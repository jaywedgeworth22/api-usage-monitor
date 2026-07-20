import Foundation
import Models

// ---------------------------------------------------------------------------
// Pure, deterministic presentation logic for the Dashboard.
//
// All budget math, projection, coverage, and roll-up derivations live here as
// value types with no SwiftUI / UIKit dependency, so they are unit-testable
// against fixture `BudgetStatusResponse`s. The views read these; they contain
// no arithmetic of their own.
// ---------------------------------------------------------------------------

/// Everything the Dashboard needs to render, derived from a single
/// `BudgetStatusResponse` (the shared `BudgetStore`'s value).
struct DashboardViewData: Equatable, Sendable {
    let response: BudgetStatusResponse

    init(_ response: BudgetStatusResponse) {
        self.response = response
    }

    var summary: BudgetSummary { response.summary }
    var providers: [ProviderBudgetStatus] { response.providers }

    // MARK: - Month-to-date totals

    var totalSpent: Double { summary.totalSpentUsd }
    var totalBudget: Double { summary.totalBudgetUsd }
    var remaining: Double { summary.remainingUsd }

    /// A real total budget is configured (drives meter vs. plain-spend hero).
    var hasBudget: Bool { totalBudget > 0 }

    /// Spent ÷ budget (0…∞). `0` when no budget is configured.
    var spentFraction: Double {
        guard hasBudget else { return 0 }
        return totalSpent / totalBudget
    }

    /// Prefer the server's `percentUsed`; fall back to the computed fraction.
    var percentUsedDisplay: Double { summary.percentUsed ?? spentFraction }

    // MARK: - Projection (month-end)

    /// Projected end-of-month spend for the whole account — the sum of each
    /// provider's own projection. The summary has no aggregate projection, so
    /// it is rolled up here.
    var projectedEom: Double {
        providers.reduce(0) { $0 + $1.projectedEomUsd }
    }

    var projectedFraction: Double {
        guard hasBudget else { return 0 }
        return projectedEom / totalBudget
    }

    /// Signed gap between projection and budget: positive = projected over.
    var projectedDeltaVsBudget: Double { projectedEom - totalBudget }

    var projectedOverBudget: Bool { hasBudget && projectedEom > totalBudget }

    /// Projected overshoot as a fraction of budget, e.g. `0.21` for +21%.
    var projectedOverageFraction: Double? {
        guard hasBudget, totalBudget > 0 else { return nil }
        return projectedDeltaVsBudget / totalBudget
    }

    // MARK: - Overall status

    /// The account-level status the hero renders. Server flags win; an
    /// all-unconfigured account reads neutral.
    var overallStatus: BudgetLevel {
        if summary.overBudget { return .exceeded }
        if summary.warning { return .warning }
        if configuredProviderCount == 0 { return .unconfigured }
        return .ok
    }

    /// Status the *projection* implies (may be worse than today's status).
    var projectionStatus: BudgetLevel {
        guard hasBudget else { return .unconfigured }
        if projectedEom > totalBudget { return .exceeded }
        if projectedFraction >= 0.9 { return .warning }
        return .ok
    }

    // MARK: - Provider roll-ups

    var overBudgetProviders: [ProviderBudgetStatus] {
        providers.filter { $0.status == .exceeded }
    }

    var warningProviders: [ProviderBudgetStatus] {
        providers.filter { $0.status == .warning }
    }

    var configuredProviderCount: Int {
        providers.filter(\.hasBudget).count
    }

