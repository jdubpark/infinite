import test from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TranscriptTail, parseTranscriptRecord } from "../packages/host/src/transcript.js";
import { drain, findCodexRollout, relay } from "../packages/host/src/hook-relay.js";
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

/**
 * A worker for the secondary tests. It asks for secondaries unless `ask` is false, answers the primary
 * end mark with `wanted`, and moves a secondary's cursor only when `advance` allows that name.
 */
function fakeSecondaryWorker(path: string, options: { ask?: boolean; wanted?: unknown[]; advance?: (name: string) => boolean; onEnd?: () => void; onSecondaryPost?: (name: string) => void; drain?: unknown } = {}) {
  const posts: Record<string, unknown>[] = [];
  const requests: { url: string; body: string }[] = [];
  const cursors = new Map<string, number>();
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = String(init?.body);
    requests.push({ url, body: raw });
    const body = JSON.parse(raw) as Record<string, unknown>;
    // The drain route answers with its window, or 204 when nothing is owed.
    if (url.endsWith("/drain")) return options.drain === undefined ? new Response(null, { status: 204 }) : reply(options.drain);
    if (!url.endsWith("/transcript")) return reply({ transcript: { path, after: 0, drain: 7, ...(options.ask === false ? {} : { secondaries: true }) } });
    posts.push(body);
    if (typeof body.secondary !== "string") {
      if (body.end === true) {
        options.onEnd?.();
        // The wanted list names where each file starts, so its cursor starts there too.
        for (const item of options.wanted ?? []) {
          const want = item as { name: string; after: number };
          cursors.set(want.name, want.after);
        }
        return reply({ after: body.offset, secondaries: options.wanted });
      }
      return reply({ after: Number(body.offset) + Buffer.byteLength(String(body.text)) });
    }
    const name = body.secondary;
    if (body.end === true || typeof body.text !== "string") return reply({});
    options.onSecondaryPost?.(name);
    const current = cursors.get(name) ?? 0;
    if (body.offset !== current || !(options.advance?.(name) ?? true)) return reply({ after: current });
    const after = current + Buffer.byteLength(body.text);
    cursors.set(name, after);
    return reply({ after });
  }) as typeof fetch;
  return { fetch: fake, posts, requests };
}

/** A primary transcript and the subagent folder Claude Code writes beside it. */
function secondaryFixture(root: string) {
  const path = join(root, "s.jsonl");
  const folder = join(root, "s", "subagents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(path, claude("user", "u1", "short") + "\n");
  writeFileSync(join(folder, "agent-a.jsonl"), "a".repeat(20));
  writeFileSync(join(folder, "agent-a.meta.json"), "{}");
  writeFileSync(join(folder, "agent-b.jsonl"), "0123456789");
  writeFileSync(join(folder, "notes.jsonl"), "{}");
  mkdirSync(join(folder, "agent-dir.jsonl"));
  symlinkSync(join(folder, "agent-a.jsonl"), join(folder, "agent-link.jsonl"));
  return { path, folder };
}

const secondaryEvent = JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: "unused" });

/** A file's identity as the relay reports it: `<device>:<inode>`, exact for large inode numbers. */
const idOf = (file: string) => {
  const info = lstatSync(file, { bigint: true });
  return `${info.dev}:${info.ino}`;
};

