import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "../packages/host/src/evidence/types.js";
import {
  GroupPass,
  GROUP_BATCH,
  LANDINGS_DUE_SQL,
  LINEAGE_SQL,
  ROOT_TASKS_SQL,
  applyDuplicateRule,
  lineageRoots,
  mergeRoots,
  recordLanding,
  rootOf,
  runGroupId,
  sweepGroups,
} from "../packages/host/src/eval-groups.js";
import {
  capturedTaskId,
  completeMaterial,
  evalCorpusModule,
  insertMarker,
  pathRef,
  readEvalTask,
  readMaterial,
  reconcileBatch,
} from "../packages/host/src/eval-store.js";
import { TRIAL_TASKS_SQL, drawsHoldout } from "../packages/host/src/eval-sets.js";
import type { CaptureStart, Capsule, EvalFeatures } from "../packages/host/src/eval-types.js";
import { insertMined, minedTaskId, placeMined, type MinedCandidate } from "../packages/host/src/eval-miner.js";
import { landingSignalId } from "../packages/host/src/outcome-signals.js";
import { outcomeModule, writeSignal, type SignalRow } from "../packages/host/src/outcome-store.js";
import type { TeamRun } from "../packages/host/src/team-types.js";

const PROJECT = "project-a";
const RUN = "run-1";
const MEMBER = "member-a";
const WORKSPACE = "/unused/workspace";
const ANCHOR = "a".repeat(40);
const MEMBER_BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);
/** The commit that the mined copy and the run's landing share. */
const LANDED = "e".repeat(40);
const OTHER_LANDING = "f".repeat(40);
const SRC = "src/a.ts";
const TEST_A = "tests/a.test.ts";
const TEST_B = "tests/b.test.ts";
const LIB_C = "lib/c.ts";
const TEST_C = "tests/c.test.ts";

const COMMIT_AT = "2026-11-13T10:00:00.000Z";
/** Six days before the commit: the captured row, inside the 90-day lineage window. */
const CAPTURED_AT = "2026-11-07T10:00:00.000Z";
/** Five days before the commit: the approval. */
const APPROVED_AT = "2026-11-08T10:00:00.000Z";
/** Ninety-one days before the commit: outside the window. */
const OLD_CAPTURED_AT = "2026-08-14T10:00:00.000Z";
const OLD_APPROVED_AT = "2026-08-15T10:00:00.000Z";
const LATE_APPROVED_AT = "2026-11-14T10:00:00.000Z";
const NOW = "2026-11-16T12:00:00.000Z";

const FEATURES: EvalFeatures = { role: "implementer", area: "host", kind: "feature", risk: "normal", featureVersion: 1 };
const CAPSULE: Capsule = {
  objective: "Ship the scheduler",
  steering: [],
  ownerAnswers: [],
  task: { id: "a", title: "Task a", instructions: "Do a", paths: ["a.txt"] },
};

