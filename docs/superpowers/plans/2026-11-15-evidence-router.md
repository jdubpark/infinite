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

---

# Slice: `auto` at `start`

Evidence router design (INF-186), delivery step 2: Part 1 (the `auto` pin, `routing-no-eligible-profile`, `revokeRouting`, the end of the shadow period as a stored fact), Part 5 (the fixed rules on limit fallbacks, and the exploration guards except headroom), Part 7 (the `pending`, `applied`, and `released` states, `task.routing`, the who-chose weight), Part 8 (the `start` point), and Part 9 (`pause-explore`, `resume-explore`, `revoke-routing`, `repo init --routing auto`). Acceptance 3, 5, 6, 7 (start, fallbacks, scouts, escalations), 15, and 16. After this slice, a project whose owner saved `mode: "auto"` starts each first implementer on the router's choice once the project's shadow period has ended. The coordinator's plan may omit `agentProfileId`. The host writes a `pending` row before it creates the member, and the row becomes `applied` when the member starts on that profile. The owner pauses exploration per project and revokes routing per run. It builds on the shadow recorder (`routing-*.ts`), the event outbox, and configuration identity. It runs no Git command and adds no run status, no event kind, and no setting key.

**`auto` comes only from a saved `mode: "auto"`, and only after the project's shadow period has ended.** An `autonomous` project without a saved policy stays in shadow. A saved `auto` is accepted at any time: until the end of the period is stored, runs pin step 1's shadow pin with `requested: "auto"`, byte for byte, and `repo init` prints a note on stderr. *(My call, against Part 1's autonomous default: the coordinator's brief requires an explicit per-project setting and forbids a default. The flip is one line of `pinRouting` and two test rows, for the owner to rule on. Refusing a saved `auto` before the period ends would make the owner come back after two weeks; accepting it changes nothing until the period ends.)*

**The end of the shadow period is a stored fact, taken once from `recorded` rows.** It is the later of 14 days after the project's first recorded `start` row and the time of its 50th recorded `start` row. The first `createRun` of a project that saved `auto`, at or after that time, stores it in a new table `routing_projects`, and it never moves: neither later rows nor retention can restart a period that has ended. *(My call: Part 1 makes the end "a host-held fact" but does not say when it is taken. Taking it at pin time costs nothing for every other project.)*

**The choice is applied in `prepareMember`, before `newMember`, through `pinnedProfile`.** `RoutingRecorder.applyStart` writes the `pending` row and returns the profile. A new outbox projector `routing` moves the row to `applied` or `released` from four existing event kinds: `member.started`, `run.revision-advanced`, `run.settled`, and `run.deleted`. The projector's cursor survives a restart, so it is the design's "startup pass". In `off` and `shadow` the call passes no profile, so `newMember` runs as on main.

**When the router cannot choose, the task starts on the coordinator's pick if it passes rules 1 and 2, else on the default profile, and one run line says so.** The same rule serves a revoked run. *(My call, against the failure table's "the host starts the default profile": the coordinator's pick is what would have run without the router, and Part 1's revoke rule already uses it. Rules 1 and 2 still bind it.)*

**The fixed rules bind every implementer and scout profile of an `auto` run, revoked or not.** The router screens rules 1 to 3 as in step 1. A plan's `agentProfileId` is checked against the pool only, recorded as `coordinator_profile_id`, and starts only through the fallback rule. A limit fallback skips a target that fails rule 1 or 2, as it skips a limited provider. A scout or an escalation profile that a worker names must pass rule 1. *(My call for scouts and escalations: Part 2 leaves their decision points to step 4, but "Authority and safety" and acceptance 7 bind every `auto` run now.)*

Where the code and the design disagree, and the ruling for this slice:

- **`configIdOf` in `outcome-projector.ts` refuses a routing component other than `off`** (lines 846 and 852), as `parseConfigured` and `memberConfiguration` do. The step-1 plan named only the last two. Ruling: Task 5 widens all three with one `isRoutingComponent`. Without it, every outcome row of an `auto` run would lose its configuration and count only as earlier evidence.
- **`policyDigest` hashes a literal `mode: "shadow"`.** Ruling: a `mode` parameter that defaults to `shadow`, so every step-1 digest is unchanged; an `auto` pin hashes `auto` and is a new routing policy version (C7).
- **`shadowProgress` counts `start` rows of any state.** Ruling: `recorded` rows only, through the new index `routing_by_state`. On step-1 data the count is unchanged.
- **Part 7's `task.routing = { decisionKey, profileId, mode }`.** Ruling: `{ profileId, by: "router" | "fallback" }`. The key is recomputed from the run, the revision, and the task's blind index, so it stays off the run record and the relay view; `mode` is always `auto` where the field exists; `by` records the fallback that Failure modes requires.
- **No headroom or pressure code exists** (delegated adoption design Part 8). Ruling: the headroom guard is not applied, `greedy-headroom` is never written, and status says so, as in step 1.
- **The import guard bars `routing-` modules from `team-prompts.ts` and `team-mcp.ts`.** Ruling: the pool helpers the prompts need live in `team-types.ts`; `routing-rules.ts` holds the rest; an agreement test ties `fixedRuleFailure` to `screen`.
- **Part 9's `infinite team revoke-routing RUN_ID --revision N`.** Ruling: the `revoke-permissions` pattern. The command reads the run's current revision; there is no `--revision` option.
- **Part 7 releases a row when "the run halts first".** Ruling: a halted or blocked run keeps its `pending` rows. A run the halt held while it waited for input resumes in place, in the same revision, and reuses them; every other resume advances the revision (`resumeRun` in `teams.ts`), and `run.revision-advanced` releases them. Rows are also released when the run settles or is deleted, and a `pending` row older than 7 days counts nowhere and is released by the next decision of its project.
- **The step-1 plan names `projectRef` parameters; `routing-store.ts` takes a project id and computes the index itself** (`projectDecisions`, `shadowProgress`). Ruling: new reads follow the code.