test("the relay lists secondary transcripts on the end mark when asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-list-"));
  try {
    const { path, folder } = secondaryFixture(root);
    const asked = fakeSecondaryWorker(path);
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: asked.fetch });
    const size = Buffer.byteLength(claude("user", "u1", "short") + "\n");
    assert.deepEqual(asked.posts.at(-1), {
      path, offset: size, end: true, drain: 7,
      secondaries: {
        files: [
          { name: "agent-a.jsonl", size: 20, id: idOf(join(folder, "agent-a.jsonl")) },
          { name: "agent-b.jsonl", size: 10, id: idOf(join(folder, "agent-b.jsonl")) },
        ],
        total: 2,
      },
    });
    assert.notEqual(idOf(join(folder, "agent-a.jsonl")), idOf(join(folder, "agent-b.jsonl")), "two files have different ids");

    const quiet = fakeSecondaryWorker(path, { ask: false });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: quiet.fetch });
    assert.equal("secondaries" in (quiet.posts.at(-1) ?? {}), false, "no listing when the reply does not ask");

    const lonely = join(root, "lonely.jsonl");
    writeFileSync(lonely, claude("user", "u2", "short") + "\n");
    const missing = fakeSecondaryWorker(lonely);
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: missing.fetch });
    assert.deepEqual(missing.posts.at(-1)?.secondaries, { files: [], total: 0 }, "a missing folder lists nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the relay streams the secondary transcripts the worker asks for", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-stream-"));
  try {
    const { path } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path, { wanted: [{ name: "agent-a.jsonl", after: 0 }, { name: "agent-b.jsonl", after: 4 }] });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: worker.fetch });
    const streamed = worker.posts.filter(post => post.secondary !== undefined);
    assert.deepEqual(streamed, [
      { path, secondary: "agent-a.jsonl", offset: 0, text: "a".repeat(20), drain: 7 },
      { path, secondary: "agent-a.jsonl", offset: 20, end: true, drain: 7 },
      { path, secondary: "agent-b.jsonl", offset: 4, text: "456789", drain: 7 },
      { path, secondary: "agent-b.jsonl", offset: 10, end: true, drain: 7 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the relay opens only the names it listed", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-names-"));
  const realOpen = fs.openSync;
  try {
    const { path } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path, { wanted: [
      { name: "notes.jsonl", after: 0 },
      { name: "../s.jsonl", after: 0 },
      { name: "agent-missing.jsonl", after: 0 },
      { name: "agent-link.jsonl", after: 0 },
      { name: "agent-a.jsonl", after: -1 },
      { name: "agent-b.jsonl", after: 0 },
      // A repeated name is streamed once.
      { name: "agent-b.jsonl", after: 0 },
    ] });
    const opened: string[] = [];
    fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(file));
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: worker.fetch });
    } finally {
      fs.openSync = realOpen;
      syncBuiltinESMExports();
    }
    const streamed = worker.posts.filter(post => post.secondary !== undefined);
    assert.deepEqual([...new Set(streamed.map(post => post.secondary))], ["agent-b.jsonl"]);
    assert.equal(streamed.filter(post => post.text !== undefined).length, 1, "streamed once");
    assert.deepEqual(opened.filter(file => file.includes("subagents")).map(file => basename(file)), ["agent-b.jsonl"]);
  } finally { fs.openSync = realOpen; rmSync(root, { recursive: true, force: true }); }
});

