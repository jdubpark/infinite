import XCTest
import LocalAuthentication
import Security
@testable import InfiniteCore

final class KeychainTests: XCTestCase {
    func testKeychainQueriesAttachFreshNonInteractiveLAContext() throws {
        let matchQuery = KeychainQuery.match(service: "dev.infinite.test", account: "acct-1")
        let readQuery = KeychainQuery.read(service: "dev.infinite.test", account: "acct-1")
        let payload = Data("secret-token".utf8)
        let addQuery = KeychainQuery.add(service: "dev.infinite.test", account: "acct-1", data: payload)

        for query in [matchQuery, readQuery, addQuery] {
            XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
            XCTAssertEqual(query[kSecAttrService as String] as? String, "dev.infinite.test")
            XCTAssertEqual(query[kSecAttrAccount as String] as? String, "acct-1")
            let context = try XCTUnwrap(query[kSecUseAuthenticationContext as String] as? LAContext)
            XCTAssertTrue(context.interactionNotAllowed)
        }

        let matchContext = try XCTUnwrap(matchQuery[kSecUseAuthenticationContext as String] as? LAContext)
        let readContext = try XCTUnwrap(readQuery[kSecUseAuthenticationContext as String] as? LAContext)
        let addContext = try XCTUnwrap(addQuery[kSecUseAuthenticationContext as String] as? LAContext)
        XCTAssertFalse(matchContext === readContext)
        XCTAssertFalse(matchContext === addContext)
        XCTAssertFalse(readContext === addContext)

        XCTAssertEqual(readQuery[kSecReturnData as String] as? Bool, true)
        XCTAssertEqual(readQuery[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
        XCTAssertEqual(addQuery[kSecValueData as String] as? Data, payload)
        XCTAssertEqual(addQuery[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    }

    func testInteractionNotAllowedErrorsProduceClearActionableMessages() {
        let readError = DeviceKeychain.error(for: errSecInteractionNotAllowed, operation: .read)
        XCTAssertEqual(readError.code, "keychain-interaction-not-allowed")
        XCTAssertTrue(readError.message.contains("Keychain is locked"))
        XCTAssertTrue(readError.message.contains("Unlock Keychain"))

        let saveError = DeviceKeychain.error(for: errSecInteractionNotAllowed, operation: .save)
        XCTAssertEqual(saveError.code, "keychain-interaction-not-allowed")
        XCTAssertTrue(saveError.message.contains("Unlock Keychain"))

        let updateError = DeviceKeychain.error(for: errSecInteractionNotAllowed, operation: .update)
        XCTAssertEqual(updateError.code, "keychain-interaction-not-allowed")
        XCTAssertTrue(updateError.message.contains("Unlock Keychain"))

        let removeError = DeviceKeychain.error(for: errSecInteractionNotAllowed, operation: .remove)
        XCTAssertEqual(removeError.code, "keychain-interaction-not-allowed")
        XCTAssertTrue(removeError.message.contains("Unlock Keychain"))

        let genericReadError = DeviceKeychain.error(for: errSecItemNotFound, operation: .read)
        XCTAssertEqual(genericReadError.code, "failed")
        XCTAssertEqual(genericReadError.message, "Unlock Keychain or pair this device again.")

        let vault = CmuxIdentityVault(profileID: "profile-1")
        let lockedVaultError = vault.keychainError(errSecInteractionNotAllowed)
        XCTAssertTrue(lockedVaultError.localizedDescription.contains("Keychain is locked"))
        XCTAssertTrue(lockedVaultError.localizedDescription.contains("Unlock Keychain"))

        let otherVaultError = vault.keychainError(errSecAuthFailed)
        XCTAssertTrue(otherVaultError.localizedDescription.contains("\(errSecAuthFailed)"))
    }

    func testDeviceKeychainRoundTripsWithNonInteractiveContext() throws {
        let service = "dev.infinite.test.keychain.\(UUID().uuidString.lowercased())"
        let account = "device-token"
        defer { try? DeviceKeychain.remove(account, service: service) }

        try DeviceKeychain.save("initial-token", for: account, service: service)
        XCTAssertEqual(try DeviceKeychain.read(account, service: service), "initial-token")

        try DeviceKeychain.save("rotated-token", for: account, service: service)
        XCTAssertEqual(try DeviceKeychain.read(account, service: service), "rotated-token")

        try DeviceKeychain.remove(account, service: service)
        XCTAssertThrowsError(try DeviceKeychain.read(account, service: service))
    }
}
