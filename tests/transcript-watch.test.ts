import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptTail, type TranscriptProvider } from "../packages/host/src/transcript.js";
import { TranscriptWatch, type WatchHook } from "../packages/host/src/transcript-watch.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

const PATH = "/transcripts/session.jsonl";
const STAMP = "2026-01-01T00:00:00.000Z";

const line = (value: unknown) => JSON.stringify(value) + "\n";

/** A Claude assistant row with a message id, a text reply, and a fixed output count. */
const claudeRow = (id: string, output = 40) => line({
  type: "assistant", uuid: `uuid-${id}`, timestamp: STAMP, sessionId: "session-fixture-a",
  message: { id, model: "model-fixture-a", role: "assistant", content: "answer",
    usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

/** A Claude assistant row whose output count is a string, so the parser refuses it. */
const refusedClaudeRow = () => line({
  type: "assistant", uuid: "uuid-refused", timestamp: STAMP,
  message: { id: "msg_refused", model: "model-fixture-a", role: "assistant", content: "answer",
    usage: { input_tokens: 100, output_tokens: "7", cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

/** Codex usage whose input plus output equals the total. */
const codexUsage = (total: number) => ({
  input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: total - 1000, reasoning_output_tokens: 0, total_tokens: total,
});
/** Codex usage for a small response, with cached and reasoning tokens. */
const smallUsage = { input_tokens: 60, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 100 };
const requestRow = (response: string, total: number) => line({
  timestamp: STAMP, type: "token_usage_record",
  payload: { response_id: response, thread_id: "thread_watch_01", turn_id: "turn_watch_01", usage: codexUsage(total), thread_token_usage: codexUsage(total) },
});
const requestSmall = (response: string) => line({
  timestamp: STAMP, type: "token_usage_record",
  payload: { response_id: response, thread_id: "thread_watch_01", turn_id: "turn_watch_01", usage: smallUsage, thread_token_usage: smallUsage },
});
const totalRow = (total: number) => line({
  timestamp: STAMP, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: codexUsage(total) } },
});
const totalUsageRow = (usage: Record<string, number>) => line({
  timestamp: STAMP, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } },
});
const sessionMetaRow = line({ timestamp: STAMP, type: "session_meta", payload: { id: "thread_watch_01" } });

const watchFor = (provider: string, usage: UsageRecord[] = []) => new TranscriptWatch({ provider, onUsage: record => usage.push(record) });
const turnFor = (path = PATH, provider: TranscriptProvider = "claude", turnEnd = true): WatchHook => ({
  subagent: false, turnEnd, transcript: { path, provider },
});
/** The text-less end mark at a cursor, which the relay sends after the last chunk. */
const mark = (watch: TranscriptWatch, path: string, offset: number, drain: number) => watch.post({ path, offset, end: true, drain });

test("a turn-end drain that reaches the end of the file is complete", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  const reply = watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  assert.equal(reply?.messages.length, 1);
  assert.equal(reply?.after, Buffer.byteLength(text));
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 1, provider: "claude" });
  assert.equal(usage.length, 1);
});

test("bytes after the end mark reopen the drain", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const first = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text: first, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(first), started.drain);
  watch.post({ path: PATH, offset: Buffer.byteLength(first), text: claudeRow("msg_2"), drain: started.drain });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 2, provider: "claude" });
});

test("an end mark for an older drain is ignored", () => {
  const text = claudeRow("msg_1");
  const older = watchFor("claude");
  const first = older.hook(turnFor())!;
  const second = older.hook(turnFor())!;
  older.post({ path: PATH, offset: 0, text, drain: second.drain });
  mark(older, PATH, Buffer.byteLength(text), first.drain);
  assert.deepEqual(older.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "claude" });

  const current = watchFor("claude");
  current.hook(turnFor());
  const latest = current.hook(turnFor())!;
  current.post({ path: PATH, offset: 0, text, drain: latest.drain });
  mark(current, PATH, Buffer.byteLength(text), latest.drain);
  assert.deepEqual(current.finish(true), { coverage: "complete", records: 1, provider: "claude" });
});

test("a later hook without a transcript ends the turn boundary", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  watch.hook({ subagent: false, turnEnd: false });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "claude" });
});

