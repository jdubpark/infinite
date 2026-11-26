import Foundation

public struct ProjectGroup: Identifiable, Equatable, Sendable {
    public struct Repo: Equatable, Sendable {
        public let projectID: String
        public let name: String
        public let path: String
        public let checkoutIDs: [String]
    }
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var name: String { value["name"].string }
    public var implicit: Bool { value["implicit"].bool }
    public var revision: Int { value["revision"].int }
    public var repos: [Repo] {
        value["repos"].array.map { repo in
            let primary = repo["projectId"].string
            let checkouts = repo["checkouts"].array.map { $0["projectId"].string }.filter { !$0.isEmpty }
            return Repo(projectID: primary, name: repo["name"].string.isEmpty ? primary : repo["name"].string, path: repo["path"].string,
                        checkoutIDs: checkouts.contains(primary) ? checkouts : [primary] + checkouts)
        }
    }
    public var projectIDs: [String] { repos.flatMap(\.checkoutIDs) }
    public var repoCountLabel: String? { repos.count > 1 ? "\(repos.count) repos" : nil }
    public static func ordered(_ groups: [ProjectGroup]) -> [ProjectGroup] {
        groups.sorted {
            if $0.implicit != $1.implicit { return !$0.implicit }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }
}

public struct ProjectGroupList: Equatable, Sendable {
    public let groups: [ProjectGroup]
    public let suggestions: [JSON]
    public init(_ value: JSON) {
        groups = ProjectGroup.ordered(value["groups"].array.map(ProjectGroup.init).filter { !$0.id.isEmpty })
        suggestions = value["suggestions"].array
    }
    public static let empty = ProjectGroupList(.null)
    public func group(_ id: String) -> ProjectGroup? { groups.first { $0.id == id } }
    public func repoName(_ projectID: String) -> String? {
        for group in groups { if let repo = group.repos.first(where: { $0.projectID == projectID }) { return repo.name } }
        return nil
    }
}

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
    public var subtitle: String {
        switch self {
        case .needsInput: return "Waiting on your answer or to be unblocked"
        case .working: return "Agents are on it"
        case .review: return "Results need your review · delivery follows each repository's policy"
        case .ended: return "Cancelled, merged, or stopped"
        }
    }
}

