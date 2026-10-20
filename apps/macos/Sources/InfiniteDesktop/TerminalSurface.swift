import SwiftUI
import WebKit
import InfiniteCore

@MainActor final class TerminalPipe {
    var receive: ((Data, Bool, Int?, Int?) -> Void)?
    private var dimensions: (Int?, Int?) = (nil, nil)
    private var snapshot = Data()
    private var history = Data()
    private var replayAvailable = true
    func feed(_ data: Data, reset: Bool = false, columns: Int? = nil, rows: Int? = nil) {
        if reset { dimensions = (columns, rows) }
        if reset { snapshot = data; history = Data(); replayAvailable = true }
        else if replayAvailable { history.append(data) }
        if snapshot.count + history.count > 8 * 1024 * 1024 {
            // A byte suffix is not a terminal snapshot: it may begin inside an
            // escape sequence or depend on modes established before the suffix.
            snapshot = Data(); history = Data(); replayAvailable = false
        }
        receive?(data, reset, columns, rows)
    }
    func clear() { dimensions = (nil, nil); snapshot = Data(); history = Data(); replayAvailable = true }
    func replay() -> Bool {
        guard replayAvailable else { return false }
        receive?(snapshot + history, true, dimensions.0, dimensions.1); return true
    }
}

struct TerminalSurface: NSViewRepresentable {
    let pipe: TerminalPipe
    var acceptsInput: Bool
    /// Fit the terminal to this view and resize the PTY; only a lease holder may.
    var followsViewport: Bool = false
    /// Cursor animation runs only while this terminal is on a visible page.
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
        pipe.receive = { [weak coordinator = context.coordinator] data, reset, columns, rows in coordinator?.feed(data, reset, columns, rows) }
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
        private var pending = Data()
        private var pendingReset = false
        private var dimensions: (Int?, Int?) = (nil, nil)
        private var writing = false
        private var overflowed = false
        private var renderGeneration = UUID()
        private var controlled: Bool?
        private var following: Bool?
        private var rendered: Bool?
        var disposed = false
        func follow(_ enabled: Bool) {
            guard !disposed, following != enabled else { return }
            following = enabled
            Task { try? await view?.callAsyncJavaScript("window.infiniteTerminal.follow(enabled)", arguments: ["enabled": enabled], in: nil, contentWorld: .page) }
        }
        func render(_ enabled: Bool) {
            guard !disposed, rendered != enabled else { return }
            rendered = enabled
            Task { try? await view?.callAsyncJavaScript("window.infiniteTerminal.render(enabled)", arguments: ["enabled": enabled], in: nil, contentWorld: .page) }
        }
        func control(_ enabled: Bool) {
            guard !disposed else { return }
            let next = enabled && !overflowed
            // SwiftUI re-runs updateNSView on every poll; only a real change crosses the bridge.
            if controlled == next { return }
            controlled = next
            Task { try? await view?.callAsyncJavaScript("window.infiniteTerminal.control(enabled)", arguments: ["enabled": next], in: nil, contentWorld: .page) }
        }
        init(_ parent: TerminalSurface) { self.parent = parent }
        func feed(_ data: Data, _ reset: Bool, _ columns: Int?, _ rows: Int?) {
            guard ready, !disposed else { return }
            if reset { renderGeneration = UUID(); pending = Data(); pendingReset = true; overflowed = false; dimensions = (columns, rows) }
            guard !overflowed else { return }
            if pending.count + data.count > 8 * 1024 * 1024 {
                pending = Data("\r\nTerminal rendering paused. Reconnect this terminal to refresh its screen.\r\n".utf8)
                pendingReset = true; renderGeneration = UUID(); overflowed = true; control(false)
                parent.onFailure("Terminal rendering fell behind. Reconnect the terminal for a fresh screen before sending input.")
            } else { pending.append(data) }
            guard !writing else { return }
            writing = true
            Task {
                defer { writing = false }
                while !pending.isEmpty || pendingReset {
                    guard !disposed else { return }
                    let bytes = pending; let reset = pendingReset; let size = dimensions; let generation = renderGeneration
                    pending = Data(); pendingReset = false
                    do {
                        guard let view else { return }
                        _ = try await view.callAsyncJavaScript("await window.infiniteTerminal.feed(bytes, reset, columns, rows)", arguments: ["bytes": bytes.base64EncodedString(), "reset": reset, "columns": size.0 ?? 0, "rows": size.1 ?? 0], in: nil, contentWorld: .page)
                        if reset && !overflowed && !disposed && generation == renderGeneration { parent.onReady() }
                    } catch {
                        guard !disposed else { return }
                        renderGeneration = UUID(); overflowed = true; control(false); parent.onFailure("Terminal rendering failed. Reconnect the terminal before sending input."); return
                    }
                }
            }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !disposed, message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                ready = true
                guard parent.pipe.replay() else {
                    overflowed = true; control(false)
                    parent.onFailure("Terminal history exceeded its replay limit. Reconnect the terminal for a fresh screen before sending input.")
                    return
                }
                control(parent.acceptsInput); follow(parent.followsViewport)
                render(parent.isVisible)
                if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int { parent.onResize(cols, rows) }
            case "input": if ready, !overflowed, parent.acceptsInput, let text = body["text"] as? String { parent.onInput(text) }
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
            renderGeneration = UUID(); ready = false; overflowed = true; control(false); parent.onFailure(message)
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
    /// Inside a glass container the editor draws no fill of its own.
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
        view.placeholder = placeholder
        // Drafting remains possible while offline; enabled gates submission only.
        view.canSubmit = enabled
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptEditor
        init(_ parent: PromptEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) { if let view = notification.object as? NSTextView { parent.text = view.string } }
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
