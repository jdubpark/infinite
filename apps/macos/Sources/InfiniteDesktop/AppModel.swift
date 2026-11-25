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
    /// The mission whose coordinator runs this session, when one does. Absent for sessions the owner runs.
    var managedBy: SessionManagement? { try? value["managedBy"].decoded() }
    /// Run by a mission coordinator: the owner sees it read-only and answers only its provider prompts.
    var managed: Bool { managedBy != nil }
    /// The owner may use this session's terminal fallback (attach, take control, keys, typed input). Always for a
    /// session the owner runs; for a mission-managed one only while its provider prompt waits for the owner.
    var terminalOpen: Bool { !managed || needsYou }
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

/// A list Resume that did not go through, shown beside its run until dismissed or another resume is attempted.
struct TeamResumeFailure: Equatable {
    let message: String

    static func retainingExisting(_ failures: [String: TeamResumeFailure], teamIDs: Set<String>) -> [String: TeamResumeFailure] {
        Dictionary(uniqueKeysWithValues: failures.filter { teamIDs.contains($0.key) })
    }
}

@MainActor final class AppModel: ObservableObject {
    @Published var profiles: [HostProfile] = []
    @Published var activeID = "" {
        didSet {
            if activeID != oldValue {
                connectionGeneration = UUID()
                connectionProfileID = ""
                connecting = false
                if let aborted = takeConnectingClient() { Task { @MainActor [weak self] in await self?.deps.closeClient(aborted) } }
                if connectedProfileID != nil { connected = false; connectedProfileID = nil }
            }
        }
    }
    @Published var me: JSON = .null
    @Published var sessions: [AgentSession] = []
    /// The rows `sessions` is built from, and their version; reset with `sessions`.
    private var sessionList = SessionList()
    @Published var resources: JSON = .null
    @Published var selectedID: String? { didSet { if selectedID != oldValue { mount(selectedID) } } }
    @Published var secondaryID: String? { didSet { if secondaryID != oldValue { mount(secondaryID) } } }
    /// Terminals kept attached and rendered off-screen so recent sessions reopen instantly.
    @Published private(set) var mounted: [String] = []
    @Published var connected = false
    @Published var connecting = false
    @Published private(set) var displayVisible = false
    @Published private(set) var sessionsDisplayStale = false
    @Published private(set) var sessionsLoaded = false
    @Published private(set) var connectionError = ""
    @Published var message = ""
    @Published var showingPair = false
    @Published var showingCreate = false
    @Published var pendingCreation = DraftRecord()
    /// Team runs the host reports, ordered with the ones waiting on a person first.
    @Published var teams: [TeamRun] = []
    /// A selected team shows its dashboard in place of the session panes, which stay mounted.
    @Published var selectedTeamID: String? {
        didSet {
            if selectedTeamID != oldValue, let oldValue { pruneTeamModel(oldValue) }
            if selectedTeamID != nil { showingHome = false; showingCost = false; showingUnderstanding = false; selectedMissionID = nil }
        }
    }
    /// A selected mission shows its detail the same way; a mission and a team are never both open.
    @Published var selectedMissionID: String? {
        didSet {
            if selectedMissionID != oldValue, let oldValue { pruneMissionModel(oldValue) }
            if selectedMissionID != nil { showingHome = false; showingCost = false; showingUnderstanding = false; selectedTeamID = nil; teamOpenedFrom = nil }
        }
    }
    /// The mission whose subtask opened the current team page, so that page can lead back to it.
    @Published var teamOpenedFrom: String?
    /// Home, the project board, covers the session panes the same way; it is the first page after connecting.
    @Published var showingHome = true { didSet { if showingHome { showingCost = false; showingUnderstanding = false } } }
    /// The cost view covers the panes like Home; one of Home, Cost, a mission, or a team shows at a time.
    @Published var showingCost = false { didSet { if showingCost { showingHome = false; showingUnderstanding = false; selectedTeamID = nil; selectedMissionID = nil } } }
    /// Read-only workspace facts, separate from the existing project board.
    @Published var showingUnderstanding = false { didSet { if showingUnderstanding { showingHome = false; showingCost = false; selectedTeamID = nil; selectedMissionID = nil } } }
    /// Last workspace selected in Understand, so returning from another page preserves the scope.
    @Published var understandingWorkspaceID: String?
    private(set) var cost: CostModel?
    /// The project Home's board is narrowed to; nil shows every project.
    @Published var projectFilter: String?
    @Published private(set) var projectGroups = ProjectGroupList.empty
    @Published private(set) var board = Board.empty
    /// The last board poll succeeded; otherwise Home says why its rows may be old.
    @Published private(set) var boardFresh = false
    @Published private(set) var boardError = ""
    /// The owner's halt as the host last reported it. A failed poll keeps the last report.
    @Published private(set) var halt = HaltView.clear
    /// After the host refuses the halt route (an older host, or a remote channel without it), the next ask waits a minute.
    private var haltRetryAt = Date.distantPast
    @Published var pendingMissionCreation = DraftRecord()
    var missionModels: [String: MissionModel] = [:]
    @Published var showingCreateTeam = false
    @Published var pendingTeamCreation = DraftRecord()
    @Published private(set) var teamsFresh = false
    @Published private(set) var teamsDisplayStale = false
    @Published private(set) var teamsLoaded = false
    /// List Resume: runs with a resume in flight, and the last failure per run until dismissed or retried.
    @Published private(set) var resumingTeams: Set<String> = []
    @Published private(set) var teamResumeFailures: [String: TeamResumeFailure] = [:]
    var teamModels: [String: TeamModel] = [:]
    /// Resource samples are only fetched while a Resources window is showing them.
    var resourceWatchers = 0
    private static let keepAlive = 3
    let cmux = CmuxViewModel()
    private var connectionProfileID = ""
    private(set) var connectedProfileID: String?
    private var connectingClient: (generation: UUID, client: RemoteClient)?
    private func takeConnectingClient(for generation: UUID? = nil) -> RemoteClient? { guard let pending = connectingClient, generation == nil || pending.generation == generation else { return nil }; connectingClient = nil; return pending.client }
    private var creatingKinds = Set<String>()
    private var draftEpochs: [String: Int] = [:]
    private let draftQueue = DraftKeyQueue()
    private let deps: AppModelDependencies
    var client: RemoteClient?
    var terminals: [String: SessionModel] = [:]
    private var pollTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    private var displayGeneration = UUID()
    private var pollGeneration = UUID()
    private lazy var sessionFreshness = DisplayFreshness { [weak self] in self?.sessionsDisplayStale = $0 }
    private lazy var teamFreshness = DisplayFreshness { [weak self] in self?.teamsDisplayStale = $0 }
    var active: HostProfile? { profiles.first { $0.id == activeID } }
    var projects: [JSON] { me["projects"].array }
    var isOwner: Bool { me["role"].string == "owner" }
    /// The host's configured digest model, when any.
    var summaryModel: String? { let model = me["capabilities"]["summaries"]["model"].string; return model.isEmpty ? nil : model }
    var teamsEnabled: Bool { me["teams"]["enabled"].bool }
    /// The host keeps a usage ledger, so the cost view has figures to show.
    var usageEnabled: Bool { me["usage"]["enabled"].bool }
    func costModel() -> CostModel? {
        if let cost { return cost }
        guard let client else { return nil }
        let model = CostModel(client: client, owner: isOwner)
        model.setDisplayVisible(displayVisible)
        cost = model; return model
    }
    func showCost() { showingUnderstanding = false; showingCost = true }
    func showUnderstanding(workspace: String? = nil) {
        selectedTeamID = nil; selectedMissionID = nil; teamOpenedFrom = nil
        let requested = workspace ?? understandingWorkspaceID ?? projectFilter
        if let requested, projectGroups.group(requested) != nil { understandingWorkspaceID = requested }
        else if understandingWorkspaceID == nil { understandingWorkspaceID = projectGroups.groups.first?.id }
        showingCost = false; showingHome = false; showingUnderstanding = true
    }
    var teamLineup: JSON { me["teams"]["lineup"] }
    func projectName(_ id: String) -> String { projects.first { $0["id"].string == id }?["name"].string ?? id }
    /// Providers offered for a single-provider team, Claude Code first.
    var teamProviders: [String] { let all = me["providers"].array.map(\.string); return all.contains("claude") ? ["claude"] + all.filter { $0 != "claude" } : all }
    /// A team may only start in a workspace whose required checks the host configured.
    func teamWorkspaceReady(_ id: String) -> Bool { !(projects.first { $0["id"].string == id }?["team"]["checks"].array.isEmpty ?? true) }
    /// The workspace a new team starts in by default: the first one with checks configured.
    var defaultTeamWorkspace: String { (projects.first { !$0["team"]["checks"].array.isEmpty } ?? projects.first)?["id"].string ?? "" }
    init(deps: AppModelDependencies = .live) { self.deps = deps; (profiles, activeID) = deps.loadProfiles() }
    func start() { if active != nil { Task { await connect() } } }
    func setDisplayVisible(_ visible: Bool) {
        guard displayVisible != visible else { return }
        displayVisible = visible
        displayGeneration = UUID()
        for terminal in terminals.values { terminal.setDisplayVisible(visible) }
        for model in teamModels.values { model.setDisplayVisible(visible) }
        for model in missionModels.values { model.setDisplayVisible(visible) }
        cost?.setDisplayVisible(visible)
        cmux.setDisplayVisible(visible)
        if visible { startPolling() } else { stopPolling() }
    }

