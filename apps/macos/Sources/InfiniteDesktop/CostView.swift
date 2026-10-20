import SwiftUI
import Charts
import InfiniteCore

/// Money the agents spent on this host: the month at a glance, thirty days stacked by account, each
/// account's balance or plan, projects ranked by accrued cost, and a scorecard of model profiles.
/// Every figure is the host's own ledger; a floor shows "≥", an absent balance shows "—", never $0.
@MainActor final class CostModel: ObservableObject {
    enum Tab: String, CaseIterable, Identifiable { case overview, projects, models; var id: String { rawValue }; var title: String { rawValue.capitalizedFirst } }
    @Published var tab: Tab = .overview
    @Published private(set) var overview: UsageOverview?
    @Published private(set) var daily: DailyUsage?
    @Published private(set) var projects: [ProjectUsageSummary] = []
    @Published private(set) var scorecard: Scorecard?
    @Published private(set) var project: ProjectUsage?
    @Published private(set) var projectDaily: DailyUsage?
    @Published private(set) var projectID: String?
    @Published var role = "implementer" { didSet { if role != oldValue { Task { await loadModels() } } } }
    @Published private(set) var loading = false
    @Published private(set) var error = ""
    @Published private(set) var loadedAt: Date?
    let client: RemoteClient
    let owner: Bool
    /// Days are bucketed in this Mac's timezone, so the bars match the owner's calendar.
    let tz = TimeZone.current.identifier
    init(client: RemoteClient, owner: Bool) { self.client = client; self.owner = owner }

    /// One pass over every route; a single failing route leaves the others' data in place.
    func load() async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        async let overview = client.usageOverview()
        async let daily = client.usageDaily(days: 30, tz: tz)
        async let projects = client.usageProjects(tz: tz)
        async let models = client.usageModels(role: role)
        var failures: [String] = []
        do { self.overview = try await overview } catch { failures.append(error.localizedDescription) }
        do { self.daily = try await daily } catch { failures.append(error.localizedDescription) }
        do { self.projects = try await projects.projects.sorted { $0.total.usd > $1.total.usd } } catch { failures.append(error.localizedDescription) }
        do { self.scorecard = try await models } catch { failures.append(error.localizedDescription) }
        if let id = projectID { await loadProject(id) }
        self.error = failures.first ?? ""
        if failures.isEmpty { loadedAt = Date() }
    }
    func loadModels() async {
        do { scorecard = try await client.usageModels(role: role); error = "" } catch { self.error = error.localizedDescription }
    }
    func open(project id: String) async {
        projectID = id; tab = .projects
        if project?.id != id { project = nil; projectDaily = nil }
        await loadProject(id)
    }
    func closeProject() { projectID = nil; project = nil; projectDaily = nil }
    private func loadProject(_ id: String) async {
        async let detail = client.usageProject(id, tz: tz)
        async let days = client.usageDaily(days: 30, tz: tz, project: id)
        do { let value = try await detail; if projectID == id { project = value } } catch { self.error = error.localizedDescription }
        do { let value = try await days; if projectID == id { projectDaily = value } } catch { self.error = error.localizedDescription }
    }
    /// Owner only: asks the provider for a fresh balance, then reloads everything.
    func refresh() async {
        if owner { do { _ = try await client.refreshBalances() } catch { self.error = error.localizedDescription } }
        await load()
    }
    /// Owner only: sets a subscription's monthly fee (`nil` returns to the config default). The host's
    /// reply replaces the account tiles at once; the month headline follows on the next load. A refusal
    /// is thrown for the editor to show beside the field and never touches the view's figures.
    func setPlan(account id: String, usd: Double?) async throws {
        let accounts = try await client.setPlan(account: id, planUsd: usd)
        if var overview { overview.accounts = accounts; self.overview = overview }
        await load()
    }
    var minAttempts: Int { scorecard?.minAttempts ?? 10 }
    var roles: [String] {
        var roles = scorecard?.roles ?? []
        for known in ["implementer", "reviewer", "integrator", "project-manager"] where !roles.contains(known) { roles.append(known) }
        return roles
    }
}

