import Foundation
import LocalAuthentication
#if canImport(UIKit)
import UIKit
#endif

// ---------------------------------------------------------------------------
// Small, dependency-light helpers for the Settings lane: haptics, biometry
// detection (for an accurately-labelled app-lock toggle), and app version info
// for the About section. Kept internal — these never leak out of the module.
// ---------------------------------------------------------------------------

/// Thin wrapper over `UINotificationFeedbackGenerator` / `UISelectionFeedback`
/// so key Settings actions (connect, save, remove, toggle) feel tactile and
/// native. No-ops on platforms without UIKit.
@MainActor
enum Haptics {
    static func success() { notify(.success) }
    static func warning() { notify(.warning) }
    static func error() { notify(.error) }

    static func selection() {
        #if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    #if canImport(UIKit)
    private static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }
    #else
    private static func notify(_ type: Int) {}
    #endif
}

/// What biometric hardware (if any) this device has, so the app-lock row can
/// say "Require Face ID" / "Require Touch ID" instead of a generic label.
struct BiometryInfo: Equatable {
    let isAvailable: Bool
    let type: LABiometryType

    /// The human name of the enrolled biometry, or a passcode fallback phrase.
    var label: String {
        switch type {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "your passcode"
        }
    }

    var systemImage: String {
        switch type {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        default: return "lock.fill"
        }
    }

    /// A one-line description of what unlocking will require.
    var requirementCaption: String {
        if isAvailable {
            return "Unlock the app with \(label) each time it opens or returns from the background."
        }
        return "Unlock the app with your device passcode each time it opens or returns from the background."
    }

    static func current() -> BiometryInfo {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            error: &error
        )
        return BiometryInfo(isAvailable: available, type: context.biometryType)
    }
}

/// Bundle-sourced app identity for the About section.
enum AppInfo {
    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    static var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    static var displayName: String {
        (Bundle.main.infoDictionary?["CFBundleDisplayName"] as? String)
            ?? (Bundle.main.infoDictionary?["CFBundleName"] as? String)
            ?? "Usage Monitor"
    }
}

/// Format a server uptime (seconds) into a compact "3d 4h" / "5m" string.
enum UptimeFormat {
    static func string(fromSeconds seconds: Int) -> String {
        guard seconds > 0 else { return "just started" }
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60

        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m" }
        return "\(seconds)s"
    }
}
