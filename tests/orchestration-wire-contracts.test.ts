import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  goalCycleUsageSchema,
  isConfiguredChecksProject,
  isEstablishChecksProject,
  isPassedTeamCheck,
  projectTeamProject,
  recordedTeamReportEnvelopeSchema,
  storedUsageRollupSchema,
  strictDeliveryReconciliationReportSchema,
  teamCheckSchema,
  teamProjectSchema,
  teamReportEnvelopeSchema,
  usageRollupSchema,
  usageTotalsSchema,
  type GoalCycleUsage,
  type PassedTeamCheck,
  type RecordedTeamReportEnvelope,
  type TeamCheck,
  type TeamProject,
  type TeamReportEnvelope,
  type TeamRun,
} from "../packages/host/src/team-types.js";
import { teamReportToolInputSchema } from "../packages/host/src/team-mcp.js";
import { terminalConnection, type TerminalControlAction } from "../packages/host/src/client-transport.js";
import type { TerminalInput } from "@infinite/remote/protocol";
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
  missionSubtaskSchema,
  recordedMissionFollowUpSchema,
  type MissionDecisionState,
} from "../packages/host/src/mission-types.js";
import { MissionService } from "../packages/host/src/missions.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { validateWorkspaceManifest } from "../packages/host/src/workspace-checkpoint.js";
import {
  executionStateSchema,
  httpControlRequestSchema,
  normalizeControlRequest,
  normalizeWorkerControlRequest,
  teamAnswerWorkerRequestSchema,
  workerControlRequestSchema,
  workerWorkspaceExportRequestSchema,
  type Config,
  type WorkerControlRequestState,
} from "../packages/host/src/types.js";
import { terminalInputSchema } from "../packages/host/src/terminal-stream.js";

const AT = "2026-11-25T12:00:00.000Z";
const LATER = "2026-11-25T12:05:00.000Z";
const OFFSET_AT = "2026-11-24T12:00:00+05:00";
const HASH = "a".repeat(40);
const BASE_HASH = "b".repeat(40);
const LOWER_SHA256 = "0123456789abcdef".repeat(4);
const UPPER_SHA256 = LOWER_SHA256.toUpperCase();
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const CMD = { command: "npm", args: ["test"] };
const ACTOR = { id: "device-1:client-1", label: "Laptop CLI" };

