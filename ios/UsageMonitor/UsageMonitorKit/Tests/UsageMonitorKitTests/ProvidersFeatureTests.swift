import XCTest
@testable import Models
@testable import Providers
import DesignSystem

/// Providers-lane tests: the pure query (search/filter/sort) transform, the
/// money/percent/status presentation derivations, key masking, and the list
/// view-model. All run against `PreviewFixtures` sample data — no network.
///
/// NOTE FOR ASSEMBLE: the `UsageMonitorKitTests` target must depend on
/// `"Providers"` for `@testable import Providers` to resolve. Add it to that
/// test target's dependencies array in `Package.swift`.
final class ProvidersQueryTests: XCTestCase {
    private let all = ProviderBudgetStatus.sampleList  // [exceeded, warning, ok, unconfigured]

    // MARK: - Search

    func testSearchMatchesTitleAndNameCaseInsensitively() {
        var q = ProvidersQuery()
        q.searchText = "OPEN"
        let titles = q.apply(to: all).map(\.title)
        XCTAssertEqual(Set(titles), ["OpenAI", "OpenRouter"])
    }

    func testSearchByProviderSlug() {
        var q = ProvidersQuery()
        q.searchText = "voyage"
        XCTAssertEqual(q.apply(to: all).map(\.title), ["Voyage AI"])
    }

    func testEmptySearchReturnsEverything() {
        let q = ProvidersQuery()
        XCTAssertEqual(q.apply(to: all).count, all.count)
    }

    // MARK: - Filter

    func testFacetFiltering() {
        XCTAssertEqual(applyFilter(.overBudget).map(\.title), ["OpenRouter"])
        XCTAssertEqual(applyFilter(.attention).map(\.title), ["Anthropic"])
        XCTAssertEqual(applyFilter(.onTrack).map(\.title), ["OpenAI"])
        XCTAssertEqual(applyFilter(.noBudget).map(\.title), ["Voyage AI"])
        XCTAssertEqual(applyFilter(.all).count, 4)
    }

    private func applyFilter(_ f: ProviderFilter) -> [ProviderBudgetStatus] {
        var q = ProvidersQuery()
        q.filter = f
        return q.apply(to: all)
    }

    // MARK: - Sort

    func testStatusSortIsMostSevereFirst() {
        var q = ProvidersQuery(); q.sort = .status
        XCTAssertEqual(q.apply(to: all).map(\.status), [.exceeded, .warning, .ok, .unconfigured])
    }

    func testSpendSortDescending() {
        var q = ProvidersQuery(); q.sort = .spend
        XCTAssertEqual(q.apply(to: all).map(\.title), ["Anthropic", "OpenRouter", "OpenAI", "Voyage AI"])
    }

    func testUtilisationSortPushesUnbudgetedLast() {
        var q = ProvidersQuery(); q.sort = .utilisation
        XCTAssertEqual(q.apply(to: all).map(\.title), ["OpenRouter", "Anthropic", "OpenAI", "Voyage AI"])
    }

    func testNameSortAlphabetical() {
        var q = ProvidersQuery(); q.sort = .name
        XCTAssertEqual(q.apply(to: all).map(\.title), ["Anthropic", "OpenAI", "OpenRouter", "Voyage AI"])
    }

    func testSearchFilterSortCompose() {
        var q = ProvidersQuery()
        q.searchText = "open"
        q.sort = .name
        XCTAssertEqual(q.apply(to: all).map(\.title), ["OpenAI", "OpenRouter"])
    }
}

final class ProviderPresentationTests: XCTestCase {

