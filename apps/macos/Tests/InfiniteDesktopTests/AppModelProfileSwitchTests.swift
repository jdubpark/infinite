import XCTest
import InfiniteCore
@testable import InfiniteDesktop

private actor DeferredValue<Value: Sendable> {
    private var entered = false
    private var entryWaiter: CheckedContinuation<Void, Never>?
    private var valueWaiter: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { entryWaiter = $0 }
    }

    func wait() async throws -> Value {
        if let result { return try result.get() }
        entered = true
        entryWaiter?.resume()
        entryWaiter = nil
        return try await withCheckedThrowingContinuation { valueWaiter = $0 }
    }

    func succeed(_ value: Value) {
        result = .success(value)
        valueWaiter?.resume(returning: value)
        valueWaiter = nil
    }
}

private actor CallRecorder {
    var closedCount = 0
    var savedDrafts: [(String, DraftRecord)] = []
    var clearedChecks: [(String, String)] = []
    var sentRequests: [(String, JSON)] = []
    func recordClose() { closedCount += 1 }
    func recordSave(_ key: String, _ draft: DraftRecord) { savedDrafts.append((key, draft)) }
    func recordClear(_ requestID: String, _ key: String) { clearedChecks.append((requestID, key)) }
    func recordSend(_ path: String, _ body: JSON) { sentRequests.append((path, body)) }
}

private actor MemoryDraftStore {
    private var records: [String: DraftRecord] = [:]
    func read(_ key: String) -> DraftRecord { records[key] ?? DraftRecord() }
    func save(_ record: DraftRecord, key: String) { records[key] = record }
    func clearIfMatching(_ requestID: String, key: String) {
        if records[key]?.pending?.id == requestID { records[key] = DraftRecord() }
    }
}

