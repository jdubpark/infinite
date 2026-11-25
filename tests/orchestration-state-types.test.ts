import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  buildTeamPendingOperation,
  deliveryReconciliationReportSchema,
  isAnsweredTeamDecision,
  isEstablishChecksProject,
  isFailedTeamCheck,
  isOpenTeamDecision,
  isPassedTeamCheck,
  isRunningTeamCheck,
  permissionDecisionReportSchema,
  projectTeamDecision,
  recordedTeamReportSchema,
  teamCheckSchema,
  teamDecisionSchema,
  teamLineupSchema,
  teamMemberSavedWorkSchema,
  teamModelProfileSchema,
  teamPendingOperationSchema,
  teamPermissionAgentDecisionSchema,
  teamProjectSchema,
  teamPublicationSchema,
  teamReportEnvelopeSchema,
  teamReportSchema,
  type DeliveryReconciliationReport,
  type OpenTeamDecision,
  type AnsweredTeamDecision,
  type PermissionDecisionReport,
  type TeamCheckState,
  type TeamMemberSavedWork,
  type TeamPendingOperation,
  type TeamPermissionAgentDecisionState,
  type TeamProjectState,
  type TeamPublicationState,
} from "../packages/host/src/team-types.js";
import {
  boardItemSchema,
  isAnsweredMissionDecision,
  isOpenMissionDecision,
  missionDecisionSchema,
  missionFollowUpSchema,
  missionSubtaskSchema,
  projectMissionDecision,
  projectMissionSubtask,
  type AnsweredMissionDecision,
  type BoardItem,
  type MissionFollowUp,
  type MissionSubtaskState,
  type OpenMissionDecision,
} from "../packages/host/src/mission-types.js";
import {
  createGoalSchema,
  goalCycleSchema,
  goalOutcomeSchema,
  isActiveGoalCycle,
  isSettledGoalCycle,
  parseCreateGoal,
  projectCreateGoal,
  projectGoalCycle,
  type GoalCycleState,
  type GoalOutcomeInput,
} from "../packages/host/src/goal-types.js";
import {
  executionStateSchema,
  permissionChannelViewSchema,
  projectPermissionChannelView,
  sessionHeadlessSchema,
  sessionRuntimeSchema,
  teamAnswerWorkerRequestSchema,
  workerControlRequestSchema,
  workerWorkspaceExportRequestSchema,
  type ExecutionState,
  type PermissionChannelViewState,
  type SessionHeadless,
  type SessionRuntime,
  type TeamAnswerWorkerRequest,
  type WorkerControlRequestState,
  type WorkerRequest,
  type WorkerWorkspaceExportRequestState,
} from "../packages/host/src/types.js";

const AT = "2026-11-25T12:00:00.000Z";
const LATER = "2026-11-25T12:05:00.000Z";
const HASH = "a".repeat(40);
const BASE_HASH = "b".repeat(40);
const SHA256 = "c".repeat(64);
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const CONNECTOR = { kind: "connector" as const, id: "slack-bridge", name: "Slack bridge" };
const CMD = { command: "npm", args: ["test"] };

test("TeamMemberSavedWork enforces state-coupled fields at runtime and compile time", () => {
  const published: TeamMemberSavedWork = {
    revision: 1,
    state: "published",
    repository: "example/app",
    branch: "infinite/run-wip-m1",
    commit: HASH,
    at: AT,
  };
  const nothingToSave: TeamMemberSavedWork = {
    revision: 1,
    state: "nothing-to-save",
    at: AT,
  };
  const retrying: TeamMemberSavedWork = {
    revision: 1,
    state: "retrying",
    repository: "example/app",
    branch: "infinite/run-wip-m1",
    at: AT,
    failure: { category: "network", attempts: 2, at: AT, retryAt: LATER },
  };
  const gaveUp: TeamMemberSavedWork = {
    revision: 1,
    state: "gave-up",
    repository: "example/app",
    branch: "infinite/run-wip-m1",
    commit: HASH,
    at: AT,
    failure: { category: "auth", attempts: 5, at: AT, retryAt: LATER },
  };

  assert.equal(teamMemberSavedWorkSchema.safeParse(published).success, true);
  assert.equal(teamMemberSavedWorkSchema.safeParse(nothingToSave).success, true);
  assert.equal(teamMemberSavedWorkSchema.safeParse(retrying).success, true);
  assert.equal(teamMemberSavedWorkSchema.safeParse(gaveUp).success, true);

  assert.equal(teamMemberSavedWorkSchema.safeParse({ ...published, failure: retrying.failure }).success, false);
  assert.equal(teamMemberSavedWorkSchema.safeParse({ revision: 1, state: "published", repository: "example/app", branch: "main", at: AT }).success, false);
  assert.equal(teamMemberSavedWorkSchema.safeParse({ revision: 1, state: "nothing-to-save", repository: "example/app", at: AT }).success, false);
  assert.equal(teamMemberSavedWorkSchema.safeParse({ revision: 1, state: "retrying", repository: "example/app", branch: "main", at: AT }).success, false);

  if (published.state === "published") {
    const commit: string = published.commit;
    assert.equal(commit, HASH);
  }

  // @ts-expect-error published savedWork cannot carry failure
  const invalidPublishedWithFailure: TeamMemberSavedWork = {
    revision: 1,
    state: "published",
    repository: "example/app",
    branch: "main",
    commit: HASH,
    at: AT,
    failure: retrying.failure,
  };
  // @ts-expect-error nothing-to-save savedWork cannot carry repository
  const invalidNothingWithRepo: TeamMemberSavedWork = {
    revision: 1,
    state: "nothing-to-save",
    at: AT,
    repository: "example/app",
  };
  // @ts-expect-error retrying savedWork requires failure
  const invalidRetryingWithoutFailure: TeamMemberSavedWork = {
    revision: 1,
    state: "retrying",
    repository: "example/app",
    branch: "main",
    at: AT,
  };
  assert.ok(invalidPublishedWithFailure && invalidNothingWithRepo && invalidRetryingWithoutFailure);
});

