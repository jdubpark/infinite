import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { UsageRecord, UsageTokens } from "../packages/host/src/usage.js";
import {
  importLedger, importState, ledgerRecord, readBriefings, readRecords, readSessions, usageModule, writeBriefing,
  writeRecord, writeSession, type LedgerHeader, type LedgerState, type SealedLedger,
} from "../packages/host/src/usage-store.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-usage-store-"));
  return { root, path: evidenceDatabasePath(join(root, "state")), key: randomBytes(32), close: () => rmSync(root, { recursive: true, force: true }) };
}

function open(f: Fixture): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(usageModule);
  return store;
}

const TOKENS: UsageTokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
const tokens = (values: Partial<UsageTokens>): UsageTokens => ({ ...TOKENS, ...values });
const AT = "2026-10-21T10:00:00Z";

function claude(messageId: string, values: Partial<UsageTokens> = {}, extra: Partial<UsageRecord> = {}): UsageRecord {
  return { provider: "claude", providerId: "claude", modelId: "model-a", messageId, partId: "", modelSource: "reported", completedAt: AT, tokens: tokens(values), reportedCost: 0, ...extra };
}

function opencode(messageId: string, partId: string, values: Partial<UsageTokens> = {}): UsageRecord {
  return { provider: "opencode", providerId: "deepseek", modelId: "flash", messageId, partId, modelSource: "requested", completedAt: AT, tokens: tokens(values), reportedCost: 0.5 };
}

function header(sessionId: string, extra: Partial<LedgerHeader> = {}): LedgerHeader {
  return { sessionId, provider: "claude", projectId: "project-marker", createdAt: AT, ...extra };
}

const LIVE: LedgerState = { coverage: "partial", reason: "running", cursor: 0, seen: 0, refused: 0, exited: false };

function rows(store: EvidenceStore, table: string): string {
  return store.read(db => JSON.stringify(db.all(`SELECT * FROM ${table} ORDER BY 1`)));
}

test("the usage module creates its tables once", () => {
  const f = fixture();
  let store = open(f);
  try {
    assert.equal(store.status().modules.usage, "ready");
    const tables = store.read(db => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage_%' ORDER BY name")
      .map(row => row.name));
    assert.deepEqual(tables, ["usage_briefings", "usage_meta", "usage_models", "usage_projects", "usage_records", "usage_sessions"]);
    const counts = store.describe().counts;
    assert.equal(counts["usage.sessions"], 0);
    assert.equal(counts["usage.records"], 0);
    assert.equal(counts["usage.briefings"], 0);
    store.close();
    store = open(f);
    assert.equal(store.status().modules.usage, "ready");
  } finally {
    store.close();
    f.close();
  }
});

test("a Claude or Codex key belongs to its first session", () => {
  const f = fixture();
  const store = open(f);
  try {
    for (const provider of ["claude", "codex"] as const) {
      store.write(tx => {
        assert.equal(writeSession(tx, header("session-a", { provider }), LIVE), true);
        assert.equal(writeSession(tx, header("session-b", { provider }), LIVE), true);
      });
      const first = store.write(tx => writeRecord(tx, "session-a", { ...claude("shared-message"), provider }));
      const second = store.write(tx => writeRecord(tx, "session-b", { ...claude("shared-message"), provider }));
      assert.equal(first, "inserted");
      assert.equal(second, "kept");
      const stored = store.read(db => db.all<{ session_id: string }>("SELECT session_id FROM usage_records WHERE provider=?", provider));
      assert.deepEqual(stored.map(row => row.session_id), ["session-a"]);
      store.write(tx => tx.exec("DELETE FROM usage_records; DELETE FROM usage_sessions;"));
    }
  } finally {
    store.close();
    f.close();
  }
});

