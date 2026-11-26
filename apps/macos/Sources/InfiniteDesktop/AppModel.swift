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
    var now: String { value["attention"]["now"].string }
    var backend: String { value["backend"].string }
    var managedBy: SessionManagement? { try? value["managedBy"].decoded() }
    var managed: Bool { managedBy != nil }
    var terminalOpen: Bool { !managed || needsYou }
    private static let ended: Set<String> = ["exited", "unavailable", "recording-error"]
    var running: Bool { (status == "running" || status == "starting") && !Self.ended.contains(attention) }
    var needsYou: Bool { running && attention == "needs-you" }
    var recordingError: Bool { status == "recording-error" || attention == "recording-error" }
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

struct TeamResumeFailure: Equatable {
    let message: String

    static func retainingExisting(_ failures: [String: TeamResumeFailure], teamIDs: Set<String>) -> [String: TeamResumeFailure] {
        Dictionary(uniqueKeysWithValues: failures.filter { teamIDs.contains($0.key) })
    }
}

enum WorkspaceRoute: Equatable {
    case home
    case understanding
    case cost
    case mission(String)
    case team(id: String, fromMission: String?)
    case sessions
}

enum HostConnectionState: Equatable {
    case disconnected(error: String = "")
    case connecting(profileID: String)
    case connected
    case offline(error: String)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    var isConnecting: Bool {
        if case .connecting = self { return true }
        return false
    }

    var error: String {
        switch self {
        case .disconnected(let error), .offline(let error): return error
        case .connecting, .connected: return ""
        }
    }

    var connectingProfileID: String? {
        if case .connecting(let profileID) = self { return profileID }
        return nil
    }
}

@MainActor final class AppModel: ObservableObject {
    @Published var profiles: [HostProfile] = []
    @Published var activeID = "" {
        didSet {
            if activeID != oldValue {
                connectionGeneration = UUID()
                if let aborted = takeConnectingClient() {
                    Task { @MainActor [weak self] in await self?.deps.closeClient(aborted) }
                }
                if connectedProfileID != nil { connectedProfileID = nil }
                if connectionState != .disconnected() { connectionState = .disconnected() }
            }
        }
    }
    @Published var me: JSON = .null
    @Published var sessions: [AgentSession] = []
    private var sessionList = SessionList()
    @Published var resources: JSON = .null
    @Published var selectedID: String? { didSet { if selectedID != oldValue { mount(selectedID) } } }
    @Published var secondaryID: String? { didSet { if secondaryID != oldValue { mount(secondaryID) } } }
    @Published private(set) var mounted: [String] = []
    @Published private(set) var connectionState: HostConnectionState = .disconnected()
    @Published private(set) var displayVisible = false
    @Published private(set) var sessionsDisplayStale = false
    @Published private(set) var sessionsLoaded = false
    @Published var message = ""
    @Published var showingPair = false
    @Published var showingCreate = false
    @Published var pendingCreation = DraftRecord()
    @Published var teams: [TeamRun] = []
    @Published var route: WorkspaceRoute = .home {
        didSet {
            guard route != oldValue else { return }
            if case .team(let oldTeam, _) = oldValue { pruneTeamModel(oldTeam) }
            if case .mission(let oldMission) = oldValue { pruneMissionModel(oldMission) }
        }
    }
    @Published var understandingWorkspaceID: String?
    private(set) var cost: CostModel?
    @Published var projectFilter: String?
    @Published private(set) var projectGroups = ProjectGroupList.empty
    @Published private(set) var board = Board.empty
    @Published private(set) var boardFresh = false
    @Published private(set) var boardError = ""
    @Published private(set) var halt = HaltView.clear
    private var haltRetryAt = Date.distantPast
    @Published var pendingMissionCreation = DraftRecord()
    var missionModels: [String: MissionModel] = [:]
    @Published var showingCreateTeam = false
    @Published var pendingTeamCreation = DraftRecord()
    @Published private(set) var teamsFresh = false
    @Published private(set) var teamsDisplayStale = false
    @Published private(set) var teamsLoaded = false
    @Published private(set) var resumingTeams: Set<String> = []
    @Published private(set) var teamResumeFailures: [String: TeamResumeFailure] = [:]
    var teamModels: [String: TeamModel] = [:]
    var resourceWatchers = 0
    private static let keepAlive = 3
    let cmux = CmuxViewModel()
    private(set) var connectedProfileID: String?
    private var connectingClient: (generation: UUID, client: RemoteClient)?
    private func takeConnectingClient(for generation: UUID? = nil) -> RemoteClient? {
        guard let pending = connectingClient, generation == nil || pending.generation == generation else { return nil }
        connectingClient = nil
        return pending.client
    }
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

