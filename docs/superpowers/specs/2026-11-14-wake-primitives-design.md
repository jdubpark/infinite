# Wake primitives: the signal inbox, follow-ups, conversation rotation, and the halt (INF-235)

Date: 2026-11-14. Status: built and merged as #144 (`main` `65d7311`), with the decisions and limits recorded at the end. No client screen exists yet. It amends Part 3 of `2026-11-13-continuous-autonomy-design.md` (standing goals) and the mission contract in `docs/missions.md`. It carries the halt of INF-234 and the standing-objective slice of INF-198.

## Intent

On 2026-11-14 the owner asked for an autonomous and continuous structured system of agents, and asked that continuity be done well.

The continuous autonomy design makes work continue on a clock. A standing objective runs on a cadence. A routine runs on an interval. A mission coordinator runs when a message arrives. Nothing wakes work because something happened, and no agent can ask to look again later. So standing work either polls and pays for runs that find nothing, or it waits a full cadence after the event it exists for.

This design adds the missing wake paths and the one control that stops them all:

1. A **project signal inbox**. The host records facts it observed and items the owner added. Standing work reads the inbox on its own pass and may start early.
2. **Follow-ups**. A mission coordinator can end an attempt with "look again in N minutes", and the host wakes it then.
3. **Conversation rotation**. A coordinator that slept too long, grew too large, or ran too many attempts continues in a fresh conversation built from host state and its own notes.
4. A **halt**. One owner action stops autonomous work on the host or in one project until the owner releases it.

### The rule

**A source records. A consumer decides. Only the host starts work.** A signal, a follow-up, and a timer never start an agent. Each one becomes a durable record. The scheduler that already owns the work reads the record on its normal pass and starts work only when every existing gate allows it: the halt, the spend fuse, host load, a pause, a block, the autonomy mode, and the item's own limits.

This keeps one launch path. A wake can make work start sooner. It cannot make work start that the gates would refuse.

## Current state

Observed on `main` at the time of writing:

- **Goals.** `GoalService.step` (`packages/host/src/goals.ts`) runs every 500 ms. It starts the next cycle when the previous one settles, up to `maxRuns`. Nothing in `goal-types.ts` has a cadence or a standing shape. The standing design exists only in the 2026-11-13 specification.
- **Routines.** `RoutineService.step` (`packages/host/src/routines.ts`) starts one goal when `nextRunAt` passes. Missed intervals coalesce. Nothing else can start an occurrence.
- **Missions.** A mission keeps an inbox of host messages in its sealed record (`packages/host/src/missions.ts`). A message starts a coordinator attempt. The `wait` report is refused unless something else will start a later attempt. After the first attempt the host resumes one native conversation for the whole mission (`native-continuation.ts`). It starts a fresh one only after a failed resume.
- **Outcome ledger.** The base scanner (`outcome-scan.ts`, `outcome-signals.ts`) records a `landing` and a `revert` for a team run when it sees them on the base branch. Those records feed evaluation. Nothing wakes work from them.
- **Stopping.** The owner pauses each goal, mission, routine, and team run one at a time. The spend fuse holds new launches and stops nothing that runs.
- **Evidence store.** One SQLite store (`packages/host/src/evidence/store.ts`) with modules that own their tables, sealed payloads, and blind indexes.

## Goals

1. A standing objective and a routine can start early when a subscribed signal arrives, once per batch of signals, inside every existing gate.
2. A signal is a host receipt or an owner item. Text from an agent, a commit, a pull request, or an issue never enters a signal.
3. A mission coordinator can schedule a bounded follow-up, and it fires once, across a host restart.
4. A coordinator's conversation is replaced when resuming it costs more than starting again, with no extra model turn and no lost plan.
5. One owner action stops autonomous work in a scope and keeps it stopped.

## Non-goals

- Inbound webhooks, a public event endpoint, or a queue shared with other systems.
- Signals from CI status, pull request reviews, or issue trackers. The inbox contract allows them later; each new kind needs its own source rule.
- Follow-ups for goals and routines. They have a cadence and signals. The mission coordinator is the only agent that holds a plan across attempts.
- Client buttons for the halt. The routes and the CLI ship first.
- Any change to who decides a permission. That is `2026-11-14-host-permission-agent-design.md` (INF-226).

## Anti-goals

