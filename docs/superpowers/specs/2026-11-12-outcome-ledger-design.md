# Outcome ledger (INF-184)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

The owner asked how an agent's work is measured. Today a scorecard is computed on read from the run records the host still holds. It loses work when a record changes or is deleted, and it stops at "integrated".

This design gives every attempt one durable outcome row, written from typed events when each fact happens. The row records how the attempt ended, how far its work got (integrated, accepted, firstPass, held), and what it cost. Later facts, such as a revert on the base branch, attach as signals. The other designs use these rows and definitions unchanged.

## Current state

Observed in `packages/host/src` on `main`:

- `GET /api/usage/models` calls `scorecard(teams.list(), …)`. Its evidence is the run records the host holds, and `retire` and `removeRun` delete records.
- `scorecard` finds a member's task in `run.tasks`, which holds the current revision only. `steer`, `action` (resume), and `resumeVerificationRecovery` clear `run.tasks`. `continueRun` and `startAutomaticRecovery` move the tasks to `run.continuations`, which the scorecard does not read. An attempt integrated before any of these counts as not integrated.
- On a `changes-requested` review, `consume` adds one to `reviewRounds` on every integrated task. Nothing records which task needed the change.
- The scorecard excludes only attempts whose `stoppedReason` names a provider limit. An owner cancel, or a stop caused by another member's block, counts as a failure. A scout never counts as integrated.
- The host learns of a merge only from the delivery member's report. Nothing compares later base-branch commits with a run, although `ProjectSourceService` already mirrors a GitHub project's base branch (`mirrorHead`). `packages/host/src` makes no GitHub API call.

## Goals

- One durable row per attempt, kept when the run record changes or is deleted.
- Exact rules for integrated, accepted, firstPass, and held, with unknown as a stored value.
- Fair denominators. An attempt that ended for a cause outside itself is excluded and counted separately.
- Delayed signals with a stated author and authority.
- The scorecard API and `infinite usage models` keep their shape and read the ledger.
- Roll-ups per run, goal, and mission.

## Non-goals

- A scalar reward. The router design owns it.
- Token capture for Claude Code and Codex. The ledger stores what the usage ledger reports.
- Off-host work: laptop sessions, the operator's own delegation tools, and work merged outside a run. The operator's advisory routing ledger, kept outside this repository, enters only through the import in Part 8.
- Any change to how a run behaves.
- Rates for members that have no task.

## Anti-goals

- A level that claims more than the host observed.
- Blame spread over tasks that did nothing wrong.
- Measurement that blocks, slows, or changes a run.
- Run text in a durable row.

## Approaches

1. **Fix the on-read scorecard** to read `run.continuations`. It still loses deleted runs and the tasks that `steer` and resume clear. It cannot attribute a correction round or hold a delayed signal.
2. **Snapshot at settle** from the run record. It records only what the record still shows, so it inherits the same losses.
3. **Project from typed events.** It needs about twenty emission points in `TeamService`, and a new transition must remember to emit. Each fact is recorded when it is true.

The design uses approach 3, because capture cannot be backfilled. It uses approach 2 once, as a flagged backfill of the run records the host holds today.

## Design

### Part 1. Events and the outbox

`TeamService` gets a private `emit(stored, kind, ids, data)` that appends an event to `stored.outbox`, a new field of the sealed record. `save` writes the sealed record, appends the outbox to the store, and clears what it appended. On start, the service appends each loaded record's outbox again. That is the reconciliation pass of umbrella C1. An append is idempotent by key, so a crash between the two writes loses nothing and duplicates nothing.

`deleteRecord` emits `run.deleted`, flushes the outbox, and advances the projectors once before it removes the file. Retention waits for the store: when the flush fails, or a projector that is not blocked is still behind, it keeps the sealed record and a later tick tries again. It waits at most 24 hours from its first held attempt (`retention.evidenceHeldAt`), then removes the record and logs one line. A blocked projector does not hold a deletion, because it cannot catch up without a repair. An owner's explicit removal does not wait: it tries the flush and the advance once, then removes the record whatever the result.

*(My call: a persisted outbox, not a pass that re-derives lost events. `steer` and `repair` erase facts from the record, so re-derivation cannot be complete.)*

