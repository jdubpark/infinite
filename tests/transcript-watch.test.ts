import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptTail, type TranscriptProvider } from "../packages/host/src/transcript.js";
import { TranscriptWatch, closesTurn, type WatchHook } from "../packages/host/src/transcript-watch.js";
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

// ---- Secondary transcripts (subagent files) -------------------------------------------------

const SUB = "agent-a.jsonl";
const bytes = (text: string) => Buffer.byteLength(text);
/** A listing of one secondary file. */
const listing = (name: string, size: number, id = "1:10") => ({ files: [{ name, size, id }], total: 1 });
const EMPTY = { files: [], total: 0 };

test("a Claude hook asks for secondaries and a Codex hook does not", () => {
  const claude = watchFor("claude").hook(turnFor())!;
  assert.deepEqual(claude, { path: PATH, after: 0, drain: 1, secondaries: true });
  const codex = watchFor("codex").hook(turnFor(PATH, "codex"))!;
  assert.equal("secondaries" in codex, false);
});

test("a listed secondary is read and counted", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  const end = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  assert.deepEqual(end?.secondaries, [{ name: SUB, after: 0 }]);
  assert.deepEqual(watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain }), { messages: [], after: bytes(sub) });
  assert.deepEqual(watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain }), { messages: [], after: bytes(sub) });
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 2, provider: "claude" });
  assert.equal("secondary" in usage[0], false);
  assert.equal(usage[1].secondary, true);
});

test("an unchanged secondary needs no stream", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  const again = watch.hook(turnFor())!;
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: again.drain, secondaries: listing(SUB, bytes(sub)) });
  assert.equal(reply?.secondaries, undefined);
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 2, provider: "claude" });
});

test("a secondary that grew and was not read is partial", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  const again = watch.hook(turnFor())!;
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: again.drain, secondaries: listing(SUB, bytes(sub) + 10) });
  assert.deepEqual(reply?.secondaries, [{ name: SUB, after: bytes(sub) }]);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
});

test("a subagent hook with no secondary transcript is partial", () => {
  const withEmpty = watchFor("claude");
  withEmpty.hook({ subagent: true, turnEnd: false });
  const started = withEmpty.hook(turnFor())!;
  const text = claudeRow("msg_1");
  withEmpty.post({ path: PATH, offset: 0, text, drain: started.drain });
  withEmpty.post({ path: PATH, offset: bytes(text), end: true, drain: started.drain, secondaries: EMPTY });
  assert.deepEqual(withEmpty.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });

  const withoutKey = watchFor("claude");
  withoutKey.hook({ subagent: true, turnEnd: false });
  const startedKey = withoutKey.hook(turnFor())!;
  withoutKey.post({ path: PATH, offset: 0, text, drain: startedKey.drain });
  withoutKey.post({ path: PATH, offset: bytes(text), end: true, drain: startedKey.drain });
  assert.deepEqual(withoutKey.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("a subagent hook whose secondary is read is complete", () => {
  const watch = watchFor("claude");
  watch.hook({ subagent: true, turnEnd: false });
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  // The reply asked for the file; the relay sends it, then its end mark.
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 2, provider: "claude" });
});

test("a session without subagents is complete with an empty listing", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(text), end: true, drain: started.drain, secondaries: EMPTY });
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 1, provider: "claude" });
});

test("a cut listing is partial", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: { files: [{ name: SUB, size: bytes(sub), id: "1:10" }], total: 2 } });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
});