/// One color per account, fixed by name so a filter never repaints a survivor. The order was checked
/// for colour-vision separation on the dark ground; unknown accounts take the free slots in turn.
enum AccountPalette {
    private static func hex(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
    static let blue = hex(0x3987E5), yellow = hex(0xC98500), violet = hex(0x9085E9), aqua = hex(0x199E70), orange = hex(0xD95926)
    private static let known: [String: Color] = ["deepseek": blue, "meta": yellow, "claude": violet, "codex": aqua]
    private static let slots: [Color] = [blue, yellow, violet, aqua, orange]
    static func colors(for accounts: [String]) -> [String: Color] {
        var result: [String: Color] = [:]
        var free = slots.filter { slot in !accounts.contains { known[$0] == slot } }
        for account in accounts.sorted() {
            if let color = known[account] { result[account] = color }
            else { result[account] = free.isEmpty ? Palette.muted : free.removeFirst() }
        }
        return result
    }
    static func color(_ account: String, in colors: [String: Color]) -> Color { colors[account] ?? Palette.muted }
}

private let dayParser: DateFormatter = { let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f }()
private let dayName: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEE d MMM"); return f }()

struct CostView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var model: CostModel
    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 20).padding(.vertical, 10)
            Divider()
            ScrollView {
                Group {
                    switch model.tab {
                    case .overview: OverviewSection(model: model)
                    case .projects: if model.projectID != nil { ProjectDetailSection(model: model) } else { ProjectsSection(model: model) }
                    case .models: ModelsSection(model: model)
                    }
                }
                .frame(maxWidth: 860, alignment: .leading).padding(.horizontal, 32).padding(.top, 28).padding(.bottom, 48)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Palette.background)
        .task(id: app.activeID) {
            // Refresh while shown; the task ends with the view.
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }
    private var header: some View {
        HStack(spacing: 12) {
            Picker("View", selection: $model.tab) { ForEach(CostModel.Tab.allCases) { Text($0.title).tag($0) } }
                .pickerStyle(.segmented).labelsHidden().fixedSize()
            if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(Palette.attention).lineLimit(1).truncationMode(.tail) }
            Spacer(minLength: 8)
            if !app.connected { Text("Offline · last received").font(.caption).foregroundStyle(Palette.attention) }
            else if let at = model.loadedAt { Text("as of \(shortAge(at))").font(.caption).foregroundStyle(.tertiary).monospacedDigit() }
            if model.loading { ProgressView().controlSize(.small) }
            Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless).foregroundStyle(.secondary).disabled(model.loading || !app.connected)
                .help(model.owner ? "Reload and ask providers for fresh balances" : "Reload")
                .accessibilityLabel("Refresh cost figures")
        }
    }
}

/// A dollar figure with its source marker: "≥" and a dotted line when some steps carried no price.
/// Unmeasured work counts the same way: a figure with gaps is a floor, and nothing measured is "—", never $0.
struct MoneyText: View {
    let money: Money
    let unmeasured: Int
    init(_ money: Money, unmeasured: Int = 0) { self.money = money; self.unmeasured = unmeasured }
    private var display: Money.Display { money.display(unmeasured: unmeasured) }
    private var gaps: String {
        var parts: [String] = []
        if money.unpriced > 0 { parts.append("\(money.unpriced) step\(money.unpriced == 1 ? "" : "s") had no price") }
        if unmeasured > 0 { parts.append("\(unmeasured) session\(unmeasured == 1 ? "" : "s") unmeasured") }
        return parts.joined(separator: " · ")
    }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            switch display {
            case .absent: Text("—").foregroundStyle(.tertiary)
            case .floor(let usd):
                Text("≥").foregroundStyle(.secondary)
                Text(UsageFormat.usd(usd)).overlay(alignment: .bottom) {
                    // A hairline of dots under a floor, the same weight at every size.
                    Line().stroke(Palette.muted, style: StrokeStyle(lineWidth: 1, dash: [1, 2])).frame(height: 1).offset(y: 2)
                }
            case .exact(let usd): Text(UsageFormat.usd(usd))
            }
        }
        .help(display == .exact(money.usd) ? "" : (display == .absent ? "Not measured: " : "At least: ") + gaps)
        .accessibilityLabel(display == .absent ? "not measured" : display.label.replacingOccurrences(of: "≥ ", with: "at least "))
    }
    private struct Line: Shape {
        func path(in rect: CGRect) -> Path { var path = Path(); path.move(to: CGPoint(x: rect.minX, y: rect.midY)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)); return path }
    }
}

