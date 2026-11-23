import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { evalTrialsModule, finishTrial, insertTrial, openTrialCounts, startTrial } from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION } from "../packages/host/src/eval-trial-rules.js";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { calibrationJudgements, judgeCalibrationsModule } from "../packages/host/src/judge-store.js";
import { JudgeCalibrations } from "../packages/host/src/judge-calibration-jobs.js";
import { TrialJobs } from "../packages/host/src/eval-trial-jobs.js";
import { TrialPump, type TrialTeams } from "../packages/host/src/eval-trial-pump.js";
import { launcherEvalIdentity, type EvalIdentity, type EvalProbe } from "../packages/host/src/eval-identity.js";
import type { Grader } from "../packages/host/src/eval-grader.js";
import type { SourceResult } from "../packages/host/src/eval-trial.js";
import type { Capsule, TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { JudgeCreate, ReplayState } from "../packages/host/src/team-replay.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { fixture, git } from "./team-fixture.js";

// The pump's judgement turn. The 30-pair tests run on a rig with a scripted `TrialTeams` and a scripted judge that answers from the
// package files the pump wrote; the real-host tests run a real team service and tests/fixtures/judge-agent.mjs. The source build is
// scripted in both, so that 60 judgements need not build 60 real sources; the trial pump's own tests cover the real build.

const T0 = "2026-11-22T00:00:00.000Z";
const JOB = "job-1";
const PROJECT = "pump-project";
const SECOND = "pump-second";
const LAUNCHER = resolve("tests/fixtures/eval-command.mjs");
const JUDGE_AGENT = resolve("tests/fixtures/judge-agent.mjs");
const JUDGE: TeamModelProfile = { id: "zz-judge-profile", label: "Label Zed", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
const OTHER: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const LINEUP = { coordinator: OTHER, integrator: OTHER, reviewer: OTHER, implementers: [OTHER], escalations: [], fallbacks: [], judge: JUDGE };
const FOCUSED = { command: "node", args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"] };
const SETTINGS = { eval: { mine: true, focusedTest: FOCUSED, reportFormat: "junit", trialsPerDay: 100 } };
const SCORES = { correctness: 4, cleanliness: 3, extensibility: 3, docs: 2 };
const READY: EvalProbe = { state: "ready", uid: 5001, storage: true, fetch: "refused" };
const CAPSULE = { objective: "Write a.txt", steering: [], ownerAnswers: [], task: { id: "task-capsule", title: "Write a.txt", instructions: "Write a.txt.", paths: ["a.txt"] } } as Capsule;
const UID = process.getuid?.() ?? 0;
const dirs: string[] = [];

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A small unified diff; the resolved side holds the marker line the fixture judge looks for. */
const patchOf = (pair: number, resolved: boolean) =>
  Buffer.from(`diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${resolved ? `RESOLVED-MARKER\n+fix-${pair}` : `other-${pair}`}\n`);
const taskOf = (pair: number) => `task-zq-${String(pair).padStart(3, "0")}`;
const trialOf = (pair: number, resolved: boolean) => `trial-zq-${pair * 2 + (resolved ? 0 : 1)}`;
const grade = (resolved: boolean): TrialGrade => ({ ending: "graded", expectedPassed: resolved ? 1 : 0, expectedTotal: 1, guardPassed: true, resolved, overwritten: 0, diff: null, isolation: "isolated" });

type Mode = "prefer-a" | "prefer-resolved" | "hang";
type Rig = ReturnType<typeof makeRig>;
type Options = { mode?: Mode; pairs?: number; teams?: () => TrialTeams; identity?: EvalIdentity; prepare?: (rig: Rig, ctx: { trialId: string; root: string }) => Promise<SourceResult>;
  /** Pairs for a second project, seeded after the first project's. */
  secondPairs?: number;
  config?: (config: Config) => void; inventory?: () => Promise<[]> };

/** The pump over a real store and real jobs, with `pairs` seeded dev pairs. Every identity call and source build is logged. */
function makeRig(options: Options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-judge-pump-")));
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
    projects: [{ id: PROJECT, name: PROJECT, path: join(root, "unused"), source: { mode: "github", repository: "example/app", baseBranch: "main" }, team: SETTINGS }],
    stateDir: join(root, "state"), runDir: join(root, "runs"), keyFile: join(root, "vault.key"), maxSessions: 16,
    eval: {
      grader: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: "/var/lib/infinite-grader/root" },
      member: { prefix: { command: "/usr/bin/sudo", args: ["-n"] }, root: join(root, "eval"), agents: { claude: { command: "claude", args: [] } } },
    },
    teams: { workspaceDir: join(root, "workspaces"), lineup: LINEUP },
  } as unknown as Config;
  options.config?.(config);
  const log: string[] = [];
  /** The grader job and project of every source the pump asked for. */
  const sources: { jobId: string; projectId: string }[] = [];
  const identity = options.identity ?? ({
    probe: async () => READY, receive: async () => "failed", prepare: async () => "failed", check: async () => "failed",
    teamPrefix: () => undefined, setupPrefix: () => undefined,
    stop: async () => { log.push("stop"); return true; },
    clean: async () => { log.push("clean"); return true; },
    scrub: async () => { log.push("scrub"); return true; },
  } as unknown as EvalIdentity);
  const grader = { clean: async () => true } as unknown as Grader;
  const judge = scriptedTeams(options.mode ?? "prefer-resolved");
  const jobs = new TrialJobs({ store, config, now });
  const judgements = new JudgeCalibrations({ store, config, now });
  /** The mirror head the scripted source status reports; undefined means the project has no mirror yet. */
  const mirror = { head: "head" as string | undefined };
  /** How many of the next source builds end on an environment cause. */
  const sourceFails = { left: 0 };
  const rig = {
    root, store, config, log, sources, judge, jobs, judgements, now, mirror, sourceFails,
    pump: undefined as unknown as TrialPump,
    close: () => store.close(),
  };
  const defaultPrepare = async (_r: Rig, ctx: { trialId: string; root: string }): Promise<SourceResult> => {
    log.push("prepare");
    const workspace = join(ctx.root, "trials", ctx.trialId, "work");
    mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "--quiet", workspace]);
    return { kind: "ready", baseCommit: "base", workspace, hiddenFiles: [], isolation: "isolated", capsule: CAPSULE, features: {} as never };
  };
  rig.pump = new TrialPump({
    config, store, jobs, grader, identity, judgements, teams: options.teams ?? (() => judge.teams),
    sessions: { list: async () => [], remove: async () => undefined } as never,
    source: { mirrorPath: () => join(root, "mirror.git"), status: () => ({ mode: "github", repository: "example/app", baseBranch: "main", mirrorHead: mirror.head }) as never },
    hostLoad: { held: () => undefined }, halt: () => ({ check: () => ({ state: "clear" as const }) }),
    graderProbe: async () => ({ state: "ready", storage: true, version: 2, uid: 5002 }), inventory: options.inventory ?? (async () => []), now,
    prepareSource: async (_store, _taskId, ctx) => {
      sources.push({ jobId: ctx.jobId, projectId: ctx.projectId });
      if (sourceFails.left > 0) {
        sourceFails.left -= 1;
        return { kind: "environment", cause: "eval-failed" };
      }
      return (options.prepare ?? defaultPrepare)(rig as Rig, { trialId: ctx.trialId, root: ctx.root });
    },
  });
  seedPairs(rig, options.pairs ?? 30);
  if (options.secondPairs) seedPairs(rig, options.secondPairs, SECOND, options.pairs ?? 30);
  return rig;
}