test("the watch keeps at most 64 secondary readers", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const names = (prefix: string, size: number) => Array.from({ length: 64 }, (_, i) => ({ name: `agent-${prefix}${i}.jsonl`, size, id: `1:${i + 10}` }));
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: { files: names("a", 0), total: 64 } });
  const again = watch.hook(turnFor())!;
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: again.drain, secondaries: { files: names("b", 5), total: 64 } });
  assert.equal(reply?.secondaries, undefined, "no reader is opened past the limit");
  // A name of the second listing has no reader; a name of the first listing still has its reader.
  assert.equal(watch.post({ path: PATH, secondary: "agent-b0.jsonl", offset: 0, text: sub, drain: again.drain }), undefined);
  assert.deepEqual(watch.post({ path: PATH, secondary: "agent-a0.jsonl", offset: 0, end: true, drain: again.drain }), { messages: [], after: 0 });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("an invalid listing is a cut listing", () => {
  const primary = claudeRow("msg_1");
  const invalid: unknown[] = [
    // Each listing is invalid for one reason only, so each rule is tested by itself.
    { files: [{ name: "../x.jsonl", size: 0, id: "1:10" }], total: 1 },
    { files: [{ name: SUB, size: -1, id: "1:10" }], total: 1 },
    { files: [{ name: SUB, size: 0 }], total: 1 },
    { files: [{ name: SUB, size: 0, id: "abc" }], total: 1 },
    { files: Array.from({ length: 65 }, (_, i) => ({ name: `agent-${i}.jsonl`, size: 0, id: `1:${100 + i}` })), total: 65 },
    { files: [{ name: SUB, size: 0, id: "1:10" }, { name: SUB, size: 0, id: "1:11" }], total: 2 },
    { files: [{ name: SUB, size: 0, id: "1:10" }, { name: "agent-b.jsonl", size: 0, id: "1:11" }], total: 1 },
    "agent-a.jsonl",
  ];
  // The same shape with nothing wrong is accepted, so the fixtures above fail for the reason they name.
  {
    const watch = watchFor("claude");
    const started = watch.hook(turnFor())!;
    watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
    const valid = { files: [{ name: SUB, size: 0, id: "1:10" }, { name: "agent-b.jsonl", size: 0, id: "1:11" }], total: 2 };
    watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: valid });
    assert.deepEqual(watch.finish(true), { coverage: "complete", records: 1, provider: "claude" });
  }
  for (const value of invalid) {
    const watch = watchFor("claude");
    watch.hook({ subagent: true, turnEnd: false });
    const started = watch.hook(turnFor())!;
    watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
    const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: value });
    assert.equal(reply?.secondaries, undefined, JSON.stringify(value));
    assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
  }
});

test("a secondary post for an unknown name or a wrong offset changes nothing", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  assert.equal(watch.post({ path: PATH, secondary: "agent-zz.jsonl", offset: 0, text: sub, drain: started.drain }), undefined);
  assert.deepEqual(watch.post({ path: PATH, secondary: SUB, offset: 5, text: sub, drain: started.drain }), { messages: [], after: 0 });
  assert.equal(usage.length, 1, "only the primary row was journaled");
});

test("a secondary end mark for an older drain is ignored", () => {
  const primary = claudeRow("msg_1"), sub = claudeRow("msg_s1"), more = claudeRow("msg_s2");
  const run = (markDrain: "old" | "current") => {
    const watch = watchFor("claude");
    const first = watch.hook(turnFor())!;
    watch.post({ path: PATH, offset: 0, text: primary, drain: first.drain });
    watch.post({ path: PATH, offset: bytes(primary), end: true, drain: first.drain, secondaries: listing(SUB, bytes(sub)) });
    watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: first.drain });
    watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: first.drain });
    // The file grew. The second drain lists it, reads the new bytes, and receives an end mark.
    const second = watch.hook(turnFor())!;
    const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: second.drain, secondaries: listing(SUB, bytes(sub) + bytes(more)) });
    assert.deepEqual(reply?.secondaries, [{ name: SUB, after: bytes(sub) }]);
    watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), text: more, drain: second.drain });
    watch.post({ path: PATH, secondary: SUB, offset: bytes(sub) + bytes(more), end: true, drain: markDrain === "old" ? first.drain : second.drain });
    return watch.finish(true);
  };
  // The same posts are complete when the mark names the current drain, so the drain check decides.
  assert.deepEqual(run("current"), { coverage: "complete", records: 3, provider: "claude" });
  assert.deepEqual(run("old"), { coverage: "partial", reason: "secondary-missing", records: 3, provider: "claude" });
});

