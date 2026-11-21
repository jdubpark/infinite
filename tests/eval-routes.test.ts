import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { EvalJobs } from "../packages/host/src/eval-jobs.js";
import { evalRoutes } from "../packages/host/src/eval-routes.js";
import { AREA_COUNTS_SQL, STATE_COUNTS_SQL, SUMMARY_JOBS, VALID_CAPTURED_SQL, evalSummary } from "../packages/host/src/eval-summary.js";
import { groupStats } from "../packages/host/src/eval-groups.js";
import { insertMined, minedTaskId } from "../packages/host/src/eval-miner.js";
import {
  capturedTaskId,
  completeMaterial,
  evalCorpusModule,
  insertMarker,
  readEvalTask,
  retireTask,
} from "../packages/host/src/eval-store.js";
import { EVAL_MODULE, type Capsule, type CaptureStart, type EvalFeatures, type EvalHostApi, type EvalIdentityState, type EvalRefusal, type GraderState, type MiningStatus } from "../packages/host/src/eval-types.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx } from "../packages/host/src/evidence/types.js";
import { TrialJobs } from "../packages/host/src/eval-trial-jobs.js";
import { evalTrialsModule, insertTrial, trialsSince } from "../packages/host/src/eval-trial-store.js";
import { outcomeModule, writeOutcome, type OutcomeRow } from "../packages/host/src/outcome-store.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const NOW = "2026-11-16T12:00:00.000Z";
const CAPTURED_AT = "2026-11-15T10:00:00.000Z";
const LEDGER_AT = "2026-11-14T10:00:00.000Z";
const PROJECT = "project-routes";
const MEMBER = "member-a";
const ANCHOR = "a".repeat(40);
const MEMBER_BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);
const MINED_COMMIT = "e".repeat(40);
const REJECTED_COMMIT = "f".repeat(40);
const FOCUSED = {
  command: "node",
  args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"],
};
const FEATURES: EvalFeatures = { role: "implementer", area: "host", kind: "feature", risk: "normal", featureVersion: 1 };
const CAPSULE: Capsule = {
  objective: "Ship the scheduler",
  steering: [],
  ownerAnswers: [],
  task: { id: "a", title: "Task a", instructions: "Do a", paths: ["a.txt"] },
};
const JOB = { kind: "validate", limits: { maxWallMinutes: 60 } };
const TRIALS_PER_DAY = 6;
const MODEL = "model-trial-zeta";
const CLAUDE_TRIAL: TeamModelProfile = { id: "claude-trial", label: "Claude trial", provider: "claude", model: MODEL, effort: "high", tier: "strong" };
const TRIAL_CONFIGURATION = { profile: CLAUDE_TRIAL, guidance: "as-of-base", knowledge: "none" };
const BASELINE_JOB = { kind: "baseline", configurations: [TRIAL_CONFIGURATION], limits: { maxTrials: 10, maxWallMinutes: 60 } };
const PATCH_TEXT = "patch-text-4c7e";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const REQUEST_OTHER = "22222222-2222-4222-8222-222222222222";
const READ_ROLES = ["owner", "controller", "viewer"];
const PROJECT_WIDE = "project-wide";
/** Seventy feature-map areas, sorted so that the last seven are the ones the 64-area cap folds. */
const WIDE_AREAS = Array.from({ length: 70 }, (_, index) => `area-${String(index).padStart(2, "0")}`);

type Fixture = {
  store: EvidenceStore;
  mining: MiningStatus;
  grader: GraderState;
  api: EvalHostApi;
  cleanup: () => void;
};

type FixtureOptions = {
  /** False leaves the store with no ledger module, as a host that has not built one. */
  outcomes?: boolean;
  /** True reopens the corpus at an older module version, so the store reports it unavailable (a rolled-back host). */
  rollback?: boolean;
  /** True writes a file that is not a database, so the store opens as unavailable. */
  damaged?: boolean;
  /** The grader's state and launcher version, and the eval identity's state, as the host's probes would report them. */
  grader?: GraderState;
  graderVersion?: number | null;
  identity?: EvalIdentityState;
};

type Reply = { status: number; text: string; body: any };

