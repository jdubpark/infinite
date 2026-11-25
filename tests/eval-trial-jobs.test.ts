import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { Config } from "../packages/host/src/types.js";
import type { Provider } from "../packages/host/src/types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { EvalProbe } from "../packages/host/src/eval-identity.js";
import type { GraderProbe } from "../packages/host/src/eval-grader.js";
import type { BaselineJobRequest, ComparisonJobRequest, EvalJobWait, EvalRefusal, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { ACTIVE_JOBS_SQL, ACTIVE_PROJECT_JOBS_SQL, EvalJobs } from "../packages/host/src/eval-jobs.js";
import {
  BASELINE_JOBS_SQL,
  TrialJobs,
  type NextTrial,
  type TrialGates,
} from "../packages/host/src/eval-trial-jobs.js";
import {
  evalTrialsModule,
  finishTrial,
  insertTrial,
  liveTrials,
  openTrialCounts,
  startTrial,
} from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION, trialProfileKey } from "../packages/host/src/eval-trial-rules.js";
import { ComparisonPass, reportFor } from "../packages/host/src/eval-comparison.js";
import { rotateHoldout } from "../packages/host/src/eval-sets.js";
import { advanceEpoch, configurationModule } from "../packages/host/src/configuration-store.js";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-11-16T10:00:00.000Z");
const PROJECT = "project-trials-1";
const BARE = "project-trials-bare";
const OTHER = "project-trials-2";
const REQUEST_ONE = "11111111-1111-4111-8111-111111111111";
const REQUEST_TWO = "22222222-2222-4222-8222-222222222222";
const REQUEST_THREE = "33333333-3333-4333-8333-333333333333";
const REQUEST_FOUR = "44444444-4444-4444-8444-444444444444";
const REQUEST_FIVE = "55555555-5555-4555-8555-555555555555";
const TASK_ONE = "captured:run-1:t01";
const TASK_TWO = "captured:run-1:t02";
const TASK_THREE = "captured:run-1:t03";
const FOCUSED = {
  command: "node",
  args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"],
};

const CLAUDE: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const CODEX: TeamModelProfile = { id: "codex-strong", label: "Codex strong", provider: "codex", model: "gpt-5-codex", effort: "high", tier: "strong" };
const CLAUDE_OTHER: TeamModelProfile = { id: "claude-other", label: "Claude other", provider: "claude", model: "claude-haiku-5-5", effort: "low", tier: "light" };
const CLAUDE_CONTRIBUTOR: TeamModelProfile = { id: "claude-contributor", label: "Claude contributor", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong", dataUse: "contributor" };
const GROK = { id: "grok-strong", label: "Grok strong", provider: "grok", model: "grok-4", tier: "strong" } as unknown as TeamModelProfile;

const LINEUP = {
  coordinator: CLAUDE, integrator: CLAUDE, reviewer: CLAUDE,
  implementers: [CLAUDE, CODEX], escalations: [CLAUDE_CONTRIBUTOR], fallbacks: [],
};

const VOID_GRADE: TrialGrade = { ending: "void-host", expectedPassed: null, expectedTotal: 0, guardPassed: null, resolved: false, overwritten: 0, diff: null, isolation: "none" };

function configuration(profile: TeamModelProfile): TrialConfiguration {
  return { profile, guidance: "as-of-base", knowledge: "none" };
}

function request(extra: Partial<BaselineJobRequest> = {}): BaselineJobRequest {
  return { kind: "baseline", configurations: [configuration(CLAUDE)], limits: { maxTrials: 10, maxWallMinutes: 600 }, ...extra };
}

function project(id: string, team: Record<string, unknown>) {
  return { id, name: id, path: "/srv/unused", source: { mode: "github" }, team: { eval: team } };
}

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "infinite-trial-jobs-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  let clock = START;
  const now = () => new Date(clock).toISOString();
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  const config = {
    projects: [
      project(PROJECT, { mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 1 }),
      project(BARE, { mine: true, focusedTest: FOCUSED, reportFormat: "junit" }),
      project(OTHER, { mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 1 }),
    ],
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: {
        prefix: { command: "/usr/bin/sudo", args: ["-n"] },
        root: "/var/lib/infinite-eval",
        agents: { claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } },
      },
    },
    teams: { workspaceDir: "/srv/unused", lineup: LINEUP },
  } as unknown as Pick<Config, "projects" | "eval" | "teams">;
  const gate = {
    halted: new Set<string>(),
    hostLoad: false,
    identity: { state: "ready", storage: true, fetch: "refused" } as EvalProbe,
    grader: { state: "ready", storage: true, version: 2 } as GraderProbe,
    limited: new Set<Provider>(),
    trialLive: false,
    free: 4,
  };
  const trial = new TrialJobs({ store, config, now });
  const jobs = new EvalJobs({
    store, config, now,
    baseline: { views: (db, rows) => trial.views(db, rows), digest: (projectId, jobId) => trial.digest(projectId, jobId) },
  });
  const gates = (): TrialGates => ({
    identity: gate.identity,
    grader: gate.grader,
    hostLoadHeld: gate.hostLoad,
    halted: projectId => gate.halted.has(projectId),
    limited: gate.limited,
    freeSlots: async () => gate.free,
    trialLive: gate.trialLive,
  });
  return {
    store, config, trial, jobs, gate, gates,
    setClock: (ms: number) => { clock = ms; },
    now,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("block changes only an open job", () => {
  const states: string[] = [];
  for (const kind of ["cancelled", "paused", "running"]) {
    const f = fixture();
    try {
      const created = f.trial.create(PROJECT, request(), REQUEST_ONE);
      assert.ok("job" in created);
      const jobId = created.job.jobId;
      if (kind === "cancelled") f.jobs.control(jobId, "cancel");
      if (kind === "paused") {
        for (let attempt = 0; attempt < 3; attempt++) {
          voidTrial(f, insertAt(f, jobId, attempt));
          f.trial.record(jobId, "void-host");
        }
      }
      if (kind === "running") f.store.write(tx => tx.run("UPDATE eval_jobs SET status = 'running' WHERE job_id = ?", jobId));
      f.trial.block(jobId, "eval-processes-alive");
      const view = f.jobs.view(jobId);
      states.push(`${kind}:${view?.status}:${view?.reason}`);
    } finally {
      f.cleanup();
    }
  }
  assert.equal(states[0], "cancelled:cancelled:owner");
  assert.equal(states[1], "paused:paused:trial-voids");
  assert.equal(states[2], "running:blocked:eval-processes-alive");
});

function addTask(f: Fixture, taskId: string): void {
  const at = new Date(START).toISOString();
  f.store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
      + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
      + "VALUES (?, 'captured', 'run-1', 'member-1', ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, 'run:run-1', 'host', ?)",
      taskId,
      tx.index("project", PROJECT),
      at,
      at,
      tx.seal("eval_tasks", taskId, { projectId: PROJECT }),
      at,
    );
  });
}

