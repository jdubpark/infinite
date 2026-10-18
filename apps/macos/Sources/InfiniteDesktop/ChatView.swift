import SwiftUI
import InfiniteCore

/// The conversation as the provider recorded it: prompts, replies, and one line per tool call.
struct ChatView: View {
    @ObservedObject var model: SessionModel
    @State private var lastVisible = true
    private static let clock: DateFormatter = { let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f }()
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    catchUp
                    if model.messageSource == "recording" && !model.messages.isEmpty {
                        Text("This session predates chat transcripts: only prompts sent through Infinite appear here. Open Screen for the agent's output.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(model.messages) { message in
                        row(message).id(message.id)
                            .onAppear { if message.id == model.messages.last?.id { lastVisible = true } }
                            .onDisappear { if message.id == model.messages.last?.id { lastVisible = false } }
                    }
                    if !model.chatNote.isEmpty { Text(model.chatNote).font(.callout).foregroundStyle(.secondary).padding(.top, 8) }
                }.padding(.horizontal, 18).padding(.vertical, 16).frame(maxWidth: 860, alignment: .leading)
            }
            .frame(maxWidth: .infinity)
            .onChange(of: model.messages.last?.id) { _, id in if lastVisible, let id { proxy.scrollTo(id, anchor: .bottom) } }
            .onAppear { if let id = model.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
        }
    }
    @ViewBuilder private var catchUp: some View {
        if let summary = model.summary {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Summary by \(summary.model)", systemImage: "text.alignleft").font(.caption.weight(.semibold))
                    Text("· \(summary.messages) messages · not the agent's words").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Dismiss") { model.dismissSummary() }.controlSize(.small)
                }
                Text(summary.text.isEmpty ? "Nothing new since you last looked." : summary.text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }.padding(12).background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        } else if model.unread > 0 {
            HStack(spacing: 10) {
                Text("\(model.unread) new since you last looked").font(.caption).foregroundStyle(.secondary)
                if model.summaryModel != nil {
                    Button(model.summaryBusy ? "Summarizing…" : "Summarize what's new") { Task { await model.catchUp() } }.controlSize(.small).disabled(model.summaryBusy)
                }
                if !model.summaryError.isEmpty { Text(model.summaryError).font(.caption).foregroundStyle(.orange).lineLimit(2) }
                Spacer()
            }.padding(.vertical, 2)
        }
    }
    @ViewBuilder private func row(_ message: ChatMessage) -> some View {
        switch message.role {
        case "user":
            HStack { Spacer(minLength: 60)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(message.text).font(.system(size: 13)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 12).padding(.vertical, 8).background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                    if let ts = message.ts { Text(Self.clock.string(from: ts)).font(.system(size: 10)).foregroundStyle(.tertiary) }
                }
            }
        case "tool":
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "wrench").font(.system(size: 10)).foregroundStyle(.tertiary)
                Text(message.toolName ?? "tool").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                Text(message.text.split(separator: "\n").first.map(String.init) ?? message.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }.padding(.leading, 2)
        default:
            VStack(alignment: .leading, spacing: 3) {
                Text(message.text).font(.system(size: 13)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if let ts = message.ts { Text(Self.clock.string(from: ts)).font(.system(size: 10)).foregroundStyle(.tertiary) }
            }.padding(.trailing, 60)
        }
    }
}

/// A dialog the agent is waiting on, answered through the host's checked key presses.
struct PromptCard: View {
    @ObservedObject var model: SessionModel
    let prompt: JSON
    @State private var reply = ""
    private var options: [JSON] { prompt["options"].array }
    /// Dialogs the host cannot answer by option: multi-select, or no verified on-screen block.
    private var screenOnly: Bool { prompt["multiSelect"].bool || prompt["hash"].string.isEmpty || options.isEmpty }
    private var acceptsText: Bool { prompt["acceptsText"].bool && prompt["kind"].string != "yes-no" }
    private var canAnswer: Bool { model.role != "viewer" && model.ready && !model.answering }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised").foregroundStyle(.orange)
                Text(prompt["title"].string.isEmpty ? "The agent needs you" : prompt["title"].string).font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Open screen") { model.showScreen() }.controlSize(.small)
            }
            if !prompt["detail"].string.isEmpty {
                Text(prompt["detail"].string).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).lineLimit(8).fixedSize(horizontal: false, vertical: true)
            }
            if prompt["destructive"] != .null {
                Text("Destructive command: \(prompt["destructive"]["pattern"].string.replacingOccurrences(of: "-", with: " "))").font(.caption).foregroundStyle(.red)
            }
            if screenOnly {
                Text("Answer this dialog on the screen view.").font(.caption).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) {
                    ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                        Button(option["label"].string) { Task { await model.answer(option: option["index"].int) } }
                            .controlSize(.regular).disabled(!canAnswer)
                    }
                }
                if acceptsText {
                    HStack {
                        TextField("Reply instead…", text: $reply).textFieldStyle(.roundedBorder).disabled(!canAnswer)
                        Button("Send reply") { let text = reply; reply = ""; Task { await model.answer(text: text) } }.disabled(!canAnswer || reply.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            if model.role == "viewer" { Text("View only: this device cannot answer.").font(.caption).foregroundStyle(.secondary) }
        }.padding(12).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}
