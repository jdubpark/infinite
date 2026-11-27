import Foundation

public struct SessionList: Sendable {
    public enum Outcome: Equatable, Sendable { case replaced, unchanged, unreadable, stale }

    public enum SyncCursor: Equatable, Sendable {
        case unversioned
        case versioned(String)

        init(validating value: JSON) {
            guard case .string(let text) = value, (1...128).contains(text.utf8.count),
                  text.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f })
            else {
                self = .unversioned
                return
            }
            self = .versioned(text)
        }

        var token: String? {
            if case .versioned(let text) = self { return text }
            return nil
        }
    }

    public struct Read: Sendable {
        public let path: String
        let order: Int
    }

    public private(set) var rows: [JSON] = []
    public private(set) var cursor: SyncCursor = .unversioned
    private var started = 0, kept = 0

    public var version: String? { cursor.token }

    public init() {}

    public var path: String { "/sessions?since=\(cursor.token ?? "")" }

    public mutating func begin() -> Read {
        started += 1
        return Read(path: path, order: started)
    }

    public mutating func accept(_ answer: JSON, to read: Read) -> Outcome {
        if read.order < kept { return .stale }
        let named = SyncCursor(validating: answer["version"])
        if case .array(let sessions) = answer["sessions"] {
            rows = sessions
            cursor = named
            kept = read.order
            return .replaced
        }
        if answer["unchanged"] == .bool(true), case .versioned = named, named == cursor {
            kept = read.order
            return .unchanged
        }
        return .unreadable
    }

    public mutating func acceptPlain(_ answer: JSON, to read: Read) -> Outcome {
        if read.order < kept { return .stale }
        rows = answer["sessions"].array
        cursor = .unversioned
        kept = read.order
        return .replaced
    }
}
