# Request intake from Slack through Linear, on a dedicated instance

Status: design for build, 2026-11-13. Decisions marked **(call)** are the
author's; the owner can overturn them. Decisions marked **(owner)** were made by
the owner in the design conversation.

## Intent

The owner files work where a human team already talks. In a Slack channel or
thread, the owner mentions Linear's own Slack agent. Linear writes an issue from
the thread. The Infinite instance bound to that Linear workspace starts a
mission on the issue, and that instance's Slack bot answers in the same thread:
one acknowledgement, questions when the coordinator has them, and the result.
Requests range from "fix this error" and "build this" to "pull this data", which
changes no code and ends in a written answer.

The same owner runs unrelated work on the same host. An organization's
repositories, mail, Slack history, and provider logins must never reach the
other work, and answers must never land in the wrong place. Each organization's
workspace therefore gets its own Infinite instance.

### Why now

Today the owner starts every mission from the CLI, the Mac app, or the phone.
Nothing starts a mission from an issue, nothing talks to Slack, and a mission
that changes no files has no way to carry its findings back. All agents on the
host also share one Unix account, so a connector added for one body of work is
visible to every run (`docs/security.md`, "Separate the API service Unix
identity").

## Goals

- A second instance runs on the same host for one organization's workspace, with
  its own accounts, credentials, state, and release pointer.
- Two instances together cannot overload the host, and under contention the
  first instance keeps priority. No instance has a fixed resource ceiling.
- A Linear issue that the owner filed and marked starts exactly one mission.
- The originating Slack thread receives the acknowledgement, each owner
  question, and the final outcome. The owner's tagged replies answer or steer.
- A request that changes no code ends with a written answer in the thread.
- Agents can read through the connectors logged in on that instance.

## Non-goals

- Workspaces inside one instance (approach B below).
- Teammates starting, answering, or steering anything.
- An Infinite bot that reads channels on its own or files issues. Linear's Slack
  agent does intake.
- Agents posting to Slack, sending mail, or using any write connector.
- Progress streaming in Slack, message edits, reactions, buttons, or files.
- Provider permission prompts in Slack. They stay on the phone, Mac, and CLI.
- Changes to delivery. Merge and publish policy stays per repository.
- Registering Infinite as a Linear agent that issues are delegated to.
- Client UI changes. The instance appears as a second machine in every client.
- Operator confidentiality. The host's root user can read both instances.

## Anti-goals

These make the feature a failure even if it works:

- One instance reading the other's credentials, state, source, or history.
- A post to any thread other than the one the request came from.
- A teammate's message treated as an instruction.
- A mission started for an issue the owner did not mark.
- The second instance slowing or killing work in the first.
- A Slack message that claims completion the host did not observe. Results are
  agent reports and are labelled as such; `ready-for-review` is not "done".

## Constraints

- Honesty rules in `PRODUCT.md` hold: the host does not infer completion, does
  not approve provider permissions, and does not change a Linear issue's
  workflow state.
- The owner talks only to the mission coordinator. Slack input becomes a mission
  answer or a mission steer, never direct subteam input.
- Slack and Linear credentials are private `0600` files outside the state
  directory, run directory, and every workspace root, validated the way
  `validateLinearConfig` validates the Linear key. They never enter an agent's
  environment.
- No inbound public endpoint. Linear is polled; Slack uses Socket Mode.
- Files guarded by the first instance's release activation (its unit, sudoers,
  wrappers, config) stay byte-identical, with one exception: the `hostLoad`
  block added to its config. Otherwise the second instance only adds files,
  plus one machine entry in the shared relay's config.
- The host's root disk is small. The second instance keeps everything except
  unit, sudoers, wrapper, and config files on the data volume.

## Approaches

**A. One instance per workspace, on the same host (owner).** A second service
with its own API account, agent account, group, vault key, state, provider
homes, credentials, and release pointer. New features assume one workspace per
instance, so the code has no branch that could route to another workspace.
Costs: deploy templates need an instance name; the workspace is a second
machine in the clients; providers need a second login. Chosen on the condition
that it does not overload the host or conflict with the first instance; the
owner then ruled out per-service ceilings in favour of protecting the host as a
whole.

