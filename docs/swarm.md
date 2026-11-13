# Swarm view

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
where each stays for 72 hours by its own age and at most 12 are shown. Vitals
count agents of live swarms only.

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
not a landed change. Only Claude Code and Codex record tool inputs; agents of
other providers are marked `no signal` and keep their planned and integrated
links.

The code map comes from the repository graph checkpoints described in
[repository graphs](repository-graphs.md). The view reads each project's
shared graph lane. Without a code map the view derives areas from touched
paths and marks `code graph off`. A mission coordinator's touches are not
drawn, because a coordinator belongs to no single project.

## Host endpoints

All three are `GET`, open to every paired role, and admitted over the relay.

| Endpoint | Returns |
| --- | --- |
| `/api/projects/:id/graph/map?lane=` | The directory-level code map for a project lane. |
| `/api/teams/:id/context` | Touched files per member of a team run. |
| `/api/sessions/:id/context` | Touched files for one session. |

`/api/me` reports `capabilities.swarmContext` on a host that serves them. On
an older host the Graph view draws the swarm without a code map or observed
touches.

The touch index is in memory, incremental, and bounded: eight journal reads
per session per request, four sessions read at a time across the host, 300
files per session, 256 sessions. It is rebuilt on demand after a restart. The
view asks for team context every five seconds and for at most twelve solo or
coordinator sessions per cycle, walking a longer list in turn. Each request
stands alone; while one fails the legend shows `context stale` and the last
received context stays drawn.

## Limits

- The active machine only.
- No history or replay.
- No controls.
