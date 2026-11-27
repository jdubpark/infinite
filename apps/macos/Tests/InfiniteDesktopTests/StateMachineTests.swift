import XCTest
import InfiniteCore
@testable import InfiniteDesktop

private actor StateMachineDeferred<Value: Sendable> {
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

private actor ControlCallTracker {
    var releasedIDs: [String] = []
    private var releaseWaiters: [(id: UUID, target: Int, continuation: CheckedContinuation<Bool, Never>)] = []

    func recordRelease(_ id: String) {
        releasedIDs.append(id)
        var remaining: [(id: UUID, target: Int, continuation: CheckedContinuation<Bool, Never>)] = []
        for waiter in releaseWaiters {
            if releasedIDs.count >= waiter.target {
                waiter.continuation.resume(returning: true)
            } else {
                remaining.append(waiter)
            }
        }
        releaseWaiters = remaining
    }

    private func expireWaiter(_ id: UUID) {
        if let idx = releaseWaiters.firstIndex(where: { $0.id == id }) {
            let waiter = releaseWaiters.remove(at: idx)
            waiter.continuation.resume(returning: releasedIDs.count >= waiter.target)
        }
    }

    func waitForReleaseCount(_ target: Int, timeout: Duration = .seconds(2)) async -> Bool {
        if releasedIDs.count >= target { return true }
        let waiterID = UUID()
        let timeoutTask = Task {
            try? await Task.sleep(for: timeout)
            self.expireWaiter(waiterID)
        }
        let satisfied = await withCheckedContinuation { continuation in
            if releasedIDs.count >= target {
                continuation.resume(returning: true)
            } else {
                releaseWaiters.append((id: waiterID, target: target, continuation: continuation))
            }
        }
        timeoutTask.cancel()
        return satisfied
    }
}

@MainActor final class StateMachineTests: XCTestCase {
    private func makeClient() -> RemoteClient {
        RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token")
    }

    func testAppModelRouteIsMutuallyExclusiveAndPreservesProjectFilter() {
        let app = AppModel()
        XCTAssertEqual(app.route, .home)
        XCTAssertTrue(app.showingHome)
        XCTAssertFalse(app.showingCost || app.showingUnderstanding)

        app.showHome(project: "proj-1")
        XCTAssertEqual(app.route, .home)
        XCTAssertEqual(app.projectFilter, "proj-1")

        app.openTeam("team-1", from: "mission-1")
        XCTAssertEqual(app.route, .team(id: "team-1", fromMission: "mission-1"))
        XCTAssertEqual(app.selectedTeamID, "team-1")
        XCTAssertEqual(app.teamOpenedFrom, "mission-1")
        XCTAssertFalse(app.showingHome)
        XCTAssertNil(app.selectedMissionID)

        app.openMission("mission-2")
        XCTAssertEqual(app.route, .mission("mission-2"))
        XCTAssertEqual(app.selectedMissionID, "mission-2")
        XCTAssertNil(app.selectedTeamID)
        XCTAssertNil(app.teamOpenedFrom)

        app.showCost()
        XCTAssertEqual(app.route, .cost)
        XCTAssertTrue(app.showingCost)
        XCTAssertNil(app.selectedMissionID)

        app.showUnderstanding()
        XCTAssertEqual(app.route, .understanding)
        XCTAssertTrue(app.showingUnderstanding)
        XCTAssertFalse(app.showingCost)

        app.openSession("session-1")
        XCTAssertEqual(app.route, .sessions)
        XCTAssertEqual(app.selectedID, "session-1")
        XCTAssertFalse(app.showingUnderstanding)

        app.showHome(project: app.projectFilter)
        XCTAssertEqual(app.route, .home)
        XCTAssertEqual(app.projectFilter, "proj-1")
    }

    func testHostConnectionStateEnforcesConnectedConnectingMutualExclusion() {
        let disconnected = HostConnectionState.disconnected()
        XCTAssertFalse(disconnected.isConnected)
        XCTAssertFalse(disconnected.isConnecting)
        XCTAssertEqual(disconnected.error, "")

        let connecting = HostConnectionState.connecting(profileID: "p1")
        XCTAssertFalse(connecting.isConnected)
        XCTAssertTrue(connecting.isConnecting)
        XCTAssertEqual(connecting.connectingProfileID, "p1")

        let connected = HostConnectionState.connected
        XCTAssertTrue(connected.isConnected)
        XCTAssertFalse(connected.isConnecting)
        XCTAssertNil(connected.connectingProfileID)

        let offline = HostConnectionState.offline(error: "Timed out")
        XCTAssertFalse(offline.isConnected)
        XCTAssertFalse(offline.isConnecting)
        XCTAssertEqual(offline.error, "Timed out")
    }

    func testSessionModelRendererStateRequiresSnapshotBeforeRestored() {
        let session = AgentSession(value: .object(["id": .string("s1"), "status": .string("running")]))
        let model = SessionModel(session: session, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true)
        let initialGen = model.rendererGeneration
        XCTAssertEqual(model.rendererState, .awaitingSnapshot(generation: initialGen))
        XCTAssertFalse(model.screenReady)

        model.rendererRestored(initialGen)
        XCTAssertEqual(model.rendererState, .awaitingSnapshot(generation: initialGen))

        model.receive(.object(["message": .object(["snapshot": .object(["ansi": .string("hi"), "cols": .number(80), "rows": .number(24)])])]))
        XCTAssertEqual(model.rendererState, .snapshotReceived(generation: initialGen))
        XCTAssertTrue(model.rendererState.snapshotReady)
        XCTAssertFalse(model.rendererState.isReady)

        model.rendererRestored(UUID())
        XCTAssertEqual(model.rendererState, .snapshotReceived(generation: initialGen))

        model.rendererRestored(initialGen)
        XCTAssertEqual(model.rendererState, .ready(generation: initialGen))
        XCTAssertTrue(model.rendererState.isReady)

        model.rendererFailed("Crashed")
        XCTAssertEqual(model.rendererState, .failed(generation: initialGen, receivedScreen: true))
        XCTAssertFalse(model.rendererState.snapshotReady)
        XCTAssertFalse(model.rendererState.isReady)
        XCTAssertFalse(model.directInput)
    }

    func testSessionModelRendererFailedPreservesReceivedScreenForSubsequentOutputChunks() {
        let session = AgentSession(value: .object(["id": .string("s1"), "status": .string("running")]))
        let model = SessionModel(session: session, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true)
        var feeds: [(Data, Bool)] = []
        model.pipe.receive = { data, reset, _, _ in feeds.append((data, reset)) }

        model.receive(.object(["message": .object(["snapshot": .object(["ansi": .string("hi"), "cols": .number(80), "rows": .number(24)])])]))
        model.rendererFailed("Crashed")
        model.receive(.object(["message": .object(["events": .array([.object(["type": .string("output"), "data": .object(["text": .string("chunk-1")])])])])]))
        model.receive(.object(["message": .object(["events": .array([.object(["type": .string("output"), "data": .object(["text": .string("chunk-2")])])])])]))

        XCTAssertEqual(model.rendererState, .failed(generation: model.rendererGeneration, receivedScreen: true))
        XCTAssertEqual(feeds.map(\.0), [Data("hi".utf8), Data("chunk-1".utf8), Data("chunk-2".utf8)])
        XCTAssertEqual(feeds.map(\.1), [true, false, false])
        XCTAssertTrue(model.pipe.replay())
        XCTAssertEqual(feeds.last?.0, Data("hichunk-1chunk-2".utf8))
        XCTAssertEqual(feeds.last?.1, true)
    }

    func testCmuxConnectionPhaseAndCreationStateInvariants() {
        let generation = UUID()
        let connecting = CmuxConnectionPhase.connecting(generation: generation, statusText: "Connecting")
        XCTAssertTrue(connecting.isConnecting)
        XCTAssertFalse(connecting.hasConnected)
        XCTAssertFalse(connecting.isConnected)

        let unreachable = CmuxConnectionPhase.connected(generation: generation, statusText: "Noise", reachable: false)
        XCTAssertTrue(unreachable.hasConnected)
        XCTAssertFalse(unreachable.isConnected)

        let pending = CmuxPendingCreation(id: "m1", argv: ["claude"], cwd: "/tmp", name: "Claude")
        let clearing = CmuxCreationState.clearing(previous: pending)
        XCTAssertTrue(clearing.isVisiblePending)
        XCTAssertNil(clearing.pending)

        let cmux = CmuxViewModel()
        cmux.rendererRestored(cmux.rendererGeneration)
        XCTAssertFalse(cmux.snapshotReady)
        XCTAssertEqual(cmux.operation, .idle)
        XCTAssertEqual(cmux.connectionPhase, .disconnected)
    }

    func testSessionModelClaimingIsFencedByReleaseAndDetach() async {
        let running = AgentSession(value: .object([
            "id": .string("s-claim"),
            "status": .string("running"),
            "control": .object(["label": .string("Alice")])
        ]))
        let futureExpiry = Date().addingTimeInterval(600).timeIntervalSince1970 * 1000
        let grantResponse = JSON.object([
            "control": .object([
                "id": .string("stale-lease"),
                "label": .string("You"),
                "expiresAt": .number(futureExpiry)
            ])
        ])

        let claimGate1 = StateMachineDeferred<JSON>()
        let tracker1 = ControlCallTracker()
        let deps1 = SessionModelDependencies(
            readDraft: { _ in DraftRecord() },
            saveDraft: { _, _ in },
            acquireMutation: { _, _ in DraftRecord() },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, path, body, _ in
                if path.hasSuffix("/control"), body?["action"].string == "claim" {
                    return try await claimGate1.wait()
                }
                if path.hasSuffix("/control"), body?["action"].string == "release" {
                    await tracker1.recordRelease(body?["leaseId"].string ?? "")
                }
                return .object([:])
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let releasedModel = SessionModel(session: running, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true, deps: deps1)
        releasedModel.observe(running.value)
        releasedModel.streamState = .attached(streamID: "stream-1", generation: UUID())
        let claimForRelease = Task { @MainActor in await releasedModel.claim() }
        await claimGate1.waitUntilEntered()
        guard case .claiming(let gen1, let initialHolder) = releasedModel.controlState else {
            return XCTFail("Expected .claiming during in-flight claim")
        }
        XCTAssertEqual(initialHolder, "Alice")
        XCTAssertEqual(releasedModel.otherHolder, "Alice")
        XCTAssertFalse(releasedModel.hasControl)

        releasedModel.observe(.object([
            "id": .string("s-claim"),
            "status": .string("running"),
            "control": .object(["label": .string("Bob")])
        ]))
        guard case .claiming(gen1, let updatedHolder) = releasedModel.controlState else {
            return XCTFail("Expected .claiming to preserve generation across observe")
        }
        XCTAssertEqual(updatedHolder, "Bob")

        await releasedModel.release()
        guard case .unheld(let cleared) = releasedModel.controlState else {
            return XCTFail("Expected release() to fence .claiming back to .unheld")
        }
        XCTAssertEqual(cleared, "")
        XCTAssertNil(releasedModel.otherHolder)
        await claimGate1.succeed(grantResponse)
        await claimForRelease.value
        let released1 = await tracker1.waitForReleaseCount(1)
        XCTAssertTrue(released1, "Expected superseded lease to be released within timeout")
        let releasedOnRelease = await tracker1.releasedIDs
        XCTAssertEqual(releasedOnRelease, ["stale-lease"])
        guard case .unheld(let postClaim) = releasedModel.controlState else {
            return XCTFail("Expected fenced claim not to re-enter .claiming or .held")
        }
        XCTAssertEqual(postClaim, "")

        let claimGate2 = StateMachineDeferred<JSON>()
        let tracker2 = ControlCallTracker()
        let deps2 = SessionModelDependencies(
            readDraft: { _ in DraftRecord() },
            saveDraft: { _, _ in },
            acquireMutation: { _, _ in DraftRecord() },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, path, body, _ in
                if path.hasSuffix("/control"), body?["action"].string == "claim" {
                    return try await claimGate2.wait()
                }
                if path.hasSuffix("/control"), body?["action"].string == "release" {
                    await tracker2.recordRelease(body?["leaseId"].string ?? "")
                }
                return .object([:])
            },
            openTerminal: { _, _, _ in "stream-2" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let detachedModel = SessionModel(session: running, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true, deps: deps2)
        detachedModel.observe(running.value)
        detachedModel.streamState = .attached(streamID: "stream-2", generation: UUID())
        let claimForDetach = Task { @MainActor in await detachedModel.claim() }
        await claimGate2.waitUntilEntered()
        guard case .claiming = detachedModel.controlState else {
            return XCTFail("Expected .claiming before detach()")
        }
        await detachedModel.detach()
        XCTAssertEqual(detachedModel.streamState, .detached)
        guard case .unheld(let afterDetach) = detachedModel.controlState else {
            return XCTFail("Expected detach() to fence .claiming back to .unheld")
        }
        XCTAssertEqual(afterDetach, "Alice")
        await claimGate2.succeed(grantResponse)
        await claimForDetach.value
        let released2 = await tracker2.waitForReleaseCount(1)
        XCTAssertTrue(released2, "Expected detached superseded lease to be released within timeout")
        let releasedOnDetach = await tracker2.releasedIDs
        XCTAssertEqual(releasedOnDetach, ["stale-lease"])
        guard case .unheld = detachedModel.controlState else {
            return XCTFail("Expected fenced claim after detach() to remain .unheld")
        }
    }

    func testSupersededControlClaimErrorDoesNotOverwriteNewerSuccess() async {
        let running = AgentSession(value: .object(["id": .string("s-claim"), "status": .string("running")]))
        let futureExpiry = Date().addingTimeInterval(600).timeIntervalSince1970 * 1000
        let firstClaimGate = StateMachineDeferred<JSON>()
        let secondClaimGate = StateMachineDeferred<JSON>()
        actor ClaimStep {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let step = ClaimStep()
        let deps = SessionModelDependencies(
            readDraft: { _ in DraftRecord() },
            saveDraft: { _, _ in },
            acquireMutation: { _, _ in DraftRecord() },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, path, body, _ in
                if path.hasSuffix("/control"), body?["action"].string == "claim" {
                    if await step.next() == 1 { return try await firstClaimGate.wait() }
                    return try await secondClaimGate.wait()
                }
                return .object([:])
            },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )

        let model = SessionModel(session: running, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true, deps: deps)
        model.streamState = .attached(streamID: "stream-1", generation: UUID())

        let firstClaim = Task { @MainActor in await model.claim() }
        await firstClaimGate.waitUntilEntered()

        let secondClaim = Task { @MainActor in await model.claim() }
        await secondClaimGate.waitUntilEntered()
        await secondClaimGate.succeed(.object([
            "control": .object([
                "id": .string("lease-2"),
                "label": .string("You"),
                "expiresAt": .number(futureExpiry)
            ])
        ]))
        await secondClaim.value
        XCTAssertTrue(model.hasControl)
        XCTAssertEqual(model.lease["id"].string, "lease-2")
        XCTAssertEqual(model.notice, "")

        await firstClaimGate.fail(DesktopError("Stale claim failed"))
        await firstClaim.value

        XCTAssertTrue(model.hasControl)
        XCTAssertEqual(model.lease["id"].string, "lease-2")
        XCTAssertEqual(model.notice, "")
    }

    func testCmuxDisconnectFromDisconnectedRemainsDisconnected() async throws {
        let cmux = CmuxViewModel()
        XCTAssertEqual(cmux.connectionPhase, .disconnected)
        XCTAssertEqual(cmux.operation, .idle)
        await cmux.select("t1")
        XCTAssertEqual(cmux.operation, .idle)
        try await cmux.disconnect()
        XCTAssertEqual(cmux.connectionPhase, .disconnected)
        XCTAssertEqual(cmux.operation, .idle)
    }

    func testMutationStateInvariantsAcrossMissionAndTeamModels() {
        let mutation = TeamMutation(requestID: "r1", path: "/missions/m1/pause", body: .object([:]), label: "Pause")
        XCTAssertFalse(MutationState.idle.isSending)
        XCTAssertNil(MutationState.idle.pending)
        XCTAssertTrue(MutationState.sending(pending: nil).isSending)
        XCTAssertEqual(MutationState.sending(pending: mutation).pending, mutation)
        XCTAssertFalse(MutationState.unconfirmed(mutation).isSending)
        XCTAssertEqual(MutationState.unconfirmed(mutation).pending, mutation)

        let teamModel = TeamModel(run: TeamRun(.object(["id": .string("t1"), "revision": .number(1)])), client: makeClient(), role: "owner")
        XCTAssertEqual(teamModel.mutationState, .idle)
        teamModel.discardPending()
        XCTAssertEqual(teamModel.notice, "")

        let missionModel = MissionModel(mission: Mission(.object(["id": .string("m1"), "revision": .number(1)])), client: makeClient(), role: "owner")
        XCTAssertEqual(missionModel.mutationState, .idle)
        missionModel.discardPending()
        XCTAssertEqual(missionModel.notice, "")
    }

    func testMissionAndTeamModelsStayBusyThroughRefusalRefreshAndSurfacePollErrors() async {
        let missionPollGate = StateMachineDeferred<JSON>()
        actor MissionPollSwitch {
            var getCount = 0
            func next() -> Int { getCount += 1; return getCount }
        }
        let missionSwitch = MissionPollSwitch()
        let missionModel = MissionModel(
            mission: Mission(.object(["id": .string("m1"), "revision": .number(1)])),
            client: makeClient(),
            role: "owner",
            sendRequest: { _, path, body in
                if body != nil { throw DesktopError("Revision mismatch", status: 409) }
                if path == "/missions/m1" {
                    switch await missionSwitch.next() {
                    case 1: return .object(["id": .string("m1"), "revision": .number(1)])
                    case 2: return try await missionPollGate.wait()
                    default: throw DesktopError("Poll failed")
                    }
                }
                return .object([:])
            }
        )
        missionModel.setDisplayVisible(true)
        await missionModel.poll()
        XCTAssertTrue(missionModel.canSteer)

        missionModel.direction = "Next instruction"
        let missionSteer1 = Task { @MainActor in await missionModel.steer() }
        await missionPollGate.waitUntilEntered()
        XCTAssertTrue(missionModel.busy)
        XCTAssertTrue(missionModel.mutationState.isSending)
        XCTAssertFalse(missionModel.canAct)
        XCTAssertFalse(missionModel.canSteer)

        await missionPollGate.succeed(.object(["id": .string("m1"), "revision": .number(2)]))
        await missionSteer1.value
        XCTAssertFalse(missionModel.busy)
        XCTAssertEqual(missionModel.mutationState, .idle)
        XCTAssertEqual(missionModel.mission?.revision, 2)
        XCTAssertEqual(missionModel.notice, "Revision mismatch The mission was refreshed; review it before sending again.")

        await missionModel.steer()
        XCTAssertFalse(missionModel.busy)
        XCTAssertFalse(missionModel.fresh)
        XCTAssertEqual(missionModel.notice, "Revision mismatch Could not refresh the mission: Poll failed")

        let teamPollGate = StateMachineDeferred<JSON>()
        actor TeamPollSwitch {
            var getCount = 0
            func next() -> Int { getCount += 1; return getCount }
        }
        let teamSwitch = TeamPollSwitch()
        let teamModel = TeamModel(
            run: TeamRun(.object(["id": .string("t1"), "revision": .number(1)])),
            client: makeClient(),
            role: "owner",
            sendRequest: { _, path, body in
                if body != nil { throw DesktopError("Revision mismatch", status: 409) }
                if path == "/teams/t1" {
                    switch await teamSwitch.next() {
                    case 1: return .object(["id": .string("t1"), "revision": .number(1)])
                    case 2: return try await teamPollGate.wait()
                    default: throw DesktopError("Poll failed")
                    }
                }
                return .object([:])
            }
        )
        teamModel.setDisplayVisible(true)
        await teamModel.poll()
        XCTAssertTrue(teamModel.canSteer)

        teamModel.direction = "Next instruction"
        let teamSteer1 = Task { @MainActor in await teamModel.steer() }
        await teamPollGate.waitUntilEntered()
        XCTAssertTrue(teamModel.busy)
        XCTAssertTrue(teamModel.mutationState.isSending)
        XCTAssertFalse(teamModel.canSteer)
        XCTAssertFalse(teamModel.canOwn)

        await teamPollGate.succeed(.object(["id": .string("t1"), "revision": .number(2)]))
        await teamSteer1.value
        XCTAssertFalse(teamModel.busy)
        XCTAssertEqual(teamModel.mutationState, .idle)
        XCTAssertEqual(teamModel.run?.revision, 2)
        XCTAssertEqual(teamModel.notice, "Revision mismatch The team was refreshed; review it before sending again.")

        await teamModel.steer()
        XCTAssertFalse(teamModel.busy)
        XCTAssertFalse(teamModel.fresh)
        XCTAssertEqual(teamModel.notice, "Revision mismatch Could not refresh the team: Poll failed")
    }

    func testMissionModelPreFetchLoadingStateGatesMutationsHandlesErrorsAndTransitionsToLoaded() async {
        let boardItem = BoardItem(.object([
            "kind": .string("mission"),
            "id": .string("m-seed"),
            "title": .string("Checkout limits"),
            "groupId": .string("storefront"),
            "projectName": .string("Storefront"),
            "column": .string("needs-input"),
            "status": .string("needs-input"),
            "subtasks": .object(["total": .number(4), "running": .number(1), "done": .number(2)])
        ]))
        let seed = MissionSeed(id: "m-seed", row: boardItem)
        actor MissionPollRecorder {
            var calls: [(String, Bool)] = []
            var pollAttempt = 0
            func record(_ path: String, hasBody: Bool) -> Int {
                calls.append((path, hasBody))
                if !hasBody { pollAttempt += 1 }
                return pollAttempt
            }
        }
        let recorder = MissionPollRecorder()
        let loadedPayload: JSON = .object([
            "id": .string("m-seed"),
            "groupId": .string("storefront"),
            "groupName": .string("Storefront"),
            "title": .string("Checkout limits"),
            "objective": .string("Add checkout limits across services."),
            "revision": .number(3),
            "status": .string("working"),
            "updatedAt": .string("2026-01-01T00:05:00.000Z")
        ])

        let model = MissionModel(
            seed: seed,
            client: makeClient(),
            role: "owner",
            sendRequest: { _, path, body in
                let attempt = await recorder.record(path, hasBody: body != nil)
                if body != nil { return .object([:]) }
                switch attempt {
                case 1: throw DesktopError("Host unreachable")
                case 2: return .object(["id": .string("other-mission"), "revision": .number(1)])
                default: return loadedPayload
                }
            }
        )

        XCTAssertEqual(model.loadState, .loading(seed: seed, error: nil))
        XCTAssertNil(model.mission)
        XCTAssertFalse(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertEqual(model.id, "m-seed")
        XCTAssertEqual(model.title, "Checkout limits")
        XCTAssertEqual(model.status, "needs-input")
        XCTAssertEqual(model.statusLabel, "Needs your input")
        XCTAssertEqual(model.groupID, "storefront")
        XCTAssertEqual(model.groupName, "Storefront")
        XCTAssertEqual(seed.progressFraction, 0.5)
        XCTAssertFalse(model.canAct)
        XCTAssertFalse(model.canSteer)

        model.direction = "Should not send before load"
        await model.steer()
        await model.answer(decisionID: "d1", revision: 1, text: "Yes")
        await model.perform("pause")
        let callsBeforePoll = await recorder.calls
        XCTAssertTrue(callsBeforePoll.isEmpty)

        model.setDisplayVisible(true)
        await model.poll()
        XCTAssertEqual(model.loadState, .loading(seed: seed, error: "Host unreachable"))
        XCTAssertNil(model.mission)
        XCTAssertEqual(model.loadError, "Host unreachable")
        XCTAssertFalse(model.fresh)
        XCTAssertFalse(model.canAct)

        await model.poll()
        XCTAssertNil(model.mission)
        XCTAssertEqual(model.loadError, "The server returned a mismatched mission.")
        XCTAssertFalse(model.fresh)

        await model.poll()
        XCTAssertEqual(model.loadState, .loaded(Mission(loadedPayload)))
        XCTAssertEqual(model.mission?.objective, "Add checkout limits across services.")
        XCTAssertEqual(model.mission?.revision, 3)
        XCTAssertTrue(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertTrue(model.fresh)
        XCTAssertTrue(model.canAct)
        XCTAssertTrue(model.canSteer)
    }

    func testAppModelCreatesExplicitLoadingModelsWithoutSyntheticPayloads() async {
        let profile = HostProfile(id: "p1", label: "Host", origin: "https://host.example.com")
        let deps = AppModelDependencies(
            loadProfiles: { ([profile], profile.id) },
            saveProfiles: { _, _ in },
            readToken: { _ in "token" },
            fetchIdentity: { _ in .object(["role": .string("owner")]) },
            readDraft: { _ in DraftRecord() },
            saveDraft: { _, _ in },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, _, _ in .object([:]) },
            closeClient: { _ in }
        )
        let app = AppModel(deps: deps)
        await app.connect()

        app.openMission("m-new")
        let missionModel = app.missionModel(for: "m-new")
        XCTAssertNotNil(missionModel)
        XCTAssertEqual(missionModel?.loadState, .loading(seed: MissionSeed(id: "m-new"), error: nil))
        XCTAssertNil(missionModel?.mission)
        XCTAssertFalse(missionModel?.isLoaded ?? true)

        let loadedMission = Mission(.object([
            "id": .string("m-new"),
            "title": .string("Platform rollout"),
            "status": .string("working"),
            "revision": .number(2),
            "subtasks": .array([
                .object([
                    "id": .string("sub-1"),
                    "repoProjectId": .string("api-repo"),
                    "title": .string("API rollout"),
                    "status": .string("running"),
                    "teamId": .string("team-sub-1"),
                    "teamStatus": .string("verifying")
                ])
            ])
        ]))
        missionModel?.observe(loadedMission)
        XCTAssertEqual(missionModel?.direction, "")
        XCTAssertNil(missionModel?.pending)
        XCTAssertEqual(missionModel?.busy, false)

        app.openTeam("team-sub-1", from: "m-new")
        XCTAssertNil(app.missionModels["m-new"])
        XCTAssertEqual(app.route, .team(id: "team-sub-1", fromMission: "m-new"))

        let subteamModel = app.teamModel(for: "team-sub-1")
        XCTAssertNotNil(subteamModel)
        XCTAssertEqual(
            subteamModel?.loadState,
            .loading(
                seed: TeamSeed(
                    id: "team-sub-1",
                    title: "API rollout",
                    status: "verifying",
                    projectID: "api-repo",
                    missionID: "m-new"
                ),
                error: nil
            )
        )
        XCTAssertNil(subteamModel?.run)
        XCTAssertEqual(subteamModel?.managed, true)
        XCTAssertEqual(subteamModel?.projectID, "api-repo")
        XCTAssertEqual(subteamModel?.title, "API rollout")
        XCTAssertEqual(subteamModel?.status, "verifying")

        let unknownTeam = app.teamModel(for: "team-unlisted")
        XCTAssertEqual(unknownTeam?.loadState, .loading(seed: TeamSeed(id: "team-unlisted"), error: nil))
        XCTAssertNil(unknownTeam?.run)

        let listedRun = TeamRun(.object([
            "id": .string("team-listed"),
            "title": .string("Listed team"),
            "status": .string("implementing"),
            "revision": .number(4)
        ]))
        app.teams = [listedRun]
        let listedModel = app.teamModel(for: "team-listed")
        XCTAssertEqual(listedModel?.loadState, .listSeed(listedRun, error: nil))
        XCTAssertEqual(listedModel?.run, listedRun)
        XCTAssertEqual(listedModel?.isLoaded, false)
    }

    func testLateFailingPollNeverClobbersNewerSuccessfulRetryInMissionAndTeamModels() async {
        let missionStaleGate = StateMachineDeferred<JSON>()
        actor PollCounter {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let missionCounter = PollCounter()
        let loadedMissionPayload: JSON = .object([
            "id": .string("m-race"),
            "title": .string("Race mission"),
            "status": .string("working"),
            "revision": .number(2),
            "updatedAt": .string("2026-01-01T00:02:00.000Z")
        ])
        let missionModel = MissionModel(
            seed: MissionSeed(id: "m-race", title: "Race mission", status: "working"),
            client: makeClient(),
            role: "owner",
            sendRequest: { _, path, _ in
                if path == "/missions/m-race", await missionCounter.next() == 1 {
                    return try await missionStaleGate.wait()
                }
                return loadedMissionPayload
            }
        )
        missionModel.setDisplayVisible(true)
        let staleMissionPoll = Task { @MainActor in await missionModel.poll() }
        await missionStaleGate.waitUntilEntered()

        await missionModel.retryLoad()
        XCTAssertTrue(missionModel.isLoaded)
        XCTAssertTrue(missionModel.fresh)
        XCTAssertTrue(missionModel.canSteer)
        XCTAssertNil(missionModel.loadError)
        XCTAssertFalse(missionModel.isRetrying)

        await missionStaleGate.fail(DesktopError("Stale mission poll failed"))
        await staleMissionPoll.value
        XCTAssertTrue(missionModel.isLoaded)
        XCTAssertTrue(missionModel.fresh)
        XCTAssertTrue(missionModel.canSteer)
        XCTAssertNil(missionModel.loadError)

        let teamStaleGate = StateMachineDeferred<JSON>()
        let teamCounter = PollCounter()
        let loadedTeamPayload: JSON = .object([
            "id": .string("t-race"),
            "title": .string("Race team"),
            "status": .string("implementing"),
            "revision": .number(3),
            "updatedAt": .string("2026-01-01T00:03:00.000Z")
        ])
        let teamModel = TeamModel(
            seed: TeamSeed(id: "t-race", title: "Race team", status: "implementing"),
            client: makeClient(),
            role: "owner",
            sendRequest: { _, path, _ in
                if path == "/teams/t-race", await teamCounter.next() == 1 {
                    return try await teamStaleGate.wait()
                }
                return loadedTeamPayload
            }
        )
        teamModel.setDisplayVisible(true)
        let staleTeamPoll = Task { @MainActor in await teamModel.poll() }
        await teamStaleGate.waitUntilEntered()

        await teamModel.retryLoad()
        XCTAssertTrue(teamModel.isLoaded)
        XCTAssertTrue(teamModel.fresh)
        XCTAssertTrue(teamModel.canSteer)
        XCTAssertNil(teamModel.loadError)
        XCTAssertFalse(teamModel.displayStale)
        XCTAssertFalse(teamModel.isRetrying)

        await teamStaleGate.fail(DesktopError("Stale team poll failed"))
        await staleTeamPoll.value
        XCTAssertTrue(teamModel.isLoaded)
        XCTAssertTrue(teamModel.fresh)
        XCTAssertTrue(teamModel.canSteer)
        XCTAssertNil(teamModel.loadError)
        XCTAssertFalse(teamModel.displayStale)
    }

    func testConcurrentManualRetriesCoalesceToSingleRequestInMissionAndTeamModels() async {
        actor RequestCounter {
            var count = 0
            func record() { count += 1 }
        }

        let missionGate = StateMachineDeferred<JSON>()
        let missionCounter = RequestCounter()
        let missionPayload: JSON = .object([
            "id": .string("m-retry"),
            "title": .string("Retry mission"),
            "status": .string("working"),
            "revision": .number(1),
            "updatedAt": .string("2026-01-01T00:01:00.000Z")
        ])
        let missionModel = MissionModel(
            seed: MissionSeed(id: "m-retry"),
            client: makeClient(),
            role: "owner",
            sendRequest: { _, _, _ in
                await missionCounter.record()
                return try await missionGate.wait()
            }
        )
        missionModel.setDisplayVisible(true)
        let missionRetry1 = Task { @MainActor in await missionModel.retryLoad() }
        await missionGate.waitUntilEntered()
        XCTAssertTrue(missionModel.isRetrying)

        let missionRetry2 = Task { @MainActor in await missionModel.retryLoad() }
        await Task.yield()
        XCTAssertTrue(missionModel.isRetrying)

        await missionGate.succeed(missionPayload)
        await missionRetry1.value
        await missionRetry2.value

        let missionRequestCount = await missionCounter.count
        XCTAssertEqual(missionRequestCount, 1)
        XCTAssertFalse(missionModel.isRetrying)
        XCTAssertTrue(missionModel.isLoaded)
        XCTAssertTrue(missionModel.fresh)

        let teamGate = StateMachineDeferred<JSON>()
        let teamCounter = RequestCounter()
        let teamPayload: JSON = .object([
            "id": .string("t-retry"),
            "title": .string("Retry team"),
            "status": .string("implementing"),
            "revision": .number(1),
            "updatedAt": .string("2026-01-01T00:01:00.000Z")
        ])
        let teamModel = TeamModel(
            seed: TeamSeed(id: "t-retry"),
            client: makeClient(),
            role: "owner",
            sendRequest: { _, _, _ in
                await teamCounter.record()
                return try await teamGate.wait()
            }
        )
        teamModel.setDisplayVisible(true)
        let teamRetry1 = Task { @MainActor in await teamModel.retryLoad() }
        await teamGate.waitUntilEntered()
        XCTAssertTrue(teamModel.isRetrying)

        let teamRetry2 = Task { @MainActor in await teamModel.retryLoad() }
        await Task.yield()
        XCTAssertTrue(teamModel.isRetrying)

        await teamGate.succeed(teamPayload)
        await teamRetry1.value
        await teamRetry2.value

        let teamRequestCount = await teamCounter.count
        XCTAssertEqual(teamRequestCount, 1)
        XCTAssertFalse(teamModel.isRetrying)
        XCTAssertTrue(teamModel.isLoaded)
        XCTAssertTrue(teamModel.fresh)
    }
}
