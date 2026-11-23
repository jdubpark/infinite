import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { EvalIdentity, EvalProbe } from "../packages/host/src/eval-identity.js";
import type { Grader } from "../packages/host/src/eval-grader.js";
import type { TrialGrade } from "../packages/host/src/eval-types.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { TrialJobs } from "../packages/host/src/eval-trial-jobs.js";
import { TrialPump, type TrialPumpOptions, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import { EVAL_TRIALS_MODULE, evalTrialsModule, finishTrial, insertTrial, startTrial } from "../packages/host/src/eval-trial-store.js";
import { ComparisonPass } from "../packages/host/src/eval-comparison.js";
import { EvalJobs } from "../packages/host/src/eval-jobs.js";
import { EvalHost } from "../packages/host/src/eval-host.js";
import type { CostLookup } from "../packages/host/src/outcome-cells.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";

// The trial pump over small fakes: a real store and a real TrialJobs, a recording identity, and no member. The end-to-end
// behaviour lives in eval-trial-run.test.ts.

const PROJECT = "project-pump-1";
const TASK = "captured:run-1:t01";
const CLAUDE: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const LINEUP = { coordinator: CLAUDE, integrator: CLAUDE, reviewer: CLAUDE, implementers: [CLAUDE], escalations: [], fallbacks: [] };
const READY: EvalProbe = { state: "ready", uid: 5001, storage: true, fetch: "refused" };
const FOCUSED = { command: "node", args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"] };
const VOID_GRADE: TrialGrade = { ending: "void-host", expectedPassed: null, expectedTotal: 0, guardPassed: null, resolved: false, overwritten: 0, diff: null, isolation: "none" };
const dirs: string[] = [];

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Probe = Parameters<EvalIdentity["probe"]>[0];

/** The pump with no member and a source whose `status` has no mirror head, so no trial can start. Every call is logged. */
function rig(options: { removeRefused?: boolean; baseBranch?: string; probes?: EvalProbe[]; sessionsRemoved?: string[]; forgetThrows?: boolean; replayIds?: string[];
  replayState?: (trialId: string) => Promise<unknown>; onStatus?: () => void; cost?: CostLookup; clock?: () => string; trialsNewer?: boolean; alive?: boolean;
  /** The mirror head the scripted source status reports; without it the project has no mirror yet. */
  mirrorHead?: string; prepareSource?: TrialPumpOptions["prepareSource"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "infinite-trial-pump-"));
  dirs.push(root);
  const vaultKey = randomBytes(32);
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const now = options.clock ?? (() => new Date().toISOString());
  if (options.trialsNewer) {
    // A stored trials version one above the code's makes that module unavailable, as in evidence-store.test.ts.
    const first = new EvidenceStore({ databasePath, vaultKey });
    first.register(evalCorpusModule(first, now));
    const trials = evalTrialsModule(first, now);
    first.register({ ...trials, version: trials.version + 1, readVersion: trials.version + 1 });
    first.close();
  }
  const store = new EvidenceStore({ databasePath, vaultKey });
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  const config = {
    projects: [{ id: PROJECT, name: PROJECT, path: "/srv/unused",
      source: { mode: "github", repository: "example/app", ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}) },
      team: { eval: { mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 100 } } }],
    stateDir: join(root, "state"), runDir: join(root, "runs"), keyFile: join(root, "vault.key"), maxSessions: 16,
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-eval", agents: { claude: { command: "claude", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;
  const log: string[] = [];
  const probeInputs: Probe[] = [];
  const probes = [...(options.probes ?? [])];
  const identity = {
    probe: async (input: Probe) => { log.push("probe"); probeInputs.push(input); return probes.shift() ?? READY; },
    receive: async () => "failed", prepare: async () => "failed", check: async () => "failed",
    teamPrefix: () => undefined, setupPrefix: () => undefined,
    stop: async () => { log.push("stop"); return true; },
    clean: async () => { log.push("clean"); return true; },
    scrub: async () => { log.push("scrub"); return true; },
  } as unknown as EvalIdentity;
  const grader = { clean: async () => true } as unknown as Grader;
  const forgotten: string[] = [];
  const teams: TrialTeams = {
    createForReplay: async () => { throw new Error("no member in this test"); },
    replayState: async (trialId: string) => options.replayState?.(trialId),
    endReplay: async () => undefined,
    forgetReplay: async trialId => {
      forgotten.push(trialId);
      if (options.forgetThrows) throw new Error("forget failed");
      return true;
    },
    replayIds: () => { log.push("replayIds"); return options.replayIds ?? []; },
    providerLimits: () => [],
  } as unknown as TrialTeams;
  const sessionsRemoved = options.sessionsRemoved ?? [];
  const jobs = new TrialJobs({ store, config, now });
  const pump = new TrialPump({
    config, store, jobs, grader, identity, teams: () => teams,
    sessions: { list: async () => [], remove: async (id: string) => { sessionsRemoved.push(id); if (options.removeRefused) throw new Error("refused"); } } as never,
    ...(options.cost ? { cost: options.cost } : {}),
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => { log.push("status"); options.onStatus?.(); return { mode: "github", repository: "example/app", baseBranch: "main", ...(options.mirrorHead ? { mirrorHead: options.mirrorHead } : {}) } as never; } },
    ...(options.prepareSource ? { prepareSource: options.prepareSource } : {}),
    hostLoad: { held: () => undefined }, halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }), inventory: async () => options.alive ? [{ ruid: 5001, euid: 5001, state: "S" } as never] : [], now,
  });
  const addJob = () => {
    const at = now();
    store.write(tx => {
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
        + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
        + "VALUES (?, 'captured', 'run-1', 'member-1', ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, 'run:run-1', 'host', ?)",
        TASK, tx.index("project", PROJECT), at, at, tx.seal("eval_tasks", TASK, { projectId: PROJECT }), at);
    });
    const created = jobs.create(PROJECT, {
      kind: "baseline", configurations: [{ profile: CLAUDE, guidance: "as-of-base", knowledge: "none" }],
      limits: { maxTrials: 10, maxWallMinutes: 600 },
    }, randomUUID());
    assert.ok("job" in created, "the baseline job is created");
    return created.job.jobId;
  };
  const seed = (jobId: string, slot: number, state: "preparing" | "running"): string => {
    const trialId = randomUUID();
    const configuration = { profile: CLAUDE, guidance: "as-of-base" as const, knowledge: "none" as const };
    store.write(tx => {
      insertTrial(tx, { trialId, jobId, taskId: TASK, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot, attempt: 0,
        projectId: PROJECT, configuration, keepDays: 365 }, now());
      if (state === "running") startTrial(tx, trialId, now());
    });
    return trialId;
  };
  return { store, config, pump, log, root, now, jobs, seed, probeInputs, sessionsRemoved, forgotten, addJob, cleanup: () => store.close() };
}

