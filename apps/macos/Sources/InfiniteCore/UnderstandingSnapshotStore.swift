import Foundation
import CryptoKit

/// Small encrypted, host-scoped cache for the native Understanding page.
/// Overview and Knowledge writers merge into one versioned envelope.
public final class UnderstandingSnapshotStore {
    public struct Envelope: Codable, Sendable {
        public let version: Int
        public var overview: Data?
        public var catalog: Data?
        public var components: Data?
        public var componentDetails: [String: Data]
        public var knowledgeObservedAt: Date?

        public init(version: Int = 1, overview: Data? = nil, catalog: Data? = nil, components: Data? = nil,
                    componentDetails: [String: Data] = [:], knowledgeObservedAt: Date? = nil) {
            self.version = version; self.overview = overview; self.catalog = catalog; self.components = components
            self.componentDetails = componentDetails; self.knowledgeObservedAt = knowledgeObservedAt
        }
    }
    public struct Snapshot: Codable, Sendable {
        public let host: String
        public let credential: String
        public let workspace: String
        public let membershipRevision: Int
        public var observedAt: Date
        public var envelope: Envelope

        public init(host: String, credential: String, workspace: String, membershipRevision: Int,
                    observedAt: Date = Date(), envelope: Envelope = Envelope()) {
            self.host = host; self.credential = credential; self.workspace = workspace
            self.membershipRevision = membershipRevision; self.observedAt = observedAt; self.envelope = envelope
        }
        private enum CodingKeys: String, CodingKey { case host, credential, workspace, membershipRevision, observedAt, envelope, payload }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            host = try values.decode(String.self, forKey: .host)
            credential = try values.decode(String.self, forKey: .credential)
            workspace = try values.decode(String.self, forKey: .workspace)
            membershipRevision = try values.decode(Int.self, forKey: .membershipRevision)
            observedAt = try values.decode(Date.self, forKey: .observedAt)
            if let current = try values.decodeIfPresent(Envelope.self, forKey: .envelope) {
                guard current.version == 1 else { throw DesktopError("Cached Understanding uses an unsupported version.") }
                envelope = current
            } else {
                // Migrate prior raw-overview and combined Knowledge payloads in place on next write.
                let payload = try values.decode(Data.self, forKey: .payload)
                envelope = try Self.migrateLegacy(payload)
            }
        }
        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(host, forKey: .host); try values.encode(credential, forKey: .credential)
            try values.encode(workspace, forKey: .workspace); try values.encode(membershipRevision, forKey: .membershipRevision)
            try values.encode(observedAt, forKey: .observedAt); try values.encode(envelope, forKey: .envelope)
        }
        private static func migrateLegacy(_ bytes: Data) throws -> Envelope {
            let value = try JSON.parse(bytes)
            if value["schemaVersion"].int == 1 && value["workspace"]["id"] != .null {
                return Envelope(overview: bytes)
            }
            guard value["overview"] != .null else { throw DesktopError("Cached Understanding has an unsupported format.") }
            var details: [String: Data] = [:]
            for (id, detail) in value["details"].object { details[id] = try detail.data() }
            return Envelope(overview: try value["overview"].data(), catalog: try value["catalog"].data(),
                            components: try value["components"].data(), componentDetails: details)
        }
    }
    private struct Archive: Codable { var snapshots: [Snapshot] }
    private static let archiveLock = NSLock()
    private let directory: URL
    private let service: String
    private let fileName = "workspace-snapshots.sealed"
    private let maximumSnapshots = 4
    private let maximumBytes = 8 * 1024 * 1024
    private let maximumDetails = 128
    private let maximumDetailsBytes = 2 * 1024 * 1024
    private let lifetime: TimeInterval = 24 * 60 * 60
    private var key: SymmetricKey?

    public init(location: DraftLocation = DraftLocation(bundleID: Bundle.main.bundleIdentifier)) {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Infinite/Understanding-\(URL(fileURLWithPath: location.directory).lastPathComponent)", isDirectory: true)
        service = "\(location.service).understanding-snapshots"
    }

    private var file: URL { directory.appendingPathComponent(fileName) }
    private func locked<T>(_ action: () throws -> T) rethrows -> T {
        Self.archiveLock.lock(); defer { Self.archiveLock.unlock() }
        return try action()
    }
    private func encryptionKey(create: Bool) throws -> SymmetricKey? {
        if let key { return key }
        if let stored = try? DeviceKeychain.read("snapshot-key", service: service),
           let bytes = Data(base64Encoded: stored), bytes.count == 32 {
            let value = SymmetricKey(data: bytes); key = value; return value
        }
        guard create else { return nil }
        if FileManager.default.fileExists(atPath: file.path) { throw DesktopError("Unlock Keychain to recover cached Understanding.") }
        let value = SymmetricKey(size: .bits256)
        try DeviceKeychain.save(value.withUnsafeBytes { Data($0).base64EncodedString() }, for: "snapshot-key", service: service)
        key = value
        return value
    }
    private func readArchive() throws -> Archive {
        guard FileManager.default.fileExists(atPath: file.path) else { return Archive(snapshots: []) }
        guard let key = try encryptionKey(create: false) else { throw DesktopError("Unlock Keychain to recover cached Understanding.") }
        let bytes = try Data(contentsOf: file)
        guard bytes.count <= maximumBytes + 64 * 1024 else { throw DesktopError("Cached Understanding exceeded its storage limit.") }
        let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: bytes), using: key, authenticating: Data("understanding-snapshots-v1".utf8))
        let archive = try JSONDecoder().decode(Archive.self, from: clear)
        guard archive.snapshots.count <= maximumSnapshots, archive.snapshots.reduce(0, { $0 + $1.envelopeBytes }) <= maximumBytes else {
            throw DesktopError("Cached Understanding exceeded its storage limit.")
        }
        return archive
    }
    private func writeArchive(_ archive: Archive) throws {
        let clear = try JSONEncoder().encode(archive)
        guard clear.count <= maximumBytes else { throw DesktopError("Cached Understanding exceeded its storage limit.") }
        guard let key = try encryptionKey(create: true) else { throw DesktopError("The cache key is unavailable.") }
        let sealed = try AES.GCM.seal(clear, using: key, authenticating: Data("understanding-snapshots-v1".utf8))
        guard let bytes = sealed.combined else { throw DesktopError("Could not encrypt cached Understanding.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    public func read(host: String, credential: String, workspace: String, membershipRevision: Int, now: Date = Date()) throws -> Snapshot? {
        try locked {
            try readArchive().snapshots.first {
                $0.host == host && $0.credential == credential && $0.workspace == workspace &&
                $0.membershipRevision == membershipRevision && now.timeIntervalSince($0.observedAt) <= lifetime && now >= $0.observedAt
            }
        }
    }
    public func readRecent(host: String, credential: String, now: Date = Date()) throws -> [Snapshot] {
        try locked {
            try readArchive().snapshots.filter {
                $0.host == host && $0.credential == credential && now.timeIntervalSince($0.observedAt) <= lifetime && now >= $0.observedAt
            }.sorted { $0.observedAt > $1.observedAt }
        }
    }
    public func mergeOverview(host: String, credential: String, workspace: String, membershipRevision: Int,
                              observedAt: Date = Date(), data: Data) throws {
        try merge(host: host, credential: credential, workspace: workspace, membershipRevision: membershipRevision, observedAt: observedAt) { envelope in
            envelope.overview = data
        }
    }
    public func mergeKnowledge(host: String, credential: String, workspace: String, membershipRevision: Int,
                               observedAt: Date = Date(), catalog: Data, components: Data) throws {
        try merge(host: host, credential: credential, workspace: workspace, membershipRevision: membershipRevision, observedAt: observedAt) { envelope in
            envelope.catalog = catalog; envelope.components = components; envelope.knowledgeObservedAt = observedAt
        }
    }
    public func mergeComponentDetail(host: String, credential: String, workspace: String, membershipRevision: Int,
                                     observedAt: Date = Date(), id: String, detail: Data) throws {
        try merge(host: host, credential: credential, workspace: workspace, membershipRevision: membershipRevision, observedAt: observedAt) { envelope in
            envelope.componentDetails[id] = detail
            let retained = envelope.componentDetails.sorted { $0.key < $1.key }
            var bytes = 0
            envelope.componentDetails = [:]
            for (key, value) in retained.reversed() where envelope.componentDetails.count < maximumDetails && bytes + value.count <= maximumDetailsBytes {
                envelope.componentDetails[key] = value; bytes += value.count
            }
            envelope.knowledgeObservedAt = observedAt
        }
    }
    private func merge(host: String, credential: String, workspace: String, membershipRevision: Int,
                       observedAt: Date, update: (inout Envelope) -> Void) throws {
        try locked {
            var archive = try readArchive()
            let existing = archive.snapshots.first { $0.host == host && $0.credential == credential && $0.workspace == workspace && $0.membershipRevision == membershipRevision }
            archive.snapshots.removeAll { $0.host == host && $0.credential == credential && $0.workspace == workspace }
            var snapshot = existing ?? Snapshot(host: host, credential: credential, workspace: workspace, membershipRevision: membershipRevision)
            update(&snapshot.envelope)
            snapshot.observedAt = observedAt
            archive.snapshots.insert(snapshot, at: 0)
            archive.snapshots = Array(archive.snapshots.filter { Date().timeIntervalSince($0.observedAt) <= lifetime }.prefix(maximumSnapshots))
            try writeArchive(archive)
        }
    }
    public func clear(host: String, credential: String, workspace: String) throws {
        try locked {
            var archive = try readArchive()
            archive.snapshots.removeAll { $0.host == host && $0.credential == credential && $0.workspace == workspace }
            if archive.snapshots.isEmpty { try? FileManager.default.removeItem(at: file) }
            else { try writeArchive(archive) }
        }
    }
}

private extension UnderstandingSnapshotStore.Snapshot {
    var envelopeBytes: Int {
        (envelope.overview?.count ?? 0) + (envelope.catalog?.count ?? 0) + (envelope.components?.count ?? 0) + envelope.componentDetails.values.reduce(0) { $0 + $1.count }
    }
}
