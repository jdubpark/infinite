import XCTest
@testable import InfiniteCore

/// The project-first Home reads the host's project, board, and mission JSON directly; these pin the
/// grouping and filtering it derives from them.
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
        // A repository without a display name falls back to its host project ID.
        XCTAssertEqual(list.repoName("storefront-api"), "storefront-api")
        XCTAssertEqual(list.repoName("notes"), "notes")
        XCTAssertNil(list.repoName("missing"))
        XCTAssertEqual(list.suggestions.count, 1)
        XCTAssertEqual(ProjectGroupList.empty.groups, [])
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

    /// An unknown column still shows, and a row without an ID is dropped rather than colliding.
    func testUnknownColumnsShowAsWorkingAndRowsWithoutIDsDrop() {
        var nameless = item("x", column: "review", updatedAt: "")
        if case .object(var fields) = nameless { fields["id"] = nil; nameless = .object(fields) }
        let board = Board(.object(["items": .array([item("future", column: "some-new-column", updatedAt: ""), nameless])]))
        XCTAssertEqual(board.items.map(\.id), ["future"])
        XCTAssertEqual(board.items.first?.column, .working)
    }

    func testFilteringByProjectMatchesGroupIDOrProjectNameWhenUngrouped() {
        let storefront = ProjectGroup(.object(["id": .string("storefront"), "name": .string("Storefront"), "repos": .array([])]))
        let notes = ProjectGroup(.object(["id": .string("notes"), "name": .string("Notes"), "implicit": .bool(true), "repos": .array([])]))
        let board = Board(.object(["items": .array([
            item("mission", column: "working", updatedAt: "1"),
            item("team-no-group", column: "review", updatedAt: "2", groupID: nil, kind: "team"),
            item("notes-goal", column: "working", updatedAt: "3", groupID: "notes", project: "Notes", kind: "goal"),
            // A group ID wins over a matching name: this row belongs elsewhere.
            item("elsewhere", column: "working", updatedAt: "4", groupID: "other"),
        ])]))
        XCTAssertEqual(Set(board.items(in: storefront).map(\.id)), ["mission", "team-no-group"])
        XCTAssertEqual(board.items(in: notes).map(\.id), ["notes-goal"])
        XCTAssertEqual(board.items(in: nil).count, 4)
        XCTAssertEqual(board.columns(in: storefront).map(\.column), [.working, .review])
        XCTAssertEqual(board.count(.working, in: notes), 1)
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

    /// A card and its draft follow the decision's host ID. When polling drops an answered question,
    /// the remaining one keeps its own ID instead of inheriting the first card's position.
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

    /// An answer names the decision and the revision the owner saw, whatever the mission says by the time it is sent.
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

    /// Each mission status lands in the column the board contract names, and controls follow it.
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
    }
}
