import Foundation
import InfiniteCore

extension SessionModel {
    func loadInitialDraft() async {
        guard !draftLoaded else { return }
        do {
            let loaded = try await deps.readDraft(identity)
            if draftTouched {
                let recoveredUnsent = !loaded.text.isEmpty && loaded.text != draft.text
                if recoveredUnsent {
                    draft.text = draft.text.isEmpty ? loaded.text : "\(loaded.text)\n\n\(draft.text)"
                }
                if draft.pending == nil, let pending = loaded.pending {
                    draft.pending = pending
                }
                if draft.lastQueuedText == nil, let lastQueuedText = loaded.lastQueuedText {
                    draft.lastQueuedText = lastQueuedText
                }
                draftLoaded = true
                draftVersion += 1
                if draft.pending != nil && notice.isEmpty {
                    notice = "A previous send was not confirmed. Inspect the terminal before retrying the same send or clearing it."
                } else if recoveredUnsent && notice.isEmpty {
                    notice = "Recovered your saved unsent draft alongside new text."
                }
                try? await persistDraft(waitForInitialLoad: false, flush: true)
            } else {
                draft = loaded
                draftLoaded = true
                draftVersion += 1
                if draft.pending != nil && notice.isEmpty {
                    notice = "A previous send was not confirmed. Inspect the terminal before retrying the same send or clearing it."
                }
            }
        } catch {
            notice = error.localizedDescription
        }
    }

