# Usage ledger and provider-limit fallback

Date: 2026-10-17. Status: design for review. Checkout: the agent-teams branch, where Goals, Teams, and the lineup live.

## Intent

Two problems with running mixed-model teams today:

1. Nobody knows what the OpenCode workers (DeepSeek, Muse Spark, others) cost. The host records which profile it asked for and nothing about tokens or dollars.
2. Claude Code and Codex members run on subscription quotas. When the quota is hit the agent does not exit: Claude Code blocks and may wait for the reset, Codex's interface sits with "usage limited" in its status line. The scheduler sees a running member that never reports, and eventually blocks the run on the one-hour member time limit with no explanation.

This design adds a durable usage ledger for OpenCode sessions with a soft per-provider budget, and teaches the team scheduler to recognise a provider usage limit and move the member's task to a configured comparable profile.

## Goals

- Every OpenCode message's token counts and USD cost are recorded durably, priced from a configured table when one exists and otherwise as OpenCode reports them.
- Totals are visible per member, per team run, per goal, and per provider over a budget period, in the API and the web client.
- A configured budget per provider is a line to compare against. It never refuses, pauses, or reroutes work.
- When a Claude Code or Codex team or goal member hits a usage limit, the host stops that member and launches a replacement on the profile the lineup names as its limit fallback, preserving the member's partial work. The switch, its reason, and the reset time when the provider stated one are recorded on the task and in the run history.
- While a provider's limit is known to be in effect, new members in any run that would use that provider launch on the fallback directly instead of discovering the limit again.

## Non-goals

- Switching interactive sessions (`infinite claude`, `infinite codex`). A limit there becomes a visible notice in the session's attention record and nothing more.
- Hard budget enforcement, spend alerts, or push notifications for spend.
- Cost for Claude Code and Codex. Their interactive processes expose no per-message cost to the host. The ledger records their usage as unknown, not zero.
- Reading or predicting Claude Code or Codex quota before a limit is hit (percent used, windows). Codex's app server and Claude Code's statusline both expose this, and a later adapter can use them. This design reacts to the limit event only.
- Mac app changes. The desktop Teams dashboard lives in a different checkout and shows what the API gives it; the new fields render there in a later change.
- Automatic switch back when a limit resets. The next member launched after the reset simply uses the normal profile.

## Anti-goals

- Claiming a cost or a model that was not observed. A requested model is not a served model, and a priced total is only as good as the price table.
- Treating a limit switch as success or progress. It is a recorded fact about a provider, and the replacement member still has to report.
- Letting the fallback mechanism widen scope: a fallback profile cannot change a task's owned paths, a goal's allowed paths, or any limit.

## Facts the design rests on

Confirmed from the installed binaries and the vendors' own documentation on 2026-10-17. Versions: OpenCode 1.18.34, Codex 0.162.0 on the live host (0.163.0 locally), Claude Code 2.1.302.

**OpenCode.** The server emits `message.updated` with `properties.info`. For an assistant message, `info` has `cost` (USD), `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`, plus `providerID`, `modelID`, and `time.completed` once the message is final. The event repeats while the message streams; the final value is the one with `time.completed`. `GET /session/{id}/message` returns the same objects after the fact. `cost` comes from models.dev pricing and is 0 when the catalog has no price for the model. `opencode run --format json` writes one JSON object per bus event to stdout, so the same `message.updated` events are available from a headless run. `session.error` carries `error.name` and, for `APIError`, `data.statusCode`; a 429 is retried by OpenCode itself.

**Claude Code.** The `StopFailure` hook fires instead of `Stop` when a turn ends on an API error. Its payload has `error`, one of `rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `max_output_tokens`, and others, plus `error_details` and `last_assistant_message`. The host already registers this hook and maps it to a failed turn, but drops the `error` field. The interactive process does not exit on a limit; it shows "You've hit your session limit · resets 3:45pm" (or weekly, Opus, spend variants) and may wait for the reset. `Notification` hooks `quota_auto_resume_fired`, `quota_auto_resume_stale`, and `quota_auto_resume_disabled` describe that wait.

**Codex.** Team members run the interactive TUI in a PTY with hooks configured. On a limit the TUI stays open, prints "Usage limit reached. You've reached your usage limit." or "You're out of credits.", optionally followed by " Try again at <date>", and shows "usage limited" in its status line. No hook or exit code reports it. The app-server protocol, which the host uses only for local-UI sessions, reports `turn/completed` with `turn.error.codexErrorInfo` of `usageLimitExceeded` or `rateLimitExceeded`, and notifies `account/rateLimits/updated`.

Still unobserved on the live host, and to be confirmed during implementation before the detectors are trusted: that a subscription quota hit delivers `error: "rate_limit"` in StopFailure; that the Codex TUI's "usage limited" indicator sits in its bottom status row at the configured terminal size, and what that row looks like; whether OpenCode's `cost` is non-zero for the providers actually configured there. A builder confirmed locally that `opencode run --format json` writes raw JSON lines when stdout is a PTY.

## Part 1: usage ledger

### Capture

OpenCode team members launch with `--format json` added by the host (the launch builder already owns the `run` argument list). The worker parses each stdout line that is a JSON object with `type: "message.updated"`, and for an assistant message with `time.completed` set, records a journal event of kind `usage`:

```
{ provider: "opencode", providerId, modelId, messageId, completedAt,
  tokens: { input, output, reasoning, cacheRead, cacheWrite },
  reportedCost }
