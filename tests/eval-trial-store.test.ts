import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { promptVersion } from "../packages/host/src/config-identity.js";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import type { EvidenceModule } from "../packages/host/src/evidence/types.js";
import { configRef, TRIAL_HARNESS_VERSION, trialPromptVersion } from "../packages/host/src/eval-trial-rules.js";
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
  JOB_ROWS_SQL,
  REUSE_SQL,
  SCHEMA_TRIALS_V1,
  clearTrialSession,
  dropTrial,
  evalTrialsModule,
  finishTrial,
  gradingTrial,
  insertCopy,
  insertTrial,
  jobRows,
  reusable,
  openTrialCounts,
  readTrial,
  startTrial,
  sweepTrials,
  trialCounts,
  trialsSince,
  type NewTrial,
  type ReuseSource,
  type TrialFinal,
} from "../packages/host/src/eval-trial-store.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-14T12:00:00.000Z";
const LATER = new Date(Date.parse(NOW) + 2 * DAY_MS).toISOString();
const JOB = "job-replay-1";
const TASK = "task-7";
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
    const extra = f.store.read(db => ["eval_reports", "eval_subjects", "eval_priors"]
      .map(table => JSON.stringify(db.all<Record<string, unknown>>(`SELECT * FROM ${table}`))).join("\n"));
    assert.equal(extra.includes(SECRET_NAME), false, "no plain column of the report, subject, or prior tables holds a text");
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

    f.store.write(tx => insertTrial(tx, newTrial("trial-2", 0, 1), NOW));
    f.store.write(tx => startTrial(tx, "trial-2", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-2", NOW));
    f.store.write(tx => finishTrial(tx, "trial-2", finalOf(GRADED, Buffer.alloc(TRIAL_PATCH_MAX_BYTES + 1)), NOW));
    assert.equal(readTrialPatch(f, "trial-2"), "too-large");
    assert.equal(patchRows(), 0, "no patch row for an oversized patch");

    f.store.write(tx => insertTrial(tx, newTrial("trial-5", 0, 4), NOW));
    f.store.write(tx => startTrial(tx, "trial-5", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-5", NOW));
    f.store.write(tx => finishTrial(tx, "trial-5", finalOf(GRADED, Buffer.alloc(TRIAL_PATCH_MAX_BYTES), 1), NOW));
    assert.equal(readTrialPatch(f, "trial-5"), "stored", "a patch of exactly the cap fits");
    assert.equal(totalBytes(), TRIAL_PATCH_MAX_BYTES);
    f.store.write(tx => sweepTrials(tx, LATER));
    assert.equal(totalBytes(), 0);

    f.store.write(tx => insertTrial(tx, { ...newTrial("trial-4", 0, 3), keepDays: 1 }, NOW));
    f.store.write(tx => startTrial(tx, "trial-4", NOW));
    f.store.write(tx => finishTrial(tx, "trial-4", finalOf(GRADED, Buffer.alloc(30)), NOW));
    assert.equal(patchRows(), 1);
    f.store.write(tx => sweepTrials(tx, LATER));
    assert.equal(f.store.read(db => readTrial(db, "trial-4")), undefined, "the expired trial is swept");
    assert.equal(patchRows(), 0, "its patch goes with it");
    assert.equal(totalBytes(), 0, "and the total stays exact");

    f.store.write(tx => tx.run("UPDATE eval_trial_totals SET patch_bytes = ?", TRIAL_PATCHES_HOST_MAX_BYTES - 20));
    f.store.write(tx => insertTrial(tx, newTrial("trial-6", 0, 5), NOW));
    f.store.write(tx => startTrial(tx, "trial-6", NOW));
    f.store.write(tx => gradingTrial(tx, "trial-6", NOW));
    f.store.write(tx => finishTrial(tx, "trial-6", finalOf(GRADED, Buffer.alloc(20)), NOW));
    assert.equal(readTrialPatch(f, "trial-6"), "stored", "a patch that fills the host cap exactly fits");
    assert.equal(totalBytes(), TRIAL_PATCHES_HOST_MAX_BYTES);

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
      [REUSE_SQL, [TASK, "ref", NOW, TRIAL_HARNESS_VERSION, "version", 1, 10], "eval_trials_reuse"],
      [JOB_ROWS_SQL, [JOB], "eval_trials_job"],
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


const AGO = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
const PROMPT = trialPromptVersion(PROFILE);

type Seed = { endedAt?: string; ending?: TrialGrade["ending"]; epoch?: number; harness?: number; prompt?: string; kind?: string };

function seedFinal(f: Fixture, trialId: string, seed: Seed = {}): void {
  const jobId = `job-of-${trialId}`;
  const endedAt = seed.endedAt ?? AGO(1);
  f.store.write(tx => {
    tx.run("INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
      + "VALUES (?, 'ref', ?, 'completed', ?, ?, ?, ?, '{}')", jobId, seed.kind ?? "baseline", jobId, endedAt, LATER, endedAt);
    openTrialCounts(tx, jobId, { tasks: 1, trials: 1 });
    insertTrial(tx, { ...newTrial(trialId), jobId, harness: seed.harness ?? TRIAL_HARNESS_VERSION }, endedAt);
    startTrial(tx, trialId, endedAt);
    const grade = seed.ending === undefined ? GRADED : { ...GRADED, ending: seed.ending, resolved: false };
    finishTrial(tx, trialId, { ...finalOf(grade), configId: "config-id", profileEpoch: seed.epoch ?? 3 }, endedAt);
    tx.run("UPDATE eval_trials SET prompt_version=? WHERE trial_id=?", seed.prompt ?? PROMPT, trialId);
  });
}

const REUSE_INPUT = { taskId: TASK, configRef: configRef(CONFIGURATION), promptVersion: PROMPT, profileEpoch: 3,
  harness: TRIAL_HARNESS_VERSION, since: AGO(30), limit: 10 };

test("a trial row keeps its prompt version", () => {
  const f = ready();
  try {
    f.store.write(tx => {
      openTrialCounts(tx, JOB, { tasks: 1, trials: 1 });
      insertTrial(tx, newTrial("trial-1"), NOW);
      const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(PROFILE).reverse()))) as TeamModelProfile;
      insertTrial(tx, { ...newTrial("trial-2", 1), configuration: { ...CONFIGURATION, profile: reordered } }, NOW);
    });
    const versions = f.store.read(db => db.all<{ trial_id: string; prompt_version: string }>(
      "SELECT trial_id, prompt_version FROM eval_trials ORDER BY trial_id"));
    const expected = promptVersion("implementer", "claude", JSON.parse(canonicalJson(PROFILE)) as TeamModelProfile, false, false, false);
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.prompt_version, trialPromptVersion(PROFILE));
    assert.equal(versions[0]?.prompt_version, expected);
    assert.equal(versions[1]?.prompt_version, expected, "the same profile in another key order gives the same value");
  } finally {
    f.close();
  }
});

