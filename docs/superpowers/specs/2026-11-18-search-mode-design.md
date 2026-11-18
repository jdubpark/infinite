# Search mode (INF-317)

Date: 2026-11-18. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

One member attempts a task at a time. When its result is wrong, the run learns that after integration, at the final check round, and a correction round repairs the integrated head.

Some tasks exist to make one failing check pass, and the owner already trusts the command that decides it. For such a task, several independent attempts raise the chance that one is right, and the command can pick it with no model's judgement.

Search mode gives such a task up to four attempts from the same commit, on profiles of different model families. The host runs the command on each result before integration. The first result that passes is integrated, and the other attempts are stopped. Nothing is judged, merged, or exchanged between the attempts. Extra attempts cost real work, so by default they start only after the first attempt's result fails, and the mode runs under an owner-set share, inside the run's own limits and the spend fuse.

## Current state

Read in `packages/host/src` on `main` on 2026-11-18:

- **One member per task.** `TeamTask.memberId` names one member, and the dispatcher starts a member only for a `pending` task. `replaceStalledMember`, `switchLimitedMember`, and the `escalate` branch of `consume` each put one new member in the old one's place.
- **A result integrates at once.** For an implementer `result`, `consume` calls `captureMemberResult` and then `integrateMemberResult`. No command runs between the two.
- **Checks run once per revision.** The host runs the run's required checks (`requiredChecks`) in a verification workspace after every task is integrated. A failure starts a correction round (`repair`): a new integrator works on the integrated head, at most twice.
- **No check belongs to a task.** `teamTaskPlanSchema` has no check field and names no criterion.
- **A criterion can name a command.** A criterion of the objective record can hold a `command` check: the digest of a command in the project's configured checks or the run's accepted verification. It can pin up to 8 files whose change voids a met state. The owner writes such a criterion when creating a goal or with a record correction. A goal cycle run pins a digest of its goal's record, with the record's version. No route adds a criterion to a standalone run's record, and no code runs a command for a criterion today.
- **A retry keeps the working copy.** After a stall the host starts one replacement on the same profile in the same working copy. An escalation starts another profile in that working copy, with the first member's partial edits. No retry starts again from the base commit.
- **Limits.** `holdsWorkerSlot` counts implementers and scouts against `run.parallelism`, which is at most 4. `assertBudget` counts every entry in `run.members` against the run's attempt limit. Every member launch passes the spend fuse, which holds a launch-rate limit today.
- **Sources.** An outcome row has a source: `production`, `duel`, `replay`, or `legacy`. The router reads `production` and `duel` rows.
- **Duels have no code.** The duels design specifies a capture that is not integrated, an objective gate in a verification clone, and isolation between two contestants. None of it is built.

A field of a sibling design that is named here is defined in that design.

## Goals

1. Up to four approved profiles of different families work one implementer task from the same commit, and a host-run command decides which result is integrated.
2. The command is one the owner already authorized, it fails before any attempt starts, and no attempt can change the files that define it.
3. The attempts stay independent until one is chosen.
4. A search stays inside the run's approved limits: its parallelism, its attempt limit, its deadline, and the spend fuse.
5. A failure inside a search falls back to a single attempt. A search never blocks a run that a single attempt would not have blocked, and it delays an integration by at most its allowance (Part 7).
6. The records show whether the mode pays, so the owner can keep it, narrow it, or turn it off.

## Non-goals

- A judge, a vote, a score, or a ranking of results. A result passes the command or it does not.
- A merge of two results, or a repair of one result with parts of another.
- Search for any role but implementer, on elevated-risk tasks, or outside goal cycle runs. A handoff run and a mission subteam hold no objective record, and a standalone run's record cannot hold an owner criterion today.
- New commands. A criterion's command is already a configured or accepted check.
- More than two contestants in a duel. Duels stay as designed.
- Choosing which failed result to continue from. When no result passes, the task follows today's rules (Part 4).

## Anti-goals

