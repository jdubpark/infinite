import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import {
  EVAL_MODULE,
  type Capsule,
  type CaptureStart,
} from "../packages/host/src/eval-types.js";
import {
  HOST_MATERIAL_MAX_BYTES,
  PROJECT_MATERIAL_MAX_BYTES,
  PROJECT_TASK_MAX,
  capturedTaskId,
  completeApproval,
  completeMaterial,
  evalCorpusModule,
  insertMarker,
  markApproval,
  readMaterial,
  sweepEvalTasks,
  type MaterialResult,
} from "../packages/host/src/eval-store.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-14T12:00:00.000Z";
const RUN = "run-capture-1";
const PROJECT = "project-Sealed-41";
const ANCHOR = "a".repeat(40);
const OTHER_ANCHOR = "b".repeat(40);
const BASE = "d".repeat(40);
const COMMIT = "c".repeat(40);
const HEAD = "e".repeat(40);
const OBJECTIVE = "Objective-7f3a";
const SECRET_FILE = "src/secret-name.ts";
const SECRET_TEST = "tests/secret-name.test.ts";

type Fixture = { store: EvidenceStore; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-store-"));
  const store = new EvidenceStore({
    databasePath: evidenceDatabasePath(join(root, "state")),
    vaultKey: randomBytes(32),
  });
  return {
    store,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A fixture with the module registered and ready. */
function ready(): Fixture & { module: ReturnType<typeof evalCorpusModule> } {
  const f = fixture();
  const module = evalCorpusModule(f.store, () => NOW);
  f.store.register(module);
  assert.equal(f.store.status().modules[EVAL_MODULE], "ready");
  return { ...f, module };
}

function capsule(objective = OBJECTIVE): Capsule {
  return {
    objective,
    steering: [],
    ownerAnswers: [],
    task: { id: "T1", title: "Title", instructions: "Do the work", paths: [SECRET_FILE] },
  };
}

function captureStart(memberId: string, commit: string, extra: Partial<CaptureStart> = {}): CaptureStart {
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
    ...extra,
  };
}

function count(f: Fixture, table: string, where = "1=1", ...params: string[]): number {
  return f.store.read(db => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)?.n ?? 0);
}

function snapshot(f: Fixture): string {
  return JSON.stringify(f.store.read(db => ({
    tasks: db.all("SELECT * FROM eval_tasks ORDER BY task_id"),
    material: db.all("SELECT * FROM eval_material ORDER BY task_id, part"),
  })));
}

function appendRunEvent(f: Fixture, runId: string, key: string, kind: string, status: unknown): void {
  f.store.write(tx => {
    f.store.appendEvent(tx, { key, runId, revision: 1, at: NOW, kind, data: { status } });
  });
}

function storeResult(files: string[], patchA: Buffer, patchB: Buffer | undefined): MaterialResult {
  return {
    kind: "store",
    files,
    hiddenFiles: files.filter(file => file.includes("test")),
    baseDelta: patchB ? { state: "stored", bytes: patchB } : { state: "none" },
    reference: { state: "stored", bytes: patchA },
    base: "proven",
  };
}

test("the module keeps every text sealed", () => {
  const f = ready();
  try {
    const taskId = capturedTaskId(RUN, "m-sealed");
    const patchA = randomBytes(300);
    const patchB = randomBytes(200);
    const outcome = f.store.write(tx => insertMarker(tx, captureStart("m-sealed", COMMIT), { state: "captured", capsule: capsule() }, NOW));
    assert.equal(outcome, "inserted");
    const stored = f.store.write(tx => completeMaterial(
      tx,
      taskId,
      storeResult([SECRET_FILE, SECRET_TEST], patchA, patchB),
      NOW,
    ));
    assert.equal(stored, true);

    const rows = f.store.read(db => [
      ...db.all<Record<string, unknown>>("SELECT * FROM eval_tasks"),
      ...db.all<Record<string, unknown>>("SELECT * FROM eval_material"),
    ]);
    assert.equal(rows.length, 4);
    const secrets = [OBJECTIVE, "secret-name", COMMIT, PROJECT];
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value !== "string") continue;
        for (const secret of secrets) assert.equal(value.includes(secret), false, `plain column holds ${secret}`);
      }
    }

    const material = f.store.read(db => readMaterial(db, taskId));
    assert.deepEqual(material.capsule, capsule());
    assert.deepEqual(material.reference, patchA);
    assert.deepEqual(material.baseDelta, patchB);
  } finally {
    f.close();
  }
});

