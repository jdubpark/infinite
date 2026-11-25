import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROUTING_EVIDENCE_SQL,
  ROUTING_ROWS_PER_SOURCE,
  selectRoutingEvidence,
  type LegacyLineState,
  type MemberResultRow,
  type OutcomeRow,
  outcomeModule,
  deleteLegacyOutcome,
  landingCandidates,
  legacyLineCount,
  checkScan,
  lastScan,
  type OutcomePayload,
  outcomeSources,
  readLegacyLines,
  readMemberResult,
  readOutcome,
  readScanState,
  readSignal,
  readSummary,
  rollupRecords,
  type RunSummaryRow,
  runOutcomeView,
  runOutcomes,
  runSignals,
  type ScanRow,
  type ScanState,
  scanPoints,
  type SignalPayload,
  type SignalRow,
  sweepExpiredOutcomes,
  writeLegacyLine,
  writeMemberResult,
  writeOutcome,
  writeScan,
  writeSignal,
  writeSummary,
} from "../packages/host/src/outcome-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceModule, type EvidenceTx } from "../packages/host/src/evidence/types.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcomes-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
}

const NOW = "2026-11-13T12:00:00.000Z";
const DAY_MS = 86_400_000;

function outcomeRow(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    outcomeId: "run-1:member-1",
    source: "production",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: "run-1",
    revision: 1,
    memberId: "member-1",
    sessionId: "session-1",
    attemptIndex: 1,
    inherited: false,
    role: "implementer",
    profileId: "profile-a",
    provider: "opencode",
    model: "model-one",
    effort: "high",
    profileEpoch: 1,
    configId: null,
    experimentRef: null,
    kind: "feature",
    risk: "low",
    featureVersion: 1,
    disposition: "completed",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    acceptance: 1,
    firstPass: 1,
    held: null,
    startedAt: "2026-11-13T10:00:00.000Z",
    endedAt: "2026-11-13T10:30:00.000Z",
    frozenAt: null,
    holdUntil: null,
    runDeletedAt: null,
    payload: {
      projectId: "example",
      taskId: "task-a",
      area: "packages/host",
      featureMap: "map-1",
      goal: { id: "goal-1", cycle: 1 },
      missionId: "mission-1",
      lastReview: "approved",
      rounds: { run: 0, attributed: 0, unknown: 0 },
      rubric: { version: 1, correctness: 4, cleanliness: 4, extensibility: 3, docs: 3, reviewerProfileId: "profile-b" },
      ownerRating: { score: 4, at: "2026-11-13T11:00:00.000Z" },
      diff: { added: 10, removed: 2, files: 1, docs: false, tests: true },
      wallMs: 1000,
      limitEvents: 0,
      costCoverage: "none",
    },
    ...overrides,
  };
}

function summaryRow(runId: string, overrides: Partial<RunSummaryRow> = {}): RunSummaryRow {
  return {
    runId,
    source: "production",
    projectRef: "",
    revision: 1,
    status: "ready-for-review",
    blockCode: null,
    flags: [],
    createdAt: "2026-11-13T09:00:00.000Z",
    settledAt: null,
    approvedAt: null,
    runDeletedAt: null,
    payload: {
      projectId: "example",
      attempts: { completed: 1 },
      rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 },
    },
    ...overrides,
  };
}

function memberRow(runId: string, memberId: string, overrides: Partial<MemberResultRow> = {}): MemberResultRow {
  return {
    resultId: `${runId}:${memberId}`,
    source: "production",
    projectRef: "",
    runId,
    revision: 1,
    memberId,
    sessionId: null,
    role: "reviewer",
    profileId: "profile-b",
    provider: "opencode",
    model: "model-two",
    effort: null,
    profileEpoch: 1,
    configId: null,
    reportKind: "review",
    disposition: "reported",
    flags: [],
    startedAt: "2026-11-13T10:00:00.000Z",
    endedAt: "2026-11-13T10:10:00.000Z",
    runDeletedAt: null,
    payload: { projectId: "example" },
    ...overrides,
  };
}

function appendEvent(store: EvidenceStore, runId: string, key: string, kind: string, memberId?: string): number {
  return store.write(tx => store.appendEvent(tx, {
    key,
    runId,
    revision: 1,
    at: "2026-11-13T10:00:00.000Z",
    kind,
    ...(memberId === undefined ? {} : { memberId }),
    data: {},
  })).seq;
}

test("a row round-trips with its payload sealed", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const row = outcomeRow();
    store.write(tx => writeOutcome(tx, row));

    const read = store.read(db => readOutcome(db, row.outcomeId));
    assert.ok(read);
    const [expectedProjectRef, expectedTaskRef, expectedAreaRef] = store.write(tx => [
      tx.index("project", "example"),
      tx.index("task", "task-a"),
      tx.index("area", "packages/host"),
    ]);
    assert.equal(read.projectRef, expectedProjectRef);
    assert.deepEqual(read, {
      ...row,
      projectRef: expectedProjectRef,
      taskRef: expectedTaskRef,
      areaRef: expectedAreaRef,
    });

    const raw = store.read(db => db.get<Record<string, unknown>>(
      "SELECT * FROM outcomes WHERE outcome_id=?",
      row.outcomeId,
    ));
    assert.ok(raw);
    const plain = JSON.stringify({ ...raw, payload: undefined });
    assert.equal(plain.includes("task-a"), false);
    assert.equal(plain.includes("example"), false);
    assert.equal(String(raw.payload).includes("task-a"), false);
    assert.equal(String(raw.payload).includes("example"), false);
    assert.equal(raw.project_ref, expectedProjectRef);
  } finally {
    store?.close();
    f.close();
  }
});

test("deleting a run stamps its rows and removes none", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const runId = "run-r";
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: `${runId}:member-1`, runId }));
      tx.run(
        "INSERT INTO outcome_rounds (run_id, revision, round, cause, state, started_at) VALUES (?, 1, 1, 'review', 'resolved', ?)",
        runId,
        NOW,
      );
      tx.run(
        "INSERT INTO outcome_round_links (outcome_id, run_id, revision, round, state) VALUES (?, ?, 1, 1, 'clear')",
        `${runId}:member-1`,
        runId,
      );
      writeSummary(tx, summaryRow(runId));
      writeMemberResult(tx, memberRow(runId, "member-2"));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-other:member-1", runId: "run-other" }));
    });
    appendEvent(store, runId, "run-r:a", "run.created");
    appendEvent(store, runId, "run-r:b", "run.prepared");
    assert.equal(store.events({ runId, limit: 10 }).events.length, 2);

    assert.equal(store.deleteRun(runId), true);

    const counts = store.read(db => ({
      outcomes: db.all<{ run_deleted_at: string | null }>("SELECT run_deleted_at FROM outcomes WHERE run_id=?", runId),
      rounds: db.all<{ run_deleted_at: string | null }>("SELECT run_deleted_at FROM outcome_rounds WHERE run_id=?", runId),
      links: db.all("SELECT 1 FROM outcome_round_links WHERE run_id=?", runId),
      summaries: db.all<{ run_deleted_at: string | null }>("SELECT run_deleted_at FROM run_summaries WHERE run_id=?", runId),
      members: db.all<{ run_deleted_at: string | null }>("SELECT run_deleted_at FROM member_results WHERE run_id=?", runId),
      other: db.all<{ run_deleted_at: string | null }>("SELECT run_deleted_at FROM outcomes WHERE run_id='run-other'"),
    }));
    assert.equal(counts.outcomes.length, 1);
    assert.equal(counts.rounds.length, 1);
    assert.equal(counts.links.length, 1);
    assert.equal(counts.summaries.length, 1);
    assert.equal(counts.members.length, 1);
    for (const table of [counts.outcomes, counts.rounds, counts.summaries, counts.members]) {
      assert.equal(table[0]!.run_deleted_at, NOW);
    }
    assert.equal(counts.other[0]!.run_deleted_at, null);
    assert.equal(store.events({ runId, limit: 10 }).events.length, 0);
  } finally {
    store?.close();
    f.close();
  }
});