/// The month's metered spend, the thirty-day bars, and each account in one row that is also the legend.
private struct OverviewSection: View {
    @ObservedObject var model: CostModel
    private var colors: [String: Color] { AccountPalette.colors(for: Set((model.daily?.accounts ?? []) + (model.overview?.accounts.map(\.id) ?? [])).sorted()) }
    var body: some View {
        VStack(alignment: .leading, spacing: 30) {
            if let overview = model.overview { headline(overview) }
            else if model.loading { Text("Loading…").font(.callout).foregroundStyle(.secondary) }
            else { Text(model.error.isEmpty ? "No usage figures yet." : "Usage figures unavailable.").font(.callout).foregroundStyle(.secondary) }
            if let daily = model.daily {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Last 30 days · metered, by account").font(.caption).foregroundStyle(.tertiary)
                    DailyChart(daily: daily, colors: colors)
                }
            }
            if let overview = model.overview, !overview.accounts.isEmpty {
                AccountRow(accounts: overview.accounts, colors: colors, owner: model.owner) { id, usd in try await model.setPlan(account: id, usd: usd) }
            }
            CostLegend()
        }
    }
    private func headline(_ overview: UsageOverview) -> some View {
        // The host's month starts at 00:00 UTC; the name is read in UTC so it never slips a month west of it.
        let month = UsageFormat.monthName(overview.month.start)
        let previous = UsageFormat.previousMonthName(overview.month.start)
        let delta = UsageFormat.delta(overview.month.spent.usd, previous: overview.month.previous.usd)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                MoneyText(overview.month.spent).font(.system(size: 48, weight: .semibold, design: .rounded))
                if let delta {
                    HStack(spacing: 4) {
                        Image(systemName: delta.hasPrefix("+") ? "arrow.up.right" : delta.hasPrefix("−") ? "arrow.down.right" : "arrow.right").font(.system(size: 10, weight: .bold))
                        Text(delta).monospacedDigit()
                        if let previous { Text("vs \(previous)").foregroundStyle(.secondary) }
                    }
                    .font(.caption.weight(.medium)).padding(.horizontal, 9).padding(.vertical, 4)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                    .help("Metered spend this month against \(overview.month.previous.label) last month")
                } else {
                    Text("first month").font(.caption).foregroundStyle(.tertiary)
                }
            }
            HStack(spacing: 6) {
                Text(month ?? "This month").foregroundStyle(.primary)
                dot
                HStack(spacing: 4) { Text("with plans"); Text(UsageFormat.usd(overview.withPlansUsd)).monospacedDigit().foregroundStyle(.primary) }
                if overview.month.unmeasuredSessions > 0 { dot; Text("\(overview.month.unmeasuredSessions) unmeasured").monospacedDigit() }
                dot
                Text("this host only")
            }
            .font(.callout).foregroundStyle(.secondary)
        }
    }
    private var dot: some View { Text("·").foregroundStyle(.tertiary) }
}

