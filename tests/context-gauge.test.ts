import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ContextGaugeTail } from "../packages/host/src/context-gauge.js";

const codexFixture = new URL("./fixtures/usage/codex-session.jsonl", import.meta.url);

const call = (callId: string, name: string, type = "custom_tool_call") => ({ type: "response_item", payload: { type, call_id: callId, name } });
const output = (callId: string, body: unknown, type = "custom_tool_call_output") => ({ type: "response_item", payload: { type, call_id: callId, output: body } });
const item = (id: string, body: Record<string, unknown>) => ({ type: "event_msg", payload: { type: "item_completed", item: { id, ...body } } });
const usage = (responseId: string, inputTokens: number) => ({ type: "token_usage_record", payload: { response_id: responseId, usage: { input_tokens: inputTokens } } });

/** A synthetic Codex session: two programs, one direct call with its event, usage rows, an image, and an orphan output. */
function codexSession(directEventFirst: boolean): unknown[] {
  const directEvent = item("call_direct", { type: "CommandExecution", aggregated_output: "hi" });
  const directCall = call("call_direct", "exec");
  return [
    call("call_p1", "exec"),
    item("cmd_1", { type: "CommandExecution", aggregated_output: "x".repeat(10) }),
    item("cmd_2", { type: "CommandExecution", aggregated_output: "y".repeat(20) }),
    item("mcp_1", { type: "McpToolCall", result: { content: [{ type: "text", text: "m".repeat(5) }] } }),
    item("cmd_3", { type: "CommandExecution", aggregated_output: "z".repeat(30) }),
    item("mcp_2", { type: "McpToolCall", result: { content: [{ type: "text", text: "n".repeat(7) }, { type: "text", text: "o".repeat(3) }] } }),
    output("call_p1", "p".repeat(100)),
    call("call_p2", "exec"),
    item("fc_1", { type: "FileChange", stdout: "ab", stderr: "c" }),
    item("ext_1", { type: "Extension" }),
    output("call_p2", "q".repeat(50)),
    ...(directEventFirst ? [directEvent, directCall] : [directCall, directEvent]),
    output("call_direct", "hi"),
    call("call_img", "view_image", "function_call"),
    output("call_img", [{ type: "input_text", text: "abc" }, { type: "input_image", image_url: "data:omitted" }], "function_call_output"),
    output("call_unknown", "xyz", "function_call_output"),
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9999 } } } },
    usage("resp_a", 1000),
    usage("resp_a", 1200),
    usage("resp_b", 500),
  ];
}

test("Codex session gives the exact gauge", () => {
  const tail = new ContextGaugeTail("codex");
  for (const row of codexSession(false)) tail.push(row);
  assert.deepEqual(tail.snapshot(), {
    v: 1,
    provider: "codex",
    modelSteps: 2,
    peakInputTokens: 1200,
    received: {
      program: { calls: 3, chars: 152, maxChars: 100 },
      other: { calls: 2, chars: 6, maxChars: 3 },
    },
    insidePrograms: {
      shell: { calls: 3, chars: 60, maxChars: 30 },
      mcp: { calls: 2, chars: 15, maxChars: 10 },
      "file-write": { calls: 1, chars: 3, maxChars: 3 },
      web: { calls: 1, chars: 0, maxChars: 0 },
    },
    images: 1,
    unmatched: 1,
    dropped: 0,
  });
});

test("Codex direct item gives the same gauge whichever row arrives first", () => {
  const before = new ContextGaugeTail("codex");
  const after = new ContextGaugeTail("codex");
  for (const row of codexSession(true)) before.push(row);
  for (const row of codexSession(false)) after.push(row);
  assert.deepEqual(before.snapshot(), after.snapshot());
  assert.equal(before.snapshot().insidePrograms.shell?.calls, 3);
});

test("Codex usage kinds: token_count rows count only without record rows", () => {
  const legacyOnly = new ContextGaugeTail("codex");
  const countRow = (input: number) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input } } } });
  for (const row of [countRow(300), countRow(700), countRow(400)]) legacyOnly.push(row);
  assert.deepEqual({ modelSteps: legacyOnly.snapshot().modelSteps, peak: legacyOnly.snapshot().peakInputTokens }, { modelSteps: 3, peak: 700 });

  for (const order of [["record", "count"], ["count", "record"]]) {
    const mixed = new ContextGaugeTail("codex");
    for (const kind of order) mixed.push(kind === "record" ? usage("resp_only", 800) : countRow(5000));
    assert.deepEqual({ modelSteps: mixed.snapshot().modelSteps, peak: mixed.snapshot().peakInputTokens }, { modelSteps: 1, peak: 800 });
  }
});

