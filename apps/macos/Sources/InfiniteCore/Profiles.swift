import Foundation
import LocalAuthentication
import Security

enum KeychainQuery {
    static func nonInteractiveContext() -> LAContext {
        let context = LAContext()
        context.interactionNotAllowed = true
        return context
    }

    static func match(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseAuthenticationContext as String: nonInteractiveContext(),
        ]
    }

    static func read(service: String, account: String) -> [String: Any] {
        var query = match(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return query
    }

    static func add(service: String, account: String, data: Data) -> [String: Any] {
        var query = match(service: service, account: account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return query
    }
}

public struct HostProfile: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var origin: String
    public var relayMachineID: String?
    public var pinnedMachineID: String?
    public init(id: String = UUID().uuidString.lowercased(), label: String, origin: String, relayMachineID: String? = nil, pinnedMachineID: String? = nil) {
        self.id = id; self.label = label; self.origin = origin; self.relayMachineID = relayMachineID; self.pinnedMachineID = pinnedMachineID
    }
    public func socketURL() throws -> URL {
        guard var url = URLComponents(string: origin), let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw DesktopError("Enter a bare HTTPS server or relay address. HTTP is allowed only on this Mac's loopback interface.")
        }
        if let relayMachineID, UUID(uuidString: relayMachineID) == nil { throw DesktopError("The relay machine ID is invalid.") }
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        url.path = relayMachineID.map { "/relay/clients/\($0)" } ?? "/api/remote"
        guard let result = url.url else { throw DesktopError("The server address is invalid.") }; return result
    }
}

public enum DeviceKeychain {
    enum Operation {
        case save
        case update
        case read
        case remove
    }

    public static let service = "dev.infinite.desktop.device"

    static func error(for status: OSStatus, operation: Operation) -> DesktopError {
        if status == errSecInteractionNotAllowed {
            switch operation {
            case .read:
                return DesktopError("Keychain is locked or requires permission. Unlock Keychain or pair this device again.", code: "keychain-interaction-not-allowed")
            case .save:
                return DesktopError("Keychain is locked or requires permission. Unlock Keychain to save the device key.", code: "keychain-interaction-not-allowed")
            case .update:
                return DesktopError("Keychain is locked or requires permission. Unlock Keychain to update the device key.", code: "keychain-interaction-not-allowed")
            case .remove:
                return DesktopError("Keychain is locked or requires permission. Unlock Keychain to remove this device key.", code: "keychain-interaction-not-allowed")
            }
        }
        switch operation {
        case .read:
            return DesktopError("Unlock Keychain or pair this device again.")
        case .save:
            return DesktopError("The device key could not be saved in Keychain.")
        case .update:
            return DesktopError("Keychain could not update the device key.")
        case .remove:
            return DesktopError("Keychain could not remove this device key.")
        }
    }

    public static func save(_ token: String, for id: String, service: String = service) throws {
        let data = Data(token.utf8)
        let query = KeychainQuery.match(service: service, account: id)
        let update: [String: Any] = [kSecValueData as String: data]
        let result = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if result == errSecItemNotFound {
            let added = KeychainQuery.add(service: service, account: id, data: data)
            let addResult = SecItemAdd(added as CFDictionary, nil)
            guard addResult == errSecSuccess else { throw error(for: addResult, operation: .save) }
        } else if result != errSecSuccess {
            throw error(for: result, operation: .update)
        }
    }

    public static func read(_ id: String, service: String = service) throws -> String {
        let query = KeychainQuery.read(service: service, account: id)
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { throw error(for: status, operation: .read) }
        guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
            throw DesktopError("Unlock Keychain or pair this device again.")
        }
        return token
    }

    public static func remove(_ id: String, service: String = service) throws {
        let query = KeychainQuery.match(service: service, account: id)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw error(for: status, operation: .remove) }
    }
}
