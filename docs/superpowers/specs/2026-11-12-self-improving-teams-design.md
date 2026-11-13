# Self-improving teams: shared contract and build order (INF-181)

Date: 2026-11-12. Status: design for review. This is the umbrella document for seven designs. It fixes the vocabulary, the shared data contracts, the authority rules, and the build order. Each design has its own document, its own Linear issue, and its own sequence of pull requests.

## Intent

The owner wants an autonomous team system that gets measurably better at each repository it works in. Four things are missing today:

1. Members cannot share what they learn during a run without copying every report into every later prompt.
2. The host does not know what an attempt cost for most providers, or whether its result held up after review.
3. A model chooses each task's worker from a prompt. No evidence feeds that choice.
4. A change to a prompt, to repository guidance, or to a learned lesson is adopted on opinion. Nothing measures whether it helped.

These designs close that loop, one repository at a time.

## Current state

Observed on `main` at the time of writing:

- A team member is one-shot. It receives a launch prompt and returns one structured report. `packages/host/src/team-mcp.ts` exposes `report`, `mission_report`, and `handoff`. Members have no channel to each other.
- A member's tools run in its session worker, which is a separate process. The host process can call a session worker (`packages/host/src/ipc.ts`). A session worker cannot call the host process.
- `teamContext` in `packages/host/src/team-prompts.ts` copies the reports of the run's members into a context file (`memberReports`) that later members are told to read. It strips rubric scores, owner ratings, and diff counts for an implementer only. Prompts have an 80 KiB limit.
- A run is one sealed JSON document, rewritten whole on every save. Its `events` are free text (`{ at, text }`), so nothing can be computed from them.
- The coordinator model names each task's worker as `agentProfileId` in its plan. `taskProfiles` in `packages/host/src/teams.ts` only checks that the profile is in the lineup pool. A worker names its own escalation target in an `escalate` report.
- `packages/host/src/scorecard.ts` computes integration rate, cost, review rounds, rubric, and owner rating per profile. The API computes it on read from the run records the host still holds. Retention deletes the record of a cancelled run that no goal or mission owns, so those attempts leave the evidence. A steer, a resume, and a continuation clear or move the run's task list, so an attempt integrated before one of them counts as not integrated.
- Usage is measured for OpenCode members only (`packages/host/src/usage-service.ts`, one sealed file). Claude Code and Codex members are unmeasured.
- `RoutineService` pins a digest of the whole project team configuration and the whole host `teams` configuration in each routine approval (`authority` in `packages/host/src/routines.ts`). Any change to either blocks every active routine of the project.
- Outside this repository, coordinators also record reviewed outcomes by hand in an advisory routing ledger. Its records are concentrated on one worker profile and almost none carry token measurements, so it cannot recommend a worker.

## The loop

```
          ┌──────────────── run ────────────────┐
          │ members post and read entries       │
          │ host writes typed events            │
          └───────────────┬─────────────────────┘
                          ▼
   usage capture ──► outcome ledger ◄── delayed signals
                          │              (rating, landing, revert, linked fix)
            ┌─────────────┼──────────────┐
            ▼             ▼              ▼
       replay eval      router         duels
     (offline, paired) (which profile) (paired, live)
            │             ▲              │
            └──► priors ──┘◄── outcomes ─┘
            │
            ▼
     improvement gate ──► candidate proposed for normal review
```

Production outcomes say what happened. Replay says what would happen under a different configuration on the same tasks. The router acts on both. The gate keeps self-improvement from turning into drift.

## The designs

