import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEvalClientCommand, evalJobLines, evalPriorLines, evalReportLines, evalStatusLines, type EvalApi } from "../packages/host/src/eval-cli.js";
import type { BaselineJobView, ComparisonJobView, ComparisonReport, EvalJobView, EvalSummary, ReplayPrior } from "../packages/host/src/eval-types.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const zero = { visited: 0, valid: 0, rejected: 0, retired: 0, undecided: 0 };
const counts = (captured: number, candidate: number) => ({ captured, candidate, valid: 0, rejected: 0, retired: 0 });

function fakeApi(respond: (path: string, body?: unknown, method?: string) => unknown) {
  const calls: { path: string; body?: unknown; method?: string }[] = [];
  const api: EvalApi = {
    json: async <T>(path: string, body?: unknown, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string) => {
      calls.push({ path, body, method });
      return respond(path, body, method) as T;
    },
  };
  return { api, calls };
}

const job: EvalJobView = {
  jobId: JOB_ID, projectId: "proj-1", kind: "validate", status: "running", reason: null, waiting: "grader",
  createdAt: "2026-11-16T10:00:00.000Z", startedAt: null, expiresAt: "2026-11-17T10:00:00.000Z", finishedAt: null, counts: zero,
};

const summary: EvalSummary = {
  projectId: "proj-1\u001b[2J",
  capture: { on: true },
  mining: { on: true, state: "mining", visited: null, mined: 3, skipped: 1, failures: 0, backfillDone: false },
  tasks: { byState: counts(2, 1) as EvalSummary["tasks"]["byState"], byOrigin: { captured: counts(2, 0), mined: counts(0, 1) } as EvalSummary["tasks"]["byOrigin"], byArea: [], bySet: null },
  groups: { total: 3, devOnly: 1, largest: 2, holdout: 0, exposed: 0 },
  coverage: null,
  grader: { state: "ready" },
  jobs: [job],
};

test("status prints only ids, states, and counts", () => {
  assert.deepEqual(evalStatusLines(summary), [
    "proj-1 [2J",
    "capture on · mining mining (visited unknown, mined 3, skipped 1, failures 0)",
    "states: captured 2 · candidate 1 · valid 0 · rejected 0 · retired 0",
    "mined: captured 0 · candidate 1 · valid 0 · rejected 0 · retired 0",
    "groups 3 (dev-only 1, largest 2, holdout 0, exposed 0)",
    "coverage unknown",
    "grader ready",
    `job ${JOB_ID} running · waiting grader`,
    "visited 0, valid 0, rejected 0, retired 0, undecided 0",
  ]);
});

test("status prints the eval identity and trials", () => {
  const withTrials: EvalSummary = { ...summary, grader: { state: "ready", version: 2 }, evalIdentity: { state: "busy" }, trials: { today: 2, dailyCap: 6 } };
  const lines = evalStatusLines(withTrials);
  assert.equal(lines[lines.indexOf("grader ready") + 1], "eval identity busy");
  assert.equal(lines[lines.indexOf("eval identity busy") + 1], "trials today 2 of 6");
  assert.ok(lines.includes("grader ready"));

  const off = evalStatusLines({ ...withTrials, trials: { today: 0, dailyCap: null } });
  assert.ok(off.includes("trials off"));
  assert.ok(!off.some(line => line.startsWith("trials today")));

  const version1 = evalStatusLines({ ...withTrials, grader: { state: "ready", version: 1 } });
  assert.ok(version1.includes("grader ready (version 1: no trials)"));
  assert.ok(!version1.includes("grader ready"));

  const busy = evalStatusLines({ ...withTrials, grader: { state: "busy", version: 1 } as unknown as EvalSummary["grader"] });
  assert.ok(busy.includes("grader busy"));
  assert.ok(!busy.some(line => line.includes("version 1: no trials")));
});

