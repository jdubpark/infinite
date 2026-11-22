import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import {
  clearTrialSession,
  evalTrialsModule,
  finishTrial,
  insertCopy,
  insertTrial,
  openTrialCounts,
  startTrial,
} from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION, trialPromptVersion } from "../packages/host/src/eval-trial-rules.js";
import {
  ComparisonPass,
  REPORT_DUE_SQL,
  SESSIONS_HELD_SQL,
  reportFor,
} from "../packages/host/src/eval-comparison.js";
import type {
  ComparisonPin,
  ComparisonReport,
  EvalRefusal,
  TrialConfiguration,
  TrialGrade,
  TrialJobPayload,
} from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const NOW = "2026-11-14T12:00:00.000Z";
const HOUR_MS = 3_600_000;
const PROJECT = "project-report-1";

const profile = (id: string, model: string) => ({ id, label: id, provider: "claude", model, effort: "high", tier: "strong" }) as TeamModelProfile;
const PROFILE_A = profile("profile-a", "model-a");
const PROFILE_B = profile("profile-b", "model-b");
const configuration = (item: TeamModelProfile): TrialConfiguration => ({ profile: item, guidance: "as-of-base", knowledge: "none" });
const CONFIG_A = configuration(PROFILE_A);
const CONFIG_B = configuration(PROFILE_B);

const CONFIG = { projects: [{ id: PROJECT, team: { features: { areas: [{ id: "core" }] } } }] } as unknown as Pick<Config, "projects">;

const P0 = [1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 1, 0];
const P1 = [2, 1, 2, 3, 3, 2, 1, 0, 3, 3, 2, 1];

type Fixture = { store: EvidenceStore; close: () => void };

function ready(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-report-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, () => NOW));
  store.register(evalTrialsModule(store, () => NOW));
  store.register(configurationModule());
  assert.equal(store.status().modules["eval-corpus"], "ready");
  assert.equal(store.status().modules["eval-trials"], "ready");
  return {
    store,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const taskId = (n: number) => `captured:t${String(n).padStart(3, "0")}`;
const groupId = (n: number) => `group-alpha-${String(n).padStart(2, "0")}`;

function seedTasks(f: Fixture, count: number, holdout: boolean): string[] {
  const ids: string[] = [];
  f.store.write(tx => {
    const ref = tx.index("project", PROJECT);
    for (let i = 0; i < count; i += 1) {
      tx.run(
        "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', ?, ?, ?, ?, ?)",
        groupId(i), ref, groupId(i), NOW, holdout ? 1 : 0, holdout ? NOW : null,
      );
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, "
        + "group_id, prompt_origin, area_ref, kind) VALUES (?, 'captured', 'run', 'member', ?, 'valid', 'stored', 'proven', ?, ?, '{}', ?, "
        + "'assignment', ?, 'bugfix')",
        taskId(i), ref, NOW, NOW, groupId(i), tx.index("area", "core"),
      );
      ids.push(taskId(i));
    }
  });
  return ids;
}

const pinsFor = (configs: TrialConfiguration[]): ComparisonPin[] =>
  configs.map(item => ({ configRef: configRef(item), profileEpoch: 1, promptVersion: trialPromptVersion(item.profile) }));

type JobSeed = { jobId: string; kind: "baseline" | "compare" | "confirm"; tasks: string[]; configs?: TrialConfiguration[];
  finishedAt?: string | null; status?: string; rawPayload?: string; sealedPayload?: unknown };

function seedJob(f: Fixture, seed: JobSeed): void {
  const configs = seed.configs ?? [CONFIG_A, CONFIG_B];
  const comparison = seed.kind !== "baseline";
  const finishedAt = seed.finishedAt === undefined ? NOW : seed.finishedAt;
  f.store.write(tx => {
    const payload: TrialJobPayload = {
      projectId: PROJECT,
      request: comparison
        ? { kind: seed.kind as "compare" | "confirm", configurations: configs, trialsPerTask: 3, limits: { maxTrials: 1000, maxWallMinutes: 600 } }
        : { kind: "baseline", configurations: configs, trialsPerTask: 3, limits: { maxTrials: 1000, maxWallMinutes: 600 } },
      requestDigest: "digest",
      jobDigest: "digest",
      ...(comparison ? { tasks: seed.tasks, pins: pinsFor(configs) } : {}),
    };
    tx.run(
      "INSERT INTO eval_jobs (job_id, project_ref, kind, status, reason, request_id, created_at, expires_at, finished_at, updated_at, payload) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      seed.jobId, tx.index("project", PROJECT), seed.kind, seed.status ?? "completed", finishedAt === null ? null : "done", seed.jobId,
      NOW, NOW, finishedAt, NOW, seed.rawPayload ?? tx.seal("eval_jobs", seed.jobId, seed.sealedPayload ?? payload),
    );
    openTrialCounts(tx, seed.jobId, { tasks: seed.tasks.length, trials: 0 });
  });
}

