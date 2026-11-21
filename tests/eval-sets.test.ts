import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import {
  HOLDOUT_AGED_SQL,
  HOLDOUT_USED_SQL,
  SET_COUNTS_SQL,
  TRIAL_TASKS_SQL,
  drawnSet,
  drawsHoldout,
  markExposed,
  mergedSet,
  rotateHoldout,
  setCounts,
  type GroupSetRow,
} from "../packages/host/src/eval-sets.js";

const NOW = "2026-11-14T12:00:00.000Z";
const DAY_MS = 86_400_000;
const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

function open(key: Buffer): { store: EvidenceStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-sets-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: key });
  store.register(evalCorpusModule(store, () => NOW));
  assert.equal(store.status().modules["eval-corpus"], "ready");
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function addGroup(store: EvidenceStore, id: string, project: string, fields: { holdout?: number; setAt?: string | null; confirms?: number; exposed?: number } = {}): void {
  store.write(tx => {
    tx.run(
      "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at, confirms, exposed) VALUES (?, 'run', ?, ?, ?, ?, ?, ?, ?)",
      id,
      project,
      id,
      NOW,
      fields.holdout ?? 1,
      fields.setAt === undefined ? daysAgo(1) : fields.setAt,
      fields.confirms ?? 0,
      fields.exposed ?? 0,
    );
  });
}

function holdoutOf(store: EvidenceStore, id: string): number {
  return store.read(db => db.get<{ holdout: number }>("SELECT holdout FROM eval_groups WHERE group_id = ?", id)?.holdout ?? -1);
}

function holdoutCount(store: EvidenceStore, project: string): number {
  return store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_groups WHERE project_ref = ? AND holdout = 1", project)?.n ?? -1);
}

function row(fields: Partial<GroupSetRow>): GroupSetRow {
  return { holdout: 1, exposed: 0, dev_only: 0, set_at: NOW, confirms: 0, ...fields };
}