test("a source that cannot start does not make a hot loop", async () => {
  // The project has no base branch, so the trial's context is never built.
  const r = rig();
  try {
    r.addJob();
    for (let step = 0; step < 3; step++) await r.pump.step();
    const attempts = r.log.filter(entry => entry === "status").length;
    assert.ok(attempts >= 1, "the pump tried the source");
    assert.ok(attempts <= 2, `three steps make at most two source attempts, made ${attempts}`);
  } finally {
    r.cleanup();
  }
});

test("a start-up with an unavailable identity runs again, and stops and cleans before any trial command", async () => {
  const r = rig({ probes: [{ state: "unavailable" }] });
  try {
    r.addJob();
    await r.pump.step();
    assert.deepEqual(r.log.filter(entry => entry !== "probe"), [], "an identity that cannot be probed is not stopped or cleaned, and no trial command runs");
    await r.pump.step();
    const first = r.log.indexOf("status");
    for (const op of ["stop", "clean", "scrub"]) {
      const at = r.log.indexOf(op);
      assert.ok(at >= 0, `${op} ran`);
      assert.ok(first === -1 || at < first, `${op} ran before the first trial command; log: ${r.log.join(",")}`);
    }
  } finally {
    r.cleanup();
  }
});

test("the identity probe is keyed by project", async () => {
  const r = rig();
  try {
    // The job is cancelled while a trial row lives, so the start-up probe names no project.
    const jobId = r.addJob();
    r.seed(jobId, 0, "running");
    r.store.write(tx => tx.run("UPDATE eval_jobs SET status = 'cancelled' WHERE job_id = ?", jobId));
    await r.pump.step();
    assert.equal(r.probeInputs.length, 1, "the start-up probe");
    assert.equal(r.probeInputs[0].fetchUrl, undefined, "the start-up probe fetches no repository");
    r.store.write(tx => tx.run("UPDATE eval_jobs SET status = 'scheduled' WHERE job_id = ?", jobId));
    await r.pump.step();
    assert.equal(r.probeInputs.length, 2, "the trial's project is probed again");
    assert.ok(r.probeInputs[1].fetchUrl?.includes("example/app"), "the second probe names the project's repository");
  } finally {
    r.cleanup();
  }
});

