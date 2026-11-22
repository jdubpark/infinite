import test from "node:test";
import assert from "node:assert/strict";
import { handleDuelClientCommand, judgeLines } from "../packages/host/src/duel-cli.js";
import type { EvalApi } from "../packages/host/src/eval-cli.js";
import type { CalibrationView } from "../packages/host/src/judge-store.js";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function fakeApi(respond: (path: string, body?: unknown, method?: string) => unknown = () => ({})) {
  const calls: { path: string; body?: unknown; method?: string }[] = [];
  const api: EvalApi = {
    json: async <T>(path: string, body?: unknown, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string) => {
      calls.push({ path, body, method });
      return respond(path, body, method) as T;
    },
  };
  return { api, calls };
}

const view = (over: Partial<CalibrationView> = {}): CalibrationView => ({
  calibrationId: "cal-1", profileId: "j1", profileEpoch: 3, promptVersion: "pv1", status: "completed", reason: null, state: "ok",
  pairs: { planned: 36, counted: 30, correct: 24, perProject: [{ projectId: "P", pairs: 18 }, { projectId: "Q", pairs: 12 }] },
  accuracy: 0.8, lowerBound: 0.627, swapAgreement: 0.9, judgeMinutes: 10, cost: { tokens: 10, spentUsd: 1 },
  createdAt: "2026-11-22T10:00:00.000Z", expiresAt: "2026-12-22T10:00:00.000Z", completedAt: "2026-11-22T12:00:00.000Z",
  validUntil: "2027-01-21T12:00:00.000Z", inForce: true, ...over,
});

async function capture<T>(run: () => Promise<T>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await run(); } finally { console.log = original; }
  return lines;
}

test("calibrate posts the request", async () => {
  const { api, calls } = fakeApi(() => ({ calibration: view() }));
  await capture(() => handleDuelClientCommand(["calibrate"], { "--judge": "j1", "--pairs": "30", "--request-id": REQUEST_ID }, api));
  assert.deepEqual(calls, [{ path: "/api/duels/judges/calibrations", body: { requestId: REQUEST_ID, judgeProfileId: "j1", pairs: 30 }, method: "POST" }]);
});

test("calibrate sends only the fields it was given", async () => {
  const { api, calls } = fakeApi(() => ({ calibration: view() }));
  await capture(() => handleDuelClientCommand(["calibrate"], { "--judge": "j1", "--request-id": REQUEST_ID, "--project": "P,Q", "--judge-minutes": "5" }, api));
  assert.deepEqual(calls[0]!.body, { requestId: REQUEST_ID, judgeProfileId: "j1", projects: ["P", "Q"], judgeMinutes: 5 });
});

test("calibrate refuses a bad pair count before any call", async () => {
  for (const pairs of ["29", "61", "abc", "30.5"]) {
    const { api, calls } = fakeApi();
    await assert.rejects(handleDuelClientCommand(["calibrate"], { "--judge": "j1", "--pairs": pairs, "--request-id": REQUEST_ID }, api), /Usage: infinite duels calibrate/);
    assert.equal(calls.length, 0);
  }
});

test("calibrate refuses a missing judge or request ID before any call", async () => {
  const { api, calls } = fakeApi();
  await assert.rejects(handleDuelClientCommand(["calibrate"], { "--request-id": REQUEST_ID }, api), /Usage/);
  await assert.rejects(handleDuelClientCommand(["calibrate"], { "--judge": "j1", "--request-id": "nope" }, api), /Usage/);
  assert.equal(calls.length, 0);
});

test("cancel posts to the calibration's cancel route", async () => {
  const { api, calls } = fakeApi(() => ({ calibration: view({ status: "cancelled", state: null }) }));
  const lines = await capture(() => handleDuelClientCommand(["cancel", "cal-1"], {}, api));
  assert.deepEqual(calls, [{ path: "/api/duels/judges/calibrations/cal-1/cancel", body: undefined, method: "POST" }]);
  assert.ok(lines.join("\n").includes("cancelled"));
});

test("judges prints state and bound", () => {
  const text = judgeLines([view()]).join("\n");
  for (const part of ["ok", "accuracy 0.800", "lower bound 0.627", "pairs 30 (P 18, Q 12)", "in force", "known spend 10 tokens, $1.00"]) assert.ok(text.includes(part), part);
  assert.ok(!/approved|trusted/i.test(text));
});

test("unknown numbers print as unknown", () => {
  const text = judgeLines([view({ status: "running", state: null, accuracy: null, lowerBound: null, swapAgreement: null, inForce: false, pairs: { planned: 36, counted: 0, correct: 0, perProject: [] } })]).join("\n");
  assert.ok(text.includes("accuracy unknown"));
  assert.ok(text.includes("lower bound unknown"));
  assert.ok(!/(^|[^\d])0\.000/.test(text));
  assert.ok(text.includes("state none"));
});

test("control characters are cleaned", () => {
  const text = judgeLines([view({ profileId: "j\u001b[2J1" })]).join("\n");
  assert.ok(!text.includes("\u001b"));
  assert.ok(text.includes("j [2J1"));
});

test("judges reads the list and --json prints the body", async () => {
  const body = { calibrations: [view()] };
  const { api, calls } = fakeApi(() => body);
  const lines = await capture(() => handleDuelClientCommand(["judges"], { "--json": true }, api));
  assert.deepEqual(calls.map(c => c.path), ["/api/duels/judges"]);
  assert.deepEqual(JSON.parse(lines.join("\n")), body);
});

test("a refusal prints the host's fixed sentence", async () => {
  const { api } = fakeApi(() => { throw Object.assign(new Error("x"), { status: 409, code: "calibration-active" }); });
  await assert.rejects(handleDuelClientCommand(["calibrate"], { "--judge": "j1", "--request-id": REQUEST_ID }, api), /already running/);
});

test("an unknown verb is a usage error", async () => {
  await assert.rejects(handleDuelClientCommand(["frobnicate"], {}, fakeApi().api), /Usage: infinite duels/);
});