test("TeamPendingOperation couples failure, source, and process census fields", () => {
  const active = buildTeamPendingOperation({ id: UUID, kind: "check", revision: 2 });
  const failedWithSource = buildTeamPendingOperation({
    id: UUID,
    kind: "result",
    revision: 2,
    failure: { code: "workspace-operation-failed" },
    source: { memberId: UUID2, role: "delivery" },
    census: { state: "ended", at: AT },
  });

  assert.equal(teamPendingOperationSchema.safeParse(active).success, true);
  assert.equal(teamPendingOperationSchema.safeParse(failedWithSource).success, true);
  assert.equal(teamPendingOperationSchema.safeParse({ id: UUID, kind: "check", revision: 1, failed: false, failureCode: "boom" }).success, false);
  assert.equal(teamPendingOperationSchema.safeParse({ id: UUID, kind: "result", revision: 1, failed: false, sourceMemberId: UUID2 }).success, false);
  assert.equal(teamPendingOperationSchema.safeParse({ id: UUID, kind: "result", revision: 1, failed: false, processes: "running" }).success, false);

  if (failedWithSource.failed) {
    assert.equal(failedWithSource.failureCode, "workspace-operation-failed");
  }

  // @ts-expect-error non-failed operation cannot include failureCode
  const invalidUnfailedCode: TeamPendingOperation = {
    id: UUID,
    kind: "check",
    revision: 1,
    failed: false,
    failureCode: "workspace-operation-failed",
  };
  // @ts-expect-error sourceMemberId requires sourceRole
  const invalidHalfSource: TeamPendingOperation = {
    id: UUID,
    kind: "result",
    revision: 1,
    failed: false,
    sourceMemberId: UUID2,
  };
  // @ts-expect-error processes requires processesCheckedAt
  const invalidHalfCensus: TeamPendingOperation = {
    id: UUID,
    kind: "result",
    revision: 1,
    failed: false,
    processes: "ended",
  };
  assert.ok(invalidUnfailedCode && invalidHalfSource && invalidHalfCensus);
});

test("PermissionDecisionReport and DeliveryReconciliationReport enforce variant coupling", () => {
  const approve: PermissionDecisionReport = { kind: "permission-decision", decisionId: UUID, verdict: "approve-once", summary: "In scope." };
  const requestEvidence: PermissionDecisionReport = {
    kind: "permission-decision",
    decisionId: UUID,
    verdict: "request-evidence",
    summary: "Inspect build script.",
    requestedPaths: ["scripts/build.mjs"],
  };
  assert.equal(permissionDecisionReportSchema.safeParse(approve).success, true);
  assert.equal(permissionDecisionReportSchema.safeParse(requestEvidence).success, true);
  assert.equal(permissionDecisionReportSchema.safeParse({ ...approve, requestedPaths: ["a.ts"] }).success, false);
  assert.equal(permissionDecisionReportSchema.safeParse({ kind: "permission-decision", decisionId: UUID, verdict: "request-evidence", summary: "Need files" }).success, false);
  assert.equal(teamReportSchema.safeParse({ ...approve, requestedPaths: ["a.ts"] }).success, false);

  const noPub: DeliveryReconciliationReport = {
    kind: "delivery-reconciliation",
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "no-publication",
    summary: "Remote branch does not exist.",
  };
  const ownedBranch: DeliveryReconciliationReport = {
    kind: "delivery-reconciliation",
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "owned-branch",
    remoteHeadCommit: HASH,
    summary: "Branch exists at reviewed head.",
  };
  const pullRequest: DeliveryReconciliationReport = {
    kind: "delivery-reconciliation",
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "pull-request",
    remoteHeadCommit: HASH,
    pullRequestUrl: "https://github.com/example/app/pull/42",
    summary: "Open PR matches reviewed head.",
  };

  for (const valid of [noPub, ownedBranch, pullRequest]) {
    assert.equal(deliveryReconciliationReportSchema.safeParse(valid).success, true);
    assert.equal(teamReportSchema.safeParse(valid).success, true);
  }
  for (const invalid of [
    { ...noPub, remoteHeadCommit: HASH },
    { ...noPub, pullRequestUrl: "https://github.com/example/app/pull/42" },
    { kind: "delivery-reconciliation", headCommit: HASH, repository: "example/app", branch: "infinite/feat", baseHeadCommit: BASE_HASH, disposition: "owned-branch", summary: "Missing head" },
    { ...ownedBranch, pullRequestUrl: "https://github.com/example/app/pull/42" },
    { kind: "delivery-reconciliation", headCommit: HASH, repository: "example/app", branch: "infinite/feat", baseHeadCommit: BASE_HASH, disposition: "pull-request", remoteHeadCommit: HASH, summary: "Missing PR URL" },
    { kind: "delivery-reconciliation", headCommit: HASH, repository: "example/app", branch: "infinite/feat", baseHeadCommit: BASE_HASH, disposition: "pull-request", pullRequestUrl: "https://github.com/example/app/pull/42", summary: "Missing remote head" },
  ]) {
    assert.equal(deliveryReconciliationReportSchema.safeParse(invalid).success, false);
    assert.equal(teamReportSchema.safeParse(invalid).success, false);
  }
  const legacyOwnedBranch = { kind: "delivery-reconciliation", headCommit: HASH, repository: "example/app", branch: "infinite/feat", baseHeadCommit: BASE_HASH, disposition: "owned-branch", summary: "Pre-upgrade worker report without remote head." };
  const legacyPullRequest = { kind: "delivery-reconciliation", headCommit: HASH, repository: "example/app", branch: "infinite/feat", baseHeadCommit: BASE_HASH, disposition: "pull-request", remoteHeadCommit: HASH, summary: "Pre-upgrade worker report without PR URL." };
  assert.equal(teamReportSchema.safeParse(legacyOwnedBranch).success, false);
  assert.equal(recordedTeamReportSchema.safeParse(legacyOwnedBranch).success, true);
  assert.equal(recordedTeamReportSchema.safeParse(legacyPullRequest).success, true);
  assert.equal(teamReportEnvelopeSchema.safeParse({ requestId: UUID, runId: UUID, memberId: UUID2, revision: 1, report: legacyOwnedBranch }).success, true);

  // @ts-expect-error approve-once cannot specify requestedPaths
  const invalidApprovePaths: PermissionDecisionReport = {
    kind: "permission-decision",
    decisionId: UUID,
    verdict: "approve-once",
    summary: "In scope.",
    requestedPaths: ["package.json"],
  };
  // @ts-expect-error no-publication cannot specify remoteHeadCommit
  const invalidNoPubRemote: DeliveryReconciliationReport = {
    kind: "delivery-reconciliation",
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "no-publication",
    summary: "None.",
    remoteHeadCommit: HASH,
  };
  // @ts-expect-error pull-request requires pullRequestUrl
  const invalidPrMissingUrl: DeliveryReconciliationReport = {
    kind: "delivery-reconciliation",
    headCommit: HASH,
    repository: "example/app",
    branch: "infinite/feat",
    baseHeadCommit: BASE_HASH,
    disposition: "pull-request",
    remoteHeadCommit: HASH,
    summary: "Missing URL.",
  };
  assert.ok(invalidApprovePaths && invalidNoPubRemote && invalidPrMissingUrl);
});