test("start-up probes once, not on every step, while no trial job is open", async () => {
  const r = rig({ probes: [{ state: "unavailable" }, { state: "unavailable" }, { state: "unavailable" }] });
  try {
    for (let step = 0; step < 3; step++) await r.pump.step();
    assert.equal(r.probeInputs.length, 1, "one probe for the first start-up");
    r.addJob();
    await r.pump.step();
    assert.equal(r.probeInputs.length, 2, "the start-up runs again when the first job opens");
  } finally {
    r.cleanup();
  }
});

test("a start-up that voided rows is retried until the account is clean", async () => {
  const r = rig({ probes: [{ state: "unavailable" }, READY] });
  try {
    const jobId = r.addJob();
    r.seed(jobId, 0, "running");
    r.store.write(tx => tx.run("UPDATE eval_jobs SET status = 'cancelled' WHERE job_id = ?", jobId));
    await r.pump.step();
    assert.equal(r.probeInputs.length, 1, "the first start-up probes and fails");
    await r.pump.step();
    assert.equal(r.probeInputs.length, 2, "the next step probes again");
    assert.ok(r.log.includes("stop"), "stop ran");
    assert.ok(r.log.includes("clean"), "clean ran");
  } finally {
    r.cleanup();
  }
});

test("a start-up whose stop leaves processes alive is tried again without an open job", async () => {
  // What a restart finds after a trial left processes alive and blocked its job: no live row, no open job, and an account that is not clean.
  const r = rig({ alive: true });
  try {
    const stops = () => r.log.filter(entry => entry === "stop").length;
    await r.pump.step();
    const first = stops();
    assert.ok(first > 0, "the first start-up tried the stop");
    await r.pump.step();
    assert.ok(stops() > first, "the next step tries the stop again, with no job open");
  } finally {
    r.cleanup();
  }
});

test("live rows without an open job still get the start-up", async () => {
  const r = rig();
  try {
    const jobId = r.addJob();
    const trialId = r.seed(jobId, 0, "running");
    r.store.write(tx => tx.run("UPDATE eval_jobs SET status = 'cancelled' WHERE job_id = ?", jobId));
    await r.pump.step();
    const row = r.store.read(db => db.get<{ state: string; ending: string | null }>("SELECT state, ending FROM eval_trials WHERE trial_id = ?", trialId));
    assert.equal(row?.state, "final");
    assert.equal(row?.ending, "void-host");
    assert.equal(r.probeInputs.length, 1, "the account is probed");
  } finally {
    r.cleanup();
  }
});

test("the pump starts nothing while the trials module is not ready", async () => {
  const r = rig({ trialsNewer: true });
  try {
    assert.equal(r.store.status().modules[EVAL_TRIALS_MODULE], "unavailable");
    r.addJob();
    for (let step = 0; step < 2; step++) await r.pump.step();
    assert.equal(r.probeInputs.length, 0, "no probe");
    assert.equal(r.log.filter(entry => entry === "status").length, 0, "no trial start");
  } finally {
    r.cleanup();
  }
});

test("the sweep does nothing while the trials module is not ready", async () => {
  const r = rig({ trialsNewer: true, replayIds: [randomUUID()] });
  try {
    await r.pump.sweep();
    assert.equal(r.log.includes("replayIds"), false, "the teams fake was not asked");
  } finally {
    r.cleanup();
  }
});

