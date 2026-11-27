import test from "node:test";
import assert from "node:assert/strict";
import { mapClaudeHook, claudeAgent } from "../packages/attention/src/claude.js";
import { mapCodexHook, mapCodexNotify, mapCodexOsc, mapCodexOsc777 } from "../packages/attention/src/codex.js";
import { cut, isTruncatedArrayMarker, MAX_ARRAY_ITEMS, truncateInput } from "../packages/attention/src/truncate.js";
import { hasTruncatedEvidence } from "../packages/attention/src/delegation.js";

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
  const [ask, open] = mapClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false }] } });
  assert.equal(ask.kind, "tool-start");
  assert.equal(open.kind, "prompt-open");
  if (open.kind !== "prompt-open") throw new Error();
  assert.equal(open.prompt.kind, "question");
  assert.equal(open.prompt.title, "Which DB?");
  assert.equal(open.prompt.options.length, 0);
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

test("codex hooks and notify", () => {
  const [perm] = mapCodexHook({ session_id: "s", cwd: "/w", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf dist" }, tool_use_id: "c1" });
  assert.equal(perm.kind, "prompt-open");
  if (perm.kind !== "prompt-open") throw new Error();
  assert.deepEqual(perm.prompt.destructive, { pattern: "rm-recursive-force" });
  const [stop] = mapCodexHook({ session_id: "s", cwd: "/w", hook_event_name: "Stop", last_assistant_message: "Renamed." });
  assert.equal(stop.kind === "turn-end" && stop.message, "Renamed.");
  const [notify] = mapCodexNotify({ type: "agent-turn-complete", "thread-id": "t", "turn-id": "1", cwd: "/w", "input-messages": ["x"], "last-assistant-message": "Rename complete" });
  assert.equal(notify.kind === "turn-end" && notify.message, "Rename complete");
});

test("codex OSC 9 classifies observed Codex TUI prefixes as structured notices or turn-end without false positives", () => {
  const summary = (text: string) => mapCodexOsc(text).map((s) => s.kind === "notice" ? `notice:${s.type}` : s.kind);
  const approvalCases = [
    "Approval requested: npm test",
    "Approval requested: git push --force",
    "Approval requested by github",
    "Approval requested by linear-mcp",
    "Codex wants to edit 2 files",
    "Codex wants to edit packages/attention/src/codex.ts",
    "Codex wants to edit",
    "Approval requested",
    "Codex: approval requested",
    "Codex: approval requested: npm test",
    "Codex: approval requested by github",
    "  Approval requested: npm test  ",
    "  CODEX WANTS TO EDIT 3 FILES\n",
    "\tAPPROVAL REQUESTED BY GITHUB  ",
  ];
  for (const text of approvalCases) {
    const signals = mapCodexOsc(text);
    assert.deepEqual(summary(text), ["notice:osc_approval"], text);
    assert.equal(signals[0]?.kind === "notice" && signals[0].message, text.trim(), text);
  }
  const questionCases = [
    "Question: which database?",
    "Plan mode prompt: Implement this plan?",
    "Question",
    "Codex: question",
    "Codex: question: which database?",
    "Plan mode prompt",
    "Codex: plan mode prompt: Implement this plan?",
    "  PLAN MODE PROMPT: Ship it?  ",
    "  QUESTION: Ready to deploy?  ",
  ];
  for (const text of questionCases) {
    const signals = mapCodexOsc(text);
    assert.deepEqual(summary(text), ["notice:osc_question"], text);
    assert.equal(signals[0]?.kind === "notice" && signals[0].message, text.trim(), text);
  }
  const turnEndCases = [
    "Agent turn complete",
    "Agent turn complete: Fixed tests",
    "Turn complete",
    "Turn complete: Done",
    "Codex: turn complete",
    "Codex: turn complete: Done",
    "Codex: agent turn complete",
    "  Agent turn complete  \n",
    "\tAGENT TURN COMPLETE",
  ];
  for (const text of turnEndCases) {
    assert.deepEqual(summary(text), ["notice:osc", "turn-end"], text);
  }
  const nonMatchingCases = [
    "Build complete",
    "Waiting for your input",
    "No approval needed",
    "No approval requested",
    "Your question was answered",
    "Codex: task complete",
    "Questioning...",
    "Questions: 3 remaining",
    "Question answered",
    "Plan mode prompt dismissed",
    "Plan mode prompting...",
    "Plan mode prompt? no",
    "Approval requested? no",
    "Approval requested earlier",
    "Approval requested by",
    "Approval requestedness",
    "Codex wants to edit?",
    "Codex wants to editing files",
    "Turn completed? no",
    "Turn complete? no",
    "Agent turn completed",
    "Agent turn complete? no",
    "Agent turn complete failed",
    "4;1;50",
    "",
    "   ",
  ];
  for (const text of nonMatchingCases) {
    assert.deepEqual(summary(text), ["notice:osc"], text);
  }
});

test("codex OSC 777 maps notify;Codex payloads and ignores non-Codex or malformed payloads", () => {
  const summary = (data: string) => mapCodexOsc777(data).map((s) => s.kind === "notice" ? `notice:${s.type}` : s.kind);
  assert.deepEqual(summary("notify;Codex;Approval requested: npm test"), ["notice:osc_approval"]);
  assert.deepEqual(summary("notify;Codex;Approval requested: cd /tmp; npm test"), ["notice:osc_approval"]);
  assert.deepEqual(summary("notify;Codex;Approval requested by github"), ["notice:osc_approval"]);
  assert.deepEqual(summary("notify;Codex;Codex wants to edit 2 files"), ["notice:osc_approval"]);
  assert.deepEqual(summary("notify;Codex;Question: which database?"), ["notice:osc_question"]);
  assert.deepEqual(summary("notify;Codex;Plan mode prompt: Implement this plan?"), ["notice:osc_question"]);
  assert.deepEqual(summary("notify;Codex;Agent turn complete"), ["notice:osc", "turn-end"]);
  assert.deepEqual(summary("notify;codex;  Agent turn complete  "), ["notice:osc", "turn-end"]);
  assert.deepEqual(summary("notify;Codex;Unrelated status"), ["notice:osc"]);
  const semicolonCmd = mapCodexOsc777("notify;Codex;Approval requested: cd /tmp; npm test");
  assert.equal(semicolonCmd[0]?.kind === "notice" && semicolonCmd[0].message, "Approval requested: cd /tmp; npm test");
  for (const ignored of [
    "notify;Other;Agent turn complete",
    "notify;CodexExtra;Agent turn complete",
    "notify;Codex",
    "perl;Codex;Agent turn complete",
    "",
  ]) {
    assert.deepEqual(mapCodexOsc777(ignored), [], ignored);
  }
  assert.deepEqual(mapCodexOsc777(undefined as never), []);
  assert.deepEqual(mapCodexOsc777(42 as never), []);
});

test("replays redacted Codex 0.172.0 OSC 9 and OSC 777 wire frames through parser", () => {
  const parseFrame = (frame: string) => {
    const osc9 = /^\x1b\]9;([\s\S]*)\x07$/.exec(frame);
    if (osc9) return mapCodexOsc(osc9[1]);
    const osc777 = /^\x1b\]777;([\s\S]*)\x1b\\$/.exec(frame);
    if (osc777) return mapCodexOsc777(osc777[1]);
    throw new Error(`Unexpected OSC frame: ${JSON.stringify(frame)}`);
  };
  const summarize = (frame: string) => parseFrame(frame).map((s) => (s.kind === "notice" ? `notice:${s.type}` : s.kind));
  const capturedCodex0172Frames: ReadonlyArray<[string, string, string[]]> = [
    ["exec-approval-osc9", "\x1b]9;Approval requested: npm test\x07", ["notice:osc_approval"]],
    ["mcp-approval-osc9", "\x1b]9;Approval requested by linear-mcp\x07", ["notice:osc_approval"]],
    ["edit-approval-osc9", "\x1b]9;Codex wants to edit 2 files\x07", ["notice:osc_approval"]],
    ["async-question-osc9", "\x1b]9;Question: Which target branch?\x07", ["notice:osc_question"]],
    ["plan-mode-osc777", "\x1b]777;notify;Codex;Plan mode prompt: Implement this plan?\x1b\\", ["notice:osc_question"]],
    ["empty-turn-complete-osc9", "\x1b]9;Agent turn complete\x07", ["notice:osc", "turn-end"]],
    ["nonempty-turn-preview-osc9", "\x1b]9;Updated the parser and ran unit tests.\x07", ["notice:osc"]],
    ["non-codex-osc777", "\x1b]777;notify;Terminal;Agent turn complete\x1b\\", []],
  ];
  for (const [name, frame, expected] of capturedCodex0172Frames) {
    assert.deepEqual(summarize(frame), expected, name);
  }
});

