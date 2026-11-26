import SwiftUI
import WebKit
import InfiniteCore

struct TerminalDimensions: Equatable, Sendable {
    let columns: Int
    let rows: Int

    init?(columns: Int?, rows: Int?) {
        guard let columns, let rows, (1...1000).contains(columns), (1...1000).contains(rows) else { return nil }
        self.columns = columns
        self.rows = rows
    }

    init?(json: JSON) {
        guard case .object = json else { return nil }
        if let cols = Self.validDimension(json["cols"]), let rows = Self.validDimension(json["rows"]) {
            self.columns = cols
            self.rows = rows
            return
        }
        if let cols = Self.validDimension(json["columns"]), let rows = Self.validDimension(json["rows"]) {
            self.columns = cols
            self.rows = rows
            return
        }
        return nil
    }

    private static func validDimension(_ value: JSON) -> Int? {
        guard let number = value.number, number.isFinite,
              number.rounded(.towardZero) == number,
              number >= 1, number <= 1000 else { return nil }
        return Int(number)
    }
}

struct TerminalFeedStep: Equatable, Sendable {
    var data: Data
    var reset: Bool
    var dimensions: TerminalDimensions?
    var completesReplay: Bool = false
}

struct TerminalFeedQueue: Equatable, Sendable {
    enum ReplayCompletion: Equatable, Sendable {
        case none
        case queued
        case completedNow
    }

    static let maxPendingBytes = 8 * 1024 * 1024
    static let maxPendingSteps = 4096

    private(set) var steps: [TerminalFeedStep] = []
    private(set) var pendingBytes = 0
    private(set) var overflowed = false
    private(set) var activeReplayGeneration: UUID?

    var isEmpty: Bool { steps.isEmpty }
    var isReplayingHistory: Bool { activeReplayGeneration != nil }

    func effectiveFollow(desired: Bool) -> Bool { desired && !isReplayingHistory && !overflowed }
    func effectiveInputEnabled(desired: Bool) -> Bool { desired && !isReplayingHistory && !overflowed }

    mutating func enqueueReplay(_ replaySteps: [TerminalFeedStep], generation: UUID, awaitsCompletion: Bool = false) -> Bool {
        guard !replaySteps.isEmpty else { return true }
        let bytes = replaySteps.reduce(0) { $0 + $1.data.count }
        if bytes > Self.maxPendingBytes || replaySteps.count > Self.maxPendingSteps {
            triggerOverflow()
            return false
        }
        var normalized = replaySteps
        for index in normalized.indices {
            normalized[index].completesReplay = !awaitsCompletion && (index == normalized.count - 1)
        }
        steps = normalized
        pendingBytes = bytes
        overflowed = false
        activeReplayGeneration = generation
        return true
    }

    mutating func enqueue(
        data: Data,
        reset: Bool,
        dimensions: TerminalDimensions?,
        completesReplay: Bool = true,
        generation: UUID = UUID()
    ) -> Bool {
        if reset {
            if !completesReplay || activeReplayGeneration != nil {
                activeReplayGeneration = generation
            }
            steps = [TerminalFeedStep(data: data, reset: true, dimensions: dimensions, completesReplay: completesReplay)]
            pendingBytes = data.count
            overflowed = false
            if pendingBytes > Self.maxPendingBytes {
                triggerOverflow()
                return false
            }
            return true
        }
        guard !overflowed else { return true }
        guard !data.isEmpty || dimensions != nil else { return true }
        if pendingBytes + data.count > Self.maxPendingBytes {
            triggerOverflow()
            return false
        }
        if let lastIndex = steps.indices.last,
           dimensions == nil || steps[lastIndex].dimensions == dimensions {
            steps[lastIndex].data.append(data)
            pendingBytes += data.count
            return true
        }
        if steps.count >= Self.maxPendingSteps {
            triggerOverflow()
            return false
        }
        steps.append(TerminalFeedStep(data: data, reset: false, dimensions: dimensions, completesReplay: false))
        pendingBytes += data.count
        return true
    }

