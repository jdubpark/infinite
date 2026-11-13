# Continuous autonomy: modes, standing goals, the spend fuse, and attention (INF-181)

Date: 2026-11-13. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`. It defines contracts C12, C13, and C18, and carries decisions D1, D2, D7, and D8 of the continuous autonomy amendment.

## Intent

On 2026-11-13 the owner asked for a continuous and autonomous system. Cost matters less than before. Agents still must not blow up their context or waste money.

Today every unit of autonomous work is finite. A goal stops after at most 10 cycles and 1,440 minutes. A routine's approval expires within 30 days. The owner hears about every start, finish, and stop. Spend never stops anything.

This design lets work continue without the owner under one principle. It adds a standing mode to goals, lifts the routine expiry in autonomous projects, puts a spend fuse at the launch gate as the outer bound, turns on automatic merge for newly enrolled repositories, and narrows what interrupts the owner to five reasons. Everything else goes into a daily digest.

### The principle

**The system acts without the owner when three things hold.** The action is reversible. Its outcome is established by a host receipt or an independent evaluator, never by the agent that did the work. It stays inside the spend fuse and the project's authority: permissions, allowed paths, delivery policy, and approved profiles. Otherwise it waits for the owner.

Unattended loops that hold up share three traits: an outcome signal from outside the agent, small reversible changes, and automatic demotion. Self-graded learning is the best-documented way such loops get worse: self-written skills scored 8.1 to 11.5 points below no skills (arXiv 2602.12670). One added verification step raised task success by 15.6% (arXiv 2503.13657). Agents cannot sense their own budget, and token use for one task varied up to 30 times (arXiv 2604.22750). So the bounds here are static caps that the host enforces.

## Current state

Observed in this worktree:

- **Goals.** `createGoalSchema` (`packages/host/src/goal-types.ts`) allows `maxRuns` 1 to 10, `maxMinutes` 5 to 1,440, `maxTotalMinutes` up to 1,440, and `maxMembers` 4 to 200. `GoalService.create` (`packages/host/src/goals.ts`) fixes `deadlineAt` and `ceilingAt` from the creation time. Each cycle gets at most 60 attempts, bounded by the goal's remainder. Reaching `maxRuns` ends the goal `ready-for-review`. A `no-change` cycle ends it `no-opportunity` or `ready-for-review`. A deadline or attempt stop ends it `limit-reached`, which is terminal. `outcome` accepts an assessment only after the goal stops. Cycles do not wait for the owner: `step` starts the next cycle on its own until `maxRuns`, the time limit, or a `no-change` report, and nothing compares a cycle with its success criteria.
- **Goal record.** One sealed file per goal, rewritten whole on every save. `events` keeps the last 200. `steering` allows 20 entries and 24,000 bytes. `cycles` has no bound. `retainsTeamRun` keeps the run of every cycle of a live goal, so retention removes none of its clones.
- **Next cycle.** It starts from the latest cycle that is `ready-for-review` or `merged`. For a merged parent, `createRun` (`packages/host/src/teams.ts`) starts from `deliveryReceipt.mergeCommit`. `consume` persists the delivery receipt first. `captureDeliveryBaseline` (`packages/host/src/team-workspace.ts`) then fetches the reported merge, requires a commit object whose tree equals the reviewed tree, and sets `refs/infinite/delivery`. The run becomes `merged` only after that passes. A mismatch blocks the run with `delivery-baseline-changed`. Moved-base reconciliation needs standalone ownership, so a goal run blocks (`docs/teams.md`). `step` builds the next cycle's `previousWork` from every reviewed cycle, but `teamGoalContextSchema` (`packages/host/src/team-types.ts`) allows at most 16 entries, and `createForGoal` parses it. A 17th reviewed cycle would fail to start. Today `maxRuns` of at most 10 hides this.
- **Lineup.** The repository ships no default lineup (`docs/teams.md`). The operator configures `teams.lineup` in the host config, and a goal snapshots it at creation.
- **Routines.** `RoutineService.create` (`packages/host/src/routines.ts`) refuses an approval longer than 30 days (`maxApprovalMs`). It allows `intervalMinutes` 5 to 10,080 and `maxOccurrences` 1 to 100, and the next goal's whole time ceiling must fit before expiry. `authority()` hashes the canonical project path, the project's `team`, `teamworkDir`, `source`, and `linear`, and the host's `teams`, `source`, `linear`, and `agents` blocks. Any change blocks every active routine of the project. A child goal with unmerged work, or one that stopped blocked, needing input, or at a limit, blocks the routine.
- **Spend.** `usage.budgets` is informational (`docs/teams.md`, `packages/host/src/usage-service.ts`). `UsageService` prices OpenCode usage from one sealed ledger. The worker has journaled Claude Code and Codex usage and coverage since INF-183 phases 2a and 2b (`packages/host/src/transcript-usage.ts`, `packages/host/src/worker.ts`). The ledger does not read those records yet. That is INF-183 phase 3. The evidence store exists (`packages/host/src/evidence/store.ts`).
- **Launch gates.** `TeamService.launch` calls `assertBudget` (deadline and attempt limit) and waits for a free slot under `maxSessions`. A mission coordinator starts through `Manager.createTeamSession` in `packages/host/src/missions.ts`, outside `TeamService.launch`. The storage floor refuses new runs. Nothing gates on tokens, money, or launch rate.
- **Delivery.** `teamDeliverySchema` (`packages/host/src/team-types.ts`) has `merge` and `pr`. With no `--delivery`, `requestedDelivery` (`packages/host/src/team-cli.ts`) keeps a saved policy and gives a first enrollment none, so it is review-only. A first enrollment does get delegated permissions by default. `createRun` pins `run.delivery`, and `assertDelivery` refuses delivery when the configured policy's digest differs. No host code deploys. `DEFAULT_PERMISSION_SCOPE` tells the permission coordinator to escalate deploy, promote, release, and publish.
- **Enrolled repository.** A project with a record in `repo-enrollments.sealed`, written by `infinite repo init` through `RepoEnrollmentService` (`packages/host/src/repo-enrollment.ts`). `restore` overlays the record's `team`, `source`, `linear`, and teamwork folder on the configured project while the canonical path still matches. A project with a `team` block in the config file and no record can run goals, but it is not enrolled.
- **Attention.** `Notifier` (`packages/host/src/notifier.ts`) polls and sends push messages through `PushSender` (`packages/host/src/push.ts`) to the devices in `PushStore`, on channel `attention`. It sends session states (`needs-you`, `turn-finished`, `exited`, `recording-error`), goal and team lifecycle (`*-started`, `*-finished`, `*-stuck`, `*-cancelled`), and `host-storage`. It holds a team member's permission prompt while the delegated coordinator may still decide it (`promptOwner`, a 45-second start grace, an 8-minute hold). `config.push.events` selects events. By default the owner gets a push for every goal and team start and finish. Nothing collects a digest.

## Goals

1. Work in an autonomous project continues across cycles, days, and host restarts without an owner action, inside the principle.
2. Two standing shapes: a goal that cycles until its criteria are assessed as met, and an objective with a cadence and no end.
3. One hard spend fuse that the host enforces at every member launch, in tokens, list-price dollars, metered dollars, and launches per hour.
4. Automatic merge after checks and independent review for newly enrolled GitHub repositories.
5. Five interrupt reasons, each raised by a named host event, and a bounded daily digest for everything else.
6. Supervised projects, finite goals, and existing routines behave as today.

## Non-goals

- Host-run deploys. Part 5 states only the condition for delegating one later.
- A money budget. The fuse stops runaway loops. `usage.budgets` stays informational.
- The evaluator, the objective record, and the assumption register (C14).
- Adoption of learned changes (C15), read fan-out (C16), and context crossings (C17).
- Stopping a running member for spend.
- Fuses per tenant. The current runner is single-tenant.

## Anti-goals

- A loop that runs all night because no single check owns the outer bound.
- An interrupt stream the owner learns to ignore.
- A verdict from the agent that did the work, shown as an outcome.
- An upgrade that blocks every active routine.
- A next cycle that starts from a commit the host has not validated.
- Unmeasured usage counted as zero.

## Approaches

1. **Raise the limits.** Allow `maxRuns` in the thousands, totals in weeks, and routine approvals for a year. Every code path stays. A goal total then means nothing, the record and the retained clones grow without bound, and only time stops a runaway loop.
2. **Chain routines.** A routine with no expiry submits a finite goal at each interval. It reuses code. Each occurrence starts with a fresh objective and no carried goal digest, one failed child blocks the chain, and a goal with terminal criteria cannot be expressed.
3. **A standing mode on the goal, a fuse at the launch gate.** One goal record carries continuity across cycles. Allowances renew per cycle. The fuse replaces time totals as the outer bound. Routines lose their expiry only in autonomous projects.

The design uses approach 3. Continuity needs one record that the objective record (C14) and the goal digest (C17) can attach to, and an outer bound that does not depend on the goal's own limits.

A fuse checked only between goal cycles would miss team runs, missions, learning sessions, and launch storms inside a cycle. The fuse is checked at member launch, the one gate every agent passes.

## Design

### Part 1. The principle as host rules

| Action | Acts without the owner when | Otherwise |
|---|---|---|
| Commit on an integration branch, publish a run branch | always; the host never force-updates a remote branch | — |
| Start a goal cycle, a routine occurrence, or a member | the fuse is closed and the project's authority allows it | waits |
| Advance a goal on a cycle's result | a host receipt (checks, a review record, a validated baseline) or an evaluator assessment (C14) supports it | waits for the owner |
| Merge onto the base branch | the delivery policy allows it, checks passed, and a reviewer of another model family approved (C19) | review-only |
| Deploy, release, external message, credential change, destructive operation outside the workspace | never in this design | interrupt (Part 6) |
| Adopt a learned change | it is class A (C15) | review, or never |

A merge counts as reversible because a revert commit undoes it and the host never rewrites history. A deploy does not count, until the host can run a health check and a rollback (Part 5.3).

### Part 2. Autonomy mode (C12)

**Record.** `StoredEnrollment` (`packages/host/src/repo-enrollment.ts`) gains `autonomy?: "supervised" | "autonomous"`, beside `team` and outside it. The code has no enrolled flag, so for the mode a project is enrolled when `restore` applied its enrollment record, which sets the overlay. `restore` skips a record whose canonical path no longer matches. An enrolled repository without the field is `autonomous`. A project without an applied record is `supervised` and cannot change. Host config `autonomy.defaultMode` lets the operator make `supervised` the default for enrolled repositories. `RepoEnrollmentView` returns the effective mode. *(My call: the mode stays out of `project.team`, so it is outside the routine authority digest, and a mode change blocks no routine. Part 3.6 gives the routine rule instead.)*

**Change.** `PUT /api/projects/:id/autonomy` with `requestId`, `revision`, and `mode`, owner only. The CLI is `infinite autonomy mode PROJECT supervised|autonomous`, and `infinite repo init --autonomy MODE`. The only enrollment write path today, `putLocked` in `packages/host/src/repo-enrollment.ts`, requires configured teams, an idle project, and a clean Git root, so a change at any time cannot go through it. The mode has its own write path, `setAutonomy`. It shares the enrollment revision counter and the request receipts, so a change is one enrollment revision and a replayed request returns its receipt, and it skips the Git, busy, and teams checks.

**Pin.** `TeamRun` gains `autonomy`, set in `createRun`. A goal cycle passes its own mode. A standalone run, a mission subteam, and a handoff run (`createForHandoff`) take the project's current mode. `ProductGoal` records the mode it started in, and the goal keeps it: each `GoalCycle` records the goal's pinned mode. A goal with no pin is `supervised` for all of its cycles. A change therefore applies to the next run and the next goal. A change to `supervised` also reaches a running standing goal at its next cycle boundary, through rule 3 of 3.4. A run or goal without the field is `supervised`, so work in flight at the upgrade keeps today's behaviour. The mode stays out of the `createRun` request fingerprint, as `parallelismCeiling` does today, so a goal launch prepared before the upgrade still replays.

**The evaluator condition.** A goal or run whose lineup has no eligible evaluator pins `supervised` at start (C14), because without an independent evaluator the second condition of the principle cannot hold. The host's default lineup therefore gains a default `evaluators` entry, so an enrolled repository is autonomous without owner setup. No default lineup ships today, so the host derives that entry when it reads a lineup with no `evaluators` slot: `crossReviewer` (C19), then `reviewer`, then each strong `escalations` profile, at most 4. C14 then picks one whose family differs from the coordinator's and whose model authored no integrated change in the cycle (C9 rule 4). *(My call: these are the profiles that C19 already needs for an automatic merge. The derived slot is never written into the parsed config, so the authority digest does not change, as 3.7 requires.)* The documented lineup example gains an explicit `evaluators` entry. `RepoEnrollmentView` reports `autonomyReady: false` with the reason when no eligible profile exists, so `repo init` tells the owner at onboarding. Each run or goal that pins `supervised` for this reason appears in the daily digest with the reason (6.3).

| Behaviour | `supervised` | `autonomous` |
|---|---|---|
| Standing goals (Part 3) | refused with `standing-requires-autonomy` | allowed |
| Routine approval | expires within 30 days, finite occurrences | `expiresAt` and `maxOccurrences` optional |
| Delivery default at a first `repo init` | review-only | merge (Part 5.1) |
| Owner notifications | today's push events | C18 interrupts and the daily digest |
| Spend fuse | applies | applies |
| C14 to C17 | as each contract states, else today's behaviour | as each contract states |

I assume each of C14 to C17 states its behaviour per mode, and that where one does not, autonomous enables it and supervised keeps today's behaviour.

### Part 3. Standing goals (D1)

**3.1 Shapes.** `createGoalSchema` gains:

```ts
standing?: { shape: "until-met" } | { shape: "objective"; cadenceMinutes: number };  // 30 to 10,080
```

`until-met` cycles until a cycle's composed verdict (C14) is `met`. `objective` has no terminal state. A cycle starts every `cadenceMinutes`, never before the previous cycle settles, and missed starts coalesce as routine ticks do. A standing goal refuses `maxRuns`. A routine's goal template refuses `standing`. *(My call: the default cadence is 1,440 minutes and the floor is 30, because a cycle with checks and review rarely fits in less.)*

**3.2 Allowances renew per cycle.** In a standing goal, `maxMinutes`, `extendMinutes`, `maxTotalMinutes`, and `maxMembers` apply to each cycle. At cycle start, `GoalService` sets `deadlineAt` to now plus `maxMinutes`, `ceilingAt` to now plus `maxTotalMinutes`, and the cycle's attempt allowance to `min(60, maxMembers)`. The goal's own attempt check compares the current cycle's members, not the goal total. Between cycles a standing goal has no deadline. An owner extension applies to the current cycle only. The spend fuse is the only bound across cycles. *(My call: reuse the fields, because every client already shows them. The goal view labels them "per cycle".)*

**3.3 After a cycle settles.** `GoalService.step` classifies the settled cycle:

| Class | The cycle ended | Effect |
|---|---|---|
| `reviewed` | `ready-for-review`, or `merged` with a validated baseline | parent of the next cycle |
| `no-change` | `no-change` | normal; the next cycle starts from the same parent |
| `failed` | `blocked`, or stopped by its deadline or attempt allowance, for a cause inside the work | counts toward rule 5 of 3.4 |
| `excluded` | an owner stop, a provider limit with no fallback, or a deadline while the fuse was open | neither |

Then the goal waits for the cycle's verdict. C14 starts an evaluator when a cycle settles `ready-for-review`, `merged`, or `no-change`, before the goal launches anything else. It gives a blocked or cancelled cycle none, and an unavailable evaluator yields `inconclusive`. A cycle with a verdict is failed as the objective record design defines it: a composed result other than `met`, and no gain in `met` criteria. A cycle with no verdict counts as failed when its class is `failed`. *(My call: otherwise a goal whose every cycle blocks would never trip the counter.)*

**3.4 Stop conditions.** A standing goal stops starting cycles in exactly these cases:

1. The owner pauses or cancels it, as today.
2. `until-met` only: the composed result is `met`. The goal stops as `ready-for-review` with `stopReason: "provisional-met"`, as C14 defines. It is not `achieved`. The owner may record `achieved`, or `not-achieved` with `continue: true`, which appends the owner's summary to the objective record and starts the next cycle. That override is the one way a stopped goal resumes. An `objective` goal never stops on `met`. It records the provisional verdict and waits for its next cadence, because C14's stop on `met` applies to `until-met` and finite goals only.
3. The project's mode is `supervised` at a cycle boundary. The goal becomes `paused` with reason `supervised-mode`. Resume is refused until the mode is `autonomous` again.
4. A cycle holds an unresolved external operation: a delivery receipt without a validated baseline, an unresolved `deliveryAttempt`, or uncertain head publication. The goal becomes `blocked` and raises an interrupt (reason 2). Part 5.2 gives the reason.
5. Three failed cycles in a row (3.3), the count that the objective record design defines. The goal becomes `paused` with reason `repeated-failures` and raises an interrupt (reason 5). An owner resume resets the count. C14's bound on self-generated follow-up work raises the same reason.
6. A receipt refutes an `outcome` assumption (C14). The next cycle does not start until the owner corrects the objective record, and the host raises reason 4.
7. Today's other blocks: the Linear issue changed, the project is no longer enrolled, or the lineup lacks a strong coordinator and reviewer.

The fuse never stops a standing goal. While a fuse of its project or of the host is open, the goal stays `running` with reason `fuse-open`, starts no cycle, and continues when the fuse closes.

**3.5 Bounded record and retention.** The goal record keeps its last 50 cycles. Older cycles fold into `cycleTotals` (a count per class) and `foldedUsage` (one rollup), so `get()` still sums all usage. The outcome ledger's goal roll-up keeps the full history. For a live standing goal, `retainsTeamRun` keeps only the active cycle's run and the parent of the next cycle. Older cycles follow the normal retention windows. A standing goal takes the host's current lineup at each cycle start and records it on the cycle. *(My call: a lineup snapshot taken once would outlive retired profiles and their credentials.)* I assume the objective record design holds objective revisions, so the steering cap applies per revision.

**Cross-cycle context.** Standing mode depends on the goal digest of C17 for what one cycle tells the next. That digest replaces `previousWork` and is bounded, so the 16-entry limit of `teamGoalContextSchema` no longer stops the 17th cycle. This design does not define the digest. If standing goals must ship first, `step` passes only the 16 newest reviewed cycles in `previousWork`.

**3.6 Routines.** In an autonomous project, `createRoutineSchema` makes `expiresAt` and `maxOccurrences` optional. Without `expiresAt`, the approval lasts until the owner cancels the routine, the routine blocks, or its authority digest changes. "No expiry while the spend fuse holds" means that an open fuse pauses triggers and never expires the routine. The routine pins the mode it was approved in. Each occurrence's goal starts in the narrower of the pinned mode and the project's current mode. An open-ended routine in a project that becomes `supervised` blocks: "An open-ended routine needs a new approval with an expiry in a supervised project." The 30-day rule for supervised projects and the block on unmerged work stay as they are.

An open-ended routine needs a bounded record too, because `packages/host/src/routines.ts` appends each occurrence to `occurrences` and rewrites the whole sealed record on each save. The routine record keeps its newest 50 occurrences in full. Older ones fold into `foldedOccurrences` (a count and the first and last start times). The pending launch request (`launch`) and the occurrence of `activeGoalId` are never folded, whatever their age. Every count check uses the folded count plus the kept entries: the `maxOccurrences` limit, the load check against `maxOccurrences`, and the status chosen at resume. The view and the CLI show the folded count. An older occurrence's receipt stays in the goal record it started, which `GoalService` never deletes, and in the outcome ledger's goal roll-up. *(My call: 50, the bound of the goal record, because one occurrence is one goal.)* For continuous work, a standing `objective` goal is the better shape, because it carries the goal digest and survives single failed cycles.

**3.7 The authority digest (C11).** The new settings and their treatment:

| Setting | Where | In the digest |
|---|---|---|
| Autonomy mode | `StoredEnrollment.autonomy` | no; the routine pins it (3.6) |
| Fuse ceilings, attention and digest settings | the host config `autonomy` block | no |
| Standing-goal fields | the goal | not a setting; the routine's fingerprint covers its template |
| A merge policy written by the new default | `project.team.delivery` | yes, as today |

The new host settings sit in a top-level `autonomy` block, which `authority()` never reads, so they need no removal before hashing. A new key inside a digested object (`project.team`, or the host's `teams`, `source`, `linear`, or `agents`) must not add a new schema `.default()`. The code applies its default at read. Otherwise parsing writes the key into the object, the hash changes, and the upgrade blocks every active routine. One default already sits in a digested block: `teams.publishHeads` is `z.boolean().default(true)` in `packages/host/src/config.ts`, so every parsed `teams` object already carries it. For that reason a frozen-digest test pins today's formula: it stores the digest of a fixture configuration as parsed today, `publishHeads` included, and requires the changed code to produce the same value.

### Part 4. The spend fuse (C13)

**4.1 Units.** Three units, read from the usage ledger in the evidence store (INF-183 phase 3):

- **Tokens**: input, output, reasoning, and cache writes. Cache reads are left out. *(My call: they dominate long sessions at a tenth of the input price, and counting them would trip on honest work.)*
- **List dollars**: `listUsd` (C5), cache reads included at their price. It is a list-price equivalent for every profile, metered or subscription. It is never shown as money spent.
- **Metered dollars**: `spentUsd` (C5), real money. C5 records it only for rows whose account is `metered` in `usage.accounts`, priced as `priceUsage` (`packages/host/src/usage.ts`) prices them, including the DeepSeek peak multiplier. Rows from subscription profiles never count in it.

Every usage row counts, whatever its purpose (C8). Briefing rows count in the host scope. The learning budget therefore sits inside the fuse. Its decided default is a quarter of the weekly project ceiling, which is 500 M tokens, 2,500 list USD, and 250 metered USD a week at the defaults below. The delegated adoption design owns that budget.

**4.2 Scopes, windows, and defaults.** Ceilings apply per project and per host, per UTC day and per week starting Monday, as `usage.budgets` periods do. A launch-rate limit applies per rolling 60 minutes.

| Scope | Day | Week | Launches per hour |
|---|---|---|---|
| Project | 500 M tokens, 2,500 list USD, 250 metered USD | 2 B tokens, 10,000 list USD, 1,000 metered USD | 30 |
| Host | 1.5 B tokens, 7,500 list USD, 750 metered USD | 6 B tokens, 30,000 list USD, 3,000 metered USD | 80 |

*(My call: the heaviest honest day this design foresees is six members busy for 20 hours in one project. At an estimated half a million counted tokens and 10 list dollars per member-hour, that is about 60 M tokens and 1,200 list USD. The day ceiling sits about twice above that in list dollars and eight times in tokens, because the token mix varies most. A week is four days' ceiling: a loop that runs just under the day ceiling every day trips on the fourth day, and one heavy day does not. The host ceiling is three projects at their ceiling. A project cycle with a read pool launches about 15 members in its first hour, so 30 leaves twice that. The host launch limit sits below the 104 launches an hour of the recorded incident and above four projects at 20 an hour.)* *(My call, metered dollars: in `packages/host/src/price-catalog.ts`, the dearest row below `meta/muse-wonder-1.0` is `meta/muse-spark-1.3`, at 1.25, 0.15, and 4.25 USD per million input, cache-read, and output tokens. At 0.45 M input, 0.05 M output, and 2 M cache-read tokens per member-hour, the same heavy day of 120 member-hours costs about 130 USD. The day ceiling is about twice that, no higher than the list multiple and well below the token multiple, because this unit is real money: a ceiling far above what a loop could spend protects nothing, and one grant raises it. The week and host ceilings follow the rules above. The same day costs about 55 USD on `deepseek/deepseek-v4-pro`, before its peak multiplier, and about 380 USD on `meta/muse-wonder-1.0`.)* These are estimates, because Claude Code and Codex are unmeasured until INF-183 phase 3. The fuse view shows the highest measured day of the last 30 days beside each ceiling, so the owner can recalibrate.

Host config, with defaults in code and none in the schema:

```ts
autonomy?: {
  defaultMode?: "autonomous" | "supervised";
  fuse?: {
    project?: Ceilings; host?: Ceilings; projects?: Record<string, Ceilings>;  // projects: per-project overrides
    unmeasured?: { tokens: number; listUsd: number; spentUsd: number };
  };
  attention?: { digestAt?: string; timeZone?: string };   // "08:00", an IANA zone
};
type Ceilings = { day?: Amount; week?: Amount; launchesPerHour?: number };
type Amount = { tokens?: number; listUsd?: number; spentUsd?: number };
```

**4.3 Check and admit.** `FuseService`, a module in the evidence store, has two operations with different callers.

- `check({ projectId })` reads the fuse state of the project and of the host, and returns `closed`, or `open` with the scope, window, and cause. It writes nothing and charges nothing. Every "can work start" decision uses it: `GoalService.step` before it prepares a cycle, `RoutineService.step` before it starts a goal, and `TeamService.launch` immediately before the session slot check, after `assertBudget`, `assertRunPath`, and the Linear tracking block, for a member without a session (`!hasLaunch`). While the fuse is open, no cycle or occurrence starts. A member stays queued, the run keeps its status, `run.reason` names the fuse, and the next scheduler pass checks again.
- `admit(launch)` durably admits one identified launch. `launch` is `{ launchId, projectId, purpose, role, profileId }`. `launchId` is the `requestId` of the `CreateSession` request, which each caller sets before it starts a session and which `Manager.createOnce` already uses to recognise a replay. For a team member it is `member.sessionId`, new for each attempt and turn (`randomUUID` in `packages/host/src/teams.ts`), and the fuse records it with the `TeamAssignment` fields `runId`, `memberId`, and `revision`. For a mission coordinator it is `Attempt.sessionId` (`packages/host/src/missions.ts`). `admit` computes the estimate from the profile and role (4.5), writes the reservation and the launch count to the baseline (4.9), and only then returns `ok`. A repeat while the reservation is held returns the stored result and charges nothing.
- `TeamService.launch` calls `admit` immediately before the `try` that calls `createTeamSession`, after the slot check, the delivery checks, the scratch directory, and `writeTeamContext`. Every learning harness that starts a session (C8) calls it just before its start.
- The mission coordinator launch (`launch` in `packages/host/src/missions.ts`) has no slot check of its own, so it calls `check` and `admit` back to back before `createTeamSession`. A mission is charged to its first repository's project, `repoProjectIds[0]`, which its coordinator session already names. *(My call: the backstop then builds the same launch from the session request, and each subteam charges its own project.)* Read members (C16) start through `TeamService.launch`, so they follow the same two steps.

**Backstop.** `Manager.createOnce` calls `admit` with the same `launch`, built from the request and its `TeamAssignment`, after its replay check and its `maxSessions` check inside the serialized start. A launch that `TeamService` admitted is recognised by its id and is not charged twice. A caller that skipped `admit` is admitted or refused there, and a refusal throws `fuse-open`. A replayed launch whose session already exists returns before the backstop and is not a new launch. After the session is created, `createOnce` marks the launch started.

**A launch that never starts.** It releases its reservation. `createOnce` releases it when the start fails after the backstop. The caller releases it when `createTeamSession` throws earlier, including on the configured session limit. A cold start releases every admitted launch whose session does not exist. The launch-rate count stays, because the launch was attempted. A later `admit` with the same id is a new decision against the ceilings with a new reservation, and it adds no launch to the count. *(My call: a member that loses a capacity race keeps its session id, so its retries never count twice toward the rate.)*

**4.4 Running members and exemptions.** The fuse never stops or signals a running member. The member finishes its assignment, and the host consumes its report. A window can therefore exceed its ceiling by what running members still use. Launches that follow from that report wait. The permission coordinator is exempt from `check`, `admit`, and the launch count, and the backstop passes it by role, because a running member stalls without its decision, and `maxDecisions` (default 25 per run) already bounds it. The effort caps of C16 bound read steps, and a writer attempt is bounded by its cycle's time and attempt allowances and the stall window.

**4.5 Unmeasured and partial usage.** At launch, the fuse reserves an estimate for the session. The estimate is the median counted tokens, list dollars, and, for a metered profile, metered dollars of the same profile and role over the last 30 days of `complete` sessions, when at least 10 exist. Otherwise it is `autonomy.fuse.unmeasured`, default 2 M tokens, 20 list USD, and 5 metered USD, the last charged only to a metered session. *(My call: 2 M counted tokens and 8 M cache reads cost about 4.3 USD on `meta/muse-spark-1.3`.)* A running session counts the larger of its measured amount and its reservation. At exit, a `complete` session settles to its measurement. A `partial` or `none` session settles to the larger of measurement and estimate, and is labelled `estimated`. A row with no price counts its list dollars, and for a metered account its metered dollars, at the estimate. Unknown never counts as zero. *(My call: the rule mirrors C8's settlement, so the two bounds agree.)*

**4.6 Launch rate.** Each launch id that `admit` accepts counts once, in its project and in the host. Reaching the limit opens the fuse with cause `launch-rate`. It closes on its own when the rolling count falls below half the limit. A second launch-rate trip of the same scope in one UTC day stays open until the owner closes it. *(My call: one burst may be honest work; a second in a day is a loop.)*

**4.7 State, view, and reset.** A fuse is `closed` while launches flow and `open` after it trips. Each trip records the scope, the window, the cause (`tokens`, `list`, `spent`, `launch-rate`, or `unmeasurable`), the charged amounts, and the time. Opening raises one interrupt (reason 1). At 80% of a ceiling, the daily digest carries a warning.

`GET /api/fuse` returns, per scope and window: measured and estimated charges, the ceiling, any owner grant, the state, the open trip, the count of sessions charged at an estimate, the launches in the last hour, and the highest measured day of the last 30 days. The Cost view shows it, and the Teams list shows a banner while a fuse is open. `infinite fuse [--json]` prints it.

A day or week fuse closes at its window boundary. The owner can also grant more for the open window with `POST /api/fuse/grants`, owner only, naming the scope, the window, and the amounts. The default grant is half the ceiling. The CLI is `infinite fuse grant --project ID|--host --window day|week [--tokens N] [--list-usd N] [--spent-usd N]`. A grant ends with its window. `POST /api/fuse/close` closes a launch-rate trip: `infinite fuse close --project ID|--host`. No fuse figure reaches a member (C9 rule 3).

**4.8 Storage.** The fuse module owns three tables in the evidence store: `fuse_sessions` (session, project blind index, purpose, reservation, settlement, label), `fuse_launches` (for the rolling hour, kept 48 hours), and `fuse_trips` with the owner's grants. Charges come from sums over `usage_records` by window and project index. *(My call: the fuse reads the usage ledger and stores only what the ledger lacks.)*

**4.9 Baseline file and cold start.** An authoritative baseline is the set of window totals per scope and unit, outstanding reservations, launches in the rolling hour, open trips, and grants. Besides its tables, the fuse keeps that baseline in its own small sealed file, `fuse-baseline.sealed` in the host state directory, written with `writeSealed` as routine records are. `admit` rewrites the file with the new reservation and launch before it returns `ok`, and settlement and release rewrite it afterwards. A failed write refuses the launch. `check` only reads. At a cold start, the fuse reads the file first and the store second. When both are readable, the larger total wins for each scope, window, and unit; reservations and trips are the union. A trip open in either copy stays open, except that an owner close in either copy is final: a trip never reopens, so the copy that still has it open is the older one, and reopening it would hold every launch in its scope until the owner acted again. A baseline entry whose window has ended is discarded with that window, and launches older than an hour drop. A file that fails authentication counts as unreadable. When neither is readable, no authoritative baseline exists: `check` reports open, `admit` refuses, the fuse opens with cause `unmeasurable`, launches wait, and one interrupt arrives (reason 1). Running members are unaffected. That trip closes by itself when an authoritative baseline loads. *(My call: the file keeps both hard ceilings and continuity through a store outage. The store alone loses continuity, and memory alone loses the window at a restart. The rewrite costs one small write per admitted launch, under the launch-rate limit.)*

### Part 5. Delivery defaults (D7)

**5.1 The default.** At a first `infinite repo init` in autonomous mode with no `--delivery`, `requestedDelivery` returns `{ mode: "merge", mergeMethod: "squash" }`. The repository and base branch come from `--source github`, or else from `origin`, as `--delivery merge` already infers them. When neither is available, the enrollment stays review-only and the CLI says why. `--delivery review` and `--autonomy supervised` keep today's review-only default. The policy is written into `project.team.delivery`, so `createRun` pins it and `assertDelivery` checks it unchanged.

An existing enrollment keeps its saved policy. Its absent policy cannot be told apart from an explicit `--delivery review`. *(My call: the host does not widen it silently.)* At the upgrade, the host raises one wider-authority interrupt (reason 3) that lists each autonomous enrollment with a GitHub source and no delivery policy. One owner action, `POST /api/autonomy/delivery-default` or `infinite autonomy adopt-delivery-default`, writes the merge policy to every listed enrollment from its `source.repository` and `source.baseBranch`, one enrollment revision each. The daily digest repeats the list until it is empty or dismissed.

Automatic merge also needs C19's per-change rule: for every model family of a member whose commits are in the head, an approval of that exact head from a reviewer of another known family (the lineup's `reviewer` or its optional `crossReviewer`), and an unknown family fails closed. Without that, the run settles `ready-for-review` without a merge, with reason `reviewer-family-required`, and the daily digest lists it.

**5.2 The merge baseline in a continuous loop.** The rule learned in INF-30 stays binding: after a reported squash or rebase merge, the host validates and retains the actual merge commit before the next goal cycle starts. Today's code does this. This design keeps it on every path:

- The next cycle's parent is the latest `reviewed` cycle (3.3). A cycle with a delivery receipt but no validated baseline is never a parent.
- When such a cycle exists after the parent, the goal starts no further cycle (rule 4 of 3.4). Starting from the older parent would redo work that already landed.
- The receipt is persisted before validation, as today, so a mismatch blocks without losing the evidence of publication.

A squash onto a moved base fails the tree check, and in a busy repository that is common. *(My call: the host then refreshes the project's GitHub mirror with `ProjectSourceService.refresh` and accepts the reported commit as the baseline when three host reads agree. The mirrored base branch's first-parent history contains it. It is not an ancestor of the run's base commit. For `squash`, its diff against its first parent has the same `git patch-id --stable` as the reviewed range; for `merge`, its second parent is the reviewed head. A `rebase` merge onto a moved base still blocks.)* The host then sets `refs/infinite/delivery`, and the cycle becomes `merged`. A failed read keeps today's `delivery-baseline-changed` block.

**5.3 Deploys.** A deploy stays with the owner. It is an external action (reason 2), and the permission scope escalates it. A later design may delegate deploys for one repository when all of these hold:

1. The project configures three host-run commands, run through `teams.commandPrefix` as checks are: deploy, health check, and rollback.
2. The host has run deploy, health check, rollback, and health check once in a rehearsal, with receipts.
3. The owner delegates deploys for that repository, in a setting inside the authority digest.
4. A deploy runs only after a merge with a validated baseline, and a failed health check runs the rollback without asking.

None of this is built here.

### Part 6. Attention (C18)

**6.1 Interrupts.** In an autonomous project, the owner is interrupted only for these five reasons:

| Reason | Raised by |
|---|---|
| 1. `fuse` | `FuseService` opens a fuse of the project or the host (4.7). A trip that needs an owner action always pushes when it opens |
| 2. `external` | A team member's provider permission prompt that reaches the owner through today's `promptOwner` path. A read member's prompt is the exception: C16 leaves it unanswered until its effort cap, and the digest lists it. A member `question` with `interrupt: "external"`, such as a deploy or a message outside the host. A cycle stopped by an unresolved external operation (rule 4 of 3.4) |
| 3. `authority` | A member `question` with `interrupt: "authority"`: more paths, a larger allowance, another repository, or a new credential. The delivery-default offer at the upgrade (5.1) |
| 4. `definition` | Something changes what "done" means: a host receipt refutes an outcome-critical assumption, or the intent check raises an outcome-critical question with no safe default, where guessing would waste cycles. Both come from the objective record (C14), and the intent check's question carries `interrupt: "definition"` |
| 5. `failures` | A standing goal paused with `repeated-failures` (rule 5 of 3.4) |

**Questions.** In autonomous mode, a blocking `question` decision opens only for reasons 2, 3, and 4. The `question` report gains two optional fields: `interrupt`, with the value `external`, `authority`, or `definition`, and `default`, the option the member would take. Both are member claims. A wrong label changes only when the owner sees the question; the host still enforces scope and permissions. An autonomous member's prompt already tells it to propose an assumption instead of asking (C14). A question with `interrupt` opens a decision and pushes. A question with only `default` becomes an open question in the objective record (C14) and goes to the digest. The member's replacement then continues with that default as its recorded answer, labelled an assumption. The host refuses an autonomous question with neither field and gives the member one correction, as it does today for an unauthorized verification plan (`verificationCorrections` in `packages/host/src/team-types.ts`). In supervised mode every question opens a decision, as today.

The permission prompt path keeps its hold rules and its one push per prompt. For every other interrupt, the per-day limit applies to repeats of the same open condition: a repeat on the same UTC day collapses to the push already sent, with `collapseId` `interrupt:<reason>:<subject>`. A trip that only an owner action resolves always sends one push when it opens: a second launch-rate trip in one day (4.6), and an `unmeasurable` trip at a cold start (4.9).

**6.2 What stops pushing.** For a run or a goal cycle in autonomous mode, `Notifier` sends none of the lifecycle events: `goal-started`, `goal-finished`, `goal-stuck`, `goal-cancelled`, and the team forms. `TeamRow` and `GoalRow` gain `autonomous`. Interrupts come from a new `attention.interrupts()` source as the new push event `autonomy-interrupt`. The owner's own sessions keep their session events. `host-storage` stays, because it is a host health alert, not work. Supervised projects keep today's events.

**6.3 The daily digest.** The host renders it from records, without a model. *(My call: a model summary adds claims that the owner would have to check.)* It covers the time since the previous digest. Its sections, per autonomous project, in this order:

1. **Waiting on you**: open questions without an interrupt reason, out-of-scope follow-up ideas (D5), paused or blocked goals, blocked routines, runs that C19 kept from merging, runs and goals that pinned `supervised` for lack of an independent evaluator with the reason, the delivery-default offer, and class B candidates awaiting review (C15).
2. **Verdicts**: evaluator assessments with their evidence handles, each labelled "agent assessment, provisional", and the goals that ended on a provisional `met`.
3. **Delivered**: agent-reported merges and pull requests with the PR, the reviewed head, and the merge commit; whether the outcome ledger's base branch scan saw each one land, which is a host receipt; and reverts seen.
4. **Learning**: class A adoptions and demotions, by identifier.
5. **Spend**: each fuse as a share of its ceiling, the sessions charged at an estimate, warnings at 80%, and trips.
6. **Failures**: failed and excluded cycles, stalls, provider limits and switches, refused launches, and from C16 the refused read requests, truncations, effort-cap hits, and unanswered read-member prompts, as counts with links. None of these interrupts.
7. **Assumptions**: assumptions recorded or refuted that did not change the criteria.

Bounds: at most 50 items per project and 200 per digest. An item holds at most 300 characters of host text, plus identifiers and handles. Member-written text appears only as a title of at most 100 characters, marked as agent text. Overflow shows as a count with a link to the full list. A digest is kept 30 days.

**6.4 Delivery of the digest.** At `autonomy.attention.digestAt` (default 08:00) in `timeZone` (default UTC), the host stores the digest and sends one push on the new event `autonomy-digest`: "Daily digest: N items, M waiting on you." It sends nothing when nothing happened. `GET /api/digest?date=` and `infinite digest [--date D] [--json]` read it, and the web and phone clients show it beside the board. Producers add items with `attention.note(item)` to an `attention_items` table in the evidence store. Its plain columns hold identifiers, enumerations, and times. Its text is encrypted per row (C1).

## Authority and safety

- The honesty rules hold. A provisional `met` is an agent assessment. Only an owner assessment records `achieved`. A merge report stays an agent report.
- The mode, the fuse, and the attention settings are owner settings. Learning never changes them (C9 rule 2, C15 class C).
- No fuse figure, digest, or interrupt enters a member's prompt, context file, or tool result (C9 rule 3).
- Every write here is owner only: the mode, a grant, a close, and the delivery default. Reads follow the role rules of `GET /api/usage`.
- The fuse fails closed: the backstop in `Manager.createOnce` calls `admit` for every team session, so a launch from a caller that skipped `admit` is still charged or refused.
- A standing goal cannot widen itself. Steering cannot expand paths or allowances, as today. A wider need is a reason 3 interrupt.
- A mode change applies to the next run and the next goal, and a change to `supervised` pauses a standing goal at its next cycle boundary. Pause, cancel, and permission revocation still act at once.
- Interrupts and digests carry no secrets, local paths, or URLs beyond the pull request links that runs already record.

## Failure modes

- **Store unavailable.** A process that has loaded an authoritative baseline in this run of the host (4.9) keeps counting launches and reservations in memory and in the baseline file, charges each running session at least its reservation, and `admit` accepts while those stay under the ceilings. After 30 minutes without a successful store read, it opens with cause `unmeasurable`. In a process that has loaded no baseline, `check` reports open and `admit` refuses.
- **Usage lag.** Usage reaches the ledger when a hook fires. The reservation bounds the lag, because a running session counts at least its estimate.
- **Host restart.** The fuse rebuilds its baseline from the baseline file and the store (4.9), and `admit` refuses until it has one. A goal between cycles resumes from its record. A routine without expiry has no window to lose.
- **First start after the upgrade.** No baseline file exists yet. With a readable store, the fuse starts from the store: its fuse tables are empty, and window totals come from the usage rows already recorded. With an unreadable store, `admit` refuses until the store is repaired.
- **Clock jump.** Windows follow the host clock in UTC. A jump past a boundary closes a fuse early, once.
- **Evaluator down.** C14 replaces the evaluator once, then records `inconclusive` with reason `evaluator-unavailable`. Three such cycles without progress pause the goal (reason 5).
- **Interrupt storm.** A repeat of the same open condition pushes at most once per reason and subject per day. A trip that needs an owner action always pushes once. Permission prompts are bounded per run by `maxDecisions`.
- **Push off or misconfigured.** Interrupts and digests stay readable in the clients. When push is on and `config.push.events` lacks `autonomy-interrupt`, the host logs a warning at start.
- **Wrong question label.** The question reaches the owner earlier or later than it should. The host's scope and permission checks are unchanged.

## Delivery order

1. **Mode.** `StoredEnrollment.autonomy`, the API, the CLI, the pins on run, goal, and cycle, and the view. The authority digest test of 3.7. No behaviour changes yet.
2. **Launch-rate fuse.** `FuseService` with launch counts, `check` and `admit` at every caller, the backstop, trips, `close`, `GET /api/fuse`, and the CLI. It needs the evidence store only.
3. **Token, list, and metered ceilings.** Reservations, settlement, grants, and the 80% warning. It needs INF-183 phase 3.
4. **Standing objectives.** The `objective` shape, per-cycle allowances, the classification, stop rules 1, 3, 4, 5, and 7, the bounded record, and the retention change. It needs the C17 goal digest, or it ships with the 16-cycle cap under "Cross-cycle context" in Part 3. It needs no evaluator. Failure by verdict and progress joins when C14 lands.
5. **Until-met goals and open-ended routines.** The `until-met` shape, stop rules 2 and 6, and routines without expiry. It needs C14's verdicts and owner override.
6. **Delivery default.** The `repo init` default, the adoption action, the moved-base baseline check, and the C19 gate in `assertDelivery`. The gate needs C19.
7. **Attention.** The interrupt sources, `question.interrupt`, the notifier suppression, the two push events, the digest with its API, CLI, and client views.

## Acceptance

1. An autonomous project runs a standing `objective` goal with a 30-minute cadence through a host restart. Cycles continue. The record keeps 50 cycles and folds the rest. Clones of older cycles are removed on schedule.
2. An `until-met` goal's third cycle has the composed result `met`. The goal stops as `ready-for-review` with `stopReason: "provisional-met"`, and its status is not `achieved`. The owner records `not-achieved` with `continue: true`, and a fourth cycle starts on the corrected record. An `objective` goal with a `met` result starts its next cycle at its cadence.
3. Three cycles in a row block on failing checks. The goal pauses with `repeated-failures`, one push arrives, and no fourth cycle starts. An owner resume starts a fourth cycle.
4. A standing goal reaches its 17th reviewed cycle, and the cycle starts.
5. A test loop launches 31 members in one hour in one project. The 31st waits at `check`, the run keeps its status with the fuse reason, one push arrives, and running members finish. Below 15 launches in the hour the fuse closes. A second trip that day sends its own push and waits for `infinite fuse close`.
6. A project passes its day list ceiling. `check` reports open, so no new cycle, routine occurrence, or member starts in that project, and other projects continue. A grant reopens launches. At 00:00 UTC the fuse closes. A project whose metered rows pass the day `spentUsd` ceiling trips with cause `spent` while its list dollars are below their ceiling, and subscription rows add nothing to `spentUsd`.
7. A Codex member session with coverage `none` is charged at the fallback estimate and labelled `estimated`.
8. A first `repo init` of a GitHub repository writes a squash merge policy. With `--delivery review` it writes none. An existing enrollment without a policy is unchanged and appears in the upgrade interrupt.
9. A squash merge lands on a base that moved. The mirror contains the commit and the patch ids match, so the next cycle starts from it. With a different patch the run blocks with `delivery-baseline-changed`, and the goal stops with a reason 2 interrupt.
10. After the upgrade adds every new setting, every active routine's authority digest is unchanged.
11. In an autonomous project, a goal's start and finish send no push, and both appear in the next digest. A supervised project's goal still pushes `goal-started`.
12. The host restarts with the evidence store unavailable. With a readable baseline file, `admit` accepts launches only within the remaining ceilings. With no readable baseline, `admit` accepts nothing, the fuse opens with `unmeasurable`, and one interrupt arrives. Running members are unaffected.
13. An open-ended routine starts its 51st occurrence. The record keeps the newest 50 and a folded count of 1, the active occurrence is kept, and the first occurrence's goal is still readable by its id.
14. With session capacity full, ten scheduler passes over one queued member leave the baseline unchanged, and the member is charged once when it starts.

## Owner decisions

Values to confirm:

1. The fuse defaults in 4.2, including the metered-dollar ceilings of 250 USD a day and 1,000 a week per project and 750 and 3,000 per host, and a token unit that leaves out cache reads.
2. The unmeasured estimate of 2 M tokens, 20 list USD, and 5 metered USD per session.
3. The launch-rate rule: it closes on its own below half the limit, and a second trip in one day stays open.
4. A standing goal pauses, rather than blocks, after the objective record's three failed cycles in a row, and a cycle with no verdict counts as failed.
5. The cadence range of 30 to 10,080 minutes, with a default of 1,440.
6. Existing enrollments get the merge default only through the one adoption action.
7. The moved-base acceptance rule of 5.2.
8. The digest at 08:00 UTC, with at most 50 items per project and 200 in all.
9. The derived `evaluators` slot of Part 2.

## Left to the builder

- The rewrite of `GoalService.step` for the state between cycles, and the client labels for per-cycle allowances.
- The SQL behind window sums, and an index on `usage_records` by completion time and project index.
- How `Manager.createTeamSession` receives the project and purpose for the backstop. INF-183 adds `purpose` to the session header.
- Prompt wording for `question.interrupt` and for proceeding on a reversible preference. Team prompts have an 80 KiB limit and byte-sensitive tests.
- Whether the phone shows the digest as its own screen or as a board section.
- Which permission escalation records map to `external` and which to `authority`. Both interrupt.
- The `git patch-id` command and its timeouts for 5.2, run through `teams.commandPrefix`.
- A deploy check: confirm that the evidence store opens on the host before the fuse ships, because the first start after the upgrade has no baseline file.
