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
    init(mission: Mission, client: RemoteClient, role: String) { self.mission = mission; self.client = client; self.role = role }
    var id: String { mission.id }
    /// Newer revisions always win; within a revision the later update does.
    func observe(_ next: Mission) {
        guard next.id == mission.id, next.revision > mission.revision || (next.revision == mission.revision && next.updatedAt >= mission.updatedAt) else { return }
        if next != mission { mission = next }
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
        do { let value = try await client.request("/missions/\(mission.id)"); observe(Mission(value)); if !fresh { fresh = true } }
        catch { if fresh { fresh = false } }
    }
    /// The spec gives answering, steering, and lifecycle controls to the owner only.
    var canAct: Bool { fresh && role == "owner" && !busy && pending == nil }
    var canSteer: Bool { canAct && !mission.ended }
    func steer() async {
        let text = direction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate(path: "/missions/\(mission.id)/steer", label: "Direction", text: text)
    }
    func answer(_ decision: JSON, text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await mutate(path: "/missions/\(mission.id)/answer/\(decision["id"].string)", label: "Answer", text: text)
    }
    func perform(_ action: String) async {
        await mutate(path: "/missions/\(mission.id)/\(action)", label: action == "cancel" ? "Cancellation" : action.capitalizedFirst)
    }
    private func mutate(path: String, label: String, text: String? = nil) async {
        guard !busy, pending == nil else { return }
        let requestID = UUID().uuidString.lowercased()
        var fields: [String: JSON] = ["requestId": .string(requestID), "revision": .number(Double(mission.revision))]
        if let text { fields["text"] = .string(text) }
        await send(TeamMutation(requestID: requestID, path: path, body: .object(fields), label: label))
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
