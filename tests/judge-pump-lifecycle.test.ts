import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { evalTrialsModule, finishTrial, insertTrial, openTrialCounts, startTrial } from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { calibrationJudgements, judgeCalibrationsModule } from "../packages/host/src/judge-store.js";
import { JudgeCalibrations } from "../packages/host/src/judge-calibration-jobs.js";
import { TrialJobs } from "../packages/host/src/eval-trial-jobs.js";
import { TrialPump, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import type { EvalIdentity, EvalProbe } from "../packages/host/src/eval-identity.js";
import type { Grader } from "../packages/host/src/eval-grader.js";
import type { SourceResult } from "../packages/host/src/eval-trial.js";
import type { CostLookup } from "../packages/host/src/outcome-cells.js";
import type { Capsule, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { JudgeCreate, ReplayState } from "../packages/host/src/team-replay.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const T0 = "2026-11-22T00:00:00.000Z";
const DAY_BEFORE = "2026-11-20T00:00:00.000Z";
const JOB = "job-1";
const PROJECT = "pump-project";
const JUDGE: TeamModelProfile = { id: "zz-judge-profile", label: "Label Zed", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
const OTHER: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const LINEUP = { coordinator: OTHER, integrator: OTHER, reviewer: OTHER, implementers: [OTHER], escalations: [], fallbacks: [], judge: JUDGE };
const FOCUSED = { command: "node", args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"] };
const SCORES = { correctness: 4, cleanliness: 3, extensibility: 3, docs: 2 };
const READY: EvalProbe = { state: "ready", uid: 5001, storage: true, fetch: "refused" };
const CAPSULE = { objective: "Write a.txt", steering: [], ownerAnswers: [], task: { id: "task-capsule", title: "Write a.txt", instructions: "Write a.txt.", paths: ["a.txt"] } } as Capsule;
const dirs: string[] = [];

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const patchOf = (pair: number, resolved: boolean) =>
  Buffer.from(`diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${resolved ? `RESOLVED-MARKER\n+fix-${pair}` : `other-${pair}`}\n`);
const taskOf = (pair: number) => `task-zq-${String(pair).padStart(3, "0")}`;
const trialOf = (pair: number, resolved: boolean) => `trial-zq-${pair * 2 + (resolved ? 0 : 1)}`;
const grade = (resolved: boolean): TrialGrade => ({ ending: "graded", expectedPassed: resolved ? 1 : 0, expectedTotal: 1, guardPassed: true, resolved, overwritten: 0, diff: null, isolation: "isolated" });

type Mode = "prefer-a" | "hang";
type Rig = ReturnType<typeof makeRig>;
type Options = { mode?: Mode; trialsPerDay?: number; judgements?: boolean; cost?: CostLookup; trialSessions?: boolean; failCleanAt?: number };

function makeRig(options: Options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-judge-life-")));
  dirs.push(root);
  const clock = { at: T0 };
  const now = () => clock.at;
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  store.register(judgeCalibrationsModule(store, now));
  store.write(tx => openTrialCounts(tx, JOB, { tasks: 1, trials: 1000 }));
  const config = {
    projects: [{ id: PROJECT, name: PROJECT, path: join(root, "unused"), source: { mode: "github", repository: "example/app", baseBranch: "main" },
      team: { eval: { mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: options.trialsPerDay ?? 100 } } }],
    stateDir: join(root, "state"), runDir: join(root, "runs"), keyFile: join(root, "vault.key"), maxSessions: 16,
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: join(root, "eval"), agents: { claude: { command: "claude", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;
  const log: string[] = [];
  const removed: string[] = [];
  let cleans = 0;
  const identity = {
    probe: async () => READY, receive: async () => "failed", prepare: async () => "failed", check: async () => "failed",
    teamPrefix: () => undefined, setupPrefix: () => undefined,
    stop: async () => { log.push("stop"); return true; },
    // `failCleanAt` is the index, among all clean calls, of the one that reports failure.
    clean: async () => { log.push("clean"); return cleans++ !== options.failCleanAt; },
    scrub: async () => { log.push("scrub"); return true; },
  } as unknown as EvalIdentity;
  const grader = { clean: async () => true } as unknown as Grader;
  const judge = scriptedTeams(options.mode ?? "prefer-a", log);
  const jobs = new TrialJobs({ store, config, now });
  const judgements = new JudgeCalibrations({ store, config, now });
  const build = () => new TrialPump({
    config, store, jobs, grader, identity, ...(options.judgements === false ? {} : { judgements }), teams: () => judge.teams,
    sessions: { list: async () => [], remove: async (id: string) => { removed.push(id); } } as never,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: "head" }) as never },
    hostLoad: { held: () => undefined }, halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }), inventory: async () => [], now,
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    prepareSource: async (_store, _taskId, ctx): Promise<SourceResult> => {
      log.push("prepare");
      const workspace = join(ctx.root, "trials", ctx.trialId, "work");
      mkdirSync(workspace, { recursive: true });
      execFileSync("git", ["init", "--quiet", workspace]);
      return { kind: "ready", baseCommit: "base", workspace, hiddenFiles: [], isolation: "isolated", capsule: CAPSULE, features: {} as never };
    },
  });
  const rig = { root, store, config, log, removed, judge, jobs, judgements, clock, build, pump: build(), close: () => store.close() };
  seedPairs(rig, 30);
  return rig;
}

function seedPairs(r: { store: EvidenceStore }, count: number): void {
  for (let pair = 0; pair < count; pair++) {
    const taskId = taskOf(pair), groupId = `g-${taskId}`;
    r.store.write(tx => {
      tx.run("INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at, confirms, exposed) VALUES (?, 'run', ?, ?, ?, 0, NULL, 0, 0)",
        groupId, tx.index("project", PROJECT), groupId, DAY_BEFORE);
      tx.run("INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id) "
        + "VALUES (?, 'captured', '', '', ?, 'valid', 'stored', 'proven', ?, ?, 'x', ?)", taskId, tx.index("project", PROJECT), DAY_BEFORE, DAY_BEFORE, groupId);
      for (const resolved of [true, false]) {
        const trialId = trialOf(pair, resolved);
        const configuration: TrialConfiguration = { profile: OTHER, guidance: "as-of-base", knowledge: "none" };
        insertTrial(tx, { trialId, jobId: JOB, taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: pair * 2 + (resolved ? 0 : 1),
          attempt: 0, projectId: PROJECT, configuration, keepDays: 365 }, DAY_BEFORE);
        startTrial(tx, trialId, DAY_BEFORE);
        finishTrial(tx, trialId, { grade: grade(resolved), configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch: patchOf(pair, resolved) }, DAY_BEFORE);
      }
    });
  }
}

type Scripted = { teams: TrialTeams; creates: { purpose: string; trialId: string }[]; states: Map<string, ReplayState> };

function scriptedTeams(mode: Mode, log: string[]): Scripted {
  const states = new Map<string, ReplayState>();
  const creates: Scripted["creates"] = [];
  let sessions = 0;
  const teams = {
    createForReplay: async (input: JudgeCreate | { purpose: "replay"; trialId: string }) => {
      creates.push({ purpose: input.purpose, trialId: input.trialId });
      log.push(`create:${input.purpose}`);
      const sessionId = `session-${sessions++}`;
      if (input.purpose !== "duel") states.set(input.trialId, { phase: "ended", ending: "no-result", sessionExited: false, sessionId });
      else if (mode === "hang") states.set(input.trialId, { phase: "running", sessionExited: false, sessionId, memberId: "member", memberStartedAt: new Date().toISOString() });
      else states.set(input.trialId, { phase: "ended", ending: "judged", judgement: { preferred: "A", rubric: { a: SCORES, b: SCORES } }, sessionExited: true, sessionId });
      return { runId: input.trialId };
    },
    replayState: async (id: string) => states.get(id),
    endReplay: async (id: string, ending: string) => {
      log.push(`end:${ending}`);
      const state = states.get(id);
      if (state?.phase === "running") states.set(id, { phase: "ended", ending: ending as never, sessionExited: true, ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }) });
    },
    forgetReplay: async (id: string) => states.delete(id),
    replayIds: () => [...states.keys()],
    providerLimits: () => [],
  } as unknown as TrialTeams;
  return { teams, creates, states };
}