test("TeamDecision, TeamCheck, TeamPermissionAgentDecision, TeamPublication, and TeamProject reject impossible states", () => {
  const openTeam: OpenTeamDecision = {
    id: UUID,
    memberId: UUID2,
    revision: 1,
    question: "Keep existing format?",
    options: ["Yes", "No"],
    createdAt: AT,
  };
  const ownerAnswered: AnsweredTeamDecision = {
    ...openTeam,
    answer: "Yes",
    answeredBy: "owner",
    answeredAt: LATER,
  };
  const connectorAnswered: AnsweredTeamDecision = {
    ...openTeam,
    answer: "Yes",
    answeredBy: "connector",
    source: CONNECTOR,
    answeredAt: LATER,
  };

  assert.equal(teamDecisionSchema.safeParse(openTeam).success, true);
  assert.equal(teamDecisionSchema.safeParse(ownerAnswered).success, true);
  assert.equal(teamDecisionSchema.safeParse(connectorAnswered).success, true);
  assert.equal(teamDecisionSchema.safeParse({ ...openTeam, answeredAt: LATER }).success, false);
  assert.equal(teamDecisionSchema.safeParse({ ...openTeam, answeredBy: "owner" }).success, false);
  assert.equal(teamDecisionSchema.safeParse({ ...ownerAnswered, source: CONNECTOR }).success, false);

  assert.equal(projectTeamDecision(openTeam).state, "open");
  const projectedAnswered = projectTeamDecision(connectorAnswered);
  assert.equal(projectedAnswered.state, "answered");
  if (projectedAnswered.state === "answered") {
    assert.equal(projectedAnswered.decision.answer, "Yes");
  }
  assert.equal(isOpenTeamDecision({ ...openTeam, answeredBy: "owner" }), false);
  assert.equal(isOpenTeamDecision({ ...openTeam, answeredAt: LATER }), false);
  assert.equal(isOpenTeamDecision({ ...openTeam, source: CONNECTOR }), false);
  assert.equal(isAnsweredTeamDecision({ ...ownerAnswered, source: CONNECTOR }), false);
  assert.equal(isAnsweredTeamDecision({ ...openTeam, answer: "" }), false);
  assert.throws(() => projectTeamDecision({ ...ownerAnswered, source: CONNECTOR }));
  assert.throws(() => projectTeamDecision({ ...openTeam, answeredBy: "owner" }));

  const invalidOpenAnsweredAt: OpenTeamDecision = {
    ...openTeam,
    // @ts-expect-error open team decision cannot carry answeredAt
    answeredAt: LATER,
  };
  // @ts-expect-error owner-answered decision cannot carry connector source
  const invalidOwnerSource: AnsweredTeamDecision = {
    ...openTeam,
    answer: "Yes",
    answeredBy: "owner",
    source: CONNECTOR,
  };
  assert.ok(invalidOpenAnsweredAt && invalidOwnerSource);

  const runningCheck: TeamCheckState = { command: CMD, status: "running", startedAt: AT, output: "", revision: 1, round: 0 };
  const passedCheck: TeamCheckState = { command: CMD, status: "passed", startedAt: AT, finishedAt: LATER, exitCode: 0, output: "ok", revision: 1, round: 0 };
  const failedCheck: TeamCheckState = {
    command: CMD,
    status: "failed",
    startedAt: AT,
    finishedAt: LATER,
    exitCode: 1,
    output: "fail",
    revision: 1,
    round: 1,
    scan: { bytes: 4, failureCount: 1, failures: [{ line: "not ok 1", detail: "boom" }] },
  };
  assert.equal(teamCheckSchema.safeParse(runningCheck).success, true);
  assert.equal(teamCheckSchema.safeParse(passedCheck).success, true);
  assert.equal(teamCheckSchema.safeParse(failedCheck).success, true);
  assert.equal(teamCheckSchema.safeParse({ ...runningCheck, round: -1 }).success, false);
  assert.equal(teamCheckSchema.safeParse({ ...runningCheck, finishedAt: LATER }).success, false);
  assert.equal(teamCheckSchema.safeParse({ ...passedCheck, scan: failedCheck.scan }).success, false);
  assert.equal(teamCheckSchema.safeParse({ command: CMD, status: "passed", startedAt: AT, output: "ok", revision: 1 }).success, false);
  assert.equal(isRunningTeamCheck(runningCheck), true);
  assert.equal(isRunningTeamCheck({ ...runningCheck, finishedAt: LATER }), false);
  assert.equal(isPassedTeamCheck(passedCheck), true);
  assert.equal(isPassedTeamCheck({ ...passedCheck, scan: failedCheck.scan }), false);
  assert.equal(isFailedTeamCheck(failedCheck), true);
  assert.equal(isFailedTeamCheck({ command: CMD, status: "failed", startedAt: AT, output: "fail", revision: 1 }), false);

  // @ts-expect-error running check cannot carry finishedAt
  const invalidRunningFinished: TeamCheckState = {
    command: CMD,
    status: "running",
    startedAt: AT,
    output: "",
    revision: 1,
    finishedAt: LATER,
  };
  // @ts-expect-error passed check cannot carry scan
  const invalidPassedScan: TeamCheckState = {
    command: CMD,
    status: "passed",
    startedAt: AT,
    finishedAt: LATER,
    output: "ok",
    revision: 1,
    scan: failedCheck.scan,
  };
  assert.ok(invalidRunningFinished && invalidPassedScan);

  const allowedAgent: TeamPermissionAgentDecisionState = {
    decisionId: "pd-1",
    requestId: "req-1",
    memberId: UUID,
    sessionId: UUID2,
    role: "implementer",
    promptId: 1,
    result: "allowed",
    delivery: "receipt",
    at: AT,
  };
  const ownerAgent: TeamPermissionAgentDecisionState = {
    decisionId: "pd-2",
    requestId: "req-2",
    memberId: UUID,
    sessionId: UUID2,
    role: "implementer",
    promptId: 2,
    result: "owner",
    interruptClass: "credentials",
    at: AT,
  };
  assert.equal(teamPermissionAgentDecisionSchema.safeParse(allowedAgent).success, true);
  assert.equal(teamPermissionAgentDecisionSchema.safeParse(ownerAgent).success, true);
  assert.equal(teamPermissionAgentDecisionSchema.safeParse({ ...allowedAgent, code: "unsafe" }).success, false);
  assert.equal(teamPermissionAgentDecisionSchema.safeParse({ ...ownerAgent, delivery: "receipt" }).success, false);
  assert.equal(teamPermissionAgentDecisionSchema.safeParse({ ...allowedAgent, result: "stale", delivery: "receipt" }).success, false);

  // @ts-expect-error allowed permission agent decision cannot carry reject code
  const invalidAllowedCode: TeamPermissionAgentDecisionState = {
    ...allowedAgent,
    code: "unsafe",
  };
  assert.ok(invalidAllowedCode);

  const publishedPub: TeamPublicationState = { repository: "example/app", branch: "infinite/feat", commit: HASH, publishedAt: AT };
  const failedPub: TeamPublicationState = {
    repository: "example/app",
    branch: "infinite/feat",
    failure: { commit: HASH, category: "network", attempts: 1, at: AT, retryAt: LATER },
  };
  assert.equal(teamPublicationSchema.safeParse(publishedPub).success, true);
  assert.equal(teamPublicationSchema.safeParse(failedPub).success, true);
  assert.equal(teamPublicationSchema.safeParse({ repository: "example/app", branch: "infinite/feat" }).success, false);
  assert.equal(teamPublicationSchema.safeParse({ repository: "example/app", branch: "infinite/feat", commit: HASH }).success, false);

  const parsedEstablish = teamProjectSchema.parse({ checks: [], establishChecks: true });
  assert.equal(isEstablishChecksProject(parsedEstablish), true);
  assert.equal(teamProjectSchema.safeParse({ checks: [CMD], establishChecks: true }).success, false);
  assert.equal(teamProjectSchema.safeParse({ checks: [], establishChecks: true, mainCheck: {} }).success, false);
  // @ts-expect-error establishChecks project cannot configure mainCheck
  const invalidEstablishMainCheck: TeamProjectState = {
    checks: [],
    establishChecks: true,
    mainCheck: { minutes: 10 },
  };
  assert.ok(invalidEstablishMainCheck);

  const claudeProfile = teamModelProfileSchema.parse({ id: "lead", label: "Lead", provider: "claude", model: "claude-opus-4-6", effort: "high", tier: "strong" });
  const codexProfile = teamModelProfileSchema.parse({ id: "impl", label: "Impl", provider: "codex", model: "gpt-5.4", effort: "medium", tier: "light" });
  assert.deepEqual(Object.keys(claudeProfile), ["id", "label", "provider", "model", "effort", "tier"]);
  const lineup = teamLineupSchema.parse({
    coordinator: claudeProfile,
    integrator: claudeProfile,
    reviewer: claudeProfile,
    implementers: [codexProfile],
    judge: { id: "judge", label: "Judge", provider: "codex", model: "gpt-5.4-pro", effort: "high", tier: "strong" },
  });
  assert.equal(Object.keys(lineup).at(-1), "judge");
});