test("the larger whole record wins", () => {
  const f = fixture();
  const store = open(f);
  try {
    store.write(tx => writeSession(tx, header("session-a"), LIVE));
    const write = (record: UsageRecord) => store.write(tx => writeRecord(tx, "session-a", record));
    assert.equal(write(claude("m1", { input: 100 })), "inserted");
    assert.equal(write(claude("m1", { input: 90 })), "kept");
    assert.equal(write(claude("m1", { input: 60, reasoning: 40 })), "replaced");
    const afterReasoning = store.read(db => db.get<Record<string, number>>("SELECT input, reasoning, cache_write_1h, session_id FROM usage_records"));
    assert.deepEqual({ ...afterReasoning }, { input: 60, reasoning: 40, cache_write_1h: 0, session_id: "session-a" });
    assert.equal(write(claude("m1", { input: 50, reasoning: 40, cacheWrite: 10 }, { cacheWrite1h: 10 })), "replaced");
    const afterCache = store.read(db => db.get<Record<string, number | string>>(
      "SELECT input, output, reasoning, cache_read, cache_write, cache_write_1h, session_id FROM usage_records"));
    assert.deepEqual({ ...afterCache }, { input: 50, output: 0, reasoning: 40, cache_read: 0, cache_write: 10, cache_write_1h: 10, session_id: "session-a" });
    assert.equal(write(claude("m1", { input: 50, reasoning: 40, cacheWrite: 10 }, { cacheWrite1h: 10 })), "kept");
  } finally {
    store.close();
    f.close();
  }
});

test("a larger copy from another session keeps the first session", () => {
  const f = fixture();
  const store = open(f);
  try {
    for (const provider of ["claude", "codex"] as const) {
      store.write(tx => {
        writeSession(tx, header("session-a", { provider }), LIVE);
        writeSession(tx, header("session-b", { provider }), LIVE);
      });
      assert.equal(store.write(tx => writeRecord(tx, "session-a", { ...claude("m1", { input: 100 }), provider })), "inserted");
      assert.equal(store.write(tx => writeRecord(tx, "session-b", { ...claude("m1", { input: 150 }), provider })), "replaced");
      const rowsFor = store.read(db => db.all<{ session_id: string; input: number }>("SELECT session_id, input FROM usage_records WHERE provider=?", provider));
      assert.deepEqual(rowsFor.map(row => ({ ...row })), [{ session_id: "session-a", input: 150 }]);
      store.write(tx => tx.exec("DELETE FROM usage_records; DELETE FROM usage_sessions;"));
    }
  } finally {
    store.close();
    f.close();
  }
});

test("an OpenCode key is scoped to its session and its last copy wins", () => {
  const f = fixture();
  const store = open(f);
  try {
    store.write(tx => {
      writeSession(tx, header("session-a", { provider: "opencode" }), LIVE);
      writeSession(tx, header("session-b", { provider: "opencode" }), LIVE);
    });
    store.write(tx => writeRecord(tx, "session-a", opencode("msg-1", "part-1", { input: 10 })));
    store.write(tx => writeRecord(tx, "session-b", opencode("msg-1", "part-1", { input: 10 })));
    assert.equal(store.read(db => db.get<{ count: number }>("SELECT count(*) AS count FROM usage_records")?.count), 2);
    assert.equal(store.write(tx => writeRecord(tx, "session-a", opencode("msg-1", "part-1", { input: 4 }))), "replaced");
    const input = store.read(db => db.all<{ input: number }>("SELECT input FROM usage_records ORDER BY input"));
    assert.deepEqual(input.map(row => row.input), [4, 10]);
  } finally {
    store.close();
    f.close();
  }
});

