import XCTest
@testable import InfiniteDesktop

final class DisplayVisibilityTests: XCTestCase {
    func testPollingRequiresAnAwakeAppWithAtLeastOneVisibleWindow() {
        XCTAssertTrue(DisplayVisibility(appHidden: false, systemSleeping: false, visibleWindowCount: 1).isVisible)
        XCTAssertTrue(DisplayVisibility(appHidden: false, systemSleeping: false, visibleWindowCount: 2).isVisible)
        XCTAssertFalse(DisplayVisibility(appHidden: false, systemSleeping: false, visibleWindowCount: 0).isVisible)
        XCTAssertFalse(DisplayVisibility(appHidden: true, systemSleeping: false, visibleWindowCount: 1).isVisible)
        XCTAssertFalse(DisplayVisibility(appHidden: false, systemSleeping: true, visibleWindowCount: 1).isVisible)
    }
}
