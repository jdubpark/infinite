import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTail, parseTranscriptRecord } from "../packages/host/src/transcript.js";
import { findCodexRollout, relay } from "../packages/host/src/hook-relay.js";
import { startHookServer, type HookReply } from "../packages/host/src/hooks.js";
import { nativeItemMessage } from "../packages/host/src/native-codex.js";

const claude = (type: string, uuid: string, content: unknown) => JSON.stringify({ type, uuid, timestamp: "2026-10-16T12:00:00.000Z", message: { role: type, content } });

test("transcript tail joins records split across chunks and never repeats a message", () => {
  const tail = new TranscriptTail("claude");
  const first = claude("user", "u1", "Fix the failing test") + "\n";
  const second = claude("assistant", "a1", [{ type: "text", text: "Looking at it now." }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }]) + "\n";
  const cut = 20;
  assert.deepEqual(tail.ingest(first + second.slice(0, cut)).map(m => [m.role, m.text]), [["user", "Fix the failing test"]]);
  assert.equal(tail.offset, Buffer.byteLength(first) + cut);
  const rest = tail.ingest(second.slice(cut));
  assert.deepEqual(rest.map(m => [m.role, m.text, m.toolName]), [["assistant", "Looking at it now.", undefined], ["tool", "npm test", "Bash"]]);
  assert.equal(tail.offset, Buffer.byteLength(first + second));
  // The same records arriving again (a retried chunk) add nothing.
  const again = new TranscriptTail("claude");
  again.ingest(first); assert.equal(again.ingest(first).length, 0);
  // Injected context never becomes a chat message.
  assert.deepEqual(parseTranscriptRecord(claude("user", "u2", "<system-reminder>internal</system-reminder>"), "claude", 0), []);
  assert.deepEqual(parseTranscriptRecord(JSON.stringify({ type: "assistant", uuid: "s1", isSidechain: true, message: { content: "subagent" } }), "claude", 0), []);
});

