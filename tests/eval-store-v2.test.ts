import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceModule, EvidenceTx } from "../packages/host/src/evidence/types.js";
import { EVAL_MODULE, type Capsule, type CaptureStart, type MinedPayload } from "../packages/host/src/eval-types.js";
import {
  CAPTURED_COUNT_SQL,
  LIVE_RUN_IDS_SQL,
  NEXT_PROJECT_REF_SQL,
  PATHS_PENDING_SQL,
  PROJECT_OLD_SQL,
  RECONCILE_ORDER_SQL,
  SCHEMA_V1,
  UNINDEXED_SQL,
  capturedTaskId,
  completeMaterial,
  evalCorpusModule,
  indexPaths,
  insertMarker,
  pathRef,
  pathsPending,
  reconcileBatch,
  rejectTask,
  type MaterialResult,
} from "../packages/host/src/eval-store.js";

const NOW = "2026-11-14T12:00:00.000Z";
const RUN = "run-v2-1";
const PROJECT = "project-v2-7";
const ANCHOR = "a".repeat(40);
const BASE = "d".repeat(40);
const COMMIT = "c".repeat(40);
const MINED_COMMIT = "f".repeat(40);
const HEAD = "e".repeat(40);
const OBJECTIVE = "Objective-v2-9b1c";
const SECRET_FILE = "src/secret-name.ts";
const SECRET_TEST = "tests/secret-name.test.ts";
const FILES = [SECRET_FILE, SECRET_TEST];
const STORED_MEMBER = "m-stored";
const PENDING_MEMBER = "m-pending";

type Setup = { open: () => EvidenceStore; cleanup: () => void };

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-store-v2-"));
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const vaultKey = randomBytes(32);
  return {
    open: () => new EvidenceStore({ databasePath, vaultKey }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function v1Module(): EvidenceModule {
  return {
    name: EVAL_MODULE,
    version: 1,
    readVersion: 1,
    migrate(tx, from) {
      if (from === 0) for (const statement of SCHEMA_V1) tx.exec(statement);
    },
  };
}

function v2Module(store: EvidenceStore): EvidenceModule {
  return evalCorpusModule(store, () => NOW);
}

function capsule(): Capsule {
  return {
    objective: OBJECTIVE,
    steering: [],
    ownerAnswers: [],
    task: { id: "T1", title: "Title", instructions: "Do the work", paths: [SECRET_FILE] },
  };
}

function captureStart(memberId: string, commit = COMMIT): CaptureStart {
  return {
    runId: RUN,
    memberId,
    projectId: PROJECT,
    workspace: "workspace-1",
    anchorCommit: ANCHOR,
    memberBaseCommit: BASE,
    commit,
    integratedHead: HEAD,
    at: NOW,
    uiChanges: false,
    capsule: capsule(),
  };
}

function storedResult(files: string[]): MaterialResult {
  return {
    kind: "store",
    files,
    hiddenFiles: files.filter(file => file.includes("test")),
    baseDelta: { state: "none" },
    reference: { state: "stored", bytes: randomBytes(40) },
    base: "proven",
  };
}

function scalar(store: EvidenceStore, sql: string, ...params: string[]): number {
  return store.read(db => db.get<{ n: number }>(sql, ...params)?.n ?? 0);
}

const V1_COLUMNS = "task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, approved_at, base, "
  + "material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload";

function insertV1(store: EvidenceStore, memberId: string, material: "stored" | "pending"): void {
  const taskId = capturedTaskId(RUN, memberId);
  const payload = {
    projectId: PROJECT,
    anchorCommit: ANCHOR,
    memberBaseCommit: BASE,
    commit: COMMIT,
    integratedHead: HEAD,
    ...(material === "stored" ? { files: FILES } : {}),
  };
  store.write(tx => {
    tx.run(
      `INSERT INTO eval_tasks (${V1_COLUMNS}) VALUES (?, 'captured', ?, ?, ?, 'captured', NULL, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL, ?)`,
      taskId,
      RUN,
      memberId,
      tx.index("project", PROJECT),
      material,
      material === "stored" ? "proven" : "pending",
      material === "stored" ? 10 : 0,
      NOW,
      NOW,
      tx.seal("eval_tasks", taskId, payload),
    );
  });
}

function v1Rows(store: EvidenceStore): unknown[] {
  return store.read(db => db.all(`SELECT ${V1_COLUMNS} FROM eval_tasks ORDER BY task_id`));
}

function dump(store: EvidenceStore): string {
  return JSON.stringify(store.read(db => ({
    master: db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"),
    modules: db.all("SELECT name, version, read_version FROM schema_modules ORDER BY name"),
    tasks: db.all("SELECT * FROM eval_tasks ORDER BY task_id"),
    material: db.all("SELECT * FROM eval_material ORDER BY task_id, part"),
    groups: db.all("SELECT * FROM eval_groups ORDER BY group_id"),
    paths: db.all("SELECT * FROM eval_paths ORDER BY path_ref, captured_at, task_id"),
  })));
}

test("the v2 migration keeps every v1 row", () => {
  const f = setup();
  try {
    let store = f.open();
    store.register(v1Module());
    assert.equal(store.status().modules[EVAL_MODULE], "ready");
    insertV1(store, STORED_MEMBER, "stored");
    insertV1(store, PENDING_MEMBER, "pending");
    const storedId = capturedTaskId(RUN, STORED_MEMBER);
    const pendingId = capturedTaskId(RUN, PENDING_MEMBER);
    const before = v1Rows(store);
    store.close();

    store = f.open();
    store.register(v2Module(store));
    assert.equal(store.status().modules[EVAL_MODULE], "ready");

    assert.deepEqual(v1Rows(store), before);
    assert.deepEqual(
      store.read(db => db.all<Record<string, unknown>>("SELECT task_id, group_id, paths_indexed FROM eval_tasks ORDER BY task_id"))
        .map(row => ({ ...row })),
      [
        { task_id: pendingId, group_id: `run:${RUN}`, paths_indexed: 0 },
        { task_id: storedId, group_id: `run:${RUN}`, paths_indexed: 0 },
      ],
    );
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_groups WHERE root_id = ?", `run:${RUN}`), 1);

    const ref = store.read(db => db.index("project", PROJECT));
    assert.equal(store.read(db => pathsPending(db, ref)), true);
    assert.equal(store.write(tx => indexPaths(tx)), 1);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", storedId), 2);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", pendingId), 0);
    assert.equal(store.read(db => pathsPending(db, ref)), false);

    const completed = store.write(tx => completeMaterial(tx, pendingId, storedResult(FILES), NOW));
    assert.equal(completed, true);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", pendingId), 2);
  } finally {
    f.cleanup();
  }
});

