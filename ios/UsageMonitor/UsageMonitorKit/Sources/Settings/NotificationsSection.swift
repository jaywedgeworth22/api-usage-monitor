import SwiftUI
import UserNotifications
import DesignSystem
import Models
import PushScaffold

#if canImport(UIKit)
import UIKit
#endif

/// Settings → **Notifications**. Gives the budget-alert loop a user-facing home:
///   - a master "Budget alerts" toggle (persisted via ``AlertNotifier``),
///   - a minimum-severity picker (Warning & above / Critical only),
///   - the live system authorization state, with a one-tap jump to iOS Settings
///     when the user has denied permission.
///
/// This is the contextual opt-in that replaces the old cold, first-launch system
/// prompt: flipping the toggle on is what triggers the permission request, so the
/// dialog only appears once the user has expressed intent to be notified.
struct NotificationsSection: View {
    @State private var model = NotificationsSettingsModel()

    var body: some View {
        Section {
            Toggle(isOn: $model.isEnabled) {
                Label("Budget alerts", systemImage: "bell.badge.fill")
            }
            .tint(Theme.Colors.accent)
            .onChange(of: model.isEnabled) { _, enabled in
                Haptics.selection()
                if enabled { Task { await model.enableAndRequestIfNeeded() } }
            }

            if model.isEnabled {
                Picker(selection: $model.minimumSeverity) {
                    Text("Warning & above").tag(AlertSeverity.warning)
                    Text("Critical only").tag(AlertSeverity.critical)
                } label: {
                    Label("Notify me about", systemImage: "slider.horizontal.3")
                }
                .onChange(of: model.minimumSeverity) { _, _ in Haptics.selection() }

                if model.showsDeniedRow {
                    Button {
                        model.openSystemSettings()
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Notifications are turned off")
                                    .foregroundStyle(Theme.Colors.primaryText)
                                Text("Enable them in iOS Settings to get alerts.")
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                        } icon: {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(Theme.Colors.warning)
                        }
                    }
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text(footerText)
        }
        .task { await model.refreshStatus() }
    }

    private var footerText: String {
        guard model.isEnabled else {
            return "Get notified when a provider crosses or nears its monthly budget — checked quietly in the background."
        }
        switch model.authorizationStatus {
        case .denied:
            return "Usage Monitor can't send notifications until you allow them in iOS Settings."
        case .notDetermined:
            return "You'll be asked to allow notifications."
        default:
            return "Alerts are delivered in the background as budgets change, deduplicated so you're never spammed."
        }
    }
}

/// Observable wrapper around the (non-observable) `UserDefaults`-backed
/// ``AlertNotifier`` preferences plus the system authorization status, so the
/// SwiftUI section can bind to them.
@MainActor
@Observable
final class NotificationsSettingsModel {
    var isEnabled: Bool {
        didSet { AlertNotifier.isEnabled = isEnabled }
    }
    var minimumSeverity: AlertSeverity {
        didSet { AlertNotifier.minimumSeverity = minimumSeverity }
    }
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined

    init() {
        isEnabled = AlertNotifier.isEnabled
        minimumSeverity = AlertNotifier.minimumSeverity
    }

    /// Show the "turned off" row only when the user wants alerts but the system
    /// won't deliver them.
    var showsDeniedRow: Bool {
        isEnabled && authorizationStatus == .denied
    }

    func refreshStatus() async {
        authorizationStatus = await PushScaffold.authorizationStatus()
    }

    /// Request permission the first time the user opts in (the contextual
    /// prompt). Registers for remote delivery when granted.
    func enableAndRequestIfNeeded() async {
        if authorizationStatus == .notDetermined {
            let granted = await PushScaffold.requestAuthorization()
            if granted { PushScaffold.registerForRemoteNotifications() }
        }
        await refreshStatus()
    }

    func openSystemSettings() {
        #if canImport(UIKit)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #endif
    }
}
