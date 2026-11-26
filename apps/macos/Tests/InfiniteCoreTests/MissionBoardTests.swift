import XCTest
@testable import InfiniteCore

final class MissionBoardTests: XCTestCase {
    private func parse(_ text: String) throws -> JSON { try JSON.parse(Data(text.utf8)) }
    private func item(_ id: String, column: String, updatedAt: String, groupID: String? = "storefront", project: String = "Storefront", kind: String = "mission") -> JSON {
        var fields: [String: JSON] = ["kind": .string(kind), "id": .string(id), "title": .string("Item " + id), "projectName": .string(project),
                                      "column": .string(column), "status": .string("working"), "detail": .string(""), "updatedAt": .string(updatedAt)]
        if let groupID { fields["groupId"] = .string(groupID) }
        return .object(fields)
    }

    func testProjectGroupsDecodeAndListOwnerGroupsFirst() throws {
        let list = ProjectGroupList(try parse("""
        {"groups":[
          {"id":"notes","name":"Notes","implicit":true,"revision":1,"createdAt":"","updatedAt":"","repos":[{"projectId":"notes","name":"notes","path":"/srv/work/notes"}]},
          {"id":"storefront","name":"Storefront","implicit":false,"revision":3,"createdAt":"","updatedAt":"","repos":[
            {"projectId":"storefront-web","name":"storefront-web","path":"/srv/work/storefront/web"},
            {"projectId":"storefront-api","name":"","path":"/srv/work/storefront/api"}]},
          {"name":"No ID","repos":[]}
        ],"suggestions":[{"name":"Tools","repos":["a","b"],"reason":"shared-parent"}]}
        """))
        XCTAssertEqual(list.groups.map(\.id), ["storefront", "notes"])
        XCTAssertEqual(list.groups.map(\.repoCountLabel), ["2 repos", nil])
        XCTAssertEqual(list.group("storefront")?.revision, 3)
        XCTAssertEqual(list.repoName("storefront-api"), "storefront-api")
        XCTAssertEqual(list.repoName("notes"), "notes")
        XCTAssertNil(list.repoName("missing"))
        XCTAssertEqual(list.suggestions.count, 1)
        XCTAssertEqual(ProjectGroupList.empty.groups, [])
    }

    func testRepositoriesListEveryCheckoutPrimaryFirstAndOlderHostsFallBackToThePrimary() throws {
        let list = ProjectGroupList(try parse("""
        {"groups":[
          {"id":"storefront","name":"Storefront","repos":[
            {"projectId":"storefront-api","name":"storefront-api","path":"/srv/work/api","checkouts":[
              {"projectId":"storefront-api","primary":true},{"projectId":"storefront-api-review","primary":false}]},
            {"projectId":"storefront-web","name":"storefront-web","path":"/srv/work/web"}]}
        ],"suggestions":[]}
        """))
        let group = try XCTUnwrap(list.group("storefront"))
        XCTAssertEqual(group.repos.map(\.checkoutIDs), [["storefront-api", "storefront-api-review"], ["storefront-web"]])
        XCTAssertEqual(group.projectIDs, ["storefront-api", "storefront-api-review", "storefront-web"])
    }

    func testBoardColumnsFollowBoardOrderNewestFirstAndHideEmptyOnes() {
        let board = Board(.object(["items": .array([
            item("old-work", column: "working", updatedAt: "2026-10-18T01:00:00.000Z"),
            item("ask", column: "needs-input", updatedAt: "2026-10-18T00:30:00.000Z"),
            item("new-work", column: "working", updatedAt: "2026-10-18T03:00:00.000Z"),
            item("done", column: "ended", updatedAt: "2026-10-18T04:00:00.000Z"),
            item("tie-a", column: "working", updatedAt: "2026-10-18T02:00:00.000Z"),
            item("tie-b", column: "working", updatedAt: "2026-10-18T02:00:00.000Z"),
        ])]))
        let columns = board.columns()
        XCTAssertEqual(columns.map(\.column), [.needsInput, .working, .ended])
        XCTAssertEqual(columns[1].items.map(\.id), ["new-work", "tie-a", "tie-b", "old-work"])
        XCTAssertEqual(board.count(.needsInput), 1)
        XCTAssertEqual(BoardColumn.allCases.map(\.title), ["Needs input", "Working", "Ready for review", "Ended"])
    }