test("a subagent hook never opens or replaces the primary transcript", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const other = { path: "/transcripts/other.jsonl", provider: "claude" as const };
  // Before any primary hook, a subagent hook that names a file opens nothing.
  assert.equal(watch.hook({ subagent: true, turnEnd: false, transcript: other }), undefined);
  const started = watch.hook(turnFor())!;
  assert.equal(started.after, 0);
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: started.drain });
  // A subagent hook that names another file leaves the primary and its cursor alone.
  assert.equal(watch.hook({ subagent: true, turnEnd: false, transcript: other }), undefined);
  // A subagent hook that names the primary drains it from the cursor.
  const drained = watch.hook({ subagent: true, turnEnd: false, transcript: { path: PATH, provider: "claude" } })!;
  assert.deepEqual([drained.path, drained.after], [PATH, bytes(text)]);
  // The primary was read once: one usage record, and nothing was retired and read again.
  assert.equal(usage.length, 1);
  assert.equal(watch.finish(true).records, 1);
});

test("a cut or invalid listing stays partial", () => {
  for (const secondaries of [{ files: [], total: 3 }, "not a listing"]) {
    const watch = watchFor("claude");
    const started = watch.hook(turnFor())!;
    const text = claudeRow("msg_1");
    watch.post({ path: PATH, offset: 0, text, drain: started.drain });
    watch.post({ path: PATH, offset: bytes(text), end: true, drain: started.drain, secondaries });
    assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" }, JSON.stringify(secondaries));
  }
  // A later, valid, empty listing in the same transcript does not clear a cut: the files it named still exist.
  const watch = watchFor("claude");
  const first = watch.hook(turnFor())!;
  const text = claudeRow("msg_1");
  watch.post({ path: PATH, offset: 0, text, drain: first.drain });
  watch.post({ path: PATH, offset: bytes(text), end: true, drain: first.drain, secondaries: "not a listing" });
  const second = watch.hook(turnFor())!;
  watch.post({ path: PATH, offset: bytes(text), end: true, drain: second.drain, secondaries: EMPTY });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("a listing for an older drain is ignored", () => {
  const watch = watchFor("claude");
  const first = watch.hook(turnFor())!;
  const second = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: second.drain });
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: first.drain, secondaries: listing(SUB, bytes(sub)) });
  assert.equal(reply?.secondaries, undefined);
  assert.equal(watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: first.drain }), undefined, "no reader was created");
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "drain-incomplete", records: 1, provider: "claude" });
});

test("an unterminated last row in a secondary is not complete", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1").slice(0, -1);
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("a refused usage row in a secondary makes the session partial", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = refusedClaudeRow();
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "row-dropped", records: 1, provider: "claude" });
});

test("a changed primary path retires its secondaries", () => {
  const a = "/transcripts/a.jsonl";
  const b = "/transcripts/b.jsonl";
  const primaryA = claudeRow("msg_a1");
  const subA = claudeRow("msg_x1");
  const primaryB = claudeRow("msg_b1");

  // Every listed secondary of the first transcript is read to its end.
  const usage: UsageRecord[] = [];
  const read = watchFor("claude", usage);
  const first = read.hook(turnFor(a))!;
  read.post({ path: a, offset: 0, text: primaryA, drain: first.drain });
  read.post({ path: a, offset: bytes(primaryA), end: true, drain: first.drain, secondaries: listing(SUB, bytes(subA)) });
  read.post({ path: a, secondary: SUB, offset: 0, text: subA, drain: first.drain });
  read.post({ path: a, secondary: SUB, offset: bytes(subA), end: true, drain: first.drain });
  const second = read.hook(turnFor(b))!;
  read.post({ path: b, offset: 0, text: primaryB, drain: second.drain });
  read.post({ path: b, offset: bytes(primaryB), end: true, drain: second.drain, secondaries: EMPTY });
  assert.deepEqual(read.finish(true), { coverage: "complete", records: 3, provider: "claude" });
  assert.equal(usage.length, 3);

  // The first transcript lists a secondary and never reads it.
  const unread = watchFor("claude");
  const gapFirst = unread.hook(turnFor(a))!;
  unread.post({ path: a, offset: 0, text: primaryA, drain: gapFirst.drain });
  unread.post({ path: a, offset: bytes(primaryA), end: true, drain: gapFirst.drain, secondaries: listing(SUB, bytes(subA)) });
  const gapSecond = unread.hook(turnFor(b))!;
  unread.post({ path: b, offset: 0, text: primaryB, drain: gapSecond.drain });
  unread.post({ path: b, offset: bytes(primaryB), end: true, drain: gapSecond.drain, secondaries: EMPTY });
  assert.deepEqual(unread.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
});

test("a secondary end mark below the listed size is not complete", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  // The file was truncated between the listing and the open: its end mark arrives at offset 0.
  assert.deepEqual(watch.post({ path: PATH, secondary: SUB, offset: 0, end: true, drain: started.drain }), { messages: [], after: 0 });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("a repeated listing with a larger size withdraws the evidence", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  // The first listing gives the file size 0, so the watch takes the evidence from it.
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, 0) });
  // A second listing in the same drain gives the file its real size: the bytes are wanted, and the evidence goes.
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  assert.deepEqual(reply?.secondaries, [{ name: SUB, after: 0 }]);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 1, provider: "claude" });
});

