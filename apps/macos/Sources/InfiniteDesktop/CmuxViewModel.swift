import SwiftUI
import InfiniteCore

struct CmuxHostProfile: Codable, Identifiable {
    var id = UUID().uuidString
    var label: String
    var route: String
}

struct CmuxTerminalRow: Identifiable {
    let value: JSON
    let workspace: String
    let agent: JSON
    var id: String { value["id"].string }
    var title: String { value["title"].string.isEmpty ? "Terminal" : value["title"].string }
    var cwd: String { value["cwd"].string }
    var running: Bool { value["running"].bool }
    var status: String { running ? "Process running" : value["lifecycle"].string.isEmpty ? "Not running" : value["lifecycle"].string }
}

private struct CmuxPendingCreation: Codable {
    var id: String
    var argv: [String]
    var cwd: String
    var name: String
}

@MainActor final class CmuxViewModel: ObservableObject {
    @Published var profiles: [CmuxHostProfile] = []
    @Published var activeID = ""
    @Published var connected = false
    @Published var connecting = false
    @Published private(set) var disconnecting = false
    @Published var attached = false
    @Published var busy = false
    @Published var inputEnabled = false
    @Published var directInput = false
    @Published var notice = "Connect an enrolled cmux server to open its real terminals."
    @Published var connectionStatus = "Disconnected"
    @Published var terminals: [CmuxTerminalRow] = []
    @Published var selectedID: String?
    @Published var lastSeen: Date?
    @Published var draft = DraftRecord()
    @Published var creationPending = false
    @Published private(set) var rendererGeneration = UUID()
    @Published private(set) var snapshotReady = false
    let pipe = TerminalPipe()
    private let backend = CmuxBackend()
    private let drafts = DraftStore()
    private var poll: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    private var attachmentGeneration = UUID()
    private var outputBuffer: CmuxOutputBuffer?
    private var pendingCreation: CmuxPendingCreation?
    private var lastSize = (80, 24)
    private var queuedInput = Data()
    private var sendingRaw = false
    private var busyAttachment: UUID?
    private var snapshotReceived = false
    private var streamEnded = false
    private var attachedProfileID = ""
    var active: CmuxHostProfile? { profiles.first { $0.id == activeID } }
    var selected: CmuxTerminalRow? { terminals.first { $0.id == selectedID } }
    var canSend: Bool { connected && attached && snapshotReady && inputEnabled && !directInput && !busy && draft.pendingID == nil && !draft.text.isEmpty }
    private var draftIdentity: String? { selectedID.map { "cmux:\(attachedProfileID):\($0)" } }

    init() {
        if let data = UserDefaults.standard.data(forKey: "cmuxProfiles"), let saved = try? JSONDecoder().decode([CmuxHostProfile].self, from: data) { profiles = saved }
        activeID = UserDefaults.standard.string(forKey: "activeCmuxProfile") ?? profiles.first?.id ?? ""
    }

    func addProfile(label: String, route: String, invitation: String) async {
        guard !busy, !connecting, !disconnecting else { return }
        do {
            try await disconnect()
            let profile = CmuxHostProfile(label: label.isEmpty ? "cmux server" : label, route: route.trimmingCharacters(in: .whitespacesAndNewlines))
            profiles.append(profile); activeID = profile.id; persistProfiles()
            await connect(invitation: invitation)
        } catch { notice = error.localizedDescription }
    }

