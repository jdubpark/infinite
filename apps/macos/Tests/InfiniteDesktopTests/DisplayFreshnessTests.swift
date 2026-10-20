import XCTest
@testable import InfiniteDesktop

final class DisplayFreshnessTests: XCTestCase {
    @MainActor func testRepeatedFailuresKeepTheFirstThreeSecondDeadline() async throws {
        var warnings: [Bool] = []
        let freshness = DisplayFreshness { warnings.append($0) }
        defer { freshness.recovered() }

        freshness.failed()
        try await Task.sleep(for: .milliseconds(100))
        freshness.failed() // A manual refresh must not reveal the warning early.
        XCTAssertEqual(warnings, [])
        try await Task.sleep(for: .milliseconds(1_900))
        freshness.failed() // The normal two-second poll must not restart it either.
        XCTAssertEqual(warnings, [])
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertEqual(warnings, [true])
        freshness.failed()
        XCTAssertEqual(warnings, [true])
        freshness.recovered()
        XCTAssertEqual(warnings, [true, false])
    }

    @MainActor func testRecoveryCancelsTheOldDeadlineAndStartsANewStaleInterval() async throws {
        var warnings: [Bool] = []
        let freshness = DisplayFreshness { warnings.append($0) }
        defer { freshness.recovered() }

        freshness.failed()
        try await Task.sleep(for: .seconds(2))
        freshness.recovered()
        freshness.failed()
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertEqual(warnings, [false], "The canceled first deadline must not reveal the warning.")
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(warnings, [false, true])
    }

    @MainActor func testFirstCatalogFailureEventuallyShowsOfflineWithoutCachedData() async throws {
        let model = CmuxViewModel()
        // No backend is connected: snapshot fails locally without accessing a server.
        model.setDisplayVisible(true)
        await model.refresh()
        XCTAssertFalse(model.connected)
        XCTAssertFalse(model.catalogLoaded)
        XCTAssertFalse(model.catalogDisplayStale)
        try await Task.sleep(for: .milliseconds(3_300))
        XCTAssertTrue(model.catalogDisplayStale)
    }
}