test("a marker and its completion are written once", () => {
  const f = ready();
  try {
    const taskId = capturedTaskId(RUN, "m-once");
    const first = f.store.write(tx => insertMarker(tx, captureStart("m-once", COMMIT), { state: "captured", capsule: capsule() }, NOW));
    assert.equal(first, "inserted");
    const afterFirst = snapshot(f);

    const second = f.store.write(tx => insertMarker(
      tx,
      captureStart("m-once", COMMIT, { at: "2026-11-14T13:00:00.000Z" }),
      { state: "captured", capsule: capsule("Different objective") },
      "2026-11-14T13:00:00.000Z",
    ));
    assert.equal(second, "exists");
    assert.equal(snapshot(f), afterFirst);

    const completed = f.store.write(tx => completeMaterial(tx, taskId, storeResult([SECRET_FILE, SECRET_TEST], randomBytes(40), undefined), NOW));
    assert.equal(completed, true);
    const afterComplete = snapshot(f);
    const again = f.store.write(tx => completeMaterial(tx, taskId, storeResult([SECRET_FILE], randomBytes(40), undefined), NOW));
    assert.equal(again, false);
    assert.equal(snapshot(f), afterComplete);

    // Deleting the run's rows (no status event: the rows go) leaves nothing for a late completion to write.
    assert.equal(f.store.deleteRun(RUN), true);
    assert.equal(count(f, "eval_tasks"), 0);
    const late = f.store.write(tx => completeMaterial(tx, taskId, storeResult([SECRET_FILE], randomBytes(40), undefined), NOW));
    assert.equal(late, false);
    assert.equal(count(f, "eval_material"), 0);
  } finally {
    f.close();
  }
});

test("deleting a cancelled run deletes its tasks; another status stamps them", () => {
  const f = ready();
  try {
    const runA = "run-cancelled-a";
    const runB = "run-merged-b";
    const runC = "run-no-event-c";
    for (const run of [runA, runB, runC]) {
      f.store.write(tx => insertMarker(tx, captureStart("m-1", COMMIT, { runId: run }), { state: "captured", capsule: capsule() }, NOW));
      f.store.write(tx => insertMarker(tx, captureStart("m-2", HEAD, { runId: run }), { state: "rejected", reason: "ui-changes" }, NOW));
    }
    appendRunEvent(f, runA, "a-settled", "run.settled", "merged");
    appendRunEvent(f, runA, "a-deleted", "run.deleted", "cancelled");
    appendRunEvent(f, runB, "b-settled", "run.settled", "merged");
    appendRunEvent(f, runB, "b-deleted", "run.deleted", "merged");

    assert.equal(f.store.deleteRun(runA), true);
    assert.equal(count(f, "eval_tasks", "run_id=?", runA), 0);
    assert.equal(count(f, "eval_material", "task_id LIKE ?", `%${runA}%`), 0);

    assert.equal(f.store.deleteRun(runB), true);
    assert.equal(count(f, "eval_tasks", "run_id=? AND run_deleted_at IS NOT NULL", runB), 2);
    assert.equal(count(f, "eval_tasks", "run_id=? AND run_deleted_at IS NULL", runB), 0);
    const listed = f.store.read(db => f.module.runIds!(db));
    assert.equal(listed.includes(runB), false);

    assert.equal(f.store.deleteRun(runC), true);
    assert.equal(count(f, "eval_tasks", "run_id=?", runC), 0);
  } finally {
    f.close();
  }
});

