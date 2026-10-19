import SwiftUI
import InfiniteCore

/// One mission: the coordinator's open questions first, then its subtasks by repository, each
/// opening its subteam's page, and a box to steer the coordinator.
struct MissionDetailView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var model: MissionModel
    @State private var confirmCancel = false
    @State private var confirmDiscard = false
    @State private var fullRequest = false
    private var mission: Mission { model.mission }
    private func repoName(_ id: String) -> String { app.projectGroups.repoName(id) ?? app.projectName(id) }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if !mission.reason.isEmpty { note(mission.reason, color: mission.status == "blocked" ? Palette.error : .orange) }
                    decisions
                    result
                    subtasks
                    request
                    history
                }.padding(20).frame(maxWidth: 900, alignment: .leading)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            composer.padding(12)
        }
        .background(Palette.background)
        .onAppear { model.startPolling() }
        .onDisappear { model.stopPolling() }
        .alert("Cancel this mission?", isPresented: $confirmCancel) {
            Button("Keep running", role: .cancel) {}
            Button("Cancel mission", role: .destructive) { Task { await model.perform("cancel") } }
        } message: { Text("This stops the coordinator and every active subteam. Recorded work stays available.") }
        .alert("Have you checked the mission?", isPresented: $confirmDiscard) {
            Button("Keep pending request", role: .cancel) {}
            Button("Clear after review") { model.discardPending() }
        } message: { Text("The host may already have applied this request. Clearing it does not undo anything.") }
    }

    private var header: some View {
        HStack(spacing: 10) {
            StatusGlyph(mission: mission, size: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(mission.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text(headerLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if !model.fresh { Text("Updates unavailable").font(.caption).foregroundStyle(.orange) }
            if !mission.statusLabel.isEmpty {
                Text(mission.statusLabel).font(.caption.weight(.medium)).padding(.horizontal, 9).padding(.vertical, 4)
                    .glassSurface(in: Capsule(), tint: statusColor)
            }
            if model.role == "owner" && mission.canCancel {
                Menu {
                    if mission.canResume { Button("Resume mission") { Task { await model.perform("resume") } }.disabled(!model.canAct) }
                    if mission.canPause { Button("Pause mission") { Task { await model.perform("pause") } }.disabled(!model.canAct) }
                    Button("Cancel mission…", role: .destructive) { confirmCancel = true }.disabled(!model.canAct)
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize().help("Mission actions")
            }
        }
    }
    private var headerLine: String {
        let repos = mission.repoProjectIDs
        var parts = [mission.groupName]
        if repos.count > 1 { parts.append("\(repos.count) repos") }
        if mission.revision > 0 { parts.append("Revision \(mission.revision)") }
        if !mission.coordinatorStatus.isEmpty { parts.append("Coordinator \(mission.coordinatorStatus)") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private var statusColor: Color {
        switch mission.status {
        case "needs-input": return Palette.attention
        case "blocked": return Palette.error
        case "ready-for-review": return Palette.review
        case "paused": return Palette.paused
        case "cancelled": return Palette.muted
        default: return Palette.running
        }
    }

    @ViewBuilder private var decisions: some View {
        let open = mission.openDecisions
        if !open.isEmpty {
            section("Decisions for you", count: open.count) {
                ForEach(Array(open.enumerated()), id: \.offset) { _, decision in
                    DecisionCard(decision: decision, caption: caption(decision), disabled: !model.canAct || mission.status == "paused") { text in
                        Task { await model.answer(decision, text: text) }
                    }
                }
            }
        }
    }
    /// The coordinator asks every owner question; one escalated from a subteam names it.
    private func caption(_ decision: JSON) -> String {
        let asker = mission.origin(of: decision).map { "Coordinator, for \($0.title) in \(repoName($0.repoProjectID))" } ?? "Coordinator"
        return "\(asker) · \(teamDate(decision["createdAt"].string))"
    }

    /// The coordinator's claim that every subtask finished. It is a report, not acceptance.
    @ViewBuilder private var result: some View {
        if mission.result != .null {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.review)
                    Text(mission.status == "ready-for-review" ? "Ready for your review" : "Coordinator result").font(.headline)
                    Spacer()
                    Text("Each repository delivers under its own policy").font(.caption).foregroundStyle(.secondary)
                }
                Text(mission.result["summary"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Text("Coordinator report · revision \(mission.result["revision"].int). Open each subtask to review its changes.").font(.caption).foregroundStyle(.secondary)
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.review.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.review.opacity(0.25)))
        }
    }

    @ViewBuilder private var subtasks: some View {
        let (done, total) = mission.progress
        section("Subtasks", count: total) {
            if total > 0 { Text("\(done) of \(total) done").font(.caption).foregroundStyle(.secondary) }
            if !mission.dispatchSummary.isEmpty {
                Text(mission.dispatchSummary).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if mission.subtasks.isEmpty { Text("The coordinator has not dispatched any subtasks yet.").font(.callout).foregroundStyle(.secondary) }
            ForEach(mission.subtasks) { subtask in SubtaskRow(subtask: subtask, repo: repoName(subtask.repoProjectID), after: subtask.dependsOn.map { mission.subtask($0)?.title ?? $0 }) {
                if let team = subtask.teamID { app.openTeam(team, from: mission.id) }
            } }
        }
    }

    private var request: some View {
        section("Your request") {
            VStack(alignment: .leading, spacing: 4) {
                Text(mission.objective).font(.callout).textSelection(.enabled).lineLimit(fullRequest ? nil : 3).fixedSize(horizontal: false, vertical: true)
                Button(fullRequest ? "Show less" : "Show all") { fullRequest.toggle() }.buttonStyle(.link).font(.caption)
            }
        }
    }

    @ViewBuilder private var history: some View {
        let answered = mission.answeredDecisions
        if !mission.steering.isEmpty || !answered.isEmpty {
            section("Your directions and decisions") {
                ForEach(Array(mission.steering.enumerated()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Direction · revision \(entry["revision"].int) · \(teamDate(entry["at"].string))").font(.caption).foregroundStyle(.secondary)
                        Text(entry["text"].string).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
                ForEach(Array(answered.enumerated()), id: \.offset) { _, decision in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Decision · answered by \(decision["answeredBy"].string == "coordinator" ? "the coordinator" : "you")").font(.caption).foregroundStyle(.secondary)
                        Text(decision["question"].string).font(.callout).fixedSize(horizontal: false, vertical: true)
                        Text("Answer: \(decision["answer"].string)").font(.callout.weight(.medium)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        if !mission.events.isEmpty {
            DisclosureGroup("Mission history (\(mission.events.count))") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(mission.events.enumerated()), id: \.offset) { _, event in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(teamDate(event["at"].string)).font(.caption).foregroundStyle(.tertiary).frame(width: 120, alignment: .leading)
                            Text(event["text"].string).font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }.padding(.top, 6)
            }.font(.subheadline.weight(.semibold))
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let pending = model.pending {
                HStack {
                    Text("Unconfirmed request: \(pending.label.lowercased()) · revision \(pending.body["revision"].int)").font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("Retry same request") { Task { await model.retry() } }.disabled(model.busy || !model.fresh)
                    Button("Clear…") { confirmDiscard = true }.disabled(model.busy)
                }
            }
            if model.role != "owner" { Text("This device can view the mission. An owner device answers decisions and steers it.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            else if mission.ended { Text("This mission is cancelled. Its subtasks and history remain available above.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            else {
                PromptEditor(text: Binding(get: { model.direction }, set: { model.direction = $0 }), placeholder: "Steer the coordinator: a change, a priority, or a constraint…",
                             enabled: model.canSteer, transparent: true, submit: { Task { await model.steer() } })
                    .frame(height: 64).glassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                HStack(spacing: 12) {
                    Text(model.notice.isEmpty ? "Directions go to the coordinator, which passes them to the subteams it affects." : model.notice)
                        .font(.system(size: 11)).foregroundStyle(model.noticeIsError ? Color.orange : .secondary).lineLimit(2).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { Task { await model.steer() } } label: { Label(model.busy ? "Sending…" : "Send direction", systemImage: "arrow.up") }
                        .buttonStyle(.borderedProminent).disabled(!model.canSteer || model.direction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, count: Int? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) { Text(title).font(.subheadline.weight(.semibold)); if let count { Text("\(count)").font(.caption).foregroundStyle(.secondary) } }
            content()
        }
    }
    private func note(_ text: String, color: Color) -> some View {
        Text(text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// One subtask: what it does, in which repository, how large a subteam runs it, and where it stands.
/// A subtask whose subteam has started opens that team's page.
struct SubtaskRow: View {
    let subtask: MissionSubtask
    let repo: String
    let after: [String]
    let open: () -> Void
    @State private var hovering = false
    private var icon: (name: String, color: Color) {
        switch subtask.status {
        case "done": return ("checkmark.circle.fill", Palette.done)
        case "running": return ("circle.dotted.circle", Palette.running)
        case "blocked": return ("exclamationmark.triangle.fill", Palette.error)
        case "cancelled": return ("xmark.circle", Palette.muted)
        default: return ("circle", Palette.muted)
        }
    }
    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon.name).foregroundStyle(icon.color).padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(subtask.title).font(.callout.weight(.medium)).lineLimit(1)
                    Text(([repo, subtask.sizeLabel] + (after.isEmpty ? [] : ["after " + after.joined(separator: ", ")])).joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(subtask.statusLabel).font(.caption).foregroundStyle(subtask.status == "blocked" ? Palette.error : .secondary).lineLimit(1)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).opacity(subtask.teamID == nil ? 0 : 1)
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(hovering && subtask.teamID != nil ? 0.07 : 0.04), in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(subtask.teamID == nil)
        .onHover { hovering = $0 }
        .help(subtask.teamID == nil ? "Its subteam has not started yet." : "Open this subtask's team")
        .accessibilityLabel("\(subtask.title), \(repo), \(subtask.sizeLabel), \(subtask.statusLabel)")
    }
}
