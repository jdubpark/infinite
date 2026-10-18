import Foundation

public actor RemoteClient {
    public let clientID = UUID().uuidString.lowercased()
    private let profile: HostProfile
    private let token: String
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var cipher: RemoteCipher?
    private var opening: Task<Void, Error>?
    private var receiver: Task<Void, Never>?
    private var outbound: Task<Void, Error>?
    private var requestCounter = 0
    private var generation = UUID()
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    private var deadlines: [String: Task<Void, Never>] = [:]
    private var streams: [String: @Sendable (JSON) -> Void] = [:]
    private var earlyEvents: [String: [JSON]] = [:]
    private var openingStreams: Set<String> = []
    private var stopped = false
    public init(profile: HostProfile, token: String) { self.profile = profile; self.token = token }
    public var authenticatedMachineID: String? { cipher?.machineID }
    public func connect() async throws {
        if cipher != nil { return }
        if let opening { return try await opening.value }
        guard !stopped else { throw DesktopError("This connection is closed.") }
        let task = Task { try await self.handshake() }; opening = task
        do { try await task.value; opening = nil } catch { opening = nil; disconnect(error); throw error }
    }
    private func handshake() async throws {
        let config = URLSessionConfiguration.ephemeral
        // A WebSocket is a long-lived session. A short resource timeout closes
        // healthy terminals even while requests and output are flowing.
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 7 * 24 * 60 * 60
        let session = URLSession(configuration: config); self.session = session
        let socket = session.webSocketTask(with: try profile.socketURL()); socket.maximumMessageSize = 8 * 1024 * 1024 + 4096
        self.socket = socket; socket.resume()
        let handshake = try RemoteHandshake(token: token, machineID: profile.relayMachineID ?? "")
        try await socket.send(.string(String(decoding: handshake.hello.data(), as: UTF8.self)))
        let welcome: JSON = try await withThrowingTaskGroup(of: JSON.self) { group in
            group.addTask { try await Self.receive(socket) }
            group.addTask { try await Task.sleep(nanoseconds: 10_000_000_000); socket.cancel(with: .goingAway, reason: nil); throw DesktopError("The server did not authenticate in time.") }
            defer { group.cancelAll() }
            return try await group.next()!
        }
        cipher = try handshake.accept(welcome, pinnedMachineID: profile.pinnedMachineID)
        generation = UUID(); let current = generation
        receiver = Task {
            do {
                while !Task.isCancelled { let frame = try await Self.receive(socket); try self.received(frame, generation: current) }
            } catch { if current == self.generation { self.disconnect(error) } }
        }
    }
    private static func receive(_ socket: URLSessionWebSocketTask) async throws -> JSON {
        switch try await socket.receive() {
        case .string(let string): return try JSON.parse(Data(string.utf8))
        default: throw DesktopError("The server sent an invalid encrypted frame.")
        }
    }
    private func received(_ frame: JSON, generation current: UUID) throws {
        guard current == generation, cipher != nil else { return }
        let message = try cipher!.open(frame)
        if message["type"].string == "terminal-event" || message["type"].string == "terminal-closed" {
            let stream = message["streamId"].string
            if let handler = streams[stream] {
                handler(message)
                if message["type"].string == "terminal-closed" { streams.removeValue(forKey: stream) }
            } else if openingStreams.contains(stream) {
                guard (earlyEvents[stream]?.count ?? 0) < 16 else { throw DesktopError("The terminal output queue is full. Reattach to recover its recording.") }
                earlyEvents[stream, default: []].append(message)
            }
            return
        }
        guard message["type"].string == "response", (100...599).contains(message["status"].int) else { throw DesktopError("The server sent an invalid response.") }
        let id = message["id"].string
        guard let waiter = pending.removeValue(forKey: id) else { return }
        deadlines.removeValue(forKey: id)?.cancel()
        if (200...299).contains(message["status"].int) { waiter.resume(returning: message["body"]) }
        else {
            openingStreams.remove(id); earlyEvents.removeValue(forKey: id)
            let body = message["body"]
            waiter.resume(throwing: DesktopError(body["error"].string.isEmpty ? "The server refused this request." : body["error"].string, code: body["code"].string, status: message["status"].int))
        }
    }
    private func exchange(_ fields: [String: JSON]) async throws -> JSON {
        try await connect()
        guard pending.count < 8, let socket, cipher != nil else { throw DesktopError("The connection is busy. Try again shortly.") }
        requestCounter += 1; let id = String(requestCounter)
        if fields["type"]?.string == "terminal-open" { openingStreams.insert(id) }
        var object = fields; object["id"] = .string(id); object["token"] = .string(token)
        let frame = try cipher!.seal(.object(object))
        let encoded = String(decoding: try frame.data(), as: UTF8.self)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            deadlines[id] = Task { try? await Task.sleep(nanoseconds: 30_000_000_000); if !Task.isCancelled { self.disconnect(DesktopError("Connection timed out. Delivery may be uncertain; inspect the session before retrying.", code: "delivery-unknown")) } }
            let previous = outbound
            let current = generation
            outbound = Task {
                do { try await previous?.value; try await socket.send(.string(encoded)) }
                catch { if current == self.generation { self.disconnect(error) }; throw error }
            }
        }
    }
    public func request(_ path: String, body: JSON? = nil, method: String? = nil, controlID: String? = nil) async throws -> JSON {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), !path.contains("#") else { throw DesktopError("Invalid request path.") }
        var headers: [String: JSON] = ["X-Infinite-Client": .string(clientID)]
        if let controlID { headers["X-Infinite-Control"] = .string(controlID) }
        var fields: [String: JSON] = ["type": .string("request"), "method": .string(method ?? (body == nil ? "GET" : "POST")), "path": .string("/api" + path), "headers": .object(headers)]
        if let body { fields["body"] = body }
        return try await exchange(fields)
    }
    public func openTerminal(sessionID: String, after: Int = 0, handler: @escaping @Sendable (JSON) -> Void) async throws -> String {
        let reply = try await exchange(["type": .string("terminal-open"), "sessionId": .string(sessionID), "clientId": .string(clientID), "after": .number(Double(after)), "snapshot": .bool(true)])
        let id = reply["streamId"].string
        openingStreams.remove(id)
        guard !id.isEmpty else { throw DesktopError("The server did not open a terminal stream.") }
        streams[id] = handler
        for event in earlyEvents.removeValue(forKey: id) ?? [] { handler(event) }
        return id
    }
    public func sendTerminal(_ streamID: String, message: JSON) async throws {
        guard streams[streamID] != nil else { throw DesktopError("Reattach the terminal before sending input.") }
        try await notify(["type": .string("terminal-send"), "streamId": .string(streamID), "message": message])
    }
    public func closeTerminal(_ streamID: String) async {
        guard streams.removeValue(forKey: streamID) != nil else { return }
        earlyEvents.removeValue(forKey: streamID)
        try? await notify(["type": .string("terminal-close"), "streamId": .string(streamID)])
    }
    /// Sending is not a delivery receipt. The terminal gateway reports receipts separately.
    private func notify(_ fields: [String: JSON]) async throws {
        guard let socket, cipher != nil else { throw DesktopError("The terminal disconnected. Reattach before sending input.") }
        requestCounter += 1
        var object = fields; object["id"] = .string(String(requestCounter)); object["token"] = .string(token)
        let encoded = String(decoding: try cipher!.seal(.object(object)).data(), as: UTF8.self)
        let previous = outbound; let current = generation
        let task = Task {
            do { try await previous?.value; try await socket.send(.string(encoded)) }
            catch { if current == self.generation { self.disconnect(error) }; throw error }
        }
        outbound = task; try await task.value
    }
    public func close() { stopped = true; disconnect(DesktopError("Connection closed.")) }
    private func disconnect(_ error: Error) {
        generation = UUID(); cipher = nil; receiver?.cancel(); receiver = nil; outbound?.cancel(); outbound = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; session?.invalidateAndCancel(); session = nil
        let waiters = Array(pending.values); pending.removeAll()
        for waiter in waiters { waiter.resume(throwing: DesktopError("Connection interrupted. A pending send may have been delivered. Check the session before retrying.", code: "delivery-unknown")) }
        for task in deadlines.values { task.cancel() }; deadlines.removeAll()
        for (id, handler) in streams { handler(.object(["type": .string("terminal-closed"), "streamId": .string(id), "code": .number(1006)])) }
        streams.removeAll(); earlyEvents.removeAll(); openingStreams.removeAll()
    }
}