test("job prints baseline counts", () => {
  const baseline: BaselineJobView = {
    jobId: JOB_ID, projectId: "proj-1", kind: "baseline", status: "running", reason: null, waiting: "grader",
    createdAt: "2026-11-16T10:00:00.000Z", startedAt: null, expiresAt: "2026-11-17T10:00:00.000Z", finishedAt: null,
    tasks: { planned: 5, reached: 4, skipped: 1 },
    trials: { planned: 15, started: 6, graded: 5, resolved: 4, ended: 5, void: 1 },
    dailyCap: 6,
  };
  assert.deepEqual(evalJobLines(baseline), [
    `job ${JOB_ID} running · waiting grader`,
    "tasks 4 of 5 (skipped 1) · trials started 6 of 15, graded 5, resolved 4, ended 5, void 1",
  ]);
  const unknown = evalJobLines({ ...baseline, trials: { ...baseline.trials, void: null as unknown as number } });
  assert.equal(unknown[1], "tasks 4 of 5 (skipped 1) · trials started 6 of 15, graded 5, resolved 4, ended 5, void unknown");
  assert.deepEqual(evalJobLines(job), [`job ${JOB_ID} running · waiting grader`, "visited 0, valid 0, rejected 0, retired 0, undecided 0"]);
});

test("run sends the file and the request id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-eval-cli-"));
  try {
    const good = join(dir, "job.json");
    writeFileSync(good, JSON.stringify({ kind: "validate", limits: { maxWallMinutes: 10 } }));
    const { api, calls } = fakeApi(() => ({ created: true, job }));
    await handleEvalClientCommand(["run", "proj-1"], { "--file": good, "--request-id": REQUEST_ID }, api);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/eval/jobs");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { projectId: "proj-1", requestId: REQUEST_ID, job: { kind: "validate", limits: { maxWallMinutes: 10 } } });

    const refused = async (options: Record<string, string>, file: string, message: RegExp) => {
      const probe = fakeApi(() => ({ created: true, job }));
      await assert.rejects(handleEvalClientCommand(["run", "proj-1"], options, probe.api), message, file);
      assert.equal(probe.calls.length, 0, `no call for ${file}`);
    };
    await refused({ "--file": good }, "a missing request id", /Usage: infinite eval run/);
    await refused({ "--file": good, "--request-id": "not-a-uuid" }, "an invalid request id", /Usage: infinite eval run/);

    const large = join(dir, "large.json");
    writeFileSync(large, JSON.stringify({ kind: "validate", pad: "x".repeat(65 * 1024) }));
    await refused({ "--file": large, "--request-id": REQUEST_ID }, "a 65 KiB file", /larger than 64 KiB/);

    const notJson = join(dir, "bad.json");
    writeFileSync(notJson, "{ not json");
    await refused({ "--file": notJson, "--request-id": REQUEST_ID }, "a file that is not JSON", /not valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an absent eval route asks for a host upgrade", async () => {
  const { api } = fakeApi(() => { throw Object.assign(new Error("Host returned HTTP 404."), { status: 404 }); });
  await assert.rejects(handleEvalClientCommand(["status", "proj-1"], {}, api),
    (error: Error) => error.message === "This host has no eval routes. Upgrade the host first.");
});

const pair = {
  a: 0, b: 1, n: 12, mean: 7 / 36, interval: [2 / 36, 12 / 36] as [number, number],
  sign: { wins: 7, losses: 1, ties: 4, p: 0.0703125 }, holm: 0.0703125,
  detectable: { observed: 0.214, planning: [0.283, 0.332] as [number, number] },
};

