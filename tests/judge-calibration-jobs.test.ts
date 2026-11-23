import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { evalCorpusModule } from "../packages/host/src/eval-store.js";
import { evalTrialsModule, finishTrial, insertTrial, openTrialCounts, startTrial } from "../packages/host/src/eval-trial-store.js";
import { configRef, TRIAL_HARNESS_VERSION, trialProfileKey } from "../packages/host/src/eval-trial-rules.js";
import { advanceEpoch, configurationModule } from "../packages/host/src/configuration-store.js";
import { judgeCalibrationsModule, calibrationJudgements, readCalibration } from "../packages/host/src/judge-store.js";
import { labelDraw } from "../packages/host/src/judge-package.js";
import { JudgeCalibrations, type JudgementOutcome, type NextJudgement } from "../packages/host/src/judge-calibration-jobs.js";
import type { TrialGates } from "../packages/host/src/eval-trial-jobs.js";
import type { TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";

const T0 = "2026-11-22T00:00:00.000Z";
const JOB = "job-1";
const DAY_MS = 86_400_000;
const JUDGE = { id: "zz-judge", label: "Judge", provider: "codex", model: "judge-model", effort: "high", tier: "strong" } as TeamModelProfile;
const OTHER = { id: "zz-other", label: "Other", provider: "claude", model: "other-model", effort: "high", tier: "strong" } as TeamModelProfile;
const SCORES = { correctness: 3, cleanliness: 3, extensibility: 3, docs: 3 };

type Fixture = { store: EvidenceStore; close: () => void; seq: { n: number }; clock: { at: string }; jobs: JudgeCalibrations };
type Start = Extract<NextJudgement, { kind: "start" }>;

function configOf(patch: Record<string, unknown> = {}): Config {
  return {
    projects: [
      { id: "P", team: { eval: { trialsPerDay: 2 } } },
      { id: "Q", team: { eval: {} } },
      { id: "R", team: {} },
    ],
    teams: { lineup: { judge: JUDGE } },
    eval: { member: { agents: { codex: { command: "agent", args: [] } } } },
    ...patch,
  } as unknown as Config;
}

function ready(config: Config = configOf()): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-judge-jobs-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  const clock = { at: T0 };
  const now = () => clock.at;
  store.register(evalCorpusModule(store, now));
  store.register(evalTrialsModule(store, now));
  store.register(configurationModule());
  store.register(judgeCalibrationsModule(store, now));
  store.write(tx => openTrialCounts(tx, JOB, { tasks: 1, trials: 1000 }));
  return { store, seq: { n: 0 }, clock, jobs: new JudgeCalibrations({ store, config, now }), close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function grade(resolved: boolean): TrialGrade {
  return { ending: "graded", expectedPassed: resolved ? 1 : 0, expectedTotal: 1, guardPassed: true, resolved, overwritten: 0, diff: null, isolation: "isolated" };
}

function addGroup(f: Fixture, project: string, id: string, holdout: number): void {
  f.store.write(tx => {
    tx.run(
      "INSERT INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at, confirms, exposed) VALUES (?, 'run', ?, ?, ?, ?, ?, 0, 0)",
      id, tx.index("project", project), id, T0, holdout, holdout === 1 ? T0 : null,
    );
  });
}

function addTask(f: Fixture, project: string, taskId: string, groupId: string): void {
  f.store.write(tx => {
    tx.run(
      "INSERT INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, material, base, captured_at, checked_at, payload, group_id) "
      + "VALUES (?, 'captured', '', '', ?, 'valid', 'stored', 'proven', ?, ?, 'x', ?)",
      taskId, tx.index("project", project), T0, T0, groupId,
    );
  });
}

function addTrial(f: Fixture, project: string, taskId: string, resolved: boolean, profile: TeamModelProfile): string {
  const trialId = `trial-${f.seq.n++}`;
  const configuration: TrialConfiguration = { profile, guidance: "as-of-base", knowledge: "none" };
  f.store.write(tx => {
    insertTrial(tx, { trialId, jobId: JOB, taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot: f.seq.n, attempt: 0,
      projectId: project, configuration, keepDays: 365 }, T0);
    startTrial(tx, trialId, T0);
    finishTrial(tx, trialId, { grade: grade(resolved), configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90, patch: Buffer.from(`patch-${trialId}`) }, T0);
  });
  return trialId;
}

/** Seeds `count` dev pairs for a project. `ownModel` lists task numbers whose resolved trial used the judge's own model. */
function seedPairs(f: Fixture, project: string, count: number, ownModel: number[] = []): void {
  for (let i = 0; i < count; i++) {
    const taskId = `t-${project}-${String(i).padStart(3, "0")}`;
    addGroup(f, project, `g-${taskId}`, 0);
    addTask(f, project, taskId, `g-${taskId}`);
    addTrial(f, project, taskId, true, ownModel.includes(i) ? JUDGE : OTHER);
    addTrial(f, project, taskId, false, OTHER);
  }
}

const gates = (patch: Partial<TrialGates> = {}): TrialGates => ({
  identity: { state: "ready" }, grader: { state: "ready" }, hostLoadHeld: false, halted: () => false, limited: new Set(),
  freeSlots: async () => 8, trialLive: false, ...patch,
} as TrialGates);

const body = (patch: Record<string, unknown> = {}) => ({ requestId: "request-1", judgeProfileId: JUDGE.id, ...patch });

function created(f: Fixture, patch: Record<string, unknown> = {}): string {
  const made = f.jobs.create(body(patch));
  assert.equal("calibration" in made, true, JSON.stringify(made));
  return "calibration" in made ? made.calibration.calibrationId : "";
}

const judged = (start: Start, correct: boolean): JudgementOutcome => ({
  ending: "judged",
  judgement: { preferred: start.resolvedIsA === correct ? "A" : "B", rubric: { a: SCORES, b: SCORES } },
  sessionId: null,
});

/** Runs every start the job hands out, up to `max`, and returns them. */
async function drive(f: Fixture, decide: (start: Start) => JudgementOutcome, max = 500): Promise<Start[]> {
  const starts: Start[] = [];
  for (let i = 0; i < max; i++) {
    const next = await f.jobs.next(gates());
    if (next.kind !== "start") return starts;
    starts.push(next);
    assert.equal(f.jobs.begin(next), "inserted");
    f.jobs.finish(next.judgementId, decide(next));
  }
  assert.fail("the job kept handing out judgements");
}

const rowsOf = (f: Fixture, id: string) => f.store.read(db => calibrationJudgements(db, id));
const view = (f: Fixture) => f.jobs.views()[0]!;

test("no judge in the lineup refuses", () => {
  const f = ready(configOf({ teams: { lineup: {} } }));
  try {
    const refused = f.jobs.create(body());
    assert.equal("code" in refused && refused.code, "judge-not-configured");
    assert.equal("status" in refused && refused.status, 409);
    assert.deepEqual(f.jobs.views(), []);
  } finally { f.close(); }
});

test("a judge profile ID that differs refuses", () => {
  const f = ready();
  try {
    const refused = f.jobs.create(body({ judgeProfileId: "zz-elsewhere" }));
    assert.equal("code" in refused && refused.code, "judge-profile-mismatch");
  } finally { f.close(); }
});

test("a judge provider with no eval launch refuses", () => {
  const f = ready(configOf({ eval: { member: { agents: { claude: { command: "agent", args: [] } } } } }));
  try {
    const refused = f.jobs.create(body());
    assert.equal("code" in refused && refused.code, "judge-launch-missing");
  } finally { f.close(); }
});

test("a body that does not parse refuses", () => {
  const f = ready();
  try {
    for (const bad of [{ judgeProfileId: JUDGE.id }, body({ pairs: 29 }), body({ pairs: 61 }), body({ extra: 1 }), body({ judgeMinutes: 1 }), body({ projects: [] }),
      body({ expiresAt: new Date(Date.parse(T0) + 31 * DAY_MS).toISOString() })]) {
      const refused = f.jobs.create(bad);
      assert.equal("code" in refused && refused.code, "invalid-calibration-request", JSON.stringify(bad));
    }
  } finally { f.close(); }
});

test("a named project without an eval block refuses", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    const refused = f.jobs.create(body({ projects: ["P", "R"] }));
    assert.equal("code" in refused && refused.code, "eval-config-incomplete");
  } finally { f.close(); }
});

