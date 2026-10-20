import SwiftUI
import AppKit
import InfiniteCore

/// Liquid Glass for controls that act on the whole window: the start box, composers, status chips, and
/// the connection footer. Content (rows, records, terminals) stays flat beneath them. Before macOS 26 the
/// same shape gets a thin material and a light rim.
extension View {
    @ViewBuilder func glassSurface<S: Shape>(in shape: S, tint: Color? = nil) -> some View {
        if #available(macOS 26.0, *) {
            glassEffect(liquidGlass(tint: tint), in: shape)
        } else {
            background(tint.map { AnyShapeStyle($0.opacity(0.18)) } ?? AnyShapeStyle(.ultraThinMaterial), in: shape)
                .overlay(shape.stroke(Color.primary.opacity(0.10)))
        }
    }
    @ViewBuilder func glassButton(prominent: Bool = false) -> some View {
        if #available(macOS 26.0, *) {
            if prominent { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
        } else {
            if prominent { buttonStyle(.borderedProminent) } else { buttonStyle(.bordered) }
        }
    }
    /// The window title repeats what the sidebar already selects, so it is hidden where macOS allows,
    /// and the window and toolbar share the page's dark ground.
    @ViewBuilder func quietWindow() -> some View {
        if #available(macOS 15.0, *) {
            toolbar(removing: .title).toolbarBackground(Palette.background, for: .windowToolbar).containerBackground(Palette.background, for: .window)
        } else { toolbarBackground(Palette.background, for: .windowToolbar) }
    }
}

@available(macOS 26.0, *)
private func liquidGlass(tint: Color?) -> Glass {
    tint.map { Glass.regular.tint($0.opacity(0.35)) } ?? .regular
}

/// The app's palette, after the ayu dark theme: near-black grounds, warm text, and one amber accent.
/// The app is always dark; the colors carry state, so each one stays beside words.
enum Palette {
    private static func hex(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
    /// The page ground, the sidebar beside it, and a raised surface for inset panels.
    static let background = hex(0x0D1017)
    static let sidebar = hex(0x0B0E14)
    static let surface = hex(0x131721)
    static let line = hex(0x1B1F29)
    static let accent = hex(0xE6B450)
    static let running = hex(0xE6B450)
    static let review = hex(0x95E6CB)
    static let done = hex(0xAAD94C)
    static let connected = hex(0xAAD94C)
    static let attention = hex(0xFF8F40)
    static let paused = hex(0xD2A6FF)
    static let error = hex(0xF07178)
    static let muted = hex(0x565B66)
}

/// Linear-style work states: a ring that fills by quarters while work runs, a check ring for review, a
/// filled check for done, and filled marks for attention, stuck, and cancelled. Words beside the
/// glyph carry the meaning; a full ring is not completion.
struct StatusGlyph: View {
    enum Kind: Equatable { case todo, progress(Double), review, done, attention, paused, blocked, cancelled, stopped, error }
    let kind: Kind
    var size: CGFloat = 14
    init(_ kind: Kind, size: CGFloat = 14) { self.kind = kind; self.size = size }
    init(team: TeamRun, size: CGFloat = 14) {
        self.size = size
        switch team.projectState {
        case .ongoing: kind = .progress(team.progressFraction)
        case .pending: kind = team.status == "ready-for-review" ? .review : .attention
        case .stuck: kind = .blocked
        case .paused: kind = .paused
        case .complete: kind = .done
        case .cancelled: kind = .cancelled
        case .aborted: kind = .stopped
        }
    }
    init(session: AgentSession, size: CGFloat = 14) {
        self.size = size
        if session.recordingError { kind = .error }
        else if session.needsYou { kind = .attention }
        else if !session.running { kind = .stopped }
        else { kind = session.attention == "turn-finished" ? .review : session.attention == "idle" ? .todo : .progress(0.5) }
    }
    private var color: Color {
        switch kind {
        case .progress: return Palette.running
        case .review: return Palette.review
        case .done: return Palette.done
        case .attention: return Palette.attention
        case .paused: return Palette.paused
        case .blocked, .error: return Palette.error
        case .todo, .cancelled, .stopped: return Palette.muted
        }
    }
    private var filled: Bool { [.done, .attention, .blocked, .cancelled].contains(kind) }
    var body: some View {
        let line = max(1.5, size / 9)
        ZStack {
            if filled { Circle().fill(color) } else { Circle().strokeBorder(color, lineWidth: line) }
            switch kind {
            case .progress(let fraction):
                // Quarter steps, clockwise from twelve; any started work shows one quarter.
                let quarters = fraction <= 0 ? 0 : min(4, max(1, Int((fraction * 4).rounded())))
                Pie(fraction: Double(quarters) / 4).fill(color).padding(line * 2)
            case .done, .review: mark("checkmark", filled ? .white : color, 0.5)
            case .attention: mark("questionmark", .white, 0.48)
            case .blocked: mark("exclamationmark", .white, 0.48)
            case .error: mark("exclamationmark", color, 0.48)
            case .cancelled: mark("xmark", .white, 0.42)
            case .paused: mark("pause.fill", color, 0.42)
            case .stopped: RoundedRectangle(cornerRadius: 1.5).fill(color).frame(width: size * 0.32, height: size * 0.32)
            case .todo: EmptyView()
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
    private func mark(_ symbol: String, _ tint: Color, _ scale: CGFloat) -> some View {
        Image(systemName: symbol).font(.system(size: size * scale, weight: .heavy)).foregroundStyle(tint)
    }
}

private struct Pie: Shape {
    let fraction: Double
    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard fraction > 0 else { return path }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: center)
        path.addArc(center: center, radius: min(rect.width, rect.height) / 2, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * min(1, fraction)), clockwise: false)
        path.closeSubpath()
        return path
    }
}

private let plainISO: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
/// A compact age such as "now", "12m", "3h", or "5d", measured from an ISO time the host reported.
func shortAge(_ iso: String, now: Date = Date()) -> String {
    guard let date = ISO8601DateFormatter.flexible.date(from: iso) ?? plainISO.date(from: iso) else { return "" }
    return shortAge(date, now: now)
}
func shortAge(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 60 { return "now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
    if seconds < 86_400 * 60 { return "\(Int(seconds / 86_400))d" }
    return "\(Int(seconds / (86_400 * 30)))mo"
}