test("reuse finds only matching originals", () => {
  const f = ready();
  try {
    seedFinal(f, "match", { endedAt: AGO(29) });
    seedFinal(f, "old", { endedAt: AGO(31) });
    seedFinal(f, "void", { ending: "void-host" });
    seedFinal(f, "prompt", { prompt: "other" });
    seedFinal(f, "epoch", { epoch: 4 });
    seedFinal(f, "harness", { harness: TRIAL_HARNESS_VERSION + 1 });
    seedFinal(f, "confirm", { kind: "confirm" });
    const match = f.store.read(db => reusable(db, REUSE_INPUT));
    assert.equal(match.length, 1);
    assert.equal(match[0]?.trialId, "match");
    const source = match[0] as ReuseSource;
    f.store.write(tx => {
      openTrialCounts(tx, JOB, { tasks: 1, trials: 1 });
      insertCopy(tx, { trialId: "copy", jobId: JOB, taskId: TASK, projectId: PROJECT, configuration: CONFIGURATION, slot: 0,
        promptVersion: PROMPT, source, keepDays: 365 }, NOW);
    });
    assert.equal(f.store.read(db => reusable(db, REUSE_INPUT)).length, 1, "a copy row is never a source");
    seedFinal(f, "newer", { endedAt: AGO(2) });
    const two = f.store.read(db => reusable(db, REUSE_INPUT));
    assert.deepEqual(two.map(row => row.trialId), ["newer", "match"], "newest first");
    assert.equal(f.store.read(db => reusable(db, { ...REUSE_INPUT, limit: 1 })).length, 1, "the limit holds");
  } finally {
    f.close();
  }
});

