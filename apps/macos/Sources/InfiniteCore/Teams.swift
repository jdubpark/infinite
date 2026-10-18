import Foundation

/// One team run as the host reports it: a coordinator's plan, the members working on it, the
/// decisions waiting on a person, and the host's own check and review evidence. Values are read
/// on demand from the host's JSON so fields this app does not know pass through untouched.
public struct TeamRun: Identifiable, Equatable, Sendable {
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var title: String { value["title"].string }
    public var status: String { value["status"].string }
    public var revision: Int { value["revision"].int }
    public var projectID: String { value["projectId"].string }
    public var provider: String { value["provider"].string }
    public var objective: String { value["objective"].string }
    public var parallelism: Int { value["parallelism"].int }
    public var createdAt: String { value["createdAt"].string }
    public var updatedAt: String { value["updatedAt"].string }
    public var reason: String { value["reason"].string }
    public var branch: String { value["branch"].string }
    public var workspace: String { value["workspace"].string }
    public var baseCommit: String { value["baseCommit"].string }
    public var headCommit: String { value["headCommit"].string }
    public var tasks: [JSON] { value["tasks"].array }
    public var members: [JSON] { value["members"].array }
    public var decisions: [JSON] { value["decisions"].array }
    public var checks: [JSON] { value["checks"].array }
    public var steering: [JSON] { value["steering"].array }
    public var events: [JSON] { value["events"].array }
    public var review: JSON { value["review"] }
    public var lineup: JSON { value["lineup"] }
    public var hasLineup: Bool { lineup != .null }
    /// Questions of the current revision that nobody has answered yet.
    public var openDecisions: [JSON] { decisions.filter { $0["revision"].int == revision && $0["answer"] == .null } }
    public var answeredDecisions: [JSON] { decisions.filter { $0["answer"] != .null } }
    /// Members of the current revision whose agent sessions are live.
    public var activeMembers: [JSON] { members.filter { $0["revision"].int == revision && ["running", "waiting"].contains($0["status"].string) } }
    public var needsYou: Bool { status == "needs-input" }
    /// The run is over: either ready for a person's review or cancelled.
    public var finished: Bool { ["ready-for-review", "cancelled"].contains(status) }
    /// Agents are working or the host is integrating, checking, or reviewing.
    public var working: Bool { ["planning", "implementing", "integrating", "verifying", "reviewing"].contains(status) }
    public var statusLabel: String { Self.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static let labels: [String: String] = [
        "planning": "Planning", "implementing": "Implementing", "integrating": "Integrating", "verifying": "Running checks",
        "reviewing": "Reviewing", "needs-input": "Needs your input", "paused": "Paused", "blocked": "Blocked",
        "ready-for-review": "Ready for your review", "cancelled": "Cancelled",
    ]
    public static func roleName(_ role: String) -> String {
        ["project-manager": "Coordinator", "implementer": "Implementer", "integrator": "Integrator", "reviewer": "Reviewer"][role] ?? role.capitalizedFirstLetter
    }
    /// Integrated tasks out of the planned total; zero total means no plan has been reported yet.
    public var progress: (integrated: Int, total: Int) {
        (tasks.filter { $0["status"].string == "integrated" }.count, tasks.count)
    }
    /// One line for a list row: the state, then what it is waiting on or how far the plan got.
    public var summaryLine: String {
        let open = openDecisions.count
        if needsYou && open > 0 { return "\(statusLabel) · \(open == 1 ? "1 decision" : "\(open) decisions")" }
        let (done, total) = progress
        if total > 0 && !finished { return "\(statusLabel) · \(done)/\(total) tasks integrated" }
        return statusLabel
    }
    public func member(_ id: String) -> JSON? { members.first { $0["memberId"].string == id } }
    public func task(_ id: String) -> JSON? { tasks.first { $0["id"].string == id } }
}

extension String {
    var capitalizedFirstLetter: String { prefix(1).uppercased() + dropFirst() }
}
