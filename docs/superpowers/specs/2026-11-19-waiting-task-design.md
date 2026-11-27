# A blocked task waits alone (INF-325)

Date: 2026-11-19. Status: design for review, fourth draft. An independent reviewer read the first three drafts. Its third look confirmed the superseding rule and found two inexact statements, about the join for the trigger and about resuming a blocked run; this draft corrects both, and those two corrections have not been reviewed again. Nothing is built, and the design recommends not building it yet (see "When to build").

## Intent

On 2026-11-19 the owner accepted this change from the Vercel Board study:

> Design it now and build it when a run goes wider than four. The asking member stops, its task and dependents wait, the other tasks finish, and the project manager answers, replans or asks you.

Board's guide states the rule as "a question doesn't hold a worker": a worker that needs a decision gives its task up, the lead answers, and the rest of the queue keeps moving. In Infinite one worker's question or blocker stops every member of the run.

### The rule

**One task's question stops one task.** The implementer that asked stops. Its task and the tasks that depend on it wait. Every other task keeps its member and is integrated. The project manager resolves the waiting task. A wait that cannot be resolved ends where the same report ends today: automatic recovery when its conditions hold, otherwise a blocked run the owner sees.

## Current state

Observed on `main` at `c96e361e`:

- **A worker's question or blocker becomes a run block.** An implementer, scout, integrator or reviewer that reports `question` blocks the run with `agent-question`, and a `blocked` report blocks it with `agent-blocked` (`packages/host/src/teams.ts:5204-5207`).
- **A recoverable block stops the whole run.** `block` starts automatic recovery for five codes, these two among them (`teams.ts:269`). It aborts the run's commands, sets the run to `planning` under a halt, and waits "after all active members stop" (`teams.ts:2788-2799`). Recovery runs only when its conditions hold: a source member of the current revision, no pending operation, no delivery, permissions neither revoked nor uncertain, tracking in step, a run that is not paused or cancelled, and fewer than two recoveries so far (`teams.ts:2784-2799`).
- **Recovery replans everything not yet integrated.** `startAutomaticRecovery` saves the plan as a continuation, advances the revision and clears `run.tasks` (`teams.ts:2936-2943`). The project manager inspects the retained member workspaces read-only and carries approved work forward in new assignments.
- **Results are integrated in plan order.** An implementer's result waits while any task before it in the plan is not integrated, whether or not it depends on that task (`teams.ts:3458-3460`).
- **An active project manager stops new starts.** While any member of the revision other than an implementer or a permission coordinator is active, no task starts (`teams.ts:3499`). While one is waiting on a decision, the run shows `needs-input` and no task starts (`teams.ts:3500`). Preparing a project manager sets the run to `planning` (`teams.ts:4993`). So the prompt's sentence "Independent teammates can continue while a decision is pending" (`packages/host/src/team-prompts.ts:436`) holds only for members already running.
- **Dependents already wait.** A task starts only when every task it depends on is integrated (`teams.ts:3512`), and checks, review and delivery start only when every task is integrated and no member is active (`teams.ts:3513-3538`).
- **An answered question continues in the same working copy.** A recorded answer starts one replacement member with the earlier prompt plus the answer, in the earlier member's clone, when a worker slot is free (`teams.ts:3467-3478`).
- **A waiting clone is kept.** Member workspace cleanup applies only to a stopped member with an integrated result (`teams.ts:3070-3076`, `:3138-3145`).
- **Width is at most 4**, and a handoff run's ceiling is 2. The member limit is the goal's or handoff's `maxMembers`, otherwise 60 (`packages/host/src/team-types.ts:409-410`), checked when a member is created and not reserved ahead.
- **Scouts are a separate graph.** Discovery scouts live in `run.discovery.tasks` and finish as `complete` under their own scheduler (`teams.ts:3486-3497`).
- **A mission protects a subteam in recovery.** A coordinator's blocker report is refused while a subteam's recovery is `stopping` or `planning` (`packages/host/src/missions.ts:1612-1616`).

### How often it happens

Read-only counts from the live host on 2026-11-19, over the 29 runs it holds (28 created in the last 30 days; 11 at width 1, 11 at width 2, 7 at width 4):

- Completed automatic recoveries from `agent-blocked`: 5. From `agent-question`: 0.
- Tasks not integrated in the plan snapshot those five recoveries saved: 0. Four snapshots hold no task list and one holds two tasks, both integrated.
- Runs blocked now without a completed recovery: 1. It ran at width 1, holds no task, and was blocked by its project manager's own report.

These recoveries and this blocked run contain no task that a worker's question or blocker interrupted, so the rule in this document would have changed none of them. The count cannot see runs removed under retention, and it says nothing about time or money lost or about wider runs.

## Design

### 1. When a task waits instead of the run

