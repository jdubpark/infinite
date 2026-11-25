# ADR-0009: Wave 2 Lock-Free Services, Partitioned Queues, Bounded Execution, and Swift Actors

- **Status**: Accepted
- **Scope**: `packages/host/src/` (`manager.ts`, `understanding-work-narrative.ts`, `workspace-trust.ts`, `terminal-stream.ts`, `halt/service.ts`), `apps/macos/Sources/` (`Drafts.swift`, `FileTransfer.swift`, `AppModel.swift`, `AppModelDependencies.swift`, `CmuxViewModel.swift`, `FilesView.swift`)

## Context

Wave 2B targeted remaining process-wide serial chains, blocking thread waits, unbounded queues, and `@MainActor`-blocking I/O across the host and macOS desktop client:

1. `Manager` serialized every session creation, resumption, archival, deletion, control lease, retirement, and permission expansion behind a single global `serial` promise chain.
2. `WorkNarrativeStore` serialized all workspaces behind one `chain` promise and leaked `state.jobs` daily quota whenever `close()` or `gate()` aborted a queued job before execution.
3. `workspace-trust.ts` waited on Claude Code's `<file>.lock` with synchronous `Atomics.wait` (blocking the V8 event loop when called in-process from `worker.ts`) and cleared stale locks via check-then-`rmdirSync`, risking a TOCTOU unlink of a newly acquired lock.
4. `terminal-stream.ts` chained `ws.on("pong")` lease renewal onto the terminal input `serial` promise chain and queued incoming messages onto an unbounded promise chain that could not discard queued frames on close or abort.
5. `DraftStore` was a non-`Sendable` class doing synchronous Keychain, AES-GCM, and file I/O on `@MainActor`, and `FileTransfer` / `LocalFiles` ran blocking `NSFileCoordinator` and disk I/O without hopping off `@MainActor`.

## Decisions

### 1. Partitioned `Manager` queues and capacity reservation (`manager.ts`)
- Replaced the global `serial` chain with per-`sessionId` queues (`sessionQueues: Map<string, Promise<unknown>>`, pruned on settle via `serializeSession(id, fn)`). Unrelated sessions' `setArchived`, `remove`, `retireTeamRuntime`, `controlSession`, and `expandTeamPermission` calls never block one another or wait behind session creation.
- Added per-native-conversation serialization (`conversationQueues: Map<string, Promise<unknown>>`, pruned on settle via `serializeConversation(`${provider}:${nativeId}`, task)`) inside `resumeOnce` around the `meta.sealed` check, continuation scan, `createOnce`, and `remember(...)`, preserving a strictly acyclic lock order (`sessionQueues (sorted first < second) -> conversationQueues -> createAdmission`) so concurrent `resume()` calls targeting distinct stopped recordings of the same native conversation converge onto a single live session.
- Preserved `maxSessions` enforcement and `requestId` idempotency across concurrent `create`, `createTeamSession`, and `resume` calls using per-`requestId` serialization plus `pendingCreates` (`Set<string>`) reserved atomically under a short `createAdmission` check before worker spawn polling begins. `handoffProjects` continues to reject overlapping non-team creations synchronously before sealing `meta.sealed`.
- Retained non-obvious host invariants:
  - Older workers survive API upgrades and report `state` without `attention`; `withDefaultAttention` supplies an `unavailable` or lifecycle-preserved block without inventing idle or finished states.
  - `state()` stamps `unavailable` / `savedState` with `now` for live stall detection, whereas `listedState()` reads `savedStatus` timestamps (`savedAt` / `createdAt`) so unchanged listing rows stay deterministic across reads and restarts.
  - At-most-once team permission expansion seals an `"uncertain"` receipt before sending keys (`Ctrl+A`); named worker refusals that precede key delivery roll back the ledger entry, while lost acknowledgements preserve `"uncertain"` without replay.
  - `answerTeamPermission`, `answerSessionPermission`, and `answerAgentPermission` re-check the live delegation fence under the held worker control lease and return `"uncertain"` on transport errors without a worker code.
  - Code Mode recording stays consistent across resumptions (`recordedCodeMode`) so learning runs and earlier hosts keep stable identities and fingerprints.

### 2. Bounded narrative worker pool and quota refund (`understanding-work-narrative.ts`)
- Replaced `this.chain` with a bounded queue (`MAX_CONCURRENCY = 2` across workspaces, at most one active job per `workspaceId`, and `jobKey` deduplication).
- `refresh()` records the UTC day of the charged quota slot; queued jobs canceled by `close()`, replaced in the queue, or refused by `gate()` / `this.closed` before invoking `adapter.explainWork` refund `state.jobs` (when `state.day` still matches) and persist the updated store.
- Unreadable sealed narrative envelopes fail closed and are never served as authenticated state.

### 3. Non-blocking Claude trust locking and TOCTOU-safe stale lock recovery (`workspace-trust.ts`, `worker.ts`)
- Added `withClaudeConfigLockAsync` and `recordClaudeTrustAsync` using `node:timers/promises` `setTimeout` backoff so async in-process callers (`worker.ts`) never block the V8 event loop. The synchronous `recordClaudeTrust` entrypoint remains for the standalone CLI wrapper invoked through release symlinks.
- Hardened stale-lock recovery (`tryBreakStaleLock`): checks `mtimeMs` against `LOCK_STALE_MS` (10 seconds, matching `proper-lockfile`) and removes the empty stale directory directly via `rmdirSync(lock)`, letting `ENOENT` retry while `ENOTEMPTY`/`EEXIST` and other errors fail closed immediately without unlinking contents.
- Retained Codex workspace trust invariants: member clones record exact folders rather than team roots, `.codex` directories up to the `.git` project root marker fail closed before launch, and `codexTrustArgs` pins `project_root_markers=[".git"]` with JSON-quoted TOML paths.

