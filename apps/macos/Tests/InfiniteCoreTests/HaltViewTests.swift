import XCTest
@testable import InfiniteCore

final class HaltViewTests: XCTestCase {
    private func parse(_ text: String) throws -> HaltView { HaltView(try JSON.parse(Data(text.utf8))) }

    func testHostAndProjectHaltsDecodeWithTheirReasons() throws {
        let halt = try parse("""
        {"readable":true,
         "host":{"haltId":"h1","at":"2026-11-15T09:30:00.000Z","reason":"Database migration","by":"Owner laptop"},
         "projects":[
           {"projectId":"storefront-api","haltId":"p1","at":"2026-11-15T08:00:00.000Z","by":"Owner phone"},
           {"projectId":"notes","haltId":"p2","at":"2026-11-15T08:10:00.000Z","reason":"  ","by":"Owner laptop"}]}
        """)
        XCTAssertTrue(halt.readable)
        XCTAssertTrue(halt.holdsHost)
        XCTAssertEqual(halt.host?.haltID, "h1")
        XCTAssertNil(halt.host?.projectID)
        XCTAssertEqual(halt.host?.reason, "Database migration")
        XCTAssertEqual(halt.host?.by, "Owner laptop")
        XCTAssertEqual(halt.projects.map(\.projectID), ["storefront-api", "notes"])
        XCTAssertEqual(halt.projects.map(\.reason), [nil, nil])
        XCTAssertEqual(halt.projects(covering: ["notes", "other"]).map(\.haltID), ["p2"])
        XCTAssertEqual(halt.projects(covering: []), [])
    }

    func testProjectHaltsAloneDoNotHoldTheHostButAnUnreadableRecordDoes() throws {
        let projectOnly = try parse(#"{"readable":true,"projects":[{"projectId":"notes","haltId":"p2","at":"2026-11-15T08:10:00.000Z","by":"Owner laptop"}]}"#)
        XCTAssertNil(projectOnly.host)
        XCTAssertFalse(projectOnly.holdsHost)
        XCTAssertEqual(projectOnly.projects.count, 1)

        let unreadable = try parse(#"{"readable":false,"host":{"haltId":"stale","at":"2026-11-15T00:00:00.000Z","by":"Old"},"projects":[{"projectId":"notes","haltId":"p2","at":"2026-11-15T08:10:00.000Z","by":"Owner laptop"}]}"#)
        XCTAssertEqual(unreadable.state, .unreadable)
        XCTAssertFalse(unreadable.readable)
        XCTAssertNil(unreadable.host)
        XCTAssertEqual(unreadable.projects, [])
        XCTAssertTrue(unreadable.holdsHost)

        XCTAssertFalse(HaltView.clear.holdsHost)
        XCTAssertEqual(try parse(#"{"readable":true,"projects":[]}"#), .clear)
    }
}
