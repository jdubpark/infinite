import Foundation

public struct Money: Codable, Equatable, Sendable {
    public var usd: Double
    public var unpriced: Int
    public init(usd: Double, unpriced: Int = 0) { self.usd = usd; self.unpriced = unpriced }
    public static let zero = Money(usd: 0)
    public var label: String { display().label }
    public var isFloor: Bool { unpriced > 0 }
    public enum Display: Equatable, Sendable {
        case absent, floor(Double), exact(Double)
        public var label: String {
            switch self {
            case .absent: return "—"
            case .floor(let usd): return "≥ " + UsageFormat.usd(usd)
            case .exact(let usd): return UsageFormat.usd(usd)
            }
        }
    }
    public func display(unmeasured: Int = 0) -> Display {
        let gaps = unpriced > 0 || unmeasured > 0
        if usd <= 0 && gaps { return .absent }
        return gaps ? .floor(usd) : .exact(usd)
    }
}

public struct Balance: Codable, Equatable, Sendable {
    public var amount: Double
    public var currency: String
    public var asOf: String
    public var stale: Bool
    public init(amount: Double, currency: String, asOf: String, stale: Bool) { self.amount = amount; self.currency = currency; self.asOf = asOf; self.stale = stale }
}

public enum PlanSource: String, Codable, Equatable, Sendable {
    case config
    case owner
}

public enum AccountKind: Equatable, Sendable {
    case metered(month: Money?)
    case subscription(planUsd: Double?, source: PlanSource?)
    case other(kind: String, month: Money?, planUsd: Double?, planSource: String?)
}

public struct AccountView: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var billing: AccountKind
    public var balance: Balance?

    public init(id: String, billing: AccountKind, balance: Balance? = nil) {
        self.id = id
        self.billing = billing
        self.balance = balance
    }

    public init(id: String, kind: String, month: Money? = nil, planUsd: Double? = nil, planSource: String? = nil, balance: Balance? = nil) {
        self.id = id
        self.balance = balance
        switch kind {
        case "metered":
            self.billing = .metered(month: month)
        case "subscription":
            self.billing = .subscription(planUsd: planUsd, source: planSource.flatMap(PlanSource.init(rawValue:)))
        default:
            self.billing = .other(kind: kind, month: month, planUsd: planUsd, planSource: planSource)
        }
    }

    public var kind: String {
        switch billing {
        case .metered: return "metered"
        case .subscription: return "subscription"
        case .other(let kind, _, _, _): return kind
        }
    }

    public var month: Money? {
        switch billing {
        case .metered(let month): return month
        case .subscription: return nil
        case .other(_, let month, _, _): return month
        }
    }

    public var planUsd: Double? {
        switch billing {
        case .metered: return nil
        case .subscription(let planUsd, _): return planUsd
        case .other(_, _, let planUsd, _): return planUsd
        }
    }

    public var planSource: String? {
        switch billing {
        case .metered: return nil
        case .subscription(_, let source): return source?.rawValue
        case .other(_, _, _, let planSource): return planSource
        }
    }

    public var metered: Bool {
        if case .metered = billing { return true }
        return false
    }

    public var planSetByOwner: Bool {
        switch billing {
        case .subscription(_, let source): return source == .owner
        case .other(_, _, _, let planSource): return planSource == "owner"
        case .metered: return false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, month, planUsd, planSource, balance
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        let kind = try container.decode(String.self, forKey: .kind)
        let month = try container.decodeIfPresent(Money.self, forKey: .month)
        let planUsd = try container.decodeIfPresent(Double.self, forKey: .planUsd)
        let planSource = try container.decodeIfPresent(String.self, forKey: .planSource)
        let balance = try container.decodeIfPresent(Balance.self, forKey: .balance)
        self.init(id: id, kind: kind, month: month, planUsd: planUsd, planSource: planSource, balance: balance)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(month, forKey: .month)
        try container.encodeIfPresent(planUsd, forKey: .planUsd)
        try container.encodeIfPresent(planSource, forKey: .planSource)
        try container.encodeIfPresent(balance, forKey: .balance)
    }
}

