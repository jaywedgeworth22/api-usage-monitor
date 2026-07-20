import Foundation
import SwiftUI
import DesignSystem
import Models
#if canImport(UIKit)
import UIKit
#endif

// ---------------------------------------------------------------------------
// Pure, reusable presentation derivations for a `ProviderBudgetStatus`. Kept
// separate from the views so the money/percent/status → string logic can be
// unit-tested directly, and so the list row and the detail header stay in sync.
// ---------------------------------------------------------------------------

extension ProviderBudgetStatus {
    /// Design-system status for this provider's budget level.
    var semanticStatus: Theme.SemanticStatus { Theme.SemanticStatus(status) }

    /// The trailing value on a compact list row — month-to-date spend.
    var rowValue: String { CurrencyFormat.usd(spentUsd) }

    /// The small caption under the row value: utilisation for budgeted
    /// providers, otherwise a coverage/"no budget" note.
    var rowValueCaption: String {
        if hasBudget, let percentUsed {
            return CurrencyFormat.percent(percentUsed)
        }
        return "No budget"
    }

    /// A one-line human status used as the row subtitle.
    var rowSubtitle: String {
        switch status {
        case .exceeded:
            if let remainingUsd, remainingUsd < 0 {
                return "Over by \(CurrencyFormat.usd(abs(remainingUsd)))"
            }
            return "Over budget"
        case .warning:
            if let remainingUsd {
                return "\(CurrencyFormat.usd(remainingUsd)) left"
            }
            return "Approaching budget"
        case .ok:
            if let remainingUsd {
                return "\(CurrencyFormat.usd(remainingUsd)) left"
            }
            return "On track"
        case .unconfigured:
            return "Not budgeted · \(CurrencyFormat.usd(spentUsd)) spent"
        }
    }

    /// Short label for the header status badge.
    var statusLabel: String {
        switch status {
        case .exceeded: return "Over budget"
        case .warning: return "Approaching budget"
        case .ok: return "On track"
        case .unconfigured: return "No budget set"
        }
    }

    var statusSymbol: String {
        switch status {
        case .exceeded: return "exclamationmark.octagon.fill"
        case .warning: return "gauge.with.dots.needle.67percent"
        case .ok: return "checkmark.circle.fill"
        case .unconfigured: return "minus.circle"
        }
    }

    /// Meter fill fraction (spent ÷ budget). Falls back to `percentUsed` and
    /// finally to a computed ratio; `0` when no budget exists.
    var budgetFraction: Double {
        if let percentUsed { return percentUsed }
        guard let budget = monthlyBudgetUsd, budget > 0 else { return 0 }
        return spentUsd / budget
    }

    /// The individual spend components that make up `spentUsd`, largest first,
    /// dropping any that are zero. Used by the composition bar.
    var spendComponents: [SpendComponent] {
        let fixed = max(fixedAccruedUsd, 0) > 0 ? fixedAccruedUsd : fixedMonthlyCostUsd
        let raw: [SpendComponent] = [
            SpendComponent(kind: .variable, amount: observedVariableUsageUsd),
            SpendComponent(kind: .subscription, amount: subscriptionMonthToDateUsd),
            SpendComponent(kind: .fixed, amount: fixed),
        ]
        return raw.filter { $0.amount > 0.005 }.sorted { $0.amount > $1.amount }
    }

    /// Whether a subscription/renewal context is worth surfacing.
    var hasRenewalContext: Bool {
        subscriptionMonthToDateUsd > 0.005 || forecastedSubscriptionRenewalsUsd > 0.005
    }
}

/// One slice of a provider's month-to-date spend.
struct SpendComponent: Identifiable, Hashable {
    enum Kind: String {
        case variable, subscription, fixed

        var label: String {
            switch self {
            case .variable: return "Usage"
            case .subscription: return "Subscription"
            case .fixed: return "Fixed"
            }
        }

        var systemImage: String {
            switch self {
            case .variable: return "chart.bar.fill"
            case .subscription: return "arrow.triangle.2.circlepath"
            case .fixed: return "lock.fill"
            }
        }

        /// A stable, legible tint per component (design-system accent family).
        var color: Color {
            switch self {
            case .variable: return Theme.Colors.accent
            case .subscription: return Theme.Colors.warning
            case .fixed: return Theme.Colors.neutral
            }
        }
    }

    let kind: Kind
    let amount: Double

    var id: String { kind.rawValue }
    var label: String { kind.label }
}

// MARK: - Key / identifier masking

/// Masks a sensitive-looking identifier for display as `first6…last4`, the
/// convention the app uses to preview a provider key/id without revealing it in
/// full. Short values are masked defensively rather than shown whole.
enum KeyMask {
    static func preview(_ raw: String, first: Int = 6, last: Int = 4) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return "—" }
        // Not enough to safely reveal both ends without overlap → mask entirely.
        if value.count <= first + last {
            if value.count <= 4 { return String(repeating: "•", count: value.count) }
            let head = value.prefix(2)
            return "\(head)\(String(repeating: "•", count: value.count - 2))"
        }
        let head = value.prefix(first)
        let tail = value.suffix(last)
        return "\(head)…\(tail)"
    }
}

// MARK: - Haptics

/// Thin wrapper over UIKit feedback generators so the feature can add tasteful
/// haptics on key interactions. UIKit types are kept out of the signatures so
/// the module still compiles on non-UIKit platforms (where these are no-ops).
enum ProviderHaptics {
    /// A light selection tick — for changing filters/sort.
    static func selection() {
        #if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    /// A light impact — for confirming a row tap / navigation.
    static func tap() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}
