import Foundation

/// Delays stale display warnings while keeping request and control state immediate.
@MainActor final class DisplayFreshness {
    private var stale = false
    private var task: Task<Void, Never>?
    var onChange: (Bool) -> Void

    init(onChange: @escaping (Bool) -> Void) { self.onChange = onChange }

    func failed() {
        guard !stale else { return }
        stale = true
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self, !Task.isCancelled, self.stale else { return }
            self.task = nil
            self.onChange(true)
        }
    }

    func recovered() {
        stale = false
        task?.cancel()
        task = nil
        onChange(false)
    }
}