@MainActor final class AppModelProfileSwitchTests: XCTestCase {
    func testProfileSwitchWhileDraftReadsArePendingNeverPublishesPreviousProfileDraft() async {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let gateA = DeferredValue<DraftRecord>()
        let recorder = CallRecorder()
        let draftA = DraftRecord(text: "stale-a", pending: PendingSend(id: "req-a", text: "{\"requestId\":\"req-a\"}"))
        let draftB = DraftRecord(text: "clean-b")
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { client in
                let id = await client.clientID
                return .object(["role": .string("owner"), "machine": .object(["id": .string(id)])])
            },
            readDraft: { key in
                if key == "profile-a:create-team" { return try await gateA.wait() }
                if key == "profile-b:create-team" { return draftB }
                return DraftRecord()
            },
            saveDraft: { _, _ in },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, path, body in
                await recorder.recordSend(path, body)
                return .object([:])
            },
            closeClient: { _ in await recorder.recordClose() }
        )

        let model = AppModel(deps: deps)
        let connectA = Task { await model.connect() }
        await gateA.waitUntilEntered()

        model.activeID = profileB.id
        await model.connect()
        XCTAssertEqual(model.activeID, profileB.id)
        XCTAssertEqual(model.pendingTeamCreation, draftB)
        let clientB = model.client

        await gateA.succeed(draftA)
        await connectA.value

        XCTAssertEqual(model.activeID, profileB.id)
        XCTAssertEqual(model.pendingCreation, DraftRecord())
        XCTAssertEqual(model.pendingTeamCreation, draftB)
        XCTAssertEqual(model.pendingMissionCreation, DraftRecord())
        let expectedID = await clientB?.clientID
        XCTAssertEqual(model.me["machine"]["id"].string, expectedID)
        let closes = await recorder.closedCount
        XCTAssertGreaterThanOrEqual(closes, 1)
    }

    func testSubmitDuringReconnectIsRejectedAndPreservesLoadedPendingDraft() async throws {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let gate = DeferredValue<DraftRecord>()
        let recorder = CallRecorder()
        let savedPending = PendingSend(id: "saved-req-1", text: "{\"objective\":\"Original\",\"projectId\":\"p1\",\"provider\":\"claude\",\"requestId\":\"saved-req-1\",\"title\":\"Original\"}")
        let savedDraft = DraftRecord(pending: savedPending)
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { $0 == "profile-a:create-team" ? try await gate.wait() : DraftRecord() },
            saveDraft: { draft, key in await recorder.recordSave(key, draft) },
            clearDraftIfMatching: { requestID, key in await recorder.recordClear(requestID, key) },
            sendRequest: { _, path, body in
                await recorder.recordSend(path, body)
                return .object(["id": .string("team-saved")])
            },
            closeClient: { _ in await recorder.recordClose() }
        )

        let model = AppModel(deps: deps)
        let connectTask = Task { await model.connect() }
        await gate.waitUntilEntered()

        XCTAssertNil(model.client)
        XCTAssertFalse(model.connected)
        do {
            try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "Duplicate", objective: "Should reject")
            XCTFail("Expected createTeam while connecting to reject")
        } catch let error as DesktopError {
            XCTAssertEqual(error.message, "Connect to a server first.")
        }
        let earlySends = await recorder.sentRequests
        let earlySaves = await recorder.savedDrafts
        XCTAssertTrue(earlySends.isEmpty)
        XCTAssertTrue(earlySaves.isEmpty)

        await gate.succeed(savedDraft)
        await connectTask.value
        XCTAssertTrue(model.connected)
        XCTAssertNotNil(model.client)
        XCTAssertEqual(model.pendingTeamCreation, savedDraft)

        try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "Ignored", objective: "Ignored")
        let sent = await recorder.sentRequests
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].1["requestId"].string, "saved-req-1")
        let cleared = await recorder.clearedChecks
        XCTAssertEqual(cleared.count, 1)
        XCTAssertEqual(cleared[0].0, "saved-req-1")
        XCTAssertEqual(cleared[0].1, "profile-a:create-team")
    }

    func testProfileSwitchWhileSavingPendingCreateNeverSendsToNewProfileOrClearsItsDraft() async {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let saveGate = DeferredValue<Void>()
        let recorder = CallRecorder()
        let draftB = DraftRecord(text: "profile-b-draft", pending: PendingSend(id: "req-b", text: "{\"requestId\":\"req-b\"}"))
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { $0 == "profile-b:create-team" ? draftB : DraftRecord() },
            saveDraft: { _, key in
                if key == "profile-a:create-team" { try await saveGate.wait() }
            },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, path, body in
                await recorder.recordSend(path, body)
                return .object(["id": .string("team-a")])
            },
            closeClient: { _ in await recorder.recordClose() }
        )

        let model = AppModel(deps: deps)
        await model.connect()
        let createOnA = Task { try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "A", objective: "Do A") }
        await saveGate.waitUntilEntered()

        model.activeID = profileB.id
        await model.connect()
        XCTAssertEqual(model.pendingTeamCreation, draftB)

        await saveGate.succeed(())
        do {
            try await createOnA.value
            XCTFail("Expected createTeam on A to throw after switching to B")
        } catch {
            XCTAssertTrue(error is DesktopError)
        }

        let sent = await recorder.sentRequests
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(model.pendingTeamCreation, draftB)
        XCTAssertNil(model.selectedTeamID)
    }

    func testStaleSubmitCompletionDoesNotEraseNewerReplacementDraftOnDisk() async throws {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let store = MemoryDraftStore()
        let sendGate = DeferredValue<JSON>()
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { await store.read($0) },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, body in
                if body["title"].string == "First" { return try await sendGate.wait() }
                return .object(["id": .string("team-second")])
            },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        await model.connect()
        let firstCreate = Task { try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "First", objective: "First") }
        await sendGate.waitUntilEntered()
        let firstSaved = await store.read("profile-a:create-team")
        let firstReqID = try XCTUnwrap(firstSaved.pending?.id)

        await model.connect()
        let replacement = DraftRecord(pending: PendingSend(id: "replacement-req", text: "{\"requestId\":\"replacement-req\",\"title\":\"Second\"}"))
        await store.save(replacement, key: "profile-a:create-team")
        await model.connect()
        XCTAssertEqual(model.pendingTeamCreation, replacement)

        await sendGate.succeed(.object(["id": .string("team-first")]))
        try await firstCreate.value

        let persisted = await store.read("profile-a:create-team")
        XCTAssertEqual(persisted.pending?.id, "replacement-req")
        XCTAssertNotEqual(firstReqID, "replacement-req")
        XCTAssertEqual(model.pendingTeamCreation, replacement)
        XCTAssertNil(model.selectedTeamID)
    }

    func testClearWhilePendingIsEmptyOrMismatchedNeverErasesOnDiskDraft() async {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let store = MemoryDraftStore()
        let savedOnDisk = DraftRecord(pending: PendingSend(id: "disk-req-1", text: "{\"requestId\":\"disk-req-1\"}"))
        await store.save(savedOnDisk, key: "profile-a:create")
        await store.save(savedOnDisk, key: "profile-a:create-team")
        await store.save(savedOnDisk, key: "profile-a:create-mission")
        let gate = DeferredValue<DraftRecord>()
        let recorder = CallRecorder()
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in
                if key == "profile-a:create" { return try await gate.wait() }
                return await store.read(key)
            },
            saveDraft: { draft, key in
                await recorder.recordSave(key, draft)
                await store.save(draft, key: key)
            },
            clearDraftIfMatching: { requestID, key in
                await recorder.recordClear(requestID, key)
                await store.clearIfMatching(requestID, key: key)
            },
            sendRequest: { _, _, _ in .object([:]) },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        let connectTask = Task { await model.connect() }
        await gate.waitUntilEntered()

        XCTAssertNil(model.pendingCreation.pending)
        model.clearCreation()
        model.clearTeamCreation()
        model.clearMissionCreation()
        await Task.yield()

        let emptyClearCalls = await recorder.clearedChecks
        let emptySaveCalls = await recorder.savedDrafts
        XCTAssertTrue(emptyClearCalls.isEmpty)
        XCTAssertTrue(emptySaveCalls.isEmpty)
        let stillOnDisk = await store.read("profile-a:create")
        XCTAssertEqual(stillOnDisk, savedOnDisk)

        await gate.succeed(savedOnDisk)
        await connectTask.value
        model.clearCreation(expectedProfileID: profileB.id, expectedRequestID: "disk-req-1")
        model.clearCreation(expectedProfileID: profileA.id, expectedRequestID: "other-req")
        await Task.yield()
        let mismatchedClearCalls = await recorder.clearedChecks
        XCTAssertTrue(mismatchedClearCalls.isEmpty)
        let retainedAfterMismatch = await store.read("profile-a:create")
        XCTAssertEqual(retainedAfterMismatch, savedOnDisk)
    }

    func testSameProfileReconnectReloadingOriginalDraftClearsInMemoryWhenOriginalSendSucceeds() async throws {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let store = MemoryDraftStore()
        let sendGate = DeferredValue<JSON>()
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { await store.read($0) },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in try await sendGate.wait() },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        await model.connect()
        let createTask = Task { try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "First", objective: "First") }
        await sendGate.waitUntilEntered()
        let firstSaved = await store.read("profile-a:create-team")
        XCTAssertNotNil(firstSaved.pending?.id)

        await model.connect()
        XCTAssertEqual(model.pendingTeamCreation, firstSaved)

        await sendGate.succeed(.object(["id": .string("team-1")]))
        try await createTask.value

        let diskAfter = await store.read("profile-a:create-team")
        XCTAssertEqual(diskAfter, DraftRecord())
        XCTAssertEqual(model.pendingTeamCreation, DraftRecord())
        XCTAssertNil(model.selectedTeamID)
    }

    func testReconnectNeverRepublishesDraftClearedDuringSubsequentDraftReads() async throws {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let store = MemoryDraftStore()
        let sendGate = DeferredValue<JSON>()
        let teamReadGate = DeferredValue<DraftRecord>()
        let gateReads = AsyncStream<Void>.makeStream()
        let gateSecondConnect = DeferredValue<Void>()
        actor SwitchState {
            var blockSecondTeamRead = false
            func enable() { blockSecondTeamRead = true }
            func disable() { blockSecondTeamRead = false }
        }
        let switchState = SwitchState()
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in
                if key == "profile-a:create-team", await switchState.blockSecondTeamRead {
                    await switchState.disable()
                    gateReads.continuation.yield()
                    try await gateSecondConnect.wait()
                }
                return await store.read(key)
            },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in try await sendGate.wait() },
            closeClient: { _ in }
        )
        _ = teamReadGate

        let model = AppModel(deps: deps)
        await model.connect()
        let createTask = Task { try await model.create(provider: "claude", project: "p1", title: "Session") }
        await sendGate.waitUntilEntered()
        let savedCreate = await store.read("profile-a:create")
        XCTAssertNotNil(savedCreate.pending?.id)

        await switchState.enable()
        let reconnectTask = Task { await model.connect() }
        var iterator = gateReads.stream.makeAsyncIterator()
        await iterator.next()

        await sendGate.succeed(.object(["id": .string("sess-1")]))
        try await createTask.value
        let diskAfterSend = await store.read("profile-a:create")
        XCTAssertEqual(diskAfterSend, DraftRecord())

        await gateSecondConnect.succeed(())
        await reconnectTask.value

        XCTAssertEqual(model.pendingCreation, DraftRecord())
    }

    func testDraftStoreClearIfMatchingPreservesNewerRequestID() async throws {
        let location = DraftLocation(bundleID: "dev.infinite.clear-match-\(UUID().uuidString.lowercased())")
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(location.directory, isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? DeviceKeychain.remove("encrypted-drafts", service: location.service)
        }
        let store = await DraftStore.shared(location: location)
        let newer = DraftRecord(text: "second", pending: PendingSend(id: "req-2", text: "second-body"))
        try await store.save(newer, identity: "profile:create-team")
        try await store.clearIfMatching(requestID: "req-1", identity: "profile:create-team")
        let afterMismatch = try await store.read("profile:create-team")
        XCTAssertEqual(afterMismatch, newer)
        try await store.clearIfMatching(requestID: "req-2", identity: "profile:create-team")
        let afterMatch = try await store.read("profile:create-team")
        XCTAssertEqual(afterMatch, DraftRecord())
    }

    func testMutatingActiveIDBeforeConnectRunsRejectsCreateOnPreviousProfileClient() async throws {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let store = MemoryDraftStore()
        let pendingB = DraftRecord(pending: PendingSend(id: "b-pending-id", text: "{\"requestId\":\"b-pending-id\",\"groupId\":\"g1\",\"name\":\"B Team\",\"goal\":\"Goal\"}"))
        await store.save(pendingB, key: "profile-b:create-team")
        actor SendCounter {
            var count = 0
            func record() { count += 1 }
        }
        let counter = SendCounter()
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in await store.read(key) },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in
                await counter.record()
                return .object(["id": .string("team-x")])
            },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        await model.connect()
        XCTAssertTrue(model.connected)
        XCTAssertEqual(model.activeID, profileA.id)

        model.activeID = profileB.id
        XCTAssertFalse(model.connected)

        do {
            try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "Should Reject", objective: "Goal")
            XCTFail("Expected createTeam to throw before reconnect finishes for profileB")
        } catch let error as DesktopError {
            XCTAssertEqual(error.localizedDescription, "Connect to a server first.")
        }

        let sentCount = await counter.count
        XCTAssertEqual(sentCount, 0)
        let savedA = await store.read("profile-a:create-team")
        let savedB = await store.read("profile-b:create-team")
        XCTAssertEqual(savedA, DraftRecord())
        XCTAssertEqual(savedB, pendingB)
    }

    func testActiveIDChangedSynchronouslyBeforeSecondConnectStartsRejectsLateDraftPublish() async throws {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let store = MemoryDraftStore()
        let draftA = DraftRecord(text: "draft-a", pending: PendingSend(id: "req-a", text: "{\"requestId\":\"req-a\"}"))
        await store.save(draftA, key: "profile-a:create")
        let gateDraftA = DeferredValue<Void>()
        actor ClosedTracker {
            var closedCount = 0
            func markClosed() { closedCount += 1 }
        }
        let closed = ClosedTracker()
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in
                if key == "profile-a:create" { try await gateDraftA.wait() }
                return await store.read(key)
            },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in .object([:]) },
            closeClient: { _ in await closed.markClosed() }
        )

        let model = AppModel(deps: deps)
        let connectA = Task { await model.connect() }
        await gateDraftA.waitUntilEntered()

        model.activeID = profileB.id
        XCTAssertFalse(model.connected)
        XCTAssertNil(model.connectedProfileID)

        await gateDraftA.succeed(())
        await connectA.value

        XCTAssertFalse(model.connected)
        XCTAssertNil(model.connectedProfileID)
        XCTAssertNil(model.client)
        XCTAssertEqual(model.pendingCreation, DraftRecord())
        let closedClients = await closed.closedCount
        XCTAssertEqual(closedClients, 1)
    }

    func testSameProfileReconnectAwaitsDelayedSaveAndNeverOverwritesNewerRequestID() async throws {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let store = MemoryDraftStore()
        let firstSaveGate = DeferredValue<Void>()
        let createReadMilestone = AsyncStream<Void>.makeStream()
        actor ReconnectProbe {
            var createReadCount = 0
            var teamReadCount = 0
            var saveCount = 0
            func nextSave() -> Int { saveCount += 1; return saveCount }
            func recordCreateRead() -> Int { createReadCount += 1; return createReadCount }
            func recordTeamRead() { teamReadCount += 1 }
        }
        let probe = ReconnectProbe()
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in
                if key == "profile-a:create" {
                    let count = await probe.recordCreateRead()
                    if count == 2 { createReadMilestone.continuation.yield() }
                }
                if key == "profile-a:create-team", await probe.saveCount > 0 {
                    await probe.recordTeamRead()
                }
                return await store.read(key)
            },
            saveDraft: { draft, key in
                if await probe.nextSave() == 1 { try await firstSaveGate.wait() }
                await store.save(draft, key: key)
            },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in .object(["id": .string("t-1")]) },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        await model.connect()

        let firstCreate = Task { try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "First", objective: "Goal") }
        await firstSaveGate.waitUntilEntered()
        let firstReqID = model.pendingTeamCreation.pending?.id
        XCTAssertNotNil(firstReqID)

        let reconnect = Task { await model.connect() }
        var milestoneIterator = createReadMilestone.stream.makeAsyncIterator()
        await milestoneIterator.next()
        let teamReadsWhileHeld = await probe.teamReadCount
        XCTAssertEqual(teamReadsWhileHeld, 0)

        await firstSaveGate.succeed(())
        await reconnect.value
        _ = try? await firstCreate.value

        let teamReadsAfter = await probe.teamReadCount
        XCTAssertEqual(teamReadsAfter, 2)
        XCTAssertEqual(model.pendingTeamCreation.pending?.id, firstReqID)
        let savedOnDisk = await store.read("profile-a:create-team")
        XCTAssertEqual(savedOnDisk.pending?.id, firstReqID)
    }

    func testProfileSwitchWhileConnectIsStalledClosesSupersededCandidateImmediately() async throws {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let store = MemoryDraftStore()
        let identityGateA = DeferredValue<JSON>()
        actor CandidateTracker {
            var idsByClient: [ObjectIdentifier: String] = [:]
            var closedIDs: [String] = []
            func register(_ client: RemoteClient, profileID: String) {
                idsByClient[ObjectIdentifier(client)] = profileID
            }
            func close(_ client: RemoteClient) {
                let id = idsByClient[ObjectIdentifier(client)] ?? "unknown"
                closedIDs.append(id)
            }
        }
        let tracker = CandidateTracker()
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { client in
                if await tracker.idsByClient.isEmpty {
                    await tracker.register(client, profileID: profileA.id)
                    return try await identityGateA.wait()
                }
                await tracker.register(client, profileID: profileB.id)
                return .object(["role": .string("owner")])
            },
            readDraft: { key in await store.read(key) },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in .object([:]) },
            closeClient: { client in await tracker.close(client) }
        )

        let model = AppModel(deps: deps)
        let connectA = Task { await model.connect() }
        await identityGateA.waitUntilEntered()

        model.activeID = profileB.id
        await model.connect()

        let closedBeforeStallResolves = await tracker.closedIDs
        XCTAssertEqual(closedBeforeStallResolves, [profileA.id])
        XCTAssertEqual(model.connectedProfileID, profileB.id)
        XCTAssertTrue(model.connected)

        await identityGateA.succeed(.object(["role": .string("owner")]))
        await connectA.value

        let closedAfterAll = await tracker.closedIDs
        XCTAssertEqual(closedAfterAll, [profileA.id])
        XCTAssertEqual(model.connectedProfileID, profileB.id)
    }

    func testAbortedConnectOnProfileChangeClearsConnectingFlagSoSwitchingBackConnects() async throws {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let store = MemoryDraftStore()
        let gateDraftA = DeferredValue<Void>()
        actor SwitchBehavior {
            var blockFirstA = true
            func consumeBlock() -> Bool {
                if blockFirstA { blockFirstA = false; return true }
                return false
            }
        }
        let behavior = SwitchBehavior()
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in
                if key == "profile-a:create", await behavior.consumeBlock() {
                    try await gateDraftA.wait()
                }
                return await store.read(key)
            },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in .object([:]) },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        let firstConnectA = Task { await model.connect() }
        await gateDraftA.waitUntilEntered()

        model.activeID = profileB.id
        await gateDraftA.succeed(())
        await firstConnectA.value
        XCTAssertFalse(model.connecting)
        XCTAssertFalse(model.connected)

        model.activeID = profileA.id
        await model.connect()
        XCTAssertTrue(model.connected)
        XCTAssertFalse(model.connecting)
        XCTAssertEqual(model.connectedProfileID, profileA.id)
    }

    func testClearPendingDraftAndSubmitPendingCreateAreMutuallyExclusive() async throws {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let store = MemoryDraftStore()
        let initialPending = DraftRecord(pending: PendingSend(id: "req-team-1", text: "{\"requestId\":\"req-team-1\",\"title\":\"T\"}"))
        await store.save(initialPending, key: "profile-a:create-team")
        let clearGate = DeferredValue<Void>()
        let recorder = CallRecorder()
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { await store.read($0) },
            saveDraft: { draft, key in
                await recorder.recordSave(key, draft)
                await store.save(draft, key: key)
            },
            clearDraftIfMatching: { requestID, key in
                try await clearGate.wait()
                await recorder.recordClear(requestID, key)
                await store.clearIfMatching(requestID, key: key)
            },
            sendRequest: { _, path, body in
                await recorder.recordSend(path, body)
                return .object(["id": .string("team-1")])
            },
            closeClient: { _ in }
        )

        let model = AppModel(deps: deps)
        await model.connect()
        XCTAssertEqual(model.pendingTeamCreation, initialPending)

        model.clearTeamCreation()
        await clearGate.waitUntilEntered()

        do {
            try await model.createTeam(projectID: "p1", provider: "claude", useLineup: false, title: "Ignored", objective: "Goal")
            XCTFail("Expected createTeam to reject while clearTeamCreation is in progress")
        } catch let error as DesktopError {
            XCTAssertEqual(error.localizedDescription, "A request is already in progress.")
        }

        await clearGate.succeed(())
        try await Task.sleep(for: .milliseconds(30))

        let sent = await recorder.sentRequests
        let cleared = await recorder.clearedChecks
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(cleared.count, 1)
        XCTAssertEqual(model.pendingTeamCreation, DraftRecord())
        let persisted = await store.read("profile-a:create-team")
        XCTAssertEqual(persisted, DraftRecord())
    }

    func testRapidABASwitchBeforeSecondConnectRunsRejectsStaleFirstConnect() async throws {
        let profileA = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let profileB = HostProfile(id: "profile-b", label: "B", origin: "https://b.example.com")
        let store = MemoryDraftStore()
        let draftA = DraftRecord(text: "stale-a", pending: PendingSend(id: "req-a", text: "{\"requestId\":\"req-a\"}"))
        await store.save(draftA, key: "profile-a:create")
        let gateDraftA = DeferredValue<Void>()
        let recorder = CallRecorder()
        let deps = AppModelDependencies(
            loadProfiles: { ([profileA, profileB], profileA.id) },
            saveProfiles: { _, _ in },
            readToken: { "token-\($0)" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { key in
                if key == "profile-a:create" { try await gateDraftA.wait() }
                return await store.read(key)
            },
            saveDraft: { draft, key in await store.save(draft, key: key) },
            clearDraftIfMatching: { requestID, key in await store.clearIfMatching(requestID, key: key) },
            sendRequest: { _, _, _ in .object([:]) },
            closeClient: { _ in await recorder.recordClose() }
        )

        let model = AppModel(deps: deps)
        let connectA = Task { await model.connect() }
        await gateDraftA.waitUntilEntered()

        model.activeID = profileB.id
        model.activeID = profileA.id
        XCTAssertFalse(model.connected)
        XCTAssertFalse(model.connecting)

        await gateDraftA.succeed(())
        await connectA.value

        XCTAssertFalse(model.connected)
        XCTAssertNil(model.connectedProfileID)
        XCTAssertNil(model.client)
        XCTAssertEqual(model.pendingCreation, DraftRecord())
        let closes = await recorder.closedCount
        XCTAssertEqual(closes, 1)
    }
}