test("a file that shrank is not complete", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub)) });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  const again = watch.hook(turnFor())!;
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: again.drain, secondaries: listing(SUB, bytes(sub) - 5) });
  assert.equal(reply?.secondaries, undefined);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
});

test("a file truncated below the bytes already read cuts the transcript", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const primary = claudeRow("msg_1"), first = claudeRow("msg_s1"), grown = claudeRow("msg_s2");
  const one = bytes(first), two = one + bytes(grown);
  const started = watch.hook(turnFor())!;
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  // The listing gives the first size. The file grows while the relay reads it, so the reader passes that size.
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, one) });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: first, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: one, text: grown, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: two, end: true, drain: started.drain });
  assert.equal(usage.length, 3);
  // The same file is cut back to the size that was listed. That is below the bytes already read.
  const cutBack = watch.hook(turnFor())!;
  const shorter = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: cutBack.drain, secondaries: listing(SUB, one) });
  assert.equal(shorter?.secondaries, undefined);
  // It grows again to the old length with other rows. The old cursor must not pass for the new bytes.
  const regrown = watch.hook(turnFor())!;
  const again = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: regrown.drain, secondaries: listing(SUB, two) });
  assert.equal(again?.secondaries, undefined);
  assert.equal(watch.post({ path: PATH, secondary: SUB, offset: two, end: true, drain: regrown.drain }), undefined, "a broken reader takes no post");
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 3, provider: "claude" });
});

test("interleaved relay runs read a secondary once", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const older = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: older.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: older.drain, secondaries: listing(SUB, bytes(sub)) });
  const newer = watch.hook(turnFor())!;
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: newer.drain, secondaries: listing(SUB, bytes(sub)) });
  // The older run's chunk is applied; the newer run's chunk at the same offset is not, and names the reader's offset.
  assert.deepEqual(watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: older.drain }), { messages: [], after: bytes(sub) });
  assert.deepEqual(watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: newer.drain }), { messages: [], after: bytes(sub) });
  // The older run's end mark gives no evidence; the newer run's end mark does.
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: older.drain });
  assert.equal(watch.finish(true).coverage, "partial");
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: newer.drain });
  assert.deepEqual(watch.finish(true), { coverage: "complete", records: 2, provider: "claude" });
  assert.equal(usage.filter(record => record.secondary === true).length, 1);
});

test("a turn end with background tasks is not a turn boundary", () => {
  assert.equal(closesTurn([{ kind: "turn-end", backgroundTasks: 0 }], "Stop"), true);
  assert.equal(closesTurn([{ kind: "turn-end" }], "Stop"), true);
  assert.equal(closesTurn([], "SessionEnd"), true);
  assert.equal(closesTurn([{ kind: "turn-end", backgroundTasks: 2 }], "Stop"), false);
  assert.equal(closesTurn([{ kind: "turn-end", backgroundTasks: 0, failed: true }], "Stop"), false);
  assert.equal(closesTurn([{ kind: "error" }, { kind: "idle" }], "Notification"), false);
});

test("a replaced secondary file cuts the transcript", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub), "1:10") });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  assert.equal(watch.finish(true).coverage, "complete");
  // The file is removed and recreated under the same name, with the same length and another identity.
  const again = watch.hook(turnFor())!;
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: again.drain, secondaries: listing(SUB, bytes(sub), "1:99") });
  assert.equal(reply?.secondaries, undefined);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
  // The first identity coming back does not clear the cut.
  const later = watch.hook(turnFor())!;
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: later.drain, secondaries: listing(SUB, bytes(sub), "1:10") });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
});