    func testUnknownColumnsShowAsWorkingAndRowsWithoutIDsDrop() {
        var nameless = item("x", column: "review", updatedAt: "")
        if case .object(var fields) = nameless { fields["id"] = nil; nameless = .object(fields) }
        let board = Board(.object(["items": .array([item("future", column: "some-new-column", updatedAt: ""), nameless])]))
        XCTAssertEqual(board.items.map(\.id), ["future"])
        XCTAssertEqual(board.items.first?.column, .working)
    }

    func testFilteringByProjectMatchesOnlyCanonicalGroupID() {
        let appOne = ProjectGroup(.object(["id": .string("app-1"), "name": .string("App"), "repos": .array([])]))
        let appTwo = ProjectGroup(.object(["id": .string("app-2"), "name": .string("App"), "repos": .array([])]))
        let emptyID = ProjectGroup(.object(["id": .string(""), "name": .string("App"), "repos": .array([])]))
        let board = Board(.object(["items": .array([
            item("app1-mission", column: "working", updatedAt: "6", groupID: "app-1", project: "App"),
            item("app2-team", column: "review", updatedAt: "5", groupID: "app-2", project: "App", kind: "team"),
            item("missing-group", column: "review", updatedAt: "4", groupID: nil, project: "App", kind: "team"),
            item("empty-group", column: "working", updatedAt: "3", groupID: "", project: "App", kind: "goal"),
            item("orphan-group", column: "working", updatedAt: "2", groupID: "unmapped:group:app-1", project: "App"),
            item("orphan-project", column: "ended", updatedAt: "1", groupID: "unmapped:project:legacy", project: "App", kind: "team"),
        ])]))
        XCTAssertEqual(board.items(in: appOne).map(\.id), ["app1-mission"])
        XCTAssertEqual(board.items(in: appTwo).map(\.id), ["app2-team"])
        XCTAssertEqual(board.items(in: emptyID), [])
        XCTAssertEqual(board.items(in: nil).map(\.id), ["app1-mission", "app2-team", "missing-group", "empty-group", "orphan-group", "orphan-project"])
        XCTAssertEqual(board.columns(in: appOne).map(\.column), [.working])
        XCTAssertEqual(board.columns(in: appTwo).map(\.column), [.review])
        XCTAssertEqual(board.count(.working, in: appOne), 1)
        XCTAssertEqual(board.count(.review, in: appOne), 0)
        XCTAssertEqual(board.count(.review, in: appTwo), 1)
    }