**B. Workspaces inside one instance.** A workspace list in config, a workspace
ID on every project, mission, team, memory record, and delivery, and a check on
every lookup. One board for everything. Rejected: it touches nearly every
subsystem, each a place where a missed check leaks; one process holds both
workspaces' secrets; and `docs/multi-tenant.md` already states that a role
inside one instance is not a boundary.

**C. A separate host or VM per workspace.** The strongest boundary and a second
machine to pay for and run. Not needed now: approach A moves to its own VM later
by moving the instance's directories and config.

## Part 1: A second instance on one host

### Names

An instance has a name `NAME` matching `[a-z][a-z0-9-]{0,15}`. The examples use
`work`. Every identifier derives from it:

| Thing | First instance (unchanged) | Instance `work` |
| --- | --- | --- |
| API account | `infinite-host` | `infinite-work-host` |
| Agent account | `infinite-agent` | `infinite-work-agent` |
| Workspace group | `infinite-workspace` | `infinite-work-workspace` |
| Unit | `infinite.service` | `infinite-work.service` |
| Config | `/etc/infinite/config.json` | `/etc/infinite-work/config.json` |
| Run directory | `/run/infinite` | `/run/infinite-work` |
| Vault key | `/run/infinite-key/vault.key` | `/run/infinite-work-key/vault.key` |
| Wrappers | `/usr/local/libexec/infinite/` | `/usr/local/libexec/infinite-work/` |
| Sudoers | `/etc/sudoers.d/infinite` | `/etc/sudoers.d/infinite-work` |
| Release pointer | `/opt/infinite` | `/opt/infinite-work` |
| Data root | `/srv/infinite-data/` | `/srv/infinite-data/instances/work/` |

The data root holds `control`, `control-home`, `agent-home`, `workspaces`,
`team-workspaces`, `tmp/control`, `tmp/agent`, and `agents` (the provider tools
prefix). `instances/` is root-owned `0711`. `instances/work/` is owned by root
with group `infinite-work-workspace` and mode `0750`. The first instance's
accounts are in none of the new groups, and the new accounts are in none of the
old ones.

The name limit keeps `runDir/<uuid>.sock` under the 100-byte socket path limit.

### What is shared and what is not

Shared, read-only: release directories (root-owned), the Node runtime, the
relay, the host's storage watchdog.

Never shared: the vault key, device keys, the API port, provider binaries the
agent account can update, provider homes and logins, the Linear key, Slack
tokens, the GitHub credential, connector logins, temporary directories, team
workspace roots, the knowledge service, and any memory adapter.

The vault key must be newly generated. A copied key yields the same machine ID,
which breaks relay registration and push routing.

Each instance has its own release pointer. Activating a release for one
instance does not restart or touch the other, and one instance's running teams
never block the other's rollout. Release pruning must scan both instances'
processes before removing a release directory.

### Host load

The new unit has no memory, CPU, or task ceilings **(owner)**. An instance may
use whatever the host has idle. What must not happen is the host as a whole
running out. Three things protect it.

**A launch gate in the host.** Before the host starts a session on its own
behalf (a mission coordinator, a team member, a check run), it reads the host's
available memory and its one-minute load average. Below the memory floor or
above the load ceiling, the launch waits, as launches already wait at
`maxSessions`, and the waiting mission or team shows the reason. The gate never
stops running work, and it resumes launches by itself when the host recovers.
Sessions the owner starts by hand are not gated **(call)**.

```json
"hostLoad": { "minAvailableMemoryGiB": 8, "maxLoadPerCpu": 1.5 }
```

The gate reads the whole host, not the instance's own use, so it also holds
back when the other instance is the one that is busy. It is enabled on both
instances **(owner)**. On the first instance that is one added `hostLoad` block
in its config, applied through the existing config-change procedure, since that
file is guarded by release activation. Nothing else in the first instance
changes.

**Priority under contention, not limits (call).** The new unit sets
`CPUWeight=50` and `IOWeight=50`, below the default of 100. Weights do nothing
while the host has spare capacity; when both instances compete, the first gets
twice the share.

