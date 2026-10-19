import SwiftUI
import AppKit
import Security
import InfiniteCore

@main struct InfiniteDesktopApp: App {
    @StateObject private var model = AppModel()
    @NSApplicationDelegateAdaptor(DesktopDelegate.self) private var delegate
    init() {
        // A locked Keychain or changed signing identity must produce a usable
        // connection error instead of blocking the UI in a background prompt.
        SecKeychainSetUserInteractionAllowed(false)
    }
    var body: some Scene {
        Window("Infinite", id: "main") {
            DesktopView(app: model)
                .frame(minWidth: 880, minHeight: 560)
                .onAppear { delegate.model = model; model.start() }
        }
        .defaultSize(width: 1240, height: 820)
        .commands { WorkspaceCommands(app: model) }
        Window("Resources", id: "resources") { ResourceView(app: model).frame(minWidth: 640, minHeight: 480) }
            .defaultSize(width: 840, height: 640)
        Window("Files & Sync", id: "files") { FilesView(app: model).frame(minWidth: 780, minHeight: 540) }
            .defaultSize(width: 1040, height: 720)
        Window("cmux Workspaces", id: "cmux") { CmuxWorkspaceView(model: model.cmux).frame(minWidth: 780, minHeight: 540) }
            .defaultSize(width: 1120, height: 760)
        Settings { ConnectionsView(app: model).frame(width: 600) }
    }
}

/// Everything beyond the session list lives in the menu bar and separate windows.
struct WorkspaceCommands: Commands {
    @ObservedObject var app: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Session") { app.showingCreate = true }.keyboardShortcut("n").disabled(!app.connected || !app.isOwner)
            Button("New Single-Repo Team…") { app.showingCreateTeam = true }.keyboardShortcut("n", modifiers: [.command, .shift]).disabled(!app.connected || !app.isOwner || !app.teamsEnabled)
        }
        CommandMenu("Server") {
            Button("Home") { app.showHome() }.keyboardShortcut("1").disabled(app.active == nil)
            Button("Refresh") { Task { if app.connected { await app.refresh() } else { await app.connect() } } }.keyboardShortcut("r")
            Divider()
            Button("Resources") { openWindow(id: "resources") }.keyboardShortcut("2")
            Button("Files & Sync") { openWindow(id: "files") }.keyboardShortcut("3")
            Button("cmux Workspaces") { openWindow(id: "cmux") }.keyboardShortcut("4")
            Divider()
            Button("Connect a Server…") { app.showingPair = true }
        }
    }
}

@MainActor final class DesktopDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSApp.activate(ignoringOtherApps: true)
        showMainWindow()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }; return true
    }
    private func showMainWindow() {
        DispatchQueue.main.async {
            NSApp.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    private var quitting = false
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateLater }
        quitting = true
        Task { @MainActor in
            do {
                for terminal in model?.terminals.values ?? Dictionary<String, SessionModel>().values { await terminal.detach() }
                try await model?.cmux.disconnect()
                await model?.client?.close()
                sender.reply(toApplicationShouldTerminate: true)
            } catch {
                quitting = false
                let alert = NSAlert(); alert.messageText = "Connection identity could not be saved"
                alert.informativeText = error.localizedDescription; alert.addButton(withTitle: "Keep app open")
                alert.runModal(); sender.reply(toApplicationShouldTerminate: false)
            }
        }
        return .terminateLater
    }
}

