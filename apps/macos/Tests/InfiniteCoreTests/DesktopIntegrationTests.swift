import XCTest
import CryptoKit
@testable import InfiniteCore

private actor TerminalMessages {
    var values: [JSON] = []
    func append(_ value: JSON) { values.append(value) }
    func waitFor(_ matches: @Sendable ([JSON]) -> Bool) async throws {
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline {
            if matches(values) { return }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        throw DesktopError("The real terminal did not deliver the expected event before the deadline.")
    }
}

/// Run with scripts/test-macos-integration.ts, which owns an isolated Node host.
final class DesktopIntegrationTests: XCTestCase {
    func testEncryptedSwiftClientTransfersBinaryFilesAndSteersRealTerminal() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["INFINITE_TEST_ORIGIN"], let token = environment["INFINITE_TEST_TOKEN"] else {
            throw XCTSkip("Use the isolated macOS integration harness to exercise a real encrypted Node host.")
        }
        let client = RemoteClient(profile: HostProfile(label: "Integration fixture", origin: origin), token: token)
        addTeardownBlock { await client.close() }
        let identity = try await client.request("/me")
        XCTAssertEqual(identity["role"].string, "owner")
        XCTAssertEqual(identity["capabilities"]["remoteTerminal"].int, 1)
        let transfer = FileTransfer(client: client, projectID: "rehearsal")
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data((0..<153_600).map { UInt8($0 % 256) })
        try bytes.write(to: root.appendingPathComponent("source.bin"))
        let source = try XCTUnwrap(LocalFiles.version(root: root, path: "source.bin"))
        try await transfer.upload(root: root, localPath: "source.bin", remotePath: "nested/swift-upload.bin", source: source, expectedRemote: nil, progress: { _ in })
        let remoteVersion = try await transfer.metadata(path: "nested/swift-upload.bin")
        let remote = try XCTUnwrap(remoteVersion)
        XCTAssertEqual(remote.sha256, Data(SHA256.hash(data: bytes)).hex)
        let listing = try await transfer.list(path: "nested")
        XCTAssertTrue(listing.entries.contains { $0.name == "swift-upload.bin" && $0.size == bytes.count })
        try await transfer.download(remotePath: "nested/swift-upload.bin", root: root, localPath: "download.bin", source: remote, expectedLocal: nil, progress: { _ in })
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("download.bin")), bytes)

        // Change the real server file after pinning its previous version. The
        // old hash must fail before a replacement becomes visible on this Mac.
        let changed = Data("new server content".utf8), changedHash = Data(SHA256.hash(data: changed)).hex
        let upload = try await client.request("/projects/rehearsal/uploads", body: .object(["path": .string("nested/swift-upload.bin"), "size": .number(Double(changed.count)), "sha256": .string(changedHash), "expectedHash": .string(remote.sha256)]))
        let uploadID = upload["uploadId"].string
        _ = try await client.request("/projects/rehearsal/uploads/" + uploadID, body: .object(["offset": .number(0), "base64": .string(changed.base64EncodedString())]), method: "PUT")
        _ = try await client.request("/projects/rehearsal/uploads/" + uploadID + "/commit", body: .object([:]))
        do {
            try await transfer.download(remotePath: "nested/swift-upload.bin", root: root, localPath: "stale.bin", source: remote, expectedLocal: nil, progress: { _ in })
            XCTFail("A stale server version must be refused")
        } catch let error as DesktopError { XCTAssertEqual(error.code, "file-conflict") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("stale.bin").path))

        let session = try await client.request("/sessions", body: .object(["requestId": .string(UUID().uuidString.lowercased()), "provider": .string("demo"), "projectId": .string("rehearsal"), "title": .string("Swift encrypted terminal"), "prompt": .string("")]))
        let sessionID = session["id"].string, messages = TerminalMessages()
        let stream = try await client.openTerminal(sessionID: sessionID) { page in Task { await messages.append(page) } }
        try await messages.waitFor { pages in
            pages.contains { page in
                page["message"]["snapshot"]["ansi"].string.contains("local continuity rehearsal") ||
                page["message"]["events"].array.contains { $0["data"]["text"].string.contains("local continuity rehearsal") }
            }
        }
        let control = try await client.request("/sessions/" + sessionID + "/control", body: .object(["action": .string("claim")]))
        let lease = control["control"]["id"].string, inputID = UUID().uuidString.lowercased()
        try await client.sendTerminal(stream, message: .object(["op": .string("raw"), "requestId": .string(inputID), "text": .string("Swift terminal input\r"), "leaseId": .string(lease)]))
        try await messages.waitFor { pages in pages.contains { $0["message"]["receipt"]["requestId"].string == inputID && $0["message"]["receipt"]["state"].string == "delivered" } }
        _ = try await client.request("/sessions/" + sessionID + "/stop", body: .object(["requestId": .string(UUID().uuidString.lowercased())]), controlID: lease)
        await client.closeTerminal(stream)
        // Closing more than the concurrent-stream cap must not retain orphan
        // close events or drop the encrypted connection.
        for _ in 0..<6 {
            let reopened = try await client.openTerminal(sessionID: sessionID) { _ in }
            await client.closeTerminal(reopened)
        }
        let stillConnected = try await client.request("/me")
        XCTAssertEqual(stillConnected["machine"]["id"], identity["machine"]["id"])
        await client.close()
    }
}
