import Foundation

#if canImport(CmuxTerminalClientFFI)
import CmuxTerminalClientFFI
import Darwin
#endif

public enum CmuxTransportError: Error, LocalizedError, Sendable {
    case sdkUnavailable
    case notConnected
    case alreadyConnected
    case invalidConfiguration(String)
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .sdkUnavailable: "This build does not include the cmux terminal SDK."
        case .notConnected: "Connect to the cmux server first."
        case .alreadyConnected: "Disconnect the current cmux connection first."
        case .invalidConfiguration(let message), .failed(let message): message
        }
    }
}

public enum CmuxTerminalOutput: Sendable {
    /// Reset the local emulator to this size before applying the snapshot bytes.
    case snapshot(Data, columns: Int, rows: Int)
    case bytes(Data)
    case resized(columns: Int, rows: Int)
    case exited
    case invalidFrame
}

/// Queue acceptance is not a delivery receipt or evidence of provider execution.
public enum CmuxInputAcceptance: Sendable {
    case queued
}

public struct CmuxCreatedTerminal: Sendable {
    public let terminalID: String
    public let workspaceID: String
}

/// A serialized owner of the optional native SDK connection.
///
/// The output handler runs on an SDK thread. It must not synchronously call back
/// into this connection and must bound any downstream rendering queue.
public actor CmuxConnection {
    public nonisolated static var sdkAvailable: Bool {
        #if canImport(CmuxTerminalClientFFI)
        true
        #else
        false
        #endif
    }

    #if canImport(CmuxTerminalClientFFI)
    private var clientOwner: CmuxClientOwner?
    private var client: OpaquePointer? { clientOwner?.pointer }
    private var outputRelay: CmuxOutputRelay? {
        get { clientOwner?.outputRelay }
        set { clientOwner?.outputRelay = newValue }
    }
    #endif

    public init() {}

    /// The SDK stores its identity in this owner-only directory. Callers must
    /// account for that storage separately from their platform Keychain keys.
    public func connect(
        route: String,
        stateDirectory: URL,
        deviceName: String,
        invitation: String? = nil
    ) throws {
        #if canImport(CmuxTerminalClientFFI)
        guard client == nil else { throw CmuxTransportError.alreadyConnected }
        try validateRoute(route)
        guard stateDirectory.isFileURL, !deviceName.isEmpty,
              deviceName.utf8.count <= 128, !deviceName.contains("\0"),
              invitation?.contains("\0") != true else {
            throw CmuxTransportError.invalidConfiguration("The cmux connection settings are invalid.")
        }
        try FileManager.default.createDirectory(
            at: stateDirectory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let attributes = try FileManager.default.attributesOfItem(atPath: stateDirectory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              let permissions = attributes[.posixPermissions] as? NSNumber,
              permissions.intValue & 0o077 == 0 else {
            throw CmuxTransportError.invalidConfiguration("The cmux identity directory must be private to its owner.")
        }
        var error = [CChar](repeating: 0, count: 2048)
        let connected = route.withCString { routePointer in
            stateDirectory.path.withCString { directoryPointer in
                deviceName.withCString { namePointer in
                    func open(_ invitePointer: UnsafePointer<CChar>?) -> OpaquePointer? {
                        cmux_terminal_client_connect_route(
                            routePointer, directoryPointer, namePointer, invitePointer,
                            nil, &error, error.count, 45_000
                        )
                    }
                    return invitation.map { $0.withCString { open($0) } } ?? open(nil)
                }
            }
        }
        guard let connected else { throw sdkError(error, fallback: "The cmux server connection failed.") }
        clientOwner = CmuxClientOwner(pointer: connected)
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func terminals() throws -> Data {
        #if canImport(CmuxTerminalClientFFI)
        try readJSON { cmux_terminal_client_list_terminals($0, $1, $2, 10_000) }
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func sessionSnapshot() throws -> Data {
        #if canImport(CmuxTerminalClientFFI)
        try readJSON { cmux_terminal_client_session_snapshot($0, $1, $2, 10_000) }
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func createTerminal(name: String) throws -> CmuxCreatedTerminal {
        #if canImport(CmuxTerminalClientFFI)
        guard !name.contains("\0"), name.utf8.count <= 256 else {
            throw CmuxTransportError.invalidConfiguration("The terminal name is invalid.")
        }
        let data = try name.withCString { namePointer in
            try readJSON { cmux_terminal_client_create_terminal($0, namePointer, $1, $2, 10_000) }
        }
        struct Created: Decodable {
            struct Value: Decodable { let terminal_id: String; let workspace_id: String }
            let value: Value
        }
        let result = try JSONDecoder().decode(Created.self, from: data)
        return CmuxCreatedTerminal(terminalID: result.value.terminal_id, workspaceID: result.value.workspace_id)
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func attach(
        terminalID: String,
        onOutput: @escaping @Sendable (CmuxTerminalOutput) -> Void
    ) throws {
        #if canImport(CmuxTerminalClientFFI)
        let client = try connectedClient()
        guard terminalID.hasPrefix("term_"), terminalID.utf8.count <= 128,
              !terminalID.contains("\0") else {
            throw CmuxTransportError.invalidConfiguration("Choose a valid server terminal.")
        }
        cmux_terminal_client_set_output_callback(client, nil, nil)
        cmux_terminal_client_detach(client)
        let relay = CmuxOutputRelay(receive: onOutput)
        outputRelay = relay
        cmux_terminal_client_set_output_callback(client, cmuxOutputCallback, Unmanaged.passUnretained(relay).toOpaque())
        var error = [CChar](repeating: 0, count: 2048)
        let attached = terminalID.withCString {
            cmux_terminal_client_attach_with_timeout(client, $0, &error, error.count, 15_000)
        }
        if !attached {
            cmux_terminal_client_set_output_callback(client, nil, nil)
            outputRelay = nil
            throw sdkError(error, fallback: "The terminal could not be attached.")
        }
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func send(_ bytes: Data) throws -> CmuxInputAcceptance {
        #if canImport(CmuxTerminalClientFFI)
        let client = try connectedClient()
        try validateInput(bytes)
        let queued = bytes.withUnsafeBytes {
            cmux_terminal_client_send(client, $0.bindMemory(to: UInt8.self).baseAddress, $0.count)
        }
        guard queued else { throw CmuxTransportError.failed("Terminal input was not accepted by the local queue.") }
        return .queued
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func paste(_ text: String) throws -> CmuxInputAcceptance {
        #if canImport(CmuxTerminalClientFFI)
        let client = try connectedClient()
        let bytes = Data(text.utf8)
        try validateInput(bytes)
        let queued = bytes.withUnsafeBytes {
            cmux_terminal_client_paste(client, $0.bindMemory(to: UInt8.self).baseAddress, $0.count)
        }
        guard queued else { throw CmuxTransportError.failed("The paste was not accepted by the local queue.") }
        return .queued
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func resize(columns: Int, rows: Int) throws {
        #if canImport(CmuxTerminalClientFFI)
        let client = try connectedClient()
        guard let columns = UInt16(exactly: columns), let rows = UInt16(exactly: rows), columns > 0, rows > 0 else {
            throw CmuxTransportError.invalidConfiguration("The terminal size is invalid.")
        }
        guard cmux_terminal_client_resize(client, columns, rows) else {
            throw CmuxTransportError.failed("The terminal resize was not accepted.")
        }
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func detach() {
        #if canImport(CmuxTerminalClientFFI)
        guard let client else { return }
        cmux_terminal_client_set_output_callback(client, nil, nil)
        cmux_terminal_client_detach(client)
        outputRelay = nil
        #endif
    }

    /// Disconnecting releases this attachment and never requests terminal termination.
    public func disconnect() {
        #if canImport(CmuxTerminalClientFFI)
        clientOwner = nil
        #endif
    }

    #if canImport(CmuxTerminalClientFFI)
    private func connectedClient() throws -> OpaquePointer {
        guard let client else { throw CmuxTransportError.notConnected }
        return client
    }

    private func readJSON(
        _ operation: (OpaquePointer, UnsafeMutablePointer<CChar>, Int) -> UnsafeMutablePointer<CChar>?
    ) throws -> Data {
        let client = try connectedClient()
        var error = [CChar](repeating: 0, count: 2048)
        guard let result = operation(client, &error, error.count) else {
            throw sdkError(error, fallback: "The cmux request failed; refresh before retrying a mutation.")
        }
        defer { cmux_terminal_client_string_free(result) }
        let limit = 16 * 1024 * 1024
        let count = strnlen(result, limit + 1)
        guard count <= limit else { throw CmuxTransportError.failed("The cmux response exceeded the client limit.") }
        let data = Data(bytes: result, count: count)
        _ = try JSONSerialization.jsonObject(with: data)
        return data
    }

    private func validateInput(_ bytes: Data) throws {
        guard !bytes.isEmpty, bytes.count <= 32 * 1024 else {
            throw CmuxTransportError.invalidConfiguration("Send between 1 byte and 32 KiB of terminal input at a time.")
        }
    }

    private func sdkError(_ buffer: [CChar], fallback: String) -> CmuxTransportError {
        let message = buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        return .failed(message.isEmpty ? fallback : message)
    }

    private func validateRoute(_ route: String) throws {
        guard !route.contains("\0"), let url = URL(string: route),
              url.user == nil, url.password == nil,
              let scheme = url.scheme?.lowercased(), ["ws", "wss", "iroh"].contains(scheme),
              scheme != "ws" || ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? "") else {
            throw CmuxTransportError.invalidConfiguration("Use an encrypted cmux route; plain WebSocket is limited to loopback.")
        }
    }
    #endif
}

#if canImport(CmuxTerminalClientFFI)
/// Only the enclosing actor accesses this owner. Its destructor keeps the
/// callback context alive until the SDK has waited for all in-flight calls.
/// A Sendable owner also permits cleanup on macOS versions without isolated
/// actor destructors.
private final class CmuxClientOwner: @unchecked Sendable {
    let pointer: OpaquePointer
    var outputRelay: CmuxOutputRelay?
    init(pointer: OpaquePointer) { self.pointer = pointer }
    deinit {
        withExtendedLifetime(outputRelay) {
            cmux_terminal_client_set_output_callback(pointer, nil, nil)
            cmux_terminal_client_disconnect(pointer)
        }
    }
}

private final class CmuxOutputRelay: Sendable {
    let receive: @Sendable (CmuxTerminalOutput) -> Void
    init(receive: @escaping @Sendable (CmuxTerminalOutput) -> Void) { self.receive = receive }
}

private let cmuxOutputCallback: CmuxTerminalClientOutputCallback = { context, kind, bytes, count, columns, rows in
    guard let context else { return }
    let relay = Unmanaged<CmuxOutputRelay>.fromOpaque(context).takeUnretainedValue()
    guard count <= 16 * 1024 * 1024, count == 0 || bytes != nil else {
        relay.receive(.invalidFrame)
        return
    }
    switch kind {
    case 1:
        let data = bytes.map { Data(bytes: $0, count: count) } ?? Data()
        relay.receive(.snapshot(data, columns: Int(columns), rows: Int(rows)))
    case 2:
        let data = bytes.map { Data(bytes: $0, count: count) } ?? Data()
        relay.receive(.bytes(data))
    case 3: relay.receive(.resized(columns: Int(columns), rows: Int(rows)))
    case 4: relay.receive(.exited)
    default: relay.receive(.invalidFrame)
    }
}
#endif