struct DesktopView: View {
    @ObservedObject var app: AppModel
    @Environment(\.openWindow) private var openWindow
    @State private var search = ""
    @State private var endID: String?
    @State private var showEndedSessions = false
    private var searching: Bool { !search.isEmpty }
    private var filteredSessions: [AgentSession] {
        app.sessions.filter { search.isEmpty || [$0.title, $0.path, providerName($0.provider)].joined(separator: " ").localizedCaseInsensitiveContains(search) }
    }
    private var filteredGroups: [ProjectGroup] {
        app.projectGroups.groups.filter { search.isEmpty || ([$0.name] + $0.repos.map(\.name)).joined(separator: " ").localizedCaseInsensitiveContains(search) }
    }
    /// One list selects Home, a project, or a session; prefixes keep the three from colliding.
    /// While a mission or team is open nothing is selected, so any row leads back.
    private var selection: Binding<String?> {
        Binding(get: {
            if app.showingHome { return app.projectFilter.map { "project:" + $0 } ?? "home" }
            if app.selectedTeamID == nil && app.selectedMissionID == nil, let id = app.selectedID { return "session:" + id }
            return nil
        }, set: { value in
            guard let value else { return }
            let leavingSession = !app.showingHome && app.selectedTeamID == nil && app.selectedMissionID == nil
            if leavingSession, let current = app.selectedID, value != "session:" + current { app.terminals[current]?.markRead() }
            if value.hasPrefix("session:") { app.openSession(String(value.dropFirst(8))) }
            else { app.showHome(project: value.hasPrefix("project:") ? String(value.dropFirst(8)) : nil) }
        })
    }
    private var missionModel: MissionModel? { app.showingHome ? nil : app.selectedMissionID.flatMap(app.missionModel(for:)) }
    private var teamModel: TeamModel? { app.showingHome || missionModel != nil ? nil : app.selectedTeamID.flatMap(app.teamModel(for:)) }
    private var pageTitle: String {
        if app.showingHome { return app.projectFilter.flatMap(app.projectGroups.group)?.name ?? "Home" }
        if let missionModel { return missionModel.mission.title }
        if let teamModel { return teamModel.run.title }
        return app.sessions.first { $0.id == app.selectedID }?.title ?? "Infinite"
    }
    var body: some View {
        NavigationSplitView {
            sidebar.navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 380)
        } detail: {
            detail
        }
        .navigationTitle(pageTitle)
        .quietWindow()
        .tint(Palette.accent)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if app.connecting { ProgressView().controlSize(.small) }
                Menu {
                    Button("New mission") { app.showHome(project: app.projectFilter) }
                    if app.teamsEnabled { Button("New single-repo team…") { app.showingCreateTeam = true } }
                    Divider()
                    Button("New session…") { app.showingCreate = true }
                } label: { Label("New", systemImage: "plus") }
                    .disabled(!app.connected || !app.isOwner).help("Start a mission, a team, or a session")
                Menu {
                    Button("Resources") { openWindow(id: "resources") }
                    Button("Files & Sync") { openWindow(id: "files") }
                    Button("cmux Workspaces") { openWindow(id: "cmux") }
                } label: { Label("More", systemImage: "ellipsis") }.help("Server tools")
            }
        }
        .sheet(isPresented: $app.showingPair) { PairView(app: app) }
        .sheet(isPresented: $app.showingCreate) { CreateView(app: app) }
        .sheet(isPresented: $app.showingCreateTeam) { TeamCreateView(app: app) }
        .alert("End this session?", isPresented: Binding(get: { endID != nil }, set: { if !$0 { endID = nil } })) {
            Button("Cancel", role: .cancel) { endID = nil }
            Button("End session", role: .destructive) { if let id = endID { Task { await app.end(id) } }; endID = nil }
        } message: { Text("This stops the agent process on the server. Its recording stays available.") }
    }

    /// Home, every project, then sessions: the person's own, plus any team member stopped on a
    /// provider permission prompt, so no prompt is only reachable through its team's page.
    private var sidebar: some View {
        let groups = filteredGroups
        let waiting = app.board.count(.needsInput)
        let sessions = filteredSessions.filter { $0.value["team"] == .null || $0.needsYou || searching }
        let live = sessions.filter(\.running)
        let ended = sessions.filter { !$0.running }
        return List(selection: selection) {
            if app.active != nil && !searching {
                Label("Home", systemImage: "square.grid.2x2").tag("home").badge(waiting)
            }
            if !groups.isEmpty {
                Section("Projects") { ForEach(groups) { group in ProjectSidebarRow(group: group, waiting: app.board.count(.needsInput, in: group)).tag("project:" + group.id) } }
            }
            if !live.isEmpty { Section("Sessions") { rows(live) } }
            if !ended.isEmpty {
                if searching { Section("Ended sessions") { rows(ended) } }
                else { Section(isExpanded: $showEndedSessions) { rows(ended) } header: { Text("Ended sessions") } }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Palette.sidebar)
        .searchable(text: $search, placement: .sidebar, prompt: "Find a project or session")
        .overlay {
            if searching && groups.isEmpty && sessions.isEmpty {
                Text("No matches").foregroundStyle(.secondary).font(.callout)
            } else if app.active == nil {
                Text("No server connected").foregroundStyle(.secondary).font(.callout)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }
    /// The connected server, its state in words, and the way to switch or add one.
    private var footer: some View {
        HStack(spacing: 10) {
            Circle().fill(app.connected ? Palette.connected : app.connecting ? Palette.attention : Color.secondary).frame(width: 7, height: 7)
            Menu {
                ForEach(app.profiles) { profile in
                    Button { app.activeID = profile.id; Task { await app.connect() } } label: {
                        if profile.id == app.activeID { Label(profile.label, systemImage: "checkmark") } else { Text(profile.label) }
                    }
                }
                if !app.profiles.isEmpty { Divider() }
                Button("Connect a Server…") { app.showingPair = true }
                Button(app.connected ? "Refresh" : "Reconnect") { Task { if app.connected { await app.refresh() } else { await app.connect() } } }.disabled(app.active == nil)
            } label: { Text(app.active?.label ?? "No server").font(.callout.weight(.medium)).lineLimit(1).truncationMode(.tail) }
            .menuStyle(.borderlessButton).tint(.primary)
            // The connection state always shows in full; a long server name truncates instead.
            Text(app.connected ? "Connected" : app.connecting ? "Connecting…" : app.active == nil ? "Not paired" : "Offline")
                .font(.caption).foregroundStyle(app.connected || app.connecting ? Color.secondary : .orange).lineLimit(1)
                .fixedSize().layoutPriority(1)
            Spacer(minLength: 4)
            SettingsLink { Image(systemName: "gearshape") }.buttonStyle(.borderless).help("Connections")
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .glassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(10)
    }
    /// A session row says "Needs you" while its agent waits on a provider prompt; that is never answered for it.
    private func rows(_ sessions: [AgentSession]) -> some View {
        ForEach(sessions) { row in
            HStack(spacing: 9) {
                StatusGlyph(session: row, size: 12)
                Text(row.title).lineLimit(1).foregroundStyle(row.running ? .primary : .secondary)
                Spacer(minLength: 4)
                if row.needsYou {
                    Text("Needs you").font(.caption.weight(.medium)).foregroundStyle(Palette.attention)
                        .padding(.horizontal, 6).padding(.vertical, 1).background(Palette.attention.opacity(0.15), in: Capsule())
                } else if row.value["team"] != .null {
                    Image(systemName: "person.3").font(.caption2).foregroundStyle(.secondary)
                        .help("\(TeamRun.roleName(row.value["team"]["role"].string)) in team \(app.teams.first { $0.id == row.value["team"]["runId"].string }?.title ?? "run")")
                }
            }
            .padding(.vertical, 1)
            .help("\(providerName(row.provider)) · \(row.displayState)\(row.running && !row.now.isEmpty ? " · " + row.now : "")")
            .accessibilityLabel("\(row.title), \(providerName(row.provider)), \(row.displayState)")
            .tag("session:" + row.id)
            .contextMenu {
                Button("Open beside current") { app.openSession(app.selectedID ?? row.id); app.secondaryID = row.id }.disabled(app.selectedID == row.id || app.selectedID == nil)
                if app.isOwner && row.running { Button("End session…", role: .destructive) { endID = row.id } }
            }
        }
    }

    @ViewBuilder private var detail: some View {
        VStack(spacing: 0) {
            if !app.message.isEmpty {
                HStack {
                    Image(systemName: "wifi.exclamationmark")
                    Text(app.message).lineLimit(2); Spacer()
                    Button("Reconnect") { Task { await app.connect() } }.disabled(app.connecting)
                }.font(.caption).padding(10).background(Color.orange.opacity(0.12))
            }
            // Session panes stay mounted underneath Home, missions, and team dashboards, so switching back is instant.
            let covered = app.active == nil || app.showingHome || missionModel != nil || teamModel != nil
            ZStack {
                Group {
                    if app.mounted.isEmpty {
                        if app.connecting && app.sessions.isEmpty {
                            ProgressView("Connecting to \(app.active?.label ?? "server")…").frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            ContentUnavailableView {
                                Label(app.sessions.isEmpty ? "No sessions yet" : "Choose a session", systemImage: "terminal")
                            } description: {
                                Text(app.sessions.isEmpty ? "Start Claude Code or Codex in one of your projects, or hand a project a mission from Home." : "Pick a session from the sidebar.")
                            } actions: {
                                Button("New session") { app.showingCreate = true }.disabled(!app.connected || !app.isOwner)
                            }
                        }
                    } else { panes }
                }.opacity(covered ? 0 : 1).allowsHitTesting(!covered).accessibilityHidden(covered)
                if app.active == nil { welcome }
                else if app.showingHome { HomeView(app: app) }
                else if let missionModel { MissionDetailView(app: app, model: missionModel).id(missionModel.id) }
                else if let teamModel { TeamDetailView(app: app, model: teamModel).id(teamModel.id) }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.background)
    }
    private var welcome: some View {
        VStack(spacing: 14) {
            Image(systemName: "infinity").font(.system(size: 44, weight: .light)).foregroundStyle(.tint)
            Text("Connect your server").font(.title2.weight(.semibold))
            Text("Your agents run on the server and keep running when this app is closed.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
            Button("Connect server…") { app.showingPair = true }.buttonStyle(.borderedProminent).controlSize(.large)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(40)
    }
    /// Recent terminals stay mounted off-screen, so switching back is instant and keeps their scrollback.
    private var panes: some View {
        GeometryReader { area in
            let visible = app.visibleIDs
            let width = max(1, (area.size.width - CGFloat(visible.count - 1)) / CGFloat(max(1, visible.count)))
            ZStack(alignment: .topLeading) {
                ForEach(app.mounted, id: \.self) { id in
                    if let model = app.model(for: id) {
                        let slot = visible.firstIndex(of: id)
                        SessionPane(model: model, closeView: visible.count > 1 && id == app.secondaryID ? { app.secondaryID = nil } : nil)
                            .frame(width: slot == nil ? area.size.width : width, height: area.size.height)
                            .offset(x: slot.map { CGFloat($0) * (width + 1) } ?? 0)
                            .opacity(slot == nil ? 0 : 1)
                            .allowsHitTesting(slot != nil)
                            .accessibilityHidden(slot == nil)
                            .onChange(of: slot == nil) { _, hidden in if hidden { model.markRead(); Task { await model.release() } } }
                            .onDisappear { Task { await model.detach() } }
                    }
                }
                if visible.count > 1 { Rectangle().fill(.separator).frame(width: 1, height: area.size.height).offset(x: width) }
            }
        }
    }
}

/// A sidebar project: its name, a repository count when it spans several, and how many rows wait on the owner.
struct ProjectSidebarRow: View {
    let group: ProjectGroup
    let waiting: Int
    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: group.repos.count > 1 ? "square.stack.3d.up" : "folder").font(.system(size: 12)).foregroundStyle(.secondary).frame(width: 14)
            Text(group.name).lineLimit(1)
            Spacer(minLength: 4)
            if let count = group.repoCountLabel { Text(count).font(.caption).foregroundStyle(.tertiary).fixedSize() }
            if waiting > 0 { Circle().fill(Palette.attention).frame(width: 6, height: 6).accessibilityHidden(true) }
        }
        .padding(.vertical, 1)
        .help(([group.name] + group.repos.map(\.name)).joined(separator: " · ") + (waiting > 0 ? " · \(waiting) waiting on you" : ""))
        .accessibilityLabel("\(group.name)\(group.repoCountLabel.map { ", " + $0 } ?? "")\(waiting > 0 ? ", \(waiting) need input" : "")")
    }
}

func providerName(_ name: String) -> String { ["claude": "Claude Code", "codex": "Codex", "grok": "Grok", "opencode": "OpenCode", "demo": "Rehearsal"][name] ?? name }
func statusColor(_ session: AgentSession) -> Color {
    session.needsYou ? .orange : session.running ? .green : session.recordingError ? .red : .secondary
}

struct SessionPane: View {
    @ObservedObject var model: SessionModel
    var closeView: (() -> Void)?
    @State private var confirmEnd = false
    @State private var confirmClear = false
    private var session: AgentSession { model.session }
    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ZStack {
                // The terminal is created the first time the screen is shown and kept afterwards,
                // so returning to it is immediate; chat needs no renderer at all.
                if model.screenShown {
                    GeometryReader { area in
                        let generation = model.rendererGeneration
                        TerminalSurface(pipe: model.pipe, acceptsInput: model.directInput && model.canUseTerminal, followsViewport: model.hasControl, onInput: model.raw, onResize: { cols, rows in Task { await model.resize(cols, rows) } }, onFailure: { message in
                            if generation == model.rendererGeneration { model.rendererFailed(message) }
                        }, onReady: { model.rendererRestored(generation) })
                            .id(generation).frame(width: area.size.width, height: area.size.height)
                    }.opacity(model.view == .screen ? 1 : 0).allowsHitTesting(model.view == .screen)
                }
                if model.view == .chat { ChatView(model: model) }
            }.frame(minHeight: 100, maxHeight: .infinity).layoutPriority(-1).clipped()
            Divider()
            VStack(spacing: 10) {
                if let prompt = model.prompt, model.session.needsYou { PromptCard(model: model, prompt: prompt).id(prompt["id"].int) }
                composer
            }.padding(12).fixedSize(horizontal: false, vertical: true).layoutPriority(1)
        }.background(Palette.background)
        .task { await model.attach() }
        .alert("End this session?", isPresented: $confirmEnd) {
            Button("Cancel", role: .cancel) {}
            Button("End session", role: .destructive) { Task { await model.end() } }
        } message: { Text("This stops the agent process on the server. Its recording stays available.") }
        .alert("Have you checked the terminal?", isPresented: $confirmClear) {
            Button("Keep pending send", role: .cancel) {}
            Button("Clear after review") { model.clearPending() }
        } message: { Text("The previous prompt may already have been delivered. Clearing it does not cancel server work.") }
    }
    private var header: some View {
        HStack(spacing: 10) {
            StatusGlyph(session: session, size: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                HStack(spacing: 8) {
                    Text("\(providerName(session.provider)) · \(session.displayState)").font(.caption).foregroundStyle(.secondary).lineLimit(1).fixedSize()
                    Text(session.path.isEmpty ? session.project : session.path).font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
            Picker("View", selection: Binding(get: { model.view }, set: { if $0 == .screen { model.showScreen() } else { model.view = .chat } })) {
                Text("Chat").tag(SessionViewMode.chat); Text("Screen").tag(SessionViewMode.screen)
            }.pickerStyle(.segmented).labelsHidden().fixedSize()
            if !session.running && session.value["resumable"].bool == true {
                Button("Resume") { Task { await model.resume() } }.disabled(model.role != "owner")
            } else {
                Menu {
                    Button("Reconnect terminal") { Task { await model.detach(); await model.attach() } }
                    if model.role == "owner" { Button("End session…", role: .destructive) { confirmEnd = true } }
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize().help("Session actions")
            }
            if let closeView { Button(action: closeView) { Image(systemName: "xmark") }.buttonStyle(.plain).help("Close this view; the agent keeps running") }
        }
    }
    /// Text would land in the open dialog; the screen view, where the dialog is visible, still allows it.
    private var promptBlocks: Bool { model.prompt != nil && session.needsYou && model.view == .chat }
    private var footer: (text: String, color: Color) {
        if model.draft.pendingID != nil { return (model.notice.isEmpty ? "Delivery unconfirmed. Check the terminal before retrying." : model.notice, .orange) }
        if !model.notice.isEmpty { return (model.notice, .secondary) }
        if model.role == "viewer" { return ("View only", .secondary) }
        if !session.running { return ("This session is \(session.displayState.lowercased()).", .secondary) }
        if model.prompt != nil && session.needsYou && model.view == .chat { return ("Answer the dialog above first.", .secondary) }
        if model.busy && !model.attached { return ("Connecting to the terminal…", .secondary) }
        if let other = model.otherHolder { return ("\(other) has control · sending takes over", .secondary) }
        if model.directInput { return ("Keys go straight to the terminal", .secondary) }
        return ("Enter to send · Shift-Enter for a new line", .secondary)
    }
    private var composer: some View {
        VStack(spacing: 8) {
            PromptEditor(text: Binding(get: { model.draft.text }, set: model.setDraft), placeholder: "Message \(providerName(session.provider))…",
                         enabled: model.canSend && model.role != "viewer" && !promptBlocks, transparent: true, submit: { Task { await model.send() } })
                .frame(height: 76).glassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            HStack(spacing: 12) {
                Text(footer.text).font(.system(size: 11)).foregroundStyle(footer.color).lineLimit(2).help(footer.text).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if model.role == "owner" {
                    Toggle("Type in terminal", isOn: Binding(get: { model.directInput }, set: model.setDirectInput))
                        .toggleStyle(.switch).controlSize(.mini).font(.caption).disabled(!model.screenReady || model.view != .screen)
                }
                if model.draft.pendingID != nil {
                    Button("Retry same send") { Task { await model.send(retry: true) } }.disabled(!model.ready || model.busy)
                    Button("Clear…") { confirmClear = true }
                } else {
                    Button { Task { await model.send() } } label: { Label(model.busy ? "Sending…" : "Send", systemImage: "arrow.up") }
                        .buttonStyle(.borderedProminent).disabled(!model.canSend || model.role == "viewer" || promptBlocks)
                }
            }
        }
    }
}

struct PairView: View {
    @ObservedObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var origin = ""
    @State private var token = ""
    @State private var relay = ""
    @State private var busy = false
    @State private var error = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Connect your server", systemImage: "lock.shield").font(.title2.weight(.semibold))
            Text("Use this Mac’s paired device key. It is saved in Keychain and never passed to the terminal renderer.").foregroundStyle(.secondary)
            Form {
                TextField("Name", text: $label, prompt: Text("Server"))
                TextField("HTTPS address", text: $origin, prompt: Text("https://host.example.com"))
                SecureField("Device key", text: $token)
                TextField("Relay machine ID", text: $relay, prompt: Text("Leave empty for a direct connection"))
            }.textFieldStyle(.roundedBorder)
            Text("The host must have encrypted remote access enabled. There is no unencrypted fallback.").font(.caption).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.callout).textSelection(.enabled) }
            HStack {
                Button("Import CLI connection…") { importConnection() }.disabled(busy)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "Connecting…" : "Connect") {
                    busy = true; error = ""
                    Task {
                        do { try await app.pair(label: label, origin: origin, token: token, relay: relay); token = ""; dismiss() }
                        catch { self.error = error.localizedDescription }; busy = false
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(busy || origin.isEmpty || token.isEmpty)
            }
        }.padding(26).frame(width: 510)
    }
    private func importConnection() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.message = "Choose the Infinite CLI connection file. Its key will be stored in Keychain after the server authenticates."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let value = try JSON.parse(Data(contentsOf: url))
            guard !value["origin"].string.isEmpty, !value["token"].string.isEmpty else { throw DesktopError("This file does not contain an Infinite origin and token.") }
            origin = value["origin"].string; token = value["token"].string
        } catch { self.error = error.localizedDescription }
    }
}