public enum PlanFee {
    public static let maxUsd: Double = 100_000
    public static func parse(_ text: String) throws -> Double {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("$") { cleaned.removeFirst() }
        if cleaned.filter({ $0 == "," }).count > 1 || (cleaned.contains(",") && cleaned.contains(".")) {
            throw DesktopError("Use one comma or dot for cents, without thousands separators.")
        }
        cleaned = cleaned.replacingOccurrences(of: ",", with: ".")
        guard !cleaned.isEmpty else { throw DesktopError("Enter a monthly fee in dollars.") }
        let parts = cleaned.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, parts.allSatisfy({ $0.allSatisfy(\.isNumber) }), parts.count == 1 ? !parts[0].isEmpty : !parts[1].isEmpty else {
            throw DesktopError("Enter a plain dollar amount such as 200 or 19.99.")
        }
        if parts.count == 2, parts[1].count > 2 { throw DesktopError("Use at most two decimals.") }
        guard let value = Double(cleaned), value.isFinite, value >= 0 else { throw DesktopError("Enter a plain dollar amount such as 200 or 19.99.") }
        guard value <= maxUsd else { throw DesktopError("The fee must be at most " + UsageFormat.usd(maxUsd) + " a month.") }
        return value
    }
}

public struct UsageOverview: Codable, Equatable, Sendable {
    public struct Month: Codable, Equatable, Sendable {
        public var start: String
        public var end: String
        public var spent: Money
        public var previous: Money
        public var plansUsd: Double
        public var unmeasuredSessions: Int
        public init(start: String, end: String, spent: Money, previous: Money, plansUsd: Double, unmeasuredSessions: Int) {
            self.start = start; self.end = end; self.spent = spent; self.previous = previous; self.plansUsd = plansUsd; self.unmeasuredSessions = unmeasuredSessions
        }
    }
    public var month: Month
    public var accounts: [AccountView]
    public init(month: Month, accounts: [AccountView]) { self.month = month; self.accounts = accounts }
    public var withPlansUsd: Double { month.spent.usd + month.plansUsd }
}

public struct DailyUsage: Codable, Equatable, Sendable {
    public struct Day: Codable, Equatable, Sendable, Identifiable {
        public var date: String
        public var usd: Double
        public var byAccount: [String: Double]
        public init(date: String, usd: Double, byAccount: [String: Double]) { self.date = date; self.usd = usd; self.byAccount = byAccount }
        public var id: String { date }
    }
    public var tz: String
    public var accounts: [String]
    public var days: [Day]
    public init(tz: String, accounts: [String], days: [Day]) { self.tz = tz; self.accounts = accounts; self.days = days }
    public var maxUsd: Double { days.map(\.usd).max() ?? 0 }
}

public struct ProjectUsageSummary: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var total: Money
    public var month: Money
    public var spark: [Double]
    public var unmeasured: Int?
    public init(id: String, name: String, total: Money, month: Money, spark: [Double], unmeasured: Int? = nil) { self.id = id; self.name = name; self.total = total; self.month = month; self.spark = spark; self.unmeasured = unmeasured }
}
public struct UsageProjects: Codable, Equatable, Sendable {
    public var projects: [ProjectUsageSummary]
    public init(projects: [ProjectUsageSummary]) { self.projects = projects }
}

public struct ProjectUsage: Codable, Equatable, Sendable {
    public struct Kinds: Codable, Equatable, Sendable {
        public var goals: Double
        public var teams: Double
        public var sessions: Double
        public var briefings: Double
        public init(goals: Double, teams: Double, sessions: Double, briefings: Double) { self.goals = goals; self.teams = teams; self.sessions = sessions; self.briefings = briefings }
    }
    public struct Goal: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var total: Money
        public var tasks: Int
        public init(id: String, title: String, total: Money, tasks: Int) { self.id = id; self.title = title; self.total = total; self.tasks = tasks }
    }
    public struct Team: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var goalId: String?
        public var total: Money
        public init(id: String, title: String, goalId: String? = nil, total: Money) { self.id = id; self.title = title; self.goalId = goalId; self.total = total }
    }
    public struct Session: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var total: Money
        public init(id: String, title: String, total: Money) { self.id = id; self.title = title; self.total = total }
    }
    public struct Briefings: Codable, Equatable, Sendable {
        public var total: Money
        public var runs: Int
        public var unmeasured: Int
        public init(total: Money, runs: Int, unmeasured: Int) { self.total = total; self.runs = runs; self.unmeasured = unmeasured }
    }
    public var id: String
    public var name: String
    public var total: Money
    public var byKind: Kinds
    public var goals: [Goal]
    public var teams: [Team]
    public var sessions: [Session]
    public var briefings: Briefings
    public var unmeasured: Int?
    public init(id: String, name: String, total: Money, byKind: Kinds, goals: [Goal], teams: [Team], sessions: [Session], briefings: Briefings, unmeasured: Int? = nil) {
        self.id = id; self.name = name; self.total = total; self.byKind = byKind; self.goals = goals; self.teams = teams; self.sessions = sessions; self.briefings = briefings; self.unmeasured = unmeasured
    }
}

