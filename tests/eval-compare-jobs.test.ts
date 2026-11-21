import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { configurationModule, advanceEpoch } from "../packages/host/src/configuration-store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import {
  evalTrialsModule,
  finishTrial,
  insertTrial,
  openTrialCounts,
  startTrial,
  type ReuseSource,
} from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION, trialPromptVersion, trialProfileKey } from "../packages/host/src/eval-trial-rules.js";
import { CONFIRM_TASKS_MIN } from "../packages/host/src/eval-sets.js";
import {
  COMPARE_TASKS_MIN,
  applyComparison,
  comparisonJobSchema,
  pinsChanged,
  pinsOf,
  planComparison,
  subjectOf,
  type ComparisonPlan,
} from "../packages/host/src/eval-compare-jobs.js";
import type { ComparisonJobRequest, EvalRefusal, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";

const DAY_MS = 86_400_000;
const NOW = "2026-11-14T12:00:00.000Z";
const AGO = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
const PROJECT = "project-compare-1";
const OTHER_PROJECT = "project-compare-2";

const profile = (id: string, model: string) => ({ id, label: id, provider: "claude", model, effort: "high", tier: "strong" }) as TeamModelProfile;
const PROFILE_A = profile("profile-a", "model-a");
const PROFILE_B = profile("profile-b", "model-b");
const PROFILE_C = profile("profile-c", "model-c");
const configuration = (item: TeamModelProfile): TrialConfiguration => ({ profile: item, guidance: "as-of-base", knowledge: "none" });
const CONFIG_A = configuration(PROFILE_A);
const CONFIG_B = configuration(PROFILE_B);
const CONFIG_C = configuration(PROFILE_C);

const GRADED: TrialGrade = { ending: "graded", expectedPassed: 1, expectedTotal: 1, guardPassed: true, resolved: true,
  overwritten: 0, diff: null, isolation: "isolated" };

type Fixture = { store: EvidenceStore; close: () => void };

function ready(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-compare-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  store.register(evalTrialsModule(store, () => NOW));
  store.register(configurationModule());
  assert.equal(store.status().modules["eval-corpus"], "ready");
  assert.equal(store.status().modules["eval-trials"], "ready");
  assert.equal(store.status().modules["configurations"], "ready");
  return {
    store,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type TaskSeed = { id: string; group: string; holdout: boolean; origin?: "captured" | "mined" };

/** One valid task, and its root group when the group does not exist yet. */
function seedTask(f: Fixture, seed: TaskSeed, project = PROJECT): void {
  const origin = seed.origin ?? "captured";
  f.store.write(tx => {
    const ref = tx.index("project", project);
    tx.run(
      "INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', ?, ?, ?, ?, ?)",
      seed.group, ref, seed.group, NOW, seed.holdout ? 1 : 0, seed.holdout ? NOW : null,
    );
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, "
      + "group_id, prompt_origin, area_ref) VALUES (?, ?, 'run', 'member', ?, 'valid', 'stored', 'proven', ?, ?, '{}', ?, ?, ?)",
      seed.id, origin, ref, NOW, NOW, seed.group, origin === "captured" ? "assignment" : "run-objective", tx.index("area", "core"),
    );
  });
}

const taskId = (n: number, origin: "captured" | "mined" = "captured") => `${origin}:t${String(n).padStart(3, "0")}`;

/** 40 tasks, each in its own group; the groups of i % 5 in {0, 1} are holdout (16). Even tasks are captured, odd tasks mined. */
function seedMixed(f: Fixture): void {
  for (let i = 0; i < 40; i += 1) {
    seedTask(f, { id: taskId(i, i % 2 === 0 ? "captured" : "mined"), group: `g-${String(i).padStart(2, "0")}`, holdout: i % 5 < 2,
      origin: i % 2 === 0 ? "captured" : "mined" });
  }
}

function request(kind: "compare" | "confirm", configurations: TrialConfiguration[], extra: Partial<ComparisonJobRequest> = {}): ComparisonJobRequest {
  return { kind, configurations, limits: { maxTrials: 1000, maxWallMinutes: 600 }, ...extra };
}

function plan(f: Fixture, req: ComparisonJobRequest, at = NOW, project = PROJECT): ComparisonPlan | EvalRefusal {
  return f.store.write(tx => planComparison(tx, { projectId: project, request: req, at }));
}

function planned(f: Fixture, req: ComparisonJobRequest, at = NOW): ComparisonPlan {
  const result = plan(f, req, at);
  assert.equal("code" in result, false, `a plan, got ${JSON.stringify(result)}`);
  return result as ComparisonPlan;
}

function refused(result: ComparisonPlan | EvalRefusal): EvalRefusal {
  assert.equal("code" in result, true, "a refusal");
  return result as EvalRefusal;
}

function apply(f: Fixture, jobId: string, req: ComparisonJobRequest, made: ComparisonPlan): "scheduled" | "complete" {
  return f.store.write(tx => {
    openTrialCounts(tx, jobId, made.planned);
    return applyComparison(tx, { jobId, projectId: PROJECT, request: req, plan: made, keepDays: 365, at: NOW });
  });
}

function count(f: Fixture, sql: string): number {
  return f.store.read(db => db.get<{ n: number }>(sql)?.n ?? -1);
}

function confirmsOf(f: Fixture): Map<string, number> {
  const rows = f.store.read(db => db.all<{ group_id: string; confirms: number }>("SELECT group_id, confirms FROM eval_groups"));
  return new Map(rows.map(row => [row.group_id, row.confirms]));
}

/** One final original trial of its own baseline job. */
function seedTrial(f: Fixture, trialId: string, task: string, item: TrialConfiguration, epoch = 1, endedAt = AGO(1)): void {
  const jobId = `job-of-${trialId}`;
  f.store.write(tx => {
    tx.run("INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
      + "VALUES (?, 'ref', 'baseline', 'completed', ?, ?, ?, ?, '{}')", jobId, jobId, endedAt, NOW, endedAt);
    openTrialCounts(tx, jobId, { tasks: 1, trials: 1 });
    insertTrial(tx, { trialId, jobId, taskId: task, configRef: configRef(item), harness: TRIAL_HARNESS_VERSION, slot: 0, attempt: 0,
      projectId: PROJECT, configuration: item, keepDays: 365 }, endedAt);
    startTrial(tx, trialId, endedAt);
    finishTrial(tx, trialId, { grade: GRADED, configId: "config-id", profileEpoch: epoch, sessionId: null, patchKeepDays: 90 }, endedAt);
  });
}

test("a compare job selects dev tasks and a confirm job holdout tasks", () => {
  const f = ready();
  try {
    seedMixed(f);
    const all = { maxTasks: 200 };
    const compare = planned(f, request("compare", [CONFIG_A, CONFIG_B], { taskFilter: all }));
    assert.equal(compare.tasks.length, 24);
    assert.deepEqual([...compare.tasks], [...compare.tasks].sort());
    for (const id of compare.tasks) {
      const n = Number(id.slice(-3));
      assert.ok(n % 5 >= 2, `${id} is a dev task`);
    }
    const confirm = planned(f, request("confirm", [CONFIG_A, CONFIG_B], { taskFilter: all }));
    assert.equal(confirm.tasks.length, 16);
    assert.deepEqual([...confirm.tasks], [...confirm.tasks].sort());
    for (const id of confirm.tasks) {
      const n = Number(id.slice(-3));
      assert.ok(n % 5 < 2, `${id} is a holdout task`);
    }
    const holdoutId = confirm.tasks[0] as string;
    const hand = planned(f, request("compare", [CONFIG_A, CONFIG_B], { taskFilter: { ...all, taskIds: [holdoutId, compare.tasks[0] as string, compare.tasks[1] as string] } }));
    assert.deepEqual(hand.tasks, [compare.tasks[0], compare.tasks[1]].sort(), "a compare job never reads a holdout task, even named");
    const excluded = planned(f, request("compare", [CONFIG_A, CONFIG_B], { taskFilter: { ...all, excludeGroups: ["g-02"] } }));
    assert.equal(excluded.tasks.length, 23);
    assert.equal(excluded.tasks.includes(taskId(2)), false);
    const origins = planned(f, request("compare", [CONFIG_A, CONFIG_B], { taskFilter: { ...all, promptOrigins: ["assignment"] } }));
    assert.ok(origins.tasks.length > 0);
    assert.ok(origins.tasks.every(id => id.startsWith("captured:")));
    const capped = planned(f, request("compare", [CONFIG_A, CONFIG_B]));
    assert.equal(capped.tasks.length, 20, "the default is 20 tasks");
    const bad = { ...request("confirm", [CONFIG_A, CONFIG_B]), taskFilter: { taskIds: [holdoutId] } };
    assert.equal(comparisonJobSchema.safeParse(bad).success, false, "a confirm request admits no taskIds");
    const shaped = { ...request("confirm", [CONFIG_A, CONFIG_B]), taskFilter: { excludeGroups: ["g-02"] } };
    assert.equal(comparisonJobSchema.safeParse(shaped).success, false, "a confirm request admits no excludeGroups");
    assert.equal(comparisonJobSchema.safeParse(request("confirm", [CONFIG_A, CONFIG_B])).success, true);
    assert.equal(comparisonJobSchema.safeParse(request("compare", [CONFIG_A])).success, false);
    assert.equal(comparisonJobSchema.safeParse(request("compare", [CONFIG_A, CONFIG_B, CONFIG_C, CONFIG_A, CONFIG_B])).success, false);
    assert.equal(comparisonJobSchema.safeParse(request("confirm", [CONFIG_A, CONFIG_B, CONFIG_C])).success, false);
    assert.equal(comparisonJobSchema.safeParse(request("compare", [CONFIG_A, CONFIG_A])).success, false, "two configurations name one configRef");
    assert.equal(comparisonJobSchema.safeParse({ ...request("compare", [CONFIG_A, CONFIG_B]), set: "holdout" }).success, false, "the request has no set field");
  } finally {
    f.close();
  }
});

test("a confirm job needs fifteen holdout tasks", () => {
  const f = ready();
  try {
    assert.equal(COMPARE_TASKS_MIN, 2);
    assert.equal(CONFIRM_TASKS_MIN, 15);
    for (let i = 0; i < 14; i += 1) seedTask(f, { id: taskId(i), group: `h-${i}`, holdout: true });
    const few = refused(plan(f, request("confirm", [CONFIG_A, CONFIG_B])));
    assert.equal(few.code, "too-few-tasks");
    assert.equal(few.status, 409);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_subjects"), 0, "a refusal leaves no row");
    seedTask(f, { id: taskId(14), group: "h-14", holdout: true });
    const enough = planned(f, request("confirm", [CONFIG_A, CONFIG_B]));
    assert.equal(enough.tasks.length, 15);
    const devOne = refused(plan(f, request("compare", [CONFIG_A, CONFIG_B])));
    assert.equal(devOne.code, "too-few-tasks", "no dev task at all");
    seedTask(f, { id: taskId(50), group: "d-50", holdout: false });
    assert.equal(refused(plan(f, request("compare", [CONFIG_A, CONFIG_B]))).code, "too-few-tasks", "one dev task");
    seedTask(f, { id: taskId(51), group: "d-51", holdout: false });
    assert.equal(planned(f, request("compare", [CONFIG_A, CONFIG_B])).tasks.length, 2);
  } finally {
    f.close();
  }
});

test("a confirm request over a holdout it may not name is refused by the schema before any read", () => {
  const f = ready();
  try {
    seedMixed(f);
    const parsed = comparisonJobSchema.safeParse({ ...request("confirm", [CONFIG_A, CONFIG_B]), taskFilter: { taskIds: [taskId(0)], maxTasks: 5 } });
    assert.equal(parsed.success, false);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_subjects"), 0);
  } finally {
    f.close();
  }
});

test("a second confirm for one subject is refused", () => {
  const f = ready();
  try {
    seedMixed(f);
    const first = planned(f, request("confirm", [CONFIG_A, CONFIG_B]));
    assert.ok(first.subject);
    assert.equal(apply(f, "job-1", request("confirm", [CONFIG_A, CONFIG_B]), first), "scheduled");
    const reversed = refused(plan(f, request("confirm", [CONFIG_B, CONFIG_A])));
    assert.equal(reversed.code, "subject-confirmed");
    assert.equal(reversed.status, 409);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_subjects"), 1, "the refusal leaves no row");
    const confirms = [...confirmsOf(f).values()].reduce((sum, n) => sum + n, 0);
    assert.equal(confirms, first.roots.length, "the refusal counts nothing");
    f.store.write(tx => tx.run("UPDATE eval_jobs SET status = 'cancelled'"));
    assert.equal(refused(plan(f, request("confirm", [CONFIG_A, CONFIG_B]))).code, "subject-confirmed", "a cancelled job still uses its subject");
    advanceEpoch(f.store, { profile: trialProfileKey(PROFILE_A), requestId: "11111111-1111-4111-8111-111111111111", now: NOW });
    const moved = planned(f, request("confirm", [CONFIG_A, CONFIG_B]));
    assert.ok(moved.subject);
    assert.notEqual(moved.subject, first.subject, "a new epoch is a new subject");
    const before = refused(plan(f, request("confirm", [CONFIG_A, CONFIG_B]), AGO(1)));
    assert.equal(before.code, "subject-confirmed", "at a time before the new epoch the old subject applies, and it is spent");
  } finally {
    f.close();
  }
});

test("a confirm job counts once on each holdout group", () => {
  const f = ready();
  try {
    for (let i = 0; i < 16; i += 1) seedTask(f, { id: taskId(i), group: `h-${i % 10}`, holdout: true });
    const first = planned(f, request("confirm", [CONFIG_A, CONFIG_B]));
    assert.equal(first.tasks.length, 16);
    assert.equal(first.roots.length, 10);
    assert.equal(apply(f, "job-1", request("confirm", [CONFIG_A, CONFIG_B]), first), "scheduled");
    let confirms = confirmsOf(f);
    assert.equal(confirms.size, 10);
    for (const n of confirms.values()) assert.equal(n, 1);
    const second = planned(f, request("confirm", [CONFIG_A, CONFIG_C]));
    assert.equal(apply(f, "job-2", request("confirm", [CONFIG_A, CONFIG_C]), second), "scheduled");
    confirms = confirmsOf(f);
    for (const n of confirms.values()) assert.equal(n, 2);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_subjects"), 2);
  } finally {
    f.close();
  }
});

test("the job, its copies, the subject, and the counts commit together or not at all", () => {
  const f = ready();
  try {
    seedMixed(f);
    const req = request("confirm", [CONFIG_A, CONFIG_B]);
    const first = planned(f, req);
    const stale = planned(f, req);
    assert.equal(apply(f, "job-1", req, first), "scheduled");
    const before = confirmsOf(f);
    assert.throws(() => apply(f, "job-2", req, stale), "a second insert of the same subject fails");
    const after = confirmsOf(f);
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), "no confirm count survived the failed write");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_subjects"), 1);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_trial_counts WHERE job_id = 'job-2'"), 0, "no counts row survived");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_trials WHERE job_id = 'job-2'"), 0);
  } finally {
    f.close();
  }
});

