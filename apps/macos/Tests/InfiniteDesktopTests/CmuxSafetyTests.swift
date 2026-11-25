import XCTest
import InfiniteCore
@testable import InfiniteDesktop

private actor CmuxDeferred<Value: Sendable> {
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

private actor CmuxFakeBackend {
    var records: [String: DraftRecord] = [:]
    var saveLog: [(String, DraftRecord)] = []
    var clearLog: [(String, String)] = []
    var pastedTexts: [String] = []
    var sentBytes: [Data] = []
    var createdCalls: [([String], String, String, String)] = []
    var closedCalls: [(String, String)] = []
    var outputCallbacks: [String: @Sendable (CmuxTerminalOutput) -> Void] = [:]
    var terminalsPayload: [JSON] = [.object(["id": .string("term-1"), "title": .string("Shell"), "running": .bool(true)])]

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

    func recordPaste(_ text: String) { pastedTexts.append(text) }
    func recordSend(_ data: Data) { sentBytes.append(data) }
    func recordCreate(_ argv: [String], _ cwd: String, _ name: String, _ id: String) { createdCalls.append((argv, cwd, name, id)) }
    func recordClose(_ id: String, _ mutationID: String) { closedCalls.append((id, mutationID)) }
    func setOutput(_ id: String, _ handler: @escaping @Sendable (CmuxTerminalOutput) -> Void) { outputCallbacks[id] = handler }
    func setTerminals(_ rows: [JSON]) { terminalsPayload = rows }
    func emit(_ id: String, _ event: CmuxTerminalOutput) { outputCallbacks[id]?(event) }

    func snapshot() -> JSON {
        .object(["terminals": .array(terminalsPayload), "tabs": .array([]), "panes": .array([]), "screens": .array([]), "workspaces": .array([]), "agents": .array([])])
    }
}

@MainActor final class CmuxSafetyTests: XCTestCase {
    private func makeDeps(
        fake: CmuxFakeBackend,
        readDraft: (@Sendable (String) async throws -> DraftRecord)? = nil,
        saveDraft: (@Sendable (DraftRecord, String) async throws -> Void)? = nil,
        acquireMutation: (@Sendable (String, String) async throws -> DraftRecord)? = nil,
        clearDraftIfMatching: (@Sendable (String, String) async throws -> Void)? = nil
    ) -> CmuxViewModelDependencies {
        CmuxViewModelDependencies(
            helperURL: { URL(fileURLWithPath: "/nonexistent/cmux") },
            connect: { _, _, _, _, _ in },
            snapshot: { await fake.snapshot() },
            attach: { id, handler in
                await fake.setOutput(id, handler)
                handler(.snapshot(Data("ok".utf8), columns: 80, rows: 24))
            },
            detach: {},
            disconnect: {},
            paste: { text in
                await fake.recordPaste(text)
                return .queued
            },
            send: { data in
                await fake.recordSend(data)
                return .queued
            },
            resize: { _, _ in },
            createTerminal: { argv, cwd, name, mutationID in
                await fake.recordCreate(argv, cwd, name, mutationID)
                return "term-created"
            },
            closeTerminal: { id, mutationID in
                await fake.recordClose(id, mutationID)
            },
            readDraft: readDraft ?? { await fake.read($0) },
            saveDraft: saveDraft ?? { draft, key in await fake.save(draft, key: key) },
            acquireMutation: acquireMutation ?? { key, text in await fake.acquireMutation(key, text: text) },
            clearDraftIfMatching: clearDraftIfMatching ?? { id, key in await fake.clearIfMatching(id, key: key) }
        )
    }

    func testConnectLoadsCreationReceiptBeforeEnablingCreation() async throws {
        let fake = CmuxFakeBackend()
        let savedCreationPayload = #"{"id":"orig-creation-1","argv":["claude"],"cwd":"/tmp/work","name":"Claude"}"#
        await fake.save(DraftRecord(pending: PendingSend(id: "orig-creation-1", text: savedCreationPayload)), key: "p1:creation".replacingOccurrences(of: "p1:creation", with: "cmux:p1:creation"))
        let readGate = CmuxDeferred<DraftRecord>()
        let deps = makeDeps(fake: fake, readDraft: { key in
            if key == "cmux:p1:creation" { return try await readGate.wait() }
            return await fake.read(key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        let connectTask = Task { await model.connect() }
        await readGate.waitUntilEntered()

        XCTAssertFalse(model.connected)
        XCTAssertFalse(model.creationReceiptLoaded)
        await model.create(provider: "codex", cwd: "/tmp/other", name: "Ignored")
        let earlyCreated = await fake.createdCalls
        XCTAssertTrue(earlyCreated.isEmpty)

        let existingCreation = await fake.read("cmux:p1:creation")
        await readGate.succeed(existingCreation)
        await connectTask.value

        XCTAssertTrue(model.connected)
        XCTAssertTrue(model.creationReceiptLoaded)
        XCTAssertTrue(model.creationPending)
        await model.retryCreation()
        let calls = await fake.createdCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].3, "orig-creation-1")
    }

    func testSendRechecksInputEnabledBeforeCallingPaste() async throws {
        let fake = CmuxFakeBackend()
        let saveGate = CmuxDeferred<Void>()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            if draft.pending != nil { try await saveGate.wait() }
            await fake.save(draft, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        model.setDisplayVisible(true)
        await model.connect()
        if model.selectedID != "term-1" { await model.select("term-1") }
        try await Task.sleep(for: .milliseconds(50))
        model.rendererRestored(model.rendererGeneration)
        XCTAssertTrue(model.snapshotReady)
        model.setInputEnabled(true)
        XCTAssertTrue(model.inputEnabled)
        model.setDraft("do not paste")
        XCTAssertTrue(model.canSend)

        let sendTask = Task { await model.send() }
        await saveGate.waitUntilEntered()

        model.setInputEnabled(false)
        await saveGate.succeed(())
        await sendTask.value

        let pasted = await fake.pastedTexts
        let sent = await fake.sentBytes
        XCTAssertTrue(pasted.isEmpty)
        XCTAssertTrue(sent.isEmpty)
        XCTAssertNil(model.draft.pending)
        XCTAssertEqual(model.draft.text, "do not paste")
    }

    func testCreationAndTerminationCheckConnectionGenerationAfterPersistence() async throws {
        let fake = CmuxFakeBackend()
        let saveGate = CmuxDeferred<Void>()
        let acquireGate = CmuxDeferred<DraftRecord>()
        let deps = makeDeps(
            fake: fake,
            saveDraft: { draft, key in
                if key == "cmux:p1:creation" { try await saveGate.wait() }
                await fake.save(draft, key: key)
            },
            acquireMutation: { key, text in
                if key == "cmux:p1:terminate:term-1" { return try await acquireGate.wait() }
                return await fake.acquireMutation(key, text: text)
            }
        )

        let model = CmuxViewModel(deps: deps)
        model.profiles = [
            CmuxHostProfile(id: "p1", label: "One", route: "wss://one.example/v1/link"),
            CmuxHostProfile(id: "p2", label: "Two", route: "wss://two.example/v1/link"),
        ]
        model.activeID = "p1"
        await model.connect()

        let createTask = Task { await model.create(provider: "claude", cwd: "/tmp/work", name: "Claude") }
        await saveGate.waitUntilEntered()
        try await model.disconnect()
        model.activeID = "p2"
        await model.connect()
        await saveGate.succeed(())
        await createTask.value
        let createdCalls = await fake.createdCalls
        XCTAssertTrue(createdCalls.isEmpty)

        model.activeID = "p1"
        await model.connect()
        let terminateTask = Task { await model.terminate("term-1") }
        await acquireGate.waitUntilEntered()
        try await model.disconnect()
        model.activeID = "p2"
        await model.connect()
        await acquireGate.succeed(DraftRecord(pending: PendingSend(id: "term-mut-1", text: "term-1")))
        await terminateTask.value
        let closedCalls = await fake.closedCalls
        XCTAssertTrue(closedCalls.isEmpty)
    }

    func testFailedDraftFlushInSelectKeepsExistingOutputStreamValid() async throws {
        let fake = CmuxFakeBackend()
        await fake.setTerminals([
            .object(["id": .string("term-1"), "title": .string("One"), "running": .bool(true)]),
            .object(["id": .string("term-2"), "title": .string("Two"), "running": .bool(true)]),
        ])
        let deps = makeDeps(fake: fake, saveDraft: { _, key in
            if key == "cmux:p1:term-1" { throw DesktopError("Disk locked") }
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")
        XCTAssertEqual(model.selectedID, "term-1")

        await model.select("term-2")
        XCTAssertEqual(model.selectedID, "term-1")
        XCTAssertEqual(model.notice, "Disk locked")

        var delivered = false
        await fake.emit("term-1", .exited)
        try await Task.sleep(for: .milliseconds(50))
        delivered = !model.attached
        XCTAssertTrue(delivered)
    }

    func testSelectFlushesConcurrentDraftEditsUnderOriginalIdentity() async throws {
        let fake = CmuxFakeBackend()
        await fake.setTerminals([
            .object(["id": .string("term-1"), "title": .string("One"), "running": .bool(true)]),
            .object(["id": .string("term-2"), "title": .string("Two"), "running": .bool(true)]),
        ])
        let firstSaveGate = CmuxDeferred<Void>()
        actor SaveCounter {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let counter = SaveCounter()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            if await counter.next() == 1 { try await firstSaveGate.wait() }
            await fake.save(draft, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")

        model.setDraft("first edit")
        try await Task.sleep(for: .milliseconds(300))
        await firstSaveGate.waitUntilEntered()

        let selectTask = Task { await model.select("term-2") }
        await Task.yield()
        model.setDraft("latest edit for term-1")
        await firstSaveGate.succeed(())
        await selectTask.value

        XCTAssertEqual(model.selectedID, "term-2")
        let savedTerm1 = await fake.read("cmux:p1:term-1")
        XCTAssertEqual(savedTerm1.text, "latest edit for term-1")
    }

    func testClearPendingAfterReviewPreservesConcurrentDraftEdits() async throws {
        let fake = CmuxFakeBackend()
        let pending = PendingSend(id: "req-1", text: "old prompt")
        await fake.save(DraftRecord(text: "old prompt", pending: pending), key: "cmux:p1:term-1")
        let saveGate = CmuxDeferred<Void>()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            try await saveGate.wait()
            await fake.save(draft, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")

        model.clearPendingAfterReview()
        await saveGate.waitUntilEntered()
        model.setDraft("typed during clear")
        await saveGate.succeed(())
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertNil(model.draft.pending)
        XCTAssertEqual(model.draft.text, "typed during clear")
        let persisted = await fake.read("cmux:p1:term-1")
        XCTAssertNil(persisted.pending)
        XCTAssertEqual(persisted.text, "typed during clear")
    }

    func testClearCreationAfterReviewUsesMatchingClearOnly() async throws {
        let fake = CmuxFakeBackend()
        let payload = #"{"id":"orig-1","argv":["claude"],"cwd":"/tmp/a","name":"A"}"#
        await fake.save(DraftRecord(pending: PendingSend(id: "orig-1", text: payload)), key: "cmux:p1:creation")
        let clearGate = CmuxDeferred<Void>()
        let deps = makeDeps(fake: fake, clearDraftIfMatching: { id, key in
            try await clearGate.wait()
            await fake.clearIfMatching(id, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        XCTAssertTrue(model.creationPending)

        model.clearCreationAfterReview()
        await clearGate.waitUntilEntered()
        let replacementPayload = #"{"id":"newer-2","argv":["codex"],"cwd":"/tmp/b","name":"B"}"#
        await fake.save(DraftRecord(pending: PendingSend(id: "newer-2", text: replacementPayload)), key: "cmux:p1:creation")
        await clearGate.succeed(())
        try await Task.sleep(for: .milliseconds(50))

        let persisted = await fake.read("cmux:p1:creation")
        XCTAssertEqual(persisted.pending?.id, "newer-2")
        let cleared = await fake.clearLog
        XCTAssertEqual(cleared.first?.0, "orig-1")
        XCTAssertEqual(cleared.first?.1, "cmux:p1:creation")
    }

    func testRendererFailureDuringSelectFlushClearsBusyState() async throws {
        let fake = CmuxFakeBackend()
        await fake.setTerminals([
            .object(["id": .string("term-1"), "title": .string("One"), "running": .bool(true)]),
            .object(["id": .string("term-2"), "title": .string("Two"), "running": .bool(true)]),
        ])
        let flushGate = CmuxDeferred<Void>()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            if key == "cmux:p1:term-1" { try await flushGate.wait() }
            await fake.save(draft, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")

        let selectTask = Task { await model.select("term-2") }
        await flushGate.waitUntilEntered()

        model.rendererFailed("frame overflow")
        await flushGate.succeed(())
        await selectTask.value

        XCTAssertFalse(model.busy)
        XCTAssertFalse(model.attaching)
        XCTAssertFalse(model.draftEditingLocked)
        XCTAssertEqual(model.selectedID, "term-1")
    }

    func testDraftEditsAreRejectedDuringDisconnectAndSelectHandoff() async throws {
        let fake = CmuxFakeBackend()
        await fake.setTerminals([
            .object(["id": .string("term-1"), "title": .string("One"), "running": .bool(true)]),
            .object(["id": .string("term-2"), "title": .string("Two"), "running": .bool(true)]),
        ])
        let saveGate = CmuxDeferred<Void>()
        let detachGate = CmuxDeferred<Void>()
        actor GateToggle {
            var blockSave = false
            var blockDetach = false
            func setBlockSave(_ value: Bool) { blockSave = value }
            func setBlockDetach(_ value: Bool) { blockDetach = value }
        }
        let toggle = GateToggle()
        let deps = CmuxViewModelDependencies(
            helperURL: { URL(fileURLWithPath: "/nonexistent/cmux") },
            connect: { _, _, _, _, _ in },
            snapshot: { await fake.snapshot() },
            attach: { id, handler in
                await fake.setOutput(id, handler)
                handler(.snapshot(Data("ok".utf8), columns: 80, rows: 24))
            },
            detach: {
                if await toggle.blockDetach { try? await detachGate.wait() }
            },
            disconnect: {},
            paste: { _ in .queued },
            send: { _ in .queued },
            resize: { _, _ in },
            createTerminal: { _, _, _, _ in "term-created" },
            closeTerminal: { _, _ in },
            readDraft: { await fake.read($0) },
            saveDraft: { draft, key in
                if await toggle.blockSave { try await saveGate.wait() }
                await fake.save(draft, key: key)
            },
            acquireMutation: { key, text in await fake.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await fake.clearIfMatching(id, key: key) }
        )

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")
        model.setDraft("before detach")

        await toggle.setBlockDetach(true)
        let selectTask = Task { await model.select("term-2") }
        await detachGate.waitUntilEntered()

        XCTAssertTrue(model.draftEditingLocked)
        model.setDraft("dropped handoff keystroke")
        XCTAssertEqual(model.draft.text, "before detach")

        await detachGate.succeed(())
        await selectTask.value
        XCTAssertFalse(model.draftEditingLocked)
        XCTAssertEqual(model.selectedID, "term-2")
        let savedTerm1 = await fake.read("cmux:p1:term-1")
        XCTAssertEqual(savedTerm1.text, "before detach")

        await toggle.setBlockDetach(false)
        model.setDraft("before disconnect")
        await toggle.setBlockSave(true)
        let disconnectTask = Task { try await model.disconnect() }
        await saveGate.waitUntilEntered()

        XCTAssertTrue(model.draftEditingLocked)
        model.setDraft("late during disconnect")
        XCTAssertEqual(model.draft.text, "before disconnect")

        await saveGate.succeed(())
        try await disconnectTask.value
        XCTAssertFalse(model.draftEditingLocked)
        let savedTerm2 = await fake.read("cmux:p1:term-2")
        XCTAssertEqual(savedTerm2.text, "before disconnect")
    }

    func testSettlePendingSendSurfacesFollowUpSaveErrorAndSchedulesAutosaveRetry() async throws {
        let fake = CmuxFakeBackend()
        let settleSaveGate = CmuxDeferred<Void>()
        actor SaveStep {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let step = SaveStep()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            switch await step.next() {
            case 1:
                await fake.save(draft, key: key)
            case 2:
                try await settleSaveGate.wait()
                await fake.save(draft, key: key)
            case 3:
                throw DesktopError("Temporary save failure")
            default:
                await fake.save(draft, key: key)
            }
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        model.setDisplayVisible(true)
        await model.connect()
        try await Task.sleep(for: .milliseconds(50))
        model.rendererRestored(model.rendererGeneration)
        model.setInputEnabled(true)
        model.setDraft("initial prompt")

        let sendTask = Task { await model.send() }
        await settleSaveGate.waitUntilEntered()

        model.setDraft("follow-up draft text")
        await settleSaveGate.succeed(())
        await sendTask.value

        XCTAssertNil(model.draft.pending)
        XCTAssertEqual(model.draft.text, "follow-up draft text")
        XCTAssertTrue(model.inputEnabled)
        XCTAssertEqual(model.notice, "Send was queued, but your newer draft could not be saved: Temporary save failure")

        try await Task.sleep(for: .milliseconds(350))
        let persisted = await fake.read("cmux:p1:term-1")
        XCTAssertEqual(persisted.text, "follow-up draft text")
        XCTAssertNil(persisted.pending)
    }

    func testDisconnectWhilePasteIsSuspendedFencesInputAndSkipsEnter() async throws {
        let fake = CmuxFakeBackend()
        let pasteGate = CmuxDeferred<Void>()
        let flushGate = CmuxDeferred<Void>()
        actor SaveGateFlag {
            var gateFlush = false
            func enable() { gateFlush = true }
        }
        @MainActor final class ModelBox {
            var model: CmuxViewModel?
        }
        let flag = SaveGateFlag()
        let box = ModelBox()
        let deps = CmuxViewModelDependencies(
            helperURL: { URL(fileURLWithPath: "/nonexistent/cmux") },
            connect: { _, _, _, _, _ in },
            snapshot: { await fake.snapshot() },
            attach: { id, handler in
                await fake.setOutput(id, handler)
                handler(.snapshot(Data("ok".utf8), columns: 80, rows: 24))
            },
            detach: {},
            disconnect: {},
            paste: { text in
                await fake.recordPaste(text)
                try await pasteGate.wait()
                return .queued
            },
            send: { data in
                await fake.recordSend(data)
                return .queued
            },
            resize: { _, _ in },
            createTerminal: { _, _, _, _ in "term-created" },
            closeTerminal: { _, _ in },
            readDraft: { await fake.read($0) },
            saveDraft: { draft, key in
                if await flag.gateFlush {
                    await MainActor.run {
                        XCTAssertEqual(box.model?.inputFenced, true)
                        XCTAssertEqual(box.model?.disconnecting, true)
                        XCTAssertEqual(box.model?.inputEnabled, false)
                    }
                    try await flushGate.wait()
                }
                await fake.save(draft, key: key)
            },
            acquireMutation: { key, text in await fake.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await fake.clearIfMatching(id, key: key) }
        )

        let model = CmuxViewModel(deps: deps)
        box.model = model
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        model.setDisplayVisible(true)
        await model.connect()
        try await Task.sleep(for: .milliseconds(50))
        model.rendererRestored(model.rendererGeneration)
        model.setInputEnabled(true)
        model.setDraft("send during disconnect")

        let sendTask = Task { await model.send() }
        await pasteGate.waitUntilEntered()

        await flag.enable()
        let disconnectTask = Task { try await model.disconnect() }
        await flushGate.waitUntilEntered()
        XCTAssertTrue(model.inputFenced)

        await pasteGate.succeed(())
        await sendTask.value
        let sentWhileFlushing = await fake.sentBytes
        XCTAssertTrue(sentWhileFlushing.isEmpty)

        await flushGate.succeed(())
        try await disconnectTask.value

        let pasted = await fake.pastedTexts
        let sent = await fake.sentBytes
        XCTAssertEqual(pasted, ["send during disconnect"])
        XCTAssertTrue(sent.isEmpty)
    }

    func testConcurrentDisconnectCallsAwaitSameFlushAndShareOutcome() async throws {
        let fake = CmuxFakeBackend()
        let firstFlushGate = CmuxDeferred<Void>()
        let secondFlushGate = CmuxDeferred<Void>()
        actor GateSwitch {
            var attempt = 0
            func next() -> Int { attempt += 1; return attempt }
        }
        let switcher = GateSwitch()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            switch await switcher.next() {
            case 1:
                try await firstFlushGate.wait()
            case 2:
                try await secondFlushGate.wait()
            default:
                break
            }
            await fake.save(draft, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")
        model.setDraft("must flush before terminate")

        let d1 = Task { try await model.disconnect() }
        await firstFlushGate.waitUntilEntered()
        actor Flag {
            var completed = false
            func mark() { completed = true }
        }
        let d2Flag = Flag()
        let d2 = Task {
            do {
                try await model.disconnect()
                await d2Flag.mark()
                return "ok"
            } catch {
                await d2Flag.mark()
                return error.localizedDescription
            }
        }
        try await Task.sleep(for: .milliseconds(30))
        let completedEarly = await d2Flag.completed
        XCTAssertFalse(completedEarly)

        await firstFlushGate.fail(DesktopError("Disk full"))
        do {
            try await d1.value
            XCTFail("Expected first disconnect to fail")
        } catch let error as DesktopError {
            XCTAssertEqual(error.localizedDescription, "Disk full")
        }
        let d2Result = await d2.value
        XCTAssertEqual(d2Result, "Disk full")

        let d3 = Task { try await model.disconnect() }
        await secondFlushGate.waitUntilEntered()
        let d4 = Task { try await model.disconnect() }
        await secondFlushGate.succeed(())
        try await d3.value
        try await d4.value
        XCTAssertFalse(model.connected)
        let saved = await fake.read("cmux:p1:term-1")
        XCTAssertEqual(saved.text, "must flush before terminate")
    }

    func testFailedDisconnectFlushWhileSelectIsSuspendedReleasesBusyState() async throws {
        let fake = CmuxFakeBackend()
        await fake.setTerminals([
            .object(["id": .string("term-1"), "title": .string("One"), "running": .bool(true)]),
            .object(["id": .string("term-2"), "title": .string("Two"), "running": .bool(true)]),
        ])
        let flushGate = CmuxDeferred<Void>()
        let deps = makeDeps(fake: fake, saveDraft: { draft, key in
            if key == "cmux:p1:term-1" { try await flushGate.wait() }
            await fake.save(draft, key: key)
        })

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        await model.connect()
        await model.select("term-1")

        let selectTask = Task { await model.select("term-2") }
        await flushGate.waitUntilEntered()

        let disconnectTask = Task {
            do {
                try await model.disconnect()
                return ""
            } catch {
                return error.localizedDescription
            }
        }
        await Task.yield()
        await flushGate.fail(DesktopError("Flush blocked"))

        await selectTask.value
        let disconnectErr = await disconnectTask.value
        XCTAssertEqual(disconnectErr, "Flush blocked")
        XCTAssertFalse(model.busy)
        XCTAssertFalse(model.attaching)
        XCTAssertFalse(model.draftEditingLocked)
        XCTAssertFalse(model.inputFenced)
    }

    func testStaleRawDrainerErrorNeverClearsNewerGenerationKeysOrInput() async throws {
        let fake = CmuxFakeBackend()
        let firstRawGate = CmuxDeferred<Void>()
        actor RawStep {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let step = RawStep()
        let deps = CmuxViewModelDependencies(
            helperURL: { URL(fileURLWithPath: "/nonexistent/cmux") },
            connect: { _, _, _, _, _ in },
            snapshot: { await fake.snapshot() },
            attach: { id, handler in
                await fake.setOutput(id, handler)
                handler(.snapshot(Data("ok".utf8), columns: 80, rows: 24))
            },
            detach: {},
            disconnect: {},
            paste: { _ in .queued },
            send: { data in
                if await step.next() == 1 {
                    try await firstRawGate.wait()
                }
                await fake.recordSend(data)
                return .queued
            },
            resize: { _, _ in },
            createTerminal: { _, _, _, _ in "term-created" },
            closeTerminal: { _, _ in },
            readDraft: { await fake.read($0) },
            saveDraft: { draft, key in await fake.save(draft, key: key) },
            acquireMutation: { key, text in await fake.acquireMutation(key, text: text) },
            clearDraftIfMatching: { id, key in await fake.clearIfMatching(id, key: key) }
        )

        let model = CmuxViewModel(deps: deps)
        model.profiles = [CmuxHostProfile(id: "p1", label: "Host", route: "wss://cmux.example/v1/link")]
        model.activeID = "p1"
        model.setDisplayVisible(true)
        await model.connect()
        try await Task.sleep(for: .milliseconds(50))
        model.rendererRestored(model.rendererGeneration)
        model.setInputEnabled(true)
        model.directInput = true

        model.raw("old")
        await firstRawGate.waitUntilEntered()

        model.setInputEnabled(false)
        model.setInputEnabled(true)
        model.directInput = true
        model.raw("new")
        try await Task.sleep(for: .milliseconds(30))

        await firstRawGate.fail(DesktopError("Stale stream write failed"))
        try await Task.sleep(for: .milliseconds(30))

        XCTAssertTrue(model.inputEnabled)
        XCTAssertTrue(model.directInput)
        let sent = await fake.sentBytes
        XCTAssertEqual(sent, [Data("new".utf8)])
    }
}
