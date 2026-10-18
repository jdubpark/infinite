import Foundation
import Darwin

/// Native terminal bytes use the public cmux C SDK. The bundled cmux executable
/// supplies the authenticated resource and workspace RPC APIs absent from C.
/// All remote requests travel through normal enrolled Noise connections.
public actor CmuxBackend {
    private let terminal = CmuxConnection()
    private var helper: CmuxHelperProcess?
    private var workspaceHelper: CmuxHelperProcess?
    private var runtimeDirectory: URL?
    private var vault: CmuxIdentityVault?
    private var helperURL: URL?
    private var route = ""
    private var deviceName = "Infinite Desktop"

    public init() {}

    /// Enrollment needs approval at the server. Invitations are sent through
    /// stdin and never placed in a process argument or saved profile.
    public func connect(
        profileID: String, route: String, helperURL: URL,
        invitation: String? = nil, deviceName: String = "Infinite Desktop",
        onState: @escaping @Sendable (JSON) -> Void = { _ in }
    ) async throws {
        guard helper == nil, runtimeDirectory == nil else { throw CmuxTransportError.alreadyConnected }
        guard let url = URL(string: route), url.user == nil, url.password == nil,
              let scheme = url.scheme?.lowercased(), ["wss", "ws", "iroh"].contains(scheme),
              scheme != "ws" || ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host ?? ""),
              !route.contains("\0"), !deviceName.isEmpty, !deviceName.contains("\0"), deviceName.utf8.count <= 128,
              invitation?.contains("\n") != true, invitation?.contains("\0") != true else {
            throw CmuxTransportError.invalidConfiguration("Use an encrypted cmux route and a valid device name. Plain WebSocket is limited to loopback.")
        }
        guard helperURL.isFileURL, FileManager.default.isExecutableFile(atPath: helperURL.path) else {
            throw CmuxTransportError.invalidConfiguration("This build is missing its cmux helper executable.")
        }
        // Invitations can provide this route to the helper; the C SDK uses
        // the supplied path literally. Give both clients the same endpoint.
        guard var endpoint = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw CmuxTransportError.invalidConfiguration("The cmux route is invalid.")
        }
        if ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""), endpoint.path.isEmpty || endpoint.path == "/" {
            endpoint.path = "/v1/link"
        }
        guard let resolvedRoute = endpoint.url?.absoluteString else {
            throw CmuxTransportError.invalidConfiguration("The cmux route is invalid.")
        }
        let vault = CmuxIdentityVault(profileID: profileID)
        let directory = try vault.materialize()
        self.vault = vault; runtimeDirectory = directory
        self.helperURL = helperURL; self.route = resolvedRoute; self.deviceName = deviceName
        do {
            var arguments = connectionArguments(command: "connect", directory: directory)
            arguments += ["--headless", "--json", "--local-socket", directory.appendingPathComponent("control.sock").path]
            if invitation != nil { arguments += ["--invite-file", "-"] }
            let helper = try CmuxHelperProcess(executable: helperURL, arguments: arguments, observe: onState)
            self.helper = helper
            if let invitation { try helper.write(Data((invitation + "\n").utf8)) }
            let deadline = Date().addingTimeInterval(65)
            var connected = false
            while Date() < deadline {
                let state = try JSON.parse(helper.readLine(deadline: deadline))
                if state["event"].string == "connection-snapshot", state["connection"]["state"].string == "connected" {
                    connected = true; break
                }
            }
            guard connected else { throw CmuxTransportError.failed("The cmux enrollment or connection timed out.") }
            helper.discardQueuedOutput()
            // Save both the device secret and authenticated daemon pin before
            // opening the second client with that identity.
            try vault.save(from: directory)
            // The CLI appends "client" to its state root; the C ABI expects the
            // identity directory itself. Both must use the same enrolled key.
            try await terminal.connect(route: resolvedRoute, stateDirectory: directory.appendingPathComponent("client"), deviceName: deviceName)
            try vault.save(from: directory)
        } catch {
            await terminal.disconnect()
            helper?.stop(); helper = nil
            do {
                try vault.save(from: directory)
                try vault.eraseRuntime(directory)
                runtimeDirectory = nil; self.vault = nil
            } catch {
                throw CmuxTransportError.failed("Connection failed and the identity could not be saved to Keychain. Retry disconnect before closing the app.")
            }
            throw error
        }
    }

    public func snapshot() throws -> JSON {
        try resource(operation: "session.snapshot")
    }

    /// Mutation keys are caller-owned. Preserve the same key if reconciling an
    /// ambiguous response; this client never retries a mutation automatically.
    public func resource(operation: String, params: [String: JSON] = [:], mutationID: String? = nil) throws -> JSON {
        guard helper != nil, let directory = runtimeDirectory else { throw CmuxTransportError.notConnected }
        guard !operation.isEmpty, operation.utf8.count <= 128 else {
            throw CmuxTransportError.invalidConfiguration("The resource operation is invalid.")
        }
        var parameters = params
        parameters["machine"] = parameters["machine"] ?? .string("current")
        parameters["session"] = parameters["session"] ?? .string("current")
        let id = UUID().uuidString
        var request: [String: JSON] = ["protocol": .string("cmux.protocol/2"), "type": .string("request"),
                                      "id": .string(id), "operation": .string(operation), "params": .object(parameters)]
        if let mutationID { request["idempotency_key"] = .string(mutationID) }
        let response = try CmuxUnixRequest.perform(socketPath: directory.appendingPathComponent("control.sock").path, request: .object(request))
        guard response["protocol"].string == "cmux.protocol/2", response["type"].string == "response", response["id"].string == id else {
            throw CmuxTransportError.failed("The cmux resource response did not match its request. Refresh before retrying a mutation.")
        }
        guard response["ok"].bool else {
            throw DesktopError(response["error"]["message"].string, code: response["error"]["code"].string)
        }
        return response["result"]
    }

    /// Launches exact argv in a remote directory. This never builds a shell
    /// command from user text and never auto-retries either creation mutation.
    public func createTerminal(
        argv: [String], cwd: String, name: String,
        workspaceID: String? = nil, mutationID: String = UUID().uuidString
    ) throws -> CmuxCreatedTerminal {
        guard !argv.isEmpty, argv.allSatisfy({ !$0.contains("\0") }), cwd.hasPrefix("/"), !cwd.contains("\0") else {
            throw CmuxTransportError.invalidConfiguration("Choose an absolute remote working directory and a command with arguments.")
        }
        let workspace: String
        if let workspaceID { workspace = workspaceID }
        else {
            let created = try resource(operation: "workspace.create", params: ["name": .string(name), "initial_content": .string("empty")], mutationID: "\(mutationID):workspace")
            workspace = created["value"]["workspace_id"].string
            guard !workspace.isEmpty else { throw CmuxTransportError.failed("The server did not identify the created workspace. Refresh the catalog.") }
        }
        let created = try resource(operation: "workspace.run", params: ["workspace": .string(workspace), "argv": .array(argv.map(JSON.string)), "cwd": .string(cwd), "name": .string(name), "on_exit": .string("keep")], mutationID: mutationID)
        let id = created["value"]["terminal_id"].string
        guard !id.isEmpty else { throw CmuxTransportError.failed("The server did not identify the created terminal. Refresh the catalog.") }
        return CmuxCreatedTerminal(terminalID: id, workspaceID: workspace)
    }

    /// This explicitly terminates a server PTY. Disconnect and detach do not.
    public func closeTerminal(_ terminalID: String, mutationID: String = UUID().uuidString) throws {
        _ = try resource(operation: "terminal.close", params: ["terminal": .string(terminalID)], mutationID: mutationID)
    }

    /// Workspace RPC has a separate handle namespace from terminal resources.
    /// Handles remain valid for this persistent connection. A transport failure
    /// invalidates this channel; callers must reopen their file workspace.
    public func workspaceRPC(_ request: JSON) throws -> JSON {
        guard helper != nil, let directory = runtimeDirectory, let helperURL else { throw CmuxTransportError.notConnected }
        if workspaceHelper == nil {
            workspaceHelper = try CmuxHelperProcess(executable: helperURL, arguments: connectionArguments(command: "rpc", directory: directory))
        }
        guard let process = workspaceHelper else { throw CmuxTransportError.notConnected }
        do {
            var data = try request.data()
            guard data.count <= 4 * 1024 * 1024 else { throw CmuxTransportError.invalidConfiguration("The workspace request exceeds 4 MiB.") }
            data.append(10)
            try process.write(data)
            return try JSON.parse(process.readLine(deadline: Date().addingTimeInterval(45)))
        } catch {
            process.stop(); workspaceHelper = nil
            throw error
        }
    }

    public func attach(terminalID: String, onOutput: @escaping @Sendable (CmuxTerminalOutput) -> Void) async throws {
        try await terminal.attach(terminalID: terminalID, onOutput: onOutput)
    }
    public func send(_ bytes: Data) async throws -> CmuxInputAcceptance { try await terminal.send(bytes) }
    public func paste(_ text: String) async throws -> CmuxInputAcceptance { try await terminal.paste(text) }
    public func resize(columns: Int, rows: Int) async throws { try await terminal.resize(columns: columns, rows: rows) }
    public func detach() async { await terminal.detach() }

    public func disconnect() async throws {
        await terminal.disconnect()
        workspaceHelper?.stop(); workspaceHelper = nil
        helper?.stop(); helper = nil
        if let runtimeDirectory, let vault {
            // Preserve identity on a Keychain failure; the caller can retry.
            try vault.save(from: runtimeDirectory)
            try vault.eraseRuntime(runtimeDirectory)
        }
        runtimeDirectory = nil; vault = nil; helperURL = nil; route = ""
    }

    private func connectionArguments(command: String, directory: URL) -> [String] {
        ["remote", command, route, "--state-dir", directory.path, "--device-name", deviceName,
         "--connect-timeout-seconds", "60", "--reconnect-attempts", "1"]
    }
}