function open(): { store: EvidenceStore; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-groups-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(outcomeModule({ now: () => NOW }));
  store.register(evalCorpusModule(store, () => NOW));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function startOf(runId: string, at: string): CaptureStart {
  return {
    runId,
    memberId: MEMBER,
    projectId: PROJECT,
    workspace: WORKSPACE,
    anchorCommit: ANCHOR,
    memberBaseCommit: MEMBER_BASE,
    commit: COMMIT,
    integratedHead: HEAD,
    at,
    uiChanges: false,
    capsule: CAPSULE,
  };
}

/** A captured row with stored material on `files`, in the same write. Returns its task id. */
function captureTx(tx: EvidenceTx, runId: string, files: string[], at: string): string {
  const taskId = capturedTaskId(runId, MEMBER);
  insertMarker(tx, startOf(runId, at), { state: "captured", capsule: CAPSULE }, at);
  completeMaterial(tx, taskId, {
    kind: "store",
    files,
    hiddenFiles: [],
    baseDelta: { state: "none" },
    reference: { state: "stored", bytes: Buffer.from("patch") },
    base: "proven",
  }, at);
  return taskId;
}

/** The approval of a captured row: its `approved_at` is what lineage reads. */
function approveTx(tx: EvidenceTx, taskId: string, at: string): void {
  tx.run("UPDATE eval_tasks SET approval = 'read', approved_at = ? WHERE task_id = ?", at, taskId);
}

function minedInput(commit: string, files: string[]): MinedCandidate {
  return {
    kind: "candidate", projectId: PROJECT, commit, parent: ANCHOR, commitTime: COMMIT_AT, capsule: CAPSULE,
    promptOrigin: "commit-message", files, hiddenFiles: [], features: FEATURES,
  };
}

/** A mined candidate of `commit`, written by Task 5's `insertMined` with its own group. Returns its task id. */
function insertMinedTx(tx: EvidenceTx, commit: string, files: string[], at: string): string {
  insertMined(tx, minedInput(commit, files), at);
  return minedTaskId(tx.index("project", PROJECT), tx.index("eval-commit", commit));
}

/** The mining step of one commit, as the miner writes it: the insert, then Task 5's `placeMined` in the same write. */
function mineTx(tx: EvidenceTx, commit: string, files: string[], at: string): string {
  const taskId = insertMinedTx(tx, commit, files, at);
  placeMined(tx, minedInput(commit, files), at);
  return taskId;
}

function landTx(tx: EvidenceTx, runId: string, commit: string, at: string): boolean {
  return recordLanding(tx, {
    projectRef: tx.index("project", PROJECT),
    groupId: runGroupId(runId),
    landingRef: tx.index("eval-commit", commit),
    at,
  });
}

/** The promotion step: every captured row of the pass becomes a candidate, with the duplicate rule on promotion. */
function promoteTx(tx: EvidenceTx): void {
  reconcileBatch(
    tx,
    () => ({ kind: "candidate" as const, features: FEATURES }),
    NOW,
    GROUP_BATCH,
    (inner, task) => {
      applyDuplicateRule(inner, rootOf(inner, task.groupId ?? runGroupId(task.runId)), NOW);
    },
  );
}

/** Rows that break the invariant: a root holding a captured candidate or valid row and a mined candidate or valid row. */
function invariantBreaches(db: EvidenceDb): number {
  return db.get<{ n: number }>(
    "SELECT count(*) AS n FROM eval_groups g WHERE g.root_id = g.group_id "
    + "AND EXISTS (SELECT 1 FROM eval_tasks t JOIN eval_groups h ON h.group_id = t.group_id "
    + "WHERE h.root_id = g.group_id AND t.origin = 'captured' AND t.state IN ('candidate', 'valid')) "
    + "AND EXISTS (SELECT 1 FROM eval_tasks t JOIN eval_groups h ON h.group_id = t.group_id "
    + "WHERE h.root_id = g.group_id AND t.origin = 'mined' AND t.state IN ('candidate', 'valid'))",
  )?.n ?? 0;
}

function devOnlyOf(db: EvidenceDb, root: string): number {
  return db.get<{ dev_only: number }>("SELECT dev_only FROM eval_groups WHERE group_id = ?", root)?.dev_only ?? 0;
}

test("the three group facts give one result in every order", () => {
  // M is the mined copy with its lineage merge (or the landing join when L came first), L the landing, P the promotion.
  const orders = ["MLP", "MPL", "LMP", "LPM", "PLM", "PML"];
  const devOnlyOrders = new Set(["MLP", "MPL", "PML"]);
  const cases = [
    { name: "overlap", minedFiles: [SRC, TEST_B], devOnly: true },
    { name: "no overlap", minedFiles: [LIB_C, TEST_C], devOnly: false },
  ];
  for (const c of cases) {
    for (const order of orders) {
      const f = open();
      try {
        const captured = f.store.write(tx => {
          const id = captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT);
          approveTx(tx, id, APPROVED_AT);
          return id;
        });
        let mined = "";
        for (const step of order) {
          if (step === "M") f.store.write(tx => { mined = mineTx(tx, LANDED, c.minedFiles, COMMIT_AT); });
          if (step === "L") f.store.write(tx => { landTx(tx, RUN, LANDED, COMMIT_AT); });
          if (step === "P") f.store.write(tx => { promoteTx(tx); });
          assert.equal(f.store.read(db => invariantBreaches(db)), 0, `${c.name} ${order} after ${step}`);
        }
        const result = f.store.read(db => {
          const row = readEvalTask(db, captured);
          const copy = readEvalTask(db, mined);
          return {
            captured: row?.state, mined: copy?.state, reason: copy?.reason, parts: readMaterial(db, mined),
            root: rootOf(db, row?.groupId ?? ""), minedRoot: rootOf(db, copy?.groupId ?? ""),
            devOnly: devOnlyOf(db, rootOf(db, row?.groupId ?? "")),
          };
        });
        const label = `${c.name} in order ${order}`;
        assert.equal(result.captured, "candidate", label);
        assert.equal(result.mined, "rejected", label);
        assert.equal(result.reason, "duplicate-of-captured", label);
        assert.deepEqual(result.parts, {}, label);
        assert.equal(result.minedRoot, result.root, label);
        assert.equal(result.devOnly, c.devOnly && devOnlyOrders.has(order) ? 1 : 0, label);
        // Ruling 14: the smallest group id is the root, and the mined id `mined:...` sorts before `run:`.
        assert.equal(result.root, mined, label);
      } finally {
        f.cleanup();
      }
    }
  }
});

