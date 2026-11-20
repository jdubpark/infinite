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
        XCTAssertEqual(model.run.revision, 3)
    }

    func testAListRowNeverReplacesAFullRead() {
        let model = model(run("2026-01-01T00:00:00.000Z"))
        let full = run("2026-01-01T00:00:01.000Z", objective: "Export the report")
        model.observe(full)
        model.observeListRow(run("2026-01-01T00:00:02.000Z"))
        model.observeListRow(run("2026-01-01T00:00:03.000Z", revision: 2))
        XCTAssertEqual(model.run, full, "The page keeps the request, check output and reports of its last full read")
    }
}
