import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ContextGaugeTail, saturate } from "../packages/host/src/context-gauge.js";

const fixture = (name: string) => new URL(`./fixtures/usage/${name}`, import.meta.url);

const call = (callId: string, name: string, type = "custom_tool_call") => ({ type: "response_item", payload: { type, call_id: callId, name } });
const output = (callId: string, body: unknown, type = "custom_tool_call_output") => ({ type: "response_item", payload: { type, call_id: callId, output: body } });
const item = (id: string, body: Record<string, unknown>) => ({ type: "event_msg", payload: { type: "item_completed", item: { id, ...body } } });
const usage = (responseId: string, inputTokens: number) => ({ type: "token_usage_record", payload: { response_id: responseId, usage: { input_tokens: inputTokens } } });
const claudeStep = (id: string, usageFields: Record<string, unknown>, model = "model-fixture-a") => ({
  type: "assistant", message: { id, model, usage: usageFields, content: [] },
});

function codexSession(): unknown[] {
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
    call("call_direct", "exec"),
    item("call_direct", { type: "CommandExecution", aggregated_output: "hi" }),
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
  for (const row of codexSession()) tail.push(row);
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

test("Codex direct item is never attributed inside a program regardless of row order", () => {
  const c = call("d", "exec");
  const it = item("d", { type: "CommandExecution", aggregated_output: "hi" });
  const out = output("d", "hi");
  const permutations: [string, unknown[]][] = [
    ["call -> item -> output", [c, it, out]],
    ["call -> output -> item", [c, out, it]],
    ["item -> call -> output", [it, c, out]],
    ["item -> output -> call", [it, out, c]],
    ["output -> call -> item", [out, c, it]],
    ["output -> item -> call", [out, it, c]],
    ["duplicate before and between", [it, c, it, out]],
    ["duplicate between and after", [c, it, out, it]],
  ];
  for (const [label, rows] of permutations) {
    const tail = new ContextGaugeTail("codex");
    for (const row of rows) tail.push(row);
    const gauge = tail.snapshot();
    assert.deepEqual(gauge.insidePrograms, {}, label);
    assert.deepEqual(gauge.received, { program: { calls: 1, chars: 2, maxChars: 2 } }, label);
    assert.equal(gauge.unmatched, 0, label);
  }
});

test("out-of-order Codex correlation reconciles mid-stream snapshots and preserves program items", () => {
  const tail = new ContextGaugeTail("codex");
  tail.push(item("prog_before", { type: "CommandExecution", aggregated_output: "a".repeat(10) }));
  tail.push(item("direct_1", { type: "CommandExecution", aggregated_output: "x".repeat(500) }));
  assert.deepEqual(tail.snapshot().insidePrograms, { shell: { calls: 2, chars: 510, maxChars: 500 } });

  tail.push(call("direct_1", "exec"));
  assert.deepEqual(tail.snapshot().insidePrograms, { shell: { calls: 1, chars: 10, maxChars: 10 } });

  tail.push(output("direct_2", [{ type: "input_text", text: "result-two" }, { type: "input_image", image_url: "data:omitted" }], "function_call_output"));
  tail.push({ type: "event_msg", payload: { type: "item_completed", item: { id: "", call_id: "direct_2", type: "McpToolCall", result: { content: [{ type: "text", text: "y".repeat(40) }] } } } });
  tail.push({ type: "event_msg", payload: { type: "item_completed", item: { id: 123, call_id: "direct_2", type: "CommandExecution", aggregated_output: "ignored" } } });
  assert.deepEqual(tail.snapshot().insidePrograms, { shell: { calls: 1, chars: 10, maxChars: 10 } });
  assert.equal(tail.snapshot().unmatched, 1);
  assert.equal(tail.snapshot().images, 1);

  tail.push(call("direct_2", "spawn_agent", "function_call"));
  tail.push(output("direct_1", "ok"));
  tail.push(item("prog_after", { type: "McpToolCall", result: { content: [{ type: "text", text: "m".repeat(7) }] } }));
  tail.push(item("direct_3", { type: "FileChange", stdout: "abc", stderr: "de" }));
  tail.push(output("direct_3", "done", "function_call_output"));

  const gauge = tail.snapshot();
  assert.deepEqual(gauge.insidePrograms, {
    shell: { calls: 1, chars: 10, maxChars: 10 },
    mcp: { calls: 1, chars: 7, maxChars: 7 },
  });
  assert.deepEqual(gauge.received, {
    program: { calls: 1, chars: 2, maxChars: 2 },
    agent: { calls: 1, chars: 10, maxChars: 10 },
    other: { calls: 1, chars: 4, maxChars: 4 },
  });
  assert.equal(gauge.images, 1);
  assert.equal(gauge.unmatched, 1);

  const claudeOutOfOrder = new ContextGaugeTail("claude");
  claudeOutOfOrder.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t_late", content: "hello" }] } });
  assert.deepEqual(claudeOutOfOrder.snapshot().received, { other: { calls: 1, chars: 5, maxChars: 5 } });
  assert.equal(claudeOutOfOrder.snapshot().unmatched, 1);
  claudeOutOfOrder.push({ type: "assistant", message: { id: "m_late", usage: { input_tokens: 10 }, content: [{ type: "tool_use", id: "t_late", name: "Read" }] } });
  assert.deepEqual(claudeOutOfOrder.snapshot().received, { "file-read": { calls: 1, chars: 5, maxChars: 5 } });
  assert.equal(claudeOutOfOrder.snapshot().unmatched, 0);
});

test("out-of-order Codex correlation enforces bounded pending buffers without losing counts", () => {
  const manyItems = new ContextGaugeTail("codex");
  for (let i = 0; i < 8200; i += 1) {
    manyItems.push(item(`p_${i}`, { type: "CommandExecution", aggregated_output: "ab" }));
  }
  assert.deepEqual(manyItems.snapshot().insidePrograms, { shell: { calls: 8200, chars: 16400, maxChars: 2 } });
  manyItems.push(call("p_8199", "exec"));
  assert.deepEqual(manyItems.snapshot().insidePrograms, { shell: { calls: 8199, chars: 16398, maxChars: 2 } });

  const manyOutputs = new ContextGaugeTail("codex");
  for (let i = 0; i < 8200; i += 1) {
    manyOutputs.push(output(`o_${i}`, "xy", "function_call_output"));
  }
  assert.equal(manyOutputs.snapshot().unmatched, 8200);
  assert.deepEqual(manyOutputs.snapshot().received, { other: { calls: 8200, chars: 16400, maxChars: 2 } });
  manyOutputs.push(call("o_8199", "exec"));
  assert.equal(manyOutputs.snapshot().unmatched, 8199);
  assert.deepEqual(manyOutputs.snapshot().received, {
    program: { calls: 1, chars: 2, maxChars: 2 },
    other: { calls: 8199, chars: 16398, maxChars: 2 },
  });

  const dupOutputs = new ContextGaugeTail("codex");
  dupOutputs.push(output("dup", "a"));
  dupOutputs.push(output("dup", "bb"));
  dupOutputs.push(call("dup", "exec"));
  assert.deepEqual(dupOutputs.snapshot().received, {
    program: { calls: 1, chars: 1, maxChars: 1 },
    other: { calls: 1, chars: 2, maxChars: 2 },
  });
  assert.equal(dupOutputs.snapshot().unmatched, 1);
});

test("Codex Extension items measure known payload shapes and stay safe on empty or hostile inputs", () => {
  const webResults = [
    { type: "text_result", ref_id: "turn0search0", url: "https://example.com/result", future_field: { preserved: true } },
  ];
  const structuredResult = { title: "Docs", score: 2, tags: ["a", "b"] };
  const cases: { label: string; body: Record<string, unknown>; cls: "web" | "other"; chars: number }[] = [
    { label: "bare Extension", body: { type: "Extension" }, cls: "web", chars: 0 },
    { label: "web.search with structured results", body: { type: "Extension", kind: "web.search", query: "docs", action: { type: "search", query: "docs", queries: null }, results: webResults }, cls: "web", chars: JSON.stringify(webResults).length },
    { label: "web.search with null results ignores input query", body: { type: "Extension", kind: "web.search", query: "ignored query text", action: { type: "search", query: "ignored" }, results: null }, cls: "web", chars: 0 },
    { label: "web.search with empty results array", body: { type: "Extension", kind: "web.search", query: "docs", results: [] }, cls: "web", chars: 0 },
    { label: "image_gen.generation with inline result", body: { type: "Extension", kind: "image_gen.generation", status: "completed", revisedPrompt: "A blue square", result: "cG5n" }, cls: "other", chars: 4 },
    { label: "image_gen.generation with fileId only", body: { type: "Extension", kind: "image_gen.generation", status: "completed", revisedPrompt: "A blue square", fileId: "file-1" }, cls: "other", chars: 0 },
    { label: "clock.sleep has no result payload", body: { type: "Extension", kind: "clock.sleep", durationMs: 1000 }, cls: "other", chars: 0 },
    { label: "plain text payload", body: { type: "Extension", text: "hello world" }, cls: "web", chars: 11 },
    { label: "plain output string", body: { type: "Extension", output: "fetched body" }, cls: "web", chars: 12 },
    { label: "plain content string", body: { type: "Extension", content: "page text" }, cls: "web", chars: 9 },
    { label: "content-part array with image", body: { type: "Extension", content: [{ type: "output_text", text: "abc" }, { type: "input_image", image_url: "data:omitted" }, { type: "text", text: "de" }] }, cls: "web", chars: 5 },
    { label: "text-only part array without type", body: { type: "Extension", content: [{ text: "abc" }, { text: "defg" }] }, cls: "web", chars: 7 },
    { label: "nested MCP-style result.content", body: { type: "Extension", result: { content: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }], isError: false } }, cls: "web", chars: 9 },
    { label: "nested empty result.content", body: { type: "Extension", result: { content: [], isError: false } }, cls: "web", chars: 0 },
    { label: "nested result.structuredContent when content is empty", body: { type: "Extension", result: { content: [], structuredContent: structuredResult } }, cls: "web", chars: JSON.stringify(structuredResult).length },
    { label: "image-only content array", body: { type: "Extension", content: [{ type: "input_image", image_url: "data:omitted" }] }, cls: "web", chars: 0 },
    { label: "falls back from null results to output", body: { type: "Extension", kind: "web.search", results: null, output: "fallback" }, cls: "web", chars: 8 },
    { label: "nested result.output", body: { type: "Extension", result: { output: "nested-out" } }, cls: "web", chars: 10 },
    { label: "string array results", body: { type: "Extension", results: ["one", "two", "three"] }, cls: "web", chars: 11 },
    { label: "structured JSON result object", body: { type: "Extension", result: structuredResult }, cls: "web", chars: JSON.stringify(structuredResult).length },
    { label: "empty object and primitive payloads", body: { type: "Extension", result: {}, output: 42, content: true, text: null }, cls: "web", chars: 0 },
    { label: "non-serializable BigInt payload", body: { type: "Extension", result: { count: 1n } }, cls: "web", chars: 0 },
  ];

  for (const entry of cases) {
    const tail = new ContextGaugeTail("codex");
    tail.push(item("ext_case", entry.body));
    const snap = tail.snapshot();
    assert.deepEqual(snap.insidePrograms, { [entry.cls]: { calls: 1, chars: entry.chars, maxChars: entry.chars } }, entry.label);
    assert.equal(snap.images, 0, entry.label);
  }

  const sparse: unknown[] = [];
  sparse[1] = "ab";
  const sparseTail = new ContextGaugeTail("codex");
  assert.doesNotThrow(() => sparseTail.push(item("ext_sparse", { type: "Extension", results: sparse })));
  assert.deepEqual(sparseTail.snapshot().insidePrograms, { web: { calls: 1, chars: JSON.stringify(sparse).length, maxChars: JSON.stringify(sparse).length } });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const cyclicTail = new ContextGaugeTail("codex");
  assert.doesNotThrow(() => cyclicTail.push(item("ext_cycle", { type: "Extension", result: circular })));
  assert.deepEqual(cyclicTail.snapshot().insidePrograms, { web: { calls: 1, chars: 0, maxChars: 0 } });

  let deep: Record<string, unknown> = { text: "deep" };
  for (let i = 0; i < 32; i += 1) deep = { result: deep };
  const deepTail = new ContextGaugeTail("codex");
  assert.doesNotThrow(() => deepTail.push(item("ext_deep", { type: "Extension", result: deep })));
  assert.ok((deepTail.snapshot().insidePrograms.web?.chars ?? 0) > 0);

  const directExt = new ContextGaugeTail("codex");
  directExt.push(item("ws_direct", { type: "Extension", kind: "web.search", results: webResults }));
  directExt.push(call("ws_direct", "web.run", "function_call"));
  directExt.push(output("ws_direct", "search summary", "function_call_output"));
  assert.deepEqual(directExt.snapshot().insidePrograms, {});
  assert.deepEqual(directExt.snapshot().received, { other: { calls: 1, chars: 14, maxChars: 14 } });
});