    func connect(invitation: String = "") async {
        guard !connecting, !disconnecting, !busy, let profile = active else { return }
        do { try await disconnect() } catch { notice = error.localizedDescription; return }
        connecting = true; connectionStatus = invitation.isEmpty ? "Authenticating saved identity…" : "Waiting for server enrollment approval…"
        notice = invitation.isEmpty ? "Authenticating the pinned cmux server." : "Approve this device on your server. The invitation stays in memory."
        connectionGeneration = UUID(); let generation = connectionGeneration
        let helper = Bundle.main.resourceURL!.appendingPathComponent("cmux")
        do {
            let token = invitation.trimmingCharacters(in: .whitespacesAndNewlines)
            try await backend.connect(profileID: profile.id, route: profile.route, helperURL: helper, invitation: token.isEmpty ? nil : token) { [weak self] event in
                Task { @MainActor in
                    guard let self, self.connectionGeneration == generation else { return }
                    let state = event["connection"]["state"].string
                    if !state.isEmpty { self.connectionStatus = state == "connected" ? "Noise encrypted · enrolled device" : state.capitalized }
                    if state != "connected" { self.inputEnabled = false; self.directInput = false }
                }
            }
            guard generation == connectionGeneration else { return }
            connected = true; connecting = false; connectionStatus = "Noise encrypted · enrolled device"
            persistProfiles(); loadPendingCreation()
            await refresh()
            guard generation == connectionGeneration else { return }
            if let id = terminals.first?.id { await select(id) }
            guard generation == connectionGeneration else { return }
            poll = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let self, !Task.isCancelled, self.connectionGeneration == generation else { return }
                    await self.refresh()
                }
            }
        } catch {
            guard generation == connectionGeneration else { return }
            connecting = false; connected = false; connectionStatus = "Disconnected"
            notice = error.localizedDescription
        }
    }

    func refresh() async {
        guard !disconnecting else { return }
        let generation = connectionGeneration
        do {
            let snapshot = try await backend.snapshot()
            guard generation == connectionGeneration else { return }
            let tabs = snapshot["tabs"].array, panes = snapshot["panes"].array, screens = snapshot["screens"].array, workspaces = snapshot["workspaces"].array
            terminals = snapshot["terminals"].array.map { terminal in
                let tab = tabs.first { $0["id"] == terminal["tab_id"] }
                let pane = panes.first { $0["id"] == tab?["pane_id"] }
                let screen = screens.first { $0["id"] == pane?["screen_id"] }
                let workspace = workspaces.first { $0["id"] == screen?["workspace_id"] }
                let agent = snapshot["agents"].array.first { $0["terminal_id"] == terminal["id"] } ?? .null
                return CmuxTerminalRow(value: terminal, workspace: workspace?["name"].string ?? "Workspace", agent: agent)
            }
            connected = true; lastSeen = Date()
            if let selectedID, !terminals.contains(where: { $0.id == selectedID && $0.running }) { inputEnabled = false; directInput = false }
        } catch {
            guard generation == connectionGeneration else { return }
            connected = false; inputEnabled = false; directInput = false
            notice = "Catalog is stale. \(error.localizedDescription)"
        }
    }

    func select(_ id: String) async {
        guard connected, !busy, !connecting, !disconnecting else { return }
        do { try persistDraft() } catch { notice = error.localizedDescription; return }
        let connection = connectionGeneration, profileID = activeID
        saveTask?.cancel(); inputEnabled = false; directInput = false; queuedInput.removeAll()
        attachmentGeneration = UUID(); let generation = attachmentGeneration
        rendererGeneration = UUID(); snapshotReady = false; snapshotReceived = false
        busy = true; busyAttachment = generation; sendingRaw = false
        defer { if generation == attachmentGeneration && connection == connectionGeneration { busy = false; busyAttachment = nil } }
        outputBuffer?.cancel(); outputBuffer = nil
        await backend.detach()
        guard connection == connectionGeneration, generation == attachmentGeneration, profileID == activeID else { return }
        selectedID = id; attachedProfileID = profileID; attached = false; snapshotReady = false; streamEnded = false; pipe.feed(Data(), reset: true)
        do { draft = try drafts.read(draftIdentity!) }
        catch { notice = error.localizedDescription; return }
        let buffer = CmuxOutputBuffer { [weak self] events in
            guard let self, self.attachmentGeneration == generation else { return }
            for event in events { self.receive(event) }
        }
        outputBuffer = buffer
        do {
            try await backend.attach(terminalID: id) { buffer.append($0) }
            guard generation == attachmentGeneration else { return }
            attached = !streamEnded
            notice = draft.pendingID == nil ? "Draft locally. Enable input when you are ready to send." : "A previous input has no delivery receipt. Inspect the terminal before clearing it."
        } catch { buffer.cancel(); if generation == attachmentGeneration { notice = error.localizedDescription } }
    }

    private func receive(_ event: CmuxTerminalOutput) {
        switch event {
        case .snapshot(let bytes, let columns, let rows):
            snapshotReady = false; snapshotReceived = true
            pipe.feed(bytes, reset: true, columns: columns, rows: rows)
        case .bytes(let bytes): pipe.feed(bytes)
        case .resized: break
        case .exited:
            streamEnded = true; snapshotReady = false; snapshotReceived = false; attached = false; inputEnabled = false; directInput = false
            notice = "The terminal stream ended. Refresh the catalog to inspect its state."
        case .invalidFrame:
            rendererFailed("Terminal output exceeded the client limit or was invalid. Reattach to load a fresh snapshot.")
        }
    }

    func rendererFailed(_ message: String) {
        attachmentGeneration = UUID(); let generation = attachmentGeneration
        streamEnded = true; attached = false; snapshotReady = false; snapshotReceived = false; inputEnabled = false; directInput = false
        if busyAttachment != nil { busy = false; busyAttachment = nil }
        sendingRaw = false; queuedInput.removeAll()
        outputBuffer?.cancel(); outputBuffer = nil
        notice = message
        Task { guard generation == attachmentGeneration else { return }; await backend.detach() }
    }

    func rendererRestored(_ generation: UUID) {
        // A new web view can acknowledge its initial empty replay before the
        // server snapshot arrives. Only a rendered server snapshot admits input.
        guard generation == rendererGeneration, snapshotReceived, !streamEnded else { return }
        snapshotReady = true
    }

    func setInputEnabled(_ value: Bool) {
        inputEnabled = value && connected && attached && snapshotReady && !busy
        if !inputEnabled {
            directInput = false; queuedInput.removeAll()
            notice = "Input disabled. Your draft stays local."
        }
        else {
            notice = "Input enabled here. Other enrolled clients can also type. Enter sends; Shift-Enter adds a line."
            Task { await resize(lastSize.0, lastSize.1) }
        }
    }

    func setDraft(_ text: String) {
        draft.text = text; saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled else { return }
            do { try self.persistDraft() } catch { self.notice = error.localizedDescription }
        }
    }

    func send() async {
        guard canSend, let identity = draftIdentity, let terminalID = selectedID else { return }
        let connection = connectionGeneration, attachment = attachmentGeneration, profileID = attachedProfileID
        let current = { self.connectionGeneration == connection && self.attachmentGeneration == attachment && self.attachedProfileID == profileID && self.selectedID == terminalID && self.draftIdentity == identity }
        guard draft.text.utf8.count <= 32 * 1024 else { notice = "Send at most 32 KiB in one prompt."; return }
        let requestID = UUID().uuidString, text = draft.text
        draft.pendingID = requestID; draft.pendingText = text
        do { try drafts.save(draft, identity: identity) } catch { notice = error.localizedDescription; return }
        busy = true; busyAttachment = attachment
        defer { if current() { busy = false; busyAttachment = nil } }
        do {
            _ = try await backend.paste(text)
            guard current() else { return }
            guard connected, attached, snapshotReady, inputEnabled, !directInput else { throw DesktopError("Input stopped before Enter. Inspect the pasted text before continuing.") }
            _ = try await backend.send(Data([13]))
            guard current() else { return }
            guard draft.pendingID == requestID else { throw DesktopError("The pending draft changed. Inspect the terminal before continuing.") }
            var updated = draft
            updated.lastQueuedText = updated.pendingText
            if updated.text == updated.pendingText { updated.text = "" }
            updated.pendingID = nil; updated.pendingText = nil
            try drafts.save(updated, identity: identity)
            draft = updated
            notice = "Queued to connection. Delivery and agent execution are not confirmed."
        } catch { if current() { inputEnabled = false; directInput = false; notice = "Input outcome is uncertain. \(error.localizedDescription)" } }
    }

    func clearPendingAfterReview() {
        guard !busy else { return }
        var updated = draft
        if updated.text == updated.pendingText { updated.text = "" }
        updated.pendingID = nil; updated.pendingText = nil
        do {
            if let draftIdentity { try drafts.save(updated, identity: draftIdentity) }
            draft = updated; notice = "Pending send cleared after your review. It was not resent."
        }
        catch { notice = error.localizedDescription }
    }

    func restoreLastQueuedPrompt() {
        guard draft.text.isEmpty, draft.pendingID == nil, let text = draft.lastQueuedText else { return }
        setDraft(text)
        notice = "Last queued prompt restored locally. Check the terminal before choosing to send it again."
    }

    func raw(_ text: String) {
        guard inputEnabled, directInput, attached, snapshotReady, connected else { return }
        let bytes = Data(text.utf8)
        guard queuedInput.count + bytes.count <= 32 * 1024 else {
            queuedInput.removeAll(); inputEnabled = false; directInput = false
            notice = "Input queue is full. Inspect the terminal before enabling input again."; return
        }
        queuedInput.append(bytes)
        guard !sendingRaw else { return }; sendingRaw = true
        let generation = attachmentGeneration
        Task {
            defer { if generation == attachmentGeneration { sendingRaw = false } }
            while !queuedInput.isEmpty && inputEnabled && directInput && attachmentGeneration == generation {
                let bytes = queuedInput; queuedInput.removeAll()
                do { _ = try await backend.send(bytes) }
                catch { if generation == attachmentGeneration { queuedInput.removeAll(); inputEnabled = false; directInput = false; notice = "Input was not confirmed. \(error.localizedDescription)" }; return }
            }
        }
    }

    func resize(_ columns: Int, _ rows: Int) async {
        lastSize = (columns, rows)
        guard inputEnabled, attached else { return }
        let generation = attachmentGeneration
        do { try await backend.resize(columns: columns, rows: rows) }
        catch { if generation == attachmentGeneration { notice = error.localizedDescription } }
    }

    func create(provider: String, cwd: String, name: String) async {
        guard connected, !busy else { return }
        if pendingCreation == nil {
            let argv = provider == "claude" ? ["claude"] : provider == "codex" ? ["codex"] : ["/bin/bash", "-l"]
            pendingCreation = CmuxPendingCreation(id: UUID().uuidString, argv: argv, cwd: cwd, name: name.isEmpty ? provider.capitalized : name)
            creationPending = true
            do { try savePendingCreation(pendingCreation, profileID: activeID) } catch { notice = error.localizedDescription; return }
        }
        await retryCreation()
    }

    func retryCreation() async {
        guard let pendingCreation, connected, !busy, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let identity = "cmux:\(profileID):creation"
        let current = { self.connectionGeneration == generation && self.activeID == profileID }
        do { try savePendingCreation(pendingCreation, profileID: profileID) } catch { notice = error.localizedDescription; return }
        busy = true; busyAttachment = nil
        defer { if current() { busy = false } }
        do {
            let result = try await backend.createTerminal(argv: pendingCreation.argv, cwd: pendingCreation.cwd, name: pendingCreation.name, mutationID: pendingCreation.id)
            // Settle only this profile's exact receipt, even if the UI moved on.
            if try drafts.read(identity).pendingID == pendingCreation.id { try drafts.save(DraftRecord(), identity: identity) }
            guard current(), self.pendingCreation?.id == pendingCreation.id else { return }
            self.pendingCreation = nil
            creationPending = false
            busy = false; await refresh()
            guard current() else { return }
            await select(result.terminalID)
        } catch { if current() { notice = "Creation was not confirmed. Inspect the catalog; retry uses the same mutation identity. \(error.localizedDescription)" } }
    }

    func clearCreationAfterReview() {
        guard !busy else { return }
        let previous = pendingCreation; pendingCreation = nil
        do { try savePendingCreation(nil, profileID: activeID); creationPending = false }
        catch { pendingCreation = previous; notice = error.localizedDescription }
    }

    func terminate(_ id: String) async {
        guard connected, !busy, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let current = { self.connectionGeneration == generation && self.activeID == profileID }
        let identity = "cmux:\(profileID):terminate:\(id)"
        busy = true; busyAttachment = nil
        defer { if current() { busy = false } }
        do {
            var receipt = try drafts.read(identity)
            let mutationID = receipt.pendingID ?? UUID().uuidString
            receipt.pendingID = mutationID
            try drafts.save(receipt, identity: identity)
            try await backend.closeTerminal(id, mutationID: mutationID)
            if try drafts.read(identity).pendingID == mutationID { try drafts.save(DraftRecord(), identity: identity) }
            guard current() else { return }
            if id == selectedID { inputEnabled = false; directInput = false; attached = false }
            notice = "The server confirmed terminal termination."; await refresh()
        } catch { if current() { notice = "Termination was not confirmed. Refresh the catalog before trying again. \(error.localizedDescription)" } }
    }

    func disconnect() async throws {
        guard !disconnecting else { return }
        disconnecting = true
        defer { disconnecting = false }
        try persistDraft(); saveTask?.cancel(); poll?.cancel(); poll = nil
        connectionGeneration = UUID(); attachmentGeneration = UUID()
        connected = false; connecting = false; sendingRaw = false; busyAttachment = nil
        inputEnabled = false; directInput = false; attached = false; snapshotReady = false; snapshotReceived = false; queuedInput.removeAll()
        outputBuffer?.cancel(); outputBuffer = nil
        try await backend.disconnect()
        connected = false; connecting = false; busy = false; connectionStatus = "Disconnected"
        notice = "Connect to inspect your server terminals."
        terminals = []; selectedID = nil; pipe.feed(Data(), reset: true)
        draft = DraftRecord(); pendingCreation = nil; creationPending = false
    }

    private func persistDraft() throws {
        if let draftIdentity { try drafts.save(draft, identity: draftIdentity) }
    }
    private func persistProfiles() {
        UserDefaults.standard.set(try? JSONEncoder().encode(profiles), forKey: "cmuxProfiles")
        UserDefaults.standard.set(activeID, forKey: "activeCmuxProfile")
    }
    private func savePendingCreation(_ pendingCreation: CmuxPendingCreation?, profileID: String) throws {
        var record = DraftRecord()
        if let pendingCreation { record.pendingID = pendingCreation.id; record.pendingText = String(decoding: try JSONEncoder().encode(pendingCreation), as: UTF8.self) }
        try drafts.save(record, identity: "cmux:\(profileID):creation")
    }
    private func loadPendingCreation() {
        do {
            let record = try drafts.read("cmux:\(activeID):creation")
            pendingCreation = try record.pendingText.map { try JSONDecoder().decode(CmuxPendingCreation.self, from: Data($0.utf8)) }
            creationPending = pendingCreation != nil
        } catch { notice = error.localizedDescription }
    }
}