test("a run deleted with unseen events is flagged", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    appendEvent(store, "run-x", "x:1", "other.event");
    appendEvent(store, "run-x", "x:2", "other.event");
    appendEvent(store, "run-x", "x:3", "other.event");
    appendEvent(store, "run-r", "r:4", "task.integrated", "member-1");
    appendEvent(store, "run-s", "s:5", "task.integrated", "member-1");
    appendEvent(store, "run-r", "r:6", "task.integrated", "member-1");
    store.write(tx => {
      tx.run("INSERT INTO outcome_state (key, value) VALUES ('last_seq', ?)", 5);
      writeOutcome(tx, outcomeRow({ outcomeId: "run-r:member-1", runId: "run-r" }));
      writeMemberResult(tx, memberRow("run-r", "member-2"));
      writeSummary(tx, summaryRow("run-r"));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-s:member-1", runId: "run-s" }));
      writeSummary(tx, summaryRow("run-s"));
    });

    assert.equal(store.deleteRun("run-s"), true);
    const sFlags = store.read(db => db.get<{ flags: string }>("SELECT flags FROM outcomes WHERE outcome_id='run-s:member-1'")!.flags);
    assert.equal(sFlags, "");

    assert.equal(store.deleteRun("run-r"), true);

    const flags = store.read(db => ({
      row: db.get<{ flags: string }>("SELECT flags FROM outcomes WHERE outcome_id='run-r:member-1'")!.flags,
      member: db.get<{ flags: string }>("SELECT flags FROM member_results WHERE result_id='run-r:member-2'")!.flags,
      summary: db.get<{ flags: string }>("SELECT flags FROM run_summaries WHERE run_id='run-r'")!.flags,
    }));
    assert.equal(flags.row, "gap");
    assert.equal(flags.member, "gap");
    assert.equal(flags.summary, "gap");
  } finally {
    store?.close();
    f.close();
  }
});

test("the store sweep finds unstamped runs only", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const module = outcomeModule({ now: () => NOW });
    store.register(module);
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-r:member-1", runId: "run-r" }));
    });
    appendEvent(store, "run-r", "r:1", "run.created");
    store.write(tx => writeSummary(tx, summaryRow("run-t")));

    const listed = () => store!.read(db => module.runIds!(db));
    assert.ok(listed().includes("run-r"));
    assert.ok(listed().includes("run-t"));

    assert.equal(store.deleteRun("run-r"), true);
    assert.equal(listed().includes("run-r"), false);
    assert.ok(listed().includes("run-t"));

    assert.equal(store.sweep(() => false), 1);
    assert.equal(listed().includes("run-t"), false);
    const stamp = store.read(db => db.get<{ run_deleted_at: string | null }>("SELECT run_deleted_at FROM run_summaries WHERE run_id='run-t'"));
    assert.equal(stamp?.run_deleted_at, NOW);
  } finally {
    store?.close();
    f.close();
  }
});

test("rows expire 730 days after their run was deleted", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => "2024-01-01T00:00:00.000Z" }));
    const seed = (runId: string, deleted: boolean) => store!.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: `${runId}:member-1`, runId }));
      writeSummary(tx, summaryRow(runId));
      tx.run("INSERT INTO outcome_rounds (run_id, revision, round, cause, state, started_at) VALUES (?, 1, 1, 'review', 'resolved', ?)", runId, NOW);
      tx.run("INSERT INTO outcome_round_links (outcome_id, run_id, revision, round, state) VALUES (?, ?, 1, 1, 'clear')", `${runId}:member-1`, runId);
      writeMemberResult(tx, memberRow(runId, "member-2"));
      if (deleted) {
        tx.run("UPDATE outcomes SET run_deleted_at='2024-01-01T00:00:00.000Z' WHERE run_id=?", runId);
        tx.run("UPDATE outcome_rounds SET run_deleted_at='2024-01-01T00:00:00.000Z' WHERE run_id=?", runId);
        tx.run("UPDATE run_summaries SET run_deleted_at='2024-01-01T00:00:00.000Z' WHERE run_id=?", runId);
        tx.run("UPDATE member_results SET run_deleted_at='2024-01-01T00:00:00.000Z' WHERE run_id=?", runId);
      }
    });
    seed("run-expired", true);
    seed("run-expired-2", true);
    seed("run-live", false);
    const count = (runId: string) => store!.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes WHERE run_id=?", runId)!.n);

    assert.equal(sweepExpiredOutcomes(store, "2025-12-30T23:59:59.999Z"), 0);
    assert.equal(count("run-expired"), 1);

    assert.equal(sweepExpiredOutcomes(store, "2025-12-31T00:00:00.001Z", 1), 1);
    const remaining = (runId: string) => store!.read(db => ({
      outcomes: db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes WHERE run_id=?", runId)!.n,
      rounds: db.get<{ n: number }>("SELECT count(*) AS n FROM outcome_rounds WHERE run_id=?", runId)!.n,
      links: db.get<{ n: number }>("SELECT count(*) AS n FROM outcome_round_links WHERE run_id=?", runId)!.n,
      summaries: db.get<{ n: number }>("SELECT count(*) AS n FROM run_summaries WHERE run_id=?", runId)!.n,
      members: db.get<{ n: number }>("SELECT count(*) AS n FROM member_results WHERE run_id=?", runId)!.n,
    }));
    const first = ["run-expired", "run-expired-2"].filter(runId => remaining(runId).outcomes === 0);
    assert.equal(first.length, 1, "one call removes one run");
    const gone = first[0]!;
    assert.deepEqual(remaining(gone), { outcomes: 0, rounds: 0, links: 0, summaries: 0, members: 0 });

    assert.equal(sweepExpiredOutcomes(store, "2025-12-31T00:00:00.001Z"), 1);
    const left = ["run-expired", "run-expired-2"].find(runId => runId !== gone)!;
    assert.deepEqual(remaining(left), { outcomes: 0, rounds: 0, links: 0, summaries: 0, members: 0 });
    assert.equal(count("run-live"), 1);
    assert.equal(remaining("run-live").summaries, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("the retention sweep waits for a ready module", () => {
  const warned: unknown[][] = [];
  const logged: unknown[][] = [];
  const warn = console.warn, log = console.log;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  console.log = (...args: unknown[]) => { logged.push(args); };
  const f = fixture();
  try {
    const bare = open(f);
    try {
      assert.equal(sweepExpiredOutcomes(bare, NOW), 0);
    } finally {
      bare.close();
    }
    const closed = new EvidenceStore({ databasePath: join(f.root, "missing", "\0", "evidence.db"), vaultKey: f.key });
    try {
      assert.equal(closed.status().state, "unavailable");
      assert.equal(sweepExpiredOutcomes(closed, NOW), 0);
    } finally {
      closed.close();
    }
    assert.deepEqual(warned.filter(args => String(args[0]).includes("Outcome retention")), []);
    assert.deepEqual(logged.filter(args => String(args[0]).includes("Outcome retention")), []);
  } finally {
    console.warn = warn;
    console.log = log;
    f.close();
  }
});

test("the module reports its counts", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:member-1", disposition: "open", flags: [] }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:member-2", memberId: "member-2", disposition: "open", flags: ["gap"] }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:member-3", memberId: "member-3", disposition: "completed", flags: ["gap"] }));
      writeSummary(tx, summaryRow("run-1"));
      writeMemberResult(tx, memberRow("run-1", "member-4"));
    });
    const counts = store.describe().counts;
    assert.equal(counts["outcomes.outcomes"], 3);
    assert.equal(counts["outcomes.open"], 2);
    assert.equal(counts["outcomes.gap"], 2);
    assert.equal(counts["outcomes.summaries"], 1);
    assert.equal(counts["outcomes.memberResults"], 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("a run view returns the summary, rows, and member results after the run's record is gone", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:member-1" }));
      writeSummary(tx, summaryRow("run-1"));
      writeMemberResult(tx, memberRow("run-1", "member-2"));
    });
    assert.equal(store.deleteRun("run-1"), true);
    const view = runOutcomeView(store, "run-1");
    assert.ok(view);
    assert.equal(view.summary?.runDeletedAt, NOW);
    assert.deepEqual(view.rows.map(row => row.outcomeId), ["run-1:member-1"]);
    assert.deepEqual(view.members.map(row => row.resultId), ["run-1:member-2"]);
    assert.equal(runOutcomeView(store, "run-missing"), undefined);
    assert.deepEqual(store.read(db => runOutcomes(db, "run-1")).map(row => row.runDeletedAt), [NOW]);
    assert.equal(store.read(db => readSummary(db, "run-1"))?.runId, "run-1");
    assert.equal(store.read(db => readMemberResult(db, "run-1:member-2"))?.memberId, "member-2");
  } finally {
    store?.close();
    f.close();
  }
});

const COMMIT = "a".repeat(40);
const HEAD = "c".repeat(40);
const T_EARLY = "2026-11-13T11:00:00.000Z";
const T_LATE = "2026-11-13T12:30:00.000Z";

