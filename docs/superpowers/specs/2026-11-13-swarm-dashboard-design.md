# Swarm dashboard: lanes, wall, and code-context graph for the web client

Date: 2026-11-13. Status: approved by the owner on 2026-11-13 and implemented on `feat/swarm-dashboard`. See "Changes during implementation" at the end.

## Intent

The phone app already shows work by project and workspace. The web client
should show the same host from the other side: the agents themselves, how they
are organised into teams and missions, what each one is doing now, and which
parts of the code they are working in.

The owner asked for a simple, technical dashboard with little text, built
around agents and swarms. The page is drawn with marks, numerals, and short
monospace codes. Sentences stay on the existing session and team pages, which
every mark links to.

## What exists today (observed in code)

- The web landing page (`apps/web/src/main.tsx`, the `overview` block) is a
  session list under a headline. Teams (`apps/web/src/teams.tsx`) is a text
  list with a long prose detail page.
- The web client has no mission view. Missions, their coordinator, and their
  subteams appear only on the phone board and in the Mac app.
- The host already serves the swarm's shape and state:
  - `GET /api/missions`: coordinator session, subtasks with `dependsOn`,
    `teamId`, and `teamStatus` (`packages/host/src/mission-types.ts`).
  - `GET /api/teams`: status, members with role, model profile, status,
    `lastActivityAt`, and usage; tasks with dependencies; checks; worker
    slots; delegated permission decisions (`TeamView` in
    `packages/host/src/team-types.ts`).
  - `GET /api/sessions`: per-session attention state, open prompt, the loud
    tool currently in flight, last activity, `managedBy`.
  - `GET /api/machine/resources`: CPU, memory, swap, network.
- The host builds a Graphify code graph per project and per team run
  (`packages/host/src/repository-graphs.ts`, `docs/repository-graphs.md`) and
  hands its path to team members. It serves only build receipts at
  `GET /api/projects/:id/graph`, to owners. No endpoint serves graph content.
- On the reference deployment the API process cannot read graph files. The
  builder runs as the agent user under a private umask
  (`deploy/ubuntu/repository-graph-wrapper.py`), and the host only reads the
  JSON receipt the builder prints.
- Each session journal records `tool-start` signals with the tool name and its
  truncated input for Claude Code and Codex (`packages/attention/src`). Other
  providers record an empty input.
- `readEvents` (`packages/host/src/vault.ts`) decrypts every event it passes
  and stops after 200 events or 512 KiB scanned, so a signals-only read can
  return `more: true` with no events.
- The phone already separates a provider prompt the coordinator is deciding
  from one that waits on a person (`approvalOwner` in
  `apps/mobile/src/features/teams/model.ts`).

## Goals

1. One glance answers: how many agents, in which state, in which swarm, and
   which ones wait on a person.
2. Three views of one live model, switched without refetching: **Lanes**,
   **Wall**, and **Graph**.
3. The Graph view connects agents to the code context they use, drawn on the
   Graphify graph the host already builds.
4. Read-only. Every mark opens the existing session or team page.
5. The page works with whatever a host reports. A host without missions or
   without repository graphs still gets a correct, smaller picture.

## Non-goals

- Controls of any kind: no pause, steer, answer, or cancel. The owner steers
  through the coordinator on the existing pages.
- A roll-up across machines. The view shows the active machine.
- History, replay, or a timeline.
- Phone or Mac changes.
- A symbol-level code graph. The map stops at directories.
- Any change to how agents receive or use graphs.
- New persisted host state.
- Grouping successive goal cycles into one swarm. Each run is its own swarm
  and carries a goal tag.

## Anti-goals

These make the dashboard a failure even if it works:

- A mark that implies completion, approval, or merge that the host did not
  observe. `PRODUCT.md` honesty rules apply to glyphs as much as to words.
- Counting a prompt the permission reviewer is handling as waiting on a
  person.