test("saturate clamps totals at safe and custom thresholds and handles invalid inputs", () => {
  const safe = Number.MAX_SAFE_INTEGER;
  assert.equal(saturate(0, 0), 0);
  assert.equal(saturate(0, 0, 100), 0);
  assert.equal(saturate(12, 30), 42);
  assert.equal(saturate(30, 20, 100), 50);
  assert.equal(saturate(safe - 5, 5), safe);
  assert.equal(saturate(60, 40, 100), 100);
  assert.equal(saturate(safe - 5, 6), safe);
  assert.equal(saturate(safe, 1), safe);
  assert.equal(saturate(safe, safe), safe);
  assert.equal(saturate(Number.MAX_VALUE, Number.MAX_VALUE), safe);
  assert.equal(saturate(Infinity, 1), safe);
  assert.equal(saturate(1, Infinity, 100), 100);
  assert.equal(saturate(60, 50, 100), 100);
  assert.equal(saturate(150, 0, 100), 100);
  assert.equal(saturate(0, 150, 100), 100);
  assert.equal(saturate(10, 20, 10.9), 10);
  assert.equal(saturate(safe, 100, safe + 1000), safe);

  for (const invalidLimit of [0, -1, -100, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(saturate(10, 20, invalidLimit), 0, `limit ${String(invalidLimit)}`);
  }

  assert.equal(saturate(-5, 10, 100), 10);
  assert.equal(saturate(10, -5, 100), 10);
  assert.equal(saturate(-5, -10, 100), 0);
  assert.equal(saturate(Number.NaN, 10, 100), 10);
  assert.equal(saturate(10, Number.NaN, 100), 10);
  assert.equal(saturate(Number.NEGATIVE_INFINITY, 10, 100), 10);
  assert.equal(saturate(Number.NaN, Number.NaN), 0);

  const ratios = [0, 25, 50, 100, 150].map(value => saturate(value, 0, 100) / 100);
  assert.deepEqual(ratios, [0, 0.25, 0.5, 1, 1]);
});

test("Codex usage kinds: token_count rows count only without record rows", () => {
  const countRow = (input: number) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input } } } });
  const legacyOnly = new ContextGaugeTail("codex");
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

