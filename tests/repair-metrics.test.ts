import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createRemoteClient } from "@infinite/remote";
import {
  computeRepairLoopMetrics,
  runMayOverlapWindow,
  snapshotRepairRun,
  type RepairLoopCause,
  type RepairLoopReport,
  type RepairRunEvent,
  type RepairRunFilter,
} from "../packages/host/src/repair-metrics.js";
import { registerRepairMetricsRoute, type RepairMetricsRouteDeps } from "../packages/host/src/repair-metrics-routes.js";
import { formatRepairLoopReport, handleUsageRepairsCommand } from "../packages/host/src/repair-metrics-cli.js";
import { parseClientArgs } from "../packages/host/src/client.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { TeamCheck, TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import type { UsageTotals } from "../packages/host/src/usage.js";
import { startHost } from "./helpers.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
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
  round: 1,
  ...partial,
});

const reviewEvent = (revision: number, memberId: string, verdict: "approved" | "changes-requested", headCommit: string, at: string, seq?: number): RepairRunEvent =>
  ({ ...(seq === undefined ? {} : { seq }), kind: "review.recorded", revision, at, memberId, data: { v: 1, verdict, headCommit } });

const repairEvent = (revision: number, round: number, cause: RepairLoopCause, headCommit: string, at: string, seq?: number): RepairRunEvent =>
  ({ ...(seq === undefined ? {} : { seq }), kind: "repair.started", revision, at, data: { v: 1, round, cause, headCommit } });

const eventsByRun = (entries: Record<string, RepairRunEvent[]>): ((runId: string) => readonly RepairRunEvent[]) =>
  runId => entries[runId] ?? [];

function makeStandardReviewRun(id: string, extra?: Partial<TeamRun>, hour = "10"): { run: TeamRun; events: RepairRunEvent[] } {
  const t = (min: string) => `2026-11-25T${hour}:${min}:00.000Z`;
  const run = makeRun({
    id,
    members: [
      makeMember({ runId: id, memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: t("00"), report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: id, memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: t("01"), reportedAt: t("02"), report: { kind: "result", summary: "Fixed" } }),
      makeMember({ runId: id, memberId: "r1", role: "reviewer", baseCommit: COMMIT_B, startedAt: t("03"), reportedAt: t("04"), report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: `2026-11-25T${hour}:02:10.000Z`, finishedAt: `2026-11-25T${hour}:02:50.000Z` })],
    ...extra,
  });
  const events = [
    reviewEvent(1, "r0", "changes-requested", COMMIT_A, t("00"), 1),
    repairEvent(1, 1, "review", COMMIT_A, t("00"), 2),
    reviewEvent(1, "r1", "approved", COMMIT_B, t("04"), 3),
  ];
  return { run, events };
}

