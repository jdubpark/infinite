import XCTest
import InfiniteCore
@testable import InfiniteDesktop

private actor SessionDeferred<Value: Sendable> {
    private var entered = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var valueWaiters: [CheckedContinuation<Value, Error>] = []
    private var result: Result<Value, Error>?

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { entryWaiters.append($0) }
    }

    func wait() async throws -> Value {
        if let result { return try result.get() }
        entered = true
        let waiters = entryWaiters
        entryWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        return try await withCheckedThrowingContinuation { valueWaiters.append($0) }
    }

    func succeed(_ value: Value) {
        result = .success(value)
        let waiters = valueWaiters
        valueWaiters.removeAll()
        for waiter in waiters { waiter.resume(returning: value) }
    }

    func fail(_ error: Error) {
        result = .failure(error)
        let waiters = valueWaiters
        valueWaiters.removeAll()
        for waiter in waiters { waiter.resume(throwing: error) }
    }
}

private actor SessionMemoryDrafts {
    var records: [String: DraftRecord] = [:]
    var saveLog: [(String, DraftRecord)] = []
    var clearLog: [(String, String)] = []

    func read(_ key: String) -> DraftRecord { records[key] ?? DraftRecord() }

    func save(_ record: DraftRecord, key: String) {
        records[key] = record
        saveLog.append((key, record))
    }

    func acquireMutation(_ key: String, text: String) -> DraftRecord {
        var current = records[key] ?? DraftRecord()
        if current.pending == nil {
            current.pending = PendingSend(id: UUID().uuidString.lowercased(), text: text)
            records[key] = current
            saveLog.append((key, current))
        }
        return current
    }

    func clearIfMatching(_ requestID: String, key: String) {
        clearLog.append((requestID, key))
        if records[key]?.pending?.id == requestID {
            records[key] = DraftRecord()
        }
    }
}

private actor SessionRequestLog {
    var requests: [(String, JSON?, String?)] = []
    func record(_ path: String, _ body: JSON?, _ controlID: String?) {
        requests.append((path, body, controlID))
    }
}

@MainActor final class SessionModelSafetyTests: XCTestCase {
    private func makeClient() -> RemoteClient {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        return RemoteClient(profile: profile, token: "token-a")
    }

    private func makeSession(id: String = "sess-1") -> AgentSession {
        AgentSession(value: .object(["id": .string(id), "status": .string("running")]))
    }

    func testTypingBeforeInitialDraftLoadCompletesRecoversPendingSendAndPreservesTypedText() async throws {
        let readGate = SessionDeferred<DraftRecord>()
        let drafts = SessionMemoryDrafts()
        let deps = SessionModelDependencies(
            readDraft: { _ in try await readGate.wait() },
            saveDraft: { draft, key in await drafts.save(draft, key: key) },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, _, _, _ in .object([:]) },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        model.attached = true
        model.setDraft("freshly typed text")
        try await Task.sleep(for: .milliseconds(300))

        let earlySaves = await drafts.saveLog
        XCTAssertTrue(earlySaves.isEmpty)
        XCTAssertFalse(model.canSend)

        let stored = DraftRecord(text: "old draft", pending: PendingSend(id: "req-pending", text: "old send"), lastQueuedText: "prev")
        await readGate.succeed(stored)
        await model.draftLoadTask?.value

        XCTAssertTrue(model.draftLoaded)
        XCTAssertEqual(model.draft.text, "freshly typed text")
        XCTAssertEqual(model.draft.pending, PendingSend(id: "req-pending", text: "old send"))
        XCTAssertEqual(model.draft.lastQueuedText, "prev")
        XCTAssertFalse(model.canSend)
        let persisted = await drafts.read("profile-a:sess-1")
        XCTAssertEqual(persisted.pending?.id, "req-pending")
        XCTAssertEqual(persisted.text, "freshly typed text")
    }

