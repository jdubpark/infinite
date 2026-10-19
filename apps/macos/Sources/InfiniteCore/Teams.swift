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
    /// When the run last did something a person would notice: its latest history entry. The host
    /// rewrites `updatedAt` on routine scheduler passes, so that is only the fallback.
    public var lastActivityAt: String { events.map { $0["at"].string }.max() ?? updatedAt }
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

    /// Tasks grouped into columns by dependency depth, so parallel work shares a column.
    /// Unknown or cyclic dependencies do not hide a task; it lands after what is known.
    public var taskColumns: [[JSON]] {
        var depth: [String: Int] = [:]
        func level(_ id: String, _ seen: Set<String>) -> Int {
            if let known = depth[id] { return known }
            guard let task = task(id), !seen.contains(id) else { return 0 }
            let parents = task["dependsOn"].array.map(\.string).filter { self.task($0) != nil }
            let value = parents.map { level($0, seen.union([id])) + 1 }.max() ?? 0
            depth[id] = value
            return value
        }
        var columns: [[JSON]] = []
        for task in tasks {
            let column = level(task["id"].string, [])
            while columns.count <= column { columns.append([]) }
            columns[column].append(task)
        }
        return columns
    }
    /// The latest host check per command in the current revision, setup excluded.
    public var currentChecks: [JSON] {
        var latest: [String: JSON] = [:]
        var order: [String] = []
        for check in checks where check["revision"].int == revision && check["phase"].string != "setup" {
            let key = Self.commandLine(check["command"])
            if latest[key] == nil { order.append(key) }
            latest[key] = check
        }
        return order.compactMap { latest[$0] }
    }
    public static func commandLine(_ command: JSON) -> String { ([command["command"].string] + command["args"].array.map(\.string)).joined(separator: " ") }
    /// The reviewer's verdict for this revision; an earlier revision's verdict no longer applies.
    public var currentVerdict: String? { review != .null && review["revision"].int == revision ? review["verdict"].string : nil }

    public enum StageState: Equatable, Sendable { case pending, active, done, failed }
    /// Where the run stands at each pipeline stage, from recorded evidence first and status second.
    public var stages: [(name: String, state: StageState)] {
        let checks = currentChecks
        let allIntegrated = !tasks.isEmpty && tasks.allSatisfy { $0["status"].string == "integrated" }
        let plan: StageState = !tasks.isEmpty ? .done : ["planning", "discovering"].contains(status) ? .active : .pending
        let build: StageState = allIntegrated ? .done : tasks.contains { $0["status"].string == "blocked" } ? .failed : status == "implementing" || tasks.contains { ["running", "waiting"].contains($0["status"].string) } ? .active : .pending
        let integrate: StageState = allIntegrated && !headCommit.isEmpty ? .done : status == "integrating" ? .active : .pending
        let check: StageState = checks.contains { $0["status"].string == "failed" } ? .failed : !checks.isEmpty && checks.allSatisfy { $0["status"].string == "passed" } ? .done : status == "verifying" || checks.contains { $0["status"].string == "running" } ? .active : .pending
        let reviewed: StageState = currentVerdict == "approved" ? .done : currentVerdict == "changes-requested" ? .failed : status == "reviewing" ? .active : .pending
        let you: StageState = status == "ready-for-review" || needsYou ? .active : status == "merged" ? .done : .pending
        return [("Plan", plan), ("Build", build), ("Integrate", integrate), ("Checks", check), ("Review", reviewed), ("You", you)]
    }

    /// Text an agent put under a "Limitations:" heading in its report, up to the next blank line.
    public static func limitations(_ text: String) -> String? {
        let lines = text.components(separatedBy: .newlines)
        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("limitations:") }) else { return nil }
        let inline = lines[start].drop { $0 != ":" }.dropFirst().trimmingCharacters(in: .whitespaces)
        let rest = lines[(start + 1)...].prefix { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^[-*]\s*"#, with: "", options: .regularExpression) }
        let body = ([inline] + rest).filter { !$0.isEmpty }.joined(separator: " ")
        return body.isEmpty ? nil : body
    }

    /// One concrete review action: a direction to send the team, or a command to copy.
    public struct ReviewStep: Equatable, Sendable {
        public enum Action: Equatable, Sendable { case direction(String), copy(String) }
        public let title: String
        public let detail: String
        public let action: Action
        public let urgent: Bool
    }
    /// What the person should do with a run that reports ready: blockers first, then the usual checks.
    /// These are suggestions; the host never approves or merges on the person's behalf.
    public var reviewSteps: [ReviewStep] {
        var steps: [ReviewStep] = []
        for check in currentChecks where check["status"].string == "failed" {
            let line = Self.commandLine(check["command"])
            steps.append(.init(title: "Fix the failing check", detail: line, action: .direction("The host check `\(line)` failed. Fix the cause and rerun every required check."), urgent: true))
        }
        if currentVerdict == "changes-requested" {
            steps.append(.init(title: "Address the reviewer's changes", detail: "The reviewer did not approve this revision.", action: .direction("Address every change the reviewer requested, then rerun the checks."), urgent: true))
        }
        for task in tasks {
            guard let note = Self.limitations(task["summary"].string) else { continue }
            steps.append(.init(title: "Resolve a flagged limitation", detail: "\(task["title"].string): \(note)", action: .direction("In \"\(task["title"].string)\" the agent reported this limitation: \(note)\nResolve it or explain why it is acceptable."), urgent: false))
        }
        if !baseCommit.isEmpty {
            let target = headCommit.isEmpty ? branch : headCommit
            steps.append(.init(title: "Read the diff", detail: "Copies a git command for this run's changes.", action: .copy("git diff \(baseCommit)..\(target)"), urgent: false))
        }
        steps.append(.init(title: "Ask for end-to-end proof", detail: "Agents report; a real run shows.", action: .direction("Run the finished feature end to end with a realistic input. Paste the exact command and its output."), urgent: false))
        steps.append(.init(title: "Ask what could break", detail: "Find the risky part fast.", action: .direction("List the three riskiest changes in this run with file and line, and what would break if each is wrong."), urgent: false))
        return steps
    }
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
