import Foundation
import CryptoKit
import Security

/// Compatibility with Infinite's existing remote-v1 protocol. It has no forward secrecy.
public struct RemoteHandshake {
    private let key: SymmetricKey
    public let hello: JSON
    private static let domain = "infinite-remote-v1"
    public init(token: String, machineID: String = "", nonce: Data? = nil) throws {
        guard (32...200).contains(token.utf8.count), token.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }),
              machineID.isEmpty || UUID(uuidString: machineID) != nil else { throw DesktopError("Use a valid paired device key and machine ID.") }
        key = SymmetricKey(data: SHA256.hash(data: Data(token.utf8)))
        var random = Data(count: 32)
        if let nonce { guard nonce.count == 32 else { throw DesktopError("Invalid nonce.") }; random = nonce }
        else {
            let result = random.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
            guard result == errSecSuccess else { throw DesktopError("Secure randomness is unavailable.") }
        }
        let proof = HMAC<SHA256>.authenticationCode(for: try JSON.array([.string(Self.domain), .string("client"), .string(machineID), .string(random.hex)]).data(), using: key)
        hello = .object(["type": .string("hello"), "version": .number(1), "machineId": .string(machineID), "nonce": .string(random.hex), "proof": .string(Data(proof).hex)])
    }
    public func accept(_ welcome: JSON, pinnedMachineID: String? = nil) throws -> RemoteCipher {
        let serverID = welcome["machineId"].string
        guard welcome.object.count == 5, welcome["type"].string == "welcome", welcome["version"].int == 1,
              UUID(uuidString: serverID) != nil, welcome["nonce"].string.count == 64,
              Data(hex: welcome["nonce"].string) != nil, let proof = Data(hex: welcome["proof"].string), proof.count == 32,
              hello["machineId"].string.isEmpty || hello["machineId"].string == serverID,
              pinnedMachineID == nil || pinnedMachineID == serverID else { throw DesktopError("The server identity or handshake is invalid. Pair again only after checking the server.", code: "identity-failed") }
        let transcript = try JSON.array([.string(Self.domain), hello["machineId"], .string(serverID), hello["nonce"], welcome["nonce"], hello["proof"]]).data()
        let proofData = try JSON.array([.string(Self.domain), .string("server"), .string(transcript.hex)]).data()
        guard HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: proofData, using: key) else { throw DesktopError("Server authentication failed.", code: "identity-failed") }
        let context = Data(SHA256.hash(data: transcript))
        let material = HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: context, info: Data("\(Self.domain):directional-keys".utf8), outputByteCount: 64)
        let bytes = material.withUnsafeBytes { Data($0) }
        return RemoteCipher(sendKey: SymmetricKey(data: bytes.prefix(32)), receiveKey: SymmetricKey(data: bytes.suffix(32)), context: context, machineID: serverID)
    }
}

public struct RemoteCipher {
    private let sendKey: SymmetricKey
    private let receiveKey: SymmetricKey
    private let context: Data
    public let machineID: String
    private var sent: UInt64 = 0
    private var received: UInt64 = 0
    fileprivate init(sendKey: SymmetricKey, receiveKey: SymmetricKey, context: Data, machineID: String) {
        self.sendKey = sendKey; self.receiveKey = receiveKey; self.context = context; self.machineID = machineID
    }
    private func nonce(_ sequence: UInt64) throws -> AES.GCM.Nonce {
        var n = sequence.bigEndian
        let data = Data(repeating: 0, count: 4) + withUnsafeBytes(of: &n) { Data($0) }
        return try AES.GCM.Nonce(data: data)
    }
    private func aad(_ direction: String, _ sequence: UInt64) throws -> Data {
        try JSON.array([.string("infinite-remote-v1"), .string(context.hex), .string(direction), .number(Double(sequence))]).data()
    }
    public mutating func seal(_ message: JSON) throws -> JSON {
        let data = try message.data()
        guard data.count <= 96 * 1024, sent < 9_007_199_254_740_991 else { throw DesktopError("The encrypted request is too large.") }
        let box = try AES.GCM.seal(data, using: sendKey, nonce: nonce(sent), authenticating: aad("client", sent))
        let result: JSON = .object(["type": .string("ciphertext"), "seq": .number(Double(sent)), "data": .string((box.ciphertext + box.tag).hex)])
        sent += 1; return result
    }
    public mutating func open(_ frame: JSON) throws -> JSON {
        guard frame.object.count == 3, frame["type"].string == "ciphertext", frame["seq"].number == Double(received),
              frame["data"].string.count <= 8 * 1024 * 1024 + 4096,
              let bytes = Data(hex: frame["data"].string), bytes.count >= 16 else { throw DesktopError("Invalid or replayed encrypted message.", code: "integrity-failed") }
        let box = try AES.GCM.SealedBox(nonce: nonce(received), ciphertext: bytes.dropLast(16), tag: bytes.suffix(16))
        let clear = try AES.GCM.open(box, using: receiveKey, authenticating: aad("server", received))
        let result = try JSON.parse(clear); received += 1; return result
    }
}
