import Foundation

/// The session rows the host sent last, and the version it named for them.
/// `GET /api/sessions?since=VERSION` answers `{ version, unchanged: true }` while the list is still that version,
/// else `{ version, sessions }`. A host that predates `since` ignores it and answers `{ sessions }`.
public struct SessionList: Sendable {
    public enum Outcome: Equatable, Sendable { case replaced, unchanged, unreadable }

    public private(set) var rows: [JSON] = []
    public private(set) var version: String?

    public init() {}

    /// The read to send: it names the version held, or asks for one with an empty `since`.
    public var path: String { "/sessions?since=\(version ?? "")" }

    /// Takes the answer to `path`. Rows replace the list, with their version when the host names one; `unchanged`
    /// keeps the list when it names the version held. Any other answer is unreadable: follow it with a plain
    /// `/sessions` read and `acceptPlain`.
    public mutating func accept(_ answer: JSON) -> Outcome {
        let named = Self.readable(answer["version"])
        if case .array(let sessions) = answer["sessions"] { rows = sessions; version = named; return .replaced }
        if answer["unchanged"] == .bool(true), let named, named == version { return .unchanged }
        return .unreadable
    }

    /// Takes the answer to a plain `/sessions` read as the app always read it, and asks for a version again next time.
    public mutating func acceptPlain(_ answer: JSON) {
        rows = answer["sessions"].array; version = nil
    }

    /// A version is kept only in the alphabet and bound the host accepts back in `since`.
    private static func readable(_ value: JSON) -> String? {
        guard case .string(let text) = value, (1...128).contains(text.utf8.count),
              text.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f })
        else { return nil }
        return text
    }
}
