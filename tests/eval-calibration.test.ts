import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { evalTrialsModule, finishTrial, insertCopy, insertTrial, openTrialCounts, startTrial } from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import type { TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import { CALIBRATION_TASKS_SQL, PAIR_TRIAL_SQL, calibrationPairs, readTrialPatch } from "../packages/host/src/eval-calibration.js";

const NOW = "2026-11-14T12:00:00.000Z";
const PROJECT = "project-1";
const JOB = "job-1";
const PROFILE = { id: "profile-1", label: "Trial", provider: "claude", model: "model-x", effort: "high", tier: "strong" } as TeamModelProfile;
const CONFIGURATION: TrialConfiguration = { profile: PROFILE, guidance: "as-of-base", knowledge: "none" };

function grade(resolved: boolean, isolation: "isolated" | "none" = "isolated"): TrialGrade {
  return { ending: "graded", expectedPassed: resolved ? 1 : 0, expectedTotal: 1, guardPassed: true, resolved, overwritten: 0, diff: null, isolation };
}

type Fixture = { store: EvidenceStore; close: () => void; seq: { n: number } };

function ready(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-calibration-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  store.register(evalTrialsModule(store, () => NOW));
  assert.equal(store.status().modules["eval-trials"], "ready");
  store.write(tx => openTrialCounts(tx, JOB, { tasks: 1, trials: 1000 }));
  return { store, seq: { n: 0 }, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function addGroup(f: Fixture, id: string, holdout: number): void {
  f.store.write(tx => {
    tx.run(
      "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at, confirms, exposed) VALUES (?, 'run', ?, ?, ?, ?, ?, 0, 0)",
      id, tx.index("project", PROJECT), id, NOW, holdout, holdout === 1 ? NOW : null,
    );
  });
}

function addTask(f: Fixture, taskId: string, groupId: string | null): void {
  f.store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id) "
      + "VALUES (?, 'captured', '', '', ?, 'valid', 'stored', 'proven', ?, ?, 'x', ?)",
      taskId, tx.index("project", PROJECT), NOW, NOW, groupId,
    );
  });
}

function addTrial(f: Fixture, taskId: string, resolved: boolean, patch: Buffer | undefined, minute: number, isolation: "isolated" | "none" = "isolated"): string {
  const trialId = `trial-${f.seq.n++}`;
  const at = new Date(Date.parse(NOW) + minute * 60_000).toISOString();
  f.store.write(tx => {
    insertTrial(tx, { trialId, jobId: JOB, taskId, configRef: configRef(CONFIGURATION), harness: TRIAL_HARNESS_VERSION, slot: f.seq.n, attempt: 0,
      projectId: PROJECT, configuration: CONFIGURATION, keepDays: 365 }, at);
    startTrial(tx, trialId, at);
    finishTrial(tx, trialId, { grade: grade(resolved, isolation), configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch }, at);
  });
  return trialId;
}

function exposedOf(f: Fixture, id: string): number {
  return f.store.read(db => db.get<{ exposed: number }>("SELECT exposed FROM eval_groups WHERE group_id = ?", id)?.exposed ?? -1);
}

test("the calibration read returns no holdout task and one pair per task", () => {
  const f = ready();
  try {
    addGroup(f, "g-dev", 0);
    addGroup(f, "g-hold", 1);
    addGroup(f, "g-one", 0);
    addGroup(f, "g-copy", 0);
    addTask(f, "t-dev", "g-dev");
    addTask(f, "t-hold", "g-hold");
    addTask(f, "t-one", "g-one");
    addTask(f, "t-copy", "g-copy");
    addTrial(f, "t-dev", true, Buffer.from("resolved-old"), 1);
    addTrial(f, "t-dev", true, Buffer.from("resolved-mid"), 2);
    const newestResolved = addTrial(f, "t-dev", true, Buffer.from("resolved-new\n\u0000bytes"), 3);
    addTrial(f, "t-dev", false, Buffer.from("unresolved-old"), 4);
    const newestUnresolved = addTrial(f, "t-dev", false, Buffer.from("unresolved-new"), 5);
    addTrial(f, "t-hold", true, Buffer.from("h1"), 1);
    addTrial(f, "t-hold", false, Buffer.from("h0"), 2);
    addTrial(f, "t-one", true, Buffer.from("only-resolved"), 1);
    addTrial(f, "t-copy", true, Buffer.from("c1"), 1);
    const source = addTrial(f, "t-copy", true, Buffer.from("c2"), 2);
    f.store.write(tx => {
      insertCopy(tx, {
        trialId: "copy-1", jobId: JOB, taskId: "t-copy", projectId: PROJECT, configuration: CONFIGURATION, slot: 99,
        promptVersion: "version", keepDays: 365,
        source: { trialId: source, ending: "graded", resolved: false, isolation: "isolated", configId: null, profileEpoch: 1,
          tokens: null, spentUsd: null, cost: null, startedAt: NOW, endedAt: NOW },
      }, NOW);
    });
    const result = calibrationPairs(f.store, { projectId: PROJECT });
    assert.equal(result.next, null);
    assert.equal(result.pairs.length, 1);
    const pair = result.pairs[0]!;
    assert.equal(pair.taskId, "t-dev");
    assert.equal(pair.resolved.trialId, newestResolved);
    assert.equal(pair.unresolved.trialId, newestUnresolved);
    const wantResolved = Buffer.from("resolved-new\n\u0000bytes");
    assert.equal(pair.resolved.patch.length, wantResolved.length);
    assert.equal(pair.resolved.patch.equals(wantResolved), true);
    const wantUnresolved = Buffer.from("unresolved-new");
    assert.equal(pair.unresolved.patch.length, wantUnresolved.length);
    assert.equal(pair.unresolved.patch.equals(wantUnresolved), true);
  } finally {
    f.close();
  }
});