An implementer's `question` or `blocked` report opens a wait, in place of a run block, only when all of these hold:

1. The reporter is an implementer of the current revision. Scouts, integrators and reviewers keep today's path.
2. At least one other task of the revision is running, or pending with its dependencies integrated, and does not depend on the reporting task directly or through other tasks.
3. The task has not waited before in this revision.
4. The run has fewer than 4 open waits, no delivery attempt, no stop reason and no halt, and at that moment the member limit has room for a project manager attempt and one replacement. The room is checked, not reserved.
5. The task is not under a live search (INF-317).

Otherwise the report blocks the run as today. `missing-agent-report`, `invalid-no-change` and `wrong-agent-report` always take today's path: they say the member is unreliable, not that it needs an answer.

### 2. The wait record

`run.waits` holds `{ id, taskId, memberId, revision, kind: "question" | "blocked", text, recommendation?, createdAt, managerMemberIds, decisionId?, resolution? }`. The task's status becomes `waiting`, a status tasks and clients already have. The member is stopped with its report kept, and its clone is retained.

Every project manager attempt for a wait carries the wait's id, and so do its successors after an answer, a stall or a provider limit. Stall and provider-limit histories are grouped by wait id, because ordinary project managers have no task id and would otherwise share one allowance.

### 3. Three scheduler rules change

This is the part the first draft missed. Without all three, the other tasks do not keep moving.

1. **Integration follows dependencies.** An implementer's result may be integrated when every task it depends on is integrated, instead of every task before it in the plan. Integration stays one at a time, with the same scope validation and conflict handling. The plan check already refuses overlapping paths between tasks without a dependency order (`packages/host/src/team-workspace.ts:725-730`), which is what makes the order free.
2. **A wait's project manager does not stop new starts.** A member that carries a wait id is exempt from the two rules at `teams.ts:3499-3500`, and preparing it does not set the run to `planning`. Wait managers run one at a time; other open waits queue.
3. **Run status has an order.** `needs-input` while an owner decision is open, otherwise `implementing` while any task is not integrated. Checks, review and delivery are unchanged: they start only when every task is integrated, so an open wait holds them.

### 4. How a wait is resolved

The wait's project manager is read-only. The host confirms that its process stopped and that its working copy is unchanged (`assertMemberReadOnly`) before applying any of its reports:

- **`answer`**: text for the task. The host starts one replacement implementer in the same clone with the earlier prompt plus the answer, recorded as the project manager's answer and never as the owner's.
- **`replace`**: an amended plan. The host validates the complete task graph, not a subset. Tasks that are integrated or running must appear unchanged. The waiting task and its dependents are replaced by tasks with new ids, and any surviving task's dependency on a replaced id is rewritten in the same amendment. Profiles, goal scope and the pinned verification are checked as for a first plan (`teams.ts:5281`, `:5299-5305`). Ledger events for an amendment carry an amendment number, so they do not repeat the identities of the revision's first plan. The replaced member's clone stays as evidence; its edits are carried forward only by a new assignment whose brief says so, as recovery does today.
- **`question`**: a decision for the owner with a recommendation (INF-323). The wait stays open and the other tasks continue. The answer returns to a successor attempt for the same wait.
- **`recover`**: the project manager judges the plan itself wrong.

### 5. When a wait cannot be resolved

A `recover` report, a refused amendment, a manager that exits without a report, a second question from the same task, or a wait with no manager at work for the run's stall window ends the wait. Its source is the original implementer's report, with its original code. From there:

- **Automatic recovery** when `block`'s conditions hold. The work integrated while the task waited stays integrated.
- **A blocked run the owner sees** when they do not: two recoveries already used, permissions revoked or uncertain, tracking out of step, or the member limit reached.

The stall window does not run while an owner decision for the wait is open, or while the run is paused or halted.

**Every change of revision supersedes every open wait.** The task list belongs to one revision, and six paths replace it: an owner steer, an owner continuation (`teams.ts:2127-2129`), a resume that advances the revision, automatic recovery (`teams.ts:2941-2943`), verification recovery (`teams.ts:2179`) and delivery recovery after the base moved (`teams.ts:5415`). In the same save that advances the revision, each open wait of the old revision is marked superseded with the cause, its manager is stopped, its open owner decision is closed as no longer applicable, and a resolution that arrives for it later is refused. This covers the case of several open waits where one ends in recovery: the others end with it. Superseded waits stay in the record as evidence. A cancel does the same without advancing the revision.

**A block that keeps the revision suspends its waits.** When the run blocks without recovery (a deadline reached, `teams.ts:2550-2552`, or recovery not available), no further wait manager starts. The waits stay in the record and nothing acts on them. A blocked run has no resume in place: the owner's resume or continuation advances the revision (`teams.ts:2264-2267`), and the rule above then supersedes them. One existing path keeps a revision across a pause: the owner's halt of a run that waits for input with nothing in flight (`teams.ts:2299-2313`). A run held that way keeps its waits, and they continue when the halt is released.