/** Slot s of configuration c is resolved when s < rows[c][i]. */
function seedTrials(f: Fixture, jobId: string, tasks: string[], rows: number[][], options: { configs?: TrialConfiguration[]; session?: string } = {}): string[] {
  const configs = options.configs ?? [CONFIG_A, CONFIG_B];
  const trialIds: string[] = [];
  f.store.write(tx => {
    tasks.forEach((task, i) => {
      configs.forEach((item, c) => {
        for (let slot = 0; slot < 3; slot += 1) {
          const trialId = `trial-${jobId}-${i}-${c}-${slot}`;
          trialIds.push(trialId);
          const grade: TrialGrade = { ending: "graded", expectedPassed: 1, expectedTotal: 1, guardPassed: true,
            resolved: slot < (rows[c]?.[i] ?? 0), overwritten: 0, diff: null, isolation: "isolated" };
          insertTrial(tx, { trialId, jobId, taskId: task, configRef: configRef(item), harness: TRIAL_HARNESS_VERSION, slot, attempt: 0,
            projectId: PROJECT, configuration: item, keepDays: 365 }, NOW);
          startTrial(tx, trialId, NOW);
          finishTrial(tx, trialId, { grade, configId: "config-id", profileEpoch: 1, sessionId: options.session ?? null, patchKeepDays: 90 }, NOW);
        }
      });
    });
  });
  return trialIds;
}

const pass = (f: Fixture, now = NOW) => new ComparisonPass({ store: f.store, config: CONFIG, now: () => now });

function opened(result: ComparisonReport | EvalRefusal): ComparisonReport {
  assert.equal("code" in result, false, `a report, got ${JSON.stringify(result)}`);
  return result as ComparisonReport;
}

function refusal(result: ComparisonReport | EvalRefusal): EvalRefusal {
  assert.equal("code" in result, true, "a refusal");
  return result as EvalRefusal;
}

const read = (f: Fixture, jobId: string) => f.store.read(db => reportFor(db, jobId));
const count = (f: Fixture, sql: string): number => f.store.read(db => db.get<{ n: number }>(sql)?.n ?? -1);

function fixtureP(f: Fixture, jobId: string, kind: "compare" | "confirm", holdout = false): string[] {
  const tasks = seedTasks(f, 12, holdout);
  seedJob(f, { jobId, kind, tasks });
  seedTrials(f, jobId, tasks, [P0, P1]);
  return tasks;
}

test("the report pass writes nothing while a module is not ready", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-report-newer-"));
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const vaultKey = randomBytes(32);
  // A stored trials version one above the code's makes that module unavailable, as in the trial pump's test.
  const first = new EvidenceStore({ databasePath, vaultKey });
  first.register(evalCorpusModule(first, () => NOW));
  const trials = evalTrialsModule(first, () => NOW);
  first.register({ ...trials, version: trials.version + 1, readVersion: trials.version + 1 });
  const seeded: Fixture = { store: first, close: () => first.close() };
  const tasks = seedTasks(seeded, 2, false);
  seedJob(seeded, { jobId: "job-newer", kind: "compare", tasks });
  first.close();
  const store = new EvidenceStore({ databasePath, vaultKey });
  const f: Fixture = { store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
  try {
    store.register(evalCorpusModule(store, () => NOW));
    store.register(evalTrialsModule(store, () => NOW));
    assert.equal(store.status().modules["eval-trials"], "unavailable");
    assert.equal(pass(f).step(), "idle");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_jobs WHERE reported_at IS NULL"), 1, "the job keeps no stamp");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_reports"), 0);
  } finally {
    f.close();
  }
});

