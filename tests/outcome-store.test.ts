import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemberResultRow,
  type OutcomeRow,
  outcomeModule,
  readMemberResult,
  readOutcome,
  readSummary,
  type RunSummaryRow,
  runOutcomeView,
  runOutcomes,
  sweepExpiredOutcomes,
  writeMemberResult,
  writeOutcome,
  writeSummary,
} from "../packages/host/src/outcome-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";

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

/** Appends one event for a run, as the outbox does, and returns its seq. */
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
    // seq 1 to 3 belong to another run, seq 4 and 6 are R's, and seq 5 is S's. The projector has reached seq 5.
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

    // run-s has events only at or below last_seq, so it gains no gap.
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
    // T has rows and no events.
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

    // Two years, less one day, is not enough: 730 days after 2024-01-01 is 2025-12-31.
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
