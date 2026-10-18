import SwiftUI
import InfiniteCore

func teamColor(_ team: TeamRun) -> Color {
    team.needsYou || team.status == "blocked" ? .orange : team.working ? .green : team.status == "ready-for-review" ? .blue : .secondary
}
private let teamClock: DateFormatter = { let f = DateFormatter(); f.dateStyle = .short; f.timeStyle = .short; return f }()
private func teamDate(_ value: String) -> String { ISO8601DateFormatter.flexible.date(from: value).map(teamClock.string(from:)) ?? value }

/// A sidebar row: the run's name and what it is waiting on or how far its plan got.
struct TeamRowView: View {
    let team: TeamRun
    var body: some View {
        HStack(spacing: 9) {
            Circle().fill(teamColor(team)).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(team.title).lineLimit(1).foregroundStyle(team.finished ? .secondary : .primary)
                Text(team.summaryLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }.padding(.vertical, 2)
    }
}

/// Everything a person needs to follow and steer one run: open decisions, member sessions that
/// need them, the work plan, the host's check and review evidence, and a direction composer.
struct TeamDetailView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var model: TeamModel
    @State private var confirmCancel = false
    @State private var confirmDiscard = false
    private var team: TeamRun { model.run }
    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    banners
                    decisions
                    attention
                    plan
                    membersSection
                    evidence
                    output
                    history
                }.padding(20).frame(maxWidth: 900, alignment: .leading)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            composer.padding(12)
        }
        .background(Color(nsColor: .windowBackgroundColor))
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
            Circle().fill(teamColor(team)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(team.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text("\(app.projectName(team.projectID)) · \(lead) · Revision \(team.revision) · up to \(team.parallelism) implementer\(team.parallelism == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if !model.fresh { Text("Updates unavailable").font(.caption).foregroundStyle(.orange) }
            Text(team.statusLabel).font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 3)
                .background(teamColor(team).opacity(0.16), in: Capsule())
            if model.role == "owner" && team.status != "cancelled" {
                Menu {
                    if !["blocked", "ready-for-review"].contains(team.status) {
                        Button(team.status == "paused" ? "Resume team" : "Pause team") { Task { await model.perform(team.status == "paused" ? "resume" : "pause") } }.disabled(!model.canOwn)
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
        if team.status == "ready-for-review" {
            Label("The team reports this run is ready for your review. Inspect the changes and evidence before merging or publishing.", systemImage: "checkmark.circle")
                .font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        }
        section("Your request") { Text(team.objective).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
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
            ForEach(Array(team.tasks.enumerated()), id: \.offset) { _, task in TaskCard(task: task, team: team) }
        }
    }

    @ViewBuilder private var membersSection: some View {
        section("Team members", count: team.members.count) {
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
                        if let session, session.running, !session.now.isEmpty { Text(session.now).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    Spacer()
                    Button("Open session") { app.openSession(member["sessionId"].string) }.controlSize(.small).disabled(session == nil)
                }
            }
        }
    }

    @ViewBuilder private var evidence: some View {
        section("Verification evidence") {
            Text("Host check results and the reviewer's assessment are recorded separately. Reports are agent claims; checks are the host's own.").font(.caption).foregroundStyle(.secondary)
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
            HStack(spacing: 6) { Text("Reviewer assessment").font(.subheadline.weight(.semibold)); Text("agent report").font(.caption).foregroundStyle(.secondary) }.padding(.top, 4)
            if team.review == .null { Text("No reviewer assessment recorded yet.").font(.callout).foregroundStyle(.secondary) }
            else {
                Text("\(team.review["verdict"].string == "approved" ? "Approved by reviewer" : "Changes requested") · revision \(team.review["revision"].int)").font(.callout.weight(.medium))
                Text(team.review["summary"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var output: some View {
        section("Review the changes") {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow { Text("Branch").foregroundStyle(.secondary); mono(team.branch) }
                GridRow { Text("Workspace").foregroundStyle(.secondary); mono(team.workspace) }
                GridRow { Text("Base commit").foregroundStyle(.secondary); mono(team.baseCommit) }
                if !team.headCommit.isEmpty { GridRow { Text("Head commit").foregroundStyle(.secondary); mono(team.headCommit) } }
            }.font(.caption)
        }
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
            if let pending = model.pending {
                HStack {
                    Text("Unconfirmed request: \(pending.label.lowercased()) · revision \(pending.body["revision"].int)").font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("Retry same request") { Task { await model.retry() } }.disabled(model.busy || !model.fresh)
                    Button("Clear…") { confirmDiscard = true }.disabled(model.busy)
                }
            }
            if model.role == "viewer" { Text("This device can view the team. An owner or controller can answer decisions and send direction.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            else if team.status == "cancelled" { Text("This run is cancelled. Its work and evidence remain available above.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            else {
                PromptEditor(text: Binding(get: { model.direction }, set: { model.direction = $0 }), placeholder: "Give the team a direction or change the requirements…",
                             enabled: model.canSteer, submit: { Task { await model.steer() } })
                    .frame(height: 64).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.14)))
                HStack(spacing: 12) {
                    Text(model.notice.isEmpty ? "A direction records a new revision; the team replans from its integrated work." : model.notice)
                        .font(.system(size: 11)).foregroundStyle(model.noticeIsError ? Color.orange : .secondary).lineLimit(2).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { Task { await model.steer() } } label: { Label(model.busy ? "Sending…" : "Send direction", systemImage: "arrow.up") }
                        .buttonStyle(.borderedProminent).disabled(!model.canSteer || model.direction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

struct TaskCard: View {
    let task: JSON
    let team: TeamRun
    private var status: String { task["status"].string }
    private var icon: (name: String, color: Color) {
        switch status {
        case "integrated": return ("checkmark.circle.fill", .green)
        case "running": return ("circle.dotted.circle", .green)
        case "waiting": return ("clock", .orange)
        case "blocked": return ("exclamationmark.triangle", .orange)
        default: return ("circle", .secondary)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: icon.name).foregroundStyle(icon.color)
                Text(task["title"].string).font(.callout.weight(.medium))
                Spacer()
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            let depends = task["dependsOn"].array.map { id in team.task(id.string)?["title"].string ?? id.string }
            Text(depends.isEmpty ? "No task dependencies" : "After: \(depends.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary)
            assigned
            HStack(spacing: 6) {
                Text("Owns").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(task["paths"].array.enumerated()), id: \.offset) { _, path in Text(path.string).font(.system(size: 11, design: .monospaced)).lineLimit(1) }
            }
            if !task["summary"].string.isEmpty { Text(task["summary"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            DisclosureGroup("Task instructions") {
                Text(task["instructions"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
                if !task["commit"].string.isEmpty { Text("Integrated commit: \(task["commit"].string)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
            }.font(.caption)
        }.padding(12).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
    @ViewBuilder private var assigned: some View {
        let member = task["memberId"].string.isEmpty ? nil : team.member(task["memberId"].string)
        let profile = member.flatMap { $0["modelProfile"] == .null ? nil : $0["modelProfile"] }
            ?? team.lineup["implementers"].array.first { $0["id"].string == task["agentProfileId"].string && !task["agentProfileId"].string.isEmpty }
        HStack(spacing: 6) {
            Text("Assigned agent").font(.caption).foregroundStyle(.secondary)
            if let profile { ProfileLine(profile: profile) }
            else if !task["agentProfileId"].string.isEmpty { Text("Profile \(task["agentProfileId"].string) · model details unavailable").font(.caption) }
            else if team.hasLineup { Text("Model assignment pending").font(.caption) }
            else { Text(providerName(member?["provider"].string.isEmpty == false ? member!["provider"].string : team.provider)).font(.caption) }
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
    private var providers: [String] { let all = app.me["providers"].array.map(\.string); return all.contains("claude") ? ["claude"] + all.filter { $0 != "claude" } : all }
    private var selectedProject: JSON? { app.projects.first { $0["id"].string == project } }
    private var projectReady: Bool { !(selectedProject?["team"]["checks"].array.isEmpty ?? true) }
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
            project = (app.projects.first { !$0["team"]["checks"].array.isEmpty } ?? app.projects.first)?["id"].string ?? ""
            useLineup = app.teamLineup != .null
            if !providers.contains(provider) { provider = providers.first { $0 != "demo" } ?? providers.first ?? "" }
        }
    }
}