test("a report uses its own job id as the seed", () => {
  const f = ready();
  try {
    // Per-task differences of the resolved counts, configuration 1 minus configuration 0; the interval's sum is -20 or -21 by seed.
    const D = [0, -2, -1, -3, -3, -2, 0, -2, -1, 2, 0, 3];
    const a = D.map(d => Math.max(0, -d));
    const b = D.map((d, i) => (a[i] as number) + d);
    const tasks = seedTasks(f, 12, false);
    for (const jobId of ["job-fixture", "job-other"]) {
      seedJob(f, { jobId, kind: "compare", tasks });
      seedTrials(f, jobId, tasks, [a, b]);
    }
    assert.equal(pass(f).step(), "reported");
    assert.equal(pass(f).step(), "reported");
    const interval = (jobId: string) => opened(read(f, jobId)).pairs[0]?.interval ?? null;
    const fixture = interval("job-fixture");
    const other = interval("job-other");
    assert.ok(fixture !== null && other !== null);
    assert.equal(fixture[0], -20 / 36);
    assert.equal(fixture[1], 3 / 36);
    assert.equal(other[0], -21 / 36);
    assert.equal(other[1], 3 / 36);
  } finally {
    f.close();
  }
});

test("a report is written once", () => {
  const f = ready();
  try {
    fixtureP(f, "job-p", "compare");
    assert.equal(pass(f).step(), "reported");
    const report = opened(read(f, "job-p"));
    assert.equal(report.pairs.length, 1);
    const pair = report.pairs[0] as ComparisonReport["pairs"][number];
    assert.equal(pair.a, 0);
    assert.equal(pair.b, 1);
    assert.equal(pair.n, 12);
    assert.equal(pair.mean, 7 / 36);
    assert.equal(pair.interval?.[0], 2 / 36);
    assert.equal(pair.interval?.[1], 12 / 36);
    assert.equal(pair.sign.wins, 7);
    assert.equal(pair.sign.losses, 1);
    assert.equal(pair.sign.ties, 4);
    assert.equal(pair.sign.p, 0.0703125);
    assert.equal(pair.holm, 0.0703125);
    assert.equal(report.tasks.analysed, 12);
    assert.equal(report.tasks.planned, 12);
    assert.equal(report.conclusive, true);
    assert.equal(report.kind, "compare");
    assert.equal(report.set, "dev");
    assert.equal(report.configurations.length, 2);
    assert.equal(report.byArea.length, 1);
    assert.equal(report.byArea[0]?.area, "core");
    assert.equal(pass(f).step(), "idle");
    assert.equal(pass(f).step(), "idle");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_reports"), 1);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_jobs WHERE reported_at IS NOT NULL"), 1);
  } finally {
    f.close();
  }
});

test("a report waits for the trial sessions, at most a day", () => {
  const f = ready();
  try {
    const tasks = seedTasks(f, 2, false);
    seedJob(f, { jobId: "job-held", kind: "compare", tasks });
    const trialIds = seedTrials(f, "job-held", tasks, [[1, 1], [2, 2]], { session: "session-1" });
    assert.equal(pass(f).step(), "waiting");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_reports"), 0);
    f.store.write(tx => {
      for (const trialId of trialIds) clearTrialSession(tx, trialId);
    });
    assert.equal(pass(f).step(), "reported");
  } finally {
    f.close();
  }
  const late = ready();
  try {
    const tasks = seedTasks(late, 2, false);
    seedJob(late, { jobId: "job-late", kind: "compare", tasks });
    seedTrials(late, "job-late", tasks, [[1, 1], [2, 2]], { session: "session-1" });
    const almost = new Date(Date.parse(NOW) + 24 * HOUR_MS - 1000).toISOString();
    assert.equal(pass(late, almost).step(), "waiting");
    const day = new Date(Date.parse(NOW) + 24 * HOUR_MS).toISOString();
    assert.equal(pass(late, day).step(), "reported");
    assert.equal(opened(read(late, "job-late")).pairs.length, 1);
  } finally {
    late.close();
  }
});

test("a confirm report counts only tasks still in holdout", () => {
  const f = ready();
  try {
    const tasks = fixtureP(f, "job-confirm", "confirm", true);
    f.store.write(tx => {
      tx.run("UPDATE eval_groups SET exposed = 1, holdout = 0 WHERE group_id = ?", groupId(11));
    });
    assert.equal(tasks.length, 12);
    assert.equal(pass(f).step(), "reported");
    const report = opened(read(f, "job-confirm"));
    assert.equal(report.kind, "confirm");
    assert.equal(report.set, "holdout");
    assert.equal(report.tasks.leftHoldout, 1);
    assert.equal(report.tasks.analysed, 11);
    assert.equal(report.tasks.planned, 12);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0]?.n, 11);
  } finally {
    f.close();
  }
});

