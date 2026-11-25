import XCTest
import CryptoKit
import Network
@testable import InfiniteCore

private actor MockRemoteServer {
    private let token: String
    private let serverID = UUID().uuidString.lowercased()
    private var listener: NWListener?
    private var activeConnection: NWConnection?
    private var openedStreams: [String] = []
    private var closedStreams: [String] = []
    private var sentStreams: [String] = []

    init(token: String) {
        self.token = token
    }

    func start() async throws -> Int {
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        let listener = try NWListener(using: params, on: .any)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            Task { await self?.accept(connection) }
        }
        return try await withCheckedThrowingContinuation { continuation in
            let resumed = LockFreeInt64(0)
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if resumed.add(1) == 1 {
                        continuation.resume(returning: Int(listener.port?.rawValue ?? 0))
                    }
                case .failed(let error):
                    if resumed.add(1) == 1 {
                        continuation.resume(throwing: error)
                    }
                default:
                    break
                }
            }
            listener.start(queue: DispatchQueue(label: "mock-remote-server"))
        }
    }

    func stop() {
        activeConnection?.cancel()
        activeConnection = nil
        listener?.cancel()
        listener = nil
    }

    func dropActiveConnection() {
        activeConnection?.cancel()
        activeConnection = nil
    }

    func recordedOpenedStreams() -> [String] { openedStreams }
    func recordedClosedStreams() -> [String] { closedStreams }
    func recordedSentStreams() -> [String] { sentStreams }

    private func accept(_ connection: NWConnection) {
        activeConnection = connection
        connection.start(queue: DispatchQueue(label: "mock-remote-conn"))
        Task {
            do {
                guard let helloData = try await receiveText(on: connection) else { return }
                let hello = try JSON.parse(helloData)
                let key = SymmetricKey(data: SHA256.hash(data: Data(token.utf8)))
                let welcomeNonce = Data(repeating: 0x33, count: 32).hex
                let transcript = try JSON.array([
                    .string("infinite-remote-v1"),
                    hello["machineId"],
                    .string(serverID),
                    hello["nonce"],
                    .string(welcomeNonce),
                    hello["proof"],
                ]).data()
                let proofData = try JSON.array([
                    .string("infinite-remote-v1"),
                    .string("server"),
                    .string(transcript.hex),
                ]).data()
                let proof = HMAC<SHA256>.authenticationCode(for: proofData, using: key)
                let welcome: JSON = .object([
                    "type": .string("welcome"),
                    "version": .number(1),
                    "machineId": .string(serverID),
                    "nonce": .string(welcomeNonce),
                    "proof": .string(Data(proof).hex),
                ])
                try await sendText(welcome.data(), on: connection)

                let context = Data(SHA256.hash(data: transcript))
                let material = HKDF<SHA256>.deriveKey(
                    inputKeyMaterial: key,
                    salt: context,
                    info: Data("infinite-remote-v1:directional-keys".utf8),
                    outputByteCount: 64
                )
                let bytes = material.withUnsafeBytes { Data($0) }
                let receiveKey = SymmetricKey(data: bytes.prefix(32))
                let sendKey = SymmetricKey(data: bytes.suffix(32))
                var receivedSeq: UInt64 = 0
                var sentSeq: UInt64 = 0

                while let frameData = try await receiveText(on: connection) {
                    let frame = try JSON.parse(frameData)
                    let cipherBytes = try XCTUnwrap(Data(hex: frame["data"].string))
                    let box = try AES.GCM.SealedBox(
                        nonce: try nonce(receivedSeq),
                        ciphertext: cipherBytes.dropLast(16),
                        tag: cipherBytes.suffix(16)
                    )
                    let clear = try AES.GCM.open(box, using: receiveKey, authenticating: try aad("client", receivedSeq, context: context))
                    receivedSeq += 1
                    let msg = try JSON.parse(clear)
                    switch msg["type"].string {
                    case "terminal-open":
                        let id = msg["id"].string
                        openedStreams.append(id)
                        let reply: JSON = .object([
                            "type": .string("response"),
                            "id": .string(id),
                            "status": .number(200),
                            "body": .object(["streamId": .string(id)]),
                        ])
                        let sealed = try AES.GCM.seal(
                            try reply.data(),
                            using: sendKey,
                            nonce: try nonce(sentSeq),
                            authenticating: try aad("server", sentSeq, context: context)
                        )
                        let wrapped: JSON = .object([
                            "type": .string("ciphertext"),
                            "seq": .number(Double(sentSeq)),
                            "data": .string((sealed.ciphertext + sealed.tag).hex),
                        ])
                        sentSeq += 1
                        try await sendText(wrapped.data(), on: connection)
                    case "terminal-close":
                        closedStreams.append(msg["streamId"].string)
                    case "terminal-send":
                        sentStreams.append(msg["streamId"].string)
                    default:
                        break
                    }
                }
            } catch {
            }
        }
    }

    private func nonce(_ seq: UInt64) throws -> AES.GCM.Nonce {
        var n = seq.bigEndian
        return try AES.GCM.Nonce(data: Data(repeating: 0, count: 4) + withUnsafeBytes(of: &n) { Data($0) })
    }

    private func aad(_ direction: String, _ seq: UInt64, context: Data) throws -> Data {
        try JSON.array([.string("infinite-remote-v1"), .string(context.hex), .string(direction), .number(Double(seq))]).data()
    }

    private func receiveText(on connection: NWConnection) async throws -> Data? {
        try await withCheckedThrowingContinuation { continuation in
            connection.receiveMessage { data, _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: data)
            }
        }
    }

    private func sendText(_ data: Data, on connection: NWConnection) async throws {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [meta])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }
}