test("29 available pairs refuse and store nothing", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 29);
    const refused = f.jobs.create(body());
    assert.equal("code" in refused && refused.code, "too-few-pairs");
    assert.deepEqual(f.jobs.views(), []);
  } finally { f.close(); }
});

test("30 pairs across two projects pool", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 18);
    seedPairs(f, "Q", 12);
    const id = created(f);
    const made = f.jobs.views()[0]!;
    assert.equal(made.pairs.planned, 30);
    assert.deepEqual(made.pairs.perProject, [{ projectId: "P", pairs: 18 }, { projectId: "Q", pairs: 12 }]);
    assert.equal(made.status, "running");
    assert.equal(made.calibrationId, id);
  } finally { f.close(); }
});

test("the pairs of one project are handed out together", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 18);
    seedPairs(f, "Q", 12);
    created(f);
    const starts = await drive(f, start => judged(start, true));
    assert.equal(starts.length, 60);
    const runs = starts.map(start => start.projectId).filter((project, at, all) => at === 0 || all[at - 1] !== project);
    assert.deepEqual(runs, ["P", "Q"]);
  } finally { f.close(); }
});

test("a named project limits the pool", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 18);
    seedPairs(f, "Q", 12);
    const refused = f.jobs.create(body({ projects: ["P"] }));
    assert.equal("code" in refused && refused.code, "too-few-pairs");
  } finally { f.close(); }
});