test("relay forwards the hook, then streams the transcript from the worker's cursor in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-relay-"));
  const path = join(root, "conversation.jsonl");
  const lines = Array.from({ length: 40 }, (_, i) => claude("user", `u${i}`, `message ${i} ${"é".repeat(5000)}`) + "\n");
  writeFileSync(path, lines.join(""));
  const expected = lines.join("");
  let received = "", cursor = 0;
  const payloads: { route: string; body: Record<string, unknown> }[] = [];
  const server = await startHookServer({
    token: "t",
    onPayload: (route, body): HookReply | void => {
      const b = body as Record<string, unknown>;
      payloads.push({ route, body: b });
      if (route === "claude") return { transcript: { path: String(b.transcript_path), after: cursor } };
      if (route === "transcript") {
        assert.equal(b.path, path);
        if (b.text === undefined) return { after: cursor };
        if (b.offset !== cursor) return { after: cursor };
        received += String(b.text); cursor += Buffer.byteLength(String(b.text));
        return { after: cursor };
      }
    },
    onError: () => assert.fail("hook error"),
  });
  try {
    await relay("claude", JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path }), { url: server.url, token: "t" });
    assert.equal(received, expected, "every byte arrives once, in order, on UTF-8 boundaries");
    assert.ok(payloads.filter(p => p.route === "transcript").length > 1, "the file was larger than one chunk");
    // A second event after no change streams nothing.
    const before = payloads.length;
    await relay("claude", JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path }), { url: server.url, token: "t" });
    // The relay posts no chunk, only the end marker, because the cursor is already at the end.
    assert.deepEqual(payloads.slice(before).map(p => p.route), ["claude", "transcript"]);
    assert.equal(payloads[before + 1]?.body.end, true);
    // A symlink or a non-transcript file is never read.
    const outside = join(root, "secret.txt"); writeFileSync(outside, "private");
    await relay("claude", JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: outside }), { url: server.url, token: "t" });
    assert.ok(!received.includes("private"));
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("codex rollouts are found by thread id under the sessions date tree", () => {
  const home = mkdtempSync(join(tmpdir(), "infinite-codex-home-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "10", "16");
    mkdirSync(day, { recursive: true });
    const thread = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
    writeFileSync(join(day, `rollout-2026-10-16T12-00-00-${thread}.jsonl`), "");
    assert.equal(findCodexRollout(home, thread), join(day, `rollout-2026-10-16T12-00-00-${thread}.jsonl`));
    assert.equal(findCodexRollout(home, "missing-thread-id"), undefined);
    assert.equal(findCodexRollout(home, "../etc"), undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("native codex items become chat messages only when they carry user-facing content", () => {
  assert.deepEqual(nativeItemMessage({ id: "i1", type: "agentMessage", text: "Done with the refactor." }), { id: "i1", role: "assistant", text: "Done with the refactor." });
  assert.deepEqual(nativeItemMessage({ id: "i2", type: "userMessage", content: [{ type: "text", text: "Refactor it" }] }), { id: "i2", role: "user", text: "Refactor it" });
  assert.deepEqual(nativeItemMessage({ id: "i3", type: "commandExecution", command: "npm test" }), { id: "i3", role: "tool", toolName: "shell", text: "npm test" });
  assert.equal(nativeItemMessage({ id: "i4", type: "reasoning", text: "thinking" }), undefined);
  assert.equal(nativeItemMessage({ type: "agentMessage", text: "no id" }), undefined);
});

test("the tail reports each parsed row once", () => {
  const rows: unknown[] = [];
  const tail = new TranscriptTail("claude", 4096, row => rows.push(row));
  const first = claude("user", "u1", "Fix the failing test") + "\n";
  const second = claude("assistant", "a1", [{ type: "text", text: "Looking." }]) + "\n";
  const cut = 20;
  const early = tail.ingest(first + "not json\n" + second.slice(0, cut));
  const late = tail.ingest(second.slice(cut));
  assert.deepEqual(rows.map(row => (row as { uuid: string }).uuid), ["u1", "a1"]);
  assert.deepEqual([...early, ...late].map(message => message.text), ["Fix the failing test", "Looking."]);
  // An observer that throws does not stop chat ingestion.
  const throwing = new TranscriptTail("claude", 4096, () => { throw new Error("observer failed"); });
  assert.deepEqual(throwing.ingest(first).map(message => message.role), ["user"]);
});

test("the tail records a dropped line", () => {
  const tail = new TranscriptTail("claude");
  tail.ingest(claude("user", "u1", "short") + "\n");
  assert.equal(tail.dropped, false);
  tail.ingest("x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(tail.dropped, true);
});

test("the tail reports a pending row and counts discarded lines", () => {
  const tail = new TranscriptTail("claude");
  const row = claude("user", "u1", "hi");
  tail.ingest("not json\n   \n" + row.slice(0, 10));
  assert.equal(tail.discarded, 1, "whitespace-only lines do not count");
  assert.equal(tail.pending, true);
  tail.ingest(row.slice(10) + "\n");
  assert.equal(tail.pending, false);
});

/** A worker that acknowledges transcript bytes. With `advance` false it never moves its cursor. */
function fakeTranscriptWorker(path: string, advance: boolean, start = 0, failAt = -1, beforeReply?: (index: number) => void) {
  const posts: Record<string, unknown>[] = [];
  let cursor = start;
  let chunkIndex = 0;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith("/claude")) return reply({ transcript: { path, after: cursor, drain: 7 } });
    posts.push(body);
    if (body.text === undefined) return reply({});
    const index = chunkIndex++;
    beforeReply?.(index);
    if (index === failAt) return reply({}, 500);
    if (!advance || body.offset !== cursor) return reply({ after: cursor });
    cursor += Buffer.byteLength(String(body.text));
    return reply({ after: cursor });
  }) as typeof fetch;
  return { fetch: fake, posts };
}

test("the relay marks the end of the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-relay-end-"));
  const options = (fetchImpl: typeof fetch) => ({ url: "http://worker.test", token: "t", fetch: fetchImpl });
  const event = (path: string) => JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path });
  try {
    // A file that fits in one chunk: the chunk carries no end flag, and a text-less mark follows it at the file size.
    const small = join(root, "small.jsonl");
    const body = claude("user", "u1", "short") + "\n";
    writeFileSync(small, body);
    const caught = fakeTranscriptWorker(small, true);
    await relay("claude", event(small), options(caught.fetch));
    assert.deepEqual(caught.posts, [
      { path: small, offset: 0, text: body, drain: 7 },
      { path: small, offset: Buffer.byteLength(body), end: true, drain: 7 },
    ]);

    // The cursor is already at the end when the stream starts: a text-less end marker closes the drain.
    const caughtUp = fakeTranscriptWorker(small, true, Buffer.byteLength(body));
    await relay("claude", event(small), options(caughtUp.fetch));
    assert.deepEqual(caughtUp.posts, [{ path: small, offset: Buffer.byteLength(body), end: true, drain: 7 }]);

    // A file of several chunks: no chunk carries the flag, and the mark follows the last acknowledged chunk.
    const several = join(root, "several.jsonl");
    writeFileSync(several, "x".repeat(500 * 1024));
    const streamed = fakeTranscriptWorker(several, true);
    await relay("claude", event(several), options(streamed.fetch));
    assert.equal(streamed.posts.length, 4);
    assert.ok(streamed.posts.slice(0, 3).every(post => post.end === undefined), "no chunk carries the end flag");
    assert.deepEqual(streamed.posts[3], { path: several, offset: 500 * 1024, end: true, drain: 7 });

    // The worker never advances: the chunk is sent once, with no retry and no marker.
    const stalled = fakeTranscriptWorker(small, false);
    await relay("claude", event(small), options(stalled.fetch));
    assert.equal(stalled.posts.length, 1);

    // The file needs more than MAX_CHUNKS (64) chunks: the budget ends the stream with no marker.
    const big = join(root, "big.jsonl");
    writeFileSync(big, Buffer.alloc(13 * 1024 * 1024, "x"));
    const long = fakeTranscriptWorker(big, true);
    await relay("claude", event(big), options(long.fetch));
    assert.equal(long.posts.length, 64);
    assert.equal(long.posts.some(post => post.end === true), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the relay sends bytes that arrive after a chunk before it marks the end", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-relay-grow-"));
  try {
    const path = join(root, "growing.jsonl");
    writeFileSync(path, "x".repeat(1000));
    // The file grows while the first chunk is in flight.
    const worker = fakeTranscriptWorker(path, true, 0, -1, index => { if (index === 0) appendFileSync(path, "y".repeat(10)); });
    await relay("claude", JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path }), { url: "http://worker.test", token: "t", fetch: worker.fetch });
    assert.deepEqual(worker.posts, [
      { path, offset: 0, text: "x".repeat(1000), drain: 7 },
      { path, offset: 1000, text: "y".repeat(10), drain: 7 },
      { path, offset: 1010, end: true, drain: 7 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the relay sends no end mark when a post after a chunk fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-relay-fail-"));
  try {
    const path = join(root, "failing.jsonl");
    writeFileSync(path, "x".repeat(500 * 1024));
    // The second chunk post fails: the relay stops there and marks nothing.
    const worker = fakeTranscriptWorker(path, true, 0, 1);
    await relay("claude", JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path }), { url: "http://worker.test", token: "t", fetch: worker.fetch });
    assert.equal(worker.posts.length, 2);
    assert.equal(worker.posts.some(post => post.end === true), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