/// Backpressure is applied on the SDK thread before scheduling MainActor work.
/// Exactly one drain is outstanding; overflow forces a fresh server snapshot.
private final class CmuxOutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [CmuxTerminalOutput] = []
    private var byteCount = 0
    private var scheduled = false
    private var canceled = false
    private var failed = false
    private let deliver: @MainActor @Sendable ([CmuxTerminalOutput]) -> Void
    init(deliver: @escaping @MainActor @Sendable ([CmuxTerminalOutput]) -> Void) { self.deliver = deliver }
    func append(_ event: CmuxTerminalOutput) {
        lock.lock()
        guard !canceled, !failed else { lock.unlock(); return }
        let size: Int
        switch event { case .snapshot(let bytes, _, _), .bytes(let bytes): size = bytes.count; default: size = 0 }
        if events.count >= 512 || byteCount + size > 16 * 1024 * 1024 {
            events = [.invalidFrame]; byteCount = 0; failed = true
        } else { events.append(event); byteCount += size }
        let shouldSchedule = !scheduled; scheduled = true; lock.unlock()
        if shouldSchedule { Task { @MainActor in self.flush() } }
    }
    @MainActor private func flush() {
        lock.lock(); let batch = canceled ? [] : events; events.removeAll(); byteCount = 0; scheduled = false; lock.unlock()
        if !batch.isEmpty { deliver(batch) }
    }
    func cancel() { lock.lock(); canceled = true; events.removeAll(); byteCount = 0; lock.unlock() }
}