function signalRow(overrides: Partial<SignalRow> & { signalId: string }): SignalRow {
  return {
    runId: "run-1",
    outcomeId: "run-1:member-1",
    kind: "rating",
    author: "host",
    authority: "receipt",
    state: "active",
    at: NOW,
    payload: { kind: "rating", score: 4 } as SignalPayload,
    ...overrides,
  };
}

function day(n: number): string {
  return new Date(Date.parse("2026-11-01T00:00:00.000Z") + n * DAY_MS).toISOString();
}

function outcomesVersion1(): EvidenceModule {
  return {
    name: "outcomes",
    version: 1,
    readVersion: 1,
    migrate(tx) {
      tx.exec(
        "CREATE TABLE IF NOT EXISTS outcomes (outcome_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
        + "project_ref TEXT NOT NULL, task_ref TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, "
        + "member_id TEXT NOT NULL, session_id TEXT, attempt_index INTEGER NOT NULL, inherited INTEGER NOT NULL, "
        + "role TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, "
        + "profile_epoch INTEGER NOT NULL, config_id TEXT, experiment_ref TEXT, area_ref TEXT NOT NULL, kind TEXT, "
        + "risk TEXT NOT NULL, feature_version INTEGER NOT NULL, disposition TEXT NOT NULL, exclusion TEXT, "
        + "flags TEXT NOT NULL, integrated INTEGER, accepted INTEGER, first_pass INTEGER, held INTEGER, "
        + "started_at TEXT, ended_at TEXT, frozen_at TEXT, hold_until TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS outcome_rounds (run_id TEXT NOT NULL, revision INTEGER NOT NULL, "
        + "round INTEGER NOT NULL, cause TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, "
        + "run_deleted_at TEXT, PRIMARY KEY (run_id, revision, round))",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS outcome_round_links (outcome_id TEXT NOT NULL, run_id TEXT NOT NULL, "
        + "revision INTEGER NOT NULL, round INTEGER NOT NULL, state TEXT NOT NULL, "
        + "PRIMARY KEY (outcome_id, revision, round))",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS run_summaries (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
        + "project_ref TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT, block_code TEXT, flags TEXT NOT NULL, "
        + "created_at TEXT, settled_at TEXT, approved_at TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS member_results (result_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
        + "project_ref TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL, "
        + "session_id TEXT, role TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, "
        + "effort TEXT, profile_epoch INTEGER NOT NULL, config_id TEXT, report_kind TEXT, disposition TEXT NOT NULL, "
        + "flags TEXT NOT NULL, started_at TEXT, ended_at TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS backfill_runs (run_id TEXT PRIMARY KEY, at TEXT NOT NULL, rows INTEGER NOT NULL, "
        + "skipped INTEGER NOT NULL)",
      );
      tx.exec("CREATE TABLE IF NOT EXISTS outcome_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_run ON outcomes (run_id)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_session ON outcomes (session_id)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_deleted ON outcomes (run_deleted_at)");
      tx.exec("CREATE INDEX IF NOT EXISTS member_results_by_run ON member_results (run_id)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcome_round_links_by_run ON outcome_round_links (run_id)");
    },
  };
}

test("a version 1 store migrates in place", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomesVersion1());
    const payload: OutcomePayload = outcomeRow().payload;
    store.write(tx => {
      tx.run(
        "INSERT INTO outcomes (outcome_id, source, project_ref, task_ref, run_id, revision, member_id, attempt_index, "
        + "inherited, role, profile_id, provider, model, profile_epoch, area_ref, risk, feature_version, disposition, "
        + "flags, integrated, accepted, first_pass, held, payload) "
        + "VALUES (?, 'production', ?, ?, 'run-1', 1, 'member-1', 1, 0, 'implementer', 'profile-a', 'opencode', "
        + "'model-one', 1, ?, 'low', 1, 'completed', '', 1, 1, 1, NULL, ?)",
        "run-1:member-1",
        tx.index("project", "example"),
        tx.index("task", "task-a"),
        tx.index("area", "packages/host"),
        tx.seal("outcomes", "run-1:member-1", payload),
      );
    });
    store.close();

    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const row = store.read(db => readOutcome(db, "run-1:member-1"));
    assert.equal(row?.accepted, 1);
    assert.equal(row?.acceptance, 1);
    assert.deepEqual([row?.integrated, row?.firstPass, row?.held, row?.exclusion, row?.flags, row?.holdUntil], [1, 1, null, null, [], null]);
    const tables = store.read(db => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'"))
      .map(table => table.name);
    for (const table of ["outcome_signals", "base_scans", "base_scan_state"]) assert.ok(tables.includes(table), table);
    const stored = store.read(db => db.get<{ version: number }>("SELECT version FROM schema_modules WHERE name='outcomes'"));
    assert.equal(stored?.version, 4);
    const columns = store.read(db => db.all<{ name: string }>("SELECT name FROM pragma_table_info('outcomes')"))
      .map(column => column.name);
    const summaryColumns = store.read(db => db.all<{ name: string }>("SELECT name FROM pragma_table_info('run_summaries')"))
      .map(column => column.name);
    for (const column of ["goal_ref", "mission_ref"]) {
      assert.ok(columns.includes(column), `outcomes.${column}`);
      assert.ok(summaryColumns.includes(column), `run_summaries.${column}`);
    }
    const counts = store.describe().counts;
    assert.equal(counts["outcomes.signals"], 0);
    assert.equal(counts["outcomes.scans"], 0);
  } finally {
    store?.close();
    f.close();
  }
});

test("a write without an acceptance stores the accepted level", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const { acceptance: _dropped, ...bare } = outcomeRow({ outcomeId: "run-1:bare", memberId: "bare", accepted: 1 });
    store.write(tx => {
      writeOutcome(tx, bare);
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:kept", memberId: "kept", accepted: null, acceptance: 1 }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-1:none", memberId: "none", accepted: 1, acceptance: null }));
    });
    assert.equal(store.read(db => readOutcome(db, "run-1:bare"))?.acceptance, 1);
    const kept = store.read(db => readOutcome(db, "run-1:kept"));
    assert.equal(kept?.accepted, null);
    assert.equal(kept?.acceptance, 1);
    assert.equal(store.read(db => readOutcome(db, "run-1:none"))?.acceptance, null);
  } finally {
    store?.close();
    f.close();
  }
});

