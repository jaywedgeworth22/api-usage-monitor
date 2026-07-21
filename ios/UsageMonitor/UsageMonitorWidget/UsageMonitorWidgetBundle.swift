import WidgetKit
import SwiftUI
import WidgetShared
import DesignSystem

/// The widget extension entry point. Owned jointly by the **WidgetShared** lane
/// (the data bridge, already built) and the **Widget UI** lane (these views).
///
/// The extension is deliberately model- and networking-free: it renders the
/// compact `WidgetSnapshot` the app persists to the shared app-group container
/// after every successful refresh, so the home-screen widget shows real,
/// recently-cached data even when the host app isn't running. When no snapshot
/// has been written yet (fresh install, signed-out) it falls back to the
/// deterministic `.placeholder`.
@main
struct UsageMonitorWidgetBundle: WidgetBundle {
    var body: some Widget {
        BudgetSummaryWidget()
    }
}

// MARK: - Deep link

/// Tapping the widget opens the app. The app target may route this URL (e.g. in
/// `.onOpenURL`) to the Overview tab; unhandled, it simply launches the app.
enum WidgetDeepLink {
    static let summary = URL(string: "usagemonitor://dashboard")
}

// MARK: - Timeline

struct BudgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct BudgetTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> BudgetEntry {
        BudgetEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (BudgetEntry) -> Void) {
        // In the gallery (`isPreview`) prefer the curated placeholder so the
        // widget always looks representative; otherwise show real cached data.
        let snapshot = context.isPreview
            ? .placeholder
            : (SharedStore.shared.read() ?? .empty)
        completion(BudgetEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BudgetEntry>) -> Void) {
        let snapshot = SharedStore.shared.read() ?? .empty
        let entry = BudgetEntry(date: Date(), snapshot: snapshot)
        // The app refreshes the snapshot on foreground / background fetch; the
        // widget just re-reads periodically. 30 min is a battery-safe cadence
        // that still keeps spend reasonably fresh through the day.
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())
            ?? Date().addingTimeInterval(1800)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Widget

struct BudgetSummaryWidget: Widget {
    let kind = "BudgetSummaryWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BudgetTimelineProvider()) { entry in
            BudgetWidgetView(snapshot: entry.snapshot)
                .containerBackground(Theme.Colors.background, for: .widget)
                .widgetURL(WidgetDeepLink.summary)
        }
        .configurationDisplayName("Budget")
        .description("Month-to-date spend and your top budgets.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Root view (family switch)

struct BudgetWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let snapshot: WidgetSnapshot

    var body: some View {
        switch family {
        case .systemMedium:
            MediumBudgetWidget(snapshot: snapshot)
        default:
            SmallBudgetWidget(snapshot: snapshot)
        }
    }
}

// MARK: - Shared summary column

/// The month-to-date hero: caption, big total, "of budget", overall meter, and
/// (only when off-track) a status badge. Reused by both families.
private struct BudgetSummaryColumn: View {
    let snapshot: WidgetSnapshot
    var showsBadge = true

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("This month")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)

            Text(CurrencyFormat.compactUSD(snapshot.totalSpentUsd))
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            if let caption = WidgetPresentation.budgetCaption(for: snapshot) {
                Text(caption)
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }

            if snapshot.totalBudgetUsd > 0 {
                BudgetMeter(
                    fraction: WidgetPresentation.fraction(
                        spent: snapshot.totalSpentUsd,
                        budget: snapshot.totalBudgetUsd
                    ),
                    status: WidgetPresentation.overallStatus(for: snapshot),
                    height: 8
                )
                .padding(.top, Theme.Spacing.xxs)
            }

            if showsBadge, let label = WidgetPresentation.overallLabel(for: snapshot) {
                StatusBadge(
                    label,
                    status: WidgetPresentation.overallStatus(for: snapshot),
                    systemImage: WidgetPresentation.overallSymbol(for: snapshot)
                )
                .padding(.top, Theme.Spacing.xxs)
            }
        }
    }
}

// MARK: - Small

private struct SmallBudgetWidget: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BudgetSummaryColumn(snapshot: snapshot)
            Spacer(minLength: 0)
            // Projected end-of-month gives the small widget a forward-looking
            // footer without crowding the hero.
            if snapshot.projectedEomUsd > 0 {
                Text("Proj. \(CurrencyFormat.compactUSD(snapshot.projectedEomUsd))")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Medium

private struct MediumBudgetWidget: View {
    let snapshot: WidgetSnapshot

    private var meters: [WidgetSnapshot.Meter] {
        Array(snapshot.topMeters.prefix(3))
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            BudgetSummaryColumn(snapshot: snapshot)
                .frame(maxWidth: .infinity, alignment: .leading)

            if meters.isEmpty {
                emptyMeters
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(meters) { meter in
                        LabeledBudgetMeter(
                            title: meter.name,
                            detail: WidgetPresentation.meterDetail(
                                spent: meter.spentUsd,
                                budget: meter.budgetUsd
                            ),
                            fraction: WidgetPresentation.fraction(
                                spent: meter.spentUsd,
                                budget: meter.budgetUsd
                            ),
                            status: WidgetPresentation.semanticStatus(forRawStatus: meter.status)
                        )
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var emptyMeters: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                .foregroundStyle(Theme.Colors.tertiaryText)
            Text("No budgets set")
                .font(Theme.Typography.callout.weight(.medium))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Configure provider budgets to track them here.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(date: .now, snapshot: .placeholder)
}

#Preview("Medium", as: .systemMedium) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(date: .now, snapshot: .placeholder)
}
