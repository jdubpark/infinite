import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EvalHost } from "../packages/host/src/eval-host.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { finishTrial, insertTrial, openTrialCounts, startTrial } from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import type {
  ComparisonJobRequest,
  ComparisonReport,
  EvalRefusal,
  EvalSummary,
  TrialConfiguration,
  TrialGrade,
  TrialJobPayload,
} from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const NOW = "2026-11-21T12:00:00.000Z";
const DAY_MS = 86_400_000;
const PROJECT = "project-compare-1";
const PLAIN = "project-compare-plain";
const BASELINE = "job-baseline";
const REQUEST_ONE = "11111111-1111-4111-8111-111111111111";
const REQUEST_TWO = "22222222-2222-4222-8222-222222222222";
const FOCUSED = {
  command: "node",
  args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"],
};

const profile = (id: string, model: string) => ({ id, label: id, provider: "claude", model, effort: "high", tier: "strong" }) as TeamModelProfile;
const PROFILE_A = profile("profile-a", "model-a");
const PROFILE_B = profile("profile-b", "model-b");
const configuration = (item: TeamModelProfile): TrialConfiguration => ({ profile: item, guidance: "as-of-base", knowledge: "none" });
const CONFIG_A = configuration(PROFILE_A);
const CONFIG_B = configuration(PROFILE_B);

// Resolved trials out of three, by task and configuration (the comparison test's fixture P).
const P0 = [1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 1, 0];
const P1 = [2, 1, 2, 3, 3, 2, 1, 0, 3, 3, 2, 1];

type Rig = { host: EvalHost; store: EvidenceStore; close: () => void };

function projectConfig() {
  return {
    id: PROJECT, name: PROJECT, path: "/unused/project", source: { mode: "github" },
    team: {
      eval: { focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 100, candidateProfiles: [PROFILE_A, PROFILE_B] },
      features: { areas: [{ id: "core", paths: ["packages/core"] }] },
    },
  };
}

function plainConfig() {
  return { id: PLAIN, name: PLAIN, path: "/unused/plain", source: { mode: "github" }, team: { features: { areas: [{ id: "core", paths: ["packages/core"] }] } } };
}

