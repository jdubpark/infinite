import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptWatch, type WatchHook } from "../packages/host/src/transcript-watch.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

// An end-only hook is a Codex turn-end notify with Codex hooks off (INF-213). No hook marks the start of the next
// turn, so the watch reads the turn boundary from the transcript itself.

const PATH = "/transcripts/rollout.jsonl";
const OTHER = "/transcripts/rollout-2.jsonl";
const STAMP = "2026-01-01T00:00:00.000Z";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const bytes = (text: string) => Buffer.byteLength(text);
const usageOf = (total: number) => ({
  input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: total - 1000, reasoning_output_tokens: 0, total_tokens: total,
});
const turnRow = (turn: string) => line({ timestamp: STAMP, type: "turn_context", payload: { turn_id: turn, model: "model-fixture-a" } });
/** One request of `own` tokens. `thread` is the conversation's total after it. */
const requestRow = (response: string, turn: string, own: number, thread = own) => line({
  timestamp: STAMP, type: "token_usage_record",
  payload: { response_id: response, thread_id: "thread_watch_01", turn_id: turn, usage: usageOf(own), thread_token_usage: usageOf(thread) },
});
const totalRow = (total: number) => line({
  timestamp: STAMP, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usageOf(total) } },
});

const watchFor = (usage: UsageRecord[] = []) => new TranscriptWatch({ provider: "codex", onUsage: record => usage.push(record) });
const notify = (path = PATH): WatchHook => ({ subagent: false, turnEnd: true, endOnly: true, transcript: { path, provider: "codex" } });
const hookEnd = (path = PATH): WatchHook => ({ subagent: false, turnEnd: true, transcript: { path, provider: "codex" } });
const mark = (watch: TranscriptWatch, path: string, offset: number, drain: number) => watch.post({ path, offset, end: true, drain });

/** A completed turn: its context, one request, and the cumulative total that reconciles it. */
const TURN_1 = turnRow("turn-1") + requestRow("resp_1", "turn-1", 1150) + totalRow(1150);

/** One completed turn, read to its end by the drain of `hook`. Returns the cursor. */
function firstTurn(watch: TranscriptWatch, hook: WatchHook, rows = TURN_1): number {
  const started = watch.hook(hook)!;
  watch.post({ path: PATH, offset: 0, text: rows, drain: started.drain });
  mark(watch, PATH, bytes(rows), started.drain);
  return bytes(rows);
}

/** The final drain after the provider exited, reading `rows` from `offset` to the end. */
function finalDrain(watch: TranscriptWatch, offset: number, rows = "") {
  const final = watch.drainFinal()!;
  if (rows) watch.post({ path: PATH, offset, text: rows, drain: final.drain });
  mark(watch, PATH, offset + bytes(rows), final.drain);
  return watch.finish(true, true);
}

test("an end-only turn end with no later turn is complete", () => {
  const watch = watchFor();
  const offset = firstTurn(watch, notify());
  assert.deepEqual(finalDrain(watch, offset), { coverage: "complete", records: 1, provider: "codex", finalDrain: "complete" });
});

test("a later turn cut short after an end-only turn end is stopped mid-turn", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor(usage);
  const offset = firstTurn(watch, notify());
  watch.stopRequested();
  // The second turn wrote its context and was stopped before its usage row.
  assert.deepEqual(finalDrain(watch, offset, turnRow("turn-2")),
    { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex", finalDrain: "complete" });
  assert.equal(usage.length, 1);
});

test("rows of the same turn written after an end-only turn end keep it complete", () => {
  const watch = watchFor();
  // The notice's drain read the request row; the turn's total row was written after it.
  const offset = firstTurn(watch, notify(), turnRow("turn-1") + requestRow("resp_1", "turn-1", 1150));
  assert.deepEqual(finalDrain(watch, offset, totalRow(1150)), { coverage: "complete", records: 1, provider: "codex", finalDrain: "complete" });
});

test("a second end-only turn end restores complete coverage", () => {
  const watch = watchFor();
  const offset = firstTurn(watch, notify());
  const second = turnRow("turn-2") + requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300);
  const started = watch.hook(notify())!;
  watch.post({ path: PATH, offset, text: second, drain: started.drain });
  mark(watch, PATH, offset + bytes(second), started.drain);
  assert.deepEqual(finalDrain(watch, offset + bytes(second)), { coverage: "complete", records: 2, provider: "codex", finalDrain: "complete" });
});

test("a transcript that names no turn needs no later byte after an end-only turn end", () => {
  const rows = requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
  const quiet = watchFor();
  assert.deepEqual(finalDrain(quiet, firstTurn(quiet, notify(), rows)), { coverage: "complete", records: 1, provider: "codex", finalDrain: "complete" });
  const grown = watchFor();
  assert.deepEqual(finalDrain(grown, firstTurn(grown, notify(), rows), totalRow(1150)),
    { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex", finalDrain: "complete" });
});

test("an end-only turn end whose drain never reached its end does not stand", () => {
  const watch = watchFor();
  const rows = TURN_1;
  const started = watch.hook(notify())!;
  // The relay sent the bytes and was cut before its end mark.
  watch.post({ path: PATH, offset: 0, text: rows, drain: started.drain });
  assert.deepEqual(finalDrain(watch, bytes(rows)), { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex", finalDrain: "complete" });
});

test("a hook that is not end-only keeps its turn end when later rows arrive", () => {
  // With Codex hooks on, a turn-start hook would have cleared the turn end. The watch does not read the transcript for it.
  const watch = watchFor();
  const offset = firstTurn(watch, hookEnd());
  assert.deepEqual(finalDrain(watch, offset, turnRow("turn-2")), { coverage: "complete", records: 1, provider: "codex", finalDrain: "complete" });
});

test("a later hook that is not end-only replaces an end-only turn end", () => {
  const watch = watchFor();
  const offset = firstTurn(watch, notify());
  const second = turnRow("turn-2");
  const started = watch.hook({ subagent: false, turnEnd: false, transcript: { path: PATH, provider: "codex" } })!;
  watch.post({ path: PATH, offset, text: second, drain: started.drain });
  mark(watch, PATH, offset + bytes(second), started.drain);
  assert.deepEqual(finalDrain(watch, offset + bytes(second)),
    { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex", finalDrain: "complete" });
});

test("a transcript replaced after an end-only turn end leaves a gap", () => {
  const watch = watchFor();
  firstTurn(watch, notify());
  const rows = turnRow("turn-9") + requestRow("resp_9", "turn-9", 1150) + totalRow(1150);
  const started = watch.hook(notify(OTHER))!;
  watch.post({ path: OTHER, offset: 0, text: rows, drain: started.drain });
  mark(watch, OTHER, bytes(rows), started.drain);
  const final = watch.drainFinal()!;
  mark(watch, OTHER, bytes(rows), final.drain);
  assert.deepEqual(watch.finish(true, true), { coverage: "partial", reason: "drain-incomplete", records: 2, provider: "codex", finalDrain: "complete" });
});
