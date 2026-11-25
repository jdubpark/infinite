import assert from "node:assert/strict";
import test from "node:test";
import {
  goalCycleUsageSchema,
  isConfiguredChecksProject,
  isEstablishChecksProject,
  isPassedTeamCheck,
  projectTeamProject,
  recordedTeamReportEnvelopeSchema,
  teamCheckSchema,
  teamProjectSchema,
  teamReportEnvelopeSchema,
  usageRollupSchema,
  type GoalCycleUsage,
  type PassedTeamCheck,
  type TeamCheck,
  type TeamProject,
} from "../packages/host/src/team-types.js";
import {
  goalCycleSchema,
  isActiveGoalCycle,
  isFiniteCreateGoal,
  isSettledGoalCycle,
  isStandingCreateGoal,
  isUnclassifiedGoalCycle,
  parseCreateGoal,
  projectCreateGoal,
  projectGoalCycle,
  type ActiveGoalCycle,
  type GoalCycle,
  type UnclassifiedGoalCycle,
} from "../packages/host/src/goal-types.js";
import {
  httpControlRequestSchema,
  normalizeControlRequest,
  teamAnswerWorkerRequestSchema,
  workerControlRequestSchema,
  workerWorkspaceExportRequestSchema,
} from "../packages/host/src/types.js";
import { terminalInputSchema } from "../packages/host/src/terminal-stream.js";

const AT = "2026-11-25T12:00:00.000Z";
const LATER = "2026-11-25T12:05:00.000Z";
const HASH = "a".repeat(40);
const BASE_HASH = "b".repeat(40);
const LOWER_SHA256 = "0123456789abcdef".repeat(4);
const UPPER_SHA256 = LOWER_SHA256.toUpperCase();
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const CMD = { command: "npm", args: ["test"] };
const ACTOR = { id: "device-1:client-1", label: "Laptop CLI" };

test("HTTP and WebSocket control transport schemas normalize redundant takeover: false to strict worker requests", () => {
  for (const action of ["renew", "release"] as const) {
    const httpBody = httpControlRequestSchema.parse({ action, leaseId: UUID, takeover: false });
    const httpNormalized = normalizeControlRequest(httpBody, ACTOR);
    assert.deepEqual(httpNormalized, { op: "control", action, actor: ACTOR, leaseId: UUID });
    assert.equal(Object.hasOwn(httpNormalized, "takeover"), false);
    assert.equal(workerControlRequestSchema.safeParse(httpNormalized).success, true);

    const wsFrame = terminalInputSchema.parse({ op: "control", requestId: UUID2, action, leaseId: UUID, takeover: false });
    assert.equal(wsFrame.op, "control");
    if (wsFrame.op === "control") {
      const wsNormalized = normalizeControlRequest(wsFrame, ACTOR);
      assert.deepEqual(wsNormalized, httpNormalized);
      assert.equal(workerControlRequestSchema.safeParse(wsNormalized).success, true);
    }

    assert.equal(httpControlRequestSchema.safeParse({ action, leaseId: UUID, takeover: true }).success, false);
    assert.equal(terminalInputSchema.safeParse({ op: "control", requestId: UUID2, action, leaseId: UUID, takeover: true }).success, false);
    assert.equal(httpControlRequestSchema.safeParse({ action }).success, false);
    assert.equal(terminalInputSchema.safeParse({ op: "control", requestId: UUID2, action }).success, false);
  }

  const claimBody = httpControlRequestSchema.parse({ action: "claim", takeover: true });
  assert.deepEqual(normalizeControlRequest(claimBody, ACTOR), { op: "control", action: "claim", actor: ACTOR, takeover: true });
});

test("live teamReportEnvelopeSchema rejects incomplete delivery reconciliation while recordedTeamReportEnvelopeSchema preserves journal replay", () => {
  const legacyOwnedBranch = {
    kind: "delivery-reconciliation" as const,
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "owned-branch" as const,
    summary: "Remote branch existed before remoteHeadCommit became required.",
  };
  const legacyPullRequest = {
    kind: "delivery-reconciliation" as const,
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "pull-request" as const,
    remoteHeadCommit: HASH,
    summary: "PR existed before pullRequestUrl became required.",
  };
  const envelopeBase = { requestId: UUID, runId: UUID, memberId: UUID2, revision: 1 };

  assert.equal(teamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: legacyOwnedBranch }).success, false);
  assert.equal(teamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: legacyPullRequest }).success, false);
  assert.equal(recordedTeamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: legacyOwnedBranch }).success, true);
  assert.equal(recordedTeamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: legacyPullRequest }).success, true);

  const strictOwnedBranch = { ...legacyOwnedBranch, remoteHeadCommit: HASH };
  assert.equal(teamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: strictOwnedBranch }).success, true);

  const legacyQuestion = { kind: "question" as const, question: "Proceed with schema split?", options: ["Yes", "No"] };
  assert.equal(teamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: legacyQuestion }).success, true);
  assert.equal(recordedTeamReportEnvelopeSchema.safeParse({ ...envelopeBase, report: legacyQuestion }).success, true);
});