test("Claude session gives the exact gauge", () => {
  const tail = new ContextGaugeTail("claude");
  const assistant = (id: string, input: number, content: unknown[], extra: Record<string, unknown> = {}) => ({
    type: "assistant", ...extra, message: { id, usage: { input_tokens: input, cache_read_input_tokens: 0 }, content },
  });
  const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
  const result = (id: string, content: unknown) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });

  tail.push(assistant("msg_1", 100, [toolUse("t1", "Bash"), toolUse("t2", "Read")]));
  tail.push({ type: "assistant", message: { id: "msg_1", usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, content: [toolUse("t3", "Edit")] } });
  tail.push(assistant("msg_2", 300, [toolUse("t4", "Grep"), toolUse("t5", "mcp__linear__get_issue"), toolUse("t6", "Agent")]));
  tail.push(assistant("msg_side", 9000, [toolUse("t7", "Bash")], { isSidechain: true }));
  tail.push({ ...result("t7", "x".repeat(500)), isSidechain: true });
  tail.push(result("t1", "a".repeat(40)));
  tail.push(result("t2", [{ type: "text", text: "b".repeat(25) }, { type: "image", source: {} }]));
  tail.push(result("t3", "c".repeat(12)));
  tail.push(result("t4", "d".repeat(8)));
  tail.push(result("t5", [{ type: "text", text: "e".repeat(6) }, { type: "text", text: "f".repeat(4) }]));
  tail.push(result("t6", "g".repeat(15)));
  tail.push(result("t99", "h".repeat(3)));

  assert.deepEqual(tail.snapshot(), {
    v: 1,
    provider: "claude",
    modelSteps: 2,
    peakInputTokens: 300,
    received: {
      shell: { calls: 1, chars: 40, maxChars: 40 },
      "file-read": { calls: 1, chars: 25, maxChars: 25 },
      "file-write": { calls: 1, chars: 12, maxChars: 12 },
      search: { calls: 1, chars: 8, maxChars: 8 },
      mcp: { calls: 1, chars: 10, maxChars: 10 },
      agent: { calls: 1, chars: 15, maxChars: 15 },
      other: { calls: 1, chars: 3, maxChars: 3 },
    },
    insidePrograms: {},
    images: 1,
    unmatched: 1,
    dropped: 0,
  });
});

test("hostile rows change nothing and nothing throws", () => {
  const junk: unknown[] = [
    null, undefined, 0, 1, "text", true, [], [null], [{}], {},
    { type: null }, { type: "assistant" }, { type: "assistant", message: null }, { type: "assistant", message: [] },
    { type: "assistant", message: { id: 5, usage: {} } }, { type: "assistant", message: { id: "m", usage: null, content: "s" } },
    { type: "user", message: { content: "str" } }, { type: "user", message: { content: [null, 5, "x", { type: "tool_result" }] } },
    { type: "response_item", payload: null }, { type: "response_item", payload: { type: "custom_tool_call", call_id: 4, name: "exec" } },
    { type: "event_msg", payload: { type: "item_completed", item: null } }, { type: "event_msg", payload: { type: "item_completed", item: { id: 7, type: "CommandExecution" } } },
    { type: "token_usage_record", payload: { response_id: 5 } }, { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: -1 } } } },
    { type: "event_msg", payload: { type: "item_completed", item: { id: "j", type: "Unknown" } } },
  ];
  for (const provider of ["claude", "codex"] as const) {
    const tail = new ContextGaugeTail(provider);
    const before = tail.snapshot();
    for (const row of junk) {
      assert.doesNotThrow(() => tail.push(row));
      assert.deepEqual(tail.snapshot(), before, `${provider} changed by ${JSON.stringify(row)}`);
    }
    for (const line of ["", "{", "null", "[]", "42", "not json"]) assert.doesNotThrow(() => tail.pushLine(line));
    assert.deepEqual(tail.snapshot(), before);
  }

  // A 5 million character output is counted by length and never copied.
  const big = new ContextGaugeTail("claude");
  big.push({ type: "assistant", message: { id: "m_big", usage: { input_tokens: 1 }, content: [{ type: "tool_use", id: "big", name: "Bash" }] } });
  big.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "big", content: "a".repeat(5_000_000) }] } });
  assert.deepEqual(big.snapshot().received.shell, { calls: 1, chars: 5_000_000, maxChars: 5_000_000 });

  const bigCodex = new ContextGaugeTail("codex");
  bigCodex.push(call("big", "exec"));
  bigCodex.push(output("big", "a".repeat(5_000_000)));
  assert.deepEqual(bigCodex.snapshot().received.program, { calls: 1, chars: 5_000_000, maxChars: 5_000_000 });
});

test("Codex call ids are bounded and a forgotten output is unmatched", () => {
  const tail = new ContextGaugeTail("codex");
  for (let index = 0; index < 10_000; index += 1) tail.push(call(`c${index}`, "view_image", "function_call"));
  assert.equal(tail.snapshot().dropped, 1808);
  tail.push(output("c0", "abc", "function_call_output"));
  const gauge = tail.snapshot();
  assert.equal(gauge.unmatched, 1);
  assert.deepEqual(gauge.received.other, { calls: 1, chars: 3, maxChars: 3 });
});

test("the Codex fixture gives one step per distinct response id", () => {
  const lines = readFileSync(codexFixture, "utf8").split("\n").filter(line => line.trim().length > 0);
  const responseIds = new Set<string>();
  for (const line of lines) {
    const row = JSON.parse(line) as { type?: string; payload?: { response_id?: unknown } };
    if (row.type === "token_usage_record" && typeof row.payload?.response_id === "string") responseIds.add(row.payload.response_id);
  }
  assert.ok(responseIds.size > 0, "the fixture has usage records to count");

  const tail = new ContextGaugeTail("codex");
  for (const line of lines) tail.pushLine(line);
  assert.equal(tail.snapshot().modelSteps, responseIds.size);
});