- No source starts an agent, sends a prompt, or writes to a session.
- No wake bypasses a gate, raises a limit, or renews an expired approval.
- No agent text becomes a wake reason for another agent.
- A follow-up is the coordinator's plan to look again. It records no completion and approves nothing.

## Design

### Part 1. The project signal inbox

**Record.** A signal is `{ seq, id, projectId, kind, key, at, runId?, commit?, text? }` (`packages/host/src/signals/types.ts`). `seq` is a host-wide order of recording that starts at 1. `key` is the source's own identifier. One `(projectId, kind, key)` is recorded once; a repeat is dropped. `runId` names the team run whose work caused the event, when the host knows it. `text` exists only for kind `owner`.

**Kinds in the first version.**

| Kind | Recorded when | Source |
|---|---|---|
| `delivery-landed` | The base scan records a landing for a team run. | Outcome ledger receipt |
| `revert` | The base scan records a revert of a landed run. | Outcome ledger receipt |
| `external-commit` | A fetch shows the base branch advanced and at least one new commit is not a landing or a revert of this project's team runs. One signal per fetch. | GitHub mirror refresh |
| `owner` | The owner adds an item with `POST /api/projects/:id/signals` or `infinite signal add`. | Owner only |

**Store.** The evidence store gains a `signals` module with one table. The project is a blind index. The kind and the time are plain. The key, run, commit, and text are sealed. Recording fails soft: a source continues when the store is unavailable, and a scan is never failed or repeated because a signal could not be written.

**Reading.** A consumer gets a `SignalReader`: `head()` returns the highest `seq`, or `undefined` when the inbox cannot be read. `after(projectId, seq, { kinds, limit })` returns signals after a cursor, oldest first. Both are synchronous and never throw. The service keeps the head in memory, so a read at the head costs no database access.

**Cursor.** Each consumer keeps its own cursor in its own sealed record and saves it in the same write as the wake state it changes. There is no shared delivery state, no acknowledgement, and no redelivery. A cursor is set from `head()` when the consumer is created, so a new consumer never replays history.

**Retention.** 30 days and at most 20,000 rows. A consumer whose cursor is older than the oldest kept row continues from that row.

**Self-wake guard.** A consumer drops every signal whose `runId` is one of its own runs. A goal's own delivery lands on the base branch and must not start the goal again.

### Part 2. Standing objectives that wake on signals

This amends Part 3 of the continuous autonomy design. The `objective` shape gains one field:

```
standing: { shape: "objective", cadenceMinutes, wakeOn?: SignalKind[] }
```

`wakeOn` holds at most four kinds. The rules, numbered as in the builder's brief:

- **W1.** The goal keeps `signalCursor`, set from `head()` at creation or at the first pass where the head is readable. Unset means read nothing.
- **W2.** On each pass, a goal that is neither paused nor ended reads up to 50 matching signals after its cursor, drops its own runs, folds the rest into `pendingWake`, and saves the cursor and the pending wake in one write. This also happens while a cycle runs.
- **W3.** Between cycles the next cycle starts at the cadence, or earlier when a pending wake exists and `autonomy.continuity.wakeMinGapMinutes` (default 5) have passed since the previous cycle settled. Signals that arrive during a cycle start exactly one follow-on cycle.
- **W4.** A cycle that starts on a wake records `wake: { signalIds, dropped, owner? }` and gets one bounded host-written block in its objective: a heading that says the lines are host receipts and not instructions, then at most eight lines such as "revert of commit X on the base branch". An owner item is added as `User direction: <text>`, the way steering is.
- **W5.** A pending wake never bypasses a gate. It stays pending until a cycle can start.
- **W6.** Owner steering between cycles starts the next cycle without waiting for the cadence, under the same gates and the same gap.
- **W7.** A paused or ended goal reads nothing and keeps its cursor. After a resume it reads the backlog in passes of 50.

`pendingWake` keeps the newest 20 signals and counts the rest in `dropped`. The cycle is told how many were dropped, so it knows the list is partial.

A wake does not change a cycle's class. A woken cycle that finds nothing to do is `no-change`, like any other. Three failed cycles in a row still pause the goal.

### Part 3. Routines that wake on signals