test("HTTP, WebSocket, and worker control boundaries normalize takeover: false and return control-lost for lease-less renew/release", () => {
  for (const action of ["renew", "release"] as const) {
    const httpBody = httpControlRequestSchema.parse({ action, leaseId: UUID, takeover: false });
    const httpNormalized = normalizeControlRequest(httpBody, ACTOR);
    assert.deepEqual(httpNormalized, { ok: true, request: { op: "control", action, actor: ACTOR, leaseId: UUID } });
    if (httpNormalized.ok) {
      assert.equal(Object.hasOwn(httpNormalized.request, "takeover"), false);
      assert.equal(workerControlRequestSchema.safeParse(httpNormalized.request).success, true);
    }

    const wsFrame = terminalInputSchema.parse({ op: "control", requestId: UUID2, action, leaseId: UUID, takeover: false });
    assert.equal(wsFrame.op, "control");
    if (wsFrame.op === "control") {
      const wsNormalized = normalizeControlRequest(wsFrame, ACTOR);
      assert.deepEqual(wsNormalized, httpNormalized);
    }

    const httpLeaseLess = httpControlRequestSchema.parse({ action });
    assert.deepEqual(normalizeControlRequest(httpLeaseLess, ACTOR), { ok: false, code: "control-lost" });
    const wsLeaseLess = terminalInputSchema.parse({ op: "control", requestId: UUID2, action });
    assert.equal(wsLeaseLess.op, "control");
    if (wsLeaseLess.op === "control") {
      assert.deepEqual(normalizeControlRequest(wsLeaseLess, ACTOR), { ok: false, code: "control-lost" });
    }

    assert.equal(httpControlRequestSchema.safeParse({ action, leaseId: UUID, takeover: true }).success, false);
    assert.equal(terminalInputSchema.safeParse({ op: "control", requestId: UUID2, action, leaseId: UUID, takeover: true }).success, false);

    const legacyWorkerInput = { op: "control", action, actor: ACTOR, leaseId: UUID, takeover: false } as unknown as WorkerControlRequestState;
    const workerNormalized = normalizeWorkerControlRequest(legacyWorkerInput);
    assert.deepEqual(workerNormalized, { op: "control", action, actor: ACTOR, leaseId: UUID });
    assert.equal(Object.hasOwn(workerNormalized, "takeover"), false);
    assert.equal(workerControlRequestSchema.safeParse(workerNormalized).success, true);

    const invalidWorkerTakeover = { op: "control", action, actor: ACTOR, leaseId: UUID, takeover: true } as unknown as WorkerControlRequestState;
    assert.equal(workerControlRequestSchema.safeParse(normalizeWorkerControlRequest(invalidWorkerTakeover)).success, false);

    const legacyWorkerWithExtra = { op: "control", action, actor: ACTOR, leaseId: UUID, takeover: false, unexpected: true } as unknown as WorkerControlRequestState;
    assert.equal(workerControlRequestSchema.safeParse(normalizeWorkerControlRequest(legacyWorkerWithExtra)).success, false);
  }

  const claimBody = httpControlRequestSchema.parse({ action: "claim", takeover: true });
  assert.deepEqual(normalizeControlRequest(claimBody, ACTOR), { ok: true, request: { op: "control", action: "claim", actor: ACTOR, takeover: true } });

  const validRemoteRenew: TerminalInput = { op: "control", requestId: UUID, action: "renew", leaseId: UUID2, takeover: false };
  const validRemoteClaim: TerminalInput = { op: "control", requestId: UUID, action: "claim", takeover: true };
  // @ts-expect-error TerminalInput renew cannot set takeover: true
  const invalidRemoteRenewTakeover: TerminalInput = { op: "control", requestId: UUID, action: "renew", leaseId: UUID2, takeover: true };
  // @ts-expect-error TerminalInput release cannot set takeover: true
  const invalidRemoteReleaseTakeover: TerminalInput = { op: "control", requestId: UUID, action: "release", leaseId: UUID2, takeover: true };
  type ControlMethod = ReturnType<typeof terminalConnection>["control"];
  const checkControlTyping = (control: ControlMethod, action: TerminalControlAction) => {
    void control("claim", true);
    void control("renew");
    void control("renew", false);
    void control("release");
    void control(action);
    void control(action, false);
    // @ts-expect-error client-transport control rejects takeover: true on renew
    void control("renew", true);
    // @ts-expect-error client-transport control rejects takeover: true on release
    void control("release", true);
    // @ts-expect-error client-transport control rejects takeover: true on union TerminalControlAction
    void control(action, true);
  };
  assert.ok(validRemoteRenew && validRemoteClaim && invalidRemoteRenewTakeover && invalidRemoteReleaseTakeover && checkControlTyping);
});

