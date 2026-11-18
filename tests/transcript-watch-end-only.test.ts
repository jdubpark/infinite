import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptWatch, type WatchHook } from "../packages/host/src/transcript-watch.js";
import { UsageTail } from "../packages/host/src/transcript-usage.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

// An end-only hook is a Codex turn-end notify with Codex hooks off (INF-213). No hook marks the start of the next
// turn, so the watch reads the turn boundary from the transcript itself, after the provider exited: a `task_started`
// row starts a turn, and a `task_complete` row that names the same turn ends it. The hook is only the reason to read.

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
/** One request of `own` tokens. `thread` is the conversation's total after it. */
const requestRow = (response: string, turn: string, own: number, thread = own) => line({
  timestamp: STAMP, type: "token_usage_record",
  payload: { response_id: response, thread_id: "thread_watch_01", turn_id: turn, usage: usageOf(own), thread_token_usage: usageOf(thread) },
});
const totalRow = (total: number) => line({
  timestamp: STAMP, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usageOf(total) } },
});

/** A turn up to its usage, as Codex writes it: start, context, one request, and the total that reconciles it. */
const OPEN_1 = startRow("turn-1") + contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
const TURN_1 = OPEN_1 + endRow("turn-1");
const OPEN_2 = startRow("turn-2") + contextRow("turn-2") + requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300);
const TURN_2 = OPEN_2 + endRow("turn-2");

const COMPLETE = { coverage: "complete", provider: "codex", finalDrain: "complete" };
const MID_TURN = { coverage: "partial", reason: "stopped-mid-turn", provider: "codex", finalDrain: "complete" };

const watchFor = (usage: UsageRecord[] = []) => new TranscriptWatch({ provider: "codex", onUsage: record => usage.push(record) });
const NOTIFY: WatchHook = { subagent: false, turnEnd: true, endOnly: true, transcript: { path: PATH, provider: "codex" } };
const mark = (watch: TranscriptWatch, path: string, offset: number, drain: number) => watch.post({ path, offset, end: true, drain });

/** The drain of `hook` reads `rows` from `offset` to its end mark. Returns the cursor. */
function drainOf(watch: TranscriptWatch, hook: WatchHook, rows: string, offset = 0): number {
  const started = watch.hook(hook)!;
  if (rows) watch.post({ path: PATH, offset, text: rows, drain: started.drain });
  mark(watch, PATH, offset + bytes(rows), started.drain);
  return offset + bytes(rows);
}

/** The final drain after the provider exited, reading `rows` from `offset` to the end. */
function finalDrain(watch: TranscriptWatch, offset: number, rows = "") {
  const final = watch.drainFinal()!;
  if (rows) watch.post({ path: PATH, offset, text: rows, drain: final.drain });
  mark(watch, PATH, offset + bytes(rows), final.drain);
  return watch.finish(true, true);
}

/** One notice whose drain reads `first`, then an exit whose final drain reads `rest`. */
function exitAfter(first: string, rest = "") {
  const watch = watchFor();
  return finalDrain(watch, drainOf(watch, NOTIFY, first), rest);
}

test("an end-only turn end is complete when the final drain shows the turn ended", () => {
  assert.deepEqual(exitAfter(TURN_1), { ...COMPLETE, records: 1 });
});

test("an end-only turn end needs a final drain that read the transcript to its end", () => {
  // The notice's read saw the turn end, but only a read after the provider exited has seen every row written since.
  const unread = watchFor();
  drainOf(unread, NOTIFY, TURN_1);
  assert.deepEqual(unread.finish(true), { coverage: "partial", reason: "stopped-mid-turn", records: 1, provider: "codex" });
  // The final drain was owed and never started, as when its relay cannot launch.
  const skipped = watchFor();
  drainOf(skipped, NOTIFY, TURN_1);
  assert.deepEqual(skipped.finish(true, true), { coverage: "partial", reason: "drain-skipped", records: 1, provider: "codex", finalDrain: "skipped" });
  // The final drain started and never reached its end.
  const cut = watchFor();
  drainOf(cut, NOTIFY, TURN_1);
  assert.ok(cut.drainFinal());
  assert.deepEqual(cut.finish(true, true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "codex", finalDrain: "incomplete" });
  // A hook that is not end-only keeps the allowance for a skipped drain: a later turn would have sent its own hook.
  const ordinary = watchFor();
  drainOf(ordinary, { subagent: false, turnEnd: true, transcript: { path: PATH, provider: "codex" } }, TURN_1);
  assert.deepEqual(ordinary.finish(true, true), { coverage: "complete", records: 1, provider: "codex", finalDrain: "skipped" });
});

