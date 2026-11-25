import Foundation

public actor RemoteClient {
    private struct OutboundFrame: Sendable {
        let payload: String
        let completion: CheckedContinuation<Void, Error>?
    }

    private final class ConnectingState {
        let id = UUID()
        var task: Task<Void, Error>?
        var session: URLSession?
        var socket: URLSessionWebSocketTask?
    }

    private final class OpenChannel {
        let id: UUID
        let session: URLSession
        let socket: URLSessionWebSocketTask
        var cipher: RemoteCipher
        var pending: [String: CheckedContinuation<JSON, Error>] = [:]
        var deadlines: [String: Task<Void, Never>] = [:]
        var streams: [String: @Sendable (JSON) -> Void] = [:]
        var earlyEvents: [String: [JSON]] = [:]
        var openingStreams: Set<String> = []
        let outboundContinuation: AsyncStream<OutboundFrame>.Continuation
        let receiver: Task<Void, Never>
        let writer: Task<Void, Never>

        init(
            id: UUID,
            session: URLSession,
            socket: URLSessionWebSocketTask,
            cipher: RemoteCipher,
            outboundContinuation: AsyncStream<OutboundFrame>.Continuation,
            receiver: Task<Void, Never>,
            writer: Task<Void, Never>
        ) {
            self.id = id
            self.session = session
            self.socket = socket
            self.cipher = cipher
            self.outboundContinuation = outboundContinuation
            self.receiver = receiver
            self.writer = writer
        }
    }

    private enum ConnectionState {
        case idle
        case connecting(ConnectingState)
        case open(OpenChannel)
        case closed
    }

    public let clientID = UUID().uuidString.lowercased()
    private let profile: HostProfile
    private let token: String
    private var state: ConnectionState = .idle
    private var requestCounter = 0

    public init(profile: HostProfile, token: String) {
        self.profile = profile
        self.token = token
    }

    public var authenticatedMachineID: String? {
        if case .open(let channel) = state { return channel.cipher.machineID }
        return nil
    }

    public func connect() async throws {
        switch state {
        case .open:
            return
        case .connecting(let connecting):
            if let task = connecting.task {
                return try await task.value
            }
            throw DesktopError("This connection is closed.")
        case .closed:
            throw DesktopError("This connection is closed.")
        case .idle:
            let connecting = ConnectingState()
            let task = Task { try await self.handshake(connecting: connecting) }
            connecting.task = task
            state = .connecting(connecting)
            do {
                try await task.value
            } catch {
                if case .connecting(let current) = state, current.id == connecting.id {
                    disconnect(error)
                }
                throw error
            }
        }
    }

    private func handshake(connecting: ConnectingState) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 7 * 24 * 60 * 60
        let session = URLSession(configuration: config)
        let socket = session.webSocketTask(with: try profile.socketURL())
        socket.maximumMessageSize = 8 * 1024 * 1024 + 4096
        guard case .connecting(let current) = state, current.id == connecting.id else {
            socket.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
            throw DesktopError("This connection is closed.")
        }
        connecting.session = session
        connecting.socket = socket
        socket.resume()
        let handshake = try RemoteHandshake(token: token, machineID: profile.relayMachineID ?? "")
        try await socket.send(.string(String(decoding: handshake.hello.data(), as: UTF8.self)))
        let welcome: JSON = try await withThrowingTaskGroup(of: JSON.self) { group in
            group.addTask { try await Self.receive(socket) }
            group.addTask {
                try await Task.sleep(nanoseconds: 10_000_000_000)
                socket.cancel(with: .goingAway, reason: nil)
                throw DesktopError("The server did not authenticate in time.")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
        let cipher = try handshake.accept(welcome, pinnedMachineID: profile.pinnedMachineID)
        guard case .connecting(let currentAfter) = state, currentAfter.id == connecting.id else {
            socket.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
            throw DesktopError("This connection is closed.")
        }
        let (outboundStream, outboundContinuation) = AsyncStream.makeStream(of: OutboundFrame.self)
        let channelID = UUID()
        let receiver = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let frame = try await Self.receive(socket)
                    try await self?.received(frame, channelID: channelID)
                }
            } catch {
                await self?.disconnectIfCurrent(channelID: channelID, error: error)
            }
        }
        let writer = Task { [weak self] in
            var failedError: Error?
            for await frame in outboundStream {
                if let failedError {
                    frame.completion?.resume(throwing: failedError)
                    continue
                }
                guard await self?.isChannelOpen(channelID) == true else {
                    let error = DesktopError("Connection interrupted. A pending send may have been delivered. Check the session before retrying.", code: "delivery-unknown")
                    failedError = error
                    frame.completion?.resume(throwing: error)
                    continue
                }
                do {
                    try await socket.send(.string(frame.payload))
                    frame.completion?.resume()
                } catch {
                    failedError = error
                    frame.completion?.resume(throwing: error)
                    await self?.disconnectIfCurrent(channelID: channelID, error: error)
                }
            }
        }
        let channel = OpenChannel(
            id: channelID,
            session: session,
            socket: socket,
            cipher: cipher,
            outboundContinuation: outboundContinuation,
            receiver: receiver,
            writer: writer
        )
        state = .open(channel)
    }

    private static func receive(_ socket: URLSessionWebSocketTask) async throws -> JSON {
        switch try await socket.receive() {
        case .string(let string): return try JSON.parse(Data(string.utf8))
        default: throw DesktopError("The server sent an invalid encrypted frame.")
        }
    }

    private func received(_ frame: JSON, channelID: UUID) throws {
        guard case .open(let channel) = state, channel.id == channelID else { return }
        let message = try channel.cipher.open(frame)
        if message["type"].string == "terminal-event" || message["type"].string == "terminal-closed" {
            let stream = message["streamId"].string
            if let handler = channel.streams[stream] {
                handler(message)
                if message["type"].string == "terminal-closed" { channel.streams.removeValue(forKey: stream) }
            } else if channel.openingStreams.contains(stream) {
                guard (channel.earlyEvents[stream]?.count ?? 0) < 16 else {
                    throw DesktopError("The terminal output queue is full. Reattach to recover its recording.")
                }
                channel.earlyEvents[stream, default: []].append(message)
            }
            return
        }
        guard message["type"].string == "response", (100...599).contains(message["status"].int) else {
            throw DesktopError("The server sent an invalid response.")
        }
        let id = message["id"].string
        guard let waiter = channel.pending.removeValue(forKey: id) else { return }
        channel.deadlines.removeValue(forKey: id)?.cancel()
        if (200...299).contains(message["status"].int) {
            waiter.resume(returning: message["body"])
        } else {
            channel.openingStreams.remove(id)
            channel.earlyEvents.removeValue(forKey: id)
            let body = message["body"]
            waiter.resume(throwing: DesktopError(body["error"].string.isEmpty ? "The server refused this request." : body["error"].string, code: body["code"].string, status: message["status"].int))
        }
    }

    private func exchange(_ fields: [String: JSON]) async throws -> JSON {
        try await connect()
        guard case .open(let channel) = state, channel.pending.count < 8 else {
            throw DesktopError("The connection is busy. Try again shortly.")
        }
        requestCounter += 1
        let id = String(requestCounter)
        if fields["type"]?.string == "terminal-open" { channel.openingStreams.insert(id) }
        var object = fields
        object["id"] = .string(id)
        object["token"] = .string(token)
        let frame = try channel.cipher.seal(.object(object))
        let encoded = String(decoding: try frame.data(), as: UTF8.self)
        let channelID = channel.id
        return try await withCheckedThrowingContinuation { continuation in
            channel.pending[id] = continuation
            channel.deadlines[id] = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { return }
                await self?.disconnectIfCurrent(
                    channelID: channelID,
                    error: DesktopError("Connection timed out. Delivery may be uncertain; inspect the session before retrying.", code: "delivery-unknown")
                )
            }
            if case .terminated = channel.outboundContinuation.yield(OutboundFrame(payload: encoded, completion: nil)) {
                let waiter = channel.pending.removeValue(forKey: id)
                channel.deadlines.removeValue(forKey: id)?.cancel()
                channel.openingStreams.remove(id)
                waiter?.resume(throwing: DesktopError("Connection interrupted. A pending send may have been delivered. Check the session before retrying.", code: "delivery-unknown"))
            }
        }
    }

    public func request(_ path: String, body: JSON? = nil, method: String? = nil, controlID: String? = nil) async throws -> JSON {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), !path.contains("#") else {
            throw DesktopError("Invalid request path.")
        }
        var headers: [String: JSON] = ["X-Infinite-Client": .string(clientID)]
        if let controlID { headers["X-Infinite-Control"] = .string(controlID) }
        var fields: [String: JSON] = ["type": .string("request"), "method": .string(method ?? (body == nil ? "GET" : "POST")), "path": .string("/api" + path), "headers": .object(headers)]
        if let body { fields["body"] = body }
        return try await exchange(fields)
    }

    public func openTerminal(sessionID: String, after: Int = 0, handler: @escaping @Sendable (JSON) -> Void) async throws -> String {
        let reply = try await exchange(["type": .string("terminal-open"), "sessionId": .string(sessionID), "clientId": .string(clientID), "after": .number(Double(after)), "snapshot": .bool(true)])
        let id = reply["streamId"].string
        guard case .open(let channel) = state else {
            throw DesktopError("The connection is closed.")
        }
        channel.openingStreams.remove(id)
        guard !id.isEmpty else { throw DesktopError("The server did not open a terminal stream.") }
        channel.streams[id] = handler
        for event in channel.earlyEvents.removeValue(forKey: id) ?? [] { handler(event) }
        return id
    }

    public func sendTerminal(_ streamID: String, message: JSON) async throws {
        guard case .open(let channel) = state, channel.streams[streamID] != nil else {
            throw DesktopError("Reattach the terminal before sending input.")
        }
        try await notify(["type": .string("terminal-send"), "streamId": .string(streamID), "message": message])
    }

    public func closeTerminal(_ streamID: String) async {
        guard case .open(let channel) = state, channel.streams.removeValue(forKey: streamID) != nil else { return }
        channel.earlyEvents.removeValue(forKey: streamID)
        try? await notify(["type": .string("terminal-close"), "streamId": .string(streamID)])
    }

    private func notify(_ fields: [String: JSON]) async throws {
        guard case .open(let channel) = state else {
            throw DesktopError("The terminal disconnected. Reattach before sending input.")
        }
        requestCounter += 1
        var object = fields
        object["id"] = .string(String(requestCounter))
        object["token"] = .string(token)
        let encoded = String(decoding: try channel.cipher.seal(.object(object)).data(), as: UTF8.self)
        try await withCheckedThrowingContinuation { continuation in
            if case .terminated = channel.outboundContinuation.yield(OutboundFrame(payload: encoded, completion: continuation)) {
                continuation.resume(throwing: DesktopError("The terminal disconnected. Reattach before sending input."))
            }
        }
    }

    public func close() {
        disconnect(DesktopError("Connection closed."))
        state = .closed
    }

    private func isChannelOpen(_ channelID: UUID) -> Bool {
        guard case .open(let channel) = state else { return false }
        return channel.id == channelID
    }

    private func disconnectIfCurrent(channelID: UUID, error: Error) {
        guard case .open(let channel) = state, channel.id == channelID else { return }
        disconnect(error)
    }

    private func disconnect(_ error: Error) {
        let current = state
        if case .closed = current { return }
        state = .idle
        switch current {
        case .idle, .closed:
            return
        case .connecting(let connecting):
            connecting.task?.cancel()
            connecting.socket?.cancel(with: .goingAway, reason: nil)
            connecting.session?.invalidateAndCancel()
        case .open(let channel):
            channel.receiver.cancel()
            channel.outboundContinuation.finish()
            channel.socket.cancel(with: .goingAway, reason: nil)
            channel.session.invalidateAndCancel()
            let waiters = Array(channel.pending.values)
            channel.pending.removeAll()
            for waiter in waiters {
                waiter.resume(throwing: DesktopError("Connection interrupted. A pending send may have been delivered. Check the session before retrying.", code: "delivery-unknown"))
            }
            for task in channel.deadlines.values { task.cancel() }
            channel.deadlines.removeAll()
            for (id, handler) in channel.streams {
                handler(.object(["type": .string("terminal-closed"), "streamId": .string(id), "code": .number(1006)]))
            }
            channel.streams.removeAll()
            channel.earlyEvents.removeAll()
            channel.openingStreams.removeAll()
        }
    }
}
