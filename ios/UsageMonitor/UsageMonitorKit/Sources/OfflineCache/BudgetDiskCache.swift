import Foundation
import Models

/// Disk persistence for the last successful budget response, enabling an
/// offline-first first paint. Owned by the **OfflineCache** lane.
///
/// The on-disk format is a timestamped ``CachedBudget`` envelope so the UI can
/// show a "stale as of <time>" indicator (see ``BudgetStaleness``). The original
/// `save(_:)` / `load()` API is preserved unchanged for the app's snapshot sink;
/// ``saveEntry(_:)`` / ``loadEntry()`` expose the timestamp. A legacy bare
/// `BudgetStatusResponse` file (from an earlier build) is still read back so an
/// in-place upgrade never drops the offline paint.
///
/// Intentionally free of any `AppCore` dependency (see the target's layering):
/// it operates purely on `Models`. The app target adapts it to
/// `AppCore.BudgetSnapshotSink`.
public struct BudgetDiskCache {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// - Parameter directory: defaults to the app's Caches directory. The app
    ///   group container can be passed to share the cache with the widget.
    public init(directory: URL? = nil, fileName: String = "budget-status-cache.json") {
        let base = directory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        self.fileURL = base.appendingPathComponent(fileName)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    /// Persist the response atomically, stamping it with the current time.
    /// Swallows I/O errors — caching is a best-effort side effect, never a hard
    /// failure.
    public func save(_ response: BudgetStatusResponse) {
        saveEntry(CachedBudget(response: response, cachedAt: Date()))
    }

    /// Persist a pre-built entry (lets a caller control `cachedAt`).
    public func saveEntry(_ entry: CachedBudget) {
        guard let data = try? encoder.encode(entry) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// The most recently cached response, or `nil` when none exists / is
    /// unreadable.
    public func load() -> BudgetStatusResponse? {
        loadEntry()?.response
    }

    /// The most recently cached entry, including its `cachedAt` timestamp, or
    /// `nil` when none exists / is unreadable. Falls back to a legacy bare
    /// `BudgetStatusResponse` file, dating it from the file's modification time.
    public func loadEntry() -> CachedBudget? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        if let entry = try? decoder.decode(CachedBudget.self, from: data) {
            return entry
        }
        // Backward compatibility: an older build wrote the bare response.
        if let legacy = try? decoder.decode(BudgetStatusResponse.self, from: data) {
            let stamp = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.modificationDate] as? Date) ?? nil
            return CachedBudget(response: legacy, cachedAt: stamp ?? Date())
        }
        return nil
    }

    /// Remove the cache (e.g. on sign-out / token change).
    public func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