- Colour as the only carrier of state.
- Layout that shifts when a state changes, a list that reorders between
  polls, or a graph that reshuffles on each poll.
- Prose returning to the canvas.
- Request volume that grows while the tab is hidden.

## Constraints

- Web stack as it is: React 19, Vite, hash routes
  (`apps/web/src/session-navigation.tsx`), polling through `useLiveRefresh`
  (`apps/web/src/live-refresh.ts`), no state library.
- `DESIGN.md` rules hold. "State With Words" is met by an always-visible
  legend, an accessible name on every mark, and a tooltip that states the
  state in words.
- All three device roles may view. Nothing here mutates.
- The API process must not open graph files, and no new privileged command is
  added to the deployment.
- The map exposes repository-relative directory names and counts only, which is
  the exposure the project file listing already has. No source text.
- Fixtures and screenshots use neutral placeholder names and paths.

## Approaches

**A. One swarm model in the web client, three renderers; new read endpoints
only for what the browser cannot derive (picked).** The browser joins the three
existing lists into a swarm model. The host adds a reduced code map and
per-agent touch sets. Smallest contract change, fast iteration on the picture.

**B. A host `/api/swarm` aggregate that precomputes the model.** Other clients
could reuse it and the browser makes one request. It adds a host contract and
tests for a join the browser can do from data it already polls, and no other
client needs it yet. Revisit if the phone or Mac wants the same view.

**C. Embed Graphify's own HTML visualisation for the context graph.** No layout
code. The host builds graphs with visualisation and clustering turned off, the
symbol-level graph has thousands of nodes, the API process cannot read the
files, and agents and live state cannot be drawn on it.

The owner chose all three views and asked for the Graph view to use the
Graphify context graph. How it is built was left to the builder; A is the
builder's pick.

## Design

### Shell and routes

- A **Swarm** item leads the workspace navigation. Routes: `#/swarm` (Lanes),
  `#/swarm/wall`, `#/swarm/graph`, with the machine prefix other routes use.
- The Swarm view replaces the `overview` block, so it is what a desktop-width
  window shows at the root route. At phone width the root keeps the session
  list first, as today.
- The sidebar rail keeps the session picker. A focus toggle (button and the
  `f` key) hides the sidebar for wallboard use.
- The page has four fixed regions, top to bottom: vitals strip, view switch
  with legend, canvas, inspector. Regions keep their size while content
  changes.

```
┌ vitals ───────────────────────────────────────────────────────────┐
│ ● 9  ◐ 4  ◉ 1  ◌ 3   slots 7/12   $6.42   cpu ▂▅▇  mem ▅  14:02 │
├ [Lanes] [Wall] [Graph]        ● working ◐ waiting ◉ needs you ... ┤
│                                                                   │
│                            canvas                                 │
│                                                                   │
├ inspector ────────────────────────────────────────────────────────┤
│ IM · sonnet · working 42s · Edit · $0.31 · task api-routes   ↗ ↗ │
└───────────────────────────────────────────────────────────────────┘
```

### Data

All requests go through the existing `useApi` and `useLiveRefresh`, so they
stop while the tab is hidden or offline.

| Feed | Request | Interval | When |
| --- | --- | --- | --- |
| Sessions | `GET /sessions` | 1.8 s | already polled by the app |
| Teams | `GET /teams` | 1.8 s | already polled by the app |
| Missions | `GET /missions` | 1.8 s | Swarm view open and `me.missions.enabled` |
| Resources | `GET /machine/resources` | 5 s | Swarm view open |
| Code map | `GET /projects/:id/graph/map` | on open, then every 60 s | Graph view, one per project with a live unit |
| Team touches | `GET /teams/:id/context` | 5 s | Graph view, one per live unit |
| Session touches | `GET /sessions/:id/context` | 5 s | Graph view, solo sessions and mission coordinators |

The view is fresh only when the sessions and teams feeds are fresh. After the
existing three-second stale delay the canvas dims and the status slot in the
vitals strip reads `STALE` with the last received time. The slot is always
present, so nothing moves.