| Document | What it adds | Needs |
|---|---|---|
| `2026-11-12-team-blackboard-design.md` (INF-182) | The evidence store, the event table, typed entries, and member tools to post and read them | — |
| `2026-11-12-member-usage-capture-design.md` (INF-183) | Token usage for Claude Code and Codex members, limit events, list-price equivalent | The store, from its third phase on |
| `2026-11-12-outcome-ledger-design.md` (INF-184) | Typed events, one durable outcome per attempt, success levels, delayed signals, the scorecard's new source | The store. Usage capture for cost |
| `2026-11-12-replay-eval-design.md` (INF-185) | A per-repository eval corpus from the repository's own history, a harness, paired comparison, the learning budget | Outcome ledger |
| `2026-11-12-evidence-router-design.md` (INF-186, and INF-187 for the cascade) | Host-side profile choice with an exploration share, and cost-aware start-tier choice (learned cascade) | Outcome ledger, usage capture, and replay eval for priors |
| `2026-11-12-duels-design.md` (INF-188) | Two profiles on one live task, a blind judge, one result integrated | Router, outcome ledger, usage capture, and replay eval for judge calibration |
| `2026-11-12-improvement-gate-design.md` (INF-189) | Change candidates measured on held-out replay tasks before they are proposed | Replay eval, outcome ledger |

## Vocabulary

One word has one meaning across all eight documents.

- **Run, task, member, role, profile, lineup**: as in `packages/host/src/team-types.ts`. A profile's identity is its provider, model, and effort or variant.
- **Attempt**: one member working one task. Key `(runId, memberId)`.
- **Assignment**: every attempt at one task in one run revision. Key `(runId, revision, taskId)`.
- **Event**: a typed fact about a run state change. Only the host process writes events.
- **Entry**: a typed blackboard record. A member, the host, or the owner is its author.
- **Outcome**: the durable result of one attempt, derived from events and usage. The owner's verdict on a product goal (`ProductGoal.outcomes`) is called a **goal assessment** in these documents.
- **Source**: where an outcome came from: `production`, `duel`, `replay`, or `legacy`. An eval task has an **origin** instead (`captured` or `mined`).
- **Area, kind, risk**: the task features in contract C4.
- **Configuration**: everything that can change an outcome, content-addressed (contract C7).
- **Profile epoch**: a counter per profile identity. The owner advances it after a known backend change behind an unchanged model name. Observed counts from two profile epochs never share a statistic. A consumer may use an earlier epoch only as a labelled prior with a capped weight, as the router design does.
- **Limit event**: one provider limit episode seen in one session. It is not a run event. The usage capture design defines it.
- **Eval task, trial, corpus, dev set, holdout set, resolved**: defined in the replay eval design. `resolved` is an eval grade. It is not a success level.
- **Routing decision, routing mode**: defined in the router design.
- **Duel, champion, challenger, judge**: defined in the duels design.
- **Change candidate, gate receipt**: defined in the improvement gate design.
- **Learning budget**: the owner-set allowance that duels, replay trials, and gate trials spend (contract C8).

## Shared contracts

### C1. One evidence store

All new state lives in one SQLite database in the host state directory. The host process is its only writer. A session worker may open it read-only to answer a member's read. It uses `node:sqlite` in WAL mode and file mode `0600`, as `packages/host/src/memory/store.ts` does. New append-heavy state never uses a sealed whole-file JSON document.

The blackboard design owns the database lifecycle, the event table, and the entry tables. Each other design registers its own module, with its own tables, in the same database.

**What is encrypted.** A plain column holds an opaque identifier, an enumeration, a number, or a time. Any name or text that comes from a repository, a run, or the owner is encrypted per row with a key derived from the vault key. That includes a project identifier, a task identifier, an area name, a path, and a summary. When such a value must be matched, the row stores a keyed hash of it, a blind index. A configured profile ID, a provider name, and a model ID count as enumerations. *(My call: they come from host configuration, they name no repository or task, and SQL groups by them.)*

**Authority.** The sealed run record stays the only authority for run state. The store never decides a run's status, and an event never exists for a transition the run record does not have. The run record is written first. An event write is idempotent by a deterministic key, and a persisted outbox in the run record repairs an event that a crash lost. A member's entry takes another path: the session worker records it in the session journal, and the host process copies it into the store.

**Derived rows.** A design that derives a durable row from an event writes the row in the same transaction as the event. Deleting a run's events then loses nothing.

