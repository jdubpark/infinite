# Search mode (INF-317)

Date: 2026-11-18. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

One member attempts a task at a time. When its result is wrong, the run learns that after integration, at the final check round, and a correction round repairs the integrated head.

Some tasks exist to make one failing check pass, and the owner already trusts the command that decides it. For such a task, several independent attempts raise the chance that one is right, and the command can pick it with no model's judgement.

Search mode gives such a task up to four attempts from the same commit, on profiles of different model families. The host runs the command on each result before integration. The first result that passes is integrated, and the other attempts are stopped. Nothing is judged, merged, or exchanged between the attempts. Extra attempts cost real work, so by default they start only after the first attempt's result fails, and the mode runs under an owner-set share, inside the run's own limits and the spend fuse.

A measuring mode comes first. It records how often a first result fails its check, and it starts no extra attempt.

## Current state

Read in `packages/host/src` on `main` on 2026-11-18:

- **One member per task.** `TeamTask.memberId` names one member, and the dispatcher starts a member only for a `pending` task. `replaceStalledMember`, `switchLimitedMember`, and the `escalate` branch of `consume` each put one new member in the old one's place.
- **A result integrates at once.** For an implementer `result`, `consume` calls `captureMemberResult` and then `integrateMemberResult`. No command runs between the two.
- **Checks follow integration.** The host runs the run's required checks (`requiredChecks`) in a verification workspace when every task is integrated, and again after each correction round. A failed check, or a review that requests changes, starts a correction round (`repair`): a new integrator works on the integrated head, at most twice. A check that runs past its limit, or that fails again on an unchanged head, blocks the run instead.
- **No check belongs to a task.** `teamTaskPlanSchema` has no check field and names no criterion.
- **A criterion can name a command, and cannot yet pin a file.** A criterion of the objective record can hold a `command` check: the digest of a command in the project's configured checks or the run's accepted verification. The owner adds one when creating a goal or with a record correction. The stored criterion can hold up to 8 `pinned` files, whose change voids a met state. The owner's criterion input has no `pinned` field, so no criterion pins a file today. A goal cycle run pins a digest of its goal's record, with the record's version, when the objective switch is on. No route adds a criterion to a standalone run's record, and no code runs a command for a criterion.
- **A retry keeps the working copy.** After a stall the host starts one replacement on the same profile in the same working copy. An escalation starts another profile in that working copy, with the first member's partial edits. No retry starts again from the base commit. A member has no runtime limit: the host replaces it only when it shows no activity.
- **One workspace operation at a time.** A run has one workspace operation at a time (`operation`). The host records the operation's intent before it starts. After a host restart an unfinished operation is not replayed: the run blocks. An interrupted check is released only by an explicit reconciliation (`reconcileVerification`), which needs a quiet run and a process census that sees no process of that check.
- **Limits.** `holdsWorkerSlot` counts implementers and scouts against `run.parallelism`, which is at most 4. `assertBudget` counts every entry in `run.members` against the run's attempt limit, and a goal run that reaches the limit stops. The router's `spareAttempts` is that limit, less the members so far, less one for each task not yet integrated, less three. Every member launch passes the spend fuse, which holds a launch-rate limit today.
- **Sources.** An outcome row has a source: `production`, `duel`, `replay`, or `legacy`. The router reads `production` and `duel` rows.
- **Duels have no code.** The duels design specifies a capture that is not integrated, an objective gate in a verification clone, and isolation between two contestants. None of it is built.
- **The ledger is small.** On 2026-11-18 the live host's ledger held 88 implementer rows from 31 runs since 2026-10-18. 65 of them came from a one-time backfill of runs whose records still existed. Of 87 first attempts, 83 were integrated, 2 reported a blocker, 1 escalated, and the host stopped 1. No row is a stall, a missing report, or a provider limit. 11 correction rounds ran in 9 runs, and 10 of them were backfilled without a cause or an end state. Nothing in the ledger says how often a first result fails one named check.

A field of a sibling design that is named here is defined in that design.

## Goals

1. Up to four approved profiles of different families work one implementer task from the same commit, and a host-run command decides which result is integrated.
2. The command is one the owner already authorized, it fails before any attempt starts, and no attempt can change the files that the owner pinned for it.
3. The attempts stay independent until one is chosen.
4. A search stays inside the run's approved limits: its parallelism, its attempt limit, its deadline, and the spend fuse. It takes no attempt that the run's remaining tasks, its review, and its correction rounds are counted to need.
5. A search that ends without a pass releases the task to today's single-attempt path. It holds a task's integration for at most its allowance (Part 7). The one exception is a host restart during a gate run, which blocks the run as an interrupted check does today (Failure modes).
6. The records show whether the mode pays before it spends, so the owner can keep it, narrow it, or turn it off.

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