```

Lines that are not JSON, not `message.updated`, or not completed are ignored. A repeated `messageId` replaces the earlier record for that message rather than adding to it. The member's terminal shows the JSON event stream; these members accept no interactive input anyway, and the web chat view continues to come from the provider's own record.

OpenCode sessions driven through the local-UI adapter already subscribe to `/event` and record the message role from `message.updated`; the same handler records the `usage` event. Terminal-mode `infinite opencode` sessions run the TUI and have no structured output; the ledger records nothing for them and the API says so rather than showing zero.

Claude Code and Codex sessions record no `usage` events in this change.

### Pricing

Host configuration gains an optional `usage` block:

```json
{
  "usage": {
    "prices": {
      "deepseek/deepseek-flash": { "input": 0.14, "output": 0.28, "cacheRead": 0.014, "cacheWrite": 0.14 },
      "meta/muse-spark-1.3-contributor": { "input": 0, "output": 0 }
    },
    "budgets": {
      "opencode": { "usd": 50, "period": "month" }
    }
  }
}
```

Prices are USD per million tokens; `cacheRead` and `cacheWrite` are optional and default to the input price. `budgets` is keyed by provider (`claude`, `codex`, `grok`, `opencode`); `period` is `day`, `week`, or `month`, in UTC, defaulting to `month`. A budget is informational.

Each `usage` record is priced at read time, not at capture: `cost` is computed from the configured price for `providerId/modelId` when one exists, otherwise it is `reportedCost`. The record exposes `pricing: "configured" | "provider" | "unknown"`, where `unknown` means no configured price and a reported cost of 0. Changing the price table re-prices history, which is the intended behaviour for a tally.

### Aggregation and durability

A `UsageService` in the API owns a sealed ledger in the state directory. It follows the journals of sessions that can produce `usage` events (OpenCode sessions, by provider) with a cursor per session, the same way the team scheduler follows `team-report` events, and writes each record keyed by `(sessionId, messageId)`. Re-reading a journal after a restart produces the same ledger. The ledger also stores, per session, the provider, model profile when the session is a team member, and project.

The service answers:

- per session: tokens, cost, message count, pricing mix
- per team run: the sum over its member sessions, grouped by profile and by provider; the team view carries this as `usage` on each member and on the run
- per goal: the sum over its cycles, carried on the goal view
- per provider and period: cost and tokens in the current budget period, the configured budget if any, and the previous period's total

Sessions whose provider has no capture path (Claude Code, Codex, Grok, OpenCode in TUI mode) are reported as `unmeasured`, with the count of such sessions, so a total is never mistaken for a complete total.

### Surfaces

- `GET /api/usage` returns the per-provider period summary and the unmeasured counts. `GET /api/me` advertises `usage: { enabled, budgets }` so clients can hide the feature on hosts without it.
- Team and goal views gain `usage` fields as above. The web Teams and Goals pages show a cost line per member (or "unmeasured"), a total per run with the pricing mix, and a "Spend this period" block on the Teams list showing each budgeted provider as spent / budget, marked over when exceeded.
- Session summaries in `GET /api/sessions` carry `usage` for measured sessions so the session list can show a cost.
- `infinite usage` in the laptop CLI prints the `GET /api/usage` summary; `--json` prints it raw.

Every surface labels configured prices as configured and provider-reported costs as reported by OpenCode.

## Part 2: provider-limit detection and fallback

### Signal

A new attention signal kind, `provider-limit`:

```
{ kind: "provider-limit", provider, limit: "usage" | "credits", resetsAt?, message }
```

Sources:

- Claude Code, hook: `StopFailure` with `error === "rate_limit"` produces `limit: "usage"`. No other `StopFailure` error is a limit: `billing_error`, `account_on_hold`, `overloaded`, and the rest stay provider errors as today, because switching models does not address them. `Notification` with `notification_type` beginning `quota_auto_resume_` also produces the signal, so a session that has started waiting is recognised even if the StopFailure was missed.
- Claude Code, screen: a line matching the documented limit text ("You've hit your … limit · resets …"). `resetsAt` is parsed from the reset clause when present; parse failures leave it unset.
- Codex, screen: the "usage limited" indicator in the TUI's own status row at the bottom of the screen produces `limit: "usage"`. The transcript-body messages "Usage limit reached. You've reached your usage limit." and "You're out of credits." (the latter `limit: "credits"`) never trigger on their own; they may supply `resetsAt` from a following "Try again at …" clause and are recorded as annotation when the status row has triggered.
- Codex, app server (local-UI sessions): `turn/completed` whose `turn.error.codexErrorInfo` is `usageLimitExceeded` (quota) or `rateLimitExceeded` (transient). Only `usageLimitExceeded` is a limit for this design; `rateLimitExceeded` stays a provider error.
- OpenCode: not a source. Its 429s are retried by OpenCode and are not subscription limits.

Screen detection runs in the worker's existing screen loop, which already matches dialog blocks for prompts. The signal is recorded in the journal with its source, and the attention record gains `limit: { provider, resetsAt?, since }` so clients can show "Usage limit reached · resets 15:00" for any session, team member or not. The attention state itself is unchanged by the signal; the existing states already describe whether the process is working, idle, or exited.

A `provider-limit` signal is an observation about the provider's account at that moment. It does not mean the task failed and never substitutes for a report.

### Confidence, and what each observation is allowed to do

Two failure modes shape the rules below. A transient API 429 that exhausts Claude Code's own retries also ends the turn with `StopFailure`, so a hook-only `rate_limit` can describe a blip rather than a quota. And the limit texts live in this repository, in this document and in the detector's tests, so any member working here can put them on its own screen with `cat` or `grep`. A false switch costs one member attempt on one member. A false host-level entry reroutes every new member of that provider on the host. The rules keep the first cheap and make the second hard.

Each observation is **single-source** or **corroborated**:

- Claude Code: the hook signal alone is single-source. It is corroborated when the screen shows the limit notice in the same check or within the next two, or when a `quota_auto_resume_*` notification follows.
- Codex: the status-row indicator is single-source when first seen. It is corroborated when it persists across at least three consecutive screen checks spanning at least 30 seconds with no other output change. The screen loop only acts on the status row, so transcript text, including this repository's own test fixtures scrolled through the body, cannot trigger a switch.
- Codex app server `usageLimitExceeded` and Claude `quota_auto_resume_*` notifications are corroborated on arrival; they are the provider's typed statement.

What an observation may do:

- **Switch the observed member.** A corroborated observation on a team or goal member switches it (Part 2, scheduler behaviour). A single-source Claude hook observation also switches, because the member's turn has already failed and the cost of being wrong is one attempt. A single-source Codex screen observation only annotates and waits for corroboration.
- **Write the host-level limit entry.** Only a corroborated observation writes `providerLimits`. The entry lasts until the provider's stated `resetsAt`, capped at 24 hours; when the provider stated no reset time the entry lasts 15 minutes. There is no one-hour default.
- **Annotate.** Every observation, whatever its confidence, is recorded in the session's journal and attention record for people to see.

### Host-level limit memory

`TeamService` keeps `providerLimits`, a map from provider to `{ detectedAt, resetsAt?, expiresAt, sessionId, runId?, confidence }`, persisted in a sealed file. A corroborated limit is recorded here regardless of which run observed it, with the expiry rules above, and is cleared early when a member of that provider later completes a turn successfully. `GET /api/me` and the team views expose the current entries so the dashboards can say why members are launching on fallbacks.

### Lineup configuration

Each `TeamModelProfile` gains an optional `limitFallback`, the `id` of another profile in the same lineup. The lineup gains an optional `fallbacks` pool, a list of profiles that exist only to be fallbacks, alongside `implementers` and `escalations`. A `limitFallback` may name any profile in the lineup: an implementer, an escalation, or a fallback-pool entry.

Validation, at config load and when a goal or team snapshots its lineup:

- the named id exists in the lineup and resolves to a different provider than the profile it backs (a fallback on the same limited account is useless)
- a profile with `tier: "strong"` may only fall back to a `tier: "strong"` profile, so goals keep a strong coordinator and reviewer after a switch
- the reused-id rule already in force applies: one id means one provider, model, effort or variant, tier, and data-use setting throughout the lineup
- fallback chains are followed at most twice; a cycle is a config error

Example additions to the documented lineup:

```json
{
  "coordinator": { "id": "opus-xhigh", "...": "...", "limitFallback": "deepseek-pro-xhigh" },
  "implementers": [
    { "id": "haiku-medium", "...": "...", "limitFallback": "deepseek-flash-medium" },
    { "id": "luna-medium", "...": "...", "limitFallback": "deepseek-flash-medium" }
  ],
  "fallbacks": [
    { "id": "deepseek-pro-xhigh", "label": "DeepSeek V4 Pro high", "provider": "opencode", "model": "deepseek/deepseek-v4-pro", "variant": "high", "tier": "strong" },
    { "id": "deepseek-flash-medium", "label": "DeepSeek Flash medium", "provider": "opencode", "model": "deepseek/deepseek-flash", "variant": "medium", "tier": "light" }
  ]
}
```

Model identifiers in the example are placeholders for the operator's actual OpenCode model ids.

### Scheduler behaviour

In the scheduler's per-member step, after reading new journal events and before the existing exited-without-report check:

1. If the member has no report and its journal shows a `provider-limit` observation since the member started that is allowed to switch under the confidence rules, record the limit in `providerLimits` when corroborated, then stop the member through the existing stop path. Stopping uses the existing lease-aware stop; an unstoppable member stays `unavailable` with the existing reason.
2. Resolve the fallback: the member's profile's `limitFallback`, following at most two hops past any profile whose provider is currently in `providerLimits`. With no resolvable fallback, the run blocks with reason "Claude Code usage limit reached at 14:02, resets 15:00; no fallback profile is configured for opus-xhigh." (times from the observation; omitted when unknown). Blocking is the existing `blocked` status, and the member's workspace is preserved.
3. For an implementer: run the existing partial-work path-scope check on its working copy, then create the replacement member with the same `cwd`, `baseCommit`, and task, pinned to the fallback profile. Its prompt is the task prompt plus the note used for escalation: the previous member's partial edits are present and passed the path check. Record `task.limitSwitch = { fromProfileId, toProfileId, reason, resetsAt?, memberId, at }` (a list, since a replacement can itself be switched). This does not consume the task's one escalation.
4. For a scout, coordinator, reviewer, or integrator: assert the copy is unchanged where the role requires it, then relaunch with the original prompt on the fallback profile. The replacement is a new member with its own attempt.
5. Write a run event: "haiku-medium hit a Claude Code usage limit (resets 15:00); task X continues on deepseek-flash-medium with partial work preserved."

Each replacement is a member attempt and counts against the run's and goal's member limits exactly as escalation does. The host does not extend any limit because a provider was unavailable.

At member creation, `memberProfile` consults `providerLimits`: if the selected profile's provider has an unexpired entry, the member is pinned to the resolved fallback and the run event says so. If no fallback resolves, the launch proceeds on the original profile, because the limit may have lifted and the detector will catch it again if not. Goals inherit this through the shared service; a goal's lineup snapshot is unchanged and the substitution is recorded per member.

A limit detected in a non-team session also updates `providerLimits`, so a team starting after an interactive session hit the wall benefits from it. Nothing else happens to that session.

### What the dashboards show

- On the member: "Stopped: Claude Code usage limit, resets 15:00" and a link to the replacement.
- On the task: the switch record, in the same place and style as escalation.
- On the run and on the Teams list: "Claude Code limited since 14:02 · resets 15:00 · new Claude members launch on their fallback" while an entry exists.
- Reset times are the provider's own statement, labelled as such; absence means the provider gave none.

## Honesty and safety rules carried over

- A `provider-limit` observation and a usage total are both records of what the host saw, never inferences about completion or product impact.
- The host never answers a provider's dialog to clear a limit, never enters credentials, and never sends input to a limited member. Stopping it is the only action.
- Fallback cannot change owned paths, allowed paths, deadlines, member limits, or the goal's lineup snapshot; it only pins a different profile for one member.
- Price tables and budgets live in private host configuration. No credential is involved; nothing new reaches agent environments or browsers except the aggregated numbers and the limit observations.
- Contributor data-use labels follow the fallback profile. A fallback onto a contributor profile is displayed with the same disclosure the web client shows today; the operator decides whether to configure such a fallback.

## Left to the builder

- Exact journal event shape, cursor storage, and ledger file layout, subject to the idempotency and restart rules above.
- The regular expressions for screen detection, derived from the quoted vendor strings and validated against captured (redacted) screens from the live host before being trusted.
- Whether `UsageService` polls journals on a timer or is fed by the manager when it already reads them; either is acceptable if restart recovery holds.
- Web layout details within the existing Teams and Goals page sections.
- Test strategy, following the repository's existing fixture-driven host tests: a fixture OpenCode run emitting `--format json` events, a demo member whose screen prints the Codex and Claude limit texts, and a scheduler test that a limited implementer is replaced on its fallback with partial work preserved and member counts advanced.

## Rollout notes

The live host currently runs a release without teams or Linear configuration. Enabling this design there requires the agent-teams branch to be the deployed release, the `teams.lineup` to be configured with fallbacks, and the three live confirmations listed under "Facts" to be recorded privately before the detectors are relied on for unattended goals.
