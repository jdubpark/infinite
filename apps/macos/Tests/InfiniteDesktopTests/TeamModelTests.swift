import XCTest
import InfiniteCore
@testable import InfiniteDesktop

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
        XCTAssertEqual(model.loadState, .listSeed(listRow))
        XCTAssertEqual(model.run, listRow)
        XCTAssertFalse(model.isLoaded)
        XCTAssertFalse(model.fresh)
        XCTAssertFalse(model.behind)
    }
}