/// Runs only the bundled executable with an argument vector. Output is bounded;
/// stdin carries invitations and JSON, so secrets never enter process arguments.
private final class CmuxHelperProcess: @unchecked Sendable {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errorOutput = Pipe()
    private let condition = NSCondition()
    private var partial = Data()
    private var lines: [Data] = []
    private var queuedBytes = 0
    private var failure: String?
    private var standardError = Data()
    private var ended = false
    private var discard = false
    private let observe: (@Sendable (JSON) -> Void)?

    init(executable: URL, arguments: [String], observe: (@Sendable (JSON) -> Void)? = nil) throws {
        self.observe = observe
        process.executableURL = executable; process.arguments = arguments
        process.standardInput = input; process.standardOutput = output; process.standardError = errorOutput
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            self?.receive(bytes)
        }
        // Keep a bounded diagnostic in memory for the local UI; never log it.
        errorOutput.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            guard let self else { return }; self.condition.lock()
            self.standardError.append(bytes)
            if self.standardError.count > 4096 { self.standardError = self.standardError.suffix(4096) }
            self.condition.unlock()
        }
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }; self.condition.lock()
            self.ended = true; self.condition.broadcast(); self.condition.unlock()
        }
        do { try process.run() }
        catch { output.fileHandleForReading.readabilityHandler = nil; errorOutput.fileHandleForReading.readabilityHandler = nil; throw error }
    }

    func write(_ data: Data) throws {
        guard process.isRunning else { throw CmuxTransportError.failed("The cmux helper stopped. Reconnect before sending another request.") }
        try input.fileHandleForWriting.write(contentsOf: data)
    }

    func readLine(deadline: Date) throws -> Data {
        condition.lock(); defer { condition.unlock() }
        while lines.isEmpty && failure == nil && !ended {
            guard condition.wait(until: deadline) else {
                throw CmuxTransportError.failed("The cmux request timed out. Its remote outcome may be unknown; refresh before retrying.")
            }
        }
        if let failure { throw CmuxTransportError.failed(failure) }
        guard !lines.isEmpty else {
            let diagnostic = String(decoding: standardError, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw CmuxTransportError.failed(diagnostic.isEmpty ? "The cmux helper connection ended. Check enrollment or device revocation at the server." : diagnostic)
        }
        let line = lines.removeFirst(); queuedBytes -= line.count; return line
    }

    func discardQueuedOutput() {
        condition.lock(); discard = true; lines.removeAll(); queuedBytes = 0; condition.unlock()
    }

    private func receive(_ bytes: Data) {
        condition.lock()
        if bytes.isEmpty { ended = true; condition.broadcast(); condition.unlock(); return }
        partial.append(bytes)
        var observed: [JSON] = []
        while let end = partial.firstIndex(of: 10) {
            let line = Data(partial[..<end]); partial.removeSubrange(...end)
            if observe != nil, let value = try? JSON.parse(line) { observed.append(value) }
            if !discard {
                if lines.count >= 256 || queuedBytes + line.count > 16 * 1024 * 1024 {
                    failure = "The cmux helper output exceeded the client limit."; break
                }
                lines.append(line); queuedBytes += line.count
            }
        }
        if partial.count > 16 * 1024 * 1024 { partial.removeAll(); failure = "The cmux helper frame exceeded the client limit." }
        condition.broadcast(); condition.unlock()
        for value in observed { observe?(value) }
    }

    func stop() {
        try? input.fileHandleForWriting.close()
        if process.isRunning {
            process.interrupt()
            let deadline = Date().addingTimeInterval(0.8)
            condition.lock()
            while !ended && Date() < deadline { _ = condition.wait(until: deadline) }
            condition.unlock()
            if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        output.fileHandleForReading.readabilityHandler = nil
        errorOutput.fileHandleForReading.readabilityHandler = nil
        try? output.fileHandleForReading.close(); try? errorOutput.fileHandleForReading.close()
    }

    deinit { stop() }
}

private enum CmuxUnixRequest {
    static func perform(socketPath: String, request: JSON) throws -> JSON {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let path = Array(socketPath.utf8CString)
        guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw CmuxTransportError.failed("The cmux control socket path is too long.")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: path.map { UInt8(bitPattern: $0) }) }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw CmuxTransportError.failed("Could not open the cmux control socket.") }
        defer { Darwin.close(descriptor) }
        var noSignal: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 30, tv_usec: 0)
        _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw CmuxTransportError.failed("The cmux control connection is unavailable. Reconnect the host.") }
        var data = try request.data()
        guard data.count <= 4 * 1024 * 1024 else { throw CmuxTransportError.invalidConfiguration("The resource request exceeds 4 MiB.") }
        data.append(10)
        try data.withUnsafeBytes { bytes in
            var sent = 0
            while sent < bytes.count {
                let count = Darwin.send(descriptor, bytes.baseAddress!.advanced(by: sent), bytes.count - sent, 0)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw CmuxTransportError.failed("The cmux request could not be fully sent. Refresh before retrying a mutation.") }
                sent += count
            }
        }
        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while response.count <= 16 * 1024 * 1024 {
            let count = Darwin.recv(descriptor, &buffer, buffer.count, 0)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw CmuxTransportError.failed("No complete cmux response arrived. The remote outcome may be unknown; refresh before retrying.") }
            if let end = buffer[..<count].firstIndex(of: 10) {
                response.append(contentsOf: buffer[..<end])
                guard response.count <= 16 * 1024 * 1024 else { break }
                return try JSON.parse(response)
            }
            response.append(contentsOf: buffer[..<count])
        }
        throw CmuxTransportError.failed("The cmux response exceeded 16 MiB.")
    }
}