function insertAt(f: Fixture, jobId: string, attempt: number, options: { taskId?: string; slot?: number; at?: string; start?: boolean } = {}): string {
  const trialId = randomUUID();
  const at = options.at ?? f.now();
  const configuration_ = configuration(CLAUDE);
  f.store.write(tx => {
    insertTrial(tx, {
      trialId, jobId, taskId: options.taskId ?? TASK_ONE, configRef: configRef(configuration_), harness: TRIAL_HARNESS_VERSION,
      slot: options.slot ?? 0, attempt, projectId: PROJECT, configuration: configuration_, keepDays: 365,
    }, at);
    if (options.start !== false) startTrial(tx, trialId, at);
  });
  return trialId;
}

function voidTrial(f: Fixture, trialId: string): void {
  f.store.write(tx => {
    finishTrial(tx, trialId, { grade: VOID_GRADE, configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90 }, f.now());
  });
}

function assertRefusal(result: unknown, status: number, code: string): void {
  assert.ok(result && typeof result === "object" && "code" in result, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal((result as EvalRefusal).status, status);
  assert.equal((result as EvalRefusal).code, code);
}

test("a baseline request makes one job", () => {
  const f = fixture();
  try {
    for (const taskId of [TASK_ONE, TASK_TWO, TASK_THREE]) addTask(f, taskId);
    const body = request({ limits: { maxTrials: 10, maxWallMinutes: 600 } });
    const first = f.trial.create(PROJECT, body, REQUEST_ONE);
    assert.ok("job" in first, "the first create makes a job");
    assert.equal(first.created, true);
    const again = f.trial.create(PROJECT, body, REQUEST_ONE);
    assert.ok("job" in again);
    assert.equal(again.created, false, "the same id and body return the same job");
    assert.equal(again.job.jobId, first.job.jobId);
    assertRefusal(f.trial.create(PROJECT, request({ limits: { maxTrials: 11, maxWallMinutes: 600 } }), REQUEST_ONE), 409, "request-conflict");
    assert.equal(f.jobs.list().length, 1, "still one job");

    const jobId = first.job.jobId;
    const view = f.jobs.view(jobId);
    assert.ok(view && view.kind === "baseline", "the job view is a baseline view");
    assert.equal(view.tasks.planned, 3, "three valid tasks are planned");
    assert.equal(view.trials.planned, 9, "three tasks times one configuration times three trials each");
    assert.equal(view.dailyCap, 1);

    assertRefusal(f.trial.create(PROJECT, request({ configurations: [configuration(CLAUDE_OTHER)] }), REQUEST_TWO), 409, "profile-not-approved");
    assertRefusal(f.trial.create(PROJECT, request({ configurations: [configuration(GROK)] }), REQUEST_TWO), 409, "profile-not-approved");
    assertRefusal(f.trial.create(PROJECT, request({ configurations: [configuration(CLAUDE_CONTRIBUTOR)] }), REQUEST_TWO), 409, "profile-not-approved");
    assertRefusal(f.trial.create(BARE, request(), REQUEST_THREE), 409, "eval-config-incomplete");
    assertRefusal(f.trial.create("no-such-project", request(), REQUEST_FOUR), 404, "unknown-project");

    assert.ok(!("code" in f.jobs.control(jobId, "pause")), "pause answers the job");
    assertRefusal(f.trial.create(PROJECT, request(), REQUEST_TWO), 409, "job-active");
    const validate = f.jobs.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 60 } }, REQUEST_FIVE);
    assert.ok("job" in validate && validate.created === true, "a validate job beside a paused baseline job is created");
  } finally {
    f.cleanup();
  }
});