test("live teamReportEnvelopeSchema and MCP JSON schema enforce structural delivery reconciliation while recordedTeamReportEnvelopeSchema preserves journal replay", () => {
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

  const recordedLegacyEnvelope: RecordedTeamReportEnvelope = { ...envelopeBase, report: legacyOwnedBranch };
  // @ts-expect-error live TeamReportEnvelope owned-branch requires remoteHeadCommit
  const invalidLiveEnvelope: TeamReportEnvelope = { ...envelopeBase, report: legacyOwnedBranch };
  const prebuiltNoPubWithRemote = {
    kind: "delivery-reconciliation" as const,
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "no-publication" as const,
    remoteHeadCommit: HASH,
    summary: "Invalid remote head on no-publication.",
  };
  // @ts-expect-error prebuilt no-publication variable carrying remoteHeadCommit cannot assign to live envelope report
  const invalidNoPubLiveReport: TeamReportEnvelope["report"] = prebuiltNoPubWithRemote;
  const prebuiltApproveWithPaths = {
    kind: "permission-decision" as const,
    decisionId: UUID,
    verdict: "approve-once" as const,
    summary: "In scope.",
    requestedPaths: ["package.json"],
  };
  // @ts-expect-error prebuilt approve-once variable carrying requestedPaths cannot assign to live envelope report
  const invalidApproveLiveReport: TeamReportEnvelope["report"] = prebuiltApproveWithPaths;
  assert.ok(recordedLegacyEnvelope && invalidLiveEnvelope && invalidNoPubLiveReport && invalidApproveLiveReport);

  assert.equal(strictDeliveryReconciliationReportSchema.safeParse(legacyOwnedBranch).success, false);
  assert.equal(strictDeliveryReconciliationReportSchema.safeParse(strictOwnedBranch).success, true);

  type BranchSchema = { properties?: { kind?: { const?: string }; disposition?: { const?: string }; verdict?: { const?: string }; requestedPaths?: unknown }; required?: string[]; oneOf?: BranchSchema[]; anyOf?: BranchSchema[] };
  const flatten = (node: BranchSchema): BranchSchema[] => [...(node.oneOf ?? []), ...(node.anyOf ?? [])].flatMap(child => (child.oneOf || child.anyOf) ? flatten(child) : [child]);
  const reportSchema = (teamReportToolInputSchema as { properties?: { report?: BranchSchema } }).properties?.report ?? {};
  const flattened = flatten(reportSchema);
  const deliveryBranches = flattened.filter(branch => branch.properties?.kind?.const === "delivery-reconciliation");
  const byDisposition = new Map(deliveryBranches.map(branch => [branch.properties?.disposition?.const, branch.required ?? []]));
  assert.equal(byDisposition.size, 3);
  assert.equal(byDisposition.get("no-publication")?.includes("remoteHeadCommit"), false);
  assert.equal(byDisposition.get("no-publication")?.includes("pullRequestUrl"), false);
  assert.equal(byDisposition.get("owned-branch")?.includes("remoteHeadCommit"), true);
  assert.equal(byDisposition.get("owned-branch")?.includes("pullRequestUrl"), false);
  assert.equal(byDisposition.get("pull-request")?.includes("remoteHeadCommit"), true);
  assert.equal(byDisposition.get("pull-request")?.includes("pullRequestUrl"), true);

  const permissionBranches = flattened.filter(branch => branch.properties?.kind?.const === "permission-decision");
  const byVerdict = new Map(permissionBranches.map(branch => [branch.properties?.verdict?.const, branch]));
  assert.equal(byVerdict.size, 3);
  assert.equal(byVerdict.get("approve-once")?.properties?.requestedPaths, undefined);
  assert.equal(byVerdict.get("escalate")?.properties?.requestedPaths, undefined);
  assert.equal(byVerdict.get("request-evidence")?.required?.includes("requestedPaths"), true);
});

