import Foundation

public struct TeamRun: Identifiable, Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case planning, discovering, implementing, integrating, verifying, reviewing, delivering
        case merged, needsInput, paused, blocked, readyForReview, noChange, cancelled
        case unknown(String)

        public init(_ raw: String) {
            switch raw {
            case "planning": self = .planning
            case "discovering": self = .discovering
            case "implementing": self = .implementing
            case "integrating": self = .integrating
            case "verifying": self = .verifying
            case "reviewing": self = .reviewing
            case "delivering": self = .delivering
            case "merged": self = .merged
            case "needs-input": self = .needsInput
            case "paused": self = .paused
            case "blocked": self = .blocked
            case "ready-for-review": self = .readyForReview
            case "no-change": self = .noChange
            case "cancelled": self = .cancelled
            default: self = .unknown(raw)
            }
        }
    }

    public let value: JSON
    public init(_ value: JSON) { self.value = value }
    public var id: String { value["id"].string }
    public var title: String { value["title"].string }
    public var status: String { value["status"].string }
    public var typedStatus: Status { Status(status) }
    public var revision: Int { value["revision"].int }
    public var projectID: String { value["projectId"].string }
    public var missionID: String { value["missionId"].string }
    public var managedByMission: Bool { !missionID.isEmpty }
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
    public var openDecisions: [JSON] { decisions.filter { $0["revision"].int == revision && $0["answer"] == .null } }
    public var answeredDecisions: [JSON] { decisions.filter { $0["answer"] != .null } }
    public var activeMembers: [JSON] { members.filter { $0["revision"].int == revision && ["running", "waiting"].contains($0["status"].string) } }
    public var needsYou: Bool { typedStatus == .needsInput }
    public var finished: Bool {
        switch typedStatus {
        case .readyForReview, .merged, .noChange, .cancelled: return true
        default: return false
        }
    }
    public var working: Bool {
        switch typedStatus {
        case .planning, .discovering, .implementing, .integrating, .verifying, .reviewing, .delivering: return true
        default: return false
        }
    }
    public var statusLabel: String { Self.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirstLetter }
    public static let labels: [String: String] = [
        "planning": "Planning", "discovering": "Investigating", "implementing": "Implementing", "integrating": "Integrating",
        "verifying": "Running checks", "reviewing": "Reviewing", "delivering": "Delivering", "merged": "Merge reported",
        "needs-input": "Needs your input", "paused": "Paused", "blocked": "Blocked",
        "ready-for-review": "Ready for your review", "no-change": "No change proposed", "cancelled": "Cancelled",
    ]
    public var projectState: ProjectState {
        switch typedStatus {
        case .cancelled: return .cancelled
        case .noChange: return .aborted
        case .merged: return .complete
        case .paused: return .paused
        case .blocked: return .stuck
        case .needsInput, .readyForReview: return .pending
        case .planning, .discovering, .implementing, .integrating, .verifying, .reviewing, .delivering, .unknown:
            return openDecisions.isEmpty ? .ongoing : .pending
        }
    }
    public var progressFraction: Double {
        if typedStatus == .readyForReview || typedStatus == .merged { return 1 }
        let floor: Double = switch typedStatus {
        case .delivering: 1.0
        case .verifying, .reviewing: 0.75
        case .integrating: 0.5
        default: 0.25
        }
        let (done, total) = progress
        return max(floor, total > 0 ? Double(done) / Double(total) : 0)
    }
    public var lastActivityAt: String {
        let recorded = value["lastActivityAt"].string
        if !recorded.isEmpty { return recorded }
        return events.map { $0["at"].string }.filter { !$0.isEmpty }.max() ?? updatedAt
    }
    public var linearIssue: String { value["linear"]["issue"]["identifier"].string }
    public var offersResume: Bool {
        typedStatus == .blocked && value["resumable"].bool && Self.absent(value["goal"]) && Self.absent(value["deliveryReceipt"]) && !managedByMission
    }
    public static func blockedFirst(_ runs: [TeamRun]) -> [TeamRun] {
        runs.filter { $0.typedStatus == .blocked } + runs.filter { $0.typedStatus != .blocked }
    }
    private static func absent(_ value: JSON) -> Bool {
        switch value {
        case .null: return true
        case .string(let text): return text.isEmpty
        default: return false
        }
    }
    public static func roleName(_ role: String) -> String {
        ["project-manager": "Coordinator", "implementer": "Implementer", "integrator": "Integrator", "reviewer": "Reviewer"][role] ?? role.capitalizedFirstLetter
    }
    public var progress: (integrated: Int, total: Int) {
        (tasks.filter { $0["status"].string == "integrated" }.count, tasks.count)
    }
    public var summaryLine: String {
        let open = openDecisions.count
        if needsYou && open > 0 { return "\(statusLabel) · \(open == 1 ? "1 decision" : "\(open) decisions")" }
        let (done, total) = progress
        if total > 0 && !finished { return "\(statusLabel) · \(done)/\(total) tasks integrated" }
        return statusLabel
    }
    public func member(_ id: String) -> JSON? { members.first { $0["memberId"].string == id } }
    public func task(_ id: String) -> JSON? { tasks.first { $0["id"].string == id } }

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
    public var currentVerdict: String? { review != .null && review["revision"].int == revision ? review["verdict"].string : nil }

    public enum StageState: Equatable, Sendable { case pending, active, done, failed }
    public var stages: [(name: String, state: StageState)] {
        let checks = currentChecks
        let allIntegrated = !tasks.isEmpty && tasks.allSatisfy { $0["status"].string == "integrated" }
        let plan: StageState = !tasks.isEmpty ? .done : (typedStatus == .planning || typedStatus == .discovering) ? .active : .pending
        let build: StageState = allIntegrated ? .done : tasks.contains { $0["status"].string == "blocked" } ? .failed : typedStatus == .implementing || tasks.contains { ["running", "waiting"].contains($0["status"].string) } ? .active : .pending
        let integrate: StageState = allIntegrated && !headCommit.isEmpty ? .done : typedStatus == .integrating ? .active : .pending
        let check: StageState = checks.contains { $0["status"].string == "failed" } ? .failed : !checks.isEmpty && checks.allSatisfy { $0["status"].string == "passed" } ? .done : typedStatus == .verifying || checks.contains { $0["status"].string == "running" } ? .active : .pending
        let reviewed: StageState = currentVerdict == "approved" ? .done : currentVerdict == "changes-requested" ? .failed : typedStatus == .reviewing ? .active : .pending
        let you: StageState = typedStatus == .readyForReview || needsYou ? .active : typedStatus == .merged ? .done : .pending
        return [("Plan", plan), ("Build", build), ("Integrate", integrate), ("Checks", check), ("Review", reviewed), ("You", you)]
    }

    public static func limitations(_ text: String) -> String? {
        let lines = text.components(separatedBy: .newlines)
        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("limitations:") }) else { return nil }
        let inline = lines[start].drop { $0 != ":" }.dropFirst().trimmingCharacters(in: .whitespaces)
        let rest = lines[(start + 1)...].prefix { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^[-*]\s*"#, with: "", options: .regularExpression) }
        let body = ([inline] + rest).filter { !$0.isEmpty }.joined(separator: " ")
        return body.isEmpty ? nil : body
    }

    public static func limitations(of task: JSON) -> [String] {
        if case .array(let items) = task["limitations"] {
            return items.compactMap { item -> String? in
                guard case .string(let text) = item else { return nil }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        }
        guard let legacy = limitations(task["summary"].string) else { return [] }
        return [legacy]
    }

    public static let maxSteeringDirectionChars = 8_000

    private static func utf16Prefix(_ text: String, maxUnits: Int) -> String {
        guard maxUnits > 0 else { return "" }
        guard text.utf16.count > maxUnits else { return text }
        var result = ""
        var used = 0
        for character in text {
            let cost = character.utf16.count
            if used + cost > maxUnits {
                if result.isEmpty {
                    for scalar in character.unicodeScalars {
                        let scalarCost = scalar.utf16.count
                        if used + scalarCost > maxUnits { break }
                        result.unicodeScalars.append(scalar)
                        used += scalarCost
                    }
                }
                break
            }
            result.append(character)
            used += cost
        }
        return result
    }

    private static func utf16Chunks(_ text: String, maxUnits: Int) -> [String] {
        guard maxUnits > 0 else { return [] }
        guard text.utf16.count > maxUnits else { return [text] }
        var chunks: [String] = []
        var current = ""
        var used = 0
        for character in text {
            let cost = character.utf16.count
            if cost <= maxUnits {
                if used + cost > maxUnits, !current.isEmpty {
                    chunks.append(current)
                    current = ""
                    used = 0
                }
                current.append(character)
                used += cost
            } else {
                for scalar in character.unicodeScalars {
                    let scalarCost = scalar.utf16.count
                    if used + scalarCost > maxUnits, !current.isEmpty {
                        chunks.append(current)
                        current = ""
                        used = 0
                    }
                    if scalarCost <= maxUnits {
                        current.unicodeScalars.append(scalar)
                        used += scalarCost
                    }
                }
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    private static func limitationDirection(taskTitle: String, notes: [String]) -> String {
        if notes.count == 1, let note = notes.first {
            return "In \"\(taskTitle)\" the agent reported this limitation: \(note)\nResolve it or explain why it is acceptable."
        }
        let bullets = notes.map { "- \($0)" }.joined(separator: "\n")
        return "In \"\(taskTitle)\" the agent reported these limitations:\n\(bullets)\nResolve them or explain why they are acceptable."
    }

    private static func limitationReviewSteps(taskTitle: String, notes: [String]) -> [ReviewStep] {
        guard !notes.isEmpty else { return [] }
        let singleWrapperCost = limitationDirection(taskTitle: "", notes: [""]).utf16.count
        let multiWrapperCost = limitationDirection(taskTitle: "", notes: ["", ""]).utf16.count
        let maxTitleUnits = max(0, min(200, maxSteeringDirectionChars - max(singleWrapperCost, multiWrapperCost) - 16))
        let directionTitle = taskTitle.utf16.count > maxTitleUnits && limitationDirection(taskTitle: taskTitle, notes: notes).utf16.count > maxSteeringDirectionChars
            ? utf16Prefix(taskTitle, maxUnits: maxTitleUnits)
            : taskTitle
        let singleBudget = max(1, maxSteeringDirectionChars - limitationDirection(taskTitle: directionTitle, notes: [""]).utf16.count)
        let expanded = notes.flatMap { note -> [String] in
            note.utf16.count <= singleBudget ? [note] : utf16Chunks(note, maxUnits: singleBudget)
        }
        var groups: [[String]] = []
        var current: [String] = []
        for note in expanded {
            let candidate = current + [note]
            if !current.isEmpty && limitationDirection(taskTitle: directionTitle, notes: candidate).utf16.count > maxSteeringDirectionChars {
                groups.append(current)
                current = [note]
            } else {
                current = candidate
            }
        }
        if !current.isEmpty { groups.append(current) }
        return groups.map { group in
            let direction = limitationDirection(taskTitle: directionTitle, notes: group)
            if group.count == 1, let note = group.first {
                return ReviewStep(title: "Resolve a flagged limitation", detail: "\(taskTitle): \(note)", action: .direction(direction), urgent: false)
            }
            return ReviewStep(title: "Resolve flagged limitations", detail: "\(taskTitle): \(group.joined(separator: " · "))", action: .direction(direction), urgent: false)
        }
    }

    public struct ReviewStep: Equatable, Sendable {
        public enum Action: Equatable, Sendable { case direction(String), copy(String) }
        public let title: String
        public let detail: String
        public let action: Action
        public let urgent: Bool
    }
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
            let notes = Self.limitations(of: task)
            steps.append(contentsOf: Self.limitationReviewSteps(taskTitle: task["title"].string, notes: notes))
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

public enum ProjectState: String, CaseIterable, Sendable {
    case stuck, ongoing, pending, paused, complete, cancelled, aborted
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
    public var closed: Bool { [.complete, .cancelled, .aborted].contains(self) }
}

extension String {
    var capitalizedFirstLetter: String { prefix(1).uppercased() + dropFirst() }
}
