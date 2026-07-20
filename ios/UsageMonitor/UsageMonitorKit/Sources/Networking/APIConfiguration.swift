import Foundation

/// Where the app points and how it authenticates.
///
/// The default base URL is the production monitor. The host is overridable so
/// an operator can point the app at a staging deployment from Settings; the
/// chosen value is persisted by the app layer and passed in here.
public struct APIConfiguration: Sendable, Equatable {
    /// Base URL, e.g. `https://usage.jays.services`. Paths are appended to this.
    public var baseURL: URL

    /// Default request timeout in seconds.
    public var timeout: TimeInterval

    public init(baseURL: URL, timeout: TimeInterval = 20) {
        self.baseURL = baseURL
        self.timeout = timeout
    }

    /// The production monitor deployment.
    public static let production = APIConfiguration(
        baseURL: URL(string: "https://usage.jays.services")!
    )

    /// Build a configuration from a user-entered host string, tolerating a
    /// missing scheme (defaults to https) and trailing slashes. Returns `nil`
    /// for input that can't form a valid absolute URL.
    public static func fromUserInput(_ raw: String) -> APIConfiguration? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return APIConfiguration(baseURL: url)
    }
}