test("a baseline create answers evidence-unavailable while the trials module is not ready", async () => {
  const r = rig();
  r.cleanup();
  const root = mkdtempSync(join(tmpdir(), "infinite-trial-host-"));
  dirs.push(root);
  const vaultKey = randomBytes(32);
  const databasePath = evidenceDatabasePath(join(root, "state"));
  const now = () => new Date().toISOString();
  // A stored trials version one above the code's makes that module unavailable, as in evidence-store.test.ts.
  const first = new EvidenceStore({ databasePath, vaultKey });
  const trials = evalTrialsModule(first, now);
  first.register({ ...trials, version: trials.version + 1, readVersion: trials.version + 1 });
  first.close();
  const store = new EvidenceStore({ databasePath, vaultKey });
  try {
    const host = new EvalHost({
      config: r.config, store, source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main" }) as never },
      hostLoad: { held: () => undefined }, halt: () => ({ check: () => ({ state: "clear" as const }) }), runs: () => [], now,
    });
    assert.equal(store.status().modules[EVAL_TRIALS_MODULE], "unavailable");
    const baseline = host.create(PROJECT, {
      kind: "baseline", configurations: [{ profile: CLAUDE, guidance: "as-of-base", knowledge: "none" }],
      limits: { maxTrials: 10, maxWallMinutes: 600 },
    } as never, randomUUID());
    assert.equal((baseline as { status?: number }).status, 503);
    assert.equal((baseline as { code?: string }).code, "evidence-unavailable");
    const validate = host.create(PROJECT, { kind: "validate", limits: { maxWallMinutes: 10 } } as never, randomUUID());
    assert.ok("job" in validate, `a validate create still creates a job: ${JSON.stringify(validate).slice(0, 200)}`);
    host.close();
  } finally {
    store.close();
  }
});

test("start-up blocks the open job when the account's processes stay alive", async () => {
  const r = rig({ alive: true });
  try {
    const jobId = r.addJob();
    await r.pump.step();
    const job = r.store.read(db => db.get<{ status: string; reason: string | null }>("SELECT status, reason FROM eval_jobs WHERE job_id = ?", jobId));
    assert.equal(job?.status, "blocked");
    assert.equal(job?.reason, "eval-processes-alive");
    const n = r.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_trials"))?.n;
    assert.equal(n, 0, "no trial row");
    // The account is not clean, so the stop is tried again on each step (one a minute on a host) while the job stays blocked.
    const stops = r.log.filter(entry => entry === "stop").length;
    await r.pump.step();
    assert.ok(r.log.filter(entry => entry === "stop").length > stops, "the next step tries the stop again");
    const after = r.store.read(db => db.get<{ status: string; reason: string | null }>("SELECT status, reason FROM eval_jobs WHERE job_id = ?", jobId));
    assert.equal(after?.status, "blocked", "the job stays blocked until the owner resumes it");
    assert.equal(after?.reason, "eval-processes-alive");
  } finally {
    r.cleanup();
  }
});

test("a sweep that meets a failed removal still removes the due sessions", async () => {
  const trialId = randomUUID();
  const r = rig({ forgetThrows: true, replayIds: [trialId] });
  try {
    r.addJob();
    const jobId = r.store.read(db => db.get<{ job_id: string }>("SELECT job_id FROM eval_jobs"))?.job_id as string;
    const long = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const configuration = { profile: CLAUDE, guidance: "as-of-base" as const, knowledge: "none" as const };
    r.store.write(tx => {
      insertTrial(tx, { trialId, jobId, taskId: TASK, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: 0, attempt: 0,
        projectId: PROJECT, configuration, keepDays: 365 }, long);
      startTrial(tx, trialId, long);
      finishTrial(tx, trialId, { grade: VOID_GRADE, configId: null, profileEpoch: null, sessionId: "session-due", patchKeepDays: 90 }, long);
    });
    // The run of the final trial remains, and forgetting it fails.
    await r.pump.sweep();
    assert.deepEqual(r.sessionsRemoved, ["session-due"], "the due session is removed in the same sweep");
    assert.ok(r.forgotten.includes(trialId), "the failing forget was attempted");
  } finally {
    r.cleanup();
  }
});

