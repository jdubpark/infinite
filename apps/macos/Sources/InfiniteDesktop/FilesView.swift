import SwiftUI
import AppKit
import InfiniteCore

struct FilesView: View {
    @ObservedObject var app: AppModel
    @State private var projectID = ""
    @State private var localRoot: URL?
    @State private var localPath = ""
    @State private var remotePath = ""
    @State private var localEntries: [FileEntry] = []
    @State private var remoteEntries: [FileEntry] = []
    @State private var localSelection = Set<String>()
    @State private var remoteSelection = Set<String>()
    @State private var nextCursor: String?
    @State private var remoteTotal = 0
    @State private var remoteLoaded = false
    @State private var remoteLoadedPath: String?
    @State private var loadingRemote = false
    @State private var localError = ""
    @State private var remoteError = ""
    @State private var status = ""
    @State private var failure = ""
    @State private var progress = 0.0
    @State private var busy = false
    @State private var canceling = false
    @State private var operation: Task<Void, Never>?
    @State private var plan: SyncPlan?
    @State private var showingPlan = false
    @State private var loadGeneration = UUID()

    private var transfer: FileTransfer? {
        guard let client = app.client, !projectID.isEmpty else { return nil }
        return FileTransfer(client: client, projectID: projectID)
    }
    private var localChosen: [FileEntry] { localEntries.filter { localSelection.contains($0.id) } }
    private var remoteChosen: [FileEntry] { remoteEntries.filter { remoteSelection.contains($0.id) } }
    private var canUpload: Bool { app.connected && app.isOwner && !busy && !localChosen.isEmpty && localChosen.allSatisfy(\.transferable) }
    private var canDownload: Bool { app.connected && localRoot != nil && !busy && !remoteChosen.isEmpty && remoteChosen.allSatisfy(\.transferable) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Files").font(.largeTitle.weight(.semibold))
                Spacer()
                Picker("Server project", selection: $projectID) {
                    Text("Choose project").tag("")
                    ForEach(Array(app.projects.enumerated()), id: \.offset) { _, project in Text(project["name"].string).tag(project["id"].string) }
                }.frame(maxWidth: 260).disabled(busy || !app.connected)
                Button { refresh() } label: { Image(systemName: "arrow.clockwise") }.help("Refresh both folders").disabled(busy)
            }
            HSplitView {
                localPane.frame(minWidth: 270)
                remotePane.frame(minWidth: 270)
            }
            HStack(spacing: 12) {
                Button("Upload selected →") { uploadSelected() }.disabled(!canUpload)
                Button("← Download selected") { downloadSelected() }.disabled(!canDownload)
                Spacer()
                Button("Preview folder sync") { previewSync() }.disabled(busy || localRoot == nil || projectID.isEmpty || !app.connected)
            }
            Text("Transfers compare file versions before replacing anything. Previous versions are saved privately. Files are limited to 256 MiB.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                ProgressView(value: busy ? progress : 0).frame(maxWidth: 180).opacity(busy ? 1 : 0)
                Text(status).font(.caption).foregroundStyle(busy ? .primary : .secondary).lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                Button(canceling ? "Canceling…" : "Cancel") { canceling = true; operation?.cancel() }
                    .frame(width: 82).disabled(!busy || canceling).opacity(busy ? 1 : 0)
            }.frame(height: 24)
            Text(failure).foregroundStyle(.red).font(.callout).lineLimit(2).textSelection(.enabled)
                .opacity(failure.isEmpty ? 0 : 1).frame(height: 34, alignment: .leading)
        }
        .padding(22)
        .onAppear { if projectID.isEmpty { projectID = app.projects.first?["id"].string ?? "" }; refresh() }
        .onChange(of: projectID) { _, _ in remotePath = ""; remoteSelection = []; plan = nil; refreshRemote() }
        .onChange(of: app.activeID) { _, _ in
            operation?.cancel(); plan = nil; showingPlan = false; projectID = ""; remotePath = ""; remoteEntries = []; nextCursor = nil; remoteLoaded = false; remoteLoadedPath = nil
        }
        .onChange(of: app.projects.map { $0["id"].string }) { _, ids in
            if !ids.contains(projectID) { projectID = ids.first ?? "" }
        }
        .onDisappear { operation?.cancel() }
        .sheet(isPresented: $showingPlan) { syncSheet }
    }

    private var localPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("This Mac", systemImage: "laptopcomputer").font(.headline)
                Spacer(); Button("Choose folder…") { chooseFolder() }.disabled(busy)
            }
            HStack {
                Button { localPath = parent(localPath); localSelection = []; refreshLocal() } label: { Image(systemName: "arrow.up") }.disabled(localPath.isEmpty || busy)
                Text(localRoot.map { $0.lastPathComponent + (localPath.isEmpty ? "" : "/" + localPath) } ?? "No folder selected")
                    .font(.caption.monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
            if !localError.isEmpty { stateView(localError, symbol: "exclamationmark.triangle") }
            else if localRoot == nil { stateView("Choose a Mac folder to browse, transfer, or sync.", symbol: "folder") }
            else if localEntries.isEmpty { stateView("This Mac folder is empty.", symbol: "folder") }
            else {
                Table(localEntries, selection: $localSelection) {
                    TableColumn("Name") { entry in entryName(entry) { localPath = entry.path; localSelection = []; refreshLocal() } }
                    TableColumn("Size") { entry in Text(size(entry)).foregroundStyle(.secondary) }.width(70)
                }
            }
        }.padding(10)
    }
    private var remotePane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Server", systemImage: "server.rack").font(.headline)
                Spacer(); Text(app.connected ? "Encrypted connection" : app.active == nil ? "Not paired" : app.sessionsDisplayStale ? (remoteLoaded ? "Offline · last received" : "Can't reach server") : "Checking…")
                    .font(.caption).foregroundStyle(app.sessionsDisplayStale ? Palette.attention : .secondary).lineLimit(1).frame(width: 150, alignment: .trailing)
            }.frame(height: 24)
            HStack {
                Button { remotePath = parent(remotePath); remoteSelection = []; refreshRemote() } label: { Image(systemName: "arrow.up") }.disabled(remotePath.isEmpty || busy || !app.connected)
                Text(remotePath.isEmpty ? "/" : "/" + remotePath).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
            if remoteLoaded {
                if remoteEntries.isEmpty { stateView(remoteError.isEmpty ? "This server folder is empty." : remoteError, symbol: remoteError.isEmpty ? "folder" : "exclamationmark.triangle") }
                else {
                    Table(remoteEntries, selection: $remoteSelection) {
                        TableColumn("Name") { entry in entryName(entry) { remotePath = entry.path; remoteSelection = []; refreshRemote() }.disabled(!app.connected) }
                        TableColumn("Size") { entry in Text(size(entry)).foregroundStyle(.secondary) }.width(70)
                    }
                }
            }
            else if !app.connected { stateView("Connect to a server to browse its projects.", symbol: "network.slash") }
            else if projectID.isEmpty { stateView("Choose a server project.", symbol: "folder") }
            else if !remoteError.isEmpty { stateView(remoteError, symbol: "exclamationmark.triangle") }
            else if loadingRemote { ProgressView("Loading server folder…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                stateView("Choose a server project.", symbol: "folder")
            }
            Text(remoteError).font(.caption).foregroundStyle(.orange).lineLimit(1).frame(height: 16, alignment: .leading)
            if nextCursor != nil {
                HStack { Text("\(remoteEntries.count) of \(remoteTotal)").font(.caption).foregroundStyle(.secondary); Spacer(); Button { refreshRemote(more: true) } label: { Text(loadingRemote ? "Loading…" : "Load more").frame(width: 88) }.disabled(busy || loadingRemote || !app.connected) }
            }
        }.padding(10)
    }
    private func stateView(_ message: String, symbol: String) -> some View {
        VStack(spacing: 12) { Image(systemName: symbol).font(.system(size: 28)); Text(message).multilineTextAlignment(.center).font(.callout) }
            .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity).padding(20)
    }
    private func entryName(_ entry: FileEntry, open: @escaping () -> Void) -> some View {
        HStack {
            if entry.isDirectory { Button(action: open) { Label(entry.name, systemImage: "folder.fill") }.buttonStyle(.plain).disabled(busy) }
            else { Label(entry.name, systemImage: entry.kind == "symlink" ? "link" : "doc") }
            if !entry.isDirectory && !entry.transferable { Image(systemName: "minus.circle").foregroundStyle(.secondary).help("Symbolic links, special files, and files larger than 256 MiB cannot be transferred.") }
        }
    }
    private func size(_ entry: FileEntry) -> String { entry.isDirectory ? "—" : ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file) }
    private func parent(_ path: String) -> String { path.split(separator: "/").dropLast().joined(separator: "/") }
    private func chooseFolder() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.prompt = "Choose folder"
        if panel.runModal() == .OK, let url = panel.url {
            do { localRoot = try LocalFiles.canonicalRoot(url); localPath = ""; localSelection = []; plan = nil; refreshLocal() }
            catch { localError = error.localizedDescription }
        }
    }
    private func refresh() { refreshLocal(); refreshRemote() }
    private func refreshLocal() {
        guard let root = localRoot else { return }
        do { localEntries = try LocalFiles.list(root: root, path: localPath); localError = "" }
        catch { localEntries = []; localError = error.localizedDescription }
    }
    private func refreshRemote(more: Bool = false) {
        let path = remotePath, cursor = more ? nextCursor : nil
        let loadedKey = projectID + "\u{0}" + path
        if loadedKey != remoteLoadedPath {
            loadGeneration = UUID(); remoteEntries = []; remoteSelection = []; remoteLoaded = false; nextCursor = nil; loadingRemote = false; remoteError = ""
        }
        guard let transfer, app.connected else { return }
        let generation = UUID(); loadGeneration = generation
        remoteError = ""; loadingRemote = true
        Task {
            do {
                let page = try await transfer.list(path: path, cursor: cursor)
                guard generation == loadGeneration else { return }
                remoteEntries = more ? remoteEntries + page.entries : page.entries
                nextCursor = page.nextCursor; remoteTotal = page.total; remoteLoadedPath = loadedKey; remoteLoaded = true; loadingRemote = false
            } catch { if generation == loadGeneration { remoteError = error.localizedDescription; loadingRemote = false } }
        }
    }
    private func begin(_ label: String, work: @escaping @MainActor () async throws -> String) {
        guard !busy else { return }
        busy = true; canceling = false; progress = 0; status = label; failure = ""
        operation = Task {
            do { status = try await work() }
            catch is CancellationError { status = "Canceled. Confirmed transfers remain. No further files will be transferred." }
            catch { failure = error.localizedDescription; status = "Stopped. Already confirmed transfers remain. Refresh the preview before retrying a sync." }
            busy = false; canceling = false; operation = nil; refresh()
        }
    }
    private func uploadSelected() {
        guard let transfer, let root = localRoot else { return }
        let chosen = localChosen, target = remotePath
        begin("Preparing upload…") {
            for entry in chosen {
                try Task.checkCancellation()
                guard let source = try await Task.detached(operation: { try LocalFiles.version(root: root, path: entry.path) }).value else { throw DesktopError("The selected local file disappeared.") }
                let path = SyncPlanner.joined(target, entry.name), expected = try await transfer.metadata(path: path)
                if let expected, expected.sha256 != source.sha256, !confirmReplacement(entry.name, side: "server") { throw CancellationError() }
                status = "Uploading " + entry.name
                try await transfer.upload(root: root, localPath: entry.path, remotePath: path, source: source, expectedRemote: expected) { value in Task { @MainActor in progress = value } }
            }
            return "Uploaded \(chosen.count) file(s). Previous server versions were saved privately."
        }
    }
    private func downloadSelected() {
        guard let transfer, let root = localRoot else { return }
        let chosen = remoteChosen, target = localPath
        begin("Preparing download…") {
            for entry in chosen {
                try Task.checkCancellation()
                guard let source = try await transfer.metadata(path: entry.path) else { throw DesktopError("The selected server file disappeared.") }
                let path = SyncPlanner.joined(target, entry.name)
                let expected = try await Task.detached(operation: { try LocalFiles.version(root: root, path: path) }).value
                if let expected, expected.sha256 != source.sha256, !confirmReplacement(entry.name, side: "Mac") { throw CancellationError() }
                status = "Downloading " + entry.name
                try await transfer.download(remotePath: entry.path, root: root, localPath: path, source: source, expectedLocal: expected) { value in Task { @MainActor in progress = value } }
            }
            return "Downloaded \(chosen.count) file(s). Previous Mac versions were saved privately."
        }
    }
    private func previewSync() {
        guard let transfer, let root = localRoot else { return }
        let path = localPath, serverPath = remotePath, profile = app.activeID
        begin("Comparing folders…") {
            let folder = try LocalFiles.location(root: root, path: path)
            let planner = SyncPlanner(transfer: transfer, baselines: try SyncBaselines())
            plan = try await planner.preview(profileID: profile, localRoot: folder, remoteRoot: serverPath) { value in Task { @MainActor in status = value } }
            try Task.checkCancellation()
            if !app.isOwner { for index in plan?.items.indices ?? 0..<0 where plan?.items[index].action == .upload { plan?.items[index].action = .none } }
            showingPlan = true
            return "Preview ready. No files have changed."
        }
    }
    private var syncSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("Folder sync preview").font(.title2.bold()); Spacer(); Button("Done") { showingPlan = false }.disabled(busy) }
            Text("Review each direction before applying. Deletions are never propagated. Conflicts stay unchanged until you choose a copy; replaced versions are backed up privately.")
                .font(.callout).foregroundStyle(.secondary)
            Text("Files only. Git metadata, Infinite state, .DS_Store, symbolic links, and special files are excluded. Empty folders are not synchronized.")
                .font(.caption).foregroundStyle(.secondary)
            if let plan {
                Text("\(plan.localRoot.lastPathComponent) ↔ server /\(plan.remoteRoot)").font(.caption.monospaced())
                if plan.items.isEmpty { stateView("Both folders contain no transferable files.", symbol: "checkmark.circle") }
                else {
                    Table(plan.items) {
                        TableColumn("File") { item in Text(item.path).lineLimit(1).truncationMode(.middle).help(item.path) }
                        TableColumn("Comparison") { item in Text(item.reason).font(.caption).foregroundStyle(item.needsDecision ? .orange : .secondary) }
                        TableColumn("Action") { item in
                            Picker("Action", selection: Binding(get: { self.plan?.items.first { $0.id == item.id }?.action ?? .none }, set: { value in
                                guard let index = self.plan?.items.firstIndex(where: { $0.id == item.id }) else { return }; self.plan?.items[index].action = value
                            })) {
                                ForEach(item.choices.filter { app.isOwner || $0 != .upload }, id: \.self) { action in Text(action.label).tag(action) }
                            }.labelsHidden().disabled(busy || item.blocked)
                        }.width(180)
                    }
                }
                HStack {
                    Text("\(plan.items.filter { $0.action != .none }.count) transfers selected").font(.caption)
                    Spacer()
                    Button("Refresh preview") { previewSync() }.disabled(busy || !app.connected)
                    Button("Saved server versions") { if let url = try? LocalFiles.privateDirectory("Recovered Files") { NSWorkspace.shared.open(url) } }
                    Button("Apply reviewed actions") { applySync() }.buttonStyle(.borderedProminent).disabled(busy || !app.connected || (!app.isOwner && plan.items.contains { $0.action == .upload }))
                }
            }
            if busy { HStack { ProgressView(value: progress); Text(status).lineLimit(1); Button(canceling ? "Canceling…" : "Cancel") { canceling = true; operation?.cancel() }.disabled(canceling) } }
            if !failure.isEmpty { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
        }.padding(24).frame(minWidth: 850, idealWidth: 1000, minHeight: 560, idealHeight: 650)
    }
    private func applySync() {
        guard let transfer, let reviewed = plan else { return }
        begin("Applying reviewed transfers…") {
            let planner = SyncPlanner(transfer: transfer, baselines: try SyncBaselines())
            let count = try await planner.apply(reviewed) { name, value in Task { @MainActor in status = name; progress = value } }
            plan = nil; showingPlan = false
            return "Synced \(count) file(s). The baseline contains only confirmed copies."
        }
    }
    private func confirmReplacement(_ name: String, side: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Replace \(name) on the \(side)?"
        alert.informativeText = side == "Mac" ? "Its current version remains in a private .infinite-desktop-recovery folder beside the replaced file. In Finder, press Command-Shift-Period to show hidden folders." : "Its current version will be downloaded privately into Saved server versions before replacement."
        alert.addButton(withTitle: "Replace and keep backup"); alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}
