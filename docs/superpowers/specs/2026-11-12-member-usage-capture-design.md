# Member usage capture (INF-183)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

The host knows what an attempt cost only when its member ran on OpenCode. Claude Code and Codex members show `Unmeasured`. The outcome ledger, the router, and the learning budget need a cost for every attempt.

This design records token usage for the Claude Code and Codex sessions that the host runs, turns provider limit observations into durable limit events, and adds a list-price equivalent to every usage record.

It amends two earlier non-goals. The 2026-10-17 usage ledger design excluded cost for Claude Code and Codex. The 2026-10-19 cost and effectiveness design said: "Capturing Claude Code or Codex token usage. They remain unmeasured." Both end here. The rule that Spent holds only metered money stays.

## Current state

Observed on `main`:

- `UsageRecord` in `packages/host/src/usage.ts` types `provider` as the literal `"opencode"`. The worker journals a `usage` record for OpenCode only (`usageFromRunLine`, and `onUsage` in the native adapter).
- `UsageService.tick` in `packages/host/src/usage-service.ts` folds those journal records into one sealed file. It marks a session `measured` only for OpenCode, holds every row in memory, and re-seals the whole file when a row changes. INF-40 tracks that cost.
- `priceUsage` uses the configured price, then the dated catalog, then the provider's reported cost. `packages/host/src/price-catalog.ts` prices DeepSeek and Meta models only.
- The worker already receives the provider's session transcript for Claude Code and Codex. A provider hook runs `packages/host/src/hook-relay.ts` in the agent's account, and the relay streams the file to the `transcript` hook route. `TranscriptTail` in `packages/host/src/transcript.ts` builds chat messages and reads no usage fields.
- Claude hooks are on by default. Codex hooks are off by default (`DEFAULT_HOOKS` in `packages/host/src/config.ts`), so a Codex session streams its transcript only where `attention.hooks.codex` is true.
- Every member and every mission coordinator session launches through `Manager.createTeamSession`. It stores the `TeamAssignment` (`runId`, `memberId`, `revision`, `role`, `taskId`) and the profile on the session, and the ledger copies both to its session header.
- `teamUsage` in `packages/host/src/team-usage.ts` reads one session per member. A permission reviewer has several (`TeamMember.turns`).
- `ProviderLimits` in `packages/host/src/provider-limits.ts` keeps only the current limit per provider.

### Confirmed provider fields

Confirmed on Claude Code 2.1.323 and codex-cli 0.167.2 on a development machine. The check listed key names and value types in recent session transcripts and tested arithmetic relations as true or false. No transcript content entered this design. The builder repeats the check on the execution host's versions and records it here.

**Claude Code**, in a row with `type: "assistant"`:

- `message.id` and `message.model` are strings. Several rows share one `message.id`, with identical `message.usage` in every inspected case. A model that starts with `<` marks a synthetic row.
- `message.usage` has numeric `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`.
- `message.usage.cache_creation.ephemeral_1h_input_tokens` and its five-minute sibling always summed to `cache_creation_input_tokens`.
- `message.usage.output_tokens_details.thinking_tokens` never exceeded `output_tokens`.
- The row has `timestamp`, `sessionId`, and `version`.
- A subagent's rows are in a separate file, `agent-<id>.jsonl`, in a `subagents` folder that belongs to the session. Those rows carry `message.usage`, and the session transcript had none of them.

Not confirmed: a `message.usage.iterations` array with more than one element, and whether a resumed conversation copies earlier rows. That input tokens exclude both cache classes rests on the provider's published API contract.

**Codex**, in the session transcript:

- A `token_usage_record` row has `timestamp` and a `payload` with `response_id`, `thread_id`, `turn_id`, `usage`, and `thread_token_usage`.
- Each usage object has `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `total_tokens`. `total_tokens` always equalled `input_tokens + output_tokens`, so cached tokens are part of input and reasoning tokens are part of output. The parser refuses a usage object that breaks this rule.
- `response_id` was unique within a transcript and never appeared in two.
- An `event_msg` row with `payload.type: "token_count"` has `payload.info.total_token_usage` and `payload.rate_limits.primary.used_percent`. The cumulative total never decreased, and the same total repeats across rows.
- A `turn_context` row has `payload.turn_id`, `payload.model`, and `payload.effort`. A `session_meta` row has `payload.cli_version` and `payload.parent_thread_id`.

Not confirmed: a non-zero `cache_write_input_tokens` (it was always zero), whether older versions write `token_usage_record`, and how child threads are counted.

## Goals

1. Every Claude Code and Codex session that the host runs with hooks records token usage per provider request, for every role.
2. A usage record counts once, whatever the worker, the relay, or a resumed conversation replays.
3. Each session states its coverage: `none`, `partial`, or `complete`. A total never treats unknown as zero.
4. Spent keeps its meaning. Subscription usage adds tokens and a list-price equivalent, never money.
5. Every limit episode becomes a durable limit event tied to a profile and, for a member with a task, to its attempt.
6. Usage rows live in the evidence store, and the whole-file re-seal ends. This closes INF-40.
7. The session header carries `purpose` and `configId`, and the ledger reports spend per purpose.

## Non-goals

- Laptop sessions and other work that runs off the host.
- Provider billing APIs, estimated balances, and allocating a plan fee across tasks.
- Grok sessions and OpenCode in a native terminal. They stay unmeasured.
- Codex sessions that run through the native adapter in `packages/host/src/native-codex.ts`. No token notification was confirmed for it.
- Quota readings. Codex states a used percentage in its `token_count` rows, and recording it is a later addition.
- Enforcing the learning budget. This design supplies the meter.

## Anti-goals

- **A subscription token that shows as money spent.**
- **A partial session that looks complete.**
- **A parser that guesses** when a provider renames a field.
- **A usage row that carries conversation text.**
- **Two meters summed for one request.**

## Approaches

**A. Read usage from the transcript rows the worker already receives.** It adds no access path, gives one usage record per provider request with the provider's own identifier, and works for every role. Its weakness is lag: usage arrives when a hook fires, and a session stopped between hooks loses its tail unless a final drain runs.

**B. Start members headless and read structured output**, as OpenCode members do with `--format json`. That replaces the terminal session that the prompt, permission, and limit detectors read.

**C. Read provider telemetry or account APIs.** Account APIs need administrator keys and give no per-session attribution. Telemetry export needs a collector service and was not verified here.

The pick is A. *(My call: the bytes already arrive, the provider identifiers make replay safe, and member execution does not change.)*

## Design

### Part 1: record shape

`UsageRecord` widens. Existing OpenCode rows stay valid.

```ts
export interface UsageRecord {
  provider: "opencode" | "claude" | "codex";
  providerId: string;   // "claude" or "codex" for those providers
  modelId: string;
  messageId: string;    // claude: message.id. codex: response_id.
  partId: string;       // "" for claude and codex
  nativeId?: string;    // claude: sessionId. codex: thread_id.
  secondary?: true;     // read from a secondary transcript
  modelSource: "requested" | "reported" | "unknown";
  completedAt: string;  // the row timestamp
  tokens: UsageTokens;
  cacheWrite1h?: number; // the part of tokens.cacheWrite with a one-hour lifetime
  reportedCost: number; // 0 for claude and codex
}
```

`providerId` is `claude` or `codex` so that the documented account patterns `claude/*` and `codex/*` match.

Token classes never overlap:

| Class | Claude Code | Codex |
|---|---|---|
| `input` | `input_tokens` | `input_tokens - cached_input_tokens` |
| `cacheRead` | `cache_read_input_tokens` | `cached_input_tokens` |
| `cacheWrite` | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| `reasoning` | `thinking_tokens`, or 0 when absent | `reasoning_output_tokens` |
| `output` | `output_tokens - reasoning` | `output_tokens - reasoning_output_tokens` |

`priceUsage` already bills `output + reasoning` at the output rate, so the split loses nothing. A Codex usage record with a non-zero `cache_write_input_tokens` is stored, and its list price stays unknown until the builder confirms how that field relates to `input_tokens`.

### Part 2: capture in the worker

A hook payload only names the transcript. No usage comes from the payload.

**One pass per row.** The worker gives each transcript row to a usage tail as well as to the chat parser. The usage tail is a new module, `packages/host/src/transcript-usage.ts`. It reads identifiers, model names, timestamps, and numbers, and never content. The worker appends each usage record as a `usage` journal record, the type OpenCode already uses.

**Claude Code rule.** A transcript row yields a usage record when `type` is `assistant`, `message.id` and `message.usage` exist, and `message.model` does not start with `<`. The model is `reported`. Rows that share a `message.id` yield one usage record. The worker emits it again only when one of the provider's counts for that message grows.

**Codex rule.** A `token_usage_record` row yields a usage record from `payload.usage`. The model comes from the `turn_context` row with the same `turn_id`, or else from the profile with `modelSource: "requested"`. A conversation without `token_usage_record` rows falls back to `token_count` rows. The usage tail holds the conversation's last cumulative total and emits nothing from it while the provider runs, because a `token_usage_record` row can still arrive. When the provider exits, a conversation that produced no `token_usage_record` row yields one usage record for the thread: its last cumulative total, with the time of the last increase and the last model the conversation named. One conversation therefore never uses both row types. *(My call: one snapshot per thread. A record per increase is not stable when a transcript is read again, and it loses tokens when a long conversation exceeds the tail's memory bound. The cost is coarse timing: the whole thread counts on the day of its last increase.)*

**Secondary transcripts.** A subagent's usage is not in the session transcript. After the primary transcript, the relay posts an end marker that lists secondary transcripts: for Claude Code, the `agent-<id>.jsonl` files in the session's `subagents` folder. The worker answers with a byte offset for each file it wants. It accepts a secondary path only inside the folder derived from the authenticated primary path, and it keeps at most 64 usage tails. Codex child threads are not captured in the first version.

**Final drain.** A member that the host stops mid-turn fires no further hook. On provider exit the worker starts the relay once in drain mode and accepts chunks until the end marker or a 10 second limit. Where the agent runs under another account, this needs one root-owned wrapper beside the provider wrappers in `deploy/ubuntu/infinite.sudoers`. Without it the drain is skipped, and the session's coverage says so.

**Keys and cursors.**

- The record key is `message.id` for Claude and `response_id` for Codex. The Codex fallback key is the thread. OpenCode keeps session, message, and part.
- Claude and Codex keys are global, not per session, so a replay from a relay retry, a new worker, or a resumed conversation adds nothing. A usage record belongs to the first session that captured it.
- The transcript offset lives in worker memory. A new worker reads from zero.
- The journal cursor is stored per session in the same transaction as the rows it covers.

### Part 3: coverage

Each session has a coverage value and a fixed reason code. The worker appends one `usage-coverage` journal record when the provider process exits.

- `none`: no usage record arrived. Reasons: `hooks-off`, `no-transcript`, `no-usage-fields`, `unsupported`.
- `partial`: at least one usage record arrived and a gap is possible. Reasons: `running`, `stopped-mid-turn`, `drain-incomplete`, `secondary-missing`, `child-threads`, `row-dropped`.
- `complete`: the last drain before provider exit reached the end marker for the primary transcript and for every listed secondary transcript, and that drain ran at a session end, or at a turn end that did not fail and left no background task running.

A session that the host stopped mid-turn stays `partial` with reason `stopped-mid-turn`, also when its final drain reached the end marker. A request in flight at the stop leaves no transcript row, so the end of the file does not prove that every request was counted. The final drain still adds every row the transcript holds.

For Codex, `complete` also requires that the conversation's usage records sum to its last `thread_token_usage`. OpenCode sessions keep today's rule: a session in a measured launch mode is `complete`.

`measured` stays in the API and is true for `partial` and `complete`. Every roll-up that counts unmeasured sessions or members also counts partial ones.

### Part 4: the ledger in the evidence store

Usage rows move out of the sealed file into tables that this design owns in the evidence store (C1). *(My call: per-request rows cannot live in a file that is rewritten whole, and one database lets the outcome ledger read cost with a join.)*

```sql
CREATE TABLE usage_sessions (
  session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, project_ref TEXT NOT NULL,
  created_at TEXT NOT NULL, last_active_at TEXT,
  coverage TEXT NOT NULL, coverage_reason TEXT,
  run_id TEXT, member_id TEXT, revision INTEGER, role TEXT, task_key TEXT,
  profile_id TEXT, purpose TEXT, config_id TEXT, native_id TEXT,
  provider_version TEXT, journal_cursor INTEGER NOT NULL DEFAULT 0,
  exited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE usage_records (
  provider TEXT NOT NULL,
  key_scope TEXT NOT NULL,   -- opencode: session id. claude and codex: ''.
  record_key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES usage_sessions(session_id),
  completed_at TEXT NOT NULL,
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL, model_source TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  reported_cost_micro INTEGER NOT NULL DEFAULT 0,
  secondary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_scope, record_key)
);
```

A write that meets an existing key keeps one whole record and the first `session_id`. It never mixes classes from two records, because the classes of one request are derived together. The kept record is the larger one in this order: token total, then reasoning tokens, then one-hour cache tokens. A record that is equal or smaller in that order changes nothing, so a transcript that is read again cannot undo a later refinement. Briefing rows move to a `usage_briefings` table.

A usage row has no free text and no encrypted column. Its opaque identifiers, enumerations, and numbers are plain so that SQL can index and sum them. The project and the task are stored as blind indexes, `project_ref` and `task_key`, as contract C1 requires. The service resolves a project's rows by computing the index of each project it knows.

**Header.** The session gains optional `purpose` and `configId` fields, passed through `Manager.createTeamSession` by the launcher. A member session without a purpose is `work`, and a session that is not a member has none. This design stores and reports `configId`. `TeamService` computes it when it starts a member (contract C7).

**Roles.** Every role already has its assignment on the header. The gap is a member with several sessions: `UsageService.member(runId, memberId)` sums every session whose header matches, and `teamUsage` calls it in place of `session(member.sessionId)`.

**Import.** One transaction imports the sealed ledger's rows, headers, cursors, and briefings. Keys make it idempotent. Afterwards the service stops writing the sealed file and keeps it unread for one release. The read API of `UsageService` keeps its shape.

### Part 5: pricing

Spent and the list-price equivalent are separate results.

| Usage record | Account kind | Spent | `pricing` |
|---|---|---|---|
| `opencode` | any | as today | as today |
| `claude` or `codex` | `subscription` | 0 | `subscription` |
| `claude` or `codex` | `metered` | configured price, then catalog | `configured` or `catalog` |
| `claude` or `codex` | none configured | 0 | `unknown` |

`Pricing` gains `subscription`. A `subscription` row is not unpriced. A row with no configured account is, because the host does not know how that usage is billed.

`listPrice(record)` returns the configured price, then the catalog price, or null, for every usage record. It applies the catalog's peak multiplier, bills reasoning at the output rate, and uses a separate rate for `cacheWrite1h` when the catalog has one. The catalog gains dated prices for the Claude and OpenAI models in the lineup, keyed `claude/<model>` and `codex/<model>`, each with its URL and date. This design states no prices.

`UsageTotals` gains `list`, with `usd` and `unpriced`. A consumer treats `listUsd` as unknown when `unpriced` is above zero. No Spent figure, daily bar, budget, or account total includes it.

### Part 6: limit events

A limit event is one limit episode seen in one session. The ledger reads `provider-limit` journal signals with the session's cursor. Signals with no recovery turn end between them (`recoveryTurnEnd`) form one episode.

```sql
CREATE TABLE limit_events (
  session_id TEXT NOT NULL, first_seq INTEGER NOT NULL,
  provider TEXT NOT NULL, profile_id TEXT,
  run_id TEXT, member_id TEXT, task_key TEXT,
  kind TEXT NOT NULL,        -- usage | credits
  confidence TEXT NOT NULL,  -- single-source | corroborated
  detected_at TEXT NOT NULL, resets_at TEXT,
  PRIMARY KEY (session_id, first_seq)
);
```

A limit event is an observation about a provider account and changes nothing in the fallback path. The outcome ledger reads limit events per attempt, and the router reads them per provider.

### Part 7: surface

API changes are additive:

- Session, member, and task usage objects gain `coverage` and `list`. `UsageRollup` gains `partialMembers`.
- `GET /api/usage` reports `claude` and `codex` with tokens, `partialSessions`, and `unmeasuredSessions`. `spent` is absent unless the account is metered.
- `GET /api/usage/projects/:id` gains `byPurpose`: Spent, list, and member count for `work`, `duel`, `replay`, and `gate`. Headline Spent includes every purpose. *(My call: money is money.)*
- `GET /api/usage/limits?days=30&project=…` returns limit events and counts per profile.
- `GET /api/usage/capture` returns, per provider, the last provider version seen and sessions by coverage and reason for seven days.

CLI: `infinite usage limits` and `infinite usage capture`. Existing commands print tokens for subscription rows and `—` for their Spent. The list-price equivalent prints only in `infinite usage models`, labelled as such.

Clients show tokens where a member showed `Unmeasured`, and they mark a figure that includes an exited `partial` session. The Models tab gains a "list-price equivalent" column.

There is no MCP surface. A member gets no usage tool.

## Authority and safety

- A usage total and a limit event record what the host saw. Neither says a task is complete, failed, or valuable.
- The relay stays the only process that opens a provider file, and the ledger stores no transcript path.
- The usage tail copies numbers, identifiers, model names, and timestamps. A test asserts that no other key reaches the journal or the store.
- The transcript reaches the worker through the agent's account, which can write the file. Usage from this path is the provider's record as relayed, not a host receipt, so consumers must not treat cost as tamper-proof. The relay's path checks keep an honest session from reading the wrong files. They are not a boundary against a process in the agent's account, which can read the same files and write any transcript row.
- Usage numbers, list prices, and limit counts never enter a member prompt (C9), and `listUsd` is never shown as money spent (C5).

## Failure modes

| Failure | Result |
|---|---|
| A provider renames a field | The parser yields nothing. Coverage is `none` with `no-usage-fields`, and `infinite usage capture` shows the version. |
| The relay times out | Capture resumes at the next hook or in the final drain. If neither completes, coverage is `partial`. |
| A member is stopped mid-turn | The final drain adds the remaining rows. Coverage stays `partial`. |
| A request was in flight at the stop | No transcript holds it. This blind spot is permanent. |
| The evidence store cannot open | Usage endpoints report unavailable. Capture continues in journals, and the fold resumes from the stored cursors. |

## Delivery order

1. **Parsers and fixtures.** `transcript-usage.ts`, the widened `UsageRecord`, and redacted fixtures. No runtime change.
2. **Worker capture.** Journal `usage` and `usage-coverage` records for Claude Code and Codex, the end marker, secondary transcripts, and the final drain. It needs no store. The ledger still shows those sessions as unmeasured.
3. **Ledger in the evidence store.** Tables, import, `member()`, coverage in every roll-up, and the two new header fields. It needs the store lifecycle from the blackboard design. It closes INF-40, and clients show tokens.
4. **List-price equivalent.** Catalog prices, `listPrice`, `list` totals, and the Models column.
5. **Limit events.**

## Acceptance

Fixtures come from synthetic sessions against a scratch repository. A script replaces all text with placeholders and keeps structure and numbers.

1. A Claude fixture has one request split over three rows, one synthetic row, and one request with thinking tokens and one-hour cache writes. The parser yields two usage records, `output + reasoning` equals `output_tokens`, and `cacheWrite1h` is set.
2. A Codex fixture has `token_usage_record` rows and repeated `token_count` rows. Usage records equal distinct `response_id` values and sum to the last `thread_token_usage`. A fixture without `token_usage_record` rows yields one record that equals the final cumulative total.
3. With usage rows added to the rehearsal provider's transcript (`packages/host/src/demo.ts`), a team run shows member tokens, `coverage: "complete"`, and unchanged Spent.
4. A member stopped mid-turn is `partial` with reason `drain-incomplete` without the final drain. With it, the session is `partial` with reason `stopped-mid-turn`, and its totals include the rows written after the last hook.
5. A transcript re-read from offset zero changes no total. Neither does a second session whose transcript replays the first.
6. Usage records under a `subscription` account add 0 to month Spent and to the daily series, and `unpriced` does not change. With no configured account they count as unpriced.
7. A usage record with an unknown model raises `list.unpriced`, and no client prints a list figure for that total.
8. Two limit signals in one episode produce one limit event with the member's profile.
9. A fixture sealed ledger gives the same `GET /api/usage` body before and after import, and the sealed file is not written again.
10. A permission reviewer with three turn sessions reports the sum of all three.

## Owner decisions

1. **Visibility.** The 2026-10-19 design made an API-price value for subscription use a non-goal (INF-71). This design shows Claude and Codex tokens everywhere and their list-price equivalent only in the Models tab and the CLI.
2. **Codex hooks.** Codex capture needs `attention.hooks.codex` on the deployment. The default is off.
3. **Final drain wrapper.** One more root-owned wrapper lets the host read the rest of a stopped member's transcript. Without it those sessions lose the rows written after the last hook.
4. **Retention.** Usage rows hold no text and are kept without limit in the first version.

## Left to the builder

- Repeat the field confirmation on the execution host's provider versions and record it here.
- Confirm each item marked not confirmed above, or leave it unmeasured. Check also for a token notification in the native Codex adapter and for a session-end hook when the host stops a provider.
- The fixture recorder and its redaction.
- Catalog prices, each with its URL and date.
- Exact SQL, indexes, daily bucketing, and the import mechanics.
- Use of the store's shared blind index function, which the blackboard design owns.
- Rendering of the partial mark and the list label, following `DESIGN.md`.