public struct TaskUsage: Codable, Equatable, Sendable {
    public var usd: Double
    public var unpriced: Int
    public var tokens: Int
    public var attempts: Int
    public var profiles: [String]
    public init(usd: Double, unpriced: Int, tokens: Int, attempts: Int, profiles: [String]) { self.usd = usd; self.unpriced = unpriced; self.tokens = tokens; self.attempts = attempts; self.profiles = profiles }
    public var money: Money { Money(usd: usd, unpriced: unpriced) }
}

public struct OwnerRating: Codable, Equatable, Sendable {
    public var score: Int
    public var note: String?
    public var at: String
    public init(score: Int, note: String? = nil, at: String) { self.score = score; self.note = note; self.at = at }
}

public struct RubricScore: Codable, Equatable, Sendable {
    public var score: Int
    public var why: String
    public init(score: Int, why: String) { self.score = score; self.why = why }
}
public struct Rubric: Codable, Equatable, Sendable {
    public var version: Int
    public var correctness: RubricScore
    public var cleanliness: RubricScore
    public var extensibility: RubricScore
    public var docs: RubricScore
    public var reviewerProfileId: String
    public init(version: Int, correctness: RubricScore, cleanliness: RubricScore, extensibility: RubricScore, docs: RubricScore, reviewerProfileId: String) {
        self.version = version; self.correctness = correctness; self.cleanliness = cleanliness; self.extensibility = extensibility; self.docs = docs; self.reviewerProfileId = reviewerProfileId
    }
}

public struct ModelRow: Codable, Equatable, Sendable, Identifiable {
    public struct RubricMeans: Codable, Equatable, Sendable {
        public var correctness: Double
        public var cleanliness: Double
        public var extensibility: Double
        public var docs: Double
        public var n: Int
        public init(correctness: Double, cleanliness: Double, extensibility: Double, docs: Double, n: Int) { self.correctness = correctness; self.cleanliness = cleanliness; self.extensibility = extensibility; self.docs = docs; self.n = n }
        public var mean: Double { (correctness + cleanliness + extensibility + docs) / 4 }
    }
    public struct OwnerMean: Codable, Equatable, Sendable {
        public var mean: Double
        public var n: Int
        public init(mean: Double, n: Int) { self.mean = mean; self.n = n }
    }
    public var profileId: String
    public var label: String
    public var provider: String
    public var role: String
    public var metered: Bool
    public var attempts: Int
    public var integrated: Int
    public var rate: Double
    public var rateInterval: [Double]?
    public var medianUsd: Double?
    public var medianTokens: Double?
    public var usdPerMTok: Double?
    public var medianMinutes: Double?
    public var meanReviewRounds: Double?
    public var rubric: RubricMeans?
    public var owner: OwnerMean?
    public var enough: Bool
    public var id: String { profileId + "/" + role }
    public var interval: (low: Double, high: Double)? {
        guard let rateInterval, rateInterval.count == 2 else { return nil }
        return (rateInterval[0], rateInterval[1])
    }
}
public struct ModelSuggestion: Codable, Equatable, Sendable {
    public var text: String
    public var profileId: String
    public var comparedTo: String
    public var role: String
    public var n: [Int]
    public init(text: String, profileId: String, comparedTo: String, role: String, n: [Int]) { self.text = text; self.profileId = profileId; self.comparedTo = comparedTo; self.role = role; self.n = n }
}
public struct Scorecard: Codable, Equatable, Sendable {
    public var rubricVersion: Int
    public var minAttempts: Int
    public var rows: [ModelRow]
    public var suggestions: [ModelSuggestion]
    public init(rubricVersion: Int, minAttempts: Int, rows: [ModelRow], suggestions: [ModelSuggestion]) { self.rubricVersion = rubricVersion; self.minAttempts = minAttempts; self.rows = rows; self.suggestions = suggestions }
    public var roles: [String] { Array(Set(rows.map(\.role))).sorted() }
}

