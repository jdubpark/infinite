import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applySignal, describeNow, initialAttention } from "../packages/attention/src/attention.js";
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
    for (const signal of signals) {
      seq++;
      const data: SignalData = { ...signal, source: "hook", provider: "claude" };
      const event: SignalEvent = { seq, at: `fixture-${seq}`, type: "signal", data };
      events.push(event);
      attention = applySignal(attention, event);
    }
    const hook = typeof body.hook_event_name === "string" ? body.hook_event_name : "unknown";
    const tool = typeof body.tool_name === "string" ? body.tool_name : null;
    snapshots.push({
      hook,
      tool,
      signals: signals.map((signal) => signal.kind),
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
    { hook: "Stop", tool: null, signals: ["turn-end"], state: "turn-finished", lastTool: null, promptTool: null, lastMessage: "17", summary: "17" },
  ]);
  assert.equal(attention.state, "turn-finished");
  assert.equal(attention.prompt, undefined, "Stop clears the hook prompt");
});

test("Code Mode moments retain shell and file activity without inventing a REPL moment", async () => {
  const { rows, events } = await replayFixture();
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
  assert.equal(decision.detail, "Waiting");
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