test("a v1 host leaves a v2 store alone", () => {
  const f = setup();
  try {
    let store = f.open();
    store.register(v2Module(store));
    assert.equal(store.status().modules[EVAL_MODULE], "ready");
    store.write(tx => insertMarker(tx, captureStart(STORED_MEMBER), { state: "captured", capsule: capsule() }, NOW));
    store.write(tx => completeMaterial(tx, capturedTaskId(RUN, STORED_MEMBER), storedResult(FILES), NOW));
    const before = dump(store);
    store.close();

    store = f.open();
    store.register(v1Module());
    assert.equal(store.status().modules[EVAL_MODULE], "unavailable");
    assert.equal(dump(store), before);
    store.close();
  } finally {
    f.cleanup();
  }
});

test("the v2 tables keep every text sealed", () => {
  const f = setup();
  try {
    const store = f.open();
    store.register(v2Module(store));
    const taskId = capturedTaskId(RUN, STORED_MEMBER);
    store.write(tx => insertMarker(tx, captureStart(STORED_MEMBER), { state: "captured", capsule: capsule() }, NOW));
    store.write(tx => completeMaterial(tx, taskId, storedResult(FILES), NOW));
    const ref = store.write(tx => tx.index("project", PROJECT));
    store.write(tx => {
      const jobPayload = tx.seal("eval_jobs", "job-sealed-1", {
        projectId: PROJECT,
        request: { kind: "validate", taskFilter: { taskIds: [taskId] } },
        requestDigest: "digest-1",
        pinnedDigest: "digest-2",
      });
      tx.run(
        "INSERT INTO eval_jobs (job_id, project_ref, kind, status, reason, waiting, request_id, created_at, started_at, "
        + "expires_at, finished_at, updated_at, payload) VALUES (?, ?, 'validate', 'running', NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?)",
        "job-sealed-1",
        ref,
        "request-sealed-1",
        NOW,
        NOW,
        NOW,
        jobPayload,
      );
      const miningPayload = tx.seal("eval_mining", ref, { head: COMMIT, after: MINED_COMMIT });
      tx.run(
        "INSERT INTO eval_mining (project_ref, state, updated_at, payload) VALUES (?, 'caught-up', ?, ?)",
        ref,
        NOW,
        miningPayload,
      );
    });

    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths"), 2);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_groups"), 1);
    const tables = ["eval_tasks", "eval_groups", "eval_paths", "eval_mining", "eval_jobs", "eval_material"];
    const secrets = [OBJECTIVE, "secret-name", COMMIT, MINED_COMMIT, PROJECT];
    for (const table of tables) {
      const rows = store.read(db => db.all<Record<string, unknown>>(`SELECT * FROM ${table}`));
      assert.ok(rows.length > 0, `${table} has no rows to check`);
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value !== "string") continue;
          for (const secret of secrets) assert.equal(value.includes(secret), false, `${table} plain column holds ${secret}`);
        }
      }
    }
    store.close();
  } finally {
    f.cleanup();
  }
});

