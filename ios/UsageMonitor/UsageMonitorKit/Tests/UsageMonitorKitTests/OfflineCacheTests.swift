import XCTest
@testable import OfflineCache
import Models
import WidgetShared

/// OfflineCache lane tests: disk round-trip (with timestamp + legacy fallback),
/// the "stale as of <time>" indicator logic, and the widget snapshot derivation.
///
/// NOTE: requires the `UsageMonitorKitTests` target to depend on `OfflineCache`
/// and `WidgetShared` (see integration notes) — the foundation manifest wires
/// only Models/Networking/AppCore/DesignSystem by default.
final class OfflineCacheTests: XCTestCase {

    private func tempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("offlinecache-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - Disk cache round-trip

    func testSaveThenLoadRoundTripsResponse() {
        let dir = tempDirectory()
        let cache = BudgetDiskCache(directory: dir)

        XCTAssertNil(cache.load(), "empty directory should have no cache")

        cache.save(.sample)

        let loaded = cache.load()
        XCTAssertEqual(loaded?.month, BudgetStatusResponse.sample.month)
        XCTAssertEqual(loaded?.providers.count, BudgetStatusResponse.sample.providers.count)
    }

    func testSaveStampsCachedAtCloseToNow() throws {
        let dir = tempDirectory()
        let cache = BudgetDiskCache(directory: dir)
        let before = Date()

        cache.save(.sample)

        let cachedAt = try XCTUnwrap(cache.loadEntry()?.cachedAt)
        XCTAssertGreaterThanOrEqual(cachedAt.timeIntervalSince1970, before.timeIntervalSince1970 - 1)
        XCTAssertLessThanOrEqual(cachedAt.timeIntervalSince1970, Date().timeIntervalSince1970 + 1)
    }

    func testSaveEntryPreservesExplicitCachedAt() {
        let dir = tempDirectory()
        let cache = BudgetDiskCache(directory: dir)
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)

        cache.saveEntry(CachedBudget(response: .sample, cachedAt: stamp))

        XCTAssertEqual(cache.loadEntry()?.cachedAt, stamp)
    }

    func testClearRemovesCache() {
        let dir = tempDirectory()
        let cache = BudgetDiskCache(directory: dir)
        cache.save(.sample)
        XCTAssertNotNil(cache.load())

        cache.clear()
        XCTAssertNil(cache.load())
    }

    /// A file written in the legacy bare-response format must still load.
    func testLegacyBareResponseFileStillLoads() throws {
        let dir = tempDirectory()
        let fileURL = dir.appendingPathComponent("budget-status-cache.json")
        let legacyData = try JSONEncoder().encode(BudgetStatusResponse.sample)
        try legacyData.write(to: fileURL)

        let cache = BudgetDiskCache(directory: dir)
        let entry = cache.loadEntry()
        XCTAssertNotNil(entry, "legacy bare-response file should be readable")
        XCTAssertEqual(entry?.response.month, BudgetStatusResponse.sample.month)
    }

    // MARK: - Staleness indicator

    func testFreshEntryIsNotStale() {
        let staleness = BudgetStaleness(cachedAt: Date(), threshold: 15 * 60)
        XCTAssertFalse(staleness.isStale())
        XCTAssertTrue(staleness.shortLabel().hasPrefix("Updated"))
    }

    func testOldEntryIsStaleWithLabel() {
        let now = Date()
        let cachedAt = now.addingTimeInterval(-30 * 60) // 30 min old
        let staleness = BudgetStaleness(cachedAt: cachedAt, threshold: 15 * 60)

        XCTAssertTrue(staleness.isStale(asOf: now))
        XCTAssertEqual(staleness.age(asOf: now), 30 * 60, accuracy: 1)
        XCTAssertTrue(staleness.staleLabel(asOf: now).hasPrefix("Stale as of "))
        XCTAssertTrue(staleness.shortLabel(asOf: now).hasPrefix("Stale · "))
    }

    func testThresholdBoundaryIsStale() {
        let now = Date()
        let staleness = BudgetStaleness(cachedAt: now.addingTimeInterval(-900), threshold: 900)
        XCTAssertTrue(staleness.isStale(asOf: now))
    }

    // MARK: - Widget snapshot derivation

    func testSnapshotKeepsHighestUtilisationBudgetedMeters() {
        let snapshot = WidgetSnapshotBuilder.snapshot(from: .sample, maxMeters: 2)

        XCTAssertLessThanOrEqual(snapshot.topMeters.count, 2)
        // Meters are sorted most-utilised first.
        let percents = snapshot.topMeters.map { $0.percentUsed ?? 0 }
        XCTAssertEqual(percents, percents.sorted(by: >))
        XCTAssertEqual(snapshot.month, BudgetStatusResponse.sample.month)
    }
}
