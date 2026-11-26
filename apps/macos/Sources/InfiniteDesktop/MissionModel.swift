import SwiftUI
import InfiniteCore

struct MissionSeed: Equatable, Sendable {
    let id: String
    let title: String
    let status: String
    let groupID: String
    let groupName: String
    let column: BoardColumn
    let progressFraction: Double

    init(
        id: String,
        title: String = "",
        status: String = "",
        groupID: String = "",
        groupName: String = "",
        column: BoardColumn? = nil,
        progressFraction: Double = 0.25
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.groupID = groupID
        self.groupName = groupName
        self.column = column ?? Self.column(for: status)
        self.progressFraction = progressFraction
    }

    init(id: String, row: BoardItem?) {
        self.init(
            id: id,
            title: row?.title ?? "",
            status: row?.status ?? "",
            groupID: row?.groupID ?? "",
            groupName: row?.projectName ?? "",
            column: row?.column,
            progressFraction: row?.progressFraction ?? 0.25
        )
    }

    var typedStatus: Mission.Status { Mission.Status(status) }

    var statusLabel: String {
        guard !status.isEmpty else { return "" }
        return Mission.labels[status] ?? status.replacingOccurrences(of: "-", with: " ").capitalizedFirst
    }

    private static func column(for status: String) -> BoardColumn {
        switch Mission.Status(status) {
        case .needsInput, .blocked: return .needsInput
        case .readyForReview: return .review
        case .cancelled: return .ended
        case .planning, .working, .paused, .unknown: return .working
        }
    }
}

enum MissionLoadState: Equatable, Sendable {
    case loading(seed: MissionSeed, error: String?)
    case loaded(Mission)

    var id: String {
        switch self {
        case .loading(let seed, _): return seed.id
        case .loaded(let mission): return mission.id
        }
    }

    var mission: Mission? {
        if case .loaded(let mission) = self { return mission }
        return nil
    }

    var isLoaded: Bool { mission != nil }

    var loadError: String? {
        if case .loading(_, let error) = self { return error }
        return nil
    }

    var title: String {
        switch self {
        case .loading(let seed, _): return seed.title
        case .loaded(let mission): return mission.title
        }
    }

    var status: String {
        switch self {
        case .loading(let seed, _): return seed.status
        case .loaded(let mission): return mission.status
        }
    }

    var statusLabel: String {
        switch self {
        case .loading(let seed, _): return seed.statusLabel
        case .loaded(let mission): return mission.statusLabel
        }
    }

    var groupID: String {
        switch self {
        case .loading(let seed, _): return seed.groupID
        case .loaded(let mission): return mission.groupID
        }
    }

    var groupName: String {
        switch self {
        case .loading(let seed, _): return seed.groupName
        case .loaded(let mission): return mission.groupName
        }
    }
}

@MainActor final class MissionModel: ObservableObject {
    private enum PollOutcome {
        case updated
        case skipped
        case failed(String)
    }

    private enum PollMode {
        case background
        case manual
        case forced
    }

    @Published private(set) var loadState: MissionLoadState
    @Published var direction = ""
    @Published private(set) var mutationState: MutationState = .idle
    @Published private(set) var notice = ""
    @Published private(set) var noticeIsError = false
    @Published private(set) var fresh = false
    @Published private(set) var isRetrying = false

    var busy: Bool { mutationState.isSending }
    var pending: TeamMutation? { mutationState.pending }

    let role: String
    private let client: RemoteClient
    private let sendRequest: @Sendable (RemoteClient, String, JSON?) async throws -> JSON
    private var pollTask: Task<Void, Never>?
    private var pageShown = false
    private var displayVisible = false
    private var pollGeneration = UUID()
    private var latestPollAttempt: UInt64 = 0
    private var inFlightPoll: (attempt: UInt64, manual: Bool, task: Task<PollOutcome, Never>)?

    init(
        seed: MissionSeed,
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
        mission: Mission,
        client: RemoteClient,
        role: String,
        sendRequest: @escaping @Sendable (RemoteClient, String, JSON?) async throws -> JSON = { try await $0.request($1, body: $2) }
    ) {
        self.loadState = .loaded(mission)
        self.client = client
        self.role = role
        self.sendRequest = sendRequest
    }

    var id: String { loadState.id }
    var mission: Mission? { loadState.mission }
    var isLoaded: Bool { loadState.isLoaded }
    var loadError: String? { loadState.loadError }
    var title: String { loadState.title }
    var status: String { loadState.status }
    var statusLabel: String { loadState.statusLabel }
    var groupID: String { loadState.groupID }
    var groupName: String { loadState.groupName }

    func observe(_ next: Mission) {
        guard next.id == id else { return }
        switch loadState {
        case .loading:
            loadState = .loaded(next)
        case .loaded(let current):
            guard next.revision > current.revision || (next.revision == current.revision && next.updatedAt >= current.updatedAt) else { return }
            if next != current { loadState = .loaded(next) }
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
            if isRetrying { isRetrying = false }
        }
        updatePolling()
    }