test("a Claude step input is the sum of its three token fields", () => {
  const tail = new ContextGaugeTail("claude");
  tail.push(claudeStep("msg_sum", { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }));
  assert.deepEqual({ steps: tail.snapshot().modelSteps, peak: tail.snapshot().peakInputTokens }, { steps: 1, peak: 160 });
});

test("Code Mode context gauge counts real model steps and only the program result", () => {
  const tail = new ContextGaugeTail("claude");
  const rows = readFileSync(new URL("./fixtures/claude-code-mode/transcript.jsonl", import.meta.url), "utf8").trim().split("\n");
  for (const line of rows) tail.pushLine(line);
  const gauge = tail.snapshot();
  assert.deepEqual({ modelSteps: gauge.modelSteps, peakInputTokens: gauge.peakInputTokens }, { modelSteps: 2, peakInputTokens: 17531 });
  assert.deepEqual(gauge.received, { program: { calls: 1, chars: 115, maxChars: 115 } });
});

test("tool classes: wait is program, and a name that ends in _agent or _agents is agent", () => {
  const tail = new ContextGaugeTail("codex");
  tail.push(call("w", "wait"));
  tail.push(output("w", "abc"));
  tail.push(call("i", "interrupt_agent", "function_call"));
  tail.push(output("i", "de", "function_call_output"));
  tail.push(call("s", "inspect_agents", "function_call"));
  tail.push(output("s", "fghi", "function_call_output"));
  tail.push(call("o", "agent_notes", "function_call"));
  tail.push(output("o", "j", "function_call_output"));
  assert.deepEqual(tail.snapshot().received, {
    program: { calls: 1, chars: 3, maxChars: 3 },
    agent: { calls: 2, chars: 6, maxChars: 4 },
    other: { calls: 1, chars: 1, maxChars: 1 },
  });
});

