import SwiftUI
import InfiniteCore

func teamColor(_ team: TeamRun) -> Color {
    switch team.projectState {
    case .pending: return team.status == "ready-for-review" ? Palette.review : Palette.attention
    case .stuck: return Palette.error
    case .ongoing: return Palette.running
    case .paused: return Palette.paused
    case .complete: return Palette.done
    case .cancelled, .aborted: return .secondary
    }
}
private let teamClock: DateFormatter = { let f = DateFormatter(); f.dateStyle = .short; f.timeStyle = .short; return f }()
private func teamDate(_ value: String) -> String { ISO8601DateFormatter.flexible.date(from: value).map(teamClock.string(from:)) ?? value }

/// A sidebar row: the run's status glyph and name; its state in words is in the tooltip and on Home.
struct TeamRowView: View {
    let team: TeamRun
    var body: some View {
        HStack(spacing: 9) {
            StatusGlyph(team: team, size: 12)
            Text(team.title).lineLimit(1).foregroundStyle(team.projectState.closed ? .secondary : .primary)
            Spacer(minLength: 4)
            if team.projectState == .pending || team.projectState == .stuck {
                Text(team.projectState == .stuck ? "Stuck" : team.status == "ready-for-review" ? "Review" : "Needs you")
                    .font(.caption).foregroundStyle(team.projectState == .stuck ? Palette.error : Palette.attention)
            }
        }
        .padding(.vertical, 1)
        .help(team.summaryLine)
        .accessibilityLabel("\(team.title), \(team.summaryLine)")
    }
}

