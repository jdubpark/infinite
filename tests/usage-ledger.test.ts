import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageService, combineCoverage, ledgerCoverage, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import { EvidenceError } from "../packages/host/src/evidence/types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { UsageRecord } from "../packages/host/src/usage.js";
import { teamUsage } from "../packages/host/src/team-usage.js";

// FIXTURE-START
const NOW = new Date("2026-10-21T12:00:00.000Z");
const usageRow = (completedAt: string, modelId: string, providerId: string, partId: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: "opencode", providerId, modelId, messageId: `msg-${partId}`, partId, modelSource: "reported", completedAt,
  tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0, ...extra,
});
function fixtureConfig(stateDir: string): Config {
  return { stateDir, usage: {
    prices: { "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    budgets: { opencode: { usd: 10, period: "week" } },
    accounts: {
      deepseek: { kind: "metered", match: ["deepseek/*"] },
      claude: { kind: "subscription", match: ["claude/*"], planUsd: 200 },
    },
  } } as unknown as Config;
}
function fixtureLedger() {
  const team = { runId: "run-1", memberId: "member-a", taskId: "task-1", role: "implementer", revision: 1 };
  return {
    cursors: { "member-a": 7, local: 1 },
    sessions: {
      "member-a": { provider: "opencode", projectId: "demo", createdAt: "2026-10-20T01:00:00.000Z", lastActiveAt: "2026-10-20T03:00:00.000Z", measured: true, team, profileId: "ds", exited: true },
      local: { provider: "opencode", projectId: "demo", createdAt: "2026-09-30T22:00:00.000Z", lastActiveAt: "2026-09-30T23:30:00.000Z", measured: true, exited: true },
      "claude-a": { provider: "claude", projectId: "demo", createdAt: "2026-10-19T00:00:00.000Z", lastActiveAt: "2026-10-20T00:00:00.000Z", measured: false, exited: true },
      "claude-b": { provider: "claude", projectId: "other", createdAt: "2026-09-10T00:00:00.000Z", lastActiveAt: "2026-09-10T01:00:00.000Z", measured: false, exited: true },
    },
    rows: {
      "member-a/msg-p1/p1": usageRow("2026-10-21T01:00:00.000Z", "deepseek-flash", "deepseek", "p1"),
      "member-a/msg-p2/p2": usageRow("2026-10-20T02:30:00.000Z", "deepseek-v4-pro", "deepseek", "p2"),
      "member-a/msg-p3/p3": usageRow("2026-10-20T04:00:00.000Z", "unlisted", "deepseek", "p3", { reportedCost: 0.0012345678 }),
      "member-a/msg-p4/p4": usageRow("2026-10-20T05:00:00.000Z", "deepseek-flash", "deepseek", "p4", { modelSource: "unknown" }),
      "local/msg-p5/p5": usageRow("2026-09-30T23:00:00.000Z", "deepseek-flash", "deepseek", "p5"),
    },
    briefings: {
      "brief-1/2026-10-21T00:00:00.000Z": { projectId: "demo", at: "2026-10-21T00:00:00.000Z",
        record: usageRow("2026-10-21T00:00:00.000Z", "deepseek-flash", "deepseek", "2026-10-21T00:00:00.000Z", { messageId: "brief-1" }) },
      "brief-2/2026-10-20T00:00:00.000Z": { projectId: "other", at: "2026-10-20T00:00:00.000Z" },
    },
  };
}
// FIXTURE-END

function subset(actual: unknown, expected: unknown, path = "$"): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, `${path} length`);
    expected.forEach((value, index) => subset(actual[index], value, `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", path);
    for (const [key, value] of Object.entries(expected)) subset((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

/** A service over a fixture ledger sealed the way the host wrote it. */
function fixtureService(dir: string, key: Buffer): { usage: UsageService; store: EvidenceStore } {
  writeSealed(join(dir, "usage.sealed"), key, "usage", fixtureLedger());
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  const usage = new UsageService(fixtureConfig(dir), key, {} as Manager, store);
  return { usage, store };
}

test("the store gives the bodies of the sealed ledger it imports", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  try {
    const { usage, store } = fixtureService(dir, key);
    try {
      subset(usage.summary(NOW), {
        period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
        providers: {
          claude: { measured: false, unmeasuredSessions: 1 },
          codex: { measured: false, unmeasuredSessions: 0 },
          grok: { measured: false, unmeasuredSessions: 0 },
          opencode: {
            period: { start: "2026-10-19T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" },
            measured: true, unmeasuredSessions: 1,
            spent: { cost: 0.008535, tokens: { input: 5000, output: 2500, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 5, pricing: { configured: 2, catalog: 1, provider: 1, unknown: 1 } },
            previous: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 0, pricing: { configured: 0, catalog: 0, provider: 0, unknown: 0 } },
            budget: { usd: 10, period: "week" },
          },
          demo: { measured: false, unmeasuredSessions: 0 },
        },
        month: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", spent: { usd: 0.008535, unpriced: 1 }, previous: { usd: 0.002, unpriced: 0 }, plansUsd: 200, unmeasuredSessions: 2 },
        accounts: [
          { id: "deepseek", kind: "metered", month: { usd: 0.008535, unpriced: 1 }, balance: null },
          { id: "claude", kind: "subscription", planUsd: 200, planSource: "config", balance: null },
        ],
      });
      subset(usage.daily({ days: 3, tz: "Asia/Seoul", now: NOW }), {
        tz: "Asia/Seoul", accounts: ["claude", "deepseek"],
        days: [
          { date: "2026-10-19", usd: 0, byAccount: {} },
          { date: "2026-10-20", usd: 0.004535, byAccount: { deepseek: 0.004535 } },
          { date: "2026-10-21", usd: 0.004, byAccount: { deepseek: 0.004 } },
        ],
      });
      subset(usage.projects({ now: NOW }), {
        projects: [
          { id: "demo", name: "demo", total: { usd: 0.010535, unpriced: 1 }, month: { usd: 0.008535, unpriced: 1, unmeasured: 1 }, unmeasured: 1 },
          { id: "other", name: "other", total: { usd: 0, unpriced: 0 }, month: { usd: 0, unpriced: 0, unmeasured: 1 }, unmeasured: 2 },
        ],
      });
      subset(usage.project("demo", { now: NOW }), {
        id: "demo", name: "demo", total: { usd: 0.010535, unpriced: 1 }, unmeasured: 1,
        byKind: { goals: 0, teams: 0.006535, sessions: 0.002, briefings: 0.002 }, goals: [],
        teams: [{ id: "run-1", title: "run-1", total: { usd: 0.006535, unpriced: 1 } }],
        sessions: [{ id: "local", title: "local", total: { usd: 0.002, unpriced: 0 } }],
        briefings: { total: { usd: 0.002, unpriced: 0 }, runs: 1, unmeasured: 0 },
      });
      subset(usage.project("other", { now: NOW }), {
        id: "other", name: "other", total: { usd: 0, unpriced: 0 }, unmeasured: 2,
        byKind: { goals: 0, teams: 0, sessions: 0, briefings: 0 }, goals: [], teams: [], sessions: [],
        briefings: { total: { usd: 0, unpriced: 0 }, runs: 1, unmeasured: 1 },
      });
      subset(usage.taskUsage("run-1", "task-1", 1), { usd: 0.006535, unpriced: 1, tokens: 6000, attempts: 1, profiles: ["ds"] });
      subset(usage.session("member-a"), {
        cost: 0.006535, tokens: { input: 4000, output: 2000, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 4,
        pricing: { configured: 1, catalog: 1, provider: 1, unknown: 1 }, measured: true,
      });
      subset(usage.session("claude-a"), { measured: false });
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the sealed ledger is imported once and never written again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32), file = join(dir, "usage.sealed");
  try {
    writeSealed(file, key, "usage", fixtureLedger());
    const before = readFileSync(file);
    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
    const manager = { events: (_id: string, after: number) => ({ events: [], cursor: after, more: false }) } as unknown as Manager;
    const service = new UsageService(fixtureConfig(dir), key, manager, store);
    const row = { id: "new-session", provider: "opencode", projectId: "demo", createdAt: "2026-10-21T10:00:00.000Z", status: "exited", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow;
    await service.tick([row]);
    service.recordBriefing("demo", "brief-3", "2026-10-21T05:00:00.000Z", null);
    assert.deepEqual(readFileSync(file), before, "the sealed file keeps its bytes");
    const first = JSON.stringify(service.summary(NOW));
    store.close();

    writeSealed(file, key, "usage", { cursors: {}, sessions: {}, rows: {}, briefings: {} });
    const restarted = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
    try {
      const again = new UsageService(fixtureConfig(dir), key, manager, restarted);
      assert.equal(JSON.stringify(again.summary(NOW)), first, "a second service returns the first bodies");
    } finally { restarted.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a page and its cursor commit together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    const pages = [1, 2, 3].map(index => ({ index, record: usageRow(`2026-10-21T0${index}:00:00.000Z`, "deepseek-flash", "deepseek", `j${index}`) }));
    const afters: number[] = [];
    const manager = { events: (_id: string, after: number) => {
      afters.push(after);
      const page = pages.find(item => item.index === after + 1);
      return page ? { events: [{ seq: page.index, at: page.record.completedAt, type: "usage", data: page.record }], cursor: page.index, more: page.index < pages.length } : { events: [], cursor: after, more: false };
    } } as unknown as Manager;
    let writes = 0, armed = false;
    const flaky = { register: (module: Parameters<EvidenceStore["register"]>[0]) => store.register(module), status: () => store.status(),
      read: <T>(fn: Parameters<EvidenceStore["read"]>[0]) => store.read(fn),
      write: <T>(fn: Parameters<EvidenceStore["write"]>[0]) => { if (armed && ++writes === 2) throw new Error("disk full"); return store.write(fn); },
    } as unknown as EvidenceStore;
    const usage = new UsageService(fixtureConfig(dir), key, manager, flaky);
    armed = true;
    const row = { id: "journal", provider: "opencode", projectId: "demo", createdAt: "2026-10-21T10:00:00.000Z", status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow;
    await usage.tick([row]);
    assert.equal(store.read(db => db.get<{ journal_cursor: number }>("SELECT journal_cursor FROM usage_sessions WHERE session_id=?", "journal"))!.journal_cursor, 1);
    assert.equal(store.read(db => db.all("SELECT record_key FROM usage_records")).length, 1, "page 2 stores nothing");
    await usage.tick([row]);
    assert.deepEqual(afters, [0, 1, 1, 2], "the next tick asks for events after the stored cursor");
    assert.equal((usage.session("journal") as { messages: number }).messages, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a tick reads at most 20 pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    const calls: number[] = [];
    const manager = { events: (_id: string, after: number) => {
      calls.push(after);
      const index = after + 1, record = usageRow(`2026-10-21T00:${String(index % 60).padStart(2, "0")}:00.000Z`, "deepseek-flash", "deepseek", `q${index}`);
      return { events: [{ seq: index, at: record.completedAt, type: "usage", data: record }], cursor: index, more: index < 25 };
    } } as unknown as Manager;
    const usage = new UsageService(fixtureConfig(dir), key, manager, store);
    const row = { id: "long", provider: "opencode", projectId: "demo", createdAt: "2026-10-21T10:00:00.000Z", status: "exited", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow;
    await usage.tick([row]);
    assert.equal(calls.length, 20);
    assert.equal(store.read(db => db.get<{ exited: number }>("SELECT exited FROM usage_sessions WHERE session_id=?", "long"))!.exited, 0, "the session stays open");
    await usage.tick([row]);
    assert.equal(calls.length, 25);
    assert.equal(store.read(db => db.get<{ exited: number }>("SELECT exited FROM usage_sessions WHERE session_id=?", "long"))!.exited, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an unavailable store never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "a regular file, not a folder");
  const warn = console.warn, warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const store = new EvidenceStore({ databasePath: join(blocker, "evidence.sqlite3"), vaultKey: key });
    const usage = new UsageService(fixtureConfig(dir), key, { list: () => { throw new Error("no listing without a store"); } } as unknown as Manager, store);
    assert.equal(usage.available(), false);
    await usage.tick([]);
    assert.deepEqual(usage.session("x"), { measured: false, coverage: "none", unavailable: true });
    assert.throws(() => usage.summary(), (error: unknown) => error instanceof EvidenceError && error.code === "unavailable");
    const before = warnings.length;
    usage.recordBriefing("demo", "brief", "2026-10-21T05:00:00.000Z", null);
    assert.equal(warnings.length - before, 1, "a lost briefing warns once");
  } finally { console.warn = warn; rmSync(dir, { recursive: true, force: true }); }
});

test("a new service resumes from the stored cursors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const journal = (calls: number[]) => ({ events: (_id: string, after: number) => {
    calls.push(after);
    if (after >= 3) return { events: [], cursor: after, more: false };
    const index = after + 1, record = usageRow(`2026-10-21T0${index}:00:00.000Z`, "deepseek-flash", "deepseek", `r${index}`);
    return { events: [{ seq: index, at: record.completedAt, type: "usage", data: record }], cursor: index, more: index < 3 };
  } }) as unknown as Manager;
  const row = { id: "resume", provider: "opencode", projectId: "demo", createdAt: "2026-10-21T10:00:00.000Z", status: "running", runtime: { nativeUi: "opencode" } } as unknown as UsageSessionRow;
  try {
    const first = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
    const firstCalls: number[] = [];
    const usage = new UsageService(fixtureConfig(dir), key, journal(firstCalls), first);
    await usage.tick([row]);
    first.close();
    await usage.tick([row]);
    const second = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
    try {
      const calls: number[] = [];
      const resumed = new UsageService(fixtureConfig(dir), key, journal(calls), second);
      await resumed.tick([row]);
      assert.deepEqual(calls, [3], "the resumed service asks only for events after the stored cursor");
      assert.equal((resumed.session("resume") as { messages: number }).messages, 3, "no total doubles");
    } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Task 4: Claude Code, Codex, and coverage in every roll-up

type JournalEvent = { type: string; data: unknown };
/** A manager whose journals are arrays of events; the cursor is the position of the last event read. */
function journalManager(journals: Record<string, JournalEvent[]>, reads: string[] = []): Manager {
  return { events: (id: string, after: number, limit: number, types?: Set<string>) => {
    reads.push(`${id}:${after}`);
    const rest = (journals[id] ?? []).slice(after), batch = rest.slice(0, limit);
    return {
      events: batch.flatMap((event, index) => !types || types.has(event.type) ? [{ seq: after + index + 1, at: NOW.toISOString(), type: event.type, data: event.data }] : []),
      cursor: after + batch.length,
      more: rest.length > limit,
    };
  } } as unknown as Manager;
}
const claudeUsage = (messageId: string, extra: Record<string, unknown> = {}): JournalEvent => ({ type: "usage", data: {
  provider: "claude", providerId: "claude", modelId: "model-a", messageId, partId: "", modelSource: "reported",
  completedAt: "2026-10-21T01:00:00.000Z", tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 1000, cacheWrite: 0 }, reportedCost: 0, ...extra } });
const coverageEvent = (data: Record<string, unknown>): JournalEvent => ({ type: "usage-coverage", data });
const claudeRow = (id: string, status: "running" | "exited", extra: Record<string, unknown> = {}) =>
  ({ id, provider: "claude", projectId: "demo", createdAt: "2026-10-21T10:00:00.000Z", status, ...extra }) as unknown as UsageSessionRow;
function journalService(dir: string, key: Buffer, journals: Record<string, JournalEvent[]>, config: Config = fixtureConfig(dir), reads?: string[]) {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  return { usage: new UsageService(config, key, journalManager(journals, reads), store), store };
}
const rawSession = (store: EvidenceStore, id: string) => store.read(db => db.get<{ exited: number; journaled_coverage: string | null; final_drain: string | null }>(
  "SELECT exited, journaled_coverage, final_drain FROM usage_sessions WHERE session_id=?", id))!;

test("ledger coverage follows the rule table", async t => {
  const open = { provider: "claude" as const, measuredLaunch: false, closed: false, valid: 1, refused: 0 };
  await t.test("row 1: a measured OpenCode launch is complete, and a refused row makes it partial", () => {
    assert.deepEqual(ledgerCoverage({ provider: "opencode", measuredLaunch: true, closed: false, valid: 1, refused: 0 }), { coverage: "complete" });
    assert.deepEqual(ledgerCoverage({ provider: "opencode", measuredLaunch: true, closed: false, valid: 1, refused: 1 }), { coverage: "partial", reason: "row-dropped" });
  });
  await t.test("row 2: any other OpenCode session and Grok are unsupported", () => {
    assert.deepEqual(ledgerCoverage({ provider: "opencode", measuredLaunch: false, closed: true, valid: 1, refused: 0 }), { coverage: "none", reason: "unsupported" });
    assert.deepEqual(ledgerCoverage({ provider: "grok", measuredLaunch: true, closed: true, valid: 1, refused: 0 }), { coverage: "none", reason: "unsupported" });
  });
  await t.test("row 3: a journaled record decides, and complete with a refused record is partial", () => {
    assert.deepEqual(ledgerCoverage({ ...open, journaled: { coverage: "complete" } }), { coverage: "complete" });
    assert.deepEqual(ledgerCoverage({ ...open, journaled: { coverage: "complete" }, refused: 1 }), { coverage: "partial", reason: "row-dropped" });
    assert.deepEqual(ledgerCoverage({ ...open, journaled: { coverage: "partial", reason: "stopped-mid-turn" } }), { coverage: "partial", reason: "stopped-mid-turn" });
  });
  await t.test("row 4: an open session is running, partial with records and none without", () => {
    assert.deepEqual(ledgerCoverage(open), { coverage: "partial", reason: "running" });
    assert.deepEqual(ledgerCoverage({ ...open, valid: 0 }), { coverage: "none", reason: "running" });
  });
  await t.test("row 5: a closed session without a coverage record is drain-incomplete or unsupported", () => {
    assert.deepEqual(ledgerCoverage({ ...open, closed: true }), { coverage: "partial", reason: "drain-incomplete" });
    assert.deepEqual(ledgerCoverage({ ...open, closed: true, valid: 0 }), { coverage: "none", reason: "unsupported" });
  });
});

test("a Claude session is measured from its journal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, { "c-measured": [claudeUsage("m1"), claudeUsage("m2"), coverageEvent({ coverage: "complete" })] });
  try {
    await usage.tick([claudeRow("c-measured", "exited")]);
    subset(usage.session("c-measured"), {
      measured: true, coverage: "complete", messages: 2, cost: 0,
      tokens: { input: 200, output: 40, reasoning: 0, cacheRead: 2000, cacheWrite: 0 },
      pricing: { configured: 0, catalog: 0, provider: 0, unknown: 2 },
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a configured price does not price a Claude or Codex record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const config = { stateDir: dir, usage: { prices: { "claude/model-a": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, budgets: {}, accounts: {} } } as unknown as Config;
  const { usage, store } = journalService(dir, key, { "c-priced": [claudeUsage("p1"), coverageEvent({ coverage: "complete" })] }, config);
  try {
    await usage.tick([claudeRow("c-priced", "exited")]);
    subset(usage.session("c-priced"), { cost: 0, pricing: { unknown: 1 } });
    subset(usage.summary(NOW).month.spent, { usd: 0, unpriced: 1 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a replay adds nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, {
    A: [claudeUsage("m1"), claudeUsage("m2"), claudeUsage("m1"), claudeUsage("m2"), coverageEvent({ coverage: "complete" })],
    B: [claudeUsage("m1"), claudeUsage("m2"), coverageEvent({ coverage: "complete" })],
  });
  try {
    await usage.tick([claudeRow("A", "exited"), claudeRow("B", "exited")]);
    subset(usage.summary(NOW).providers.claude, { recorded: { messages: 2 } });
    subset(usage.session("A"), { measured: true, messages: 2 });
    subset(usage.session("B"), { measured: true, coverage: "complete", messages: 0 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a session from before the upgrade is read again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  try {
    writeSealed(join(dir, "usage.sealed"), key, "usage", fixtureLedger());
    const { usage, store } = journalService(dir, key, { "claude-a": [claudeUsage("old-1"), coverageEvent({ coverage: "complete" })] });
    try {
      await usage.tick([claudeRow("claude-a", "exited", { createdAt: "2026-10-19T00:00:00.000Z" })]);
      subset(usage.session("claude-a"), { measured: true, coverage: "complete", messages: 1 });
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("partial sessions are counted beside unmeasured ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, {
    "c-complete": [claudeUsage("p1"), coverageEvent({ coverage: "complete" })],
    "c-partial": [claudeUsage("p2"), coverageEvent({ coverage: "partial", reason: "stopped-mid-turn" })],
    "c-running": [claudeUsage("p3")],
    "c-none": [coverageEvent({ coverage: "none", reason: "hooks-off" })],
  });
  try {
    await usage.tick([claudeRow("c-complete", "exited"), claudeRow("c-partial", "exited"), claudeRow("c-running", "running"), claudeRow("c-none", "exited")]);
    const summary = usage.summary(NOW);
    subset(summary.providers.claude, { unmeasuredSessions: 1, partialSessions: 1 });
    subset(summary.month, { partialSessions: 1 });
    subset(usage.project("demo", { now: NOW }), { partial: 1 });
    subset(usage.projects({ now: NOW }), { projects: [{ id: "demo", partial: 1, month: { partial: 1 } }] });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a refused record makes a complete session partial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, { refused: [
    claudeUsage("r1"), claudeUsage("r2", { tokens: { input: 100, output: "7", reasoning: 0, cacheRead: 0, cacheWrite: 0 } }), coverageEvent({ coverage: "complete" }),
  ] });
  try {
    await usage.tick([claudeRow("refused", "exited")]);
    subset(usage.session("refused"), { measured: true, coverage: "partial", coverageReason: "row-dropped", messages: 1 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("aggregate coverage takes the first lasting gap", () => {
  assert.deepEqual(combineCoverage([{ coverage: "complete" }, { coverage: "complete" }]), { coverage: "complete" });
  assert.deepEqual(combineCoverage([{ coverage: "complete" }, { coverage: "partial", coverageReason: "running" }]), { coverage: "partial", reason: "running" });
  assert.deepEqual(combineCoverage([
    { coverage: "partial", coverageReason: "running" }, { coverage: "partial", coverageReason: "drain-incomplete" }, { coverage: "partial", coverageReason: "stopped-mid-turn" },
  ]), { coverage: "partial", reason: "drain-incomplete" });
  assert.equal(combineCoverage([{ coverage: "none", coverageReason: "unsupported" }]).coverage, "none");
});

test("task usage carries coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const team = { runId: "run-x", memberId: "m1", taskId: "task-x", role: "implementer", revision: 1 };
  const { usage, store } = journalService(dir, key, {
    "t-complete": [claudeUsage("t1"), coverageEvent({ coverage: "complete" })],
    "t-partial": [claudeUsage("t2"), coverageEvent({ coverage: "partial", reason: "drain-incomplete" })],
  });
  try {
    await usage.tick([
      claudeRow("t-complete", "exited", { team, createdAt: "2026-10-21T08:00:00.000Z" }),
      claudeRow("t-partial", "exited", { team: { ...team, memberId: "m2" }, createdAt: "2026-10-21T09:00:00.000Z" }),
    ]);
    subset(usage.taskUsage("run-x", "task-x", 1), { coverage: "partial", coverageReason: "drain-incomplete", attempts: 2 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("usage after the exit record is still read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const journals: Record<string, JournalEvent[]> = {
    late: [claudeUsage("l1")],
    early: [claudeUsage("e1"), coverageEvent({ coverage: "partial", reason: "stopped-mid-turn" })],
  };
  const reads: string[] = [];
  const { usage, store } = journalService(dir, key, journals, fixtureConfig(dir), reads);
  try {
    await usage.tick([claudeRow("late", "exited"), claudeRow("early", "running")]);
    subset(usage.session("late"), { measured: true, coverage: "partial", coverageReason: "running", messages: 1 });
    assert.equal(rawSession(store, "late").exited, 0, "the exit record does not close a session whose journal may still grow");
    subset(usage.session("early"), { coverage: "partial", coverageReason: "stopped-mid-turn" });
    assert.equal(rawSession(store, "early").exited, 0);

    journals.late.push(claudeUsage("l2"), coverageEvent({ coverage: "complete" }));
    journals.early.push(claudeUsage("e2"));
    await usage.tick([claudeRow("late", "exited"), claudeRow("early", "exited")]);
    subset(usage.session("late"), { coverage: "complete", messages: 2 });
    assert.equal(rawSession(store, "late").exited, 1, "the journaled record closes the session");
    assert.equal(rawSession(store, "early").exited, 1, "the session closes on the first tick that lists it exited");

    const before = reads.filter(read => read.startsWith("late:")).length;
    await usage.tick([claudeRow("late", "exited")]);
    assert.equal(reads.filter(read => read.startsWith("late:")).length, before, "a closed session is not read again");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an exited session without a coverage record closes after 60 seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, { "timer-usage": [claudeUsage("t1")], "timer-none": [] });
  const rows = [claudeRow("timer-usage", "exited"), claudeRow("timer-none", "exited")];
  const start = Date.parse("2026-10-21T12:00:00.000Z");
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    await usage.tick(rows);
    subset(usage.session("timer-usage"), { coverage: "partial", coverageReason: "running" });
    subset(usage.session("timer-none"), { measured: false, coverage: "none", coverageReason: "running" });

    mock.timers.setTime(start + 59_000);
    await usage.tick(rows);
    assert.equal(rawSession(store, "timer-usage").exited, 0, "still open at 59 seconds");
    subset(usage.session("timer-usage"), { coverage: "partial", coverageReason: "running" });

    mock.timers.setTime(start + 60_000);
    await usage.tick(rows);
    assert.equal(rawSession(store, "timer-usage").exited, 1);
    subset(usage.session("timer-usage"), { coverage: "partial", coverageReason: "drain-incomplete" });
    subset(usage.session("timer-none"), { measured: false, coverage: "none", coverageReason: "unsupported" });
  } finally { mock.timers.reset(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a coverage record is kept as the worker wrote it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, {
    "drain-skipped": [claudeUsage("d1"), coverageEvent({ coverage: "partial", reason: "drain-skipped", finalDrain: "skipped", extra: 1 })],
    "drain-maybe": [claudeUsage("d2"), coverageEvent({ coverage: "complete", finalDrain: "maybe" })],
    "bad-reason": [claudeUsage("d3"), coverageEvent({ coverage: "partial", reason: "Not A Reason!" })],
    "bad-coverage": [coverageEvent({ coverage: "full" })],
    "complete-reason": [coverageEvent({ coverage: "complete", reason: "row-dropped" })],
  });
  try {
    await usage.tick(["drain-skipped", "drain-maybe", "bad-reason", "bad-coverage", "complete-reason"].map(id => claudeRow(id, "exited")));
    subset(usage.session("drain-skipped"), { measured: true, coverage: "partial", coverageReason: "drain-skipped" });
    assert.equal(rawSession(store, "drain-skipped").final_drain, "skipped");
    assert.equal(rawSession(store, "drain-maybe").final_drain, null, "an unknown final drain is stored as null");
    for (const id of ["bad-reason", "bad-coverage", "complete-reason"]) assert.equal(rawSession(store, id).journaled_coverage, null, `${id} is ignored`);
    subset(usage.summary(NOW).providers.claude, { partialSessions: 1 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

const teamOf = (runId: string, memberId: string) => ({ runId, memberId, taskId: "task-m", role: "implementer", revision: 1 });
const memberRow = (id: string, status: "running" | "exited", team?: ReturnType<typeof teamOf>, extra: Record<string, unknown> = {}) =>
  claudeRow(id, status, { ...(team ? { team } : {}), ...extra });

test("a member sums every session it ran", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, {
    "m-1": [claudeUsage("a1"), coverageEvent({ coverage: "complete" })],
    "m-2": [claudeUsage("a2"), coverageEvent({ coverage: "complete" })],
    "m-3": [claudeUsage("a3"), coverageEvent({ coverage: "complete" })],
  });
  try {
    await usage.tick(["m-1", "m-2", "m-3"].map(id => memberRow(id, "exited", teamOf("run-m", "member-m"))));
    subset(usage.member("run-m", "member-m"), { measured: true, coverage: "complete", messages: 3 });
    const team = teamUsage([{ sessionId: "m-3", runId: "run-m", memberId: "member-m" }], "claude", usage);
    assert.equal(team.members[0].usage?.messages, 3);
    assert.equal(team.rollup.total.messages, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("member coverage is the worst of its sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, {
    "a-open": [claudeUsage("ao")],
    "a-done": [claudeUsage("ad"), coverageEvent({ coverage: "complete" })],
    "b-done": [claudeUsage("bd"), coverageEvent({ coverage: "complete" })],
    "b-stop": [claudeUsage("bs"), coverageEvent({ coverage: "partial", reason: "stopped-mid-turn" })],
    "c-none": [coverageEvent({ coverage: "none", reason: "unsupported" })],
  });
  try {
    await usage.tick([
      memberRow("a-open", "running", teamOf("run-a", "m")), memberRow("a-done", "exited", teamOf("run-a", "m")),
      memberRow("b-done", "exited", teamOf("run-b", "m")), memberRow("b-stop", "exited", teamOf("run-b", "m")),
      memberRow("c-none", "exited", teamOf("run-c", "m")),
    ]);
    subset(usage.member("run-a", "m"), { measured: true, coverage: "partial", coverageReason: "running", messages: 2 });
    subset(usage.member("run-b", "m"), { measured: true, coverage: "partial", coverageReason: "stopped-mid-turn", messages: 2 });
    assert.deepEqual(usage.member("run-c", "m"), { measured: false, coverage: "none" });
    assert.deepEqual(usage.member("run-x", "m"), { measured: false, coverage: "none" }, "a member with no session is unmeasured");
    const rollup = teamUsage([
      { sessionId: "a-done", runId: "run-a", memberId: "m" }, { sessionId: "b-stop", runId: "run-b", memberId: "m" },
      { sessionId: "c-none", runId: "run-c", memberId: "m" },
    ], "claude", usage).rollup;
    assert.equal(rollup.partialMembers, 1, "a running gap is not counted, a stopped one is");
    assert.equal(rollup.unmeasuredMembers, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an unavailable ledger marks the rollup", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "a regular file, not a folder");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const store = new EvidenceStore({ databasePath: join(blocker, "evidence.sqlite3"), vaultKey: key });
    const usage = new UsageService(fixtureConfig(dir), key, {} as Manager, store);
    const team = teamUsage([{ sessionId: "x", runId: "run-u", memberId: "m" }, { sessionId: "y" }], "claude", usage);
    assert.equal(team.rollup.unavailable, true);
    assert.equal(team.rollup.unmeasuredMembers, 2);
    assert.equal(team.rollup.total.messages, 0);
    assert.ok(team.members.every(member => !("usage" in member)));
    store.close();
  } finally { console.warn = warn; rmSync(dir, { recursive: true, force: true }); }
});

test("a mission attempt reads its own session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const { usage, store } = journalService(dir, key, {
    "mission-1": [claudeUsage("q1"), coverageEvent({ coverage: "complete" })],
  });
  try {
    await usage.tick([claudeRow("mission-1", "exited")]);
    const team = teamUsage([{ sessionId: "mission-1" }], "claude", usage);
    subset(team.members[0].usage, { messages: 1, coverage: "complete", tokens: { input: 100 } });
    subset(usage.session("mission-1"), { messages: 1 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("project usage reports spend by purpose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-ledger-")), key = randomBytes(32);
  const opencodeUsage = (messageId: string): JournalEvent => ({ type: "usage", data: {
    provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId, partId: messageId, modelSource: "reported",
    completedAt: "2026-10-21T01:00:00.000Z", tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0 } });
  const openRow = (id: string, extra: Record<string, unknown>) => ({ id, provider: "opencode", projectId: "demo", createdAt: "2026-10-21T10:00:00.000Z",
    status: "exited", teamModelProfile: { id: "ds", provider: "opencode" }, ...extra }) as unknown as UsageSessionRow;
  const { usage, store } = journalService(dir, key, {
    "p-plain": [opencodeUsage("p1")], "p-gate": [opencodeUsage("p2")], "p-solo": [opencodeUsage("p3")],
  });
  try {
    await usage.tick([
      openRow("p-plain", { team: teamOf("run-p", "member-p") }),
      openRow("p-gate", { team: teamOf("run-g", "member-g"), purpose: "gate" }),
      openRow("p-solo", { runtime: { nativeUi: "opencode" } }),
    ]);
    const detail = usage.project("demo", { now: NOW });
    subset(detail, {
      total: { usd: 0.006, unpriced: 0 },
      byPurpose: {
        work: { total: { usd: 0.002, unpriced: 0 }, members: 1 },
        gate: { total: { usd: 0.002, unpriced: 0 }, members: 1 },
        duel: { total: { usd: 0, unpriced: 0 }, members: 0 },
        replay: { total: { usd: 0, unpriced: 0 }, members: 0 },
      },
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
