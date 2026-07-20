import Foundation
import Observation
import Models
import Networking
import AppCore
import DesignSystem

/// A combined snapshot of the two public health probes — `GET /api/health`
/// (liveness) and `GET /api/ready` (readiness + dependency checks). Readiness
/// is best-effort: liveness alone still produces a useful snapshot.
struct ServerStatusSnapshot: Equatable, Sendable {
    var health: ServerHealth
    var readiness: ServerReadiness?
    var fetchedAt: Date

    /// Roll-up status for the header badge.
    var overallStatus: Theme.SemanticStatus {
        if !health.ok { return .danger }
        if let readiness, !readiness.ok { return .warning }
        return .ok
    }

    var overallLabel: String {
        if !health.ok { return "Offline" }
        if let readiness, !readiness.ok { return "Degraded" }
        return "Operational"
    }

    /// The named dependency checks that were reported, in display order.
    var dependencyChecks: [(name: String, ok: Bool)] {
        guard let checks = readiness?.checks else { return [] }
        var rows: [(String, Bool)] = []
        if let c = checks.database { rows.append(("Database", c.ok)) }
        if let c = checks.scheduler { rows.append(("Scheduler", c.ok)) }
        if let c = checks.backup { rows.append(("Backups", c.ok)) }
        if let c = checks.startup { rows.append(("Startup", c.ok)) }
        return rows
    }
}

/// Owns the Settings server-status panel's load lifecycle. Independent of the
/// budget `BudgetStore` because it hits the **public** health endpoints (no
/// token required) — the status card renders even before a token is entered,
/// which helps the user tell "wrong token" apart from "server down".
@MainActor
@Observable
final class ServerStatusStore {
    private(set) var state: LoadState<ServerStatusSnapshot> = .idle

    private let probe: @Sendable (APIClient) async throws -> ServerStatusSnapshot

    init(probe: @escaping @Sendable (APIClient) async throws -> ServerStatusSnapshot = ServerStatusStore.liveProbe) {
        self.probe = probe
    }

    func loadIfNeeded(using client: APIClient) async {
        if case .idle = state { await load(using: client) }
    }

    func load(using client: APIClient) async {
        if state.value == nil { state = .loading }
        await fetch(using: client)
    }

    func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    private func fetch(using client: APIClient) async {
        do {
            state = .loaded(try await probe(client))
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func handle(_ error: APIError) {
        // Keep a prior good snapshot on transient refresh failures.
        if state.value == nil {
            state = .failed(error)
        }
    }

    /// The real probe: liveness is required, readiness is best-effort.
    nonisolated static let liveProbe: @Sendable (APIClient) async throws -> ServerStatusSnapshot = { client in
        let health = try await client.health()
        let readiness = try? await client.readiness()
        return ServerStatusSnapshot(health: health, readiness: readiness, fetchedAt: Date())
    }
}