test("MissionFollowUp, BoardItem, MissionDecision, and MissionSubtask enforce invariants", () => {
  const openFollowUp: MissionFollowUp = {
    id: UUID,
    dueAt: LATER,
    reason: "CI should finish",
    check: "Inspect PR checks",
    createdAt: AT,
    state: "open",
  };
  const firedFollowUp: MissionFollowUp = {
    id: UUID,
    dueAt: LATER,
    reason: "CI should finish",
    check: "Inspect PR checks",
    createdAt: AT,
    state: "fired",
    settledAt: LATER,
  };
  assert.equal(missionFollowUpSchema.safeParse(openFollowUp).success, true);
  assert.equal(missionFollowUpSchema.safeParse(firedFollowUp).success, true);
  assert.equal(missionFollowUpSchema.safeParse({ ...openFollowUp, settledAt: LATER }).success, false);
  assert.equal(missionFollowUpSchema.safeParse({ id: UUID, dueAt: LATER, reason: "x", check: "y", createdAt: AT, state: "fired" }).success, false);

  // @ts-expect-error open follow-up cannot have settledAt
  const invalidOpenSettled: MissionFollowUp = {
    ...openFollowUp,
    settledAt: LATER,
  };
  // @ts-expect-error cancelled follow-up requires settledAt
  const invalidCancelledUnsettled: MissionFollowUp = {
    id: UUID,
    dueAt: LATER,
    reason: "x",
    check: "y",
    createdAt: AT,
    state: "cancelled",
  };
  assert.ok(invalidOpenSettled && invalidCancelledUnsettled);

  const missionRow: BoardItem = {
    kind: "mission",
    id: UUID,
    title: "Ship API",
    groupId: "core",
    projectName: "Core",
    column: "working",
    status: "working",
    detail: "Running subtask",
    createdAt: AT,
    updatedAt: LATER,
    subtasks: { total: 2, running: 1, done: 1 },
  };
  const teamRow: BoardItem = {
    kind: "team",
    id: UUID2,
    title: "Fix tests",
    projectName: "Core",
    column: "review",
    status: "ready-for-review",
    detail: "Ready",
    createdAt: AT,
    updatedAt: LATER,
  };
  assert.equal(boardItemSchema.safeParse(missionRow).success, true);
  assert.equal(boardItemSchema.safeParse(teamRow).success, true);
  assert.equal(boardItemSchema.safeParse({ ...teamRow, stopReason: "deadline" }).success, false);
  assert.equal(boardItemSchema.safeParse({ ...teamRow, subtasks: { total: 1, running: 0, done: 1 } }).success, false);

  // @ts-expect-error goal board items cannot carry subtasks
  const invalidGoalSubtasks: BoardItem = {
    kind: "goal",
    id: UUID,
    title: "Goal",
    projectName: "Core",
    column: "working",
    status: "running",
    detail: "Working",
    createdAt: AT,
    updatedAt: LATER,
    subtasks: { total: 1, running: 1, done: 0 },
  };
  assert.ok(invalidGoalSubtasks);

  const openMissionDecision: OpenMissionDecision = {
    id: UUID,
    question: "Deploy API first?",
    options: ["Yes", "No"],
    createdAt: AT,
    subtaskId: "api",
    childDecisionId: UUID2,
  };
  const answeredMissionDecision: AnsweredMissionDecision = {
    ...openMissionDecision,
    answer: "Yes",
    answeredAt: LATER,
    answeredBy: "connector",
    source: CONNECTOR,
  };
  assert.equal(missionDecisionSchema.safeParse(openMissionDecision).success, true);
  assert.equal(missionDecisionSchema.safeParse(answeredMissionDecision).success, true);
  assert.equal(missionDecisionSchema.safeParse({ id: UUID, question: "Q", options: [], createdAt: AT, childDecisionId: UUID2 }).success, false);
  assert.equal(missionDecisionSchema.safeParse({ ...openMissionDecision, answeredBy: "owner" }).success, false);
  assert.equal(missionDecisionSchema.safeParse({ ...openMissionDecision, answer: "Yes", answeredBy: "owner", source: CONNECTOR }).success, false);
  assert.equal(projectMissionDecision(openMissionDecision).state, "open");
  assert.equal(projectMissionDecision(answeredMissionDecision).state, "answered");
  assert.equal(isOpenMissionDecision({ id: UUID, question: "Q", options: [], createdAt: AT, childDecisionId: UUID2 }), false);
  assert.equal(isOpenMissionDecision({ ...openMissionDecision, answeredAt: LATER }), false);
  assert.equal(isAnsweredMissionDecision({ ...openMissionDecision, answer: "Yes", answeredBy: "owner", source: CONNECTOR }), false);
  assert.throws(() => projectMissionDecision({ id: UUID, question: "Q", options: [], createdAt: AT, childDecisionId: UUID2 }));
  assert.throws(() => projectMissionDecision({ ...openMissionDecision, answer: "Yes", answeredBy: "owner", source: CONNECTOR }));

  const queuedSubtask: MissionSubtaskState = {
    id: "api",
    repoProjectId: "api-repo",
    title: "API",
    objective: "Add route",
    size: "solo",
    parallelism: 1,
    dependsOn: [],
    status: "queued",
  };
  const runningSubtask: MissionSubtaskState = {
    ...queuedSubtask,
    status: "running",
    teamId: UUID,
    teamStatus: "implementing",
  };
  const launchBlockedSubtask: MissionSubtaskState = {
    ...queuedSubtask,
    status: "blocked",
  };
  const teamBlockedSubtask: MissionSubtaskState = {
    ...queuedSubtask,
    status: "blocked",
    teamId: UUID,
    teamStatus: "blocked",
  };
  const usageTotals = {
    cost: 0.02,
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 20, cacheWrite: 10 },
    messages: 3,
    pricing: { configured: 1, catalog: 0, provider: 0, unknown: 0 },
  };
  const usageRollup = {
    total: usageTotals,
    byProfile: { impl: usageTotals },
    byProvider: { codex: usageTotals },
    unmeasuredMembers: 0,
    partialMembers: 0,
  };
  const cancelledSubtask: MissionSubtaskState = {
    ...queuedSubtask,
    status: "cancelled",
    teamId: UUID,
    teamStatus: "cancelled",
    finalEvidence: {
      headCommit: HASH,
      reason: "Cancelled after mission stop",
      usage: usageRollup,
    },
  };
  assert.equal(missionSubtaskSchema.safeParse(queuedSubtask).success, true);
  assert.equal(missionSubtaskSchema.safeParse(runningSubtask).success, true);
  assert.equal(missionSubtaskSchema.safeParse(launchBlockedSubtask).success, true);
  assert.equal(missionSubtaskSchema.safeParse(teamBlockedSubtask).success, true);
  assert.equal(missionSubtaskSchema.safeParse(cancelledSubtask).success, true);
  assert.equal(missionSubtaskSchema.safeParse({ ...queuedSubtask, teamId: UUID }).success, false);
  assert.equal(missionSubtaskSchema.safeParse({ ...queuedSubtask, status: "running" }).success, false);
  assert.equal(missionSubtaskSchema.safeParse({ ...queuedSubtask, status: "blocked", teamStatus: "blocked" }).success, false);
  assert.equal(projectMissionSubtask(queuedSubtask).status, "queued");
  assert.equal(projectMissionSubtask(runningSubtask).status, "running");
  assert.equal(projectMissionSubtask(launchBlockedSubtask).teamId, undefined);
  assert.equal(projectMissionSubtask(teamBlockedSubtask).teamId, UUID);
  assert.equal(projectMissionSubtask(cancelledSubtask).status, "cancelled");
  assert.throws(() => projectMissionSubtask({ ...queuedSubtask, status: "running" }));
  assert.throws(() => projectMissionSubtask({ ...queuedSubtask, status: "blocked", teamStatus: "blocked" }));
  // @ts-expect-error blocked subtask without teamId cannot carry teamStatus
  const invalidBlockedSubtaskStatus: MissionSubtaskState = { ...queuedSubtask, status: "blocked", teamStatus: "blocked" };
  assert.ok(invalidBlockedSubtaskStatus);
});