    mutating func markReplayComplete(writing: Bool, currentGeneration: UUID) -> ReplayCompletion {
        guard !overflowed, let replayGeneration = activeReplayGeneration, replayGeneration == currentGeneration else {
            return .none
        }
        if let lastIndex = steps.indices.last {
            steps[lastIndex].completesReplay = true
            return .queued
        }
        if writing {
            steps.append(TerminalFeedStep(data: Data(), reset: false, dimensions: nil, completesReplay: true))
            return .queued
        }
        activeReplayGeneration = nil
        return .completedNow
    }

    mutating func dequeue() -> TerminalFeedStep? {
        guard !steps.isEmpty else { return nil }
        let next = steps.removeFirst()
        pendingBytes = max(0, pendingBytes - next.data.count)
        return next
    }

    mutating func completeStep(_ step: TerminalFeedStep, generation: UUID, currentGeneration: UUID) -> Bool {
        guard !overflowed, generation == currentGeneration, step.completesReplay else { return false }
        if activeReplayGeneration == generation { activeReplayGeneration = nil }
        return true
    }

    mutating func markFailed() {
        steps = []
        pendingBytes = 0
        overflowed = true
        activeReplayGeneration = nil
    }

    private mutating func triggerOverflow() {
        let notice = Data("\r\nTerminal rendering paused. Reconnect this terminal to refresh its screen.\r\n".utf8)
        steps = [TerminalFeedStep(data: notice, reset: true, dimensions: nil, completesReplay: false)]
        pendingBytes = notice.count
        overflowed = true
        activeReplayGeneration = nil
    }
}

@MainActor final class TerminalPipe {
    struct Entry: Equatable {
        var data: Data
        var dimensions: TerminalDimensions?
    }

    static let maxHistoryBytes = 8 * 1024 * 1024
    static let maxHistoryEntries = 4096

    var receive: ((Data, Bool, Int?, Int?) -> Void)?
    var receiveStep: ((Data, Bool, Int?, Int?, Bool) -> Void)?
    var onCompleteReplay: (() -> Void)?
    private(set) var activeDimensions: TerminalDimensions?
    private(set) var streamReplayPending = false
    private var entries: [Entry] = []
    private var totalBytes = 0
    private var replayAvailable = true

    func feed(_ data: Data, reset: Bool = false, columns: Int? = nil, rows: Int? = nil, completesReplay: Bool = true) {
        let size = TerminalDimensions(columns: columns, rows: rows)
        if reset {
            activeDimensions = size
            replayAvailable = true
            streamReplayPending = !completesReplay
            if data.count > Self.maxHistoryBytes {
                entries = []
                totalBytes = 0
                replayAvailable = false
            } else {
                entries = [Entry(data: data, dimensions: size)]
                totalBytes = data.count
            }
            receive?(data, true, size?.columns, size?.rows)
            receiveStep?(data, true, size?.columns, size?.rows, completesReplay)
            return
        }
        let sizeChanged = size != nil && size != activeDimensions
        if let size { activeDimensions = size }
        guard !data.isEmpty || sizeChanged else { return }
        if replayAvailable {
            if totalBytes + data.count > Self.maxHistoryBytes {
                entries = []
                totalBytes = 0
                replayAvailable = false
            } else if entries.isEmpty {
                entries = [Entry(data: data, dimensions: activeDimensions)]
                totalBytes = data.count
            } else if sizeChanged {
                if entries.count == 1 && entries[0].data.isEmpty && entries[0].dimensions == nil {
                    entries[0].dimensions = size
                    entries[0].data.append(data)
                    totalBytes += data.count
                } else if entries.count >= Self.maxHistoryEntries {
                    entries = []
                    totalBytes = 0
                    replayAvailable = false
                } else {
                    entries.append(Entry(data: data, dimensions: size))
                    totalBytes += data.count
                }
            } else if let lastIndex = entries.indices.last {
                entries[lastIndex].data.append(data)
                totalBytes += data.count
            }
        }
        receive?(data, false, size?.columns, size?.rows)
        receiveStep?(data, false, size?.columns, size?.rows, false)
    }