test("the report holds no task material", () => {
  const f = ready();
  try {
    const tasks = fixtureP(f, "job-material", "compare");
    const trialIds = f.store.read(db => db.all<{ trial_id: string }>("SELECT trial_id FROM eval_trials").map(row => row.trial_id));
    assert.equal(trialIds.length, 72);
    assert.equal(pass(f).step(), "reported");
    const json = JSON.stringify(opened(read(f, "job-material")));
    const plain = JSON.stringify(f.store.read(db =>
      db.all("SELECT job_id, project_ref, kind, state, generated_at, expires_at FROM eval_reports")));
    for (const text of [json, plain]) {
      for (const id of tasks) assert.equal(text.includes(id), false, `no task id ${id}`);
      for (const id of trialIds) assert.equal(text.includes(id), false, "no trial id");
      for (let i = 0; i < 12; i += 1) assert.equal(text.includes(groupId(i)), false, "no group id");
      assert.equal(text.includes("model-"), false, "no model name");
    }
    const report = JSON.parse(json) as ComparisonReport;
    assert.equal(report.configurations[0]?.profileId, "profile-a");
    assert.equal(report.configurations[0]?.provider, "claude");
  } finally {
    f.close();
  }
});

test("a baseline job gets prior rows and no report", () => {
  const f = ready();
  try {
    const tasks = seedTasks(f, 4, false);
    seedJob(f, { jobId: "job-base", kind: "baseline", tasks: [] });
    seedTrials(f, "job-base", tasks, [[1, 2, 3, 0], [3, 3, 0, 1]]);
    assert.equal(pass(f).step(), "reported");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_reports"), 0);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_jobs WHERE reported_at IS NOT NULL"), 1);
    const rows = f.store.read(db => db.all<{ configuration: number; tasks: number; trials: number; resolved: number }>(
      "SELECT configuration, tasks, trials, resolved FROM eval_priors ORDER BY configuration"));
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.trials, 12);
    assert.equal(rows[0]?.tasks, 4);
    assert.equal(rows[0]?.resolved, 6);
    assert.equal(rows[1]?.resolved, 7);
    assert.equal(pass(f).step(), "idle");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_priors"), 2);
  } finally {
    f.close();
  }
  const g = ready();
  try {
    const tasks = seedTasks(g, 4, true);
    seedJob(g, { jobId: "job-confirm", kind: "confirm", tasks });
    seedTrials(g, "job-confirm", tasks, [[1, 2, 3, 0], [3, 3, 0, 1]]);
    assert.equal(pass(g).step(), "reported");
    assert.equal(count(g, "SELECT count(*) AS n FROM eval_reports"), 1);
    assert.equal(count(g, "SELECT count(*) AS n FROM eval_priors"), 0);
  } finally {
    g.close();
  }
});

test("reportFor answers each state", () => {
  const f = ready();
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(refusal(read(f, "job-missing")).code, "unknown-job");
    assert.equal(refusal(read(f, "job-missing")).status, 404);
    const tasks = seedTasks(f, 2, false);
    seedJob(f, { jobId: "job-base", kind: "baseline", tasks: [] });
    const base = refusal(read(f, "job-base"));
    assert.equal(base.code, "no-report");
    assert.equal(base.status, 409);
    seedJob(f, { jobId: "job-running", kind: "compare", tasks, finishedAt: null, status: "running" });
    assert.equal(refusal(read(f, "job-running")).code, "report-not-ready");
    seedJob(f, { jobId: "job-done", kind: "compare", tasks, finishedAt: NOW });
    seedTrials(f, "job-done", tasks, [[1, 2], [2, 3]]);
    assert.equal(refusal(read(f, "job-done")).code, "report-not-ready");
    seedJob(f, { jobId: "job-broken", kind: "compare", tasks, finishedAt: "2026-11-14T13:00:00.000Z", rawPayload: "{}" });
    const later = "2026-11-14T14:00:00.000Z";
    assert.equal(pass(f, later).step(), "reported", "the baseline job");
    assert.equal(pass(f, later).step(), "reported", "the finished compare job");
    assert.equal(opened(read(f, "job-done")).pairs.length, 1);
    assert.equal(pass(f, later).step(), "reported", "the unreadable job");
    assert.equal(pass(f, later).step(), "idle");
    const broken = refusal(read(f, "job-broken"));
    assert.equal(broken.code, "report-unreadable");
    assert.equal(broken.status, 409);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_reports WHERE state = 'unreadable'"), 1);
    assert.equal(refusal(read(f, "job-base")).code, "no-report");
  } finally {
    console.warn = warn;
    f.close();
  }
});

