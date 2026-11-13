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

# Phase 2c: the final drain, and Codex hooks on by default

Spec part 2, "Final drain", part 3 (coverage), and owner decisions 2 and 3, settled on 2026-11-13: the wrapper is added, and Codex hooks are on by default. A provider that the host stops mid-turn fires no further hook, so the rows it wrote after its last hook never reach the worker. In this phase the worker starts the relay once in drain mode after the provider exits, and serves it for at most 10 seconds. The drain reuses the transcript route, drain ids, end marks, and the secondary listing, so the watch has no second read path. A session stopped mid-turn stays `partial` with `stopped-mid-turn`, and a drain that could not run is visible in the coverage record. Member launch, hook payloads, the 4 second hook deadline, the pass budgets, the relay's path checks, and the usage ledger do not change.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/final-drain.ts` (create) | The 10 second limit, the drain command for a profile, and one run of it |
| `packages/host/src/hook-relay.ts` (modify) | Drain mode: ask the worker what to read, then stream as a hook does |
| `deploy/ubuntu/transcript-drain.sh` (create) | The root-owned wrapper that runs the relay in drain mode as the agent account |
| `deploy/ubuntu/infinite.sudoers`, `deploy/ubuntu/README.md` (modify) | The sudoers line and the install step |
| `packages/host/src/transcript-watch.ts` (modify) | Start the final drain, keep the turn boundary across a stop, state the drain in the coverage record |
| `packages/host/src/transcript-usage.ts` (modify) | The `drain-skipped` reason |
| `packages/host/src/hooks.ts` (modify) | The `drain` route |
| `packages/host/src/worker.ts` (modify) | Run the drain after the exit record, serve its posts, then journal coverage |
| `packages/host/src/demo.ts` (modify) | A row written after the last hook, and an early drain post |
| `packages/host/src/config.ts` (modify) | Codex hooks on by default |
| `README.md`, `docs/architecture.md`, `docs/security.md`, `docs/teams.md`, the spec (modify) | The new default, the drain, and the reason code |
| `tests/final-drain.test.ts` (create); `tests/transcript.test.ts`, `tests/transcript-watch.test.ts`, `tests/transcript-usage.test.ts`, `tests/chat.test.ts`, `tests/host-launch.test.ts` (modify) | Tests |

## Wire protocol

1. **Start.** The relay in drain mode posts the body `{}` to the `drain` hook route. While the drain window is open, the worker answers `{ transcript: { path, after, drain, secondaries? } }` from `TranscriptWatch.drainFinal()`. Otherwise it answers 204, and the relay exits.
2. **Stream.** Exactly as a hook-started drain: chunks and the text-less end mark go to `transcript` with the reply's `drain`, the listing rides on the primary end mark when the reply asks, and the wanted secondaries follow.

What differs from a hook-started drain:

- The start route and body. There is no provider payload, no Codex rollout lookup, and no stdin.
- The relay lists secondaries when the reply asks, whatever the route. The watch asks only for a Claude transcript.
- The relay's process deadline is 10 seconds, not 4. The pass budgets (64 primary, 128 secondary) do not change.
- The drain takes the turn boundary of the last provider hook, not one of its own.
- The worker serves it only after provider exit, once, until the relay process exits (after its last end mark) or 10 seconds pass.

## Review Focus

1. **The drain cannot run:** a sudo deployment without the wrapper, or with an old sudoers file that refuses it. Expect no wait for the limit, `finalDrain: "skipped"`, `drain-skipped` for a session that needed the drain, and `complete` for a session stopped idle at a clean turn end. (Tasks 1, 2, 3.)
2. **`SessionEnd` after a host stop.** A provider stopped mid-turn fires `SessionEnd` on its way out. Expect `partial` with `stopped-mid-turn`, also when the final drain reaches the end of the file. (Task 2.)
3. **A drain that hangs.** Expect the window to close at 10 seconds, the process to get `SIGTERM`, later posts to be refused, and one coverage record after the last usage record. (Tasks 1, 2, 3.)
4. **A drain post that is not the final drain:** one sent while the provider runs, a second start, or an end mark from an orphaned hook relay. Expect the first two to change nothing, and the last to give no evidence. (Tasks 2, 3.)
5. **An idle stop with nothing new.** A member stopped after a clean turn end, whose final drain finds no new bytes. Expect `complete` with `finalDrain: "complete"`. (Tasks 2, 3.)

### Task 1: the drain process