test("claude PermissionDenied closes the open prompt and keeps the reason as a notice", () => {
  const [closed, notice] = mapClaudeHook({ ...base, hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "t9", reason: "Blocked by policy" });
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
  const overArr = truncateInput({ items: Array.from({ length: 51 }, () => "x".repeat(4000)) });
  assert.ok(bytes(overArr) <= 16384, `truncated array case was ${bytes(overArr)}`);
  const nested = truncateInput({ a: { b: { c: "x".repeat(5000) } } });
  assert.ok(bytes(nested) <= 16384);
  const wide = truncateInput({ a: "日".repeat(4000), b: "日".repeat(4000), c: "日".repeat(4000) });
  assert.ok(bytes(wide) <= 16384, `multibyte case was ${bytes(wide)}`);

  const manyTruncatedArrays = truncateInput(Object.fromEntries(
    Array.from({ length: 140 }, (_, i) => [`k${String(i).padStart(3, "0")}`, Array.from({ length: 51 }, () => 0)]),
  ));
  assert.ok(Buffer.byteLength(JSON.stringify(manyTruncatedArrays), "utf8") <= 16_384);
  assert.equal(hasTruncatedEvidence(manyTruncatedArrays), true);

  const manyPrimitives = truncateInput(Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [`k${String(i).padStart(4, "0")}`, 1]),
  ));
  assert.ok(Buffer.byteLength(JSON.stringify(manyPrimitives), "utf8") <= 16_384);
  assert.equal(hasTruncatedEvidence(manyPrimitives), true);

  const hugeKey = truncateInput({ ["a".repeat(20_000)]: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(hugeKey), "utf8") <= 16_384);
  assert.equal(hasTruncatedEvidence(hugeKey), true);

  const wideWithEmpties = truncateInput({
    emptyObj: {},
    emptyArr: [],
    ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${String(i).padStart(4, "0")}`, 1])),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(wideWithEmpties), "utf8") <= 16_384);
  assert.deepEqual(wideWithEmpties.emptyObj, {});
  assert.deepEqual(wideWithEmpties.emptyArr, []);
  assert.equal(hasTruncatedEvidence(wideWithEmpties), true);

  const wideWithUndefined = truncateInput({
    missing: undefined,
    ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${String(i).padStart(4, "0")}`, 1])),
    tailMissing: undefined,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(wideWithUndefined), "utf8") <= 16_384);
  assert.equal(hasTruncatedEvidence(wideWithUndefined), true);
});