**Retention.** Events and entries are run-scoped and are deleted with their run. Outcomes are durable and outlive the run record. A durable row holds identifiers, features, dispositions, counts, and costs. It holds no free text from the run. Eval material is the one exception: an eval task keeps recorded task text and patches, encrypted, under its own owner-set retention.

### C2. Event envelope

```ts
type RunEvent = {
  seq: number;          // monotonic per database
  key: string;          // deterministic idempotency key
  runId: string;
  revision: number;
  at: string;           // host clock, ISO 8601
  kind: string;         // dotted, for example "member.reported"
  memberId?: string;
  taskId?: string;
  data: object;         // kind-specific, versioned, bounded in size
};
```

The outcome ledger design owns the core event kinds, the points in `TeamService` that emit them, and the outbox that carries them to the store. The outbox flush appends events in one store transaction and runs each registered projector for a newly inserted event inside it. When a projector for an event's kind cannot run, the whole flush rolls back and the events stay in the outbox. Another design may add event kinds under its own prefix, such as `duel.`, and may register a projector. It lists its kinds in its own document.

### C3. Entries are data

An entry has an author (`host`, `member`, or `owner`) and an authority (`receipt`, `claim`, or `direction`). A host receipt states something the host observed. A member claim states what a member says. Only an owner direction can bind a member.

Entries attach to tasks and paths, never to a member identity, so a replacement member inherits them. Every prompt presents member-written text as untrusted evidence, never as instructions.

### C4. Task features

Every consumer uses the same four features, computed once when the host accepts a plan and stored with a `featureVersion`:

- **role**: the existing `TeamRole`.
- **area**: derived by the host from the task's owned `paths` through a versioned per-project area map. A model never labels it. A task that spans areas is `mixed`.
- **kind**: `feature`, `fix`, `refactor`, `test`, `docs`, or `investigation`. The coordinator labels it in the plan. It is a claim, and it may be absent.
- **risk**: `normal` or `elevated`. The host derives it from per-project path rules. A coordinator label can raise it. Nothing but an owner rule change can lower it.

The outcome ledger design owns the exact derivation.

### C5. Success levels and cost

The outcome ledger defines these. Every consumer uses them unchanged. Each level is yes, no, or unknown.

- **integrated**: the host integrated the attempt's result. A result with no commit is flagged.
- **accepted**: integrated, and an approving review was recorded for a revision that contains it.
- **firstPass**: accepted, with no correction round attributed to the task.
- **held**: accepted, the host observed the work land on the base branch, and no escaped-defect signal arrived within the hold window. It is unknown until the window closes.

An attempt that ended for a cause outside itself is excluded from quality denominators and counted separately. The causes are a provider limit, an owner stop, a host stop that the attempt did not cause, and a duel that preferred the other contestant.

A replay trial has no review and no hold window, so its `accepted`, `firstPass`, and `held` are unknown. The replay eval design grades a trial as `resolved` instead. A scout has no commit, so its row has no levels. The ledger records only that it completed.

Cost is recorded as tokens by class, `spentUsd` for metered profiles only, `listUsd` for any profile, wall minutes, and limit events. `listUsd` is a list-price equivalent used as a routing weight. It is never shown as money spent, and it is unknown when a model has no list price. Usage reaches the host through the agent's own account, so cost is evidence as relayed. It is not a host receipt.

A scalar reward is a versioned function over these levels. The router design owns it. No other design defines success.

### C6. Sources never mix silently

Every outcome row and every statistic names its sources. `production` and `duel` come from real work. `replay` comes from the eval harness. `legacy` is the one-time import of the operator's hand-recorded ledger. Legacy rows are unauthenticated claims: they are displayed, and they never drive an automatic decision.

### C7. Configuration identity

`configId` is the SHA-256 of the canonical JSON of six components:

1. **Profile identity**: provider, model, and effort or variant.
2. **Prompt version**: the digest of what `teamPrompt` renders for a fixed set of fixture runs, for the member's role and provider. The host computes it at start. An override in a gate trial is part of the rendered text, so it changes the prompt version of that trial. *(My call: prompt text is spread through `teamPrompt`, and a digest of rendered fixtures tracks every wording change without a refactor.)*
3. **Guidance digest**: the digest of the guidance set in the member's base tree. The guidance set is a per-project list of path patterns. The default is `AGENTS.md` and `CLAUDE.md` at any depth.
4. **Knowledge snapshot reference**: `none` until a memory integration supplies one. A gate trial with a forced lesson records that lesson's digest.
5. **Routing policy version**: the router's policy digest, or `off`.
6. **Shape**: `team` for a member of a team run, or `trial` for a replay trial.

`TeamService` computes `configId` after it starts a member, in a read that never delays the launch. It emits the value as the `member.configured` event, and the usage session header carries it once the usage capture design adds the field. A member whose read fails has no `configId`. The outcome ledger design delivers this and keeps one row per `configId` with its components, so a reader can tell which component changed.

### C8. Purpose and the learning budget

Every member session has a purpose: `work`, `duel`, `replay`, or `gate`. The design that starts a session sets its purpose at launch, and the purpose never changes afterwards. The usage ledger records it, and the cost view shows learning spend apart from work.

Each project has an owner-set learning budget per calendar month: a list-price cap, a metered-money cap, and a share for each of the three learning purposes. A project with no learning budget has a budget of zero. A duel's challenger and judge, a replay trial, and a gate trial reserve an estimate of both amounts before they start and settle to measured usage afterwards. Where a profile has no measured history, the estimate is an owner-set fallback amount. With no fallback, the reservation is refused. A session whose usage is missing or partial settles at its estimate, or at the measured amount when that is larger, and is labelled so. A cap governs admission: when it is reached, no new session of that purpose starts. A running session finishes, so a month can exceed a cap by the sessions that were already running. Learning never draws on a run's or a goal's own limits. The replay eval design owns the budget record and its reserve and settle operations.

Exploration is different: it is real work sent to a profile that is not the current best. The router bounds it by share, and it sets an `explore` flag on the routing decision.

### C9. Authority

These rules bind every design.

1. The honesty rules in `PRODUCT.md` hold. No component infers that a task is complete. No component approves a provider permission.
2. Learning never changes permissions, scope, owned paths, budgets, limits, review requirements, delivery policy, or the set of approved profiles. It may change which approved profile gets a task, which entries a member reads, and which candidate is proposed.
3. A posterior, a reward, a routing decision, an eval result, a gate receipt, a duel record, and a usage figure never enter any member's prompt, context file, or tool result. A rubric score and an owner rating keep the rule of the 2026-10-19 design: they never reach an implementer. Reviewers, integrators, and project managers read them in the context file today, and these designs do not change that.
4. A model never grades its own work. A judge differs in model from both contestants. Today a reviewer may share a model with an implementer, and the host then drops the rubric. These designs keep that behaviour and add two rules. The router never chooses a profile whose model equals the reviewer's model. The outcome ledger flags an attempt that its own model reviewed, and no decision uses the acceptance of a flagged attempt.
5. The owner delegates routing authority per project. The delegation is pinned per run and can be revoked. The default is `off`. The 2026-10-19 cost and effectiveness design says the host never changes routing, and that remains the default. The router's `auto` mode is the explicit owner opt-in that amends it.
6. A profile with `dataUse: "contributor"` is eligible only where the project's policy allows it.
7. A gate receipt is evidence. It is never approval. Adoption needs the normal independent review, and a repository file needs the normal pull request checks.
8. Eval material stays in private host state and never enters a tracked file. A trial member receives only the recorded assignment of its own eval task. Hidden tests, reference patches, grades, and every other task's material never enter a member's workspace, prompt, or tool result. A duel judge may read the result patches of a dev set task, and that task can then never be a holdout task.
9. Evidence is recorded per project. Numeric outcome statistics may pool across one tenant's projects as a prior, as the existing scorecard already does. Content never crosses a project boundary. One channel is the exception, and it exists today: a mission coordinator carries interfaces between a mission's repositories in subtask objectives, and it may do the same in a mission-scoped entry.