async function until(r: { pump: TrialPump }, done: () => boolean, steps = 200): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (let step = 0; step < steps && Date.now() < deadline && !done(); step++) await r.pump.step();
}

const calibrate = (r: Rig, body: Record<string, unknown> = {}): string => {
  const made = r.judgements.create({ requestId: randomUUID(), judgeProfileId: JUDGE.id, pairs: 30, ...body });
  assert.ok("calibration" in made, JSON.stringify(made));
  return made.calibration.calibrationId;
};
const rowsOf = (r: Rig, id: string) => r.store.read(db => calibrationJudgements(db, id));
const viewOf = (r: Rig, id: string) => r.judgements.views().find(view => view.calibrationId === id)!;
const finalCount = (r: Rig, id: string) => rowsOf(r, id).filter(row => row.state === "final" || row.state === "dropped").length;

function addTrialJob(r: Rig, tasks: number): void {
  for (let i = 1; i <= tasks; i++) {
    const taskId = `captured:run-1:t0${i}`;
    r.store.write(tx => {
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
        + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
        + "VALUES (?, 'captured', 'run-1', 'member-1', ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, 'run:run-1', 'host', ?)",
        taskId, tx.index("project", PROJECT), T0, T0, tx.seal("eval_tasks", taskId, { projectId: PROJECT }), T0);
    });
  }
  const created = r.jobs.create(PROJECT, { kind: "baseline", configurations: [{ profile: OTHER, guidance: "as-of-base", knowledge: "none" }],
    limits: { maxTrials: 10, maxWallMinutes: 600 } }, randomUUID());
  assert.ok("job" in created, "the baseline job is created");
}

