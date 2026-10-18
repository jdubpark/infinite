import XCTest
import Darwin
@testable import InfiniteCore

final class SyncSafetyTests: XCTestCase {
    func testPreviewRequiresDecisionsForDivergenceAndNeverPropagatesDeletion() {
        let original = FileVersion(sha256: "original", size: 1)
        let localEdit = FileVersion(sha256: "local edit", size: 2)
        let remoteEdit = FileVersion(sha256: "remote edit", size: 3)
        let cases: [(FileVersion?, FileVersion?, String?, SyncAction, Bool)] = [
            (original, original, nil, .none, false),
            (localEdit, nil, nil, .upload, false),
            (nil, remoteEdit, nil, .download, false),
            (localEdit, remoteEdit, nil, .none, true),
            (localEdit, original, original.sha256, .upload, false),
            (original, remoteEdit, original.sha256, .download, false),
            (localEdit, remoteEdit, original.sha256, .none, true),
            (nil, original, original.sha256, .none, true),
            (nil, remoteEdit, original.sha256, .none, true),
            (original, nil, original.sha256, .none, true),
            (localEdit, nil, original.sha256, .none, true),
            (nil, nil, original.sha256, .none, false),
        ]
        for (local, remote, baseline, expected, decision) in cases {
            let item = SyncPlanner.classify(path: "notes.txt", local: local, remote: remote, baseline: baseline)
            XCTAssertEqual(item.action, expected)
            XCTAssertEqual(item.needsDecision, decision)
        }
    }

    func testDownloadedFileCannotReplaceNewerLocalContentOrFollowSymlinks() throws {
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("notes.txt")
        let staged = try LocalFiles.stage(root: root, path: "notes.txt")
        try Data("original".utf8).write(to: target)
        let preview = try XCTUnwrap(LocalFiles.version(root: root, path: "notes.txt"))
        try staged.handle.write(contentsOf: Data("new remote content".utf8))
        try Data("new local content after preview".utf8).write(to: target)
        XCTAssertThrowsError(try LocalFiles.install(staged, expected: preview))
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "new local content after preview")
        try FileManager.default.removeItem(at: target)
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: root.appendingPathComponent("untouched"))
        XCTAssertThrowsError(try LocalFiles.install(staged, expected: nil))
        try staged.handle.seek(toOffset: 0)
        XCTAssertEqual(try staged.handle.readToEnd(), Data("new remote content".utf8))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linked"), withDestinationURL: root)
        XCTAssertThrowsError(try LocalFiles.location(root: root, path: "linked/other.txt", createParents: true))
        XCTAssertThrowsError(try LocalFiles.location(root: root, path: "../other.txt", createParents: true))
    }

    func testNewDownloadRefusesUnexpectedDestinationAndInstallsCompleteContent() throws {
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let staged = try LocalFiles.stage(root: root, path: "new.txt"), target = root.appendingPathComponent("new.txt")
        try staged.handle.write(contentsOf: Data("complete verified content".utf8))
        try Data("unexpected competing file".utf8).write(to: target)
        XCTAssertThrowsError(try LocalFiles.install(staged, expected: nil))
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "unexpected competing file")
        try FileManager.default.removeItem(at: target)
        try LocalFiles.install(staged, expected: nil)
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "complete verified content")
    }

    func testReplacementRetainsOpenEditorWritesAndExecutablePermissions() throws {
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("script.sh")
        try Data("original".utf8).write(to: target)
        try FileManager.default.setAttributes([.posixPermissions: 0o750], ofItemAtPath: target.path)
        let expected = try XCTUnwrap(LocalFiles.version(root: root, path: "script.sh"))
        let editor = try FileHandle(forWritingTo: target)
        defer { try? editor.close() }
        do {
            let staged = try LocalFiles.stage(root: root, path: "script.sh")
            try staged.handle.write(contentsOf: Data("downloaded".utf8))
            try LocalFiles.install(staged, expected: expected)
        }
        var retained = stat()
        XCTAssertEqual(fstat(editor.fileDescriptor, &retained), 0)
        XCTAssertGreaterThan(retained.st_nlink, 0, "An editor's displaced inode must remain recoverable after replacement")
        try editor.truncate(atOffset: 0)
        try editor.write(contentsOf: Data("late editor write".utf8))
        try editor.synchronize()
        let recovered = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var preserved = false
        for case let file as URL in recovered {
            if (try? Data(contentsOf: file)) == Data("late editor write".utf8) { preserved = true }
        }
        XCTAssertTrue(preserved, "Writes through an already-open editor must remain available on disk")
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "downloaded")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: target.path)[.posixPermissions] as? NSNumber)?.intValue, 0o750)
    }

    func testDownloadStagingCannotBeRedirectedByMovedParent() throws {
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("chosen"), outside = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try Data("unrelated".utf8).write(to: outside.appendingPathComponent("file.txt"))
        let staged = try LocalFiles.stage(root: root, path: "chosen/file.txt")
        try FileManager.default.moveItem(at: folder, to: root.appendingPathComponent("moved"))
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: outside)
        try staged.handle.write(contentsOf: Data("downloaded".utf8))
        XCTAssertThrowsError(try LocalFiles.install(staged, expected: nil))
        XCTAssertEqual(try String(contentsOf: outside.appendingPathComponent("file.txt"), encoding: .utf8), "unrelated")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), ["file.txt"])
    }

    func testBaselinesAreScopedAndAdvanceOnlyThroughConfirmation() async throws {
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try SyncBaselines(directory: root)
        let before = try await store.read("first folder")
        XCTAssertTrue(before.isEmpty)
        try await store.confirm("notes.txt", hash: "confirmed content", scope: "first folder")
        let confirmed = try await store.read("first folder"), other = try await store.read("second folder")
        XCTAssertEqual(confirmed["notes.txt"], "confirmed content")
        XCTAssertTrue(other.isEmpty)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
}
