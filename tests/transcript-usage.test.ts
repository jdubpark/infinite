import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UsageTail, usageCoverage, usageRecordKey, type UsageCoverageInput } from "../packages/host/src/transcript-usage.js";
import type { UsageRecord, UsageTokens } from "../packages/host/src/usage.js";

const fixture = (name: string) => new URL(`./fixtures/usage/${name}`, import.meta.url);

/** Pushes every row of a fixture. Lines that are not JSON are skipped, as a relay would skip them. */
function pushFixture(tail: UsageTail, name: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of readFileSync(fixture(name), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    records.push(...tail.push(row));
  }
  return records;
}

function claudeRow(messageId: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "session-fixture-a",
    message: { id: messageId, model: "model-fixture-a", usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
    ...extra,
  };
}

const codexUsage = { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 150, reasoning_output_tokens: 30, total_tokens: 1150 };

function requestRow(responseId: string, turnId: string, usage: Record<string, number>) {
  return { timestamp: "2026-01-01T00:00:00.000Z", type: "token_usage_record", payload: { response_id: responseId, thread_id: "thread_fixture_01", turn_id: turnId, usage, thread_token_usage: usage } };
}

function countRow(total: Record<string, number>) {
  return { timestamp: "2026-01-01T00:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } };
}

function turnRow(turnId: string, model: string) {
  return { timestamp: "2026-01-01T00:00:00.000Z", type: "turn_context", payload: { turn_id: turnId, model, effort: "medium" } };
}

const TOKEN_CLASSES: (keyof UsageTokens)[] = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
const sumClasses = (tokens: UsageTokens) => TOKEN_CLASSES.reduce((total, key) => total + tokens[key], 0);
const RECORD_KEYS = ["provider", "providerId", "modelId", "messageId", "partId", "nativeId", "secondary", "modelSource", "completedAt", "tokens", "cacheWrite1h", "reportedCost"];

test("a Claude request split over rows yields one record", () => {
  const records = pushFixture(new UsageTail({ provider: "claude" }), "claude-session.jsonl");
  assert.equal(records.length, 2);
  assert.equal(records.some(record => record.messageId === "msg_fixture_03"), false);
  assert.equal(records.filter(record => record.messageId === "msg_fixture_01").length, 1);
});

test("Claude classes do not overlap", () => {
  const record = pushFixture(new UsageTail({ provider: "claude" }), "claude-session.jsonl").find(item => item.messageId === "msg_fixture_02");
  assert.ok(record);
  assert.equal(record.tokens.reasoning, 40);
  assert.equal(record.tokens.output, 60);
  assert.equal(record.tokens.cacheWrite, 700);
  assert.equal(record.cacheWrite1h, 500);
  assert.equal(record.tokens.input, 1200);
  assert.equal(record.tokens.cacheRead, 5000);
});

test("a Claude message that grows is emitted again", () => {
  const tail = new UsageTail({ provider: "claude" });
  const first = tail.push(claudeRow("msg_grow_01", { output_tokens: 10 }));
  assert.equal(first.length, 1);
  assert.equal(first[0]!.tokens.output, 10);
  const second = tail.push(claudeRow("msg_grow_01", { output_tokens: 30 }));
  assert.equal(second.length, 1);
  assert.equal(second[0]!.tokens.output, 30);
  assert.deepEqual(tail.push(claudeRow("msg_grow_01", { output_tokens: 30 })), []);
});

test("Codex request rows yield one record per response", () => {
  const tail = new UsageTail({ provider: "codex" });
  const records = pushFixture(tail, "codex-session.jsonl");
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(record => record.messageId)).size, 3);
  const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const record of records) for (const key of TOKEN_CLASSES) sum[key] += record.tokens[key];
  assert.deepEqual(sum, { input: 2000, output: 270, reasoning: 80, cacheRead: 300, cacheWrite: 0 });
  assert.equal(sum.input + sum.cacheRead, 2300);
  assert.deepEqual(tail.finish(), []);
});

test("a Codex record takes its model from its turn", () => {
  const records = pushFixture(new UsageTail({ provider: "codex" }), "codex-session.jsonl");
  const byResponse = (id: string) => records.find(record => record.messageId === id);
  assert.deepEqual([byResponse("resp_fixture_01")?.modelId, byResponse("resp_fixture_01")?.modelSource], ["model-fixture-a", "reported"]);
  assert.deepEqual([byResponse("resp_fixture_02")?.modelId, byResponse("resp_fixture_02")?.modelSource], ["model-fixture-b", "reported"]);
  assert.deepEqual([byResponse("resp_fixture_03")?.modelId, byResponse("resp_fixture_03")?.modelSource], ["model-fixture-b", "reported"]);

  const requested = new UsageTail({ provider: "codex", requestedModel: "model-requested" }).push(requestRow("resp_req_01", "turn_missing", codexUsage));
  assert.deepEqual([requested[0]?.modelId, requested[0]?.modelSource], ["model-requested", "requested"]);

  const unknown = new UsageTail({ provider: "codex" }).push(requestRow("resp_unk_01", "turn_missing", codexUsage));
  assert.deepEqual([unknown[0]?.modelId, unknown[0]?.providerId, unknown[0]?.modelSource], ["unknown", "codex", "unknown"]);
});

