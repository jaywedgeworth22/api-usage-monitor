import XCTest
import DesignSystem
import WidgetShared

// NOTE: `WidgetPresentation` is a pure, view-free helper compiled from
// `UsageMonitorWidget/WidgetPresentation.swift`. This test target compiles that
// single file directly (see project.yml `UsageMonitorWidgetTests` sources) so
// the mapping/derivation logic is exercised without a WidgetKit host.
final class WidgetPresentationTests: XCTestCase {

    // MARK: - Raw status string -> SemanticStatus

    func testSemanticStatusMapsKnownRawValues() {
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "ok"), .ok)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "warning"), .warning)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "exceeded"), .danger)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "unconfigured"), .neutral)
    }

    func testSemanticStatusDegradesUnknownRawValueToNeutral() {
        // Schema drift must never crash or mis-alarm.
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "totally-new"), .neutral)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: ""), .neutral)
    }

    // MARK: - Fraction

    func testFractionComputesSpentOverBudget() {
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: 200), 0.25, accuracy: 0.0001)
    }

    func testFractionIsZeroWithoutBudget() {
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: nil), 0)
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: 0), 0)
    }

    // MARK: - Overall status / label from snapshot flags

    func testOverallStatusPrioritisesOverBudget() {
        let s = makeSnapshot(overBudget: true, warning: true, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .danger)
        XCTAssertEqual(WidgetPresentation.overallLabel(for: s), "Over budget")
    }

    func testOverallStatusWarning() {
        let s = makeSnapshot(overBudget: false, warning: true, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .warning)
        XCTAssertEqual(WidgetPresentation.overallLabel(for: s), "Approaching")
    }

    func testOverallStatusOkWhenBudgetedAndOnTrack() {
        let s = makeSnapshot(overBudget: false, warning: false, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .ok)
        XCTAssertNil(WidgetPresentation.overallLabel(for: s))
    }

    func testOverallStatusNeutralWhenNoBudget() {
        let s = makeSnapshot(overBudget: false, warning: false, totalBudget: 0)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .neutral)
    }

    // MARK: - Detail / caption strings

    func testMeterDetailDropsDenominatorWithoutBudget() {
        XCTAssertFalse(WidgetPresentation.meterDetail(spent: 42, budget: nil).contains("/"))
        XCTAssertTrue(WidgetPresentation.meterDetail(spent: 42, budget: 100).contains("/"))
    }

    func testBudgetCaptionNilWithoutBudget() {
        XCTAssertNil(WidgetPresentation.budgetCaption(for: makeSnapshot(overBudget: false, warning: false, totalBudget: 0)))
        XCTAssertNotNil(WidgetPresentation.budgetCaption(for: makeSnapshot(overBudget: false, warning: false, totalBudget: 900)))
    }

    // MARK: - Helpers

    private func makeSnapshot(overBudget: Bool, warning: Bool, totalBudget: Double) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            month: "2026-07",
            totalSpentUsd: 428.16,
            totalBudgetUsd: totalBudget,
            projectedEomUsd: 690.4,
            percentUsed: totalBudget > 0 ? 428.16 / totalBudget : nil,
            overBudget: overBudget,
            warning: warning,
            topMeters: []
        )
    }
}