test("the job waits for every gate and says which", async () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    const created = f.trial.create(PROJECT, request({ windows: [{ startHourUtc: 10, endHourUtc: 11 }] }), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;

    const first = await f.trial.next(f.gates());
    assert.equal(first.kind, "trial", "with every gate open the job hands out a trial");
    assert.equal(first.kind === "trial" && first.taskId, TASK_ONE);
    assert.equal(first.kind === "trial" && first.slot, 0);
    assert.equal(first.kind === "trial" && first.attempt, 0);

    const expectWait = async (waiting: string) => {
      const result = await f.trial.next(f.gates());
      assert.deepEqual(result, { kind: "wait", jobId, waiting }, `the ${waiting} gate holds the job`);
      assert.equal(f.jobs.view(jobId)?.waiting, waiting, `the column holds ${waiting}`);
    };

    f.gate.halted.add(PROJECT);
    await expectWait("halt");
    f.gate.halted.delete(PROJECT);

    f.setClock(START + 2 * 3_600_000);
    await expectWait("window");
    f.setClock(START);

    f.gate.hostLoad = true;
    await expectWait("host-load");
    f.gate.hostLoad = false;

    f.gate.identity = { state: "busy" } as EvalProbe;
    await expectWait("eval-identity");
    f.gate.identity = { state: "ready", storage: true, fetch: "refused" } as EvalProbe;

    f.gate.grader = { state: "ready", storage: true, version: 1 } as GraderProbe;
    await expectWait("grader");
    f.gate.grader = { state: "ready", storage: false, version: 2 } as GraderProbe;
    await expectWait("storage");
    f.gate.grader = { state: "ready", storage: true, version: 2 } as GraderProbe;
    f.gate.identity = { state: "ready", storage: false, fetch: "refused" } as EvalProbe;
    await expectWait("storage");
    f.gate.identity = { state: "ready", storage: true, fetch: "refused" } as EvalProbe;

    f.gate.trialLive = true;
    await expectWait("another-job");
    f.gate.trialLive = false;

    f.gate.limited = new Set<Provider>(["claude"]);
    await expectWait("provider-limit");
    f.gate.limited = new Set<Provider>();

    f.gate.free = 3;
    await expectWait("session-slots");
    f.gate.free = 4;

    insertAt(f, "other-job", 0, { taskId: TASK_TWO });
    await expectWait("daily-cap");
  } finally {
    f.cleanup();
  }
});

test("a job starts no trial after its limits", async () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    const yesterday = new Date(START - DAY_MS).toISOString();
    const first = f.trial.create(PROJECT, request({ limits: { maxTrials: 2, maxWallMinutes: 600 } }), REQUEST_ONE);
    assert.ok("job" in first);
    insertAt(f, first.job.jobId, 0, { at: yesterday });
    insertAt(f, first.job.jobId, 1, { at: yesterday });
    assert.deepEqual(await f.trial.next(f.gates()), { kind: "none" }, "two trials reach maxTrials");
    const done = f.jobs.view(first.job.jobId);
    assert.equal(done?.status, "completed");
    assert.equal(done?.reason, "limit-reached");

    const second = f.trial.create(PROJECT, request(), REQUEST_TWO);
    assert.ok("job" in second);
    insertAt(f, "other-job", 0, { taskId: TASK_TWO });
    const capped = await f.trial.next(f.gates());
    assert.deepEqual(capped, { kind: "wait", jobId: second.job.jobId, waiting: "daily-cap" }, "one trial today reaches trialsPerDay 1");

    f.setClock(START + DAY_MS);
    const next = await f.trial.next(f.gates());
    assert.equal(next.kind, "trial", "the next UTC day starts a trial");
  } finally {
    f.cleanup();
  }
});

test("a changed configuration blocks the job", async () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    const created = f.trial.create(PROJECT, request(), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    assert.equal((await f.trial.next(f.gates())).kind, "trial");

    (f.config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.trialMinutes = 30;
    assert.deepEqual(await f.trial.next(f.gates()), { kind: "none" }, "a changed trialMinutes returns no trial");
    assert.equal(f.jobs.view(jobId)?.status, "blocked");
    assert.equal(f.jobs.view(jobId)?.reason, "configuration-changed");

    assert.ok(!("code" in f.jobs.control(jobId, "resume")), "resume answers the job");
    assert.equal(f.jobs.view(jobId)?.status, "running");
    assert.equal((await f.trial.next(f.gates())).kind, "trial", "resume pins the new digest");

    f.config.eval!.member!.root = "/var/lib/another-eval";
    assert.deepEqual(await f.trial.next(f.gates()), { kind: "none" }, "a changed eval.member root blocks the job too");
    assert.equal(f.jobs.view(jobId)?.reason, "configuration-changed");
    assert.ok(!("code" in f.jobs.control(jobId, "resume")));
    assert.equal((await f.trial.next(f.gates())).kind, "trial");
  } finally {
    f.cleanup();
  }
});

