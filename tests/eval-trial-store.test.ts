import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { EVAL_MODULE } from "../packages/host/src/eval-types.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import {
  EVAL_TRIALS_MODULE,
  JOB_SLOTS_SQL,
  JOB_TRIALS_SQL,
  LIVE_TRIALS_SQL,
  PATCHES_EXPIRED_SQL,
  PROJECT_DAY_SQL,
  TRIAL_PATCH_MAX_BYTES,
  TRIAL_PATCHES_HOST_MAX_BYTES,
  TRIALS_EXPIRED_SQL,
  TRIAL_SESSIONS_SQL,
  dropTrial,
  evalTrialsModule,
  finishTrial,
  gradingTrial,
  insertTrial,
  openTrialCounts,
  readTrial,
  startTrial,
  sweepTrials,
  trialCounts,
  trialsSince,
  type NewTrial,
  type TrialFinal,
} from "../packages/host/src/eval-trial-store.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-14T12:00:00.000Z";
const LATER = new Date(Date.parse(NOW) + 2 * DAY_MS).toISOString();
const JOB = "job-replay-1";
const TASK = "task-7";
// The project id is sealed in the payload and held only as a blind index, so it can carry a sentinel string.
const PROJECT = "Objective-7f3a";
const SECRET_NAME = "secret-name";
const MODEL = "model-Sealed-9";

const PROFILE = { id: "profile-1", label: "Trial", provider: "claude", model: MODEL, effort: "high", tier: "strong" } as TeamModelProfile;
const CONFIGURATION: TrialConfiguration = { profile: PROFILE, guidance: "as-of-base", knowledge: "none" };

const GRADED: TrialGrade = { ending: "graded", expectedPassed: 1, expectedTotal: 1, guardPassed: true, resolved: true,
  overwritten: 0, diff: null, isolation: "isolated" };
const VOID: TrialGrade = { ending: "void-host", expectedPassed: null, expectedTotal: 1, guardPassed: null, resolved: false,
  overwritten: 0, diff: null, isolation: "none" };