**A defined loser (call).** The new unit sets `OOMScoreAdjust=500`. If the host
does run out of memory despite the gate, the kernel takes the new instance's
processes first. The first instance's unit, including its existing limits, is
not edited.

`maxSessions` keeps its default in the new instance.

### Deploy templates

Rendering from the existing templates in `deploy/ubuntu/` must produce, from
one instance name: the unit, the sudoers file, the agent wrappers, the tmpfiles
entry, the GitHub credential files (issuer config path, token directory,
refresh unit and timer, `gh` wrapper), and a config skeleton that includes a
`teams` block and the `hostLoad` block. Whether that is a renderer script or
systemd template units is left to the builder. Rendering with no instance name
must reproduce the current tracked files byte for byte.

Every path in the instance wrapper derives from the instance name: temporary
directory, package store, Corepack home, tools prefix, release pointer, and the
directory the wrapper loads session environment files from. A wrapper that
still loads the first instance's environment directory would hand the new
agents the first instance's variables.

The instance tracks its repositories from GitHub with its own App credential,
rendered as above, so the first instance's credential is never installed on the
organization and the two token directories are separate **(call)**. If the
organization does not approve an App installation, those repositories use the
existing laptop source mode; no token-based variant is built.

### Host tools outside the repository

Several host tools are private to the deployment and are not tracked: release
activation and its file guard, release pruning, the boot helper that places the
vault key under `/run`, the root-owned team command launcher named by
`teams.commandPrefix`, the secrets sync list, and the backup job. The tracked
deliverable for this part is the templates and a runbook. The coordinator, who
has root on the host, extends each private tool at commissioning:

- The boot helper also places the new instance's vault key. At rest that key is
  on the encrypted volume, readable by root only.
- The new instance gets its own team command launcher under its wrapper
  directory, with its own roots. Sudo launch profiles are refused without one.
  Installing a launcher needs the owner's approval, as it does today.
- Release pruning scans both instances' processes.
- Relay registration adds one machine entry to the relay's config. This and the
  `hostLoad` block are the only edits to existing files.
- New credential paths join the secrets sync list, in a vault of their own
  **(call)**. Following the owner's backup policy, nothing else from the new
  instance goes off the host: code is on GitHub, and a lost host loses the
  instance's run history, not its source or credentials.

"Byte-identical" for the first instance is measured against the files installed
on the host, which is what the activation guard hashes. Fixing a tracked
template does not change an installed file.

The rendered sudoers file keeps `INFINITE_MISSION_ASSIGNMENT` in `env_keep`. The
tracked template omits it today; the worker sets it and the mission report tool
requires it, so a sudo-launched mission coordinator cannot report without it.
Fix the tracked template in the same change.

### Off by default in a workspace instance

So that an organization's content reaches no third party the owner did not
choose **(call)**: repository briefings, the knowledge service, remote memory
adapters, cmux, the demo provider, and contributor data-use models are off. The
lineup lists only providers the owner enabled for that organization.

### Reaching the instance

The instance registers with the existing relay as a second machine with its own
registration key, and gets its own loopback port and origin. The phone, Mac, and
web clients add it as a machine. The laptop CLI addresses it with
`INFINITE_CLIENT_CONFIG` or `--client-config`; no CLI change is needed.

### Acceptance on the host

- The new agent account cannot read the first instance's agent home, control
  state, workspaces, or `/etc/infinite`, and the reverse holds.
- `systemctl show` reports the weights and OOM score, and every process owned
  by the new accounts is in the new unit's control group.
- The first instance's guarded files hash the same before and after, apart
  from the `hostLoad` block in its config.
- Restarting either service leaves the other's sessions and workers running.
- With host memory pushed below the floor by a synthetic load, the new instance
  holds its next launch and shows the reason, its running sessions continue,
  and the launch proceeds once memory recovers.

## Part 2: Intake

An in-process service in the instance polls Linear every 30 seconds for issues
that qualify and starts one mission per issue. It uses the instance's existing
`linear.apiKeyFile`, which holds the owner's key in that Linear workspace.

### Configuration

