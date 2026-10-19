import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, waitFor } from "./helpers.js";
import { writeSealed } from "../packages/host/src/vault.js";
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

test("an unreadable or misshapen ledger is discarded with a warning and the service starts empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-usage-")), key = randomBytes(32), file = join(dir, "usage.sealed");
  const warn = console.warn, warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const manager = {} as Manager;
    for (const write of [() => writeFileSync(file, "not a sealed ledger"), () => writeSealed(file, key, "usage", { rows: [], cursors: {}, sessions: {} }), () => writeSealed(file, key, "usage", { rows: {}, cursors: {} })]) {
      write();
      const usage = new UsageService({ stateDir: dir } as Config, key, manager);
      assert.equal(usage.summary().providers.opencode.spent?.messages, 0);
      assert.deepEqual(usage.session("any"), { measured: false });
    }
    assert.equal(warnings.length, 3, "One warning for each discarded ledger");
  } finally { console.warn = warn; rmSync(dir, { recursive: true, force: true }); }
});

test("the API starts and serves with unreadable usage and limit files", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    await host.stopApi();
    writeFileSync(join(host.config.stateDir, "usage.sealed"), "not a sealed ledger");
    writeFileSync(join(host.config.stateDir, "provider-limits.sealed"), "not a sealed limits file");
    await host.start();
    const usage = await host.fetchApi("/usage");
    assert.equal(usage.status, 200);
    assert.equal((usage.body as UsageSummary).providers.opencode.spent?.messages, 0);
    assert.deepEqual((await host.fetchApi("/me")).body.providerLimits, []);
  } finally { await host.stop(); }
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
    const initial = (await run.host.fetchApi(`/teams/${created.body.id}`)).body;
    for (const task of initial.tasks) if (task.usage) assert.ok(task.usage.usd > 0 || task.usage.unpriced > 0 || task.usage.tokens > 0, "task usage appears only after recorded usage exists");
    const team = await run.settled(created.body.id);
    const usage = await waitFor(() => run.host.fetchApi("/usage").then(r => r.body as UsageSummary), (u: UsageSummary) => u.providers.opencode.spent?.messages === 4 && u.providers.claude.unmeasuredSessions >= 2, 20000);
    const view = (await run.host.fetchApi(`/teams/${created.body.id}`)).body;
    assert.equal(view.usage.byProfile["deepseek-high"].cost.toFixed(4), "0.0020");
    assert.equal(view.usage.byProvider.opencode.messages, 4);
    assert.equal(view.usage.total.cost.toFixed(4), "0.0022");
    assert.ok(view.usage.unmeasuredMembers >= 2, "Coordinator and reviewer are not measured");
    assert.equal(view.members.find((member: any) => member.role === "reviewer").usage, undefined);
    assert.equal(view.members.find((member: any) => member.modelProfile?.id === "deepseek-high").usage.messages, 2);
    const deepseekMember = team.members.find(member => member.modelProfile?.id === "deepseek-high")!, taskUsage = view.tasks.find((task: any) => task.id === deepseekMember.taskId)?.usage;
    assert.equal(taskUsage.attempts, team.members.filter(member => member.taskId === deepseekMember.taskId).length);
    assert.equal(taskUsage.usd, 0.002);
    // DeepSeek uses the configured price; the default Muse model uses its built-in catalog entry.
    assert.equal(usage.providers.opencode.spent!.cost.toFixed(4), "0.0022");
    assert.deepEqual(usage.providers.opencode.spent!.pricing, { configured: 2, catalog: 2, provider: 0, unknown: 0 });
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
    assert.equal(settled.providers.opencode.spent!.cost.toFixed(4), "0.0022");
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
    assert.equal(usage.providers.opencode.spent!.cost.toFixed(4), "0.0002");
  } finally { await run.close(); }
});