test("mined rows stay out of capture's reads and cap", () => {
  const f = setup();
  try {
    const store = f.open();
    store.register(v2Module(store));
    const ref = store.write(tx => tx.index("project", PROJECT));
    const visible = capturedTaskId(RUN, "m-visible");
    assert.equal(store.write(tx => insertMarker(tx, captureStart("m-visible"), { state: "captured", capsule: capsule() }, NOW)), "inserted");
    store.write(tx => {
      const payload: MinedPayload = {
        projectId: PROJECT,
        anchorCommit: ANCHOR,
        commit: MINED_COMMIT,
        commitTime: NOW,
        promptOrigin: "commit-message",
        files: [],
        hiddenFiles: [],
        features: { role: "implementer", area: "area-mined", kind: null, risk: "normal", featureVersion: 1 },
      };
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, approved_at, "
        + "base, material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload, group_id, commit_ref, lineage) "
        + "VALUES ('mined:visible', 'mined', '', '', ?, 'candidate', NULL, 'stored', NULL, NULL, 'proven', 0, ?, NULL, ?, NULL, ?, "
        + "'mined:visible', ?, 'clear')",
        ref,
        NOW,
        NOW,
        tx.seal("eval_tasks", "mined:visible", payload),
        tx.index("eval-commit", MINED_COMMIT),
      );
    });

    const decided: string[] = [];
    const result = store.write(tx => reconcileBatch(tx, task => {
      decided.push(task.taskId);
      return { kind: "wait" };
    }, NOW));
    assert.equal(result.visited, 1);
    assert.deepEqual(decided, [visible]);

    store.write(tx => {
      tx.run(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 19998) "
        + "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
        + "captured_at, checked_at, payload) SELECT 'captured:run-bulk:m-' || i, 'captured', 'run-bulk', 'm-' || i, ?, "
        + "'rejected', 'none', 'none', 0, ?, ?, '' FROM n",
        ref,
        NOW,
        NOW,
      );
      tx.run(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) "
        + "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
        + "captured_at, checked_at, payload, group_id) SELECT 'mined:bulk:' || i, 'mined', '', '', ?, 'candidate', 'none', "
        + "'none', 0, ?, ?, '', 'mined:bulk:' || i FROM n",
        ref,
        NOW,
        NOW,
      );
    });
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_tasks WHERE origin = 'mined'"), 5001);
    assert.equal(
      store.write(tx => insertMarker(tx, captureStart("m-cap"), { state: "captured", capsule: capsule() }, NOW)),
      "inserted",
    );
    assert.equal(
      store.write(tx => insertMarker(tx, captureStart("m-cap-2"), { state: "captured", capsule: capsule() }, NOW)),
      "full",
    );
    store.close();
  } finally {
    f.cleanup();
  }
});