    func testConcurrentTypingDuringAutosaveNeverSkipsDurablePreSendSave() async throws {
        let drafts = SessionMemoryDrafts()
        let firstSaveGate = SessionDeferred<Void>()
        let requestLog = SessionRequestLog()
        actor SaveCounter {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let saveCounter = SaveCounter()
        let futureExpiry = Date().addingTimeInterval(600).timeIntervalSince1970 * 1000
        let deps = SessionModelDependencies(
            readDraft: { await drafts.read($0) },
            saveDraft: { draft, key in
                if await saveCounter.next() == 1 { try await firstSaveGate.wait() }
                await drafts.save(draft, key: key)
            },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, path, body, controlID in
                await requestLog.record(path, body, controlID)
                return .object(["state": .string("delivered")])
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        await model.draftLoadTask?.value
        model.attached = true
        model.lease = .object(["id": .string("lease-1"), "expiresAt": .number(futureExpiry)])

        model.setDraft("first prompt")
        try await Task.sleep(for: .milliseconds(300))
        await firstSaveGate.waitUntilEntered()

        let sendTask = Task { await model.send() }
        await Task.yield()
        model.setDraft("first prompt edited")
        await firstSaveGate.succeed(())
        await sendTask.value

        let requests = await requestLog.requests
        let inputRequests = requests.filter { $0.0.hasSuffix("/input") }
        XCTAssertEqual(inputRequests.count, 1)
        let sentRequestID = try XCTUnwrap(inputRequests.first?.1?["requestId"].string)
        let saves = await drafts.saveLog
        XCTAssertTrue(saves.contains { $0.1.pending?.id == sentRequestID })
    }

    func testSendRevalidatesLeaseAndAttachmentAfterDraftSaveBeforePostingInput() async throws {
        let drafts = SessionMemoryDrafts()
        let saveGate = SessionDeferred<Void>()
        let requestLog = SessionRequestLog()
        let futureExpiry = Date().addingTimeInterval(600).timeIntervalSince1970 * 1000
        let deps = SessionModelDependencies(
            readDraft: { await drafts.read($0) },
            saveDraft: { draft, key in
                try await saveGate.wait()
                await drafts.save(draft, key: key)
            },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, path, body, controlID in
                await requestLog.record(path, body, controlID)
                return .object(["state": .string("delivered")])
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        await model.draftLoadTask?.value
        model.attached = true
        model.lease = .object(["id": .string("lease-1"), "expiresAt": .number(futureExpiry)])
        model.setDraft("hello world")

        let sendTask = Task { await model.send() }
        await saveGate.waitUntilEntered()

        model.lease = .object(["id": .string("lease-2"), "expiresAt": .number(futureExpiry)])
        model.controlGeneration = UUID()
        await saveGate.succeed(())
        await sendTask.value

        let requests = await requestLog.requests
        XCTAssertTrue(requests.filter { $0.0.hasSuffix("/input") }.isEmpty)
        XCTAssertNil(model.draft.pending)
        XCTAssertEqual(model.draft.text, "hello world")
        XCTAssertEqual(model.notice, "Control changed before sending input. Refresh and try again.")
    }

    func testFailedControlClaimPreservesPendingAutosaveTask() async throws {
        let drafts = SessionMemoryDrafts()
        let requestLog = SessionRequestLog()
        let deps = SessionModelDependencies(
            readDraft: { await drafts.read($0) },
            saveDraft: { draft, key in await drafts.save(draft, key: key) },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, path, body, controlID in
                await requestLog.record(path, body, controlID)
                throw DesktopError("Control refused")
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        await model.draftLoadTask?.value
        model.attached = true
        model.setDraft("keep my unsaved draft")

        await model.send()
        try await Task.sleep(for: .milliseconds(350))

        let persisted = await drafts.read("profile-a:sess-1")
        XCTAssertEqual(persisted.text, "keep my unsaved draft")
        XCTAssertNil(persisted.pending)
    }

    func testConcurrentLifecycleCallsShareOneMutationIDAndClearMatchingOnly() async throws {
        let drafts = SessionMemoryDrafts()
        let gate = SessionDeferred<Void>()
        let requestLog = SessionRequestLog()
        let deps = SessionModelDependencies(
            readDraft: { await drafts.read($0) },
            saveDraft: { draft, key in await drafts.save(draft, key: key) },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, path, body, controlID in
                await requestLog.record(path, body, controlID)
                try await gate.wait()
                return .object(["id": .string("resumed-1")])
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        await model.draftLoadTask?.value

        let first = Task { await model.resume() }
        let second = Task { await model.resume() }
        try await Task.sleep(for: .milliseconds(30))
        await gate.succeed(())
        await first.value
        await second.value

        let requests = await requestLog.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].1?["requestId"].string, requests[1].1?["requestId"].string)
        let cleared = await drafts.clearLog
        XCTAssertEqual(cleared.count, 2)
        let resumeDraft = await drafts.read("profile-a:sess-1:resume")
        XCTAssertEqual(resumeDraft, DraftRecord())
    }

    func testLocalFolderListingStateClearsEntriesImmediatelyOnFolderSwitchAndRejectsStaleResults() {
        var state = LocalFolderListingState()
        let rootA = URL(fileURLWithPath: "/home/dev/folder-a", isDirectory: true)
        let rootB = URL(fileURLWithPath: "/home/dev/folder-b", isDirectory: true)
        let reqA = state.beginLoad(root: rootA, path: "")!
        let oldEntry = FileEntry(path: "secret.txt", name: "secret.txt", kind: "file", size: 42)
        XCTAssertTrue(state.finish(generation: reqA.generation, key: reqA.key, entries: [oldEntry]))
        state.selection = ["secret.txt"]

        let reqB = state.beginLoad(root: rootB, path: "")!
        XCTAssertTrue(state.entries.isEmpty)
        XCTAssertTrue(state.selection.isEmpty)
        XCTAssertFalse(state.loaded)
        XCTAssertTrue(state.loading)

        XCTAssertFalse(state.finish(generation: reqA.generation, key: reqA.key, entries: [oldEntry]))
        XCTAssertTrue(state.entries.isEmpty)

        let newEntry = FileEntry(path: "readme.md", name: "readme.md", kind: "file", size: 10)
        XCTAssertTrue(state.finish(generation: reqB.generation, key: reqB.key, entries: [newEntry]))
        XCTAssertEqual(state.entries.map(\.path), ["readme.md"])
        XCTAssertTrue(state.loaded)
        XCTAssertFalse(state.loading)
    }

    func testDetachTerminatesPromptlyWhenFlushSaveFails() async throws {
        let drafts = SessionMemoryDrafts()
        actor SaveCalls {
            var count = 0
            func bump() { count += 1 }
        }
        let calls = SaveCalls()
        let deps = SessionModelDependencies(
            readDraft: { await drafts.read($0) },
            saveDraft: { _, _ in
                await calls.bump()
                throw DesktopError("Disk full")
            },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, _, _, _ in .object([:]) },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        await model.draftLoadTask?.value
        model.setDraft("unsaved text")

        await model.detach()

        let saveAttempts = await calls.count
        XCTAssertEqual(saveAttempts, 1)
        XCTAssertEqual(model.notice, "Disk full")
    }

    func testReconnectedRetryRemainsBoundToOriginalPromptWhenEarlierSendUnwinds() async throws {
        let drafts = SessionMemoryDrafts()
        let firstSaveGate = SessionDeferred<Void>()
        let requestLog = SessionRequestLog()
        actor SaveCounter {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let saveCounter = SaveCounter()
        let futureExpiry = Date().addingTimeInterval(600).timeIntervalSince1970 * 1000
        let deps = SessionModelDependencies(
            readDraft: { await drafts.read($0) },
            saveDraft: { draft, key in
                if await saveCounter.next() == 1 { try await firstSaveGate.wait() }
                await drafts.save(draft, key: key)
            },
            acquireMutation: { key, text in await drafts.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await drafts.clearIfMatching(id, key: key) },
            sendRequest: { _, path, body, controlID in
                await requestLog.record(path, body, controlID)
                return .object(["state": .string("delivered")])
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: makeSession(), client: makeClient(), profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
        await model.draftLoadTask?.value
        model.attached = true
        model.lease = .object(["id": .string("lease-1"), "expiresAt": .number(futureExpiry)])
        model.setDraft("original prompt")

        let firstSend = Task { await model.send() }
        await firstSaveGate.waitUntilEntered()
        let capturedRequestID = try XCTUnwrap(model.draft.pending?.id)

        model.connectionLost()
        model.attached = true
        model.lease = .object(["id": .string("lease-2"), "expiresAt": .number(futureExpiry)])
        model.setDraft("different composer text")

        let retrySend = Task { await model.send(retry: true) }
        await firstSaveGate.succeed(())
        await firstSend.value
        await retrySend.value

        let requests = await requestLog.requests.filter { $0.0.hasSuffix("/input") }
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.1?["requestId"].string, capturedRequestID)
        XCTAssertEqual(requests.first?.1?["text"].string, "original prompt")
    }
}
