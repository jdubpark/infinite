# Evidence Router Implementation Plan (INF-186)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host choose a member's model profile from measured outcomes, first by recording what it would choose and only later by choosing.

**Architecture:** A policy per project is pinned on each run. At a task's first implementer start a recorder reads outcome rows through an index, builds a posterior per candidate profile, makes a seeded choice, and stores one decision row in a `routing` module of the evidence store. In shadow the member still runs on the coordinator's profile. Later slices apply the choice, add exploration guards, replay priors, the escalation and scout points, and the learned cascade.

**Tech Stack:** TypeScript, `zod`, `node:crypto`, `node:sqlite`, `node:test`. The evidence store of INF-182, the outcome ledger of INF-184, configuration identity, and task features.

**Spec:** `docs/superpowers/specs/2026-11-12-evidence-router-design.md`, under the shared contracts in `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md` (C1, C4, C9, C11, C19).

This plan grows one section per slice. Each slice is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- The router never changes what a run does unless its mode says so. In `off` nothing is read or written and no prompt byte changes. In `shadow` a decision is recorded and the member runs on the coordinator's profile.
- A router failure never blocks, fails, or slows a run beyond its fixed budget. With the store unavailable a task starts on the coordinator's profile.
- No routing value reaches a member: no prompt, context file, or tool carries the policy, a decision key, a posterior, a reward, or a utility.
- Plain columns hold ids, enumerations, counts, times, numbers, and blind indexes (C1). Text from a member or a repository is sealed.
- Every read on the launch path goes through an index and has a row limit. Nothing is read once for each session, member, run, or task on a list route or a tick.
- The policy lives in `project.team.routing`, inside `RoutineService.authority` (C11).
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. The coordinator runs the full check `npm run check` once per slice.

## Slices

| Slice | Content | Needs |
|---|---|---|
| The shadow recorder | The policy and the pin, the posterior, `routing_decisions`, shadow rows at `start`, `routing status`, `routing explain`. This section | main |
| `auto` at `start` | The plan schema and prompt change, the applied choice, the fixed rules on fallbacks, the exploration guards, the pause, `revoke-routing` | The shadow recorder |
| Replay prior and dry run | Priors from replay results, a dry run over stored tasks | `auto` at `start`; replay eval trials |
| Escalation target and scout rule | The escalation and scout decision points | `auto` at `start` |
| Learned cascade | Start strong when the posterior says so | Escalation target |
| Status in the clients | Web, phone, and Mac | The shadow recorder |

---

# Slice: the shadow recorder

Evidence router design (INF-186), delivery step 1: Part 1 (policy and pin), Part 3 (reward), Part 4 (posterior, without replay), Part 5 (fixed rules, utility, greedy pick, sample, without the exploration guards except risk), Part 7 (`routing_decisions`, `shadow` rows only), and Part 9 (`routing status`, `routing explain`, the two read routes, `repo init --routing`). Acceptance 1, 2, 4, 5, 9, 11, 12, 13, 15, and the mode half of 16. After this slice, each first implementer start of a run in `shadow` writes one decision row with the router's pick and the coordinator's pick, and the member still runs on the coordinator's profile. The owner reads what the router would have done with `infinite routing status PROJECT` and `infinite routing explain RUN_ID TASK_ID`. It builds on the outcome ledger (rows, cell rules, reads), configuration identity, and task features. It runs no Git command, starts no session, and spends no model token.

**Shadow is the default only where the owner has already delegated: an `autonomous` project without a saved mode.** A saved `off` is off. A saved `shadow` is shadow. A saved `auto` runs as shadow, because this host cannot apply a choice, and status says so. A `supervised` project without a saved mode is off. *(My call, against the brief's "off by default": owner decision 1 (2026-11-13) starts the shadow period of every `autonomous` project, and a shadow row changes nothing that a run does. The setting that turns it on is the project's autonomy mode, which the owner sets. `--routing off` turns it off for one project. If the coordinator rules for off everywhere, the change is one line of `effectiveRouting` and one row of its test.)*

**The decision is made once, in `prepareMember`, right after `newMember`, for the implementer of a pending task.** `prepareMember` is the only path that starts a task's first implementer (the advance loop calls it for pending tasks; tasks become pending only at plan acceptance). Replacements (answer, stall, limit switch, escalation) call `newMember` directly, so they never reach the router. `launch()` runs again on every wait (fuse, host load, slots) and already holds the member-tools queue join at its top; a decision there would read the store on every tick. The decision key is fixed by the run, the revision, and the task, so a second `prepareMember` for the same task after a failed preparation or a restart finds the stored row and reuses it.

**Outcomes module version 4 adds three plain columns and one index, so a decision opens no sealed payload.** `point` (`start` or `escalation`), `feature_map_ref` (a blind index), and `owner_score` (1 to 5). Today the decision point, the feature map, and the owner's rating exist only in the sealed payload (`OutcomePayload.replaces`, `.featureMap`, `.ownerRating`), and a launch must not open one payload per row. *(My call for `owner_score` as a plain column: a five-value score is an enumeration, the same kind of fact as `accepted` and `held`, which are plain. The cost of the version: a rollback to a version 3 host makes the `outcomes` module unavailable until the host returns, as versions 2 and 3 did; events wait in the outbox.)*

**Costs are marked tier defaults, headroom is not modelled, and earlier evidence is built now.** `listUsd` is always null in the ledger (`buildCells` in `outcome-cells.ts` sets it so), so no measured cost exists: light $0.40, strong $2.20, a profile without a tier counts as light, and the rescue cost `R` is $1.50, the worked example's figures. The headroom term `p(a)` is 0 and labelled `not-modelled`, because no headroom or pressure code exists. *(My call: Part 5 allows marked defaults below five costed attempts, and every cell is below that today.)* Earlier evidence (acceptance 13) is in this slice. *(My call: every release that edits a prompt fixture changes the implementer's prompt version, so without it every shadow decision would fall back to `Beta(1, 1)` after each release.)*

**A failed shadow decision is silent to the run.** It writes no row, adds no run event line, and adds no event kind. One fixed log line per reason per process names no id. *(My call, against the failure-mode table's "adds a line to the run's events": in shadow the member starts exactly as it would have, so a run line would report a fallback that did not happen, and run lines reach every client.)*

Where the code and the design disagree, and the ruling for this slice:

- **The prompt version hashes the whole profile object, its label included** (`promptVersion` in `config-identity.ts` renders prompts with the profile). A label edit therefore demotes a profile's rows to earlier evidence. Ruling: accept it; status shows the earlier mass.
- **The configuration identity fixes `routing: "off"`** (`ConfigComponents.routing`), and `parseConfigured` in `configuration-store.ts` refuses another value. In shadow the router chooses nothing, so `"off"` stays true. Step 2 must widen both.
- **No model-family, headroom, or duel-lead code exists.** The family rule (C19), `p(a)`, and the duel tie-break are not applied, and status says so.
- **`task.planned` computes features from the current project configuration** (`teams.ts`, the plan-acceptance block), not from a pin. The recorder recomputes them with the same expression at start. An owner edit of the feature map between plan acceptance and start puts the decision in another cell than the row. Ruling: accept it; it is rare and both rows record their own features.
- **`repo init` rebuilds the team block from its own fields** (`team-cli.ts:724`), so a rerun drops a saved `routing`. It drops `features` and `eval` the same way today. Ruling: Task 9 carries `routing`; `features` and `eval` are outside this slice.
- **`config.ts` parses `project.team` with the strict `teamProjectSchema`.** A host from before this slice refuses a configuration that holds `routing`. Ruling: the release notes say to remove `routing` from every project before a rollback. Nothing saves it unless the owner runs `repo init --routing` or the team route.

**Coordinator rulings (2026-11-15).** They settle the calls marked above and replace any line of this section that says otherwise.

- **Shadow is the default for an `autonomous` project without a saved mode: accepted.** It follows owner decision 1, and a shadow row changes nothing that a run does. The owner was told on 2026-11-15 and can still rule for off everywhere; that is the one line of `effectiveRouting` named above. A `supervised` project and a saved `off` write nothing, and the tests for both stay.
- **Silent failure, the 250 ms budget, tier default costs, earlier evidence in this slice, and no `deleteRun` are accepted as written.** The design is amended in Task 9.
- **`repo init` keeps `routing` by the general rule.** The command carries every team key it does not own (`carriedTeamSettings`, a separate change that lands first). Task 9 adds only the three options and merges them over the carried value; it does not add a rule for `routing` alone. Its test stays as written. If that change is not on `main` when Task 9 starts, Task 9 stops and reports.
- **Another slice adds a key beside this one.** The objective record's owner ops add `objective` to `teamProjectSchema`, strip it in `withoutPrivateSettings`, and add tests to `tests/routines.test.ts` and `tests/team-prompts.test.ts`. Whichever lands second merges `main` and keeps both; neither slice edits the other's lines.
- **Release.** Before the release that carries this slice is activated, time two things on a copy of the live evidence database: the outcomes version 4 migration, and one `recordStart` for a project with the most outcome rows. Both run in the host process and block it while they run. The release notes say to remove `routing` from every project before a rollback, and that a rollback makes the outcome ledger unavailable until the host returns.

## Trust boundary, and what a review checks

The policy, the recorder, the reads, and the routes are host code. These inputs originate outside the host:

- **The owner's policy** arrives through `PUT /api/projects/:id/team` (owner role) or `infinite repo init` with an owner key. `teamRoutingSchema` is strict, and every number is bounded (Part 1). It is inside the routine approval digest (umbrella C11), so a change blocks an active routine until the owner approves it again.
- **The coordinator's plan** is member text. The recorder reads from it the task id (`^[a-z][a-z0-9-]{0,39}$`), the paths (through `taskArea`), the kind and the risk (enumerations), and `agentProfileId` (a pool id that `taskProfiles` already checked). The task id and the area go only into the sealed payload. Plain columns hold their blind indexes (`task_key`, `area_ref`). `coordinator_profile_id` is plain because it is an owner-configured profile id.
- **Outcome rows** are host-derived. The router reads only their plain columns, plus the joined `configurations.prompt_version`.
- **Route queries** come from paired devices with the owner, controller, or viewer role. They name a project id, or a run id and a task id. Answers hold ids, enumerations, counts, times, numbers, and the decoded payload of a decision: the project id, task id, area, feature map digest, and per-candidate numbers. No route is on the relay allow-list (`allowedPath` in `remote-access.ts` does not match `/routing/` or `/teams/:id/routing/`).

**What reaches stored text.** The recorder reads the run record, the pinned lineup and policy, the provider limits held in memory, and the store. It never reads a session's environment, a journal, a member report, or a provider output. A GitHub grant or an egress proxy password therefore cannot reach the payload. The only member text in the payload is the task id and the area, both already sealed in the outcome row of the same attempt. *(My call: no `evidence/secret-scan.ts` pass. The task id's pattern admits no known token shape, and an area is a directory name or an owner area id.)*