    func completeReplay() {
        guard streamReplayPending else { return }
        streamReplayPending = false
        onCompleteReplay?()
    }

    func clear() {
        activeDimensions = nil
        streamReplayPending = false
        entries = []
        totalBytes = 0
        replayAvailable = true
    }

    func replaySteps() -> [TerminalFeedStep]? {
        guard replayAvailable else { return nil }
        guard !entries.isEmpty else {
            return [TerminalFeedStep(data: Data(), reset: true, dimensions: activeDimensions, completesReplay: !streamReplayPending)]
        }
        let lastIndex = entries.count - 1
        return entries.enumerated().map { index, entry in
            TerminalFeedStep(data: entry.data, reset: index == 0, dimensions: entry.dimensions, completesReplay: !streamReplayPending && index == lastIndex)
        }
    }

    func replay() -> Bool {
        guard let steps = replaySteps() else { return false }
        for step in steps {
            receive?(step.data, step.reset, step.dimensions?.columns, step.dimensions?.rows)
        }
        return true
    }
}

struct TerminalSurface: NSViewRepresentable {
    let pipe: TerminalPipe
    var acceptsInput: Bool
    var followsViewport: Bool = false
    var isVisible: Bool = true
    var onInput: (String) -> Void
    var onResize: (Int, Int) -> Void
    var onFailure: (String) -> Void = { _ in }
    var onReady: () -> Void = {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: WKWebView, context: Context) -> CGSize? {
        guard let width = proposal.width, let height = proposal.height, width.isFinite, height.isFinite else { return nil }
        return CGSize(width: width, height: height)
    }
    func makeNSView(context: Context) -> WKWebView {
        let controller = WKUserContentController(); controller.add(context.coordinator, name: "terminal")
        let configuration = WKWebViewConfiguration(); configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.view = view
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("Terminal/terminal.html")
        let url = FileManager.default.fileExists(atPath: bundled.path) ? bundled : Bundle.module.url(forResource: "terminal", withExtension: "html", subdirectory: "Resources")!
        context.coordinator.allowedRoot = url.deletingLastPathComponent()
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        pipe.receiveStep = { [weak coordinator = context.coordinator] data, reset, columns, rows, completesReplay in
            coordinator?.feed(data, reset, columns, rows, completesReplay: completesReplay)
        }
        pipe.onCompleteReplay = { [weak coordinator = context.coordinator] in
            coordinator?.completeReplay()
        }
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.ready else { return }
        context.coordinator.control(acceptsInput)
        context.coordinator.follow(followsViewport)
        context.coordinator.render(isVisible)
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.disposed = true; coordinator.ready = false
        view.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        view.stopLoading()
    }
    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: TerminalSurface; weak var view: WKWebView?; var ready = false; var allowedRoot: URL?
        private var queue = TerminalFeedQueue()
        private var writing = false
        private var renderGeneration = UUID()
        private var desiredControl = false
        private var controlled: Bool?
        private var desiredFollow = false
        private var following = false
        private var rendered: Bool?
        var disposed = false
        func follow(_ enabled: Bool) {
            desiredFollow = enabled
            syncFollow()
        }
        private func applyFollow() async {
            guard !disposed else { return }
            let effective = queue.effectiveFollow(desired: desiredFollow)
            guard following != effective else { return }
            following = effective
            _ = try? await view?.callAsyncJavaScript("window.infiniteTerminal.follow(enabled)", arguments: ["enabled": effective], in: nil, contentWorld: .page)
        }
        private func syncFollow() {
            guard !disposed else { return }
            let effective = queue.effectiveFollow(desired: desiredFollow)
            guard following != effective else { return }
            following = effective
            Task { try? await view?.callAsyncJavaScript("window.infiniteTerminal.follow(enabled)", arguments: ["enabled": effective], in: nil, contentWorld: .page) }
        }
        func render(_ enabled: Bool) {
            guard !disposed, rendered != enabled else { return }
            rendered = enabled
            Task { try? await view?.callAsyncJavaScript("window.infiniteTerminal.render(enabled)", arguments: ["enabled": enabled], in: nil, contentWorld: .page) }
        }
        func control(_ enabled: Bool) {
            desiredControl = enabled
            syncControl()
        }
        private func applyControl() async {
            guard !disposed else { return }
            let next = queue.effectiveInputEnabled(desired: desiredControl)
            guard controlled != next else { return }
            controlled = next
            _ = try? await view?.callAsyncJavaScript("window.infiniteTerminal.control(enabled)", arguments: ["enabled": next], in: nil, contentWorld: .page)
        }
        private func syncControl() {
            guard !disposed else { return }
            let next = queue.effectiveInputEnabled(desired: desiredControl)
            guard controlled != next else { return }
            controlled = next
            Task { try? await view?.callAsyncJavaScript("window.infiniteTerminal.control(enabled)", arguments: ["enabled": next], in: nil, contentWorld: .page) }
        }
        init(_ parent: TerminalSurface) { self.parent = parent }
        private func replay(_ steps: [TerminalFeedStep], awaitsCompletion: Bool) {
            guard ready, !disposed else { return }
            let generation = UUID()
            renderGeneration = generation
            let accepted = queue.enqueueReplay(steps, generation: generation, awaitsCompletion: awaitsCompletion)
            syncFollow()
            syncControl()
            if !accepted {
                renderGeneration = UUID(); syncControl(); syncFollow()
                parent.onFailure("Terminal rendering fell behind. Reconnect the terminal for a fresh screen before sending input.")
            }
            drain()
        }
        func feed(_ data: Data, _ reset: Bool, _ columns: Int?, _ rows: Int?, completesReplay: Bool = true) {
            guard ready, !disposed else { return }
            let size = TerminalDimensions(columns: columns, rows: rows)
            if reset { renderGeneration = UUID() }
            let accepted = queue.enqueue(data: data, reset: reset, dimensions: size, completesReplay: completesReplay, generation: renderGeneration)
            syncFollow()
            syncControl()
            if !accepted {
                renderGeneration = UUID(); syncControl(); syncFollow()
                parent.onFailure("Terminal rendering fell behind. Reconnect the terminal for a fresh screen before sending input.")
            }
            drain()
        }
        func completeReplay() {
            guard ready, !disposed else { return }
            let generation = renderGeneration
            switch queue.markReplayComplete(writing: writing, currentGeneration: generation) {
            case .none:
                break
            case .queued:
                drain()
            case .completedNow:
                Task {
                    await applyFollow()
                    await applyControl()
                    if !disposed && !queue.overflowed && generation == renderGeneration { parent.onReady() }
                }
            }
        }
        private func drain() {
            guard !writing, !queue.isEmpty else { return }
            writing = true
            Task {
                defer { writing = false }
                while let step = queue.dequeue() {
                    guard !disposed else { return }
                    let generation = renderGeneration
                    do {
                        guard let view else { return }
                        _ = try await view.callAsyncJavaScript("await window.infiniteTerminal.feed(bytes, reset, columns, rows)", arguments: ["bytes": step.data.base64EncodedString(), "reset": step.reset, "columns": step.dimensions?.columns ?? 0, "rows": step.dimensions?.rows ?? 0], in: nil, contentWorld: .page)
                        if queue.completeStep(step, generation: generation, currentGeneration: renderGeneration), !disposed {
                            await applyFollow()
                            await applyControl()
                            if !disposed && !queue.overflowed && generation == renderGeneration { parent.onReady() }
                        }
                    } catch {
                        guard !disposed else { return }
                        renderGeneration = UUID(); queue.markFailed(); syncControl(); syncFollow(); parent.onFailure("Terminal rendering failed. Reconnect the terminal before sending input."); return
                    }
                }
            }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !disposed, message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                ready = true
                guard let steps = parent.pipe.replaySteps() else {
                    queue.markFailed(); syncControl(); syncFollow()
                    parent.onFailure("Terminal history exceeded its replay limit. Reconnect the terminal for a fresh screen before sending input.")
                    return
                }
                desiredControl = parent.acceptsInput
                desiredFollow = parent.followsViewport
                render(parent.isVisible)
                replay(steps, awaitsCompletion: parent.pipe.streamReplayPending)
                if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int { parent.onResize(cols, rows) }
            case "input": if ready, queue.effectiveInputEnabled(desired: parent.acceptsInput), let text = body["text"] as? String { parent.onInput(text) }
            case "resize": if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int { parent.onResize(cols, rows) }
            default: break
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, url.isFileURL, let root = allowedRoot,
                  url.standardizedFileURL.path == root.appendingPathComponent("terminal.html").standardizedFileURL.path else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        private func failed(_ message: String) {
            guard !disposed else { return }
            renderGeneration = UUID(); ready = false; queue.markFailed(); syncControl(); syncFollow(); parent.onFailure(message)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed("Terminal renderer could not load: \(error.localizedDescription)") }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed("Terminal renderer failed: \(error.localizedDescription)") }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed("Terminal renderer stopped. Reconnect this terminal to recover its screen.") }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task {
                let initialized = try? await webView.evaluateJavaScript("Boolean(window.infiniteTerminal)") as? Bool
                if initialized != true { failed("Terminal renderer did not initialize. Rebuild the app's bundled terminal assets.") }
            }
        }
    }
}