test("a signal round-trips sealed", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const landing = signalRow({
      signalId: "sig-landing",
      authority: "receipt",
      at: T_EARLY,
      payload: { kind: "landing", commit: COMMIT, method: "merge-commit", scanSeq: 2, holdDays: 90, holdUntil: day(90), reviewedHead: HEAD },
    });
    const fix = signalRow({
      signalId: "sig-fix",
      author: "owner",
      authority: "claim",
      kind: "linked-fix",
      at: T_LATE,
      payload: { kind: "linked-fix", issue: "ABC-12", request: "req-1" },
    });
    store.write(tx => {
      writeSignal(tx, landing);
      writeSignal(tx, fix);
    });

    assert.deepEqual(store.read(db => readSignal(db, "sig-fix")), fix);
    assert.deepEqual(store.read(db => runSignals(db, "run-1")), [landing, fix]);

    const raw = store.read(db => db.all<Record<string, unknown>>("SELECT * FROM outcome_signals"));
    assert.equal(raw.length, 2);
    for (const row of raw) {
      const plain = JSON.stringify({ ...row, payload: undefined });
      assert.equal(plain.includes(COMMIT), false);
      assert.equal(plain.includes("ABC-12"), false);
      assert.equal(String(row.payload).includes(COMMIT), false);
      assert.equal(String(row.payload).includes("ABC-12"), false);
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("scan state and points", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const state: ScanState = { projectRef: "p", seq: 3, payload: { head: HEAD, repository: "example/repo", baseBranch: "main" } };
    store.write(tx => {
      writeScan(tx, { projectRef: "p", seq: 1, at: day(0), checkedAt: day(1), commits: 1, gap: null, payload: { to: COMMIT } },
        { ...state, seq: 1 });
      writeScan(tx, { projectRef: "p", seq: 2, at: day(2), checkedAt: day(2), commits: 1, gap: "bound", payload: { from: COMMIT, to: HEAD } },
        { ...state, seq: 2 });
      writeScan(tx, { projectRef: "p", seq: 3, at: day(40), checkedAt: day(40), commits: 3, gap: null, payload: { to: HEAD } }, state);
    });

    const from1 = store.read(db => scanPoints(db, "p", 1, day(30)));
    assert.equal(from1.last?.seq, 2);
    assert.equal(from1.next?.seq, 3);
    assert.equal(from1.gapInside, true);
    const from2 = store.read(db => scanPoints(db, "p", 2, day(30)));
    assert.equal(from2.last?.seq, 2);
    assert.equal(from2.gapInside, false);

    store.write(tx => checkScan(tx, "p", 2, day(1)));
    assert.equal(store.read(db => scanPoints(db, "p", 2, day(30)).last?.checkedAt), day(2));
    store.write(tx => checkScan(tx, "p", 2, day(5)));
    assert.equal(store.read(db => scanPoints(db, "p", 2, day(30)).last?.checkedAt), day(5));

    assert.deepEqual(store.read(db => readScanState(db, "p")), state);
    assert.equal(store.read(db => lastScan(db, "p"))?.seq, 3);

    const raw = store.read(db => ({
      scans: db.all<Record<string, unknown>>("SELECT * FROM base_scans"),
      state: db.all<Record<string, unknown>>("SELECT * FROM base_scan_state"),
    }));
    for (const row of [...raw.scans, ...raw.state]) {
      const plain = JSON.stringify({ ...row, payload: undefined });
      assert.equal(plain.includes(HEAD), false);
      assert.equal(plain.includes("example/repo"), false);
      assert.equal(String(row.payload).includes(HEAD), false);
      assert.equal(String(row.payload).includes("example/repo"), false);
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("landing candidates", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
    const approvedSince = ago(90);
    store.write(tx => {
      writeSummary(tx, summaryRow("run-in", { approvedAt: ago(89) }));
      writeSummary(tx, summaryRow("run-out", { approvedAt: ago(91) }));
      writeSummary(tx, summaryRow("run-landed", { approvedAt: ago(1) }));
      writeSignal(tx, signalRow({
        signalId: "sig-landed",
        runId: "run-landed",
        outcomeId: null,
        kind: "landing",
        authority: "receipt",
        payload: { kind: "landing", commit: COMMIT, method: "merge-commit", scanSeq: 1, holdDays: 90, holdUntil: day(90) },
      }));
      writeSummary(tx, summaryRow("run-other", {
        approvedAt: ago(1),
        payload: { ...summaryRow("run-other").payload, projectId: "other" },
      }));
      writeSummary(tx, summaryRow("run-unapproved", { approvedAt: null }));
      writeSummary(tx, summaryRow("run-deleted", {
        approvedAt: ago(1),
        runDeletedAt: NOW,
        payload: { ...summaryRow("run-deleted").payload, reviewedHead: HEAD },
      }));
    });
    const ref = store.write(tx => tx.index("project", "example"));

    const found = store.read(db => landingCandidates(db, ref, approvedSince));
    assert.deepEqual(found.map(candidate => candidate.runId), ["run-deleted", "run-in"]);
    assert.equal(found[0]!.payload.reviewedHead, HEAD);
  } finally {
    store?.close();
    f.close();
  }
});

test("retention follows the configured days", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => "2024-01-01T00:00:00.000Z" }));
    const deleted = "2024-01-01T00:00:00.000Z";
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "run-old:member-1", runId: "run-old", runDeletedAt: deleted }));
      writeSummary(tx, summaryRow("run-old", { runDeletedAt: deleted }));
      writeSignal(tx, signalRow({ signalId: "sig-old", runId: "run-old", at: deleted }));
      writeScan(tx, { projectRef: "p", seq: 1, at: deleted, checkedAt: deleted, commits: 1, gap: null, payload: { to: HEAD } },
        { projectRef: "p", seq: 1, payload: { head: HEAD, repository: "example/repo", baseBranch: "main" } });
    });
    const remaining = () => store!.read(db => ({
      outcomes: db.get<{ n: number }>("SELECT count(*) AS n FROM outcomes WHERE run_id='run-old'")!.n,
      signals: db.get<{ n: number }>("SELECT count(*) AS n FROM outcome_signals WHERE run_id='run-old'")!.n,
      scans: db.get<{ n: number }>("SELECT count(*) AS n FROM base_scans")!.n,
    }));

    assert.equal(sweepExpiredOutcomes(store, "2025-01-01T00:00:00.001Z"), 0);
    assert.deepEqual(remaining(), { outcomes: 1, signals: 1, scans: 1 });

    assert.equal(sweepExpiredOutcomes(store, "2025-01-01T00:00:00.001Z", undefined, 365), 1);
    assert.deepEqual(remaining(), { outcomes: 0, signals: 0, scans: 1 });
  } finally {
    store?.close();
    f.close();
  }
});

test("the run view lists signals", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, outcomeRow());
      writeSignal(tx, signalRow({ signalId: "sig-late", at: T_LATE, payload: { kind: "rating", score: 3 } }));
      writeSignal(tx, signalRow({ signalId: "sig-early", at: T_EARLY, payload: { kind: "rating", score: 5 } }));
      writeSignal(tx, signalRow({ signalId: "sig-other", runId: "run-other", outcomeId: null, at: T_EARLY }));
    });
    const view = runOutcomeView(store, "run-1");
    assert.deepEqual(view?.signals.map(signal => signal.signalId), ["sig-early", "sig-late"]);
  } finally {
    store?.close();
    f.close();
  }
});

const GOAL = "goal-7";
const OTHER_GOAL = "goal-8";
const MISSION = "mission-7";

function rowIn(runId: string, memberId: string, goal?: string, mission?: string): OutcomeRow {
  const payload: OutcomePayload = { ...outcomeRow().payload };
  delete payload.goal;
  delete payload.missionId;
  if (goal !== undefined) payload.goal = { id: goal, cycle: 1 };
  if (mission !== undefined) payload.missionId = mission;
  return outcomeRow({ outcomeId: `${runId}:${memberId}`, runId, memberId, payload });
}

function summaryWith(runId: string, goal?: string, mission?: string): RunSummaryRow {
  const base = summaryRow(runId);
  const payload: RunSummaryRow["payload"] = { ...base.payload };
  delete payload.goal;
  delete payload.missionId;
  if (goal !== undefined) payload.goal = { id: goal, cycle: 1 };
  if (mission !== undefined) payload.missionId = mission;
  return { ...base, payload };
}