    func setDraft(_ text: String) {
        draftTouched = true
        draft.text = text
        draftVersion += 1
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled else { return }
            try? await self.persistDraft()
        }
    }

    func persistDraft(
        throwing: Bool = false,
        expectedPendingID: String? = nil,
        waitForInitialLoad: Bool = true,
        flush: Bool = false
    ) async throws {
        if waitForInitialLoad {
            await draftLoadTask?.value
            if !draftLoaded {
                await loadInitialDraft()
            }
        }
        guard draftLoaded else {
            if throwing {
                throw DesktopError(notice.isEmpty ? "Draft is still loading. Try again." : notice)
            }
            return
        }
        while true {
            let snapshot = draft, version = draftVersion, key = identity, previous = saveInFlight
            var saveError: Error?
            var wrote = false
            var savedVersion = version
            let task = Task { @MainActor [weak self] in
                await previous?.value
                guard let self else { return }
                if !throwing && !flush && version != self.draftVersion { return }
                let currentSnapshot = (throwing || flush) ? self.draft : snapshot
                savedVersion = self.draftVersion
                if let expectedPendingID, throwing, currentSnapshot.pending?.id != expectedPendingID {
                    saveError = DesktopError("The pending send changed before saving.")
                    return
                }
                do {
                    try await self.deps.saveDraft(currentSnapshot, key)
                    wrote = true
                } catch {
                    if throwing {
                        saveError = error
                    } else if self.draftVersion == savedVersion {
                        self.notice = error.localizedDescription
                    }
                }
            }
            saveInFlight = task
            await task.value
            if let saveError { throw saveError }
            if !throwing && !flush { return }
            guard wrote else { return }
            if throwing, let expectedPendingID {
                if draft.pending?.id == expectedPendingID { return }
                throw DesktopError("The pending send changed before saving.")
            }
            if !flush || draftVersion == savedVersion { return }
        }
    }

    func send(retry: Bool = false) async {
        guard ready, !busy else { return }
        let generation = attachGeneration
        busy = true; sending = true
        defer { if generation == attachGeneration { busy = false; sending = false } }
        if !draftLoaded {
            await draftLoadTask?.value
            if !draftLoaded { await loadInitialDraft() }
            guard generation == attachGeneration, ready, draftLoaded else { return }
        }
        let retryTarget: PendingSend?
        if retry {
            guard let pending = draft.pending else { return }
            retryTarget = pending
        } else {
            guard !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.pending == nil else { return }
            retryTarget = nil
        }
        let sendToken = UUID()
        activeSendToken = sendToken
        guard await ensureControl(), generation == attachGeneration, hasControl, attached else { return }
        if retry, draft.pending != retryTarget { return }
        let leaseID = lease["id"].string, control = controlGeneration
        guard !leaseID.isEmpty else { return }
        saveTask?.cancel(); saveTask = nil
        let text = retryTarget?.text ?? draft.text
        let id = retryTarget?.id ?? UUID().uuidString.lowercased()
        let previousPending: PendingSend? = retry ? retryTarget : nil
        draftTouched = true
        if !retry {
            draft.pending = PendingSend(id: id, text: text)
            draftVersion += 1
        }
        do {
            try await persistDraft(throwing: true, expectedPendingID: id)
        } catch {
            if activeSendToken == sendToken, generation == attachGeneration, !retry, draft.pending?.id == id {
                draft.pending = previousPending
                draftVersion += 1
            }
            if generation == attachGeneration { notice = error.localizedDescription }
            return
        }
        guard generation == attachGeneration, control == controlGeneration, ready, hasControl, lease["id"].string == leaseID else {
            if activeSendToken == sendToken, generation == attachGeneration, !retry, draft.pending?.id == id {
                draft.pending = previousPending
                draftVersion += 1
                try? await persistDraft(flush: true)
            }
            if generation == attachGeneration {
                notice = "Control changed before sending input. Refresh and try again."
            }
            return
        }
        do {
            let receipt = try await deps.sendRequest(client, "/sessions/\(session.id)/input", .object(["requestId": .string(id), "text": .string(text), "submit": .bool(true)]), leaseID)
            guard generation == attachGeneration else { return }
            guard receipt["state"].string == "delivered" || receipt["receipt"]["state"].string == "delivered" else {
                throw DesktopError("Delivery is uncertain. Inspect the terminal before retrying.", code: "delivery-unknown")
            }
            if activeSendToken == sendToken, draft.pending?.id == id {
                if draft.text == text { draft.text = "" }
                draft.pending = nil
                draftVersion += 1
                try? await persistDraft(flush: true)
            }
            notice = "Delivered to the terminal."
        } catch {
            if generation == attachGeneration { notice = error.localizedDescription }
        }
    }

    func clearPending() async {
        guard draftLoaded, !sending, !clearingPending, let pending = draft.pending else { return }
        clearingPending = true
        defer { clearingPending = false }
        draftTouched = true
        let pendingID = pending.id
        let pendingText = pending.text
        let previous = saveInFlight
        let startVersion = draftVersion
        let key = identity
        var saveError: Error?
        var editedDuringSave = false
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, self.draft.pending?.id == pendingID else { return }
            var latest = self.draft
            let latestStartVersion = self.draftVersion
            if self.draftVersion == startVersion && latest.text == pendingText {
                latest.text = ""
            }
            latest.pending = nil
            do {
                try await self.deps.saveDraft(latest, key)
                guard self.draft.pending?.id == pendingID else { return }
                editedDuringSave = self.draftVersion != latestStartVersion
                if !editedDuringSave && self.draft.text == pendingText {
                    self.draft.text = ""
                }
                self.draft.pending = nil
                self.draftVersion += 1
                self.notice = "Previous send cleared after your review."
            } catch {
                saveError = error
                self.notice = error.localizedDescription
            }
        }
        saveInFlight = task
        await task.value
        if saveError == nil && editedDuringSave {
            try? await persistDraft(flush: true)
        }
    }

    func lifecycle(_ action: String, controlID: String? = nil) async throws -> JSON {
        let key = "\(identity):\(action)"
        let record = try await deps.acquireMutation(key, action)
        guard let requestID = record.pending?.id else {
            throw DesktopError("Could not record \(action) request.")
        }
        let result = try await deps.sendRequest(client, "/sessions/\(session.id)/\(action)", .object(["requestId": .string(requestID)]), controlID)
        try await deps.clearDraftIfMatching(requestID, key)
        return result
    }

    func end() async {
        guard role == "owner", !managed else { return }
        do {
            if !hasControl { await claim() }
            guard hasControl else { throw DesktopError("Take control before ending this session.") }
            _ = try await lifecycle("stop", controlID: lease["id"].string)
            notice = "End requested. Waiting for confirmed process exit."
        } catch {
            notice = error.localizedDescription
        }
    }

    func resume() async {
        guard !managed else { return }
        do {
            let response = try await lifecycle("resume")
            notice = "Resumed as \(response["id"].string.prefix(8)). Select the new session from the sidebar."
        } catch {
            notice = error.localizedDescription
        }
    }
}
