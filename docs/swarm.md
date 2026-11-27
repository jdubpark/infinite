# Swarm view

> **Scope note:** This page documents the read-only **web Swarm visualization** (`#/swarm`, `#/swarm/wall`, `#/swarm/graph`), its links into the **Team Run Inspector** (`#/teams/:id`) and **Mission Inspector** (`#/missions/:id`), and the **Decision Queue** (`#/decisions`). For multi-agent orchestration lifecycles, mission-to-subteam scheduling, and the Blackboard, see [System Architecture](architecture.md#orchestration-stack-and-state-machines), [Teams](teams.md#team-runs), [Missions](missions.md), and [Blackboard and member entry tools](teams.md#blackboard-and-member-entry-tools).

The Swarm view is the web client's landing page. It shows the agents on the
active machine: how they are organised into teams and missions, what each one
is doing now, and which parts of the code they are working in. It is
read-only. Every mark opens the existing session or team page, where steering
and answers stay.

The phone shows the same host by project and workspace. The Swarm view shows
it by agent.

## Views

One model feeds three views. Switching between them does not refetch.

| View | Route | Shows |
| --- | --- | --- |
| Lanes | `#/swarm` | One row per team run on seven fixed stage columns: plan, scout, build, integrate, check, review, ship. Agents sit on the stage of their role. |
| Wall | `#/swarm/wall` | One fixed-size tile per agent: role, model, state, activity, tool in flight, cost. |
| Graph | `#/swarm/graph` | Every live swarm beside the code areas its agents touched, with links between them. |

Cost counts measured usage only. A cost ends in `+` when some agents of that
run, mission, or the solo group have no usage data, and a dash replaces it when
no measured usage gives a figure.

Controls float above the canvas as glass: the vitals strip, the view switch,
the focus toggle, the legend, and the inspector. The `f` key hides the sidebar
for wallboard use. Escape clears the selection.

## Swarms, units, agents

- A **swarm** is a mission with its coordinator and subteams, a standalone
  team run, or the `solo` group of running sessions that belong to no team.
- A **unit** is one team run.
- An **agent** is a team member, a mission coordinator, or a solo session.

A unit is **live** while it works, waits for input, is paused, or still has an
agent that is queued, working, waiting, or holding a prompt. Other runs are
**quiet** and collapse to one row. A quiet run inside a live mission keeps its
place in that mission. Runs of swarms with nothing live move to a quiet group,
where each stays for 72 hours after its host-recorded `lastActivityAt`
timestamp (falling back on legacy hosts to the latest time its agents started,
acted, or reported, or its creation when none did), and at most 12 are shown.
Routine no-op saves on settled runs leave both `updatedAt` and `lastActivityAt`
unchanged. Vitals count agents of live swarms only.

Rows keep their order between polls. Live swarms are ordered by creation time,
newest first, with the solo group last. A swarm that starts waiting on a
person keeps its row; its marks and the vitals carry that.

## Agent states

Shape and colour carry the state together. The legend is always visible.

| State | Mark | Meaning |
| --- | --- | --- |
| needs you | ringed disc with a mark | A provider prompt that a person must answer. |
| in review | ringed disc | A provider prompt the permission reviewer is handling under the run's delegation. |
| working | filled disc | The host observed the agent working. |
| waiting | half disc | Running, with a finished turn or no activity. |
| queued | dashed outline | Not started. |
| reported | hollow disc | The agent sent its report. This is the agent's claim. |
| stopped | small square | The agent's process stopped. |
| fault | diamond | The runtime is unavailable or its recording failed. |

"Needs you" follows the same ownership rule as the phone. The count of work
waiting on a person adds open team decisions outside missions and open mission
decisions, so a run can wait on its owner while no agent holds a prompt.

No mark records completion, approval, or a merge. "Merge reported" is the
delivery agent's report.

## What the Wall observes

- **Activity** is observed in the page. Each poll records whether an agent's
  last-activity time advanced, in ten-second buckets over five minutes. It
  starts empty when the page opens.
- **Tool** is the loud tool the host reports as in flight. Reads and other
  quiet tools never appear, and the slot empties when a tool ends.

## Wait reasons, stalled, and spinner-only indicators

The host computes ordered wait reasons for non-paused, non-terminal team runs
(`packages/host/src/team-wait-reasons.ts`) and projects them on `GET /api/teams?view=list`
(`packages/host/src/team-list.ts`), capped at 16 ordered wait reasons per run
with whitespace-collapsed summaries truncated at 240 characters, alongside member
liveness fields (`stalledAt`, `spinnerOnlySince`, `pendingLimit`).

Wait-reason kinds are ordered from highest actionability to structural waits:

| Kind | Meaning |
| --- | --- |
| `owner-decision` | An open team decision on the active revision waits for an answer. |
| `provider-prompt` | A provider prompt is waiting for owner response or permission coordinator review. |
| `stalled` | An active unreported member stalled without substantive activity and is stopping. |
| `spinner-only` | An active unreported member shows spinner or status redraws without substantive screen changes. |
| `provider-limit` | A corroborated provider limit or member `pendingLimit` holds new or current work. |
| `worker-slot` | Ready tasks, scouts, or queued members are waiting for an available worker or session slot. |
| `dependency` | Pending tasks are waiting on upstream `dependsOn` tasks to integrate. |
| `integration-order` | A reported implementer is waiting to integrate behind earlier tasks in plan order. |
| `linear-sync` | Linear issue tracking confirmation is pending or retrying. |

Swarm views render these indicators consistently from the same host projection:

- **Lanes**: each live unit label displays a wait-count pill (`1 wait` / `N waits`,
  with all summaries on hover), and agent mark titles append `provider limit`,
  `stalled`, or `spinner-only` when set.
- **Wall**: standalone team headers and mission subteam sections display wait
  badges (`1 wait` / `N waits`), and each agent tile shows compact `lim`,
  `stall`, `spin`, and `earlier` tags.
- **Swarm Inspector (bottom bar)**: selecting a unit shows `wait N` with the
  highest-priority wait-reason summary (all summaries on hover) and a `team`
  link; selecting an agent shows `stalled` and `spinner-only` flags alongside
  `session` and `team` links.

## Team Run and Mission Inspectors

Swarm stays read-only and routes into dedicated detail views when you open a
unit or mission:

- **Web Team Run Inspector (`#/teams/:id`)**: clicking `team` in the Swarm
  inspector or double-clicking a unit title opens `TeamDetail`
  (`apps/web/src/teams.tsx`), composed of `TeamOverview` and
  `TeamEvidenceBoard`. `TeamOverview` separates task integration progress and
  criterion outcome groups from provisional criterion assessments and reviewer
  acceptance claims, lists ordered host wait reasons (`Why this run is waiting`)
  with `Logs`, `Entries`, and `Session` actions plus `Stalled since` /
  `Spinner-only screen since` member flags, and collapses finished or prior
  attempts under a `Finished (N)` toggle with replacement links. The `Board`
  tab (`TeamEvidenceBoard`, deep-linkable at `#/teams/:id/entries/:entryId`)
  filters Blackboard entries, distinguishes `Host receipt`, `Agent claim`, and
  `Owner direction` authority, and navigates supersession chains. See
  [Teams](teams.md#team-runs) and [Blackboard and member entry tools](teams.md#blackboard-and-member-entry-tools).
- **Web Mission Inspector (`#/missions/:id`)**: clicking a mission title in
  Lanes or a held mission row opens `MissionPage` (`apps/web/src/missions.tsx`,
  `apps/web/src/mission-inspector/MissionInspector.tsx`). It polls
  `GET /api/missions/:id/progress` using a generation-scoped cursor
  (`mp1.<generation>.<missionId>.<instance>.<sequence>`), surfaces a
  resync banner (`MissionResyncBanner`) on `host-restarted`, `history-evicted`,
  `retention-gap`, `cursor-ahead`, `invalid-cursor`, or `mission-mismatch`,
  separates recorded state from live worker status, compacts finished subteam
  assignments under `Finished (N)`, and lets paired viewers inspect child subteam
  Blackboard entries or open a child team directly. See [Missions](missions.md).

## Code context in the Graph view

The Graph view is layered from left to right: mission hub, unit hubs, agents,
touched code areas, and their neighbours. It draws the code context in use:
each touched directory and its closest neighbours in the code graph, one block
per project, in path order. It never draws symbols or source text. Positions
depend only on which nodes exist, so a state change moves nothing.

An agent's links to code come from three sources. They are drawn differently
and never merged.

| Link | Source | Drawn |
| --- | --- | --- |
| planned | The paths the team plan gave the agent's task. | dashed |
| read, edit | File paths in the agent's recorded tool inputs. | dotted, thin solid |
| integrated | The paths the host read from Git for the task's integrated change. | heavy solid |

Observed tool inputs show what an agent's tools were pointed at. They do not
show that the agent understood or used the content, and an observed edit is
not a landed change.

An agent has `no signal` until the host has read a tool input that a provider
hook recorded for its session. The legend counts those agents. Each one says
so on hover, and its role is underlined with dots; a mission coordinator has
no role label, so it shows this on hover only. That is the case when the
provider's hooks are off (Codex hooks are off by default), when the session
was started with native arguments or in the native UI, before the agent's
first tool call, while the host is still reading a long journal, when the
session has no host journal or its journal cannot be read, and until the page
has an answer from the host. Agents of providers other than Claude Code and
Codex always have no signal. The mark describes what the host has seen, not
what the agent did, and such an agent keeps its planned and integrated links.

The code map comes from the repository graph checkpoints described in
[repository graphs](repository-graphs.md). The view reads each project's
shared graph lane. Without a code map the view derives areas from touched
paths and marks `code graph off`. A mission coordinator's touches are not
drawn, because a coordinator belongs to no single project.

## Host endpoints

All four are `GET`, open to every paired role, and admitted over the relay.

| Endpoint | Returns |
| --- | --- |
| `/api/teams?view=list` | Bounded team list projection (capped at 16 ordered wait reasons / 240-char summaries and member liveness fields). |
| `/api/projects/:id/graph/map?lane=` | The directory-level code map for a project lane. |
| `/api/teams/:id/context` | Touched files per member of a team run. |
| `/api/sessions/:id/context` | Touched files for one session. |

`/api/me` reports `capabilities.swarmContext` on a host that serves the three
code-map and context endpoints (`/api/projects/:id/graph/map?lane=`,
`/api/teams/:id/context`, `/api/sessions/:id/context`) — not
`/api/teams?view=list`, which is always available — along with
`providerCapabilities.<provider>.observesToolInputs` so clients derive
tool-input observability from host metadata rather than hardcoded provider IDs.
On an older host the Graph view draws the swarm without a code map or observed
touches.

The touch index is in memory, incremental, and bounded: eight journal reads
per session per request, four sessions read at a time across the host, 300
files per session, 256 sessions. When the index is full of sessions that are
still being read, a further session is answered with `complete: false` and no
files, and is admitted on a later request. Shell commands are read
conservatively: only words written literally in the command count, and a
command the recorder cut short counts for nothing. The index is rebuilt on
demand after a restart. The
view asks for team context every five seconds and for at most twelve solo or
coordinator sessions per cycle, walking a longer list in turn. Each request
stands alone; while one fails the legend shows `context stale` and the last
received context stays drawn. The flag clears when that request answers again
or its team or session leaves the view.

## Limits

- The active machine only.
- No history or replay.
- No controls.

## Decisions view

A separate route, `#/decisions`, shows what waits on a person: session
prompts, team decisions, and mission decisions from `GET /api/decision-queue`,
one at a time, oldest first. The sidebar says how many wait.

- An option is selected first and sent second. A number key or a click
  selects. Enter or the submit button sends. The `r` key selects the agent's
  recommendation and sends nothing.
- The recommended option is listed first. An approval question keeps its own
  order: approve first, deny second.
- A destructive session prompt takes an accepting option from a click only,
  not from a number key.
- Answers go through the existing session, team, and mission routes, so the
  same roles, control lease, and revision checks apply. A viewer reads the
  queue and cannot answer. Only the owner answers a mission decision.
- A prompt that only its terminal can answer links to that session's terminal.
- The view reads the queue every 1.8 seconds while it is open, and every 10
  seconds otherwise for the sidebar count. The last queue the host reported
  stays on screen while a read is in flight or fails.
- The queue takes answers only while it is the host's current answer. A
  failed read turns answers off at once. So does a read that has not come
  back three seconds after it was due. After about three seconds without a
  current queue, the decision dims, a notice says since when the queue has
  not refreshed, and the sidebar shows no count.
- Time in a hidden tab does not count toward that notice. A tab that returns
  asks for a new read at once and takes no answers until one lands. If a read
  from before is still in flight, the new one starts when that one settles.
  The notice shows only if no read lands within three seconds of the return.
- A decision answered here leaves the queue at once. If the fifth read after
  the answer still lists it, it shows again.
- A decision that leaves the queue while it is on screen is reported as no
  longer in the queue. The view does not say that it was answered, because
  the queue does not say why it left.
- A host without the queue route gets one line that says the queue is not
  available there. The same line replaces the last queue if the host stops
  serving the route.
