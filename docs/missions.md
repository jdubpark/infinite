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

A **checkout** is one enrolled host directory, as before. Checkouts of one Git
repository fold into a **repository**. A **project** groups repositories, and it
is the only thing the owner targets. A repository belongs to at most one project.
Deleting an owner-created project retires its ID permanently; a later project
with the same name receives another available slug.

Grouping grants a mission's coordinator read access to every repository in the
project and lets it dispatch subteams to them. It does not merge project context,
Linear mappings, delivery policies, or permission delegation; each repository
keeps its own. Context relationships from `infinite repo link` are unchanged.

**Checkout identity.** The host derives one key per checkout and stores it
sealed the first time it sees the checkout. The first rule that applies wins:

1. The GitHub source record, `remote:github.com/OWNER/REPO`, when one exists.
2. The checkout's `remote.origin.url`, normalized to `remote:HOST[:PORT]/PATH`.
   The scheme, user info, and a trailing `.git` are dropped, and the host is
   lowercased; a port stays, and the path keeps its case except on
   `github.com`. `ssh` and `https` forms of one remote are equal.
3. The earliest root commit, `root:HASH`, when there is no remote.
4. None, when the folder is not a Git repository or Git fails. Such a checkout
   stays a project of its own.

Identity is captured once per checkout and never rescanned, so an agent that
edits Git metadata cannot regroup projects. Capture runs `git config --get
remote.origin.url` and `git rev-list --max-parents=0 HEAD` without hooks or
filters. A failed capture stores nothing and is retried on each list, at most
once a minute.

**Repository and primary.** Checkouts with the same key form one repository
with exactly one primary checkout. The default primary is the first of: the
owner's stored choice; a checkout with a GitHub source record; a team-ready
checkout with the most recent sync apply; the most recently applied checkout;
the shortest host path; the lowest ID. An owner's choice is stored on the
project as `primary` and lasts until that checkout leaves the project.

**Project kinds.**

- `owner`: created or edited by the owner.
- `repository`: created by the host for an identity key that no stored project
  holds. Its ID is the slug of the repository name, and its name starts as that
  name. Renaming, hiding, or changing the primary keeps the kind. Adding a
  checkout of a different repository makes it `owner`.
- `implicit`: a checkout with no identity and no stored project. Not stored; its
  ID is the host project ID.

**Automatic folding.** On every list, each checkout with an identity that no
stored project holds joins the stored project that already holds the same key
with the most checkouts, then the earliest created. With no such project, the
host creates a `repository` project. A checkout the owner removed is recorded in
that project's `detached` list and does not return on its own. After a split,
two projects may hold the same key; the second takes the next free slug and the
same default name.

**Hidden.** `hidden` removes a project from the picker, the board chips, and the
goal and session choices. Hidden projects are listed under "Hidden" in the
management screen. Missions can still be created for them from the CLI, and
their runs remain under "All". Nothing hides on its own.

**Names.** A project's name is its stored name. Owner projects use the name the
owner typed. Repository projects use the repository name: the last segment of
the remote, or for a root-only checkout the folder name, unless that name is
`codebase`, `code`, `src`, `repo`, `app`, `main`, or `worktree`, in which case
the parent folder's name is used. A checkout's label is its host project name,
shown only on the project screen. Host paths never appear in a list row.

**Suggestions.** The host suggests combinations and never applies one. It
considers only `repository` and `implicit` projects, grouped by a shared parent
folder of their primary paths (other than the home directory or the workspace
base), or by a shared Linear project of any checkout. A suggestion lists every
checkout it would combine, so one `POST` moves whole repositories. Owner projects
are never suggested.

**API.**

- `GET /api/project-groups` returns `ProjectGroupList`. Each project lists its
  `repos`, one per repository with the primary's `projectId`, `name`, and
  `path`, and its `checkouts`, primary first.
- `GET /api/project-groups/:id` accepts a project ID or a host project ID. A host
  project ID resolves to the project that contains that checkout.