test("three voids in a row pause the job", () => {
  const f = fixture();
  try {
    const created = f.trial.create(PROJECT, request(), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    for (let attempt = 0; attempt < 3; attempt++) {
      voidTrial(f, insertAt(f, jobId, attempt));
      f.trial.record(jobId, "void-host");
      if (attempt < 2) assert.equal(f.jobs.view(jobId)?.status, "scheduled", "two voids do not pause the job");
    }
    assert.equal(f.jobs.view(jobId)?.status, "paused");
    assert.equal(f.jobs.view(jobId)?.reason, "trial-voids");
  } finally {
    f.cleanup();
  }
});

test("cancel voids the running trial", async () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    const created = f.trial.create(PROJECT, request(), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    assert.equal((await f.trial.next(f.gates())).kind, "trial");
    const trialId = insertAt(f, jobId, 0);

    assert.ok(!("code" in f.jobs.control(jobId, "pause")));
    assert.equal(f.jobs.view(jobId)?.status, "paused");
    assert.ok(f.store.read(db => liveTrials(db)).some(row => row.trialId === trialId), "pause leaves the live trial alone");

    assert.ok(!("code" in f.jobs.control(jobId, "resume")));
    assert.ok(!("code" in f.jobs.control(jobId, "cancel")));
    assert.equal(f.jobs.view(jobId)?.status, "cancelled");
    assert.ok(f.store.read(db => liveTrials(db)).some(row => row.trialId === trialId),
      "cancel leaves the live trial for the pump to end void-owner");
    assert.deepEqual(await f.trial.next(f.gates()), { kind: "none" }, "a cancelled job hands out nothing");
  } finally {
    f.cleanup();
  }
});

test("the baseline statements read through an index", () => {
  const f = fixture();
  try {
    const plans: [string, string, unknown[], string][] = [
      ["BASELINE_JOBS_SQL", BASELINE_JOBS_SQL, ["scheduled", 100], "eval_jobs_status"],
      ["ACTIVE_JOBS_SQL", ACTIVE_JOBS_SQL, ["scheduled", 20], "eval_jobs_status"],
      ["ACTIVE_PROJECT_JOBS_SQL", ACTIVE_PROJECT_JOBS_SQL, ["p", "baseline"], "eval_jobs_project"],
    ];
    for (const [name, sql, params, index] of plans) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(params as never[])).map(row => row.detail));
      assert.ok(details.some(detail => detail.includes(index)), `${name} uses ${index}: ${details.join("; ")}`);
      assert.ok(details.every(detail => !detail.includes("SCAN eval_jobs") || detail.includes(index)), `${name} does not scan eval_jobs`);
    }
  } finally {
    f.cleanup();
  }
});

test("a provider outside the supported three is refused even when the lineup lists it", () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    const teams = f.config.teams as unknown as { lineup: typeof LINEUP };
    teams.lineup = { ...LINEUP, implementers: [CLAUDE, CODEX, GROK] };
    assertRefusal(f.trial.create(PROJECT, request({ configurations: [configuration(GROK)] }), REQUEST_TWO), 409, "profile-not-approved");
    assert.equal(f.jobs.list().length, 0, "no job was made");
  } finally {
    f.cleanup();
  }
});

test("a baseline job is not a validation job", () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    const created = f.trial.create(PROJECT, request(), REQUEST_ONE);
    assert.ok("job" in created);
    const work = f.jobs.next({ grader: f.gate.grader, hostLoadHeld: false, halted: () => false });
    assert.deepEqual(work, { kind: "none" }, "the validation pump leaves the baseline job alone");
    assert.equal(f.jobs.view(created.job.jobId)?.status, "scheduled");
  } finally {
    f.cleanup();
  }
});

test("a job ends done at maxTasks and expired at its expiry time", async () => {
  const f = fixture();
  try {
    addTask(f, TASK_ONE);
    addTask(f, TASK_TWO);
    const body = request({ trialsPerTask: 1, taskFilter: { maxTasks: 1 } });
    const first = f.trial.create(PROJECT, body, REQUEST_ONE);
    assert.ok("job" in first);
    const trialId = insertAt(f, first.job.jobId, 0, { at: new Date(START - DAY_MS).toISOString() });
    f.store.write(tx => {
      finishTrial(tx, trialId, { grade: { ...VOID_GRADE, ending: "graded" }, configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90 }, f.now());
    });
    assert.deepEqual(await f.trial.next(f.gates()), { kind: "none" }, "the one task is reached, so the second is not started");
    const done = f.jobs.view(first.job.jobId);
    assert.equal(done?.status, "completed");
    assert.equal(done?.reason, "done");

    const expires = new Date(START + 3_600_000).toISOString();
    const second = f.trial.create(PROJECT, request({ expiresAt: expires }), REQUEST_TWO);
    assert.ok("job" in second);
    f.setClock(START + 3_600_000);
    assert.deepEqual(await f.trial.next(f.gates()), { kind: "none" }, "a job is expired at its expiry time");
    assert.equal(f.jobs.view(second.job.jobId)?.status, "expired");
  } finally {
    f.cleanup();
  }
});

const GRADED: TrialGrade = { ending: "graded", expectedPassed: 1, expectedTotal: 1, guardPassed: true, resolved: true, overwritten: 0, diff: null, isolation: "isolated" };
const REQUEST_SIX = "66666666-6666-4666-8666-666666666666";
const taskName = (n: number) => `captured:run-1:c${String(n).padStart(3, "0")}`;