    func testRowValueCaption() {
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.rowValueCaption, "48%")
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.rowValueCaption, "No budget")
    }

    func testRowSubtitleReflectsStatus() {
        XCTAssertEqual(ProviderBudgetStatus.sampleExceeded.rowSubtitle, "Over by $14.90")
        XCTAssertEqual(ProviderBudgetStatus.sampleWarning.rowSubtitle, "$37.60 left")
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.rowSubtitle, "$103.80 left")
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.rowSubtitle, "Not budgeted · $18.05 spent")
    }

    func testSemanticStatusMapping() {
        XCTAssertEqual(ProviderBudgetStatus.sampleExceeded.semanticStatus, .danger)
        XCTAssertEqual(ProviderBudgetStatus.sampleWarning.semanticStatus, .warning)
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.semanticStatus, .ok)
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.semanticStatus, .neutral)
    }

    func testBudgetFractionPrefersPercentThenComputesThenZero() {
        // Uses percentUsed directly.
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.budgetFraction, 0.481, accuracy: 0.0001)
        // Computes spent/budget when percentUsed is nil but a budget exists.
        let computed = ProviderBudgetStatus(
            id: "p", name: "p", displayName: "P",
            monthlyBudgetUsd: 100, spentUsd: 50, percentUsed: nil, status: .ok
        )
        XCTAssertEqual(computed.budgetFraction, 0.5, accuracy: 0.0001)
        // Zero without a budget.
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.budgetFraction, 0, accuracy: 0.0001)
    }

    func testSpendComponentsDropZerosAndSortDescending() {
        let p = ProviderBudgetStatus(
            id: "p", name: "p", displayName: "P",
            fixedMonthlyCostUsd: 0,
            observedVariableUsageUsd: 60,
            subscriptionMonthToDateUsd: 30,
            fixedAccruedUsd: 10,
            spentUsd: 100
        )
        let comps = p.spendComponents
        XCTAssertEqual(comps.map(\.kind), [.variable, .subscription, .fixed])
        XCTAssertEqual(comps.map(\.amount), [60, 30, 10])

        // A provider whose only spend is variable yields a single slice.
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.spendComponents.map(\.kind), [.variable])
    }

    func testHasRenewalContext() {
        let sub = ProviderBudgetStatus(
            id: "p", name: "p", displayName: "P",
            subscriptionMonthToDateUsd: 30, spentUsd: 30
        )
        XCTAssertTrue(sub.hasRenewalContext)
        XCTAssertFalse(ProviderBudgetStatus.sampleOk.hasRenewalContext)
    }
}

final class KeyMaskTests: XCTestCase {
    func testLongIdentifierShowsFirst6Last4() {
        XCTAssertEqual(KeyMask.preview("prov_openrouter"), "prov_o…uter")
    }

    func testShortIdentifierIsMaskedNotRevealed() {
        XCTAssertEqual(KeyMask.preview("abcd"), "••••")
        XCTAssertEqual(KeyMask.preview("abcdefg"), "ab•••••")
    }

    func testEmptyIdentifier() {
        XCTAssertEqual(KeyMask.preview("   "), "—")
    }
}

@MainActor
final class ProvidersListModelTests: XCTestCase {
    func testResultsReflectSearchAndFilter() {
        let model = ProvidersListModel()
        model.filter = .overBudget
        XCTAssertEqual(model.results(from: ProviderBudgetStatus.sampleList).map(\.title), ["OpenRouter"])
        XCTAssertTrue(model.isFiltering)
    }

    func testFacetCountsIgnoreSearchText() {
        let model = ProvidersListModel()
        model.searchText = "nonsense-that-matches-nothing"
        XCTAssertEqual(model.count(for: .overBudget, in: ProviderBudgetStatus.sampleList), 1)
        XCTAssertEqual(model.count(for: .all, in: ProviderBudgetStatus.sampleList), 4)
    }

    func testResetClearsSearchAndFilter() {
        let model = ProvidersListModel()
        model.searchText = "open"
        model.filter = .attention
        model.reset()
        XCTAssertEqual(model.searchText, "")
        XCTAssertEqual(model.filter, .all)
        XCTAssertFalse(model.isFiltering)
    }
}