function outcomesVersion2(): EvidenceModule {
  const version1 = outcomesVersion1();
  return {
    name: "outcomes",
    version: 2,
    readVersion: 2,
    migrate(tx, from) {
      if (from < 1) version1.migrate(tx, from);
      tx.exec("ALTER TABLE outcomes ADD COLUMN acceptance INTEGER");
      tx.exec("UPDATE outcomes SET acceptance = accepted");
      tx.exec(
        "CREATE TABLE IF NOT EXISTS outcome_signals (signal_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, outcome_id TEXT, "
        + "kind TEXT NOT NULL, author TEXT NOT NULL, authority TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, "
        + "payload TEXT NOT NULL)",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS base_scans (project_ref TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, "
        + "checked_at TEXT NOT NULL, commits INTEGER NOT NULL, gap TEXT, payload TEXT NOT NULL, "
        + "PRIMARY KEY (project_ref, seq))",
      );
      tx.exec(
        "CREATE TABLE IF NOT EXISTS base_scan_state (project_ref TEXT PRIMARY KEY, seq INTEGER NOT NULL, "
        + "payload TEXT NOT NULL)",
      );
      tx.exec("CREATE INDEX IF NOT EXISTS outcome_signals_by_run ON outcome_signals (run_id)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcome_signals_by_outcome ON outcome_signals (outcome_id)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcome_signals_by_kind ON outcome_signals (kind, at)");
    },
  };
}

function insertOutcomeAtVersion2(tx: EvidenceTx, outcomeId: string, runId: string, sealed: string): void {
  tx.run(
    "INSERT INTO outcomes (outcome_id, source, project_ref, task_ref, run_id, revision, member_id, attempt_index, "
    + "inherited, role, profile_id, provider, model, profile_epoch, area_ref, risk, feature_version, disposition, "
    + "flags, integrated, accepted, acceptance, first_pass, payload) "
    + "VALUES (?, 'production', ?, ?, ?, 1, 'member-1', 1, 0, 'implementer', 'profile-a', 'opencode', "
    + "'model-one', 1, ?, 'low', 1, 'completed', '', 1, 1, 1, 1, ?)",
    outcomeId,
    tx.index("project", "example"),
    tx.index("task", "task-a"),
    runId,
    tx.index("area", "packages/host"),
    sealed,
  );
}

function insertSummaryAtVersion2(tx: EvidenceTx, runId: string, sealed: string): void {
  tx.run(
    "INSERT INTO run_summaries (run_id, source, project_ref, revision, flags, payload) "
    + "VALUES (?, 'production', ?, 1, '', ?)",
    runId,
    tx.index("project", "example"),
    sealed,
  );
}

test("a version 2 store migrates to version 3 and indexes goals and missions", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomesVersion2());
    store.write(tx => {
      insertSummaryAtVersion2(tx, "run-1", tx.seal("run_summaries", "run-1", summaryWith("run-1", GOAL).payload));
      insertOutcomeAtVersion2(tx, "run-1:member-1", "run-1", tx.seal("outcomes", "run-1:member-1", rowIn("run-1", "member-1", undefined, MISSION).payload));
      insertOutcomeAtVersion2(tx, "run-2:member-1", "run-2", tx.seal("outcomes", "run-2:member-1", rowIn("run-2", "member-1").payload));
      insertOutcomeAtVersion2(tx, "run-3:member-1", "run-3", "x");
    });
    const earlier = store.read(db => ({
      outcomes: db.all("SELECT * FROM outcomes ORDER BY outcome_id"),
      summaries: db.all("SELECT * FROM run_summaries ORDER BY run_id"),
    }));
    store.close();

    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    assert.equal(store.status().modules.outcomes, "ready");
    const later = store.read(db => ({
      outcomes: db.all("SELECT * FROM outcomes ORDER BY outcome_id"),
      summaries: db.all("SELECT * FROM run_summaries ORDER BY run_id"),
    }));
    const withoutRefs = (row: Record<string, unknown>) => {
      const { goal_ref: _goal, mission_ref: _mission, point: _point, feature_map_ref: _featureMap, owner_score: _score, ...rest } = row;
      return { ...rest };
    };
    assert.equal(later.outcomes.length, earlier.outcomes.length);
    assert.equal(later.summaries.length, earlier.summaries.length);
    earlier.outcomes.forEach((row, index) => assert.deepEqual(withoutRefs(later.outcomes[index]!), { ...row }));
    earlier.summaries.forEach((row, index) => assert.deepEqual(withoutRefs(later.summaries[index]!), { ...row }));
    const stored = store.read(db => db.get<{ version: number; read_version: number }>(
      "SELECT version, read_version FROM schema_modules WHERE name='outcomes'",
    ));
    assert.deepEqual({ ...stored }, { version: 4, read_version: 2 });

    const refs = store.read(db => ({
      goal: db.index("goal", GOAL),
      mission: db.index("mission", MISSION),
      summary: db.get<{ goal_ref: string | null; mission_ref: string | null }>(
        "SELECT goal_ref, mission_ref FROM run_summaries WHERE run_id='run-1'",
      ),
      withMission: db.get<{ goal_ref: string | null; mission_ref: string | null }>(
        "SELECT goal_ref, mission_ref FROM outcomes WHERE outcome_id='run-1:member-1'",
      ),
      plain: db.get<{ goal_ref: string | null; mission_ref: string | null }>(
        "SELECT goal_ref, mission_ref FROM outcomes WHERE outcome_id='run-2:member-1'",
      ),
      damaged: db.get<{ goal_ref: string | null; mission_ref: string | null }>(
        "SELECT goal_ref, mission_ref FROM outcomes WHERE outcome_id='run-3:member-1'",
      ),
      lines: db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_lines'"),
    }));
    assert.equal(refs.summary?.goal_ref, refs.goal);
    assert.equal(refs.summary?.mission_ref, null);
    assert.equal(refs.withMission?.mission_ref, refs.mission);
    assert.equal(refs.withMission?.goal_ref, null);
    assert.deepEqual({ ...refs.plain }, { goal_ref: null, mission_ref: null });
    assert.deepEqual({ ...refs.damaged }, { goal_ref: "unreadable", mission_ref: "unreadable" });
    assert.equal(refs.lines?.name, "legacy_lines");
  } finally {
    store?.close();
    f.close();
  }
});

test("writes keep the goal and mission indexes", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, rowIn("run-1", "member-1", GOAL, MISSION));
      writeSummary(tx, summaryWith("run-1", GOAL, MISSION));
    });
    const dump = JSON.stringify(store.read(db => [db.all("SELECT * FROM outcomes"), db.all("SELECT * FROM run_summaries")]));
    assert.ok(!dump.includes(GOAL), "the goal id is in a plain column");
    assert.ok(!dump.includes(MISSION), "the mission id is in a plain column");

    const written = store.read(db => ({
      row: db.get<{ goal_ref: string | null; mission_ref: string | null }>("SELECT goal_ref, mission_ref FROM outcomes WHERE outcome_id='run-1:member-1'"),
      summary: db.get<{ goal_ref: string | null; mission_ref: string | null }>("SELECT goal_ref, mission_ref FROM run_summaries WHERE run_id='run-1'"),
      goal: db.index("goal", GOAL),
      mission: db.index("mission", MISSION),
    }));
    assert.deepEqual({ ...written.row }, { goal_ref: written.goal, mission_ref: written.mission });
    assert.deepEqual({ ...written.summary }, { goal_ref: written.goal, mission_ref: written.mission });

    store.write(tx => {
      writeOutcome(tx, rowIn("run-1", "member-1"));
      writeSummary(tx, summaryWith("run-1"));
    });
    const cleared = store.read(db => ({
      row: db.get<{ goal_ref: string | null; mission_ref: string | null }>("SELECT goal_ref, mission_ref FROM outcomes WHERE outcome_id='run-1:member-1'"),
      summary: db.get<{ goal_ref: string | null; mission_ref: string | null }>("SELECT goal_ref, mission_ref FROM run_summaries WHERE run_id='run-1'"),
    }));
    assert.deepEqual({ ...cleared.row }, { goal_ref: null, mission_ref: null });
    assert.deepEqual({ ...cleared.summary }, { goal_ref: null, mission_ref: null });
  } finally {
    store?.close();
    f.close();
  }
});

test("roll-up records follow the goal through summaries and rows", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeSummary(tx, summaryWith("R1", GOAL));
      writeOutcome(tx, rowIn("R1", "m1", GOAL));
      writeOutcome(tx, rowIn("R1", "m2", GOAL));
      writeOutcome(tx, rowIn("R1", "m3"));
      writeMemberResult(tx, memberRow("R1", "member-4"));
      writeSummary(tx, summaryWith("R2"));
      writeOutcome(tx, rowIn("R2", "m1", GOAL));
      writeSummary(tx, summaryWith("R3", OTHER_GOAL));
      writeOutcome(tx, rowIn("R3", "m1", OTHER_GOAL));
      writeOutcome(tx, rowIn("R4", "m1", undefined, MISSION));
    });
    const goal = store.read(db => rollupRecords(db, "goal", db.index("goal", GOAL)));
    assert.deepEqual(goal.runIds, ["R1", "R2"]);
    assert.equal(goal.summaries.length, 2);
    assert.equal(goal.rows.length, 4);
    assert.equal(goal.members.length, 1);
    assert.deepEqual(goal.unreadable, { summaries: 0, rows: 0, members: 0 });

    const other = store.read(db => rollupRecords(db, "goal", db.index("goal", OTHER_GOAL)));
    assert.deepEqual(other.runIds, ["R3"]);

    const mission = store.read(db => rollupRecords(db, "mission", db.index("mission", MISSION)));
    assert.deepEqual(mission.runIds, ["R4"]);
    const wrongColumn = store.read(db => rollupRecords(db, "mission", db.index("goal", GOAL)));
    assert.deepEqual(wrongColumn.runIds, []);
  } finally {
    store?.close();
    f.close();
  }
});

