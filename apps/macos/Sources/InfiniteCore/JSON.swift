import Foundation

public enum JSON: Codable, Sendable, Equatable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSON { if case .object(let value) = self { return value[key] ?? .null }; return .null }
    public var string: String { if case .string(let value) = self { return value }; return "" }
    public var number: Double? { if case .number(let value) = self { return value }; return nil }
    public var int: Int { number.flatMap { $0.isFinite && abs($0) < Double(Int.max) ? Int($0) : nil } ?? 0 }
    public var bool: Bool { if case .bool(let value) = self { return value }; return false }
    public var array: [JSON] { if case .array(let value) = self { return value }; return [] }
    public var object: [String: JSON] { if case .object(let value) = self { return value }; return [:] }
    public func data() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        return try encoder.encode(self)
    }
    public static func parse(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
}

public struct DesktopError: LocalizedError, Sendable {
    public let message: String
    public let code: String
    public let status: Int
    public init(_ message: String, code: String = "failed", status: Int = 0) { self.message = message; self.code = code; self.status = status }
    public var errorDescription: String? { message }
}

extension Data {
    public var hex: String { map { String(format: "%02x", $0) }.joined() }
    public init?(hex: String) {
        guard hex.count % 2 == 0, hex.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        self.init(); var index = hex.startIndex
        while index < hex.endIndex {
            let end = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<end], radix: 16) else { return nil }
            append(byte); index = end
        }
    }
}