**What a member sees.** Nothing. No MCP tool reads routing state. `teamContext` copies named run fields, and `run.routing` is not one of them. `withoutPrivateSettings` in `team-prompts.ts` gains `delete copy.routing`, which covers `configuredProject` and `handoff.project`. Step 1 adds nothing to a task, so `JSON.stringify(task)` in `teamPrompt` is unchanged. The import guard `team prompts never import the ledger` also refuses `routing-` specifiers.

The slice adds no run status and no run event, so the ledger records nothing new.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| A `supervised` project without a policy, or a saved `off` | No `routing` key on the run record, no row, prompts and contexts equal to those without the router | Task 1 `the effective mode follows the saved mode and the project's autonomy`; Task 6 `an off run pins nothing and writes nothing`, `a member context never carries the feature map, the eval block, or routing` |
| An `autonomous` project with a lineup, two tasks | Two `recorded` rows with both picks; each member on its plan profile | Task 6 `a shadow run records each first implementer and runs the coordinator's profiles` |
| `prepareMember` twice for one task (failed preparation, restart), with new outcome rows between | One row, the first choice unchanged | Task 5 `a second start reuses the row whatever the store holds now` |
| A replacement of a member (stall, answer, limit, escalation) | No new row | Task 6 `replacements never reach the router` |
| Store unavailable; `outcomes`, `configurations`, or `routing` module not ready | No row, no throw, the run continues on the coordinator's profiles, one log line | Task 5 `without its modules the recorder writes nothing and never throws`; Task 6 `with the store unavailable the run continues` |
| A decision that takes more than 250 ms | No row, one log line | Task 5 `a decision over its budget writes no row` |
| No candidate passes the fixed rules | No row; status says start is not covered | Task 4 `coverage and the default profile`; Task 5 `an uncovered start writes no row` |
| Every candidate's provider limited | Row with basis `default-all-limited`, chosen and greedy the first candidate that passes rules 1 and 2 | Task 4 `coverage and the default profile` |
| Rows given in any order | The same posterior, bit for bit | Task 3 `the posterior does not depend on row order` (seeded, 200 permutations of 50 rows) |
| Legacy rows added or removed | No decision changes | Task 2 `routing evidence reads one identity and point, newest first, within its limit`; Task 3 `legacy rows change nothing` |
| A version 3 store | Version 4, the three columns filled, every earlier column unchanged | Task 2 `a version 3 store migrates to version 4 and fills the routing columns` |
| A row or decision payload that does not open | Migration: `point` NULL and `feature_map_ref` `unreadable`; explain shows the decision with `payload` null | Task 2 migration test; Task 7 `explain decodes every decision of a task and hides blind indexes` |
| A deleted run | Its decision rows stay until retention; its outcome rows stay until the ledger sweep, as today | Task 5 `retention removes decisions after 180 days, at most the limit per call` |
| A saved mode change | The routine approval digest changes; a project without `routing` keeps today's digest | Task 1 `routing settings change the approval digest, and their absence keeps it` |
| A rollback to a host before this slice | The stored `outcomes` version 4 makes that host's ledger unavailable; `routing` is unknown to it and unread; a saved `routing` makes its configuration fail to parse | Store rule of `register`; release notes, no new test |

## Cost on the launch path

One decision per task and revision, inside `prepareMember`, synchronous:

- one primary-key read of `routing_decisions`;
- per distinct candidate identity (at most 8, the lineup's implementer limit): one `epochAt` read and two seeks of `outcomes_by_route` (one per source), each at most 1,000 rows, each row joined to `configurations` by its primary key;
- the posterior over the rows read, in memory;
- one insert.

No sealed payload opens, and nothing reads a session record, a journal, or the usage ledger. At 10,000 outcome rows a decision reads at most 10,000 rows, and in practice the implementer start rows of the candidates' identities in the last 180 days. Expected time is tens of milliseconds; Task 5's budget test and the query-plan tests hold the bound. At 1,000 sessions nothing changes, because nothing is read per session. The evidence store is synchronous, so the 250 ms budget cannot stop a slow read: the recorder measures and refuses to write after one.

Status reads the same rows for the configured lineup, at most 500 decision rows of the project, and opens at most 50 decision payloads. Explain reads at most 20 rows. The retention pass deletes at most 100 rows. The version 4 migration opens every outcomes payload once at registration, as version 3 did.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/routing-types.ts` (create) | Shared types only: knobs, the pin, the evidence row, the posterior, the payload, the decision row, the status and explain answers |
| `packages/host/src/routing-policy.ts` (create) | `teamRoutingSchema`, defaults, presets, versions, `effectiveRouting`, `policyDigest`, `pinRouting` |
| `packages/host/src/team-types.ts` (modify) | `teamProjectSchema.routing`, `TeamRun.routing` (two lines) |
| `packages/host/src/evidence/crypto.ts` (modify) | Index class `feature-map` |
| `packages/host/src/outcome-store.ts` (modify) | Module version 4: the three columns, `outcomes_by_route`, `selectRoutingEvidence` |
| `packages/host/src/outcome-cells.ts` (modify) | `rowUse` takes the fields it reads |
| `packages/host/src/routing-posterior.ts` (create) | Pure: reward, rescue, weights, levels, earlier evidence |
| `packages/host/src/routing-choice.ts` (create) | Pure: fixed rules, costs, utility, greedy pick, the choice |
| `packages/host/src/routing-sample.ts` (create) | Pure: the seed and the seeded Beta sampler |
| `packages/host/src/routing-store.ts` (create) | Module `routing`: table, indexes, reads, insert, retention |
| `packages/host/src/routing-recorder.ts` (create) | `RoutingRecorder.recordStart`: readiness, key reuse, the read, the budget, the write |
| `packages/host/src/routing-reads.ts` (create) | `routingStatus`, `routingExplain` |
| `packages/host/src/routing-routes.ts` (create) | `GET /api/routing/projects/:id`, `GET /api/teams/:id/routing/:taskId` |
| `packages/host/src/routing-cli.ts` (create) | `infinite routing status|explain` handler and its pure line builders |
| `packages/host/src/teams.ts` (modify) | At most 10 lines: two imports, the field, `useRouter`, two lines in `createRun`, three lines in `prepareMember` |
| `packages/host/src/team-prompts.ts` (modify) | `delete copy.routing` in `withoutPrivateSettings` |
| `packages/host/src/server.ts` (modify) | At most 6 lines: register `routingModule()`, build the recorder, `teams.useRouter`, the sweep line, `routing: 1` in `/me`, the route line |
| `packages/host/src/client.ts`, `cli.ts`, `client-entry.ts` (modify) | The `routing` command, its options, help lines |
| `packages/host/src/team-cli.ts` (modify) | `repo init --routing`, `--routing-value`, `--routing-contributor` |
| `docs/teams.md`, the design (modify) | The shadow recorder and the amendments listed in Task 9 |
| `tests/routing-{policy,posterior,choice,store,recorder,run,reads,routes}.test.ts` (create); `tests/{routines,evidence-store,outcome-store,team-prompts,outcome-rules,remote-access,client-args,autonomy-enrollment}.test.ts` (modify) | Pure rules, a real store, a direct team service, the host |

**Order and owners.** Task 1 runs first and is small. Then Tasks 2, 3, and 4 run in parallel. Task 5 waits for all three. Then Tasks 6 and 7 run in parallel; Task 7 adds its one `server.ts` line after Task 6 commits, so each file has one writer at a time. Then Tasks 8 and 9 run in parallel. Task 3 also writes `outcome-cells.ts`, and no other task touches it. Task 8 owns `client.ts` and registers Task 9's three option names, whose spelling is fixed here; Task 9's host test runs after that commit.

## Review Focus

1. **Routing data reaching a member**: the `routing` key, a decision key, the policy digest, a seed, a posterior, a reward, or a utility in any prompt or context file, for any role. Expect none (Task 6 `a member context never carries the feature map, the eval block, or routing`, `a shadow run records each first implementer and runs the coordinator's profiles`, which searches every member's prompt for the row's key, digest, and seed; `team prompts never import the ledger`).
2. **A shadow decision that changes what runs**: a member on another profile than its plan's, a run that blocks or fails because of the store, a throw out of `recordStart`, a decision taken in `launch()` or in a replacement. Expect none (Task 5 `without its modules the recorder writes nothing and never throws`; Task 6 `a shadow run records each first implementer and runs the coordinator's profiles`, `with the store unavailable the run continues`, `replacements never reach the router`).
3. **Off is not byte-identical**: a pin, a row, or a digest change without a saved policy in a `supervised` project. Expect none (Task 1 `the effective mode follows the saved mode and the project's autonomy`, `routing settings change the approval digest, and their absence keeps it`; Task 6 `an off run pins nothing and writes nothing`).
4. **The posterior counts a row it must not**: `legacy`, the other point, another feature map or version, an unfrozen or excluded row, a same-model acceptance, a row older than 180 days; or earlier evidence above a mass of 10; or a result that depends on row order. Expect none (Task 3 `the reward table`, `withheld and excluded rows give nothing`, `levels hold their own rows`, `earlier evidence is capped at a mass of 10`, `the posterior does not depend on row order`, `legacy rows change nothing`).
5. **An unbounded or unrepeatable launch read**: a scan without the route index, a temporary sort, no row limit, a second decision for one key, a sampler that differs for one seed. Expect none (Task 2 `routing evidence reads seek the route index`; Task 5 `decision reads seek their indexes`, `a second start reuses the row whatever the store holds now`; Task 4 `the sampler is deterministic and matches its Beta`).

### Task 1: the policy and the shared types

**Files:** `packages/host/src/routing-types.ts`, `packages/host/src/routing-policy.ts`, `packages/host/src/team-types.ts`, `packages/host/src/evidence/crypto.ts`, `tests/routing-policy.test.ts`, `tests/routines.test.ts`, `tests/evidence-store.test.ts`. Runs first. Tasks 2 to 9 start from its commit.

**Interfaces (produces):**
```ts
// routing-types.ts: types only. Its one import is `import type { OutcomeRow } from "./outcome-store.js"`.
export type RoutingMode = "off" | "shadow" | "auto";
export type RoutingPoint = "start" | "escalation" | "scout";
export type RoutingKnobs = { points: RoutingPoint[]; cascade: boolean; successValueUsd: number; maxExploreShare: number;
  exploreWindow: number; minSpareAttempts: number; allowContributor: boolean; listWeight: number; headroomWeight: number };
/** Pinned on a run that records. Only `shadow` exists in this slice. */
export type TeamRunRouting = { mode: "shadow"; requested: "shadow" | "auto"; source: "saved" | "autonomous-default";
  knobs: RoutingKnobs; defaults: (keyof RoutingKnobs)[]; algorithmVersion: number; rewardVersion: number; digest: string };
export type Identity = { provider: string; model: string; effort: string | null };
export type RoutingEvidenceRow = Pick<OutcomeRow, "outcomeId" | "source" | "projectRef" | "areaRef" | "provider" | "model"
  | "effort" | "profileEpoch" | "kind" | "featureVersion" | "disposition" | "exclusion" | "flags" | "integrated" | "accepted"
  | "firstPass" | "held" | "endedAt" | "frozenAt">
  & { point: "start" | "escalation"; featureMapRef: string | null; ownerScore: number | null; promptVersion: string | null };
export type RuleRemoval = "contributor" | "reviewer-model" | "limited";
export type Basis = "sampled" | "greedy-risk" | "single-candidate" | "default-all-limited";
export type Beta = { a: number; b: number };
export type LevelName = "cell" | "project" | "tenant";
export type LevelRecord = { level: LevelName; observed: { success: number; failure: number; rows: number };
  earlier: { success: number; failure: number; rows: number; scale: number }; prior: { strength: number; mean: number }; posterior: Beta };
export type ProfilePosterior = { reward: LevelRecord[]; rescue: LevelRecord[]; theta: Beta; phi: Beta;
  rows: { production: number; duel: number }; earlierRows: number; level: LevelName | "none"; untimed: number };
export type CandidateRecord = { profileId: string; identity: string; tier: "light" | "strong" | null; removed?: RuleRemoval;
  posterior?: ProfilePosterior; costUsd?: number; thetaMean?: number; thetaSd?: number; phiMean?: number;
  greedyUtility?: number; sample?: number; sampledUtility?: number; samplerFallback?: true };
/** Sealed in `routing_decisions.encrypted_payload`. At most 32 KiB of JSON. */
export type RoutingPayload = { projectId: string; taskId: string; area: string; featureMap: string; coordinatorProfileId: string | null;
  knobs: RoutingKnobs; costs: { lightUsd: number; strongUsd: number; rescueUsd: number; basis: "tier-default" };
  headroom: "not-modelled"; chosenWeight: number; current: { identity: string; epoch: number; promptVersion: string }[];
  candidates: CandidateRecord[]; elapsedMs: number };
export type DecisionRow = { key: string; runId: string; revision: number; taskKey: string; point: RoutingPoint; ordinal: number;
  projectRef: string; role: "implementer" | "scout"; areaRef: string | null; kind: string | null; risk: "normal" | "elevated";
  featureVersion: number; featureMapRef: string; mode: "shadow" | "auto"; algorithmVersion: number; rewardVersion: number;
  policyDigest: string; seed: string; basis: string; chosenProfileId: string; chosenIdentity: string; greedyProfileId: string;
  coordinatorProfileId: string | null; explore: boolean; state: "pending" | "applied" | "released" | "recorded";
  memberId: string | null; decidedAt: string };
export type StatusProfile = { profileId: string; removed?: "contributor" | "reviewer-model"; rows: { production: number; duel: number };
  earlier: { rows: number; mass: number; appliedMass: number }; mean: number; interval: [number, number]; rescue: number;
  level: LevelName | "none"; costUsd: number; greedy: boolean };
export type StatusCell = { scope: "cell"; area: string; taskKind: string | null; featureVersion: number; featureMap: string } | { scope: "new-task" };
export type RoutingStatus = {
  projectId: string; mode: "off" | "shadow"; requested: RoutingMode | null; source: "saved" | "autonomous-default" | null;
  knobs: RoutingKnobs | null; defaults: (keyof RoutingKnobs)[];
  covers: { start: boolean; reason: "off" | "no-lineup" | "no-start-point" | "no-eligible-profile" | null };
  costs: { lightUsd: number; strongUsd: number; rescueUsd: number; basis: "tier-default" };
  headroom: "not-modelled"; interval: "normal-approx-90"; chosenWeight: number; limits: "not-applied";
  shadow: { windowDays: 30; decisions: number; withCoordinator: number; agreements: number; greedyAgreements: number; capped: boolean };
  explore: { exploratory: number; of: number; guards: "risk-only" };
  period: { decisions: number; capped: boolean; firstAt: string | null; targetDays: 14; targetDecisions: 50 };
  cells: { cell: StatusCell; profiles: StatusProfile[] }[]; cellsCapped: boolean; unreadableCells: number };
export type ExplainedDecision = Omit<DecisionRow, "projectRef" | "areaRef" | "taskKey" | "featureMapRef"> & { payload: RoutingPayload | null };
export type RoutingExplain = { runId: string; taskId: string; decisions: ExplainedDecision[]; capped: boolean };

// routing-policy.ts. Imports: zod, `canonicalJson` (evidence/crypto.ts), `type AutonomyMode` (autonomy.ts), `type TeamLineup` (team-types.ts).
export const ROUTING_ALGORITHM_VERSION = 1;
export const REWARD_VERSION = 1;
export const VALUE_PRESETS = { cost: 0.5, balanced: 2, quality: 8 } as const;
export const ROUTING_DEFAULTS: RoutingKnobs;        // points ["start"], cascade false, 2, 0.2, 50, 4, false, 0.25, 1
export const AUTONOMOUS_DEFAULTS: RoutingKnobs;     // ROUTING_DEFAULTS with cascade true
export const teamRoutingSchema: z.ZodType;          // exactly Part 1: every key optional, .strict(), no .default()
export type TeamRouting = z.infer<typeof teamRoutingSchema>;
export type EffectiveRouting = { mode: "off" }
  | { mode: "shadow"; requested: "shadow" | "auto"; source: "saved" | "autonomous-default"; knobs: RoutingKnobs; defaults: (keyof RoutingKnobs)[] };
export function effectiveRouting(saved: TeamRouting | undefined, autonomy: AutonomyMode): EffectiveRouting;
/** SHA-256 hex of canonicalJson({ algorithmVersion, rewardVersion, mode: "shadow", knobs }). */
export function policyDigest(effective: Extract<EffectiveRouting, { mode: "shadow" }>): string;
/** Undefined unless the effective mode is shadow, `points` holds "start", and the run has a lineup. */
export function pinRouting(saved: TeamRouting | undefined, autonomy: AutonomyMode, lineup: TeamLineup | undefined): TeamRunRouting | undefined;
```
`team-types.ts`: `routing: teamRoutingSchema.optional(),` in `teamProjectSchema` after `eval`, and `routing?: TeamRunRouting;` in `TeamRun` beside `blackboard?:`. `evidence/crypto.ts`: `"feature-map"` joins `EvidenceIndexClass` and `INDEX_CLASSES`.

**Decisions:**

- **`effectiveRouting`.** Saved `mode` `off`: off. `shadow`: shadow, requested `shadow`, source `saved`. `auto`: shadow, requested `auto`, source `saved`. No saved policy: `autonomous` gives shadow, requested `shadow`, source `autonomous-default`, knobs `AUTONOMOUS_DEFAULTS`; `supervised` gives off. A saved policy without `mode` takes the project's default mode (shadow when `autonomous`, off otherwise), and its other keys still apply over `ROUTING_DEFAULTS`. *(My call: Part 1 reads a missing mode as `off`, but the autonomous default exists so that an owner who only sets a value does not turn routing off.)* `defaults` lists each knob taken from a default.
- **`points` is normalised**: unique, in the order `start`, `escalation`, `scout`. Two spellings of one policy give one digest.
- **The digest leaves out `requested` and `source`.** They say where the policy came from, not what it does. *(My call.)*
- **The policy is inside the routine approval digest.** `digestedProjectTeam` in `routines.ts` keeps every key but `eval`, so `routing` enters with no change there. A project without `routing` hashes as today.
- Step 1 reads `cascade`, `exploreWindow`, `maxExploreShare`, `minSpareAttempts`, and `headroomWeight` only into the pin, the digest, and status.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the policy schema takes each knob and refuses the rest` (routing-policy) | Each Part 1 key at its bounds parses. `successValueUsd` 100.01, `maxExploreShare` 0.51, `exploreWindow` 9, `minSpareAttempts` 21, `listWeight` 1.1, `headroomWeight` 4.1, `points` `[]`, and an unknown key fail. `teamRoutingSchema.parse({})` deep-equals `{}`, and `parse({ mode: "shadow" })` has the one key. |
| `the effective mode follows the saved mode and the project's autonomy` (routing-policy) | The seven cases: saved off with either autonomy gives off; saved shadow gives shadow from `saved`; saved auto gives shadow with `requested` auto; nothing with `autonomous` gives shadow from `autonomous-default` with `cascade` true; nothing with `supervised` gives off; `{ successValueUsd: 8 }` with `autonomous` gives shadow from `saved` with value 8 and `defaults` without `successValueUsd`; the same with `supervised` gives off. |
| `a pin needs shadow, the start point, and a lineup` (routing-policy) | `pinRouting` is undefined for off, for `points: ["escalation"]`, and without a lineup. Otherwise `mode` shadow, `algorithmVersion` 1, `rewardVersion` 1, nine knobs, and `digest` equal to `policyDigest`. |
| `the digest changes with every knob and with nothing else` (routing-policy) | Changing each of the nine knobs changes the digest. `points` `["escalation", "start"]` and `["start", "escalation", "start"]` give the digest of `["start", "escalation"]`. Two pins with equal knobs from `saved` and from `autonomous-default` have one digest. |
| `routing settings change the approval digest, and their absence keeps it` (routines) | Pattern of `eval settings stay out of the routine approval digest`: an approved routine on a project without `routing` ticks `running`. Setting `project.team.routing` to `{ mode: "shadow" }` makes the next tick block it for approval. |
| `blind indexes separate classes` (evidence-store, extended) | `feature-map` and `area` give different indexes for the value `a`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-policy.test.ts tests/evidence-store.test.ts`, then `tests/routines.test.ts` on the host, then `npm run typecheck`, and commit. The typecheck does not read `tests/`, so a missing import in a test shows only when the file runs.

### Task 2: the outcomes store, version 4

**Files:** `packages/host/src/outcome-store.ts`, `tests/outcome-store.test.ts`. Needs Task 1. Runs in parallel with Tasks 3 and 4.

**Interfaces (produces):** module `outcomes`, version 4, `readVersion` 2. `migrate(tx, from)` runs versions 1 to 3 as today, then, when `from < 4`:
```sql
ALTER TABLE outcomes ADD COLUMN point TEXT;            -- 'start' | 'escalation' on implementer rows that are not legacy; else NULL
ALTER TABLE outcomes ADD COLUMN feature_map_ref TEXT;  -- index('feature-map', payload.featureMap); 'unreadable' when the payload does not open
ALTER TABLE outcomes ADD COLUMN owner_score INTEGER;   -- payload.ownerRating?.score (1 to 5), else NULL
CREATE INDEX IF NOT EXISTS outcomes_by_route
  ON outcomes (source, role, point, provider, model, effort, ended_at, outcome_id);
-- Then every row: open the payload once and set the three columns.
```
```ts
export const ROUTING_ROWS_PER_SOURCE = 1000;
/** Rows of one identity and point from `production` and `duel`, ended at or after `since`, each source its newest
 *  ROUTING_ROWS_PER_SOURCE, returned in `outcome_id` order. Opens no payload. */
export function selectRoutingEvidence(db: EvidenceDb, identity: Identity, point: "start" | "escalation", since: string): RoutingEvidenceRow[];
```
Each source runs:
```sql
SELECT o.outcome_id, o.source, o.project_ref, o.area_ref, o.provider, o.model, o.effort, o.profile_epoch, o.kind,
       o.feature_version, o.disposition, o.exclusion, o.flags, o.integrated, o.accepted, o.first_pass, o.held,
       o.ended_at, o.frozen_at, o.point, o.feature_map_ref, o.owner_score, c.prompt_version
FROM outcomes o LEFT JOIN configurations c ON c.config_id = o.config_id
WHERE o.source = ? AND o.role = 'implementer' AND o.point = ? AND o.provider = ? AND o.model = ? AND o.effort IS ?
  AND o.ended_at >= ?
ORDER BY o.ended_at DESC, o.outcome_id DESC LIMIT ?
```

**Decisions:**

- **The point of a row.** A row whose `replaces.cause` is `escalation` is at `escalation`. A row that replaces another member for any other cause takes the point of that member's row, found by its outcome id (`${runId}:${memberId}`, the form of `outcomeId` in `outcome-projector.ts`). A row without `replaces` is at `start`. A predecessor row that is missing, or whose point is NULL, gives NULL, and the router never reads NULL. *(My call: an unknown point is never guessed as `start`.)* `writeOutcome` derives all three columns from the payload, and one primary-key read of the predecessor, and ignores a caller's value, as it does for `goal_ref`.
- **The migration resolves chains in memory.** Outcome ids hold a random member id, so table order is not attempt order. It opens each payload once inside its own `try`, keeps `{ outcomeId, replaces }`, and resolves each chain with a depth limit of 64; a deeper chain or a cycle gives NULL.
- **Two seeks, one per source**, so a `replay` or `legacy` row never sits inside the scanned range. `effort IS ?` must seek the index for a NULL effort; if the query-plan test shows a scan, use `effort = ?` and a second statement with `effort IS NULL`.
- The join reads `configurations`, so a caller checks that both modules are ready. Rows of a deleted run stay readable until the ledger sweep, as in every ledger read.
- The existing `a version 2 store migrates to version 3 and indexes goals and missions` now expects version 4.
- **Coordination note.** If another wave 3 slice also raises `outcomes`, the second to merge renumbers to 5 and runs its migration after this one.

- [ ] **Step 1: Write the failing tests** in `tests/outcome-store.test.ts`.

| Test name | Assertions |
|---|---|
| `a version 3 store migrates to version 4 and fills the routing columns` | A store first opened with the version 1 to 3 statements copied into the test holds: a first implementer row (no `replaces`); a stall replacement of it; an escalation replacement; a stall replacement of the escalation member; a replacement whose predecessor is absent; a scout row; a legacy row; a row rated 4; a row whose payload is `"x"`. After `outcomeModule()`: version 4 and ready; points `start`, `start`, `escalation`, `escalation`, NULL, NULL, NULL; `owner_score` 4 on the rated row and NULL elsewhere; `feature_map_ref` equal to `db.index("feature-map", featureMap)` and `unreadable` on the damaged row; every earlier column of every row equal before and after. |
| `writes keep the routing columns` | `writeOutcome` with `replaces.cause` `escalation` gives `escalation`; a stall replacement of that row gives `escalation`; a rewrite with an `ownerRating` of 2 gives `owner_score` 2; a caller's `point` is ignored. |
| `routing evidence reads one identity and point, newest first, within its limit` | Rows of two identities, both points, the sources `production`, `duel`, `legacy`, and `replay`, ended inside and before `since`: only `production` and `duel` rows of the identity and point ended at or after `since` return, in `outcome_id` order. A row whose `config_id` is NULL or unknown has `promptVersion` null; a known one has the stored version. An identity with a NULL effort matches only rows with a NULL effort. With 1,001 `production` rows, the 1,000 newest return. |
| `routing evidence reads seek the route index` | `EXPLAIN QUERY PLAN` of the statement, for an effort and for NULL: a line `SEARCH o USING INDEX outcomes_by_route`, a primary-key search of `c`, and no `SCAN o` and no `USE TEMP B-TREE`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/outcome-store.test.ts tests/outcome-reads.test.ts tests/outcome-signals.test.ts` and `npm run typecheck`.

### Task 3: the posterior

**Files:** `packages/host/src/routing-posterior.ts`, `packages/host/src/outcome-cells.ts`, `tests/routing-posterior.test.ts`. Needs Task 1. Runs in parallel with Tasks 2 and 4.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
// outcome-cells.ts: the one change. Behaviour and every caller unchanged.
export function rowUse(row: Pick<OutcomeRow, "flags" | "disposition" | "exclusion" | "frozenAt" | "integrated" | "accepted" | "firstPass" | "held">, use: CellUse): RowUse;

// routing-posterior.ts
export const HALF_LIFE_DAYS = 30, MAX_AGE_DAYS = 180, LEVEL_STRENGTH = 20, EARLIER_MASS = 10;
export const CHOSEN_WEIGHT = 0.5;   // every row is coordinator-chosen in step 1 (owner decision 5)
export type RoutingTarget = { projectRef: string; areaRef: string; kind: string | null; featureVersion: number; featureMapRef: string; point: "start" | "escalation" };
export type CurrentConfig = { epoch: number; promptVersion: string };
export type Observation = { reward?: { r: number; w: number }; rescue?: { x: 0 | 1; w: number } };
export function observe(row: RoutingEvidenceRow, now: string, chosenWeight: number): Observation | undefined;
export function posterior(rows: readonly RoutingEvidenceRow[], target: RoutingTarget, current: CurrentConfig, now: string, chosenWeight?: number): ProfilePosterior;
export function betaMean(beta: Beta): number;
export function betaSd(beta: Beta): number;
```

**Decisions:**

- **The reward is Part 3's first matching line**, after `rowUse(row, "decision")` gives `counted` (open, excluded, backfilled, gap, and unfrozen integrated rows give nothing). A counted row whose disposition is not `integrated` has `r` 0. Then `accepted` 0 gives 0; `accepted` null gives no reward observation (`rowUse` nulls it for `same-model-review`); `held` 0 gives 0; `ownerScore` gives `(score − 1) / 4`; `firstPass` 1 gives 1; anything else 0.5. The last three lines have weight 0.5 while `held` is null. *(My call: "ended without integration" is the ledger's own counted-failure set, `question` and `blocked` included, so the router keeps one counting rule.)*
- **The rescue observation** is 1 when `firstPass` is 1, and 0 when it is 0 or the row is a counted non-integrated row. It has no provisional weight.
- **Weights.** Time: `0.5 ** (ageDays / 30)` from `endedAt` to `now`; an `endedAt` after `now` counts as age 0; an age over 180 days gives nothing; a counted row without `endedAt` gives nothing and adds to `untimed` (missing is never zero age). *(Coordinator ruling after review: an old row's time is known, so it is not untimed; the test row at 181 days holds.)* Who chose: `chosenWeight`, default 0.5.
- **Current or earlier.** A row is current when `profileEpoch` equals `current.epoch` and `promptVersion` equals `current.promptVersion`. A null `promptVersion` is earlier.
- **Levels.** A row of another project is `tenant`. A row of the target project matching `areaRef`, `kind` (null equals null), `featureVersion`, and `featureMapRef` is `cell`; any other row of the project is `project`. A row whose `point` differs from the target's, or whose source is `legacy`, is skipped (the reader already leaves both out). Earlier evidence at a level is scaled by `min(1, 10 / (success + failure))` and enters as `P` and `Q`. Then Part 4 exactly: tenant `Beta(1 + P + S, 1 + Q + F)`; each child `Beta(k·μ + P + S, k·(1 − μ) + Q + F)` with `k = min(20, a + b of the parent)`. `theta` is the cell's reward posterior and `phi` the cell's rescue posterior.
- **`level`** is the most specific level with a current observed row, or `none`.
- **Order independence.** `posterior` sorts its input by `outcomeId` before it sums, so the result is a function of the row set, bit for bit.

- [ ] **Step 1: Write the failing tests.** Rows are built by a helper with `chosenWeight` 1 and `endedAt` equal to `now` unless a row says otherwise.

| Test name | Assertions |
|---|---|
| `the reward table` | A stalled row: `r` 0, `w` 1. Integrated, `accepted` 0: 0, 1. `accepted` null with `same-model-review`: no reward, and its rescue observation is also absent. `held` 0: 0, 1. Rated 3 with `held` null: 0.5, 0.5, and rescue 1 when `firstPass` is 1 (acceptance 11). `firstPass` 1 with `held` null: 1, 0.5. `firstPass` 1 with `held` 1: 1, 1. `firstPass` 0 with `held` 1: 0.5, 1, rescue 0. One first-pass row with `held` null adds 0.5 success and 0 failure mass; with `held` 0 it adds 1 failure mass. |
| `withheld and excluded rows give nothing` | Rows flagged `backfilled` or `gap`, an integrated row with `frozenAt` null, an `open` row, and rows with dispositions `limit`, `owner-stop`, `host-stop`: `observe` is undefined for each. |
| `time and who-chose weights` | `endedAt` 30 days before `now`: weight 0.5; 60 days: 0.25; 181 days: nothing and `untimed` 0; one hour after `now`: 1; `endedAt` null on a counted row: nothing and `untimed` 1. With `chosenWeight` 0.5, a fresh first-pass row with `held` 1 adds 0.5 success. |
| `with no rows every level is Beta(1, 1)` | `theta` and `phi` `{ a: 1, b: 1 }`; each level's posterior `{ a: 1, b: 1 }`; `level` `none` (acceptance 12). |
| `levels hold their own rows` | Tenant rows with success 6 and failure 2 give tenant `Beta(7, 3)`; project rows with 1 and 1 give project `Beta(8, 4)`; the cell gets prior strength 12 and `Beta(8, 4)`. With tenant 24 and 6, the project prior strength is 20 and its parameters are 15.625 and 4.375. A row of another `featureMapRef`, another `featureVersion`, another `kind`, or another area of the project counts at `project`, never at `cell`. A row of the other point counts nowhere (acceptance 12). |
| `earlier evidence is capped at a mass of 10` | 40 first-pass `held` 1 rows of epoch 0 with current epoch 1, all tenant: tenant `Beta(11, 1)`, `earlier.scale` 0.25, `earlierRows` 40. Four such rows: `Beta(5, 1)`. Rows with `promptVersion` null are earlier. A current row beside them counts in `observed` (acceptance 13). |
| `the posterior does not depend on row order` | Seeded property test: 50 rows across the three levels, both epochs, and mixed levels; 200 seeded shuffles give results whose every number is `Object.is`-equal to the sorted input's result. |
| `legacy rows change nothing` | Adding 20 `legacy` rows to an input gives a deep-equal result (acceptance 9). |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-posterior.test.ts tests/outcome-cells.test.ts` and `npm run typecheck`.

### Task 4: the choice and the sampler

**Files:** `packages/host/src/routing-choice.ts`, `packages/host/src/routing-sample.ts`, `tests/routing-choice.test.ts`. Needs Task 1. Runs in parallel with Tasks 2 and 3.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
// routing-sample.ts
/** SHA-256 hex of `${digest}|${runId}|${revision}|${taskKey}|${point}|${ordinal}`. */
export function decisionSeed(digest: string, runId: string, revision: number, taskKey: string, point: RoutingPoint, ordinal: number): string;
/** SHA-256 hex of `${seed}|${identity}`. */
export function candidateSeed(seed: string, identity: string): string;
/** One Beta draw from a SHA-256 counter stream. Throws RangeError unless a and b are finite and above 0. */
export function betaSample(a: number, b: number, seed: string): { value: number; fallback: boolean };

// routing-choice.ts
export const TIER_COSTS = { light: 0.40, strong: 2.20 } as const;
export const RESCUE_USD = 1.50;
export type Screened = { profile: TeamModelProfile; identity: string; removed?: RuleRemoval };
export function screen(lineup: TeamLineup, knobs: RoutingKnobs, limited: ReadonlySet<Provider>): Screened[];   // lineup.implementers order
export function tierCost(profile: TeamModelProfile): number;
export function utility(input: { theta: number; phi: number; costUsd: number }, knobs: Pick<RoutingKnobs, "successValueUsd" | "listWeight">,
  risk: "normal" | "elevated", rescueUsd?: number): number;
export type Scored = { profile: TeamModelProfile; identity: string; posterior: ProfilePosterior; costUsd: number };
export type Choice = { basis: Basis; chosen: string; greedy: string; explore: boolean; candidates: CandidateRecord[] };
/** Undefined when no candidate passes rules 1 and 2: the start is not covered. */
export function choose(screened: readonly Screened[], scored: ReadonlyMap<string, Scored>, knobs: RoutingKnobs,
  risk: "normal" | "elevated", seed: string): Choice | undefined;
```

**Decisions:**

- **Fixed rules, in this order.** Rule 1: `dataUse` `contributor` without `allowContributor`. Rule 2: the profile's model equals `lineup.reviewer`'s model. Rule 3: the provider is in `limited`. Candidates are `lineup.implementers` only; `cascade` is pinned but not applied (step 5).
- **Coverage.** No candidate passes rules 1 and 2: undefined, and the caller writes no row. *(My call: Part 1's refusal `routing-no-eligible-profile` belongs to `auto`; a shadow run is never refused.)* Candidates pass rules 1 and 2 but none passes rule 3: basis `default-all-limited`, chosen and greedy the first of them. Exactly one passes all three: `single-candidate`.
- **Utility.** `U = V'·θ − λ·(c + (1 − φ)·R)`, with `V'` equal to `3·successValueUsd` for elevated risk, `λ` `listWeight`, `c` `tierCost` (a profile without a tier is light), and `R` 1.50. The headroom term is 0. No duel tie-break and no family rule.
- **Greedy** maximises `U` with `θ` at the posterior mean, or the mean minus one standard deviation for elevated risk; `φ` at its mean. Ties go to lineup order.
- **The sample.** Normal risk: one draw of `θ` per candidate from `candidateSeed(seed, identity)`, highest `U` wins, ties in lineup order; basis `sampled`; `explore` is chosen unlike greedy. Elevated risk: basis `greedy-risk`, chosen equals greedy, `explore` false. The share, budget, pause, and headroom guards are step 2; status labels the count of would-explore decisions `risk-only`.
- **The sampler.** Uniforms take 53 bits of each 8-byte word of `sha256(\`${seed}:${counter}\`)`, as `(n + 0.5) / 2**53`. Normals by Box–Muller. Gamma by Marsaglia and Tsang; for a shape below 1, `Gamma(a + 1)·u^(1/a)`. Beta is `X / (X + Y)`. Each gamma tries at most 64 times; after that the draw is the mean and `fallback` is true, which the payload records. A changed generator must raise `ROUTING_ALGORITHM_VERSION`. The stored row, not a recomputation, is the record; a recheck on another Node major may differ in the last bits.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `fixed rules remove contributor, reviewer-model, and limited candidates` | With `mixedLineup` from `tests/team-fixture.ts`: `spark-high` removed `contributor`, `astra-xhigh` kept. With `allowContributor` true both pass. A profile on the reviewer's model is removed `reviewer-model`. A limited provider is removed `limited` only after the first two rules pass. |
| `coverage and the default profile` | Only contributor and reviewer-model candidates: `choose` is undefined. Two candidates that pass rules 1 and 2, both limited: basis `default-all-limited`, chosen and greedy the first. One passing candidate: `single-candidate`, `explore` false. |
| `the worked example` | `utility` with `successValueUsd` 2, `listWeight` 1, `R` 1.50: means 0.50, 0.667, 0.818 with φ 0.60, 0.70, 0.90 and costs 0.40, 0.30, 2.20 give 0.00, 0.58, and −0.71 to two decimals, so greedy is the second. Draws 0.72, 0.44, 0.86 give 0.44, 0.13, −0.63, so the draw picks the first. |
| `elevated risk is greedy at the mean minus one deviation with triple value` | Lineup order B then A, equal costs, B `Beta(3, 1)`, A `Beta(30, 10)`: normal risk's greedy is B (a tie at 0.75 resolved by order); elevated risk gives basis `greedy-risk`, chosen A, `explore` false, and over 1,000 seeds never explores (acceptance 6, risk clause). |
| `the sampler is deterministic and matches its Beta` | One seed gives one value twice. Over 20,000 seeds, `Beta(2, 5)` has a mean within 0.01 of 2/7 and `Beta(0.3, 0.7)` within 0.01 of 0.3; every value lies in (0, 1). `a` 0, `b` −1, NaN, and Infinity throw `RangeError`. Three fixed seeds give three recorded values. |
| `the seed binds every part of the key` | Changing any one of digest, run id, revision, task key, point, or ordinal changes `decisionSeed`; two identities give two `candidateSeed`s. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-choice.test.ts` and `npm run typecheck`.

### Task 5: the decision store and the recorder

**Files:** `packages/host/src/routing-store.ts`, `packages/host/src/routing-recorder.ts`, `tests/routing-store.test.ts`, `tests/routing-recorder.test.ts`. Needs Tasks 2, 3, and 4.

**Interfaces (produces):** module `routing`, version 1, `readVersion` 1, no `deleteRun` and no `runIds`.
```sql
CREATE TABLE IF NOT EXISTS routing_decisions (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  task_key TEXT NOT NULL, point TEXT NOT NULL, ordinal INTEGER NOT NULL, project_ref TEXT NOT NULL, role TEXT NOT NULL,
  area_ref TEXT, kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL, feature_map_ref TEXT NOT NULL,
  mode TEXT NOT NULL, algorithm_version INTEGER NOT NULL, reward_version INTEGER NOT NULL, policy_digest TEXT NOT NULL,
  seed TEXT NOT NULL, basis TEXT NOT NULL, chosen_profile_id TEXT NOT NULL, chosen_identity TEXT NOT NULL,
  greedy_profile_id TEXT NOT NULL, coordinator_profile_id TEXT, explore INTEGER NOT NULL, state TEXT NOT NULL,
  member_id TEXT, decided_at TEXT NOT NULL, encrypted_payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS routing_by_task ON routing_decisions (run_id, task_key, revision, point, ordinal);
CREATE INDEX IF NOT EXISTS routing_by_project ON routing_decisions (project_ref, point, decided_at, key);
CREATE INDEX IF NOT EXISTS routing_by_time ON routing_decisions (decided_at, key);
```
```ts
// routing-store.ts
export const ROUTING_MODULE = "routing";
export const ROUTING_RETENTION_DAYS = 180, TASK_DECISION_LIMIT = 20, PROJECT_DECISION_LIMIT = 500, PAYLOAD_LIMIT_BYTES = 32 * 1024;
export function routingModule(): EvidenceModule;                     // counts: { decisions }
/** SHA-256 hex of `${runId}|${revision}|${taskKey}|${point}|${ordinal}`. */
export function decisionKey(runId: string, revision: number, taskKey: string, point: RoutingPoint, ordinal: number): string;
export function readDecision(db: EvidenceDb, key: string): DecisionRow | undefined;                 // plain columns only
/** INSERT ... ON CONFLICT(key) DO NOTHING. True when this call stored the row. */
export function insertDecision(tx: EvidenceTx, row: DecisionRow, payload: RoutingPayload): boolean;
export function taskDecisions(db: EvidenceDb, runId: string, taskKey: string): { rows: (DecisionRow & { payload: RoutingPayload | null })[]; capped: boolean };
export function projectDecisions(db: EvidenceDb, projectRef: string, since: string): { rows: DecisionRow[]; capped: boolean };
/** Opens the payload of the newest decision of each distinct cell, at most `limit` cells. */
export function projectCells(db: EvidenceDb, projectRef: string, since: string, limit: number): { cells: { areaRef: string | null; kind: string | null; featureVersion: number; featureMapRef: string; payload: RoutingPayload | null }[]; capped: boolean };
export function shadowProgress(db: EvidenceDb, projectRef: string): { decisions: number; capped: boolean; firstAt: string | null };   // counts at most 50
export function sweepExpiredDecisions(store: EvidenceStore, now: string, limit?: number): number;   // limit 100

// routing-recorder.ts
export type RouterStart = { run: TeamRun; task: TeamTask; publishHeads: boolean; entryTools: boolean;
  featureMap: FeatureMap | undefined; limited: ReadonlySet<Provider> };
export class RoutingRecorder {
  constructor(options: { store: EvidenceStore; now?: () => string; clock?: () => number; log?: (line: string) => void });
  /** Never throws. Writes at most one row. */
  recordStart(input: RouterStart): void;
}
```

**Decisions:**

- **`recordStart` steps.** (1) Return when `run.routing` is absent, `run.lineup` is absent, or `knobs.points` lacks `start`. (2) Return unless `outcomes`, `configurations`, and `routing` are all `ready` in `store.status().modules`; log `Routing shadow decision skipped: the evidence store is unavailable.` once per recorder. *(Coordinator ruling after review: every "once" in this list is per recorder instance, as the tests say; the host has one recorder per process.)* (3) Compute features with `taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, featureMap)`, run `screen`, and compute each kept candidate's `promptVersion("implementer", profile.provider, profile, publishHeads, entryTools)` before the clock starts. (4) Start the clock. (5) One `store.read`: the task key and the decision key; when `readDecision` finds the row, return. Otherwise for each distinct identity `epochAt(db, profileIdentityKey(identity), now)` and `selectRoutingEvidence(db, identity, "start", now − 180 days)`, then `posterior` and `choose` with `decisionSeed(run.routing.digest, run.id, run.revision, taskKey, "start", 1)`. (6) If the clock shows more than 250 ms, log `Routing shadow decision skipped: it took longer than 250 ms.` once and return. (7) One `store.tryWrite` with `insertDecision`. Any throw is caught and logs `Routing shadow decision failed.` once. No log line holds an id or a value.
- **The row.** `point` `start`, `ordinal` 1 (replacements never reach the router, so one start decision exists per task and revision), `role` `implementer`, `mode` `shadow`, `state` `recorded`, `member_id` NULL, `coordinator_profile_id` the plan's `agentProfileId` or NULL, `decided_at` from `now`. *(My call for `member_id`: a reused row would otherwise name a member that never started.)* `project_ref`, `area_ref`, `task_key`, and `feature_map_ref` are blind indexes. `seed` is the decision seed. A payload over 32 KiB writes no row and logs the `tooLarge` line ("Routing shadow decision skipped: its details are over the size limit.").
- **Key first.** The key lookup runs before any evidence read, so a reused row costs one read, and the same key gives the same choice whatever the store holds now (acceptance 5).
- **Retention.** A row holds no run text, so it outlives the run record and has no `deleteRun`. *(My call: the sweep removes rows with `decided_at` older than 180 days, at most 100 per call through `key IN (SELECT key ... ORDER BY decided_at, key LIMIT ?)`, from the host's existing evidence sweep.)*
- **Bounds.** `taskDecisions` returns at most 20 rows; `projectDecisions` the newest 500 within `since`; `projectCells` reads those 500 plain rows and opens at most `limit` payloads; `shadowProgress` counts through `SELECT count(*) FROM (SELECT 1 ... LIMIT 50)`.

- [ ] **Step 1: Write the failing tests.** Stores are built as in `tests/eval-capture-run.test.ts`: `new EvidenceStore({ databasePath, vaultKey })` with `configurationModule()`, `outcomeModule()`, and `routingModule()`.

| Test name | Assertions |
|---|---|
| `a decision is stored once per key` (routing-store) | `insertDecision` twice with one key: true, then false, and the stored row equals the first. `counts` reports `decisions` 1. |
| `plain columns hold no clear text` (routing-store) | A payload with project id P, task id T, area A, and feature map M: no plain column of the row contains P, T, A, or M; `taskDecisions` opens the payload to them. |
| `task decisions are bounded and survive an unreadable payload` (routing-store) | 21 decisions of one task: 20 return and `capped` is true. One payload set to `"x"`: that row returns with `payload` null and the others open. |
| `retention removes decisions after 180 days, at most the limit per call` (routing-store) | A row decided 181 days before `now` and one decided 179 days before: one sweep removes the first only. With three expired rows and `limit` 2, one call removes two. A row whose run was deleted stays until its time. |
| `decision reads seek their indexes` (routing-store) | `EXPLAIN QUERY PLAN` of the key read, `taskDecisions`, `projectDecisions`, `shadowProgress`, and the sweep's inner select: each names its index (`routing_by_task`, `routing_by_project`, `routing_by_time`, or the primary key), with no `SCAN routing_decisions` and no `USE TEMP B-TREE`. |
| `a shadow start writes one recorded row with both picks` (routing-recorder) | A run pinned from `pinRouting(undefined, "autonomous", mixedLineup)` with tasks on `spark-high` and `astra-xhigh`: two rows; `coordinator_profile_id` `spark-high` and `astra-xhigh`; both chosen and greedy `astra-xhigh`; basis `single-candidate`; `mode` shadow; `state` recorded; `member_id` NULL; `policy_digest` equal to the pin's digest; `algorithm_version` 1 and `reward_version` 1. With `allowContributor` true, basis `sampled`. |
| `a second start reuses the row whatever the store holds now` (routing-recorder) | `recordStart` for one task, then 30 outcome rows for its candidates are written, then `recordStart` again: one row, and its chosen profile, seed, and payload are unchanged. |
| `without its modules the recorder writes nothing and never throws` (routing-recorder) | A store whose database path is a file (the technique of `tests/outcome-routes.test.ts`), and stores without `outcomes`, without `configurations`, and without `routing` registered: `recordStart` returns, no `routing_decisions` row exists where the table exists, and the log holds the unavailable line once per recorder. |
| `a decision over its budget writes no row` (routing-recorder) | A forward-only `clock` that returns 0, then 251: no row and the budget line once. A clock that returns 0, then 249: one row. |
| `an uncovered start writes no row` (routing-recorder) | A lineup whose implementers are all contributor profiles without `allowContributor`: no row and no log line. A run without `routing`: no row and no call of `store.read` (a counting wrapper). |
| `the payload stays within its limit with eight candidates` (routing-recorder) | Eight implementers, each with rows at all three levels: one row, payload JSON under 32 KiB. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-store.test.ts tests/routing-recorder.test.ts` and `npm run typecheck`.

### Task 6: the wiring

**Files:** `packages/host/src/teams.ts`, `packages/host/src/team-prompts.ts`, `packages/host/src/server.ts`, `tests/routing-run.test.ts`, `tests/team-prompts.test.ts`, `tests/outcome-rules.test.ts`. Needs Task 5. Runs in parallel with Task 7.

**Interfaces (produces):**
```ts
// teams.ts: at most 10 added lines.
import type { RoutingRecorder } from "./routing-recorder.js";
import { pinRouting } from "./routing-policy.js";
private router?: RoutingRecorder;
useRouter(router: RoutingRecorder): void { this.router = router; }
// createRun, right after `run.autonomy = goal ? autonomyOf(internal) : autonomyOf(project);`
const routing = this.router ? pinRouting(project.team.routing, run.autonomy, lineup) : undefined;
if (routing) run.routing = routing;
// prepareMember, right after `const run = stored.run, member = this.newMember(...)`
if (role === "implementer" && task && run.routing && this.router)
  this.router.recordStart({ run, task: task as TeamTask, publishHeads: this.publishHeadsEnabled(), entryTools: entryToolsFor(run, "implementer"),
    featureMap: (run.handoff?.project ?? this.config.projects.find(project => project.id === run.projectId)?.team)?.features, limited: this.limits.limited() });
```
`team-prompts.ts`: `delete copy.routing;` in `withoutPrivateSettings`. `server.ts`: `evidence.register(routingModule());` after `outcomeModule()`; `teams.useRouter(new RoutingRecorder({ store: evidence }));`; `sweepExpiredDecisions(evidence, new Date().toISOString());` in `sweepEvidence`; `routing: 1` in the `/me` teams flags.

**Decisions:**

- **The pin needs a router.** Without `useRouter`, `createRun` pins nothing. *(My call: a pin means something only where a recorder exists; every fixture run without a router keeps today's record.)*
- **The call sits after `newMember`.** `newMember` runs `assertBudget`, so a refused start writes no row. `prepareMember` itself is reached only for the first implementer of a pending task; the four replacement paths (`teams.ts` answer, stall, limit switch, escalation) call `newMember` directly. In step 2 the call moves before `newMember`, because the choice must then pass `pinnedProfile`.
- **The member is untouched.** The call passes no profile and changes no field of `member`, `task`, or `run`. The configuration identity keeps `routing: "off"`.
- No `launch()` change, no new run status, no run event, no new event kind.

- [ ] **Step 1: Write the failing tests.** The run tests use `fixture("mixed", mixedLineup, {}, { noServer: true })`, set the fixture project's `autonomy` to `autonomous` in `f.host.config`, build a store as in Task 5, and attach `new RoutingRecorder({ store })` to `f.openTeamService()` as `tests/eval-capture-run.test.ts` attaches its sink. They wait for each member's process to close before teardown, so a signal to an ended child (EPERM on macOS) cannot cancel the file.

| Test name | Assertions |
|---|---|
| `a shadow run records each first implementer and runs the coordinator's profiles` (routing-run) | After the run settles: two rows; `coordinator_profile_id` `spark-high` and `astra-xhigh`; both chosen `astra-xhigh`; the two implementers' `modelProfile.id` are `spark-high` and `astra-xhigh`; `run.routing.mode` shadow. No member's `prompt` contains `"routing":`, a row's `key`, its `policy_digest`, or its `seed`. |
| `an off run pins nothing and writes nothing` (routing-run) | The same scenario with the project `supervised`: the run record has no `routing` key, `routing_decisions` is empty, and the members' profiles equal the shadow run's. |
| `with the store unavailable the run continues` (routing-run) | The recorder's store has the file in place of its database: the run reaches the same terminal status as the shadow run, the members' profiles are unchanged, and no error escapes. |
| `replacements never reach the router` (routing-run) | A fixture scenario that replaces an implementer, with an autonomous project (the worker checks which of `question`, `limit`, and `stall-slow-stop` does so and names it in the test): the run holds exactly one row per task, and the replaced task's row is unchanged after the replacement. |
| `a member context never carries the feature map, the eval block, or routing` (team-prompts, extended) | With `configuredProject.routing` and `handoff.project.routing` set to `{ mode: "shadow", successValueUsd: 8 }`: `teamContext` for every role deep-equals the result without them, contains no `"routing":`, and `teamPrompt` for every role is byte-equal to the result without them (acceptance 1 and 4). |
| `team prompts never import the ledger` (outcome-rules, extended) | `routing-` joins the forbidden specifiers of `team-prompts.ts` and of `team-mcp.ts`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-prompts.test.ts tests/outcome-rules.test.ts`, then `tests/routing-run.test.ts` and `tests/teams.test.ts` on the host (report none cancelled), then `npm run typecheck`.

### Task 7: the status and explain reads, and their routes

**Files:** `packages/host/src/routing-reads.ts`, `packages/host/src/routing-routes.ts`, one `server.ts` line, `tests/routing-reads.test.ts`, `tests/routing-routes.test.ts`, `tests/remote-access.test.ts`. Needs Task 5. Runs in parallel with Task 6, and adds its `server.ts` line after Task 6 commits.

**Interfaces (produces):**
```ts
// routing-reads.ts
export const STATUS_CELL_LIMIT = 50, SHADOW_WINDOW_DAYS = 30;
/** Throws EvidenceError `unavailable` unless `outcomes`, `configurations`, and `routing` are ready. */
export function routingStatus(store: EvidenceStore, input: { projectId: string; saved: TeamRouting | undefined; autonomy: AutonomyMode;
  lineup: TeamLineup | undefined; publishHeads: boolean; entryTools: boolean; now: string }): RoutingStatus;
/** Undefined when no decision exists for the run and task. */
export function routingExplain(store: EvidenceStore, runId: string, taskId: string): RoutingExplain | undefined;
// routing-routes.ts
export function routingRoutes(app: express.Express, deps: { evidence: EvidenceStore; config: () => Config }, guard: express.RequestHandler): void;
```
`server.ts`: `routingRoutes(app, { evidence, config: () => config }, requireRole(["owner", "controller", "viewer"]));` beside `objectiveRoutes`. The route derives `publishHeads` as `publishHeadsEnabled` in `teams.ts` does (`config.teams.publishHeads !== false`) and `entryTools` as `config.teams?.blackboard?.tools === true`, the values a new run pins, so status uses the prompt versions a new decision would use.

**Decisions:**

- **`GET /api/routing/projects/:id`.** An unknown project answers 404 `{ code: "unknown-project" }`. The route reads `project.team.routing`, `autonomyOf(project)`, and `config.teams?.lineup`. `unavailable` answers 503 `evidence-unavailable`.
- **`GET /api/teams/:id/routing/:taskId`.** `:id` is a UUID, lowercased; `:taskId` matches the task id pattern; anything else is 400. No decision answers 404 `{ code: "routing-decision-not-found" }`. The run record need not exist: rows outlive it.
- **Status contents.** `mode`, `requested`, `source`, `knobs`, and `defaults` from `effectiveRouting`. `covers.start` from `screen` without limits (`limits: "not-applied"`, *my call*: limits change by the minute). `shadow`: the project's `recorded` start rows of the last 30 days from `projectDecisions` (newest 500); `withCoordinator` counts rows with a coordinator pick; `agreements` counts chosen equal to it; `greedyAgreements` counts greedy equal to it. `explore`: rows with `explore` among them. `period`: `shadowProgress`. `cells`: `projectCells` with limit 50, newest first, names from each payload, then one `new-task` line, whose target has an area index no row holds, so it shows the project level. Each profile gets the posterior over the rows read once per identity, its interval as the mean ± 1.645 standard deviations clipped to [0, 1], and the greedy mark from `choose`'s greedy rule. A cell whose newest payload does not open is left out and counted in `unreadableCells`.
- **Unknown stays unknown.** No rate is computed on the host: the CLI shows `agreements` of `withCoordinator`, and none when `withCoordinator` is 0. A profile with no rows shows the prior mean 0.5 with `level` `none`, never a count of 0 as a rate.
- **Explain** returns `taskDecisions` with `projectRef`, `areaRef`, `taskKey`, and `featureMapRef` removed.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `status in off mode, without a lineup, and without an eligible profile` (routing-reads) | A `supervised` project: `mode` off, `knobs` null, `covers.reason` `off`, `cells` `[]`. Shadow without a lineup: `no-lineup`. A lineup of contributor profiles: `no-eligible-profile`. |
| `status counts shadow agreement and the shadow period` (routing-reads) | Four rows: chosen a with coordinator a; chosen a with coordinator b; chosen b with no coordinator; chosen a with coordinator a decided 31 days ago. `shadow.decisions` 3, `withCoordinator` 2, `agreements` 1; `period.decisions` 4 and `firstAt` the oldest. 51 rows: `period.decisions` 50 and `capped` true. |
| `status cells come from recorded decisions, at most 50, then the new task line` (routing-reads) | 51 distinct cells: 50 cells newest first, `cellsCapped` true, and a last `new-task` line. With no outcome rows, each profile has `mean` 0.5, `interval` [0.025, 0.975] to three decimals, `level` `none`, and `rows` 0 and 0. The status opens at most 50 payloads (a counting wrapper on `db.open`). |
| `explain decodes every decision of a task and hides blind indexes` (routing-reads) | Rows of revisions 1 and 2 for one task: two entries in revision order; no entry has `projectRef`, `areaRef`, `taskKey`, or `featureMapRef`. A damaged payload gives `payload` null. An unknown task gives undefined. |
| `routing reads answer every paired role` (routing-routes, host) | Owner, controller, and viewer get 200 for both routes. An unknown project gives 404 `unknown-project`; an unknown task gives 404 `routing-decision-not-found`; `taskId` `A_B` gives 400. With the evidence directory replaced by a file, both answer 503 `evidence-unavailable`. |
| `the relay refuses routing reads` (remote-access) | `["GET", "/routing/projects/<id>"]` and `["GET", "/teams/<uuid>/routing/task-1"]` answer 403 `remote-endpoint-denied`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-reads.test.ts`, then `tests/routing-routes.test.ts` and `tests/remote-access.test.ts` on the host, then `npm run typecheck`.

### Task 8: the routing command

**Files:** `packages/host/src/routing-cli.ts`, `packages/host/src/client.ts`, `packages/host/src/cli.ts`, `packages/host/src/client-entry.ts`, `tests/client-args.test.ts`, `tests/routing-routes.test.ts` (one more test after Task 7). Needs Task 7.

**Interfaces (produces):**
```ts
// routing-cli.ts
export async function handleRoutingClientCommand(positional: string[], options: Record<string, string | boolean>, api: ApiClient): Promise<void>;
export function routingStatusLines(status: RoutingStatus): string[];
export function routingExplainLines(explain: RoutingExplain): string[];
```
`client.ts`: `routing` joins `CLIENT_COMMANDS` and dispatches to the handler as `autonomy` does; `--routing`, `--routing-value`, and `--routing-contributor` join `CLIENT_STRING_OPTIONS` (Task 9 reads them). Help lines in `cli.ts` and `client-entry.ts`: `infinite routing status PROJECT [--json]`, `infinite routing explain RUN_ID TASK_ID [--json]`, and `infinite repo init ... [--routing off|shadow] [--routing-value cost|balanced|quality|USD] [--routing-contributor allow|deny]`.

**Decisions:**

- **`PROJECT` is required.** *(My call: Part 9 makes it optional, but an all-projects status reads every project's rows; it waits for a need.)*
- **Status lines, in order.** (1) `Project ID · routing shadow (saved)`, `(autonomous default)`, or `· routing off`; then ` · requested auto: this host records shadow decisions only` when so. (2) `Value $V per success · list weight W · contributor profiles allowed|not allowed`, each followed by ` (default)` when it is one. (3) `Start: covered` or `Start: not covered (REASON)`. (4) `Shadow, last 30 days: N decisions; the router matched the coordinator in K of M`, or `; no decision had a coordinator pick`, plus ` (newest 500)` when capped. (5) `Shadow period: N of 50 decisions since DATE; it ends after 14 days and 50 decisions, whichever is later.` or `Shadow period: no decision yet.` (6) `Would explore: X of Y, before the share, budget, and headroom guards.` (7) `Costs are tier defaults: light $0.40, strong $2.20, rescue $1.50. Limit headroom is not modelled. Intervals are 90% normal approximations. Coordinator-chosen history counts at half weight.` (8) Per recorded cell (at most 50 cells with a decision in the last 30 days; their evidence still counts for 180 days) `Cell AREA · KIND or no kind · features vN MAP` (MAP is `default` or the first 12 hex), or `New task (project level)`; then per profile `  PROFILE  mean M [L, H] · rescue R · rows production P, duel D · earlier mass E (N rows) · level LEVEL · $C`, where the earlier-mass phrase is `earlier mass E (N rows)` when the rounded `mass` (before each level's cap) equals `appliedMass` (after it), and `earlier mass APPLIED of RAW applied (N rows)` otherwise; with ` · greedy` on the greedy one, or `  PROFILE  removed: REASON`. (9) `Older cells are not shown.` when capped. (10) `Cells with unreadable details: N.` when above 0. Every text value passes through `clean`.
- **Explain lines**, per decision: `Revision R · start 1 · shadow · recorded · basis BASIS · decided AT`, `Chosen X · greedy Y · coordinator Z or none · explore yes|no`, `Policy DIGEST12 · seed SEED12 · algorithm A · reward W`, then one line per candidate with its mean, deviation, rescue, cost, greedy utility, sample, and sampled utility, or its removal. `The decision's details are unreadable.` when `payload` is null.
- **Errors.** 404 `unknown-project`: `No project has this ID.` 404 `routing-decision-not-found`: `No routing decision exists for this run and task.` 503: `The evidence store is unavailable.` A host without `/me` `teams.routing` 1: `This host does not record routing decisions. Upgrade the host first.` Each exits non-zero.
- `--json` prints the answer as received.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `routing lines show unknown, never zero` (client-args) | A status with `withCoordinator` 0 prints `no decision had a coordinator pick`; a profile with `level` none prints `level none` and `rows production 0, duel 0`; `requested` auto prints `this host records shadow decisions only`; `firstAt` null prints `no decision yet`; a cell area with a control character prints a space there. An explain with `payload` null prints the unreadable line. |
| `routing options parse` (client-args) | `parseClientArgs` keeps the values of `--routing`, `--routing-value`, and `--routing-contributor`; `clientCommandCandidate(["--json", "routing"])` is `routing`. |
| `the routing command prints status and explain` (routing-routes, host) | After one recorded decision: `infinite routing status ID` exits 0 and prints `routing shadow`; `explain RUN TASK` prints `basis`; an unknown project exits non-zero with `No project has this ID.` |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/client-args.test.ts`, then `tests/routing-routes.test.ts` on the host, then `npm run typecheck`.

### Task 9: `repo init --routing`, and the docs

**Files:** `packages/host/src/team-cli.ts`, `docs/teams.md`, the design, `tests/autonomy-enrollment.test.ts`. Needs Task 6 (the `/me` flag). Runs in parallel with Task 8, and runs its host test after Task 8 commits `client.ts`, which registers the three option names.

**Interfaces (produces):** `infinite repo init [DIR] ... [--routing off|shadow] [--routing-value cost|balanced|quality|USD] [--routing-contributor allow|deny]`.

**Decisions:**

- **The team body carries `routing`.** `body.team` (`team-cli.ts:724`) gains `routing` when the result is not empty: `target.team?.routing` with the given options merged over it. With none of the three options, `target.team.routing` passes unchanged, so a rerun keeps it.
- **Values.** `--routing auto` exits non-zero with `This host records shadow decisions only. Use --routing shadow; auto routing comes with a later release.` *(My call: the host still accepts a saved `auto` from the team route and runs it as shadow, and status says so.)* `--routing-value` takes a preset (0.5, 2, 8) or a finite number from 0 to 100, else exits with `--routing-value must be cost, balanced, quality, or a dollar value from 0 to 100.` `--routing-contributor allow|deny` sets `allowContributor` true or false.
- **Capability.** Any of the three options against a host without `me.teams?.routing === 1` exits with `This host does not support routing settings. Upgrade the host before using --routing.` before anything is written.
- The three flags join the non-Git `unsupported` list (`team-cli.ts:608`). The pending-intent comparison already compares `team` as JSON.
- **Docs.** `docs/teams.md`: the shadow recorder, the default per autonomy mode, what a row holds, status and explain, retention, the rollback note (remove `routing` from every project before rolling back past this release). The design: Part 1 "a policy without `mode` takes the project's default mode"; Part 5 "a shadow run is never refused"; Part 7 "a shadow row has `member_id` NULL" and the `feature_map_ref` column; Failure modes "in shadow, no run line"; Left to the builder, filled in: the sampler, computed on read, the index names, the interval method, the tier defaults.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `repo init saves routing and keeps it when omitted` (autonomy-enrollment, host) | Pattern of `repo init stores an explicit mode outside the team block and keeps it when omitted`: `--routing shadow --routing-value quality` stores `{ mode: "shadow", successValueUsd: 8 }`; a rerun without the options keeps it; `--routing-contributor allow` adds `allowContributor` true and keeps the rest; `--routing auto` exits non-zero and stores nothing new. |

- [ ] **Step 2: Run the test and confirm it fails.** **Step 3: Implement**, and amend the docs and the design. **Step 4: Run** `tests/autonomy-enrollment.test.ts` on the host and `npm run typecheck`.
- [ ] **Step 5: The coordinator runs `npm run check` once (count failed and cancelled tests), requests the independent review, and commits.**

## Not in this slice

- `auto` mode: the plan schema and prompt change, `task.routing`, `pinnedProfile`, the pending, applied, and released states, the fixed rules on limit fallbacks, `routing-no-eligible-profile`, the end of the shadow period as a stored fact, the exploration share, budget, pause, and headroom guards, `pause-explore`, `resume-explore`, and `revoke-routing` (delivery step 2). Step 2 also moves the call before `newMember` and widens `ConfigComponents.routing`.
- The who-chose lookup of applied rows. Every row counts at `CHOSEN_WEIGHT` until `auto` writes applied rows.
- Replay priors and the dry run (step 3); `orderProbability` (with the duels design).
- The escalation and scout points (step 4) and the learned cascade (step 5). `cascade` is pinned and shown, never applied.
- Measured costs and the rescue cost from the ledger, limit headroom and pressure, model families (C19), and the duel tie-break: they need code that other designs own.
- Status in the web, phone, and Mac clients (step 6), and status for all projects at once.
- A secret scan of the payload, and a `deleteRun` for decision rows.
- Carrying `features` and `eval` through `repo init`: done on main by INF-256 (#157), which carries every team key that `repo init` does not own, `routing` included.

## Owner decisions this slice needs, with the defaults it builds

1. The value preset (decision 3): `balanced`, $2 per success.
2. Contributor eligibility (decision 4): not allowed by default; `--routing-contributor allow` per project. Where the coordinator plans tasks on a contributor profile, the router's pick differs by construction, and status shows the removal beside the agreement count.
3. Coordinator-chosen history (decision 5): half weight. At zero weight a shadow decision has no evidence at all, and every posterior stays `Beta(1, 1)`.
4. The shadow period (decision 1): 14 days and 50 recorded start decisions. This slice only shows progress toward it.
