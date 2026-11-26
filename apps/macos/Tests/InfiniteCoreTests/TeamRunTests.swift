import XCTest
@testable import InfiniteCore

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
        XCTAssertEqual(run(["status": .string("some-new-state")]).typedStatus, .unknown("some-new-state"))
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

    func testHomeBoardGroupsEveryHostState() {
        let expected: [String: ProjectState] = [
            "planning": .ongoing, "discovering": .ongoing, "implementing": .ongoing, "integrating": .ongoing, "verifying": .ongoing,
            "reviewing": .ongoing, "delivering": .ongoing, "some-new-state": .ongoing,
            "needs-input": .pending, "ready-for-review": .pending, "blocked": .stuck, "paused": .paused,
            "merged": .complete, "cancelled": .cancelled, "no-change": .aborted,
        ]
        for (status, state) in expected { XCTAssertEqual(run(["status": .string(status)]).projectState, state, status) }
        XCTAssertEqual(run(["decisions": .array([decision("open", revision: 2)])]).projectState, .pending)
        XCTAssertEqual(run(["status": .string("paused"), "decisions": .array([decision("open", revision: 2)])]).projectState, .paused)
        XCTAssertEqual(ProjectState.allCases.filter(\.closed), [.complete, .cancelled, .aborted])
        XCTAssertEqual(ProjectState.allCases, [.stuck, .ongoing, .pending, .paused, .complete, .cancelled, .aborted])
    }

    func testStatusRingNeverDropsBelowThePhase() {
        let tasks: [JSON] = [["id": "a", "status": "integrated"], ["id": "b", "status": "running"], ["id": "c", "status": "running"], ["id": "d", "status": "pending"]].map { fields in .object(fields.mapValues { .string($0) }) }
        XCTAssertEqual(run([:]).progressFraction, 0.25)
        XCTAssertEqual(run(["status": .string("verifying"), "tasks": .array(tasks)]).progressFraction, 0.75)
        XCTAssertEqual(run(["status": .string("ready-for-review")]).progressFraction, 1)
        XCTAssertEqual(run(["linear": .object(["issue": .object(["identifier": .string("INF-7")])])]).linearIssue, "INF-7")
    }

    func testLastActivityFollowsHistoryNotRoutineSaves() {
        let events: JSON = .array([["at": "2026-10-18T01:00:00.000Z", "text": "Plan reported."], ["at": "2026-10-18T02:30:00.000Z", "text": "Checks passed."]].map { .object($0.mapValues { .string($0) }) })
        XCTAssertEqual(run(["updatedAt": .string("2026-10-18T09:00:00.000Z"), "events": events]).lastActivityAt, "2026-10-18T02:30:00.000Z")
        XCTAssertEqual(run(["updatedAt": .string("2026-10-18T09:00:00.000Z")]).lastActivityAt, "2026-10-18T09:00:00.000Z")
    }

    func testBlockedRunsSortFirstAndKeepTheOrderWithinEachGroup() {
        let ready = run(["id": .string("ready"), "status": .string("ready-for-review")])
        let blockedA = run(["id": .string("blocked-a"), "status": .string("blocked")])
        let working = run(["id": .string("working"), "status": .string("implementing")])
        let blockedB = run(["id": .string("blocked-b"), "status": .string("blocked")])
        let sorted = TeamRun.blockedFirst([ready, blockedA, working, blockedB])
        XCTAssertEqual(sorted.map(\.id), ["blocked-a", "blocked-b", "ready", "working"])
        XCTAssertEqual(TeamRun.blockedFirst([]).map(\.id), [])
    }

    func testMissionSubteamsAreManagedAndNeverOfferAListResume() {
        let subteam = run(["status": .string("blocked"), "resumable": .bool(true), "missionId": .string("m-1")])
        XCTAssertTrue(subteam.managedByMission)
        XCTAssertFalse(subteam.offersResume)
        XCTAssertFalse(run([:]).managedByMission)
    }

    func testOnlyAResumableBlockedRunWithoutGoalOrReceiptOffersResume() {
        let receipt: JSON = .object(["id": .string("r1")])
        XCTAssertTrue(run(["status": .string("blocked"), "resumable": .bool(true)]).offersResume)
        XCTAssertTrue(run(["status": .string("blocked"), "resumable": .bool(true), "goal": .null, "deliveryReceipt": .null]).offersResume)
        XCTAssertTrue(run(["status": .string("blocked"), "resumable": .bool(true), "goal": .string("")]).offersResume)
        XCTAssertFalse(run(["status": .string("blocked"), "resumable": .bool(false)]).offersResume)
        XCTAssertFalse(run(["status": .string("blocked")]).offersResume)
        XCTAssertFalse(run(["status": .string("blocked"), "resumable": .bool(true), "goal": .string("Ship the export")]).offersResume)
        XCTAssertFalse(run(["status": .string("blocked"), "resumable": .bool(true), "deliveryReceipt": receipt]).offersResume)
        XCTAssertFalse(run(["status": .string("paused"), "resumable": .bool(true)]).offersResume)
    }

    func testFinishedRunsAndLineup() {
        XCTAssertTrue(run(["status": .string("cancelled")]).finished)
        XCTAssertFalse(run(["status": .string("paused")]).finished)
        XCTAssertFalse(run(["status": .string("paused")]).working)
        XCTAssertFalse(run([:]).hasLineup)
        XCTAssertTrue(run(["lineup": .object(["coordinator": .object(["label": .string("Opus")])])]).hasLineup)
    }

    private func task(_ id: String, _ status: String, after: [String] = [], summary: String = "", limitations: [JSON]? = nil) -> JSON {
        var fields: [String: JSON] = ["id": .string(id), "title": .string("Task " + id), "status": .string(status), "dependsOn": .array(after.map { .string($0) }), "paths": .array([.string("src/\(id).mjs")]), "summary": .string(summary)]
        if let limitations { fields["limitations"] = .array(limitations) }
        return .object(fields)
    }
    private func check(_ status: String, revision: Int = 2, args: [String] = ["test"], phase: String? = nil) -> JSON {
        var fields: [String: JSON] = ["command": .object(["command": .string("npm"), "args": .array(args.map { .string($0) })]), "status": .string(status), "revision": .number(Double(revision)), "output": .string("")]
        if let phase { fields["phase"] = .string(phase) }
        return .object(fields)
    }

    func testTaskColumnsFollowDependencyDepthAndSurviveBadEdges() {
        let team = run(["tasks": .array([task("a", "integrated"), task("b", "integrated"), task("c", "pending", after: ["a", "b"]), task("d", "pending", after: ["c", "missing"])])])
        XCTAssertEqual(team.taskColumns.map { $0.map { $0["id"].string } }, [["a", "b"], ["c"], ["d"]])
        let cycle = run(["tasks": .array([task("x", "pending", after: ["y"]), task("y", "pending", after: ["x"])])])
        XCTAssertEqual(Set(cycle.taskColumns.flatMap { $0.map { $0["id"].string } }), ["x", "y"])
    }

    func testCurrentChecksKeepTheLatestResultPerCommandInThisRevision() {
        let team = run(["checks": .array([check("passed", revision: 1), check("failed"), check("passed"), check("passed", args: ["run", "build"]), check("passed", args: ["ci"], phase: "setup")])])
        XCTAssertEqual(team.currentChecks.map { "\(TeamRun.commandLine($0["command"])) \($0["status"].string)" }, ["npm test passed", "npm run build passed"])
    }

    func testStagesReflectEvidenceAndStaleVerdictsDoNotCount() {
        let ready = run(["status": .string("ready-for-review"), "headCommit": .string("bbb"), "tasks": .array([task("a", "integrated")]), "checks": .array([check("passed")]),
                         "review": .object(["verdict": .string("approved"), "revision": .number(2), "summary": .string("ok")])])
        XCTAssertEqual(ready.stages.map(\.state), [.done, .done, .done, .done, .done, .active])
        let stale = run(["status": .string("reviewing"), "tasks": .array([task("a", "integrated")]), "checks": .array([check("failed")]),
                         "review": .object(["verdict": .string("approved"), "revision": .number(1), "summary": .string("ok")])])
        XCTAssertNil(stale.currentVerdict)
        XCTAssertEqual(stale.stages.map(\.state), [.done, .done, .pending, .failed, .active, .pending])
        XCTAssertEqual(run(["status": .string("planning")]).stages.first?.state, .active)
    }

    func testLimitationsAreReadFromTheAgentsReportHeading() {
        let summary = "Changes:\n- did things\n\nLimitations:\n- No Linear MCP tool was available,\n  so no comment was posted.\n\nNext: none"
        XCTAssertEqual(TeamRun.limitations(summary), "No Linear MCP tool was available, so no comment was posted.")
        XCTAssertEqual(TeamRun.limitations("Limitations: none known"), "none known")
        XCTAssertNil(TeamRun.limitations("All good."))
    }

    func testReviewStepsPutBlockersFirstAndNeverInventApproval() {
        let team = run(["status": .string("ready-for-review"), "baseCommit": .string("aaa"), "headCommit": .string("bbb"), "branch": .string("team/x"),
                        "tasks": .array([task("a", "integrated", summary: "Limitations:\nNo fixture for empty input.")]), "checks": .array([check("failed")]),
                        "review": .object(["verdict": .string("changes-requested"), "revision": .number(2), "summary": .string("fix")])])
        let steps = team.reviewSteps
        XCTAssertEqual(steps.map(\.title), ["Fix the failing check", "Address the reviewer's changes", "Resolve a flagged limitation", "Read the diff", "Ask for end-to-end proof", "Ask what could break"])
        XCTAssertEqual(steps.prefix(2).map(\.urgent), [true, true])
        XCTAssertEqual(steps[3].action, .copy("git diff aaa..bbb"))
        let clean = run(["status": .string("ready-for-review"), "tasks": .array([task("a", "integrated")]), "checks": .array([check("passed")])])
        XCTAssertFalse(clean.reviewSteps.contains { $0.urgent })
        XCTAssertFalse(clean.reviewSteps.contains { $0.title == "Read the diff" })
    }

    func testStructuredTaskLimitationsOverrideSummaryScraping() {
        let singleTask = task("a", "integrated", summary: "Limitations:\n- Legacy note that should be ignored.", limitations: [.string("  No simulator run.  ")])
        XCTAssertEqual(TeamRun.limitations(of: singleTask), ["No simulator run."])
        let singleSteps = run(["status": .string("ready-for-review"), "tasks": .array([singleTask])]).reviewSteps
        XCTAssertEqual(singleSteps.first, TeamRun.ReviewStep(
            title: "Resolve a flagged limitation",
            detail: "Task a: No simulator run.",
            action: .direction("In \"Task a\" the agent reported this limitation: No simulator run.\nResolve it or explain why it is acceptable."),
            urgent: false
        ))

        let multiTask = task("b", "integrated", summary: "Done.", limitations: [.string("  No simulator run.  "), .string("   "), .number(7), .string("Skipped live check.")])
        XCTAssertEqual(TeamRun.limitations(of: multiTask), ["No simulator run.", "Skipped live check."])
        let multiSteps = run(["status": .string("ready-for-review"), "tasks": .array([multiTask])]).reviewSteps
        XCTAssertEqual(multiSteps.first, TeamRun.ReviewStep(
            title: "Resolve flagged limitations",
            detail: "Task b: No simulator run. · Skipped live check.",
            action: .direction("In \"Task b\" the agent reported these limitations:\n- No simulator run.\n- Skipped live check.\nResolve them or explain why they are acceptable."),
            urgent: false
        ))

        let emptyArrayTask = task("c", "integrated", summary: "Limitations:\n- Should never be scraped.", limitations: [])
        XCTAssertEqual(TeamRun.limitations(of: emptyArrayTask), [])
        let emptySteps = run(["status": .string("ready-for-review"), "tasks": .array([emptyArrayTask])]).reviewSteps
        XCTAssertFalse(emptySteps.contains { $0.title.lowercased().contains("limitation") })

        let blankArrayTask = task("d", "integrated", summary: "Limitations:\n- Should never be scraped.", limitations: [.string(" \n\t ")])
        XCTAssertEqual(TeamRun.limitations(of: blankArrayTask), [])
        let blankSteps = run(["status": .string("ready-for-review"), "tasks": .array([blankArrayTask])]).reviewSteps
        XCTAssertFalse(blankSteps.contains { $0.title.lowercased().contains("limitation") })

        let legacyTask = task("e", "integrated", summary: "Done.\n\nLimitations:\n- Legacy fallback gap.")
        XCTAssertEqual(TeamRun.limitations(of: legacyTask), ["Legacy fallback gap."])
        let legacySteps = run(["status": .string("ready-for-review"), "tasks": .array([legacyTask])]).reviewSteps
        XCTAssertEqual(legacySteps.first?.title, "Resolve a flagged limitation")
        XCTAssertEqual(legacySteps.first?.detail, "Task e: Legacy fallback gap.")
    }
}
