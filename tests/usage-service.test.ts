import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers.js";
import { fixture, mixedLineup } from "./team-fixture.js";
import { UsageService, type UsageSessionRow, type UsageSummary } from "../packages/host/src/usage-service.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

const step = (partId: string): UsageRecord => ({ provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m1", partId, modelSource: "reported",
  completedAt: new Date().toISOString(), tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0.01 });

test("a tick reads the listing it is given, and skips an exited session whose journal it has read to the end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-usage-"));
  try {
    const reads: number[] = [];
    const manager = {
      list: () => { throw new Error("The tick must use the listing it was given"); },
      events: (_id: string, after: number) => {
        reads.push(after);
        const events = [step("p1"), step("p2")].map((data, index) => ({ seq: index + 1, at: data.completedAt, type: "usage", data })).filter(event => event.seq > after);
        return { events: events.slice(0, 1), cursor: events[0]?.seq ?? after, more: events.length > 1 };
      },
    } as unknown as Manager;
    const usage = new UsageService({ stateDir: dir } as Config, randomBytes(32), manager);
    const row = { id: "native", provider: "opencode", projectId: "rehearsal", createdAt: new Date().toISOString(), status: "exited", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow;
    await usage.tick([row]);
    assert.deepEqual(reads, [0, 1], "Two pages read the journal to its end");
    assert.equal((usage.session("native") as { messages: number }).messages, 2);
    await usage.tick([row]);
    assert.deepEqual(reads, [0, 1], "An exited session read to its end is not read again");
    assert.equal((usage.session("native") as { messages: number }).messages, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
    const view = (await run.host.fetchApi(`/teams/${created.body.id}`)).body;
    assert.equal(view.usage.byProfile["deepseek-high"].cost.toFixed(4), "0.0020");
    assert.equal(view.usage.byProvider.opencode.messages, 4);
    assert.equal(view.usage.total.cost.toFixed(4), "0.5020");
    assert.ok(view.usage.unmeasuredMembers >= 2, "Coordinator and reviewer are not measured");
    assert.equal(view.members.find((member: any) => member.role === "reviewer").usage, undefined);
    assert.equal(view.members.find((member: any) => member.modelProfile?.id === "deepseek-high").usage.messages, 2);
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
