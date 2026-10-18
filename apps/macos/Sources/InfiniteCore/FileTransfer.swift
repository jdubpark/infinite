import Foundation
import CryptoKit
import Darwin

public struct FileEntry: Identifiable, Sendable {
    public let path: String
    public let name: String
    public let kind: String
    public let size: Int
    public let modifiedAt: String
    public var id: String { path }
    public var isDirectory: Bool { kind == "directory" }
    public var transferable: Bool { kind == "file" && size <= FileTransfer.maximumBytes }
    public init(path: String, name: String, kind: String, size: Int, modifiedAt: String = "") {
        self.path = path; self.name = name; self.kind = kind; self.size = size; self.modifiedAt = modifiedAt
    }
    init(_ value: JSON) {
        self.init(path: value["path"].string, name: value["name"].string, kind: value["kind"].string, size: value["size"].int, modifiedAt: value["modifiedAt"].string)
    }
}

public struct FilePage: Sendable {
    public let entries: [FileEntry]
    public let nextCursor: String?
    public let total: Int
}

public struct FileVersion: Codable, Equatable, Sendable {
    public let sha256: String
    public let size: Int
    /// Local identity includes timestamps and inode; remote identity uses a content hash.
    public let stamp: String?
    public init(sha256: String, size: Int, stamp: String? = nil) { self.sha256 = sha256; self.size = size; self.stamp = stamp }
}