test("reuse fills slots with matching recent trials", () => {
  const f = ready();
  try {
    for (let i = 0; i < 3; i += 1) seedTask(f, { id: taskId(i), group: `d-${i}`, holdout: false });
    for (let i = 10; i < 25; i += 1) seedTask(f, { id: taskId(i), group: `h-${i}`, holdout: true });
    const task = taskId(0);
    seedTrial(f, "a1", task, CONFIG_A, 1, AGO(1));
    seedTrial(f, "a2", task, CONFIG_A, 1, AGO(2));
    seedTrial(f, "a3", task, CONFIG_A, 1, AGO(3));
    seedTrial(f, "a4", task, CONFIG_A, 1, AGO(4));
    seedTrial(f, "b1", task, CONFIG_B, 1, AGO(1));
    seedTrial(f, "b-old-epoch", task, CONFIG_B, 2, AGO(1));
    seedTrial(f, "b-stale", task, CONFIG_B, 1, AGO(40));
    seedTrial(f, "h1", taskId(10), CONFIG_A, 1, AGO(1));
    const req = request("compare", [CONFIG_A, CONFIG_B], { trialsPerTask: 3 });
    const made = planned(f, req);
    assert.equal(made.tasks.length, 3);
    assert.equal(made.slots, 18);
    assert.equal(made.copies.length, 4);
    const mine = made.copies.filter(copy => copy.taskId === task);
    assert.equal(mine.length, 4);
    assert.deepEqual(mine.filter(copy => copy.configuration === 0).map(copy => copy.slot).sort(), [0, 1, 2]);
    assert.deepEqual(mine.filter(copy => copy.configuration === 1).map(copy => copy.slot), [0]);
    const sources = mine.filter(copy => copy.configuration === 0).map(copy => (copy.source as ReuseSource).trialId);
    assert.deepEqual(sources, ["a1", "a2", "a3"], "newest first");
    assert.equal(made.planned.trials, 14);
    assert.equal(made.planned.tasks, 3);
    assert.equal(apply(f, "job-1", req, made), "scheduled");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_trials WHERE job_id = 'job-1' AND reused_from IS NOT NULL"), 4);
    assert.equal(count(f, "SELECT reused AS n FROM eval_trial_counts WHERE job_id = 'job-1'"), 4);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_subjects"), 0, "a compare job has no subject");
    const confirm = planned(f, request("confirm", [CONFIG_A, CONFIG_B], { trialsPerTask: 3 }));
    assert.equal(confirm.copies.length, 0, "a confirm job never reuses");
    const capped = planned(f, request("compare", [CONFIG_A, CONFIG_B], { trialsPerTask: 3, limits: { maxTrials: 5, maxWallMinutes: 600 } }));
    assert.equal(capped.planned.trials, 5, "the planned count stops at maxTrials");
  } finally {
    f.close();
  }
});