The design builds one mechanism that runs as C by default and as A when the owner sets `start: "together"`. B is not built. A measuring mode, which gates the first result and starts nothing, is delivered before either. *(My call: the ledger holds 87 first attempts, and none of them says how often a first result fails a named check. If first results mostly pass, A wastes most of its spend and C rarely fires. The measuring mode gives that number for two command runs a task.)*

The research supports several attempts only under an exact check. Coverage, the share of problems that some attempt solves, kept rising with more samples where selection without an exact check stayed flat: on MATH, coverage went from 82.9% to 98.44% while majority voting moved from 40.50% to 41.41% (arXiv 2407.21787). Without a verifier, polling several answers at 25 times the cost gave no consistent gain (arXiv 2603.06612). On SWE-bench Verified, some candidate was correct for 69.8% of the issues, a model-based selector delivered 57.4%, and a random pick 45.8% (arXiv 2501.14723). Models agree 60% of the time when both are wrong (arXiv 2506.07962), so attempts on different families are only partly independent. In a model of search on rugged landscapes, a fresh start beat a small change from a weak position, and the small change won from a strong one (Kauffman, Lobo and Macready, 2000). None of this was measured on Infinite. Part 8 measures it.

## Design

### Part 1: Policy and eligibility

The search policy sits in the project team configuration, beside the router's `routing` and the duel policy:

```ts
const teamSearchSchema = z.object({                          // read default:
  mode: z.enum(["off", "measure", "live"]).optional(),         // "off"
  start: z.enum(["after-fail", "together"]).optional(),        // "after-fail"
  share: z.number().min(0).max(0.25).optional(),               // 0.1
  attempts: z.number().int().min(2).max(4).optional(),         // 3, the champion included
  gateMinutes: z.number().int().min(1).max(60).optional(),     // 15
  waitMinutes: z.number().int().min(5).max(120).optional(),    // 60
}).strict();
```

