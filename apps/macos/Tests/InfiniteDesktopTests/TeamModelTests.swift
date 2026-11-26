import XCTest
import InfiniteCore
@testable import InfiniteDesktop

private actor TeamDeferred<Value: Sendable> {
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
}

@MainActor final class TeamModelTests: XCTestCase {
    private func run(_ updatedAt: String, revision: Double = 1, status: String = "implementing", objective: String? = nil) -> TeamRun {
        var fields: [String: JSON] = ["id": .string("run-1"), "revision": .number(revision), "updatedAt": .string(updatedAt), "status": .string(status)]
        if let objective { fields["objective"] = .string(objective) }
        return TeamRun(.object(fields))
    }
    private func model(_ seed: TeamRun) -> TeamModel {
        TeamModel(run: seed, client: RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token"), role: "owner")
    }

    func testAListRowSeedsARunThatWasNotReadInFull() {
        let model = model(run("2026-01-01T00:00:00.000Z"))
        let row = run("2026-01-01T00:00:01.000Z")
        model.observeListRow(row)
        XCTAssertEqual(model.run, row)
    }

    func testARowThatChangesWhatControlsUsePutsAFullReadBehindUntilTheRunIsReadAgain() {
        let model = model(run("2026-01-01T00:00:00.000Z", revision: 3))
        XCTAssertFalse(model.behind, "a row seed is not a full read")
        model.observe(run("2026-01-01T00:01:00.000Z", revision: 3, objective: "The request."))
        model.observeListRow(run("2026-01-01T00:02:00.000Z", revision: 3))
        XCTAssertFalse(model.behind, "a later row with the same revision and status leaves the controls valid")
        model.observeListRow(run("2026-01-01T00:03:00.000Z", revision: 3, status: "blocked"))
        XCTAssertTrue(model.behind, "the page would still offer the controls of a working run")
        model.observe(run("2026-01-01T00:03:00.000Z", revision: 3, status: "blocked", objective: "The request."))
        XCTAssertFalse(model.behind)
        model.observeListRow(run("2026-01-01T00:04:00.000Z", revision: 4, status: "blocked"))
        XCTAssertTrue(model.behind, "a request naming revision 3 would be refused")
        XCTAssertEqual(model.run?.revision, 3)
    }

    func testADirectionSourceIsLabelledByItsKind() {
        XCTAssertEqual(directionSourceLabel(.object(["kind": .string("github-review"), "name": .string("Your GitHub review")])), "Owner (GitHub review)")
        XCTAssertEqual(directionSourceLabel(.object(["kind": .string("connector"), "name": .string("Ops bot")])), "Ops bot")
        XCTAssertEqual(directionSourceLabel(.object(["kind": .string("connector"), "name": .string("")])), "Connector")
        XCTAssertEqual(directionSourceLabel(.string("coordinator")), "Mission coordinator")
        XCTAssertEqual(directionSourceLabel(.object(["kind": .string("unknown"), "name": .string("Other")])), "You")
        XCTAssertEqual(directionSourceLabel(.null), "You")
    }

    func testAListRowNeverReplacesAFullRead() {
        let model = model(run("2026-01-01T00:00:00.000Z"))
        let full = run("2026-01-01T00:00:01.000Z", objective: "Export the report")
        model.observe(full)
        model.observeListRow(run("2026-01-01T00:00:02.000Z"))
        model.observeListRow(run("2026-01-01T00:00:03.000Z", revision: 2))
        XCTAssertEqual(model.run, full, "The page keeps the request, check output and reports of its last full read")
    }

    func testPreFetchSeedStateGatesActionsHandlesFirstPollErrorAndTransitionsToLoaded() async {
        let seed = TeamSeed(id: "run-1", title: "Subteam alpha", status: "verifying", projectID: "repo-a")
        actor TeamPollRecorder {
            var calls: [(String, Bool)] = []
            var pollAttempt = 0
            func record(_ path: String, hasBody: Bool) -> Int {
                calls.append((path, hasBody))
                if !hasBody { pollAttempt += 1 }
                return pollAttempt
            }
        }
        let recorder = TeamPollRecorder()
        let fullRun = run("2026-01-01T00:02:00.000Z", revision: 2, status: "implementing", objective: "Ship it")
        let model = TeamModel(
            seed: seed,
            client: RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token"),
            role: "owner",
            sendRequest: { _, path, body in
                let attempt = await recorder.record(path, hasBody: body != nil)
                if body != nil { return .object([:]) }
                switch attempt {
                case 1: throw DesktopError("Network timeout")
                case 2: return .object(["id": .string("wrong-team"), "revision": .number(1)])
                default: return fullRun.value
                }
            }
        )

        XCTAssertEqual(model.loadState, .loading(seed: seed, error: nil))
        XCTAssertNil(model.run)
        XCTAssertFalse(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertEqual(model.id, "run-1")
        XCTAssertEqual(model.title, "Subteam alpha")
        XCTAssertEqual(model.status, "verifying")
        XCTAssertEqual(model.statusLabel, "Running checks")
        XCTAssertEqual(model.projectID, "repo-a")
        XCTAssertFalse(model.managed)
        XCTAssertFalse(model.behind)
        XCTAssertFalse(model.canSteer)
        XCTAssertFalse(model.canOwn)
        XCTAssertFalse(model.offersContinue)
        XCTAssertFalse(model.canContinue)

        model.direction = "Do not send while loading"
        await model.steer()
        await model.answer(.object(["id": .string("d1")]), text: "Yes")
        await model.perform("pause")
        await model.continueRun()
        let callsBeforePoll = await recorder.calls
        XCTAssertTrue(callsBeforePoll.isEmpty)

        model.setDisplayVisible(true)
        await model.poll()
        XCTAssertEqual(model.loadState, .loading(seed: seed, error: "Network timeout"))
        XCTAssertNil(model.run)
        XCTAssertEqual(model.loadError, "Network timeout")
        XCTAssertFalse(model.fresh)

        await model.poll()
        XCTAssertNil(model.run)
        XCTAssertEqual(model.loadError, "The server returned a mismatched team.")
        XCTAssertFalse(model.fresh)

        await model.poll()
        XCTAssertEqual(model.loadState, .loaded(fullRun, latestListRow: nil))
        XCTAssertEqual(model.run, fullRun)
        XCTAssertTrue(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertTrue(model.fresh)
        XCTAssertTrue(model.canSteer)
        XCTAssertTrue(model.canOwn)
    }

    func testLoadingSeedUpgradesToListSeedBeforeFullRead() {
        let seed = TeamSeed(id: "run-1", title: "Subteam alpha", status: "implementing", projectID: "repo-a", missionID: "m-1")
        let model = TeamModel(
            seed: seed,
            client: RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token"),
            role: "owner"
        )
        XCTAssertTrue(model.managed)
        XCTAssertNil(model.run)

        let listRow = run("2026-01-01T00:01:00.000Z", revision: 2)
        model.observeListRow(listRow)
        XCTAssertEqual(model.loadState, .listSeed(listRow, error: nil))
        XCTAssertEqual(model.run, listRow)
        XCTAssertFalse(model.isLoaded)
        XCTAssertFalse(model.fresh)
        XCTAssertFalse(model.behind)
    }

    func testListSeedFailingDetailPollSurfacesErrorAndKeepsDetailLoadingUntilRetrySucceeds() async {
        let initialRow = run("2026-01-01T00:00:00.000Z", revision: 1)
        let newerRow = run("2026-01-01T00:01:00.000Z", revision: 2)
        let fullRun = run("2026-01-01T00:02:00.000Z", revision: 2, status: "implementing", objective: "Full objective")
        actor AttemptCounter {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let counter = AttemptCounter()
        let model = TeamModel(
            run: initialRow,
            client: RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token"),
            role: "owner",
            sendRequest: { _, _, _ in
                if await counter.next() == 1 {
                    throw DesktopError("Detail read failed")
                }
                return fullRun.value
            }
        )

        XCTAssertEqual(model.loadState, .listSeed(initialRow, error: nil))
        XCTAssertFalse(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertFalse(model.canSteer)
        XCTAssertFalse(model.canOwn)

        model.setDisplayVisible(true)
        await model.poll()
        XCTAssertEqual(model.loadState, .listSeed(initialRow, error: "Detail read failed"))
        XCTAssertEqual(model.loadError, "Detail read failed")
        XCTAssertFalse(model.isLoaded)
        XCTAssertFalse(model.fresh)
        XCTAssertFalse(model.canSteer)
        XCTAssertFalse(model.canOwn)

        model.observeListRow(newerRow)
        XCTAssertEqual(model.loadState, .listSeed(newerRow, error: "Detail read failed"))
        XCTAssertEqual(model.loadError, "Detail read failed")
        XCTAssertFalse(model.isLoaded)

        await model.poll()
        XCTAssertEqual(model.loadState, .loaded(fullRun, latestListRow: nil))
        XCTAssertEqual(model.run, fullRun)
        XCTAssertTrue(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertTrue(model.fresh)
        XCTAssertTrue(model.canSteer)
        XCTAssertTrue(model.canOwn)
    }

    func testMutationReceiptReportsAcknowledgedRevisionWhenNewerPollArrivedFirst() async {
        let initialRun = run("2026-01-01T00:06:00.000Z", revision: 6, objective: "Ship it")
        let ackedRun = run("2026-01-01T00:07:00.000Z", revision: 7, objective: "Ship it")
        let newerPolledRun = run("2026-01-01T00:08:00.000Z", revision: 8, objective: "Ship it")
        let steerGate = TeamDeferred<JSON>()
        let model = TeamModel(
            run: initialRun,
            client: RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token"),
            role: "owner",
            sendRequest: { _, path, body in
                if body != nil, path.hasSuffix("/steer") {
                    return try await steerGate.wait()
                }
                return initialRun.value
            }
        )

        model.setDisplayVisible(true)
        await model.poll()
        XCTAssertEqual(model.run?.revision, 6)

        model.direction = "Tighten scope"
        let steerTask = Task { @MainActor in await model.steer() }
        await steerGate.waitUntilEntered()

        model.observe(newerPolledRun)
        XCTAssertEqual(model.run?.revision, 8)

        await steerGate.succeed(ackedRun.value)
        await steerTask.value

        XCTAssertEqual(model.run?.revision, 8)
        XCTAssertEqual(model.notice, "Direction recorded · revision 7.")
        XCTAssertFalse(model.noticeIsError)
        XCTAssertEqual(model.direction, "")
    }

    func testFirstFullReadOlderThanNewerListSeedTransitionsToLoadedBehind() async {
        let rowV1 = run("2026-01-01T00:01:00.000Z", revision: 1)
        let rowV2 = run("2026-01-01T00:02:00.000Z", revision: 2)
        let fullV1 = run("2026-01-01T00:01:00.000Z", revision: 1, objective: "Full objective v1")
        let fullV2 = run("2026-01-01T00:02:00.000Z", revision: 2, objective: "Full objective v2")
        let firstFetchGate = TeamDeferred<JSON>()
        actor FetchStep {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let step = FetchStep()
        let model = TeamModel(
            run: rowV1,
            client: RemoteClient(profile: HostProfile(label: "Test", origin: "http://127.0.0.1:1"), token: "token"),
            role: "owner",
            sendRequest: { _, _, _ in
                if await step.next() == 1 {
                    return try await firstFetchGate.wait()
                }
                return fullV2.value
            }
        )

        model.setDisplayVisible(true)
        let initialPoll = Task { @MainActor in await model.poll() }
        await firstFetchGate.waitUntilEntered()

        model.observeListRow(rowV2)
        XCTAssertEqual(model.loadState, .listSeed(rowV2, error: nil))

        await firstFetchGate.succeed(fullV1.value)
        await initialPoll.value

        XCTAssertEqual(model.loadState, .loaded(fullV1, latestListRow: rowV2))
        XCTAssertTrue(model.isLoaded)
        XCTAssertNil(model.loadError)
        XCTAssertEqual(model.run, fullV1)
        XCTAssertTrue(model.behind)
        XCTAssertFalse(model.fresh)
        XCTAssertFalse(model.canSteer)
        XCTAssertFalse(model.canOwn)

        await model.poll()
        XCTAssertEqual(model.loadState, .loaded(fullV2, latestListRow: rowV2))
        XCTAssertFalse(model.behind)
        XCTAssertTrue(model.fresh)
        XCTAssertTrue(model.canSteer)
    }

    func testTeamSeedGlyphAndProgressMatchLoadedRunAcrossStatuses() {
        let statuses = [
            "planning", "discovering", "implementing", "integrating", "verifying",
            "reviewing", "delivering", "needs-input", "ready-for-review", "blocked",
            "paused", "merged", "cancelled", "no-change", "some-future-status"
        ]
        for status in statuses {
            let seed = TeamSeed(id: "run-1", status: status)
            let loaded = TeamRun(.object(["id": .string("run-1"), "status": .string(status)]))
            XCTAssertEqual(seed.progressFraction, loaded.progressFraction, status)
            XCTAssertEqual(StatusGlyph(teamSeed: seed).kind, StatusGlyph(team: loaded).kind, status)
        }
        XCTAssertEqual(TeamSeed(id: "run-1", status: "integrating").progressFraction, 0.5)
        XCTAssertEqual(TeamSeed(id: "run-1", status: "verifying").progressFraction, 0.75)
        XCTAssertEqual(TeamSeed(id: "run-1", status: "reviewing").progressFraction, 0.75)
        XCTAssertEqual(TeamSeed(id: "run-1", status: "delivering").progressFraction, 1.0)
        XCTAssertEqual(StatusGlyph(teamSeed: TeamSeed(id: "run-1")).kind, .todo)

        let openDecisionRun = TeamRun(.object([
            "id": .string("run-1"),
            "status": .string("implementing"),
            "revision": .number(1),
            "decisions": .array([.object(["id": .string("d1"), "revision": .number(1), "question": .string("Continue?")])])
        ]))
        let needsInputSeed = TeamSeed(id: "run-1", status: "implementing", column: BoardColumn.needsInput.rawValue)
        XCTAssertEqual(StatusGlyph(teamSeed: needsInputSeed).kind, .attention)
        XCTAssertEqual(StatusGlyph(teamSeed: needsInputSeed).kind, StatusGlyph(team: openDecisionRun).kind)
        XCTAssertEqual(StatusGlyph(teamSeed: TeamSeed(id: "run-1", column: BoardColumn.needsInput.rawValue)).kind, .attention)
        XCTAssertEqual(StatusGlyph(teamSeed: TeamSeed(id: "run-1", status: "blocked", column: BoardColumn.needsInput.rawValue)).kind, .blocked)
    }
}
