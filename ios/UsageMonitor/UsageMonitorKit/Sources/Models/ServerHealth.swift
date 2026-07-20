import Foundation

/// `GET /api/health` — public, unauthenticated liveness probe.
public struct ServerHealth: Codable, Hashable, Sendable {
    public var ok: Bool
    public var status: String
    public var uptimeSeconds: Int?
    public var checkedAt: String?
    public var service: String?
    public var version: String?
    public var commit: String?

    public init(
        ok: Bool,
        status: String,
        uptimeSeconds: Int? = nil,
        checkedAt: String? = nil,
        service: String? = nil,
        version: String? = nil,
        commit: String? = nil
    ) {
        self.ok = ok
        self.status = status
        self.uptimeSeconds = uptimeSeconds
        self.checkedAt = checkedAt
        self.service = service
        self.version = version
        self.commit = commit
    }
}

/// `GET /api/ready` — public readiness probe with dependency detail. Only the
/// `ok`/`status` roll-up and each check's `ok` are decoded.
public struct ServerReadiness: Codable, Hashable, Sendable {
    public struct Check: Codable, Hashable, Sendable {
        public var ok: Bool
        public var latencyMs: Double?

        public init(ok: Bool, latencyMs: Double? = nil) {
            self.ok = ok
            self.latencyMs = latencyMs
        }
    }

    public struct Checks: Codable, Hashable, Sendable {
        public var database: Check?
        public var scheduler: Check?
        public var backup: Check?
        public var startup: Check?

        public init(
            database: Check? = nil,
            scheduler: Check? = nil,
            backup: Check? = nil,
            startup: Check? = nil
        ) {
            self.database = database
            self.scheduler = scheduler
            self.backup = backup
            self.startup = startup
        }
    }

    public var ok: Bool
    public var status: String
    public var checkedAt: String?
    public var checks: Checks?

    public init(ok: Bool, status: String, checkedAt: String? = nil, checks: Checks? = nil) {
        self.ok = ok
        self.status = status
        self.checkedAt = checkedAt
        self.checks = checks
    }
}
