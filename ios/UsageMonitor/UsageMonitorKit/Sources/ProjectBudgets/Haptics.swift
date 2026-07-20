import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Feature-local haptic helpers. Kept inside the lane (not the shared
/// DesignSystem) so nothing else has to change. No-ops where UIKit feedback is
/// unavailable.
enum Haptics {
    static func success() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    static func warning() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        #endif
    }

    static func tap() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}
