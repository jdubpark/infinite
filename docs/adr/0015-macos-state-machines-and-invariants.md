# ADR-0015: macOS Typed State Machines and Client Invariants

- **Status**: Accepted
- **Scope**: `apps/macos/Sources/InfiniteCore/`, `apps/macos/Sources/InfiniteDesktop/`

## Context

Wave 3B eliminates remaining implicit state machines across the macOS core and desktop client where parallel booleans, optional IDs, status strings, and cleanup flags had to move in lockstep, and completes the zero-comment sweep across all `apps/macos/` sources, `Sources/InfiniteDesktop/Resources/terminal.js`, and tests (extending [ADR-0004](0004-macos-swift-concurrency-and-transport.md) and [ADR-0009](0009-wave2-lockfree-services-and-swift-actors.md)).

## Decisions

### 1. Typed state machines eliminating impossible states
- **Workspace routing and host connection (`AppModel.swift`)**:
  - `WorkspaceRoute` (`home`, `understanding`, `cost`, `mission(String)`, `team(id: String, fromMission: String?)`, `sessions`) replaces six independent booleans and optional IDs (`showingHome`, `showingCost`, `showingUnderstanding`, `selectedTeamID`, `selectedMissionID`, `teamOpenedFrom`). Navigation destinations are mutually exclusive by construction, and `fromMission` can exist only inside `.team`.
  - `HostConnectionState` (`disconnected(error:)`, `connecting(profileID:)`, `connected`, `offline(error:)`) replaces separate `connected`, `connecting`, `connectionError`, and `connectionProfileID` fields so `connected` and `connecting` cannot both be true.
- **Session stream, renderer, and control lease (`SessionModel.swift`)**:
  - `StreamState` (`detached`, `attaching(generation:)`, `attached(streamID:generation:)`) ties the stream ID and generation token strictly to the attached lifecycle.
  - `RendererState` (`awaitingSnapshot(generation:)`, `snapshotReceived(generation:)`, `ready(generation:)`, `failed(generation:)`) ensures `rendererRestored` cannot mark the renderer ready before a snapshot arrives or across generation resets.
  - `ControlState` (`unheld(otherHolder:)`, `claiming(generation:otherHolder:)`, `held(lease:generation:renewal:directInput:)`) binds the renewal task and direct-input mode strictly to an active lease, fences in-flight claims against concurrent `release()`/`detach()`, and keeps one `releaseControlState` transition canceling renewal and clearing queued raw bytes.
- **cmux workspace view-model (`CmuxState.swift`, `CmuxViewModel.swift`, `CmuxOutputBuffer.swift`)**:
  - `CmuxConnectionPhase` (`disconnected`, `connecting(generation:statusText:)`, `connected(generation:statusText:reachable:)`, `disconnecting`) keeps `hasConnected` distinct from `reachable` so polling still recovers after transient snapshot failures.
  - `CmuxAttachmentState` (`none`, `attaching`, `attached(..., input: CmuxInputMode)`, `detached`), `CmuxOperation` (`idle`, `attaching`, `sending`, `mutating`), `inputFenced`, and `draftEditingLocked` prevent `inputEnabled` or `directInput` without an active attachment and `snapshotReady`, fence input and draft mutations synchronously across `select` and `disconnect`, and preserve `selectedID` across `.detached` for manual reattachment.
  - `CmuxCreationState` (`idle`, `pending`, `clearing(previous:)`) and `creationReceiptLoaded` gate terminal creation until the persisted receipt loads, keep the pending creation banner visible while clearing is in flight, and restore the previous record if persistence fails.
  - `CmuxOutputBuffer` bounds queued events and bytes via `LockFreeInt64` counters from `InfiniteCore`, retaining queue budget until consumer delivery finishes.
- **Mission, team, halt, usage, and core connection models**:
  - `MutationState` (`idle`, `sending(pending:)`, `unconfirmed(TeamMutation)`) and `TeamModel.ReadCoverage` (`listSeedOnly`, `fullRead(latestListRow:)`) prevent unconfirmed mutations from drifting from `busy` and ensure `behind` applies only after a full team read.
  - `HaltView.State` (`readable(host:projects:)`, `unreadable`) and `HaltState.Scope` (`host`, `project(String)`) discard any host/project halt fields fail-closed when `readable` is false and forbid empty project IDs.
  - `SessionList.SyncCursor` (`unversioned`, `versioned(String)`) admits only host-validated `[A-Za-z0-9_-]` version tokens (1–128 bytes).
  - `CmuxConnection.ConnectionState` (`disconnected`, `connected(CmuxClientOwner)`) and `CmuxClientOwner.Attachment` (`detached`, `attached(CmuxOutputRelay)`) ensure FFI output callbacks cannot outlive or float free of the client handle.
  - `Mission.Status`, `MissionSubtask.Size`/`Status`, `TeamRun.Status`, top-level `AccountKind`, and `AccountView.billing` (`metered(month:)`, `subscription(planUsd:source:)`, `other`) encode wire statuses and metered-vs-subscription billing shapes in Swift while preserving `Codable` wire compatibility and `.unknown`/`.other` forward-compatibility cases.

