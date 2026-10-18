import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "./helpers.js";
import { fixture, mixedLineup } from "./team-fixture.js";
import type { UsageSummary } from "../packages/host/src/usage-service.js";

test("usage ledger prices OpenCode members, survives restart idempotently, and counts unmeasured sessions", { timeout: 120000 }, async () => {
  const lineup = structuredClone(mixedLineup);
  lineup.implementers = [
    lineup.implementers[0],
    { id: "deepseek-high", label: "DeepSeek implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light", dataUse: "contributor" },
  ];
  const run = await fixture("usage", lineup, { usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 2 } }, budgets: { opencode: { usd: 10, period: "month" } } } });
  try {
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    const usage = await waitFor(() => run.host.fetchApi("/usage").then(r => r.body as UsageSummary), (u: UsageSummary) => u.providers.opencode.spent?.messages === 4 && u.providers.claude.unmeasuredSessions >= 2, 20000);
    // deepseek member: configured 1000*1 + 500*2 per million = 0.002; spark member: no table entry, reported 0.5
    assert.equal(usage.providers.opencode.spent!.cost.toFixed(4), (0.002 + 0.5).toFixed(4));
    assert.deepEqual(usage.providers.opencode.spent!.pricing, { configured: 2, provider: 2, unknown: 0 });
    assert.equal(usage.providers.opencode.budget?.usd, 10);
    assert.equal(usage.providers.opencode.period.start, usage.period.start, "A monthly budget shares the default month window");
    assert.ok(usage.providers.claude.unmeasuredSessions >= 2, "Active coordinator and reviewer sessions count in the current period");
    assert.equal(usage.providers.claude.measured, false);
    assert.equal(usage.providers.claude.spent, undefined);
    assert.ok(usage.providers.claude.unmeasuredSessions >= 2); // coordinator + reviewer
    const me = (await run.host.fetchApi("/me")).body;
    assert.equal(me.usage.enabled, true);
    assert.equal(me.usage.budgets.opencode.usd, 10);
    await run.host.stopApi();
    await run.host.start();
    const again = (await run.host.fetchApi("/usage")).body as UsageSummary;
    assert.equal(again.providers.opencode.spent!.messages, 4);
    // Give the restarted service time to re-read the journals; a missing cursor would double the rows or the cost.
    await new Promise(resolve => setTimeout(resolve, 5000));
    const settled = (await run.host.fetchApi("/usage")).body as UsageSummary;
    assert.equal(settled.providers.opencode.spent!.messages, 4);
    assert.equal(settled.providers.opencode.spent!.cost.toFixed(4), "0.5020");
    const sessions = (await run.host.fetchApi("/sessions")).body.sessions;
    const deepseek = team.members.find(member => member.modelProfile?.id === "deepseek-high")!;
    assert.equal(sessions.find((s: any) => s.id === deepseek.sessionId).usage.cost.toFixed(4), "0.0020");
    const reviewer = team.members.find(member => member.role === "reviewer")!;
    assert.equal(sessions.find((s: any) => s.id === reviewer.sessionId).usage, undefined);
  } finally { await run.close(); }
});

test("one unreadable journal does not hide another measured session's usage", { timeout: 120000 }, async () => {
  const lineup = structuredClone(mixedLineup);
  lineup.implementers = [
    lineup.implementers[0],
    { id: "deepseek-high", label: "DeepSeek implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light", dataUse: "contributor" },
  ];
  const run = await fixture("usage", lineup, { usage: { prices: {}, budgets: {} } });
  try {
    const team = await run.settled((await run.host.fetchApi("/teams", "owner", run.create())).body.id);
    await waitFor(() => run.host.fetchApi("/usage").then(r => r.body as UsageSummary), (u: UsageSummary) => u.providers.opencode.spent?.messages === 4, 20000);
    // Rebuild the ledger from journals after damaging one member's journal.
    await run.host.stopApi();
    const damaged = team.members.find(member => member.modelProfile?.id === "deepseek-high")!;
    const events = join(run.host.config.stateDir, "sessions", damaged.sessionId!, "events");
    for (const name of readdirSync(events)) writeFileSync(join(events, name), "not a sealed journal\n");
    rmSync(join(run.host.config.stateDir, "usage.sealed"));
    await run.host.start();
    const usage = await waitFor(() => run.host.fetchApi("/usage").then(r => r.body as UsageSummary), (u: UsageSummary) => u.providers.opencode.spent?.messages === 2, 20000);
    assert.equal(usage.providers.opencode.spent!.cost.toFixed(4), "0.5000");
  } finally { await run.close(); }
});
