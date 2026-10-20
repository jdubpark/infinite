# Projects and missions

A **project** is what the owner targets when handing off work. It contains one
repository (a monorepo) or several repositories that each keep their own Git
history, checks, and remote, such as a frontend and a backend. A **mission** is
one task handed to a project. A main coordinator splits it into subtasks, and
each subtask runs as an ordinary single-repository team run (a **subteam**).

Owners start and monitor missions from one board on the CLI, the Mac app, and
the phone. Sessions remain available inside a run's logs; they are no longer the
unit the owner manages.

## Projects

Every enrolled repository is a host project, as before. An owner groups
repositories into a project with an explicit create. A repository outside every
group appears as an implicit single-repository project whose ID is its host
project ID. A repository belongs to at most one owner-created group. Deleting
an owner-created group retires its ID permanently; a later group with the same
name receives another available slug.

Grouping grants a mission's coordinator read access to every repository in the
group and lets it dispatch subteams to them. It does not merge project context,
Linear mappings, delivery policies, or permission delegation; each repository
keeps its own. Context relationships from `infinite repo link` are unchanged.

The host **suggests** groups and never applies one on its own:

- repositories whose host paths share the same parent folder, other than the
  host home directory or the workspace base itself;
- repositories enrolled with the same Linear project.

A suggestion becomes a group only through an owner create. Editing a group
affects future missions; a running mission keeps the repositories pinned when it
started.

API: `GET /api/project-groups` returns `ProjectGroupList`.
`POST /api/project-groups`, `PUT /api/project-groups/:id`, and
`DELETE /api/project-groups/:id` are owner-only and idempotent by `requestId`.
Deleting a group does not affect its repositories or missions already running.

## Missions

`POST /api/missions` (owner) creates a mission for a group. A retry with the
same `requestId` returns the recorded mission before any admission check, so it
succeeds even after the group was edited or deleted or a handoff started. The host launches
the coordinator with the configured strong coordinator profile in a mission
folder outside every repository, with each repository's host path listed in its
prompt for reading. The coordinator must not edit repositories directly; all
changes go through subteams. The launch enforces this: a Claude Code coordinator
runs in `dontAsk` mode with only Read, Glob, Grep, and its mission report tool,
and only its report MCP server. Codex is refused as a coordinator for now,
because Codex merges inherited MCP servers that could keep write-capable tools
outside its read-only sandbox.

The coordinator reports through its mission report tool:

| Report | Effect |
|---|---|
| `dispatch` | Adds subtasks (up to `maxSubtasks` in total). Later dispatches may add more. The host adds same-repository dependency edges, shown in mission events and later coordinator mission state. |
| `answer-child` | Answers an open subteam decision within the mission's objective and steering. Recorded as answered by the coordinator, in the mission and in the subteam. |
| `question` | Opens a mission decision for the owner. With `subtaskId` and `childDecisionId`, the owner's answer is forwarded to that subteam decision. |
| `cancel-subtask` | Cancels that subtask's subteam. A subtask that never started is cancelled at once, and the coordinator is told in its next attempt. |
| `result` | Accepted only when every subtask is `done` or `cancelled`, at least one is `done`, and no owner decision is open. A `blocked` subtask, or a queued one whose dependency ended `blocked` or `cancelled`, must be cancelled explicitly first. Moves the mission to `ready-for-review`. |
| `blocked` | Moves the mission to `blocked` with the summary as its reason. |
| `wait` | Ends the attempt without a decision. Accepted only while a subtask is running or can still start, or an owner decision is open, so a later attempt is certain. |

Size rules: a `solo` subtask starts a subteam with parallelism 1, and a `team`
subtask uses its `parallelism` (1–4). The coordinator chooses the size; a simple
mission may dispatch exactly one solo subtask.

Scheduling: a subtask starts when every dependency is `done`. The host adds a
dependency from each later subtask to the latest earlier, non-cancelled subtask
in the same repository, including when the subtasks arrive in separate
dispatches. The coordinator can also declare dependencies explicitly. Generated
edges are recorded on the affected subtasks, named in mission events, and shown
in the `dependsOn` fields of subsequent coordinator mission state.

Mission subteams reserve only their own repository while a launch is pending or
their run is active; a mission does not reserve every repository in its group
for its whole lifetime. An active subteam or pending mission launch prevents a
standalone team from starting in that repository. Once the subteam finishes,
standalone runs can start there even if the mission continues elsewhere.
Multiple standalone runs may coexist in one repository. A mission subtask waits
while its repository is already in use and rechecks at launch; if a standalone
run starts in the gap, the mission records that launch failure as a blocked
subtask with the reason. A blocked subteam run keeps its repository reserved
until cancelled.

A subtask that depends, directly or through other subtasks, on finished work in
its own repository starts from that run's workspace head rather than from the
repository. With several same-repository predecessors, it uses the latest run
in the dependency chain, so its base includes earlier work. A subtask is `done`
when its subteam reaches `ready-for-review`, `merged`, or `no-change`;
`blocked` when its subteam is blocked; `cancelled` when its subteam is cancelled.

Escalation: when a subteam opens a decision or becomes blocked, the host sends
the coordinator a message naming the subtask, the decision ID, and the question
or reason. Each coordinator attempt receives at most 30 messages; the rest wait
for the next attempt. Every open subteam decision is also listed in each
attempt's mission state, read from the subteams, so none depends on a message. Only the coordinator's `question` report reaches the owner. Provider
permission prompts are unaffected and keep their existing owner or delegated
coordinator path per repository.

Owner controls: answer, steer (forwarded to the coordinator), pause, resume, and
cancel. All five are owner-only; a controller cannot answer or steer a mission. A
coordinator `result` from an attempt that started before the owner's latest
direction or answer is not applied; the host starts a new attempt with that
input instead. Pause, resume, and cancel apply to the coordinator and every active
subteam. The deadline stops the coordinator and active subteams like a team
deadline.

Status honesty: `ready-for-review` means the coordinator reported a result after
every subtask finished. It does not establish product impact or acceptance. Each
subteam delivers only under its repository's own delivery policy; the mission
does not push, merge, or deploy.

## Board

`GET /api/board` returns `Board`: every mission, plus team runs and goals that
were not started by a mission. Subteams appear only inside their mission.

| Column | Mission | Team run | Goal |
|---|---|---|---|
| `needs-input` | `needs-input`, `blocked` | `needs-input`, `blocked` | `needs-input`, `blocked` |
| `working` | `planning`, `working`, `paused` | active and `paused` statuses | `running`, `paused` |
| `review` | `ready-for-review` | `ready-for-review` | `ready-for-review` |
| `ended` | `cancelled` | `merged`, `no-change`, `cancelled` | other terminal statuses |

Rows are newest-updated first within a column. `detail` shows the open question,
the block reason, or the current step.

## Clients

All three clients show the same board: Needs input, Working, Ready for review,
and a collapsed Ended section, with a composer that targets a project.

- CLI: `infinite projects` lists projects, repositories, and suggestions.
  `infinite projects group NAME REPO...` creates a group. `infinite start
  [--project ID] "task"` creates a mission; without `--project` it uses the
  group containing the current repository. `infinite board` is a full-screen
  board with a composer at the bottom.
- Mac: the sidebar lists projects. Home shows the board and a composer with a
  project picker. Selecting a project filters the board to it.
- Phone: the first tab is the board with a composer and project picker.

A mission row opens a detail view: open decisions first, then subtasks with
their repository and status. Each subtask opens the existing team detail.