public enum LocalFiles {
    /// Resolve once when the user chooses an existing root. Foundation URL
    /// standardization collapses canonical system paths back to symbolic aliases.
    public static func canonicalRoot(_ selected: URL) throws -> URL {
        guard let resolved = realpath(selected.path, nil) else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    }
    public static func components(_ relative: String) throws -> [String] {
        guard !relative.hasPrefix("/"), !relative.contains("\\"), !relative.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw DesktopError("Choose a relative file path.") }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard relative.isEmpty || parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw DesktopError("The file path contains an unsafe component.") }
        return relative.isEmpty ? [] : parts
    }
    private static func info(_ url: URL) throws -> stat? {
        var value = stat()
        if lstat(url.path, &value) == 0 { return value }
        if errno == ENOENT { return nil }
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    fileprivate static func kind(_ info: stat) -> String {
        switch info.st_mode & S_IFMT { case S_IFREG: return "file"; case S_IFDIR: return "directory"; case S_IFLNK: return "symlink"; default: return "other" }
    }
    fileprivate static func stamp(_ s: stat) -> String {
        "\(s.st_dev):\(s.st_ino):\(s.st_size):\(s.st_mtimespec.tv_sec):\(s.st_mtimespec.tv_nsec):\(s.st_ctimespec.tv_sec):\(s.st_ctimespec.tv_nsec)"
    }
    public static func location(root: URL, path: String, createParents: Bool = false) throws -> URL {
        let parts = try components(path)
        // The folder picker resolves the trusted root once. Revalidate every
        // ancestor on each operation so later symlink replacements fail closed.
        var current = URL(fileURLWithPath: "/", isDirectory: true)
        for part in root.pathComponents.dropFirst() {
            current.appendPathComponent(part)
            guard let value = try info(current), kind(value) == "directory" else { throw DesktopError("The selected folder moved or contains a symbolic link. Choose it again.", code: "local-conflict") }
        }
        for (index, part) in parts.enumerated() {
            current.appendPathComponent(part)
            var value = try info(current)
            if value == nil && index < parts.count - 1 && createParents {
                try FileManager.default.createDirectory(at: current, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                value = try info(current)
            }
            if let value {
                guard kind(value) != "symlink" else { throw DesktopError("Symbolic links are not followed or replaced.", code: "local-conflict") }
                if index < parts.count - 1 && kind(value) != "directory" { throw DesktopError("A parent path is no longer a folder.", code: "local-conflict") }
            } else if index < parts.count - 1 { throw DesktopError("A parent folder is missing.", code: "local-conflict") }
        }
        return current
    }
    public static func list(root: URL, path: String) throws -> [FileEntry] {
        let directory = try location(root: root, path: path)
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter {
            !$0.lastPathComponent.hasPrefix(".infinite-desktop-")
        }.map { url in
            guard let value = try info(url) else { throw DesktopError("The folder changed. Refresh its listing.") }
            let name = url.lastPathComponent
            return FileEntry(path: path.isEmpty ? name : path + "/" + name, name: name, kind: kind(value), size: Int(value.st_size))
        }.sorted { ($0.isDirectory ? 0 : 1, $0.name) < ($1.isDirectory ? 0 : 1, $1.name) }
    }
    public static func version(root: URL, path: String) throws -> FileVersion? {
        let parent = try openParent(root: root, path: path)
        defer { close(parent) }
        return try version(parent: parent, name: URL(fileURLWithPath: path).lastPathComponent)
    }
    fileprivate static func openParent(root: URL, path: String, createParents: Bool = false) throws -> Int32 {
        let parts = try components(path)
        guard !parts.isEmpty else { throw DesktopError("Choose a file inside the selected folder.") }
        let ancestors = root.pathComponents.dropFirst()
        guard ancestors.allSatisfy({ $0 != "." && $0 != ".." }) else { throw DesktopError("Choose the folder again.", code: "local-conflict") }
        var current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard current >= 0 else { throw POSIXError(.EIO) }
        do {
            for (index, part) in (Array(ancestors) + parts.dropLast()).enumerated() {
                var next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0 && errno == ENOENT && createParents && index >= ancestors.count {
                    guard mkdirat(current, part, 0o700) == 0 || errno == EEXIST else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                    next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard next >= 0 else { throw DesktopError("A parent folder moved, is missing, or contains a symbolic link. Choose it again.", code: "local-conflict") }
                close(current); current = next
            }
            return current
        } catch { close(current); throw error }
    }
    fileprivate static func info(parent: Int32, name: String) throws -> stat? {
        var value = stat()
        if fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0 { return value }
        if errno == ENOENT { return nil }
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    fileprivate static func version(parent: Int32, name: String) throws -> FileVersion? {
        guard let expected = try info(parent: parent, name: name) else { return nil }
        guard kind(expected) == "file", expected.st_size <= FileTransfer.maximumBytes else { throw DesktopError("Choose a regular file of at most 256 MiB.") }
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var initial = stat(); guard fstat(fd, &initial) == 0, stamp(initial) == stamp(expected) else { throw DesktopError("The local file changed while opening it.", code: "local-conflict") }
        var digest = SHA256(), count = 0
        while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty {
            try Task.checkCancellation(); digest.update(data: data); count += data.count
            if count > FileTransfer.maximumBytes { throw DesktopError("File transfer is limited to 256 MiB.") }
        }
        var final = stat()
        guard fstat(fd, &final) == 0, stamp(initial) == stamp(final), let current = try info(parent: parent, name: name), stamp(current) == stamp(initial), count == Int(initial.st_size) else { throw DesktopError("The local file changed while reading it.", code: "local-conflict") }
        return FileVersion(sha256: Data(digest.finalize()).hex, size: count, stamp: stamp(initial))
    }
    public static func privateDirectory(_ name: String) throws -> URL {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = support.appendingPathComponent("InfiniteDesktop", isDirectory: true).appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        return try canonicalRoot(root)
    }
    static func stage(root: URL, path: String) throws -> LocalDownload { try LocalDownload(root: root, path: path) }
    static func install(_ staged: LocalDownload, expected: FileVersion?) throws {
        var coordinationError: NSError?, result: Result<Void, Error> = .success(())
        NSFileCoordinator().coordinate(writingItemAt: staged.destination, options: .forReplacing, error: &coordinationError) { _ in
            result = Result { try staged.install(expected: expected) }
        }
        if let coordinationError { throw coordinationError }; try result.get()
    }
}

/// Directory descriptors keep transfers anchored even if a Finder move or editor
/// renames an ancestor. Replacements preserve the actual displaced inode, including
/// subsequent writes by an editor that still has that file open.
final class LocalDownload {
    let destination: URL
    let handle: FileHandle
    private let root: URL, path: String, name: String, directoryName: String
    private let parent: Int32, directory: Int32
    private var preserve = false
    init(root: URL, path: String) throws {
        self.root = root; self.path = path; name = URL(fileURLWithPath: path).lastPathComponent
        destination = root.appendingPathComponent(path)
        parent = try LocalFiles.openParent(root: root, path: path, createParents: true)
        directoryName = ".infinite-desktop-recovery-" + UUID().uuidString
        guard mkdirat(parent, directoryName, 0o700) == 0 else { let code = errno; close(parent); throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
        directory = openat(parent, directoryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { let code = errno; unlinkat(parent, directoryName, AT_REMOVEDIR); close(parent); throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
        let fd = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { let code = errno; close(directory); unlinkat(parent, directoryName, AT_REMOVEDIR); close(parent); throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
    deinit {
        try? handle.close()
        if !preserve { unlinkat(directory, name, 0); unlinkat(parent, directoryName, AT_REMOVEDIR) }
        close(directory); close(parent)
    }
    private func validateParent() throws {
        let current = try LocalFiles.openParent(root: root, path: path)
        defer { close(current) }
        var before = stat(), after = stat()
        guard fstat(parent, &before) == 0, fstat(current, &after) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino else { throw DesktopError("The destination folder moved during transfer. Preview again.", code: "local-conflict") }
    }
    private func sameFile(_ before: stat, _ after: stat) -> Bool {
        // Atomic rename changes ctime. Identity, size and mtime remain comparable.
        before.st_dev == after.st_dev && before.st_ino == after.st_ino && before.st_size == after.st_size &&
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec
    }
    func install(expected: FileVersion?) throws {
        try validateParent()
        guard try LocalFiles.version(parent: parent, name: name) == expected else { throw DesktopError("The destination changed since preview. No file was replaced.", code: "local-conflict") }
        let previous = try LocalFiles.info(parent: parent, name: name)
        guard previous.map(LocalFiles.stamp) == expected?.stamp else { throw DesktopError("The destination changed before replacement.", code: "local-conflict") }
        if let previous {
            guard fchmod(handle.fileDescriptor, previous.st_mode & 0o777) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        try handle.synchronize()
        var incoming = stat(); guard fstat(handle.fileDescriptor, &incoming) == 0 else { throw POSIXError(.EIO) }
        try validateParent()
        if let expected, let previous {
            guard renameatx_np(directory, name, parent, name, UInt32(RENAME_SWAP)) == 0 else { throw DesktopError("The destination changed or this volume cannot replace files safely. No file was replaced.", code: "local-conflict") }
            preserve = true
            do {
                let displaced = try LocalFiles.version(parent: directory, name: name)
                guard let actual = try LocalFiles.info(parent: directory, name: name), sameFile(previous, actual),
                      displaced?.sha256 == expected.sha256, displaced?.size == expected.size,
                      let installed = try LocalFiles.info(parent: parent, name: name), sameFile(incoming, installed) else { throw DesktopError("The destination changed during replacement.", code: "local-conflict") }
                try validateParent()
            } catch {
                // Exchange again to restore the displaced file. If another writer
                // replaced our download, its version is also retained, never unlinked.
                let restored = renameatx_np(directory, name, parent, name, UInt32(RENAME_SWAP)) == 0
                throw DesktopError(restored ? "A concurrent edit was detected and the previous file restored. Both copies are kept in \(directoryName). Preview again." : "The destination changed during replacement. The displaced file is kept in \(directoryName); review it before continuing.", code: "local-conflict")
            }
        } else {
            guard linkat(directory, name, parent, name, 0) == 0 else { throw DesktopError("The destination appeared or could not be written. No file was replaced.", code: "local-conflict") }
            do { try validateParent() } catch { preserve = true; throw error }
        }
        guard fsync(directory) == 0, fsync(parent) == 0 else { preserve = true; throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}

public struct FileTransfer: Sendable {
    public static let chunkBytes = 48 * 1024
    public static let maximumBytes = 256 * 1024 * 1024
    public let client: RemoteClient
    public let projectID: String
    public init(client: RemoteClient, projectID: String) { self.client = client; self.projectID = projectID }
    private var prefix: String { "/projects/" + projectID }
    private func query(_ path: String, _ values: [String: String]) -> String {
        var url = URLComponents(); url.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return path + "?" + (url.percentEncodedQuery ?? "")
    }
    public func list(path: String, cursor: String? = nil) async throws -> FilePage {
        _ = try LocalFiles.components(path)
        var values = ["path": path, "limit": "200"]; if let cursor { values["cursor"] = cursor }
        let value = try await client.request(query(prefix + "/files", values))
        return FilePage(entries: value["entries"].array.map(FileEntry.init), nextCursor: value["nextCursor"].string.isEmpty ? nil : value["nextCursor"].string, total: value["total"].int)
    }
    public func metadata(path: String) async throws -> FileVersion? {
        _ = try LocalFiles.components(path)
        do {
            let value = try await client.request(query(prefix + "/file", ["path": path, "offset": "0", "length": "0"]))
            guard value["sha256"].string.count == 64, value["totalBytes"].int <= Self.maximumBytes else { throw DesktopError("The server returned invalid file metadata.") }
            return FileVersion(sha256: value["sha256"].string, size: value["totalBytes"].int)
        } catch let error as DesktopError where error.status == 404 { return nil }
    }
    public func createDirectory(path: String) async throws {
        if path.isEmpty { return }; _ = try LocalFiles.components(path)
        _ = try await client.request(prefix + "/directories", body: .object(["path": .string(path)]))
    }
    public func upload(root: URL, localPath: String, remotePath: String, source: FileVersion, expectedRemote: FileVersion?, progress: @escaping @Sendable (Double) -> Void) async throws {
        try Task.checkCancellation()
        guard try LocalFiles.version(root: root, path: localPath) == source else { throw DesktopError("The local source changed since preview.", code: "local-conflict") }
        guard try await metadata(path: remotePath) == expectedRemote else { throw DesktopError("The server destination changed since preview.", code: "file-conflict") }
        if let expectedRemote, expectedRemote.sha256 != source.sha256 {
            let backup = try LocalFiles.privateDirectory("Recovered Files").appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try await download(remotePath: remotePath, root: backup, localPath: URL(fileURLWithPath: remotePath).lastPathComponent, source: expectedRemote, expectedLocal: nil, progress: { _ in })
        }
        let parent = remotePath.split(separator: "/").dropLast().joined(separator: "/")
        try await createDirectory(path: parent)
        let begun = try await client.request(prefix + "/uploads", body: .object(["path": .string(remotePath), "size": .number(Double(source.size)), "sha256": .string(source.sha256), "expectedHash": expectedRemote.map { .string($0.sha256) } ?? .null]))
        let id = begun["uploadId"].string
        guard UUID(uuidString: id) != nil else { throw DesktopError("The server returned an invalid upload receipt.") }
        do {
            let url = try LocalFiles.location(root: root, path: localPath)
            let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
            guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
            var offset = 0, digest = SHA256()
            while let bytes = try handle.read(upToCount: Self.chunkBytes), !bytes.isEmpty {
                try Task.checkCancellation(); digest.update(data: bytes)
                guard offset + bytes.count <= source.size else { throw DesktopError("The source grew during upload.", code: "local-conflict") }
                let receipt = try await client.request(prefix + "/uploads/" + id, body: .object(["offset": .number(Double(offset)), "base64": .string(bytes.base64EncodedString())]), method: "PUT")
                offset += bytes.count
                guard receipt["offset"].int == offset else { throw DesktopError("The server did not confirm this upload chunk.") }
                progress(Double(offset) / Double(max(1, source.size)))
            }
            guard offset == source.size, Data(digest.finalize()).hex == source.sha256,
                  try LocalFiles.version(root: root, path: localPath) == source else { throw DesktopError("The source changed during upload; it was not committed.", code: "local-conflict") }
            try Task.checkCancellation()
            let committed = try await client.request(prefix + "/uploads/" + id + "/commit", body: .object([:]))
            guard committed["sha256"].string == source.sha256 else { throw DesktopError("The server did not confirm the uploaded hash.") }
            progress(1)
        } catch {
            // Cancel only this staging object. A lost commit receipt is never replayed.
            _ = try? await client.request(prefix + "/uploads/" + id, method: "DELETE")
            throw error
        }
    }
    public func download(remotePath: String, root: URL, localPath: String, source: FileVersion, expectedLocal: FileVersion?, progress: @escaping @Sendable (Double) -> Void) async throws {
        try Task.checkCancellation()
        let staged = try LocalFiles.stage(root: root, path: localPath)
        guard try LocalFiles.version(root: root, path: localPath) == expectedLocal else { throw DesktopError("The local destination changed since preview.", code: "local-conflict") }
        let handle = staged.handle
        var offset = 0, digest = SHA256()
        repeat {
            try Task.checkCancellation()
            let value = try await client.request(query(prefix + "/file", ["path": remotePath, "offset": String(offset), "length": String(Self.chunkBytes), "sha256": source.sha256]))
            guard value["sha256"].string == source.sha256, value["totalBytes"].int == source.size, value["offset"].int == offset,
                  let bytes = Data(base64Encoded: value["base64"].string), bytes.count <= Self.chunkBytes,
                  offset + bytes.count <= source.size, value["nextOffset"].int == offset + bytes.count,
                  !bytes.isEmpty || offset == source.size else { throw DesktopError("The server returned an inconsistent file chunk.", code: "file-conflict") }
            try handle.write(contentsOf: bytes); digest.update(data: bytes); offset += bytes.count
            progress(Double(offset) / Double(max(1, source.size)))
        } while offset < source.size
        guard Data(digest.finalize()).hex == source.sha256 else { throw DesktopError("The downloaded file failed its integrity check.") }
        try handle.synchronize(); try Task.checkCancellation()
        try LocalFiles.install(staged, expected: expectedLocal)
        progress(1)
    }
}
