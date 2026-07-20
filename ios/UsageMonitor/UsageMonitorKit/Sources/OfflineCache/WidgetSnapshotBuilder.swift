import Foundation
import Models
import WidgetShared

/// Derives the compact `WidgetShared.WidgetSnapshot` from a full
/// `BudgetStatusResponse`. Owned by the **OfflineCache** lane (it already
/// depends on both `Models` and `WidgetShared`). Working starter — the lane may
/// refine meter selection, ordering, or add per-project rollups.
public enum WidgetSnapshotBuilder {
    /// Build a snapshot capturing the summary plus the highest-utilisation
    /// budgeted providers.
    /// - Parameter maxMeters: how many provider meters to keep for the widget.
    public static func snapshot(from response: BudgetStatusResponse, maxMeters: Int = 3) -> WidgetSnapshot {
        let summary = response.summary

        let meters: [WidgetSnapshot.Meter] = response.providers
            .filter { $0.hasBudget }
            .sorted { ($0.percentUsed ?? 0) > ($1.percentUsed ?? 0) }
            .prefix(maxMeters)
            .map { provider in
                WidgetSnapshot.Meter(
                    id: provider.id,
                    name: provider.title,
                    spentUsd: provider.spentUsd,
                    budgetUsd: provider.monthlyBudgetUsd,
                    percentUsed: provider.percentUsed,
                    status: provider.status.rawValue
                )
            }

        return WidgetSnapshot(
            generatedAt: response.generatedAtDate ?? Date(),
            month: response.month,
            totalSpentUsd: summary.totalSpentUsd,
            totalBudgetUsd: summary.totalBudgetUsd,
            projectedEomUsd: response.providers.reduce(0) { $0 + $1.projectedEomUsd },
            percentUsed: summary.percentUsed,
            overBudget: summary.overBudget,
            warning: summary.warning,
            topMeters: meters
        )
    }
}