```json
"intake": {
  "linear": { "teamIds": ["TEAM_UUID"], "creatorId": "USER_UUID", "label": "infinite" },
  "slack": {
    "appTokenFile": "/run/secrets/slack-app-token",
    "botTokenFile": "/run/secrets/slack-bot-token",
    "teamId": "T00000000", "ownerUserId": "U00000000"
  },
  "mission": { "groupId": "work", "maxSubtasks": 8, "maxMinutes": 240, "answerProjectId": "notes" },
  "maxActive": 3,
  "requireSlackThread": true
}
```

`linear.creatorId` is required. It is the owner's Linear user ID, and an issue
created by anyone else, or with no creator, is skipped.

`slack` is optional. Without it, intake still starts missions and records
outcomes in Linear, and the owner answers questions in the apps.

### Which issues start a mission

All of these must hold:

1. The issue is in a configured team, carries the label, is not archived, and
   is in an open workflow state.
2. It was created after intake was first enabled on this instance. The enable
   time is stored in sealed state. Older issues are never admitted.
3. Linear reports the owner's user ID as its creator.
4. When `requireSlackThread` is set, the issue links a Slack thread in the
   configured Slack workspace, and that thread contains a message from the
   owner's Slack user ID that mentions Linear's agent, posted before the issue
   was created.

Checks 3 and 4 are independent on purpose: one rests on Linear's attribution,
the other on Slack's. The label exists because the owner also files issues for
teammates **(call)**.

An issue that passes check 1 and fails a later check is recorded as skipped with
its reason, once, in local state only. Intake writes nothing to an issue it does
not admit.

### Starting the mission

Intake keeps one sealed record per Linear issue ID: the issue snapshot, the
admitting rule, the Slack thread binding, the mission ID, and the message
outbox. States: `queued`, `started`, `finished`, `skipped`.

The mission's `requestId` is derived deterministically from the issue ID, so a
crash between "seen" and "created" still produces exactly one mission. The
mission targets `intake.mission.groupId`, an owner project that groups the
workspace's repositories; the coordinator picks the repositories.

The objective is the issue identifier, title, and description, followed by the
owner's own messages from the linked thread: the owner's first message and the
owner's newest messages that fit in the 24,000-character objective limit.
Messages from anyone else, and bot messages, are read at admission to check
authorship; they are not stored, shown to agents, or logged. The objective
states that only the owner's words are instructions and that anything read
later through a connector is information.

When `maxActive` intake missions are planning or working, the record waits in
`queued` and starts when one leaves those states. A mission that is waiting on
the owner or paused does not hold a slot **(call)**, so an unanswered question
never stalls the queue. Missions started from the apps do not count toward
`maxActive`. The default of three **(call)** keeps a burst of filed issues from
starting a dozen coordinators at once; the launch gate in Part 1, not this
number, is what protects the host. `maxSubtasks` and `maxMinutes` default to the
mission defaults.

Starting missions on the owner's behalf is recorded delegation, not inference:
the `intake` block is the owner's standing instruction, and each mission's first
event names the issue and the rule that admitted it.

### After the start

- The mission uses the snapshot. A later edit to the issue's title or
  description does not change a running mission **(call)**. The thread gets one
  note saying so and that a tagged reply steers the run.
- If the issue is closed, cancelled, archived, or deleted, the host pauses the
  mission with that reason **(call)**. The person who closed the issue may not
  be the owner, so the owner decides whether to resume or cancel. A Linear
  outage is not a closure and pauses nothing.
- Removing the label after the start has no effect.

### The time limit counts working time

A mission's deadline is wall-clock from creation today. It also expires a
paused mission, and resume is refused after it. Requests filed from Slack are
answered hours later as a matter of course, so for missions started by intake
the limit counts only time spent planning or working **(call)**: time waiting on
an owner decision and time paused extend the deadline by the same amount.
Missions started from the apps keep today's rule.

### What intake writes to Linear

Two comments on the source issue, sent through an outbox that saves comment IDs
and reconciles them after a lost response, as the existing Linear bridge does:
one when the mission starts, one with the outcome (result, blocked, or
cancelled). Each is labelled as an Infinite agent report. Comments exclude host
addresses, paths, and raw logs.

