# A blocked task waits alone (INF-325)

Date: 2026-11-19. Status: design for review. Nothing is built, and the design recommends not building it until one of the two triggers in "When to build" is met.

## Intent

On 2026-11-19 the owner accepted this change from the Vercel Board study:

> Design it now and build it when a run goes wider than four. The asking member stops, its task and dependents wait, the other tasks finish, and the project manager answers, replans or asks you.

Board's guide states the rule as "a question doesn't hold a worker": a worker that needs a decision gives its task up, the lead answers, and the rest of the queue keeps moving. In Infinite one worker's question or blocker stops every member of the run.

### The rule

**One task's question stops one task.** The member that asked stops. Its task and the tasks that depend on it wait. Every other task keeps its member, integrates, and is checked as today. The project manager resolves the waiting task. Today's run-wide recovery stays as the path for everything this design does not cover, and as the fallback when a wait cannot be resolved.

## Current state

Observed on `main` at `c96e361e`:

- **A worker's question or blocker becomes a run block.** In `TeamService.consume` an implementer, scout, integrator or reviewer that reports `question` blocks the run with `agent-question`, and a `blocked` report blocks it with `agent-blocked` (`packages/host/src/teams.ts:5204-5207`).
- **A recoverable block stops the whole run.** `block` starts automatic recovery for the codes `agent-blocked`, `agent-question`, `missing-agent-report`, `invalid-no-change` and `wrong-agent-report` (`teams.ts:269`). It aborts the run's commands, sets the run to `planning` under a halt, and waits "after all active members stop" (`teams.ts:2788-2799`).
- **Recovery replans everything not yet integrated.** `startAutomaticRecovery` saves the plan as a continuation, advances the revision and clears `run.tasks` (`teams.ts:2936-2943`). The project manager is told to diagnose the report, inspect the retained member workspaces read-only, and carry approved work forward in new assignments (`teams.ts:2929-2934`). The limit is two recoveries per run (`teams.ts:270`).
- **A project manager's own question already waits alone.** It becomes a decision, the run shows `needs-input`, and the prompt says "Independent teammates can continue while a decision is pending" (`teams.ts:5208-5215`, `packages/host/src/team-prompts.ts:436`).
- **An answered question already continues in the same working copy.** A recorded answer starts one replacement member with the earlier prompt plus the answer, in the earlier member's clone, when a worker slot is free (`teams.ts:3467-3478`).
- **Width is at most 4.** `run.parallelism` is 1 to 4, and 2 for a handoff run.
- **The frequency is low.** On 2026-11-18 the coordinator's ledger held 87 implementer first attempts, of which 2 ended blocked, and 37 runs, of which 3 ended blocked on `agent-blocked`.

So the cost today is bounded by width: one question stops at most three healthy members, and their partial work is retained, not lost. The cost grows with width and with task length.

## Design

### 1. When a task waits instead of the run

A worker's `question` or `blocked` report puts its task into a wait, in place of a run block, only when all of these hold:

1. The reporting member is an implementer or a scout of the current revision.
2. At least one other task of the revision is running, or ready with its dependencies integrated, and does not depend on the reporting task, directly or through other tasks.
3. The task has not waited before in this revision. A second question from the same task goes to run-wide recovery as today.
4. The run holds fewer than 4 open waits, no delivery attempt, no stop reason, no halt, and its member budget has room for the project manager's attempt and one replacement.
5. The task is not under a live search (INF-317). A search releases its task to the single-attempt path first.

Otherwise nothing changes: the report blocks the run and recovery runs as today. `missing-agent-report`, `invalid-no-change` and `wrong-agent-report` always take today's path, because they say the member is unreliable, not that it needs an answer.

### 2. What a wait is

The run record gains `waits`: `{ id, taskId, memberId, revision, kind: "question" | "blocked", text, recommendation?, blocker?, createdAt, resolution? }`. The task's status becomes `waiting`, a status tasks already have. The member is `stopped` with its report kept, and its clone is retained exactly as a blocked member's is today.

Scheduling needs no new rule: a task starts only when its dependencies are integrated, so the dependents of a waiting task do not start. Tasks outside that set run, integrate one at a time, and are checked as today.

### 3. Who resolves it

The host starts one **project manager attempt for the wait**. It is read-only, so it runs beside the working members without contention. It reads the wait, the task's brief, the retained clone, and the integrated head, and reports one of:

