import Foundation

/// Turns a cache timestamp into the strings and flags a view needs to show a
/// clear "stale as of <time>" indicator when data is being served from disk
/// (typically while offline).
///
/// Model-free and `AppCore`-free: pure `Foundation`. Feature roots (or the app)
/// build one from ``CachedBudget/cachedAt`` and render ``shortLabel`` /
/// ``staleLabel`` in a banner; the shared `BudgetStore` already keeps stale data
/// on-screen on a refresh failure, so this only supplies the wording.
public struct BudgetStaleness: Equatable, Sendable {
    /// When the on-screen data was last successfully cached.
    public let cachedAt: Date
    /// Age past which the data is considered stale. Default 15 minutes.
    public let threshold: TimeInterval

    /// Default staleness window: 15 minutes.
    public static let defaultThreshold: TimeInterval = 15 * 60

    public init(cachedAt: Date, threshold: TimeInterval = BudgetStaleness.defaultThreshold) {
        self.cachedAt = cachedAt
        self.threshold = threshold
    }

    /// Seconds since the data was cached.
    public func age(asOf now: Date = Date()) -> TimeInterval {
        max(0, now.timeIntervalSince(cachedAt))
    }

    /// Whether the cached data is older than ``threshold``.
    public func isStale(asOf now: Date = Date()) -> Bool {
        age(asOf: now) >= threshold
    }

    /// A relative age phrase, e.g. "5 minutes ago", "just now".
    public func relativeDescription(asOf now: Date = Date()) -> String {
        if age(asOf: now) < 45 { return "just now" }
        return Self.relativeFormatter.localizedString(for: cachedAt, relativeTo: now)
    }

    /// An absolute clock/day time, e.g. "9:15 AM" (today) using the user locale.
    public func absoluteDescription() -> String {
        Self.timeFormatter.string(from: cachedAt)
    }

    /// The full indicator string for the offline/stale banner, e.g.
    /// "Stale as of 9:15 AM · 22 minutes ago".
    public func staleLabel(asOf now: Date = Date()) -> String {
        "Stale as of \(absoluteDescription()) · \(relativeDescription(asOf: now))"
    }

    /// A compact indicator suitable for a caption/badge, e.g.
    /// "Updated 5 minutes ago" (fresh) or "Stale · 22 minutes ago" (stale).
    public func shortLabel(asOf now: Date = Date()) -> String {
        let rel = relativeDescription(asOf: now)
        return isStale(asOf: now) ? "Stale · \(rel)" : "Updated \(rel)"
    }

    // MARK: - Formatters (cached; thread-safe for read-only use)

    private nonisolated(unsafe) static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private nonisolated static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()
}