A key is the kind plus the run id, revision, member id, task id, and round that make the fact unique. A flush stores its events in one `write` call of the evidence store. It never waits for a projection, because capture cannot be repeated. Each projector then advances from its own cursor over the event table, in its own transaction: its rows and its cursor commit together, so it sees each matching event exactly once and in order. A projector that throws, or whose module is unavailable, keeps its cursor and catches up later, and the other projectors are not held back. A projector added in a later release starts at the first stored event. An outcome row therefore exists once its projector has passed its event, which a flush attempts at once.

*(Changed after review of the outbox: the first design projected inside the flush, and only the events that flush inserted. An event stored before its projector existed would then never be projected.)*

Another design may add event kinds under its own prefix and register a projector for them, as umbrella C2 allows. The duels design adds six `duel.` kinds.

| Kind | Emitted in | Data |
|---|---|---|
| `run.created` | `createRun` | project, base commit, purpose, goal, mission |
| `run.prepared` | `createRun` (prepare completion) | base commit |
| `plan.accepted` | `consume` (`plan`) | task count, plan digest |
| `task.planned` | `consume` (`plan`), once per task | profile, owned paths, features |
| `discovery.accepted` | `consume` (`explore`) | per scout task: profile |
| `member.started` | `launch` | role, purpose, session, profile identity, replaced member and cause |
| `member.configured` | `launch`, a read after the session starts | `configId` and its six components. Absent when the read fails |
| `member.reported` | `readMemberJournal` | report kind |
| `member.stopped` | `replaceStalledMember`, `switchLimitedMember`, `retireMember`, `step` (halt loop, exit branch) | reason class |
| `task.integrated` | `consume` (implementer `result`) | commit, head, base commit, diff counts |
| `scout.completed` | `consume` (`findings`) | |
| `task.escalated` | `consume` (`escalate`) | from and to profile |
| `task.limit-switched` | `switchLimitedMember` | from and to profile |
| `check.finished` | `check` | round, head, result per command |
| `review.recorded` | `consume` (`review`) | verdict, head, base commit, reviewer profile identity, rubric scores |
| `review.tree` | `consume` (`review`), a read after the review operation | head, reviewed tree; absent when the read fails |
| `repair.started` | `repair` | round, cause: `check`, `review`, `delivery` |
| `repair.integrated` | `consume` (integrator `result`) | round, commit, head, base commit |
| `repair.paths` | `consume` (integrator `result`), a read after the operation | round, commit, changed paths or `pathsOmitted` |
| `delivery.recorded` | `consume` (delivery reports) | `merge` or `pull-request`, head, merge commit |
| `rating.recorded` | `rateTask` | task, score |
| `run.blocked` | `block` | block code, source member |
| `run.revision-advanced` | `steer`, `action`, `continueRun`, `startAutomaticRecovery`, `resumeVerificationRecovery`, `consume` (moved base) | cause, base commit changed, recovery source |
| `run.settled` | `save`, `retire` | status, run summary counts |
| `run.deleted` | `deleteRecord` | |
| `ledger.gap` | `flushOutbox`, after a stored flush | dropped count |

`save` already detects every status change for retention. It emits `run.settled` when the status becomes `ready-for-review`, `merged`, `no-change`, or `cancelled`, and `retire` emits it when it removes a blocked run's workspace. The reason classes of `member.stopped` are `stall`, `limit`, `no-report`, `owner` (pause, cancel, steer), and `host` (a halt for another member's block or an automatic recovery, a deadline, the attempt limit, a runtime retirement). Two events need a new best-effort Git read: the integrator commit's changed paths, and the reviewed head's tree id.

### Part 2. Task features

The host computes features in the `plan` branch of `consume`. A project may set a feature map in its private team configuration (`teamProjectSchema`):

```ts
features?: {
  areas: { id: string; paths: string[] }[];  // id: /^[a-z][a-z0-9-]{0,39}$/
  elevated?: string[];                       // path prefixes
  elevatedTokens?: string[];                 // replaces the default list
}
```

**Area.** A path belongs to the area with the longest matching prefix (`teamPathAllowed`). Without a match, the area is a directory name with a trailing slash: the first two segments when the first is `apps`, `packages`, `services`, `libs`, `crates`, `cmd`, or `modules`, and the first segment otherwise. A root file has the area `root`. The trailing slash keeps a directory name apart from a mapped area id and from the reserved names. Test and documentation paths, by the predicates in `diffStat`, do not vote unless the task owns nothing else. The task's area is the single area of its voting paths, or `mixed`. A scout task has area `none`.

