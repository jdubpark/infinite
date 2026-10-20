import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, waitFor } from "./helpers.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { fixture, mixedLineup } from "./team-fixture.js";
import { UsageService, type UsageSessionRow, type UsageSummary } from "../packages/host/src/usage-service.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

const step = (partId: string): UsageRecord => ({ provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m1", partId, modelSource: "reported",
  completedAt: new Date().toISOString(), tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4 }, reportedCost: 0.01 });

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
  const run = await fixture("usage", lineup, { usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, budgets: { opencode: { usd: 10, period: "month" } } } });
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
    assert.equal(taskUsage.attempts, team.members.filter(member => member.taskId === deepseekMember.taskId && member.revision === deepseekMember.revision).length);
    assert.equal(taskUsage.usd, 0.002);
    const model = (await run.host.fetchApi("/usage/models")).body.rows.find((row: any) => row.profileId === "deepseek-high");
    assert.equal(model.medianTokens, 1504);
    assert.equal(model.usdPerMTok, model.medianUsd / 1504 * 1_000_000);
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

test("team task usage follows the task's revision while run and project totals retain prior spend", { timeout: 120000 }, async () => {
  const lineup = structuredClone(mixedLineup);
  lineup.implementers = [
    lineup.implementers[0],
    { id: "deepseek-high", label: "DeepSeek implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light", dataUse: "contributor" },
  ];
  const run = await fixture("usage", lineup, { usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, budgets: {} } });
  try {
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    const first = await run.settled(created.body.id);
    assert.ok(first.tasks.every((task: any) => task.revision === 1 && task.reviewRounds === 0), "New tasks carry their creating revision and zero first-pass reviews");
    const steered = await run.host.fetchApi(`/teams/${first.id}/steer`, "owner", { requestId: randomUUID(), revision: first.revision, text: "Replan the same task IDs under the updated request." });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    const second = await run.settled(first.id);
    assert.equal(second.revision, 2);
    for (const task of second.tasks) {
      const assigned = second.members.filter(member => member.taskId === task.id && member.revision === task.revision);
      assert.equal(task.revision, 2);
      assert.equal(task.usage?.attempts, assigned.length);
      assert.equal(task.usage?.usd, assigned.reduce((sum, member) => sum + (member.usage?.cost ?? 0), 0));
    }
    assert.ok(second.usage.total.cost > first.usage.total.cost, "Run totals retain the earlier revision's spend");
    const project = (await run.host.fetchApi("/usage/projects/rehearsal")).body;
    assert.equal(project.total.usd, second.usage.total.cost, "Project totals retain spend from both revisions");
    await run.host.stopApi();
    const file = join(run.host.config.stateDir, "teams", `${second.id}.sealed`);
    const key = readFileSync(run.host.config.keyFile);
    const stored = unseal<any>(key, `team:${second.id}`, readFileSync(file, "utf8"));
    for (const task of stored.run.tasks) delete task.revision; // Simulate a record written before task revisions were persisted.
    writeSealed(file, key, `team:${second.id}`, stored);
    await run.host.start();
    const restored = (await run.host.fetchApi(`/teams/${second.id}`)).body;
    assert.ok(restored.tasks.every((task: any) => task.revision === second.revision && task.usage?.attempts === 1), "Legacy tasks inherit the retained run revision and keep matching usage");
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

test("task usage separates same-id tasks by revision and preserves historical project spend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-usage-")), key = randomBytes(32);
  try {
    const sessions = [
      { id: "revision-one", provider: "opencode", projectId: "demo", createdAt: "2026-10-18T00:00:00Z", status: "exited", team: { runId: "run-1", memberId: "member-one", taskId: "edit", role: "implementer", revision: 1 }, teamModelProfile: { id: "profile", provider: "opencode" } },
      { id: "revision-two", provider: "opencode", projectId: "demo", createdAt: "2026-10-19T00:00:00Z", status: "exited", team: { runId: "run-1", memberId: "member-two", taskId: "edit", role: "implementer", revision: 2 }, teamModelProfile: { id: "profile", provider: "opencode" } },
    ];
    const records = new Map([["revision-one", { ...step("one"), modelId: "unlisted-model", reportedCost: 1 }], ["revision-two", { ...step("two"), modelId: "unlisted-model", reportedCost: 2 }]]);
    const manager = { list: () => sessions, events: (id: string) => { const record = records.get(id)!; return { events: [{ seq: 1, at: record.completedAt, type: "usage", data: record }], cursor: 1, more: false }; } } as unknown as Manager;
    const usage = new UsageService({ stateDir: dir, usage: { prices: {}, budgets: {} } } as Config, key, manager);
    await usage.tick(sessions as unknown as UsageSessionRow[]);
    assert.deepEqual(usage.taskUsage("run-1", "edit", 2), { usd: 2, unpriced: 0, tokens: 24, attempts: 1, profiles: ["profile"] });
    assert.deepEqual(usage.taskUsage("run-1", "edit", 1), { usd: 1, unpriced: 0, tokens: 24, attempts: 1, profiles: ["profile"] });
    assert.equal(usage.project("demo")!.total.usd, 3, "Project totals preserve spend across revisions");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projects disclose unmeasured sessions and briefings, including month counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-usage-")), key = randomBytes(32);
  try {
    const sessions = [{ id: "unmeasured", provider: "claude", projectId: "all-unmeasured", createdAt: "2026-10-19T00:00:00Z", status: "exited" }];
    const manager = { list: () => sessions, events: () => ({ events: [], cursor: 0, more: false }) } as unknown as Manager;
    const usage = new UsageService({ stateDir: dir, usage: { prices: {}, budgets: {} } } as Config, key, manager);
    await usage.tick(sessions as unknown as UsageSessionRow[]);
    usage.recordBriefing("all-unmeasured", "briefing", "2026-10-19T01:00:00Z", null);
    assert.deepEqual(usage.project("all-unmeasured", { now: new Date("2026-10-19T12:00:00Z") })!.total, { usd: 0, unpriced: 0 });
    assert.equal(usage.project("all-unmeasured", { now: new Date("2026-10-19T12:00:00Z") })!.unmeasured, 2);
    const listing = usage.projects({ now: new Date("2026-10-19T12:00:00Z") }).projects[0];
    assert.equal(listing.unmeasured, 2);
    assert.equal(listing.month.unmeasured, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    assert.equal(usage.project("demo")!.briefings.total.usd, 0.024);
    const local = usage.daily({ days: 2, tz: "Asia/Seoul", now: new Date("2026-10-19T12:00:00Z") });
    assert.deepEqual(local.days.map(day => day.date), ["2026-10-18", "2026-10-19"]);
    assert.deepEqual(local.days.map(day => day.usd), [0, 0.096]);
    const utc = usage.daily({ days: 2, tz: "UTC", now: new Date("2026-10-19T12:00:00Z") });
    assert.deepEqual(utc.days.map(day => day.date), ["2026-10-18", "2026-10-19"]);
    assert.deepEqual(utc.days.map(day => day.usd), [0.072, 0.024]);
    assert.equal(usage.taskUsage("run-1", "task-1", 1)?.attempts, 2);
    assert.equal(usage.taskUsage("run-1", "task-1", 1)?.tokens, 48);
    assert.equal(usage.taskUsage("run-1", "task-1", 1)?.unpriced, 1);
    assert.equal(usage.taskUsage("run-1", "task-1", 1)?.usd, 0.024);
    assert.deepEqual(usage.daily({ days: 3, tz: "UTC", now: new Date("2026-10-19T12:00:00Z") }).days.map(day => day.usd), [0, 0.072, 0.024]);
    const project = usage.project("demo", { tz: "UTC", now: new Date("2026-10-19T12:00:00Z") })!;
    assert.equal(project.total.unpriced, 1);
    assert.equal(project.total.usd, 0.096);
    assert.equal(project.byKind.goals, 0.024);
    assert.equal(project.byKind.teams, 0.024);
    assert.equal(project.byKind.sessions, 0.024);
    assert.equal(project.byKind.briefings, 0.024);
    usage.recordBriefing("demo", "session-brief-unmeasured", "2026-10-19T00:00:00Z", null);
    const withBriefing = usage.project("demo")!;
    assert.deepEqual(withBriefing.briefings, { total: { usd: 0.024, unpriced: 0 }, runs: 2, unmeasured: 1 });
    const summary = usage.summary(new Date("2026-10-19T12:00:00Z"));
    assert.equal(summary.providers.opencode.spent?.cost, 0.096);
    assert.equal(summary.providers.opencode.unmeasuredSessions, 1);
    assert.equal(summary.month.unmeasuredSessions, 1);
    assert.equal(summary.month.plansUsd, 200);
    assert.equal(summary.accounts.find(account => account.id === "deepseek")?.month?.usd, 0.096);
    assert.equal(summary.accounts.find(account => account.id === "deepseek")?.balance, null);
    assert.throws(() => usage.daily({ days: 1, tz: "Not/AZone" }), RangeError);
    assert.throws(() => usage.projects({ tz: "Not/AZone" }), RangeError);
    assert.throws(() => usage.project("missing", { tz: "Not/AZone" }), RangeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