The routine digest hashes the project team configuration, so no key has a schema default, and the code applies each default at read (umbrella C11). The owner saves the policy through the route that saves `routing`. `createRun` pins a copy as `run.search`. The mode is `off` in every project until the owner sets it. *(My call: a search spends the run's own attempts, so autonomy mode does not turn it on.)*

**Modes.** `measure` admits a search, runs the base run, and gates the first result after it is integrated as today. It holds nothing, starts no challenger, and changes no outcome row (Part 3). `live` holds the first result for its gate, and widens.

A task plan gains one optional field:

```ts
criterion: z.string().optional(),   // the ID of the one criterion this task must turn
```

The coordinator names a criterion only when the task's result alone is expected to turn it. The host refuses a plan whose `criterion` is not the ID of a criterion in the run's pinned digest. A task that also names a follow-up of the objective record design names one of that follow-up's criteria. The field names a criterion and never a command, so the duels design's rule that check commands stay out of the plan holds.

**The run's record** is the goal's record at the version that `run.goal.record` pins. The pinned digest holds only a label for each check, so the host reads a criterion's command and pinned files from the goal's record at that version. A version that cannot be read fails condition 3.

**Prerequisite: the owner's pins.** The objective record design lets a criterion pin files, and it records each file's blob when the criterion is written. The owner's criterion input does not accept `pinned` yet. Search needs that input on `criterion.add` and `criterion.edit`: a list of up to 8 repository paths. It is an amendment to step 2 of that design. No search is admitted until it exists, because condition 3 cannot hold.

**Admission.** When the dispatcher prepares a task's first member, the host admits a search for the task only when all of these hold:

1. `run.search.mode` is `measure` or `live`, and `run.routing` is `auto`, covers `start`, and is not revoked.
2. The task is an implementer task with `normal` risk, on the first attempt of its assignment. The run is a goal cycle run that pins a record digest.
3. The task names a criterion, and no other task of the plan names the same one. In the run's record the criterion is active, its origin is `owner`, its check is a `command` with producer `host`, and it pins at least one file. The command is one of the run's required checks (`requiredChecks`).
4. At the task's `baseCommit` every pinned file has the blob the record holds, and no pinned file matches the task's owned paths.
5. The task has no duel, and its `start` routing decision is not exploratory. *(My call: one experiment per task, as in the duels design.)*
6. The run has no search that is `wide`, and has had fewer than two searches. If the run has a deadline, the search's allowance fits before it (Part 7).
7. Searches stay at or below `share` of the project's last 100 applied `start` decisions, and searches are not paused for the project (Part 8).
8. The base run fails (Part 3).

Otherwise the task gets a single attempt as today, and the host counts the first failed condition per day.

*(My call on condition 3: a pinned file is the only statement the host can check of what defines a check. Without one, the fastest way to pass is to weaken the test, and a search would select that result. The owner chose an owner criterion's pinned files. A derived criterion is a model's reading of the owner's text, and it stays out until the records say more.)*

**Widening.** Only a `live` search widens. The host starts challengers at the moment Part 4 names, and only when all of these hold then:

9. No other search of the run is `wide`. The champion's family is known. Part 2 yields at least one challenger, and no provider limit is active for it.
10. A worker slot is free that no ready task needs, and a host session slot is free. The host starts one challenger for each such pair of slots, up to `attempts − 1`.
11. The run keeps its reserve: with the challengers counted as members, `spareAttempts(run)` is 0 or more. The host checks this before it prepares a challenger. It never asks `assertBudget` for an attempt that the limit would refuse, because a refused attempt stops a goal run. The spend fuse admits each launch (C13).
12. If the run has a deadline, the rest of the allowance fits before it.

### Part 2: The contestants

The **champion** is the member the dispatcher prepared, on the profile of the task's `start` routing decision. A **challenger** is another candidate that the decision row stores without a removal. The host takes challengers in the order of `greedyUtility` in that row, highest first, and skips a candidate whose model family is unknown or is already in the search. The family is that of C19, under which no family differs from an unknown one. A champion of unknown family therefore gets no challenger (condition 9). *(My call: two profiles of one family fail together more often than two families do.)*

Every contestant is a normal work member. It has purpose `work`, the task's owned paths, the champion's `baseCommit`, and the prompt of a single attempt on its profile. The host prepares a challenger through `newMember`'s `pinnedProfile` parameter, as the duels design does. No text mentions a search.

### Part 3: The gate

The gate is the criterion's command. It is one of the run's required checks, so the owner authorized it and the host already runs it at the final check round. The host runs it in a gate clone: a verification clone at one commit, after the project's setup command. The command gets `gateMinutes`, or the limit of the final check round (`teams.checkMinutes`) when that is shorter.

**A gate run is a workspace operation.** It holds the run's one operation slot, and the host records its intent before it starts, as it does for a check today. It is a new operation kind, `gate`. After a host restart an interrupted gate run is handled as an interrupted check is today, and it is never replayed (Failure modes).

**The base run.** When conditions 1 to 7 hold, the host writes `task.search` in state `admitting` and runs the gate at the task's `baseCommit`, while the champion works. The search goes on only when the command exits non-zero inside its limit, and it is then `armed`. A pass, a timeout, a failed setup, or an abort for the run's own work (Part 7) ends the search as `abandoned` with that reason, and the champion continues as a single attempt. A `result` that arrives while the base run is open is captured when that run ends, and it is then gated or integrated as the base run decided. Any other event that ends the champion's attempt in that time abandons the search. *(My call: a command that passes at the base cannot tell a right result from an empty one. One command run for each search buys that certainty for this exact commit.)*

**A result in `live` mode.** When a contestant reports `result`, the host captures it with `captureMemberResult` and does not integrate it. In the order the captures completed, each capture meets three checks:

- **Scope.** A scope violation fails the contestant (`fail-scope`). It does not block the run while the search goes on. A pinned file lies outside the owned paths (condition 4), so a change to one is a scope violation.
- **Empty.** An unchanged tree fails without a run (`fail-empty`), because the base already failed.
- **Command.** The host runs the gate at the captured commit. Exit 0 inside the limit passes. Any other exit, a timeout, or a failed setup fails (`fail-check`).

The first pass ends the search (Part 4). A captured result that has not been gated by then is never gated.

The same command runs again on the integrated head at the run's final check round, as today. A gate pass is therefore never the last check of a result, and a command that passed by chance gets a second run before review.

**A result in `measure` mode.** The champion's result is integrated as today, without waiting. The host then puts the captured commit through the same three checks when the run has no workspace operation waiting, and records the result. It aborts that gate run when the run needs the slot, and records `skipped`. The result changes nothing in the run.

**What the gate cannot see.** The host cannot tell which files define a command. The pinned files are the owner's statement of them. A contestant can still weaken a test that is not pinned and lies inside its owned paths. A single attempt can do the same today, and review is the guard in both cases. A search gives more attempts that chance, and the first pass wins, so the pinned-file rule of condition 3 stays strict (owner decision 7).

### Part 4: Choosing

```ts
// on TeamTask, in the sealed run record (contract C1)
search?: {
  id: string;
  mode: "measure" | "live";
  start: "after-fail" | "together";
  state: "admitting" | "armed" | "wide" | "resolved" | "exhausted" | "abandoned" | "measured";
  criterionId: string; command: string;            // the command's digest
  decisionKey: string; baseCommit: string;
  base?: GateRun;
  contestants: Contestant[];                       // the champion first
  holdUntil?: string;                              // rule 6
  waitUntil?: string;                              // rule 6
  winner?: string;                                 // a member ID
  class?: "champion-pass" | "rescued" | "challenger-first" | "none";
  endReason?: string;
};
type GateRun = { result: "pass" | "fail-scope" | "fail-empty" | "fail-check" | "skipped"; ms: number; failures?: number; at: string };
type Contestant = { memberId: string; profileId: string; captured?: true; commit?: string; tree?: string; gate?: GateRun; left?: string };
```

`task.memberId` stays the champion until a result passes. A `measure` search goes from `armed` to `measured` when its one gate result is recorded, or to `abandoned`. The rules below are those of a `live` search.

1. **Armed.** After a failed base run the search is `armed`: the champion works alone. With `start: "together"` the host widens at once when conditions 9 to 12 hold. When they do not, the search stays `armed` and goes on as under `after-fail`.
2. **The champion leaves** when it stalls or exits without a report. The host stops it. Today's handling of that event, a stall replacement for example, does not start. It waits for the release (rule 8).
3. **Widening.** The host widens when the champion's result fails its gate, or when the champion leaves, unless the search is already `wide`. It starts the challengers that conditions 9 to 12 allow, and the search is `wide`. When none can start, the search is `exhausted`. The champion's failed result stays captured and is not integrated.
4. **A pass.** The contestant's result enters today's integration path, `task.memberId` becomes that contestant, and the search is `resolved`. The host stops every other contestant that is still running, with stop reason `host`, and starts no replacement.
5. **A challenger leaves** when it stalls, hits a provider limit, exits without a report, fails preparation, opens a provider permission prompt, or reports `question`, `blocked`, or `escalate`. The host stops it and starts no replacement.
6. **The hold and the wait.** `holdUntil` is the moment the champion's `result` arrived, or the champion left, plus the allowance (Part 7). `waitUntil` is the moment the champion's result failed its gate, or the champion left, plus `waitMinutes`. A challenger that is still working at `waitUntil` is stopped. A result that was captured before `waitUntil` is gated, even when its gate run ends later.
7. **Exhausted.** The search ends as `exhausted` when every contestant has failed its gate or left, when `waitUntil` has passed and no captured result waits for its gate, or at `holdUntil`.
8. **Release.** A search that ends as `exhausted` or `abandoned` releases the task. The host stops every challenger, aborts the search's open gate run, and handles the champion as if no search had run. A captured result is handled as `consume` handles a result today: it is integrated when it has a commit, and it meets the final check round and its correction rounds. A scope violation blocks the run. A stall or an exit without a report gets today's handling of that event. A champion that is still working goes on as a single attempt.
9. **Abandoned.** These events abandon the search: a `question`, `blocked`, or `escalate` report from the champion; a provider limit on the champion; a failed preparation of the champion; a steer, a pause, a cancel, a routing revocation, or a revision advance; an allowance that no longer fits before the run's deadline (Part 7); a host restart during a gate run (Failure modes); and any other event that blocks the run today. The task is released, and today's rule for the event applies.

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

The host writes `task.search` first, and then emits events with this design's own prefix, as umbrella contract C2 allows:

- `search.admitted`: conditions 1 to 7 held and the base run begins.
- `search.started`: the base run failed and a `live` search is `armed`. It names the champion's member ID.
- `search.widened`: it names each challenger's member ID.
- `search.captured` and `search.gated`: one for each result.
- `search.resolved`: the search ended as `resolved` or `exhausted`.
- `search.abandoned`: the search ended as `abandoned`, with its reason.
- `search.measured`: a `measure` search recorded its gate result.

`search.resolved` and `search.abandoned` carry the class and, for each contestant, the member ID, the gate result, whether its result was captured, and whether the search selected it. A projector that this design registers derives the durable row:

```sql
CREATE TABLE searches (
  search_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL, decision_key TEXT NOT NULL,
  project_ref TEXT NOT NULL, mode TEXT NOT NULL, start TEXT NOT NULL,
  state TEXT NOT NULL, end_reason TEXT, class TEXT,
  contestants INTEGER NOT NULL, widened INTEGER NOT NULL DEFAULT 0,
  champion_identity TEXT NOT NULL, winner_identity TEXT,
  started_at TEXT NOT NULL, ended_at TEXT,
  encrypted_payload TEXT NOT NULL
);
```

The payload holds the task ID, the criterion ID, the member IDs, config IDs, every gate run, tree IDs, diff sizes, and costs. The row holds no run text. The host keeps the last 4,096 characters of each gate run's output in the run record. The team view does not carry them, and `infinite search show` prints them for the owner.

`failures` on a gate run is the failure-line count of the check-output scanner (INF-314), when that scanner is on `main` and finds failure lines. It is absent otherwise. No rule of this design reads it. Part 9 says why it is recorded.

**Classification comes before outcomes.** The outcome ledger's projector sets source `search` and `experiment_ref` on a contestant's row from `search.started` and `search.widened`. The host emits `search.started` before it captures any result of the search, and `search.widened` before a challenger launches, so no terminal event of a contestant is projected first. Both events apply idempotently by search ID and member ID, and reconciliation replays them from `task.search`. The source never changes afterwards, whether the search is resolved, exhausted, or abandoned. A `measure` search emits neither event, and its rows keep source `production`.

**Outcome rows.** The search sets the fate of these contestants, from `search.resolved` or `search.abandoned`:

| Contestant | Disposition | Counted |
|---|---|---|
| Its result passed and was integrated | `integrated` | yes |
| Its result failed scope and was not integrated | `out-of-scope` | failure |
| Its result failed the command, or was empty, and was not integrated | `gate-failed` | failure |
| Its result was captured and never gated, because another passed or the search ended | `not-chosen` | excluded: `search` |
| The host stopped it while it worked, because the search ended | `host-stop` | excluded: `host` |

A contestant that left for its own reason keeps its own disposition. After a release the champion's row takes the disposition that today's rules give it, and its failed gate stays in the `searches` row. Both keep source `search`. A search that was abandoned before it was armed leaves the champion a `production` row. A challenger's row has `inherited` 0, because it began at the base commit.

The router does not read `search` rows in this version. *(My call: in a `search` row, `integrated` means the result passed a command before integration. No production row was asked to do that, so the two rates differ in meaning, and C6 keeps them apart. A champion that passed alone is a `search` row too. If only the champions that failed left `production`, the production rate of their profiles would rise for no reason.)*

### Part 7: Budget, slots, and time

**Budget.** Every contestant has purpose `work` (C8). It counts against the run's attempt limit and against the goal's member count, and its launch passes the spend fuse like any member's. The learning budget pays nothing. Condition 11 keeps the run's reserve: a challenger starts only while `spareAttempts(run)` stays at 0 or more, so one attempt remains for each task not yet integrated, and three more. A run that later needs more than that reserve reaches its attempt limit sooner than it would have without the search. *(My call: the router's explore guard uses the same count with a floor of 4. A search is work the owner asked for, so its floor is 0.)* A challenger that the reserve refuses or the fuse holds is not started, and the search goes on with the others. A search never waits for a fuse.

**Worker slots.** Each contestant holds a normal worker slot inside `run.parallelism`. Condition 10 gives a challenger only a slot that no ready task needs. A task that becomes ready later waits for a slot, as it waits today behind any running implementer. *(My call: unlike a duel's challenger, a search contestant is work the owner asked for, so the host does not stop it for a later task.)*

**Time.** A gate run counts as 20 minutes for the clone and the setup command, plus `gateMinutes`. A search's **allowance** is one gate run for each contestant, one more for a base run that is still open, and the wait. With the defaults and three attempts that is 4 × 35 + 60 = 200 minutes. The host enforces it through `holdUntil` (Part 4, rule 6): at that moment the search is `exhausted`, its open gate run is aborted, and the task is released. Time that the search's operations spend waiting behind other operations of the run counts inside the allowance. A task's integration therefore starts at most the allowance later than it would have alone. Integration follows plan order, so later results wait too while their members keep working. A run has at most two searches. Choosing `live` is the owner's authorization for that delay.

The wait is a cutoff of this design. A single attempt has no runtime limit, and a challenger that is still working at `waitUntil` is stopped. *(My call: without a cutoff a slow challenger holds the task's integration open. The status counts the challengers that the wait stopped.)*

`assertBudget` stops a goal run at its `deadlineAt`. The host therefore requires the allowance to fit before the deadline at admission, again at widening, and again when the champion's result arrives. A search that no longer fits is abandoned, and the task is released (Part 4, rules 8 and 9).

**The operation slot.** A base run and a `measure` gate run start only when the run has no workspace operation waiting, and the host aborts them when the run needs the slot. In `live` mode a gate run of a captured result waits its turn like any capture, and production work that arrives during it waits until it ends.

### Part 8: Measures and the brake

A `measure` search records one gate result for the first result: `pass`, a failure kind, or `skipped`.

Each ended `live` search that was armed has one class, from host records alone:

- `champion-pass`: the champion's result passed its gate.
- `rescued`: the champion's result failed its gate, or the champion left, and a challenger's result passed.
- `challenger-first`: a challenger's result passed while the champion was still working. Only `start: "together"` can produce it. What the champion would have produced is unknown.
- `none`: no result passed.

`infinite search status` shows, per project: admissions and the reasons that ended them at the base run; first results by gate result, from both modes; `live` searches by class; the share of widened searches that were `rescued`; the cost of all contestants beside the champion's cost; the minutes a search added; gate failures by kind; challengers that left, by reason, and challengers that the wait stopped; and the count of searches with two equal captured trees.

Two of these numbers answer questions that nothing answers today. The share of first results that pass their gate is how often a first attempt turns such a check. The `rescued` share of widened searches is how often a fresh start on another family passes where the first attempt failed.

**When `live` pays.** If a first result passes with probability p, an `after-fail` search widens with probability 1 − p. `measure` mode gives p for two command runs a task. *(My call: the owner runs `measure` until about 20 first results are recorded, and then decides on `live`. At the ledger's volume, a share of 0.1 allows at most two or three searches in an active week.)*

**The brake.** Searches pause for a project when it has 10 or more widened searches and the last 10 hold fewer than 2 `rescued`. The owner resumes them, and the count starts again. A `challenger-first` search does not count as a rescue, because the champion might have passed. *(My call: below one rescue in five, the extra attempts mostly fail where the first one failed, and today's correction round is the cheaper path. Under `start: "together"` the same rule pauses a project whose first attempts mostly pass.)*

### Part 9: What stays open

Two rules are left out on purpose, because no measurement on Infinite supports them yet:

- **Repair a near miss, restart a clear failure.** Published search results favour a small change to a strong result and a fresh start from a weak one. This design restarts after every failed gate and falls back to a correction round only when no restart passes. A rule that sends a near miss straight to the correction round needs a host measure of nearness. The candidate is the failure-line count of the champion's gate run beside the base run's count. Part 6 records both, so the records can show whether fewer failures than the base predicts that a correction round resolves.
- **The router's use of search results.** A gated pass beside a gated failure on the same task is a paired fact with no judge in it. The duels design's pair statistic could count it as a gate decision. Whether it should is the owner's decision 8.

### Part 10: Surface

- **CLI.** `infinite repo init --search off|measure|live [--search-start after-fail|together] [--search-share N]`. `infinite search status [PROJECT]` shows the mode, the pause state, the share, skip counts, and the measures of Part 8. `infinite search show SEARCH_ID`, `pause PROJECT`, and `resume PROJECT`.
- **API.** `GET /api/search/projects/:id` and `/api/search/:id` serve owner, controller, and viewer. Pause and resume need the owner. `PUT /api/projects/:id/team` carries `search`. The team view shows a task's search state, its contestants, and their gate results, without gate output.
- **MCP.** Nothing new. A contestant sees no new tool, field, or report kind.
- **Prompts.** The coordinator prompt gains one sentence about the `criterion` field, only in a run whose search mode is `measure` or `live` and whose pinned digest holds a host `command` criterion. It changes the prompt version of the coordinator role only (C7). No implementer prompt changes.

## Authority and safety

- **Honesty.** A gate pass selects which reported result enters integration. It records nothing as complete, and the final check round, review, verdicts, and delivery apply unchanged. The selection rests on a host receipt and never on the agent that did the work.
- **Authorized commands.** The gate runs only a command that is one of the run's required checks. It runs that command more often and at more commits. Captured results are unreviewed member code, as the integrated head is when today's final check round runs it.
- **Fixed limits.** A search adds no worker beyond `run.parallelism`, no attempt beyond the run's attempt limit or inside its reserve (Part 7), no permission decision, and no owner prompt. Every launch passes the spend fuse.
- **Approved profiles.** A challenger comes from the candidates of the task's own routing decision, so it passed the router's eligibility rules, the contributor rule included.
- **Prompts (C9 rule 3).** A contestant's prompt does not change, and no search record reaches a member's prompt, context file, or tool result (Part 5).
- **Learning (C9 rule 2).** No learned value decides whether a search starts, widens, or ends. The share, the attempt count, the reserve, and the brake are fixed numbers and counts.

## Failure modes

| Situation | Behaviour |
|---|---|
| The base run passes, times out, fails setup, or is aborted for the run's own work | The search is abandoned with that reason. The champion continues as a single attempt, with a `production` row. |
| The champion's result passes its gate | It integrates. Under `after-fail` no challenger ever started. |
| No challenger can start when the champion's result fails | `exhausted` at once, then the release. |
| No challenger can start at arming under `together` | The search stays `armed`. It widens when the champion's result fails, if conditions 9 to 12 hold then. |
| A challenger stalls, hits a limit, or opens a permission prompt | It leaves (Part 4). The search goes on without it. |
| Every result fails, the wait ends, or the hold ends | `exhausted`. The task is released to today's rules for the champion. |
| The command fails fast at the base and runs past its limit on a right result | Every gate run fails by time. The search is `exhausted`, the task is released, and the brake counts it. |
| The run's attempt reserve is used up | No challenger starts (condition 11). A run that later needs more attempts than the reserve reaches its limit sooner than without the search. |
| The winner's commit conflicts at integration | The run blocks with `integration-conflict`, as today. |
| The command passes by chance on a wrong result | The final check round runs it again on the integrated head, and review follows. |
| A pinned file changed before the task's base | Condition 4 fails. No search starts. |
| The host restarts during a gate run, in either mode | The gate run is never replayed. The run blocks with the interrupted-operation reason, as it does for an interrupted check today. The reconciliation of that state gains the `gate` kind, with the same conditions: a quiet run, and a process census that sees no process of the gate run and none using the gate clone. It then removes the clone, abandons the search, and releases the task. A search spends more time inside workspace operations than a single attempt does, so a restart blocks such a run more often (owner decision 13). |
| The host restarts at another moment of a search | It resumes from `task.search`. Events and the `searches` row are idempotent by key, and no second challenger starts for a contestant. |
| The evidence store is unavailable | No search starts. An open search finishes in the run record, and reconciliation writes its row and its classification later. |
| Searches are paused, or the share is used up, during a search | The open search finishes. The next one does not start. |

## Changes this design asks of its siblings

- **Objective record design.** The owner's criterion input gains `pinned`, a list of up to 8 paths, on `criterion.add` and `criterion.edit`, as an amendment to its step 2. Nothing else changes: a criterion still never adds a command, and this design reads `pinned` as that design uses it, as the files that define a check.
- **Team plan schema.** `teamTaskPlanSchema` gains `criterion`.
- **Team workspace operations.** A fifth operation kind, `gate`. The reconciliation of an interrupted check accepts it, under the rule of the failure-mode table.
- **Outcome ledger design.** A fifth source, `search`, set from `search.started` and `search.widened`. `search.resolved` and `search.abandoned` set `out-of-scope`, `gate-failed`, and `not-chosen` as `duel.resolved` does, and `not-chosen` under a search has exclusion `search`. A challenger's `attempt_index` counts it after the champion, in start order.
- **Umbrella.** Its table of designs gains this one. In C6 the list of sources gains `search`. In C11 the search policy joins the settings inside the routine digest, for the duel policy's reason: it changes who does the work.
- **Duels design.** Its conditions 3 and 8 count a search as an experiment on the task and as an open duel of the run.
- **Evidence router design.** The choice does not change. A pure helper of the router module returns a decision's candidates in the order of Part 2.

## Delivery order

Each phase is its own pull request.

1. **The search engine.** A pure module that applies admission, widening, a gate result, a leave, the wait, the hold, and the release to `task.search`, with a seeded simulator of its orders. Nothing imports it.
2. **A gate run at a commit.** The gate clone, the `gate` operation with its restart rule, and the base run. The duels design's gate needs the same piece.
3. **Measure mode.** The policy and its pin, the `criterion` field, admission, the gate of an integrated result, the `searches` table, and `infinite search status`.
4. **Live search.** Hold and choose, challengers, the release, the ledger source, and the brake.
5. **Client views.**

Phases 3 and 4 need the router in `auto` and owner criteria with `command` checks in goal records, which are on `main`. They also need the owner's `pinned` input, which is not built. No phase needs the eval identity, a judge, the learning budget, or the assumption tests of the objective record design.

## Acceptance

1. With mode `off`, generated prompts, scheduling, and stored records match today's.
2. A plan whose `criterion` names no criterion of the run's pinned digest is refused. A plan with a valid `criterion` and mode `off` runs as today. A task whose criterion is derived, or pins no file, gets a single attempt, and the status counts condition 3.
3. With conditions 1 to 7 true and a command that fails at `baseCommit`, the search is `armed` and one implementer works. With a command that passes at `baseCommit`, the search is abandoned and the task runs as today, with a `production` row.
4. In `measure` mode the champion's result integrates without waiting for a gate run, no second implementer starts, the `searches` row holds the gate result of the captured commit, and the champion's row has source `production`. A gate run that the run's own work interrupts is recorded as `skipped`.
5. Under `after-fail`, a champion result that passes its gate integrates, and no second implementer ever starts for the task. A champion result that fails its gate is not integrated, and challengers start on the champion's `baseCommit`, each of a family that no other contestant has. No challenger starts when the champion's family is unknown.
6. Under `together`, challengers start when the base run fails and conditions 9 to 12 hold. When they do not hold, the search stays `armed`, and it widens when the champion's result fails its gate.
7. The first result that passes its gate is integrated, `task.memberId` names its member, and every other running contestant is stopped with no replacement. A result that was captured before the pass and not yet gated is never gated, and its row is `not-chosen`.
8. A result that changes a pinned file, or a path outside the task's owned paths, fails with `fail-scope` and does not block the run while the search goes on.
9. When every result fails, when the wait ends with no capture left to gate, or at `holdUntil`, the task is released: the champion's captured result integrates as today and the final check round runs. When the champion stalled and no challenger passed, today's stall replacement starts then, and not before.
10. The task's integration starts no later than the allowance after the champion's result arrived. A gate run that is open at that moment is aborted.
11. A `question` from the champion abandons the search, stops every challenger, and blocks the run as today. Every contestant of a search that was abandoned after it was armed keeps source `search`.
12. No challenger starts when it would take `spareAttempts(run)` below 0, and the host makes no `assertBudget` call that the limit refuses. With one attempt left and a reviewer still to start, a search starts no challenger.
13. No search starts when the run has had two searches, when the allowance does not fit before the deadline, or when the share is used up. Each case counts its condition. When every free worker slot has a ready task as the champion's result fails, no challenger starts, and the search is `exhausted`.
14. After a resolved search, a later member's context file has no `search` field and no report of a contestant that was not integrated.
15. A restart while no gate run is open resumes the search with the same contestants and one `searches` row. A restart during a gate run starts no second command and blocks the run as an interrupted check does. Its reconciliation is refused while the census sees a process of the gate run, and it otherwise abandons the search and releases the task.
16. With 10 widened searches of which 1 is `rescued`, the next task that meets every other condition gets a single attempt, and the status shows the pause.
17. Every contestant row of a `live` search that was armed has source `search`, and no production cell counts it.

## Owner decisions

Each value below was my call.

1. **Measure first.** Run `measure` until about 20 first results are recorded, and then decide on `live`. `measure` costs two command runs for each eligible task and starts no extra attempt. A host restart during one of those runs blocks the run (decision 13).
2. **When challengers start.** `after-fail` by default, `together` as an option. `together` finishes sooner and pays for challengers on every search.
3. **The numbers.** A share of 0.1 with a ceiling of 0.25, three attempts with a ceiling of four, two searches per run, 15 minutes for a gate command, and a wait of 60 minutes. With the defaults a search may hold an integration for up to 200 minutes.
4. **The wait.** A challenger that is still working 60 minutes after the champion's result failed is stopped. A single attempt has no such limit.
5. **The reserve.** A challenger starts only while `spareAttempts(run)` stays at 0 or more. A higher floor, such as the router's 4, makes a search rarer and leaves the run more attempts.
6. **Slots.** A challenger takes only a slot that no ready task needs, and keeps it when a task becomes ready later. The other choice stops the newest challenger for that task.
7. **Pinned files and origin.** Only an owner criterion with at least one pinned file opens a search. Without the rule, more criteria qualify, and a result that weakens the test can win. The rule needs the owner's `pinned` input, which is not built.
8. **Evidence.** `search` rows stay out of the router, and a gated pass beside a gated failure is not counted as a pair. Counting it would add judge-free pairs to the duels design's statistic.
9. **The brake.** Pause below 2 rescues in the last 10 widened searches.
10. **Permission prompts.** A challenger leaves at its first provider permission prompt, as a duel's challenger does. The other choice lets it use the run's delegated permission reviewer under the run's cap.
11. **Autonomy.** The mode stays `off` in an autonomous project until the owner sets it. Duels default to `live` there.
12. **The plan field.** A coordinator, which is a model, names the criterion a task must turn. The host checks everything else. Without the field the host cannot tell which task a failing criterion belongs to.
13. **A restart during a gate run.** The run blocks, and the same reconciliation as for an interrupted check releases it. The other choice lets the host release it alone when its census sees no process. That is a weaker fence than a check has today.

## Left to the builder

- The Git commands that build a gate clone at a commit, and how one clone is reused between the gate runs of a search without carrying a file from one result to the next. A new command form needs an entry in the server's owner-approved team command list.
- The fields of the `gate` operation's intent, and how the process census matches a gate run's processes.
- How base runs, captures, and gate runs use the run's one operation slot under the rules of Part 7.
- The order of candidates that have no stored utility.
- How `TeamService` reads the goal's record at the pinned version. The goal service owns that record.
- The wording of the coordinator prompt's sentence about `criterion`.
- The layout of `infinite search status` and the client views.