test("daily attribution honors IANA day boundaries; task and project rollups preserve unpriced steps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-usage-")), key = randomBytes(32);
  try {
    const sessions = [
      { id: "member-a", provider: "opencode", projectId: "demo", createdAt: "2026-10-18T23:30:00Z", status: "exited", team: { runId: "run-1", memberId: "member-a", taskId: "task-1", role: "implementer", revision: 1 }, teamModelProfile: { id: "profile-a", provider: "opencode" } },
      { id: "member-b", provider: "opencode", projectId: "demo", createdAt: "2026-10-18T23:30:00Z", status: "exited", team: { runId: "run-1", memberId: "member-b", taskId: "task-1", role: "implementer", revision: 1 }, teamModelProfile: { id: "profile-b", provider: "opencode" } },
      { id: "member-c", provider: "opencode", projectId: "demo", createdAt: "2026-10-18T23:30:00Z", status: "exited", team: { runId: "run-2", memberId: "member-c", taskId: "task-2", role: "implementer", revision: 1 }, teamModelProfile: { id: "profile-c", provider: "opencode" } },
      { id: "interactive", provider: "opencode", projectId: "demo", createdAt: "2026-10-18T23:30:00Z", status: "exited", runtime: { nativeUi: "opencode" } },
    ];
    const manager = { list: () => sessions, events: (id: string) => { const record = { ...step(`part-${id}`), modelId: id === "member-b" ? "unlisted" : "deepseek-flash", completedAt: "2026-10-18T23:30:00Z", reportedCost: 0 }; return { events: [{ seq: 1, at: record.completedAt, type: "usage", data: record }], cursor: 1, more: false }; } } as unknown as Manager;
    const usage = new UsageService({ stateDir: dir, usage: { prices: { "deepseek/deepseek-flash": { input: 1000, output: 1000 } }, budgets: {}, accounts: {
      deepseek: { kind: "metered", match: ["deepseek/*"] }, claude: { kind: "subscription", match: ["claude/*"], planUsd: 200 },
    } } } as Config, key, manager);
    usage.useResolvers({ goalOfRun: runId => runId === "run-1" ? { id: "goal-1", title: "Goal" } : undefined, runTitle: runId => runId, projectName: id => id, sessionTitle: id => id });
    await usage.tick(sessions as unknown as UsageSessionRow[]);
    usage.recordBriefing("demo", "session-brief", "2026-10-19T00:00:00Z", { providerId: "deepseek", modelId: "deepseek-flash", tokens: step("brief").tokens });
    assert.equal(usage.project("demo")!.briefings.total.usd, 0.015);
    const local = usage.daily({ days: 2, tz: "Asia/Seoul", now: new Date("2026-10-19T12:00:00Z") });
    assert.deepEqual(local.days.map(day => day.date), ["2026-10-18", "2026-10-19"]);
    assert.deepEqual(local.days.map(day => day.usd), [0, 0.06]);
    const utc = usage.daily({ days: 2, tz: "UTC", now: new Date("2026-10-19T12:00:00Z") });
    assert.deepEqual(utc.days.map(day => day.date), ["2026-10-18", "2026-10-19"]);
    assert.deepEqual(utc.days.map(day => day.usd), [0.045, 0.015]);
    assert.equal(usage.taskUsage("run-1", "task-1")?.attempts, 2);
    assert.equal(usage.taskUsage("run-1", "task-1")?.tokens, 30);
    assert.equal(usage.taskUsage("run-1", "task-1")?.unpriced, 1);
    assert.equal(usage.taskUsage("run-1", "task-1")?.usd, 0.015);
    assert.deepEqual(usage.daily({ days: 3, tz: "UTC", now: new Date("2026-10-19T12:00:00Z") }).days.map(day => day.usd), [0, 0.045, 0.015]);
    const project = usage.project("demo", { tz: "UTC", now: new Date("2026-10-19T12:00:00Z") })!;
    assert.equal(project.total.unpriced, 1);
    assert.equal(project.total.usd, 0.06);
    assert.equal(project.byKind.goals, 0.015);
    assert.equal(project.byKind.teams, 0.015);
    assert.equal(project.byKind.sessions, 0.015);
    assert.equal(project.byKind.briefings, 0.015);
    usage.recordBriefing("demo", "session-brief-unmeasured", "2026-10-19T00:00:00Z", null);
    const withBriefing = usage.project("demo")!;
    assert.deepEqual(withBriefing.briefings, { total: { usd: 0.015, unpriced: 0 }, runs: 2, unmeasured: 1 });
    const summary = usage.summary(new Date("2026-10-19T12:00:00Z"));
    assert.equal(summary.providers.opencode.spent?.cost, 0.06);
    assert.equal(summary.providers.opencode.unmeasuredSessions, 1);
    assert.equal(summary.month.unmeasuredSessions, 1);
    assert.equal(summary.month.plansUsd, 200);
    assert.equal(summary.accounts.find(account => account.id === "deepseek")?.month?.usd, 0.06);
    assert.equal(summary.accounts.find(account => account.id === "deepseek")?.balance, null);
    assert.throws(() => usage.daily({ days: 1, tz: "Not/AZone" }), RangeError);
    assert.throws(() => usage.projects({ tz: "Not/AZone" }), RangeError);
    assert.throws(() => usage.project("missing", { tz: "Not/AZone" }), RangeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