test("a valid captured task is retired, never promoted again", () => {
  const f = setup();
  try {
    const store = f.open();
    store.register(v2Module(store));
    const retiring = capturedTaskId(RUN, "m-retire");
    store.write(tx => insertMarker(tx, captureStart("m-retire"), { state: "captured", capsule: capsule() }, NOW));
    store.write(tx => completeMaterial(tx, retiring, storedResult(FILES), NOW));
    store.write(tx => tx.run("UPDATE eval_tasks SET state='valid' WHERE task_id=?", retiring));
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", retiring), 2);

    const retired = store.write(tx => reconcileBatch(tx, () => ({ kind: "reject", reason: "excluded" }), NOW));
    assert.equal(retired.demoted, 1);
    assert.equal(retired.rejected, 0);
    const row = store.read(db => db.get<{ state: string; reason: string; material: string; base: string; material_bytes: number }>(
      "SELECT state, reason, material, base, material_bytes FROM eval_tasks WHERE task_id = ?",
      retiring,
    ));
    assert.ok(row);
    assert.deepEqual({ ...row }, { state: "retired", reason: "excluded", material: "none", base: "none", material_bytes: 0 });
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_material WHERE task_id = ?", retiring), 0);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", retiring), 0);

    const kept = capturedTaskId(RUN, "m-keep");
    store.write(tx => insertMarker(tx, captureStart("m-keep"), { state: "captured", capsule: capsule() }, NOW));
    store.write(tx => completeMaterial(tx, kept, storedResult(FILES), NOW));
    store.write(tx => tx.run("UPDATE eval_tasks SET state='valid' WHERE task_id=?", kept));
    let promotions = 0;
    const candidate = store.write(tx => reconcileBatch(
      tx,
      () => ({ kind: "candidate", features: { role: "implementer", area: "area-a", kind: null, risk: "normal", featureVersion: 1 } }),
      NOW,
      100,
      () => { promotions++; },
    ));
    assert.equal(candidate.promoted, 0);
    assert.equal(promotions, 0);
    assert.equal(store.read(db => db.get<{ state: string }>("SELECT state FROM eval_tasks WHERE task_id = ?", kept))?.state, "valid");

    const rejectable = capturedTaskId(RUN, "m-reject");
    store.write(tx => insertMarker(tx, captureStart("m-reject"), { state: "captured", capsule: capsule() }, NOW));
    store.write(tx => completeMaterial(tx, rejectable, storedResult(FILES), NOW));
    store.write(tx => rejectTask(tx, rejectable, "excluded", NOW, PROJECT));
    assert.equal(store.read(db => db.get<{ state: string }>("SELECT state FROM eval_tasks WHERE task_id = ?", rejectable))?.state, "rejected");
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE task_id = ?", rejectable), 0);
    store.close();
  } finally {
    f.cleanup();
  }
});

test("the hot statements read through an index", () => {
  const f = setup();
  try {
    const store = f.open();
    store.register(v2Module(store));
    const ref = store.write(tx => tx.index("project", PROJECT));
    const cases: { name: string; sql: string; params: (string | number)[]; index: string[] }[] = [
      { name: "RECONCILE_ORDER_SQL", sql: RECONCILE_ORDER_SQL, params: ["captured", 100], index: ["eval_tasks_check_captured"] },
      { name: "PATHS_PENDING_SQL", sql: PATHS_PENDING_SQL, params: [ref], index: ["eval_tasks_unindexed"] },
      { name: "UNINDEXED_SQL", sql: UNINDEXED_SQL, params: [100], index: ["eval_tasks_unindexed"] },
      { name: "CAPTURED_COUNT_SQL", sql: CAPTURED_COUNT_SQL, params: [ref], index: ["eval_tasks_summary"] },
      { name: "NEXT_PROJECT_REF_SQL", sql: NEXT_PROJECT_REF_SQL, params: [""], index: ["eval_tasks_project", "eval_tasks_bytes"] },
      { name: "PROJECT_OLD_SQL", sql: PROJECT_OLD_SQL, params: [ref, NOW, 100], index: ["eval_tasks_project"] },
      { name: "LIVE_RUN_IDS_SQL", sql: LIVE_RUN_IDS_SQL, params: [], index: ["eval_tasks_live_runs"] },
    ];
    for (const item of cases) {
      const details = store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.params))
        .map(row => row.detail);
      assert.ok(
        details.some(detail => item.index.some(index => detail.includes(`INDEX ${index}`))),
        `${item.name} plan: ${details.join(" | ")}`,
      );
    }
    store.close();
  } finally {
    f.cleanup();
  }
});

test("deleting a run takes its path rows and keeps its group", () => {
  const f = setup();
  try {
    const store = f.open();
    store.register(v2Module(store));
    store.write(tx => insertMarker(tx, captureStart(STORED_MEMBER), { state: "captured", capsule: capsule() }, NOW));
    store.write(tx => completeMaterial(tx, capturedTaskId(RUN, STORED_MEMBER), storedResult(FILES), NOW));
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths"), 2);
    assert.equal(store.deleteRun(RUN), true);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths"), 0);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_tasks"), 0);
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_groups WHERE group_id = ?", `run:${RUN}`), 1);
    const ref = store.read(db => pathRef(db, PROJECT, SECRET_FILE));
    assert.equal(scalar(store, "SELECT count(*) AS n FROM eval_paths WHERE path_ref = ?", ref), 0);
    store.close();
  } finally {
    f.cleanup();
  }
});