### Swarm model

A pure module, `apps/web/src/swarm/model.ts`, turns sessions, teams, and
missions into the model all three views render. It has no DOM or CSS imports so
`node:test` can load it directly.

- **Swarm**: a mission (coordinator plus subteams), a standalone team run, or
  the synthetic `solo` swarm holding running sessions that belong to no team.
- **Unit**: one team run. A team with `missionId` is a unit of that mission's
  swarm. If the mission is absent from the list it stands as its own swarm.
- **Agent**: one team member, mission coordinator, or solo session.

**Live and quiet.** A unit is live when its status is one of the seven working
statuses, `needs-input`, or `paused`, or when any of its agents is queued,
working, waiting, in review, or needs a person. Every other unit is quiet:
`blocked`, `ready-for-review`, `merged`, `no-change`, and `cancelled` runs
whose agents have all stopped. A mission swarm is live while its coordinator
runs or any of its units is live.

- Live units are drawn in full. Members shown are those of the current
  revision, plus any member of an earlier revision that is still `running` or
  `waiting` (flagged as earlier).
- Quiet units are drawn as one collapsed row each, with their hold or terminal
  glyph and no agents, in a quiet group below the live ones. The group holds
  runs updated in the last 72 hours, newest first, at most 12, and ends with a
  `+n` count that opens the Teams page.
- Vitals count agents of live units only.

**Order.** Live swarms are ordered by `createdAt`, newest first, with the solo
group last, followed by the quiet group. Order never depends on state: a swarm
that starts waiting on a person keeps its row, and its marks and the vitals
carry that. `updatedAt` is not used for live runs because the host rewrites it
on every monitor pass, which would reorder rows between polls.

**Agent state** comes from the member status, the session attention state, and
who owns an open prompt:

| Member status | Attention state | Shown as |
| --- | --- | --- |
| `queued` | any | queued |
| `running` or `waiting` | `needs-you`, prompt owned by a person | needs you |
| `running` or `waiting` | `needs-you`, prompt owned by the coordinator | in review |
| `running` | `working` | working |
| `running` | `turn-finished`, `idle` | waiting |
| `waiting` | any other | waiting |
| `reported` | any | reported |
| `stopped` | any | stopped |
| `unavailable` | any | fault |
| any | `recording-error`, `unavailable` | fault |

- Prompt ownership follows the phone's `approvalOwner` rule exactly. The rule
  moves to a module both clients can import, or is copied with the same tests;
  the two must not drift.
- A running member whose session is missing from the list uses its member
  status alone.
- `pendingLimit` or an attention limit adds a limit flag; `stalledAt` adds a
  stall flag.
- "Reported" is an agent's claim and its mark must not read as success.

**Waiting on a person** is counted from three sources: agents in the needs-you
state, open decisions of the current revision on a team that no mission
manages, and open mission decisions. A unit held by a decision shows the input
glyph even when no agent has a provider prompt.

**Stages.** A unit moves through seven stages: plan, scout, build, integrate,
check, review, ship.

- `active` is the stage of the current status: `planning`, `discovering`,
  `implementing`, `integrating`, `verifying`, `reviewing`, `delivering`. It is
  empty for held and settled statuses.
- `reached` is the furthest stage with evidence in the current revision, so a
  paused or blocked run still has a position: plan once the run exists; scout
  when discovery exists; build when any task has a member or is no longer
  pending; integrate when an integrator member exists or a task is integrated;
  check when checks exist; review when a review or reviewer member exists; ship
  when a delivery member, pull request report, or delivery receipt exists.
  `reached` is never behind `active`. A steer or resume starts a new revision,
  so the lane returns to plan, which is what the run is doing.
- Roles sit on stages: project manager on plan, scout on scout, implementer on
  build, integrator on integrate, reviewer on review, delivery on ship. The
  check stage has no agent; it shows the host's check results. The permission
  reviewer and the mission coordinator are drawn beside the lane, not on a
  stage.