test("a copy is final and counts only as reused", () => {
  const f = ready();
  try {
    seedFinal(f, "source");
    const source = f.store.read(db => reusable(db, REUSE_INPUT))[0] as ReuseSource;
    assert.ok(source);
    f.store.write(tx => {
      openTrialCounts(tx, JOB, { tasks: 1, trials: 2 });
      insertCopy(tx, { trialId: "copy", jobId: JOB, taskId: TASK, projectId: PROJECT, configuration: CONFIGURATION, slot: 0,
        promptVersion: PROMPT, source, keepDays: 365 }, NOW);
    });
    const row = f.store.read(db => db.get<Record<string, unknown>>("SELECT * FROM eval_trials WHERE trial_id='copy'"));
    assert.equal(row?.state, "final");
    assert.equal(row?.reused_from, "source");
    assert.equal(row?.session_id, null);
    assert.equal(row?.attempt, 0);
    assert.equal(row?.prompt_version, PROMPT);
    assert.equal(row?.ended_at, source.endedAt);
    assert.equal(row?.expires_at, new Date(Date.parse(NOW) + 365 * DAY_MS).toISOString());
    const counts = countsOf(f);
    assert.equal(counts.reused, 1);
    assert.equal(counts.started, 0);
    assert.equal(counts.graded, 0);
    assert.equal(f.store.read(db => db.get<{ n: number }>(PROJECT_DAY_SQL, db.index("project", PROJECT), AGO(0))?.n), 0);
    assert.equal(f.store.read(db => db.get<{ n: number }>(JOB_TRIALS_SQL, JOB)?.n), 0);
    const opened = f.store.read(db => readTrial(db, "copy"));
    assert.equal(opened?.payload.configuration.profile.model, MODEL, "the copy's configuration opens under its own id");
    assert.equal(f.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_trial_patches"))?.n, 0);
    const rows = f.store.read(db => jobRows(db, JOB));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.reused, true);
    assert.equal(rows[0]?.profileEpoch, 3);
  } finally {
    f.close();
  }
});

test("a session's cost is recorded when it is cleared", () => {
  const f = ready();
  try {
    f.store.write(tx => {
      openTrialCounts(tx, JOB, { tasks: 1, trials: 4 });
      for (const [index, id] of ["t-complete", "t-partial", "t-none", "t-plain"].entries()) {
        insertTrial(tx, newTrial(id, index), NOW);
        startTrial(tx, id, NOW);
        finishTrial(tx, id, { ...finalOf(GRADED), sessionId: `session-${id}` }, NOW);
      }
      clearTrialSession(tx, "t-complete", { tokens: 120, usd: 0.5, complete: true });
      clearTrialSession(tx, "t-partial", { tokens: 80, usd: 0.25, complete: false });
      clearTrialSession(tx, "t-none", "none");
      clearTrialSession(tx, "t-plain");
    });
    const cost = (id: string) => f.store.read(db => db.get<{ session_id: string | null; tokens: number | null; spent_usd: number | null;
      cost: string | null }>("SELECT session_id, tokens, spent_usd, cost FROM eval_trials WHERE trial_id=?", id));
    assert.deepEqual({ ...cost("t-complete") }, { session_id: null, tokens: 120, spent_usd: 0.5, cost: "complete" });
    assert.deepEqual({ ...cost("t-partial") }, { session_id: null, tokens: 80, spent_usd: 0.25, cost: "partial" });
    assert.deepEqual({ ...cost("t-none") }, { session_id: null, tokens: null, spent_usd: null, cost: "none" });
    assert.deepEqual({ ...cost("t-plain") }, { session_id: null, tokens: null, spent_usd: null, cost: null });
  } finally {
    f.close();
  }
});

