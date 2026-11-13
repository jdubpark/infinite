# Objective record and provisional verdicts (INF-181 amendment)

Date: 2026-11-13. Status: design for review. Part of the continuous autonomy amendment to `2026-11-12-self-improving-teams-design.md`, which defines contracts C12 to C19. This design delivers C14 and decision D5, and the outcome measures for work with no commit.

## Intent

The owner wants goals that keep working without them. An unattended goal needs three things it lacks today: a statement of "done" that a party other than the worker can check, a record of what the team assumed where the request was silent, and a verdict after each cycle that lets the next cycle start or stop.

This design adds one host-owned, versioned **objective record** per goal and per standalone run. It holds the statement, definitions, constraints, non-goals, criteria that each name a check, a producer, and a threshold, an assumption register, open questions, the evaluator rubric version, and a decision log. An **intent check** at plan acceptance fills the register. An independent **evaluator** gives a provisional verdict after each cycle. The owner's assessment stays final. The coordinator may queue **follow-up work** inside the record's criteria and paths. Scout findings get **measures** of their own.

The amendment's principle applies throughout. The system acts without the owner when the action is reversible, its outcome is established by a host receipt or an independent evaluator, and it stays inside the spend fuse and the project's authority. A provisional verdict lets a cycle start or a goal stop. Both are reversible. A provisional verdict never records a goal as achieved.

## Current state

Observed in this worktree:

- `createGoalSchema` (`packages/host/src/goal-types.ts`) takes `objective` (12,000 characters), `successCriteria` as one string (4,000), `nonGoals` (20 strings), `allowedPaths` (32), and `evidence` (20 strings). A criterion names no check, producer, or threshold.
- `steer` in `packages/host/src/goals.ts` appends `{ text, revision, at }` to `goal.steering`: at most 20 entries, and 24,000 bytes together with the objective. The next cycle's objective is the goal objective followed by `User direction:` lines. Steering never edits criteria, scope, or limits.
- `outcome` accepts `achieved`, `not-achieved`, or `inconclusive` with a summary and evidence, only on a terminal goal with no active cycle. Only `achieved` sets the status `achieved`. No member can call it.
- When a cycle settles, the goal scheduler starts the next one until `goal.cycles.length >= goal.maxRuns` (at most 10). Nothing compares a cycle with the criteria. A coordinator `no-change` report stops the goal as `no-opportunity`, or as `ready-for-review` when an earlier cycle produced reviewed work.
- `TeamGoalContext` (`packages/host/src/team-types.ts`) carries `successCriteria`, `nonGoals`, `allowedPaths`, `evidence`, and `previousWork` into each run. `teamPrompt` prints the whole context into every role's prompt as "Approved goal context", followed by "Ask for a user decision if a material scope decision is required."
- `consume` in `packages/host/src/teams.ts` refuses a goal plan without a brief (`goal-brief-required`) and a task path outside `allowedPaths` (`goal-scope-violation`). The prompt lets a brief's `evidence` hold "a relevant fact or clearly marked hypothesis". Hypotheses sit beside facts, and nothing tracks them.
- The coordinator may request one batch of 1 to 3 scouts before planning (`explore`). A second batch is refused (`discovery-already-used`). A scout reports `findings` of 1 to 12 `{ source, observation }` items and may not commission agents.
- A member question is one `question` report of up to 4,000 characters and four options. It becomes a `TeamDecision`, which the owner or a coordinator answers.
- The reviewer reviews the integrated change "against the objective, task acceptance criteria, and recorded checks". No role judges a cycle against the goal's success criteria.
- `rateTask` rates tasks in `run.tasks` only. Scout tasks live in `run.discovery.tasks` and cannot be rated.
- The outcome ledger design gives a scout row disposition `completed` and no levels. Its goal roll-up shows the owner's verdict, called a goal assessment.
- A mission (`packages/host/src/mission-types.ts`) has an objective of 24,000 characters and no success criteria.

Two statements in the amendment brief differ from the code. The brief says cycles wait for the owner's verdict. They do not wait: they run until the cycle limit, the time limit, or a `no-change` report, and nothing checks the criteria in between. The brief says the planner works inside one request. A goal's coordinator already chooses the next change in each cycle. What is missing is a durable queue for follow-up work and a host scope check on it.

## Goals

1. A record whose criteria each name a check, a producer other than the worker, and a threshold, so a cycle can be judged without the owner.
2. Assumptions written down, each with a status, the observation that would refute it, and the test that settles it.
3. Fewer owner questions. The intent check assumes and records, or sends a scout, and asks only what only the owner knows.
4. A provisional verdict after each cycle, kept apart from host receipts and from the owner's assessment.
5. Follow-up work that the host checks against scope, with out-of-scope ideas queued for the owner and repeated self-generated work bounded.
6. Measures for scout findings that leave the ledger's four levels unchanged.

## Non-goals

- Judging whether an objective is met. The host checks shape only.
- Mission-level records. A subteam run gets a run record from its subtask objective, as a standalone run does.
- Reopening a goal after a later regression. A goal stopped on a provisional `met` stays stopped until the owner acts.
- Learning on the record. No learning changes a criterion, a constraint, or the register.
- Client screen design. This design names what each client shows.

## Anti-goals

- **A team that writes its own finish line.** A member never adds, edits, or retires a criterion. A derived criterion never replaces the owner's text.
- **A verdict that reads as a receipt.** An evaluator assessment is always labelled an agent assessment.
- **Questions as a reflex.** Each open question costs owner attention, which the owner decided to save.
- **Assumptions that become facts by repetition.** A status changes only on a host receipt or an owner direction.
- **Self-generated work that never ends.**

## Approaches

1. **Let the reviewer judge the goal.** The reviewer already reads the objective and the checks. It shares the cycle's context and may share a model with an implementer. It reviews a change, not an outcome, and nothing records assumptions.
2. **Owner-written criteria only.** The owner writes every criterion and check at creation, and nothing is derived. This is the most honest form. Owners write one paragraph of success text today, so an autonomous goal would wait for the owner before its first cycle.
3. **A host-owned record, an intent check, and a separate evaluator. Picked.** The owner's text stays criterion `c0`, which the evaluator judges in every verdict. The intent check derives criteria with named checks from that text, labelled as derived. Read-only members judge. The host enforces the shape and composes the verdict.