Intake does not change the issue's state, assignee, or labels. Comment delivery
never gates the mission **(call)**.

Subteams of an intake mission create no Linear issues of their own, whatever the
repository's Linear mapping says. Today each mission subteam creates an issue
when its repository is mapped, which would scatter agent-created issues through
a team's Linear.

### API

`GET /api/intake` (any role) lists intake records: issue identifier and URL,
state, skip reason, mission ID, and Slack delivery state for each message.

## Part 3: The Slack surface

A Slack app installed in the organization's Slack workspace, connected by
Socket Mode. It is part of the intake service.

### Thread binding

The intake record holds the channel ID and thread root timestamp taken from the
issue's Slack link. Every outbound call takes an intake record, not a channel,
so the surface has no way to post anywhere else. A thread is bound only when
the host read it at admission, or when the owner bound it by mention; a record
never holds a thread the bot could not read.

A thread may collect several intake records over time. A reply that starts
with `Qn` goes to the record that asked question `n`. A reply that starts with
an issue identifier goes to that record. Any other reply goes to the one record
that is not finished. When more than one record in the thread is not finished
and the reply has neither prefix, the host changes nothing and answers with
the open identifiers, so an answer or a `cancel` never lands on the wrong
request. (Amended during implementation; the first draft sent every reply to
the newest unfinished record.)

The bot never posts in a thread that has no bound record, including to explain
itself.

At start the surface calls Slack's identity check and refuses to run unless the
workspace ID equals `intake.slack.teamId`.

### What the bot posts

| When | Message |
| --- | --- |
| Record created | The issue identifier and title, that questions and the result will appear here, and how to reply. Says "queued" when waiting on `maxActive`. |
| An owner decision opens | The question, numbered options when present, and "reply with a mention and your answer". Numbered `Q1`, `Q2` per thread. |
| Mission reaches `ready-for-review` | "Ready for review" or, when every finished subtask ended with no change, "Answer". Then the coordinator's result summary, marked as an agent report, and the links the host recorded: pull requests or published branches. |
| Mission blocked, paused by intake, or cancelled | The status, the recorded reason, and what the owner can do. |

Nothing is posted for progress. Text over about 3,000 characters is split on
line boundaries without cutting a code block.

A request that starts on its first attempt gets one acknowledgement. A request
whose start is refused or fails gets one acknowledgement that carries the
host's fixed reason, and a short "started" line when it later starts. Every
posted text passes a filter that replaces host paths and addresses with a
placeholder. (Amended during implementation.)

In the thread it looks like this:

```
owner     @Linear file this for infinite: export fails on empty rows
Linear    Created WRK-142 "Export fails on empty rows"
Infinite  Started on WRK-142. I'll post questions and the result here.
          Reply with @Infinite to answer or steer.
Infinite  Q1: Should empty rows be skipped or written as blanks?
          1. Skip   2. Write blanks
owner     @Infinite 1
Infinite  Ready for review (agent report): empty rows are now skipped ...
          Pull request: https://github.com/ORG/REPO/pull/0
```

### What the bot listens to

The app subscribes to mentions only. An event is accepted when all hold: the
workspace ID matches, the event is a mention of this app, the author is
`intake.slack.ownerUserId`, the author is not a bot, and the channel and thread
match a bound intake record. Any other event is dropped before anything is
stored; only a count is kept. The one exception is the thread-binding fallback
in "Checks before building Parts 2 and 3", when that fallback is in force.

An accepted mention becomes, in order:

1. `status`, `pause`, `resume`, or `cancel` as the whole message: that mission
   action. `status` replies with the mission status and open questions.
2. An answer, when a decision is open. It goes to the oldest open decision, or
   to `Qn` when the reply starts with it. An option number selects that option.
3. A steer to the coordinator, otherwise. The steer carries the owner's message
   only. Mission steering is capped at twenty entries and 10,000 bytes in
   total, so other people's thread messages are not attached; the owner quotes
   what matters.

A reply to a finished mission is answered with one line: file a follow-up with
Linear's agent in this thread. A bare option number with no open decision is
answered with "that question was already answered".

