# Continuous Autonomy Implementation Plan (INF-196)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let work in an autonomous project continue without the owner under one principle. The action is reversible, a host receipt or an independent evaluator establishes its outcome, and it stays inside the spend fuse and the project's authority.

**Architecture:** The enrollment record holds the owner's mode. `RepoEnrollmentService` overlays it on the configured project, as it overlays `team` and `source`. Run, goal, and cycle creation pin it, and later slices read only the pins. A spend fuse at member launch is the outer bound. Attention narrows owner pushes to five interrupt reasons and a daily digest.

**Tech Stack:** TypeScript, `zod`, `node:test`. The evidence store of INF-182 for the fuse and the digest.

**Spec:** `docs/superpowers/specs/2026-11-13-continuous-autonomy-design.md`, under contracts C11 to C13 and C18 of `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md`. Verdicts and the evaluator are in `docs/superpowers/specs/2026-11-13-objective-record-design.md` (C14).

This plan grows one section per slice. Each slice is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- The host never infers task completion and never approves a provider permission on its own (`PRODUCT.md`).
- The mode, the fuse, and the attention settings are owner settings. Learning never changes them (C9 rule 2, C15 class C).
- No new key inside an object that the routine authority digest hashes uses a schema `.default()`. The code applies the default at read (C11).
- A run, goal, cycle, or pending launch without a mode is `supervised`.
- No fuse figure, digest, or interrupt enters a member's prompt, context file, or tool result (C9 rule 3).
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. Tests that start a host run on the host. The full check is `npm run check`.

## Slices

| Slice | Content | Needs |
|---|---|---|
| Autonomy mode | The stored mode, the API and CLI, the pins on run, goal, and cycle, the view, and the digest test of 3.7. This section | nothing |
| Launch-rate fuse | `FuseService` with launch counts, `check` and `admit` at every caller, the backstop, trips, `close`, `GET /api/fuse`, and the CLI | the evidence store |
| Token, list, and metered ceilings | Reservations, settlement, grants, and the 80% warning | Launch-rate fuse, INF-183 phase 3 |
| Standing objectives | The `objective` shape, per-cycle allowances, the classification, stop rules 1, 3, 4, 5, and 7, the bounded record, retention | Autonomy mode; the C17 goal digest or the 16-cycle cap |
| Until-met goals and open-ended routines | The `until-met` shape, stop rules 2 and 6, routines without expiry and their pinned mode | Standing objectives, C14 verdicts and owner override |
| Delivery default | The `repo init` merge default, the adoption action, the moved-base baseline check, the C19 gate in `assertDelivery` | Autonomy mode, C19 |
| Attention | Interrupt sources, `question.interrupt`, notifier suppression, the two push events, the digest with its API, CLI, and client views | Autonomy mode; the fuse and standing goals for their interrupt sources |

---

# Slice: autonomy mode

Spec Part 2 (C12) and the digest rule of 3.7. The slice stores each enrolled repository's mode, pins it on every new run, goal, and cycle, and shows it in the enrollment view and the CLI. It changes no behaviour: nothing reads a pin yet. A test proves that no routine's authority digest moves.

## Trust boundary, and what a review checks

The mode is an owner setting. Two writers exist, and both require the owner role and a paired owner CLI: `PUT /api/projects/:id/autonomy` and `PUT /api/projects/:id/team` with `autonomy` (`infinite repo init --autonomy`). The operator can set only `autonomy.defaultMode` in the host config file. No member report, tool call, provider output, steering text, learning path, or goal, team, or routine request carries a mode. `createGoalSchema`, `createTeamSchema`, `createRoutineSchema`, and `teamGoalContextSchema` gain no key. A config project entry cannot set it, because the projects schema strips unknown keys.

The slice must survive:

- **A record written before this slice.** An enrollment without the key reads the host default. A run, goal, cycle, or pending launch without the key reads `supervised`. Loading rewrites no record.
- **A host restart between a change and the next run.** The change is sealed before memory changes. `restore` applies it again at start. A goal launch prepared before the change replays with the mode it recorded.
- **A client that sends an unknown value.** Strict schemas refuse it with 400, and nothing is stored. A stored value that is not a mode reads as `supervised`.

Outside the slice: what a mode enables (slices 2 to 7), and the evaluator condition (C14). A rollback to a release before this slice ignores the key, and its next `repo init` drops it. After the upgrade again, that repository reads the host default. A person who holds the vault key can edit the sealed file.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/autonomy.ts` (create) | The mode type and schema, and the two reading rules |
| `packages/host/src/types.ts` (modify) | `Project.autonomy` (the overlay) and `Config.autonomy` |
| `packages/host/src/config.ts` (modify) | The top-level `autonomy` block, with no default |
| `packages/host/src/repo-enrollment.ts` (modify) | The stored key, the request key, `setAutonomy`, the overlay, and the view fields |
| `packages/host/src/server.ts` (modify) | `PUT /api/projects/:id/autonomy` and the `/me` capability |
| `packages/host/src/team-types.ts`, `goal-types.ts` (modify) | `TeamRun.autonomy`, `ProductGoal.autonomy`, `GoalCycle.autonomy` |
| `packages/host/src/teams.ts` (modify) | `createForGoal` and `createRun` only |
| `packages/host/src/goals.ts` (modify) | `Stored.launch`, `create`, `step`, and `launch` |
| `packages/host/src/autonomy-cli.ts` (create), `client.ts`, `team-cli.ts` (modify) | `infinite autonomy mode` and `repo init --autonomy` |
| `docs/teams.md` (modify) | A short "Autonomy mode" section |
| `tests/autonomy-mode.test.ts`, `autonomy-enrollment.test.ts`, `autonomy-pins.test.ts`, `autonomy-cli.test.ts` (create) | One file per task, so no task edits a busy test file |

## Review Focus

1. A goal launch prepared before the upgrade replays after it. Expect its existing run with no `request-conflict`, and a `supervised` pin, because the mode stays out of the `createRun` fingerprint.
2. A routine approved before this slice ticks after the upgrade, with a mode set and `autonomy.defaultMode` in the config. Expect no block and an unchanged `authority`.
3. Records without the key. Expect an enrollment to read the host default, which is `autonomous` unless the config says otherwise. Expect a run, goal, cycle, or launch to read `supervised`, and the later cycles of an old goal to pin `supervised`. Expect no write at load.
4. A mode change while a run is active, a goal is running, or a cycle launch is prepared. Expect each to keep its pin. The next run and the next goal take the new mode. The later cycles of a running goal keep the goal's pinned mode.
5. An unknown mode from a client, the CLI, or a sealed record. Expect 400 or a CLI error with nothing stored. Expect a stored unknown value to read as `supervised`.

**Order.** Task 1 runs first. Tasks 2 and 3 then run in parallel, because they share no file. Task 4 follows Task 2 and can run beside Task 3.

### Task 1: the mode rules and the host setting

**Files:** `packages/host/src/autonomy.ts` (create), `packages/host/src/types.ts`, `packages/host/src/config.ts`, `tests/autonomy-mode.test.ts` (create).

**Interfaces (produces):**

```ts
// packages/host/src/autonomy.ts (imports zod only)
export const AUTONOMY_MODES = ["supervised", "autonomous"] as const;
export type AutonomyMode = typeof AUTONOMY_MODES[number];
export const autonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomySource = "saved" | "host-default" | "not-enrolled";
/** "autonomous" only when value.autonomy is exactly "autonomous". Missing, null, or unknown is "supervised". */
export function autonomyOf(value: { autonomy?: unknown } | undefined): AutonomyMode;
/** An applied enrollment: a valid saved mode, else config.autonomy.defaultMode, else "autonomous". A saved non-mode is "supervised". */
export function enrollmentAutonomy(saved: { autonomy?: unknown }, config: { autonomy?: { defaultMode?: AutonomyMode } }): { mode: AutonomyMode; source: "saved" | "host-default" };
// packages/host/src/types.ts
export interface Project { /* existing fields */ autonomy?: AutonomyMode }   // set only by RepoEnrollmentService
export interface Config { /* existing fields */ autonomy?: { defaultMode?: AutonomyMode } }
// packages/host/src/config.ts, in the top-level schema
autonomy: z.object({ defaultMode: autonomyModeSchema.optional() }).strict().optional(),
```

**Decisions:**

- The mode lives beside `project.team`, never inside it. `RoutineService.authority()` picks `path`, `team`, `teamworkDir`, `source`, and `linear` from the project, and it never reads the top-level `autonomy` block. So the digest excludes both by construction, and `authority()` does not change.
- `Project.autonomy` holds the effective mode of an applied enrollment, and readers call `autonomyOf(project)`. *(My call: an overlay like `team` and `source`, instead of a lookup hook, so `TeamService` and `GoalService` gain no constructor option, and a skipped `restore` leaves the project supervised.)*
- `autonomy` is strict and holds only `defaultMode` in this slice. The fuse and attention slices add their keys. *(My call: a strict block refuses a misspelt key now.)*
- An unknown stored value fails closed to `supervised`. *(My call: the safer mode, since a wrong `autonomous` would later widen what runs without the owner.)*

- [ ] **Step 1: Write the failing tests** in `tests/autonomy-mode.test.ts`. The digest test keeps `frozenAuthority(config, project)`: a copy of today's formula, the SHA-256 hex of `JSON.stringify({ project: { path: realpath, team, teamworkDir, source, linear }, teams, source, linear, agents })`.

| Test name | Assertions |
|---|---|
| `a missing or unknown pin reads as supervised` | `autonomyOf` gives `supervised` for `undefined`, `{}`, `{ autonomy: null }`, `{ autonomy: "auto" }`, and `{ autonomy: "Autonomous" }`, and `autonomous` for `{ autonomy: "autonomous" }`. |
| `an enrollment reads its saved mode, then the host default, then autonomous` | `({}, {})` gives `autonomous`/`host-default`. `({}, { autonomy: { defaultMode: "supervised" } })` gives `supervised`/`host-default`. `({ autonomy: "supervised" }, { autonomy: { defaultMode: "autonomous" } })` gives `supervised`/`saved`. `({ autonomy: "auto" }, {})` gives `supervised`/`saved`. |
| `parsing the host configuration adds no key to a digested block` | Two config files that differ only by `"autonomy": { "defaultMode": "supervised" }` parse with `readConfig`. Each has a lineup, a command prefix, `source.mirrorDir`, a Linear key file, two agents, and a project `team` with checks, a merge delivery, and permissions. For both, `JSON.stringify` of `teams`, `source`, `linear`, `agents`, and `projects[0].team` equals one frozen literal, which keeps today's `publishHeads: true`. The first result has no `autonomy` key. `"defaultMode": "auto"` and `"autonomy": { "mode": "supervised" }` fail to parse. |
| `the routine authority digest is the same before and after modes exist` | A routine is created with `startsAt` one hour ahead and `expiresAt` two days ahead, over a config with every digested block set. Its sealed `authority` equals `frozenAuthority`. With `project.autonomy = "autonomous"` and `config.autonomy = { defaultMode: "supervised" }`, a new `RoutineService` over the same state directory runs `tick()`. The status stays `scheduled`, `reason` stays undefined, and the sealed `authority` is unchanged. The same holds with `project.autonomy = "supervised"`. |

- [ ] **Step 2: Run** `node --import tsx --test tests/autonomy-mode.test.ts` and confirm a missing module error.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test again, then `node --import tsx --test tests/usage-config.test.ts` and `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs `tests/routines.test.ts` on the host.**

