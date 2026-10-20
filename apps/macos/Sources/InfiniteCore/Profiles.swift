import Foundation
import Security

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
    public static let service = "dev.infinite.desktop.device"
    public static func save(_ token: String, for id: String, service: String = service) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
        let update: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        let result = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if result == errSecItemNotFound {
            let added = query.merging(update) { _, new in new }.merging([kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, new in new }
            guard SecItemAdd(added as CFDictionary, nil) == errSecSuccess else { throw DesktopError("The device key could not be saved in Keychain.") }
        } else if result != errSecSuccess { throw DesktopError("Keychain could not update the device key.") }
    }
    public static func read(_ id: String, service: String = service) throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data, let token = String(data: data, encoding: .utf8) else { throw DesktopError("Unlock Keychain or pair this device again.") }
        return token
    }
    public static func remove(_ id: String) throws {
        let status = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: id] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DesktopError("Keychain could not remove this device key.") }
    }
}