Answers and steers go through the same mission methods as the HTTP routes and
are recorded as the owner's, with Slack named as the source in the mission
event. The apps remain equal: a question answered on the phone closes it for
Slack as well.

### Observing missions

Missions emit nothing today, and listing them recomputes usage for every
mission. The mission service gains a change notification on save, and the
surface diffs each mission against what it already delivered for that record.

### Changes to missions

Intake and the Slack surface need these changes to the mission service, and no
others:

- A change notification on save.
- An optional source on create, answer, steer, and pause, written into the
  mission event in place of today's fixed text: the issue and admitting rule on
  create, "Slack" on an answer or steer, the closure reason on an intake pause.
- The working-time limit for missions started by intake (Part 2).
- No Linear issues for subteams of an intake mission (Part 2).
- The subteam's final report text in the coordinator's subtask-finished message
  (Part 4).

### Delivery

Inbound: an accepted event is written to sealed state before the Socket Mode
envelope is acknowledged, so Slack's redelivery is the retry. Duplicates are
dropped by envelope and event identity.

Outbound: each message has a deterministic key (mission, kind, decision or
revision). The key travels in the Slack message's metadata. After an uncertain
send, the surface looks for the key in the thread before sending again, and
records the returned timestamp as the receipt. Delivery state is visible through
`GET /api/intake`.

A Slack outage never blocks a mission. Questions remain answerable in the apps.

## Part 4: Answers without code changes, and connectors

A mission can already end successfully when every subtask reports `no-change`.
Two gaps stop that from being useful.

**The coordinator never sees what the subteam found.** The message that tells a
mission coordinator a subtask finished carries only status and reason. It must
also carry the subteam's final report text: the `no-change` summary and
evidence, scout findings, or the result summary, bounded per subtask and marked
as agent claims. The coordinator's `result` summary, up to 8,000 characters, is
then the answer the thread receives.

**Every subtask needs a repository.** A request about mail or chat history has
no natural one. The instance's project includes a small repository for such
work, named by `intake.mission.answerProjectId`, and the coordinator's guidance
prefers it when the request is not about code **(call)**. Cloning a large
repository to read a mailbox would waste time and disk.

Prompt guidance for intake missions tells the coordinator to decide first
whether the request changes code. For an answer-only request it dispatches one
solo subtask whose objective says to change no files and to report the answer
as `no-change` evidence.

### Connectors

Connectors are the MCP servers logged in under the instance's agent account.
A subteam's planner, implementers, scouts, and reviewers already inherit that
account's MCP configuration, so no launch change is needed. The mission
coordinator and the permission reviewer launch with a strict MCP configuration
and stay without connectors; the mission coordinator delegates.

Connectors are granted read scopes only. That limit is enforced by the scopes
chosen at login, not by the host: an agent with a shell can use any token its
account holds.

The delegated-permission scope for the workspace's repositories adds read-only
connector calls made for the accepted objective. Sends, writes, and new
credentials still escalate to the owner. This uses the existing scope text; it
is not a new mechanism.

## Security

- **Who can cause work.** Only the owner, by filing a marked issue and by tagged
  replies. A stolen owner Slack or Linear session is equivalent to the owner.
- **Residual: label added by someone else.** A teammate who adds the label to an
  issue the owner created through Slack would start a mission on it. The owner
  accepted being the creator as sufficient.
- **Untrusted text.** Other people's thread messages never reach the objective.
  Issue edits, mail, and chat history read through a connector can still
  contain instructions aimed at agents. Mitigations: the
  objective framing, read-only connector scopes, no agent write path to Slack,
  permission escalation for sends and new credentials, and the instance
  boundary. None of these is a proof against a determined injection.
- **Posting scope.** The bot can post only into bound threads, and only
  host-authored templates plus the coordinator's reported text.
- **Secrets.** The Slack tokens allow reading history in channels the bot was
  invited to. They are held like the Linear key and never passed to agents.

## What the owner supplies at commissioning

- A Slack admin's approval of the app in the organization's workspace, and the
  bot invited to the channels where it is used.
- The owner's personal Linear API key in that workspace, the team IDs, the
  owner's Linear user ID, and the label.
