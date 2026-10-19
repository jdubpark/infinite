import Foundation

/// A project the owner hands work to: one repository, or several that keep their own history and
/// checks. A repository outside every owner-created group arrives as an implicit single-repository
/// project whose ID is its host project ID.
public struct ProjectGroup: Identifiable, Equatable, Sendable {
    public struct Repo: Equatable, Sendable {
        public let projectID: String
        public let name: String
        public let path: String
    }
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var name: String { value["name"].string }
    public var implicit: Bool { value["implicit"].bool }
    public var revision: Int { value["revision"].int }
    public var repos: [Repo] {
        value["repos"].array.map { Repo(projectID: $0["projectId"].string, name: $0["name"].string.isEmpty ? $0["projectId"].string : $0["name"].string, path: $0["path"].string) }
    }
    /// "2 repos" for a multi-repository project; a single repository needs no count.
    public var repoCountLabel: String? { repos.count > 1 ? "\(repos.count) repos" : nil }
    /// Owner-created projects first, then the implicit single-repository ones; each set by name.
    public static func ordered(_ groups: [ProjectGroup]) -> [ProjectGroup] {
        groups.sorted {
            if $0.implicit != $1.implicit { return !$0.implicit }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
}

/// `GET /api/project-groups`: the projects and the host's grouping suggestions, which never apply on their own.
public struct ProjectGroupList: Equatable, Sendable {
    public let groups: [ProjectGroup]
    public let suggestions: [JSON]
    public init(_ value: JSON) {
        groups = ProjectGroup.ordered(value["groups"].array.map(ProjectGroup.init).filter { !$0.id.isEmpty })
        suggestions = value["suggestions"].array
    }
    public static let empty = ProjectGroupList(.null)
    public func group(_ id: String) -> ProjectGroup? { groups.first { $0.id == id } }
    /// The repository's display name from whichever project lists it.
    public func repoName(_ projectID: String) -> String? {
        for group in groups { if let repo = group.repos.first(where: { $0.projectID == projectID }) { return repo.name } }
        return nil
    }
}

/// The board's columns in the order the board shows them.
public enum BoardColumn: String, CaseIterable, Sendable {
    case needsInput = "needs-input", working, review, ended
    public var title: String {
        switch self {
        case .needsInput: return "Needs input"
        case .working: return "Working"
        case .review: return "Ready for review"
        case .ended: return "Ended"
        }
    }
    /// One dim line under the column title. Review is an agent report, never acceptance.
    public var subtitle: String {
        switch self {
        case .needsInput: return "Waiting on your answer or to be unblocked"
        case .working: return "Agents are on it"
        case .review: return "Agents report done · nothing merges until you do"
        case .ended: return "Cancelled, merged, or stopped"
        }
    }
}

/// One board row: a mission, or a team run or goal that no mission started.
public struct BoardItem: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case mission, team, goal }
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    /// Kinds this app does not know yet still show, as a team-like row that opens nothing.
    public var kind: Kind? { Kind(rawValue: value["kind"].string) }
    public var id: String { value["id"].string }
    public var title: String { value["title"].string }
    public var groupID: String { value["groupId"].string }
    public var projectName: String { value["projectName"].string }
    /// A column this app does not know is shown as working rather than hidden.
    public var column: BoardColumn { BoardColumn(rawValue: value["column"].string) ?? .working }
    public var status: String { value["status"].string }
    public var detail: String { value["detail"].string }
    public var updatedAt: String { value["updatedAt"].string }
    public var subtasks: (total: Int, running: Int, done: Int)? {
        let counts = value["subtasks"]
        guard counts != .null else { return nil }
        return (counts["total"].int, counts["running"].int, counts["done"].int)
    }
    /// "2/5 subtasks" for a mission that has dispatched work.
    public var subtaskLabel: String? {
        guard let counts = subtasks, counts.total > 0 else { return nil }
        return "\(counts.done)/\(counts.total) subtask\(counts.total == 1 ? "" : "s")"
    }
    /// How full a working row's ring draws: finished subtasks, never below a started quarter.
    public var progressFraction: Double {
        guard let counts = subtasks, counts.total > 0 else { return 0.25 }
        return max(0.25, Double(counts.done) / Double(counts.total))
    }
    public var statusLabel: String { Mission.labels[status] ?? TeamRun.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static func == (lhs: BoardItem, rhs: BoardItem) -> Bool { lhs.value == rhs.value }
}

/// `GET /api/board`, grouped for display.
public struct Board: Equatable, Sendable {
    public let items: [BoardItem]
    public init(_ value: JSON) { items = value["items"].array.map(BoardItem.init).filter { !$0.id.isEmpty } }
    public init(items: [BoardItem]) { self.items = items }
    public static let empty = Board(items: [])