test("Codex bounds: forgotten call ids, one call in flight, and recent step ids", () => {
  const abandoned = new ContextGaugeTail("codex");
  for (let index = 0; index < 10_000; index += 1) abandoned.push(call(`c${index}`, "view_image", "function_call"));
  assert.equal(abandoned.snapshot().dropped, 1808);
  abandoned.push(output("c0", "abc", "function_call_output"));
  assert.equal(abandoned.snapshot().unmatched, 1);
  assert.deepEqual(abandoned.snapshot().received.other, { calls: 1, chars: 3, maxChars: 3 });

  const paired = new ContextGaugeTail("codex");
  for (let index = 0; index < 10_000; index += 1) {
    paired.push(call(`p${index}`, "view_image", "function_call"));
    paired.push(output(`p${index}`, "x", "function_call_output"));
  }
  assert.deepEqual({ dropped: paired.snapshot().dropped, unmatched: paired.snapshot().unmatched, calls: paired.snapshot().received.other?.calls }, { dropped: 0, unmatched: 0, calls: 10_000 });

  const distinct = new ContextGaugeTail("codex");
  for (let index = 0; index < 3000; index += 1) distinct.push(usage(`r${index}`, 1));
  assert.equal(distinct.snapshot().modelSteps, 3000);

  const recent = new ContextGaugeTail("codex");
  for (const id of ["a", "b", "a"]) recent.push(usage(id, 1));
  assert.equal(recent.snapshot().modelSteps, 2);
  const aged = new ContextGaugeTail("codex");
  aged.push(usage("a", 1));
  for (let index = 0; index < 1024; index += 1) aged.push(usage(`o${index}`, 1));
  aged.push(usage("a", 1));
  assert.equal(aged.snapshot().modelSteps, 1026);

  const refreshed = new ContextGaugeTail("codex");
  refreshed.push(usage("a", 1));
  for (let index = 0; index < 1023; index += 1) refreshed.push(usage(`o${index}`, 1));
  refreshed.push(usage("a", 1));
  assert.equal(refreshed.snapshot().modelSteps, 1024);
  refreshed.push(usage("new", 1));
  refreshed.push(usage("a", 1));
  assert.equal(refreshed.snapshot().modelSteps, 1025);

  const repeated = new ContextGaugeTail("codex");
  for (let index = 0; index < 8192; index += 1) repeated.push(call(`f${index}`, index === 0 ? "exec" : "view_image", "function_call"));
  repeated.push(call("f0", "view_image", "function_call"));
  repeated.push(output("f0", "abc", "function_call_output"));
  assert.deepEqual({ dropped: repeated.snapshot().dropped, unmatched: repeated.snapshot().unmatched, program: repeated.snapshot().received.program },
    { dropped: 0, unmatched: 0, program: { calls: 1, chars: 3, maxChars: 3 } });
});