- **A race to the weakest check.** The first result that passes wins. A check that an attempt can weaken would select the attempt that weakened it.
- **A gate that selects speed.** A command that already passes before the work passes for every result, and the fastest attempt would win for no reason.
- **A loss recorded as a failure.** An attempt that was stopped because another passed first says nothing about its profile.
- **Width as a goal.** A search exists to turn one criterion. The number of attempts is a cost.

## Approaches

**A. Race from the start.** All attempts start together, and the first result that passes wins. The task finishes as fast as its fastest right attempt. Every search pays for attempts that a right first attempt made unnecessary.

**B. Hold all, then choose.** The host waits for every result, gates them all, and integrates one that passed. It pays every attempt in full and delays the task to its slowest attempt. The gate is pass or fail, so waiting cannot find a better result.

**C. Widen after a failure.** One attempt runs, and the host gates its result. The other profiles start only when that result fails or the attempt dies. If attempts pass independently with probability p, C reaches the same success as A with K attempts. C pays about (1 − p) × (K − 1) extra attempts, where A pays close to K − 1. C is slower on exactly the tasks whose first attempt fails.

The design builds one mechanism that runs as C by default and as A when the owner sets `start: "together"`. B is not built. *(My call: nothing measured on Infinite says how often a first attempt passes such a check. If it is often, A wastes most of its spend, and C's records give that number at the price of two command runs for each search.)*

The research supports several attempts only under an exact check. Coverage, the share of problems that some attempt solves, kept rising with more samples where selection without an exact check stayed flat: on MATH, coverage went from 82.9% to 98.44% while majority voting moved from 40.50% to 41.41% (arXiv 2407.21787). Without a verifier, polling several answers at 25 times the cost gave no consistent gain (arXiv 2603.06612). On SWE-bench Verified, some candidate was correct for 69.8% of the issues, a model-based selector delivered 57.4%, and a random pick 45.8% (arXiv 2501.14723). Models agree 60% of the time when both are wrong (arXiv 2506.07962), so attempts on different families are only partly independent. In a model of search on rugged landscapes, a fresh start beat a small change from a weak position, and the small change won from a strong one (Kauffman, Lobo and Macready, 2000). None of this was measured on Infinite. Part 8 measures it.

## Design

### Part 1: Policy and eligibility

The search policy sits in the project team configuration, beside the router's `routing` and the duel policy:

```ts
const teamSearchSchema = z.object({                          // read default:
  mode: z.enum(["off", "live"]).optional(),                    // "off"
  start: z.enum(["after-fail", "together"]).optional(),        // "after-fail"
  share: z.number().min(0).max(0.25).optional(),               // 0.1
  attempts: z.number().int().min(2).max(4).optional(),         // 3, the champion included
  gateMinutes: z.number().int().min(1).max(60).optional(),     // 15
  waitMinutes: z.number().int().min(5).max(120).optional(),    // 60
}).strict();
```

The routine digest hashes the project team configuration, so no key has a schema default, and the code applies each default at read (umbrella C11). The owner saves the policy through the route that saves `routing`. `createRun` pins a copy as `run.search`. The mode is `off` in every project until the owner sets it. *(My call: a search spends the run's own attempts, so autonomy mode does not turn it on.)*

A task plan gains one optional field:

```ts
criterion: z.string().optional(),   // the ID of the one criterion this task must turn
```

The coordinator names a criterion only when the task's result alone is expected to turn it. The host refuses a plan whose `criterion` is not the ID of a criterion in the run's pinned digest. A task that also names a follow-up of the objective record design names one of that follow-up's criteria. The field names a criterion and never a command, so the duels design's rule that check commands stay out of the plan holds.

**The run's record** is the goal's record at the version that `run.goal.record` pins. The pinned digest holds only a label for each check, so the host reads a criterion's command and pinned files from the goal's record at that version. A version that cannot be read fails condition 3.

**Admission.** When the dispatcher prepares a task's first member, the host admits a search for the task only when all of these hold:

1. `run.search.mode` is `live`, and `run.routing` is `auto`, covers `start`, and is not revoked.
2. The task is an implementer task with `normal` risk, on the first attempt of its assignment. The run is a goal cycle run that pins a record digest.
3. The task names a criterion, and no other task of the plan names the same one. In the run's record the criterion is active, its origin is `owner`, its check is a `command` with producer `host`, and it pins at least one file. The command is one of the run's required checks (`requiredChecks`).
4. At the task's `baseCommit` every pinned file has the blob the record holds, and no pinned file matches the task's owned paths.
5. The task has no duel, and its `start` routing decision is not exploratory. *(My call: one experiment per task, as in the duels design.)*
6. The run has no search with challengers running, and has had fewer than two searches. If the run has a deadline, the search's allowance fits before it (Part 7).
7. Searches stay at or below `share` of the project's last 100 applied `start` decisions, and searches are not paused for the project (Part 8).
8. The base run fails (Part 3).

Otherwise the task gets a single attempt as today, and the host counts the first failed condition per day.

*(My call on condition 3: a pinned file is the only statement the host can check of what defines a check. Without one, the fastest way to pass is to weaken the test, and a search would select that result. The owner chose an owner criterion's pinned files. A derived criterion is a model's reading of the owner's text, and it stays out until the records say more.)*

**Widening.** The host starts challengers at the moment Part 4 names, and only when all of these hold then:

9. No other search of the run is `wide`. Part 2 yields at least one challenger, and no provider limit is active for it.
10. A worker slot is free that no ready task needs, and a host session slot is free. The host starts one challenger for each such pair of slots, up to `attempts − 1`.
11. `assertBudget` has room for each challenger, and the spend fuse admits each launch (C13).
12. If the run has a deadline, the rest of the allowance fits before it.

When no challenger can start, the search ends as `exhausted` at once and the task falls back (Part 4).

### Part 2: The contestants

The **champion** is the member the dispatcher prepared, on the profile of the task's `start` routing decision. A **challenger** is another candidate that the decision row stores without a removal. The host takes challengers in the order of `greedyUtility` in that row, highest first, and skips a candidate whose model family is unknown or is already in the search. The family is that of C19. *(My call: two profiles of one family fail together more often than two families do. An unknown family fails closed, as in C19.)*

Every contestant is a normal work member. It has purpose `work`, the task's owned paths, the champion's `baseCommit`, and the prompt of a single attempt on its profile. The host prepares a challenger through `newMember`'s `pinnedProfile` parameter, as the duels design does. No text mentions a search.

### Part 3: The gate

The gate is the criterion's command. It is one of the run's required checks, so the owner authorized it and the host already runs it at the final check round. The host runs it in a verification clone, after the project's setup command, with `gateMinutes` for the command. That is shorter than the limit of the final check round (`teams.checkMinutes`, 60 by default). A gate run holds the run's one workspace operation slot (`operation`).

**The base run.** When conditions 1 to 7 hold, the host writes `task.search` and runs the gate at the task's `baseCommit`, while the champion works. The search goes on only when the command exits non-zero inside `gateMinutes`. A pass, a timeout, or a failed setup ends the search as `abandoned` with that reason, and the champion continues as a single attempt. A result that arrives while the base run is open is captured when that run ends, and it is then gated or integrated as the base run decided. *(My call: a command that passes at the base cannot tell a right result from an empty one. One command run for each search buys that certainty for this exact commit.)*

**A result.** When a contestant reports `result`, the host captures it with `captureMemberResult` and does not integrate it. In the order the captures completed, each capture meets three checks:

- **Scope.** A scope violation fails the contestant (`fail-scope`). It does not block the run while the search goes on. A pinned file lies outside the owned paths (condition 4), so a change to one is a scope violation.
- **Empty.** An unchanged tree fails without a run (`fail-empty`), because the base already failed.
- **Command.** The host runs the gate at the captured commit. Exit 0 inside `gateMinutes` passes. Any other exit, a timeout, or a failed setup fails (`fail-check`).

The first pass ends the search (Part 4). A capture that completes after it is not gated.

The same command runs again on the integrated head at the run's final check round, as today. A gate pass is therefore never the last check of a result, and a command that passed by chance gets a second run before review.

**What the gate cannot see.** The host cannot tell which files define a command. The pinned files are the owner's statement of them. A contestant can still weaken a test that is not pinned and lies inside its owned paths. A single attempt can do the same today, and review is the guard in both cases. A search gives more attempts that chance, and the first pass wins, so the pinned-file rule of condition 3 stays strict (owner decision 4).

### Part 4: Choosing

```ts
// on TeamTask, in the sealed run record (contract C1)
search?: {
  id: string;
  start: "after-fail" | "together";
  state: "admitting" | "armed" | "wide" | "resolved" | "exhausted" | "abandoned";
  criterionId: string; command: string;            // the command's digest
  decisionKey: string; baseCommit: string;
  base?: GateRun;
  contestants: Contestant[];                       // the champion first
  waitUntil?: string;
  winner?: string;                                 // a member ID
  class?: "champion-pass" | "rescued" | "challenger-first" | "none";
  endReason?: string;
};
type GateRun = { result: "pass" | "fail-scope" | "fail-empty" | "fail-check"; ms: number; failures?: number; at: string };
type Contestant = { memberId: string; profileId: string; captured?: true; commit?: string; tree?: string; gate?: GateRun; left?: string };
```

`task.memberId` stays the champion until a result passes.

1. **Armed.** After a failed base run the search is `armed`: the champion works alone. With `start: "together"` the host widens at once when conditions 9 to 12 hold. Otherwise the search goes on as under `after-fail`.
2. **The champion leaves** when it stalls, runs past its runtime limit, or exits without a report. The host stops it. Today's handling of that event, a stall replacement for example, does not start. It waits for the fallback (rule 8).
3. **Widening.** With `start: "after-fail"` the host widens when the champion's result fails its gate, or when the champion leaves. The host then starts the challengers that conditions 9 to 12 allow, and the search is `wide`. The champion's failed result stays captured and is not integrated.
4. **A pass.** The contestant's result enters today's integration path, `task.memberId` becomes that contestant, and the search is `resolved`. The host stops every other contestant that is still running, with stop reason `host`, and starts no replacement.
5. **A challenger leaves** when it stalls, hits a provider limit, exits without a report, fails preparation, opens a provider permission prompt, or reports `question`, `blocked`, or `escalate`. The host stops it and starts no replacement.
6. **The wait.** It starts when the champion's result has failed its gate or the champion has left, and it lasts `waitMinutes`. A capture that completes inside the wait is gated, even when its gate run ends later.
7. **Exhausted.** The search ends as `exhausted` when every contestant has failed its gate or left, or when the wait ends with no capture left to gate. The host stops the challengers that are still running.
8. **Fallback.** After `exhausted` the task follows today's rules for the champion, as if no search had run. A result that failed the command, or an empty one, is handled as `consume` handles a result today: it is integrated when it has a commit, and it meets the final check round and its correction rounds. A scope violation blocks the run. A stall, a passed runtime limit, or an exit without a report gets today's handling of that event.
9. **Abandoned.** A `question`, `blocked`, or `escalate` report from the champion, a provider limit on the champion, a failed preparation of the champion, a steer, a pause, a cancel, a routing revocation, or a revision advance abandons the search. So does any other event that blocks the run today. The host stops every challenger, and today's rule for that event applies at once.

*(My call on rule 9: a question or a blocker says the task itself may be wrong, and more attempts at a wrong task are waste. A limit is no fault of the attempt, and today's limit switch already carries its work to another profile.)*

A contestant that was not integrated becomes removable `memberMinutes` after the search ends, as in the duels design.

### Part 5: Isolation

The isolation rules of the duels design (Part 5) apply to a search, with `task.search` in place of `task.duel`:

- The host removes `task.search` from every task in every member's context file, continuation snapshots included.
- `memberReports` and the blackboard's `report` entries cover a contestant only after its result is integrated.
- The blackboard hides a contestant's own entries from other members until then, and the host posts no entry about a search.
- A contestant's prompt, context file, and tool results name no other contestant, no gate result, and no search (C9 rule 3).
- `task.criterion` is part of the plan and stays visible. It names the task's target and says nothing about a search.

One limit remains, and the duels design names it: member clones of one run share a directory and an agent identity, so no operating-system boundary stops a contestant from reading a sibling's clone. A contestant is not told that a sibling exists. Part 8 counts searches in which two captured trees are equal, as a tripwire.

### Part 6: Records

The host writes `task.search` first. It then emits `search.started`, `search.widened`, `search.captured`, `search.gated`, `search.resolved`, or `search.abandoned`. These kinds use this design's own prefix, as umbrella contract C2 allows. `search.resolved` closes a search in state `resolved` or `exhausted`, and the outcome ledger's projector reads it. It carries the class and, for each contestant, the member ID, the gate result, and whether the search selected its result. A projector that this design registers derives the durable row:

```sql
CREATE TABLE searches (
  search_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL, decision_key TEXT NOT NULL,
  project_ref TEXT NOT NULL, start TEXT NOT NULL,
  state TEXT NOT NULL, end_reason TEXT, class TEXT,
  contestants INTEGER NOT NULL, widened INTEGER NOT NULL DEFAULT 0,
  champion_identity TEXT NOT NULL, winner_identity TEXT,
  started_at TEXT NOT NULL, ended_at TEXT,
  encrypted_payload TEXT NOT NULL
);
```

The payload holds the task ID, the criterion ID, the member IDs, config IDs, every gate run, tree IDs, diff sizes, and costs. The row holds no run text. The host keeps the last 4,096 characters of each gate run's output in the run record. The team view does not carry them, and `infinite search show` prints them for the owner.

`failures` on a gate run is the failure-line count of the check-output scanner (INF-314), when that scanner is on `main` and finds failure lines. It is absent otherwise. No rule of this design reads it. Part 9 says why it is recorded.

**Outcome rows.** The ledger's `experiment_ref` holds the search ID on every contestant's row of a search that passed its base run, and those rows have source `search`:

| Contestant | Disposition | Counted |
|---|---|---|
| Its result passed and was integrated | `integrated` | yes |
| Its result failed scope | `out-of-scope` | failure |
| Its result failed the command, or was empty, and was not integrated | `gate-failed` | failure |
| Its result was captured after another passed | `not-chosen` | excluded: `search` |
| The host stopped it because the search ended | `host-stop` | excluded: `host` |
| It left for its own reason | its own disposition | as today |

After a fallback the champion's row takes the disposition that today's rules give it, and its failed gate stays in the `searches` row. A search that was abandoned at its base run leaves the champion a `production` row. A challenger's row has `inherited` 0, because it began at the base commit.

The router does not read `search` rows in this version. *(My call: in a `search` row, `integrated` means the result passed a command before integration. No production row was asked to do that, so the two rates differ in meaning, and C6 keeps them apart. A champion that passed alone is a `search` row too. If only the champions that failed left `production`, the production rate of their profiles would rise for no reason.)*

### Part 7: Budget, slots, and time

**Budget.** Every contestant has purpose `work` (C8). It counts against the run's attempt limit in `assertBudget` and against the goal's member count, and its launch passes the spend fuse like any member's. The learning budget pays nothing. A challenger that the attempt limit refuses or the fuse holds is not started, and the search goes on with the others. A search never waits for a fuse.

**Worker slots.** Each contestant holds a normal worker slot inside `run.parallelism`. Condition 10 gives a challenger only a slot that no ready task needs. A task that becomes ready later waits for a slot, as it waits today behind any running implementer. *(My call: unlike a duel's challenger, a search contestant is work the owner asked for, so the host does not stop it for a later task.)*

**Time.** A search's **allowance** is the most it adds before the champion's result would have integrated alone: one gate run for the champion's result, the wait, and one gate run for each challenger. A gate run counts as 20 minutes for the clone and the setup command, plus `gateMinutes`. With the defaults and three attempts that is 165 minutes. The default wait equals a member's one-hour runtime limit, so the wait never stops a challenger that the host would let work. Integration follows plan order, so later results wait too while their members keep working. A run has at most two searches. Choosing `live` is the owner's authorization for that delay.

`assertBudget` stops a goal run at its `deadlineAt`. The host therefore requires the allowance to fit before the deadline at admission, again at widening, and again when the champion's result arrives. A search that no longer fits is abandoned.

**The operation slot.** A base run starts only when the run has no workspace operation waiting. A gate run of a captured result waits its turn like any capture. Production work that arrives during a gate run waits until it ends.

### Part 8: Measures and the brake

Each ended search that passed its base run has one class, from host records alone:

- `champion-pass`: the champion's result passed its gate.
- `rescued`: the champion's result failed its gate, or the champion left, and a challenger's result passed.
- `challenger-first`: a challenger's result passed while the champion was still working. Only `start: "together"` can produce it. What the champion would have produced is unknown.
- `none`: no result passed.

`infinite search status` shows, per project: admissions and the reasons that ended them at the base run; searches by class; the share of widened searches that were `rescued`; the cost of all contestants beside the champion's cost; the minutes a search added; gate failures by kind; challengers that left, by reason, and challengers that the wait stopped; and the count of searches with two equal captured trees.

Two of these numbers answer questions that nothing answers today. The share of `champion-pass` is how often a first attempt turns such a check. The `rescued` share of widened searches is how often a fresh start on another family passes where the first attempt failed. The outcome ledger already holds the comparison for the second: how often a correction round resolves.

**The brake.** Searches pause for a project when it has 10 or more widened searches and the last 10 hold fewer than 2 `rescued`. The owner resumes them, and the count starts again. A `challenger-first` search does not count as a rescue, because the champion might have passed. *(My call: below one rescue in five, the extra attempts mostly fail where the first one failed, and today's correction round is the cheaper path. Under `start: "together"` the same rule pauses a project whose first attempts mostly pass.)*

### Part 9: What stays open

Two rules are left out on purpose, because no measurement on Infinite supports them yet:

- **Repair a near miss, restart a clear failure.** Published search results favour a small change to a strong result and a fresh start from a weak one. This design restarts after every failed gate and falls back to a correction round only when no restart passes. A rule that sends a near miss straight to the correction round needs a host measure of nearness. The candidate is the failure-line count of the champion's gate run beside the base run's count. Part 6 records both, so the records can show whether fewer failures than the base predicts that a correction round resolves.
- **The router's use of search results.** A gated pass beside a gated failure on the same task is a paired fact with no judge in it. The duels design's pair statistic could count it as a gate decision. Whether it should is the owner's decision 5.

### Part 10: Surface

- **CLI.** `infinite repo init --search off|live [--search-start after-fail|together] [--search-share N]`. `infinite search status [PROJECT]` shows the mode, the pause state, the share, skip counts, and the measures of Part 8. `infinite search show SEARCH_ID`, `pause PROJECT`, and `resume PROJECT`.
- **API.** `GET /api/search/projects/:id` and `/api/search/:id` serve owner, controller, and viewer. Pause and resume need the owner. `PUT /api/projects/:id/team` carries `search`. The team view shows a task's search state, its contestants, and their gate results, without gate output.
- **MCP.** Nothing new. A contestant sees no new tool, field, or report kind.
- **Prompts.** The coordinator prompt gains one sentence about the `criterion` field, only in a run whose search mode is `live` and whose pinned record holds a host `command` criterion. It changes the coordinator's prompt version (C7), so the ledger keeps the rows before and after it apart.

## Authority and safety

- **Honesty.** A gate pass selects which reported result enters integration. It records nothing as complete, and the final check round, review, verdicts, and delivery apply unchanged. The selection rests on a host receipt and never on the agent that did the work.
- **Authorized commands.** The gate runs only a command that the project's configured checks or the run's accepted verification already hold. It runs that command more often and at more commits. Captured results are unreviewed member code, as the integrated head is when today's final check round runs it.
- **Fixed limits.** A search adds no worker beyond `run.parallelism`, no attempt beyond the run's attempt limit, no permission decision, and no owner prompt. Every launch passes the spend fuse.
- **Approved profiles.** A challenger comes from the candidates of the task's own routing decision, so it passed the router's eligibility rules, the contributor rule included.
- **Prompts (C9 rule 3).** A contestant's prompt does not change, and no search record reaches a member's prompt, context file, or tool result (Part 5).
- **Learning (C9 rule 2).** No learned value decides whether a search starts, widens, or ends. The share, the attempt count, and the brake are fixed numbers and counts.

## Failure modes

| Situation | Behaviour |
|---|---|
| The base run passes, times out, or fails setup | The search is abandoned with that reason. The champion continues as a single attempt. |
| The champion's result passes its gate | It integrates. Under `after-fail` no challenger ever started. |
| No challenger can start at widening | `exhausted` at once, then the fallback. |
| A challenger stalls, hits a limit, or opens a permission prompt | It leaves (Part 4). The search goes on without it. |
| Every result fails, or the wait ends | `exhausted`. The task follows today's rules for the champion. |
| The command fails fast at the base and runs past `gateMinutes` on a right result | Every gate run fails by time. The search is `exhausted`, the fallback applies, and the brake counts it. |
| The winner's commit conflicts at integration | The run blocks with `integration-conflict`, as today. |
| The command passes by chance on a wrong result | The final check round runs it again on the integrated head, and review follows. |
| A pinned file changed before the task's base | Condition 4 fails. No search starts. |
| The host restarts during a search | It resumes from `task.search`. Events and the `searches` row are idempotent by key, no second challenger starts for a contestant, and an interrupted gate run starts again. |
| The evidence store is unavailable | No search starts. An open search finishes in the run record, and reconciliation writes its row later. |
| Searches are paused, or the share is used up, during a search | The open search finishes. The next one does not start. |

## Changes this design asks of its siblings

- **Team plan schema.** `teamTaskPlanSchema` gains `criterion`.
- **Outcome ledger design.** A fifth source, `search`. `search.resolved` sets `out-of-scope`, `gate-failed`, and `not-chosen` as `duel.resolved` does, and `not-chosen` under a search has exclusion `search`. A challenger's `attempt_index` counts it after the champion, in start order.
- **Umbrella.** Its table of designs gains this one. In C6 the list of sources gains `search`. In C11 the search policy joins the settings inside the routine digest, for the duel policy's reason: it changes who does the work.
- **Duels design.** Its conditions 3 and 8 count a search as an experiment on the task and as an open duel of the run.
- **Evidence router design.** The choice does not change. A pure helper of the router module returns a decision's candidates in the order of Part 2.
- **Objective record design.** Nothing changes. A criterion still never adds a command, and this design reads `pinned` as that design uses it: the files that define a check.

## Delivery order

Each phase is its own pull request.

1. **The search engine.** A pure module that applies admission, widening, a gate result, a leave, and the wait to `task.search`, with a seeded simulator of its orders. Nothing imports it.
2. **A gate run at a commit.** A verification clone at a captured commit, the base run, and their use of the operation slot. The duels design's gate needs the same piece.
3. **Live search.** The policy and its pin, the `criterion` field, admission, challengers, hold and choose, the fallback, the `searches` table, and the ledger source.
4. **Surface, measures, and the brake.**

Phase 3 needs the router in `auto`, and owner criteria with `command` checks and pinned files in goal records. Both are on `main`. It does not need the eval identity, a judge, the learning budget, or the assumption tests of the objective record design.

## Acceptance

1. With mode `off`, generated prompts, scheduling, and stored records match today's.
2. A plan whose `criterion` names no criterion of the run's pinned digest is refused. A plan with a valid `criterion` and mode `off` runs as today. A task whose criterion is derived, or pins no file, gets a single attempt, and the status counts condition 3.
3. With conditions 1 to 7 true and a command that fails at `baseCommit`, the search is `armed` and one implementer works. With a command that passes at `baseCommit`, the search is abandoned and the task runs as today.
4. Under `after-fail`, a champion result that passes its gate integrates, and no second implementer ever starts for the task. A champion result that fails its gate is not integrated, and challengers start on the champion's `baseCommit`, each of a family that no other contestant has.
5. Under `together`, challengers start when the base run fails.
6. The first result that passes its gate is integrated, `task.memberId` names its member, and every other running contestant is stopped with no replacement. A capture that completes after the pass is not gated, and its row is `not-chosen`.
7. A result that changes a pinned file, or a path outside the task's owned paths, fails with `fail-scope` and does not block the run while the search goes on.
8. When every result fails, or the wait ends, the champion's captured result integrates as today and the final check round runs. When the champion stalled and no challenger passed, today's stall replacement starts then, and not before.
9. A `question` from the champion abandons the search, stops every challenger, and blocks the run as today.
10. No search starts when the run has had two searches, when the allowance does not fit before the deadline, or when the share is used up. Each case counts its condition. When every free worker slot has a ready task at widening, no challenger starts, and the search is `exhausted`.
11. After a resolved search, a later member's context file has no `search` field and no report of a contestant that was not integrated.
12. A restart in each state resumes the search with the same contestants, at most one gate run in flight, and one `searches` row.
13. With 1 `rescued` in a project's last 10 widened searches, the next task that meets every other condition gets a single attempt, and the status shows the pause.
14. Every contestant row of a search that passed its base run has source `search`, and no production cell counts it. The champion of a search that was abandoned at its base run has a `production` row.

## Owner decisions

Each value below was my call.

1. **When challengers start.** `after-fail` by default, `together` as an option. `together` finishes sooner and pays for challengers on every search.
2. **The numbers.** A share of 0.1 with a ceiling of 0.25, three attempts with a ceiling of four, two searches per run, 15 minutes for a gate run, and a wait of 60 minutes. With the defaults a search may delay an integration by up to 165 minutes.
3. **Slots.** A challenger takes only a slot that no ready task needs, and keeps it when a task becomes ready later. The other choice stops the newest challenger for that task.
4. **Pinned files and origin.** Only an owner criterion with at least one pinned file opens a search. Without the rule, more criteria qualify, and a result that weakens the test can win.
5. **Evidence.** `search` rows stay out of the router, and a gated pass beside a gated failure is not counted as a pair. Counting it would add judge-free pairs to the duels design's statistic.
6. **The brake.** Pause below 2 rescues in the last 10 widened searches.
7. **Permission prompts.** A challenger leaves at its first provider permission prompt, as a duel's challenger does. The other choice lets it use the run's delegated permission reviewer under the run's cap.
8. **Autonomy.** The mode stays `off` in an autonomous project until the owner sets it. Duels default to `live` there.
9. **The plan field.** A coordinator, which is a model, names the criterion a task must turn. The host checks everything else. Without the field the host cannot tell which task a failing criterion belongs to.

## Left to the builder

- The Git commands that build a verification clone at a captured commit, and how one clone is reused between the gate runs of a search without carrying a file from one result to the next. A new command form needs an entry in the server's owner-approved team command list.
- How base runs, captures, and gate runs use the run's one operation slot under the rules of Part 7.
- How `TeamService` reads the goal's record at the pinned version. The goal service owns that record.
- The order of candidates that have no stored utility, and the family of a profile whose family is unknown.
- The wording of the coordinator prompt's sentence about `criterion`.
- The layout of `infinite search status` and the client views.