test("a session whose removal is refused keeps its place for the next sweep", async () => {
  const r = rig({ removeRefused: true });
  try {
    const jobId = r.addJob(), trialId = r.seed(jobId, 0, "running");
    const long = new Date(Date.now() - 2 * 3_600_000).toISOString();
    r.store.write(tx => finishTrial(tx, trialId, { grade: VOID_GRADE, configId: null, profileEpoch: null, sessionId: "session-kept", patchKeepDays: 90 }, long));
    await r.pump.sweep();
    assert.deepEqual(r.sessionsRemoved, ["session-kept"], "the removal was tried");
    const row = r.store.read(db => db.get<{ session_id: string | null }>("SELECT session_id FROM eval_trials WHERE trial_id = ?", trialId));
    assert.equal(row?.session_id, "session-kept", "a refused removal leaves the session on the row");
  } finally {
    r.cleanup();
  }
});

test("start-up voids every running trial and the job records the streak", async () => {
  const r = rig();
  try {
    const jobId = r.addJob();
    const ids = [0, 1, 2].map(slot => r.seed(jobId, slot, "running"));
    await r.pump.step();
    for (const id of ids) {
      const row = r.store.read(db => db.get<{ state: string; ending: string | null }>("SELECT state, ending FROM eval_trials WHERE trial_id = ?", id));
      assert.deepEqual({ ...row }, { state: "final", ending: "void-host" });
    }
    const job = r.store.read(db => db.get<{ status: string; reason: string | null }>("SELECT status, reason FROM eval_jobs WHERE job_id = ?", jobId));
    assert.deepEqual({ ...job }, { status: "paused", reason: "trial-voids" }, "three voids in a row pause the job: the record was written");
  } finally {
    r.cleanup();
  }
});

test("start-up drops a preparing row, so its slot runs again as attempt 0, and keeps the voided trial's session", async () => {
  const seen: { slot: number; attempt: number }[] = [];
  let store: EvidenceStore | undefined;
  const r = rig({
    replayState: async () => ({ phase: "running", sessionId: "session-voided" }),
    onStatus: () => {
      const rows = store?.read(db => db.all<{ slot: number; attempt: number }>("SELECT slot, attempt FROM eval_trials WHERE state = 'preparing'")) ?? [];
      seen.push(...rows);
    },
  });
  store = r.store;
  try {
    const jobId = r.addJob();
    const preparing = r.seed(jobId, 0, "preparing");
    const running = r.seed(jobId, 1, "running");
    await r.pump.step();
    assert.equal(r.store.read(db => db.get("SELECT 1 FROM eval_trials WHERE trial_id = ?", preparing)), undefined, "the preparing row is gone");
    assert.deepEqual({ ...seen[0] }, { slot: 0, attempt: 0 }, "the slot starts again as attempt 0");
    const voided = r.store.read(db => db.get<{ ending: string | null; session_id: string | null }>("SELECT ending, session_id FROM eval_trials WHERE trial_id = ?", running));
    assert.equal(voided?.ending, "void-host");
    assert.equal(voided?.session_id, "session-voided", "the voided trial names its session, so the sweep removes it");
  } finally {
    r.cleanup();
  }
});

type CostRow = { session_id: string | null; tokens: number | null; spent_usd: number | null; cost: string | null };
const COST_SQL = "SELECT session_id, tokens, spent_usd, cost FROM eval_trials WHERE trial_id = ?";

function endedTrial(r: ReturnType<typeof rig>, sessionId: string, endedAt: string): string {
  const jobId = r.addJob();
  const trialId = r.seed(jobId, 0, "running");
  r.store.write(tx => finishTrial(tx, trialId, { grade: VOID_GRADE, configId: null, profileEpoch: null, sessionId, patchKeepDays: 90 }, endedAt));
  return trialId;
}

