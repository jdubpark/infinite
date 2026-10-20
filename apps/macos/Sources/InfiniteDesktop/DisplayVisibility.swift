import AppKit
import SwiftUI

/// Whether the desktop client has a window a person can currently see.
struct DisplayVisibility: Equatable {
    let appHidden: Bool
    let systemSleeping: Bool
    let visibleWindowCount: Int

    var isVisible: Bool { !appHidden && !systemSleeping && visibleWindowCount > 0 }
}

@MainActor final class DisplayVisibilityMonitor: ObservableObject {
    @Published private(set) var state = DisplayVisibility(appHidden: true, systemSleeping: false, visibleWindowCount: 0)

    private let observations = DisplayVisibilityObservations()
    private var systemSleeping = false
    private var displaysSleeping = false

    init() {
        let appNotifications = NotificationCenter.default
        for name in [NSApplication.didHideNotification, NSApplication.didUnhideNotification,
                     NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                     NSApplication.didChangeOcclusionStateNotification,
                     NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                     NSWindow.didDeminiaturizeNotification, NSWindow.didBecomeKeyNotification,
                     NSWindow.didResignKeyNotification, NSWindow.willCloseNotification] {
            observe(name, in: appNotifications)
        }

        let workspaceNotifications = NSWorkspace.shared.notificationCenter
        observe(NSWorkspace.willSleepNotification, in: workspaceNotifications, systemSleeping: true)
        observe(NSWorkspace.didWakeNotification, in: workspaceNotifications, systemSleeping: false)
        observe(NSWorkspace.screensDidSleepNotification, in: workspaceNotifications, displaysSleeping: true)
        observe(NSWorkspace.screensDidWakeNotification, in: workspaceNotifications, displaysSleeping: false)
        refresh()
    }

    func refresh() {
        let visibleWindows = NSApplication.shared.windows.filter {
            $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible)
        }.count
        let next = DisplayVisibility(appHidden: NSApplication.shared.isHidden,
                                     systemSleeping: systemSleeping || displaysSleeping,
                                     visibleWindowCount: visibleWindows)
        if next != state { state = next }
    }

    private func observe(_ name: Notification.Name, in center: NotificationCenter,
                         systemSleeping: Bool? = nil, displaysSleeping: Bool? = nil) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let systemSleeping { self.systemSleeping = systemSleeping }
                if let displaysSleeping { self.displaysSleeping = displaysSleeping }
                self.refresh()
            }
        }
        observations.append(token, center: center)
    }
}

private final class DisplayVisibilityObservations {
    private var values: [(NotificationCenter, NSObjectProtocol)] = []

    func append(_ token: NSObjectProtocol, center: NotificationCenter) {
        values.append((center, token))
    }

    deinit {
        for (center, token) in values { center.removeObserver(token) }
    }
}