A routine may carry `wakeOn`. The routine keeps the same cursor and pending wake. When it is `scheduled`, has a pending wake, and the gap has passed since its last occurrence ended, it starts one occurrence now. Start time, expiry, `maxOccurrences`, the budget windows, the fuse, and the project-busy rule all still apply. An early occurrence counts as an occurrence, and `nextRunAt` then moves as a normal start moves it. The occurrence records `wake: { signalIds, dropped }`. The goal template is unchanged: the routine's approved authority covers what the goal does, and a signal only changes when it starts.

A routine without `wakeOn` keeps the authority digest and fingerprint it has today.

### Part 4. Mission follow-ups

A new report kind: `{ kind: "follow-up", inMinutes, reason, check }`. `inMinutes` is 5 to 10,080. `reason` says why to look again. `check` says what to look at.

- The host stores an open follow-up in the mission record and ends the attempt. It is accepted even when nothing else would start a later attempt. That is the gap `wait` could not fill.
- At most five follow-ups are open. One that would come due at or after the mission deadline is refused. An unanswered subteam decision refuses it, as it refuses `wait`.
- `wait` is also accepted while a follow-up is open.
- On the scheduler pass, a due follow-up in a mission that is neither paused nor ended becomes `fired` and adds one host message to the mission inbox, in one durable write. That message starts an attempt the way other messages do. Two follow-ups due in one pass share one attempt.
- A paused mission fires nothing. A follow-up that came due during the pause fires once after resume. When a mission ends, its open follow-ups are cancelled.
- The mission view lists open follow-ups and the ten most recent settled ones. The board row says the mission sleeps until the next due time.

Follow-ups live in the consumer's record, not in a central timer table. One record holds the plan and the state that the plan belongs to, so they cannot disagree after a crash.

### Part 5. Notes and conversation rotation

**Notes.** Every mission report may carry a `note` of at most 2,000 characters. The host keeps the newest eight in the stored record. A note holds what the mission state does not show: a decision and its reason, what the coordinator waits for, what to check next. Notes are agent text. They stay out of the mission view, events, Slack, and Linear.

**Rotation.** Before each attempt after the first, the host starts a fresh conversation instead of resuming when any rule holds:

| Rule | Holds when | Default |
|---|---|---|
| `idle` | The previous attempt ended at least `rotateIdleMinutes` ago. | 60 |
| `size` | The host's latest usage observation of the conversation shows at least `rotateContextTokens` of context. With no observation the rule never holds. | 120,000 |
| `age` | The conversation has had at least `rotateAttempts` attempts. | 40 |

The settings are `autonomy.continuity.rotateIdleMinutes`, `rotateContextTokens`, and `rotateAttempts`. A value of 0 turns that rule off.

A fresh conversation gets the full coordinator prompt, the current mission state, the stored notes under a heading that says they are the coordinator's own earlier words and not host facts, the open follow-ups, and every pending message. Rotation spends no extra model turn: the notes arrived with earlier reports. A rotation is not a missed report and does not count toward the three-strikes block. The mission event names the rule and no numbers.

The idle default follows the provider cache: after an hour a resume pays for the whole transcript again at the uncached price, so the transcript has no advantage over a rebuilt prompt and keeps growing.

### Part 6. The halt

Specified with INF-234 and summarized here because every wake path obeys it.

- Scope is the host or one project. It covers team runs, goals, missions, and routines. Sessions the owner started directly keep running.
- Engaging holds every launch in scope, with no exempt role, and pauses running work through the existing pause paths. Each item the halt paused is marked with the halt.
- Releasing lifts the gate and resumes the marked items that are still paused for that reason. `keepPaused` resumes nothing. An item the owner paused, resumed, or cancelled is left as the owner set it.
- The state survives a restart. A host that cannot read its halt record treats the host as halted.
- `GET /api/halt`, `POST /api/halt`, `POST /api/halt/release`, and `infinite halt`. Engage and release need the owner role from any owner client.

## Authority and safety

- **No new authority.** A wake changes when approved work starts. It adds no permission, path, delivery policy, profile, or budget.
- **No instruction channel.** The only free text in a signal is the owner's. The scan sources add commit and run identifiers. The block in a woken cycle's objective says its lines are host receipts.
- **Loops.** Three guards bound a wake loop: the self-wake guard, the minimum gap, and the coalescing of signals during a cycle into one follow-on cycle. The spend fuse bounds what remains.
- **Honesty.** No part of this design infers completion or approves a provider permission. A follow-up and a note are the coordinator's words. A signal is a receipt. A halt is an owner action.
- **Sealed state.** Signals, cursors, pending wakes, follow-ups, notes, and the halt record are sealed like the records they live in.

