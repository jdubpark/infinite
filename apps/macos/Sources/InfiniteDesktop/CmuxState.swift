import Foundation
import InfiniteCore

struct CmuxHostProfile: Codable, Identifiable {
    var id = UUID().uuidString
    var label: String
    var route: String
}

struct CmuxTerminalRow: Identifiable {
    let value: JSON
    let workspace: String
    let agent: JSON
    var id: String { value["id"].string }
    var title: String { value["title"].string.isEmpty ? "Terminal" : value["title"].string }
    var cwd: String { value["cwd"].string }
    var running: Bool { value["running"].bool }
    var status: String { running ? "Process running" : value["lifecycle"].string.isEmpty ? "Not running" : value["lifecycle"].string }
}

struct CmuxPendingCreation: Codable, Equatable {
    var id: String
    var argv: [String]
    var cwd: String
    var name: String
}

enum CmuxConnectionPhase: Equatable {
    case disconnected
    case connecting(generation: UUID, statusText: String)
    case connected(generation: UUID, statusText: String, reachable: Bool)
    case disconnecting

    var generation: UUID? {
        switch self {
        case .disconnected, .disconnecting: return nil
        case .connecting(let generation, _), .connected(let generation, _, _): return generation
        }
    }

    var statusText: String {
        switch self {
        case .disconnected, .disconnecting: return "Disconnected"
        case .connecting(_, let status), .connected(_, let status, _): return status
        }
    }

    var hasConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    var isConnected: Bool {
        if case .connected(_, _, let reachable) = self { return reachable }
        return false
    }

    var isConnecting: Bool {
        if case .connecting = self { return true }
        return false
    }

    var isDisconnecting: Bool {
        if case .disconnecting = self { return true }
        return false
    }
}

enum CmuxInputMode: Equatable {
    case disabled
    case promptOnly
    case directKeys
}

enum CmuxAttachmentState {
    case none
    case attaching(
        id: String,
        profileID: String,
        generation: UUID,
        rendererGeneration: UUID,
        buffer: CmuxOutputBuffer,
        snapshotReceived: Bool,
        snapshotReady: Bool
    )
    case attached(
        id: String,
        profileID: String,
        generation: UUID,
        rendererGeneration: UUID,
        buffer: CmuxOutputBuffer,
        snapshotReceived: Bool,
        snapshotReady: Bool,
        input: CmuxInputMode
    )
    case detached(id: String, profileID: String, rendererGeneration: UUID)

    var selectedID: String? {
        switch self {
        case .none: return nil
        case .attaching(let id, _, _, _, _, _, _),
             .attached(let id, _, _, _, _, _, _, _),
             .detached(let id, _, _):
            return id
        }
    }

    var attachedProfileID: String {
        switch self {
        case .none: return ""
        case .attaching(_, let profileID, _, _, _, _, _),
             .attached(_, let profileID, _, _, _, _, _, _),
             .detached(_, let profileID, _):
            return profileID
        }
    }

    var generation: UUID? {
        switch self {
        case .none, .detached: return nil
        case .attaching(_, _, let generation, _, _, _, _),
             .attached(_, _, let generation, _, _, _, _, _):
            return generation
        }
    }

    var rendererGeneration: UUID? {
        switch self {
        case .none: return nil
        case .attaching(_, _, _, let rendererGeneration, _, _, _),
             .attached(_, _, _, let rendererGeneration, _, _, _, _),
             .detached(_, _, let rendererGeneration):
            return rendererGeneration
        }
    }

    var buffer: CmuxOutputBuffer? {
        switch self {
        case .none, .detached: return nil
        case .attaching(_, _, _, _, let buffer, _, _),
             .attached(_, _, _, _, let buffer, _, _, _):
            return buffer
        }
    }

    var isAttached: Bool {
        if case .attached = self { return true }
        return false
    }

    var isAttaching: Bool {
        if case .attaching = self { return true }
        return false
    }

    var snapshotReady: Bool {
        switch self {
        case .attaching(_, _, _, _, _, _, let ready),
             .attached(_, _, _, _, _, _, let ready, _):
            return ready
        case .none, .detached:
            return false
        }
    }

    var inputMode: CmuxInputMode {
        if case .attached(_, _, _, _, _, _, _, let input) = self { return input }
        return .disabled
    }
}

enum CmuxOperation: Equatable {
    case idle
    case attaching(UUID)
    case sending(UUID)
    case mutating
}

enum CmuxCreationState: Equatable {
    case idle
    case pending(CmuxPendingCreation)
    case clearing(previous: CmuxPendingCreation)

    var pending: CmuxPendingCreation? {
        if case .pending(let item) = self { return item }
        return nil
    }

    var isVisiblePending: Bool {
        switch self {
        case .idle: return false
        case .pending, .clearing: return true
        }
    }
}
