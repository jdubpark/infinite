import test from "node:test"; import assert from "node:assert/strict";
import { teamLineupSchema, resolveLimitFallback } from "../packages/host/src/team-types.js";
import { usageConfigSchema } from "../packages/host/src/config.js";
import { switchFallback } from "../packages/host/src/teams.js";
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
test("a limit switch never falls back onto the stopped member's own provider", () => {
  // haiku (Claude) falls back to OpenCode, whose own fallback is another Claude profile.
  const lineup = teamLineupSchema.parse({ ...base, implementers: [p("haiku", "claude", "light", "ds-chain")], escalations: [p("sonnet", "claude", "light")],
    fallbacks: [p("ds-strong", "opencode", "strong"), p("ds-light", "opencode", "light"), p("ds-chain", "opencode", "light", "sonnet")] });
  // Host memory holds only OpenCode; Claude's limit was seen by a single-source hook on the stopped member.
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["opencode"]))?.id, "sonnet", "The resolver alone would return to Claude");
  assert.equal(switchFallback(lineup, "haiku", "claude", new Set(["opencode"])), undefined);
  assert.equal(switchFallback(lineup, "haiku", "claude", new Set())?.id, "ds-chain");
});
test("usage config accepts per-million prices and provider budgets", () => {
  const parsed = usageConfigSchema.parse({ prices: { "deepseek/deepseek-flash": { input: 0.14, output: 0.28 } }, budgets: { opencode: { usd: 50 } } });
  assert.equal(parsed.budgets.opencode?.period, "month");
  assert.equal(usageConfigSchema.safeParse({ prices: { "x/y": { input: -1, output: 0 } }, budgets: {} }).success, false);
});
test("usage accounts default empty and balance keys require absolute paths", () => {
  assert.deepEqual(usageConfigSchema.parse({}).accounts, {});
  const good = usageConfigSchema.parse({ accounts: { deepseek: { kind: "metered", match: ["deepseek/*"], balance: { source: "deepseek", apiKeyFile: "/private/key" } } } });
  assert.equal(good.accounts.deepseek?.balance?.source, "deepseek");
  assert.equal(usageConfigSchema.safeParse({ accounts: { deepseek: { kind: "metered", match: ["deepseek/*"], balance: { source: "deepseek", apiKeyFile: "relative-key" } } } }).success, false);
});