test("truncateInput annotates dropped array items without altering 50-item arrays", () => {
  const exact = truncateInput({ items: Array.from({ length: MAX_ARRAY_ITEMS }, (_, i) => i) });
  assert.equal((exact.items as unknown[]).length, MAX_ARRAY_ITEMS);
  assert.equal((exact.items as unknown[]).some(isTruncatedArrayMarker), false);

  const over = truncateInput({
    items: Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, i) => i),
    nested: { items: Array.from({ length: MAX_ARRAY_ITEMS + 3 }, (_, i) => `v${i}`) },
    matrix: [Array.from({ length: MAX_ARRAY_ITEMS + 2 }, (_, i) => i)],
  });
  const roundTrip = JSON.parse(JSON.stringify(over)) as {
    items: unknown[];
    nested: { items: unknown[] };
    matrix: unknown[][];
  };
  assert.equal(roundTrip.items.length, MAX_ARRAY_ITEMS + 1);
  assert.deepEqual(roundTrip.items[MAX_ARRAY_ITEMS], { "[truncated]": true, omitted: 1 });
  assert.equal(isTruncatedArrayMarker(roundTrip.items[MAX_ARRAY_ITEMS]), true);
  assert.deepEqual(roundTrip.nested.items[MAX_ARRAY_ITEMS], { "[truncated]": true, omitted: 3 });
  assert.deepEqual(roundTrip.matrix[0]![MAX_ARRAY_ITEMS], { "[truncated]": true, omitted: 2 });
});

test("claude StopFailure rate_limit adds a single-source provider-limit; other errors do not", () => {
  const limited = mapClaudeHook({ ...base, hook_event_name: "StopFailure", error: "rate_limit", error_details: "5-hour limit" });
  assert.equal(limited.length, 3);
  assert.deepEqual(limited[2], { kind: "provider-limit", limit: "usage", confidence: "single-source", message: "5-hour limit" });
  const plain = mapClaudeHook({ ...base, hook_event_name: "StopFailure", error: "rate_limit" });
  assert.equal(plain[2].kind === "provider-limit" && plain[2].message, "Claude Code reported a usage limit");
  const overloaded = mapClaudeHook({ ...base, hook_event_name: "StopFailure", error: "overloaded" });
  assert.deepEqual(overloaded.map((s) => s.kind), ["error", "turn-end"]);
});

test("claude quota_auto_resume_stale and _disabled add a corroborated provider-limit; _fired is a notice only", () => {
  for (const type of ["quota_auto_resume_stale", "quota_auto_resume_disabled"]) {
    const out = mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: type, message: "waiting" });
    const last = out[out.length - 1];
    assert.equal(last.kind, "provider-limit");
    assert.equal(last.kind === "provider-limit" && last.confidence, "corroborated");
  }
  const fired = mapClaudeHook({ ...base, hook_event_name: "Notification", notification_type: "quota_auto_resume_fired", message: "resumed" });
  assert.deepEqual(fired.map((s) => s.kind), ["notice"]);
});

test("permission evidence distinguishes complete input from omitted array items and command tails", () => {
  const cases = [
    { input: { command: "npm test" }, complete: true },
    { input: { command: "x".repeat(5000) }, complete: false },
    { input: { edits: Array.from({ length: 50 }, (_, n) => ({ old_string: String(n), new_string: "replacement" })) }, complete: true },
    { input: { edits: Array.from({ length: 51 }, (_, n) => ({ old_string: String(n), new_string: "replacement" })) }, complete: false },
  ];
  for (const { input, complete } of cases) {
    const [signal] = mapClaudeHook({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: input });
    assert.equal(signal.kind, "prompt-open");
    if (signal.kind !== "prompt-open") throw new Error("Expected a permission request");
    assert.equal(signal.prompt.tool?.inputComplete, complete);
  }
});