/// Thirty days of metered spend stacked by account. Hovering a day shows its split; the account row below is the legend.
struct DailyChart: View {
    let daily: DailyUsage
    let colors: [String: Color]
    @State private var selected: Date?
    private var days: [(day: Date, row: DailyUsage.Day)] { daily.days.compactMap { row in dayParser.date(from: row.date).map { ($0, row) } } }
    private var selectedRow: (day: Date, row: DailyUsage.Day)? {
        guard let selected else { return nil }
        return days.first { Calendar.current.isDate($0.day, inSameDayAs: selected) }
    }
    private var empty: Bool { daily.maxUsd <= 0 }
    var body: some View {
        Chart {
            ForEach(days, id: \.row.id) { entry in
                ForEach(daily.accounts, id: \.self) { account in
                    BarMark(x: .value("Day", entry.day, unit: .day), y: .value("USD", entry.row.byAccount[account] ?? 0), width: .ratio(0.6))
                        .foregroundStyle(by: .value("Account", account))
                }
            }
            if let selectedRow {
                RuleMark(x: .value("Day", selectedRow.day, unit: .day))
                    .foregroundStyle(Color.primary.opacity(0.18)).lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, alignment: .center, spacing: 8, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) { tooltip(selectedRow) }
            }
        }
        .chartForegroundStyleScale(domain: daily.accounts, range: daily.accounts.map { AccountPalette.color($0, in: colors) })
        .chartLegend(.hidden)
        .chartXSelection(value: $selected)
        .chartYScale(domain: 0...(empty ? 1 : daily.maxUsd * 1.12))
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                AxisGridLine().foregroundStyle(Palette.line)
                AxisValueLabel(format: .dateTime.month(.abbreviated).day(), anchor: .top).foregroundStyle(.tertiary)
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine().foregroundStyle(Palette.line)
                AxisValueLabel { if let usd = value.as(Double.self) { Text(usd == 0 ? "0" : UsageFormat.usd(usd)).font(.system(size: 10)).monospacedDigit().foregroundStyle(.tertiary) } }
            }
        }
        .frame(height: 190)
        .overlay(alignment: .center) { if empty { Text("No metered spend in 30 days").font(.callout).foregroundStyle(.tertiary) } }
        .accessibilityLabel("Daily metered spend, 30 days, \(daily.tz)")
        .accessibilityValue(days.map { "\($0.row.date) \(UsageFormat.usd($0.row.usd))" }.joined(separator: ", "))
    }
    private func tooltip(_ entry: (day: Date, row: DailyUsage.Day)) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(dayName.string(from: entry.day)).foregroundStyle(.secondary); Spacer(minLength: 12); Text(UsageFormat.usd(entry.row.usd)).fontWeight(.semibold).monospacedDigit() }
            ForEach(daily.accounts.filter { (entry.row.byAccount[$0] ?? 0) > 0 }, id: \.self) { account in
                HStack(spacing: 6) {
                    Circle().fill(AccountPalette.color(account, in: colors)).frame(width: 6, height: 6)
                    Text(account); Spacer(minLength: 12)
                    Text(UsageFormat.usd(entry.row.byAccount[account] ?? 0)).monospacedDigit().foregroundStyle(.secondary)
                }
            }
        }
        .font(.caption).padding(.horizontal, 10).padding(.vertical, 7).frame(minWidth: 140, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Palette.line))
    }
}

/// Each account beside its series colour: what it spent this month or costs per month, and its balance.
private struct AccountRow: View {
    let accounts: [AccountView]
    let colors: [String: Color]
    /// Only the owner may change a subscription's fee; everyone else sees the figure alone.
    let owner: Bool
    let setPlan: (String, Double?) async throws -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                if index > 0 { Rectangle().fill(Palette.line).frame(width: 1).padding(.vertical, 2).padding(.horizontal, 18) }
                card(account)
            }
        }
    }
    private func card(_ account: AccountView) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Circle().fill(AccountPalette.color(account.id, in: colors)).frame(width: 8, height: 8)
                Text(account.id).font(.callout.weight(.semibold))
                Text(account.metered ? "metered" : "plan").font(.caption).foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let month = account.month { MoneyText(month).font(.system(size: 22, weight: .semibold, design: .rounded)) }
                    else if let plan = account.planUsd { Text(UsageFormat.usd(plan)).font(.system(size: 22, weight: .semibold, design: .rounded)) }
                    else { Text("—").font(.system(size: 22, weight: .semibold, design: .rounded)).foregroundStyle(.tertiary) }
                    if owner, !account.metered { PlanFeeEditor(account: account, setPlan: setPlan) }
                }
                HStack(spacing: 4) {
                    Text(account.metered ? "this month" : "per month")
                    if account.planSetByOwner { Text("· set by you") }
                }.font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    if let balance = account.balance {
                        Text(UsageFormat.balance(balance)).font(.callout.weight(.medium)).monospacedDigit()
                        if balance.stale { Text("stale").font(.caption).foregroundStyle(Palette.attention) }
                    } else {
                        Text("—").font(.callout.weight(.medium)).foregroundStyle(.tertiary)
                    }
                }
                HStack(spacing: 4) {
                    Text("balance")
                    if let balance = account.balance { Text("· as of \(shortAge(balance.asOf))").monospacedDigit() }
                }.font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The owner's pencil beside a subscription fee: a popover with the dollar field, Save, Cancel, and