function report(overrides: Partial<ComparisonReport> = {}): ComparisonReport {
  return {
    jobId: JOB_ID, projectId: "proj-1", kind: "compare", set: "dev", source: "replay", metric: "resolved",
    status: "completed", reason: "done", generatedAt: "2026-11-21T10:00:00.000Z", trialsPerTask: 3, conclusive: true,
    tasks: { planned: 12, analysed: 12, leftHoldout: 0 },
    configurations: [
      { index: 0, profileId: "light-a", provider: "codex", profileEpoch: 1, promptVersion: "a".repeat(64) },
      { index: 1, profileId: "light-b", provider: "claude", profileEpoch: 1, promptVersion: "b".repeat(64) },
    ],
    pairs: [pair],
    sensitivity: [{ a: 0, b: 1, n: 10, mean: 1 / 6 }],
    attrition: [
      { configuration: 0, void: { "void-limit": 0, "void-host": 0, "void-owner": 0 }, changed: 1, short: 1 },
      { configuration: 1, void: { "void-limit": 0, "void-host": 0, "void-owner": 0 }, changed: 0, short: 0 },
    ],
    cost: [
      { configuration: 0, trials: 4, resolved: 2, costed: 3, tokensPerResolved: 4500, spentUsdPerResolved: 2.25, listUsdPerResolved: null, minutesPerResolved: 30 },
      { configuration: 1, trials: 4, resolved: 3, costed: 4, tokensPerResolved: null, spentUsdPerResolved: null, listUsdPerResolved: null, minutesPerResolved: null },
    ],
    byPromptOrigin: [{ promptOrigin: "assignment", n: 6, pairs: [{ ...pair, mean: 0.2777778, interval: [0.1111111, 0.4444444], sign: { wins: 3, losses: 0, ties: 3, p: 0.125 } }] }],
    byArea: [{ area: "host", n: 6, pairs: [{ ...pair, mean: null, interval: null }] }],
    ...overrides,
  };
}

test("the report prints its figures", async () => {
  const lines = evalReportLines(report());
  assert.equal(lines[0], `report ${JOB_ID} compare (dev set) · completed · done · 3 trials per task`);
  assert.equal(lines[1], "tasks 12 of 12 analysed (100%) · share rule met");
  assert.equal(lines[2], "configuration 0: light-a (codex, epoch 1)");
  assert.equal(lines[4], "1 vs 0: +0.194 [+0.056, +0.333] · sign 7-1-4, p 0.0703 (Holm 0.0703) · detectable 0.214 (planning 0.283 to 0.332)");
  assert.ok(lines.includes("attrition 0: void-limit 0, void-host 0, void-owner 0, changed 1, short 1"));
  assert.ok(lines.includes("cost 0: 4 trials, 2 resolved · per resolved: tokens 4500, spent USD 2.25, list USD unknown, minutes 30.0 (complete cost for 3 of 4)"));
  assert.ok(lines.includes("cost 1: 4 trials, 3 resolved · per resolved: tokens unknown, spent USD unknown, list USD unknown, minutes unknown (complete cost for 4 of 4)"));
  assert.ok(lines.includes("by prompt origin assignment (n 6): 1 vs 0 +0.278 [+0.111, +0.444], p 0.1250"));
  assert.ok(lines.includes("by area host (n 6): 1 vs 0 unknown unknown, p 0.0703"));

  const { api, calls } = fakeApi(() => report());
  await handleEvalClientCommand(["report", JOB_ID], {}, api);
  assert.equal(calls[0].path, `/eval/jobs/${JOB_ID}/report`);
});

test("an inconclusive report says so", () => {
  const lines = evalReportLines(report({ conclusive: false, tasks: { planned: 10, analysed: 8, leftHoldout: 0 } }));
  assert.equal(lines[1], "tasks 8 of 10 analysed (80%) · inconclusive: under 90% of tasks kept every valid trial");
  assert.ok(lines.includes("sensitivity 1 vs 0: +0.167 over 10 tasks"));
});

test("the share rounds down, so it never reaches 90% by rounding", () => {
  const lines = evalReportLines(report({ conclusive: false, tasks: { planned: 200, analysed: 179, leftHoldout: 0 } }));
  assert.equal(lines[1], "tasks 179 of 200 analysed (89%) · inconclusive: under 90% of tasks kept every valid trial");
  const met = evalReportLines(report({ conclusive: true }));
  assert.ok(met[1].endsWith("share rule met"));
  assert.equal(met[1].includes("· conclusive"), false);
});

const prior = (over: Partial<ReplayPrior> = {}): ReplayPrior => ({
  projectId: "proj-1", profileId: "light-a", profile: { provider: "codex", model: "model-x", effort: "low" },
  profileEpoch: 1, promptVersion: "1a2b3c4d" + "0".repeat(56), role: "implementer", area: "host", kind: "feature", tasks: 6, trials: 18,
  resolved: 7, source: "replay", promptOrigin: "assignment", generatedAt: "2026-11-21T10:00:00.000Z", jobId: JOB_ID, ...over,
});

