import Foundation

// ---------------------------------------------------------------------------
// Deterministic sample data for SwiftUI previews, gallery entries, and unit
// tests. Every feature/integration target may reference these so previews
// render realistic content without a live network. They are `public` and
// stable — treat them as fixtures, not production data.
// ---------------------------------------------------------------------------

public extension ProviderAlert {
    static let sampleWarning = ProviderAlert(
        code: "budget_warning",
        severity: .warning,
        message: "Anthropic is at 85% of its $250 monthly budget."
    )
    static let sampleCritical = ProviderAlert(
        code: "budget_exceeded",
        severity: .critical,
        message: "OpenRouter has exceeded its $120 monthly budget."
    )
    static let sampleInfo = ProviderAlert(
        code: "billing_sync_incomplete",
        severity: .info,
        message: "Google Cloud Billing export is pending; spend coverage is incomplete."
    )
}

public extension ProviderBudgetStatus {
    static let sampleWarning = ProviderBudgetStatus(
        id: "prov_anthropic",
        name: "anthropic",
        displayName: "Anthropic",
        monthlyBudgetUsd: 250,
        fixedMonthlyCostUsd: 0,
        snapshotCostUsd: 212.40,
        snapshotCostFetchedAt: "2026-07-19T09:15:00.000Z",
        pushedMonthToDateUsd: 212.40,
        receiptCashPaidUsd: 0,
        observedVariableUsageUsd: 212.40,
        estimatedApiEquivalentUsd: 0,
        spendCoverage: .partial,
        subscriptionMonthToDateUsd: 0,
        fixedAccruedUsd: 0,
        forecastedSubscriptionRenewalsUsd: 0,
        spentUsd: 212.40,
        projectedEomUsd: 335.10,
        remainingUsd: 37.60,
        percentUsed: 0.8496,
        status: .warning,
        alerts: [.sampleWarning]
    )

    static let sampleOk = ProviderBudgetStatus(
        id: "prov_openai",
        name: "openai",
        displayName: "OpenAI",
        monthlyBudgetUsd: 200,
        snapshotCostUsd: 96.20,
        snapshotCostFetchedAt: "2026-07-19T09:15:00.000Z",
        pushedMonthToDateUsd: 96.20,
        observedVariableUsageUsd: 96.20,
        spendCoverage: .complete,
        spentUsd: 96.20,
        projectedEomUsd: 151.80,
        remainingUsd: 103.80,
        percentUsed: 0.481,
        status: .ok,
        alerts: []
    )

    static let sampleExceeded = ProviderBudgetStatus(
        id: "prov_openrouter",
        name: "openrouter",
        displayName: "OpenRouter",
        monthlyBudgetUsd: 120,
        snapshotCostUsd: 134.90,
        snapshotCostFetchedAt: "2026-07-19T09:15:00.000Z",
        pushedMonthToDateUsd: 134.90,
        observedVariableUsageUsd: 134.90,
        spendCoverage: .complete,
        spentUsd: 134.90,
        projectedEomUsd: 210.40,
        remainingUsd: -14.90,
        percentUsed: 1.124,
        status: .exceeded,
        alerts: [.sampleCritical]
    )

    static let sampleUnconfigured = ProviderBudgetStatus(
        id: "prov_voyage",
        name: "voyage",
        displayName: "Voyage AI",
        monthlyBudgetUsd: nil,
        pushedMonthToDateUsd: 18.05,
        observedVariableUsageUsd: 18.05,
        spendCoverage: .partial,
        spentUsd: 18.05,
        projectedEomUsd: 28.40,
        status: .unconfigured,
        alerts: [.sampleInfo]
    )

    static let sampleList: [ProviderBudgetStatus] = [
        .sampleExceeded, .sampleWarning, .sampleOk, .sampleUnconfigured,
    ]
}

public extension ProjectBudgetStatus {
    static let sampleTrade = ProjectBudgetStatus(
        id: "proj_socratic",
        name: "Socratic Trade",
        description: "Cost-aware trading feedback loop",
        monthlyBudgetUsd: 400,
        spentUsd: 246.80,
        projectedEomUsd: 388.00,
        spendCoverage: .partial,
        directUsd: 201.30,
        allocatedUsd: 45.50,
        incompleteAllocatedProviderCount: 1,
        remainingUsd: 153.20,
        percentUsed: 0.617,
        status: .warning
    )