test("approval marks follow the latest approval", () => {
  const f = ready();
  try {
    const m1 = capturedTaskId(RUN, "m-x1");
    const m2 = capturedTaskId(RUN, "m-x2");
    const m3 = capturedTaskId(RUN, "m-y1");
    f.store.write(tx => insertMarker(tx, captureStart("m-x1", COMMIT), { state: "captured", capsule: capsule() }, NOW));
    f.store.write(tx => insertMarker(tx, captureStart("m-x2", HEAD), { state: "captured", capsule: capsule() }, NOW));
    f.store.write(tx => insertMarker(tx, captureStart("m-y1", COMMIT, { anchorCommit: OTHER_ANCHOR }), { state: "captured", capsule: capsule() }, NOW));

    const approval = (at: string) => ({ runId: RUN, workspace: "workspace-1", anchorCommit: ANCHOR, reviewedHead: HEAD, at });
    const T1 = "2026-11-14T12:10:00.000Z";
    const T2 = "2026-11-14T12:20:00.000Z";

    const first = f.store.write(tx => markApproval(tx, approval(T1)));
    assert.equal(first.length, 2);
    assert.deepEqual(first.map(row => row.taskId).sort(), [m1, m2].sort());
    const second = f.store.write(tx => markApproval(tx, approval(T2)));
    assert.equal(second.length, 2);

    assert.equal(f.store.write(tx => completeApproval(tx, m1, T1, ["src/secret-name.ts"])), false);
    assert.equal(f.store.write(tx => completeApproval(tx, m1, T2, ["src/secret-name.ts"])), true);
    assert.equal(f.store.write(tx => completeApproval(tx, m2, T2, undefined)), true);

    const states = f.store.read(db => db.all<{ task_id: string; approval: string | null }>(
      "SELECT task_id, approval FROM eval_tasks ORDER BY task_id",
    ));
    const byId = new Map(states.map(row => [row.task_id, row.approval]));
    assert.equal(byId.get(m1), "read");
    assert.equal(byId.get(m2), "unknown");
    assert.equal(byId.get(m3), null);
  } finally {
    f.close();
  }
});

