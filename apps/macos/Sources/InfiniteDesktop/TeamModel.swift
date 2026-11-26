import SwiftUI
import InfiniteCore

struct TeamMutation: Equatable {
    let requestID: String
    let path: String
    let body: JSON
    let label: String
}

enum MutationState: Equatable {
    case idle
    case sending(pending: TeamMutation?)
    case unconfirmed(TeamMutation)

    var isSending: Bool {
        if case .sending = self { return true }
        return false
    }

    var pending: TeamMutation? {
        switch self {
        case .idle: return nil
        case .sending(let pending): return pending
        case .unconfirmed(let pending): return pending
        }
    }
}

struct TeamSeed: Equatable, Sendable {
    let id: String
    let title: String
    let status: String
    let projectID: String
    let missionID: String

    init(
        id: String,
        title: String = "",
        status: String = "",
        projectID: String = "",
        missionID: String = ""
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.projectID = projectID
        self.missionID = missionID
    }

    var typedStatus: TeamRun.Status { TeamRun.Status(status) }

    var statusLabel: String {
        guard !status.isEmpty else { return "" }
        return TeamRun.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirst
    }

    var managedByMission: Bool { !missionID.isEmpty }

    var progressFraction: Double {
        switch typedStatus {
        case .readyForReview, .merged, .delivering: return 1.0
        case .verifying, .reviewing: return 0.75
        case .integrating: return 0.5
        case .planning, .discovering, .implementing, .needsInput, .paused, .blocked, .noChange, .cancelled, .unknown:
            return 0.25
        }
    }
}

enum TeamLoadState: Equatable, Sendable {
    case loading(seed: TeamSeed, error: String?)
    case listSeed(TeamRun, error: String?)
    case loaded(TeamRun, latestListRow: TeamRun?)

    var id: String {
        switch self {
        case .loading(let seed, _): return seed.id
        case .listSeed(let run, _), .loaded(let run, _): return run.id
        }
    }

    var run: TeamRun? {
        switch self {
        case .loading: return nil
        case .listSeed(let run, _), .loaded(let run, _): return run
        }
    }

    var isLoaded: Bool {
        if case .loaded = self { return true }
        return false
    }

    var loadError: String? {
        switch self {
        case .loading(_, let error), .listSeed(_, let error): return error
        case .loaded: return nil
        }
    }

    var title: String {
        switch self {
        case .loading(let seed, _): return seed.title
        case .listSeed(let run, _), .loaded(let run, _): return run.title
        }
    }

    var status: String {
        switch self {
        case .loading(let seed, _): return seed.status
        case .listSeed(let run, _), .loaded(let run, _): return run.status
        }
    }

    var statusLabel: String {
        switch self {
        case .loading(let seed, _): return seed.statusLabel
        case .listSeed(let run, _), .loaded(let run, _): return run.statusLabel
        }
    }

    var projectID: String {
        switch self {
        case .loading(let seed, _): return seed.projectID
        case .listSeed(let run, _), .loaded(let run, _): return run.projectID
        }
    }

    var missionID: String {
        switch self {
        case .loading(let seed, _): return seed.missionID
        case .listSeed(let run, _), .loaded(let run, _): return run.missionID
        }
    }

    var managedByMission: Bool {
        switch self {
        case .loading(let seed, _): return seed.managedByMission
        case .listSeed(let run, _), .loaded(let run, _): return run.managedByMission
        }
    }
}

@MainActor final class TeamModel: ObservableObject {
    private enum PollOutcome {
        case updated
        case skipped
        case failed(String)
    }

    @Published private(set) var loadState: TeamLoadState
    @Published var direction = ""
    @Published private(set) var mutationState: MutationState = .idle
    @Published private(set) var notice = ""
    @Published private(set) var noticeIsError = false
    @Published private(set) var fresh = false
    @Published private(set) var displayStale = false

    var busy: Bool { mutationState.isSending }
    var pending: TeamMutation? { mutationState.pending }

    let role: String
    private let client: RemoteClient
    private let sendRequest: @Sendable (RemoteClient, String, JSON?) async throws -> JSON
    private var pollTask: Task<Void, Never>?
    private var pageShown = false
    private var displayVisible = false
    private var refreshToken: UUID?

    var behind: Bool {
        guard case .loaded(let run, let listed?) = loadState, Self.later(listed, than: run) else { return false }
        return Self.controlState(listed) != Self.controlState(run)
    }

    private static func controlState(_ run: TeamRun) -> [JSON] {
        [.number(Double(run.revision)), .string(run.status), .string(run.missionID), .bool(run.value["continuable"].bool), .bool(run.value["resumable"].bool),
         .bool(run.value["goal"] != .null), .bool(run.value["deliveryReceipt"] != .null), .bool(run.value["pullRequest"] != .null)]
    }

    private static func later(_ next: TeamRun, than run: TeamRun) -> Bool {
        next.revision > run.revision || (next.revision == run.revision && next.updatedAt > run.updatedAt)
    }

    private static func supersedes(_ next: TeamRun, _ current: TeamRun) -> Bool {
        next.revision > current.revision || (next.revision == current.revision && next.updatedAt >= current.updatedAt)
    }

