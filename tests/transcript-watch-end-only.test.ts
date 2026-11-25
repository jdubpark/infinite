import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptWatch, type WatchHook } from "../packages/host/src/transcript-watch.js";
import { UsageTail } from "../packages/host/src/transcript-usage.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

const PATH = "/transcripts/rollout.jsonl";
const OTHER = "/transcripts/rollout-2.jsonl";
const STAMP = "2026-01-01T00:00:00.000Z";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const bytes = (text: string) => Buffer.byteLength(text);
const usageOf = (total: number) => ({
  input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: total - 1000, reasoning_output_tokens: 0, total_tokens: total,
});
const event = (type: string, turn?: string) => line({ timestamp: STAMP, type: "event_msg", payload: { type, ...(turn ? { turn_id: turn } : {}) } });
const startRow = (turn?: string) => event("task_started", turn);
const endRow = (turn?: string) => event("task_complete", turn);
const contextRow = (turn: string) => line({ timestamp: STAMP, type: "turn_context", payload: { turn_id: turn, model: "model-fixture-a" } });
const requestRow = (response: string, turn: string, own: number, thread = own) => line({
  timestamp: STAMP, type: "token_usage_record",
  payload: { response_id: response, thread_id: "thread_watch_01", turn_id: turn, usage: usageOf(own), thread_token_usage: usageOf(thread) },
});
const totalRow = (total: number) => line({
  timestamp: STAMP, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usageOf(total) } },
});

const OPEN_1 = startRow("turn-1") + contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
const TURN_1 = OPEN_1 + endRow("turn-1");
const OPEN_2 = startRow("turn-2") + contextRow("turn-2") + requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300);
const TURN_2 = OPEN_2 + endRow("turn-2");

const COMPLETE = { coverage: "complete", provider: "codex", finalDrain: "complete" };
const MID_TURN = { coverage: "partial", reason: "stopped-mid-turn", provider: "codex", finalDrain: "complete" };

const watchFor = (usage: UsageRecord[] = []) => new TranscriptWatch({ provider: "codex", onUsage: record => usage.push(record) });
const NOTIFY: WatchHook = { subagent: false, turnEnd: true, endOnly: true, transcript: { path: PATH, provider: "codex" } };
const mark = (watch: TranscriptWatch, path: string, offset: number, drain: number) => watch.post({ path, offset, end: true, drain });

function drainOf(watch: TranscriptWatch, hook: WatchHook, rows: string, offset = 0): number {
  const started = watch.hook(hook)!;
  if (rows) watch.post({ path: PATH, offset, text: rows, drain: started.drain });
  mark(watch, PATH, offset + bytes(rows), started.drain);
  return offset + bytes(rows);
}

function finalDrain(watch: TranscriptWatch, offset: number, rows = "") {
  const final = watch.drainFinal()!;
  if (rows) watch.post({ path: PATH, offset, text: rows, drain: final.drain });
  mark(watch, PATH, offset + bytes(rows), final.drain);
  return watch.finish(true, true);
}

function exitAfter(first: string, rest = "") {
  const watch = watchFor();
  return finalDrain(watch, drainOf(watch, NOTIFY, first), rest);
}

test("an end-only turn end is complete when the final drain shows the turn ended", () => {
  assert.deepEqual(exitAfter(TURN_1), { ...COMPLETE, records: 1 });
});

test("an end-only turn end needs a final drain that read the transcript to its end", () => {
  const unread = watchFor();
  drainOf(unread, NOTIFY, TURN_1);
  assert.deepEqual(unread.finish(true), { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex" });
  const skipped = watchFor();
  drainOf(skipped, NOTIFY, TURN_1);
  assert.deepEqual(skipped.finish(true, true), { coverage: "partial", reason: "drain-skipped", records: 1, provider: "codex", finalDrain: "skipped" });
  const cut = watchFor();
  drainOf(cut, NOTIFY, TURN_1);
  assert.ok(cut.drainFinal());
  assert.deepEqual(cut.finish(true, true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "codex", finalDrain: "incomplete" });
  const ordinary = watchFor();
  drainOf(ordinary, { subagent: false, turnEnd: true, transcript: { path: PATH, provider: "codex" } }, TURN_1);
  assert.deepEqual(ordinary.finish(true, true), { coverage: "complete", records: 1, provider: "codex", finalDrain: "skipped" });
});

test("a later turn that was cut short is stopped mid-turn, wherever it stopped", () => {
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + contextRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, OPEN_2), { ...MID_TURN, records: 2 });
  const usage: UsageRecord[] = [];
  const watch = watchFor(usage);
  const offset = drainOf(watch, NOTIFY, TURN_1);
  watch.stopRequested();
  assert.deepEqual(finalDrain(watch, offset, startRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.equal(usage.length, 1);
});

test("a later turn read by the notice's own drain is still an open turn", () => {
  assert.deepEqual(exitAfter(TURN_1 + startRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1 + startRow("turn-2") + contextRow("turn-2")), { ...MID_TURN, records: 1 });
});

test("a later turn that reuses an ended turn's id is still an open turn", () => {
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-1")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1 + startRow("turn-1")), { ...MID_TURN, records: 1 });
  const watch = watchFor();
  const first = drainOf(watch, NOTIFY, TURN_1);
  const second = drainOf(watch, NOTIFY, startRow("turn-1"), first);
  assert.deepEqual(finalDrain(watch, second), { ...MID_TURN, records: 1 });
});

test("an aborted turn is not an ended turn", () => {
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + event("turn_aborted", "turn-2")), { ...MID_TURN, records: 1 });
});