test("a symbolic link in the secondary folder path is not listed", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-link-"));
  try {
    // The subagents folder is a link to a folder that holds a subagent transcript.
    const linked = join(root, "s.jsonl");
    writeFileSync(linked, claude("user", "u1", "short") + "\n");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "agent-x.jsonl"), "xxxx");
    mkdirSync(join(root, "s"));
    symlinkSync(elsewhere, join(root, "s", "subagents"));
    const first = fakeSecondaryWorker(linked);
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: first.fetch });
    assert.deepEqual(first.posts.at(-1)?.secondaries, { files: [], total: 0 });

    // The session folder is a link to a folder whose subagents folder holds a subagent transcript.
    const other = join(root, "other");
    mkdirSync(join(other, "subagents"), { recursive: true });
    writeFileSync(join(other, "subagents", "agent-x.jsonl"), "xxxx");
    const throughLink = join(root, "t.jsonl");
    writeFileSync(throughLink, claude("user", "u2", "short") + "\n");
    symlinkSync(other, join(root, "t"));
    const second = fakeSecondaryWorker(throughLink);
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: second.fetch });
    assert.deepEqual(second.posts.at(-1)?.secondaries, { files: [], total: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file replaced after the listing is not streamed", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-replace-"));
  try {
    const { path, folder } = secondaryFixture(root);
    const wanted = [{ name: "agent-a.jsonl", after: 0 }];
    // Control: the same reply streams the listed file when nothing replaces it.
    const control = fakeSecondaryWorker(path, { wanted });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: control.fetch });
    assert.ok(control.posts.some(post => post.secondary === "agent-a.jsonl" && post.text !== undefined));

    // The file is replaced with a new one of the same name while the end mark is answered. The old file stays
    // under another name, so the new file cannot reuse its identity.
    const replaced = fakeSecondaryWorker(path, {
      wanted,
      onEnd: () => {
        renameSync(join(folder, "agent-a.jsonl"), join(folder, "agent-a.old"));
        writeFileSync(join(folder, "agent-a.jsonl"), "y".repeat(20));
      },
    });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: replaced.fetch });
    assert.equal(replaced.posts.some(post => post.secondary === "agent-a.jsonl"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a secondary that grows while it is read ends at the new size", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-grow-"));
  try {
    const { path, folder } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path, {
      wanted: [{ name: "agent-a.jsonl", after: 0 }],
      onSecondaryPost: name => { if (name === "agent-a.jsonl" && worker.posts.filter(post => post.secondary === name).length === 1) appendFileSync(join(folder, name), "b".repeat(10)); },
    });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: worker.fetch });
    assert.deepEqual(worker.posts.filter(post => post.secondary !== undefined), [
      { path, secondary: "agent-a.jsonl", offset: 0, text: "a".repeat(20), drain: 7 },
      { path, secondary: "agent-a.jsonl", offset: 20, text: "b".repeat(10), drain: 7 },
      { path, secondary: "agent-a.jsonl", offset: 30, end: true, drain: 7 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a route other than claude never lists", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-codex-"));
  try {
    const { path } = secondaryFixture(root);
    // The same transcript listed under claude is the positive control.
    const claudeWorker = fakeSecondaryWorker(path);
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: claudeWorker.fetch });
    assert.ok("secondaries" in (claudeWorker.posts.at(-1) ?? {}));
    const worker = fakeSecondaryWorker(path);
    await relay("codex", JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: path }), { url: "http://worker.test", token: "t", fetch: worker.fetch });
    assert.equal("secondaries" in (worker.posts.at(-1) ?? {}), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("more than 64 secondary files are listed as a cut", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-cut-"));
  try {
    const { path, folder } = secondaryFixture(root);
    for (let i = 0; i < 70; i++) writeFileSync(join(folder, `agent-${String(i).padStart(3, "0")}.jsonl`), "");
    const worker = fakeSecondaryWorker(path);
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: worker.fetch });
    const listing = worker.posts.at(-1)?.secondaries as { files: { name: string }[]; total: number };
    assert.equal(listing.total, 72, "70 generated files plus agent-a and agent-b");
    assert.equal(listing.files.length, 64);
    assert.deepEqual(listing.files.slice(0, 2).map(file => file.name), ["agent-000.jsonl", "agent-001.jsonl"]);
    const sorted = [...Array.from({ length: 70 }, (_, i) => `agent-${String(i).padStart(3, "0")}.jsonl`), "agent-a.jsonl", "agent-b.jsonl"].sort();
    assert.deepEqual(listing.files.map(file => file.name), sorted.slice(0, 64));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the secondary budget is shared and stops the stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-budget-"));
  try {
    const { path, folder } = secondaryFixture(root);
    rmSync(join(folder, "agent-a.jsonl"));
    writeFileSync(join(folder, "agent-a.jsonl"), Buffer.alloc(25 * 1024 * 1024, "x"));
    const worker = fakeSecondaryWorker(path, { wanted: [{ name: "agent-a.jsonl", after: 0 }, { name: "agent-b.jsonl", after: 0 }] });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: worker.fetch });
    const streamed = worker.posts.filter(post => post.secondary !== undefined);
    assert.equal(streamed.length, 128);
    assert.equal(streamed.some(post => post.end === true), false);
    assert.equal(streamed.some(post => post.secondary === "agent-b.jsonl"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a secondary that stops early does not stop the next one", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-secondary-early-"));
  try {
    const { path } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path, {
      wanted: [{ name: "agent-a.jsonl", after: 0 }, { name: "agent-b.jsonl", after: 0 }],
      advance: name => name === "agent-b.jsonl",
    });
    await relay("claude", secondaryEvent, { url: "http://worker.test", token: "t", fetch: worker.fetch });
    const streamed = worker.posts.filter(post => post.secondary !== undefined);
    assert.deepEqual(streamed, [
      { path, secondary: "agent-a.jsonl", offset: 0, text: "a".repeat(20), drain: 7 },
      { path, secondary: "agent-b.jsonl", offset: 0, text: "0123456789", drain: 7 },
      { path, secondary: "agent-b.jsonl", offset: 10, end: true, drain: 7 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the drain relay asks the worker what to read and streams it like a hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-drain-relay-"));
  try {
    const { path } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path, {
      drain: { transcript: { path, after: 0, drain: 9, secondaries: true } },
      wanted: [{ name: "agent-a.jsonl", after: 0 }, { name: "agent-b.jsonl", after: 4 }],
    });
    await drain({ url: "http://worker.test", token: "t", fetch: worker.fetch });
    assert.deepEqual(worker.requests[0], { url: "http://worker.test/drain", body: "{}" });
    const sent = worker.posts.map(post => [post.secondary ?? "primary", post.offset, post.end === true ? "end" : "chunk", post.drain]);
    assert.deepEqual(sent, [
      ["primary", 0, "chunk", 9],
      ["primary", Buffer.byteLength(claude("user", "u1", "short") + "\n"), "end", 9],
      ["agent-a.jsonl", 0, "chunk", 9],
      ["agent-a.jsonl", 20, "end", 9],
      ["agent-b.jsonl", 4, "chunk", 9],
      ["agent-b.jsonl", 10, "end", 9],
    ]);
    assert.ok(worker.posts[1].secondaries, "the primary end mark carries the listing the reply asked for");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the drain relay lists secondaries only when the reply asks", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-drain-quiet-"));
  try {
    const { path } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path, { drain: { transcript: { path, after: 0, drain: 9 } } });
    await drain({ url: "http://worker.test", token: "t", fetch: worker.fetch });
    const end = worker.posts.find(post => post.end === true);
    assert.ok(end, "the primary end mark is sent");
    assert.equal("secondaries" in end, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the drain relay does nothing when the worker has nothing to drain", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-drain-none-"));
  try {
    const { path } = secondaryFixture(root);
    const worker = fakeSecondaryWorker(path);
    await drain({ url: "http://worker.test", token: "t", fetch: worker.fetch });
    assert.equal(worker.requests.length, 1);
    assert.equal(worker.requests[0].url, "http://worker.test/drain");
    assert.equal(worker.posts.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