### Task 2: the enrollment record and the API

**Files:** `packages/host/src/repo-enrollment.ts`, `packages/host/src/server.ts`, `tests/autonomy-enrollment.test.ts` (create).

**Interfaces (consumes):** Task 1. **(produces):**

```ts
export const repoEnrollmentRequestSchema = z.object({ /* existing fields */, autonomy: autonomyModeSchema.optional() }).strict();
export const autonomyChangeSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1), mode: autonomyModeSchema }).strict();
export type AutonomyChange = z.infer<typeof autonomyChangeSchema>;
export interface RepoEnrollmentView { /* existing fields */; autonomy: AutonomyMode; autonomySource: AutonomySource }
interface StoredEnrollment { /* existing fields */; autonomy?: AutonomyMode }   // absent on records saved before this slice
class RepoEnrollmentService { setAutonomy(projectId: string, input: AutonomyChange): Promise<RepoEnrollmentView> }
// PUT /api/projects/:id/autonomy  body AutonomyChange, returns RepoEnrollmentView
// GET /api/me                      teams.autonomyMode: 1
```

**Decisions:**

- `setAutonomy` joins the `mutation` chain that `put` uses, so it never interleaves with a `repo init`.
- `setAutonomy` checks in this order. The project exists, else 404 `unknown-project`. A receipt with this `requestId` replays: its fingerprint is the SHA-256 of `JSON.stringify({ action: "autonomy", ...request })`, and another fingerprint or project gives 409 `request-conflict`. A record exists, else 409 `autonomy-requires-enrollment`: "Only a repository enrolled with infinite repo init has an autonomy mode. Other projects stay supervised." *(My call: the code name.)* The path binding holds, else 409 `project-path-mismatch`. `revision` equals the stored revision, else 409 `stale-enrollment-revision`.
- It then writes `{ ...current, autonomy: mode, revision: revision + 1 }` and the receipt in one `writeSealed`. Only after that does it replace `this.store` and set `project.autonomy`.
- `setAutonomy` runs no Git command, does not call `isBusy`, and does not require `config.teams`. *(My call: a mode change touches no file and applies from the next run, so the spec's "at any time" holds.)*
- Every accepted change writes one revision, even when the mode is unchanged. *(My call: the CLI skips that case.)*
- `putLocked` writes `request.autonomy` when present, else keeps `current.autonomy`, else writes no key. The key sits before `revision`. It sets `project.autonomy` and `responseProject.autonomy` from `enrollmentAutonomy`.
- `restore` sets `project.autonomy` from `enrollmentAutonomy(enrollment, this.config)` beside `project.team`, after the path checks pass.
- `view` adds `autonomy: autonomyOf(project)`. `autonomySource` is `not-enrolled` when `project.autonomy` is absent, `saved` when the record has the key, and `host-default` otherwise. So the view shows what the next run pins. *(My call: the two field names and the three source values.)*
- The route uses `requireRole(["owner"])` and `requireOwnerCli`, and refuses a multi-tenant host with 403 `single-tenant-required`, as `PUT /api/projects/:id/team` does. *(My call: the paired owner CLI writes every enrollment today. The attention slice can add a phone control.)* It takes no `projectConfigChanges` lock, because the service chain serializes. `/me` gains `teams.autonomyMode: 1` for the CLI. *(My call: the flag name, in the style of `repoEnrollment: 1`.)*
- A `put` without `autonomy` writes the same `projects` entry as today. Each new receipt's stored `response` carries the two view fields. A receipt from before this slice replays its stored response, without them.

- [ ] **Step 1: Write the failing tests** in `tests/autonomy-enrollment.test.ts`, with the Git and command-prefix fixture of `tests/repo-enrollment.test.ts`.

| Test name | Assertions |
|---|---|
| `an enrolled repository is autonomous by default and an unenrolled one is supervised` | Before `put`: `get` gives `supervised`/`not-enrolled`, and `config.projects[0].autonomy` is undefined. After a `put` without `autonomy`: `autonomous`/`host-default`, overlay `autonomous`, and the sealed entry has no `autonomy` key. With `config.autonomy = { defaultMode: "supervised" }`: `supervised`/`host-default`. |
| `an enrollment saved before this slice reads the host default and is not rewritten` | `writeSealed` stores `{ version: 1, projects: { example: { path, team, revision: 1 } }, requests: {} }`. A new service gives the view `autonomous`/`host-default` and overlay `autonomous`. The file bytes are equal before construction and after `get`. |
| `repo init stores an explicit mode outside the team block and keeps it when omitted` | `put` with `autonomy: "supervised"` gives `supervised`/`saved`. A `put` at revision 1 without it keeps `supervised`. A `put` with `autonomous` gives `autonomous`. `Object.hasOwn(config.projects[0].team!, "autonomy")` is false, and the sealed entry's `team` deep-equals the request's `team`. |
| `a mode change is one revision, replays by request id, and runs no Git` | At revision 1, `setAutonomy` with `supervised` gives revision 2, `supervised`/`saved`, and overlay `supervised`. The same request gives the same view at revision 2. Its id with `autonomous` gives 409 `request-conflict`. A new id at revision 1 gives 409 `stale-enrollment-revision`. The command-prefix receipt file gains no line. A service whose `isBusy` returns true accepts a change. |
| `a mode change needs an applied enrollment` | An unenrolled project gives 409 `autonomy-requires-enrollment`, and no sealed file exists. `missing` gives 404 `unknown-project`. A moved project path gives 409 `project-path-mismatch`. |
| `a mode change survives a restart` | After the change to `supervised`, a new config and service give overlay `supervised` and the view `supervised`/`saved`. |
| `an unknown mode is refused and a stored unknown mode reads as supervised` | `setAutonomy` with `mode: "auto"` and `put` with `autonomy: "auto"` throw a `ZodError`, and the revision is unchanged. A sealed entry with `autonomy: "auto"` gives overlay `supervised` and the view `supervised`/`saved`. |
| `only the owner CLI changes the mode over the API` *(starts a host)* | Set up as `owner CLI enrolls a mirrored repository` does. The owner bearer gets 200 with `supervised` at revision 2. A controller gets 403. A browser owner with a cookie and `Origin` gets 403. `mode: "auto"` and an extra key get 400. `/api/me` has `teams.autonomyMode` 1. After `host.stopApi()` and `host.start()`, `GET /api/projects/:id/team` shows `supervised`. |

- [ ] **Step 2: Run** `node --import tsx --test tests/autonomy-enrollment.test.ts` and confirm the failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests that start no host, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs the host test and `tests/repo-enrollment.test.ts` on the host.**

### Task 3: the pins on run, goal, and cycle

**Files:** `packages/host/src/team-types.ts`, `packages/host/src/goal-types.ts`, `packages/host/src/teams.ts`, `packages/host/src/goals.ts`, `tests/autonomy-pins.test.ts` (create).

**Interfaces (consumes):** Task 1. **(produces):**

```ts
export interface TeamRun { /* existing fields */; autonomy?: AutonomyMode }      // pinned at creation
export interface ProductGoal { /* existing fields */; autonomy?: AutonomyMode }  // the mode the goal started in
export interface GoalCycle { /* existing fields */; autonomy?: AutonomyMode }    // the goal's pinned mode, copied when the cycle's launch is prepared
createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false, autonomy: AutonomyMode = "supervised"): Promise<TeamView>;
// createRun's internal parameter gains autonomy?: AutonomyMode.
// goals.ts: Stored.launch?: { request: CreateTeam; context: TeamGoalContext; autonomy?: AutonomyMode }
```

**Decisions:**

- `TeamService.createRun` pins `autonomyOf(internal)` for a goal run and `autonomyOf(project)` for every other run: standalone, mission subteam, and handoff. *(My call: a handoff run takes the project's current mode, as a standalone run does.)* One statement after the `TeamRun` literal sets `run.autonomy`. The literal's line stays as it is.
- `createRun` drops `autonomy` from `creationContext` beside `parallelismCeiling`, so the request fingerprint does not change. *(My call: the existing rule for host-derived values. A launch prepared before this slice must still find its run.)*
- A replayed request returns the stored run with its pin. A continuation or resume keeps the run's pin. *(My call.)* `createForMission`, `createForHandoff`, `view`, and every other `teams.ts` function stay unchanged.
- `GoalService.create` adds `autonomy: autonomyOf(project)` after `lineup` in the goal literal.
- `GoalService.step` sets `stored.launch.autonomy` when it prepares a cycle. The value is `autonomyOf(goal)`: the goal's own pin, and `supervised` when the goal has none. It does not read the project. *(Spec Part 2, as corrected on 2026-11-13: a goal keeps the mode it started in, so a change applies to the next run and the next goal. A goal recorded before the contract has no pin, so its later cycles stay supervised and work in flight keeps today's behaviour.)*
- `GoalService.launch` passes `autonomyOf(pending)` to `createForGoal` and writes it on the new cycle. The branch of `step` that records an existing run for a paused or stopped goal writes `autonomyOf(stored.launch)`.
- The cycle's mode is copied once, when its launch is prepared, and a restart replays the prepared launch with the mode it recorded.
- Loading migrates nothing, and no view adds a default. A record without a pin loads byte-identical and reads `supervised` through `autonomyOf`. *(My call: one reading rule for every later slice, and the smallest change to `teams.ts`.)*
- Keys that appear: `run.autonomy` on every new run (`supervised` in a fixture without an overlay), `goal.autonomy` on every new goal, and `autonomy` on every new cycle and prepared launch. Routine records do not change.
- C14's seam: a pin is computed only in `TeamService.createRun`, `GoalService.create`, and `GoalService.step`. C14 adds its eligible-evaluator check at those three points.

- [ ] **Step 1: Write the failing tests** in `tests/autonomy-pins.test.ts`. Team tests use `schedulerFixture()` with `projects[0].team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] }`, the goal test lineup, and `agents` for `demo`, `claude`, and `codex`. Goal tests use a stub `TeamService` that records each `createForGoal` call and returns a view whose status the test sets.

| Test name | Assertions |
|---|---|
| `a standalone run and a mission subteam pin the project's current mode` | With `projects[0].autonomy = "autonomous"`, `create()` and `createForMission()` give views and sealed records with `autonomy: "autonomous"`. Without the overlay, `create()` gives `supervised`. |
| `a goal run pins the mode its cycle passes` | With overlay `supervised`, `createForGoal(request, context, lineup, false, "autonomous")` pins `autonomous`. Without the fifth argument it pins `supervised`. |
| `the mode is not part of a run request's identity` | `createForGoal` with one request id, first with `supervised` and then with `autonomous`, gives the same run twice with no `request-conflict`. The pin stays `supervised`. |
| `a mode change applies from the next run` | Run A starts with overlay `autonomous`. After the overlay becomes `supervised`, A's sealed record still has `autonomous`, and run B pins `supervised`. |
| `a run recorded before this slice reads as supervised and is not rewritten` | The fixture run has no key. `autonomyOf(teams.get(id))` is `supervised`, and the sealed record has no `autonomy` key after `get`. |
| `a goal records its start mode and every cycle keeps it` | With overlay `autonomous`, `create()` gives `goal.autonomy` `autonomous`. The first tick calls `createForGoal` with `autonomous`, and cycle 1 has `autonomous`. After the overlay becomes `supervised` and the stub settles cycle 1 as `ready-for-review`, cycle 2 is still called and recorded with `autonomous`. The reverse holds too: a goal created under `supervised` keeps `supervised` cycles after the overlay becomes `autonomous`. |
| `a prepared launch keeps its mode across a change and a restart` | A goal record holds `launch.autonomy: "autonomous"` with overlay `supervised`. A new `GoalService` calls `createForGoal` with `autonomous`, and the cycle records `autonomous`. |
| `a goal recorded before this slice stays supervised` | A goal record and its launch have no key, with overlay `autonomous`. The call and cycle 1 use `supervised`, and so does cycle 2. `autonomyOf(goal)` is `supervised`. |

- [ ] **Step 2: Run** `node --import tsx --test tests/autonomy-pins.test.ts` and confirm the failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test again, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs `tests/goals.test.ts`, `tests/teams.test.ts`, and `tests/missions.test.ts` on the host.**

### Task 4: the CLI and the documentation

**Files:** `packages/host/src/autonomy-cli.ts` (create), `packages/host/src/client.ts`, `packages/host/src/team-cli.ts`, `docs/teams.md`, `tests/autonomy-cli.test.ts` (create).

**Interfaces (consumes):** the Task 2 route, view, and `/me` flag. **(produces):**

```ts
export async function handleAutonomyClientCommand(positional: string[], options: Record<string, string | boolean>,
  api: { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> }): Promise<boolean>;
// infinite autonomy mode PROJECT [supervised|autonomous] [--revision N] [--request-id UUID] [--json]
// infinite repo init … [--autonomy supervised|autonomous]
```

**Decisions:**

- `autonomy mode PROJECT` reads `GET /api/projects/PROJECT/team` and prints `PROJECT  MODE (saved | host default | not enrolled) · revision N`. *(My call: the read form costs one request.)*
- With a mode, it refuses a value other than the two, and a project id that fails `^[a-z0-9-]{1,80}$`, before any request. A view without `autonomy` gives "This host does not support autonomy modes. Upgrade the host." A `not-enrolled` view gives "PROJECT is not enrolled. Run infinite repo init first; other projects stay supervised."
- A view whose `autonomySource` is `saved` and whose mode equals the request prints the mode and sends nothing. *(My call: a rerun after a lost reply reads the new revision, so a resend would conflict.)* Otherwise it prints the request id to stderr and sends `{ requestId, revision, mode }`, with `revision` from the view unless `--revision` is given.
- `client.ts` adds `"autonomy"` to `CLIENT_COMMANDS` and one dispatch line beside `routine`.
- `repo init` checks `--autonomy` beside `--handoff`, before any request. With the flag set, `me.teams?.autonomyMode !== 1` gives "This host does not support autonomy modes. Upgrade the host before using --autonomy." The body gains `autonomy` only when the flag is set. The `resumePendingIntent` comparison adds `prior.autonomy === body.autonomy`. The non-Git flag list and the usage line gain `--autonomy`. The printed JSON gains `autonomy` and `autonomySource`.
- `requestedDelivery` does not change. The merge default is the delivery slice.
- `docs/teams.md` gains "Autonomy mode": the two values, the default for enrolled repositories, `autonomy.defaultMode`, both commands, and that this release records and pins the mode without acting on it.

- [ ] **Step 1: Write the failing tests** in `tests/autonomy-cli.test.ts`, with the fake HTTP server of `tests/routine-cli.test.ts`.

| Test name | Assertions |
|---|---|
| `autonomy mode prints the current mode` | The view `{ autonomy: "autonomous", autonomySource: "host-default", revision: 3 }` prints `autonomous (host default)` and `revision 3`. The server sees one GET and no PUT. |
| `autonomy mode sends one change at the current revision` | `autonomy mode example supervised` sends `GET /api/projects/example/team`, then `PUT /api/projects/example/autonomy` with `revision: 3`, `mode: "supervised"`, and a UUID `requestId` that stderr names. With `--revision 5 --request-id` and a fixed UUID, the body carries both. |
| `autonomy mode sends nothing for a mode already saved` | A `saved` view in `supervised` sends no PUT for `supervised`. A `host-default` view in `supervised` sends the PUT. |
| `autonomy mode refuses bad input before a change` | `auto` and the project `Bad_Id` throw with zero requests. A `not-enrolled` view and a view without `autonomy` each throw, with no PUT. |
| `repo init sets, keeps, and validates the mode` *(starts a host)* | A clean repository enrolled with `--autonomy supervised --json` prints `supervised`/`saved` at revision 1. A rerun without the flag prints `supervised` at revision 2. `--autonomy auto` throws, and the revision stays 2. In a non-Git directory, `--autonomy supervised` throws an error that names `--autonomy`. |

- [ ] **Step 2: Run** `node --import tsx --test tests/autonomy-cli.test.ts` and confirm the failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests that start no host, `tests/routine-cli.test.ts`, and `tests/team-cli-source.test.ts`, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs the host test and `npm run check`, requests the independent review, and commits.**

## Not in this slice

- Anything that reads a pin: standing goals and `standing-requires-autonomy`, the routine's pinned mode and the narrower-mode rule, the merge default at `repo init`, notifier suppression, `TeamRow.autonomous` and `GoalRow.autonomous`, and the fuse.
- The evaluator condition (C14): the derived `evaluators` slot, `autonomyReady` in the view, the `supervised` pin for a lineup with no eligible evaluator, and its digest line. It plugs into the three pin sites of Task 3.
- The `fuse` and `attention` keys of the host `autonomy` block.
- The mode in the web and phone clients. *(My call: it arrives with the attention slice, where the mode first changes what the owner sees.)*

---

# Slice: launch-rate fuse

Continuous autonomy design, delivery slice 2 (contract C13, Part 4). The slice adds `FuseService`, an evidence store module with its own sealed baseline file. Every caller that starts a team session asks `check` before it does work and `admit` before it starts a session, and `Manager.createOnce` calls `admit` again as a backstop. In this slice the only ceilings are launches per rolling hour, 30 per project and 80 per host, and the only causes are `launch-rate` and `unmeasurable`.

The fuse is off in a service that never receives one. `server.ts` gives one to every service. Most existing tests build services without one, so they behave and seal records exactly as today.

## Trust boundary, and what a review checks

The fuse is host code and an owner setting. Its limits come only from the host config block `autonomy.fuse`. Only the owner can close a trip, through `POST /api/fuse/close`. No member, report, provider, client field, or learning path can raise a limit, close a trip, or grant more. No team, goal, routine, or mission record carries a fuse limit or count. Their `reason` holds only a fixed wait text. The fuse reads no report. A launch id is a host-issued session request id: `member.sessionId` or `Attempt.sessionId`, both from `randomUUID()` in host code.

The slice must survive these failures. A host restart. A baseline file that is missing or fails authentication. An evidence store that is unavailable at start or during a run. A launch that is admitted and never starts. A caller that skips `admit`. Ten scheduler passes over one queued member. A review looks for a launch that is counted twice or not at all, a refusal that throws into a scheduler loop, a write by `check`, a baseline written while none is authoritative, and a changed record in a service without a fuse. Hostile code inside the host process is outside this slice. So is a person who deletes both the baseline file and the store.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/fuse/types.ts` (create) | Launch, check, admission, trip, record, and view types, and the `FuseGate` interface |
| `packages/host/src/fuse/rules.ts` (create) | Pure rules: the rolling hour, trip open and close, the second-trip rule, the exemption, the launch builder, the wait reasons |
| `packages/host/src/fuse/baseline.ts` (create) | The sealed baseline file, its schema, the cold-start merge, and pruning |
| `packages/host/src/vault.ts` (modify) | `writeSealed` removes its temporary file when a write fails |
| `packages/host/src/fuse/service.ts` (create) | `FuseService`: the evidence module, load, `check`, `admit`, `release`, `started`, `close`, `view`, interrupts, the timer |
| `packages/host/src/config.ts` (modify) | The top-level `autonomy.fuse` block, and the `autonomy-interrupt` push event |
| `packages/host/src/teams.ts` (modify) | `useFuse`, and two call sites in `launch` |
| `packages/host/src/manager.ts` (modify) | `useFuse`, and the backstop, release, and start mark in `createOnce` |
| `packages/host/src/goals.ts`, `routines.ts`, `missions.ts` (modify) | `useFuse`, `check` in `step`, and `check` and `admit` in the mission coordinator launch |
| `packages/host/src/server.ts`, `cli.ts` (modify) | Build and wire the fuse, `GET /api/fuse`, `POST /api/fuse/close`, the fuse source for the Notifier |
| `packages/host/src/client.ts` (modify) | `infinite fuse [--json]` and `infinite fuse close --project ID\|--host` |
| `packages/host/src/notifier.ts` (modify) | The fuse interrupt source |
| `docs/teams.md` (modify) | One paragraph: the launch-rate fuse, its wait reason, and the CLI |
| `tests/fuse-rules.test.ts`, `fuse-baseline.test.ts`, `fuse-service.test.ts`, `fuse-callers.test.ts`, `fuse-launch.test.ts`, `fuse-api.test.ts` (create) | One file per task |
| `tests/push.test.ts`, `tests/client-args.test.ts` (modify) | The fuse push, and the `fuse` command candidate |

## Review Focus

1. Ten scheduler passes over a queued member while capacity is full or the fuse is open. Expect the baseline file bytes unchanged, and one charge when the member starts.
2. A launch that `TeamService` admitted reaches the backstop. Expect one count. A caller that skipped `admit` is counted there, or refused with `fuse-open`.
3. A cold start with the file unauthenticated, the store unavailable, or both. Expect the store, the file, or `unmeasurable`, and no file write without an authoritative baseline.
4. A refusal in each caller. Expect no throw, an unchanged status, a reason that names the fuse and holds no figure, and no save by the fuse gate on a pass that changes nothing.
5. A service without a fuse. Expect today's behaviour and today's sealed records.

### Task 1: types, pure rules, and the wait reason

**Files:** `packages/host/src/fuse/types.ts`, `packages/host/src/fuse/rules.ts`, `tests/fuse-rules.test.ts`.

**Interfaces (consumes):** `TeamAssignment` and `TeamModelProfile` from `packages/host/src/team-types.ts`.

**Interfaces (produces):**

```ts
// packages/host/src/fuse/types.ts
export type FuseScope = "project" | "host";
export type FuseWindow = "hour" | "day" | "week";
export type FuseCause = "launch-rate" | "unmeasurable";            // slice 3 adds "tokens" | "list" | "spent"
export type SessionPurpose = "work" | "duel" | "replay" | "gate";   // C8
export type LaunchRole = TeamAssignment["role"];
export type FuseLaunch = { launchId: string; projectId: string; purpose: SessionPurpose; role: LaunchRole; profileId: string;
  assignment?: Pick<TeamAssignment, "runId" | "memberId" | "revision"> };
export type FuseOpen = { state: "open"; scope: FuseScope; projectId?: string; window?: FuseWindow; cause: FuseCause; tripId?: string; ownerClose: boolean };
export type FuseCheck = { state: "closed"; exempt?: true } | FuseOpen;
export type FuseAdmission = { ok: true; launchId: string; repeat?: true; exempt?: true }
  | { ok: false; launchId: string; open: FuseOpen } | { ok: false; launchId: string; failure: "write-failed" };
export type LaunchState = "admitted" | "started" | "released";
export type FuseLaunchRecord = FuseLaunch & { state: LaunchState; admittedAt: number; seq: number };
export type FuseTripRecord = { tripId: string; scope: FuseScope; projectId?: string; cause: FuseCause; window?: FuseWindow;
  openedAt: number; closedAt?: number; closedBy?: "rate" | "owner" | "baseline"; ownerClose: boolean; announcedAt?: number; launches?: number; seq: number };
export type FuseLimits = { project: number; host: number; projects: Record<string, number> };   // launches per hour
export interface FuseGate {
  check(input: { projectId: string; role?: LaunchRole }): FuseCheck;
  admit(launch: FuseLaunch): FuseAdmission;
  release(launchId: string): void;
  started(launchId: string): void;
}
// packages/host/src/fuse/rules.ts
export const HOUR_MS = 3_600_000;
export const DEFAULT_LAUNCHES_PER_HOUR = { project: 30, host: 80 } as const;
export const EXEMPT_ROLES: ReadonlySet<LaunchRole>;                                   // { "permission-coordinator" }
export function utcDay(ms: number): string;                                           // "2026-11-13"
export function projectLimit(limits: FuseLimits, projectId: string): number;
export function rollingCount(launches: readonly FuseLaunchRecord[], trips: readonly FuseTripRecord[], scope: FuseScope, projectId: string | undefined, now: number): number;
export function scopeState(launches: readonly FuseLaunchRecord[], trips: readonly FuseTripRecord[], scope: FuseScope, projectId: string | undefined, limit: number, now: number): FuseCheck;
export function fuseCheck(launches: readonly FuseLaunchRecord[], trips: readonly FuseTripRecord[], projectId: string, limits: FuseLimits, now: number): FuseCheck;
export function workLaunch(input: { launchId: string; projectId: string; provider: string; team: TeamAssignment; profile?: Pick<TeamModelProfile, "id"> }): FuseLaunch;
export function fuseReason(result: FuseOpen | "write-failed"): string;
export function isFuseReason(text: string | undefined): boolean;
export function applyFuseReason(holder: { reason?: string }, result: FuseCheck | FuseAdmission | undefined): { wait: boolean; changed: boolean };
```

**Decisions:**

- **Rolling count.** A launch counts toward a scope while `admittedAt > now - HOUR_MS` and `admittedAt` is after the `closedAt` of the scope's latest owner-closed trip. An owner close stamped after `now` is not a cutoff yet. *(Local review, second pass: after a clock that stepped back, a cutoff in the future left every new launch uncounted until the clock passed it.)* A launch stamped after `now` still counts. *(My call: a backward clock jump cannot reopen a burst, and an owner close starts a fresh count.)* Released launches count, because the launch was attempted. The host scope counts every project.
- **Trip rules in `scopeState`.** A recorded open `ownerClose` trip is open. A recorded open rate trip without `ownerClose` is open while `2 * count >= limit`, so it closes below half the limit (below 15 of 30). With no open trip, `count >= limit` reports a pending trip (`state: "open"`, no `tripId`). Its `ownerClose` is true when the scope already has a rate trip whose `openedAt` falls in `utcDay(now)`.
- **`scopeState` judges one scope only**: that scope's own trips and its own count against its own limit. A project call never reads a host trip, because it has neither the host count nor the host limit. *(Decided during the build: a project call that reported a recorded host rate trip as open could never see it close, and every launch would wait for good.)* Within one scope an open `unmeasurable` trip wins over a rate trip, and an open `ownerClose` rate trip wins over one without it. *(Decided during the build: the baseline merge keeps a trip open when either copy has it open, so one scope can hold two open rate trips.)*
- **`fuseCheck` holds the order** for one project: `scopeState` for the host with `limits.host` (the `unmeasurable` trip is a host trip, so it comes first), then `scopeState` for the project with `projectLimit(limits, projectId)`. It returns the first open result, or the project's closed result. *(My call: the host wins over the project.)* `FuseService.check` and `admit` call `fuseCheck`, so no caller repeats the order.
- A result copies the trip's `window` when the trip has one and sets none otherwise. A pending rate trip has `window: "hour"`. An `unmeasurable` result has no window.
- **Exemption.** `EXEMPT_ROLES` holds only `permission-coordinator`. Task 3 applies it inside `FuseService`, so no caller and not the backstop tests a role.
- **`workLaunch`** is the one launch builder. `purpose` is `work`, because no learning harness exists yet. `profileId` is `profile.id`, or the provider when the member has no profile. `assignment` copies `runId`, `memberId`, and `revision`. *(My call: one builder, so the first `admit` and the backstop build equal launches.)*
- **Wait reasons** start with `Waiting for the spend fuse:` and name the scope and the cause, never a count or a limit. Project rate: `Waiting for the spend fuse: this project reached its hourly launch limit.` Host rate: the same with `the host`. A rate trip with `ownerClose` adds ` It stays open until the owner closes it.` `unmeasurable`: `Waiting for the spend fuse: the host cannot read its fuse baseline.`, with no added sentence whatever its `ownerClose` says, because the owner cannot close it. `write-failed`: `Waiting for the spend fuse: the host could not record the launch.` `isFuseReason` tests that prefix.
- **`applyFuseReason`.** An open check or a refusal sets `holder.reason` to its wait reason and returns `wait: true`. An accepted admission clears `holder.reason` only when it is a fuse reason. A closed check does the same, except that it leaves the `write-failed` reason alone. *(Decided during the build: `check` reads memory and cannot see a failing baseline write, so with a failing write a caller that checks and then admits would clear the reason and set it again on every pass, with a save and an event each time.)* An exempt result and `undefined` change nothing. `changed` is true only when the value changed. So a pass that changes nothing saves nothing.
- **How slice 3 adds units without changing these interfaces.** `FuseCause` gains `tokens`, `list`, and `spent`. `FuseWindow` already holds `day` and `week`, and `FuseOpen.window` is already optional. `FuseLaunch` already carries `profileId`, `role`, and `purpose`, which are the inputs to the estimate, so `admit` computes reservations inside. `FuseGate` does not change. Settlement reads the usage ledger inside the service. The baseline raises its `version`, and the view gains `day` and `week` beside `hour`.

- [ ] **Step 1: Write the failing tests** in `tests/fuse-rules.test.ts`. The clock starts at `2026-11-13T10:00:00.000Z`.

| Test name | Assertions |
|---|---|
| `the rolling hour counts the last hour after the last owner close` | At `now`, a launch at `now - 3,600,000` does not count, one at `now - 3,599,999` counts, and one at `now + 300,000` counts. An owner-closed trip with `closedAt` `now - 1,800,000` drops the launches before it. A released launch counts. The host scope counts launches of projects `a` and `b`, and the project scope counts only its own. |
| `a close stamped after now is not yet a cutoff` | An owner close one hour after `now`: two recent launches both count. One millisecond after that close time, neither counts. |
| `a rate trip opens at the limit and closes below half` | Limit 30, no trip: 29 is closed, 30 is open with no `tripId` and `ownerClose` false. A recorded open trip: 15 is open, 14 is closed. Limit 7: 4 is open, 3 is closed. |
| `a second rate trip in one UTC day needs the owner` | A closed rate trip opened at 01:00 UTC on 2026-11-13. A pending trip at 23:59 has `ownerClose` true. At 00:00 on 2026-11-14 it has `ownerClose` false. A recorded open `ownerClose` trip stays open at count 0. |
| `unmeasurable wins, then the host, then the project` | With an `unmeasurable` host trip, an `ownerClose` host rate trip, and a project rate trip all open, `fuseCheck` for the project reports `unmeasurable`. Without it, the host trip. Without both, the project trip. `scopeState` for the project reports the project trip in all three cases. |
| `an owner-close trip wins over another open rate trip of its scope` | With a plain open rate trip and an open `ownerClose` rate trip in one project, in either order, `scopeState` reports the `ownerClose` trip at count 0. |
| `a host rate trip closes for a project check when the host count falls` | Host limit 80 with a recorded open host rate trip (no `ownerClose`): at 40 counted launches `fuseCheck` for a project is open with scope `host`, and at 39 it is closed. `scopeState` for the project is closed at both. |
| `wait reasons name the scope and cause and hold no figure` | Every `fuseReason` output starts with the prefix and contains no digit. The owner sentence ends a project and a host rate reason with `ownerClose`, and no `unmeasurable` reason, with or without `ownerClose`. `isFuseReason` is true for each, and false for `Waiting for an available host session slot.` and for undefined. |
| `applying a result sets and clears only a fuse reason` | Holder with the slot-wait reason plus an open check: the reason becomes the fuse reason, and `{ wait: true, changed: true }`. The same again: `changed` false. A closed check: reason undefined, `changed` true. A non-fuse reason plus a closed check: unchanged. An exempt check, and `undefined`: `{ wait: false, changed: false }`. `write-failed`: `wait` true. |
| `a closed check leaves a write failure for the admission to clear` | After a `write-failed` admission sets the reason: a closed check gives `{ wait: false, changed: false }` and keeps the text, the same refusal again gives `changed: false`, and an accepted admission clears it with `changed: true`. |
| `limits and days follow the configuration and UTC` | `projectLimit({ project: 30, host: 80, projects: { a: 5 } }, "a")` is 5, and for `b` it is 30. `utcDay` of `2026-11-13T23:59:59.999Z` is `2026-11-13`, and one millisecond later it is `2026-11-14`. `EXEMPT_ROLES` has `permission-coordinator` and not `project-manager`. |
| `workLaunch builds one launch shape` | It returns the session id as `launchId`, `purpose` `work`, the profile id or the provider, and the three assignment fields. |

- [ ] **Step 2: Run the tests and confirm they fail** with a missing module error.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/fuse-rules.test.ts`, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator requests the independent review and commits.**

### Task 2: the baseline file and the cold-start merge

**Files:** `packages/host/src/fuse/baseline.ts`, `tests/fuse-baseline.test.ts`. **Needs:** Task 1.

**Interfaces (produces):**

```ts
export const BASELINE_FILE = "fuse-baseline.sealed";   // in config.stateDir
export const BASELINE_SCOPE = "fuse-baseline";          // the seal scope
export type FuseBaseline = { version: 1; seq: number; launches: FuseLaunchRecord[]; trips: FuseTripRecord[] };
/** Undefined when the file is missing, fails authentication, or fails the schema. Never throws. */
export function readBaseline(file: string, key: Buffer): FuseBaseline | undefined;
/** `writeSealed` under BASELINE_SCOPE. False on any failure. Never throws. */
export function writeBaseline(file: string, key: Buffer, baseline: FuseBaseline): boolean;
export function mergeBaselines(file: FuseBaseline | undefined, store: FuseBaseline | undefined, now: number): FuseBaseline | undefined;
export function pruneBaseline(baseline: FuseBaseline, now: number): FuseBaseline;
```

**Decisions:**

- The schema is strict. It allows at most 5,000 launches and 1,000 trips, and ids of at most 128 characters. A project id has no length limit, as in the host configuration. *(Local review and review round 1: a baseline that refused a project id the configuration accepts made every admission of that project fail.)* A file outside it counts as unreadable. *(My call.)* `writeBaseline` returns false for a baseline outside the schema and writes nothing, so the host never writes a file it could not read back. The role list in the schema is checked against `LaunchRole` at build time.
- `writeSealed` (`vault.ts`) removes its temporary file when the write or the rename fails. *(Review round 1: every refused admission and every recovery tick left one more temporary file beside a baseline path that could not be written. The helper is shared, so every sealed write gains this, and `tests/vault.test.ts` covers it.)* Slice 3 raises `version` to 2 and reads version 1. A rolled-back host reads a version 2 file as unreadable and loads from the store.
- **The file has seen everything up to its own `seq`.** When both copies are readable, a launch or a trip that only the store holds, with a `seq` at or below the file's `seq`, is dropped: the file is written first, so it held that item and pruned it. *(Local review: a failed store write after an owner close left the store row open. The next UTC day the file pruned the closed trip, and every later restart took the store's open copy back, already announced, so every launch of its scope waited with no push.)* A store-only item with a higher `seq` is kept: then the file is the older copy.
- **Merge.** Launches are the union by `launchId`, and trips are the union by `tripId`. For an item in both copies, the copy with the higher `seq` wins, and the file wins a tie. `seq` is the larger of the two. Both undefined gives undefined. The result is pruned. *(Decided during the build and the local review, and a change to spec 4.9, which keeps a trip open when either copy has it open. A trip never reopens, so the open copy of a trip is always the older one. Keeping it open brought a closed trip back after a failed store write: a self-closing trip held launches until the count fell again, and an owner-closed trip held every launch of its scope until the owner closed it a second time, with no new push.)*
- **Prune.** A launch older than an hour drops, except one in state `admitted`, which waits for the cold-start release. A closed trip drops when its `openedAt` day has ended and its `closedAt` is more than an hour old. Open trips stay. *(My call: a released launch older than an hour that is admitted again counts as a new launch.)*