struct PromptEditor: NSViewRepresentable {
    @Binding var text: String
    var placeholder = ""
    var enabled: Bool
    var editable = true
    var transparent = false
    var submit: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let textView = DraftTextView(); textView.delegate = context.coordinator
        textView.font = .systemFont(ofSize: 14); textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false; textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false; textView.isAutomaticSpellingCorrectionEnabled = false
        textView.backgroundColor = NSColor.textBackgroundColor; textView.drawsBackground = !transparent
        textView.textContainerInset = NSSize(width: 10, height: 12)
        textView.autoresizingMask = [.width]; textView.isVerticallyResizable = true
        textView.textContainer?.widthTracksTextView = true
        textView.onSubmit = { context.coordinator.parent.submit() }
        let scroll = NSScrollView(); scroll.documentView = textView; scroll.hasVerticalScroller = true
        scroll.drawsBackground = !transparent; scroll.borderType = .noBorder
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? DraftTextView else { return }
        if view.string != text { view.string = text }
        view.isEditable = editable
        view.placeholder = placeholder
        view.canSubmit = enabled
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptEditor
        init(_ parent: PromptEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard parent.editable else { return }
            if let view = notification.object as? NSTextView { parent.text = view.string }
        }
    }
    final class DraftTextView: NSTextView {
        var onSubmit: (() -> Void)?; var canSubmit = false
        var placeholder = "" { didSet { if placeholder != oldValue { needsDisplay = true } } }
        override func didChangeText() { super.didChangeText(); needsDisplay = true }
        override func draw(_ rect: NSRect) {
            super.draw(rect)
            guard string.isEmpty, !placeholder.isEmpty, let font else { return }
            let origin = NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height)
            placeholder.draw(at: origin, withAttributes: [.font: font, .foregroundColor: NSColor.placeholderTextColor])
        }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 36, !event.modifierFlags.contains(.shift), !hasMarkedText() {
                if canSubmit { onSubmit?() }; return
            }
            super.keyDown(with: event)
        }
    }
}
