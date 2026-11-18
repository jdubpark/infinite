import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEvalClientCommand, evalJobLines, evalStatusLines, type EvalApi } from "../packages/host/src/eval-cli.js";
import type { BaselineJobView, EvalJobView, EvalSummary } from "../packages/host/src/eval-types.js";

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
  groups: { total: 3, devOnly: 1, largest: 2 },
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
    "groups 3 (dev-only 1, largest 2)",
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
  // A validate view keeps its two lines.
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

    // Valid JSON, so only the size limit can refuse it.
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
