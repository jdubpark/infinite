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
starts, answers, steers, pauses, resumes, and cancels runs with the same roles
and request rules as the web client, and records goal outcomes. It opens member
sessions, and a member session links back to its team. The Mac app shows Teams
only.

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
configured lineup. First-time repository enrollment delegates current one-shot
tool requests to the strong coordinator by default; `--permissions off` opts out.
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
| `parallelism` | 3 | 1–4 concurrent workers within a cycle, subject to host session capacity; the owner can change it while the goal runs |

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
- With no resolvable fallback, the run blocks with a reason naming the profile and the limit times. The workspace is preserved.
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

The owner can raise or lower the limit while a team or goal runs. Raising it
starts more ready tasks on the next scheduling pass. Lowering it never stops a
running worker; it only holds new starts until fewer workers than the new limit
are running. A change does not create a new team revision or discard reports.

The limit counts concurrent workers, not member attempts. It does not change
`maxMembers`, deadlines or spend. Host session capacity still applies. Handoff
teams allow 1–2.

The owner sets the limit; agents cannot change it.

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

This starting configuration uses Opus 5.5 at `xhigh` for coordination and repair,
Astra 6 at `high` for review, and Haiku 5.5 and GPT-6 Luna at `high` for ordinary
worker tasks. Opus 5.5 `xhigh` and Astra 6 `xhigh` are available through the
explicit escalation pool. Model IDs live in host configuration, rather than
application routing code.

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
    ]
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

This pins a repository scope and a limit of ten decisions to each new run. Later
enrollments preserve the saved policy, including an explicit opt-out. To enable
delegation on an existing enrollment, pass `--permissions coordinator`. Add
`--permission-scope TEXT` or `--permission-limit N` to that explicit command to
change the scope or set a limit from one to twenty. Existing runs remain unchanged.
An older host without delegation support requires an upgrade or an explicit
`--permissions off` choice.

The default scope approves one-time repository read, edit, build and test
operations for the accepted task in its assigned workspace, including a one-time
run of the task's tests or accepted checks outside the provider sandbox. It
escalates new credentials, other repositories, global settings, deployment,
destructive operations, persistent approvals, other permission bypasses and
unclear effects. Delivery keeps its separate pinned policy.

A current one-shot tool prompt can start a separate turn on the run's strong
Claude coordinator profile. The coordinator receives the task, owner scope and exact
request, then reports approve-once or escalate. The host checks the assignment,
workspace, prompt, policy, expiry and human input control before delivering the
recorded choice. Workers cannot approve their own requests. The permission
coordinator runs noninteractively with built-in tools disabled and only its
assignment's report tool allowed. It escalates when the supplied evidence is
insufficient. Worker provider modes, global trust settings and credentials
remain unchanged. Other coordinator providers are not yet supported for this role.