- [ ] **Step 1: Write the failing tests** in `tests/fuse-baseline.test.ts`.

| Test name | Assertions |
|---|---|
| `a baseline round-trips through the sealed file` | Write then read returns an equal value, and the file mode is `0600`. A file sealed with another key, a file sealed under another scope, truncated JSON, a missing file, a `version` 2 file, and a file with an unknown key each read as undefined. |
| `writing a baseline never throws` | A path whose parent is a regular file returns false. |
| `merge takes the union and the later copy of each item` | File at `seq` 3 with `{ A: admitted, seq 3 }`, store `{ A: started, seq 4; B: released, seq 5 }`: A is started and B is kept. Trip T closed in the file at `seq` 3 and open in the store at `seq` 2 is closed. `seq` is the larger. One side undefined gives the other, pruned. |
| `the file has seen everything up to its own seq` | File at `seq` 9 without trip T and without launch L. Store with T open at `seq` 7 and L at `seq` 6: neither is in the merge. A store-only trip at `seq` 10 is kept. With no file, the store's copy is kept. |
| `a closed trip stays closed in a merge` | A trip closed by the owner at `seq` 9 in one copy and open at `seq` 7 in the other, in either order, is closed by the owner after the merge, with its `closedAt`. The same holds for a trip closed by rate. |
| `prune keeps only what the windows need` | A started launch admitted 61 minutes ago drops. An admitted launch 3 hours old stays. A trip opened yesterday and closed 2 hours ago drops. A trip opened today stays. An owner-closed trip from yesterday closed 30 minutes ago stays. An open trip from last week stays. |
| `an oversized baseline is unreadable` | A file with 5,001 launches reads as undefined. |