test("roll-up records count unreadable payloads", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeSummary(tx, summaryWith("R1", GOAL));
      writeOutcome(tx, rowIn("R1", "m1", GOAL));
      writeOutcome(tx, rowIn("R1", "m2", GOAL));
      writeOutcome(tx, rowIn("R1", "m3"));
    });
    const goal = (db: EvidenceDb) => rollupRecords(db, "goal", db.index("goal", GOAL));

    store.write(tx => tx.run("UPDATE outcomes SET payload='x' WHERE outcome_id='R1:m1'"));
    const damagedRow = store.read(goal);
    assert.equal(damagedRow.unreadable.rows, 1);
    assert.deepEqual(damagedRow.rows.map(row => row.outcomeId), ["R1:m2", "R1:m3"]);

    store.write(tx => tx.run("UPDATE run_summaries SET payload='x' WHERE run_id='R1'"));
    const damagedSummary = store.read(goal);
    assert.equal(damagedSummary.unreadable.summaries, 1);
    assert.deepEqual(damagedSummary.summaries, []);
    assert.deepEqual(damagedSummary.runIds, ["R1"]);

    assert.equal(damagedSummary.unindexed, 0);
    store.write(tx => tx.run("UPDATE outcomes SET goal_ref='unreadable' WHERE outcome_id='R1:m3'"));
    assert.equal(store.read(goal).unindexed, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("legacy lines round-trip sealed", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const hash = "f".repeat(64);
    const state: LegacyLineState = { state: "imported", lineHash: hash, recordedAt: NOW };
    const ref = store.read(db => db.index("legacy", "op-line-1"));
    store.write(tx => writeLegacyLine(tx, ref, state));

    const absent = store.read(db => db.index("legacy", "op-line-absent"));
    const read = store.read(db => readLegacyLines(db, [ref, absent]));
    assert.deepEqual(read.get(ref), state);
    assert.equal(read.has(absent), false);
    const raw = JSON.stringify(store.read(db => db.all("SELECT * FROM legacy_lines")));
    assert.ok(!raw.includes(hash), "the line hash is in a plain column");

    store.write(tx => tx.run("UPDATE legacy_lines SET payload='x' WHERE line_ref=?", ref));
    assert.throws(
      () => store?.read(db => readLegacyLines(db, [ref])),
      error => error instanceof EvidenceError && error.code === "unavailable",
    );
  } finally {
    store?.close();
    f.close();
  }
});

test("a legacy row is never a run", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const outcomes = outcomeModule({ now: () => NOW });
    store.register(outcomes);
    const legacy = outcomeRow({
      outcomeId: "legacy-run-1:op-line-1",
      source: "legacy",
      runId: "legacy-run-1",
      memberId: "op-line-1",
      runDeletedAt: "2026-11-13T10:00:00.000Z",
    });
    const production = outcomeRow();
    store.write(tx => {
      writeOutcome(tx, legacy);
      writeOutcome(tx, production);
    });

    const listed = store.read(db => outcomes.runIds?.(db) ?? []);
    assert.ok(!listed.includes("legacy-run-1"), "a legacy run is listed as a run");

    assert.equal(sweepExpiredOutcomes(store, NOW), 0);
    store.sweep(() => false);
    assert.equal(store.read(db => readOutcome(db, legacy.outcomeId))?.source, "legacy");

    store.write(tx => writeSummary(tx, summaryRow(production.runId, { approvedAt: "2026-11-13T12:00:00.000Z" })));
    const candidates = store.read(db => landingCandidates(db, db.index("project", legacy.payload.projectId), "1970-01-01T00:00:00.000Z"));
    assert.deepEqual(candidates.map(candidate => candidate.runId), [production.runId]);

    assert.equal(store.write(tx => deleteLegacyOutcome(tx, production.outcomeId)), false);
    assert.equal(store.read(db => readOutcome(db, production.outcomeId))?.source, "production");
    assert.equal(store.write(tx => deleteLegacyOutcome(tx, legacy.outcomeId)), true);
    assert.equal(store.read(db => readOutcome(db, legacy.outcomeId)), undefined);
  } finally {
    store?.close();
    f.close();
  }
});

test("retention removes legacy rows and lines on their recorded time", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    const expired = "2024-01-01T00:00:00.000Z";
    const kept = "2025-06-01T00:00:00.000Z";
    const late = "2025-12-31T00:00:00.001Z";
    store.write(tx => {
      writeOutcome(tx, outcomeRow({
        outcomeId: "legacy-old:op-1",
        source: "legacy",
        runId: "legacy-old",
        memberId: "op-1",
        runDeletedAt: expired,
      }));
      writeLegacyLine(tx, "line-old", { state: "imported", lineHash: "a".repeat(64), recordedAt: expired });
      writeLegacyLine(tx, "line-kept", { state: "imported", lineHash: "b".repeat(64), recordedAt: kept });
    });

    assert.equal(sweepExpiredOutcomes(store, late), 1);
    assert.equal(store.read(db => readOutcome(db, "legacy-old:op-1")), undefined);
    assert.equal(store.read(db => legacyLineCount(db)), 1);

    store.write(tx => {
      writeLegacyLine(tx, "line-expired-a", { state: "imported", lineHash: "c".repeat(64), recordedAt: expired });
      writeLegacyLine(tx, "line-expired-b", { state: "imported", lineHash: "d".repeat(64), recordedAt: expired });
    });
    assert.equal(store.read(db => legacyLineCount(db)), 3);
    sweepExpiredOutcomes(store, late, 1);
    assert.equal(store.read(db => legacyLineCount(db)), 2);
    sweepExpiredOutcomes(store, late);
    assert.equal(store.read(db => legacyLineCount(db)), 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("the module reports legacy counts", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, outcomeRow({ outcomeId: "legacy-run-1:op-1", source: "legacy", runId: "legacy-run-1", memberId: "op-1" }));
      writeOutcome(tx, outcomeRow({ outcomeId: "legacy-run-1:op-2", source: "legacy", runId: "legacy-run-1", memberId: "op-2" }));
      writeOutcome(tx, outcomeRow());
      for (const ref of ["line-1", "line-2", "line-3"]) {
        writeLegacyLine(tx, ref, { state: "imported", lineHash: null, recordedAt: NOW });
      }
    });
    const counts = store.describe().counts;
    assert.equal(counts["outcomes.legacy"], 2);
    assert.equal(counts["outcomes.outcomes"], 1);
    assert.equal(counts["outcomes.legacyLines"], 3);
  } finally {
    store?.close();
    f.close();
  }
});

const T_IN = "2026-11-13T11:00:00.000Z";
const T_OLD = "2026-10-01T00:00:00.000Z";
const ROUTE_SINCE = "2026-11-12T00:00:00.000Z";

function plainPayload(overrides: Partial<OutcomePayload> = {}): OutcomePayload {
  const payload: OutcomePayload = { ...outcomeRow().payload, ...overrides };
  if (!("ownerRating" in overrides)) delete payload.ownerRating;
  return payload;
}

function outcomesVersion3(): EvidenceModule {
  const version2 = outcomesVersion2();
  return {
    name: "outcomes",
    version: 3,
    readVersion: 2,
    migrate(tx, from) {
      version2.migrate(tx, from);
      tx.exec("ALTER TABLE outcomes ADD COLUMN goal_ref TEXT");
      tx.exec("ALTER TABLE outcomes ADD COLUMN mission_ref TEXT");
      tx.exec("ALTER TABLE run_summaries ADD COLUMN goal_ref TEXT");
      tx.exec("ALTER TABLE run_summaries ADD COLUMN mission_ref TEXT");
      tx.exec(
        "CREATE TABLE IF NOT EXISTS legacy_lines (line_ref TEXT PRIMARY KEY, state TEXT NOT NULL, "
        + "recorded_at TEXT NOT NULL, payload TEXT NOT NULL)",
      );
      tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_goal ON outcomes (goal_ref)");
      tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_mission ON outcomes (mission_ref)");
      tx.exec("CREATE INDEX IF NOT EXISTS run_summaries_by_goal ON run_summaries (goal_ref)");
      tx.exec("CREATE INDEX IF NOT EXISTS run_summaries_by_mission ON run_summaries (mission_ref)");
      tx.exec("CREATE INDEX IF NOT EXISTS legacy_lines_by_recorded ON legacy_lines (recorded_at)");
    },
  };
}

function insertOutcomeAtVersion3(
  tx: EvidenceTx,
  row: { outcomeId: string; runId: string; memberId: string; source: string; role: string; sealed: string; attemptIndex?: number },
): void {
  tx.run(
    "INSERT INTO outcomes (outcome_id, source, project_ref, task_ref, run_id, revision, member_id, attempt_index, "
    + "inherited, role, profile_id, provider, model, profile_epoch, area_ref, risk, feature_version, disposition, "
    + "flags, integrated, accepted, acceptance, first_pass, payload) "
    + "VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?, 'profile-a', 'opencode', 'model-one', 1, ?, 'low', 1, 'completed', '', 1, 1, 1, 1, ?)",
    row.outcomeId,
    row.source,
    tx.index("project", "example"),
    tx.index("task", "task-a"),
    row.runId,
    row.memberId,
    row.attemptIndex ?? 1,
    row.role,
    tx.index("area", "packages/host"),
    row.sealed,
  );
}

type Replaces = OutcomePayload["replaces"];

function routingRow(runId: string, memberId: string, replaces?: Replaces, score?: number): OutcomeRow {
  const overrides: Partial<OutcomePayload> = {};
  if (replaces !== undefined) overrides.replaces = replaces;
  if (score !== undefined) overrides.ownerRating = { score, at: T_EARLY };
  return outcomeRow({ outcomeId: `${runId}:${memberId}`, runId, memberId, payload: plainPayload(overrides) });
}