test("an end row closes only the turn it names", () => {
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + endRow("turn-1")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + endRow()), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, startRow() + endRow()), { ...MID_TURN, records: 1 });
});

test("rows the turn writes after the notice was read complete it", () => {
  const first = startRow("turn-1") + contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150);
  const late = totalRow(1150) + contextRow("turn-1") + endRow("turn-1") + event("thread_settings_applied");
  assert.deepEqual(exitAfter(first, late), { ...COMPLETE, records: 1 });
  assert.deepEqual(exitAfter(first, totalRow(1150)), { ...MID_TURN, records: 1 });
});

test("a later turn that ends completes the session, with or without its own notice", () => {
  const noticed = watchFor();
  const first = drainOf(noticed, NOTIFY, TURN_1);
  const second = drainOf(noticed, NOTIFY, TURN_2, first);
  assert.deepEqual(finalDrain(noticed, second), { ...COMPLETE, records: 2 });
  assert.deepEqual(exitAfter(TURN_1, TURN_2), { ...COMPLETE, records: 2 });
});

test("a turn that no start row announced is an open turn", () => {
  assert.deepEqual(exitAfter(TURN_1, contextRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300)), { ...MID_TURN, records: 2 });
  assert.deepEqual(exitAfter(TURN_1, contextRow("turn-2") + endRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(contextRow("turn-1") + TURN_1), { ...COMPLETE, records: 1 });
});

test("the usage reader reports an ended turn only after a start row and its end row", () => {
  const ended = (rows: string) => {
    const tail = new UsageTail({ provider: "codex" });
    for (const text of rows.split("\n")) if (text) tail.push(JSON.parse(text));
    return tail.lastTurnEnded();
  };
  assert.equal(ended(""), false);
  assert.equal(ended(line({ timestamp: STAMP, type: "session_meta", payload: { id: "thread_watch_01" } })), false);
  assert.equal(ended(endRow("turn-1")), false);
  assert.equal(ended(startRow("turn-1")), false);
  assert.equal(ended(startRow("turn-1") + endRow("turn-1")), true);
});

test("a transcript that starts no turn cannot show that one ended", () => {
  const rows = contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
  assert.deepEqual(exitAfter(rows), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(rows + endRow("turn-1")), { ...MID_TURN, records: 1 });
});

test("a hook that is not end-only keeps its turn end whatever the transcript shows", () => {
  const hook: WatchHook = { subagent: false, turnEnd: true, transcript: { path: PATH, provider: "codex" } };
  const watch = watchFor();
  const offset = drainOf(watch, hook, TURN_1);
  assert.deepEqual(finalDrain(watch, offset, startRow("turn-2") + contextRow("turn-2")), { ...COMPLETE, records: 1 });
  const bare = watchFor();
  const rows = requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
  assert.deepEqual(finalDrain(bare, drainOf(bare, hook, rows)), { ...COMPLETE, records: 1 });
});

test("a later hook that is not end-only replaces an end-only turn end", () => {
  const open: WatchHook = { subagent: false, turnEnd: false, transcript: { path: PATH, provider: "codex" } };
  const closed: WatchHook = { subagent: false, turnEnd: true, transcript: { path: PATH, provider: "codex" } };
  const watch = watchFor();
  const first = drainOf(watch, NOTIFY, TURN_1);
  const second = drainOf(watch, open, TURN_2, first);
  assert.deepEqual(finalDrain(watch, second), { ...MID_TURN, records: 2 });
  const other = watchFor();
  const start = drainOf(other, NOTIFY, TURN_1);
  const end = drainOf(other, closed, OPEN_2, start);
  assert.deepEqual(finalDrain(other, end), { ...COMPLETE, records: 2 });
});

test("a transcript replaced after an end-only turn end leaves a gap", () => {
  const watch = watchFor();
  drainOf(watch, NOTIFY, TURN_1);
  const rows = startRow("turn-9") + contextRow("turn-9") + requestRow("resp_9", "turn-9", 1150) + totalRow(1150) + endRow("turn-9");
  const started = watch.hook({ ...NOTIFY, transcript: { path: OTHER, provider: "codex" } })!;
  watch.post({ path: OTHER, offset: 0, text: rows, drain: started.drain });
  mark(watch, OTHER, bytes(rows), started.drain);
  const final = watch.drainFinal()!;
  mark(watch, OTHER, bytes(rows), final.drain);
  assert.deepEqual(watch.finish(true, true), { coverage: "partial", reason: "drain-incomplete", records: 2, provider: "codex", finalDrain: "complete" });
});
