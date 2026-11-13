# Swarm Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Swarm view on the web client with Lanes, Wall, and Graph views of one live model, the Graph linked to the code context agents touched.

**Architecture:** The browser joins the session, team, and mission lists it already polls into one pure model that three renderers draw. The host adds only what the browser cannot derive: a directory-level code map carried in the graph builder's receipt, and an in-memory index of the files each agent's recorded tool inputs pointed at.

**Tech Stack:** React 19, Vite, TypeScript, `d3-force`, plain CSS; Node.js host with Express and zod; Python 3 graph builder; `node:test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-13-swarm-dashboard-design.md`. Tracked in Linear INF-190 (sub-issues INF-191 to INF-195).

## Global Constraints

- Read-only: no request in this work mutates host state.
- All web requests go through `useApi` and `useLiveRefresh`; nothing polls while the tab is hidden.
- State is carried by shape and colour together. Every mark is focusable and has an accessible name.
- No mark implies completion, approval, or merge the host did not observe. "Reported" and "merge reported" stay agent claims.
- Rows never reorder and graph nodes never move between polls when only state changes. Live order uses `createdAt`, never `updatedAt`.
- The API process never opens a graph file and no privileged command is added.
- Budgets: 120 areas, 400 code links, 256 KB map, 8 journal reads per session per request, 300 files per session, 256 indexed sessions, 60 agents and 6 project clusters in the Graph view.
- Glass is for controls only; lanes, tiles, and graph nodes are flat. Opaque fallback under `prefers-reduced-transparency`.
- No home-directory paths, real names, hosts, or keys in any tracked file. Fixtures use neutral placeholders.
- Workers share one tree: touch only the files your task owns, never revert another change, never use `git stash`, and do not commit. The coordinator commits by path.
- Verification is focused: typecheck plus the test files a task touches. One full `npm run check` runs at the end.

## Review Focus

1. A team run whose provider prompt is under delegated permission review must show "in review", never "needs you" (Task 1 test `prompt ownership`).
2. A journal dominated by terminal output must not stall the touch index or block the event loop (Task 4 test `read budget on an output-heavy journal`).
3. A builder receipt with a malformed or oversized `map` must be rejected at the boundary and leave the graph receipt usable (Task 3 test `malformed map is dropped`).
4. A tool input with a path outside the session's working directory, or with `..` segments, must never appear in a touch set (Task 4 test `path confinement`).
5. A host without missions, without repository graphs, or that predates the context endpoints must still render all three views (Task 5 test `no code map`, Task 7 harness).

## File Structure

| File | Responsibility | Owner |
| --- | --- | --- |
| `apps/web/src/swarm/types.ts` | Input, model, view, and context contracts | Task 0 |
| `apps/web/src/swarm/swarm.css` | Scoped tokens, glass, floating bars, marks | Task 0 |
| `apps/web/src/swarm/marks.tsx`, `format.ts` | State marks, role chip, compact formatters | Task 0 |
| `apps/web/src/main.tsx`, `session-navigation.tsx`, `api.ts` | Swarm route, nav item, landing view, `Me` additions | Task 0 |
| `apps/web/src/swarm/model.ts`, `approval.ts`, `activity.ts` | Pure model, prompt ownership, page-observed activity | Task 1 |
| `apps/web/src/swarm/SwarmView.tsx`, `Lanes.tsx`, `Wall.tsx`, `views.css` | Shell, vitals, legend, inspector, Lanes, Wall | Task 2 |
| `scripts/repository_graph.py`, `packages/host/src/repository-graphs.ts` | Map in the receipt, map and area lookups | Task 3 |
| `packages/host/src/context-touches.ts` | Touch extraction and incremental index | Task 4 |
| `apps/web/src/swarm/Graph.tsx`, `graph-model.ts`, `use-context.ts`, `graph.css` | Graph view | Task 5 |
| `packages/host/src/server.ts`, `remote-access.ts` | Routes, capability flag, relay allowlist | Task 6 |
| `tests/web-swarm.test.ts`, `tests/fixtures/web-swarm-*`, docs | Browser harness, screenshots, documentation | Task 7 |