### 2. Native SDK, Keychain, and transport invariants
- **`CmuxConnection` (`@unchecked Sendable` owner)**: `CmuxClientOwner` uses `@unchecked Sendable` only inside the `CmuxConnection` actor so its `deinit` keeps `CmuxOutputRelay` alive until `cmux_terminal_client_set_output_callback(pointer, nil, nil)` and `cmux_terminal_client_disconnect` complete on macOS 14 (which lacks isolated actor destructors). The SDK output callback runs on an SDK thread and must never synchronously call back into `CmuxConnection`.
- **`CmuxIdentityVault` enrollment guard**: `save(from:)` skips saving an empty archive so a failed first enrollment never overwrites a previously enrolled Keychain identity.
- **Halt compatibility and polling backoff**: `HaltView` treats only an explicit `"readable": false` as unreadable so older hosts omitting `readable` are not misclassified as halted. When `/halt` returns `404` or `remote-endpoint-denied`, `AppModel` backs off for 60 seconds before re-asking.
- **Session raw input framing**: `SessionModel.raw` chunks UTF-8 text on `UnicodeScalar` boundaries at most 4,000 bytes per frame to respect gateway limits without splitting multibyte scalars.
- **Sync collision and baseline rules (`SyncPlanner.swift`)**: `preview` normalizes paths with NFC (`precomposedStringWithCanonicalMapping.lowercased()`) to reject case/Unicode collisions before touching a case-insensitive macOS volume. Equal copies establish a baseline only when `apply` confirms both sides still match; preview never mutates baselines.

### 3. SwiftUI, AppKit, and xterm.js rendering invariants
- **Terminal replay safety (`TerminalSurface.swift`, `Resources/terminal.js`)**: `TerminalPipe` clears its replay buffer and disables replay rather than keeping a tail slice if buffered output exceeds 8 MiB, because a byte suffix can start mid-escape-sequence or miss earlier mode state. `TerminalSurface.Coordinator` bridges `control`, `follow`, and `render` only on state changes because SwiftUI re-invokes `updateNSView` on every poll. `terminal.js` prefers WebGL with DOM fallback and keeps server-supplied snapshot dimensions when control is unheld so full-screen TUIs do not scramble on viewport fit.
- **Keyed decision cards and model retention**: `MissionDetailView` and `TeamDetailView` key open `DecisionCard` views by host decision ID so polling drops of answered cards never shift typed drafts onto neighboring questions. `AppModel` prunes left team/mission models unless they hold an unsent `direction` or unconfirmed `pending` mutation; `SessionModel` evictions retain the model when `draft.text` or `draft.pending` is non-empty while releasing screen/chat buffers.
- **Usage formatting, palette, and validation (`Usage.swift`, `CostView.swift`, `Glass.swift`)**: Month names are formatted in UTC to match the host's `00:00 UTC` month boundaries west of Greenwich. `PlanFee.parse` accepts one comma or dot as decimal separator and rejects thousands separators rather than guessing locale grouping. `AccountPalette` assigns deterministic dark-ground colors per account name, `MoneyText` renders unmeasured/unpriced zero as `—` and partial gaps as a dotted `≥` floor, and `Glass` gates `.toolbar(removing: .title)` on macOS 15+ and `.glassEffect` on macOS 26+.
- **macOS 14 deployment target**: `apps/macos/Package.swift` remains `.macOS(.v14)` with zero `NSLock` or `NSCondition` usage.

## Consequences

- Illegal route, connection, attachment, mutation, halt, cursor, and account-billing combinations fail to compile in `apps/macos/`.
- All previously annotated files across `apps/macos/Sources/`, `apps/macos/Sources/InfiniteDesktop/Resources/terminal.js`, and `apps/macos/Tests/` carry zero prose comments under `scripts/check-comments.mjs`.
