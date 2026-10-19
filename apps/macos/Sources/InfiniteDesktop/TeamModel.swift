import SwiftUI
import InfiniteCore

/// A team request whose delivery the host has not confirmed. Retrying resends the identical
/// body, so the host either recovers its recorded outcome or applies it once.
struct TeamMutation: Equatable {
    let requestID: String
    let path: String
    let body: JSON
    let label: String
}

/// One selected team run: polls it while shown and carries answers, directions, and owner actions.
@MainActor final class TeamModel: ObservableObject {
    @Published private(set) var run: TeamRun
    @Published var direction = ""
    @Published private(set) var busy = false
    @Published private(set) var notice = ""
    @Published private(set) var noticeIsError = false
    /// The last poll of this run succeeded, so its state is current and controls may act on it.
    @Published private(set) var fresh = false
    @Published private(set) var pending: TeamMutation?
    let role: String
    private let client: RemoteClient
    private var pollTask: Task<Void, Never>?
    init(run: TeamRun, client: RemoteClient, role: String) { self.run = run; self.client = client; self.role = role }
    var id: String { run.id }
    /// Newer revisions always win; within a revision the later update does.
    func observe(_ next: TeamRun) {
        guard next.revision > run.revision || (next.revision == run.revision && next.updatedAt >= run.updatedAt) else { return }
        if next != run { run = next }
    }
    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
    func stopPolling() { pollTask?.cancel(); pollTask = nil }
    func poll() async {
        do { let value = try await client.request("/teams/\(run.id)"); observe(TeamRun(value)); if !fresh { fresh = true } }
        catch { if fresh { fresh = false } }
    }
    var canSteer: Bool { fresh && role != "viewer" && run.status != "cancelled" && !busy && pending == nil }
    var canOwn: Bool { fresh && role == "owner" && !busy && pending == nil }
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
    private func mutate(path: String, label: String, text: String? = nil) async {
        guard !busy, pending == nil else { return }
        let requestID = UUID().uuidString.lowercased()
        var fields: [String: JSON] = ["requestId": .string(requestID), "revision": .number(Double(run.revision))]
        if let text { fields["text"] = .string(text) }
        await send(TeamMutation(requestID: requestID, path: path, body: .object(fields), label: label))
    }
    func retry() async { guard let pending else { return }; await send(pending) }
    /// The owner's 1–5 rating of a task. Idempotent per request id; the run is re-read afterwards.
    func rate(task: String, score: Int) async {
        guard canOwn, (1...5).contains(score) else { return }
        busy = true; defer { busy = false }
        do {
            _ = try await client.rateTask(team: run.id, task: task, score: score, requestID: UUID().uuidString.lowercased())
            notice = "Rating recorded."; noticeIsError = false
        } catch { notice = error.localizedDescription; noticeIsError = true }
        await poll()
    }
    /// Only after the person has checked the team: the host may already have applied the request.
    func discardPending() { pending = nil; notice = "Unconfirmed request cleared after your review."; noticeIsError = false }
    private func send(_ mutation: TeamMutation) async {
        busy = true; defer { busy = false }
        do {
            let result = try await client.request(mutation.path, body: mutation.body)
            let next = TeamRun(result); observe(next); pending = nil
            notice = "\(mutation.label) recorded · revision \(next.revision)."; noticeIsError = false
            if mutation.path.hasSuffix("/steer") { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            pending = mutation; notice = "Delivery unconfirmed. Retry sends this exact request."; noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            pending = nil; notice = error.message + " The team was refreshed; review it before sending again."; noticeIsError = true
            await poll()
        } catch { pending = nil; notice = error.localizedDescription; noticeIsError = true }
    }
}