test("a session's cost is recorded before its removal", async () => {
  const order: string[] = [];
  const lookups: Record<string, { usd: number; tokens: number; complete: boolean } | undefined> = {
    "session-complete": { usd: 1.25, tokens: 900, complete: true },
    "session-partial": { usd: 0.5, tokens: 100, complete: false },
    "session-unmeasured": undefined,
  };
  const removed: string[] = [];
  const r = rig({ sessionsRemoved: removed, cost: sessionId => { order.push(`cost:${sessionId}`); return lookups[sessionId]; } });
  try {
    const long = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const jobId = r.addJob();
    const ids: Record<string, string> = {};
    let slot = 0;
    for (const sessionId of Object.keys(lookups)) {
      const trialId = r.seed(jobId, slot++, "running");
      ids[sessionId] = trialId;
      r.store.write(tx => finishTrial(tx, trialId, { grade: VOID_GRADE, configId: null, profileEpoch: null, sessionId, patchKeepDays: 90 }, long));
    }
    await r.pump.sweep();
    assert.equal(removed.length, 3, "every session is removed");
    for (const sessionId of removed) {
      assert.ok(order.indexOf(`cost:${sessionId}`) >= 0, "the lookup ran for " + sessionId);
    }
    const read = (name: string): CostRow | undefined => r.store.read(db => db.get<CostRow>(COST_SQL, ids[name]));
    const complete = read("session-complete");
    assert.equal(complete?.cost, "complete");
    assert.equal(complete?.tokens, 900);
    assert.equal(complete?.spent_usd, 1.25);
    assert.equal(complete?.session_id, null);
    const partial = read("session-partial");
    assert.equal(partial?.cost, "partial");
    assert.equal(partial?.tokens, 100);
    assert.equal(partial?.spent_usd, 0.5);
    const none = read("session-unmeasured");
    assert.equal(none?.cost, "none");
    assert.equal(none?.tokens, null, "unknown stays unknown, never zero");
    assert.equal(none?.spent_usd, null);
    assert.equal(none?.session_id, null);
  } finally {
    r.cleanup();
  }
});

test("a cost is read before the session is removed", async () => {
  const events: string[] = [];
  const removed: string[] = [];
  const r = rig({ sessionsRemoved: removed, cost: sessionId => { events.push(`cost:${sessionId}:removed=${removed.length}`); return { usd: 1, tokens: 1, complete: true }; } });
  try {
    endedTrial(r, "session-order", new Date(Date.now() - 2 * 3_600_000).toISOString());
    await r.pump.sweep();
    assert.deepEqual(events, ["cost:session-order:removed=0"], "the lookup saw no removal yet");
    assert.deepEqual(removed, ["session-order"]);
  } finally {
    r.cleanup();
  }
});

test("a cost the ledger cannot read waits a day", async () => {
  let clock = Date.now();
  const removed: string[] = [];
  const r = rig({ sessionsRemoved: removed, clock: () => new Date(clock).toISOString(),
    cost: () => { throw new Error("ledger unavailable"); } });
  try {
    const endedAt = new Date(clock - 2 * 3_600_000).toISOString();
    const trialId = endedTrial(r, "session-wait", endedAt);
    await r.pump.sweep();
    assert.deepEqual(removed, [], "the session stays");
    const waiting = r.store.read(db => db.get<CostRow>(COST_SQL, trialId));
    assert.equal(waiting?.session_id, "session-wait");
    assert.equal(waiting?.cost, null);
    clock = Date.parse(endedAt) + 24 * 3_600_000;
    await r.pump.sweep();
    assert.deepEqual(removed, ["session-wait"], "after a day the session is removed");
    const done = r.store.read(db => db.get<CostRow>(COST_SQL, trialId));
    assert.equal(done?.cost, "none");
    assert.equal(done?.tokens, null);
    assert.equal(done?.spent_usd, null);
    assert.equal(done?.session_id, null);
  } finally {
    r.cleanup();
  }
});

test("the pump opens a comparison job", async () => {
  const r = rig();
  try {
    r.addJob();
    r.store.write(tx => { tx.run("UPDATE eval_jobs SET kind = 'compare'"); });
    await r.pump.step();
    await r.pump.step();
    const fetched = r.probeInputs.map(input => input.fetchUrl).filter(url => url !== undefined);
    assert.ok(fetched.some(url => url?.includes("example/app")), "the probe names the compare job's project");
  } finally {
    r.cleanup();
  }
});