A request qualifies when its evidence is complete: hook tool input that storage
did not truncate, or a Codex "Would you like to run the following command?"
dialog that shows its whole `$` command. Codex hooks are off by default, so
Codex members reach the coordinator through the dialog. The review also gets the
files the member changed against its base and the accepted checks; see
[security](security.md#delegated-team-permission-decisions) for the rule. Once a
request qualifies, the host either starts the review or records an escalation
with its reason, so clients show the prompt as the coordinator's only while it
can act. Codex members are told their sandbox has no network, listeners or IPC
sockets. They prefer checks that run inside it, ask to leave it only for a
one-time run of the task's tests or an accepted check, and report what they
skipped. The host runs the accepted checks after integration.

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
that same host-owned run directory. A constrained launcher must permit
`clone --no-local --no-hardlinks --no-checkout -- SOURCE DESTINATION` from an
existing team copy, `cat-file -t COMMIT`, `check-ref-format --branch BRANCH`,
and `checkout --detach COMMIT`. Recovery uses `checkout -B BRANCH COMMIT`
only in its fresh recovery clone. Read-only inspection uses
`status --porcelain=v1 -z --untracked-files=all` in both team and project
copies. Preserve the launcher's existing path, identity, branch, and commit
restrictions when allowing these forms; verify them under the deployed Unix
identities before activating a host update.

GitHub-tracked sources add these operations. The host runs each through
`teams.commandPrefix`, and a launcher that refuses one fails that refresh step:

- in a host mirror: `init --bare` when the mirror is created, `fetch --no-tags` of
  the base branch from the GitHub URL into `refs/heads/BASE`, and `rev-parse` of
  that ref;
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

A member can explicitly ask a question with suggested options. The team records
the question and stops that assignment; independent tasks can continue. An owner
or controller answers from the team page. The answer is recorded and a new
assignment receives the applicable context. This is a product decision, separate
from the provider's tool permission dialogs.

For a standalone team, steering records a new requirements revision. Earlier
member results cannot satisfy it. The scheduler stops old assignments and replans from the integrated
workspace with the new direction. Completed earlier integration remains visible;
unfinished member copies are preserved. Pause, resume and cancel are owner
actions. A member with no report and no attention activity for `teams.stallMinutes`
(5–1,440, default 30) is stopped. One replacement then continues the same task in
the preserved workspace, with feedback that the earlier attempt stalled. A second
stall on the same assignment blocks the team with the reason "An agent showed no
activity twice on the same assignment." Activity means attention activity from the
member's terminal or hooks. Screen output also counts, so an agent stuck behind an
animated spinner looks active. Older runs blocked by the former one-hour limit
still resume. A team blocked only by a stall can resume with
`infinite team resume ID`. That starts a fresh plan from the preserved
integration commit and keeps the stopped member workspace.
Resume waits until those members have stopped. A changed verification clone has
the separate guarded Resume path described above; other blocks, including an
interrupted workspace or check operation, still require inspection and a new
team. Stopping an agent does not prove that arbitrary detached tool
descendants have stopped, and a current human input lease can prevent the
scheduler from stopping a member. Such conflicts remain visible.

## Blocked runs

A blocked run waits for the owner, so the host flags it everywhere the owner
looks:

* **Phone push.** With push enabled, the host announces new runs, completion,
  cancellation and runs that need the owner. Stuck events are high priority;
  blocked runs say whether they can resume. With `push.detail: "full"`, finished
  and stuck events may include the reason. `team-stuck` controls stuck events;
  `team-blocked` remains an alias. Runs already present when the host starts are
  primed silently, and runs owned by a goal use goal notifications instead.
* **Linear.** The tracked issue gets the reason, the next step and a `Blocked`
  label (see [Linear tracking](#linear-tracking)).
* **App lists.** Web, phone and Mac list blocked runs first, with the reason.
  The list offers Resume when the run can resume, the same rule as the team
  page.

The host never resumes a blocked run itself. `infinite team resume ID` replans
from the integrated work when the block allows it; otherwise inspect the run and
start a new one.

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
uncertain workers. Interrupted Git/check operations require reconciliation; they
are not blindly replayed. Host reboot recovery is a separate limitation of the
underlying session runtime.

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
| `POST /api/goals/:id/parallelism` | `requestId`, `revision`, `parallelism` (1–4) | Owner |
| `POST /api/goals/:id/outcome` | `requestId`, `revision`, `result`, `summary`, `evidence` | Owner/controller |

Creation requires `requestId` (UUID), `projectId`, `title` (up to 100 characters),
`objective` (12,000), and `successCriteria` (4,000). Optional arrays are
`nonGoals` (20 entries, 1,000 characters each), `evidence` (20 entries, 2,000
characters each), and `allowedPaths` (1–32 entries, 300 characters each).
`maxRuns`, `maxMinutes`, `extendMinutes`, `maxTotalMinutes`, `maxMembers`, and
`parallelism` use the limits above.
The host also limits the combined creation request to 40 KiB. On a mapped
project, optional `linearIssueId` accepts an existing issue UUID or identifier
(up to 100 characters); omitting it creates a new parent issue.

Goal steering accepts up to 8,000 characters while running or awaiting input.
It leaves scope and budgets unchanged. Outcome `result` is `achieved`,
`not-achieved`, or `inconclusive`; `summary` permits 4,000 characters and
`evidence` 8,000. An outcome requires a terminal goal with no active cycle or
pending operation. Resume requires a paused goal whose deadline has not expired;
extend the goal first if it has.

A parallelism change applies to the active cycle and later cycles. It is refused
with `goal-not-running` for a goal that is not running, needing input or paused,
and with `goal-launch-pending` while the next cycle is attaching.

### Teams

| Method and endpoint | Body | Role |
| --- | --- | --- |
| `GET /api/teams` | None; returns `{teams}` | Any paired device |
| `GET /api/teams/:id` | None; returns reports and check evidence | Any paired device |
| `POST /api/teams` | `requestId`, `projectId`, `provider`, `title`, `objective`, `parallelism`, optional `useConfiguredLineup` | Owner |
| `POST /api/teams/:id/steer` | `requestId`, `revision`, `text` | Owner/controller; standalone teams |
| `POST /api/teams/:id/decisions/:decisionId/answer` | `requestId`, `revision`, `text` | Owner/controller |
| `POST /api/teams/:id/pause`, `/resume`, `/cancel` | `requestId`, `revision` | Owner; standalone teams |
| `POST /api/teams/:id/tasks/:taskId/rating` | `requestId`, `score` (1–5), optional `note` (≤1,000 characters) | Owner |
| `POST /api/teams/:id/parallelism` | `requestId`, `revision`, `parallelism` (1–4; 1–2 for handoff teams) | Owner; standalone teams |

## Model scorecard

`GET /api/usage/models?role=implementer` returns per-profile task outcomes,
metered usage, version 1 reviewer rubric means, separate owner ratings, Wilson
95% integration intervals, and advisory comparisons once both profiles have
at least ten attempts. Limit-switched attempts are excluded. The host never
changes the configured model lineup; ratings and rubrics are not sent to
implementers. The owner rating request is idempotent for a given `requestId`.

Goal-owned team lifecycle and steering routes return `409` with
`code: "goal-owned-team"`. Use the owning goal's endpoints. The decision route
remains available for its active cycle while the goal is running.

A parallelism change is refused with `goal-owned-team` for a goal-owned team and
with `team-not-running` for a cancelled, ready-for-review, merged or no-change
team. A value above a handoff team's maximum is refused with
`team-parallelism-limit`. Stale revisions and request conflicts follow the usual
rules.

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