function seedPairs(r: { store: EvidenceStore }, count: number, project = PROJECT, from = 0): void {
  for (let pair = from; pair < from + count; pair++) {
    const taskId = taskOf(pair), groupId = `g-${taskId}`;
    r.store.write(tx => {
      tx.run("INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at, confirms, exposed) VALUES (?, 'run', ?, ?, ?, 0, NULL, 0, 0)",
        groupId, tx.index("project", project), groupId, T0);
      tx.run("INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id) "
        + "VALUES (?, 'captured', '', '', ?, 'valid', 'stored', 'proven', ?, ?, 'x', ?)", taskId, tx.index("project", project), T0, T0, groupId);
      for (const resolved of [true, false]) {
        const trialId = trialOf(pair, resolved);
        const configuration: TrialConfiguration = { profile: OTHER, guidance: "as-of-base", knowledge: "none" };
        insertTrial(tx, { trialId, jobId: JOB, taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: pair * 2 + (resolved ? 0 : 1),
          attempt: 0, projectId: project, configuration, keepDays: 365 }, T0);
        startTrial(tx, trialId, T0);
        finishTrial(tx, trialId, { grade: grade(resolved), configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch: patchOf(pair, resolved) }, T0);
      }
    });
  }
}

type Scripted = { teams: TrialTeams; creates: { purpose: string; trialId: string }[]; ended: { id: string; ending: string }[]; reads: Map<string, { a: Buffer; b: Buffer }>;
  states: Map<string, ReplayState>; mode: { current: Mode } };

