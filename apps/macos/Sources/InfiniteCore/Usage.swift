import Foundation

// The host's usage contract (`packages/host/src/usage-api.ts`), mirrored field for field. Money is
// USD in dollars; a figure with `unpriced > 0` is a floor, never an exact amount. A balance exists
// only when the provider's own API returned one; `nil` renders as "—", never as an estimate.

public struct Money: Codable, Equatable, Sendable {
    public var usd: Double
    public var unpriced: Int
    public init(usd: Double, unpriced: Int = 0) { self.usd = usd; self.unpriced = unpriced }
    public static let zero = Money(usd: 0)
    /// "≥ $12.40" when some steps carried no price, "—" when nothing priced was measured, otherwise "$12.40".
    public var label: String { display().label }
    public var isFloor: Bool { unpriced > 0 }
    /// How a figure shows once the work the ledger could not price or see is counted in. A figure is
    /// never $0 when something was spent that nobody measured; it is a floor when part was measured.
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

public struct AccountView: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var kind: String
    public var month: Money?
    public var planUsd: Double?
    public var balance: Balance?
    public init(id: String, kind: String, month: Money? = nil, planUsd: Double? = nil, balance: Balance? = nil) {
        self.id = id; self.kind = kind; self.month = month; self.planUsd = planUsd; self.balance = balance
    }
    public var metered: Bool { kind == "metered" }
}

/// `GET /api/usage`: the month headline and the accounts. The older per-provider fields pass through untouched.
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
    /// Metered spend plus every subscription's fixed monthly fee.
    public var withPlansUsd: Double { month.spent.usd + month.plansUsd }
}

/// `GET /api/usage/daily`: one row per day in the requested timezone, oldest first, stacked by account.
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

/// `GET /api/usage/projects`: accrued cost per project with a 30-day sparkline, oldest first.
public struct ProjectUsageSummary: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var total: Money
    public var month: Money
    public var spark: [Double]
    /// Sessions and briefings the ledger could not measure; absent on hosts that do not count them yet.
    public var unmeasured: Int?
    public init(id: String, name: String, total: Money, month: Money, spark: [Double], unmeasured: Int? = nil) { self.id = id; self.name = name; self.total = total; self.month = month; self.spark = spark; self.unmeasured = unmeasured }
}
public struct UsageProjects: Codable, Equatable, Sendable {
    public var projects: [ProjectUsageSummary]
    public init(projects: [ProjectUsageSummary]) { self.projects = projects }
}

/// `GET /api/usage/projects/:id`: everything attributed to one project, split by kind.
public struct ProjectUsage: Codable, Equatable, Sendable {
    /// Dollars spent per kind of work. Counts come from the rows themselves and from `briefings.runs`.
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
    /// Sessions and briefings the ledger could not measure; absent on hosts that do not count them yet.
    public var unmeasured: Int?
    public init(id: String, name: String, total: Money, byKind: Kinds, goals: [Goal], teams: [Team], sessions: [Session], briefings: Briefings, unmeasured: Int? = nil) {
        self.id = id; self.name = name; self.total = total; self.byKind = byKind; self.goals = goals; self.teams = teams; self.sessions = sessions; self.briefings = briefings; self.unmeasured = unmeasured
    }
}

/// A task's cost on the team view: every member that worked it, replacements included.
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

/// `GET /api/usage/models`: one row per model profile in a role. Cost columns are `nil` for
/// subscription profiles; `enough` is false below `minAttempts`, where no ranking is shown.
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
    /// The Wilson 95% interval as a pair, when the host computed one.
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

/// Short figures for the cost views: dollars, tokens, and the change between two periods.
public enum UsageFormat {
    /// "$0.42", "$12.50", "$1,284", "$12.9K", "$1.2M". Cents matter below a thousand dollars.
    public static func usd(_ value: Double) -> String {
        let magnitude = abs(value)
        let sign = value < 0 ? "−" : ""
        if magnitude >= 1_000_000 { return sign + "$" + trim(magnitude / 1_000_000, decimals: 1) + "M" }
        if magnitude >= 10_000 { return sign + "$" + trim(magnitude / 1_000, decimals: 1) + "K" }
        if magnitude >= 1_000 { return sign + "$" + grouped(magnitude.rounded()) }
        return sign + String(format: "$%.2f", magnitude)
    }
    /// "31K", "1.2M", "640".
    public static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return trim(Double(value) / 1_000_000, decimals: 1) + "M" }
        if value >= 1_000 { return trim(Double(value) / 1_000, decimals: value < 10_000 ? 1 : 0) + "K" }
        return String(value)
    }
    /// The change from `previous` to `current` as a signed percent ("+18%", "−8%", "0%"); nil when
    /// there is no previous figure to compare with.
    public static func delta(_ current: Double, previous: Double) -> String? {
        guard previous > 0 else { return nil }
        let percent = (current - previous) / previous * 100
        let rounded = Int(percent.rounded())
        if rounded == 0 { return "0%" }
        return (rounded > 0 ? "+" : "−") + String(abs(rounded)) + "%"
    }
    /// The month an ISO instant falls in, read in UTC because the host's month windows start at
    /// 00:00 UTC; the local zone would name the previous month west of Greenwich.
    public static func monthName(_ iso: String, locale: Locale = .current) -> String? {
        guard let date = parseISO(iso) else { return nil }
        return monthFormatter(locale).string(from: date)
    }
    /// The month before the one `iso` falls in, in the same UTC reading.
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
    /// "0.91" style rate as a percent without decimals: "91%".
    public static func percent(_ rate: Double) -> String { String(Int((rate * 100).rounded())) + "%" }
    /// A balance in its own currency: "$12.50", "12.50 CNY".
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
    /// The host's JSON as a typed contract value; numbers round-trip as JSON numbers, so integer fields decode.
    public func decoded<T: Decodable>(_ type: T.Type = T.self) throws -> T { try JSONDecoder().decode(T.self, from: data()) }
}

/// The usage routes. Every read sends the device timezone so daily buckets match the owner's day.
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
        try await request("/usage/projects/" + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id) + Self.query([("tz", tz)])).decoded()
    }
    public func usageModels(role: String? = nil) async throws -> Scorecard { try await request("/usage/models" + Self.query([("role", role)])).decoded() }
    /// Owner only; the host re-reads the balance at most once a minute.
    public func refreshBalances() async throws -> [AccountView] {
        struct Reply: Decodable { var accounts: [AccountView] }
        return try await request("/usage/balances/refresh", body: .object([:])).decoded(Reply.self).accounts
    }
    /// Owner only, idempotent per `requestID`. Returns the host's updated team view.
    public func rateTask(team: String, task: String, score: Int, note: String? = nil, requestID: String) async throws -> JSON {
        var body: [String: JSON] = ["requestId": .string(requestID), "score": .number(Double(score))]
        if let note, !note.isEmpty { body["note"] = .string(note) }
        return try await request("/teams/\(team)/tasks/\(task)/rating", body: .object(body))
    }
}