### Lanes view

One row per unit, grouped under its swarm. Stage columns are fixed, so every
row aligns.

```
MISSION checkout-v2  ◎                      3 units  11 agents  $4.20
          plan  scout  build   integ  check  review  ship
api       ●─────○○─────●●●○────◐──────·──────·───────·     3/3  $2.10
web       ●─────○──────●●──────·──────·──────·───────·     2/2  $1.40
mobile    ◌ after api

TEAM fix-login                              1 unit    4 agents  $0.90
          ●─────·──────○○──────○──────■■□────◉───────·     1/2  $0.90
```

- The track is filled up to `reached`; the `active` stage carries a ring.
- A held unit shows a hold glyph at `reached` (input, paused, blocked) and a
  settled unit a terminal glyph (review ready, merge reported, no change,
  cancelled). "Merge reported" keeps its agent-claim wording in the tooltip.
- Check results are squares: passed, failed, running.
- A mission subtask without a team is a ghost row with `after <unit>`.
- Row end: worker slots in use over the limit, and cost.
- Selecting a dot fills the inspector. The row title opens the team page.

### Wall view

One tile per agent of a live unit, grouped by swarm and unit, ordered needs
you, in review, working, waiting, queued, reported, stopped.

```
┌ IM ● ─────┐   role code, state mark
│ sonnet  S │   model label, tier
│ ▁▂▅▇▇▅▂▁▁ │   activity, last 5 min
│ Edit  42s │   tool in flight, time since last activity
│ $0.31     │   cost
└───────────┘
```

- Tiles are a fixed size and wrap. A group header carries the swarm title and
  its counts.
- **Activity** is observed in the page: each poll records whether an agent's
  `lastActivityAt` advanced, into 30 ten-second buckets. It starts empty when
  the page opens and the legend says so. The host has no cheap activity
  history, and none is added.
- **Tool** is the loud tool the host reports as in flight. Quiet tools such as
  reads never appear and the slot empties when a tool ends, so it is often
  blank. A blank slot keeps its space.
- Role codes: `PM`, `SC`, `IM`, `IN`, `RV`, `DL`, `PR` (permission reviewer),
  `MC` (mission coordinator), `SO` (solo).

### Graph view

A node-link picture of every live swarm on the left and the code context in
use on the right, with links between agents and the code areas they touched.

```
   swarm                                  code context
              ○ SC                    ▢ apps/web/src
              │                      ╱ │
   IM ●───────◎ PM ───────● IM ┄┄┄┄▣ packages/host/src ── ▢ packages/remote
              │                      ╲ │
          RV ◌    ● IM ━━━━━━━━━━━━━━▣ tests
              ║
   ◎══════ MISSION ══════◎
```

Nodes:

- Mission hub, unit hub (the project manager), agents around their hub, and
  solo sessions as a loose group.
- Code areas: directories from a project's code map. The view draws the
  context in use, not the whole map: every touched area plus the areas linked
  to it in the code graph, heaviest links first. Each project with a live unit
  forms its own labelled cluster. Areas are sized by symbol count and carry
  heat from the number of agents touching them. Only hubs, project clusters,
  and touched areas carry a label; other labels appear on hover.

Links:

- Membership (hub to agent) and dispatch (mission to unit, with an arrow for
  subtask dependencies).
- Touch (agent to area), four kinds that are never merged:
  - planned ownership: dashed;
  - observed read: dotted;
  - observed edit: thin solid;
  - integrated change: heavy solid.
  Width follows the count.
- Code (area to area): faint, weighted by the number of graph edges between
  the two directories.

Behaviour:

- Layout is layered and deterministic: mission hub, unit hubs, agents, touched
  areas, neighbouring areas, left to right, with areas in path order under
  their project. Positions depend only on which nodes exist and on the model's
  order, so a state change recolours a node without moving it and nothing
  animates into place.
