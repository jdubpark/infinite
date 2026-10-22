import SwiftUI
import InfiniteCore
import CryptoKit

/// Source-linked finite-state models and ordered counterexample replay for one component.
/// A check is an explicit owner action; polling only reads its recorded run.
struct UnderstandingBehaviorView: View {
    @ObservedObject var app: AppModel
    let group: ProjectGroup
    let componentID: String
    let currentSourceSnapshotID: String
    let currentSourceState: String
    let behaviors: [JSON]
    let onAccessDenied: () -> Void

    @State private var selectedID = ""
    @State private var remoteBehavior: JSON = .null
    @State private var modelSide = "current"
    @State private var selectedRunID = ""
    @State private var selectedPropertyID = ""
    @State private var traceIndex = 0
    @State private var focusedState = ""
    @State private var focusedTransition = ""
    @State private var pendingRunBodies: [String: JSON] = [:]
    @State private var busy = false
    @State private var loading = false
    @State private var error = ""
    @State private var sourcesExpanded = false
    @State private var expandedTransitionEvidence: Set<String> = []

    private var componentBehaviors: [JSON] {
        behaviors.filter { $0["definition"]["componentId"].string == componentID }
    }
    private var behavior: JSON? {
        if remoteBehavior["id"].string == selectedID { return remoteBehavior }
        return componentBehaviors.first { $0["id"].string == selectedID }
    }
    private var runs: [JSON] { (behavior?["runs"].array ?? []).sorted { $0["startedAt"].string < $1["startedAt"].string } }
    private var selectedRun: JSON? { runs.first { $0["id"].string == selectedRunID } ?? runs.last }
    private var model: JSON { behavior?["definition"][modelSide] ?? .null }
    private var check: JSON { selectedRun?[modelSide] ?? .null }
    private var selectedRunDefinitionMatches: Bool { selectedRun == nil || selectedRun?["definitionRevision"].int == currentRevision }
    private var selectedRunModelMatches: Bool { selectedRun == nil || check == .null || (!check["modelHash"].string.isEmpty && check["modelHash"].string == modelHash(model)) }
    private var canAssociateResultWithModel: Bool { selectedRunDefinitionMatches && selectedRunModelMatches }
    private var modelHashMismatch: Bool { selectedRun != nil && check != .null && selectedRunDefinitionMatches && !selectedRunModelMatches }
    private var sourceFreshness: String {
        guard !currentSourceSnapshotID.isEmpty, currentSourceState != "unavailable" else { return "unavailable" }
        return currentSourceState == "stale" || behavior?["definition"]["sourceSnapshotId"].string != currentSourceSnapshotID ? "stale" : "current"
    }
    private var associationNotice: String? {
        if !selectedRunDefinitionMatches {
            return "This run belongs to definition revision \(selectedRun?["definitionRevision"].int ?? 0); the active definition is revision \(currentRevision). Its ordered trace remains available as raw run evidence. The current graph and property basis are hidden because they may describe a different model. Current source freshness above belongs to the active definition."
        }
        if modelHashMismatch {
            return "The selected result’s model hash does not match the active \(modelSide) model. Its ordered trace remains available as raw run evidence; the graph and property basis are hidden."
        }
        return nil
    }
    private var property: JSON? {
        guard canAssociateResultWithModel else { return nil }
        return model["properties"].array.first { $0["id"].string == selectedPropertyID } ?? model["properties"].array.first
    }
    private var outcome: JSON? {
        let results = check["properties"].array
        if !canAssociateResultWithModel { return results.first { $0["id"].string == selectedPropertyID } ?? results.first }
        return results.first { $0["id"].string == property?["id"].string }
    }
    private var trace: [JSON] { outcome?["trace"].array ?? [] }
    private var selectedStep: JSON? { trace.isEmpty ? nil : trace[min(traceIndex, trace.count - 1)] }
    private var currentRevision: Int { behavior?["revision"].int ?? 0 }
    private var pendingRunBody: JSON? { pendingRunBodies[selectedID] }
    private var isStale: Bool { behavior?["freshness"].string != "current" }
    private var isRunning: Bool { behavior?["status"].string == "running" || (behavior?["runs"].array ?? []).contains { $0["state"].string == "running" } }
    private var base: String {
        let workspace = group.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? group.id
        return "/project-groups/\(workspace)/understanding"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Behavior checks · \(componentBehaviors.count)").font(.headline)
                if loading { ProgressView().controlSize(.small) }
                Spacer()
            }
            if componentBehaviors.isEmpty {
                Text("No behavior definition is linked to this component. Add one from source references and recorded requirements with the CLI or an agent, then reload component knowledge.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                if componentBehaviors.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(componentBehaviors, id: \.self["id"].string) { item in
                                Button("\(item["definition"]["title"].string) · r\(item["revision"].int)") { select(item["id"].string) }
                                    .buttonStyle(.bordered).tint(selectedID == item["id"].string ? .accentColor : .secondary)
                            }
                        }
                    }
                }
                if let behavior {
                    sourceSection(behavior)
                    Picker("Model", selection: $modelSide) {
                        Text("Current").tag("current")
                        if behavior["definition"]["planned"] != .null || (selectedRun?["planned"] ?? .null) != .null { Text("Planned").tag("planned") }
                    }.pickerStyle(.segmented)
                    Text(modelSide == "current" ? "Current source model" : "Planned model")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("A passing finite-state check is model evidence. It does not prove the implementation behaves this way.")
                        .font(.caption).foregroundStyle(.secondary)
                    runControls(behavior)
                    if !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(errorColor)
                    }
                    recordedRuns
                    if let selectedRun {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Selected run · \(selectedRun["id"].string) · definition revision \(selectedRun["definitionRevision"].int) · \(selectedRun["startedAt"].string)")
                                .font(.caption).foregroundStyle(.secondary)
                            meta("Definition fingerprint", selectedRun["definitionHash"].string)
                        }
                    }
                    if let associationNotice {
                        Text(associationNotice)
                            .font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                    }
                    if let property { propertyDetail(property) }
                    if check != .null { checkerDetail }
                    if let outcome, !trace.isEmpty { traceReplay(outcome) }
                    if canAssociateResultWithModel && model != .null { diagram }
                    ForEach(Array(behavior["coverage"].array.enumerated()), id: \.offset) { _, item in
                        Text("Coverage · \(item.string)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 12))
        .onAppear { selectInitial() }
        .onChange(of: componentBehaviors) { _, next in updateFromList(next) }
        .onChange(of: modelSide) { _, _ in selectedPropertyID = ""; traceIndex = 0; focusedState = ""; focusedTransition = "" }
        .onChange(of: selectedID) { _, _ in
            selectedRunID = ""; selectedPropertyID = ""; traceIndex = 0; focusedState = ""; focusedTransition = ""
        }
        .task(id: "\(selectedID):\(isRunning)") {
            guard !selectedID.isEmpty else { return }
            let id = selectedID
            var latest = await fetchBehavior(id)
            while !Task.isCancelled, latest.map(isBehaviorRunning) == true {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { break }
                latest = await fetchBehavior(id)
            }
        }
        .onChange(of: runs.map { $0["id"].string }) { _, ids in
            if !ids.contains(selectedRunID) { selectedRunID = ids.last ?? "" }
        }
        .onChange(of: check["properties"].array.map { $0["id"].string }) { _, ids in
            if !ids.contains(selectedPropertyID) { selectedPropertyID = ids.first ?? "" }
        }
    }

    private func selectInitial() {
        guard selectedID.isEmpty, let first = componentBehaviors.first else { return }
        selectedID = first["id"].string
        remoteBehavior = first
    }
    private func select(_ id: String) {
        guard selectedID != id else { return }
        selectedID = id
        remoteBehavior = .null
        error = ""
    }
    private func updateFromList(_ list: [JSON]) {
        if selectedID.isEmpty, let first = list.first { selectedID = first["id"].string; remoteBehavior = first; return }
        guard let latest = list.first(where: { $0["id"].string == selectedID }) else { return }
        if remoteBehavior["id"].string == latest["id"].string,
           remoteBehavior["revision"].int != latest["revision"].int {
            selectedRunID = ""; selectedPropertyID = ""; traceIndex = 0; focusedState = ""; focusedTransition = ""
        }
        remoteBehavior = latest
    }
    private func accept(_ value: JSON) {
        guard value["id"].string == selectedID, value["definition"]["componentId"].string == componentID else { return }
        if remoteBehavior["id"].string == value["id"].string,
           remoteBehavior["revision"].int != value["revision"].int {
            selectedRunID = ""; selectedPropertyID = ""; traceIndex = 0; focusedState = ""; focusedTransition = ""
        }
        remoteBehavior = value
    }
    private func fetchBehavior(_ id: String) async -> JSON? {
        guard let client = app.client, app.connected else { return nil }
        loading = true
        defer { loading = false }
        do {
            let escaped = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
            let value = try await client.request("\(base)/behaviors/\(escaped)")
            guard selectedID == id, value["id"].string == id,
                  value["definition"]["componentId"].string == componentID,
                  app.projectGroups.group(group.id)?.revision == group.revision else { return nil }
            accept(value)
            error = ""
            return value
        } catch {
            let status = (error as? DesktopError)?.status ?? 0
            if [401, 403, 404].contains(status) { remoteBehavior = .null; onAccessDenied() }
            else { self.error = error.localizedDescription }
            return nil
        }
    }
    private func isBehaviorRunning(_ value: JSON) -> Bool {
        value["status"].string == "running" || value["runs"].array.contains { $0["state"].string == "running" }
    }

    private func sourceSection(_ behavior: JSON) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(behavior["definition"]["title"].string) · latest result \(statusLabel(behavior))")
                .font(.subheadline.weight(.semibold))
            meta("Source snapshot freshness", sourceFreshness)
            meta("Behavior/check freshness", behavior["freshness"].string)
            meta("Source snapshot", behavior["definition"]["sourceSnapshotId"].string)
            meta("Requirement revision", behavior["definition"]["requirementRevision"].string)
            values("Plan revisions", behavior["definition"]["planRevisions"].array.map { "\($0["id"].string) r\($0["revision"].int)" })
            Button("\(sourcesExpanded ? "Hide" : "Show") captured source fingerprints · \(behavior["sources"].array.count) files") { sourcesExpanded.toggle() }
                .buttonStyle(.link).font(.caption)
            if sourcesExpanded {
                ForEach(Array(behavior["sources"].array.enumerated()), id: \.offset) { _, source in
                    Text("Source · \(source["repositoryId"].string) / \(source["path"].string):\(source["lines"].int) · fingerprint \(source["hash"].string)")
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            ForEach(Array(behavior["definition"]["assumptions"].array.enumerated()), id: \.offset) { _, item in
                Text("Assumption · \(item.string)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(Array(behavior["definition"]["exclusions"].array.enumerated()), id: \.offset) { _, item in
                Text("Exclusion · \(item.string)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if sourceFreshness != "current" { Text("The behavior definition’s source snapshot does not match current component evidence.").font(.caption).foregroundStyle(.orange) }
            if isStale { Text("The host marks this behavior or its latest result stale or unavailable; review the selected run and captured plan revisions before running another check.").font(.caption).foregroundStyle(.orange) }
        }
    }

    private func runControls(_ behavior: JSON) -> some View {
        HStack(spacing: 8) {
            if let pendingRunBody {
                Button(busy ? "Sending…" : "Retry same check request") { Task { await sendRun(pendingRunBody, for: selectedID) } }
                    .disabled(busy || !app.connected || !app.isOwner)
            } else {
                Button(busy ? "Starting…" : "Run check", systemImage: "play.fill") { Task { await createRun(behavior) } }
                    .disabled(!app.isOwner || !app.connected || busy || isStale)
            }
            if !app.isOwner { Text("Owner access is required to run a check.").font(.caption).foregroundStyle(.secondary) }
            if !app.connected { Text("Read-only while disconnected.").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var recordedRuns: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recorded runs · previous traces remain available").font(.caption.weight(.semibold))
            if runs.isEmpty { Text("Unchecked · no model-check run is recorded.").font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(runs.enumerated()), id: \.element["id"].string) { index, run in
                Button {
                    selectedRunID = run["id"].string; selectedPropertyID = ""; traceIndex = 0; focusedState = ""; focusedTransition = ""
                } label: {
                    HStack {
                        Text("Run \(index + 1) · \(run["state"].string) · definition r\(run["definitionRevision"].int) · \(run["startedAt"].string)")
                        Spacer()
                        if selectedRun?["id"].string == run["id"].string { Image(systemName: "checkmark.circle.fill") }
                    }.font(.caption)
                }.buttonStyle(.plain)
            }
        }
    }

    private var diagram: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("State and transition diagram · initial \(model["initial"].string)").font(.subheadline.weight(.semibold))
            ForEach(model["states"].array, id: \.self["id"].string) { state in
                Button {
                    focusedState = state["id"].string
                    if selectedStep == nil { focusedTransition = "" }
                } label: {
                    HStack {
                        Text(state["label"].string.isEmpty ? state["id"].string : state["label"].string).font(.caption.weight(.semibold))
                        Spacer()
                        if state["id"].string == model["initial"].string { Text("Initial").font(.caption2) }
                        if state["id"].string == (selectedStep?["state"].string ?? focusedState) { Image(systemName: "scope") }
                    }
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(stateBackground(state["id"].string, active: selectedStep?["state"].string ?? focusedState), in: RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain).accessibilityLabel("Focus state \(state["label"].string)")
            }
            Text("Transitions · select an edge to focus it").font(.caption.weight(.semibold))
            ForEach(model["transitions"].array, id: \.self["id"].string) { edge in
                VStack(alignment: .leading, spacing: 5) {
                    Button {
                        focusedTransition = edge["id"].string
                        focusedState = ""
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 6) {
                                stateNode(edge["from"].string)
                                VStack(spacing: 2) {
                                    Text(edge["label"].string.isEmpty ? edge["event"].string : edge["label"].string).font(.caption2).lineLimit(2)
                                    Image(systemName: "arrow.right").foregroundStyle(.tint)
                                }.frame(minWidth: 74)
                                stateNode(edge["to"].string)
                            }
                            Text("\(edge["id"].string) · \(edge["actor"].string) · \(edge["event"].string) · guard \(display(edge["guard"]))")
                                .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                            if !edge["effects"].object.isEmpty {
                                values("Effects", edge["effects"].object.keys.sorted().map { key in "\(key)=\(display(edge["effects"][key]))" })
                            }
                        }
                    }
                    .buttonStyle(.plain).accessibilityLabel("Focus transition \(edge["id"].string) from \(edge["from"].string) to \(edge["to"].string)")
                    let evidenceItems = edge["evidence"].array
                    if !evidenceItems.isEmpty {
                        DisclosureGroup(isExpanded: Binding(
                            get: { expandedTransitionEvidence.contains(edge["id"].string) },
                            set: { expanded in
                                if expanded { expandedTransitionEvidence.insert(edge["id"].string) }
                                else { expandedTransitionEvidence.remove(edge["id"].string) }
                            }
                        )) {
                            evidence(evidenceItems)
                        } label: {
                            Text("Transition evidence · \(evidenceItems.count)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(edge["id"].string == (selectedStep?["transitionId"].string ?? focusedTransition) ? Color.orange.opacity(0.15) : Palette.sidebar,
                            in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(edge["id"].string == (selectedStep?["transitionId"].string ?? focusedTransition) ? Color.accentColor : Color.clear, lineWidth: 1))
            }
            ForEach(model["variables"].array, id: \.self["id"].string) { variable in
                Text("Variable \(variable["id"].string) · initial \(display(variable["initial"])) · domain \(variable["domain"].array.map(display).joined(separator: ", "))")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }
    private var checkerDetail: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Checker result · \(check["status"].string) · \(check["exhaustive"].bool ? "exhaustive" : "bounded")").font(.subheadline.weight(.semibold))
            meta("Engine", "\(check["tool"].string) \(check["toolVersion"].string)")
            meta("Explored", "\(check["exploredStates"].int) states · \(check["exploredTransitions"].int) transitions")
            meta("Limits", "\(check["limits"]["maxStates"].int) states · \(check["limits"]["maxTransitions"].int) transitions · \(check["limits"]["timeoutMs"].int) ms · \(check["limits"]["maxTraceSteps"].int) trace steps")
            if !check["message"].string.isEmpty { Text(check["message"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            ForEach(check["properties"].array, id: \.self["id"].string) { result in
                if canAssociateResultWithModel {
                    let definition = model["properties"].array.first { $0["id"].string == result["id"].string }
                    Text("\(definition?["basis"].string.capitalized ?? "Property") · \(definition?["title"].string ?? result["id"].string) · \(result["status"].string) · reachable states \(result["reachableStates"].int)")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Button {
                        selectedPropertyID = result["id"].string; traceIndex = 0
                    } label: {
                        Text("Historical property · \(result["id"].string) · \(result["status"].string) · reachable states \(result["reachableStates"].int)")
                            .font(.caption).foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private func propertyDetail(_ value: JSON) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(value["basis"].string.capitalized) requirement · \(value["kind"].string)").font(.subheadline.weight(.semibold))
                Spacer()
                if model["properties"].array.count > 1 {
                    Picker("Property", selection: $selectedPropertyID) {
                        ForEach(model["properties"].array, id: \.self["id"].string) { item in Text(item["title"].string).tag(item["id"].string) }
                    }.frame(maxWidth: 300)
                }
            }
            Text(value["title"].string).font(.caption.weight(.semibold))
            Text(value["requirement"].string).font(.callout).textSelection(.enabled)
            evidence(value["evidence"].array)
            Text("Property result · \(outcome?["status"].string ?? (selectedRun == nil ? "unchecked" : selectedRun?["state"].string ?? "unavailable"))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func traceReplay(_ result: JSON) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Ordered counterexample replay\(result["traceTruncated"].bool ? " · truncated" : "")").font(.subheadline.weight(.semibold))
            HStack {
                Button("Previous") { traceIndex = max(0, traceIndex - 1) }.disabled(traceIndex <= 0)
                Text("Step \(traceIndex + 1) of \(trace.count)").font(.caption).foregroundStyle(.secondary)
                Button("Next") { traceIndex = min(trace.count - 1, traceIndex + 1) }.disabled(traceIndex >= trace.count - 1)
            }
            if let step = selectedStep {
                Text("Active state · \(step["state"].string)").font(.callout.weight(.semibold))
                if !step["transitionId"].string.isEmpty {
                    if canAssociateResultWithModel {
                        Button("Active transition · \(step["transitionId"].string)") { focusedTransition = step["transitionId"].string; focusedState = step["state"].string }
                            .buttonStyle(.link)
                    } else {
                        Text("Historical transition · \(step["transitionId"].string)").font(.caption).foregroundStyle(.secondary)
                    }
                } else { Text("Initial state").font(.caption).foregroundStyle(.secondary) }
                if !step["summary"].string.isEmpty { Text(step["summary"].string).font(.caption).textSelection(.enabled) }
                ForEach(step["values"].object.keys.sorted(), id: \.self) { key in
                    Text("\(key) = \(display(step["values"][key]))").font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
        .padding(10).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
    }

    private func createRun(_ behavior: JSON) async {
        guard app.isOwner, app.connected, !isStale, !busy else { return }
        let body = JSON.object(["requestId": .string(UUID().uuidString.lowercased()), "revision": .number(Double(behavior["revision"].int))])
        let id = behavior["id"].string
        pendingRunBodies[id] = body
        await sendRun(body, for: id)
    }
    private func sendRun(_ body: JSON, for id: String) async {
        guard let client = app.client, app.connected, app.isOwner, !busy else { return }
        busy = true; error = ""
        defer { busy = false }
        do {
            let escaped = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
            let value = try await client.request("\(base)/behaviors/\(escaped)/run", body: body)
            guard value["id"].string == id, value["definition"]["componentId"].string == componentID else {
                throw DesktopError("The host returned behavior outside the selected component.")
            }
            pendingRunBodies[id] = nil
            if selectedID == id {
                accept(value)
                selectedRunID = value["runs"].array.sorted { $0["startedAt"].string < $1["startedAt"].string }.last?["id"].string ?? ""
                selectedPropertyID = ""; traceIndex = 0; focusedState = ""; focusedTransition = ""
                error = "Check accepted. Results are model evidence and do not prove implementation behavior."
            }
        } catch {
            let failure = error as? DesktopError
            if failure?.status == 0 || failure?.code == "delivery-unknown" {
                pendingRunBodies[id] = body
                if selectedID == id { self.error = "Delivery is uncertain. Retry sends the same request ID and revision; polling never starts another check." }
            } else if failure?.status == 409 {
                pendingRunBodies[id] = nil
                if selectedID == id {
                    self.error = "The definition revision changed. The latest definition is loading; press Run check to send a new explicit request."
                    _ = await fetchBehavior(id)
                }
            } else if [401, 403].contains(failure?.status ?? 0) {
                pendingRunBodies[id] = nil
                if selectedID == id { remoteBehavior = .null }
                onAccessDenied()
            } else {
                pendingRunBodies[id] = nil
                if selectedID == id { self.error = error.localizedDescription }
            }
        }
    }

    private func stateNode(_ id: String) -> some View {
        Text(model["states"].array.first { $0["id"].string == id }?["label"].string ?? id)
            .font(.caption2.weight(.medium)).multilineTextAlignment(.center).lineLimit(2)
            .frame(maxWidth: .infinity, minHeight: 34).padding(.horizontal, 5)
            .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.25), lineWidth: 1))
    }
    private func stateBackground(_ id: String, active: String) -> Color {
        id == active ? Color.orange.opacity(0.14) : Palette.sidebar
    }
    private func statusLabel(_ value: JSON) -> String {
        switch value["status"].string {
        case "unchecked": return "Unchecked"
        case "running": return "Running"
        case "inconclusive": return "Inconclusive"
        case "stale": return "Stale"
        default: return value["status"].string.capitalized
        }
    }
    private func modelHash(_ value: JSON) -> String {
        SHA256.hash(data: Data(canonicalJSON(value).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func canonicalJSON(_ value: JSON) -> String {
        switch value {
        case .object(let fields):
            return "{" + fields.keys.sorted().map { key in "\(quotedJSON(key)):\(canonicalJSON(fields[key] ?? .null))" }.joined(separator: ",") + "}"
        case .array(let items): return "[" + items.map(canonicalJSON).joined(separator: ",") + "]"
        case .string(let string): return quotedJSON(string)
        case .number(let number): return number.rounded() == number ? String(Int64(number)) : String(number)
        case .bool(let boolean): return boolean ? "true" : "false"
        case .null: return "null"
        }
    }
    private func quotedJSON(_ value: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let bytes = (try? encoder.encode(value)) ?? Data("\"\"".utf8)
        return String(decoding: bytes, as: UTF8.self)
    }
    private var errorColor: Color {
        error.hasPrefix("Check accepted") ? Color.secondary : Color.orange
    }
    private func display(_ value: JSON) -> String {
        switch value {
        case .string(let string): return string
        case .number(let number): return number.rounded() == number ? String(Int(number)) : String(number)
        case .bool(let bool): return bool ? "true" : "false"
        case .null: return "null"
        case .array, .object: return (try? String(data: value.data(), encoding: .utf8)) ?? "unavailable"
        }
    }
    private func evidence(_ list: [JSON]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(list.enumerated()), id: \.offset) { _, item in
                Text("\(item["repositoryId"].string.isEmpty ? "" : "\(item["repositoryId"].string) · ")\(item["source"].string)\(item["line"] == .null ? "" : ":\(item["line"].int)")\(item["text"].string.isEmpty ? "" : " · \(item["text"].string)")")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }
    private func meta(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value.isEmpty ? "unavailable" : value).font(.caption).textSelection(.enabled)
        }
    }
    private func values(_ title: String, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(items.isEmpty ? "none" : items.joined(separator: ", ")).font(.caption).textSelection(.enabled)
        }
    }
}
