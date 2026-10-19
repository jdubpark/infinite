import SwiftUI
import InfiniteCore

struct AgentSession: Identifiable, Equatable {
    let value: JSON
    var id: String { value["id"].string }
    var title: String { value["title"].string }
    var provider: String { value["provider"].string }
    var project: String { value["projectId"].string }
    var path: String { value["cwd"].string }
    var status: String { value["status"].string }
    var attention: String { value["attention"]["state"].string }
    /// The host's one-line description of what the agent is doing now.
    var now: String { value["attention"]["now"].string }
    var backend: String { value["backend"].string }
    /// The host reports these attention states once a session can no longer be reached, whatever its stored status says.
    private static let ended: Set<String> = ["exited", "unavailable", "recording-error"]
    var running: Bool { (status == "running" || status == "starting") && !Self.ended.contains(attention) }
    var needsYou: Bool { running && attention == "needs-you" }
    var recordingError: Bool { status == "recording-error" || attention == "recording-error" }
    /// A short state word. Activity words come from the host's attention signal; they never claim completion.
    var displayState: String {
        switch running ? attention : (Self.ended.contains(attention) ? attention : status) {
        case "needs-you": return "Needs you"
        case "turn-finished": return "Turn finished"
        case "unavailable": return "Unreachable"
        case "recording-error": return "Recording error"
        case "": return "Running"
        case let value: return value.replacingOccurrences(of: "-", with: " ").capitalizedFirst
        }
    }
}
extension String { var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() } }

struct ChatMessage: Identifiable, Equatable {
    let id: String
    let role: String
    let text: String
    let toolName: String?
    let ts: Date?
    /// Journal position, comparable with the page cursor the host returns.
    let seq: Int
    init(_ value: JSON) {
        id = value["id"].string; role = value["role"].string; text = value["text"].string; seq = value["seq"].int
        toolName = value["toolName"].string.isEmpty ? nil : value["toolName"].string
        ts = ISO8601DateFormatter.flexible.date(from: value["ts"].string)
    }
}
struct ChatSummary: Equatable {
    let model: String
    let text: String
    let messages: Int
}
enum SessionViewMode: String { case chat, screen }
extension ISO8601DateFormatter {
    static let flexible: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}

/// A list Resume that did not go through, shown beside its run until a later refresh or resume clears it.
struct TeamResumeFailure: Equatable {
    let message: String
    let at: Date
}

