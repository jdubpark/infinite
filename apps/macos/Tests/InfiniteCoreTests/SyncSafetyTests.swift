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

    /// The installed app keeps the draft key and folder it always used; every other build gets its own, so a
    /// rehearsal copy or unbundled binary never reads, rotates, or writes beside the installed app's drafts.
    func testDraftLocationIsTheInstalledAppsOnlyForItsBundleID() {
        XCTAssertEqual(DraftLocation(bundleID: "dev.infinite.desktop").service, "dev.infinite.desktop.device")
        XCTAssertEqual(DraftLocation(bundleID: "dev.infinite.desktop").directory, "Infinite/Drafts")
        let rehearsal = DraftLocation(bundleID: "dev.infinite.rehearsal.e2e")
        XCTAssertEqual(rehearsal.service, "dev.infinite.desktop.device.dev.infinite.rehearsal.e2e")
        XCTAssertEqual(rehearsal.directory, "Infinite/Drafts-dev.infinite.rehearsal.e2e")
        XCTAssertEqual(DraftLocation(bundleID: nil).directory, "Infinite/Drafts-unbundled")
        XCTAssertEqual(DraftLocation(bundleID: "..").directory, "Infinite/Drafts-unbundled")
        XCTAssertEqual(DraftLocation(bundleID: "a/../b").directory, "Infinite/Drafts-a-..-b")
        XCTAssertNotEqual(DraftLocation(bundleID: "dev.infinite.desktop.beta"), DraftLocation(bundleID: "dev.infinite.desktop"))
    }

    func testUnderstandingSnapshotCacheEncryptsAndScopesBoundedOfflineSnapshots() async throws {
        let location = DraftLocation(bundleID: "dev.infinite.test-\(UUID().uuidString.lowercased())")
        let service = "\(location.service).understanding-snapshots"
        let cacheDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Infinite/Understanding-\(URL(fileURLWithPath: location.directory).lastPathComponent)", isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: cacheDirectory)
            try? DeviceKeychain.remove("snapshot-key", service: service)
        }

        let store = UnderstandingSnapshotStore(location: location)
        let secretText = "private workspace source snapshot"
        for index in 0..<5 {
            try await store.mergeOverview(host: "host-A", credential: "credential-A", workspace: "workspace-\(index)",
                                          membershipRevision: index, data: Data(secretText.utf8))
        }
        let encryptedFile = cacheDirectory.appendingPathComponent("workspace-snapshots.sealed")
        let ciphertext = try Data(contentsOf: encryptedFile)
        XCTAssertFalse(String(decoding: ciphertext, as: UTF8.self).contains(secretText))

        let recent = try await store.readRecent(host: "host-A", credential: "credential-A")
        XCTAssertEqual(recent.count, 4)
        let otherHost = try await store.read(host: "other-host", credential: "credential-A", workspace: "workspace-4", membershipRevision: 4)
        XCTAssertNil(otherHost)
        let otherCredential = try await store.read(host: "host-A", credential: "other-credential", workspace: "workspace-4", membershipRevision: 4)
        XCTAssertNil(otherCredential)
        let staleRevision = try await store.read(host: "host-A", credential: "credential-A", workspace: "workspace-4", membershipRevision: 3)
        XCTAssertNil(staleRevision)
        let current = try await store.read(host: "host-A", credential: "credential-A", workspace: "workspace-4", membershipRevision: 4)
        XCTAssertNotNil(current)
        let expired = try await store.read(host: "host-A", credential: "credential-A", workspace: "workspace-4", membershipRevision: 4,
                                           now: Date().addingTimeInterval(25 * 60 * 60))
        XCTAssertNil(expired)

        let overview = try JSON.object(["schemaVersion": .number(1), "workspace": .object(["id": .string("workspace-4")])]).data()
        let catalog = try JSON.object(["revision": .number(7), "projects": .array([])]).data()
        let components = try JSON.array([.object(["id": .string("component-a")])]).data()
        let detail = try JSON.object(["component": .object(["id": .string("component-a")]), "relationships": .array([])]).data()

        // Exercise overview-first and knowledge-first writer orders, then cold-open as an offline reader.
        try await store.mergeOverview(host: "host-A", credential: "credential-A", workspace: "workspace-4",
                                      membershipRevision: 4, data: overview)
        try await store.mergeKnowledge(host: "host-A", credential: "credential-A", workspace: "workspace-4",
                                       membershipRevision: 4, catalog: catalog, components: components)
        try await store.mergeComponentDetail(host: "host-A", credential: "credential-A", workspace: "workspace-4",
                                             membershipRevision: 4, id: "component-a", detail: detail)
        try await assertOfflineSnapshot(UnderstandingSnapshotStore(location: location), workspace: "workspace-4",
                                        revision: 4, overview: overview, catalog: catalog, components: components, detail: detail)

        try await store.mergeOverview(host: "host-A", credential: "credential-A", workspace: "workspace-4",
                                      membershipRevision: 4, data: overview)
        try await assertOfflineSnapshot(UnderstandingSnapshotStore(location: location), workspace: "workspace-4",
                                        revision: 4, overview: overview, catalog: catalog, components: components, detail: detail)
    }

    func testUnderstandingSnapshotStoreSharesRegistryAndSerializesConcurrentMerges() async throws {
        let location = DraftLocation(bundleID: "dev.infinite.concurrent-\(UUID().uuidString.lowercased())")
        let service = "\(location.service).understanding-snapshots"
        let cacheDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Infinite/Understanding-\(URL(fileURLWithPath: location.directory).lastPathComponent)", isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: cacheDirectory)
            try? DeviceKeychain.remove("snapshot-key", service: service)
        }

        let first = await UnderstandingSnapshotStore.shared(location: location)
        let second = await UnderstandingSnapshotStore.shared(location: location)
        XCTAssertTrue(first === second)

        let overview = try JSON.object(["schemaVersion": .number(1), "workspace": .object(["id": .string("ws-1")])]).data()
        let catalog = try JSON.object(["revision": .number(2), "projects": .array([])]).data()
        let components = try JSON.array([.object(["id": .string("comp-0")])]).data()

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await first.mergeOverview(host: "h", credential: "c", workspace: "ws-1", membershipRevision: 2, data: overview)
            }
            group.addTask {
                try await second.mergeKnowledge(host: "h", credential: "c", workspace: "ws-1", membershipRevision: 2, catalog: catalog, components: components)
            }
            for index in 0..<8 {
                let detail = try JSON.object(["component": .object(["id": .string("comp-\(index)")])]).data()
                group.addTask {
                    try await first.mergeComponentDetail(host: "h", credential: "c", workspace: "ws-1", membershipRevision: 2, id: "comp-\(index)", detail: detail)
                }
            }
            try await group.waitForAll()
        }

        let fetched = try await second.read(host: "h", credential: "c", workspace: "ws-1", membershipRevision: 2)
        let snapshot = try XCTUnwrap(fetched)
        XCTAssertEqual(snapshot.envelope.overview, overview)
        XCTAssertEqual(snapshot.envelope.catalog, catalog)
        XCTAssertEqual(snapshot.envelope.components, components)
        XCTAssertEqual(snapshot.envelope.componentDetails.count, 8)
    }

    func testDraftRecordPreservesPendingWireFormatAndRejectsMissingID() throws {
        var record = DraftRecord()
        record.text = "draft"
        record.pending = PendingSend(id: "req-1", text: "draft")
        record.lastQueuedText = "prev"
        let encoded = try JSONEncoder().encode(record)
        let wire = try JSON.parse(encoded)
        XCTAssertEqual(wire["pendingID"].string, "req-1")
        XCTAssertEqual(wire["pendingText"].string, "draft")

        let decoded = try JSONDecoder().decode(DraftRecord.self, from: encoded)
        XCTAssertEqual(decoded, record)

        let idOnly = try JSON.object(["text": .string(""), "pendingID": .string("req-2")]).data()
        let decodedIDOnly = try JSONDecoder().decode(DraftRecord.self, from: idOnly)
        XCTAssertEqual(decodedIDOnly.pending, PendingSend(id: "req-2", text: ""))

        let textOnly = try JSON.object(["text": .string(""), "pendingText": .string("orphan")]).data()
        let decodedTextOnly = try JSONDecoder().decode(DraftRecord.self, from: textOnly)
        XCTAssertNil(decodedTextOnly.pending)
    }

    func testDraftStoreSharesRegistryAndSerializesConcurrentSaves() async throws {
        let location = DraftLocation(bundleID: "dev.infinite.drafts-\(UUID().uuidString.lowercased())")
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(location.directory, isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? DeviceKeychain.remove("encrypted-drafts", service: location.service)
        }

        let first = await DraftStore.shared(location: location)
        let second = await DraftStore.shared(location: location)
        XCTAssertTrue(first === second)

        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 0..<8 {
                let record = DraftRecord(text: "draft-\(index)", pending: PendingSend(id: "req-\(index)", text: "send-\(index)"))
                group.addTask {
                    try await first.save(record, identity: "session-\(index)")
                }
            }
            try await group.waitForAll()
        }

        for index in 0..<8 {
            let loaded = try await second.read("session-\(index)")
            XCTAssertEqual(loaded.text, "draft-\(index)")
            XCTAssertEqual(loaded.pending, PendingSend(id: "req-\(index)", text: "send-\(index)"))
        }
    }

    private func assertOfflineSnapshot(_ store: UnderstandingSnapshotStore, workspace: String, revision: Int,
                                       overview: Data, catalog: Data, components: Data, detail: Data,
                                       file: StaticString = #filePath, line: UInt = #line) async throws {
        let snapshot = try await store.read(host: "host-A", credential: "credential-A", workspace: workspace, membershipRevision: revision)
        let cached = try XCTUnwrap(snapshot, file: file, line: line)
        XCTAssertEqual(cached.envelope.overview, overview, file: file, line: line)
        XCTAssertEqual(cached.envelope.catalog, catalog, file: file, line: line)
        XCTAssertEqual(cached.envelope.components, components, file: file, line: line)
        XCTAssertEqual(cached.envelope.componentDetails["component-a"], detail, file: file, line: line)
        XCTAssertEqual(try JSON.parse(XCTUnwrap(cached.envelope.overview, file: file, line: line))["workspace"]["id"].string,
                       workspace, file: file, line: line)
        XCTAssertEqual(try JSON.parse(XCTUnwrap(cached.envelope.catalog, file: file, line: line))["revision"].int,
                       7, file: file, line: line)
        XCTAssertEqual(try JSON.parse(XCTUnwrap(cached.envelope.components, file: file, line: line)).array.first?["id"].string,
                       "component-a", file: file, line: line)
        XCTAssertEqual(try JSON.parse(XCTUnwrap(cached.envelope.componentDetails["component-a"], file: file, line: line))["component"]["id"].string,
                       "component-a", file: file, line: line)
    }

    func testCancelledTaskPreventsInstallAsyncAndTransfersFromProceeding() async throws {
        var root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = try LocalFiles.canonicalRoot(root)
        defer { try? FileManager.default.removeItem(at: root) }

        let target = root.appendingPathComponent("cancelled.txt")
        let stagedImmediate = try LocalFiles.stage(root: root, path: "cancelled.txt")
        try stagedImmediate.handle.write(contentsOf: Data("should not install".utf8))

        let gate = AsyncStream<Void>.makeStream()
        let preCancelled = Task {
            for await _ in gate.stream {}
            try await LocalFiles.installAsync(stagedImmediate, expected: nil)
        }
        preCancelled.cancel()
        gate.continuation.finish()
        do {
            try await preCancelled.value
            XCTFail("Expected pre-cancelled installAsync to throw CancellationError")
        } catch is CancellationError {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))

        let stagedBlocked = try LocalFiles.stage(root: root, path: "cancelled.txt")
        try stagedBlocked.handle.write(contentsOf: Data("blocked by coordinator".utf8))
        let coordinatorEntered = DispatchSemaphore(value: 0)
        let releaseCoordinator = DispatchSemaphore(value: 0)
        defer { releaseCoordinator.signal() }
        DispatchQueue.global(qos: .userInitiated).async {
            var coordinationError: NSError?
            NSFileCoordinator().coordinate(writingItemAt: stagedBlocked.destination, options: .forReplacing, error: &coordinationError) { _ in
                coordinatorEntered.signal()
                _ = releaseCoordinator.wait(timeout: .now() + 5)
            }
        }
        XCTAssertEqual(coordinatorEntered.wait(timeout: .now() + 2), .success)
        let inFlightInstall = Task {
            try await LocalFiles.installAsync(stagedBlocked, expected: nil)
        }
        try await Task.sleep(for: .milliseconds(30))
        inFlightInstall.cancel()
        do {
            try await inFlightInstall.value
            XCTFail("Expected in-flight installAsync to throw CancellationError")
        } catch is CancellationError {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))

        let source = root.appendingPathComponent("upload-source.txt")
        try Data("payload".utf8).write(to: source)
        let version = try XCTUnwrap(LocalFiles.version(root: root, path: "upload-source.txt"))
        let profile = HostProfile(id: "p1", label: "A", origin: "https://a.example.com")
        let transfer = FileTransfer(client: RemoteClient(profile: profile, token: "t"), projectID: "proj")

        let uploadTask = Task {
            await Task.yield()
            try await transfer.upload(root: root, localPath: "upload-source.txt", remotePath: "upload-source.txt", source: version, expectedRemote: nil) { _ in }
        }
        uploadTask.cancel()
        do {
            try await uploadTask.value
            XCTFail("Expected cancelled upload to throw CancellationError")
        } catch is CancellationError {}

        let downloadTask = Task {
            await Task.yield()
            try await transfer.download(remotePath: "missing.txt", root: root, localPath: "dest.txt", source: version, expectedLocal: nil) { _ in }
        }
        downloadTask.cancel()
        do {
            try await downloadTask.value
            XCTFail("Expected cancelled download to throw CancellationError")
        } catch is CancellationError {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("dest.txt").path))
    }

    func testDraftStoreReadOrCreatePendingIsAtomicAcrossConcurrentCallers() async throws {
        let location = DraftLocation(bundleID: "dev.infinite.atomic-\(UUID().uuidString.lowercased())")
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(location.directory, isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? DeviceKeychain.remove("encrypted-drafts", service: location.service)
        }
        let store = await DraftStore.shared(location: location)
        try await store.save(DraftRecord(), identity: "warmup")
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        do {
            _ = try await store.readOrCreatePending(identity: "sess-1:resume", text: "resume")
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            XCTFail("Expected readOrCreatePending to fail on read-only draft directory")
        } catch {}
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        let results = try await withThrowingTaskGroup(of: DraftRecord.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    try await store.readOrCreatePending(identity: "sess-1:resume", text: "resume")
                }
            }
            var collected: [DraftRecord] = []
            for try await item in group { collected.append(item) }
            return collected
        }
        XCTAssertEqual(results.count, 8)
        let ids = results.map(\.pendingID)
        XCTAssertTrue(ids.allSatisfy { $0 != nil })
        let uniqueIDs = Set(ids)
        XCTAssertEqual(uniqueIDs.count, 1)
        let acquiredID = try XCTUnwrap(uniqueIDs.first.flatMap { $0 })

        let reopened = DraftStore(location: location)
        let persisted = try await reopened.read("sess-1:resume")
        XCTAssertEqual(persisted.pendingID, acquiredID)
        XCTAssertEqual(persisted.pendingText, "resume")

        try await reopened.clearIfMatching(requestID: "wrong-id", identity: "sess-1:resume")
        let retained = try await reopened.read("sess-1:resume")
        XCTAssertEqual(retained.pendingID, acquiredID)

        try await reopened.clearIfMatching(requestID: acquiredID, identity: "sess-1:resume")
        let cleared = try await reopened.read("sess-1:resume")
        XCTAssertEqual(cleared, DraftRecord())
    }
}
