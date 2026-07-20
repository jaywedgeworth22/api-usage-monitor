import UIKit

/// Thin wrapper over UIKit feedback generators for the Alerts lane's key
/// interactions. Kept tiny and centralized so every haptic in the feature reads
/// intentional and consistent. All calls are main-actor (UIKit feedback APIs
/// require it) and safe no-ops on devices without a Taptic Engine.
@MainActor
enum AlertsHaptics {
    /// A light tap when drilling into an alert's provider.
    static func selection() {
        let generator = UISelectionFeedbackGenerator()
        generator.selectionChanged()
    }

    /// A soft impact for filter changes.
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.impactOccurred()
    }

    /// Success/warning notification after a manual refresh completes.
    static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(type)
    }
}
