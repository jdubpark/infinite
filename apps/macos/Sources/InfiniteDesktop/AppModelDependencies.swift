import Foundation
import InfiniteCore

struct PendingClearTarget: Equatable {
    let profileID: String
    let requestID: String
}

@MainActor final class DraftKeyQueue {
    private var tails: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    func run<T>(_ key: String, operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let previous = tails[key]?.task
        let token = UUID()
        let task = Task { @MainActor () async throws -> T in
            _ = await previous?.result
            return try await operation()
        }
        let waiter = Task { @MainActor in _ = await task.result }
        tails[key] = (token, waiter)
        defer { if tails[key]?.id == token { tails[key] = nil } }
        return try await task.value
    }
}

struct AppModelDependencies: Sendable {
    var loadProfiles: @Sendable () -> ([HostProfile], String)
    var saveProfiles: @Sendable ([HostProfile], String) -> Void
    var readToken: @Sendable (String) throws -> String
    var fetchIdentity: @Sendable (RemoteClient) async throws -> JSON
    var readDraft: @Sendable (String) async throws -> DraftRecord
    var saveDraft: @Sendable (DraftRecord, String) async throws -> Void
    var clearDraftIfMatching: @Sendable (String, String) async throws -> Void
    var sendRequest: @Sendable (RemoteClient, String, JSON) async throws -> JSON
    var closeClient: @Sendable (RemoteClient) async -> Void

    static let live = AppModelDependencies(
        loadProfiles: {
            let profiles: [HostProfile]
            if let data = UserDefaults.standard.data(forKey: "hostProfiles"), let value = try? JSONDecoder().decode([HostProfile].self, from: data) { profiles = value }
            else { profiles = [] }
            let activeID = UserDefaults.standard.string(forKey: "activeHost") ?? profiles.first?.id ?? ""
            return (profiles, activeID)
        },
        saveProfiles: { profiles, activeID in
            UserDefaults.standard.set(try? JSONEncoder().encode(profiles), forKey: "hostProfiles")
            UserDefaults.standard.set(activeID, forKey: "activeHost")
        },
        readToken: { try DeviceKeychain.read($0) },
        fetchIdentity: { try await $0.request("/me") },
        readDraft: { try await DraftStore.shared().read($0) },
        saveDraft: { try await DraftStore.shared().save($0, identity: $1) },
        clearDraftIfMatching: { try await DraftStore.shared().clearIfMatching(requestID: $0, identity: $1) },
        sendRequest: { try await $0.request($1, body: $2) },
        closeClient: { await $0.close() }
    )
}

struct SessionModelDependencies: Sendable {
    var readDraft: @Sendable (String) async throws -> DraftRecord
    var saveDraft: @Sendable (DraftRecord, String) async throws -> Void
    var acquireMutation: @Sendable (String, String) async throws -> DraftRecord
    var clearDraftIfMatching: @Sendable (String, String) async throws -> Void
    var sendRequest: @Sendable (RemoteClient, String, JSON?, String?) async throws -> JSON
    var openTerminal: @Sendable (RemoteClient, String, @escaping @Sendable (JSON) -> Void) async throws -> String
    var closeTerminal: @Sendable (RemoteClient, String) async -> Void
    var sendTerminal: @Sendable (RemoteClient, String, JSON) async throws -> Void

    static let live = SessionModelDependencies(
        readDraft: { try await DraftStore.shared().read($0) },
        saveDraft: { try await DraftStore.shared().save($0, identity: $1) },
        acquireMutation: { try await DraftStore.shared().readOrCreatePending(identity: $0, text: $1) },
        clearDraftIfMatching: { try await DraftStore.shared().clearIfMatching(requestID: $0, identity: $1) },
        sendRequest: { try await $0.request($1, body: $2, controlID: $3) },
        openTerminal: { try await $0.openTerminal(sessionID: $1, handler: $2) },
        closeTerminal: { await $0.closeTerminal($1) },
        sendTerminal: { try await $0.sendTerminal($1, message: $2) }
    )
}

struct CmuxViewModelDependencies: Sendable {
    var helperURL: @Sendable () -> URL
    var connect: @Sendable (String, String, URL, String?, @escaping @Sendable (JSON) -> Void) async throws -> Void
    var snapshot: @Sendable () async throws -> JSON
    var attach: @Sendable (String, @escaping @Sendable (CmuxTerminalOutput) -> Void) async throws -> Void
    var detach: @Sendable () async -> Void
    var disconnect: @Sendable () async throws -> Void
    var paste: @Sendable (String) async throws -> CmuxInputAcceptance
    var send: @Sendable (Data) async throws -> CmuxInputAcceptance
    var resize: @Sendable (Int, Int) async throws -> Void
    var createTerminal: @Sendable ([String], String, String, String) async throws -> String
    var closeTerminal: @Sendable (String, String) async throws -> Void
    var readDraft: @Sendable (String) async throws -> DraftRecord
    var saveDraft: @Sendable (DraftRecord, String) async throws -> Void
    var acquireMutation: @Sendable (String, String) async throws -> DraftRecord
    var clearDraftIfMatching: @Sendable (String, String) async throws -> Void

    static func live(backend: CmuxBackend = CmuxBackend()) -> CmuxViewModelDependencies {
        CmuxViewModelDependencies(
            helperURL: { Bundle.main.resourceURL?.appendingPathComponent("cmux") ?? URL(fileURLWithPath: "/nonexistent/cmux") },
            connect: { try await backend.connect(profileID: $0, route: $1, helperURL: $2, invitation: $3, onState: $4) },
            snapshot: { try await backend.snapshot() },
            attach: { try await backend.attach(terminalID: $0, onOutput: $1) },
            detach: { await backend.detach() },
            disconnect: { try await backend.disconnect() },
            paste: { try await backend.paste($0) },
            send: { try await backend.send($0) },
            resize: { try await backend.resize(columns: $0, rows: $1) },
            createTerminal: { try await backend.createTerminal(argv: $0, cwd: $1, name: $2, mutationID: $3).terminalID },
            closeTerminal: { try await backend.closeTerminal($0, mutationID: $1) },
            readDraft: { try await DraftStore.shared().read($0) },
            saveDraft: { try await DraftStore.shared().save($0, identity: $1) },
            acquireMutation: { try await DraftStore.shared().readOrCreatePending(identity: $0, text: $1) },
            clearDraftIfMatching: { try await DraftStore.shared().clearIfMatching(requestID: $0, identity: $1) }
        )
    }
}
