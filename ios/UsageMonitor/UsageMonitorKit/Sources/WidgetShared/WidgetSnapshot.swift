import Foundation

/// A compact, self-contained projection of budget status that the WidgetKit
/// extension can render without pulling in the app's full model/networking
/// stack. The app derives and persists this after every successful refresh.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Meter: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var spentUsd: Double
        public var budgetUsd: Double?
        public var percentUsed: Double?
        /// Raw status string: "ok" | "warning" | "exceeded" | "unconfigured".
        public var status: String

        public init(
            id: String,
            name: String,
            spentUsd: Double,
            budgetUsd: Double?,
            percentUsed: Double?,
            status: String
        ) {
            self.id = id
            self.name = name
            self.spentUsd = spentUsd
            self.budgetUsd = budgetUsd
            self.percentUsed = percentUsed
            self.status = status
        }
    }

    public var generatedAt: Date
    public var month: String
    public var totalSpentUsd: Double
    public var totalBudgetUsd: Double
    public var projectedEomUsd: Double
    public var percentUsed: Double?
    public var overBudget: Bool
    public var warning: Bool
    /// Highest-utilisation budget meters, already sorted, capped for widgets.
    public var topMeters: [Meter]

    public init(
        generatedAt: Date,
        month: String,
        totalSpentUsd: Double,
        totalBudgetUsd: Double,
        projectedEomUsd: Double,
        percentUsed: Double?,
        overBudget: Bool,
        warning: Bool,
        topMeters: [Meter]
    ) {
        self.generatedAt = generatedAt
        self.month = month
        self.totalSpentUsd = totalSpentUsd
        self.totalBudgetUsd = totalBudgetUsd
        self.projectedEomUsd = projectedEomUsd
        self.percentUsed = percentUsed
        self.overBudget = overBudget
        self.warning = warning
        self.topMeters = topMeters
    }

    /// Deterministic **gallery/preview** sample (never used as a live empty state).
    public static let placeholder = WidgetSnapshot(
        generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
        month: "2026-07",
        totalSpentUsd: 428.16,
        totalBudgetUsd: 900,
        projectedEomUsd: 690.40,
        percentUsed: 0.4757,
        overBudget: false,
        warning: true,
        topMeters: [
            Meter(id: "anthropic", name: "Anthropic", spentUsd: 212.4, budgetUsd: 250, percentUsed: 0.85, status: "warning"),
            Meter(id: "openai", name: "OpenAI", spentUsd: 96.2, budgetUsd: 200, percentUsed: 0.48, status: "ok"),
            Meter(id: "voyage", name: "Voyage", spentUsd: 61.0, budgetUsd: 150, percentUsed: 0.41, status: "ok")
        ]
    )

    /// Live empty state when no snapshot has been written (signed-out / fresh install).
    /// Zeros only — never fabricated spend that looks like real money.
    public static let empty = WidgetSnapshot(
        generatedAt: Date(timeIntervalSince1970: 0),
        month: "",
        totalSpentUsd: 0,
        totalBudgetUsd: 0,
        projectedEomUsd: 0,
        percentUsed: nil,
        overBudget: false,
        warning: false,
        topMeters: []
    )
}