    static let sampleMonitor = ProjectBudgetStatus(
        id: "proj_monitor",
        name: "Usage Monitor",
        description: "Internal tooling",
        monthlyBudgetUsd: 150,
        spentUsd: 41.10,
        projectedEomUsd: 64.90,
        spendCoverage: .complete,
        directUsd: 41.10,
        allocatedUsd: 0,
        remainingUsd: 108.90,
        percentUsed: 0.274,
        status: .ok
    )

    static let sampleList: [ProjectBudgetStatus] = [.sampleTrade, .sampleMonitor]
}

public extension BudgetSummary {
    static let sample = BudgetSummary(
        totalBudgetUsd: 570,
        budgetedSpentUsd: 443.50,
        unbudgetedSpentUsd: 18.05,
        unassignedSpentUsd: 0,
        totalSpentUsd: 461.55,
        estimatedApiEquivalentUsd: 512.30,
        remainingUsd: 126.50,
        percentUsed: 0.778,
        overBudget: true,
        warning: true
    )
}

public extension BudgetStatusResponse {
    static let sample = BudgetStatusResponse(
        ok: true,
        generatedAt: "2026-07-19T09:15:00.000Z",
        month: "2026-07",
        providers: ProviderBudgetStatus.sampleList,
        projects: ProjectBudgetStatus.sampleList,
        summary: .sample
    )

    /// An all-clear response for empty/first-run previews.
    static let sampleEmpty = BudgetStatusResponse(
        ok: true,
        generatedAt: "2026-07-19T09:15:00.000Z",
        month: "2026-07",
        providers: [],
        projects: [],
        summary: BudgetSummary(
            totalBudgetUsd: 0,
            budgetedSpentUsd: 0,
            unbudgetedSpentUsd: 0,
            totalSpentUsd: 0,
            estimatedApiEquivalentUsd: 0,
            remainingUsd: 0,
            percentUsed: nil,
            overBudget: false,
            warning: false
        )
    )
}

public extension SubscriptionSummary {
    static let sampleClaude = SubscriptionSummary(
        id: "sub_claude_max",
        name: "Claude Max",
        description: "Anthropic Claude Max plan",
        costUsd: 100,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        monthlyEquivalentUsd: 100,
        anchorDay: 7,
        startDate: "2026-01-07T00:00:00.000Z",
        currentPeriodStart: "2026-07-07T00:00:00.000Z",
        nextRenewalAt: "2026-08-07T00:00:00.000Z",
        autoRenew: true,
        status: "active",
        effectiveStatus: "active",
        provider: .init(id: "prov_anthropic", name: "anthropic", displayName: "Anthropic"),
        project: .init(id: "proj_socratic", name: "Socratic Trade")
    )

    static let sampleCursor = SubscriptionSummary(
        id: "sub_cursor",
        name: "Cursor Pro",
        costUsd: 240,
        currency: "USD",
        interval: "yearly",
        intervalCount: 1,
        monthlyEquivalentUsd: 20,
        startDate: "2026-03-01T00:00:00.000Z",
        currentPeriodStart: "2026-03-01T00:00:00.000Z",
        nextRenewalAt: "2027-03-01T00:00:00.000Z",
        autoRenew: true,
        status: "active",
        effectiveStatus: "active",
        provider: .init(id: "prov_cursor", name: "cursor", displayName: "Cursor")
    )

    static let sampleList: [SubscriptionSummary] = [.sampleClaude, .sampleCursor]
}

public extension ServerHealth {
    static let sample = ServerHealth(
        ok: true,
        status: "live",
        uptimeSeconds: 84_213,
        checkedAt: "2026-07-19T09:15:00.000Z",
        service: "api-usage-monitor",
        version: "1.0.0",
        commit: "c747e892"
    )
}

public extension ServerReadiness {
    static let sample = ServerReadiness(
        ok: true,
        status: "ready",
        checkedAt: "2026-07-19T09:15:00.000Z",
        checks: Checks(
            database: Check(ok: true, latencyMs: 3.2),
            scheduler: Check(ok: true),
            backup: Check(ok: true),
            startup: Check(ok: true)
        )
    )
}