function addGrouped(f: Fixture, taskId: string, holdout: boolean): void {
  const at = new Date(START).toISOString();
  f.store.write(tx => {
    const ref = tx.index("project", PROJECT);
    tx.run(
      "INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', ?, ?, ?, ?, ?)",
      `group-${taskId}`, ref, `group-${taskId}`, at, holdout ? 1 : 0, holdout ? at : null,
    );
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
      + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
      + "VALUES (?, 'captured', 'run-1', 'member-1', ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, ?, 'host', ?)",
      taskId, ref, at, at, tx.seal("eval_tasks", taskId, { projectId: PROJECT }), `group-${taskId}`, at,
    );
  });
}

function compareRequest(kind: "compare" | "confirm", extra: Partial<ComparisonJobRequest> = {}): ComparisonJobRequest {
  return { kind, configurations: [configuration(CLAUDE), configuration(CODEX)], limits: { maxTrials: 200, maxWallMinutes: 600 }, trialsPerTask: 1, ...extra };
}

function raiseCap(f: Fixture): void {
  (f.config.projects[0] as unknown as { team: { eval: Record<string, unknown> } }).team.eval.trialsPerDay = 100;
}

function runTrial(f: Fixture, next: Extract<NextTrial, { kind: "trial" }>): void {
  const trialId = randomUUID();
  f.store.write(tx => {
    insertTrial(tx, {
      trialId, jobId: next.jobId, taskId: next.taskId, configRef: next.configRef, harness: TRIAL_HARNESS_VERSION,
      slot: next.slot, attempt: next.attempt, projectId: PROJECT, configuration: next.configuration, keepDays: 365,
    }, f.now());
    startTrial(tx, trialId, f.now());
    finishTrial(tx, trialId, { grade: GRADED, configId: "config-id", profileEpoch: 1, sessionId: null, patchKeepDays: 90 }, f.now());
  });
}

async function drain(f: Fixture): Promise<string[]> {
  const order: string[] = [];
  for (let turn = 0; turn < 100; turn += 1) {
    const next = await f.trial.next(f.gates());
    if (next.kind !== "trial") return order;
    order.push(next.taskId);
    runTrial(f, next);
  }
  throw new Error("The scheduler never stopped.");
}

function created(result: unknown): { created: boolean; job: { jobId: string } } {
  assert.ok(result && typeof result === "object" && "job" in result, `expected a job, got ${JSON.stringify(result)}`);
  return result as { created: boolean; job: { jobId: string } };
}

function countOf(f: Fixture, sql: string, ...params: string[]): number {
  return f.store.read(db => db.get<{ n: number }>(sql, ...params)?.n ?? -1);
}

test("baseline reads the dev set only", async () => {
  const f = fixture();
  try {
    raiseCap(f);
    for (let n = 1; n <= 3; n += 1) addGrouped(f, taskName(n), false);
    addGrouped(f, taskName(4), true);
    const made = created(f.trial.create(PROJECT, request({ trialsPerTask: 1 }), REQUEST_ONE));
    const view = f.jobs.view(made.job.jobId);
    assert.ok(view && view.kind === "baseline");
    assert.equal(view.tasks.planned, 3, "the holdout task is not planned");
    const order = await drain(f);
    assert.equal(order.length, 3);
    assert.equal(order.includes(taskName(4)), false, "no trial starts for the holdout task");
    assert.equal(f.jobs.view(made.job.jobId)?.reason, "done");
  } finally {
    f.cleanup();
  }
});

test("a compare job runs its fixed list in order", async () => {
  const f = fixture();
  try {
    raiseCap(f);
    for (let n = 1; n <= 3; n += 1) addGrouped(f, taskName(n), false);
    const made = created(f.trial.create(PROJECT, compareRequest("compare"), REQUEST_ONE));
    addGrouped(f, taskName(4), false);
    f.store.write(tx => {
      tx.run("UPDATE eval_tasks SET state = 'retired' WHERE task_id = ?", taskName(2));
    });
    const order = await drain(f);
    assert.equal(order.length, 4, "two configurations on two remaining tasks");
    assert.deepEqual([...new Set(order)], [taskName(1), taskName(3)], "the list's order, without the retired and the added task");
    const view = f.jobs.view(made.job.jobId);
    assert.ok(view && view.kind === "compare");
    assert.equal(view.status, "completed");
    assert.equal(view.reason, "done");
    assert.equal(view.tasks.planned, 3);
    assert.equal(view.tasks.skipped, 1, "the retired task counts as skipped");
  } finally {
    f.cleanup();
  }
});

