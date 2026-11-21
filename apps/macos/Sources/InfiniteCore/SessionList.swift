import Foundation

/// The session rows the host sent last, and the version it named for them.
/// `GET /api/sessions?since=VERSION` answers `{ version, unchanged: true }` while the list is still that version,
/// else `{ version, sessions }`. A host that predates `since` ignores it and answers `{ sessions }`.
public struct SessionList: Sendable {
    /// `stale` is the answer to a read that started before the read whose answer the list holds: it changes nothing.
    public enum Outcome: Equatable, Sendable { case replaced, unchanged, unreadable, stale }

    /// A read in flight: the path to send, and its place in the order the reads started.
    public struct Read: Sendable {
        public let path: String
        let order: Int
    }

    public private(set) var rows: [JSON] = []
    public private(set) var version: String?
    private var started = 0, kept = 0

    public init() {}

    /// The read to send: it names the version held, or asks for one with an empty `since`.
    public var path: String { "/sessions?since=\(version ?? "")" }

    /// Starts a read of `path`. Reads may overlap, so each answer goes back with the read it answers.
    public mutating func begin() -> Read {
        started += 1
        return Read(path: path, order: started)
    }

    /// Takes the answer to `read`. Rows replace the list, with their version when the host names one; `unchanged`
    /// keeps the list when it names the version held. Any other answer is unreadable: follow it with a plain
    /// `/sessions` read and `acceptPlain`.
    public mutating func accept(_ answer: JSON, to read: Read) -> Outcome {
        if read.order < kept { return .stale }
        let named = Self.readable(answer["version"])
        if case .array(let sessions) = answer["sessions"] { rows = sessions; version = named; kept = read.order; return .replaced }
        if answer["unchanged"] == .bool(true), let named, named == version { kept = read.order; return .unchanged }
        return .unreadable
    }

    /// Takes the answer to the plain `/sessions` read that follows `read`, as the app always read it, and asks for a
    /// version again next time.
    public mutating func acceptPlain(_ answer: JSON, to read: Read) -> Outcome {
        if read.order < kept { return .stale }
        rows = answer["sessions"].array; version = nil; kept = read.order
        return .replaced
    }

    /// A version is kept only in the alphabet and bound the host accepts back in `since`.
    private static func readable(_ value: JSON) -> String? {
        guard case .string(let text) = value, (1...128).contains(text.utf8.count),
              text.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f })
        else { return nil }
        return text
    }
}