- Selecting an agent highlights its areas; selecting an area highlights the
  agents touching it and lists their count in the inspector.
- Rendered as SVG. Budget: 60 agents, 6 project clusters, 120 areas, 400 code
  links. Beyond a budget the least-touched items are dropped and a `+n` count
  is shown in the legend.
- The view reads each project's shared graph lane. The endpoint also serves a
  run's own lane and falls back to the shared lane when the run lane has no
  receipt, which is normal after a host restart.
- An agent whose provider records no tool inputs is marked `no signal` and
  keeps only its planned and integrated links.
- Without a code map (graphs disabled or none built) the view still draws the
  swarms and derives areas from touched paths alone, with no code-to-code
  links and a `code graph off` marker in the legend.
- Over the relay the endpoints below are admitted (see Host: access). A host
  that predates them answers 404; the view then behaves as without a code map
  and without observed touches.

**What "touched" means.**

1. Planned ownership: `task.paths` from the team plan.
2. Integrated change: `task.changedPaths`, which the host reads from Git.
3. Observed tool inputs: paths in recorded `tool-start` signals, split into
   reads and edits, plus a count of `graphify` commands the agent ran. This is
   what the agent's tools were pointed at. It is not evidence that the agent
   understood or used the content, and an observed edit is not a landed
   change. The legend labels these links "observed tool inputs".

### Vitals, legend, inspector

- **Vitals**: agent counts by state, the count waiting on a person, worker
  slots in use over the limit, total cost of live swarms, CPU and memory
  meters, a provider-limit flag per limited provider, and the freshness slot.
- **Legend**: always visible, one line, mark plus word for each state.
- **Inspector**: one line for the selection. Agent: role, model, state and
  duration, tool in flight, cost, task ID, links to the session and team.
  Unit: status, revision, slots, checks, cost, link to the team. Area: path,
  files, symbols, agents touching, map lane and commit.

### Look

- The Swarm view sits on the existing dark `terminal-surface` with
  `terminal-ink`, scoped to the view through CSS variables. Other pages keep
  the paper look. `DESIGN.md` today reserves the dark surface for terminal
  replay; this change adds an instrument-surface role limited to the Swarm
  view and amends that rule. Because the palette is scoped variables, moving
  the view to paper later is a token change.
- Controls follow the Liquid Glass arrangement `DESIGN.md` already describes
  for native. The canvas is flat content that runs edge to edge. The vitals
  strip, view switch, legend, and inspector float above it as glass, and
  content scrolls under them. On the web the glass is real: a translucent
  fill, `backdrop-filter` blur and saturation, a light rim with a brighter top
  edge, and one shared soft lift. Shapes are capsules and concentric rounded
  panels. The canvas keeps enough inset that nothing rests under a control.
- Glass is for controls only. Lanes, tiles, and graph nodes stay flat, and
  glass never sits on glass.
- With `prefers-reduced-transparency`, or where `backdrop-filter` is not
  supported, glass falls back to an opaque fill with the same rim.
- Labels use the UI monospace stack. The only sans text is the swarm title.
- State is carried by shape and colour together: filled disc (working, with a
  slow ring unless reduced motion is requested), half disc (waiting), ringed
  disc with a mark (needs you), ringed disc without a mark (in review), dashed
  outline (queued), hollow disc (reported), small dim square (stopped),
  diamond in the error colour (fault).
- State colours derive from the existing running, warning, and error tokens,
  adjusted for the dark ground: at least 3:1 contrast for marks and 4.5:1 for
  text.
- Every mark is focusable with an accessible name such as "Implementer,
  working, tool Edit". Arrow keys move between agents in Lanes and Wall.

### Host: code map

The graph builder already reads the graph file, so it produces the map. The
API process never opens a graph file and no privileged command is added.