    private var pollGeneration = UUID()
    private var latestPollAttempt: UInt64 = 0
    private var inFlightPoll: (attempt: UInt64, task: Task<PollOutcome, Never>)?
    private lazy var freshness = DisplayFreshness { [weak self] in self?.displayStale = $0 }

    init(
        seed: TeamSeed,
        client: RemoteClient,
        role: String,
        sendRequest: @escaping @Sendable (RemoteClient, String, JSON?) async throws -> JSON = { try await $0.request($1, body: $2) }
    ) {
        self.loadState = .loading(seed: seed, error: nil)
        self.client = client
        self.role = role
        self.sendRequest = sendRequest
    }

    init(
        run: TeamRun,
        client: RemoteClient,
        role: String,
        sendRequest: @escaping @Sendable (RemoteClient, String, JSON?) async throws -> JSON = { try await $0.request($1, body: $2) }
    ) {
        self.loadState = .listSeed(run, error: nil)
        self.client = client
        self.role = role
        self.sendRequest = sendRequest
    }

    var id: String { loadState.id }
    var run: TeamRun? { loadState.run }
    var isLoaded: Bool { loadState.isLoaded }
    var loadError: String? { loadState.loadError }
    var title: String { loadState.title }
    var status: String { loadState.status }
    var statusLabel: String { loadState.statusLabel }
    var projectID: String { loadState.projectID }
    var missionID: String { loadState.missionID }

    func observe(_ next: TeamRun) {
        guard next.id == id else { return }
        switch loadState {
        case .loading:
            loadState = .loaded(next, latestListRow: nil)
        case .listSeed(let current, _):
            guard Self.supersedes(next, current) else { return }
            loadState = .loaded(next, latestListRow: nil)
        case .loaded(let current, let latestListRow):
            guard Self.supersedes(next, current) else { return }
            if next != current {
                loadState = .loaded(next, latestListRow: latestListRow)
            }
        }
    }

    func observeListRow(_ next: TeamRun) {
        guard next.id == id else { return }
        switch loadState {
        case .loading(_, let error):
            loadState = .listSeed(next, error: error)
        case .listSeed(let current, let error):
            guard Self.supersedes(next, current) else { return }
            if next != current { loadState = .listSeed(next, error: error) }
        case .loaded(let current, let listed):
            guard Self.supersedes(next, current) else { return }
            if listed != next, listed.map({ !Self.later($0, than: next) }) ?? true {
                loadState = .loaded(current, latestListRow: next)
            }
            let shown = pageShown && displayVisible
            if behind {
                if fresh { fresh = false }
                if shown { refreshSoon() }
            } else if !shown, Self.later(next, than: current), fresh {
                fresh = false
            }
        }
    }

    private func refreshSoon() {
        guard refreshToken == nil else { return }
        let token = UUID(), generation = pollGeneration
        refreshToken = token
        Task { [weak self] in
            _ = await self?.runPoll(generation, coalesce: false)
            if self?.refreshToken == token { self?.refreshToken = nil }
        }
    }

    func startPolling() {
        pageShown = true
        updatePolling()
    }

    func stopPolling() {
        pageShown = false
        updatePolling()
    }

    func setDisplayVisible(_ visible: Bool) {
        guard displayVisible != visible else { return }
        displayVisible = visible
        if !visible {
            fresh = false
            latestPollAttempt &+= 1
            inFlightPoll?.task.cancel()
            inFlightPoll = nil
        }
        updatePolling()
    }

