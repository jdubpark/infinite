import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptWatch, type WatchHook } from "../packages/host/src/transcript-watch.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

// An end-only hook is a Codex turn-end notify with Codex hooks off (INF-213). No hook marks the start of the next
// turn, so the watch reads the turn boundary from the transcript itself: it counts the turns the transcript starts.

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
/** The row that starts a turn. */
const startRow = (turn?: string) => event("task_started", turn);
/** The row a turn writes for its settings. A turn can write it more than once. */
const contextRow = (turn: string) => line({ timestamp: STAMP, type: "turn_context", payload: { turn_id: turn, model: "model-fixture-a" } });
/** One request of `own` tokens. `thread` is the conversation's total after it. */
const requestRow = (response: string, turn: string, own: number, thread = own) => line({
  timestamp: STAMP, type: "token_usage_record",
  payload: { response_id: response, thread_id: "thread_watch_01", turn_id: turn, usage: usageOf(own), thread_token_usage: usageOf(thread) },
});
const totalRow = (total: number) => line({
  timestamp: STAMP, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usageOf(total) } },
});

/** A completed turn as Codex writes it: start, context, one request, the total that reconciles it, and the end. */
const TURN_1 = startRow("turn-1") + contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150) + totalRow(1150) + event("task_complete", "turn-1");
const TURN_2 = startRow("turn-2") + contextRow("turn-2") + requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300) + event("task_complete", "turn-2");

const COMPLETE = { coverage: "complete", provider: "codex", finalDrain: "complete" };
const MID_TURN = { coverage: "partial", reason: "stopped-mid-turn", provider: "codex", finalDrain: "complete" };

const watchFor = (usage: UsageRecord[] = []) => new TranscriptWatch({ provider: "codex", onUsage: record => usage.push(record) });
/** A turn-end notice. `turn` is the turn it names; `null` is a notice that names none. */
const notify = (turn: string | null = "turn-1", path = PATH): WatchHook =>
  ({ subagent: false, turnEnd: true, endOnly: true, ...(turn === null ? {} : { turn }), transcript: { path, provider: "codex" } });
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

test("an end-only turn end with no later turn is complete", () => {
  const watch = watchFor();
  const offset = drainOf(watch, notify(), TURN_1);
  assert.deepEqual(finalDrain(watch, offset), { ...COMPLETE, records: 1 });
});

test("a later turn stopped before its context row is stopped mid-turn", () => {
  for (const stopAt of ["never", "before-final"] as const) {
    const usage: UsageRecord[] = [];
    const watch = watchFor(usage);
    const offset = drainOf(watch, notify(), TURN_1);
    if (stopAt === "before-final") watch.stopRequested();
    // The second turn wrote the row that starts it and nothing else.
    assert.deepEqual(finalDrain(watch, offset, startRow("turn-2")), { ...MID_TURN, records: 1 }, stopAt);
    assert.equal(usage.length, 1);
  }
});

test("a later turn stopped after its context row is stopped mid-turn", () => {
  const watch = watchFor();
  const offset = drainOf(watch, notify(), TURN_1);
  assert.deepEqual(finalDrain(watch, offset, startRow("turn-2") + contextRow("turn-2")), { ...MID_TURN, records: 1 });
});

test("a later turn that reuses the ended turn's id is still a later turn", () => {
  const watch = watchFor();
  const offset = drainOf(watch, notify(), TURN_1);
  assert.deepEqual(finalDrain(watch, offset, startRow("turn-1") + contextRow("turn-1")), { ...MID_TURN, records: 1 });
});

test("rows the ended turn writes after its end-only turn end keep it complete", () => {
  const watch = watchFor();
  // The notice's drain read the request row. The turn wrote its total, a second context row and its end after it,
  // and Codex wrote a between-turn row. None of them starts a turn.
  const offset = drainOf(watch, notify(), startRow("turn-1") + contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150));
  const late = totalRow(1150) + contextRow("turn-1") + event("task_complete", "turn-1") + event("thread_settings_applied");
  assert.deepEqual(finalDrain(watch, offset, late), { ...COMPLETE, records: 1 });
});

test("a second end-only turn end restores complete coverage", () => {
  const watch = watchFor();
  const first = drainOf(watch, notify("turn-1"), TURN_1);
  const second = drainOf(watch, notify("turn-2"), TURN_2, first);
  assert.deepEqual(finalDrain(watch, second), { ...COMPLETE, records: 2 });
});

test("an end-only turn end for a turn that is not the newest in the transcript does not stand", () => {
  // The next turn began before the notice's drain read the file: the notice names turn-1, the transcript is in turn-2.
  const watch = watchFor();
  const offset = drainOf(watch, notify("turn-1"), TURN_1 + startRow("turn-2") + contextRow("turn-2"));
  assert.deepEqual(finalDrain(watch, offset), { ...MID_TURN, records: 1 });
  // The notice for turn-2 then closes it.
  const racing = watchFor();
  const first = drainOf(racing, notify("turn-1"), TURN_1 + startRow("turn-2") + contextRow("turn-2"));
  const rest = requestRow("resp_2", "turn-2", 1150, 2300) + totalRow(2300) + event("task_complete", "turn-2");
  const second = drainOf(racing, notify("turn-2"), rest, first);
  assert.deepEqual(finalDrain(racing, second), { ...COMPLETE, records: 2 });
});