struct CreateView: View {
    @ObservedObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var provider = "claude"
    @State private var project = ""
    @State private var title = ""
    @State private var busy = false
    @State private var error = ""
    @State private var clearPending = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("New session").font(.title2.weight(.semibold))
            Form {
                Picker("Agent", selection: $provider) { ForEach(app.me["providers"].array.map(\.string), id: \.self) { Text(providerName($0)).tag($0) } }
                Picker("Project", selection: $project) { ForEach(Array(app.projects.enumerated()), id: \.offset) { _, item in Text(item["name"].string).tag(item["id"].string) } }
                TextField("Name", text: $title, prompt: Text("Optional"))
            }.disabled(app.pendingCreation.pendingID != nil)
            if app.pendingCreation.pendingID != nil {
                Text("A creation request is pending. Retry uses its original agent, project, and request identity. Check the session list before starting a different request.").font(.callout).foregroundStyle(.orange)
                Button("Clear after checking sessions…") { clearPending = true }.disabled(busy)
            }
            if let selected = app.projects.first(where: { $0["id"].string == project }) {
                Text(selected["path"].string).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack { Spacer(); Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy); Button(busy ? "Starting…" : app.pendingCreation.pendingID == nil ? "Start" : "Retry same creation") {
                busy = true
                Task { do { try await app.create(provider: provider, project: project, title: title); dismiss() } catch { self.error = error.localizedDescription }; busy = false }
            }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(busy || project.isEmpty) }
        }.padding(26).frame(width: 480)
            .alert("Clear the pending creation?", isPresented: $clearPending) {
                Button("Keep pending", role: .cancel) {}
                Button("I checked the sessions") { app.clearCreation() }
            } message: { Text("The server may already have created this agent. Clearing does not stop it.") }
            .onAppear { project = app.projects.first?["id"].string ?? ""; if !app.me["providers"].array.map(\.string).contains(provider) { provider = app.me["providers"].array.first?.string ?? "" } }
    }
}

