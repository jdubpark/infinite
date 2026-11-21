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
import { TrialPump, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import { evalTrialsModule, finishTrial, insertTrial, startTrial } from "../packages/host/src/eval-trial-store.js";
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
  replayState?: (trialId: string) => Promise<unknown>; onStatus?: () => void; cost?: CostLookup; clock?: () => string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "infinite-trial-pump-"));
  dirs.push(root);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  const now = options.clock ?? (() => new Date().toISOString());
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
    replayIds: () => options.replayIds ?? [],
    providerLimits: () => [],
  } as unknown as TrialTeams;
  const sessionsRemoved = options.sessionsRemoved ?? [];
  const jobs = new TrialJobs({ store, config, now });
  const pump = new TrialPump({
    config, store, jobs, grader, identity, teams: () => teams,
    sessions: { list: async () => [], remove: async (id: string) => { sessionsRemoved.push(id); if (options.removeRefused) throw new Error("refused"); } } as never,
    ...(options.cost ? { cost: options.cost } : {}),
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => { log.push("status"); options.onStatus?.(); return { mode: "github", repository: "example/app", baseBranch: "main" } as never; } },
    hostLoad: { held: () => undefined }, halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }), inventory: async () => [], now,
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
  return { store, config, pump, log, seed, probeInputs, sessionsRemoved, forgotten, addJob, cleanup: () => store.close() };
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
    // No job is open at start-up, so the start-up probe names no project.
    await r.pump.step();
    assert.equal(r.probeInputs.length, 1, "the start-up probe");
    assert.equal(r.probeInputs[0].fetchUrl, undefined, "the start-up probe fetches no repository");
    r.addJob();
    await r.pump.step();
    assert.equal(r.probeInputs.length, 2, "the trial's project is probed again");
    assert.ok(r.probeInputs[1].fetchUrl?.includes("example/app"), "the second probe names the project's repository");
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
