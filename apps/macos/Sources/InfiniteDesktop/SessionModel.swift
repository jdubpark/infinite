import SwiftUI
import InfiniteCore

@MainActor final class SessionModel: ObservableObject {
    enum StreamState: Equatable {
        case detached
        case attaching(generation: UUID)
        case attached(streamID: String, generation: UUID)

        var streamID: String? {
            if case .attached(let id, _) = self { return id }
            return nil
        }
        var generation: UUID? {
            switch self {
            case .detached: return nil
            case .attaching(let g), .attached(_, let g): return g
            }
        }
        var isAttached: Bool {
            if case .attached = self { return true }
            return false
        }
        var isAttaching: Bool {
            if case .attaching = self { return true }
            return false
        }
    }

    enum RendererState: Equatable {
        case awaitingSnapshot(generation: UUID)
        case snapshotReceived(generation: UUID)
        case ready(generation: UUID)
        case failed(generation: UUID, receivedScreen: Bool)

        var generation: UUID {
            switch self {
            case .awaitingSnapshot(let g), .snapshotReceived(let g), .ready(let g), .failed(let g, _): return g
            }
        }
        var snapshotReady: Bool {
            switch self {
            case .snapshotReceived, .ready: return true
            case .awaitingSnapshot, .failed: return false
            }
        }
        var receivedScreen: Bool {
            switch self {
            case .awaitingSnapshot: return false
            case .snapshotReceived, .ready: return true
            case .failed(_, let received): return received
            }
        }
        var isReady: Bool {
            if case .ready = self { return true }
            return false
        }
    }

    enum ControlState {
        case unheld(otherHolder: String)
        case claiming(generation: UUID, otherHolder: String)
        case held(lease: JSON, generation: UUID, renewal: Task<Void, Never>?, directInput: Bool)
    }

    @Published var session: AgentSession
    @Published var draft = DraftRecord()
    @Published var notice = ""
    @Published var streamState: StreamState = .detached
    @Published var sending = false
    @Published private(set) var controlState: ControlState = .unheld(otherHolder: "")
    @Published private(set) var rendererState: RendererState = .awaitingSnapshot(generation: UUID())
    @Published var view: SessionViewMode = .chat
    @Published private(set) var screenShown = false
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var messageSource = ""
    @Published private(set) var chatNote = "Loading the conversation…"
    @Published private(set) var unread = 0
    @Published private(set) var summary: ChatSummary?
    @Published private(set) var summaryBusy = false
    @Published private(set) var summaryError = ""
    @Published private(set) var answering = false

    var attached: Bool {
        get { streamState.isAttached }
        set {
            if newValue {
                if !streamState.isAttached {
                    streamState = .attached(streamID: streamState.streamID ?? "stream", generation: streamState.generation ?? UUID())
                }
            } else {
                streamState = .detached
            }
        }
    }
    var busy: Bool { streamState.isAttaching || sending }
    var rendererUnavailable: Bool { !rendererState.isReady }
    var rendererGeneration: UUID { rendererState.generation }
    var lease: JSON {
        get {
            if case .held(let lease, _, _, _) = controlState { return lease }
            return .null
        }
        set {
            if newValue == .null {
                releaseControlState(otherHolder: currentOtherHolder)
            } else if case .held(_, let generation, let renewal, let direct) = controlState {
                controlState = .held(lease: newValue, generation: generation, renewal: renewal, directInput: direct)
            } else {
                controlState = .held(lease: newValue, generation: controlGeneration, renewal: nil, directInput: false)
            }
        }
    }
    var directInput: Bool {
        if case .held(_, _, _, let direct) = controlState { return direct }
        return false
    }
    var holder: String {
        switch controlState {
        case .unheld(let name), .claiming(_, let name): return name
        case .held(let lease, _, _, _): return lease["label"].string
        }
    }