    /// Rows for one project, or all rows. A row the host left without a group matches by project name.
    public func items(in group: ProjectGroup?) -> [BoardItem] {
        guard let group else { return items }
        return items.filter { $0.groupID.isEmpty ? $0.projectName == group.name : $0.groupID == group.id }
    }
    /// Non-empty columns in board order, newest-updated first within each. The sort is stable.
    public func columns(in group: ProjectGroup? = nil) -> [(column: BoardColumn, items: [BoardItem])] {
        let rows = items(in: group)
        return BoardColumn.allCases.compactMap { column in
            let matching = rows.enumerated().filter { $0.element.column == column }
                .sorted { $0.element.updatedAt != $1.element.updatedAt ? $0.element.updatedAt > $1.element.updatedAt : $0.offset < $1.offset }
                .map(\.element)
            return matching.isEmpty ? nil : (column, matching)
        }
    }
    public func count(_ column: BoardColumn, in group: ProjectGroup? = nil) -> Int { items(in: group).filter { $0.column == column }.count }
}

/// One subtask of a mission, run by a single-repository subteam.
public struct MissionSubtask: Identifiable, Equatable, Sendable {
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var repoProjectID: String { value["repoProjectId"].string }
    public var title: String { value["title"].string }
    public var objective: String { value["objective"].string }
    public var size: String { value["size"].string }
    public var parallelism: Int { max(1, value["parallelism"].int) }
    public var dependsOn: [String] { value["dependsOn"].array.map(\.string) }
    public var status: String { value["status"].string }
    public var teamID: String? { value["teamId"].string.isEmpty ? nil : value["teamId"].string }
    /// The subteam's last status the host observed; it is never an agent's own report.
    public var teamStatus: String { value["teamStatus"].string }
    public var sizeLabel: String { size == "team" ? "Team · up to \(parallelism)" : "Solo" }
    public var statusLabel: String {
        let own = ["queued": "Queued", "running": "Running", "done": "Done", "cancelled": "Cancelled", "blocked": "Blocked"][status] ?? status.capitalizedFirstLetter
        guard !teamStatus.isEmpty else { return own }
        return "\(own) · \(TeamRun.labels[teamStatus] ?? teamStatus)"
    }
}

/// One mission as the host reports it. Values are read on demand so unknown fields pass through.
public struct Mission: Identifiable, Equatable, Sendable {
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var groupID: String { value["groupId"].string }
    public var groupName: String { value["groupName"].string }
    public var repoProjectIDs: [String] { value["repoProjectIds"].array.map(\.string) }
    public var title: String { value["title"].string }
    public var objective: String { value["objective"].string }
    public var revision: Int { value["revision"].int }
    public var status: String { value["status"].string }
    public var reason: String { value["reason"].string }
    public var createdAt: String { value["createdAt"].string }
    public var updatedAt: String { value["updatedAt"].string }
    public var deadlineAt: String { value["deadlineAt"].string }
    public var dispatchSummary: String { value["dispatchSummary"].string }
    public var coordinatorStatus: String { value["coordinator"]["status"].string }
    public var subtasks: [MissionSubtask] { value["subtasks"].array.map(MissionSubtask.init) }
    public var decisions: [JSON] { value["decisions"].array }
    public var steering: [JSON] { value["steering"].array }
    public var events: [JSON] { value["events"].array }
    public var result: JSON { value["result"] }
    /// Decisions nobody has answered; the owner answers these first.
    public var openDecisions: [JSON] { decisions.filter { $0["answer"] == .null } }
    public var answeredDecisions: [JSON] { decisions.filter { $0["answer"] != .null } }
    public var ended: Bool { status == "cancelled" }
    public var statusLabel: String { Self.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static let labels: [String: String] = [
        "planning": "Planning", "working": "Working", "needs-input": "Needs your input", "paused": "Paused",
        "blocked": "Blocked", "ready-for-review": "Ready for your review", "cancelled": "Cancelled",
    ]
    public var column: BoardColumn {
        switch status {
        case "needs-input", "blocked": return .needsInput
        case "ready-for-review": return .review
        case "cancelled": return .ended
        default: return .working
        }
    }
    public var progress: (done: Int, total: Int) { (subtasks.filter { $0.status == "done" }.count, subtasks.count) }
    /// Owner controls offered for this status. The host still decides; a refused action refreshes the mission.
    public var canPause: Bool { ["planning", "working", "needs-input"].contains(status) }
    public var canResume: Bool { status == "paused" }
    public var canCancel: Bool { status != "cancelled" }
    public func subtask(_ id: String) -> MissionSubtask? { subtasks.first { $0.id == id } }
    /// Which subtask raised an escalated decision, when one did.
    public func origin(of decision: JSON) -> MissionSubtask? { decision["subtaskId"].string.isEmpty ? nil : subtask(decision["subtaskId"].string) }
}
