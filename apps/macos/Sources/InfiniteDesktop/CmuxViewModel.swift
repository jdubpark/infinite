import SwiftUI
import InfiniteCore

@MainActor final class CmuxViewModel: ObservableObject {
    @Published var profiles: [CmuxHostProfile] = []
    @Published var activeID = "" {
        didSet {
            if activeID != oldValue {
                connectionGeneration = UUID()
                creationReceiptLoaded = false
                creationState = .idle
            }
        }
    }
    @Published private(set) var connectionPhase: CmuxConnectionPhase = .disconnected
    @Published private(set) var displayVisible = false
    @Published private(set) var attachmentState: CmuxAttachmentState = .none
    @Published private(set) var operation: CmuxOperation = .idle
    @Published private(set) var draftEditingLocked = false
    @Published private(set) var inputFenced = false
    @Published var notice = "Connect an enrolled cmux server to open its real terminals."
    @Published var terminals: [CmuxTerminalRow] = []
    @Published var lastSeen: Date?
    @Published var draft = DraftRecord()
    @Published private(set) var creationState: CmuxCreationState = .idle
    @Published private(set) var creationReceiptLoaded = false
    @Published private(set) var fallbackRendererGeneration = UUID()
    @Published private(set) var catalogDisplayStale = false
    @Published private(set) var catalogLoaded = false

    var connected: Bool { connectionPhase.isConnected }
    var connecting: Bool { connectionPhase.isConnecting }
    var disconnecting: Bool { connectionPhase.isDisconnecting }
    var hasConnected: Bool { connectionPhase.hasConnected }
    var connectionStatus: String { connectionPhase.statusText }
    var attached: Bool { attachmentState.isAttached }
    var attaching: Bool {
        if case .attaching = operation { return true }
        return attachmentState.isAttaching
    }
    var busy: Bool { operation != .idle }
    var sending: Bool { if case .sending = operation { return true }; return false }
    var inputEnabled: Bool { attachmentState.inputMode != .disabled }
    var directInput: Bool {
        get { attachmentState.inputMode == .directKeys }
        set { setDirectInput(newValue) }
    }
    var selectedID: String? { attachmentState.selectedID }
    var snapshotReady: Bool { attachmentState.snapshotReady }
    var rendererGeneration: UUID { attachmentState.rendererGeneration ?? fallbackRendererGeneration }
    var creationPending: Bool { creationState.isVisiblePending }

