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
    @Published var activeID = "" {
        didSet {
            if activeID != oldValue {
                connectionGeneration = UUID()
                creationReceiptLoaded = false
                pendingCreation = nil
                creationPending = false
            }
        }
    }
    @Published var connected = false
    @Published var connecting = false
    @Published private(set) var displayVisible = false
    @Published private(set) var disconnecting = false
    @Published private(set) var draftEditingLocked = false
    @Published private(set) var inputFenced = false
    @Published var attached = false
    @Published var busy = false
    @Published private(set) var sending = false
    @Published var inputEnabled = false
    @Published var directInput = false
    @Published var notice = "Connect an enrolled cmux server to open its real terminals."
    @Published var connectionStatus = "Disconnected"
    @Published var terminals: [CmuxTerminalRow] = []
    @Published var selectedID: String?
    @Published var lastSeen: Date?
    @Published var draft = DraftRecord()
    @Published var creationPending = false
    @Published private(set) var creationReceiptLoaded = false
    @Published private(set) var rendererGeneration = UUID()
    @Published private(set) var snapshotReady = false
    @Published private(set) var hasConnected = false
    @Published private(set) var catalogDisplayStale = false
    @Published private(set) var catalogLoaded = false
    @Published private(set) var attaching = false
    let pipe = TerminalPipe()
    private let deps: CmuxViewModelDependencies
    private var poll: Task<Void, Never>?
    private var displayGeneration = UUID()
    private var pollGeneration = UUID()
    private var saveTask: Task<Void, Never>?
    private var saveInFlight: Task<Void, Error>?
    private var draftVersion = 0
    private var connectionGeneration = UUID()
    private var attachmentGeneration = UUID()
    private var inputGeneration = UUID()
    private var activeDisconnectTask: Task<Void, Error>?
    private var outputBuffer: CmuxOutputBuffer?
    private var pendingCreation: CmuxPendingCreation?
    private var clearingCreation = false
    private var clearingPending = false
    private var lastSize = (80, 24)
    private var queuedInput = Data()
    private var sendingRaw = false
    private var busyAttachment: UUID?
    private var selectionToken: UUID?
    private var snapshotReceived = false
    private var streamEnded = false
    private lazy var catalogFreshness = DisplayFreshness { [weak self] in self?.catalogDisplayStale = $0 }
    private var attachedProfileID = ""
    var active: CmuxHostProfile? { profiles.first { $0.id == activeID } }
    var selected: CmuxTerminalRow? { terminals.first { $0.id == selectedID } }
    var rendererVisible: Bool { displayVisible && attached }
    var canSend: Bool { connected && attached && snapshotReady && inputEnabled && !directInput && !busy && !inputFenced && !disconnecting && draft.pending == nil && !draft.text.isEmpty }
    private var draftIdentity: String? { selectedID.map { "cmux:\(attachedProfileID):\($0)" } }

    init(deps: CmuxViewModelDependencies = .live()) {
        self.deps = deps
        if let data = UserDefaults.standard.data(forKey: "cmuxProfiles"), let saved = try? JSONDecoder().decode([CmuxHostProfile].self, from: data) { profiles = saved }
        activeID = UserDefaults.standard.string(forKey: "activeCmuxProfile") ?? profiles.first?.id ?? ""
    }

    func setDisplayVisible(_ visible: Bool) {
        guard displayVisible != visible else { return }
        displayVisible = visible
        displayGeneration = UUID()
        if visible, hasConnected {
            let generation = displayGeneration
            Task {
                await refresh()
                guard self.displayVisible, self.displayGeneration == generation, self.hasConnected, !self.disconnecting else { return }
                if selectedID == nil, let id = terminals.first?.id { await select(id) }
                startPolling()
            }
        } else {
            stopPolling()
        }
    }

    private func startPolling() {
        guard poll == nil, hasConnected, !disconnecting, displayVisible else { return }
        let generation = connectionGeneration, visibility = displayGeneration
        let run = UUID(); pollGeneration = run
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self, !Task.isCancelled, self.pollGeneration == run,
                      self.connectionGeneration == generation, self.hasConnected, !self.disconnecting, self.displayVisible,
                      self.displayGeneration == visibility else { break }
                await self.refresh()
            }
            guard let self, self.pollGeneration == run else { return }
            self.poll = nil
        }
    }

    private func stopPolling() {
        pollGeneration = UUID()
        poll?.cancel(); poll = nil
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
        guard activeID == profile.id else { return }
        connecting = true; creationReceiptLoaded = false; pendingCreation = nil; creationPending = false
        connectionStatus = invitation.isEmpty ? "Authenticating saved identity…" : "Waiting for server enrollment approval…"
        notice = invitation.isEmpty ? "Authenticating the pinned cmux server." : "Approve this device on your server. The invitation stays in memory."
        connectionGeneration = UUID(); let generation = connectionGeneration
        let helper = deps.helperURL()
        do {
            let token = invitation.trimmingCharacters(in: .whitespacesAndNewlines)
            try await deps.connect(profile.id, profile.route, helper, token.isEmpty ? nil : token) { [weak self] event in
                Task { @MainActor in
                    guard let self, self.connectionGeneration == generation else { return }
                    let state = event["connection"]["state"].string
                    if !state.isEmpty { self.connectionStatus = state == "connected" ? "Noise encrypted · enrolled device" : state.capitalized }
                    if state != "connected" { self.inputEnabled = false; self.directInput = false }
                }
            }
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            await loadPendingCreation(profileID: profile.id, generation: generation)
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            connected = true; connecting = false; connectionStatus = "Noise encrypted · enrolled device"
            hasConnected = true
            persistProfiles()
            await refresh()
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            if let id = terminals.first?.id { await select(id) }
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            startPolling()
        } catch {
            guard generation == connectionGeneration else { return }
            connecting = false; connected = false; connectionStatus = "Disconnected"
            notice = error.localizedDescription
        }
    }

    func refresh() async {
        guard displayVisible, !disconnecting else { return }
        let generation = connectionGeneration, visibility = displayGeneration
        do {
            let snapshot = try await deps.snapshot()
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            let tabs = snapshot["tabs"].array, panes = snapshot["panes"].array, screens = snapshot["screens"].array, workspaces = snapshot["workspaces"].array
            terminals = snapshot["terminals"].array.map { terminal in
                let tab = tabs.first { $0["id"] == terminal["tab_id"] }
                let pane = panes.first { $0["id"] == tab?["pane_id"] }
                let screen = screens.first { $0["id"] == pane?["screen_id"] }
                let workspace = workspaces.first { $0["id"] == screen?["workspace_id"] }
                let agent = snapshot["agents"].array.first { $0["terminal_id"] == terminal["id"] } ?? .null
                return CmuxTerminalRow(value: terminal, workspace: workspace?["name"].string ?? "Workspace", agent: agent)
            }
            connected = true; lastSeen = Date(); hasConnected = true; catalogLoaded = true
            catalogFreshness.recovered()
            if let selectedID, !terminals.contains(where: { $0.id == selectedID && $0.running }) { inputEnabled = false; directInput = false }
        } catch {
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            connected = false; inputEnabled = false; directInput = false
            catalogFreshness.failed()
        }
    }

    func select(_ id: String) async {
        guard connected, !busy, !connecting, !disconnecting else { return }
        let connection = connectionGeneration, profileID = activeID, priorAttachment = attachmentGeneration
        let token = UUID()
        selectionToken = token
        let fencedInput = UUID()
        inputGeneration = fencedInput
        inputFenced = true; inputEnabled = false; directInput = false; queuedInput.removeAll()
        saveTask?.cancel(); saveTask = nil
        busy = true; attaching = true
        defer {
            if selectionToken == token {
                selectionToken = nil
                draftEditingLocked = false
                inputFenced = false
                busy = false; busyAttachment = nil; attaching = false
            }
        }
        do { try await flushDraft() } catch {
            if connectionGeneration == connection && attachmentGeneration == priorAttachment && inputGeneration == fencedInput && !disconnecting {
                inputFenced = false
                notice = error.localizedDescription
            }
            return
        }
        guard connection == connectionGeneration, attachmentGeneration == priorAttachment, profileID == activeID, !disconnecting, selectionToken == token else { return }
        draftEditingLocked = true
        attachmentGeneration = UUID(); let generation = attachmentGeneration
        busyAttachment = generation
        saveTask?.cancel(); saveTask = nil
        inputEnabled = false; directInput = false; queuedInput.removeAll()
        rendererGeneration = UUID(); snapshotReady = false; snapshotReceived = false; sendingRaw = false
        outputBuffer?.cancel(); outputBuffer = nil
        await deps.detach()
        guard connection == connectionGeneration, generation == attachmentGeneration, profileID == activeID, !disconnecting else { return }
        selectedID = nil; draft = DraftRecord(); draftVersion += 1
        attached = false; snapshotReady = false; streamEnded = false; pipe.feed(Data(), reset: true)
        let identity = "cmux:\(profileID):\(id)"
        do {
            let loaded = try await deps.readDraft(identity)
            guard connection == connectionGeneration, generation == attachmentGeneration, profileID == activeID, !disconnecting else { return }
            selectedID = id; attachedProfileID = profileID; draft = loaded; draftVersion += 1
            draftEditingLocked = false
            inputFenced = false
        } catch { notice = error.localizedDescription; return }
        let buffer = CmuxOutputBuffer { [weak self] events in
            guard let self, self.attachmentGeneration == generation else { return }
            for event in events { self.receive(event) }
        }
        outputBuffer = buffer
        do {
            try await deps.attach(id) { buffer.append($0) }
            guard generation == attachmentGeneration else { return }
            attached = !streamEnded
            notice = draft.pending == nil ? "Draft locally. Enable input when you are ready to send." : "A previous input has no delivery receipt. Inspect the terminal before clearing it."
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
        attaching = false
        if busyAttachment != nil || selectionToken != nil {
            selectionToken = nil; draftEditingLocked = false; busy = false; busyAttachment = nil
        }
        sendingRaw = false; queuedInput.removeAll()
        outputBuffer?.cancel(); outputBuffer = nil
        notice = message
        Task { guard generation == attachmentGeneration else { return }; await deps.detach() }
    }

    func rendererRestored(_ generation: UUID) {
        guard generation == rendererGeneration, snapshotReceived, !streamEnded else { return }
        snapshotReady = true
    }

    func setInputEnabled(_ value: Bool) {
        inputEnabled = value && connected && attached && snapshotReady && !busy && !inputFenced && !disconnecting
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
        guard selectedID != nil, !disconnecting, !draftEditingLocked else { return }
        draft.text = text; draftVersion += 1; scheduleAutosave()
    }

    private func scheduleAutosave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled else { return }
            do { try await self.persistDraft() } catch { self.notice = error.localizedDescription }
        }
    }

    func send() async {
        guard canSend, let identity = draftIdentity, let terminalID = selectedID else { return }
        guard draft.text.utf8.count <= 32 * 1024 else { notice = "Send at most 32 KiB in one prompt."; return }
        saveTask?.cancel(); saveTask = nil
        let connection = connectionGeneration, attachment = attachmentGeneration, input = inputGeneration, profileID = attachedProfileID
        let current = { self.connectionGeneration == connection && self.attachmentGeneration == attachment && self.inputGeneration == input && !self.inputFenced && !self.disconnecting && self.attachedProfileID == profileID && self.selectedID == terminalID && self.draftIdentity == identity }
        sending = true; busy = true; busyAttachment = attachment
        defer { sending = false; if self.connectionGeneration == connection && self.attachmentGeneration == attachment { busy = false; busyAttachment = nil } }
        let requestID = UUID().uuidString, text = draft.text, previousPending = draft.pending
        draft.pending = PendingSend(id: requestID, text: text); draftVersion += 1
        do { try await saveRecord(draft, identity: identity) }
        catch {
            if current() && draft.pending?.id == requestID { draft.pending = previousPending; draftVersion += 1 }
            notice = error.localizedDescription; return
        }
        guard current(), !disconnecting, connected, attached, snapshotReady, inputEnabled, !directInput else {
            if attachedProfileID == profileID && selectedID == terminalID && draftIdentity == identity && draft.pending?.id == requestID {
                draft.pending = previousPending; draftVersion += 1
                try? await saveRecord(draft, identity: identity)
            }
            if connectionGeneration == connection && !disconnecting {
                notice = "Input stopped before sending. Your draft stays local."
            }
            return
        }
        do {
            _ = try await deps.paste(text)
            guard current() else { return }
            guard connected, attached, snapshotReady, inputEnabled, !directInput else { throw DesktopError("Input stopped before Enter. Inspect the pasted text before continuing.") }
            _ = try await deps.send(Data([13]))
            guard current() else { return }
            guard draft.pending?.id == requestID else { throw DesktopError("The pending draft changed. Inspect the terminal before continuing.") }
            let savedFollowUp = try await settlePendingSend(
                requestID: requestID,
                identity: identity,
                recordLastQueued: true,
                followUpErrorPrefix: "Send was queued, but your newer draft could not be saved"
            )
            if savedFollowUp {
                notice = "Queued to connection. Delivery and agent execution are not confirmed."
            }
        } catch { if current() { inputEnabled = false; directInput = false; notice = "Input outcome is uncertain. \(error.localizedDescription)" } }
    }

    func clearPendingAfterReview() {
        guard !busy, !clearingPending, let pending = draft.pending else { return }
        guard let identity = draftIdentity else {
            if draft.text == pending.text { draft.text = "" }
            draft.pending = nil; draftVersion += 1; notice = "Pending send cleared after your review. It was not resent."
            return
        }
        let pendingID = pending.id
        clearingPending = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.clearingPending = false }
            do {
                let savedFollowUp = try await self.settlePendingSend(
                    requestID: pendingID,
                    identity: identity,
                    recordLastQueued: false,
                    followUpErrorPrefix: "Pending send cleared, but your newer draft could not be saved"
                )
                if savedFollowUp && self.draftIdentity == identity {
                    self.notice = "Pending send cleared after your review. It was not resent."
                }
            } catch { self.notice = error.localizedDescription }
        }
    }

    func restoreLastQueuedPrompt() {
        guard draft.text.isEmpty, draft.pending == nil, let text = draft.lastQueuedText else { return }
        setDraft(text)
        notice = "Last queued prompt restored locally. Check the terminal before choosing to send it again."
    }

    func raw(_ text: String) {
        guard inputEnabled, directInput, attached, snapshotReady, connected, !inputFenced, !disconnecting else { return }
        let bytes = Data(text.utf8)
        guard queuedInput.count + bytes.count <= 32 * 1024 else {
            queuedInput.removeAll(); inputEnabled = false; directInput = false
            notice = "Input queue is full. Inspect the terminal before enabling input again."; return
        }
        queuedInput.append(bytes)
        guard !sendingRaw else { return }; sendingRaw = true
        let generation = attachmentGeneration, input = inputGeneration
        Task {
            defer { if generation == attachmentGeneration { sendingRaw = false } }
            while !queuedInput.isEmpty && inputEnabled && directInput && attachmentGeneration == generation && inputGeneration == input && !inputFenced && !disconnecting {
                let bytes = queuedInput; queuedInput.removeAll()
                do {
                    guard inputGeneration == input, !inputFenced, !disconnecting else { return }
                    _ = try await deps.send(bytes)
                }
                catch { if generation == attachmentGeneration { queuedInput.removeAll(); inputEnabled = false; directInput = false; notice = "Input was not confirmed. \(error.localizedDescription)" }; return }
            }
        }
    }

    func resize(_ columns: Int, _ rows: Int) async {
        lastSize = (columns, rows)
        guard inputEnabled, attached else { return }
        let generation = attachmentGeneration
        do { try await deps.resize(columns, rows) }
        catch { if generation == attachmentGeneration { notice = error.localizedDescription } }
    }

    func create(provider: String, cwd: String, name: String) async {
        guard connected, creationReceiptLoaded, !busy, !clearingCreation, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let current = { self.connectionGeneration == generation && self.activeID == profileID && !self.disconnecting }
        if pendingCreation == nil {
            busy = true; busyAttachment = nil
            let argv = provider == "claude" ? ["claude"] : provider == "codex" ? ["codex"] : ["/bin/bash", "-l"]
            let created = CmuxPendingCreation(id: UUID().uuidString, argv: argv, cwd: cwd, name: name.isEmpty ? provider.capitalized : name)
            pendingCreation = created; creationPending = true
            do { try await savePendingCreation(created, profileID: profileID) }
            catch {
                if connectionGeneration == generation && activeID == profileID {
                    if pendingCreation?.id == created.id { pendingCreation = nil; creationPending = false }
                    busy = false
                }
                if current() { notice = error.localizedDescription }
                return
            }
            if connectionGeneration == generation && activeID == profileID { busy = false }
        }
        guard current(), connected else { return }
        await retryCreation()
    }

    func retryCreation() async {
        guard let pendingCreation, connected, creationReceiptLoaded, !busy, !clearingCreation, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let identity = "cmux:\(profileID):creation"
        let current = { self.connectionGeneration == generation && self.activeID == profileID && !self.disconnecting }
        busy = true; busyAttachment = nil
        defer { if connectionGeneration == generation && activeID == profileID { busy = false } }
        do {
            try await savePendingCreation(pendingCreation, profileID: profileID)
            guard current(), connected, self.pendingCreation?.id == pendingCreation.id else { return }
            let terminalID = try await deps.createTerminal(pendingCreation.argv, pendingCreation.cwd, pendingCreation.name, pendingCreation.id)
            try await deps.clearDraftIfMatching(pendingCreation.id, identity)
            guard current(), self.pendingCreation?.id == pendingCreation.id else { return }
            self.pendingCreation = nil
            creationPending = false
            busy = false; await refresh()
            guard current() else { return }
            await select(terminalID)
        } catch { if current() { notice = "Creation was not confirmed. Inspect the catalog; retry uses the same mutation identity. \(error.localizedDescription)" } }
    }

    func clearCreationAfterReview() {
        guard !busy, !clearingCreation, creationReceiptLoaded, let target = pendingCreation else { return }
        let profileID = activeID, generation = connectionGeneration
        let identity = "cmux:\(profileID):creation"
        clearingCreation = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.clearingCreation = false }
            do {
                try await self.deps.clearDraftIfMatching(target.id, identity)
                if self.activeID == profileID && self.connectionGeneration == generation && self.pendingCreation?.id == target.id {
                    self.pendingCreation = nil
                    self.creationPending = false
                }
            } catch {
                if self.activeID == profileID && self.connectionGeneration == generation {
                    self.notice = error.localizedDescription
                }
            }
        }
    }

    func terminate(_ id: String) async {
        guard connected, !busy, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let current = { self.connectionGeneration == generation && self.activeID == profileID && !self.disconnecting }
        let identity = "cmux:\(profileID):terminate:\(id)"
        busy = true; busyAttachment = nil
        defer { if connectionGeneration == generation && activeID == profileID { busy = false } }
        do {
            let receipt = try await deps.acquireMutation(identity, id)
            guard let mutationID = receipt.pending?.id else { throw DesktopError("Could not record terminal termination request.") }
            guard current(), connected else { return }
            try await deps.closeTerminal(id, mutationID)
            try await deps.clearDraftIfMatching(mutationID, identity)
            guard current() else { return }
            if id == selectedID { inputEnabled = false; directInput = false; attached = false }
            notice = "The server confirmed terminal termination."; await refresh()
        } catch { if current() { notice = "Termination was not confirmed. Refresh the catalog before trying again. \(error.localizedDescription)" } }
    }

    func disconnect() async throws {
        if let activeDisconnectTask {
            try await activeDisconnectTask.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.activeDisconnectTask = nil }
            try await self.performDisconnect()
        }
        activeDisconnectTask = task
        try await task.value
    }

    private func performDisconnect() async throws {
        guard !disconnecting else { return }
        disconnecting = true
        draftEditingLocked = true
        let fencedInput = UUID()
        inputGeneration = fencedInput
        inputFenced = true; inputEnabled = false; directInput = false; queuedInput.removeAll()
        defer {
            disconnecting = false
            draftEditingLocked = false
            if !connected { inputFenced = false }
        }
        saveTask?.cancel(); saveTask = nil
        do {
            try await flushDraft()
        } catch {
            if inputGeneration == fencedInput && selectionToken == nil {
                inputFenced = false
            }
            throw error
        }
        stopPolling()
        saveTask?.cancel(); saveTask = nil
        selectionToken = nil
        connectionGeneration = UUID(); attachmentGeneration = UUID()
        connected = false; connecting = false; attaching = false; sendingRaw = false; busyAttachment = nil
        inputEnabled = false; directInput = false; attached = false; snapshotReady = false; snapshotReceived = false; queuedInput.removeAll()
        outputBuffer?.cancel(); outputBuffer = nil
        try await deps.disconnect()
        connected = false; connecting = false; busy = false; connectionStatus = "Disconnected"
        hasConnected = false; catalogLoaded = false; sending = false; creationReceiptLoaded = false; catalogFreshness.recovered()
        notice = "Connect to inspect your server terminals."
        terminals = []; selectedID = nil; attachedProfileID = ""; pipe.feed(Data(), reset: true)
        draft = DraftRecord(); draftVersion += 1; pendingCreation = nil; creationPending = false
        inputFenced = false
    }

    private func saveRecord(_ record: DraftRecord, identity: String) async throws {
        let previous = saveInFlight
        let task = Task { @MainActor in
            _ = try? await previous?.value
            try await self.deps.saveDraft(record, identity)
        }
        saveInFlight = task
        try await task.value
    }
    private func settlePendingSend(requestID: String, identity: String, recordLastQueued: Bool, followUpErrorPrefix: String) async throws -> Bool {
        let previous = saveInFlight
        var editedDuringSave = false
        let task = Task { @MainActor [weak self] in
            _ = try? await previous?.value
            guard let self, self.draftIdentity == identity, self.draft.pending?.id == requestID else { return }
            let startVersion = self.draftVersion
            var toSave = self.draft
            let pendingText = toSave.pending?.text ?? ""
            if recordLastQueued { toSave.lastQueuedText = pendingText }
            if toSave.text == pendingText { toSave.text = "" }
            toSave.pending = nil
            try await self.deps.saveDraft(toSave, identity)
            guard self.draftIdentity == identity, self.draft.pending?.id == requestID else { return }
            if recordLastQueued { self.draft.lastQueuedText = pendingText }
            editedDuringSave = self.draftVersion != startVersion
            if !editedDuringSave && self.draft.text == pendingText {
                self.draft.text = ""
            }
            self.draft.pending = nil
            self.draftVersion += 1
        }
        saveInFlight = task
        try await task.value
        if editedDuringSave && draftIdentity == identity {
            do {
                try await flushDraft()
            } catch {
                notice = "\(followUpErrorPrefix): \(error.localizedDescription)"
                scheduleAutosave()
                return false
            }
        }
        return true
    }
    private func flushDraft() async throws {
        guard let identity = draftIdentity else { return }
        while true {
            guard draftIdentity == identity else { return }
            let version = draftVersion, previous = saveInFlight
            var wrote = false
            var savedVersion = version
            let task = Task { @MainActor [weak self] in
                _ = try? await previous?.value
                guard let self, self.draftIdentity == identity else { return }
                let currentSnapshot = self.draft
                savedVersion = self.draftVersion
                try await self.deps.saveDraft(currentSnapshot, identity)
                wrote = true
            }
            saveInFlight = task
            try await task.value
            if !wrote || draftIdentity != identity || draftVersion == savedVersion { return }
        }
    }
    private func persistDraft() async throws {
        guard let identity = draftIdentity else { return }
        let snapshot = draft, version = draftVersion
        let previous = saveInFlight
        let task = Task { @MainActor [weak self] in
            _ = try? await previous?.value
            guard let self, self.draftVersion == version, self.draftIdentity == identity else { return }
            try await self.deps.saveDraft(snapshot, identity)
        }
        saveInFlight = task
        try await task.value
    }
    private func persistProfiles() {
        UserDefaults.standard.set(try? JSONEncoder().encode(profiles), forKey: "cmuxProfiles")
        UserDefaults.standard.set(activeID, forKey: "activeCmuxProfile")
    }
    private func savePendingCreation(_ pendingCreation: CmuxPendingCreation?, profileID: String) async throws {
        var record = DraftRecord()
        if let pendingCreation {
            record.pending = PendingSend(id: pendingCreation.id, text: String(decoding: try JSONEncoder().encode(pendingCreation), as: UTF8.self))
        }
        try await deps.saveDraft(record, "cmux:\(profileID):creation")
    }
    private func loadPendingCreation(profileID: String, generation: UUID) async {
        do {
            let record = try await deps.readDraft("cmux:\(profileID):creation")
            guard generation == connectionGeneration, profileID == activeID, !disconnecting else { return }
            pendingCreation = try record.pending.map { try JSONDecoder().decode(CmuxPendingCreation.self, from: Data($0.text.utf8)) }
            creationPending = pendingCreation != nil
            creationReceiptLoaded = true
        } catch {
            guard generation == connectionGeneration, profileID == activeID else { return }
            creationReceiptLoaded = false
            notice = error.localizedDescription
        }
    }
}

