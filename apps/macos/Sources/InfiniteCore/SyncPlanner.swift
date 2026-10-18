import Foundation
import CryptoKit

public enum SyncAction: String, Codable, CaseIterable, Sendable {
    case none, upload, download
    public var label: String {
        switch self { case .none: return "Leave unchanged"; case .upload: return "Mac → server"; case .download: return "Server → Mac" }
    }
}
public struct SyncItem: Identifiable, Sendable {
    public let path: String
    public let local: FileVersion?
    public let remote: FileVersion?
    public let reason: String
    public let needsDecision: Bool
    public let blocked: Bool
    public var action: SyncAction
    public var id: String { path }
    public init(path: String, local: FileVersion?, remote: FileVersion?, reason: String, needsDecision: Bool, blocked: Bool = false, action: SyncAction) {
        self.path = path; self.local = local; self.remote = remote; self.reason = reason; self.needsDecision = needsDecision; self.blocked = blocked; self.action = action
    }
    public var choices: [SyncAction] { [.none] + (local == nil || blocked ? [] : [.upload]) + (remote == nil || blocked ? [] : [.download]) }
}
public struct SyncPlan: Sendable {
    public var items: [SyncItem]
    public let createdAt: Date
    public let localRoot: URL
    public let remoteRoot: String
    public let scope: String
}

/// Content baselines are local, private and scoped to one machine/project/folder pair.
/// Preview never writes them. Only confirmed convergence advances a baseline.
public actor SyncBaselines {
    private struct Record: Codable { var version = 1; var files: [String: String] }
    private let directory: URL
    public init(directory: URL? = nil) throws { self.directory = try directory ?? LocalFiles.privateDirectory("Sync Baselines") }
    private func url(_ scope: String) -> URL { directory.appendingPathComponent(Data(SHA256.hash(data: Data(scope.utf8))).hex + ".json") }
    public func read(_ scope: String) throws -> [String: String] {
        let file = url(scope)
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: file))
        guard record.version == 1 else { throw DesktopError("This sync baseline requires a newer app.") }
        return record.files
    }
    public func confirm(_ path: String, hash: String, scope: String) throws {
        var files = try read(scope); files[path] = hash
        let data = try JSONEncoder().encode(Record(files: files))
        try data.write(to: url(scope), options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url(scope).path)
    }
}

