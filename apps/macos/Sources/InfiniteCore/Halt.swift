import Foundation

public struct HaltState: Equatable, Sendable {
    public enum Scope: Equatable, Sendable {
        case host
        case project(String)
    }

    public let haltID: String
    public let scope: Scope
    public let at: String
    public let reason: String?
    public let by: String

    public var projectID: String? {
        if case .project(let id) = scope { return id }
        return nil
    }

    init(_ value: JSON, scope: Scope) {
        haltID = value["haltId"].string
        self.scope = scope
        at = value["at"].string
        by = value["by"].string
        let reason = value["reason"].string.trimmingCharacters(in: .whitespacesAndNewlines)
        self.reason = reason.isEmpty ? nil : reason
    }
}

public struct HaltView: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case readable(host: HaltState?, projects: [HaltState])
        case unreadable
    }

    public let state: State

    public var readable: Bool {
        if case .readable = state { return true }
        return false
    }

    public var host: HaltState? {
        if case .readable(let host, _) = state { return host }
        return nil
    }

    public var projects: [HaltState] {
        if case .readable(_, let projects) = state { return projects }
        return []
    }

    public init(_ value: JSON) {
        if value["readable"] == .bool(false) {
            state = .unreadable
            return
        }
        let host = value["host"].object.isEmpty ? nil : HaltState(value["host"], scope: .host)
        let projects: [HaltState] = value["projects"].array.compactMap { entry in
            let projectID = entry["projectId"].string
            return projectID.isEmpty ? nil : HaltState(entry, scope: .project(projectID))
        }
        state = .readable(host: host, projects: projects)
    }

    public static let clear = HaltView(.null)

    public var holdsHost: Bool {
        switch state {
        case .unreadable: return true
        case .readable(let host, _): return host != nil
        }
    }

    public func projects(covering ids: [String]) -> [HaltState] {
        projects.filter { $0.projectID.map(ids.contains) ?? false }
    }
}
