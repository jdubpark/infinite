# Request intake

Intake starts a mission from a Linear issue the owner files. It runs only when the
host config has an `intake` block. Without one, no records are kept and
`GET /api/intake` returns `{ "records": [] }`, with no `lastError` or `slack` member.

## What starts a mission

The host polls Linear every 30 seconds. An issue qualifies when it:

- is in one of `intake.linear.teamIds`;
- has the label `intake.linear.label`, matched without case;
- is not archived, and its state is neither completed nor cancelled;
- was created after the host first enabled intake.

One cycle reads at most 10 pages of 200 issues. When more remain, the issues read
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

Without `requireSlackThread`, a Slack thread link is read in the background
when present. A failed or unreadable read starts the mission without a thread
section and binds no thread, and nothing waits or retries.

The objective is the Linear title, the description (up to 12,000 characters), a
fixed note that only the owner's words are instructions, and the Slack thread as
background. The thread is read once, at admission. The host labels every line of
every message `[owner]` or `[other]`, so a line of someone else's message can never
read as an owner line. Blank lines are dropped. Other people's messages are kept
in the objective, and bot messages are left out. The coordinator is told that this
text is information, not instructions. The thread is cut to fit the
24,000-character objective limit; the oldest lines go first. See
[security](security.md#request-intake). The mission title is the issue
identifier and title, up to 100 characters.

Admission saves the request before the mission starts and reuses it on every
retry, so a retry cannot create a second mission for the same issue.

Starts are limited by `intake.maxActive`. A record over the limit stays `queued`
with the hold reason `max-active`. A refusal from the mission service is kept as
the hold reason too. A failed start is retried on a later cycle.

## Configuration

The `intake` block is validated by `intakeConfigSchema` in
`packages/host/src/intake-types.ts`. Unknown fields are refused.

| Field | Type and default | Meaning |
|---|---|---|
| `linear.teamIds` | UUIDs, 1 to 20, required | Linear teams whose issues qualify. |
| `linear.creatorId` | UUID, required | The owner's Linear user ID. Issues from any other creator are skipped. |
| `linear.label` | text, 1 to 80 characters, required | The label that marks an issue for intake. |
| `linear.commentsMirrorToSlack` | boolean, default `false` | When `true` and a thread is bound, the two Linear comments are not posted; the Slack thread carries the same messages. Refused without `slack`. |
| `slack` | object, optional | The Slack surface. Without it, the bot posts nothing, receives no replies, and no thread is read or bound. |
| `slack.appTokenFile` | absolute path, required with `slack` | The Socket Mode app token. A nonempty regular `0600` file outside `stateDir`, `runDir`, `teams.workspaceDir`, and every project path. |
| `slack.botTokenFile` | absolute path, required with `slack` | The bot token. The same file rules as `appTokenFile`. |
| `slack.teamId` | `T` followed by 2 to 20 uppercase letters or digits, required with `slack` | The workspace. A token for another workspace, or a token Slack refuses, stops the surface with a reason. |
| `slack.ownerUserId` | `U` or `W` ID, required with `slack` | The only Slack user whose messages cause work. |
| `slack.linearAgentUserId` | `U` or `W` ID, optional; required when `requireSlackThread` is on | Linear's agent user in Slack, mentioned by the owner to file a request. |
| `slack.bindByMention` | boolean, default `false` | Binds a thread by a mention of an identifier. Cannot be used with `requireSlackThread`. |
| `slack.endpoint` | URL, optional | The Slack Web API base. Only the official HTTPS endpoint, or loopback HTTP when `environment` is `"local"`. |
| `mission.groupId` | project group ID, required | The group new missions start in. A host project ID works as an alias. |
| `mission.maxSubtasks` | integer 1 to 12, default `8` | The subtask limit for each mission. |
| `mission.maxMinutes` | integer 5 to 1440, default `240` | The working-time limit for each mission. See [missions](missions.md#working-time-limit). |
| `mission.answerProjectId` | project ID, optional | A configured project. When the mission's repositories include it, the coordinator is told to answer from it. Must name a configured project. |
| `maxActive` | integer 1 to 12, default `3` | Missions intake may have running at once. |
| `requireSlackThread` | boolean, default `true` | Requires a Slack thread and an owner mention before admission. Needs `slack` and `slack.linearAgentUserId`. |

Linear credentials are a separate block, `linear.apiKeyFile`, a `0600` file with
the same location rules. Linear's endpoint must be its official HTTPS endpoint,
or loopback HTTP when `environment` is `"local"`.

### Thread binding without a Slack block

A record is bound to a Slack thread in one of two ways: the host read that thread
successfully at admission, or the owner bound it with a mention when
`bindByMention` is on. A linked thread that was not read, because the read failed
or Slack refused it, is not bound, and the record's comments go to Linear.

Without an `intake.slack` block, no thread is read or bound, so every record's
comments go to Linear. `linear.commentsMirrorToSlack` without a Slack block is
refused at startup.

## What the bot posts

Every Slack message is posted into the thread a record is bound to. Nothing is
posted to a channel taken from an inbound event. Messages are posted in this
order as the mission moves:

- an acknowledgement when the mission starts, or a queued notice while it waits
  for a running request to finish;
- for a request whose start was refused, one notice with the hold reason:
  `Received ID "TITLE". It has not started: REASON`, then
  `I'll post questions and the result here once it starts.` A later change of the
  hold reason posts nothing. When a queued or held request starts, `Started on ID.`
  follows;
- a numbered question for each mission decision, with its options;
- a status note when the mission is paused, but only when the record has a
  `closure`, which is set when the Linear issue is deleted, archived, cancelled,
  or closed. The note says why and asks for `resume` or `cancel`. A pause with no
  closure posts nothing;
- the result: `Answer (agent report):` for an answer-only request, and
  `Ready for review (agent report):` otherwise, followed by pull request and
  branch lines when a subteam published one;
- `Blocked: REASON` or `Cancelled: REASON` when the mission ends that way, then
  `File a follow-up with Linear's agent in this thread.`;
- an edit note when the Linear issue changes after the run started. The run keeps
  the original text.

Text leaves the host only after a filter. Paths under the instance's configured
directories (`stateDir`, `runDir`, `teams.workspaceDir`, and every project path)
and under `/srv/`, `/opt/`, `/run/`, and `/etc/` become `[local path omitted]`, as
do the home and temporary paths shared Linear text already drops. Every IPv4
address becomes `[address omitted]`. Links, such as pull request URLs, and branch
names are kept. The filter applies to every Slack message and every Linear comment.

Text longer than 3,000 characters is split across messages. Code fences are kept
whole where the split allows it. Each message has a key, and a message whose
last send may have reached Slack is looked up in the thread before it is sent
again. A permanent Slack error marks the message `failed`. A transient error is
retried after 5 seconds, 30 seconds, and 2 minutes, then every 10 minutes. A
message that is still unsent 24 hours after it was created is marked `failed`.

The bot accepts only `app_mention` events from `slack.ownerUserId` in a bound
thread, and only those whose team matches `slack.teamId`. Everything else is
counted as dropped. In a reply:

- `status` lists the mission status and its open questions;
- `pause`, `resume`, and `cancel` act on the mission;
- `Q<n>` followed by an answer answers that question; an option number is
  accepted as the answer;
- an unnumbered reply answers the oldest open question;
- with no open question, any other text is a steer to the coordinator.

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
   none, it goes to the newest finished request.
5. With more than one unfinished request, nothing is applied to any mission, and
   the bot replies:
   `More than one request is open in this thread: ID1, ID2. Start your reply with an identifier or a question number.`
   This holds for `status`, `pause`, `resume`, `cancel`, and any other text.

The bot never approves a provider permission, never infers completion, and never
changes a Linear issue's state, assignee, or labels. Replies are applied once,
and a saved call is replayed exactly on retry.

Delivery never gates a mission. An outage of Slack or Linear pauses nothing.

## Linear comments

Intake writes two comments on the Linear issue, both labelled as agent reports:

1. When the mission starts: `Infinite agent report: a mission started on this issue. Questions and the result will follow.`
2. When the mission ends: `Infinite agent report: ready for review.` with the
   coordinator's result summary, or `Infinite agent report: blocked.` or
   `Infinite agent report: cancelled.` with the reason.

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

Both surfaces summarise an unexpected error as its name and code, and write the
full error to the host log. Failures with fixed text, a mission refusal, a Slack
request failure, and a Linear request failure, keep that text. See [security](security.md#request-intake).

## Pre-build checks

Three checks decide how intake behaves once real Linear and Slack traffic is
seen. They are recorded here so the decision is not lost.

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