test("a fully reused compare completes at creation", async () => {
  const f = fixture();
  try {
    raiseCap(f);
    const ended = new Date(START - DAY_MS).toISOString();
    for (let n = 1; n <= 2; n += 1) addGrouped(f, taskName(n), false);
    for (const [index, taskId] of [taskName(1), taskName(2)].entries()) {
      for (const [side, item] of [configuration(CLAUDE), configuration(CODEX)].entries()) {
        const jobId = `seed-job-${index}-${side}`;
        f.store.write(tx => {
          tx.run("INSERT INTO eval_jobs (job_id, project_ref, kind, status, request_id, created_at, expires_at, updated_at, payload) "
            + "VALUES (?, 'ref', 'baseline', 'completed', ?, ?, ?, ?, '{}')", jobId, jobId, ended, ended, ended);
          openTrialCounts(tx, jobId, { tasks: 1, trials: 1 });
          const trialId = randomUUID();
          insertTrial(tx, {
            trialId, jobId, taskId, configRef: configRef(item), harness: TRIAL_HARNESS_VERSION, slot: 0, attempt: 0,
            projectId: PROJECT, configuration: item, keepDays: 365,
          }, ended);
          startTrial(tx, trialId, ended);
          finishTrial(tx, trialId, { grade: GRADED, configId: "config-id", profileEpoch: 1, sessionId: null, patchKeepDays: 90 }, ended);
        });
      }
    }
    const made = created(f.trial.create(PROJECT, compareRequest("compare"), REQUEST_ONE));
    const view = f.jobs.view(made.job.jobId);
    assert.ok(view && view.kind === "compare");
    assert.equal(view.status, "completed");
    assert.equal(view.reason, "done");
    assert.equal(view.trials.reused, 4);
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_trials WHERE job_id = ?", made.job.jobId), 4, "only the copies exist");
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_trials WHERE job_id = ? AND reused_from IS NOT NULL", made.job.jobId), 4);
    assert.equal((await f.trial.next(f.gates())).kind, "none");
  } finally {
    f.cleanup();
  }
});

test("a changed identity ends the job", async () => {
  const f = fixture();
  try {
    raiseCap(f);
    for (let n = 1; n <= 2; n += 1) addGrouped(f, taskName(n), false);
    const made = created(f.trial.create(PROJECT, compareRequest("compare"), REQUEST_ONE));
    const first = await f.trial.next(f.gates());
    assert.equal(first.kind, "trial");
    if (first.kind === "trial") runTrial(f, first);
    f.setClock(START + 60_000);
    advanceEpoch(f.store, { profile: trialProfileKey(CLAUDE), requestId: REQUEST_TWO, now: new Date(START + 30_000).toISOString() });
    assert.equal((await f.trial.next(f.gates())).kind, "none", "no trial starts after the epoch moved");
    const view = f.jobs.view(made.job.jobId);
    assert.equal(view?.status, "completed");
    assert.equal(view?.reason, "identity-changed");
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_trials WHERE job_id = ?", made.job.jobId), 1, "no further trial row exists");
  } finally {
    f.cleanup();
  }
});

test("a repeated request creates one job", () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 15; n += 1) addGrouped(f, taskName(n), true);
    const body = compareRequest("confirm");
    const first = created(f.trial.create(PROJECT, body, REQUEST_ONE));
    assert.equal(first.created, true);
    const again = created(f.trial.create(PROJECT, body, REQUEST_ONE));
    assert.equal(again.created, false);
    assert.equal(again.job.jobId, first.job.jobId);
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_jobs"), 1, "one job");
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_subjects"), 1, "one subject row");
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_groups WHERE holdout = 1 AND confirms = 1"), 15, "each root counts once");
    assert.equal(countOf(f, "SELECT count(*) AS n FROM eval_groups WHERE confirms != 1"), 0);
  } finally {
    f.cleanup();
  }
});

test("one active job per kind", () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 3; n += 1) addGrouped(f, taskName(n), false);
    for (let n = 11; n <= 25; n += 1) addGrouped(f, taskName(n), true);
    created(f.trial.create(PROJECT, compareRequest("compare"), REQUEST_ONE));
    assertRefusal(f.trial.create(PROJECT, compareRequest("compare", { trialsPerTask: 2 }), REQUEST_TWO), 409, "job-active");
    const confirm = created(f.trial.create(PROJECT, compareRequest("confirm"), REQUEST_THREE));
    assert.equal(confirm.created, true, "a confirm job beside an active compare job is created");
  } finally {
    f.cleanup();
  }
});

test("an interim view shows no result", async () => {
  const f = fixture();
  try {
    raiseCap(f);
    for (let n = 1; n <= 2; n += 1) addGrouped(f, taskName(n), false);
    const made = created(f.trial.create(PROJECT, compareRequest("compare"), REQUEST_ONE));
    const next = await f.trial.next(f.gates());
    assert.equal(next.kind, "trial");
    if (next.kind === "trial") runTrial(f, next);
    const running = f.jobs.view(made.job.jobId);
    assert.ok(running && running.kind === "compare");
    assert.equal(running.status, "running");
    assert.equal(running.trials.resolved, null, "no resolved count while the job runs");
    assert.equal(running.report, null);
    assert.equal(running.set, "dev");
    assert.ok(!("code" in f.jobs.control(made.job.jobId, "cancel")));
    const pending = f.jobs.view(made.job.jobId);
    assert.ok(pending && pending.kind === "compare");
    assert.equal(pending.report, "pending");
    assert.equal(pending.trials.resolved, null, "a finished job without a report shows no result");
    f.store.write(tx => {
      tx.run("UPDATE eval_jobs SET reported_at = ? WHERE job_id = ?", f.now(), made.job.jobId);
    });
    const ready = f.jobs.view(made.job.jobId);
    assert.ok(ready && ready.kind === "compare");
    assert.equal(ready.report, "ready");
    assert.equal(ready.trials.resolved, 1, "the resolved count shows once reported");
  } finally {
    f.cleanup();
  }
});

