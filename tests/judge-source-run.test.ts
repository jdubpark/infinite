import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { configRef, TRIAL_HARNESS_VERSION, trialProfileKey } from "../packages/host/src/eval-trial-rules.js";
import { finishTrial, insertTrial, openTrialCounts, startTrial } from "../packages/host/src/eval-trial-store.js";
import { epochAt } from "../packages/host/src/configuration-store.js";
import { judgePromptVersion, profileIdentityKey } from "../packages/host/src/config-identity.js";
import { JudgeCalibrations, graderJobOf } from "../packages/host/src/judge-calibration-jobs.js";
import { calibrationJudgements, insertCalibration } from "../packages/host/src/judge-store.js";
import type { EvalHost } from "../packages/host/src/eval-host.js";
import type { TrialConfiguration, TrialGrade } from "../packages/host/src/eval-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { PROJECT, graderRecord, host, profile, serveTeam, setup, teamFixture, validated, type Setup } from "./eval-run-fixture.js";

// One calibration judgement over the real source build: EvalHost, the pump, the real prepareTrialSource, the grader and eval
// launcher fixtures, a real team service, and the fixture judge. judge-pump.test.ts scripts the source build to run 60 judgements.

const JUDGE_AGENT = resolve("tests/fixtures/judge-agent.mjs");
const JUDGE: TeamModelProfile = { id: "zz-judge-profile", label: "Label Zed", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };
const OTHER: TeamModelProfile = { id: "claude-strong", label: "Claude strong", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" };
const LINEUP = { coordinator: OTHER, integrator: OTHER, reviewer: OTHER, implementers: [OTHER], escalations: [], fallbacks: [], judge: JUDGE };
const SEED_JOB = "job-seed";
const PAIRS = 30;
const DAY_MS = 86_400_000;

/** A small unified diff; the resolved side holds the marker line the fixture judge looks for. */
const patchOf = (resolved: boolean) =>
  Buffer.from(`diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${resolved ? "RESOLVED-MARKER\n+fix" : "other"}\n`);
const grade = (resolved: boolean): TrialGrade => ({ ending: "graded", expectedPassed: resolved ? 1 : 0, expectedTotal: 1, guardPassed: true, resolved, overwritten: 0, diff: null, isolation: "isolated" });

/**
 * The rig of eval-trial-run.test.ts, with the judge as the lineup's judge and the fixture judge as the eval member's claude agent.
 * The eval root is reached through a link: the package writer refuses a linked path, so the pump must hand it the real one.
 */
async function judgeRig() {
  const s = setup({ linked: true });
  s.config.teams = { ...s.config.teams, lineup: LINEUP } as Config["teams"];
  s.config.eval!.member!.agents!.claude = { command: process.execPath, args: [JUDGE_AGENT, s.receipts] };
  const fx = await teamFixture(s);
  fx.host.config.teams = { ...fx.host.config.teams, lineup: LINEUP } as Config["teams"];
  const served = await serveTeam(s, fx);
  const h = host(s, { teams: () => served.service, sessions: served.manager });
  return { s, fx, served, h };
}

/** Two graded isolated trials of the one valid task, then a running calibration of PAIRS pairs that all name them. */
function calibrate(s: Setup): { calibrationId: string; resolved: Buffer; unresolved: Buffer } {
  const taskId = s.r.store.read(db => db.get<{ task_id: string }>("SELECT task_id FROM eval_tasks WHERE state = 'valid' ORDER BY task_id"))?.task_id;
  assert.ok(taskId, "the store holds a valid task");
  const resolved = patchOf(true), unresolved = patchOf(false);
  const trials = { resolved: "trial-judge-resolved", unresolved: "trial-judge-unresolved" };
  const at = new Date().toISOString();
  const calibrationId = randomUUID();
  const judgeKey = profileIdentityKey(trialProfileKey(JUDGE));
  s.r.store.write(tx => {
    openTrialCounts(tx, SEED_JOB, { tasks: 1, trials: 10 });
    const configuration: TrialConfiguration = { profile: OTHER, guidance: "as-of-base", knowledge: "none" };
    for (const [slot, isResolved] of [[0, true], [1, false]] as const) {
      const trialId = isResolved ? trials.resolved : trials.unresolved;
      insertTrial(tx, { trialId, jobId: SEED_JOB, taskId, configRef: configRef(configuration), harness: TRIAL_HARNESS_VERSION, slot, attempt: 0,
        projectId: PROJECT, configuration, keepDays: 365 }, at);
      startTrial(tx, trialId, at);
      finishTrial(tx, trialId, { grade: grade(isResolved), configId: null, profileEpoch: null, sessionId: null, patchKeepDays: 90,
        patch: isResolved ? resolved : unresolved }, at);
    }
    // The pins are taken as JudgeCalibrations.create takes them. create keeps one pair per task, and the fixture mirror has too few tasks.
    const inserted = insertCalibration(tx, {
      calibrationId, requestId: randomUUID(), judgeKey, profileEpoch: epochAt(tx, judgeKey, at), promptVersion: judgePromptVersion(JUDGE.provider),
      pairsPlanned: PAIRS, judgeMinutes: 10, createdAt: at, expiresAt: new Date(Date.parse(at) + DAY_MS).toISOString(),
      payload: {
        profileId: JUDGE.id, request: { requestId: "unused", judgeProfileId: JUDGE.id, pairs: PAIRS },
        pairs: Array.from({ length: PAIRS }, () => ({ projectId: PROJECT, taskId, resolvedTrialId: trials.resolved, unresolvedTrialId: trials.unresolved })),
        perProject: [{ projectId: PROJECT, pairs: PAIRS }],
      },
    });
    assert.equal(inserted, "inserted");
  });
  return { calibrationId, resolved, unresolved };
}

const rowsOf = (s: Setup, id: string) => s.r.store.read(db => calibrationJudgements(db, id));
const finals = (s: Setup, id: string) => rowsOf(s, id).filter(row => row.state === "final").length;

/** Ticks the host until `done` holds; a count and a deadline bound the loop. */
async function until(h: EvalHost, done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (let step = 0; step < 5000 && Date.now() < deadline && !done(); step++) {
    h.tick();
    await h.idle();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Cancels the calibration so no further judgement starts, then lets the one in flight end. */
async function stop(s: Setup, h: EvalHost, calibrationId: string): Promise<void> {
  new JudgeCalibrations({ store: s.r.store, config: s.config, now: () => new Date().toISOString() }).cancel(calibrationId);
  await until(h, () => rowsOf(s, calibrationId).every(row => row.state === "final" || row.state === "dropped"), 120_000);
}

const receipt = (s: Setup, judgementId: string, name: string): Buffer => readFileSync(join(s.receipts, judgementId, "read", name));

test("a judgement builds its source through the grader and the eval account", { timeout: 900_000 }, async () => {
  const { s, fx, served, h } = await judgeRig();
  try {
    await validated(h);
    const before = graderRecord(s).length;
    const { calibrationId, resolved, unresolved } = calibrate(s);
    await until(h, () => finals(s, calibrationId) >= 1, 600_000);
    const first = rowsOf(s, calibrationId).find(row => row.state === "final");
    assert.ok(first, "a judgement ended");
    assert.equal(first.state, "final");
    assert.equal(first.ending, "judged");
    const job = graderJobOf(calibrationId, PROJECT);
    const record = graderRecord(s).slice(before);
    assert.ok(record.some(entry => entry[1] === job), "the grader fixture names the calibration's grader job");
    assert.equal(record.some(entry => entry.includes(calibrationId)), false, "the grader never sees the calibration ID");
    const a = receipt(s, first.judgementId, "package.A.patch");
    assert.equal(a.equals(first.resolvedIsA ? resolved : unresolved), true, "A holds the patch the row says");
    assert.equal(served.service.replayIds().includes(first.judgementId), false, "the run is forgotten");
    await stop(s, h, calibrationId);
    assert.deepEqual(readdirSync(join(s.evalRoot, "trials")), [], "the eval account's trials root is empty after the judgement");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});

test("the same calibration's second judgement reuses the bundle", { timeout: 900_000 }, async () => {
  const { s, fx, h } = await judgeRig();
  try {
    await validated(h);
    const before = graderRecord(s).length;
    const { calibrationId } = calibrate(s);
    await until(h, () => finals(s, calibrationId) >= 2, 600_000);
    assert.ok(finals(s, calibrationId) >= 2, "two judgements ended");
    await stop(s, h, calibrationId);
    const job = graderJobOf(calibrationId, PROJECT);
    const received = graderRecord(s).slice(before).filter(entry => entry[0] === "receive" && entry[1] === job && entry[2] === "base.bundle");
    assert.equal(received.length, 1, "the bundle was received once");
  } finally {
    h.close();
    await h.idle();
    await fx.close();
    s.r.store.close();
  }
});
