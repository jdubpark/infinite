import test from "node:test";
import assert from "node:assert/strict";
import { mapClaudeHook, claudeAgent } from "../packages/attention/src/claude.js";
import { mapCodexHook, mapCodexNotify, mapCodexOsc } from "../packages/attention/src/codex.js";
import { cut, truncateInput } from "../packages/attention/src/truncate.js";

const base = { session_id: "s", transcript_path: "/t", cwd: "/w", permission_mode: "default" };

test("claude PreToolUse becomes tool-start with destructive flag and quiet marking", () => {
  const [bash] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "t1" });
  assert.equal(bash.kind, "tool-start");
  if (bash.kind !== "tool-start") throw new Error();
  assert.equal(bash.quiet, false);
  assert.equal(bash.toolUseId, "t1");
  assert.deepEqual(bash.destructive, { pattern: "rm-recursive-force" });
  const [read] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/w/a.ts" } });
  assert.equal(read.kind === "tool-start" && read.quiet, true);
  const [ask] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] } });
  assert.equal(ask.kind, "tool-start");
  const open = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] } })[1];
  assert.equal(open.kind, "prompt-open");
  if (open.kind !== "prompt-open") throw new Error();
  assert.equal(open.prompt.kind, "question");
  assert.equal(open.prompt.title, "Which DB?");
  assert.equal(open.prompt.options.length, 0); // options come from the screen
  assert.equal(open.prompt.multiSelect, false);
});

