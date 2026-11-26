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

`infinite mission progress ID` reads one mission, its coordinator, and the
subteams bound to its assignments. Each subteam lists current assignments and
check receipts. A recorded assignment and a sampled worker status have separate
fields. An unavailable worker keeps its assignment until the host can establish
what happened.

The host allows eight simultaneous worker probes across all progress readers.
A child marked `not-sampled` has no new liveness reading on that page. Each
retained mission rotates through its eligible children as probe slots become
available. Polling other missions leaves its place in that rotation intact.

`infinite mission progress ID --after CURSOR --json` reads
`GET /api/missions/:id/progress?cursor=CURSOR`. Save the returned `cursor`
after processing the page. On reconnect, consume the retained observations in
order. When `resync.required` is true, replace the local view with the returned
`snapshot`. A host restart or an expired cursor can require a new snapshot.
Observations are sampled on reads. A transition between reads may appear only
in the underlying team record.

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
| `steer-subtask` | Sends direction to a running or blocked subteam, such as an owner answer or direction that changes work under way. The subteam stops its members and replans under a new revision. Held while the subteam is paused; refused, and the coordinator told, when the subtask has no running or blocked subteam or the subteam refuses the direction. For a finished subtask that holds an unforwarded owner review, it forwards that review instead; see [owner review of a subtask's pull request](#owner-review-of-a-subtasks-pull-request). |
| `resize-subtask` | Selects worker capacity with `subtaskId`, `parallelism` (1–4), and `summary`. Updates a queued subtask or durably forwards the change to its active subteam. A solo subtask permits only one worker. Lowering capacity lets running workers finish and holds new starts. |
| `cancel-subtask` | Cancels that subtask's subteam. A subtask that never started is cancelled at once, and the coordinator is told in its next attempt. A cancelled subteam is deleted with its workspace after every member settles; the mission keeps the cancelled status and final reason, and the coordinator is asked to decide whether a replacement subtask is needed. |
| `result` | Accepted only when every subtask is `done` or `cancelled`, at least one is `done`, no owner decision is open, and no owner review is on its way to its subtask. A `blocked` subtask, or a queued one whose dependency ended `blocked` or `cancelled`, must be cancelled explicitly first. Moves the mission to `ready-for-review`. |
| `blocked` | Moves the mission to `blocked` with the summary as its reason. It may carry an optional `blocker` object, stored as agent-reported evidence. A summary-only block stays valid. |
| `wait` | Ends the attempt without a decision. Refused while a subteam decision is open that the coordinator has neither answered nor escalated. Otherwise accepted only while something else will start a later attempt: a message that arrived during the attempt and already waits for the next one (such as a follow-up that fired while the attempt ran), an open owner decision, a subteam that is not paused, a queued subtask that can start without anyone acting, or an open follow-up. A queued subtask, or a queued review forward, whose repository any paused or blocked run holds does not count, since that run keeps the repository reserved after the others finish. |
| `follow-up` | Ends the attempt like `wait` and asks the host to start another at a set time, with `inMinutes` (5–10,080), `reason` (up to 500 characters), and `check` (up to 1,000 characters). Accepted even when nothing else would start an attempt. Refused when five follow-ups are already open, when the time falls at or after the mission deadline, or under the same open subteam decision rule as `wait`. |

Every report can carry a `note` of up to 2,000 characters beside it, in the
tool input and the report envelope. The coordinator uses it for what the
mission state does not show: decisions and their reasons, what it waits for,
and what to check next. The host keeps the newest eight notes, up to 16,000
characters in total, in the stored mission record only. Notes never appear in
the mission view, mission events, Slack, or Linear, because they are agent text.

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

Shared knowledge: the mission coordinator cannot query shared knowledge itself.
It asks a subteam to search that repository's configured knowledge scope with
the task and blocker keywords, and treats what comes back as a candidate
lesson. A candidate lesson needs source or check evidence and review by a
different strong reviewer through the configured single-writer workflow. Lessons
stay advisory: they never grant permissions, mark work resolved, weaken checks,
or publish themselves.

After the first attempt, the coordinator resumes its confirmed conversation
and receives only the current mission state and new messages. The first attempt
and any attempt after a failed resume receive the full prompt; a failed resume
does not count as a missed report. A host-chosen rotation also starts a new
conversation; see [Conversation rotation](#conversation-rotation).

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
After a cancelled subteam's members settle, the host removes its workspace and run
record, clears the subtask's run ID, and keeps a small final evidence snapshot
(the cancellation reason and head commit when available). If the work is still
needed, the coordinator must dispatch a replacement with a new subtask ID in the
same repository. These removals are host housekeeping, recorded by the host;
they are not reported as agent completion.

Escalation: when a subteam opens a decision or becomes blocked, the host sends
the coordinator a message naming the subtask, the decision ID, and the question
or reason. A blocked subteam's `subtask-finished` message carries its `blocker`
only when exactly one `agent-blocked` member report of the current revision has
a summary equal to the subteam's blocking reason. Summary-only, ambiguous,
superseded, and host-generated blocks carry none. A blocker object is limited
to 12 KiB of UTF-8 JSON and rejects unknown fields. It is agent-reported
evidence: the host does not verify the cause, resolve the blocker, or publish a
lesson. Each coordinator attempt receives at most 30 messages; the rest wait for
the next attempt. Every open subteam decision is also listed in each attempt's
mission state, read from the subteams, so none depends on a message. Only the
coordinator's `question` report reaches the owner. Provider permission prompts
are unaffected and keep their existing owner or delegated coordinator path per
repository.

Recommendations: a subteam decision carries the asking member's recommendation
when it has one (see [team questions](teams.md#team-questions-and-steering)).
The `child-decision` message and the decision's `openChildDecisions` entry
carry its answers and reason, and the prompt prints it as the asking agent's
recommendation. It is evidence for the coordinator's own choice between
`answer-child` and asking the owner; it changes neither rule. The
coordinator's `question` report requires its own recommendation through the
report tool. A forwarded question without `answerMode` takes the subteam
decision's mode, so the host checks the options and the recommendation against
that final mode: one option unless the mode is `multiple`. A question from a
coordinator started before this rule is still read, with no recommendation,
and its reporter falls back the same way a team member's does.
When the owner, a connector, or the coordinator's `answer-child` answers a
mission decision, the host records `matched`, `different`, or `other` on its
recommendation, as for team decisions. A connector reads the recommendation
in its request view ([MCP](mcp.md)). Nothing answers a question with its
recommendation.

Prompt budget: each coordinator attempt includes the longest run of waiting
messages that fits the 80 KiB prompt and the 30-message cap. If even the first
message does not fit, the host shortens it for that prompt only, in this order:
permission-recovery outcomes use their compact form, blocker evidence keeps
only `cause` and `proposedRecovery`, long text is cut, and finally only
identifiers remain. A follow-up message keeps its `followUpId` and `dueAt` in
every form. A shortened message carries a `truncated` marker saying
where the full record stays: the subteam's run, which its members read in
`.git/infinite-team-context.json`, or the mission's attempt history. It is
delivered once and counted as consumed. The host never starts an attempt with
zero messages while messages wait. If even the identifiers-only form cannot
fit, the mission becomes `blocked` with the reason "The next coordinator
message cannot fit with the mission state, even shortened. No empty
coordinator attempt was started; start a new mission with a consolidated
objective." Like any mission block, this cancels its subteams.

A run outside the mission that holds a repository changes state without
reaching the mission. When a ready subtask's repository is held only by paused
or blocked runs outside this mission and no coordinator attempt is running, the
host sends the coordinator a `repository-held` message naming each holder run
and its status, once per subtask, holder, and status. The coordinator can then
cancel the subtask, ask the owner, or report blocked. A queued review forward
that such runs hold gets the same message for its subtask, with the review ID,
once per review, holder, and status; see
[owner review of a subtask's pull request](#owner-review-of-a-subtasks-pull-request).

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

The owner's [halt](teams.md#halt) pauses a `planning`, `working`, or `needs-input` mission when
any of its repositories is in the halted scope, as the owner's pause does, and
holds every new coordinator and subteam launch in scope. The mission shows the
halt as its reason. It pauses only the subteams that are working or waiting for
input when the pause reaches them. A subteam that waits for input, with nothing
else in flight, is paused where it waits: it keeps its question, and an answer
given during the halt is kept until it resumes. A release resumes the mission
unless the owner acted on it during the halt or its deadline has passed, in
which case it stays paused and says why. An answer or an extension during the
halt does not count as such an action. Each subteam the halt paused then shows
the mission's new reason, not the halt's; so does each one after a release that
keeps the mission paused. When the mission resumes, it resumes only the
subteams that the halt paused and that nobody has acted on since; a subteam
paused where it waited continues where it waited. An answer is not such an
action. Any other owner action on a subteam takes precedence once the halt's
pause has reached it; a pause still on its way, or repeated after a restart,
pauses a working or waiting subteam even if the owner acted on it in the
meantime. The release withdraws every halt
pause not yet delivered, and a mission that stays paused sends its ordinary
pause in its place, as the owner's pause of a mission does. A `needs-input`
mission keeps its questions while paused. The owner can answer one during the
halt: the answer is recorded and, for a forwarded question, reaches the subteam
that the halt holds, but nothing starts. The release resumes the mission with
the answer applied, and the mission waits again while another question is open.
No coordinator attempt starts while any of its repositories is halted, and no
subteam starts in a halted repository. A connector cannot resume a mission the
halt paused, or one a halt covers: the halt is the owner's stop, and delegated
agent input cannot undo it. A connector can still cancel such a mission.

The halt does not stop a mission's time limit, except as a pause does: an intake
mission's clock stops while it is paused, and any other mission keeps its
deadline. When the deadline passes during the halt, the mission is blocked at
its time limit and nothing is unpaused. The release leaves it blocked and
resumes none of its subteams; each subteam the halt paused shows the time limit
instead of the halt. The owner can extend the time limit during the halt. The
deadline moves at once, but the subteams stay paused: a mission the halt paused
resumes them on release, and the resumes that an extension of a blocked mission
queues wait until no halt covers any of its repositories. Every subteam resume
waits while its mission is paused, blocked at its time limit, or halted, and a
later pause of the mission withdraws it. When the owner's resume or extension
then withdraws that pause before it arrives, every subteam that is paused at
that moment still gets a resume, so the withdrawn resume does not leave it
paused. A halt that engages before an earlier
halt's resume reaches a subteam holds that resume: its own release lets the
subteam continue, or, if the mission stays paused, retires the resume and shows
the mission's reason on the subteam. The same holds when the owner's pause or
the time limit supersedes a release's resume before it reaches its subteam,
even during a later halt: once no halt holds the mission, the subteam keeps its
pause and shows the mission's reason, and the owner's resume or extension
continues it. If the owner resumes the mission before that pause arrives, the
subteam resumes as the halt paused it.

Status honesty: `ready-for-review` means the coordinator reported a result after
every subtask finished. It does not establish product impact or acceptance. Each
subteam delivers only under its repository's own delivery policy; the mission
does not push, merge, or deploy. An owner review can reopen it, as the next
section says.

### Owner review of a subtask's pull request

With review feedback (`github.reviewFeedback`, see [teams](teams.md)) switched on, the host watches a
subteam run that delivered to a pull request and waits at `ready-for-review`. A
changes-requested review by the owner on that pull request goes to the mission's
coordinator, never straight to the subteam. Without the switch no mission
behaves differently.

The host records the review as owner direction with the review as its source
(`Owner (GitHub review)`), in one saved mission change under the review's
request ID. A repeat of that ID has no second effect. The effect depends on the
mission's status:

| Mission status | Effect |
|---|---|
| `planning`, `working`, `needs-input` | Recorded as owner steering, and a `review-direction` message goes to the coordinator's inbox. |
| `ready-for-review` | The mission reopens: its result moves to `earlierResults`, it returns to `working`, its deadline becomes now plus its original `maxMinutes`, and the review is recorded as above. Follow-ups the earlier result cancelled stay cancelled. |
| `paused`, `blocked` | Nothing is recorded yet. The review waits, and one mission event says so. It is delivered when the mission is live again. |
| `cancelled` | The review is refused. |

The mission event reads "The owner's review was delivered to the coordinator".
The subteam's run shows nothing until a forward steers it. The
`review-direction` message carries the owner's words unchanged, the subtask,
the subteam run, the review ID and the pull request URL. The prompt says what a
`steer-subtask` on that subtask does. The review is direction: it adds no
command, grant, delivery change, permission mode, or limit. Each accepted
review that reopens a mission gives it working time once; the limits on
subtasks, members, and coordinator attempts stay cumulative.

The coordinator decides what to do with it. A `steer-subtask` report on a
`done` subtask that holds an unforwarded review is the forward. It counts only
from a coordinator attempt that received the review. When the owner sent
direction or a review after the attempt started, or the review's
`review-direction` message still waits in the inbox because the attempt's
messages were full, the report is not applied, the coordinator is told, and a
new attempt considers it. The mission events then say nothing about a forward. A
forward is accepted only while that subteam run is still `ready-for-review`
with its pull request at the reviewed revision and head, and its workspace is
present; otherwise it is refused and the coordinator told why. An accepted
forward is queued as a `review-forward` operation with a stable request ID, and
works once. Each time the mission applies its operations, the forward:

1. Ends as used if the subteam already holds a receipt for its request ID.
2. Waits while the mission is paused or blocked at its time limit, and while
   another run holds the repository. When only paused or blocked runs outside
   the mission hold it, the coordinator gets a `repository-held` message for
   the subtask with the review ID, and `wait` no longer counts the forward as
   something that will start a later attempt.
3. Reads GitHub once more. The read runs outside the mission's queue and the
   scheduler pass, so a slow read delays no owner action and no other mission.
   The next pass uses its answer only after step 2 lets the forward go again;
   an answer that arrives while the forward waits is dropped, and GitHub is
   read again when the wait ends. If the owner has since approved or dismissed
   the review, or it is no longer the owner's newest, the forward ends
   superseded. A failed read is retried a minute later.
4. Is refused if the subteam's revision or head moved. It is never rebound to
   a later delivery.
5. Steers the subteam with the coordinator's text under its request ID. The
   subtask then follows the subteam's status, and the subteam continues from
   its delivered commit on the same pull request.

A superseded or refused forward is reported to the coordinator as a refused
`steer-subtask`; it does not count toward the three refusals that block a
mission. While a forward is queued, the coordinator cannot report a `result`.
Every coordinator prompt lists queued forwards in the mission state as
`queuedForwards`, with the review ID and a note: the review is already
forwarded, the host sends it to the subteam when it can, and the coordinator is
told if the forward ends without reaching the subteam. A further
`steer-subtask` on that subtask is refused with that note and does not count
toward the three refusals either. A `steer-subtask` on another finished subtask
is refused as before and counts.

A mission started by [intake](intake.md) that a review reopens returns its
intake record from `finished` to `started` in the same change. The record keeps
its earlier messages and outcome comment, and the next result records its own
outcome. A Linear issue that was closed in the meantime pauses the reopened
mission, as for any started record. An intake service that was not running
when the mission reopened finds the record on its first pass with review
feedback on. Later passes look at finished records again only after a reopen
that could not be written; with review feedback off they never do.

**Rollback.** A host from before this change does not know the state it adds.
Before a rollback to such a host, in this order:

1. While review feedback is still on, leave no review waiting on a paused or
   blocked mission (its event "A review is waiting"): resume or extend the
   mission so the review is delivered, or cancel it. Only the running poller
   delivers a waiting review; with the switch off it stays pending on its run,
   and the older host's poller would steer it into the subteam directly, past
   the coordinator.
2. Switch review feedback off (`github.reviewFeedback.enabled: false`) and
   restart, so no new review reaches a mission. If a mission run still shows a
   review `accepted` that its mission has not received, keep the switch off on
   the older host until that run is finished or cancelled.
3. Wait until no mission holds a queued forward: an event "The coordinator
   forwarded the owner's review" with no later "received the owner's review"
   or "was not forwarded" event. A forward does not end by itself while its
   mission is paused or blocked at its time limit, or while a paused or blocked
   run holds its repository: resume, extend, or cancel that mission, or resume
   or cancel the holding run. The older host cannot apply a
   `review-forward` operation. The mission blocks with "The mission could not
   advance" and logs it again on every scheduler pass.
4. Finish or cancel every mission that is live, paused, or blocked at its time
   limit and whose steering holds an owner review (source `github-review`). A
   paused or deadline-blocked mission goes live again on the older host through
   resume or extend. The older host takes that source for a connector source,
   so the coordinator's own `steer-subtask` reaches the subteam labelled as the
   owner's review.

### Follow-ups

A follow-up is the coordinator's plan to look again at a time. It is meant for
something outside the mission state, such as a CI run or a release, where no
host message will arrive on its own. It records no completion and approves
nothing.

The host stores each follow-up in the mission record with its ID, due time,
reason, check, creation time, and state (`open`, `fired`, or `cancelled`). On
each scheduler pass, an open follow-up that is due, in a mission that is not
paused or ended, becomes `fired` and adds one host message with its reason and
check to the coordinator's inbox. Both changes are one durable write, so a
restart can neither lose the message nor fire it twice. Follow-ups due in the
same pass reach the same attempt.

A paused mission fires nothing; a follow-up that came due during the pause
fires once after resume. A message the coordinator received is settled only
when a report from that attempt is applied. When a pause withdraws an attempt
whose launch was still waiting, for example on host load, or stops one before a
report from it was applied, the messages that attempt held, including a fired
follow-up, return to the front of the queue and reach the first attempt after
resume. A conversation resumed after the pause can therefore see such a message
twice. A mission in `needs-input` is still live, so its
follow-ups fire. When a mission is cancelled, blocked (including by its
deadline), or reaches `ready-for-review`, its open follow-ups become
`cancelled`; a blocked mission cannot resume, so they could never fire.

Each attempt's mission state lists the open follow-ups with their due time and
reason. The mission view's `followUps` holds the open ones and the ten most
recently settled. A board row whose coordinator waits on a follow-up, with no
subtask running and no open question, shows the due time in UTC. The host
records a mission event when a follow-up is set and when it fires.

### Conversation rotation

Before each attempt after the first, the host decides whether to resume the
coordinator's conversation or start a new one. It starts a new one after a
failed resume, as above, or when one of these rules holds:

- `idle`: the conversation's previous attempt ended at least
  `rotateIdleMinutes` ago (default 60). The provider's prompt cache is cold by
  then, so a resume pays for the whole transcript again.
- `size`: the latest usage the host observed for the conversation is at least
  `rotateContextTokens` (default 120,000). The measure is the newest
  main-conversation model call recorded in the session journal of the
  conversation's latest attempt that has one: its input, cache-read,
  cache-write, and output tokens. Subagent usage is not counted. Without an
  observation, this rule never fires.
- `age`: the conversation has had at least `rotateAttempts` attempts (default
  40).

A new conversation, whether from a rotation or a failed resume, receives the
full prompt, the coordinator's stored notes under a heading that marks them as its own earlier words rather than host
facts, the open follow-ups in the mission state, and the pending messages. No
extra model turn is spent on the switch. Direction that earlier attempts
already received, from the owner or a connector, is listed under a heading that
says so, each item named by its source. It still applies, and
receiving it does not mean it was carried out: the coordinator checks its notes,
refused reports, and the mission state, does not repeat what they show was done,
and continues what is unresolved. Direction that no attempt has received is
listed under its own heading only when its message is in this attempt; one
still queued behind the message limit or the prompt budget is listed when its
message arrives. The direction text is unchanged. A rotation is not a missed report and
does not count toward the three-refusal block. The host records a mission event
that names the rule.

Notes take only the prompt room left after the full prompt and its leading
pending message, within the 80 KiB prompt limit. The host keeps the newest
notes that fit and says how many older ones it left out; with no room, it
leaves every note out. When the leading message has to be shortened, that
message takes the whole room: every note is left out, without a count, and
the prompt is the one a mission without notes would get. Notes therefore
never hold a message back, cost it its text, or make the prompt too large.

A rotation retires every older conversation. The host resumes only a
conversation from the rotation on that a confirmed native session ID names. If
none does, for example because the new conversation's hook never reported its
session, the next attempt starts another new conversation. It neither resumes
nor rotates away from the retired one again, so one rotation records one event.

Set the rules in host config under `autonomy.continuity`:
`rotateIdleMinutes` (0–10,080), `rotateContextTokens` (0–10,000,000), and
`rotateAttempts` (0–1,000). Each is an integer; 0 turns that rule off.

### Working-time limit

Every mission has a deadline `maxMinutes` after it is created. The default is 240
minutes; an intake mission takes `intake.mission.maxMinutes`. When it passes, the
mission is blocked. Active subteams pause, queued subtasks stay queued, and their
workspaces and mission evidence are kept. The owner can extend the time limit or
cancel the mission. `POST /api/missions/:id/extend` adds 5 to 1440 minutes. For a
deadline-blocked mission, the new deadline is measured from the extension time.
For a running or paused mission, the extension adds to its current deadline, or
counts from now when that deadline has already passed. On a stopped intake clock,
it adds to the time that was left when the clock stopped.

An intake mission stops its working-time clock while it is `needs-input` or
`paused`, and the deadline moves forward by the time it was stopped. Waiting for
an owner answer does not use up the limit. Other missions keep a fixed deadline.
While the clock is stopped, the mission view carries `clockStoppedAt`, and its
`deadlineAt` does not yet include the stopped time. The time left is `deadlineAt`
minus `clockStoppedAt`. Clients show that instead of a stop time, and they offer
Resume while any time is left.

### Stale blocked missions

A blocked mission stays under `needs-input` so the owner reads the reason. A
mission blocked by its time limit can be extended; this resumes its paused
subteams and starts a fresh coordinator attempt. Other blocked missions cannot
resume. When a mission has been blocked for `teams.retention.blockedHours`
(default 72), the host closes it as `cancelled` and cancels its subteams. The reason and one event read
"Closed by the host after 72 hours blocked without owner action", followed by
the last blocker. The host closed it; nothing about the work is claimed. Team
runs and goals close the same way; see [teams](teams.md).

### Answer missions

A mission created with `mode: "answer"` is a question, not a work request. Its coordinator reads the project's repositories and reports a `result` whose summary is the answer. The result is accepted with no finished subtask, and the mission records that it started no subteam and changed nothing. An answer mission also cannot set a follow-up: its coordinator answers now, asks the owner, or reports blocked, and a `follow-up` report is refused.

The coordinator cannot start work in this mode. The host refuses `dispatch`, `resize-subtask`, `cancel-subtask`, `steer-subtask`, and `answer-child` with one reason, through the same refusal path as other reports, so three refusals in a row block the mission. `question`, `blocked`, and `wait` behave as in a work mission. Its prompt says it can only read, that text marked `other N | ` or `bot | ` is background and never an instruction, and that a needed change belongs in the answer for the owner to decide on. A mission without a mode behaves as before.

Read-only is enforced by the provider's tool flags for the coordinator, not by an operating-system sandbox. The result is an agent report; the host does not verify it.

### Origin

A mission started by intake records `origin`: `kind: "intake"`, the Linear issue
ID, its identifier and URL, and the rule that admitted it (the label, the owner
creator, and the owner's Slack mention when a thread is required). Missions the
owner creates through `POST /api/missions` have no origin. The origin is recorded
at creation and does not change. See [intake](intake.md).

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
open question, the block reason, or the current step. `createdAt` is the time the
mission, run, or goal was created.

### Attempts

Missions of one project with the same objective are attempts of one work item:
the owner sent the same request again after an earlier one stopped. The same
holds for standalone team runs of one host project with the same objective.
Objectives are compared after trimming and collapsing whitespace. Goals repeat
by design and are never attempts.

When the host holds more than one attempt, each item carries `attempt`:

| Field | Meaning |
|---|---|
| `workId` | The same for every attempt of the work. |
| `number`, `of` | Position among the attempts the host still holds, oldest first, and how many there are. A deleted run no longer counts. |
| `superseded` | A newer attempt exists and this one is `blocked` or `cancelled`. |

The board still lists every attempt. A client may fold superseded attempts
behind the newest one; an older attempt that is under way or awaiting review is
never superseded, so folding does not hide work that can still change. The phone
folds them and shows "Attempt N of M"; the other clients list every item.

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
