import SwiftUI
import InfiniteCore

/// Home: one text box that starts a team, above every run grouped by what it needs next.
struct HomeView: View {
    @ObservedObject var app: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                if app.teamsEnabled { TeamStartBox(app: app) }
                ProjectList(app: app)
            }
            .frame(maxWidth: 720).padding(.horizontal, 32).padding(.top, 72).padding(.bottom, 40)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.background)
    }
}

/// A team starts from a sentence in the chosen workspace, with the host's configured lineup (or its
/// first provider) and two implementers. The full form stays one click away for anything else.
struct TeamStartBox: View {
    @ObservedObject var app: AppModel
    @State private var objective = ""
    @State private var project = ""
    @State private var busy = false
    @State private var error = ""
    @State private var confirmClear = false
    private var pending: Bool { app.pendingTeamCreation.pendingID != nil }
    private var useLineup: Bool { app.teamLineup != .null }
    private var provider: String { useLineup ? app.teamLineup["coordinator"]["provider"].string : app.teamProviders.first { $0 != "demo" } ?? app.teamProviders.first ?? "" }
    private var ready: Bool { app.connected && app.isOwner && !busy && !project.isEmpty }
    private var canStart: Bool { ready && (pending || (app.teamWorkspaceReady(project) && !provider.isEmpty && !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
    /// The title of the request waiting for confirmation, read back from its saved body.
    private var pendingTitle: String {
        guard let text = app.pendingTeamCreation.pendingText, let value = try? JSON.parse(Data(text.utf8)) else { return "" }
        return value["title"].string
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 0) {
                PromptEditor(text: $objective, placeholder: pending ? "A team request is waiting for confirmation" : "Describe what a team should build or fix…",
                             enabled: canStart, transparent: true, submit: start)
                    .frame(height: 76)
                HStack(spacing: 12) {
                    workspaceMenu.disabled(pending || busy)
                    Button { app.showingCreateTeam = true } label: { Image(systemName: "slider.horizontal.3") }
                        .buttonStyle(.borderless).foregroundStyle(.secondary).help("More options: name, agents, and parallelism")
                        .disabled(!app.connected || !app.isOwner)
                    Spacer()
                    Button(action: start) {
                        Image(systemName: busy ? "ellipsis" : "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 18, height: 18)
                    }
                    .glassButton(prominent: true).buttonBorderShape(.circle).controlSize(.regular)
                    .disabled(!canStart).help(pending ? "Retry the same request" : "Start the team")
                    .accessibilityLabel(pending ? "Retry the same team request" : "Start team")
                }
                .padding(.horizontal, 12).padding(.bottom, 10)
            }
            .glassSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            notes.padding(.horizontal, 6)
        }
        .onAppear(perform: reset)
        .onChange(of: app.me) { _, _ in reset() }
        .alert("Clear the pending team request?", isPresented: $confirmClear) {
            Button("Keep pending", role: .cancel) {}
            Button("I checked the teams") { app.clearTeamCreation() }
        } message: { Text("The server may already have started this team. Clearing does not stop it.") }
    }

    private var workspaceMenu: some View {
        Menu {
            ForEach(Array(app.projects.enumerated()), id: \.offset) { _, item in
                Button { project = item["id"].string } label: {
                    Text(item["name"].string + (item["team"]["checks"].array.isEmpty ? " · setup required" : ""))
                }
            }
        } label: { Label(project.isEmpty ? "Workspace" : app.projectName(project), systemImage: "folder") }
            .menuStyle(.borderlessButton).font(.callout).tint(.secondary).fixedSize()
    }
    @ViewBuilder private var notes: some View {
        if pending {
            HStack(spacing: 10) {
                Image(systemName: "clock.badge.questionmark").foregroundStyle(.orange)
                Text("“\(pendingTitle)” was sent but not confirmed. Check the list before starting another.").lineLimit(2)
                Spacer()
                Button("Clear…") { confirmClear = true }.disabled(busy)
            }.font(.caption)
        }
        if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Palette.error).textSelection(.enabled) }
        else if !app.isOwner && app.connected { Text("Only an owner device can start a team.").font(.caption).foregroundStyle(.secondary) }
        else if !project.isEmpty && !app.teamWorkspaceReady(project) { Text("This workspace needs required team checks in the host configuration.").font(.caption).foregroundStyle(.orange) }
        else if provider == "demo" { Text("Rehearsal runs a local test process, not an AI model.").font(.caption).foregroundStyle(.orange) }
    }