test("a later turn end needs its own evidence", () => {
  const watch = watchFor("claude");
  const first = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: first.drain });
  mark(watch, PATH, Buffer.byteLength(text), first.drain);
  const second = watch.hook(turnFor())!;
  assert.equal(watch.finish(true).coverage, "partial");
  mark(watch, PATH, Buffer.byteLength(text), second.drain);
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 1, provider: "claude" });
});

test("an unterminated last row is not complete", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const first = claudeRow("msg_1");
  const partial = claudeRow("msg_2").slice(0, -1);
  watch.post({ path: PATH, offset: 0, text: first, drain: started.drain });
  watch.post({ path: PATH, offset: Buffer.byteLength(first), text: partial, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(first) + Buffer.byteLength(partial), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "claude" });
});

test("a line that is not JSON makes the session partial", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = "not json\n" + claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "claude" });
});

test("a subagent hook makes the session partial", () => {
  const watch = watchFor("claude");
  watch.hook({ subagent: true, turnEnd: false });
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("a chunk never creates end evidence", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, end: true, drain: started.drain });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "claude" });
});

test("a refused usage row makes the session partial", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1") + refusedClaudeRow();
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "claude" });
});

test("a repeated response is counted once", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("codex", usage);
  const started = watch.hook(turnFor(PATH, "codex"))!;
  const cumulative200 = {
    input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0,
    output_tokens: 80, reasoning_output_tokens: 10, total_tokens: 200,
  };
  const text = requestSmall("resp_a") + requestSmall("resp_a") + totalUsageRow(cumulative200);
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "codex" });
  assert.equal(usage.length, 1, "one usage record is journaled for the repeated response");
});

test("a cumulative transcript without a thread id is a gap", () => {
  const watch = watchFor("codex");
  const startA = watch.hook(turnFor("/transcripts/a.jsonl", "codex"))!;
  const cumulative = totalRow(1150);
  watch.post({ path: "/transcripts/a.jsonl", offset: 0, text: cumulative, drain: startA.drain });
  mark(watch, "/transcripts/a.jsonl", Buffer.byteLength(cumulative), startA.drain);
  const startB = watch.hook(turnFor("/transcripts/b.jsonl", "codex"))!;
  const text = requestRow("resp_b", 1150) + totalRow(1150);
  watch.post({ path: "/transcripts/b.jsonl", offset: 0, text, drain: startB.drain });
  mark(watch, "/transcripts/b.jsonl", Buffer.byteLength(text), startB.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "codex" });
});

test("a failed usage write is never complete", () => {
  let calls = 0;
  const watch = new TranscriptWatch({ provider: "claude", onUsage: () => { calls += 1; if (calls === 1) throw new Error("journal write failed"); } });
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  const reply = watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  assert.equal(reply?.messages.length, 1, "chat still receives the message");
  mark(watch, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "claude" });
});

test("a post for another path or offset changes nothing", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  assert.equal(watch.post({ path: "/transcripts/other.jsonl", offset: 0, text, drain: started.drain }), undefined);
  assert.deepEqual(watch.post({ path: PATH, offset: 5, text, drain: started.drain }), { messages: [], after: 0 });
  // The chunk was not applied, so no row was read and the transcript counts as absent.
  assert.deepEqual(watch.finish(true), { coverage: "none", reason: "no-transcript", records: 0, provider: "claude" });

  // An end mark at another offset than the cursor creates no evidence.
  const marked = watchFor("claude");
  const startMarked = marked.hook(turnFor())!;
  marked.post({ path: PATH, offset: 0, text, drain: startMarked.drain });
  assert.deepEqual(marked.post({ path: PATH, offset: 5, end: true, drain: startMarked.drain }), { messages: [], after: Buffer.byteLength(text) });
  assert.deepEqual(marked.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "claude" });
});

test("a session without a transcript reports why", () => {
  assert.deepEqual(watchFor("claude").finish(false), { coverage: "none", reason: "hooks-off", records: 0, provider: "claude" });
  assert.deepEqual(watchFor("claude").finish(true), { coverage: "none", reason: "no-transcript", records: 0, provider: "claude" });
  assert.deepEqual(watchFor("grok").finish(true), { coverage: "none", reason: "unsupported", records: 0, provider: "grok" });
});

