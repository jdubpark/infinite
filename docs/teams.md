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

Removal also waits for head publication; see [Head publication](#head-publication).

The run record, events, reports, and receipts remain after merged, no-change,
ready-for-review, and blocked workspaces are removed. Cancelled runs are deleted
whole after their settle window. Started and completed removals are recorded as
host events, and a failed removal is retried on later scheduler ticks. A blocked run whose workspace
was removed cannot resume, continue, or be steered; pause and cancel remain
available. `DELETE /api/teams/:id` and `infinite team delete ID` remove a settled
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
The operator must first establish that the old check processes have exited:
the host cannot see check processes orphaned by a previous API process (for
example, when `systemd` uses `KillMode=process` or a sudo command prefix is
configured). Before attesting, confirm that no process from the interrupted
check remains and that no process has a working directory under the team root.
The attestation is an operator claim, not host verification.

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
`integration-changed-files`.

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
| `maxRuns` | 3 | 1–10 sequential feature cycles |
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

Goal and Team pages show the issue link, title, workflow state, tracking status,
and last check time. A cached issue record is not proof that Linear is currently
reachable. The issue's workflow state stays separate from local execution state,
agent review, and product outcome assessments. Infinite does not automatically
change that state or mark an issue Done when checks pass.

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

The sealed host ledger records measured OpenCode token usage. Configure a `usage` block to expose the Cost view, account mapping, and budgets. The dated built-in catalog prices DeepSeek and Meta models; custom prices can override it. Claude and Codex remain unmeasured per use and appear only as fixed plan fees. The web client, API, and CLI read the same ledger.

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

Only some work is measured. OpenCode team members and OpenCode sessions started from the local UI report usage. Claude Code, Codex, Grok, and OpenCode in a native terminal do not, so their sessions, and team members that use them, show `Unmeasured`. Unmeasured work is counted separately and is never added to a total as zero.

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
blocker. All roles are prompted to write plain English and report only evidence
and checks they observed.

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
    }
  }
}
```

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

The first repository enrollment enables delegation by default:

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

The first command revokes delegation for a current run. The second disables it
for future runs. Both require an owner client. Pausing, cancelling or steering a
run prevents its old pending decisions from being applied.

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

Trust lets each provider apply the repository's own provider settings in member
folders, such as Claude hooks, permission rules and MCP configuration, or a
project Codex configuration. Team members can edit those files, and later
members load the integrated result. Review them like the rest of a run's
changes. Tool permission prompts, delegation limits and the root ownership rules
above are unchanged; sessions outside team runs never receive this trust.

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
The host also limits the combined creation request to 40 KiB. On a mapped
project, optional `linearIssueId` accepts an existing issue UUID or identifier
(up to 100 characters); omitting it creates a new parent issue.

Goal steering accepts up to 8,000 characters while running or awaiting input.
It leaves scope and budgets unchanged. Outcome `result` is `achieved`,
`not-achieved`, or `inconclusive`; `summary` permits 4,000 characters and
`evidence` 8,000. An outcome requires a terminal goal with no active cycle or
pending operation. Resume requires a paused goal whose deadline has not expired;
extend the goal first if it has.

The legacy goal parallelism endpoint refuses owner capacity changes; each
cycle's PM selects capacity for its work. The refusal uses `409` with
`code: "agent-managed-capacity"`.

### Teams

| Method and endpoint | Body | Role |
| --- | --- | --- |
| `GET /api/teams` | None; returns `{teams}` | Any paired device |
| `GET /api/teams/:id` | None; returns reports and check evidence | Any paired device |
| `POST /api/teams` | `requestId`, `projectId`, `provider`, `title`, `objective`, optional `useConfiguredLineup` | Owner |
| `POST /api/teams/:id/steer` | `requestId`, `revision`, `text` | Owner/controller; standalone teams |
| `POST /api/teams/:id/continue` | `requestId` (UUID), `revision`, optional trimmed `text` (1–8,000 characters) | Owner; continuable standalone blocked runs |
| `POST /api/teams/:id/decisions/:decisionId/answer` | `requestId`, `revision`, `text` | Owner/controller |
| `POST /api/teams/:id/pause`, `/resume`, `/cancel` | `requestId`, `revision` | Owner; standalone teams |
| `POST /api/teams/:id/tasks/:taskId/rating` | `requestId`, `score` (1–5), optional `note` (≤1,000 characters) | Owner |

The continue request accepts exactly `requestId`, `revision`, and optional
`text`; omit `text` when no direction is needed. A supplied direction is trimmed
and must contain 1–8,000 characters.

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
not measure, or one with partly unpriced usage, is left out of every cost figure
and is never counted as zero. A rate with no counted attempt prints as
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
- A session's cost counts only when its cost is complete. A session left out
  of the cost is never counted as zero.
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
at a time.

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
nothing. Two lines that supersede each other give the same result in either
order, and the result does not depend on where the file is cut into batches.
In a cycle of `supersedes`, the first line in the file wins.

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
because a replay is idempotent by line id. It answers `400` for an invalid
body, `403` for a caller that is not the owner, `409` with
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
