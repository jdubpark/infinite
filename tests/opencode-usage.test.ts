import test from "node:test";
import assert from "node:assert/strict";
import { JsonLineAssembler, toolFromRunLine, usageFromRunLine, usageFromStepFinish } from "../packages/host/src/opencode-usage.js";

const context = { completedAt: "2026-10-17T12:00:00.000Z", providerId: "deepseek", modelId: "deepseek-flash", modelSource: "requested" as const };
const step = { type: "step-finish", id: "prt_1", messageID: "msg_1", sessionID: "ses_1", reason: "stop", cost: 0.0123,
  tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 100, write: 0 } } };
const completed = { type: "step_finish", timestamp: 2, sessionID: "ses_1", part: step };

test("a step-finish part becomes a usage record; other parts do not", () => {
  assert.deepEqual(usageFromStepFinish(step, context), { provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", modelSource: "requested",
    messageId: "msg_1", partId: "prt_1", completedAt: context.completedAt,
    tokens: { input: 1200, output: 300, reasoning: 50, cacheRead: 100, cacheWrite: 0 }, reportedCost: 0.0123 });
  assert.equal(usageFromStepFinish({ ...step, type: "text" }, context), undefined);
  assert.equal(usageFromStepFinish({ ...step, id: undefined }, context), undefined);
  assert.equal(usageFromStepFinish({ ...step, messageID: "" }, context), undefined);
  assert.equal(usageFromStepFinish(null, context), undefined);
});

test("missing, negative, and non-finite numbers never reach pricing", () => {
  const record = usageFromStepFinish({ ...step, cost: null, tokens: { input: 7.9, output: -3, reasoning: Number.NaN, cache: undefined } }, context);
  assert.deepEqual(record?.tokens, { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(record?.reportedCost, 0);
  const noTokens = usageFromStepFinish({ ...step, tokens: undefined, cost: -1 }, context);
  assert.deepEqual(noTokens?.tokens, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(noTokens?.reportedCost, 0);
});

test("run output lines map to usage by the requested model, and text lines are ignored", () => {
  const record = usageFromRunLine(completed, "deepseek/deepseek-flash", new Date(5));
  assert.equal(record?.completedAt, new Date(2).toISOString());
  assert.deepEqual([record?.providerId, record?.modelId, record?.modelSource], ["deepseek", "deepseek-flash", "requested"]);
  assert.equal(usageFromRunLine({ ...completed, type: "text", part: { type: "text", id: "p", messageID: "m" } }, "a/b"), undefined);
  assert.equal(usageFromRunLine({ ...completed, timestamp: "x" }, "a/b/c", new Date(5))?.completedAt, new Date(5).toISOString());
  assert.equal(usageFromRunLine({ ...completed, timestamp: "x" }, "a/b/c", new Date(5))?.modelId, "b/c");
});

test("the assembler reassembles a JSON line split across chunks and drops other output", () => {
  const line = JSON.stringify(completed); const assembler = new JsonLineAssembler();
  assert.deepEqual(assembler.push("spinner text\r\n" + line.slice(0, 40)), []);
  assert.deepEqual(assembler.push(line.slice(40) + "\n{not json}\n[1]\n"), [completed]);
});

test("the assembler accepts CRLF endings and drops an oversize partial line", () => {
  const assembler = new JsonLineAssembler();
  assert.deepEqual(assembler.push('{"a":1}\r\n'), [{ a: 1 }]);
  assert.deepEqual(assembler.push("x".repeat(1024 * 1024 + 1)), []);
  assert.deepEqual(assembler.push('tail\n{"b":2}\n'), [{ b: 2 }]);
});

test("a finished OpenCode tool part is activity without its input", () => {
  const line = (status: string) => ({ type: "tool_use", timestamp: 5, sessionID: "s", part: { type: "tool", tool: "bash", callID: "call_1", state: { status, input: { command: "npm test" } } } });
  assert.deepEqual(toolFromRunLine(line("completed")), { tool: "bash", toolUseId: "call_1", ok: true });
  assert.deepEqual(toolFromRunLine(line("error")), { tool: "bash", toolUseId: "call_1", ok: false });
  assert.equal(toolFromRunLine({ type: "tool_use", part: { tool: "" } }), undefined);
  assert.equal(toolFromRunLine({ type: "step_finish", part: { type: "step-finish" } }), undefined);
  assert.equal(toolFromRunLine(null), undefined);
});
