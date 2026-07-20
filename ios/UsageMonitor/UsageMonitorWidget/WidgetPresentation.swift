import Foundation
import DesignSystem
import WidgetShared

/// Pure, view-free presentation logic for the budget widget.
///
/// Kept deliberately separate from the SwiftUI views so the status mapping and
/// derivation math are unit-testable without a rendering context. This lane is
/// model- and networking-free by contract, so the raw status *string* carried
/// on `WidgetSnapshot.Meter` is mapped onto `Theme.SemanticStatus` here rather
/// than via AppCore's `Theme.SemanticStatus(_ level:)` bridge (which lives in a
/// layer the widget must not depend on).
enum WidgetPresentation {
    /// Map a raw `WidgetSnapshot.Meter.status` string onto the design system's
    /// semantic status. The raw values mirror the server's `BudgetLevel`:
    /// `"ok" | "warning" | "exceeded" | "unconfigured"`. Anything unexpected
    /// degrades to `.neutral` so a schema drift never crashes or mis-alarms.
    static func semanticStatus(forRawStatus raw: String) -> Theme.SemanticStatus {
        switch raw {
        case "exceeded": return .danger
        case "warning": return .warning
        case "ok": return .ok
        default: return .neutral // "unconfigured" or anything unrecognised
        }
    }

    /// Overall status for the summary hero, derived from the snapshot's flags.
    static func overallStatus(for snapshot: WidgetSnapshot) -> Theme.SemanticStatus {
        if snapshot.overBudget { return .danger }
        if snapshot.warning { return .warning }
        return snapshot.totalBudgetUsd > 0 ? .ok : .neutral
    }

    /// Short badge label for the overall summary, or `nil` when on-track (no
    /// badge shown so the small widget stays calm and uncluttered).
    static func overallLabel(for snapshot: WidgetSnapshot) -> String? {
        if snapshot.overBudget { return "Over budget" }
        if snapshot.warning { return "Approaching" }
        return nil
    }

    /// SF Symbol paired with `overallLabel`.
    static func overallSymbol(for snapshot: WidgetSnapshot) -> String {
        if snapshot.overBudget { return "exclamationmark.octagon.fill" }
        if snapshot.warning { return "gauge.with.dots.needle.67percent" }
        return "checkmark.circle.fill"
    }

    /// Fraction spent (spent ÷ budget). Returns `0` when there is no budget so
    /// the meter renders an empty track rather than a divide-by-zero.
    static func fraction(spent: Double, budget: Double?) -> Double {
        guard let budget, budget > 0 else { return 0 }
        return spent / budget
    }

    /// Compact `"$212 / $250"` detail for a meter row; drops the denominator
    /// when the provider has no configured budget.
    static func meterDetail(spent: Double, budget: Double?) -> String {
        if let budget, budget > 0 {
            return "\(CurrencyFormat.compactUSD(spent)) / \(CurrencyFormat.compactUSD(budget))"
        }
        return CurrencyFormat.compactUSD(spent)
    }

    /// `"of $900"` sub-caption under the hero total, or `nil` when unbudgeted.
    static func budgetCaption(for snapshot: WidgetSnapshot) -> String? {
        guard snapshot.totalBudgetUsd > 0 else { return nil }
        return "of \(CurrencyFormat.compactUSD(snapshot.totalBudgetUsd))"
    }
}