test("the identity status keeps the last probe once it has aged out", async t => {
  const r = rig({ probes: [{ state: "misconfigured" }] });
  try {
    assert.deepEqual(r.pump.identityStatus(), { state: "unavailable", lastProbe: null }, "no probe has happened");
    r.addJob();
    await r.pump.step();
    assert.equal(r.probeInputs.length, 1, "one probe");
    assert.equal(r.pump.identityStatus().state, "misconfigured", "a fresh probe is the state");
    assert.equal(r.pump.identityStatus().lastProbe, undefined);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60_000 });
    const aged = r.pump.identityStatus();
    assert.equal(aged.state, "unavailable", "scheduling still sees an unavailable identity");
    assert.equal(aged.lastProbe?.state, "misconfigured");
    assert.match(aged.lastProbe?.at ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.equal(r.pump.identityState(), "unavailable");
  } finally {
    r.cleanup();
  }
});

test("the sweep ends an idle paused job past its expiry and leaves an unexpired one paused", async () => {
  let clock = Date.parse("2026-11-16T10:00:00.000Z");
  const r = rig({ clock: () => new Date(clock).toISOString() });
  try {
    const jobId = r.addJob();
    r.store.write(tx => {
      tx.run("UPDATE eval_jobs SET status = 'paused', reason = 'owner', expires_at = ? WHERE job_id = ?", new Date(clock + 3_600_000).toISOString(), jobId);
    });
    const statusOf = () => r.store.read(db => db.get<{ status: string; reason: string | null }>("SELECT status, reason FROM eval_jobs WHERE job_id = ?", jobId));
    await r.pump.sweep();
    assert.equal(statusOf()?.status, "paused", "before its expiry the job stays paused");
    clock += 3_600_000;
    await r.pump.sweep();
    assert.equal(statusOf()?.status, "expired");
    assert.equal(statusOf()?.reason, "expired");
  } finally {
    r.cleanup();
  }
});

test("the comparison step reports no job whose trial is still live after a sweep", async () => {
  const r = rig();
  try {
    const jobId = r.addJob();
    r.seed(jobId, 0, "running");
    r.store.write(tx => {
      tx.run("UPDATE eval_jobs SET status = 'paused', reason = 'owner', expires_at = ? WHERE job_id = ?", new Date(Date.parse(r.now()) - 1000).toISOString(), jobId);
    });
    await r.pump.sweep();
    const row = r.store.read(db => db.get<{ status: string }>("SELECT status FROM eval_jobs WHERE job_id = ?", jobId));
    assert.equal(row?.status, "paused");
    assert.equal(new ComparisonPass({ store: r.store, config: r.config, now: r.now }).step(), "idle");
  } finally {
    r.cleanup();
  }
});

type Built = { slot: number; attempt: number; waiting: string | null };
const trialRows = (r: ReturnType<typeof rig>) => r.store.read(db => db.all<{ attempt: number; state: string; ending: string | null }>(
  "SELECT attempt, state, ending FROM eval_trials ORDER BY created_at, attempt"));
const jobOf = (r: ReturnType<typeof rig>, jobId: string) => r.store.read(db => db.get<{ status: string; reason: string | null; waiting: string | null }>(
  "SELECT status, reason, waiting FROM eval_jobs WHERE job_id = ?", jobId))!;

/** A source that ends with `cause` for the first `failures` builds, then skips the task. Each build records the row's attempt and the job's wait. */
function scripted(failures: number, cause: "bundle-missing" | "grader-failed" = "bundle-missing") {
  const builds: Built[] = [];
  let store: EvidenceStore | undefined;
  let jobId = "";
  const prepareSource: TrialPumpOptions["prepareSource"] = async (_store, _taskId, ctx) => {
    const row = _store.read(db => db.get<{ slot: number; attempt: number }>("SELECT slot, attempt FROM eval_trials WHERE trial_id = ?", ctx.trialId))!;
    store = _store;
    builds.push({ slot: row.slot, attempt: row.attempt, waiting: jobId === "" ? null : _store.read(db => db.get<{ waiting: string | null }>("SELECT waiting FROM eval_jobs WHERE job_id = ?", jobId))!.waiting });
    return builds.length <= failures ? { kind: "environment", cause } : { kind: "skip", reason: "not-valid" };
  };
  return { builds, prepareSource, setJob: (id: string) => { jobId = id; }, store: () => store };
}

