import SwiftUI
import AppCore
import DesignSystem
import Models

/// Typed navigation value for pushing a provider detail. Carrying only the id
/// keeps navigation state small and lets the detail re-resolve the *current*
/// provider from the shared store after a refresh.
struct ProviderRoute: Hashable {
    let id: String
}

/// Per-provider budget detail. Built entirely from the `ProviderBudgetStatus`
/// already present in the shared `BudgetStore` response — there is no
/// per-provider fetch (`GET /api/providers/{id}` is session-gated and not
/// reachable by the app's bearer token; see the architecture contract).
struct ProviderDetailView: View {
    let route: ProviderRoute
    @Environment(BudgetStore.self) private var store

    /// Always resolve from the live store so a pull-to-refresh updates the
    /// numbers in place.
    private var provider: ProviderBudgetStatus? {
        store.providers.first { $0.id == route.id }
    }

    var body: some View {
        Group {
            if let provider {
                content(for: provider)
            } else {
                EmptyState(
                    systemImage: "questionmark.square.dashed",
                    title: "Provider unavailable",
                    message: "This provider is no longer in the latest budget report."
                )
                .frame(maxHeight: .infinity)
                .dsScreenBackground()
            }
        }
        .navigationTitle(provider?.title ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.loadIfNeeded() }
    }

    @ViewBuilder
    private func content(for provider: ProviderBudgetStatus) -> some View {
        RefreshableScrollView(onRefresh: { await store.refresh() }) {
            header(provider)
            if store.lastError != nil {
                refreshBanner
            }
            budgetCard(provider)
            statGrid(provider)
            if !provider.spendComponents.isEmpty {
                compositionCard(provider)
            }
            paceCard(provider)
            if provider.hasRenewalContext {
                renewalCard(provider)
            }
            dataQualityCard(provider)
            identifierCard(provider)
            if !provider.alerts.isEmpty {
                alertsSection(provider)
            }
        }
    }

    // MARK: - Header

