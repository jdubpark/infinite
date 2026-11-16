import Foundation

/// One halt the owner engaged: when, from which owner device, and the owner's reason when one was given.
public struct HaltState: Equatable, Sendable {
    public let haltID: String
    /// The halted host project, or nil for the whole host.
    public let projectID: String?
    /// ISO time the halt was engaged.
    public let at: String
    public let reason: String?
    /// The label of the owner device that engaged it.
    public let by: String
    init(_ value: JSON, projectID: String?) {
        haltID = value["haltId"].string; self.projectID = projectID; at = value["at"].string; by = value["by"].string
        let reason = value["reason"].string.trimmingCharacters(in: .whitespacesAndNewlines)
        self.reason = reason.isEmpty ? nil : reason
    }
}

/// `GET /api/halt`: what the owner's halt holds. While a halt holds, no new team member, coordinator, reviewer, or
/// routine occurrence starts in its scope, and the running work there is paused; the owner's own sessions keep running.
/// Releasing is the owner's host command; this app only shows the halt.
public struct HaltView: Equatable, Sendable {
    /// False when the host cannot read its halt record. The host then holds every launch until it can.
    public let readable: Bool
    public let host: HaltState?
    public let projects: [HaltState]
    public init(_ value: JSON) {
        // Only the host's explicit `false` means an unreadable record; a missing field is not a halt.
        readable = value["readable"] != .bool(false)
        host = value["host"].object.isEmpty ? nil : HaltState(value["host"], projectID: nil)
        projects = value["projects"].array.compactMap { entry in
            entry["projectId"].string.isEmpty ? nil : HaltState(entry, projectID: entry["projectId"].string)
        }
    }
    /// No halt: the state before the first report, and for a host without the halt route.
    public static let clear = HaltView(.null)
    /// The whole host is held, by the owner's host halt or because the host cannot read its record.
    public var holdsHost: Bool { !readable || host != nil }
    /// Project halts on any of these host projects, in the host's order.
    public func projects(covering ids: [String]) -> [HaltState] {
        projects.filter { $0.projectID.map(ids.contains) ?? false }
    }
}