- `PUT /api/project-groups/:id` (owner, `requestId`, `revision`) takes `name`,
  `repos` (host project IDs, up to 64), `hidden`, and `primary` (host project
  IDs, at most one per repository). Removing a checkout detaches it. Adding a
  checkout held by a `repository` project moves that checkout, and an emptied
  `repository` project is deleted with its ID retired. Adding a checkout held by
  an `owner` project returns 409 `project-group-repo-conflict`. A `primary` ID
  outside the project returns 400. Editing an `implicit` project first stores it
  as an `owner` project with the same ID.
- `POST /api/project-groups` (owner) follows the same move rules and conflict
  check.
- `DELETE /api/project-groups/:id` on a `repository` project releases its
  checkouts, which fold again into a new project with a new ID on the next list.
  On an `owner` project it deletes the project.

`POST`, `PUT`, and `DELETE` on project groups are owner-only and idempotent by
`requestId`. Deleting a project does not affect its repositories or missions
already running.

**Compatibility.** `repos[]` keeps one entry per repository with the primary's
values, so older clients render the folded list unchanged. `implicit` stays for
the same reason. Hidden projects stay in the list with `hidden: true`. Old mission
records keep their `groupId`, and an old implicit ID resolves to its folded
project.

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

A mission's coordinator sees one entry per repository: the chosen checkout's host
project ID, the repository name, its path, and whether it is team-ready. The
chosen checkout is, in order: the one named in the request's optional
`checkouts` field (host project IDs; an ID outside the project returns 400); the
primary when team-ready; any team-ready checkout, with a mission event saying the
primary was not configured; otherwise the primary. Alternate checkouts are not
listed to the coordinator. The mission pins the chosen IDs in `repoProjectIds`,
so later edits to the project do not change a running mission. `groupId` accepts
a host project ID as an alias, and the mission stores the resolved project ID and
its name at start. The phone never sends `checkouts`.

The coordinator reports through its mission report tool:

| Report | Effect |
|---|---|
| `dispatch` | Adds subtasks (up to `maxSubtasks` in total). Later dispatches may add more. The host adds same-repository dependency edges, shown in mission events and later coordinator mission state. |
| `answer-child` | Answers an open subteam decision within the mission's objective and steering. Recorded as answered by the coordinator, in the mission and in the subteam. |
| `question` | Opens a mission decision for the owner. With `subtaskId` and `childDecisionId`, the owner's answer is forwarded to that subteam decision. |
| `steer-subtask` | Sends direction to a running or blocked subteam, such as an owner answer or direction that changes work under way. The subteam stops its members and replans under a new revision. Held while the subteam is paused; refused, and the coordinator told, when the subtask has no running or blocked subteam or the subteam refuses the direction. |
| `resize-subtask` | Selects worker capacity with `subtaskId`, `parallelism` (1–4), and `summary`. Updates a queued subtask or durably forwards the change to its active subteam. A solo subtask permits only one worker. Lowering capacity lets running workers finish and holds new starts. |
| `cancel-subtask` | Cancels that subtask's subteam. A subtask that never started is cancelled at once, and the coordinator is told in its next attempt. |
| `result` | Accepted only when every subtask is `done` or `cancelled`, at least one is `done`, and no owner decision is open. A `blocked` subtask, or a queued one whose dependency ended `blocked` or `cancelled`, must be cancelled explicitly first. Moves the mission to `ready-for-review`. |
| `blocked` | Moves the mission to `blocked` with the summary as its reason. |
| `wait` | Ends the attempt without a decision. Refused while a subteam decision is open that the coordinator has neither answered nor escalated. Otherwise accepted only while something else will start a later attempt: an open owner decision, a subteam that is not paused, or a queued subtask that can start without anyone acting. A queued subtask whose repository any paused or blocked run holds does not count, since that run keeps the repository reserved after the others finish. |