*(My call: without the voting rule most backend tasks here would be `mixed`, because tests live in a top-level directory.)*

**Kind.** `teamTaskPlanSchema` gains an optional `kind` with the six values of umbrella C4. An absent label is stored as null. A scout task is `investigation`.

**Risk.** Risk is `elevated` when any owned path matches an `elevated` prefix, or a voting path spells an entry of the token list. A run of letters and digits in a path is a name. A name splits into words at each camel-case boundary and each boundary between a letter and a digit. A path spells an entry when adjacent words of one name, joined in lower case, equal the entry, or the entry followed by `s`. So `oauthClient`, `OAuthClient`, `K8sClient`, and `permissions` spell `oauth`, `oauth`, `k8s`, and `permission`. `author` spells nothing. Neither does a lower-case compound such as `authservice`, because nothing marks a boundary inside it. The rule is a default: a project covers such names with its own tokens or prefixes. The default list covers authorization (`auth`, `authn`, `authz`, `authorization`, `authentication`, `authorize`, `authenticate`, `oauth`, `permission`, `password`, `credential`, `secret`, `vault`, `security`), money (`billing`, `payment`), data migration (`migration`, `migrate`), and deployment (`deploy`, `deployment`, `sudoers`, `workflow`, `terraform`, `k8s`, `kubernetes`, `dockerfile`, `env`, `ci`). A project's map can replace it. The plan schema also gains an optional `risk: "elevated"`, which can only raise risk.

`featureVersion` is a code constant, 1 for these rules. Each row stores `featureMap`, a digest of the project's map, or `default`. Features are fixed at plan acceptance, because a row keeps no paths to derive from again.

### Part 3. Outcome rows

```sql
CREATE TABLE outcomes (
  outcome_id TEXT PRIMARY KEY,           -- runId ':' memberId
  source TEXT NOT NULL,                  -- production | duel | replay | legacy
  project_ref TEXT NOT NULL,             -- blind index of the project id
  run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,        -- 1 for the first attempt of the assignment
  inherited INTEGER NOT NULL,            -- 1 when it began in a predecessor's working copy
  role TEXT NOT NULL,                    -- implementer | scout
  profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT,                           -- effort or variant
  profile_epoch INTEGER NOT NULL,
  config_id TEXT,
  experiment_ref TEXT,                   -- set by the duel and replay designs
  area_ref TEXT NOT NULL,                -- blind index of the area
  kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  exclusion TEXT,                        -- limit | owner | host | duel
  integrated INTEGER, accepted INTEGER, first_pass INTEGER, held INTEGER,  -- 1, 0, NULL = unknown
  started_at TEXT, ended_at TEXT, frozen_at TEXT, hold_until TEXT, run_deleted_at TEXT,
  payload TEXT NOT NULL                  -- encrypted OutcomePayload
);
```

```ts
type OutcomePayload = {
  projectId: string; taskId: string; area: string; featureMap: string;
  goal?: { id: string; cycle: number }; missionId?: string;
  replaces?: { memberId: string; cause: "stall" | "limit" | "escalation" | "answer" };
  failureKind?: string;   // the host's own code, for example "task-scope-violation"
  baseCommit?: string;    // the run's base commit at integration
  rounds: { run: number; attributed: number; unknown: number };
  rubric?: { version: 1; correctness: number; cleanliness: number; extensibility: number; docs: number; reviewerProfileId: string };
  ownerRating?: { score: number; at: string };
  diff?: { added: number; removed: number; files: number; tests: boolean; docs: boolean };
  wallMs?: number; integrationMs?: number;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  spentUsd?: number; listUsd?: number; limitEvents: number;   // no tokens means unmeasured
  costCoverage: "none" | "partial" | "complete";               // from the usage ledger
  landing?: { at: string; method: "merge-commit" | "merge-parent" | "tree-equal" };
  flags?: ("backfilled" | "gap" | "empty-result" | "scan-gap" | "same-model-review")[];
};
```

Plaintext columns hold opaque identifiers, enumerations, numbers, and times. Names from the repository or the run stay in the encrypted payload. A row never holds an objective, instructions, a summary, a rubric reason, a rating note, a path, or a URL.