- **`answer`**: text for the task. The host starts one replacement member in the same clone with the earlier prompt plus the answer. This is the existing answered-question path, with the project manager as the answerer.
- **`replace`**: new tasks that replace the waiting task and its dependents. The host validates the amended plan with the same checks as a first plan (`validateTeamPlan`: ids, cycles, unknown dependencies, path overlap) over the tasks that are not yet integrated, and refuses an amendment that touches a running or integrated task or their owned paths.
- **`question`**: a decision for the owner, with a recommendation (INF-323). The wait stays open, the other tasks continue, and the owner's answer returns to this attempt's successor.
- **`recover`**: the project manager judges the plan itself wrong. The host falls back to run-wide recovery.

An attempt that exits without a report, reports anything else, or sends an amendment the host refuses also falls back to run-wide recovery. The fallback is the behaviour of today, so the new path can only save work, never strand it.

### 4. When the rest finishes first

If every other task is integrated and the wait is still open, the run stays in `implementing` while the project manager attempt runs, and in `needs-input` while an owner decision is open. Checks and review do not start until no task is waiting, because they run on the whole integrated revision.

### 5. Owner actions and limits

- Steer, pause, cancel, a halt, and a deadline act on the run as today. A steer replans the revision and drops its waits, with an event that says so.
- A wait counts no automatic recovery. A fallback from a wait counts one, as today.
- Budget: the project manager attempt and the replacement member each count as a member attempt (limit 60 a run).
- A wait that stays open for the run's stall window with no project manager attempt at work falls back to recovery.

### 6. What clients and records show

- The run view: the task shows `waiting` with the wait's text and, once resolved, how. Clients already render task status; the wait text is one line on the task.
- The run's events: "Task T is waiting on the project manager: QUESTION. N other tasks continue." and its resolution.
- The outcome ledger: one new event kind for a wait opening and one for its resolution, so the saving can be measured (members that kept working while a task waited).

### 7. The search-mode design (INF-317, PR #199)

That design runs challengers for one task under one run and already speaks of a search's "hold" on a task. The two designs meet at one point: a task under a live search is not eligible for a wait (rule 5 of section 1). No other part of the search design reads run-wide recovery, so neither blocks the other. This document says "wait" throughout to keep "hold" for the search.

## When to build

The owner's condition is width above four. Two measurable triggers, either one:

1. `run.parallelism` may exceed 4.
2. Over 30 days, run-wide recoveries from `agent-question` or `agent-blocked` stopped 10 or more healthy members, counted from the outcome ledger's member stop events (`host` stops in a revision whose block source is another member).

On the 2026-11-18 numbers neither is met: two blocked first attempts in 87, at width 4 or less.

One small change is worth making before then, because it is independent of the rest and INF-323 builds it: a worker's question carries its recommendation into the `agent-question` text, so the recovering project manager reads what the member would have done.

## Build plan (when triggered)

1. Types: `waits` on the run, the project manager's wait reports, and the pure eligibility function of section 1 with its table as unit tests.
2. `TeamService`: open a wait in `consume`, start and consume the project manager attempt, the `answer` and `replace` paths, and every fallback. A strong implementer and independent review: this is the run state machine.
3. Plan amendment validation in `team-workspace.ts`, sharing `validateTeamPlan`.
4. Prompts for the wait attempt; client line; ledger events; documents.

Off by default behind `config.teams.taskWaits`, pinned on the run at creation like the entry tools.

## Risks

- **A second state machine beside recovery.** Mitigated by making every failure of the new path enter the old one, and by refusing the cases that complicate it (delivery in flight, a halt, a second wait on a task).
- **A plan amended while members work.** The amendment may only replace tasks that have not started or are waiting, and must keep owned paths separate from every running and integrated task. The host checks it; the prompt does not carry that rule alone.
- **The project manager answers what the owner should.** Its prompt keeps the existing rule: never choose or approve for the owner. A material product, scope or permission decision is a `question`.

## Not verified

- The exact scheduler lines that start a task once its dependencies are integrated (`TeamService.step` was read for the answered-question path only).
- Whether the outcome ledger can already count healthy members stopped by a recovery, or needs the block source joined by hand.
- The retention of a waiting member's clone when the run's other members finish (`memberMinutes`).
