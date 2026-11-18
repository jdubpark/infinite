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
- **A result integrates in plan order.** For an implementer `result`, `consume` runs one workspace operation that calls `captureMemberResult` and then `integrateMemberResult`. No command runs between the two. The host does this only when every earlier task of the plan is integrated.
- **Checks follow integration.** The host runs the run's required checks (`requiredChecks`) in a verification workspace when every task is integrated and no member is at work, and again after each correction round. A failed check, or a review that requests changes, starts a correction round (`repair`): a new integrator works on the integrated head, at most twice. A check that runs past its limit, or that fails again on an unchanged head, blocks the run instead. A check waits while the host-load hold is on.
- **No check belongs to a task.** `teamTaskPlanSchema` has no check field and names no criterion.
- **A criterion can name a command, and cannot yet pin a file.** A criterion of the objective record can hold a `command` check: the digest of a command in the project's configured checks or the run's accepted verification. The owner adds one when creating a goal or with a record correction. The stored criterion can hold up to 8 `pinned` files, whose change voids a met state. The owner's criterion input has no `pinned` field, so no criterion pins a file today. A goal cycle run pins a digest of its goal's record, with the record's version, when the objective switch is on. No route adds a criterion to a standalone run's record, and no code runs a command for a criterion.
- **A retry keeps the working copy.** After a stall the host starts one replacement on the same profile in the same working copy. An escalation starts another profile in that working copy, with the first member's partial edits. No retry starts again from the base commit. A member has no runtime limit: the host replaces it only when it shows no activity.
- **One workspace operation at a time.** A run has one workspace operation at a time (`operation`), and the host records the operation's intent before it starts. After a host restart an unfinished operation is not replayed, and the run blocks. The owner can reconcile an interrupted check (`reconcileVerification`). The run must be quiet. Where the host has a record of the check's processes, it refuses while it still sees one of them, or sees a process that uses the run's directory. The owner attests that the processes have stopped, and the check then runs again in a new workspace. The host stops a running command by killing its process group. Where a launcher does not let the host signal the group, the command runs on to its end, and the operation stays open until it closes.
- **Limits.** `holdsWorkerSlot` counts implementers and scouts against `run.parallelism`, which is at most 4. `assertBudget` counts every entry in `run.members` against the run's attempt limit, and a goal run stops when a launch would exceed it. A goal's limit is 24 attempts by default, and its cycles share it. `assertBudget` also stops a goal run at its deadline, unless an approved extension applies. The router's `spareAttempts` is the run's limit, less the members so far, less one for each task not yet integrated, less three. The router explores only while that count is at or above `minSpareAttempts`, 4 by default. Every member launch passes the spend fuse, which holds a launch-rate limit today.
- **Sources.** An outcome row has a source: `production`, `duel`, `replay`, or `legacy`. The router reads `production` and `duel` rows.
- **Duels have no code.** The duels design specifies a capture that is not integrated, an objective gate in a verification clone, and isolation between two contestants. None of it is built.
- **The ledger is small.** On 2026-11-18 the live host's ledger held 88 implementer rows from 31 runs since 2026-10-18. 65 of them came from a one-time backfill of runs whose records still existed. Of 87 first attempts, 83 were integrated, 2 reported a blocker, 1 escalated, and the host stopped 1. No row is a stall, a missing report, or a provider limit. 11 correction rounds ran in 9 runs, and 10 of them were backfilled without a cause or an end state. Nothing in the ledger says how often a first result fails one named check.

A field of a sibling design that is named here is defined in that design.

## Goals

