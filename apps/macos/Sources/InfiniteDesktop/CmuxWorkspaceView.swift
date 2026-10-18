import SwiftUI
import InfiniteCore

struct CmuxWorkspaceView: View {
    @ObservedObject var model: CmuxViewModel
    @State private var showingConnection = false
    @State private var showingCreate = false
    @State private var terminateID: String?
    @State private var invitation = ""
    @State private var search = ""
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "rectangle.split.2x2").foregroundStyle(.tint)
                Text("cmux").font(.title3.weight(.semibold))
                if !model.profiles.isEmpty {
                    Picker("Server", selection: $model.activeID) {
                        ForEach(model.profiles) { Text($0.label).tag($0.id) }
                    }.labelsHidden().frame(maxWidth: 220).disabled(model.connected || model.connecting || model.disconnecting || model.busy || model.selectedID != nil)
                }
                Spacer()
                Label(model.connectionStatus, systemImage: model.connected ? "lock.shield" : "network").font(.caption).foregroundStyle(.secondary)
                Button { showingConnection = true } label: { Image(systemName: "plus") }.help("Add a cmux server").disabled(model.connecting || model.disconnecting || model.busy)
                if model.connected {
                    Button("Disconnect") { Task { do { try await model.disconnect() } catch { model.notice = error.localizedDescription } } }
                } else if model.active != nil {
                    Button(model.connecting ? "Connecting…" : model.disconnecting ? "Disconnecting…" : "Connect") { Task { await model.connect(invitation: invitation); invitation = "" } }.disabled(model.connecting || model.disconnecting || model.busy)
                }
            }.padding(14)
            Divider()
            if !model.notice.isEmpty {
                HStack(alignment: .top) {
                    Image(systemName: "info.circle")
                    Text(model.notice).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.font(.caption).padding(10).background(Color.accentColor.opacity(0.06))
            }
            if !model.connected && !model.connecting {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Your server’s real terminals").font(.title2.weight(.medium))
                    Text("Open Claude Code, Codex, or a shell inside a persistent cmux workspace. Server processes keep running after you disconnect.").foregroundStyle(.secondary).frame(maxWidth: 470)
                    if model.active != nil {
                        SecureField("Invitation, only for first enrollment", text: $invitation).textFieldStyle(.roundedBorder).frame(maxWidth: 440)
                        Button("Connect to \(model.active?.label ?? "server")") { Task { await model.connect(invitation: invitation); invitation = "" } }.buttonStyle(.borderedProminent).disabled(model.disconnecting || model.busy)
                    } else { Button("Add cmux server") { showingConnection = true }.buttonStyle(.borderedProminent) }
                    Text("Normal device enrollment and server approval are required. The server is a trusted encryption endpoint.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: 470)
                }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(30)
            } else {
                HStack(spacing: 1) {
                    catalog.frame(width: 220)
                    terminal.frame(minWidth: 350)
                }
            }
        }
        .sheet(isPresented: $showingConnection) { CmuxConnectSheet(model: model, isPresented: $showingConnection) }
        .sheet(isPresented: $showingCreate) { CmuxCreateSheet(model: model, isPresented: $showingCreate) }
        .alert("Terminate this server terminal?", isPresented: Binding(get: { terminateID != nil }, set: { if !$0 { terminateID = nil } })) {
            Button("Cancel", role: .cancel) { terminateID = nil }
            Button("Terminate terminal", role: .destructive) { if let id = terminateID { Task { await model.terminate(id) } }; terminateID = nil }
        } message: { Text("This stops the process in this terminal. Other terminals remain running.") }
    }

    private var catalog: some View {
        VStack(spacing: 10) {
            HStack {
                Text("TERMINALS").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).disabled(model.connecting)
                Button { showingCreate = true } label: { Image(systemName: "plus") }.buttonStyle(.borderless).disabled(!model.connected || model.busy)
            }
            TextField("Find terminal or path", text: $search).textFieldStyle(.roundedBorder)
            if model.creationPending {
                VStack(alignment: .leading, spacing: 6) {
                    Text("An earlier creation is unconfirmed.").font(.caption)
                    Button("Retry same creation") { Task { await model.retryCreation() } }.disabled(model.busy || !model.connected)
                    Button("Clear after checking catalog") { model.clearCreationAfterReview() }.font(.caption).disabled(model.busy)
                }.padding(8).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
            }
            ScrollView {
                LazyVStack(spacing: 5) {
                    ForEach(model.terminals.filter { search.isEmpty || ($0.title + " " + $0.cwd + " " + $0.workspace).localizedCaseInsensitiveContains(search) }) { terminal in
                        Button { Task { await model.select(terminal.id) } } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Circle().fill(terminal.running ? Color.green : Color.secondary).frame(width: 6, height: 6)
                                    Text(terminal.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                }
                                Text(terminal.workspace).font(.caption).lineLimit(1)
                                Text(terminal.cwd.isEmpty ? "Working directory unavailable" : terminal.cwd).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                                Text(terminal.status).font(.system(size: 10)).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(9)
                                .background(model.selectedID == terminal.id ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(model.busy)
                            .contextMenu { Button("Terminate terminal…", role: .destructive) { terminateID = terminal.id }.disabled(!model.connected || model.busy) }
                    }
                }
            }
            Text("Process activity does not confirm task completion.").font(.system(size: 10)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            if let seen = model.lastSeen { Text("Catalog updated \(seen, style: .relative) ago").font(.system(size: 10)).foregroundStyle(.secondary) }
        }.padding(12)
    }

    @ViewBuilder private var terminal: some View {
        if let id = model.selectedID {
            let renderer = model.rendererGeneration
            VStack(spacing: 0) {
                HStack {
                    Text(model.selected?.title ?? "Terminal").font(.headline).lineLimit(1)
                    Spacer()
                    if !model.attached { Button("Reattach") { Task { await model.select(id) } }.disabled(model.busy || !model.connected) }
                    Toggle("Enable input", isOn: Binding(get: { model.inputEnabled }, set: { model.setInputEnabled($0) })).toggleStyle(.checkbox).disabled(!model.attached || !model.connected || !model.snapshotReady)
                    Toggle("Direct keys", isOn: $model.directInput).toggleStyle(.checkbox).disabled(!model.inputEnabled)
                    Button { terminateID = id } label: { Image(systemName: "stop.circle") }.help("Terminate this server terminal").disabled(model.busy || !model.connected)
                }.padding(10)
                GeometryReader { area in
                    TerminalSurface(pipe: model.pipe, acceptsInput: model.inputEnabled && model.directInput && model.connected && model.attached && model.snapshotReady, followsViewport: model.inputEnabled && model.attached,
                        onInput: { text in if renderer == model.rendererGeneration { model.raw(text) } },
                        onResize: { cols, rows in Task { guard renderer == model.rendererGeneration else { return }; await model.resize(cols, rows) } },
                        onFailure: { message in if renderer == model.rendererGeneration { model.rendererFailed(message) } },
                        onReady: { model.rendererRestored(renderer) })
                        .id(renderer).frame(width: area.size.width, height: area.size.height)
                }.frame(minHeight: 100, maxHeight: .infinity).layoutPriority(-1).clipped()
                Divider()
                if model.draft.pendingID != nil {
                    HStack {
                        Text("Pending send · no delivery receipt").font(.caption).foregroundStyle(.orange)
                        Spacer()
                        Button("Clear after checking terminal") { model.clearPendingAfterReview() }.disabled(model.busy)
                    }.padding(.horizontal, 12).padding(.vertical, 8)
                }
                PromptEditor(text: Binding(get: { model.draft.text }, set: model.setDraft), enabled: model.canSend, submit: { Task { await model.send() } }).frame(height: 100)
                HStack {
                    Text(model.directInput ? "Direct keys go to the terminal. Local draft is kept." : "Local draft · Enter sends · Shift-Enter adds a line").font(.system(size: 10)).foregroundStyle(.secondary)
                    Spacer()
                    if model.draft.lastQueuedText != nil {
                        Button("Restore last queued") { model.restoreLastQueuedPrompt() }.font(.caption).disabled(!model.draft.text.isEmpty || model.draft.pendingID != nil || model.busy)
                    }
                    Button("Send") { Task { await model.send() } }.buttonStyle(.borderedProminent).disabled(!model.canSend)
                }.padding(10)
            }
        } else {
            VStack(spacing: 12) {
                if model.connecting { ProgressView(); Text("Waiting for the encrypted connection…").foregroundStyle(.secondary) }
                else {
                    Image(systemName: "terminal").font(.largeTitle).foregroundStyle(.secondary)
                    Text("Select a terminal or start an agent.").foregroundStyle(.secondary)
                    Button("New terminal") { showingCreate = true }.disabled(!model.connected || model.creationPending)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct CmuxConnectSheet: View {
    @ObservedObject var model: CmuxViewModel
    @Binding var isPresented: Bool
    @State private var label = ""
    @State private var route = ""
    @State private var invitation = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect a cmux server").font(.title2.weight(.semibold))
            TextField("Connection name", text: $label)
            TextField("wss://server.example/v1/link or iroh://…", text: $route)
            SecureField("Single-use enrollment invitation", text: $invitation)
            Text("The server must run cmux-tui with its remote listener enabled. Approve this device on the server when requested. Device identity and server pins are stored in Keychain.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Cancel") { invitation = ""; isPresented = false }
                Spacer()
                Button("Connect") {
                    let token = invitation; invitation = ""; isPresented = false
                    Task { await model.addProfile(label: label, route: route, invitation: token) }
                }.buttonStyle(.borderedProminent).disabled(route.isEmpty || model.busy || model.connecting || model.disconnecting)
            }
        }.textFieldStyle(.roundedBorder).padding(24).frame(width: 470)
    }
}

private struct CmuxCreateSheet: View {
    @ObservedObject var model: CmuxViewModel
    @Binding var isPresented: Bool
    @State private var provider = "claude"
    @State private var cwd = ""
    @State private var name = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Start a server terminal").font(.title2.weight(.semibold))
            Picker("Command", selection: $provider) { Text("Claude Code").tag("claude"); Text("Codex").tag("codex"); Text("Shell").tag("shell") }
            TextField("Name", text: $name)
            TextField("Absolute working directory on server", text: $cwd)
            Text("The command runs on your server in a persistent PTY. Provider sign-in, tools, permissions, and terminal UI stay with the real CLI.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Cancel") { isPresented = false }; Spacer()
                Button("Start") { isPresented = false; Task { await model.create(provider: provider, cwd: cwd, name: name) } }
                    .buttonStyle(.borderedProminent).disabled(!cwd.hasPrefix("/") || model.creationPending || model.busy)
            }
        }.textFieldStyle(.roundedBorder).padding(24).frame(width: 460)
            .onAppear { cwd = model.selected?.cwd ?? "" }
    }
}