test("a stored record keeps only usage fields", () => {
  const f = fixture();
  const store = open(f);
  try {
    const raw = {
      provider: "claude", providerId: "claude", modelId: "model-marker", messageId: "msg-marker", partId: "", nativeId: "native-marker",
      modelSource: "reported", completedAt: AT, tokens: tokens({ input: 3 }), reportedCost: 0, text: "private-marker", cwd: "/home/dev/projects/infinite",
    };
    const checked = ledgerRecord(raw);
    assert.ok(checked);
    store.write(tx => writeSession(tx, header("session-a", { projectId: "project-marker", team: { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer", taskId: "task-marker" } }), LIVE));
    store.write(tx => writeRecord(tx, "session-a", checked));
    const read = store.read(db => readRecords(db, { sessionIds: ["session-a"] }));
    assert.deepEqual(Object.keys(read[0].record).sort(), ["completedAt", "messageId", "modelId", "modelSource", "partId", "provider", "providerId", "reportedCost", "tokens"].sort());
    const row = store.read(db => db.get<Record<string, unknown>>("SELECT * FROM usage_records"));
    assert.equal(Object.keys(row ?? {}).length, 14);
    const bytes = Buffer.concat([readFileSync(f.path), existsSync(`${f.path}-wal`) ? readFileSync(`${f.path}-wal`) : Buffer.alloc(0)]);
    for (const marker of ["private-marker", "native-marker", "msg-marker", "model-marker", "project-marker", "/home/dev/projects/infinite"]) {
      assert.equal(bytes.includes(marker), false, `${marker} must not reach the database file`);
    }
  } finally {
    store.close();
    f.close();
  }
});

test("a journal record is checked before it is stored", () => {
  const valid = claude("m1", { input: 1 });
  const refused: unknown[] = [
    { ...valid, provider: undefined },
    { ...valid, provider: "grok" },
    { ...valid, modelId: "" },
    { ...valid, modelId: "x".repeat(201) },
    { ...valid, tokens: tokens({ input: -1 }) },
    { ...valid, tokens: tokens({ input: 1.5 }) },
    { ...valid, tokens: tokens({ input: "7" as unknown as number }) },
    { ...valid, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0 } },
    { ...valid, tokens: tokens({ cacheWrite: 1 }), cacheWrite1h: 2 },
    { ...valid, reportedCost: Number.NaN },
    { ...valid, reportedCost: -0.1 },
    { ...valid, completedAt: "not a time" },
    { ...valid, secondary: false },
  ];
  for (const value of refused) assert.equal(ledgerRecord(value), undefined, JSON.stringify(value));
  const extra = ledgerRecord({ ...valid, text: "extra" });
  assert.ok(extra);
  assert.equal("text" in extra, false);
  assert.equal(ledgerRecord({ ...valid, completedAt: "2026-01-01T00:00:00Z" })?.completedAt, "2026-01-01T00:00:00.000Z");
});

test("session rows hold opaque columns", () => {
  const f = fixture();
  const store = open(f);
  try {
    const team = { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer" as const, taskId: "task-marker" };
    store.write(tx => {
      assert.equal(writeSession(tx, header("team-a", { projectId: "project-marker", team }), LIVE), true);
      assert.equal(writeSession(tx, header("plain-a", { team: undefined }), LIVE), true);
      assert.equal(writeSession(tx, header("bad id", { team: undefined }), LIVE), false);
      assert.equal(writeSession(tx, header("bad-time", { createdAt: "not a time" }), LIVE), false);
      assert.equal(writeSession(tx, header("config-a", { configId: "abc" }), LIVE), true);
    });
    const sessions = store.read(db => readSessions(db));
    const teamRow = sessions.find(row => row.sessionId === "team-a");
    assert.equal(teamRow?.projectId, "project-marker");
    assert.equal(teamRow?.purpose, "work");
    assert.equal(teamRow?.taskKey, store.read(db => db.index("task", "task-marker")));
    assert.equal(sessions.find(row => row.sessionId === "plain-a")?.purpose, undefined);
    assert.equal(sessions.find(row => row.sessionId === "config-a")?.configId, undefined);
    assert.equal(sessions.some(row => row.sessionId === "bad id" || row.sessionId === "bad-time"), false);
    const shape = store.read(db => db.get<{ project_ref: string; task_key: string; config_id: string | null }>(
      "SELECT s.project_ref, s.task_key, s.config_id FROM usage_sessions s WHERE s.session_id='team-a'"));
    assert.match(shape?.project_ref ?? "", /^[0-9a-f]{64}$/);
    assert.match(shape?.task_key ?? "", /^[0-9a-f]{64}$/);
    assert.equal(store.read(db => db.get<{ config_id: string | null }>("SELECT config_id FROM usage_sessions WHERE session_id='config-a'"))?.config_id, null);
    store.write(tx => writeSession(tx, header("role-a", { team: { ...team, role: "Not A Role!" as never } }), LIVE));
    assert.equal(store.read(db => db.get<{ role: string | null }>("SELECT role FROM usage_sessions WHERE session_id='role-a'"))?.role, null);
  } finally {
    store.close();
    f.close();
  }
});

test("the import maps the sealed ledger", () => {
  const f = fixture();
  const store = open(f);
  try {
    const sealed = (messageId: string, input: unknown): UsageRecord =>
      ({ ...opencode(messageId, "part-1"), tokens: tokens({ input: input as number }) });
    const ledger: SealedLedger = {
      cursors: { "open-a": 7 },
      sessions: {
        "open-a": { provider: "opencode", projectId: "demo", createdAt: AT, measured: true, exited: true,
          team: { runId: "run-1", memberId: "member-a", revision: 1, role: "implementer", taskId: "task-1" }, profileId: "ds" },
        "claude-a": { provider: "claude", projectId: "demo", createdAt: AT, measured: false, exited: true },
      },
      rows: {
        "open-a/msg-1/part-1": sealed("msg-1", 1),
        "open-a/msg-2/part-1": sealed("msg-2", 2),
        "open-a/msg-3/part-1": sealed("msg-3", 3),
        "ghost/msg-4/part-1": sealed("msg-4", 4),
        "open-a/msg-5/part-1": sealed("msg-5", "7"),
      },
      briefings: {
        "open-a/2026-10-21T00:00:00Z": { projectId: "demo", at: "2026-10-21T00:00:00Z", record: { ...opencode("open-a", "2026-10-21T00:00:00Z") } },
        "open-a/2026-10-22T00:00:00Z": { projectId: "other", at: "2026-10-22T00:00:00Z" },
      },
    };
    const result = store.write(tx => importLedger(tx, ledger, "imported"));
    assert.deepEqual(result, { sessions: 2, records: 3, briefings: 2, refused: 2 });
    const sessions = store.read(db => readSessions(db));
    const measured = sessions.find(row => row.sessionId === "open-a");
    assert.equal(measured?.coverage, "complete");
    assert.equal(measured?.cursor, 7);
    assert.equal(measured?.exited, true);
    const unmeasured = sessions.find(row => row.sessionId === "claude-a");
    assert.equal(unmeasured?.coverage, "none");
    assert.equal(unmeasured?.reason, "unsupported");
    assert.equal(unmeasured?.cursor, 0);
    assert.equal(unmeasured?.exited, false);
    assert.equal(store.read(db => importState(db)), "done");
    // The fold moves on after the import: a newer copy of a record, and a later cursor.
    store.write(tx => {
      writeSession(tx, { sessionId: "open-a", provider: "opencode", projectId: "demo", createdAt: AT,
        team: { runId: "run-1", memberId: "member-a", revision: 1, role: "implementer", taskId: "task-1" }, profileId: "ds" },
        { coverage: "complete", cursor: 8, seen: 1, refused: 0, exited: true });
      assert.equal(writeRecord(tx, "open-a", sealed("msg-1", 200)), "replaced");
    });
    const before = ["usage_meta", "usage_projects", "usage_models", "usage_sessions", "usage_records", "usage_briefings"].map(table => rows(store, table));
    // A second import, with the same ledger or another outcome, writes nothing.
    assert.deepEqual(store.write(tx => importLedger(tx, ledger, "imported")), { sessions: 0, records: 0, briefings: 0, refused: 0 });
    assert.deepEqual(store.write(tx => importLedger(tx, undefined, "absent")), { sessions: 0, records: 0, briefings: 0, refused: 0 });
    const after = ["usage_meta", "usage_projects", "usage_models", "usage_sessions", "usage_records", "usage_briefings"].map(table => rows(store, table));
    assert.deepEqual(after, before);
    assert.equal(store.read(db => readSessions(db)).find(row => row.sessionId === "open-a")?.cursor, 8);
    assert.equal(store.read(db => readRecords(db, { sessionIds: ["open-a"] })).some(row => row.record.tokens.input === 200), true);
  } finally {
    store.close();
    f.close();
  }
});

test("records are read by session and time", () => {
  const f = fixture();
  const store = open(f);
  try {
    store.write(tx => {
      writeSession(tx, header("session-a"), LIVE);
      writeSession(tx, header("session-b"), LIVE);
      writeRecord(tx, "session-a", claude("m1", { input: 1 }, { completedAt: "2026-10-01T00:00:00.000Z" }));
      writeRecord(tx, "session-a", claude("m2", { input: 2 }, { completedAt: "2026-10-02T00:00:00.000Z" }));
      writeRecord(tx, "session-b", claude("m3", { input: 3 }, { completedAt: "2026-10-03T00:00:00.000Z" }));
    });
    const inputs = (filter?: Parameters<typeof readRecords>[1]) => store.read(db => readRecords(db, filter)).map(row => row.record.tokens.input).sort();
    assert.deepEqual(inputs({ sessionIds: ["session-a"] }), [1, 2]);
    assert.deepEqual(inputs({ from: "2026-10-02T00:00:00.000Z" }), [2, 3]);
    assert.deepEqual(inputs({ to: "2026-10-02T00:00:00.000Z" }), [1]);
    assert.deepEqual(inputs({ sessionIds: ["session-b"], from: "2026-10-01T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" }), [3]);
    store.write(tx => writeBriefing(tx, "session-a/2026-10-21T00:00:00Z", "demo", "2026-10-21T00:00:00Z"));
    assert.equal(store.read(db => readBriefings(db)).length, 1);
  } finally {
    store.close();
    f.close();
  }
});