test("the hot statements read through an index", () => {
  const f = ready();
  try {
    const plan = (sql: string, ...params: string[]) =>
      f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map(row => row.detail).join("\n");
    assert.match(plan(REPORT_DUE_SQL), /eval_jobs_unreported/);
    assert.match(plan(SESSIONS_HELD_SQL, "job"), /eval_trials_job/);
  } finally {
    f.close();
  }
});

test("the prior export leaves out copies", () => {
  const f = ready();
  try {
    const tasks = seedTasks(f, 1, false);
    seedJob(f, { jobId: "job-copy", kind: "compare", tasks });
    const grade: TrialGrade = { ending: "graded", expectedPassed: 1, expectedTotal: 1, guardPassed: true, resolved: true,
      overwritten: 0, diff: null, isolation: "isolated" };
    f.store.write(tx => {
      [CONFIG_A, CONFIG_B].forEach((item, c) => {
        const trialId = `trial-copy-original-${c}`;
        insertTrial(tx, { trialId, jobId: "job-copy", taskId: tasks[0] as string, configRef: configRef(item), harness: TRIAL_HARNESS_VERSION,
          slot: 0, attempt: 0, projectId: PROJECT, configuration: item, keepDays: 365 }, NOW);
        startTrial(tx, trialId, NOW);
        finishTrial(tx, trialId, { grade, configId: "config-id", profileEpoch: 1, sessionId: null, patchKeepDays: 90 }, NOW);
      });
      insertCopy(tx, { trialId: "trial-copy-of-baseline", jobId: "job-copy", taskId: tasks[0] as string, projectId: PROJECT,
        configuration: CONFIG_A, slot: 1, promptVersion: trialPromptVersion(PROFILE_A), keepDays: 365,
        source: { trialId: "trial-baseline-source", ending: "graded", resolved: true, isolation: "isolated", configId: "config-id",
          profileEpoch: 1, tokens: null, spentUsd: null, cost: null, startedAt: null, endedAt: NOW } }, NOW);
    });
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_trials WHERE reused_from IS NOT NULL"), 1);
    assert.equal(pass(f).step(), "reported");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_priors"), 2);
    assert.equal(count(f, "SELECT sum(trials) AS n FROM eval_priors"), 2);
  } finally {
    f.close();
  }
});

test("a job whose priors cannot be built does not block the next job", () => {
  const f = ready();
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const tasks = seedTasks(f, 2, false);
    seedJob(f, { jobId: "job-a-base", kind: "baseline", tasks: [], sealedPayload: { projectId: PROJECT } });
    seedJob(f, { jobId: "job-b-compare", kind: "compare", tasks, finishedAt: "2026-11-14T13:00:00.000Z" });
    seedTrials(f, "job-b-compare", tasks, [[1, 2], [2, 3]]);
    const later = "2026-11-14T14:00:00.000Z";
    assert.equal(pass(f, later).step(), "reported");
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_jobs WHERE job_id = 'job-a-base' AND reported_at IS NOT NULL"), 1);
    assert.equal(count(f, "SELECT count(*) AS n FROM eval_priors"), 0);
    assert.equal(pass(f, later).step(), "reported");
    assert.equal(opened(read(f, "job-b-compare")).pairs.length, 1);
  } finally {
    console.warn = warn;
    f.close();
  }
});

test("the report statistics are computed in a read, not inside the write", () => {
  const f = ready();
  try {
    fixtureP(f, "job-outside", "compare");
    const seen = { outside: 0, inside: 0 };
    // Counts the statements that read the trial rows, and whether the store's write was open when they ran.
    const counting = <T extends object>(target: T, writing: boolean): T => new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if ((key === "all" || key === "get") && /eval_trials/.test(String(args[0]))) seen[writing ? "inside" : "outside"] += 1;
          return (value as (...inner: unknown[]) => unknown).apply(object, args);
        };
      },
    });
    const spy = new Proxy(f.store, {
      get(target, key) {
        if (key === "write") return (fn: (tx: never) => unknown) => target.write(tx => fn(counting(tx, true) as never));
        if (key === "read") return (fn: (db: never) => unknown) => target.read(db => fn(counting(db, false) as never));
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    assert.equal(new ComparisonPass({ store: spy, config: CONFIG, now: () => NOW }).step(), "reported");
    assert.ok(seen.outside > 0, "the trial rows are read");
    assert.equal(seen.inside, 0, "no trial row is read inside the write");
    assert.equal(opened(read(f, "job-outside")).tasks.analysed > 0, true);
  } finally {
    f.close();
  }
});