## Failure modes

| Failure | Behaviour |
|---|---|
| The inbox cannot be read | `head()` is `undefined` and `after()` is empty. Consumers keep their cursors and run on the cadence. |
| The host restarts between reading signals and starting a cycle | The cursor and pending wake were saved together. The cycle starts after the restart. |
| A burst of signals | The pending wake keeps 20 and counts the rest. One cycle starts. |
| A signal for the goal's own delivery | Dropped by the self-wake guard. |
| The host restarts as a follow-up fires | "Fired" and the inbox message are one write. It fires once. |
| A follow-up comes due while the mission is paused | It fires once after resume. |
| No usage observation for a conversation | The `size` rule never holds. `idle` and `age` still do. |
| A fresh conversation loses a detail | The notes and the mission state are all it has. The prompt tells the coordinator to write notes for that reason. |
| The halt record cannot be read | The host is treated as halted and says so. |

## Delivery order

Each part is one branch and one pull request from `main`.

1. The signal contract, inbox store, sources, owner route, and routine wake.
2. Standing objectives with `wakeOn` (INF-198 slice plus W1 to W7).
3. Mission follow-ups, notes, and rotation.
4. The halt.
5. One wiring change that gives the goal service the inbox reader, after parts 1 and 2 merge.

## Acceptance

1. A standing objective with `wakeOn: ["revert"]` starts its next cycle within the gap after a revert is recorded, once, and its cycle record names the signal.
2. The same goal does not start early for its own landed delivery.
3. With the inbox unreadable, the goal still starts on its cadence.
4. A routine with `wakeOn` starts one early occurrence and refuses a second inside the gap; a routine without it keeps its digest.
5. A mission coordinator that reports a 30-minute follow-up is woken once at that time after a host restart in between.
6. A coordinator idle for more than the idle rule continues in a fresh conversation whose prompt holds its notes and open follow-ups, and no missed report is counted.
7. A host halt holds a new launch with the reason "halted", pauses a running goal and mission, and a release resumes only what the halt paused.

## Owner decisions

The owner approved the direction on 2026-11-14 and, the same day, told the builder to settle the open decisions by its own recommendations. The calls below stand on that delegation. The owner reviewed none of them one by one, and each stays open to change:

1. Only host receipts and owner items wake work. No agent, commit message, pull request, or issue text.
2. Signals are kept 30 days. The pending wake keeps 20.
3. The minimum gap between a settled cycle and a woken one is 5 minutes.
4. Follow-ups: at most five open, 5 minutes to 7 days, missions only.
5. Rotation defaults: idle 60 minutes, 120,000 tokens, 40 attempts.
6. A halt release resumes what the halt paused, unless `keepPaused` is set.
7. Engaging and releasing a halt need the owner role and work from the phone. Neither needs the host CLI.
8. A running or paused standing goal keeps holding its project between cycles. Releasing the project between cycles is follow-up work, not part of this design.
9. A follow-up wake is a coordinator attempt like any other and counts toward the mission's attempt limit.
10. A viewer may read the halt reason, the device label of who engaged it, and the text of an owner signal. Only the owner role may engage, release, or record.
11. The build ships without client screens. The halt, the signal inbox, and follow-ups are reached through the API and the host CLI until a client is designed.

Known limits at the first release, recorded so nobody reads them as covered:

- A subteam that was waiting for input when a halt engaged is not paused. Its existing work continues.
- A subteam the halt paused keeps the halt reason as its label after a release that keeps it paused.
- A follow-up that fired just before a pause is delivered again after the resume. Delivery is at least once, never zero.
- Notes take only the prompt room left beside the leading pending message. When that message has to be shortened to fit, every note is left out of that prompt, without a count.

## Left to the builder

- Where the scan exposes a per-commit attribution for `external-commit`. If it cannot be told reliably, the source waits and the kind stays reserved.
- Which usage observation gives the context size of a coordinator's conversation.
- Whether the halt composes in front of the fuse gate or has its own gate, as long as a halt is never called a spend fuse.