**Cost.** The ledger copies cost from the usage ledger and stores the usage coverage with it. It refreshes both whenever the usage ledger reports new usage for one of the attempt's sessions. That also happens after the row is frozen and after the run record is deleted. A cost spread in a cell uses rows with `complete` coverage only, and it reports how many rows it left out.

Purpose sets the source. An attempt in a replay run or a gate run has source `replay`. A duel contestant whose fate the duel set has source `duel`, as the duels design defines. Every other attempt has source `production`.

**Configurations and profile epochs.** After a member's session starts, an enrichment in `launch` computes `configId` as umbrella C7 defines and emits it as `member.configured`. It runs after the launch and never delays it, and a read that fails emits nothing. A `configurations` table keeps one row per `configId` with its six components, so a reader can tell which component changed between two attempts. A `profile_epochs` table keeps each epoch of a profile identity with the time it began, so a reader takes the epoch in effect at a member's start time, and an epoch advanced later does not change an earlier attempt. `infinite usage outcomes new-epoch --profile ID`, owner only, advances the profile's epoch after a known backend change behind an unchanged model name. Each outcome row stores the epoch its attempt started in, and no cell merges two epochs of one profile.

| Disposition | Set by | Counted |
|---|---|---|
| `integrated` | `task.integrated` | yes |
| `completed` | `scout.completed` | yes |
| `escalated` | `task.escalated` | failure |
| `stalled`, `no-report` | `member.stopped` with that class | failure |
| `question`, `blocked` | `member.reported` with that kind | failure |
| `wrong-report` | `run.blocked`: `wrong-agent-report` | failure |
| `out-of-scope` | `run.blocked`: `task-scope-violation`, `read-only-role-changed-files`. `duel.resolved`: the contestant failed the duel's scope gate and the run continued | failure |
| `gate-failed` | `duel.resolved`: the contestant failed a duel gate check and was not integrated | failure |
| `not-chosen` | `duel.resolved`: the contestant passed the duel gate and the other result was integrated | excluded: `duel` |
| `limit` | `member.stopped`: `limit` | excluded: `limit` |
| `owner-stop` | `member.stopped`: `owner` | excluded: `owner` |
| `host-stop` | `member.stopped`: `host`. `run.blocked`: `integration-conflict` or a workspace operation failure | excluded: `host` |
| `open` | nothing yet | no |

A stall or an escalation counts as a failure and a limit is excluded, as in the 2026-10-19 design. Excluding owner stops and host stops is new.

### Part 4. Success levels

Each level is yes, no, or unknown. A row with an exclusion has no levels.

- **integrated** is yes for disposition `integrated` and no for every other counted disposition of an implementer. A `result` with no commit still integrates the task in the run record, so the row is integrated and carries `empty-result`.
- **accepted** is yes when a `review.recorded` with verdict `approved` follows the attempt's `task.integrated`, in the same run, with the same base commit. Only the moved-base path changes `run.baseCommit`, so an approved head with the same base contains every earlier integration.
- **firstPass** is yes when accepted is yes and no correction round is attributed to the task. It is no when accepted is no or a round is attributed. Otherwise it is unknown.
- **held** is defined in Part 5.

A scout row has no levels. Its disposition `completed` is its only result, and a scout rate is the share of counted scout rows that completed.

| Row state | integrated | accepted | firstPass | held |
|---|---|---|---|---|
| Open | unknown | unknown | unknown | unknown |
| Excluded, or a scout | none | none | none | none |
| Counted failure of an implementer | no | no | no | no |
| Integrated, not frozen | yes | yes after an approval, else unknown | as defined above | unknown |
| Frozen with an approval | yes | yes | yes, no, or unknown | Part 5 |
| Frozen after a changes-requested review | yes | no | no | no |
| Frozen with no covering review, or after an owner cancel | yes | unknown | unknown | unknown |
| Replay trial | yes or no | unknown | unknown | unknown |

**Correction rounds.** A correction round is one `repair.started` and the `repair.integrated` that answers it. The projector attributes the round to each integrated attempt, not yet frozen and on the same base commit, whose task owns a path that the repair changed. It reads owned paths from `task.planned`. A repair that changed no task's owned path is counted on the run summary only. If the repair's paths are missing, or nothing answers the round, each such attempt gets one unknown round, and its firstPass cannot be yes. The row also keeps `rounds.run`, the run-wide count that `reviewRounds` holds today.