function routingOf(store: EvidenceStore): Record<string, { point: string | null; owner_score: number | null }> {
  const rows = store.read(db => db.all<{ outcome_id: string; point: string | null; owner_score: number | null }>(
    "SELECT outcome_id, point, owner_score FROM outcomes ORDER BY outcome_id",
  ));
  return Object.fromEntries(rows.map(row => [row.outcome_id, { point: row.point, owner_score: row.owner_score }]));
}

test("a version 3 store migrates to version 4 and fills the routing columns", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomesVersion3());
    const seeded: { runId: string; memberId: string; source: string; role: string; payload: OutcomePayload | "x"; attemptIndex?: number }[] = [
      { runId: "run-10", memberId: "s1", source: "production", role: "implementer", payload: plainPayload(), attemptIndex: 0 },
      { runId: "run-10", memberId: "r1", source: "production", role: "implementer", payload: plainPayload({ replaces: { memberId: "s1", cause: "stall" } }) },
      { runId: "run-1", memberId: "m1", source: "production", role: "implementer", payload: plainPayload() },
      { runId: "run-1", memberId: "m2", source: "production", role: "implementer", payload: plainPayload({ replaces: { memberId: "m1", cause: "stall" } }) },
      { runId: "run-1", memberId: "m3", source: "production", role: "implementer", payload: plainPayload({ replaces: { memberId: "m2", cause: "escalation" } }) },
      { runId: "run-1", memberId: "m4", source: "production", role: "implementer", payload: plainPayload({ replaces: { memberId: "m3", cause: "stall" } }) },
      { runId: "run-2", memberId: "m1", source: "production", role: "implementer", payload: plainPayload({ replaces: { memberId: "ghost", cause: "stall" } }) },
      { runId: "run-3", memberId: "m1", source: "production", role: "scout", payload: plainPayload() },
      { runId: "run-4", memberId: "m1", source: "legacy", role: "implementer", payload: plainPayload({ legacy: { id: "old-1", result: "accepted", attempts: 1 } }) },
      { runId: "run-5", memberId: "m1", source: "production", role: "implementer", payload: plainPayload({ ownerRating: { score: 4, at: T_EARLY } }) },
      { runId: "run-6", memberId: "m1", source: "production", role: "implementer", payload: "x" },
    ];
    store.write(tx => {
      for (const row of [...seeded].reverse()) {
        const outcomeId = `${row.runId}:${row.memberId}`;
        insertOutcomeAtVersion3(tx, {
          outcomeId,
          runId: row.runId,
          memberId: row.memberId,
          source: row.source,
          role: row.role,
          sealed: row.payload === "x" ? "x" : tx.seal("outcomes", outcomeId, row.payload),
          attemptIndex: row.attemptIndex,
        });
      }
    });
    const earlier = store.read(db => db.all("SELECT * FROM outcomes ORDER BY outcome_id"));
    store.close();

    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    assert.equal(store.status().modules.outcomes, "ready");
    const later = store.read(db => db.all("SELECT * FROM outcomes ORDER BY outcome_id"));
    const withoutRouting = (row: Record<string, unknown>) => {
      const { point: _point, feature_map_ref: _featureMap, owner_score: _score, ...rest } = row;
      return { ...rest };
    };
    assert.equal(later.length, earlier.length);
    earlier.forEach((row, index) => assert.deepEqual(withoutRouting(later[index]!), { ...row }));
    const stored = store.read(db => db.get<{ version: number; read_version: number }>(
      "SELECT version, read_version FROM schema_modules WHERE name='outcomes'",
    ));
    assert.deepEqual({ ...stored }, { version: 4, read_version: 2 });

    const migrated = store.read(db => ({
      featureMap: db.index("feature-map", "map-1"),
      rows: db.all<{ outcome_id: string; point: string | null; feature_map_ref: string | null; owner_score: number | null }>(
        "SELECT outcome_id, point, feature_map_ref, owner_score FROM outcomes ORDER BY outcome_id",
      ),
    }));
    assert.deepEqual(Object.fromEntries(migrated.rows.map(row => [row.outcome_id, row.point])), {
      "run-1:m1": "start",
      "run-1:m2": "start",
      "run-1:m3": "escalation",
      "run-1:m4": "escalation",
      "run-2:m1": null,
      "run-3:m1": null,
      "run-4:m1": null,
      "run-5:m1": "start",
      "run-6:m1": null,
      "run-10:s1": null,
      "run-10:r1": null,
    });
    assert.deepEqual(Object.fromEntries(migrated.rows.map(row => [row.outcome_id, row.owner_score])), {
      "run-1:m1": null,
      "run-1:m2": null,
      "run-1:m3": null,
      "run-1:m4": null,
      "run-2:m1": null,
      "run-3:m1": null,
      "run-4:m1": null,
      "run-5:m1": 4,
      "run-6:m1": null,
      "run-10:s1": null,
      "run-10:r1": null,
    });
    for (const row of migrated.rows) {
      assert.equal(row.feature_map_ref, row.outcome_id === "run-6:m1" ? "unreadable" : migrated.featureMap);
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("writes keep the routing columns", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, routingRow("run-1", "m1"));
      writeOutcome(tx, routingRow("run-1", "m2", { memberId: "m1", cause: "escalation" }));
      writeOutcome(tx, routingRow("run-1", "m3", { memberId: "m2", cause: "stall" }));
      writeOutcome(tx, { ...routingRow("run-2", "m1"), point: "escalation" } as OutcomeRow);
    });
    assert.deepEqual(routingOf(store), {
      "run-1:m1": { point: "start", owner_score: null },
      "run-1:m2": { point: "escalation", owner_score: null },
      "run-1:m3": { point: "escalation", owner_score: null },
      "run-2:m1": { point: "start", owner_score: null },
    });

    store.write(tx => writeOutcome(tx, routingRow("run-1", "m1", undefined, 2)));
    assert.deepEqual(routingOf(store)["run-1:m1"], { point: "start", owner_score: 2 });
  } finally {
    store?.close();
    f.close();
  }
});

test("a row at attempt zero has no point, and its replacement inherits none", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      writeOutcome(tx, { ...routingRow("run-1", "s1"), attemptIndex: 0 });
      writeOutcome(tx, { ...routingRow("run-1", "r1", { memberId: "s1", cause: "stall" }), attemptIndex: 2 });
    });
    assert.deepEqual(routingOf(store), {
      "run-1:r1": { point: null, owner_score: null },
      "run-1:s1": { point: null, owner_score: null },
    });
  } finally {
    store?.close();
    f.close();
  }
});

type EvidenceSpec = { runId: string; source?: string; model?: string; effort?: string | null; escalation?: boolean; endedAt: string; configId?: string | null };
function evidenceRow(spec: EvidenceSpec): OutcomeRow {
  return outcomeRow({
    outcomeId: `${spec.runId}:m1`,
    runId: spec.runId,
    memberId: "m1",
    source: spec.source ?? "production",
    model: spec.model ?? "model-one",
    effort: spec.effort === undefined ? "high" : spec.effort,
    configId: spec.configId ?? null,
    endedAt: spec.endedAt,
    payload: plainPayload(spec.escalation ? { replaces: { memberId: "m0", cause: "escalation" } } : {}),
  });
}

const IDENTITY_A = { provider: "opencode", model: "model-one", effort: "high" };
const IDENTITY_C = { provider: "opencode", model: "model-one", effort: null };
const IDENTITY_BIG = { provider: "opencode", model: "model-big", effort: "high" };