const exitReplays = (r: Rig) => { for (const [id, state] of r.judge.states) if (state.phase === "ended" && !state.sessionExited) r.judge.states.set(id, { ...state, sessionExited: true }); };

test("start-up voids a live judgement and retries it once", async () => {
  const r = makeRig({ mode: "hang" });
  try {
    const id = calibrate(r);
    await until(r, () => r.judgements.live().length === 1, 20);
    const first = rowsOf(r, id)[0]!;
    assert.equal(first.state, "live");
    r.pump = r.build();
    let most = 0;
    const alive = () => [...r.judge.states.values()].filter(state => state.phase === "running").length;
    await until(r, () => { most = Math.max(most, alive()); return rowsOf(r, id).length >= 2; }, 30);
    most = Math.max(most, alive());
    const rows = rowsOf(r, id);
    assert.equal(rows[0]!.state, "final");
    assert.equal(rows[0]!.ending, "void-host", "the live row ended void-host, not dropped");
    assert.equal(rows[0]!.sessionId, "session-0", "its session ID is kept for the sweep");
    assert.equal(rows[1]!.pairIndex, rows[0]!.pairIndex);
    assert.equal(rows[1]!.ordering, rows[0]!.ordering);
    assert.equal(rows[1]!.attempt, 1, "the same ordering retries as attempt 1");
    assert.equal(rows.filter(row => row.state === "dropped").length, 0);
    assert.ok(most <= 1, `at most one judge session at a time, saw ${most}`);
    assert.equal(r.judge.creates.filter(item => item.purpose === "duel").length, 2);
  } finally {
    r.close();
  }
});

test("start-up forgets a finished judge run", async () => {
  const r = makeRig({ mode: "prefer-a" });
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 1, 20);
    const done = rowsOf(r, id)[0]!;
    assert.equal(done.state, "final");
    const stray = randomUUID();
    const endedState: ReplayState = { phase: "ended", ending: "judged", sessionExited: true, sessionId: "session-x" };
    r.pump = r.build();
    r.judge.states.set(done.judgementId, endedState);
    r.judge.states.set(stray, endedState);
    await r.pump.step();
    await r.pump.sweep();
    assert.equal(r.judge.states.has(done.judgementId), false, "the final judgement's run is forgotten");
    assert.equal(r.judge.states.has(stray), true, "a run no row names stays");
  } finally {
    r.close();
  }
});