test("a promotion retires a valid mined copy", () => {
  const f = open();
  try {
    f.store.write(tx => {
      const id = captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT);
      approveTx(tx, id, APPROVED_AT);
    });
    const mined = f.store.write(tx => mineTx(tx, LANDED, [SRC, TEST_B], COMMIT_AT));
    f.store.write(tx => {
      tx.run("UPDATE eval_tasks SET state = 'valid' WHERE task_id = ?", mined);
    });
    f.store.write(tx => { promoteTx(tx); });
    const copy = f.store.read(db => readEvalTask(db, mined));
    assert.equal(copy?.state, "retired");
    assert.equal(copy?.reason, "duplicate-of-captured");
    assert.deepEqual(f.store.read(db => readMaterial(db, mined)), {});
  } finally {
    f.cleanup();
  }
});

test("a valid captured row makes a later mined copy a duplicate", () => {
  const f = open();
  try {
    const captured = f.store.write(tx => {
      const id = captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT);
      approveTx(tx, id, APPROVED_AT);
      return id;
    });
    f.store.write(tx => { promoteTx(tx); });
    // Validation passed: the captured row is valid, no longer a candidate.
    f.store.write(tx => { tx.run("UPDATE eval_tasks SET state = 'valid' WHERE task_id = ?", captured); });
    const mined = f.store.write(tx => mineTx(tx, LANDED, [SRC, TEST_B], COMMIT_AT));
    const copy = f.store.read(db => readEvalTask(db, mined));
    assert.equal(copy?.state, "rejected");
    assert.equal(copy?.reason, "duplicate-of-captured");
    assert.equal(f.store.read(invariantBreaches), 0);
  } finally {
    f.cleanup();
  }
});

