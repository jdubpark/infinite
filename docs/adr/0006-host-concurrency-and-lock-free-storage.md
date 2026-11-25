# ADR-0006: Host Lock-Free Storage, Pipeline Concurrency, and Partitioned Coordination

- **Status**: Accepted
- **Scope**: `packages/host/src/` (`team-cli.ts`, `chunk-upload.ts`, `codex-environment.ts`, `project-source.ts`, `project-sync.ts`, `desktop.ts`, `cli.ts`, `repo-enrollment.ts`)

## Context

Several host subsystems serialized unrelated work behind process-wide promise mutexes, unbounded promise chains, or shared-file directory locks (`mkdirSync(.lock)` without stale-lock recovery). This introduced crash-wedge risks, cross-project/cross-thread head-of-line blocking, memory leaks in idle map queues, and unbounded stdin buffering.

## Decisions

### 1. Lock-free per-directory CLI defaults and validation (`team-cli.ts`)
- Directory-scoped Linear defaults are stored as individual content-addressed atomic files under `<path>.d/<sha256(directory)>.json` (written via `O_EXCL` temp + `renameSync`), eliminating the shared single-file `mkdirSync(.lock)` mutex and its crash-wedge failure mode. Lookups check per-directory files first and fall back to any legacy single-file JSON map.
- Explicit `--branch` arguments are validated before source inference so invalid input raises an error rather than silently falling back to laptop mode.
- Non-git directory detection rejects any directory whose ancestor chain contains a `.git` marker, because Git reports broken or inaccessible repositories as `"not a git repository"`.
- Idempotent mutation receipts resume an earlier unconfirmed request with the same intent under its original request ID (refusing a different explicit ID), whereas intentionally repeatable actions (such as `pause` / `resume`) are never implicitly resumed.
- Permission-agent opt-out is recorded only when `--permissions off` is explicitly specified, because the host cannot distinguish an omitted flag from a repeat invocation without policy.

### 2. Lock-free pipelined chunk uploads (`chunk-upload.ts`)
- Replaced the mutex-across-disk-I/O `queue.then(...)` serializer with a bounded lock-free pipeline (`READ_WINDOW = 8` concurrent blob reads feeding a bounded batch queue consumed by `BATCHES_IN_FLIGHT` HTTP upload workers).
- Multiple batches stay in flight because remote hosts have high RTT and serial uploads are latency-bound rather than bandwidth-bound.
- Only dropped connections (`TypeError` from `fetch`) are retried because chunk PUTs are idempotent; HTTP refusals and timeouts are not retried. The first failure cancels all in-flight requests so retries never compete for uplink bandwidth.
- Uploads strictly read hashes named in the local manifest; host replies never select arbitrary local files.

### 3. Partitioned Codex environment coordination (`codex-environment.ts`)
- Replaced the connection-wide `sequence` lock and global `uncertain` latch with single-flight `register` deduplication (`Map<string, Promise<void>>`, pruned in `finally`) plus per-`threadId` serialization and uncertainty tracking, so unrelated threads never contend or poison each other.
- Lifecycle state comes exclusively from the persistent observer via `observe()`, because responses on the request connection can arrive after newer observer events.
- Environment IDs are reserved before transmission so a lost acknowledgement cannot make an ID safe to reuse for a different connection or silently repeat registration.
- Because both `turn/settings/update` and `thread/settings/update` mutate provider state, any loss after sending keeps the held result unpublished until reconciled.

### 4. Bounded per-project sync/source queues and workspace tree swap (`project-source.ts`, `project-sync.ts`)
- Per-project `serial` maps prune settled entries on completion and short-circuit aborted `AbortSignal`s before entering the queue.
- Mirror fetch ordering stamps are strictly monotonic per project (advancing by +1 ms if the host clock steps backward), even across source changes. Timer refreshes apply exponential backoff on failing fetches. Before fetching, the host records the mirror's pre-fetch head so a head moved by an interrupted fetch or host stop is never misattributed.
- `ProjectSync` checks running cloud sessions inside the project queue after `applying()` becomes true so a session launch refused by `applying()` cannot slip between the check and publish. Admission is durable before waiting in the queue and disables lease expiry.
- Filesystem errors map to fixed categories/messages without leaking raw host paths (`ENOENT` indicates a missing project only when the project directory itself is gone).
- Hard-linking files from the previously applied generation into the next generation is allowed only when both share the same laptop root and the drift reference matches every file in the applied manifest. The cloud copy of Infinite's own metadata directory always wins over laptop copies.
- Projects shared with a separate agent account (configured flag or setgid parent directory) publish group-writable files and `0o2770` directories instead of raw laptop modes.

### 5. Per-path desktop file staging and synchronous expiry (`desktop.ts`)
- File operations remain confined to configured roots while keeping host control state excluded even if a project is configured as an ancestor; local agents remain trusted filesystem peers.
- Upload handles are connection-independent and intentionally do not survive an API restart. `expire()` snapshots and removes expired idle uploads synchronously before awaiting file removal.
- At the `DesktopFiles` service boundary, `commit()` and `remove()` serialize per normalized path (`project:<project>:<path>`) and `directory()` avoids the project-wide service lock so direct callers do not contend across disjoint paths. At the HTTP route boundary in `server.ts`, `changeProjectFiles()` still tracks active per-project file mutations and rejects concurrent HTTP file mutations on the same project with `409 files-changing` to fence session starts, workspace syncs, and source refreshes. Published files explicitly apply destination group and permissions because `copyFile` can inherit staging inode group ownership.

### 6. Bounded CLI stdin drainer and per-project enrollment (`cli.ts`, `repo-enrollment.ts`)
- `cli.ts` `attach()` replaces the unbounded `inputChain` promise chain with a 64 KiB bounded FIFO buffer and fail-fast error latch so large pastes cannot grow memory without bound or send out-of-order chunks after an IPC error.
- `RepoEnrollmentService` replaces its global `mutation` mutex with per-`projectId` single-flight locks and synchronous snapshot merging around `writeSealed`, allowing git checks across unrelated projects to run concurrently while keeping `requestId` replay and first-enrollment (`first: true` only on creating requests, never re-running hooks on replay, and never treating pre-marker legacy records as first) atomic. Explicit `--permissions off` persists the permission-agent opt-out before writing the enrollment and never carries a coordinator policy.

## Consequences

- Crash-wedging directory locks, global enrollment/thread serialization bottlenecks, unbounded CLI input chains, and leaking per-project queue maps are eliminated.
- All eight modified host modules carry zero prose comments under `scripts/check-comments.mjs`.