final class TransportSafetyTests: XCTestCase {
    func testRemoteClientStreamIDsDoNotRepeatAcrossReconnects() async throws {
        let token = String(repeating: "a", count: 32)
        let server = MockRemoteServer(token: token)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let client = RemoteClient(
            profile: HostProfile(label: "Local", origin: "http://127.0.0.1:\(port)"),
            token: token
        )
        let stream1 = try await client.openTerminal(sessionID: "s1") { _ in }
        await server.dropActiveConnection()
        try await Task.sleep(for: .milliseconds(50))

        let stream2 = try await client.openTerminal(sessionID: "s1") { _ in }
        XCTAssertNotEqual(stream1, stream2)

        await client.closeTerminal(stream1)
        try await client.sendTerminal(stream2, message: .object(["op": .string("raw"), "text": .string("ok")]))
        try await Task.sleep(for: .milliseconds(50))

        let closed = await server.recordedClosedStreams()
        let sent = await server.recordedSentStreams()
        XCTAssertEqual(closed, [])
        XCTAssertEqual(sent, [stream2])
        await client.close()
    }

    func testCmuxHelperProcessBoundsStdoutIngressBeforeAsyncStream() async throws {
        let helper = try CmuxHelperProcess(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "head -c 65536 /dev/zero | tr '\\0' 'a'; sleep 2"],
            maxStdoutBufferBytes: 4096,
            maxStderrBufferBytes: 4096
        )
        do {
            _ = try await helper.readLine(deadline: Date().addingTimeInterval(5))
            XCTFail("Expected stdout ingress overflow")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("limit"))
        }
        await helper.stop()
    }

    func testCmuxHelperProcessBoundsStderrIngressBeforeAsyncStream() async throws {
        let helper = try CmuxHelperProcess(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "head -c 65536 /dev/zero | tr '\\0' 'b' >&2; sleep 2"],
            maxStdoutBufferBytes: 4096,
            maxStderrBufferBytes: 4096
        )
        do {
            _ = try await helper.readLine(deadline: Date().addingTimeInterval(5))
            XCTFail("Expected stderr ingress overflow")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("limit"))
        }
        await helper.stop()
    }

    func testCmuxHelperProcessReleasesIngressBytesDuringNormalStreaming() async throws {
        let helper = try CmuxHelperProcess(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "while IFS= read -r line; do printf '%s\\n' \"$line\"; done"],
            maxStdoutBufferBytes: 128,
            maxStderrBufferBytes: 128
        )
        for index in 0..<12 {
            let payload = #"{"seq":\#(index),"pad":"0123456789abcdef"}"#
            try await helper.write(Data((payload + "\n").utf8))
            let line = try await helper.readLine(deadline: Date().addingTimeInterval(5))
            let json = try JSON.parse(line)
            XCTAssertEqual(json["seq"].int, index)
        }
        await helper.stop()
    }

    func testCmuxHelperProcessRejectsBufferedLinesAfterFramingFailure() async throws {
        let helper = try CmuxHelperProcess(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "i=0; while [ $i -lt 260 ]; do echo '{\"ok\":true}'; i=$((i+1)); done; sleep 1"]
        )
        try await Task.sleep(for: .milliseconds(150))
        do {
            _ = try await helper.readLine(deadline: Date().addingTimeInterval(5))
            XCTFail("Expected buffered lines to be rejected once limit failure was latched")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("limit"))
        }
        await helper.stop()
    }
}