### 6. Missions

A subteam with an open wait under local resolution gets the protection a subteam in recovery has: a coordinator's blocker report is refused while it lasts. An owner decision from a wait is forwarded to the coordinator like any open decision (`missions.ts:998-1000`), and the coordinator is woken when a wait ends in recovery or a block.

### 7. What clients and records show

- The run view: the task shows `waiting` with the wait's text and, once resolved, how.
- The run's events: "Task T is waiting on the project manager: QUESTION. N other tasks continue." and its resolution.
- The outcome ledger: one event when a wait opens and one when it ends, with the wait id.

### 8. The search-mode design (INF-317, PR #199)

That design already speaks of a search's "hold" on a task, so this document says "wait". The two meet at one point: a task under a live search is not eligible for a wait.

## When to build

The owner's condition is a run wider than four. Width is capped at 4 today, so that condition cannot be met until the cap changes.

A second trigger, measurable from data the host already keeps: **interrupted tasks**. For each automatic recovery from `agent-question` or `agent-blocked`, count the tasks in the continuation's snapshot that were not integrated, leaving out the source's own task and its dependents. Build when that count reaches 10 in 30 days. The count is a proxy: an interrupted task is not proven lost work, because recovery can carry it forward, and a pending task counts even if it had not started.

The snapshot does not name the source (`packages/host/src/team-types.ts:673-682`). The `run.revision-advanced` event does: it carries `sourceMemberId`, `sourceCode` and `fromRevision` (`teams.ts:2942`). The snapshot records the revision that ended and the event records the one that began (`teams.ts:2937`, `:2941-2942`). The count therefore joins them by run id, with the snapshot's `revision` equal to the event's `fromRevision`, keeps the events whose cause is `automatic-recovery`, and maps the member to its task. A recovery whose event is missing, or whose event names no member, counts as unknown, not as zero. `run.recovery.source` cannot serve, because a later recovery overwrites it (`teams.ts:2793`). A block that never reaches a completed recovery leaves no snapshot, so blocked runs are counted from their current task list. Their source is the `sourceMemberId` of the `run.blocked` event (`teams.ts:928`), and a block without one counts as unknown.

On 2026-11-19 the count over the retained history is 0. The join was not needed for that figure: every snapshot's candidate set was already empty.

Two smaller items do not wait for the trigger:

- INF-323 puts a worker's recommendation into the `agent-question` text, so the recovering project manager reads what the member would have done.
- The escalation path sets no `contextFeedback` on the replacement member, unlike the three other replacement paths (`teams.ts:5262-5276` against `:3475`, `:4904`, `:4962`). The note still reaches the member in its prompt. It is a four-line consistency fix for the next change to that code.

## Build plan (when triggered)

1. Types and the pure eligibility function of section 1, with its table as unit tests.
2. The three scheduler rules of section 3, each behind the run's pinned setting, with tests that a task behind a waiting task integrates and that a wait manager does not stop a new start.
3. The wait lifecycle in `TeamService`: open, manager attempts bound to the wait id, `answer`, `question`, every ending of section 5.
4. The amendment: validation over the complete graph, new ids, ledger identities.
5. Mission protection, prompts, the client line, ledger events, documents.

Steps 2 to 4 change the run state machine and go to a strong implementer with independent review. Off by default behind `config.teams.taskWaits`, pinned on the run at creation.

## Risks

- **A second path beside recovery.** Section 5 keeps every ending inside today's two outcomes and bypasses none of recovery's conditions.
- **Integration order.** Rule 1 of section 3 changes when results land for every run that has the setting, not only for runs with a wait. It needs its own tests on dependency chains and on a conflict between independent tasks.
- **A plan amended while members work.** The host validates the whole graph and holds running and integrated tasks unchanged; the prompt does not carry that rule alone.
- **The project manager answers what the owner should.** Its prompt keeps the existing rule: a material product, scope or permission decision is a `question` for the owner. Its answers are recorded as an agent's.
- **The reviewer's "recent reports".** The reviewer prompt lists the last five tasks in plan order (`packages/host/src/team-prompts.ts:197-198`). With integration in dependency order that list is no longer the most recent work. It is orientation and gates nothing; the build relabels it or sorts it by integration time.

## Not verified

- That the search-mode design reads run-wide recovery nowhere else. Only its text on holds was read.
- The count above covers the runs the live host still holds (the oldest is 32 days old). Runs removed under retention are not in it.
- Whether integration in dependency order can meet a conflict that plan order avoided, for example through files generated by a build step outside the planned paths.