test("numbers: Claude token fields that are not safe integers count as 0", () => {
  const steps = (usageFields: Record<string, unknown>) => {
    const tail = new ContextGaugeTail("claude");
    tail.push(claudeStep("msg_n", usageFields));
    const gauge = tail.snapshot();
    return { modelSteps: gauge.modelSteps, peakInputTokens: gauge.peakInputTokens };
  };
  assert.deepEqual(steps({ input_tokens: 1e308, cache_read_input_tokens: 1e308 }), { modelSteps: 1, peakInputTokens: 0 });
  assert.deepEqual(steps({ input_tokens: 9007199254740991, cache_creation_input_tokens: 1 }), { modelSteps: 0, peakInputTokens: 0 });
  assert.deepEqual(steps({ input_tokens: 0.5 }), { modelSteps: 1, peakInputTokens: 0 });
});

test("numbers: a Codex usage row whose input is not a safe non-negative integer is no step", () => {
  for (const input of [1e308, 0.5, -1, Number.MAX_SAFE_INTEGER + 2, "7"]) {
    const record = new ContextGaugeTail("codex");
    record.push(usage("resp_bad", input as number));
    const counted = new ContextGaugeTail("codex");
    counted.push({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input } } } });
    for (const gauge of [record.snapshot(), counted.snapshot()]) {
      assert.deepEqual({ modelSteps: gauge.modelSteps, peak: gauge.peakInputTokens }, { modelSteps: 0, peak: 0 }, `input ${String(input)}`);
    }
  }
});