test("a comparison job waits for the trial gates", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 2; n += 1) addGrouped(f, taskName(n), false);
    const made = created(f.trial.create(PROJECT, compareRequest("compare"), REQUEST_ONE));
    f.gate.limited = new Set<Provider>(["claude"]);
    const limited = await f.trial.next(f.gates());
    assert.equal(limited.kind, "wait");
    assert.equal(limited.kind === "wait" && limited.waiting, "provider-limit");
    assert.equal(limited.kind === "wait" && limited.jobId, made.job.jobId);
    f.gate.limited = new Set<Provider>();
    insertAt(f, "other-job", 0, { taskId: taskName(9) });
    const capped = await f.trial.next(f.gates());
    assert.equal(capped.kind, "wait");
    assert.equal(capped.kind === "wait" && capped.waiting, "daily-cap");
  } finally {
    f.cleanup();
  }
});

test("a paused or blocked job expires at its expiry time, and an unexpired paused job stays paused", async () => {
  for (const kind of ["paused", "blocked"] as const) {
    const f = fixture();
    try {
      const expires = new Date(START + 3_600_000).toISOString();
      const created = f.trial.create(PROJECT, request({ expiresAt: expires }), REQUEST_ONE);
      assert.ok("job" in created, JSON.stringify(created));
      const jobId = created.job.jobId;
      if (kind === "paused") f.jobs.control(jobId, "pause");
      else f.trial.block(jobId, "eval-processes-alive");
      assert.equal(f.jobs.view(jobId)?.status, kind);
      f.setClock(START + 3_600_000 - 1);
      await f.trial.next(f.gates());
      assert.equal(f.jobs.view(jobId)?.status, kind, `before its expiry a ${kind} job stays ${kind}`);
      f.setClock(START + 3_600_000);
      await f.trial.next(f.gates());
      const view = f.jobs.view(jobId);
      assert.equal(view?.status, "expired", kind);
      assert.equal(view?.reason, "expired");
      assert.equal(view?.finishedAt, f.now());
    } finally {
      f.cleanup();
    }
  }
});