@MainActor final class AppModel: ObservableObject {
    @Published var profiles: [HostProfile] = []
    @Published var activeID = ""
    @Published var me: JSON = .null
    @Published var sessions: [AgentSession] = []
    @Published var resources: JSON = .null
    @Published var selectedID: String? { didSet { if selectedID != oldValue { mount(selectedID) } } }
    @Published var secondaryID: String? { didSet { if secondaryID != oldValue { mount(secondaryID) } } }
    /// Terminals kept attached and rendered off-screen so recent sessions reopen instantly.
    @Published private(set) var mounted: [String] = []
    @Published var connected = false
    @Published var connecting = false
    @Published var message = ""
    @Published var showingPair = false
    @Published var showingCreate = false
    @Published var pendingCreation = DraftRecord()
    /// Team runs the host reports, ordered with the ones waiting on a person first.
    @Published var teams: [TeamRun] = []
    /// A selected team shows its dashboard in place of the session panes, which stay mounted.
    @Published var selectedTeamID: String? { didSet { if selectedTeamID != nil { showingHome = false; selectedMissionID = nil } } }
    /// A selected mission shows its detail the same way; a mission and a team are never both open.
    @Published var selectedMissionID: String? { didSet { if selectedMissionID != nil { showingHome = false; selectedTeamID = nil; teamOpenedFrom = nil } } }
    /// The mission whose subtask opened the current team page, so that page can lead back to it.
    @Published var teamOpenedFrom: String?
    /// Home, the project board, covers the session panes the same way; it is the first page after connecting.
    @Published var showingHome = true
    /// The project Home's board is narrowed to; nil shows every project.
    @Published var projectFilter: String?
    @Published private(set) var projectGroups = ProjectGroupList.empty
    @Published private(set) var board = Board.empty
    /// The last board poll succeeded; otherwise Home says why its rows may be old.
    @Published private(set) var boardFresh = false
    @Published private(set) var boardError = ""
    @Published var pendingMissionCreation = DraftRecord()
    var missionModels: [String: MissionModel] = [:]
    @Published var showingCreateTeam = false
    @Published var pendingTeamCreation = DraftRecord()
    @Published private(set) var teamsFresh = false
    /// List Resume: runs with a resume in flight, and the last failure per run until a later refresh succeeds.
    @Published private(set) var resumingTeams: Set<String> = []
    @Published private(set) var teamResumeFailures: [String: TeamResumeFailure] = [:]
    var teamModels: [String: TeamModel] = [:]
    /// Resource samples are only fetched while a Resources window is showing them.
    var resourceWatchers = 0
    private static let keepAlive = 3
    let cmux = CmuxViewModel()
    private var connectionProfileID = ""
    var client: RemoteClient?
    var terminals: [String: SessionModel] = [:]
    private var pollTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    let drafts = DraftStore()
    var active: HostProfile? { profiles.first { $0.id == activeID } }
    var projects: [JSON] { me["projects"].array }
    var isOwner: Bool { me["role"].string == "owner" }
    /// The host's configured digest model, when any.
    var summaryModel: String? { let model = me["capabilities"]["summaries"]["model"].string; return model.isEmpty ? nil : model }
    var teamsEnabled: Bool { me["teams"]["enabled"].bool }
    var teamLineup: JSON { me["teams"]["lineup"] }
    var teamParallelismLimit: Int { let value = me["teams"]["maxParallelism"].int; return max(1, min(4, value == 0 ? 4 : value)) }
    func projectName(_ id: String) -> String { projects.first { $0["id"].string == id }?["name"].string ?? id }
    /// Providers offered for a single-provider team, Claude Code first.
    var teamProviders: [String] { let all = me["providers"].array.map(\.string); return all.contains("claude") ? ["claude"] + all.filter { $0 != "claude" } : all }
    /// A team may only start in a workspace whose required checks the host configured.
    func teamWorkspaceReady(_ id: String) -> Bool { !(projects.first { $0["id"].string == id }?["team"]["checks"].array.isEmpty ?? true) }
    /// The workspace a new team starts in by default: the first one with checks configured.
    var defaultTeamWorkspace: String { (projects.first { !$0["team"]["checks"].array.isEmpty } ?? projects.first)?["id"].string ?? "" }
    init() {
        if let data = UserDefaults.standard.data(forKey: "hostProfiles"), let value = try? JSONDecoder().decode([HostProfile].self, from: data) { profiles = value }
        activeID = UserDefaults.standard.string(forKey: "activeHost") ?? profiles.first?.id ?? ""
    }
    func start() { if active != nil { Task { await connect() } } }
    var visibleIDs: [String] { [selectedID, secondaryID].compactMap { $0 }.reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }
    private func mount(_ id: String?) {
        var next = mounted.filter { $0 != id }
        if let id { next.insert(id, at: 0) }
        // Visible panes always stay; the rest keep the most recent slots.
        let visible = visibleIDs
        let kept = next.filter { visible.contains($0) } + next.filter { !visible.contains($0) }
        if kept != mounted { mounted = Array(kept.prefix(max(Self.keepAlive, visible.count))) }
    }
    func unmount(_ id: String) { mounted.removeAll { $0 == id } }
    func persistProfiles() {
        UserDefaults.standard.set(try? JSONEncoder().encode(profiles), forKey: "hostProfiles")
        UserDefaults.standard.set(activeID, forKey: "activeHost")
    }
    func pair(label: String, origin: String, token: String, relay: String) async throws {
        var profile = HostProfile(label: label.isEmpty ? "Server" : label, origin: origin.trimmingCharacters(in: .whitespacesAndNewlines), relayMachineID: relay.isEmpty ? nil : relay.lowercased())
        let candidate = RemoteClient(profile: profile, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
        do {
            let identity = try await candidate.request("/me")
            profile.pinnedMachineID = identity["machine"]["id"].string
            if profile.pinnedMachineID?.isEmpty != false { throw DesktopError("The server did not identify itself.") }
            if label.isEmpty { profile.label = identity["machine"]["label"].string.isEmpty ? "Server" : identity["machine"]["label"].string }
            try DeviceKeychain.save(token.trimmingCharacters(in: .whitespacesAndNewlines), for: profile.id)
            profiles.append(profile); activeID = profile.id; persistProfiles()
            await candidate.close(); showingPair = false; await connect()
        } catch { await candidate.close(); throw error }
    }
    func connect() async {
        if connecting && connectionProfileID == activeID { return }
        connectionProfileID = activeID
        let profile = active
        pollTask?.cancel(); connectionGeneration = UUID(); let generation = connectionGeneration
        let previousTerminals = Array(terminals.values); terminals.removeAll()
        let previousClient = client; client = nil
        connected = false; connecting = true; sessions = []; resources = .null; me = .null
        teams = []; selectedTeamID = nil; selectedMissionID = nil; teamOpenedFrom = nil; projectFilter = nil; showingHome = true; teamModels.removeAll(); teamsFresh = false
        projectGroups = .empty; board = .empty; boardFresh = false; boardError = ""; missionModels.removeAll()
        for terminal in previousTerminals { await terminal.detach() }
        await previousClient?.close()
        guard generation == connectionGeneration else { return }
        selectedID = nil; secondaryID = nil; mounted = []; message = ""
        guard let profile else { connecting = false; return }
        do {
            let next = RemoteClient(profile: profile, token: try DeviceKeychain.read(profile.id))
            client = next; let identity = try await next.request("/me")
            guard generation == connectionGeneration else { await next.close(); return }
            me = identity
            pendingCreation = try drafts.read("\(profile.id):create")
            pendingTeamCreation = try drafts.read("\(profile.id):create-team")
            pendingMissionCreation = try drafts.read("\(profile.id):create-mission")
            connected = true; connecting = false; persistProfiles()
            pollTask = Task {
                var count = 0
                while !Task.isCancelled && generation == self.connectionGeneration {
                    await self.refresh(includeResources: self.resourceWatchers > 0 && count % 3 == 0)
                    count += 1; try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        } catch { guard generation == connectionGeneration else { return }; connecting = false; message = error.localizedDescription }
    }
    func refresh(includeResources: Bool = true) async {
        guard let client else { return }; let generation = connectionGeneration
        do {
            let response = try await client.request("/sessions")
            guard generation == connectionGeneration else { return }
            let next = response["sessions"].array.map(AgentSession.init).sorted {
                if $0.needsYou != $1.needsYou { return $0.needsYou }
                if $0.running != $1.running { return $0.running }
                return $0.value["createdAt"].string > $1.value["createdAt"].string
            }
            // Every poll returns the whole list; only a real change may redraw the window.
            if next != sessions { sessions = next }
            if !connected { connected = true }
            if !message.isEmpty { message = "" }
            for session in sessions {
                if let terminal = terminals[session.id] {
                    terminal.observe(session.value)
                    if session.status == "running", terminal.observing && !terminal.attached { await terminal.attach() }
                }
            }
            if selectedID == nil { selectedID = (sessions.first { $0.running } ?? sessions.first)?.id }
            if teamsEnabled || !teams.isEmpty { await refreshTeams(generation) }
            await refreshBoard(generation)
            if includeResources {
                do { let sample = try await client.request("/machine/resources"); if generation == connectionGeneration { resources = sample } }
                catch {
                    guard generation == connectionGeneration else { return }
                    resources = .object(["unavailable": .string(error.localizedDescription)])
                }
            }
        } catch {
            guard generation == connectionGeneration else { return }
            connected = false; message = error.localizedDescription
            for terminal in terminals.values { terminal.connectionLost() }
        }
    }
    /// The team list is small and the whole list arrives each poll; only a real change redraws.
    private func refreshTeams(_ generation: UUID) async {
        guard let client else { return }
        let started = Date()
        do {
            let response = try await client.request("/teams")
            guard generation == connectionGeneration else { return }
            // A failure recorded while this refresh was in flight still stands; older ones are cleared.
            teamResumeFailures = teamResumeFailures.filter { $0.value.at >= started }
            let next = TeamRun.blockedFirst(response["teams"].array.map(TeamRun.init).sorted {
                if $0.needsYou != $1.needsYou { return $0.needsYou }
                if $0.finished != $1.finished { return $1.finished }
                return $0.createdAt > $1.createdAt
            })
            if next != teams { teams = next }
            for team in next { teamModels[team.id]?.observe(team) }
            if !teamsFresh { teamsFresh = true }
        } catch {
            guard generation == connectionGeneration else { return }
            if teamsFresh { teamsFresh = false }
        }
    }
    /// Projects and the board arrive whole each poll; only a real change redraws.
    private func refreshBoard(_ generation: UUID) async {
        guard let client else { return }
        do {
            let groups = ProjectGroupList(try await client.request("/project-groups"))
            let next = Board(try await client.request("/board"))
            guard generation == connectionGeneration else { return }
            if groups != projectGroups { projectGroups = groups }
            if next != board { board = next }
            if let filter = projectFilter, groups.group(filter) == nil { projectFilter = nil }
            if !boardFresh { boardFresh = true }
            if !boardError.isEmpty { boardError = "" }
        } catch {
            guard generation == connectionGeneration else { return }
            if boardFresh { boardFresh = false }
            let text = (error as? DesktopError)?.status == 404 ? "This server has no project board yet. Update the host to use projects and missions." : error.localizedDescription
            if text != boardError { boardError = text }
        }
    }
    /// Home for every project, or narrowed to one.
    func showHome(project: String? = nil) {
        selectedTeamID = nil; selectedMissionID = nil; teamOpenedFrom = nil
        projectFilter = project; showingHome = true
    }
    /// A team page, remembering the mission it was opened from.
    func openTeam(_ id: String, from mission: String? = nil) { selectedTeamID = id; teamOpenedFrom = mission }
    func missionModel(for id: String) -> MissionModel? {
        if let existing = missionModels[id] { return existing }
        guard let client else { return nil }
        // Until its first poll, the mission shows what its board row reported.
        let row = board.items.first { $0.id == id }
        let model = MissionModel(mission: Mission(.object(["id": .string(id), "title": .string(row?.title ?? ""), "status": .string(row?.status ?? ""), "groupName": .string(row?.projectName ?? "")])),
                                 client: client, role: me["role"].string)
        missionModels[id] = model; return model
    }
    /// Missions start from the owner's sentence in one project. Retrying resends the identical body,
    /// so the host either recovers its recorded outcome or applies it once.
    func createMission(groupID: String, objective: String) async throws {
        guard let client else { throw DesktopError("Connect to a server first.") }
        let profileID = activeID
        if pendingMissionCreation.pendingID == nil {
            let requestID = UUID().uuidString.lowercased()
            let body: JSON = .object(["requestId": .string(requestID), "groupId": .string(groupID), "objective": .string(objective.trimmingCharacters(in: .whitespacesAndNewlines))])
            var record = DraftRecord(); record.pendingID = requestID
            record.pendingText = String(decoding: try body.data(), as: UTF8.self)
            try drafts.save(record, identity: "\(profileID):create-mission"); pendingMissionCreation = record
        }
        guard let payload = pendingMissionCreation.pendingText else { throw DesktopError("Review the pending mission request before starting another.") }
        let result = try await client.request("/missions", body: JSON.parse(Data(payload.utf8)))
        try drafts.save(DraftRecord(), identity: "\(profileID):create-mission")
        guard profileID == activeID else { return }
        pendingMissionCreation = DraftRecord()
        await refresh()
        let id = result["id"].string.isEmpty ? result["mission"]["id"].string : result["id"].string
        if !id.isEmpty { selectedMissionID = id }
    }
    func clearMissionCreation() {
        do { try drafts.save(DraftRecord(), identity: "\(activeID):create-mission"); pendingMissionCreation = DraftRecord() }
        catch { message = error.localizedDescription }
    }
    /// Resume from the Home list: the same request as the team page, with its failure kept for the row.
    func resumeTeam(_ id: String) async {
        guard !resumingTeams.contains(id), let model = teamModel(for: id) else { return }
        guard !model.busy, model.pending == nil else {
            teamResumeFailures[id] = TeamResumeFailure(message: "Another request for this team is unconfirmed or in progress. Open the team to check it.", at: Date())
            return
        }
        resumingTeams.insert(id)
        await model.perform("resume")
        resumingTeams.remove(id)
        teamResumeFailures[id] = model.noticeIsError ? TeamResumeFailure(message: model.notice, at: Date()) : nil
    }
    func teamModel(for id: String) -> TeamModel? {
        if let existing = teamModels[id] { return existing }
        guard let client else { return nil }
        // A subteam the team list has not reported yet starts from its ID; its first poll fills it in.
        let team = teams.first { $0.id == id } ?? TeamRun(.object(["id": .string(id)]))
        let model = TeamModel(run: team, client: client, role: me["role"].string)
        teamModels[id] = model; return model
    }
    /// Leaving a team for one of its member sessions.
    func openSession(_ id: String) { selectedTeamID = nil; selectedMissionID = nil; showingHome = false; selectedID = id }
    func createTeam(projectID: String, provider: String, useLineup: Bool, title: String, objective: String, parallelism: Int) async throws {
        guard let client else { throw DesktopError("Connect to a server first.") }
        let profileID = activeID
        if pendingTeamCreation.pendingID == nil {
            let requestID = UUID().uuidString.lowercased()
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let request = objective.trimmingCharacters(in: .whitespacesAndNewlines)
            let firstLine = request.split(whereSeparator: \.isNewline).first.map(String.init) ?? request
            var fields: [String: JSON] = ["requestId": .string(requestID), "projectId": .string(projectID), "provider": .string(provider),
                                          "title": .string(name.isEmpty ? String(firstLine.prefix(100)) : name), "objective": .string(request), "parallelism": .number(Double(parallelism))]
            if useLineup { fields["useConfiguredLineup"] = .bool(true) }
            var record = DraftRecord(); record.pendingID = requestID
            record.pendingText = String(decoding: try JSON.object(fields).data(), as: UTF8.self)
            try drafts.save(record, identity: "\(profileID):create-team"); pendingTeamCreation = record
        }
        guard let payload = pendingTeamCreation.pendingText else { throw DesktopError("Review the pending team request before starting another.") }
        let result = try await client.request("/teams", body: JSON.parse(Data(payload.utf8)))
        try drafts.save(DraftRecord(), identity: "\(profileID):create-team")
        guard profileID == activeID else { return }
        pendingTeamCreation = DraftRecord()
        await refresh(); selectedTeamID = result["id"].string.isEmpty ? nil : result["id"].string
        showingCreateTeam = false
    }
    func clearTeamCreation() {
        do { try drafts.save(DraftRecord(), identity: "\(activeID):create-team"); pendingTeamCreation = DraftRecord() }
        catch { message = error.localizedDescription }
    }
    func model(for id: String) -> SessionModel? {
        if let existing = terminals[id] { return existing }
        guard let session = sessions.first(where: { $0.id == id }), let client else { return nil }
        let model = SessionModel(session: session, client: client, profileID: activeID, drafts: drafts, role: me["role"].string, supportsStream: me["capabilities"]["remoteTerminal"].int == 1, summaryModel: summaryModel)
        terminals[id] = model; return model
    }
    func create(provider: String, project: String, title: String) async throws {
        guard let client else { throw DesktopError("Connect to a server first.") }
        let profileID = activeID
        if pendingCreation.pendingID == nil {
            let requestID = UUID().uuidString.lowercased()
            let body: JSON = .object(["requestId": .string(requestID), "provider": .string(provider), "projectId": .string(project), "title": .string(title.isEmpty ? "\(provider.capitalized) session" : title), "prompt": .string("")])
            var record = DraftRecord(); record.pendingID = requestID
            record.pendingText = String(decoding: try body.data(), as: UTF8.self)
            try drafts.save(record, identity: "\(profileID):create"); pendingCreation = record
        }
        guard let payload = pendingCreation.pendingText else { throw DesktopError("Review the pending creation before starting another session.") }
        let result = try await client.request("/sessions", body: JSON.parse(Data(payload.utf8)))
        try drafts.save(DraftRecord(), identity: "\(profileID):create")
        guard profileID == activeID else { return }
        pendingCreation = DraftRecord()
        await refresh(); openSession(result["id"].string.isEmpty ? result["session"]["id"].string : result["id"].string)
        showingCreate = false
    }
    func clearCreation() {
        do { try drafts.save(DraftRecord(), identity: "\(activeID):create"); pendingCreation = DraftRecord() }
        catch { message = error.localizedDescription }
    }
    func forget() async {
        guard let active else { return }
        pollTask?.cancel()
        for terminal in terminals.values { await terminal.detach() }
        if let client { await client.close() }
        do { try DeviceKeychain.remove(active.id) } catch { message = error.localizedDescription; return }
        profiles.removeAll { $0.id == active.id }; activeID = profiles.first?.id ?? ""; persistProfiles(); await connect()
    }
}

@MainActor final class SessionModel: ObservableObject {
    @Published var session: AgentSession
    @Published var draft = DraftRecord()
    @Published var notice = ""
    @Published var attached = false
    @Published var busy = false
    @Published var lease: JSON = .null
    @Published var directInput = false
    @Published var holder = ""
    @Published private(set) var rendererUnavailable = true
    @Published private(set) var rendererGeneration = UUID()
    @Published var view: SessionViewMode = .chat
    /// The terminal renderer exists only once the screen view has been shown.
    @Published private(set) var screenShown = false
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var messageSource = ""
    @Published private(set) var chatNote = "Loading the conversation…"
    @Published private(set) var unread = 0
    @Published private(set) var summary: ChatSummary?
    @Published private(set) var summaryBusy = false
    @Published private(set) var summaryError = ""
    @Published private(set) var answering = false
    let summaryModel: String?
    private var messagesCursor = ""
    private var chatTask: Task<Void, Never>?
    private var chatGeneration = UUID()
    /// Where the chat stood when this Mac last looked at it; the digest starts there.
    private var readCursor: String
    private static let readCursorsKey = "readCursors"
    let pipe = TerminalPipe()
    let client: RemoteClient
    let profileID: String
    let drafts: DraftStore
    let role: String
    let supportsStream: Bool
    private var streamID: String?
    private var renewal: Task<Void, Never>?
    private var attachGeneration = UUID()
    private var controlGeneration = UUID()
    private var saveTask: Task<Void, Never>?
    private var queuedRaw = Data()
    private var sendingRaw = false
    private var lastSize = (80, 24)
    private var snapshotReady = false
    private var receivedScreen = false
    var observing = false
    var identity: String { "\(profileID):\(session.id)" }
    var hasControl: Bool { !lease["id"].string.isEmpty && (lease["expiresAt"].number ?? 0) > Date().timeIntervalSince1970 * 1000 && attached }
    var canUseTerminal: Bool { hasControl && snapshotReady && !rendererUnavailable }
    /// The stream is open and input could be sent once control is held. Typing into the
    /// terminal also needs a current screen; sending a prompt does not.
    var ready: Bool { attached && session.running }
    var screenReady: Bool { ready && snapshotReady && !rendererUnavailable }
    var canSend: Bool { ready && !busy && draft.pendingID == nil && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// The open dialog, when the host reports one.
    var prompt: JSON? { let value = session.value["attention"]["prompt"]; return value == .null ? nil : value }
    /// Another device currently holds the input lease.
    var otherHolder: String? { hasControl || holder.isEmpty ? nil : holder }
    init(session: AgentSession, client: RemoteClient, profileID: String, drafts: DraftStore, role: String, supportsStream: Bool, summaryModel: String? = nil) {
        self.session = session; self.client = client; self.profileID = profileID; self.drafts = drafts; self.role = role; self.supportsStream = supportsStream; self.summaryModel = summaryModel
        readCursor = (UserDefaults.standard.dictionary(forKey: Self.readCursorsKey) as? [String: String])?["\(profileID):\(session.id)"] ?? ""
        do { draft = try drafts.read(identity) } catch { notice = error.localizedDescription }
        if draft.pendingID != nil { notice = "A previous send was not confirmed. Inspect the terminal before retrying the same send or clearing it." }
    }
    func showScreen() { screenShown = true; view = .screen }

    // ---- Chat ---------------------------------------------------------------------------
    /// Polls the host's chat record while this session is observed. Messages are the provider's
    /// own transcript when the host has it, otherwise the prompts this device delivered.
    private func startChat() {
        chatTask?.cancel()
        chatGeneration = UUID(); let generation = chatGeneration
        chatTask = Task {
            while !Task.isCancelled && generation == chatGeneration {
                await pollChat(generation)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
    private func stopChat() { chatTask?.cancel(); chatTask = nil; chatGeneration = UUID() }
    private func pollChat(_ generation: UUID) async {
        var pages = 0, more = false
        repeat {
            let query = messagesCursor.isEmpty ? "" : "&after=\(messagesCursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? messagesCursor)"
            let page: JSON
            do { page = try await client.request("/sessions/\(session.id)/messages?limit=100\(query)") }
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
                // Unread counts only what the host recorded after this Mac last looked.
                let count = messages.filter { $0.seq > read }.count
                if count != unread { unread = count }
            }
            pages += 1
            more = page["more"].bool
        } while more && pages < 10
    }
    /// Remembers where the chat stood, so the next visit can measure and summarize what is new.
    func markRead() {
        guard !messagesCursor.isEmpty else { return }
        readCursor = messagesCursor; unread = 0; summary = nil
        var cursors = (UserDefaults.standard.dictionary(forKey: Self.readCursorsKey) as? [String: String]) ?? [:]
        cursors["\(profileID):\(session.id)"] = messagesCursor
        if cursors.count > 200 { cursors = Dictionary(uniqueKeysWithValues: Array(cursors).suffix(150)) }
        UserDefaults.standard.set(cursors, forKey: Self.readCursorsKey)
    }
    /// Asks the host's digest model for what happened since this Mac last looked.
    func catchUp() async {
        guard summaryModel != nil, !summaryBusy else { return }
        summaryBusy = true; summaryError = ""
        let after = readCursor.isEmpty ? "" : "?after=\(readCursor)"
        do {
            let value = try await client.request("/sessions/\(session.id)/summary\(after)")
            summary = ChatSummary(model: value["model"].string, text: value["text"].string, messages: value["messages"].int)
        } catch { summaryError = error.localizedDescription }
        summaryBusy = false
    }
    func dismissSummary() { summary = nil; summaryError = "" }
    /// Answers the open dialog by option or text. The host presses keys on the dialog it shows
    /// and reports whether it closed; nothing here approves anything on its own.
    func answer(option: Int? = nil, text: String? = nil) async {
        guard let prompt, !answering, await ensureControl() else { return }
        answering = true
        var body: [String: JSON] = ["requestId": .string(UUID().uuidString.lowercased()), "promptId": .number(Double(prompt["id"].int))]
        if let option { body["option"] = .number(Double(option)) }
        if let text, !text.isEmpty { body["text"] = .string(text) }
        do {
            let receipt = try await client.request("/sessions/\(session.id)/answer", body: .object(body), controlID: lease["id"].string)
            let result = receipt["result"].string
            notice = result == "closed" ? "Answer delivered; the dialog closed." : result == "changed" ? "The dialog changed before the answer; check it again." : "Answer delivered; the dialog is still open. Check the screen."
        } catch { notice = error.localizedDescription }
        answering = false
    }
    func rendererFailed(_ message: String) {
        rendererUnavailable = true; snapshotReady = false; directInput = false; queuedRaw = Data(); notice = message
    }
    func rendererRestored(_ generation: UUID) {
        guard generation == rendererGeneration, receivedScreen, snapshotReady else { return }
        rendererUnavailable = false
    }
    func setDraft(_ text: String) {
        draft.text = text; saveTask?.cancel()
        saveTask = Task { try? await Task.sleep(nanoseconds: 250_000_000); if !Task.isCancelled { saveDraft() } }
    }
    func saveDraft() { do { try drafts.save(draft, identity: identity) } catch { notice = error.localizedDescription } }
    func attach() async {
        observing = true
        if chatTask == nil { startChat() }
        guard streamID == nil, !busy else { return }
        guard supportsStream && session.backend != "cmux" else { notice = "This host does not provide a live byte stream for this session. Update the host or use the cmux connection."; return }
        attachGeneration = UUID(); let current = attachGeneration
        busy = true; snapshotReady = false; receivedScreen = false; rendererUnavailable = true
        queuedRaw = Data(); sendingRaw = false
        rendererGeneration = UUID(); pipe.feed(Data(), reset: true)
        do {
            let id = try await client.openTerminal(sessionID: session.id) { [weak self] message in
                Task { @MainActor in guard let self, self.attachGeneration == current else { return }; self.receive(message) }
            }
            guard current == attachGeneration else { await client.closeTerminal(id); return }
            streamID = id; attached = true
            if draft.pendingID == nil { notice = "" }
        } catch { notice = error.localizedDescription }
        busy = false
    }
    func receive(_ event: JSON) {
        if event["type"].string == "terminal-closed" {
            streamID = nil; connectionLost()
            notice = session.status == "running"
                ? "Terminal stream closed. Checking server status; your draft stays here."
                : "This session is \(session.status). Your draft stays here."
            return
        }
        let message = event["message"]
        if message["snapshot"] != .null {
            receivedScreen = true; snapshotReady = true
            pipe.feed(Data(message["snapshot"]["ansi"].string.utf8), reset: true, columns: message["snapshot"]["cols"].int, rows: message["snapshot"]["rows"].int)
        }
        for output in message["events"].array where output["type"].string == "output" {
            let first = !receivedScreen; receivedScreen = true; snapshotReady = true
            pipe.feed(Data(output["data"]["text"].string.utf8), reset: first)
        }
        if message["state"] != .null {
            var value = session.value.object
            for (key, item) in message["state"].object { value[key] = item }
            observe(.object(value))
        }
        if message["refusal"] != .null { controlGeneration = UUID(); lease = .null; directInput = false; queuedRaw = Data(); sendingRaw = false; renewal?.cancel(); notice = "Input was refused. Refresh and take control again." }
        if message["receipt"]["state"].string == "uncertain" { directInput = false; queuedRaw = Data(); notice = "Terminal input delivery is uncertain. Check the screen before sending again." }
    }
    func observe(_ value: JSON) {
        let next = AgentSession(value: value)
        if next != session { session = next }
        let control = value["control"]
        if control["label"].string != holder { holder = control["label"].string }
        if !lease["id"].string.isEmpty && (control["id"] != lease["id"] || session.status != "running") {
            controlGeneration = UUID(); lease = .null; directInput = false; queuedRaw = Data(); sendingRaw = false; renewal?.cancel()
        }
    }
    func claim(takeover: Bool = false) async {
        guard attached else { return }
        let attachment = attachGeneration
        controlGeneration = UUID(); let operation = controlGeneration
        queuedRaw = Data(); sendingRaw = false
        renewal?.cancel()
        do {
            let response = try await client.request("/sessions/\(session.id)/control", body: .object(["action": .string("claim"), "takeover": .bool(takeover)]))
            guard attachment == attachGeneration, operation == controlGeneration, attached else { return }
            lease = response["control"]; holder = lease["label"].string
            guard hasControl else { throw DesktopError("Control was not granted.") }
            if draft.pendingID == nil { notice = "" }
            let leaseID = lease["id"]
            renewal = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard !Task.isCancelled, attachment == self.attachGeneration, operation == self.controlGeneration,
                          self.lease["id"] == leaseID, self.hasControl else { return }
                    do {
                        let result = try await self.client.request("/sessions/\(self.session.id)/control", body: .object(["action": .string("renew"), "leaseId": leaseID]))
                        guard !Task.isCancelled, attachment == self.attachGeneration, operation == self.controlGeneration,
                              self.lease["id"] == leaseID, self.attached else { return }
                        self.lease = result["control"]
                    } catch {
                        guard !Task.isCancelled, attachment == self.attachGeneration, operation == self.controlGeneration,
                              self.lease["id"] == leaseID, self.attached else { return }
                        self.connectionLost(); self.notice = "Control could not be renewed. Your draft is kept locally."; return
                    }
                }
            }
            await resize(lastSize.0, lastSize.1)
        } catch {
            if attachment == attachGeneration, operation == controlGeneration { notice = error.localizedDescription }
        }
    }
    func release() async {
        controlGeneration = UUID()
        let old = lease; lease = .null; directInput = false; queuedRaw = Data(); sendingRaw = false; renewal?.cancel()
        if !old["id"].string.isEmpty { _ = try? await client.request("/sessions/\(session.id)/control", body: .object(["action": .string("release"), "leaseId": old["id"]])) }
    }
    /// Sending claims the input lease itself; a lease held elsewhere is taken over.
    func ensureControl() async -> Bool {
        if hasControl { return true }
        guard ready else { return false }
        await claim(takeover: !holder.isEmpty)
        return hasControl
    }
    func setDirectInput(_ enabled: Bool) {
        if !enabled { directInput = false; queuedRaw = Data(); return }
        guard screenReady else { return }
        Task { if await ensureControl() { directInput = true } }
    }
    func send(retry: Bool = false) async {
        guard ready, !busy, retry ? draft.pendingID != nil : canSend else { return }
        guard await ensureControl(), hasControl, attached else { return }
        let generation = attachGeneration
        let text = retry ? (draft.pendingText ?? draft.text) : draft.text
        let id = draft.pendingID ?? UUID().uuidString.lowercased()
        draft.pendingID = id; draft.pendingText = text
        do { try drafts.save(draft, identity: identity) } catch { notice = error.localizedDescription; return }
        busy = true
        do {
            let receipt = try await client.request("/sessions/\(session.id)/input", body: .object(["requestId": .string(id), "text": .string(text), "submit": .bool(true)]), controlID: lease["id"].string)
            guard generation == attachGeneration else { return }
            guard receipt["state"].string == "delivered" || receipt["receipt"]["state"].string == "delivered" else { throw DesktopError("Delivery is uncertain. Inspect the terminal before retrying.", code: "delivery-unknown") }
            if draft.text == text { draft.text = "" }; draft.pendingID = nil; draft.pendingText = nil; saveDraft()
            notice = "Delivered to the terminal."
        } catch { if generation == attachGeneration { notice = error.localizedDescription } }
        if generation == attachGeneration { busy = false }
    }
    func clearPending() { if draft.text == draft.pendingText { draft.text = "" }; draft.pendingID = nil; draft.pendingText = nil; saveDraft(); notice = "Previous send cleared after your review." }
    func raw(_ text: String) {
        guard directInput, canUseTerminal else { return }
        let data = Data(text.utf8)
        guard queuedRaw.count + data.count <= 32 * 1024 else { directInput = false; queuedRaw = Data(); notice = "Input queue is full. Check the terminal before continuing."; return }
        queuedRaw.append(data)
        guard !sendingRaw else { return }; sendingRaw = true
        let generation = attachGeneration
        let control = controlGeneration, leaseID = lease["id"]
        Task {
            while !queuedRaw.isEmpty && canUseTerminal && directInput && generation == attachGeneration && control == controlGeneration && lease["id"] == leaseID {
                let data = queuedRaw; queuedRaw = Data()
                guard let streamID else { break }
                do {
                    // Keep every payload under the gateway's UTF-8 byte limit without splitting a scalar.
                    var batch = ""
                    for scalar in String(decoding: data, as: UTF8.self).unicodeScalars {
                        guard canUseTerminal, directInput, generation == attachGeneration, control == controlGeneration, lease["id"] == leaseID else { throw DesktopError("Input stopped. Check the terminal before continuing.") }
                        let next = String(scalar)
                        if batch.utf8.count + next.utf8.count > 4000 {
                            try await sendRaw(batch, stream: streamID, control: control, leaseID: leaseID); batch = ""
                        }
                        batch += next
                    }
                    if !batch.isEmpty && canUseTerminal && directInput && generation == attachGeneration && control == controlGeneration { try await sendRaw(batch, stream: streamID, control: control, leaseID: leaseID) }
                } catch {
                    if generation == attachGeneration, control == controlGeneration { notice = error.localizedDescription; queuedRaw = Data(); directInput = false }
                    break
                }
            }
            if generation == attachGeneration, control == controlGeneration { sendingRaw = false }
        }
    }
    private func sendRaw(_ text: String, stream: String, control: UUID, leaseID: JSON) async throws {
        guard canUseTerminal, directInput, control == controlGeneration, lease["id"] == leaseID else { throw DesktopError("Terminal input stopped. Reconnect before sending input.") }
        try await client.sendTerminal(stream, message: .object(["op": .string("raw"), "requestId": .string(UUID().uuidString.lowercased()), "text": .string(text), "leaseId": leaseID]))
    }
    func resize(_ cols: Int, _ rows: Int) async {
        lastSize = (cols, rows)
        guard hasControl, let streamID else { return }
        try? await client.sendTerminal(streamID, message: .object(["op": .string("resize"), "cols": .number(Double(min(240, max(20, cols)))), "rows": .number(Double(min(100, max(5, rows)))), "leaseId": lease["id"]]))
    }
    func connectionLost() {
        controlGeneration = UUID()
        let previous = streamID; streamID = nil; attachGeneration = UUID()
        attached = false; busy = false; snapshotReady = false; rendererUnavailable = true; lease = .null; directInput = false; queuedRaw = Data(); renewal?.cancel()
        if let previous { Task { await client.closeTerminal(previous) } }
        notice = "Connection lost. Your draft stays here; reconnect to check server status."
    }
    func detach() async {
        let previous = streamID, previousLease = lease
        observing = false
        stopChat(); markRead()
        controlGeneration = UUID()
        attachGeneration = UUID(); snapshotReady = false; rendererUnavailable = true
        streamID = nil; attached = false; busy = false; lease = .null; directInput = false; queuedRaw = Data(); renewal?.cancel()
        saveTask?.cancel(); saveDraft()
        if !previousLease["id"].string.isEmpty {
            _ = try? await client.request("/sessions/\(session.id)/control", body: .object(["action": .string("release"), "leaseId": previousLease["id"]]))
        }
        if let previous { await client.closeTerminal(previous) }
    }
    private func lifecycle(_ action: String, controlID: String? = nil) async throws -> JSON {
        let key = "\(identity):\(action)"
        var pending = try drafts.read(key)
        if pending.pendingID == nil { pending.pendingID = UUID().uuidString.lowercased(); try drafts.save(pending, identity: key) }
        let result = try await client.request("/sessions/\(session.id)/\(action)", body: .object(["requestId": .string(pending.pendingID!)]), controlID: controlID)
        try drafts.save(DraftRecord(), identity: key)
        return result
    }
    func end() async {
        guard role == "owner" else { return }
        do {
            if !hasControl { await claim() }
            guard hasControl else { throw DesktopError("Take control before ending this session.") }
            _ = try await lifecycle("stop", controlID: lease["id"].string)
            notice = "End requested. Waiting for confirmed process exit."
        } catch { notice = error.localizedDescription }
    }
    func resume() async {
        do {
            let response = try await lifecycle("resume")
            notice = "Resumed as \(response["id"].string.prefix(8)). Select the new session from the sidebar."
        } catch { notice = error.localizedDescription }
    }
}
