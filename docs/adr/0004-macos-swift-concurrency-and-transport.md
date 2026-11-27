# ADR-0004: macOS Client Concurrency, Transport, and Sealed Storage

- **Status**: Accepted
- **Scope**: `apps/macos/Sources/InfiniteCore/`, `apps/macos/Sources/InfiniteDesktop/`

## Context

The native macOS client bridges a C FFI terminal SDK (`CmuxConnection`), bundled `cmux` helper subprocesses, long-lived encrypted WebSocket sessions (`RemoteClient`), and local AES-GCM sealed caches (`UnderstandingSnapshotStore`, `DraftStore`). Previously these boundaries used `NSLock`, `NSCondition`, `@unchecked Sendable`, linked outbound `Task` chains, and loose mutable optional properties.

## Decisions

### 1. Actor isolation and lock-free `AsyncStream` pipelines
- **`UnderstandingSnapshotStore`**: Converted from a class with a process-wide static `NSLock` into a `public actor` backed by a per-`(service, directory)` actor registry (`UnderstandingSnapshotStore.shared(location:)`). Separate views (`UnderstandingView`, `UnderstandingKnowledgeView`) share one actor instance and cached `SymmetricKey` off `@MainActor`. Overview and Knowledge writers merge into one versioned AES-GCM envelope (`Envelope` v1); legacy `payload` entries migrate in memory on decode and rewrite to `envelope` on the next save.
- **`CmuxOutputBuffer`**: Replaced `NSLock` with lock-free C11 `<stdatomic.h>` (`InfiniteAtomics` / `LockFreeInt64`) event, byte, overflow, and cancel counters paired with a bounded `AsyncStream<CmuxTerminalOutput>` and a single `@MainActor` consumer task with `deinit` cleanup. Queued and pending-batch events remain accounted for in `queuedEvents` and `queuedBytes` until `deliver` completes or the batch is discarded on cancel or overflow. Buffer overflow (more than 512 queued/pending events or 16 MiB buffered/pending bytes) atomically latches overflow so stale buffered frames are discarded and `[.invalidFrame]` is delivered once, prompting reattachment to a fresh server snapshot.
- **`RemoteClient`**: Encodes connection lifecycle in `ConnectionState` (`idle` | `connecting` | `open` | `closed`) and replaces linked outbound `Task` chains with a single-owner `AsyncStream<OutboundFrame>` writer loop while sealing frames sequentially on the actor. `requestCounter` lives on `RemoteClient` so request and terminal stream identifiers remain monotonic across reconnects. `URLSessionConfiguration.timeoutIntervalForResource` is set to 7 days (with a 15s request timeout) so long-lived healthy WebSockets are not closed prematurely. `notify` does not imply a delivery receipt; terminal gateways emit receipts separately.
- **`CmuxBackend` and `CmuxHelperProcess`**: Groups connection fields under `SessionState` (`disconnected` | `connecting` | `connected` | `disconnecting(Task)` | `cleanupFailed`) so overlapping `disconnect()` calls coalesce on the active teardown task, failed Keychain saves preserve retryable vault/runtime cleanup, and concurrent `connect()` calls are blocked until teardown finishes; replaces blocking `NSCondition` waits with an async `actor` driven by `AsyncStream<CmuxHelperEvent>` so cooperative Swift threads are never blocked. Helper `stdout` and `stderr` pipe handlers enforce ingress byte budgets (16 MiB stdout, 256 KiB stderr) with `LockFreeInt64` before yielding into `AsyncStream`, releasing bytes as the actor consumes events and terminating the child process while rejecting subsequent writes and queued lines if a runaway helper exceeds the cap; `readLine`, `waitForLine`, `receive`, and `write` check both latched framing/limit failures and the atomic ingress-overflow latch before returning queued lines or writing to stdin.

### 2. cmux helper security, routing, and enrollment ordering
- Native terminal byte streams use the C SDK (`CmuxConnection`), while authenticated resource and workspace RPCs use the bundled `cmux` helper over a local Unix socket / stdio JSON sharing the enrolled Noise identity.
- Enrollment invitations and JSON payloads pass over stdin (`--invite-file -`), never via process arguments or saved profiles.
- `ws`/`wss` routes with empty or `/` paths normalize to `/v1/link` so the helper and literal-path C SDK hit the same endpoint.
- `vault.save` runs immediately after `connection-snapshot` reports `"connected"` so the device secret and authenticated daemon pin persist before `terminal.connect` opens the second client. On disconnect, the vault saves before the runtime directory is erased so a Keychain failure preserves the runtime directory for retry.
- The CLI appends `client` to `--state-dir`, whereas the C ABI expects `directory/client` directly; both share the enrolled key.
- Mutation keys (`idempotency_key`) are caller-owned. `createTerminal` launches exact `argv` in `cwd` without shell interpolation and never auto-retries workspace or terminal creation. `closeTerminal` explicitly terminates a server PTY; `disconnect` and `detach` do not.
- Workspace file RPC runs in a separate persistent `rpc` helper with its own handle namespace; transport failure terminates `workspaceHelper` and invalidates handles, requiring callers to reopen their workspace.
- Helper diagnostics are strictly bounded in memory: stderr retains at most the trailing 4,096 bytes for local UI error reporting (never logged), and stdout buffers at most 256 lines / 16 MiB.

### 3. cmux desktop view-model invariants
- `setDisplayVisible` resumes polling whenever `hasConnected` is true (even if a failed catalog read cleared `connected`) so the next poll can recover.
- `rendererRestored` gates `snapshotReady` on `snapshotReceived && !streamEnded` because a newly created WebView acknowledges its initial empty replay before the server snapshot arrives.
- `retryCreation` settles only the matching `pendingCreation.id` receipt for the originating `profileID`, even if the user switched profiles mid-flight.

### 4. Local drafts and `PendingSend`
- `DraftLocation` preserves the original Keychain service and `Infinite/Drafts` Application Support path for `dev.infinite.desktop`, while rehearsal/unbundled builds isolate into per-bundle-ID suffixes.
- `DraftStore` persists only AES-GCM authenticated ciphertext, never auto-replays pending submissions on load, and refuses silent key rotation if sealed draft files exist when the Keychain key cannot be read.
- `DraftRecord.pending` pairs `id` and `text` in `PendingSend` (retaining `pendingID`/`pendingText` JSON keys) so half-present pending drafts are unrepresentable at compile time.

## Consequences

- `NSLock` and `NSCondition` are completely eliminated from `apps/macos/Sources/`.
- Illegal connection, helper session, and half-present draft states fail to compile under Swift.