/** Steps until `count` source builds (or status reads, with no mirror head) were made; a step budget keeps a stuck pump from hanging. */
async function stepsUntil(r: ReturnType<typeof rig>, made: () => number, count: number): Promise<void> {
  for (let step = 0; step < 200 && made() < count; step++) await r.pump.step();
  assert.equal(made(), count);
}

test("a source that cannot be built leaves no row for nine tries, and the tenth ends the trial void-host", async () => {
  const s = scripted(100);
  const r = rig({ baseBranch: "main", mirrorHead: "head", prepareSource: s.prepareSource });
  try {
    const jobId = r.addJob();
    s.setJob(jobId);
    await stepsUntil(r, () => s.builds.length, 9);
    assert.deepEqual(trialRows(r), [], "nine failures leave no trial row");
    assert.deepEqual({ ...jobOf(r, jobId) }, { status: "running", reason: null, waiting: "bundle-missing" }, "the job names the cause");
    await stepsUntil(r, () => s.builds.length, 10);
    assert.deepEqual(trialRows(r).map(row => ({ ...row })), [{ attempt: 0, state: "final", ending: "void-host" }], "the tenth failure ends the trial");
    await stepsUntil(r, () => s.builds.length, 11);
    assert.equal(s.builds[10]!.attempt, 1, "the next try is attempt 1: the voided one used attempt 0");
  } finally {
    r.cleanup();
  }
});

test("a cause that never clears uses the slot's three attempts and pauses the job", async () => {
  const s = scripted(1000);
  const r = rig({ baseBranch: "main", mirrorHead: "head", prepareSource: s.prepareSource });
  try {
    const jobId = r.addJob();
    s.setJob(jobId);
    await stepsUntil(r, () => s.builds.length, 30);
    for (let step = 0; step < 6; step++) await r.pump.step();
    assert.equal(s.builds.length, 30, "no build follows the third void");
    assert.deepEqual(trialRows(r).map(row => ({ ...row })), [0, 1, 2].map(attempt => ({ attempt, state: "final", ending: "void-host" })));
    const job = jobOf(r, jobId);
    assert.deepEqual({ status: job.status, reason: job.reason }, { status: "paused", reason: "trial-voids" });
    const owner = new EvalJobs({ store: r.store, config: r.config, now: r.now, baseline: { views: (db, rows) => r.jobs.views(db, rows), digest: (projectId, id) => r.jobs.digest(projectId, id) } });
    assert.ok(!("code" in owner.control(jobId, "resume")), "the owner resumes the job");
    for (let step = 0; step < 6; step++) await r.pump.step();
    assert.deepEqual({ ...s.builds[30]! }, { slot: 1, attempt: 0, waiting: null }, "after a resume the job moves on to the next slot, as attempt 0");
  } finally {
    r.cleanup();
  }
});

test("a short outage uses no attempt and the wait clears when the source builds", async () => {
  const s = scripted(3);
  const r = rig({ baseBranch: "main", mirrorHead: "head", prepareSource: s.prepareSource });
  try {
    const jobId = r.addJob();
    s.setJob(jobId);
    await stepsUntil(r, () => s.builds.length, 3);
    assert.equal(jobOf(r, jobId).waiting, "bundle-missing", "the job names the cause while the slot waits");
    await stepsUntil(r, () => s.builds.length, 4);
    assert.deepEqual(s.builds[3], { slot: 0, attempt: 0, waiting: null }, "the fourth build is attempt 0 and the job waits for nothing");
    assert.deepEqual(trialRows(r), [], "no void row was written");
  } finally {
    r.cleanup();
  }
});

test("a project with no mirror head counts the same way", async () => {
  const r = rig();
  try {
    const jobId = r.addJob();
    const tries = () => r.log.filter(entry => entry === "status").length;
    await stepsUntil(r, tries, 9);
    assert.deepEqual(trialRows(r), []);
    assert.equal(jobOf(r, jobId).waiting, "mirror");
    await stepsUntil(r, tries, 10);
    assert.deepEqual(trialRows(r).map(row => ({ ...row })), [{ attempt: 0, state: "final", ending: "void-host" }]);
  } finally {
    r.cleanup();
  }
});