1. Up to four approved profiles of different families work one implementer task from the same commit, and a host-run command decides which result is integrated.
2. The command is one the owner already authorized, it fails at the commit that every attempt starts from, and no attempt can change the files that the owner pinned for it.
3. The attempts stay independent until one is chosen.
4. A search stays inside the run's approved limits: its parallelism, its attempt limit, its deadline, and the spend fuse. A challenger starts only while the run keeps a reserve of attempts (Part 7). The reserve is a rule of thumb. It covers the longest planned sequence after the last integration, and it does not cover a stall or an escalation on the way.
5. A search that ends without a pass releases the task to today's single-attempt path. Its hold on a task ends at most its allowance after the champion's result arrived or the champion left (Part 7). The task is then scheduled as today, in plan order and behind the run's other operations. Two events break that bound: a host restart during a workspace operation of the search, and a gate run that the host cannot stop (Failure modes).
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

**Modes.** `measure` admits a search and changes nothing in the task's handling. Before the run's final check round, the host runs the criterion's command at the task's base commit and at the first result's commit, and records both (Part 3). It starts no challenger, holds no result, and changes no outcome row. `live` runs the command at the base commit while the first attempt works, holds the first result for its gate, and widens.

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
6. The run has no search that is `wide`, and has had fewer than two searches. Searches are not paused for the project (Part 8).
7. In `live` mode, searches stay at or below `share` of the project's last 100 applied `start` decisions. If the run has a deadline, the search's allowance fits before it (Part 7). The share does not limit `measure`.
8. In `live` mode, the base run fails (Part 3).

Otherwise the task gets a single attempt as today, and the host counts the first failed condition per day.