test("routing evidence reads one identity and point, newest first, within its limit", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    store.write(tx => {
      tx.run(
        "INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
        + "VALUES ('cfg-1', 'opencode', 'model-one', 'high', 'pv-1', 'g', 'k', 'r', 's', ?)",
        NOW,
      );
      const specs: EvidenceSpec[] = [
        { runId: "run-a1", endedAt: T_IN, configId: "cfg-1" },
        { runId: "run-a2", source: "duel", endedAt: T_IN },
        { runId: "run-a3", endedAt: T_OLD },
        { runId: "run-a4", source: "replay", endedAt: T_IN },
        { runId: "run-a5", source: "legacy", endedAt: T_IN },
        { runId: "run-a6", escalation: true, endedAt: T_IN, configId: "cfg-missing" },
        { runId: "run-b1", model: "model-two", endedAt: T_IN },
        { runId: "run-c1", effort: null, endedAt: T_IN, configId: "cfg-missing" },
      ];
      for (const spec of specs) writeOutcome(tx, evidenceRow(spec));
      for (let index = 0; index <= ROUTING_ROWS_PER_SOURCE; index++) {
        writeOutcome(tx, outcomeRow({
          outcomeId: `run-big-${index}:m1`,
          runId: `run-big-${index}`,
          memberId: "m1",
          model: "model-big",
          endedAt: new Date(Date.parse(T_IN) + index * 1000).toISOString(),
          payload: plainPayload(),
        }));
      }
    });

    const reads = store.read(db => ({
      start: selectRoutingEvidence(db, IDENTITY_A, "start", ROUTE_SINCE),
      escalation: selectRoutingEvidence(db, IDENTITY_A, "escalation", ROUTE_SINCE),
      nullEffort: selectRoutingEvidence(db, IDENTITY_C, "start", ROUTE_SINCE),
      otherModel: selectRoutingEvidence(db, { ...IDENTITY_A, model: "model-two" }, "start", ROUTE_SINCE),
      big: selectRoutingEvidence(db, IDENTITY_BIG, "start", ROUTE_SINCE),
    }));
    const summary = (rows: { outcomeId: string; source: string; promptVersion: string | null }[]) =>
      rows.map(row => ({ id: row.outcomeId, source: row.source, promptVersion: row.promptVersion }));
    assert.deepEqual(summary(reads.start), [
      { id: "run-a1:m1", source: "production", promptVersion: "pv-1" },
      { id: "run-a2:m1", source: "duel", promptVersion: null },
    ]);
    assert.deepEqual(summary(reads.escalation), [{ id: "run-a6:m1", source: "production", promptVersion: null }]);
    assert.deepEqual(summary(reads.nullEffort), [{ id: "run-c1:m1", source: "production", promptVersion: null }]);
    assert.deepEqual(summary(reads.otherModel), [{ id: "run-b1:m1", source: "production", promptVersion: null }]);
    for (const row of [...reads.start, ...reads.escalation]) assert.ok(Array.isArray(row.flags), row.outcomeId);
    const bigIds = reads.big.map(row => row.outcomeId);
    assert.equal(bigIds.length, ROUTING_ROWS_PER_SOURCE);
    assert.ok(bigIds.includes("run-big-1000:m1"));
    assert.ok(!bigIds.includes("run-big-0:m1"));
  } finally {
    store?.close();
    f.close();
  }
});

test("routing evidence reads seek the route index", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    const plan = (params: (string | number | null)[]) => store!.read(db => db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${ROUTING_EVIDENCE_SQL}`,
      ...params,
    ).map(row => row.detail));
    const withEffort = plan(["production", "start", "opencode", "model-one", "high", ROUTE_SINCE, ROUTING_ROWS_PER_SOURCE]);
    const withoutEffort = plan(["production", "start", "opencode", "model-one", null, ROUTE_SINCE, ROUTING_ROWS_PER_SOURCE]);
    for (const details of [withEffort, withoutEffort]) {
      assert.ok(details.some(line => line.includes("SEARCH o USING INDEX outcomes_by_route")), details.join("\n"));
      assert.ok(details.some(line => /SEARCH c USING .*INDEX/.test(line)), details.join("\n"));
      assert.ok(!details.some(line => line.startsWith("SCAN o")), details.join("\n"));
      assert.ok(!details.some(line => line.includes("USE TEMP B-TREE")), details.join("\n"));
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("migration gives no point to a replacement cycle or to a chain past 64 hops, and an older host leaves the module unavailable", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(outcomesVersion3());
    const seeded: { runId: string; memberId: string; payload: OutcomePayload | "x" }[] = [
      { runId: "run-7", memberId: "m1", payload: plainPayload({ replaces: { memberId: "m2", cause: "stall" } }) },
      { runId: "run-7", memberId: "m2", payload: plainPayload({ replaces: { memberId: "m1", cause: "stall" } }) },
      { runId: "run-9", memberId: "m1", payload: "x" },
      { runId: "run-9", memberId: "m2", payload: plainPayload({ replaces: { memberId: "m1", cause: "stall" } }) },
      { runId: "run-9", memberId: "m3", payload: plainPayload({ replaces: { memberId: "m1", cause: "escalation" } }) },
      { runId: "run-8", memberId: "c0", payload: plainPayload() },
    ];
    for (let k = 1; k <= 65; k++) seeded.push({ runId: "run-8", memberId: `c${k}`, payload: plainPayload({ replaces: { memberId: `c${k - 1}`, cause: "stall" } }) });
    store.write(tx => {
      for (const row of seeded) {
        const outcomeId = `${row.runId}:${row.memberId}`;
        insertOutcomeAtVersion3(tx, { outcomeId, runId: row.runId, memberId: row.memberId, source: "production", role: "implementer",
          sealed: row.payload === "x" ? "x" : tx.seal("outcomes", outcomeId, row.payload) });
      }
    });
    store.close();
    store = open(f);
    store.register(outcomeModule({ now: () => NOW }));
    assert.equal(store.status().modules.outcomes, "ready");
    const points = routingOf(store);
    assert.deepEqual([points["run-7:m1"]!.point, points["run-7:m2"]!.point], [null, null]);
    assert.deepEqual([points["run-9:m2"]!.point, points["run-9:m3"]!.point], [null, "escalation"]);
    assert.equal(points["run-8:c64"]!.point, "start");
    assert.equal(points["run-8:c65"]!.point, null);
    store.write(tx => writeOutcome(tx, routingRow("run-9", "m4", { memberId: "m1", cause: "stall" })));
    assert.equal(routingOf(store)["run-9:m4"]!.point, null);
    store.write(tx => {
      tx.run("UPDATE outcomes SET payload='x' WHERE outcome_id='run-8:c0'");
      writeOutcome(tx, routingRow("run-8", "d1", { memberId: "c0", cause: "answer" }));
    });
    assert.equal(routingOf(store)["run-8:d1"]!.point, "start");
    store.close();
    store = open(f);
    store.register(outcomesVersion3());
    assert.equal(store.status().modules.outcomes, "unavailable");
  } finally {
    store?.close();
    f.close();
  }
});

test("a route read maps every column, includes rows ended at since, and sorts by outcome id", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(configurationModule());
    store.register(outcomeModule({ now: () => NOW }));
    assert.equal(ROUTING_ROWS_PER_SOURCE, 1000);
    store.write(tx => {
      tx.run(
        "INSERT INTO configurations (config_id, provider, model, effort, prompt_version, guidance, knowledge, routing, shape, first_seen_at) "
        + "VALUES ('cfg-1', 'opencode', 'model-one', 'high', 'pv-1', 'g', 'k', 'r', 's', ?)", NOW);
      writeOutcome(tx, outcomeRow({
        outcomeId: "run-z:m1", runId: "run-z", memberId: "m1", kind: "bugfix", featureVersion: 3,
        disposition: "integrated", integrated: 1, accepted: 0, firstPass: 0, held: 1, profileEpoch: 2, configId: "cfg-1",
        flags: ["same-model-review"], endedAt: ROUTE_SINCE, frozenAt: T_IN,
        payload: plainPayload({ featureMap: "map-2", ownerRating: { score: 5, at: T_EARLY } }),
      }));
      writeOutcome(tx, outcomeRow({ outcomeId: "run-a:m1", runId: "run-a", memberId: "m1", source: "duel", endedAt: T_IN, payload: plainPayload() }));
    });
    const read = store.read(db => ({ rows: selectRoutingEvidence(db, IDENTITY_A, "start", ROUTE_SINCE), map2: db.index("feature-map", "map-2"), map1: db.index("feature-map", "map-1"), project: db.index("project", "example"), area: db.index("area", "packages/host") }));
    assert.deepEqual(read.rows.map(row => row.outcomeId), ["run-a:m1", "run-z:m1"]);
    assert.deepEqual({ ...read.rows[1] }, {
      outcomeId: "run-z:m1", source: "production", projectRef: read.project, areaRef: read.area, provider: "opencode", model: "model-one",
      effort: "high", profileEpoch: 2, kind: "bugfix", featureVersion: 3, disposition: "integrated", exclusion: null,
      flags: ["same-model-review"], integrated: 1, accepted: 0, firstPass: 0, held: 1, endedAt: ROUTE_SINCE, frozenAt: T_IN,
      point: "start", featureMapRef: read.map2, ownerScore: 5, promptVersion: "pv-1",
    });
    assert.equal(read.rows[0]!.featureMapRef, read.map1);
  } finally {
    store?.close();
    f.close();
  }
});
