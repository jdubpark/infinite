import XCTest
@testable import InfiniteDesktop

final class TeamResumeFailureTests: XCTestCase {
    func testRemovedTeamsDoNotKeepResumeFailuresInMemory() {
        let failures = [
            "current": TeamResumeFailure(message: "Retry this run."),
            "removed": TeamResumeFailure(message: "This run is no longer listed.")
        ]

        XCTAssertEqual(TeamResumeFailure.retainingExisting(failures, teamIDs: ["current"]), ["current": failures["current"]!])
    }
}
