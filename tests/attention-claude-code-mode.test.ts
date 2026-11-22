import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applySignal, describeNow, dropsPrompt, initialAttention } from "../packages/attention/src/attention.js";
import { mapClaudeHook } from "../packages/attention/src/claude.js";
import { deriveMoments } from "../packages/attention/src/moments.js";
import type { Signal, SignalData, SignalEvent } from "../packages/attention/src/types.js";

const fixtureUrl = new URL("./fixtures/claude-code-mode/hooks.jsonl", import.meta.url);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function replayFixture() {
  const rows = (await readFile(fixtureUrl, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  let attention = initialAttention("fixture", true);
  let seq = 0;
  const events: SignalEvent[] = [];
  const snapshots: Array<{
    hook: string;
    tool: string | null;
    signals: Signal["kind"][];
    state: string;
    lastTool: string | null;
    promptTool: string | null;
    lastMessage: string | null;
    summary: string;
  }> = [];

  for (const row of rows) {
    const body = record(row);
    const signals = mapClaudeHook(row);
    const journaledSignals: Signal["kind"][] = [];
    for (const signal of signals) {
      if (attention.prompt && dropsPrompt(attention, signal)) {
        // Mirror worker.record(): journal the prompt close before a signal drops it.
        seq++;
        const close: SignalEvent = { seq, at: `fixture-${seq}`, type: "signal", data: { kind: "prompt-closed", promptId: attention.prompt.id, reason: "resolved", source: "hook", provider: "claude" } };
        events.push(close); attention = applySignal(attention, close); journaledSignals.push(close.data.kind);
      }
      seq++;
      const data: SignalData = { ...signal, source: "hook", provider: "claude" };
      const event: SignalEvent = { seq, at: `fixture-${seq}`, type: "signal", data };
      events.push(event);
      attention = applySignal(attention, event);
      journaledSignals.push(signal.kind);
    }
    const hook = typeof body.hook_event_name === "string" ? body.hook_event_name : "unknown";
    const tool = typeof body.tool_name === "string" ? body.tool_name : null;
    snapshots.push({
      hook,
      tool,
      signals: journaledSignals,
      state: attention.state,
      lastTool: attention.lastTool?.tool ?? null,
      promptTool: attention.prompt?.tool?.name ?? null,
      lastMessage: attention.lastMessage ?? null,
      summary: describeNow(attention, "claude"),
    });
  }

  return { rows, attention, events, snapshots };
}

test("Claude Code Mode hooks preserve attention state through real hook payloads", async () => {
  const { attention, rows, snapshots } = await replayFixture();
  const write = rows.map(record).find(body => body.hook_event_name === "PreToolUse" && body.tool_name === "Write");
  assert.ok(write);
  const filePath = record(write.tool_input).file_path;
  assert.equal(typeof filePath, "string");
  const waitingSummary = `Permission needed ${filePath}`;

  assert.deepEqual(snapshots, [
    { hook: "SessionStart", tool: null, signals: [], state: "working", lastTool: null, promptTool: null, lastMessage: null, summary: "Thinking" },
    { hook: "UserPromptSubmit", tool: null, signals: ["turn-start"], state: "working", lastTool: null, promptTool: null, lastMessage: null, summary: "Thinking" },
    { hook: "PreToolUse", tool: "Bash", signals: ["tool-start"], state: "working", lastTool: "Bash", promptTool: null, lastMessage: null, summary: "Running wc -c a.txt b.txt c.md" },
    { hook: "PostToolUse", tool: "Bash", signals: ["tool-end"], state: "working", lastTool: null, promptTool: null, lastMessage: null, summary: "Thinking" },
    { hook: "PreToolUse", tool: "Write", signals: ["tool-start"], state: "working", lastTool: "Write", promptTool: null, lastMessage: null, summary: "Editing total.txt" },
    { hook: "PermissionRequest", tool: "Write", signals: ["prompt-open"], state: "needs-you", lastTool: "Write", promptTool: "Write", lastMessage: null, summary: waitingSummary },
    { hook: "PostToolUse", tool: "Write", signals: ["tool-end"], state: "needs-you", lastTool: null, promptTool: "Write", lastMessage: null, summary: waitingSummary },
    { hook: "PostToolUse", tool: "REPL", signals: ["tool-end"], state: "needs-you", lastTool: null, promptTool: "Write", lastMessage: null, summary: waitingSummary },
    { hook: "Stop", tool: null, signals: ["prompt-closed", "turn-end"], state: "turn-finished", lastTool: null, promptTool: null, lastMessage: "17", summary: "17" },
  ]);
  assert.equal(attention.state, "turn-finished");
  assert.equal(attention.prompt, undefined, "Stop clears the hook prompt");
});

test("Code Mode moments retain activity; hook-only waiting follows plain-mode rules", async () => {
  const { rows, events } = await replayFixture();
  const stop = events.findIndex(event => event.data.kind === "turn-end");
  const resolution = events.findIndex(event => event.data.kind === "prompt-closed" && event.data.reason === "resolved");
  assert.equal(resolution, stop - 1);
  const beforeStop = deriveMoments(events.slice(0, resolution));
  // Hook-only attention still waits after Write success, as in plain mode; worker.record() resolves it immediately before Stop.
  assert.equal(beforeStop.find(moment => moment.kind === "decision")?.detail, "Waiting");
  const moments = deriveMoments(events);

  assert.deepEqual(moments.map((moment) => `${moment.kind}:${moment.title}`), [
    "turn:17",
    "edit:total.txt",
    "decision:Permission needed",
    "command:wc -c a.txt b.txt c.md",
    "turn:In one program: run the shell command 'wc -c a.txt b.txt c.md', then write only the total number into a new file named total.txt in the current folder. Reply with only the total.",
  ]);
  const decision = moments.find((moment) => moment.kind === "decision");
  assert.ok(decision);
  assert.equal(decision.detail, "Resolved");
  const writeStart = rows.map(record).find((body) => body.hook_event_name === "PreToolUse" && body.tool_name === "Write");
  assert.ok(writeStart);
  const writeInput = record(record(writeStart).tool_input);
  const edit = moments.find((moment) => moment.kind === "edit");
  assert.ok(edit);
  assert.equal(edit.detail, writeInput.file_path);

  const command = moments.find((moment) => moment.kind === "command");
  assert.ok(command);
  assert.equal(command.status, "ok");
  assert.match(command.detail ?? "", /6\.3s/);
});

test("an unmatched REPL end preserves a running Bash tool and its permission prompt", () => {
  let attention = initialAttention("fixture", true);
  let seq = 0;
  const applyHook = (payload: unknown) => {
    for (const signal of mapClaudeHook(payload)) {
      seq++;
      attention = applySignal(attention, {
        seq, at: `fixture-${seq}`, type: "signal",
        data: { ...signal, source: "hook", provider: "claude" },
      });
    }
  };
  const input = { command: "wc -c a.txt b.txt c.md" };
  applyHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input, tool_use_id: "toolu_cc_0001" });
  applyHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: input, permission_suggestions: [] });
  assert.equal(attention.state, "needs-you");
  assert.equal(attention.lastTool?.tool, "Bash");
  assert.equal(attention.prompt?.tool?.name, "Bash");

  applyHook({
    hook_event_name: "PostToolUse", tool_name: "REPL", tool_use_id: "toolu_010001",
    tool_input: { code: "await $`wc -c a.txt b.txt c.md`", description: "Run wc -c" },
    tool_response: { code: "await $`wc -c a.txt b.txt c.md`", result: "17", stdout: "", stderr: "", toolsUsed: ["Bash"] },
  });
  assert.equal(attention.lastTool?.tool, "Bash");
  assert.equal(attention.prompt?.tool?.name, "Bash");
  assert.equal(attention.state, "needs-you");
});

// The hook of the provider's own continue has no marker: the worker adds it, because only the worker knows it resumed.
test("the continue prompt hook maps to a plain turn-start with no automatic marker", () => {
  const body = {
    session_id: "00000000-0000-4000-8000-000000000001", transcript_path: "/home/dev/.claude/projects/demo/00000000-0000-4000-8000-000000000001.jsonl",
    cwd: "/home/dev/projects/demo", prompt_id: "00000000-0000-4000-8000-000000000002", permission_mode: "default",
    hook_event_name: "UserPromptSubmit", prompt: "Continue from where you left off.",
  };
  assert.deepEqual(mapClaudeHook(body), [{ kind: "turn-start", prompt: "Continue from where you left off." }]);
});