/** A project that mines, captures, and validates, with one feature-map area (`host`). */
function projectConfig() {
  return {
    id: PROJECT, name: PROJECT, path: "/unused/project", source: { mode: "github" },
    team: {
      eval: { capture: true, mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: TRIALS_PER_DAY, candidateProfiles: [CLAUDE_TRIAL] },
      features: { areas: [{ id: "host", paths: ["packages/host"] }] },
    },
  };
}

/** A project that does not mine, keeps 1,000 days of records, and has seventy areas. */
function wideConfig() {
  return {
    id: PROJECT_WIDE, name: PROJECT_WIDE, path: "/unused/wide", source: { mode: "github" },
    team: {
      eval: { capture: true, retentionDays: 1000, focusedTest: FOCUSED, reportFormat: "junit" },
      features: { areas: WIDE_AREAS.map(id => ({ id, paths: [`packages/${id}`] })) },
    },
  };
}

/**
 * The host API of the plan, built from the real store, the real `EvalJobs`, and the real summary, with a fake miner
 * status and grader state. `retire` is the owner's task retirement, written here as a small adapter.
 */
function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-eval-routes-"));
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const vaultKey = randomBytes(32);
  // A file that is not a database makes the store open as unavailable, as a damaged evidence file does.
  if (options.damaged === true) {
    mkdirSync(dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "not a database");
  }
  if (options.rollback === true) {
    // A newer host builds the corpus tables; this store then reopens them at an older version.
    const newer = new EvidenceStore({ databasePath, vaultKey });
    newer.register(evalCorpusModule(newer, () => NOW));
    newer.close();
  }
  const store = new EvidenceStore({ databasePath, vaultKey });
  if (options.outcomes !== false) store.register(outcomeModule({ now: () => NOW }));
  const corpus = evalCorpusModule(store, () => NOW);
  store.register(options.rollback === true ? { ...corpus, version: 1, readVersion: 1 } : corpus);
  store.register(evalTrialsModule(store, () => NOW));
  const config = { projects: [projectConfig(), wideConfig()] } as unknown as Pick<Config, "projects" | "eval" | "teams">;
  const trials = new TrialJobs({ store, config, now: () => NOW });
  const jobs = new EvalJobs({ store, config, now: () => NOW, baseline: trials });
  const fake = {
    mining: waitingMining(), grader: options.grader ?? "not-configured" as GraderState,
    graderVersion: options.graderVersion ?? null, identity: options.identity ?? "not-configured" as EvalIdentityState,
  };
  const api: EvalHostApi = {
    summary: async projectId => {
      const project = config.projects.find(item => item.id === projectId);
      if (project === undefined) return { status: 404, code: "unknown-project" };
      // The host's own count: trials a project started since 00:00 UTC of today, and the cap the project sets.
      const today = store.read(db => trialsSince(db, projectId, `${NOW.slice(0, 10)}T00:00:00.000Z`));
      return evalSummary(store, {
        project, mining: fake.mining, grader: fake.grader, graderVersion: fake.graderVersion, evalIdentity: fake.identity,
        trials: { today, dailyCap: project.team?.eval?.trialsPerDay ?? null }, jobs: jobs.projectJobs(projectId, SUMMARY_JOBS), now: NOW,
      });
    },
    jobs: () => jobs.list(),
    job: jobId => jobs.view(jobId) ?? { status: 404, code: "unknown-job" },
    // The host sends a baseline job to TrialJobs and a validate job to EvalJobs.
    create: (projectId, request, requestId) => request.kind === "baseline"
      ? trials.create(projectId, request, requestId)
      : request.kind === "validate" ? jobs.create(projectId, request, requestId) : { status: 400, code: "invalid-eval-request" },
    report: () => ({ status: 404, code: "no-report" }),
    priors: () => ({ status: 404, code: "unknown-project" }),
    control: (jobId, action) => jobs.control(jobId, action),
    retire: taskId => retireOwned(store, taskId),
  };
  return {
    store, api, mining: fake.mining, grader: fake.grader, cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Retires a candidate or valid task. Any other state refuses with `task-not-active`. */
function retireOwned(store: EvidenceStore, taskId: string): { taskId: string; state: "retired" } | EvalRefusal {
  const row = store.read(db => readEvalTask(db, taskId));
  if (row === undefined) return { status: 404, code: "unknown-task" };
  if (row.state !== "candidate" && row.state !== "valid") return { status: 409, code: "task-not-active" };
  store.write(tx => retireTask(tx, taskId, "owner-retired", NOW));
  return { taskId, state: "retired" };
}

function waitingMining(): MiningStatus {
  return { state: "waiting", visited: null, mined: null, skipped: null, failures: null, backfillDone: null };
}

function startOf(runId: string, projectId = PROJECT): CaptureStart {
  return {
    runId, memberId: MEMBER, projectId, workspace: "/unused/workspace", anchorCommit: ANCHOR,
    memberBaseCommit: MEMBER_BASE, commit: COMMIT, integratedHead: HEAD, at: CAPTURED_AT, uiChanges: false, capsule: CAPSULE,
  };
}

/** A captured row with stored material on `files`, as the capture service writes it. Returns its task id. */
function captureRow(tx: EvidenceTx, runId: string, files: string[], capsule: Capsule = CAPSULE, projectId = PROJECT): string {
  const taskId = capturedTaskId(runId, MEMBER);
  insertMarker(tx, startOf(runId, projectId), { state: "captured", capsule }, CAPTURED_AT);
  completeMaterial(tx, taskId, {
    kind: "store", files, hiddenFiles: [], baseDelta: { state: "none" },
    reference: { state: "stored", bytes: Buffer.from("patch") }, base: "proven",
  }, CAPTURED_AT);
  return taskId;
}

/**
 * Sets a row's state and area the way promotion does. The routes read these two columns, and this test does not run the
 * promotion or the validator.
 */
function setRow(tx: EvidenceTx, taskId: string, state: string, area: string): string {
  tx.run("UPDATE eval_tasks SET state = ?, area_ref = ? WHERE task_id = ?", state, tx.index("area", area), taskId);
  return taskId;
}

/** One ledger row of an accepted implementer attempt on the project, as the outcome ledger writes it. */
function acceptedRow(id: string, projectId = PROJECT): OutcomeRow {
  return {
    outcomeId: `${id}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: id, revision: 1, memberId: "m1",
    sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "astra-xhigh", provider: "codex",
    model: "model-x", effort: "xhigh", profileEpoch: 1, configId: null, experimentRef: null, kind: null, risk: "normal",
    featureVersion: 1, disposition: "integrated", exclusion: null, flags: [], integrated: 1, accepted: 1, acceptance: 1,
    firstPass: 1, held: 1, startedAt: LEDGER_AT, endedAt: LEDGER_AT, frozenAt: LEDGER_AT, holdUntil: null, runDeletedAt: null,
    payload: { projectId, taskId: `task-${id}`, area: "host/", featureMap: "default", rounds: { run: 1, attributed: 1, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
  } as OutcomeRow;
}

const readGuard: express.RequestHandler = (req, res, next) => READ_ROLES.includes(String(req.header("x-role")))
  ? next()
  : void res.status(401).json({ code: "unauthorized" });
const ownerGuard: express.RequestHandler = (req, res, next) => req.header("x-role") === "owner"
  ? next()
  : void res.status(403).json({ code: "forbidden" });

async function serve(api: EvalHostApi): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  evalRoutes(app, { host: api }, readGuard, ownerGuard);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function call(base: string, method: string, path: string, role: string | undefined, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (role !== undefined) headers["x-role"] = role;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) };
}

const validJob = () => ({ projectId: PROJECT, requestId: REQUEST, job: JOB });

test("the summary counts every state and keeps unknowns unknown", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    f.store.write(tx => {
      captureRow(tx, "run-a", ["tests/a.test.ts"]);
      setRow(tx, captureRow(tx, "run-b", ["tests/b.test.ts"]), "candidate", "host");
      setRow(tx, captureRow(tx, "run-c", ["tests/c.test.ts"]), "valid", "host");
      setRow(tx, captureRow(tx, "run-d", ["tests/d.test.ts"]), "candidate", "web");
      setRow(tx, captureRow(tx, "run-e", ["tests/e.test.ts"]), "candidate", "mixed");
      setRow(tx, captureRow(tx, "run-f", ["tests/f.test.ts"]), "candidate", "root");
      insertMined(tx, {
        kind: "candidate", projectId: PROJECT, commit: MINED_COMMIT, parent: ANCHOR, commitTime: CAPTURED_AT, capsule: CAPSULE,
        promptOrigin: "commit-message", files: ["packages/host/src/a.ts"], hiddenFiles: [], features: FEATURES,
      }, NOW);
      insertMined(tx, { kind: "rejected", projectId: PROJECT, commit: REJECTED_COMMIT, reason: "too-large" }, NOW);
    });

    const first = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(first.status, 200);
    const summary = first.body;
    assert.deepEqual(summary.tasks.byState, { captured: 1, candidate: 5, valid: 1, rejected: 1, retired: 0 });
    assert.deepEqual(summary.tasks.byOrigin.captured, { captured: 1, candidate: 4, valid: 1, rejected: 0, retired: 0 });
    assert.deepEqual(summary.tasks.byOrigin.mined, { captured: 0, candidate: 1, valid: 0, rejected: 1, retired: 0 });
    // The built-in names `mixed` and `root` keep their names; a reference the map does not define counts as `other`.
    assert.deepEqual(summary.tasks.byArea, [
      { area: "host", candidate: 2, valid: 1 },
      { area: "mixed", candidate: 1, valid: 0 },
      { area: "other", candidate: 1, valid: 0 },
      { area: "root", candidate: 1, valid: 0 },
    ]);
    assert.equal(summary.tasks.bySet, null);
    const expectedGroups = f.store.read(db => groupStats(db, db.index("project", PROJECT)));
    assert.deepEqual(summary.groups, { ...expectedGroups, holdout: 0, exposed: 0 });
    assert.equal(summary.capture.on, true);
    assert.equal(summary.mining.on, true);
    assert.equal(summary.mining.visited, null, "no mining row: visited is unknown, never 0");
    assert.equal(summary.coverage, null, "no ledger rows: coverage is unknown");
    assert.equal(summary.grader.state, "not-configured");
    assert.deepEqual(summary.jobs, []);

    for (let i = 0; i < 4; i++) f.store.write(tx => writeOutcome(tx, acceptedRow(`ledger-${i}`)));
    const second = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(second.status, 200);
    assert.equal(second.body.coverage.accepted, 4);
    assert.equal(second.body.coverage.validCaptured, 1);
    assert.ok(Math.abs(second.body.coverage.share - 0.25) < 1e-9, `share ${second.body.coverage.share}`);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("the summary bounds areas, the window, and mining", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    f.store.write(tx => {
      WIDE_AREAS.forEach((area, index) => {
        setRow(tx, captureRow(tx, `wide-${index}`, [`tests/w${index}.test.ts`], CAPSULE, PROJECT_WIDE), "candidate", area);
      });
      // A valid captured task captured in 2020, before the 730-day window, so it must not count as valid captured.
      const old = setRow(tx, captureRow(tx, "wide-old", ["tests/old.test.ts"], CAPSULE, PROJECT_WIDE), "valid", "area-00");
      tx.run("UPDATE eval_tasks SET captured_at = ? WHERE task_id = ?", "2020-01-01T00:00:00.000Z", old);
    });
    f.store.write(tx => writeOutcome(tx, acceptedRow("wide-ledger", PROJECT_WIDE)));

    const reply = await call(server.base, "GET", `/api/eval/projects/${PROJECT_WIDE}`, "viewer");
    assert.equal(reply.status, 200);
    const summary = reply.body;
    assert.equal(summary.mining.on, false, "a project without a mine setting reports mining off");
    const byArea: { area: string; candidate: number; valid: number }[] = summary.tasks.byArea;
    assert.equal(byArea.length, 64, "at most 64 areas");
    const names = byArea.map(row => row.area);
    assert.ok(names.includes("area-62") && !names.includes("area-63"), "the first 63 names stay and the rest fold");
    assert.deepEqual(byArea.find(row => row.area === "other"), { area: "other", candidate: 7, valid: 0 });
    assert.equal(byArea.reduce((sum, row) => sum + row.candidate, 0), 70, "no candidate is lost in the fold");
    assert.equal(summary.coverage.days, 730, "a retention above 730 days is capped at 730");
    assert.equal(summary.coverage.accepted, 1);
    assert.equal(summary.coverage.validCaptured, 0, "a valid captured task outside the window does not count");
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("coverage is unknown without a readable ledger", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    for (let i = 0; i < 4; i++) f.store.write(tx => writeOutcome(tx, acceptedRow(`ledger-${i}`)));
    const before = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(before.body.coverage.accepted, 4);
    f.store.write(tx => tx.run("UPDATE outcomes SET payload = ? WHERE outcome_id = ?", "not sealed", "ledger-0:m1"));
    const after = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(after.status, 200);
    assert.equal(after.body.coverage, null, "an unreadable ledger row makes the share unknown, though attempts are accepted");
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("coverage is unknown without the outcome ledger", async () => {
  const f = fixture({ outcomes: false });
  const server = await serve(f.api);
  try {
    const reply = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(reply.status, 200, "the summary still answers without the ledger");
    assert.equal(reply.body.coverage, null);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("the summary answers 503 when the corpus module is not ready", async () => {
  const f = fixture({ rollback: true });
  assert.equal(f.store.status().modules[EVAL_MODULE], "unavailable");
  const server = await serve(f.api);
  try {
    const reply = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(reply.status, 503);
    assert.equal(reply.body.code, "evidence-unavailable");
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("only the owner changes a job", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    f.store.write(tx => insertMined(tx, { kind: "rejected", projectId: PROJECT, commit: REJECTED_COMMIT, reason: "too-large" }, NOW));
    const rejected = f.store.read(db => minedTaskId(db.index("project", PROJECT), db.index("eval-commit", REJECTED_COMMIT)));

    assert.equal((await call(server.base, "GET", "/api/eval/jobs", "viewer")).status, 200);
    assert.equal((await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "controller")).status, 200);
    assert.equal((await call(server.base, "POST", "/api/eval/jobs", "viewer", validJob())).status, 403);
    assert.equal((await call(server.base, "POST", "/api/eval/jobs", "controller", validJob())).status, 403);
    assert.equal((await call(server.base, "POST", `/api/eval/tasks/${rejected}/retire`, "viewer")).status, 403);

    const created = await call(server.base, "POST", "/api/eval/jobs", "owner", validJob());
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    const jobId = created.body.job.jobId;
    const again = await call(server.base, "POST", "/api/eval/jobs", "owner", validJob());
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.job.jobId, jobId);
    const conflict = await call(server.base, "POST", "/api/eval/jobs", "owner", { ...validJob(), requestId: REQUEST_OTHER });
    assert.equal(conflict.status, 409, "a second request while the project holds a job is refused");
    assert.equal(conflict.body.code, "job-active");

    assert.equal((await call(server.base, "POST", `/api/eval/jobs/${jobId}/pause`, "controller")).status, 403);
    const paused = await call(server.base, "POST", `/api/eval/jobs/${jobId}/pause`, "owner");
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, "paused");
    assert.equal((await call(server.base, "POST", `/api/eval/jobs/${jobId}/resume`, "owner")).status, 200);
    assert.equal((await call(server.base, "POST", `/api/eval/jobs/${jobId}/cancel`, "owner")).status, 200);
    const twice = await call(server.base, "POST", `/api/eval/jobs/${jobId}/cancel`, "owner");
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, "invalid-job-transition");

    const notActive = await call(server.base, "POST", `/api/eval/tasks/${rejected}/retire`, "owner");
    assert.equal(notActive.status, 409);
    assert.equal(notActive.body.code, "task-not-active");

    const unknownProject = await call(server.base, "POST", "/api/eval/jobs", "owner", { ...validJob(), projectId: "no-such-project", requestId: randomUUID() });
    assert.equal(unknownProject.status, 404);
    assert.equal(unknownProject.body.code, "unknown-project");
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("no route answers with text from the corpus", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    const objective = "Objective-7f3a";
    const file = "secret-name";
    f.store.write(tx => {
      setRow(tx, captureRow(tx, "run-secret", [file], { ...CAPSULE, objective }), "candidate", "host");
    });
    const created = await call(server.base, "POST", "/api/eval/jobs", "owner", validJob());
    assert.equal(created.status, 201);
    const replies = [
      await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "owner"),
      await call(server.base, "GET", "/api/eval/jobs", "owner"),
      await call(server.base, "GET", `/api/eval/jobs/${created.body.job.jobId}`, "owner"),
      created,
    ];
    for (const reply of replies) {
      for (const needle of [objective, file, COMMIT]) {
        assert.ok(!reply.text.includes(needle), `a route answer holds corpus text of ${needle.length} characters`);
      }
    }
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("an unavailable store answers 503", async () => {
  const f = fixture({ damaged: true });
  assert.equal(f.store.status().state, "unavailable");
  const server = await serve(f.api);
  try {
    const jobId = randomUUID();
    const taskId = capturedTaskId("run-missing", MEMBER);
    const replies = [
      await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer"),
      await call(server.base, "GET", "/api/eval/jobs", "viewer"),
      await call(server.base, "GET", `/api/eval/jobs/${jobId}`, "viewer"),
      await call(server.base, "POST", "/api/eval/jobs", "owner", validJob()),
      await call(server.base, "POST", `/api/eval/jobs/${jobId}/pause`, "owner"),
      await call(server.base, "POST", `/api/eval/tasks/${taskId}/retire`, "owner"),
    ];
    for (const reply of replies) {
      assert.equal(reply.status, 503);
      assert.equal(reply.body.code, "evidence-unavailable");
    }
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("a body or id that does not parse answers 400", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    const bad = [
      await call(server.base, "POST", "/api/eval/jobs", "owner", { ...validJob(), requestId: "not-a-uuid" }),
      await call(server.base, "POST", "/api/eval/jobs", "owner", { ...validJob(), extra: true }),
      await call(server.base, "POST", "/api/eval/jobs", "owner", { projectId: PROJECT, requestId: REQUEST, job: "text" }),
      await call(server.base, "GET", "/api/eval/jobs/not-a-uuid", "viewer"),
      await call(server.base, "POST", "/api/eval/tasks/nope/retire", "owner"),
    ];
    for (const reply of bad) {
      assert.equal(reply.status, 400);
      assert.equal(reply.body.code, "invalid-eval-request");
    }
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("the hot statements read through an index", () => {
  const f = fixture();
  try {
    const since = "2026-11-01T00:00:00.000Z";
    const cases = [
      { name: "STATE_COUNTS_SQL", sql: STATE_COUNTS_SQL, params: [PROJECT], indexes: ["eval_tasks_summary"] },
      { name: "AREA_COUNTS_SQL", sql: AREA_COUNTS_SQL, params: [PROJECT], indexes: ["eval_tasks_summary"] },
      { name: "VALID_CAPTURED_SQL", sql: VALID_CAPTURED_SQL, params: [PROJECT, since], indexes: ["eval_tasks_summary", "eval_tasks_project"] },
    ];
    for (const item of cases) {
      const details = f.store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.params))
        .map(row => row.detail);
      assert.ok(
        details.some(detail => detail.startsWith("SEARCH ") && item.indexes.some(index => detail.includes(index))),
        `${item.name} plan: ${details.join(" | ")}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("the summary shows the eval identity and today's trials", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    const jobId = randomUUID();
    const seed = (trialId: string, slot: number, at: string) => f.store.write(tx => insertTrial(tx, {
      trialId, jobId, taskId: capturedTaskId("run-trial-day", MEMBER), projectId: PROJECT, configuration: TRIAL_CONFIGURATION,
      harness: 1, slot, attempt: 1, keepDays: 365,
    }, at));
    seed(randomUUID(), 0, NOW);
    seed(randomUUID(), 1, NOW);
    // Yesterday, before 00:00 UTC of today: not counted.
    seed(randomUUID(), 2, "2026-11-15T23:00:00.000Z");

    const first = await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
    assert.equal(first.status, 200);
    assert.equal(first.body.evalIdentity.state, "not-configured", "without eval.member the identity is not configured");
    assert.equal(first.body.trials.today, 2, "two trials started today");
    assert.equal(first.body.trials.dailyCap, TRIALS_PER_DAY, "the project's cap");
    assert.equal(first.body.grader.version, null, "no probe has answered a version");

    const wide = await call(server.base, "GET", `/api/eval/projects/${PROJECT_WIDE}`, "viewer");
    assert.equal(wide.body.trials.dailyCap, null, "without trialsPerDay the cap is unknown, and the line says trials off");

    const probed = fixture({ grader: "ready", graderVersion: 1, identity: "busy" });
    const probedServer = await serve(probed.api);
    try {
      const reply = await call(probedServer.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer");
      assert.equal(reply.body.evalIdentity.state, "busy");
      assert.equal(reply.body.grader.state, "ready");
      assert.equal(reply.body.grader.version, 1, "a version 1 grader is reported as version 1");
    } finally {
      await probedServer.close();
      probed.cleanup();
    }
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("a baseline job is created and listed", async () => {
  const f = fixture();
  const server = await serve(f.api);
  try {
    const objective = "Objective-trial-5d8e";
    const file = "tests/trial-file-9a1c.test.ts";
    const trialId = randomUUID();
    const sessionId = randomUUID();
    f.store.write(tx => setRow(tx, captureRow(tx, "run-trial", [file], { ...CAPSULE, objective }), "valid", "host"));

    const created = await call(server.base, "POST", "/api/eval/jobs", "owner", { projectId: PROJECT, requestId: REQUEST, job: BASELINE_JOB });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.job.kind, "baseline");
    assert.equal(created.body.job.tasks.planned, 1);
    assert.equal(created.body.job.trials.planned, 3, "one task, one configuration, three trials per task");
    assert.equal(created.body.job.dailyCap, TRIALS_PER_DAY);
    const jobId: string = created.body.job.jobId;
    const again = await call(server.base, "POST", "/api/eval/jobs", "owner", { projectId: PROJECT, requestId: REQUEST, job: BASELINE_JOB });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.job.jobId, jobId);

    // A trial the baseline job started, with a session and a patch held in the sealed store.
    f.store.write(tx => {
      insertTrial(tx, {
        trialId, jobId, taskId: capturedTaskId("run-trial", MEMBER), projectId: PROJECT, configuration: TRIAL_CONFIGURATION,
        harness: 1, slot: 0, attempt: 1, keepDays: 365,
      }, NOW);
      tx.run("UPDATE eval_trials SET session_id = ? WHERE trial_id = ?", sessionId, trialId);
      tx.run("INSERT INTO eval_trial_patches (trial_id, bytes, stored_at, expires_at, payload) VALUES (?, ?, ?, ?, ?)",
        trialId, PATCH_TEXT.length, NOW, "2026-12-16T12:00:00.000Z", tx.seal("eval_trial_patches", trialId, { patch: PATCH_TEXT }));
    });

    const listed = await call(server.base, "GET", "/api/eval/jobs", "viewer");
    assert.equal(listed.status, 200);
    const row = listed.body.find((item: { jobId: string }) => item.jobId === jobId);
    assert.ok(row, "the job is listed");
    assert.equal(row.kind, "baseline");
    assert.equal(row.tasks.planned, 1);
    assert.equal(row.trials.started, 0, "a row with no start counts nothing");
    assert.equal(row.trials.planned, 3);

    assert.equal((await call(server.base, "POST", "/api/eval/jobs", "viewer", { projectId: PROJECT, requestId: REQUEST_OTHER, job: BASELINE_JOB })).status, 403);

    const replies = [created, again, listed, await call(server.base, "GET", `/api/eval/jobs/${jobId}`, "viewer"),
      await call(server.base, "GET", `/api/eval/projects/${PROJECT}`, "viewer")];
    for (const reply of replies) {
      for (const needle of [objective, file, COMMIT, trialId, sessionId, PATCH_TEXT, MODEL]) {
        assert.ok(!reply.text.includes(needle), `a baseline route answer holds a sealed value of ${needle.length} characters`);
      }
    }
  } finally {
    await server.close();
    f.cleanup();
  }
});