*(My call: owned paths, not `changedPaths`. They always exist, and they say who was responsible for a file, including one the task should have written.)*

**Freeze.** The first `run.settled` after an attempt's integration freezes accepted and firstPass. At freeze, accepted becomes no when the last review that covered the attempt requested changes and the owner did not cancel the run. Otherwise, without an approval, it stays unknown. A later steer or continuation creates new attempts and changes no frozen row.

**Same-model review.** When the approving review came from a member whose model equals the attempt's model, the row carries the `same-model-review` flag. `consume` already drops the rubric in that case. A `decision` query treats the accepted and firstPass of a flagged row as unknown (umbrella C9 rule 4).

**Denominators.** A rate is yes divided by yes plus no, over ended rows with no exclusion. Unknown, excluded, and open rows are reported beside it. The interval is `wilsonInterval(yes, yes + no)`. A cell with fewer than 10 counted rows is marked `enough: false`, as today.

### Part 5. Delayed signals

```sql
CREATE TABLE outcome_signals (
  signal_id TEXT PRIMARY KEY,   -- deterministic
  run_id TEXT NOT NULL,
  outcome_id TEXT,              -- null for a run-wide signal
  kind TEXT NOT NULL,
  author TEXT NOT NULL,         -- host | owner
  authority TEXT NOT NULL,      -- receipt | claim
  state TEXT NOT NULL,          -- active | withdrawn
  at TEXT NOT NULL,
  payload TEXT NOT NULL         -- encrypted: score, commit ids, issue identifier, reason class
);
```

| Kind | Author, authority | Comes from | Effect |
|---|---|---|---|
| `rating` | owner, claim | `rating.recorded` | sets `ownerRating`. No level changes |
| `landing` | host, receipt | base branch scan | sets `landing` and `hold_until` on the run's accepted rows |
| `revert` | host, receipt | base branch scan | held becomes no on the run's accepted rows |
| `linked-fix` | owner, claim | owner API | held becomes no on the named row, or on the run's accepted rows |
| `exclusion` | owner, claim | owner API | sets an exclusion on a row |

The host never infers a defect. A `revert` records only that a base-branch commit says it reverts a landed commit. A member cannot write a signal. `rateTask` reaches only the current revision's tasks, so an older row cannot be rated yet.

**Base branch scan.** `ProjectSourceService.refreshOne` gets an optional callback that fires when `mirrorHead` changes. The ledger reads the new first-parent commits in the mirror, at most 500 per scan, and records the commit range that each scan covered. It compares the commits with two sets of the project's runs. Rules 1 to 3 use the approved runs that have no landing and were approved at most 90 days ago. Rule 4 uses the landed runs whose hold window is still open.

1. A commit whose id is a run's reported merge commit lands that run (`merge-commit`).
2. A commit whose second parent is a run's reviewed head lands that run (`merge-parent`).
3. A commit whose tree is a run's reviewed tree lands that run (`tree-equal`).
4. A commit whose message contains `This reverts commit` followed by a landed commit's id records a `revert`.

*(My call: exact matches only. A pull request number in a commit subject is text that anyone can write. The cost is that a squash merge onto a moved base stays unobserved.)*

**held.** The hold window starts at landing and lasts `teams.outcomes.holdDays`, default 30. Held is yes when accepted is yes, a landing exists, the window has closed, the scans covered every base-branch commit inside the window, and no active `revert` or `linked-fix` falls inside it. Held is no when accepted is no, or when such a signal exists. Otherwise held is unknown. That covers every project without a GitHub mirror, every landing the scan could not match, and every window with a scan gap, which the row marks with the `scan-gap` flag.

### Part 6. Run summaries, member results, and roll-ups

`run_summaries` has one row per run, rewritten at each `run.settled`. It holds the status, the block code, and counts from the run record: tasks planned and integrated, attempts by disposition, correction rounds with and without an attributed task, automatic recoveries, decisions answered by the owner and by a coordinator, steering messages, permission decisions escalated to the owner, and the cost roll-up. It also keeps the reviewed head, the reviewed tree, the merge commit, and the approval time, so the base branch scan does not depend on run-scoped events.

`member_results` keeps the same facts for a member that has no task (project manager, integrator, reviewer, delivery): role, profile identity, `configId`, disposition, times, and cost. *(My call: capture these now, because this evidence cannot be backfilled. The permission coordinator has its own decision records and is left out.)*

