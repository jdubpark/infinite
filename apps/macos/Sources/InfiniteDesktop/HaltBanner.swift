import SwiftUI
import InfiniteCore

/// Which halts a page shows: the overview folds project halts into one line; any other page shows the halts on
/// the host projects it covers in full. A host halt shows on every page.
enum HaltPage: Equatable {
    case overview
    case projects([String])
}

extension AppModel {
    /// The host projects a desktop project (a group of repositories) covers.
    func haltRepoIDs(group id: String?) -> [String] { id.flatMap(projectGroups.group)?.repos.map(\.projectID) ?? [] }
    /// A halted host project's name, from whichever project lists it, else its ID.
    func haltName(_ projectID: String) -> String { projectGroups.repoName(projectID) ?? projectName(projectID) }
    /// The desktop project that lists a halted host project, so the overview line can open it.
    func haltGroup(_ projectID: String) -> ProjectGroup? { projectGroups.groups.first { $0.repos.contains { $0.projectID == projectID } } }
}

/// The owner's halt above the page. Informational only: the owner releases a halt with the host CLI.
struct HaltBanners: View {
    @ObservedObject var app: AppModel
    let page: HaltPage
    private var halt: HaltView { app.halt }
    var body: some View {
        let projects: [HaltState] = {
            switch page {
            case .overview: return halt.projects
            case .projects(let ids): return halt.projects(covering: ids)
            }
        }()
        if halt.holdsHost || !projects.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if !halt.readable { HaltBanner(kind: .unreadable, owner: app.isOwner) }
                else if let host = halt.host { HaltBanner(kind: .host(host), owner: app.isOwner) }
                if page == .overview {
                    if !projects.isEmpty { HaltOverviewLine(app: app, halts: projects) }
                } else {
                    // Under a host halt the host banner already says what a halt holds; a project banner keeps its own facts.
                    ForEach(projects, id: \.haltID) { state in
                        HaltBanner(kind: .project(state, name: app.haltName(state.projectID ?? "")), owner: app.isOwner, explains: !halt.holdsHost)
                    }
                }
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// One halt in full: what it holds, since when and from which owner device, and the owner's reason.
struct HaltBanner: View {
    enum Kind { case host(HaltState), project(HaltState, name: String), unreadable }
    let kind: Kind
    let owner: Bool
    var explains = true
    private var state: HaltState? {
        switch kind {
        case .host(let state), .project(let state, _): return state
        case .unreadable: return nil
        }
    }
    private var color: Color { state == nil ? Palette.error : Palette.paused }
    private var title: String {
        switch kind {
        case .host: return "Halted by the owner for the whole host"
        case .project(_, let name): return "Halted by the owner for \(name)"
        case .unreadable: return "Halted for the whole host"
        }
    }
    private var effect: String {
        switch kind {
        case .host: return "No new agent work starts, and the halt pauses running teams, missions, goals, and routines. The owner's own sessions keep running."
        case .project(_, let name): return "No new agent work starts in \(name), and the halt pauses its running teams, missions, goals, and routines. The owner's own sessions keep running."
        case .unreadable: return "The host cannot read its halt record, so it holds every new team, mission, goal, and routine launch until it can. It checks again every minute."
        }
    }
    private var release: String? {
        guard owner else { return nil }
        switch kind {
        case .host: return "infinite halt off --host"
        case .project(let state, _): return "infinite halt off --project \(state.projectID ?? "")"
        case .unreadable: return nil
        }
    }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: state == nil ? "exclamationmark.octagon.fill" : "pause.circle.fill")
                .font(.system(size: 14)).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    if let state { HaltSince(state: state).font(.caption).foregroundStyle(.secondary) }
                }
                if let reason = state?.reason {
                    Text("“\(reason)”").font(.callout).lineLimit(3).textSelection(.enabled).help(reason)
                }
                if explains { Text(effect).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                if let release {
                    (Text("Release it with ") + Text(release).font(.system(size: 11, design: .monospaced)) + Text(" on an owner device."))
                        .font(.caption).foregroundStyle(.tertiary).textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(color.opacity(0.35)))
        .accessibilityElement(children: .combine)
    }
}

/// "since 14:05 · 3h ago · by Owner laptop", kept current while the page stays open.
struct HaltSince: View {
    let state: HaltState
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in Text(Self.text(state, now: context.date)).lineLimit(1) }
    }
    static func text(_ state: HaltState, now: Date = Date()) -> String {
        var parts: [String] = []
        if let date = ISO8601DateFormatter.flexible.date(from: state.at) ?? ISO8601DateFormatter().date(from: state.at) {
            let clock = Calendar.current.isDate(date, inSameDayAs: now) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(date: .abbreviated, time: .shortened)
            let age = shortAge(date, now: now)
            parts.append("since \(clock) · \(age == "now" ? "just now" : age + " ago")")
        }
        if !state.by.isEmpty { parts.append("by \(state.by)") }
        return parts.joined(separator: " · ")
    }
}

/// The overview's compact form: one line naming each halted project, each opening its own page.
struct HaltOverviewLine: View {
    @ObservedObject var app: AppModel
    let halts: [HaltState]
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "pause.circle.fill").font(.system(size: 12)).foregroundStyle(Palette.paused)
            Text(halts.count == 1 ? "Project halted by the owner:" : "Projects halted by the owner:").font(.callout.weight(.medium))
            // One line stays one line: past three halts the rest are counted, and named in the tooltip.
            ForEach(Array(halts.prefix(3).enumerated()), id: \.element.haltID) { index, state in
                let id = state.projectID ?? ""
                if index > 0 { Text("·").font(.callout).foregroundStyle(.tertiary) }
                if let group = app.haltGroup(id) {
                    Button(name(state)) { app.showHome(project: group.id) }.buttonStyle(.link).font(.callout)
                        .help(detail(state)).accessibilityHint("Opens the project")
                } else {
                    Text(name(state)).font(.callout).help(detail(state))
                }
            }
            if halts.count > 3 {
                Text("· and \(halts.count - 3) more").font(.callout).foregroundStyle(.secondary)
                    .help(halts.dropFirst(3).map(detail).joined(separator: "\n"))
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.paused.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Palette.paused.opacity(0.25)))
    }
    /// A repository inside a multi-repository project names that project too.
    private func name(_ state: HaltState) -> String {
        let id = state.projectID ?? ""
        return app.haltGroup(id).map { $0.repos.count > 1 ? "\(app.haltName(id)) in \($0.name)" : $0.name } ?? app.haltName(id)
    }
    private func detail(_ state: HaltState) -> String {
        [name(state), HaltSince.text(state), state.reason.map { "“\($0)”" }].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A mission covers every repository it runs in; its list arrives with the mission's first poll.
struct MissionHaltBanners: View {
    @ObservedObject var app: AppModel
    @ObservedObject var model: MissionModel
    var body: some View {
        let ids = model.mission.repoProjectIDs
        HaltBanners(app: app, page: .projects(ids.isEmpty ? app.haltRepoIDs(group: model.mission.groupID) : ids))
    }
}

/// A team runs in one host project; a subteam not yet listed learns it on its first poll.
struct TeamHaltBanners: View {
    @ObservedObject var app: AppModel
    @ObservedObject var model: TeamModel
    var body: some View { HaltBanners(app: app, page: .projects([model.run.projectID].filter { !$0.isEmpty })) }
}