test("a compare job whose every slot is reused is complete", () => {
  const f = ready();
  try {
    seedTask(f, { id: taskId(0), group: "d-0", holdout: false });
    seedTask(f, { id: taskId(1), group: "d-1", holdout: false });
    for (const task of [taskId(0), taskId(1)]) {
      seedTrial(f, `a-${task}`, task, CONFIG_A);
      seedTrial(f, `b-${task}`, task, CONFIG_B);
    }
    const req = request("compare", [CONFIG_A, CONFIG_B], { trialsPerTask: 1 });
    const made = planned(f, req);
    assert.equal(made.slots, 4);
    assert.equal(made.copies.length, 4);
    assert.equal(made.planned.trials, 0);
    assert.equal(apply(f, "job-1", req, made), "complete");
  } finally {
    f.close();
  }
});

test("the pins follow the epoch and the prompt version", () => {
  const f = ready();
  try {
    const configurations = [CONFIG_A, CONFIG_B];
    const pins = f.store.read(db => pinsOf(db, configurations, NOW));
    assert.equal(pins.length, 2);
    assert.equal(pins[0]?.configRef, configRef(CONFIG_A));
    assert.equal(pins[0]?.profileEpoch, 1);
    assert.equal(pins[0]?.promptVersion, trialPromptVersion(PROFILE_A));
    assert.equal(pins[1]?.configRef, configRef(CONFIG_B));
    assert.equal(f.store.read(db => pinsChanged(db, configurations, pins, NOW)), false);
    const zeros = pins.map((pin, index) => index === 0 ? { ...pin, promptVersion: "0".repeat(64) } : pin);
    assert.equal(f.store.read(db => pinsChanged(db, configurations, zeros, NOW)), true);
    const since = new Date(Date.parse(NOW) + 1000).toISOString();
    advanceEpoch(f.store, { profile: trialProfileKey(PROFILE_A), requestId: "22222222-2222-4222-8222-222222222222", now: since });
    const later = new Date(Date.parse(NOW) + 2000).toISOString();
    assert.equal(f.store.read(db => pinsChanged(db, configurations, pins, NOW)), false, "before the epoch started");
    assert.equal(f.store.read(db => pinsChanged(db, configurations, pins, later)), true);
    const moved = f.store.read(db => pinsOf(db, configurations, later));
    assert.equal(moved[0]?.profileEpoch, 2);
    assert.equal(moved[1]?.profileEpoch, 1);
    assert.notEqual(subjectOf(pins), subjectOf(moved));
    assert.equal(subjectOf(pins), subjectOf([...pins].reverse()), "the subject does not depend on the order");
    assert.match(subjectOf(pins), /^[0-9a-f]{64}$/);
  } finally {
    f.close();
  }
});
