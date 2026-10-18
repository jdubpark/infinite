import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(payloads.length, before + 1);
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
