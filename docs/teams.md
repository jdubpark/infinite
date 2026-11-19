# Goals and agent teams

Open **Goals** in the web client to give the agents a product outcome, evidence,
and limits. The coordinator investigates the project, selects a useful change,
and sends bounded tasks to parallel workers. A successful cycle produces an
isolated branch with check results and an independent agent review. The next cycle starts
from that reviewed commit, or its recorded merge commit when delivery is enabled.

Use **Teams** for one feature request or pasted PRD. A team plans and implements
that request without selecting a sequence of follow-up improvements. Both flows
show member sessions, questions, steering, file ownership, and verification
records. The web interface supports desktop and narrow phone browsers. The
native phone app has **Teams** and **Goals** tabs beside its sessions. It
starts, answers, steers, pauses, resumes, continues eligible blocked runs, and
cancels runs with the same roles and request rules as the web client, and
records goal outcomes. It opens member sessions, and a member session links
back to its team. The Mac app shows Teams only.

A team opens on the same layout in the web client, the phone app, and
`infinite team watch`. Open decisions come first. The Jevcode summary follows,
in the briefing order: the outcome, system shape, ranked **Review first** items
with their priority and question, what changed, check evidence, guidance for
agents, and gaps. System shape and guidance start collapsed on the web and
phone. **Review logs** shows one agent's terminal screen and recent control
events. Each agent has a control, Previous and Next step through them, and
**Back to summary** returns. On the web and phone, the plan, members,
verification, and run history sit under **Run details**. The summary is the
briefing agent's reading of recorded activity. It is not completion or approval.

A Team marked **ready for your review** has explicit reports for its current revision,
passing configured checks, and an approving reviewer report. It does not
establish product impact or human acceptance. The host does not push, open pull
requests, merge into the original checkout, or deploy.
The paired CLI can bring a team's integrated branch into an ordinary local branch with `infinite team pull TEAM_ID`.

A run started without its own title is named by its request's first line, and the
full request stays visible on the run as "Your request". A first line longer than
60 characters gets a shorter title in the background. Local paths and file URLs
are removed from the request first; quote a path that contains spaces so it is
removed whole. With `jev` configured, Jev keeps the clipped line when it reads
clearly; otherwise the `summaries` writer names the request. Once the coordinator's plan arrives,
its brief title replaces either form; a title the owner wrote is never replaced.
A Linear issue created for the run follows these renames, and any concurrent edit
to its description, project, or parent still blocks the run. A title edit made on
Linear also blocks it, with one exception: a rename request the host sent but
never got an answer for may still commit, so a change to that exact title is
treated as the late rename and renamed back to the run's newest title.

## Start from a terminal

The paired laptop CLI can enroll a repository and control the same Teams shown
in the web client. See [CLI repository setup](cli.md) for command options.

```sh
cd /path/to/project
infinite repo init
infinite team start "Implement the checkout retry behavior described in the issue"
infinite team start --prd docs/checkout-prd.md
infinite team status
infinite team status TEAM_ID
infinite team status TEAM_ID --logs
infinite team watch TEAM_ID
infinite team steer TEAM_ID "Keep the existing checkout layout"
infinite team answer TEAM_ID QUESTION_ID "Use the existing retry policy"
infinite team continue TEAM_ID "Preserve the current checkout design"
```

`infinite team status` without an ID lists each team's members, tasks, and open
questions. `infinite team status TEAM_ID` prints that team's decisions and
Jevcode summary, wrapped to the terminal width. Each open decision shows the
`infinite team answer` command that answers it.

`infinite team watch TEAM_ID` keeps that summary full screen and refreshes it
every two seconds. The bottom line lists the keys for the current view:

| Key | Action |
| --- | --- |
| `l` | Open the review log |
| `s` or `b` | Return to the summary |
| `←` `→`, or `n` `p` | Next or previous agent |
| `↑` `↓`, or `j` `k` | Scroll one line |
| Space, Page Up, Page Down | Scroll one page |
| `g` `G`, Home, End | Jump to the top or bottom |
| `a` | Ask Jevcode for a summary when it is empty or failed |
| `q` or Ctrl+C | Detach |

A refresh keeps your scroll position; switching view or agent starts at the
top. A failed refresh keeps the last card on screen under a notice. A
non-interactive watch prints again only when the visible text changes.
`--logs` starts in the review log. `infinite team status TEAM_ID --logs` prints
the current revision's review logs once. `--json` still prints the team record.
Set `NO_COLOR` to drop bold headings and the highlighted key bar.

