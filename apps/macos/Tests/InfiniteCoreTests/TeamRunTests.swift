import XCTest
@testable import InfiniteCore

/// The team dashboard reads the host's run record directly; these pin the few derived facts it shows.
final class TeamRunTests: XCTestCase {
    private func run(_ fields: [String: JSON]) -> TeamRun {
        var base: [String: JSON] = [
            "id": .string("b1f2c3d4-0000-4000-8000-000000000001"), "title": .string("Export recordings"), "status": .string("implementing"),
            "revision": .number(2), "projectId": .string("rehearsal"), "provider": .string("demo"), "createdAt": .string("2026-10-18T00:00:00.000Z"),
            "tasks": .array([]), "members": .array([]), "decisions": .array([]), "checks": .array([]), "steering": .array([]), "events": .array([]),
        ]
        for (key, value) in fields { base[key] = value }
        return TeamRun(.object(base))
    }
    private func decision(_ id: String, revision: Int, answer: String? = nil) -> JSON {
        var fields: [String: JSON] = ["id": .string(id), "memberId": .string("m1"), "revision": .number(Double(revision)), "question": .string("Which label?"), "options": .array([.string("Compact")]), "createdAt": .string("2026-10-18T00:01:00.000Z")]
        if let answer { fields["answer"] = .string(answer) }
        return .object(fields)
    }

    func testOnlyUnansweredDecisionsOfTheCurrentRevisionAreOpen() {
        let team = run(["status": .string("needs-input"), "decisions": .array([decision("old", revision: 1), decision("done", revision: 2, answer: "Compact"), decision("open", revision: 2)])])
        XCTAssertEqual(team.openDecisions.map { $0["id"].string }, ["open"])
        XCTAssertEqual(team.answeredDecisions.map { $0["id"].string }, ["done"])
        XCTAssertTrue(team.needsYou)
        XCTAssertEqual(team.summaryLine, "Needs your input · 1 decision")
    }

    func testSummaryLineCountsIntegratedTasksWhileWorking() {
        let tasks: [JSON] = [["id": "a", "status": "integrated"], ["id": "b", "status": "running"], ["id": "c", "status": "pending"]].map { fields in .object(fields.mapValues { .string($0) }) }
        let team = run(["tasks": .array(tasks)])
        XCTAssertEqual(team.progress.integrated, 1)
        XCTAssertEqual(team.progress.total, 3)
        XCTAssertTrue(team.working)
        XCTAssertEqual(team.summaryLine, "Implementing · 1/3 tasks integrated")
        XCTAssertEqual(run(["status": .string("ready-for-review"), "tasks": .array(tasks)]).summaryLine, "Ready for your review")
        XCTAssertEqual(run(["status": .string("some-new-state")]).statusLabel, "Some new state")
    }

    func testActiveMembersBelongToTheCurrentRevisionAndAreLive() {
        let member = { (id: String, revision: Int, status: String) -> JSON in .object(["memberId": .string(id), "sessionId": .string("s-" + id), "revision": .number(Double(revision)), "status": .string(status), "role": .string("implementer")]) }
        let team = run(["members": .array([member("stale", 1, "running"), member("done", 2, "reported"), member("live", 2, "waiting")])])
        XCTAssertEqual(team.activeMembers.map { $0["memberId"].string }, ["live"])
        XCTAssertEqual(team.member("done")?["status"].string, "reported")
        XCTAssertNil(team.member("missing"))
        XCTAssertEqual(TeamRun.roleName("project-manager"), "Coordinator")
        XCTAssertEqual(TeamRun.roleName("auditor"), "Auditor")
    }

    func testFinishedRunsAndLineup() {
        XCTAssertTrue(run(["status": .string("cancelled")]).finished)
        XCTAssertFalse(run(["status": .string("paused")]).finished)
        XCTAssertFalse(run(["status": .string("paused")]).working)
        XCTAssertFalse(run([:]).hasLineup)
        XCTAssertTrue(run(["lineup": .object(["coordinator": .object(["label": .string("Opus")])])]).hasLineup)
    }
}