    private func reset() {
        if project.isEmpty || !app.projects.contains(where: { $0["id"].string == project }) { project = app.defaultTeamWorkspace }
    }
    private func start() {
        guard canStart else { return }
        busy = true; error = ""
        Task {
            do {
                try await app.createTeam(projectID: project, provider: provider, useLineup: useLineup, title: "", objective: objective, parallelism: min(2, app.teamParallelismLimit))
                objective = ""
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// Every team run, grouped by what it needs next. Closed groups start folded.
struct ProjectList: View {
    @ObservedObject var app: AppModel
    @State private var unfolded: Set<ProjectState> = []
    private var groups: [(state: ProjectState, runs: [TeamRun])] {
        ProjectState.allCases.map { state in (state, app.teams.filter { $0.projectState == state }) }.filter { !$0.runs.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if app.teamsEnabled && !app.teamsFresh && app.connected { Text("Updates unavailable").font(.caption).foregroundStyle(Palette.attention) }
            else if !app.connected && !app.teams.isEmpty { Text("Offline · last received").font(.caption).foregroundStyle(Palette.attention) }
            if app.me == .null {
                // Without the server's identity the app cannot tell whether teams are on.
                note(app.connecting ? "Connecting to \(app.active?.label ?? "the server")…" : "Not connected. Reconnect to load projects.")
            } else if !app.teamsEnabled {
                note("Teams are off on this server. Enable them in the host configuration to start team projects.")
            } else if app.teams.isEmpty {
                note("No projects yet.")
            } else {
                ForEach(groups, id: \.state) { group in section(group.state, group.runs) }
            }
        }
    }

    @ViewBuilder private func section(_ state: ProjectState, _ runs: [TeamRun]) -> some View {
        let open = !state.closed || unfolded.contains(state)
        VStack(alignment: .leading, spacing: 2) {
            Button {
                guard state.closed else { return }
                withAnimation(.snappy(duration: 0.2)) { if open { unfolded.remove(state) } else { unfolded.insert(state) } }
            } label: {
                HStack(spacing: 6) {
                    Text(state.title)
                    Text("\(runs.count)").monospacedDigit()
                    if state.closed { Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)) }
                }
                .font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.bottom, 4).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(state.title), \(runs.count)\(state.closed ? open ? ", expanded" : ", collapsed" : "")")
            if open { ForEach(runs) { team in ProjectRow(app: app, team: team) } }
        }
    }
    private func note(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10)
    }
}

/// One run on one line: its status, name, state in words, and how long ago the host last changed it.
/// Decisions, the stop reason, plan progress, and the Linear issue are in the tooltip and the team page.
struct ProjectRow: View {
    @ObservedObject var app: AppModel
    let team: TeamRun
    @State private var hovering = false
    private var state: String {
        let open = team.openDecisions.count
        return open > 0 ? (open == 1 ? "1 decision" : "\(open) decisions") : team.statusLabel
    }
    private var stateColor: Color {
        switch team.projectState {
        case .pending: return team.status == "ready-for-review" ? Palette.review : Palette.attention
        case .stuck: return Palette.error
        default: return .secondary
        }
    }
    private var details: String {
        let (done, total) = team.progress
        var parts = [team.statusLabel, app.projectName(team.projectID), total > 0 ? "\(done)/\(total) tasks integrated" : "No plan yet"]
        if !team.reason.isEmpty { parts.append(team.reason) }
        if !team.linearIssue.isEmpty { parts.append(team.linearIssue) }
        return parts.joined(separator: " · ")
    }
    var body: some View {
        Button { app.selectedTeamID = team.id } label: {
            HStack(spacing: 10) {
                StatusGlyph(team: team)
                Text(team.title).lineLimit(1).foregroundStyle(team.projectState.closed ? .secondary : .primary)
                Spacer(minLength: 12)
                Text(state).font(.callout).foregroundStyle(stateColor).lineLimit(1)
                Text(shortAge(team.updatedAt)).font(.callout).foregroundStyle(.tertiary).monospacedDigit().frame(minWidth: 30, alignment: .trailing)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(hovering ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(details)
        .accessibilityLabel("\(team.title), \(details)")
        .accessibilityHint("Opens the team")
    }
}
