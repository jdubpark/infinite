import XCTest
import InfiniteCore
@testable import InfiniteDesktop

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
        XCTAssertEqual(model.rendererState, .failed(generation: initialGen))
        XCTAssertFalse(model.rendererState.snapshotReady)
        XCTAssertFalse(model.rendererState.isReady)
        XCTAssertFalse(model.directInput)
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

        let releasedModel = SessionModel(session: running, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true)
        releasedModel.observe(running.value)
        releasedModel.streamState = .attached(streamID: "stream-1", generation: UUID())
        let claimForRelease = Task { @MainActor in await releasedModel.claim() }
        await Task.yield()
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
        await claimForRelease.value
        guard case .unheld(let postClaim) = releasedModel.controlState else {
            return XCTFail("Expected fenced claim not to re-enter .claiming or .held")
        }
        XCTAssertEqual(postClaim, "")

        let detachedModel = SessionModel(session: running, client: makeClient(), profileID: "p1", role: "owner", supportsStream: true)
        detachedModel.observe(running.value)
        detachedModel.streamState = .attached(streamID: "stream-2", generation: UUID())
        let claimForDetach = Task { @MainActor in await detachedModel.claim() }
        await Task.yield()
        guard case .claiming = detachedModel.controlState else {
            return XCTFail("Expected .claiming before detach()")
        }
        await detachedModel.detach()
        XCTAssertEqual(detachedModel.streamState, .detached)
        guard case .unheld(let afterDetach) = detachedModel.controlState else {
            return XCTFail("Expected detach() to fence .claiming back to .unheld")
        }
        XCTAssertEqual(afterDetach, "Alice")
        await claimForDetach.value
        guard case .unheld = detachedModel.controlState else {
            return XCTFail("Expected fenced claim after detach() to remain .unheld")
        }
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
}
