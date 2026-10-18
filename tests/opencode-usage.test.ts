import test from "node:test";
import assert from "node:assert/strict";
import { JsonLineAssembler, usageFromMessageUpdated } from "../packages/host/src/opencode-usage.js";

const completed = { type: "message.updated", properties: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", providerID: "deepseek", modelID: "deepseek-flash", cost: 0.0123,
  tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 100, write: 0 } }, time: { created: 1, completed: 2 } } } };

test("completed assistant messages become usage records; streaming and user messages do not", () => {
  assert.deepEqual(usageFromMessageUpdated(completed), { provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "msg_1", completedAt: new Date(2).toISOString(),
    tokens: { input: 1200, output: 300, reasoning: 50, cacheRead: 100, cacheWrite: 0 }, reportedCost: 0.0123 });
  assert.equal(usageFromMessageUpdated({ ...completed, properties: { info: { ...completed.properties.info, time: { created: 1 } } } }), undefined);
  assert.equal(usageFromMessageUpdated({ type: "message.updated", properties: { info: { id: "u", role: "user", time: { created: 1, completed: 2 } } } }), undefined);
  assert.equal(usageFromMessageUpdated({ ...completed, type: "message.part.updated" }), undefined);
  assert.equal(usageFromMessageUpdated(null), undefined);
});

test("missing, negative, and non-finite numbers never reach pricing", () => {
  const info = { ...completed.properties.info, cost: null, tokens: { input: 7.9, output: -3, reasoning: Number.NaN, cache: undefined } };
  const record = usageFromMessageUpdated({ ...completed, properties: { info } });
  assert.deepEqual(record?.tokens, { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(record?.reportedCost, 0);
  const noTokens = usageFromMessageUpdated({ ...completed, properties: { info: { ...info, tokens: undefined, cost: -1 } } });
  assert.deepEqual(noTokens?.tokens, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(noTokens?.reportedCost, 0);
});

test("a completed message without identifiers or a valid completion time is ignored", () => {
  for (const patch of [{ id: undefined }, { providerID: undefined }, { modelID: undefined }, { time: { created: 1, completed: "x" } }])
    assert.equal(usageFromMessageUpdated({ ...completed, properties: { info: { ...completed.properties.info, ...patch } } }), undefined);
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
