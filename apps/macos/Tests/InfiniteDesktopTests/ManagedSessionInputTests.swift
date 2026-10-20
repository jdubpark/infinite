import XCTest
import InfiniteCore
@testable import InfiniteDesktop

/// A mission-managed session opens its terminal fallback only while its provider prompt waits for the owner.
final class ManagedSessionInputTests: XCTestCase {
    private func session(_ text: String) throws -> AgentSession {
        AgentSession(value: try JSON.parse(Data(text.utf8)))
    }
    func testManagedSessionsOpenTheTerminalOnlyWhileTheirPromptWaits() throws {
        let waiting = try session(#"{"id":"s-1","status":"running","managedBy":{"kind":"mission","missionId":"m-1"},"attention":{"state":"needs-you"}}"#)
        XCTAssertTrue(waiting.managed)
        XCTAssertTrue(waiting.terminalOpen)
        let working = try session(#"{"id":"s-1","status":"running","managedBy":{"kind":"mission","missionId":"m-1"},"attention":{"state":"turn-finished"}}"#)
        XCTAssertFalse(working.terminalOpen)
        // A session that has stopped needs nothing from the owner, so its terminal stays closed even with a stale attention state.
        let stopped = try session(#"{"id":"s-1","status":"exited","managedBy":{"kind":"mission","missionId":"m-1"},"attention":{"state":"needs-you"}}"#)
        XCTAssertFalse(stopped.terminalOpen)
    }
    func testOwnerSessionsKeepTheirTerminalWhetherOrNotAPromptWaits() throws {
        let idle = try session(#"{"id":"s-2","status":"running","attention":{"state":"turn-finished"}}"#)
        XCTAssertFalse(idle.managed)
        XCTAssertTrue(idle.terminalOpen)
        XCTAssertTrue(try session(#"{"id":"s-3","status":"running","attention":{"state":"needs-you"}}"#).terminalOpen)
    }
}
