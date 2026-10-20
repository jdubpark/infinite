import Foundation
import CryptoKit

public struct DraftRecord: Codable, Sendable {
    public var text: String = ""
    public var pendingID: String?
    public var pendingText: String?
    public var lastQueuedText: String?
    public init() {}
}

/// Where one app build keeps its draft key and ciphertext. The installed app keeps its original names; any
/// other build (a rehearsal copy, an unbundled binary) gets its own, so it never prompts for, or fails on,
/// the installed app's key and never writes into its drafts.
public struct DraftLocation: Equatable, Sendable {
    public static let installedBundleID = "dev.infinite.desktop"
    public let service: String
    /// Relative to Application Support.
    public let directory: String
    public init(bundleID: String?) {
        if bundleID == Self.installedBundleID { service = DeviceKeychain.service; directory = "Infinite/Drafts"; return }
        // Bundle IDs are already path-safe; anything else is reduced to letters, digits, dots, and hyphens.
        let safe = String((bundleID ?? "").map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".") ? $0 : "-" })
        let name = safe.contains(where: { $0.isLetter || $0.isNumber }) ? safe : "unbundled"
        service = "\(DeviceKeychain.service).\(name)"; directory = "Infinite/Drafts-\(name)"
    }
}

/// Only authenticated ciphertext is persisted. A pending submission is never replayed on load.
public final class DraftStore {
    private let directory: URL
    private let service: String
    private var key: SymmetricKey?
    public init(location: DraftLocation = DraftLocation(bundleID: Bundle.main.bundleIdentifier)) {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(location.directory, isDirectory: true)
        service = location.service
    }
    private func encryptionKey() throws -> SymmetricKey {
        if let key { return key }
        let value: SymmetricKey
        if let stored = try? DeviceKeychain.read("encrypted-drafts", service: service), let data = Data(base64Encoded: stored), data.count == 32 { value = SymmetricKey(data: data) }
        else {
            // An existing ciphertext must never become unreadable through silent key rotation.
            if FileManager.default.fileExists(atPath: directory.path), !(try FileManager.default.contentsOfDirectory(atPath: directory.path)).isEmpty { throw DesktopError("Unlock Keychain to recover local drafts.") }
            value = SymmetricKey(size: .bits256)
            try DeviceKeychain.save(value.withUnsafeBytes { Data($0).base64EncodedString() }, for: "encrypted-drafts", service: service)
        }
        key = value; return value
    }
    private func file(_ identity: String) -> URL { directory.appendingPathComponent(Data(SHA256.hash(data: Data(identity.utf8))).hex + ".sealed") }
    public func read(_ identity: String) throws -> DraftRecord {
        let path = file(identity)
        guard FileManager.default.fileExists(atPath: path.path) else { return DraftRecord() }
        let bytes = try Data(contentsOf: path)
        let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: bytes), using: encryptionKey(), authenticating: Data(identity.utf8))
        return try JSONDecoder().decode(DraftRecord.self, from: clear)
    }
    public func save(_ record: DraftRecord, identity: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let clear = try JSONEncoder().encode(record)
        let encrypted = try AES.GCM.seal(clear, using: encryptionKey(), authenticating: Data(identity.utf8))
        guard let data = encrypted.combined else { throw DesktopError("Could not encrypt the draft.") }
        try data.write(to: file(identity), options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file(identity).path)
    }
}