test("GoalOutcomeInput, CreateGoal, and GoalCycle enforce outcome, standing, and settlement states", () => {
  const plainOutcome: GoalOutcomeInput = {
    requestId: UUID,
    revision: 1,
    result: "achieved",
    summary: "Verified in production-like check",
    evidence: "All acceptance checks passed",
  };
  const continueOutcome: GoalOutcomeInput = {
    requestId: UUID,
    revision: 1,
    result: "not-achieved",
    summary: "Add edge-case coverage",
    evidence: "Missing retry case",
    verdictId: UUID2,
    continue: true,
  };
  assert.equal(goalOutcomeSchema.safeParse(plainOutcome).success, true);
  assert.equal(goalOutcomeSchema.safeParse(continueOutcome).success, true);
  assert.equal(goalOutcomeSchema.safeParse({ ...plainOutcome, verdictId: UUID2, continue: true }).success, false);
  assert.equal(goalOutcomeSchema.safeParse({ requestId: UUID, revision: 1, result: "not-achieved", summary: "s", evidence: "e", continue: true }).success, false);
  const parsedPlain = goalOutcomeSchema.parse({ summary: plainOutcome.summary, evidence: plainOutcome.evidence, revision: plainOutcome.revision, requestId: plainOutcome.requestId, result: plainOutcome.result });
  const parsedContinue = goalOutcomeSchema.parse({ continue: true, evidence: continueOutcome.evidence, summary: continueOutcome.summary, verdictId: continueOutcome.verdictId, result: continueOutcome.result, revision: continueOutcome.revision, requestId: continueOutcome.requestId });
  assert.deepEqual(Object.keys(parsedPlain), ["requestId", "revision", "result", "summary", "evidence"]);
  assert.deepEqual(Object.keys(parsedContinue), ["requestId", "revision", "result", "summary", "evidence", "verdictId", "continue"]);
  const digest = (body: GoalOutcomeInput) => createHash("sha256").update(JSON.stringify({ action: "outcome", ...body })).digest("hex");
  assert.equal(digest(parsedPlain), digest(plainOutcome));
  assert.equal(digest(parsedContinue), digest(continueOutcome));

  if (continueOutcome.continue === true) {
    const verdict: string = continueOutcome.verdictId;
    const result: "not-achieved" = continueOutcome.result;
    assert.equal(verdict, UUID2);
    assert.equal(result, "not-achieved");
  }

  const invalidContinueAchieved: GoalOutcomeInput = {
    requestId: UUID,
    revision: 1,
    result: "achieved",
    summary: "Done",
    evidence: "Proof",
    verdictId: UUID2,
    // @ts-expect-error continue outcome requires result not-achieved
    continue: true,
  };
  // @ts-expect-error continue outcome requires verdictId
  const invalidContinueNoVerdict: GoalOutcomeInput = {
    requestId: UUID,
    revision: 1,
    result: "not-achieved",
    summary: "Retry",
    evidence: "Gap",
    continue: true,
  };
  assert.ok(invalidContinueAchieved && invalidContinueNoVerdict);

  const finite = parseCreateGoal({
    requestId: UUID,
    projectId: "core",
    title: "Improve parser",
    objective: "Harden wire parser",
    successCriteria: "Reject invalid payloads",
  });
  assert.equal(finite.maxRuns, 3);
  assert.equal(projectCreateGoal(finite).kind, "finite");
  const standing = parseCreateGoal({
    requestId: UUID2,
    projectId: "core",
    title: "Watch health",
    objective: "Keep checks green",
    successCriteria: "Checks stay green",
    standing: { shape: "objective", cadenceMinutes: 60 },
  });
  assert.equal(projectCreateGoal(standing).kind, "standing");
  assert.equal(createGoalSchema.safeParse({ ...standing, maxRuns: 2 }).success, false);

  const cycleProfile = { id: "lead", label: "Lead", provider: "claude" as const, model: "claude-opus-4-6", effort: "high" as const, tier: "strong" as const };
  const cycleUsageTotals = {
    cost: 0.05,
    tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 50, cacheWrite: 25 },
    messages: 4,
    pricing: { configured: 1, catalog: 0, provider: 0, unknown: 0 },
  };
  const activeCycle = {
    teamId: UUID,
    cycle: 1,
    goalRevision: 1,
    status: "implementing",
    startedAt: AT,
    memberCount: 2,
    lineup: { coordinator: cycleProfile, integrator: cycleProfile, reviewer: cycleProfile, implementers: [cycleProfile] },
    brief: {
      title: "Fix retry flake",
      problem: "Retry check flakes on timer skew",
      evidence: [{ source: "tests/retry.test.ts", observation: "Timeout at 50ms" }],
      dataShape: "RetryState",
      acceptance: ["Retry test passes deterministically"],
      expectedOutcome: "Deterministic retry check",
      uiChanges: false,
    },
    usage: { ...cycleUsageTotals, total: cycleUsageTotals, byProfile: { lead: cycleUsageTotals }, byProvider: { claude: cycleUsageTotals }, unmeasuredMembers: 0, partialMembers: 0 },
  };
  const settledCycle = {
    ...activeCycle,
    status: "ready-for-review",
    finishedAt: LATER,
    class: "reviewed" as const,
    settledAt: LATER,
    assessment: {
      verdictId: UUID2,
      revision: 1,
      head: HASH,
      kind: "reviewed" as const,
      result: "not-met" as const,
      counts: { met: 0, notMet: 1, inconclusive: 0, pendingOwner: 0 },
      criteria: [{ id: "c0", state: "not-met" as const }],
      at: LATER,
      progress: -1,
    },
  };
  assert.equal(goalCycleSchema.safeParse(activeCycle).success, true);
  assert.equal(goalCycleSchema.safeParse(settledCycle).success, true);
  assert.equal(goalCycleSchema.safeParse({ ...activeCycle, class: "reviewed" }).success, false);
  assert.equal(goalCycleSchema.safeParse({ ...activeCycle, settledAt: LATER }).success, false);
  assert.equal(isActiveGoalCycle(activeCycle), true);
  assert.equal(isActiveGoalCycle({ ...activeCycle, class: "reviewed" }), false);
  assert.equal(isActiveGoalCycle({ ...activeCycle, settledAt: LATER }), false);
  assert.equal(isSettledGoalCycle(settledCycle), true);
  assert.equal(isSettledGoalCycle({ ...activeCycle, class: "reviewed" }), false);
  assert.equal(isSettledGoalCycle({ ...activeCycle, settledAt: LATER }), false);
  assert.throws(() => projectGoalCycle({ ...activeCycle, class: "reviewed" }));
  assert.throws(() => projectGoalCycle({ ...activeCycle, settledAt: LATER }));
  const projectedActive: GoalCycleState = projectGoalCycle(activeCycle);
  const projectedSettled: GoalCycleState = projectGoalCycle(settledCycle);
  assert.equal(projectedActive.state, "active");
  assert.equal(projectedSettled.state, "settled");
});