/// "Reset to default" once the owner has overridden the config. The figure is checked here the way the
/// host checks it (0–100000, two decimals); a refusal from the host shows beneath the field verbatim.
private struct PlanFeeEditor: View {
    let account: AccountView
    let setPlan: (String, Double?) async throws -> Void
    @State private var open = false
    @State private var text = ""
    @State private var problem = ""
    @State private var saving = false
    var body: some View {
        Button { text = account.planUsd.map { String(format: "%.2f", $0) } ?? ""; problem = ""; open = true } label: {
            Image(systemName: "pencil").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).frame(width: 18, height: 18).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Change the monthly fee for \(account.id)")
        .accessibilityLabel("Edit \(account.id) monthly fee")
        .popover(isPresented: $open, arrowEdge: .bottom) { editor }
    }
    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Monthly fee · \(account.id)").font(.caption.weight(.medium)).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text("$").foregroundStyle(.secondary)
                TextField("0.00", text: $text).textFieldStyle(.roundedBorder).frame(width: 110).monospacedDigit()
                    .disabled(saving).onSubmit { save() }
                    .accessibilityLabel("Monthly fee in dollars")
            }
            if !problem.isEmpty { Text(problem).font(.caption).foregroundStyle(Palette.error).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 230, alignment: .leading) }
            HStack(spacing: 8) {
                if account.planSetByOwner {
                    Button("Reset to default") { apply(nil) }.disabled(saving).help("Return to the fee in the host's config")
                }
                Spacer(minLength: 8)
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { open = false }.keyboardShortcut(.cancelAction).disabled(saving)
                Button("Save") { save() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent).disabled(saving)
            }
            .controlSize(.small)
        }
        .padding(14).frame(minWidth: 250)
    }
    private func save() {
        do { apply(try PlanFee.parse(text)) } catch { problem = error.localizedDescription }
    }
    private func apply(_ usd: Double?) {
        problem = ""; saving = true
        Task {
            do { try await setPlan(account.id, usd); open = false }
            catch { problem = error.localizedDescription }
            saving = false
        }
    }
}

/// The one legend for every marker the cost views use.
private struct CostLegend: View {
    var body: some View {
        HStack(spacing: 22) {
            item("≥ $", "some steps had no price")
            item("—", "the provider reports no balance")
            item("unmeasured", "sessions the ledger cannot see")
        }
        .font(.caption).foregroundStyle(.tertiary)
    }
    private func item(_ mark: String, _ meaning: String) -> some View {
        HStack(spacing: 5) { Text(mark).foregroundStyle(.secondary).monospacedDigit(); Text(meaning) }
    }
}

/// Projects ranked by accrued cost, each with its last thirty days.
private struct ProjectsSection: View {
    @ObservedObject var model: CostModel
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.projects.isEmpty {
                Text(model.loading && model.loadedAt == nil ? "Loading…" : "No metered spend is attributed to a project yet.").font(.callout).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 14) {
                    Text("Project").frame(maxWidth: .infinity, alignment: .leading)
                    Text("30 days").frame(width: 104, alignment: .leading)
                    Text("Month").frame(width: 84, alignment: .trailing)
                    Text("Total").frame(width: 96, alignment: .trailing)
                }
                .font(.caption.weight(.medium)).foregroundStyle(.tertiary).padding(.horizontal, 10).padding(.bottom, 6)
                ForEach(model.projects) { project in ProjectRowView(project: project) { Task { await model.open(project: project.id) } } }
            }
        }
    }
}

private struct ProjectRowView: View {
    let project: ProjectUsageSummary
    let open: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: open) {
            HStack(spacing: 14) {
                Text(project.name).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Sparkline(values: project.spark).frame(width: 104, height: 24)
                MoneyText(project.month).font(.callout).monospacedDigit().foregroundStyle(.secondary).frame(width: 84, alignment: .trailing)
                MoneyText(project.total, unmeasured: project.unmeasured ?? 0).font(.callout.weight(.medium)).monospacedDigit().frame(width: 96, alignment: .trailing)
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10).padding(.vertical, 9).contentShape(Rectangle())
            .background(hovering ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(project.name), \(project.month.label) this month, \(project.total.label) total")
        .accessibilityHint("Opens the project's cost")
    }
}

