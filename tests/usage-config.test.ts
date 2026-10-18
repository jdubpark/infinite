import test from "node:test"; import assert from "node:assert/strict";
import { teamLineupSchema, resolveLimitFallback } from "../packages/host/src/team-types.js";
import { usageConfigSchema } from "../packages/host/src/config.js";
const p = (id: string, provider: "claude" | "codex" | "opencode", tier?: "light" | "strong", limitFallback?: string) =>
  provider === "opencode" ? { id, label: id, provider, model: "deepseek/deepseek-flash", variant: "high", tier, limitFallback }
  : { id, label: id, provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-6-luna", effort: "high", tier, limitFallback };
const base = { coordinator: p("c", "claude", "strong", "ds-strong"), integrator: p("c", "claude", "strong", "ds-strong"), reviewer: p("c", "claude", "strong", "ds-strong"),
  implementers: [p("haiku", "claude", "light", "ds-light")], fallbacks: [p("ds-strong", "opencode", "strong"), p("ds-light", "opencode", "light")] };
test("lineup fallbacks must exist, change provider, keep strong tier, and not cycle", () => {
  assert.ok(teamLineupSchema.safeParse(base).success);
  assert.equal(teamLineupSchema.safeParse({ ...base, implementers: [p("haiku", "claude", "light", "missing")] }).success, false);
  assert.equal(teamLineupSchema.safeParse({ ...base, implementers: [p("haiku", "claude", "light", "c")] }).success, false); // same provider
  assert.equal(teamLineupSchema.safeParse({ ...base, coordinator: p("c", "claude", "strong", "ds-light"), integrator: p("c", "claude", "strong", "ds-light"), reviewer: p("c", "claude", "strong", "ds-light") }).success, false); // strong -> light
  const cyclic = { ...base, fallbacks: [p("ds-strong", "opencode", "strong"), p("ds-light", "opencode", "light", "haiku")] };
  assert.equal(teamLineupSchema.safeParse(cyclic).success, false);
});
test("resolveLimitFallback follows at most two hops and skips limited providers", () => {
  const lineup = teamLineupSchema.parse({ ...base, implementers: [p("haiku", "claude", "light", "luna")], escalations: [p("luna", "codex", "light", "ds-light")] });
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["claude"]))?.id, "luna");
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["claude", "codex"]))?.id, "ds-light");
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["claude", "codex", "opencode"])), undefined);
  assert.equal(resolveLimitFallback(lineup, "ds-light", new Set(["opencode"])), undefined);
});
test("usage config accepts per-million prices and provider budgets", () => {
  const parsed = usageConfigSchema.parse({ prices: { "deepseek/deepseek-flash": { input: 0.14, output: 0.28 } }, budgets: { opencode: { usd: 50 } } });
  assert.equal(parsed.budgets.opencode?.period, "month");
  assert.equal(usageConfigSchema.safeParse({ prices: { "x/y": { input: -1, output: 0 } }, budgets: {} }).success, false);
});
