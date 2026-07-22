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

    /// Whether budget-alert notifications are enabled. Defaults to `false` so
    /// the first notification prompt always follows an explicit, contextual opt-in.
    public static var isEnabled: Bool {
        get { defaults.object(forKey: enabledKey) as? Bool ?? false }
        set { defaults.set(newValue, forKey: enabledKey) }
    }

    /// Lowest severity that should produce a notification. Defaults to `.warning`
    /// (info-level signals are non-interruptive and never notify).
    public static var minimumSeverity: AlertSeverity {
        get { AlertSeverity(rawValue: defaults.string(forKey: minSeverityKey) ?? "") ?? .warning }
        set { defaults.set(newValue.rawValue, forKey: minSeverityKey) }
    }

    // MARK: Delivery

    /// Deliver notifications for any newly-appeared **provider-scoped** alerts.
    @discardableResult
    public static func deliver(
        for items: [(providerTitle: String, providerId: String, alert: ProviderAlert)]
    ) async -> [String] {
        guard isEnabled else { return [] }

        let status = await PushScaffold.authorizationStatus()
        guard status == .authorized || status == .provisional else { return [] }

        let minimum = minimumSeverity
        let surfaced = items.filter { $0.alert.severity.order <= minimum.order }
        // Provider-scoped identity so two providers with the same alert code
        // do not suppress each other.
        let surfacedIDs = Set(surfaced.map { "\($0.providerId)|\($0.alert.id)" })

        let previouslyDelivered = Set(defaults.stringArray(forKey: deliveredKey) ?? [])
        let fresh = surfaced.filter {
            !previouslyDelivered.contains("\($0.providerId)|\($0.alert.id)")
        }

        defaults.set(Array(surfacedIDs), forKey: deliveredKey)

        guard !fresh.isEmpty else { return [] }
        return await PushScaffold.scheduleAlertNotifications(
            for: fresh,
            minimumSeverity: minimum
        )
    }

    /// Flat-alert convenience (no provider identity) — prefer the tuple overload.
    @discardableResult
    public static func deliver(for alerts: [ProviderAlert]) async -> [String] {
        await deliver(for: alerts.map {
            (providerTitle: $0.title, providerId: "unknown", alert: $0)
        })
    }

    /// Testing/reset hook: forget the delivered-alert history.
    public static func resetDeliveryHistory() {
        defaults.removeObject(forKey: deliveredKey)
    }
}