test("pairs judged by the judge's own model are skipped", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 31, [0]);
    const id = created(f);
    const tasks = f.store.read(db => readCalibration(db, id)?.payload.pairs.map(pair => pair.taskId) ?? []);
    assert.equal(tasks.length, 30);
    assert.equal(tasks.includes("t-P-000"), false);
  } finally { f.close(); }
});

test("a holdout task never pairs", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    addGroup(f, "P", "g-hold", 1);
    addTask(f, "P", "t-P-hold", "g-hold");
    addTrial(f, "P", "t-P-hold", true, OTHER);
    addTrial(f, "P", "t-P-hold", false, OTHER);
    const id = created(f, { pairs: 30 });
    const tasks = f.store.read(db => readCalibration(db, id)?.payload.pairs.map(pair => pair.taskId) ?? []);
    assert.equal(tasks.includes("t-P-hold"), false);
  } finally { f.close(); }
});

test("each pair gets both label orders", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    const id = created(f);
    const first = await f.jobs.next(gates());
    assert.equal(first.kind, "start");
    if (first.kind !== "start") return;
    assert.equal(first.pairIndex, 0);
    assert.equal(first.ordering, 0);
    assert.equal(first.attempt, 0);
    assert.equal(first.resolvedIsA, labelDraw(`${id}:0`) === 0);
    f.jobs.begin(first);
    f.jobs.finish(first.judgementId, judged(first, true));
    const second = await f.jobs.next(gates());
    assert.equal(second.kind === "start" && second.pairIndex, 0);
    assert.equal(second.kind === "start" && second.ordering, 1);
    assert.equal(second.kind === "start" && second.resolvedIsA, !first.resolvedIsA);
    assert.notEqual(second.kind === "start" && second.resolvedTrialId, second.kind === "start" && second.unresolvedTrialId);
  } finally { f.close(); }
});

test("a second calibration waits its turn", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    const refused = f.jobs.create(body({ requestId: "request-2" }));
    assert.equal("code" in refused && refused.code, "calibration-active");
  } finally { f.close(); }
});

test("a repeated request returns the same calibration", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 31);
    const id = created(f);
    const again = f.jobs.create(body());
    assert.equal("calibration" in again && again.calibration.calibrationId, id);
    const conflict = f.jobs.create(body({ pairs: 31 }));
    assert.equal("code" in conflict && conflict.code, "request-conflict");
    assert.equal(f.jobs.views().length, 1);
  } finally { f.close(); }
});

test("an ordering out of retries drops its pair at once", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 36);
    const id = created(f);
    const starts = await drive(f, start => start.pairIndex === 0 ? { ending: "void-host", sessionId: null } : judged(start, true));
    const zero = starts.filter(start => start.pairIndex === 0);
    assert.deepEqual(zero.map(start => [start.ordering, start.attempt]), [[0, 0], [0, 1], [0, 2]]);
    assert.equal(starts[3]?.pairIndex, 1);
    assert.equal(rowsOf(f, id).filter(row => row.pairIndex === 0).length, 3);
    assert.equal(rowsOf(f, id).some(row => row.pairIndex === 0 && row.ordering === 1), false);
    const done = view(f);
    assert.equal(done.status, "completed");
    assert.equal(done.pairs.counted, 35);
    assert.equal(done.pairs.correct, 35);
    assert.equal(done.state, "ok");
  } finally { f.close(); }
});

test("a calibration that cannot reach 30 counted pairs ends early", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    const starts = await drive(f, start => start.pairIndex === 0 ? { ending: "void-host", sessionId: null } : judged(start, true));
    assert.equal(starts.length, 3);
    const done = view(f);
    assert.equal(done.status, "completed");
    assert.equal(done.state, "not-ok");
    assert.equal(done.reason, "pairs-dropped");
    assert.equal(done.pairs.counted, 0);
  } finally { f.close(); }
});