The research supports approach 3. A per-turn intent check lifted resolve rate from 61.2% to 69.4% on underspecified coding tasks (arXiv 2603.26233). A tracker of assumption status raised accuracy by 4.4 to 16.1 points (arXiv 2602.07549). One added verification step raised task success by 15.6% (arXiv 2503.13657).

## Design

### Part 1. The record

```ts
type ObjectiveRecord = {
  schemaVersion: 1;
  owner: { kind: "goal"; goalId: string } | { kind: "run"; runId: string };
  version: number;                 // +1 on every change
  digest: string;                  // SHA-256 of the canonical record without `log`
  statement: { objective: string; directions: { id: string; text: string; source: "steering" | "correction"; at: string }[] };
  definitions: { id: string; term: string; meaning: string }[];        // ≤ 16
  constraints: { allowedPaths: string[]; excludedPaths: string[]; rules: { id: string; text: string }[] };  // rules ≤ 16
  nonGoals: { id: string; text: string }[];                            // ≤ 20
  ownerEvidence: string[];                                             // the goal's `evidence`
  criteria: Criterion[];           // ≤ 8 active, c0 included
  assumptions: Assumption[];       // ≤ 32 active (Part 3)
  questions: { id: string; text: string; assumptions: string[]; waits: boolean; decisionId?: string;
               state: "open" | "answered" | "dismissed" | "default-kept" }[];   // ≤ 8 open
  rubricVersion: number;           // the evaluator rubric
  log: LogEntry[];
};
type Criterion = {
  id: string;                      // "c0" is the owner's success text
  origin: "owner" | "derived";
  derivedFrom?: string;            // a quote of the statement, ≤ 500 bytes, required when derived
  statement: string;               // ≤ 1,000 bytes; c0 ≤ 16,000 bytes (Creation)
  check: Check; producer: "host" | "evaluator" | "owner"; threshold: Threshold;
  pinned?: { path: string; blob: string }[];   // files whose change voids a met state
  latest?: { state: "met" | "not-met" | "inconclusive" | "pending-owner"; note?: string; verdictId: string };
  state: "active" | "retired";
};
type Check =
  | { kind: "command"; command: string }        // digest of a configured or accepted check command
  | { kind: "receipt"; receipt: "checks-passed" | "review-approved" | "merged" | "landed" }
  | { kind: "artifact"; path: string; schema?: string; count?: string }   // count: JSON pointer to an array
  | { kind: "citations" | "citation-form"; path: string; entries: string; perEntry: number } // Part 7
  | { kind: "judgement"; item: string }         // an item of the pinned rubric
  | { kind: "owner-rating"; subject: string };
type Threshold = { kind: "pass" } | { kind: "count"; min?: number; max?: number }
  | { kind: "share"; min: number } | { kind: "score"; min: number; of: 5 };
```

The host validates shape on every write. A `command`, `receipt`, `artifact`, `citations`, or `citation-form` check needs producer `host`. A `judgement` check needs producer `evaluator`. An `owner-rating` check needs producer `owner`. No other producer exists, so no criterion is produced by the worker. The threshold must fit the check: `pass` for a command, a receipt, or a judgement; `count` for an artifact with `count`; `share` for both citation checks; `score` for an owner rating. A `command` digest must match a command in the project's configured checks or the run's accepted verification, so a criterion never adds a command. The host records the blob id of an artifact `schema` and of every `pinned` path when the criterion is written.

