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
    /// The agents have stopped: the run waits for a person's review, reported a merge, proposed no change, or was cancelled.
    public var finished: Bool { ["ready-for-review", "merged", "no-change", "cancelled"].contains(status) }
    /// Agents are working or the host is integrating, checking, reviewing, or delivering.
    public var working: Bool { ["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering"].contains(status) }
    public var statusLabel: String { Self.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static let labels: [String: String] = [
        "planning": "Planning", "discovering": "Investigating", "implementing": "Implementing", "integrating": "Integrating",
        "verifying": "Running checks", "reviewing": "Reviewing", "delivering": "Delivering", "merged": "Merge reported",
        "needs-input": "Needs your input", "paused": "Paused", "blocked": "Blocked",
        "ready-for-review": "Ready for your review", "no-change": "No change proposed", "cancelled": "Cancelled",
    ]
    /// The home board's group for this run. A run waiting for review is pending, not complete; a reported
    /// merge is the only complete state, and it remains an agent report rather than host verification.
    public var projectState: ProjectState {
        switch status {
        case "cancelled": return .cancelled
        case "no-change": return .aborted
        case "merged": return .complete
        case "paused": return .paused
        case "blocked": return .stuck
        case "needs-input", "ready-for-review": return .pending
        default: return openDecisions.isEmpty ? .ongoing : .pending
        }
    }
    /// How full the status ring draws: the plan's integrated share, never below the current phase's floor.
    public var progressFraction: Double {
        if ["ready-for-review", "merged"].contains(status) { return 1 }
        let floor = ["integrating": 0.5, "verifying": 0.75, "reviewing": 0.75, "delivering": 1.0][status] ?? 0.25
        let (done, total) = progress
        return max(floor, total > 0 ? Double(done) / Double(total) : 0)
    }
    /// The Linear issue the host syncs this run to, when it tracks one.
    public var linearIssue: String { value["linear"]["issue"]["identifier"].string }
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

/// Where a run sits on the home board, in the order the board lists them.
public enum ProjectState: String, CaseIterable, Sendable {
    case ongoing, pending, stuck, paused, complete, cancelled, aborted
    public var title: String {
        switch self {
        case .ongoing: return "Ongoing"
        case .pending: return "Pending"
        case .stuck: return "Stuck"
        case .paused: return "Paused"
        case .complete: return "Complete"
        case .cancelled: return "Cancelled"
        case .aborted: return "Aborted"
        }
    }
    /// The agents stopped for good; the board folds these groups until opened.
    public var closed: Bool { [.complete, .cancelled, .aborted].contains(self) }
}

extension String {
    var capitalizedFirstLetter: String { prefix(1).uppercased() + dropFirst() }
}