test("a later turn that was cut short is stopped mid-turn, wherever it stopped", () => {
  // The later turn wrote its start row only; its start and context; or everything except its end row.
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
  // The next turn began before the watch read for the notice, so no row arrives after that read.
  assert.deepEqual(exitAfter(TURN_1 + startRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1 + startRow("turn-2") + contextRow("turn-2")), { ...MID_TURN, records: 1 });
});

test("a later turn that reuses an ended turn's id is still an open turn", () => {
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-1")), { ...MID_TURN, records: 1 });
  // The reused start is read by the notice's own drain.
  assert.deepEqual(exitAfter(TURN_1 + startRow("turn-1")), { ...MID_TURN, records: 1 });
  // A second notice for the first turn follows the reused start.
  const watch = watchFor();
  const first = drainOf(watch, NOTIFY, TURN_1);
  const second = drainOf(watch, NOTIFY, startRow("turn-1"), first);
  assert.deepEqual(finalDrain(watch, second), { ...MID_TURN, records: 1 });
});

test("an aborted turn is not an ended turn", () => {
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + event("turn_aborted", "turn-2")), { ...MID_TURN, records: 1 });
});

test("an end row closes only the turn it names", () => {
  // A late end row of an earlier turn, an end row with no turn, and a start row with no turn close nothing.
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + endRow("turn-1")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, startRow("turn-2") + endRow()), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, startRow() + endRow()), { ...MID_TURN, records: 1 });
});

test("rows the turn writes after the notice was read complete it", () => {
  // The notice's drain read up to the request row. The total, a second context row, the end row and a between-turn
  // row arrive in the final drain.
  const first = startRow("turn-1") + contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150);
  const late = totalRow(1150) + contextRow("turn-1") + endRow("turn-1") + event("thread_settings_applied");
  assert.deepEqual(exitAfter(first, late), { ...COMPLETE, records: 1 });
  // Without the end row the turn stays open.
  assert.deepEqual(exitAfter(first, totalRow(1150)), { ...MID_TURN, records: 1 });
});

test("a later turn that ends completes the session, with or without its own notice", () => {
  const noticed = watchFor();
  const first = drainOf(noticed, NOTIFY, TURN_1);
  const second = drainOf(noticed, NOTIFY, TURN_2, first);
  assert.deepEqual(finalDrain(noticed, second), { ...COMPLETE, records: 2 });
  // The second notice was lost. The final drain reads the turn to its end row.
  assert.deepEqual(exitAfter(TURN_1, TURN_2), { ...COMPLETE, records: 2 });
});

test("a turn that no start row announced is an open turn", () => {
  // A start row this reader does not know leaves no trace. The turn's context and usage rows still show that it began.
  assert.deepEqual(exitAfter(TURN_1, contextRow("turn-2")), { ...MID_TURN, records: 1 });
  assert.deepEqual(exitAfter(TURN_1, requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300)), { ...MID_TURN, records: 2 });
  // Its end row closes nothing: no start row named the turn.
  assert.deepEqual(exitAfter(TURN_1, contextRow("turn-2") + endRow("turn-2")), { ...MID_TURN, records: 1 });
  // A context row before the first start row belongs to the turn that the start row then names.
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
  // With Codex hooks on, a turn-start hook would have cleared the turn end. The watch does not read the transcript for it.
  const hook: WatchHook = { subagent: false, turnEnd: true, transcript: { path: PATH, provider: "codex" } };
  const watch = watchFor();
  const offset = drainOf(watch, hook, TURN_1);
  assert.deepEqual(finalDrain(watch, offset, startRow("turn-2") + contextRow("turn-2")), { ...COMPLETE, records: 1 });
  // A transcript with no start row at all changes nothing for it either.
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
  // The transcript shows the turn ended, and the later hook says it did not: the hook is the source again.
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