test("SessionHeadless, ExecutionState, SessionRuntime, PermissionChannelView, and WorkerRequest enforce wire states", () => {
  const servedHeadless: SessionHeadless = { channel: true, allowlist: ["Read"] };
  const unservedHeadless: SessionHeadless = { channel: false, reason: "No hooks configured." };
  assert.equal(sessionHeadlessSchema.safeParse(servedHeadless).success, true);
  assert.equal(sessionHeadlessSchema.safeParse(unservedHeadless).success, true);
  assert.equal(sessionHeadlessSchema.safeParse({ channel: true, reason: "Unexpected" }).success, false);
  assert.equal(sessionHeadlessSchema.safeParse({ channel: false }).success, false);

  // @ts-expect-error served headless record cannot carry refusal reason
  const invalidServedReason: SessionHeadless = {
    channel: true,
    reason: "Unexpected",
  };
  // @ts-expect-error unserved headless record requires reason
  const invalidUnservedNoReason: SessionHeadless = { channel: false };
  assert.ok(invalidServedReason && invalidUnservedNoReason);

  const cloudOnline: ExecutionState = { location: "cloud", state: "online", cloudReady: true, reconciliation: "available" };
  const cloudPaused: ExecutionState = { location: "cloud", state: "paused", cloudReady: false, reason: "Reconnect failed." };
  const laptopPreparing: ExecutionState = { location: "laptop", state: "preparing", cloudReady: false, reason: "Syncing checkpoint" };
  assert.equal(executionStateSchema.safeParse(cloudOnline).success, true);
  assert.equal(executionStateSchema.safeParse(cloudPaused).success, true);
  assert.equal(executionStateSchema.safeParse(laptopPreparing).success, true);
  assert.equal(executionStateSchema.safeParse({ location: "cloud", state: "online", cloudReady: false }).success, false);
  assert.equal(executionStateSchema.safeParse({ location: "cloud", state: "online", cloudReady: true, reason: "Should not exist" }).success, false);
  assert.equal(executionStateSchema.safeParse({ location: "cloud", state: "paused", cloudReady: false }).success, false);
  assert.equal(executionStateSchema.safeParse({ location: "laptop", state: "online", cloudReady: true, reconciliation: "available" }).success, false);

  const invalidLaptopReconcile: ExecutionState = {
    location: "laptop",
    state: "online",
    cloudReady: true,
    // @ts-expect-error laptop execution cannot carry reconciliation
    reconciliation: "available",
  };
  // @ts-expect-error cloud execution cannot enter connecting state
  const invalidCloudConnecting: ExecutionState = {
    location: "cloud",
    state: "connecting",
    cloudReady: false,
  };
  assert.ok(invalidLaptopReconcile && invalidCloudConnecting);

  const ptyRuntime: SessionRuntime = { id: UUID, location: "local", transport: "pty", nativeUi: "codex" };
  const cmuxRuntime: SessionRuntime = { id: UUID, location: "local", transport: "cmux" };
  assert.equal(sessionRuntimeSchema.safeParse(ptyRuntime).success, true);
  assert.equal(sessionRuntimeSchema.safeParse(cmuxRuntime).success, true);
  assert.equal(sessionRuntimeSchema.safeParse({ ...cmuxRuntime, nativeUi: "codex" }).success, false);
  const invalidCmuxNative: SessionRuntime = {
    id: UUID,
    location: "local",
    transport: "cmux",
    // @ts-expect-error cmux runtime cannot carry nativeUi
    nativeUi: "codex",
  };
  assert.ok(invalidCmuxNative);

  const waiting = { interruptClass: "credentials", tool: "Bash", since: AT, expiresAt: LATER };
  const servedChannel: PermissionChannelViewState = projectPermissionChannelView({ served: true, waiting });
  const unservedChannel: PermissionChannelViewState = projectPermissionChannelView({ served: false, waiting });
  assert.equal(servedChannel.served, true);
  assert.equal(unservedChannel.served, false);
  assert.equal(permissionChannelViewSchema.safeParse({ served: true, waiting }).success, true);
  assert.equal(permissionChannelViewSchema.safeParse({ served: false, waiting }).success, false);

  const actor = { id: `team-permission:${UUID}`, label: "Team permission" };
  const baseTeamAnswer = {
    op: "team-answer" as const,
    requestId: randomUUID(),
    decisionId: UUID,
    targetSessionId: UUID2,
    assignment: { runId: UUID, memberId: UUID2, revision: 1, role: "implementer" as const },
    targetCwd: "/home/dev/projects/example",
    expiresAt: LATER,
    policyHash: SHA256,
    promptId: 1,
    promptHash: SHA256,
    evidenceHash: SHA256,
    option: 1,
    actor,
    leaseId: "lease-1",
  };
  const reviewerAnswer: TeamAnswerWorkerRequest = { ...baseTeamAnswer, coordinatorMemberId: randomUUID() };
  const agentAccept: TeamAnswerWorkerRequest = { ...baseTeamAnswer, choice: "accept" };
  const agentReject: TeamAnswerWorkerRequest = { ...baseTeamAnswer, choice: "reject", text: "Rejected by policy." };
  const workerReviewer: WorkerRequest = reviewerAnswer;
  const workerAccept: WorkerRequest = agentAccept;
  const workerReject: WorkerRequest = agentReject;
  assert.ok(workerReviewer && workerAccept && workerReject);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse(reviewerAnswer).success, true);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse({ ...reviewerAnswer, requestId: "req-1" }).success, true);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse(agentAccept).success, true);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse(agentReject).success, true);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse({ ...reviewerAnswer, choice: "accept" }).success, false);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse({ ...agentAccept, text: "Not allowed on accept" }).success, false);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse({ ...agentReject, text: "bad\x00text" }).success, false);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse({ ...reviewerAnswer, assignment: { ...baseTeamAnswer.assignment, role: "mission-coordinator" } }).success, false);
  assert.equal(teamAnswerWorkerRequestSchema.safeParse(baseTeamAnswer).success, false);

  const invalidMixedTeamAnswer: TeamAnswerWorkerRequest = {
    ...baseTeamAnswer,
    coordinatorMemberId: UUID,
    // @ts-expect-error reviewer team-answer cannot also specify permission-agent choice
    choice: "accept",
  };
  // @ts-expect-error permission-agent accept cannot carry reject text
  const invalidAcceptText: WorkerRequest = { ...baseTeamAnswer, choice: "accept", text: "Not allowed on accept" };
  const invalidMissionCoordinatorAnswer: WorkerRequest = {
    ...baseTeamAnswer,
    coordinatorMemberId: UUID,
    // @ts-expect-error mission-coordinator cannot be targeted by team-answer
    assignment: { ...baseTeamAnswer.assignment, role: "mission-coordinator" },
  };
  assert.ok(invalidMixedTeamAnswer && invalidAcceptText && invalidMissionCoordinatorAnswer);

  const claimReq: WorkerControlRequestState = { op: "control", action: "claim", actor, takeover: true };
  const renewReq: WorkerControlRequestState = { op: "control", action: "renew", actor, leaseId: "lease-1" };
  const workerClaim: WorkerRequest = claimReq;
  const workerRenew: WorkerRequest = renewReq;
  assert.ok(workerClaim && workerRenew);
  assert.equal(workerControlRequestSchema.safeParse(claimReq).success, true);
  assert.equal(workerControlRequestSchema.safeParse(renewReq).success, true);
  assert.equal(workerControlRequestSchema.safeParse({ op: "control", action: "renew", actor }).success, false);
  assert.equal(workerControlRequestSchema.safeParse({ op: "control", action: "release", actor, leaseId: "lease-1", takeover: true }).success, false);
  // @ts-expect-error WorkerRequest renew requires leaseId
  const invalidWorkerRenew: WorkerRequest = { op: "control", action: "renew", actor };
  // @ts-expect-error WorkerRequest release forbids takeover
  const invalidWorkerReleaseTakeover: WorkerRequest = { op: "control", action: "release", actor, leaseId: "lease-1", takeover: true };
  assert.ok(invalidWorkerRenew && invalidWorkerReleaseTakeover);

  const exportReq: WorkerWorkspaceExportRequestState = { op: "workspace-export", method: "sync/export" };
  const blobReq: WorkerWorkspaceExportRequestState = { op: "workspace-export", method: "sync/blob", hash: SHA256 };
  const workerExport: WorkerRequest = exportReq;
  const workerBlob: WorkerRequest = blobReq;
  assert.ok(workerExport && workerBlob);
  assert.equal(workerWorkspaceExportRequestSchema.safeParse(exportReq).success, true);
  assert.equal(workerWorkspaceExportRequestSchema.safeParse(blobReq).success, true);
  assert.equal(workerWorkspaceExportRequestSchema.safeParse({ op: "workspace-export", method: "sync/export", hash: SHA256 }).success, false);
  assert.equal(workerWorkspaceExportRequestSchema.safeParse({ op: "workspace-export", method: "sync/blob" }).success, false);
  // @ts-expect-error WorkerRequest sync/export forbids hash
  const invalidWorkerExportHash: WorkerRequest = { op: "workspace-export", method: "sync/export", hash: SHA256 };
  // @ts-expect-error WorkerRequest sync/blob requires hash
  const invalidWorkerBlobNoHash: WorkerRequest = { op: "workspace-export", method: "sync/blob" };
  assert.ok(invalidWorkerExportHash && invalidWorkerBlobNoHash);
});