test("the v2 migration keeps v1 rows", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-trials-v1-"));
  const options = { databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) };
  const v1: EvidenceModule = {
    name: EVAL_TRIALS_MODULE, version: 1, readVersion: 1,
    migrate(tx) {
      for (const statement of SCHEMA_TRIALS_V1) tx.exec(statement);
      tx.run("INSERT OR IGNORE INTO eval_trial_totals (id, patch_bytes) VALUES (1, 0)");
    },
  };
  try {
    const first = new EvidenceStore(options);
    first.register(evalCorpusModule(first, () => NOW));
    first.register(v1);
    assert.equal(first.status().modules[EVAL_TRIALS_MODULE], "ready");
    first.write(tx => {
      tx.run("INSERT INTO eval_trial_counts (job_id, planned_tasks, planned_trials, started, graded, resolved) VALUES (?, 1, 2, 1, 1, 1)", JOB);
      const payload = (id: string) => tx.seal("eval_trials", id, { projectId: PROJECT, taskId: TASK, configuration: CONFIGURATION,
        ...(id === "old-1" ? { patch: "stored" } : {}) });
      tx.run("INSERT INTO eval_trials (trial_id, job_id, task_id, project_ref, config_ref, config_id, profile_epoch, harness, slot, attempt, "
        + "state, ending, resolved, isolation, session_id, created_at, started_at, ended_at, expires_at, payload) "
        + "VALUES ('old-1', ?, ?, 'ref', ?, 'cid', 2, 1, 0, 0, 'final', 'graded', 1, 'isolated', 'old-session', ?, ?, ?, ?, ?)",
      JOB, TASK, configRef(CONFIGURATION), NOW, NOW, NOW, LATER, payload("old-1"));
      tx.run("INSERT INTO eval_trials (trial_id, job_id, task_id, project_ref, config_ref, harness, slot, attempt, state, created_at, expires_at, payload) "
        + "VALUES ('old-2', ?, ?, 'ref', ?, 1, 1, 0, 'preparing', ?, ?, ?)", JOB, TASK, configRef(CONFIGURATION), NOW, LATER, payload("old-2"));
      tx.run("INSERT INTO eval_trial_patches (trial_id, bytes, stored_at, expires_at, payload) VALUES ('old-1', 5, ?, ?, ?)",
        NOW, LATER, tx.seal("eval_trial_patches", "old-1", { patch: Buffer.from("patch").toString("base64") }));
      tx.run("UPDATE eval_trial_totals SET patch_bytes = 5 WHERE id=1");
    });
    first.close();

    const second = new EvidenceStore(options);
    second.register(evalCorpusModule(second, () => NOW));
    second.register(evalTrialsModule(second, () => NOW));
    assert.equal(second.status().modules[EVAL_TRIALS_MODULE], "ready");
    const rows = second.read(db => db.all<Record<string, unknown>>(
      "SELECT trial_id, state, ending, resolved, config_id, profile_epoch, session_id, slot, prompt_version, reused_from, tokens, spent_usd, cost "
      + "FROM eval_trials ORDER BY trial_id"));
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[0] }, { trial_id: "old-1", state: "final", ending: "graded", resolved: 1, config_id: "cid", profile_epoch: 2,
      session_id: "old-session", slot: 0, prompt_version: null, reused_from: null, tokens: null, spent_usd: null, cost: null });
    assert.equal(rows[1]?.state, "preparing");
    assert.equal(rows[1]?.prompt_version, null);
    const counts = second.read(db => trialCounts(db, [JOB])).get(JOB);
    assert.equal(counts?.reused, 0);
    assert.equal(counts?.graded, 1);
    assert.equal(counts?.resolved, 1);
    const old = second.read(db => readTrial(db, "old-1"));
    assert.equal(old?.payload.patch, "stored", "the sealed payload still opens");
    assert.equal(second.read(db => db.get<{ patch_bytes: number }>("SELECT patch_bytes FROM eval_trial_totals"))?.patch_bytes, 5);
    for (const table of ["eval_reports", "eval_subjects", "eval_priors"]) {
      assert.equal(second.read(db => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n, 0, `${table} exists and is empty`);
    }
    second.close();

    const older = new EvidenceStore(options);
    older.register(evalCorpusModule(older, () => NOW));
    older.register(v1);
    assert.equal(older.status().modules[EVAL_TRIALS_MODULE], "unavailable", "a module that claims version 1 reads a v2 store as unavailable");
    older.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed v2 migration leaves the module unavailable and the v1 store unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-trials-v1-"));
  const options = { databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) };
  try {
    const first = new EvidenceStore(options);
    first.register({
      name: EVAL_TRIALS_MODULE, version: 1, readVersion: 1,
      migrate(tx) {
        for (const statement of SCHEMA_TRIALS_V1) tx.exec(statement);
      },
    });
    first.write(tx => tx.exec("CREATE TABLE eval_reports (job_id TEXT PRIMARY KEY)"));
    first.write(tx => tx.exec("ALTER TABLE eval_trial_counts ADD COLUMN reused INTEGER NOT NULL DEFAULT 0"));
    first.close();
    const second = new EvidenceStore(options);
    second.register(evalCorpusModule(second, () => NOW));
    second.register(evalTrialsModule(second, () => NOW));
    assert.equal(second.status().modules[EVAL_TRIALS_MODULE], "unavailable");
    const columns = second.read(db => db.all<{ name: string }>("SELECT name FROM pragma_table_info('eval_trials')")).map(row => row.name);
    assert.equal(columns.includes("prompt_version"), false, "the earlier ALTER statements rolled back with the failure");
    assert.equal(second.read(db => db.get<{ version: number }>("SELECT version FROM schema_modules WHERE name=?", EVAL_TRIALS_MODULE))?.version, 1);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired reports and priors are swept", () => {
  const f = ready();
  try {
    f.store.write(tx => {
      for (let index = 0; index < 150; index += 1) {
        tx.run("INSERT INTO eval_priors (prior_id, job_id, project_ref, configuration, profile_id, provider, profile_epoch, prompt_version, "
          + "prompt_origin, tasks, trials, resolved, generated_at, expires_at) VALUES (?, 'j', 'ref', 0, 'p', 'claude', 1, 'v', 'captured', 1, 1, 1, ?, ?)",
          `prior-${index}`, NOW, AGO(1));
      }
      tx.run("INSERT INTO eval_priors (prior_id, job_id, project_ref, configuration, profile_id, provider, profile_epoch, prompt_version, "
        + "prompt_origin, tasks, trials, resolved, generated_at, expires_at) VALUES ('live', 'j', 'ref', 0, 'p', 'claude', 1, 'v', 'captured', 1, 1, 1, ?, ?)",
      NOW, LATER);
      tx.run("INSERT INTO eval_reports (job_id, project_ref, kind, state, generated_at, expires_at, payload) VALUES ('old', 'ref', 'compare', 'ok', ?, ?, 'x')",
        NOW, AGO(1));
      tx.run("INSERT INTO eval_subjects (project_ref, subject, job_id, created_at) VALUES ('ref', 'subject', 'old', ?)", AGO(900));
    });
    const count = (table: string) => f.store.read(db => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n);
    f.store.write(tx => sweepTrials(tx, NOW));
    assert.equal(count("eval_priors"), 51, "100 expired priors go in one pass");
    assert.equal(count("eval_reports"), 0);
    f.store.write(tx => sweepTrials(tx, NOW));
    assert.equal(count("eval_priors"), 1, "the rest go in the next pass, and an unexpired one stays");
    f.store.write(tx => sweepTrials(tx, LATER));
    assert.equal(count("eval_subjects"), 1, "a subject row is never deleted");
  } finally {
    f.close();
  }
});