/**
 * A `TrialTeams` with no team service. A duel run reads the package the pump wrote and answers as the mode says: `prefer-a` always A,
 * `prefer-resolved` the label whose patch holds the marker line, `hang` never answers (its member started three minutes ago).
 * A replay run ends `no-result` with its session still alive until the test sets `sessionExited`.
 */
function scriptedTeams(mode: Mode): Scripted {
  const states = new Map<string, ReplayState>();
  const creates: Scripted["creates"] = [], ended: Scripted["ended"] = [], reads: Scripted["reads"] = new Map();
  const current = { current: mode };
  let sessions = 0;
  const teams = {
    createForReplay: async (input: JudgeCreate | { purpose: "replay"; trialId: string }) => {
      creates.push({ purpose: input.purpose, trialId: input.trialId });
      const sessionId = `session-${sessions++}`;
      if (input.purpose !== "duel") {
        states.set(input.trialId, { phase: "ended", ending: "no-result", sessionExited: false, sessionId });
        return { runId: input.trialId };
      }
      const dir = join(input.workspace, ".git", "infinite-judge");
      const a = readFileSync(join(dir, "A.patch")), b = readFileSync(join(dir, "B.patch"));
      reads.set(input.trialId, { a, b });
      if (current.current === "hang") {
        states.set(input.trialId, { phase: "running", sessionExited: false, sessionId, memberId: "member", memberStartedAt: new Date(Date.now() - 3 * 60_000).toISOString() });
        return { runId: input.trialId };
      }
      const holds = (bytes: Buffer) => bytes.toString("utf8").split("\n").includes("+RESOLVED-MARKER");
      const preferred = current.current === "prefer-a" ? "A" : holds(a) ? "A" : holds(b) ? "B" : "tie";
      states.set(input.trialId, { phase: "ended", ending: "judged", judgement: { preferred, rubric: { a: SCORES, b: SCORES } }, sessionExited: true, sessionId });
      return { runId: input.trialId };
    },
    replayState: async (id: string) => states.get(id),
    endReplay: async (id: string, ending: string) => {
      ended.push({ id, ending });
      const state = states.get(id);
      if (state?.phase === "running") states.set(id, { phase: "ended", ending: ending as never, sessionExited: true, ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }) });
    },
    forgetReplay: async (id: string) => states.delete(id),
    replayIds: () => [...states.keys()],
    providerLimits: () => [],
  } as unknown as TrialTeams;
  return { teams, creates, ended, reads, states, mode: current };
}

/** Steps the pump until `done` holds; a bound on the steps and the time keeps a bug from spinning. */
async function until(r: { pump: TrialPump }, done: () => boolean, options: { steps?: number; ms?: number; pause?: number } = {}): Promise<void> {
  const deadline = Date.now() + (options.ms ?? 120_000);
  for (let step = 0; step < (options.steps ?? 2000) && Date.now() < deadline && !done(); step++) {
    await r.pump.step();
    if (options.pause) await new Promise(resolve => setTimeout(resolve, options.pause));
  }
}

const calibrate = (r: Rig, body: Record<string, unknown> = {}): string => {
  const made = r.judgements.create({ requestId: randomUUID(), judgeProfileId: JUDGE.id, pairs: 30, ...body });
  assert.ok("calibration" in made, JSON.stringify(made));
  return made.calibration.calibrationId;
};
const rowsOf = (r: Rig, id: string) => r.store.read(db => calibrationJudgements(db, id));
const viewOf = (r: Rig, id: string) => r.judgements.views().find(view => view.calibrationId === id)!;
const finalCount = (r: Rig, id: string) => rowsOf(r, id).filter(row => row.state === "final" || row.state === "dropped").length;

test("a judgement runs and is recorded", async () => {
  const r = makeRig({ mode: "prefer-a" });
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 1, { steps: 20 });
    const rows = rowsOf(r, id);
    assert.ok(rows.length >= 1, "a judgement started");
    const first = rows[0]!;
    assert.equal(first.state, "final");
    assert.equal(first.ending, "judged");
    assert.equal(first.preferred, "A");
    assert.equal(r.judge.creates.filter(item => item.purpose === "duel").length, rows.length, "one judge run per row");
    assert.equal(r.judge.creates[0]!.trialId, first.judgementId, "the judgement ID is the run ID");
  } finally {
    r.close();
  }
});

