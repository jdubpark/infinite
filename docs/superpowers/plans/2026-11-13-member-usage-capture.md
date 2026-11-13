# Member Usage Capture Implementation Plan (INF-183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record token usage for the Claude Code and Codex sessions that the host runs, without changing how a member runs.

**Architecture:** A usage tail reads the transcript rows that the session worker already receives. It copies identifiers, model names, timestamps, and numbers into `UsageRecord` values, and never content. Later phases journal those records and fold them into the usage ledger.

**Tech Stack:** TypeScript, `node:test`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-12-member-usage-capture-design.md`, under the shared contracts in `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md` (C5, C8).

This plan grows one section per delivery phase of the spec. Each phase is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- A parser never guesses. A row with a missing or invalid required field yields nothing.
- Token classes never overlap: cached tokens are not part of `input`, and reasoning tokens are not part of `output`.
- A usage record never carries conversation text, a path, or any key outside the `UsageRecord` type.
- Fixtures are synthetic. Every string in them is a placeholder. No fixture is copied from a real session.
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. The full check is `npm run check`.

---

# Phase 1: parsers and fixtures

Spec part 1 and the two parsing rules of part 2, delivery phase 1. No runtime change: nothing calls the usage tail yet.

## Confirmed row shapes

Confirmed by key names and value types on Claude Code 2.1.323 and codex-cli 0.167.2. No content was read.

**Claude Code.** A row with `type: "assistant"` has string `timestamp` and `sessionId`, and a `message` with string `id` and `model` and an object `usage`:

```
usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens   integers
usage.cache_creation.ephemeral_1h_input_tokens, usage.cache_creation.ephemeral_5m_input_tokens              integers
usage.output_tokens_details.thinking_tokens                                                                 integer
```

**Codex.** Every row has `timestamp`, `type`, and `payload`.

```
type "token_usage_record": payload.response_id, payload.thread_id, payload.turn_id   strings
                           payload.usage, payload.thread_token_usage                 usage objects
type "event_msg" with payload.type "token_count": payload.info.total_token_usage     usage object
type "turn_context": payload.turn_id, payload.model                                  strings
type "session_meta": payload.id                                                      string, equal to the thread_id of the request rows
usage object: input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens   integers
```

In every usage object checked, `total_tokens` equals `input_tokens + output_tokens`.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/usage.ts` (modify) | Widen `UsageRecord` |
| `packages/host/src/transcript-usage.ts` (create) | `UsageTail`: one transcript row in, usage records out |
| `tests/fixtures/usage/claude-session.jsonl` (create) | Synthetic Claude Code rows |
| `tests/fixtures/usage/codex-session.jsonl` (create) | Synthetic Codex rows with `token_usage_record` |
| `tests/fixtures/usage/codex-cumulative-session.jsonl` (create) | Synthetic Codex rows with `token_count` only |
| `tests/transcript-usage.test.ts` (create) | Parser tests |

## Review Focus

1. A row that is not an object, or whose usage holds a negative, fractional, or string number. Expect no record and no throw.
2. A Claude row whose later copy reports larger numbers for one message. Expect one record per message, re-emitted with the larger values.
3. A Codex conversation where `token_usage_record` rows start after several `token_count` rows. Expect no fallback record at `finish()`.
6. A transcript that is read again from its start, or a long conversation that exceeds a memory bound. Expect the same keys, and no key whose counts depend on the order of arrival.
4. A Codex `usage` whose `cached_input_tokens` exceeds `input_tokens`. Expect no record, because `input` would be negative.
5. A row that carries text beside its usage. Expect the record to hold no key outside `UsageRecord`.

Each of these has a test in the task that owns the code.

### Task 1: widen the usage record

**Files:** modify `packages/host/src/usage.ts`.

**Interfaces (produces):**

```ts
export interface UsageRecord {
  provider: "opencode" | "claude" | "codex";
  providerId: string;        // "claude" or "codex" for those providers
  modelId: string;
  messageId: string;         // claude: message.id. codex: response_id, or the fallback key
  partId: string;            // "" for claude and codex
  nativeId?: string;         // claude: sessionId. codex: thread_id
  secondary?: true;          // read from a secondary transcript
  modelSource: "requested" | "reported" | "unknown";
  completedAt: string;
  tokens: UsageTokens;
  cacheWrite1h?: number;     // the part of tokens.cacheWrite with a one-hour lifetime
  reportedCost: number;      // 0 for claude and codex
}
```

- [ ] **Step 1: Change the type.** Keep the existing doc comment and add one line on the new providers.
- [ ] **Step 2: Run `npm run typecheck -w @infinite/host`.** Existing OpenCode code must compile unchanged. Fix a compile error only by narrowing on `provider`, never by a cast.
- [ ] **Step 3: Run the existing suites** `tests/usage-pricing.test.ts`, `tests/usage-service.test.ts`, `tests/opencode-usage.test.ts`, and `tests/team-usage.test.ts`. They must pass unchanged.

### Task 2: the usage tail

**Files:** create `packages/host/src/transcript-usage.ts`, the three fixtures, and `tests/transcript-usage.test.ts`.

**Interfaces (produces):**

```ts
export type UsageTranscriptProvider = "claude" | "codex";
export class UsageTail {
  constructor(options: { provider: UsageTranscriptProvider; requestedModel?: string; secondary?: boolean });
  /** One parsed transcript row. Returns the usage records to journal now. Never throws. */
  push(row: unknown): UsageRecord[];
  /** The provider exited. Returns the Codex fallback records, and nothing for Claude. Never throws. */
  finish(): UsageRecord[];
  /** Codex: the last cumulative total seen, for the coverage check of a later phase. */
  cumulativeTotal(): number | undefined;
}
/** The dedupe key of a record: `${provider}:${messageId}`. */
export function usageRecordKey(record: UsageRecord): string;
```

**Token classes** (spec part 1):

| Class | Claude Code | Codex |
|---|---|---|
| `input` | `input_tokens` | `input_tokens - cached_input_tokens` |
| `cacheRead` | `cache_read_input_tokens` | `cached_input_tokens` |
| `cacheWrite` | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| `reasoning` | `output_tokens_details.thinking_tokens`, or 0 when absent | `reasoning_output_tokens` |
| `output` | `output_tokens - reasoning` | `output_tokens - reasoning_output_tokens` |

**Decisions:**

- A number is valid when it is a non-negative safe integer. Every class must be valid after the subtraction. A Codex usage object must also satisfy `total_tokens === input_tokens + output_tokens`, which held on every real row checked. Otherwise the row yields nothing.
- **Claude.** A row yields a record when `type` is `"assistant"`, `message.id` and `message.model` are non-empty strings, `message.usage` is an object, `timestamp` is a string, and the model does not start with `<`. `modelSource` is `"reported"`. `nativeId` is `sessionId` when it is a string. `cacheWrite1h` is set when `cache_creation.ephemeral_1h_input_tokens` is a positive valid number. The tail keeps the largest raw count of each provider field per `message.id` and derives the classes from the merged counts, so `output` is always the merged `output_tokens` minus the merged `thinking_tokens`. `push` returns the record on the first row of a message, and again only when a raw count grew. It keeps at most 4,096 messages and forgets the oldest first. A forgotten message that arrives again is emitted again, possibly with smaller counts, so the ledger of a later phase keeps the record with the larger total per key.
- **Codex request rows.** A `token_usage_record` row yields a record from `payload.usage`, with `messageId` `payload.response_id` and `nativeId` `payload.thread_id`. The model is the `payload.model` of the `turn_context` row with the same `turn_id`, with `modelSource` `"reported"`. Without one it is `requestedModel` with `"requested"`. Without that `modelId` is `"unknown"` with `"unknown"`, and `providerId` stays `"codex"`, because the provider is known. The tail keeps the last 256 turn models.
- **Codex cumulative rows.** A `token_count` row yields nothing from `push`. The tail keeps the last cumulative total: the mapped classes, `total_tokens`, and the row's timestamp. It replaces them only when a row's classes are valid and its `total_tokens` is larger. `finish()` returns one record for the thread, only when the conversation produced no `token_usage_record` row. Its `messageId` is `cumulative:${threadId}` and its `nativeId` is the thread ID, which is the `payload.id` of the `session_meta` row. Its model is the last model that a `turn_context` row named. A usage key is unique across sessions, so a conversation with no `session_meta` row yields no fallback record. *(My call after review: one snapshot per thread. A record per increase loses tokens past the memory bound and is not stable under replay.)*
- `secondary: true` is set on every record when the option is set.
- `providerId` is `"claude"` or `"codex"`. `partId` is `""`. `reportedCost` is `0`.

- [ ] **Step 1: Write the fixtures.** Use placeholders such as `msg_fixture_01`, `resp_fixture_01`, and `2026-01-01T00:00:00.000Z`.

  - `claude-session.jsonl`: one request split over three `assistant` rows with one `message.id` and equal usage. One `assistant` row whose model is `<synthetic>`. One request with `thinking_tokens: 40`, `output_tokens: 100`, and `ephemeral_1h_input_tokens: 500` inside `cache_creation_input_tokens: 700`. One `user` row with a `message.content` placeholder string. One line that is not JSON.
  - `codex-session.jsonl`: one `session_meta` row. Two `turn_context` rows with different models. Three `token_usage_record` rows with distinct `response_id` values over those two turns, whose `usage` values sum to the last `thread_token_usage`. Five `token_count` rows, two of them repeating a total.
  - `codex-cumulative-session.jsonl`: one `session_meta` row with `id: "thread_fixture_02"`, one `turn_context` row, and four `token_count` rows with totals 100, 100, 250, and 400. The last row has `input_tokens: 240`, `cached_input_tokens: 60`, `output_tokens: 160`, and `reasoning_output_tokens: 40`.

- [ ] **Step 2: Write the failing tests.** A helper reads a fixture, skips a line that does not parse, and pushes each row.

| Test name | Assertions |
|---|---|
| `a Claude request split over rows yields one record` | The fixture yields exactly 2 records in total. The synthetic row yields none. |
| `Claude classes do not overlap` | For the thinking request: `reasoning === 40`, `output === 60`, `cacheWrite === 700`, `cacheWrite1h === 500`. |
| `a Claude message that grows is emitted again` | Push a row with `output_tokens: 10`, then the same `message.id` with `output_tokens: 30`. `push` returns one record each time, with `output` 10 and then 30. A third equal row returns none. |
| `Codex request rows yield one record per response` | 3 records with 3 distinct `messageId` values. The per-class sum equals the mapped last `thread_token_usage`. `input + cacheRead` equals the summed raw `input_tokens`. `finish()` returns none. |
| `a Codex record takes its model from its turn` | Records carry the model of their own `turn_id`, with `modelSource` `"reported"`. With no `turn_context` row and `requestedModel: "model-requested"`, the model is `model-requested` with `"requested"`. With neither, `modelId` is `"unknown"` with `"unknown"`, and `providerId` is `"codex"`. |
| `a Codex conversation without request rows falls back to cumulative totals` | `push` returns none for every row. `finish()` returns exactly 1 record: `messageId` `cumulative:thread_fixture_02`, `nativeId` `thread_fixture_02`, tokens `{ input: 180, output: 120, reasoning: 40, cacheRead: 60, cacheWrite: 0 }`, the time of the last increase, and the fixture's model with `"reported"`. A second `finish()` returns an equal result. `cumulativeTotal() === 400`. |
| `a cumulative fallback without a thread id yields nothing` | With no `session_meta` row, `finish()` returns none. |
| `request rows that start late cancel the fallback` | Both tails start with a `session_meta` row. A control tail with two `token_count` rows returns 1 record from `finish()`. A tail that also gets one `token_usage_record` row returns none. |
| `a Claude message merges inclusive output before it splits reasoning` | One message reports `output_tokens: 100` with no thinking detail, then `output_tokens: 100` with `thinking_tokens: 40`. The second record has `output` 60 and `reasoning` 40. |
| `a Codex request takes the model of its own turn` | With turns A and B registered in that order, a request row for turn A carries turn A's model. |
| `a cumulative total that shrinks or is invalid is ignored` | Totals 100, 250, then 200, then a row whose cached tokens exceed its input. `finish()` returns the classes of the 250 row, and `cumulativeTotal() === 250`. |
| `invalid rows yield nothing` | `null`, `"text"`, `[]`, a Claude row with `input_tokens: -1`, with `output_tokens: 1.5`, with `output_tokens: "7"`, with `thinking_tokens` above `output_tokens`, and a Codex row with `cached_input_tokens` above `input_tokens`. No record and no throw. |
| `a Codex total that contradicts its counts is refused` | A cumulative row whose `total_tokens` is not `input_tokens + output_tokens` leaves the earlier snapshot in place. A request row with a wrong total yields nothing. |
| `a record holds only usage fields` | Push a Claude row that also has `message.content: "private-marker"` and a top-level `cwd`. `Object.keys(record)` is a subset of the `UsageRecord` keys, `Object.keys(record.tokens)` equals the five classes, and `JSON.stringify(record)` contains neither marker. |
| `a secondary tail marks its records` | With `secondary: true`, every record has `secondary === true`. Without it, the key is absent. |
| `usageRecordKey joins the provider and the message` | `claude:msg_fixture_01` and `codex:resp_fixture_01`. |

- [ ] **Step 3: Run the tests and confirm they fail** with a missing module error: `node --import tsx --test tests/transcript-usage.test.ts`
- [ ] **Step 4: Implement `UsageTail`.**
- [ ] **Step 5: Run the tests and confirm they pass**, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 6: The coordinator checks the parser against real transcripts** outside the repository, printing counts and sums only. It then runs `npm run check`, requests the independent review, and commits.

## Not in this phase

- Journal records, coverage, secondary transcripts, and the final drain (phase 2).
- The ledger in the evidence store, list prices, and limit events (phases 3 to 5).
- A fixture recorder. The fixtures here are written by hand from the confirmed shapes.

---

# Phase 2a: the session worker journals usage and coverage

Spec part 2 (one pass per row) and part 3 (coverage), for the primary transcript only. Secondary transcripts and the final drain follow in phases 2b and 2c. The usage ledger ignores these records until phase 3, because `UsageService.tick` reads `usage` records only from OpenCode sessions.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/transcript.ts` (modify) | `TranscriptTail` reports each parsed row to an observer and records a dropped line |
| `packages/host/src/transcript-usage.ts` (modify) | Counters for coverage, child-thread detection, and the pure `usageCoverage` function |
| `packages/host/src/hook-relay.ts` (modify) | An end marker when the relay reaches the end of the file |
| `packages/host/src/types.ts` (modify) | The `usage-coverage` journal event type |
| `packages/host/src/worker.ts` (modify) | Feed the usage tail, journal `usage` records, track the last drain, journal one `usage-coverage` record at provider exit |
| `packages/host/src/demo.ts` (modify) | The rehearsal provider writes usage on its assistant rows |
| `tests/transcript.test.ts`, `tests/transcript-usage.test.ts`, `tests/host-launch.test.ts` or `tests/attention-hooks.test.ts` (modify) | Tests, in the suites that already cover each file |

## Review Focus

1. A relay that stops at its chunk budget before the end of the file. Expect no end mark and coverage `partial` with `drain-incomplete`.
7. Two hooks whose relays overlap. Expect the end mark of the first to leave the drain of the second open.
2. A member that the host stops in the middle of a turn. Expect `partial` with `stopped-mid-turn`, also when the last drain reached the end of the file.
3. A hook from a subagent, or Codex child-thread rows. Expect `partial`, never `complete`, because that usage is not captured yet.
4. A session with hooks off, or with no hook before exit. Expect `none` with `hooks-off` and no `usage` record.
5. A transcript line that exceeds the partial-line cap. Expect `partial` with `row-dropped`.
6. An end marker for another path, or at another offset than the worker's cursor. Expect it to be ignored.

### Task 1: observer, counters, coverage rule, end marker

**Files:** `transcript.ts`, `transcript-usage.ts`, `hook-relay.ts`, and their tests. No change to `worker.ts`.

**Interfaces (produces):**

```ts
// transcript.ts
export class TranscriptTail {
  constructor(provider: TranscriptProvider, remember?: number, onRow?: (row: unknown) => void);
  /** True once a line was discarded because it exceeded the partial-line cap. */
  dropped: boolean;
}
export function parseTranscriptRow(row: unknown, provider: TranscriptProvider, offset: number): TranscriptMessage[];
// parseTranscriptRecord(raw, provider, offset) stays and calls parseTranscriptRow.

