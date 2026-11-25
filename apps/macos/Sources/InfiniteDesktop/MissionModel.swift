import SwiftUI
import InfiniteCore

@MainActor final class MissionModel: ObservableObject {
    private enum PollOutcome {
        case updated
        case skipped
        case failed(String)
    }

    @Published private(set) var mission: Mission
    @Published var direction = ""
    @Published private(set) var mutationState: MutationState = .idle
    @Published private(set) var notice = ""
    @Published private(set) var noticeIsError = false
    @Published private(set) var fresh = false

    var busy: Bool { mutationState.isSending }
    var pending: TeamMutation? { mutationState.pending }

    let role: String
    private let client: RemoteClient
    private let sendRequest: @Sendable (RemoteClient, String, JSON?) async throws -> JSON
    private var pollTask: Task<Void, Never>?
    private var pageShown = false
    private var displayVisible = false
    private var pollGeneration = UUID()

    init(
        mission: Mission,
        client: RemoteClient,
        role: String,
        sendRequest: @escaping @Sendable (RemoteClient, String, JSON?) async throws -> JSON = { try await $0.request($1, body: $2) }
    ) {
        self.mission = mission
        self.client = client
        self.role = role
        self.sendRequest = sendRequest
    }

    var id: String { mission.id }

    func observe(_ next: Mission) {
        guard next.id == mission.id, next.revision > mission.revision || (next.revision == mission.revision && next.updatedAt >= mission.updatedAt) else { return }
        if next != mission { mission = next }
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
            let value = try await sendRequest(client, "/missions/\(mission.id)", nil)
            guard displayVisible, generation == pollGeneration else { return .skipped }
            observe(Mission(value))
            if !fresh { fresh = true }
            return .updated
        } catch {
            guard displayVisible, generation == pollGeneration else { return .skipped }
            if fresh { fresh = false }
            return .failed(error.localizedDescription)
        }
    }

    var canAct: Bool { fresh && role == "owner" && mutationState == .idle }
    var canSteer: Bool { canAct && !mission.ended }

    func steer() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate("Direction") { .action(missionID: self.mission.id, name: "steer", revision: self.mission.revision, text: text, requestID: $0) }
    }

    func answer(decisionID: String, revision: Int, text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !decisionID.isEmpty else { return }
        await mutate("Answer") { .answer(missionID: self.mission.id, decisionID: decisionID, revision: revision, text: text, requestID: $0) }
    }

    func perform(_ action: String) async {
        await mutate(action == "cancel" ? "Cancellation" : action.capitalizedFirst) { .action(missionID: self.mission.id, name: action, revision: self.mission.revision, requestID: $0) }
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
            if next.id == mission.id { observe(next) } else { await poll() }
            mutationState = .idle
            notice = "\(mutation.label) recorded · revision \(mission.revision)."
            noticeIsError = false
            if mutation.path.hasSuffix("/steer") { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            mutationState = .unconfirmed(mutation)
            notice = "Delivery unconfirmed. Retry sends this exact request."
            noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            let outcome = await performPoll(pollGeneration)
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