A goal roll-up sums the run summaries and rows that carry the goal id. A mission roll-up does the same for the mission id. A goal roll-up also shows the owner's latest verdict from `ProductGoal.outcomes`. This design calls that verdict a **goal assessment**, so that outcome keeps one meaning.

### Part 7. Reads

**Scorecard.** `GET /api/usage/models` returns the same `ModelUsage` shape, built from rows with source `production`. `attempts` is the ended rows with no exclusion, `integrated` is the rows with integrated yes, and `meanReviewRounds` uses `rounds.run`. The other fields read the payload. The response gains two additive fields, `sources` and `excluded`. `infinite usage models` needs no change.

The numbers change in three ways, on purpose. An attempt integrated before a steer, a resume, or a continuation now counts. An attempt from a deleted run stays. Owner stops and host stops leave the denominator.

**Cells.** Other designs call one in-process query:

```ts
type CellQuery = {
  use: "display" | "decision";
  sources: Source[];                       // required
  by: ("project" | "profile" | "area" | "kind" | "risk")[];
  role: "implementer" | "scout";
  projectId?: string; days?: number;
};
type LevelCount = { yes: number; no: number; unknown: number; rate: number | null; interval: [number, number] | null };
type Spread = { n: number; median: number; iqr: [number, number] };
type Cell = {
  key: Record<string, string>; sources: Source[]; from: string; to: string;
  attempts: number; open: number; excluded: { limit: number; owner: number; host: number; duel: number };
  levels: { integrated: LevelCount; accepted: LevelCount; firstPass: LevelCount; held: LevelCount };
  tokens: Spread | null; spentUsd: Spread | null; listUsd: Spread | null; minutes: Spread | null;
  ownerRating: { mean: number; n: number } | null;
  enough: boolean;
};
```

For role `scout`, a cell leaves the four levels empty and reports a fifth count, `completed`.

A `decision` query refuses the `legacy` source. It leaves out an integrated row that is not frozen, and it includes a row that ended without integration as soon as the attempt ends.

A second query groups rows by assignment and returns the first profile, the final profile, the attempt count, and the total cost. A third query returns the rows themselves for a `decision` use: identifiers, source, features, profile identity and epoch, `configId`, disposition, exclusion, the four levels, the owner rating, cost, the end and freeze times, and `experiment_ref`. The router design computes its reward from these rows. Memory's `routing-outcome` source (INF-132) reads cells.

**API and CLI.**

- `GET /api/outcomes` returns cells for a `display` query. `infinite usage outcomes [--project ID] [--role ROLE] [--by LIST] [--sources LIST] [--days N] [--json]`.
- `GET /api/outcomes/runs/:runId` returns a run's summary, rows, and signals, also after the run record is deleted. `infinite usage outcomes --run ID`.
- `GET /api/outcomes/rollup` takes `goal=ID` or `mission=ID`. `infinite usage outcomes --goal ID` or `--mission ID`.
- `POST /api/outcomes/signals`, owner only, records or withdraws a `linked-fix` or an `exclusion`. `infinite usage outcomes link-fix` and `exclude`.
- `POST /api/outcomes/epochs`, owner only, advances a profile epoch. `infinite usage outcomes new-epoch --profile ID`.

There is no MCP surface. A member never reads the ledger.

### Part 8. Legacy import

`infinite usage outcomes import-legacy --file FILE [--dry-run]`, owner only, reads JSON lines in this product's own shape. The operator converts their ledger to it outside this repository.

```ts
type LegacyOutcome = {
  id: string; projectId: string;
  profile: { provider: string; model: string; effort?: string };
  label?: string;          // the old task tag, at most 40 characters
  result: "accepted" | "rejected" | "excluded";
  attempts: number; totalTokens?: number; elapsedMs?: number;
  reviewerModel?: string; recordedAt: string; supersedes?: string;
};
```

Each line becomes a row with source `legacy` and id `legacy:<id>`. `accepted` sets integrated and accepted to yes, and firstPass to yes only when `attempts` is 1. `rejected` sets accepted to no. `excluded` sets exclusion `host`. Held is unknown. The import is idempotent by id, drops a superseded line, and refuses a changed line under a known id.

A legacy row is an unauthenticated claim. It appears only in `display` queries, under its own source label. Memory's import of the same evidence (INF-141) reads these rows and does not import the operator's ledger a second time.