- A GitHub App installation on the organization, limited to the repositories
  the instance works on, with its credential held only by the new instance.
- Test issues filed through Linear's Slack agent, for the checks below: one by
  the owner, and two from a teammate's Slack accounts.
- Approval of the new instance's team command launcher.
- Provider logins for the new agent account, and the list of providers and
  models allowed to see the organization's code.
- Connector logins with read scopes.

## Checks before building Parts 2 and 3

Three facts decide field names and three fallbacks. They need the
organization's Slack and Linear, so the owner files the test issue and supplies
the Linear key, and the coordinator reads the results. Record them privately,
outside this repository. Each outcome has a defined path:

1. File one issue through Linear's Slack agent and read it through the API.
   Note which field holds the creator (a person, or an app acting for one) and
   how the Slack thread link is represented.
   - If Linear attributes such issues to an app rather than to the owner,
     intake skips them (`creator-mismatch`) and admits nothing filed that way.
     Check 3 is never dropped: a thread check alone cannot tie the owner's
     mention to one issue, so a teammate's issue that links the same thread
     would pass. An attribution rule is designed from what Linear actually
     records before intake is used in that workspace. (Amended during
     implementation; the first draft dropped check 3 in this case.)
   - One issue filed by the owner cannot show whom Linear names when someone
     else files. Also file one issue through Linear's Slack agent from a
     teammate's Slack account that has a linked Linear account, and one from a
     Slack account with no Linear account, in a thread where the owner
     mentioned Linear's agent earlier. Intake is enabled only when neither
     issue reports the owner as its creator. If either does, a teammate's
     request would pass checks 3 and 4, and an attribution rule is designed
     first. (Added during implementation.)
   - If the API exposes no thread link, a thread is bound when the owner
     mentions the bot in it with the identifier of an admitted issue that has
     no thread yet. Until then the outcome goes to Linear and the apps, and
     `requireSlackThread` cannot be used.
2. Add a top-level comment to that issue and see whether it appears in the
   Slack thread. If it does, the bot's Slack post is the outcome for issues
   with a bound thread and intake skips their Linear outcome comment, so the
   thread never shows the result twice.
3. Run a Codex team member against a remote MCP connector under its sandbox. If
   it cannot reach the connector, the instance's lineup assigns Claude Code to
   the subteam planner and scout roles, which do answer-only work. That is a
   config choice for the whole instance; no per-subtask lineup is built.

## Testing

Loopback fakes stand in for Linear and Slack, allowed only when the host
environment is `local`, as the Linear endpoint override is today.

- Authorization: a teammate's labelled issue is skipped; an unlabelled owner
  issue is ignored; a teammate's mention in a bound thread stores nothing; a
  mention from another workspace is dropped; an owner mention in an unbound
  thread gets no reply and stores nothing.
- Idempotency: a restart between "seen" and "created" yields one mission; a
  redelivered envelope yields one answer; a lost send response yields one
  message.
- State: answer versus steer routing; `Qn` addressing; replies to a finished
  mission; `queued` to `started` under `maxActive`, with a waiting mission
  holding no slot; pause on a closed issue and no pause on a Linear outage; a
  mission that waits on the owner past its original deadline still resumes.
- Answer-only: a mission with one `no-change` subtask produces a result that
  contains the subteam's evidence, and the thread shows "Answer".
- No duplicates in Linear: subteams of an intake mission create no issues.
- Launch gate: with an injected host reading below the memory floor or above
  the load ceiling, automatic launches wait with a visible reason, owner-started
  sessions still start, and waiting launches proceed when the reading recovers.

The host acceptance list in Part 1 covers the instance boundary.

## Build order

1. The instance: templates, the sudoers fix, the launch gate, commissioning,
   host acceptance. Useful on its own from the apps and CLI.
2. Intake from Linear, with outcome comments. Works without Slack.
3. The Slack surface.
4. Subteam findings to the coordinator, and the answer-only guidance. Can run
   alongside 3.

## Left to the builder

Module and file layout; the sealed record format; how templates are rendered;
exact Slack scopes once check 1 is recorded; message wording; how the thread
link is parsed; bounds on thread background in the objective; fixture design.
