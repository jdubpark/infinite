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
    @Published private(set) var displayStale = false
    @Published private(set) var pending: TeamMutation?
    let role: String
    private let client: RemoteClient
    private var pollTask: Task<Void, Never>?
    private var pageShown = false
    private var displayVisible = false
    /// `run` came from `/teams/:id` or a mutation result, not from a team list row.
    private var detailed = false
    /// The newest team list row seen for a run read in full.
    private var listed: TeamRun?
    /// Set while the one early read of a shown page is under way. It is kept when the page hides, until that read ends,
    /// so a page hidden and shown again starts no second one beside it.
    private var refreshToken: UUID?
    /// The team list has reported a later state that differs from the full read held here in what controls are
    /// decided from. A request sent now would name a revision the host has left, or act on a status it no longer has.
    var behind: Bool {
        guard detailed, let listed, Self.later(listed, than: run) else { return false }
        return Self.controlState(listed) != Self.controlState(run)
    }
    /// What this page's controls and a list's Resume are decided from. A team list row carries all of it.
    private static func controlState(_ run: TeamRun) -> [JSON] {
        [.number(Double(run.revision)), .string(run.status), .string(run.missionID), .bool(run.value["continuable"].bool), .bool(run.value["resumable"].bool),
         .bool(run.value["goal"] != .null), .bool(run.value["deliveryReceipt"] != .null), .bool(run.value["pullRequest"] != .null)]
    }
    private static func later(_ next: TeamRun, than run: TeamRun) -> Bool {
        next.revision > run.revision || (next.revision == run.revision && next.updatedAt > run.updatedAt)
    }
    private var pollGeneration = UUID()
    private lazy var freshness = DisplayFreshness { [weak self] in self?.displayStale = $0 }
    init(run: TeamRun, client: RemoteClient, role: String) { self.run = run; self.client = client; self.role = role }
    var id: String { run.id }
    /// A full read of the run. Newer revisions always win; within a revision the later update does.
    func observe(_ next: TeamRun) {
        guard supersedes(next) else { return }
        detailed = true
        if next != run { run = next }
    }
    /// A team list row omits what only this page shows: the request, check output and member reports. It seeds a run
    /// not yet read in full and never replaces a full read. A later row that changes the revision, the status or what
    /// the run is eligible for puts the full read behind: controls wait, and a shown page reads the run at once. Any
    /// other later row marks only a hidden page's read out of date; a shown page takes that change from its own poll.
    func observeListRow(_ next: TeamRun) {
        guard supersedes(next) else { return }
        guard detailed else { if next != run { run = next }; return }
        if listed.map({ !Self.later($0, than: next) }) ?? true { listed = next }
        let shown = pageShown && displayVisible
        if behind {
            if fresh { fresh = false }
            if shown { refreshSoon() }
        } else if !shown, Self.later(next, than: run), fresh { fresh = false }
    }
    /// One read ahead of the two-second poll. Rows that arrive while it is under way start no second one.
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
        guard displayVisible, generation == pollGeneration else { return }
        do {
            let value = try await client.request("/teams/\(run.id)")
            guard displayVisible, generation == pollGeneration else { return }
            // A read that started before the list reported a later state is already out of date.
            observe(TeamRun(value)); let current = !behind; if fresh != current { fresh = current }; freshness.recovered()
        } catch {
            guard displayVisible, generation == pollGeneration else { return }
            if fresh { fresh = false }; freshness.failed()
        }
    }
    /// A mission's subteam is run by its coordinator: the owner reads it, and talks to the coordinator from the mission.
    var managed: Bool { run.managedByMission }
    var canSteer: Bool { !managed && fresh && role != "viewer" && run.status != "cancelled" && !(run.status == "blocked" && run.value["continuable"].bool) && !busy && pending == nil }
    var canOwn: Bool { !managed && fresh && role == "owner" && !busy && pending == nil }
    var offersContinue: Bool {
        role == "owner" && run.status == "blocked" && run.value["continuable"].bool && !managed
            && run.value["goal"] == .null && run.value["deliveryReceipt"] == .null && run.value["pullRequest"] == .null
    }
    var canContinue: Bool { offersContinue && fresh && !busy && pending == nil }
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
        guard !managed, !busy, pending == nil else { return }
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
            if mutation.path.hasSuffix("/continue") && direction.trimmingCharacters(in: .whitespacesAndNewlines) == mutation.body["text"].string { direction = "" }
        } catch let error as DesktopError where error.code == "delivery-unknown" {
            pending = mutation; notice = "Delivery unconfirmed. Retry sends this exact request."; noticeIsError = true
        } catch let error as DesktopError where (400...499).contains(error.status) {
            pending = nil; notice = error.message + " The team was refreshed; review it before sending again."; noticeIsError = true
            await poll()
        } catch { pending = nil; notice = error.localizedDescription; noticeIsError = true }
    }
}
