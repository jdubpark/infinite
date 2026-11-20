import XCTest
@testable import InfiniteCore

/// The session poll names the version it holds; these pin which answers keep, replace, or cannot stand for the list.
final class SessionListTests: XCTestCase {
    private func json(_ text: String) throws -> JSON { try JSON.parse(Data(text.utf8)) }

    func testAnUnchangedAnswerKeepsTheRowsOfTheVersionItNames() throws {
        var list = SessionList()
        XCTAssertEqual(list.path, "/sessions?since=", "with no version held, the poll asks for one")
        XCTAssertEqual(list.accept(try json(#"{"version":"v1_A-b","sessions":[{"id":"a"},{"id":"b"}]}"#)), .replaced)
        XCTAssertEqual(list.path, "/sessions?since=v1_A-b")
        XCTAssertEqual(list.accept(try json(#"{"version":"v1_A-b","unchanged":true}"#)), .unchanged)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["a", "b"])
        XCTAssertEqual(list.accept(try json(#"{"version":"v2","sessions":[{"id":"c"}]}"#)), .replaced)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["c"])
        XCTAssertEqual(list.path, "/sessions?since=v2")
    }

    func testAHostThatIgnoresSinceAnswersRowsAndTheNextPollAsksAgain() throws {
        var list = SessionList()
        XCTAssertEqual(list.accept(try json(#"{"sessions":[{"id":"a"}]}"#)), .replaced)
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["a"])
        XCTAssertEqual(list.path, "/sessions?since=")
        // A version outside the alphabet the host takes back is not kept.
        XCTAssertEqual(list.accept(try json(#"{"version":"a b","sessions":[]}"#)), .replaced)
        XCTAssertEqual(list.path, "/sessions?since=")
    }

    func testAnswersThatCannotStandForTheListAreUnreadable() throws {
        var list = SessionList()
        _ = list.accept(try json(#"{"version":"v1","sessions":[{"id":"a"}]}"#))
        for text in [#"{"version":"v0","unchanged":true}"#, #"{"unchanged":true}"#, #"{"version":"v1","unchanged":"yes"}"#, #"{"version":"v1"}"#, #"[]"#, #"{"error":"Invalid request"}"#] {
            XCTAssertEqual(list.accept(try json(text)), .unreadable, text)
            XCTAssertEqual(list.rows.map { $0["id"].string }, ["a"], text)
        }
        // The plain read that follows replaces the rows as the app always read them, and drops the version.
        list.acceptPlain(try json(#"{"sessions":[{"id":"b"}]}"#))
        XCTAssertEqual(list.rows.map { $0["id"].string }, ["b"])
        XCTAssertEqual(list.path, "/sessions?since=")
        var fresh = SessionList()
        XCTAssertEqual(fresh.accept(try json(#"{"version":"v1","unchanged":true}"#)), .unreadable, "unchanged stands for nothing while no version is held")
    }
}
