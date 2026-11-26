import test from "node:test";
import assert from "node:assert/strict";
import { accountOf, listPriceUsage, periodStart, priceUsage, sumUsage, type UsageRecord } from "../packages/host/src/usage.js";
import type { UsageConfig } from "../packages/host/src/config.js";

const base: UsageRecord = {
  provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m1", partId: "p1", modelSource: "reported", completedAt: "2026-10-17T12:00:00.000Z",
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0,
};

test("configured prices override the reported cost and are per million tokens", () => {
  const record = { ...base, tokens: { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 2_000_000, cacheWrite: 0 }, reportedCost: 9 };
  const configured = priceUsage(record, { "deepseek/deepseek-flash": { input: 0.14, output: 0.28, cacheRead: 0.014 } });
  assert.ok(Math.abs(configured.cost - (0.14 + 0.14 + 0.028)) < 1e-9);
  assert.equal(configured.pricing, "configured");
  assert.deepEqual(priceUsage(record, { "deepseek/deepseek-flash": { input: 1, output: 1 } }).cost, 1 + 0.5 + 2);
});

test("reasoning tokens bill at the output rate", () => {
  const record = { ...base, tokens: { input: 0, output: 0, reasoning: 1_000_000, cacheRead: 0, cacheWrite: 0 } };
  assert.deepEqual(priceUsage(record, { "deepseek/deepseek-flash": { input: 1, output: 2 } }), { cost: 2, pricing: "configured" });
});

test("reported cost is used without a table, and zero without a table is unknown", () => {
  assert.deepEqual(priceUsage({ ...base, modelId: "unlisted-model", reportedCost: 0.02 }, undefined), { cost: 0.02, pricing: "provider" });
  assert.deepEqual(priceUsage({ ...base, modelId: "unlisted-model", reportedCost: 0 }, {}), { cost: 0, pricing: "unknown" });
});

test("a record whose model was never observed is unknown, whatever its reported cost or the price table", () => {
  const unknown = { ...base, providerId: "unknown", modelId: "unknown", modelSource: "unknown" as const, reportedCost: 0.5, tokens: { ...base.tokens, input: 1_000_000 } };
  assert.deepEqual(priceUsage(unknown, undefined), { cost: 0, pricing: "unknown" });
  assert.deepEqual(priceUsage(unknown, { "unknown/unknown": { input: 1, output: 1 } }), { cost: 0, pricing: "unknown" });
});

test("period starts are UTC day, Monday week, and month", () => {
  const now = new Date("2026-10-17T15:00:00Z");
  assert.equal(periodStart("day", now).toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(periodStart("week", now).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(periodStart("month", now).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(periodStart("week", new Date("2026-10-18T00:00:00Z")).toISOString(), "2026-10-12T00:00:00.000Z");
});

test("sumUsage rounds the total to micro-dollars once, not per row", () => {
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const totals = sumUsage([0.0000004, 0.0000004, 0.0000004].map((cost) => ({ cost, pricing: "provider" as const, tokens: zero })));
  assert.equal(totals.cost, 0.000001);
});

test("sumUsage adds costs, tokens, and counts pricing sources", () => {
  const tokens = { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 };
  const totals = sumUsage([
    { cost: 0.5, pricing: "configured", tokens },
    { cost: 0.25, pricing: "provider", tokens },
    { cost: 0, pricing: "unknown", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
  ]);
  assert.deepEqual(totals, {
    cost: 0.75, messages: 3, tokens: { input: 20, output: 10, reasoning: 2, cacheRead: 4, cacheWrite: 6 },
    pricing: { configured: 1, catalog: 0, provider: 1, unknown: 1 },
  });
});

test("catalog prices DeepSeek flash off peak and doubles at peak boundaries", () => {
  const record = { ...base, tokens: { input: 1_000_000, output: 1_000_000, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 } };
  assert.deepEqual(priceUsage({ ...record, completedAt: "2026-10-17T02:00:00Z" }, undefined), { cost: 0.753, pricing: "catalog" });
  assert.equal(priceUsage({ ...record, completedAt: "2026-10-16T03:59:59Z" }, undefined).cost, 1.506);
  assert.equal(priceUsage({ ...record, completedAt: "2026-10-16T04:00:00Z" }, undefined).cost, 0.753);
});

test("configured price beats the built-in catalog and accounts match globs", () => {
  assert.deepEqual(priceUsage({ ...base, tokens: { ...base.tokens, input: 1_000_000 } }, { "deepseek/deepseek-flash": { input: 3, output: 2 } }), { cost: 3, pricing: "configured" });
  assert.equal(accountOf("deepseek", "deepseek-flash", { deepseek: { kind: "metered", match: ["deepseek/*"] } }), "deepseek");
  assert.equal(accountOf("meta", "muse-spark", { deepseek: { kind: "metered", match: ["deepseek/*"] } }), "meta");
});

test("Codex records with positive cacheWrite stay unpriced while zero cacheWrite and Claude price normally", () => {
  const prices: UsageConfig["prices"] = {
    "openai/gpt-5.4": { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
    "anthropic/claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  const codexBase: UsageRecord = {
    ...base,
    provider: "codex",
    providerId: "openai",
    modelId: "gpt-5.4",
    tokens: { input: 100_000, output: 50_000, reasoning: 0, cacheRead: 10_000, cacheWrite: 5_000 },
    reportedCost: 0,
  };
  assert.deepEqual(listPriceUsage(codexBase, prices), { cost: 0, pricing: "unknown" });
  assert.deepEqual(priceUsage(codexBase, prices), { cost: 0, pricing: "unknown" });
  assert.deepEqual(
    listPriceUsage({ ...codexBase, tokens: { ...codexBase.tokens, cacheWrite: 0 } }, prices),
    { cost: 0.602, pricing: "configured" },
  );
  const claudeRecord: UsageRecord = {
    ...base,
    provider: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet",
    tokens: { input: 100_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 100_000 },
    reportedCost: 0,
  };
  assert.deepEqual(listPriceUsage(claudeRecord, prices), { cost: 0.675, pricing: "configured" });
});