**Rollback.** A host before this slice reads the `routing` module as unavailable, because its stored version is 2; it records no shadow row and answers 503 to status. A saved `auto` there pins shadow (step 1's `effectiveRouting`). A pending task of an `auto` run without `agentProfileId` is refused there with `invalid-agent-profile`, and a member configuration whose routing component is a digest is skipped with one log line. The release notes say: let every `auto` run settle, or cancel it, before rolling back past this release.

## Coordinator rulings (2026-11-16)

These rulings override the text below where the two differ.

1. **The autonomous default becomes `auto` after the shadow period.** This follows design Part 1 and owner decision 1, which the owner confirmed on 2026-11-13: "router `auto` after a shadow period with 20% exploration".
   - **The rule.** An `autonomous` project with no saved routing policy pins `auto` once its period end is stored: `{ mode: "auto", requested: "auto", source: "autonomous-default", knobs, defaults, algorithmVersion: 1, rewardVersion: 1, digest: policyDigest(effective, "auto"), periodEndedAt }`. Until the end is stored, its pin is step 1's shadow pin, byte for byte. A saved `shadow` or `off` is the owner's choice and wins over the default. A `supervised` project without a saved policy stays `off`.
   - **Task 1.** `pinRouting` pins `auto` for a saved `mode: "auto"` or for the autonomous default, when `start` is among the points, a lineup exists, and `periodEndedAt` is given. The test `an auto pin needs a saved auto mode and a period end` becomes `an auto pin needs a saved auto mode or the autonomous default, and a period end`. Its cases:
     - with an end, no saved policy in an `autonomous` project gives the auto pin with `source` `autonomous-default`;
     - with an end, a saved `shadow`, a `supervised` project without a policy, `points: ["escalation"]`, and no lineup each give step 1's result;
     - with no end, the autonomous default gives step 1's shadow pin, byte for byte.
   - **Task 7: the period end.** `pin` step (1) reads the period end for a saved `auto` and for the autonomous default.
   - **Task 7: coverage.** A saved `auto` without an implementer that passes rules 1 and 2 refuses with 409 `routing-no-eligible-profile`, as planned. The autonomous default never refuses a run. Without coverage it gives the shadow pin and logs `AUTO_LOG.uncovered` once per recorder: `Routing auto pin stayed in shadow: no implementer profile passes the fixed rules.` Status then shows `covers.reason` `no-eligible-profile`. Add this case to `the pin is auto only after the stored period end, and refuses without coverage`: the autonomous default over an all-contributor lineup, with a stored end, gives the shadow pin and no 409.
   - **Task 8.** Status `mode` is `auto` when a new run would pin `auto` under either rule.
   - **Task 10.** For the autonomous default during its period, status line (1) reads `ID · routing shadow (autonomous default) · auto starts after the shadow period`. Line (5)'s ` Auto routing needs --routing auto.` appears only for a saved `shadow`. `ROUTING_AUTO_NOTE` stays as written, for `--routing auto`.
   - **Task 11.** The docs and the design amendment keep Part 1's autonomous default. Amend only three things: the stored end and when it is taken, the fallback rule, and the coverage rule above.
   - **The release note for this slice.** After the deploy, each autonomous project starts new runs in `auto` once 14 days have passed since its first recorded shadow start and it has 50 recorded start decisions. `infinite routing status PROJECT` shows the progress, and `--routing shadow` keeps a project in shadow.
2. **Accepted as the writer proposed:**
   - the fallback rule: the coordinator's pick when it passes rules 1 and 2, else the default profile;
   - rule 1 binds scouts, escalations, and limit fallbacks in every auto-pinned run;
   - `task.routing = { profileId, by }`;
   - the `routing` projector is the startup pass, and a stale pending row is released after 7 days;
   - the share guard is strict from the first decision;
   - headroom is not applied;
   - `revoke-routing` reads the current revision;
   - the period counts recorded rows, including rows from before `auto`.
3. **Line counts on today's main (`3a0eacb`).**
   - `teams.ts` is 5,757 lines (#171 removed 3, #172 added 5), so Task 9's net −10 gives 5,747.
   - `team-cli.ts` goes from 1,263 to 1,242 lines, and `server.ts` stays at 2,282.
   - Task 9's line numbers are those of main `0e108bf`; find each place by its quoted code. #172 added `permissionAgentTask` after `permissionAgentLive`, and its hand-off uses `memberTaskOf`; neither is in a region Task 9 edits.
   - Task 11 step 5 lowers the two baseline entries with `node scripts/check-file-size.mjs --update` and checks the output.
4. **Merge order.** This slice merges before the intent check (INF-282). Both change the plan path in `teams.ts`, so the intent check rebases on this one.

## Trust boundary, and what a review checks

The pin, the decision, the projector, the reads, and the routes are host code. These inputs originate outside the host:

- **The owner's policy.** `mode: "auto"` arrives through `PUT /api/projects/:id/team` (owner role) or `infinite repo init --routing auto` with an owner key. It is inside the routine approval digest (C11), so saving it blocks an active routine until the owner approves it again (step 1's `routing settings change the approval digest, and their absence keeps it`). It changes no run until the period end is stored.
- **The owner's pause and revoke.** Owner-role routes. The pause lives in `routing_projects`, outside the approval digest (acceptance 16). The revoke sets `run.routingRevokedAt` through the run's request receipts, like `revoke-permissions`.
- **The coordinator's plan** is member text. In an `auto` run `agentProfileId` may be absent; a present one must name a pool profile (409 otherwise) and is recorded. No plan field adds a profile or changes a rule.
- **A worker's `explore` and `escalate` reports** are member text. In an `auto` run each scout profile must be in the rule-1 scout pool (409 `invalid-agent-profile`), and the escalation profile in the rule-1 escalation pool (409 `invalid-escalation`).
- **Run events** that the projector reads are host-emitted. It reads `role`, `profileId`, and `replaces` from `member.started`, and the ids and the revision of each event.
- **Route parameters** come from paired devices. A project id must name a configured project; a run id is a UUID, lowercased; the revoke body is `teamActionSchema`. No new route is on the relay allow-list (`allowedPath` in `remote-access.ts` matches none of them; Task 8 tests it).

**What reaches stored text.** The decision payload holds step 1's fields plus `guards`: a pause time, a count of spare attempts, and two counts. `routing_projects` holds a blind index and three times. The run record gains `task.routing` (a profile id and an enumeration) and `run.routingRevokedAt` (a time). A fallback adds one run line with the task id and the profile's label. Nothing reads a session's environment, a journal, or a provider output, so a GitHub grant or an egress proxy password cannot reach any of them. The new run fields reach relay devices through the team view, and they are disclosed: they hold no member text. *(My call: no `evidence/secret-scan.ts` pass, as in step 1.)*

**What a member sees.** No routing value. `teamContext` removes `routing` from every task of `tasks`, of each continuation, and of `discovery`, for every role. The inline implementer task drops it. `run.routing` and `run.routingRevokedAt` are not among the run fields `teamContext` copies. In the `auto` coordinator prompt, the worker pool paragraph becomes fixed text that starts "The host assigns each plan task's worker profile; omit agentProfileId from plan tasks." and keeps main's last two sentences. It carries no policy, key, digest, posterior, reward, or utility, so the permission agent's 4,000-character read finds none. No MCP tool reads routing state.

**What the ledger records.** Nothing new: no run status and no event kind. The projector reads four existing kinds. An `auto` run's member configurations carry the policy digest as their routing component (C7), and their outcome rows keep their configuration id.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| An `off` or `shadow` project, with or without a lineup | Pins, plan checks, prompts, contexts, and launches equal to step 1's | Task 1 `off and shadow pins are byte-equal to step 1`; Task 2 `off and shadow plan checks refuse as main does`; Task 6 `off and shadow prompts and contexts are byte-equal to main`; Task 9 runs the five step-1 tests of `tests/routing-run.test.ts`, with only their router harness changed, and the `mixed-invalid` refusal of `tests/teams.test.ts` unchanged |
| A saved `auto` before the period ends | Step 1's shadow pin with `requested` auto; shadow rows; never refused | Task 1 `an auto pin needs a saved auto mode and a period end`; Task 7 `the pin is auto only after the stored period end, and refuses without coverage` |
| The 50th recorded start lands, more rows follow, retention removes the oldest | The end is stored at the first auto-requesting create after it and never moves | Task 3 `the period end is the later of 14 days and the 50th recorded start, stored once` |
| An `auto` plan without `agentProfileId`, two tasks, a question answered | Accepted; each first implementer runs its row's chosen profile; rows `pending`, then `applied` with the member; the answer's replacement keeps the profile and writes no row | Task 9 `an auto run accepts a plan without profiles and starts the router's choice` |
| `prepareMember` twice for one task, with a lost save and new outcome rows between | One row; the same profile | Task 7 `a second start reuses the pending row and the task's routing` |
| Store unavailable or closed, a decision over 250 ms, a payload over 32 KiB, a failed write, a throw | Fallback profile, one run line, no row, one log line per reason; the run continues | Task 7 `every failure starts the fallback profile with one run line`; Task 9 `with the store closed an auto run starts fallback profiles and continues` |
| A member starts on a limit fallback; a run settles, advances, or is deleted with `pending` rows | Released; counts nowhere | Task 3 `the projector applies or releases each pending row once` |
| Projector events repeated, in each order of three, or replayed after a restart | The same rows as one projection | Task 3 `projecting again, in each order of three events or after a restart, changes nothing` |
| Exploratory picks during a pause, below `minSpareAttempts`, at elevated risk, or with a full share; any interleaving of decisions, applications, and releases | Greedy with its basis; the share bound holds at every exploratory start, pending rows included; a released row frees its place | Task 4 `paused, low budget, and elevated risk never explore over 1,000 seeds`, `the share holds at every exploratory start for any interleaving, and a released row frees its place`; Task 7 `the guards make exploratory picks greedy in a real store, and the payload records them` |
| A limit fallback whose target is a contributor or on the reviewer's model | Skipped in `auto`, as a limited provider is; unchanged in `off` and `shadow` | Task 2 `auto fallbacks skip a target that fails a fixed rule; off and shadow keep main's chain` |
| A scout or an escalation on a contributor profile in `auto` | 409 | Task 2 `auto plans may omit profiles, and scouts and escalations pass rule 1` |
| The owner revokes | New starts on the fallback profile; no new row; a new coordinator sees the eligible pool | Task 9 `revoking routing returns new tasks to the coordinator's profiles` |
| The owner pauses, then resumes | No exploration while paused; the saved configuration and the approval digest unchanged | Task 4 (pause guard); Task 8 `a pause leaves the saved configuration unchanged` |
| An `auto` pin whose lineup cannot cover `start` | `createRun` answers 409 `routing-no-eligible-profile` | Task 7 `the pin is auto only after the stored period end, and refuses without coverage` |
| A member configured in an `auto` run | Its configuration stored with the digest; its outcome row keeps the id | Task 5 `a routed member's configuration is stored and its outcome row keeps the id` |
| A rollback to a host before this slice | The `routing` module unavailable there; saved `auto` pins shadow; see **Rollback** | Store rule of `register`; release notes, no new test |

## Cost on the launch path

`createRun`: in `off` and `shadow`, and in a project without a saved `auto`, nothing new is read. A project that saved `auto` adds one primary-key read of `routing_projects`; until its end is stored, two seeks of `routing_by_state` (one row each, the second at offset 49) and at most one write. Coverage is `screen` in memory.

One `auto` decision per task and revision, inside `prepareMember`, synchronous:

- one primary-key read of `routing_decisions`; a found row ends the read;
- per distinct candidate identity (at most 8): step 1's `epochAt` read and two seeks of `outcomes_by_route` (at most 1,000 rows each), and one covering seek of `routing_by_identity` (at most 2,000 entries);
- one primary-key read of `routing_projects`, and two seeks of `routing_by_state` (at most `exploreWindow − 1`, so 499, entries each);
- one `store.tryWrite`: one insert and one update of at most 100 stale rows.

No sealed payload opens. At 10,000 outcome rows a decision reads at most 10,000 outcome rows, 16,000 identity entries, and 998 window entries. Expected time is tens of milliseconds, and the 250 ms budget is measured as in step 1. A shadow decision adds the identity seek; on a host with no applied row it finds nothing. `recordStart` returns before any read for an `auto` pin. `applyStart` returns before any read for `off` and `shadow`, and for a task that already holds `task.routing`.

The projector runs where the outbox advances, as the outcome projector does: once after each flush of a run's events (one page of at most 500 events) and in the host's catch-up pass (at most 20 pages). Per `member.started`: one blind index and at most one primary-key update. Per `run.settled`, `run.deleted`, or `run.revision-advanced`: one update of at most 200 rows through `routing_by_task`. On the first start after the upgrade it reads the stored events of its four kinds once, page by page; no update finds a `pending` row. Status adds one primary-key read, two window seeks, and one identity seek per candidate. At 1,000 sessions nothing changes: nothing is read per session, member, or run on a list route or a tick.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/routing-types.ts` (modify) | The `auto` pin, three bases, `ExploreGuards`, `ProjectRoutingState`, the new status fields |
| `packages/host/src/routing-policy.ts` (modify) | `policyDigest` with a mode; `pinRouting` with a period end |
| `packages/host/src/team-types.ts` (modify) | Task 1: `TaskRouting`, `TeamTask.routing`, `TeamRun.routingRevokedAt`. Task 2: `fixedRuleFailure`, `autoPinned`, `autoRouted`, the three pools, `memberLimit`, `switchFallback` (moved), the predicate of `resolveLimitFallback` |
| `packages/host/src/routing-rules.ts` (create) | `assertTaskProfiles` (moved from `teams.ts`), `fallbackRule`, `fallbackProfile`, `spareAttempts`, `routingComponent` |
| `packages/host/src/routing-store.ts` (modify) | Module `routing` version 2: `routing_projects`, two indexes, the period, the pause, the share window, applied ids, settle and release, the projector, `registerRouting` |
| `packages/host/src/routing-guards.ts` (create) | Pure: `shareAllows`, `guardExploration` |
| `packages/host/src/routing-posterior.ts` (modify) | The who-chose weight of applied rows |
| `packages/host/src/config-identity.ts`, `configuration-store.ts`, `outcome-projector.ts` (modify) | The routing component is `off` or a policy digest |
| `packages/host/src/team-prompts.ts` (modify) | The `auto` coordinator sentence, the filtered pools, `routing` out of every context and inline task |
| `packages/host/src/run-events.ts` (modify) | `appendRunEvent`, moved from `teams.ts` |
| `packages/host/src/routing-auto.ts` (create) | `decideAutoStart`, `periodEnd`, `AUTO_LOG` |
| `packages/host/src/routing-recorder.ts` (modify) | `pin`, `applyStart`; `recordStart` skips `auto` pins and weighs applied rows |
| `packages/host/src/routing-reads.ts` (modify) | Status: the mode, the period end, the pause, the share, the state counts, the who-chose weight |
| `packages/host/src/routing-routes.ts` (modify) | The pause, resume, and revoke routes |
| `packages/host/src/teams.ts` (modify) | Net −10 lines (5,757 to 5,747 on main `3a0eacb`), only the lines Task 9 lists |
| `packages/host/src/server.ts` (modify) | Net 0 lines: lines 45, 260, 834, and 1100 edited in place |
| `packages/host/src/routing-cli.ts` (modify) | `requestedRouting` (moved from `team-cli.ts`, now with `auto`), `pause-explore`, `resume-explore`, the `auto` lines, `ROUTING_AUTO_NOTE` |
| `packages/host/src/team-cli.ts` (modify) | Net −21 lines (1,263 to 1,242): `requestedRouting` moved out, the `auto` capability line, the note, `revoke-routing` |
| `packages/host/src/cli.ts`, `client-entry.ts` (modify) | Help lines. `client.ts` is unchanged |
| `docs/teams.md`, the design (modify) | Auto routing, and the amendments listed in Task 11 |
| `tests/routing-{rules,guards,projector,identity,auto,auto-run}.test.ts` (create); `tests/{routing-policy,routing-store,routing-posterior,routing-recorder,routing-reads,routing-routes,routing-run,team-prompts,remote-access,client-args,autonomy-enrollment,usage-config}.test.ts`, `tests/fixtures/team-agent.mjs` (modify) | Pure rules, a real store, a direct team service, the host. No test file over the ratchet: `tests/teams.test.ts`, `tests/team-events.test.ts`, `tests/outcome-store.test.ts`, and `tests/evidence-store.test.ts` are not touched |

**Order and owners.** Task 1 runs first and is small. Then Tasks 2, 3, 4, 5, and 10 run in parallel. Task 6 waits for Task 2. Task 7 waits for Tasks 2, 3, and 4. Task 8 waits for Tasks 3 and 4, and runs in parallel with Tasks 6 and 7. Task 9 waits for Tasks 5, 6, 7, and 8; it is the only writer of `teams.ts`, `server.ts`, `tests/routing-run.test.ts`, and `tests/fixtures/team-agent.mjs`. Task 11 waits for Tasks 9 and 10. Files with two writers have them in sequence: `team-types.ts` (Task 1, then Task 2) and `tests/routing-routes.test.ts` (Task 8, then Task 11). Every name, signature, statement, status code, and sentence that one task builds against another's is fixed below. Line numbers of `teams.ts` and `server.ts` are main's (`0e108bf`).

## Review Focus

1. **Routing data reaching a member**: `task.routing`, a decision key, the digest, a seed, a knob, or a posterior in any prompt, context file, continuation, or discovery snapshot, for any role, or inside the first 4,000 characters the permission agent reads. Expect none (Task 6 `an auto coordinator is told the host assigns profiles`, `a member context never carries a task's routing, in any role or snapshot`; Task 9 `an auto run accepts a plan without profiles and starts the router's choice`, which searches every member prompt and every role's context; step 1's `team prompts never import the ledger`).
2. **Off and shadow are not byte-identical**: a changed pin, digest, plan refusal, prompt byte, context byte, or launched profile without a saved `auto`. Expect none (Task 1 `off and shadow pins are byte-equal to step 1`; Task 2 `off and shadow plan checks refuse as main does`; Task 6 `off and shadow prompts and contexts are byte-equal to main`; the five step-1 run tests with their assertions unchanged, and the `mixed-invalid` refusal).
3. **A profile that fails a fixed rule starts in an `auto` run**: by the router's choice, the fallback, a limit fallback, a scout, an escalation, or a replacement. Expect none (Task 2 `auto plans may omit profiles, and scouts and escalations pass rule 1`, `auto fallbacks skip a target that fails a fixed rule; off and shadow keep main's chain`, `the fallback profile is the coordinator's pick when it passes, else the default`; Task 7 `every failure starts the fallback profile with one run line`; Task 9 `revoking routing returns new tasks to the coordinator's profiles`).
4. **Exploration outside its guards**: an exploratory start during a pause, below `minSpareAttempts`, at elevated risk, or over the share; a share that ignores `pending` rows or keeps a released one. Expect none (Task 4 `paused, low budget, and elevated risk never explore over 1,000 seeds`, `the share holds at every exploratory start for any interleaving, and a released row frees its place`; Task 3 `the share window counts the newest pending and applied starts, and stale pending rows are released`; Task 7 `the guards make exploratory picks greedy in a real store, and the payload records them`).
5. **A row stuck or misapplied, or a period that moves**: a row `applied` on a limit fallback, a `pending` row that outlives its run, a second decision for one key, a recorded row that changes, an end computed from `auto` rows or moved by retention. Expect none (Task 3 `the period end is the later of 14 days and the 50th recorded start, stored once`, `the projector applies or releases each pending row once`, `projecting again, in each order of three events or after a restart, changes nothing`; Task 7 `a second start reuses the pending row and the task's routing`, `the pin is auto only after the stored period end, and refuses without coverage`).

### Task 1: the `auto` pin and the shared types

**Files:** `packages/host/src/routing-types.ts`, `packages/host/src/routing-policy.ts`, `packages/host/src/team-types.ts` (types only), `tests/routing-policy.test.ts`. Runs first. Tasks 2 to 11 start from its commit.

**Interfaces (produces):**
```ts
// routing-types.ts: changed and added types only.
export type TeamRunRouting = { mode: "shadow" | "auto"; requested: "shadow" | "auto"; source: "saved" | "autonomous-default";
  knobs: RoutingKnobs; defaults: (keyof RoutingKnobs)[]; algorithmVersion: number; rewardVersion: number; digest: string;
  /** `auto` pins only: the stored end of the project's shadow period. */
  periodEndedAt?: string };
export type Basis = "sampled" | "greedy-risk" | "greedy-paused" | "greedy-budget" | "greedy-share" | "single-candidate" | "default-all-limited";
/** What the guards read for one `auto` start. Sealed in the payload of every `auto` row. */
export type ExploreGuards = { pausedAt: string | null; spareAttempts: number; share: { exploratory: number; of: number } };
// RoutingPayload gains `guards?: ExploreGuards` (auto rows only; a shadow payload is unchanged).
export type ProjectRoutingState = { periodEndedAt: string | null; explorePausedAt: string | null };
// RoutingStatus: `mode` widens to "off" | "shadow" | "auto"; `explore` and `period` gain fields; `share` and `auto` are new.
//   explore: { exploratory: number; of: number; guards: "risk-only" | "applied"; pausedAt: string | null };
//   share: { exploratory: number; of: number; window: number; limit: number } | null;              // auto only
//   auto: { windowDays: 30; pending: number; applied: number; released: number; capped: boolean } | null;  // auto only
//   period: { decisions: number; capped: boolean; firstAt: string | null; targetDays: 14; targetDecisions: 50;
//     endsAt: string | null; endedAt: string | null; stored: boolean };

// routing-policy.ts
/** SHA-256 hex of canonicalJson({ algorithmVersion, rewardVersion, mode, knobs }). The default keeps every step-1 digest. */
export function policyDigest(effective: Extract<EffectiveRouting, { mode: "shadow" }>, mode?: "shadow" | "auto"): string;
/** Step 1's pin, unchanged without `periodEndedAt`. With it and a saved `mode: "auto"`, the `auto` pin. */
export function pinRouting(saved: TeamRouting | undefined, autonomy: AutonomyMode, lineup: TeamLineup | undefined, periodEndedAt?: string): TeamRunRouting | undefined;

// team-types.ts
/** `auto`-pinned runs only: the profile the host started the task on, and who chose it. Disclosed in the team view; never in a member's prompt or context. */
export type TaskRouting = { profileId: string; by: "router" | "fallback" };
// TeamTask gains `routing?: TaskRouting;` after `limitSwitches`. TeamRun gains `routingRevokedAt?: string;` after `routing?:`.
```

**Decisions:**

- **The `auto` pin.** When `effectiveRouting` gives shadow with `requested` auto (only a saved `mode: "auto"` does), `points` holds `start`, a lineup exists, and `periodEndedAt` is given, the pin is `{ mode: "auto", requested: "auto", source: "saved", knobs, defaults, algorithmVersion: 1, rewardVersion: 1, digest: policyDigest(effective, "auto"), periodEndedAt }`. Every other input gives step 1's result.
- **`effectiveRouting` is unchanged.** The pin and the status decide `auto` from the stored end.
- **`ROUTING_ALGORITHM_VERSION` stays 1.** The sampler and the posterior are unchanged; the guards are recorded in `basis` and `guards`, and an `auto` decision carries its own digest. *(My call: raising it would change every shadow digest and seed.)*

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `off and shadow pins are byte-equal to step 1` | For each saved policy and autonomy pair of step 1's `the effective mode follows the saved mode and the project's autonomy`, with and without `mixedLineup`: `JSON.stringify(pinRouting(saved, autonomy, lineup))` equals the same call with a fourth argument `undefined`. The autonomous default's digest equals the value main's `policyDigest` gives, pinned from main's own output before the change. `policyDigest(e)` equals `policyDigest(e, "shadow")`. |
| `an auto pin needs a saved auto mode and a period end` | Saved `{ mode: "auto" }` with `autonomous` and with `supervised`, no end: step 1's shadow pin with `requested` auto. With an end: `mode` auto, `periodEndedAt` the end, `digest` equal to `policyDigest(e, "auto")` and unequal to the shadow digest of the same knobs. With an end, these give step 1's result: no saved policy in an `autonomous` project, a saved `shadow`, `points: ["escalation"]`, no lineup. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-policy.test.ts` and `npm run typecheck`, and commit. The typecheck does not read `tests/`, so a missing import in a test shows only when the file runs.

### Task 2: the fixed rules outside the router

**Files:** `packages/host/src/team-types.ts`, `packages/host/src/routing-rules.ts` (create), `tests/routing-rules.test.ts` (create). Needs Task 1. Runs in parallel with Tasks 3, 4, 5, and 10.

**Interfaces (produces):**
```ts
// team-types.ts. These live here because team-prompts.ts may not import a routing- module.
/** Rule 1 or rule 2 of Part 5, in screen's order, or undefined when the profile passes both. */
export function fixedRuleFailure(lineup: Pick<TeamLineup, "reviewer">, knobs: Pick<RoutingKnobs, "allowContributor">, profile: TeamModelProfile): "contributor" | "reviewer-model" | undefined;
/** The run pinned `auto`, revoked or not: plan checks relax, and the fixed rules bind every implementer and scout profile. */
export function autoPinned(run: Pick<TeamRun, "routing">): boolean;
/** The router chooses: an `auto` pin the owner has not revoked. */
export function autoRouted(run: Pick<TeamRun, "routing" | "routingRevokedAt">): boolean;
/** Lineup order. In an auto-pinned run, the profiles that pass rules 1 and 2 (implementers), or rule 1 (scouts, escalations);
 *  otherwise the lineup's own array. Empty without a lineup or an escalation pool. */
export function eligibleImplementers(run: Pick<TeamRun, "routing" | "lineup">): TeamModelProfile[];
export function scoutPool(run: Pick<TeamRun, "routing" | "lineup">): TeamModelProfile[];
export function escalationPool(run: Pick<TeamRun, "routing" | "lineup">): TeamModelProfile[];
/** The attempt limit of assertBudget: (run.goal ?? run.handoff)?.maxMembers ?? 60. */
export function memberLimit(run: Pick<TeamRun, "goal" | "handoff">): number;
/** First profile within two limitFallback hops whose provider is not limited and, given `eligible`, that passes it. */
export function resolveLimitFallback(lineup: LineupShape, profileId: string, limited: Set<Provider>, eligible?: (profile: TeamModelProfile) => boolean): TeamModelProfile | undefined;
/** Moved from teams.ts unchanged, with `eligible` passed through. */
export function switchFallback(lineup: TeamLineup, profileId: string, provider: Provider, limited: Set<Provider>, eligible?: (profile: TeamModelProfile) => boolean): TeamModelProfile | undefined;

// routing-rules.ts. Imports: TeamError (team-workspace.ts), team-types.ts.
export const PROFILE_MESSAGES = {
  singleProvider: "A single-provider team cannot select profiles from a configured lineup.",          // main, verbatim
  pool: "Every task must select an agentProfileId from the team's configured implementer pool.",     // main, verbatim
  autoPool: "A task's agentProfileId must name a profile in the team's configured implementer pool.",
  scoutPool: "Every scout must select an agentProfileId from the approved scout pool.",
  noEligible: "Auto routing needs an implementer profile that passes the fixed rules: not a contributor profile unless the policy allows one, and not on the reviewer's model.",
} as const;
/** Moved from TeamService.taskProfiles. Throws TeamError 409 invalid-agent-profile. */
export function assertTaskProfiles(run: TeamRun, tasks: readonly { agentProfileId?: string }[], use: "plan" | "scouts"): void;
/** The limit fallback predicate of an implementer or a scout in an auto-pinned run; undefined for every other role and run. */
export function fallbackRule(run: TeamRun, role: TeamMember["role"]): ((profile: TeamModelProfile) => boolean) | undefined;
/** The coordinator's pick when it passes rules 1 and 2, else the default profile. Throws TeamError 409 routing-no-eligible-profile when none passes. */
export function fallbackProfile(run: TeamRun, task: Pick<TeamTask, "agentProfileId">): TeamModelProfile;
/** memberLimit(run) − run.members.length − (tasks whose status is not "integrated") − 3. May be negative. */
export function spareAttempts(run: TeamRun): number;
/** C7 component 5: run.routing.digest while autoRouted(run), else "off". */
export function routingComponent(run: Pick<TeamRun, "routing" | "routingRevokedAt">): string;
```

**Decisions:**

- **`fixedRuleFailure` is rules 1 and 2 of `screen`.** `screen` in `routing-choice.ts` stays unchanged; the agreement test ties the two.
- **Outside an auto-pinned run, every helper returns main's value.** The pools return the lineup's own arrays in order, so a prompt built from them is byte-equal to main's. `assertTaskProfiles` refuses with main's two messages in main's order, for `plan` and for `scouts` alike.
- **In an auto-pinned run**: for `plan`, an absent id passes and a present one must be in `lineup.implementers` (`autoPool`); for `scouts`, each id must be in `scoutPool(run)` (`scoutPool`). Without a lineup, both uses refuse any id, as main does.
- **`resolveLimitFallback` passes over a target that fails `eligible`**, as it passes over a limited one, and still stops after two hops. Without `eligible` it is main's function. `fallbackRule` gives `profile => fixedRuleFailure(run.lineup!, run.routing!.knobs, profile) === undefined` for an implementer or a scout of an auto-pinned run.
- **The default profile** is the first of `lineup.implementers` that passes rules 1 and 2 (Part 1). `createRun` refuses an `auto` pin without one (Task 7), so `fallbackProfile`'s throw is unreachable in a run and is tested once.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `fixed rules agree with the router's screen` | For `mixedLineup` and `limitLineup`, with `allowContributor` true and false, for each implementer: `fixedRuleFailure` equals the `removed` of `screen(lineup, knobs, new Set())`. |
| `off and shadow plan checks refuse as main does` | Runs without a lineup, and with `mixedLineup` and no pin or a shadow pin (requested shadow and auto): `assertTaskProfiles` for `plan` and for `scouts` throws `TeamError` 409 `invalid-agent-profile` with `singleProvider` or `pool`, byte for byte, on a missing id, an unknown id, and any id without a lineup; it passes on pool ids. The three pools deep-equal the lineup's arrays. |
| `auto plans may omit profiles, and scouts and escalations pass rule 1` | An auto pin over `mixedLineup` plus an escalation pool of a contributor and a strong profile: a plan without ids passes; an unknown id gives `autoPool`; a scout on `spark-high` gives `scoutPool`, and passes with `allowContributor`; `escalationPool` holds only the strong profile; with `routingRevokedAt` set, the same. |
| `auto fallbacks skip a target that fails a fixed rule; off and shadow keep main's chain` | Implementer A falls back to contributor C, and C to D, on three providers: without a predicate, `resolveLimitFallback` gives C; with `fallbackRule` of an auto implementer, D; with D on the reviewer's model, undefined. `fallbackRule` is undefined for the coordinator, the integrator, the reviewer, and every role of an off or shadow run. `switchFallback` gives the same results with its own provider counted as limited. |
| `the fallback profile is the coordinator's pick when it passes, else the default` | Auto over `mixedLineup`: pick `astra-xhigh` gives astra; pick `spark-high` gives astra; no pick gives astra; with `allowContributor`, pick `spark-high` gives spark. An all-contributor lineup throws 409 `routing-no-eligible-profile` with `noEligible`. |
| `spare attempts and the routing component` | Limit 60, 5 members, tasks pending, running, waiting, integrated, and blocked: 48. A goal with `maxMembers` 10, 9 members, one pending task: −3. `routingComponent`: no pin `off`; shadow `off`; auto the digest; auto revoked `off`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-rules.test.ts tests/usage-config.test.ts tests/routing-choice.test.ts` and `npm run typecheck`, and commit.

### Task 3: the decision store, version 2, and the projector

**Files:** `packages/host/src/routing-store.ts`, `tests/routing-store.test.ts`, `tests/routing-projector.test.ts` (create). Needs Task 1. Runs in parallel with Tasks 2, 4, 5, and 10.

**Interfaces (produces):** module `routing`, version 2, `readVersion` 1, `counts: { decisions, projects }`, still no `deleteRun`. `migrate(tx, from)` runs the version 1 statements when `from` is 0, then, when `from < 2`:
```sql
CREATE TABLE IF NOT EXISTS routing_projects (project_ref TEXT PRIMARY KEY, period_ended_at TEXT,
  explore_paused_at TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS routing_by_state ON routing_decisions (project_ref, point, state, decided_at, key, explore);
CREATE INDEX IF NOT EXISTS routing_by_identity ON routing_decisions (chosen_identity, point, state, decided_at, run_id, member_id);
```
```ts
export const PERIOD_DAYS = 14, PERIOD_DECISIONS = 50, STALE_PENDING_DAYS = 7, STALE_RELEASE_LIMIT = 100,
  APPLIED_ID_LIMIT = 2000, RUN_RELEASE_LIMIT = 200;
export function readProjectState(db: EvidenceDb, projectId: string): ProjectRoutingState;          // both null without a row
/** Undefined below 50 recorded starts. endsAt is the later of firstAt + 14 days and fiftiethAt. */
export function computedPeriodEnd(db: EvidenceDb, projectId: string): { firstAt: string; fiftiethAt: string; endsAt: string } | undefined;
/** Stores the end unless one is stored, then returns the stored value: a stored end never moves. */
export function markPeriodEnded(tx: EvidenceTx, projectId: string, endedAt: string, now: string): string;
/** A pause keeps the first pause time; null resumes. Returns the stored value. */
export function setExplorePause(tx: EvidenceTx, projectId: string, pausedAt: string | null, now: string): string | null;
/** The newest `window − 1` start rows of the project that are applied, or pending and decided within 7 days of `now`. */
export function shareWindow(db: EvidenceDb, projectId: string, window: number, now: string): { exploratory: number; of: number };
/** Releases the project's pending start rows decided more than 7 days before `now`, oldest first, at most 100. Returns the count. */
export function releaseStalePending(tx: EvidenceTx, projectId: string, now: string): number;
/** `${run_id}:${member_id}` of the identity's applied start rows decided at or after `since`, newest first, at most 2,000. */
export function appliedOutcomeIds(db: EvidenceDb, identity: string, since: string): Set<string>;
/** pending becomes applied with the member when the started profile is the chosen one, else released. No other state changes. */
export function settleStart(tx: EvidenceTx, key: string, memberId: string, profileId: string): void;
/** pending becomes released for the run's rows, those of revisions below `beforeRevision` when given, at most 200. */
export function releaseRun(tx: EvidenceTx, runId: string, beforeRevision?: number): number;
/** name "routing", module "routing", kinds ["member.started", "run.deleted", "run.revision-advanced", "run.settled"]. */
export function routingProjector(): EventProjector;
/** Registers the module, then its projector. server.ts calls it in place of `evidence.register(routingModule())`. */
export function registerRouting(store: EvidenceStore, outbox: EventOutbox): void;
```
The statements, each through the index named in the query-plan test:
```sql
-- computedPeriodEnd, at offsets 0 and 49 (routing_by_state)
SELECT decided_at FROM routing_decisions WHERE project_ref=? AND point='start' AND state='recorded'
  ORDER BY decided_at, key LIMIT 1 OFFSET ?;
-- markPeriodEnded, then a primary-key read of the stored value
INSERT INTO routing_projects (project_ref, period_ended_at, explore_paused_at, updated_at) VALUES (?, ?, NULL, ?)
  ON CONFLICT(project_ref) DO UPDATE SET period_ended_at = COALESCE(routing_projects.period_ended_at, excluded.period_ended_at),
  updated_at = excluded.updated_at;
-- setExplorePause
INSERT INTO routing_projects (project_ref, period_ended_at, explore_paused_at, updated_at) VALUES (?, NULL, ?, ?)
  ON CONFLICT(project_ref) DO UPDATE SET explore_paused_at = CASE WHEN excluded.explore_paused_at IS NULL THEN NULL
  ELSE COALESCE(routing_projects.explore_paused_at, excluded.explore_paused_at) END, updated_at = excluded.updated_at;
-- shareWindow: once with state 'applied' and bound '', once with 'pending' and now − 7 days; merged in memory by (decided_at, key) descending
SELECT decided_at, key, explore FROM routing_decisions WHERE project_ref=? AND point='start' AND state=? AND decided_at >= ?
  ORDER BY decided_at DESC, key DESC LIMIT ?;
-- releaseStalePending
UPDATE routing_decisions SET state='released' WHERE key IN (SELECT key FROM routing_decisions
  WHERE project_ref=? AND point='start' AND state='pending' AND decided_at < ? ORDER BY decided_at, key LIMIT 100);
-- appliedOutcomeIds (routing_by_identity, covering)
SELECT run_id, member_id FROM routing_decisions WHERE chosen_identity=? AND point='start' AND state='applied' AND decided_at >= ?
  ORDER BY decided_at DESC LIMIT 2000;
-- settleStart (primary key)
UPDATE routing_decisions SET state = CASE WHEN chosen_profile_id = ? THEN 'applied' ELSE 'released' END,
  member_id = CASE WHEN chosen_profile_id = ? THEN ? ELSE NULL END WHERE key=? AND state='pending';
-- releaseRun (routing_by_task); beforeRevision defaults to Number.MAX_SAFE_INTEGER
UPDATE routing_decisions SET state='released' WHERE key IN (SELECT key FROM routing_decisions
  WHERE run_id=? AND state='pending' AND revision < ? LIMIT 200);
```

**Decisions:**

- **`readVersion` stays 1**: every version 1 column keeps its meaning. A host before this slice reads the module as unavailable, by the store's rule for a newer stored version.
- **The period counts `recorded` start rows only.** `auto` rows never count toward it. Rows recorded before the owner saved `auto` count. Retention can delay an end that was never stored; it cannot move a stored one.
- **The share window is two seeks, one per state**, because one seek over `state IN (...)` sorts in a temporary B-tree. An `applied` row counts at any age; a `pending` row counts for 7 days, and the next decision of its project releases it.
- **The projector.** `member.started` with `data.role` `implementer`, no `data.replaces`, a `taskId`, and a string `data.profileId`: `settleStart(tx, decisionKey(event.runId, event.revision, tx.index("task", event.taskId), "start", 1), event.memberId, data.profileId)`. A start with `unavailable: true` settles the same way: the member exists on that profile, and its outcome row records what follows. `run.revision-advanced`: `releaseRun(tx, event.runId, event.revision)`. `run.settled` and `run.deleted`: `releaseRun(tx, event.runId)`. `run.blocked` is not read: a blocked run may resume and reuse its rows. Every update requires `state = 'pending'`, so a repeated or late event changes nothing, and a `recorded` row never changes.
- **A new projector replays the stored events** from the outbox's first stored event, in pages, the outbox's own rule. Events from before this slice find no `pending` row.
- **`shadowProgress` counts `recorded` rows only**, through `routing_by_state`. Step 1's `shadow progress counts start rows up to 50 and names the first time` gains a `pending` row that is not counted. Step 1's `the module is version 1 with no run hooks` now expects version 2, and `decision reads seek their indexes` expects `routing_by_state` for `shadowProgress`.
- `routing_projects` rows are never swept: one row per project, holding a blind index and three times.

- [ ] **Step 1: Write the failing tests.** Stores are built as in step 1's `tests/routing-store.test.ts`; the projector tests add `new EventOutbox(store)` before the modules, as `server.ts` does.

| Test name | Assertions |
|---|---|
| `a version 1 store migrates to version 2 and keeps every row` (routing-store) | A store first opened with the version 1 statements copied into the test, holding three decisions: after `routingModule()`, version 2 and ready; `routing_projects`, `routing_by_state`, and `routing_by_identity` exist in `sqlite_master`; every column of every row is equal before and after. |
| `the period end is the later of 14 days and the 50th recorded start, stored once` (routing-store) | 49 recorded start rows: undefined. A 50th, two days after the first: `endsAt` is the first plus 14 days. A project whose 50th row is 20 days after its first: `endsAt` is the 50th row's time. Pending, applied, and released rows, escalation-point rows, and another project's rows do not count. `markPeriodEnded` with X, then Y, stores and returns X. After a sweep removes the first 10 rows, `readProjectState` still gives X. |
| `the pause is kept per project, and a second pause keeps the first time` (routing-store) | Pause at A, then at B: A. Resume: null. An unknown project: both fields null. A stored period end survives a pause and a resume. |
| `the share window counts the newest pending and applied starts, and stale pending rows are released` (routing-store) | With window 10 over a project holding pending, applied, released, and recorded start rows, rows of the escalation point, rows of another project, and pending rows 8 days old: `of` counts only fresh pending and applied start rows, at most 9, the newest by `(decided_at, key)`, and `exploratory` the explore flags among them. `releaseStalePending` with 101 stale rows releases 100, the oldest first. |
| `applied outcome ids are one identity's applied starts, newest first, at most 2,000` (routing-store) | 2,001 applied rows of identity X: the 2,000 newest, as `${runId}:${memberId}`. Pending and released rows, another identity, the escalation point, and rows before `since` are left out. |
| `version 2 reads seek their indexes` (routing-store) | `EXPLAIN QUERY PLAN` of both period statements, both window statements, the inner select of `releaseStalePending`, `appliedOutcomeIds`, the `routing_projects` read, `settleStart`, the inner select of `releaseRun`, and `shadowProgress`: each a `SEARCH` through `routing_by_state`, `routing_by_identity`, `routing_by_task`, or a primary key, with no `SCAN routing_decisions` and no `USE TEMP B-TREE`. |
| `the projector applies or releases each pending row once` (routing-projector) | Pending rows of run R for tasks a to d at revision 1 and e at revision 2. `member.started` of a's implementer on its chosen profile: applied, with the member id. Of b's on another profile: released, member NULL. Of c's with `replaces`, of a scout, and of a reviewer: c stays pending. A second start of a: stays applied with the first member. A `recorded` row never changes. `run.revision-advanced` to 2: c and d released, e pending. `run.settled`: e released. `run.deleted` of another run touches only that run's rows. |
| `projecting again, in each order of three events or after a restart, changes nothing` (routing-projector) | For each of the six orders of [start of a on its chosen profile, start of b on another profile, `run.settled`], with rows a and b pending: projecting the sequence through `routingProjector().project`, then projecting it again, gives the rows of one projection; a is applied when its start precedes the settle, else released; b is released. Restart: events stored through the outbox before `registerRouting` are projected by the first `advance()` after it; closing the store, reopening it with a new outbox, and advancing again changes no row. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-store.test.ts tests/routing-projector.test.ts tests/routing-reads.test.ts` and `npm run typecheck`, and commit.

### Task 4: the exploration guards and the who-chose weight

**Files:** `packages/host/src/routing-guards.ts` (create), `packages/host/src/routing-posterior.ts`, `tests/routing-guards.test.ts` (create), `tests/routing-posterior.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 3, 5, and 10.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
// routing-guards.ts
export const SHARE_EPSILON = 1e-9;
/** One more exploratory start keeps the window's share, itself included, within the limit: E + 1 ≤ s·(N + 1) + ε. */
export function shareAllows(share: { exploratory: number; of: number }, maxExploreShare: number): boolean;
/** Step 2's guards on an exploratory choice, in this order: paused, budget, share. A choice that does not explore is returned unchanged. */
export function guardExploration(choice: Choice, guards: ExploreGuards, knobs: Pick<RoutingKnobs, "minSpareAttempts" | "maxExploreShare">): Choice;

// routing-posterior.ts: one optional parameter; observe is unchanged.
export function posterior(rows: readonly RoutingEvidenceRow[], target: RoutingTarget, current: CurrentConfig, now: string,
  chosenWeight?: number, routerChosen?: ReadonlySet<string>): ProfilePosterior;
```

**Decisions:**

- **A guarded choice** is `{ ...choice, chosen: choice.greedy, explore: false, basis }` with `greedy-paused` when `pausedAt` is set, else `greedy-budget` when `spareAttempts < minSpareAttempts`, else `greedy-share` when `shareAllows` is false. `candidates` keep their samples, so explain shows what the sample was. Elevated risk is already greedy in `choose` (`greedy-risk`).
- **The share is strict from the first decision.** With `maxExploreShare` 0.2, a project explores for the first time after four non-exploratory `auto` starts are counted. *(My call: Part 5's "would exceed" read over the decisions that exist; a window that is not yet full is no reason to exceed the share.)*
- **The who-chose weight.** A row whose `outcomeId` is in `routerChosen` has weight 1; every other row keeps `chosenWeight`. With the default empty set, the result equals step 1's, bit for bit. Only the applied member's own row counts in full; a replacement's row keeps the half weight.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `paused, low budget, and elevated risk never explore over 1,000 seeds` (routing-guards) | Two candidates with equal posteriors and costs, so `choose` explores near half of 1,000 seeds: with `pausedAt` set, no result explores, and each one `choose` marked exploratory has basis `greedy-paused` and `chosen` equal to `greedy`; with `spareAttempts` 3 and `minSpareAttempts` 4, `greedy-budget`; with 4, at least one explores; elevated risk never explores (acceptance 6). With all three guards true, the basis is `greedy-paused`. |
| `the share holds at every exploratory start for any interleaving, and a released row frees its place` (routing-guards) | `shareAllows`: 0.2 with N 4 and E 0 is true; N 3 and E 0 false; N 49 and E 9 true; N 49 and E 10 false; share 0 always false. Seeded property test: 1,000 seeds, each 300 steps of decide (a seeded exploratory sample), apply, or release over a window of 20 at 0.2; at every exploratory decision, the newest `min(20, count)` pending or applied rows, itself included, hold at most 0.2 of explorations, within 1e-9. Example: 12 counted rows whose newest 9 hold two explorations: false; release one of them: true. Nine pending rows refuse as nine applied rows do. |
| `an applied row counts at full weight` (routing-posterior) | One fresh first-pass row with `held` 1: with its outcome id in `routerChosen`, the tenant posterior is `Beta(2, 1)`; without, `Beta(1.5, 1)`. Step 1's `the posterior does not depend on row order` passes with a `routerChosen` of half the rows. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-guards.test.ts tests/routing-posterior.test.ts tests/routing-choice.test.ts` and `npm run typecheck`, and commit.

### Task 5: the configuration identity carries the policy digest

**Files:** `packages/host/src/config-identity.ts`, `packages/host/src/configuration-store.ts`, `packages/host/src/outcome-projector.ts`, `tests/routing-identity.test.ts` (create). Needs Task 1. Runs in parallel with Tasks 2, 3, 4, and 10. Three small edits under one rule; `outcome-projector.ts` stays under 1,000 lines.

**Interfaces (produces):**
```ts
// config-identity.ts
// ConfigComponents.routing widens from "off" to string: "off" or a 64-hex policy digest (C7 component 5).
export function isRoutingComponent(value: unknown): value is string;          // "off" or /^[0-9a-f]{64}$/
// memberConfiguration's input gains `routing?: string`; absent gives "off", so every existing caller keeps its ids.
// configuration-store.ts, parseConfigured (line 168): `knowledge !== "none" || !isRoutingComponent(routing)` refuses.
// outcome-projector.ts, configIdOf (lines 846 and 852): `!isRoutingComponent(data.routing)` refuses; the components carry `data.routing`.
```

**Decisions:**

- **`configId` is unchanged**: it hashes the components, so a configuration with `off` keeps main's id, and a digest gives a new id.
- **The value is a policy digest**, an opaque hash of owner settings, so the plain `configurations.routing` column may hold it.
- Task 9 passes `routing: routingComponent(stored.run)` at the capture (`teams.ts:5215`).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `a routing component is off or a policy digest, and off keeps main's ids` | `isRoutingComponent`: `off` and a 64-hex string pass; `auto`, 63 hex digits, upper-case hex, and a number fail. `configId` of the components of step 1's `a configId covers all six components` equals that test's value; the same components with a digest give another id. `memberConfiguration` with `routing` set to a digest records it and the matching id. |
| `a routed member's configuration is stored and its outcome row keeps the id` | A `member.configured` event whose routing is a digest: the configurations module stores it, and refuses one whose routing is `auto`. Through the outcome projector, the member's outcome row has that `configId`, and its joined `prompt_version` is not null. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-identity.test.ts tests/config-identity.test.ts tests/configuration-store.test.ts tests/outcome-projector.test.ts` and `npm run typecheck`, and commit.

### Task 6: the prompts and the contexts

**Files:** `packages/host/src/team-prompts.ts`, `tests/team-prompts.test.ts`. Needs Task 2. Runs in parallel with Tasks 3, 4, 5, 7, 8, and 10.

**Interfaces (produces):** no new export. The changes in `teamPrompt` and `teamContext`:

- **Pool paragraph** (line 403). `autoRouted(run)`: exactly `The host assigns each plan task's worker profile; omit agentProfileId from plan tasks. Coordinator, integrator, and reviewer profiles are fixed. Do not invent profile IDs, model names, effort settings, or executable arguments.` (the last two sentences are main's). Otherwise today's paragraph over `eligibleImplementers(run)`. The first sentence speaks of plan tasks only, because the explore text below still asks for each scout's profile.
- **Plan example** (`taskProfileExample`, line 309). `autoRouted(run)`: empty. Otherwise `eligibleImplementers(run)[0].id`.
- **Explore example** (line 406). The example id comes from `scoutPool(run)`, light first, as today. `autoPinned(run)`: "Use the worker pool above." becomes `Choose each scout's agentProfileId from this approved scout pool: ${JSON.stringify(scoutPool(run))}.`
- **Implementer escalation paragraph** (line 412). Its condition and its JSON use `escalationPool(run)`.
- **Inline implementer task** (lines 306 to 308). `routing` joins the removed fields.
- **`teamContext`**, for every role: `routing` is removed from each task of `tasks`, of each continuation's `tasks`, and of `discovery.tasks`. Key order is kept, so a task without `routing` serialises as today.

**Decisions:**

- **Off and shadow are byte-equal by construction**: outside an auto-pinned run the helpers return the lineup's arrays, and the two sentences are the only conditional text.
- **A revoked run** shows today's paragraph over the pool that passes rules 1 and 2, because its fallback starts only those. Its explore text names the rule-1 scout pool, because a scout's profile must pass rule 1.
- **No text names routing.** The `auto` text names no policy, key, or number, and the coordinator still sees the lineup in its context's `authority.lineup`, as today.
- A scout has no `routing` field in this slice; its inline task is unchanged. Step 4 adds the removal with the scout point.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `off and shadow prompts and contexts are byte-equal to main` | Before the change, the worker records main's `promptVersion` for every role with the fixtures' providers, and the tests pin those values; after the change they are equal. For every role, `teamPrompt` and `teamContext` of a `mixedLineup` run with a shadow pin (requested shadow, and requested auto) equal those of the same run without `routing`, byte for byte. |
| `an auto coordinator is told the host assigns profiles` | An auto pin over `mixedLineup`: the coordinator prompt contains `The host assigns each plan task's worker profile; omit agentProfileId from plan tasks.` once, contains neither `Every task MUST include agentProfileId` nor `"agentProfileId"` in the plan example, and names only `astra-xhigh` in the scout pool sentence. Its first 4,000 characters contain no `"routing":`, no knob name, and not the pin's digest. |
| `a revoked run and an auto implementer see only the profiles that pass` | The same run with `routingRevokedAt`: today's pool sentence followed by the JSON of `[astra-xhigh]` only. An auto implementer with an escalation pool of a contributor and a strong profile sees the strong one only; with only the contributor, no escalation paragraph; in an off run, both. |
| `a member context never carries a task's routing, in any role or snapshot` | `task.routing` set on run tasks, on continuation tasks, and on discovery tasks, and `routingRevokedAt` set: `teamContext` for every role contains no `"routing":` and no `routingRevokedAt`; the inline implementer task contains no `"routing":`. Step 1's `a member context never carries the feature map, the eval block, or routing` passes unchanged. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-prompts.test.ts tests/outcome-rules.test.ts tests/config-identity.test.ts` and `npm run typecheck`, and commit.

### Task 7: the `auto` decision

**Files:** `packages/host/src/routing-auto.ts` (create), `packages/host/src/routing-recorder.ts`, `packages/host/src/run-events.ts`, `tests/routing-auto.test.ts` (create), `tests/routing-recorder.test.ts`. Needs Tasks 2, 3, and 4.

**Interfaces (produces):**
```ts
// run-events.ts: moved from teams.ts unchanged (lines 229 to 232 there). Task 9 removes the old copy.
export function appendRunEvent(run: TeamRun, text: string): void;   // pushes { at, text }; keeps the newest 300

// routing-auto.ts
export type AutoFailure = "unavailable" | "budget" | "tooLarge" | "write" | "failed";
export type AutoDecision = { profile: TeamModelProfile; by: "router" } | { profile: TeamModelProfile; by: "fallback"; reason: AutoFailure };
export const AUTO_LOG: Record<AutoFailure | "pin", string>;
/** One auto start decision: one store.read, at most one store.tryWrite. Never throws. */
export function decideAutoStart(store: EvidenceStore, input: RouterStart, now: () => string, clock: () => number): AutoDecision;
/** The stored end of the project's shadow period, storing it first when the computed end has passed. Undefined while the period runs.
 *  Throws when the store cannot answer. */
export function periodEnd(store: EvidenceStore, projectId: string, now: string): string | undefined;

// routing-recorder.ts: two methods. recordStart is unchanged for shadow pins and returns at once for auto pins.
export class RoutingRecorder {
  /** Step 1's pinRouting, reading the period end only for a saved `auto`. Throws TeamError 409 routing-no-eligible-profile
   *  for an auto pin without a candidate that passes rules 1 and 2. Any store failure gives the shadow pin and one log line. */
  pin(saved: TeamRouting | undefined, autonomy: AutonomyMode, lineup: TeamLineup | undefined, projectId: string): TeamRunRouting | undefined;
  /** Undefined unless the run is auto-pinned. Sets task.routing and returns the profile to start. */
  applyStart(input: RouterStart): TeamModelProfile | undefined;
}
```
The fixed texts:
```ts
AUTO_LOG = {
  unavailable: "Routing auto decision fell back: the evidence store is unavailable.",
  budget: "Routing auto decision fell back: it took longer than 250 ms.",
  tooLarge: "Routing auto decision fell back: its details are over the size limit.",
  write: "Routing auto decision fell back: the decision could not be stored.",
  failed: "Routing auto decision failed; the task starts on its fallback profile.",
  pin: "Routing auto pin fell back to shadow: the evidence store is unavailable.",
};
// The run line of a fallback: `Host routing could not choose a profile for task ${task.id}; it is assigned ${profile.label}.`
```

**Decisions:**

- **`pin` steps.** (1) `effectiveRouting(saved, autonomy)`. Unless it is shadow with `requested` auto, `start` is listed, and a lineup exists, return `pinRouting(saved, autonomy, lineup)` without touching the store. (2) `periodEnd(store, projectId, now)`; a throw logs `pin` once and gives the shadow pin. (3) Undefined: the shadow pin. (4) Otherwise `pinRouting(saved, autonomy, lineup, end)`, then refuse with `TeamError(409, "routing-no-eligible-profile", PROFILE_MESSAGES.noEligible)` unless `screen(lineup, pin.knobs, new Set())` keeps a candidate with no removal.
- **`periodEnd` steps.** The `routing` module must be ready, else it throws. One `store.read`: a stored `periodEndedAt` is returned; else `computedPeriodEnd`. A computed end after `now`, or none, gives undefined. Otherwise one `store.tryWrite` of `markPeriodEnded`, whose stored value is returned; a failed write throws.
- **`applyStart` steps.** (1) Not `autoPinned(run)`, or no lineup: undefined, nothing read. (2) `routingRevokedAt` set: `fallbackProfile(run, task)`, `task.routing = { profileId, by: "fallback" }`, no run line (the revoke wrote one). (3) `task.routing` names a lineup implementer that passes rules 1 and 2: that profile, nothing read. (4) `decideAutoStart`; set `task.routing` from its result; on a fallback, one `appendRunEvent` line and the reason's log line once per recorder. `applyStart` changes no other field of the task, the member, or the run. It throws only `fallbackProfile`'s TeamError, which `createRun`'s coverage check makes unreachable.
- **`decideAutoStart` steps.** (1) `outcomes`, `configurations`, and `routing` ready, else `unavailable`. (2) Features, `screen`, and prompt versions exactly as `record` computes them, before the clock starts. (3) One `store.read`: the task key and the decision key; a found row returns its chosen profile with `by: "router"`, whatever its state, so the same key gives the same choice (acceptance 5). Otherwise per identity `epochAt`, `selectRoutingEvidence`, and `appliedOutcomeIds(db, identity, since)` into `posterior(rows, target, current, now, CHOSEN_WEIGHT, applied)`; `readProjectState`, `shareWindow(db, projectId, knobs.exploreWindow, now)`, and `spareAttempts(run)`; then `choose` and `guardExploration`. `choose` giving undefined is `failed`. (4) More than 250 ms: `budget`. (5) A payload over 32 KiB: `tooLarge`. (6) One `store.tryWrite`: `releaseStalePending`, then `insertDecision`; when the insert finds the key taken, the stored row's profile is used. A false `tryWrite` is `write`. Any throw is `failed`. A fallback's profile is `fallbackProfile(run, task)`.
- **The row.** Step 1's row with `mode` auto, `state` pending, `member_id` NULL, `policy_digest` the auto digest, the guarded `basis`, `chosen`, and `explore`, and `coordinator_profile_id` the plan's id or NULL. The payload adds `guards`. No log line holds an id or a value.
- **The shadow recorder** passes `appliedOutcomeIds` into `posterior` the same way, and `record` returns at once when `run.routing.mode` is `auto`.

- [ ] **Step 1: Write the failing tests.** Stores and runs are built as in step 1's `tests/routing-recorder.test.ts`, with the run pinned by `pinRouting({ mode: "auto" }, "supervised", mixedLineup, PAST)` and tasks a (`agentProfileId` `spark-high`) and b (none).

| Test name | Assertions |
|---|---|
| `an auto start writes one pending row and returns its choice` (routing-auto) | With `allowContributor`: `applyStart` returns the profile named by the row's `chosen_profile_id`; the row has `mode` auto, `state` pending, `member_id` NULL, `coordinator_profile_id` `spark-high` for a and NULL for b, and `policy_digest` the pin's digest; `task.routing` is `{ profileId, by: "router" }`. The first decision of the project never explores, because its window is empty, and its `payload.guards.share` is 0 of 0. For an off run and a shadow run, `applyStart` returns undefined without calling `store.read` (a counting wrapper). |
| `a second start reuses the pending row and the task's routing` (routing-auto) | `applyStart` for a, then 30 outcome rows for its candidates, then `task.routing` deleted (a lost save), then `applyStart` again: the same profile and one row. With `task.routing` kept, the second call reads nothing. |
| `every failure starts the fallback profile with one run line` (routing-auto) | An unavailable store (a file in place of the database), a clock that returns 0 then 251, a payload over the limit (built as step 1's `a payload over its limit logs its own line once and writes no row`), a store whose `tryWrite` returns false, and a store whose `read` throws: a gets `astra-xhigh` (its pick fails rule 1), and with `allowContributor` gets `spark-high`; b gets `astra-xhigh`; `task.routing.by` is `fallback`; `run.events` gains exactly `Host routing could not choose a profile for task a; it is assigned Astra implementer.` per task; no row; each reason's line once per recorder (acceptance 15). |
| `the guards make exploratory picks greedy in a real store, and the payload records them` (routing-auto) | Ten applied non-exploratory rows in the window and `allowContributor`; 50 runs of distinct ids decide task a. Unpaused: some rows explore with basis `sampled`, and recounting the window at each one satisfies `shareAllows`. Paused: no row explores, and every row whose sampled pick differed from greedy has basis `greedy-paused`. Every payload's `guards` holds the pause time and `spareAttempts` of the run. |
| `the pin is auto only after the stored period end, and refuses without coverage` (routing-auto) | Saved `auto` with 49 recorded rows: the shadow pin, deep-equal to `pinRouting(saved, autonomy, lineup)`, and no `routing_projects` row. With 50 rows, the first 15 days ago: the auto pin with `periodEndedAt` the first plus 14 days, stored; after the first 20 rows are deleted, a second pin gives the same end. An all-contributor lineup with a stored end: TeamError 409 `routing-no-eligible-profile`. An unavailable `routing` module: the shadow pin and the `pin` line once. A saved shadow or no policy: no `store.read`. |
| `a shadow decision counts an applied row in full, and an auto pin records no shadow row` (routing-recorder) | An applied auto row whose member's outcome row is first-pass with `held` 1: a shadow `recordStart`'s payload gives that identity's tenant level success 1, not 0.5. `recordStart` with an auto pin writes nothing and reads nothing. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-auto.test.ts tests/routing-recorder.test.ts tests/routing-store.test.ts` and `npm run typecheck`, and commit.

### Task 8: status, and the pause, resume, and revoke routes

**Files:** `packages/host/src/routing-reads.ts`, `packages/host/src/routing-routes.ts`, `tests/routing-reads.test.ts`, `tests/routing-routes.test.ts`, `tests/remote-access.test.ts`. Needs Tasks 3 and 4. Runs in parallel with Tasks 6 and 7.

**Interfaces (produces):**
```ts
// routing-routes.ts
export type RoutingRouteDeps = { evidence: EvidenceStore; config: () => Config;
  teams: { revokeRouting(id: string, input: unknown): Promise<unknown> } };   // structural: TeamService gains it in Task 9
export function routingRoutes(app: express.Express, deps: RoutingRouteDeps, guard: express.RequestHandler, ownerGuard: express.RequestHandler): void;
// POST /api/routing/projects/:id/explore/pause   (ownerGuard) → 200 { projectId, explorePausedAt }
// POST /api/routing/projects/:id/explore/resume  (ownerGuard) → 200 { projectId, explorePausedAt: null }
// POST /api/teams/:id/routing/revoke             (ownerGuard) → 200 the team view; body teamActionSchema
```

**Decisions:**

- **Status.** `mode` is off when `effectiveRouting` is off; `auto` when a new run would pin `auto`: the saved mode is `auto`, `start` is among the points, a lineup exists, and `period.endedAt` is set; shadow otherwise. `covers` keeps step 1's meaning, so an `auto` status with `covers.reason` `no-eligible-profile` says that `createRun` refuses. `period`: `shadowProgress`, `endsAt` from `computedPeriodEnd`, and `endedAt` the stored end (`stored` true) or, unstored, `endsAt` when it is at or before `now` (`stored` false; the next run stores it). `shadow` counts `recorded` rows only. `explore` counts recorded rows in shadow (`guards` `risk-only`) and pending and applied rows in `auto` (`guards` `applied`); `pausedAt` comes from the project state in both modes. `share`, in `auto` only: `shareWindow` with the pinned knobs' window and limit. `auto`, in `auto` only: the pending, applied, and released counts among the 30-day rows (newest 500). Each profile's posterior passes `appliedOutcomeIds`.
- **Routes.** An unknown project answers 404 `unknown-project`. A `routing` module that is not ready, or an `unavailable` error, answers 503 `evidence-unavailable`. A run id that is not a UUID answers 400 `invalid-routing-request`. The revoke answers what `revokeRouting` throws through the host's error handler: 409 `routing-not-enabled` without an auto pin, 409 `stale-team-revision`, 404 for an unknown run.
- **The pause is outside the configuration**, so it never touches the routine approval digest (acceptance 16). It acts on `auto` starts only; a shadow row records what the sampler would do, as in step 1.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `status reports auto, the period end, and the pause` (routing-reads) | Saved `auto`, no rows: `mode` shadow, `requested` auto, `endsAt` and `endedAt` null, `share` and `auto` null. 50 recorded rows, the first 15 days ago: `mode` auto, `endedAt` the first plus 14 days, `stored` false; after `markPeriodEnded`, `stored` true. A pause: `explore.pausedAt` set in both modes. |
| `auto status counts each state and the share, and weighs applied rows in full` (routing-reads) | In the last 30 days, two pending, three applied, one released, and four recorded rows: `auto` 2, 3, 1; `shadow.decisions` 4; `share.of` 5, `window` 50, `limit` 0.2. A profile whose one row is an applied first-pass row has a higher `mean` than in the same status without the applied decision. |
| `pause, resume, and revoke answer the owner only` (routing-routes, host) | Owner: pause 200 with `explorePausedAt` set, resume 200 with null. Controller and viewer: 403 on all three. Unknown project: 404 `unknown-project`. Evidence directory replaced by a file: 503 `evidence-unavailable`. Revoke of a run without an auto pin: 409 `routing-not-enabled`. `/me` holds `teams.routingAuto` 1. |
| `a pause leaves the saved configuration unchanged` (routing-routes, host) | The host's configuration file is byte-equal before the pause, after it, and after the resume (acceptance 16). |
| `the relay refuses routing writes` (remote-access) | `["POST", "/routing/projects/<id>/explore/pause"]`, `["POST", "/routing/projects/<id>/explore/resume"]`, and `["POST", "/teams/<uuid>/routing/revoke"]` answer 403 `remote-endpoint-denied`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routing-reads.test.ts`, then `tests/routing-routes.test.ts` and `tests/remote-access.test.ts` on the host after Task 9 commits the `server.ts` line (the in-process tests run before), then `npm run typecheck`, and commit.

### Task 9: the wiring

**Files:** `packages/host/src/teams.ts`, `packages/host/src/server.ts`, `tests/routing-auto-run.test.ts` (create), `tests/routing-run.test.ts` (its router harness only), `tests/usage-config.test.ts`, `tests/fixtures/team-agent.mjs`. Needs Tasks 5, 6, 7, and 8.

**Interfaces (produces):**
```ts
// teams.ts, by main's line numbers. Net −10 lines: 5,757 to 5,747 on main `3a0eacb`.
// 16: the team-types import gains `autoPinned, escalationPool, memberLimit, switchFallback`.
// 34: import { assertTaskProfiles, fallbackProfile, fallbackRule, routingComponent } from "./routing-rules.js";   (replaces the pinRouting import)
// 36: the run-events import gains `appendRunEvent as runEvent`.
// 229–232: the local `runEvent` is removed (−4).
// 465–472: `switchFallback`, its comment, and the blank line after it are removed (−8).
// 1644:
      const routing = this.router?.pin(project.team.routing, run.autonomy, lineup, run.projectId);
// 2602:
    const limit = memberLimit(run);
// After 2073, the end of revokePermissions (+11):
  revokeRouting(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (run.routing?.mode !== "auto") throw new TeamError(409, "routing-not-enabled", "This team does not choose worker profiles automatically.");
      if (this.replay(stored, "revoke-routing", body) || !this.mutation(stored, "revoke-routing", body)) return this.view(stored);
      run.routingRevokedAt ??= timestamp();
      this.event(stored, "Host profile routing was revoked by the owner; new tasks start on the coordinator's profiles.");
      this.save(stored); return this.view(stored);
    });
  }
// 4824–4832: `taskProfiles` is removed (−9).
// 4847–4848:
    assertTaskProfiles(run, [task], role === "scout" ? "scouts" : "plan");
    return run.lineup.implementers.find(profile => profile.id === task.agentProfileId) ?? fallbackProfile(run, task);
// 4859: resolveLimitFallback(run.lineup, selected!.id, this.limits.limited(), fallbackRule(run, role))
// 4990: switchFallback(run.lineup, from.id, provider, this.limits.limited(), fallbackRule(run, member.role))
// 5030–5034, five lines for five:
    const run = stored.run, start = role === "implementer" && task && run.routing && this.router ? { run, task: task as TeamTask,
      publishHeads: this.publishHeadsEnabled(), entryTools: entryToolsFor(run, "implementer"), objectiveDigest: Boolean(run.goal?.record),
      limited: this.limits.limited(), featureMap: (run.handoff?.project ?? this.config.projects.find(project => project.id === run.projectId)?.team)?.features } : undefined;
    const member = this.newMember(run, role, "", run.headCommit!, task?.id, undefined, start && autoPinned(run) ? this.router!.applyStart(start) : undefined);
    if (start) this.router!.recordStart(start);
// 5215: `captured` gains `routing: routingComponent(stored.run)` on the same line.
// 5277: assertTaskProfiles(run, report.tasks, "scouts");
// 5305: const profile = escalationPool(run).find(item => item.id === report.agentProfileId);
// 5322: assertTaskProfiles(run, report.tasks, "plan");

// server.ts, net 0 lines.
// 45:   import { registerRouting, sweepExpiredDecisions } from "./routing-store.js";
// 260:  registerRouting(evidence, outbox);
// 834:  the /me teams flags gain `routingAuto: 1` after `routing: 1`.
// 1100: routingRoutes(app, { evidence, config: () => config, teams }, requireRole(["owner", "controller", "viewer"]), requireRole(["owner"]));
```
`tests/usage-config.test.ts` imports `switchFallback` from `team-types.js`. `tests/fixtures/team-agent.mjs` gains one line after the scenario's profile assignments: `if (existsSync(join(receiptDir, "plan-no-profiles"))) for (const task of tasks) delete task.agentProfileId;`.

**Decisions:**

- **Shadow keeps step 1's order.** `recordStart` still runs after `newMember`, so a refused start writes no shadow row. `applyStart` runs before it. An `auto` start that `newMember` then refuses leaves its row `pending` until the run settles, advances, or is deleted, or for 7 days.
- **Off and shadow pass no profile.** `applyStart` runs only for an auto-pinned run, so for them `newMember(run, role, "", run.headCommit!, task?.id, undefined, undefined)` runs exactly as main's call, and the recorder sees only `recordStart`.
- **The step-1 run tests keep every assertion.** Their harness (`mixedRun` in `tests/routing-run.test.ts`) passes `useRouter` an object that has only `recordStart`, and `createRun` now calls `pin`. Task 9 changes the harness alone: it wraps the real recorder's `recordStart` in place and passes the recorder itself (net +1 line, 254 to 255).
- **The member's profile check survives a missing router.** An auto-pinned run whose host has no recorder reaches `memberProfile`; a task without a pick then starts on `fallbackProfile`, never on the run's provider.
- **Disclosed in the view.** `task.routing` and `run.routingRevokedAt` reach clients and relay devices with the run. The web, phone, and Mac clients show a started task's member profile, and "Model assignment pending" before it starts, so a plan without `agentProfileId` needs no client change.
- No `launch()` change, no new run status, no new event kind.

- [ ] **Step 1: Write the failing tests.** The run tests use `fixture("mixed", mixedLineup, {}, { noServer: true })`, set the project's `team.routing` to `{ mode: "auto" }`, and build a store with `new EventOutbox(store)`, `configurationModule()`, `outcomeModule()`, and `registerRouting(store, outbox)`. They store the period end with `markPeriodEnded` before `create`, pass `events: outbox` to `f.openTeamService`, and attach `new RoutingRecorder({ store })`. They copy `membersClosed` and `settleAnswering` from `tests/routing-run.test.ts` without editing that file, wait for each member's process to close before teardown (EPERM on macOS), and call `outbox.advance()` until nothing is pending before reading rows.

| Test name | Assertions |
|---|---|
| `an auto run accepts a plan without profiles and starts the router's choice` (routing-auto-run) | With `plan-no-profiles` written to `f.receipts`: every plan is accepted. For each task, one row per revision (step 1's `rowsPerRevision`; the mixed flow plans at revisions 2 and 3), each with `mode` auto, `state` applied, and `member_id` the first implementer of that task and revision. Every implementer's `modelProfile.id` is `astra-xhigh`. `task.routing` is `{ profileId: "astra-xhigh", by: "router" }` in the stored run and in `teams.get`. Every project-manager prompt contains `The host assigns each plan task's worker profile; omit agentProfileId from plan tasks.` and not `Every task MUST include agentProfileId`. No member prompt contains `"routing":`, a row's key, its policy digest, or its seed, and `teamContext` of the stored run contains no `"routing":` for any role. |
| `with the store closed an auto run starts fallback profiles and continues` (routing-auto-run) | `store.close()` right after `create` returns (the plan arrives later, from the coordinator's own process): every first implementer runs `astra-xhigh`, `task.routing.by` is `fallback`, `run.events` holds `Host routing could not choose a profile for task a; it is assigned Astra implementer.` once per task and revision, and the run reaches the shadow run's terminal status (acceptance 15). |
| `revoking routing returns new tasks to the coordinator's profiles` (routing-auto-run) | Revoked right after `create`, with the mixed plan's picks: task a (pick `spark-high`, fails rule 1) and task b (pick `astra-xhigh`) both run `astra-xhigh`; no `routing_decisions` row exists; the run's events hold the revoke line; the revision-2 coordinator's prompt holds today's pool sentence followed by the JSON of `[astra-xhigh]` only. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/usage-config.test.ts tests/team-prompts.test.ts`, then on the host, in the background: `tests/routing-auto-run.test.ts`, `tests/routing-run.test.ts` (the five step-1 tests, assertions unchanged), `tests/routing-routes.test.ts`, `tests/remote-access.test.ts`, and `tests/teams.test.ts`, reporting none failed and none cancelled. Then `npm run typecheck`, and commit.

### Task 10: the routing command

**Files:** `packages/host/src/routing-cli.ts`, `tests/client-args.test.ts`. Needs Task 1. Runs in parallel with Tasks 2 to 5.

**Interfaces (produces):**
```ts
// routing-cli.ts
/** Moved from team-cli.ts. `--routing` now takes off, shadow, or auto; the other two options are unchanged. Undefined when none is given. */
export function requestedRouting(options: Options): Record<string, unknown> | undefined;
export const ROUTING_AUTO_NOTE = "Auto routing applies to runs created after the project's shadow period ends: 14 days and 50 recorded start decisions, whichever is later. infinite routing status PROJECT shows the progress.";
// handleRoutingClientCommand gains: infinite routing pause-explore PROJECT [--json] | resume-explore PROJECT [--json]
```

**Decisions:**

- **`requestedRouting`.** `--routing` outside off, shadow, and auto exits with `--routing must be off, shadow, or auto.` Every other message is step 1's.
- **Pause and resume.** Each needs `me.teams?.routingAuto === 1`, else `This host does not support exploration pauses. Upgrade the host first.` before any request. Each posts `{}` to `/routing/projects/PROJECT/explore/pause` or `/resume`, then prints `Exploration paused for PROJECT since TIME.` or `Exploration resumed for PROJECT.`; `--json` prints the answer. A missing project prints the usage. Errors map as step 1's `read` maps them.
- **Status lines**, the changes to step 1's order. (1) `ID · routing auto (saved)`; in shadow with `requested` auto, `ID · routing shadow (saved) · requested auto: auto starts after the shadow period`. (5) With `period.endedAt`: `Shadow period: ended DATE.`, plus ` Auto routing needs --routing auto.` when `requested` is not auto; otherwise step 1's line. (6) In shadow, step 1's line; in `auto`, `Explored: X of Y auto start decisions in the last 30 days.` (6b) `Exploration share: E of the last N pending or applied starts; the limit is S of W.`, or `Exploration share: no auto start decision yet.` when N is 0. (6c) `Exploration paused since DATE.` when paused. (6d) In `auto`, `Auto starts, last 30 days: P pending, A applied, R released.`, plus ` (newest 500)` when capped. (7b) In `auto`, after line 7: `The router's applied choices count at full weight.`
- **Explain** adds, for a payload with `guards`: `Guards: pause none|since DATE · spare attempts N · share E of N`. Step 1's header already prints the row's own mode and state.
- Step 1's `routing lines show unknown, never zero` changes one assertion: `requested` auto prints `requested auto: auto starts after the shadow period`.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `routing auto lines show the period, the pause, and the share` (client-args) | An auto status prints `rehearsal · routing auto (saved)`, `Shadow period: ended`, the explored, share, and state lines, and the full-weight line. A shadow status with `requested` auto prints the requested line; an ended period without `requested` auto adds `Auto routing needs --routing auto.`; a pause prints its line in both modes; a share of 0 prints `no auto start decision yet`. An explain of an applied row prints `auto · applied` and its guards line. |
| `requested routing accepts auto and keeps the step-1 checks` (client-args) | `--routing auto` gives `{ mode: "auto" }`; `--routing on` exits with the new message; the value and contributor cases of step 1 give step 1's results. |
| `the routing command pauses and resumes exploration` (client-args) | With a fake API: `routing pause-explore rehearsal` posts to `/routing/projects/rehearsal/explore/pause` and prints the paused line; `resume-explore` prints the resumed line; `--json` prints the answer; without `routingAuto`, the upgrade sentence and no POST; without a project, the usage. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/client-args.test.ts` and `npm run typecheck`, and commit.

### Task 11: `repo init --routing auto`, `team revoke-routing`, help, and the docs

**Files:** `packages/host/src/team-cli.ts`, `packages/host/src/cli.ts`, `packages/host/src/client-entry.ts`, `docs/teams.md`, the design, `tests/autonomy-enrollment.test.ts`, `tests/routing-routes.test.ts`. Needs Tasks 9 and 10.

**Interfaces (produces):** `infinite repo init ... [--routing off|shadow|auto]`, `infinite team revoke-routing TEAM_ID [--request-id UUID] [--json]`. `team-cli.ts`, net −21 lines (1,263 to 1,242):

- lines 37 to 60 (`ROUTING_VALUE_PRESETS` and `requestedRouting`) are removed (−24), and one import line is added: `import { requestedRouting, ROUTING_AUTO_NOTE } from "./routing-cli.js";` (+1);
- after line 695: `if (routingChoice?.mode === "auto" && me.teams?.routingAuto !== 1) throw new Error("This host does not support auto routing. Upgrade the host before using --routing auto.");` (+1);
- after line 847: `if (routingChoice?.mode === "auto") console.error(ROUTING_AUTO_NOTE);` (+1);
- lines 1199, 1203, and 1262 in place: `revoke-routing` joins the action list, maps to `/teams/${id}/routing/revoke`, and joins the usage line. Its body is `{ requestId, revision: current.revision }`, as `revoke-permissions` sends.

`cli.ts` (lines 244, 245, 278, 279) and `client-entry.ts` (lines 35, 36, 50, 51): `--routing off|shadow|auto`, and three new lines: `infinite team revoke-routing TEAM_ID    Return new tasks to the coordinator's profiles`, `infinite routing pause-explore PROJECT`, and `infinite routing resume-explore PROJECT`.

**Decisions:**

- **`repo init` stores `auto` merged over the carried value** (step 1's rule), then prints the note. It never refuses `auto` on a host with `routingAuto`.
- **Docs.** `docs/teams.md` gains "## Auto routing" after "## Shadow routing": turning it on, the shadow period and its stored end, what the coordinator sees, the fallback rule and its run line, the fixed rules on scouts, escalations, and fallbacks, the guards and the pause, `revoke-routing`, the status lines, and the rollback note.
- **The design**, amended in place and marked *Auto slice (2026-11-16)*: Part 1 (`auto` only from a saved mode; the period end and when it is stored; a saved `auto` before then pins shadow; the revoke and fallback rule); Part 5 (the guard order; the share over `exploreWindow − 1` pending and applied rows; the 7-day stale rule; headroom not applied); Part 7 (`task.routing = { profileId, by }`; the `routing` projector as the startup pass; a blocked run keeps its pending rows); Part 8 (in an `auto` run, a worker's scout and escalation profiles pass rule 1); Part 9 (`revoke-routing` reads the current revision); Failure modes (the fallback rule and its run line); Left to the builder, "Filled in by the auto slice" (the share formula and its epsilon, the indexes `routing_by_state` and `routing_by_identity`, `routing_projects`).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `repo init saves routing and keeps it when omitted` (autonomy-enrollment, host, updated) | Step 1's assertions hold, except the two on `--routing auto`: it now stores `{ mode: "auto", successValueUsd: 8, allowContributor: true }` over the carried value, exits 0, and prints `ROUTING_AUTO_NOTE` on stderr (read through `spawnSync`, because `invoke` returns stdout only). The following `--routing off` still replaces only the mode. |
| `the team revoke-routing command reaches the route` (routing-routes, host) | On a run without an auto pin, `infinite team revoke-routing ID` exits non-zero and prints `This team does not choose worker profiles automatically.` |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement**, and amend the docs and the design. **Step 4: Run** `tests/autonomy-enrollment.test.ts` and `tests/routing-routes.test.ts` on the host and `npm run typecheck`.
- [ ] **Step 5: The coordinator runs `npm run check` once (count failed and cancelled tests), checks the file-size ratchet output for `teams.ts` 5,747 and `team-cli.ts` 1,242, requests the independent review, and commits.**

## Not in this slice

- The headroom guard and the limit-pressure term (delegated adoption design Part 8), model families (C19), and the duel tie-break. They need code that other designs own.
- The escalation and scout decision points (step 4): an optional `agentProfileId` in the scout schema and the `escalate` report, the implementer's "the host selects the stronger profile" text, and acceptance 8. The learned cascade (step 5): `cascade` stays pinned and shown, never applied. `--routing-points` and `--routing-cascade` (Part 9).
- Replay priors and the dry run (step 3); `orderProbability`.
- Status, the pause, and `task.routing` in the web, phone, and Mac clients (step 6). No client change is needed for this slice: each shows the member's profile once a task starts.
- A run event kind for routing. The who-chose weight reads decision rows.
- Measured costs and the rescue cost from the ledger.

## Owner decisions this slice needs, with the defaults it builds

1. **Which projects run `auto`**: per the design and coordinator ruling 1, every `autonomous` project after its shadow period, and a saved `auto` in any project. A saved `shadow` keeps a project in shadow.
2. **The shadow period** (decision 1, value to confirm): 14 days and 50 recorded `start` decisions, counted per project from recorded rows, including rows recorded before `auto` was saved.
3. **The fallback when the router cannot choose**: the coordinator's pick when it passes rules 1 and 2, else the default profile (the failure table says the default profile).
4. **Contributor eligibility** (decision 4): not allowed by default. In an `auto` run this also bars contributor profiles from scouts, escalations, and limit fallbacks, so a lineup whose only light implementer is a contributor profile starts every task on a strong profile until the owner runs `--routing-contributor allow` for the project.
5. **A saved `auto` before the period ends**: accepted, with a note; runs stay in shadow until the end is stored.
