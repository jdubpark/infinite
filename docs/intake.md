# Request intake

Intake starts a mission from a qualifying Linear issue or the owner's request in
Slack. The owner can mention the bot or post in a configured
[request channel](#slack-request-channels). It runs only when the
host config has an `intake` block. Without one, no records are kept and
`GET /api/intake` returns `{ "records": [] }`, with no `lastError` or `slack` member.

An authenticated external assistant can also submit requests through the
[MCP connector](mcp.md). It reuses this queue and Linear tracking with explicit
connector provenance and a separate project allowlist.

## What starts a mission

The host polls Linear every 30 seconds. An issue qualifies when it:

- is in one of `intake.linear.teamIds`;
- has the label `intake.linear.label`, matched without case;
- is not archived, and its state is neither completed nor cancelled;
- was created after the host first enabled intake.

One cycle reads at most 2,000 issues, in pages of 40. The page size keeps each
query under Linear's 10,000-point limit for a single query, which a page of 200
issues exceeded. When more remain, the issues read
are still admitted, and `lastError` reads
`More labelled issues than one intake cycle reads.`

Each qualifying issue is then checked again, field by field, before a record is
kept:

| Check | Skip reason when it fails |
|---|---|
| The issue's creator is `intake.linear.creatorId`, the owner's Linear user ID. | `creator-mismatch` |
| With `requireSlackThread`, the issue has a Slack message link among its attachments. | `no-slack-thread` |
| The Slack thread can be read. An unreadable thread is retried for one hour after the issue was created. | `thread-unreadable` |
| A message from the owner in that thread mentions Linear's agent (`linearAgentUserId`) and is timestamped before the issue was filed. | `no-owner-mention` |

A skipped issue keeps a record with its identifier, URL, times, and skip reason.
It keeps no title, no description, and no thread, so it never binds a thread.
Only the owner's Linear user ID causes work. The first two
checks apply to every issue. The Slack checks apply only when
`requireSlackThread` is on, which is the default.

Without `requireSlackThread`, a linked Slack thread is still read when present.
A failed or unreadable read starts the mission without a thread section and
binds no thread, and nothing waits or retries.

The objective is the Linear title, the description (up to 12,000 characters), a
fixed note that only the owner's words are instructions, and only the owner's own
messages from the linked Slack thread, under `Slack thread (the owner's messages):`.
The thread is read once, at admission. Messages from anyone else, and bot
messages, are read at admission to check authorship and are not stored, shown to
agents, or logged. The owner's messages are kept oldest first, each trimmed, and
empty ones are dropped. The thread section is cut to fit the 24,000-character
objective limit: the owner's first message stays, the oldest of the rest go first,
and one line counts how many were omitted. See
[security](security.md#request-intake). The mission title is the issue
identifier and title, up to 100 characters.

Admission saves the request before the mission starts and reuses it on every
retry, so a retry cannot create a second mission for the same issue.

Starts are limited by `intake.maxActive`. A record over the limit stays `queued`
with the hold reason `max-active`. A refusal from the mission service is kept as
the hold reason too. A failed start is retried on a later cycle.

## Slack request channels

A request channel gives developers and users one thread for a proposal, the
owner's decision to take it on, questions from the swarm, and the result.
An ordinary top-level message from the configured owner can file a Linear
issue and start work. Choose who can interact with the bot.

- **One member across joined channels.** Enable `intake.slack.directRequests`
  and `intake.slack.ownerOnlyInJoinedChannels`. The member identified by
  `intake.slack.ownerUserId` can ask, start work, steer, and request status
  in any public or private channel the bot joins. Only that member can
  trigger a reply, including by mentioning the bot. Proposal reactions apply
  only to the shared proposal policy below. The one-member policy
  also applies to any listed request channels. Channel members can read the
  resulting thread.
- **Shared proposals in dedicated channels.** Set `intake.slack.requestChannelIds`
  and enable `directRequests`. Teammates in those channels can propose work
  and ask for status. The owner decides which proposals to take on.

| In a shared proposal channel | What happens |
| --- | --- |
| A teammate opens a thread with “The export skips empty rows.” | The bot adds 👀 to acknowledge the proposal. The proposal stays in Slack until the owner takes it on. |
| The owner replies `work: Include empty rows in the CSV export.` | Infinite files the owner's instructions in Linear and starts or queues the mission. Earlier thread messages supply attributed background. |
| The owner opens a thread with `ask: Why does the export skip those rows?` | With `answerQuestions` enabled, a read-only coordinator answers in the thread. |
| A participant replies `status` to a bound thread | The host reports the state of work in that thread. Teammates see subtask counts and how many decisions are open. |
| The bot asks which output to use | The owner can reply `Q1 JSON` or choose an option on the question. A receipt confirms the saved answer. |

The thread gets a progress update when the swarm first dispatches subtasks.
The coordinator's working notes, worker conversations and tool output stay on
the host. Decisions and the agent's result use the existing Slack outbox,
including its recovery after a restart or a lost send response. After a request
finishes, mention the bot to start another request in that thread.

Slack timestamps determine which ordinary replies count. The owner's request
opens a direct conversation. For a request filed through Linear, the first
confirmed bot post opens it. An answer must also follow the question in Slack.
A delayed message written earlier cannot answer a new question or control a
later request that shares the thread.

Invite the bot to each channel. Subscribe to `message.channels` for public
channels and `message.groups` for private channels, and keep `app_mention`
for explicit requests. Shared proposal acknowledgements also need the
`reactions:write` scope. See the [Slack app setup](../deploy/ubuntu/instances.md#slack-app-and-read-only-connectors).

This follows Vercel Board's practice of keeping the human conversation in one
thread and publishing selected updates. Infinite binds a request to its Slack
channel and root timestamp. A retry of the owner's message reaches that same
request. An explicit follow-up after it finishes can start a fresh mission in
the same thread.

The coordinator delegates through Infinite's mission service. Subteams need
only their assigned repository access. The host holds the Slack credential,
publishes recorded progress, and labels the coordinator's final account as an
agent report. Answering a mission question uses the decision attached to that
thread. Provider permissions and repository delivery follow their existing
controls. [Agents in Slack](https://vercel.com/docs/board/guides/agents-in-slack)
and [Building an Agent Swarm](https://vercel.com/docs/board/guides/agent-swarm).

## Direct requests

With `intake.slack.directRequests` on, the owner can start work by mentioning the
instance's own Slack bot. The host files the Linear issue itself and starts the
mission. The owner does not file anything through Linear's Slack agent.

The default trigger is an `app_mention` from `slack.ownerUserId` in the
configured workspace. [Request channels](#slack-request-channels) also accept
ordinary messages from that owner. For a mention:

- In a thread with no record, `bindByMention` is tried first, as before. If it
  binds nothing, the mention files a request.
- A mention in a top-level message with no text after the bot mention is dropped
  and counted. The same mention as a reply inside a thread files a request, because
  the thread supplies the context.
- In a thread where every record has finished, a mention files a follow-up request,
  unless it starts with `Q<n>`, with a record's identifier, or is only `status`,
  `pause`, `resume`, or `cancel`. Those keep the routing described under
  [a thread with more than one request](#a-thread-with-more-than-one-request).
- In a thread with an unfinished record, the mention is a reply, as before.
- A second event for a mention that already filed a request, by event ID or
  message timestamp, is dropped with no write and no reply.

The thread is bound when the record is created, by the owner's request, so every
message the bot posts still goes to `record.thread`.

**Title and description.** The title is the first non-empty line of the owner's
text with whitespace collapsed, cut to 120 characters. With no text it is
`Request from a Slack thread`. The description is the owner's text, trimmed, up to
12,000 characters, followed by `Filed from Slack by the owner: LINK` when Slack
returns a permalink. The issue gets the label `intake.linear.label`. Only the
owner's words go into the issue.

**Team.** The issue is filed in the first entry of `linear.teamIds`. The host
checks that the issue's creator is `linear.creatorId` and that its team is the one
requested. A mismatch stops the request with the hold reason below.

**Exactly one issue.** The record is saved before Linear is called, and the issue
is created under the record's own ID. A retry after a failure, a lost response, a
restart, or a redelivered Slack event reaches the same issue and the same mission.

**The thread section.** The objective starts with `Request filed from Slack as ID:
TITLE`, the owner's text, and the note that only the owner's words are
instructions. It ends with the Slack thread up to the owner's request, oldest
first, under `Slack thread, oldest first, as it stood when the owner asked:`. The
host reads the thread when it files the request, and again if filing is retried, so
a message edited before the read appears with its edited text.
The host keeps messages whose timestamp is at or before the mention and discards
later ones before anything is stored, passed to an agent, shown, or logged. Every line of
every message carries its author:

| Marker | Author |
|---|---|
| `owner \| ` | `slack.ownerUserId` |
| `other N \| ` | Anyone else. `N` counts distinct people from 1, in order of first appearance. |
| `bot \| ` | A bot, or a message with no user. |

Before marking, every line-break character in a message (`\r\n`, `\r`, U+000B,
U+000C, U+0085, U+2028, U+2029) becomes `\n`, and empty lines are dropped. A line
forged inside another person's message therefore still starts with that person's
marker. Each message is cut at 4,000 characters, and a marked cut line,
`[… message cut]`, follows a message that was cut; the notice is in addition to
the 4,000. The section is bounded by the 24,000-character objective limit
in the way the linked-thread section is. An unreadable thread files the request
without a thread section. See [security](security.md#request-intake).

**If filing fails.** The record stays `queued` with no mission and the hold reason
`It could not be filed in Linear and will be retried: SUMMARY`. The next cycle
tries again. The bot posts `Received your request "TITLE". It has not started:
REASON`, then `I'll post questions and the result here once it starts.` Once it is
filed and started, the acknowledgement is `Started on ID "TITLE" (URL). I'll post
questions and the result here.` and a `Started on ID (URL).` line follows when the
first message was a notice.

**No acknowledgement without a save.** A request whose first save fails is not
acknowledged to Slack, so Slack redelivers it. The failure is logged and counted as
dropped, and nothing is posted.

**What the tracker receives.** For a direct request the Linear issue holds only the
owner's text and the Slack link, and the outcome comment is a fixed receipt:
`Infinite agent report: ready for review. The report is in the Slack thread this request came from.`,
or the same with `blocked. The reason is` or `cancelled. The reason is`. Agent
reports and questions go to the Slack thread only. Reports posted in the thread may
restate thread content, and pull requests the agents open are written by the
agents; both are residual risks. See [security](security.md#request-intake).

**Linear's own issues.** With `linear.admitIssues` set to `false`, the host does
not poll Linear for labelled issues, and only direct requests start work.

## Questions

With `intake.slack.answerQuestions` on, the owner's Slack request can be a question. A
question is answered in the thread by a read-only mission. It files no Linear
issue, starts no subteam, and changes nothing. A mention that asks for a change
keeps the route described under [direct requests](#direct-requests). The setting
needs `slack.directRequests`.

**How the route is chosen.** The host decides once per request, in the intake
cycle (never in the Slack event handler), in this order:

1. The owner's word. A mention that starts with `ask:` or `work:`, in any case, with
   optional spaces around the colon, takes that route. The word is removed from the
   title, the description, and the objective. The route is stored at once, with
   `by: "owner"`.
2. A reading, when `slack.classify` is on. The reading service returns `answer` or
   `work` with a confidence. The request goes to work only when the reading is
   `work` at 0.6 or higher; every other reading is an answer. The route is stored
   with `by: "model"` and the confidence.
3. Otherwise `work`, with `by: "default"`. This covers `classify` off, a reading
   service that is not configured, an error, and a reading that takes longer than
   six seconds.

Routing eligibility is fixed when the mention is saved: a record saved with
`answerQuestions` on carries `routable`, and only such a record is routed or read
by the reading service. A request saved before the setting was on, including one
whose Linear filing was still pending, stays work and follows the original filing
and reconciliation path. A marked request whose route was not yet stored when the setting is turned
off goes to work in the next cycle and is filed; a route already stored is kept.

The stored route (`kind`, `by`, `confidence`, `at`) is on each record in
`GET /api/intake`, without the request's text. A record made before this feature,
or with `answerQuestions` off, has no route and is work. The owner's word always
wins over a reading, and a slow or failed reading never holds a request: it goes to
work in the same cycle.

**What an answer is.** The mission starts in answer mode: its coordinator reads the
project group's repositories, may ask the owner a question, and reports its answer
as a `result` through its report tool. It cannot start subtasks; the mission refuses
a dispatch. The coordinator's model is the mission lineup's coordinator, as for any
mission. The mission is titled `Question: TITLE`, cut to 100 characters, with
`maxSubtasks` 1 and a working-time limit of the smaller of `mission.maxMinutes` and
30. The objective starts `Question asked from Slack: TITLE`, then the owner's text,
the note that only the owner's words are instructions, and the same marked thread
section as a request. The admission rule records whether the owner mentioned the bot or sent an ordinary request-channel message.

**What an answer is not.** It has no issue, so its record keeps an empty
identifier and URL. Intake makes no Linear request for it: no issue, no comment,
and no state read. It does not count toward `maxActive` and is never held by it.
It is not a claim that anything was done: the host never infers completion, so the
answer exists only because the coordinator reported it, and it is posted labelled
as an agent report.

**What the thread shows.**

- When the mission starts: `Answering this from the repositories, read-only. No issue was filed.`
- The result: `Answer (agent report):`, the answer, a blank line, then
  `No issue was filed. To start work, mention me with the change you want, or begin with "work:".`
- A blocked or cancelled answer uses the usual `Blocked:` and `Cancelled:` text.
  Where a request's notices name its identifier, an answer's name `your question "TITLE"`.
- A request routed to work without the owner's word, by a reading or by the
  default, adds a correction line to its acknowledgement. Once started:
  `I took this as a request for a change. If you only wanted an answer, reply with a mention and "cancel", then mention me again starting with "ask:".`
  While it waits for a slot, or for any other reason has no mission yet, the
  line says `"cancel" once it starts` instead, because `cancel` on a request with
  no mission answers `This request has not started yet.` A mention that starts
  with `ask:` in a thread with an unfinished request is a reply to that request,
  not a new question; the cancel step is what lets the new mention route again.
  A request the owner sent with `work:` gets no such line.

`status`, `pause`, `resume`, `cancel`, `Q<n>` answers, and plain-text steering work
on a running answer as they do on a request. When another unfinished
request shares the thread, the answer has no identifier, so start the reply with
`answer` (for example `answer cancel`); the ambiguity reply lists it as
`answer (your question "TITLE")`. In a thread where every record has
finished, a new mention is routed again, so a follow-up can become an answer or
work; the new mission's thread section carries the earlier question and answer.

## Configuration

The `intake` block is validated by `intakeConfigSchema` in
`packages/host/src/intake-types.ts`. Unknown fields are refused.

| Field | Type and default | Meaning |
|---|---|---|
| `linear.teamIds` | UUIDs, 1 to 20, required | Linear teams whose issues qualify. |
| `linear.creatorId` | UUID, required | The owner's Linear user ID. Issues from any other creator are skipped. |
| `linear.label` | text, 1 to 80 characters, required | The label that marks an issue for intake. |
| `linear.admitIssues` | boolean, default `true` | When `false`, labelled issues in Linear start nothing and only direct requests start work. Needs `slack.directRequests`. |
| `linear.commentsMirrorToSlack` | boolean, default `false` | When `true` and a thread is bound, the two Linear comments are not posted; the Slack thread carries the same messages. Refused without `slack`. |
| `slack` | object, optional | The Slack surface. Without it, the bot posts nothing, receives no replies, and no thread is read or bound. |
| `slack.appTokenFile` | absolute path, required with `slack` | The Socket Mode app token. A nonempty regular `0600` file outside `stateDir`, `runDir`, `teams.workspaceDir`, and every project path. |
| `slack.botTokenFile` | absolute path, required with `slack` | The bot token. The same file rules as `appTokenFile`. |
| `slack.teamId` | `T` followed by 2 to 20 uppercase letters or digits, required with `slack` | The workspace. A token for another workspace, or a token Slack refuses, stops the surface with a reason. |
| `slack.ownerUserId` | `U` or `W` ID, required with `slack` | The only Slack user whose messages cause work. |
| `slack.linearAgentUserId` | `U` or `W` ID, optional; required when `requireSlackThread` is on, unless `linear.admitIssues` is `false` | Linear's agent user in Slack, mentioned by the owner to file a request. |
| `slack.directRequests` | boolean, default `false` | Lets the owner's mention of the bot file a Linear issue and start a mission. See [direct requests](#direct-requests). |
| `slack.requestChannelIds` | up to 20 unique public or private channel IDs, optional | Enables proposals, untagged owner requests and replies, and thread-local status in these channels. A nonempty list requires `directRequests`. |
| `slack.ownerOnlyInJoinedChannels` | boolean, optional | Accepts requests only from `ownerUserId` in every joined public or private channel. Takes precedence over `requestChannelIds` and requires `directRequests`. |
| `slack.answerQuestions` | boolean, default `false` | Lets the owner's mention be a question that a read-only mission answers in the thread. Needs `slack.directRequests`. See [questions](#questions). |
| `slack.classify` | boolean, default `false` | Lets the reading service choose the route when the mention has no `ask:` or `work:`. Needs `slack.answerQuestions` and the top-level `jev` block. An instance that wants only the route reading sets `jev.sessionReadings` to `false`. |
| `slack.bindByMention` | boolean, default `false` | Binds a thread by a mention of an identifier. Cannot be used with `requireSlackThread`. |
| `slack.organizationScope` | object, required with `slack` | Fail-closed channel and workspace isolation boundary (`#304`): optional `channelIds` allowlist (an empty list denies all; omission allows every otherwise verified internal channel) plus a required non-empty `workspaces` array pinning each checkout's canonical `path` and GitHub `repository` (or `null` with `rootCommit`). Re-verified live via Slack `conversations.info` (rejects IMs, MPIMs, shared/external/org-shared channels, and non-member channels) and exact 1:1 `mission.groupId` checkout checks before accepting events, reading threads, starting missions, or posting replies. Slack has no unscoped mode or compatibility flag. See [secondary instances](../deploy/ubuntu/instances.md). |
| `slack.endpoint` | URL, optional | The Slack Web API base. Only the official HTTPS endpoint, or loopback HTTP when `environment` is `"local"`. |
| `mission.groupId` | project group ID, required | The group new missions start in. A host project ID works as an alias. |
| `mission.maxSubtasks` | integer 1 to 12, default `8` | The subtask limit for each mission. |
| `mission.maxMinutes` | integer 5 to 1440, default `240` | The working-time limit for each mission. See [missions](missions.md#working-time-limit). |
| `mission.answerProjectId` | project ID, optional | A configured project. When the mission's repositories include it, the coordinator is told to answer from it. Must name a configured project. |
| `maxActive` | integer 1 to 12, default `3` | Missions intake may have running at once. |
| `requireSlackThread` | boolean, default `true` | Requires a Slack thread and an owner mention before admission. Needs `slack`, and `slack.linearAgentUserId` unless `linear.admitIssues` is `false`. |

Linear credentials are a separate block, `linear.apiKeyFile`, a `0600` file with
the same location rules. Linear's endpoint must be its official HTTPS endpoint,
or loopback HTTP when `environment` is `"local"`.

### Thread binding without a Slack block

A record is bound to a Slack thread in one of two ways: the host read that thread
successfully at admission, or the owner bound it with a mention when
`bindByMention` is on. A linked thread that was not read, because the read failed
or Slack refused it, is not bound, and the record's comments go to Linear.

Every Slack-enabled host must pin a nonempty workspace audience. Each admitted
record keeps an immutable digest of its Slack workspace, owner, configured
mission group, workspace pins, and channel policy. Before reading, publishing,
binding, replaying, or acting on a record, the host checks that digest and the
linked mission's group and repository IDs against the current audience. When
the audience changes, older records that cannot be proven stay sealed as audit
evidence, are omitted from runtime intake views, and receive no automatic
migration or inferred audience. Hosts without a Slack block continue to use
Linear intake independently, and their `/api/intake/workspace-scope` state is
`unconfigured`.

On a Slack-enabled host, both ends of a cross-project context link must be
pinned. Excluded links contribute no text or relationship to new sessions,
including links between two unlisted projects because no shared enrollment is
proven; hosts without Slack continue to use explicit owner-granted links.

Without an `intake.slack` block, no thread is read or bound, so every record's
comments go to Linear. `linear.commentsMirrorToSlack` without a Slack block is
refused at startup.

## What the bot posts

Every Slack message is posted into the thread a record is bound to. Nothing is
posted to a channel taken from an inbound event. Messages are posted in this
order as the mission moves:

- an acknowledgement when the mission starts, or a queued notice while it waits
  for a running request to finish;
- in a request channel, a single update about the first dispatch of subtasks;
- for a request whose start was refused, one notice with the hold reason:
  `Received ID "TITLE". It has not started: REASON`, then
  `I'll post questions and the result here once it starts.` A later change of the
  hold reason posts nothing. When a queued or held request starts, `Started on ID.`
  follows;
- a numbered question for each mission decision, with each option on its own line. New questions also include controls
  when the decision has choices: approvals have Approve and Deny, single-choice decisions use buttons or a menu, and
  multiple-choice decisions use a multi-select with an explicit Submit button. The choices remain readable in the
  message text. Multi-select changes do not answer the question until Submit is pressed;
- a status note when the mission is paused, but only when the record has a
  `closure`, which is set when the Linear issue is deleted, archived, cancelled,
  or closed. The note says why and asks for `resume` or `cancel`. A pause with no
  closure posts nothing;
- the result: `Answer (agent report):` for an answer-only request, and
  `Ready for review (agent report):` otherwise, followed by pull request and
  branch lines when a subteam published one;
- `Blocked: REASON` or `Cancelled: REASON` when the mission ends that way, then
  `File a follow-up with Linear's agent in this thread.` With direct requests on,
  this line and the reply to a finished request say
  `Mention me in this thread to file a follow-up.` instead;
- an edit note when the Linear issue changes after the run started. The run keeps
  the original text. For a request the host files itself, an edit is detected
  against the text the tracker returned at filing, because the tracker may
  reformat links.

Text leaves the host only after a filter. A `file://` URL, and a path that starts
with a configured directory (`stateDir`, `runDir`, `teams.workspaceDir`, or a
project path), a host root (`/srv/`, `/opt/`, `/run/`, `/etc/`, `/Users/`, `/home/`,
`/tmp/`, `/private/tmp/`, `/private/var/`, `/var/folders/`), `~/`, or a Windows drive
such as `C:\`, becomes `[local path omitted]` when it is at the start of the text
or after any character other than a letter, a digit, or one of `. _ ~ % / -`, so
links and branch names keep their paths. Repeated slashes and `./` segments do not
hide a path; a path ends at whitespace, a quote, a backtick, or an angle bracket,
and a trailing run of `) ] , ; : . ! ?` stays in the text. Then every IPv4 literal
becomes `[address omitted]`, which also hides four-part version numbers. The filter
applies to every Slack message and every Linear comment.

Messages use Slack's Markdown blocks to render paragraphs, lists, emphasis,
links, and code, with a text fallback for notifications and accessibility.
Text longer than 3,000 characters is split across messages. Code fences are kept
whole where the split allows it. Each message has a key, and a message whose
last send may have reached Slack is looked up in the thread before it is sent
again. A permanent Slack error marks the message `failed`. A transient error is
retried after 5 seconds, 30 seconds, and 2 minutes, then every 10 minutes. A
message that is still unsent 24 hours after it was created is marked `failed`.
Past 400 messages a record drops only the bot's oldest sent or failed replies, and
past 200 received replies only the oldest applied ones, so nothing still to be
sent or applied is lost.

The configured owner can direct a bound mission with an `app_mention` in the
configured workspace, or an ordinary reply in a request channel. In a reply:

- `status` lists the mission status and its open questions;
- `pause`, `resume`, and `cancel` act on the mission;
- `extend`, `extend 6h`, or `extend 90m` gives a mission stopped at its time limit
  more working time. See [time limit stop](#time-limit-stop);
- `Q<n>` followed by an answer answers that question; an option number is
  accepted as the answer;
- an unnumbered reply answers the oldest open question;
- with no open question, any other text is a steer to the coordinator.

After an answer is saved by the mission, the bot posts `Received your answer to
Q<n>.` in the same thread. This confirms receipt, not completed work or a resumed
mission. The receipt uses the same durable delivery and duplicate protection as
other bot replies, including after a restart or a lost Slack response.

Deny and `None of these` leave the decision open and ask `What would you prefer
instead? Reply with a mention and Q<n> followed by your alternative.` The
alternative is then handled as the owner's ordinary tagged reply. Controls are
bound to the recorded question message, owner, workspace, channel, thread, and
current open decision; stale or mismatched callbacks are ignored. Existing
questions are not edited when controls are introduced.

### Time limit stop

When a mission reaches its approved time limit, it stops. It is not finished: its
subteams are paused, their work is kept, and the record stays started, so replies
still reach the mission. The thread gets:

```text
Stopped at its time limit: REASON
Reply with a mention and `extend` (or `extend 6h`) to give it more time, or `cancel`.
```

A reply of `extend` alone adds the mission's `maxMinutes`, up to 1440 minutes.
`extend N` adds N hours. `extend N` with a unit adds N minutes (`m`, `min`, `mins`,
`minute`, `minutes`) or N hours (`h`, `hr`, `hrs`, `hour`, `hours`). The amount
must be from 5 to 1440 minutes. Any other `extend` followed by a number gets the
help line, `Extend by 5 minutes to 24 hours, for example `extend 6h` or `extend 90m`.`,
and changes nothing. A reply that starts with `extend` and then a word, such as
"extend the API to cover CSV exports", is steering.

After an extension, the thread gets `Extended by 6 hours. The mission now stops at
2026-11-15 12:00 UTC.`, with the new stop time in UTC. A refusal is posted as its
message. A later stop, after an extension, is announced again.

If the mission is cancelled or finishes while it is stopped, the record finishes as
usual and the thread gets the matching result or cancellation line.

### A thread with more than one request

Several records can share one thread, for example when the owner files a follow-up
in the thread of a running request. Each reply goes to one record, by these rules
in order:

1. A second event for a message already received, by its event ID or its message
   timestamp, is dropped with no reply.
2. A reply that starts with `Q<n>` goes to the request that asked that question.
   If no request in the thread asked it, the reply is `There is no question Q<n>.`
3. A reply that starts with a request's identifier, followed by a space, `:`, `,`,
   or nothing, goes to that request, with the identifier removed. Any request in
   the thread can be named, finished or not.
4. Otherwise, with one unfinished request in the thread, the reply goes to it. With
   none, it goes to the newest finished request, except that with direct requests
   on, a mention that starts with neither `Q<n>` nor an identifier, and is not
   exactly `status`, `pause`, `resume`, `cancel`, or an `extend` command, files a
   follow-up request instead.
5. With more than one unfinished request, nothing is applied to any mission, and
   the bot replies:
   `More than one request is open in this thread: ID1, ID2. Start your reply with an identifier or a question number.`
   This holds for `status`, `pause`, `resume`, `cancel`, `extend`, and any other text.

The bot never approves a provider permission, never infers completion, and never
changes a Linear issue's state, assignee, or labels. Replies are applied once,
and a saved call is replayed exactly on retry. A redelivered event adds nothing and
gets no reply, but a reply its record has not yet applied, for example after a
failed write, is applied then.

Delivery never gates a mission. An outage of Slack or Linear pauses nothing.

## Linear comments

Intake writes two comments on the Linear issue, both labelled as agent reports.
They begin with `Infinite` by default; set `linear.reportName` (1 to 40 characters: an ASCII letter first, then
ASCII letters, digits, spaces, or hyphens) to use another name:

1. When the mission starts: `Infinite agent report: a mission started on this issue. Questions and the result will follow.`
2. When the mission ends: `Infinite agent report: ready for review.` with the
   coordinator's result summary, or `Infinite agent report: blocked.` or
   `Infinite agent report: cancelled.` with the reason.

A stop at the time limit is not an end. A record whose comments go to Linear, not
to Slack, gets one
`Infinite agent report: blocked.` comment for each stop, and a stop after an
extension posts one more. The record stays started until the mission really ends.
If an earlier stop's comment is not delivered yet when a later stop or the finish
is recorded, the newer comment replaces it, so Linear shows the latest state.

Each comment's ID is saved with the record before the write, and a retry reuses
it, so a lost response does not post a second comment. With
`commentsMirrorToSlack` on and a bound thread, neither comment is written.

## API

`GET /api/intake` returns:

- `records`: one view per admitted or skipped issue, with its identifier, state
  (`queued`, `started`, `finished`, or `skipped`), skip or hold reason, mission
  ID, comment states, and message states. The view leaves out the description,
  the objective, and the Slack message text.
- `lastError`: the newest failure of any intake step, as `{ at, step, message }`.
  Present only when there is one.
- `slack`: the Slack surface's status, `{ connected, reason?, dropped, lastError? }`.
  Present only when `intake.slack` is configured. `dropped` counts inbound events
  that were refused, and `reason` says why the surface is not connected.

`GET /api/intake/workspace-scope` (owner-only) returns HTTP 200 with `{ "state": "verified" | "blocked" | "unconfigured" }`. Slack-enabled hosts check `intake.mission.groupId` against the required workspace pins (plus `answerProjectId`); a host without Slack reports `unconfigured`. It checks only local checkout/workspace binding—it does not call Slack `conversations.info`, does not return mismatch details, and does not return `403` when `"blocked"`.

Separately, live Slack channel and membership verification (`conversations.info`, rejecting IMs, MPIMs, shared/external/org-shared channels, non-allowlisted channels, and channels the bot has not joined, alongside `workspacesAllowed()`) runs during Slack event handling, thread reads, replies, and again before a queued thread-bound request files or starts a mission (`IntakeService.startQueued()` calls `requireOrganizationSource(record.thread)`, placing a queued request on hold if bot channel membership was lost). When starting a mission, the internal mission creator also enforces `organizationScope` checkout bounds and throws an internal `TeamError` (`403 intake-audience-denied`) on mismatch, which the intake queue catches to place the queued request on hold rather than returning an HTTP 403 directly to the Slack requester.

Both surfaces summarise an unexpected error as its name and code, and write the
full error to the host log. Failures with fixed text, a mission refusal, a Slack
request failure, and a Linear request failure, keep that text. See [security](security.md#request-intake).

## Operational rollout checks

Three configuration choices govern how intake behaves against a given Linear and
Slack workspace:

1. **Linear attribution.** If Linear records issues filed through its Slack agent
   as created by an app rather than by the owner, intake skips them with
   `creator-mismatch`, and they stay skipped until an attribution rule is designed
   from what Linear actually records. If Linear's API exposes no Slack thread link
   on those issues, `bindByMention` is the fallback, and `requireSlackThread` cannot
   be used with it.
2. **Comment mirroring.** `commentsMirrorToSlack` decides whether Linear gets its
   two comments or the bound Slack thread carries the mission's messages alone.
   It defaults to `false`, which keeps the Linear comments.
3. **Connector lineup.** Work that needs an external connector runs on the lineup
   chosen for it in `teams.lineup`. Intake does not select a lineup; it passes the
   request to the mission service unchanged.

## Related

- [Missions](missions.md) for the coordinator, subteams, and the report tools.
- [Security](security.md) for who can cause work and how tokens are handled.
- [Hosting](hosting.md) for the launch gate and the second instance.