test("GoalCycle and cancelled MissionSubtask usage schemas accept historical stored rollups and pre-catalog totals-only snapshots", () => {
  const totals = {
    cost: 0.04,
    tokens: { input: 120, output: 60, reasoning: 0, cacheRead: 10, cacheWrite: 5 },
    messages: 2,
    pricing: { configured: 1, catalog: 0, provider: 0, unknown: 0 },
  };
  const preCatalogTotals = {
    cost: 0.04,
    tokens: { input: 120, output: 60, reasoning: 0, cacheRead: 10, cacheWrite: 5 },
    messages: 2,
    pricing: { configured: 1, provider: 0, unknown: 0 },
  };
  const preCatalogIncompleteTotals = {
    cost: 0.04,
    tokens: { input: 120, output: 60, reasoning: 0, cacheRead: 10, cacheWrite: 5 },
    messages: 2,
    pricing: { configured: 1, provider: 0, unknown: 0 },
    incomplete: true,
  };
  const currentRollup = {
    total: totals,
    byProfile: { lead: totals },
    byProvider: { claude: totals },
    unmeasuredMembers: 0,
    partialMembers: 0,
  };
  const legacyStoredRollup = {
    total: totals,
    byProfile: { lead: totals },
    byProvider: { claude: totals },
    unmeasuredMembers: 1,
  };
  const currentSnapshot: GoalCycleUsage = { ...totals, ...currentRollup };
  const historicalNoPartial: GoalCycleUsage = { ...totals, ...legacyStoredRollup };
  const legacyTotalsOnly: GoalCycleUsage = totals;
  const legacyPreCatalogTotalsOnly: GoalCycleUsage = preCatalogTotals;
  const legacyIncompleteTotalsOnly: GoalCycleUsage = preCatalogIncompleteTotals;

  assert.equal(usageTotalsSchema.safeParse(totals).success, true);
  assert.equal(usageTotalsSchema.safeParse(preCatalogTotals).success, false);
  assert.equal(usageTotalsSchema.safeParse({ ...totals, incomplete: true }).success, false);
  assert.equal(usageRollupSchema.safeParse(currentRollup).success, true);
  assert.equal(usageRollupSchema.safeParse(legacyStoredRollup).success, false);
  assert.equal(storedUsageRollupSchema.safeParse(legacyStoredRollup).success, true);

  const baseCycle = { teamId: UUID, cycle: 1, goalRevision: 1, status: "ready-for-review", startedAt: AT, finishedAt: LATER, memberCount: 2 };
  for (const usage of [currentSnapshot, historicalNoPartial, legacyTotalsOnly, legacyPreCatalogTotalsOnly, legacyIncompleteTotalsOnly]) {
    assert.equal(goalCycleUsageSchema.safeParse(usage).success, true);
    assert.equal(goalCycleSchema.safeParse({ ...baseCycle, usage }).success, true);
  }
  assert.equal(goalCycleUsageSchema.safeParse({ ...totals, total: totals }).success, false);

  const planningCycle = { teamId: UUID, cycle: 1, goalRevision: 1, status: "planning", startedAt: AT, baseCommit: "", memberCount: 0 };
  assert.equal(goalCycleSchema.safeParse(planningCycle).success, true);

  const cancelledWithLegacyUsage = {
    id: "api",
    repoProjectId: "api-repo",
    title: "API",
    objective: "Update route",
    size: "solo" as const,
    parallelism: 1,
    dependsOn: [],
    status: "cancelled" as const,
    teamId: UUID,
    teamStatus: "cancelled" as const,
    finalEvidence: { reason: "Cancelled before partialMembers existed", usage: legacyStoredRollup },
  };
  assert.equal(missionSubtaskSchema.safeParse(cancelledWithLegacyUsage).success, true);

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

test("CreateGoal, TeamProject, MissionDecisionState, and TeamRun enforce strict domain unions", () => {
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

  const invalidForwardedMissionDecision: MissionDecisionState = {
    state: "open",
    // @ts-expect-error forwarded mission decision requires subtaskId when childDecisionId is set
    decision: { id: UUID, question: "Proceed?", options: ["Yes", "No"], createdAt: AT, childDecisionId: UUID2 },
  };
  // @ts-expect-error TeamRun check cannot mark status passed with nonzero exitCode
  const invalidRunCheck: TeamRun["checks"][number] = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: 1, output: "fail", revision: 1 };
  // @ts-expect-error TeamRun permissionAgentDecisions allowed entry requires delivery receipt
  const invalidRunAgentDecision: NonNullable<TeamRun["permissionAgentDecisions"]>[number] = {
    decisionId: "pd-1", requestId: "req-1", memberId: UUID, sessionId: UUID2, role: "implementer", promptId: 1, result: "allowed", at: AT,
  };
  // @ts-expect-error TeamRun publication with commit requires publishedAt
  const invalidRunPublication: NonNullable<TeamRun["publication"]> = { repository: "example/app", branch: "infinite/feat", commit: HASH };
  assert.ok(invalidForwardedMissionDecision && invalidRunCheck && invalidRunAgentDecision && invalidRunPublication);
});

test("MissionService loads legacy settled follow-ups without synthesizing settledAt, trims via cancel transition, and persists cleanly across reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-mission-legacy-followup-"));
  const stateDir = join(dir, "state");
  mkdirSync(join(stateDir, "missions"), { recursive: true });
  const key = randomBytes(32);
  const missionId = UUID;
  const futureDueAt = "2099-01-01T00:00:00.000Z";
  const legacyCancelled = {
    id: "f-legacy-cancelled",
    dueAt: futureDueAt,
    reason: "Cancelled before future due date",
    check: "Inspect PR",
    createdAt: AT,
    state: "cancelled" as const,
  };
  const openFollowUp = {
    id: "f-open-current",
    dueAt: futureDueAt,
    reason: "Wait for CI",
    check: "Inspect CI",
    createdAt: AT,
    state: "open" as const,
  };
  assert.equal(recordedMissionFollowUpSchema.safeParse(legacyCancelled).success, true);
  const timestampedSettled = Array.from({ length: 10 }, (_, index) => ({
    id: `f-${index}`,
    dueAt: `2026-11-25T12:${String(index).padStart(2, "0")}:00.000Z`,
    reason: `Check ${index}`,
    check: "Inspect PR",
    createdAt: AT,
    state: "fired" as const,
    settledAt: `2026-11-25T12:${String(index).padStart(2, "0")}:30.000Z`,
  }));
  const missionProfile = { id: "lead", label: "Lead", provider: "claude" as const, model: "claude-opus-4-6", effort: "high" as const, tier: "strong" as const };
  const stored = {
    mission: {
      id: missionId,
      groupId: "core",
      groupName: "Core",
      repoProjectIds: ["api-repo"],
      title: "Legacy mission",
      objective: "Verify legacy follow-up load",
      mode: "work",
      revision: 1,
      status: "working",
      createdAt: AT,
      updatedAt: LATER,
      deadlineAt: futureDueAt,
      maxSubtasks: 4,
      maxMinutes: 60,
      lineup: { coordinator: missionProfile, integrator: missionProfile, reviewer: missionProfile, implementers: [missionProfile] },
      subtasks: [],
      decisions: [],
      followUps: [legacyCancelled, ...timestampedSettled, openFollowUp],
      steering: [],
      events: [],
    },
    fingerprint: "f".repeat(64),
    folder: "legacy-mission",
    repos: [],
    attempts: [],
    inbox: [],
    notes: [],
    notified: [],
    launches: {},
    ops: [],
    receipts: {},
    refusals: 0,
  };
  writeSealed(join(stateDir, "missions", `${missionId}.sealed`), key, `mission:${missionId}`, stored);
  const config = { stateDir } as unknown as Config;
  const service = new MissionService(config, key, {} as never, { useMissionReservations() {} } as never, {} as never);
  let reloadedService: MissionService | undefined;
  try {
    const loaded = service.peek(missionId);
    assert.ok(loaded);
    const legacyEntry = loaded.followUps?.find(item => item.id === "f-legacy-cancelled");
    assert.ok(legacyEntry);
    assert.equal(legacyEntry.state, "cancelled");
    const legacySettledAt: string | undefined = legacyEntry.settledAt;
    assert.equal(legacySettledAt, undefined);

    await service.cancel(missionId, { requestId: UUID2, revision: 1 });
    await service.close();

    reloadedService = new MissionService(config, key, {} as never, { useMissionReservations() {} } as never, {} as never);
    const persisted = reloadedService.peek(missionId);
    assert.ok(persisted);
    assert.equal(persisted.status, "cancelled");
    assert.equal(persisted.followUps?.length, 10);
    assert.deepEqual(
      persisted.followUps?.map(item => item.id),
      [...timestampedSettled.slice(1).map(item => item.id), "f-open-current"],
    );
    const newlyCancelled = persisted.followUps?.find(item => item.id === "f-open-current");
    assert.ok(newlyCancelled && newlyCancelled.state === "cancelled" && typeof newlyCancelled.settledAt === "string");
  } finally {
    await service.close();
    await reloadedService?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PassedTeamCheck, sync/blob hashes, and checkpoint timestamps match host store validators", () => {
  const passedZero: TeamCheck = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: 0, output: "ok", revision: 1, round: 0 };
  const passedNoCode: TeamCheck = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, output: "ok", revision: 1, round: 0 };
  const passedNonZero = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: 1, output: "fail", revision: 1, round: 0 } as unknown as TeamCheck;
  const passedNullCode = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: null, output: "signal", revision: 1, round: 0 } as unknown as TeamCheck;

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

  const manifestWithoutId = {
    version: 1 as const,
    capturedAt: OFFSET_AT,
    captureStartedAt: OFFSET_AT,
    cwd: { root: 0, path: "" },
    roots: ["/home/dev/projects/example"],
    entries: [{ root: 0, path: "", kind: "directory" as const, mode: 0o755 }],
  };
  const manifestId = createHash("sha256").update(JSON.stringify(manifestWithoutId)).digest("hex");
  const validatedManifest = validateWorkspaceManifest({ ...manifestWithoutId, id: manifestId });
  assert.equal(validatedManifest.capturedAt, OFFSET_AT);
  assert.equal(executionStateSchema.safeParse({
    location: "cloud",
    state: "online",
    cloudReady: true,
    checkpoint: { id: validatedManifest.id, capturedAt: OFFSET_AT },
  }).success, true);
  assert.equal(executionStateSchema.safeParse({
    location: "cloud",
    state: "online",
    cloudReady: true,
    checkpoint: { id: validatedManifest.id, capturedAt: "not-a-timestamp" },
  }).success, false);
});
