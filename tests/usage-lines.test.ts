import test from "node:test";
import assert from "node:assert/strict";
import { usageLines } from "../packages/host/src/client.js";
import { formatUsd } from "../packages/host/src/usage.js";
import type { UsageSummary } from "../packages/host/src/usage-service.js";

const totals = (cost: number, messages: number, unknown = 0) => ({ cost, messages, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, pricing: { configured: messages - unknown, provider: 0, unknown } });
const idle = { measured: false, period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" }, unmeasuredSessions: 0 };
const lines = (opencode: Partial<UsageSummary["providers"]["opencode"]>, others: Partial<UsageSummary["providers"]> = {}) => {
  const summary = { period: idle.period, providers: { claude: idle, codex: idle, grok: idle, opencode: { ...idle, measured: true, ...opencode }, demo: idle, ...others } } as UsageSummary;
  return usageLines(summary);
};
const opencode = (l: string[]) => l.find(line => line.startsWith("opencode"))!;

test("each provider line takes its period words and start date from its own window and budget", () => {
  const day = opencode(lines({ spent: totals(1, 2), budget: { usd: 5, period: "day" }, period: { start: "2026-10-17T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" } }));
  assert.match(day, /spent \$1\.00 of \$5\.00 for day from 2026-10-17 \(2 steps, 0 unmeasured sessions\)/);
  const week = opencode(lines({ spent: totals(1, 2), budget: { usd: 5, period: "week" }, period: { start: "2026-10-12T00:00:00.000Z", end: "2026-10-19T00:00:00.000Z" } }));
  assert.match(week, /for week from 2026-10-12/);
  const none = opencode(lines({ spent: totals(1, 2), period: { start: "2026-10-12T00:00:00.000Z", end: "2026-10-19T00:00:00.000Z" } }));
  assert.match(none, /spent \$1\.00 for week from 2026-10-12/); assert.doesNotMatch(none, / of \$/);
});

test("over-budget spend is marked and unmeasured providers never print a figure", () => {
  const l = lines({ spent: totals(12, 3), budget: { usd: 10, period: "month" } }, { claude: { ...idle, unmeasuredSessions: 1 } });
  assert.match(opencode(l), /OVER BUDGET$/);
  assert.match(l.find(line => line.startsWith("claude"))!, /unmeasured \(1 session,/);
  assert.doesNotMatch(opencode(lines({ spent: totals(10, 3), budget: { usd: 10, period: "month" } })), /OVER BUDGET/);
});

test("unpriced steps make the figure a lower bound or remove it", () => {
  assert.match(opencode(lines({ spent: totals(1.2, 3, 1) })), /spent at least \$1\.20 for month .*\(3 steps, 1 unpriced,/);
  const all = opencode(lines({ spent: totals(0, 2, 2), budget: { usd: 10, period: "month" } }));
  assert.match(all, /spent — \(no price available\) of \$10\.00/); assert.doesNotMatch(all, /\$0\.00/);
});

test("sub-cent costs are never shown as zero", () => {
  assert.deepEqual([0, 0.003, 0.00004, 0.01, 1.234].map(formatUsd), ["0.00", "0.0030", "<0.0001", "0.01", "1.23"]);
  assert.match(opencode(lines({ spent: totals(0.003, 1) })), /spent \$0\.0030 /);
});