- [ ] **Steps 2 to 5** as in Task 1, with `tests/fuse-baseline.test.ts`.

### Task 3: FuseService and the configuration

**Files:** `packages/host/src/fuse/service.ts`, `packages/host/src/config.ts`, `tests/fuse-service.test.ts`. **Needs:** Task 2.

**Interfaces (produces):**

```ts
export type FuseServiceOptions = { config: Config; key: Buffer; store: EvidenceStore; sessionExists(sessionId: string): boolean; now?: () => number };
export type FuseScopeView = { state: "open" | "closed"; trip?: { tripId?: string; cause: FuseCause; window?: FuseWindow; openedAt?: string; ownerClose: boolean };
  hour: { launches: number; limit: number } };                       // slice 3 adds day and week
export type FuseView = { authoritative: boolean; host: FuseScopeView; projects: (FuseScopeView & { projectId: string })[] };
export type FuseInterrupt = { tripId: string; scope: FuseScope; projectId?: string; label: string; cause: FuseCause; ownerClose: boolean; openedAt: string };
export class FuseService implements FuseGate {
  constructor(options: FuseServiceOptions);   // registers the module and loads the baseline
  check(input: { projectId: string; role?: LaunchRole }): FuseCheck;
  admit(launch: FuseLaunch): FuseAdmission;
  release(launchId: string): void;
  started(launchId: string): void;
  close(input: { scope: "host" } | { scope: "project"; projectId: string }): "closed" | "not-open" | "unmeasurable" | "write-failed";
  view(): FuseView;
  interrupts(): FuseInterrupt[];
  markAnnounced(tripIds: readonly string[]): void;
  tick(): boolean;    // retries the load while no baseline is authoritative, prunes the store; true when authoritative
  start(): void;      // a 60-second unref'd timer that runs tick
  stop(): void;
}
// config.ts, top level, no schema default anywhere inside:
autonomy?: { fuse?: { project?: Ceilings; host?: Ceilings; projects?: Record<string, Ceilings> } };
type Ceilings = { launchesPerHour?: number };   // an integer from 1 to 1,000; slice 3 adds day and week
```