final class CmuxOutputBuffer: Sendable {
    private static let maximumBufferedEvents = 512
    private static let maximumBufferedBytes: Int64 = 16 * 1024 * 1024
    private let continuation: AsyncStream<CmuxTerminalOutput>.Continuation
    private let queuedEvents = LockFreeInt64(0)
    private let queuedBytes = LockFreeInt64(0)
    private let overflowed = LockFreeInt64(0)
    private let canceled = LockFreeInt64(0)
    private let consumer: Task<Void, Never>

    init(deliver: @escaping @MainActor @Sendable ([CmuxTerminalOutput]) -> Void) {
        let (stream, continuation) = AsyncStream.makeStream(
            of: CmuxTerminalOutput.self,
            bufferingPolicy: .bufferingOldest(Self.maximumBufferedEvents + 1)
        )
        self.continuation = continuation
        let queuedEvents = self.queuedEvents
        let queuedBytes = self.queuedBytes
        let overflowed = self.overflowed
        let canceled = self.canceled
        self.consumer = Task { @MainActor in
            var batch: [CmuxTerminalOutput] = []
            var batchBytes: Int64 = 0
            var flushTask: Task<Void, Never>?
            var deliveredOverflow = false
            @MainActor func discardBatch() {
                let bytes = batchBytes
                let count = Int64(batch.count)
                batch.removeAll()
                batchBytes = 0
                if bytes > 0 { queuedBytes.sub(bytes) }
                if count > 0 { queuedEvents.sub(count) }
            }
            @MainActor func flushBatch() {
                guard !batch.isEmpty else { return }
                let out = batch
                let bytes = batchBytes
                let count = Int64(out.count)
                batch.removeAll()
                batchBytes = 0
                deliver(out)
                if bytes > 0 { queuedBytes.sub(bytes) }
                if count > 0 { queuedEvents.sub(count) }
            }
            @MainActor func deliverOverflowOnce() {
                guard !deliveredOverflow, !Task.isCancelled, canceled.load() == 0 else { return }
                deliveredOverflow = true
                discardBatch()
                flushTask?.cancel()
                flushTask = nil
                continuation.finish()
                deliver([.invalidFrame])
            }
            defer {
                flushTask?.cancel()
                discardBatch()
            }
            for await event in stream {
                if Task.isCancelled || canceled.load() != 0 {
                    let size = Self.byteSize(of: event)
                    if size > 0 { queuedBytes.sub(size) }
                    queuedEvents.sub(1)
                    break
                }
                if overflowed.load() != 0 {
                    let size = Self.byteSize(of: event)
                    if size > 0 { queuedBytes.sub(size) }
                    queuedEvents.sub(1)
                    deliverOverflowOnce()
                    return
                }
                batch.append(event)
                batchBytes += Self.byteSize(of: event)
                if flushTask == nil {
                    flushTask = Task { @MainActor in
                        await Task.yield()
                        flushTask = nil
                        guard !Task.isCancelled, canceled.load() == 0 else { return }
                        if overflowed.load() != 0 {
                            deliverOverflowOnce()
                            return
                        }
                        flushBatch()
                    }
                }
            }
            if Task.isCancelled || canceled.load() != 0 { return }
            flushTask?.cancel()
            flushTask = nil
            if overflowed.load() != 0 {
                deliverOverflowOnce()
            } else {
                flushBatch()
            }
        }
    }

    func append(_ event: CmuxTerminalOutput) {
        guard canceled.load() == 0, overflowed.load() == 0 else { return }
        let size = Self.byteSize(of: event)
        if queuedEvents.add(1) > Int64(Self.maximumBufferedEvents) {
            queuedEvents.sub(1)
            overflowed.store(1)
            continuation.finish()
            return
        }
        if queuedBytes.add(size) > Self.maximumBufferedBytes {
            queuedBytes.sub(size)
            queuedEvents.sub(1)
            overflowed.store(1)
            continuation.finish()
            return
        }
        if case .dropped = continuation.yield(event) {
            queuedBytes.sub(size)
            queuedEvents.sub(1)
            overflowed.store(1)
            continuation.finish()
        }
    }

    func cancel() {
        canceled.store(1)
        continuation.finish()
        consumer.cancel()
    }

    deinit {
        canceled.store(1)
        continuation.finish()
        consumer.cancel()
    }

    private static func byteSize(of event: CmuxTerminalOutput) -> Int64 {
        switch event {
        case .snapshot(let bytes, _, _), .bytes(let bytes): return Int64(bytes.count)
        default: return 0
        }
    }
}