### 4. Decoupled terminal heartbeat lease renewal and bounded FIFO drainer (`terminal-stream.ts`)
- Decoupled `ws.on("pong")` lease renewal from incoming message processing using an independent single-flight `renewInFlight` promise so slow `input` IPC cannot stall lease renewal.
- Replaced the unbounded `serial` promise chain with a bounded FIFO array drainer (`MAX_PENDING_BYTES = 256 * 1024`, `MAX_PENDING_FRAMES = 128`) that immediately discards queued frames on close or abort (`open = false`, `abort.abort()`) and waits only for in-flight single-frame / renewal promises before releasing the control lease.
- Preserved `terminalPages` watch-before-snapshot ordering, lossless recording fallback without cursor guessing, and `force: true` input delivery on the visible terminal surface.

### 5. `HaltService` single-file `halt.sealed` atomic settlement (`halt/service.ts`, `halt/record.ts`)
- `HaltService` intentionally retains its single-file (`halt.sealed`) serialized `this.serial` barrier for rare owner `engage` and `release` transitions rather than introducing timeouts or a two-file WAL. That preserves strict v1 durability (`<= MAX_RECEIPTS = 100` in one sealed file), atomic settlement semantics, and the sequential ordering guarantee documented in `docs/teams.md#halt`.
- Hot-path gate reads (`check`, `gate`, `view`, `epoch`) remain lock-free synchronous memory reads, and per-team concurrency (`KeyedQueue` + `PendingCreates` from PR #294) prevents slow team creations from blocking `teams.haltPause`.
- Halt harness test runs (`tests/halt.test.ts`) place `Manager` `runDir` directories directly under `/tmp/halt-run-*` because Unix domain socket `sun_path` lengths require short socket paths.

### 6. Actor-isolated `DraftStore`, generation-fenced `AppModel` drafts, and off-MainActor `FileTransfer` (`Drafts.swift`, `AppModel.swift`, `AppModelDependencies.swift`, `FileTransfer.swift`)
- Converted `DraftStore` from a non-`Sendable` class to `public actor DraftStore` with a shared per-`(service, directory)` actor registry (`DraftStore.shared(location:)`), matching `UnderstandingSnapshotStore`, and added `clearIfMatching(requestID:identity:)` so stale completion or confirmation handlers never erase a newer replacement draft on disk. Updated `AppModel`, `SessionModel`, `CmuxViewModel`, and `SyncSafetyTests` to `await` draft reads and saves off `@MainActor`, guarding `SessionModel`'s initial async load against clobbering edits made before load completion.
- Updated `AppModel` to track `connectedProfileID` and `connectingClient` alongside `client` and fence draft I/O per `(profileID, kind)` via `DraftKeyQueue`: mutating `activeID` synchronously clears `connecting`, `connected`, and `connectedProfileID` and immediately closes any in-flight `connectingClient`, and `AppModel.connect()` immediately closes any superseded `connectingClient`, clears `pendingCreation`, `pendingTeamCreation`, and `pendingMissionCreation` (and `client = nil`, `connectedProfileID = nil`), reads `/me` and all three drafts into locals via `readProfileDrafts()` (serialized per `(profileID, kind)` via `DraftKeyQueue` and re-reading if `draftEpochs` advances) while rechecking `connectionGeneration == generation && activeID == profile.id` (clearing `connecting = false` and closing stale `RemoteClient` instances on mismatch), and publishes `client`, `connectedProfileID`, `me`, drafts, and `connected = true` atomically only after all checks pass. Fenced `submitPendingCreate` with `connected`, `connectedProfileID == activeID`, `connectionGeneration`, `activeID`, `DraftKeyQueue`, and `clearIfMatching`, and required a non-nil `targetID` (plus confirmation-captured profile/request IDs in the SwiftUI views) in `clearPendingDraft` so missing or mismatched clear requests are strict no-ops.
- Moved blocking `NSFileCoordinator` coordination (`LocalFiles.installAsync` on `DispatchQueue.global(qos: .userInitiated)`) and disk I/O in `FileTransfer.upload`, `FileTransfer.download`, and `FilesView` (`refreshLocal`, `previewSync`) off `@MainActor` while retaining `LocalFiles`'s canonical root checks, ancestor `lstat` / `openat` symlink defenses, and `RENAME_SWAP` recovery invariants.

## Consequences

- Cross-session manager mutations, multi-workspace work narratives, terminal `pong` lease renewals, and macOS UI interactions no longer suffer head-of-line blocking or event-loop / `@MainActor` freezes from unrelated or slow operations, while `HaltService` retains single-file atomic settlement.
- All refactored files (`manager.ts`, `understanding-work-narrative.ts`, `workspace-trust.ts`, `terminal-stream.ts`, `halt/service.ts`, `Drafts.swift`, `FileTransfer.swift`, `tests/halt.test.ts`) carry zero prose comments under `scripts/check-comments.mjs`.