- `scripts/repository_graph.py` adds a `map` object to its `ready` and
  `unchanged` receipts. It takes no new argument, so the deployment wrapper
  and its sudo rule are unchanged.
- `RepositoryGraphs` keeps the map with the receipt in memory, inside its
  existing receipt bound.
- `GET /api/projects/:id/graph/map?lane=<lane>`, any role, answers from those
  receipts.

```json
{
  "state": "ready",
  "lane": "shared",
  "head": "<commit>",
  "builtAt": "<iso time>",
  "areas": [{ "id": "packages/host/src", "files": 131, "symbols": 2210 }],
  "links": [{ "source": "apps/web/src", "target": "packages/remote/src", "weight": 42 }],
  "truncated": { "areas": false, "links": true }
}
```

- `state` is `ready`, `disabled` (graphs not configured or the project is
  filtered out), or `unavailable` with `reason`: `none-built` or `too-large`.
- `lane` defaults to `shared`; `run-<team id>` selects a run lane. When the
  requested lane has no receipt with a map, the response uses the shared lane
  and says so in `lane`. Receipts are lost on restart; startup reconciliation
  rebuilds the shared lane, and run lanes return when a member next launches.
- Reduction, in the builder: take nodes that have a repository-relative
  `source_file` and are not external. An area is the file's directory,
  truncated to the largest depth that yields at most 120 areas, with any
  overflow folded into one `other` area. A link is the count of graph edges
  whose two ends lie in different areas, undirected, whatever their relation.
  The 400 heaviest links are kept. The rule depends only on `source_file`,
  `external`, and edge endpoints, which both the real extractor and the test
  extractor emit.
- The map is at most 256 KB serialized, well inside the host's 1 MB receipt
  limit. A larger map is dropped and the receipt reports `too-large`.

### Host: touches

`GET /api/teams/:id/context`, any role, returns every member of the run.
`GET /api/sessions/:id/context`, any role, returns one session and serves solo
sessions and mission coordinators. Both read one in-memory index.

```json
{
  "teamId": "<id>",
  "revision": 3,
  "members": [{
    "memberId": "<id>",
    "sessionId": "<id>",
    "observable": true,
    "complete": true,
    "graphQueries": 2,
    "files": [{ "path": "packages/host/src/teams.ts", "reads": 4, "edits": 1, "lastAt": "<iso time>" }],
    "truncated": false
  }]
}
```