public enum UsageFormat {
    public static func usd(_ value: Double) -> String {
        let magnitude = abs(value)
        let sign = value < 0 ? "−" : ""
        if magnitude >= 1_000_000 { return sign + "$" + trim(magnitude / 1_000_000, decimals: 1) + "M" }
        if magnitude >= 10_000 { return sign + "$" + trim(magnitude / 1_000, decimals: 1) + "K" }
        if magnitude >= 1_000 { return sign + "$" + grouped(magnitude.rounded()) }
        return sign + String(format: "$%.2f", magnitude)
    }
    public static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return trim(Double(value) / 1_000_000, decimals: 1) + "M" }
        if value >= 1_000 { return trim(Double(value) / 1_000, decimals: value < 10_000 ? 1 : 0) + "K" }
        return String(value)
    }
    public static func delta(_ current: Double, previous: Double) -> String? {
        guard previous > 0 else { return nil }
        let percent = (current - previous) / previous * 100
        let rounded = Int(percent.rounded())
        if rounded == 0 { return "0%" }
        return (rounded > 0 ? "+" : "−") + String(abs(rounded)) + "%"
    }
    public static func monthName(_ iso: String, locale: Locale = .current) -> String? {
        guard let date = parseISO(iso) else { return nil }
        return monthFormatter(locale).string(from: date)
    }
    public static func previousMonthName(_ iso: String, locale: Locale = .current) -> String? {
        guard let date = parseISO(iso), let previous = utcCalendar.date(byAdding: .month, value: -1, to: date) else { return nil }
        return monthFormatter(locale).string(from: previous)
    }
    private static let utcCalendar: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
    private static let isoFractional: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let isoPlain: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
    private static func parseISO(_ iso: String) -> Date? { isoFractional.date(from: iso) ?? isoPlain.date(from: iso) }
    private static func monthFormatter(_ locale: Locale) -> DateFormatter {
        let f = DateFormatter(); f.locale = locale; f.timeZone = TimeZone(identifier: "UTC"); f.setLocalizedDateFormatFromTemplate("MMMM"); return f
    }
    public static func percent(_ rate: Double) -> String { String(Int((rate * 100).rounded())) + "%" }
    public static func balance(_ balance: Balance) -> String {
        balance.currency.uppercased() == "USD" ? usd(balance.amount) : String(format: "%.2f ", balance.amount) + balance.currency
    }
    private static func trim(_ value: Double, decimals: Int) -> String {
        let text = String(format: "%.\(decimals)f", value)
        guard decimals > 0, text.contains(".") else { return text }
        var trimmed = Substring(text)
        while trimmed.hasSuffix("0") { trimmed = trimmed.dropLast() }
        if trimmed.hasSuffix(".") { trimmed = trimmed.dropLast() }
        return String(trimmed)
    }
    private static func grouped(_ value: Double) -> String {
        let digits = Array(String(Int(value)))
        var out = ""
        for (index, digit) in digits.enumerated() {
            if index > 0 && (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return out
    }
}

extension JSON {
    public func decoded<T: Decodable>(_ type: T.Type = T.self) throws -> T { try JSONDecoder().decode(T.self, from: data()) }
}

extension RemoteClient {
    private static func query(_ items: [(String, String?)]) -> String {
        let pairs = items.compactMap { key, value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return key + "=" + (value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value)
        }
        return pairs.isEmpty ? "" : "?" + pairs.joined(separator: "&")
    }
    public func usageOverview() async throws -> UsageOverview { try await request("/usage").decoded() }
    public func usageDaily(days: Int = 30, tz: String, project: String? = nil) async throws -> DailyUsage {
        try await request("/usage/daily" + Self.query([("days", String(days)), ("tz", tz), ("project", project)])).decoded()
    }
    public func usageProjects(tz: String) async throws -> UsageProjects { try await request("/usage/projects" + Self.query([("tz", tz)])).decoded() }
    public func usageProject(_ id: String, tz: String) async throws -> ProjectUsage {
        try await request(Self.usageProjectPath(id, tz: tz)).decoded()
    }
    static func usageProjectPath(_ id: String, tz: String) -> String { "/usage/projects/" + pathSegment(id) + query([("tz", tz)]) }
    static func pathSegment(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")) ?? id
    }
    public func usageModels(role: String? = nil) async throws -> Scorecard { try await request("/usage/models" + Self.query([("role", role)])).decoded() }
    public func refreshBalances() async throws -> [AccountView] {
        struct Reply: Decodable { var accounts: [AccountView] }
        return try await request("/usage/balances/refresh", body: .object([:])).decoded(Reply.self).accounts
    }
    public func setPlan(account: String, planUsd: Double?) async throws -> [AccountView] {
        struct Reply: Decodable { var accounts: [AccountView] }
        let body: JSON = .object(["planUsd": planUsd.map { .number($0) } ?? .null])
        return try await request("/usage/accounts/" + Self.pathSegment(account) + "/plan", body: body, method: "PUT").decoded(Reply.self).accounts
    }
    public func rateTask(team: String, task: String, score: Int, note: String? = nil, requestID: String) async throws -> JSON {
        var body: [String: JSON] = ["requestId": .string(requestID), "score": .number(Double(score))]
        if let note, !note.isEmpty { body["note"] = .string(note) }
        return try await request("/teams/\(team)/tasks/\(task)/rating", body: .object(body))
    }
}
