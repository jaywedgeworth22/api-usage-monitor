import Foundation

/// Reads/writes the compact `WidgetSnapshot` shared across the app-group
/// boundary. File-based (atomic write into the group container) with a
/// `UserDefaults`-suite fallback so it still functions when no container is
/// available (previews / unsigned builds).
public struct SharedStore {
    public static let shared = SharedStore()

    private let fileName = "widget-snapshot.json"
    private let defaultsKey = "widget-snapshot"

    public init() {}

    private var fileURL: URL? {
        AppGroup.containerURL?.appendingPathComponent(fileName)
    }

    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    public func write(_ snapshot: WidgetSnapshot) {
        guard let data = try? encoder.encode(snapshot) else { return }
        if let url = fileURL {
            try? data.write(to: url, options: .atomic)
        } else {
            AppGroup.defaults.set(data, forKey: defaultsKey)
        }
    }

    public func read() -> WidgetSnapshot? {
        if let url = fileURL, let data = try? Data(contentsOf: url) {
            return try? decoder.decode(WidgetSnapshot.self, from: data)
        }
        if let data = AppGroup.defaults.data(forKey: defaultsKey) {
            return try? decoder.decode(WidgetSnapshot.self, from: data)
        }
        return nil
    }
}