test("an always-resolved judge calibrates ok", { timeout: 240_000 }, async () => {
  const r = makeRig({ mode: "prefer-resolved" });
  try {
    const id = calibrate(r);
    await until(r, () => viewOf(r, id).status !== "running");
    const view = viewOf(r, id);
    assert.equal(view.status, "completed");
    assert.equal(view.pairs.correct, 30);
    assert.equal(view.state, "ok");
    assert.equal(view.swapAgreement, 1);
  } finally {
    r.close();
  }
});

test("an always-A judge scores no correct pair", { timeout: 240_000 }, async () => {
  const r = makeRig({ mode: "prefer-a" });
  try {
    const id = calibrate(r);
    await until(r, () => viewOf(r, id).status !== "running");
    const view = viewOf(r, id);
    assert.equal(view.status, "completed");
    assert.equal(view.pairs.correct, 0);
    assert.equal(view.state, "not-ok");
    assert.equal(view.swapAgreement, 0);
  } finally {
    r.close();
  }
});

test("a judgement waits while a trial is live", async () => {
  const r = makeRig({ mode: "prefer-resolved" });
  try {
    // One valid task and a baseline job: the pump starts that trial first, and its run stays alive.
    r.store.write(tx => {
      tx.run(
        "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, material_bytes, "
        + "captured_at, checked_at, payload, group_id, area_ref, validated_at) "
        + "VALUES (?, 'captured', 'run-1', 'member-1', ?, 'valid', 'stored', 'proven', 0, ?, ?, ?, 'run:run-1', 'host', ?)",
        "captured:run-1:t01", tx.index("project", PROJECT), T0, T0, tx.seal("eval_tasks", "captured:run-1:t01", { projectId: PROJECT }), T0);
    });
    const created = r.jobs.create(PROJECT, { kind: "baseline", configurations: [{ profile: OTHER, guidance: "as-of-base", knowledge: "none" }],
      limits: { maxTrials: 10, maxWallMinutes: 600 } }, randomUUID());
    assert.ok("job" in created, "the baseline job is created");
    const id = calibrate(r);
    await until(r, () => r.judge.creates.some(item => item.purpose === "replay"), { steps: 20 });
    assert.ok(r.judge.creates.some(item => item.purpose === "replay"), "the trial started first");
    for (let step = 0; step < 8; step++) await r.pump.step();
    assert.equal(r.judge.creates.filter(item => item.purpose === "duel").length, 0, "no judge run starts while the trial is live");
    assert.equal(rowsOf(r, id).length, 0, "no judgement row is opened either");
    assert.equal(viewOf(r, id).waiting, "another-job", "the view names the live trial as the gate");
    // The trial's session exits and the job is cancelled, so no further trial is ready: the trial closes, and the judgement runs after it.
    const trialId = r.judge.creates.find(item => item.purpose === "replay")!.trialId;
    r.store.write(tx => { tx.run("UPDATE eval_jobs SET status = 'cancelled' WHERE kind = 'baseline'"); });
    r.judge.states.set(trialId, { ...r.judge.states.get(trialId)!, sessionExited: true });
    await until(r, () => finalCount(r, id) >= 1, { steps: 40 });
    assert.ok(r.judge.creates.some(item => item.purpose === "duel"), "the judgement started once the trial was final");
    const trialFinal = r.store.read(db => db.get<{ state: string }>("SELECT state FROM eval_trials WHERE trial_id = ?", trialId));
    assert.equal(trialFinal?.state, "final");
    const duelAt = r.judge.creates.findIndex(item => item.purpose === "duel"), replayAt = r.judge.creates.findIndex(item => item.purpose === "replay");
    assert.ok(replayAt < duelAt);
  } finally {
    r.close();
  }
});

test("the identity is cleaned after each judgement", async () => {
  const r = makeRig({ mode: "prefer-resolved" });
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 3, { steps: 60 });
    assert.ok(finalCount(r, id) >= 3);
    const steps = r.log.slice(r.log.indexOf("prepare"));
    const prepares = steps.flatMap((entry, at) => (entry === "prepare" ? [at] : []));
    assert.ok(prepares.length >= 3, "three sources were prepared");
    for (let i = 0; i + 1 < prepares.length; i++) {
      const between = steps.slice(prepares[i]! + 1, prepares[i + 1]!);
      assert.deepEqual(between, ["stop", "clean", "scrub"], `the account is stopped, cleaned, and scrubbed between judgement ${i} and the next prepare`);
    }
  } finally {
    r.close();
  }
});