/// Thirty daily values as one quiet line; the last day carries a marker.
struct Sparkline: View {
    let values: [Double]
    private var top: Double { max(values.max() ?? 0, 0.01) }
    var body: some View {
        let points = Array(values.enumerated())
        Chart(points, id: \.offset) { point in
            AreaMark(x: .value("Day", point.offset), y: .value("USD", point.element))
                .interpolationMethod(.monotone)
                .foregroundStyle(LinearGradient(colors: [Palette.accent.opacity(0.22), Palette.accent.opacity(0)], startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("Day", point.offset), y: .value("USD", point.element))
                .interpolationMethod(.monotone).lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).foregroundStyle(Palette.accent)
            if point.offset == points.count - 1 {
                PointMark(x: .value("Day", point.offset), y: .value("USD", point.element)).symbolSize(22).foregroundStyle(Palette.accent)
            }
        }
        .chartXAxis(.hidden).chartYAxis(.hidden).chartLegend(.hidden)
        .chartYScale(domain: 0...(top * 1.15)).chartXScale(domain: 0...max(1, values.count - 1))
        .chartPlotStyle { $0.padding(.vertical, 3) }
        .accessibilityHidden(true)
    }
}

/// One project's goals, team runs, sessions, and briefings, each with its cost, under its own daily bars.
private struct ProjectDetailSection: View {
    @ObservedObject var model: CostModel
    private var colors: [String: Color] { AccountPalette.colors(for: Set((model.projectDaily?.accounts ?? []) + (model.daily?.accounts ?? [])).sorted()) }
    var body: some View {
        VStack(alignment: .leading, spacing: 26) {
            Button { model.closeProject() } label: { Label("Projects", systemImage: "chevron.left").font(.callout) }
                .buttonStyle(.plain).foregroundStyle(.secondary).keyboardShortcut("[", modifiers: .command)
            if let project = model.project {
                HStack(alignment: .firstTextBaseline, spacing: 14) {
                    Text(project.name).font(.title2.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 12)
                    MoneyText(project.total, unmeasured: project.unmeasured ?? 0).font(.system(size: 28, weight: .semibold, design: .rounded))
                }
                if let daily = model.projectDaily { DailyChart(daily: daily, colors: colors) }
                HStack(alignment: .top, spacing: 26) {
                    kind(project.goals.count, "goal", usd: project.byKind.goals)
                    kind(project.teams.count, "team run", usd: project.byKind.teams)
                    kind(project.sessions.count, "session", usd: project.byKind.sessions)
                    kind(project.briefings.runs, "briefing", usd: project.byKind.briefings)
                }
                if !project.goals.isEmpty {
                    group("Goals") {
                        ForEach(project.goals) { goal in
                            row(goal.title, detail: "\(goal.tasks) task\(goal.tasks == 1 ? "" : "s")", money: goal.total)
                        }
                    }
                }
                if !project.teams.isEmpty {
                    group("Team runs") {
                        ForEach(project.teams) { team in
                            row(team.title, detail: team.goalId.flatMap { id in project.goals.first { $0.id == id }?.title }, money: team.total)
                        }
                    }
                }
                if !project.sessions.isEmpty {
                    group("Sessions") { ForEach(project.sessions) { session in row(session.title, detail: nil, money: session.total) } }
                }
                if project.briefings.runs > 0 || project.briefings.total.usd > 0 {
                    group("Briefings") {
                        row("\(project.briefings.runs) run\(project.briefings.runs == 1 ? "" : "s")", detail: project.briefings.unmeasured > 0 ? "\(project.briefings.unmeasured) unmeasured" : nil,
                            money: project.briefings.total, unmeasured: project.briefings.unmeasured)
                    }
                }
                CostLegend()
            } else {
                Text(model.error.isEmpty ? "Loading…" : "Project cost unavailable.").font(.callout).foregroundStyle(.secondary)
            }
        }
    }
    /// How many of a kind, and the dollars they add up to.
    private func kind(_ n: Int, _ noun: String, usd: Double) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(n)").font(.system(size: 17, weight: .semibold, design: .rounded)).monospacedDigit()
                Text(n == 1 ? noun : noun + "s").font(.caption).foregroundStyle(.secondary)
            }
            Text(n == 0 && usd <= 0 ? "—" : UsageFormat.usd(usd)).font(.callout).monospacedDigit().foregroundStyle(n == 0 && usd <= 0 ? .tertiary : .secondary)
        }
    }
    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.bottom, 4)
            content()
        }
    }
    private func row(_ title: String, detail: String?, money: Money, unmeasured: Int = 0) -> some View {
        HStack(spacing: 12) {
            Text(title).lineLimit(1)
            if let detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            Spacer(minLength: 12)
            MoneyText(money, unmeasured: unmeasured).font(.callout).monospacedDigit()
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1).padding(.horizontal, 10) }
    }
}

