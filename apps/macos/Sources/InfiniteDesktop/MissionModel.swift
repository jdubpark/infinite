import SwiftUI
import InfiniteCore

/// One selected mission: polls it while shown and carries the owner's answers, steering, and controls.
/// Requests reuse the team page's unconfirmed-delivery handling: a retry resends the identical body.
@MainActor final class MissionModel: ObservableObject {
    @Published private(set) var mission: Mission
    @Published var direction = ""
    @Published private(set) var busy = false
    @Published private(set) var notice = ""
    @Published private(set) var noticeIsError = false
    /// The last poll succeeded, so controls act on the mission's current revision.
    @Published private(set) var fresh = false
    @Published private(set) var pending: TeamMutation?
    let role: String
    private let client: RemoteClient
    private var pollTask: Task<Void, Never>?
    private var pageShown = false
    private var displayVisible = false
    private var pollGeneration = UUID()
    init(mission: Mission, client: RemoteClient, role: String) { self.mission = mission; self.client = client; self.role = role }
    var id: String { mission.id }
    /// Newer revisions always win; within a revision the later update does.
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
            pollGeneration = UUID(); pollTask?.cancel(); pollTask = nil
            return
        }
        guard pollTask == nil else { return }
        let generation = UUID(); pollGeneration = generation
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
        await poll(pollGeneration)
    }
    private func poll(_ generation: UUID) async {
        guard displayVisible else { return }
        do {
            let value = try await client.request("/missions/\(mission.id)")
            guard displayVisible, generation == pollGeneration else { return }
            observe(Mission(value)); if !fresh { fresh = true }
        } catch {
            guard displayVisible, generation == pollGeneration else { return }
            if fresh { fresh = false }
        }
    }
    /// The spec gives answering, steering, and lifecycle controls to the owner only.
    var canAct: Bool { fresh && role == "owner" && !busy && pending == nil }
    var canSteer: Bool { canAct && !mission.ended }
    func steer() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate("Direction") { .action(missionID: self.mission.id, name: "steer", revision: self.mission.revision, text: text, requestID: $0) }
    }
    /// Answers exactly the decision the owner saw, at the revision shown with it. If polling has
    /// moved the mission on since, the host refuses the stale revision instead of misapplying it.
    func answer(decisionID: String, revision: Int, text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !decisionID.isEmpty else { return }
        await mutate("Answer") { .answer(missionID: self.mission.id, decisionID: decisionID, revision: revision, text: text, requestID: $0) }
    }
    func perform(_ action: String) async {
        await mutate(action == "cancel" ? "Cancellation" : action.capitalizedFirst) { .action(missionID: self.mission.id, name: action, revision: self.mission.revision, requestID: $0) }
    }
    private func mutate(_ label: String, _ request: (String) -> MissionRequest) async {
        guard !busy, pending == nil else { return }
        let requestID = UUID().uuidString.lowercased()
        let built = request(requestID)
        await send(TeamMutation(requestID: requestID, path: built.path, body: built.body, label: label))
    }
    func retry() async { guard let pending else { return }; await send(pending) }
    /// Only after the person has checked the mission: the host may already have applied the request.
    func discardPending() { pending = nil; notice = "Unconfirmed request cleared after your review."; noticeIsError = false }
    private func send(_ mutation: TeamMutation) async {
        busy = true; defer { busy = false }
        do {
            let result = try await client.request(mutation.path, body: mutation.body)
            let next = Mission(result["mission"] == .null ? result : result["mission"])
            pending = nil
            if next.id == mission.id { observe(next) } else { await poll() }
            notice = "\(mutation.label) recorded · revision \(mission.revision)."; noticeIsError = false
            if mutation.path.hasSuffix("/steer") { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            pending = mutation; notice = "Delivery unconfirmed. Retry sends this exact request."; noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            pending = nil; notice = error.message + " The mission was refreshed; review it before sending again."; noticeIsError = true
            await poll()
        } catch { pending = nil; notice = error.localizedDescription; noticeIsError = true }
    }
}