    func testBoardItemReadsKindsSubtaskProgressAndLabels() throws {
        let mission = BoardItem(try parse(#"{"kind":"mission","id":"m1","title":"Checkout","projectName":"Storefront","column":"working","status":"working","detail":"Running subtask api-limits","updatedAt":"","subtasks":{"total":4,"running":1,"done":1}}"#))
        XCTAssertEqual(mission.kind, .mission)
        XCTAssertEqual(mission.subtaskLabel, "1/4 subtasks")
        XCTAssertEqual(mission.progressFraction, 0.25)
        XCTAssertEqual(mission.statusLabel, "Working")
        let team = BoardItem(try parse(#"{"kind":"team","id":"t1","title":"Fix","projectName":"Notes","column":"working","status":"verifying","detail":"","updatedAt":""}"#))
        XCTAssertEqual(team.kind, .team)
        XCTAssertNil(team.subtaskLabel)
        XCTAssertEqual(team.statusLabel, "Running checks")
        let future = BoardItem(try parse(#"{"kind":"pipeline","id":"p1","column":"working","status":"warming-up"}"#))
        XCTAssertNil(future.kind)
        XCTAssertEqual(future.statusLabel, "Warming up")
        XCTAssertEqual(BoardItem(try parse(#"{"id":"m","subtasks":{"total":1,"running":0,"done":1}}"#)).subtaskLabel, "1/1 subtask")
        XCTAssertEqual(BoardItem(try parse(#"{"id":"m","subtasks":{"total":4,"running":0,"done":3}}"#)).progressFraction, 0.75)
    }

    func testCaptionDetailPreservesHostDetailVerbatim() {
        func item(_ detail: String, done: Int = 1, total: Int = 3) -> BoardItem {
            BoardItem(.object([
                "id": .string("m"),
                "kind": .string("mission"),
                "detail": .string(detail),
                "subtasks": .object(["total": .number(Double(total)), "running": .number(1), "done": .number(Double(done))]),
            ]))
        }
        XCTAssertEqual(item("Running: Call api /health from web").detailBesideProgress, "Running: Call api /health from web")
        XCTAssertEqual(item("").detailBesideProgress, "")
        XCTAssertEqual(item("Planning subtasks", done: 0, total: 0).detailBesideProgress, "Planning subtasks")
        XCTAssertEqual(item("Should web wait for the merge?").detailBesideProgress, "Should web wait for the merge?")
        XCTAssertEqual(item("Running: Show 1 of 2 subtasks done", done: 1, total: 2).detailBesideProgress, "Running: Show 1 of 2 subtasks done")
        XCTAssertEqual(item("Running: Check summary. 1 of 2 subtasks done", done: 1, total: 2).detailBesideProgress, "Running: Check summary. 1 of 2 subtasks done")
        XCTAssertEqual(item("1 of 2 subtasks done", done: 1, total: 2).detailBesideProgress, "1 of 2 subtasks done")
        XCTAssertEqual(BoardItem(.object(["id": .string("m"), "detail": .string("Planning subtasks")])).detailBesideProgress, "Planning subtasks")
    }

    func testMissionDecodesDecisionsSubtasksAndOwnerControls() throws {
        let mission = Mission(try parse("""
        {"id":"8a1f0000-0000-4000-8000-000000000001","groupId":"storefront","groupName":"Storefront","repoProjectIds":["storefront-web","storefront-api"],
         "title":"Checkout limits","objective":"Add limits.","revision":4,"status":"needs-input","createdAt":"","updatedAt":"","deadlineAt":"",
         "subtasks":[
           {"id":"api-limits","repoProjectId":"storefront-api","title":"API limits","objective":"","size":"team","parallelism":3,"dependsOn":[],"status":"done","teamId":"t-1","teamStatus":"ready-for-review"},
           {"id":"web-banner","repoProjectId":"storefront-web","title":"Banner","objective":"","size":"solo","parallelism":1,"dependsOn":["api-limits"],"status":"queued"}],
         "decisions":[
           {"id":"d1","question":"Which limit?","options":["10","20"],"createdAt":"","subtaskId":"web-banner","childDecisionId":"c1"},
           {"id":"d0","question":"Earlier?","options":[],"createdAt":"","answer":"Yes","answeredAt":"","answeredBy":"coordinator"}],
         "steering":[],"events":[{"at":"2026-10-18T00:00:00.000Z","text":"Dispatched 2 subtasks."}]}
        """))
        XCTAssertEqual(mission.openDecisions.map(\.id), ["d1"])
        XCTAssertEqual(mission.answeredDecisions.map { $0["id"].string }, ["d0"])
        XCTAssertEqual(mission.origin(of: mission.openDecisions[0])?.title, "Banner")
        XCTAssertNil(mission.origin(of: MissionDecision(mission.answeredDecisions[0])))
        XCTAssertEqual(mission.progress.done, 1)
        XCTAssertEqual(mission.progress.total, 2)
        XCTAssertEqual(mission.subtasks.map(\.sizeLabel), ["Team · up to 3", "Solo"])
        XCTAssertEqual(mission.subtasks.map(\.typedSize), [.team(parallelism: 3), .solo])
        XCTAssertEqual(mission.subtasks.map(\.teamID), ["t-1", nil])
        XCTAssertEqual(mission.subtasks[0].statusLabel, "Done · Ready for your review")
        XCTAssertEqual(mission.subtasks[1].statusLabel, "Queued")
        XCTAssertEqual(mission.subtasks[1].dependsOn, ["api-limits"])
        XCTAssertEqual(mission.statusLabel, "Needs your input")
        XCTAssertEqual(mission.column, .needsInput)
        XCTAssertTrue(mission.canPause)
        XCTAssertFalse(mission.canResume)
        XCTAssertTrue(mission.canCancel)
    }

    func testOpenDecisionsKeepTheirIdentityWhenAnEarlierOneIsAnswered() {
        func mission(revision: Int, answeredA: Bool) -> Mission {
            var a: [String: JSON] = ["id": .string("a"), "question": .string("Items or products?"), "options": .array([])]
            if answeredA { a["answer"] = .string("Items") }
            let b: JSON = .object(["id": .string("b"), "question": .string("Show the limit in the cart?"), "options": .array([])])
            return Mission(.object(["id": .string("m"), "revision": .number(Double(revision)), "decisions": .array([.object(a), b, .object(["question": .string("No ID")])])]))
        }
        let before = mission(revision: 3, answeredA: false).openDecisions
        let after = mission(revision: 4, answeredA: true).openDecisions
        XCTAssertEqual(before.map(\.id), ["a", "b"])
        XCTAssertEqual(after.map(\.id), ["b"])
        XCTAssertEqual(after.first?.question, "Show the limit in the cart?")
        XCTAssertEqual(Set(before.map(\.id)).count, before.count)
    }

    func testRequestsPinTheDecisionAndTheObservedRevision() {
        let answer = MissionRequest.answer(missionID: "m1", decisionID: "b", revision: 3, text: "Yes", requestID: "r1")
        XCTAssertEqual(answer.path, "/missions/m1/answer/b")
        XCTAssertEqual(answer.body, .object(["requestId": .string("r1"), "revision": .number(3), "text": .string("Yes")]))
        let pause = MissionRequest.action(missionID: "m1", name: "pause", revision: 7, requestID: "r2")
        XCTAssertEqual(pause.path, "/missions/m1/pause")
        XCTAssertEqual(pause.body, .object(["requestId": .string("r2"), "revision": .number(7)]))
        XCTAssertEqual(MissionRequest.action(missionID: "m1", name: "steer", revision: 7, text: "Smaller", requestID: "r3").body["text"], .string("Smaller"))
    }

    func testReviewCopyLeavesDeliveryToEachRepositoryPolicy() {
        XCTAssertFalse(BoardColumn.review.subtitle.contains("nothing merges"))
        XCTAssertTrue(BoardColumn.review.subtitle.contains("each repository's policy"))
    }

    func testMissionStatusesMapToBoardColumnsAndControls() {
        let expected: [String: BoardColumn] = [
            "planning": .working, "working": .working, "paused": .working, "needs-input": .needsInput,
            "blocked": .needsInput, "ready-for-review": .review, "cancelled": .ended,
        ]
        for (status, column) in expected { XCTAssertEqual(Mission(.object(["status": .string(status)])).column, column, status) }
        let paused = Mission(.object(["status": .string("paused")]))
        XCTAssertTrue(paused.canResume)
        XCTAssertFalse(paused.canPause)
        let cancelled = Mission(.object(["status": .string("cancelled")]))
        XCTAssertFalse(cancelled.canCancel)
        XCTAssertTrue(cancelled.ended)
        XCTAssertFalse(Mission(.object(["status": .string("ready-for-review")])).canPause)
        for status in ["planning", "working", "needs-input"] { XCTAssertTrue(Mission(.object(["status": .string(status)])).canAnswer, status) }
        for status in ["paused", "blocked", "ready-for-review", "cancelled"] { XCTAssertFalse(Mission(.object(["status": .string(status)])).canAnswer, status) }
    }

    func testManagedSessionsDecodeTheirMissionAndOwnerSessionsCarryNone() throws {
        let managed = try parse(#"{"id":"s-1","status":"running","managedBy":{"kind":"mission","missionId":"m-1","teamId":"t-1"}}"#)
        XCTAssertEqual(try managed["managedBy"].decoded(SessionManagement.self), SessionManagement(kind: "mission", missionId: "m-1", teamId: "t-1"))
        let coordinator = try parse(#"{"id":"s-2","managedBy":{"kind":"mission","missionId":"m-1"}}"#)
        XCTAssertNil(try coordinator["managedBy"].decoded(SessionManagement.self).teamId)
        let owned = try parse(#"{"id":"s-3","status":"running"}"#)
        XCTAssertNil(try? owned["managedBy"].decoded(SessionManagement.self))
    }

    func testDecisionRecommendationReadsOnlyWhenPresentAndNamesTheComparison() throws {
        XCTAssertNil(DecisionRecommendation(try parse(#"{"id":"d-1","question":"Ship?"}"#)["recommendation"]))
        XCTAssertNil(DecisionRecommendation(try parse(#"{"recommendation":{"answers":[],"reason":"x"}}"#)["recommendation"]))
        let recommendation = try XCTUnwrap(DecisionRecommendation(try parse(#"{"recommendation":{"answers":["Yes"],"reason":"Tests pass.","outcome":"different"}}"#)["recommendation"]))
        XCTAssertTrue(recommendation.recommends("Yes"))
        XCTAssertFalse(recommendation.recommends("No"))
        XCTAssertEqual(recommendation.comparisonNote, "Different from the recommendation")
        XCTAssertNil(DecisionRecommendation(try parse(#"{"answers":["Later"],"outcome":"other"}"#))?.comparisonNote)
    }
}
