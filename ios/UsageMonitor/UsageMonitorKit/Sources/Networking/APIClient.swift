import Foundation
import Models

/// The single entry point for all network access.
///
/// An `actor` so token reads and request construction are serialized and the
/// type is `Sendable` across the app's concurrency domains. Feature view-models
/// hold a reference (injected from `AppCore`) and call the typed methods below;
/// they never build URLs or touch `URLSession` directly.
///
/// ## Reachable endpoints (bearer-token auth model)
/// The server's middleware makes only a few routes reachable with a bearer
/// token (see `ARCHITECTURE-CONTRACT.md` → "Backend auth model"):
///   - `GET /api/budget-status` — bearer-gated; returns the **full** project
///     budget response (providers + projects + summary + embedded alerts).
///     This is the app's primary data source.
///   - `GET /api/subscriptions` — bearer- OR session-authorized (collection GET).
///   - `GET /api/health`, `GET /api/ready` — public, no token required.
/// The richer `GET /api/providers` route is session-cookie gated and is **not**
/// reachable with a bearer token today (documented follow-up).
public actor APIClient {
    private let configuration: APIConfiguration
    private let tokenStore: TokenStoring
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(
        configuration: APIConfiguration = .production,
        tokenStore: TokenStoring = KeychainTokenStore(),
        session: URLSession = .shared
    ) {
        self.configuration = configuration
        self.tokenStore = tokenStore
        self.session = session
        self.decoder = JSONDecoder()
    }

    /// Whether a token is currently stored (surface an onboarding prompt when not).
    public var hasToken: Bool {
        tokenStore.hasToken
    }

    // MARK: - Public endpoints

    /// `GET /api/budget-status` — the full provider + project budget response.
    public func budgetStatus() async throws -> BudgetStatusResponse {
        try await get("/api/budget-status", authenticated: true)
    }

    /// `GET /api/subscriptions` — every tracked subscription with monthly-equivalent cost.
    public func subscriptions() async throws -> [SubscriptionSummary] {
        try await get("/api/subscriptions", authenticated: true)
    }

    /// `GET /api/health` — public liveness probe.
    public func health() async throws -> ServerHealth {
        try await get("/api/health", authenticated: false)
    }

    /// `GET /api/ready` — public readiness probe with dependency detail.
    public func readiness() async throws -> ServerReadiness {
        try await get("/api/ready", authenticated: false)
    }

    /// Validate the currently stored token by making the cheapest authenticated
    /// call. Returns normally on success; throws the mapped ``APIError`` otherwise.
    /// Used by Settings to confirm a freshly-entered token before saving it as
    /// the active credential.
    @discardableResult
    public func verifyToken() async throws -> BudgetStatusResponse {
        try await budgetStatus()
    }

    // MARK: - Request plumbing

    private func get<T: Decodable>(_ path: String, authenticated: Bool) async throws -> T {
        let request = try makeRequest(path: path, authenticated: authenticated)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let urlError as URLError {
            switch urlError.code {
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
                throw APIError.offline
            case .timedOut, .cannotConnectToHost, .networkConnectionLost, .cannotFindHost:
                throw APIError.transport(urlError.localizedDescription)
            default:
                throw APIError.transport(urlError.localizedDescription)
            }
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Malformed response")
        }

        switch http.statusCode {
        case 200...299:
            break
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.forbidden
        case 429:
            let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            throw APIError.rateLimited(retryAfter: retryAfter)
        case 503:
            throw APIError.serverNotConfigured
        default:
            throw APIError.httpStatus(http.statusCode)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch let decodingError as DecodingError {
            throw APIError.decoding(Self.describe(decodingError))
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }

    private func makeRequest(path: String, authenticated: Bool) throws -> URLRequest {
        let url = configuration.baseURL.appendingPathComponent(path)
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: configuration.timeout
        )
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if authenticated {
            guard let token = tokenStore.token(),
                  !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                throw APIError.missingToken
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case let .keyNotFound(key, _):
            return "Missing field '\(key.stringValue)'."
        case let .typeMismatch(_, context):
            return context.debugDescription
        case let .valueNotFound(_, context):
            return context.debugDescription
        case let .dataCorrupted(context):
            return context.debugDescription
        @unknown default:
            return "Could not decode the response."
        }
    }
}