test("a shortened secondary file cuts the transcript", () => {
  const watch = watchFor("claude");
  const started = watch.hook(turnFor())!;
  const primary = claudeRow("msg_1");
  const sub = claudeRow("msg_s1");
  watch.post({ path: PATH, offset: 0, text: primary, drain: started.drain });
  watch.post({ path: PATH, offset: bytes(primary), end: true, drain: started.drain, secondaries: listing(SUB, bytes(sub), "1:10") });
  watch.post({ path: PATH, secondary: SUB, offset: 0, text: sub, drain: started.drain });
  watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), end: true, drain: started.drain });
  const shorter = watch.hook(turnFor())!;
  assert.equal(watch.post({ path: PATH, offset: bytes(primary), end: true, drain: shorter.drain, secondaries: listing(SUB, bytes(sub) - 5, "1:10") })?.secondaries, undefined);
  // A later drain lists the file larger again. Its bytes belong to a file that was shortened, so they are not read.
  const larger = watch.hook(turnFor())!;
  const reply = watch.post({ path: PATH, offset: bytes(primary), end: true, drain: larger.drain, secondaries: listing(SUB, bytes(sub) + 10, "1:10") });
  assert.equal(reply?.secondaries, undefined);
  assert.equal(watch.post({ path: PATH, secondary: SUB, offset: bytes(sub), text: "x".repeat(10), drain: larger.drain }), undefined);
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 2, provider: "claude" });
});

test("a replaced transcript keeps its missing subagent", () => {
  const usage: UsageRecord[] = [];
  const watch = watchFor("claude", usage);
  const a = "/transcripts/a.jsonl";
  const b = "/transcripts/b.jsonl";
  // Transcript A is open, gets a subagent hook that drains it, then a complete turn end that lists nothing.
  const startA = watch.hook(turnFor(a))!;
  const primaryA = claudeRow("msg_a1");
  watch.post({ path: a, offset: 0, text: primaryA, drain: startA.drain });
  const subagent = watch.hook({ subagent: true, turnEnd: false, transcript: { path: a, provider: "claude" } });
  assert.equal(subagent?.path, a);
  const turnA = watch.hook(turnFor(a))!;
  watch.post({ path: a, offset: bytes(primaryA), end: true, drain: turnA.drain, secondaries: EMPTY });
  // Transcript B lists one file, reads it to its end, and ends its turn. The subagent belonged to A.
  const startB = watch.hook(turnFor(b))!;
  const primaryB = claudeRow("msg_b1");
  const subB = claudeRow("msg_s1");
  watch.post({ path: b, offset: 0, text: primaryB, drain: startB.drain });
  watch.post({ path: b, offset: bytes(primaryB), end: true, drain: startB.drain, secondaries: listing(SUB, bytes(subB)) });
  watch.post({ path: b, secondary: SUB, offset: 0, text: subB, drain: startB.drain });
  watch.post({ path: b, secondary: SUB, offset: bytes(subB), end: true, drain: startB.drain });
  assert.deepEqual(watch.finish(true), { coverage: "partial", reason: "secondary-missing", records: 3, provider: "claude" });
});

test("a transcript replaced mid-turn is not complete", () => {
  const a = "/transcripts/a.jsonl";
  const b = "/transcripts/b.jsonl";
  const run = (turnEnd: boolean) => {
    const watch = watchFor("claude");
    const startA = watch.hook(turnFor(a, "claude", turnEnd))!;
    const primaryA = claudeRow("msg_a1");
    watch.post({ path: a, offset: 0, text: primaryA, drain: startA.drain });
    watch.post({ path: a, offset: bytes(primaryA), end: true, drain: startA.drain, secondaries: EMPTY });
    const startB = watch.hook(turnFor(b))!;
    const primaryB = claudeRow("msg_b1");
    watch.post({ path: b, offset: 0, text: primaryB, drain: startB.drain });
    watch.post({ path: b, offset: bytes(primaryB), end: true, drain: startB.drain, secondaries: EMPTY });
    return watch.finish(true);
  };
  // A's last hook was not a turn boundary: the session stopped mid-turn, even though B ends its turn.
  assert.deepEqual(run(false), { coverage: "partial", reason: "stopped-mid-turn", records: 2, provider: "claude" });
  // Positive control: when A's last hook closes its turn, the same sequence is complete.
  assert.deepEqual(run(true), { coverage: "complete", records: 2, provider: "claude" });
});