    let pipe = TerminalPipe()
    private let deps: CmuxViewModelDependencies
    private var poll: Task<Void, Never>?
    private var displayGeneration = UUID()
    private var pollGeneration = UUID()
    private var saveTask: Task<Void, Never>?
    private var saveInFlight: Task<Void, Error>?
    private var draftVersion = 0
    private var connectionGeneration = UUID()
    private var inputGeneration = UUID()
    private var activeDisconnectTask: Task<Void, Error>?
    private var clearingPending = false
    private var lastSize = (80, 24)
    private var queuedInput = Data()
    private var rawDrainGeneration: UUID?
    private var selectionToken: UUID?
    private lazy var catalogFreshness = DisplayFreshness { [weak self] in self?.catalogDisplayStale = $0 }
    var active: CmuxHostProfile? { profiles.first { $0.id == activeID } }
    var selected: CmuxTerminalRow? { terminals.first { $0.id == selectedID } }
    var rendererVisible: Bool { displayVisible && attached }
    var canSend: Bool { connected && attached && snapshotReady && inputEnabled && !directInput && !busy && !inputFenced && !disconnecting && draft.pending == nil && !draft.text.isEmpty }
    private var draftIdentity: String? {
        guard let selectedID else { return nil }
        return "cmux:\(attachmentState.attachedProfileID):\(selectedID)"
    }

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
        creationReceiptLoaded = false; creationState = .idle
        let initialStatus = invitation.isEmpty ? "Authenticating saved identity…" : "Waiting for server enrollment approval…"
        connectionGeneration = UUID(); let generation = connectionGeneration
        connectionPhase = .connecting(generation: generation, statusText: initialStatus)
        notice = invitation.isEmpty ? "Authenticating the pinned cmux server." : "Approve this device on your server. The invitation stays in memory."
        let helper = deps.helperURL()
        do {
            let token = invitation.trimmingCharacters(in: .whitespacesAndNewlines)
            try await deps.connect(profile.id, profile.route, helper, token.isEmpty ? nil : token) { [weak self] event in
                Task { @MainActor in
                    guard let self, self.connectionGeneration == generation else { return }
                    let state = event["connection"]["state"].string
                    if !state.isEmpty {
                        let status = state == "connected" ? "Noise encrypted · enrolled device" : state.capitalized
                        switch self.connectionPhase {
                        case .connecting(generation, _):
                            self.connectionPhase = .connecting(generation: generation, statusText: status)
                        case .connected(generation, _, let reachable):
                            self.connectionPhase = .connected(generation: generation, statusText: status, reachable: reachable)
                        default:
                            break
                        }
                    }
                    if state != "connected" { self.invalidateInput() }
                }
            }
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            await loadPendingCreation(profileID: profile.id, generation: generation)
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            connectionPhase = .connected(generation: generation, statusText: "Noise encrypted · enrolled device", reachable: true)
            persistProfiles()
            await refresh()
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            if let id = terminals.first?.id { await select(id) }
            guard generation == connectionGeneration, profile.id == activeID, !disconnecting else { return }
            startPolling()
        } catch {
            guard generation == connectionGeneration else { return }
            connectionPhase = .disconnected
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
            if let phaseGen = connectionPhase.generation {
                connectionPhase = .connected(generation: phaseGen, statusText: connectionPhase.statusText, reachable: true)
            }
            lastSeen = Date(); catalogLoaded = true
            catalogFreshness.recovered()
            if let selectedID, !terminals.contains(where: { $0.id == selectedID && $0.running }) { invalidateInput() }
        } catch {
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if case .connected(let gen, let status, _) = connectionPhase {
                connectionPhase = .connected(generation: gen, statusText: status, reachable: false)
            }
            invalidateInput()
            catalogFreshness.failed()
        }
    }

    func select(_ id: String) async {
        guard connected, !busy, !connecting, !disconnecting else { return }
        let connection = connectionGeneration, profileID = activeID, priorAttachment = attachmentState.generation
        let token = UUID()
        selectionToken = token
        let fencedInput = UUID()
        inputGeneration = fencedInput
        inputFenced = true
        disableInput()
        saveTask?.cancel(); saveTask = nil
        operation = .attaching(token)
        defer {
            if selectionToken == token {
                selectionToken = nil
                if case .attaching(token) = operation { operation = .idle }
                if !disconnecting {
                    draftEditingLocked = false
                    inputFenced = false
                }
            }
        }
        do { try await flushDraft() } catch {
            if connectionGeneration == connection && attachmentState.generation == priorAttachment && inputGeneration == fencedInput && !disconnecting {
                inputFenced = false
                notice = error.localizedDescription
            }
            return
        }
        guard connection == connectionGeneration, attachmentState.generation == priorAttachment, profileID == activeID, !disconnecting, selectionToken == token else { return }
        draftEditingLocked = true
        saveTask?.cancel(); saveTask = nil
        disableInput()
        rawDrainGeneration = nil
        attachmentState.buffer?.cancel()
        fallbackRendererGeneration = UUID()
        attachmentState = .none
        await deps.detach()
        guard connection == connectionGeneration, operation == .attaching(token), profileID == activeID, !disconnecting, selectionToken == token else { return }
        draft = DraftRecord(); draftVersion += 1
        pipe.feed(Data(), reset: true)
        let identity = "cmux:\(profileID):\(id)"
        let loaded: DraftRecord
        do {
            let read = try await deps.readDraft(identity)
            guard connection == connectionGeneration, operation == .attaching(token), profileID == activeID, !disconnecting, selectionToken == token else { return }
            loaded = read
        } catch { notice = error.localizedDescription; return }
        let rendererGen = UUID()
        let buffer = CmuxOutputBuffer { [weak self] events in
            guard let self, self.attachmentState.generation == token else { return }
            for event in events {
                guard self.attachmentState.generation == token else { break }
                self.receive(event)
            }
        }
        attachmentState = .attaching(
            id: id,
            profileID: profileID,
            generation: token,
            rendererGeneration: rendererGen,
            buffer: buffer,
            snapshotReceived: false,
            snapshotReady: false
        )
        draft = loaded; draftVersion += 1
        draftEditingLocked = false
        inputFenced = false
        do {
            try await deps.attach(id) { buffer.append($0) }
            guard case .attaching(let attachedID, let attachedProfile, token, let attachedRenderer, let attachedBuffer, let snapshotReceived, let snapshotReady) = attachmentState else { return }
            attachmentState = .attached(
                id: attachedID,
                profileID: attachedProfile,
                generation: token,
                rendererGeneration: attachedRenderer,
                buffer: attachedBuffer,
                snapshotReceived: snapshotReceived,
                snapshotReady: snapshotReady,
                input: .disabled
            )
            notice = draft.pending == nil ? "Draft locally. Enable input when you are ready to send." : "A previous input has no delivery receipt. Inspect the terminal before clearing it."
        } catch {
            buffer.cancel()
            if attachmentState.generation == token {
                attachmentState = .detached(id: id, profileID: profileID, rendererGeneration: rendererGen)
                notice = error.localizedDescription
            }
        }
    }

    private func receive(_ event: CmuxTerminalOutput) {
        switch event {
        case .snapshot(let bytes, let columns, let rows):
            switch attachmentState {
            case .attaching(let id, let profileID, let generation, let rendererGen, let buffer, _, _):
                attachmentState = .attaching(id: id, profileID: profileID, generation: generation, rendererGeneration: rendererGen, buffer: buffer, snapshotReceived: true, snapshotReady: false)
            case .attached(let id, let profileID, let generation, let rendererGen, let buffer, _, _, let input):
                attachmentState = .attached(id: id, profileID: profileID, generation: generation, rendererGeneration: rendererGen, buffer: buffer, snapshotReceived: true, snapshotReady: false, input: input)
            case .none, .detached:
                break
            }
            pipe.feed(bytes, reset: true, columns: columns, rows: rows)
        case .bytes(let bytes):
            pipe.feed(bytes)
        case .resized:
            break
        case .exited:
            switch attachmentState {
            case .attaching(let id, let profileID, _, let rendererGen, let buffer, _, _),
                 .attached(let id, let profileID, _, let rendererGen, let buffer, _, _, _):
                buffer.cancel()
                attachmentState = .detached(id: id, profileID: profileID, rendererGeneration: rendererGen)
            case .none, .detached:
                break
            }
            queuedInput.removeAll(); rawDrainGeneration = nil
            notice = "The terminal stream ended. Refresh the catalog to inspect its state."
        case .invalidFrame:
            rendererFailed("Terminal output exceeded the client limit or was invalid. Reattach to load a fresh snapshot.")
        }
    }

    func rendererFailed(_ message: String) {
        let currentGen = attachmentState.generation
        switch attachmentState {
        case .attaching(let id, let profileID, _, let rendererGen, let buffer, _, _),
             .attached(let id, let profileID, _, let rendererGen, let buffer, _, _, _):
            buffer.cancel()
            attachmentState = .detached(id: id, profileID: profileID, rendererGeneration: rendererGen)
        case .none, .detached:
            break
        }
        selectionToken = nil
        if !disconnecting {
            draftEditingLocked = false
            inputFenced = false
        }
        if let currentGen, operation == .attaching(currentGen) || operation == .sending(currentGen) {
            operation = .idle
        } else if case .attaching = operation {
            operation = .idle
        }
        rawDrainGeneration = nil; queuedInput.removeAll()
        notice = message
        Task {
            guard attachmentState.generation == nil else { return }
            await deps.detach()
        }
    }

    func rendererRestored(_ generation: UUID) {
        switch attachmentState {
        case .attaching(let id, let profileID, let attachGen, generation, let buffer, true, _):
            attachmentState = .attaching(id: id, profileID: profileID, generation: attachGen, rendererGeneration: generation, buffer: buffer, snapshotReceived: true, snapshotReady: true)
        case .attached(let id, let profileID, let attachGen, generation, let buffer, true, _, let input):
            attachmentState = .attached(id: id, profileID: profileID, generation: attachGen, rendererGeneration: generation, buffer: buffer, snapshotReceived: true, snapshotReady: true, input: input)
        default:
            break
        }
    }

    func setInputEnabled(_ value: Bool) {
        if value,
           case .attached(let id, let profileID, let generation, let rendererGen, let buffer, let snapshotReceived, true, _) = attachmentState,
           connected, !busy, !inputFenced, !disconnecting {
            attachmentState = .attached(id: id, profileID: profileID, generation: generation, rendererGeneration: rendererGen, buffer: buffer, snapshotReceived: snapshotReceived, snapshotReady: true, input: .promptOnly)
            notice = "Input enabled here. Other enrolled clients can also type. Enter sends; Shift-Enter adds a line."
            Task { await resize(lastSize.0, lastSize.1) }
        } else {
            invalidateInput()
            notice = "Input disabled. Your draft stays local."
        }
    }

    func setDirectInput(_ enabled: Bool) {
        if !enabled {
            queuedInput.removeAll()
            if case .attached(let id, let profileID, let generation, let rendererGen, let buffer, let snapshotReceived, let ready, let input) = attachmentState,
               input != .disabled {
                attachmentState = .attached(id: id, profileID: profileID, generation: generation, rendererGeneration: rendererGen, buffer: buffer, snapshotReceived: snapshotReceived, snapshotReady: ready, input: .promptOnly)
            }
            return
        }
        guard case .attached(let id, let profileID, let generation, let rendererGen, let buffer, let snapshotReceived, let ready, let input) = attachmentState,
              input != .disabled, !inputFenced, !disconnecting else { return }
        attachmentState = .attached(id: id, profileID: profileID, generation: generation, rendererGeneration: rendererGen, buffer: buffer, snapshotReceived: snapshotReceived, snapshotReady: ready, input: .directKeys)
    }

    private func invalidateInput() {
        inputGeneration = UUID()
        disableInput()
    }

    private func disableInput() {
        queuedInput.removeAll()
        if case .attached(let id, let profileID, let generation, let rendererGen, let buffer, let snapshotReceived, let ready, _) = attachmentState {
            attachmentState = .attached(id: id, profileID: profileID, generation: generation, rendererGeneration: rendererGen, buffer: buffer, snapshotReceived: snapshotReceived, snapshotReady: ready, input: .disabled)
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
        guard canSend, let identity = draftIdentity, let terminalID = selectedID,
              let attachment = attachmentState.generation else { return }
        guard draft.text.utf8.count <= 32 * 1024 else { notice = "Send at most 32 KiB in one prompt."; return }
        saveTask?.cancel(); saveTask = nil
        let connection = connectionGeneration, input = inputGeneration, profileID = attachmentState.attachedProfileID
        let sendToken = UUID()
        let current = { self.connectionGeneration == connection && self.attachmentState.generation == attachment && self.inputGeneration == input && !self.inputFenced && !self.disconnecting && self.attachmentState.attachedProfileID == profileID && self.selectedID == terminalID && self.draftIdentity == identity }
        operation = .sending(sendToken)
        defer { if self.operation == .sending(sendToken) { self.operation = .idle } }
        let requestID = UUID().uuidString, text = draft.text, previousPending = draft.pending
        draft.pending = PendingSend(id: requestID, text: text); draftVersion += 1
        do { try await saveRecord(draft, identity: identity) }
        catch {
            if current() && draft.pending?.id == requestID { draft.pending = previousPending; draftVersion += 1 }
            notice = error.localizedDescription; return
        }
        guard current(), !disconnecting, connected, attached, snapshotReady, inputEnabled, !directInput else {
            if attachmentState.attachedProfileID == profileID && selectedID == terminalID && draftIdentity == identity && draft.pending?.id == requestID {
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
        } catch {
            if current() {
                invalidateInput()
                notice = "Input outcome is uncertain. \(error.localizedDescription)"
            }
        }
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
        guard inputEnabled, directInput, attached, snapshotReady, connected, !inputFenced, !disconnecting,
              let generation = attachmentState.generation else { return }
        let bytes = Data(text.utf8)
        guard queuedInput.count + bytes.count <= 32 * 1024 else {
            invalidateInput()
            notice = "Input queue is full. Inspect the terminal before enabling input again."; return
        }
        queuedInput.append(bytes)
        let input = inputGeneration
        guard rawDrainGeneration != input else { return }
        rawDrainGeneration = input
        Task {
            defer { if rawDrainGeneration == input { rawDrainGeneration = nil } }
            while !queuedInput.isEmpty && inputEnabled && directInput && attachmentState.generation == generation && inputGeneration == input && !inputFenced && !disconnecting {
                let bytes = queuedInput; queuedInput.removeAll()
                do {
                    guard inputGeneration == input, !inputFenced, !disconnecting else { return }
                    _ = try await deps.send(bytes)
                } catch {
                    if rawDrainGeneration == input && attachmentState.generation == generation && inputGeneration == input {
                        invalidateInput()
                        notice = "Input was not confirmed. \(error.localizedDescription)"
                    }
                    return
                }
            }
        }
    }

    func resize(_ columns: Int, _ rows: Int) async {
        lastSize = (columns, rows)
        guard inputEnabled, attached, let generation = attachmentState.generation else { return }
        do { try await deps.resize(columns, rows) }
        catch { if attachmentState.generation == generation { notice = error.localizedDescription } }
    }

    func create(provider: String, cwd: String, name: String) async {
        guard connected, creationReceiptLoaded, !busy, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let current = { self.connectionGeneration == generation && self.activeID == profileID && !self.disconnecting }
        if creationState == .idle {
            operation = .mutating
            let argv = provider == "claude" ? ["claude"] : provider == "codex" ? ["codex"] : ["/bin/bash", "-l"]
            let created = CmuxPendingCreation(id: UUID().uuidString, argv: argv, cwd: cwd, name: name.isEmpty ? provider.capitalized : name)
            creationState = .pending(created)
            do { try await savePendingCreation(created, profileID: profileID) }
            catch {
                if connectionGeneration == generation && activeID == profileID {
                    if creationState.pending?.id == created.id { creationState = .idle }
                    if operation == .mutating { operation = .idle }
                }
                if current() { notice = error.localizedDescription }
                return
            }
            if connectionGeneration == generation && activeID == profileID && operation == .mutating { operation = .idle }
        }
        guard current(), connected else { return }
        await retryCreation()
    }

    func retryCreation() async {
        guard case .pending(let pendingCreation) = creationState,
              connected, creationReceiptLoaded, !busy, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let identity = "cmux:\(profileID):creation"
        let current = { self.connectionGeneration == generation && self.activeID == profileID && !self.disconnecting }
        operation = .mutating
        defer { if connectionGeneration == generation && activeID == profileID && operation == .mutating { operation = .idle } }
        do {
            try await savePendingCreation(pendingCreation, profileID: profileID)
            guard current(), connected, creationState.pending?.id == pendingCreation.id else { return }
            let terminalID = try await deps.createTerminal(pendingCreation.argv, pendingCreation.cwd, pendingCreation.name, pendingCreation.id)
            try await deps.clearDraftIfMatching(pendingCreation.id, identity)
            guard current(), creationState.pending?.id == pendingCreation.id else { return }
            creationState = .idle
            operation = .idle
            await refresh()
            guard current() else { return }
            await select(terminalID)
        } catch { if current() { notice = "Creation was not confirmed. Inspect the catalog; retry uses the same mutation identity. \(error.localizedDescription)" } }
    }

    func clearCreationAfterReview() {
        guard !busy, creationReceiptLoaded, case .pending(let previous) = creationState else { return }
        let profileID = activeID, generation = connectionGeneration
        let identity = "cmux:\(profileID):creation"
        creationState = .clearing(previous: previous)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.deps.clearDraftIfMatching(previous.id, identity)
                if self.activeID == profileID && self.connectionGeneration == generation, case .clearing = self.creationState {
                    self.creationState = .idle
                }
            } catch {
                if self.activeID == profileID && self.connectionGeneration == generation, case .clearing(let saved) = self.creationState {
                    self.creationState = .pending(saved)
                    self.notice = error.localizedDescription
                }
            }
        }
    }

    func terminate(_ id: String) async {
        guard connected, !busy, !disconnecting else { return }
        let generation = connectionGeneration, profileID = activeID
        let current = { self.connectionPhase.generation == generation || self.connectionGeneration == generation }
        let stillActive = { current() && self.activeID == profileID && !self.disconnecting }
        let identity = "cmux:\(profileID):terminate:\(id)"
        operation = .mutating
        defer { if connectionGeneration == generation && activeID == profileID && operation == .mutating { operation = .idle } }
        do {
            let receipt = try await deps.acquireMutation(identity, id)
            guard let mutationID = receipt.pending?.id else { throw DesktopError("Could not record terminal termination request.") }
            guard stillActive(), connected else { return }
            try await deps.closeTerminal(id, mutationID)
            try await deps.clearDraftIfMatching(mutationID, identity)
            guard stillActive() else { return }
            if id == selectedID {
                invalidateInput()
                switch attachmentState {
                case .attaching(let attachedID, let attachedProfile, _, let rendererGen, let buffer, _, _),
                     .attached(let attachedID, let attachedProfile, _, let rendererGen, let buffer, _, _, _):
                    buffer.cancel()
                    attachmentState = .detached(id: attachedID, profileID: attachedProfile, rendererGeneration: rendererGen)
                case .none, .detached:
                    break
                }
            }
            notice = "The server confirmed terminal termination."; await refresh()
        } catch { if stillActive() { notice = "Termination was not confirmed. Refresh the catalog before trying again. \(error.localizedDescription)" } }
    }

    func disconnect() async throws {
        if let activeDisconnectTask {
            try await activeDisconnectTask.value
            return
        }
        let fencedInput = UUID()
        let previousPhase = connectionPhase
        connectionPhase = .disconnecting
        draftEditingLocked = true
        inputGeneration = fencedInput
        inputFenced = true
        disableInput()
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.activeDisconnectTask = nil }
            try await self.performDisconnect(previousPhase: previousPhase, fencedInput: fencedInput)
        }
        activeDisconnectTask = task
        try await task.value
    }

    private func performDisconnect(previousPhase: CmuxConnectionPhase, fencedInput: UUID) async throws {
        var teardownStarted = false
        defer {
            if case .disconnecting = connectionPhase {
                connectionPhase = teardownStarted ? .disconnected : previousPhase
            }
            if selectionToken == nil {
                draftEditingLocked = false
                if !connected { inputFenced = false }
            }
        }
        saveTask?.cancel(); saveTask = nil
        do {
            try await flushDraft()
        } catch {
            connectionPhase = previousPhase
            if inputGeneration == fencedInput && selectionToken == nil {
                inputFenced = false
            }
            throw error
        }
        teardownStarted = true
        stopPolling()
        saveTask?.cancel(); saveTask = nil
        selectionToken = nil
        connectionGeneration = UUID()
        operation = .idle
        rawDrainGeneration = nil; queuedInput.removeAll()
        attachmentState.buffer?.cancel()
        fallbackRendererGeneration = UUID()
        attachmentState = .none
        do {
            try await deps.disconnect()
        } catch {
            connectionPhase = .disconnected
            catalogLoaded = false; creationReceiptLoaded = false; catalogFreshness.recovered()
            notice = error.localizedDescription
            terminals = []; pipe.feed(Data(), reset: true)
            draft = DraftRecord(); draftVersion += 1; creationState = .idle
            draftEditingLocked = false
            inputFenced = false
            throw error
        }
        connectionPhase = .disconnected
        catalogLoaded = false; creationReceiptLoaded = false; catalogFreshness.recovered()
        notice = "Connect to inspect your server terminals."
        terminals = []; pipe.feed(Data(), reset: true)
        draft = DraftRecord(); draftVersion += 1; creationState = .idle
        draftEditingLocked = false
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
            if let decoded = try record.pending.map({ try JSONDecoder().decode(CmuxPendingCreation.self, from: Data($0.text.utf8)) }) {
                creationState = .pending(decoded)
            } else {
                creationState = .idle
            }
            creationReceiptLoaded = true
        } catch {
            guard generation == connectionGeneration, profileID == activeID else { return }
            creationReceiptLoaded = false
            notice = error.localizedDescription
        }
    }
}