test("an expired patch drops the pair", { timeout: 240_000 }, async () => {
  const r = makeRig({ mode: "prefer-resolved", pairs: 32 });
  try {
    const id = calibrate(r, { pairs: 32 });
    // The patch of the first pair's resolved trial expires after the calibration chose its pairs.
    const first = rowsOf(r, id);
    assert.equal(first.length, 0);
    r.store.write(tx => { tx.run("DELETE FROM eval_trial_patches WHERE trial_id = ?", trialOf(0, true)); });
    await until(r, () => viewOf(r, id).status !== "running");
    const rows = rowsOf(r, id);
    const dropped = rows.filter(row => row.state === "dropped");
    assert.equal(dropped.length, 1, "one row dropped");
    assert.equal(dropped[0]!.dropReason, "patch-missing");
    assert.equal(dropped[0]!.pairIndex, 0);
    assert.equal(r.judge.creates.some(item => item.trialId === dropped[0]!.judgementId), false, "no judge run starts for the dropped pair");
    assert.equal(rows.some(row => row.pairIndex === 0 && row.state !== "dropped"), false, "its other ordering never starts");
    const view = viewOf(r, id);
    assert.equal(view.pairs.counted, 31, "the dropped pair is not counted");
  } finally {
    r.close();
  }
});

