import XCTest
import Models

/// Placeholder host-app test bundle. The bulk of logic is tested in the
/// `UsageMonitorKit` SPM test target (fast, no simulator host). Keep a smoke
/// test here so the app scheme's Test action is wired end to end; feature lanes
/// that need a hosted (UI/integration) test add files alongside this one.
final class AppSmokeTests: XCTestCase {
    func testFixturesAreAvailable() {
        XCTAssertFalse(BudgetStatusResponse.sample.providers.isEmpty)
    }
}