// transcript-usage.ts
export class UsageTail {
  /** Rows pushed, and usage records returned by push and finish, since construction. */
  rowCount(): number;
  recordCount(): number;
  /** Codex: the sum of total tokens over the request records returned so far. */
  requestTotal(): number;
  /** Codex: a row of type "inter_agent_communication_metadata" was seen. */
  sawChildThreads(): boolean;
}
export type UsageCoverage = "none" | "partial" | "complete";
export type UsageCoverageReason = "hooks-off" | "no-transcript" | "no-usage-fields" | "unsupported"
  | "row-dropped" | "drain-incomplete" | "stopped-mid-turn" | "secondary-missing" | "child-threads";
export interface UsageCoverageInput {
  provider: string;                                  // the session's provider
  hooks: boolean;                                    // at least one provider hook arrived
  rows: number; records: number;
  dropped: boolean;
  lastDrain?: { complete: boolean; turnEnd: boolean };
  subagents: boolean;                                // a hook from a subagent arrived
  childThreads: boolean;
  totalMismatch: boolean;                            // codex: requestTotal() differs from cumulativeTotal()
}
export function usageCoverage(input: UsageCoverageInput): { coverage: UsageCoverage; reason?: UsageCoverageReason };
```

**Decisions:**

- `TranscriptTail.ingest` parses each complete line once. It calls `onRow` with the parsed value before it builds chat messages. A line that is not JSON calls nothing. An observer that throws is ignored.
- `usageCoverage` returns the first match:

| Order | Condition | Result |
|---|---|---|
| 1 | provider is not `claude`, `codex`, or `demo` | `none`, `unsupported` |
| 2 | `hooks` is false | `none`, `hooks-off` |
| 3 | `rows` is 0 | `none`, `no-transcript` |
| 4 | `records` is 0 | `none`, `no-usage-fields` |
| 5 | `dropped` or `totalMismatch` | `partial`, `row-dropped` |
| 6 | no `lastDrain`, or `lastDrain.complete` is false | `partial`, `drain-incomplete` |
| 7 | `lastDrain.turnEnd` is false | `partial`, `stopped-mid-turn` |
| 8 | `subagents` | `partial`, `secondary-missing` |
| 9 | `childThreads` | `partial`, `child-threads` |
| 10 | otherwise | `complete`, no reason |

- The relay marks the end of the file as its last step. After each acknowledged chunk it takes a fresh file size. Only when the acknowledged cursor equals that size does it post `{ path, offset, end: true }` with no text. A chunk never carries the mark, because the file can grow while the relay still streams. It sends no mark when it stops at `MAX_CHUNKS` or on a failed post.
- The hook reply names a drain: `{ transcript: { path, after, drain } }`. The relay puts that `drain` on every transcript post of the stream. Two hooks can overlap, so a mark completes only the drain it belongs to.
- `no-transcript` is a new reason code. The spec gains it in this pull request.

- [ ] **Step 1: Write the failing tests.**

| Test name | File | Assertions |
|---|---|---|
| `the tail reports each parsed row once` | `tests/transcript.test.ts` | Three lines in two chunks, one split across the chunks, one that is not JSON. The observer receives the two parsed rows in order, once each. Chat messages are unchanged. A throwing observer does not stop ingestion. |
| `the tail records a dropped line` | same | A line longer than the partial-line cap sets `dropped`. A normal session leaves it false. |
| `usage coverage follows the rule table` | `tests/transcript-usage.test.ts` | One assertion per row of the table, each built from a complete input that differs from the `complete` case in one field. |
| `the tail counts rows, records, and request totals` | same | After the Codex fixture: `rowCount()` is its row count, `recordCount()` is 3, `requestTotal()` is 2650, and `cumulativeTotal()` is 2650. |
| `child-thread rows are detected` | same | A row with `type: "inter_agent_communication_metadata"` sets `sawChildThreads()`. The fixtures leave it false. |
| `the relay marks the end of the file` | the suite that already tests `relay` | With a fake `fetch` and a temporary file: no chunk post carries `end`, and every post carries the reply's `drain`. After the last acknowledged chunk, one text-less post carries `end: true` at the file size. When the file grows after a chunk, the new bytes go first and the mark follows them. When a post fails, the fake worker never advances, or the file needs more than `MAX_CHUNKS` chunks, no mark is posted. |

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `tests/transcript.test.ts`, `tests/transcript-usage.test.ts`, the relay suite, and `npm run typecheck -w @infinite/host`.

### Task 2: worker wiring

**Files:** `types.ts`, `worker.ts`, `demo.ts`, and one integration test in the suite that already starts a rehearsal session with hooks.

**Decisions:**

- `Event["type"]` gains `"usage-coverage"`.
- The worker keeps one `UsageTail` beside its `TranscriptTail`, created with it, with `provider` from the hook route and `requestedModel` from `session.teamModelProfile?.model` for Codex. The tail's observer pushes each row and appends every returned record as a `usage` journal record, exactly as the OpenCode path does.
- **Drain tracking.** When a hook names the transcript, the worker starts a drain record with a new id: `{ id, complete: false, turnEnd }`. `turnEnd` is true when the mapped signals of that hook include `turn-end`, or the hook event is `SessionEnd`. A `transcript` post completes the drain when it has `end: true`, the current path, the current drain's id, and the tail's cursor stands at the end of what the post covers. A chunk is ingested before that test. Any other mark is ignored and answered like a chunk.
- **A changed transcript path.** Before the worker replaces its transcript, it journals the old usage tail's `finish()` records and keeps the old row and record counts. An old drain that is missing or not complete sets a sticky gap, which makes the session `partial` with `drain-incomplete`.
- **Subagents.** A hook whose payload has an `agent_id` sets a `subagents` flag.
- **At provider exit**, inside `exited`, before the lifecycle record: append the records from `finish()`, then one `usage-coverage` record `{ coverage, reason?, records, provider }` from `usageCoverage`. A session with no usage tail appends the record too, so that `hooks-off` and `unsupported` are visible. An OpenCode session appends nothing. A failure here must not stop the exit path.
- The rehearsal provider adds `message.id`, `message.model: "rehearsal-model"`, and a `message.usage` object with fixed small counts to each assistant row.

- [ ] **Step 1: Write the failing integration test.** A rehearsal session with hooks runs one turn and exits. Its journal holds at least one `usage` record with `provider: "claude"`, `modelId: "rehearsal-model"`, and the fixed counts, and exactly one `usage-coverage` record. A second case with hooks off holds no `usage` record and one `usage-coverage` record with `coverage: "none"` and `reason: "hooks-off"`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the integration suite, `tests/usage-service.test.ts` (the ledger must not change), `tests/transcript.test.ts`, and the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

### Task 3: the transcript watch

The independent review of Tasks 1 and 2 found sequences where a session could be marked `complete` with usage missing: bytes that arrive after an end mark, a later hook that names no transcript, an unterminated last row, a replaced Codex transcript with a total mismatch, a Codex session with request rows and no cumulative row, and a failed journal write. This task moves the drain and coverage state out of `worker.ts` into one class that a unit test can drive through each sequence. It supersedes the worker-level state of Task 2.

**Files:** create `packages/host/src/transcript-watch.ts` and `tests/transcript-watch.test.ts`. Modify `transcript.ts`, `transcript-usage.ts`, `worker.ts`, `demo.ts`, `tests/chat.test.ts`.

**Interfaces (produces):**

```ts
// transcript.ts, on TranscriptTail
/** True while an unterminated line waits for its newline. */
get pending(): boolean;
/** Complete lines that were not JSON. Whitespace-only lines do not count. */
discarded: number;

// transcript-usage.ts, on UsageTail
/** Codex: false when request records exist and their total is not the last cumulative total. Otherwise true. */
reconciled(): boolean;

// transcript-watch.ts
export interface CoverageRecord { coverage: UsageCoverage; reason?: UsageCoverageReason; records: number; provider: string }
export class TranscriptWatch {
  constructor(options: { provider: string; requestedModel?: string; onUsage(record: UsageRecord): void });
  /** Every provider hook. Returns what the relay must send when a primary hook names a transcript. */
  hook(input: { subagent: boolean; turnEnd: boolean; transcript?: { path: string; provider: TranscriptProvider } }): { path: string; after: number; drain: number } | undefined;
  /** One post to the transcript route: a chunk or an end mark. Undefined when the post is not for the current transcript. */
  post(body: unknown): { messages: TranscriptMessage[]; after: number } | undefined;
  /** The provider exited. Journals the last usage records and returns the coverage record. */
  finish(hooks: boolean): CoverageRecord;
}
```

**Decisions:**

- **Hooks.** Every hook replaces the last-hook record `{ turnEnd, drain }`. `drain` is the new drain's id when the hook names a transcript, and absent otherwise. A hook from a subagent sets a sticky subagent flag. So any hook after a turn end, with or without a transcript path, ends that turn boundary.
- **Drains.** A hook that names a transcript starts a drain with the next id. A new path first retires the current transcript.
- **End evidence.** A chunk is applied only at the tail's cursor, and a chunk never creates evidence. A text-less post with `end: true` at the cursor stores `{ drain, offset }` when its `drain` is the current drain's id. Nothing else creates evidence.
- **The drain is complete** only when the evidence names the current drain, its offset equals the tail's cursor, the tail has no pending line, and the last hook started that same drain. Bytes that arrive later move the cursor, so old evidence stops counting.
- **Retiring a transcript** journals its `finish()` records, keeps its row and record counts, and keeps four sticky facts: a dropped or discarded line, a drain that was not complete, a failed reconciliation, and child threads.
- **Usage writes.** The watch calls `onUsage` inside a guard. A throw sets a sticky write failure and never stops chat.
- **Refused rows.** `UsageTail.rejectedCount()` counts rows that carry usage and that the parser refused. A Claude row carries usage when it is an `assistant` row with a `message.usage` object and a model that does not start with `<`. A Codex row carries usage when it is a `token_usage_record` row, or a `token_count` row with a `total_token_usage` object.
- **Distinct requests.** The Codex tail keeps the total of each `response_id`, for at most 4,096 ids. A repeated id yields a record only when its total grew. That record holds the whole new snapshot under the same key, and `requestTotal()` sums distinct ids. Past the bound, `reconciled()` is false.
- **A cumulative transcript with no thread id** cannot produce its snapshot record, so `reconciled()` is false for it.
- **Coverage inputs.** `dropped` is true for a dropped line, a discarded line, a refused usage row, or a write failure, now or in a retired transcript. `totalMismatch` is true when any tail fails `reconciled()`. `lastDrain.complete` also needs every retired drain to have been complete. `lastDrain.turnEnd` is the last hook's `turnEnd`.
- **Worker.** `worker.ts` keeps one `TranscriptWatch` and no drain state of its own. The hook handler calls `hook` for every provider hook, the transcript route calls `post` and journals the returned messages, and `exited` appends the coverage record from `finish(hooksReady)` unless the provider is `opencode`.
- **Rehearsal provider.** On `SIGTERM` it waits for its queued hooks, for at most 3 seconds, before it exits. The integration test then needs no timing.

- [ ] **Step 1: Write the failing tests** in `tests/transcript-watch.test.ts`. Build rows with the helpers of `tests/transcript-usage.test.ts`. `onUsage` pushes into an array.

| Test name | Assertions |
|---|---|
| `a turn-end drain that reaches the end of the file is complete` | A turn-end hook, one chunk, then the text-less mark with the drain id. `finish(true)` gives `complete`, and the usage records arrived through `onUsage`. |
| `a chunk never creates end evidence` | A chunk with `end: true` and the drain id, and no mark. `partial`, `drain-incomplete`. |
| `a refused usage row makes the session partial` | A valid usage row and a distinct assistant row whose `output_tokens` is a string. `partial`, `row-dropped`. |
| `a repeated response is counted once` | One Codex response twice with 100 tokens, and a cumulative total of 200. `partial`, `row-dropped`, and one usage record. |
| `a cumulative transcript without a thread id is a gap` | Path A with cumulative rows, no `session_meta`, and a valid mark. Then a complete path B. `partial`, `row-dropped`. |
| `bytes after the end mark reopen the drain` | Complete evidence, then one more applied chunk without `end`. `partial`, `drain-incomplete`. |
| `an end mark for an older drain is ignored` | Hook A, then turn-end hook B. A mark with A's drain id leaves the session `partial`. A mark with B's id makes it `complete`. |
| `a later hook without a transcript ends the turn boundary` | Complete evidence at a turn end, then a hook with `turnEnd: false` and no transcript. `partial`. |
| `a later turn end needs its own evidence` | Complete, then a second turn-end hook. `partial` until a text-less mark at the cursor carries the second drain's id. |
| `an unterminated last row is not complete` | A chunk whose last line has no newline, then the mark. `partial`, `drain-incomplete`, and that row yields no usage record. |
| `a line that is not JSON makes the session partial` | `partial`, `row-dropped`. |
| `a subagent hook makes the session partial` | A subagent hook, then a complete turn-end drain. `partial`, `secondary-missing`. |
| `a changed path retires the old transcript` | Old path complete, new path complete: `complete`, and `records` counts both. Old path not complete: `partial`, `drain-incomplete`. An old Codex tail whose totals do not reconcile: `partial`, `row-dropped`. A retired Codex tail with only cumulative rows journals its snapshot at retirement. |
| `a Codex session reconciles request totals` | Request rows with a matching cumulative row: `complete`. Request rows with no cumulative row: `partial`, `row-dropped`. A mismatch: `partial`, `row-dropped`. |
| `a failed usage write is never complete` | `onUsage` throws once. `partial`, `row-dropped`. The chunk's chat messages are still returned. |
| `a post for another path or offset changes nothing` | Another path returns undefined. A chunk at another offset is not ingested and returns the cursor. An end mark at another offset creates no evidence. |
| `a session without a transcript reports why` | `finish(false)`: `none`, `hooks-off`. `finish(true)` with no transcript: `none`, `no-transcript`. Provider `grok`: `none`, `unsupported`. |
| `chat messages are unchanged` | `post` returns the messages that `TranscriptTail.ingest` returns for the same text. |

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement**, and reduce `worker.ts` to the three calls.
- [ ] **Step 4: Run** `tests/transcript-watch.test.ts`, `tests/chat.test.ts` three times in a row, `tests/transcript.test.ts`, `tests/transcript-usage.test.ts`, `tests/usage-service.test.ts`, `tests/host-launch.test.ts`, and the typecheck.

## Not in this phase

- Secondary transcripts (phase 2b) and the final drain (phase 2c). Until then a session with subagents or a mid-turn stop is `partial`.
- Any ledger or client change (phase 3).

---

# Phase 2b: secondary transcripts

Spec part 2, "Secondary transcripts", and the `secondary-missing` rule of part 3. A Claude Code subagent writes its own transcript, and the session transcript does not hold its usage. This phase reads those files through the relay, so a session with subagents can be `complete`.

## Confirmed layout

Checked on local Claude Code data by name shapes and counts only, on 2026-11-13:

- The primary transcript is `<project>/<session>.jsonl`. Its subagent transcripts are `<project>/<session>/subagents/agent-<name>.jsonl`, flat, with one `agent-<name>.meta.json` beside each. Every one of 1,244 names matches `/^agent-[A-Za-z0-9_-]{1,120}\.jsonl$/`.
- A subagent row with `type: "assistant"` carries `message.id`, `message.model`, and `message.usage` in the shape the primary uses. Of 13,166 such rows, none lacked a field.
- A subagent row's `sessionId` is the parent session.
- Files per session: median 4, 90th percentile 45, maximum 124. Four of 87 sessions hold more than 64.
- A file can be large. The median is 1.5 MB and the largest is about 2 GB.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/transcript-secondary.ts` (create) | The name pattern, the limits, and the wire types that the relay and the watch share. No imports |
| `packages/host/src/hook-relay.ts` (modify) | List the secondary files on the primary end mark, and stream the ones the worker asks for |
| `packages/host/src/transcript-watch.ts` (modify) | Read secondary files, keep their end evidence, and decide the secondary state |
| `packages/host/src/transcript-usage.ts` (modify) | The coverage rule takes the secondary state |
| `packages/host/src/hooks.ts` (modify) | The reply fields |
| `packages/host/src/worker.ts` (modify) | Pass the wanted list through in the transcript reply |
| `packages/host/src/demo.ts` (modify) | A rehearsal subagent transcript, for the end-to-end test |
| `tests/transcript.test.ts`, `tests/transcript-watch.test.ts`, `tests/transcript-usage.test.ts`, `tests/chat.test.ts` (modify) | Tests |
| `docs/architecture.md` (modify) | One sentence on subagent usage |