test("a Codex conversation without request rows falls back to cumulative totals", () => {
  const tail = new UsageTail({ provider: "codex" });
  assert.deepEqual(pushFixture(tail, "codex-cumulative-session.jsonl"), []);
  const records = tail.finish();
  assert.deepEqual(records, [{
    provider: "codex", providerId: "codex", modelId: "model-fixture-a", messageId: "cumulative:thread_fixture_02", partId: "",
    nativeId: "thread_fixture_02", modelSource: "reported", completedAt: "2026-01-01T00:00:04.000Z",
    tokens: { input: 180, output: 120, reasoning: 40, cacheRead: 60, cacheWrite: 0 }, reportedCost: 0,
  }]);
  assert.deepEqual(tail.finish(), records);
  assert.equal(tail.cumulativeTotal(), 400);
});

test("a cumulative total that shrinks or is invalid is ignored", () => {
  const tail = new UsageTail({ provider: "codex" });
  tail.push({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread_shrink_01" } });
  tail.push(countRow({ input_tokens: 60, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 100 }));
  tail.push(countRow({ input_tokens: 150, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 250 }));
  tail.push(countRow({ input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 10, total_tokens: 200 }));
  tail.push(countRow({ input_tokens: 100, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 400 }));
  const records = tail.finish();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.tokens, { input: 120, cacheRead: 30, cacheWrite: 0, output: 80, reasoning: 20 });
  assert.equal(tail.cumulativeTotal(), 250);
});

test("a Codex request takes the model of its own turn", () => {
  const tail = new UsageTail({ provider: "codex" });
  tail.push(turnRow("turn_a", "model-fixture-a"));
  tail.push(turnRow("turn_b", "model-fixture-b"));
  const [record] = tail.push(requestRow("resp_turn_a_01", "turn_a", codexUsage));
  assert.equal(record?.modelId, "model-fixture-a");
  assert.equal(record?.modelSource, "reported");
});

test("a Claude message merges inclusive output before it splits reasoning", () => {
  const tail = new UsageTail({ provider: "claude" });
  const first = tail.push(claudeRow("msg_merge_01", { output_tokens: 100 }));
  assert.equal(first[0]?.tokens.output, 100);
  const second = tail.push(claudeRow("msg_merge_01", { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }));
  assert.equal(second.length, 1);
  assert.equal(second[0]?.tokens.output, 60);
  assert.equal(second[0]?.tokens.reasoning, 40);
});

test("a cumulative fallback without a thread id yields nothing", () => {
  const tail = new UsageTail({ provider: "codex" });
  tail.push(countRow({ input_tokens: 60, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 100 }));
  assert.deepEqual(tail.finish(), []);
  assert.equal(tail.cumulativeTotal(), 100);
});

test("request rows that start late cancel the fallback", () => {
  const sessionMeta = { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread_late_01" } };
  const total = countRow({ input_tokens: 60, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 100 });

  const control = new UsageTail({ provider: "codex" });
  control.push(sessionMeta);
  control.push(total);
  control.push(total);
  assert.equal(control.finish().length, 1);

  const late = new UsageTail({ provider: "codex" });
  late.push(sessionMeta);
  late.push(total);
  late.push(total);
  assert.equal(late.push(requestRow("resp_late_01", "turn_missing", codexUsage)).length, 1);
  assert.deepEqual(late.finish(), []);
});

test("invalid rows yield nothing", () => {
  const tail = new UsageTail({ provider: "claude" });
  const codex = new UsageTail({ provider: "codex" });
  const rows: unknown[] = [
    null, "text", [],
    claudeRow("msg_bad_01", { input_tokens: -1 }),
    claudeRow("msg_bad_02", { output_tokens: 1.5 }),
    claudeRow("msg_bad_03", { output_tokens: "7" }),
    claudeRow("msg_bad_04", { output_tokens: 10, output_tokens_details: { thinking_tokens: 20 } }),
  ];
  for (const row of rows) assert.deepEqual(tail.push(row), []);
  assert.deepEqual(codex.push(requestRow("resp_bad_01", "turn_bad", { ...codexUsage, cached_input_tokens: 2000 })), []);
  assert.deepEqual(codex.finish(), []);
});

test("a Codex total that contradicts its counts is refused", () => {
  const meta = { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread_total_01" } };
  const tail = new UsageTail({ provider: "codex" });
  tail.push(meta);
  tail.push(countRow({ input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100 }));
  tail.push(countRow({ input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 300 }));
  const [record] = tail.finish();
  assert.ok(record);
  assert.deepEqual(record.tokens, { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(tail.cumulativeTotal(), 100);
  const request = new UsageTail({ provider: "codex" });
  assert.deepEqual(request.push(requestRow("resp_total_01", "turn_missing", { ...codexUsage, total_tokens: 9999 })), []);
});

test("a record holds only usage fields", () => {
  const records = new UsageTail({ provider: "claude" }).push(claudeRow("msg_private_01", {}, { cwd: "private-marker", message: { id: "msg_private_01", model: "model-fixture-a", content: "private-marker", usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  const [record] = records;
  assert.ok(record);
  for (const key of Object.keys(record)) assert.ok(RECORD_KEYS.includes(key), `unexpected key ${key}`);
  assert.deepEqual(Object.keys(record.tokens).sort(), [...TOKEN_CLASSES].sort());
  const json = JSON.stringify(record);
  assert.equal(json.includes("private-marker"), false);
});

test("a secondary tail marks its records", () => {
  const marked = pushFixture(new UsageTail({ provider: "claude", secondary: true }), "claude-session.jsonl");
  assert.ok(marked.length > 0);
  assert.equal(marked.every(record => record.secondary === true), true);
  const plain = pushFixture(new UsageTail({ provider: "claude" }), "claude-session.jsonl");
  assert.equal(plain.every(record => !("secondary" in record)), true);
});

test("usageRecordKey joins the provider and the message", () => {
  const claude = pushFixture(new UsageTail({ provider: "claude" }), "claude-session.jsonl")[0];
  const codex = pushFixture(new UsageTail({ provider: "codex" }), "codex-session.jsonl")[0];
  assert.ok(claude && codex);
  assert.equal(usageRecordKey(claude), "claude:msg_fixture_01");
  assert.equal(usageRecordKey(codex), "codex:resp_fixture_01");
});

test("usage coverage follows the rule table", () => {
  const complete: UsageCoverageInput = { provider: "claude", hooks: true, rows: 5, records: 2, dropped: false, lastDrain: { complete: true, turnEnd: true }, secondary: "none", childThreads: false, totalMismatch: false };
  const none = (reason: string) => ({ coverage: "none", reason });
  const partial = (reason: string) => ({ coverage: "partial", reason });
  assert.deepEqual(usageCoverage(complete), { coverage: "complete" });
  assert.deepEqual(usageCoverage({ ...complete, provider: "demo" }), { coverage: "complete" });
  assert.deepEqual(usageCoverage({ ...complete, provider: "opencode" }), none("unsupported"));
  assert.deepEqual(usageCoverage({ ...complete, hooks: false }), none("hooks-off"));
  assert.deepEqual(usageCoverage({ ...complete, rows: 0 }), none("no-transcript"));
  assert.deepEqual(usageCoverage({ ...complete, records: 0 }), none("no-usage-fields"));
  assert.deepEqual(usageCoverage({ ...complete, dropped: true }), partial("row-dropped"));
  assert.deepEqual(usageCoverage({ ...complete, totalMismatch: true }), partial("row-dropped"));
  assert.deepEqual(usageCoverage({ ...complete, lastDrain: undefined }), partial("drain-incomplete"));
  assert.deepEqual(usageCoverage({ ...complete, lastDrain: { complete: false, turnEnd: true } }), partial("drain-incomplete"));
  assert.deepEqual(usageCoverage({ ...complete, lastDrain: { complete: true, turnEnd: false } }), partial("stopped-mid-turn"));
  assert.deepEqual(usageCoverage({ ...complete, secondary: "complete" }), { coverage: "complete" });
  assert.deepEqual(usageCoverage({ ...complete, secondary: "missing" }), partial("secondary-missing"));
  assert.deepEqual(usageCoverage({ ...complete, childThreads: true }), partial("child-threads"));
  assert.deepEqual(usageCoverage({ ...complete, finalDrain: "skipped" }), { coverage: "complete" });
  assert.deepEqual(usageCoverage({ ...complete, finalDrain: "skipped", lastDrain: { complete: true, turnEnd: false } }), partial("drain-skipped"));
  assert.deepEqual(usageCoverage({ ...complete, finalDrain: "skipped", lastDrain: { complete: false, turnEnd: true } }), partial("drain-skipped"));
  assert.deepEqual(usageCoverage({ ...complete, finalDrain: "skipped", lastDrain: undefined }), partial("drain-skipped"));
  assert.deepEqual(usageCoverage({ ...complete, finalDrain: "incomplete", lastDrain: { complete: false, turnEnd: true } }), partial("drain-incomplete"));
  assert.deepEqual(usageCoverage({ ...complete, finalDrain: "skipped", dropped: true }), partial("row-dropped"));
});

test("the tail counts rows, records, and request totals", () => {
  const tail = new UsageTail({ provider: "codex" });
  pushFixture(tail, "codex-session.jsonl");
  assert.equal(tail.rowCount(), 11);
  assert.equal(tail.recordCount(), 3);
  assert.equal(tail.requestTotal(), 2650);
  assert.equal(tail.cumulativeTotal(), 2650);
});

test("child-thread rows are detected", () => {
  const tail = new UsageTail({ provider: "codex" });
  pushFixture(tail, "codex-session.jsonl");
  assert.equal(tail.sawChildThreads(), false);
  tail.push({ timestamp: "2026-01-01T00:00:05.000Z", type: "inter_agent_communication_metadata", payload: {} });
  assert.equal(tail.sawChildThreads(), true);
});

test("reconciled holds when request totals match the last cumulative total", () => {
  assert.equal(pushFixtureTail("codex-session.jsonl").reconciled(), true);
  const missingTotal = new UsageTail({ provider: "codex" });
  missingTotal.push(requestRow("resp_unreconciled_01", "turn_unreconciled", codexUsage));
  assert.equal(missingTotal.reconciled(), false);
  assert.equal(new UsageTail({ provider: "claude" }).reconciled(), true);
});

/** The usage tail of a fixture, with every row pushed. */
function pushFixtureTail(name: string): UsageTail {
  const tail = new UsageTail({ provider: "codex" });
  pushFixture(tail, name);
  return tail;
}

test("rejectedCount counts usage-bearing rows the parser refuses, and not repeats or synthetic rows", () => {
  const claude = new UsageTail({ provider: "claude" });
  claude.push(claudeRow("msg_ok", { output_tokens: 10 }));
  claude.push(claudeRow("msg_ok", { output_tokens: 10 }));
  claude.push(claudeRow("msg_bad", { output_tokens: "7" }));
  claude.push(claudeRow("msg_synthetic", {}, { message: { id: "msg_synthetic", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  claude.push({ type: "assistant", timestamp: "2026-01-01T00:00:00.000Z", message: "not an object" });
  assert.equal(claude.rejectedCount(), 1);

  const codex = new UsageTail({ provider: "codex" });
  codex.push(requestRow("resp_bad", "turn_bad", { ...codexUsage, cached_input_tokens: 2000 }));
  codex.push(countRow({ ...codexUsage, cached_input_tokens: 2000 }));
  codex.push(countRow(codexUsage));
  codex.push(countRow(codexUsage));
  assert.equal(codex.rejectedCount(), 2);
});

test("a repeated response counts once, and a larger total for it replaces the record", () => {
  const tail = new UsageTail({ provider: "codex" });
  assert.equal(tail.push(requestRow("resp_dup", "turn_dup", codexUsage)).length, 1);
  assert.deepEqual(tail.push(requestRow("resp_dup", "turn_dup", codexUsage)), []);
  const larger = { input_tokens: 1500, cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 230, reasoning_output_tokens: 30, total_tokens: 1730 };
  const grown = tail.push(requestRow("resp_dup", "turn_dup", larger));
  assert.equal(grown.length, 1);
  // The record under the same key holds the whole new snapshot. Only the difference joins the request total.
  assert.deepEqual(grown[0]?.tokens, { input: 1200, output: 200, reasoning: 30, cacheRead: 300, cacheWrite: 0 });
  assert.equal(grown[0]?.messageId, "resp_dup");
  assert.equal(tail.requestTotal(), 1730);
});

test("an overflowing response table makes reconciled false from then on", () => {
  const tail = new UsageTail({ provider: "codex" });
  for (let index = 0; index < 4096; index++) tail.push(requestRow(`resp_bound_${index}`, "turn_bound", codexUsage));
  tail.push(requestRow("resp_bound_overflow", "turn_bound", codexUsage));
  assert.equal(tail.reconciled(), false);
});

test("a cumulative-only conversation is reconciled only once its thread id is known", () => {
  const tail = new UsageTail({ provider: "codex" });
  tail.push(countRow(codexUsage));
  assert.equal(tail.reconciled(), false);
  tail.push({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "thread_meta_01" } });
  assert.equal(tail.reconciled(), true);
});