    /// The N providers with the highest month-to-date spend, spend-descending.
    func topProviders(limit: Int) -> [ProviderBudgetStatus] {
        guard limit > 0 else { return [] }
        return providers
            .sorted { lhs, rhs in
                if lhs.spentUsd != rhs.spentUsd { return lhs.spentUsd > rhs.spentUsd }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: - Coverage caveat

    /// Any provider whose reported spend is not provably complete — the hero
    /// shows a "may be incomplete" caveat when true.
    var hasIncompleteCoverage: Bool {
        providers.contains { !$0.spendCoverage.isComplete }
    }

    // MARK: - Value captured

    /// What the tracked usage would cost at list API rates.
    var estimatedApiEquivalent: Double { summary.estimatedApiEquivalentUsd }

    /// Money saved vs. paying list API rates (never negative for display).
    var apiEquivalentSavings: Double {
        max(estimatedApiEquivalent - totalSpent, 0)
    }

    var hasApiEquivalentSavings: Bool { apiEquivalentSavings > 0.005 }

    // MARK: - Empty / first-run

    /// Nothing meaningful to show yet (all zeros, no providers).
    var isEmpty: Bool {
        providers.isEmpty && totalSpent == 0 && totalBudget == 0
    }
}

// MARK: - Spend pace / projection series

/// A single (day, cumulative-USD) sample for the month-pace chart.
struct PacePoint: Identifiable, Equatable, Sendable {
    let day: Int
    let value: Double
    var id: Int { day }
}

/// The month-pace projection: month-to-date spend and a forecast to month end,
/// against an even-spend reference line and the budget. Derived purely from the
/// snapshot's real figures (current spend, projection, budget) plus the month's
/// calendar — it is a forecast, not fabricated daily history.
struct SpendPace: Equatable, Sendable {
    let daysInMonth: Int
    let currentDay: Int
    let spent: Double
    let projected: Double
    let budget: Double

    /// Even-spend reference: origin to full budget across the month.
    var idealPace: [PacePoint] {
        [PacePoint(day: 0, value: 0), PacePoint(day: daysInMonth, value: budget)]
    }

    /// Cumulative spend from month start to today (linear approximation of the
    /// month-to-date pace — the endpoint is the real month-to-date figure).
    var toDate: [PacePoint] {
        [PacePoint(day: 0, value: 0), PacePoint(day: currentDay, value: spent)]
    }

    /// The forecast segment: today's spend extended to the projected month-end.
    var projection: [PacePoint] {
        [PacePoint(day: currentDay, value: spent),
         PacePoint(day: daysInMonth, value: projected)]
    }

    /// Upper bound for the chart's Y domain so budget, spend, and projection all
    /// stay visible with a little headroom.
    var yUpperBound: Double {
        max(budget, projected, spent) * 1.12
    }

    /// Build from a `BudgetStatusResponse`'s month + generated timestamp and the
    /// account totals. Returns `nil` when there is no budget to pace against or
    /// the month string can't be parsed.
    static func make(
        month: String,
        generatedAt: Date?,
        spent: Double,
        projected: Double,
        budget: Double,
        calendar: Calendar = .current
    ) -> SpendPace? {
        guard budget > 0 else { return nil }

        let parts = month.split(separator: "-")
        guard parts.count >= 2,
              let year = Int(parts[0]),
              let monthNumber = Int(parts[1]),
              (1...12).contains(monthNumber)
        else { return nil }

        var firstComponents = DateComponents()
        firstComponents.year = year
        firstComponents.month = monthNumber
        firstComponents.day = 1
        guard let firstOfMonth = calendar.date(from: firstComponents),
              let dayRange = calendar.range(of: .day, in: .month, for: firstOfMonth)
        else { return nil }

        let daysInMonth = dayRange.count

        var day = daysInMonth
        if let generatedAt {
            if generatedAt < firstOfMonth {
                day = 1
            } else {
                let comps = calendar.dateComponents([.year, .month, .day], from: generatedAt)
                if comps.year == year, comps.month == monthNumber, let d = comps.day {
                    day = d
                } else {
                    // Snapshot is from a later month — treat the month as complete.
                    day = daysInMonth
                }
            }
        }
        day = min(max(day, 1), daysInMonth)

        return SpendPace(
            daysInMonth: daysInMonth,
            currentDay: day,
            spent: spent,
            projected: max(projected, spent),
            budget: budget
        )
    }
}