## Wire protocol

Every new field is optional. An old relay with a new worker, and a new relay with an old worker, behave as phase 2a does.

1. **Ask.** The worker's hook reply is `{ transcript: { path, after, drain, secondaries: true } }` when the transcript's provider is `claude`.
2. **Listing.** The relay streams the primary as today. When it sends the primary end mark, and the reply asked for secondaries, and the route is `claude`, the mark carries `secondaries: { files: [{ name, size, id }], total }`. `id` names the file's identity (device and inode) as an opaque string.
3. **Wanted.** The worker answers the end mark with `{ after, secondaries: [{ name, after }] }`. The list holds the files it wants and the byte each starts at. It is absent when the worker wants none.
4. **Stream.** For each wanted file the relay posts chunks `{ path, secondary: name, offset, text, drain }` and, when the acknowledged cursor is at a fresh size, the text-less end mark `{ path, secondary: name, offset, end: true, drain }`. `path` is always the primary path. The worker answers each post with `{ after }`.

## Review Focus

1. A subagent transcript that grows while the relay reads it. Expect no end mark before the cursor reaches a fresh size, exactly as for the primary.
2. A session with more subagent files than the limit. Expect the first 64 by name to be read, and the session to be `partial` with `secondary-missing`.
3. A listing or a post with a name outside the pattern (`../x.jsonl`, a path, a name the relay did not list). Expect the worker to read nothing from it and the relay to open nothing for it.
4. A new worker on a resumed session whose folder already holds subagent files. Expect them to be read from byte 0, and each record to keep its provider message id, so the ledger can drop the repeat.
5. A subagent hook with no listing at all (an old relay, or a layout the relay does not know). Expect `partial` with `secondary-missing`, never `complete`.

### Task 1: the relay lists and streams secondary files

**Interfaces (produces):**

```ts
// packages/host/src/transcript-secondary.ts
/** The file name of a Claude Code subagent transcript. */
export const SECONDARY_NAME = /^agent-[A-Za-z0-9_-]{1,120}\.jsonl$/;
/** The most secondary transcripts one session lists, streams, and reads. */
export const MAX_SECONDARY_FILES = 64;
/** `id` is the file's identity, `<device>:<inode>` in decimal. A new file under an old name has another id. */
export const SECONDARY_ID = /^[0-9]{1,20}:[0-9]{1,20}$/;
export interface SecondaryListing { files: { name: string; size: number; id: string }[]; total: number }
export interface SecondaryRequest { name: string; after: number }

// packages/host/src/hook-relay.ts
/** The folder that holds a primary transcript's subagent transcripts: the primary path without `.jsonl`, then `subagents`. */
export function secondaryFolder(primary: string): string;
/** The secondary transcripts beside `primary`. Never throws. */
export function listSecondaries(primary: string): SecondaryListing;

// packages/host/src/hooks.ts
export interface HookReply {
  transcript?: { path: string; after: number; drain?: number; secondaries?: boolean };
  after?: number;
  /** The secondary transcripts the worker wants, on the reply to a primary end mark. */
  secondaries?: SecondaryRequest[];
}
```

**Decisions:**

- **What the path checks are for.** The relay and every file it reads belong to the agent's account. A process in that account can read the same files and can write any transcript row, so no path check here is a boundary against it, and none claims to be. The checks keep an honest session from reading the wrong files by accident: a stray symbolic link, a renamed folder, a file swapped during a run. A race that needs a second process in the agent's account to replace a folder between two system calls is outside what they guard. *(My call after review round 2. The design already says usage from this path is the provider's record as relayed and not a host receipt. The primary transcript path has the same trust: the hook payload names it.)*
- **The folder must be real.** The relay resolves the primary's directory with `realpathSync`, joins the session name and `subagents` to it, and uses that folder only when the folder's own real path is the same string. So neither the session folder nor `subagents` is a symbolic link. Otherwise the listing is `{ files: [], total: 0 }` and nothing is streamed. `secondaryFolder(primary)` stays the plain derived path, for a caller that only builds it. *(After review: a link in either component would let the relay list and read files outside the folder derived from the primary.)*
- `listSecondaries` reads the folder with `readdirSync(folder, { withFileTypes: true })`. It keeps an entry that is a regular file by `entry.isFile()`, so a symbolic link and a directory are left out, and whose name matches `SECONDARY_NAME`. `total` is the count of kept entries. `files` holds the first `MAX_SECONDARY_FILES` in ascending name order (plain string comparison), each with the `size` from `lstatSync`. A file whose `lstatSync` throws, or is not a regular file, is left out of `files` and stays in `total`. Any other error, including a missing folder, gives `{ files: [], total: 0 }`. The relay reads each listed file's device and inode with `lstatSync(path, { bigint: true })`, keeps them for the open check, and sends them as the entry's `id`.
- The relay builds the listing at the moment it builds the primary end mark, after the fresh size check, so the listing is newer than the last primary byte it sent.
- The relay streams a wanted entry only when its `name` is in the listing it just sent and its `after` is a safe integer of at least 0. It reads at most `MAX_SECONDARY_FILES` entries of the reply, in the reply's order. It opens the file by name in the real folder with the flags the primary uses (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`), and continues only when the open file is a regular file with the device and inode it listed. *(After review: a folder replaced between the listing and the open cannot redirect the read.)* A name that appears twice in the reply is streamed once.
- One loop serves the primary and a secondary. The primary keeps its budget of 64 passes. All secondaries of one relay run share a second budget of 128 passes, where a pass is one chunk or one end mark. When the budget is spent the relay stops, and the next hook continues from the worker's cursors. *(My call: 128 passes is about 24 MB, which bounds the time a hook can add. A resumed session with many old files catches up over a few hooks.)*
- A secondary stream that stops early (a repeated cursor, a failed post, a shrunk file) does not stop the next wanted file.
- The 4 second process deadline and the 1.5 second post timeout do not change.

- [ ] **Step 1: Write the failing tests** in `tests/transcript.test.ts`. They use a fake `fetch`, as `fakeTranscriptWorker` does, and start no server. Extend that helper or add one beside it. The helper replies to the `claude` route with `{ transcript: { path, after, drain: 7, secondaries: true } }`, answers the primary end mark with a given wanted list, and acknowledges secondary chunks per name.

| Test name | Assertions |
|---|---|
| `the relay lists secondary transcripts on the end mark when asked` | A temp folder holds `s.jsonl`, and in `s/subagents/`: `agent-b.jsonl` (10 bytes), `agent-a.jsonl` (20 bytes), `agent-a.meta.json`, `notes.jsonl`, a directory `agent-dir.jsonl`, and a symbolic link `agent-link.jsonl` to `agent-a.jsonl`. The primary end mark equals `{ path, offset, end: true, drain: 7, secondaries: { files: [{ name: "agent-a.jsonl", size: 20, id }, { name: "agent-b.jsonl", size: 10, id }], total: 2 } }`, where each `id` is that file's `<device>:<inode>` and the two differ. When the reply does not ask, the end mark has no `secondaries` key. When the folder is missing, the listing is `{ files: [], total: 0 }`. |
| `the relay streams the secondary transcripts the worker asks for` | The worker wants `agent-a.jsonl` from 0 and `agent-b.jsonl` from 4. After the primary end mark the posts are, in order: the chunk `{ path, secondary: "agent-a.jsonl", offset: 0, text, drain: 7 }` with all 20 bytes, the mark `{ path, secondary: "agent-a.jsonl", offset: 20, end: true, drain: 7 }`, the chunk for `agent-b.jsonl` from offset 4 with its last 6 bytes, and its mark at offset 10. |
| `the relay opens only the names it listed` | The worker wants `notes.jsonl`, `../s.jsonl`, `agent-missing.jsonl`, `agent-link.jsonl`, an entry whose `after` is `-1`, and the listed `agent-b.jsonl` twice. Only `agent-b.jsonl` is streamed, once. A spy on `openSync` (installed with `syncBuiltinESMExports`) sees exactly one open under the `subagents` folder, for `agent-b.jsonl`. |
| `a symbolic link in the secondary folder path is not listed` | With `s/subagents` a symbolic link to a folder that holds `agent-x.jsonl`, the end mark's listing is `{ files: [], total: 0 }`. The same holds when `s` itself is a symbolic link to a folder that holds `subagents/agent-x.jsonl`. |
| `a file replaced after the listing is not streamed` | The fake worker replaces `agent-a.jsonl` with a new file of the same name while it answers the end mark. No post carries `secondary: "agent-a.jsonl"`. Without the replacement, the same reply streams it. |
| `a secondary that grows while it is read ends at the new size` | The file grows while its first chunk is in flight. A second chunk carries the new bytes, and the end mark is at the new size. |
| `a route other than claude never lists` | A `codex` hook whose reply asks for secondaries gets an end mark with no `secondaries` key. |
| `more than 64 secondary files are listed as a cut` | With more than 64 matching files, `total` is their count, and the names in `files` equal, in full and in order, the first 64 of the sorted names. |
| `the secondary budget is shared and stops the stream` | One secondary of 25 MB and one small secondary, both wanted from 0. The posts with a `secondary` key number 128, none is an end mark, and none names the small file. |
| `a secondary that stops early does not stop the next one` | The worker never advances its cursor for `agent-a.jsonl` and advances for `agent-b.jsonl`. `agent-a.jsonl` gets one chunk and no mark. `agent-b.jsonl` gets its chunk and its mark. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement** `transcript-secondary.ts`, the relay changes, and the `HookReply` fields.
- [ ] **Step 4: Run** `node --import tsx --test tests/transcript.test.ts`, then `npm run typecheck -w @infinite/host`. The existing relay tests must pass unchanged, because every new field is optional.

### Task 2: the watch reads secondary transcripts and decides coverage

**Interfaces (consumes):** task 1.

**Interfaces (produces):**

```ts
// packages/host/src/transcript-watch.ts
export class TranscriptWatch {
  hook(input: WatchHook): { path: string; after: number; drain: number; secondaries?: true } | undefined;
  post(body: unknown): { messages: TranscriptMessage[]; after: number; secondaries?: SecondaryRequest[] } | undefined;
  finish(hooks: boolean): CoverageRecord;   // unchanged
}
/** Whether a hook closes a turn with nothing left running: the `SessionEnd` event, or a `turn-end` signal with no background task. */
export function closesTurn(signals: readonly { kind: string; backgroundTasks?: number; failed?: boolean }[], event: string): boolean;

// packages/host/src/transcript-usage.ts
export type SecondaryState = "none" | "complete" | "missing";
export interface UsageCoverageInput {
  // `subagents: boolean` is replaced by:
  /** `none`: no subagent hook arrived and no secondary transcript is known. `complete`: every known one reached its end in the last drain. */
  secondary: SecondaryState;
  // the other fields do not change
}
```

**Decisions:**

- `hook` adds `secondaries: true` when the hook's transcript provider is `claude`.
- **A subagent hook never opens or replaces the primary transcript.** When a hook from a subagent names a file other than the primary the watch already reads, or the watch reads none yet, the watch treats the hook as naming no transcript. When it names the current primary, it starts a drain like any other hook. *(My call after the worker's report: the documented payload names the main transcript on every hook, and this rule keeps the watch correct if a payload ever names the subagent's own file.)*
- The current transcript keeps a map from name to a secondary reader, and the last listing. A secondary reader is a `TranscriptTail` with `remember` 1, whose row observer feeds a `UsageTail` built with `{ provider: "claude", secondary: true }` and no requested model. Its chat messages are discarded, so `post` returns `messages: []` for every secondary post. Each reader keeps its own end evidence `{ drain, offset }`, its required size (the largest size any listing gave for its file), and the `id` of the file it first read.
- **Listing.** A primary end mark creates the listing only when it is applied, its `drain` is the current drain, and it carries a `secondaries` value. A valid listing is an object whose `files` is an array of at most `MAX_SECONDARY_FILES` entries, each with a `name` that matches `SECONDARY_NAME`, a safe integer `size` of at least 0, and an `id` that matches `SECONDARY_ID`, with no repeated name, and whose `total` is a safe integer of at least `files.length`. An invalid value is recorded as a cut listing with no files.
- For each listed file, the watch finds its reader or creates one, and raises the reader's required size to the listed size when that is larger. It creates no reader beyond `MAX_SECONDARY_FILES` for one primary transcript.
- **A transcript is cut**, and stays cut, from the first listing that is invalid, or whose `total` is greater than `files.length`, or that names a file beyond the reader limit, or that gives a reader's file another `id`, or that gives it a size below its required size or below the bytes the reader has already read. *(After review round 3: a file can grow while the relay reads it, so the reader's offset can be past every listed size.)* A replaced or shortened file is not read again: its reader's offset belongs to bytes that no longer exist. *(After review round 2: a new file under an old name, with the old length, must not inherit the old cursor.)* The secondaries of a cut transcript are never complete. *(After review: a later empty listing must not erase the knowledge that files existed and were not read.)*
- A listed file whose `size` equals its reader's offset, with no pending line, gets end evidence for this drain from the listing itself. *(My call: the listing is the relay's fresh size check, so a post per unchanged file adds nothing.)* A file whose `size` is greater than the offset loses any end evidence it had, and goes into the wanted list as `{ name, after: offset }`. Any other file gets neither.
- The reply to the end mark carries `secondaries` only when the wanted list is not empty.
- **Secondary posts.** A post whose `secondary` is a string belongs to that reader. An unknown name, or a `path` that is not the current primary, returns undefined. A chunk is applied only when its `offset` equals the reader's offset. A text-less end mark that is applied, and whose `drain` is the current drain, records the reader's end evidence. A chunk never records evidence.
- **Secondary facts belong to a transcript.** Each transcript keeps its own: whether a subagent hook arrived while it was the primary, whether any listing reported a file or was invalid, its readers, and whether it is cut. A subagent hook that arrives before any transcript is open counts for the first transcript that opens. *(After review round 2: a later transcript's reader must not answer for an earlier transcript's subagent.)*
- **Secondary state of one transcript:**
  - `none` when it saw no subagent hook, has no reader, and no listing of it ever reported a file or was invalid.
  - `complete` when it has at least one reader and its secondaries are complete.
  - `missing` in every other case. A subagent hook with no reader is therefore `missing`.
