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
