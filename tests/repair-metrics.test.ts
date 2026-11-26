import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createRemoteClient } from "@infinite/remote";
import { computeRepairLoopMetrics, type RepairLoopReport } from "../packages/host/src/repair-metrics.js";
import { registerRepairMetricsRoute } from "../packages/host/src/repair-metrics-routes.js";
import { formatRepairLoopReport, handleUsageRepairsCommand } from "../packages/host/src/repair-metrics-cli.js";
import { parseClientArgs } from "../packages/host/src/client.js";
import type { TeamCheck, TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import type { UsageTotals } from "../packages/host/src/usage.js";
import { startHost } from "./helpers.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);

function makeUsage(cost: number, input: number, output = 0): UsageTotals {
  return {
    cost,
    tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    pricing: { configured: 1, catalog: 0, provider: 0, unknown: 0 },
  };
}

function makeMember(partial: Partial<TeamMember> & Pick<TeamMember, "memberId" | "role">): TeamMember {
  return {
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
  };
}

function makeCheck(partial: Partial<TeamCheck> & Pick<TeamCheck, "status" | "startedAt">): TeamCheck {
  if (partial.status === "passed") {
    return {
      command: { command: "npm", args: ["test"] },
      revision: 1,
      output: "",
      finishedAt: partial.startedAt,
      exitCode: 0,
      ...partial,
      status: "passed",
    };
  }
  if (partial.status === "failed" || partial.status === "interrupted") {
    return {
      command: { command: "npm", args: ["test"] },
      revision: 1,
      output: "failed",
      finishedAt: partial.startedAt,
      exitCode: 1,
      ...partial,
      status: partial.status,
    };
  }
  return {
    command: { command: "npm", args: ["test"] },
    revision: 1,
    output: "",
    ...partial,
    status: "running",
  };
}

function makeRun(partial: Partial<TeamRun> & Pick<TeamRun, "id">): TeamRun {
  return {
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
    round: 1,
    ...partial,
  };
}

test("measures resolved review-repair loop with duration, tokens, and USD", () => {
  const run = makeRun({
    id: "run-review-ok",
    members: [
      makeMember({
        runId: "run-review-ok",
        memberId: "rev-0",
        role: "reviewer",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T10:00:00.000Z",
        reportedAt: "2026-11-25T10:02:00.000Z",
        report: { kind: "review", verdict: "changes-requested", summary: "Fix edge case" },
      }),
      makeMember({
        runId: "run-review-ok",
        memberId: "int-1",
        role: "integrator",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T10:02:30.000Z",
        reportedAt: "2026-11-25T10:05:30.000Z",
        report: { kind: "result", summary: "Fixed edge case" },
      }),
      makeMember({
        runId: "run-review-ok",
        memberId: "rev-1",
        role: "reviewer",
        baseCommit: COMMIT_B,
        startedAt: "2026-11-25T10:07:00.000Z",
        reportedAt: "2026-11-25T10:08:00.000Z",
        report: { kind: "review", verdict: "approved", summary: "Looks good" },
      }),
    ],
    checks: [
      makeCheck({ status: "passed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T09:59:00.000Z", finishedAt: "2026-11-25T10:00:00.000Z" }),
      makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:06:00.000Z", finishedAt: "2026-11-25T10:07:00.000Z" }),
    ],
  });

  const usageMap = new Map<string, UsageTotals>([
    ["int-1", makeUsage(0.12, 1000, 200)],
    ["rev-1", makeUsage(0.08, 600, 150)],
  ]);

  const report = computeRepairLoopMetrics([run], member => usageMap.get(member.memberId), {
    now: Date.parse("2026-11-26T00:00:00.000Z"),
  });

  assert.equal(report.windowDays, 30);
  assert.equal(report.totals.runsExamined, 1);
  assert.equal(report.totals.loopsTotal, 1);
  assert.equal(report.totals.resolved, 1);
  assert.equal(report.totals.unresolved, 0);
  assert.equal(report.totals.inProgress, 0);
  assert.deepEqual(report.totals.byCause, { review: 1, check: 0, delivery: 0 });
  assert.equal(report.totals.measuredLoops, 1);
  assert.equal(report.totals.unmeasuredLoops, 0);
  assert.equal(report.totals.unmeasuredMembers, 0);
  assert.equal(report.totals.medianMinutes, 6);
  assert.equal(report.totals.p90Minutes, 6);
  assert.equal(report.totals.medianTokens, 1950);
  assert.equal(report.totals.medianUsd, 0.2);

  assert.equal(report.loops.length, 1);
  assert.deepEqual(report.loops[0], {
    runId: "run-review-ok",
    projectId: "proj-alpha",
    revision: 1,
    cause: "review",
    outcome: "resolved",
    rounds: 1,
    attempts: 3,
    coldReplacements: 0,
    failedResumes: 0,
    startedAt: "2026-11-25T10:02:00.000Z",
    finishedAt: "2026-11-25T10:08:00.000Z",
    durationMs: 360_000,
    failedCommit: COMMIT_A,
    passingCommit: COMMIT_B,
    measured: true,
    tokens: 1950,
    usd: 0.2,
  });
});

test("measures check-repair and delivery-repair loops and ignores non-repaired check failures", () => {
  const checkRepair = makeRun({
    id: "run-check-ok",
    members: [
      makeMember({
        runId: "run-check-ok",
        memberId: "int-1",
        role: "integrator",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T11:02:00.000Z",
        reportedAt: "2026-11-25T11:04:00.000Z",
        report: { kind: "result", summary: "Fixed test" },
      }),
      makeMember({
        runId: "run-check-ok",
        memberId: "rev-1",
        role: "reviewer",
        baseCommit: COMMIT_B,
        startedAt: "2026-11-25T11:05:00.000Z",
        reportedAt: "2026-11-25T11:07:00.000Z",
        report: { kind: "review", verdict: "approved", summary: "Approved" },
      }),
    ],
    checks: [
      makeCheck({ status: "passed", phase: "setup", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T11:00:00.000Z", finishedAt: "2026-11-25T11:00:30.000Z" }),
      makeCheck({ status: "failed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T11:00:31.000Z", finishedAt: "2026-11-25T11:01:00.000Z" }),
      makeCheck({ status: "passed", phase: "setup", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T11:04:05.000Z", finishedAt: "2026-11-25T11:04:20.000Z" }),
      makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T11:04:21.000Z", finishedAt: "2026-11-25T11:04:50.000Z" }),
    ],
  });

  const terminalFailedCheckNoRepair = makeRun({
    id: "run-check-blocked-no-repair",
    status: "blocked",
    checks: [
      makeCheck({ status: "failed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T12:00:00.000Z", finishedAt: "2026-11-25T12:01:00.000Z" }),
    ],
  });

  const deliveryRepair = makeRun({
    id: "run-delivery-ok",
    members: [
      makeMember({
        runId: "run-delivery-ok",
        memberId: "del-0",
        role: "delivery",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T13:00:00.000Z",
        reportedAt: "2026-11-25T13:01:00.000Z",
        report: { kind: "delivery-repair", headCommit: COMMIT_A, summary: "Rebase conflict" },
      }),
      makeMember({
        runId: "run-delivery-ok",
        memberId: "int-d1",
        role: "integrator",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T13:01:30.000Z",
        reportedAt: "2026-11-25T13:03:00.000Z",
        report: { kind: "result", summary: "Rebased" },
      }),
      makeMember({
        runId: "run-delivery-ok",
        memberId: "rev-d1",
        role: "reviewer",
        baseCommit: COMMIT_C,
        startedAt: "2026-11-25T13:04:00.000Z",
        reportedAt: "2026-11-25T13:05:00.000Z",
        report: { kind: "review", verdict: "approved", summary: "Approved after rebase" },
      }),
    ],
    checks: [
      makeCheck({ status: "passed", round: 1, headCommit: COMMIT_C, startedAt: "2026-11-25T13:03:10.000Z", finishedAt: "2026-11-25T13:03:50.000Z" }),
    ],
  });

  const report = computeRepairLoopMetrics([checkRepair, terminalFailedCheckNoRepair, deliveryRepair], () => makeUsage(0.1, 500), {
    now: Date.parse("2026-11-26T00:00:00.000Z"),
  });

  assert.equal(report.totals.runsExamined, 3);
  assert.equal(report.totals.loopsTotal, 2);
  assert.deepEqual(report.totals.byCause, { review: 0, check: 1, delivery: 1 });
  const checkLoop = report.loops.find(loop => loop.runId === "run-check-ok")!;
  assert.equal(checkLoop.cause, "check");
  assert.equal(checkLoop.outcome, "resolved");
  assert.equal(checkLoop.attempts, 4);
  assert.equal(checkLoop.durationMs, 360_000);
  const deliveryLoop = report.loops.find(loop => loop.runId === "run-delivery-ok")!;
  assert.equal(deliveryLoop.cause, "delivery");
  assert.equal(deliveryLoop.outcome, "resolved");
  assert.equal(deliveryLoop.passingCommit, COMMIT_C);
});

test("counts unresolved blocked/cancelled/superseded loops, cold replacements, failed resumes, and multi-round repairs in denominator", () => {
  const multiRoundBlocked = makeRun({
    id: "run-blocked",
    status: "blocked",
    round: 2,
    members: [
      makeMember({
        runId: "run-blocked",
        memberId: "rev-0",
        role: "reviewer",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T14:00:00.000Z",
        reportedAt: "2026-11-25T14:01:00.000Z",
        report: { kind: "review", verdict: "changes-requested", summary: "Missing tests" },
      }),
      makeMember({
        runId: "run-blocked",
        memberId: "int-1a",
        role: "integrator",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T14:02:00.000Z",
        stalledAt: "2026-11-25T14:17:00.000Z",
        stoppedReason: "No activity for 15 minutes",
      }),
      makeMember({
        runId: "run-blocked",
        memberId: "int-1b",
        role: "integrator",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T14:18:00.000Z",
        reportedAt: "2026-11-25T14:20:00.000Z",
        turns: [
          { sessionId: "s1", decisionId: "d1", startedAt: "2026-11-25T14:18:00.000Z", mode: "resume" },
          { sessionId: "s2", decisionId: "d1", startedAt: "2026-11-25T14:18:10.000Z", mode: "start" },
        ],
        report: { kind: "result", summary: "Partial fix" },
      }),
      makeMember({
        runId: "run-blocked",
        memberId: "int-2",
        role: "integrator",
        baseCommit: COMMIT_B,
        startedAt: "2026-11-25T14:22:00.000Z",
        reportedAt: "2026-11-25T14:25:00.000Z",
        report: { kind: "result", summary: "Second round fix" },
      }),
      makeMember({
        runId: "run-blocked",
        memberId: "rev-2a",
        role: "reviewer",
        baseCommit: COMMIT_C,
        startedAt: "2026-11-25T14:26:00.000Z",
        stoppedReason: "Claude Code usage limit",
      }),
      makeMember({
        runId: "run-blocked",
        memberId: "rev-2b",
        role: "reviewer",
        baseCommit: COMMIT_C,
        startedAt: "2026-11-25T14:27:00.000Z",
        reportedAt: "2026-11-25T14:29:00.000Z",
        stoppedReason: "Native resume failed; restarted",
        report: { kind: "review", verdict: "changes-requested", summary: "Still broken" },
      }),
    ],
    checks: [
      makeCheck({ status: "failed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T14:20:30.000Z", finishedAt: "2026-11-25T14:21:30.000Z" }),
      makeCheck({ status: "passed", round: 2, headCommit: COMMIT_C, startedAt: "2026-11-25T14:25:10.000Z", finishedAt: "2026-11-25T14:25:50.000Z" }),
    ],
  });

  const cancelled = makeRun({
    id: "run-cancelled",
    status: "cancelled",
    revision: 2,
    members: [
      makeMember({
        runId: "run-cancelled",
        revision: 1,
        memberId: "rev-sup",
        role: "reviewer",
        baseCommit: COMMIT_A,
        startedAt: "2026-11-25T15:00:00.000Z",
        reportedAt: "2026-11-25T15:01:00.000Z",
        report: { kind: "review", verdict: "changes-requested", summary: "Changes needed" },
      }),
      makeMember({
        runId: "run-cancelled",
        revision: 2,
        memberId: "rev-cancel",
        role: "reviewer",
        baseCommit: COMMIT_B,
        startedAt: "2026-11-25T15:10:00.000Z",
        reportedAt: "2026-11-25T15:11:00.000Z",
        report: { kind: "review", verdict: "changes-requested", summary: "More changes" },
      }),
      makeMember({
        runId: "run-cancelled",
        revision: 2,
        memberId: "int-cancel",
        role: "integrator",
        baseCommit: COMMIT_B,
        startedAt: "2026-11-25T15:12:00.000Z",
        status: "running",
      }),
    ],
  });

  const report = computeRepairLoopMetrics([multiRoundBlocked, cancelled], () => makeUsage(0.05, 400), {
    now: Date.parse("2026-11-26T00:00:00.000Z"),
  });

  assert.equal(report.totals.loopsTotal, 3);
  assert.equal(report.totals.resolved, 0);
  assert.equal(report.totals.unresolved, 3);
  assert.equal(report.totals.coldReplacements, 2);
  assert.equal(report.totals.failedResumes, 2);
  assert.equal(report.totals.medianMinutes, null);
  assert.equal(report.totals.p90Minutes, null);

  const blockedSample = report.loops.find(loop => loop.runId === "run-blocked")!;
  assert.equal(blockedSample.outcome, "blocked");
  assert.equal(blockedSample.rounds, 2);
  assert.equal(blockedSample.attempts, 7);
  assert.equal(blockedSample.coldReplacements, 2);
  assert.equal(blockedSample.failedResumes, 2);
  assert.equal(blockedSample.finishedAt, undefined);
  assert.equal(blockedSample.durationMs, undefined);

  const supersededSample = report.loops.find(loop => loop.runId === "run-cancelled" && loop.revision === 1)!;
  assert.equal(supersededSample.outcome, "superseded");
  assert.equal(supersededSample.measured, false);
  const cancelledSample = report.loops.find(loop => loop.runId === "run-cancelled" && loop.revision === 2)!;
  assert.equal(cancelledSample.outcome, "cancelled");
  assert.equal(cancelledSample.measured, true);
});

test("keeps unmeasured members out of token/USD medians and never reports unmeasured as 0", () => {
  const unmeasuredRun = makeRun({
    id: "run-unmeasured",
    provider: "claude",
    members: [
      makeMember({
        runId: "run-unmeasured",
        memberId: "rev-0",
        role: "reviewer",
        provider: "claude",
        baseCommit: COMMIT_A,
        reportedAt: "2026-11-25T10:00:00.000Z",
        report: { kind: "review", verdict: "changes-requested", summary: "Fix" },
      }),
      makeMember({
        runId: "run-unmeasured",
        memberId: "int-1",
        role: "integrator",
        provider: "opencode",
        startedAt: "2026-11-25T10:01:00.000Z",
        reportedAt: "2026-11-25T10:03:00.000Z",
        report: { kind: "result", summary: "Fixed" },
      }),
      makeMember({
        runId: "run-unmeasured",
        memberId: "rev-1",
        role: "reviewer",
        provider: "claude",
        baseCommit: COMMIT_B,
        startedAt: "2026-11-25T10:04:00.000Z",
        reportedAt: "2026-11-25T10:05:00.000Z",
        report: { kind: "review", verdict: "approved", summary: "OK" },
      }),
    ],
    checks: [
      makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:03:10.000Z", finishedAt: "2026-11-25T10:03:50.000Z" }),
    ],
  });

  const report = computeRepairLoopMetrics(
    [unmeasuredRun],
    (member, fallback) => (member.provider ?? fallback) === "opencode" ? makeUsage(0.5, 2000) : undefined,
    { now: Date.parse("2026-11-26T00:00:00.000Z") },
  );

  assert.equal(report.totals.resolved, 1);
  assert.equal(report.totals.measuredLoops, 0);
  assert.equal(report.totals.unmeasuredLoops, 1);
  assert.equal(report.totals.unmeasuredMembers, 1);
  assert.equal(report.totals.medianMinutes, 5);
  assert.equal(report.totals.medianTokens, null);
  assert.equal(report.totals.medianUsd, null);
  assert.equal(report.loops[0]!.measured, false);
  assert.equal(report.loops[0]!.tokens, undefined);
  assert.equal(report.loops[0]!.usd, undefined);
});

test("filters by projectId and days, skips replay runs, and caps sample at 50", () => {
  const now = Date.parse("2026-11-26T00:00:00.000Z");
  const runs: TeamRun[] = [];
  for (let i = 0; i < 55; i++) {
    const start = new Date(now - (i + 1) * 3600_000).toISOString();
    const end = new Date(now - (i + 1) * 3600_000 + 120_000).toISOString();
    runs.push(makeRun({
      id: `run-${String(i).padStart(2, "0")}`,
      projectId: "proj-target",
      createdAt: start,
      updatedAt: end,
      members: [
        makeMember({ runId: `run-${String(i).padStart(2, "0")}`, memberId: `r0-${i}`, role: "reviewer", baseCommit: COMMIT_A, reportedAt: start, report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
        makeMember({ runId: `run-${String(i).padStart(2, "0")}`, memberId: `i1-${i}`, role: "integrator", baseCommit: COMMIT_A, startedAt: start, reportedAt: end, report: { kind: "result", summary: "Done" } }),
        makeMember({ runId: `run-${String(i).padStart(2, "0")}`, memberId: `r1-${i}`, role: "reviewer", baseCommit: COMMIT_B, startedAt: end, reportedAt: end, report: { kind: "review", verdict: "approved", summary: "OK" } }),
      ],
      checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: end, finishedAt: end })],
    }));
  }
  runs.push(makeRun({
    id: "run-old",
    projectId: "proj-target",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T01:00:00.000Z",
    members: [
      makeMember({ runId: "run-old", memberId: "r-old", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-10-01T00:30:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Old" } }),
    ],
  }));
  runs.push(makeRun({
    id: "run-other",
    projectId: "proj-other",
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T01:00:00.000Z",
    members: [
      makeMember({ runId: "run-other", memberId: "r-other", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T00:30:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Other" } }),
    ],
  }));
  runs.push(makeRun({
    id: "run-replay",
    projectId: "proj-target",
    replay: { jobId: "j1", trialId: "t1", purpose: "replay" },
    members: [
      makeMember({ runId: "run-replay", memberId: "r-replay", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T00:30:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Replay" } }),
    ],
  }));

  const report = computeRepairLoopMetrics(runs, () => makeUsage(0.01, 100), { projectId: "proj-target", days: 10, now });
  assert.equal(report.projectId, "proj-target");
  assert.equal(report.windowDays, 10);
  assert.equal(report.totals.runsExamined, 55);
  assert.equal(report.totals.loopsTotal, 55);
  assert.equal(report.loops.length, 50);
  assert.equal(report.loops[0]!.runId, "run-00");
  assert.equal(report.loops[49]!.runId, "run-49");
});

test("registerRepairMetricsRoute serves validated metrics and maps unavailable ledger to 503", async () => {
  const run = makeRun({
    id: "run-route",
    projectId: "proj-http",
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:10:00.000Z",
    members: [
      makeMember({ runId: "run-route", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-route", memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "result", summary: "Fixed" } }),
      makeMember({ runId: "run-route", memberId: "r1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:03:00.000Z", reportedAt: "2026-11-25T10:04:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:02:50.000Z" })],
  });

  const app = express();
  let ledgerUnavailable = false;
  registerRepairMetricsRoute(app, {
    runs: () => [run],
    memberUsage: () => ledgerUnavailable
      ? { measured: false, coverage: "none", unavailable: true }
      : { ...makeUsage(0.25, 1000), measured: true, coverage: "complete" },
    now: () => Date.parse("2026-11-26T00:00:00.000Z"),
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "unavailable") {
      return void res.status(503).json({ error: "The usage ledger is unavailable" });
    }
    return void res.status(400).json({ error: "Invalid request" });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/usage/repair-loops?project=proj-http&days=7`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as RepairLoopReport;
    assert.equal(body.windowDays, 7);
    assert.equal(body.projectId, "proj-http");
    assert.equal(body.totals.resolved, 1);
    assert.equal(body.totals.medianUsd, 0.5);

    const badProject = await fetch(`http://127.0.0.1:${port}/api/usage/repair-loops?project=INVALID`);
    assert.equal(badProject.status, 400);
    const badDays = await fetch(`http://127.0.0.1:${port}/api/usage/repair-loops?days=0`);
    assert.equal(badDays.status, 400);
    const extraParam = await fetch(`http://127.0.0.1:${port}/api/usage/repair-loops?extra=1`);
    assert.equal(extraParam.status, 400);

    ledgerUnavailable = true;
    const unavailable = await fetch(`http://127.0.0.1:${port}/api/usage/repair-loops`);
    assert.equal(unavailable.status, 503);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("GET /api/usage/repair-loops is live on host and allowed over remote channel", { timeout: 60000 }, async () => {
  const host = await startHost({ config: { machine: { id: randomUUID(), label: "Test machine" }, remote: { enabled: true } } });
  const owner = createRemoteClient({ url: host.origin, token: host.tokens.owner });
  try {
    assert.equal((await host.fetchApi("/usage/repair-loops", null)).status, 401);
    const viewer = await host.fetchApi("/usage/repair-loops", "viewer");
    assert.equal(viewer.status, 200);
    assert.equal(viewer.body.windowDays, 30);
    assert.equal(viewer.body.totals.loopsTotal, 0);
    assert.equal((await host.fetchApi("/usage/repair-loops?days=400")).status, 400);
    assert.equal((await host.fetchApi("/usage/repair-loops?project=BAD_ID")).status, 400);

    const remoteBody = await owner.request<RepairLoopReport>("/usage/repair-loops?days=14");
    assert.equal(remoteBody.windowDays, 14);
    assert.deepEqual(remoteBody.loops, []);

    await host.stopApi();
    const location = join(host.config.stateDir, "evidence");
    rmSync(location, { recursive: true, force: true });
    writeFileSync(location, "not a directory");
    await host.start();
    const down = await host.fetchApi("/usage/repair-loops");
    assert.equal(down.status, 503);
  } finally {
    owner.close();
    await host.stop();
  }
});

test("CLI formatter and handleUsageRepairsCommand format summary, unmeasured warnings, and JSON", async () => {
  const parsed = parseClientArgs(["usage", "repairs", "--project", "proj-a", "--days", "14", "--json"]);
  assert.equal(parsed.command, "usage");
  assert.deepEqual(parsed.args, ["repairs"]);
  assert.equal(parsed.options["--project"], "proj-a");
  assert.equal(parsed.options["--days"], "14");
  assert.equal(parsed.options["--json"], true);

  const sampleReport: RepairLoopReport = {
    windowDays: 14,
    projectId: "proj-a",
    totals: {
      runsExamined: 3,
      loopsTotal: 2,
      resolved: 1,
      unresolved: 1,
      inProgress: 0,
      byCause: { review: 1, check: 1, delivery: 0 },
      coldReplacements: 1,
      failedResumes: 1,
      measuredLoops: 1,
      unmeasuredLoops: 1,
      unmeasuredMembers: 1,
      medianMinutes: 4.5,
      p90Minutes: 4.5,
      medianTokens: 1200,
      medianUsd: 0.05,
    },
    loops: [
      {
        runId: "run-12345678",
        projectId: "proj-a",
        revision: 1,
        cause: "review",
        outcome: "resolved",
        rounds: 1,
        attempts: 3,
        coldReplacements: 0,
        failedResumes: 0,
        startedAt: "2026-11-25T10:00:00.000Z",
        finishedAt: "2026-11-25T10:04:30.000Z",
        durationMs: 270_000,
        failedCommit: COMMIT_A,
        passingCommit: COMMIT_B,
        measured: true,
        tokens: 1200,
        usd: 0.05,
      },
      {
        runId: "run-87654321",
        projectId: "proj-a",
        revision: 2,
        cause: "check",
        outcome: "blocked",
        rounds: 2,
        attempts: 4,
        coldReplacements: 1,
        failedResumes: 1,
        startedAt: "2026-11-25T11:00:00.000Z",
        failedCommit: COMMIT_C,
        measured: false,
      },
    ],
  };

  const textLines = formatRepairLoopReport(sampleReport).join("\n");
  assert.match(textLines, /Repair loops · last 14d · project proj-a/);
  assert.match(textLines, /cold replacements 1, failed resumes 1/);
  assert.match(textLines, /1 measured loops, 1 unmeasured loops, 1 unmeasured members — unmeasured omitted, never zero/);
  assert.match(textLines, /Warning: 1 of 2 loops have unmeasured member usage/);
  assert.match(textLines, /1200 tok \/ \$0\.05/);
  assert.match(textLines, /unmeasured/);

  const calls: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    await handleUsageRepairsCommand([], { "--project": "proj-a", "--days": "14" }, {
      json: async <T>(path: string) => { calls.push(path); return sampleReport as unknown as T; },
    });
    assert.deepEqual(calls, ["/usage/repair-loops?project=proj-a&days=14"]);
    assert.ok(logs.some(line => line.includes("Repair loops · last 14d")));

    logs.length = 0;
    await handleUsageRepairsCommand([], { "--json": true }, {
      json: async <T>(path: string) => { calls.push(path); return sampleReport as unknown as T; },
    });
    assert.deepEqual(JSON.parse(logs.join("\n")), sampleReport);
  } finally {
    console.log = origLog;
  }

  await assert.rejects(() => handleUsageRepairsCommand(["extra"], {}, { json: async () => sampleReport as never }), /Usage: infinite usage repairs/);
  await assert.rejects(() => handleUsageRepairsCommand([], { "--days": "0" }, { json: async () => sampleReport as never }), /between 1 and 366/);
  await assert.rejects(() => handleUsageRepairsCommand([], { "--project": "BAD!" }, { json: async () => sampleReport as never }), /Project ID must match/);
});