**Files:** create `final-drain.ts`, `deploy/ubuntu/transcript-drain.sh`, `tests/final-drain.test.ts`. Modify `hook-relay.ts`, `deploy/ubuntu/infinite.sudoers`, `deploy/ubuntu/README.md`, `tests/transcript.test.ts`.

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
- **Another account.** For a sudo profile, the options before `--` must be only `-n`, `--non-interactive`, `-H`, `--set-home`, `-u USER`, `--user USER`, `-g GROUP`, or `--group GROUP`: the check `teamModelLaunch` makes. Move that check into one shared function, and do not copy it. `teamModelLaunch` keeps its error messages. The executable after `--` must be absolute. The wrapper is `join(dirname(executable), DRAIN_WRAPPER)`, and it is present when `statSync(wrapper).isFile()`. The command is `profile.command` with `["-n", ...the other options in order, "--", wrapper]`. A missing wrapper or any other shape returns undefined. *(My call: the wrapper sits beside the provider wrapper the owner installed, so no config field is added. A profile without `-n` still gets it, so sudo never waits for a password.)*
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

- `drainFinal()` returns undefined when no primary transcript is open, when a final drain already started, or after a closing `finish`. Otherwise it goes through `receiveHook` with `subagent: false`, the current path and provider, and the last hook's `turnEnd` (false when none), and keeps the new drain's id as the final drain. `Current` keeps its provider for this. Only a `claude` transcript asks for secondaries.
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
| `the final drain starts once and ends hook handling` | A second `drainFinal()` returns undefined. `hook(turnFor(PATH, "claude", false))` after it returns undefined, and the record equals the one without that hook. |
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

**Interfaces (consumes):** Tasks 1 and 2. Task 4 must be committed first, because this task edits the same two docs.

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

- [ ] **Step 2: The coordinator runs `tests/chat.test.ts` and confirms the new tests fail.** It starts a host.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/transcript-watch.test.ts tests/final-drain.test.ts`, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs `tests/chat.test.ts` three times in a row, then `npm run check`, requests the independent review, and commits.**

### Task 4: Codex hooks on by default

**Files:** modify `config.ts`, `README.md`, `docs/architecture.md`, `docs/security.md`, `docs/teams.md`, `tests/host-launch.test.ts`.

**Decisions:**

- `DEFAULT_HOOKS` is `{ claude: true, codex: true }`. Its comment says that Codex hooks are on by default, and that `attention.hooks.codex: false` turns them off. The zod defaults follow it, and `manager.ts` keeps its fallback.
- Sessions with native arguments or a native interface still get no hooks. `doctor` prints its trust-flag line by default now, with its text unchanged.
- Replace each sentence that states the old default. Keep every "unverified until spike S2" statement: this phase verifies nothing about the trust flag.
  - `README.md`: "Codex hooks are off by default until S2 runs; set `attention.hooks.codex` to `true` to try them." becomes "Codex hooks are on by default; set `attention.hooks.codex` to `false` to turn them off."
  - `docs/architecture.md`: "Codex hooks are off by default until the Codex spike confirms them." becomes "Codex hooks are on by default; `attention.hooks.codex: false` turns them off."
  - `docs/security.md`: "Codex hooks are off by default. When `attention.hooks.codex` is enabled, they are injected with" becomes "Codex hooks are on by default (`attention.hooks.codex`), and they are injected with".
  - `docs/teams.md`: "Codex hooks are off by default, so Codex members reach the coordinator through the dialog." becomes "With Codex hooks on, the default, a Codex request also carries its hook tool input when the hook reports one; with them off, Codex members reach the coordinator through the dialog."
- No digest changes. The routine authority digest in `routines.ts` hashes the project, `teams`, `source`, `linear`, and `agents`, not `attention`. No other digest reads `attention`.

- [ ] **Step 1: Rewrite the default test** in `tests/host-launch.test.ts`. `codex hooks stay off unless the config turns them on` becomes `codex hooks are on unless the config turns them off`: `{ ...DEFAULT_HOOKS }` is `{ claude: true, codex: true }`. With no attention block, `attention` is undefined. `attention: {}` gives `{ claude: true, codex: true }`. `hooks: { claude: false }` gives `{ claude: false, codex: true }`. `hooks: { codex: false }` gives `{ claude: true, codex: false }`. With `DEFAULT_HOOKS`, the Codex launch args include `--dangerously-bypass-hook-trust` and end with the prompt. With `{ claude: true, codex: false }` they are `["-a", "on-request", "go"]`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/host-launch.test.ts tests/attention-hooks.test.ts`, then `npm run typecheck -w @infinite/host`. The coordinator runs `tests/team-permissions.test.ts`, `tests/teams.test.ts`, and `tests/missions.test.ts`, which start a host, because Codex members now launch with hooks.

Tasks 1, 2, and 4 touch separate files and can run in parallel. Task 3 runs last.

## Not in this phase

- Installing the wrapper and the new sudoers file on the execution host. Until then, sudo sessions report `finalDrain: "skipped"`.
- The ledger and clients (phase 3): reading coverage that now follows the exit record, keeping `finalDrain`, and showing `drain-skipped`.
- A larger pass budget for the drain.
- Confirming whether Claude Code runs `SessionEnd` on `SIGTERM`, and spike S2.
- Codex child threads, native Codex sessions, and OpenCode.
