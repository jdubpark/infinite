import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceModule, EvidenceTx } from "../packages/host/src/evidence/types.js";
import { EVAL_MODULE } from "../packages/host/src/eval-types.js";
import { SCHEMA_V1, SCHEMA_V2, evalCorpusModule } from "../packages/host/src/eval-store.js";
import { drawsHoldout } from "../packages/host/src/eval-sets.js";

const NOW = "2026-11-14T12:00:00.000Z";
const PROJECT = "project-v3-1";
const KEY = Buffer.alloc(32, 5);

function setup(): { open: () => EvidenceStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-store-v3-"));
  const databasePath = evidenceDatabasePath(join(root, "state"));
  return {
    open: () => new EvidenceStore({ databasePath, vaultKey: KEY }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function v2Module(): EvidenceModule {
  return {
    name: EVAL_MODULE,
    version: 2,
    readVersion: 2,
    migrate(tx, from) {
      if (from === 0) for (const statement of SCHEMA_V1) tx.exec(statement);
      if (from < 2) for (const statement of SCHEMA_V2) tx.exec(statement);
    },
  };
}

const V2_TASK_COLUMNS = "task_id, origin, run_id, member_id, project_ref, state, reason, material, base, captured_at, checked_at, payload, "
  + "group_id, commit_ref, area_ref, lineage, validated_at, attempts, paths_indexed";

type TaskInput = { id: string; origin: "captured" | "mined"; state: string; group: string; payload: unknown; sealed?: string };

function addTask(tx: EvidenceTx, project: string, task: TaskInput): void {
  tx.run(
    `INSERT INTO eval_tasks (${V2_TASK_COLUMNS}) VALUES (?, ?, 'run-1', 'm-1', ?, ?, NULL, 'stored', 'proven', ?, ?, ?, ?, NULL, 'area-x', 'clear', NULL, 2, 1)`,
    task.id,
    task.origin,
    project,
    task.state,
    NOW,
    NOW,
    task.sealed ?? tx.seal("eval_tasks", task.id, task.payload),
    task.group,
  );
}

function addGroup(tx: EvidenceTx, id: string, project: string, devOnly: number, createdAt: string): void {
  tx.run(
    "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, dev_only, landing_ref, created_at) VALUES (?, 'run', ?, ?, ?, 'landing-1', ?)",
    id,
    project,
    id,
    devOnly,
    createdAt,
  );
}

function v2Snapshot(store: EvidenceStore): string {
  return JSON.stringify(store.read(db => ({
    tasks: db.all(`SELECT ${V2_TASK_COLUMNS} FROM eval_tasks ORDER BY task_id`),
    groups: db.all("SELECT group_id, kind, project_ref, root_id, dev_only, landing_ref, landing_checked_at, created_at FROM eval_groups ORDER BY group_id"),
  })));
}

test("the v3 migration draws every root once", () => {
  const f = setup();
  try {
    let store = f.open();
    store.register(v2Module());
    assert.equal(store.status().modules[EVAL_MODULE], "ready");
    const devOnly = new Set([3, 11]);
    const measured = new Set([5, 17, 29]);
    store.write(tx => {
      tx.exec("CREATE TABLE eval_trials (trial_id TEXT PRIMARY KEY, task_id TEXT NOT NULL)");
      const ref = tx.index("project", PROJECT);
      for (let i = 0; i < 40; i++) {
        const group = `run:g${i}`;
        const created = `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`;
        addGroup(tx, group, ref, devOnly.has(i) ? 1 : 0, created);
        addTask(tx, ref, { id: `t${i}`, origin: "captured", state: "valid", group, payload: { projectId: PROJECT } });
        if (measured.has(i)) tx.run("INSERT INTO eval_trials (trial_id, task_id) VALUES (?, ?)", `trial-${i}`, `t${i}`);
      }
      tx.run("INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at) VALUES ('run:child', 'run', ?, 'run:g0', ?)", ref, NOW);
    });
    const beforeV2 = v2Snapshot(store);
    store.close();

    store = f.open();
    store.register(evalCorpusModule(store, () => NOW));
    assert.equal(store.status().modules[EVAL_MODULE], "ready");
    assert.equal(v2Snapshot(store), beforeV2);

    type G = { group_id: string; root_id: string; holdout: number; set_at: string | null; created_at: string; exposed: number; confirms: number };
    const groups = store.read(db => db.all<G>("SELECT group_id, root_id, holdout, set_at, created_at, exposed, confirms FROM eval_groups ORDER BY group_id"));
    assert.equal(groups.length, 41);
    let holdoutRoots = 0;
    for (const group of groups) {
      assert.equal(group.exposed, 0);
      assert.equal(group.confirms, 0);
      if (group.group_id !== group.root_id) {
        assert.equal(group.holdout, 0);
        assert.equal(group.set_at, null);
        continue;
      }
      const i = Number(group.group_id.slice("run:g".length));
      const drawn = drawsHoldout(store.read(db => db.index("eval-set", group.group_id)));
      const expected = !devOnly.has(i) && !measured.has(i) && drawn;
      assert.equal(group.holdout === 1, expected, group.group_id);
      assert.equal(group.set_at, expected ? group.created_at : null);
      if (expected) holdoutRoots++;
    }
    assert.ok(holdoutRoots > 0);
    const after = JSON.stringify(groups);
    store.close();

    store = f.open();
    store.register(evalCorpusModule(store, () => NOW));
    assert.equal(JSON.stringify(store.read(db => db.all<G>("SELECT group_id, root_id, holdout, set_at, created_at, exposed, confirms FROM eval_groups ORDER BY group_id"))), after);
    store.close();
  } finally {
    f.cleanup();
  }
});

test("the v3 migration fills the prompt origin and kind", () => {
  const f = setup();
  try {
    let store = f.open();
    store.register(v2Module());
    const features = { role: "implementer", area: "area-x", kind: "bugfix", risk: "normal", featureVersion: 1 };
    store.write(tx => {
      const ref = tx.index("project", PROJECT);
      addGroup(tx, "run:a", ref, 0, NOW);
      addTask(tx, ref, { id: "captured-valid", origin: "captured", state: "valid", group: "run:a", payload: { projectId: PROJECT, features } });
      addTask(tx, ref, { id: "captured-nofeatures", origin: "captured", state: "candidate", group: "run:a", payload: { projectId: PROJECT } });
      addTask(tx, ref, { id: "mined-candidate", origin: "mined", state: "candidate", group: "run:a", payload: { projectId: PROJECT, promptOrigin: "commit-message", features: { ...features, kind: null } } });
      addTask(tx, ref, { id: "rejected", origin: "captured", state: "rejected", group: "run:a", payload: { projectId: PROJECT } });
      addTask(tx, ref, { id: "unreadable", origin: "captured", state: "valid", group: "run:a", payload: null, sealed: "not a sealed payload" });
    });
    store.close();

    store = f.open();
    store.register(evalCorpusModule(store, () => NOW));
    assert.equal(store.status().modules[EVAL_MODULE], "ready");
    const rows = store.read(db => db.all<{ task_id: string; prompt_origin: string | null; kind: string | null }>(
      "SELECT task_id, prompt_origin, kind FROM eval_tasks ORDER BY task_id",
    ));
    const byId = new Map(rows.map(row => [row.task_id, row]));
    assert.equal(byId.get("captured-valid")?.prompt_origin, "assignment");
    assert.equal(byId.get("captured-valid")?.kind, "bugfix");
    assert.equal(byId.get("captured-nofeatures")?.prompt_origin, "assignment");
    assert.equal(byId.get("captured-nofeatures")?.kind, null);
    assert.equal(byId.get("mined-candidate")?.prompt_origin, "commit-message");
    assert.equal(byId.get("mined-candidate")?.kind, null);
    for (const id of ["rejected", "unreadable"]) {
      assert.equal(byId.get(id)?.prompt_origin, null, id);
      assert.equal(byId.get(id)?.kind, null, id);
    }
    store.close();
  } finally {
    f.cleanup();
  }
});

test("an older host leaves the corpus unavailable", () => {
  const f = setup();
  try {
    let store = f.open();
    store.register(evalCorpusModule(store, () => NOW));
    assert.equal(store.status().modules[EVAL_MODULE], "ready");
    store.close();

    store = f.open();
    store.register(v2Module());
    assert.equal(store.status().modules[EVAL_MODULE], "unavailable");
    store.close();
  } finally {
    f.cleanup();
  }
});
