import Foundation
import Observation
import Models
import Networking

/// The single owner of the app's `GET /api/budget-status` data.
///
/// One fetch fans out to four features — Dashboard, Providers, Alerts, and
/// Project budgets all read this shared store rather than each hitting the
/// network. Inject it via `@Environment(AppEnvironment.self).budgetStore` (or
/// the directly-provided `@Environment(BudgetStore.self)`); never construct
/// your own `APIClient` call for budget status.
///
/// ## Lifecycle for feature roots
///   - `.task { await store.loadIfNeeded() }` on first appear.
///   - Wrap content in `RefreshableScrollView { await store.refresh() }` for
///     pull-to-refresh.
///   - Render from ``state`` (`LoadState`): skeleton while
///     `state.isInitialLoading`, `ErrorState` on `state.error`, content on
///     `state.value`. On a refresh failure over existing data the prior data
///     is kept and ``lastError`` is set (surface a non-blocking banner).
@MainActor
@Observable
public final class BudgetStore {
    /// The four-phase load state of the budget response.
    public private(set) var state: LoadState<BudgetStatusResponse> = .idle

    /// When the currently-held data was produced (server `generatedAt` for a
    /// cached first paint, otherwise the successful fetch time).
    public private(set) var lastUpdated: Date?

    /// A refresh error that occurred while data was already on screen. `state`
    /// stays `.loaded`; features show this as a transient banner, not a
    /// full-screen error.
    public private(set) var lastError: APIError?

    private var apiClient: APIClient
    private let sink: BudgetSnapshotSink

    public init(apiClient: APIClient, sink: BudgetSnapshotSink = NullBudgetSnapshotSink()) {
        self.apiClient = apiClient
        self.sink = sink
    }

    /// Swap in a new client after a host change (called by `AppEnvironment`).
    func replaceClient(_ client: APIClient) {
        self.apiClient = client
    }

    // MARK: - Derived accessors (nil-safe; empty when unloaded)

    public var response: BudgetStatusResponse? { state.value }
    public var providers: [ProviderBudgetStatus] { state.value?.providers ?? [] }
    public var projects: [ProjectBudgetStatus] { state.value?.projects ?? [] }
    public var summary: BudgetSummary? { state.value?.summary }

    /// Every provider alert flattened with its owning provider, sorted most
    /// severe first — the Alerts feature's primary data source.
    public var alertItems: [ProviderAlertItem] {
        providers
            .flatMap { provider in provider.alerts.map { ProviderAlertItem(provider: provider, alert: $0) } }
            .sorted { $0.alert.severity.order < $1.alert.severity.order }
    }

    // MARK: - Loading

    /// Fetch once if nothing has been requested yet. Safe to call on every
    /// appear.
    public func loadIfNeeded() async {
        if case .idle = state { await load() }
    }

    /// Full load: paint cached data immediately (offline-first) if present,
    /// then fetch fresh.
    public func load() async {
        if state.value == nil {
            state = .loading
            if let cached = await sink.loadCached() {
                state = .loaded(cached)
                lastUpdated = cached.generatedAtDate ?? lastUpdated
            }
        }
        await fetch()
    }

    /// Pull-to-refresh: fetch without dropping existing data on failure.
    public func refresh() async {
        await fetch()
    }

    private func fetch() async {
        do {
            let response = try await apiClient.budgetStatus()
            state = .loaded(response)
            lastUpdated = Date()
            lastError = nil
            await sink.store(response)
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func handle(_ error: APIError) {
        if state.value == nil {
            state = .failed(error)
        } else {
            // Keep stale-but-useful data on screen; surface the error softly.
            lastError = error
        }
    }
}

/// One provider alert paired with the provider it belongs to. Stable identity
/// for SwiftUI lists across refreshes.
public struct ProviderAlertItem: Identifiable, Hashable, Sendable {
    public let provider: ProviderBudgetStatus
    public let alert: ProviderAlert

    public init(provider: ProviderBudgetStatus, alert: ProviderAlert) {
        self.provider = provider
        self.alert = alert
    }

    public var id: String { "\(provider.id)|\(alert.id)" }
}