/** A host over a real store, with no `teams` (so no trial pump), no member, and the clock fixed at NOW. */
function rig(options: { damaged?: boolean } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-compare-run-"));
  const databasePath = evidenceDatabasePath(join(root, "state"));
  if (options.damaged === true) {
    mkdirSync(dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "not a database");
  }
  const store = new EvidenceStore({ databasePath, vaultKey: randomBytes(32) });
  store.register(outcomeModule({ now: () => NOW }));
  store.register(configurationModule());
  const config = {
    stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"),
    projects: [projectConfig(), plainConfig()],
  } as unknown as Config;
  const host = new EvalHost({
    config, store,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main" }) as never },
    hostLoad: { held: () => undefined },
    halt: () => ({ check: () => ({ state: "clear" as const }) }),
    runs: () => [],
    now: () => NOW,
  });
  return {
    host, store,
    close: () => {
      host.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const taskId = (prefix: string, n: number) => `captured:${prefix}${String(n).padStart(3, "0")}`;

/** One valid task in its own root group per task, in the set the test names. The draw is never used. */
function seedTasks(store: EvidenceStore, prefix: string, count: number, set: { holdout: boolean; setAt?: string }): string[] {
  const ids: string[] = [];
  store.write(tx => {
    const ref = tx.index("project", PROJECT);
    for (let i = 0; i < count; i += 1) {
      const id = taskId(prefix, i);
      const group = `group-${prefix}-${String(i).padStart(3, "0")}`;
      tx.run(
        "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', ?, ?, ?, ?, ?)",
        group, ref, group, NOW, set.holdout ? 1 : 0, set.holdout ? set.setAt ?? NOW : null,
      );
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, "
        + "group_id, prompt_origin, area_ref, kind) VALUES (?, 'captured', 'run', 'member', ?, 'valid', 'stored', 'proven', ?, ?, '{}', ?, "
        + "'assignment', ?, 'bugfix')",
        id, ref, NOW, NOW, group, tx.index("area", "core"),
      );
      ids.push(id);
    }
  });
  return ids;
}

/** A finished baseline job with three trials per task and configuration; slot s resolves when s < rows[c][i]. */
function seedBaseline(store: EvidenceStore, tasks: string[], rows: number[][]): void {
  const configs = [CONFIG_A, CONFIG_B];
  store.write(tx => {
    const payload: TrialJobPayload = {
      projectId: PROJECT,
      request: { kind: "baseline", configurations: configs, trialsPerTask: 3, limits: { maxTrials: 1000, maxWallMinutes: 600 } },
      requestDigest: "digest",
      jobDigest: "digest",
    };
    tx.run(
      "INSERT INTO eval_jobs (job_id, project_ref, kind, status, reason, request_id, created_at, expires_at, finished_at, updated_at, payload) "
      + "VALUES (?, ?, 'baseline', 'completed', 'done', ?, ?, ?, ?, ?, ?)",
      BASELINE, tx.index("project", PROJECT), BASELINE, NOW, NOW, NOW, NOW, tx.seal("eval_jobs", BASELINE, payload),
    );
    openTrialCounts(tx, BASELINE, { tasks: tasks.length, trials: 0 });
    tasks.forEach((task, i) => {
      configs.forEach((item, c) => {
        for (let slot = 0; slot < 3; slot += 1) {
          const trialId = `trial-${i}-${c}-${slot}`;
          const grade: TrialGrade = { ending: "graded", expectedPassed: 1, expectedTotal: 1, guardPassed: true,
            resolved: slot < (rows[c]?.[i] ?? 0), overwritten: 0, diff: null, isolation: "isolated" };
          insertTrial(tx, { trialId, jobId: BASELINE, taskId: task, configRef: configRef(item), harness: TRIAL_HARNESS_VERSION, slot, attempt: 0,
            projectId: PROJECT, configuration: item, keepDays: 365 }, NOW);
          startTrial(tx, trialId, NOW);
          finishTrial(tx, trialId, { grade, configId: "config-id", profileEpoch: 1, sessionId: null, patchKeepDays: 90 }, NOW);
        }
      });
    });
  });
}

function request(kind: "compare" | "confirm"): ComparisonJobRequest {
  return { kind, configurations: [CONFIG_A, CONFIG_B], limits: { maxTrials: 200, maxWallMinutes: 600 }, trialsPerTask: 3 };
}

function opened<T extends object>(result: T | EvalRefusal): T {
  assert.equal("code" in result, false, `expected a value, got ${JSON.stringify(result).slice(0, 300)}`);
  return result as T;
}

function refused(result: object, status: number, code: string): void {
  assert.equal("code" in result, true, `expected a refusal, got ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal((result as EvalRefusal).status, status);
  assert.equal((result as EvalRefusal).code, code);
}

const count = (r: Rig, sql: string): number => r.store.read(db => db.get<{ n: number }>(sql)?.n ?? -1);

async function summaryOf(r: Rig, projectId: string): Promise<EvalSummary> {
  return opened<EvalSummary>(await r.host.summary(projectId));
}

test("the host registers the trial tables", () => {
  const r = rig();
  try {
    assert.equal(r.store.status().modules["eval-trials"], "ready");
  } finally {
    r.close();
  }
});

test("a compare job of measured configurations reports on the tick", async () => {
  const r = rig();
  try {
    const tasks = seedTasks(r.store, "a", 12, { holdout: false });
    seedBaseline(r.store, tasks, [P0, P1]);
    const made = opened<{ created: boolean; job: { jobId: string; status: string; reason: string | null } }>(
      r.host.create(PROJECT, request("compare"), REQUEST_ONE),
    );
    assert.equal(made.created, true);
    assert.equal(made.job.status, "completed", "every slot is reused, so the job completes at creation");
    assert.equal(made.job.reason, "done");
    r.host.start();
    await r.host.idle();
    r.host.tick();
    await r.host.idle();
    const report = opened<ComparisonReport>(r.host.report(made.job.jobId));
    assert.equal(report.pairs.length, 1);
    const pair = report.pairs[0] as ComparisonReport["pairs"][number];
    assert.equal(pair.n, 12);
    assert.equal(pair.interval?.[0], 2 / 36);
    assert.equal(pair.interval?.[1], 12 / 36);
    assert.equal(pair.sign.p, 0.0703125);
    const priors = opened<{ projectId: string; priors: { jobId: string; trials: number }[] }>(r.host.priors(PROJECT));
    assert.equal(priors.projectId, PROJECT);
    assert.ok(priors.priors.length > 0, "the baseline job's trials are exported");
    // A reused copy was counted by the job that ran it, so the compare job exports no row of its own.
    assert.ok(priors.priors.every(prior => prior.jobId === BASELINE), "only the baseline job's rows");
    assert.ok(priors.priors.reduce((sum, prior) => sum + prior.trials, 0) > 0);
  } finally {
    r.close();
  }
});

test("a confirm subject is refused through the host", () => {
  const r = rig();
  try {
    seedTasks(r.store, "h", 16, { holdout: true });
    const first = opened<{ created: boolean; job: { jobId: string; kind: string } }>(r.host.create(PROJECT, request("confirm"), REQUEST_ONE));
    assert.equal(first.created, true);
    assert.equal(first.job.kind, "confirm");
    // One active job per kind, so the first is cancelled; a cancelled confirm job still uses its subject.
    const cancelled = opened<{ status: string }>(r.host.control(first.job.jobId, "cancel"));
    assert.equal(cancelled.status, "cancelled");
    refused(r.host.create(PROJECT, request("confirm"), REQUEST_TWO), 409, "subject-confirmed");
  } finally {
    r.close();
  }
});

test("rotation runs on the sweep", async () => {
  const r = rig();
  try {
    const aged = new Date(Date.parse(NOW) - 121 * DAY_MS).toISOString();
    seedTasks(r.store, "r", 3, { holdout: true, setAt: aged });
    const before = await summaryOf(r, PROJECT);
    assert.deepEqual(before.tasks.bySet, { dev: 0, holdout: 3 });
    r.host.sweep();
    const after = await summaryOf(r, PROJECT);
    assert.deepEqual(after.tasks.bySet, { dev: 3, holdout: 0 });
    assert.equal(count(r, "SELECT count(*) AS n FROM eval_groups WHERE holdout = 1"), 0);
  } finally {
    r.close();
  }
});

test("an unavailable store answers 503", () => {
  const r = rig({ damaged: true });
  try {
    assert.notEqual(r.store.status().modules["eval-corpus"], "ready");
    r.host.start();
    r.host.tick();
    r.host.tick();
    refused(r.host.report("job-none"), 503, "evidence-unavailable");
    refused(r.host.priors(PROJECT), 503, "evidence-unavailable");
  } finally {
    r.close();
  }
});

test("a project without eval settings sees no change", async () => {
  const r = rig();
  try {
    r.host.start();
    for (let turn = 0; turn < 3; turn += 1) {
      await r.host.idle();
      r.host.tick();
    }
    await r.host.idle();
    const summary = await summaryOf(r, PLAIN);
    assert.equal(summary.tasks.bySet, null);
    for (const table of ["eval_groups", "eval_jobs", "eval_reports", "eval_priors"]) {
      assert.equal(count(r, `SELECT count(*) AS n FROM ${table}`), 0, `${table} stays empty`);
    }
  } finally {
    r.close();
  }
});