test("a synthetic Claude row is no model step, and its content is still read", () => {
  const tail = new ContextGaugeTail("claude");
  tail.push(claudeStep("msg_syn", { input_tokens: 500 }, "<synthetic>"));
  tail.push({ type: "assistant", message: { id: "msg_syn", usage: { input_tokens: 500 }, model: "<synthetic>", content: [{ type: "tool_use", id: "t_syn", name: "Bash" }] } });
  tail.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t_syn", content: "ok" }] } });
  assert.deepEqual({ steps: tail.snapshot().modelSteps, peak: tail.snapshot().peakInputTokens, shell: tail.snapshot().received.shell }, { steps: 0, peak: 0, shell: { calls: 1, chars: 2, maxChars: 2 } });
});

test("the Claude fixture gives one step per distinct non-synthetic message id with usage", () => {
  const rows = readFileSync(fixture("claude-session.jsonl"), "utf8").split("\n").flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  assert.ok(rows.length > 0, "the fixture has rows to read");
  const ids = new Set<string>();
  let synthetic = 0;
  for (const row of rows) {
    const message = row.message as { id?: unknown; usage?: unknown; model?: unknown } | undefined;
    if (row.type !== "assistant" || !message?.usage || typeof message.id !== "string") continue;
    if (typeof message.model === "string" && message.model.startsWith("<")) synthetic += 1;
    else ids.add(message.id);
  }
  assert.ok(ids.size > 0, "the fixture has model steps to count");
  assert.ok(synthetic > 0, "the fixture has a synthetic row to skip");

  const tail = new ContextGaugeTail("claude");
  for (const line of readFileSync(fixture("claude-session.jsonl"), "utf8").split("\n")) tail.pushLine(line);
  assert.equal(tail.snapshot().modelSteps, ids.size);
});

