import Foundation
import Models

/// Turns freshly-fetched provider alerts into local notifications — the piece
/// that finally connects the background refresh to the user's Lock Screen, so a
/// budget monitor actually tells you when you cross a threshold while you're not
/// looking at the app.
///
/// It sits on top of ``PushScaffold/scheduleAlertNotifications(for:minimumSeverity:)``
/// and adds the three things a real delivery loop needs:
///   1. **Gating** — respects the user's "Budget alerts" master toggle and their
///      minimum-severity choice, and only fires when notifications are actually
///      authorized.
///   2. **De-duplication across runs** — remembers which alerts it has already
///      notified about (persisted), so a background refresh every couple of
///      hours doesn't re-post the same "over budget on Anthropic" every time.
///      An alert that clears and later re-triggers *will* notify again.
///
/// Preferences live in `UserDefaults.standard` (shared within the app process,
/// readable from the background refresh task and writable from the Settings UI)
/// rather than the `@MainActor` `AppSettings`, so the background task can read
/// them without hopping actors or constructing app state.
public enum AlertNotifier {
    private static let enabledKey = "notifications.budgetAlertsEnabled"
    private static let minSeverityKey = "notifications.minimumSeverity"
    private static let deliveredKey = "notifications.deliveredAlertIDs"

    private static var defaults: UserDefaults { .standard }

    // MARK: Preferences

    /// Whether budget-alert notifications are enabled. Defaults to `true` so a
    /// user who grants permission starts receiving alerts without a second opt-in.
    public static var isEnabled: Bool {
        get { defaults.object(forKey: enabledKey) as? Bool ?? true }
        set { defaults.set(newValue, forKey: enabledKey) }
    }

    /// Lowest severity that should produce a notification. Defaults to `.warning`
    /// (info-level signals are non-interruptive and never notify).
    public static var minimumSeverity: AlertSeverity {
        get { AlertSeverity(rawValue: defaults.string(forKey: minSeverityKey) ?? "") ?? .warning }
        set { defaults.set(newValue.rawValue, forKey: minSeverityKey) }
    }

    // MARK: Delivery

    /// Deliver notifications for any newly-appeared alerts in `alerts`, deduped
    /// against what was delivered on previous runs. No-ops when disabled or when
    /// notifications aren't authorized. Returns the identifiers newly scheduled.
    @discardableResult
    public static func deliver(for alerts: [ProviderAlert]) async -> [String] {
        guard isEnabled else { return [] }

        let status = await PushScaffold.authorizationStatus()
        // `.authorized` and `.provisional` (quiet delivery) both permit posting.
        guard status == .authorized || status == .provisional else { return [] }

        let minimum = minimumSeverity
        let surfaced = alerts.filter { $0.severity.order <= minimum.order }
        let surfacedIDs = Set(surfaced.map(\.id))

        // Alerts we've already notified about; anything no longer surfaced is
        // pruned so a cleared-then-re-triggered alert can notify again.
        let previouslyDelivered = Set(defaults.stringArray(forKey: deliveredKey) ?? [])
        let fresh = surfaced.filter { !previouslyDelivered.contains($0.id) }

        // Record the current surfaced set as "delivered" regardless — this both
        // marks the fresh ones and prunes stale ids.
        defaults.set(Array(surfacedIDs), forKey: deliveredKey)

        guard !fresh.isEmpty else { return [] }
        return await PushScaffold.scheduleAlertNotifications(for: fresh, minimumSeverity: minimum)
    }

    /// Testing/reset hook: forget the delivered-alert history.
    public static func resetDeliveryHistory() {
        defaults.removeObject(forKey: deliveredKey)
    }
}