test("chat messages are unchanged", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1") + claudeRow("msg_2");
  const reply = watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  assert.deepEqual(reply?.messages, new TranscriptTail("claude").ingest(text));
  assert.equal(reply?.after, Buffer.byteLength(text));
});

test("a changed path retires the old transcript", () => {
  const a = "/transcripts/a.jsonl";
  const b = "/transcripts/b.jsonl";

  // Both transcripts complete: both usage records count.
  const complete: UsageRecord[] = [];
  const both = watchFor("claude", complete);
  const startA = both.hook(turnFor(a))!;
  both.post({ path: a, offset: 0, text: claudeRow("msg_a"), drain: startA.drain });
  mark(both, a, Buffer.byteLength(claudeRow("msg_a")), startA.drain);
  const startB = both.hook(turnFor(b))!;
  both.post({ path: b, offset: 0, text: claudeRow("msg_b"), drain: startB.drain });
  mark(both, b, Buffer.byteLength(claudeRow("msg_b")), startB.drain);
  assert.deepEqual(both.finish(true), { coverage: "complete", records: 2, provider: "claude" });

  // The old transcript never completed: the session is partial.
  const incomplete = watchFor("claude");
  incomplete.hook(turnFor(a));
  incomplete.post({ path: a, offset: 0, text: claudeRow("msg_a") });
  const startNew = incomplete.hook(turnFor(b))!;
  incomplete.post({ path: b, offset: 0, text: claudeRow("msg_b"), drain: startNew.drain });
  mark(incomplete, b, Buffer.byteLength(claudeRow("msg_b")), startNew.drain);
  assert.deepEqual(incomplete.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 2, provider: "claude" });

  // The old Codex transcript has request rows that never reconcile: the session is partial.
  const codex = watchFor("codex");
  codex.hook(turnFor(a, "codex"));
  codex.post({ path: a, offset: 0, text: requestRow("resp_a", 1150) });
  const startCodex = codex.hook(turnFor(b, "codex"))!;
  const codexText = requestRow("resp_b", 1150) + totalRow(1150);
  codex.post({ path: b, offset: 0, text: codexText, drain: startCodex.drain });
  mark(codex, b, Buffer.byteLength(codexText), startCodex.drain);
  assert.deepEqual(codex.finish(true), { coverage: "partial", reason: "row-dropped", records: 2, provider: "codex" });

  // A retired Codex transcript with only cumulative rows journals its snapshot when it is retired.
  const snapshot: UsageRecord[] = [];
  const retiring = watchFor("codex", snapshot);
  retiring.hook(turnFor(a, "codex"));
  retiring.post({ path: a, offset: 0, text: sessionMetaRow + totalRow(1150) });
  retiring.hook(turnFor(b, "codex"));
  assert.deepEqual(snapshot.map(record => record.messageId), ["cumulative:thread_watch_01"]);
});

test("a Codex session reconciles request totals", () => {
  const matching = watchFor("codex");
  const started = matching.hook(turnFor(PATH, "codex"))!;
  const text = requestRow("resp_1", 1150) + totalRow(1150);
  matching.post({ path: PATH, offset: 0, text, drain: started.drain });
  mark(matching, PATH, Buffer.byteLength(text), started.drain);
  assert.deepEqual(matching.finish(true), { coverage: "complete", records: 1, provider: "codex" });

  const missingTotal = watchFor("codex");
  const startedMissing = missingTotal.hook(turnFor(PATH, "codex"))!;
  const missingText = requestRow("resp_1", 1150);
  missingTotal.post({ path: PATH, offset: 0, text: missingText, drain: startedMissing.drain });
  mark(missingTotal, PATH, Buffer.byteLength(missingText), startedMissing.drain);
  assert.deepEqual(missingTotal.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "codex" });

  const mismatched = watchFor("codex");
  const startedMismatch = mismatched.hook(turnFor(PATH, "codex"))!;
  const mismatchText = requestRow("resp_1", 1150) + totalRow(1730);
  mismatched.post({ path: PATH, offset: 0, text: mismatchText, drain: startedMismatch.drain });
  mark(mismatched, PATH, Buffer.byteLength(mismatchText), startedMismatch.drain);
  assert.deepEqual(mismatched.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "codex" });
});
