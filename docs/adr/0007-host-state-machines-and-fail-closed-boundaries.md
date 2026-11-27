# ADR-0007: Host State Machines, Fail-Closed Halts, Eval Isolation, and Transport Boundaries

- **Status**: Accepted
- **Scope**: `packages/host/src/` (`halt/`, `hybrid-workspace.ts`, `executor-tunnel.ts`, `eval-*.ts`, `permission-session-requests.ts`, `slack-client.ts`)

## Context

Core host control planes previously represented mutually exclusive lifecycle phases as parallel optional properties and boolean flags (such as `HaltEntry.scope` + optional `projectId`, `HaltService`'s `(record, readable)` pair, `hybrid-workspace.ts`'s 17 mutable flags, `EvalTaskRow`'s untyped payload union, `Tracked`'s `phase`/`inFlight`/`retryAt`, and `SlackClient.connect`'s 6 socket variables). Encoding these as compile-time discriminated unions eliminates non-null assertions, unsafe payload casts, and illegal phase combinations.

## Decisions

### 1. Owner halt gate, epochs, and fail-closed persistence (`halt/`)
- **Typed invariants**: `HaltEntry` and `LaunchHalted` discriminate on `scope` (`"host"` forbids `projectId`; `"project"` requires `projectId` and forbids `unreadable`). `HaltView`, `RecordState`, and `EpochsState` discriminate on `"readable"` vs `"unreadable"`, preventing stale records from leaking when storage is unreadable.
- **Sealed-file authority and fail-closed reads**: Every halt change writes `halt.sealed` first, then updates memory. `ENOENT` means no halt; any other read, authentication, or schema error treats the entire host as halted (`unreadable`) without throwing.
- **Precedence over FuseGate**: Launch gates check halt before fuse. A halted launch never reaches the fuse (not counted, charged, or recorded as a trip), and no role is exempt.
- **Pause/resume ordering and reason preservation**: Halt stops services in order (`routines` → `goals` → `missions` → `teams`) and release resumes them in reverse. Running and `needs-input` team runs are paused; idle waiting runs stay held so open questions and incoming answers remain attached. Exact halt-reason matching ensures release never clears a pause reason written by another subsystem.
- **Separate halt epochs (`halt-epochs.sealed`)**: Stored separately so restoring or deleting `halt.sealed` cannot revert epochs. Every scope-changing engage or release writes a new epoch before updating `halt.sealed`, invalidating earlier permission-agent decisions. Unreadable epochs leave the permission agent unready; a missing epochs file mints a fresh host epoch rather than reusing an old one.

### 2. Hybrid workspace preparation and executor tunnel boundaries (`hybrid-workspace.ts`, `executor-tunnel.ts`)
- `createHybridWorkspace` encodes lifecycle in `WorkspacePhase` (`laptop` | `selecting` | `cloud` | `failed` | `closed`). A restarted coordinator has not re-admitted an earlier prepared tree or writer boundary, so it reuses verified content only and never trusts an old mutable path. Inactive preparation generations stay private until handoff selection exposes only the chosen tree after host writes finish.
- `createExecutorTunnel` and `forwardExecutor` encode connection state in `DevicePhase` and `ForwardPhase`. Both directions share a single total buffer budget so multiplexing does not multiply memory limits by provider count. Reconnecting an idle relay reopens transport only and never replays unresolved operations.

### 3. Eval task state machine and grader isolation (`eval-types.ts`, `eval-trial.ts`, `eval-store.ts`, `eval-validate.ts`)
- `EvalTaskRow` couples `origin` (`"captured"` | `"mined"`) and `state` (`"captured"` | `"candidate"` | `"valid"` | `"rejected"` | `"retired"`) with `payload` (`CapturedPayload` | `MinedPayload` | `RejectedPayload`), eliminating unsafe casts.
- **Grader sandbox isolation**: The grader builds both commit graphs; the eval account holds only the base commit. Grading rebuilds the task from the bundle after clean, and the host reads runner reports exclusively through the grader's read path without opening files under the grader's root.
- **Report-only resolution and secret patches**: Only parsed runner reports resolve trials (exit codes never do; missing reports leave grade unknown). Three runner reports are required to mark a task valid. Patches matching secret shapes are still graded, with stored patch bytes withheld.
- **Retention and concurrent updates**: Deleting a run retains its `eval_tasks` only when its final status is `merged` or `no-change` (other statuses indicate lost trailing events). Validation re-reads sealed `eval_tasks.payload` at commit time so concurrent approval updates (`laterFiles`) are preserved. `Decide` in `eval-store.ts` stays structurally aligned with `PromotionFacts` in `eval-rules.ts`.

### 4. Interactive session permission requests and Slack Socket Mode (`permission-session-requests.ts`, `slack-client.ts`)
- `SessionPermissionRequests` encodes per-prompt tracking in a discriminated `Tracked` union (`building` | `handed` | `owner`, with `retryAt` valid only in `owner`). It applies solely to owner-started host sessions; team members, mission coordinators, and laptop-executed sessions never enter this path, and requests stay with the owner when no delivery service serves them.
- `SlackClient.connect` encodes socket lifecycle in `SocketPhase` (`idle` | `opening` | `handshaking` | `connected` | `backoff` | `closed`). Socket Mode envelopes with an ID are acknowledged only after the handler resolves. Socket URLs allow `wss://` on Slack hosts, or loopback `ws://` strictly when the configured API endpoint itself is a loopback override.

## Consequences

- `entry.projectId!` non-null assertions in `halt/service.ts` and unsafe `as CapturedPayload | MinedPayload` casts in `eval-trial.ts` are removed.
- All 11 refactored host files carry zero prose comments under `scripts/check-comments.mjs`.
