import SwiftUI
import InfiniteCore

/// Home: one text box that hands a mission to a project, above the board grouped by what each row needs next.
struct HomeView: View {
    @ObservedObject var app: AppModel
    private var filter: ProjectGroup? { app.projectFilter.flatMap(app.projectGroups.group) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                if let filter { ProjectHeader(app: app, group: filter) }
                if app.isOwner && !app.projectGroups.groups.isEmpty { MissionStartBox(app: app) }
                BoardList(app: app, filter: filter)
            }
            .frame(maxWidth: 720).padding(.horizontal, 32).padding(.top, 72).padding(.bottom, 40)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.background)
    }
}

/// The selected project's name and repositories, with the way back to every project.
struct ProjectHeader: View {
    @ObservedObject var app: AppModel
    let group: ProjectGroup
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(group.name).font(.title2.weight(.semibold))
                Text(group.repos.map(\.name).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button("All projects") { app.showHome() }.buttonStyle(.link).font(.callout)
        }
        .padding(.horizontal, 6).padding(.bottom, -18)
    }
}

/// A mission starts from a sentence in the chosen project. The main coordinator splits it into
/// subtasks; nothing starts in a repository directly from here.
struct MissionStartBox: View {
    @ObservedObject var app: AppModel
    @State private var objective = ""
    @State private var group = ""
    @State private var busy = false
    @State private var error = ""
    @State private var confirmClear = false
    private var pending: Bool { app.pendingMissionCreation.pendingID != nil }
    private var ready: Bool { app.connected && app.isOwner && !busy && !group.isEmpty }
    private var canStart: Bool { ready && (pending || !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
    /// The first line of the request waiting for confirmation, read back from its saved body.
    private var pendingSummary: String {
        guard let text = app.pendingMissionCreation.pendingText, let value = try? JSON.parse(Data(text.utf8)) else { return "" }
        let request = value["objective"].string
        return String((request.split(whereSeparator: \.isNewline).first.map(String.init) ?? request).prefix(80))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 0) {
                PromptEditor(text: $objective, placeholder: pending ? "A mission request is waiting for confirmation" : "Describe what this project needs…",
                             enabled: canStart, transparent: true, submit: start)
                    .frame(height: 76)
                HStack(spacing: 12) {
                    projectMenu.disabled(pending || busy)
                    Spacer()
                    Button(action: start) {
                        Image(systemName: busy ? "ellipsis" : "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 18, height: 18)
                    }
                    .glassButton(prominent: true).buttonBorderShape(.circle).controlSize(.regular)
                    .disabled(!canStart).help(pending ? "Retry the same request" : "Start the mission")
                    .accessibilityLabel(pending ? "Retry the same mission request" : "Start mission")
                }
                .padding(.horizontal, 12).padding(.bottom, 10)
            }
            .glassSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            notes.padding(.horizontal, 6)
        }
        .onAppear(perform: reset)
        .onChange(of: app.projectGroups) { _, _ in reset() }
        .onChange(of: app.projectFilter) { _, filter in if let filter, !pending { group = filter } }
        .alert("Clear the pending mission request?", isPresented: $confirmClear) {
            Button("Keep pending", role: .cancel) {}
            Button("I checked the board") { app.clearMissionCreation() }
        } message: { Text("The server may already have started this mission. Clearing does not stop it.") }
    }

    private var pendingGroup: String {
        guard let text = app.pendingMissionCreation.pendingText, let value = try? JSON.parse(Data(text.utf8)) else { return "" }
        return value["groupId"].string
    }
    private func label(_ item: ProjectGroup) -> String { item.name + (item.repoCountLabel.map { " · " + $0 } ?? "") }
    private var projectMenu: some View {
        Menu {
            ForEach(app.projectGroups.groups) { item in
                Button { group = item.id } label: { Text(label(item)) }
            }
        } label: { Label(app.projectGroups.group(group).map(label) ?? "Project", systemImage: "folder") }
            .menuStyle(.borderlessButton).font(.callout).tint(.secondary).fixedSize()
            .accessibilityLabel("Project")
    }
    @ViewBuilder private var notes: some View {
        if pending {
            HStack(spacing: 10) {
                Image(systemName: "clock.badge.questionmark").foregroundStyle(.orange)
                Text("“\(pendingSummary)” was sent but not confirmed. Check the board before starting another.").lineLimit(2)
                Spacer()
                Button("Clear…") { confirmClear = true }.disabled(busy)
            }.font(.caption)
        }
        if !error.isEmpty { Text(error).font(.caption).foregroundStyle(Palette.error).textSelection(.enabled) }
    }

    private func reset() {
        // A pending request keeps the project it was sent to, so a retry is the identical request.
        if pending, !pendingGroup.isEmpty { group = pendingGroup; return }
        if let filter = app.projectFilter, app.projectGroups.group(filter) != nil { group = filter; return }
        if group.isEmpty || app.projectGroups.group(group) == nil { group = app.projectGroups.groups.first?.id ?? "" }
    }
    private func start() {
        guard canStart else { return }
        busy = true; error = ""
        Task {
            do {
                try await app.createMission(groupID: group, objective: objective)
                objective = ""
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// The board: Needs input, Working, Ready for review, then a folded Ended section.
struct BoardList: View {
    @ObservedObject var app: AppModel
    let filter: ProjectGroup?
    @State private var showEnded = false

    var body: some View {
        let columns = app.board.columns(in: filter)
        VStack(alignment: .leading, spacing: 26) {
            if !app.boardError.isEmpty { Text(app.boardError).font(.caption).foregroundStyle(Palette.attention).padding(.horizontal, 10) }
            else if app.connected && !app.boardFresh && app.me != .null { Text("Loading the board…").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10) }
            else if !app.connected && !app.board.items.isEmpty { Text("Offline · last received").font(.caption).foregroundStyle(Palette.attention).padding(.horizontal, 10) }
            if app.me == .null {
                note(app.connecting ? "Connecting to \(app.active?.label ?? "the server")…" : "Not connected. Reconnect to load projects.")
            } else if app.boardFresh && columns.isEmpty {
                note(filter == nil ? "Nothing on the board yet. Describe a task above to start a mission." : "Nothing in \(filter!.name) yet.")
            } else {
                ForEach(columns, id: \.column) { entry in section(entry.column, entry.items) }
            }
        }
    }

    @ViewBuilder private func section(_ column: BoardColumn, _ items: [BoardItem]) -> some View {
        let folds = column == .ended
        let open = !folds || showEnded
        VStack(alignment: .leading, spacing: 2) {
            Button {
                guard folds else { return }
                withAnimation(.snappy(duration: 0.2)) { showEnded.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(column.title)
                        Text("\(items.count)").monospacedDigit()
                        if folds { Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)) }
                    }
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    if !folds { Text(column.subtitle).font(.caption).foregroundStyle(.tertiary) }
                }
                .padding(.horizontal, 10).padding(.bottom, 4).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(column.title), \(items.count)\(folds ? open ? ", expanded" : ", collapsed" : "")")
            if open { ForEach(items) { item in BoardRow(app: app, item: item) } }
        }
    }
    private func note(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10)
    }
}

/// One mission, team run, or goal on one row: status, title, where it runs and what it is doing,
/// its state in words, and how long ago it last changed.
struct BoardRow: View {
    @ObservedObject var app: AppModel
    let item: BoardItem
    @State private var hovering = false
    private var team: TeamRun? { item.kind == .team ? app.teams.first { $0.id == item.id } : nil }
    private var stateColor: Color {
        switch item.column {
        case .needsInput: return item.status == "blocked" ? Palette.error : Palette.attention
        case .review: return Palette.review
        default: return .secondary
        }
    }
    private var caption: String {
        [item.kind == .team ? "Team run" : item.kind == .goal ? "Goal" : nil, item.projectName, item.subtaskLabel, item.detail.isEmpty ? nil : item.detail]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private var opens: Bool { item.kind == .mission || item.kind == .team }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            rowLine
            if let failure = app.teamResumeFailures[item.id] {
                Text(failure.message).font(.caption).foregroundStyle(Palette.error).lineLimit(2).padding(.leading, 24)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(hovering && opens ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onHover { hovering = $0 }
        .help(opens ? [item.statusLabel, caption].joined(separator: " · ") : "Goals open from the CLI or the phone app.")
    }
    private var rowLine: some View {
        HStack(spacing: 10) {
            Button(action: open) {
                HStack(spacing: 10) {
                    if let team { StatusGlyph(team: team) } else { StatusGlyph(item: item) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).lineLimit(1).foregroundStyle(item.column == .ended ? .secondary : .primary)
                        Text(caption).font(.caption).foregroundStyle(item.column == .needsInput && item.status == "blocked" ? Palette.error : .secondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    Spacer(minLength: 12)
                    Text(item.statusLabel).font(.callout).foregroundStyle(stateColor).lineLimit(1)
                    Text(shortAge(item.updatedAt)).font(.callout).foregroundStyle(.tertiary).monospacedDigit().frame(minWidth: 30, alignment: .trailing)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // A goal has no Mac page; its row stays legible but takes no clicks.
            .allowsHitTesting(opens)
            .accessibilityLabel("\(item.title), \(item.statusLabel), \(caption)")
            .accessibilityHint(item.kind == .mission ? "Opens the mission" : item.kind == .team ? "Opens the team" : "")
            if let team, team.offersResume && app.isOwner {
                let resuming = app.resumingTeams.contains(team.id)
                Button(resuming ? "Resuming…" : "Resume") { Task { await app.resumeTeam(team.id) } }
                    .glassButton().controlSize(.small).disabled(!app.teamsFresh || resuming)
                    .help("Resume this blocked team")
            }
        }
    }
    private func open() {
        switch item.kind {
        case .mission: app.selectedMissionID = item.id
        case .team: app.openTeam(item.id)
        default: break
        }
    }
}