test("the calibration read marks each returned group exposed", () => {
  const f = ready();
  try {
    for (const id of ["g-a", "g-b", "g-c"]) addGroup(f, id, 0);
    addGroup(f, "g-hold", 1);
    addTask(f, "t-a", "g-a");
    addTask(f, "t-b", "g-b");
    addTask(f, "t-c", "g-c");
    addTask(f, "t-hold", "g-hold");
    for (const task of ["t-a", "t-b"]) {
      addTrial(f, task, true, Buffer.from("r"), 1);
      addTrial(f, task, false, Buffer.from("u"), 2);
    }
    addTrial(f, "t-c", true, Buffer.from("r"), 1);
    addTrial(f, "t-hold", true, Buffer.from("r"), 1);
    addTrial(f, "t-hold", false, Buffer.from("u"), 2);
    const result = calibrationPairs(f.store, { projectId: PROJECT });
    assert.equal(result.pairs.length, 2);
    assert.equal(exposedOf(f, "g-a"), 1);
    assert.equal(exposedOf(f, "g-b"), 1);
    assert.equal(exposedOf(f, "g-c"), 0);
    assert.equal(exposedOf(f, "g-hold"), 0);
  } finally {
    f.close();
  }
});

test("the calibration read pages", () => {
  const f = ready();
  try {
    for (let i = 0; i < 25; i++) {
      const id = String(i).padStart(2, "0");
      addGroup(f, `g-${id}`, 0);
      addTask(f, `t-${id}`, `g-${id}`);
      addTrial(f, `t-${id}`, true, Buffer.from("r"), 1);
      addTrial(f, `t-${id}`, false, Buffer.from("u"), 2);
    }
    const first = calibrationPairs(f.store, { projectId: PROJECT, limit: 20 });
    assert.equal(first.pairs.length, 20);
    assert.equal(first.next, "t-19");
    const second = calibrationPairs(f.store, { projectId: PROJECT, after: first.next ?? "", limit: 20 });
    assert.equal(second.pairs.length, 5);
    assert.equal(second.next, null);
  } finally {
    f.close();
  }
});

test("the hot statements read through an index", () => {
  const f = ready();
  try {
    const plans: [string, (string | number)[]][] = [
      [CALIBRATION_TASKS_SQL, ["ref", "", 20]],
      [PAIR_TRIAL_SQL, ["ref", "task", 1]],
    ];
    for (const [sql, params] of plans) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map(row => row.detail);
      assert.equal(details.some(detail => detail.includes("eval_trials_graded")), true, `${sql.slice(0, 40)} uses eval_trials_graded: ${details.join(" | ")}`);
    }
  } finally {
    f.close();
  }
});

test("a pair with a non-isolated trial is not returned", () => {
  const f = ready();
  try {
    addGroup(f, "g-mixed", 0);
    addGroup(f, "g-clean", 0);
    addTask(f, "t-mixed", "g-mixed");
    addTask(f, "t-clean", "g-clean");
    addTrial(f, "t-mixed", true, Buffer.from("r"), 1);
    addTrial(f, "t-mixed", false, Buffer.from("u"), 2, "none");
    addTrial(f, "t-clean", true, Buffer.from("r"), 1);
    addTrial(f, "t-clean", false, Buffer.from("u"), 2);
    const result = calibrationPairs(f.store, { projectId: PROJECT });
    assert.deepEqual(result.pairs.map(pair => pair.taskId), ["t-clean"]);
  } finally {
    f.close();
  }
});

test("a non-isolated resolved trial does not hide an isolated one", () => {
  const f = ready();
  try {
    addGroup(f, "g-a", 0);
    addTask(f, "t-a", "g-a");
    const isolated = addTrial(f, "t-a", true, Buffer.from("isolated-resolved"), 1);
    addTrial(f, "t-a", true, Buffer.from("none-resolved-newer"), 2, "none");
    addTrial(f, "t-a", false, Buffer.from("u"), 3);
    const result = calibrationPairs(f.store, { projectId: PROJECT });
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0]!.resolved.trialId, isolated);
  } finally {
    f.close();
  }
});

test("the patch read returns the stored bytes", () => {
  const f = ready();
  try {
    const bytes = Buffer.from("stored\n\u0000patch");
    const id = addTrial(f, "t-a", true, bytes, 1);
    const read = f.store.read(db => readTrialPatch(db, id));
    assert.equal(read?.length, bytes.length);
    assert.equal(read?.equals(bytes), true);
    assert.equal(f.store.read(db => readTrialPatch(db, "unknown")), undefined);
  } finally {
    f.close();
  }
});