Repository setup records a private binding between the local Git root and the
selected host project. A new remote source receives a committed Git snapshot;
ignored files and uncommitted changes are not included. Existing cloud sources
are not replaced by enrollment. Setup and verification commands belong to that
repository, while the coordinator, workers, and reviewer come from the host's
configured lineup. The host passes the selected project ID to Ubuntu provider
wrappers as `INFINITE_PROJECT_ID`, which selects an optional project environment
file on that host. First-time repository enrollment delegates current one-shot
tool requests to the configured permission reviewer, using the strong coordinator
when no reviewer profile is configured; `--permissions off` opts out.
The repository policy bounds that authority; see
[Delegating permission decisions](#delegating-permission-decisions).

`--source` picks where the host gets the repository. `infinite repo init` records
`github` when `origin` is an HTTPS or SSH `github.com` URL without embedded
credentials, and `laptop` otherwise. `--source laptop` keeps workspace sync for
the checkout, and `--source github` switches an enrolled project to GitHub mode.
Enrolling a `github` project still uploads a one-time snapshot so the project
directory exists at once. The first refresh then fast-forwards it to the base
branch. See [GitHub-tracked sources](#github-tracked-sources).

A rerun keeps every team setting that the command does not set itself: the handoff time limits, the feature map, and eval capture.

A new empty repository can enroll immediately after `git init`. Its cloud source
gets an empty baseline commit; local Git history and files stay unchanged. When
no checks exist, enrollment records `checks: []` and `establishChecks: true`.
This owner opt-in authorizes the coordinator to define verification commands.
The first plan must include `verification` with one or more `checks` and an
optional `setup` command, each using the existing command/argument format.

The host saves those commands before implementation and retains them through
steering, retries, restarts, and later goal cycles. A plan cannot replace existing
configured checks or change accepted commands. Setup runs after integration so
workers can create the project first. Failed checks enter bounded repair; the
team cannot become ready for review without passing checks and an independent
review of both the implementation and its verification. Check commands execute
under the configured host command identity, with the same environment filtering,
timeouts, and interruption handling as configured checks. This opt-in does not
approve provider permissions or allow a denied tool to be bypassed.

Add the repository's Linear team and project mapping during enrollment to track
new runs. Supply the IDs once per parent folder to reuse them across its child
repositories; each child can then run `infinite repo init` without Linear flags.
Existing repository mappings remain in place when parent defaults change.
A mapping is configuration, not proof of connectivity: each run shows
whether Linear has confirmed its issue and execution evidence. Historical runs
remain unchanged. Run status, verification, and human acceptance retain the
separate meanings described below.

## Scheduled routines

An owner can create a finite routine for a project enrolled with `infinite repo init`.
Each occurrence submits the routine's fixed goal to the existing GoalService,
which applies the same project enrollment, execution policy, path scope, provider
permissions, delivery policy, and review requirements as a manually started goal.
The independent reviewer and the existing scoped coordinator approvals remain
part of each goal cycle.

Create a JSON file with the goal scope, explicit budgets, and finite schedule.
Use a stable request ID in the file or pass it on the command line so an
uncertain create can be retried safely:

```json
{
  "goal": {
    "projectId": "project-id",
    "title": "Keep the project guide current",
    "objective": "Review and improve the project guide using current repository evidence.",
    "successCriteria": "The guide is accurate, scoped, and independently reviewed.",
    "allowedPaths": ["docs"],
    "nonGoals": ["Change application behavior"],
    "evidence": ["Cite the repository evidence used"],
    "maxRuns": 2,
    "maxMinutes": 60,
    "maxTotalMinutes": 90,
    "maxMembers": 8,
    "parallelism": 2
  },
  "intervalMinutes": 10080,
  "maxOccurrences": 3,
  "startsAt": "2026-11-10T00:00:00Z",
  "expiresAt": "2026-11-27T00:00:00Z"
}
```

Replace the example project ID and dates with an enrolled project and future UTC
timestamps. Approval must expire within 30 days of creation; the entire next
goal's time ceiling must fit before expiry. The aggregate upper bound is the occurrence
count multiplied by each goal's total time ceiling (`maxTotalMinutes`, or
`maxMinutes` when no total ceiling is set); `maxRuns` limits cycles within each
goal occurrence. A routine is refused or
blocked if the enrolled execution policy changes; review the new policy and
create a new owner-approved routine to use it.

```sh
infinite routine create --file routine.json --request-id REQUEST_UUID
infinite routine list
infinite routine status ROUTINE_ID
infinite routine pause ROUTINE_ID --revision 1
infinite routine resume ROUTINE_ID --revision 2
infinite routine cancel ROUTINE_ID --revision 2
```

Use `--json` for machine-readable records. `infinite routine status` shows
the revision needed for the next action, occurrence goal IDs, the active goal,
next due time, and any blocking reason.
Watch each goal on the existing board or with `infinite usage goal GOAL_ID`.
Pause and cancel stop future triggers; an already active goal continues under
its own controls and limits. Resume does not change the approved scope or resume
a child goal. A blocked, needs-input, or limit-reached child stops further
triggers until an owner reviews and resolves the state, then explicitly resumes
the routine when it remains eligible. A changed project approval policy needs
a new owner-approved routine. A completed review does not itself authorize
merge or infer that the goal was achieved.
Missed schedule ticks are coalesced, so downtime does not produce a burst of
catch-up goals.

A routine can also wake on [project signals](#project-signals). Add `wakeOn`
to the file with up to four signal kinds, for example
`"wakeOn": ["revert", "owner"]`. When a matching signal arrives, the routine
starts its next occurrence early instead of waiting for its next due time:

- It reads signals only while it is scheduled or running. A paused, blocked,
  or ended routine reads nothing and keeps its place in the inbox.
- Signals recorded before the approval never wake it.
- It ignores signals about the team runs of goals it started, so its own
  delivery never wakes it.
- An early start waits until `autonomy.continuity.wakeMinGapMinutes` (0 to
  1,440, default 5) have passed since the previous occurrence ended.
- Every other rule still applies: the start time, the expiry,
  `maxOccurrences`, the time budget, the launch-rate fuse, and the busy-project
  rule. When the project is busy, the waiting signals wait for the next due
  time.
- Signals that arrive while an occurrence runs start at most one follow-on
  occurrence.
- Signals that arrive together start one occurrence. The routine reads 50
  signals a pass and starts nothing while more wait, so a large batch delays
  the start by a few seconds and never splits into two occurrences.
- An early start needs a readable inbox. While the inbox cannot be read, the
  routine runs on its schedule only, and the waiting signals keep waiting for
  the next start that can read all of them.
- The occurrence lists the signal IDs it started on under `wake`. It submits
  the same goal as any other occurrence.

`wakeOn` is part of the approval and cannot change later. A routine without it
runs on its schedule only.

### Navigating large repositories

For large codebases, agents can use [Graphify](https://github.com/Graphify-Labs/graphify)
to find relevant symbols and relationships before reading source. Install the
tested `graphifyy==0.9.104` package in an isolated Python environment on the
execution host. Keep its output in a private scratch directory outside the
repository, scoped to one checkout and accessible to that run's agent identity.

```sh
graphify extract REPOSITORY_PATH --code-only --max-workers 2 --out GRAPH_DIRECTORY
graphify query 'RoutineService' --graph GRAPH_DIRECTORY/graphify-out/graph.json --budget 1500
```

Use code-only extraction for this workflow; semantic extraction, hosted graph
uploads, global hooks, and cross-repository graph merging are not required.
Record the checkout revision and dirty-file state alongside the graph, and
refresh extraction after source changes. Query specific symbols with a bounded
output budget; inspect truncation and skipped-file warnings. Open the referenced
source at the current revision before making a change or review claim. A graph
may omit files or relationships and does not establish test coverage, independent
review, completion, or permission to act. If the tool is unavailable to the
agent, continue with direct repository search and report the coverage gap.

## GitHub-tracked sources

A project in `github` source mode follows its base branch on GitHub. The host
keeps that branch current without a laptop process, and team runs start from the
current base. [Source modes](workspace-sync.md#source-modes) explains how a
project gets this mode.

### Host mirror

The host keeps one bare Git mirror of the base branch for each `github` project,
at `PROJECT_ID.git` under `source-mirrors`. That directory sits beside
`teams.workspaceDir`, or under the host state directory when no team workspace
directory is set. Set `source.mirrorDir` to an absolute path in host configuration
to choose another parent. The mirror lives outside every project directory and
every team workspace.

```json
{
  "source": { "mirrorDir": "/srv/infinite-data/source-mirrors", "refreshMinutes": 5 }
}
```

Agents can write the mirror. The API account creates it, but the fetch that
fills it runs as the agent identity through `teams.commandPrefix`. On the Ubuntu
template only that identity can reach the GitHub App token. A constrained
launcher that clears global Git configuration must attach that credential helper
to the mirror fetch itself, for example as `-c credential.https://github.com.helper=…`
on that one operation; without it a private repository fails as `auth`. The mirror is
group-writable with the setgid bit (`2770`) when `sync.sharedGroup` is set, and
`0750` otherwise. This grants agents no power over the base that they lack today,
because they already write the project directory that team runs clone. The mirror
keeps team runs apart from the working tree that sessions edit. It does not
protect the base from agents. The working tree stays a detached checkout with no
GitHub remote, so only the mirror fetches from GitHub.

### Refresh

A refresh is one unit of work per project, and only one runs for a project at a
time. It does these steps in order:

1. Fetch the base branch from GitHub into the mirror, through the command prefix.
   A failure records a category (`auth`, `network`, `not-found`, or `other`) and a
   fixed message. The stored message never contains Git output, a URL, or a token.
   After a failure the timer waits twice as long before each further attempt,
   from the refresh interval up to one hour, until a fetch succeeds. An explicit
   refresh and the refresh before a team run always attempt the fetch.
2. If the mirror head moved and no cloud session is running or starting in the
   project directory, fast-forward the working tree to the new head and record
   `appliedAt`. Team runs, goals, and handoffs do not count as sessions here,
   because they work in their own clones.
3. If a session left tracked edits in the working tree, commit only those edits on
   a local branch named `infinite/saved-YYYYMMDD-XXXXXXXX`, with a fixed message.
   Then return the tree to a clean detached checkout. Untracked and ignored files
   stay in place, so installed dependencies and generated reports survive. The
   saved branch appears in the project's status.
4. If the working tree's `HEAD` is not an ancestor of the new head, leave the tree
   as it is and record `diverged`. This covers a session that committed on the
   host, and a snapshot that had commits on a feature branch when the project
   switched to GitHub mode. The owner or coordinator resolves it. A refresh never
   resets the tree or discards tracked edits.

While the fast-forward in step 2 runs, new sessions in the project wait with
`409 source-refreshing`. The fetch in step 1 does not block sessions.

### Triggers

A refresh runs:

- on a timer, using `source.refreshMinutes` (default 5, from 1 to 1440). The host
  checks every minute and fetches a project whose last successful fetch is older
  than the interval;
- before a team run prepares its workspace, and before a goal or mission
  continuation does (see [Team runs](#team-runs));
- after the host records a `--delivery merge` merge report for the project;
- at the end of `infinite repo init` for a `github` project;
- on demand, through `infinite repo refresh`, the **Refresh from GitHub** button
  in the web and phone apps, or `POST /api/projects/:id/source/refresh`.

### Status

`GET /api/projects/:id` returns `source` for every project. A laptop project
returns `{ "mode": "laptop" }`. A `github` project also returns:

- `repository` and `baseBranch`;
- `mirrorHead` and `fetchedAt`, the base head the last successful fetch saw and when it ran;
- `appliedHead` and `appliedAt`, the commit the working tree last reached;
- `savedBranches`, the local branches that hold saved edits;
- `pending`, with `reason`, `since`, and for some reasons `category` and `message`.

| Reason | Meaning | Message |
| --- | --- | --- |
| `fetch-failed` | The last fetch failed | `auth` says `grant the GitHub App access to OWNER/REPO`. `network` says `the host could not reach GitHub`. `not-found` says `GitHub reports no such repository or branch for the configured source`. `other` says `the fetch from GitHub failed`. |
| `session-running` | A session holds the working tree, so the fast-forward waits | None |
| `diverged` | The working tree has commits that are not on the base branch | `the host checkout has commits that are not on BASE` |
| `apply-failed` | The fast-forward or the save failed | A category from the [host-side table](workspace-sync.md#host-side) and a fixed message |

The CLI prints one line for each state. These examples use placeholder
repositories and heads:

```text
follows github example/product@main · host 0123abcd = origin/main · fetched 2m ago · applied 2m ago
follows github example/product@main · host 0123abcd, origin/main 4567ef01 · fetch failed 14m ago: auth · grant the GitHub App access to example/product
follows github example/product@main · host 0123abcd, origin/main 4567ef01 · waiting: session running
follows github example/product@main · host 0123abcd = origin/main · saved local edits on infinite/saved-YYYYMMDD-XXXXXXXX
follows github example/product@main · host diverged from origin/main
```

### Team runs

A team run for a `github` project refreshes the source first. It then clones the
mirror, not the project directory. The run's `baseCommit` is the mirror's
base-branch head at that moment.

- If the fetch failed but the mirror already has a head, the run starts from that
  head. The run records `baseStale` with `reason: "fetch-failed"`, its category,
  and the last `fetchedAt`. Its event log says GitHub could not be reached.
- If the mirror has no head yet, the run is refused with `source-unavailable`
  (409). The message points to the project's source status.

Goal and mission continuations keep cloning the parent run's integration checkout,
because they continue that run's branch. The host refreshes the mirror before they
start, with a maximum age of one minute. When the mirror head descends from the
parent's head and differs from it, the continuation records
`baseBehind: { mirrorHead }`, so the coordinator can rebase early instead of at
delivery.

Each integration records what changed. The run's `changes` lists the files changed from its base to its recorded head, each with a status of added, modified, removed, or renamed and its line counts (`null` for binary files). It holds up to 400 files and sets `truncated` when more changed. Each integrated task's `changedPaths` lists the paths its own change touched, up to 200, with its own `truncated` flag. Git reads for these fields are best-effort: if Git refuses or fails a read, the field is absent and integration still succeeds.

Runs also write run events to the evidence store: `run.created`, `run.blocked`, and `run.settled`, with a summary of the run's counts when it settles. Each run keeps its events in a small outbox inside its record until the store accepts them, and a restart does not lose them. The events only record what the run did. A run behaves the same whether or not its events are stored, and a store that stays unavailable never stops or changes a run.

Runs also mirror their reports, integrations, check results, and owner directions into the evidence store as entries, and record each member's launch sizes. The owner reads them with `infinite team entries` and `infinite team entry`. Entries and sizes never change a run.

Member entry tools are off by default. `config.teams.blackboard.tools` turns them on. The switch has no default, and it is part of the routine digest, so a routine blocks when it changes. A run pins the switch at creation only when it is `true` and the evidence store is ready. A run created otherwise keeps today's prompts and context files for its whole life. With the switch on, project managers, scouts, implementers, integrators, and reviewers get three tools: `entry_post`, `entry_list`, and `entry_get`. A post is one of `contract`, `finding`, `blocker`, or `handoff`, and a handoff needs the author's own task. Every member entry is a claim by its member, and it never changes an assignment, a scope, or the reporting rules. The session worker refuses a post that holds a private key, a known access token shape, the member's hook token or hook address, or a credential the host gave the session (a GitHub grant, an egress proxy password); the refusal names the field and never repeats the text. Caps per attempt: 20 posts and 64 KiB of bodies, 12 KiB per body, 16 KiB per request, and 256 KiB served across reads, with 200 read calls. A run holds at most 400 member entries. A member's context file carries a digest of at most 4,096 bytes. The owner withdraws an entry with `infinite team entry TEAM_ID ENTRY_ID withdraw`. Members then stop listing and getting it, and the owner still reads its body.

The host adds no `--allowedTools` for Claude members. The entry tools follow the profile's permission mode, as `report` does. A Claude profile whose own arguments set an allow-list must name `mcp__infinite_team__entry_post`, `mcp__infinite_team__entry_list`, and `mcp__infinite_team__entry_get`, or the provider refuses the three tools.

## Workspace retention

Team workspaces are host-managed temporary copies. By default, merged and
no-change runs lose their integration and member clones 60 minutes after all
members stop; cancelled runs lose their clones and run record after 60 minutes. A
ready-for-review run keeps its clones for 24 hours, and a blocked run keeps them
for 72 hours. The `teams.retention` settings (`finishedMinutes`,
`cancelledMinutes`, `reviewHours`, `blockedHours`, `memberMinutes`) change these
windows. A run that belongs to a goal, mission or handoff that is still active
keeps its merged, no-change or ready-for-review clones until that owner finishes,
because the next cycle clones from them. Full-run cleanup waits for settled
members and for pending operations and live commands to finish. A stopped
member's clone can be removed earlier, after its result was integrated and
`memberMinutes` (default 60) has passed; the host leaves a pending operation's source clone in
place and keeps a clone that a replacement member still uses as its working
directory.

A paused subteam keeps its workspace while its mission is blocked by the
approved time limit. The mission owner can extend the limit to resume it. If the
mission is cancelled or closed after the blocked retention period, it cancels
the paused subteam and normal cancelled-run retention applies.

Removal also waits for head publication; see [Head publication](#head-publication).

Before removing a cancelled or blocked run's workspace, the host also saves each
eligible member clone's unfinished work to its GitHub repository. It waits for a
successful save or five failed attempts before removing the run workspace.

The run record, events, reports, and receipts remain after merged, no-change,
ready-for-review, and blocked workspaces are removed. After a blocked run's
workspace removal completes, the host closes it as `cancelled` with the last
blocker in its reason; it does not claim the work is complete. Its record then
uses the normal `cancelledMinutes` retention. The outcome ledger keeps the run
as blocked: the close writes no second settled event. A blocked run that
still holds an unresolved operation keeps its workspaces unless the host looks
and finds no process of that operation. The host records each command an
operation starts, as the leader of its own session and process group, and while
the operation runs it samples the process table for descendants that moved to
other sessions or groups. The saved intent says that this record may be
incomplete from before a command starts until a save holds it. While such a run
is blocked or paused with no command of its own running, the host looks at most
every ten minutes for processes that match the record, and for any process of
the host account or of the account that runs team commands that uses the run
directory as a working directory, open file, or command-line argument. The
run's events record each change in what the host saw, and keep the two kinds
apart: a process that only uses the directory is not called the operation's
process. After `teams.retention.blockedHours` the host closes the run only when
a look taken at that moment, in two passes, finds neither kind; the workspaces
are then removed and the run closes as described above. In every other case the
run keeps its workspaces and stays blocked: when a look finds a process; when it
cannot finish; when a process of those accounts refuses inspection; when the
record overflowed; or when an earlier API process stopped while the record was
marked incomplete and the host has not rebooted since. In the last four cases
the host says it cannot tell. The host never signals or stops a process it
finds. The look has stated limits: it does not inspect other accounts or a
process that left its recorded session and group and no longer uses the run
directory, and it is evidence about left-over processes, not a defense against
a process that hides on purpose. An intent recorded by an older host has no
process record, so its run keeps the earlier behavior: elapsed time alone never
closes it, and the owner cancels or reconciles it. Started and completed removals are
recorded as host events, and a failed removal is retried on later scheduler
ticks. A blocked run whose workspace is being removed cannot resume, continue,
or be steered. An owner can cancel a blocked run directly after its goal or
mission is no longer active. `DELETE /api/teams/:id` and `infinite team delete ID` remove a settled
cancelled, merged, or no-change run (clones and record) immediately. A live
goal, mission, or handoff that still uses the run as its source receives
`team-retained`; `team-in-use` means another run has a pending preparation that
clones from this workspace. Both removals can be retried once the reference
settles. Deleted request IDs are kept in the sealed `retired.sealed` tombstone,
up to 2,000 IDs with the oldest dropped. Replaying one returns `team-deleted`;
start another run with a new request ID.

Retention marks a workspace removal as started in the run record, then removes
the tree outside the serialized team mutation queue. At most two background
removals run at once. Completion and distinct failures are recorded as host
events; failures clear the removal marker and retry on a later scheduler tick.
After a restart, a surviving path with a persisted removal marker is retried;
cancelled records are deleted only after the run directory is gone.
`idle()` waits for background removals in tests and shutdown tooling; `close()`
does not wait for them. An active team cannot be deleted.

When storage falls below `teams.storageFloor`, new runs are refused before their
workspaces are created. See the configured reason in the API response and free
space before retrying.

## Eval capture

Eval capture keeps each implementer task of a finished team run as an eval task. A later replay can run other configurations on the same tasks. This slice only captures and sorts them. Capture spends no model tokens, starts no session, and reads the corpus for no decision.

Capture is off by default. Only a project in `github` source mode captures. A laptop project writes nothing and reads nothing.

**Turn capture on only after the owner has admitted the patch form and the capture name list in the launcher** (see [Git forms](#git-forms)). Until then every task ends `capture-failed`. While the base check form is refused, every task ends `base-not-proven`.

Capture never changes a run. A failed, stalled, or slow capture never delays a run, takes an enrichment slot, or reaches a member.

### Settings

Set `eval` in the project's team block, through the owner-only `PUT /api/projects/PROJECT_ID/team` route or the configuration file. Only `capture` is needed:

```json
{ "team": { "eval": { "capture": true } } }
```

The schema is strict, so an unknown key refuses the write. At this stage every field is optional.

| Field | Limit | Default | Meaning |
|---|---|---|---|
| `capture` | boolean | `false` | Turns capture on. Read only for a `github` project. |
| `testPaths.prefixes` | up to 32 paths, 200 characters each | host rule | Directories whose files count as tests |
| `testPaths.suffixes` | up to 32 suffixes, 64 characters each | host rule | File-name endings that count as tests |
| `excludeAreas` | up to 32 area IDs | none | Feature-map areas whose tasks never enter the corpus |
| `retentionDays` | integer, 30 to 3650 | 365 | Days a captured task is kept before the sweep removes it |

- A prefix is repository-relative. It cannot start with `/`, contain `..`, `.git`, `.`, an empty segment, or glob characters.
- Without `testPaths`, the host rule applies. It counts a file as a test when a path segment is `test`, `tests`, or `__tests__`, or when the name contains `.test.` or `.spec.`. When `testPaths` is set, it replaces that rule and needs at least one prefix or suffix.
- An area ID is lowercase letters, digits, and hyphens, up to 40 characters. An ID that the feature map does not know refuses every task with `excluded-area-unknown`.
- `infinite repo init` keeps every team setting it does not own, `eval` included, when it runs again.
- A client from before that change, and any client that sends a whole team block without `eval`, replaces the block and turns capture off. That fails safe, and nothing reports it.

### What a captured task keeps

An implementer task is captured when its commit integrates. It keeps:

- **The capsule.** The run's objective, the steering and owner answers dated before the member started, the brief and goal context when the run has them, and the task's ID, title, instructions, and paths. It is capped at 65,536 bytes of canonical JSON. A capsule over the cap refuses the task. It is never cut.
- **Two binary patches.** The base delta, from the run's base to the member's base, when they differ. The reference, from the member's base to the task commit.
- **File lists.** The reference's files, its hidden test files, and the files that later commits of the run changed.

It never keeps a rendered prompt. The capsule holds the inputs that the prompt builder uses, so a later replay can render them again.

All of this is sealed in the evidence store. See [Evidence store at rest](security.md#evidence-store-at-rest).

### States and reason codes

A task starts as `captured`. It becomes `candidate` when the outcome ledger counts its attempt as accepted and every other check passes. Otherwise it becomes `rejected` with one code. A `candidate` can become `rejected` later, for example after an owner exclusion.

The decision waits for three facts: the capture reads, the approval read, and the frozen ledger row. The facts can arrive in any order, and every order gives the same result. A timer pass makes the decision, every 60 seconds, for at most 100 rows a pass, oldest check first. A restart turns a read that was still running into a failure.

Start codes. The task is `rejected` before any read.

| Code | Meaning |
|---|---|
| `ui-changes` | The run's brief says it changes the user interface. |
| `start-unknown` | The member has no start time, so no capsule can be cut. |
| `capsule-too-large` | The capsule is over 65,536 bytes. |
| `excluded-area-unknown` | `excludeAreas` names an area that the feature map does not have. |
| `capture-busy` | The queue is full, or four reads have stalled. |

Material codes. The task is `rejected` after the reads.

| Code | Meaning |
|---|---|
| `capture-failed` | The reference's name read failed or threw. |
| `reference-too-wide` | The reference lists more than 500 files, or its list was cut. |
| `excluded-area` | A reference file is in an excluded area. |
| `no-hidden-tests` | The reference has no test file, or only test files. |
| `patch-too-large` | A patch is over 1,048,576 bytes. |
| `corpus-full` | A project or host material cap would be exceeded. |

Promotion codes. The ledger's decision rule runs first, then the facts, in this order.

| Code | Meaning |
|---|---|
| `ledger-missing` | The run was deleted, and its ledger row no longer exists. |
| `ledger-withheld` | The ledger withholds the attempt because it is backfilled or has a gap. |
| `excluded` | The owner excluded the attempt. |
| `same-model-review` | The approving review ran on the same model as the work. |
| `not-accepted` | The ledger counts the attempt as not accepted. |
| `acceptance-unknown` | The ledger cannot tell whether the attempt was accepted. |
| `patch-missing` | A patch could not be read, or the patch form is refused. |
| `reference-unknown` | The approval read is missing, or the later-change list was too wide. |
| `reference-ambiguous` | A later commit of the run changed a reference file. |
| `base-not-proven` | Form 3 did not prove that the anchor is on the mirror's branch. |
| `features-unknown` | The ledger row has no usable risk level. |
| `unreadable` | A sealed payload does not open. |

An unfrozen ledger row waits. A ledger row that does not open leaves its task as it is, and the pass counts it as `unreadable`.

A missing fact stays missing. A refused patch is never stored as empty. A truncated list is never read as complete. An unknown acceptance is never a refusal or an acceptance. An empty reference patch counts as missing, because a captured task has at least two files, so an empty read means the read failed without saying so. An empty base delta is kept, because two different commits may have equal trees.

### Deletion and retention

- A deleted run keeps its captured tasks only when it merged or needed no change. Any other deleted run, and a run with no readable status, takes its tasks and their sealed material with it. The status is the run's last `run.deleted` or `run.settled` event.
- A kept task is stamped with the deletion time, and retention removes it later.
- Retention removes a task once its capture time is older than the project's `retentionDays`. A task whose project is no longer configured keeps the default of 365 days. The sweep removes at most 100 rows a pass.
- Removing a run's clones does not change a captured task.

These are the defaults this slice ships. The owner has not yet decided them (spec owner decision 5). They stand until the owner changes them.

### Caps

| Cap | Limit | Result |
|---|---|---|
| Capsule | 65,536 bytes | `capsule-too-large`, never cut |
| Patch | 1,048,576 bytes each | `patch-too-large` |
| Reference file list | 500 names | `reference-too-wide` |
| Later-change list | 2,000 names | `reference-unknown` |
| Tasks, per project | 20,000 rows, rejected rows included | No new row |
| Material, per project | 134,217,728 bytes (128 MiB) | `corpus-full` at completion |
| Material, per host | 536,870,912 bytes (512 MiB) | `corpus-full` at completion |

A new task is refused at 20,000 tasks for a project. The byte caps are checked when the material completes: a completion that would pass either material cap rejects the task `corpus-full`, and every part is removed.

### Queue limits

| Limit | Value | Effect |
|---|---|---|
| Queued captures | 64 | A marker over the limit is `capture-busy`. |
| Concurrent reads | 2 | Other reads wait in the queue. |
| Stalled reads | 4 | While four reads are stalled, every new capture is `capture-busy`. |
| Read deadline | 35 seconds | A read that runs longer counts as failed, and as stalled until its call settles. |
| Git process | 30 seconds | A Git read that runs longer is stopped. |

Capture writes one log line per code per process: `Eval capture skipped (CODE).`. The code is `capture-busy` or `corpus-full`. No log line carries a file name, a commit ID, or any other text.

### Git forms

Each capture read runs through the team Git prefix, with the six `-c` settings. A commit ID must match 40 or 64 lowercase hexadecimal characters before it enters an argument.

| Form | Command | Limit | If refused |
|---|---|---|---|
| 1. Patch (new) | `git diff --no-ext-diff --no-textconv --no-color --binary --default-prefix --no-renames --submodule=short --ignore-submodules=none --unified=3 --inter-hunk-context=0 FROM TO --`, in the run's integration checkout | 1,048,576 bytes; Git 2.41 or later | The patch is `missing`, and the task ends `patch-missing`. |
| 2. Name list of capture (new) | `git diff --no-ext-diff --no-textconv --name-only --no-renames --ignore-submodules=none -z FROM TO --`, in the same checkout | 500 names for a reference; 2,000 for later changes; 64 KiB of output | Every capture ends `capture-failed`; a later-change list leaves the approval unknown. |
| 3. Base check (reused, form 1 of the base scan) | `git merge-base --is-ancestor ANCHOR HEAD`, in the source mirror, where `HEAD` is the mirror's head | 30 seconds | Every task ends `base-not-proven`. |

Form 3 is in a launcher audit that is pending with the outcome-ledger release. Forms 1 and 2 need the owner's launcher approval before capture is turned on. The launcher must also end each of the three reads by itself after 35 seconds: the host may not signal a command that the launcher runs as another account, and a read that hangs there holds one of four places until it ends.

## Eval mining and validation

Mining finds commits on a project's base branch that change a test file and another file. Validation runs each such commit's focused test as the grader account. A task becomes `valid` only when its runner reports show the expected cases failing on the base and passing on the reference. Neither step spends model tokens, starts a session, or changes a run. Both are off until the owner turns them on.

Read this section before turning either one on. The grader account and the Git forms need owner steps first. See [the grader install](../deploy/ubuntu/grader.md) and [the grader's security boundary](security.md#eval-grader-account).

### Turn it on

1. Set up the grader account, if you want validation. Steps 1 to 4 of [the grader install](../deploy/ubuntu/grader.md) do it.
2. Add the Git forms of [the mirror](#git-forms-of-mining-and-validation) to the production launcher.
3. Set `eval.grader` in the host configuration. Without it, validation cannot start.
4. Set `mine` for mining, and `focusedTest` and `reportFormat` for validation, in the project's `eval` block.
5. Create a validate job with `infinite eval run PROJECT`. Mining runs without a job.

### Settings

Set the fields in the project's `eval` block, as the capture section shows. They are read only for a `github` project. The schema is strict.

| Field | Limit | Default | Meaning |
|---|---|---|---|
| `mine` | boolean | `false` | Turns mining on. |
| `gradingPaths` | up to 64 repository path prefixes | none | Paths that a round takes from the reference, so a result cannot change them. |
| `focusedTest` | a command with `{files}` as one whole argument and `{report}` once in the arguments | none | The test that each round runs. Validation needs it. |
| `reportFormat` | `junit` or `tap` | none | The format that the focused test writes to `{report}`. Validation needs it. |
| `guardChecks` | up to 8 commands | the project's `checks` | Commands that must pass on the reference copy. |

- The placeholder `{files}` becomes one argument per hidden file, each written as `./` plus its path. A file name cannot read as an option.
- The placeholder `{report}` becomes a path in the grader's work directory, `reports/round-N.xml` or `.tap`.
- The team's `setup` command, when set, runs before the tests of each round.
- `excludeAreas` and `retentionDays` also apply to mined commits.

The host configuration has one block for validation, `eval.grader`:

| Field | Limit | Meaning |
|---|---|---|
| `prefix` | a command and its arguments | The launcher the host runs as the grader. |
| `root` | an absolute path | The grader's root. |
| `canaries` | up to 32 absolute paths | Files that the grader must not read. |

The `eval` block of a project and the `eval.grader` block do not change a run, a member's prompt, or a team view. The routine approval digest leaves them out.

### Mining

Mining reads the base branch of the project's mirror (`source.baseBranch`). Each pass mines at most 50 commits. A pass has two parts.

1. **Forward.** The first-parent commits added since the last pass, oldest first. A pass keeps the newest 500 new commits. Older new commits are not mined or counted.
2. **Backfill.** The older first-parent commits, newest first. The backfill stops after 2,000 commits are visited.

The first pass sets the cursor at the head of the base branch. Each commit is decided and the cursor moves in one transaction, so a restart neither skips nor repeats a commit. A rewritten branch restarts the forward walk at the new head: the head is decided first, then the backfill walks down from it within its 2,000-commit bound. Rows that exist stay.

Each commit is decided in this order:

1. A root commit is `skipped`.
2. A commit with no test file, or with no other file, is `skipped`. It leaves no row.
3. A commit that breaks a rule in the table below is rejected with that rule's code. The table lists the codes in the order the host checks them.
4. A commit that breaks no rule becomes a `candidate`, and its groups are updated.

A refused read or a failed read is not a rejection. It ends the pass, as described below.

A mined capsule holds the objective, a task title, and the parent directories of the changed files, at most 32. The objective comes from the run that merged the commit, if a kept run's merge commit equals it (`run-objective`). Otherwise the objective is the commit message (`commit-message`). The message is sealed and never logged.

Mined rejection codes:

| Code | Meaning |
|---|---|
| `too-large` | More than 29 files, more than 1,499 changed lines, or a change list that was cut. |
| `binary-change` | A file is binary. Its size is unknown, so it is never counted as small. |
| `excluded-area-unknown` | `excludeAreas` is set, and the feature map is not available. |
| `excluded-area` | A changed file is in an excluded area. |
| `revert` | The commit is a revert, by its subject or by the commit it names. |
| `ui-changes` | The run that merged the commit has UI changes. |
| `capsule-too-large` | The commit message is over 24,000 characters, or the capsule is over 65,536 bytes. |
| `secret-shaped` | The capsule matches a secret pattern. Nothing is stored. |
| `lineage-too-wide` | The commit would merge more than 64 groups, or a path has more than 1,000 captured rows in the lineage window. |
| `duplicate-of-captured` | The commit's group holds a captured `candidate` or `valid` task. |

The message of a commit is read after its change counts. A message that is too large is `capsule-too-large`, as the capsule is.

Mined rows never count against the capture cap of 20,000 rows. A project holds at most 5,000 mined rows. A pass starts only when 50 capsules of 65,536 bytes fit under the project's and the host's material caps. Otherwise the state is `full`, and each pass checks again.

A read that is refused, fails, or times out ends the pass. The cursor stays where it was. The state becomes `failing`, and the next pass waits one hour. The host logs `Eval mining paused (read-failed).` when a project starts failing, not at each hourly retry. No commit is skipped for a failed read, and no failed read is recorded as "no test change".

Mining states:

| State | Meaning |
|---|---|
| `off` | Mining is not on for the project. |
| `waiting` | A pass waits until capture has indexed the paths of its captured tasks. |
| `mining` | A pass is running, or the last pass stopped at its 50-commit budget and the next pass goes on. |
| `caught-up` | The last pass reached the newest commit, and the backfill reached the first commit or its 2,000-commit bound. |
| `full` | The project or host material cap, or the 5,000-row limit, leaves no room. |
| `failing` | A read failed. The next pass waits one hour. |

Until the first pass, the visited, mined, skipped, and failure counts show `unknown`, never `0`.

### Groups

A group holds the tasks that come from one change. The captured tasks of one run share the run's group, whose id is `run:` plus the run id. A mined task starts in its own group, whose id is its task id, which begins with `mined:`.

Two events merge groups:

- **A landing.** A mined commit is the run's merge commit, from the run record or from the run's landing signal. The groups merge. A landing adds no dev-only mark.
- **A lineage link.** A mined commit changes a file that a captured task changed. That task must be captured within 90 days before the commit, approved before it, and in a run with no observed landing. Its groups merge, the root takes the dev-only mark, and the mined row's `lineage` is `unclear`. With no such task, `lineage` is `clear`. More than 64 groups, or more than 1,000 rows on one path, rejects the commit `lineage-too-wide`.

The smallest group id is the root of a merge. A mined group's id begins with `mined:`, which sorts before `run:`. So a mined group is the root of any merge with a run group, whichever event came first. A dev-only mark stays on its root when later merges happen. Step 4 of the delivery order will read the mark. This slice only stores it.

The duplicate rule applies after each mined insert, each merge, and each captured promotion. In a root that holds a captured `candidate` or `valid` task:

- a mined `candidate` is rejected `duplicate-of-captured`;
- a mined `valid` task is retired `duplicate-of-captured`.

A mined task is never reinstated. Its captured duplicate can be rejected later, and the mined task stays rejected.

When a run is deleted, its captured rows and their paths go. The mined copy stays with its group row. Group rows that no task names are removed, at most 100 per sweep.

Each run group without a landing is checked at most every 10 minutes, at most 100 groups per pass. A group older than 90 days is stamped as checked and skipped.

The summary shows the number of roots, the dev-only roots, and the largest root's task count.

### Validation

A validate job runs one task at a time, host-wide. Each task's rounds run as the grader, in the directories `round-1` to `round-6` of that job's work directory. Before each task the host probes the grader and checks the copy of the base bundle. The copy is streamed again when its digest differs.

A captured task's base is its anchor, with the stored base delta applied. Its reference adds the stored reference patch to the base. A mined task's base is the commit's first parent, and its reference is the commit. When the anchor of a captured task, or the commit of a mined task, is no longer on the base branch, the task is rejected or retired `anchor-missing`.

The rounds run in this order. The order stops at the first decision.

| Round | Tree | What the host checks |
|---|---|---|
| R1 | Reference | The passed hidden cases become the expected set E. An empty E rejects `not-fail-to-pass`. More than 5,000 expected cases reject `reference-too-wide`. |
| Guards | A fresh copy of the reference | Every guard check must exit 0. A non-zero exit or a time-out rejects `guard-failed`. |
| B1 | Base, with the hidden files and the `gradingPaths` files copied in from the reference | The cases of E that B1 does not pass form the set F1. An empty F1 rejects `not-fail-to-pass`. |
| R2 | Reference | The passed cases must be exactly E. Any difference rejects `flaky`. |
| B2 | Base, as B1 | The cases of E that B2 does not pass must equal F1. Any difference rejects `flaky`. |
| R3 | Reference | The passed cases must be exactly E. Any difference rejects `flaky`. The task is then `valid`. |

The focused test receives only the hidden files. Every case in its report counts as a case of those files. A report that is missing or invalid is undecided, as below. A focused test that runs past its limit rejects `too-slow`. The focused test's exit code is never read.

Each command has its own limit of 10 minutes: the focused test, `setup`, each guard check, and each preparation command. A `setup` command or a preparation command that exits non-zero, or times out, is undecided `setup-failed`.

A report is parsed under the job's `reportFormat`. A JUnit case key keeps its `classname`. A TAP key has no `classname`. A repeated key keeps its worst status. A report is invalid when it is over 8 MiB, has over 20,000 cases, has a key over 4,096 characters, has a DTD or an entity declaration, or, as TAP, has over 200,000 lines or a line over 16,384 characters.

Validation outcomes:

| Outcome | Code | Effect |
|---|---|---|
| Valid | none | `valid`. The expected cases are stored as hashes. Revalidation replaces them. |
| Rejected | `not-fail-to-pass`, `guard-failed`, `flaky`, `too-slow`, `reference-too-wide` | A candidate is `rejected`. A valid task is `retired`. |
| Rejected | `no-hidden-tests` | The reference changes no hidden test file that the diff can show. |
| Rejected | `patch-missing`, `patch-too-large` | A stored patch is missing, or it is over 1 MiB. |
| Rejected | `unreadable` | A sealed payload does not open. |
| Retired | `anchor-missing` | The anchor or commit is no longer on the base branch. |
| Retired | `owner-retired` | The owner retired the task with `infinite eval retire`. |
| Rejected | `unvalidated` | Three attempts ended undecided. |
| Undecided | `report-missing`, `report-invalid`, `setup-failed` | One attempt is counted on the task. The job moves on to its next task. |
| Environment | `anchor-unknown`, `grader-failed`, `grader-processes-alive`, `halted`, `bundle-missing`, `state-changed` | No attempt is counted. The cursor stays, so the job visits the task again. |

An exit code never validates a task. A focused test that exits 0 and writes no report is undecided. A round that has no report is never read as a pass or as a failure.

The owner's halt stops a running command within 10 seconds. The attempt is not counted, and the job waits `halt`. A restart stops the grader's processes and cleans every job that was running, before any task starts. The restart counts no attempt.

After each task the host stops every grader process, and it checks the process table. A process that survives blocks the job with `grader-processes-alive`. Each task gets a new home and temporary directory for the grader.

### Validate jobs

A job is created with a request. The CLI reads it from a file of at most 64 KiB, and sends it with a request id:

```json
{ "kind": "validate", "taskFilter": { "maxTasks": 20 }, "limits": { "maxWallMinutes": 60 } }
```

| Field | Limit | Default |
|---|---|---|
| `taskFilter.taskIds` | up to 1,000 ids, each `captured:` or `mined:` plus a name | all candidates |
| `taskFilter.origins` | up to 2 of `captured` and `mined` | both |
| `taskFilter.areas` | up to 32 area ids | all areas |
| `taskFilter.revalidate` | boolean | `false`. With `true`, valid tasks validated 30 or more days ago also run. |
| `taskFilter.maxTasks` | 1 to 1,000 | 100 |
| `limits.maxWallMinutes` | 10 to 43,200 | none, required |
| `windows` | up to 4 windows of whole UTC hours | No window applies. A window that ends before it starts crosses midnight. |
| `expiresAt` | an ISO time up to 30 days ahead | 30 days |

**Create.** A request id that matches a job with the same body returns that job. The same id with another body is `409` `request-conflict`. A project with a job that is `scheduled`, `running`, `paused`, or `blocked` is `409` `job-active`. Missing validation settings are `409` `eval-config-incomplete`.

**Pinned configuration.** The job pins the validation settings and `eval.grader` when it is created. The settings are `focusedTest`, `reportFormat`, `gradingPaths`, `guardChecks`, and `setup`. A change to any of them blocks the job with `configuration-changed` before its next task. `resume` pins the new values, and that is the owner's approval. A change to the prompt version or the permission policy does not block a job.

**Statuses.** A job is `scheduled`, `running`, `paused`, `blocked`, `completed`, `cancelled`, or `expired`. The reasons are `owner`, `validation-stuck`, `configuration-changed`, `grader-processes-alive`, `limit-reached`, `done`, and `expired`.

**Waits.** A job that cannot start a task says why, in its `waiting` field:

| Wait | Cause |
|---|---|
| `grader` | The grader state is not `ready`. |
| `window` | The current hour is outside every window. |
| `host-load` | The host load is high. The host checks it before each task, not during one. |
| `halt` | The project is halted. |
| `storage` | The grader has less than 10 GiB or 200,000 inodes free. |
| `bundle` | The base bundle could not be streamed. |
| `mirror` | A mirror read is refused. |
| `another-job` | Another job's task is running. |

**Order and counts.** The host works on the oldest job first. For each job it checks, in order: expiry; the limits (`maxTasks` and `maxWallMinutes`); the pinned configuration; the halt; the windows; the host load; the grader; and storage. Then it takes the next task after its cursor, by task id. The job is `completed` with reason `done` when no task is left.

A job that gets three undecided results in a row is `paused` with `validation-stuck`. Environment results change no counter, and the cursor stays. The job visits the task again.

**Control.** `pause` moves a `scheduled` or `running` job to `paused`. `resume` moves a `paused` or `blocked` job to `running`, or to `scheduled` when it never started. `cancel` moves any job that is not final to `cancelled`. Any other transition is `409` `invalid-job-transition`. Jobs finished more than 90 days ago are removed, at most 100 per sweep.

### Summary and status

`GET /api/eval/projects/:id` and `infinite eval status PROJECT` show:

- task counts by state and by origin, where a state with no row counts 0;
- the `candidate` and `valid` counts for each area, up to 64 areas;
- the group counts of [groups](#groups);
- the mining state and counts;
- coverage;
- the grader state, from a probe that runs at most every 10 minutes;
- the project's 10 newest jobs.

The set counts (dev and holdout) arrive in step 4 of the delivery order. Until then the summary shows `bySet` as null.

Coverage is the share of accepted production attempts that have a valid captured task. The window is the project's `retentionDays` (365 by default), capped at 730 days. Coverage is `unknown` when there are no accepted attempts, when any ledger row cannot be read, or when the outcome ledger is not ready. An unknown share is never shown as a number.

### CLI

| Command | What it does |
|---|---|
| `infinite eval status PROJECT [--json]` | Prints the summary. |
| `infinite eval run PROJECT --file job.json --request-id UUID [--json]` | Creates a validate job for the project. |
| `infinite eval job JOB [--json]` | Prints one job. |
| `infinite eval pause JOB`, `resume JOB`, `cancel JOB` | Controls a job. |
| `infinite eval retire TASK` | Retires a `candidate` or `valid` task as `owner-retired`. |

The status lines come in this order: the project; capture on or off, with the mining state and counts; the counts by state; the mined counts; the groups; the coverage; the grader state; and one line per job. A null count prints `unknown`, and so does an unknown coverage. A text value prints with control characters replaced by spaces. No line carries a file name, a message, a commit id, a case, or a capsule.

A `404` without a known code prints `This host has no eval routes. Upgrade the host first.`

### Routes

| Route | Role |
|---|---|
| `GET /api/eval/projects/:id` | Owner, controller, or viewer |
| `GET /api/eval/jobs`, `GET /api/eval/jobs/:id` | Owner, controller, or viewer |
| `POST /api/eval/jobs` | Owner. Body `{ projectId, requestId, job }`. Answers `{ created, job }`: `201` when the job is created, `200` when the request id already holds a job. An unknown project is `404` `unknown-project`. |
| `POST /api/eval/jobs/:id/pause`, `resume`, `cancel` | Owner |
| `POST /api/eval/tasks/:id/retire` | Owner |

A body or id that does not parse is `400` `invalid-eval-request`. An unknown project, job, or task is `404`. A store that is not ready is `503` `evidence-unavailable`. No route returns a capsule, a patch, a file name, a case, or a commit. The priors and report routes of part 8 of the design arrive in later steps.

### Git forms of mining and validation

Every mirror read runs through `teams.commandPrefix`, with the six `-c` settings of the capture section and `GIT_NO_REPLACE_OBJECTS=1`. Every commit id must be a full lowercase hexadecimal id before it enters an argument. A refused read changes the state of the work that depends on it, as the last column says.

| Form | Command | Limit | While refused |
|---|---|---|---|
| E1, change counts | `git diff --no-ext-diff --no-textconv --numstat --no-renames --ignore-submodules=none --diff-algorithm=myers -z PARENT COMMIT --`, in the mirror | 30 seconds; 64 KiB, and a longer output is too large | No commit is mined. Mining is `failing`. Nothing is claimed about any commit. |
| E2, time and message | `git log --no-walk=unsorted --no-show-signature --no-notes --encoding=UTF-8 --format=%ct%x00%B COMMIT`, in the mirror | 30 seconds; 64 KiB | No commit is mined. |
| E3, base bundle | `git bundle create - refs/heads/BRANCH`, in the mirror | 600 seconds; streamed, at most 1 GiB | No validation starts. The job waits `bundle`. |
| Forms 1 to 4, base scan | The base-scan forms of the outcome ledger: `merge-base --is-ancestor`, the first-parent lists, and `git log --no-walk` for up to 50 ids | 30 seconds each | Mining is `failing`. Validation waits `mirror` and counts no attempt. |

The launcher ends E1 and E2 by itself after 35 seconds, and E3 after 660 seconds. The host cannot signal a command that the launcher runs as another account.

The Git commands that validation runs inside the grader's root are grader commands. They run through the grader launcher, with its environment and limits. They are not forms of `teams.commandPrefix`.

### Not in this slice

These arrive in later steps of the delivery order:

- trials, the eval identity, grading, and `baseline` jobs;
- the dev and holdout sets, and the exposure of a group;
- reports, priors, and their routes;
- `candidateProfiles`, `memberProfile`, and `trialMinutes`;
- a scheduled revalidation. An owner starts one with `revalidate`.

Also not in this slice:

- reinstating a mined task, and undoing a lineage merge that a later landing proves wrong;
- skipping a commit whose reads keep failing. Mining stays `failing` and retries hourly, so the owner sees it;
- the summary in the web client, the phone, and the Mac app;
- MCP tools. None, by design. An eval result never reaches a member's prompt, workspace, or tool result.

## Head publication

The host publishes each integrated head to GitHub, so the work survives workspace
removal and disk loss. The target is the run's pinned delivery repository
(`run.delivery.repository`), or else the project's GitHub source repository. With
neither, nothing is published. The URL is `https://github.com/OWNER/REPO.git`;
`source.remoteOverrides` can override it per project.

The host runs one operation through `teams.commandPrefix`, from the run's
integration workspace:

```sh
git push https://github.com/OWNER/REPO.git FULL_COMMIT_SHA:refs/heads/RUN_BRANCH
```

Publication runs after every accepted integration, before any reviewer or delivery
member starts. Blocked and cancelled runs publish before retention removes their
workspace. Merged and no-change runs need no publication, and neither does a run
whose workspace was already removed or is missing, since no head is left to push.

A failed push is retried after 1 minute, doubling per attempt up to one hour. The
run does not block: review and delivery wait, and the run continues on its own once
GitHub accepts the head. Each failure category is recorded once in run history, and
after the third failed attempt for a head the history says that review and delivery
are waiting on GitHub access. Owner removal and owner delivery reconciliation refuse
with `head-not-published` while the head is unpublished. Git output, URLs and tokens
are never stored.

If GitHub rejects the push as non-fast-forward, the host leaves that remote branch
untouched and publishes the head as `RUN_BRANCH-` plus the first eight hex
characters of the SHA. The host never deletes or force-updates a remote branch.

**Unfinished member work.** For cancelled and blocked runs, the host snapshots unfinished member clone work
(including uncommitted edits) to `RUN_BRANCH-wip-MEMBER_ID` before removing the
workspace. If that branch is rejected, it tries `RUN_BRANCH-wip-MEMBER_ID-SHA8`;
it never deletes or force-updates either branch. Failed snapshots or pushes retry
after 1 minute, doubling each time. Once a save has been requested, the host
retries when its backoff expires even if the normal retention period has not
arrived. Only the retries are automatic: after an early owner request, the
workspace is removed when the owner requests removal again or when retention
comes due. After five failed attempts, the host records the give-up, and the
workspace can then be removed the same way. This does not
cover the integration workspace, runs without a GitHub publication target, or
ready-for-review, merged and no-change runs.

The delivery prompt says the host already published the reviewed head, so a remote
branch already at that commit is the expected unchanged head. That host publication
is not a delivery: with no pull request and a moved base, the delivery member reports
the `no-publication` disposition, so clean-base recovery still applies. Its new head
then publishes to a SHA-suffixed sibling branch. Set `teams.publishHeads` to `false`
to disable publication.

## Optional provider-side delivery

Repositories remain review-only until an owner configures delivery once during
enrollment:

```sh
infinite repo init --delivery merge
infinite repo init --delivery merge --repository OWNER/REPO --base-branch main --merge-method squash
infinite repo init --delivery pr --repository OWNER/REPO --base-branch main
infinite repo init --delivery review
```

For `--delivery merge` and `--delivery pr`, the CLI reads `origin` only when its URL is an HTTPS or
SSH `github.com` repository without credentials. It reads the default branch
from `origin/HEAD`; if that is missing, it uses the current local `main` or
`master` branch. Otherwise, provide `--base-branch`. The CLI does not change
the remote or local Git state. Existing enrollment keeps its delivery policy
when `--delivery` is omitted; `--delivery review` removes that policy. New
enrollments remain review-only by default. Delivery settings are per repository
and are not inherited from parent-folder Linear defaults.

The configured target authorizes the strong coordinator role to use its
existing provider tools to merge its own work after configured checks pass and
an independent reviewer approves the implementation and verification. The host
checks that a delivery report identifies the reviewed head and configured
repository. The provider's merge receipt remains agent evidence; the host does
not independently verify the remote merge or grant GitHub tool permissions.
Missing GitHub tools or authentication blocks delivery for review. It does not
expand provider permissions, and a merge report does not establish human
acceptance or product impact.

For a stopped delivery that reports a routine capability or workflow failure,
the host can queue a bounded same-run retry under the unchanged delivery policy.
The strong coordinator first inspects the exact remote branch and pull request;
it reuses matching work and does not create duplicates, rewrite an owned branch,
force-push, or switch credentials or tools. At most two automatic recovery
attempts run per team. Repeated identical failure evidence exhausts recovery.
The host preserves each earlier attempt and its report. Remote observations
remain agent evidence; they do not prove that a merge or pull request succeeded.

When the configured base moved and the coordinator reports that nothing was
published, it submits a structured `delivery-reconciliation` report naming the
reviewed head, repository, branch, and observed base head. The host confirms
that base head against its refreshed GitHub source mirror, then creates a clean
recovery workspace at that commit and keeps the old integration workspace
available under the workspace retention policy. An integrator must carry the
approved changes forward from that copy while it remains available.
The new head must pass configured checks and independent review before delivery
can start again. This moved-base path currently requires standalone ownership;
goal, mission, and handoff runs remain blocked for parent-directed reconciliation.
An owned remote branch or pull request is never rewritten by this path.

After an explicitly blocked delivery attempt, an owner can request a fresh
strong-coordinator reconciliation through
`POST /api/teams/:id/reconcile-delivery` with `requestId`, `revision`, and a
`text` field recording the resolved dependency and remote evidence. The CLI is
`infinite team reconcile-delivery ID TEXT... [--pending ID --head COMMIT
--processes-stopped TEXT] [--request-id UUID] [--json]`. The three optional
flags must be used together. They apply only to a settled pending `result`
operation whose failure code is `workspace-operation-failed`,
`invalid-workspace-baseline`, `workspace-copy-changed`, or
`delivery-baseline-source-mismatch`, and whose exact source, stopped delivery
member, no-publication report, moved base,
revision, head, and pinned policy still match. The owner supplies an explicit
process-quiescence attestation using the API's optional `failedOperation`:

```json
{
  "pendingId": "<pending operation UUID>",
  "headCommit": "<exact reviewed commit>",
  "attestation": {
    "boundary": "delivery-preparation",
    "processesStopped": true,
    "text": "<operator evidence that the preparation and delivery processes exited>"
  }
}
```

Read `pendingOperation.id`, `failureCode`, `sourceMemberId`, and `sourceRole`
from the current team status. The request must also identify the current
`revision` and a fresh `requestId`, which must be reused if the response is lost.
Every member must be stopped, Linear must confirm current requirements, and
both the integration and original delivery workspaces must be clean at the
exact reviewed head. The host records the failure, original report,
and attestation in `deliveryOperationReconciliations` before clearing the gate;
the old result is never replayed. Recovery attempt counts do not reset. A fresh
strong delivery member must inspect the current remote branch, pull request,
CI, and pinned base head, then return a new structured report before any write.
The attestation is an operator claim, not host verification. Unknown or
interrupted operations, publication or permission uncertainty, dirty work,
changed policy, paused runs, and exhausted recovery budget remain blocked.
Refusals include `delivery-reconciliation-unavailable`,
`delivery-reconciliation-operation-changed`,
`delivery-reconciliation-head-changed`, `delivery-policy-changed`,
`integration-changed-files`, and `delivery-recovery-exhausted`. The ordinary
blocked-attempt flow remains available under the same pinned policy. A new
member must reuse matching branches, pull requests and confirmed results before
considering any new action. A changed baseline still needs a fresh
implementation and review; this action does not waive checks, reconcile edited
files, or expand provider access.

### Restart-interrupted verification

An owner can reconcile a check only when the team is blocked with the host's
restart-interruption reason, the same check operation is still pending, every
member is stopped, the exact integrated head is unchanged and clean, and the
retained check records show that the final configured command was interrupted.
Result, prepare, member, permission, and delivery uncertainty stays fenced.
The operator must first establish that the old check processes have exited. A
check can outlive the API process that started it (for example, when `systemd`
uses `KillMode=process` or a sudo command prefix is configured). Before
attesting, confirm that no process from the interrupted check remains and that
no process has a working directory under the team root. The attestation is an
operator claim, not host verification.

The host reports what it sees. A check whose intent carries a process record is
looked for again before each reconciliation; the result is written to the run's
events and to `pendingOperation.processes`, with `processesCheckedAt` (process
ids are not exposed): `running` when processes match the host's record of the
check, `in-use` when none does but a process uses the run directory, `ended`
when the host looked and found neither, and `unknown` when it could not tell.
The host's view is limited: it inspects processes of its own account and, through
the installed `process-census` wrapper where a sudo command prefix is set, of the
account that runs team commands; it does not inspect other accounts. Without that
wrapper or its sudo rule the result is `unknown`. An `ended` or `unknown` result
therefore does not replace the attestation, which is still required.

Use `POST /api/teams/:id/reconcile-verification` with `requestId`, `revision`,
`pendingId`, `headCommit`, and `attestation: { boundary: "check-only",
processesStopped: true, text }`. The CLI form is
`infinite team reconcile-verification ID --pending PENDING_ID --head COMMIT
--processes-stopped TEXT... [--request-id UUID] [--json]`.

This clears only the interrupted check intent. It preserves the run, issue,
revision, tasks, members, head, old check records, and workspace; the scheduler
starts fresh verification in a new disposable workspace, followed by the
normal independent review. Reusing the request ID and body returns the saved
state. A different body with that ID is refused. Refusal codes include
`stale-team-revision`, `team-cancelled`, `linear-reconciliation-required`,
`verification-reconciliation-unavailable`,
`verification-reconciliation-operation-changed`,
`verification-reconciliation-head-changed`, and
`verification-policy-changed`; a dirty integration workspace returns
`integration-changed-files`. While the host sees a process that matches its
record of the interrupted check, the request is refused with
`team-operation-running`; while it sees only processes that use the run
directory, with `team-directory-in-use`; and once workspace removal has started,
with `team-workspace-removed`.

An owner can retire a current-revision reviewer whose report is missing and
whose runtime is in `recording-error`, then let the scheduler start one fresh
reviewer at the same verified head. First inspect
`GET /api/teams/:id/members/:memberId/runtime`, verify the assignment and
process identity, confirm no person controls the session, and establish that
the integration head and member checkout are unchanged. Then POST
`/api/teams/:id/members/:memberId/retire` with `requestId`, `revision`,
`sessionId`, `identity`, and a short operator statement. The CLI form is
`infinite team retire-member ID MEMBER_ID TEXT... --identity HASH
[--request-id UUID] [--json]`.

Retirement freezes the recorded tree with `SIGSTOP`, rescans and records new
descendants, then uses `SIGKILL` once the tree is quiescent. It never sends
`SIGCONT` or runs termination handlers. The host signals its own processes and the
sudo launcher directly. Agent-owned descendants are signaled only through the
configured team command boundary, after a per-process start-time recheck.
Unknown owners are observed but never signaled; retirement remains blocked
until they exit, then retry with the same request ID and inspected identity.
The original session journal, recording-gap evidence, reports, and workspace
remain available. Restoring recording is unsupported. The scheduler creates
the replacement only after the recorded process tree has exited and the old
checkout passes its read-only check. Refusal codes include
`stale-team-revision`, `member-retirement-unavailable`,
`runtime-identity-changed`, `retirement-processes-alive`,
`retirement-boundary-unavailable`, `control-busy`, and `runtime-retiring`.

After the host records a `merge` report, it refreshes the project, so the merged
commit reaches the host before the owner reads the result.

`--delivery pr` moves the review step to GitHub without granting merge authority.
After the reviewer approves the implementation and its verification, the delivery
member pushes the reviewed `infinite/team-*` branch at exactly the reviewed commit.
It opens a pull request against the base branch, then stops. Its report names the
head commit and the pull request URL. The host checks that the URL belongs to the
configured repository, records it on the run as `pullRequest`, and sets the run to
`ready-for-review`. The owner reviews and merges on GitHub. For a `github` project,
the refresh timer then picks up the merge. `team pull` works on the run as usual.
`pr` requires the same strong coordinator and independent strong reviewer as
`merge`. `--merge-method` does not apply to it. A delivery report whose kind does
not match the configured mode is refused with `delivery-mode-mismatch`.

## Project context and explicit relationships

Each project keeps its own context, task history, and repository evidence. Parent
folder enrollment and Linear mappings do not share context. An alias pointing to
the same directory also keeps a separate context record.

From an enrolled repository, explicitly name a source project or enrolled directory:

```sh
infinite repo link ../backend --relationship "Uses the backend API"
infinite repo links
infinite repo unlink ../backend
```

Use `--project ID` to select the consuming project without changing directories.
Only an owner can change links. A link imports the source's owner-authored project
context into future managed sessions, with its project ID, version, and relationship.
It does not import transcripts, follow another link, or merge Linear projects.
Existing sessions keep their snapshots after unlinking. Native CLI launches keep
their existing no-injection behavior; team sessions receive the scoped context.

The separately installed shared-brain skill also defaults to the requested
repository alone. Its owner-managed knowledge links require an explicit linked
search; `global` is not included automatically. An Infinite context link does not
create a brain link. Each surface grants only its named kind of context, and
neither grants filesystem or network permissions.

A project's `team` object may set `features`, a private feature map of areas, each an `id` with
repository-relative path prefixes, plus optional `elevated` prefixes and `elevatedTokens`. The host reads it when a
plan is accepted and records each task's area, kind, and risk in its run events. It never sends the map to a member:
member context files and prompts leave it out. A plan task may add `kind` and `risk: "elevated"` as labels; a label
can raise risk but never lower it. The key has no default, so a project without a map keeps its configuration as it was.

## Let an ordinary session request a team

`infinite repo init` enables automatic handoff for new sessions in that project.
Use `--handoff off` during enrollment to keep them as individual sessions.
Existing projects and already running sessions retain their settings.

After enrollment, start normally with `infinite claude "Your task"` or
`infinite codex "Your task"`. Both use the enrolled cloud project. Later local
edits need an explicit sync; starting a session does not upload them.

A supported Claude or Codex terminal session receives a scoped `handoff` tool.
It can request a team when the current task benefits from parallel work and
independent review. The request contains the remaining objective, the reason
for delegation, and a summary of completed work. The coordinator can use one
implementer if parallel work is unnecessary. It reports no change only when the
task requires no further code changes, with evidence. No terminal-text heuristic
makes this choice.

Before yielding, the agent must stop its tool jobs, commit only its own changes,
and supply the clean Git commit. Unrelated edits must remain untouched; a dirty
checkout refuses the transfer. The host records the request, releases the source
writer, checks its observable process group and descendants, and verifies the
same commit before preparing an isolated team copy. A retry or host restart uses
the recorded team identity. The yielded session cannot be resumed as another
writer for the same task.

The team inherits the source session's configured lineup, project checks and
Linear mapping. It has at most two parallel implementers, sixteen member
attempts, and sixty minutes from the accepted handoff. A project can set
`handoffMinutes` (5–1,440, default 60), `handoffExtendMinutes` (0–240, default 0)
and `handoffMaxTotalMinutes` (at least `handoffMinutes`) in its `team` object.
An extension works as it does for goals below: it applies only while an active
member shows activity within the stall window. These are execution limits,
not a token or currency cap. A recorded initial user request stays in its context.
For an interactive session with no initial request, the agent's summary supplies
the current task context and is labeled accordingly. It does not grant authority
to expand the task, publish, deploy, or change provider permissions.

The CLI releases its own terminal lease after an accepted handoff when it has no
unsent local draft. A draft or another controlling device keeps the transfer
waiting until that client detaches. Status and the resulting team ID are exposed
at `GET /api/sessions/:id/handoff` and on the session record.

Handoff currently covers new Claude and Codex PTY sessions at the configured
repository root, with ordinary prompts and supported model flags. Native UI,
laptop execution, resumed sessions, other providers, and unsupported native
arguments retain their existing behavior and report handoff as unavailable.
The process check is not a sandbox for arbitrary background services: the agent
must stop jobs that detached or escaped its observed process tree before yielding.
An uncertain stop or changed checkpoint blocks the transfer and preserves the work.

## Start and steer a goal

An owner selects a configured workspace and supplies the desired outcome,
success criteria, non-goals, allowed paths, and evidence. Evidence can be a link,
a repository reference, or an observation. Starting the goal authorizes the
coordinator to select and build work within those boundaries.

| Setting | Default | Accepted range or meaning |
| --- | --- | --- |
| `allowedPaths` | `["."]` | Repository-relative files or folders; `.` permits the entire project. No globs or parent traversal. |
| `maxRuns` | 3 | 1–10 sequential feature cycles; a standing goal has no cycle limit |
| `maxMinutes` | 60 | 5–1,440 minutes from creation |
| `extendMinutes` | 0 | 0–240 minutes added each time the deadline arrives while an agent is active; 0 turns extensions off |
| `maxTotalMinutes` | `maxMinutes` | 5–1,440 minutes, at least `maxMinutes`; the ceiling for the deadline, including extensions |
| `maxMembers` | 24 | 4–200 member attempts across the goal, including scouts, questions resumed as new attempts, review, repair, and escalation |

The PM and coordinator choose worker capacity within the host's ceiling of four
concurrent workers. Worker capacity is not an owner setting. The host starts
workers for ready tasks and releases their slots when their processes stop;
host session capacity still applies.

Pausing does not extend the deadline or restore consumed attempts. Steering can
change the direction, but cannot expand the approved paths, deadline, or limits.

Each goal holds an objective record. It states the objective, the success
criteria as `c0`, the non-goals, the evidence, and the allowed paths, and it
gets one direction for each steering message, in steering order. Each change
is logged. The owner reads the record, or any past version of it, with
`infinite goal record ID [--version N] [--json]` or `GET /api/goals/:id/record`.
A standalone run gets its record at its first accepted plan. Goal cycle runs,
mission subteams, and handoff runs have no record of their own. The relay does not
carry the record or its corrections. Its assumptions, open questions, and derived
criteria come from the intent check; see [Intent check](#intent-check).

With `extendMinutes` above 0, the host moves the deadline forward when it arrives,
if the active team has a member with attention activity within the stall window
(`teams.stallMinutes`, default 30). The new deadline is the later of now or the
old deadline, plus `extendMinutes`, and never passes `maxTotalMinutes`. The goal
and its team record each extension with the policy that allowed it. A goal
without that policy, or whose agents are all quiet, stops at its deadline as before.
Owners can also extend a running, paused, or time-stopped goal with
`POST /api/goals/:id/extend`. A time-stopped goal returns to running once its
stopped team has settled, and the ceiling rises to cover the new deadline.
Failed extensions record recovery events and stop automatic retries after three
failed attempts, including across host restarts. An unapplied request is abandoned;
if the team already saved its receipt, retry the same request to reconcile it.
Later owner controls invalidate an unapplied extension, while an applied receipt
is reconciled without undoing those controls.
Start a new goal to approve a larger scope or more work. Each cycle also has a
maximum of 60 member attempts, bounded by the goal's remaining allowance. These
are execution limits; they do not enforce a token or currency budget. A stop
request is not proof that arbitrary detached tool descendants have stopped.

The goal page shows the active team, its questions and opportunity brief,
previous cycles, recorded agent profiles, evidence, and remaining limits.
Owners can pause, resume, or cancel. Owners and controllers can steer a running
goal and answer a current member question on its linked team page. Viewers can
read the same records. Direct steering and lifecycle actions on a goal-owned
team are refused; use its goal so the scheduler retains control of the sequence.
Questions remain answerable while that team is the active cycle of a running
goal. A paused goal must resume before work or answers can continue.

After a pause or cancel with an active team, the goal's reason says it is
stopping its active team. Once no team is stopping, or when there was none, for
example between standing cycles, the reason says that the owner paused or
cancelled the goal. A paused goal keeps its paused team attached for the
resume; the reason changes once that team is paused and its members have
stopped.

A blocked goal closes as `cancelled` after `teams.retention.blockedHours` (72
hours by default) without owner action. The host records the last blocker in its
reason and does not claim completion. The blocked period is saved independently
of `updatedAt`, so ordinary saves do not restart the window. A goal that was
already blocked when the host began recording this starts its period at its last
save. Paused,
ready-for-review, no-opportunity, limit-reached, and achieved goals do not expire
under this rule.

A reviewed cycle supplies the next cycle's source commit. The host checks that
the earlier workspace still matches that recorded head before cloning it.
Unreviewed or failed changes do not become the next cycle's base, and the
original project checkout remains unchanged. A conflict, missing report, or
unresolved operation blocks progression with its evidence and workspace intact.

The coordinator can report that no further change is justified by the evidence.
The goal then stops as `no-opportunity`, or `ready-for-review` if an earlier cycle
produced reviewed changes. Exhausted attempts or time produce `limit-reached`;
reaching the cycle limit leaves reviewed work ready for inspection. None of
these states means the desired product outcome was achieved.

After a goal has stopped and has no active cycle or pending operation, an owner
or controller can record `achieved`, `not-achieved`, or `inconclusive`, with an
assessment and supporting evidence. A paused goal remains resumable and cannot
accept an outcome assessment; finish or cancel it first. Only an explicit user
assessment can mark the goal `achieved`. Passing checks, agent approval, or an
idle terminal cannot do so.

### Intent check

An autonomous goal cycle or standalone run holds its plan before any work
starts and asks a read-only checker whether the plan matches the objective
record. The checker is a member with role `intent-checker`. Every other run and
goal is unchanged.

**The pin.** `createRun` records `run.intentCheck` as `on` or `off`, beside
`run.autonomy`, and the team view shows it. A goal cycle or standalone run pinned
`autonomous` gets `on`. A `supervised` run gets `on` only when the project sets
`objective.intentCheck: "on"`. A mission subteam and a handoff run always get
`off`. A run without the field was created before this change and never checks.
A new cycle is a new run, so a cycle of an older goal checks when that goal is
pinned `autonomous`.

**The off switch.** `objective.intentCheck` takes `"on"` or `"off"` and has no
default. Without the key, the mode's default applies. `"off"` stops the check in
autonomous mode, and `"on"` starts it in supervised mode. Both `objective.intentCheck`
and each `evaluators` list are part of the routine authority digest. Writing or
changing either one needs the owner's approval of active routines again; absent
keys leave the digest unchanged. `objective.prompts` is optional, so
`{ "intentCheck": "off" }` stands alone.

**Start pins.** An autonomous project starts a new run or goal `supervised` when
its lineup has no eligible evaluator. A lineup is autonomy-ready when one of its
evaluators has a known model family that differs from the coordinator's. A lineup
without a coordinator family, or a run with no lineup, is not ready. The run or
goal then records one event:

- `This run starts supervised: it has no lineup, so no evaluator of another model family can check it.`
- `This run starts supervised: no lineup profile of a model family other than the coordinator's can evaluate it.`
- A goal writes the same two texts with `This goal starts supervised:`.

A standing goal is refused with `standing-requires-autonomy` (409) when its
project is not autonomous. When the project is autonomous but its lineup is not
ready, the refusal says that a standing goal needs an evaluator.
The enrollment view reports `autonomyReady` and, when it is `false`,
`autonomyReason` (`no-lineup` or `no-eligible-evaluator`). `infinite repo init`
prints both.

A pin already taken never moves. A goal cycle copies its goal's pin, and a
resumed or restarted run keeps its own. If the lineup later loses its evaluator,
the next cycle of an `autonomous` goal stays `autonomous`, and its checks skip
with `no-eligible-profile`.

**Evaluators.** The lineup's `evaluators` slot lists at most 4 strong profiles
that may check a plan. Without the slot, the list is derived when the lineup is
read: the reviewer, when its tier is `strong`, then each strong escalation, first
id wins, at most 4. The derived list is never written back to the configuration.

**Choosing the checker.** The host takes the first evaluator whose model family
is known, differs from the coordinator's family and the plan author's family,
and runs on a provider that is not limited. If none qualifies, the check is
skipped with `no-eligible-profile`. The checker's prompt is fixed text and holds
no run data. The checker is a counted member: the fuse counts its launch, and in
a goal cycle it uses one member of the goal's member budget, as do a replacement
checker and a corrected project manager.

**What the checker reads.** Its context file holds the objective record without
its log, criteria without their latest values, and assumptions without their
proposals. It also holds the held plan's summary, brief, tasks without their
agent profile, and verification, the scout reports of the same revision, the
configured checks, the mode, whether criteria are due, and the limits. The
context is at most 1 MiB. A larger context skips the check with
`context-too-large`. The context holds no routing value, score, other member
report, or credential.

**What the checker reports.** One report of kind `intent-check`. It has a
summary, up to 16 items (up to 3 of them scouts), up to 8 criteria, and up to 24
`outOfScope` ids. Each item gives a dimension, a reason, a criticality
(`outcome`, `plan`, or `detail`), and a disposition (`ask`, `scout`, or `assume`).
Each item also gives an assumption, with what would refute it and a test. An
`ask` item adds a question with a default or an `interrupt`. Criteria come only
for a goal whose criteria are due. The host drops an item that fails its shape,
secret, quote, or command checks, and counts each drop. A report of any other
kind is stored as fixed text and counts as a failure.

**What the host records.**

- `assume` adds an assumption with status `assumed`.
- `scout` is converted to `assume` and logged until the scout step is built.
- `ask` in supervised mode always waits. In autonomous mode it is converted to
  `assume`, unless it is an outcome question with an owner test. That question
  stays open, and it waits only when it carries an `interrupt`.
- Derived criteria join the record and show as `derived` in its digest.

Each change the check makes to the record writes one log entry:
`intent-check.applied`, `intent-check.answered`, `intent-check.released`, or
`intent-check.skipped`. The entry names the ids and counts it changed.

**The owner's answer.** Waiting questions become one decision. Its text opens
with `The intent check needs your answer on N item(s) before the plan proceeds.
Answer in one message.`, then numbers each item. Its options hold only `Use the
stated defaults`, and only when every waiting item's assumptions are `assumed`.
Otherwise the decision takes free text. Authority surfaces, including member
prompts, permission reviews, the blackboard, and Linear, print the decision as
`The intent check's questions` and its question ids, never its text.

- `Use the stated defaults` marks the questions `default-kept`.
- Any other text becomes a `correction` direction while the record holds fewer
  than 20 directions. At 20, the answer reaches the project manager without a
  new direction.
- A delegate's answer records nothing. It releases the questions, and the record
  keeps them open.

The project manager then corrects its plan once, with the items and the answer.
The corrected plan is accepted without a second check.

**Failures and skips.** A checker that stops without a usable report, or fails
its read-only check, counts one failure. A pause, cancel, halt, block, or
recovery that stops the read-only check counts no failure and writes nothing; a
resumed run plans a new revision, and its plan is checked. The first failure
starts one replacement with the event `The intent checker stopped without a
usable report; one replacement starts.` A second failure skips the check. Every
skip accepts the held plan once and writes one event:

- `checker-failed`: `The intent check was skipped: the checker failed twice. The plan is accepted unchecked.`
- `no-eligible-profile`: `The intent check was skipped: no evaluator profile differs in family from the coordinator and the plan's author. The plan is accepted unchecked.`
- `record-unavailable`: `The intent check was skipped: the objective record could not be read or written. The plan is accepted unchecked.`
- `log-full`: `The intent check was skipped: the objective record's log is full. The plan is accepted unchecked.`
- `context-too-large`: `The intent check was skipped: the checker's context is over 1 MiB. The plan is accepted unchecked.`

**The held plan.** The held plan is the project manager's stored report. It is
accepted again after the check ends and passes the same checks as before, with no
second copy. A restart keeps the check's state. Cancelling the run releases its
waiting questions as `cancelled`. A later plan revision releases them as
`replanned`.

**Before a rollback.** Remove `objective.intentCheck` and every `evaluators`
list from the configuration. Finish or cancel each run that has an
`intent-checker` member. A goal whose pinned lineup has `evaluators` is expected
to block at its next cycle on an older host.

### Owner criteria

An owner can give a goal criteria and correct them. Both need the project's objective switch. Without it, creation `criteria` and every correction answer `409` with `objective-prompts-off`. No prompt, context file, run fingerprint, or routine digest changes.

Turn the switch on in the project's team block:

```json
"objective": { "prompts": "on" }
```

The key has no default. Writing it at all, even as `"off"`, changes the routine approval digest of that project, so its active routines wait for owner approval again. An absent key keeps every stored digest valid. A rerun of `repo init` keeps the key.

With the switch on, each goal cycle's member prompts and context file show the record's criteria in place of the success text. The digest lists the active criteria with each statement, check label, and producer. It is at most 6,144 bytes of JSON with `c0`'s statement left out, because the prompt prints `c0`'s text once. A criterion whose correction would push the digest over that cap answers `409` with `objective-digest-too-large`.

A cycle pins the digest it launched with. Every member of that run reads the same digest, including members started after a pause, a replan, or a host restart. The next cycle reads the latest version. A correction therefore reaches members from the next cycle. To reach a running cycle, steer it.

The sealed eval capsule of a run copies the goal context. Once a cycle pins the digest, the eval capture holds the owner's criteria text.

Owner text lives in the sealed goal record, the pinned digest, the prompts and context files of later cycles, and the team views of a goal cycle, which show its pinned digest beside its success text. The reviewer's notes are sealed, and only the owner reads them in the permission decision log. The host never writes owner text to a log line, an event, or an error body. A statement that looks like a secret is refused with `400` and `objective-secret`, and the refusal does not repeat it.

Creation criteria go in `criteria` on `POST /api/goals`: one to seven criteria, each with a statement, a check, and a threshold. Routine goals never take criteria. A create that carries criteria is refused with `409` and `objective-source-invalid` when its goal fields cannot build a record, and nothing is stored. A create without criteria still works without a record, as before. A goal created over the relay can carry criteria, as it already carries the success text and steering, because the create route is owner-only. The relay also carries team views, so a relay client can read a cycle's pinned digest there, as it already reads the success text. The record reads and corrections stay off the relay.

`POST /api/goals/:id/record` takes `{ requestId, version, ops }` from an owner device. A controller or viewer gets `403`. Four ops are available:

- `criterion.add` takes a `criterion` with a statement, a check, a threshold, and an optional producer.
- `criterion.edit` takes an `id` and at least one of `statement`, `check`, or `threshold`.
- `criterion.retire` takes an `id`.
- `criterion.confirm` takes an `id`. Only a derived criterion can be confirmed. No criterion is derived yet, so every confirm answers `409` with `objective-op-target` for now.

Limits:

- A correction holds at most 16 ops.
- A statement is 1 to 1,000 bytes. A criterion is at most 2,048 bytes.
- A command check must name one of the project's configured checks. Otherwise the op answers `400` with `objective-command-unknown`.
- A record holds at most 8 active criteria and 64 in all.
- `c0` cannot be edited or retired. The op answers `409` with `objective-op-c0`.
- Every op names a criterion of the record the correction applies to, so op order does not change the result. A new criterion has no ID that the same correction can name.
- A correction must leave room in the log for steering: at least 20 entries and 46 KiB. Otherwise it answers `409` with `objective-log-full`.

A correction applies once or not at all:

- The same `requestId` with the same body answers the record's latest view and writes nothing.
- The same `requestId` with another body answers `409` with `request-conflict`.
- A `version` that is no longer the latest answers `409` with `objective-version-stale`.
- A refused op refuses the whole correction. The error does not repeat any owner text.

Corrections write `criterion.*` log entries. Rebuilding any earlier version undoes them, so every version still reads back.

The record commands take three forms:

```
infinite goal record ID [--version N] [--json]
infinite goal record ID retire CID | confirm CID [--version N] [--request-id ID] [--json]
infinite goal record ID apply --file PATH [--version N] [--request-id ID] [--json]
```

Without `--version`, a correction reads the latest version first and then posts once. `apply` reads `{ "ops": [...] }` from a file of at most 64 KiB. The command checks the file before it sends anything, and an error names the op's index, not its text. When the post gets no answer, the command prints the retry with the version and request ID it used. Retry with the same body, version, and request ID only.

Before a rollback to a host without this slice, remove `project.team.objective` from every project. The older host refuses the project schema with that key. A pending goal launch that carries a pinned digest also blocks on an older host.

### Standing objectives

A goal can be a standing objective. It runs one cycle after another on a
cadence and has no cycle limit. Create it with
`standing: { shape: "objective", cadenceMinutes, wakeOn }`. The project must be
autonomous: a supervised project refuses it with `standing-requires-autonomy`.
A routine cannot start a standing goal, and a standing goal refuses `maxRuns`.
Every cycle passes the whole objective, so a standing goal's objective must fit
in 24,000 bytes of UTF-8; a longer one is refused with
`standing-objective-too-large`. The host never cuts the owner's text.

The first cycle starts when the goal is created. Each later cycle starts at the
later of two times: the previous cycle's start plus `cadenceMinutes`, and the
time the previous cycle settled. `cadenceMinutes` is 30 to 10,080, default
1,440. Starts missed while the host was down coalesce into one cycle.

`maxMinutes`, `extendMinutes`, `maxTotalMinutes`, and `maxMembers` apply to each
cycle. At each cycle start the host sets the deadline and the ceiling from that
moment and gives the cycle `maxMembers` attempts, at most 60. A cycle that passes
its time limit is stopped, and the goal goes on. Between cycles the goal has no
deadline, so the host refuses an extension then; an extension applies to the
current cycle only. Each cycle takes the host's current lineup and records it.

A cycle's launch is recorded before its run is created. If the run was never
created, because the host restarted or creation failed, the host withdraws the
launch, returns its wake to the goal, and the next cycle passes every gate again
(mode, lineup, failure count, Linear tracking, spend fuse, and owner pause or
cancel) with a fresh window. Creation failures that pass with time leave the
goal `running` with the reason and retry a minute later: low or unmeasurable
storage, a window that lapsed while creation waited, a mission holding the
repository, and file or process resource exhaustion. Any other creation failure
blocks the goal, as it does a finite goal.

When a cycle's members have stopped, the host records its `class`:

| Class | The cycle ended | Effect |
| --- | --- | --- |
| `reviewed` | `ready-for-review`, or `merged` with a validated baseline | It is the parent of the next cycle |
| `no-change` | `no-change` | Normal. The next cycle starts from the same parent |
| `failed` | Blocked, or stopped at its time or attempt limit | Counts toward the failure stop |
| `excluded` | Owner pause or cancel, a provider limit with no fallback, or a time stop while the spend fuse was open | Counts neither way |

A standing goal never stops as `ready-for-review`, `no-opportunity`, or
`limit-reached`. It stops starting cycles only in these cases:

- The owner pauses or cancels it.
- At a cycle boundary the project is supervised or no longer enrolled. The goal
  becomes `paused` with `reasonCode: "supervised-mode"`. Resume returns
  `standing-requires-autonomy` until the project is autonomous again.
- A settled cycle left an external operation open: a reported merge without a
  validated baseline, an unfinished delivery attempt or delivery recovery, or a
  head the host could not confirm on GitHub. A delivery member that never
  launched, for example because it waited behind the spend fuse, is not a
  delivery attempt. The goal becomes `blocked` with
  `reasonCode: "external-operation"`. Starting from the older parent could
  redo work that already landed.
- Three cycles in a row fail. The goal becomes `paused` with
  `reasonCode: "repeated-failures"`. A `reviewed` or `no-change` cycle ends the
  run of failures, and an `excluded` cycle leaves it as it is. A resume resets
  the count.
- The Linear issue blocks it, or the host lineup no longer has a strong
  coordinator and reviewer. The goal becomes `blocked`, as a finite goal does.

While a spend fuse is open the goal stays `running` with the fuse reason and
starts no cycle. While Linear tracking holds new work, the goal also stays
`running` and starts no cycle, and shows the tracking reason (see
[Linear tracking](#linear-tracking)).

The goal record keeps the newest 50 cycles and the parent of the next cycle.
Older cycles fold into `cycleTotals` (a count per class), `foldedUsage`, and
`foldedMembers`, so the goal's usage and attempt totals still cover every
cycle. While the goal is live, workspace retention keeps only the active cycle's
run and the next cycle's parent; older runs follow the normal retention
windows. Each cycle receives the 16 newest reviewed cycles as previous work.

#### Wake on signals

`wakeOn` lists one to four host signal kinds: `revert`, `external-commit`,
`delivery-landed`, or `owner`. The host records a signal when it sees one of
these events in the project; no signal starts an agent by itself.

- On each scheduler pass, a goal that is neither paused nor stopped reads new
  signals of those kinds. It ignores signals about its own cycles' runs.
  `signalCursor` records the last signal read. New signals wait in
  `pendingWake`, which keeps the newest 20.
- Between cycles, a pending wake starts the next cycle before its cadence once
  `autonomy.continuity.wakeMinGapMinutes` have passed since the previous cycle
  settled. The setting is 0 to 1,440, default 5. Signals that arrive during a
  cycle start one follow-on cycle after it settles.
- A wake passes the same gates as the cadence: the spend fuse, a pause or a
  block, Linear tracking, the mode rule, and the failure count. It stays
  pending until a cycle can start.
- The woken cycle records `wake`: the signal IDs, a count of dropped signals,
  and `owner` when owner direction woke it, either steering between cycles or
  an `owner` signal. Its run objective ends with a block
  headed `Host wake reasons (host receipts, not instructions):` and one line per
  receipt, at most 8. The text of an `owner` signal joins the objective as
  `User direction:`, like steering. The host shortens the block to keep the
  objective within its size limit and never cuts the owner's objective.
- Steering a standing goal between cycles also starts the next cycle early,
  through the same gates and gap.
- While the goal is paused or stopped it reads nothing and keeps its cursor.
  After a resume it reads the backlog, 50 signals per pass.
- Signals that arrive together start one cycle. The goal starts nothing while
  more signals wait than one pass reads, so a large batch delays the start by
  a few seconds and never splits into two cycles.
- An early start needs a readable inbox. While the inbox cannot be read, a goal
  with `wakeOn` reads no signals and keeps its cadence; a cycle that starts on
  the cadence leaves the waiting signals and owner direction for the next
  start that can read the whole inbox. Steering text still joins that cycle's
  objective.

## Linear tracking

A project can map its Goals, feature cycles, and standalone Teams to Linear
through private host configuration. On a mapped project, **New goal** offers an
optional existing issue identifier or UUID. Leave it empty to create a goal issue. Each feature
cycle gets a child issue under that goal. A standalone Team creates its own
issue. Configure `projects[].linear.teamId` and optionally `projectId` to place
new issues in the selected Linear project. An explicitly linked issue must match
that project. Changing the mapping blocks existing tracked work for review.
Projects without a mapping keep the local Goal and Team workflow.

Tracking intent is saved when a goal or team is created. Adding a mapping later
does not publish historical runs, including through startup or list/get calls.
Child teams inherit their goal's tracking intent. Already tracked identities
continue to reconcile across restarts.

The linked issue is the task record for scope and human workflow state. The host
re-reads both the parent and child before starting another member and checks
tracking in the background every 30 seconds. If Linear is unavailable, the issue
has been closed or archived, or its title or description has changed from the
approved snapshot, the host blocks further work. Moves between open workflow
states are accepted. Read the recorded reason and obtain new approval for
changed scope; a network recovery alone does not authorize different work. A cycle receives the
recorded source issue as context; that context cannot expand its approved goal
paths, non-goals, or limits.

A goal starts no new cycle while its tracking is not `synced`, for example
during a Linear outage or a rate limit. The goal stays `running`, and its
reason is `New work waits for Linear tracking: ` followed by the tracking
reason, which during a rate limit names when tracking retries. The reason
clears once tracking is `synced` again. A tracking `blocked` status blocks the
goal instead.

Goal and Team pages show the issue link, title, workflow state, tracking status,
and last check time. A cached issue record is not proof that Linear is currently
reachable. The issue's workflow state stays separate from local execution state,
agent review, and product outcome assessments. Infinite does not automatically
change that state or mark an issue Done when checks pass.

A live run or goal, and a finished run its live goal still names as active,
must be confirmed within 30 seconds, and the host re-reads them on that cadence.
A finished item only informs the pages, so a page view accepts a confirmation up
to 10 minutes old before it asks for a new read. Continue, Resume, and delivery
or verification reconciliation still require a confirmation under 30 seconds
old before they act. A blocked run keeps the 30-second rule for page views,
because the host can restart it by itself. Each read asks Linear for only the
issues it names, and a read that is due also refreshes issues past half their
window, so records expire together.

Linear limits each user's requests and query complexity per hour. When Linear
answers with a rate limit, the host pauses every Linear request. The first rule
that applies sets the pause:

1. A `Retry-After` header, in seconds or as an HTTP date, is Linear's deadline.
   No request goes before it, up to two hours.
2. Otherwise, the reset time of the limit Linear reports as spent, or the latest
   reset it reports. Resets in epoch milliseconds or epoch seconds are accepted.
   Linear's limits refill continuously, so this pause lasts five minutes at most.
3. Otherwise, one minute, doubling each time the limit repeats, up to five
   minutes.

Dates and reset times are read against the response's `Date` header, so a host
clock that differs from Linear's does not shorten the pause. When the pause
ends, one request asks Linear first. Other requests wait for its answer: another
limit starts a new pause, and any answer without a limit reopens normal traffic.

While the pause lasts, each waiting goal and each active run without a reason
of its own shows "New work waits for Linear tracking:" with the retry time, and
its tracking view carries `retryAt`. A run also shows this when its tracking has
failed or its last confirmation is more than a minute old. The service journal
records one line a minute at most, with the remaining requests and complexity
that Linear reported. `GET /api/linear/status` reports the last rate-limit
headers, which rule set the last pause, any current pause, and the requests and
complexity this host sent in the last hour. It carries no credential and no
issue content.

When a tracked run becomes blocked, its status comment records the reason and
the next step, and the issue gets a `Blocked` label. The host uses the team's
own `Blocked` label, or a workspace label of that name, and creates one in the
team when neither exists. It removes the label when the run moves again. A
failed label update is retried later and never holds back the run.

The host keeps issue creation and evidence delivery in a durable outbox.
Requirements populate new issue descriptions; briefs, steering, questions and
answers, user outcomes, and terminal check/review summaries are sent as comments.
The next cycle waits for confirmation of the prior cycle's evidence. After a
lost write response or restart, the host reconciles saved issue and comment IDs
before retrying. Raw logs and captured provider output are excluded; selected
text is not guaranteed to be free of secrets.

Add a host credential and project mapping to private configuration, alongside
the project's existing path and checks. Replace the example team UUID with the
intended Linear team's ID:

```json
{
  "linear": { "apiKeyFile": "/run/secrets/linear-api-key" },
  "projects": [{
    "id": "example",
    "name": "Example project",
    "path": "/srv/infinite-data/projects/example",
    "linear": { "teamId": "00000000-0000-4000-8000-000000000000" },
    "team": { "checks": [{ "command": "npm", "args": ["run", "check"] }] }
  }]
}
```

The key must be a private `0600` file outside the host's state directory, run
directory, team workspace root, and every project root. The host uses Linear's
official HTTPS API. Custom `linear.endpoint` values are restricted to HTTP
loopback `/graphql` endpoints when the host environment is `local`, for rehearsal. The credential is not passed into agent environments.

The browser receives tracking records and a project capability flag, never the
Linear API credential. Keep credentials, workspace mappings, and concrete issue
bindings in private configuration or encrypted runtime state. Do not copy them
into tracked configuration examples, screenshots, or repository reports.

## Usage and budgets

The sealed host ledger records measured OpenCode token usage. Configure a `usage` block to expose the Cost view, account mapping, and budgets. The dated built-in catalog prices DeepSeek and Meta models; custom prices can override it. The ledger records Claude Code and Codex tokens for sessions whose hooks stream a transcript. Each figure states its coverage. Those records are not priced yet, so they count as unpriced steps. The web client, API, and CLI read the same ledger.

```json
{
  "usage": {
    "prices": {
      "PROVIDER_ID/MODEL_ID": { "input": 0.5, "output": 2, "cacheRead": 0.1, "cacheWrite": 0.6 }
    },
    "accounts": {
      "deepseek": { "kind": "metered", "match": ["deepseek/*"], "balance": { "source": "deepseek", "apiKeyFile": "/ABSOLUTE/PATH/TO/DEEPSEEK_KEY" } },
      "meta": { "kind": "metered", "match": ["meta/*"] },
      "claude": { "kind": "subscription", "match": ["claude/*"], "planUsd": 200 },
      "codex": { "kind": "subscription", "match": ["codex/*"], "planUsd": 200 }
    },
    "budgets": {
      "opencode": { "usd": 50, "period": "month" }
    }
  }
}
```

- **Prices** are USD per million tokens, keyed `provider/model`. `cacheRead` and `cacheWrite` default to the `input` price. Reasoning tokens bill at the `output` price.
- **Catalog** prices are dated 2026-10-19 and include DeepSeek Flash/V4 Pro and Meta Muse Spark/Contributor/Wonder. DeepSeek weekday UTC peak windows are priced at twice the off-peak rate; Chinese public holidays are not modelled. Configured prices take precedence over the catalog, then OpenCode-reported cost is used. Each catalog entry records its source URL and date.
- **Accounts** map provider/model globs to a metered or subscription account. `planUsd` is the configured fixed monthly fee. An owner can override a subscription account's fee; the override is stored in sealed host state and takes precedence over the config default. Account views include `planSource: "owner"` for an active override or `"config"` for a configured fee; the marker is omitted when neither supplies a fee. Resetting an override restores the config default. The DeepSeek balance key is read once from an absolute `apiKeyFile`; it is never logged or returned to clients. The host refreshes at most every 15 minutes and preserves the last good balance as stale after a failure. Meta has no balance in this view; other balances show `—` unless supplied by an official provider API.
- **Budgets** are per provider, in USD, with a `day`, `week`, or `month` period. Periods are UTC, weeks start on Monday, and the period defaults to `month`.

Every total carries an unpriced count. Clients mark incomplete priced totals with `≥` and do not turn missing usage or price into a zero-cost claim.

Budgets are informational. The host shows spent against budget and marks `over budget`, but it never pauses, refuses, or hides a team, goal, or session because of spend.

OpenCode team members and OpenCode sessions started from the local UI report usage. Grok and OpenCode in a native terminal stay unmeasured, so their sessions, and team members that use them, show `Unmeasured`. Unmeasured work is counted separately and is never added to a total as zero.

Headless team members record the model that was requested for them. If the provider substitutes another model, the ledger still prices the requested one.

`GET /api/usage` returns the month and account summary. `PUT /api/usage/accounts/:id/plan` is owner-only and accepts `{ "planUsd": number | null }` for a subscription account; the fee must be from 0 to 100000 USD with at most two decimal places. `null` clears the owner override and restores the configured `planUsd` default. The response contains the refreshed `{ accounts }` list, including each fee's optional `planSource`. `GET /api/usage/daily` accepts `days` (1–366), an IANA `tz` (default UTC), and optional `project`. `GET /api/usage/projects` and `/api/usage/projects/:id` provide project roll-ups. Owners can request a DeepSeek refresh with `POST /api/usage/balances/refresh`. The CLI provides `infinite cost`, `infinite cost plan ACCOUNT USD|reset`, `infinite usage`, `usage projects`, `usage project PROJECT_ID`, `usage goal GOAL_ID`, and `usage models [--role ROLE]`; read commands accept `--json`. For example, `infinite cost plan claude 200` sets a monthly fee and `infinite cost plan claude reset` removes the owner override.

## Provider usage limits and fallbacks

A provider can refuse work because the account reached a usage limit. The host records that observation, stops the affected team member, and can relaunch the work on a fallback profile from another provider. A limit does not mean the task failed, and a switch does not mean progress. Only a member's report establishes either.

### Configuration

A profile may name another profile in the same lineup as its `limitFallback`. The lineup may also carry a `fallbacks` pool of profiles that exist only to be fallbacks, beside `implementers` and `escalations`. A `limitFallback` may name an implementer, an escalation, or a pool entry. Model ids below are placeholders for the operator's own.

```json
{
  "coordinator": { "id": "opus-xhigh", "...": "...", "limitFallback": "deepseek-pro-xhigh" },
  "implementers": [
    { "id": "haiku-medium", "...": "...", "limitFallback": "deepseek-flash-medium" }
  ],
  "fallbacks": [
    { "id": "deepseek-pro-xhigh", "label": "DeepSeek V4 Pro high", "provider": "opencode", "model": "deepseek/deepseek-v4-pro", "variant": "high", "tier": "strong" },
    { "id": "deepseek-flash-medium", "label": "DeepSeek Flash medium", "provider": "opencode", "model": "deepseek/deepseek-flash", "variant": "medium", "tier": "light" }
  ]
}
```

The host validates this when it loads configuration and when a goal or team snapshots its lineup:

- The named id exists and belongs to a different provider than the profile it backs.
- A `strong` profile falls back only to a `strong` profile.
- One id means one provider, model, effort or variant, tier, and data-use setting throughout the lineup.
- Fallback chains are followed at most two hops, and a cycle is a configuration error.

### What counts as a limit

- Claude Code: a `StopFailure` hook with `error` of `rate_limit`, a `Notification` of `quota_auto_resume_stale` or `quota_auto_resume_disabled`, or the documented limit notice on screen. Other `StopFailure` errors stay provider errors. `quota_auto_resume_fired` is not a limit. It means the wait ended and the limit lifted, so it ends the episode and clears the displayed limit.
- Codex terminal sessions: the `usage limited` indicator in the terminal's own status row. Limit messages in the transcript body never trigger on their own. They may only supply a reset time.
- Codex app-server sessions: `turn/completed` with `usageLimitExceeded`. `rateLimitExceeded` stays a provider error.
- OpenCode is not a source. It retries its own 429 responses.

Clock times in a notice, such as `resets 3:45pm`, are read as UTC because the host runs in UTC. A time that cannot be parsed is left unset.

### Confidence

Each observation is single-source or corroborated.

- Claude Code: the hook alone is single-source. It is corroborated when the screen shows the notice in the same check or the next two, or when a `quota_auto_resume_*` notification follows.
- Codex terminal: the status row is single-source when first seen. It is corroborated when it persists across at least three consecutive screen checks spanning `attention.limitConfirmMs`, 30 seconds by default, with no other output change.
- Codex app-server `usageLimitExceeded` and Claude `quota_auto_resume_*` notifications are corroborated on arrival.

Observations are grouped into an episode held in the worker. An episode starts at the first observation. It ends after three consecutive screen checks with no match and no armed corroboration, after a notification that the limit lifted, or when the agent completes a turn that did not fail. Only a source that can report a failed turn counts: a Claude Code `Stop` hook, as distinct from `StopFailure`, or a native adapter's turn status. A Codex terminal turn end, from its `Stop` hook, notify, or OSC notification, cannot say the turn failed, so it ends nothing. An episode journals at most one single-source and one corroborated signal, in either order. A reset time stated by any observation carries onto the later ones. A successful turn also clears the session's displayed limit, and screen matching stays suppressed until a check sees no match.

### What the host does

- A corroborated observation, or a single-source Claude hook observation, stops the member and relaunches its work on the fallback profile. The replacement keeps the same working copy and base commit. Its prompt is the original prompt, with feedback and recorded answers, retargeted to the fallback provider. It notes that the previous member's partial edits are present and passed the path-scope check. A single-source Codex status-row observation only annotates and waits for corroboration.
- The task records `limitSwitches` entries: the profile it left, the profile it moved to, the reason, the stated reset time if any, the member, and when. This does not use the task's one escalation. Each replacement counts against the run's and goal's member limits.
- With no resolvable fallback, the run blocks with a reason naming the profile and the limit times. Its workspace remains available under the workspace retention policy described above.
- Only a corroborated observation writes the host-level entry in `providerLimits`. It lasts until the provider's stated reset time, capped at 24 hours, or 15 minutes when the provider stated none. Only a later successful turn, by the same measure, of a session of that provider clears it early, and an older observation cannot restore a cleared entry. New members of that provider launch on their fallback while the entry exists. With no fallback, they launch on the original profile.
- A limit seen in any session, team member or not, updates the host-level entry. Nothing else happens to a non-team session.
- Clients show the entry on the Teams list and the observation on session rows. Reset times are the provider's own statement, and a missing time means the provider gave none.

### What the host never does

- It never sends input to a limited member, answers a provider dialog, or enters credentials. Stopping the member is the only action.
- It never extends a run, goal, or member limit because a provider was unavailable.
- It never changes owned paths, allowed paths, deadlines, or the goal's lineup snapshot. A fallback pins a different profile for one member.
- It never reads a limit or a switch as completion, failure, or product impact.

A fallback onto a contributor-data profile shows the same data-use disclosure as any other profile. The operator decides whether to configure one.

### Operator preconditions

Before relying on the detectors unattended, confirm on the target host:

1. A subscription quota hit delivers `error: "rate_limit"` in `StopFailure`.
2. The Codex terminal's `usage limited` indicator sits in its bottom status row at the configured terminal size.
3. OpenCode's reported cost is non-zero for the providers actually configured.
4. Whether Codex emits a `Stop` hook, a notify `agent-turn-complete`, or an OSC 9 turn-complete notification when a turn ends on a limit. None of them ends a limit episode, but each one moves the session to a finished turn.
5. Whether the Claude Code limit notice uses a straight or a curly apostrophe in "You've hit your … limit". The detector accepts both.

## Roles and execution

| Role | Responsibility | Output |
| --- | --- | --- |
| Coordinator (project manager) | Inspect the request and evidence, choose a scoped opportunity, define owned paths and dependencies, and select allowed worker profiles | Short brief and plan, discovery request, question, or no-change report |
| Scout | Answer a bounded research question without editing the repository | Findings with sources and observations |
| Implementer | Build its task in a separate working copy within its owned paths | Result, question, blocker, or explicit escalation request |
| Integrator | Repair an integrated result after failed checks or review feedback | Repair result within the approved scope |
| Reviewer | Inspect the integrated change and its evidence without editing it | Approval or changes requested; UI evidence when applicable |

The workflow keeps planning small. The coordinator may request one batch of
1–3 read-only scouts from the worker pool, then receives their recorded findings
once. It skips discovery when the request and repository already supply enough
evidence. Scouts cannot commission more agents. A goal brief records the
observed problem, evidence, data shape, acceptance criteria, expected effect,
and whether the interface changes. Prompts call for a concise brief and useful
tasks, without process documents or artificial subdivisions.

Each assignment gives a light worker one coherent outcome and the smallest
necessary set of owned paths, with explicit exclusions. Its `instructions`
contain the requested behavior, inspected source paths and entry points, agreed
data/interface contracts and applicable error cases, constraints and dependency
outputs, observable acceptance criteria, and exact focused check commands with
expected results. Those checks supplement the run's required verification.
The coordinator settles product and shared-interface decisions before dispatch,
splits independent outcomes, and orders shared-interface work before consumers.
Workers choose routine implementation details within that brief; a missing
material requirement or required path goes through the existing question or
blocker report with the exact gap and smallest proposed resolution. These are
prompt instructions, not host validation of a brief's semantic completeness.

The coordinator prefers `light` profiles for bounded research and implementation
and selects from the configured pool. Each plan has 1–12 tasks. The host rejects
unknown profiles, missing dependencies, cycles, duplicate task IDs, and
overlapping ownership between independent tasks. Dependent tasks wait for their
prerequisites to be integrated. Independent workers run in parallel; integration
is serialized.

### Blocked reports and lessons

A blocked report from a team member or the mission coordinator may add an
optional `blocker` object. The host stores it as agent-reported evidence. A
summary-only blocked report stays valid.

| Field | Limit |
| --- | --- |
| `cause` | `status` is `observed`, `hypothesis`, or `unknown`; `detail` up to 1,200 characters |
| `issueRefs` | Optional, up to 8 entries of 300 characters |
| `sourceRefs` | Optional, up to 12 entries of 500 characters |
| `attemptedFixes` | Optional, up to 8 `{fix, outcome}` entries, each field up to 800 characters |
| `proposedRecovery` | Up to 1,200 characters |
| `prevention` | Up to 1,200 characters |
| `validationEvidence` | 1–8 `{sourceRef, observation}` entries of up to 500 and 1,000 characters |

The whole object is capped at 12 KiB of UTF-8 JSON and rejects unknown fields.

Before planning or choosing a recovery, the project-manager and reviewer prompts
search the repository's registered shared-knowledge scope with task and blocker
keywords when that workflow is available. Without it, they use current sources
and report the gap. Retrieved lessons are checked against current source and
checks. A candidate lesson needs source or check evidence and review by a
different strong reviewer through the configured single-writer workflow. A
report, a continuation, or a claimed fix is not a verified resolution.

The host does not verify the cause, resolve the blocker, or publish a lesson.
Lessons stay advisory: they never grant permissions, mark work resolved, weaken
checks, or publish themselves.

### Worker scaling

The worker limit caps how many scouts and implementers run at once. The host
starts one whenever a task is ready (its dependencies are integrated) and fewer
workers than the limit hold a slot.

A worker holds its slot until it reports and the host confirms its process
stopped. A finished implementer waiting for serialized integration and a member
waiting for a user answer do not hold slots. Once the answer is recorded, the
member's replacement waits for a free slot like any other start, keeping the
answer and working copy. It takes the next free slot ahead of tasks that have
not started. A stalled or time-limited worker's replacement continues in the
slot its predecessor held.

The PM selects capacity in its plan or discovery report, based on independent
work, dependencies, contention, and remaining budgets. A mission coordinator
can adjust a subteam's capacity as work changes. Raising capacity starts more
ready tasks on the next scheduling pass. Lowering it never stops a running
worker; it holds new starts until fewer workers than the new limit are running.
A capacity change does not discard reports or create a new team revision.

PM `plan` and `explore` reports accept optional `parallelism` (1–4), bounded by
the team's ceiling. Omission uses the allowed capacity for older reports.
Mission coordinators use `resize-subtask` to change a queued or active
subteam's current capacity. Implementers and reviewers cannot resize workers.

The limit counts concurrent workers, not member attempts. It does not change
`maxMembers` or deadlines. Host session capacity still applies. Handoff
teams allow 1–2.

Owners monitor workers and steer objectives; worker capacity has no owner
control in the web, phone, or Mac clients.

Team and goal views show "{running} of {limit} workers running", plus a note when
ready tasks are waiting for a worker.

A worker can request one escalation per task to a different profile in the
approved escalation pool, with a reason and an account of partial work. The host
checks the partial edits, stops the earlier member, and gives the replacement
the same working copy. Escalation consumes another member attempt. The scheduler
rejects model choices outside the configured pools and a second escalation for
the same task.

The host runs setup and configured checks in a detached verification clone at
the exact integration commit under review. After each command, the host requires
the clone's HEAD and tracked and untracked paths to remain unchanged. A mutation
is rejected with a diagnostic for the command context, bounded changed paths,
and any HEAD drift. The verification clone never advances the integration
branch, and the original integration checkout remains available for inspection.

After a completed setup command or configured check changes its isolated
verification clone, the same guarded Resume is available only when the
current-revision check evidence is terminal and the recorded integration head
is unchanged. Resume creates a clean sibling under recovery/ from that commit,
starts a fresh plan there, and retains the original workspace and prior member
and check evidence. Mutations during member setup or workspace preparation are
not Resume-eligible; they require reconciliation and a new team. Other check or
workspace blocks also require inspection and a new team.

Prompts prefer API, process, integration, or end-to-end checks that exercise
changed behavior. Before adding a test, the agent must identify its observable
contract, a credible regression, and the gap in existing coverage. Repository
instructions still apply. Repair attempts are bounded; unresolved failures
remain visible.

Each configured check may run for `teams.checkMinutes` (default 60). A check that
runs past the limit is stopped and blocks the team with a resumable reason. The
timeout does not count as one of the team's two correction rounds, because it is
host evidence about the check, not about the agents' work. When the command runs
through a `teams.commandPrefix` launcher such as `sudo`, the host may be refused
permission to signal it. The check output then says so, and the command is left
to finish with its result discarded. Size the limit for the project's full check
on the execution host.

For a brief that changes the interface, an approving reviewer must include
`uiEvidence` describing the runnable flow inspected, results, and limitations.
This is an agent's recorded claim, separate from the host's command results. If
inspection is unavailable, the reviewer must request changes or report a
blocker. Missing UI evidence and invalid acceptance evidence share one
corrected review per run revision. For a run with a brief, the reviewer report
also includes one `acceptance` entry per brief criterion, numbered in order,
with a `verified`, `not-verified`, or `inconclusive` verdict and observed
evidence. The host rejects
approval unless every criterion is verified, and rejects duplicate or out-of-range
criterion numbers for either verdict. Runs without a brief keep their existing
review behavior. The evidence text is kept on `run.review` in the team view;
the `review.recorded` event carries only each criterion's number and verdict,
as it carries only rubric scores. If the corrected report in that revision still
has missing UI evidence or invalid acceptance evidence, the run blocks with the
matching code (`ui-review-evidence-required` or `acceptance-evidence-required`)
for the first problem. All roles are prompted to write plain English and report
only evidence and checks they observed.

## Model routing

Add `lineup` to the private `teams` configuration. The Team form selects the
configured lineup by default; a user can instead select one configured provider
for all roles. Goals always use a recorded lineup and require both coordinator
and reviewer profiles to have `tier: "strong"`.

This example uses Opus 5.5 at `xhigh` for coordination and repair, Astra 6 at
`high` for review, and Haiku 5.5 and GPT-6 Luna at `high` for ordinary worker
tasks. Opus 5.5 `xhigh` and Astra 6 `xhigh` are available through the explicit
escalation pool. Model IDs live in host configuration, rather than application
routing code.

`permissionReviewer` is an optional Claude Code profile for read-only review of
member permission prompts. When omitted, the coordinator is the fallback
reviewer and must have `tier: "strong"`; configuring `permissionReviewer` removes
that strong-tier requirement for this role. A light Claude profile at `high`
effort fits this narrow, mechanical rule because the host rechecks the answer
and applies it. The repository ships no default lineup, so add the profile to
the deployment's host configuration to use it.

```json
{
  "lineup": {
    "coordinator": {
      "id": "opus-xhigh", "label": "Opus 5.5 xhigh",
      "provider": "claude", "model": "claude-opus-5-5", "effort": "xhigh",
      "tier": "strong", "dataUse": "standard"
    },
    "implementers": [
      {
        "id": "haiku-high", "label": "Haiku 5.5 high",
        "provider": "claude", "model": "claude-haiku-5-5", "effort": "high",
        "tier": "light", "dataUse": "standard"
      },
      {
        "id": "luna-high", "label": "Luna 6 high",
        "provider": "codex", "model": "gpt-6-luna", "effort": "high",
        "tier": "light", "dataUse": "standard"
      }
    ],
    "integrator": {
      "id": "opus-xhigh", "label": "Opus 5.5 xhigh",
      "provider": "claude", "model": "claude-opus-5-5", "effort": "xhigh",
      "tier": "strong", "dataUse": "standard"
    },
    "reviewer": {
      "id": "astra-high", "label": "Astra 6 high",
      "provider": "codex", "model": "gpt-6-astra", "effort": "high",
      "tier": "strong", "dataUse": "standard"
    },
    "escalations": [
      {
        "id": "opus-xhigh", "label": "Opus 5.5 xhigh",
        "provider": "claude", "model": "claude-opus-5-5", "effort": "xhigh",
        "tier": "strong", "dataUse": "standard"
      },
      {
        "id": "astra-xhigh", "label": "Astra 6 xhigh",
        "provider": "codex", "model": "gpt-6-astra", "effort": "xhigh",
        "tier": "strong", "dataUse": "standard"
      }
    ],
    "permissionReviewer": {
      "id": "haiku-permission-reviewer", "label": "Haiku 5.5 high",
      "provider": "claude", "model": "claude-haiku-5-5", "effort": "high",
      "tier": "light", "dataUse": "standard"
    },
    "evaluators": [
      {
        "id": "astra-high", "label": "Astra 6 high",
        "provider": "codex", "model": "gpt-6-astra", "effort": "high",
        "tier": "strong", "dataUse": "standard"
      }
    ]
  }
}
```

`evaluators` lists the profiles that may check a plan. This example names the
reviewer's profile explicitly. See [Intent check](#intent-check) for how the
list is derived and how a checker is chosen.

Optional OpenCode workers can be added to `implementers`. OpenCode uses a
provider-qualified `model` and optional `variant`; it does not accept an
`effort` field in these profiles. These examples match the approved high-variant
profiles for Meta Muse Spark Contributor and DeepSeek Flash:

```json
[
  {
    "id": "muse-spark-contributor-high", "label": "Muse Spark 1.3 Contributor high",
    "provider": "opencode", "model": "meta/muse-spark-1.3-contributor",
    "variant": "high", "tier": "light", "dataUse": "contributor"
  },
  {
    "id": "deepseek-flash-high", "label": "DeepSeek V4.1 Flash high",
    "provider": "opencode", "model": "deepseek/deepseek-flash",
    "variant": "high", "tier": "light", "dataUse": "standard"
  }
]
```

`tier` is an optional routing label (`light` or `strong`), not a measured price
or capability guarantee. `dataUse` is an optional disclosure (`standard` or
`contributor`); the web client displays contributor settings. It does not change
a provider's terms or retention policy. Review those terms before routing
project context to a contributor profile. A reused profile ID must identify the
same provider, model, effort or variant, tier, and data-use setting throughout
the lineup.

Each selected provider executable must be configured and authenticated. Keep
its sandbox and permission settings in the ordinary provider profile. Move
model, effort, and variant selections into the lineup, and remove fallback-model
flags. Conflicting arguments are refused. Infinite does not silently substitute a
model when a requested selection is unavailable.

Claude launches receive `--model` and `--effort`; Codex receives `--model` and
`-c model_reasoning_effort=...`; OpenCode launches in headless `run` mode with
`--model` and optional `--variant`. These are requested settings, not evidence
of the backend model that served a turn. Provider account access and
organization restrictions still apply. A provider failure leaves the assignment
unresolved. The configuration example does not establish model availability on
a particular account.

A goal snapshots its lineup at creation, and every cycle uses that snapshot.
Standalone teams also snapshot their lineup. Each member records its provider
and selected profile before launch. Restart, steering, question retries, and
later cycles preserve those selections even if host configuration changes.
Credentials and permissions continue to come from the current provider
configuration. Legacy single-provider teams retain their provider selection.

Mixed-model sudo profiles use the explicit `-- EXECUTABLE` boundary from the
Ubuntu template. Before it, supported options are `-n`, `-H`, `-u USER`, and
`-g GROUP` (or their separate-argument long forms). Other wrapper forms are
refused so provider flags cannot become prompt text.

Team launches preserve configured provider permission modes. A team assignment
does not grant tool permission. Folder trust prompts wait for the owner unless
the owner trusts the team roots (see [Workspace trust](#workspace-trust)).
Product questions reported by a member wait for `infinite team answer`.

Headless OpenCode `run` rejects unmet permission requests; this adapter does
not offer an interactive approval flow for that provider. A denied reporting
tool or required tool can stop the member without an accepted report. Inspect
the failure and the configured provider policy; retries do not grant permission.

## Delegating permission decisions

In a workspace that the owner delegated, a separate permission agent answers
the tool permission requests of agent sessions: team members, sessions outside
a team run, and headless Claude Code sessions. It allows a request once, or
rejects it with a recorded reason. Five classes of request always wait for the
owner's own answer: production or staging actions, new or external
credentials, money, destructive operations outside the workspace, and global
or account settings.

The permission agent serves a project when both conditions hold:

- An owner act covers the project: `infinite permissions delegate`, or the
  owner's first `infinite repo init` of that project without
  `--permissions off`. See
  [workspace permission delegation](cli.md#workspace-permission-delegation).
- The host is ready: a light profile, strong profiles from at least two model
  families, and a current replay result under the owner's miss-rate threshold.
  See [readiness and replay](cli.md#permission-agent-readiness-and-replay).

`infinite permissions status` shows both. A project that is not served is
handled as before; for a team run that means the coordinator review in
[the next section](#coordinator-review-for-runs-the-permission-agent-does-not-serve).

Each request passes these steps in order:

1. **Class rules.** A host rule that establishes one of the five classes sends
   the request to the owner. No model turn runs, and the push names the class.
   The rules read the command's words and its targets as real paths. They also
   cover a workspace trust prompt and a request that can be granted only as a
   persistent approval. `permissionAgent.releaseCommands` in the host
   configuration names this host's deploy commands for the production or
   staging class.
2. **Qualify.** The host must hold the whole action, and the dialog must offer
   a one-shot accept and a one-shot reject. A request that does not qualify
   can be rejected or sent to the owner. It is never allowed.
3. **Lock and replay.** An assignment that repeated one rejected request twice
   is locked and gets no model turn until the owner unlocks it. An identical
   request under the same authority is answered from its recorded verdict.
4. **Tier.** A routine request goes to the light model, which can allow it or
   refer it. A request is raised to the strong model when it is destructive,
   reaches outside the session's directory, uses a release verb or a push,
   needs privilege, names a credential or a payment, changes a settings file,
   installs globally, cannot be read by the host, or follows a reject in the
   same assignment. The strong model comes from a model family other than the
   requester's. It allows the request, rejects it with a reason code, or names
   the owner with a class.
5. **Delivery.** The host records the decision. It then checks that the
   session still runs, that the dialog and its evidence are unchanged, that
   the owner's authority still holds, and that no person holds input control.
   Then it sends one option. A reject goes through the dialog's one-shot
   reject option, followed by a fixed host notice that carries the reason
   code. No model text reaches the requesting agent. A destructive request is
   delivered only on an allow from the strong model. A delivery whose result
   is unknown is never repeated.

A reject is final for that request, and members are told not to reach the same
effect by another route. The reason codes are `outside-workspace`, `unrelated`,
`unsafe`, `incomplete`, `uncertain`, `unavailable`, `locked` and `needs-owner`.
`outside-workspace` covers reading, fetching, copying or running anything from
another session's, run's, worktree's or checkout's directory, even when the
request changes nothing there. A fetch, pull or clone that names another
checkout's path is such a read. These stay inside: the session's scratch roots,
its task-owned temporary files, its own repository's Git metadata (also a
worktree's shared Git directory), fetches from the repository's network remotes,
and the installed toolchains and package-manager caches that an allowed
operation uses. The task text cannot widen the session root: a directory that
the task names or asks for is still outside it.
Run status shows the code, and a locked assignment shows as blocked on a
permission. `infinite permissions unlock` ends a lock and `infinite permissions
reopen` closes a reject so that the request gets a fresh review; neither
allows anything.

The owner is pushed for a class request, for a request that the host can
answer in neither direction, and for a request of a project that the agent
does not serve. An allowed, rejected or stale request pushes nothing.
`infinite permissions log` lists every decision with its tier, rules and
delivery events; see the [decision log](cli.md#permission-decision-log).

`infinite team revoke-permissions TEAM_ID` returns one run's requests to the
owner. `infinite permissions revoke` ends a workspace's delegation: its
pending decisions are retired and never applied, and an answer that is already
with a member's session is fenced before the revoke is acknowledged. The owner's halt stops the
permission agent for the projects it covers: no reviewer turn starts and no
recorded verdict is delivered until the release.

A session outside a team run is served when the host owns its terminal. A
laptop-execution session, a cmux session and a native-UI session stay with the
owner, and so does a dialog that first appears while a person holds input
control. The task evidence for such a session is its title and the prompts
that the owner submitted through the host, never agent output. A reject
reaches the session through the dialog's one reject option, and the fixed
notice follows when that option takes text. A dialog that offers two reject
options has no recognised one-shot reject, so a reject for it goes to the
owner.

A headless Claude Code session (`--print` in the default permission mode) is
served through a hook channel. A class call ends the provider's run and waits
for the owner's answer on the session's prompt. The owner's allow resumes the
same conversation and runs that call once. A served headless launch loads no
user, project or local settings file, so the allow rules, environment values
and model defaults of those files do not apply to it. Headless sessions of
other providers are not served.

### Coordinator review for runs the permission agent does not serve

This is the earlier repository-level delegation. It decides only for a team
run that the permission agent does not serve, and it is kept until the
permission agent has replaced it on the host. A run uses one path or the
other, never both for the same request. When the permission agent starts to
serve a run in flight, the run's coordinator reviews are retired without an
answer, an answer in flight is fenced, and the coordinator review decides
nothing more for that run. The switch is fenced: from the moment the run can
be served no coordinator answer starts, the run's coordinator answers already
with a worker are fenced there, and only then does the permission agent serve
the run. Each coordinator answer is recorded as one a worker may still type in
the same save that dispatches it, and stays so until its result is conclusive,
the worker confirms its fence, or its session has exited. An answer in that
state, including one whose result was never confirmed or that was in flight
when the host restarted, keeps the run from switching; meanwhile the run's dialogs stay
with the owner. The switch runs at the owner act or the replay that made the host
ready, not only at the next scheduler pass, and the coordinator's authority is
read once more under the session's input lease immediately before its answer
is typed.

The first repository enrollment enables this delegation by default:

```sh
infinite repo init
```

This pins a repository scope and a limit of twenty-five decisions to each new
run. Later enrollments preserve the saved policy, including an explicit opt-out.
To enable delegation on an existing enrollment, pass `--permissions coordinator`.
Add `--permission-scope TEXT` or `--permission-limit N` to that explicit command
to change the scope or set a limit from one to fifty. Existing runs remain
unchanged. An older host without delegation support requires an upgrade or an
explicit `--permissions off` choice.

The default scope treats routine development work as the coordinator's to
approve: repository inspection and fetch, scoped edits and staging, dependency
installation from the repository's declared manifests and lockfiles, test
planning, builds, tests, scripts, local listeners and local browser checks for
the accepted objective and assigned role, inside the assigned workspace. These
may run outside the provider sandbox and use network access, local sockets, IPC
and task-owned temporary files while preserving the assigned repository and path
scope. It escalates only production or staging actions (deploy, promote, roll
out, release, publish), new or external credentials, other repositories, global
or account settings, destructive operations outside the assigned workspace,
persistent approvals, permission bypasses, and commands whose effect is
unrelated to the task or appears malicious. Delivery keeps its separate pinned
policy. An enrollment whose saved scope is exactly an earlier host default pins
the current default scope on new runs, and a saved limit of ten (the earlier
default) becomes the current default limit with it; the host cannot tell an
explicit ten from the old default. Any other saved scope or limit is kept as
saved. Re-enroll with `--permission-scope` or `--permission-limit` to pin an
explicit policy.

While a run's coordinator can still decide a member's prompt, the phone is not
pushed for it. The push arrives only when the request becomes the owner's: the
coordinator escalated it, the review window expired, the run spent its decision
limit or cannot act, or bounded evidence recovery cannot establish a complete
one-shot request. A run gets
a short grace period to start the review before an unreviewed prompt is pushed.

A run revision has one read-only permission reviewer: the pinned Claude
permission reviewer profile, or the strong coordinator when no reviewer profile
is configured. The reviewer receives the task, owner scope and assignment once.
Each qualifying request is a turn that resumes the same native conversation and
adds that request's evidence together with the owner's current steering and
answers. The reviewer keeps its member and conversation while the integration
head moves, because it has no file tools. The five-minute review window applies
to each turn. If the conversation cannot be resumed, the host restarts it once with
the full assignment and current request evidence. Between requests, the
reviewer waits without a running process and holds no agent slot. It reports
approve-once, request-evidence, or escalate. The host checks the assignment,
workspace, prompt, policy, expiry and human input control before delivering the
recorded choice.
Workers cannot approve their own requests. The permission reviewer runs
noninteractively with built-in tools disabled and only its assignment's report
tool allowed. It can request up to eight specific source paths for bounded read-only
collection; the host collects them and continues the same conversation with a
fresh review turn. It escalates when the supplied evidence is insufficient. An
incomplete or collapsed prompt gets a diagnostic turn that can never approve.
Worker provider modes, global trust settings and credentials remain unchanged. Other
coordinator providers are not yet supported for this role.

Within the run revision's decision limit, an identical request can reuse a
terminal reviewer's recorded verdict without another turn. The reuse key binds
the pinned policy, semantic prompt and chosen option, task ID, changed paths,
and accepted checks; it excludes prompt, session, and member identifiers. Reuse
also requires the same run revision, assigned role, working directory, reviewer
profile, inspected workspace evidence, and owner authority (pinned policy plus
the owner's steering and answers); a later owner answer makes every earlier
verdict a miss, and an owner answer retires every outstanding delegated
decision so it is reviewed again under the new direction or stays with the
owner. A recorded approval is still rechecked against the current target
session, including that owner authority, and delivered once. A recorded reviewer escalation remains with the
owner. Reuse does not extend the run's decision limit or apply to host-side
escalations.

Permission recovery runs before owner escalation. A recognized collapsed Codex
command may receive a guarded display-only Ctrl+A; this never accepts the
command. Other incomplete permission dialogs go to the strong coordinator for diagnosis,
with approval disabled until the ordinary one-shot checks qualify. Recovery
retains its request identity, attempts, decisions, receipts and observed
consequences in the sealed run record. An uncertain expansion is not replayed.

PM and mission coordinators receive bounded recovery outcomes so they can make
an in-scope correction through the existing team controls. Later reviews can
consult relevant outcomes from the same project. These observations are
advisory: they cannot grant permission, weaken checks or replace fresh source
inspection. A delivered answer or expanded dialog does not prove the requested
command succeeded; execution remains unknown until separate execution evidence
establishes it.

A request qualifies when its evidence is complete: hook tool input that storage
did not truncate, or a Codex "Would you like to run the following command?"
dialog that shows its whole `$` command. Codex hooks are off by default, so
Codex members reach the coordinator through the dialog. The review also gets the
files the member changed against its base, accepted checks, and bounded complete
command-source files with hashes and explicit collection gaps. The host
rechecks this snapshot before answering. New members receive a host-assigned
external scratch directory for temporary scripts and check outputs; source
collection reads only that assigned scratch root, never arbitrary temporary
paths. A reviewer uses the objective and its
review assignment; having no individual implementation task is normal. Delivery
requests also carry the separate pinned policy, reviewed head and branch, and
passing-check evidence. The host verifies the actual delivery workspace is clean
and still at the reviewed commit before review and before answering. Git pushes
use that literal commit SHA and explicit destination; ordinary workers cannot publish. See
[security](security.md#delegated-team-permission-decisions) for the rule. Once a
request qualifies, the host either starts the review or records an escalation
with its reason, so clients show the prompt as the coordinator's only while it
can act. Codex members prefer operations that work inside their sandbox and
request one-time execution when a necessary scoped development command needs
network, listeners, IPC, or Git metadata access. The host runs the accepted checks
after integration. An obsolete report-only reviewer cannot approve a later
prompt or block another review merely because its shutdown is unavailable.

Workspace trust, persistent allow rules, ambiguous prompts and unsupported native
requests are never delegated; trust prompts disappear only when the owner trusts
the team roots. A coordinator that itself needs permission
cannot approve its own prompt. Each decision is bounded; stale or uncertain
answers are never replayed automatically. Run status and Linear retain the
receipt separately from successful tool execution.

```sh
infinite team revoke-permissions TEAM_ID
infinite repo init --permissions off
```

The first command revokes delegation for a current run, on either path. The
second disables the coordinator review for future runs and records an opt-out
from the permission agent for that project. Both require an owner client. Pausing, cancelling or steering a
run prevents its old pending decisions from being applied.

## Autonomy mode

Each project has an autonomy mode. The mode is `supervised` or `autonomous`.

Standing objectives read the mode: only an autonomous project can run one, and a standing goal pauses at a cycle boundary when its project becomes supervised. Nothing else reads the mode yet.

Each new run and each new goal records the project's mode when it starts. A goal's cycles keep the goal's mode. A change applies to the next run and the next goal. A run or a goal already in progress keeps its mode. An autonomous project whose lineup has no eligible evaluator starts new runs and goals `supervised`, and the intent check follows the pinned mode; see [Intent check](#intent-check).

An enrolled repository without a saved mode uses the host default. The default is `autonomous` unless the operator sets `autonomy.defaultMode` in the host configuration file. A project that is not enrolled reads as `supervised`.

Read the mode:

```sh
infinite autonomy mode PROJECT
```

Change it:

```sh
infinite autonomy mode PROJECT supervised
infinite autonomy mode PROJECT autonomous
```

Set it when enrolling:

```sh
infinite repo init --autonomy supervised
```

Omit `--autonomy` on a later `repo init` to keep the saved mode.

Only the owner can change the mode, from the paired owner CLI. Members, other roles, and browser sessions cannot.

## Shadow routing

Shadow routing records which profile the router would pick for each implementer start. It never applies that pick: the member runs on the profile the plan names, and the run is never refused, blocked, or failed by the router or the evidence store.

### Settings

```sh
infinite repo init --routing shadow --routing-value quality --routing-contributor allow
infinite repo init --routing off
```

- `--routing off|shadow|auto` sets the mode. `auto` is described in [Auto routing](#auto-routing).
- `--routing-value` is the dollar value of one success: `cost` (0.5), `balanced` (2), `quality` (8), or a number from 0 to 100.
- `--routing-contributor allow|deny` sets whether contributor profiles may be candidates. The default is deny.
- A rerun without these options keeps the saved policy unchanged. Each option you give merges over the saved policy. The routing policy is part of the routine approval digest, so a change blocks the project's active routines until the owner approves them again.

With no saved mode, the default follows the project's autonomy mode: a `supervised` project is `off`, and an `autonomous` project is `shadow` until its shadow period ends, then `auto`. Setting `--routing shadow` turns shadow on in a supervised project too. Knobs you do not set show as defaults in `routing status`.

### What a decision row holds

One row per task and revision, written at the task's first implementer start, with nothing recorded for a replacement. A run pinned at algorithm version 2 that lists the escalation or scout point also writes one row per escalated task and revision (point `escalation`, role `implementer`) and one per scout (point `scout`, role `scout`). A scout's row has no posterior, and its payload's `current` list is empty. An escalation row has the same fields as a start row, and its payload has no guards. A row holds the run, revision, task key, point, role, area, kind, risk, feature map reference, mode `shadow`, the algorithm and reward versions, the policy digest, the seed, the basis, the chosen and greedy profiles, the coordinator's pick when there is one, the exploration flag, and the decision time. The project, the task ID (a scout's ID for a scout row), the area, and the feature map name are stored only as blind indexes (`project_ref` among them); the sealed payload holds the clear values and each candidate's posterior, cost, and utility, at most 32 KiB. A shadow row has no member ID.

Nothing about the routing reaches a member: no prompt, context file, or tool carries the policy, a seed, a posterior, or a utility. A shadow run writes no line to the run's events.

A run's team view shows the policy the run pinned: the mode, the requested mode, the source, the knobs and which are defaults, the algorithm and reward versions, and the digest. The relay carries team views, and a handoff run's view also shows the project's saved policy. A team view also shows each task's and each scout's `routing` (the profile the host chose, and whether the router or its fallback chose it) and each member's `hostProfiles` flag. No view shows a seed, a posterior, or a utility. Status and explain are not served over the relay.

### Status and explain

```sh
infinite routing status PROJECT [--json]
infinite routing explain RUN_ID TASK_ID [--json]
```

`status` shows the mode and its source, the value and the contributor setting, whether start is covered, how often the router matched the coordinator over the last 30 days, the shadow period (it ends after 14 days and 50 decisions, whichever is later), and each profile's posterior at each recorded area and at the new-task line. Intervals are 90% normal approximations. A count of zero is shown as "no decision had a coordinator pick", never as a rate. A cost that is a tier default is labelled as one. `explain` lists one task's start decisions, with the candidates each one considered.

With owner criteria on (`project.team.objective.prompts: "on"`), status reads the evidence as the start of a goal cycle with a pinned record digest would, with the digest in the prompt version. In such a project, the rows of a standalone run, and of a goal cycle whose digest was skipped, count as earlier evidence. A recorded decision keeps the prompt version its own start used.

Status reads at most the newest 500 decisions of the last 30 days and shows at most 50 cells that have a decision in those 30 days. A cell's evidence still counts for 180 days, and a cell with no decision in the last 30 days is not shown. Earlier mass is evidence from an earlier configuration or prompt version; it counts at most 10 per level. When the applied and the raw earlier mass differ, a profile's line reads `earlier mass A of R applied`, where A is the applied mass and R the raw one.

### Retention

The host removes decisions decided more than 180 days ago. A decision holds no run text, so it outlives the run record until that sweep.

### Rolling back

Before rolling back past this release, remove `routing` from every project's team block. This release provides no command that removes the key, so this step is still open. A rollback also leaves the outcome ledger unavailable until a host of this release or later runs again, because an older host cannot read its version 4.

## Auto routing

In `auto`, the router chooses each task's implementer profile when the task first starts in a plan revision. A saved `auto` starts a new run on the router's choice once the project's shadow period has ended. Until then, the run is pinned `shadow` and nothing changes.

### Turning it on

```sh
infinite repo init --routing auto
infinite routing status PROJECT
```

- `--routing auto` keeps the saved policy's other settings and replaces only the mode. The command refuses on a host that does not report `routingAuto`, and prints the shadow-period note after it saves.
- A project with no saved mode and an `autonomous` autonomy mode gets this behaviour by default (`modeSource: autonomous-default`). A saved `mode` always wins: `--routing shadow` keeps an autonomous project in shadow, and `--routing off` turns routing off.
- A `supervised` project without a saved mode stays `off`.

### The shadow period

The period ends at the later of two points: 14 days after the project's first recorded start decision, and the 50th recorded start decision. Both count recorded rows, including rows recorded before `auto` was saved. The end is stored the first time a run is created after it has passed, and it never moves afterwards. Until the end is stored, a saved `auto` pins `shadow`.

`infinite routing status PROJECT` shows the progress and the mode with its source. The mode reads `auto` when a new run would pin `auto`.

### What the coordinator and the members see

In an `auto` run, the coordinator's plan may omit `agentProfileId` on its tasks, and the coordinator is told that the host assigns each task's worker profile. A plan that sends one still passes the existing checks. No member prompt, context file, or tool carries a task's routing, the policy digest, a decision key, or a score.

### Fixed rules

An `auto` run applies these rules to its profiles:

1. A contributor profile is used only when the policy sets `allowContributor`. This holds for implementers, scouts, escalations, and their limit fallbacks. The coordinator, integrator, and reviewer slots and their limit fallbacks are the owner's lineup choices, and the router does not check them.
2. A profile on the reviewer's model is never used for an implementer's start, or for an implementer's limit fallback, escalated or not. A profile the host chooses for an escalation or a scout is checked against this rule; a profile a member names is not.
3. A profile outside the owner's lineup is never used.

When the router cannot choose a profile at a start, the task starts on the coordinator's profile if it passes rules 1 and 2, and otherwise on the first implementer in lineup order that passes them. The run's events then hold one line for that task and revision: `Host routing could not choose a profile for task ID; it is assigned LABEL.` A provider-limit fallback passes over a profile that fails its member's rules: rules 1 and 2 for an implementer, escalated or not, rules 1 and 2 for a scout of a run that covers `scout`, and rule 1 for any other scout. A saved `auto` whose lineup has no implementer that passes rules 1 and 2 is refused with 409 `routing-no-eligible-profile` when a run is created. The autonomous default never refuses a run: it stays in shadow and logs once per host process that no implementer profile passes the rules.

### Exploration guards

A start explores (picks a profile other than the greedy one) only when all of these hold:

- exploration is not paused for the project;
- the run has at least `minSpareAttempts` spare attempts (default 4);
- the share of exploratory starts over the project's last `exploreWindow` starts, counting pending and applied rows, stays within `maxExploreShare` (default 0.2) with the new start included;
- the task's risk is not `elevated`.

Pending rows that are not released within 7 days are released. Headroom is not applied.

```sh
infinite routing pause-explore PROJECT
infinite routing resume-explore PROJECT
```

Pausing changes only the routing state in the evidence store, not the saved configuration.

### Revoking routing for a run

```sh
infinite team revoke-routing TEAM_ID [--request-id UUID] [--json]
```

The command reads the run's current revision and stops host routing for the run's new tasks. Each starts on the coordinator's pick when it passes the fixed rules, else on the first implementer in lineup order that passes them; no run line is written per task. It is refused with 409 `routing-not-enabled` for a run that was not pinned `auto`, and it is owner-only.

### Escalations and scouts

Two more points can route under `auto`: `escalation`, the profile of an implementer that escalates, and `scout`, the profile of each scout. The owner lists them with `--routing-points`:

```sh
infinite repo init --routing auto --routing-points start,escalation,scout
infinite repo init --routing-points start
```

- `--routing-points LIST` sets the points the router covers. `LIST` is a comma-separated set of `start`, `escalation`, and `scout`. It must include `start`; a list without it is refused before any request. A rerun without the option keeps the saved points.
- The points are part of the routing policy. A change blocks the project's active routines until the owner approves them again.
- A run pinned with `escalation` or `scout` in its points is pinned at algorithm version 2. A run pinned at version 1 routes only `start`, whatever its points list.
- In `shadow`, a point that a version-2 pin lists records rows and applies nothing, as `start` does.

**Coverage.** A point is covered when the run is pinned `auto` at version 2, lists the point, and has a candidate that passes the fixed rules.

- `escalation`: a profile in `lineup.escalations` other than the escalated member's own profile. Coverage is per member: when the member's own profile is the only candidate, that member is not covered.
- `scout`: an implementer whose tier is not `strong`. A profile without a tier counts as light.

An uncovered point keeps today's path. The member names a profile from the pool, and the host checks it as it does in every other run.

**What the members are told.** In a covered run that is not revoked:

- The coordinator is told that the host assigns each scout's profile, and its explore example omits `agentProfileId`.
- An implementer is told that the host selects the stronger profile, and its escalate report is `{"kind":"escalate","reason":…}` with no profile.

Otherwise the text is today's, and names the pool. No member is told a candidate, a score, the policy digest, or a decision key. A scout's inline assignment has no `routing` field, and no context file or permission review prompt carries `routing` or `hostProfiles`. After a revoke, the prompts return to today's text, but a member of a covered run still holds `hostProfiles`, including a member created after the revoke. A report from it without a profile is still accepted and takes the fallback.

**What the router picks.** Neither point draws a sample or reads an exploration guard.

- An escalation takes the candidate with the highest greedy utility. An elevated-risk task uses the mean minus one posterior deviation, as the design's Part 5 says. The basis is `greedy-point`. It is `single-candidate` when one candidate is left, and `default-all-limited` when every candidate is limited, which takes the first candidate.
- A scout takes the candidate with the lowest tier cost, and ties go to lineup order. A limited candidate is passed over unless every candidate is limited. The basis is `greedy-point`, `single-candidate`, or `default-all-limited`. A scout candidate is never `strong`, so every candidate has the light cost, and in practice the first candidate in lineup order that is not limited is chosen.

A router pick and a fallback pick pass rules 1 and 2, and are never the escalated member's own profile. In a covered run that is not revoked, a profile a member names does not choose, but it must still be in its pool and pass rule 1. Otherwise the run blocks when the host takes the report, with `invalid-escalation` for an escalation or `invalid-agent-profile` for a scout batch, as an out-of-pool name does today. The router's pick replaces a named profile that passes. When the router cannot choose, the named profile is the fallback if it is a candidate: it passes rules 1 and 2 and, for a scout, is not `strong`. In an uncovered or revoked run, a named profile is used as before and keeps rule 1 only. When the chosen profile's provider is limited at launch, the member starts on that profile's limit fallback, as every launch does. That fallback passes rules 1 and 2 but can be the escalated member's own profile, and the decision row is then released.

**When the decision is written.** An escalation is decided when the host accepts the escalate report, before the path-scope check. A scout is decided before its member is created. Each decision writes one `pending` row, or reuses the row already stored for its key, and the row becomes `applied` when the member starts on that profile. Otherwise it becomes `released`. A `pending` row at these points is not released after 7 days. The run's settle, advance, or delete releases it.

**When the router cannot choose.** The store is unavailable, a decision takes more than 250 ms, its payload is over 32 KiB, a write fails, or an error is thrown. The member then gets the fallback profile and no row is written. The fallback for an escalation is the member's named profile when it passes rules 1 and 2, else the first escalation candidate. The fallback for a scout is the coordinator's named profile when it is a candidate, else the first scout candidate. The run's events then hold one line for the escalation or scout:

- `Host routing could not choose an escalation profile for task TASK_ID; it is assigned LABEL.`
- `Host routing could not choose a profile for scout SCOUT_ID; it is assigned LABEL.`

The host logs one line for each reason, once per host process. The run continues.

**Revoking.** `infinite team revoke-routing TEAM_ID` stops the router at these points too. A revoked run writes no row. An escalation or a scout with no profile named takes the fallback, with no run line. A named one follows today's path. A member that was already told that the host selects therefore still gets a profile.

**Reading the decisions.** `infinite routing explain RUN_ID SCOUT_ID` shows a scout's decision. `infinite routing explain RUN_ID TASK_ID` shows a task's start and escalation decisions. Both list the decisions at every point. The command's usage line still calls the second argument `TASK_ID`; a scout ID works in its place. `infinite routing status` counts `start` decisions only.

### Status lines

`infinite routing status` prints one line per project:

- `ID · routing auto (saved)` or `ID · routing auto (autonomous default)` when a new run would pin `auto`;
- `ID · routing shadow (saved) · requested auto: auto starts after the shadow period` when `auto` is saved, an implementer passes the fixed rules, and the period has not ended; without such an implementer, `ID · routing shadow (saved) · requested auto`, and new runs are refused;
- `ID · routing shadow (autonomous default) · auto starts after the shadow period` during the autonomous default's period, while an implementer passes the fixed rules;
- `Shadow period: ended TIME. Auto routing needs --routing auto.` when the period has ended and `--routing shadow` is saved.

### Rolling back

To stop new runs from choosing profiles without a release rollback, run `infinite repo init --routing shadow`, and revoke host routing on any active run with `infinite team revoke-routing TEAM_ID`. Before a release rollback past this slice, let every run pinned `auto` settle, or cancel it: a host without this slice requires `agentProfileId` on every plan task, and an `auto` plan omits it, so that host refuses the run's next member start with `invalid-agent-profile`. The rollback note under Shadow routing still applies to a release rollback.

For the escalation and scout points, before a release rollback past this release, run `infinite repo init --routing-points start` on every project that lists `escalation` or `scout`, and let every run whose pin has `algorithmVersion: 2` settle, or cancel it. An unsettled version-2 run that a host from before this release picks up can block: a stored scout without `agentProfileId` stops at launch with 409 `invalid-agent-profile`, and an `escalate` report without one does not parse, so the member's exit blocks the run with `missing-agent-report`. That host also cannot replay the launch of a member that holds `hostProfiles`: the launch fingerprint covers the assignment, so the replay fails with "Request ID already belongs to a different session".

## Launch-rate fuse

The host limits how often it starts team sessions: 30 per project and 80 across the host in a rolling hour. A launch that would pass a limit waits. The member or goal shows a reason that starts "Waiting for the spend fuse:", names the project or the host, and gives no figures. The first trip of a UTC day closes by itself when fewer than half the limit remain in the last hour. If the limit is reached again on the same UTC day, the trip stays open until the owner closes it with `infinite fuse close --project PROJECT_ID` or `infinite fuse close --host`. The permission coordinator is never counted or held. The limits can be changed under `autonomy.fuse` in the host configuration (`project`, `host`, and `projects.PROJECT_ID`, each with `launchesPerHour`). A trip opened because the launch record cannot be read closes once the record can be read. Run `infinite fuse` to read every scope, or add `--json` for the full view. The `autonomy-interrupt` push event is on by default and sends the owner one notification per trip and subject per UTC day.

## Project signals

A project signal is a fact the host recorded about a project, or an item the
owner added. Each project has an inbox of signals, oldest first. There are four
kinds:

- `delivery-landed`: the base branch scan saw a team run's delivered change on
  the base branch. The signal names the run and the landed commit.
- `revert`: the base branch scan saw a revert of a landed run's change. The
  signal names the reverted run and the revert commit.
- `external-commit`: a fetch moved the base branch, and at least one new commit
  is neither a landing nor a revert that the scan attributed to a team run of
  the project. The signal names the new base head. The host records it only
  when the scan read exactly the new commits, so never on a project's first
  scan or after a rewritten history. A run can land as several commits, and
  the scan names only the last one, so a commit before a landing in the same
  fetch may belong to that run and does not count. The one exception is a
  landing by a merge commit whose second parent is the run's reviewed head: the
  run's commits sit behind that parent, so a commit before it counts.
- `owner`: direction the owner added with `infinite signal add`.

Only the owner can add a signal, and only owner signals carry text. The host
never copies text from a commit, a pull request, an issue, or an agent into a
signal. Scan signals hold commit and run IDs only.

A signal starts nothing by itself. A [routine](#scheduled-routines) or a
[standing goal](#wake-on-signals) with `wakeOn` reads the inbox on its own
scheduler pass and decides within its own limits.

The host keeps signals for 30 days, and at most 20,000 across all projects. The
oldest go first. A reader whose place is older than the oldest kept signal
continues from that signal. Signals live in the evidence store. While the
store is unavailable, nothing is recorded and readers wait.

Each signal has a key from its source: a request ID, a ledger ID, or a commit.
The host records one key once per project and kind, and remembers the key for
the full 30 days, also after the 20,000 limit removed the signal itself. A
repeat within 30 days records nothing. After 30 days the same key is a new
signal, so a source uses a key once. The host remembers at most 200,000 keys.
At that number it refuses new signals until old keys expire; it never forgets
a key early to make room.

```sh
infinite signal add --project PROJECT_ID "Check the release notes before the next run"
infinite signal list --project PROJECT_ID [--after SEQ] [--json]
```

## Halt

The owner can stop autonomous work on the whole host or in one project, and it stays stopped until the owner releases it. `infinite halt on --host` or `infinite halt on --project PROJECT_ID [--reason TEXT]` engages a halt from any owner client, and the phone can send the same request through the API. From that moment no new team, goal, mission, or routine session starts in scope. Every scheduler and the session manager's backstop ask the halt before the launch-rate fuse, so a held launch is not counted by the fuse, is not a failed attempt, and is not a missed coordinator report. No role is exempt, including the permission coordinator that the fuse lets through. The session manager checks the halt once more right before it writes the session record, after every wait, and over every project the work covers; a mission coordinator covers all of the mission's repositories. When the halt refuses a launch there that a scheduler had already admitted, the fuse gives that admission back: the launch is not counted, and a trip that only it opened is removed. An admission made before a host restart is settled by the fuse as usual and keeps its count. A held item shows "Halted by the owner for the whole host." or "Halted by the owner for this project."

Engaging also pauses the running work in scope through each item's own pause path: routines first, so they start nothing, then goals, missions, and the team runs that no goal or mission owns. A goal or mission pauses its own runs. A goal is in scope while it runs and while its run waits for input. A mission is in scope when any of its repositories is the halted project, including while it waits for the owner's answer, and it pauses only the subteams that are working or waiting for input when the pause reaches them; each subteam decides that in its own queue. A team run that waits for input, whether it stands alone, belongs to a goal, or is a subteam, is paused where it waits when nothing else in it is in flight: it keeps its revision and its open questions, and an answer given during the halt is recorded but starts nothing until the run resumes. A member that is queued but not yet launched is not at work, so it does not prevent this: it stays queued and launches after the release. That covers the replacement that an answer queues while the run still waits, which then starts with the answer. A run that waits while one of its members still works is paused like a working run, and its release gives it a fresh plan: a question still open in the stopped revision is no longer current, and the owner's answers carry into the new plan. A goal's run or a subteam the halt paused carries the halt's mark from its first saved paused state, and any accepted owner action on it except an answer clears the mark. On release the mission resumes a subteam only if it is still paused and still carries that mark, so an owner action after the pause reached the subteam always wins. While the halt is engaged, a halt pause that has not reached a subteam yet, or that the mission repeats after a restart, still pauses the subteam if it is working or waiting for input when the pause arrives, even if the owner paused and resumed it in the meantime; the subteam then resumes on release. The release withdraws every halt pause that has not been delivered. If the mission stays paused, each of those subteams gets the mission's ordinary pause instead, the one the owner's pause of a mission sends: it carries no halt mark and resumes with the mission. Items the owner paused, blocked items, and ended items are not touched. A mission that waits for the owner's answer keeps its questions while paused. The owner can answer one during the halt: the answer is recorded, a forwarded answer reaches the subteam that the halt holds, and nothing starts until the release, which resumes the mission with the answer applied; the mission waits again while another question is open. Sessions the owner started directly keep running. Each item the halt paused is marked with that halt. An item that could not be paused is listed in the response, and the halt stays engaged.

`infinite halt off --host` or `--project PROJECT_ID` releases it. The gate lifts first. Then each marked item that is still paused, and that the owner did not change during the halt, resumes in reverse order under the same rules as the owner's resume. A team run resumes with a fresh plan, except a run the halt paused where it waited for input: that run continues its revision, its open questions are still there, and an answer given during the halt starts the requesting member's next attempt. An item that those rules refuse stays paused and says why, for example a team whose members are still stopping, a team that needs workspace reconciliation, a goal or mission past its deadline, or a standing goal whose project is no longer autonomous. A standing goal has no deadline of its own, so a halt that outlasts its last cycle's time window does not end it: on release it returns to its cadence. A mission whose time limit passed during the halt is blocked at its time limit and stays blocked; extend it to continue (see [missions](missions.md)). Resume it when it is ready. A host halt and a project halt are independent: an item resumes only when no remaining halt covers it, and otherwise it moves to the remaining halt. `--keep-paused` lifts the gate and resumes nothing; each marked item, and each run that a marked goal or mission paused, then says that the owner kept it paused. A run paused where it waited stays that way, so it still takes an answer, and the owner's later resume continues where it waited. Whenever a release leaves a goal or mission paused, the runs it paused show the goal's or mission's new reason instead of the halt's.

Engage and release are idempotent by request ID. Engaging a scope that is already halted, or releasing one that is not, changes nothing and returns the current state. The halt is recorded in `halt.sealed` in the host state directory with its time, reason, and the owner device that engaged it. A restart keeps it, and a restart in the middle of a pause or resume pass finishes that pass without repeating what was done. If the host cannot read the record, it treats the whole host as halted and refuses every change to the halt until the record can be read; it checks again every minute. Once the record can be read again, any pause or resume pass it holds as unfinished runs before the next change to the halt. When the record cannot be restored, removing that file on the host clears every halt at the next check; nothing resumes, so resume each paused item yourself. A second file, `halt-epochs.sealed`, holds the halt epochs that the permission agent reads: every engage and release renews the epoch of its scope, so a verdict reached before a halt or its release is never delivered after it. Restoring or removing `halt.sealed` leaves it as it is. Do not restore it from a copy; removing it makes the permission agent retire every verdict not yet delivered. A halt never infers completion and approves nothing. `infinite halt` lists every halted scope; add `--json` for the full view.

## Configuration

Each new run gets a folder named from its UTC creation date, a slug of its
title, and the first eight characters of its ID, such as
`2026-01-15-add-export-3f2a9c1d/`, holding the `integration/` checkout and the
`members/` copies. Its branch is `infinite/team-<slug>-<id8>`. The run ID remains its
identity in the API, receipts, and Linear. Runs go under
`teams.workspaceDir/<project-id>-<YYYY-MM-DD>-<slug>-<id8>/` unless the project has a teamwork folder, in which case it is `<teamworkDir>/<YYYY-MM-DD>-<slug>-<id8>/`.

A teamwork folder keeps a product's runs beside its code under the server home.
For a mirrored `Projects/sample/codebase`, run `infinite repo init --teamwork
../teamwork` in that checkout; runs then go to `Projects/sample/teamwork/` on the
host, next to `Projects/sample/codebase/`. The local path is resolved from the
current directory, must be below the local home and outside the repository, and
is stored as its home-relative path. The host refuses a folder equal to its sync
home, reached through a symbolic link, or overlapping any project, the team
workspace root, or host state and credential paths, and checks again when each
run is prepared. `--teamwork none` returns new runs to the default root.
Existing runs keep the folder and branch they were created with.

The host owns every directory component from the sync home through the teamwork
root. Each component below the sync home must be a real directory, owned by the
host account or root, and not writable by group or others. Host-created teamwork
and default workspace roots use mode `0750`, preserving inherited setgid. Run
directories sit directly in these protected roots; run and member directories
use mode `2770`, set through no-follow directory descriptors before the agent
identity receives access. The default root is checked during preparation and
whenever a run path is used, including for legacy records. Unsafe legacy roots
leave their records preserved but prevent preparation, launch, and bundling.
Stored roots outside `teams.workspaceDir` require a trusted teamwork anchor.
Directories above each root must be owned by root or the API account and not writable by other accounts unless sticky.

`repo init` uses pnpm install and pnpm run commands for repositories with a
`pnpm-lock.yaml` or a `packageManager` field naming pnpm; npm remains the default
for npm repositories.

Enable teams in the private host configuration and define the project's
verification commands. Commands use executable/argument arrays, without an
implicit shell. This example is for a project with a suitable `npm run check`
script; use that project's actual verification entry point.

```json
{
  "teams": {
    "workspaceDir": "/srv/infinite-data/team-workspaces"
  },
  "projects": [{
    "id": "example",
    "name": "Example project",
    "path": "/srv/infinite-data/projects/example",
    "team": {
      "setup": { "command": "npm", "args": ["ci", "--no-audit", "--no-fund"] },
      "checks": [{ "command": "npm", "args": ["run", "check"] }]
    }
  }]
}
```

The source must be a clean Git repository root with a commit. Teams pin that
commit and make independent clones without hardlinks or shared object storage.
Ignored files and uncommitted changes are not copied. Setup must provision the
dependencies each isolated copy needs. The source checkout remains unchanged.
The run shows its branch, base, integrated commit and workspace for inspection.

If the API and provider use different Unix identities, provision the workspace
root owned by the API account with the intended shared group and setgid/default
ACL inheritance. The root itself must not be group- or other-writable (for
example, mode `2750`); existing deployments with a group-writable root must
remove group write before teams can run. Configure `teams.commandPrefix` so **all** Git, setup and check
commands execute as the provider's unprivileged identity. For example, a
root-owned, constrained launcher can run commands under that account. The prefix
is an executable/argument array like the other commands. Do not run
agent-controlled repository scripts or Git filters as the privileged API
account. A sudo provider profile without a command prefix is refused.

A constrained launcher must allow what the host runs through the prefix:
Git clones, checkouts and integration inside each run directory under the team
workspace root and every enrolled teamwork folder, branches named
`infinite/team-*`, and, for `infinite team pull`, `git rev-parse --verify
refs/heads/<branch>` and `git bundle create - refs/heads/<branch>` in a run's
`integration/` checkout. Enrollment also runs `git rev-parse` and `git status`
in the project source. So that a new project needs no launcher edit, a launcher
can allow those read-only checks anywhere below the sync home and recognize a
teamwork run by its directory: the API account creates each one, named
`DATE-SLUG-REQUEST8`, before any Git command runs in it, and the provider
account cannot create a directory with that owner.

Verification and Resume also use `verification/ID` and `recovery/ID` beneath
that same host-owned run directory. Moved-base recovery clones the configured
source into a fresh safe sibling with
`clone --no-local --no-hardlinks --no-checkout -- MIRROR_PATH DESTINATION`,
run from the team's recovery directory, then runs `remote remove origin`,
`cat-file -t BASE`,
`check-ref-format --branch BRANCH`, `checkout -B BRANCH BASE`, and
`status --porcelain=v1 -z --untracked-files=all` only inside that clone. Only
the pinned base fetch, `rev-parse`, and the five base scan forms listed below run
in the source mirror. Verification
copies use `checkout --detach COMMIT` in their destination. Recovery uses
`checkout -B BRANCH COMMIT` only in its fresh recovery clone. Read-only inspection uses
`status --porcelain=v1 -z --untracked-files=all` in both team and project
copies. Preserve the launcher's existing path, identity, branch, and commit
restrictions when allowing these forms; verify them under the deployed Unix
identities before activating a host update.

GitHub-tracked sources add these operations. The host runs each through
`teams.commandPrefix`, and a launcher that refuses one fails that refresh step:

- in a host mirror: `init --bare` when the mirror is created, `fetch --no-tags` of
  the base branch from the GitHub URL into `refs/heads/BASE`, and `rev-parse` of
  that ref before and after the fetch. The read before the fetch finds a head
  that an earlier fetch left without a record, and the host notes it first;
- in a host mirror, after each successful fetch: the base scan forms in the
  table below;
- in a project source directory: `rev-parse --show-toplevel` (the refresh
  refuses a directory that is not the repository root), `fetch --no-tags` of the
  base branch from the mirror path into `refs/remotes/origin/BASE`,
  `rev-parse HEAD`, `merge-base --is-ancestor`,
  `status --porcelain --untracked-files=no`, `checkout --detach` to the new head,
  and, to save tracked edits, `checkout -b infinite/saved-*`,
  `diff --cached --quiet`, `add -u`, and `commit -m` with one of two fixed
  messages (staged edits are committed first, then remaining working-tree edits);
- in a team run: `clone --no-local --no-hardlinks --no-checkout -- MIRROR_PATH`
  into the run directory in place of a project-directory clone, `cat-file -t`
  on the base commit, and, for a continuation, `fetch --no-tags -- MIRROR_PATH SHA`
  of the current mirror head into the parent run's integration checkout so the
  host can tell whether that run is behind the base.
- in a team run's integration checkout: `push` of the exact commit SHA to
  `refs/heads/RUN_BRANCH` on the GitHub URL, with no force, delete or implicit
  refspec. See [Head publication](#head-publication).

The host reads the base branch in the source mirror after each successful fetch.
It records which approved runs landed on the base and which landings were
reverted. These five forms run through `teams.commandPrefix` in the host mirror,
never in a team workspace, with a 30 second limit. Every commit id is checked as
a 40 or 64 character lower-case hex id before use.

| # | Form | Output |
|---|---|---|
| 1 | `merge-base --is-ancestor OLD NEW` | Exit status only |
| 2 | `rev-list --first-parent --max-count=501 NEW ^OLD` | At most 501 ids, 33 KiB |
| 3 | `rev-list --first-parent --max-count=500 NEW` | At most 500 ids, 33 KiB |
| 4 | `log --no-walk=unsorted --no-show-signature --format=%H %T %P ID...` (1 to 50 ids) | One line per id |
| 5 | `log --no-walk=unsorted --no-show-signature --format=%H --fixed-strings --grep=This reverts commit ID... ID...` (1 to 50 patterns, then 1 to 50 ids) | At most 50 ids |

One scan runs at most 600 Git commands. A scan that needs more fails, writes
nothing, and is tried again after the next fetch. Each form follows the six
settings that the host puts before every Git command, and nothing else; the
launcher should admit a form only in that shape.

The production launcher must admit all five forms. Until it does, every scan
fails: no landing is recorded, and held stays unknown.

`teams.publishHeads` (boolean, default `true`) controls head publication. Set it
to `false` to disable it.

Nothing new is needed for `--delivery pr`. The delivery member pushes from its
member clone with its own tools, as it does for `merge`.

The Ubuntu launcher must preserve `INFINITE_HOOK_URL`, `INFINITE_HOOK_TOKEN`,
`INFINITE_TEAM_ASSIGNMENT` and `INFINITE_TRUSTED_WORKSPACE`; the supplied sudoers
template includes them. These are a member's scoped report capability,
assignment and trusted folder, not owner API keys. Verify executable access,
workspace permissions, report delivery and configured checks under the actual
deployment identities before using a production host.

### Workspace trust

Claude Code and Codex ask whether to trust each new folder. They key that trust
by the folder's own Git root, and every member is a separate clone, so trusting
a parent folder never covers a member. To trust the team roots once, set:

```json
{ "teams": { "workspaceDir": "/srv/infinite-data/team-workspaces", "trustWorkspaces": true } }
```

Every member launched afterwards, in `teams.workspaceDir` or an enrolled
teamwork folder, starts trusted in its own folder. The host records the
decision with the member session, so restarts keep it. Codex receives a
per-launch `projects` override and nothing is written to its configuration.
Claude Code reads trust only from its account's global config (`.claude.json`, or
a legacy `.claude/.config.json` it still prefers), so each member folder gains a
`hasTrustDialogAccepted` entry there. The entry is written under Claude's own
`<file>.lock` lock, so a running Claude session and the host never overwrite
each other's update; a lock held past five seconds leaves the prompt instead.
The worker writes it when
Claude runs in the host's own account. For a sudo profile, the agent wrapper
writes it in the agent account, for the current folder only, from
`INFINITE_TRUSTED_WORKSPACE`. A wrapper or sudoers file without that support
leaves the prompt for the owner. The setting is off by default. Turning it off
affects members launched afterwards; existing Claude entries stay until removed.

Claude team launches (members, mission coordinators and permission
coordinators) load no project or local settings file and start no server from
a project `.mcp.json`. They pass
`--setting-sources user`, which keeps the agent account's own settings, or
`--setting-sources ""` when the
[headless permission channel](security.md#headless-permission-channel) serves
them. The host's `--settings` layer and the machine's managed settings load
either way. A Codex member can commit `.claude/settings.json` or `.mcp.json`.
Without this flag Claude Code runs their hooks and MCP server commands in any
folder and applies their allow rules in a trusted one, so a later Claude
member would load what an earlier member wrote. A repository's own
`.claude/settings.json` and `.mcp.json` therefore never apply in a team run;
`CLAUDE.md` instructions still load. A profile
that sets `--setting-sources` cannot launch a Claude team role.

Trust still lets Codex apply a project Codex configuration in member folders.
Team members can edit that file, and later Codex members load the integrated
result. Review it like the rest of a run's changes. Tool permission prompts,
delegation limits and the root ownership rules above are unchanged; sessions
outside team runs never receive this trust.

## Team questions and steering

A member can explicitly ask a question with suggested options. Eligible worker
questions first reach the project manager through bounded recovery, with the
original question retained. The manager resolves routine task dependencies and
ownership, or asks the owner for a material decision. Project-manager and
delivery questions retain the direct decision path: an owner or controller
answers from the team page, and a new assignment receives the recorded answer.
Provider tool permission dialogs use their separate permission policy.

For a standalone team, steering records a new requirements revision. Earlier
member results cannot satisfy it. The scheduler stops old assignments and replans from the integrated
workspace with the new direction. Completed earlier integration remains visible;
unfinished member copies remain available under the workspace retention policy.
Pause, resume and cancel are owner
actions. A member with no report and no attention activity for `teams.stallMinutes`
(5–1,440, default 30) is stopped. A reviewer uses the shorter of that setting and
a five-minute quiet window so a silent review can recover before a goal deadline.
One replacement then continues the same task in that workspace, with feedback
that the earlier attempt stalled. A second
stall on the same assignment blocks the team with the reason "An agent showed no
activity twice on the same assignment." Activity means attention activity from the
member's terminal or hooks. Screen output also counts, so an agent stuck behind an
animated spinner looks active. Older runs blocked by the former one-hour limit
still resume. A team blocked only by a stall can resume with
`infinite team resume ID`. That starts a fresh plan from the integration commit;
stopped member copies remain subject to the workspace retention policy.
Resume waits until those members have stopped. A changed verification clone has
the separate guarded Resume path described above; other blocks, including an
interrupted workspace or check operation, still require inspection and a new
team. Stopping an agent does not prove that arbitrary detached tool
descendants have stopped, and a current human input lease can prevent the
scheduler from stopping a member. Such conflicts remain visible.

## Blocked runs

Routine agent blockers go to the team's project manager for diagnosis and a
corrected plan. The host allows at most two automatic recovery attempts per run,
retains the blocker and earlier member evidence, confirms that previous members
have stopped, and verifies the recorded integration commit before replanning.
The run stays in planning while recovery is active, so a goal or mission keeps
supervising it. A mission coordinator resolves remaining dependencies and
ownership issues through its subteam controls.

Settled local result failures can also enter this bounded PM diagnosis when the
host has exact member provenance or a persisted failure marker. The host drains
write-capable members and checks the recorded integration head. If that
workspace is dirty at the same head, it creates a clean sibling and keeps the
original copy available under the workspace retention policy; reports remain in
run history. The PM diagnoses the failure in a new
revision; scope violations and rejected results are not accepted as success.
Legacy blocked result intents are eligible only when their saved blocked state
and failure code prove that the operation had settled. An obsolete
permission-coordinator result with a terminal decision is ignored without
answering or reapplying the permission report; unavailable session records
remain visible.

A project manager may explicitly report `no-change` with evidence when the
request is already satisfied, no implementation tasks have been planned, and
the integration head still equals the original source commit.
The host verifies that the manager and integration workspaces are unchanged.
This ends the team with an agent finding, without declaring a product goal
achieved or user acceptance complete.

Recovery preserves the approved objective, required checks, independent review,
permission decisions, and execution limits. An interrupted operation without
settled-failure evidence remains fenced; it is never replayed after restart.
Recovery does not accept a scope violation, override changed permissions, or
resume an explicitly paused or cancelled run. A hard stop or exhausted recovery
remains blocked and visible to the owner:

* **Phone push.** With push enabled, the host announces new runs, completion,
  cancellation and runs that need the owner. Stuck events are high priority;
  blocked runs say whether they can resume. With `push.detail: "full"`, finished
  and stuck events may include the reason. `team-stuck` controls stuck events;
  `team-blocked` remains an alias. Runs already present when the host starts are
  primed silently, and runs owned by a goal use goal notifications instead.
* **Linear.** The tracked issue gets the reason, the next step and a `Blocked`
  label (see [Linear tracking](#linear-tracking)).
* **App lists.** Web, phone and Mac list blocked runs first, with the reason.
  Team detail offers Continue development when the owner can continue safely;
  Resume remains for the existing supported resume cases.

Existing eligible agent-report blockers can enter the same bounded manager
recovery. `infinite team resume ID` remains available for the supported recovery
cases below; otherwise inspect the retained evidence before choosing the next
action.

An owner can continue a blocked standalone run when its current state is marked
continuable. This is available only when the host can safely start a fresh
revision without a goal, mission, handoff, or uncertain operation or delivery.
No cancellation is needed. Continuation keeps the original team and tracked
issue, integrated work, repository policies, and prior evidence, then starts a
fresh plan. Required checks still apply to the new revision. Add optional
direction with `infinite team continue TEAM_ID [TEXT]`; the direction is trimmed
and limited to 8,000 characters. Use the web or phone form to continue from the
team detail when the host reports this option.

An unconfirmed continuation is never replayed automatically. Inspect the current
team state first. If the host did not record it and you choose to retry, use the
same request ID and the original direction, for example:

```sh
infinite team continue TEAM_ID "Preserve the current checkout design" --request-id REQUEST_UUID
```

The web, phone, and Mac clients keep an unconfirmed request available as
**Retry same request**. Do not cancel the run or create a new continuation to
resolve an uncertain result.

## Reports and recovery

Claude Code and Codex team members receive a scoped MCP report tool
(`mcp__infinite_team__report` in Claude Code and `infinite_team`'s `report` in
Codex); OpenCode and other helper-command providers receive a command that
accepts JSON on standard input. Reports include `plan`, `explore`,
`findings`, `no-change`, `escalate`, `result`, `review`, `question`, and `blocked`;
each role has a permitted subset. The report tool follows the configured provider
profile, except for the dedicated permission coordinator: its constrained launch
allows only its assignment's authenticated report tool. This keeps report JSON
out of Claude's shell-command parsing while preserving worker permission checks.
The detached worker authenticates the report, validates its run,
member and revision binding, and writes it to the encrypted journal before
acknowledging it. A repeated identical report returns the same acceptance;
conflicting reports are refused. Ordinary session hooks cannot grant team
authority.

Reports are agent claims. A clean process exit, an idle terminal, a turn-end
hook, or an English completion message cannot substitute for a report. The host
independently checks file ownership, Git integration and configured command
results. Coordinator, scout, and review copies must remain unchanged. Goal task
ownership and integrator changes must stay within the approved allowed paths.
Integration conflicts and missing reports stop progression; they never silently
become success.

Goal and team state, requirements, answers, outcomes, and receipts use the
existing encrypted store. Detached member sessions survive API loss. After restart, the scheduler
reconciles durable assignment identities instead of launching replacements for
uncertain workers. Interrupted Git/check operations without a persisted settled
failure require reconciliation; they are not blindly replayed. A narrowly
matched obsolete permission-review report can be dispositioned without
applying it. Host reboot recovery is a separate limitation of the underlying
session runtime.

Source copies, Git objects, dependency caches and provider histories are
plaintext at runtime and require encrypted storage. Separate clones isolate
edits; they are not security sandboxes. All roles remain inside the selected
provider and tenant's existing trust boundary. Team workspace cleanup and
artifact retention are explicit operator responsibilities.

## API

The web client and automation share these authenticated APIs. The encrypted
remote transport permits them, with device roles enforced by the host. Every
mutation returns the current Goal or Team record.

### Goals

| Method and endpoint | Body | Role |
| --- | --- | --- |
| `GET /api/goals` | None; returns `{goals}` | Any paired device |
| `GET /api/goals/:id` | None; returns the goal, cycles, limits, and assessments | Any paired device |
| `GET /api/goals/:id/record[?version=N]` | Optional `version` (a positive integer); returns the objective record at that version, with its log | Owner, controller, or viewer |
| `POST /api/goals` | Creation fields below | Owner |
| `POST /api/goals/:id/steer` | `requestId`, `revision`, `text` | Owner/controller |
| `POST /api/goals/:id/pause`, `/resume`, `/cancel` | `requestId`, `revision` | Owner |
| `POST /api/goals/:id/extend` | `requestId`, `revision`, `minutes` (5–1,440) | Owner |
| `POST /api/goals/:id/outcome` | `requestId`, `revision`, `result`, `summary`, `evidence` | Owner/controller |

Creation requires `requestId` (UUID), `projectId`, `title` (up to 100 characters),
`objective` (12,000), and `successCriteria` (4,000). Optional arrays are
`nonGoals` (20 entries, 1,000 characters each), `evidence` (20 entries, 2,000
characters each), and `allowedPaths` (1–32 entries, 300 characters each).
`maxRuns`, `maxMinutes`, `extendMinutes`, `maxTotalMinutes`, and `maxMembers`
use the limits above. Legacy creation requests may include `parallelism`, but
it does not select worker capacity.
Optional `standing` makes the goal a standing objective (see
[Standing objectives](#standing-objectives)):
`{ shape: "objective", cadenceMinutes, wakeOn }`, with `cadenceMinutes`
30–10,080 (default 1,440) and `wakeOn` holding one to four distinct signal
kinds. A standing request must omit `maxRuns`. In a supervised project it
returns `409` with `code: "standing-requires-autonomy"`; an objective over
24,000 bytes returns `400` with `code: "standing-objective-too-large"`. A standing goal record
adds `reasonCode` (`supervised-mode`, `repeated-failures`, or
`external-operation`), `failedCycles`, `cycleTotals`, `foldedUsage`,
`foldedMembers`, `signalCursor`, `pendingWake`, and, between cycles, the
computed `nextCycleAt`. A paused goal, also one the owner's halt paused, has no
`nextCycleAt` until it resumes. Its cycles add `class`, `settledAt`, `lineup`,
`deadlineStop`, and `wake`.
The host also limits the combined creation request to 40 KiB. On a mapped
project, optional `linearIssueId` accepts an existing issue UUID or identifier
(up to 100 characters); omitting it creates a new parent issue.

Goal steering accepts up to 8,000 characters while running or awaiting input.
It leaves scope and budgets unchanged. Outcome `result` is `achieved`,
`not-achieved`, or `inconclusive`; `summary` permits 4,000 characters and
`evidence` 8,000. An outcome requires a terminal goal with no active cycle or
pending operation. Resume requires a paused goal whose deadline has not expired;
extend the goal first if it has. A standing goal's deadline belongs to its
cycle, so its resume ignores it; resume is refused while the project is not
autonomous. Extending a standing goal between cycles returns
`goal-not-extendable`.

The record reads answer `404` with `objective-version-not-found` for a version
the record does not have, and `409` for a goal cycle run, mission subteam, or handoff run
(`objective-record-of-goal`, `objective-record-of-mission`, `objective-record-of-handoff`), a stored record that
cannot be read (`objective-record-invalid`), one a newer host wrote
(`objective-record-newer`), and a goal whose fields do not fit the record
(`objective-source-invalid`). An unknown id answers `404` with
`goal-not-found` or `team-not-found`. A standalone run with no plan yet answers
`404` with `objective-record-absent`. A `version` that is not a positive integer
answers `400`. Error bodies carry a code and a fixed sentence, never record text.

The legacy goal parallelism endpoint refuses owner capacity changes; each
cycle's PM selects capacity for its work. The refusal uses `409` with
`code: "agent-managed-capacity"`.

### Teams

| Method and endpoint | Body | Role |
| --- | --- | --- |
| `GET /api/teams[?view=list]` | None; returns `{teams}`: every run in full, or with `view=list` one compact row per run (see below) | Any paired device |
| `GET /api/teams/:id` | None; returns the full record with reports and check evidence | Any paired device |
| `GET /api/teams/:id/context` | None; returns the files each member's recorded tool inputs pointed at | Any paired device |
| `GET /api/teams/:id/record[?version=N]` | Optional `version` (a positive integer); returns the objective record of a standalone run at that version | Owner, controller, or viewer |
| `POST /api/teams` | `requestId`, `projectId`, `provider`, `title`, `objective`, optional `useConfiguredLineup` | Owner |
| `POST /api/teams/:id/steer` | `requestId`, `revision`, `text` | Owner/controller; standalone teams |
| `POST /api/teams/:id/continue` | `requestId` (UUID), `revision`, optional trimmed `text` (1–8,000 characters) | Owner; continuable standalone blocked runs |
| `POST /api/teams/:id/decisions/:decisionId/answer` | `requestId`, `revision`, `text` | Owner/controller |
| `POST /api/teams/:id/pause`, `/resume`, `/cancel` | `requestId`, `revision` | Owner; standalone teams |
| `POST /api/teams/:id/tasks/:taskId/rating` | `requestId`, `score` (1–5), optional `note` (≤1,000 characters) | Owner |

`GET /api/teams` without `view` answers every run in full, which is what
installed clients read. `view=list` answers one compact row per run for list
screens. A row uses the same keys and meanings as the full record and leaves
out the request, check output, member reports, task instructions and
summaries, continuations, steering, the brief and issue descriptions. It
keeps the run's identity, status, revision, times, branch and commits, reason
and worker counts; its decisions in full; reduced `members`; `tasks` with
their dependencies and at most 20 changed paths each, then `truncated`;
`checks` with their command, phase, status and revision; the latest entry of
`events`; and the identifying fields of `lineup`, `goal`, `linear`, `review`,
`discovery`, `pullRequest`, `deliveryReceipt`, `permissions`,
`permissionDecisions` and `usage`. `TeamListItem` in
`packages/host/src/team-list.ts` is the exact shape. A row is reduced, not
redacted: decision text, the reason, check commands and paths appear as in
the full record. The list is not paginated. Read a run's detail from
`GET /api/teams/:id`.

A full list grows with every stored run and its check output. The remote
channel carries at most 4 MiB per response. When the answer to
`GET /api/teams` with no query exceeds that, the channel answers the compact
rows in its place, and answers rows without the full read for the next five
minutes, also when the list has shrunk in that time. A client built before
`view=list` existed then reads rows where it expected full records. Its list
screens work. A screen that shows a run from a list row computes the run's
status, check summary and task order correctly, because a row keeps what
those are computed from, and lacks the request, check output, reports and
task text until it reads the run itself.

The context response lists, for each member of the current revision and each
earlier member still running, its repository-relative `files` with `reads`,
`edits`, and `lastAt`, a `graphQueries` count, and `observable`, `complete`,
and `truncated` flags. `GET /api/sessions/:id/context` returns the same shape
for one session. These are observed tool inputs: they show what an agent's
tools were pointed at, not that the agent used the content, and an observed
edit is not a landed change. A session answers `observable: false` until the
index has read a tool input that a provider hook recorded for it; with
`complete: false` the index may still find one. That covers a provider whose
hooks are off, a session started with native arguments or in the native UI,
and a session before its first tool call. A session also answers
`observable: false` when its provider is neither Claude Code nor Codex, when
it has no host journal, and when its journal cannot be read. The index is in
memory, bounded,
and rebuilt on demand after a restart. `complete: false` means the index is
still catching up, or is full of sessions being read and will admit this one
on a later request. See [Swarm view](swarm.md).

The continue request accepts exactly `requestId`, `revision`, and optional
`text`; omit `text` when no direction is needed. A supplied direction is trimmed
and must contain 1–8,000 characters.

### Project signals

| Method and endpoint | Body | Role |
| --- | --- | --- |
| `GET /api/projects/:id/signals?after=SEQ&limit=N` | None; returns `{signals, head}`, oldest first. `after` defaults to 0; `limit` is 1–200, default 50 | Any paired device |
| `POST /api/projects/:id/signals` | `requestId` (UUID), `text` (trimmed, 1–2,000 characters); returns `{recorded, signal}` | Owner |

`head` is the highest signal number on the host, across all projects. A repeated
`requestId` records nothing and returns the signal stored first, with
`recorded: false`. A repeated `requestId` whose signal the row limit already
removed is `410` with `code: "signal-gone"`; nothing new is recorded. An unknown
project is `404`. An unavailable evidence store is `503` with
`code: "evidence-unavailable"`, and a full key record is `503` with
`code: "signal-inbox-full"`. See [Project signals](#project-signals).

### Halt

| Method and endpoint | Body | Role |
| --- | --- | --- |
| `GET /api/halt` | None; returns `{readable, host?, projects}`. Each halt has `haltId`, `at`, optional `reason`, and `by`, the engaging device's label; a project halt adds `projectId` | Any paired device, including viewers, who see the owner's free-form reason and the device label |
| `POST /api/halt` | `requestId` (UUID), `scope` (`host` or `project`), `projectId` for a project, optional trimmed `reason` (1–500 characters) | Owner |
| `POST /api/halt/release` | `requestId` (UUID), `scope`, `projectId` for a project, optional `keepPaused` | Owner |

Engage returns `{halt, engaged, paused, failed}` and release returns
`{halt, released, resumed, notResumed}`. Each listed item has `kind` (`routine`,
`goal`, `mission`, or `team`), `id`, `title`, and an optional `reason`. A replay
of the same request returns the first result. An unknown project answers `404`
with `code: "project-not-found"`; a project that left the configuration while
halted can still be released. A request ID reused with a different body answers
`409` with `code: "request-conflict"`. While the halt record cannot be read, both
mutations answer `409` with `code: "halt-unreadable"`. A failed write answers
`503` with `code: "write-failed"` and changes nothing. The session manager
refuses a launch that a halt holds with `409` and `code: "halted"`. See
[Halt](#halt).

## Model scorecard

`GET /api/usage/models?role=implementer` reads the outcome ledger's production
rows, not run records. It returns per-profile task outcomes, metered usage,
version 1 reviewer rubric means, separate owner ratings, Wilson 95% integration
intervals, and advisory comparisons once both profiles have at least ten counted
attempts. The shape is unchanged, with two additive fields: top-level `sources`
(`["production"]`) and a per-row `excluded` object with `limit`, `owner`,
`host`, and `duel` counts. Limit-switched attempts stay excluded. A profile with
no counted attempt has no row. When the evidence store is unavailable the route
answers `503` with `code: "evidence-unavailable"`; it neither falls back to run
records nor shows an empty scorecard.

The numbers changed on purpose in these eight ways:

1. An attempt integrated before a steer, a resume, or a continuation counts.
2. An attempt of a deleted run counts.
3. Owner stops and host stops leave the denominator.
4. A running attempt is left out, because only ended attempts count.
5. A profile's row shows one identity and one epoch only: the model the configured lineup gives that profile ID now, at the epoch the owner last declared for it (`infinite usage outcomes new-epoch`). Older epochs, and an older model behind the same ID, stay in the ledger cells. After an epoch advance or a model change, the profile has no row until an attempt under the new one has ended, and a profile whose attempts are all still running or excluded has no row either. A lineup that a goal, a mission, or a handoff policy carries can give the same profile ID another model for good; those attempts stay in the ledger cells and never reach this row.
6. A scout's rate is its completed share.
7. Review rounds count correction rounds of every cause (`rounds.run`).
8. Minutes run to the integration event, not to the report.

The first start after an upgrade writes the rows of every retained run that predates the ledger before the host serves, so the scorecard never shows a part of the history as all of it.

Cost is the usage service's measured total for each session. A session it did
not measure, one it covered only in part, or one with partly unpriced usage is
left out of every cost figure and is never counted as zero. A rate with no counted attempt prints as
`rate unknown`, never as 0%.

`GET /api/outcomes?project=&role=&by=&sources=&days=` returns display cells to
every paired device. `by` names up to five dimensions (`project`, `profile`,
`area`, `kind`, `risk`; default `profile`), `sources` names any of `production`,
`duel`, `replay`, and `legacy` (default `production`), and `days` is an integer
from 1 to 3650. Each cell shows its key, attempts, open and excluded counts, and
the four levels with their intervals. `infinite usage outcomes` prints one line
per cell, and `--json` prints the response. Rows whose payload cannot be read
are left out and counted in `unreadable`.

The host never changes the configured model lineup; ratings and rubrics are not sent to
implementers. The owner rating request is idempotent for a given `requestId`.

### Signals and held

A signal is a fact about a run's outcome rows. Besides `rating`, four kinds
appear. `landing` and `revert` are host receipts from the base branch scan.
`linked-fix` and `exclusion` are owner claims. A member cannot write a signal.
Signals are kept as long as the run's rows are.

The scan matches a new first-parent base commit to an approved run by one of
three exact rules. It checks the commits oldest first:

1. The commit is the merge commit that the run reported (`merge-commit`).
2. The commit's second parent is the run's reviewed head (`merge-parent`).
3. The commit's tree is the run's reviewed tree (`tree-equal`).

A tree can recur, so rule 3 also needs proof that the commit is not older than
the run. The commit is the reviewed head itself, or the run's base is among the
scanned commits before it. When the base is not among them, the rule holds only
in a scan of new commits. A scan that reads history older than the ledger's own
head (the first scan, or one after a rewrite or a source change) then matches no
tree. A run that changed nothing never lands.

A run lands once, at its first matching commit. A squash onto a moved base lands
nothing, so that run's held stays unknown.

A landing starts a hold window of `teams.outcomes.holdDays` days. Held is:

- yes when the row was accepted, and the window closed with scans that covered
  every base commit in it;
- no when the row was not accepted, when the landing was reverted inside the
  window, or when a linked fix applies;
- unknown otherwise.

A linked fix applies when the run has no landing, or when its time is at or
before the close of the window. Unknown is never shown as a number. A cell
counts an unknown held under `unknown`.

Held stays unknown when a gap falls inside the window:

- a jump past 500 commits, where the scan keeps the newest 500 and records the
  gap `bound`;
- a rewritten base branch (`rewrite`), or a project that now follows another
  repository or branch (`source`);
- a fetch that no scan recorded, when the scanner cannot show that every head
  the mirror held since the last recorded scan is still a first-parent commit of
  the base branch (also `rewrite`). A host restart after such a fetch moved the
  head is one case;
- a refresh that lapses by more than six hours across the close of the window.

The row carries the `scan-gap` flag when a gap leaves held unknown on an accepted
row of a run that landed. A revert decides held whatever the gap.

The first scan of a project reads only the newest 500 commits, so it finds no
older landing. A run is a landing candidate for 90 days after its approval.

An owner exclusion removes the attempt from every rate, and the scorecard counts
it under `excluded.owner`. Withdrawing the exclusion restores the attempt.

Two settings under `teams.outcomes` control the ledger. Neither needs a new
routine approval.

- `holdDays`: an integer from 1 to 365. Default 30.
- `retentionDays`: an integer from 30 to 3650. Default 730, the ledger's
  retention.

A changed `holdDays` applies to landings recorded afterwards. Each landing keeps
the window it started with.

`POST /api/outcomes/signals` is owner only. Each body is JSON with one of three
shapes. A record carries a `requestId` UUID. A withdrawal carries none, because
it is idempotent by the signal's state.

- `{"action": "record", "kind": "linked-fix", "requestId", "runId", "memberId", "issue", "commit", "at"}`.
  `memberId` and `at` are optional. The fix names an `issue` or a `commit`. `at`
  is an ISO time no later than the request.
- `{"action": "record", "kind": "exclusion", "requestId", "runId", "memberId", "reason"}`.
  `reason` is `outside-cause`, `invalid-task`, `trial`, or `other`.
- `{"action": "withdraw", "kind": "linked-fix" or "exclusion", "signalId"}`.
  `signalId` is 64 hex characters.

The route answers:

- `200` with `{ "signal", "repeated" }`. `repeated` is `true` when the same
  record was already applied, or when the signal was already withdrawn. The
  served signal has no `request` field.
- `400` for an invalid body, or an `at` later than the request.
- `403` for a caller that is not the owner.
- `404` with `outcome-not-found` for an unknown run or member, or with
  `signal-not-found` for an unknown signal.
- `409` with `request-conflict` when the `requestId` was used for another
  record, or with `signal-not-withdrawable` when the signal is not an owner
  signal of the given kind.
- `503` with `code: "evidence-unavailable"` when the store is unavailable, or
  when a row of the run cannot be read.

The remote relay refuses this route with `403` and `code:
"remote-endpoint-denied"`.

`GET /api/outcomes/runs/:runId` lists the run's signals, withdrawn ones included.
`unreadable` counts the signals of the run that the store could not read. A run
with such a signal keeps the levels it had: the host does not recompute its rows
without every signal, and an owner claim on it answers `503`. The ledger's
projector also waits at the next event of that run, as it does for an outcome row
it cannot read, so no later event of any run is projected until the store is
repaired.
`infinite usage outcomes --run ID` prints one line per signal.

```sh
infinite usage outcomes link-fix --run ID [--member ID] (--issue KEY | --commit SHA) [--at TIME] [--request-id ID] [--json]
infinite usage outcomes exclude --run ID --member ID --reason REASON [--request-id ID] [--json]
```

Either command takes `--withdraw SIGNAL` to withdraw that signal; a withdrawal
needs no other option. For a record, pass `--request-id` to make a retry safe.
Otherwise each run of the command is a new request.

A revert is seen only when a first-parent commit's message names the landing
commit or, for a landing by the second parent, the reviewed head. Work that is
removed another way is not seen: a revert of one commit of the branch, a revert
of a second merge of the same head, or a plain edit. Held can then be yes for
work that is gone.

A landing is a receipt of what the mirror showed at a fetch. The agent identity
can write the mirror, so a receipt is not proof against a member that alters the
mirror itself. A `merge-commit` landing also rests on the merge commit that the
delivery member reported: the scan checks only that it is a first-parent commit
of the base branch. Each landing stores which rule matched.

Runs that predate the ledger never land, so their held stays unknown. A landing
commit that the scan read before its run's approval reached the ledger is never
matched. The scan does not infer a landing from a pull request number, a commit
subject, or the GitHub API.

### Roll-ups

`GET /api/outcomes/rollup?goal=ID` and `GET /api/outcomes/rollup?mission=ID`
return one roll-up for a goal or a mission. Pass exactly one of them, and the
value must be a UUID. Every paired device can read it, as it reads
`GET /api/outcomes`. `infinite usage outcomes --goal ID` or `--mission ID`
prints the roll-up, and `--json` prints the response.

A run belongs to a roll-up when its run summary or one of its rows carries the
goal or mission id. Every row and member result of such a run counts. A row
copies the goal when it is made, so a row that an event made before
`run.created` can carry none. The run still belongs through its summary or its
other rows. A deleted run still rolls up while the ledger keeps its rows.

The response holds these fields:

- `target` and `known`. `known` is true when the host holds a record of the
  goal or mission.
- `assessment`: the goal's latest assessment, with `result`, `at`, and
  `revision`. A mission has none. The assessment text stays with the goal.
- `runs`: `total`, `withSummary`, `withCounts`, `deleted`, the `status` and
  `blockCodes` counts, the summed `counts` and `rounds`, and `flagged` with
  `backfilled` and `gap`.
- `attempts`: rows by disposition, for both roles.
- `implementer` and `scout`: the display cells of each role. They count the
  same way as the cells of `GET /api/outcomes`.
- `members`: the member results counted.
- `cost`: `sessions`, `complete`, `noSession`, `tokens`, and `spentUsd`.
- `unreadable`: the stored records of the runs that the store could not open.
- `unindexed`: the stored rows and summaries whose goal or mission reference
  could not be read at migration. It counts across the whole store.

Unknown values stay unknown:

- `counts` and `rounds` are summed over settled runs only. Both are null when
  no run has settled.
- A session's cost counts only when it is complete: the usage ledger covered
  the whole session, and every step has a price. A session left out of the cost
  is never counted as zero.
- `tokens` and `spentUsd` are null when nothing was summed, never 0.
- Only a metered provider adds to `spentUsd`.

The route answers:

- `400` for a bad query, for example both parameters, neither, or a value that
  is not a UUID.
- `404` with `code: "rollup-not-found"` when the host holds no record of the
  goal or mission and the ledger holds no run of it.
- `503` with `code: "evidence-unavailable"` when the store is unavailable.

A known goal or mission with no run answers `200` with zero runs, null
`counts`, and empty cells. The remote relay refuses this route with `403` and
`code: "remote-endpoint-denied"`.

### Legacy import

`infinite usage outcomes import-legacy --file FILE [--dry-run] [--json]`
imports the operator's own ledger. Only the owner can run it. The operator
converts the ledger to JSON lines outside this repository. The CLI reads the
file, and the host never reads a path. Each line is one outcome, and each line
is an unauthenticated claim.

The fields of a line:

| Field | Rule |
|---|---|
| `id` | Required. Letters, digits, `.`, `_`, `:`, and `-`. 1 to 80 characters, starting with a letter or digit. |
| `projectId` | Required. Lowercase letters, digits, and `-`. 1 to 80 characters. The project need not exist on this host. |
| `profile` | Required. `provider` and `effort` (optional): lowercase letters, digits, and `-`, starting with a letter, 1 to 40 characters. `model`: letters, digits, `.`, `_`, `:`, `/`, and `-`, 1 to 120 characters. |
| `label` | Optional. At most 40 characters, with no control character. |
| `result` | Required. `accepted`, `rejected`, or `excluded`. |
| `attempts` | Required. An integer from 1 to 100. |
| `totalTokens` | Optional. An integer from 0 to 10^12. |
| `elapsedMs` | Optional. An integer from 0 to 31,536,000,000. |
| `reviewerModel` | Optional. The same form as `model`. |
| `recordedAt` | Required. An ISO time with an offset, not later than the import. |
| `supersedes` | Optional. The same form as `id`, and not equal to `id`. |

An unknown key fails the line. One line looks like this:

```json
{"id":"op-2026-10-01-example","projectId":"alpha","profile":{"provider":"opencode","model":"model-a","effort":"high"},"label":"ABC-12","result":"accepted","attempts":1,"totalTokens":120000,"reviewerModel":"model-b","recordedAt":"2026-10-01T09:00:00Z"}
```

The limits are:

- 20,000 lines in a file.
- 1,024 bytes in a line.
- 50 lines in a batch.
- 50,000 legacy lines on a host.

The CLI checks the whole file before it sends anything. A file with a wrong
line, a blank line, or a repeated id with another body is refused, and the
CLI prints `Line N: <reason>` for each error and `Nothing was sent.`. It then
exits non-zero. A valid file goes out in batches of 50, in file order, one batch
at a time. The command then prints `Line N: changed` or `Line N: conflict` for
each refused line and one summary line, such as
`Imported 3, repeated 0, superseded 0, expired 0, refused 0, removed 0.` It
exits non-zero when a line was refused. `removed` counts the stored rows that a
superseding line replaced. `--json` prints each line's number and outcome.

A line becomes a row with these values:

- Source `legacy`. Its outcome id is `legacy:` followed by a blind index of the
  line's `id`. The operator's `id`, `label`, `projectId`, `reviewerModel`, and
  `supersedes` stay in the sealed payload.
- Profile `(legacy)` at epoch 0, role `implementer`, and a run id of its own.
  No legacy row shares a cell with a production row.
- `accepted`: integrated yes, accepted yes, firstPass yes only when `attempts`
  is 1, and held unknown.
- `rejected`: integrated unknown, accepted no, firstPass no, and held no. The
  operator's ledger does not say whether rejected work was integrated.
- `excluded`: disposition `host-stop`, exclusion `host`, and all four levels
  unknown.

The host gives each line one of six outcomes:

- `imported`: the line is stored as a new row.
- `repeated`: the same id came with the same body, so nothing changes.
- `superseded`: a line that the host holds replaces this id, so the line is not
  stored.
- `expired`: `recordedAt` is older than the retention window.
- `changed`: the id is known with another body. The line is refused. To change
  an outcome, the operator issues a new id with `supersedes`.
- `conflict`: the outcome id belongs to a row that the import did not write.
  The line is refused.

A refused line does not stop the other lines of its batch. A replay changes
nothing. What the host stores depends on the set of lines, not on their order
or on where the file is cut into batches. A line that was itself superseded
still replaces the line it names. So a chain of `supersedes` keeps only its
last line, and a cycle keeps no line. This holds for one body per id: of two
bodies under one id, the first that the host sees stays, and the other is
`changed`.

`--dry-run` writes nothing. It decides each batch against what the host holds,
so it reports what a real import of that batch would. In a file of more than
50 lines, a later batch does not see an earlier one: a line that repeats or
supersedes a line of an earlier batch reads `imported`.

Legacy rows appear only in `display` cells that name the `legacy` source, such
as `GET /api/outcomes?sources=legacy`. They never enter the Models scorecard,
a `decision` read, or a roll-up. The host never recomputes a legacy row. A
legacy row is kept `teams.outcomes.retentionDays` after its `recordedAt`, and a
line recorded longer ago than that is `expired` when it is imported.

`POST /api/outcomes/legacy` is the route behind the command. It is owner only.
The body holds `dryRun` and 1 to 50 `lines`. The route has no request id,
because a replay is idempotent by line id. It answers `400` with
`code: "legacy-invalid"` and no detail for a body that does not parse, so no
key or value of the operator's file comes back in an error. It answers `403`
for a caller that is not the owner, `409` with
`code: "legacy-limit"` when the host would exceed 50,000 legacy lines, and
`503` when the store is unavailable. The remote relay refuses this route with
`403` and `code: "remote-endpoint-denied"`.

### Other route rules

Goal-owned team lifecycle and steering routes return `409` with
`code: "goal-owned-team"`. Use the owning goal's endpoints. The decision route
remains available for its active cycle while the goal is running.

The legacy team parallelism endpoint refuses owner capacity changes with `409`
and `code: "agent-managed-capacity"`. Legacy team creation requests may include
`parallelism`, but it does not select worker
capacity. PM reports and mission coordinator actions remain bounded by the
host's ceiling; handoff teams permit at most two workers and solo mission
subtasks permit one.

`GET /api/me` advertises `teams: {enabled, maxParallelism, lineup?}`,
`goals: {enabled}`, each project's configured checks, and optional
`projects[].linear: {enabled}`. Team records include
`workers: {limit, max, running, ready}`, where `max` is the highest limit allowed
for that team. Goal and Team records include optional `linear`
tracking with `status` (`pending`, `synced`, `blocked`, or `error`), `reason`,
`checkedAt`, and the latest issue snapshot when available. Goals are enabled
only when the configured coordinator and reviewer both carry `tier: "strong"`.
With `useConfiguredLineup: true`, a Team creation's `provider` must match the
lineup's coordinator. Goal creation selects that provider from its lineup.
Callers cannot supply arbitrary profiles, model names, or executable arguments.

Mutations use a UUID request identity and expected revision. An identical retry
recovers the recorded result; changed content under the same identity and
obsolete revisions are refused. After uncertain delivery, retry the original
request. Browser pending requests survive navigation and connection loss in tab
memory, but not a reload or closed tab.

The workflow combines deterministic execution steps with agent decisions, as
described in [Stripe's Minions, Part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2).
Infinite's execution and trust boundaries remain those described above.
