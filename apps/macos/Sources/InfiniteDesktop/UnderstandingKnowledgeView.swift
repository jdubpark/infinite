import SwiftUI
import InfiniteCore
import CryptoKit

/// Knowledge catalog and component map. Every mutation is an explicit owner action
/// against the last observed catalog revision; conflicts keep the editor open.
struct UnderstandingKnowledgeView: View {
    @ObservedObject var app: AppModel
    let group: ProjectGroup
    let overview: JSON
    @State private var catalog: JSON = .null
    @State private var index: [JSON] = []
    @State private var detail: JSON = .null
    @State private var selectedComponent = ""
    @State private var loading = false
    @State private var error = ""
    @State private var refreshToken = 0
    @State private var editor: Editor?
    @State private var componentDetails: [String: JSON] = [:]
    @State private var featureFilter = "all"
    @State private var retryRoute = ""
    @State private var retryBody: JSON?
    @State private var mutationInFlight = false
    @State private var catalogConflict = false
    private let snapshotStore = UnderstandingSnapshotStore()

    private var owner: Bool { app.isOwner }
    private var overviewGeneration: String { overview["observedAt"].string }
    private var components: [JSON] { index.isEmpty ? overview["knowledge"]["components"].array : index }
    private var catalogRevision: Int { catalog["revision"].int }
    private var selected: JSON? {
        guard !selectedComponent.isEmpty else { return nil }
        if detail["component"]["id"].string == selectedComponent { return detail["component"] }
        return overview["knowledge"]["components"].array.first { $0["id"].string == selectedComponent }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Workspace knowledge").font(.title3.weight(.semibold))
                if loading { ProgressView().controlSize(.small) }
                Spacer()
                if owner {
                    Menu("Add", systemImage: "plus") {
                        Button("Project") { openEditor(.project, value: .null) }
                        Button("Feature") { openEditor(.feature, value: .null) }
                        Button("Plan") { openEditor(.plan, value: .null) }
                    }.disabled(!app.connected)
                }
                Button("Refresh sources", systemImage: "arrow.clockwise") { Task { await refreshSources() } }
                    .disabled(!app.connected || !owner || loading)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            if !error.isEmpty {
                HStack {
                    Text(error).font(.caption).foregroundStyle(.orange)
                    if catalogConflict { Button("Reload latest catalog") { Task { await load(); catalogConflict = false } } }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.bottom, 8)
            }
            if !retryRoute.isEmpty, let retryBody {
                HStack { Text("A mutation response was uncertain.").font(.caption).foregroundStyle(.orange); Button("Retry same request") { Task { await performMutation(path: retryRoute, body: retryBody) } }.disabled(mutationInFlight || !app.connected) }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.bottom, 8)
            }
            HStack(spacing: 0) {
                List(selection: $selectedComponent) {
                    Section("Components · \(components.count)") {
                        ForEach(components, id: \.self["id"].string) { component in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(component["name"].string.isEmpty ? "Component" : component["name"].string).lineLimit(1)
                                if !componentDescription(component).isEmpty { Text(componentDescription(component)).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                Text("\(component["repositoryIds"].array.count) \(component["repositoryIds"].array.count == 1 ? "repository" : "repositories")").font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 3).tag(component["id"].string)
                        }
                    }
                    Section("Catalog") {
                        Label("Workspace overview", systemImage: "square.grid.2x2").tag("")
                        Label("\(catalog["projects"].array.filter { !$0["archived"].bool }.count) projects", systemImage: "square.stack.3d.up")
                        Label("\(catalog["features"].array.filter { !$0["archived"].bool }.count) features", systemImage: "checklist")
                        Label("\(catalog["plans"].array.filter { !$0["archived"].bool }.count) plans", systemImage: "map")
                    }
                }
                .listStyle(.sidebar).scrollContentBackground(.hidden).background(Palette.sidebar)
                .frame(minWidth: 235, idealWidth: 275, maxWidth: 330)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let component = selected { componentDetail(component) }
                        else { catalogDetail }
                    }
                    .frame(maxWidth: 1000, alignment: .leading).padding(22)
                }
            }
        }
        .task(id: "\(app.activeID)|\(group.id)|\(group.revision)|\(overviewGeneration)|\(refreshToken)") { await load() }
        .onChange(of: selectedComponent) { _, id in if !id.isEmpty { Task { await loadComponent(id) } } }
        .sheet(item: $editor) { draft in
            KnowledgeEditorSheet(app: app, group: group, catalogRevision: { catalogRevision }, catalog: catalog, overview: overview, components: index, draft: draft,
                onSaved: { await load() })
        }
    }

    private var catalogDetail: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Workspace knowledge").font(.title2.weight(.semibold))
                Text("Owner-maintained projects, feature assessments, component plans, and explicit maintenance policy.")
                    .foregroundStyle(.secondary)
            }
            if !catalog["coverage"].array.isEmpty { values("Catalog coverage", catalog["coverage"].array.map(\.string)) }
            catalogSection("Projects", values: catalog["projects"].array.filter { !$0["archived"].bool }, icon: "square.stack.3d.up", entity: .project)
            HStack {
                Text("Features").font(.headline)
                Spacer()
                Picker("Feature status", selection: $featureFilter) {
                    ForEach(["all", "planned", "active", "blocked", "completed", "cancelled", "failed"], id: \.self) { Text($0.capitalized).tag($0) }
                }.frame(width: 150)
            }
            catalogSection("", values: catalog["features"].array.filter { !$0["archived"].bool && (featureFilter == "all" || $0["status"].string == featureFilter) }, icon: "checklist", entity: .feature)
            catalogSection("Plans", values: catalog["plans"].array.filter { !$0["archived"].bool }, icon: "map", entity: .plan)
            policySection
            maintenanceSection
            deliverySection
            if !overview["knowledge"]["coverage"].array.isEmpty { values("Workspace coverage", overview["knowledge"]["coverage"].array.map(\.string)) }
        }
    }

    private func catalogSection(_ title: String, values: [JSON], icon: String, entity: Editor.Kind) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if !title.isEmpty { HStack {
                Label(title, systemImage: icon).font(.headline)
                Spacer()
                if owner { Button("Add") { openEditor(entity, value: .null) }.disabled(!app.connected) }
            } }
            if values.isEmpty { Text(title.isEmpty ? "No features match this filter." : "No recorded \(title.lowercased()).").font(.callout).foregroundStyle(.secondary) }
            ForEach(values, id: \.self["id"].string) { value in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(value["name"].string.isEmpty ? value["title"].string : value["name"].string).font(.subheadline.weight(.semibold))
                        Spacer()
                        if entity == .feature { Text(value["status"].string.capitalized).font(.caption).foregroundStyle(.secondary) }
                        if owner {
                            Button("Edit") { openEditor(entity, value: value) }.disabled(!app.connected)
                            Button("Archive") { Task { await archive(entity, value: value) } }.disabled(!app.connected)
                        }
                    }
                    Text(value["description"].string.isEmpty ? value["text"].string : value["description"].string)
                        .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    if entity == .feature {
                        Text("Assessment: \(value["status"].string) · linked work \(value["workIds"].array.count) · components \(value["componentIds"].array.count)")
                            .font(.caption).foregroundStyle(.secondary)
                        DisclosureGroup("Feature details and recorded work") {
                            Text(value["description"].string.isEmpty ? "No feature description recorded." : value["description"].string)
                                .font(.callout).textSelection(.enabled)
                            ForEach(value["workIds"].array, id: \.string) { workID in
                                if let work = overview["work"].array.first(where: { $0["id"].string == workID.string }) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("\(work["kind"].string.capitalized) · \(work["status"].string) · \(work["title"].string)").font(.subheadline.weight(.medium))
                                        Text(work["reportedSummary"].string.isEmpty ? "No reported result." : work["reportedSummary"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                        if !work["links"].array.isEmpty {
                                            ForEach(work["links"].array, id: \.self["url"].string) { link in
                                                if let url = safeURL(link["url"].string) { Link(link["label"].string.isEmpty ? "Open related record" : link["label"].string, destination: url) }
                                            }
                                        }
                                    }.padding(.vertical, 4)
                                }
                            }
                            if let url = safeURL(value["sourceUrl"].string) { Link("Open feature source", destination: url) }
                        }.font(.caption)
                    }
                    if entity == .project {
                        let features = catalog["features"].array.filter { !$0["archived"].bool && $0["projectId"].string == value["id"].string }
                        let done = features.filter { $0["status"].string == "completed" }.count
                        Text("Feature progress · \(done) completed / \(features.count) recorded")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(features, id: \.self["id"].string) { feature in
                            Text("\(feature["status"].string.capitalized) · \(feature["title"].string)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !value["repositoryIds"].array.isEmpty { Text("Repositories: \(value["repositoryIds"].array.map(\.string).joined(separator: ", "))").font(.caption).foregroundStyle(.secondary) }
                    history(value["history"].array)
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var policySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Maintenance policy").font(.headline)
            let policy = catalog["policy"]
            Text("\(policy["enabled"].bool ? "Enabled" : "Disabled") · synthesis \(policy["synthesis"].bool ? "on" : "off") · delivery \(policy["delivery"].bool ? "on" : "off") · every \(policy["intervalMinutes"].int) min · daily limit \(policy["dailyJobLimit"].int)")
                .font(.callout).textSelection(.enabled)
            if owner { Button("Edit policy") { openEditor(.policy, value: policy) }.disabled(catalog == .null || !app.connected) }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12))
    }

    private var maintenanceSection: some View {
        let m = overview["knowledge"]["maintenance"]
        return VStack(alignment: .leading, spacing: 7) {
            Text("Source maintenance").font(.headline)
            Text("State: \(m["state"].string.isEmpty ? "unavailable" : m["state"].string)").font(.callout.weight(.medium))
            if !m["message"].string.isEmpty { Text(m["message"].string).font(.callout).foregroundStyle(.secondary) }
            meta("Last observed", m["lastObservedAt"].string)
            meta("Last published", m["lastPublishedAt"].string)
            meta("Next attempt", m["nextAttemptAt"].string)
            Text("Jobs today: \(m["jobsToday"].int) / \(m["dailyJobLimit"].int)").font(.caption).foregroundStyle(.secondary)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12))
    }

    private var deliverySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Provider delivery observations").font(.headline)
            if overview["knowledge"]["delivery"].array.isEmpty { Text("No provider delivery observations available.").foregroundStyle(.secondary) }
            ForEach(overview["knowledge"]["delivery"].array, id: \.self["repositoryId"].string) { delivery in
                VStack(alignment: .leading, spacing: 7) {
                    Text("\(delivery["repositoryId"].string) · \(delivery["state"].string)").font(.subheadline.weight(.medium))
                    meta("Observed", delivery["observedAt"].string)
                    ForEach(delivery["pullRequests"].array, id: \.self["number"].int) { pr in
                        HStack {
                            Text("PR #\(pr["number"].int) · \(pr["state"].string) · head \(pr["head"].string)").font(.caption).textSelection(.enabled)
                            Spacer()
                            if let url = safeURL(pr["url"].string) { Link("Open", destination: url) }
                        }
                        ForEach(pr["checks"].array, id: \.self["name"].string) { check in
                            Text("Check · \(check["name"].string): \(check["status"].string) / \(check["conclusion"].string)").font(.caption).foregroundStyle(.secondary)
                        }
                        if !pr["mergeCommit"].string.isEmpty { Text("Provider-reported merge revision: \(pr["mergeCommit"].string)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                    ForEach(delivery["environments"].array, id: \.self["environment"].string) { env in
                        HStack {
                            Text("Environment · \(env["environment"].string) · \(env["status"].string) · \(env["revision"].string)").font(.caption).textSelection(.enabled)
                            Spacer()
                            if let url = safeURL(env["url"].string) { Link("Open", destination: url) }
                        }
                        Text("Provider observed \(env["observedAt"].string)").font(.caption2).foregroundStyle(.secondary)
                    }
                    if !delivery["coverage"].array.isEmpty { values("Delivery coverage", delivery["coverage"].array.map(\.string)) }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12))
            }
            Text("Provider merge reports and environment observations are separate. A merge does not establish deployment.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func componentDetail(_ fallback: JSON) -> some View {
        let value = detail == .null ? fallback : detail["component"]
        return VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(value["name"].string.isEmpty ? "Component" : value["name"].string).font(.title2.weight(.semibold))
                    if !componentDescription(value).isEmpty { Text(componentDescription(value)).foregroundStyle(.secondary).textSelection(.enabled) }
                    Text("\(value["repositoryIds"].array.count) \(value["repositoryIds"].array.count == 1 ? "repository" : "repositories")").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if owner { Button("Edit component") { openEditor(.component, value: overrideFor(selectedComponent)) }.disabled(!app.connected) }
            }
            HStack(spacing: 8) {
                statusPill("Current", value["current"]["state"].string)
                statusPill("Difference", value["difference"]["state"].string)
                if value["pinned"].bool { Label("Pinned", systemImage: "pin.fill").font(.caption) }
                if value["retired"].bool { Label("Retired", systemImage: "archivebox").font(.caption) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Current").font(.headline)
                Text(value["current"]["summary"].string.isEmpty ? "No current source summary is available." : value["current"]["summary"].string).textSelection(.enabled)
                meta("Latest source observation", value["current"]["sources"].array.map { $0["observedAt"].string }.max() ?? "")
                meta("Generated", value["current"]["generatedAt"].string)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Planned").font(.headline)
                if value["planned"].array.isEmpty { Text("No component plan is recorded.").foregroundStyle(.secondary) }
                ForEach(value["planned"].array, id: \.self["id"].string) { plan in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(plan["title"].string).font(.subheadline.weight(.medium)); Spacer(); Text(plan["status"].string.capitalized).font(.caption).foregroundStyle(.secondary) }
                        Text(plan["text"].string).textSelection(.enabled)
                        meta("Updated", plan["updatedAt"].string)
                        history(plan["history"].array)
                        if owner {
                            HStack {
                                Button("Edit") { openEditor(.plan, value: plan) }.disabled(!app.connected)
                                if plan["status"].string == "proposed" { Button("Accept") { Task { await setPlanStatus(plan, "accepted") } }.disabled(!app.connected) }
                                if plan["status"].string == "accepted" { Button("Supersede") { Task { await setPlanStatus(plan, "superseded") } }.disabled(!app.connected) }
                                Button("Archive") { Task { await archive(.plan, value: plan) } }.disabled(!app.connected)
                            }
                        }
                    }.padding(10).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 9))
                }
                if owner { Button("Add plan") { openEditor(.plan, value: .null) }.disabled(!app.connected) }
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("Difference from accepted plans").font(.headline)
                Text(value["difference"]["summary"].string.isEmpty ? "No comparison summary is available." : value["difference"]["summary"].string).textSelection(.enabled)
                meta("Generated", value["difference"]["generatedAt"].string)
            }
            relationshipSection
            if !value["current"]["claims"].array.isEmpty {
                DisclosureGroup("Current evidence") { claimList(value["current"]["claims"].array) }
            }
            if !value["difference"]["claims"].array.isEmpty {
                DisclosureGroup("Comparison evidence") { claimList(value["difference"]["claims"].array) }
            }
            DisclosureGroup("Observed files · \(value["files"].array.count)") {
                if value["files"].array.isEmpty { Text("No file inventory was recorded.").font(.caption).foregroundStyle(.secondary) }
                ForEach(Array(value["files"].array.enumerated()), id: \.offset) { _, file in
                    Text("\(file["repositoryId"].string) / \(file["path"].string) · \(file["lines"].int) lines · fingerprint \(file["hash"].string)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            DisclosureGroup("Source details") {
                VStack(alignment: .leading, spacing: 8) {
                    meta("Component ID", value["id"].string)
                    values("Repositories", value["repositoryIds"].array.map(\.string))
                    if !value["paths"].array.isEmpty { values("Mapped paths", value["paths"].array.map { "\($0["repositoryId"].string):\($0["path"].string)" }) }
                    meta("Current snapshot", value["current"]["snapshotId"].string)
                    ForEach(value["current"]["sources"].array, id: \.self["repositoryId"].string) { source in
                        Text("\(source["repositoryId"].string) · head \(source["head"].string) · fingerprint \(source["fingerprint"].string) · observed \(source["observedAt"].string)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    meta("Compared snapshot", value["difference"]["snapshotId"].string)
                    if !value["difference"]["planRevisions"].array.isEmpty { values("Plan revisions used", value["difference"]["planRevisions"].array.map { "\($0["id"].string) r\($0["revision"].int)" }) }
                }
            }
            if !value["history"].array.isEmpty { DisclosureGroup("Component history") { values("Recorded observations", value["history"].array.map { "\($0["at"].string) · \($0["summary"].string)" }) } }
            let coverage = Array(Set(value["coverage"].array.map(\.string) + detail["coverage"].array.map(\.string))).sorted()
            if !coverage.isEmpty { DisclosureGroup("Source coverage") { values("Coverage", coverage) } }
        }
        .id(value["id"].string)
    }

    private var relationshipSection: some View {
        let relationships = detail["relationships"].array
        return VStack(alignment: .leading, spacing: 8) {
            Text("Relationships").font(.headline)
            if relationships.isEmpty { Text("No typed relationships are reported.").foregroundStyle(.secondary) }
            ForEach(relationships, id: \.self["id"].string) { edge in
                let fromName = componentName(edge["from"].string)
                let toName = componentName(edge["to"].string)
                let relation = "\(fromName) \(edge["kind"].string) \(toName)"
                let neighbor = edge["to"].string == selectedComponent ? edge["from"].string : edge["to"].string
                let summary = edge["summary"].string.replacingOccurrences(of: edge["from"].string, with: fromName).replacingOccurrences(of: edge["to"].string, with: toName)
                Button { selectedComponent = edge["to"].string == selectedComponent ? edge["from"].string : edge["to"].string } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(relation, systemImage: "arrow.right")
                        if !summary.hasPrefix("Static import map reports a file-level dependency from ") { Text(summary).font(.caption).foregroundStyle(.secondary) }
                        Text("\(edge["basis"].string) evidence · open \(componentName(neighbor))").font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).padding(9).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 8))
                DisclosureGroup("Relationship evidence") {
                    Text(edge["summary"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    let sources = edge["evidence"].array.map { "\($0["source"].string)\($0["line"] == .null ? "" : ":\($0["line"].int)")" }
                    if !sources.isEmpty { values("Sources", sources) }
                }.font(.caption)
            }
        }
    }

    private func componentDescription(_ value: JSON) -> String {
        let description = value["description"].string
        return description == "Deterministic repository-layout component map; description has not been owner-verified." ? "" : description
    }
    private func componentName(_ id: String) -> String {
        let value = detail["component"]["id"].string == id ? detail["component"] : components.first { $0["id"].string == id } ?? .null
        return value["name"].string.isEmpty ? "Unavailable component" : value["name"].string
    }

    private func load() async {
        guard let client = app.client, app.connected else { loadCached(); return }
        loading = true; defer { loading = false }
        let hostID = app.activeID
        let membershipRevision = group.revision
        let credential = cacheCredential
        let overviewObservation = overview["observedAt"].string
        do {
            let base = routeBase
            async let catalogResult = client.request("\(base)/catalog")
            async let indexResult = client.request("\(base)/components")
            let (c, i) = try await (catalogResult, indexResult)
            guard !Task.isCancelled, overview["observedAt"].string == overviewObservation,
                  app.client === client, app.activeID == hostID, cacheCredential == credential,
                  app.projectGroups.group(group.id)?.revision == membershipRevision else { return }
            catalog = c; index = i["components"].array; error = ""
            if !selectedComponent.isEmpty {
                if index.contains(where: { $0["id"].string == selectedComponent }) {
                    await loadComponent(selectedComponent, overviewObservation: overviewObservation)
                } else {
                    selectedComponent = ""
                    detail = .null
                }
            }
            saveCache()
        } catch {
            self.error = error.localizedDescription
            if [401, 403, 404].contains((error as? DesktopError)?.status ?? 0) { clearCache() }
        }
    }
    private func loadComponent(_ id: String, overviewObservation: String? = nil) async {
        detail = .null
        if let cached = componentDetails[id] { detail = cached }
        guard let client = app.client, app.connected else { return }
        let hostID = app.activeID
        let workspaceID = group.id
        let membershipRevision = group.revision
        let credential = cacheCredential
        do {
            let path = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
            let response = try await client.request("\(routeBase)/components/\(path)")
            guard !Task.isCancelled, (overviewObservation == nil || overview["observedAt"].string == overviewObservation),
                  app.client === client, app.activeID == hostID, cacheCredential == credential, selectedComponent == id,
                  app.projectGroups.group(workspaceID)?.revision == membershipRevision else { return }
            detail = response
            componentDetails[id] = response
            saveDetailCache(id, detail: response)
        } catch {
            self.error = error.localizedDescription
            if [401, 403, 404].contains((error as? DesktopError)?.status ?? 0) { clearCache() }
        }
    }
    private var cacheHost: String {
        let profile = app.active
        let origin = "\(profile?.origin ?? "")|\(profile?.relayMachineID ?? "")"
        let originHash = SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(app.activeID)|\(profile?.pinnedMachineID ?? app.activeID)|\(originHash)"
    }
    private var cacheCredential: String {
        guard let active = app.active, let token = try? DeviceKeychain.read(active.id) else { return "unavailable" }
        return SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func saveCache() {
        guard cacheCredential != "unavailable" else { return }
        guard let catalogBytes = try? catalog.data(), let componentBytes = try? JSON.array(index).data() else { return }
        try? snapshotStore.mergeKnowledge(host: cacheHost, credential: cacheCredential, workspace: group.id,
                                          membershipRevision: group.revision, catalog: catalogBytes, components: componentBytes)
    }
    private func saveDetailCache(_ id: String, detail: JSON) {
        guard cacheCredential != "unavailable", let bytes = try? detail.data() else { return }
        try? snapshotStore.mergeComponentDetail(host: cacheHost, credential: cacheCredential, workspace: group.id,
                                                membershipRevision: group.revision, id: id, detail: bytes)
    }
    private func loadCached() {
        guard cacheCredential != "unavailable",
              let cached = try? snapshotStore.read(host: cacheHost, credential: cacheCredential,
                                                   workspace: group.id, membershipRevision: group.revision),
              let catalogBytes = cached.envelope.catalog, let componentsBytes = cached.envelope.components,
              let cachedCatalog = try? JSON.parse(catalogBytes), let cachedComponents = try? JSON.parse(componentsBytes) else { return }
        catalog = cachedCatalog
        index = cachedComponents.array
        componentDetails = cached.envelope.componentDetails.compactMapValues { try? JSON.parse($0) }
        if let selected = componentDetails[selectedComponent] { detail = selected }
    }
    private func clearCache() {
        guard cacheCredential != "unavailable" else { return }
        try? snapshotStore.clear(host: cacheHost, credential: cacheCredential, workspace: group.id)
        catalog = .null; index = []; detail = .null; componentDetails = [:]
    }
    private var routeBase: String { "/project-groups/\(group.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? group.id)/understanding" }
    private func refreshSources() async {
        guard app.isOwner, app.connected, let client = app.client else { return }
        do {
            _ = try await client.request("\(routeBase)/refresh", body: .object([:]), method: "POST")
            refreshToken += 1
        } catch { self.error = error.localizedDescription }
    }
    private func openEditor(_ kind: Editor.Kind, value: JSON) {
        editor = Editor(kind: kind, value: value, requestID: UUID().uuidString.lowercased(), baseRevision: catalogRevision)
    }
    private func archive(_ kind: Editor.Kind, value: JSON) async {
        guard owner, app.connected, app.client != nil, !value["id"].string.isEmpty else { return }
        let path = "\(routeBase)/catalog/\(kind.collection)/\(value["id"].string.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value["id"].string)"
        let envelope: JSON = .object(["requestId": .string(UUID().uuidString.lowercased()), "revision": .number(Double(catalogRevision)), "action": .string("archive")])
        await performMutation(path: path, body: envelope)
    }
    private func setPlanStatus(_ plan: JSON, _ status: String) async {
        let value: JSON = .object(["componentId": .string(plan["componentId"].string),
                                   "repositoryIds": .array(plan["repositoryIds"].array), "title": .string(plan["title"].string),
                                   "text": .string(plan["text"].string), "status": .string(status),
                                   "sourceUrl": plan["sourceUrl"] == .null ? .null : plan["sourceUrl"],
                                   "workId": plan["workId"] == .null ? .null : plan["workId"]])
        await mutate(.plan, id: plan["id"].string, value: value, requestID: UUID().uuidString.lowercased(), retryBody: nil)
    }
    private func mutate(_ kind: Editor.Kind, id: String?, value: JSON?, requestID: String, retryBody: JSON?) async {
        guard owner, app.connected, app.client != nil else { return }
        let escapedID = id.map { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? $0 }
        let route = "\(routeBase)/catalog/\(kind.collection)" + (escapedID.map { "/\($0)" } ?? "")
        let body = retryBody ?? .object(["requestId": .string(requestID), "revision": .number(Double(catalogRevision)), "action": .string(id == nil ? "create" : "update"), "value": value ?? .null])
        await performMutation(path: route, body: body)
    }
    private func performMutation(path: String, body: JSON) async {
        guard owner, app.connected, let client = app.client, !mutationInFlight else { return }
        mutationInFlight = true; defer { mutationInFlight = false }
        retryRoute = path; retryBody = body
        do {
            _ = try await client.request(path, body: body, method: "POST")
            retryRoute = ""; retryBody = nil; error = ""
            await load()
        } catch {
            self.error = error.localizedDescription
            let status = (error as? DesktopError)?.status ?? 0
            catalogConflict = status == 409
            if status != 0 { retryRoute = ""; retryBody = nil }
        }
    }
    private func overrideFor(_ id: String) -> JSON {
        catalog["componentOverrides"].array.first { $0["id"].string == id }
            ?? overview["knowledge"]["components"].array.first { $0["id"].string == id }
            ?? (detail["component"]["id"].string == id ? detail["component"] : .null)
    }
    @ViewBuilder private func history(_ items: [JSON]) -> some View {
        if !items.isEmpty {
            DisclosureGroup("History") {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text("r\(item["revision"].int) · \(item["at"].string) · \(item["summary"].string)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }.font(.caption)
        }
    }
    private func values(_ title: String, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(title).font(.subheadline.weight(.medium)); ForEach(Array(items.enumerated()), id: \.offset) { _, item in Text("•  \(item)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) } }
    }
    private func meta(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) { Text(title).frame(width: 130, alignment: .leading).font(.caption.weight(.medium)).foregroundStyle(.secondary); Text(value.isEmpty ? "Unavailable" : value).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
    }
    private func claimList(_ claims: [JSON]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(claims.enumerated()), id: \.offset) { _, claim in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(claim["basis"].string.capitalized): \(claim["text"].string)").font(.callout).textSelection(.enabled)
                    ForEach(Array(claim["evidence"].array.enumerated()), id: \.offset) { _, evidence in
                        let citation = evidence["line"] == .null ? evidence["source"].string : "\(evidence["source"].string):\(evidence["line"].int)"
                        Text(citation).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
        }
    }
    private func statusPill(_ name: String, _ value: String) -> some View {
        Label("\(name): \(value.isEmpty ? "unknown" : value)", systemImage: name == "Current" ? "dot.radiowaves.left.and.right" : "arrow.left.arrow.right")
            .font(.caption).padding(.horizontal, 8).padding(.vertical, 5).background(Palette.sidebar, in: Capsule())
    }
    private func safeURL(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value), parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil else { return nil }
        return parts.url
    }
}

private struct Editor: Identifiable {
    enum Kind: String { case project, feature, plan, component, policy
        var collection: String { self == .component ? "components" : rawValue + "s" }
    }
    let id = UUID()
    let kind: Kind
    let value: JSON
    let requestID: String
    let baseRevision: Int
}

private struct KnowledgeEditorSheet: View {
    @ObservedObject var app: AppModel
    let group: ProjectGroup
    let catalogRevision: () -> Int
    let catalog: JSON
    let overview: JSON
    let components: [JSON]
    let draft: Editor
    let onSaved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var text = ""
    @State private var status = "planned"
    @State private var projectID = ""
    @State private var componentID = ""
    @State private var repositoryIDs = ""
    @State private var workIDs = ""
    @State private var componentIDs = ""
    @State private var sourceURL = ""
    @State private var linkedWorkID = ""
    @State private var redirectTo = ""
    @State private var pinned = false
    @State private var enabled = false
    @State private var synthesis = false
    @State private var delivery = false
    @State private var interval = "60"
    @State private var dailyLimit = "20"
    @State private var saving = false
    @State private var error = ""
    @State private var conflict = false
    @State private var deliveryUnknown = false
    @State private var lastRequest: (path: String, body: JSON)?

    private var isUpdate: Bool { !draft.value["id"].string.isEmpty || draft.kind == .policy }
    private var repos: [String] { repositoryIDs.split(whereSeparator: \.isNewline).map(String.init).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var componentChoices: [JSON] {
        var choices = components
        let selectedIDs = [componentID, redirectTo] + componentIDs.split(whereSeparator: \.isNewline).map(String.init)
        for id in selectedIDs where !id.isEmpty && !choices.contains(where: { $0["id"].string == id }) {
            choices.append(.object(["id": .string(id), "name": .string("\(id) · unavailable")]))
        }
        return choices
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("\(isUpdate ? "Edit" : "Create") \(draft.kind.rawValue.capitalized)").font(.title2.weight(.semibold)); Spacer(); Button("Cancel") { dismiss() }.disabled(saving || deliveryUnknown) }
            Form {
                if draft.kind != .policy {
                    if draft.kind == .project || draft.kind == .feature || draft.kind == .plan || draft.kind == .component {
                        field(draft.kind == .project || draft.kind == .component ? "Name" : "Title", text: $name)
                    }
                    if draft.kind == .project || draft.kind == .feature || draft.kind == .component { TextField("Description", text: $description, axis: .vertical).lineLimit(3...8) }
                    if draft.kind == .plan { TextField("Plan", text: $text, axis: .vertical).lineLimit(4...12) }
                    if draft.kind == .feature { Picker("Owner assessment", selection: $status) { ForEach(["planned", "active", "blocked", "completed", "cancelled", "failed"], id: \.self) { Text($0.capitalized).tag($0) } } }
                    if draft.kind == .plan { Picker("Plan status", selection: $status) { ForEach(["proposed", "accepted", "superseded"], id: \.self) { Text($0.capitalized).tag($0) } } }
                    if draft.kind == .feature {
                        Picker("Project", selection: $projectID) {
                            Text("Unassigned").tag("")
                            ForEach(catalog["projects"].array.filter { !$0["archived"].bool }, id: \.self["id"].string) { Text($0["name"].string).tag($0["id"].string) }
                        }
                    }
                    if !group.repos.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Repositories").font(.caption.weight(.medium))
                            ForEach(group.repos, id: \.projectID) { repo in Toggle("\(repo.name) · \(repo.projectID)", isOn: repositoryBinding(repo.projectID)) }
                        }
                    } else { field("Repository ID", text: $repositoryIDs) }
                    if draft.kind == .feature {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Linked work").font(.caption.weight(.medium))
                            ForEach(overview["work"].array, id: \.self["id"].string) { item in Toggle("\(item["title"].string) · \(item["status"].string)", isOn: workBinding(item["id"].string)) }
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Components").font(.caption.weight(.medium))
                            ForEach(componentChoices, id: \.self["id"].string) { item in Toggle(item["name"].string.isEmpty ? item["id"].string : item["name"].string, isOn: componentBinding(item["id"].string)) }
                        }
                    }
                    if draft.kind == .plan || draft.kind == .feature { field("Source URL (optional)", text: $sourceURL) }
                    if draft.kind == .plan {
                        Picker("Component", selection: $componentID) {
                            Text("Choose a component").tag("")
                            ForEach(componentChoices, id: \.self["id"].string) { Text($0["name"].string.isEmpty ? $0["id"].string : $0["name"].string).tag($0["id"].string) }
                        }
                        Picker("Linked work", selection: $linkedWorkID) {
                            Text("No linked work").tag("")
                            ForEach(overview["work"].array, id: \.self["id"].string) { Text($0["title"].string).tag($0["id"].string) }
                        }
                    }
                    if draft.kind == .component {
                        Picker("Redirect to", selection: $redirectTo) {
                            Text("No redirect").tag("")
                            ForEach(componentChoices.filter { $0["id"].string != draft.value["id"].string }, id: \.self["id"].string) { Text($0["name"].string).tag($0["id"].string) }
                        }
                        Toggle("Pinned", isOn: $pinned)
                    }
                } else {
                    Toggle("Enable maintenance", isOn: $enabled)
                    Toggle("Allow synthesis jobs", isOn: $synthesis)
                    Toggle("Collect provider delivery", isOn: $delivery)
                    field("Interval in minutes", text: $interval)
                    field("Daily job limit", text: $dailyLimit)
                }
            }
            .disabled(saving || deliveryUnknown)
            if conflict {
                Text("The catalog changed. Your draft is preserved. Reload the latest catalog, review it, then explicitly resubmit with a new request ID.").font(.caption).foregroundStyle(.orange)
                HStack {
                    Button("Reload latest") { Task { await onSaved(); error = "Latest catalog loaded. Your draft remains open; review the latest catalog before resubmitting." } }
                    Button("Resubmit draft") { Task { await save(newRequestID: UUID().uuidString.lowercased()) } }
                }.disabled(saving || deliveryUnknown || !app.connected || !app.isOwner)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if deliveryUnknown, let lastRequest {
                Button("Retry same request") { Task { await send(path: lastRequest.path, body: lastRequest.body) } }.disabled(saving || !app.connected || !app.isOwner)
            }
            HStack { Spacer(); Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(saving || deliveryUnknown || conflict || !app.connected || !app.isOwner) }
        }
        .padding(20).frame(minWidth: 560, minHeight: 560)
        .interactiveDismissDisabled(saving || deliveryUnknown)
        .onAppear(perform: populate)
    }
    private func populate() {
        let v = draft.value
        name = v["name"].string.isEmpty ? v["title"].string : v["name"].string
        description = v["description"].string; text = v["text"].string; status = v["status"].string.isEmpty ? (draft.kind == .plan ? "proposed" : "planned") : v["status"].string
        projectID = v["projectId"].string; componentID = v["componentId"].string
        repositoryIDs = v["repositoryIds"].array.map(\.string).joined(separator: "\n")
        workIDs = v["workIds"].array.map(\.string).joined(separator: "\n")
        componentIDs = v["componentIds"].array.map(\.string).joined(separator: "\n")
        sourceURL = v["sourceUrl"].string; redirectTo = v["redirectTo"].string; pinned = v["pinned"].bool
        linkedWorkID = v["workId"].string
        enabled = v["enabled"].bool; synthesis = v["synthesis"].bool; delivery = v["delivery"].bool
        if v["intervalMinutes"].int > 0 { interval = String(v["intervalMinutes"].int) }
        if v["dailyJobLimit"].int > 0 { dailyLimit = String(v["dailyJobLimit"].int) }
    }
    @ViewBuilder private func field(_ title: String, text: Binding<String>, multiline: Bool = false) -> some View {
        if multiline { TextField(title, text: text, axis: .vertical).lineLimit(2...5) }
        else { TextField(title, text: text) }
    }
    private func repositoryBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { repos.contains(id) }, set: { enabled in
            var selected = repos
            if enabled && !selected.contains(id) { selected.append(id) }
            if !enabled { selected.removeAll { $0 == id } }
            repositoryIDs = selected.joined(separator: "\n")
        })
    }
    private func workBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { workIDs.split(whereSeparator: \.isNewline).map(String.init).contains(id) }, set: { enabled in
            var selected = workIDs.split(whereSeparator: \.isNewline).map(String.init)
            if enabled && !selected.contains(id) { selected.append(id) }
            if !enabled { selected.removeAll { $0 == id } }
            workIDs = selected.joined(separator: "\n")
        })
    }
    private func componentBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { componentIDs.split(whereSeparator: \.isNewline).map(String.init).contains(id) }, set: { enabled in
            var selected = componentIDs.split(whereSeparator: \.isNewline).map(String.init)
            if enabled && !selected.contains(id) { selected.append(id) }
            if !enabled { selected.removeAll { $0 == id } }
            componentIDs = selected.joined(separator: "\n")
        })
    }
    private func save(newRequestID: String? = nil) async {
        guard app.isOwner, app.connected, app.client != nil, !saving, !deliveryUnknown, !conflict || newRequestID != nil else { return }
        let action = isUpdate ? "update" : "create"
        let value: JSON
        switch draft.kind {
        case .policy:
            value = .object(["enabled": .bool(enabled), "synthesis": .bool(synthesis), "delivery": .bool(delivery), "intervalMinutes": .number(Double(Int(interval) ?? 60)), "dailyJobLimit": .number(Double(Int(dailyLimit) ?? 20))])
        case .project:
            value = .object(["name": .string(name), "description": .string(description), "repositoryIds": .array(repos.map(JSON.string))])
        case .feature:
            value = .object(["projectId": projectID.isEmpty ? .null : .string(projectID), "title": .string(name), "description": .string(description), "repositoryIds": .array(repos.map(JSON.string)), "workIds": .array(workIDs.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map(JSON.string)), "componentIds": .array(componentIDs.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map(JSON.string)), "status": .string(status), "sourceUrl": sourceURL.isEmpty ? .null : .string(sourceURL)])
        case .plan:
            value = .object(["componentId": .string(componentID), "repositoryIds": .array(repos.map(JSON.string)), "title": .string(name), "text": .string(text), "status": .string(status), "sourceUrl": sourceURL.isEmpty ? .null : .string(sourceURL), "workId": linkedWorkID.isEmpty ? .null : .string(linkedWorkID)])
        case .component:
            let id = draft.value["id"].string
            guard !id.isEmpty else { error = "Choose an existing component to add an override."; return }
            value = .object(["repositoryIds": .array(repos.map(JSON.string)), "name": .string(name), "description": .string(description), "redirectTo": redirectTo.isEmpty ? .null : .string(redirectTo), "pinned": .bool(pinned)])
        }
        let requestID = newRequestID ?? draft.requestID
        let revision = newRequestID == nil ? draft.baseRevision : catalogRevision()
        let body: JSON = .object(["requestId": .string(requestID), "revision": .number(Double(revision)), "action": .string(action), "value": value])
        let id = draft.value["id"].string
        let escapedID = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
        let suffix = draft.kind == .policy ? "policy" : draft.kind.collection + (isUpdate && draft.kind != .policy ? "/\(escapedID)" : "")
        let base = "/project-groups/\(group.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? group.id)/understanding/catalog/\(suffix)"
        await send(path: base, body: body)
    }
    private func send(path: String, body: JSON) async {
        guard app.isOwner, app.connected, let client = app.client, !saving else { return }
        saving = true; defer { saving = false }
        lastRequest = (path, body)
        do {
            _ = try await client.request(path, body: body, method: "POST")
            deliveryUnknown = false; conflict = false
            await onSaved(); dismiss()
        } catch {
            let remote = error as? DesktopError
            self.error = error.localizedDescription
            if remote?.code == "delivery-unknown" {
                deliveryUnknown = true; conflict = false
            } else if remote?.status == 409 {
                deliveryUnknown = false; conflict = true
            }
            if deliveryUnknown { self.error += " Retry this exact request to resolve its delivery before editing or submitting another change." }
        }
    }
}
