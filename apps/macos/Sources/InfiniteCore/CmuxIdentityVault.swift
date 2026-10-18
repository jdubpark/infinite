import Foundation
import Security
import Darwin

/// Identity and daemon pins are kept together in a device-only Keychain item.
/// Plaintext files exist only in a private directory while cmux is connected.
struct CmuxIdentityVault {
    let profileID: String
    private let service = "dev.infinite.desktop.cmux.identity"
    private let files = ["client/client-identity.json", "client/known-daemons.json"]

    func materialize() throws -> URL {
        guard !profileID.isEmpty, profileID.utf8.count <= 128 else {
            throw CmuxTransportError.invalidConfiguration("The cmux profile identifier is invalid.")
        }
        var template = Array("/tmp/infinite-cmux.XXXXXX".utf8CString)
        guard let path = mkdtemp(&template) else {
            throw CmuxTransportError.failed("Could not create a private cmux runtime directory.")
        }
        let directory = URL(fileURLWithPath: String(cString: path), isDirectory: true)
        do {
            var query = baseQuery
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
            if let data = item as? Data {
                let archive = try JSONDecoder().decode([String: Data].self, from: data)
                guard Set(archive.keys).isSubset(of: Set(files)), archive.values.reduce(0, { $0 + $1.count }) <= 1024 * 1024 else {
                    throw CmuxTransportError.failed("The saved cmux identity is invalid.")
                }
                for (name, content) in archive {
                    let file = directory.appendingPathComponent(name)
                    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    try content.write(to: file, options: [.atomic])
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                }
            }
            return directory
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    func save(from directory: URL) throws {
        var archive: [String: Data] = [:]
        for name in files {
            let file = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 1024 * 1024 else {
                throw CmuxTransportError.failed("A cmux identity file has an invalid type or size.")
            }
            archive[name] = try Data(contentsOf: file)
        }
        // A failed first enrollment must not replace a previously saved identity
        // with an empty archive.
        guard !archive.isEmpty else { return }
        let payload = try JSONEncoder().encode(archive)
        let update = [kSecValueData as String: payload]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var query = baseQuery
            query[kSecValueData as String] = payload
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let created = SecItemAdd(query as CFDictionary, nil)
            guard created == errSecSuccess else { throw keychainError(created) }
        } else if status != errSecSuccess { throw keychainError(status) }
    }

    func eraseRuntime(_ directory: URL) throws {
        try FileManager.default.removeItem(at: directory)
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: profileID]
    }

    private func keychainError(_ status: OSStatus) -> CmuxTransportError {
        .failed("The cmux identity could not be secured in Keychain (\(status)).")
    }
}
