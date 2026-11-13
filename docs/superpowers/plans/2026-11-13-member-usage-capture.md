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
