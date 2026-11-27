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
    case snapshot(Data, columns: Int, rows: Int)
    case bytes(Data)
    case resized(columns: Int, rows: Int)
    case exited
    case invalidFrame
}

public enum CmuxInputAcceptance: Sendable {
    case queued
}

public struct CmuxCreatedTerminal: Sendable {
    public let terminalID: String
    public let workspaceID: String
}

public actor CmuxConnection {
    public nonisolated static var sdkAvailable: Bool {
        #if canImport(CmuxTerminalClientFFI)
        true
        #else
        false
        #endif
    }

    #if canImport(CmuxTerminalClientFFI)
    private enum ConnectionState {
        case disconnected
        case connected(CmuxClientOwner)
    }

    private var state: ConnectionState = .disconnected
    #endif

    public init() {}

    public func connect(
        route: String,
        stateDirectory: URL,
        deviceName: String,
        invitation: String? = nil
    ) throws {
        #if canImport(CmuxTerminalClientFFI)
        guard case .disconnected = state else { throw CmuxTransportError.alreadyConnected }
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
        state = .connected(CmuxClientOwner(pointer: connected))
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
        let owner = try connectedOwner()
        guard terminalID.hasPrefix("term_"), terminalID.utf8.count <= 128,
              !terminalID.contains("\0") else {
            throw CmuxTransportError.invalidConfiguration("Choose a valid server terminal.")
        }
        cmux_terminal_client_set_output_callback(owner.pointer, nil, nil)
        cmux_terminal_client_detach(owner.pointer)
        let relay = CmuxOutputRelay(receive: onOutput)
        owner.attachment = .attached(relay)
        cmux_terminal_client_set_output_callback(owner.pointer, cmuxOutputCallback, Unmanaged.passUnretained(relay).toOpaque())
        var error = [CChar](repeating: 0, count: 2048)
        let attached = terminalID.withCString {
            cmux_terminal_client_attach_with_timeout(owner.pointer, $0, &error, error.count, 15_000)
        }
        if !attached {
            cmux_terminal_client_set_output_callback(owner.pointer, nil, nil)
            owner.attachment = .detached
            throw sdkError(error, fallback: "The terminal could not be attached.")
        }
        #else
        throw CmuxTransportError.sdkUnavailable
        #endif
    }

    public func send(_ bytes: Data) throws -> CmuxInputAcceptance {
        #if canImport(CmuxTerminalClientFFI)
        let client = try connectedOwner().pointer
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
        let client = try connectedOwner().pointer
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
        let client = try connectedOwner().pointer
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
        guard case .connected(let owner) = state else { return }
        cmux_terminal_client_set_output_callback(owner.pointer, nil, nil)
        cmux_terminal_client_detach(owner.pointer)
        owner.attachment = .detached
        #endif
    }

    public func disconnect() {
        #if canImport(CmuxTerminalClientFFI)
        state = .disconnected
        #endif
    }

    #if canImport(CmuxTerminalClientFFI)
    private func connectedOwner() throws -> CmuxClientOwner {
        guard case .connected(let owner) = state else { throw CmuxTransportError.notConnected }
        return owner
    }

    private func readJSON(
        _ operation: (OpaquePointer, UnsafeMutablePointer<CChar>, Int) -> UnsafeMutablePointer<CChar>?
    ) throws -> Data {
        let client = try connectedOwner().pointer
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
private final class CmuxClientOwner: @unchecked Sendable {
    enum Attachment {
        case detached
        case attached(CmuxOutputRelay)
    }

    let pointer: OpaquePointer
    var attachment: Attachment = .detached
    init(pointer: OpaquePointer) { self.pointer = pointer }
    deinit {
        withExtendedLifetime(attachment) {
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