- **Secondary state of the session**, decided in `finish`: the worst state over the current transcript and every replaced one, where `missing` is worse than `complete`, and `complete` is worse than `none`.
- The current transcript's secondaries are complete when the transcript is not cut, the last listing belongs to the current drain, the last hook started that drain, and every reader of the transcript is in that listing with end evidence for that drain at its present offset, an offset of at least its required size, and no pending line. *(After review: an end mark below the listed size, which a truncated file produces, proves nothing about the bytes that were listed.)*
- **A turn end with background tasks is not a turn boundary.** `closesTurn(signals, event)` is true for the `SessionEnd` event, and for a `turn-end` signal that is not `failed` and whose `backgroundTasks` is 0 or absent. A failed turn end carries no task count, so it proves nothing about what still runs. `worker.ts` passes its result as `turnEnd`. A subagent that runs in the background keeps writing usage after the turn's last hook, so that turn end cannot prove that every row was read, and the session is `partial` with `stopped-mid-turn`. *(My call. Known cost: a session that leaves a background shell running is `partial` too, because the hook payload's task list is counted and not typed. Revisit when the task type is confirmed.)*
- **Replaced transcript.** When the primary path changes, each reader of the old transcript is finished: its usage is journaled, its rows and records join the retired counts, and a dropped line, a discarded line, or a refused row sets the retired dropped fact. The old transcript's secondary state at that moment joins the retired state by the worst-state rule. The old transcript must also have ended at a boundary: when its last drain was complete and the last hook was not a turn boundary, the session's last drain counts as not at a turn end, and the session is `partial` with `stopped-mid-turn`. The new transcript starts with no readers, no listing, and no subagent hook. *(After review round 2: a later transcript's turn end must not answer for an earlier transcript that never reached one.)*
- **Counts.** `rows` and `records` in the coverage input include every secondary reader. `dropped` is also true when a secondary reader dropped or discarded a line or refused a row.
- `usageCoverage` returns `partial` with `secondary-missing` when `secondary` is `missing`. The rule order does not change: `secondary-missing` follows `stopped-mid-turn` and precedes `child-threads`.
- `worker.ts`: `onTranscript` returns `{ after, secondaries }` when the watch's reply has a wanted list, and `{ after }` otherwise.
- `demo.ts`: when the request contains `subagent`, the rehearsal writes one assistant row to `agent-rehearsal.jsonl` in the secondary folder of its transcript, before it writes its last assistant row. The row has `isSidechain: true`, a message id `msg-demo-sub-<pid>`, the model `rehearsal-sub-model`, and usage `input_tokens: 200`, `output_tokens: 50`, with both cache counts 0. It creates the folder with mode `0700` and the file with mode `0600`. It posts no extra hook.
- `docs/architecture.md`: after the sentence that says subagent records are dropped from chat, add one sentence: a Claude Code subagent's usage is read from its own transcript file in the session's `subagents` folder, through the same relay, and never becomes chat.

- [ ] **Step 1: Write the failing tests.**

In `tests/transcript-watch.test.ts`. Add a helper for a subagent row: `claudeRow` with `isSidechain: true`. `N` is the byte length of that row.

| Test name | Assertions |
|---|---|
| `a Claude hook asks for secondaries and a Codex hook does not` | The Claude hook returns `{ path, after: 0, drain: 1, secondaries: true }`. The Codex hook's result has no `secondaries` key. |
| `a listed secondary is read and counted` | After a primary row and its chunk, the end mark with `secondaries: { files: [{ name: "agent-a.jsonl", size: N }], total: 1 }` returns `secondaries: [{ name: "agent-a.jsonl", after: 0 }]`. The secondary chunk returns `{ messages: [], after: N }`. After the secondary end mark, `finish(true)` is `{ coverage: "complete", records: 2, provider: "claude" }`. The second usage record has `secondary: true`, and the first does not. |
| `an unchanged secondary needs no stream` | After the test above's drain, a second turn-end hook and a primary end mark with the same listing return no `secondaries` key, and `finish(true)` is `complete`. |
| `a secondary that grew and was not read is partial` | The second drain's listing gives `size: N + 10`. With no secondary post, `finish(true)` is `partial` with `secondary-missing`. |
| `a subagent hook with no secondary transcript is partial` | A hook with `subagent: true`, then a complete turn-end drain whose end mark carries `secondaries: { files: [], total: 0 }`. `finish(true)` is `partial` with `secondary-missing`. The same holds when the end mark carries no `secondaries` key. This replaces `a subagent hook makes the session partial`. |
| `a subagent hook whose secondary is read is complete` | A hook with `subagent: true`, then a turn-end drain that lists and reads one secondary to its end. `finish(true)` is `complete`. |
| `a session without subagents is complete with an empty listing` | No subagent hook, and an end mark with `secondaries: { files: [], total: 0 }`. `finish(true)` is `complete`. |
| `a cut listing is partial` | A listing `{ files: [one file], total: 2 }` whose one file is read to its end gives `partial` with `secondary-missing`. |
| `the watch keeps at most 64 secondary readers` | A first drain lists 64 names, each of size 0. A second drain lists 64 other names, each of size 5. The second reply's wanted list is absent. A post for a name of the second listing returns undefined, because no reader was created, and a post for a name of the first listing returns that reader's offset. `finish(true)` is `partial` with `secondary-missing`. |
| `an invalid listing is a cut listing` | Each of these listings returns no wanted list and gives `secondary-missing` after a subagent hook: a `files` entry named `../x.jsonl`, an entry with `size: -1`, an entry with no `id`, an entry whose `id` is `abc`, 65 entries, a repeated name, a `total` below `files.length`, and a `secondaries` value that is a string. Each fixture is wrong in one way only, and the same shape with nothing wrong is accepted. |
| `a secondary post for an unknown name or a wrong offset changes nothing` | A post for `agent-zz.jsonl` returns undefined. A chunk for a known name at a wrong offset returns `{ messages: [], after }` with the reader's own offset, and no usage record appears. |
| `a secondary end mark for an older drain is ignored` | A secondary grows between two drains. In the second drain the worker asks for the new bytes and reads them. With an end mark that names the second drain, `finish(true)` is `complete`. With the same posts and an end mark that names the first drain, it is `partial` with `secondary-missing`. |
| `a subagent hook never opens or replaces the primary transcript` | A subagent hook that names a file returns undefined before any primary hook, and again after the primary is open when it names another file. A subagent hook that names the primary returns the primary path and the current offset. The primary is read once: one usage record, and `finish(true).records` is 1. |
| `a cut or invalid listing stays partial` | With no subagent hook, a listing `{ files: [], total: 3 }` and a listing that is a string each give `partial` with `secondary-missing`. Each still does after a later turn-end drain with a valid empty listing. |
| `a secondary end mark below the listed size is not complete` | A listing gives one file of size N. An end mark for it at offset 0 in the current drain is acknowledged, and `finish(true)` is `partial` with `secondary-missing`. |
| `a repeated listing with a larger size withdraws the evidence` | In one drain, a listing gives the file size 0, and a second end mark gives it size N. The second reply wants the file from 0. With no secondary bytes, `finish(true)` is `partial` with `secondary-missing`. |
| `a file that shrank is not complete` | A file read to N has evidence. The next drain lists it at a smaller size. The reply does not want it, and `finish(true)` is `partial` with `secondary-missing`. |
| `interleaved relay runs read a secondary once` | Two drains. The older run's chunk at offset 0 is applied. The newer run's chunk at offset 0 is not applied and returns the reader's offset. The older run's end mark gives no evidence, and the newer run's end mark does. `finish(true)` is `complete` with one secondary usage record. |
| `a turn end with background tasks is not a turn boundary` | `closesTurn` is true for a `turn-end` signal with `backgroundTasks` 0, for one with no `backgroundTasks`, and for the `SessionEnd` event with no signal. It is false for a `turn-end` signal with `backgroundTasks` 2, for a `turn-end` signal with `failed: true`, and for any other signal and event. |
| `a replaced secondary file cuts the transcript` | A file is read to its end and the session is `complete`. The next drain lists the same name and size with another `id`. The reply does not want it, and `finish(true)` is `partial` with `secondary-missing`. It stays so after a later drain lists the first `id` again. |
| `a shortened secondary file cuts the transcript` | After `a file that shrank is not complete`, a later drain lists the file larger than before. The reply does not want it, a chunk posted for it is refused, and `finish(true)` is still `partial` with `secondary-missing`. |
| `a file truncated below the bytes already read cuts the transcript` | A listing gives the file its first size. The reader takes a second chunk that the relay found while streaming, and ends past the listed size. The next drain lists the file at the first size again: the reply wants nothing. The drain after that lists it at the longer size: the reply wants nothing, a post for it is refused, and `finish(true)` is `partial` with `secondary-missing`. |
| `a replaced transcript keeps its missing subagent` | Transcript A is open, gets a subagent hook, and has a complete turn-end drain with an empty listing. Transcript B opens, lists one file, reads it to its end, and ends its turn. `finish(true)` is `partial` with `secondary-missing`. |
| `a transcript replaced mid-turn is not complete` | Transcript A has a complete drain from a hook that is not a turn boundary. Transcript B opens and has a complete turn-end drain. `finish(true)` is `partial` with `stopped-mid-turn`. When A's last hook is a turn boundary, the same sequence is `complete`. |
| `a listing for an older drain is ignored` | A primary end mark that names an older drain and carries a listing creates no reader and returns no wanted list. |
| `an unterminated last row in a secondary is not complete` | A secondary chunk with no final newline, then its end mark, gives `partial` with `secondary-missing`. |
| `a refused usage row in a secondary makes the session partial` | A secondary row whose output count is a string gives `partial` with `row-dropped`. |
| `a changed primary path retires its secondaries` | The first transcript has one secondary read to its end, and the second transcript has none and a complete drain with an empty listing. `finish(true)` is `complete` with `records` counting both transcripts. When the first transcript's secondary was listed and not read, `finish(true)` is `partial` with `secondary-missing`. |

In `tests/transcript-usage.test.ts`, the rule table test uses `secondary: "none"` for the complete case, asserts `partial` with `secondary-missing` for `secondary: "missing"`, and asserts `complete` for `secondary: "complete"`.

In `tests/chat.test.ts`:

| Test name | Assertions |
|---|---|
| `a rehearsal subagent's usage is journaled from its own transcript` | A demo session with the prompt `hook dialog subagent` runs the dialog flow of the existing usage test and is stopped. The `usage` events include one with `secondary: true`, `modelId: "rehearsal-sub-model"`, `tokens.input` 200, and `tokens.output` 50. The single `usage-coverage` event is `complete` with no reason. No chat message holds the subagent row's text. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/transcript-watch.test.ts tests/transcript-usage.test.ts tests/transcript.test.ts`, then `npm run typecheck -w @infinite/host`. `tests/chat.test.ts` starts a host, so the coordinator runs it.
- [ ] **Step 5: The coordinator runs `tests/chat.test.ts` and `npm run check`, requests the independent review, and commits.**

## Not in this phase

- The final drain (phase 2c). A member stopped mid-turn stays `partial`.
- Codex child threads. They stay `partial` with `child-threads`.
- Any ledger or client change (phase 3).

---

# Phase 2c: the final drain

Spec part 2, "Final drain", part 3 (coverage), and owner decision 3, settled on 2026-11-13: the wrapper is added. Owner decision 2, Codex hooks on by default, was withdrawn the same day on the result of spike S2 (Task 4). A provider that the host stops mid-turn fires no further hook, so the rows it wrote after its last hook never reach the worker. In this phase the worker starts the relay once in drain mode after the provider exits, and serves it for at most 10 seconds. The drain reuses the transcript route, drain ids, end marks, and the secondary listing, so the watch has no second read path. A session stopped mid-turn stays `partial` with `stopped-mid-turn`, and a drain that could not run is visible in the coverage record. Member launch, hook payloads, the 4 second hook deadline, the pass budgets, the relay's path checks, and the usage ledger do not change.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/final-drain.ts` (create) | The 10 second limit, the drain command for a profile, and one run of it |
| `packages/host/src/sudo-profile.ts` (create), `packages/host/src/launch.ts` (modify) | `sudoShape`, the one check of a sudo profile's arguments, shared by `teamModelLaunch` and `drainLaunch` |
| `packages/host/src/hook-relay.ts` (modify) | Drain mode: ask the worker what to read, then stream as a hook does |
| `deploy/ubuntu/transcript-drain.sh` (create) | The root-owned wrapper that runs the relay in drain mode as the agent account |
| `deploy/ubuntu/infinite.sudoers`, `deploy/ubuntu/README.md` (modify) | The sudoers line and the install step |
| `packages/host/src/transcript-watch.ts` (modify) | Start the final drain, keep the turn boundary across a stop, state the drain in the coverage record |
| `packages/host/src/transcript-usage.ts` (modify) | The `drain-skipped` reason |
| `packages/host/src/hooks.ts` (modify) | The `drain` route |
| `packages/host/src/worker.ts` (modify) | Run the drain after the exit record, serve its posts, then journal coverage |
| `packages/host/src/demo.ts` (modify) | A row written after the last hook, and an early drain post |
| `packages/host/src/config.ts`, `packages/host/src/cli.ts` (modify) | The comment and the `doctor` warning that say what the Codex hook flag allows (Task 4) |
| `README.md`, `docs/architecture.md`, `docs/security.md`, the 2026-10-04 attention spec, the usage capture spec (modify) | The drain, the reason code, and the corrected statements about the Codex hook flag |
| `tests/final-drain.test.ts` (create); `tests/transcript.test.ts`, `tests/transcript-watch.test.ts`, `tests/transcript-usage.test.ts`, `tests/chat.test.ts` (modify) | Tests |

## Wire protocol

1. **Start.** The relay in drain mode posts the body `{}` to the `drain` hook route. While the drain window is open, the worker answers `{ transcript: { path, after, drain, secondaries? } }` from `TranscriptWatch.drainFinal()`. Otherwise it answers 204, and the relay exits.
2. **Stream.** Exactly as a hook-started drain: chunks and the text-less end mark go to `transcript` with the reply's `drain`, the listing rides on the primary end mark when the reply asks, and the wanted secondaries follow.

What differs from a hook-started drain:

- The start route and body. There is no provider payload, no Codex rollout lookup, and no stdin.
- The relay lists secondaries when the reply asks, whatever the route. The watch asks only for a Claude transcript.
- The relay's process deadline is 10 seconds, not 4. The pass budgets (64 primary, 128 secondary) do not change.
- The drain takes the turn boundary of the last provider hook, not one of its own.
- The worker serves it only after provider exit, in one window that ends when the relay process exits (after its last end mark) or 10 seconds pass. A second start inside the window returns the same drain with the current cursor.

## Review Focus

1. **The drain cannot run:** a sudo deployment without the wrapper, or with an old sudoers file that refuses it. Expect no wait for the limit, `finalDrain: "skipped"`, `drain-skipped` for a session that needed the drain, and `complete` for a session stopped idle at a clean turn end. (Tasks 1, 2, 3.)
2. **`SessionEnd` after a host stop.** A provider stopped mid-turn fires `SessionEnd` on its way out. Expect `partial` with `stopped-mid-turn`, also when the final drain reaches the end of the file. (Task 2.)
3. **A drain that hangs.** Expect the window to close at 10 seconds, the process to get `SIGTERM`, later posts to be refused, and one coverage record after the last usage record. (Tasks 1, 2, 3.)
4. **A drain post that is not the worker's own:** one sent while the provider runs, a second start, or an end mark from an orphaned hook relay. Expect the first to change nothing, the second to return the same drain and reset nothing, and the last to give no evidence. A start that arrives before the worker's relay must not keep that relay from reading. (Tasks 2, 3.)
5. **An idle stop with nothing new.** A member stopped after a clean turn end, whose final drain finds no new bytes. Expect `complete` with `finalDrain: "complete"`. (Tasks 2, 3.)

### Task 1: the drain process

**Files:** create `final-drain.ts`, `sudo-profile.ts`, `deploy/ubuntu/transcript-drain.sh`, `tests/final-drain.test.ts`. Modify `hook-relay.ts`, `launch.ts`, `deploy/ubuntu/infinite.sudoers`, `deploy/ubuntu/README.md`, `tests/transcript.test.ts`.

**Interfaces (produces):**

```ts
// packages/host/src/final-drain.ts (node built-ins and a type import of AgentProfile only)
/** The longest a final drain runs: the worker's window and the relay's process deadline. */
export const FINAL_DRAIN_MS = 10_000;
/** The wrapper's file name, beside the provider wrapper that a sudo profile names. */
export const DRAIN_WRAPPER = "transcript-drain";
/** The command that runs the relay in drain mode in the provider's account. Undefined when it cannot run. */
export function drainLaunch(profile: AgentProfile, relayPath: string): { command: string; args: string[] } | undefined;
/** Runs the command once. Resolves when it exits, fails to start, or `limitMs` passes. Never rejects. */
export function runFinalDrain(launch: { command: string; args: string[] }, env: Record<string, string>, limitMs?: number): Promise<void>;

// packages/host/src/hook-relay.ts
/** The final drain: asks the `drain` route what to read, then streams it as a hook-started drain does. */
export async function drain(options: RelayOptions): Promise<void>;
```

`deploy/ubuntu/transcript-drain.sh`, in full:

```sh
#!/bin/sh
# The final transcript drain: after a provider exits, the worker runs the hook relay once more as the
# agent account. It takes no arguments. The worker's authenticated reply names the transcript, and
# sudo's env_keep passes the hook address and token.
set -eu
umask 077
ulimit -c 0
if [ "$#" -ne 0 ]; then
  printf 'transcript-drain takes no arguments\n' >&2
  exit 64
fi
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/node /opt/infinite/packages/host/dist/hook-relay.js drain
```

`deploy/ubuntu/infinite.sudoers` gains, after the `repository-graph` line:

```
# The final transcript drain after a provider exits. No arguments: the worker's reply names the file.
infinite-host ALL=(infinite-agent) NOPASSWD: /usr/local/libexec/infinite/transcript-drain ""
```

**Decisions:**

- **Same account.** When `profile.command` does not match `/(^|\/)sudo$/`, `drainLaunch` returns `{ command: process.execPath, args: [relayPath, "drain"] }`, with `"--import", import.meta.resolve("tsx")` first when `relayPath` ends in `.ts`, as `buildLaunch` does. The relay runs in the worker's account, which is the provider's. A command that is not sudo but switches account is treated the same way. Its relay cannot open the file, so its drain starts and reads nothing. *(My call: the code already tells the two shapes apart by the sudo pattern.)*
- **Another account.** For a sudo profile, the options before `--` must be only `-n`, `--non-interactive`, `-H`, `--set-home`, `-u USER`, `--user USER`, `-g GROUP`, or `--group GROUP`: the check `teamModelLaunch` makes. Move that check into one shared function, `sudoShape` in `packages/host/src/sudo-profile.ts` (node built-ins only), and do not copy it. `teamModelLaunch` keeps its error messages. The executable after `--` must be absolute. The wrapper is `join(dirname(executable), DRAIN_WRAPPER)`, and it is present when `statSync(wrapper).isFile()`. The command is `profile.command` with `["-n", ...the other options in order, "--", wrapper]`. A missing wrapper or any other shape returns undefined. *(My call: the wrapper sits beside the provider wrapper the owner installed, so no config field is added. A profile without `-n` still gets it, so sudo never waits for a password.)*
- sudo refuses a command its policy does not list and exits at once. The relay then never posts `drain`, and the watch reports the drain as `skipped` (Task 2). The worker waits only until the process exits.
- `runFinalDrain` spawns with `stdio: "ignore"` and exactly the given env. At `limitMs` (default `FINAL_DRAIN_MS`) it resolves and sends `SIGTERM`. sudo passes the signal to the relay. A throwing spawn or an `error` event resolves at once.
- `drain(options)` posts `{}` to `drain` and handles the reply as `relay` handles a hook reply. Move the transcript block of `relay` into one function that both call. For `relay`, listing stays limited to the `claude` route. For `drain`, the reply's `secondaries: true` decides.
- The entry block: when `process.argv[2]` is `drain`, the deadline is `FINAL_DRAIN_MS` (imported from `final-drain.ts`), no body is read from argv or stdin, and it calls `drain`. Other routes do not change.
- The wrapper follows `agent-wrapper.sh`: `set -eu`, `umask 077`, `ulimit -c 0`, a fixed `PATH`, and absolute paths. It refuses every argument with exit 64, and the sudoers `""` allows none. It does not load `agent-env.sh`, because the drain needs no project secret.
- `deploy/ubuntu/README.md`, in the paragraph that installs `agent-wrapper.sh`: install `transcript-drain.sh` as `/usr/local/libexec/infinite/transcript-drain`, `root:root`, mode `0755`, then reinstall the sudoers file with `visudo -cf`. Without it, sudo sessions report `finalDrain: "skipped"`.

- [ ] **Step 1: Write the failing tests.**

| Test name | File | Assertions |
|---|---|---|
| `the drain relay asks the worker what to read and streams it like a hook` | `tests/transcript.test.ts` | With `fakeSecondaryWorker` extended to record its first request: that request goes to `/drain` with body `"{}"`. Its reply names drain 9 with `secondaries: true`. The posts are the primary chunk with `drain: 9`, the end mark with `drain: 9` and the listing, then each wanted secondary's chunk and mark with `drain: 9`. |
| `the drain relay lists secondaries only when the reply asks` | same | A reply without `secondaries` gives an end mark with no `secondaries` key. |
| `the drain relay does nothing when the worker has nothing to drain` | same | A 204 reply: exactly one request, to `/drain`, and no `transcript` post. |
| `a same-account profile drains with the relay itself` | `tests/final-drain.test.ts` | For `{ command: "claude", args: [] }` and `/opt/infinite/packages/host/dist/hook-relay.js`: `{ command: process.execPath, args: [that path, "drain"] }`. For a `.ts` relay, `args[0]` is `--import` and the last two are the path and `drain`. |
| `a sudo profile drains through the wrapper beside its provider` | same | A temporary folder holds files `claude` and `transcript-drain`. `{ command: "/usr/bin/sudo", args: ["-H", "-u", "agent", "--", <folder>/claude, "--model", "m"] }` gives `{ command: "/usr/bin/sudo", args: ["-n", "-H", "-u", "agent", "--", <folder>/transcript-drain] }`. With `-n` already in the profile, `-n` appears once. |
| `a missing wrapper or an unknown sudo shape skips the drain` | same | Undefined for: no wrapper file; a folder named `transcript-drain`; `-E` before `--`; no `--`; a relative executable. |
| `a drain that outlives the limit is stopped` | same | A node child that writes its pid to a file and never exits, with `limitMs` 300: the promise resolves within 2,000 ms, and the pid is gone within 2,000 ms after that. |
| `a drain resolves when its process exits or cannot start` | same | A child that exits with code 3, with `limitMs` 10,000, resolves within 3,000 ms. A missing command resolves and never rejects. |
| `the drain wrapper takes no arguments` | same | `/bin/sh deploy/ubuntu/transcript-drain.sh extra` exits 64 with `no arguments` on stderr. The script's last line is the `exec` line above. |
| `sudoers allows the drain wrapper only without arguments` | same | The file holds the line above, and no line names `transcript-drain` with `*`. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/final-drain.test.ts tests/transcript.test.ts`, then `npm run typecheck -w @infinite/host`. Neither file starts a server. The existing relay tests must pass unchanged.

### Task 2: the watch decides the final drain

**Files:** modify `transcript-watch.ts`, `transcript-usage.ts`, `tests/transcript-watch.test.ts`, `tests/transcript-usage.test.ts`.

**Interfaces (produces):**

```ts
// packages/host/src/transcript-watch.ts
export type FinalDrainState = "complete" | "incomplete" | "skipped";
export interface CoverageRecord {
  coverage: UsageCoverage; reason?: UsageCoverageReason; records: number; provider: string;
  /** Present only when `finish` was told a drain was owed and a primary transcript was open. */
  finalDrain?: FinalDrainState;
}
export interface WatchHook {
  // subagent, turnEnd, and transcript do not change
  /** The hook is the provider's `SessionEnd`. */
  sessionEnd?: boolean;
}
export class TranscriptWatch {
  /** A primary transcript is open, so a final drain has a file to read. */
  get reading(): boolean;
  /** The host asked the provider to stop. Idempotent. */
  stopRequested(): void;
  /** Starts the final drain on the current transcript, once per session. */
  drainFinal(): { path: string; after: number; drain: number; secondaries?: true } | undefined;
  /** With `finalDrain` true, the provider exited and a drain was owed: the record states it, and the watch closes. */
  finish(hooks: boolean, finalDrain?: boolean): CoverageRecord;
}

// packages/host/src/transcript-usage.ts
export type UsageCoverageReason = /* the existing codes */ | "drain-skipped";
export interface UsageCoverageInput { /* existing fields, and: */ finalDrain?: "complete" | "incomplete" | "skipped" }
```

**Decisions:**

- `drainFinal()` returns undefined when no primary transcript is open, or after a closing `finish`. The final drain is created once. While the watch is open, a later call returns the same drain: its id, the primary transcript's current cursor as `after`, and `secondaries` as the first start had it. It starts no new drain and resets no evidence. *(Decided after review: any process of the agent's account holds the hook token and can post a start first. A start that returned nothing would then keep the worker's own relay from reading the rows after the last hook.)* End evidence holds only for the cursor it was posted at, so an end mark posted before later bytes arrived does not complete the drain. The first call goes through `receiveHook` with `subagent: false`, the current path and provider, and the last hook's `turnEnd` (false when none), and keeps the new drain's id as the final drain. `Current` keeps its provider for this. Only a `claude` transcript asks for secondaries.
- After `drainFinal()`, `hook()` returns undefined and changes nothing. *(My call: the provider has exited, so a late hook cannot describe a turn.)* Posts work as today: a chunk at the cursor is applied whatever its drain, and only a mark with the final drain's id gives evidence.
- The final drain is the last drain. A final drain that started and did not reach the end gives `drain-incomplete`, even when the last hook's drain was complete. *(My call: once the relay reads after exit, a cut-off drain may have left rows unread, and the watch cannot tell "nothing new" from "not read".)*
- The final drain takes the last provider hook's turn boundary. After a hook that was not a turn boundary, a final drain that reaches the end gives `stopped-mid-turn`, as the spec requires. After a clean turn boundary it gives `complete`, with or without new bytes. *(My call: after exit the file stops growing, and a request after a clean turn end that fired no hook is not a case the providers are known to produce.)*
- **`SessionEnd` after a stop.** `stopRequested()` sets a sticky flag. A hook with `sessionEnd: true` after it takes the `turnEnd` of the hook before it instead of its own. A turn-end signal after the stop still closes the turn. Without a stop request, `SessionEnd` keeps its Phase 2b meaning. *(My call: Claude Code may run its `SessionEnd` hook when it gets `SIGTERM`, which proves the process is ending, not that the turn ended. A `Stop` hook overtaken by the stop request still proves the turn ended, and the rehearsal relies on that.)*
- `finalDrain` in the record: `skipped` when no final drain started; `complete` when the final drain is the current drain and the existing `complete(current)` test holds; `incomplete` otherwise. It describes the primary transcript. Secondaries keep their own reason.
- `finish(hooks, true)` closes the watch: later `hook`, `post`, and `drainFinal` return undefined, so no usage record follows the coverage record. `finish(hooks)` keeps today's behavior, so the Phase 2a and 2b tests do not change.
- `usageCoverage` gains one row. Rows 6 to 8 become:

| Order | Condition | Result |
|---|---|---|
| 6 | `finalDrain` is `skipped`, and `lastDrain` is missing, not complete, or not at a turn end | `partial`, `drain-skipped` |
| 7 | no `lastDrain`, or `lastDrain.complete` is false | `partial`, `drain-incomplete` |
| 8 | `lastDrain.turnEnd` is false | `partial`, `stopped-mid-turn` |

  The other rows keep their order. *(My call: the spec has no reason for a drain that could not run. A distinct reason tells the owner that a wrapper is missing, in phase 3's sessions-by-reason view, without a new column. A skipped drain after a clean idle stop loses nothing the watch can know of, so that session stays `complete`, and only `finalDrain` shows the skip.)*

- [ ] **Step 1: Write the failing tests** in `tests/transcript-watch.test.ts`, with the existing helpers. Row A and row B are two `claudeRow` values. Every `finish` below is `finish(true, true)` unless stated.

| Test name | Assertions |
|---|---|
| `the final drain reads rows written after the last hook` | A turn-end hook, row A, and a mark for drain 1. `reading` is true. `drainFinal()` returns `{ path, after: bytes(A), drain: 2, secondaries: true }`. Row B and a mark for drain 2 at the end: `{ coverage: "complete", records: 2, provider: "claude", finalDrain: "complete" }`, and `onUsage` got both records. |
| `an idle stop with no new bytes stays complete` | A complete turn-end drain, `drainFinal()`, and a mark for drain 2 at the same cursor: `complete`, `records: 1`, `finalDrain: "complete"`. |
| `a final drain after a mid-turn hook stays stopped-mid-turn` | The first test with `turnEnd: false`: `{ coverage: "partial", reason: "stopped-mid-turn", records: 2, provider: "claude", finalDrain: "complete" }`. |
| `a final drain that does not reach the end is incomplete` | A complete turn-end drain, `drainFinal()`, and row B with no mark: `partial`, `drain-incomplete`, `finalDrain: "incomplete"`. The same with no post after `drainFinal()`. |
| `a skipped final drain is visible` | No `drainFinal()`. A complete turn-end drain: `complete`, `finalDrain: "skipped"`. A complete drain from a `turnEnd: false` hook: `partial`, `drain-skipped`. A turn-end drain with no mark: `partial`, `drain-skipped`. The mid-turn case with `finish(true)`: `partial`, `stopped-mid-turn`, and no `finalDrain` key. |
| `an end mark for the last hook's drain does not complete the final drain` | A turn-end hook and row A with no mark, then `drainFinal()`. A mark at the cursor for drain 1: `partial`, `drain-incomplete`, `finalDrain: "incomplete"`. A mark for drain 2 instead: `complete`. |
| `the final drain starts once and ends hook handling` | Row B is posted between two `drainFinal()` calls. The second returns the same `drain` id, with `after` at the new cursor. `hook(turnFor(PATH, "claude", false))` after it returns undefined, and the record equals the one without that hook. |
| `an early start cannot keep the worker's relay from reading` | A turn-end hook, row A, and a mark for drain 1. A first `drainFinal()` returns drain 2, and a text-less end mark for drain 2 is posted at the cursor. A second `drainFinal()` returns drain 2 with the same cursor. Row B and a mark for drain 2 at the new cursor: `{ coverage: "complete", records: 2, provider: "claude", finalDrain: "complete" }`. Without that last mark: `partial`, `drain-incomplete`, `finalDrain: "incomplete"`. |
| `a second start after the closing finish returns nothing` | After `finish(true, true)`, `drainFinal()` is undefined. |
| `no transcript means no final drain` | Before a transcript hook, `reading` is false and `drainFinal()` is undefined, also after a subagent hook. The record is `{ coverage: "none", reason: "no-transcript", records: 0, provider: "claude" }`, with no `finalDrain` key. |
| `the watch accepts nothing after the closing finish` | After `finish(true, true)`, a chunk at the cursor returns undefined and adds no usage record, and `hook` and `drainFinal` return undefined. |
| `a SessionEnd after a stop request keeps the turn boundary` | Each case posts row A after its first hook, ends with a mark at the cursor for the last drain, and uses `finish(true)`. `turnEnd: false` hook, `stopRequested()`, then `{ ...turnFor(), sessionEnd: true }`: `partial`, `stopped-mid-turn`. Turn-end hook, `stopRequested()`, the same `SessionEnd`: `complete`. `turnEnd: false` hook, `SessionEnd`, no stop request: `complete`. `turnEnd: false` hook, `stopRequested()`, `turnFor()`: `complete`. |
| `the final drain reads a grown secondary` | A turn-end drain lists `agent-a.jsonl` at size N and reads it to its end. `drainFinal()`. The primary mark for drain 2 lists it at `N + M` and returns `secondaries: [{ name: "agent-a.jsonl", after: N }]`. A secondary chunk of M bytes and its mark for drain 2: `complete`, `records: 3`, `finalDrain: "complete"`. Without that secondary mark: `partial`, `secondary-missing`, `finalDrain: "complete"`. |
| `a Codex final drain completes the cumulative total` | A Codex turn-end drain of `requestRow("resp_1", 1150)` with its mark. `drainFinal()` returns `{ path, after, drain: 2 }` with no `secondaries` key. `totalRow(1150)` and a mark for drain 2: `{ coverage: "complete", records: 1, provider: "codex", finalDrain: "complete" }`. |

In `tests/transcript-usage.test.ts`, `usage coverage follows the rule table` adds: `skipped` with a complete turn-end `lastDrain` gives `complete`; `skipped` with `turnEnd: false`, with `complete: false`, and with no `lastDrain` each give `drain-skipped`; `incomplete` with `complete: false` gives `drain-incomplete`; `skipped` with `dropped` gives `row-dropped`.

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/transcript-watch.test.ts tests/transcript-usage.test.ts`, then `npm run typecheck -w @infinite/host`. Every existing test in both files must pass unchanged.

### Task 3: the worker runs the drain

**Interfaces (consumes):** Tasks 1 and 2.

**Files:** modify `hooks.ts`, `worker.ts`, `demo.ts`, `tests/chat.test.ts`, `docs/architecture.md`, `docs/security.md`, and the spec.

**Decisions:**

- `HookRoute` and `ROUTES` in `hooks.ts` gain `drain`.
- In `onHook`, above the `state.status !== "running"` gate, and in place of the old `transcript` line below it:

  ```ts
  if (route === "drain") { const started = drainOpen ? transcriptWatch.drainFinal() : undefined; return started ? { transcript: started } : undefined; }
  if (route === "transcript") return state.status === "running" || drainOpen ? onTranscript(body) : undefined;
  ```

  Provider hooks and reports keep the status gate, so after exit they are dropped or refused as today.
- `onHook` passes `sessionEnd: event === "SessionEnd"` to `transcriptWatch.hook`. `deliver` calls `transcriptWatch.stopRequested()` just before `child.kill("SIGTERM")`, and `handoff-stop` calls it before `stopHandoffProcesses`.
- **`exited` order.** (1) Native, hybrid, and executor shutdown, as today. (2) `flush`, the exited state, `publish`, the `lifecycle` exited record, and `persist`, as today. (3) In an async continuation that never rejects, `await finalDrain()`. (4) Unless the provider is `opencode`, append `usage-coverage` from `transcriptWatch.finish(hooksReady, true)`, then `persist`. (5) Start the 1.5 second exit timer, so the hook server closes after the drain. Each step catches its own failure. *(My call, which changes the Phase 2a order: the session reads `exited` the moment the provider is gone, so every existing gate keeps refusing input, reports, and provider hooks during the drain. Only the drain's posts are served. Readers that need coverage wait for the coverage record, not the exit record.)*
- `finalDrain()` returns at once when `hookServer` is null or `transcriptWatch.reading` is false. It returns when `drainLaunch(profile, relayPath)` is undefined: the watch then reports `skipped`. Otherwise it sets `drainOpen = true`, awaits `runFinalDrain(launch, env)`, and sets `drainOpen = false` in `finally`. `env` holds `PATH` and `HOME` when the worker has them, `INFINITE_HOOK_URL: hookServer.url`, and `INFINITE_HOOK_TOKEN: hookToken`, and nothing else.
- After the window closes, a `transcript` post gets 204 with no cursor, so a late relay stops, and its bytes are never read. The closed watch refuses them as well.
- The drain also runs for a handoff source. *(My call: the relay opens only transcript files and the loopback socket, and writes nothing in the project.)*
- The rows the drain reads become chat messages too, journaled after the exit record.
- `demo.ts`: `transcribe` takes an optional message id. With `late-row` in the request, the `SIGTERM` handler waits for the hook chain as today (at most 3 seconds), then appends one assistant row with id `msg-demo-<pid>-late`, model `rehearsal-model`, usage `input_tokens: 120`, `output_tokens: 30`, both cache counts 0, and the text "Stopped before the reply was finished.", posts no hook, and exits. With `drain-early` in the request, the chain calls `drain({ url, token })` once, right after the first `UserPromptSubmit` hook.
- `docs/architecture.md`, after the sentence on subagent usage: after the provider exits, the worker runs the relay once more in drain mode, for at most 10 seconds, so rows written after the last hook still reach chat and usage. On the Ubuntu deployment it runs through the root-owned `transcript-drain` wrapper. `docs/security.md`, in the transcript bullet: the wrapper takes no arguments, the worker's authenticated reply names the file, and the path checks do not change.
- The spec: part 3 gains `drain-skipped` among the `partial` reasons, says the coverage record follows the final drain and carries `finalDrain`, and acceptance 4 reads `drain-skipped` for the case without the drain. Owner decisions 2 and 3 record the 2026-11-13 decisions.

- [ ] **Step 1: Write the failing tests** in `tests/chat.test.ts`. Each waits for exactly one `usage-coverage` event, not for `exited` alone.

| Test name | Assertions |
|---|---|
| `a rehearsal turn journals its usage, and its exit journals the coverage of the session` (modify) | Also `finalDrain` is `"complete"`. |
| `a rehearsal subagent's usage is journaled from its own transcript` (modify) | Also `finalDrain` is `"complete"`. |
| `a rehearsal without hooks journals no usage and coverage none for hooks-off` (modify) | The record has no `finalDrain` key. |
| `a rehearsal stopped mid-turn journals the row written after its last hook` | Prompt `hook dialog late-row`, stopped while the dialog is open. A `usage` event has message id `msg-demo-<pid>-late`, with `tokens.input` 120 and `tokens.output` 30. Coverage is `partial`, `stopped-mid-turn`, `finalDrain: "complete"`. The `lifecycle` exited event and every `usage` event have a lower `seq` than the coverage event. Chat holds "Stopped before the reply was finished." |
| `a sudo profile drains through the wrapper beside it, and skips without one` | A temporary folder holds an executable `sudo` script that appends `"$*"` to a log, drops its options through `--`, and runs the rest. It also holds `demo` and `transcript-drain` scripts that run the demo and the relay in drain mode with `--import tsx`. The demo profile is `<folder>/sudo` with `["-n", "-u", "test-agent", "--", <folder>/demo]`. The late-row session journals the late row, is `stopped-mid-turn` with `finalDrain: "complete"`, and the log holds the line `-n -u test-agent -- <folder>/transcript-drain`. With `transcript-drain` deleted, a second session has no late-row usage, is `partial` with `drain-skipped` and `finalDrain: "skipped"`, and adds no drain line to the log. |
| `a drain post while the provider runs changes nothing` | Prompt `hook dialog drain-early`, answered, then stopped. "Removed the build directory" reaches chat, and coverage is `complete` with `finalDrain: "complete"`. |
| `a drain that hangs is stopped at its limit and the session still closes` | The sudo stand-in runs a `transcript-drain` script that posts nothing and sleeps for 60 seconds. A late-row session stopped mid-turn: one coverage event, `partial`, `drain-skipped`, `finalDrain: "skipped"`, no late-row usage. The coverage event follows the exited event by at least 9 and less than 14 seconds. The sleeping process is gone, and the worker process that started it ends within 5 seconds. |
| `a sudo policy that refuses the wrapper skips the drain at once` | The wrapper file exists, and the sudo stand-in exits 1 for it. A late-row session stopped mid-turn: `partial`, `drain-skipped`, `finalDrain: "skipped"`, no late-row usage, and the coverage event follows the exited event by less than 3 seconds. A session that ends at a clean turn boundary under the same refusal: `complete` with `finalDrain: "skipped"`. |

- [ ] **Step 2: The coordinator runs `tests/chat.test.ts` and confirms the new tests fail.** It starts a host.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/transcript-watch.test.ts tests/final-drain.test.ts`, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs `tests/chat.test.ts` three times in a row, then `npm run check`, requests the independent review, and commits.**

### Task 4: withdrawn. Codex hooks stay off, and the docs say why

The owner decided on 2026-11-13 that Codex hooks are on by default. Spike S2 ran the same day against the real Codex CLI (version 0.167, eight turns, in the member sandbox with network off), and the decision was withdrawn on its result.

- The injected `-c hooks.*` are accepted, fire outside the command sandbox, and reach the loopback hook server. The transcript relay streams the session file.
- `--dangerously-bypass-hook-trust` is not limited to the hooks the host injects. With it, hooks that the working directory defines also ran, without review. Without it no hook ran, the host's own included. The flag persists no trust.
- So `DEFAULT_HOOKS` stays `{ claude: true, codex: false }`, and no deployment turns Codex hooks on while they need the flag.

What this task does instead. The coordinator makes these edits:

- `docs/security.md`, `docs/architecture.md`, `README.md`, and two sentences of `docs/superpowers/specs/2026-10-04-mobile-attention-brief-design.md` no longer say that the flag applies only to the host's hooks. They state what the spike found.
- The comment on `DEFAULT_HOOKS` in `config.ts` gives the reason. The `doctor` line in `cli.ts` becomes a warning: "Warning: Codex hooks are on. They run with --dangerously-bypass-hook-trust, which also lets hooks defined in a session's working directory run without review. Use them only with repositories you trust."
- No test changes. `tests/host-launch.test.ts` pins the default as it is.

Codex usage capture without the flag is separate work: reading the transcript from the `notify` route with hooks off, or host-recorded trust for the host's own hooks.

Tasks 1 and 2 touch separate files and can run in parallel. Task 3 runs last.

## Not in this phase

- Installing the wrapper and the new sudoers file on the execution host. Until then, sudo sessions report `finalDrain: "skipped"`.
- The ledger and clients (phase 3): reading coverage that now follows the exit record, keeping `finalDrain`, and showing `drain-skipped`.
- A larger pass budget for the drain.
- Confirming whether Claude Code runs `SessionEnd` on `SIGTERM`.
- Codex usage capture. Codex hooks stay off (Task 4), so a Codex session keeps coverage `none` with `hooks-off` until capture has a route that needs no bypass flag.
- Codex child threads, native Codex sessions, and OpenCode.

---

# Phase 3: the usage ledger in the evidence store

Spec part 4, the ledger side of part 3, the roll-up and header items of part 7, and delivery item 3. The usage ledger moves from `usage.sealed` into a `usage` module of the evidence store, which closes INF-40. The fold reads the `usage` and `usage-coverage` records that phase 2 journals, so Claude Code, Codex, and rehearsal sessions show tokens and coverage in every roll-up, and a member's total covers all of its sessions. What stays the same: every existing response field keeps its name, type, and meaning; OpenCode figures and the plan-override file do not change; capture in the worker does not change. Claude Code and Codex records stay unpriced until phase 4.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/types.ts` (modify) | `SessionPurpose`, and `purpose` and `configId` on `Session` |
| `packages/host/src/manager.ts` (modify) | `createTeamSession` checks and stores the two header fields |
| `packages/host/src/evidence/crypto.ts` (modify) | Index classes `model` and `usage-record` |
| `packages/host/src/usage-store.ts` (create) | The `usage` module: tables, record checks, keys, the merge rule, the import, row reads |
| `packages/host/src/usage-service.ts` (modify) | The ledger on the store: import, fold, coverage, roll-ups, `member()` |
| `packages/host/src/usage-api.ts` (modify) | The added fields of task and project usage |
| `packages/host/src/team-usage.ts` (modify) | `teamUsage` reads members, and rollups count partial members |
| `packages/host/src/teams.ts` (modify) | Task usage in the team view carries coverage |
| `packages/host/src/server.ts` (modify) | Passes the store to the ledger, and answers 503 while the ledger is unavailable |
| `packages/host/src/client.ts` (modify) | `usageLines` prints tokens for a provider without Spent |
| `docs/teams.md` (modify) | The two paragraphs that call Claude and Codex unmeasured |
| `tests/usage-store.test.ts`, `tests/usage-ledger.test.ts` (create) | Store and service tests that start no host |
| `tests/usage-service.test.ts`, `tests/usage-routes.test.ts`, `tests/team-usage.test.ts`, `tests/usage-lines.test.ts`, `tests/chat.test.ts`, `tests/teams.test.ts` (modify) | Changed and added cases |

## Review Focus

1. **One request seen twice.** A Claude or Codex record from a second session, a transcript read again from byte 0, a smaller copy after a larger one, or an import after a tick. Expect one row: the larger whole record, owned by the first session.
2. **A store that fails.** A write that throws on page 2 of 3, a store that cannot open, or one closed during a run. Expect rows and cursor to roll back together, no throw into the team loop, 503 from the usage routes, and an exact resume from the stored cursors.
3. **Sessions from before the upgrade.** The sealed ledger marked Claude sessions exited without reading their journals, and phase 2 workers already journaled their usage. Expect those sessions read again from cursor 0, and measured OpenCode sessions kept at their cursors.
4. **Text where an id or a number belongs.** A record with message content, a path, a native id, or a model name over 200 characters; a header with a project or task name. Expect no plain column and no database byte to hold them, and a refused record to make its session `partial`.
5. **Coverage edges.** Usage records that follow the exit record, an exited session with no coverage record, a running session with records, a refused record under `complete`, and a member whose sessions disagree. Expect the coverage table of Task 4.

Each has a test in the task that owns the code.

## When the store is unavailable

The ledger observes. Capture continues in the session journals, and the fold resumes from the stored cursors when the store returns. Every `/api/usage` route answers 503 with `{ "error": "The usage ledger is unavailable" }`. The session listing carries no `usage` key. A team view's rollup carries `unavailable: true` and counts its members as unmeasured. No run, session, or host start waits on the store. A briefing recorded while it is unavailable is lost with one warning.

### Task 1: the session header fields

**Files:** modify `types.ts` and `manager.ts`. Test in `tests/teams.test.ts`, beside `team session creation refuses native continuation for other providers or roles`.

**Interfaces (produces):**

```ts
// types.ts
export type SessionPurpose = "work" | "duel" | "replay" | "gate";
export interface Session {
  /** Host-owned (contract C8). Set only through createTeamSession, and never changed. */
  purpose?: SessionPurpose;
  /** Host-owned (contract C7). A lowercase SHA-256 hex digest. */
  configId?: string;
}
// manager.ts
createTeamSession(request: CreateSession, team: TeamAssignment, cwd: string, modelProfile?: TeamModelProfile,
  workspaceRoot?: string, workspaceTrusted = false, header: { purpose?: SessionPurpose; configId?: string } = {}): Promise<Session & WorkerState>;
```

**Decisions:**

- A purpose outside the four values, or a `configId` that does not match `/^[0-9a-f]{64}$/`, throws `ContentError` with status 400, next to the continuation checks.
- The fields join the `createOnce` request only when present. A request without them keeps its fingerprint, so a member replayed after the upgrade still matches its session. `createOnce` copies them onto the session next to `team`.
- No caller passes them in this phase. *(My call: the launchers that set `duel`, `replay`, and `gate`, and the outcome ledger that computes `configId`, come later. The ledger records `work` for a member session without a purpose.)*
- Neither field enters `TeamAssignment`. *(My call: the assignment is written into the member's context file, and a member that can read its purpose can tell a trial from real work. C9.)*

| Test name | Assertions |
|---|---|
| `team session creation checks its header fields` | With `Object.create(Manager.prototype)`, `config.teams.workspaceDir` set to a temporary folder, a `cwd` inside it, a resolved `serial`, and a `createOnce` stub that returns its request: `{ purpose: "gate", configId: "a".repeat(64) }` reaches the request. An empty header leaves neither key in it. `purpose: "learning"`, `configId: "abc"`, and `"A".repeat(64)` each throw with status 400. |

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run `node --import tsx --test --test-name-pattern "team session creation" tests/teams.test.ts` and confirm it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command and `npm run typecheck -w @infinite/host`.** Hand to the coordinator.

### Task 2: the usage module

**Files:** create `usage-store.ts` and `tests/usage-store.test.ts`. Modify `evidence/crypto.ts`.

**Interfaces (consumes):** Task 1; `EvidenceModule`, `EvidenceTx`, `EvidenceDb`; `UsageRecord`; `UsageCoverage`, `UsageCoverageReason`, and `usageRecordKey` from `transcript-usage.ts`.

**Interfaces (produces):**

```ts
// evidence/crypto.ts
export type EvidenceIndexClass = "project" | "task" | "area" | "model" | "usage-record";

// usage-store.ts
export const SESSION_PURPOSES: readonly SessionPurpose[];
export type LedgerCoverageReason = UsageCoverageReason | "running"; export interface LedgerCoverage { coverage: UsageCoverage; reason?: LedgerCoverageReason }
export interface LedgerHeader { sessionId: string; provider: Provider; projectId: string; createdAt: string; lastActiveAt?: string;
  team?: TeamAssignment; profileId?: string; purpose?: SessionPurpose; configId?: string }
export interface LedgerState extends LedgerCoverage { cursor: number; seen: number; refused: number; exited: boolean;
  /** The worker's usage-coverage record, once the fold has read it. */ journaled?: LedgerCoverage & { finalDrain?: "complete" | "incomplete" | "skipped" } }
export interface StoredSession extends LedgerState { sessionId: string; provider: Provider; projectId: string; createdAt: string;
  lastActiveAt?: string; runId?: string; memberId?: string; revision?: number; role?: string; taskKey?: string;
  profileId?: string; purpose?: SessionPurpose; configId?: string }
/** The `Ledger` and `LedgerSession` types of usage-service.ts, moved here under these names. */
export type SealedLedger; export type SealedSession;
export const usageModule: EvidenceModule;
/** A copy with only UsageRecord keys, or undefined when a field is missing or invalid. */
export function ledgerRecord(value: unknown): UsageRecord | undefined;
export function ledgerKey(record: UsageRecord, sessionId: string): string;
/** False, with nothing written, when an id or a time is invalid. */
export function writeSession(tx: EvidenceTx, header: LedgerHeader, state: LedgerState): boolean;
/** The session row must exist. */
export function writeRecord(tx: EvidenceTx, sessionId: string, record: UsageRecord): "inserted" | "replaced" | "kept";
export function writeBriefing(tx: EvidenceTx, key: string, projectId: string, at: string, record?: UsageRecord): void;
export function readSessions(db: EvidenceDb): StoredSession[];
/** `from` is inclusive and `to` exclusive. */
export function readRecords(db: EvidenceDb, filter?: { sessionIds?: string[]; from?: string; to?: string }): { sessionId: string; record: UsageRecord }[];
export function readBriefings(db: EvidenceDb): { projectId: string; at: string; record?: UsageRecord }[];
export function importState(db: EvidenceDb): "pending" | "done";
export function importLedger(tx: EvidenceTx, ledger: SealedLedger | undefined, outcome: "imported" | "absent" | "unreadable"):
  { sessions: number; records: number; briefings: number; refused: number };
```

**Schema** (migration from 0 to 1):

```sql
CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE usage_projects (project_ref TEXT PRIMARY KEY, encrypted_project TEXT NOT NULL);
CREATE TABLE usage_models (model_ref INTEGER PRIMARY KEY, model_key TEXT NOT NULL UNIQUE, encrypted_model TEXT NOT NULL);
CREATE TABLE usage_sessions (
  session_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
  project_ref TEXT NOT NULL REFERENCES usage_projects(project_ref),
  created_at TEXT NOT NULL, last_active_at TEXT,
  coverage TEXT NOT NULL, coverage_reason TEXT, journaled_coverage TEXT, journaled_reason TEXT, final_drain TEXT,
  run_id TEXT, member_id TEXT, revision INTEGER, role TEXT, task_key TEXT,
  profile_id TEXT, purpose TEXT, config_id TEXT,
  journal_cursor INTEGER NOT NULL DEFAULT 0, records_seen INTEGER NOT NULL DEFAULT 0,
  records_refused INTEGER NOT NULL DEFAULT 0, exited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE usage_records (
  record_key TEXT PRIMARY KEY, provider TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES usage_sessions(session_id),
  completed_at TEXT NOT NULL, model_ref INTEGER NOT NULL REFERENCES usage_models(model_ref), model_source TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL DEFAULT 0,
  reported_cost REAL NOT NULL DEFAULT 0, secondary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE usage_briefings (
  briefing_key TEXT PRIMARY KEY, project_ref TEXT NOT NULL REFERENCES usage_projects(project_ref), at TEXT NOT NULL,
  model_ref INTEGER REFERENCES usage_models(model_ref), model_source TEXT,
  input INTEGER, output INTEGER, reasoning INTEGER, cache_read INTEGER, cache_write INTEGER, reported_cost REAL
);
CREATE INDEX usage_records_by_session ON usage_records (session_id);
CREATE INDEX usage_records_by_time ON usage_records (completed_at);
CREATE INDEX usage_sessions_by_member ON usage_sessions (run_id, member_id);
CREATE INDEX usage_sessions_by_project ON usage_sessions (project_ref);
```

**Decisions:**

- The module is `usage`, version 1, read version 1. `counts` returns `{ sessions, records, briefings }`. It has no `deleteRun` and no `runIds`: usage rows outlive their run and are kept without a limit (owner decision, 2026-11-13).
- **Plain columns** hold only opaque ids, enumerations, numbers, and times. `session_id`, `run_id`, and `member_id` must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`, the store's `OPAQUE_ID`. `profile_id` is a configured id (C1). `config_id` is stored only when it matches `/^[0-9a-f]{64}$/`, else null. Every time is stored as `new Date(value).toISOString()`, and a time that does not parse refuses its header or record. A reason column holds a token matching `/^[a-z][a-z0-9-]{0,39}$/`.
- **Sealed values.** The project id is sealed in `usage_projects` under `project_ref = index("project", projectId)`. `{ providerId, modelId }` is sealed in `usage_models` under `model_key = index("model", providerId + "\u0000" + modelId)`, and rows hold the integer `model_ref`. `task_key = index("task", taskId)`. Record and briefing keys exist only as `index("usage-record", key)`. Each `seal` and `open` uses the table name and that row's key column. *(My call: the design keeps `model_id` plain and C1 calls a model id an enumeration, but the brief puts model names behind a seal, and here a model, a message id, and a native id come from a transcript the agent's account can write. The dictionary decrypts each name once per read, not once per row.)*
- **Stored keys.** A record keeps `provider`, `providerId`, `modelId`, `modelSource`, `completedAt`, the five token classes, `cacheWrite1h`, `reportedCost`, and `secondary`. `messageId`, `partId`, and `nativeId` survive only inside the keyed hash. A read record has `messageId: ""` and `partId: ""`, `cacheWrite1h` only when above 0, and `secondary` only when true. *(My call: no reader needs them. The design's `native_id` and `provider_version` columns wait for the capture endpoint.)*
- `reported_cost` is `REAL`. *(My call: a micro-dollar integer rounds a reported cost, and the bodies before and after import would differ in the sixth decimal.)*
- **Checks** (`ledgerRecord`). `provider` is `opencode`, `claude`, or `codex`. `providerId` and `modelId` have 1 to 200 characters, `messageId` 1 to 512, `partId` 0 to 512. `modelSource` is one of its three values. `completedAt` parses. Each token class is a non-negative safe integer. `cacheWrite1h` is absent or an integer from 0 to `cacheWrite`. `reportedCost` is finite and at least 0. `secondary` is absent or `true`.
- **Keys.** `ledgerKey` is `usageRecordKey(record)` for `claude` and `codex`, which is global across sessions, and `opencode:${sessionId}/${messageId}/${partId}` for OpenCode, the sealed ledger's key. *(My call: the design's three-column key becomes one keyed hash of the same parts, so no message id sits in a plain column.)*
- **Merge** (`writeRecord`). A new key inserts with the given session. For `claude` and `codex`, a stored row is replaced only by a larger record, compared by token total over the five classes, then `reasoning`, then `cacheWrite1h`. The replacement writes every column of the new record and keeps the stored `session_id`. Equal or smaller changes nothing. For `opencode` the last copy replaces the row, as today. *(My call: the brief keeps OpenCode behaviour unchanged.)*
- **Purpose.** Stored as the header's purpose, as `work` when the header has a `team` and no purpose, and as null without a `team`. *(My call: a mission coordinator has a team assignment, so it counts as a member.)*
- `writeBriefing` keys its row by `index("usage-record", "briefing:" + key)`. The model and token columns are set only with a record. The last write for a key wins.
- **Import**, in the caller's one transaction. A `measured` session imports as `complete` with its cursor and `exited` flag. Any other session imports as `none` with `unsupported`, cursor 0, and `exited` false. *(My call: the sealed ledger marked unmeasured sessions exited without reading them, so a Claude session that ran under a phase 2 worker would never show its usage.)* A row's session is the text before the first `/` of its sealed key. A row whose session was not imported, a row that `ledgerRecord` refuses, and a briefing whose record it refuses are skipped and counted in `refused`. Sessions are written before records, because `foreign_keys` is on. The call writes `usage_meta('sealed-import', outcome)` last. The import runs once: when that row exists, `importLedger` writes nothing and returns zero counts, so a later call cannot rewind a cursor or a record that the fold wrote since. `importState` is `done` once that row exists.

| Test name | Assertions |
|---|---|
| `the usage module creates its tables once` | On a new store, `status().modules.usage` is `ready`, and `sqlite_master` lists exactly the six `usage_` tables. A second store on the same file registers it as `ready`. `describe().counts` holds `usage.sessions`, `usage.records`, and `usage.briefings`. |
| `a Claude or Codex key belongs to its first session` | One Claude record written for session A and then B: one row with `session_id` A, results `inserted` then `kept`. The same for a Codex record. |
| `the larger whole record wins` | From a Claude record with total 100: total 90 is `kept`; total 100 with more reasoning is `replaced`; then equal reasoning with a larger `cacheWrite1h` is `replaced`; an equal record is `kept`. After each replacement every class equals the new record's, and `session_id` stays A. |
| `an OpenCode key is scoped to its session and its last copy wins` | One message and part in sessions A and B: two rows. A smaller copy for A is `replaced`. |
| `a stored record keeps only usage fields` | A record that also has `nativeId: "native-marker"`, `messageId: "msg-marker"`, `modelId: "model-marker"`, `text: "private-marker"`, and `cwd: "/home/dev/projects/infinite"`, in a session of project `project-marker` with task `task-marker`. The read record's keys are exactly `provider, providerId, modelId, messageId, partId, modelSource, completedAt, tokens, reportedCost`. `SELECT *` of its row gives exactly the 14 columns. Neither the database file nor its `-wal` file contains a marker or the path. |
| `a journal record is checked before it is stored` | `ledgerRecord` is undefined for: no `provider`, provider `grok`, an empty `modelId`, a 201-character `modelId`, `input` of `-1`, `1.5`, or `"7"`, no `cacheWrite`, `cacheWrite1h` above `cacheWrite`, `reportedCost` of `NaN` or `-0.1`, `completedAt: "not a time"`, and `secondary: false`. A valid record with an extra key returns a copy without it, and `2026-01-01T00:00:00Z` becomes `2026-01-01T00:00:00.000Z`. |
| `session rows hold opaque columns` | `project_ref` and `task_key` are 64 hex characters. `readSessions` returns the project id and `taskKey === db.index("task", "task-marker")`. A team header without a purpose stores `work`; a header without a team stores none. A session id `bad id` or an unparseable `createdAt` returns false and writes nothing. A `configId` of `abc` is stored as null. |
| `the import maps the sealed ledger` | A ledger with a measured exited OpenCode session at cursor 7, an unmeasured exited Claude session, three valid rows, a row of a missing session, a row with a string token, and two briefings, one without a record. The result is `{ sessions: 2, records: 3, briefings: 2, refused: 2 }`. OpenCode: `complete`, cursor 7, exited. Claude: `none`, `unsupported`, cursor 0, not exited. `importState` is `done`. A second call leaves every table equal. |
| `records are read by session and time` | `readRecords` by `sessionIds`, by `from`, and by `to` returns the expected rows, with `from` inclusive and `to` exclusive. `index("model", v)` differs from `index("usage-record", v)`. |

- [ ] **Step 1: Write the failing tests.** Build the store as `tests/evidence-store.test.ts` does, register `usageModule`, and read raw rows with `store.read(db => db.all(...))`.
- [ ] **Step 2: Run `node --import tsx --test tests/usage-store.test.ts` and confirm it fails** with a missing module.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, `node --import tsx --test tests/evidence-store.test.ts`, and `npm run typecheck -w @infinite/host`.** Hand to the coordinator.

### Task 3: the ledger on the store

A storage swap with today's rules. Only OpenCode sessions in a measured launch mode are read.

**Files:** modify `usage-service.ts`, `server.ts`, `tests/usage-service.test.ts`, `tests/usage-routes.test.ts`. Create `tests/usage-ledger.test.ts`.

**Interfaces:** consumes Task 2. Produces `constructor(config: Config, key: Buffer, manager: Manager, store: EvidenceStore)` and `available(): boolean`, true when the module is ready and the import is done. Every other public signature stays.

**Decisions:**

- The constructor registers `usageModule`. When `importState` is `pending`, it reads `usage.sealed` with today's checks and calls `importLedger` in one `store.write`: `imported`, `absent` when there is no file, or `unreadable` with today's warning. A throw from that write logs one fixed warning and leaves the ledger unavailable until the next start, which tries again, so no tick writes before the import.
- Afterwards the service never reads, writes, or deletes `usage.sealed`. It stays unread for one release. `usage-plans.sealed` is unchanged.
- **Fold.** In this task an OpenCode session in a measured launch mode is `complete`, and every other session is `none` with `unsupported`. `tick` reads the stored sessions once and skips exited ones. Each journal page is one `store.write` holding the session row with its new cursor and every record of the page. A session with no new events is written only when its row changed.
- A tick reads at most 20 pages over all sessions. A session not read to its end stays unexited and continues next tick. *(My call: Task 4 reads every Claude session from before the upgrade from cursor 0, and the tick blocks the team loop while it reads. 20 pages is about 10 MB of journal.)*
- A write that throws ends the tick with one warning. Nothing of that page is stored, and the next tick reads it again from the stored cursor. An unreadable journal keeps today's warn-once rule and does not stop other sessions. A record that `ledgerRecord` refuses is skipped and counted in `records_refused`.
- `recordBriefing` uses `writeBriefing`. When the store is unavailable or the write fails, the briefing is lost with one warning.
- **Reads.** Each method takes its rows from `readSessions`, `readRecords` (filtered by session or time where it has one), and `readBriefings` inside one `store.read`, then keeps today's arithmetic: `priceUsage` per record, the same rounding, the same grouping. A session is measured when its coverage is not `none`. No records are kept between calls (INF-40).
- **Unavailable.** `tick` returns at once. `session` returns `{ measured: false, unavailable: true }`. `taskUsage` returns undefined and `sessions` zero totals. `summary`, `daily`, `projects`, and `project` throw `EvidenceError` with code `unavailable`. A throw inside `store.read` counts the same.
- **Routes.** `server.ts` passes its `EvidenceStore`. One handler before the usage routes gives every `/api/usage` request the 503 answer while `available()` is false, before anything changes. A route that catches `EvidenceError` code `unavailable` gives the same answer.

Tests in `tests/usage-ledger.test.ts` use a helper that builds a store in a temporary folder, and `subset(actual, expected)`, which checks every key of `expected` recursively, with arrays of equal length, so later tasks can add fields.

**Fixture ledger.** `now` is `2026-10-21T12:00:00.000Z`. Prices `deepseek/deepseek-flash` `{ input: 1, output: 2 }`. Accounts `deepseek` (metered, `deepseek/*`) and `claude` (subscription, `claude/*`, `planUsd: 200`). Budget `opencode` `{ usd: 10, period: "week" }`. Session `member-a`: OpenCode, measured, exited, project `demo`, team `run-1`, `member-a`, `task-1`, revision 1, `implementer`, profile `ds`, with four rows: a configured-price row on 2026-10-21, `deepseek-v4-pro` at 02:30 UTC on 2026-10-20 (a catalog peak), `unlisted` with `reportedCost: 0.0012345678`, and one with `modelSource: "unknown"`. Session `local`: OpenCode, measured, exited, `demo`, one row on 2026-09-30T23:00Z. Session `claude-a`: Claude, unmeasured, exited, `demo`, active this month. Session `claude-b`: Claude, unmeasured, project `other`, last active in September. Briefings: one with a `deepseek-flash` record on 2026-10-21 for `demo`, one without a record for `other`.

| Test name | Assertions |
|---|---|
| `the store gives the bodies of the sealed ledger it imports` | `summary(now)`, `daily({ days: 3, tz: "Asia/Seoul", now })`, `projects({ now })`, `project("demo", { now })`, `project("other", { now })`, `taskUsage("run-1", "task-1", 1)`, `session("member-a")`, and `session("claude-a")` are `subset`-equal to literals printed by the current code. |
| `the sealed ledger is imported once and never written again` | After the constructor, a tick that adds a session, and `recordBriefing`, the file's bytes equal the fixture's. A second service on the same database, after the file is replaced by another ledger, returns the first bodies. |
| `a page and its cursor commit together` | A journal of three pages, and a store wrapper whose `write` throws for page 2 once. After tick 1 the stored rows are page 1's, and `journal_cursor` is page 1's cursor. Tick 2 asks for events after that cursor, and `messages` equals the three pages' records. |
| `a tick reads at most 20 pages` | An exited session with 25 pages. Tick 1 asks for 20 pages and leaves it unexited. Tick 2 asks for 5 and marks it exited. |
| `an unavailable store never throws` | A store whose path lies under a regular file. `available()` is false, `tick()` resolves, `session("x")` is `{ measured: false, unavailable: true }`, `summary()` throws code `unavailable`, and `recordBriefing` returns with one warning. |
| `a new service resumes from the stored cursors` | After one tick, `store.close()`, and the next tick resolves. A new store and service on the same file ask for events after the stored cursor, and no total doubles. |

Changes to existing tests: the unit tests of `tests/usage-service.test.ts` build the service with a store, and the loop in `an unreadable or misshapen ledger is discarded with a warning and the service starts empty` uses a new folder per case. `one unreadable journal does not hide another measured session's usage` rebuilds by deleting `evidence/evidence.sqlite3` with its `-wal` and `-shm` files instead of `usage.sealed`. `a host with an unusable evidence location still serves and reports the store unavailable` expects the 503 answer from `/usage` and 200 from `/sessions`.

- [ ] **Step 1: Write the fixture test and run it against the current code** with `node --import tsx --test tests/usage-ledger.test.ts`. It must pass. tsx does not type-check, so the fourth argument is ignored.
- [ ] **Step 2: Write the other tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `tests/usage-ledger.test.ts`, `tests/usage-store.test.ts`, `tests/team-usage.test.ts`, the unit tests of `tests/usage-service.test.ts` with `--test-name-pattern`, and the typecheck.**
- [ ] **Step 5: The coordinator runs `tests/usage-service.test.ts` and `tests/usage-routes.test.ts`, which start hosts.**

### Task 4: Claude Code, Codex, and coverage in every roll-up

**Files:** modify `usage-service.ts`, `usage-api.ts`, `tests/usage-ledger.test.ts`, `tests/usage-service.test.ts`, `tests/chat.test.ts`.

**Interfaces (produces):**

```ts
// usage-service.ts
export interface SessionUsage extends UsageTotals { measured: true; coverage: "partial" | "complete"; coverageReason?: LedgerCoverageReason }
export type UnmeasuredUsage = { measured: false; coverage: "none"; coverageReason?: LedgerCoverageReason; unavailable?: true };
export function ledgerCoverage(input: { provider: Provider; measuredLaunch: boolean; closed: boolean;
  journaled?: LedgerCoverage; valid: number; refused: number }): LedgerCoverage;
export function combineCoverage(parts: readonly { coverage: UsageCoverage; coverageReason?: LedgerCoverageReason }[]): LedgerCoverage;
// UsageSummary: providers[p] gains partialSessions: number and recorded: { tokens: UsageTokens; messages: number }; month gains partialSessions: number.
// usage-api.ts: TaskUsage gains coverage: "partial" | "complete" and coverageReason?. ProjectUsage gains partial and month.partial. ProjectUsageDetail gains partial.
```

**Decisions:**

- **Fold.** Sessions of provider `claude`, `codex`, and `demo` are read with event types `usage` and `usage-coverage`, whatever their coverage. Grok and OpenCode sessions outside a measured launch are not read. `seen` counts usage events read, and `valid` is `seen - refused`.
- A `usage-coverage` event is kept as `journaled` when its `coverage` is one of the three values, its `reason` is absent or a token matching `/^[a-z][a-z0-9-]{0,39}$/`, and `complete` has no reason. A reason the type does not name, such as `drain-skipped` from phase 2c, is stored and reported as given. `finalDrain` goes to `final_drain` when it is `complete`, `incomplete`, or `skipped`, and is dropped otherwise. Other fields are ignored. A failing event is ignored, and the last valid one wins.
- **Closing.** The coverage record is a session's last usage record, and after phase 2c usage records follow the exit record. So a `claude`, `codex`, or `demo` session closes (`exited` set) only when it is listed as exited, its journal is read to the end, and either a `journaled` record was read or the ledger first saw it exited at least 60 seconds ago. That first-seen time lives in memory. A coverage event before the exit and one after it close the session the same way. *(My call: a session whose worker wrote no coverage record must stop being read at some point. The final drain runs for at most 10 seconds after exit, and a restart only delays closing.)* Other providers close as in Task 3, when listed as exited and read to the end.
- **Coverage.** `ledgerCoverage` returns the first match.

| Order | Session | Result |
|---|---|---|
| 1 | `opencode` in a measured launch mode (today's rule) | `complete`, or `partial` with `row-dropped` when `refused > 0` |
| 2 | any other `opencode`, and `grok` | `none`, `unsupported` |
| 3 | `claude`, `codex`, or `demo` with `journaled` | `journaled`, except `complete` becomes `partial` with `row-dropped` when `refused > 0` |
| 4 | same, no `journaled`, not closed | `partial` when `valid > 0`, else `none`; reason `running` |
| 5 | same, no `journaled`, closed | `partial` with `drain-incomplete` when `valid > 0`, else `none` with `unsupported` |

*(My call: rows 4 and 5 cover a session whose worker wrote no coverage record, from before phase 2 or after a crash. Row 4 also covers the final drain's window, so a drain in progress never counts as a gap. The refusal in row 1 is new for OpenCode, whose records the sealed ledger stores unchecked today.)*

- **Counts.** A session is measured when its coverage is not `none`. Unmeasured counts keep today's meaning: coverage `none`. Every unmeasured count gains a partial count beside it: coverage `partial` with a reason other than `running`. *(My call: a running session is partial by nature and would mark every live figure. Only a gap that can no longer close is counted, which is the mark the design asks clients to show.)*
- **`combineCoverage`** ignores `none` parts and returns `none` when none are left. All `complete` gives `complete`. Otherwise `partial`, with the reason of the first part, in the given order, whose reason is not `running`, else `running`.
- **Pricing.** A `claude` or `codex` record prices as `{ cost: 0, pricing: "unknown" }` everywhere, whatever the configured prices. *(My call: the account rule of part 5 keeps a subscription token from showing as money, and it comes with phase 4. Until then these records are unpriced steps. Spent in dollars does not change, member totals read "No price available", and a money figure that holds Claude or Codex steps becomes a lower bound.)*
- `providers[p].measured` and `spent` keep today's rule, `opencode` only. `recorded` sums the provider's measured sessions over its own period, plus briefings for `opencode`: the rows `spent` would sum. *(My call: Spent for Claude and Codex needs the phase 4 account rule.)*
- `session()` and `taskUsage()` carry coverage. `taskUsage` combines its sessions in `created_at` order.

| Test name | Assertions |
|---|---|
| `ledger coverage follows the rule table` | One assertion per row, each differing from the previous case in one field, plus `complete` with `refused: 1`. |
| `a Claude session is measured from its journal` | An exited `claude` session whose journal holds two usage events and a `complete` coverage event. `session(id)` has `measured: true`, `coverage: "complete"`, `messages: 2`, the summed tokens, `cost: 0`, and `pricing.unknown: 2`. |
| `a configured price does not price a Claude or Codex record` | With a price for `claude/model-a`, the record still has `cost: 0` and `unknown` pricing. `month.spent.usd` equals the OpenCode-only figure, and `month.spent.unpriced` rises by the Claude record count. |
| `a replay adds nothing` | Sessions A and B journal the same two Claude message ids, A first, and A's journal repeats each record once. `providers.claude.recorded.messages` is 2. `session(B)` is measured with `messages: 0`. |
| `a session from before the upgrade is read again` | The fixture ledger's `claude-a`, exited, with a journal holding one usage event and a `complete` coverage event. After import and one tick, `session("claude-a").coverage` is `complete` with `messages: 1`. |
| `partial sessions are counted beside unmeasured ones` | Claude sessions in project `demo`: complete; exited `partial` with `stopped-mid-turn`; running with records; exited `none` with `hooks-off`. `providers.claude` has `unmeasuredSessions: 1` and `partialSessions: 1`. `month.partialSessions`, the project row's `partial` and `month.partial`, and `project("demo").partial` are 1. |
| `a refused record makes a complete session partial` | One usage event with `output: "7"` beside a valid one, and a `complete` coverage event. `partial`, `row-dropped`, `messages: 1`. |
| `aggregate coverage takes the first lasting gap` | `combineCoverage` of complete and complete is `complete`; of complete and running `partial` is `partial` with `running`; of running, `drain-incomplete`, and `stopped-mid-turn` is `partial` with `drain-incomplete`; of only `none` parts is `none`. |
| `task usage carries coverage` | A task with a complete session and an exited `partial` `drain-incomplete` session: `coverage: "partial"`, `coverageReason: "drain-incomplete"`. |
| `usage after the exit record is still read` | A `claude` session listed as exited, whose journal first ends after one usage event. Tick 1 leaves it open, `partial` with `running`. The journal then gains a usage event and a coverage event. Tick 2 gives `messages: 2` and the journaled coverage, and closes it, so tick 3 asks for no events. A coverage event read while the session is still listed as running is kept, and the session closes on the first tick that lists it exited. |
| `an exited session without a coverage record closes after 60 seconds` | With `mock.timers` for `Date`: an exited session with one usage event stays open, `partial` with `running`, at 59 seconds, and closes as `partial` with `drain-incomplete` at 60. With no usage event it closes as `none` with `unsupported`. |
| `a coverage record is kept as the worker wrote it` | `{ coverage: "partial", reason: "drain-skipped", finalDrain: "skipped" }` plus an extra key is kept: the session reports `drain-skipped`, `final_drain` is `skipped`, and it counts in `partialSessions`. `finalDrain: "maybe"` stores null. `reason: "Not A Reason!"`, `coverage: "full"`, and `complete` with a reason are each ignored. |

In `tests/chat.test.ts`, `a rehearsal turn journals its usage, and its exit journals the coverage of the session` also waits until the session listing's `usage` has `measured: true` and `coverage: "complete"`, with `tokens.input` and `tokens.output` equal to the sums over the journal's usage events, and `/api/usage` has `month.spent.usd === 0`. Existing expected objects gain the new fields: `session("any")` is `{ measured: false, coverage: "none" }`, the unavailable result of Task 3 gains `coverage: "none"`, and the `taskUsage` objects gain `coverage: "complete"`. No assertion is removed.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run `node --import tsx --test tests/usage-ledger.test.ts` and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, `tests/usage-store.test.ts`, the unit tests of `tests/usage-service.test.ts`, `tests/usage-lines.test.ts`, and the typecheck.**
- [ ] **Step 5: The coordinator runs `tests/chat.test.ts` and `tests/usage-service.test.ts`.**

### Task 5: members, purposes, and the CLI

**Files:** modify `usage-service.ts`, `team-usage.ts`, `teams.ts`, `client.ts`, `docs/teams.md`, `tests/team-usage.test.ts`, `tests/usage-ledger.test.ts`, `tests/usage-lines.test.ts`.

**Interfaces (produces):**

```ts
member(runId: string, memberId: string): SessionUsage | UnmeasuredUsage;   // usage-service.ts
// usage-api.ts: ProjectUsageDetail gains byPurpose: Record<SessionPurpose, { total: Money; members: number }>.
// team-usage.ts
export interface UsageRollup { /* existing fields */ partialMembers: number; unavailable?: true }
interface UsageMember { sessionId: string; runId?: string; memberId?: string; provider?: Provider; modelProfile?: { id: string } }
// teamUsage keeps its signature. A member's usage is UsageTotals & { coverage: "partial" | "complete"; coverageReason?: LedgerCoverageReason }.
```

**Decisions:**

- `member(runId, memberId)` sums every stored session with that `run_id` and `member_id`, in `created_at` then `session_id` order, with `combineCoverage` over them. With no session it returns `{ measured: false, coverage: "none" }`. This covers a permission reviewer's turn sessions.
- `teamUsage` calls `member` when the member has `runId` and `memberId`, and `session(sessionId)` otherwise, so a mission coordinator attempt keeps reading its session. Coverage `none` counts in `unmeasuredMembers`. Coverage `partial` with a reason other than `running` also counts in `partialMembers`, and its usage is still added. An `unavailable` result sets `rollup.unavailable` and counts as unmeasured.
- `emptyRollup` sets `partialMembers: 0`. `addRollups` sums `partialMembers`, reading a missing value as 0, because goal records hold rollup snapshots from before this phase. It sets `unavailable` when any part has it.
- `teams.ts`: the task usage built in the team view adds the result of `combineCoverage` over its attempts' usage, as `coverage` and `coverageReason`.
- **`byPurpose`** holds all four keys. `total` is the money of the project's measured member sessions with that purpose, priced as everywhere. `members` counts distinct `(run_id, member_id)` among the project's sessions with that purpose. A session without a purpose is in no key, and the headline total is unchanged (design: money is money). The design's `list` field waits for phase 4.
- **`usageLines`.** A provider without `spent` whose `recorded.messages` is above 0 prints `${label}  ${tokens} tokens for ${word} from ${start} (${messages} steps, ${partial} partial, ${unmeasured} unmeasured sessions)`. `tokens` is the sum of the five classes in plain digits, `word` and `start` follow today's rule, and the partial part is left out when 0. Every other line is unchanged.
- **`docs/teams.md`.** Replace the sentence "Claude and Codex remain unmeasured per use and appear only as fixed plan fees." and the paragraph that starts "Only some work is measured." with: the ledger records Claude Code and Codex tokens for sessions whose hooks stream a transcript; each figure states its coverage; those records are not priced yet and count as unpriced steps; Grok and OpenCode in a native terminal stay unmeasured.

| Test name | Assertions |
|---|---|
| `a member sums every session it ran` | Three sessions of run `r` and member `m`, one record each. `member("r", "m").messages` is 3, and `teamUsage` with one member whose `sessionId` is the third session reports 3. |
| `member coverage is the worst of its sessions` | Complete with running `partial`: the member is `partial` with `running` and `partialMembers` is 0. Complete with exited `partial` `stopped-mid-turn`: `partial` with that reason and `partialMembers` 1. Only `none` sessions: no usage, and `unmeasuredMembers` 1. |
| `rollups count and merge partial members` | `addRollups` of 1 and 2 partial members is 3. A part without the key counts 0. `emptyRollup(4).partialMembers` is 0. |
| `an unavailable ledger marks the rollup` | `teamUsage` over an unavailable service: `rollup.unavailable` is true, every member is unmeasured, and no member has usage. |
| `a mission attempt reads its own session` | A member without `runId` gets `session(sessionId)`'s totals. |
| `project usage reports spend by purpose` | A member session with no purpose, a member session with header purpose `gate`, and a session without a team, each with one priced record. `byPurpose.work` and `byPurpose.gate` have `members: 1` and their record's money. `duel` and `replay` are `{ total: { usd: 0, unpriced: 0 }, members: 0 }`. The headline total equals the sum of all three records. |
| `a provider without Spent prints its tokens` | `claude` with `recorded` `{ tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 1000, cacheWrite: 0 }, messages: 3 }`, `partialSessions: 1`, `unmeasuredSessions: 2` prints `claude    1125 tokens for month from 2026-10-01 (3 steps, 1 partial, 2 unmeasured sessions)`, with the label padded as today. With `messages: 0` the line is today's unmeasured line. |

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run `node --import tsx --test tests/usage-ledger.test.ts tests/team-usage.test.ts tests/usage-lines.test.ts` and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command and `npm run typecheck -w @infinite/host`.**
- [ ] **Step 5: The coordinator runs `tests/usage-service.test.ts`, `tests/teams.test.ts`, `tests/missions.test.ts`, `tests/goals.test.ts`, and `npm run check`, requests the independent review, and commits.**

## Order

Tasks 1 and 2 touch different files, but Task 2 imports `SessionPurpose`, so Task 1 goes first. It is small. Tasks 3, 4, and 5 each change `usage-service.ts` and build on the previous task's interfaces, so they run one after another.

## Not in this phase

- List price (part 5, phase 4): catalog prices, `listPrice`, `list` totals, the `subscription` pricing value, the account rule for Spent, and the Models column. Until then every Claude and Codex record is unpriced.
- Limit events (part 6, phase 5), `GET /api/usage/limits`, and `infinite usage limits`.
- `GET /api/usage/capture`, `infinite usage capture`, and the `native_id` and `provider_version` columns.
- Web, phone, and Mac rendering: tokens where a member showed `Unmeasured`, the partial mark, and the web line that says only OpenCode members report usage. These clients decode the new fields and ignore them until then.
- Computing `configId` (outcome ledger, C7), and the launchers that set `duel`, `replay`, or `gate`.
- Deleting `usage.sealed`, one release after this one.
- The final drain (phase 2c) and Codex child threads.