test("GoalCycle usage schema accepts current rollups, historical rollups without partialMembers, and legacy totals-only snapshots", () => {
  const totals = {
    cost: 0.04,
    tokens: { input: 120, output: 60, reasoning: 0, cacheRead: 10, cacheWrite: 5 },
    messages: 2,
    pricing: { configured: 1, catalog: 0, provider: 0, unknown: 0 },
  };
  const currentRollup = {
    total: totals,
    byProfile: { lead: totals },
    byProvider: { claude: totals },
    unmeasuredMembers: 0,
    partialMembers: 0,
  };
  const currentSnapshot: GoalCycleUsage = { ...totals, ...currentRollup };
  const historicalNoPartial: GoalCycleUsage = {
    ...totals,
    total: totals,
    byProfile: { lead: totals },
    byProvider: { claude: totals },
    unmeasuredMembers: 1,
  };
  const legacyTotalsOnly: GoalCycleUsage = totals;

  assert.equal(usageRollupSchema.safeParse(currentRollup).success, true);
  assert.equal(usageRollupSchema.safeParse({ total: totals, byProfile: {}, byProvider: {}, unmeasuredMembers: 0 }).success, false);

  const baseCycle = { teamId: UUID, cycle: 1, goalRevision: 1, status: "ready-for-review", startedAt: AT, finishedAt: LATER, memberCount: 2 };
  for (const usage of [currentSnapshot, historicalNoPartial, legacyTotalsOnly]) {
    assert.equal(goalCycleUsageSchema.safeParse(usage).success, true);
    assert.equal(goalCycleSchema.safeParse({ ...baseCycle, usage }).success, true);
  }
  assert.equal(goalCycleUsageSchema.safeParse({ ...totals, total: totals }).success, false);

  // @ts-expect-error totals-only GoalCycleUsage cannot attach partial rollup fields
  const invalidHalfSnapshot: GoalCycleUsage = { ...totals, total: totals };
  assert.ok(invalidHalfSnapshot);
});

test("GoalCycle distinguishes active, unclassified finished, and settled cycles while rejecting partial settlement", () => {
  const active: GoalCycle = { teamId: UUID, cycle: 1, goalRevision: 1, status: "implementing", startedAt: AT, memberCount: 2 };
  const unclassified: GoalCycle = { ...active, status: "ready-for-review", finishedAt: LATER };
  const settled: GoalCycle = { ...unclassified, class: "reviewed", settledAt: LATER };
  const settledWithoutFinishedAt: GoalCycle = { ...active, status: "cancelled", class: "excluded", settledAt: LATER };

  assert.equal(goalCycleSchema.safeParse(active).success, true);
  assert.equal(goalCycleSchema.safeParse(unclassified).success, true);
  assert.equal(goalCycleSchema.safeParse(settled).success, true);
  assert.equal(goalCycleSchema.safeParse(settledWithoutFinishedAt).success, true);

  assert.equal(isActiveGoalCycle(active), true);
  assert.equal(isUnclassifiedGoalCycle(active), false);
  assert.equal(isSettledGoalCycle(active), false);
  assert.equal(projectGoalCycle(active).state, "active");

  assert.equal(isActiveGoalCycle(unclassified), false);
  assert.equal(isUnclassifiedGoalCycle(unclassified), true);
  assert.equal(isSettledGoalCycle(unclassified), false);
  const projectedUnclassified = projectGoalCycle(unclassified);
  assert.equal(projectedUnclassified.state, "unclassified");
  if (projectedUnclassified.state === "unclassified") {
    const finishedAt: string = projectedUnclassified.cycle.finishedAt;
    assert.equal(finishedAt, LATER);
  }

  assert.equal(isActiveGoalCycle(settled), false);
  assert.equal(isUnclassifiedGoalCycle(settled), false);
  assert.equal(isSettledGoalCycle(settled), true);
  assert.equal(projectGoalCycle(settled).state, "settled");
  assert.equal(projectGoalCycle(settledWithoutFinishedAt).state, "settled");

  for (const malformed of [
    { ...active, class: "reviewed" as const },
    { ...active, settledAt: LATER },
    { ...unclassified, class: "reviewed" as const },
    { ...unclassified, settledAt: LATER },
  ]) {
    assert.equal(goalCycleSchema.safeParse(malformed).success, false);
    assert.equal(isActiveGoalCycle(malformed), false);
    assert.equal(isUnclassifiedGoalCycle(malformed), false);
    assert.equal(isSettledGoalCycle(malformed), false);
    assert.throws(() => projectGoalCycle(malformed));
  }

  const invalidActiveFinished: ActiveGoalCycle = {
    ...active,
    // @ts-expect-error active goal cycle cannot carry finishedAt
    finishedAt: LATER,
  };
  // @ts-expect-error unclassified goal cycle requires finishedAt
  const invalidUnclassifiedNoFinish: UnclassifiedGoalCycle = { ...active };
  assert.ok(invalidActiveFinished && invalidUnclassifiedNoFinish);
});

