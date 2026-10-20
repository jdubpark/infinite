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

`POST /api/missions` (owner) creates a mission for a group. The host launches
the coordinator with the configured strong coordinator profile in a mission
folder outside every repository, with each repository's host path listed in its
prompt for reading. The coordinator must not edit repositories directly; all
changes go through subteams.

The coordinator reports through its mission report tool:

| Report | Effect |
|---|---|
| `dispatch` | Adds subtasks (up to `maxSubtasks` in total). A later dispatch may add more. |
| `answer-child` | Answers an open subteam decision within the mission's objective and steering. Recorded as answered by the coordinator. |
| `question` | Opens a mission decision for the owner. With `subtaskId` and `childDecisionId`, the owner's answer is forwarded to that subteam decision. |
| `cancel-subtask` | Cancels that subtask's subteam. |
| `result` | Accepted only when no subtask is queued or running. Moves the mission to `ready-for-review`. |
| `blocked` | Moves the mission to `blocked` with the summary as its reason. |

Size rules: a `solo` subtask starts a subteam with parallelism 1, and a `team`
subtask uses its `parallelism` (1–4). The coordinator chooses the size; a simple
mission may dispatch exactly one solo subtask.

Scheduling: a subtask starts when every dependency is `done`. At most one
subteam per repository is active at a time; others stay `queued`. A subtask is
`done` when its subteam reaches `ready-for-review`, `merged`, or `no-change`;
`blocked` when its subteam is blocked; `cancelled` when its subteam is cancelled.

Escalation: when a subteam opens a decision or becomes blocked, the host sends
the coordinator a message naming the subtask, the decision ID, and the question
or reason. Only the coordinator's `question` report reaches the owner. Provider
permission prompts are unaffected and keep their existing owner or delegated
coordinator path per repository.

Owner controls: answer, steer (forwarded to the coordinator), pause, resume, and
cancel. Pause, resume, and cancel apply to the coordinator and every active
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