test("a later end mark of the same drain does not move the turn boundary", () => {
  // The second case reuses the ended turn's id, so only the count taken at the first mark shows the later turn.
  for (const more of [startRow("turn-2") + contextRow("turn-2"), startRow("turn-1")]) {
    const watch = watchFor();
    const started = watch.hook(notify("turn-1"))!;
    watch.post({ path: PATH, offset: 0, text: TURN_1, drain: started.drain });
    mark(watch, PATH, bytes(TURN_1), started.drain);
    // More bytes of the same drain open the next turn, and a second end mark follows them.
    watch.post({ path: PATH, offset: bytes(TURN_1), text: more, drain: started.drain });
    mark(watch, PATH, bytes(TURN_1 + more), started.drain);
    assert.deepEqual(finalDrain(watch, bytes(TURN_1 + more)), { ...MID_TURN, records: 1 }, more);
  }
});

test("an end-only turn end that names no turn cannot be matched to the transcript, and does not stand", () => {
  // Read after the next turn began, such a notice could not be told from that turn's own notice.
  const unnamed = watchFor();
  assert.deepEqual(finalDrain(unnamed, drainOf(unnamed, notify(null), TURN_1)), { ...MID_TURN, records: 1 });
  // An id too long to be a turn id counts as no name.
  const long = watchFor();
  const id = "t".repeat(201);
  const rows = startRow(id) + contextRow(id) + requestRow("resp_1", id, 1150) + totalRow(1150);
  assert.deepEqual(finalDrain(long, drainOf(long, notify(id), rows)), { ...MID_TURN, records: 1 });
  // A transcript whose start row names no turn cannot be matched either.
  const bare = watchFor();
  const anonymous = startRow() + requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
  assert.deepEqual(finalDrain(bare, drainOf(bare, notify("turn-1"), anonymous)), { ...MID_TURN, records: 1 });
});

test("a transcript with context rows and no start rows still shows a later turn", () => {
  const rows = contextRow("turn-1") + requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
  const same = watchFor();
  assert.deepEqual(finalDrain(same, drainOf(same, notify(), rows), contextRow("turn-1")), { ...COMPLETE, records: 1 });
  const later = watchFor();
  assert.deepEqual(finalDrain(later, drainOf(later, notify(), rows), contextRow("turn-2")), { ...MID_TURN, records: 1 });
});

test("a transcript that starts no turn needs no later byte after an end-only turn end", () => {
  const rows = requestRow("resp_1", "turn-1", 1150) + totalRow(1150);
  const quiet = watchFor();
  assert.deepEqual(finalDrain(quiet, drainOf(quiet, notify(), rows)), { ...COMPLETE, records: 1 });
  const grown = watchFor();
  assert.deepEqual(finalDrain(grown, drainOf(grown, notify(), rows), totalRow(1150)), { ...MID_TURN, records: 1 });
});

test("an end-only turn end whose drain never reached its end does not stand", () => {
  const watch = watchFor();
  const started = watch.hook(notify())!;
  // The relay sent the bytes and was cut before its end mark.
  watch.post({ path: PATH, offset: 0, text: TURN_1, drain: started.drain });
  assert.deepEqual(finalDrain(watch, bytes(TURN_1)), { ...MID_TURN, records: 1 });
});

test("a hook that is not end-only keeps its turn end when a later turn starts", () => {
  // With Codex hooks on, a turn-start hook would have cleared the turn end. The watch does not read the transcript for it.
  const watch = watchFor();
  const hook: WatchHook = { subagent: false, turnEnd: true, turn: "turn-1", transcript: { path: PATH, provider: "codex" } };
  const offset = drainOf(watch, hook, TURN_1);
  assert.deepEqual(finalDrain(watch, offset, startRow("turn-2") + contextRow("turn-2")), { ...COMPLETE, records: 1 });
});

test("a later hook that is not end-only replaces an end-only turn end", () => {
  const watch = watchFor();
  const first = drainOf(watch, notify(), TURN_1);
  const open: WatchHook = { subagent: false, turnEnd: false, transcript: { path: PATH, provider: "codex" } };
  const second = drainOf(watch, open, startRow("turn-2") + contextRow("turn-2"), first);
  assert.deepEqual(finalDrain(watch, second), { ...MID_TURN, records: 1 });
});

test("a transcript replaced after an end-only turn end leaves a gap", () => {
  const watch = watchFor();
  drainOf(watch, notify(), TURN_1);
  const rows = startRow("turn-9") + contextRow("turn-9") + requestRow("resp_9", "turn-9", 1150) + totalRow(1150);
  const started = watch.hook(notify("turn-9", OTHER))!;
  watch.post({ path: OTHER, offset: 0, text: rows, drain: started.drain });
  mark(watch, OTHER, bytes(rows), started.drain);
  const final = watch.drainFinal()!;
  mark(watch, OTHER, bytes(rows), final.drain);
  assert.deepEqual(watch.finish(true, true), { coverage: "partial", reason: "drain-incomplete", records: 2, provider: "codex", finalDrain: "complete" });
});
