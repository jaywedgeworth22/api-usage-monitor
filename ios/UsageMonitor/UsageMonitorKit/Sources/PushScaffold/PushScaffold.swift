import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif
import Models

/// Public entry point for the **PushScaffold** lane: the client-side plumbing
/// for `UserNotifications` + APNs so budget/alert notifications can be
/// delivered and their taps routed to the right screen. Depends only on
/// `AppCore` + `Models`.
///
/// Scope (see ARCHITECTURE-CONTRACT.md):
///   - `requestAuthorization()` — asks for alert/badge/sound permission.
///   - `registerForRemoteNotifications()` — triggers APNs device-token
///     registration (the app forwards the token via `setAPNsDeviceToken(_:)`).
///   - `configureNotificationCategories()` — registers the alert category so a
///     tapped notification carries a routable action.
///   - `scheduleAlertNotifications(for:)` — client-side local notifications
///     built from `[ProviderAlert]`, usable *before* any server push exists.
///   - Tap routing lives in `PushRouter` + `PushNotificationDelegate`.
///
/// **Server-side APNs delivery is a documented backend follow-up.** This lane
/// sets the client up correctly (authorization, token intake, category, tap
/// routing, local fallback) but does not — and cannot — fake a push arriving
/// from a server. See the integration notes returned to the Assemble agent.
public enum PushScaffold {

    // MARK: Authorization

    /// Request notification authorization. Returns whether it was granted.
    /// Safe, no-network. Idempotent — calling again returns the current grant.
    @discardableResult
    public static func requestAuthorization(
        options: UNAuthorizationOptions = [.alert, .badge, .sound]
    ) async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            return try await center.requestAuthorization(options: options)
        } catch {
            return false
        }
    }

    /// Current authorization status, for surfacing state in Settings.
    public static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    // MARK: Categories

    /// Register the notification categories/actions the app understands. Call
    /// once at launch (before authorization is fine). The alert category makes
    /// a tapped alert notification route into the Alerts tab.
    public static func configureNotificationCategories() {
        let openAction = UNNotificationAction(
            identifier: PushIdentifiers.openAlertsAction,
            title: "View Alerts",
            options: [.foreground]
        )
        let alertCategory = UNNotificationCategory(
            identifier: PushIdentifiers.alertCategory,
            actions: [openAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        UNUserNotificationCenter.current().setNotificationCategories([alertCategory])
    }

    // MARK: Remote (APNs) registration

    /// Trigger APNs registration. On success the system calls the app
    /// delegate's `didRegisterForRemoteNotificationsWithDeviceToken`, which
    /// must forward the token to `setAPNsDeviceToken(_:)`.
    ///
    /// No-op where UIKit is unavailable (tests / previews).
    @MainActor
    public static func registerForRemoteNotifications() {
        #if canImport(UIKit)
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    /// APNs device-token intake. The app forwards the raw token from
    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    ///
    /// This lane records the hex-encoded token on `PushRouter.shared` so the
    /// (future) backend can be handed it during device enrollment. It does
    /// **not** transmit the token anywhere — server enrollment is the
    /// documented backend follow-up.
    public static func setAPNsDeviceToken(_ token: Data) {
        let hex = deviceTokenHexString(from: token)
        Task { @MainActor in
            PushRouter.shared.deviceTokenHex = hex
        }
    }

    /// Pure, testable APNs-token → lowercase hex-string encoding (the format
    /// APNs enrollment APIs expect).
    public static func deviceTokenHexString(from token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Local notifications (client-side fallback)

    /// Schedule immediate local notifications for the given provider alerts —
    /// a client-only path that works before any server push infrastructure
    /// exists. De-duplicates by alert identity so re-scheduling the same alert
    /// set does not spam the user. Returns the identifiers scheduled.
    ///
    /// Only alerts at or above `minimumSeverity` are surfaced; `.info` is
    /// treated as non-interruptive and skipped by default.
    @discardableResult
    public static func scheduleAlertNotifications(
        for alerts: [ProviderAlert],
        minimumSeverity: AlertSeverity = .warning
    ) async -> [String] {
        let center = UNUserNotificationCenter.current()
        let surfaced = alerts.filter { $0.severity.order <= minimumSeverity.order }
        guard !surfaced.isEmpty else { return [] }

        // Avoid re-posting alerts already pending delivery.
        let pending = await center.pendingNotificationRequests().map(\.identifier)
        let pendingSet = Set(pending)

        var scheduled: [String] = []
        for alert in surfaced {
            let identifier = "\(PushIdentifiers.localAlertPrefix)\(alert.id)"
            guard !pendingSet.contains(identifier) else { continue }

            let content = UNMutableNotificationContent()
            content.title = alert.title
            content.body = alert.message
            content.sound = .default
            content.categoryIdentifier = PushIdentifiers.alertCategory
            content.interruptionLevel = alert.severity.interruptionLevel
            content.userInfo = PushDeepLink(tab: .alerts, alertCode: alert.code).userInfo

            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: nil // deliver now
            )
            do {
                try await center.add(request)
                scheduled.append(identifier)
            } catch {
                continue
            }
        }
        return scheduled
    }
}

private extension AlertSeverity {
    /// Map domain severity to a notification interruption level. `.critical`
    /// uses `.timeSensitive` (falls back gracefully if the Time-Sensitive
    /// entitlement is absent).
    var interruptionLevel: UNNotificationInterruptionLevel {
        switch self {
        case .critical: return .timeSensitive
        case .warning: return .active
        case .info: return .passive
        }
    }
}