    var connected: Bool { connectionState.isConnected }
    var connecting: Bool { connectionState.isConnecting }
    var connectionError: String { connectionState.error }
    var showingHome: Bool { route == .home }
    var showingCost: Bool { route == .cost }
    var showingUnderstanding: Bool { route == .understanding }
    var selectedTeamID: String? { if case .team(let id, _) = route { return id }; return nil }
    var selectedMissionID: String? { if case .mission(let id) = route { return id }; return nil }
    var teamOpenedFrom: String? { if case .team(_, let mission) = route { return mission }; return nil }

    var active: HostProfile? { profiles.first { $0.id == activeID } }
    var projects: [JSON] { me["projects"].array }
    var isOwner: Bool { me["role"].string == "owner" }
    var summaryModel: String? { let model = me["capabilities"]["summaries"]["model"].string; return model.isEmpty ? nil : model }
    var teamsEnabled: Bool { me["teams"]["enabled"].bool }
    var usageEnabled: Bool { me["usage"]["enabled"].bool }
    func costModel() -> CostModel? {
        if let cost { return cost }
        guard let client else { return nil }
        let model = CostModel(client: client, owner: isOwner)
        model.setDisplayVisible(displayVisible)
        cost = model; return model
    }
    func showCost() { route = .cost }
    func showUnderstanding(workspace: String? = nil) {
        let requested = workspace ?? understandingWorkspaceID ?? projectFilter
        if let requested, projectGroups.group(requested) != nil { understandingWorkspaceID = requested }
        else if understandingWorkspaceID == nil { understandingWorkspaceID = projectGroups.groups.first?.id }
        route = .understanding
    }
    var teamLineup: JSON { me["teams"]["lineup"] }
    func projectName(_ id: String) -> String { projects.first { $0["id"].string == id }?["name"].string ?? id }
    var teamProviders: [String] { let all = me["providers"].array.map(\.string); return all.contains("claude") ? ["claude"] + all.filter { $0 != "claude" } : all }
    func teamWorkspaceReady(_ id: String) -> Bool { !(projects.first { $0["id"].string == id }?["team"]["checks"].array.isEmpty ?? true) }
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
        if connectionState.connectingProfileID == activeID { return }
        let profile = active
        stopPolling(); connectionGeneration = UUID(); let generation = connectionGeneration
        let previousTerminals = Array(terminals.values); terminals.removeAll()
        for model in teamModels.values { model.stopPolling() }; for model in missionModels.values { model.stopPolling() }
        let previousClient = client; client = nil; connectedProfileID = nil; let supersededClient = takeConnectingClient()
        connectionState = .connecting(profileID: activeID)
        sessions = []; sessionList = SessionList(); resources = .null; me = .null
        pendingCreation = DraftRecord(); pendingTeamCreation = DraftRecord(); pendingMissionCreation = DraftRecord()
        teams = []; projectFilter = nil; route = .home; teamModels.removeAll(); teamResumeFailures = [:]; teamsFresh = false
        projectGroups = .empty; board = .empty; boardFresh = false; boardError = ""; missionModels.removeAll(); cost = nil
        halt = .clear; haltRetryAt = .distantPast
        understandingWorkspaceID = nil
        sessionsLoaded = false; teamsLoaded = false
        sessionFreshness.recovered(); teamFreshness.recovered()
        if let supersededClient { await deps.closeClient(supersededClient) }
        for terminal in previousTerminals { await terminal.detach() }; if let previousClient { await deps.closeClient(previousClient) }
        guard generation == connectionGeneration else { return }
        if activeID != (profile?.id ?? "") { connectionState = .disconnected(); return }
        selectedID = nil; secondaryID = nil; mounted = []; message = ""
        guard let profile else { connectionState = .disconnected(); return }
        do {
            let next = RemoteClient(profile: profile, token: try deps.readToken(profile.id)); connectingClient = (generation, next)
            let identity = try await deps.fetchIdentity(next)
            guard generation == connectionGeneration, activeID == profile.id else {
                if generation == connectionGeneration { connectionState = .disconnected() }
                if let stale = takeConnectingClient(for: generation) { await deps.closeClient(stale) }
                return
            }
            guard let (createDraft, teamDraft, missionDraft) = try await readProfileDrafts(profile.id, generation: generation),
                  generation == connectionGeneration, activeID == profile.id else {
                if generation == connectionGeneration && activeID != profile.id { connectionState = .disconnected() }
                if let stale = takeConnectingClient(for: generation) { await deps.closeClient(stale) }
                return
            }
            _ = takeConnectingClient(for: generation)
            client = next; connectedProfileID = profile.id; me = identity
            pendingCreation = createDraft; pendingTeamCreation = teamDraft; pendingMissionCreation = missionDraft
            connectionState = .connected; persistProfiles(); startPolling()
        } catch {
            if let stale = takeConnectingClient(for: generation) { await deps.closeClient(stale) }
            guard generation == connectionGeneration else { return }
            message = error.localizedDescription
            connectionState = client == nil ? .disconnected(error: error.localizedDescription) : .offline(error: error.localizedDescription)
            sessionFreshness.failed()
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
                if next != sessions { sessions = next }
            }
            sessionsLoaded = true
            if !connected && connectedProfileID == activeID { connectionState = .connected }
            sessionFreshness.recovered()
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
            connectionState = .offline(error: error.localizedDescription)
            message = error.localizedDescription
            sessionFreshness.failed()
            for terminal in terminals.values { terminal.connectionLost() }
        }
    }
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
    func showHome(project: String? = nil) {
        projectFilter = project
        route = .home
    }
    func openMission(_ id: String) {
        route = .mission(id)
    }
    func openTeam(_ id: String, from mission: String? = nil) {
        route = .team(id: id, fromMission: mission)
    }
    func missionModel(for id: String) -> MissionModel? {
        if let existing = missionModels[id] { return existing }
        guard let client else { return nil }
        let row = board.items.first { $0.id == id }
        let model = MissionModel(mission: Mission(.object(["id": .string(id), "title": .string(row?.title ?? ""), "status": .string(row?.status ?? ""), "groupName": .string(row?.projectName ?? "")])),
                                 client: client, role: me["role"].string)
        model.setDisplayVisible(displayVisible)
        missionModels[id] = model; return model
    }
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
        if generation == connectionGeneration && !id.isEmpty { openMission(id) }
    }
    func clearMissionCreation(expectedProfileID: String? = nil, expectedRequestID: String? = nil) { clearPendingDraft("create-mission", expectedProfileID: expectedProfileID, expectedRequestID: expectedRequestID, expectedID: { $0.pendingMissionCreation.pending?.id }) { $0.pendingMissionCreation = DraftRecord() } }
    func resumeTeam(_ id: String) async {
        guard !resumingTeams.contains(id), let model = teamModel(for: id) else { return }
        guard !model.busy, model.pending == nil else {
            teamResumeFailures[id] = TeamResumeFailure(message: "Another request for this team is unconfirmed or in progress. Open the team to check it.")
            return
        }
        resumingTeams.insert(id)
        teamResumeFailures[id] = nil
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
        let team = teams.first { $0.id == id } ?? TeamRun(.object(["id": .string(id)]))
        let model = TeamModel(run: team, client: client, role: me["role"].string)
        model.setDisplayVisible(displayVisible)
        teamModels[id] = model; return model
    }
    private func pruneTeamModel(_ id: String) {
        guard id != selectedTeamID, let model = teamModels[id], !model.busy, model.pending == nil, model.direction.isEmpty else { return }
        model.stopPolling(); teamModels[id] = nil
    }
    private func pruneMissionModel(_ id: String) {
        guard id != selectedMissionID, let model = missionModels[id], !model.busy, model.pending == nil, model.direction.isEmpty else { return }
        model.stopPolling(); missionModels[id] = nil
    }
    private func pruneDetailModels() {
        for id in Array(teamModels.keys) { pruneTeamModel(id) }
        for id in Array(missionModels.keys) { pruneMissionModel(id) }
    }
    func openSession(_ id: String) { route = .sessions; selectedID = id }
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
        await refresh(); if generation == connectionGeneration {
            let id = result["id"].string
            if !id.isEmpty { openTeam(id) }
            showingCreateTeam = false
        }
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
        await refresh(); if generation == connectionGeneration {
            let id = result["id"].string.isEmpty ? result["session"]["id"].string : result["id"].string
            if !id.isEmpty { openSession(id) }
            showingCreate = false
        }
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