### C10. Existing programs

- **Workspace Memory (INF-129).** Memory is durable, reviewed, cross-run knowledge. The memory product document names a session working context, and the frozen S1 contract defines no collection for it. The blackboard takes that role and stays outside memory. An entry reaches memory only as an explicit proposal through memory's own review path (INF-141, INF-142). The evidence store holds no canonical knowledge. Memory's planned advisory routing imports read the outcome ledger, including its `legacy` rows, and do not import the operator's ledger a second time. The improvement gate supplies the held-out evaluation that INF-141 requires.
- **Cost and effectiveness (INF-71).** The outcome ledger becomes the scorecard's source. Rubric version 1 and the owner rating stay as signals.
- **Blocker learning (INF-128, INF-170).** The blocker evidence shape becomes the body of a `blocker` entry. Large evidence stays in the store, and a prompt carries a summary and a pointer.
- **Routines (INF-179).** Replay jobs and gate jobs reuse the routine's finite, expiring, owner-approved shape.
- **Usage ledger partitioning (INF-40).** Usage capture moves usage rows into the evidence store, which closes INF-40.

### C11. Policy settings and routine approvals

These designs add settings to the project team configuration and to the host `teams` configuration. Both are inside the digest that a routine approval pins. A builder decides, per setting, whether a change must block active routines:

| Setting | In the digest | Reason |
|---|---|---|
| Routing policy, duel policy | yes | It changes who does the work |
| Blackboard switches | yes | They change what a member reads and which tools it has |
| Feature map | yes | It changes how risk is derived |
| Outcome settings, eval configuration, learning budget | no | They change measurement and learning spend, never a routine's work |

A setting that is out of the digest is removed from the digested object before hashing. A project without that setting then keeps its digest, and no active routine blocks at upgrade.

## Build order

Capture comes first because it cannot be backfilled. Retention deletes cancelled runs, and squash merges drop per-task commits.

1. The evidence store and the event table. Worker-side usage capture, which needs no store.
2. Typed events and the outcome ledger, with the scorecard reading from it. The usage ledger in the store. Host-written entries.
3. Member entry tools. Replay eval: corpus capture starts as soon as events exist.
4. The router in `shadow` mode, then `auto` for projects the owner opts in.
5. Duels and the improvement gate.

## Non-goals

- Free-form chat between agents.
- Automatic edits to a lineup, and automatic adoption of any candidate.
- Laptop sessions and other work that runs off the host.
- Replay of interface tasks in the first version.
- Routing of coordinator, reviewer, permission, and delivery roles in the first version.

## Anti-goals

These would make the program a failure even if every part works:

- **A number that looks exact but is not.** Every statistic shows its n, its interval, and its sources. Unknown stays unknown.
- **A team that learns to please its reviewer.** Reviewer acceptance is a proxy. The reward is anchored to `held` and to the owner's rating.
- **Learning spend the owner cannot see or cap.**
- **A second source of truth** for run state, for knowledge, or for tracked work.
- **Self-modification without a measured gate and an independent review.**

## Owner decisions

Each design lists its own. These six cut across them:

1. Whether to delegate routing to the host (`auto` mode) for a project, and for which decision points.
2. The learning budget per project and its split across duels, replay, and gate trials.
3. Whether to add two accounts for replay: an eval identity with its own provider logins for trial members, and a grader identity with no provider login for validation and grading. Without them a replay trial can read the mirror, so its result feeds neither the router nor the gate, and no duel runs.
4. Whether `listUsd` is an acceptable routing weight for subscription profiles.
5. Whether outcome rows, which hold no run text, may outlive a deleted cancelled run.
6. Whether the blackboard takes the role of the memory design's session working context, stored outside memory.