struct ConnectionsView: View {
    @ObservedObject var app: AppModel
    @State private var confirmForget = false
    @State private var showingPair = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Connections").font(.title.weight(.medium))
            Text("Your Mac connects directly to each trusted server. Closing the app does not stop its agents.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if app.profiles.isEmpty { Text("No server connected yet.").foregroundStyle(.secondary) }
            ForEach(app.profiles) { profile in
                HStack {
                    Image(systemName: "server.rack").font(.title2).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(profile.label).font(.headline)
                        Text(profile.origin).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(profile.relayMachineID == nil ? "Direct · end-to-end encrypted" : "Relay · end-to-end encrypted").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if profile.id == app.activeID { Text(app.connected ? "Connected" : app.connecting ? "Connecting…" : "Disconnected").font(.caption).foregroundStyle(.secondary) }
                    else { Button("Connect") { app.activeID = profile.id; Task { await app.connect() } } }
                }.padding(.vertical, 10)
                Divider()
            }
            HStack {
                Button("Add server…") { showingPair = true }.buttonStyle(.borderedProminent)
                Button("Forget selected server…", role: .destructive) { confirmForget = true }.disabled(app.active == nil)
            }
            Text("Forgetting removes this Mac app's saved key. Revoke a lost device on the server to invalidate its access. The current Infinite transport has no forward secrecy; cmux connections use the qualified upstream Noise transport.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(26).frame(maxWidth: .infinity, alignment: .leading)
            .sheet(isPresented: $showingPair) { PairView(app: app) }
            .alert("Forget this connection?", isPresented: $confirmForget) { Button("Cancel", role: .cancel) {}; Button("Forget", role: .destructive) { Task { await app.forget() } } } message: { Text("Server sessions remain running. You will need a device key to connect again.") }
    }
}

struct ResourceView: View {
    @ObservedObject var app: AppModel
    private var resources: JSON { app.resources }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack { Text("Server resources").font(.title.weight(.medium)); Spacer(); Text(app.connected ? "Live observations" : "Stale · reconnecting").font(.caption).foregroundStyle(app.connected ? Color.secondary : .orange) }
                Text("Measurements belong to the execution server. Unavailable readings are never shown as zero.").foregroundStyle(.secondary)
                if !resources["unavailable"].string.isEmpty { Text(resources["unavailable"].string).foregroundStyle(.orange) }
                Grid(alignment: .leading, horizontalSpacing: 40, verticalSpacing: 16) {
                    GridRow { metric("CPU", percent(resources["cpu"]["usagePercent"])); metric(resources["memory"]["availableKind"].string == "free" ? "Memory free" : "Memory available", bytes(resources["memory"]["availableBytes"])); metric("Memory total", bytes(resources["memory"]["totalBytes"])) }
                    GridRow { metric("Swap used", bytes(resources["swap"]["usedBytes"])); metric("Network received", rate(resources["network"]["receiveBytesPerSecond"])); metric("Network sent", rate(resources["network"]["sendBytesPerSecond"])) }
                }.padding(.vertical, 14)
                Divider()
                Text("Storage").font(.title3.weight(.semibold))
                ForEach(Array(resources["disks"].array.enumerated()), id: \.offset) { _, disk in
                    HStack { Text(disk["projectId"].string); Spacer(); Text("\(bytes(disk["availableBytes"])) available / \(bytes(disk["totalBytes"]))").monospacedDigit() }
                    if let available = disk["availableBytes"].number, let total = disk["totalBytes"].number, total > 0 { ProgressView(value: max(0, min(1, 1 - available / total))) }
                }
                Divider()
                Text("Agent processes").font(.title3.weight(.semibold))
                ForEach(Array(resources["sessions"].array.enumerated()), id: \.offset) { _, row in
                    HStack {
                        VStack(alignment: .leading) { Text(app.sessions.first { $0.id == row["sessionId"].string }?.title ?? String(row["sessionId"].string.prefix(8))); Text(row["scope"].string).font(.caption).foregroundStyle(.secondary) }
                        Spacer(); Text(percent(row["cpuPercent"])).frame(width: 80, alignment: .trailing); Text(bytes(row["rssBytes"])).frame(width: 100, alignment: .trailing)
                    }.padding(.vertical, 5)
                }
                Text("Sample: \(resources["capturedAt"].string.isEmpty ? "not available" : resources["capturedAt"].string)").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(resources["unavailable"].array.enumerated()), id: \.offset) { _, value in Text("\(value["field"].string): \(value["reason"].string)").font(.caption).foregroundStyle(.secondary) }
            }.padding(26).frame(maxWidth: 1000, alignment: .leading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Samples are only requested while this window is open.
        .onAppear { app.resourceWatchers += 1; Task { await app.refresh(includeResources: true) } }
        .onDisappear { app.resourceWatchers -= 1 }
    }
    private func metric(_ label: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 7) { Text(label).font(.caption).foregroundStyle(.secondary); Text(value).font(.system(size: 25, weight: .medium, design: .rounded)).monospacedDigit() }.frame(minWidth: 170, alignment: .leading) }
    private func percent(_ value: JSON) -> String { value.number.map { String(format: "%.1f%%", $0) } ?? "Unavailable" }
    private func bytes(_ value: JSON) -> String { value.number.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .memory) } ?? "Unavailable" }
    private func rate(_ value: JSON) -> String { value.number == nil ? "Unavailable" : bytes(value) + "/s" }
}
