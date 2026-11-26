# Swarm Inspector and Same-Implementer Repair Experiment

Date: 2026-11-26. Status: accepted design and baseline instrumentation gate.

## 1. Architectural Synthesis

Infinite coordinates multi-agent team runs on the host (`packages/host/src/teams.ts`), separating durable authority in sealed run records from SQLite-backed evidence and client projections.

### Existing Observability & Coordination Primitives (on `main`)

- **Blackboard (`packages/host/src/evidence/blackboard.ts`, `packages/host/src/evidence/reader.ts`, `packages/host/src/team-entry-route.ts`)**: Stores encrypted, typed run entries (`contract`, `finding`, `blocker`, `handoff`, `report`, `integration`, `check`, `direction`) in `evidence/evidence.sqlite3`. Workers post entries via session journals (`team-entry`) and read entries via `EvidenceReader` through the `team-entry` worker route (`team-entry-route.ts`), recording `"team-entry-read"` session journal events under fixed digest and call caps (`member_scopes`). The host remains the sole SQLite writer and the sealed run record remains the state authority.
- **MissionProgress (`packages/host/src/mission-progress.ts`)**: `MissionProgressService` and `projectMissionChild` project bounded snapshots of linked child runs, current-revision assignments, latest verification checks, and concurrent worker liveness probes for mission oversight.
- **Host and CLI Team Surfaces (`packages/host/src/team-list.ts`, `packages/host/src/team-watch.ts`, `packages/host/src/team-cli.ts`, `packages/host/src/server.ts`)**: Expose run status, member roles, task states, check results, open owner decisions, and live SSE topic updates (`/api/events`) while stripping internal continuation secrets from `TeamView` (`prompt`, `nativeSessionId`, `continuation`, and `turns`).
- **Stall Replacement and Limit Fallback (`packages/host/src/teams.ts`)**: Uses inactivity quiet windows (`stallWindowFor`, `lastActivityAt`, `stalledAt`, `pendingLimit`) and recorded wait reasons (`run.reason`, `member.stoppedReason`) before triggering `replaceStalledMember` or `switchLimitedMember`.

### Companion Inspector & Stall Hardening Work

Planned companion PRs build on these primitives to add Web/CLI/Mobile Run Inspector views and spinner-immune stall detection with richer wait reasons, while this PR establishes baseline repair-loop measurement on `main` before altering repair execution.

### Baseline Measurement Before Execution Changes

Currently (`packages/host/src/teams.ts`), when a repair is triggered by:
- a reviewer reporting `verdict: "changes-requested"` (`cause: "review"`),
- a host verification check finishing `"failed"` and entering repair (`cause: "check"`), or
- a delivery coordinator reporting `"delivery-repair"` (`cause: "delivery"`),

the host calls `repair(stored, feedback, cause)`, increments `run.round` (capped at 2 rounds), and queues a **cold `integrator`** member in a new isolated workspace clone at `run.headCommit`, followed by verification `check()` and a fresh independent `reviewer`.

Before changing that execution path (for example, resuming or rebinding the originating implementer), we measure the existing baseline on the host:
- **Metrics engine (`packages/host/src/repair-metrics.ts`)**: `computeRepairLoopMetrics(runs, memberUsage, options)` reconstructs every repair loop per `(run, revision)` from full `TeamRun` records.
- **Host endpoint (`packages/host/src/repair-metrics-routes.ts`, `packages/host/src/remote-access.ts`)**: `GET /api/usage/repair-loops?project=ID&days=N` (strictly validated; available over encrypted remote channels).
- **CLI command (`packages/host/src/repair-metrics-cli.ts`)**: `infinite usage repairs [--project ID] [--days N] [--json]`.

## 2. Same-Implementer Repair Experiment Gate

### Baseline Command

```sh
infinite usage repairs --days 30 --json
```

Scope to a single repository when evaluating per-project rollouts:

```sh
infinite usage repairs --project PROJECT_ID --days 30 --json
```

### Falsifiable Primary Metrics

Every measurement MUST honor strict denominator completeness:

1. **Resolution latency (`medianMinutes`, `p90Minutes`)**:
   - Elapsed wall-clock time (`durationMs`) from the loop trigger timestamp (`changes-requested` `reportedAt`, failed `check` `finishedAt` leading into an integrator attempt, or `delivery-repair` `reportedAt`) to the resolution timestamp (`approved` `reviewer` `reportedAt` on a passing checked commit).
2. **Measured repair cost (`medianTokens`, `medianUsd`)**:
   - Sum of tokens (`input + output + reasoning + cacheRead + cacheWrite`) and priced USD across all integrator, check-associated, and re-review member attempts inside each loop where **every** member in the loop has complete, fully priced measured usage.
   - **Unmeasured honesty invariant**: Loops containing any unmeasured, partial-coverage, or unpriced (`pricing.unknown > 0`) member are excluded from `medianTokens` and `medianUsd` and reported separately in `unmeasuredLoops` and `unmeasuredMembers`. Unmeasured work is **never** coerced to `0` tokens or `$0`.
3. **Denominator completeness invariant**:
   - All repair loops in the window enter `loopsTotal`, including unresolved outcomes (`blocked`, `cancelled`, `superseded`, `unresolved`) and `in-progress` loops.
   - All integrator, verification check, and re-review attempts enter `attempts`, explicitly counting **cold replacements** (stalled, provider-limit-switched, retired, or evidence-rejected retries) and **failed resumes** (any member whose `turns` record a `resume` fallback to `start`, or whose `stoppedReason` records resume failure).

### Isolation and Safety Invariants

Any future experiment that resumes or reuses an implementer for repair MUST preserve all existing isolation and review invariants:

1. **Isolated Git clones unchanged**: Every worker continues executing in its own isolated Git clone. No shared mutable working copy is permitted between concurrent workers or against the host's main integration workspace.
2. **Rebind to authorized paths and current integrated head**: When resuming or rebinding an implementer, the host MUST check out or rebase onto the current integrated `run.headCommit` and enforce `task.paths` (or `goal.allowedPaths`) via `assertMemberScope` and `captureMemberResult` before `integrateMemberResult` accepts any changes.
3. **Retain cross-provider limit fallback and cold replacement**: If a resumed implementer hits a provider limit (`switchLimitedMember`), stalls (`replaceStalledMember`), or fails native continuation (`resumeFailed`), the host MUST fall back to a cold replacement / configured `limitFallback` profile and record the fallback in the denominator metrics.
4. **Retain independent full-commit review**: A passing host verification run (`stored.checkHead === run.headCommit`) and an independent `reviewer` approval (`verdict: "approved"`, honoring model-family separation and `automaticMergeReviewReason` lineage checks) remain mandatory before delivery or `ready-for-review`.

### Minimum Sample and Win Threshold

Do not enable same-implementer repair as the production default until an A/B or pre/post gated evaluation satisfies all of the following:

- **Minimum sample**: At least **20 repair loops** in the 30-day baseline and at least **20 repair loops** in the experiment arm (with at least **80% measured loop coverage** when comparing token/USD medians, or >= 20 measured loops per arm).
- **Win threshold**:
  - At least a **25% reduction in `medianMinutes`** for resolved repair loops, **and**
  - At least a **20% reduction in `medianTokens`** (and no regression in `medianUsd`) across measured repair loops, **with**
  - No increase in `unresolved` (`blocked` / `cancelled` / `superseded`) rate, no increase in `failedResumes` + `coldReplacements` per loop beyond the baseline budget, and no regression in post-approval outcome quality.