/// Model profiles in one role: outcomes, cost, time, and quality, with n beside every figure and no
/// ranking below the host's minimum sample. Subscription profiles show "—" for money.
private struct ModelsSection: View {
    @ObservedObject var model: CostModel
    /// Ranked rows first, by integrated rate; the rest follow by sample size.
    private var rows: [ModelRow] {
        (model.scorecard?.rows ?? []).sorted {
            if $0.enough != $1.enough { return $0.enough }
            if $0.rate != $1.rate { return $0.rate > $1.rate }
            return $0.attempts > $1.attempts
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 12) {
                Picker("Role", selection: $model.role) { ForEach(model.roles, id: \.self) { Text(TeamRun.roleName($0)).tag($0) } }
                    .pickerStyle(.menu).fixedSize()
                Spacer()
                Text("rubric v\(model.scorecard?.rubricVersion ?? 1) · ranked from \(model.minAttempts) attempts · Wilson 95%").font(.caption).foregroundStyle(.tertiary)
            }
            if rows.isEmpty {
                Text(model.loading && model.scorecard == nil ? "Loading…" : "No \(TeamRun.roleName(model.role).lowercased()) attempts recorded yet.").font(.callout).foregroundStyle(.secondary)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
                    GridRow {
                        Text("Model"); Text("n").gridColumnAlignment(.trailing); Text("Integrated"); Text("Median $").gridColumnAlignment(.trailing); Text("$ / MTok").gridColumnAlignment(.trailing)
                        Text("Minutes").gridColumnAlignment(.trailing); Text("Rounds").gridColumnAlignment(.trailing); Text("Rubric").gridColumnAlignment(.trailing); Text("Owner").gridColumnAlignment(.trailing)
                    }
                    .font(.caption.weight(.medium)).foregroundStyle(.tertiary).padding(.bottom, 6)
                    ForEach(rows) { row in
                        Divider().gridCellUnsizedAxes(.horizontal).overlay(Palette.line)
                        ModelGridRow(row: row, minAttempts: model.minAttempts).padding(.vertical, 8)
                    }
                }
                .font(.callout)
            }
            if let suggestions = model.scorecard?.suggestions, !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text("Suggestions").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        Text("advisory · routing stays yours").font(.caption).foregroundStyle(.tertiary)
                    }
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { _, suggestion in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "lightbulb").font(.caption).foregroundStyle(Palette.accent)
                            Text(suggestion.text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            Text("n \(suggestion.n.map(String.init).joined(separator: " · "))").font(.caption).foregroundStyle(.tertiary).monospacedDigit()
                        }
                    }
                }
            }
            HStack(spacing: 22) {
                HStack(spacing: 5) { Text("—").foregroundStyle(.secondary); Text("subscription · no per-use dollars") }
                HStack(spacing: 5) { Text("n").foregroundStyle(.secondary); Text("attempts, limit switches excluded") }
            }.font(.caption).foregroundStyle(.tertiary)
        }
    }
}