async function withRouteServer(deps: RepairMetricsRouteDeps, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  registerRepairMetricsRoute(app, deps);
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
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("measures resolved review-repair loop with duration, tokens, and USD", () => {
  const run = makeRun({
    id: "run-review-ok",
    members: [
      makeMember({ runId: "run-review-ok", memberId: "rev-0", role: "reviewer", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:00:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix edge case" } }),
      makeMember({ runId: "run-review-ok", memberId: "int-1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:02:30.000Z", reportedAt: "2026-11-25T10:05:30.000Z", report: { kind: "result", summary: "Fixed edge case" } }),
      makeMember({ runId: "run-review-ok", memberId: "rev-1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:07:00.000Z", reportedAt: "2026-11-25T10:08:00.000Z", report: { kind: "review", verdict: "approved", summary: "Looks good" } }),
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
    now: NOW,
    runEvents: eventsByRun({
      "run-review-ok": [
        reviewEvent(1, "rev-0", "changes-requested", COMMIT_A, "2026-11-25T10:02:00.000Z", 1),
        repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T10:02:00.000Z", 2),
        reviewEvent(1, "rev-1", "approved", COMMIT_B, "2026-11-25T10:08:00.000Z", 3),
      ],
    }),
  });

  assert.equal(report.windowDays, 30);
  assert.deepEqual(report.totals, {
    runsExamined: 1,
    eventCoverage: "complete",
    incompleteRuns: 0,
    loopsTotal: 1,
    resolved: 1,
    unresolved: 0,
    inProgress: 0,
    byCause: { review: 1, check: 0, delivery: 0 },
    coldReplacements: 0,
    failedResumes: 0,
    measuredLoops: 1,
    unmeasuredLoops: 0,
    unfinishedLoops: 0,
    unmeasuredMembers: 0,
    medianMinutes: 6,
    p90Minutes: 6,
    medianTokens: 1950,
    medianUsd: 0.2,
  });
  assert.deepEqual(report.loops, [{
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
  }]);
});

test("measures check-repair and delivery-repair loops and ignores non-repaired check failures", () => {
  const checkRepair = makeRun({
    id: "run-check-ok",
    members: [
      makeMember({ runId: "run-check-ok", memberId: "int-1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T11:02:00.000Z", reportedAt: "2026-11-25T11:04:00.000Z", report: { kind: "result", summary: "Fixed test" } }),
      makeMember({ runId: "run-check-ok", memberId: "rev-1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T11:05:00.000Z", reportedAt: "2026-11-25T11:07:00.000Z", report: { kind: "review", verdict: "approved", summary: "Approved" } }),
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
    round: 0,
    checks: [makeCheck({ status: "failed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T12:00:00.000Z", finishedAt: "2026-11-25T12:01:00.000Z" })],
  });
  const deliveryRepair = makeRun({
    id: "run-delivery-ok",
    members: [
      makeMember({ runId: "run-delivery-ok", memberId: "del-0", role: "delivery", baseCommit: COMMIT_A, startedAt: "2026-11-25T13:00:00.000Z", reportedAt: "2026-11-25T13:01:00.000Z", report: { kind: "delivery-repair", headCommit: COMMIT_A, summary: "Rebase conflict" } }),
      makeMember({ runId: "run-delivery-ok", memberId: "int-d1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T13:01:30.000Z", reportedAt: "2026-11-25T13:03:00.000Z", report: { kind: "result", summary: "Rebased" } }),
      makeMember({ runId: "run-delivery-ok", memberId: "rev-d1", role: "reviewer", baseCommit: COMMIT_C, startedAt: "2026-11-25T13:04:00.000Z", reportedAt: "2026-11-25T13:05:00.000Z", report: { kind: "review", verdict: "approved", summary: "Approved after rebase" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_C, startedAt: "2026-11-25T13:03:10.000Z", finishedAt: "2026-11-25T13:03:50.000Z" })],
  });

  const report = computeRepairLoopMetrics([checkRepair, terminalFailedCheckNoRepair, deliveryRepair], () => makeUsage(0.1, 500), {
    now: NOW,
    runEvents: eventsByRun({
      "run-check-ok": [repairEvent(1, 1, "check", COMMIT_A, "2026-11-25T11:01:00.000Z", 1), reviewEvent(1, "rev-1", "approved", COMMIT_B, "2026-11-25T11:07:00.000Z", 2)],
      "run-delivery-ok": [repairEvent(1, 1, "delivery", COMMIT_A, "2026-11-25T13:01:00.000Z", 1), reviewEvent(1, "rev-d1", "approved", COMMIT_C, "2026-11-25T13:05:00.000Z", 2)],
    }),
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
      makeMember({ runId: "run-blocked", memberId: "rev-0", role: "reviewer", baseCommit: COMMIT_A, startedAt: "2026-11-25T14:00:00.000Z", reportedAt: "2026-11-25T14:01:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Missing tests" } }),
      makeMember({ runId: "run-blocked", memberId: "int-1a", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T14:02:00.000Z", stalledAt: "2026-11-25T14:17:00.000Z", stoppedReason: "No activity for 15 minutes" }),
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
      makeMember({ runId: "run-blocked", memberId: "int-2", role: "integrator", baseCommit: COMMIT_B, startedAt: "2026-11-25T14:22:00.000Z", reportedAt: "2026-11-25T14:25:00.000Z", report: { kind: "result", summary: "Second round fix" } }),
      makeMember({ runId: "run-blocked", memberId: "rev-2a", role: "reviewer", baseCommit: COMMIT_C, startedAt: "2026-11-25T14:26:00.000Z", stoppedReason: "Claude Code usage limit" }),
      makeMember({ runId: "run-blocked", memberId: "rev-2b", role: "reviewer", baseCommit: COMMIT_C, startedAt: "2026-11-25T14:27:00.000Z", reportedAt: "2026-11-25T14:29:00.000Z", stoppedReason: "Native resume failed; restarted", report: { kind: "review", verdict: "changes-requested", summary: "Still broken" } }),
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
      makeMember({ runId: "run-cancelled", revision: 1, memberId: "rev-sup", role: "reviewer", baseCommit: COMMIT_A, startedAt: "2026-11-25T15:00:00.000Z", reportedAt: "2026-11-25T15:01:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Changes needed" } }),
      makeMember({ runId: "run-cancelled", revision: 2, memberId: "rev-cancel", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T15:10:00.000Z", reportedAt: "2026-11-25T15:11:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "More changes" } }),
      makeMember({ runId: "run-cancelled", revision: 2, memberId: "int-cancel", role: "integrator", baseCommit: COMMIT_B, startedAt: "2026-11-25T15:12:00.000Z", status: "stopped" }),
    ],
  });

  const report = computeRepairLoopMetrics([multiRoundBlocked, cancelled], () => makeUsage(0.05, 400), {
    now: NOW,
    runEvents: eventsByRun({
      "run-blocked": [
        reviewEvent(1, "rev-0", "changes-requested", COMMIT_A, "2026-11-25T14:01:00.000Z", 1),
        repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T14:01:00.000Z", 2),
        repairEvent(1, 2, "check", COMMIT_B, "2026-11-25T14:21:30.000Z", 3),
        reviewEvent(1, "rev-2b", "changes-requested", COMMIT_C, "2026-11-25T14:29:00.000Z", 4),
      ],
      "run-cancelled": [
        reviewEvent(1, "rev-sup", "changes-requested", COMMIT_A, "2026-11-25T15:01:00.000Z", 1),
        repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T15:01:00.000Z", 2),
        reviewEvent(2, "rev-cancel", "changes-requested", COMMIT_B, "2026-11-25T15:11:00.000Z", 3),
        repairEvent(2, 1, "review", COMMIT_B, "2026-11-25T15:11:00.000Z", 4),
      ],
    }),
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
  assert.equal(blockedSample.attempts, 8);
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
      makeMember({ runId: "run-unmeasured", memberId: "rev-0", role: "reviewer", provider: "claude", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-unmeasured", memberId: "int-1", role: "integrator", provider: "opencode", startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:03:00.000Z", report: { kind: "result", summary: "Fixed" } }),
      makeMember({ runId: "run-unmeasured", memberId: "rev-1", role: "reviewer", provider: "claude", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:04:00.000Z", reportedAt: "2026-11-25T10:05:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:03:10.000Z", finishedAt: "2026-11-25T10:03:50.000Z" })],
  });

  const report = computeRepairLoopMetrics(
    [unmeasuredRun],
    (member, fallback) => (member.provider ?? fallback) === "opencode" ? makeUsage(0.5, 2000) : undefined,
    {
      now: NOW,
      runEvents: eventsByRun({
        "run-unmeasured": [
          reviewEvent(1, "rev-0", "changes-requested", COMMIT_A, "2026-11-25T10:00:00.000Z", 1),
          repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T10:00:00.000Z", 2),
          reviewEvent(1, "rev-1", "approved", COMMIT_B, "2026-11-25T10:05:00.000Z", 3),
        ],
      }),
    },
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
  const runs: TeamRun[] = [];
  const evMap: Record<string, RepairRunEvent[]> = {};
  for (let i = 0; i < 55; i++) {
    const id = `run-${String(i).padStart(2, "0")}`;
    const start = new Date(NOW - (i + 1) * 3600_000).toISOString();
    const end = new Date(NOW - (i + 1) * 3600_000 + 120_000).toISOString();
    runs.push(makeRun({
      id,
      projectId: "proj-target",
      createdAt: start,
      updatedAt: end,
      members: [
        makeMember({ runId: id, memberId: `r0-${i}`, role: "reviewer", baseCommit: COMMIT_A, reportedAt: start, report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
        makeMember({ runId: id, memberId: `i1-${i}`, role: "integrator", baseCommit: COMMIT_A, startedAt: start, reportedAt: end, report: { kind: "result", summary: "Done" } }),
        makeMember({ runId: id, memberId: `r1-${i}`, role: "reviewer", baseCommit: COMMIT_B, startedAt: end, reportedAt: end, report: { kind: "review", verdict: "approved", summary: "OK" } }),
      ],
      checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: end, finishedAt: end })],
    }));
    evMap[id] = [
      reviewEvent(1, `r0-${i}`, "changes-requested", COMMIT_A, start, 1),
      repairEvent(1, 1, "review", COMMIT_A, start, 2),
      reviewEvent(1, `r1-${i}`, "approved", COMMIT_B, end, 3),
    ];
  }
  runs.push(
    makeRun({ id: "run-old", projectId: "proj-target", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T01:00:00.000Z", members: [makeMember({ runId: "run-old", memberId: "r-old", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-10-01T00:30:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Old" } })] }),
    makeRun({ id: "run-other", projectId: "proj-other", createdAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T01:00:00.000Z", members: [makeMember({ runId: "run-other", memberId: "r-other", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T00:30:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Other" } })] }),
    makeRun({ id: "run-replay", projectId: "proj-target", replay: { jobId: "j1", trialId: "t1", purpose: "replay" }, members: [makeMember({ runId: "run-replay", memberId: "r-replay", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T00:30:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Replay" } })] }),
  );

  const report = computeRepairLoopMetrics(runs, () => makeUsage(0.01, 100), { projectId: "proj-target", days: 10, now: NOW, runEvents: eventsByRun(evMap) });
  assert.equal(report.projectId, "proj-target");
  assert.equal(report.windowDays, 10);
  assert.equal(report.totals.runsExamined, 55);
  assert.equal(report.totals.loopsTotal, 55);
  assert.equal(report.loops.length, 50);
  assert.equal(report.loops[0]!.runId, "run-00");
  assert.equal(report.loops[0]!.attempts, 3);
  assert.equal(report.loops[0]!.tokens, 200);
  assert.equal(report.loops[0]!.usd, 0.02);
  assert.equal(report.loops[49]!.runId, "run-49");
  assert.equal(report.loops[49]!.attempts, 3);
  assert.equal(report.loops[49]!.tokens, 200);
  assert.equal(report.loops[49]!.usd, 0.02);
});

test("treats pricing.unknown > 0 and partial coverage as unmeasured in metrics and route", async () => {
  const { run, events } = makeStandardReviewRun("run-pricing-unknown");
  const ev = eventsByRun({ "run-pricing-unknown": events });
  const unknownUsage: UsageTotals = {
    cost: 0,
    tokens: { input: 500, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    pricing: { configured: 0, catalog: 0, provider: 0, unknown: 1 },
  };
  const direct = computeRepairLoopMetrics([run], member => member.memberId === "i1" ? makeUsage(0.2, 500) : unknownUsage, { now: NOW, runEvents: ev });
  assert.equal(direct.totals.measuredLoops, 0);
  assert.equal(direct.totals.unmeasuredLoops, 1);
  assert.equal(direct.totals.unmeasuredMembers, 1);
  assert.equal(direct.totals.medianTokens, null);
  assert.equal(direct.totals.medianUsd, null);
  assert.equal(direct.loops[0]!.measured, false);
  assert.equal(direct.loops[0]!.usd, undefined);

  let mode: "partial" | "unknown" | "unreadable" = "partial";
  await withRouteServer({
    runs: () => mode === "unreadable" ? [] : [run],
    runEvents: ev,
    readable: () => mode !== "unreadable",
    memberUsage: (_runId, memberId) => mode === "partial"
      ? (memberId === "i1" ? { ...makeUsage(0.2, 500), measured: true, coverage: "complete" } : { ...makeUsage(0.1, 300), measured: true, coverage: "partial", coverageReason: "drain-incomplete" })
      : { ...unknownUsage, measured: true, coverage: "complete" },
    now: () => NOW,
  }, async base => {
    const partialBody = await (await fetch(`${base}/api/usage/repair-loops`)).json() as RepairLoopReport;
    assert.equal(partialBody.totals.measuredLoops, 0);
    assert.equal(partialBody.totals.unmeasuredLoops, 1);
    assert.equal(partialBody.totals.unmeasuredMembers, 1);
    assert.equal(partialBody.totals.medianUsd, null);

    mode = "unknown";
    const unknownBody = await (await fetch(`${base}/api/usage/repair-loops`)).json() as RepairLoopReport;
    assert.equal(unknownBody.totals.measuredLoops, 0);
    assert.equal(unknownBody.totals.unmeasuredLoops, 1);
    assert.equal(unknownBody.totals.unmeasuredMembers, 2);
    assert.equal(unknownBody.totals.medianUsd, null);

    mode = "unreadable";
    assert.equal((await fetch(`${base}/api/usage/repair-loops`)).status, 503);
  });
});

test("preserves member order for same-millisecond delivery-repair + integrator and check ties", () => {
  const ts = "2026-11-25T10:00:00.000Z";
  const sameMsDelivery = makeRun({
    id: "run-same-ms-delivery",
    members: [
      makeMember({ runId: "run-same-ms-delivery", memberId: "del-0", role: "delivery", baseCommit: COMMIT_A, startedAt: ts, reportedAt: ts, report: { kind: "delivery-repair", headCommit: COMMIT_A, summary: "Conflict" } }),
      makeMember({ runId: "run-same-ms-delivery", memberId: "int-1", role: "integrator", baseCommit: COMMIT_A, startedAt: ts, reportedAt: ts, report: { kind: "result", summary: "Rebased" } }),
      makeMember({ runId: "run-same-ms-delivery", memberId: "rev-1", role: "reviewer", baseCommit: COMMIT_B, startedAt: ts, reportedAt: ts, report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: ts, finishedAt: ts })],
  });

  const report = computeRepairLoopMetrics([sameMsDelivery], () => makeUsage(0.1, 100), {
    now: NOW,
    runEvents: eventsByRun({ "run-same-ms-delivery": [repairEvent(1, 1, "delivery", COMMIT_A, ts, 1), reviewEvent(1, "rev-1", "approved", COMMIT_B, ts, 2)] }),
  });
  assert.equal(report.totals.resolved, 1);
  assert.deepEqual(report.totals.byCause, { review: 0, check: 0, delivery: 1 });
  assert.equal(report.loops[0]!.attempts, 3);
  assert.equal(report.loops[0]!.tokens, 200);
  assert.equal(report.loops[0]!.usd, 0.2);
});

test("rejects resolution on missing check, stale round check, setup-only check, and evidence-rejected approval retry", () => {
  const noCheck = makeStandardReviewRun("run-no-check", { status: "blocked", checks: [] });
  const staleCheckRun = makeRun({
    id: "run-stale-check",
    status: "blocked",
    members: [
      makeMember({ runId: "run-stale-check", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-stale-check", memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "result", summary: "Round 1" } }),
      makeMember({ runId: "run-stale-check", memberId: "r1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:04:00.000Z", reportedAt: "2026-11-25T10:05:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Round 2" } }),
      makeMember({ runId: "run-stale-check", memberId: "i2", role: "integrator", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:06:00.000Z", reportedAt: "2026-11-25T10:07:00.000Z", report: { kind: "result", summary: "Round 2 fix" } }),
      makeMember({ runId: "run-stale-check", memberId: "r2", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:08:00.000Z", reportedAt: "2026-11-25T10:09:00.000Z", report: { kind: "review", verdict: "approved", summary: "Stale commit" } }),
    ],
    checks: [
      makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:03:00.000Z" }),
      makeCheck({ status: "failed", round: 2, headCommit: COMMIT_C, startedAt: "2026-11-25T10:07:10.000Z", finishedAt: "2026-11-25T10:07:50.000Z" }),
    ],
  });
  const setupOnly = makeStandardReviewRun("run-setup-only", {
    status: "blocked",
    checks: [makeCheck({ status: "passed", phase: "setup", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:02:50.000Z" })],
  });
  const evidenceRetryRun = makeRun({
    id: "run-evidence-retry",
    brief: { title: "UI change", problem: "Broken button", evidence: [{ source: "tests", observation: "fails" }], dataShape: "string", acceptance: ["Button works"], expectedOutcome: "Works", uiChanges: true },
    members: [
      makeMember({ runId: "run-evidence-retry", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-evidence-retry", memberId: "i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "result", summary: "Fixed" } }),
      makeMember({ runId: "run-evidence-retry", memberId: "r1a", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:03:00.000Z", reportedAt: "2026-11-25T10:04:00.000Z", report: { kind: "review", verdict: "approved", summary: "Missing UI evidence" } }),
      makeMember({ runId: "run-evidence-retry", memberId: "r1b", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:05:00.000Z", reportedAt: "2026-11-25T10:06:00.000Z", report: { kind: "review", verdict: "approved", summary: "Verified UI", uiEvidence: "Clicked button in browser", acceptance: [{ criterion: 1, verdict: "verified", evidence: "Button worked" }] } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:02:50.000Z" })],
  });

  const report = computeRepairLoopMetrics([noCheck.run, staleCheckRun, setupOnly.run, evidenceRetryRun], () => makeUsage(0.05, 100), {
    now: NOW,
    runEvents: eventsByRun({
      "run-no-check": noCheck.events,
      "run-stale-check": [
        reviewEvent(1, "r0", "changes-requested", COMMIT_A, "2026-11-25T10:00:00.000Z", 1),
        repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T10:00:00.000Z", 2),
        reviewEvent(1, "r1", "changes-requested", COMMIT_B, "2026-11-25T10:05:00.000Z", 3),
        repairEvent(1, 2, "review", COMMIT_B, "2026-11-25T10:05:00.000Z", 4),
        reviewEvent(1, "r2", "approved", COMMIT_B, "2026-11-25T10:09:00.000Z", 5),
      ],
      "run-setup-only": setupOnly.events,
      "run-evidence-retry": [
        reviewEvent(1, "r0", "changes-requested", COMMIT_A, "2026-11-25T10:00:00.000Z", 1),
        repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T10:00:00.000Z", 2),
        reviewEvent(1, "r1b", "approved", COMMIT_B, "2026-11-25T10:06:00.000Z", 3),
      ],
    }),
  });

  assert.equal(report.totals.loopsTotal, 4);
  assert.equal(report.totals.resolved, 1);
  assert.equal(report.totals.unresolved, 3);
  assert.equal(report.loops.find(loop => loop.runId === "run-no-check")!.outcome, "blocked");
  assert.equal(report.loops.find(loop => loop.runId === "run-stale-check")!.outcome, "blocked");
  assert.equal(report.loops.find(loop => loop.runId === "run-setup-only")!.outcome, "blocked");
  const retrySample = report.loops.find(loop => loop.runId === "run-evidence-retry")!;
  assert.equal(retrySample.outcome, "resolved");
  assert.equal(retrySample.coldReplacements, 1);
  assert.equal(retrySample.attempts, 4);
  assert.equal(retrySample.finishedAt, "2026-11-25T10:06:00.000Z");
  assert.equal(retrySample.durationMs, 360_000);
});

test("requires host-accepted review.recorded evidence matching member, revision, and head before resolving", () => {
  const readOnlyRejected = makeStandardReviewRun("run-ro-rejected", { status: "blocked" }, "10");
  const mismatchedHead = makeStandardReviewRun("run-wrong-head", { status: "blocked" }, "11");
  const mismatchedMember = makeStandardReviewRun("run-wrong-member", { status: "blocked" }, "12");

  const report = computeRepairLoopMetrics([readOnlyRejected.run, mismatchedHead.run, mismatchedMember.run], () => makeUsage(0.05, 200), {
    now: NOW,
    runEvents: eventsByRun({
      "run-ro-rejected": readOnlyRejected.events.slice(0, 2),
      "run-wrong-head": [...mismatchedHead.events.slice(0, 2), reviewEvent(1, "r1", "approved", COMMIT_A, "2026-11-25T11:04:00.000Z", 3)],
      "run-wrong-member": [...mismatchedMember.events.slice(0, 2), reviewEvent(1, "other-rev", "approved", COMMIT_B, "2026-11-25T12:04:00.000Z", 3)],
    }),
  });

  assert.equal(report.totals.loopsTotal, 3);
  assert.equal(report.totals.resolved, 0);
  assert.equal(report.totals.unresolved, 3);
  for (const sample of report.loops) {
    assert.equal(sample.outcome, "blocked");
    assert.equal(sample.finishedAt, undefined);
    assert.equal(sample.passingCommit, undefined);
  }
});

test("counts check repairs admitted by repair.started even before integrator is queued (blocked setup and in-progress prep)", () => {
  const blockedSetup = makeRun({
    id: "run-check-setup-blocked",
    status: "blocked",
    blockCode: "team-setup-failed",
    round: 1,
    checks: [makeCheck({ status: "failed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:01:00.000Z" })],
  });
  const prepInProgress = makeRun({
    id: "run-check-prep-running",
    status: "integrating",
    round: 1,
    checks: [makeCheck({ status: "failed", round: 0, headCommit: COMMIT_B, startedAt: "2026-11-25T11:00:00.000Z", finishedAt: "2026-11-25T11:01:00.000Z" })],
  });
  const neverEntered = makeRun({
    id: "run-check-no-repair",
    status: "blocked",
    blockCode: "repeated-check-failure",
    round: 0,
    checks: [makeCheck({ status: "failed", round: 0, headCommit: COMMIT_C, startedAt: "2026-11-25T12:00:00.000Z", finishedAt: "2026-11-25T12:01:00.000Z" })],
  });

  const report = computeRepairLoopMetrics([blockedSetup, prepInProgress, neverEntered], () => makeUsage(0.1, 100), {
    now: NOW,
    runEvents: eventsByRun({
      "run-check-setup-blocked": [repairEvent(1, 1, "check", COMMIT_A, "2026-11-25T10:01:00.000Z", 1)],
      "run-check-prep-running": [repairEvent(1, 1, "check", COMMIT_B, "2026-11-25T11:01:00.000Z", 1)],
    }),
  });

  assert.equal(report.totals.runsExamined, 3);
  assert.equal(report.totals.loopsTotal, 2);
  assert.equal(report.totals.resolved, 0);
  assert.equal(report.totals.unresolved, 1);
  assert.equal(report.totals.inProgress, 1);
  assert.deepEqual(report.totals.byCause, { review: 0, check: 2, delivery: 0 });

  const blocked = report.loops.find(loop => loop.runId === "run-check-setup-blocked")!;
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.rounds, 1);
  assert.equal(blocked.attempts, 1);
  assert.equal(blocked.failedCommit, COMMIT_A);
  assert.equal(blocked.measured, false);

  const inProgress = report.loops.find(loop => loop.runId === "run-check-prep-running")!;
  assert.equal(inProgress.outcome, "in-progress");
  assert.equal(inProgress.rounds, 1);
  assert.equal(inProgress.attempts, 1);
  assert.equal(inProgress.failedCommit, COMMIT_B);
  assert.equal(inProgress.measured, false);
});

test("does not open phantom loops for rejected changes-requested or rejected delivery-repair reports", () => {
  const rejectedReview = makeRun({
    id: "run-rejected-review",
    status: "ready-for-review",
    round: 0,
    brief: { title: "Fix", problem: "Bug", evidence: [{ source: "tests", observation: "fails" }], dataShape: "string", acceptance: ["Passes"], expectedOutcome: "Works", uiChanges: false },
    members: [
      makeMember({ runId: "run-rejected-review", memberId: "r0-dup", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Duplicate acceptance", acceptance: [{ criterion: 1, verdict: "not-verified", evidence: "First" }, { criterion: 1, verdict: "not-verified", evidence: "Duplicate" }] } }),
      makeMember({ runId: "run-rejected-review", memberId: "r0-ok", role: "reviewer", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "review", verdict: "approved", summary: "Approved", acceptance: [{ criterion: 1, verdict: "verified", evidence: "Verified" }] } }),
    ],
    checks: [makeCheck({ status: "passed", round: 0, headCommit: COMMIT_A, startedAt: "2026-11-25T09:59:00.000Z", finishedAt: "2026-11-25T09:59:30.000Z" })],
  });
  const rejectedDelivery = makeRun({
    id: "run-rejected-delivery",
    status: "blocked",
    round: 0,
    members: [makeMember({ runId: "run-rejected-delivery", memberId: "del-stale", role: "delivery", baseCommit: COMMIT_A, reportedAt: "2026-11-25T11:00:00.000Z", report: { kind: "delivery-repair", headCommit: COMMIT_B, summary: "Wrong head" } })],
  });
  const rejectedThenAcceptedDelivery = makeRun({
    id: "run-delivery-retry",
    status: "ready-for-review",
    round: 1,
    members: [
      makeMember({ runId: "run-delivery-retry", memberId: "del-rej", role: "delivery", baseCommit: COMMIT_A, startedAt: "2026-11-25T12:00:00.000Z", reportedAt: "2026-11-25T12:01:00.000Z", report: { kind: "delivery-repair", headCommit: COMMIT_A, summary: "Missing reconciliation" } }),
      makeMember({ runId: "run-delivery-retry", memberId: "del-acc", role: "delivery", baseCommit: COMMIT_A, startedAt: "2026-11-25T12:03:00.000Z", reportedAt: "2026-11-25T12:04:00.000Z", report: { kind: "delivery-repair", headCommit: COMMIT_A, summary: "Admitted conflict" } }),
      makeMember({ runId: "run-delivery-retry", memberId: "int-1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T12:05:00.000Z", reportedAt: "2026-11-25T12:07:00.000Z", report: { kind: "result", summary: "Rebased" } }),
      makeMember({ runId: "run-delivery-retry", memberId: "rev-1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T12:08:00.000Z", reportedAt: "2026-11-25T12:09:00.000Z", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T12:07:10.000Z", finishedAt: "2026-11-25T12:07:50.000Z" })],
  });

  const report = computeRepairLoopMetrics([rejectedReview, rejectedDelivery, rejectedThenAcceptedDelivery], () => makeUsage(0.1, 100), {
    now: NOW,
    runEvents: eventsByRun({
      "run-rejected-review": [reviewEvent(1, "r0-ok", "approved", COMMIT_A, "2026-11-25T10:02:00.000Z", 1)],
      "run-delivery-retry": [repairEvent(1, 1, "delivery", COMMIT_A, "2026-11-25T12:04:00.000Z", 1), reviewEvent(1, "rev-1", "approved", COMMIT_B, "2026-11-25T12:09:00.000Z", 2)],
    }),
  });

  assert.equal(report.totals.loopsTotal, 1);
  assert.equal(report.totals.resolved, 1);
  assert.equal(report.totals.unresolved, 0);
  assert.equal(report.loops[0]!.runId, "run-delivery-retry");
  assert.equal(report.loops[0]!.startedAt, "2026-11-25T12:04:00.000Z");
  assert.equal(report.loops[0]!.durationMs, 300_000);
});

test("keeps unfinished loops and active or non-exited sessions out of final repair-cost medians", async () => {
  const finished = makeStandardReviewRun("run-finished", {}, "10");
  const liveRunning = makeRun({
    id: "run-live-opencode",
    status: "integrating",
    members: [
      makeMember({ runId: "run-live-opencode", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T11:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-live-opencode", memberId: "i-live", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T11:01:00.000Z", status: "running" }),
    ],
  });
  const inProgressVerifying = makeRun({
    id: "run-live-verifying",
    status: "verifying",
    members: [
      makeMember({ runId: "run-live-verifying", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T12:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-live-verifying", memberId: "i-done", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T12:01:00.000Z", reportedAt: "2026-11-25T12:02:00.000Z", status: "stopped", report: { kind: "result", summary: "Fixed" } }),
    ],
    checks: [makeCheck({ status: "running", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T12:02:10.000Z" })],
  });
  const cancelledActive = makeRun({
    id: "run-cancel-active",
    status: "cancelled",
    members: [
      makeMember({ runId: "run-cancel-active", memberId: "r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T13:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Fix" } }),
      makeMember({ runId: "run-cancel-active", memberId: "i-canceling", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T13:01:00.000Z", status: "running" }),
    ],
  });
  const ev = eventsByRun({
    "run-finished": finished.events,
    "run-live-opencode": [reviewEvent(1, "r0", "changes-requested", COMMIT_A, "2026-11-25T11:00:00.000Z", 1), repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T11:00:00.000Z", 2)],
    "run-live-verifying": [reviewEvent(1, "r0", "changes-requested", COMMIT_A, "2026-11-25T12:00:00.000Z", 1), repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T12:00:00.000Z", 2)],
    "run-cancel-active": [reviewEvent(1, "r0", "changes-requested", COMMIT_A, "2026-11-25T13:00:00.000Z", 1), repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T13:00:00.000Z", 2)],
  });

  await withRouteServer({
    runs: () => [finished.run, liveRunning, inProgressVerifying, cancelledActive],
    runEvents: ev,
    memberUsage: (runId, memberId) => {
      if (runId === "run-finished") return { ...makeUsage(0.1, 1000), measured: true, coverage: "complete" };
      if (memberId === "i-done") return { ...makeUsage(0.02, 200), measured: true, coverage: "complete" };
      return { ...makeUsage(0, 0), measured: true, coverage: "complete" };
    },
    now: () => NOW,
  }, async base => {
    const body = await (await fetch(`${base}/api/usage/repair-loops`)).json() as RepairLoopReport;
    assert.equal(body.totals.loopsTotal, 4);
    assert.equal(body.totals.resolved, 1);
    assert.equal(body.totals.inProgress, 2);
    assert.equal(body.totals.unresolved, 1);
    assert.equal(body.totals.measuredLoops, 1);
    assert.equal(body.totals.unmeasuredLoops, 0);
    assert.equal(body.totals.unfinishedLoops, 3);
    assert.equal(body.totals.unmeasuredMembers, 0);
    assert.equal(body.totals.medianTokens, 2000);
    assert.equal(body.totals.medianUsd, 0.2);
    for (const id of ["run-live-opencode", "run-live-verifying", "run-cancel-active"]) {
      const sample = body.loops.find(loop => loop.runId === id)!;
      assert.equal(sample.measured, false);
      assert.equal(sample.unfinished, true);
      assert.equal(sample.tokens, undefined);
      assert.equal(sample.usd, undefined);
    }
  });

  const dir = mkdtempSync(join(tmpdir(), "inf-repair-usage-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    const config = { stateDir: dir, usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, budgets: {}, accounts: {} } } as unknown as Config;
    const rowsBySession: Record<string, { type: string; data: unknown }[]> = { "sess-oc": [] };
    const manager = {
      list: async () => [],
      events: (id: string, cursor: number) => ({ events: (rowsBySession[id] ?? []).slice(cursor), cursor: (rowsBySession[id] ?? []).length, more: false }),
    } as unknown as Manager;
    const usage = new UsageService(config, key, manager, store);
    const row = (status: "running" | "exited"): UsageSessionRow => ({
      id: "sess-oc", provider: "opencode", projectId: "proj-a", status, createdAt: "2026-11-25T10:00:00.000Z",
      team: { runId: "run-oc", memberId: "m-oc", role: "integrator", revision: 1 },
      teamModelProfile: { id: "oc", label: "OC", provider: "opencode", model: "deepseek/deepseek-flash" },
    }) as unknown as UsageSessionRow;
    await usage.tick([row("running")]);
    assert.equal(usage.member("run-oc", "m-oc").measured, true);
    assert.equal(usage.memberFinal("run-oc", "m-oc").measured, false);
    rowsBySession["sess-oc"] = [{
      type: "usage",
      data: { provider: "opencode", providerId: "deepseek", modelId: "deepseek-flash", messageId: "m1", partId: "p1", modelSource: "reported", completedAt: "2026-11-25T10:01:00.000Z", tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, reportedCost: 0 },
    }];
    await usage.tick([row("exited")]);
    const finalUsage = usage.memberFinal("run-oc", "m-oc");
    assert.equal(finalUsage.measured, true);
    if (finalUsage.measured) {
      assert.equal(finalUsage.coverage, "complete");
      assert.equal(finalUsage.messages, 1);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counts failed resume and fallback start turns as distinct launch attempts", () => {
  const { run, events } = makeStandardReviewRun("run-resume-fallback");
  run.members[1]!.turns = [
    { sessionId: "sess-res", decisionId: "d1", startedAt: "2026-11-25T10:01:00.000Z", mode: "resume" },
    { sessionId: "sess-fb", decisionId: "d1", startedAt: "2026-11-25T10:01:30.000Z", mode: "start" },
  ];
  const report = computeRepairLoopMetrics([run], () => makeUsage(0.1, 300), { now: NOW, runEvents: eventsByRun({ "run-resume-fallback": events }) });
  assert.equal(report.loops[0]!.outcome, "resolved");
  assert.equal(report.loops[0]!.failedResumes, 1);
  assert.equal(report.loops[0]!.attempts, 4);
});

test("filters out-of-window and other-project runs before cloning, reading events, or pricing usage", async () => {
  const oldRun = makeRun({
    id: "run-hist-old",
    projectId: "proj-target",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T02:00:00.000Z",
    members: [
      makeMember({ runId: "run-hist-old", memberId: "old-r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-10-01T00:10:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Old" } }),
      makeMember({ runId: "run-hist-old", memberId: "old-i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-10-01T00:20:00.000Z", reportedAt: "2026-10-01T00:30:00.000Z", report: { kind: "result", summary: "Old" } }),
    ],
  });
  const otherProj = makeRun({
    id: "run-hist-other",
    projectId: "proj-other",
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:30:00.000Z",
    members: [
      makeMember({ runId: "run-hist-other", memberId: "oth-r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", report: { kind: "review", verdict: "changes-requested", summary: "Other" } }),
      makeMember({ runId: "run-hist-other", memberId: "oth-i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", report: { kind: "result", summary: "Other" } }),
    ],
  });
  const multiRev = makeRun({
    id: "run-multi-rev",
    projectId: "proj-target",
    revision: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-11-25T11:00:00.000Z",
    members: [
      makeMember({ runId: "run-multi-rev", revision: 1, memberId: "m-old-r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-10-01T00:10:00.000Z", prompt: "HUGE_PROMPT", report: { kind: "review", verdict: "changes-requested", summary: "Old rev" } }),
      makeMember({ runId: "run-multi-rev", revision: 1, memberId: "m-old-i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-10-01T00:20:00.000Z", reportedAt: "2026-10-01T00:30:00.000Z", prompt: "HUGE_PROMPT", report: { kind: "result", summary: "Old rev" } }),
      makeMember({ runId: "run-multi-rev", revision: 2, memberId: "m-new-r0", role: "reviewer", baseCommit: COMMIT_A, reportedAt: "2026-11-25T10:00:00.000Z", prompt: "HUGE_PROMPT", report: { kind: "review", verdict: "changes-requested", summary: "New rev" } }),
      makeMember({ runId: "run-multi-rev", revision: 2, memberId: "m-new-i1", role: "integrator", baseCommit: COMMIT_A, startedAt: "2026-11-25T10:01:00.000Z", reportedAt: "2026-11-25T10:02:00.000Z", prompt: "HUGE_PROMPT", report: { kind: "result", summary: "New rev" } }),
      makeMember({ runId: "run-multi-rev", revision: 2, memberId: "m-new-r1", role: "reviewer", baseCommit: COMMIT_B, startedAt: "2026-11-25T10:03:00.000Z", reportedAt: "2026-11-25T10:04:00.000Z", prompt: "HUGE_PROMPT", report: { kind: "review", verdict: "approved", summary: "OK" } }),
    ],
    checks: [makeCheck({ revision: 2, status: "passed", round: 1, headCommit: COMMIT_B, startedAt: "2026-11-25T10:02:10.000Z", finishedAt: "2026-11-25T10:02:50.000Z", output: "HUGE_CHECK_OUTPUT" })],
  });

  const cutoffMs = NOW - 7 * 86_400_000;
  assert.equal(runMayOverlapWindow(oldRun, { projectId: "proj-target", cutoffMs }), false);
  assert.equal(runMayOverlapWindow(otherProj, { projectId: "proj-target", cutoffMs }), false);
  assert.equal(runMayOverlapWindow(multiRev, { projectId: "proj-target", cutoffMs }), true);
  const snap = snapshotRepairRun(multiRev);
  assert.equal("prompt" in snap.members[0]!, false);
  assert.equal("output" in snap.checks[0]!, false);

  const eventLookups: string[] = [];
  const usageLookups: string[] = [];
  const ev = eventsByRun({
    "run-hist-old": [reviewEvent(1, "old-r0", "changes-requested", COMMIT_A, "2026-10-01T00:10:00.000Z", 1), repairEvent(1, 1, "review", COMMIT_A, "2026-10-01T00:10:00.000Z", 2)],
    "run-hist-other": [reviewEvent(1, "oth-r0", "changes-requested", COMMIT_A, "2026-11-25T10:00:00.000Z", 1), repairEvent(1, 1, "review", COMMIT_A, "2026-11-25T10:00:00.000Z", 2)],
    "run-multi-rev": [
      reviewEvent(1, "m-old-r0", "changes-requested", COMMIT_A, "2026-10-01T00:10:00.000Z", 1),
      repairEvent(1, 1, "review", COMMIT_A, "2026-10-01T00:10:00.000Z", 2),
      reviewEvent(2, "m-new-r0", "changes-requested", COMMIT_A, "2026-11-25T10:00:00.000Z", 3),
      repairEvent(2, 1, "review", COMMIT_A, "2026-11-25T10:00:00.000Z", 4),
      reviewEvent(2, "m-new-r1", "approved", COMMIT_B, "2026-11-25T10:04:00.000Z", 5),
    ],
  });

  const report = computeRepairLoopMetrics(
    [oldRun, otherProj, multiRev],
    member => { usageLookups.push(`${member.runId}:${member.memberId}`); return makeUsage(0.1, 100); },
    { projectId: "proj-target", days: 7, now: NOW, runEvents: runId => { eventLookups.push(runId); return ev(runId); } },
  );

  assert.equal(report.totals.loopsTotal, 1);
  assert.deepEqual(eventLookups, ["run-multi-rev"]);
  assert.deepEqual(usageLookups, ["run-multi-rev:m-new-i1", "run-multi-rev:m-new-r1"]);

  const dir = mkdtempSync(join(tmpdir(), "inf-repair-ev-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(dir), vaultKey: key });
  try {
    store.write(tx => {
      for (const item of ev("run-multi-rev")) {
        store.appendEvent(tx, { key: `${item.kind}:${item.revision}:${item.memberId ?? item.data.round}`, runId: "run-multi-rev", revision: item.revision, at: item.at, kind: item.kind, ...(item.memberId ? { memberId: item.memberId } : {}), data: item.data });
      }
    });
    let receivedFilter: RepairRunFilter | undefined;
    await withRouteServer({
      runs: filter => { receivedFilter = filter; return [multiRev].filter(r => runMayOverlapWindow(r, filter)).map(snapshotRepairRun); },
      evidence: store,
      memberUsage: () => ({ ...makeUsage(0.1, 100), measured: true, coverage: "complete" }),
      now: () => NOW,
    }, async base => {
      const res = await fetch(`${base}/api/usage/repair-loops?project=proj-target&days=7`);
      assert.equal(res.status, 200);
      const body = await res.json() as RepairLoopReport;
      assert.deepEqual(receivedFilter, { projectId: "proj-target", cutoffMs });
      assert.equal(body.totals.resolved, 1);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerRepairMetricsRoute serves validated metrics and maps unavailable ledger to 503", async () => {
  const { run, events } = makeStandardReviewRun("run-route", { projectId: "proj-http", updatedAt: "2026-11-25T10:10:00.000Z" });
  let ledgerUnavailable = false;
  await withRouteServer({
    runs: () => [run],
    runEvents: eventsByRun({ "run-route": events }),
    memberUsage: () => ledgerUnavailable
      ? { measured: false, coverage: "none", unavailable: true }
      : { ...makeUsage(0.25, 1000), measured: true, coverage: "complete" },
    now: () => NOW,
  }, async base => {
    const ok = await fetch(`${base}/api/usage/repair-loops?project=proj-http&days=7`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as RepairLoopReport;
    assert.equal(body.windowDays, 7);
    assert.equal(body.projectId, "proj-http");
    assert.equal(body.totals.resolved, 1);
    assert.equal(body.totals.medianUsd, 0.5);

    assert.equal((await fetch(`${base}/api/usage/repair-loops?project=INVALID`)).status, 400);
    assert.equal((await fetch(`${base}/api/usage/repair-loops?days=0`)).status, 400);
    assert.equal((await fetch(`${base}/api/usage/repair-loops?extra=1`)).status, 400);

    ledgerUnavailable = true;
    assert.equal((await fetch(`${base}/api/usage/repair-loops`)).status, 503);
  });
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
    totals: { runsExamined: 3, eventCoverage: "complete", incompleteRuns: 0, loopsTotal: 2, resolved: 1, unresolved: 1, inProgress: 0, byCause: { review: 1, check: 1, delivery: 0 }, coldReplacements: 1, failedResumes: 1, measuredLoops: 1, unmeasuredLoops: 1, unfinishedLoops: 0, unmeasuredMembers: 1, medianMinutes: 4.5, p90Minutes: 4.5, medianTokens: 1200, medianUsd: 0.05 },
    loops: [
      { runId: "run-12345678", projectId: "proj-a", revision: 1, cause: "review", outcome: "resolved", rounds: 1, attempts: 3, coldReplacements: 0, failedResumes: 0, startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:04:30.000Z", durationMs: 270_000, failedCommit: COMMIT_A, passingCommit: COMMIT_B, measured: true, tokens: 1200, usd: 0.05 },
      { runId: "run-87654321", projectId: "proj-a", revision: 2, cause: "check", outcome: "blocked", rounds: 2, attempts: 4, coldReplacements: 1, failedResumes: 1, startedAt: "2026-11-25T11:00:00.000Z", failedCommit: COMMIT_C, measured: false },
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