test("the priors print one line per row", async () => {
  const lines = evalPriorLines([prior(), prior({ kind: null, profile: { provider: "claude", model: null, effort: null } })]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `light-a codex/model-x/low epoch 1 · prompt 1a2b3c4d · area host · kind feature · origin assignment: 7 of 18 trials resolved over 6 tasks · ${JOB_ID} · 2026-11-21T10:00:00.000Z`);
  assert.ok(lines[1].startsWith("light-a claude/unknown/unknown epoch 1"));
  assert.ok(lines[1].includes("kind none"));
  assert.deepEqual(evalPriorLines([]), ["no priors"]);

  const { api, calls } = fakeApi(() => ({ projectId: "proj-1", priors: [] }));
  await handleEvalClientCommand(["priors", "proj-1"], {}, api);
  assert.equal(calls[0].path, "/eval/projects/proj-1/priors");
});

test("a comparison job hides its result until the report", () => {
  const view: ComparisonJobView = {
    jobId: JOB_ID, projectId: "proj-1", kind: "compare", status: "running", reason: null, waiting: null,
    createdAt: "2026-11-21T10:00:00.000Z", startedAt: null, expiresAt: "2026-11-22T10:00:00.000Z", finishedAt: null,
    tasks: { planned: 20, reached: 3, skipped: 0 }, dailyCap: 6, set: "dev", report: null,
    trials: { planned: 60, started: 9, graded: 8, resolved: null, ended: 0, void: 1, reused: 12 },
  };
  assert.equal(evalJobLines(view)[1], "tasks 3 of 20 (skipped 0) · trials started 9 of 60, graded 8, resolved hidden, ended 0, void 1, reused 12");
  const pending = evalJobLines({ ...view, status: "completed", report: "pending" })[1];
  assert.equal(pending, "tasks 3 of 20 (skipped 0) · trials started 9 of 60, graded 8, resolved hidden, ended 0, void 1, reused 12 · report pending");
  const ready = evalJobLines({ ...view, status: "completed", report: "ready", trials: { ...view.trials, resolved: 5 } })[1];
  assert.ok(ready.endsWith("resolved 5, ended 0, void 1, reused 12 · report ready"));
});

test("text from the host is cleaned", () => {
  const dirty = report({ configurations: [{ index: 0, profileId: "a\u001b[2Jb", provider: "x\ny", profileEpoch: 1, promptVersion: "c" }] });
  assert.equal(evalReportLines(dirty)[2], "configuration 0: a [2Jb (x y, epoch 1)");
  assert.ok(evalPriorLines([prior({ profileId: "p\u0007q" })])[0].startsWith("p q codex/"));
});

test("the status prints the sets", () => {
  const lines = evalStatusLines({ ...summary, tasks: { ...summary.tasks, bySet: { dev: 5, holdout: 2 } }, groups: { ...summary.groups, holdout: 1, exposed: 1 } });
  assert.ok(lines.includes("sets dev 5 · holdout 2"));
  assert.ok(lines.includes("groups 3 (dev-only 1, largest 2, holdout 1, exposed 1)"));
});

test("status says what the last identity probe answered when it has aged out", () => {
  const base: EvalSummary = { ...summary, trials: { today: 0, dailyCap: 6 } };
  const lines = (evalIdentity: unknown) => evalStatusLines({ ...base, evalIdentity } as EvalSummary);
  assert.ok(lines({ state: "unavailable", lastProbe: { state: "misconfigured", at: "2026-11-22T01:00:00.000Z" } }).includes("eval identity unavailable (last probe misconfigured, 2026-11-22T01:00:00.000Z)"));
  assert.ok(lines({ state: "unavailable", lastProbe: null }).includes("eval identity unavailable (not probed)"));
  assert.ok(lines({ state: "unavailable" }).includes("eval identity unavailable"), "an older host says nothing it cannot know");
  assert.ok(lines({ state: "misconfigured" }).includes("eval identity misconfigured"));
});