private struct ModelGridRow: View {
    let row: ModelRow
    let minAttempts: Int
    var body: some View {
        GridRow {
            VStack(alignment: .leading, spacing: 1) {
                Text(row.label).fontWeight(.medium).lineLimit(1)
                Text(providerName(row.provider)).font(.caption).foregroundStyle(.secondary)
            }
            .frame(minWidth: 150, alignment: .leading)
            Text("\(row.attempts)").monospacedDigit().foregroundStyle(row.enough ? .primary : .secondary)
            if row.enough {
                HStack(spacing: 8) {
                    RateBar(rate: row.rate, interval: row.interval, color: Palette.accent)
                    Text(UsageFormat.percent(row.rate)).monospacedDigit().frame(width: 36, alignment: .trailing)
                    Text("\(row.integrated)/\(row.attempts)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                .help(row.interval.map { "95% interval \(UsageFormat.percent($0.low))–\(UsageFormat.percent($0.high))" } ?? "")
                figure(row.medianUsd.map(UsageFormat.usd), metered: row.metered)
                figure(row.usdPerMTok.map { UsageFormat.usd($0) }, metered: row.metered)
                figure(row.medianMinutes.map { String(Int($0.rounded())) }, metered: true)
                figure(row.meanReviewRounds.map { String(format: "%.1f", $0) }, metered: true)
                scored(row.rubric.map { ($0.mean, $0.n) })
                scored(row.owner.map { ($0.mean, $0.n) })
            } else {
                Text("not enough data · \(minAttempts) attempts needed").foregroundStyle(.tertiary).gridCellColumns(7)
            }
        }
    }
    private func figure(_ text: String?, metered: Bool) -> some View {
        Text(text ?? "—").monospacedDigit().foregroundStyle(text == nil ? .tertiary : .primary).help(metered || text != nil ? "" : "Subscription: no per-use dollars")
    }
    private func scored(_ value: (mean: Double, n: Int)?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            if let value {
                Text(String(format: "%.1f", value.mean)).monospacedDigit()
                Text("n\(value.n)").font(.caption).foregroundStyle(.tertiary).monospacedDigit()
            } else { Text("—").foregroundStyle(.tertiary) }
        }
    }
}

/// The integrated rate as a point, with its 95% interval as the band behind it.
struct RateBar: View {
    let rate: Double
    let interval: (low: Double, high: Double)?
    let color: Color
    var body: some View {
        GeometryReader { area in
            let width = area.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.line).frame(height: 4)
                if let interval {
                    Capsule().fill(color.opacity(0.35)).frame(width: max(4, width * (interval.high - interval.low)), height: 4).offset(x: width * interval.low)
                }
                Circle().fill(color).frame(width: 8, height: 8).overlay(Circle().stroke(Palette.background, lineWidth: 2)).offset(x: min(width - 8, max(0, width * rate - 4)))
            }.frame(height: 8, alignment: .center).frame(maxHeight: .infinity)
        }
        .frame(width: 96, height: 12)
        .accessibilityLabel("integrated \(UsageFormat.percent(rate))" + (interval.map { ", interval \(UsageFormat.percent($0.low)) to \(UsageFormat.percent($0.high))" } ?? ""))
    }
}

/// The owner's 1–5 rating of a task: five marks, the chosen one and those below it filled.
struct RatingControl: View {
    let score: Int?
    let at: String?
    let enabled: Bool
    let rate: (Int) -> Void
    @State private var hover: Int?
    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                ForEach(1...5, id: \.self) { mark in
                    Button { rate(mark) } label: {
                        Image(systemName: mark <= (hover ?? score ?? 0) ? "star.fill" : "star").font(.system(size: 12))
                            .foregroundStyle(mark <= (hover ?? score ?? 0) ? Palette.accent : Palette.muted).frame(width: 18, height: 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!enabled).onHover { hover = $0 && enabled ? mark : nil }
                    .accessibilityLabel("Rate \(mark) of 5")
                }
            }
            if let score { Text("\(score)/5" + (at.map { " · \(shortAge($0))" } ?? "")).font(.caption).foregroundStyle(.secondary).monospacedDigit() }
            else { Text(enabled ? "Rate this task" : "Not rated").font(.caption).foregroundStyle(.tertiary) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(score.map { "Your rating \($0) of 5" } ?? "Not rated")
    }
}