test("the sweep never forgets the live judge run", async () => {
  const r = makeRig({ mode: "hang" });
  try {
    const id = calibrate(r);
    await until(r, () => r.judgements.live().length === 1, 20);
    const live = rowsOf(r, id)[0]!;
    await r.pump.sweep();
    assert.equal(r.judge.states.has(live.judgementId), true, "the live run stays");
  } finally {
    r.close();
  }
});

async function trialSequence(r: Rig): Promise<string[]> {
  addTrialJob(r, 1);
  await until(r, () => r.judge.creates.length >= 1, 20);
  exitReplays(r);
  await until(r, () => r.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM eval_trials WHERE trial_id NOT LIKE 'trial-zq-%' AND state = 'final'")?.n ?? 0) >= 1, 20);
  return r.log;
}

test("a clean that fails at a judgement's end is run again before the next judgement is built", async () => {
  // The second clean call is the one at the first judgement's end; it reports failure.
  const r = makeRig({ failCleanAt: 1 });
  try {
    calibrate(r);
    await until(r, () => r.judge.creates.length >= 2, 20);
    assert.ok(r.judge.creates.length >= 2, "a second judgement started");
    const second = r.log.indexOf("create:duel", r.log.indexOf("create:duel") + 1);
    assert.deepEqual(r.log.slice(0, second + 1), [
      "stop", "clean", "scrub", "prepare", "create:duel", // start-up, then the first judgement
      "stop", "clean", // its end: the clean fails, so no scrub
      "stop", "clean", "scrub", "prepare", "create:duel", // the start-up runs again before the second judgement's source is built
    ]);
  } finally {
    r.close();
  }
});

test("a finish that fails once does not stall the calibration", async () => {
  const r = makeRig();
  try {
    const id = calibrate(r);
    const finish = r.judgements.finish.bind(r.judgements);
    let failures = 1;
    r.judgements.finish = (judgementId, outcome) => {
      if (failures-- > 0) throw new Error("store busy");
      return finish(judgementId, outcome);
    };
    await until(r, () => finalCount(r, id) >= 2, 60);
    const first = rowsOf(r, id).find(row => row.pairIndex === 0 && row.ordering === 0 && row.attempt === 0);
    assert.equal(first?.state, "final", "the row the failed finish left live is ended");
    assert.equal(first?.ending, "void-host", "by the start-up, as a host failure");
    assert.ok(finalCount(r, id) >= 2, "the calibration goes on");
  } finally {
    r.close();
  }
});

test("a pump with no calibration runs trials as before", async () => {
  const r = makeRig({ judgements: false });
  try {
    const sequence = await trialSequence(r);
    assert.deepEqual(sequence, ["stop", "clean", "scrub", "prepare", "create:replay", "stop", "clean", "scrub"]);
  } finally {
    r.close();
  }
});

test("a pump with a judge configured but no calibration runs trials the same way", async () => {
  const off = makeRig({ judgements: false }), on = makeRig();
  let asked = 0;
  const next = on.judgements.next.bind(on.judgements);
  on.judgements.next = async gates => { asked += 1; return next(gates); };
  try {
    assert.deepEqual(await trialSequence(on), await trialSequence(off));
    assert.equal(on.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM judge_judgements")?.n), 0, "no row is written");
    for (let step = 0; step < 3; step++) await on.pump.step();
    assert.equal(asked, 0, "with no calibration running the pump never asks for a judgement");
  } finally {
    off.close();
    on.close();
  }
});

test("a judgement leaves the trial daily count alone", async () => {
  const r = makeRig({ trialsPerDay: 2 });
  try {
    r.store.write(tx => {
      const configuration: TrialConfiguration = { profile: OTHER, guidance: "as-of-base", knowledge: "none" };
      insertTrial(tx, { trialId: "trial-today", jobId: JOB, taskId: taskOf(0), configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: 900,
        attempt: 0, projectId: PROJECT, configuration, keepDays: 365 }, T0);
      startTrial(tx, "trial-today", T0);
    });
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 3, 60);
    assert.ok(finalCount(r, id) >= 3, "three judgements ran today");
    addTrialJob(r, 1);
    await until(r, () => r.judge.creates.some(item => item.purpose === "replay"), 20);
    assert.ok(r.judge.creates.some(item => item.purpose === "replay"), "the next trial starts: two today would be the cap, and judgements are not counted");
  } finally {
    r.close();
  }
});

test("trials and judgements alternate", async () => {
  const r = makeRig();
  try {
    addTrialJob(r, 3);
    calibrate(r);
    await until(r, () => { exitReplays(r); return r.judge.creates.length >= 4; }, 100);
    assert.deepEqual(r.judge.creates.slice(0, 4).map(item => item.purpose), ["replay", "duel", "replay", "duel"]);
  } finally {
    r.close();
  }
});

test("one kind with work runs every turn", async () => {
  const r = makeRig();
  try {
    calibrate(r);
    await until(r, () => r.judge.creates.length >= 3, 60);
    assert.deepEqual(r.judge.creates.slice(0, 3).map(item => item.purpose), ["duel", "duel", "duel"]);
  } finally {
    r.close();
  }
});

test("an expired calibration stops scheduling", async () => {
  const r = makeRig();
  try {
    const id = calibrate(r, { expiresAt: "2026-11-22T01:00:00.000Z" });
    await until(r, () => finalCount(r, id) >= 1, 20);
    const started = rowsOf(r, id).length;
    assert.ok(started >= 1);
    r.clock.at = "2026-11-22T02:00:00.000Z";
    await r.pump.sweep();
    assert.equal(viewOf(r, id).status, "expired", "the sweep expires the calibration");
    for (let step = 0; step < 10; step++) await r.pump.step();
    assert.equal(rowsOf(r, id).length, started, "no further judgement starts");
    assert.equal(r.judge.creates.length, started);
  } finally {
    r.close();
  }
});

const SESSION_SQL = "SELECT session_id, tokens, spent_usd, cost FROM judge_judgements WHERE judgement_id = ?";
type CostRow = { session_id: string | null; tokens: number | null; spent_usd: number | null; cost: string | null };

test("the sweep records a judge session's cost before it removes the session", async () => {
  const order: string[] = [];
  const r = makeRig({ cost: sessionId => { order.push(`cost:${sessionId}`); return { tokens: 10, usd: 1, complete: true }; } });
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 1, 20);
    const row = rowsOf(r, id)[0]!;
    assert.equal(row.sessionId, "session-0");
    assert.equal(r.store.read(db => db.get<CostRow>(SESSION_SQL, row.judgementId))?.cost, null, "the close read no cost");
    r.clock.at = "2026-11-22T02:00:00.000Z";
    const mark = r.removed.length;
    await r.pump.sweep();
    const after = r.store.read(db => db.get<CostRow>(SESSION_SQL, row.judgementId))!;
    assert.deepEqual({ tokens: after.tokens, spent: after.spent_usd, cost: after.cost }, { tokens: 10, spent: 1, cost: "complete" });
    assert.equal(after.session_id, null, "the session ID is cleared");
    assert.deepEqual(r.removed.slice(mark), ["session-0"], "the session was removed once");
    assert.deepEqual(order, ["cost:session-0"]);
    assert.deepEqual(viewOf(r, id).cost, { tokens: 10, spentUsd: 1 });
  } finally {
    r.close();
  }
});

test("a cost lookup that throws leaves the session and the row alone", async () => {
  const r = makeRig({ cost: () => { throw new Error("ledger unavailable"); } });
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 1, 20);
    const row = rowsOf(r, id)[0]!;
    r.clock.at = "2026-11-22T02:00:00.000Z";
    await r.pump.sweep();
    const after = r.store.read(db => db.get<CostRow>(SESSION_SQL, row.judgementId))!;
    assert.equal(after.session_id, "session-0", "the session ID stays");
    assert.equal(after.cost, null);
    assert.deepEqual(r.removed, [], "no session was removed");
    r.clock.at = "2026-11-23T03:00:00.000Z";
    await r.pump.sweep();
    const later = r.store.read(db => db.get<CostRow>(SESSION_SQL, row.judgementId))!;
    assert.equal(later.cost, "none", "a day later the cost is recorded as none");
    assert.equal(later.session_id, null);
    assert.deepEqual(r.removed, ["session-0"]);
  } finally {
    r.close();
  }
});