## Authority and safety

- The ledger observes. No `TeamService` decision reads it, and a store failure never stops a run.
- Levels change only on host receipts and owner claims. A host receipt states what the host itself read: a report kind, a commit id, a tree id, a commit message on the base branch.
- No score reaches a prompt. `team-prompts.ts` must not import the ledger, and a test asserts it.
- A rubric is stored only when `consume` kept it. `consume` already drops one when reviewer and implementer share a model.
- Reads follow the role rules of `GET /api/usage/models`. Signal writes and the import need the owner role.
- Rows are kept `teams.outcomes.retentionDays`, default 730. An owner-only purge removes a project's rows.
- Cells pool rows across projects as numbers only (umbrella C9).

## Failure modes

- **Store unavailable.** Events wait in the outbox. Past 2,000 waiting events for one run, the service drops the oldest and emits one `ledger.gap` event with the count. Affected rows carry the `gap` flag, and their missing levels are unknown.
- **Crash or restore.** The next start appends the outbox again, and a stored key inserts nothing. A row is never removed because a record lacks it.
- **A transition forgets to emit.** A test lists every report kind and every `member.stopped` class and fails when one has no emission. At `run.settled` the projector logs any difference between the summary counts and its rows.
- **Scan gap.** A first scan, a jump of more than 500 commits, or a rewritten base branch scans the newest 500 commits only. A missed landing leaves held unknown, and so does a gap inside an open hold window.
- **Late usage.** The ledger refreshes a row's cost and coverage whenever the usage ledger reports new usage for one of its sessions, also after the freeze and after the run record is deleted.
- **Map change.** A cell never merges two `featureMap` values for one project unless the query leaves `area` out of `by`.

## Delivery order

1. **Emission.** The outbox, `emit`, every event kind, and features at plan acceptance. It needs the store. Corpus capture for replay can start.
2. **Projection and backfill.** Outcome rows, run summaries, member results, and `infinite usage outcomes --run`. A one-time backfill writes rows flagged `backfilled` from the run records the host holds, with firstPass unknown wherever the run had a correction round.
3. **Scorecard switch-over**, with the cells query, API, and CLI.
4. **Signals.** The base branch scan, landing, revert, the hold window, `linked-fix`, and `exclusion`.
5. **Roll-ups and the legacy import.**

## Acceptance

1. A run plans two tasks. One member stalls and its replacement integrates. The review approves at once. The ledger holds a `stalled` row with integrated no, and two rows with integrated, accepted, and firstPass yes. The replacement row has `attempt_index` 2 and `inherited` 1.
2. The owner steers a run after one task integrated. The row keeps integrated yes, and `GET /api/usage/models` counts it. On `main` today it does not.
3. The owner cancels a run with one running member. That row has exclusion `owner`. After retention deletes the record, `GET /api/outcomes/runs/:runId` still returns the rows.
4. A review requests changes, and the repair changes a file that only task A owns. Both rows end accepted. Row A has firstPass no, and row B has firstPass yes.
5. The process is killed between a sealed write and the store append. After restart each key exists once.
6. A merged run's commit appears in the mirror, and a later commit reverts it inside the window. Held becomes no. Without a revert, held becomes yes when the window closes. In a project with no mirror, held stays unknown.
7. A `decision` query that names `legacy` is refused. Every cell carries its row counts, an interval for each rate, and its sources.

## Owner decisions

1. Outcome rows hold no run text. May they outlive a deleted run, and is 730 days the right retention?
2. Is 30 days the right hold window?
3. A revert undoes a whole run. Should it set held to no for every accepted attempt in that run, as designed, or only mark the run summary?
4. An attempt that ends with a question counts as a failure today, and this design keeps that. Should a question be excluded like an owner stop?

## Left to the builder

- The projector registry, and use of the store's encryption and blind index helpers. The blackboard design owns the helpers.
- The key strings, and the Git commands and timeouts for the two new reads and the mirror scan.
- Prompt wording for the optional `kind` and `risk` labels. Keep it to one line, because team prompts have an 80 KiB limit and byte-sensitive tests.
- Client decoding of `ModelUsage`. This design did not verify that the web, phone, and Mac clients ignore the two new fields.
- A project removal path for the purge. This design did not find one.
- The fixture runs behind the prompt version of umbrella C7, and where the host caches each digest.