test("a calibration whose last pair drops says why", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    await drive(f, start => start.pairIndex === 29 ? { ending: "void-host", sessionId: null } : judged(start, true));
    const done = view(f);
    assert.equal(done.status, "completed");
    assert.equal(done.pairs.counted, 29);
    assert.equal(done.state, "not-ok");
    assert.equal(done.reason, "pairs-dropped");
  } finally { f.close(); }
});

test("a judge failure counts the pair incorrect", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    await drive(f, start => start.pairIndex === 0 && start.ordering === 1 ? { ending: "timeout", sessionId: null } : judged(start, true));
    const done = view(f);
    assert.equal(done.pairs.counted, 30);
    assert.equal(done.pairs.correct, 29);
  } finally { f.close(); }
});

test("a dropped judgement drops the pair without a second ordering", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 36);
    const id = created(f);
    const starts = await drive(f, start => start.pairIndex === 0 ? { dropped: "patch-missing" } : judged(start, true));
    assert.equal(starts.filter(start => start.pairIndex === 0).length, 1);
    assert.equal(rowsOf(f, id)[0]?.state, "dropped");
    assert.equal(view(f).pairs.counted, 35);
  } finally { f.close(); }
});

test("the last pair completes the calibration", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    await drive(f, start => judged(start, start.pairIndex < 24));
    const done = view(f);
    assert.equal(done.status, "completed");
    assert.equal(done.state, "ok");
    assert.equal(done.pairs.correct, 24);
    assert.equal(done.pairs.counted, 30);
    assert.equal(done.validUntil, new Date(Date.parse(T0) + 60 * DAY_MS).toISOString());
    assert.equal(done.completedAt, T0);
    assert.equal((await f.jobs.next(gates())).kind, "idle");
  } finally { f.close(); }
});

test("a moved epoch cancels the job", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    f.clock.at = "2026-11-22T01:00:00.000Z";
    advanceEpoch(f.store, { profile: trialProfileKey(JUDGE), requestId: "11111111-1111-4111-8111-111111111111", now: f.clock.at });
    assert.equal((await f.jobs.next(gates())).kind, "idle");
    const done = view(f);
    assert.equal(done.status, "cancelled");
    assert.equal(done.reason, "identity-changed");
    assert.equal(done.state, null);
    assert.deepEqual(f.jobs.running(), []);
  } finally { f.close(); }
});

test("an owner cancel ends the job with no state", () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    const id = created(f);
    const cancelled = f.jobs.cancel(id);
    assert.equal("calibration" in cancelled && cancelled.calibration.status, "cancelled");
    assert.equal("calibration" in cancelled && cancelled.calibration.state, null);
    const unknown = f.jobs.cancel("nope");
    assert.equal("code" in unknown && unknown.code, "unknown-calibration");
    assert.equal("status" in unknown && unknown.status, 404);
  } finally { f.close(); }
});

test("sweep expires a running calibration past its expiry", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f, { expiresAt: new Date(Date.parse(T0) + DAY_MS).toISOString() });
    f.jobs.sweep();
    assert.equal(view(f).status, "running");
    f.clock.at = new Date(Date.parse(T0) + 2 * DAY_MS).toISOString();
    f.jobs.sweep();
    assert.equal(view(f).status, "expired");
    assert.equal(view(f).state, null);
    assert.equal((await f.jobs.next(gates())).kind, "idle");
  } finally { f.close(); }
});

test("the sweep deletes a calibration and its judgements after 365 days", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    const id = created(f);
    const next = await f.jobs.next(gates());
    assert.equal(next.kind, "start");
    if (next.kind === "start") f.jobs.begin(next);
    f.jobs.cancel(id);
    const rows = () => f.store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM judge_judgements")!.n);
    f.clock.at = new Date(Date.parse(T0) + 364 * DAY_MS).toISOString();
    f.jobs.sweep();
    assert.equal(f.jobs.views().length, 1, "a calibration younger than 365 days stays");
    assert.equal(rows(), 1);
    f.clock.at = new Date(Date.parse(T0) + 366 * DAY_MS).toISOString();
    f.jobs.sweep();
    assert.equal(f.jobs.views().length, 0, "the calibration is deleted");
    assert.equal(rows(), 0, "and its judgements");
  } finally { f.close(); }
});

