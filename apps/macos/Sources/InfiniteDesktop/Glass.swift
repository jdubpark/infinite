import SwiftUI
import AppKit
import InfiniteCore

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

enum Palette {
    private static func hex(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
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
    init(teamSeed: TeamSeed, size: CGFloat = 14) {
        self.size = size
        switch teamSeed.typedStatus {
        case .unknown(let raw) where raw.isEmpty: kind = .todo
        case .cancelled: kind = .cancelled
        case .noChange: kind = .stopped
        case .merged: kind = .done
        case .paused: kind = .paused
        case .blocked: kind = .blocked
        case .needsInput: kind = .attention
        case .readyForReview: kind = .review
        case .planning, .discovering, .implementing, .integrating, .verifying, .reviewing, .delivering, .unknown:
            kind = .progress(0.25)
        }
    }
    init(teamLoadState: TeamLoadState, size: CGFloat = 14) {
        switch teamLoadState {
        case .loading(let seed, _): self.init(teamSeed: seed, size: size)
        case .listSeed(let run), .loaded(let run, _): self.init(team: run, size: size)
        }
    }
    init(item: BoardItem, size: CGFloat = 14) { self.init(Self.board(item.column, item.status, item.progressFraction), size: size) }
    init(missionSeed: MissionSeed, size: CGFloat = 14) {
        if missionSeed.status.isEmpty {
            self.init(.todo, size: size)
        } else {
            self.init(Self.board(missionSeed.column, missionSeed.status, missionSeed.progressFraction), size: size)
        }
    }
    init(missionLoadState: MissionLoadState, size: CGFloat = 14) {
        switch missionLoadState {
        case .loading(let seed, _): self.init(missionSeed: seed, size: size)
        case .loaded(let mission): self.init(mission: mission, size: size)
        }
    }
    init(mission: Mission, size: CGFloat = 14) {
        let (done, total) = mission.progress
        self.init(Self.board(mission.column, mission.status, total > 0 ? max(0.25, Double(done) / Double(total)) : 0.25), size: size)
    }
    private static func board(_ column: BoardColumn, _ status: String, _ fraction: Double) -> Kind {
        switch column {
        case .needsInput: return status == "blocked" ? .blocked : .attention
        case .working: return status == "paused" ? .paused : .progress(fraction)
        case .review: return .review
        case .ended: return ["merged", "achieved"].contains(status) ? .done : status == "cancelled" ? .cancelled : .stopped
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