test("a paused confirm job past its expiry gets its report and frees the holdout rotation", async () => {
  const f = fixture();
  try {
    const expires = new Date(START + 3_600_000).toISOString();
    const created = f.trial.create(PROJECT, request({ expiresAt: expires }), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    f.store.write(tx => {
      tx.run("UPDATE eval_jobs SET kind = 'confirm', status = 'paused', reason = 'owner' WHERE job_id = ?", jobId);
      tx.run(
        "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES ('run:held', 'run', ?, 'run:held', ?, 1, ?)",
        tx.index("project", PROJECT), new Date(START).toISOString(), new Date(START - 300 * DAY_MS).toISOString(),
      );
    });
    f.setClock(START + 3_600_000);
    await f.trial.next(f.gates());
    assert.equal(f.jobs.view(jobId)?.status, "expired");
    assert.equal(f.store.write(tx => rotateHoldout(tx, f.now())), 0, "the unreported confirm job still holds the groups");
    const pass = new ComparisonPass({ store: f.store, config: f.config, now: f.now });
    assert.equal(pass.step(), "reported");
    const stamped = f.store.read(db => db.get<{ reported_at: string | null }>("SELECT reported_at FROM eval_jobs WHERE job_id = ?", jobId));
    assert.equal(stamped?.reported_at, f.now());
    assert.equal(f.store.write(tx => rotateHoldout(tx, f.now())), 1, "the rotation moves again");
  } finally {
    f.cleanup();
  }
});

test("the job view says when the stored report is unreadable", () => {
  const f = fixture();
  try {
    const created = f.trial.create(PROJECT, request(), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    const at = f.now();
    f.store.write(tx => {
      tx.run("UPDATE eval_jobs SET kind = 'compare', status = 'completed', reason = 'done', finished_at = ?, payload = 'x' WHERE job_id = ?", at, jobId);
    });
    const before = f.jobs.view(jobId) as { report?: string | null };
    assert.equal(before.report, "pending");
    const pass = new ComparisonPass({ store: f.store, config: f.config, now: f.now });
    assert.equal(pass.step(), "reported");
    const state = f.store.read(db => db.get<{ state: string }>("SELECT state FROM eval_reports WHERE job_id = ?", jobId));
    assert.equal(state?.state, "unreadable");
    assert.equal((f.jobs.view(jobId) as { report?: string | null }).report, "unreadable");
    const listed = f.jobs.list().find(view => view.jobId === jobId) as { report?: string | null } | undefined;
    assert.equal(listed?.report, "unreadable");
    const report = f.store.read(db => reportFor(db, jobId)) as { status?: number; code?: string };
    assert.equal(report.status, 409);
    assert.equal(report.code, "report-unreadable");
  } finally {
    f.cleanup();
  }
});

test("an idle job past its expiry waits for its live trial to end", () => {
  const f = fixture();
  try {
    const created = f.trial.create(PROJECT, request({ expiresAt: new Date(START + 3_600_000).toISOString() }), REQUEST_ONE);
    assert.ok("job" in created);
    const jobId = created.job.jobId;
    const trialId = insertAt(f, jobId, 0);
    f.jobs.control(jobId, "pause");
    f.setClock(START + 3_600_000);
    assert.equal(f.trial.expireIdle(), 0, "a running trial holds the job");
    assert.equal(f.jobs.view(jobId)?.status, "paused");
    voidTrial(f, trialId);
    assert.equal(f.trial.expireIdle(), 1, "the job expires once the trial is final");
    assert.equal(f.jobs.view(jobId)?.status, "expired");
  } finally {
    f.cleanup();
  }
});

type Slot = { jobId: string; slot: number; attempt: number };

function release(f: Fixture, at: Slot, waiting: EvalJobWait): { answer: "released" | "exhausted"; row: boolean } {
  const trialId = insertAt(f, at.jobId, at.attempt, { slot: at.slot, start: false });
  const answer = f.trial.release({ jobId: at.jobId, taskId: TASK_ONE, configRef: configRef(configuration(CLAUDE)), slot: at.slot, attempt: at.attempt, trialId }, waiting);
  return { answer, row: f.store.read(db => db.get("SELECT 1 FROM eval_trials WHERE trial_id = ?", trialId)) !== undefined };
}
const answers = (f: Fixture, at: Slot, waiting: EvalJobWait, count: number) => Array.from({ length: count }, () => release(f, at, waiting).answer);
function open(f: Fixture, project = PROJECT, id = REQUEST_ONE): string {
  const created = f.trial.create(project, request(), id);
  assert.ok("job" in created);
  return created.job.jobId;
}

test("a release counts one slot only: a release of another slot starts the count again", () => {
  const f = fixture();
  try {
    const jobId = open(f);
    assert.ok(answers(f, { jobId, slot: 0, attempt: 0 }, "bundle-missing", 9).every(answer => answer === "released"), "nine releases keep the attempt");
    assert.equal(f.jobs.view(jobId)?.waiting, "bundle-missing", "the cause shows as the job's wait");
    assert.equal(release(f, { jobId, slot: 1, attempt: 0 }, "bundle-missing").answer, "released", "another slot's first release");
    assert.ok(answers(f, { jobId, slot: 0, attempt: 0 }, "bundle-missing", 9).every(answer => answer === "released"), "the count of the first slot started again");
    assert.equal(release(f, { jobId, slot: 0, attempt: 0 }, "bundle-missing").answer, "exhausted", "the tenth in a row for one slot");
    assert.equal(release(f, { jobId, slot: 0, attempt: 1 }, "bundle-missing").answer, "released", "the next attempt counts from one");
  } finally {
    f.cleanup();
  }
});

test("a mirror or halt wait is never counted, and it starts the count again", () => {
  const f = fixture();
  try {
    const jobId = open(f);
    const at = { jobId, slot: 0, attempt: 0 };
    assert.ok(answers(f, at, "halt", 12).every(answer => answer === "released"));
    assert.equal(f.jobs.view(jobId)?.waiting, "halt");
    assert.ok(answers(f, at, "mirror", 12).every(answer => answer === "released"));
    assert.equal(f.jobs.view(jobId)?.waiting, "mirror");
    assert.ok(answers(f, at, "bundle-missing", 5).every(answer => answer === "released"));
    assert.ok(answers(f, at, "halt", 3).every(answer => answer === "released"));
    assert.ok(answers(f, at, "bundle-missing", 9).every(answer => answer === "released"), "the count was one again after the wait");
    assert.equal(release(f, at, "bundle-missing").answer, "exhausted");
  } finally {
    f.cleanup();
  }
});

test("two jobs that take turns each reach their own tenth release", () => {
  const f = fixture();
  try {
    const first = open(f, PROJECT, REQUEST_ONE);
    const second = open(f, OTHER, REQUEST_TWO);
    const seen: string[] = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      seen.push(release(f, { jobId: first, slot: 0, attempt: 0 }, "eval-failed").answer, release(f, { jobId: second, slot: 0, attempt: 0 }, "eval-failed").answer);
    }
    assert.deepEqual(seen.slice(0, 18).filter(answer => answer !== "released"), [], "nine turns each keep the attempt");
    assert.deepEqual(seen.slice(18), ["exhausted", "exhausted"], "each job's tenth release ends its trial");
  } finally {
    f.cleanup();
  }
});

test("a job that is no longer open only loses the row", () => {
  const f = fixture();
  try {
    const jobId = open(f);
    assert.ok(!("code" in f.jobs.control(jobId, "cancel")));
    const results = Array.from({ length: 10 }, () => release(f, { jobId, slot: 0, attempt: 0 }, "bundle-missing"));
    assert.ok(results.every(result => result.answer === "released" && !result.row), "ten releases never end a trial, and each removes its row");
    assert.equal(f.jobs.view(jobId)?.waiting, null, "no wait is written on a cancelled job");
  } finally {
    f.cleanup();
  }
});

test("a release removes the row; an exhausted one leaves it for the caller to end", () => {
  const f = fixture();
  try {
    const jobId = open(f);
    const at = { jobId, slot: 0, attempt: 0 };
    const results = Array.from({ length: 10 }, () => release(f, at, "storage"));
    assert.ok(results.slice(0, 9).every(result => result.answer === "released" && !result.row));
    assert.deepEqual(results[9], { answer: "exhausted", row: true });
    const state = f.store.read(db => db.get<{ state: string }>("SELECT state FROM eval_trials WHERE job_id = ?", jobId));
    assert.equal(state?.state, "preparing");
  } finally {
    f.cleanup();
  }
});