**Creation.** `create` builds version 1 from the goal fields. `c0` is the owner's `successCriteria` text, with check `judgement` on rubric item `owner-text`, producer `evaluator`, and threshold `pass`. `createGoalSchema` gains optional `criteria`: owner criteria, validated by the same rules. `c0`'s statement has its own bound of 16,000 bytes, which holds any `successCriteria` that `createGoalSchema` accepts (4,000 characters of up to 4 bytes each), so no valid goal is truncated. A standalone run gets version 1 from its objective when its first plan arrives. Its `c0` refers to `statement.objective` instead of copying it, because a team objective may hold 24,000 characters. An existing goal gets a record on load by the same rule, logged `migrated`. *(My call: `c0` keeps the owner's own words inside every verdict, so derived criteria cannot narrow "done" unnoticed.)*

**Storage.** The current record and its log live in the sealed goal record (`goals/<id>.sealed`, through `writeSealed`), or in the sealed run record for a standalone run. The record is authority for scope and for the meaning of "done", and contract C1 keeps authority in sealed records. The parts copied from owner input (the objective, steering directions, non-goals, owner evidence, and `c0`) are bounded by the API that accepted them, as today: a goal's creation request is at most 40,000 bytes, and its steering at most 24,000 bytes together with the objective. They do not count against the record cap. The rest of the record's canonical JSON, without the log, is at most 32 KiB, so a goal's record stays under about 96 KiB. A write past the cap is refused with `objective-too-large`. The sealed record keeps the newest 400 log entries, up to 256 KiB. Older entries move to the table `objective_log` of the evidence store module `objective`, encrypted per C1, and are deleted with their goal or run.

```ts
type LogEntry = {
  seq: number; at: string; version: number;     // the version this entry created
  actor: "host" | "owner" | "intent-check" | "coordinator" | "evaluator" | "member";
  authority: "receipt" | "direction" | "claim";
  op: string;                                   // for example "criterion.derived", "assumption.status"
  target: string;                               // a criterion, assumption, question, or follow-up ID
  before?: LogValue; after?: LogValue;          // always the full value, inline or by handle
  handle?: string;                              // a receipt, entry, owner input, or report ID
};
type LogValue = { inline: unknown } | { ref: string; digest: string; bytes: number };   // ref above 2 KiB
```

Every replaced value is kept in full. A value of at most 2 KiB sits inline. A larger value goes to a row of the table `objective_values` in the same store module, encrypted per C1, and the entry holds its handle and digest. These rows keep the log's retention: they are deleted with their goal or run. Until the store accepts a row, its full value waits in the sealed record's outbox, so no write loses it. When the store is unavailable, a reader sees the digest and "value unavailable", and a rebuild names each field it could not restore. *(My call: the log replayed backwards rebuilds any version, so no full copy of a past version is stored.)*

### Part 2. Who changes which part

| Part | Written at creation by | Changed by |
|---|---|---|
| Statement | owner | owner steering and owner corrections append directions |
| Definitions, rules, non-goals, excluded paths | owner | owner correction only |
| Allowed paths | the goal, mirrored | never through the record. Widening needs a new goal, as today |
| Criteria | owner (`c0` and any `criteria`) | the intent check adds derived criteria (Part 4). The owner confirms, edits, retires, adds, and gives owner values |
| Assumptions | intent check, owner | status: the host on a receipt, the owner by direction. Members propose (Part 3) |
| Open questions | intent check | an owner answer or dismissal, or the cap (Part 4) |
| Rubric version | host default | owner correction. A Class B change under C15 |
| Log | host | append only |

An agent's reading of a term is an assumption, never a definition. The owner can promote an assumption into a definition with one correction.

**Steering.** A steering message keeps today's limits and today's path into the run objective. It also appends a direction with source `steering` and raises the version. It changes no criterion and no assumption. The next intent check reads the direction as part of the statement, and may derive criteria from it by quoting it.

**Owner correction.** `POST /api/goals/:id/record` (owner only) takes `{ requestId, version, ops }`. An op confirms a derived criterion (its origin becomes `owner`), edits, adds, or retires a criterion, records an owner value, sets or unpins an assumption's status, answers or dismisses a question, promotes an assumption, edits a definition, a rule, a non-goal, or an excluded path, or sets the rubric version. A stale `version` gets 409. All ops apply in one write and raise the version once. A standalone run takes the same body at `POST /api/teams/:id/record`.

A running member keeps the record version pinned at its launch. Assumption statuses and question answers also reach running members at once, as blackboard `direction` entries. Other changes apply from the next member start. The evaluator reads the latest version, because its verdict decides whether more work is needed under the current meaning of "done".

### Part 3. The assumption register

```ts
type Assumption = {
  id: string; statement: string;                 // ≤ 500 bytes
  status: "verified" | "assumed" | "refuted" | "unchecked";
  origin: "intent-check" | "member" | "owner";
  criticality: "outcome" | "plan" | "detail";    // outcome: refuting it changes what "done" means
  refutedBy: string;                             // the observation that would refute it, ≤ 500 bytes
  test: AssumptionTest;
  evidence: string[];                            // handles, ≤ 16
  proposals: { entryId: string; stance: "supports" | "contradicts"; summary: string; authorRole: string }[];  // ≤ 8
  question?: string;                             // the open question that carries it
  ownerPinned?: boolean;
};
type AssumptionTest =
  | { kind: "command"; command: string; refutesOn: "fail" | "pass" }
  | { kind: "artifact"; path: string; count: string; citedPerEntry?: number; threshold: Threshold }
  | { kind: "citation"; source: string; quote: string; refutesOn: "absent" | "present" }
  | { kind: "owner"; rating?: { subject: string; below: number } };
```

`assumed` means work proceeds as if it were true. `unchecked` means nobody has tested or decided it, and no task may depend on it. `verified` and `refuted` each need a handle.

**Status changes.** A status changes only on a host receipt or an owner direction. The host runs each test when its input exists, and no test runs a new command. A `command` test reads the result of that check at the final check round of each cycle. An `artifact` or `citation` test runs when a cycle settles, against the reviewed head. The result sets `verified` or `refuted`, and the log stores the receipt handle. An `owner` test changes only by an owner op, or by the owner rating it names. An owner-set status is pinned: later receipts attach as evidence and change nothing until the owner unpins it.

**Proposals.** A member changes the register only through a `finding` entry (C17) whose body names an assumption, as `assumption: { id, stance }` or `assumption: { propose: { statement, refutedBy, test, criticality } }`. A reader's `findings` result counts the same, because C16 ingests it as an entry. At ingest the host attaches a stance proposal to its assumption, with the entry's summary and author role, and changes no status. A new proposal becomes an `unchecked` assumption with origin `member`, at most 4 per attempt. A member cannot change a test, a criticality, or a status. The next intent check sorts every `unchecked` assumption.

**Refutation.** When a receipt refutes an `outcome` assumption, the current cycle continues and the next cycle does not start. The host raises the C18 reason "a refuted assumption that changes what done means", and the owner answers with a correction. A refuted `plan` or `detail` assumption reaches the coordinator through the record digest, and the coordinator replans around it. A contradicting proposal appears in the daily digest as a challenge and interrupts nobody.

### Part 4. The intent check

**When.** In `consume`, after a plan passes today's checks and before `run.tasks` is set, the host keeps the plan as `run.pendingPlan` and starts a read-only member with role `intent-checker`. It runs once per run revision, in every goal cycle and standalone run whose pinned mode is `autonomous` (C12). In `supervised` mode it runs only when the project sets `objective.intentCheck: "on"`, so supervised projects keep today's flow by default.

**Who.** The profile comes from the lineup's `evaluators` list of at most 4 strong profiles, placed after `permissionReviewer` because lineup fingerprints follow key order. When a lineup names none, the list is derived when the lineup is read, as part 2 of `2026-11-13-continuous-autonomy-design.md` defines. It is never a schema default (C11). The host picks the first listed profile whose family differs from the coordinator's, by the family function of C19. C13 admits the launch. When no listed profile is eligible, the enrollment view shows `autonomyReady: false` with the reason, and the goal or run pins `supervised`. The lineup alone decides this, so it is known before the first cycle.

**What it reads.** The record, the pending plan with its brief, the discovery findings, the open follow-ups, and the repository at the run's base. It reads no member reasoning beyond the plan, and no score of any kind.

**What it reports.**

```ts
{ kind: "intent-check"; summary: string;
  items: {                                   // 0 to 16
    dimension: string;                       // what the request left unspecified, ≤ 200 bytes
    why: string;                             // what it changes in the plan or the outcome, ≤ 500 bytes
    criticality: "outcome" | "plan" | "detail";
    disposition: "ask" | "scout" | "assume";
    assumption: { statement: string; refutedBy: string; test: AssumptionTest };   // the default
    question?: { text: string; options: string[];                                 // ask only, with
                 default?: string; interrupt?: "definition" };                    // exactly one of these
    scout?: string;                          // scout only: one bounded research question
  }[];
  criteria?: DerivedCriterion[];             // only on a goal's first check, or the first after a statement change
  outOfScope?: string[];                     // follow-up IDs the plan takes that fall outside the objective
}
```

Every item records an assumption, so every gap is written down. The host applies the items:

- **assume**: the assumption is added as `assumed`.
- **scout**: the assumption is added as `unchecked`. The scout questions, at most 3, become one host-built read request of one phase of `findings` steps on the project manager's behalf (C16). It counts as one of the project manager's read requests for the revision. When the request ends, the host settles each scout item before the corrected plan. If the item's test can run on the run's base (a recorded `command` result, or an `artifact` or `citation` test at the base commit), that receipt sets `verified` or `refuted`. Otherwise the item becomes `assumed` when its step completed and no finding from that step attached a `contradicts` proposal to it. The receipt is the step's completion. A finding's content stays a claim, attached as a proposal, and never sets `verified`. A contradicted item stays `unchecked`. The corrected plan may depend on `assumed` and `verified` items, must plan around `unchecked` and `refuted` ones, and each test runs again when the cycle settles.
- **ask**: in autonomous mode, an ask item is converted to `assume` when its criticality is not `outcome`, or when its test kind is not `owner`, since then the owner is not the only one who knows. The log records each conversion. *(My call: converting costs nothing, while refusing costs a checker round.)* The question fields follow the continuous autonomy design: a question carries `default` or `interrupt`, and the host refuses a question with neither and gives one correction. An outcome item whose question has `default` is added as `assumed`, its question goes to the record and the daily digest, and work continues on the default. An outcome item whose question has `interrupt` is added as `unchecked` and waits. In supervised mode every ask item waits.

Waiting ask items become one blocking `question` decision on the run: the existing structured question. Its text numbers each item with its dimension and default, within 4,000 characters. Its options are "Use the stated defaults" and "I will answer each item". In autonomous mode it carries `interrupt: "definition"`, C18 reason 4, because each waiting item asks what "done" means. The decision carries the record's question IDs, so a client can show a control per item. A per-item answer is an owner op and can set an assumption's status. A free-text answer reaches the project manager as today and is logged as a direction, and it sets no status. Ask items that do not wait stay open questions in the record, and C18 carries them in the daily digest. When a ninth question opens, the oldest one that does not wait closes as `default-kept`.

The pending plan is accepted at once when nothing waits and no scout was sent. Otherwise it waits for the scouts and the answer. The project manager then gets one corrected-plan attempt with the findings, the answers, and the new assumptions, through the path `consume` uses today for a plan that included unauthorized verification. The corrected plan gets today's checks and no second intent check.

**Derived criteria.** A derived criterion has the shape of Part 1, origin `derived`, and a `derivedFrom` quote. The host checks that the quote appears in the statement and that the shape is valid. It drops an invalid criterion and logs why. Derived criteria take effect at once and show as derived until the owner confirms them. They never edit or replace `c0` or an owner criterion, and together with them they stay within the cap of 8.

**Failure.** If the checker stalls or ends without a report, one replacement starts. A second failure accepts the plan unchecked and logs `intent-check-skipped`. *(My call: a missing check should not stop a cycle, and the evaluator still judges `c0`.)*

### Part 5. Verdicts (C14, D3)

There are three kinds, never merged:

| Kind | Author | Label | Stored in |
|---|---|---|---|
| Host receipt | host | receipt | today's check, review, integration, and landing records, plus artifact and citation results in `GoalCycle.receipts` |
| Evaluator assessment | evaluator member | agent assessment, provisional | `GoalCycle.assessment`, and a numeric row in `objective_verdicts` |
| Owner assessment | owner | final | `ProductGoal.outcomes`, as today |

**When.** When a cycle's run settles as `ready-for-review`, `merged`, or `no-change`, the host starts an `evaluator` member before the goal launches anything else. A blocked or cancelled cycle gets none. The host picks the profile from `lineup.evaluators` by three rules, using the family function of C19:

1. **Hard rule.** The profile's family differs from the coordinator's, and the profile's model authored no integrated change in the cycle, as an implementer or integrator. A profile whose family C19 cannot name is not eligible, because C19 fails closed. The second clause is C9 rule 4, that a model never grades its own work. It is stated by model, so a second profile of the same model cannot pass.
2. **Preference.** Among eligible profiles, the host picks the first whose family neither authored nor reviewed a change in the cycle. Failing that, the first whose family authored nothing. Failing that, the first eligible profile.
3. **Flags.** The verdict row records `sharedFamily` (the evaluator's family authored an integrated change in the cycle) and `alsoReviewed` (the evaluator's model reviewed a change in the cycle).

Having reviewed a change does not exclude a profile. The evaluator works from the artifact-only context, so it sees neither its earlier review nor the author's reasoning. When no profile passes the hard rule, the verdict is `inconclusive` with reason `no-independent-evaluator`. The family clause is settled by the lineup at start (Part 4). This case remains only when every evaluator profile of another family than the coordinator's has a model that authored integrated work in the cycle. The lineup check therefore warns when an evaluator profile's model also sits in `implementers` or `escalations`. Per-change review independence is a separate rule, C19's. A standalone run gets a verdict after its review approves, for display only.

**What it reads.** The artifact-only context of C17. This design defines that context's named-checks field: the record's statement, definitions, rules, and non-goals, and each active criterion as `{ id, statement, check, producer, threshold }`. The field holds no assumption, question, proposal, log entry, or `latest` state, because those carry the reasoning of the intent checker and of earlier evaluators. The context also holds the reviewed head in a read-only clone (the goal's latest reviewed head after `no-change`), the changed files, the artifacts the criteria name, and the `check`, `integration`, and `direction` entries. It reads no member report, brief, finding, goal digest, earlier verdict, earlier owner assessment, rubric score, task rating, usage figure, routing data, or ledger row.

**What it reports.** `{ kind: "verdict", result, criteria: [{ id, state, evidence, note }] }`. A state is `met`, `not-met`, or `inconclusive`, with up to 8 evidence handles and a note of at most 500 bytes. A handle names a host receipt, a file range at the reviewed head, or a citation that passed the host check. A `met` state on a judgement criterion needs at least one handle.

**Composition.** The host keeps the evaluator's own result and computes the composed result:

1. A host criterion takes the state of its receipt at the reviewed head, whatever the evaluator said. A disagreement is logged as `evaluator-contradicted-receipt`.
2. A criterion whose `pinned` file changed in the cycle cannot be `met`. It is `inconclusive` until the owner pins the new blob.
3. An owner criterion is `met` or `not-met` by the owner's latest value against its threshold, when the owner recorded that value on the cycle's reviewed head. Otherwise it is `pending-owner`. *(My call: a value given on an older head judges older work, so a new head waits for a new rating.)*
4. An evaluator state whose handles do not resolve becomes `inconclusive`.
5. The result is `not-met` when any criterion with a known state is `not-met`, whoever produced it, owner criteria included. Else it is `inconclusive` when any criterion is `inconclusive`. Else it is `met`. Only `pending-owner` is exempt, and it never blocks `met`.

`c0` is always an evaluator criterion, so every composed result holds an agent judgement and carries the agent assessment label. The host writes each criterion's state and note into `latest` on the record, for the owner's display.

**Use in a goal.** In `autonomous` mode the composed result drives the goal:

- `met`, on a finite goal or a standing `until-met` goal (the goal shapes of `2026-11-13-continuous-autonomy-design.md`): the goal stops as `ready-for-review` with `stopReason: "provisional-met"`. Its status is never `achieved`. The owner records `achieved`, or `not-achieved` with `continue: true`. On a standing `objective` goal, a composed `met` is recorded as the provisional verdict, the goal does not stop, and its next cycle starts at its cadence.
- `not-met` or `inconclusive`: the next cycle starts under D1, C13, and the goal's allowances, at its cadence for an `objective` goal. The coordinator learns which criteria to work on through the status rule below.
- A cycle's **progress** is the change in the number of `met` criteria since the previous verdict. Three failed cycles in a row pause the goal with reason `repeated-failures` (C18 reason 5), and an owner resume resets the count. A cycle with a verdict fails when its composed result is not `met` and its progress is not positive. A cycle with no verdict fails when it ended blocked or cancelled for a cause inside the work, so no evaluator ran, and part 3.3 of the continuous autonomy design classifies it `failed`.

**Criterion status in the next cycle (decided 2026-11-13).** Each criterion's status enters the next cycle's coordinator prompt through the goal digest of C17, and through no other channel. An entry holds the criterion ID, its status, and the label of the named check it rests on. The digest carries C14's status values unchanged: `met`, `not-met`, `inconclusive`, or `pending-owner`. A check label is the check kind and its name, such as `command:npm run rank:verify` or `judgement:owner-text`, at most 120 bytes. An entry holds no score, measured value, threshold, note, model, or profile, and it is always labelled an agent assessment. It is a task finding, the same class as a review finding that reaches a repair today. C9 rule 3 does not cover it, because that rule bars learning signals: posteriors, rewards, routing decisions, replay, duel, and gate results, and usage figures. Without it the coordinator could not tell which criteria to work on, and D3 and D5 would fail. The status never reaches the member whose work was assessed as a score or a ranking. The evaluator's notes stay on the record for the owner.

In `supervised` mode the evaluator runs only when the project sets `objective.evaluator: "on"`. Its verdict is shown and changes nothing.

**Owner override.** The owner's assessment is final. `POST /api/goals/:id/outcome` gains two optional fields. `verdictId` names the provisional verdict the owner answers. `continue: true` is allowed only with `not-achieved` on a goal stopped by `provisional-met`. With it, the host appends the owner's summary to the record as a `correction` direction and starts the next cycle, or refuses with `goal-limit-reached` when the goal's allowances are spent. An owner who judges a goal achieved while cycles run pauses or cancels it and records `achieved`, as today.

**Display.** The goal page, the team page, and the digest show the composed result as "Agent assessment, provisional". Each criterion row shows its producer and its own label: host receipt, agent assessment, or waiting for you. A difference between the evaluator's own result and the composed result is shown. The owner's assessment shows as "Your assessment" and is the only source of the `achieved` status.

**Ledger.** `objective_verdicts` holds one row per verdict: the verdict ID, project and goal blind indexes, run ID, cycle, record version, rubric version, the evaluator's profile ID, provider, model, and family, `shared_family` and `also_reviewed` (the two flags of rule 3), both results, and a count per state. It holds no text and keeps the outcome rows' retention of 730 days. When the owner records an assessment with a `verdictId`, the row stores whether they agree: `met` with `achieved`, or `not-met` with `not-achieved`. The outcome ledger's goal roll-up shows the goal assessment and, under its own name, the latest agent assessment. No verdict changes `integrated`, `accepted`, `firstPass`, or `held`. The agreement rate per evaluator profile, split by `shared_family` and by `also_reviewed`, is a display cell only, so the ledger can show whether either kind of verdict differs. *(My call: an evaluator's calibration should be visible before anything acts on it.)*

### Part 6. Follow-up work (D5)

A goal coordinator's `plan` or `no-change` report may carry `followUps` (at most 6) and `followUpOrder` (the IDs of open follow-ups, in order):

```ts
type FollowUp = {
  id: string; title: string;                 // ≤ 100 bytes
  rationale: string;                         // ≤ 1,000 bytes
  criteria: string[];                        // ≥ 1 active criterion ID
  paths: string[];                           // owned-path rules, ≤ 32
  generation: number;                        // set by the host
  state: "open" | "taken" | "done" | "dropped";
};
```

Follow-ups live in the sealed goal record as `goal.followUps`, at most 24 open. A task in a later plan names the follow-up it takes (`followUp: id`). The follow-up is then `taken`. It becomes `done` when its tasks integrate, or `dropped` when its run ends without them.

**Host scope check.** At report time the host checks each follow-up:

1. Every criterion ID is active in the latest record.
2. Every path passes `teamPathAllowed` against `allowedPaths` and overlaps no excluded path.
3. Its digest of title, paths, and criteria matches no `done` or `dropped` follow-up of the last 10 cycles, unless a revert signal or an owner direction arrived since.
4. The open count stays at most 24, and the generation at most 3.

Generation is 1 when the opening cycle took no follow-up, and otherwise one more than the highest generation it took. Follow-up planning happens in a project manager attempt, so any read it needs is a C16 read request under the read pool rules. The host checks paths and links. The intent check judges meaning: a follow-up it lists in `outOfScope` leaves the plan and goes to the owner.

**Owner idea queue.** A follow-up that fails rule 1, 2, or 4, or that the intent check puts out of scope, is not dropped. It goes to `goal.ideas` with its reason: `no-criterion`, `outside-paths`, `generation`, `cap`, or `out-of-scope`. The queue holds 20 ideas and merges duplicates by digest. Ideas appear in the daily digest (C18). The owner can dismiss an idea, start a new goal from it with its fields filled in, or name a criterion so that it returns as a follow-up. A path outside the goal still needs a new goal. A failure of rule 3 is refused with a goal event. A standalone run has no follow-ups: whatever its coordinator proposes goes to the run's idea list.

**Bound on self-generated work.** A cycle that took only follow-ups and made no positive progress is a failed cycle by Part 5's progress count. Three failed cycles in a row pause the goal with reason `repeated-failures`, C18 reason 5, as the continuous autonomy design defines, so no further follow-up starts until the owner resumes it. The generation cap and the repeat window bound the work too, and the spend fuse (C13) bounds the money in every case.

### Part 7. Measures for work with no commit

A scout attempt has an outcome row with disposition `completed` and no levels. This design adds three **finding measures** in its own table, joined to the scout row by `outcome_id`:

```sql
CREATE TABLE finding_measures (
  outcome_id TEXT PRIMARY KEY,   -- the ledger's runId ':' memberId of a scout row
  cited INTEGER,                 -- 1, 0, NULL = unknown
  used INTEGER,                  -- 1, 0, NULL = unknown
  rating INTEGER,                -- owner score 1 to 5, or NULL
  citations INTEGER NOT NULL, checked INTEGER NOT NULL, failed INTEGER NOT NULL,
  window_closed_at TEXT
);
```

- **cited** (host, receipt). The host parses each `source` of the findings. A repository citation is `path`, `path#L10-L24`, or either with `@commit`. It passes when the blob exists at the commit (by default the scout's base), the lines exist, and an optional quoted span in the observation appears in those lines after whitespace folding. An outside citation passes only when the host holds the cited text itself, such as a document the owner supplied as goal evidence. No design supplies a host-recorded web fetch, so a web citation can only be checked for form. `cited` is 1 when every citation passed, 0 when any failed, and unknown when none failed and some could not be checked. The `citations` criterion and the `citation` test use the same check, and the criterion also requires `perEntry` citations per entry. A citation the host cannot resolve leaves a `citations` criterion `inconclusive`, never `met`. The separate `citation-form` check is form only. It passes an entry that has `perEntry` citations in the citation format, with outside ones on distinct hosts. It establishes that each entry names its sources in a checkable form. It does not establish that a source exists, that it says what is quoted, or that it supports the entry. An artifact test's `citedPerEntry` counts entries by this form check.
- **used** (a coordinator claim joined with a receipt). A task plan may name up to 4 findings in `uses`. `used` is 1 when an attempt of such a task ends with `accepted` yes and no `same-model-review` flag. It is 0 when the window closes without one. The window is the finding's run plus the goal's next cycle. It stays unknown while the window is open.
- **rating** (owner, claim). `rateTask` accepts a discovery task ID of the current revision.

The four ledger levels keep their meaning and stay empty on scout rows. A `scout` cell gains `findings: { cited: LevelCount; used: LevelCount; rating: { mean: number; n: number } | null }` beside `completed`. A `decision` query may read `cited` and `rating`. `used` rests on a coordinator's claim, so it is display only. The events are `objective.finding-cited`, `objective.finding-used`, and `objective.finding-rated`, and their projector runs in the outbox flush, as umbrella C2 allows.

### Part 8. What members read, API, and CLI

| Reader | Reads |
|---|---|
| Coordinator | the record digest, the open follow-ups, and the goal digest's criterion status (Part 5) in its prompt. The full record without its log or `latest` states in the context file |
| Implementer, integrator, reviewer | the record digest in its prompt. The reviewer still reviews the change, not the goal |
| Scout | the record digest, and the assumption it tests when the intent check sent it |
| Intent checker, evaluator | Parts 4 and 5 |

The record digest goes into `TeamGoalContext` as `record`: criteria (ID, statement, check label, producer), active assumptions with status, and open questions with defaults. It is at most 6 KiB plus `c0`'s statement, so at most 22 KiB. It replaces `successCriteria`, which can already take 16,000 bytes, so a prompt grows by at most 6 KiB, inside the 80 KiB limit. It carries no criterion status, which reaches the coordinator only through the goal digest. The goal context section that member prompts print today shows it in place of `successCriteria`, whose text is `c0`. Non-goals, allowed paths, and evidence print as today. In autonomous mode, the section's sentence "Ask for a user decision if a material scope decision is required" becomes an instruction to propose an assumption. No member reads the log, a verdict row, an agreement rate, a finding measure, or the evaluator's identity.

- `GET /api/goals/:id/record` and `GET /api/teams/:id/record` return the record and its log, for any paired device. `?version=N` rebuilds a past version.
- `POST /api/goals/:id/record` and `POST /api/teams/:id/record` apply owner ops.
- `GET /api/goals/:id/verdicts` returns each cycle's verdict with its receipts.
- `infinite goal record ID [--version N] [--json]`, with `confirm CID`, `retire CID`, `set-assumption AID STATUS`, and `answer QID TEXT`.

### Part 9. Worked example

The domain illustrates the method. A research repository is enrolled with the checks `npm test` and `npm run rank:verify`. The owner starts an autonomous goal: objective "Find the best founders to fund", success criteria "A ranked shortlist with reasons and sources", allowed paths `research/founders`.

The intent check on the first plan writes these items:

| Dimension | Criticality | Disposition | Default recorded |
|---|---|---|---|
| Fund thesis: stage, sector, region | outcome | ask, `default` | seed stage, software, any region |
| What "best" means | outcome | ask, `default` | most likely to raise a priced round within three years, judged from public track record |
| Size of the public candidate pool | plan | scout | enough public candidates exist |
| Candidates to exclude, such as current holdings | outcome | ask, `default` | exclude none |
| Limits on personal information | outcome | assume | public, professional information only |
| Output shape | detail | assume | one JSON file under a schema, 10 to 25 entries |

Nothing waits. The three ask items become open questions in the digest. The scout question becomes a one-phase read request, and the project manager then gets one corrected-plan attempt. The research reads outside content, so each run carries quarantined output and ends at a pull request instead of merging (C17). The next cycle continues from the reviewed head.

Five of the assumptions:

| ID | Statement | Starts | Refuted by | Test |
|---|---|---|---|---|
| a1 | The thesis is seed stage, software, any region | assumed | the owner names another thesis | owner |
| a2 | Public sources name at least 40 candidates in that thesis | unchecked | `research/founders/candidates.json` has fewer than 40 entries with two well-formed citations | artifact, count `/entries`, `citedPerEntry` 2, min 40 |
| a3 | A shipped product with public usage is a fair proxy for execution | assumed | the owner rates the top 10 below 3 on average | owner rating |
| a4 | The scoring fields in `method.md` match what the ranking check reads | unchecked | `npm run rank:verify` fails at a cycle's final check round | command, refutes on fail |
| a5 | Only public, professional information is collected | assumed | the owner says otherwise | owner |

The criteria:

| ID | Statement | Check | Producer | Threshold |
|---|---|---|---|---|
| c0 | A ranked shortlist with reasons and sources (owner text) | judgement `owner-text` | evaluator | pass |
| c1 | `research/founders/shortlist.json` validates against its pinned schema | artifact, count `/entries` | host | count 10 to 25 |
| c2 | Every entry names two sources in checkable form, on distinct hosts | citation-form, `perEntry` 2 | host | share 1.0 |
| c3 | Each reason follows from its quoted sources and the method in `research/founders/method.md` | judgement `method-applied` | evaluator | pass |
| c4 | The order reproduces from the recorded scores | command `npm run rank:verify`, pinned `research/founders/rank-verify.mjs` | host | pass |
| c5 | The owner rates the top 10 at 4 or more on average | owner rating `top-10` | owner | score 4 of 5 |

`c1` to `c5` are derived and quote the owner's text. c2 is a form-only `citation-form` check. It shows that each entry names two sources in checkable form, not that a source exists or says what is quoted. Nobody here checks a quote at its web source, and the record and verdict show that limit. In cycle 1, three entries cite one host twice, so c2 is `not-met`, and so is the composed result. Cycle 2 starts with that gap. In cycle 2 every host and evaluator criterion is met, and c5 waits for the owner. The goal stops as `provisional-met`. The owner rates the top 10 at 3.4 on average, so a3 stands and c5 is not met. The owner records `not-achieved` with `continue` and the note "weight repeat founders higher". Cycle 3 starts on the next record version.

## Authority and safety

- The host verifies that the record has its fields, that every criterion names a check, a permitted producer, and a fitting threshold, and that each derived criterion quotes the statement. It never judges whether the objective is met.
- Only the owner records `achieved`. A provisional `met` stops cycles, and the owner can undo that in one action.
- An assumption's status changes only on a host receipt or an owner direction. Member text reaches the register only as proposals, labelled as claims wherever it is shown.
- Learning changes no part of the record. The rubric version is a Class B change (C15). Criteria, constraints, the register, and the follow-up rules are outside learning.
- The intent checker and the evaluator are read-only. They have no entry-post tool, no edit, and no launch rights. Their launches pass C13 admission.
- An evaluator's family differs from the coordinator's, and its model authored no integrated change in its cycle (C9 rule 4, by model). A verdict carries `sharedFamily` when the evaluator's family authored an integrated change, and `alsoReviewed` when its model reviewed one. C19 defines the family function and per-change review independence, and fails closed for an unknown family.
- No posterior, reward, routing decision, eval result, usage figure, verdict row, or agreement rate enters a prompt. The coordinator gets each criterion's status and check label through the goal digest, labelled an agent assessment, and never a note, a score, a model, or a profile (Part 5). A test asserts that `team-prompts.ts` imports neither `objective_verdicts` nor `finding_measures`.
- The record holds goal text. It stays in sealed records and encrypted store rows. Durable rows hold identifiers, enumerations, and counts only (C1).
- A follow-up never widens scope. Allowed paths change only through the goal's own authority.
- The switches `objective.intentCheck` and `objective.evaluator`, and the `evaluators` lineup slot, are inside the routine approval digest (C11), because they change what a run does.

## Failure modes

| Failure | Behaviour |
|---|---|
| The fuse refuses the checker or the evaluator | The plan or the verdict waits with the fuse. Nothing is skipped silently |
| The evaluator stalls or hits a limit | One replacement, through the limit fallback. A second failure gives `inconclusive` with reason `evaluator-unavailable`. Three failed cycles in a row pause the goal with reason `repeated-failures` |
| No listed or derived evaluator profile differs in family from the coordinator | The enrollment view shows `autonomyReady: false` with the reason. The goal or run pins `supervised` at start |
| Every evaluator profile of another family than the coordinator's has a model that authored integrated work in the cycle | `inconclusive` with reason `no-independent-evaluator`. The lineup check warned that those models also sit in `implementers` or `escalations` |
| The evaluator's model reviewed a change in the cycle | It still judges, from the artifact-only context. The verdict carries `alsoReviewed` |
| The evaluator calls a failing check met | Composition rule 1 overrides it and logs it. The agreement cell shows the pattern |
| A team weakens a check or schema it can edit | A pinned file that changes voids `met`. The change shows in the digest |
| Derived criteria are weaker than the owner's text | `c0` is judged in every verdict. Derived criteria show as derived until confirmed |
| Proposal spam | 4 new assumptions per attempt, 8 stance proposals per assumption, 32 active assumptions. Excess proposals are dropped at ingest and counted |
| The record outgrows its cap | The write is refused with `objective-too-large`, and the owner consolidates |
| The evidence store is unavailable | The record and verdicts live in sealed records and keep working. Log overflow, verdict rows, and finding measures wait in the outbox |
| A handle expires with its run | The register keeps the summary, author role, and stance. The handle shows as expired |
| An owner correction races a running cycle | The `version` check refuses a stale write. Running members keep their pinned version. The evaluator reads the latest |

## Delivery order

1. **The record.** Schema, validation, storage in sealed goal and run records, migration of existing goals, the log, and the read API and CLI. Steering appends directions. Runs do not change.
2. **Owner ops and prompts.** The correction API, the record digest in prompts and the context file, and the `evaluators` lineup slot.
3. **The intent check.** The role, the report, item application, the batched question, the corrected-plan attempt, and derived criteria. Until C16 lands, a scout item is converted to `assume` and logged.
4. **Tests and proposals.** Command, artifact, citation, and owner tests. Proposals need the blackboard member tools (C17).
5. **Verdicts.** The evaluator role, composition, `provisional-met`, owner override with `continue`, display, and `objective_verdicts`.
6. **Follow-ups.** The report fields, the scope check, the idea queue, and the bound.
7. **Finding measures.** The two citation checks, `uses`, scout ratings, the table, and the scout cell.

## Acceptance

1. A goal created with one paragraph of success text gets record version 1 with `c0` only. `GET /api/goals/:id/record` returns it. A goal from before this change gets the same record on load, logged `migrated`.
2. An owner op that adds a criterion with producer `coordinator`, a `judgement` check with producer `host`, or a `command` that is not a configured or accepted check gets 400. A derived criterion whose quote is not in the statement is dropped and logged.
3. An autonomous intent check returns one outcome ask with an `owner` test and `interrupt: "definition"`, and one scout. The plan waits. One `question` decision lists the ask item. After the answer and the finding, the project manager's corrected plan is accepted with no second check.
4. In autonomous mode, an ask item with criticality `detail` is recorded as `assumed` with a log entry, and no decision opens.
5. A finding contradicts a2, and a2 stays `unchecked` with the proposal attached. The artifact test then counts 31 qualifying entries, so a2 becomes `refuted` with the receipt handle. a2 is a `plan` assumption, so nobody is interrupted.
6. The evaluator reports every criterion `met` while `npm run rank:verify` failed. The composed result is `not-met`, and the log holds `evaluator-contradicted-receipt`.
7. A composed `met` stops an autonomous `until-met` goal as `ready-for-review` with `stopReason: "provisional-met"`. Its status is not `achieved`. The owner records `not-achieved` with `continue`, and the next cycle starts on a new record version. On an `objective` goal, the same verdict is recorded, and the next cycle starts at its cadence.
8. A follow-up with a path outside `allowedPaths` lands in `goal.ideas` with reason `outside-paths`. Two cycles of follow-ups only with no positive progress, then a cycle blocked on failing checks with no verdict, pause the goal with reason `repeated-failures`. An owner resume resets the count.
9. A scout cites `src/a.ts#L10-L20` where the file has 15 lines, so its measure row has `cited` 0. A task that names the finding in `uses` is accepted, so `used` becomes 1. The scout's four levels stay empty.
10. After the cycle-1 verdict of Part 9, the cycle-2 coordinator prompt lists `c2` as `not-met` with check label `citation-form:research/founders/shortlist.json`, labelled an agent assessment. It holds no evaluator note, threshold, count of failing entries, or profile name. No rendered prompt of any role holds a verdict row, an agreement rate, a finding measure, or the evaluator's profile.
11. The lineup has a coordinator profile and a reviewer profile of another family, and light implementers of a third family. The `evaluators` slot lists the reviewer's profile, and a second profile of an implementer's model. After a cycle in which that implementer's work integrated, the reviewer's profile evaluates, and the row has `also_reviewed` 1 and `shared_family` 0. The second profile is never chosen, and the lineup check warned about it.

## Owner decisions

Values to confirm:

1. Record caps: 32 KiB for the parts not copied from owner input, so a goal's record stays under about 96 KiB. 8 active criteria with `c0`, 32 active assumptions, 8 open questions, and 16 definitions and rules each. The sealed record keeps 400 log entries, up to 256 KiB. *(My call: `c0` holds up to 16,000 bytes and the record digest up to 22 KiB, so that every valid goal migrates whole.)*
2. Intent check: 16 items, 3 scout questions, and one check per run revision.
3. Follow-ups: 6 per report, 24 open per goal, generation 3, a repeat window of 10 cycles, and 20 ideas per goal.
4. Proposals: 4 new assumptions per attempt and 8 stance proposals per assumption.
5. The `used` window: the finding's run plus the goal's next cycle.
6. In supervised mode, the intent check and the evaluator are off by default.

## Left to the builder

- Prompt wording for the intent checker, the evaluator, the record digest, and the citation format, within the byte budgets and their tests.
- Rubric version 1 for the evaluator: the items `owner-text` and `method-applied`, and how a project adds items. This design fixes only that each item yields `met`, `not-met`, or `inconclusive` with handles.
- Whether the router should avoid the `evaluators` profiles for a cycle's tasks, so one stays eligible at cycle end.
- Client screens on the web, the phone, and the Mac for the record, per-item answers, verdicts, and the idea queue.
- The Git reads for artifact, schema, and citation checks, and their timeouts.
- How `run.pendingPlan` survives a restart, and how it meets steer and resume.
- Whether a mission should hold a record of its own.