- Source: `signal` events of kind `tool-start` in each session's journal.
- `observable` is false for a provider that records no tool inputs.
- Extraction is a small table and is conservative. A missed path is
  acceptable; an invented one is not.
  - File tools (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`): the
    path field of the input. `Read` counts as a read, the others as edits.
  - `apply_patch`: paths on the patch's file header lines, as edits.
  - Shell tools: a token counts as a read only when it is shaped like a
    relative file path and its directory is an area of the project's code map.
    Without a map, shell tokens are not counted. A command that runs
    `graphify query`, `path`, or `explain` adds one to `graphQueries`.
- Paths are made repository-relative against the session's working directory;
  anything outside it is dropped. Each session keeps its 300 most recently
  touched files and sets `truncated` beyond that.
- The index is incremental: a cursor per session, advanced on request. Its
  budget counts journal reads, not returned events, because a read can scan
  512 KiB and return nothing: at most 8 reads per session per request, with
  the event loop yielded between reads, and `complete: false` while it catches
  up. 256 sessions are kept. Nothing is persisted; the index is rebuilt on
  demand after a restart.

### Host: access

The relay allowlist (`packages/host/src/remote-access.ts`) admits `GET` for
the three new paths. They are read-only and expose the same class of data the
relay already serves through the project file listing and session events.
`docs/security.md` records the addition.

### Documentation

- `docs/swarm.md`: what the view shows, what each mark means, and its limits.
- `DESIGN.md`: instrument surface, state marks, the Swarm components.
- `docs/repository-graphs.md`: the map in the receipt and the map endpoint.
- `docs/teams.md`: the context endpoints.
- `docs/security.md`: the relay additions.
- `PRODUCT.md`: one line under the web client.

## Verification

- `node:test` unit tests for the model: the state table including prompt
  ownership, the waiting-on-a-person count, live and quiet, stage derivation
  for every status, mission grouping with a missing mission, solo sessions,
  stable ordering across two polls that differ only in `updatedAt`, revision
  filtering.
- Builder tests for the map: reduction, depth choice, caps, size refusal, and
  a fixture that carries the real extractor's node and edge fields.
- Host tests for the map endpoint (lane fallback, disabled, none built, viewer
  access), the touch index (each extraction rule, path confinement,
  truncation, the read budget with an output-heavy journal, the unobservable
  flag), and the relay allowlist.
- A Playwright harness in the style of `tests/web-polling.test.ts` renders
  the three views from fixtures: one mission with three subteams in two
  projects, one standalone team, two solo sessions, 40 agents, with and
  without a code map. Screenshots at 1440×900 and 1000×700, plus a
  reduced-motion run.
- A check that hidden tabs send no Swarm requests.
- `npm run check` once at the end.

## Delivery slices

1. Web: model, shell, vitals, legend, inspector, Lanes, Wall. No host change.
2. Host: map in the builder receipt, map endpoint, touch index and endpoints,
   relay allowlist, their docs.
3. Web: Graph view.
4. `DESIGN.md`, `docs/swarm.md`, `PRODUCT.md`.

Slice 1 can ship before 2 and 3. Slice 2 changes `scripts/repository_graph.py`,
which a release installs on the host; maps appear after the next graph refresh
on that release.

## Left to the builder

- Exact colour values within the contrast rule, glyph drawing, and spacing.
- Force parameters and the tick budget, within the stability rule.
- Where the shared prompt-ownership rule lives.
- File layout under `apps/web/src/swarm/`.

## Calls made by the builder, for the owner to confirm

- The Swarm view replaces the web Overview as the landing page.
- Dark canvas for this view only, with the `DESIGN.md` amendment.
- "Context used" means the touch sources above, with observed tool inputs as
  the live one.
- The Graph view shows every live swarm at once and draws only the code
  context in use, one cluster per project.
- Quiet runs collapse to one row and leave the view after 72 hours.
- The three new read endpoints are admitted over the relay.
- Active machine only.

## Changes during implementation

- **Layout.** The first build used a force simulation. Its nodes clumped and
  its labels collided, so it was replaced by the layered layout described
  above. No web dependency was added.
- **Order.** The draft put swarms that wait on a person first. That reorders
  rows on a state change, which the anti-goals forbid, so order follows
  creation time only.
- **Last good map.** A lane keeps its last good code map through a later
  failed or busy graph refresh.
- **Planned directories.** A planned path that names a directory the map knows
  is drawn as that area.
- **Not drawn.** A mission coordinator's observed touches are requested but
  not drawn, because a coordinator belongs to no single project. The area
  inspector shows the path and project only.
- **Review fixes.** An independent review found that shell extraction could
  invent a path from a truncated or quoted command, that concurrent requests
  could grow the touch index past its bound, that solo sessions lost their
  project, that session context requests were not batched, and that one failed
  context request discarded the others. Each is fixed with a regression test.
  Quiet runs are now capped and aged one by one, a quiet run inside a live
  mission is one collapsed row, and the host enforces the map's byte budget
  itself. The legend shows `context stale` while some context cannot be
  refreshed.
- **Second review pass.** A re-review confirmed six of those fixes and found
  four narrower gaps, all fixed with tests: the touch index now refuses a new
  session while it is full of sessions being read, so it never grows past its
  bound; a shell word that the shell would expand or splice is dropped whole;
  a shell comment no longer hides the paths before it; and a failed context
  request is tracked by its own path, so the stale flag clears only when that
  request answers again. These last fixes were verified by tests and were not
  re-reviewed.