/// Everything a person needs to follow and steer one run: open decisions, member sessions that
/// need them, the work plan, the host's check and review evidence, and a direction composer.
struct TeamDetailView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var model: TeamModel
    @State private var confirmCancel = false
    @State private var confirmDiscard = false
    @State private var expandedTasks: Set<String> = []
    @State private var fullRequest = false
    private var team: TeamRun { model.run }
    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        banners
                        if team.status == "ready-for-review" { reviewPanel }
                        decisions
                        attention
                        section("Run map") {
                            RunDiagram(team: team) { id in
                                expandedTasks.insert(id)
                                withAnimation { proxy.scrollTo(id, anchor: .top) }
                            }
                        }
                        request
                        plan
                        evidence
                        membersSection
                        output
                        history
                    }.padding(20).frame(maxWidth: 900, alignment: .leading)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            composer.padding(12)
        }
        .background(Palette.background)
        .onAppear { model.startPolling() }
        .onDisappear { model.stopPolling() }
        .alert("Cancel this team run?", isPresented: $confirmCancel) {
            Button("Keep running", role: .cancel) {}
            Button("Cancel team", role: .destructive) { Task { await model.perform("cancel") } }
        } message: { Text("This stops its agent sessions and keeps the recorded work.") }
        .alert("Have you checked the team?", isPresented: $confirmDiscard) {
            Button("Keep pending request", role: .cancel) {}
            Button("Clear after review") { model.discardPending() }
        } message: { Text("The host may already have applied this request. Clearing it does not undo anything.") }
    }

    private var header: some View {
        HStack(spacing: 10) {
            StatusGlyph(team: team, size: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(team.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text("\(app.projectName(team.projectID)) · \(lead) · Revision \(team.revision) · up to \(team.parallelism) implementer\(team.parallelism == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            HStack(spacing: 5) {
                Image(systemName: "wifi.exclamationmark").font(.caption).foregroundStyle(.orange)
                    .frame(width: 12).opacity(model.displayStale ? 1 : 0)
                Text(team.statusLabel).font(.caption.weight(.medium)).lineLimit(1)
            }.padding(.horizontal, 9).padding(.vertical, 4)
                .glassSurface(in: Capsule(), tint: teamColor(team))
                .help(model.displayStale ? "Updates unavailable. Controls stay disabled until the next successful refresh." : "")
            if model.role == "owner" && team.status != "cancelled" {
                Menu {
                    let resumes = team.status == "paused" || team.offersResume
                    if resumes || !["blocked", "ready-for-review"].contains(team.status) {
                        Button(resumes ? "Resume team" : "Pause team") { Task { await model.perform(resumes ? "resume" : "pause") } }.disabled(!model.canOwn)
                    }
                    Button("Cancel team…", role: .destructive) { confirmCancel = true }.disabled(!model.canOwn)
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize().help("Team actions")
            }
        }
    }
    private var lead: String {
        team.hasLineup ? "Coordinator: \(team.lineup["coordinator"]["label"].string)" : providerName(team.provider)
    }

    @ViewBuilder private var banners: some View {
        if !team.reason.isEmpty { note(team.reason, color: .orange) }
    }

    /// The team's claim of readiness, the evidence behind it at a glance, and what to do next.
    /// Nothing here approves or merges; the person decides outside the host or sends a direction.
    private var reviewPanel: some View {
        let checks = team.currentChecks
        let passed = checks.filter { $0["status"].string == "passed" }.count
        let failed = checks.contains { $0["status"].string == "failed" }
        let (done, total) = team.progress
        let verdict = team.currentVerdict
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(.blue)
                Text("Ready for your review").font(.headline)
                Spacer()
                Text("Nothing merges until you do").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                SignalTile(value: "\(done)/\(total)", label: "tasks integrated", source: "host", color: total > 0 && done == total ? .green : .orange)
                SignalTile(value: checks.isEmpty ? "—" : "\(passed)/\(checks.count)", label: "checks passed", source: "host", color: failed ? .red : !checks.isEmpty && passed == checks.count ? .green : .secondary)
                SignalTile(value: verdict == "approved" ? "Approved" : verdict == "changes-requested" ? "Changes" : "—", label: "reviewer", source: "agent claim",
                           color: verdict == "approved" ? .green : verdict == "changes-requested" ? .red : .secondary)
            }
            Text("Your review").font(.subheadline.weight(.semibold))
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(team.reviewSteps.enumerated()), id: \.offset) { index, step in
                    ReviewStepRow(number: index + 1, step: step, enabled: model.canSteer) { text in model.direction = text }
                }
            }
            Divider()
            HStack(spacing: 10) {
                Text("Decide").font(.subheadline.weight(.semibold))
                Button { copy(team.branch) } label: { Label("Looks good · copy branch", systemImage: "checkmark") }
                    .disabled(team.branch.isEmpty).help("Copies the branch name to merge or publish yourself.")
                Button { model.direction = "Please change: " } label: { Label("Request changes", systemImage: "arrow.uturn.backward") }
                    .disabled(!model.canSteer).help("Drafts a direction below. The team replans when you send it.")
            }.controlSize(.small)
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.blue.opacity(0.25)))
    }

    private var request: some View {
        section("Your request") {
            VStack(alignment: .leading, spacing: 4) {
                Text(team.objective).font(.callout).textSelection(.enabled).lineLimit(fullRequest ? nil : 2).fixedSize(horizontal: false, vertical: true)
                Button(fullRequest ? "Show less" : "Show all") { fullRequest.toggle() }.buttonStyle(.link).font(.caption)
            }
        }
    }

    @ViewBuilder private var decisions: some View {
        let open = team.openDecisions
        if !open.isEmpty {
            section("Decisions for you", count: open.count) {
                ForEach(Array(open.enumerated()), id: \.offset) { _, decision in
                    DecisionCard(decision: decision, asker: team.member(decision["memberId"].string).map { TeamRun.roleName($0["role"].string) } ?? "Team",
                                 disabled: !model.canSteer || team.status == "paused") { text in Task { await model.answer(decision, text: text) } }
                }
            }
        }
    }

    /// Provider permission prompts belong to the member's own session; the team never answers them.
    @ViewBuilder private var attention: some View {
        let ids = Set(team.activeMembers.map { $0["sessionId"].string })
        let waiting = app.sessions.filter { ids.contains($0.id) && $0.needsYou }
        if !waiting.isEmpty {
            section("Agent sessions need you") {
                Text("Respond to provider permission prompts in the session. The team does not approve them.").font(.caption).foregroundStyle(.secondary)
                ForEach(waiting) { session in
                    HStack {
                        Circle().fill(Color.orange).frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 2) { Text(session.title).font(.callout); Text(session.now.isEmpty ? "Open the session to respond." : session.now).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        Spacer()
                        Button("Open session") { app.openSession(session.id) }.controlSize(.small)
                    }
                }
            }
        }
    }

    @ViewBuilder private var plan: some View {
        section("Work plan", count: team.tasks.count) {
            if team.tasks.isEmpty { Text("The coordinator has not reported a work plan yet.").font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(team.tasks.enumerated()), id: \.offset) { _, task in
                let id = task["id"].string
                TaskCard(task: task, team: team, expanded: Binding(get: { expandedTasks.contains(id) }, set: { if $0 { expandedTasks.insert(id) } else { expandedTasks.remove(id) } }),
                         rate: model.role == "owner" ? { score in Task { await model.rate(task: id, score: score) } } : nil, canRate: model.canOwn).id(id)
            }
        }
    }

    @ViewBuilder private var membersSection: some View {
        DisclosureGroup("Team members (\(team.members.count))") {
            if team.hasLineup { LineupView(lineup: team.lineup) }
            ForEach(Array(team.members.enumerated()), id: \.offset) { _, member in
                let session = app.sessions.first { $0.id == member["sessionId"].string }
                HStack(alignment: .top) {
                    Circle().fill(session.map(statusColor) ?? .secondary).frame(width: 7, height: 7).padding(.top, 6)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(member["title"].string).font(.callout)
                        Text([TeamRun.roleName(member["role"].string), member["status"].string, "revision \(member["revision"].int)", member["taskId"].string.isEmpty ? "" : "task \(member["taskId"].string)"].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if member["modelProfile"] != .null { ProfileLine(profile: member["modelProfile"]) }
                        else { Text(providerName(member["provider"].string.isEmpty ? team.provider : member["provider"].string)).font(.caption).foregroundStyle(.secondary) }
                        Text(session?.running == true ? (session?.now ?? "") : "")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(height: 14, alignment: .leading)
                    }
                    Spacer()
                    Button("Open session") { app.openSession(member["sessionId"].string) }.controlSize(.small).disabled(session == nil)
                }
            }
        }.font(.subheadline.weight(.semibold))
    }

    @ViewBuilder private var evidence: some View {
        section("Checks · run by the host") {
            if team.checks.isEmpty { Text("No check results recorded yet.").font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(team.checks.enumerated()), id: \.offset) { _, check in
                DisclosureGroup {
                    Text(check["output"].string.isEmpty ? "No output recorded." : check["output"].string)
                        .font(.system(size: 11, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading).background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                } label: {
                    HStack {
                        Text(([check["command"]["command"].string] + check["command"]["args"].array.map(\.string)).joined(separator: " ")).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Text("\(check["status"].string) · revision \(check["revision"].int)\(check["exitCode"] == .null ? "" : " · exit \(check["exitCode"].int)")")
                            .font(.caption).foregroundStyle(check["status"].string == "passed" ? Color.green : check["status"].string == "failed" ? .red : .secondary)
                    }
                }
            }
        }
        section("Reviewer · agent claim") {
            if team.review == .null { Text("No reviewer assessment recorded yet.").font(.callout).foregroundStyle(.secondary) }
            else {
                DisclosureGroup {
                    Text(team.review["summary"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
                } label: {
                    Label("\(team.review["verdict"].string == "approved" ? "Approved" : "Changes requested") · revision \(team.review["revision"].int)",
                          systemImage: team.review["verdict"].string == "approved" ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .font(.callout.weight(.medium)).foregroundStyle(team.review["verdict"].string == "approved" ? Color.green : .red)
                }
            }
        }
    }

    @ViewBuilder private var output: some View {
        DisclosureGroup("Branch and commits") {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow { Text("Branch").foregroundStyle(.secondary); mono(team.branch) }
                GridRow { Text("Workspace").foregroundStyle(.secondary); mono(team.workspace) }
                GridRow { Text("Base commit").foregroundStyle(.secondary); mono(team.baseCommit) }
                if !team.headCommit.isEmpty { GridRow { Text("Head commit").foregroundStyle(.secondary); mono(team.headCommit) } }
            }.font(.caption).padding(.top, 6)
        }.font(.subheadline.weight(.semibold))
    }

    @ViewBuilder private var history: some View {
        let answered = team.answeredDecisions
        if !team.steering.isEmpty || !answered.isEmpty {
            section("Your directions and decisions") {
                ForEach(Array(team.steering.enumerated()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Direction · revision \(entry["revision"].int) · \(teamDate(entry["at"].string))").font(.caption).foregroundStyle(.secondary)
                        Text(entry["text"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
                ForEach(Array(answered.enumerated()), id: \.offset) { _, decision in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Decision · revision \(decision["revision"].int)").font(.caption).foregroundStyle(.secondary)
                        Text(decision["question"].string).font(.callout).fixedSize(horizontal: false, vertical: true)
                        Text("Your answer: \(decision["answer"].string)").font(.callout.weight(.medium)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        if !team.events.isEmpty {
            DisclosureGroup("Run history (\(team.events.count))") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(team.events.enumerated()), id: \.offset) { _, event in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(teamDate(event["at"].string)).font(.caption).foregroundStyle(.tertiary).frame(width: 120, alignment: .leading)
                            Text(event["text"].string).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }.padding(.top, 6)
            }.font(.subheadline.weight(.semibold))
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let pending = model.pending, !model.busy {
                HStack {
                    Text("Unconfirmed request: \(pending.label.lowercased()) · revision \(pending.body["revision"].int)").font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("Retry same request") { Task { await model.retry() } }.disabled(!model.fresh)
                    Button("Clear…") { confirmDiscard = true }
                }
            }
            if model.role == "viewer" { Text("This device can view the team. An owner or controller can answer decisions and send direction.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            else if team.status == "cancelled" { Text("This run is cancelled. Its work and evidence remain available above.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            else {
                PromptEditor(text: Binding(get: { model.direction }, set: { model.direction = $0 }), placeholder: "Give the team a direction or change the requirements…",
                             enabled: model.canSteer, transparent: true, submit: { Task { await model.steer() } })
                    .frame(height: 64).glassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                HStack(spacing: 12) {
                    Text(model.notice.isEmpty ? "A direction records a new revision; the team replans from its integrated work." : model.notice)
                        .font(.system(size: 11)).foregroundStyle(model.noticeIsError ? Color.orange : .secondary).lineLimit(2).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).frame(height: 28, alignment: .leading)
                    Button { Task { await model.steer() } } label: {
                        Group { if model.busy { ProgressView().controlSize(.small) } else { Label("Send direction", systemImage: "arrow.up") } }.frame(width: 112)
                    }.buttonStyle(.borderedProminent).disabled(!model.canSteer || model.direction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, count: Int? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) { Text(title).font(.subheadline.weight(.semibold)); if let count { Text("\(count)").font(.caption).foregroundStyle(.secondary) } }
            content()
        }
    }
    private func note(_ text: String, color: Color) -> some View {
        Text(text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
    private func copy(_ text: String) {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    }
    private func mono(_ text: String) -> some View {
        Text(text.isEmpty ? "—" : text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
    }
}

/// A question a member asked, answered by its options or in words.
struct DecisionCard: View {
    let decision: JSON
    let asker: String
    let disabled: Bool
    let answer: (String) -> Void
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble").foregroundStyle(.orange)
                Text("\(asker) · revision \(decision["revision"].int) · \(teamDate(decision["createdAt"].string))").font(.caption).foregroundStyle(.secondary)
            }
            Text(decision["question"].string).font(.system(size: 13, weight: .medium)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            let options = decision["options"].array.map(\.string)
            if !options.isEmpty {
                HStack(spacing: 8) { ForEach(Array(options.enumerated()), id: \.offset) { _, option in Button(option) { answer(option) }.disabled(disabled) } }
            }
            HStack {
                TextField("Write your answer…", text: $text).textFieldStyle(.roundedBorder).disabled(disabled).onSubmit { submit() }
                Button("Send answer") { submit() }.disabled(disabled || text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }.padding(12).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
    private func submit() { let value = text; text = ""; answer(value) }
}

/// One line per task; expanding shows the agent's own report and the brief it worked from.
/// A metered task carries what it cost; the owner can rate any task from here.
struct TaskCard: View {
    let task: JSON
    let team: TeamRun
    @Binding var expanded: Bool
    var rate: ((Int) -> Void)? = nil
    var canRate = false
    private var status: String { task["status"].string }
    private var usage: TaskUsage? { task["usage"] == .null ? nil : try? task["usage"].decoded() }
    private var rating: OwnerRating? { task["ownerRating"] == .null ? nil : try? task["ownerRating"].decoded() }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: taskIcon(status).name).foregroundStyle(taskIcon(status).color)
                    Text(task["title"].string).font(.callout.weight(.medium)).lineLimit(1)
                    Text(agentLabel(task, team)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    if let usage { MoneyText(usage.money).font(.caption).monospacedDigit().foregroundStyle(.secondary) }
                    Text("\(task["paths"].array.count) file\(task["paths"].array.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
                    Text(status).font(.caption).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).rotationEffect(.degrees(expanded ? 90 : 0))
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
            if expanded {
                let depends = task["dependsOn"].array.map { id in team.task(id.string)?["title"].string ?? id.string }
                if !depends.isEmpty { Text("After: \(depends.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary) }
                assigned
                if let usage { spend(usage) }
                if rate != nil || rating != nil {
                    HStack(spacing: 6) {
                        Text("Your rating").font(.caption).foregroundStyle(.secondary)
                        RatingControl(score: rating?.score, at: rating?.at, enabled: rate != nil && canRate) { score in rate?(score) }
                    }
                }
                HStack(spacing: 6) {
                    Text("Owns").font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(task["paths"].array.enumerated()), id: \.offset) { _, path in Text(path.string).font(.system(size: 11, design: .monospaced)).lineLimit(1) }
                }
                if !task["summary"].string.isEmpty {
                    Text(task["summary"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
                }
                DisclosureGroup("Task instructions") {
                    Text(task["instructions"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
                    if !task["commit"].string.isEmpty { Text("Integrated commit: \(task["commit"].string)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
                }.font(.caption)
            }
        }.padding(10).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
    /// What the task cost across every attempt, from the host's ledger.
    private func spend(_ usage: TaskUsage) -> some View {
        HStack(spacing: 6) {
            Text("Spent").font(.caption).foregroundStyle(.secondary)
            MoneyText(usage.money).font(.caption.weight(.medium)).monospacedDigit()
            Text("· \(UsageFormat.tokens(usage.tokens)) tokens · \(usage.attempts) attempt\(usage.attempts == 1 ? "" : "s")" + (usage.profiles.isEmpty ? "" : " · " + usage.profiles.joined(separator: ", ")))
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }
    @ViewBuilder private var assigned: some View {
        HStack(spacing: 6) {
            Text("Assigned agent").font(.caption).foregroundStyle(.secondary)
            if let profile = taskProfile(task, team) { ProfileLine(profile: profile) }
            else if !task["agentProfileId"].string.isEmpty { Text("Profile \(task["agentProfileId"].string) · model details unavailable").font(.caption) }
            else if team.hasLineup { Text("Model assignment pending").font(.caption) }
            else { Text(agentLabel(task, team)).font(.caption) }
        }
    }
}

private func taskIcon(_ status: String) -> (name: String, color: Color) {
    switch status {
    case "integrated": return ("checkmark.circle.fill", .green)
    case "running": return ("circle.dotted.circle", .green)
    case "waiting": return ("clock", .orange)
    case "blocked": return ("exclamationmark.triangle", .orange)
    default: return ("circle", .secondary)
    }
}
private func taskProfile(_ task: JSON, _ team: TeamRun) -> JSON? {
    let member = task["memberId"].string.isEmpty ? nil : team.member(task["memberId"].string)
    return member.flatMap { $0["modelProfile"] == .null ? nil : $0["modelProfile"] }
        ?? team.lineup["implementers"].array.first { $0["id"].string == task["agentProfileId"].string && !task["agentProfileId"].string.isEmpty }
}
private func agentLabel(_ task: JSON, _ team: TeamRun) -> String {
    if let profile = taskProfile(task, team) { return profile["label"].string }
    let member = task["memberId"].string.isEmpty ? nil : team.member(task["memberId"].string)
    return providerName(member?["provider"].string.isEmpty == false ? member!["provider"].string : team.provider)
}

/// The run as a pipeline: plan, the tasks in dependency columns, then integration, checks,
/// review, and the person. Tapping a task opens its card below.
struct RunDiagram: View {
    let team: TeamRun
    let select: (String) -> Void
    var body: some View {
        let stages = team.stages
        let columns = team.taskColumns
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .center, spacing: 0) {
                StageNode(name: stages[0].name, state: stages[0].state)
                arrow
                if columns.isEmpty { StageNode(name: stages[1].name, state: stages[1].state); arrow }
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(column.enumerated()), id: \.offset) { _, task in
                            Button { select(task["id"].string) } label: { taskNode(task) }.buttonStyle(.plain).help("Show this task's report")
                        }
                    }
                    arrow
                }
                ForEach(2..<stages.count, id: \.self) { index in
                    StageNode(name: stages[index].name, state: stages[index].state)
                    if index < stages.count - 1 { arrow }
                }
            }.padding(.vertical, 2)
        }
    }
    private var arrow: some View { Image(systemName: "arrow.right").font(.caption).foregroundStyle(.tertiary).padding(.horizontal, 6) }
    private func taskNode(_ task: JSON) -> some View {
        let icon = taskIcon(task["status"].string)
        return HStack(spacing: 6) {
            Image(systemName: icon.name).foregroundStyle(icon.color).font(.caption)
            VStack(alignment: .leading, spacing: 1) {
                Text(task["title"].string).font(.caption.weight(.medium)).lineLimit(1)
                Text("\(agentLabel(task, team)) · \(task["paths"].array.count) file\(task["paths"].array.count == 1 ? "" : "s")").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
        }.padding(.horizontal, 8).padding(.vertical, 6).frame(width: 165, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(icon.color.opacity(0.45)))
    }
}

struct StageNode: View {
    let name: String
    let state: TeamRun.StageState
    var body: some View {
        let style: (icon: String, color: Color) = switch state {
        case .done: ("checkmark.circle.fill", .green)
        case .active: (name == "You" ? "person.fill" : "circle.dotted.circle", name == "You" ? .blue : .orange)
        case .failed: ("xmark.octagon.fill", .red)
        case .pending: ("circle", .secondary)
        }
        VStack(spacing: 3) {
            Image(systemName: style.icon).foregroundStyle(style.color)
            Text(name).font(.caption.weight(state == .pending ? .regular : .medium)).foregroundStyle(state == .pending ? .secondary : .primary)
        }.frame(minWidth: 58).padding(.vertical, 7).padding(.horizontal, 6)
        .background(style.color.opacity(state == .pending ? 0.04 : 0.12), in: RoundedRectangle(cornerRadius: 7))
    }
}

/// One number with where it came from, so host facts and agent claims never blur.
struct SignalTile: View {
    let value: String
    let label: String
    let source: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.system(size: 20, weight: .semibold, design: .rounded)).foregroundStyle(color)
            Text(label).font(.caption)
            Text(source).font(.system(size: 10)).foregroundStyle(.secondary)
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct ReviewStepRow: View {
    let number: Int
    let step: TeamRun.ReviewStep
    let enabled: Bool
    let draft: (String) -> Void
    @State private var copied = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)").font(.caption.weight(.bold)).foregroundStyle(.white).frame(width: 18, height: 18)
                .background(step.urgent ? Color.red : .blue, in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(step.title).font(.callout.weight(.medium))
                Text(step.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            switch step.action {
            case .direction(let text):
                Button("Draft") { draft(text) }.controlSize(.small).disabled(!enabled).help("Puts this direction in the box below for you to edit and send.")
            case .copy(let text):
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); copied = true
                }.controlSize(.small).help(text)
            }
        }
    }
}

/// Requested model settings are what the host asked for; provider policy may still override them.
struct ProfileLine: View {
    let profile: JSON
    var body: some View {
        HStack(spacing: 6) {
            Text(profile["label"].string).font(.caption.weight(.medium))
            Text("Requested: \(providerName(profile["provider"].string)) · \(profile["model"].string) · effort \(profile["effort"].string)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

struct LineupView: View {
    let lineup: JSON
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("This lineup was recorded when the run started. It shows requested model settings; provider policy may override them.").font(.caption).foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                GridRow { Text("Coordinator").font(.caption).foregroundStyle(.secondary); ProfileLine(profile: lineup["coordinator"]) }
                GridRow(alignment: .top) {
                    Text("Implementer pool").font(.caption).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 3) { ForEach(Array(lineup["implementers"].array.enumerated()), id: \.offset) { _, profile in ProfileLine(profile: profile) } }
                }
                GridRow { Text("Integrator").font(.caption).foregroundStyle(.secondary); ProfileLine(profile: lineup["integrator"]) }
                GridRow { Text("Reviewer").font(.caption).foregroundStyle(.secondary); ProfileLine(profile: lineup["reviewer"]) }
            }
        }.padding(.bottom, 4)
    }
}

/// Starts a run: an outcome, a workspace with configured checks, and the agents to use.
struct TeamCreateView: View {
    @ObservedObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var objective = ""
    @State private var title = ""
    @State private var project = ""
    @State private var provider = "claude"
    @State private var useLineup = false
    @State private var parallelism = 2
    @State private var busy = false
    @State private var error = ""
    @State private var clearPending = false
    private var providers: [String] { app.teamProviders }
    private var selectedProject: JSON? { app.projects.first { $0["id"].string == project } }
    private var projectReady: Bool { app.teamWorkspaceReady(project) }
    private var pending: Bool { app.pendingTeamCreation.pendingID != nil }
    private var effectiveProvider: String { useLineup ? app.teamLineup["coordinator"]["provider"].string : provider }
    private var canStart: Bool { !busy && !project.isEmpty && (pending || (app.teamsEnabled && projectReady && !effectiveProvider.isEmpty && !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New team").font(.title2.weight(.semibold))
            Text("Describe the outcome. A coordinator plans the work, implementers build it in isolated copies, the host runs the project's checks, and a reviewer assesses the result. The team asks when it needs a decision.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Name", text: $title, prompt: Text("Uses the first line of your request"))
                Picker("Workspace", selection: $project) {
                    ForEach(Array(app.projects.enumerated()), id: \.offset) { _, item in
                        Text(item["name"].string + (item["team"]["checks"].array.isEmpty ? " · setup required" : "")).tag(item["id"].string)
                    }
                }
                if app.teamLineup != .null {
                    Picker("Agent setup", selection: $useLineup) { Text("Configured lineup").tag(true); Text("Single provider").tag(false) }
                }
                if !useLineup {
                    Picker("Agent provider", selection: $provider) { ForEach(providers, id: \.self) { Text(providerName($0)).tag($0) } }
                }
                Stepper("Parallel implementers: \(parallelism)", value: $parallelism, in: 1...app.teamParallelismLimit)
            }.disabled(pending)
            VStack(alignment: .leading, spacing: 4) {
                Text("Feature request or PRD").font(.callout)
                PromptEditor(text: $objective, placeholder: "Describe the outcome, who it is for, and what should happen…", enabled: !pending, submit: {})
                    .frame(height: 150).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.14)))
            }
            if useLineup { LineupView(lineup: app.teamLineup) }
            if !app.teamsEnabled { Text("Teams need host setup: enable teams in the host configuration and give the workspace its required checks.").font(.callout).foregroundStyle(.orange) }
            else if !project.isEmpty && !projectReady { Text("This workspace needs required team checks in the host configuration.").font(.callout).foregroundStyle(.orange) }
            if let selectedProject, !selectedProject["team"]["checks"].array.isEmpty {
                Text("Required checks: " + selectedProject["team"]["checks"].array.map { ([$0["command"].string] + $0["args"].array.map(\.string)).joined(separator: " ") }.joined(separator: " · "))
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
            }
            Text("Work runs on the server in isolated workspaces with the provider permissions configured there. Permission prompts still need your response in the agent session.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !useLineup && provider == "demo" { Text("Rehearsal uses a local test process. It does not call an AI model or implement a real feature.").font(.caption).foregroundStyle(.orange) }
            if pending {
                Text("A team request is pending. Retry uses its original request identity. Check the team list before starting a different one.").font(.callout).foregroundStyle(.orange)
                Button("Clear after checking teams…") { clearPending = true }.disabled(busy)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "Starting…" : pending ? "Retry same request" : "Start team") {
                    busy = true
                    Task {
                        do { try await app.createTeam(projectID: project, provider: effectiveProvider, useLineup: useLineup, title: title, objective: objective, parallelism: parallelism); dismiss() }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(!canStart)
            }
        }.padding(26).frame(width: 560)
        .alert("Clear the pending team request?", isPresented: $clearPending) {
            Button("Keep pending", role: .cancel) {}
            Button("I checked the teams") { app.clearTeamCreation() }
        } message: { Text("The server may already have started this team. Clearing does not stop it.") }
        .onAppear {
            project = app.defaultTeamWorkspace
            useLineup = app.teamLineup != .null
            if !providers.contains(provider) { provider = providers.first { $0 != "demo" } ?? providers.first ?? "" }
        }
    }
}