*(My call on condition 3: a pinned file is the only statement the host can check of what defines a check. Without one, the fastest way to pass is to weaken the test, and a search would select that result. The owner chose an owner criterion's pinned files. A derived criterion is a model's reading of the owner's text, and it stays out until the records say more.)*

**Widening.** Only a `live` search widens. The host starts challengers at the moment Part 4 names, and only when all of these hold then:

9. No other search of the run is `wide`. The champion's family is known. Part 2 yields at least one challenger, and no provider limit is active for it.
10. A worker slot is free that no ready task needs, and a host session slot is free. The host starts one challenger for each such pair of slots, up to `attempts − 1`.
11. The run keeps its reserve: with the challengers counted as members, `spareAttempts(run)` is 3 or more (Part 7). The host checks this before it prepares a challenger. It never asks `assertBudget` for an attempt that the limit would refuse, because a refused attempt stops a goal run. The spend fuse admits each launch (C13).
12. If the run has a deadline, the rest of the allowance fits before it.

### Part 2: The contestants

The **champion** is the member the dispatcher prepared, on the profile of the task's `start` routing decision. A **challenger** is another candidate that the decision row stores without a removal. The host takes challengers in the order of `greedyUtility` in that row, highest first, and skips a candidate whose model family is unknown or is already in the search. The family is that of C19, under which no family differs from an unknown one. A champion of unknown family therefore gets no challenger (condition 9). *(My call: two profiles of one family fail together more often than two families do.)*

Every contestant is a normal work member. It has purpose `work`, the task's owned paths, the champion's `baseCommit`, and the prompt of a single attempt on its profile. The host prepares a challenger through `newMember`'s `pinnedProfile` parameter, as the duels design does. No text mentions a search.

### Part 3: The gate

The gate is the criterion's command. It is one of the run's required checks, so the owner authorized it and the host already runs it at the final check round. The host runs it in a gate clone: a verification clone at one commit, after the project's setup command. The command gets `gateMinutes`, or the limit of the final check round (`teams.checkMinutes`) when that is shorter. A gate run waits while the host-load hold is on, as a check does.

**A gate run is a workspace operation.** It holds the run's one operation slot, and the host records its intent before it starts, as it does for a check today. It is a new operation kind, `gate`. The host stops a gate run as it stops a check, and a stopped gate run has no result. Where the launcher does not let the host signal the command, the command runs on to its end, and the run's other operations wait for it, as they do behind such a check today. After a host restart an interrupted gate run is never replayed (Failure modes).

**The base run** is a gate run at the task's `baseCommit`. A search goes on only when the command exits non-zero inside its limit. A pass, a timeout, or a failed setup ends the search as `abandoned` with that reason. *(My call: a command that passes at the base cannot tell a right result from an empty one. One command run for each search buys that certainty for this exact commit.)*

**`live` mode: the base run.** When conditions 1 to 7 hold, the host writes `task.search` in state `admitting` and starts the base run while the champion works. It starts the base run only when the run has no workspace operation waiting, and it stops the base run when one arrives. That stop also ends the search as `abandoned`. After a failed base run the search is `armed`. A `result` that arrives before the base run has ended waits for it, and is then gated or integrated as the base run decided. Any other event that ends the champion's attempt in that time abandons the search.

**`live` mode: a result.** When a contestant reports `result` and has stopped, the host captures the result with `captureMemberResult` and does not integrate it. The capture is a workspace operation with a recorded intent, as today's capture is. It does not wait for the task's turn in plan order. In the order the captures completed, each capture meets three checks:

- **Scope.** A scope violation fails the contestant (`fail-scope`). It does not block the run while the search goes on. A pinned file lies outside the owned paths (condition 4), so a change to one is a scope violation.
- **Empty.** An unchanged tree fails without a run (`fail-empty`), because the base already failed.
- **Command.** The host runs the gate at the captured commit. Exit 0 inside the limit passes. Any other exit, a timeout, or a failed setup fails (`fail-check`).

The first pass ends the search (Part 4). A captured result that has not been gated by then is never gated. The result that passed is integrated in plan order, as a single attempt's result is.

The same command runs again on the integrated head at the run's final check round, as today. A gate pass is therefore never the last check of a result, and a command that passed by chance gets a second run before review.

**`measure` mode.** The champion's result is captured and integrated as today, in one operation. When every task of the plan is integrated and no member is at work, and before the first final check round of the revision, the host runs two gate runs for each `measure` search whose champion's result was integrated: the base run, and after a failed base run the gate at the champion's captured commit. An unchanged tree is recorded as `fail-empty` without a run. The final check round begins when these gate runs have ended. The results change nothing in the run. *(My call: no member is at work at that moment, so a host restart during a gate run costs the run what a restart during its final check costs today, and nothing more. The price is a later final check round.)*

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
type GateRun = { result: "pass" | "fail-scope" | "fail-empty" | "fail-check"; ms: number; failures?: number; at: string };
type Contestant = { memberId: string; profileId: string; captured?: true; commit?: string; tree?: string; gate?: GateRun; left?: string };
```

`task.memberId` stays the champion until a result passes.

**A `measure` search** is `admitting` from its admission until its gate runs. It ends as `measured` when the base run failed and the gate result of the champion's commit is recorded. It ends as `abandoned`, with the reason recorded, in three cases. The base run does not fail. The champion's attempt ends without an integrated result: a stall, an exit without a report, a provider limit, a failed preparation, a `question`, `blocked`, or `escalate` report, a scope violation, or an integration conflict. An event of rule 9 happens before the gate result is recorded. Only the champion's own result is measured. A replacement or an escalation that finishes the task is never measured in its place.

**A `live` search** follows these rules:

1. **Armed.** After a failed base run the search is `armed`: the champion works alone. With `start: "together"` the host widens at once when conditions 9 to 12 hold. When they do not, the search stays `armed` and goes on as under `after-fail`.
2. **The champion leaves** when it stalls or exits without a report. The host stops it. Today's handling of that event, a stall replacement for example, does not start. It waits for the release (rule 8).
3. **Widening.** The host widens when the champion's result fails its gate, or when the champion leaves, unless the search is already `wide`. It starts the challengers that conditions 9 to 12 allow, and the search is `wide`. When none can start, the search is `exhausted`. The champion's failed result stays captured and is not integrated.
4. **A pass.** The contestant's result enters today's integration path, `task.memberId` becomes that contestant, and the search is `resolved`. The host stops every other contestant that is still running, with stop reason `host`, and starts no replacement.
5. **A challenger leaves** when it stalls, hits a provider limit, exits without a report, fails preparation, opens a provider permission prompt, or reports `question`, `blocked`, or `escalate`. The host stops it and starts no replacement.
6. **The hold and the wait.** `holdUntil` is the moment the champion's `result` arrived, or the champion left, plus the allowance (Part 7). `waitUntil` is the moment the champion's result failed its gate, or the champion left, plus `waitMinutes`. A challenger that is still working at `waitUntil` is stopped. A result that was captured before `waitUntil` is gated, even when its gate run ends later.
7. **Exhausted.** The search ends as `exhausted` when every contestant has failed its gate or left, when `waitUntil` has passed and no captured result waits for its gate, or at `holdUntil`.
8. **Release.** A search that ends as `exhausted` or `abandoned` releases the task. The host stops every challenger and the search's open gate run. When that gate run has closed, the champion is handled as if no search had run. A captured result is integrated as a single attempt's result is, in plan order, and it meets the final check round and its correction rounds. A scope violation blocks the run. A stall or an exit without a report gets today's handling of that event. A champion that is still working goes on as a single attempt.
9. **Abandoned.** These events abandon the search: a `question`, `blocked`, or `escalate` report from the champion; a provider limit on the champion; a failed preparation of the champion; a steer, a pause, a cancel, a routing revocation, or a revision advance; an allowance that no longer fits before the run's deadline (Part 7); a host restart during a workspace operation of the search (Failure modes); and any other event that blocks the run today. The task is released, and today's rule for the event applies.

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

- `search.admitted`: the admission conditions held. It names the task and the champion's member ID.
- `search.started`: the base run failed and a `live` search is `armed`.
- `search.widened`: it names each challenger's member ID.
- `search.captured` and `search.gated`: one for each result of a `live` search.
- `search.resolved`: the search ended as `resolved` or `exhausted`.
- `search.abandoned`: the search ended as `abandoned`, with its reason.
- `search.measured`: a `measure` search recorded its base run and its gate result.

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

**Classification comes before outcomes.** `search.started` marks the task's assignment: the task in that run and revision. From then on the outcome ledger's projector gives every attempt of that assignment source `search` and the search's `experiment_ref`. That covers the champion, each challenger, and a member that starts for the task after the search ended, a stall replacement for example. The host emits `search.started` before it captures any result of the search, so no terminal event of a contestant is projected first. The event applies idempotently by search ID, and reconciliation replays it from `task.search`. The source never changes afterwards, whether the search is resolved, exhausted, or abandoned. A `measure` search never emits the event, and its rows keep source `production`.

**Outcome rows.** The search sets the fate of these contestants, from `search.resolved` or `search.abandoned`:

| Contestant | Disposition | Counted |
|---|---|---|
| Its result passed and was integrated | `integrated` | yes |
| Its result failed scope and was not integrated | `out-of-scope` | failure |
| Its result failed the command, or was empty, and was not integrated | `gate-failed` | failure |
| Its result was captured and never gated, because another passed or the search ended | `not-chosen` | excluded: `search` |
| The host stopped it while it worked, because the search ended | `host-stop` | excluded: `host` |

A contestant that left for its own reason keeps its own disposition. After a release the champion's row takes the disposition that today's rules give it, as does the row of a member that starts for the task later. A search that was abandoned before it was armed leaves the champion a `production` row. A challenger's row has `inherited` 0, because it began at the base commit.

The router does not read `search` rows in this version. *(My call: a `search` row is an attempt whose fate a search could change. Its result may have been held for a gate, refused by it, or stopped because another passed. No `production` row met any of that, so the two populations differ, and C6 keeps them apart. `integrated` keeps the ledger's meaning. Some `search` rows were integrated after a gate pass, and some after a release with a failed gate or none, and the `searches` row tells them apart. A champion that passed alone is a `search` row too. If only the champions that failed left `production`, the production rate of their profiles would rise for no reason.)*

### Part 7: Budget, slots, and time

**Budget.** Every contestant has purpose `work` (C8). It counts against the run's attempt limit and against the goal's member count, and its launch passes the spend fuse like any member's. The learning budget pays nothing.

Condition 11 keeps a reserve. A challenger starts only while `spareAttempts(run)` stays at 3 or more with it counted. The run then has one attempt left for each task not yet integrated, and six more. Six is the longest planned sequence after the last integration: a review, two correction rounds with a review after each, and delivery. The reserve is a rule of thumb. A stall replacement, an escalation, or a review that the host rejects takes an attempt that it does not count. A run can therefore still reach its attempt limit sooner than it would have without the search (owner decision 5). A challenger that the reserve refuses or the fuse holds is not started, and the search goes on with the others. A search never waits for a fuse.

**Worker slots.** Each contestant holds a normal worker slot inside `run.parallelism`. Condition 10 gives a challenger only a slot that no ready task needs. A task that becomes ready later waits for a slot, as it waits today behind any running implementer. *(My call: unlike a duel's challenger, a search contestant is work the owner asked for, so the host does not stop it for a later task.)*

**Time.** A gate run counts as 20 minutes for the clone and the setup command, plus `gateMinutes`. A `live` search's **allowance** is one gate run for each contestant, one more for a base run that has not ended, and the wait. With the defaults and three attempts that is 4 × 35 + 60 = 200 minutes. The host enforces it through `holdUntil` (Part 4, rule 6): at that moment the search is `exhausted`, the host stops its open gate run, and the task is released. Time that the search's operations spend waiting behind other operations of the run, or behind the host-load hold, counts inside the allowance.

The search's hold on a task therefore ends at most the allowance after the champion's result arrived or the champion left. After the release the task is scheduled as today: its result is integrated in plan order, when the run's operation slot is free. Later results of the plan wait for it meanwhile, as they wait today behind any earlier task, and their members keep working. A run has at most two searches. Choosing `live` is the owner's authorization for that delay. Two events break the bound: a host restart during a workspace operation of the search, and a gate run that the host cannot stop (Failure modes).

A `measure` search holds no result. It delays the run's final check round by its two gate runs, at most 70 minutes with the defaults, and a run has at most two such searches.

The wait is a cutoff of this design. A single attempt has no runtime limit, and a challenger that is still working at `waitUntil` is stopped. *(My call: without a cutoff a slow challenger holds the task's integration open. The status counts the challengers that the wait stopped.)*

`assertBudget` stops a goal run at its deadline, unless an approved extension applies. The host therefore requires the allowance to fit before the deadline at admission, again at widening, and again when the champion's result arrives. A search that no longer fits is abandoned, and the task is released (Part 4, rules 8 and 9).

**The operation slot.** In `live` mode a base run yields to the run's other operations (Part 3). A capture and a gate run of a captured result wait their turn like any operation, and production work that arrives during a gate run waits until it ends. In `measure` mode the gate runs take the slot when no other operation of the run needs it, before the final check round.

### Part 8: Measures and the brake

A `measure` search records its base run and one gate result for the first result: `pass`, `fail-empty`, or `fail-check`.

Each ended `live` search that was armed has one class, from host records alone:

- `champion-pass`: the champion's result passed its gate.
- `rescued`: the champion's result failed its gate, or the champion left, and a challenger's result passed.
- `challenger-first`: a challenger's result passed while the champion was still working. Only `start: "together"` can produce it. What the champion would have produced is unknown.
- `none`: no result passed.

`infinite search status` shows, per project: admissions and the reasons that ended them at the base run; first results by gate result, from both modes; `live` searches by class; the share of widened searches that were `rescued`; the cost of all contestants beside the champion's cost; the minutes a search added; gate failures by kind; challengers that left, by reason, and challengers that the wait stopped; and the count of searches with two equal captured trees.

Two of these numbers answer questions that nothing answers today. The share of first results that pass their gate is how often a first attempt turns such a check. The `rescued` share of widened searches is how often a fresh start on another family passes where the first attempt failed. For a first result that failed its gate in `measure` mode, the run's own records then show what today's path made of it: a pass at the final check round, or a correction round.

**When `live` pays.** If a first result passes with probability p, an `after-fail` search widens with probability 1 − p. `measure` mode gives p for two command runs a task. *(My call: the owner runs `measure` until about 20 first results are recorded, and then decides on `live`. How long that takes depends on how many goals carry an owner criterion with a command and pinned files. No goal can carry one today.)*

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
| The base run passes, times out, fails setup, or is stopped for the run's own work | The search is abandoned with that reason. The champion continues as a single attempt, with a `production` row. |
| The champion's result passes its gate | It integrates in plan order. Under `after-fail` no challenger ever started. |
| No challenger can start when the champion's result fails | `exhausted` at once, then the release. |
| No challenger can start at arming under `together` | The search stays `armed`. It widens when the champion's result fails, if conditions 9 to 12 hold then. |
| A challenger stalls, hits a limit, or opens a permission prompt | It leaves (Part 4). The search goes on without it. |
| Every result fails, the wait ends, or the hold ends | `exhausted`. The task is released to today's rules for the champion. |
| The command fails fast at the base and runs past its limit on a right result | Every gate run fails by time. The search is `exhausted`, the task is released, and the brake counts it. |
| The run's attempt reserve is used up | No challenger starts (condition 11). |
| After a search, the run needs more attempts than the reserve held | The run reaches its attempt limit sooner than without the search, and stops as today. |
| The winner's commit conflicts at integration | The run blocks with `integration-conflict`, as today. |
| The command passes by chance on a wrong result | The final check round runs it again on the integrated head, and review follows. |
| A pinned file changed before the task's base | Condition 4 fails. No search starts. |
| The host cannot stop a gate run | The command runs on to its end. The gate operation stays open until then, its result is not used, and the run's other operations wait, as they do behind a check that cannot be stopped today. The hold can pass `holdUntil` by that time. |
| The host restarts during a gate run | The gate run is never replayed. The run blocks with the interrupted-operation reason, as it does for an interrupted check today. The owner's reconciliation of an interrupted check gains the `gate` kind, with its conditions unchanged: a quiet run, no process of the gate run that the host still sees, and the owner's attestation. It clears the intent, removes the gate clone, and abandons the search. After a `measure` gate run the run then goes on to its final check round. A `live` gate run can be interrupted while members work. The block stops them, and the run continues only as a blocked run does today: with a new plan, under a new revision (owner decision 13). |
| The host restarts during another workspace operation of a search: a challenger's preparation, a capture, or an integration | Today's rule for an interrupted operation of that kind applies unchanged, and the search is abandoned. A `live` search adds such operations to a run: one preparation for each challenger and one capture for each result. |
| The host restarts while the run has no workspace operation open | The search resumes from `task.search`. Events and the `searches` row are idempotent by key, and no second challenger starts for a contestant. |
| The evidence store is unavailable | No search starts. An open search finishes in the run record, and reconciliation writes its row and its classification later. |
| Searches are paused, or the share is used up, during a search | The open search finishes. The next one does not start. |

## Changes this design asks of its siblings

- **Objective record design.** The owner's criterion input gains `pinned`, a list of up to 8 paths, on `criterion.add` and `criterion.edit`, as an amendment to its step 2. Nothing else changes: a criterion still never adds a command, and this design reads `pinned` as that design uses it, as the files that define a check.
- **Team plan schema.** `teamTaskPlanSchema` gains `criterion`.
- **Team workspace operations.** A fifth operation kind, `gate`, and a capture that integration does not follow at once. The owner's reconciliation of an interrupted check accepts the `gate` kind, with its conditions unchanged.
- **Outcome ledger design.** A fifth source, `search`: every attempt of an assignment that `search.started` marks. `search.resolved` and `search.abandoned` set `out-of-scope` and `gate-failed` as `duel.resolved` does. They set `not-chosen`, with exclusion `search`, for a captured result that was never gated. Under a duel that disposition means a result that passed the gate. A challenger's `attempt_index` counts it after the champion, in start order.
- **Umbrella.** Its table of designs gains this one. In C6 the list of sources gains `search`. In C11 the search policy joins the settings inside the routine digest, for the duel policy's reason: it changes who does the work.
- **Duels design.** Its conditions 3 and 8 count a search as an experiment on the task and as an open duel of the run.
- **Evidence router design.** The choice does not change. A pure helper of the router module returns a decision's candidates in the order of Part 2.

## Delivery order

Each phase is its own pull request.

1. **The search engine.** A pure module that applies admission, widening, a gate result, a leave, the wait, the hold, and the release to `task.search`, with a seeded simulator of its orders. Nothing imports it.
2. **A gate run at a commit.** The gate clone, the `gate` operation with its stop and restart rules, and its reconciliation. The duels design's gate needs the same piece.
3. **Measure mode.** The policy and its pin, the `criterion` field, admission, the two gate runs before the final check round, the `searches` table, and `infinite search status`.
4. **Live search.** The base run during the work, a capture that is not integrated at once, hold and choose, challengers, the release, the ledger source, and the brake.
5. **Client views.**

Phases 3 and 4 need the router in `auto` and owner criteria with `command` checks in goal records, which are on `main`. They also need the owner's `pinned` input, which is not built. No phase needs the eval identity, a judge, the learning budget, or the assumption tests of the objective record design.

## Acceptance

1. With mode `off`, generated prompts, scheduling, and stored records match today's.
2. A plan whose `criterion` names no criterion of the run's pinned digest is refused. A plan with a valid `criterion` and mode `off` runs as today. A task whose criterion is derived, or pins no file, gets a single attempt, and the status counts condition 3.
3. In `live` mode, with conditions 1 to 7 true and a command that fails at `baseCommit`, the search is `armed` and one implementer works. With a command that passes at `baseCommit`, the search is abandoned and the task runs as today, with a `production` row.
4. In `measure` mode every result is captured, integrated, and scheduled as today, and no second implementer starts. Before the first final check round the host runs the base run and, after it fails, the gate at the champion's captured commit. The `searches` row holds both results, the search is `measured`, and the champion's row has source `production`. A used-up share does not stop a `measure` search.
5. In `measure` mode a champion that stalls, escalates, or reports a blocker ends the search as `abandoned` with that reason. The result of the member that replaces it is not measured.
6. Under `after-fail`, a champion result that passes its gate integrates, and no second implementer ever starts for the task. A champion result that fails its gate is not integrated, and challengers start on the champion's `baseCommit`, each of a family that no other contestant has. No challenger starts when the champion's family is unknown.
7. Under `together`, challengers start when the base run fails and conditions 9 to 12 hold. When they do not hold, the search stays `armed`, and it widens when the champion's result fails its gate.
8. The first result that passes its gate is integrated in plan order, `task.memberId` names its member, and every other running contestant is stopped with no replacement. A result that was captured before the pass and not yet gated is never gated, and its row is `not-chosen`.
9. A result that changes a pinned file, or a path outside the task's owned paths, fails with `fail-scope` and does not block the run while the search goes on.
10. When every result fails, when the wait ends with no capture left to gate, or at `holdUntil`, the task is released: the champion's captured result integrates as today and the final check round runs. When the champion stalled and no challenger passed, today's stall replacement starts then, and not before.
11. At `holdUntil` the search is `exhausted` and the host stops its open gate run. When that gate run has closed, nothing of the search holds the task: the champion's captured result is integrated when plan order and the run's operation slot allow.
12. A `question` from the champion abandons the search, stops every challenger, and blocks the run as today. Every attempt of a task whose `live` search was armed keeps source `search` after the abandonment.
13. No challenger starts when it would take `spareAttempts(run)` below 3, and the host makes no `assertBudget` call that the limit refuses. With eight attempts left and one task not yet integrated, a search starts one challenger and no second.
14. No `live` search starts when the run has had two searches, when the allowance does not fit before the deadline, or when the share is used up. Each case counts its condition. When every free worker slot has a ready task as the champion's result fails, no challenger starts, and the search is `exhausted`.
15. After a resolved search, a later member's context file has no `search` field and no report of a contestant that was not integrated.
16. A restart while the run has no workspace operation open resumes the search with the same contestants and one `searches` row. A restart during a gate run starts no second command and blocks the run as an interrupted check does. Its reconciliation has the conditions of an interrupted check's, clears the intent, and abandons the search. A restart during a challenger's preparation or a capture gets today's handling of that interrupted operation.
17. With 10 widened searches of which 1 is `rescued`, the next task that meets every other condition gets a single attempt, and the status shows the pause.
18. Every attempt of a task whose `live` search was armed has source `search`, a stall replacement after the release included, and no production cell counts it.

## Owner decisions

Each value below was my call.

1. **Measure first.** Run `measure` until about 20 first results are recorded, and then decide on `live`. `measure` costs two command runs for each eligible task, delays the run's final check round by them, and starts no extra attempt. A host restart during one of them blocks the run as a restart during its final check does today.
2. **When challengers start.** `after-fail` by default, `together` as an option. `together` finishes sooner and pays for challengers on every search.
3. **The numbers.** A share of 0.1 with a ceiling of 0.25, three attempts with a ceiling of four, two searches per run, 15 minutes for a gate command, and a wait of 60 minutes. With the defaults a `live` search may hold a result for up to 200 minutes.
4. **The wait.** A challenger that is still working 60 minutes after the champion's result failed is stopped. A single attempt has no such limit.
5. **The reserve.** A challenger starts only while `spareAttempts(run)` stays at 3 or more: one attempt for each task not yet integrated, and six for the longest planned sequence after the last integration. It is a rule of thumb, and a run can still reach its attempt limit sooner than without the search. A lower floor widens more often in a run that is near its limit.
6. **Slots.** A challenger takes only a slot that no ready task needs, and keeps it when a task becomes ready later. The other choice stops the newest challenger for that task.
7. **Pinned files and origin.** Only an owner criterion with at least one pinned file opens a search. Without the rule, more criteria qualify, and a result that weakens the test can win. The rule needs the owner's `pinned` input, which is not built.
8. **Evidence.** `search` rows stay out of the router, and a gated pass beside a gated failure is not counted as a pair. Counting it would add judge-free pairs to the duels design's statistic.
9. **The brake.** Pause below 2 rescues in the last 10 widened searches.
10. **Permission prompts.** A challenger leaves at its first provider permission prompt, as a duel's challenger does. The other choice lets it use the run's delegated permission reviewer under the run's cap.
11. **Autonomy.** The mode stays `off` in an autonomous project until the owner sets it. Duels default to `live` there.
12. **The plan field.** A coordinator, which is a model, names the criterion a task must turn. The host checks everything else. Without the field the host cannot tell which task a failing criterion belongs to.
13. **A restart during a search's operations.** A `live` search adds workspace operations to a run while members work: a base run, a capture and a gate run for each result, and a preparation for each challenger. A host restart during one blocks the run under today's rules, and a block stops the members at work. After an interrupted gate run, the owner's reconciliation releases the run. The other choice lets the host release an interrupted gate run alone when it sees no process of it. That is a weaker fence than a check has today.

## Left to the builder

- The Git commands that build a gate clone at a commit, and how one clone is reused between the gate runs of a search without carrying a file from one result to the next. A new command form needs an entry in the server's owner-approved team command list.
- The fields of the `gate` operation's intent, and how the process census matches a gate run's processes.
- Whether a capture that is not integrated at once is its own operation kind or a form of today's result operation.
- How the captured commit of an integrated result stays readable until its `measure` gate run.
- The order of candidates that have no stored utility.
- How `TeamService` reads the goal's record at the pinned version. The goal service owns that record.
- The wording of the coordinator prompt's sentence about `criterion`.
- The layout of `infinite search status` and the client views.