**Decisions:**

- **One clock.** `options.now`, default `Date.now`, is the only time source for every fuse rule, including the per-day interrupt rule. Callers never pass a time. Tests inject a fake clock. Nothing else switches behaviour.
- **Evidence module** `fuse`, version 1. `fuse_launches (launch_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, purpose TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, admitted_at INTEGER NOT NULL, seq INTEGER NOT NULL, sealed TEXT NOT NULL)` with an index on `admitted_at`. `fuse_trips (trip_id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_key TEXT, cause TEXT NOT NULL, fuse_window TEXT, opened_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT, owner_close INTEGER NOT NULL, announced_at INTEGER, seq INTEGER NOT NULL, sealed TEXT NOT NULL)`. `project_key` is `tx.index("project", projectId)`. `sealed` holds the project id, the profile id, the assignment, and the trip's launch count. Parameters are plain values. `counts` reports `launches`, `trips`, and `openTrips`. There are no run hooks: launch rows go after 48 hours and trip rows after 30 days, pruned by `tick`. *(My call: 30 days, the digest's retention.)* `fuse_sessions` and the grant columns arrive with slice 3.
- **Load.** The service reads the file first and the store second. The store is readable when it and the `fuse` module are `ready` and the read succeeds. `mergeBaselines` decides. Then every `admitted` launch becomes `started` when `sessionExists` is true and `released` otherwise, and the service writes the file. An error from `sessionExists` counts as true. With no authoritative baseline, the service holds one `unmeasurable` host trip in memory and writes nothing, neither the file nor the store, until `tick` loads one. That trip then closes with `closedBy: "baseline"`.
- **Every write** builds the next baseline as a copy, raises `seq`, writes the file, and only then replaces the copy in memory. It then mirrors the changed rows with `store.tryWrite`. A failed mirror is tolerated, and a restart merges by union. A failed file write changes nothing in memory.
- **`check`** reads memory only. It returns `{ state: "closed", exempt: true }` for an exempt role. Otherwise it returns `fuseCheck` for the project with the configured limits.
- **`admit`.** An exempt role returns `{ ok: true, exempt: true }` and writes nothing. A recorded `admitted` or `started` id returns `{ ok: true, repeat: true }` and writes nothing, whatever the fuse state. Otherwise an open check returns `{ ok: false, open }`, and the write records a pending trip when there is one. A closed check writes the launch, keeping the original `admittedAt` of a `released` id while that time is inside the rolling hour, so the count does not rise. A released launch from before the hour is charged at `now`. *(Review round 1: memory is pruned only at a write, so after an idle hour a retry kept its old time, started a session, and counted in no hour.)* That one write does three things in this order. First it closes with `closedBy: "rate"` every open rate trip without `ownerClose` of the host scope and of the project's scope: the closed check judged those scopes closed before the launch counted. *(Decided during the build: judged after the launch counts, a trip at 14 of 30 is let through, found open again at 15, and never closes.)* Then it adds the launch. Then it records a new trip for each scope whose count reached its limit. A failed file write returns `failure: "write-failed"`.
- `release` turns `admitted` into `released`. `started` turns `admitted` into `started`. Any other state or an unknown id is a no-op with no write.
- **`close`** closes every open launch-rate trip of the scope with `closedBy: "owner"`. In the same write it sets the `admittedAt` of that scope's launches that lie after `now` to `now`, so the owner's close always clears the count. *(Local review: a launch stamped after `now` still counts, by the rolling-count rule, and after a clock that stepped back the owner's close time lay before every counted launch, so the count stayed at the limit and the next admission opened a new owner-close trip.)* It never closes `unmeasurable`. A scope can be open with no recorded trip, because every caller stops at `check`: after a lowered limit, or after a clock that stepped back over an earlier close. `close` then records a trip that is opened and closed by the owner in one write, so the owner can always clear an open scope. *(Local review, third pass.)* With the scope closed it returns `not-open`. Without an authoritative baseline it returns `unmeasurable`.
- **Interrupts.** `interrupts()` returns open trips without `announcedAt`. A trip that closes by itself is held back when its subject (the project id or `host`) already had a trip announced in `utcDay(now)`: that is the spec's one push per reason and subject per UTC day. A trip that only the owner or a readable baseline can end is never held back: an `ownerClose` trip and the `unmeasurable` trip are always offered, because the spec sends one push whenever such a trip opens (section on interrupts: "A trip that only an owner action resolves always sends one push when it opens"). *(Local review: the first version held back every second trip of a day, so the second rate trip, which stops every launch of its scope until the owner acts, sent no push until the next UTC day.)* A failing baseline write is offered too, as an interrupt with cause `write-failed`, once per UTC day while the last write failed. *(Local review: with a failing write every admission is refused and the view still said closed, with no notice.)* `label` is the configured project name, read when the interrupt is built, or `the host`. The name is made one line of at most 80 characters with no control character, because it goes into a push body and the configuration sets no rule for it. *(Review round 1.)* `markAnnounced` stamps `announcedAt` with one write, and stamps memory for the two interrupts that have no stored trip. When that write fails, the stamp is kept in memory. *(Local review, second pass: without it the notifier sent an unannounced trip again on every tick, every two seconds, for as long as writes failed.)*
- **A failing write is visible.** The service remembers the time of its last failed baseline write and forgets it at the next successful one. While it is set, `tick` writes the baseline as it is, so the report ends as soon as the host can write again, with or without a new launch. `view()` reports it as `writeFailedAt`, and `interrupts()` offers one host interrupt with cause `write-failed`, once per UTC day while it lasts.
- **Projects are read when asked.** `view()` and the interrupt label read `config.projects` at call time, because the host adds mirrored projects while it runs.
- **The store keeps no trip the baseline dropped.** With an authoritative baseline, `tick` deletes a trip row whose `opened_at` is over 30 days old unless that trip is open in memory, whatever its `closed_at` says, so a row that a failed mirror left open does not stay for good. A load that read the file also mirrors every trip of the merge, so such a row is brought up to date at the next restart.
- **Limits.** `projects[id]`, then `project`, then 30 per project. `host`, then 80. A `projects` key that names no configured project fails config validation. *(My call: an override for a typo must not look applied.)*
- **Store outage during a run.** The service keeps counting in memory and in the file, and `admit` accepts within the limits. *(My call: the spec's 30-minute `unmeasurable` rule arrives with slice 3, because this slice reads nothing from the store during a run that it lacks in memory.)*

- [ ] **Step 1: Write the failing tests** in `tests/fuse-service.test.ts`. Each test builds an `EvidenceStore` in a fresh temporary directory with a 32-byte key, a fake clock at `2026-11-13T10:00:00.000Z`, and `sessionExists` from a set.

| Test name | Assertions |
|---|---|
| `check writes nothing and admit charges a launch once` | Ten checks leave the baseline file bytes unchanged. `admit(A)` is ok and the file's `seq` rises by 1. `admit(A)` again is ok with `repeat`, and the file bytes are unchanged. `view()` shows 1 launch for the project and for the host. |
| `the 31st launch in an hour waits` | 30 admits in project `p`, 10 seconds apart, are ok, and the 30th records one trip. `check(p)` is open, `launch-rate`, `ownerClose` false. The 31st admit is refused with that trip. `check(q)` is closed. `interrupts()` returns one entry, and none after `markAnnounced`. At 14 counted launches, `check(p)` is closed. The next admit is ok and the trip has `closedBy: "rate"`. Reaching 30 again that day opens a trip with `ownerClose` true. It is still open two hours later. `close({ scope: "project", projectId: "p" })` returns `closed`, and the next admit is ok. |
| `an admission closes every open rate trip that its scope no longer holds` | A baseline file with two open rate trips without `ownerClose` in project `p`, one open `ownerClose` trip in project `q`, and no launches. `admit` for `p` is ok and both of `p`'s trips have `closedBy: "rate"`. `check(q)` is still open. |
| `a trip that needs the owner always sends its push` | With a project limit of 2: after the first trip of `p` is announced and closes by rate, the second trip that day (`ownerClose`) is in `interrupts()` at once, with its trip id. |
| `an owner close clears launches stamped after it` | 30 admits in `p`, then the clock steps back 90 minutes. `close` returns `closed`, `check(p)` is closed, and the next admit is ok with no new trip. |
| `a failed write is visible and sends one interrupt` | With the baseline path replaced by a directory, a refused `admit` leaves `view().writeFailedAt` set and one `write-failed` interrupt, and none after `markAnnounced`. With the path restored, the next admit clears `writeFailedAt`. |
| `a restart does not bring back a trip the file dropped` | The owner closes trip T while store writes fail. A day later the file has pruned T. A new service on the same directory and store has no open trip, and `check(p)` is closed. |
| `a project added while the host runs is in the view` | A project pushed onto `config.projects` after construction appears in `view().projects` with the default limit. |
| `the owner can close a scope that is open without a recorded trip` | Four launches under a limit of 5, then a restart with a limit of 2: `check(p)` is open with no `tripId`. `close` returns `closed`, `check(p)` is closed, and a second `close` returns `not-open`. The next trip that day has `ownerClose` true. |
| `a failed write does not repeat a trip's push` | With an unannounced trip and a baseline path replaced by a directory, `markAnnounced` leaves the trip out of `interrupts()`. The only interrupt left is `write-failed`, and none after it is marked. |
| `a write failure clears when the host can write again` | After a refused admission, `tick` keeps `writeFailedAt` while the path is a directory. With the path restored and no new launch, the next `tick` clears it and the baseline file is readable. |
| `a restart heals a store row that a failed mirror left open` | The owner closes a trip while store writes fail. After a restart, the store row has `closed_by` `owner`. |
| `the host limit spans projects` | With `project.launchesPerHour` 50, 27, 27, and 26 launches in `a`, `b`, and `c` open the host fuse, and `check(d)` is open with scope `host`. |
| `the permission coordinator is exempt` | With `p` open, `check` with that role is closed and exempt. 50 exempt admits leave the file bytes and the counts unchanged. The same holds while `unmeasurable`. |
| `a launch that never starts is released and keeps its count` | `admit(A)`, `release(A)`: state `released`, count 1. `admit(A)` is ok, and the count stays 1. With `p` open, `release(A)` then `admit(A)` is refused. After `admit(B)` and `started(B)`, `release(B)` changes nothing. `release` of an unknown id writes nothing. |
| `a released launch retried after its hour counts again` | `admit(A)`, `release(A)`, an idle hour, `tick`: the count is 0. `admit(A)` is ok and the count is 1 for the project and the host. A release and a retry a minute later leave the count at 1. |
| `a project name is cleaned and bounded in an interrupt` | A project name with a line break, an escape sequence, a line separator, and 300 more characters gives a label with no control character and at most 80 characters. |
| `failed baseline writes leave no temporary files` | Five refused admissions and one `tick` with the baseline path replaced by a directory leave no `.tmp` file in the state directory. |
| `a failed baseline write refuses and changes nothing` | With the baseline path replaced by a directory, `admit` returns `failure: "write-failed"`, and the count and `check` are unchanged. |
| `a restart merges the file and the store` | A second service on the same state directory and store sees 2 launches after A and B. With the file deleted it sees 2 from the store. With the file overwritten by a seal under another key it sees 2, and the next admit leaves a readable file. |
| `a cold start releases launches that never started` | Admitted A has a session and admitted B has none. After a restart A is `started`, B is `released`, and the count is 2. |
| `no authoritative baseline opens the fuse as unmeasurable` | No file and a store opened with the wrong key: `check` is open, scope `host`, cause `unmeasurable`. `admit` is refused. `interrupts()` has one entry. No baseline file exists afterwards. `close` returns `unmeasurable`. With a readable file and that store, admits pass until the 31st. After a valid file appears, `tick()` is true, `check` is closed, and the trip closed with `closedBy: "baseline"`. |
| `the configuration sets the limits and adds no key` | A config without `autonomy` parses without the key and gives limits 30 and 80. `projects: { p: { launchesPerHour: 5 } }` gives 5 for `p`. 0, 1,001, an unknown key, and an unknown project id are refused. |
| `the module counts and prunes its rows` | `describe().counts` has `fuse.launches` 2 and `fuse.trips` 1. After 49 hours, `tick()` leaves `fuse.launches` 0. |

- [ ] **Steps 2 to 5** as in Task 1, with `tests/fuse-service.test.ts`.

### Task 4: goal, routine, and mission call sites

**Files:** `packages/host/src/goals.ts`, `routines.ts`, `missions.ts`, `tests/fuse-callers.test.ts`. **Needs:** Task 1. It can run in parallel with Tasks 2 and 3.

**Interfaces (produces):** `useFuse(fuse: FuseGate): void` on `GoalService`, `RoutineService`, and `MissionService`, as `TeamService.useEvidence` is set. *(My call: a setter, so no constructor changes, and every existing test builds these services unchanged.)*

**Decisions:**

- **`GoalService.step`**: `applyFuseReason(goal, this.fuse?.check({ projectId: goal.projectId }))` goes immediately after `if (!trackingReady) return;` and before `const parent = ...`, so before `stored.launch` is prepared. A wait keeps `goal.status` `running` and records one goal event when the reason changes. It saves only when the reason changes. A prepared `stored.launch` replays without a check, because the cycle's members wait at their own launch.
- **`RoutineService.step`**: the same check goes after the approval-window budget check and before `isProjectBusy`. A wait keeps `status`, `nextRunAt`, and `revision`. So the first tick after the fuse closes starts one goal, and missed intervals coalesce. *(My call.)* The `stored.launch` replay is not checked.
- **`MissionService.launch`**: when `!this.launched(attempt)`, it calls `check` and then `admit(workLaunch({ launchId: attempt.sessionId, projectId: mission.repoProjectIds[0], provider, team: this.assignment(stored, attempt), profile: mission.lineup.coordinator }))` immediately before `createTeamSession`. A wait sets `mission.reason`, records one event when it changes, keeps the attempt `queued`, and returns. Its `catch` calls `this.fuse?.release(attempt.sessionId)` first, and returns on a `TeamError` with code `fuse-open` as it does on the session limit. *(My call: a mission is charged to its first repository's project, the `projectId` its `CreateSession` already carries.)*

- [ ] **Step 1: Write the failing tests** in `tests/fuse-callers.test.ts`, with a stub `FuseGate` that records its calls and returns set results.

| Test name | Assertions |
|---|---|
| `a goal waits at check before it prepares a cycle` | With the goal built as `tests/goals.test.ts` builds one and the stub open: `step` prepares no launch, `createForGoal` is not called, the status is `running`, and the reason is the fuse reason with one event. A second `step` adds no event and leaves `goal.reason` unchanged. (`step` saves the record on every pass already, so the test does not compare record bytes.) With the stub closed, the reason clears and a cycle starts. Without `useFuse`, the first `step` starts a cycle. |
| `a routine waits at check and keeps its schedule` | With a due routine and the stub open: `startGoal` and `isProjectBusy` are not called, and `status`, `nextRunAt`, and `revision` are unchanged. With the stub closed, `startGoal` is called once and the reason clears. |
| `a mission coordinator waits at check and at admit` | With the service built as `tests/missions.test.ts` builds it: check open, then check closed with admit refused, each leave `createTeamSession` uncalled, the attempt `queued`, and one event. When both pass, `admit` receives the attempt's session id, the first project, role `mission-coordinator`, purpose `work`, and the coordinator profile id. A session-limit error from `createTeamSession` calls `release` with the attempt's session id. |

- [ ] **Steps 2 to 5** as in Task 1, with `tests/fuse-callers.test.ts`.

### Task 5: the team member launch and the Manager backstop

**Files:** `packages/host/src/teams.ts`, `packages/host/src/manager.ts`, `tests/fuse-launch.test.ts`. **Needs:** Task 3. Other work changes `teams.ts` now, so the change there is one field, one setter, and two call sites, all inside `launch`.

**Interfaces (produces):** `TeamService.useFuse(fuse: FuseGate)` and `Manager.useFuse(fuse: FuseGate)`. The backstop throws `TeamError(409, "fuse-open", fuseReason(open))`.

**Decisions:**

- **Call site 1, `TeamService.launch`**: immediately before the session slot check (the `manager.list()` line), after `assertBudget`, `assertRunPath`, and the Linear tracking block. Inside `if (this.fuse && !this.hasLaunch(member))`, so a service without a fuse runs no new line: `applyFuseReason(stored.run, this.fuse?.check({ projectId: stored.run.projectId, role: member.role }))`, save when changed, and return on wait. The run keeps its status. The member stays `queued`. The next pass checks again. *(Code fact: a Linear block that may return sits between `assertBudget` and the slot check.)*
- **Call site 2, `TeamService.launch`**: immediately before the `try` that calls `createTeamSession`, after the delivery checks and `writeTeamContext`. Inside `if (!this.hasLaunch(member))`: `admit(workLaunch({ launchId: member.sessionId, projectId: stored.run.projectId, provider: request.provider, team: assignment(member), profile: member.modelProfile }))`, with the same wait handling. The existing `catch` first calls `this.fuse?.release(member.sessionId)`, then keeps the session-limit wait, then treats a `TeamError` with code `fuse-open` as a wait with `run.reason` set to its message. It rethrows nothing new.
- A member whose session exists skips both calls, so a replay is never a new launch.
- **A reason that reports a member's state stays.** When `run.reason` is the runtime-unavailable, permission-review, or provider-input text, a fuse wait still holds the launch and leaves the reason alone. *(Local review: the scheduler sets those texts from each running member on every pass. With a queued member behind an open fuse, the two writers replaced each other's text each pass, with one more sealed write per pass.)*
- **Backstop, `Manager.createOnce`**: when `request.team` is set and a fuse is set, it calls `admit(workLaunch({ launchId: request.requestId, projectId: request.projectId, provider: request.provider, team: request.team, profile: request.teamModelProfile }))` immediately after the `maxSessions` check and before the handoff check. The replay check returns earlier, so a replayed session is never charged. A refusal throws `fuse-open` before any session directory exists. The former body of `createOnce` is now `createRecorded`, unchanged except for that block and one line: right after the `writeSealed` of `meta.sealed` it calls `started`. `createOnce` is a small wrapper that calls `createRecorded` and, when a team request fails, calls `release` and rethrows. *(Decided during the build: a `try` around the body from the backstop to the `writeSealed` moved seventy lines. The wrapper also releases on a failure before the backstop, which is right: that launch did not start, and `release` leaves a started launch and an unknown id alone.)* A throw from `release` or `started` is swallowed, so fuse bookkeeping never fails or hides a session start. Owner sessions (`request.team` absent) are never charged.

- [ ] **Step 1: Write the failing tests** in `tests/fuse-launch.test.ts`, with a real `FuseService` and `schedulerFixture()` plus one queued implementer, stepped with `step(record(id))` as `tests/teams.test.ts` does.

| Test name | Assertions |
|---|---|
| `ten passes with capacity full leave the baseline unchanged` | `manager.list` returns four `running` rows. Ten passes launch nothing, and the baseline file bytes are equal before and after. With `list` returning `[]`, one pass makes one launch, and the view shows 1 launch. One more pass adds no launch, and the count stays 1. |
| `a member's state keeps the reason while the fuse holds a launch` | A running coordinator waits at a provider question, a queued implementer waits behind an open fuse, and `run.reason` is the provider-input text. Ten passes launch nothing, the fuse saves nothing, the reason is unchanged, and the implementer is still `queued`. |
| `ten passes with the fuse open change only the reason` | With `p` tripped by 30 other launch ids, ten passes launch nothing. The run status is unchanged, the member is `queued`, `run.reason` is the fuse reason, and the baseline bytes are unchanged. After `close`, the next pass launches and `run.reason` is no longer a fuse reason. |
| `a capacity race releases and the retry counts once` | The fixture's `createTeamSession` throws `The configured session limit has been reached` once. The launch is `released`, the count is 1, and the reason is the slot wait. The next pass launches, and the count stays 1. |
| `without a fuse the launch and the record are as today` | Without `useFuse`, one pass launches. With a fuse under its limit, one pass launches. The sealed run records of both have the same keys for the run and for the member. |
| `the backstop recognises an admitted launch and counts one that skipped admit` | A real `Manager` with `agents: {}`: for an id admitted first, `createTeamSession` rejects with `Provider is not configured on this host`, the count is 1, and the launch is `released`. For a new id, the same error, and the count is 2. |
| `the backstop refuses while open and passes the permission coordinator` | With `p` open, `createTeamSession` rejects with code `fuse-open`, the message is a fuse reason, and no `sessions/ID` directory exists. With role `permission-coordinator`, it rejects with `Provider is not configured on this host` instead. |
| `createOnce marks a created session started` (host-run) | With the demo agent of `tests/fixtures/team-agent.mjs`, the launch is `started` after `createTeamSession` resolves, and `release` leaves it `started`. With the fuse then open, a replay of the same request returns the session and the count is unchanged. The test stops the session. |

- [ ] **Steps 2 to 5** as in Task 1, with `tests/fuse-launch.test.ts` and `tests/teams.test.ts`. The host-run test runs only in the host check.

### Task 6: wiring, the route, the CLI, and the interrupt

**Files:** `packages/host/src/server.ts`, `cli.ts`, `client.ts`, `notifier.ts`, `config.ts`, `docs/teams.md`, `tests/fuse-api.test.ts`, `tests/push.test.ts`, `tests/client-args.test.ts`. **Needs:** Tasks 4 and 5.

**Decisions:**

- `createApp` builds `FuseService` right after the evidence store. `sessionExists` is `manager.meta(id)`, false only on `ENOENT`. It calls `useFuse` on the manager, the team, goal, mission, and routine services, then `fuse.start()`. `closeEvidence` calls `fuse.stop()` before `evidence.close()`. `createApp` returns `fuse`, and `cli.ts` passes it to the `Notifier`.
- `GET /api/fuse` returns `fuse.view()`, with the role rules of `GET /api/usage` (any paired device). `POST /api/fuse/close`, `requireRole(["owner"])`, takes `{ scope: "host" } | { scope: "project", projectId }` (strict). It answers 404 for an unknown project, 409 for `unmeasurable`, 503 for `write-failed`, and otherwise 200 with `{ result, view }`.
- `client.ts` adds `fuse` to `CLIENT_COMMANDS`. `infinite fuse [--json]` prints `fuseLines(view)`, one line per scope, with host text cleaned as `evidenceStatusLines` does. `infinite fuse close --project ID|--host` takes exactly one of the two. `parseFuseCommand(positional, options)` is exported for tests.
- When push is on and `push.events` lacks `autonomy-interrupt`, the host prints one warning at start: a fuse trip would send no notification. *(Spec, failure modes.)*
- The push event enum and its default list gain `autonomy-interrupt`. *(My call: the default list includes it, so a trip reaches an owner who never set `push.events`.)*
- `Notifier` gains an optional last parameter, `fuse?: Pick<FuseService, "interrupts" | "markAnnounced">`. When `autonomy-interrupt` is enabled and devices exist, it sends one message per interrupt: title `Spend fuse open`, a body with the label, the cause in words, and whether it closes on its own, priority `high`, channel `attention`, `collapseId` `interrupt:fuse:<projectId or host>`, and URL `/teams`. The sender resolves even when the push service refuses a message, with one ticket per message. So the notifier calls `markAnnounced` for an interrupt only when at least one device's ticket is `ok`, and after a push that reached no device it offers fuse interrupts again a minute later, not on the next tick. *(Review round 1.)* The attention slice later moves this source behind `attention.interrupts()` and keeps the event and the collapse id.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `GET /api/fuse returns the view` (host-run, as `tests/client-cli.test.ts` starts `createApp`) | 200. `host.hour.limit` is 80, every configured project is listed, and every state is `closed`. |
| `closing a fuse is owner only` (host-run) | A non-owner device gets 403. An owner with no open trip gets 200 and `not-open`. An unknown project gets 404. With an open rate trip, the result is `closed`. |
| `fuse lines and arguments` | `fuseLines` prints `Host: closed, 3 of 80 launches in the last hour` and `Project fixture: open (launch rate, the owner must close it)`. `parseFuseCommand(["close"], { "--host": true })` targets the host, `--project p` targets `p`, and both or neither throw the usage line. `clientCommandCandidate(["fuse", "--json"])` is `fuse`. |
| `the notifier pushes one fuse interrupt` | With one interrupt and the event enabled: one message per device with `collapseId` `interrupt:fuse:p` and priority `high`, and `markAnnounced` receives the trip id. Without the event: no message and no `markAnnounced` call. |

- [ ] **Steps 2 to 4** as in Task 1, with `tests/fuse-api.test.ts`, `tests/push.test.ts`, and `tests/client-args.test.ts`.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review of the whole slice, and commits.**

**Order.** Task 1 first. Then Task 2 and Task 4 in parallel. Task 3 after Task 2. Task 5 after Task 3. Task 6 last.

## Not in this slice

- The token, list-dollar, and metered ceilings, day and week windows, reservations, the estimate, settlement, `fuse_sessions`, grants and `POST /api/fuse/grants`, the 80% warning, the highest-day figure, and the 30-minute store rule (slice 3).
- The Cost view figures and the Teams banner in the web and phone clients.
- The `attention.interrupts()` source, the digest, and the notifier suppression (slice 7).
- A finite goal's deadline keeps running while the fuse is open. The `excluded` cycle class and `fuse-open` on standing goals arrive with slice 4.
- Learning harness callers (C8), and reading `purpose` from the session header (INF-183).
