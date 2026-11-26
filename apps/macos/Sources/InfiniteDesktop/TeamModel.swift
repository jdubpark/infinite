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

@MainActor final class TeamModel: ObservableObject {
    private enum PollOutcome {
        case updated
        case skipped
        case failed(String)
    }

    private enum ReadCoverage {
        case listSeedOnly
        case fullRead(latestListRow: TeamRun?)
    }

    @Published private(set) var run: TeamRun
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
    private var coverage: ReadCoverage = .listSeedOnly
    private var refreshToken: UUID?

    var behind: Bool {
        guard case .fullRead(let listed?) = coverage, Self.later(listed, than: run) else { return false }
        return Self.controlState(listed) != Self.controlState(run)
    }

    private static func controlState(_ run: TeamRun) -> [JSON] {
        [.number(Double(run.revision)), .string(run.status), .string(run.missionID), .bool(run.value["continuable"].bool), .bool(run.value["resumable"].bool),
         .bool(run.value["goal"] != .null), .bool(run.value["deliveryReceipt"] != .null), .bool(run.value["pullRequest"] != .null)]
    }

    private static func later(_ next: TeamRun, than run: TeamRun) -> Bool {
        next.revision > run.revision || (next.revision == run.revision && next.updatedAt > run.updatedAt)
    }

    private var pollGeneration = UUID()
    private lazy var freshness = DisplayFreshness { [weak self] in self?.displayStale = $0 }

    init(
        run: TeamRun,
        client: RemoteClient,
        role: String,
        sendRequest: @escaping @Sendable (RemoteClient, String, JSON?) async throws -> JSON = { try await $0.request($1, body: $2) }
    ) {
        self.run = run
        self.client = client
        self.role = role
        self.sendRequest = sendRequest
    }

    var id: String { run.id }

    func observe(_ next: TeamRun) {
        guard supersedes(next) else { return }
        if case .listSeedOnly = coverage {
            coverage = .fullRead(latestListRow: nil)
        }
        if next != run { run = next }
    }

    func observeListRow(_ next: TeamRun) {
        guard supersedes(next) else { return }
        guard case .fullRead(let listed) = coverage else {
            if next != run { run = next }
            return
        }
        if listed.map({ !Self.later($0, than: next) }) ?? true {
            coverage = .fullRead(latestListRow: next)
        }
        let shown = pageShown && displayVisible
        if behind {
            if fresh { fresh = false }
            if shown { refreshSoon() }
        } else if !shown, Self.later(next, than: run), fresh {
            fresh = false
        }
    }

    private func refreshSoon() {
        guard refreshToken == nil else { return }
        let token = UUID(), generation = pollGeneration
        refreshToken = token
        Task { [weak self] in
            await self?.poll(generation)
            if self?.refreshToken == token { self?.refreshToken = nil }
        }
    }

    private func supersedes(_ next: TeamRun) -> Bool {
        next.revision > run.revision || (next.revision == run.revision && next.updatedAt >= run.updatedAt)
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
        if !visible { fresh = false }
        updatePolling()
    }

    private func updatePolling() {
        guard pageShown && displayVisible else {
            pollGeneration = UUID()
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
        _ = await performPoll(pollGeneration)
    }

    private func poll(_ generation: UUID) async {
        _ = await performPoll(generation)
    }

    private func performPoll(_ generation: UUID) async -> PollOutcome {
        guard displayVisible, generation == pollGeneration else { return .skipped }
        do {
            let value = try await sendRequest(client, "/teams/\(run.id)", nil)
            guard displayVisible, generation == pollGeneration else { return .skipped }
            observe(TeamRun(value))
            let current = !behind
            if fresh != current { fresh = current }
            freshness.recovered()
            return .updated
        } catch {
            guard displayVisible, generation == pollGeneration else { return .skipped }
            if fresh { fresh = false }
            freshness.failed()
            return .failed(error.localizedDescription)
        }
    }

    var managed: Bool { run.managedByMission }
    var canSteer: Bool { !managed && fresh && role != "viewer" && run.typedStatus != .cancelled && !(run.typedStatus == .blocked && run.value["continuable"].bool) && mutationState == .idle }
    var canOwn: Bool { !managed && fresh && role == "owner" && mutationState == .idle }
    var offersContinue: Bool {
        role == "owner" && run.typedStatus == .blocked && run.value["continuable"].bool && !managed
            && run.value["goal"] == .null && run.value["deliveryReceipt"] == .null && run.value["pullRequest"] == .null
    }
    var canContinue: Bool { offersContinue && fresh && mutationState == .idle }

    func steer() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate(path: "/teams/\(run.id)/steer", label: "Direction", text: text)
    }

    func answer(_ decision: JSON, text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate(path: "/teams/\(run.id)/decisions/\(decision["id"].string)/answer", label: "Answer", text: text)
    }

    func perform(_ action: String) async {
        await mutate(path: "/teams/\(run.id)/\(action)", label: action == "cancel" ? "Cancellation" : action.capitalizedFirst)
    }

    func continueRun() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canContinue, text.utf16.count <= 8000 else { return }
        await mutate(path: "/teams/\(run.id)/continue", label: "Continue development", text: text.isEmpty ? nil : text)
    }

    private func mutate(path: String, label: String, text: String? = nil) async {
        guard !managed, mutationState == .idle else { return }
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
            _ = try await client.rateTask(team: run.id, task: task, score: score, requestID: UUID().uuidString.lowercased())
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
            observe(next)
            mutationState = .idle
            notice = "\(mutation.label) recorded · revision \(next.revision)."
            noticeIsError = false
            if mutation.path.hasSuffix("/steer") { direction = "" }
            if mutation.path.hasSuffix("/continue") && direction.trimmingCharacters(in: .whitespacesAndNewlines) == mutation.body["text"].string { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            mutationState = .unconfirmed(mutation)
            notice = "Delivery unconfirmed. Retry sends this exact request."
            noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            let outcome = await performPoll(pollGeneration)
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
