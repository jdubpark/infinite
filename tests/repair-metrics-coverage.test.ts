import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  computeRepairLoopMetrics,
  snapshotRepairRun,
  type RepairLoopReport,
  type RepairRunEvent,
} from "../packages/host/src/repair-metrics.js";
import { registerRepairMetricsRoute, type RepairMetricsRouteDeps } from "../packages/host/src/repair-metrics-routes.js";
import { formatRepairLoopReport } from "../packages/host/src/repair-metrics-cli.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { TeamCheck, TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import type { UsageTotals } from "../packages/host/src/usage.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const NOW = Date.parse("2026-11-26T00:00:00.000Z");

const makeUsage = (cost: number, input: number, output = 0): UsageTotals => ({
  cost,
  tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  messages: 1,
  pricing: { configured: 1, catalog: 0, provider: 0, unknown: 0 },
});

const makeMember = (partial: Partial<TeamMember> & Pick<TeamMember, "memberId" | "role">): TeamMember => ({
  runId: "run-1",
  revision: 1,
  sessionId: `sess-${partial.memberId}`,
  title: `${partial.role}: ${partial.memberId}`,
  status: "stopped",
  cwd: "/tmp/work",
  baseCommit: COMMIT_A,
  prompt: "prompt",
  cursor: 0,
  stopRequestId: `stop-${partial.memberId}`,
  ...partial,
});

function makeCheck(partial: Partial<TeamCheck> & Pick<TeamCheck, "status" | "startedAt">): TeamCheck {
  if (partial.status === "passed") return { command: { command: "npm", args: ["test"] }, revision: 1, output: "", finishedAt: partial.startedAt, exitCode: 0, ...partial, status: "passed" };
  if (partial.status === "failed" || partial.status === "interrupted") return { command: { command: "npm", args: ["test"] }, revision: 1, output: "failed", finishedAt: partial.startedAt, exitCode: 1, ...partial, status: partial.status };
  return { command: { command: "npm", args: ["test"] }, revision: 1, output: "", ...partial, status: "running" };
}

const makeRun = (partial: Partial<TeamRun> & Pick<TeamRun, "id">): TeamRun => ({
  projectId: "proj-alpha",
  provider: "opencode",
  title: "Test run",
  objective: "Fix bug",
  parallelism: 2,
  revision: 1,
  status: "ready-for-review",
  createdAt: "2026-11-25T10:00:00.000Z",
  updatedAt: "2026-11-25T10:30:00.000Z",
  workspace: "/tmp/ws",
  branch: "main",
  baseCommit: COMMIT_A,
  headCommit: COMMIT_B,
  tasks: [],
  members: [],
  decisions: [],
  checks: [],
  steering: [],
  events: [],
  round: 0,
  ...partial,
});