test("the corpus caps hold", () => {
  const f = ready();
  try {
    // A project at the byte cap: a stored size of 11 bytes is refused whole, 10 bytes is kept.
    const overA = capturedTaskId(RUN, "m-cap-a");
    f.store.write(tx => insertMarker(tx, captureStart("m-cap-a", COMMIT), { state: "captured", capsule: capsule() }, NOW));
    f.store.write(tx => tx.run("UPDATE eval_tasks SET material_bytes=? WHERE task_id=?", PROJECT_MATERIAL_MAX_BYTES - 10, overA));
    assert.equal(f.store.write(tx => completeMaterial(tx, overA, storeResult([SECRET_FILE], randomBytes(11), undefined), NOW)), true);
    const refused = f.store.read(db => db.get<{ state: string; reason: string; material_bytes: number }>(
      "SELECT state, reason, material_bytes FROM eval_tasks WHERE task_id=?", overA,
    ));
    assert.equal(refused?.state, "rejected");
    assert.equal(refused?.reason, "corpus-full");
    assert.equal(refused?.material_bytes, 0);
    assert.equal(count(f, "eval_material", "task_id=?", overA), 0);

    const fitsB = capturedTaskId(RUN, "m-cap-b");
    f.store.write(tx => insertMarker(tx, captureStart("m-cap-b", HEAD), { state: "captured", capsule: capsule() }, NOW));
    f.store.write(tx => tx.run("UPDATE eval_tasks SET material_bytes=? WHERE task_id=?", PROJECT_MATERIAL_MAX_BYTES - 10, fitsB));
    assert.equal(f.store.write(tx => completeMaterial(tx, fitsB, storeResult([SECRET_FILE], randomBytes(10), undefined), NOW)), true);
    const stored = f.store.read(db => db.get<{ state: string; material: string }>(
      "SELECT state, material FROM eval_tasks WHERE task_id=?", fitsB,
    ));
    assert.equal(stored?.state, "captured");
    assert.equal(stored?.material, "stored");
    assert.equal(count(f, "eval_material", "task_id=? AND part='reference'", fitsB), 1);

    // A project at the row cap: one bulk write holds 20,000 rows, and the next marker is refused.
    const ref = f.store.write(tx => tx.index("project", PROJECT));
    f.store.write(tx => {
      for (let i = 0; i < PROJECT_TASK_MAX; i++) {
        tx.run(
          "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, approved_at, base, "
          + "material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload) "
          + "VALUES (?, 'captured', 'run-bulk', 'm-bulk', ?, 'rejected', 'start-unknown', 'none', NULL, NULL, 'none', 0, ?, ?, ?, NULL, ?)",
          `captured:run-bulk:${i}`, ref, NOW, NOW, NOW, "bulk",
        );
      }
    });
    const full = f.store.write(tx => insertMarker(tx, captureStart("m-late", COMMIT), { state: "captured", capsule: capsule() }, NOW));
    assert.equal(full, "full");
    assert.equal(count(f, "eval_tasks", "run_id=?", RUN), 2);
    const otherProject = f.store.write(tx => insertMarker(
      tx,
      captureStart("m-other", COMMIT, { projectId: "project-other" }),
      { state: "captured", capsule: capsule() },
      NOW,
    ));
    assert.equal(otherProject, "inserted");
    assert.ok(HOST_MATERIAL_MAX_BYTES > PROJECT_MATERIAL_MAX_BYTES);
  } finally {
    f.close();
  }
});

test("retention removes old tasks per project", () => {
  const f = ready();
  try {
    const at = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
    const put = (runId: string, memberId: string, projectId: string, days: number) => {
      const taskId = capturedTaskId(runId, memberId);
      f.store.write(tx => insertMarker(
        tx,
        captureStart(memberId, COMMIT, { runId, projectId, at: at(days) }),
        { state: "captured", capsule: capsule() },
        NOW,
      ));
      f.store.write(tx => completeMaterial(tx, taskId, storeResult([SECRET_FILE], randomBytes(20), undefined), NOW));
      return taskId;
    };
    const oldA = put("run-ret-a", "m-1", "project-a", 31);
    const newA = put("run-ret-a", "m-2", "project-a", 29);
    const oldOther = put("run-ret-o", "m-3", "project-other", 366);
    const newOther = put("run-ret-o", "m-4", "project-other", 364);

    const removed = f.store.write(tx => sweepEvalTasks(tx, NOW, [{ projectId: "project-a", retentionDays: 30 }], 365));
    assert.equal(removed, 2);
    const left = f.store.read(db => db.all<{ task_id: string }>("SELECT task_id FROM eval_tasks").map(row => row.task_id).sort());
    assert.deepEqual(left, [newA, newOther].sort());
    assert.equal(count(f, "eval_material", "task_id=?", oldA), 0);
    assert.equal(count(f, "eval_material", "task_id=?", oldOther), 0);
    assert.equal(count(f, "eval_material", "task_id=?", newA), 2);

    for (let i = 0; i < 150; i++) put("run-ret-bulk", `m-bulk-${i}`, "project-bulk", 31);
    const first = f.store.write(tx => sweepEvalTasks(tx, NOW, [{ projectId: "project-bulk", retentionDays: 30 }], 365));
    const second = f.store.write(tx => sweepEvalTasks(tx, NOW, [{ projectId: "project-bulk", retentionDays: 30 }], 365));
    assert.equal(first, 100);
    assert.equal(second, 50);
    assert.equal(count(f, "eval_tasks", "run_id=?", "run-ret-bulk"), 0);
  } finally {
    f.close();
  }
});