test("an id of 256 characters links rows and one of 257 does not", () => {
  for (const [length, linked] of [[256, true], [257, false]] as const) {
    const id = "x".repeat(length);
    const claude = new ContextGaugeTail("claude");
    claude.push(claudeStep(id, { input_tokens: 700 }));
    assert.deepEqual({ steps: claude.snapshot().modelSteps, peak: claude.snapshot().peakInputTokens }, linked ? { steps: 1, peak: 700 } : { steps: 0, peak: 0 }, `length ${length}`);

    const codex = new ContextGaugeTail("codex");
    codex.push(call(id, "exec"));
    codex.push(output(id, "abc"));
    const counted = { calls: 1, chars: 3, maxChars: 3 };
    assert.deepEqual({ unmatched: codex.snapshot().unmatched, received: codex.snapshot().received }, linked ? { unmatched: 0, received: { program: counted } } : { unmatched: 1, received: { other: counted } }, `length ${length}`);
  }
});

test("an output or a program item without a usable id is still measured", () => {
  const parts = [{ type: "input_text", text: "abc" }, { type: "input_image", image_url: "data:omitted" }];
  const codex = new ContextGaugeTail("codex");
  for (const callId of [undefined, "", 7, "x".repeat(257)]) codex.push({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output: parts } });
  for (const id of [undefined, "", 7, "x".repeat(257)]) codex.push({ type: "event_msg", payload: { type: "item_completed", item: { id, type: "CommandExecution", aggregated_output: "hi" } } });
  const gauge = codex.snapshot();
  assert.deepEqual({ received: gauge.received, inside: gauge.insidePrograms, images: gauge.images, unmatched: gauge.unmatched },
    { received: { other: { calls: 4, chars: 12, maxChars: 3 } }, inside: { shell: { calls: 4, chars: 8, maxChars: 2 } }, images: 4, unmatched: 4 });

  const claude = new ContextGaugeTail("claude");
  claude.push({ type: "user", message: { content: [{ type: "tool_result", content: "abc" }, { type: "tool_result", tool_use_id: 9, content: [{ type: "image" }, { type: "text", text: "de" }] }] } });
  assert.deepEqual({ received: claude.snapshot().received, images: claude.snapshot().images, unmatched: claude.snapshot().unmatched },
    { received: { other: { calls: 2, chars: 5, maxChars: 3 } }, images: 1, unmatched: 2 });
});

test("a Codex session with only cumulative totals gives no steps", () => {
  const tail = new ContextGaugeTail("codex");
  const lines = readFileSync(fixture("codex-cumulative-session.jsonl"), "utf8").split("\n").filter(line => line.trim().length > 0);
  assert.ok(lines.length > 0, "the fixture has rows to read");
  for (const line of lines) tail.pushLine(line);
  assert.equal(tail.snapshot().modelSteps, 0);
});

test("hostile rows change nothing and nothing throws", () => {
  const junk: unknown[] = [
    null, undefined, 0, 1, "text", true, [], [null], [{}], {},
    { type: null }, { type: "assistant" }, { type: "assistant", message: null }, { type: "assistant", message: [] },
    { type: "assistant", message: { id: 5, usage: {} } }, { type: "assistant", message: { id: "m", usage: null, content: "s" } },
    { type: "user", message: { content: "str" } }, { type: "user", message: { content: [null, 5, "x", { type: "tool_use" }] } },
    { type: "response_item", payload: null }, { type: "response_item", payload: { type: "custom_tool_call", call_id: 4, name: "exec" } },
    { type: "event_msg", payload: { type: "item_completed", item: null } }, { type: "event_msg", payload: { type: "item_completed", item: { id: 7, type: "Unknown" } } },
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

  const big = new ContextGaugeTail("claude");
  big.push({ type: "assistant", message: { id: "m_big", usage: { input_tokens: 1 }, content: [{ type: "tool_use", id: "big", name: "Bash" }] } });
  big.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "big", content: "a".repeat(5_000_000) }] } });
  assert.deepEqual(big.snapshot().received.shell, { calls: 1, chars: 5_000_000, maxChars: 5_000_000 });

  const bigCodex = new ContextGaugeTail("codex");
  bigCodex.push(call("big", "exec"));
  bigCodex.push(output("big", "a".repeat(5_000_000)));
  assert.deepEqual(bigCodex.snapshot().received.program, { calls: 1, chars: 5_000_000, maxChars: 5_000_000 });
});