    private func updatePolling() {
        guard pageShown && displayVisible else {
            pollGeneration = UUID()
            latestPollAttempt &+= 1
            inFlightPoll?.task.cancel()
            inFlightPoll = nil
            pollTask?.cancel()
            pollTask = nil
            return
        }
        guard pollTask == nil else { return }
        let generation = UUID()
        pollGeneration = generation
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.pollGeneration == generation, self.pageShown, self.displayVisible else { break }
                await self.poll(generation)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            guard let self, self.pollGeneration == generation else { return }
            self.pollTask = nil
        }
    }

    func poll() async {
        _ = await runPoll(pollGeneration, coalesce: false)
    }

    private func poll(_ generation: UUID) async {
        _ = await runPoll(generation, coalesce: true)
    }

    private func runPoll(_ generation: UUID, coalesce: Bool) async -> PollOutcome {
        guard displayVisible, generation == pollGeneration else { return .skipped }
        if coalesce, let active = inFlightPoll {
            return await active.task.value
        }
        latestPollAttempt &+= 1
        let attempt = latestPollAttempt
        inFlightPoll?.task.cancel()
        let task = Task<PollOutcome, Never> { [weak self] in
            guard let self else { return .skipped }
            return await self.executePoll(generation: generation, attempt: attempt)
        }
        inFlightPoll = (attempt, task)
        let outcome = await task.value
        if inFlightPoll?.attempt == attempt {
            inFlightPoll = nil
        }
        return outcome
    }

    private func recordLoadError(_ message: String) {
        switch loadState {
        case .loading(let seed, _):
            loadState = .loading(seed: seed, error: message)
        case .listSeed(let run, _):
            loadState = .listSeed(run, error: message)
        case .loaded:
            break
        }
    }

    private func executePoll(generation: UUID, attempt: UInt64) async -> PollOutcome {
        guard displayVisible, generation == pollGeneration, attempt == latestPollAttempt else { return .skipped }
        do {
            let value = try await sendRequest(client, "/teams/\(id)", nil)
            guard displayVisible, generation == pollGeneration, attempt == latestPollAttempt else { return .skipped }
            let fetched = TeamRun(value)
            guard fetched.id == id else {
                let message = "The server returned a mismatched team."
                recordLoadError(message)
                if fresh { fresh = false }
                freshness.failed()
                return .failed(message)
            }
            observe(fetched)
            let current = isLoaded && !behind
            if fresh != current { fresh = current }
            freshness.recovered()
            return .updated
        } catch {
            guard displayVisible, generation == pollGeneration, attempt == latestPollAttempt else { return .skipped }
            recordLoadError(error.localizedDescription)
            if fresh { fresh = false }
            freshness.failed()
            return .failed(error.localizedDescription)
        }
    }

    var managed: Bool { loadState.managedByMission }
    var canSteer: Bool {
        guard case .loaded(let run, _) = loadState else { return false }
        return !managed && fresh && role != "viewer" && run.typedStatus != .cancelled && !(run.typedStatus == .blocked && run.value["continuable"].bool) && mutationState == .idle
    }
    var canOwn: Bool {
        guard isLoaded else { return false }
        return !managed && fresh && role == "owner" && mutationState == .idle
    }
    var offersContinue: Bool {
        guard case .loaded(let run, _) = loadState else { return false }
        return role == "owner" && run.typedStatus == .blocked && run.value["continuable"].bool && !managed
            && run.value["goal"] == .null && run.value["deliveryReceipt"] == .null && run.value["pullRequest"] == .null
    }
    var canContinue: Bool { offersContinue && fresh && mutationState == .idle }

    func steer() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate(path: "/teams/\(id)/steer", label: "Direction", text: text)
    }

    func answer(_ decision: JSON, text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate(path: "/teams/\(id)/decisions/\(decision["id"].string)/answer", label: "Answer", text: text)
    }

    func perform(_ action: String) async {
        await mutate(path: "/teams/\(id)/\(action)", label: action == "cancel" ? "Cancellation" : action.capitalizedFirst)
    }

    func continueRun() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canContinue, text.utf16.count <= 8000 else { return }
        await mutate(path: "/teams/\(id)/continue", label: "Continue development", text: text.isEmpty ? nil : text)
    }

    private func mutate(path: String, label: String, text: String? = nil) async {
        guard let run, !managed, mutationState == .idle else { return }
        let requestID = UUID().uuidString.lowercased()
        var fields: [String: JSON] = ["requestId": .string(requestID), "revision": .number(Double(run.revision))]
        if let text { fields["text"] = .string(text) }
        await send(TeamMutation(requestID: requestID, path: path, body: .object(fields), label: label), retrying: false)
    }

    func retry() async {
        guard case .unconfirmed(let pending) = mutationState else { return }
        await send(pending, retrying: true)
    }

    func rate(task: String, score: Int) async {
        guard canOwn, (1...5).contains(score) else { return }
        mutationState = .sending(pending: nil)
        defer { mutationState = .idle }
        do {
            _ = try await client.rateTask(team: id, task: task, score: score, requestID: UUID().uuidString.lowercased())
            notice = "Rating recorded."
            noticeIsError = false
        } catch {
            notice = error.localizedDescription
            noticeIsError = true
        }
        await poll()
    }

    func discardPending() {
        guard case .unconfirmed = mutationState else { return }
        mutationState = .idle
        notice = "Unconfirmed request cleared after your review."
        noticeIsError = false
    }

    private func send(_ mutation: TeamMutation, retrying: Bool) async {
        mutationState = .sending(pending: retrying ? mutation : nil)
        do {
            let result = try await sendRequest(client, mutation.path, mutation.body)
            let next = TeamRun(result)
            if next.id == id { observe(next) } else { await poll() }
            mutationState = .idle
            let revision = next.id == id ? next.revision : (run?.revision ?? next.revision)
            notice = "\(mutation.label) recorded · revision \(revision)."
            noticeIsError = false
            if mutation.path.hasSuffix("/steer") { direction = "" }
            if mutation.path.hasSuffix("/continue") && direction.trimmingCharacters(in: .whitespacesAndNewlines) == mutation.body["text"].string { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            mutationState = .unconfirmed(mutation)
            notice = "Delivery unconfirmed. Retry sends this exact request."
            noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            let outcome = await runPoll(pollGeneration, coalesce: false)
            mutationState = .idle
            switch outcome {
            case .updated:
                notice = error.message + " The team was refreshed; review it before sending again."
            case .skipped:
                notice = error.message
            case .failed(let refreshError):
                notice = "\(error.message) Could not refresh the team: \(refreshError)"
            }
            noticeIsError = true
        } catch {
            mutationState = .idle
            notice = error.localizedDescription
            noticeIsError = true
        }
    }
}