    let summaryModel: String?
    private var messagesCursor = ""
    private var chatTask: Task<Void, Never>?
    private var chatGeneration = UUID()
    private var displayVisible = false
    private var readCursor: String
    private static let readCursorsKey = "readCursors"
    let pipe = TerminalPipe()
    let client: RemoteClient
    let deps: SessionModelDependencies
    let profileID: String
    let role: String
    let supportsStream: Bool
    var controlGeneration = UUID() {
        didSet {
            if case .held(let currentLease, _, let renewal, let direct) = controlState {
                controlState = .held(lease: currentLease, generation: controlGeneration, renewal: renewal, directInput: direct)
            }
        }
    }
    var saveTask: Task<Void, Never>?
    var saveInFlight: Task<Void, Never>?
    var draftLoadTask: Task<Void, Never>?
    var activeSendToken: UUID?
    var draftVersion = 0
    @Published var draftLoaded = false
    @Published var draftLoadError: String?
    @Published var clearingPending = false
    var draftTouched = false
    private var queuedRaw = Data()
    private var sendingRaw = false
    private var lastSize = (80, 24)
    private var awaitingOpenCatchUp = false
    private var pendingStreamReplay = false
    var observing = false
    var identity: String { "\(profileID):\(session.id)" }
    var hasControl: Bool {
        guard case .held(let lease, _, _, _) = controlState, streamState.isAttached else { return false }
        return !lease["id"].string.isEmpty && (lease["expiresAt"].number ?? 0) > Date().timeIntervalSince1970 * 1000
    }
    var canUseTerminal: Bool { hasControl && rendererState.isReady }
    var ready: Bool { streamState.isAttached && session.running }
    var screenReady: Bool { ready && rendererState.isReady }
    var canSend: Bool { ready && !busy && draftLoaded && draft.pending == nil && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var canAnswerPrompt: Bool { role != "viewer" && !answering && (managed ? session.running : ready) }
    var managed: Bool { session.managed }
    var terminalOpen: Bool { session.terminalOpen }
    var prompt: JSON? { let value = session.value["attention"]["prompt"]; return value == .null ? nil : value }
    var otherHolder: String? {
        switch controlState {
        case .unheld(let name), .claiming(_, let name): return name.isEmpty ? nil : name
        case .held: return nil
        }
    }
    private var currentOtherHolder: String { otherHolder ?? "" }

    init(session: AgentSession, client: RemoteClient, profileID: String, role: String, supportsStream: Bool, summaryModel: String? = nil, deps: SessionModelDependencies = .live) {
        self.session = session; self.client = client; self.profileID = profileID; self.role = role; self.supportsStream = supportsStream; self.summaryModel = summaryModel; self.deps = deps
        readCursor = (UserDefaults.standard.dictionary(forKey: Self.readCursorsKey) as? [String: String])?["\(profileID):\(session.id)"] ?? ""
        draftLoadTask = Task { @MainActor [weak self] in await self?.loadInitialDraft() }
    }
    func showScreen() { screenShown = true; view = .screen }
    func setDisplayVisible(_ visible: Bool) { guard displayVisible != visible else { return }; displayVisible = visible; if visible, observing { startChat() } else { stopChat() } }

    private func startChat() {
        guard displayVisible, observing else { return }
        chatTask?.cancel()
        chatGeneration = UUID(); let generation = chatGeneration
        chatTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.displayVisible, self.observing, generation == self.chatGeneration else { break }
                await self.pollChat(generation)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            guard let self, generation == self.chatGeneration else { return }
            self.chatTask = nil
        }
    }
    private func stopChat() { chatTask?.cancel(); chatTask = nil; chatGeneration = UUID() }
    private func pollChat(_ generation: UUID) async {
        guard generation == chatGeneration, displayVisible, observing else { return }
        var pages = 0, more = false
        repeat {
            guard generation == chatGeneration, displayVisible, observing else { return }
            let query = messagesCursor.isEmpty ? "" : "&after=\(messagesCursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? messagesCursor)"
            let page: JSON
            do { page = try await deps.sendRequest(client, "/sessions/\(session.id)/messages?limit=100\(query)", nil, nil) }
            catch { if generation == chatGeneration, messages.isEmpty { chatNote = error.localizedDescription }; return }
            guard generation == chatGeneration else { return }
            let incoming = page["messages"].array.map(ChatMessage.init)
            if !incoming.isEmpty {
                var next = messages
                let known = Set(next.map(\.id))
                for message in incoming where !known.contains(message.id) { next.append(message) }
                if next.count > 600 { next.removeFirst(next.count - 600) }
                if next != messages { messages = next }
            }
            messagesCursor = page["cursor"].string
            if messageSource != page["source"].string { messageSource = page["source"].string }
            let note = messages.isEmpty ? (messageSource == "transcript" ? "No messages yet." : "No chat is recorded for this session yet. Open Screen for its output.") : ""
            if note != chatNote { chatNote = note }
            if !readCursor.isEmpty, let read = Int(readCursor) {
                let count = messages.filter { $0.seq > read }.count
                if count != unread { unread = count }
            }
            pages += 1
            more = page["more"].bool
        } while more && pages < 10
    }
    func markRead() {
        guard !messagesCursor.isEmpty else { return }
        readCursor = messagesCursor; unread = 0; summary = nil
        var cursors = (UserDefaults.standard.dictionary(forKey: Self.readCursorsKey) as? [String: String]) ?? [:]
        cursors["\(profileID):\(session.id)"] = messagesCursor
        if cursors.count > 200 { cursors = Dictionary(uniqueKeysWithValues: Array(cursors).suffix(150)) }
        UserDefaults.standard.set(cursors, forKey: Self.readCursorsKey)
    }
    func catchUp() async {
        guard summaryModel != nil, !summaryBusy else { return }
        summaryBusy = true; summaryError = ""
        let after = readCursor.isEmpty ? "" : "?after=\(readCursor)"
        do {
            let value = try await deps.sendRequest(client, "/sessions/\(session.id)/summary\(after)", nil, nil)
            summary = ChatSummary(model: value["model"].string, text: value["text"].string, messages: value["messages"].int)
        } catch { summaryError = error.localizedDescription }
        summaryBusy = false
    }
    func dismissSummary() { summary = nil; summaryError = "" }
    func answer(option: Int? = nil, text: String? = nil) async {
        guard let prompt, !answering else { return }
        if !managed { guard await ensureControl() else { return } }
        answering = true
        var body: [String: JSON] = ["requestId": .string(UUID().uuidString.lowercased()), "promptId": .number(Double(prompt["id"].int))]
        if let option { body["option"] = .number(Double(option)) }
        if let text, !text.isEmpty { body["text"] = .string(text) }
        do {
            let receipt = try await deps.sendRequest(client, "/sessions/\(session.id)/answer", .object(body), managed ? nil : lease["id"].string)
            let result = receipt["result"].string
            notice = result == "closed" ? "Answer delivered; the dialog closed." : result == "changed" ? "The dialog changed before the answer; check it again." : "Answer delivered; the dialog is still open. Check the screen."
        } catch { notice = error.localizedDescription }
        answering = false
    }
    func rendererFailed(_ message: String) {
        rendererState = .failed(generation: rendererState.generation, receivedScreen: rendererState.receivedScreen)
        disableDirectInput()
        notice = message
    }
    func rendererRestored(_ generation: UUID) {
        guard case .snapshotReceived(generation) = rendererState else { return }
        rendererState = .ready(generation: generation)
    }
    func attach() async {
        observing = true
        if chatTask == nil, displayVisible { startChat() }
        guard streamState == .detached, !sending else { return }
        guard supportsStream && session.backend != "cmux" else { notice = "This host does not provide a live byte stream for this session. Update the host or use the cmux connection."; return }
        let current = UUID()
        streamState = .attaching(generation: current)
        rendererState = .awaitingSnapshot(generation: UUID())
        queuedRaw = Data(); sendingRaw = false
        awaitingOpenCatchUp = false; pendingStreamReplay = false
        pipe.feed(Data(), reset: true)
        do {
            let id = try await deps.openTerminal(client, session.id) { [weak self] message in
                Task { @MainActor in guard let self, self.streamState.generation == current else { return }; self.receive(message) }
            }
            guard streamState == .attaching(generation: current) else { await deps.closeTerminal(client, id); return }
            streamState = .attached(streamID: id, generation: current)
            if draft.pending == nil { notice = "" }
        } catch {
            if streamState == .attaching(generation: current) { streamState = .detached }
            notice = error.localizedDescription
        }
    }
    private static func eventDimensions(_ event: JSON) -> TerminalDimensions? {
        let type = event["type"].string
        guard type == "lifecycle" || type == "output" else { return nil }
        let data = event["data"]
        return TerminalDimensions(json: data) ?? TerminalDimensions(json: data["terminalSize"])
    }
    func receive(_ event: JSON) {
        if event["type"].string == "terminal-closed" {
            connectionLost()
            notice = session.status == "running"
                ? "Terminal stream closed. Checking server status; your draft stays here."
                : "This session is \(session.status). Your draft stays here."
            return
        }
        let message = event["message"]
        let topSize = TerminalDimensions(json: message)
        if message["snapshot"] != .null {
            let snapshot = message["snapshot"]
            let size = TerminalDimensions(json: snapshot) ?? TerminalDimensions(json: message["open"]) ?? topSize
            awaitingOpenCatchUp = false
            pendingStreamReplay = false
            markSnapshotReceived()
            pipe.feed(Data(snapshot["ansi"].string.utf8), reset: true, columns: size?.columns, rows: size?.rows)
        } else if message["open"] != .null {
            let size = TerminalDimensions(json: message["open"]) ?? topSize
            awaitingOpenCatchUp = true
            pendingStreamReplay = false
            pipe.feed(Data(), reset: true, columns: size?.columns, rows: size?.rows, completesReplay: false)
        }
        if message["type"].string == "resize" || message["resize"] != .null,
           let resizeSize = TerminalDimensions(json: message["resize"]) ?? topSize {
            pipe.feed(Data(), reset: false, columns: resizeSize.columns, rows: resizeSize.rows)
        }
        if case .array(let events) = message["events"] {
            let hasEventSizes = events.contains { Self.eventDimensions($0) != nil }
            let hasMore = message["more"].bool
            let explicitEndOfPage = message["more"] == .bool(false)
            if events.isEmpty {
                if let topSize {
                    pipe.feed(Data(), reset: false, columns: topSize.columns, rows: topSize.rows)
                }
            } else {
                var appliedTopSize = hasEventSizes
                for item in events {
                    let type = item["type"].string
                    if type == "lifecycle" {
                        let size = Self.eventDimensions(item) ?? (!appliedTopSize ? topSize : nil)
                        if let size {
                            appliedTopSize = true
                            pipe.feed(Data(), reset: false, columns: size.columns, rows: size.rows)
                        }
                    } else if type == "output" {
                        let first = !rendererState.receivedScreen
                        markSnapshotReceived()
                        let fallbackSize = !appliedTopSize ? topSize : nil
                        let size = Self.eventDimensions(item) ?? fallbackSize ?? (first ? pipe.activeDimensions : nil)
                        if size != nil { appliedTopSize = true }
                        if first { pendingStreamReplay = true }
                        pipe.feed(Data(item["data"]["text"].string.utf8), reset: first, columns: size?.columns, rows: size?.rows, completesReplay: !first)
                    }
                }
            }
            if explicitEndOfPage { awaitingOpenCatchUp = false }
            if pendingStreamReplay && !hasMore && !awaitingOpenCatchUp {
                pendingStreamReplay = false
                pipe.completeReplay()
            } else if explicitEndOfPage && !pendingStreamReplay {
                pipe.completeReplay()
            }
        }
        if message["state"] != .null {
            let state = message["state"]
            if pipe.activeDimensions == nil,
               let stateSize = TerminalDimensions(json: state["terminalSize"]) ?? TerminalDimensions(json: state) {
                pipe.feed(Data(), reset: false, columns: stateSize.columns, rows: stateSize.rows)
            }
            if awaitingOpenCatchUp || pendingStreamReplay {
                awaitingOpenCatchUp = false
                pendingStreamReplay = false
                pipe.completeReplay()
            }
            var value = session.value.object
            for (key, item) in state.object { value[key] = item }
            observe(.object(value))
        }
        if message["refusal"] != .null {
            releaseControlState(otherHolder: currentOtherHolder)
            notice = "Input was refused. Refresh and take control again."
        }
        if message["receipt"]["state"].string == "uncertain" {
            disableDirectInput()
            notice = "Terminal input delivery is uncertain. Check the screen before sending again."
        }
    }
    private func markSnapshotReceived() {
        switch rendererState {
        case .awaitingSnapshot(let g): rendererState = .snapshotReceived(generation: g)
        case .failed(let g, false): rendererState = .failed(generation: g, receivedScreen: true)
        case .snapshotReceived, .ready, .failed(_, true): break
        }
    }
    func observe(_ value: JSON) {
        let next = AgentSession(value: value)
        if next != session { session = next }
        let control = value["control"]
        switch controlState {
        case .unheld(let current):
            let updated = control["label"].string
            if updated != current { controlState = .unheld(otherHolder: updated) }
        case .claiming(let generation, let current):
            let updated = control["label"].string
            if updated != current { controlState = .claiming(generation: generation, otherHolder: updated) }
        case .held(let lease, _, _, _):
            if control["id"] != lease["id"] || session.status != "running" || !session.terminalOpen {
                releaseControlState(otherHolder: control["label"].string)
            }
        }
    }
    func claim(takeover: Bool = false) async {
        guard case .attached(_, let attachment) = streamState, terminalOpen else { return }
        let previousOtherHolder = currentOtherHolder
        releaseControlState(otherHolder: previousOtherHolder)
        let operation = UUID()
        controlGeneration = operation
        controlState = .claiming(generation: operation, otherHolder: previousOtherHolder)
        do {
            let response = try await deps.sendRequest(client, "/sessions/\(session.id)/control", .object(["action": .string("claim"), "takeover": .bool(takeover)]), nil)
            let granted = response["control"]
            guard streamState.generation == attachment, streamState.isAttached, terminalOpen,
                  case .claiming(operation, _) = controlState else {
                let staleID = granted["id"].string
                if !staleID.isEmpty {
                    let sessionID = session.id
                    let remoteClient = client
                    let sendRequest = deps.sendRequest
                    Task { _ = try? await sendRequest(remoteClient, "/sessions/\(sessionID)/control", .object(["action": .string("release"), "leaseId": .string(staleID)]), nil) }
                }
                return
            }
            guard !granted["id"].string.isEmpty, (granted["expiresAt"].number ?? 0) > Date().timeIntervalSince1970 * 1000 else {
                throw DesktopError("Control was not granted.")
            }
            if draft.pending == nil { notice = "" }
            let leaseID = granted["id"]
            let renewal = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard !Task.isCancelled, attachment == self.streamState.generation,
                          case .held(let currentLease, operation, _, _) = self.controlState,
                          currentLease["id"] == leaseID, self.hasControl else { return }
                    do {
                        let result = try await self.deps.sendRequest(self.client, "/sessions/\(self.session.id)/control", .object(["action": .string("renew"), "leaseId": leaseID]), nil)
                        guard !Task.isCancelled, attachment == self.streamState.generation,
                              case .held(let activeLease, operation, let task, let direct) = self.controlState,
                              activeLease["id"] == leaseID, self.streamState.isAttached else { return }
                        self.controlState = .held(lease: result["control"], generation: operation, renewal: task, directInput: direct)
                    } catch {
                        guard !Task.isCancelled, attachment == self.streamState.generation,
                              case .held(let activeLease, operation, _, _) = self.controlState,
                              activeLease["id"] == leaseID, self.streamState.isAttached else { return }
                        self.connectionLost(); self.notice = "Control could not be renewed. Your draft is kept locally."; return
                    }
                }
            }
            controlState = .held(lease: granted, generation: operation, renewal: renewal, directInput: false)
            await resize(lastSize.0, lastSize.1)
        } catch {
            guard case .claiming(operation, let other) = controlState else { return }
            controlState = .unheld(otherHolder: other)
            if streamState.generation == attachment { notice = error.localizedDescription }
        }
    }
    func release() async {
        let old = lease
        releaseControlState(otherHolder: "")
        if !old["id"].string.isEmpty { _ = try? await deps.sendRequest(client, "/sessions/\(session.id)/control", .object(["action": .string("release"), "leaseId": old["id"]]), nil) }
    }
    func ensureControl() async -> Bool {
        if hasControl { return true }
        guard ready, terminalOpen else { return false }
        await claim(takeover: !holder.isEmpty)
        return hasControl
    }
    func setDirectInput(_ enabled: Bool) {
        if !enabled { disableDirectInput(); return }
        guard screenReady else { return }
        Task {
            guard await ensureControl(), screenReady, case .held(let lease, let generation, let renewal, _) = controlState else { return }
            controlState = .held(lease: lease, generation: generation, renewal: renewal, directInput: true)
        }
    }
    private func disableDirectInput() {
        queuedRaw = Data()
        if case .held(let lease, let generation, let renewal, true) = controlState {
            controlState = .held(lease: lease, generation: generation, renewal: renewal, directInput: false)
        }
    }
    private func releaseControlState(otherHolder: String) {
        controlGeneration = UUID()
        if case .held(_, _, let renewal, _) = controlState { renewal?.cancel() }
        controlState = .unheld(otherHolder: otherHolder)
        queuedRaw = Data(); sendingRaw = false
    }
    func raw(_ text: String) {
        guard directInput, canUseTerminal,
              let generation = streamState.generation,
              case .held(let activeLease, let control, _, _) = controlState else { return }
        let leaseID = activeLease["id"]
        let data = Data(text.utf8)
        guard queuedRaw.count + data.count <= 32 * 1024 else {
            disableDirectInput()
            notice = "Input queue is full. Check the terminal before continuing."; return
        }
        queuedRaw.append(data)
        guard !sendingRaw else { return }; sendingRaw = true
        Task {
            while !queuedRaw.isEmpty && canUseTerminal && directInput && generation == streamState.generation,
                  case .held(let currentLease, control, _, _) = controlState, currentLease["id"] == leaseID,
                  let streamID = streamState.streamID {
                let data = queuedRaw; queuedRaw = Data()
                do {
                    var batch = ""
                    for scalar in String(decoding: data, as: UTF8.self).unicodeScalars {
                        guard canUseTerminal, directInput, generation == streamState.generation,
                              case .held(let checkLease, control, _, _) = controlState, checkLease["id"] == leaseID else {
                            throw DesktopError("Input stopped. Check the terminal before continuing.")
                        }
                        let next = String(scalar)
                        if batch.utf8.count + next.utf8.count > 4000 {
                            try await sendRaw(batch, stream: streamID, control: control, leaseID: leaseID); batch = ""
                        }
                        batch += next
                    }
                    if !batch.isEmpty && canUseTerminal && directInput && generation == streamState.generation,
                       case .held(let checkLease, control, _, _) = controlState, checkLease["id"] == leaseID {
                        try await sendRaw(batch, stream: streamID, control: control, leaseID: leaseID)
                    }
                } catch {
                    if generation == streamState.generation, case .held(_, control, _, _) = controlState {
                        notice = error.localizedDescription; disableDirectInput()
                    }
                    break
                }
            }
            if generation == streamState.generation, case .held(_, control, _, _) = controlState { sendingRaw = false }
        }
    }
    private func sendRaw(_ text: String, stream: String, control: UUID, leaseID: JSON) async throws {
        guard canUseTerminal, directInput,
              case .held(let activeLease, control, _, _) = controlState, activeLease["id"] == leaseID else {
            throw DesktopError("Terminal input stopped. Reconnect before sending input.")
        }
        try await deps.sendTerminal(client, stream, .object(["op": .string("raw"), "requestId": .string(UUID().uuidString.lowercased()), "text": .string(text), "leaseId": leaseID]))
    }
    func resize(_ cols: Int, _ rows: Int) async {
        lastSize = (cols, rows)
        guard hasControl, let streamID = streamState.streamID else { return }
        try? await deps.sendTerminal(client, streamID, .object(["op": .string("resize"), "cols": .number(Double(min(240, max(20, cols)))), "rows": .number(Double(min(100, max(5, rows)))), "leaseId": lease["id"]]))
    }
    func connectionLost() {
        let previous = streamState.streamID
        streamState = .detached
        sending = false
        awaitingOpenCatchUp = false; pendingStreamReplay = false
        rendererState = .awaitingSnapshot(generation: rendererState.generation)
        releaseControlState(otherHolder: currentOtherHolder)
        if let previous { Task { await deps.closeTerminal(client, previous) } }
        notice = "Connection lost. Your draft stays here; reconnect to check server status."
    }
    func detach() async {
        let previous = streamState.streamID, previousLease = lease
        observing = false
        stopChat(); markRead()
        streamState = .detached
        sending = false
        awaitingOpenCatchUp = false; pendingStreamReplay = false
        rendererState = .awaitingSnapshot(generation: rendererState.generation)
        releaseControlState(otherHolder: currentOtherHolder)
        saveTask?.cancel(); saveTask = nil; try? await persistDraft(flush: true)
        if !previousLease["id"].string.isEmpty {
            _ = try? await deps.sendRequest(client, "/sessions/\(session.id)/control", .object(["action": .string("release"), "leaseId": previousLease["id"]]), nil)
        }
        if let previous { await deps.closeTerminal(client, previous) }
    }
    func releaseDisplay() {
        guard !observing else { return }
        pipe.clear()
        messages = []; messagesCursor = ""; messageSource = ""; unread = 0; summary = nil
        chatNote = "Loading the conversation…"
    }
}