---

### Task 0: Contracts and wiring (coordinator, done before fan-out)

- [x] `types.ts`, `swarm.css`, `marks.tsx`, `format.ts` written; view and model files stubbed with their final exported signatures.
- [x] `#/swarm`, `#/swarm/wall`, `#/swarm/graph` routes; Swarm nav item; the Swarm view replaces the Overview; `Me.missions` and `Me.capabilities.swarmContext` typed.
- [x] `d3-force` and `@types/d3-force` added to `@infinite/web`.
- [x] `npm run typecheck -w @infinite/web` passes.

### Task 1: Swarm model (INF-191)

**Files:**
- Modify: `apps/web/src/swarm/model.ts`, `apps/web/src/swarm/approval.ts`, `apps/web/src/swarm/activity.ts`
- Test: `tests/web-swarm-model.test.ts`

**Interfaces:**
- Consumes: every type in `apps/web/src/swarm/types.ts`.
- Produces:
  - `buildSwarm(input: SwarmInput): SwarmModel`
  - `allAgents(swarm: Swarm): Agent[]` (coordinator, then each unit's `agents` and `side`, then `loose`)
  - `findAgent(model: SwarmModel, id: string): Agent | undefined`, `findUnit(model: SwarmModel, id: string): Unit | undefined`
  - `approvalOwner(team, sessionId, prompt): "coordinator" | "person"`
  - `createActivity(): ActivityStore`, `ACTIVITY_BUCKETS = 30`, `ACTIVITY_BUCKET_MS = 10_000`

Rules the signatures do not determine:

- **Prompt ownership** must equal the phone's rule (`apps/mobile/src/features/teams/model.ts`, `approvalOwner`): the latest permission decision for the session and prompt ID decides when present (`pending`, `reviewing`, `approved`, `answering` mean coordinator, anything else person); otherwise the coordinator owns it only when the run has `permissions`, no `permissionsRevokedAt`, fewer decisions than `maxDecisions`, a `strong` lineup coordinator, and the prompt is `delegable`, of kind `permission`, not `destructive`, and not `multiSelect`.
- **Roles:** `project-manager` PM on plan, `scout` SC on scout, `implementer` IM on build, `integrator` IN on integrate, `reviewer` RV on review, `delivery` DL on ship, `permission-coordinator` PR in `unit.side`. Other roles are skipped.
- **Members shown:** `revision === team.revision`, or status `running` or `waiting` (then `earlier: true`). A unit that is not live has empty `agents` and `side`.
- **Agent fields:** `id` member ID; `provider` member's or the team's; `model` profile label; `tool` from `attention.lastTool.tool`; `lastActivityAt` from attention, else the member; `since` from `attention.since`; `costUsd` from `usage.cost`; `observable` is true for `claude` and `codex` only; `limited` from `pendingLimit` or an attention limit; `stalled` from `stalledAt`; `projectId` the unit's.
- **State table:** as in the spec's Swarm model section, in that row order.
- **Live:** status is a working status, `needs-input`, or `paused`, or any shown member maps to queued, working, waiting, in-review, or needs-you.
- **Hold and terminal:** `needs-input` input, `paused` paused, `blocked` blocked; `ready-for-review` review-ready, `merged` merge-reported, `no-change` no-change, `cancelled` cancelled.
- **Stages:** `active` and `reached` as in the spec, from current-revision evidence only.
- **Checks:** counts of current-revision checks by `passed`, `failed`, `running`; `interrupted` is not counted.
- **Unit waiting:** open decisions of the current revision, zero when `missionId` is set.
- **Mission swarm:** units are its teams in subtask order; `dependsOn` maps subtask dependencies to team IDs; subtasks without a team and with status `queued` or `blocked` become ghosts whose `after` lists the titles of their dependencies; the coordinator agent has role MC, ID and `sessionId` from the coordinator session, state stopped when its status is `stopped`, else needs-you, working, or waiting from attention. Live while the coordinator is not stopped or any unit is live. A team whose mission is absent is its own swarm.
- **Solo swarm:** ID and title `solo`; sessions with status `running` or `starting`, not archived, without `managedBy`, and not a session of any member or coordinator. State: `starting` queued, else needs-you, working, fault, or waiting from attention. Omitted when empty.
- **Swarm waiting:** needs-you agents plus unit waiting plus open mission decisions.
- **Order:** live swarms with `waiting > 0` first, then the rest; inside each group `createdAt` descending with the ID as tie-break; solo last. Quiet swarms by `updatedAt` descending, those updated within 72 hours, at most 12; `quietOlder` counts the rest.
- **Totals:** over live swarms only. `costUsd` uses the mission's or team's `usage.total.cost`.
- **Activity:** `record` adds one to the bucket at `floor(now / 10_000)` for an agent whose `lastActivityAt` differs from the value last seen; a first sighting adds nothing. `buckets` returns 30 values, oldest first, each `min(1, count / 5)`. Agents not recorded for ten minutes are forgotten.

- [ ] **Step 1: Write the failing tests** in `tests/web-swarm-model.test.ts` with small literal fixtures (neutral names such as `checkout-v2`, `api`, `web`). One test per name:
  - `state table`: one member per row of the table yields the listed state.
  - `prompt ownership`: a `needs-you` member with a `reviewing` decision is `in-review`; with an `escalated` decision is `needs-you`; with no decision on a delegated strong run and a delegable permission prompt is `in-review`; the same prompt marked `destructive` is `needs-you`.
  - `waiting on a person`: totals count a person-owned prompt, an open decision on a standalone team, and an open mission decision; a mission-managed unit's open decision adds nothing.
  - `stages`: `active` and `reached` for each of the 14 statuses; a `blocked` run with checks reaches `check`; a steer that bumped the revision returns to `plan`.
  - `live and quiet`: a `blocked` run with all members stopped is quiet with no agents; a quiet run updated 80 hours ago is counted in `quietOlder`; 14 quiet runs yield 12 and `quietOlder` 2.
  - `stable order`: two inputs that differ only in `updatedAt` give the same live order.
  - `missions`: units in subtask order, `dependsOn` by team ID, a ghost with `after`, a team with a missing mission as its own swarm.
  - `solo`: a running session outside any team is in `solo.loose`; a member's session and a `managedBy` session are not.
  - `earlier revision`: a running member of revision 1 on a revision 2 run is shown with `earlier: true`; a stopped one is dropped.
  - `activity`: a first sighting records nothing; five advances in one bucket give 1; a bucket 31 buckets old is gone.
- [ ] **Step 2: Run** `node --import tsx --test tests/web-swarm-model.test.ts` and see the tests fail.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** the test file and `npm run typecheck -w @infinite/web`; both pass.

### Task 2: Shell, Lanes, and Wall (INF-192)

**Files:**
- Modify: `apps/web/src/swarm/SwarmView.tsx`, `apps/web/src/swarm/Lanes.tsx`, `apps/web/src/swarm/Wall.tsx`
- Create: `apps/web/src/swarm/views.css` (imported by `SwarmView.tsx`)

**Interfaces:**
- Consumes: `SwarmViewProps` (already in `SwarmView.tsx`), `ViewProps`, `buildSwarm`, `allAgents`, `findAgent`, `findUnit`, `createActivity`, `StateMark`, `RoleChip`, `agentName`, the formatters in `format.ts`, `Graph` and `GraphProps` from `./Graph`, and the classes in `swarm.css` (`sw-canvas`, `sw-top`, `sw-bottom`, `sw-glass`, `sw-capsule`, `sw-vitals`, `sw-vital`, `sw-vital-divider`, `sw-status-slot`, `sw-switch`, `sw-icon-button`, `sw-legend`, `sw-legend-item`, `sw-inspector`, `sw-inspector-fact`, `sw-inspector-links`, `sw-link`, `sw-title`, `sw-dim`, `sw-stale`).
- Produces: the same three exported components with their existing signatures. Every agent mark carries `data-agent={agent.id}`.

Decisions:

- **Feeds in `SwarmView`:** missions from `GET /missions` every 1800 ms when `me.missions?.enabled`; resources from `GET /machine/resources` every 5000 ms (read `DesktopResources.capture` in `packages/host/src/desktop.ts` for its fields). Both use `useLiveRefresh`. `now` is refreshed whenever the sessions prop changes; there is no separate timer.
- **Top bar:** vitals capsule, spacer, view switch capsule, focus icon button. Vitals slots, always rendered in this order and dimmed at zero: needs you, in review, working, waiting, queued; a divider; `slots running/limit`; cost; CPU and memory as two small horizontal meters; one `lim <provider>` flag per active `me.providerLimits` entry; the status slot, which shows the last received time, or `STALE hh:mm` when `stale`.
- **Bottom bar:** legend capsule (every state, mark plus word, and the line "activity: observed since this page opened"), then the inspector capsule. The inspector is always present; with no selection it shows a dim dash.
- **Inspector facts:** agent: role chip, model, state mark and word with elapsed time since `since`, tool, cost, task ID, and `session` and `team` links. Unit: title, status, `r<revision>`, slots, check counts, cost, `team` link.
- **Stale:** add `sw-stale` to the root when `stale`.
- **Empty:** with no live or quiet swarm, a centred dim line `no agents`, plus a `sw-link` button `start a session` when `onCreate` exists.
- **Keys:** `f` toggles focus unless the target is an input, textarea, or select; Escape clears the selection; Left and Right move focus between `[data-agent]` elements in document order.
- **Lanes:** each row is a grid `160px repeat(7, minmax(72px, 1fr)) 112px`. A header row carries the seven stage labels. Swarm header: title in `sw-title`, kind word, the coordinator mark for a mission, and at the right `n units`, `n agents`, cost. Track: a 2 px line through the stage cells, brighter up to `reached`. The `active` cell has a `--sw-raised-2` lens with a 10 px radius. Agents sit in their stage cell as 14 px marks with a 4 px gap; beyond six, five marks and `+n`. The check cell shows 8 px squares: passed filled in the working colour, failed filled in the fault colour, running outlined. A held unit shows its hold glyph in the `reached` cell; a settled unit shows its terminal glyph in the last column. Row label: unit title, and below it the project name, `r<revision>`, and `c<goalCycle>` when present. Row end: `running/limit` slots and cost. A unit with `dependsOn` shows a `↳` before its title with the tooltip `after <titles>`. A ghost row shows a queued mark and `after <titles>`. The solo swarm is one row of marks without stage columns. Quiet swarms follow under a dim `quiet` heading as one collapsed row per unit (title, glyph, age of `updatedAt`), ending with a dim `+n older` count as plain text when `quietOlder` is above zero.
- **Wall:** tiles 132 by 116 px on an auto-fill grid with a 10 px gap, grouped under a swarm header and, inside a mission, a dim unit title. Tile rows: role chip and state mark; short model and tier letter; 30 activity bars 2 px wide with a 1 px gap in an 18 px band; tool and elapsed time since `lastActivityAt`; cost. Every row keeps its height when its content is blank. Tile: `--sw-raised` fill, 14 px radius, 1 px `--sw-rule` border; selected `--sw-rule-2` border and `--sw-raised-2` fill; a needs-you tile has a 1 px `--sw-needs` border. Flags `lim`, `stall`, and `earlier` appear as dim tags beside the role chip. Order inside a group follows `AGENT_STATES`.
- **Selection:** clicking a mark or tile selects the agent; clicking a row label selects the unit; double click or Enter on an agent opens its session.
- **Titles and tooltips** state the state in words; honesty wording: `merge reported (agent report)`, `reported (agent report)`.

- [ ] **Step 1: Implement** `SwarmView.tsx` with feeds, top and bottom bars, keys, and the view switch.
- [ ] **Step 2: Implement** `Lanes.tsx` and its styles in `views.css`.
- [ ] **Step 3: Implement** `Wall.tsx` and its styles in `views.css`.
- [ ] **Step 4: Run** `npm run typecheck -w @infinite/web` and `npm run build -w @infinite/web`; both pass.

### Task 3: Code map in the receipt (INF-193)

**Files:**
- Modify: `scripts/repository_graph.py`, `packages/host/src/repository-graphs.ts`, `docs/repository-graphs.md`
- Test: `tests/repository-graph-builder.test.ts`, `tests/repository-graphs.test.ts`

**Interfaces:**
- Produces, in Python: `_code_map(graph_path: Path) -> dict[str, Any] | None`, and a `map` key (or `mapStatus: "too-large"`) on `ready` and `unchanged` receipts. No new command-line argument.
- Produces, in TypeScript:
  - `export type RepositoryCodeMap = { areas: { id: string; files: number; symbols: number }[]; links: { source: string; target: string; weight: number }[]; truncated: { areas: boolean; links: boolean } }`
  - `RepositoryGraphResult` gains `map?: RepositoryCodeMap` and `mapStatus?: "too-large"`.
  - `export type CodeMapView = ({ state: "ready"; lane: string; head: string; builtAt: string } & RepositoryCodeMap) | { state: "disabled" } | { state: "unavailable"; reason: "none-built" | "too-large" }`
  - `RepositoryGraphs.codeMap(projectId: string, lane?: string): CodeMapView`
  - `RepositoryGraphs.areas(projectId: string): ReadonlySet<string> | undefined` (shared-lane area IDs)

Rules:

- **Reduction:** nodes with a relative `source_file` and without a true `external` field. Area ID is the file's directory in POSIX form, `.` for the repository root, truncated to the largest depth that yields at most 120 areas; if depth 1 still exceeds 120, keep the 119 areas with the most symbols and fold the rest into `other`. `files` counts distinct source files and `symbols` counts nodes. A link is the count of edges whose ends lie in different areas, undirected, source sorting before target; keep the 400 heaviest, ties by source then target. `truncated.areas` is true when `other` exists and `truncated.links` when links were cut.
- **Size:** a map whose compact JSON exceeds 262144 bytes is replaced by `mapStatus: "too-large"`.
- **Failure isolation:** an unreadable or malformed graph file yields no `map` and leaves the receipt otherwise unchanged.
- **Host boundary:** the map is parsed with a strict zod schema (at most 121 areas, at most 400 links, IDs at most 300 characters, non-negative integers). A map that fails parsing is dropped and the receipt is kept.
- **`status()`** returns receipts without `map`.
- **`codeMap`:** `disabled` when the project is outside `projectIds`; otherwise the newest receipt of the requested lane that has a map, else the shared lane's, with `lane` naming the lane actually used; `too-large` when the chosen receipt says so; `none-built` otherwise. Receipt authority checks match `status()`.

- [ ] **Step 1: Write failing builder tests:** `map reduces to directory areas`, `depth is chosen to fit 120 areas`, `overflow folds into other`, `links are undirected and capped at 400`, `oversized map reports too-large`, `unchanged receipt carries the map`, and a fixture whose nodes and edges carry the real extractor's fields (`label`, `file_type`, `source_location`, `relation`, `confidence`).
- [ ] **Step 2: Write failing host tests:** `codeMap falls back to the shared lane`, `codeMap reports disabled and none-built`, `malformed map is dropped`, `status omits the map`, `areas returns shared-lane IDs`.
- [ ] **Step 3: Run** `node --import tsx --test tests/repository-graph-builder.test.ts tests/repository-graphs.test.ts` and see them fail.
- [ ] **Step 4: Implement** the builder and host changes.
- [ ] **Step 5: Run** the two test files and `npm run typecheck -w @infinite/host`; both pass.
- [ ] **Step 6: Document** the map and its bounds in `docs/repository-graphs.md`.

### Task 4: Touch index (INF-194)

**Files:**
- Create: `packages/host/src/context-touches.ts`
- Test: `tests/context-touches.test.ts`

**Interfaces:**
- Produces:
  - `export type FileTouch = { path: string; reads: number; edits: number; lastAt: string }`
  - `export type SessionTouches = { sessionId: string; observable: boolean; complete: boolean; graphQueries: number; files: FileTouch[]; truncated: boolean }`
  - `export type TouchSource = { sessionId: string; cwd: string; provider: string; projectId: string }`
  - `export type TouchPage = { events: { seq: number; at: string; type: string; data: Record<string, unknown> }[]; cursor: number; more: boolean }`
  - `export function extractTouches(tool: string, input: Record<string, unknown>, cwd: string, inArea: (directory: string) => boolean): { reads: string[]; edits: string[]; graphQuery: boolean }`
  - `export class ContextTouches { constructor(options: { read(sessionId: string, after: number): TouchPage | Promise<TouchPage>; areas(projectId: string): ReadonlySet<string> | undefined; maxReads?: number; maxSessions?: number; maxFiles?: number }); session(source: TouchSource): Promise<SessionTouches> }`
- The coordinator wires `read` to the session journal with the `signal` type filter in Task 6.

Rules:

- **Events:** only `type === "signal"` with `data.kind === "tool-start"`; `data.tool` and `data.input` are the tool name and input.
- **Observable:** providers `claude` and `codex`. For others return `observable: false`, `complete: true`, and no files, without reading.
- **File tools:** `Read` reads `input.file_path`; `Edit`, `Write`, `MultiEdit` edit `input.file_path`; `NotebookEdit` edits `input.notebook_path`.
- **`apply_patch`:** any string in the input (including inside an array) that contains `*** Begin Patch`; each `*** Add File: `, `*** Update File: `, `*** Delete File: `, and `*** Move to: ` line names an edited path.
- **Shell tools** (`Bash`, `PowerShell`, `shell`, `exec_command`, `local_shell`): the command is `input.command` (a string, or an array joined with spaces) or `input.cmd`. A token is a read only when, after stripping quotes, it matches `^[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)+$` or is an absolute path under `cwd`, its last segment has an extension of 1 to 8 letters or digits, and `inArea` is true for its directory. A command matching `(^|[\s;&|(])graphify\s+(query|path|explain)\b` sets `graphQuery`.
- **Paths:** results are repository-relative POSIX paths against `cwd`. Absolute paths outside `cwd`, any path whose normal form starts with `..`, and paths containing a NUL are dropped.
- **`inArea` for the index:** true when the directory or one of its ancestors (ending at `.`) is in `areas(projectId)`; false when `areas` is undefined.
- **Index:** per session `{ cursor, files, graphQueries, lastUsed }`. Each `session()` call makes at most `maxReads` (default 8) `read` calls, awaiting a macrotask between calls, and stops when a page has `more: false`. `complete` is true only then. Concurrent calls for one session share one advance. Keep the `maxFiles` (default 300) most recently touched files and set `truncated`. Keep `maxSessions` (default 256) sessions, evicting the least recently used. `files` is returned newest first.

- [ ] **Step 1: Write failing tests** in `tests/context-touches.test.ts` with an in-memory `read`: `file tools`, `apply_patch headers`, `shell tokens need a code area`, `graphify commands are counted`, `path confinement` (absolute outside, `../x`, NUL), `unobservable provider is not read`, `incremental cursor` (second call reads only new events), `read budget on an output-heavy journal` (pages that return no events and `more: true` end the call after 8 reads with `complete: false`), `truncation keeps the newest 300`, `session eviction`, `concurrent calls share one advance`.
- [ ] **Step 2: Run** `node --import tsx --test tests/context-touches.test.ts` and see them fail.
- [ ] **Step 3: Implement** `context-touches.ts`.
- [ ] **Step 4: Run** the test file and `npm run typecheck -w @infinite/host`; both pass.

### Task 5: Graph view (INF-195)

**Files:**
- Modify: `apps/web/src/swarm/Graph.tsx`
- Create: `apps/web/src/swarm/graph-model.ts`, `apps/web/src/swarm/use-context.ts`, `apps/web/src/swarm/graph.css` (imported by `Graph.tsx`)
- Test: `tests/web-swarm-graph.test.ts`

**Interfaces:**
- Consumes: `GraphProps`, `SwarmModel`, `Agent`, `Unit`, `CodeMap`, `SessionTouches`, `TeamTouches` from `types.ts`; `allAgents` from `model.ts`; `StateMark`; `useApi`, `ApiError` from `../api`; `useLiveRefresh`.
- Produces:
  - `GRAPH_BUDGET = { agents: 60, projects: 6, areas: 120, codeLinks: 400 }`
  - `type GraphNode = { id: string; kind: "mission" | "unit" | "agent" | "project" | "area"; side: "swarm" | "code"; label: string; agentId?: string; unitId?: string; projectId?: string; path?: string; symbols?: number; touched?: boolean; heat?: number }`
  - `type LinkKind = "member" | "dispatch" | "depends" | "planned" | "read" | "edit" | "integrated" | "code" | "contains"`
  - `type GraphLink = { id: string; source: string; target: string; kind: LinkKind; weight: number }`
  - `type GraphData = { nodes: GraphNode[]; links: GraphLink[]; dropped: { agents: number; projects: number; areas: number; codeLinks: number }; codeGraph: "on" | "partial" | "off"; unobserved: number }`
  - `buildGraph(input: { model: SwarmModel; maps: Record<string, CodeMap | undefined>; touches: Record<string, SessionTouches | undefined>; projectNames: Record<string, string> }): GraphData`
  - `areaOf(path: string, areas: ReadonlySet<string> | undefined): string`
  - `useSwarmContext(model: SwarmModel, enabled: boolean): { maps: Record<string, CodeMap | undefined>; touches: Record<string, SessionTouches | undefined> }`

Rules:

- **Node IDs:** `mission:<id>`, `unit:<id>`, `agent:<id>`, `project:<projectId>`, `area:<projectId>:<path>`. Link ID: `<kind>:<source>><target>`.
- **Swarm side:** a mission hub, a unit hub per live unit, agents linked to their unit by `member`, the permission reviewer likewise, the mission coordinator linked to the mission hub, solo agents unlinked. `dispatch` links mission to unit; `depends` links a unit to each unit in `dependsOn`.
- **Touches per agent**, kept as separate links: `planned` from the `paths` of the task whose `memberId` is the agent; `integrated` from that task's `changedPaths`; `read` and `edit` from `touches[agent.sessionId].files`, weight the count. An agent with `observable: false` (or whose touches say so) adds to `unobserved` and has no `read` or `edit` links.
- **Areas:** `areaOf` returns the longest directory prefix of the path present in the project's area set, or `.`; with no map it returns the path's directory truncated to two segments. Drawn areas are the touched ones plus, for each, the up to three heaviest neighbours in the map's links. `code` links connect drawn areas only. Each project has a `project` node linked to its drawn areas by `contains`.
- **Budgets:** beyond 60 agents drop stopped, then reported, then queued agents; beyond 6 projects keep those with the most touching agents; beyond 120 areas drop untouched neighbours first, then the least-touched; beyond 400 code links keep the heaviest. `dropped` counts each.
- **`codeGraph`:** `on` when every drawn project has a ready map, `off` when none does, `partial` otherwise.
- **`useSwarmContext`:** when `enabled`, fetch `/projects/:id/graph/map` for each project with a live unit on mount and every 60 s; `/teams/:id/context` for each live unit every 5 s; `/sessions/:id/context` for solo agents and mission coordinators every 5 s, at most 12 sessions a cycle. A 404 for a path stops further requests for that path for the life of the page. When `enabled` is false it requests nothing.
- **Layout in `Graph.tsx`:** `d3-force` with link, charge, collide, and an x force that pulls `side: "swarm"` nodes to 30% of the width and `side: "code"` nodes to 70%. Positions persist in a ref keyed by node ID and seed new simulations. The simulation restarts only when the sorted node-ID or link-ID list changes. Under `prefers-reduced-motion`, stop the simulation, run 300 ticks, and draw once.
- **Drawing:** SVG scaled to its container. Agents use the state mark shapes and colours; hubs are rings with the unit or mission title; areas are rounded squares with side `8 + 2 * sqrt(symbols)` clamped to 10 to 44 px, fill opacity rising with `heat`. Labels: hubs, project nodes, and touched areas only; others in a `<title>`. Link styles: `planned` dashed, `read` dotted, `edit` 1 px solid, `integrated` 2.5 px solid, `code` at 0.18 opacity, `member` and `dispatch` neutral. A flat legend strip inside the canvas names the four touch kinds as "observed tool inputs" for read and edit, plus `code graph off` or `+n` counts when they apply.
- **Selection:** clicking an agent selects it and dims everything but its links and areas; clicking an area sets `{ kind: "area", id }` and dims everything but the agents touching it. Every node is focusable with an accessible name.

- [ ] **Step 1: Write failing tests** in `tests/web-swarm-graph.test.ts`: `touch kinds stay separate`, `neighbours are drawn and capped at three`, `no code map` (areas from two-segment directories, `codeGraph: "off"`, no `code` links), `unobservable agent`, `one cluster per project`, `agent budget drops stopped first`, `area and link budgets`, `areaOf picks the longest prefix`.
- [ ] **Step 2: Run** `node --import tsx --test tests/web-swarm-graph.test.ts` and see them fail.
- [ ] **Step 3: Implement** `graph-model.ts`, then `use-context.ts`, then `Graph.tsx` and `graph.css`.
- [ ] **Step 4: Run** the test file, `npm run typecheck -w @infinite/web`, and `npm run build -w @infinite/web`; all pass.

### Task 6: Host routes and access (coordinator, INF-193 and INF-194)

**Files:**
- Modify: `packages/host/src/server.ts`, `packages/host/src/remote-access.ts`, `docs/teams.md`, `docs/security.md`
- Test: `tests/swarm-context-routes.test.ts`

- [ ] `GET /api/projects/:id/graph/map?lane=` (any role): 404 for an unknown project, `disabled` without `repositoryGraphs`, else `repositoryGraphs.codeMap`. `lane` accepts `shared` or `run-<uuid>`.
- [ ] `GET /api/teams/:id/context` and `GET /api/sessions/:id/context` (any role), backed by one `ContextTouches` whose `read` calls `manager.events(id, after, 200, new Set(["signal"]))` and whose `areas` calls `repositoryGraphs?.areas`. A session without a native journal answers `observable: false`.
- [ ] `/api/me` reports `capabilities.swarmContext: 1`.
- [ ] The relay allowlist admits `GET` for the three paths; tests assert each is admitted and that `POST` is refused.
- [ ] Route tests cover viewer access, the unknown project, and a team context round trip against a rehearsal session.

### Task 7: Browser harness, polish, and documentation (coordinator)

- [ ] `tests/web-swarm.test.ts` in the style of `tests/web-polling.test.ts`: fixtures with one mission of three subteams in two projects, one standalone team, two solo sessions, 40 agents, with and without a code map. Assert that the three routes render, that a second poll differing only in `updatedAt` leaves row order unchanged, that a state change leaves graph node positions unchanged, and that a hidden tab sends no Swarm requests.
- [ ] Screenshots at 1440×900 and 1000×700, plus a reduced-motion run, reviewed by eye and attached to INF-190.
- [ ] Visual polish pass against the spec's Look section.
- [ ] `docs/swarm.md`, `DESIGN.md` (instrument surface, state marks, glass controls), `PRODUCT.md`.

### Task 8: Final verification and review (coordinator)

- [ ] `npm run check` once on the integrated branch.
- [ ] One independent strong review of the combined diff with the acceptance evidence; fix findings and rerun affected checks.
- [ ] Private-information scan over the diff.
- [ ] Record outcomes in Linear and the routing ledger.

## Changes during execution

- Task 5 shipped with a layered, deterministic layout in `apps/web/src/swarm/graph-layout.ts` instead of `d3-force`; the dependency was removed. The stability rule is met by construction and pinned by `layout depends on which nodes exist, not on agent state`.
- Task 1's order rule no longer puts waiting swarms first; `stable order` pins that a swarm needing a person keeps its row.
- Task 3 keeps a lane's last good map through a failed refresh (`a failed refresh keeps the lane's last map`).
- Task 4 drops paths the recorder truncated.
- Task 5 reads the shared graph lane only.
