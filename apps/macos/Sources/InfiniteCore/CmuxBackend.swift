import Foundation
import Darwin

public actor CmuxBackend {
    private struct ConnectingSession {
        let id: UUID
        var helper: CmuxHelperProcess?
        let runtimeDirectory: URL
        let vault: CmuxIdentityVault
    }

    private struct ConnectedSession {
        let helper: CmuxHelperProcess
        var workspaceHelper: CmuxHelperProcess?
        let runtimeDirectory: URL
        let vault: CmuxIdentityVault
        let helperURL: URL
        let route: String
        let deviceName: String
    }

    private enum SessionState {
        case disconnected
        case connecting(ConnectingSession)
        case connected(ConnectedSession)
        case disconnecting(Task<Void, Error>)
        case cleanupFailed(vault: CmuxIdentityVault, runtimeDirectory: URL)
    }

    private enum TeardownOutcome {
        case succeeded
        case cleanupFailed(vault: CmuxIdentityVault, runtimeDirectory: URL)
    }

    private let terminal = CmuxConnection()
    private var state: SessionState = .disconnected
    private var rpcActive = false
    private var rpcWaiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    private func acquireRPC() async {
        if !rpcActive {
            rpcActive = true
            return
        }
        await withCheckedContinuation { continuation in
            rpcWaiters.append(continuation)
        }
    }

    private func releaseRPC() {
        if !rpcWaiters.isEmpty {
            let next = rpcWaiters.removeFirst()
            next.resume()
        } else {
            rpcActive = false
        }
    }

    private func assertStillConnecting(_ connectID: UUID) throws {
        guard case .connecting(let current) = state, current.id == connectID else {
            throw CmuxTransportError.notConnected
        }
    }

    public func connect(
        profileID: String, route: String, helperURL: URL,
        invitation: String? = nil, deviceName: String = "Infinite Desktop",
        onState: @escaping @Sendable (JSON) -> Void = { _ in }
    ) async throws {
        guard case .disconnected = state else { throw CmuxTransportError.alreadyConnected }
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
        let connectID = UUID()
        state = .connecting(ConnectingSession(id: connectID, helper: nil, runtimeDirectory: directory, vault: vault))
        var helper: CmuxHelperProcess?
        do {
            var arguments = connectionArguments(command: "connect", directory: directory, route: resolvedRoute, deviceName: deviceName)
            arguments += ["--headless", "--json", "--local-socket", directory.appendingPathComponent("control.sock").path]
            if invitation != nil { arguments += ["--invite-file", "-"] }
            let spawned = try CmuxHelperProcess(executable: helperURL, arguments: arguments, observe: onState)
            helper = spawned
            if case .connecting(var current) = state, current.id == connectID {
                current.helper = spawned
                state = .connecting(current)
            } else {
                throw CmuxTransportError.notConnected
            }
            if let invitation { try await spawned.write(Data((invitation + "\n").utf8)) }
            try assertStillConnecting(connectID)
            let deadline = Date().addingTimeInterval(65)
            var connected = false
            while Date() < deadline {
                let snapshot = try JSON.parse(await spawned.readLine(deadline: deadline))
                try assertStillConnecting(connectID)
                if snapshot["event"].string == "connection-snapshot", snapshot["connection"]["state"].string == "connected" {
                    connected = true; break
                }
            }
            guard connected else { throw CmuxTransportError.failed("The cmux enrollment or connection timed out.") }
            await spawned.discardQueuedOutput()
            try assertStillConnecting(connectID)
            try vault.save(from: directory)
            try await terminal.connect(route: resolvedRoute, stateDirectory: directory.appendingPathComponent("client"), deviceName: deviceName)
            try assertStillConnecting(connectID)
            try vault.save(from: directory)
            state = .connected(ConnectedSession(
                helper: spawned,
                workspaceHelper: nil,
                runtimeDirectory: directory,
                vault: vault,
                helperURL: helperURL,
                route: resolvedRoute,
                deviceName: deviceName
            ))
        } catch {
            let ownedAttempt: Bool
            if case .connecting(let current) = state, current.id == connectID {
                ownedAttempt = true
            } else {
                ownedAttempt = false
            }
            if ownedAttempt {
                let teardown = beginTeardown(helper: helper, workspaceHelper: nil, vault: vault, runtimeDirectory: directory)
                do {
                    try await teardown.value
                } catch {
                    throw CmuxTransportError.failed("Connection failed and the identity could not be saved to Keychain. Retry disconnect before closing the app.")
                }
            } else if let helper {
                await helper.stop()
            }
            throw error
        }
    }

    public func snapshot() throws -> JSON {
        try resource(operation: "session.snapshot")
    }

    public func resource(operation: String, params: [String: JSON] = [:], mutationID: String? = nil) throws -> JSON {
        guard case .connected(let session) = state else { throw CmuxTransportError.notConnected }
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
        let response = try CmuxUnixRequest.perform(socketPath: session.runtimeDirectory.appendingPathComponent("control.sock").path, request: .object(request))
        guard response["protocol"].string == "cmux.protocol/2", response["type"].string == "response", response["id"].string == id else {
            throw CmuxTransportError.failed("The cmux resource response did not match its request. Refresh before retrying a mutation.")
        }
        guard response["ok"].bool else {
            throw DesktopError(response["error"]["message"].string, code: response["error"]["code"].string)
        }
        return response["result"]
    }

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

    public func closeTerminal(_ terminalID: String, mutationID: String = UUID().uuidString) throws {
        _ = try resource(operation: "terminal.close", params: ["terminal": .string(terminalID)], mutationID: mutationID)
    }

    public func workspaceRPC(_ request: JSON) async throws -> JSON {
        await acquireRPC()
        defer { releaseRPC() }
        guard case .connected(var session) = state else { throw CmuxTransportError.notConnected }
        let process: CmuxHelperProcess
        if let existing = session.workspaceHelper {
            process = existing
        } else {
            let created = try CmuxHelperProcess(
                executable: session.helperURL,
                arguments: connectionArguments(command: "rpc", directory: session.runtimeDirectory, route: session.route, deviceName: session.deviceName)
            )
            session.workspaceHelper = created
            state = .connected(session)
            process = created
        }
        do {
            var data = try request.data()
            guard data.count <= 4 * 1024 * 1024 else { throw CmuxTransportError.invalidConfiguration("The workspace request exceeds 4 MiB.") }
            data.append(10)
            try await process.write(data)
            return try JSON.parse(await process.readLine(deadline: Date().addingTimeInterval(45)))
        } catch {
            await process.stop()
            if case .connected(var current) = state, current.workspaceHelper === process {
                current.workspaceHelper = nil
                state = .connected(current)
            }
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

    private func beginTeardown(
        helper: CmuxHelperProcess?,
        workspaceHelper: CmuxHelperProcess?,
        vault: CmuxIdentityVault,
        runtimeDirectory: URL
    ) -> Task<Void, Error> {
        let task = Task<Void, Error> {
            await self.terminal.disconnect()
            if let workspaceHelper { await workspaceHelper.stop() }
            if let helper { await helper.stop() }
            do {
                try vault.save(from: runtimeDirectory)
                try vault.eraseRuntime(runtimeDirectory)
                self.finishTeardown(.succeeded)
            } catch {
                self.finishTeardown(.cleanupFailed(vault: vault, runtimeDirectory: runtimeDirectory))
                throw error
            }
        }
        state = .disconnecting(task)
        return task
    }

    private func finishTeardown(_ outcome: TeardownOutcome) {
        switch outcome {
        case .succeeded:
            state = .disconnected
        case .cleanupFailed(let vault, let runtimeDirectory):
            state = .cleanupFailed(vault: vault, runtimeDirectory: runtimeDirectory)
        }
    }

    public func disconnect() async throws {
        switch state {
        case .disconnected:
            await terminal.disconnect()
        case .connecting(let connecting):
            try await beginTeardown(
                helper: connecting.helper,
                workspaceHelper: nil,
                vault: connecting.vault,
                runtimeDirectory: connecting.runtimeDirectory
            ).value
        case .connected(let session):
            try await beginTeardown(
                helper: session.helper,
                workspaceHelper: session.workspaceHelper,
                vault: session.vault,
                runtimeDirectory: session.runtimeDirectory
            ).value
        case .disconnecting(let task):
            try await task.value
        case .cleanupFailed(let vault, let runtimeDirectory):
            try await beginTeardown(
                helper: nil,
                workspaceHelper: nil,
                vault: vault,
                runtimeDirectory: runtimeDirectory
            ).value
        }
    }

    private func connectionArguments(command: String, directory: URL, route: String, deviceName: String) -> [String] {
        ["remote", command, route, "--state-dir", directory.path, "--device-name", deviceName,
         "--connect-timeout-seconds", "60", "--reconnect-attempts", "1"]
    }
}

private enum CmuxHelperEvent: Sendable {
    case stdout(Data)
    case stderr(Data)
    case terminated
}

private actor CmuxHelperProcess {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errorOutput = Pipe()
    private let eventContinuation: AsyncStream<CmuxHelperEvent>.Continuation
    private var partial = Data()
    private var lines: [Data] = []
    private var queuedBytes = 0
    private var failure: String?
    private var standardError = Data()
    private var ended = false
    private var terminated = false
    private var discard = false
    private var lineWaiter: (id: UUID, continuation: CheckedContinuation<Data, Error>)?
    private var canceledLineWaiters: Set<UUID> = []
    private var terminationWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var canceledTerminationWaiters: Set<UUID> = []
    private let observe: (@Sendable (JSON) -> Void)?

    init(executable: URL, arguments: [String], observe: (@Sendable (JSON) -> Void)? = nil) throws {
        self.observe = observe
        let (eventStream, continuation) = AsyncStream.makeStream(of: CmuxHelperEvent.self)
        self.eventContinuation = continuation
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errorOutput
        output.fileHandleForReading.readabilityHandler = { handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            continuation.yield(.stdout(bytes))
        }
        errorOutput.fileHandleForReading.readabilityHandler = { handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            continuation.yield(.stderr(bytes))
        }
        process.terminationHandler = { _ in
            continuation.yield(.terminated)
        }
        do {
            try process.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            errorOutput.fileHandleForReading.readabilityHandler = nil
            process.terminationHandler = nil
            continuation.finish()
            throw error
        }
        Task { [weak self] in
            for await event in eventStream {
                await self?.handle(event)
            }
        }
    }

    func write(_ data: Data) throws {
        guard process.isRunning else { throw CmuxTransportError.failed("The cmux helper stopped. Reconnect before sending another request.") }
        try input.fileHandleForWriting.write(contentsOf: data)
    }

    func readLine(deadline: Date) async throws -> Data {
        if !lines.isEmpty {
            let line = lines.removeFirst()
            queuedBytes -= line.count
            return line
        }
        if let failure { throw CmuxTransportError.failed(failure) }
        if ended { throw eofError() }
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else {
            throw CmuxTransportError.failed("The cmux request timed out. Its remote outcome may be unknown; refresh before retrying.")
        }
        let waiterID = UUID()
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await self.waitForLine(id: waiterID) }
            group.addTask {
                let nanoseconds = UInt64(max(0, remaining) * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanoseconds)
                throw CmuxTransportError.failed("The cmux request timed out. Its remote outcome may be unknown; refresh before retrying.")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private func waitForLine(id: UUID) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled || canceledLineWaiters.remove(id) != nil {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                if !lines.isEmpty {
                    let line = lines.removeFirst()
                    queuedBytes -= line.count
                    continuation.resume(returning: line)
                    return
                }
                if let failure {
                    continuation.resume(throwing: CmuxTransportError.failed(failure))
                    return
                }
                if ended {
                    continuation.resume(throwing: eofError())
                    return
                }
                if let existing = lineWaiter {
                    lineWaiter = nil
                    existing.continuation.resume(throwing: CancellationError())
                }
                lineWaiter = (id, continuation)
            }
        } onCancel: {
            Task { await self.cancelLineWaiter(id: id) }
        }
    }

    private func cancelLineWaiter(id: UUID) {
        if let existing = lineWaiter, existing.id == id {
            lineWaiter = nil
            existing.continuation.resume(throwing: CancellationError())
            return
        }
        canceledLineWaiters.insert(id)
    }

    func discardQueuedOutput() {
        discard = true
        lines.removeAll()
        queuedBytes = 0
    }

    private func handle(_ event: CmuxHelperEvent) {
        switch event {
        case .stdout(let bytes):
            receive(bytes)
        case .stderr(let bytes):
            standardError.append(bytes)
            if standardError.count > 4096 { standardError = standardError.suffix(4096) }
        case .terminated:
            ended = true
            terminated = true
            let waiters = Array(terminationWaiters.values)
            terminationWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
            if lines.isEmpty, let existing = lineWaiter {
                lineWaiter = nil
                existing.continuation.resume(throwing: failure.map { CmuxTransportError.failed($0) } ?? eofError())
            }
        }
    }

    private func receive(_ bytes: Data) {
        if bytes.isEmpty {
            ended = true
            if lines.isEmpty, let existing = lineWaiter {
                lineWaiter = nil
                existing.continuation.resume(throwing: failure.map { CmuxTransportError.failed($0) } ?? eofError())
            }
            return
        }
        partial.append(bytes)
        var observed: [JSON] = []
        while let end = partial.firstIndex(of: 10) {
            let line = Data(partial[..<end])
            partial.removeSubrange(...end)
            if observe != nil, let value = try? JSON.parse(line) { observed.append(value) }
            if !discard {
                if lines.count >= 256 || queuedBytes + line.count > 16 * 1024 * 1024 {
                    failure = "The cmux helper output exceeded the client limit."
                    break
                }
                lines.append(line)
                queuedBytes += line.count
            }
        }
        if partial.count > 16 * 1024 * 1024 {
            partial.removeAll()
            failure = "The cmux helper frame exceeded the client limit."
        }
        if let existing = lineWaiter {
            if let failure {
                lineWaiter = nil
                existing.continuation.resume(throwing: CmuxTransportError.failed(failure))
            } else if !lines.isEmpty {
                let line = lines.removeFirst()
                queuedBytes -= line.count
                lineWaiter = nil
                existing.continuation.resume(returning: line)
            }
        }
        for value in observed { observe?(value) }
    }

    private func eofError() -> CmuxTransportError {
        let diagnostic = String(decoding: standardError, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return CmuxTransportError.failed(diagnostic.isEmpty ? "The cmux helper connection ended. Check enrollment or device revocation at the server." : diagnostic)
    }

    func stop() async {
        try? input.fileHandleForWriting.close()
        if process.isRunning && !terminated {
            process.interrupt()
            await withTaskGroup(of: Void.self) { group in
                let waiterID = UUID()
                group.addTask { await self.waitForTermination(id: waiterID) }
                group.addTask { try? await Task.sleep(nanoseconds: 800_000_000) }
                await group.next()
                group.cancelAll()
            }
            if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        output.fileHandleForReading.readabilityHandler = nil
        errorOutput.fileHandleForReading.readabilityHandler = nil
        process.terminationHandler = nil
        try? output.fileHandleForReading.close()
        try? errorOutput.fileHandleForReading.close()
        eventContinuation.finish()
        ended = true
        if let existing = lineWaiter {
            lineWaiter = nil
            existing.continuation.resume(throwing: failure.map { CmuxTransportError.failed($0) } ?? eofError())
        }
        canceledLineWaiters.removeAll()
        canceledTerminationWaiters.removeAll()
    }

    private func waitForTermination(id: UUID) async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if terminated || Task.isCancelled || canceledTerminationWaiters.remove(id) != nil {
                    continuation.resume()
                    return
                }
                terminationWaiters[id] = continuation
            }
        } onCancel: {
            Task { await self.cancelTerminationWaiter(id: id) }
        }
    }

    private func cancelTerminationWaiter(id: UUID) {
        if let waiter = terminationWaiters.removeValue(forKey: id) {
            waiter.resume()
            return
        }
        canceledTerminationWaiters.insert(id)
    }

    deinit {
        output.fileHandleForReading.readabilityHandler = nil
        errorOutput.fileHandleForReading.readabilityHandler = nil
        process.terminationHandler = nil
        if process.isRunning {
            process.interrupt()
            _ = Darwin.kill(process.processIdentifier, SIGKILL)
        }
        try? input.fileHandleForWriting.close()
        try? output.fileHandleForReading.close()
        try? errorOutput.fileHandleForReading.close()
        eventContinuation.finish()
    }
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