test("the worst case spends exactly the request", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 36);
    created(f);
    let begun = 0;
    for (let i = 0; i < 300; i++) {
      const next = await f.jobs.next(gates());
      if (next.kind !== "start") break;
      f.jobs.begin(next);
      begun += 1;
      f.jobs.finish(next.judgementId, next.attempt < 2 ? { ending: "void-host", sessionId: null } : judged(next, true));
    }
    assert.equal(begun, 216);
    const done = view(f);
    assert.equal(done.status, "completed");
    assert.equal(done.pairs.counted, 36);
    assert.equal(done.pairs.planned, 36);
  } finally { f.close(); }
});

test("trials do not use up a calibration", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    const next = await f.jobs.next(gates());
    assert.equal(next.kind, "start");
  } finally { f.close(); }
});

test("a gate that does not hold makes the job wait", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    const cases: [Partial<TrialGates>, string][] = [
      [{ identity: { state: "unavailable" } as TrialGates["identity"] }, "eval-identity"],
      [{ grader: { state: "unavailable" } as TrialGates["grader"] }, "grader"],
      [{ hostLoadHeld: true }, "host-load"],
      [{ halted: () => true }, "halt"],
      [{ limited: new Set(["codex"]) as TrialGates["limited"] }, "provider-limit"],
      [{ trialLive: true }, "another-job"],
      [{ freeSlots: async () => 0 }, "session-slots"],
    ];
    for (const [patch, reason] of cases) {
      const next = await f.jobs.next(gates(patch));
      assert.deepEqual(next, { kind: "wait", reason });
    }
    assert.equal(rowsOf(f, f.jobs.views()[0]!.calibrationId).length, 0);
  } finally { f.close(); }
});

test("a live judgement holds the next one and begin converges", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    created(f);
    const next = await f.jobs.next(gates());
    assert.equal(next.kind, "start");
    if (next.kind !== "start") return;
    assert.equal(f.jobs.begin(next), "inserted");
    assert.equal(f.jobs.begin(next), "exists");
    assert.deepEqual(f.jobs.live().map(item => [item.judgementId, item.state]), [[next.judgementId, "preparing"]]);
    f.jobs.launched(next.judgementId, "session-1");
    assert.equal(f.jobs.live()[0]?.state, "live");
    assert.equal((await f.jobs.next(gates())).kind, "wait");
    f.jobs.finish(next.judgementId, judged(next, true));
    f.jobs.finish(next.judgementId, judged(next, false));
    const row = rowsOf(f, next.calibrationId)[0]!;
    assert.equal(row.state, "final");
    assert.equal(row.preferred, next.resolvedIsA ? "A" : "B");
  } finally { f.close(); }
});

test("the view names the gate that holds the next judgement", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    const id = created(f);
    assert.equal(view(f).waiting, null, "nothing has waited yet");
    await f.jobs.next(gates({ hostLoadHeld: true }));
    assert.equal(view(f).waiting, "host-load");
    await f.jobs.next(gates({ freeSlots: async () => 0 }));
    assert.equal(view(f).waiting, "session-slots");
    f.jobs.hold("eval-identity");
    assert.equal(view(f).waiting, "eval-identity", "a reason the pump found");
    const next = await f.jobs.next(gates());
    assert.equal(next.kind, "start");
    assert.equal(view(f).waiting, null, "a start clears the reason");
    if (next.kind !== "start") return;
    assert.equal(f.jobs.begin(next), "inserted");
    f.jobs.release(next.judgementId, "mirror");
    assert.equal(view(f).waiting, "mirror");
    assert.equal(rowsOf(f, id).length, 0, "a released start leaves no row");
    const again = await f.jobs.next(gates());
    assert.equal(again.kind === "start" ? again.judgementId : "", next.judgementId, "the same judgement runs again");
    assert.equal(again.kind === "start" ? again.attempt : -1, 0);
  } finally { f.close(); }
});

test("a calibration that is not running shows no wait reason", async () => {
  const f = ready();
  try {
    seedPairs(f, "P", 30);
    const id = created(f);
    f.jobs.hold("grader");
    const ended = f.jobs.cancel(id);
    assert.ok("calibration" in ended);
    assert.equal("calibration" in ended ? ended.calibration.waiting : "x", null, "a cancelled calibration waits on nothing");
    assert.deepEqual(await f.jobs.next(gates()), { kind: "idle" });
    f.jobs.create(body({ requestId: "request-2" }));
    assert.equal(f.jobs.views()[0]!.status, "running");
    assert.equal(f.jobs.views()[0]!.waiting, null, "idle forgot the old reason");
    assert.equal(f.jobs.views()[1]!.waiting, null);
  } finally { f.close(); }
});