public struct SyncPlanner: Sendable {
    public let transfer: FileTransfer
    public let baselines: SyncBaselines
    public init(transfer: FileTransfer, baselines: SyncBaselines) { self.transfer = transfer; self.baselines = baselines }
    public static func classify(path: String, local: FileVersion?, remote: FileVersion?, baseline: String?) -> SyncItem {
        let lhs = local?.sha256, rhs = remote?.sha256
        let reason: String, action: SyncAction, decision: Bool
        if lhs == rhs {
            reason = lhs == nil ? "Missing on both sides · no deletion propagated" : "Same content"
            action = .none; decision = false
        } else if baseline == nil {
            if lhs == nil { reason = "Only on server"; action = .download; decision = false }
            else if rhs == nil { reason = "Only on Mac"; action = .upload; decision = false }
            else { reason = "Different copies · choose which to use"; action = .none; decision = true }
        } else if lhs == nil {
            reason = "Deleted on Mac · choose Server → Mac to restore"; action = .none; decision = true
        } else if rhs == nil {
            reason = "Deleted on server · choose Mac → server to restore"; action = .none; decision = true
        } else if lhs == baseline {
            reason = "Changed on server"; action = .download; decision = false
        } else if rhs == baseline {
            reason = "Changed on Mac"; action = .upload; decision = false
        } else {
            reason = "Both copies changed · choose which to use"; action = .none; decision = true
        }
        return SyncItem(path: path, local: local, remote: remote, reason: reason, needsDecision: decision, action: action)
    }
    private static func ignored(_ name: String) -> Bool { [".git", ".infinite", ".DS_Store"].contains(name) || name.hasPrefix(".infinite-desktop-") }
    public static func joined(_ root: String, _ path: String) -> String { root.isEmpty ? path : root + "/" + path }
    public func preview(profileID: String, localRoot: URL, remoteRoot: String, progress: @escaping @Sendable (String) -> Void) async throws -> SyncPlan {
        _ = try LocalFiles.location(root: localRoot, path: ""); _ = try LocalFiles.components(remoteRoot)
        let scope = [profileID, transfer.projectID, localRoot.path, remoteRoot].joined(separator: "\u{0}")
        let baseline = try await baselines.read(scope)
        var local: [String: FileVersion] = [:], remote: [String: FileVersion] = [:], issues: [String: String] = [:]
        var directories = [""], inspected = 0
        while let directory = directories.popLast() {
            try Task.checkCancellation()
            for entry in try LocalFiles.list(root: localRoot, path: directory) where !Self.ignored(entry.name) {
                inspected += 1; guard inspected <= 10000, entry.path.split(separator: "/").count <= 64 else { throw DesktopError("Sync preview is limited to 10,000 entries and 64 directory levels. Choose a smaller folder.") }
                if entry.isDirectory { directories.append(entry.path) }
                else if entry.transferable {
                    progress("Checking Mac: " + entry.path)
                    guard let version = try LocalFiles.version(root: localRoot, path: entry.path) else { throw DesktopError("A local file disappeared during preview. Preview again.") }
                    local[entry.path] = version
                } else { issues[entry.path] = entry.kind == "symlink" ? "Symbolic link · skipped" : "Unsupported or larger than 256 MiB · skipped" }
            }
        }
        directories = [remoteRoot]; inspected = 0
        while let directory = directories.popLast() {
            var cursor: String?
            repeat {
                try Task.checkCancellation()
                let page = try await transfer.list(path: directory, cursor: cursor)
                for entry in page.entries where !Self.ignored(entry.name) {
                    let relative = remoteRoot.isEmpty ? entry.path : String(entry.path.dropFirst(remoteRoot.count + 1))
                    guard remoteRoot.isEmpty || entry.path.hasPrefix(remoteRoot + "/") else { throw DesktopError("The server returned a file outside the selected folder.") }
                    _ = try LocalFiles.components(relative)
                    inspected += 1; guard inspected <= 10000, relative.split(separator: "/").count <= 64 else { throw DesktopError("Sync preview is limited to 10,000 entries and 64 directory levels. Choose a smaller folder.") }
                    if entry.isDirectory { directories.append(entry.path) }
                    else if entry.transferable {
                        progress("Checking server: " + relative)
                        guard let version = try await transfer.metadata(path: entry.path) else { throw DesktopError("A server file disappeared during preview. Preview again.") }
                        remote[relative] = version
                    } else { issues[relative] = entry.kind == "symlink" ? "Symbolic link · skipped" : "Unsupported or larger than 256 MiB · skipped" }
                }
                cursor = page.nextCursor
            } while cursor != nil
        }
        let paths = Set(local.keys).union(remote.keys).union(baseline.keys).union(issues.keys)
        // Avoid mapping two case-distinct server files onto a case-insensitive Mac volume.
        let grouped = Dictionary(grouping: paths, by: { $0.precomposedStringWithCanonicalMapping.lowercased() })
        for group in grouped.values where group.count > 1 { for path in group { issues[path] = "Case or Unicode filename collision · choose another folder" } }
        let items = paths.sorted().map { path in
            if let issue = issues[path] { return SyncItem(path: path, local: local[path], remote: remote[path], reason: issue, needsDecision: true, blocked: true, action: .none) }
            return Self.classify(path: path, local: local[path], remote: remote[path], baseline: baseline[path])
        }
        return SyncPlan(items: items, createdAt: Date(), localRoot: localRoot, remoteRoot: remoteRoot, scope: scope)
    }
    public func apply(_ plan: SyncPlan, progress: @escaping @Sendable (String, Double) -> Void) async throws -> Int {
        var completed = 0
        for item in plan.items {
            try Task.checkCancellation()
            let remotePath = Self.joined(plan.remoteRoot, item.path)
            if item.blocked { continue }
            switch item.action {
            case .none:
                // Equal, revalidated copies establish an initial baseline only
                // when the user applies this preview. Conflicts remain untouched.
                if let local = item.local, local.sha256 == item.remote?.sha256,
                   try LocalFiles.version(root: plan.localRoot, path: item.path) == local,
                   try await transfer.metadata(path: remotePath) == item.remote {
                    try await baselines.confirm(item.path, hash: local.sha256, scope: plan.scope)
                }
                continue
            case .upload:
                guard let source = item.local else { throw DesktopError("The preview has no Mac source for this transfer.") }
                try await transfer.upload(root: plan.localRoot, localPath: item.path, remotePath: remotePath, source: source, expectedRemote: item.remote) { progress(item.path, $0) }
                try await baselines.confirm(item.path, hash: source.sha256, scope: plan.scope)
            case .download:
                guard let source = item.remote else { throw DesktopError("The preview has no server source for this transfer.") }
                try await transfer.download(remotePath: remotePath, root: plan.localRoot, localPath: item.path, source: source, expectedLocal: item.local) { progress(item.path, $0) }
                try await baselines.confirm(item.path, hash: source.sha256, scope: plan.scope)
            }
            completed += 1
        }
        return completed
    }
}
