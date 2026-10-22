import SwiftUI
import InfiniteCore
import CryptoKit

/// Read-only workspace facts. Requests run only while this page is visible and are
/// fenced by the selected host and workspace before a response can replace the page.
struct UnderstandingView: View {
    @ObservedObject var app: AppModel
    @State private var mode: Mode = .work
    @State private var selectedWorkID: String?
    @State private var selectedRepositoryID: String?
    @State private var snapshot: JSON?
    @State private var snapshotScope = ""
    @State private var snapshotRevision: Int?
    @State private var failure = ""
    @State private var failureScope = ""
    @State private var unsupportedScope = ""
    @State private var loading = false
    @State private var reloadToken = 0
    @State private var cacheNotice = false
    @State private var cacheSavedAt: Date?
    @State private var offlineWorkspaces: [ProjectGroup] = []
    private let snapshotStore = UnderstandingSnapshotStore()

    private enum Mode: String, CaseIterable, Identifiable {
        case work = "Work"
        case system = "System"
        case knowledge = "Knowledge"
        var id: String { rawValue }
    }

    private var groups: [ProjectGroup] {
        var combined = app.projectGroups.groups
        for cached in offlineWorkspaces where !combined.contains(where: { $0.id == cached.id }) { combined.append(cached) }
        return ProjectGroup.ordered(combined)
    }
    private var currentGroup: ProjectGroup? {
        if let id = app.understandingWorkspaceID, let group = groups.first(where: { $0.id == id }) { return group }
        if let id = app.projectFilter, let group = groups.first(where: { $0.id == id }) { return group }
        return groups.first
    }
    private var hostCacheIdentity: String {
        let profile = app.active
        let origin = "\(profile?.origin ?? "")|\(profile?.relayMachineID ?? "")"
        let originHash = SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(app.activeID)|\(profile?.pinnedMachineID ?? app.activeID)|\(originHash)"
    }
    private var credentialCacheIdentity: String {
        guard let active = app.active, let token = try? DeviceKeychain.read(active.id) else { return "unavailable" }
        return SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private var scope: String { "\(hostCacheIdentity)|\(credentialCacheIdentity)|\(currentGroup?.id ?? "")" }
    private var requestKey: String { "\(app.activeID)|\(scope)|\(currentGroup?.revision ?? -1)|\(app.connected)|\(reloadToken)" }
    private var currentPage: JSON? {
        snapshotScope == scope && snapshotRevision == currentGroup?.revision ? snapshot : nil
    }
    private var currentFailure: String { failureScope == scope ? failure : "" }
    private var work: [JSON] { currentPage?["work"].array ?? [] }
    private var repositories: [JSON] { currentPage?["repositories"].array ?? [] }
    private var selectedWork: JSON? {
        work.first { $0["id"].string == selectedWorkID } ?? work.first
    }
    private var selectedRepository: JSON? {
        repositories.first { $0["id"].string == selectedRepositoryID } ?? repositories.first
    }
    private func workTitle(_ item: JSON) -> String {
        item["scope"].string == "partial" ? "Cross-workspace work" : item["title"].string.isEmpty ? "Untitled work" : item["title"].string
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if groups.isEmpty {
                ContentUnavailableView("No workspaces", systemImage: "square.grid.2x2",
                                       description: Text(app.connected ? "This server has no visible workspaces." : "Connect to a server to read workspace understanding."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let page = currentPage {
                VStack(spacing: 0) {
                    if !currentFailure.isEmpty { retainedNotice(currentFailure) }
                    if cacheNotice { retainedNotice("Offline cache · source observed \(page["observedAt"].string) · retained locally \(cacheSavedAt?.formatted(date: .abbreviated, time: .shortened) ?? "recently") for this host, credential, and workspace membership.") }
                    if loading { ProgressView().controlSize(.small).frame(maxWidth: .infinity, alignment: .trailing).padding(.horizontal, 14).padding(.top, 8) }
                    if !page["coverage"].array.isEmpty {
                        Text("\(mode == .work ? "Coverage" : "Workspace coverage"): \(page["coverage"].array.map(\.string).joined(separator: " · "))")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 8)
                    }
                    if mode == .work { workContent(page) }
                    else if mode == .system { systemContent(page) }
                    else if let currentGroup { UnderstandingKnowledgeView(app: app, group: currentGroup, overview: page) }
                }
            } else {
                unavailableContent
            }
        }
        .background(Palette.background)
        .task(id: requestKey) { await refreshWhileVisible() }
        .onChange(of: app.projectGroups.groups.map(\.id)) { _, _ in refreshOfflineWorkspaces(); selectAvailableWorkspace() }
        .onChange(of: app.activeID) { _, _ in refreshOfflineWorkspaces(); selectAvailableWorkspace() }
        .onChange(of: app.connected) { _, connected in if !connected { refreshOfflineWorkspaces(); selectAvailableWorkspace() } }
        .onChange(of: app.understandingWorkspaceID) { _, _ in
            selectedWorkID = nil
            selectedRepositoryID = nil
        }
        .onChange(of: currentPage?["work"].array.map { $0["id"].string } ?? []) { _, ids in
            if let selectedWorkID, !ids.contains(selectedWorkID) { self.selectedWorkID = nil }
        }
        .onChange(of: currentPage?["repositories"].array.map { $0["id"].string } ?? []) { _, ids in
            if let selectedRepositoryID, !ids.contains(selectedRepositoryID) { self.selectedRepositoryID = nil }
        }
        .onAppear { refreshOfflineWorkspaces(); selectAvailableWorkspace() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Picker("Workspace", selection: Binding(
                get: { currentGroup?.id ?? "" },
                set: { app.understandingWorkspaceID = $0.isEmpty ? nil : $0 }
            )) {
                ForEach(groups) { group in
                    Text(group.repoCountLabel.map { "\(group.name) · \($0)" } ?? group.name).tag(group.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 280)
            .disabled(groups.isEmpty)
            Picker("Section", selection: $mode) {
                ForEach(Mode.allCases) { value in Text(value.rawValue).tag(value) }
            }
            .pickerStyle(.segmented)
            .frame(width: 300)
            Spacer()
            if let page = currentPage {
                Text("Observed \(page["observedAt"].string.isEmpty ? "time unavailable" : page["observedAt"].string)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Button {
                unsupportedScope = ""
                reloadToken += 1
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .labelStyle(.iconOnly)
            .help(unsupportedScope == scope ? "Check again after updating the server" : "Refresh workspace understanding")
            .disabled(!app.connected || currentGroup == nil || loading)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private var unavailableContent: some View {
        if !currentFailure.isEmpty {
            ContentUnavailableView {
                Label("Understanding unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(currentFailure)
            } actions: {
                if unsupportedScope == scope {
                    Button("Check again") { unsupportedScope = ""; reloadToken += 1 }
                } else if app.connected {
                    Button("Retry") { reloadToken += 1 }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if app.connected {
            ProgressView("Reading workspace…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView("Server disconnected", systemImage: "network.slash",
                                   description: Text("Connect to read workspace understanding. A retained page appears here after this workspace has loaded."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func retainedNotice(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
            Text("Refresh failed · showing this workspace’s retained page. \(message)").lineLimit(2)
            Spacer()
        }
        .font(.caption).foregroundStyle(.orange)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.orange.opacity(0.08))
    }

    private func workContent(_ page: JSON) -> some View {
        HStack(spacing: 0) {
            List(selection: $selectedWorkID) {
                if work.isEmpty {
                    Text("No work recorded for this workspace.").foregroundStyle(.secondary)
                } else {
                    ForEach(work, id: \.self["id"].string) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(workTitle(item)).lineLimit(2)
                            Text("\(item["status"].string) · \(item["kind"].string.capitalized)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 3)
                        .tag(item["id"].string)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Palette.sidebar)
            .frame(minWidth: 220, idealWidth: 270, maxWidth: 330)
            Divider()
            if let selectedWork { workDetail(selectedWork, page: page) }
            else {
                ContentUnavailableView("No work recorded", systemImage: "checklist",
                                       description: Text("Independent work and its original status appear here when the host has records for this workspace."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func workDetail(_ item: JSON, page: JSON) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(workTitle(item))
                        .font(.title2.weight(.semibold)).textSelection(.enabled)
                    HStack(spacing: 8) {
                        Text("\(item["kind"].string.capitalized) · \(item["status"].string)")
                        Text(item["column"].string.replacingOccurrences(of: "-", with: " ").capitalized)
                        if item["scope"].string == "partial" {
                            Label("Partial workspace scope", systemImage: "circle.lefthalf.filled")
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                fact("Requested outcome", value: item["scope"].string == "partial" ? "" : item["objective"].string,
                     empty: item["scope"].string == "partial" ? "Request content is withheld for this partial workspace association." : "No request recorded.")
                fact("Source-reported result", value: item["scope"].string == "partial" ? "" : item["reportedSummary"].string,
                     empty: item["scope"].string == "partial" ? "Report content is withheld for this partial workspace association." : "No source-reported result retained.")
                workAssociation(item, page: page)
                metadataLine("Source record", "\(item["kind"].string) · \(item["sourceId"].string)")
                if item["scope"].string == "complete", !item["sourceId"].string.isEmpty {
                    if item["kind"].string == "mission" {
                        Button("Open mission", systemImage: "arrow.up.right.square") {
                            app.selectedMissionID = item["sourceId"].string
                        }
                    } else if item["kind"].string == "team" {
                        Button("Open team", systemImage: "arrow.up.right.square") {
                            app.openTeam(item["sourceId"].string)
                        }
                    }
                }
                metadataLine("Repository IDs", item["repositoryIds"].array.map(\.string).joined(separator: ", "))
                if item["scope"].string != "partial", !item["links"].array.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Related records").font(.headline)
                        ForEach(item["links"].array, id: \.self["url"].string) { link in
                            if let url = safeExternalURL(link["url"].string) {
                                Link(destination: url) { Label(link["label"].string.isEmpty ? link["kind"].string.uppercased() : link["label"].string, systemImage: link["kind"].string == "pr" ? "arrow.up.right.square" : "link") }
                            } else {
                                Label("\(link["label"].string.isEmpty ? link["kind"].string.uppercased() : link["label"].string) · unavailable link", systemImage: "exclamationmark.triangle")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                workBriefs(item, page: page)
                metadataLine("Last source update", item["updatedAt"].string)
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(22)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func workAssociation(_ item: JSON, page: JSON) -> some View {
        let repoIDs = Set(item["repositoryIds"].array.map(\.string))
        let matches = page["repositories"].array.filter { repoIDs.contains($0["id"].string) }
        return VStack(alignment: .leading, spacing: 10) {
            Text("Workspace association").font(.headline)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    associationNode(currentGroup?.name ?? "Workspace", icon: "square.grid.2x2", selected: false) {}
                    Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                    associationNode(workTitle(item), icon: "checklist", selected: false) {}
                }
                if matches.isEmpty {
                    Text("No repository association reported").font(.callout).foregroundStyle(.secondary)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: 8) {
                        ForEach(matches, id: \.self["id"].string) { repository in
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                                associationNode(repository["name"].string, icon: "folder", selected: true) {
                                    selectedRepositoryID = repository["id"].string
                                    mode = .system
                                }
                            }
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            Text("Text traversal: \(currentGroup?.name ?? "Workspace") includes work item ‘\(workTitle(item))’, associated with \(matches.isEmpty ? "no reported repositories" : matches.map { $0["name"].string }.joined(separator: ", ")).")
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    @ViewBuilder private func workBriefs(_ item: JSON, page: JSON) -> some View {
        let briefIDs = Set(item["briefIds"].array.map(\.string))
        let sources = page["repositories"].array.filter { repository in
            repository["current"].array.contains { briefIDs.contains($0["id"].string) }
        }
        if !sources.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Related Briefs").font(.headline)
                ForEach(sources, id: \.self["id"].string) { repository in
                    Button {
                        selectedRepositoryID = repository["id"].string
                        mode = .system
                    } label: {
                        Label(repository["name"].string.isEmpty ? repository["id"].string : repository["name"].string,
                              systemImage: "doc.text.magnifyingglass")
                    }
                    .buttonStyle(.link)
                }
            }
        }
    }

    private func systemContent(_ page: JSON) -> some View {
        HStack(spacing: 0) {
            List(selection: $selectedRepositoryID) {
                if repositories.isEmpty {
                    Text("No repositories recorded for this workspace.").foregroundStyle(.secondary)
                } else {
                    ForEach(repositories, id: \.self["id"].string) { repository in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(repository["name"].string.isEmpty ? repository["id"].string : repository["name"].string).lineLimit(1)
                            Text(repositoryState(repository["state"].string)).font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 3)
                        .tag(repository["id"].string)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Palette.sidebar)
            .frame(minWidth: 220, idealWidth: 270, maxWidth: 330)
            Divider()
            if let selectedRepository { repositoryDetail(selectedRepository, page: page) }
            else {
                workspaceDiagram(page)
            }
        }
    }

    private func workspaceDiagram(_ page: JSON) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Workspace membership").font(.title2.weight(.semibold))
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        associationNode(currentGroup?.name ?? "Workspace", icon: "square.grid.2x2", selected: false) {}
                        Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                    }
                    if repositories.isEmpty { Text("No repository membership available").foregroundStyle(.secondary) }
                    else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: 8) {
                            ForEach(repositories, id: \.self["id"].string) { repository in
                                HStack(spacing: 6) {
                                    Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                                    associationNode(repository["name"].string, icon: "folder", selected: true) {
                                        selectedRepositoryID = repository["id"].string
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text("Text traversal: \(currentGroup?.name ?? "Workspace") contains \(repositories.isEmpty ? "no reported repositories" : repositories.map { $0["name"].string.isEmpty ? $0["id"].string : $0["name"].string }.joined(separator: ", ")).")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Text("Only explicit workspace and work associations are shown. Runtime dependencies are not inferred here.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(22)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func repositoryDetail(_ repository: JSON, page: JSON) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(repository["name"].string.isEmpty ? repository["id"].string : repository["name"].string)
                        .font(.title2.weight(.semibold)).textSelection(.enabled)
                    Label(repositoryState(repository["state"].string), systemImage: repositoryStateIcon(repository["state"].string))
                        .font(.caption).foregroundStyle(repository["state"].string == "failed" || repository["state"].string == "unavailable" ? .orange : .secondary)
                }
                repositoryMembership(repository)
                if !repository["coverage"].array.isEmpty { valuesSection("Collection coverage", values: repository["coverage"].array.map(\.string)) }
                if !repository["warnings"].array.isEmpty { valuesSection("Source warnings", values: repository["warnings"].array.map(\.string)) }
                currentArtifacts(repository["current"].array)
                plannedRequests(repository["planned"].array)
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(22)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func repositoryMembership(_ repository: JSON) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Workspace relationship").font(.headline)
            HStack(spacing: 8) {
                associationNode(currentGroup?.name ?? "Workspace", icon: "square.grid.2x2", selected: false) {}
                Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                associationNode(repository["name"].string.isEmpty ? repository["id"].string : repository["name"].string, icon: "folder", selected: false) {}
            }
            Text("Text traversal: \(currentGroup?.name ?? "Workspace") contains \(repository["name"].string.isEmpty ? repository["id"].string : repository["name"].string).")
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private func currentArtifacts(_ artifacts: [JSON]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Current").font(.headline)
            if artifacts.isEmpty { Text("No retained source snapshot is available.").foregroundStyle(.secondary) }
            ForEach(artifacts, id: \.self["id"].string) { artifact in
                VStack(alignment: .leading, spacing: 12) {
                    Label(artifact["sourceKind"].string == "team" ? "Team work-source snapshot" : "Repository source snapshot", systemImage: "doc.text.magnifyingglass")
                        .font(.subheadline.weight(.medium))
                    fact("Brief", value: artifact["brief"]["summary"].string, empty: "No brief summary retained.")
                    DisclosureGroup("Snapshot metadata") {
                        VStack(alignment: .leading, spacing: 6) {
                            metadataLine("Source project", artifact["sourceProjectId"].string)
                            metadataLine("Source session", artifact["sessionId"].string)
                            metadataLine("Source kind", artifact["sourceKind"].string)
                            metadataLine("Source revision", artifact["head"].string)
                            metadataLine("Source baseline", artifact["base"].string)
                            metadataLine("Fingerprint", artifact["fingerprint"].string)
                            metadataLine("Generated", artifact["generatedAt"].string)
                            metadataLine("Retained", artifact["retainedAt"].string)
                            if !artifact["coverage"].array.isEmpty { valuesSection("Snapshot coverage", values: artifact["coverage"].array.map(\.string)) }
                        }
                        .padding(.top, 6)
                    }
                    claimSection("Architecture", artifact["brief"]["architecture"].array)
                    claimSection("Changes", artifact["brief"]["changes"].array)
                    claimSection("Checks", artifact["brief"]["checks"].array)
                    if !artifact["brief"]["review"].array.isEmpty {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Review questions").font(.subheadline.weight(.medium))
                            ForEach(Array(artifact["brief"]["review"].array.enumerated()), id: \.offset) { _, review in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("\(review["priority"].string.capitalized) · \(review["area"].string): \(review["question"].string)")
                                        .font(.callout).textSelection(.enabled)
                                    Text(review["why"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                    citationLine(review["citations"].array)
                                }
                            }
                        }
                    }
                    if !artifact["brief"]["guidance"].array.isEmpty {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Guidance").font(.subheadline.weight(.medium))
                            ForEach(Array(artifact["brief"]["guidance"].array.enumerated()), id: \.offset) { _, guidance in
                                Text("\(guidance["basis"].string.capitalized): \(guidance["text"].string)")
                                    .font(.callout).textSelection(.enabled)
                                citationLine(guidance["citations"].array)
                            }
                        }
                    }
                    if !artifact["brief"]["unknowns"].array.isEmpty { valuesSection("Unknowns", values: artifact["brief"]["unknowns"].array.map(\.string)) }
                    let evidence = artifact["evidence"].array
                    if !evidence.isEmpty {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Evidence").font(.subheadline.weight(.medium))
                            ForEach(Array(evidence.enumerated()), id: \.offset) { _, item in
                                Text("\(item["source"].string):\(item["line"].int) · \(item["text"].string)")
                                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                    }
                }
                .padding(14)
                .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func plannedRequests(_ plans: [JSON]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Planned · recorded requests").font(.headline)
            if plans.isEmpty { Text("No recorded request is available for this repository.").foregroundStyle(.secondary) }
            ForEach(Array(plans.enumerated()), id: \.offset) { _, plan in
                VStack(alignment: .leading, spacing: 7) {
                    Text(plan["title"].string.isEmpty ? "Recorded request" : plan["title"].string).font(.subheadline.weight(.medium))
                    Text(plan["text"].string).font(.callout).textSelection(.enabled)
                    metadataLine("Original work", "\(plan["kind"].string) · \(plan["workId"].string)")
                    metadataLine("Original status", plan["status"].string)
                    metadataLine("Recorded", plan["updatedAt"].string)
                    Text("Source: recorded request").font(.caption).foregroundStyle(.secondary)
                }
                .padding(14)
                .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func claimSection(_ title: String, _ claims: [JSON]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.subheadline.weight(.medium))
            if claims.isEmpty { Text("No \(title.lowercased()) claims retained.").font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(claims.enumerated()), id: \.offset) { _, claim in
                VStack(alignment: .leading, spacing: 4) {
                    Text(claim["text"].string).font(.callout).textSelection(.enabled)
                    if !claim["citations"].array.isEmpty {
                        Text(claim["citations"].array.map { "\($0["source"].string):\($0["line"].int)" }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func fact(_ title: String, value: String, empty: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.headline)
            Text(value.isEmpty ? empty : value)
                .font(.callout).foregroundStyle(value.isEmpty ? .secondary : .primary)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func metadataLine(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary).frame(width: 140, alignment: .leading)
            Text(value.isEmpty ? "Unavailable" : value).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private func valuesSection(_ title: String, values: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.medium))
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Text("•  \(value)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private func citationLine(_ citations: [JSON]) -> some View {
        if !citations.isEmpty {
            Text(citations.map { "\($0["source"].string):\($0["line"].int)" }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private func associationNode(_ title: String, icon: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title.isEmpty ? "Unnamed repository" : title, systemImage: icon)
                .font(.caption.weight(.medium))
                .lineLimit(2)
                .frame(maxWidth: 180, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(selected ? Palette.accent.opacity(0.13) : Palette.background, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(title)
        .accessibilityHint(selected ? "Open this repository in System" : "Workspace membership")
    }

    private func safeExternalURL(_ value: String) -> URL? {
        guard let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        return components.url
    }

    private func repositoryState(_ state: String) -> String {
        switch state {
        case "ready": return "Source snapshot available"
        case "updating": return "Source snapshot updating"
        case "failed": return "Refresh failed"
        case "empty": return "No retained snapshot"
        case "unavailable": return "Source unavailable"
        default: return "State unavailable"
        }
    }

    private func repositoryStateIcon(_ state: String) -> String {
        switch state {
        case "ready": return "checkmark.circle"
        case "updating": return "arrow.triangle.2.circlepath"
        case "failed", "unavailable": return "exclamationmark.triangle"
        default: return "questionmark.circle"
        }
    }

    private func selectAvailableWorkspace() {
        if let selected = app.understandingWorkspaceID, groups.contains(where: { $0.id == selected }) { return }
        if let id = app.projectFilter, groups.contains(where: { $0.id == id }) { app.understandingWorkspaceID = id }
        else { app.understandingWorkspaceID = groups.first?.id }
    }

    private func refreshOfflineWorkspaces() {
        guard credentialCacheIdentity != "unavailable",
              let recent = try? snapshotStore.readRecent(host: hostCacheIdentity, credential: credentialCacheIdentity) else {
            offlineWorkspaces = []; return
        }
        var seen = Set<String>()
        offlineWorkspaces = recent.compactMap { cached in
            guard let data = cached.envelope.overview, let page = try? JSON.parse(data) else { return nil }
            let id = page["workspace"]["id"].string
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return ProjectGroup(.object(["id": .string(id), "name": .string(page["workspace"]["name"].string),
                                         "revision": .number(Double(cached.membershipRevision)), "repos": .array([])]))
        }
    }

    /// Stops polling for a missing/old route or unsupported response version to avoid a retry loop.
    private func refreshWhileVisible() async {
        loading = false
        guard let group = currentGroup else { return }
        let hostID = app.activeID
        let hostIdentity = app.active?.pinnedMachineID ?? hostID
        guard app.connected, let client = app.client else {
            await loadCached(group: group)
            if snapshotScope == scope {
                failure = "The server is disconnected; showing this workspace’s retained snapshot."
                failureScope = scope
            }
            return
        }
        let groupID = group.id
        let credentialIdentity = credentialCacheIdentity
        let responseScope = "\(hostCacheIdentity)|\(credentialIdentity)|\(groupID)"
        guard unsupportedScope != responseScope else { return }

        while !Task.isCancelled {
            let groupRevision = group.revision
            guard app.activeID == hostID, (app.active?.pinnedMachineID ?? app.activeID) == hostIdentity, credentialCacheIdentity == credentialIdentity, app.connected, app.client === client,
                  currentGroup?.id == groupID, currentGroup?.revision == groupRevision else { return }
            loading = true
            do {
                let pathID = groupID.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? groupID
                let response = try await client.request("/project-groups/\(pathID)/understanding")
                guard !Task.isCancelled else { return }
                guard app.activeID == hostID, (app.active?.pinnedMachineID ?? app.activeID) == hostIdentity, credentialCacheIdentity == credentialIdentity, app.connected, app.client === client,
                      currentGroup?.id == groupID, currentGroup?.revision == groupRevision else { loading = false; return }
                guard response["schemaVersion"].int == 1 else {
                    failure = "This server returned an unsupported Understanding version. Update the server, then check again."
                    failureScope = responseScope
                    unsupportedScope = responseScope
                    loading = false
                    return
                }
                guard response["workspace"]["id"].string == groupID else {
                    failure = "The server returned a different workspace. Refresh to read the selected workspace."
                    failureScope = responseScope
                    unsupportedScope = responseScope
                    loading = false
                    return
                }
                guard response["workspace"]["revision"].int == groupRevision else {
                    failure = "Workspace membership changed while loading. The current page is being refreshed."
                    failureScope = responseScope
                    loading = false
                    do { try await Task.sleep(for: .seconds(12)) } catch { return }
                    continue
                }
                snapshot = response
                snapshotScope = responseScope
                snapshotRevision = groupRevision
                cacheNotice = false
                if let bytes = try? response.data() {
                    let retainedAt = Date()
                    do {
                        try snapshotStore.mergeOverview(host: hostCacheIdentity, credential: credentialIdentity,
                                                        workspace: groupID, membershipRevision: groupRevision,
                                                        observedAt: retainedAt, data: bytes)
                        cacheSavedAt = retainedAt
                    } catch { cacheSavedAt = nil }
                }
                failure = ""
                failureScope = ""
                loading = false
            } catch {
                guard !Task.isCancelled else { return }
                guard app.activeID == hostID, (app.active?.pinnedMachineID ?? app.activeID) == hostIdentity, credentialCacheIdentity == credentialIdentity, app.connected, app.client === client,
                      currentGroup?.id == groupID, currentGroup?.revision == groupRevision else { loading = false; return }
                let remote = error as? DesktopError
                if remote?.status == 404 {
                    failure = remote?.code == "project-group-not-found"
                        ? "This workspace is no longer available on this server. Choose another workspace."
                        : "Workspace Understanding requires a newer server. Update the server, then check again."
                    failureScope = responseScope
                    unsupportedScope = responseScope
                    clearWorkspaceCache(groupID, credential: credentialIdentity)
                    loading = false
                    return
                }
                if remote?.status == 401 || remote?.status == 403 {
                    clearWorkspaceCache(groupID, credential: credentialIdentity)
                }
                failure = error.localizedDescription
                failureScope = responseScope
                loading = false
            }
            do { try await Task.sleep(for: .seconds(12)) } catch { return }
        }
        loading = false
    }

    private func loadCached(group: ProjectGroup) async {
        guard credentialCacheIdentity != "unavailable",
              let cached = try? snapshotStore.read(host: hostCacheIdentity, credential: credentialCacheIdentity,
                                                  workspace: group.id, membershipRevision: group.revision),
              let overviewData = cached.envelope.overview,
              let page = try? JSON.parse(overviewData),
              page["schemaVersion"].int == 1, page["workspace"]["id"].string == group.id,
              page["workspace"]["revision"].int == group.revision else { return }
        snapshot = page
        snapshotScope = scope
        snapshotRevision = group.revision
        cacheNotice = true
        cacheSavedAt = cached.observedAt
    }
    private func clearWorkspaceCache(_ workspace: String, credential: String) {
        try? snapshotStore.clear(host: hostCacheIdentity, credential: credential, workspace: workspace)
        snapshot = nil; snapshotScope = ""; snapshotRevision = nil; cacheNotice = false; cacheSavedAt = nil
        offlineWorkspaces.removeAll { $0.id == workspace }
    }
}