public struct BoardItem: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case mission, team, goal }
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var kind: Kind? { Kind(rawValue: value["kind"].string) }
    public var id: String { value["id"].string }
    public var title: String { value["title"].string }
    public var groupID: String { value["groupId"].string }
    public var projectName: String { value["projectName"].string }
    public var column: BoardColumn { BoardColumn(rawValue: value["column"].string) ?? .working }
    public var status: String { value["status"].string }
    public var detail: String { value["detail"].string }
    public var updatedAt: String { value["updatedAt"].string }
    public var subtasks: (total: Int, running: Int, done: Int)? {
        let counts = value["subtasks"]
        guard counts != .null else { return nil }
        return (counts["total"].int, counts["running"].int, counts["done"].int)
    }
    public var subtaskLabel: String? {
        guard let counts = subtasks, counts.total > 0 else { return nil }
        return "\(counts.done)/\(counts.total) subtask\(counts.total == 1 ? "" : "s")"
    }
    public var detailBesideProgress: String {
        guard let counts = subtasks, subtaskLabel != nil,
              let match = detail.firstMatch(of: #/(?:^|\.\s+)(\d+) of (\d+) subtasks? done$/#),
              Int(match.1) == counts.done, Int(match.2) == counts.total else { return detail }
        return String(detail[..<match.range.lowerBound])
    }
    public var progressFraction: Double {
        guard let counts = subtasks, counts.total > 0 else { return 0.25 }
        return max(0.25, Double(counts.done) / Double(counts.total))
    }
    public var statusLabel: String { Mission.labels[status] ?? TeamRun.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static func == (lhs: BoardItem, rhs: BoardItem) -> Bool { lhs.value == rhs.value }
}

public struct Board: Equatable, Sendable {
    public let items: [BoardItem]
    public init(_ value: JSON) { items = value["items"].array.map(BoardItem.init).filter { !$0.id.isEmpty } }
    public init(items: [BoardItem]) { self.items = items }
    public static let empty = Board(items: [])

    public func items(in group: ProjectGroup?) -> [BoardItem] {
        guard let group else { return items }
        return items.filter { $0.groupID.isEmpty ? $0.projectName == group.name : $0.groupID == group.id }
    }
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

public struct MissionSubtask: Identifiable, Equatable, Sendable {
    public enum Size: Equatable, Sendable {
        case solo
        case team(parallelism: Int)
    }
    public enum Status: Equatable, Sendable {
        case queued, running, done, cancelled, blocked, unknown(String)
        init(_ raw: String) {
            switch raw {
            case "queued": self = .queued
            case "running": self = .running
            case "done": self = .done
            case "cancelled": self = .cancelled
            case "blocked": self = .blocked
            default: self = .unknown(raw)
            }
        }
    }

    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var repoProjectID: String { value["repoProjectId"].string }
    public var title: String { value["title"].string }
    public var objective: String { value["objective"].string }
    public var size: String { value["size"].string }
    public var parallelism: Int { max(1, value["parallelism"].int) }
    public var typedSize: Size { size == "team" ? .team(parallelism: parallelism) : .solo }
    public var dependsOn: [String] { value["dependsOn"].array.map(\.string) }
    public var status: String { value["status"].string }
    public var typedStatus: Status { Status(status) }
    public var teamID: String? { value["teamId"].string.isEmpty ? nil : value["teamId"].string }
    public var teamStatus: String { value["teamStatus"].string }
    public var sizeLabel: String {
        switch typedSize {
        case .solo: return "Solo"
        case .team(let parallelism): return "Team · up to \(parallelism)"
        }
    }
    public var statusLabel: String {
        let own: String = switch typedStatus {
        case .queued: "Queued"
        case .running: "Running"
        case .done: "Done"
        case .cancelled: "Cancelled"
        case .blocked: "Blocked"
        case .unknown(let raw): raw.capitalizedFirstLetter
        }
        guard !teamStatus.isEmpty else { return own }
        return "\(own) · \(TeamRun.labels[teamStatus] ?? teamStatus)"
    }
}

public struct MissionDecision: Identifiable, Equatable, Sendable {
    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var question: String { value["question"].string }
    public var subtaskID: String { value["subtaskId"].string }
    public var answered: Bool { value["answer"] != .null }
}

public struct DecisionRecommendation: Equatable, Sendable {
    public enum Outcome: String, Sendable { case matched, different, other }
    public let answers: [String]
    public let reason: String
    public let outcome: Outcome?

    public init?(_ value: JSON) {
        let answers = value["answers"].array.map(\.string).filter { !$0.isEmpty }
        guard !answers.isEmpty else { return nil }
        self.answers = answers
        reason = value["reason"].string
        outcome = Outcome(rawValue: value["outcome"].string)
    }

    public func recommends(_ option: String) -> Bool { answers.contains(option) }
    public var firstAnswer: String { answers[0] }
    public var comparisonNote: String? {
        switch outcome {
        case .matched: "Matched the recommendation"
        case .different: "Different from the recommendation"
        case .other, nil: nil
        }
    }
}

public struct MissionRequest: Equatable, Sendable {
    public let path: String
    public let body: JSON
    public static func answer(missionID: String, decisionID: String, revision: Int, text: String, requestID: String) -> MissionRequest {
        MissionRequest(path: "/missions/\(missionID)/answer/\(decisionID)", body: body(requestID, revision, text))
    }
    public static func action(missionID: String, name: String, revision: Int, text: String? = nil, requestID: String) -> MissionRequest {
        MissionRequest(path: "/missions/\(missionID)/\(name)", body: body(requestID, revision, text))
    }
    private static func body(_ requestID: String, _ revision: Int, _ text: String?) -> JSON {
        var fields: [String: JSON] = ["requestId": .string(requestID), "revision": .number(Double(revision))]
        if let text { fields["text"] = .string(text) }
        return .object(fields)
    }
}

public struct Mission: Identifiable, Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case planning, working, needsInput, paused, blocked, readyForReview, cancelled
        case unknown(String)

        public init(_ raw: String) {
            switch raw {
            case "planning": self = .planning
            case "working": self = .working
            case "needs-input": self = .needsInput
            case "paused": self = .paused
            case "blocked": self = .blocked
            case "ready-for-review": self = .readyForReview
            case "cancelled": self = .cancelled
            default: self = .unknown(raw)
            }
        }
    }

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
    public var typedStatus: Status { Status(status) }
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
    public var openDecisions: [MissionDecision] { decisions.map(MissionDecision.init).filter { !$0.answered && !$0.id.isEmpty } }
    public var answeredDecisions: [JSON] { decisions.filter { $0["answer"] != .null } }
    public var ended: Bool { typedStatus == .cancelled }
    public var statusLabel: String { Self.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static let labels: [String: String] = [
        "planning": "Planning", "working": "Working", "needs-input": "Needs your input", "paused": "Paused",
        "blocked": "Blocked", "ready-for-review": "Ready for your review", "cancelled": "Cancelled",
    ]
    public var column: BoardColumn {
        switch typedStatus {
        case .needsInput, .blocked: return .needsInput
        case .readyForReview: return .review
        case .cancelled: return .ended
        case .planning, .working, .paused, .unknown: return .working
        }
    }
    public var progress: (done: Int, total: Int) { (subtasks.filter { $0.typedStatus == .done }.count, subtasks.count) }
    public var canPause: Bool {
        switch typedStatus {
        case .planning, .working, .needsInput: return true
        default: return false
        }
    }
    public var canResume: Bool { typedStatus == .paused }
    public var canCancel: Bool { typedStatus != .cancelled }
    public var canAnswer: Bool { canPause }
    public func subtask(_ id: String) -> MissionSubtask? { subtasks.first { $0.id == id } }
    public func origin(of decision: MissionDecision) -> MissionSubtask? { decision.subtaskID.isEmpty ? nil : subtask(decision.subtaskID) }
}

public struct SessionManagement: Codable, Equatable, Sendable {
    public let kind: String
    public let missionId: String
    public let teamId: String?
}
