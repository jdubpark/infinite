# ADR-0016: Per-Entity Orchestration Queues and Orchestration Service Invariants

- **Status**: Accepted
- **Scope**: `packages/host/src/` (`keyed-queue.ts`, `goals.ts`, `routines.ts`, `missions.ts`, `teams.ts`, `team-kernel.ts`, `team-permission-agent.ts`, `team-permission-review.ts`, `team-publisher.ts`, `team-recovery.ts`, `team-register.ts`, `team-retention.ts`, `team-review-feedback.ts`)

## Context

`GoalService`, `RoutineService`, `MissionService`, and `TeamService` previously serialized every mutation and scheduler tick behind a single service-wide `serial: Promise<unknown>` chain. A slow workspace operation, `gh` read, or session launch on one entity blocked unrelated entities from progressing, responding to owner actions (`pause`, `resume`, `cancel`, `steer`, `answer`), or settling during halts and shutdown.

## Decisions

### 1. Shared `KeyedQueue` and Bounded Fan-Out (`keyed-queue.ts`)
- `KeyedQueue` maintains per-key FIFO promise chains in `Map<string, Promise<unknown>>`. Each queued task chains onto the settled `done` tail (`next.then(() => undefined, () => undefined)`), so sync throws and async rejections propagate to the caller without poisoning subsequent tasks on the same key.
- Tail entries auto-evict via `if (this.queues.get(key) === done) this.queues.delete(key)` so idle maps never leak memory.
- `settle()` awaits a single snapshot of currently queued tails (`idle()`), while `drain()` loops `while (this.queues.size > 0)` over `Promise.allSettled` so `close()` waits for all in-flight operations and abort-triggered cleanup tasks without producing unhandled rejections.
- Each service tracks in-flight `tick()` sweeps in an `activeTicks` promise set rather than enqueueing an async outer tick wrapper in `KeyedQueue`, so synchronous `start()`/`tick()` fan-out chains onto per-entity queues immediately on invocation while `idle()` and `close()` still wait for active sweeps (including `TeamService`'s pre-step `manager.list()` inventory) before settling/draining `KeyedQueue`.
- `mapConcurrent(items, concurrency, fn)` bounds fan-out across independent entity keys during scheduler ticks so large entity sets do not spawn unbounded concurrent subprocesses or session launches.
- `PendingCreates` tracks each in-flight `create()` / `createRun()` entry independently in a `Set` (so colliding `requestId`s across projects never overwrite an earlier entry's project scope) and cleans up its entry on settlement. Each service's `haltPause(mark, covers)` registers itself synchronously in `activeTicks` (so `close()` and `idle()` wait for in-flight halt passes) and runs `pauseWithPendingCreates(...)`: it snapshots existing `records` and enqueues pauses for them immediately without waiting for `pendingCreates`, while concurrently draining matching `pendingCreates` and pausing any newly inserted records until `pendingCreates` settles. Because `create` callbacks never acquire `HaltService` or `haltPause`, and `haltPause` holds no service queue while draining `pendingCreates`, no deadlock is possible. `MissionService.pendingProjectIds()` mirrors `create()`'s per-repository checkout selection so partial `request.checkouts` overrides still cover default checkouts of remaining repositories.

### 2. Per-Goal Queues and Cross-Service Ordering (`goals.ts`)
- `GoalService` partitions mutations by `goalId` (`create()` keys on `request.requestId`; `answer(teamId, ...)` resolves `goalId` via `teams.goalIdOf(teamId)` before entering the goal's queue).
- `haltPause()`, `haltResume()`, and `start()` ticks snapshot keys and fan out across independent per-goal queues (`mapConcurrent(..., 8)` on ticks). `close()` sets `closed = true`, clears the timer, awaits `activeTicks`, and returns `this.queues.drain()`.
- Lock ordering is strictly `goalId -> teamId`: `GoalService` calls into `TeamService` while holding `goalId`, and `TeamService` never acquires `GoalService` queues (it accesses `goalRecordPort` synchronously with optimistic version checks).
- Retained domain invariants migrated from inline comments:
  - Creation criteria join the request payload fingerprint only when supplied so goals without criteria keep their original fingerprint and size.
  - Scheduled approvals (`admit?.()`) validate immediately inside the `create()` transaction before admitting a goal; replays return the existing record first.
  - Standing goals keep only the active cycle, the latest reviewed parent cycle, and `keptCycles` recent cycles, folding older cycles into totals with snapshot usage fallback so usage read errors never fail a launch.
  - Standing cycle boundaries evaluate autonomy mode, lineup, failure count, cadence or settled wake, Linear tracking, and fuse before renewing cycle allowances; retryable creation failures with no created run withdraw the launch, return the wake, and retry after a cooldown.
  - Signal inbox reads (`readWake`) return `"current"`, `"behind"`, or `"unknown"`; early wakes require `"current"` after the minimum gap so multi-page signal batches start at most one cycle.
  - Pre-`blockedAt` records fall back to `updatedAt` for stale-blocked retention expiry, never closing early.

### 3. Per-Routine Queues and Capacity Admission (`routines.ts`)
- `RoutineService` partitions per-routine mutations on `routine:${id}`, serializes `create()` under `"admission"` in the same `KeyedQueue` so the `maxRecords` (1000) capacity cap and idempotent `requestId` replay remain atomic without blocking routine ticks or actions, and serializes project-busy checks plus launch/replay per project on `project:${projectId}`.
- `tick()`, `haltPause()`, and `haltResume()` fan out across per-routine queues (`mapConcurrent(..., 8)` on `tick()`). Strict lock ordering is `routine:${id} -> project:${projectId} -> goalId` (`startGoal` calls `GoalService.create`). When concurrent due routines contend on the same project and receive `routine-project-busy` or `routine-starting`, `replayLaunch()` clears `stored.launch`, preserves `pendingWake` (marking `wakeDeferred = true` if woken), and reschedules as `"scheduled"` to `nextRunAt` instead of blocking; `pendingWake` is cleared only upon `recordLaunchReceipt`. `close()` awaits `activeTicks` and drains all queues including `"admission"`.
- Retained domain invariants migrated from inline comments:
  - Routine authority digests strip `outcomes`, `memberTraces`, `eval`, and `mainCheck` because measurement and trace settings never alter approved work.
  - Startup resets `launch.attempted = false` on persisted launches so uncertain GoalService calls replay idempotently.
  - Busy project refusals defer pending wakes (`wakeDeferred`) to the next scheduled interval; fuse waits coalesce missed intervals into a single start once closed.

### 4. Per-Mission Queues and Synchronous Subtask Scheduling (`missions.ts`)
- `MissionService` partitions all mutations, `create()` (`request.requestId`), `haltPause()`, `haltResume()`, and `tick()` (`mapConcurrent(..., 8)`) by `missionId`. `idle()` calls `this.queues.settle()` and `close()` returns `this.queues.drain()`.
- `schedule(stored)` remains strictly synchronous (zero `await`s) and writes `stored.launches[subtaskId]` before `launchSubteams(stored)` awaits `teams.createForMission(...)`, preserving cross-mission repository exclusivity alongside `TeamService` reservation checks.
- Retained domain invariants migrated from inline comments:
  - Intake missions pause their deadline clock (`clockStoppedAt`) while `paused` or `needs-input` and restore the stopped span on resume.
  - Connector receipts bind identity to `{ kind, id }` rather than mutable display names; owner/Slack actions preserve pre-connector digest shapes.
  - Coordinator attempts rotate on idle duration, main-conversation token size, or attempt age; once rotated, older conversations are never resumed.
  - Consumed inbox/note messages settle only on an applied report and are returned to the front of queues if the mission pauses or ends non-live before consuming them.
  - `haltSettlements` retain displaced halt-resume tokens until `applySettlements` confirms each subteam decided against its token.

### 5. Per-Run Queues, Creation Admission, and Reentrancy Prevention (`teams.ts`, `team-*.ts`)
- `TeamService` partitions all run operations and `team-*.ts` kernel/host callbacks (`TeamRetention`, `TeamPublisher`, `TeamRecovery`, `TeamPermissionAgent`, `TeamPermissionReview`, `TeamReviewFeedback`, `TeamRegister`) by `runId`; `teams.ts` wires `TeamReplay` cancellation via `void this.enqueue(s.run.id, ...)` without modifying `team-replay.ts`.
- `createRun()` acquires `runId` first (allowing idempotent replays and `request-conflict` checks without touching project locks) and then `project:${projectId}` for new runs to serialize `missionReservations` and `activeForProject` across `await volumeUsage(...)`, re-checking parent removal state afterward. Strict lock order is `runId -> project:${projectId}`; no `project:${projectId}` task ever acquires a `runId` lock, preventing AB-BA deadlocks. `TeamService`, `GoalService`, `MissionService`, and `RoutineService` all register in-flight creates in `PendingCreates`; `haltPause()` snapshots existing `this.records` and enqueues their pauses immediately while concurrently awaiting the finite snapshot of matching in-flight creates and pausing each newly published matching ID without touching out-of-scope queues.
- Reentrancy safety: no `enqueue(runId, ...)` callback awaits `enqueue(runId, ...)` for the same `runId`. Background `operation()` callbacks (`perform`, `commandRecorder`, `saveWitnessSoon`, `sampleWitness`, `noteLeftover`) and background retention/publication/permission-agent tasks run outside `runId` queues and enqueue only brief state commits. Fire-and-forget continuations (`TeamReplay.end` -> `void host.cancel` and `TeamPermissionReview.requestPermissionEvidence` -> `void host.enqueue`) queue subsequent turns on `runId` after the active turn exits.
- `tick()` refreshes host-wide session inventory (`usage.tick` and `limits.reconcile`) outside per-run locks, fans out `step(stored)` via `mapConcurrent(..., 16)` (isolating per-run errors), runs synchronous `drainEntries()` and `objectiveTests.drain()`, and awaits `ingestEntriesAsync()` which snapshots `EntryIngestQueue` work by `runId` and runs each run's ingestion inside `this.enqueue(runId, ...)`. `TeamRetention.deleteRecord()` and `removeRun()` track active record deletions in a dedicated `deletingRuns` set (separate from `removingRuns`, which also covers live-run and settled-run background workspace cleanup) and purge `entryQueue` before awaiting trace/`sealed` removal; `ingestRun()` returns early for `deletingRuns` and synchronous `rateTask()` rejects `deletingRuns` with `team-not-found` without disrupting active or settled runs during background workspace cleanup.
- `close()` aborts in-flight controllers synchronously and drains `Promise.allSettled([reviewFeedback, this.queues.drain()])`. `idle()` settles `reviewFeedback`, `this.queues.settle()`, and bounded generations of `removalTasks`, `publicationTasks`, and `memberWorkSaveTasks`.
- Retained domain invariants migrated from inline comments:
  - Operation intents persist `recording: true` before starting child commands and clear it on a trailing witness save once every start token is read, so interrupted operations never claim a complete process witness. A failure's save clears it as soon as no command is between `starting()` and its spawn, because `started` records each pid as a group and session in the same synchronous block as the spawn. The failure aborts the operation's controller before dropping it, and a failed intent refuses further commands.
  - Permission authority switches fence in-flight coordinator answers (`unfencedAnswers` + `invalidatePermissionDecisions`) before `agentSwitched` enables the permission agent.
  - Delivery recovery pins `pullRequest.branch` once observed, forbids clean-base reset after a pull request is recorded, and preserves `deliveryRecoveryAttempts` across steers.
  - Ledger enrichments (`enrich`) run outside run locks with a 30 s abort timer and a cap of `ENRICH_LIMIT = 16` pending reads.

## Consequences

- Independent goals, routines, missions, and team runs execute, tick, halt, and resume concurrently while same-entity mutations remain strictly serialized in FIFO order.
- Re-entrant same-key deadlocks and unbounded queue-map retention are eliminated.
- `packages/host/src/goals.ts`, `routines.ts`, `missions.ts`, and `teams.ts` carry zero prose comments under `scripts/check-comments.mjs`.
