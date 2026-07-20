import XCTest
@testable import Dashboard
@testable import Models

/// Dashboard-lane tests: the pure budget math, projection, roll-up, and
/// month-pace logic the overview renders. All fixture-driven and deterministic.
///
/// NOTE (integration): the `UsageMonitorKitTests` target must add `"Dashboard"`
/// to its `dependencies` in `Package.swift` for this file to compile. See the
/// Dashboard lane's integration notes.
final class DashboardViewDataTests: XCTestCase {

    // A calendar pinned to UTC so day-of-month derivations are deterministic
    // regardless of the host's time zone.
    private var utcCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }

    // MARK: - Totals & fractions

    func testTotalsFromSample() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.totalSpent, 461.55, accuracy: 0.001)
        XCTAssertEqual(data.totalBudget, 570, accuracy: 0.001)
        XCTAssertEqual(data.remaining, 126.50, accuracy: 0.001)
        XCTAssertTrue(data.hasBudget)
        XCTAssertEqual(data.spentFraction, 461.55 / 570, accuracy: 0.0001)
    }

    func testPercentUsedPrefersSummaryThenFallsBack() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.percentUsedDisplay, 0.778, accuracy: 0.0001) // summary value

        // No percentUsed on the summary → falls back to spent/budget.
        var summary = BudgetSummary.sample
        summary.percentUsed = nil
        let response = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: ProviderBudgetStatus.sampleList, projects: nil, summary: summary
        )
        XCTAssertEqual(DashboardViewData(response).percentUsedDisplay, 461.55 / 570, accuracy: 0.0001)
    }

    func testNoBudgetYieldsZeroFractionNotDivideByZero() {
        var summary = BudgetSummary.sample
        summary.totalBudgetUsd = 0
        summary.percentUsed = nil
        let response = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: [.sampleUnconfigured], projects: nil, summary: summary
        )
        let data = DashboardViewData(response)
        XCTAssertFalse(data.hasBudget)
        XCTAssertEqual(data.spentFraction, 0)
        XCTAssertEqual(data.projectedFraction, 0)
        XCTAssertNil(data.projectedOverageFraction)
    }

    // MARK: - Projection

    func testProjectedEomSumsProviderProjections() {
        let data = DashboardViewData(.sample)
        // 210.40 + 335.10 + 151.80 + 28.40
        XCTAssertEqual(data.projectedEom, 725.70, accuracy: 0.001)
        XCTAssertTrue(data.projectedOverBudget)
        XCTAssertEqual(data.projectedDeltaVsBudget, 155.70, accuracy: 0.001)
        XCTAssertEqual(data.projectedOverageFraction!, 155.70 / 570, accuracy: 0.0001)
    }

    // MARK: - Status

    func testOverallStatusFollowsSummaryFlags() {
        XCTAssertEqual(DashboardViewData(.sample).overallStatus, .exceeded)

        var warnSummary = BudgetSummary.sample
        warnSummary.overBudget = false
        warnSummary.warning = true
        let warn = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: ProviderBudgetStatus.sampleList, projects: nil, summary: warnSummary
        )
        XCTAssertEqual(DashboardViewData(warn).overallStatus, .warning)

        var okSummary = BudgetSummary.sample
        okSummary.overBudget = false
        okSummary.warning = false
        let ok = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: [.sampleOk], projects: nil, summary: okSummary
        )
        XCTAssertEqual(DashboardViewData(ok).overallStatus, .ok)
    }

    func testProjectionStatusFromProjectionVsBudget() {
        // Sample projects well over budget → exceeded.
        XCTAssertEqual(DashboardViewData(.sample).projectionStatus, .exceeded)

        // Projection at 92% of budget → warning.
        let response = makeResponse(
            budget: 100,
            providers: [provider(spent: 40, projected: 92, budget: 100, status: .ok)]
        )
        XCTAssertEqual(DashboardViewData(response).projectionStatus, .warning)

        // Comfortable projection → ok.
        let okResponse = makeResponse(
            budget: 100,
            providers: [provider(spent: 20, projected: 50, budget: 100, status: .ok)]
        )
        XCTAssertEqual(DashboardViewData(okResponse).projectionStatus, .ok)
    }

    // MARK: - Roll-ups

    func testTopProvidersSpendDescendingWithLimit() {
        let data = DashboardViewData(.sample)
        let top = data.topProviders(limit: 2)
        XCTAssertEqual(top.map(\.id), ["prov_anthropic", "prov_openrouter"]) // 212.40, 134.90
        XCTAssertEqual(data.topProviders(limit: 0).count, 0)
        XCTAssertEqual(data.topProviders(limit: 99).count, 4) // clamps to available
    }

    func testTopProvidersTieBreakByTitle() {
        let response = makeResponse(
            budget: 300,
            providers: [
                provider(id: "b", name: "Zeta", spent: 50, projected: 60, budget: 100, status: .ok),
                provider(id: "a", name: "Alpha", spent: 50, projected: 60, budget: 100, status: .ok),
            ]
        )
        // Equal spend → alphabetical by title.
        XCTAssertEqual(DashboardViewData(response).topProviders(limit: 2).map(\.title), ["Alpha", "Zeta"])
    }

    func testAttentionRollups() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.overBudgetProviders.map(\.id), ["prov_openrouter"])
        XCTAssertEqual(data.warningProviders.map(\.id), ["prov_anthropic"])
        XCTAssertEqual(data.configuredProviderCount, 3) // unconfigured has no budget
    }

    func testCoverageCaveat() {
        XCTAssertTrue(DashboardViewData(.sample).hasIncompleteCoverage) // partials present

        let allComplete = makeResponse(
            budget: 100,
            providers: [provider(spent: 10, projected: 20, budget: 100, status: .ok, coverage: .complete)]
        )
        XCTAssertFalse(DashboardViewData(allComplete).hasIncompleteCoverage)
    }

    func testApiEquivalentSavings() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.apiEquivalentSavings, 512.30 - 461.55, accuracy: 0.001)
        XCTAssertTrue(data.hasApiEquivalentSavings)

        // Never negative.
        var summary = BudgetSummary.sample
        summary.estimatedApiEquivalentUsd = 10
        summary.totalSpentUsd = 400
        let response = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: [], projects: nil, summary: summary
        )
        XCTAssertEqual(DashboardViewData(response).apiEquivalentSavings, 0)
        XCTAssertFalse(DashboardViewData(response).hasApiEquivalentSavings)
    }

    func testIsEmpty() {
        XCTAssertTrue(DashboardViewData(.sampleEmpty).isEmpty)
        XCTAssertFalse(DashboardViewData(.sample).isEmpty)
    }

    // MARK: - SpendPace

    func testSpendPaceBasics() {
        let pace = SpendPace.make(
            month: "2026-07",
            generatedAt: ISO8601DateParser.date(from: "2026-07-19T09:15:00.000Z"),
            spent: 461.55, projected: 725.70, budget: 570,
            calendar: utcCalendar
        )
        let unwrapped = try! XCTUnwrap(pace)
        XCTAssertEqual(unwrapped.daysInMonth, 31)
        XCTAssertEqual(unwrapped.currentDay, 19)
        XCTAssertEqual(unwrapped.toDate.last?.value, 461.55)
        XCTAssertEqual(unwrapped.toDate.first?.value, 0)
        XCTAssertEqual(unwrapped.projection.first?.day, 19)
        XCTAssertEqual(unwrapped.projection.last?.day, 31)
        XCTAssertEqual(unwrapped.projection.last?.value, 725.70)
        XCTAssertEqual(unwrapped.idealPace.last?.value, 570)
        XCTAssertGreaterThan(unwrapped.yUpperBound, 725.70)
    }

    func testSpendPaceNilWithoutBudget() {
        XCTAssertNil(SpendPace.make(
            month: "2026-07", generatedAt: nil, spent: 100, projected: 120, budget: 0,
            calendar: utcCalendar
        ))
    }

    func testSpendPaceNilForBadMonth() {
        XCTAssertNil(SpendPace.make(
            month: "not-a-month", generatedAt: nil, spent: 100, projected: 120, budget: 200,
            calendar: utcCalendar
        ))
        XCTAssertNil(SpendPace.make(
            month: "2026-13", generatedAt: nil, spent: 100, projected: 120, budget: 200,
            calendar: utcCalendar
        ))
    }

    func testSpendPaceClampsDayForOtherMonths() {
        // Snapshot generated before the month → day 1.
        let before = SpendPace.make(
            month: "2026-07",
            generatedAt: ISO8601DateParser.date(from: "2026-06-15T00:00:00.000Z"),
            spent: 10, projected: 20, budget: 100, calendar: utcCalendar
        )
        XCTAssertEqual(before?.currentDay, 1)

        // Snapshot from a later month → treat the month as complete.
        let after = SpendPace.make(
            month: "2026-07",
            generatedAt: ISO8601DateParser.date(from: "2026-09-15T00:00:00.000Z"),
            spent: 10, projected: 20, budget: 100, calendar: utcCalendar
        )
        XCTAssertEqual(after?.currentDay, 31)
    }

    func testSpendPaceProjectedNeverBelowSpent() {
        let pace = SpendPace.make(
            month: "2026-02", // 2026 is not a leap year → 28 days
            generatedAt: ISO8601DateParser.date(from: "2026-02-10T00:00:00.000Z"),
            spent: 300, projected: 250, budget: 400, calendar: utcCalendar
        )
        XCTAssertEqual(pace?.daysInMonth, 28)
        XCTAssertEqual(pace?.projected, 300) // clamped up to spent
    }

    // MARK: - Fixture helpers

    private func makeResponse(budget: Double, providers: [ProviderBudgetStatus]) -> BudgetStatusResponse {
        let summary = BudgetSummary(
            totalBudgetUsd: budget,
            budgetedSpentUsd: providers.reduce(0) { $0 + $1.spentUsd },
            unbudgetedSpentUsd: 0,
            totalSpentUsd: providers.reduce(0) { $0 + $1.spentUsd },
            estimatedApiEquivalentUsd: 0,
            remainingUsd: budget - providers.reduce(0) { $0 + $1.spentUsd },
            percentUsed: nil,
            overBudget: false,
            warning: false
        )
        return BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: providers, projects: nil, summary: summary
        )
    }

    private func provider(
        id: String = "p",
        name: String = "Provider",
        spent: Double,
        projected: Double,
        budget: Double?,
        status: BudgetLevel,
        coverage: CostCoverage = .complete
    ) -> ProviderBudgetStatus {
        ProviderBudgetStatus(
            id: id, name: name, displayName: name,
            monthlyBudgetUsd: budget,
            spendCoverage: coverage,
            spentUsd: spent,
            projectedEomUsd: projected,
            remainingUsd: budget.map { $0 - spent },
            percentUsed: budget.map { $0 > 0 ? spent / $0 : 0 },
            status: status
        )
    }
}