    /// Polling resumes after a failed refresh too: its next success reconnects the list, as before.
    private func startPolling() {
        guard pollTask == nil, client != nil, me != .null, displayVisible else { return }
        let connection = connectionGeneration
        let run = UUID(); pollGeneration = run
        pollTask = Task { [weak self] in
            var count = 0
            while !Task.isCancelled {
                guard let self, self.pollGeneration == run, self.connectionGeneration == connection, self.displayVisible else { break }
                await self.refresh(includeResources: self.resourceWatchers > 0 && count % 3 == 0)
                count += 1
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            guard let self, self.pollGeneration == run else { return }
            self.pollTask = nil
        }
    }

    private func stopPolling() {
        pollGeneration = UUID()
        pollTask?.cancel(); pollTask = nil
    }

    var visibleIDs: [String] { [selectedID, secondaryID].compactMap { $0 }.reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }
    private func mount(_ id: String?) {
        var next = mounted.filter { $0 != id }
        if let id { next.insert(id, at: 0) }
        // Visible panes always stay; the rest keep the most recent slots.
        let visible = visibleIDs
        let kept = next.filter { visible.contains($0) } + next.filter { !visible.contains($0) }
        let retained = Array(kept.prefix(max(Self.keepAlive, visible.count)))
        let evicted = mounted.filter { !retained.contains($0) }
        if retained != mounted { mounted = retained }
        for id in evicted { evict(id) }
    }
    func unmount(_ id: String) {
        mounted.removeAll { $0 == id }
        evict(id)
    }
    /// A pane leaving the cache detaches. Its model stays only while it holds draft text or an
    /// unconfirmed send, so a draft whose save failed is not lost with it; its screen and chat are released.
    private func evict(_ id: String) {
        guard let terminal = terminals[id] else { return }
        let retained = !terminal.draft.text.isEmpty || terminal.draft.pending != nil
        if !retained { terminals[id] = nil }
        Task { await terminal.detach(); if retained { terminal.releaseDisplay() } }
    }
    func persistProfiles() { deps.saveProfiles(profiles, activeID) }
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
        connectionError = ""
        let profile = active
        stopPolling(); connectionGeneration = UUID(); let generation = connectionGeneration
        let previousTerminals = Array(terminals.values); terminals.removeAll()
        for model in teamModels.values { model.stopPolling() }; for model in missionModels.values { model.stopPolling() }
        let previousClient = client; client = nil; connectedProfileID = nil; let supersededClient = takeConnectingClient()
        connected = false; connecting = true; sessions = []; sessionList = SessionList(); resources = .null; me = .null
        pendingCreation = DraftRecord(); pendingTeamCreation = DraftRecord(); pendingMissionCreation = DraftRecord()
        teams = []; selectedTeamID = nil; selectedMissionID = nil; teamOpenedFrom = nil; projectFilter = nil; showingHome = true; teamModels.removeAll(); teamResumeFailures = [:]; teamsFresh = false
        projectGroups = .empty; board = .empty; boardFresh = false; boardError = ""; missionModels.removeAll(); cost = nil
        halt = .clear; haltRetryAt = .distantPast
        showingUnderstanding = false; understandingWorkspaceID = nil
        sessionsLoaded = false; teamsLoaded = false
        sessionFreshness.recovered(); teamFreshness.recovered()
        if let supersededClient { await deps.closeClient(supersededClient) }
        for terminal in previousTerminals { await terminal.detach() }; if let previousClient { await deps.closeClient(previousClient) }
        guard generation == connectionGeneration else { return }; if activeID != (profile?.id ?? "") { connecting = false; return }
        selectedID = nil; secondaryID = nil; mounted = []; message = ""; guard let profile else { connecting = false; return }
        do {
            let next = RemoteClient(profile: profile, token: try deps.readToken(profile.id)); connectingClient = (generation, next)
            let identity = try await deps.fetchIdentity(next)
            guard generation == connectionGeneration, activeID == profile.id else { if generation == connectionGeneration { connecting = false }; if let stale = takeConnectingClient(for: generation) { await deps.closeClient(stale) }; return }
            guard let (createDraft, teamDraft, missionDraft) = try await readProfileDrafts(profile.id, generation: generation), generation == connectionGeneration, activeID == profile.id else { if generation == connectionGeneration && activeID != profile.id { connecting = false }; if let stale = takeConnectingClient(for: generation) { await deps.closeClient(stale) }; return }
            _ = takeConnectingClient(for: generation)
            client = next; connectedProfileID = profile.id; me = identity; pendingCreation = createDraft; pendingTeamCreation = teamDraft; pendingMissionCreation = missionDraft
            connected = true; connecting = false; persistProfiles(); connectionError = ""; startPolling()
        } catch {
            if let stale = takeConnectingClient(for: generation) { await deps.closeClient(stale) }
            guard generation == connectionGeneration else { return }
            connecting = false; message = error.localizedDescription; connectionError = error.localizedDescription; sessionFreshness.failed()
        }
    }
    private func readProfileDrafts(_ profileID: String, generation: UUID) async throws -> (DraftRecord, DraftRecord, DraftRecord)? {
        let keys = ["\(profileID):create", "\(profileID):create-team", "\(profileID):create-mission"]
        while true {
            let epochs = keys.map { draftEpochs[$0, default: 0] }
            let c = try await draftQueue.run(keys[0]) { try await self.deps.readDraft(keys[0]) }
            let t = try await draftQueue.run(keys[1]) { try await self.deps.readDraft(keys[1]) }
            let m = try await draftQueue.run(keys[2]) { try await self.deps.readDraft(keys[2]) }
            guard generation == connectionGeneration, activeID == profileID else { return nil }
            if keys.indices.allSatisfy({ draftEpochs[keys[$0], default: 0] == epochs[$0] }) { return (c, t, m) }
        }
    }
    func refresh(includeResources: Bool = true) async {
        guard displayVisible, let client else { return }
        let generation = connectionGeneration, visibility = displayGeneration
        do {
            // The poll names the version of the rows held: an unchanged list answers with its version alone.
            // Refreshes overlap (the poll and an action's refresh), so each answer goes back with the read it answers.
            let read = sessionList.begin()
            let answer = try await client.request(read.path)
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            var outcome = sessionList.accept(answer, to: read)
            if outcome == .unreadable {
                let plain = try await client.request("/sessions")
                guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
                outcome = sessionList.acceptPlain(plain, to: read)
            }
            if outcome == .replaced {
                let next = sessionList.rows.map(AgentSession.init).sorted {
                    if $0.needsYou != $1.needsYou { return $0.needsYou }
                    if $0.running != $1.running { return $0.running }
                    return $0.value["createdAt"].string > $1.value["createdAt"].string
                }
                // Only a real change may redraw the window.
                if next != sessions { sessions = next }
            }
            sessionsLoaded = true
            if !connected && connectedProfileID == activeID { connected = true }
            sessionFreshness.recovered()
            connectionError = ""
            if !message.isEmpty { message = "" }
            for session in sessions {
                if let terminal = terminals[session.id] {
                    terminal.observe(session.value)
                    if session.status == "running", terminal.observing && !terminal.attached { await terminal.attach() }
                }
            }
            if selectedID == nil { selectedID = (sessions.first { $0.running } ?? sessions.first)?.id }
            await refreshHalt(generation, visibility)
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if teamsEnabled || !teams.isEmpty { await refreshTeams(generation, visibility) }
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            await refreshBoard(generation, visibility)
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if includeResources {
                guard visibility == displayGeneration, displayVisible else { return }
                do {
                    let sample = try await client.request("/machine/resources")
                    if generation == connectionGeneration, visibility == displayGeneration, displayVisible { resources = sample }
                }
                catch {
                    guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
                    resources = .object(["unavailable": .string(error.localizedDescription)])
                }
            }
        } catch {
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            connected = false; message = error.localizedDescription
            sessionFreshness.failed()
            for terminal in terminals.values { terminal.connectionLost() }
        }
    }
    /// The team list is small and the whole list arrives each poll; only a real change redraws.
    private func refreshTeams(_ generation: UUID, _ visibility: UUID) async {
        guard displayVisible, generation == connectionGeneration, visibility == displayGeneration, let client else { return }
        do {
            let response = try await client.request("/teams?view=list")
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            let next = TeamRun.blockedFirst(response["teams"].array.map(TeamRun.init).sorted {
                if $0.needsYou != $1.needsYou { return $0.needsYou }
                if $0.finished != $1.finished { return $1.finished }
                return $0.createdAt > $1.createdAt
            })
            if next != teams { teams = next }
            if !teamResumeFailures.isEmpty {
                let retained = TeamResumeFailure.retainingExisting(teamResumeFailures, teamIDs: Set(next.map(\.id)))
                if retained != teamResumeFailures { teamResumeFailures = retained }
            }
            teamsLoaded = true
            for team in next { teamModels[team.id]?.observeListRow(team) }
            pruneDetailModels()
            if !teamsFresh { teamsFresh = true }
            teamFreshness.recovered()
        } catch {
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if teamsFresh { teamsFresh = false }
            teamFreshness.failed()
        }
    }
    /// The halt arrives whole each poll; only a real change redraws. A failed read keeps the last report; a refused
    /// route shows no halt, since the host offers none to this app, and is asked again a minute later.
    private func refreshHalt(_ generation: UUID, _ visibility: UUID) async {
        guard Date() >= haltRetryAt, displayVisible, generation == connectionGeneration, visibility == displayGeneration, let client else { return }
        do {
            let next = HaltView(try await client.request("/halt"))
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if next != halt { halt = next }
        } catch {
            guard generation == connectionGeneration, let refusal = error as? DesktopError,
                  refusal.status == 404 || refusal.code == "remote-endpoint-denied" else { return }
            haltRetryAt = Date().addingTimeInterval(60)
            if halt != .clear { halt = .clear }
        }
    }
    /// Projects and the board arrive whole each poll; only a real change redraws.
    private func refreshBoard(_ generation: UUID, _ visibility: UUID) async {
        guard displayVisible, generation == connectionGeneration, visibility == displayGeneration, let client else { return }
        do {
            let groups = ProjectGroupList(try await client.request("/project-groups"))
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            let next = Board(try await client.request("/board"))
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if groups != projectGroups { projectGroups = groups }
            if next != board { board = next }
            if let filter = projectFilter, groups.group(filter) == nil { projectFilter = nil }
            if let workspaceID = understandingWorkspaceID, groups.group(workspaceID) == nil { understandingWorkspaceID = nil }
            if !boardFresh { boardFresh = true }
            if !boardError.isEmpty { boardError = "" }
            pruneDetailModels()
        } catch {
            guard generation == connectionGeneration, visibility == displayGeneration, displayVisible else { return }
            if boardFresh { boardFresh = false }
            let text = (error as? DesktopError)?.status == 404 ? "This server has no project board yet. Update the host to use projects and missions." : error.localizedDescription
            if text != boardError { boardError = text }
        }
    }
    /// Home for every project, or narrowed to one.
    func showHome(project: String? = nil) {
        showingUnderstanding = false
        selectedTeamID = nil; selectedMissionID = nil; teamOpenedFrom = nil
        projectFilter = project; showingHome = true
    }
    /// A team page, remembering the mission it was opened from.
    func openTeam(_ id: String, from mission: String? = nil) { showingUnderstanding = false; selectedTeamID = id; teamOpenedFrom = mission }
    func missionModel(for id: String) -> MissionModel? {
        if let existing = missionModels[id] { return existing }
        guard let client else { return nil }
        // Until its first poll, the mission shows what its board row reported.
        let row = board.items.first { $0.id == id }
        let model = MissionModel(mission: Mission(.object(["id": .string(id), "title": .string(row?.title ?? ""), "status": .string(row?.status ?? ""), "groupName": .string(row?.projectName ?? "")])),
                                 client: client, role: me["role"].string)
        model.setDisplayVisible(displayVisible)
        missionModels[id] = model; return model
    }
    /// Missions start from the owner's sentence in one project. Retrying resends the identical body,
    /// so the host either recovers its recorded outcome or applies it once.
    private func clearPendingDraft(_ suffix: String, expectedProfileID: String? = nil, expectedRequestID: String? = nil, expectedID: @escaping @MainActor (AppModel) -> String?, clear: @escaping @MainActor (AppModel) -> Void) {
        let profileID = activeID, generation = connectionGeneration, key = "\(generation):\(suffix)", draftKey = "\(profileID):\(suffix)"
        guard let targetID = expectedID(self), expectedProfileID == nil || expectedProfileID == profileID, expectedRequestID == nil || expectedRequestID == targetID, !creatingKinds.contains(key) else { return }
        creatingKinds.insert(key)
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.creatingKinds.remove(key) }
            do { try await draftQueue.run(draftKey) { try await self.deps.clearDraftIfMatching(targetID, draftKey) }; draftEpochs[draftKey, default: 0] += 1; if self.connectionGeneration == generation && self.activeID == profileID && expectedID(self) == targetID { clear(self) } }
            catch { self.message = error.localizedDescription }
        }
    }
    private func submitPendingCreate(kind: String, path: String, current: DraftRecord, currentID: @escaping @MainActor (AppModel) -> String?, setPending: (DraftRecord) -> Void, buildBody: (String) throws -> JSON) async throws -> JSON {
        guard connected, let client, connectedProfileID == activeID else { throw DesktopError("Connect to a server first.") }
        let profileID = activeID, generation = connectionGeneration, key = "\(generation):\(kind)", draftKey = "\(profileID):\(kind)"
        guard !creatingKinds.contains(key) else { throw DesktopError("A request is already in progress.") }
        creatingKinds.insert(key); defer { creatingKinds.remove(key) }
        var activeRecord = current
        if activeRecord.pending == nil {
            let requestID = UUID().uuidString.lowercased()
            let record = DraftRecord(pending: PendingSend(id: requestID, text: String(decoding: try buildBody(requestID).data(), as: UTF8.self)))
            setPending(record); activeRecord = record
            do { try await draftQueue.run(draftKey) { try await self.deps.saveDraft(record, draftKey) }; draftEpochs[draftKey, default: 0] += 1 }
            catch { if generation == connectionGeneration && activeID == profileID { setPending(current) }; throw error }
        }
        guard generation == connectionGeneration && activeID == profileID else { throw DesktopError("Profile changed before sending the request.") }
        guard let activePending = activeRecord.pending else { throw DesktopError("Review the pending request before starting another.") }
        let result = try await deps.sendRequest(client, path, JSON.parse(Data(activePending.text.utf8)))
        try await draftQueue.run(draftKey) { try await self.deps.clearDraftIfMatching(activePending.id, draftKey) }; draftEpochs[draftKey, default: 0] += 1
        if activeID == profileID && currentID(self) == activePending.id { setPending(DraftRecord()) }
        return result
    }
    func createMission(groupID: String, objective: String) async throws {
        let generation = connectionGeneration
        let result = try await submitPendingCreate(kind: "create-mission", path: "/missions", current: pendingMissionCreation, currentID: { $0.pendingMissionCreation.pending?.id }, setPending: { pendingMissionCreation = $0 }) {
            .object(["requestId": .string($0), "groupId": .string(groupID), "objective": .string(objective.trimmingCharacters(in: .whitespacesAndNewlines))])
        }
        guard generation == connectionGeneration else { return }
        await refresh(); let id = result["id"].string.isEmpty ? result["mission"]["id"].string : result["id"].string
        if generation == connectionGeneration && !id.isEmpty { selectedMissionID = id }
    }
    func clearMissionCreation(expectedProfileID: String? = nil, expectedRequestID: String? = nil) { clearPendingDraft("create-mission", expectedProfileID: expectedProfileID, expectedRequestID: expectedRequestID, expectedID: { $0.pendingMissionCreation.pending?.id }) { $0.pendingMissionCreation = DraftRecord() } }
    /// Resume from the Home list: the same request as the team page, with its failure kept for the row.
    func resumeTeam(_ id: String) async {
        guard !resumingTeams.contains(id), let model = teamModel(for: id) else { return }
        guard !model.busy, model.pending == nil else {
            teamResumeFailures[id] = TeamResumeFailure(message: "Another request for this team is unconfirmed or in progress. Open the team to check it.")
            return
        }
        resumingTeams.insert(id)
        teamResumeFailures[id] = nil
        // A kept model holds its last full read. When the list has passed it, read the run again: resume names the
        // run's revision, and the run may no longer be one a list can resume.
        if model.behind { await model.poll() }
        guard !model.behind, model.run.offersResume else {
            resumingTeams.remove(id)
            teamResumeFailures[id] = TeamResumeFailure(message: model.behind
                ? "This team changed and could not be read again. Try again, or open the team."
                : "This team can no longer be resumed from here. Open the team to see where it stands.")
            pruneTeamModel(id)
            return
        }
        await model.perform("resume")
        resumingTeams.remove(id)
        teamResumeFailures[id] = model.noticeIsError ? TeamResumeFailure(message: model.notice) : nil
        pruneTeamModel(id)
    }
    func clearTeamResumeFailure(_ id: String) { teamResumeFailures[id] = nil }
    func teamModel(for id: String) -> TeamModel? {
        if let existing = teamModels[id] { return existing }
        guard let client else { return nil }
        // A subteam the team list has not reported yet starts from its ID; its first poll fills it in.
        let team = teams.first { $0.id == id } ?? TeamRun(.object(["id": .string(id)]))
        let model = TeamModel(run: team, client: client, role: me["role"].string)
        model.setDisplayVisible(displayVisible)
        teamModels[id] = model; return model
    }
    /// A page left with an unsent direction or an unconfirmed request keeps its model.
    private func pruneTeamModel(_ id: String) { guard id != selectedTeamID, let model = teamModels[id], !model.busy, model.pending == nil, model.direction.isEmpty else { return }; model.stopPolling(); teamModels[id] = nil }
    private func pruneMissionModel(_ id: String) { guard id != selectedMissionID, let model = missionModels[id], !model.busy, model.pending == nil, model.direction.isEmpty else { return }; model.stopPolling(); missionModels[id] = nil }
    private func pruneDetailModels() { for id in Array(teamModels.keys) { pruneTeamModel(id) }; for id in Array(missionModels.keys) { pruneMissionModel(id) } }
    /// Leaving a team for one of its member sessions.
    func openSession(_ id: String) { selectedTeamID = nil; selectedMissionID = nil; showingUnderstanding = false; showingHome = false; showingCost = false; selectedID = id }
    func createTeam(projectID: String, provider: String, useLineup: Bool, title: String, objective: String) async throws {
        let generation = connectionGeneration
        let result = try await submitPendingCreate(kind: "create-team", path: "/teams", current: pendingTeamCreation, currentID: { $0.pendingTeamCreation.pending?.id }, setPending: { pendingTeamCreation = $0 }) { requestID in
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines), request = objective.trimmingCharacters(in: .whitespacesAndNewlines)
            let firstLine = request.split(whereSeparator: \.isNewline).first.map(String.init) ?? request
            var fields: [String: JSON] = ["requestId": .string(requestID), "projectId": .string(projectID), "provider": .string(provider),
                                          "title": .string(name.isEmpty ? String(firstLine.prefix(100)) : name), "objective": .string(request)]
            if useLineup { fields["useConfiguredLineup"] = .bool(true) }
            return .object(fields)
        }
        guard generation == connectionGeneration else { return }
        await refresh(); if generation == connectionGeneration { selectedTeamID = result["id"].string.isEmpty ? nil : result["id"].string; showingCreateTeam = false }
    }
    func clearTeamCreation(expectedProfileID: String? = nil, expectedRequestID: String? = nil) { clearPendingDraft("create-team", expectedProfileID: expectedProfileID, expectedRequestID: expectedRequestID, expectedID: { $0.pendingTeamCreation.pending?.id }) { $0.pendingTeamCreation = DraftRecord() } }
    func model(for id: String) -> SessionModel? {
        if let existing = terminals[id] { return existing }
        guard let session = sessions.first(where: { $0.id == id }), let client else { return nil }
        let model = SessionModel(session: session, client: client, profileID: activeID, role: me["role"].string, supportsStream: me["capabilities"]["remoteTerminal"].int == 1, summaryModel: summaryModel)
        model.setDisplayVisible(displayVisible); terminals[id] = model; return model
    }
    func create(provider: String, project: String, title: String) async throws {
        let generation = connectionGeneration
        let result = try await submitPendingCreate(kind: "create", path: "/sessions", current: pendingCreation, currentID: { $0.pendingCreation.pending?.id }, setPending: { pendingCreation = $0 }) { requestID in
            var fields: [String: JSON] = ["requestId": .string(requestID), "provider": .string(provider), "projectId": .string(project), "title": .string(title.isEmpty ? "\(provider.capitalized) session" : title), "prompt": .string("")]
            if title.isEmpty { fields["generatedTitle"] = .bool(true) }
            return .object(fields)
        }
        guard generation == connectionGeneration else { return }
        await refresh(); if generation == connectionGeneration { openSession(result["id"].string.isEmpty ? result["session"]["id"].string : result["id"].string); showingCreate = false }
    }
    func clearCreation(expectedProfileID: String? = nil, expectedRequestID: String? = nil) { clearPendingDraft("create", expectedProfileID: expectedProfileID, expectedRequestID: expectedRequestID, expectedID: { $0.pendingCreation.pending?.id }) { $0.pendingCreation = DraftRecord() } }
    func end(_ id: String) async { guard let model = model(for: id) else { return }; await model.end(); await refresh() }
    func forget() async {
        guard let active else { return }
        stopPolling(); for terminal in terminals.values { await terminal.detach() }; if let client { await client.close() }
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
    @Published var sending = false
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
    private var displayVisible = false
    /// Where the chat stood when this Mac last looked at it; the digest starts there.
    private var readCursor: String
    private static let readCursorsKey = "readCursors"
    let pipe = TerminalPipe()
    let client: RemoteClient
    let deps: SessionModelDependencies
    let profileID: String
    let role: String
    let supportsStream: Bool
    private var streamID: String?
    private var renewal: Task<Void, Never>?
    var attachGeneration = UUID()
    var controlGeneration = UUID()
    var saveTask: Task<Void, Never>?
    var saveInFlight: Task<Void, Never>?
    var draftLoadTask: Task<Void, Never>?
    var activeSendToken: UUID?
    var draftVersion = 0
    var draftLoaded = false
    var draftTouched = false
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
    var canSend: Bool { ready && !busy && draftLoaded && draft.pending == nil && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// A provider prompt is answered without the input lease or an attached terminal. A mission-managed session needs only that it is running.
    var canAnswerPrompt: Bool { role != "viewer" && !answering && (managed ? session.running : ready) }
    var managed: Bool { session.managed }
    /// Whether the terminal fallback is open to the owner; see `AgentSession.terminalOpen`.
    var terminalOpen: Bool { session.terminalOpen }
    /// The open dialog, when the host reports one.
    var prompt: JSON? { let value = session.value["attention"]["prompt"]; return value == .null ? nil : value }
    /// Another device currently holds the input lease.
    var otherHolder: String? { hasControl || holder.isEmpty ? nil : holder }
    init(session: AgentSession, client: RemoteClient, profileID: String, role: String, supportsStream: Bool, summaryModel: String? = nil, deps: SessionModelDependencies = .live) {
        self.session = session; self.client = client; self.profileID = profileID; self.role = role; self.supportsStream = supportsStream; self.summaryModel = summaryModel; self.deps = deps
        readCursor = (UserDefaults.standard.dictionary(forKey: Self.readCursorsKey) as? [String: String])?["\(profileID):\(session.id)"] ?? ""
        draftLoadTask = Task { @MainActor [weak self] in await self?.loadInitialDraft() }
    }
    func showScreen() { screenShown = true; view = .screen }
    func setDisplayVisible(_ visible: Bool) { guard displayVisible != visible else { return }; displayVisible = visible; if visible, observing { startChat() } else { stopChat() } }

    // ---- Chat ---------------------------------------------------------------------------
    /// Polls the host's chat record while this session is observed. Messages are the provider's
    /// own transcript when the host has it, otherwise the prompts this device delivered.
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
            let value = try await deps.sendRequest(client, "/sessions/\(session.id)/summary\(after)", nil, nil)
            summary = ChatSummary(model: value["model"].string, text: value["text"].string, messages: value["messages"].int)
        } catch { summaryError = error.localizedDescription }
        summaryBusy = false
    }
    func dismissSummary() { summary = nil; summaryError = "" }
    /// Answers the open dialog by option or text. The host presses keys on the dialog it shows
    /// and reports whether it closed; nothing here approves anything on its own.
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
        rendererUnavailable = true; snapshotReady = false; directInput = false; queuedRaw = Data(); notice = message
    }
    func rendererRestored(_ generation: UUID) {
        guard generation == rendererGeneration, receivedScreen, snapshotReady else { return }
        rendererUnavailable = false
    }
    func attach() async {
        observing = true
        if chatTask == nil, displayVisible { startChat() }
        // A mission-managed session's terminal stays readable; only its input waits for an open prompt.
        guard streamID == nil, !busy else { return }
        guard supportsStream && session.backend != "cmux" else { notice = "This host does not provide a live byte stream for this session. Update the host or use the cmux connection."; return }
        attachGeneration = UUID(); let current = attachGeneration
        busy = true; snapshotReady = false; receivedScreen = false; rendererUnavailable = true
        queuedRaw = Data(); sendingRaw = false
        rendererGeneration = UUID(); pipe.feed(Data(), reset: true)
        do {
            let id = try await deps.openTerminal(client, session.id) { [weak self] message in
                Task { @MainActor in guard let self, self.attachGeneration == current else { return }; self.receive(message) }
            }
            guard current == attachGeneration else { await deps.closeTerminal(client, id); return }
            streamID = id; attached = true
            if draft.pending == nil { notice = "" }
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
        if !lease["id"].string.isEmpty && (control["id"] != lease["id"] || session.status != "running" || !session.terminalOpen) {
            controlGeneration = UUID(); lease = .null; directInput = false; queuedRaw = Data(); sendingRaw = false; renewal?.cancel()
        }
    }
    func claim(takeover: Bool = false) async {
        // A mission-managed session accepts a control claim only while its provider prompt waits for the owner.
        guard attached, terminalOpen else { return }
        let attachment = attachGeneration
        controlGeneration = UUID(); let operation = controlGeneration
        queuedRaw = Data(); sendingRaw = false
        renewal?.cancel()
        do {
            let response = try await deps.sendRequest(client, "/sessions/\(session.id)/control", .object(["action": .string("claim"), "takeover": .bool(takeover)]), nil)
            guard attachment == attachGeneration, operation == controlGeneration, attached else { return }
            lease = response["control"]; holder = lease["label"].string
            guard hasControl else { throw DesktopError("Control was not granted.") }
            if draft.pending == nil { notice = "" }
            let leaseID = lease["id"]
            renewal = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard !Task.isCancelled, attachment == self.attachGeneration, operation == self.controlGeneration,
                          self.lease["id"] == leaseID, self.hasControl else { return }
                    do {
                        let result = try await self.deps.sendRequest(self.client, "/sessions/\(self.session.id)/control", .object(["action": .string("renew"), "leaseId": leaseID]), nil)
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
        if !old["id"].string.isEmpty { _ = try? await deps.sendRequest(client, "/sessions/\(session.id)/control", .object(["action": .string("release"), "leaseId": old["id"]]), nil) }
    }
    /// Sending claims the input lease itself; a lease held elsewhere is taken over.
    func ensureControl() async -> Bool {
        if hasControl { return true }
        guard ready, terminalOpen else { return false }
        await claim(takeover: !holder.isEmpty)
        return hasControl
    }
    func setDirectInput(_ enabled: Bool) {
        if !enabled { directInput = false; queuedRaw = Data(); return }
        guard screenReady else { return }
        Task { if await ensureControl() { directInput = true } }
    }
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
        try await deps.sendTerminal(client, stream, .object(["op": .string("raw"), "requestId": .string(UUID().uuidString.lowercased()), "text": .string(text), "leaseId": leaseID]))
    }
    func resize(_ cols: Int, _ rows: Int) async {
        lastSize = (cols, rows)
        guard hasControl, let streamID else { return }
        try? await deps.sendTerminal(client, streamID, .object(["op": .string("resize"), "cols": .number(Double(min(240, max(20, cols)))), "rows": .number(Double(min(100, max(5, rows)))), "leaseId": lease["id"]]))
    }
    func connectionLost() {
        controlGeneration = UUID()
        let previous = streamID; streamID = nil; attachGeneration = UUID()
        attached = false; busy = false; sending = false; snapshotReady = false; rendererUnavailable = true; lease = .null; directInput = false; queuedRaw = Data(); renewal?.cancel()
        if let previous { Task { await deps.closeTerminal(client, previous) } }
        notice = "Connection lost. Your draft stays here; reconnect to check server status."
    }
    func detach() async {
        let previous = streamID, previousLease = lease
        observing = false
        stopChat(); markRead()
        controlGeneration = UUID()
        attachGeneration = UUID(); snapshotReady = false; rendererUnavailable = true
        streamID = nil; attached = false; busy = false; sending = false; lease = .null; directInput = false; queuedRaw = Data(); renewal?.cancel()
        saveTask?.cancel(); saveTask = nil; try? await persistDraft(flush: true)
        if !previousLease["id"].string.isEmpty {
            _ = try? await deps.sendRequest(client, "/sessions/\(session.id)/control", .object(["action": .string("release"), "leaseId": previousLease["id"]]), nil)
        }
        if let previous { await deps.closeTerminal(client, previous) }
    }
    /// Drops the screen and chat kept for display after this session left the pane cache. Attaching again reloads both.
    func releaseDisplay() {
        guard !observing else { return }
        pipe.clear()
        messages = []; messagesCursor = ""; messageSource = ""; unread = 0; summary = nil
        chatNote = "Loading the conversation…"
    }
}
