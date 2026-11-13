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
4. A mode change while a run is active or a cycle launch is prepared. Expect both to keep their pins, and the next run or cycle to take the new mode.
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
export interface GoalCycle { /* existing fields */; autonomy?: AutonomyMode }    // read when the cycle's launch is prepared
createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false, autonomy: AutonomyMode = "supervised"): Promise<TeamView>;
// createRun's internal parameter gains autonomy?: AutonomyMode.
// goals.ts: Stored.launch?: { request: CreateTeam; context: TeamGoalContext; autonomy?: AutonomyMode }
```

**Decisions:**

- `TeamService.createRun` pins `autonomyOf(internal)` for a goal run and `autonomyOf(project)` for every other run: standalone, mission subteam, and handoff. *(My call: a handoff run takes the project's current mode, as a standalone run does.)* One statement after the `TeamRun` literal sets `run.autonomy`. The literal's line stays as it is.
- `createRun` drops `autonomy` from `creationContext` beside `parallelismCeiling`, so the request fingerprint does not change. *(My call: the existing rule for host-derived values. A launch prepared before this slice must still find its run.)*
- A replayed request returns the stored run with its pin. A continuation or resume keeps the run's pin. *(My call.)* `createForMission`, `createForHandoff`, `view`, and every other `teams.ts` function stay unchanged.
- `GoalService.create` adds `autonomy: autonomyOf(project)` after `lineup` in the goal literal.
- `GoalService.step` sets `stored.launch.autonomy` when it prepares a cycle. The value is `supervised` when `goal.autonomy` is absent, else `autonomyOf` of the goal's project. *(My call: C12 counts a goal recorded before the contract as supervised. Its later cycles stay supervised, so work in flight keeps today's behaviour.)*
- `GoalService.launch` passes `autonomyOf(pending)` to `createForGoal` and writes it on the new cycle. The branch of `step` that records an existing run for a paused or stopped goal writes `autonomyOf(stored.launch)`.
- The cycle's mode is read once, when its launch is prepared. *(My call: a prepared launch is a started cycle, so a later change or restart applies to the next cycle.)*
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
| `a goal records its start mode and each cycle reads the project` | With overlay `autonomous`, `create()` gives `goal.autonomy` `autonomous`. The first tick calls `createForGoal` with `autonomous`, and cycle 1 has `autonomous`. After the overlay becomes `supervised` and the stub settles cycle 1 as `ready-for-review`, cycle 2 is called and recorded with `supervised`. `goal.autonomy` stays `autonomous`. |
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