async function withRouteServer(deps: RepairMetricsRouteDeps, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  registerRepairMetricsRoute(app, deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("surfaces incomplete event coverage when ledger.gap is recorded even with zero extracted loops", async () => {
  const runWithGap = makeRun({
    id: "run-ledger-gap",
    status: "ready-for-review",
    round: 0,
    members: [
      makeMember({ runId: "run-ledger-gap", memberId: "rev-0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:05:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
  });

  const dir = mkdtempSync(join(tmpdir(), "inf-repair-gap-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    store.write(tx => {
      store.appendEvent(tx, {
        key: "ledger.gap:run-ledger-gap:2026-11-25T10:03:00.000Z",
        runId: "run-ledger-gap",
        revision: 1,
        at: "2026-11-25T10:03:00.000Z",
        kind: "ledger.gap",
        data: { v: 1, dropped: 2 },
      });
    });

    await withRouteServer({
      runs: () => [snapshotRepairRun(runWithGap)],
      evidence: store,
      memberUsage: () => ({ ...makeUsage(0.1, 100), measured: true, coverage: "complete" }),
      now: () => NOW,
    }, async base => {
      const res = await fetch(`${base}/api/usage/repair-loops`);
      assert.equal(res.status, 200);
      const body = await res.json() as RepairLoopReport;
      assert.equal(body.totals.runsExamined, 1);
      assert.equal(body.totals.loopsTotal, 0);
      assert.equal(body.totals.eventCoverage, "incomplete");
      assert.equal(body.totals.incompleteRuns, 1);

      const text = formatRepairLoopReport(body).join("\n");
      assert.match(text, /Warning: event coverage is incomplete for 1 of 1 examined runs/);
      assert.match(text, /No repair loops reconstructed from complete ledger events in this window\./);
      assert.doesNotMatch(text, /No repair loops recorded in this window\./);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flags legacy runs with missing repair.started or review.recorded events without fabricating resolution", () => {
  const legacyRoundOne = makeRun({
    id: "run-legacy-round1",
    status: "ready-for-review",
    round: 1,
    members: [
      makeMember({ runId: "run-legacy-round1", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-legacy-round1", memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "result", summary: "Fixed" } }),
      makeMember({ runId: "run-legacy-round1", memberId: "r1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:03:00.000Z", reportedAt: "2026-11-25T10:04:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:02:50.000Z" })],
  });

  const legacySupersededRev = makeRun({
    id: "run-legacy-superseded",
    status: "ready-for-review",
    revision: 2,
    round: 0,
    members: [
      makeMember({ runId: "run-legacy-superseded", revision: 1, memberId: "i-old", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T11:01:00.000Z", reportedAt: "2026-11-25T11:02:00.000Z", report: { kind: "result", summary: "Fixed" } }),
    ],
    checks: [
      makeCheck({ revision: 1, status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T11:02:10.000Z", finishedAt: "2026-11-25T11:02:50.000Z" }),
    ],
  });

  const settledMissingApprovalEvent = makeRun({
    id: "run-missing-approval-event",
    status: "ready-for-review",
    round: 1,
    members: [
      makeMember({ runId: "run-missing-approval-event", memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T12:01:00.000Z", reportedAt: "2026-11-25T12:02:00.000Z", report: { kind: "result", summary: "Fixed" } }),
      makeMember({ runId: "run-missing-approval-event", memberId: "r1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T12:03:00.000Z", reportedAt: "2026-11-25T12:04:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [
      makeCheck({ status: "failed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T12:00:00.000Z", finishedAt: "2026-11-25T12:00:30.000Z" }),
      makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T12:02:10.000Z", finishedAt: "2026-11-25T12:02:50.000Z" }),
    ],
  });

  const cleanRoundZeroReconcile = makeRun({
    id: "run-clean-base-moved",
    status: "ready-for-review",
    revision: 2,
    round: 0,
    members: [
      makeMember({ runId: "run-clean-base-moved", revision: 2, memberId: "i-base", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T13:01:00.000Z", reportedAt: "2026-11-25T13:02:00.000Z", report: { kind: "result", summary: "Carried delta" } }),
      makeMember({ runId: "run-clean-base-moved", revision: 2, memberId: "r-base", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T13:03:00.000Z", reportedAt: "2026-11-25T13:04:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ revision: 2, status: "passed", round: 0, headCommit: COMMIT_B, startedAt: "2026-11-25T13:02:10.000Z", finishedAt: "2026-11-25T13:02:50.000Z" })],
  });

  const events: Record<string, RepairRunEvent[]> = {
    "run-missing-approval-event": [
      { seq: 1, kind: "repair.started", revision: 1, at: "2026-11-25T12:00:30.000Z", data: { v: 1, round: 1, cause: "check", headCommit: COMMIT_A } },
    ],
    "run-clean-base-moved": [
      { seq: 1, kind: "review.recorded", revision: 2, at: "2026-11-25T13:04:00.000Z", memberId: "r-base", data: { v: 1, verdict: "approved", headCommit: COMMIT_B } },
    ],
  };

  const report = computeRepairLoopMetrics(
    [snapshotRepairRun(legacyRoundOne), snapshotRepairRun(legacySupersededRev), snapshotRepairRun(settledMissingApprovalEvent), snapshotRepairRun(cleanRoundZeroReconcile)],
    () => makeUsage(0.1, 200),
    { now: NOW, runEvents: runId => events[runId] ?? [] },
  );

  assert.equal(report.totals.runsExamined, 4);
  assert.equal(report.totals.eventCoverage, "incomplete");
  assert.equal(report.totals.incompleteRuns, 3);
  assert.equal(report.totals.loopsTotal, 1);
  assert.equal(report.totals.resolved, 0);
  assert.equal(report.totals.unresolved, 1);
  assert.equal(report.loops[0]!.runId, "run-missing-approval-event");
  assert.equal(report.loops[0]!.outcome, "unresolved");

  const cleanOnly = computeRepairLoopMetrics(
    [snapshotRepairRun(cleanRoundZeroReconcile)],
    () => makeUsage(0.1, 200),
    { now: NOW, runEvents: runId => events[runId] ?? [] },
  );
  assert.equal(cleanOnly.totals.eventCoverage, "complete");
  assert.equal(cleanOnly.totals.incompleteRuns, 0);
  assert.equal(cleanOnly.totals.loopsTotal, 0);
});

test("memberFinal downgrades mixed none + complete multi-session members so partial costs never enter final medians", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-repair-mixed-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    const config = {
      stateDir: dir,
      usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, budgets: {}, accounts: {} },
    } as unknown as Config;
    const eventsBySession: Record<string, { type: string; data: unknown }[]> = {
      "sess-resume-none": [{ type: "usage-coverage", data: { coverage: "none", reason: "unsupported" } }],
      "sess-fallback-ok": [{
        type: "usage",
        data: { provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m1", partId: "p1", modelSource: "reported", completedAt: "2026-11-25T10:02:00.000Z", tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0 },
      }],
      "sess-all-1": [{
        type: "usage",
        data: { provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m2", partId: "p1", modelSource: "reported", completedAt: "2026-11-25T10:03:00.000Z", tokens: { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0 },
      }],
      "sess-all-2": [{
        type: "usage",
        data: { provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m3", partId: "p1", modelSource: "reported", completedAt: "2026-11-25T10:04:00.000Z", tokens: { input: 500, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0 },
      }],
    };
    const manager = {
      list: async () => [],
      events: (id: string, cursor: number) => ({ events: (eventsBySession[id] ?? []).slice(cursor), cursor: (eventsBySession[id] ?? []).length, more: false }),
    } as unknown as Manager;
    const usage = new UsageService(config, key, manager, store);

    const ocProfile = { id: "oc", label: "OC", provider: "opencode", model: "deepseek/deepseek-flash" };
    const sessionRow = (id: string, provider: "claude" | "opencode", memberId: string, createdAt: string): UsageSessionRow => ({
      id,
      provider,
      projectId: "proj-alpha",
      status: "exited",
      createdAt,
      team: { runId: "run-mixed", memberId, role: "integrator", revision: 1 },
      ...(provider === "opencode" ? { teamModelProfile: ocProfile } : {}),
    }) as unknown as UsageSessionRow;

    await usage.tick([
      sessionRow("sess-resume-none", "claude", "int-mixed", "2026-11-25T10:01:00.000Z"),
      sessionRow("sess-fallback-ok", "opencode", "int-mixed", "2026-11-25T10:01:30.000Z"),
      sessionRow("sess-all-1", "opencode", "rev-complete", "2026-11-25T10:03:00.000Z"),
      sessionRow("sess-all-2", "opencode", "rev-complete", "2026-11-25T10:03:30.000Z"),
    ]);

    const combinedMember = usage.member("run-mixed", "int-mixed");
    assert.equal(combinedMember.measured, true);
    assert.equal(combinedMember.coverage, "complete");

    const finalMixed = usage.memberFinal("run-mixed", "int-mixed");
    assert.equal(finalMixed.measured, true);
    if (finalMixed.measured) {
      assert.equal(finalMixed.coverage, "partial");
      assert.equal(finalMixed.coverageReason, "unsupported");
    }

    const finalComplete = usage.memberFinal("run-mixed", "rev-complete");
    assert.equal(finalComplete.measured, true);
    if (finalComplete.measured) {
      assert.equal(finalComplete.coverage, "complete");
      assert.equal(finalComplete.messages, 2);
      assert.equal(finalComplete.tokens.input, 1500);
    }

    const mixedRun = makeRun({
      id: "run-mixed",
      round: 1,
      members: [
        makeMember({ runId: "run-mixed", memberId: "rev-0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
        makeMember({
          runId: "run-mixed",
          memberId: "int-mixed",
          role: "integrator",
          baseCommit: COMMIT_A,
          startedAt: "2026-11-25T10:01:00.000Z",
          reportedAt: "2026-11-25T10:02:00.000Z",
          turns: [
            { sessionId: "sess-resume-none", decisionId: "d1", startedAt: "2026-11-25T10:01:00.000Z", mode: "resume" },
            { sessionId: "sess-fallback-ok", decisionId: "d1", startedAt: "2026-11-25T10:01:30.000Z", mode: "start" },
          ],
          report: { kind: "result", summary: "Fixed" },
        }),
        makeMember({ runId: "run-mixed", memberId: "rev-complete", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:03:00.000Z", reportedAt: "2026-11-25T10:04:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
      ],
      checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:02:50.000Z" })],
    });

    await withRouteServer({
      runs: () => [snapshotRepairRun(mixedRun)],
      runEvents: () => [
        { seq: 1, kind: "review.recorded", revision: 1, at: "2026-11-25T10:00:00.000Z", memberId: "rev-0", data: { v: 1, verdict: "changes-requested", headCommit: COMMIT_A } },
        { seq: 2, kind: "repair.started", revision: 1, at: "2026-11-25T10:00:00.000Z", data: { v: 1, round: 1, cause: "review", headCommit: COMMIT_A } },
        { seq: 3, kind: "review.recorded", revision: 1, at: "2026-11-25T10:04:00.000Z", memberId: "rev-complete", data: { v: 1, verdict: "approved", headCommit: COMMIT_B } },
      ],
      memberUsage: (runId, memberId) => usage.memberFinal(runId, memberId),
      now: () => NOW,
    }, async base => {
      const body = await (await fetch(`${base}/api/usage/repair-loops`)).json() as RepairLoopReport;
      assert.equal(body.totals.resolved, 1);
      assert.equal(body.totals.measuredLoops, 0);
      assert.equal(body.totals.unmeasuredLoops, 1);
      assert.equal(body.totals.unmeasuredMembers, 1);
      assert.equal(body.totals.medianTokens, null);
      assert.equal(body.totals.medianUsd, null);
      assert.equal(body.loops[0]!.measured, false);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI distinguishes unfinished in-progress loops from unmeasured member usage gaps", () => {
  const verifyingRun = makeRun({
    id: "run-verifying",
    status: "verifying",
    round: 1,
    members: [
      makeMember({ runId: "run-verifying", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-verifying", memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", status: "stopped", report: { kind: "result", summary: "Fixed" } }),
    ],
    checks: [makeCheck({ status: "running", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z" })],
  });

  const report = computeRepairLoopMetrics(
    [verifyingRun],
    () => makeUsage(0.05, 500),
    {
      now: NOW,
      runEvents: () => [
        { seq: 1, kind: "review.recorded", revision: 1, at: "2026-11-25T10:00:00.000Z", memberId: "r0", data: { v: 1, verdict: "changes-requested", headCommit: COMMIT_A } },
        { seq: 2, kind: "repair.started", revision: 1, at: "2026-11-25T10:00:00.000Z", data: { v: 1, round: 1, cause: "review", headCommit: COMMIT_A } },
      ],
    },
  );

  assert.equal(report.totals.inProgress, 1);
  assert.equal(report.totals.unfinishedLoops, 1);
  assert.equal(report.totals.unmeasuredLoops, 0);
  assert.equal(report.totals.unmeasuredMembers, 0);
  assert.equal(report.totals.medianTokens, null);
  assert.equal(report.totals.medianUsd, null);

  const text = formatRepairLoopReport(report).join("\n");
  assert.match(text, /0 measured loops, 0 unmeasured loops, 1 unfinished loops, 0 unmeasured members/);
  assert.match(text, /Note: 1 of 1 loops are still unfinished \(in-progress or active members\) and are excluded from final token\/USD medians\./);
  assert.doesNotMatch(text, /have unmeasured member usage/);
  assert.match(text, /run-verify.*in-progress\s*$/m);
});