    private func header(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.md) {
                Text(provider.title.prefix(1).uppercased())
                    .font(.title2.weight(.bold))
                    .foregroundStyle(provider.semanticStatus == .neutral ? Theme.Colors.accent : provider.semanticStatus.tint)
                    .frame(width: 52, height: 52)
                    .background(
                        (provider.semanticStatus == .neutral ? Theme.Colors.accentSoft : provider.semanticStatus.wash),
                        in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    )
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(provider.title)
                        .font(Theme.Typography.title)
                        .foregroundStyle(Theme.Colors.primaryText)
                        .lineLimit(1)
                    Text(provider.spentUsd, format: .currency(code: "USD"))
                        .font(Theme.Typography.hero)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                        .accessibilityLabel("Spent this month, \(CurrencyFormat.usd(provider.spentUsd))")
                }
            }

            HStack(spacing: Theme.Spacing.sm) {
                StatusBadge(provider.statusLabel, status: provider.semanticStatus, systemImage: provider.statusSymbol)
                if !provider.spendCoverage.isComplete {
                    StatusBadge(provider.spendCoverage.label, status: .init(coverage: provider.spendCoverage), systemImage: "chart.pie")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var refreshBanner: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "wifi.exclamationmark")
            Text("Showing last loaded data — refresh failed.")
                .font(Theme.Typography.caption)
            Spacer()
        }
        .foregroundStyle(Theme.Colors.warning)
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Budget

    @ViewBuilder
    private func budgetCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Budget", subtitle: provider.hasBudget ? "Month to date" : nil)
            if provider.hasBudget, let budget = provider.monthlyBudgetUsd {
                LabeledBudgetMeter(
                    title: provider.hasBudget ? "\(CurrencyFormat.percent(provider.budgetFraction)) used" : "Spend",
                    detail: "\(CurrencyFormat.usd(provider.spentUsd)) / \(CurrencyFormat.usd(budget))",
                    fraction: provider.budgetFraction,
                    status: provider.semanticStatus
                )
            } else {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "minus.circle")
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Text("No monthly budget configured for this provider.")
                        .font(Theme.Typography.callout)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Stat grid

    private func statGrid(_ provider: ProviderBudgetStatus) -> some View {
        LazyVGrid(
            columns: [GridItem(.flexible()), GridItem(.flexible())],
            spacing: Theme.Spacing.md
        ) {
            StatTile(
                label: "Spent",
                value: CurrencyFormat.usd(provider.spentUsd),
                secondary: "this month",
                systemImage: "creditcard.fill"
            )
            StatTile(
                label: "Projected",
                value: CurrencyFormat.usd(provider.projectedEomUsd),
                secondary: "end of month",
                systemImage: "chart.line.uptrend.xyaxis",
                status: projectionStatus(provider)
            )
            if let remaining = provider.remainingUsd {
                StatTile(
                    label: remaining < 0 ? "Over by" : "Remaining",
                    value: CurrencyFormat.usd(abs(remaining)),
                    secondary: provider.hasBudget ? "of budget" : nil,
                    systemImage: remaining < 0 ? "exclamationmark.triangle.fill" : "banknote",
                    status: remaining < 0 ? .danger : .ok
                )
            }
            if provider.hasBudget, let percent = provider.percentUsed {
                StatTile(
                    label: "Utilisation",
                    value: CurrencyFormat.percent(percent),
                    secondary: "of budget",
                    systemImage: "gauge.with.dots.needle.67percent",
                    status: provider.semanticStatus
                )
            } else if provider.estimatedApiEquivalentUsd > 0 {
                StatTile(
                    label: "API-equivalent",
                    value: CurrencyFormat.usd(provider.estimatedApiEquivalentUsd),
                    secondary: "list-price value",
                    systemImage: "tag.fill"
                )
            }
        }
    }

    /// Warn when the run-rate projects meaningfully past budget.
    private func projectionStatus(_ provider: ProviderBudgetStatus) -> Theme.SemanticStatus {
        guard let budget = provider.monthlyBudgetUsd, budget > 0 else { return .neutral }
        if provider.projectedEomUsd > budget { return .danger }
        if provider.projectedEomUsd > budget * 0.9 { return .warning }
        return .ok
    }

    // MARK: - Composition

    private func compositionCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Spend breakdown", subtitle: "How this month's \(CurrencyFormat.usd(provider.spentUsd)) is made up")
            SpendCompositionBar(components: provider.spendComponents)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Pace / projection

    private func paceCard(_ provider: ProviderBudgetStatus) -> some View {
        let points = pacePoints(spent: provider.spentUsd, projected: provider.projectedEomUsd)
        let deltaCaption: String? = {
            guard provider.projectedEomUsd > 0 else { return nil }
            let pct = (provider.projectedEomUsd - provider.spentUsd) / max(provider.spentUsd, 0.01)
            return "+\(CurrencyFormat.percent(pct)) to EOM"
        }()
        return SparklineCard(
            title: "Pace to month-end",
            value: CurrencyFormat.usd(provider.projectedEomUsd),
            caption: deltaCaption,
            points: points,
            status: projectionStatus(provider)
        )
    }

    /// Synthesise a cumulative-spend pace curve for the current month: linear to
    /// today at the observed run-rate, then extrapolated to the projected
    /// end-of-month figure. There is no per-day series in the model, so this is
    /// an at-pace illustration, not billed history.
    private func pacePoints(spent: Double, projected: Double) -> [Double] {
        let calendar = Calendar.current
        let now = Date()
        let day = calendar.component(.day, from: now)
        let range = calendar.range(of: .day, in: .month, for: now)
        let daysInMonth = range?.count ?? 30
        guard day >= 1, daysInMonth >= day, spent >= 0 else { return [0, spent, projected] }

        let dailyToDate = spent / Double(day)
        var points: [Double] = []
        for d in 1...day { points.append(dailyToDate * Double(d)) }
        if day < daysInMonth {
            let remainingDays = daysInMonth - day
            let dailyProjected = (projected - spent) / Double(remainingDays)
            for d in 1...remainingDays { points.append(spent + dailyProjected * Double(d)) }
        }
        return points
    }

    // MARK: - Renewal

    private func renewalCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Subscriptions & renewals")
            if provider.subscriptionMonthToDateUsd > 0.005 {
                DetailStatRow(label: "Subscription this month", value: CurrencyFormat.usd(provider.subscriptionMonthToDateUsd))
            }
            if provider.forecastedSubscriptionRenewalsUsd > 0.005 {
                DetailStatRow(label: "Forecast renewals", value: CurrencyFormat.usd(provider.forecastedSubscriptionRenewalsUsd))
            }
            if provider.fixedMonthlyCostUsd > 0.005 {
                DetailStatRow(label: "Fixed monthly cost", value: CurrencyFormat.usd(provider.fixedMonthlyCostUsd))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Data quality

    private func dataQualityCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Data quality")
            DetailStatRow(
                label: "Spend coverage",
                value: provider.spendCoverage.label,
                valueStatus: .init(coverage: provider.spendCoverage),
                monospaced: false
            )
            if provider.pushedMonthToDateUsd > 0.005 {
                DetailStatRow(label: "Reported (pushed)", value: CurrencyFormat.usd(provider.pushedMonthToDateUsd))
            }
            if provider.receiptCashPaidUsd > 0.005 {
                DetailStatRow(label: "Cash paid (receipts)", value: CurrencyFormat.usd(provider.receiptCashPaidUsd))
            }
            if provider.estimatedApiEquivalentUsd > 0.005 {
                DetailStatRow(label: "API-equivalent value", value: CurrencyFormat.usd(provider.estimatedApiEquivalentUsd))
            }
            if let fetched = provider.snapshotFetchedDate {
                DetailStatRow(
                    label: "Snapshot updated",
                    value: fetched.formatted(.relative(presentation: .named)),
                    monospaced: false
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Identifier (masked key preview)

    private func identifierCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Identifier")
            DetailStatRow(label: "Slug", value: provider.name, monospaced: false)
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
                Text("Key preview")
                    .font(Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer(minLength: Theme.Spacing.sm)
                Text(KeyMask.preview(provider.id))
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(Theme.Colors.primaryText)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Key preview, \(KeyMask.preview(provider.id))")
            Text("Masked as first-6…last-4. The full key is never exposed to the app.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Alerts

    private func alertsSection(_ provider: ProviderBudgetStatus) -> some View {
        let alerts = provider.alerts.sorted { $0.severity.order < $1.severity.order }
        return VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Alerts") {
                Text("\(alerts.count)")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(alerts) { alert in
                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                        Image(systemName: alert.symbolName)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Theme.SemanticStatus(alert.severity).tint)
                            .frame(width: 26)
                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                            Text(alert.title)
                                .font(Theme.Typography.callout.weight(.semibold))
                                .foregroundStyle(Theme.Colors.primaryText)
                            Text(alert.message)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(alert.title). \(alert.message)")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Detail — over budget (light)") {
    ProviderDetailPreviewHost(provider: .sampleExceeded)
        .preferredColorScheme(.light)
}

#Preview("Detail — warning (dark)") {
    ProviderDetailPreviewHost(provider: .sampleWarning)
        .preferredColorScheme(.dark)
}

#Preview("Detail — no budget") {
    ProviderDetailPreviewHost(provider: .sampleUnconfigured)
}

/// Preview host that seeds a real `BudgetStore` with a single provider (through
/// the stubbed network path) so the detail resolves it by id.
private struct ProviderDetailPreviewHost: View {
    let provider: ProviderBudgetStatus
    @State private var store: BudgetStore

    init(provider: ProviderBudgetStatus) {
        self.provider = provider
        _store = State(initialValue: ProviderPreview.store(
            with: BudgetStatusResponse(
                ok: true,
                generatedAt: "2026-07-19T09:15:00.000Z",
                month: "2026-07",
                providers: [provider],
                summary: .sample
            )
        ))
    }

    var body: some View {
        NavigationStack {
            ProviderDetailView(route: ProviderRoute(id: provider.id))
                .environment(store)
        }
    }
}
#endif