Each attempt must end with one report. An attempt whose session ends its turn
without a report, or shows no activity for the team stall window while not
waiting on a provider prompt, is stopped. A turn counts as ended only when the
latest turn signal in the session's journal is a turn-end that has stood for
five seconds; a quiet screen alone is not evidence, because the attention state
keeps an earlier turn-end while a later turn continues. A report the session
files before it confirms its exit, including across a host restart, is applied
as usual and is not counted as missing. The next attempt starts with a
refusal that says so, together with every message that arrived meanwhile.
Three missed or refused reports in a row block the mission.

After the first attempt, the coordinator resumes its confirmed conversation
and receives only the current mission state and new messages. The first attempt
and any attempt after a failed resume receive the full prompt; a failed resume
does not count as a missed report.

Size rules: a `solo` subtask starts a subteam with parallelism 1, and a `team`
subtask starts with its coordinator-selected `parallelism` (1–4). The subteam
PM can select capacity in its plan or discovery report, and the mission
coordinator can resize a queued or active team subtask up to four workers as
independent work grows or shrinks. Solo subtasks remain limited to one. These
choices do not expand deadlines, member budgets, permissions, or repository
scope. A simple mission may dispatch exactly one solo subtask.

Each subtask's `objective` carries the self-contained assignment brief described
in [Roles and execution](teams.md#roles-and-execution): one coherent outcome,
bounded paths and exclusions, source pointers, agreed interfaces, constraints,
dependency outputs, acceptance criteria, and focused checks. The mission
coordinator resolves material product and interface decisions before dispatch;
dependent objectives repeat the same shared contract. This is prompt guidance,
not a host check that the objective is unambiguous.

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

A run outside the mission that holds a repository changes state without
reaching the mission. When a ready subtask's repository is held only by paused
or blocked runs outside this mission and no coordinator attempt is running, the
host sends the coordinator a `repository-held` message naming each holder run
and its status, once per subtask, holder, and status. The coordinator can then
cancel the subtask, ask the owner, or report blocked.

Owner controls: answer, steer (forwarded to the coordinator), pause, resume, and
cancel. Owner direction and answers to mission-level questions reach the
coordinator; subtasks started later include the direction, and the coordinator
forwards it to a subteam already under way with `steer-subtask`. All five
controls are owner-only; a controller cannot answer or steer a mission. A
coordinator `result` from an attempt that started before the owner's latest
direction or answer is not applied; the host starts a new attempt with that
input instead. Pause, resume, and cancel apply to the coordinator and every active
subteam. The deadline stops the coordinator and active subteams like a team
deadline. Coordinator and subteam sessions are read-only to people; provider
permission prompts continue to go to the owner or a delegated coordinator.

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

Every item carries `groupId` and `projectName` for the project that contains its
host project, including teams and goals, so a project filter keeps every run of
that project. Rows are newest-updated first within a column. `detail` shows the
open question, the block reason, or the current step.

## Clients

All three clients show the same board: Needs input, Working, Ready for review,
and a collapsed Ended section, with a composer that targets a project.

- CLI: `infinite projects` prints each project, its repositories, their
  checkouts with the primary marked, and suggestions; hidden projects print under
  a trailing "Hidden" heading. `infinite projects group NAME REPO...` creates a
  project. `infinite projects rename ID NAME`, `hide ID`, `show ID`, and
  `primary ID HOST_PROJECT_ID` each send one update. `infinite start [--project
  ID] "task"` creates a mission. Without `--project` it uses the project
  containing the current checkout and passes that checkout as `checkouts`; with
  `--project` naming a host project ID it passes that ID. `infinite board` is a
  full-screen board with a composer at the bottom.
- Mac: the sidebar lists projects. Home shows the board and a composer with a
  project picker. Selecting a project filters the board to it.
- Phone: the first tab is the board with a composer and project picker. The
  picker lists non-hidden projects by name, with a count of unfinished items and
  no paths, and offers a **Combine** control for each suggestion. Manage projects
  lists projects, suggestions, and a folded "Hidden" section. A project screen
  edits the name, hides or shows the project, sets each repository's primary,
  moves a checkout to its own project, and removes an owner project. Controllers
  and viewers see these screens read-only.

A mission row opens a detail view: open decisions first, then subtasks with
their repository and status. Each subtask opens the existing team detail.