test("CreateGoal and TeamProject guards and projectors reject invalid coupled fields", () => {
  const standing = parseCreateGoal({
    requestId: UUID,
    projectId: "core",
    title: "Keep suite green",
    objective: "Monitor checks",
    successCriteria: "Checks stay green",
    standing: { shape: "objective", cadenceMinutes: 60 },
  });
  const finite = parseCreateGoal({
    requestId: UUID2,
    projectId: "core",
    title: "Fix bug",
    objective: "Repair parser",
    successCriteria: "Tests pass",
  });
  const invalidStandingWithMaxRuns = { ...standing, maxRuns: 2 };

  assert.equal(isStandingCreateGoal(standing), true);
  assert.equal(isFiniteCreateGoal(standing), false);
  assert.equal(isFiniteCreateGoal(finite), true);
  assert.equal(isStandingCreateGoal(finite), false);
  assert.equal(isStandingCreateGoal(invalidStandingWithMaxRuns), false);
  assert.equal(isFiniteCreateGoal(invalidStandingWithMaxRuns), false);
  assert.throws(() => projectCreateGoal(invalidStandingWithMaxRuns));

  const validEstablish = teamProjectSchema.parse({ checks: [], establishChecks: true });
  const validConfigured = teamProjectSchema.parse({ checks: [CMD], mainCheck: { minutes: 10 } });
  const invalidEstablishWithChecks: TeamProject = { checks: [CMD], establishChecks: true };
  const invalidEstablishWithMainCheck: TeamProject = { checks: [], establishChecks: true, mainCheck: { minutes: 10 } };
  const invalidEmptyChecks: TeamProject = { checks: [] };

  assert.equal(isEstablishChecksProject(validEstablish), true);
  assert.equal(isConfiguredChecksProject(validConfigured), true);
  assert.equal(projectTeamProject(validEstablish).establishChecks, true);
  assert.equal(projectTeamProject(validConfigured).checks.length, 1);

  for (const invalid of [invalidEstablishWithChecks, invalidEstablishWithMainCheck, invalidEmptyChecks]) {
    assert.equal(isEstablishChecksProject(invalid), false);
    assert.equal(isConfiguredChecksProject(invalid), false);
    assert.throws(() => projectTeamProject(invalid));
  }
});

test("PassedTeamCheck rejects nonzero exit codes and sync/blob requires lowercase SHA-256 hashes", () => {
  const passedZero: TeamCheck = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: 0, output: "ok", revision: 1, round: 0 };
  const passedNoCode: TeamCheck = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, output: "ok", revision: 1, round: 0 };
  const passedNonZero: TeamCheck = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: 1, output: "fail", revision: 1, round: 0 };
  const passedNullCode: TeamCheck = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: null, output: "signal", revision: 1, round: 0 };

  assert.equal(teamCheckSchema.safeParse(passedZero).success, true);
  assert.equal(teamCheckSchema.safeParse(passedNoCode).success, true);
  assert.equal(teamCheckSchema.safeParse(passedNonZero).success, false);
  assert.equal(teamCheckSchema.safeParse(passedNullCode).success, false);
  assert.equal(isPassedTeamCheck(passedZero), true);
  assert.equal(isPassedTeamCheck(passedNoCode), true);
  assert.equal(isPassedTeamCheck(passedNonZero), false);
  assert.equal(isPassedTeamCheck(passedNullCode), false);

  const invalidPassedCode: PassedTeamCheck = {
    command: CMD,
    status: "passed",
    startedAt: AT,
    finishedAt: LATER,
    // @ts-expect-error passed check exitCode must be 0 when present
    exitCode: 1,
    output: "fail",
    revision: 1,
  };
  assert.ok(invalidPassedCode);

  assert.equal(workerWorkspaceExportRequestSchema.safeParse({ op: "workspace-export", method: "sync/blob", hash: LOWER_SHA256 }).success, true);
  assert.equal(workerWorkspaceExportRequestSchema.safeParse({ op: "workspace-export", method: "sync/blob", hash: UPPER_SHA256 }).success, false);

  const upperDigestAnswer = {
    op: "team-answer" as const,
    requestId: "req-1",
    decisionId: UUID,
    coordinatorMemberId: UUID2,
    targetSessionId: UUID,
    assignment: { runId: UUID, memberId: UUID2, revision: 1, role: "implementer" as const },
    targetCwd: "/home/dev/projects/example",
    expiresAt: LATER,
    policyHash: UPPER_SHA256,
    promptId: 1,
    promptHash: UPPER_SHA256,
    evidenceHash: UPPER_SHA256,
    option: 1,
    actor: ACTOR,
    leaseId: "lease-1",
  };
  assert.equal(teamAnswerWorkerRequestSchema.safeParse(upperDigestAnswer).success, true);
});