    private func updatePolling() {
        guard pageShown && displayVisible else {
            pollGeneration = UUID()
            latestPollAttempt &+= 1
            inFlightPoll?.task.cancel()
            inFlightPoll = nil
            if isRetrying { isRetrying = false }
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
        _ = await runPoll(pollGeneration, mode: .forced)
    }

    func retryLoad() async {
        _ = await runPoll(pollGeneration, mode: .manual)
    }

    private func poll(_ generation: UUID) async {
        _ = await runPoll(generation, mode: .background)
    }

    private func runPoll(_ generation: UUID, mode: PollMode) async -> PollOutcome {
        guard displayVisible, generation == pollGeneration else { return .skipped }
        if let active = inFlightPoll {
            switch mode {
            case .background:
                return await active.task.value
            case .manual where active.manual:
                return await active.task.value
            case .manual, .forced:
                break
            }
        }
        latestPollAttempt &+= 1
        let attempt = latestPollAttempt
        let isManual = mode == .manual
        inFlightPoll?.task.cancel()
        if isRetrying != isManual { isRetrying = isManual }
        let task = Task<PollOutcome, Never> { [weak self] in
            guard let self else { return .skipped }
            return await self.executePoll(generation: generation, attempt: attempt)
        }
        inFlightPoll = (attempt, isManual, task)
        let outcome = await task.value
        if inFlightPoll?.attempt == attempt {
            inFlightPoll = nil
            if isRetrying { isRetrying = false }
        }
        return outcome
    }

    private func executePoll(generation: UUID, attempt: UInt64) async -> PollOutcome {
        guard displayVisible, generation == pollGeneration, attempt == latestPollAttempt else { return .skipped }
        do {
            let value = try await sendRequest(client, "/missions/\(id)", nil)
            guard displayVisible, generation == pollGeneration, attempt == latestPollAttempt else { return .skipped }
            let fetched = Mission(value)
            guard fetched.id == id else {
                let message = "The server returned a mismatched mission."
                if case .loading(let seed, _) = loadState { loadState = .loading(seed: seed, error: message) }
                if fresh { fresh = false }
                return .failed(message)
            }
            observe(fetched)
            if !fresh { fresh = true }
            return .updated
        } catch {
            guard displayVisible, generation == pollGeneration, attempt == latestPollAttempt else { return .skipped }
            if case .loading(let seed, _) = loadState {
                loadState = .loading(seed: seed, error: error.localizedDescription)
            }
            if fresh { fresh = false }
            return .failed(error.localizedDescription)
        }
    }

    var canAct: Bool { isLoaded && fresh && role == "owner" && mutationState == .idle }
    var canSteer: Bool {
        guard case .loaded(let mission) = loadState else { return false }
        return canAct && !mission.ended
    }

    func steer() async {
        guard case .loaded(let mission) = loadState else { return }
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate("Direction") { .action(missionID: mission.id, name: "steer", revision: mission.revision, text: text, requestID: $0) }
    }

    func answer(decisionID: String, revision: Int, text: String) async {
        guard case .loaded(let mission) = loadState else { return }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !decisionID.isEmpty else { return }
        await mutate("Answer") { .answer(missionID: mission.id, decisionID: decisionID, revision: revision, text: text, requestID: $0) }
    }

    func perform(_ action: String) async {
        guard case .loaded(let mission) = loadState else { return }
        await mutate(action == "cancel" ? "Cancellation" : action.capitalizedFirst) { .action(missionID: mission.id, name: action, revision: mission.revision, requestID: $0) }
    }

    private func mutate(_ label: String, _ request: (String) -> MissionRequest) async {
        guard mutationState == .idle else { return }
        let requestID = UUID().uuidString.lowercased()
        let built = request(requestID)
        await send(TeamMutation(requestID: requestID, path: built.path, body: built.body, label: label), retrying: false)
    }

    func retry() async {
        guard case .unconfirmed(let pending) = mutationState else { return }
        await send(pending, retrying: true)
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
            let next = Mission(result["mission"] == .null ? result : result["mission"])
            if next.id == id { observe(next) } else { await poll() }
            mutationState = .idle
            let revision = next.id == id ? next.revision : (mission?.revision ?? next.revision)
            notice = "\(mutation.label) recorded · revision \(revision)."
            noticeIsError = false
            if mutation.path.hasSuffix("/steer") { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            mutationState = .unconfirmed(mutation)
            notice = "Delivery unconfirmed. Retry sends this exact request."
            noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            let outcome = await runPoll(pollGeneration, mode: .forced)
            mutationState = .idle
            switch outcome {
            case .updated:
                notice = error.message + " The mission was refreshed; review it before sending again."
            case .skipped:
                notice = error.message
            case .failed(let refreshError):
                notice = "\(error.message) Could not refresh the mission: \(refreshError)"
            }
            noticeIsError = true
        } catch {
            mutationState = .idle
            notice = error.localizedDescription
            noticeIsError = true
        }
    }
}