test("each project of a calibration gets its own grader job", { timeout: 240_000 }, async () => {
  const r = makeRig({ mode: "prefer-resolved", pairs: 15, secondPairs: 15,
    config: config => { config.projects.push({ ...config.projects[0]!, id: SECOND, name: SECOND }); } });
  try {
    const id = calibrate(r);
    await until(r, () => viewOf(r, id).status !== "running");
    assert.equal(viewOf(r, id).pairs.counted, 30, "both projects' pairs were judged");
    const jobs = new Map<string, Set<string>>();
    for (const source of r.sources) jobs.set(source.projectId, (jobs.get(source.projectId) ?? new Set<string>()).add(source.jobId));
    assert.deepEqual([...jobs.keys()].sort(), [PROJECT, SECOND]);
    const first = [...jobs.get(PROJECT)!], second = [...jobs.get(SECOND)!];
    assert.equal(first.length, 1, "one grader job for the first project");
    assert.equal(second.length, 1, "one grader job for the second project");
    // The grader keeps one base bundle per job, and a bundle holds one repository.
    assert.notEqual(first[0], second[0], "two projects never share a grader job");
    for (const job of [first[0]!, second[0]!]) assert.match(job, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the grader accepts the job ID");
    // The pairs of one project run together, so the grader changes bundles once.
    const runs = r.sources.map(source => source.projectId).filter((project, at, all) => at === 0 || all[at - 1] !== project);
    assert.deepEqual(runs, [PROJECT, SECOND]);
  } finally {
    r.close();
  }
});

test("a timed-out judge ends timeout", { timeout: 240_000 }, async () => {
  const r = makeRig({ mode: "hang" });
  try {
    const id = calibrate(r, { judgeMinutes: 2 });
    await until(r, () => finalCount(r, id) >= 1, { steps: 30 });
    const first = rowsOf(r, id)[0]!;
    assert.equal(first.ending, "timeout");
    assert.equal(first.preferred, null);
    assert.deepEqual(r.judge.ended.filter(item => item.id === first.judgementId), [{ id: first.judgementId, ending: "timeout" }], "the pump ended the run once, as timeout");
    await until(r, () => viewOf(r, id).status !== "running");
    const view = viewOf(r, id);
    assert.equal(view.pairs.counted, 30, "timed-out pairs are counted");
    assert.equal(view.pairs.correct, 0, "and counted incorrect");
    assert.equal(view.state, "not-ok");
  } finally {
    r.close();
  }
});

test("a calibration that ends under a live judgement voids that judgement", async () => {
  const r = makeRig({ mode: "hang" });
  try {
    const id = calibrate(r);
    await until(r, () => r.judge.creates.some(item => item.purpose === "duel"), { steps: 20 });
    const duel = r.judge.creates.find(item => item.purpose === "duel")!;
    assert.equal(r.judgements.live().length, 1, "one judgement is live");
    const cancelled = r.judgements.cancel(id);
    assert.ok("calibration" in cancelled);
    const mark = r.log.length;
    await until(r, () => rowsOf(r, id).every(row => row.state === "final"), { steps: 20 });
    const row = rowsOf(r, id)[0]!;
    assert.equal(row.state, "final");
    assert.equal(row.ending, "void-owner");
    assert.deepEqual(r.judge.ended.filter(item => item.id === duel.trialId), [{ id: duel.trialId, ending: "void-owner" }]);
    assert.deepEqual(r.log.slice(mark), ["stop", "clean", "scrub"], "the account is cleaned after the cancel");
    assert.equal(r.judge.states.has(duel.trialId), false, "the run is forgotten");
  } finally {
    r.close();
  }
});

test("a source build that ends on an environment cause uses no attempt", async () => {
  const r = makeRig({ mode: "prefer-a" });
  try {
    r.sourceFails.left = 3;
    const id = calibrate(r);
    await until(r, () => r.sourceFails.left === 0, { steps: 40 });
    assert.equal(r.sources.length, 3, "three source builds failed");
    assert.deepEqual(rowsOf(r, id), [], "no judgement row remains");
    assert.equal(viewOf(r, id).status, "running");
    assert.equal(viewOf(r, id).waiting, "eval-failed");
    await until(r, () => finalCount(r, id) >= 1, { steps: 40 });
    const first = rowsOf(r, id)[0]!;
    assert.equal(first.attempt, 0, "the first attempt runs once the source works");
    assert.equal(first.ending, "judged");
  } finally {
    r.close();
  }
});

test("a project with no mirror head uses no attempt", async () => {
  const r = makeRig({ mode: "prefer-a" });
  try {
    r.mirror.head = undefined;
    const id = calibrate(r);
    await until(r, () => false, { steps: 12 });
    assert.deepEqual(rowsOf(r, id), [], "no judgement row remains");
    assert.equal(viewOf(r, id).status, "running");
    assert.equal(viewOf(r, id).waiting, "mirror");
    assert.equal(r.sources.length, 0, "no source was built");
    r.mirror.head = "head";
    await until(r, () => finalCount(r, id) >= 1, { steps: 40 });
    const first = rowsOf(r, id)[0]!;
    assert.equal(first.attempt, 0);
    assert.equal(first.ending, "judged");
  } finally {
    r.close();
  }
});

test("a run that ends with a trial-only ending records void-host", async () => {
  const r = makeRig({ mode: "prefer-a" });
  try {
    const id = calibrate(r);
    // A duel run never settles; if its state says so, the judgement is void and not a preference.
    const teams = r.judge.teams;
    const original = teams.createForReplay.bind(teams);
    teams.createForReplay = async input => {
      const result = await original(input);
      r.judge.states.set(input.trialId, { phase: "ended", ending: "settled", sessionExited: true, sessionId: "session-x" });
      return result;
    };
    await until(r, () => finalCount(r, id) >= 1, { steps: 20 });
    assert.equal(rowsOf(r, id)[0]!.ending, "void-host");
  } finally {
    r.close();
  }
});

// The real-host tests: a real team service and the fixture judge, with the source build scripted to a clone of the fixture project.

type Real = Awaited<ReturnType<typeof realRig>>;

async function realRig(mode: Mode) {
  const f = await fixture("success", undefined, {}, { trustWorkspaces: true });
  // The host's workspace check and the package writer both want a path with no link in it.
  const base = realpathSync(f.host.root);
  const evalRoot = join(base, "eval");
  const home = join(base, "home"), template = join(base, "template"), tmp = join(base, "tmp");
  for (const directory of [join(evalRoot, "trials"), home, template, tmp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(evalRoot, 0o711);
  const record = join(base, "eval-record.log");
  f.host.config.eval = { member: {
    prefix: { command: process.execPath, args: [LAUNCHER, "--root", evalRoot, "--home", home, "--template", template, "--tmp", tmp, "--record", record] },
    root: evalRoot, agents: { claude: { command: process.execPath, args: [JUDGE_AGENT, f.receipts] } },
  } } as Config["eval"];
  f.host.config.projects.push({ id: PROJECT, name: PROJECT, path: f.source, source: { mode: "github", repository: "example/app", baseBranch: "main" }, team: SETTINGS } as never);
  const config = f.host.config;
  config.teams = { ...config.teams, lineup: LINEUP } as Config["teams"];
  const inner = launcherEvalIdentity(() => config.eval?.member, { hostUid: UID + 2, graceMs: 5_000 });
  const identity: EvalIdentity = { ...inner, probe: async () => ({ ...READY, uid: UID + 1 }) };
  const service = await f.openTeamService({ events: { flush: () => ({ stored: true }), advance: () => ({ pending: false, blocked: [] }) } as never });
  const rig = makeRig({
    mode, identity, teams: () => service, config: target => { Object.assign(target, config); },
    prepare: async (_r, ctx) => {
      const work = join(evalRoot, "trials", ctx.trialId, "work");
      mkdirSync(join(evalRoot, "trials", ctx.trialId), { recursive: true, mode: 0o700 });
      git(evalRoot, "clone", "--quiet", f.source, work);
      writeFileSync(join(f.receipts, `${ctx.trialId}.mode`), JSON.stringify({ mode }), { mode: 0o600 });
      return { kind: "ready", baseCommit: f.base, workspace: work, hiddenFiles: [], isolation: "isolated", capsule: CAPSULE, features: {} as never };
    },
    inventory: async () => [],
  });
  return { ...rig, f, evalRoot, service, close: async () => { rig.close(); await f.close(); } };
}

const readReceipts = (r: Real, id: string): Map<string, Buffer> => {
  const dir = join(r.f.receipts, id, "read");
  const files = new Map<string, Buffer>();
  if (existsSync(dir)) for (const name of readdirSync(dir)) if (!name.startsWith(".")) files.set(name, readFileSync(join(dir, name)));
  return files;
};

test("a real judge run is recorded by the pump", { timeout: 300_000 }, async () => {
  const r = await realRig("prefer-a");
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 1, { ms: 240_000, pause: 200 });
    const first = rowsOf(r, id)[0]!;
    assert.equal(first.state, "final");
    assert.equal(first.ending, "judged");
    assert.equal(first.preferred, "A");
    assert.deepEqual(first.rubric, { a: SCORES, b: { ...SCORES, correctness: 2 } });
    assert.equal(r.service.replayIds().includes(first.judgementId), false, "the run is forgotten");
    assert.deepEqual(readdirSync(join(r.evalRoot, "trials")), [], "the identity's trials root is empty after the judgement");
  } finally {
    await r.close();
  }
});

test("the package reaches the judge", { timeout: 300_000 }, async () => {
  const r = await realRig("prefer-resolved");
  try {
    const id = calibrate(r);
    await until(r, () => finalCount(r, id) >= 2, { ms: 280_000, pause: 200 });
    const rows = rowsOf(r, id).filter(row => row.state === "final");
    assert.ok(rows.length >= 2, "both orderings of pair 0 ran");
    assert.deepEqual(rows.map(row => row.ending), rows.map(() => "judged"));
    assert.deepEqual(rows.map(row => row.ordering).sort(), [0, 1].sort());
    const view = viewOf(r, id);
    const forbidden = [JUDGE.id, JUDGE.label, id, taskOf(0), trialOf(0, true), trialOf(0, false), "claude-haiku-5-5"];
    for (const row of rows) {
      const read = readReceipts(r, row.judgementId);
      for (const name of ["context.json", "package.A.patch", "package.B.patch", "package.task.json", "package.gate.json"]) assert.ok(read.has(name), `the judge read ${name}`);
      const resolvedBytes = patchOf(0, true), unresolvedBytes = patchOf(0, false);
      assert.equal(read.get("package.A.patch")!.equals(row.resolvedIsA ? resolvedBytes : unresolvedBytes), true, `ordering ${row.ordering}: A holds the right patch`);
      assert.equal(read.get("package.B.patch")!.equals(row.resolvedIsA ? unresolvedBytes : resolvedBytes), true, `ordering ${row.ordering}: B holds the right patch`);
      // The fixture judge picked the label that holds the resolved patch, and the job read it as resolved.
      assert.equal(row.preferred, row.resolvedIsA ? "A" : "B");
      for (const [name, bytes] of read) {
        const text = bytes.toString("utf8");
        for (const word of forbidden) assert.equal(text.includes(word), false, `${name} of ordering ${row.ordering} holds ${word}`);
      }
    }
    assert.ok(view.status === "running", "the calibration still runs");
  } finally {
    await r.close();
  }
});