test("lineage is bounded in time and width", () => {
  const f = open();
  try {
    const ref = f.store.write(tx => pathRef(tx, PROJECT, SRC));
    const lineage = () => f.store.read(db => lineageRoots(db, { pathRefs: [ref], commitTime: COMMIT_AT }));
    f.store.write(tx => {
      // Outside the 90-day window.
      approveTx(tx, captureTx(tx, "run-old", [SRC, TEST_A], OLD_CAPTURED_AT), OLD_APPROVED_AT);
      // Approved after the commit.
      approveTx(tx, captureTx(tx, "run-late", [SRC, TEST_A], CAPTURED_AT), LATE_APPROVED_AT);
      // Already landed.
      approveTx(tx, captureTx(tx, "run-landed", [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      landTx(tx, "run-landed", OTHER_LANDING, COMMIT_AT);
    });
    assert.deepEqual(lineage(), { roots: [] });
    f.store.write(tx => {
      approveTx(tx, captureTx(tx, "run-ok", [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
    });
    assert.deepEqual(lineage(), { roots: [runGroupId("run-ok")] });
  } finally {
    f.cleanup();
  }

  const wide = open();
  try {
    const ref = wide.store.write(tx => pathRef(tx, PROJECT, SRC));
    wide.store.write(tx => {
      for (let i = 0; i < 64; i++) approveTx(tx, captureTx(tx, `run-${i}`, [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
    });
    const sixtyFour = wide.store.read(db => lineageRoots(db, { pathRefs: [ref], commitTime: COMMIT_AT }));
    assert.ok("roots" in sixtyFour);
    assert.equal(sixtyFour.roots.length, 64);
    wide.store.write(tx => {
      approveTx(tx, captureTx(tx, "run-64", [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
    });
    const sixtyFive = wide.store.read(db => lineageRoots(db, { pathRefs: [ref], commitTime: COMMIT_AT }));
    assert.deepEqual(sixtyFive, { tooWide: true });
    // The miner rejects a commit whose lineage is too wide.
    const mined = wide.store.write(tx => mineTx(tx, LANDED, [SRC, TEST_B], COMMIT_AT));
    const copy = wide.store.read(db => readEvalTask(db, mined));
    assert.deepEqual([copy?.state, copy?.reason], ["rejected", "lineage-too-wide"]);
  } finally {
    wide.cleanup();
  }

  // One root over 1,000 rows of one path, then 1,001: the row cap applies before any root is counted.
  const deep = open();
  try {
    const ref = deep.store.write(tx => pathRef(tx, PROJECT, SRC));
    const runs = Array.from({ length: 1_001 }, (_, i) => `deep-${String(i).padStart(4, "0")}`);
    const lineage = () => deep.store.read(db => lineageRoots(db, { pathRefs: [ref], commitTime: COMMIT_AT }));
    deep.store.write(tx => {
      for (const run of runs.slice(0, 1_000)) approveTx(tx, captureTx(tx, run, [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      mergeRoots(tx, runs.slice(0, 1_000).map(runGroupId), false);
    });
    assert.deepEqual(lineage(), { roots: [runGroupId(runs[0])] });
    deep.store.write(tx => {
      approveTx(tx, captureTx(tx, runs[1_000], [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      mergeRoots(tx, [runGroupId(runs[0]), runGroupId(runs[1_000])], false);
    });
    assert.deepEqual(lineage(), { tooWide: true });
  } finally {
    deep.cleanup();
  }
});

test("the groups pass joins a landing from either source", () => {
  // A run record whose deliveryReceipt names the commit.
  const fromRecord = open();
  try {
    const minedId = fromRecord.store.write(tx => {
      approveTx(tx, captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      return insertMinedTx(tx, LANDED, [LIB_C, TEST_C], COMMIT_AT);
    });
    const run = { id: RUN, deliveryReceipt: { mergeCommit: LANDED } } as unknown as TeamRun;
    const pass = new GroupPass({ store: fromRecord.store, runs: () => [run], now: () => NOW });
    assert.deepEqual(pass.run(), { checked: 1, landed: 1, joined: 1, indexed: 0 });
    const state = fromRecord.store.read(db => ({
      landing: db.get<{ landing_ref: string | null }>("SELECT landing_ref FROM eval_groups WHERE group_id = ?", runGroupId(RUN))?.landing_ref,
      run: rootOf(db, runGroupId(RUN)),
      mined: rootOf(db, minedId),
    }));
    assert.equal(state.landing, fromRecord.store.write(tx => tx.index("eval-commit", LANDED)));
    assert.equal(state.mined, state.run);
  } finally {
    fromRecord.cleanup();
  }

  // A ledger landing signal with the commit. A signal whose payload does not open stamps the group and joins nothing.
  const fromSignal = open();
  try {
    const minedId = fromSignal.store.write(tx => {
      approveTx(tx, captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      const id = insertMinedTx(tx, LANDED, [LIB_C, TEST_C], COMMIT_AT);
      writeSignal(tx, landingRow(RUN, LANDED));
      return id;
    });
    const pass = new GroupPass({ store: fromSignal.store, runs: () => [], now: () => NOW });
    assert.deepEqual(pass.run(), { checked: 1, landed: 1, joined: 1, indexed: 0 });
    assert.equal(fromSignal.store.read(db => rootOf(db, minedId)), fromSignal.store.read(db => rootOf(db, runGroupId(RUN))));
  } finally {
    fromSignal.cleanup();
  }

  // A run group older than 90 days is stamped and never joined, even when its run record names the commit.
  const old = open();
  try {
    const minedId = old.store.write(tx => {
      approveTx(tx, captureTx(tx, RUN, [SRC, TEST_A], OLD_CAPTURED_AT), OLD_APPROVED_AT);
      return insertMinedTx(tx, LANDED, [LIB_C, TEST_C], COMMIT_AT);
    });
    const run = { id: RUN, deliveryReceipt: { mergeCommit: LANDED } } as unknown as TeamRun;
    const pass = new GroupPass({ store: old.store, runs: () => [run], now: () => NOW });
    assert.deepEqual(pass.run(), { checked: 1, landed: 0, joined: 0, indexed: 0 });
    assert.deepEqual(old.store.read(db => ({
      ...db.get<{ landing_ref: string | null; landing_checked_at: string | null }>(
        "SELECT landing_ref, landing_checked_at FROM eval_groups WHERE group_id = ?", runGroupId(RUN)),
    })), { landing_ref: null, landing_checked_at: "9999-12-31T23:59:59.999Z" });
    assert.notEqual(old.store.read(db => rootOf(db, minedId)), old.store.read(db => rootOf(db, runGroupId(RUN))));
  } finally {
    old.cleanup();
  }

  const unopened = open();
  try {
    unopened.store.write(tx => {
      approveTx(tx, captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      insertMinedTx(tx, LANDED, [LIB_C, TEST_C], COMMIT_AT);
      writeSignal(tx, landingRow(RUN, LANDED));
      tx.run("UPDATE outcome_signals SET payload = ? WHERE signal_id = ?", "not-sealed", landingSignalId(RUN));
    });
    const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
    let clock = NOW;
    const pass = new GroupPass({ store: unopened.store, runs: () => [], now: () => clock });
    assert.deepEqual(pass.run(), { checked: 1, landed: 0, joined: 0, indexed: 0 });
    assert.equal(unopened.store.read(db => db.get<{ landing_checked_at: string | null }>(
      "SELECT landing_checked_at FROM eval_groups WHERE group_id = ?", runGroupId(RUN))?.landing_checked_at), NOW);
    clock = at(60_000);
    assert.equal(pass.run().checked, 0, "a second pass within 10 minutes reads no group");
    clock = at(11 * 60_000);
    assert.equal(pass.run().checked, 1, "a pass after 10 minutes reads the group again");
  } finally {
    unopened.cleanup();
  }
});

test("a group past the landing window is checked once", () => {
  const f = open();
  try {
    f.store.write(tx => {
      approveTx(tx, captureTx(tx, RUN, [SRC, TEST_A], OLD_CAPTURED_AT), OLD_APPROVED_AT);
    });
    let runReads = 0;
    const runs = () => {
      runReads++;
      return [];
    };
    const first = new GroupPass({ store: f.store, runs, now: () => NOW });
    assert.equal(first.run().checked, 1, "the first pass checks the old group once");
    assert.equal(runReads, 0, "a group past the window needs no merge commit, so the runs are not copied");

    // Eleven minutes later the group is due by the recheck age, but past the window it is stamped with a value
    // that never falls due, so no pass reads it again and no pass copies the runs.
    runReads = 0;
    const later = new GroupPass({ store: f.store, runs, now: () => new Date(Date.parse(NOW) + 11 * 60_000).toISOString() });
    assert.equal(later.run().checked, 0, "the old group is not due again");
    assert.equal(runReads, 0, "no pass copies the runs when no group is inside the window");
    assert.equal(f.store.read(db => db.get<{ landing_checked_at: string | null }>(
      "SELECT landing_checked_at FROM eval_groups WHERE group_id = ?", runGroupId(RUN))?.landing_checked_at), "9999-12-31T23:59:59.999Z");
  } finally {
    f.cleanup();
  }
});

test("a deleted run leaves its mined copy", () => {
  const f = open();
  try {
    const { mined } = f.store.write(tx => {
      approveTx(tx, captureTx(tx, RUN, [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      const id = insertMinedTx(tx, LANDED, [LIB_C, TEST_C], COMMIT_AT);
      landTx(tx, RUN, LANDED, COMMIT_AT);
      return { mined: id };
    });
    f.store.write(tx => {
      f.store.appendEvent(tx, {
        key: `run.deleted:${RUN}`, runId: RUN, revision: 1, at: NOW, kind: "run.deleted", data: { status: "cancelled" },
      });
    });
    assert.equal(f.store.deleteRun(RUN), true);
    const after = f.store.read(db => ({
      captured: db.get<{ n: number }>("SELECT count(*) AS n FROM eval_tasks WHERE run_id = ?", RUN)?.n ?? 0,
      paths: db.get<{ n: number }>("SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", capturedTaskId(RUN, MEMBER))?.n ?? 0,
      state: readEvalTask(db, mined)?.state,
      groups: db.get<{ n: number }>("SELECT count(*) AS n FROM eval_groups WHERE group_id IN (?, ?)", runGroupId(RUN), mined)?.n ?? 0,
    }));
    assert.deepEqual(after, { captured: 0, paths: 0, state: "candidate", groups: 2 });
    // Ruling 14: the run's group row has no task and is no root, so the first sweep takes it; the second takes nothing.
    assert.equal(f.store.write(tx => sweepGroups(tx)), 1, "the first sweep takes the run's group row");
    assert.equal(f.store.write(tx => sweepGroups(tx)), 0, "a second sweep takes nothing");
  } finally {
    f.cleanup();
  }
});

test("the sweep keeps a deleted run's group while it is another group's root", () => {
  const f = open();
  try {
    f.store.write(tx => {
      approveTx(tx, captureTx(tx, "run-a", [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      approveTx(tx, captureTx(tx, "run-b", [SRC, TEST_A], CAPTURED_AT), APPROVED_AT);
      // A lineage merge of the two runs: the smaller id, run-a's group, is the root.
      mergeRoots(tx, [runGroupId("run-a"), runGroupId("run-b")], true);
    });
    f.store.write(tx => {
      f.store.appendEvent(tx, {
        key: "run.deleted:run-a", runId: "run-a", revision: 1, at: NOW, kind: "run.deleted", data: { status: "cancelled" },
      });
    });
    assert.equal(f.store.deleteRun("run-a"), true);
    assert.equal(f.store.write(tx => sweepGroups(tx)), 0, "run-a's group has no task, but run-b's group names it as root");
    assert.equal(f.store.read(db => rootOf(db, runGroupId("run-b"))), runGroupId("run-a"));
    assert.equal(f.store.read(db => devOnlyOf(db, runGroupId("run-a"))), 1, "the root row keeps its mark");
  } finally {
    f.cleanup();
  }
});

function landingRow(runId: string, commit: string): SignalRow {
  return {
    signalId: landingSignalId(runId),
    runId,
    outcomeId: null,
    kind: "landing",
    author: "host",
    authority: "receipt",
    state: "active",
    at: NOW,
    payload: { kind: "landing", commit, method: "merge-commit", scanSeq: 1, holdDays: 0, holdUntil: NOW },
  };
}

test("the hot statements read through an index", () => {
  const f = open();
  try {
    // A planner may pick any index that leads with the same columns; each case names the ones that serve it.
    const cases: { name: string; sql: string; params: (string | number)[]; index: string[] }[] = [
      { name: "ROOT_TASKS_SQL", sql: ROOT_TASKS_SQL, params: ["run:x"], index: ["eval_groups_root"] },
      { name: "LINEAGE_SQL", sql: LINEAGE_SQL, params: ["ref", NOW, NOW, 1001], index: ["PRIMARY KEY"] },
      { name: "LANDINGS_DUE_SQL", sql: LANDINGS_DUE_SQL, params: [NOW, 100], index: ["eval_groups_unlanded"] },
    ];
    for (const item of cases) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.params))
        .map(row => row.detail);
      assert.ok(
        details.some(detail => item.index.some(index => detail.includes(index))),
        `${item.name} plan: ${details.join(" | ")}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

type SetRow = { holdout: number; set_at: string | null; exposed: number };

function setOf(db: EvidenceDb, group: string): SetRow {
  const row = db.get<SetRow>("SELECT holdout, set_at, exposed FROM eval_groups WHERE group_id = ?", group);
  assert.ok(row);
  return row;
}

/** A run id whose run group draws the wanted set under this store's vault key. */
function runDrawing(tx: EvidenceTx, holdout: boolean, skip: string[] = []): string {
  for (let n = 0; n < 500; n++) {
    const runId = `draw-run-${n}`;
    if (skip.includes(runId)) continue;
    if (drawsHoldout(tx.index("eval-set", runGroupId(runId))) === holdout) return runId;
  }
  throw new Error("no run id drew the wanted set");
}

/** A commit whose mined group draws the wanted set. */
function commitDrawing(tx: EvidenceTx, holdout: boolean, skip: string[] = []): string {
  for (let n = 0; n < 500; n++) {
    const commit = n.toString(16).padStart(40, "9");
    if (skip.includes(commit)) continue;
    const id = minedTaskId(tx.index("project", PROJECT), tx.index("eval-commit", commit));
    if (drawsHoldout(tx.index("eval-set", id)) === holdout) return commit;
  }
  throw new Error("no commit drew the wanted set");
}

function validate(tx: EvidenceTx, ...taskIds: string[]): void {
  for (const id of taskIds) tx.run("UPDATE eval_tasks SET state = 'valid' WHERE task_id = ?", id);
}

function holdoutRows(db: EvidenceDb, root: string): number {
  return db.get<{ n: number }>(
    "SELECT COALESCE(SUM(holdout), 0) AS n FROM eval_groups WHERE root_id = ?",
    root,
  )?.n ?? 0;
}

test("a new group draws its set when it is created", () => {
  const { store, cleanup } = open();
  try {
    store.write(tx => {
      const holdRun = runDrawing(tx, true);
      const devRun = runDrawing(tx, false);
      captureTx(tx, holdRun, ["a.ts"], CAPTURED_AT);
      captureTx(tx, devRun, ["b.ts"], CAPTURED_AT);
      const hold = setOf(tx, runGroupId(holdRun));
      assert.equal(hold.holdout, 1);
      assert.equal(hold.set_at, CAPTURED_AT);
      const dev = setOf(tx, runGroupId(devRun));
      assert.equal(dev.holdout, 0);
      assert.equal(dev.set_at, null);
      const holdCommit = commitDrawing(tx, true);
      const devCommit = commitDrawing(tx, false);
      for (const commit of [holdCommit, devCommit]) {
        const id = insertMinedTx(tx, commit, ["m.ts"], NOW);
        const row = setOf(tx, id);
        const drawn = drawsHoldout(tx.index("eval-set", id));
        assert.equal(row.holdout, drawn ? 1 : 0);
        assert.equal(row.set_at, drawn ? NOW : null);
      }
    });
  } finally {
    cleanup();
  }
});

test("no group spans both sets", () => {
  const { store, cleanup } = open();
  try {
    const used: string[] = [];
    store.write(tx => {
      const holdRun = runDrawing(tx, true, used);
      used.push(holdRun);
      const captured = captureTx(tx, holdRun, ["a.ts"], CAPTURED_AT);
      const devCommit = commitDrawing(tx, false);
      const mined = insertMinedTx(tx, devCommit, ["b.ts"], NOW);
      validate(tx, captured, mined);
      const root = mergeRoots(tx, [runGroupId(holdRun), mined], false);
      assert.equal(holdoutRows(tx, root), 0);
      const rows = tx.all<{ task_id: string; holdout: number }>(TRIAL_TASKS_SQL, tx.index("project", PROJECT), "");
      assert.equal(rows.length, 2);
      for (const row of rows) assert.equal(row.holdout, 0);
    });
    store.write(tx => {
      const first = runDrawing(tx, true, used);
      const second = runDrawing(tx, true, [...used, first]);
      used.push(first, second);
      captureTx(tx, first, ["c.ts"], CAPTURED_AT);
      captureTx(tx, second, ["d.ts"], APPROVED_AT);
      const earlier = [first, second]
        .map(id => setOf(tx, runGroupId(id)).set_at ?? "")
        .sort()[0];
      const root = mergeRoots(tx, [runGroupId(first), runGroupId(second)], false);
      const row = setOf(tx, root);
      assert.equal(row.holdout, 1);
      assert.equal(row.set_at, earlier);
      assert.equal(holdoutRows(tx, root), 1);
    });
    store.write(tx => {
      const third = runDrawing(tx, true, used);
      const fourth = runDrawing(tx, true, [...used, third]);
      captureTx(tx, third, ["e.ts"], CAPTURED_AT);
      captureTx(tx, fourth, ["f.ts"], CAPTURED_AT);
      const root = mergeRoots(tx, [runGroupId(third), runGroupId(fourth)], true);
      assert.equal(setOf(tx, root).holdout, 0);
      assert.equal(holdoutRows(tx, root), 0);
      assert.equal(devOnlyOf(tx, root), 1);
    });
  } finally {
    cleanup();
  }
});

test("an exposed part moves the whole root to dev", () => {
  const { store, cleanup } = open();
  try {
    store.write(tx => {
      const first = runDrawing(tx, true);
      const second = runDrawing(tx, true, [first]);
      captureTx(tx, first, ["a.ts"], CAPTURED_AT);
      captureTx(tx, second, ["b.ts"], CAPTURED_AT);
      tx.run("UPDATE eval_groups SET exposed = 1, holdout = 0, set_at = NULL WHERE group_id = ?", runGroupId(second));
      const root = mergeRoots(tx, [runGroupId(first), runGroupId(second)], false);
      const row = setOf(tx, root);
      assert.equal(row.holdout, 0);
      assert.equal(row.exposed, 1);
      assert.equal(holdoutRows(tx, root), 0);
    });
  } finally {
    cleanup();
  }
});

test("promotion and mining write the prompt origin and kind", () => {
  const { store, cleanup } = open();
  try {
    const fields = (db: EvidenceDb, id: string): { prompt_origin: string | null; kind: string | null } => {
      const row = db.get<{ prompt_origin: string | null; kind: string | null }>(
        "SELECT prompt_origin, kind FROM eval_tasks WHERE task_id = ?",
        id,
      );
      assert.ok(row);
      return row;
    };
    store.write(tx => {
      const captured = captureTx(tx, RUN, ["a.ts"], CAPTURED_AT);
      approveTx(tx, captured, APPROVED_AT);
      promoteTx(tx);
      const promoted = fields(tx, captured);
      assert.equal(promoted.prompt_origin, "assignment");
      assert.equal(promoted.kind, FEATURES.kind);
      const commit = commitDrawing(tx, false);
      const mined = insertMinedTx(tx, commit, ["m.ts"], NOW);
      const row = fields(tx, mined);
      assert.equal(row.prompt_origin, "commit-message");
      assert.equal(row.kind, FEATURES.kind);
      const rejectedCommit = "1".repeat(40);
      insertMined(tx, { kind: "rejected", projectId: PROJECT, commit: rejectedCommit, reason: "too-large" }, NOW);
      const rejectedId = minedTaskId(tx.index("project", PROJECT), tx.index("eval-commit", rejectedCommit));
      const none = fields(tx, rejectedId);
      assert.equal(none.prompt_origin, null);
      assert.equal(none.kind, null);
    });
  } finally {
    cleanup();
  }
});