type Fixture = { store: EvidenceStore; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-trials-"));
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

/** A fixture with the trial module, and the corpus module that owns `eval_jobs`, registered and ready. */
function ready(): Fixture {
  const f = fixture();
  f.store.register(evalCorpusModule(f.store, () => NOW));
  f.store.register(evalTrialsModule(f.store, () => NOW));
  assert.equal(f.store.status().modules[EVAL_TRIALS_MODULE], "ready");
  assert.equal(f.store.status().modules[EVAL_MODULE], "ready");
  return f;
}

function newTrial(trialId: string, slot = 0, attempt = 0): NewTrial {
  return {
    trialId, jobId: JOB, taskId: TASK, configRef: configRef(CONFIGURATION), harness: TRIAL_HARNESS_VERSION,
    slot, attempt, projectId: PROJECT, configuration: CONFIGURATION, keepDays: 365,
  };
}

function finalOf(grade: TrialGrade, patch?: Buffer | "too-large" | "secret-shaped", patchKeepDays = 90): TrialFinal {
  return { grade, configId: null, profileEpoch: null, sessionId: null, patchKeepDays, patch };
}

/** Plain columns of every trial table: the sealed payload column is left out. */
function plainColumns(f: Fixture): string {
  return f.store.read(db => ["eval_trials", "eval_trial_counts", "eval_trial_patches", "eval_trial_totals"]
    .map(table => JSON.stringify(db.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map(({ payload: _payload, ...rest }) => rest)))
    .join("\n"));
}

function countsOf(f: Fixture) {
  const counts = f.store.read(db => trialCounts(db, [JOB])).get(JOB);
  assert.ok(counts, "the job has a counts row");
  return counts;
}

test("trial rows keep every text sealed", () => {
  const f = ready();
  try {
    f.store.write(tx => {
      openTrialCounts(tx, JOB, { tasks: 1, trials: 1 });
      assert.equal(insertTrial(tx, newTrial("trial-1"), NOW), "inserted");
      assert.equal(startTrial(tx, "trial-1", NOW), true);
      assert.equal(gradingTrial(tx, "trial-1", NOW), true);
      assert.equal(finishTrial(tx, "trial-1", finalOf(GRADED, Buffer.from(`${SECRET_NAME} patch body`)), NOW), true);
    });
    const plain = plainColumns(f);
    assert.equal(plain.includes(SECRET_NAME), false, "the patch text stays out of every plain column");
    assert.equal(plain.includes(MODEL), false, "the profile model stays out of every plain column");
    assert.equal(plain.includes(PROJECT), false, "the project id stays out of every plain column");
    const row = f.store.read(db => readTrial(db, "trial-1"));
    assert.equal(row?.payload.configuration.profile.model, MODEL, "the sealed payload still opens");
    assert.equal(row?.payload.patch, "stored");
    const daily = (projectId: string, since: string) => f.store.read(db => trialsSince(db, projectId, since));
    assert.equal(daily(PROJECT, NOW), 1, "the day's count finds the trial by its project id");
    assert.equal(daily("Objective-other", NOW), 0, "another project's trials are apart");
    assert.equal(daily(PROJECT, LATER), 0, "a trial created before the start is not counted");
  } finally {
    f.close();
  }
});

test("a trial moves through its states once", () => {
  const f = ready();
  try {
    f.store.write(tx => openTrialCounts(tx, JOB, { tasks: 1, trials: 4 }));
    assert.equal(f.store.write(tx => insertTrial(tx, newTrial("trial-1"), NOW)), "inserted");
    assert.equal(f.store.write(tx => insertTrial(tx, newTrial("trial-1"), NOW)), "exists");

    assert.equal(f.store.write(tx => insertTrial(tx, newTrial("trial-2", 0, 1), NOW)), "inserted");
    assert.equal(f.store.write(tx => dropTrial(tx, "trial-2")), true, "dropTrial removes a preparing row");
    assert.equal(f.store.read(db => readTrial(db, "trial-2")), undefined);

    assert.equal(f.store.write(tx => startTrial(tx, "trial-1", NOW)), true);
    assert.equal(countsOf(f).started, 1);
    assert.equal(f.store.write(tx => dropTrial(tx, "trial-1")), false, "dropTrial refuses a running row");
    assert.equal(f.store.read(db => readTrial(db, "trial-1"))?.state, "running");

    assert.equal(f.store.write(tx => gradingTrial(tx, "trial-1", NOW)), true);
    assert.equal(f.store.write(tx => finishTrial(tx, "trial-1", finalOf(GRADED), NOW)), true);
    assert.equal(f.store.write(tx => finishTrial(tx, "trial-1", finalOf(VOID), NOW)), false, "a second finish writes nothing");
    const done = f.store.read(db => readTrial(db, "trial-1"));
    assert.equal(done?.state, "final");
    assert.equal(done?.ending, "graded", "the second finish did not change the ending");
    assert.equal(done?.resolved, true);
    const afterGrade = countsOf(f);
    assert.equal(afterGrade.graded, 1);
    assert.equal(afterGrade.resolved, 1);
    assert.equal(afterGrade.voidStreak, 0);

    const voids: [string, number][] = [["trial-3", 0], ["trial-4", 1], ["trial-5", 2]];
    for (const [id, attempt] of voids) {
      f.store.write(tx => insertTrial(tx, newTrial(id, 1, attempt), NOW));
      f.store.write(tx => startTrial(tx, id, NOW));
      assert.equal(f.store.write(tx => finishTrial(tx, id, finalOf(VOID), NOW)), true, "a void ends a running trial");
    }
    const afterVoids = countsOf(f);
    assert.equal(afterVoids.void, 3);
    assert.equal(afterVoids.voidStreak, 3, "three voids in a row give a streak of 3");
    assert.equal(afterVoids.ended, 0, "a void is not an ended trial");

    f.store.write(tx => insertTrial(tx, newTrial("trial-6", 2, 0), NOW));
    f.store.write(tx => startTrial(tx, "trial-6", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-6", NOW));
    f.store.write(tx => finishTrial(tx, "trial-6", finalOf(GRADED), NOW));
    const afterGraded = countsOf(f);
    assert.equal(afterGraded.voidStreak, 0, "a graded trial after voids resets the streak");
    assert.equal(afterGraded.graded, 2);
    assert.equal(afterGraded.started, 5, "five trials started; the dropped trial-2 never did");

    f.store.write(tx => insertTrial(tx, newTrial("trial-7", 3, 0), NOW));
    f.store.write(tx => startTrial(tx, "trial-7", NOW));
    f.store.write(tx => finishTrial(tx, "trial-7", finalOf({ ...VOID, ending: "timeout", isolation: "isolated" }), NOW));
    const afterTimeout = countsOf(f);
    assert.equal(afterTimeout.ended, 1, "a timeout is an ended trial");
    assert.equal(afterTimeout.void, 3, "a timeout is not a void");
  } finally {
    f.close();
  }
});

test("the patch caps hold", () => {
  const f = ready();
  try {
    f.store.write(tx => openTrialCounts(tx, JOB, { tasks: 1, trials: 6 }));
    const patchRows = () => f.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_trial_patches")?.n ?? 0);
    const totalBytes = () => f.store.read(db => db.get<{ n: number }>("SELECT patch_bytes AS n FROM eval_trial_totals")?.n ?? 0);
    const storedBytes = () => f.store.read(db => db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM eval_trial_patches")?.n ?? 0);

    // A stored patch, then a sweep after its keep period: the total returns to the sum of the rows.
    f.store.write(tx => insertTrial(tx, newTrial("trial-1"), NOW));
    f.store.write(tx => startTrial(tx, "trial-1", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-1", NOW));
    assert.equal(f.store.write(tx => finishTrial(tx, "trial-1", finalOf(GRADED, Buffer.alloc(50), 1), NOW)), true);
    assert.equal(readTrialPatch(f, "trial-1"), "stored");
    assert.equal(totalBytes(), 50);
    assert.equal(patchRows(), 1);
    f.store.write(tx => sweepTrials(tx, LATER));
    assert.equal(patchRows(), 0, "the expired patch is swept");
    assert.equal(totalBytes(), storedBytes(), "the total equals the sum of the stored bytes after a sweep");
    assert.equal(totalBytes(), 0);
    assert.ok(f.store.read(db => readTrial(db, "trial-1")), "the trial row outlives its patch");

    // One byte over the per-patch cap: the payload says too-large, and nothing is stored.
    f.store.write(tx => insertTrial(tx, newTrial("trial-2", 0, 1), NOW));
    f.store.write(tx => startTrial(tx, "trial-2", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-2", NOW));
    f.store.write(tx => finishTrial(tx, "trial-2", finalOf(GRADED, Buffer.alloc(TRIAL_PATCH_MAX_BYTES + 1)), NOW));
    assert.equal(readTrialPatch(f, "trial-2"), "too-large");
    assert.equal(patchRows(), 0, "no patch row for an oversized patch");

    // Exactly the per-patch cap is stored, and its sweep returns the total to zero.
    f.store.write(tx => insertTrial(tx, newTrial("trial-5", 0, 4), NOW));
    f.store.write(tx => startTrial(tx, "trial-5", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-5", NOW));
    f.store.write(tx => finishTrial(tx, "trial-5", finalOf(GRADED, Buffer.alloc(TRIAL_PATCH_MAX_BYTES), 1), NOW));
    assert.equal(readTrialPatch(f, "trial-5"), "stored", "a patch of exactly the cap fits");
    assert.equal(totalBytes(), TRIAL_PATCH_MAX_BYTES);
    f.store.write(tx => sweepTrials(tx, LATER));
    assert.equal(totalBytes(), 0);

    // A trial whose keep period ends before its patch's: the sweep deletes both, and the total stays exact.
    f.store.write(tx => insertTrial(tx, { ...newTrial("trial-4", 0, 3), keepDays: 1 }, NOW));
    f.store.write(tx => startTrial(tx, "trial-4", NOW));
    f.store.write(tx => finishTrial(tx, "trial-4", finalOf(GRADED, Buffer.alloc(30)), NOW));
    assert.equal(patchRows(), 1);
    f.store.write(tx => sweepTrials(tx, LATER));
    assert.equal(f.store.read(db => readTrial(db, "trial-4")), undefined, "the expired trial is swept");
    assert.equal(patchRows(), 0, "its patch goes with it");
    assert.equal(totalBytes(), 0, "and the total stays exact");

    // The host total near its cap: a 20-byte patch that fills the cap exactly is stored.
    f.store.write(tx => tx.run("UPDATE eval_trial_totals SET patch_bytes = ?", TRIAL_PATCHES_HOST_MAX_BYTES - 20));
    f.store.write(tx => insertTrial(tx, newTrial("trial-6", 0, 5), NOW));
    f.store.write(tx => startTrial(tx, "trial-6", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-6", NOW));
    f.store.write(tx => finishTrial(tx, "trial-6", finalOf(GRADED, Buffer.alloc(20)), NOW));
    assert.equal(readTrialPatch(f, "trial-6"), "stored", "a patch that fills the host cap exactly fits");
    assert.equal(totalBytes(), TRIAL_PATCHES_HOST_MAX_BYTES);

    // Ten bytes below the cap, a 20-byte patch no longer fits, so it is dropped.
    f.store.write(tx => tx.run("UPDATE eval_trial_totals SET patch_bytes = ?", TRIAL_PATCHES_HOST_MAX_BYTES - 10));
    f.store.write(tx => insertTrial(tx, newTrial("trial-3", 0, 2), NOW));
    f.store.write(tx => startTrial(tx, "trial-3", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-3", NOW));
    f.store.write(tx => finishTrial(tx, "trial-3", finalOf(GRADED, Buffer.alloc(20)), NOW));
    assert.equal(readTrialPatch(f, "trial-3"), "dropped");
    assert.equal(patchRows(), 1, "only the patch that fit is stored");
    assert.equal(totalBytes(), TRIAL_PATCHES_HOST_MAX_BYTES - 10, "a dropped patch leaves the total unchanged");
  } finally {
    f.close();
  }
});

test("a sweep keeps the counts of a live job", () => {
  const f = ready();
  try {
    f.store.write(tx => {
      tx.run("INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
        + "VALUES (?, 'ref', 'replay', 'running', 'request-1', ?, ?, ?, '{}')", JOB, NOW, LATER, NOW);
      openTrialCounts(tx, JOB, { tasks: 1, trials: 1 });
      openTrialCounts(tx, "job-gone", { tasks: 1, trials: 1 });
      sweepTrials(tx, LATER);
    });
    const counts = f.store.read(db => trialCounts(db, [JOB, "job-gone"]));
    assert.equal(counts.has(JOB), true, "a live job keeps its counts");
    assert.equal(counts.has("job-gone"), false, "the counts of a job gone from eval_jobs are swept");
  } finally {
    f.close();
  }
});

function readTrialPatch(f: Fixture, trialId: string): string | undefined {
  return f.store.read(db => readTrial(db, trialId))?.payload.patch;
}

test("the hot statements read through an index", () => {
  const f = ready();
  try {
    const plans: [string, (string | number)[], string][] = [
      [LIVE_TRIALS_SQL, [], "eval_trials_live"],
      [JOB_SLOTS_SQL, [JOB, TASK], "eval_trials_job"],
      [JOB_TRIALS_SQL, [JOB], "eval_trials_job"],
      [PROJECT_DAY_SQL, ["ref", NOW], "eval_trials_project_day"],
      [TRIALS_EXPIRED_SQL, [NOW, 100], "eval_trials_expiry"],
      [PATCHES_EXPIRED_SQL, [NOW, 100], "eval_trial_patches_expiry"],
      [TRIAL_SESSIONS_SQL, [NOW, 100], "eval_trials_sessions"],
    ];
    for (const [sql, params, index] of plans) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params))
        .map(row => row.detail);
      assert.equal(details.some(detail => detail.includes(index)), true, `${sql.slice(0, 40)} uses ${index}: ${details.join(" | ")}`);
    }
  } finally {
    f.close();
  }
});

