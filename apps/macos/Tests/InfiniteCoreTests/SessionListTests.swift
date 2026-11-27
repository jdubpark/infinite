import XCTest
@testable import InfiniteCore

final class SessionListTests: XCTestCase {
    private func json(_ text: String) throws -> JSON { try JSON.parse(Data(text.utf8)) }

    private func poll(_ list: inout SessionList, _ text: String) throws -> SessionList.Outcome {
        let read = list.begin()
        return list.accept(try json(text), to: read)
    }

    func testAnUnchangedAnswerKeepsTheRowsOfTheVersionItNames() throws {
        var list = SessionList()
        XCTAssertEqual(list.path, "/sessions?since=", "with no version held, the poll asks for one")
        XCTAssertEqual(try poll(&list, #"{"version":"v1_A-b","sessions":[{"id":"a"},{"id":"b"}]}"#), .replaced)
        XCTAssertEqual(list.begin().path, "/sessions?since=v1_A-b")
        XCTAssertEqual(try poll(&list, #"{"version":"v1_A-b","unchanged":true}"#), .unchanged)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["a", "b"])
        XCTAssertEqual(try poll(&list, #"{"version":"v2","sessions":[{"id":"c"}]}"#), .replaced)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["c"])
        XCTAssertEqual(list.path, "/sessions?since=v2")
    }

    func testAHostThatIgnoresSinceAnswersRowsAndTheNextPollAsksAgain() throws {
        var list = SessionList()
        XCTAssertEqual(try poll(&list, #"{"sessions":[{"id":"a"}]}"#), .replaced)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["a"])
        XCTAssertEqual(list.path, "/sessions?since=")
        XCTAssertEqual(try poll(&list, #"{"version":"a b","sessions":[]}"#), .replaced)
        XCTAssertEqual(list.path, "/sessions?since=")
    }

    func testAnswersThatCannotStandForTheListAreUnreadable() throws {
        var list = SessionList()
        _ = try poll(&list, #"{"version":"v1","sessions":[{"id":"a"}]}"#)
        for text in [#"{"version":"v0","unchanged":true}"#, #"{"unchanged":true}"#, #"{"version":"v1","unchanged":"yes"}"#, #"{"version":"v1"}"#, #"[]"#, #"{"error":"Invalid request"}"#] {
            XCTAssertEqual(try poll(&list, text), .unreadable, text)
            XCTAssertEqual(list.rows.map { $0["id"].string }, ["a"], text)
        }
        let read = list.begin()
        XCTAssertEqual(list.acceptPlain(try json(#"{"sessions":[{"id":"b"}]}"#), to: read), .replaced)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["b"])
        XCTAssertEqual(list.path, "/sessions?since=")
        var fresh = SessionList()
        XCTAssertEqual(try poll(&fresh, #"{"version":"v1","unchanged":true}"#), .unreadable, "unchanged stands for nothing while no version is held")
    }

    func testTheAnswerToAnEarlierReadThatArrivesLateChangesNothing() throws {
        var list = SessionList()
        let earlier = list.begin(), later = list.begin()
        XCTAssertEqual(list.accept(try json(#"{"version":"v2","sessions":[{"id":"new"}]}"#), to: later), .replaced)
        XCTAssertEqual(list.accept(try json(#"{"version":"v1","sessions":[{"id":"old"}]}"#), to: earlier), .stale)
        XCTAssertEqual(list.acceptPlain(try json(#"{"sessions":[{"id":"old"}]}"#), to: earlier), .stale)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["new"])
        XCTAssertEqual(list.path, "/sessions?since=v2", "the next poll names the newer version")
    }
}