test("claude PermissionRequest, PostToolUse, Stop, Notification", () => {
  const [perm] = mapClaudeHook({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push --force" }, permission_suggestions: [] });
  assert.equal(perm.kind, "prompt-open");
  if (perm.kind !== "prompt-open") throw new Error();
  assert.equal(perm.prompt.kind, "permission");
  assert.equal(perm.prompt.detail, "git push --force");
  assert.deepEqual(perm.prompt.destructive, { pattern: "git-push-force" });
  assert.equal(perm.prompt.source, "hook");
  const [end] = mapClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok", exitCode: 0, bashEditDiff: { changedFiles: ["/w/a.ts"] } }, tool_use_id: "t2", duration_ms: 1200 });
  assert.equal(end.kind, "tool-end");
  if (end.kind !== "tool-end") throw new Error();
  assert.equal(end.ok, true);
  assert.equal(end.durationMs, 1200);
  assert.deepEqual(end.files, ["/w/a.ts"]);
  const [fail] = mapClaudeHook({ ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, error: "exit 1" });
  assert.equal(fail.kind === "tool-end" && fail.ok, false);
  const [stop] = mapClaudeHook({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "x".repeat(5000), background_tasks: [{ id: "a" }] });
  assert.equal(stop.kind, "turn-end");
  if (stop.kind !== "turn-end") throw new Error();
  assert.equal(stop.message?.length, 4000 + " … [+1000 chars]".length);
  assert.equal(stop.backgroundTasks, 1);
  const [notice, prompt] = mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" });
  assert.equal(notice.kind, "notice");
  assert.equal(prompt.kind, "prompt-open");
  const [idle] = mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt", message: "" });
  assert.equal(idle.kind, "notice");
  assert.equal(mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt" }).length, 1);
  const [turn] = mapClaudeHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "add docs" });
  assert.equal(turn.kind === "turn-start" && turn.prompt, "add docs");
  assert.deepEqual(claudeAgent({ ...base, agent_id: "a1", agent_type: "Explore" }), { id: "a1", type: "Explore" });
  assert.equal(mapClaudeHook({ nonsense: true }).length, 0);
});

test("codex hooks, notify and osc", () => {
  const [perm] = mapCodexHook({ session_id: "s", cwd: "/w", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf dist" }, tool_use_id: "c1" });
  assert.equal(perm.kind, "prompt-open");
  if (perm.kind !== "prompt-open") throw new Error();
  assert.deepEqual(perm.prompt.destructive, { pattern: "rm-recursive-force" });
  const [stop] = mapCodexHook({ session_id: "s", cwd: "/w", hook_event_name: "Stop", last_assistant_message: "Renamed." });
  assert.equal(stop.kind === "turn-end" && stop.message, "Renamed.");
  const [notify] = mapCodexNotify({ type: "agent-turn-complete", "thread-id": "t", "turn-id": "1", cwd: "/w", "input-messages": ["x"], "last-assistant-message": "Rename complete" });
  assert.equal(notify.kind === "turn-end" && notify.message, "Rename complete");
  const osc = mapCodexOsc("Codex: approval requested");
  assert.equal(osc[0].kind, "notice");
  assert.equal(osc[1]?.kind, "prompt-open");
});

test("codex OSC text opens a prompt or ends a turn only on a known leading phrase", () => {
  const kinds = (text: string) => mapCodexOsc(text).map((s) => s.kind === "prompt-open" ? `prompt-open:${s.prompt.kind}` : s.kind);
  assert.deepEqual(kinds("Codex: approval requested"), ["notice", "prompt-open:permission"]);
  assert.deepEqual(kinds("  Approval requested: npm test"), ["notice", "prompt-open:permission"]);
  assert.deepEqual(kinds("Codex: question"), ["notice", "prompt-open:question"]);
  assert.deepEqual(kinds("Question: which database?"), ["notice", "prompt-open:question"]);
  assert.deepEqual(kinds("Codex: turn complete"), ["notice", "turn-end"]);
  assert.deepEqual(kinds("Turn complete"), ["notice", "turn-end"]);
  // Words elsewhere in the text are only a notice.
  for (const text of ["Build complete", "Waiting for your input", "No approval needed", "Your question was answered", "Codex: task complete"])
    assert.deepEqual(kinds(text), ["notice"], text);
});

test("claude PermissionDenied closes the open prompt and keeps the reason as a notice", () => {
  const [closed, notice] = mapClaudeHook({ ...base, hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "t9", reason: "Blocked by policy" });
  // The worker binds promptId 0 to whichever prompt is open.
  assert.deepEqual(closed, { kind: "prompt-closed", promptId: 0, reason: "resolved" });
  assert.deepEqual(notice, { kind: "notice", type: "permission_denied", message: "Blocked by policy" });
});

test("truncation rules", () => {
  assert.equal(cut("abc", 2), "ab … [+1 chars]");
  const out = truncateInput({ command: "x".repeat(5000), content: "y".repeat(3000), nested: { deep: "z".repeat(5000) }, n: 1 });
  assert.equal((out.command as string).length, 4000 + " … [+1000 chars]".length);
  assert.equal((out.content as string).length, 2000 + " … [+1000 chars]".length);
  assert.equal(((out.nested as Record<string, unknown>).deep as string).length, 4000 + " … [+1000 chars]".length);
  assert.equal(out.n, 1);
});

test("mapCodexOsc ignores non-string input", () => {
  assert.deepEqual(mapCodexOsc(undefined as never), []);
  assert.deepEqual(mapCodexOsc(42 as never), []);
});

test("destructive matching sees the full command, not the truncated copy", () => {
  const command = `${" ".repeat(2100)}rm -rf build`;
  const [start] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(start.kind === "tool-start" && start.destructive, { pattern: "rm-recursive-force" });
  const [perm] = mapClaudeHook({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(perm.kind === "prompt-open" && perm.prompt.destructive, { pattern: "rm-recursive-force" });
  const [cStart] = mapCodexHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(cStart.kind === "tool-start" && cStart.destructive, { pattern: "rm-recursive-force" });
  const [cPerm] = mapCodexHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(cPerm.kind === "prompt-open" && cPerm.prompt.destructive, { pattern: "rm-recursive-force" });
});

test("truncateInput enforces the 16 KiB UTF-8 cap", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const arr = truncateInput({ items: Array.from({ length: 50 }, () => "x".repeat(4000)) });
  assert.ok(bytes(arr) <= 16384, `array case was ${bytes(arr)}`);
  const nested = truncateInput({ a: { b: { c: "x".repeat(5000) } } });
  assert.ok(bytes(nested) <= 16384);
  const wide = truncateInput({ a: "日".repeat(4000), b: "日".repeat(4000), c: "日".repeat(4000) });
  assert.ok(bytes(wide) <= 16384, `multibyte case was ${bytes(wide)}`);
});