test("the draw puts three in ten groups in holdout", () => {
  assert.equal(drawsHoldout("4ccccccc" + "0".repeat(56)), true);
  assert.equal(drawsHoldout("4ccccccd" + "0".repeat(56)), false);
  const a = open(KEY_A);
  const b = open(KEY_B);
  try {
    let holdout = 0;
    let differs = false;
    for (let i = 0; i < 10_000; i++) {
      const id = `run:${i}`;
      const first = a.store.write(tx => drawnSet(tx, id, NOW));
      const again = a.store.write(tx => drawnSet(tx, id, NOW));
      assert.deepEqual(again, first);
      if (first.holdout === 1) {
        holdout++;
        assert.equal(first.setAt, NOW);
      } else {
        assert.equal(first.setAt, null);
      }
      if (i < 200 && b.store.write(tx => drawnSet(tx, id, NOW)).holdout !== first.holdout) differs = true;
    }
    const share = holdout / 10_000;
    assert.ok(share > 0.28 && share < 0.32, `share ${share}`);
    assert.equal(differs, true);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a merged group is holdout only when every part was", () => {
  const both = mergedSet([row({ set_at: "2026-11-02T00:00:00.000Z", confirms: 1 }), row({ set_at: "2026-11-01T00:00:00.000Z", confirms: 3 })], false);
  assert.equal(both.holdout, 1);
  assert.equal(both.setAt, "2026-11-01T00:00:00.000Z");
  assert.equal(both.confirms, 3);
  const cases: { rows: GroupSetRow[]; devOnly: boolean }[] = [
    { rows: [row({}), row({ holdout: 0, set_at: null })], devOnly: false },
    { rows: [row({}), row({ exposed: 1 })], devOnly: false },
    { rows: [row({}), row({ dev_only: 1 })], devOnly: false },
    { rows: [row({}), row({})], devOnly: true },
  ];
  for (const one of cases) {
    const merged = mergedSet(one.rows, one.devOnly);
    assert.equal(merged.holdout, 0);
    assert.equal(merged.setAt, null);
  }
  assert.equal(mergedSet([row({}), row({ exposed: 1 })], false).exposed, 1);
});

test("exposure moves a holdout group to dev at once and never back", () => {
  const f = open(KEY_A);
  try {
    addGroup(f.store, "run:h", "project-1");
    addGroup(f.store, "run:d", "project-1", { holdout: 0, setAt: null });
    assert.equal(f.store.write(tx => markExposed(tx, "run:h")), true);
    const moved = f.store.read(db => db.get<{ holdout: number; exposed: number; set_at: string | null }>("SELECT holdout, exposed, set_at FROM eval_groups WHERE group_id = 'run:h'"));
    assert.equal(moved?.holdout, 0);
    assert.equal(moved?.exposed, 1);
    assert.equal(moved?.set_at, null);
    const later = mergedSet([row({}), row({ holdout: 0, exposed: 1, set_at: null })], false);
    assert.equal(later.holdout, 0);
    assert.equal(f.store.write(tx => markExposed(tx, "run:d")), false);
    assert.equal(f.store.read(db => db.get<{ exposed: number }>("SELECT exposed FROM eval_groups WHERE group_id = 'run:d'")?.exposed), 1);
    assert.equal(f.store.write(tx => markExposed(tx, "run:missing")), false);
  } finally {
    f.cleanup();
  }
});

test("rotation moves used and aged groups, at most 100 a pass", () => {
  const f = open(KEY_A);
  try {
    for (let i = 0; i < 150; i++) addGroup(f.store, `run:aged-${i}`, "project-1", { setAt: daysAgo(200) });
    assert.equal(f.store.write(tx => rotateHoldout(tx, NOW)), 100);
    assert.equal(holdoutCount(f.store, "project-1"), 50);
    assert.equal(f.store.write(tx => rotateHoldout(tx, NOW)), 50);
    assert.equal(holdoutCount(f.store, "project-1"), 0);

    addGroup(f.store, "run:used-5", "project-2", { confirms: 5 });
    addGroup(f.store, "run:used-4", "project-2", { confirms: 4 });
    addGroup(f.store, "run:age-119", "project-2", { setAt: daysAgo(119) });
    addGroup(f.store, "run:age-120", "project-2", { setAt: daysAgo(120) });
    assert.equal(f.store.write(tx => rotateHoldout(tx, NOW)), 2);
    assert.equal(holdoutOf(f.store, "run:used-5"), 0);
    assert.equal(holdoutOf(f.store, "run:used-4"), 1);
    assert.equal(holdoutOf(f.store, "run:age-119"), 1);
    assert.equal(holdoutOf(f.store, "run:age-120"), 0);
  } finally {
    f.cleanup();
  }
});

test("rotation waits for every confirm report", () => {
  const f = open(KEY_A);
  try {
    addGroup(f.store, "run:a-old", "project-a", { setAt: daysAgo(300) });
    addGroup(f.store, "run:a-used", "project-a", { confirms: 5 });
    addGroup(f.store, "run:b-old", "project-b", { setAt: daysAgo(300) });
    f.store.write(tx => {
      tx.run(
        "INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
        + "VALUES ('job-1', 'project-a', 'confirm', 'running', 'req-1', ?, ?, ?, 'x')",
        NOW,
        NOW,
        NOW,
      );
    });
    assert.equal(f.store.write(tx => rotateHoldout(tx, NOW)), 1);
    assert.equal(holdoutOf(f.store, "run:a-old"), 1);
    assert.equal(holdoutOf(f.store, "run:a-used"), 1);
    assert.equal(holdoutOf(f.store, "run:b-old"), 0);
    f.store.write(tx => tx.run("UPDATE eval_jobs SET reported_at = ? WHERE job_id = 'job-1'", NOW));
    assert.equal(f.store.write(tx => rotateHoldout(tx, NOW)), 2);
    assert.equal(holdoutOf(f.store, "run:a-old"), 0);
    assert.equal(holdoutOf(f.store, "run:a-used"), 0);
  } finally {
    f.cleanup();
  }
});

test("a project with an unreported confirm does not use up the pass", () => {
  const f = open(KEY_A);
  try {
    f.store.write(tx => {
      for (let i = 0; i < 100; i += 1) {
        tx.run(
          "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', 'project-a', ?, ?, 1, ?)",
          `run:a-${i}`, `run:a-${i}`, NOW, daysAgo(300),
        );
      }
      tx.run(
        "INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
        + "VALUES ('job-1', 'project-a', 'confirm', 'paused', 'req-1', ?, ?, ?, 'x')",
        NOW, NOW, NOW,
      );
    });
    for (let i = 0; i < 5; i += 1) addGroup(f.store, `run:b-${i}`, "project-b", { setAt: daysAgo(200) });
    assert.equal(f.store.write(tx => rotateHoldout(tx, NOW)), 5, "all of project b's roots move in one pass");
    assert.equal(holdoutCount(f.store, "project-b"), 0);
    assert.equal(holdoutCount(f.store, "project-a"), 100, "none of project a's roots move");
  } finally {
    f.cleanup();
  }
});

test("the hot statements read through an index", () => {
  const f = open(KEY_A);
  try {
    const plan = (sql: string, ...params: (string | number)[]): string => f.store.read(db => db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
      .map(step => step.detail)
      .join("\n"));
    assert.match(plan(TRIAL_TASKS_SQL, "p", ""), /eval_tasks_next/);
    assert.match(plan(HOLDOUT_USED_SQL, 100), /eval_groups_holdout_used/);
    assert.match(plan(HOLDOUT_AGED_SQL, NOW, 100), /eval_groups_holdout_age/);
    assert.match(plan(HOLDOUT_USED_SQL, 100), /eval_jobs_unreported/, "the held projects are read through the partial index");
    assert.match(plan(HOLDOUT_AGED_SQL, NOW, 100), /eval_jobs_unreported/);
    const counts = plan(SET_COUNTS_SQL, "p");
    assert.doesNotMatch(counts, /SCAN t\b|SCAN eval_tasks/);
    assert.match(counts, /SEARCH t USING|SEARCH eval_tasks USING/);
  } finally {
    f.cleanup();
  }
});

test("set counts read tasks through their root", () => {
  const f = open(KEY_A);
  try {
    addGroup(f.store, "run:h", "project-1");
    addGroup(f.store, "run:d", "project-1", { holdout: 0, setAt: null, exposed: 1 });
    f.store.write(tx => {
      const insert = (id: string, group: string | null): void => {
        tx.run(
          "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id) "
          + "VALUES (?, 'captured', '', '', 'project-1', 'valid', 'stored', 'proven', ?, ?, 'x', ?)",
          id,
          NOW,
          NOW,
          group,
        );
      };
      insert("t1", "run:h");
      insert("t2", "run:h");
      insert("t3", "run:d");
      insert("t4", null);
    });
    const counts = f.store.read(db => setCounts(db, "project-1"));
    assert.deepEqual(counts, { dev: 2, holdout: 2, holdoutGroups: 1, exposedGroups: 1 });
  } finally {
    f.cleanup();
  }
});
