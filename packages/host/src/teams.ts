import type { ConnectorSource } from "./mcp-types.js";
import { runMayOverlapWindow, snapshotRepairRun, type RepairMetricsRun, type RepairRunFilter } from "./repair-metrics.js";
import { withoutMainCheck, type HandoffPolicy, type TeamHandoffContext } from "./handoff-types.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type Config, type Session, isEvalSession } from "./types.js";
import { TeamStopRefused, type Manager } from "./manager.js";
import { bootId, extendWitness, hostProcesses, newWitness, recordCommand, type CensusResult, type HostProcesses, type ProcessWitness } from "./process-census.js";
import type { WorkerError } from "./ipc.js";
import { writeSealed, unseal } from "./vault.js";
import { accountSettingPrompt, PROVIDER_NAMES, recoveryTurnEnd, type AttentionState, type Prompt, type SignalData } from "@infinite/attention";
import { activeStageForRole, evaluateStallRecovery, MEMBER_STALL_REASON, syncObservedMemberState, type LivePromptRef } from "./stall-recovery.js";
import { describeTeamWaitReasons, PERMISSION_AGENT_REASON, PERMISSION_REVIEW_REASON, PROVIDER_INPUT_REASON, SESSION_SLOT_REASON } from "./team-wait-reasons.js";
import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import { buildTeamPendingOperation, createTeamSchema, decisionAnswerLabel, inputSourceLabel, lineupProfiles, resolveLimitFallback, teamActionSchema, teamGoalContextSchema, teamLineupSchema, teamMutationSchema, teamMemberRetireSchema, teamParallelismSchema, recordedTeamReportEnvelopeSchema, type CreateTeam, type SteeringSource, type TeamContinue, type TeamGoalContext, type TeamLineup, type TeamMember, type TeamMemberRetire, type TeamModelProfile, type TeamParallelism, type TeamPermissionDecision, type TeamPermissionRecoveryView, type TeamReport, type TeamRun, type TeamScout, type TeamTask, type TeamView, type TeamVerificationReconcile, type TeamDeliveryReconcile, currentPermissions, DEFAULT_STORAGE_FLOOR, hostClosedBlockedReason, autoPinned, coversPoint, escalationPool, hostProfilesFor, memberLimit, switchFallback } from "./team-types.js";
import { memberConfiguration, type MemberConfiguration } from "./config-identity.js";
import { deliveryPromptStale, pullRequestBranch, refreshReportingInstructions, retargetPrompt, TEAM_PROMPT_LIMIT_BYTES, teamContext, teamDeliveryBranch, teamPrompt } from "./team-prompts.js";
import { reviewEvidenceProblems } from "./team-acceptance.js";
import { memberCodeModeExpected, teamModelLaunch } from "./launch.js";
import { CheckOutputScanner, checkFeedback } from "./team-check-output.js";
import { metricObserver, reviewedObservationsOf } from "./check-observations.js";
import { resumeFailed } from "./native-continuation.js";
import { combineCoverage, type UsageService } from "./usage-service.js";
import { type EvidenceStore, eventProblem } from "./evidence/store.js";
import { applyFuseReason, workLaunch } from "./fuse/rules.js";
import type { FuseAdmission, FuseCheck, FuseGate } from "./fuse/types.js";
import { KeyedQueue, PendingCreates, mapConcurrent, pauseWithPendingCreates } from "./keyed-queue.js";
import type { CaptureSink } from "./eval-types.js";
import { captureStart } from "./eval-rules.js";
import { HALT_PAUSED_TEAM, KEPT_PAUSED, LEFT_AS_IS, STILL_HALTED, pauseFailure, releaseRefusal, type HaltCovers, type HaltHeldBy, type HaltMark, type HaltOutcome } from "./halt/rules.js";
import type { EventOutbox, OutboxEvent } from "./evidence/outbox.js";
import type { Blackboard } from "./evidence/blackboard.js";
import { canonicalJson } from "./evidence/crypto.js";
import { entryToolsFor } from "./entry-roles.js";
import type { RoutingRecorder } from "./routing-recorder.js";
import { assertTaskProfiles, fallbackProfile, routingComponent } from "./routing-rules.js";
import { ENTRY_DROP_TEXT, ENTRY_INGEST_MEMBERS, ENTRY_INGEST_MS, EntryIngestQueue, ingestRunMemberEntries } from "./team-entry-ingest.js";
import { MAX_OUTBOX_EVENTS, appendRunEvent as runEvent, pathField, planDigest, profileIdentity, runEventKey, runSummaryCounts, type MemberStopDetail, type MemberStopReason, type ReplacementCause } from "./run-events.js";
import { taskFeatures } from "./task-features.js";
import { recordedTaskLimitations, taskLimitations } from "./team-task-limitations.js";
import { teamUsage } from "./team-usage.js";
import { teamListItem, type TeamListItem } from "./team-list.js";
import { teamLastActivityAt, TeamSaveTracker } from "./team-activity.js";
import { ProviderLimits, switchesMember, type LimitObservation } from "./provider-limits.js";
import type { LinearService } from "./linear.js";
import type { Readings } from "./readings.js";
import { projectGithubRepository, sessionGithubScope } from "./github-grants.js";
import type { ProjectSourceService } from "./project-source.js";
import type { RepositoryGraphs, RepositoryGraphResult } from "./repository-graphs.js";
import { LEGACY_READ_ONLY_ROLE_CHANGED_FILES_REASON, TeamError, assertMemberReadOnly, assertMemberScope, assertTeamPath, captureDeliveryBaseline, captureMemberResult, ensureDefaultTeamRoot, ensureHostDirectory, integrateMemberResult, prepareMemberScratch, prepareMemberWorkspace, prepareRecoveryWorkspaceFromSource, prepareTeamWorkspace, prepareTeamWorkspaceFromMirror, prepareVerificationWorkspace, commandScope, type CommandResult, type CommandScope, teamCommand, teamHead, teamWorkspacePath, teamGitArgs, validateTeamPlan, writeTeamContext } from "./team-workspace.js";
import { assertTeamworkPath } from "./repo-enrollment.js";
import { HOST_LOAD_REASON_PREFIX, LaunchHeldError } from "./host-load.js";
import { permissionEvidenceHash } from "./team-permissions.js";
import { storageShortfall, volumeUsage, type VolumeUsage } from "./storage.js";
import type { PermissionAgentServices } from "./permission-agent-types.js";
import { activeMember, activeTeamRun, assignment, automaticRecoveryLimit, boundedRecoveryText, commitId, coordinatorPermissionPrompt, deliveredAtRevision, digest, filesystemEntryExists, livePermissionRecoveryStatuses, permissionCoordinatorDecision, permissionRequestCount, recoveriesUsed, teamRunDirectory, terminalPermissionCoordinator, timestamp } from "./team-kernel.js";
import type { PermissionHost } from "./team-permission-agent.js";
import { TeamPermissionReview } from "./team-permission-review.js";
import { teamRetentionState, TeamRetention, type RetentionHost } from "./team-retention.js";
import { TeamPublisher, type PublisherHost } from "./team-publisher.js";
import { applyLaunchHoldReason, commitProviderLimitSwitch, ENRICH_LIMIT, escalationRetargetFor, evaluateLaunchAdmission, expireQueuedPermissionReview, isBenignEnrichError, isBenignFenceError, isBenignOutboxError, isBenignSourceRefreshError, isBenignStopError, isDeferredWorkerMember, limitFallbackEligibility, resolveLaunchHoldReason, TeamDiagnostics, TrackedTaskSet, type TeamDiagnosticsSnapshot } from "./team-diagnostics.js";
import { TeamReviewFeedback, type ReviewFeedbackHost } from "./team-review-feedback.js";
import type { ReviewIntake } from "./review-feedback.js";
import { TeamRecovery, automaticOperationRecoveryCodes, deliveryBranchMatches, deliveryInspectionHash, genericOperationFailureReason, interruptedOperationReason, recoverableOperationFailure, recoverableUnattributedResult, type RecoveryHost } from "./team-recovery.js";
import { planRunObjective, runObjectiveNote, runObjectiveView, steerRunObjective, type ObjectiveUnavailable } from "./objective-runs.js";
import { TeamIntent, type GoalRecordPort, type IntentCheckState } from "./team-intent.js";
import { TeamRegister, objectivePromptOf, registerPin, type RegisterState } from "./team-register.js";
import { TeamReplay, type JudgeCreate, type ReplayCreate, type ReplayState } from "./team-replay.js";
import { autonomyStartEvent, intentCheckPin, startMode, verdictPin } from "./evaluator-profiles.js";
import { applyTeamBriefTitle, assertPlannerCapacity, capacityCeiling, plannedTasks, plannerCorrectionFeedback } from "./team-planning.js";
import { validateGoalTaskCriterionRefs } from "./team-goal-criteria.js";
import { advanceDeliveryReviewLineage, assertReviewedDelivery, automaticMergeReviewReason, deliveryReviewLineageAtBase, inheritDeliveryReviewLineage, rebaseDeliveryReviewLineage, workspaceContributorFamilies, type DeliveryReviewApproval, type DeliveryReviewLineage } from "./delivery-review.js";
import { projectMissionChild, type MissionProgressChild } from "./mission-progress.js";
export { applyTeamBriefTitle };
import { TeamVerdicts, type VerdictState } from "./team-verdicts.js";
import type { DeliveryFact } from "./verdict-types.js";
export { TeamError } from "./team-workspace.js";
import { changeIndex, changedPathList, diffStat } from "./team-changes.js";
import { recommendationLine, recommendationOutcome } from "./question-recommendation.js";
import { integrationGauge } from "./outcome-gauges.js";
export { changeIndex };

type Mutation = { requestId: string; revision: number; text: string };
export type VerificationMutation = TeamVerificationReconcile;
export type Action = { requestId: string; revision: number };
type LimitSwitch = LimitObservation & { at: string; seq: number };
type StartInProject = <T>(projectId: string, start: () => Promise<T>) => Promise<T>;
type MissionReservationLookup = (projectId: string, exceptMissionId?: string) => string | undefined;
export type TeamServiceOptions = {
  processes?: HostProcesses;
  source?: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status"> & Partial<Pick<ProjectSourceService, "onTick">>;
  graphs?: Pick<RepositoryGraphs, "refresh">;
  onMerged?: (projectId: string) => void;
  ownerActive?: (run: TeamRun) => boolean;
  now?: () => number;
  memberWorkCommandTimeoutMs?: number;
  memberWorkPushTimeoutMs?: number;
  memberWorkCommandStopGraceMs?: number;
  volumeUsage?: (path: string) => Promise<VolumeUsage>;
  events?: EventOutbox;
  entries?: Blackboard;
  capture?: CaptureSink;
  delivery?: (runId: string, head: string, since: string) => DeliveryFact | undefined;
};
export type RetentionState = { status: TeamRun["status"]; statusAt: string; integratedAt: Record<string, string>; removalErrors: Record<string, string[]>; retryAt?: Record<string, string>;
  evidenceHeldAt?: string };
const ENTRY_DRAIN_RUNS = 4;
const REVIEW_QUIET_WINDOW_MS = 5 * 60_000;
export type PendingOperation = { id: string; kind: "prepare" | "member" | "result" | "check"; revision: number;
  source?: { memberId: string; role: TeamMember["role"]; cwd: string; baseCommit: string; headCommit: string; workspace: "member" | "integration" };
  failure?: { code?: string; reason: string; at: string };
  witness?: ProcessWitness;
  recording?: true;
};
type OperationCensus = { pendingId: string; at: string; state: "running" | "in-use" | "ended" | "unknown"; recorded?: number; using?: number; detail?: string };
const CENSUS_TTL_MS = 10 * 60_000;
const WITNESS_SAVE_MS = 200;
type OperationRecorder = { pendingId: string; inFlight: number; spawning: number; sampling?: true; save?: NodeJS.Timeout };
function operationCensusEvent(kind: PendingOperation["kind"], census: Omit<OperationCensus, "at" | "pendingId">) {
  if (census.state === "running") return `The host still sees ${census.recorded} process(es) that match its record of the interrupted ${kind} operation${census.using ? `, and ${census.using} more using this run's directory` : ""}.`;
  if (census.state === "in-use") return `The host sees ${census.using} process(es) using this run's directory. None matches its record of the interrupted ${kind} operation.`;
  if (census.state === "ended") return `The host sees no process that matches its record of the interrupted ${kind} operation, and none using this run's directory. The intent stays recorded and is not replayed.`;
  return `The host cannot tell whether the interrupted ${kind} operation left processes: ${census.detail}.`;
}
export type Stored = {
  run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean; root?: string; anchor?: string;
  goalPlanCorrectionRevision?: number;
  deliveryReviewLineage?: DeliveryReviewLineage;
  deliveryReviewApproval?: DeliveryReviewApproval;
  retention?: RetentionState;
  census?: OperationCensus;
  outbox?: OutboxEvent[];
  ledgerStatus?: TeamRun["status"];
  permissionTaskEnded?: true;
  ledgerBlockSource?: string;
  ledgerGap?: { dropped: number; firstAt: string };
  pending?: PendingOperation;
  verificationRecovery?: { pendingId: string; pendingKind: "check"; revision: number; headCommit: string; failure: "setup-changed-files" | "verification-changed-files" | "legacy-completed-check" };
  halt?: "pause" | "cancel" | "steer" | "block";
  ownerHalt?: { haltId?: string; reason: string; waiting?: true };
  unfencedAnswers?: string[];
  answersMarked?: true;
  deliveryAttempt?: { memberId: string; revision: number; headCommit: string };
  continuationHead?: { revision: number; headCommit: string };
  checkHead?: string;
  checkObservations?: unknown;
  source?: { path: string; head?: string; startCommit?: string };
  handoffPolicy?: HandoffPolicy;
  goalExtensions?: Record<string, { deadlineAt: string; ceilingAt: string }>;
  ratings?: Record<string, { fingerprint: string; result: TeamTask["ownerRating"] }>;
  ledgerReplaces?: Record<string, { memberId: string; cause: ReplacementCause }>;
  objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable; intentCheck?: IntentCheckState; register?: RegisterState;
  verdict?: VerdictState;
  reviewIntake?: ReviewIntake;
};
const receiptDigest = <T extends object>(value: T & { source?: SteeringSource | string; by?: string }) => {
  const { source, by, ...body } = value;
  return digest({ ...body, ...(by && by !== "coordinator" ? { by } : {}),
    ...(typeof source === "object" ? { source: { kind: source.kind, id: source.id } } : {}) });
};
const heldWaiting = (stored: Stored) => stored.run.status === "paused" && stored.ownerHalt?.waiting === true;
const holdsWorkerSlot = (member: TeamMember, revision: number) => member.revision === revision &&
  (member.role === "scout" || member.role === "implementer") &&
  (!isDeferredWorkerMember(member) && ["queued", "running", "unavailable"].includes(member.status) || member.status === "reported" && !member.exitConfirmedAt);
export const providerInputReason = PROVIDER_INPUT_REASON;
const permissionReviewReason = PERMISSION_REVIEW_REASON;
const permissionAgentReason = PERMISSION_AGENT_REASON;
const runtimeUnavailableReason = "An agent runtime is unavailable; the team is waiting for confirmed state.";
const memberStateReasons: ReadonlySet<string> = new Set([runtimeUnavailableReason, permissionReviewReason, permissionAgentReason, providerInputReason]);
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;
export const memberTimeLimitReason = "An agent exceeded its one-hour runtime limit. Its workspace was preserved.";
export const memberStallReason = MEMBER_STALL_REASON;
export const checkTimeoutReason = "A configured check ran past the team check time limit (teams.checkMinutes) and was stopped. No correction round was used; the integrated work was preserved.";
export const commandLeftoverEvent = "A configured command exited while a process it started still held its output. The host judged the command by its exit code and neither waited for that process nor stopped it.";
export const repeatedCheckFailureReason = "The same required verification command failed again against an unchanged integration commit. No further identical repair was attempted; inspect the check output and continue with owner direction.";
const repairLimitReason = "The team exhausted its two correction rounds. Review the check and agent evidence before continuing manually.";
const promptTooLargeReason = "The accumulated team requirements exceed the prompt limit. Start a new team with consolidated requirements.";
const missingAgentReportReason = "An agent exited without a valid structured report. Its task is unresolved.";
const invalidNoChangeReason = "A no-change report is valid only before implementation tasks are planned and when the integration head is unchanged from the base.";
const wrongAgentReportReason = "An agent's report does not match its assigned role.";
const agentQuestionReason = (role: TeamMember["role"], report: Extract<TeamReport, { kind: "question" }>) =>
  `The ${role} requested an owner decision: ${report.question}${report.recommendation ? ` ${recommendationLine(report.recommendation)}` : ""}`;
const automaticRecoveryCodes = new Set(["agent-blocked", "agent-question", "missing-agent-report", "invalid-no-change", "wrong-agent-report"]);
function roleAcceptsReport(role: TeamMember["role"], kind: NonNullable<TeamMember["report"]>["kind"]) {
  const expected: Record<TeamMember["role"], string[]> = {
    "permission-coordinator": ["permission-decision"], "project-manager": ["plan", "explore", "no-change"], scout: ["findings"],
    implementer: ["result", "escalate"], integrator: ["result"], reviewer: ["review"], delivery: ["delivery", "delivery-repair", "delivery-reconciliation", "pull-request"], "intent-checker": ["intent-check"], evaluator: ["verdict"], judge: ["judgement"],
  };
  return kind === "question" || kind === "blocked" || expected[role].includes(kind);
}
const recoverableContinueCodes = new Set(["repair-limit", "team-prompt-too-large", "repeated-check-failure", "agent-blocked", "missing-agent-report"]);
const verificationRecoveryReason = "A read-only verification command changed its workspace. Inspect the check evidence before resuming from the recorded integration commit.";
function completedChecks(stored: Stored, revision: number) {
  const checks = stored.run.checks.filter(check => check.revision === revision);
  return checks.length > 0 && checks.every(check => (check.status === "passed" || check.status === "failed") && Boolean(check.finishedAt));
}
function validVerificationRecovery(stored: Stored) {
  const { run, pending, verificationRecovery } = stored;
  const head = run.headCommit;
  return Boolean(pending && verificationRecovery && run.status === "blocked" && pending.kind === "check" &&
    pending.id === verificationRecovery.pendingId && verificationRecovery.pendingKind === "check" &&
    pending.revision === run.revision && verificationRecovery.revision === run.revision &&
    head && commitId.test(head) && verificationRecovery.headCommit === head && stored.checkHead !== head &&
    !stored.deliveryAttempt && !run.deliveryReceipt && !run.stopReason && completedChecks(stored, run.revision) &&
    (verificationRecovery.failure === "legacy-completed-check" || verificationRecovery.failure === "setup-changed-files" || verificationRecovery.failure === "verification-changed-files"));
}
function obsoletePermissionResult(stored: Stored, pending: PendingOperation) {
  const { run } = stored;
  if (run.status === "paused" || run.status === "cancelled" || stored.halt === "pause" || stored.halt === "cancel" || pending.kind !== "result" || pending.revision !== run.revision) return undefined;
  const reported = run.members.filter(member => member.revision === pending.revision && member.report && roleAcceptsReport(member.role, member.report.kind));
  const candidates = reported.filter(member => {
    const report = member.report;
    return member.role === "permission-coordinator" &&
      (!pending.source || pending.source.memberId === member.memberId) && report?.kind === "permission-decision" &&
      Boolean(run.permissionDecisions?.some(decision => decision.coordinatorMemberId === member.memberId &&
        (decision.coordinatorSessionId === member.sessionId || decision.coordinatorSessionId === undefined) && decision.id === report.decisionId &&
        decision.revision === member.revision && terminalPermissionCoordinator(run, member)));
  });
  return candidates.length === 1 && (pending.source || reported.length === 1) ? candidates[0] : undefined;
}

export function blockedTeamCanResume(input: {
  status: string;
  reason?: string;
  pending: boolean;
  deliveryAttempt: boolean;
  deliveryReceipt: boolean;
  prepared: boolean;
  stopReason?: string;
  linearStatus?: string;
  verificationRecovery?: boolean;
}): boolean {
  return input.status === "blocked"
    && (input.verificationRecovery === true || input.reason === memberStallReason || input.reason === memberTimeLimitReason || input.reason === checkTimeoutReason)
    && input.prepared
    && !input.pending
    && !input.deliveryAttempt
    && !input.deliveryReceipt
    && !input.stopReason
    && input.linearStatus !== "blocked";
}
function blockedTeamCanContinue(run: TeamRun, allowRemovedWorkspace = false): boolean {
  if (run.status !== "blocked" || run.workspaceRemovedAt && !allowRemovedWorkspace || run.goal || run.missionId || run.handoff || run.stopReason || run.deliveryReceipt) return false;
  const code = run.blockCode ?? (run.reason === repairLimitReason ? "repair-limit"
    : run.reason === promptTooLargeReason || run.reason === "The team requirements exceed the prompt limit. Start a new team with consolidated requirements." ? "team-prompt-too-large"
      : run.reason === missingAgentReportReason ? "missing-agent-report" : undefined);
  return code !== undefined && recoverableContinueCodes.has(code);
}
const configuredData = (data: MemberConfiguration) => ({
  configId: data.configId, provider: data.provider,
  ...(data.model == null ? {} : { model: data.model }), ...(data.effort == null ? {} : { effort: data.effort }),
  promptVersion: data.promptVersion, guidance: data.guidance, knowledge: data.knowledge, routing: data.routing, shape: data.shape,
});
export class TeamService {
  private readonly records = new Map<string, Stored>();
  private readonly activity = new TeamSaveTracker();
  private readonly retiredRunIds = new Set<string>();
  private readonly queues = new KeyedQueue();
  private readonly pendingCreates = new PendingCreates();
  private readonly diag = new TeamDiagnostics(() => this.options?.now?.() ?? Date.now());
  private readonly activeTicks = new TrackedTaskSet<Promise<unknown>>(() => this.diag.idle.bump());
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private tickQueued = false;
  private enrichments = 0;
  private readonly entryBacklog = new Set<string>();
  private readonly entryQueue = new EntryIngestQueue();
  private entryIngestAt = 0;
  private readonly commands = new Map<string, AbortController>();
  private readonly recorders = new Map<string, OperationRecorder>();
  private readonly sampleTimers = new Set<NodeJS.Timeout>();
  private readonly retention = new TeamRetention(this.retentionHost());
  private readonly publisher = new TeamPublisher(this.publisherHost());
  private readonly recovery = new TeamRecovery(this.recoveryHost());
  private readonly permissions = new TeamPermissionReview(this.permissionHost());
  private readonly reviewFeedback = new TeamReviewFeedback((service => ({ get records() { return service.records; }, get config() { return service.config; },
    get key() { return service.key; }, get directory() { return service.directory; }, save: stored => service.save(stored), event: (stored, text) => service.event(stored, text),
    enqueue: (runId, task) => service.enqueue(runId, task), steer: (id, input, source) => service.steer(id, input, source), held: projectId => Boolean(service.fuse?.held?.([projectId])),
    now: () => service.options?.now?.() ?? Date.now(), block: (stored, error) => service.block(stored, error), step: stored => service.step(stored),
    rebuildDeliveryPrompts: stored => service.rebuildDeliveryPrompts(stored) }) satisfies ReviewFeedbackHost)(this));
  private readonly directory: string;
  private usage?: UsageService;
  private evidence?: EvidenceStore;
  private router?: RoutingRecorder;
  private fuse?: FuseGate;
  private missionReservations?: MissionReservationLookup;
  private readonly limits: ProviderLimits;
  private readonly replays = new TeamReplay({ config: () => this.config, emit: (s, k, keys, ids, data) => this.emit(s as Stored, k, keys, ids, data), save: s => this.save(s as Stored), cancel: s => this.enqueue((s as Stored).run.id, () => this.stopRun(s as Stored, "cancel")), sessionStatus: async id => (await this.manager.state(id).catch(() => undefined))?.status, activeMember,
    prepare: (s, o, p) => this.prepareMember(s as Stored, "judge", undefined, undefined, o, p),
    operation: (s, p, c, m) => this.operation(s as Stored, "result", p, c, m) });
  private readonly intentChecks = new TeamIntent({ prepare: (s, r, f, o, p) => this.prepareMember(s as Stored, r, undefined, f, o, p), consume: (s, m) => this.consume(s as Stored, m), operation: (s, p, c, m) => this.operation(s as Stored, "result", p, c, m), save: s => this.save(s as Stored), event: (s, t) => this.event(s as Stored, t), block: (s, e, m) => this.block(s as Stored, e, m), project: run => this.config.projects.find(project => project.id === run.projectId), limited: () => this.limits.limited(this.currentDate()), prefix: () => this.config.teams?.commandPrefix });
  private readonly objectiveTests = new TeamRegister({ holder: id => this.records.get(id), configured: run => this.config.projects.find(project => project.id === run.projectId)?.team?.checks ?? [], workspace: s => { try { this.assertRunPath(s as Stored, s.run.workspace); return s.run.workspace; } catch { return undefined; } }, enqueue: (runId, work) => this.enqueue(runId, work), save: s => this.save(s as Stored), event: (s, text) => this.event(s as Stored, text), prefix: () => this.config.teams?.commandPrefix, now: timestamp });
  readonly verdicts = new TeamVerdicts({ holder: id => this.records.get(id), prepare: (s, o, p, f) => this.prepareMember(s as Stored, "evaluator", undefined, undefined, o, p, f), consume: (s, m) => this.consume(s as Stored, m), operation: (s, p, c, m) => this.operation(s as Stored, "result", p, c, m), save: s => this.save(s as Stored), delivery: (runId, head, since) => this.options?.delivery?.(runId, head, since), event: (s, t) => this.event(s as Stored, t), emit: (s, d) => this.emitWith(s as Stored, "verdict.recorded", [d.verdictId], { revision: s.verdict?.revision ?? s.run.revision }, () => d), configured: run => this.config.projects.find(project => project.id === run.projectId)?.team?.checks ?? [], limited: () => this.limits.limited(this.currentDate()), prefix: () => this.config.teams?.commandPrefix, register: this.objectiveTests, now: timestamp, uuid: randomUUID });
  private reconciledAt = 0;
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly startInProject: StartInProject, private readonly linear?: LinearService, private readonly titler?: Pick<Readings, "requestTitle">, private readonly options?: TeamServiceOptions) {
    this.directory = join(config.stateDir, "teams");
    this.limits = new ProviderLimits(join(config.stateDir, "provider-limits.sealed"), key);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.retention.findMemberTraces();
    const retiredPath = join(this.directory, "retired.sealed");
    try {
      const retired = unseal<unknown>(key, "team:retired", readFileSync(retiredPath, "utf8"));
      if (!Array.isArray(retired) || retired.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)))
        throw new TeamError(409, "invalid-team-retired", "The team deletion history cannot be authenticated.");
      for (const id of retired.slice(-2000)) this.retiredRunIds.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        if (error instanceof TeamError) throw error;
        throw new TeamError(409, "invalid-team-retired", "The team deletion history cannot be authenticated.");
      }
    }
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `team:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.run.id !== id) throw new TeamError(409, "invalid-team-record", "A team record cannot be authenticated.");
      this.records.set(id, stored); this.activity.seed(stored);
      if (stored.run.blackboard?.tools === true) for (const member of stored.run.members) if (member.entryTools === true) this.entryQueue.add(stored.run.id, member.memberId);
      if (this.options?.events && stored.ledgerStatus === undefined) stored.ledgerStatus = stored.run.status;
      for (const request of stored.run.permissionRecovery?.requests ?? []) if (request.status === "expanding" &&
          (request.expansion?.status === "intent" || request.expansion?.status === "uncertain")) {
        request.expansion.status = "uncertain";
        request.status = "interrupted";
        const cause = "The host restarted with an unresolved display-expansion intent; the keystroke will not be replayed.";
        this.recordPermissionRecoveryStep(stored, request, { cause, action: "expand-display", decision: "do-not-replay", consequence: "The prompt remains unanswered and requires fresh owner or coordinator inspection." });
        this.finishPermissionRecovery(stored, request, "interrupted", cause, "expand-display", "do-not-replay", "The prompt remains unanswered; no provider command execution was observed.");
        this.event(stored, cause);
        this.save(stored);
      }
      if (stored.run.parallelismCeiling === undefined && !stored.run.missionId &&
          !["cancelled", "ready-for-review", "merged", "no-change"].includes(stored.run.status)) {
        const ceiling = stored.run.handoff ? 2 : 4;
        const previous = stored.run.parallelism;
        stored.run.parallelismCeiling = ceiling;
        stored.run.parallelism = ceiling;
        this.event(stored, `Legacy worker capacity was moved to agent management: ${previous} to ${ceiling} (capacity ceiling ${ceiling}).`);
        this.save(stored);
      }
      if (!stored.pending && !stored.prepared && stored.run.members.length === 0 &&
          !["cancelled", "merged", "no-change", "ready-for-review", "blocked"].includes(stored.run.status)) {
        stored.run.status = "blocked"; stored.halt = "block";
        stored.run.reason = "The host restarted before this team's workspace was prepared. Start a new team.";
        this.event(stored, stored.run.reason);
        this.save(stored); this.trackBlocked(stored);
      }
      if (stored.pending) {
        stored.run.checks = stored.run.checks.map(check => check.status === "running" ? { ...check, status: "interrupted", finishedAt: timestamp() } : check);
        const pending = stored.pending, run = stored.run;
        const recoverableMarker = validVerificationRecovery(stored);
        const legacyGuardFailure = run.reason === LEGACY_READ_ONLY_ROLE_CHANGED_FILES_REASON;
        const legacyCompletedCheck = run.status === "blocked" && legacyGuardFailure && pending.kind === "check" &&
          pending.revision === run.revision && Boolean(run.headCommit && commitId.test(run.headCommit)) && stored.checkHead !== run.headCommit &&
          !stored.deliveryAttempt && !run.deliveryReceipt && !run.stopReason && completedChecks(stored, run.revision);
        if (stored.run.status === "paused") {
          stored.halt = "pause";
          this.event(stored, "The host restarted with an unresolved operation from a paused team. The pause remains in effect and the intent will not be replayed.");
        } else if (stored.run.status === "cancelled") {
          stored.halt = "cancel";
          this.event(stored, "The host restarted with an unresolved operation from a cancelled team. The intent remains retained and will not be replayed.");
        } else if (obsoletePermissionResult(stored, pending)) {
          stored.pending = undefined;
          stored.halt = undefined;
          run.status = "planning"; run.reason = undefined; run.blockCode = undefined;
          this.event(stored, "A retained permission-review result was dispositioned because its one-shot decision is already terminal. Its report and unavailable session record remain in history; no permission answer or report was replayed.");
          this.save(stored);
        } else if (recoverableOperationFailure(stored, pending) || recoverableUnattributedResult(stored, pending)) {
          const sourceMember = recoverableOperationFailure(stored, pending);
          if (!pending.failure) pending.failure = {
            code: run.blockCode && automaticOperationRecoveryCodes.has(run.blockCode) ? run.blockCode : "unattributed-result",
            reason: run.reason ?? "The host restarted with a result intent that has no member provenance. All original reports and workspaces are retained for coordinator diagnosis.",
            at: timestamp(),
          };
          pending.failure.code ??= run.blockCode && automaticOperationRecoveryCodes.has(run.blockCode) ? run.blockCode : "unattributed-result";
          const source = { code: pending.failure.code, memberId: sourceMember?.memberId ?? "unattributed", revision: pending.revision,
            ...(sourceMember?.report ? { reportKind: sourceMember.report.kind } : {}),
            reason: pending.failure.reason, at: pending.failure.at };
          const attempts = run.recovery?.attempts ?? 0;
          const reserved = run.recovery?.status === "stopping" && run.recovery.source.revision === pending.revision &&
            run.recovery.source.memberId === source.memberId && run.recovery.source.code === source.code;
          if (reserved) {
            run.status = "planning"; stored.halt = "block"; run.reason = run.recovery!.source.reason; run.blockCode = run.recovery!.source.code;
            this.event(stored, "The persisted automatic recovery reservation was restored without consuming another attempt.");
          } else if (attempts < automaticRecoveryLimit) {
            run.recovery = { attempts: attempts + 1, status: "stopping", source };
            run.status = "planning"; stored.halt = "block"; run.reason = source.reason; run.blockCode = source.code;
            this.event(stored, "The project manager will diagnose the retained result intent after write-capable members are confirmed stopped.");
          } else {
            run.recovery = { attempts, status: "exhausted", source };
            run.status = "blocked"; stored.halt = "block"; run.reason = interruptedOperationReason; run.blockCode = source.code;
          }
          this.save(stored);
        } else if (recoverableMarker || legacyCompletedCheck) {
          if (!recoverableMarker) stored.verificationRecovery = {
            pendingId: pending.id, pendingKind: "check", revision: pending.revision, headCommit: run.headCommit!, failure: "legacy-completed-check",
          };
          run.status = "blocked"; stored.halt = "block";
          run.reason ??= verificationRecoveryReason;
          this.event(stored, "The host restarted with a completed verification operation. Its rejected evidence and original integration workspace were preserved for review.");
        } else {
          stored.run.status = "blocked"; stored.halt = "block";
          stored.run.reason = interruptedOperationReason;
          stored.run.blockCode = undefined;
          delete stored.verificationRecovery;
          this.event(stored, stored.run.reason);
        }
        this.save(stored); this.trackBlocked(stored);
      }
      if (!stored.answersMarked) {
        const uncertain = (stored.run.permissionDecisions ?? []).filter(decision => decision.status === "uncertain").map(decision => decision.id);
        stored.answersMarked = true;
        if (uncertain.length) {
          stored.unfencedAnswers = [...new Set([...(stored.unfencedAnswers ?? []), ...uncertain])];
          this.save(stored);
        }
      }
      for (const decision of stored.run.permissionDecisions ?? []) if (decision.status === "answering") {
        decision.status = "uncertain";
        stored.unfencedAnswers = [...new Set([...(stored.unfencedAnswers ?? []), decision.id])];
        decision.reason = "The host restarted while an answer was in flight. Inspect the target session before taking any further action.";
        this.finishLinkedPermissionRecovery(stored, decision, decision.reason, "restore-after-restart", "answer-state-uncertain",
          "The target session must be inspected before any further action.");
        this.event(stored, decision.reason);
        this.save(stored);
      }
      for (const decision of stored.run.permissionDecisions ?? []) if (["pending", "reviewing", "approved"].includes(decision.status) &&
          (stored.pending || decision.recoveryRequestId && stored.run.permissionRecovery?.requests.some(request => request.id === decision.recoveryRequestId))) {
        decision.status = "stale";
        decision.reason = "The host restarted during a team operation. Review this request with the user.";
        this.finishLinkedPermissionRecovery(stored, decision, decision.reason, "restore-after-restart", "do-not-replay",
          "No permission answer was sent; execution is unknown.");
        this.save(stored);
      }
      for (const request of stored.run.permissionRecovery?.requests ?? []) if (livePermissionRecoveryStatuses.has(request.status)) {
        const cause = "The host restarted during permission recovery; the retained operation will not be replayed.";
        this.recordPermissionRecoveryStep(stored, request, { cause, action: "restore-after-restart", decision: "do-not-replay", consequence: "The provider request remains unanswered and requires fresh owner review." });
        this.finishPermissionRecovery(stored, request, "interrupted", cause, "restore-after-restart", "do-not-replay", "No permission answer was sent; execution is unknown.", request.latestDecisionId);
        this.save(stored);
      }
      for (const decision of stored.run.permissionDecisions ?? []) if (!decision.authorityHash && ["pending", "reviewing", "approved"].includes(decision.status)) {
        decision.status = "stale";
        decision.reason = "Recorded before owner authority was pinned; the request is reviewed again under the current owner direction.";
        this.save(stored);
      }
      this.recoverLegacyBlocked(stored);
      this.admitBlockedDeliveryRecovery(stored);
    }
    if (this.options?.events) for (const stored of this.records.values()) if (stored.outbox?.length) this.flushOutbox(stored);
    if (this.options?.entries) {
      for (const stored of this.records.values()) if (activeTeamRun(stored.run.status)) this.entryBacklog.add(stored.run.id);
      for (const stored of this.records.values()) this.entryBacklog.add(stored.run.id);
      this.drainEntries();
    }
    this.objectiveTests.restore(this.records.values()); this.verdicts.restore(this.records.values());
  }
  useUsage(service: UsageService) { this.usage = service; }
  useMissionReservations(lookup: MissionReservationLookup) { this.missionReservations = lookup; }
  useMissionReviews(destination: Parameters<TeamReviewFeedback["useMissions"]>[0]) { return this.reviewFeedback.useMissions(destination); }
  useEvidence(store: EvidenceStore) { this.evidence = store; }
  useRouter(router: RoutingRecorder) { this.router = router; }
  useFuse(fuse: FuseGate) { this.fuse = fuse; }
  useGoalRecords(port: GoalRecordPort) { this.intentChecks.goals = port; this.objectiveTests.goals = port; this.verdicts.goals = port; this.verdicts.restore(this.records.values()); }
  private fuseWait(stored: Stored, result: FuseCheck | FuseAdmission): boolean {
    const keeps = memberStateReasons.has(stored.run.reason ?? "");
    const fuse = applyFuseReason(keeps ? {} : stored.run, result);
    if (!keeps && fuse.changed) this.save(stored);
    return fuse.wait;
  }
  hasRecordFile(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return false;
    try {
      lstatSync(join(this.directory, `${id}.sealed`));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }
  private currentDate() { return new Date(this.options?.now?.() ?? Date.now()); }
  diagnostics(): TeamDiagnosticsSnapshot { return this.diag.snapshot(); }
  providerLimits() { return this.limits.active(this.currentDate()); }
  private confirmed(id: string): Promise<void> {
    const run = this.records.get(id)?.run;
    if (!this.linear || !run || !(run.linearTracking || run.linear)) return Promise.resolve();
    return this.linear.confirmTeam(id).then(() => undefined, () => undefined);
  }
  private enqueue<T>(runId: string, task: () => T | Promise<T>): Promise<T> { this.diag.idle.bump(); return this.queues.enqueue(runId, task); }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "team-not-found", "This team does not exist.");
    return stored;
  }
  private retentionNow() { return new Date(this.options?.now?.() ?? Date.now()).toISOString(); }
  private retentionState(stored: Stored) { return teamRetentionState(stored, () => this.retentionNow()); }
  private assertRunPath(stored: Stored, path: string, create = false) {
    const root = stored.root ?? this.config.teams?.workspaceDir;
    if (!root) throw new TeamError(409, "invalid-workspace", "The team workspace is outside its configured root.");
    if (!stored.anchor && root !== this.config.teams?.workspaceDir && !(stored.run.replay && root === this.replays.root()))
      throw new TeamError(409, "team-root-unsafe", "A team root outside the configured workspace directory requires a trusted anchor.");
    const canonical = stored.anchor ? ensureHostDirectory(stored.anchor, root, 0o750, create) : stored.run.replay ? this.replays.canonicalRoot() : ensureDefaultTeamRoot(root, create);
    assertTeamPath(canonical, path);
  }
  private canResume(stored: Stored, linearStatus = stored.run.linear?.status, allowRemovedWorkspace = false) {
    const run = stored.run;
    if (run.workspaceRemovedAt && !allowRemovedWorkspace) return false;
    const verificationRecovery = validVerificationRecovery(stored);
    return blockedTeamCanResume({
      status: run.status,
      reason: verificationRecovery ? verificationRecoveryReason : run.reason,
      pending: Boolean(stored.pending) && !verificationRecovery,
      deliveryAttempt: Boolean(stored.deliveryAttempt),
      deliveryReceipt: Boolean(run.deliveryReceipt),
      prepared: stored.prepared,
      stopReason: run.stopReason,
      linearStatus,
      verificationRecovery,
    });
  }
  private recoverLegacyBlocked(stored: Stored) {
    const run = stored.run, code = run.blockCode;
    if (run.status !== "blocked" || stored.run.recovery || !stored.prepared || stored.pending || stored.deliveryAttempt ||
        run.deliveryReceipt || deliveredAtRevision(run) || run.goal || run.missionId || run.handoff || run.stopReason || run.permissionsRevokedAt ||
        run.linearTracking && run.linear?.status !== "synced" ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "escalated", "uncertain"].includes(decision.status)) ||
        !code || !automaticRecoveryCodes.has(code)) return;
    if (code === "invalid-no-change" && (run.headCommit !== run.baseCommit || run.tasks.some(task => task.status === "integrated"))) return;
    const candidates = run.members.filter(member => member.revision === run.revision && member.status === "stopped" &&
      member.role !== "delivery" && member.role !== "permission-coordinator" && (
        code === "agent-blocked" ? member.report?.kind === "blocked" && member.report.summary === run.reason :
          code === "agent-question" ? member.report?.kind === "question" && agentQuestionReason(member.role, member.report) === run.reason :
            code === "missing-agent-report" ? member.report === undefined && run.reason === missingAgentReportReason :
              code === "invalid-no-change" ? member.role === "project-manager" && member.report?.kind === "no-change" && run.reason === invalidNoChangeReason :
                code === "wrong-agent-report" ? Boolean(member.report && !roleAcceptsReport(member.role, member.report.kind)) && run.reason === wrongAgentReportReason : false));
    if (candidates.length !== 1) return;
    const source = candidates[0]!;
    const reason = run.reason ?? "The recorded agent report requires a corrected plan.";
    run.recovery = { attempts: 1, status: "stopping", source: { code, memberId: source.memberId, revision: source.revision,
      ...(source.report ? { reportKind: source.report.kind } : {}), reason, at: timestamp() } };
    run.status = "planning"; stored.halt = "block";
    this.event(stored, `The project manager will diagnose the retained ${code} report from ${source.title} after confirming all members stopped.`);
    this.save(stored);
  }
  private canContinue(stored: Stored, linearStatus = stored.run.linear?.status, allowRemovedWorkspace = false) {
    const run = stored.run;
    if (!blockedTeamCanContinue(run, allowRemovedWorkspace) || !stored.prepared || stored.pending || this.commands.has(run.id) || stored.halt ||
        stored.deliveryAttempt || run.deliveryReceipt || run.stopReason || run.members.length >= 60 || run.members.some(member =>
          member.status !== "stopped" && !(member.role === "permission-coordinator" && member.status === "waiting")) ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) return false;
    if ((run.linearTracking || run.linear) && (!this.linear || linearStatus !== "synced")) return false;
    return true;
  }
  private permissionRecoveryHistory(run: TeamRun): TeamPermissionRecoveryView[] {
    const steps = (run.permissionRecovery?.steps ?? []).slice(-10);
    const relevantActions = new Set(steps.map(step => step.action.toLowerCase()));
    const stopWords = new Set(["about", "after", "before", "could", "from", "into", "needs", "permission", "prompt", "request", "same", "that", "this", "with"]);
    const tokens = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []).filter(word => !stopWords.has(word)));
    const causes = [run.reason, run.recovery?.source.reason, ...steps.map(step => step.cause)].filter((value): value is string => Boolean(value));
    const currentTokens = new Set(causes.flatMap(cause => [...tokens(cause)]));
    if (!relevantActions.size && !currentTokens.size) return [];
    return [...this.records.values()].filter(item => item.run.id !== run.id && item.run.projectId === run.projectId)
      .flatMap(item => (item.run.permissionRecovery?.outcomes ?? []).map(({ requestId: _requestId, ...outcome }) => outcome))
      .filter(outcome => relevantActions.has(outcome.action.toLowerCase()) || [...tokens(outcome.cause)].filter(token => currentTokens.has(token)).length >= 3)
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map(outcome => ({
        ...outcome, cause: boundedRecoveryText(outcome.cause), action: boundedRecoveryText(outcome.action),
        decision: boundedRecoveryText(outcome.decision), consequence: boundedRecoveryText(outcome.consequence),
      }));
  }
  private trackingHold(stored: Stored, tracking: TeamRun["linear"]) {
    const run = stored.run;
    if (!run.linearTracking || !tracking || (tracking.status !== "pending" && tracking.status !== "error") || run.reason || stored.halt
      || ["paused", "ready-for-review", "merged", "no-change", "blocked", "cancelled"].includes(run.status)) return false;
    return tracking.status === "error" || Boolean(tracking.retryAt) || Date.now() - Date.parse(tracking.checkedAt ?? run.createdAt) > 60000;
  }
  private view(stored: Stored): TeamView {
    const { members, permissionRecovery, replay, ...run } = structuredClone(stored.run);
    const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true, this.canResume(stored));
    run.linear = this.linear?.getTeam(run.id) ?? tracking ?? run.linear;
    const safeRun = {
      ...run, lastActivityAt: teamLastActivityAt(stored.run),
      checks: run.checks.map(({ scan: _scan, ...check }) => check),
      ...(this.trackingHold(stored, run.linear) ? { reason: `New work waits for Linear tracking: ${run.linear!.reason ?? "Linear has not confirmed current requirements."}` } : {}),
      resumable: this.canResume(stored, run.linear?.status),
      continuable: this.canContinue(stored, run.linear?.status),
      ...(run.permissionDecisions ? { permissionDecisions: run.permissionDecisions.map(({ prompt: _prompt, coordinatorSessionId: _sessionId, ...decision }) => decision) } : {}),
      ...(permissionRecovery ? { permissionRecovery: { outcomes: permissionRecovery.outcomes.slice(-10).map(({ requestId: _requestId, ...outcome }) => ({
        ...outcome, cause: boundedRecoveryText(outcome.cause), action: boundedRecoveryText(outcome.action),
        decision: boundedRecoveryText(outcome.decision), consequence: boundedRecoveryText(outcome.consequence),
      })) } } : {}),
    };
    const withUsage = teamUsage(members.map(({ prompt: _prompt, contextFeedback: _feedback, nativeSessionId: _nativeSessionId, goalCriteriaPlan: _goalCriteriaPlan,
      continuation: _continuation, turns: _turns, pendingFeedback: _pendingFeedback, ...member }) => member), run.provider, this.usage);
    const max = capacityCeiling(run);
    const ready = run.tasks.filter(task => task.status === "pending" && task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === "integrated")).length +
      (run.discovery && run.discovery.revision === run.revision && !run.discovery.completedAt ? run.discovery.tasks.filter(task => task.status === "pending").length : 0);
    const workers = { limit: run.parallelism, max, running: members.filter(member => holdsWorkerSlot(member, run.revision)).length, ready };
    const providerLimits = this.limits.active(this.currentDate());
    const waitReasons = describeTeamWaitReasons({ ...safeRun, members: withUsage.members }, providerLimits, this.currentDate().getTime());
    return { ...safeRun, ...(this.publisher.isPublicationPending(stored) ? { publishing: true } : {}), ...(stored.pending ? { pendingOperation: buildTeamPendingOperation({ id: stored.pending.id, kind: stored.pending.kind, revision: stored.pending.revision, failure: stored.pending.failure, source: stored.pending.source, census: stored.census?.pendingId === stored.pending.id ? stored.census : undefined }) } : {}), tasks: safeRun.tasks.map(task => {
      const revision = task.revision ?? safeRun.revision;
      const attempts = withUsage.members.filter(member => member.taskId === task.id && member.revision === revision);
      const usage = attempts.flatMap(member => member.usage?.messages ? [member.usage] : []);
      const coverage = combineCoverage(attempts.map(member => member.usage ?? { coverage: "none" as const }));
      return { ...task, revision, limitations: taskLimitations(task), ...(usage.length ? { usage: { usd: Math.round(usage.reduce((n, row) => n + row.cost, 0) * 1_000_000) / 1_000_000, unpriced: usage.reduce((n, row) => n + row.pricing.unknown, 0), tokens: usage.reduce((n, row) => n + Object.values(row.tokens).reduce((a, b) => a + b, 0), 0), attempts: attempts.length, profiles: [...new Set(attempts.map(member => member.modelProfile?.id).filter((id): id is string => Boolean(id)))].sort(), coverage: coverage.coverage as "partial" | "complete", ...(coverage.reason ? { coverageReason: coverage.reason } : {}) } } : {}) };
    }), members: withUsage.members, usage: withUsage.rollup, providerLimits, workers, waitReasons };
  }
  private save(stored: Stored) {
    const retention = this.retentionState(stored);
    if (retention.status !== stored.run.status) { retention.status = stored.run.status; retention.statusAt = this.retentionNow(); }
    if (this.options?.events) this.emitStatusEvents(stored, retention.statusAt);
    this.endPermissionTask(stored);
    this.objectiveTests.mark(stored);
    const wrote = this.activity.commit(stored, () => writeSealed(join(this.directory, `${stored.run.id}.sealed`), this.key, `team:${stored.run.id}`, stored), timestamp, this.records);
    if (this.options?.events && (wrote || stored.outbox?.length)) this.flushOutbox(stored);
    if (wrote || this.entryBacklog.has(stored.run.id) && this.options?.entries?.retryable()) this.mirrorEntries(stored.run);
  }
  private mirrorEntries(run: TeamRun) {
    const entries = this.options?.entries;
    if (!entries) return;
    if (entries.mirror(run)) this.entryBacklog.delete(run.id);
    else this.entryBacklog.add(run.id);
  }
  private drainEntries() {
    const entries = this.options?.entries;
    if (!entries || this.entryBacklog.size === 0) return;
    for (const id of [...this.entryBacklog].slice(0, ENTRY_DRAIN_RUNS)) {
      if (!entries.retryable()) return;
      this.entryBacklog.delete(id);
      if (!this.records.has(id)) continue;
      if (entries.held(id) || entries.unread(id)) { this.entryBacklog.add(id); continue; }
      const run = this.sealedRun(id);
      if (run === undefined) { entries.noteUnread(id); this.entryBacklog.add(id); continue; }
      if (entries.retry(run) !== "done") this.entryBacklog.add(id);
    }
  }
  private ingestGroups(): [string, string[]][] {
    const groups = new Map<string, string[]>();
    for (const { runId, memberId } of this.entryQueue.take(ENTRY_INGEST_MEMBERS)) groups.set(runId, [...(groups.get(runId) ?? []), memberId]);
    return [...groups.entries()];
  }
  private ingestRun(runId: string, memberIds: readonly string[]) {
    const entries = this.options?.entries;
    if (!entries || this.closed || this.retention.deletingRuns.has(runId)) return;
    const stored = this.records.get(runId);
    const result = ingestRunMemberEntries(this.entryQueue, stored?.run, memberIds, { events: (id, after, limit, types) => this.manager.events(id, after, limit, types), entries, kept: (run, member, posts) => this.objectiveTests.propose(run.id, member, posts) });
    if (!result || !stored) return;
    const newDrop = result.dropped > 0 && !stored.run.events.some(event => event.text === ENTRY_DROP_TEXT);
    if (newDrop) this.event(stored, ENTRY_DROP_TEXT);
    if (newDrop || result.advanced) this.save(stored);
  }
  ingestEntries() { if (this.options?.entries && this.entryQueue.size > 0) for (const [runId, memberIds] of this.ingestGroups()) this.ingestRun(runId, memberIds); }
  private async ingestEntriesAsync() { if (this.options?.entries && this.entryQueue.size > 0) await mapConcurrent(this.ingestGroups(), 16, ([runId, memberIds]) => this.enqueue(runId, () => { this.ingestRun(runId, memberIds); })); }
  private sealedRun(id: string): TeamRun | undefined {
    try { return unseal<Stored>(this.key, `team:${id}`, readFileSync(join(this.directory, `${id}.sealed`), "utf8")).run; }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.diag.warnUnexpected("sealed-run", error); return undefined; }
  }
  private emitStatusEvents(stored: Stored, statusAt: string) {
    const run = stored.run;
    if (stored.ledgerStatus !== run.status) {
      stored.ledgerStatus = run.status;
      if (run.status === "blocked") {
        this.emit(stored, "run.blocked", [run.revision, statusAt], {}, { code: run.blockCode, sourceMemberId: stored.ledgerBlockSource });
      } else if (["ready-for-review", "merged", "no-change", "cancelled"].includes(run.status)) {
        this.emit(stored, "run.settled", [run.revision, run.status, statusAt], {}, { status: run.status, summary: runSummaryCounts(run) });
      }
    }
    stored.ledgerBlockSource = undefined;
  }
  private emit(stored: Stored, kind: string, keyParts: readonly (string | number)[],
    ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void {
    try {
      if (!this.options?.events) return;
      const run = stored.run, key = runEventKey(kind, run.id, keyParts);
      const outbox = (stored.outbox ??= []);
      if (outbox.some(waiting => waiting.key === key)) return;
      const event: OutboxEvent = {
        key, runId: run.id, revision: ids.revision ?? run.revision, at: timestamp(), kind,
        ...(ids.memberId === undefined ? {} : { memberId: ids.memberId }),
        ...(ids.taskId === undefined ? {} : { taskId: ids.taskId }),
        data: { v: 1, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) },
      };
      const problem = eventProblem(event);
      if (problem !== undefined) { this.diag.warnDroppedEventKind(kind, problem); return; }
      if (outbox.length >= MAX_OUTBOX_EVENTS) {
        outbox.shift();
        stored.ledgerGap = { dropped: (stored.ledgerGap?.dropped ?? 0) + 1, firstAt: stored.ledgerGap?.firstAt ?? timestamp() };
      }
      outbox.push(event);
    } catch (error) { this.diag.warnUnexpected("emit", error); }
  }
  private emitWith(stored: Stored, kind: string, keyParts: readonly (string | number)[],
    ids: { memberId?: string; taskId?: string; revision?: number }, build: () => Record<string, unknown>): void {
    if (!this.options?.events) return;
    let data: Record<string, unknown>;
    try { data = build(); }
    catch { this.diag.warnUnbuiltEventKind(kind); return; }
    this.emit(stored, kind, keyParts, ids, data);
  }
  private captureIntegrated(stored: Stored, member: TeamMember, task: TeamTask, commit: string, head: string): void {
    try {
      if (!this.options?.capture?.enabled(stored.run.projectId)) return;
      this.options?.capture?.integrated(captureStart(stored.run, task, member, { commit, head, at: timestamp() }));
    } catch (error) { this.diag.warnUnexpected("capture-integrated", error); }
  }
  private captureApproved(stored: Stored, reviewedHead: string): void {
    try {
      if (!this.options?.capture?.enabled(stored.run.projectId)) return;
      this.options?.capture?.approved({ runId: stored.run.id, workspace: stored.run.workspace, anchorCommit: stored.run.baseCommit, reviewedHead, at: timestamp() });
    } catch (error) { this.diag.warnUnexpected("capture-approved", error); }
  }
  private linkReplacement(stored: Stored, next: TeamMember, previous: TeamMember, cause: ReplacementCause): void {
    if (previous.goalCriteriaPlan) next.goalCriteriaPlan = previous.goalCriteriaPlan;
    if (!this.options?.events) return;
    (stored.ledgerReplaces ??= {})[next.memberId] = { memberId: previous.memberId, cause };
  }
  private memberStopped(stored: Stored, member: TeamMember, reason: MemberStopReason, detail?: MemberStopDetail): void {
    if (member.role === "permission-coordinator") return;
    this.emitWith(stored, "member.stopped", [member.memberId],
      { memberId: member.memberId, taskId: member.taskId, revision: member.revision },
      () => ({ role: member.role, reason, ...(detail ? { detail } : {}), reported: Boolean(member.report) }));
  }
  private flushOutbox(stored: Stored, afterGap = false): boolean {
    const events = this.options?.events;
    if (!events) return true;
    try {
      if (stored.outbox?.length) {
        const result = events.flush(stored.outbox);
        if (!result.stored) return false;
        stored.outbox = [];
        if (result.refused > 0) stored.ledgerGap = { dropped: (stored.ledgerGap?.dropped ?? 0) + result.refused, firstAt: stored.ledgerGap?.firstAt ?? timestamp() };
      }
      const gap = stored.ledgerGap;
      if (!gap || afterGap) return !stored.outbox?.length;
      stored.ledgerGap = undefined;
      this.emit(stored, "ledger.gap", [gap.firstAt], {}, { dropped: gap.dropped });
      return this.flushOutbox(stored, true);
    } catch (error) { if (!isBenignOutboxError(error, this.closed)) this.diag.warnUnexpected("flush-outbox", error); return false; }
  }
  private async nameRequest(id: string, objective: string) {
    try {
      const title = (await this.titler!.requestTitle(objective))?.text;
      if (!title) return;
      await this.enqueue(id, () => {
        const stored = this.records.get(id), run = stored?.run;
        if (this.closed || !stored || !run || run.titleSource !== "request" || !["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering", "needs-input", "paused"].includes(run.status)) return;
        run.title = title;
        run.titleSource = "model";
        this.save(stored);
      });
    } catch (error) { if (!isBenignFenceError(error, this.closed)) this.diag.warnUnexpected("name-request", error); }
  }
  private event(stored: Stored, text: string) { runEvent(stored.run, text); }
  private async noteLeftover(stored: Stored, result: CommandResult) {
    if (result.leftover) await this.enqueue(stored.run.id, () => { if (!this.closed) { this.event(stored, commandLeftoverEvent); this.save(stored); } });
  }
  list(): TeamView[] { return [...this.records.values()].filter(stored => !stored.run.replay).map(record => this.view(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  listItems(): TeamListItem[] { return this.list().map(teamListItem); }
  understandingRecords() { return [...this.records.values()].filter(stored => !stored.run.replay).map(stored => structuredClone(stored.run)); }
  repairMetricsRuns(filter?: RepairRunFilter): RepairMetricsRun[] { return [...this.records.values()].flatMap(stored => runMayOverlapWindow(stored.run, filter) ? [snapshotRepairRun(stored.run)] : []); }
  pendingOperation(runId: string): boolean { return Boolean(this.records.get(runId)?.pending); }
  understandingOwnsSession(runId: string, memberId: string, sessionId: string, projectId: string): boolean {
    const stored = this.records.get(runId);
    return Boolean(stored && stored.run.projectId === projectId && stored.run.members.some(member =>
      member.memberId === memberId && member.sessionId === sessionId && member.runId === runId));
  }
  statuses() { return [...this.records.values()].filter(stored => !stored.run.replay).map(stored => ({ id: stored.run.id, title: stored.run.title, status: stored.run.status, reason: stored.run.reason, resumable: this.canResume(stored) && !stored.run.goal && !stored.run.missionId, goal: Boolean(stored.run.goal), mission: Boolean(stored.run.missionId) })); }
  decisionQueueCandidates() { return [...this.records.values()].flatMap(stored => {
    const run = stored.run, held = heldWaiting(stored), decisions = run.decisions.filter(item => item.revision === run.revision && !item.answer);
    return !run.replay && ((!stored.halt && run.status !== "paused") || held) && decisions.length
      ? [{ id: run.id, title: run.title, projectId: run.projectId, revision: run.revision, status: run.status, missionId: run.missionId,
        goal: Boolean(run.goal), held, decisions: structuredClone(decisions) }]
      : [];
  }); }
  decisionQueueSessionOrigin(runId: string, role: string) { const run = this.records.get(runId)?.run; return run && { id: run.id, title: run.title, role }; }
  promptOwner(sessionId: string, prompt: Prompt): "coordinator" | "user" | "undecided" {
    if (accountSettingPrompt(prompt)) return "user";
    for (const stored of this.records.values()) {
      const run = stored.run;
      const member = run.members.find(item => item.sessionId === sessionId && item.revision === run.revision);
      if (!member) continue;
      const activeRecovery = (run.permissionRecovery?.requests ?? []).find(item => item.targetSessionId === sessionId &&
        (item.promptId === prompt.id || item.status === "expanding" && item.expansion?.observedPromptId === undefined) &&
        item.revision === run.revision && livePermissionRecoveryStatuses.has(item.status));
      if (activeRecovery && run.permissions && !run.permissionsRevokedAt && !stored.halt && !["paused", "cancelled", "blocked"].includes(run.status)) return "coordinator";
      const decision = (run.permissionDecisions ?? []).filter(item => item.targetSessionId === sessionId && item.promptId === prompt.id &&
        (!prompt.hash || item.promptHash === prompt.hash)).at(-1);
      if (decision) return ["pending", "reviewing", "approved", "answering"].includes(decision.status) ? "coordinator" : "user";
      if (this.agentEligible(stored)) return "user";
      if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status) ||
          !activeMember(member) || member.role === "permission-coordinator" || !run.lineup ||
          !run.lineup.permissionReviewer && run.lineup.coordinator.tier !== "strong" ||
          permissionRequestCount(run) >= run.permissions.maxDecisions || !coordinatorPermissionPrompt(prompt))
        return "user";
      return "undecided";
    }
    return "user";
  }
  missionIdOf(id: string): string | undefined { return this.record(id).run.missionId; }
  goalIdOf(id: string): string | undefined { return this.records.get(id)?.run.goal?.id; }
  assessmentOf(id: string): Pick<TeamRun, "revision" | "assessment"> | undefined {
    const run = this.records.get(id)?.run;
    return run === undefined ? undefined : { revision: run.revision, assessment: run.assessment };
  }
  async settleReceipts(): Promise<string[]> {
    if (this.closed) return [];
    const ids = [...this.records.keys()];
    const settled = await mapConcurrent(ids, 16, id => this.enqueue(id, () => {
      const stored = this.records.get(id);
      if (!stored || this.closed) return false;
      try { return this.verdicts.settleReceipt(stored); } catch { return false; }
    }));
    return ids.filter((_, index) => settled[index]);
  }
  reviewedObservations(id: string) { return reviewedObservationsOf(this.records.get(id)); }
  hasDeliveryAttempt(id: string): boolean { return Boolean(this.records.get(id)?.deliveryAttempt); }
  ensureMissionCapacityCeiling(id: string, missionId: string, ceiling: number): number | undefined {
    if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 4)
      throw new TeamError(409, "team-parallelism-limit", "The assigned worker capacity ceiling must be between one and the host limit.");
    const stored = this.record(id), run = stored.run;
    if (run.missionId !== missionId) return undefined;
    if (["cancelled", "ready-for-review", "merged", "no-change"].includes(run.status)) return undefined;
    if (run.parallelismCeiling === ceiling && run.parallelism <= ceiling) return run.parallelism;
    const previousCeiling = run.parallelismCeiling;
    const previous = run.parallelism;
    run.parallelismCeiling = ceiling;
    if (run.parallelism > ceiling) run.parallelism = ceiling;
    this.event(stored, `Mission capacity was reconciled from ceiling ${previousCeiling ?? "unset"} to ${ceiling}; the worker limit is ${previous} to ${run.parallelism}.`);
    this.save(stored);
    return run.parallelism;
  }
  get(id: string): TeamView { return this.view(this.visible(id)); }
  missionProgressChild(teamId: string, missionId: string, projectId: string): MissionProgressChild {
    const run = this.records.get(teamId)?.run;
    return run && !run.replay && run.id === teamId ? projectMissionChild(run, missionId, projectId) : { kind: "missing" };
  }
  objectiveRecord(id: string, version?: number) { return runObjectiveView(this.visible(id), version); }
  private visible(id: string) { const stored = this.record(id); if (stored.run.replay) throw new TeamError(404, "team-not-found", "This team does not exist."); return stored; }
  private prefixFor(run: TeamRun) { return this.replays.prefixFor(run, this.config.teams?.commandPrefix); }
  createForReplay(input: ReplayCreate | JudgeCreate): Promise<{ runId: string }> { return this.enqueue(input.trialId, () => {
    const existing = this.records.get(input.trialId); if (existing) return { runId: existing.run.id };
    const stored: Stored = { run: this.replays.seed(input, timestamp()), fingerprint: digest(input), receipts: {}, prepared: true, root: this.replays.root() };
    this.records.set(stored.run.id, stored); this.replays.created(stored, input); this.save(stored); return { runId: stored.run.id }; }); }
  replayState(trialId: string): Promise<ReplayState | undefined> { return this.enqueue(trialId, () => this.replays.state(this.records.get(trialId))); }
  endReplay(trialId: string, ending: "timeout" | "void-owner" | "void-host"): Promise<void> { return this.enqueue(trialId, () => { const stored = this.records.get(trialId); if (stored?.run.replay) this.replays.end(stored, ending); }); }
  forgetReplay(trialId: string): Promise<boolean> { return this.enqueue(trialId, async () => { const stored = this.records.get(trialId); if (!stored) return true; if (!stored.run.replay || !this.replays.forgettable(stored)) return false; await this.retention.deleteRecord(stored, true); this.records.delete(trialId); return true; }); }
  replayIds(): string[] { return [...this.records.values()].filter(stored => stored.run.replay).map(stored => stored.run.id); }

  private retentionHost(): RetentionHost {
    const service = this;
    return {
      get records() { return service.records; },
      get commands() { return service.commands; },
      get manager() { return service.manager; },
      get config() { return service.config; },
      get closed() { return service.closed; },
      save: stored => service.save(stored),
      event: (stored, text) => service.event(stored, text),
      record: id => service.record(id),
      visible: id => service.visible(id),
      enqueue: (runId, task) => service.enqueue(runId, task),
      assertRunPath: (stored, path, create) => service.assertRunPath(stored, path, create),
      get options() { return service.options; },
      get directory() { return service.directory; },
      get recorders() { return service.recorders; },
      get entryBacklog() { return service.entryBacklog; },
      get entryQueue() { return service.entryQueue; },
      get evidence() { return service.evidence; },
      view: stored => service.view(stored),
      emit: (stored, kind, keyParts, ids, data) => service.emit(stored, kind, keyParts, ids, data),
      flushOutbox: (stored, afterGap) => service.flushOutbox(stored, afterGap),
      persistRetiredRunId: id => service.persistRetiredRunId(id),
      retentionNow: () => service.retentionNow(),
      retentionState: stored => service.retentionState(stored),
      publicationTarget: stored => service.publicationTarget(stored),
      needsPublication: stored => service.needsPublication(stored),
      startPublication: stored => service.startPublication(stored),
      refreshOperationCensus: (stored, force) => service.refreshOperationCensus(stored, force),
      closeStaleBlockedRun: (stored, hours) => service.closeStaleBlockedRun(stored, hours),
      onBackgroundTask: () => service.diag.idle.bump(),
    };
  }
  private get removingRuns() { return this.retention.removingRuns; }
  private get removalTasks() { return this.retention.removalTasks; }
  private get memberWorkSaveTasks() { return this.retention.memberWorkSaveTasks; }
  private get memberWorkSaveControllers() { return this.retention.memberWorkSaveControllers; }
  removeRun(id: string): Promise<TeamView> { return this.retention.removeRun(id); }
  private retire(...args: Parameters<TeamRetention["retire"]>) { return this.retention.retire(...args); }

  private publisherHost(): PublisherHost {
    const service = this;
    return {
      get records() { return service.records; },
      get config() { return service.config; },
      save: stored => service.save(stored),
      event: (stored, text) => service.event(stored, text),
      enqueue: (runId, task) => service.enqueue(runId, task),
      get options() { return service.options; },
      retentionNow: () => service.retentionNow(),
      onBackgroundTask: () => service.diag.idle.bump(),
    };
  }
  private get publicationTasks() { return this.publisher.publicationTasks; }
  private get publicationControllers() { return this.publisher.publicationControllers; }
  private publishHeadsEnabled(...args: Parameters<TeamPublisher["publishHeadsEnabled"]>) { return this.publisher.publishHeadsEnabled(...args); }
  private publicationTarget(...args: Parameters<TeamPublisher["publicationTarget"]>) { return this.publisher.publicationTarget(...args); }
  private needsPublication(...args: Parameters<TeamPublisher["needsPublication"]>) { return this.publisher.needsPublication(...args); }
  private publicationGate(...args: Parameters<TeamPublisher["publicationGate"]>) { return this.publisher.publicationGate(...args); }
  private startPublication(...args: Parameters<TeamPublisher["startPublication"]>) { return this.publisher.startPublication(...args); }
  private persistRetiredRunId(id: string) {
    const ids = [...this.retiredRunIds].filter(item => item !== id);
    ids.push(id);
    if (ids.length > 2000) ids.splice(0, ids.length - 2000);
    writeSealed(join(this.directory, "retired.sealed"), this.key, "team:retired", ids);
    this.retiredRunIds.clear();
    for (const item of ids) this.retiredRunIds.add(item);
  }
  rateTask(id: string, taskId: string, input: { requestId: string; score: number; note?: string }) {
    if (this.retention.deletingRuns.has(id)) throw new TeamError(404, "team-not-found", "This team does not exist.");
    const stored = this.visible(id), task = stored.run.tasks.find(item => item.id === taskId);
    if (!task) throw new TeamError(404, "task-not-found", "The team task was not found.");
    const fingerprint = digest({ taskId, score: input.score, ...(input.note ? { note: input.note } : {}) });
    const prior = stored.ratings?.[input.requestId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-id-reused", "This request ID was already used for a different task rating.");
      return task;
    }
    const rating = { score: input.score as 1 | 2 | 3 | 4 | 5, ...(input.note ? { note: input.note } : {}), at: timestamp() };
    task.ownerRating = rating;
    (stored.ratings ??= {})[input.requestId] = { fingerprint, result: rating };
    this.emitWith(stored, "rating.recorded", [input.requestId], { taskId, memberId: task.memberId, revision: task.revision }, () => ({ score: input.score }));
    this.event(stored, `The owner rated task ${taskId}.`); this.save(stored);
    return task;
  }
  async bundle(id: string) {
    const stored = this.visible(id), run = stored.run;
    if (run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
    if (run.status !== "ready-for-review") throw new TeamError(409, "team-not-ready", "This team is not ready to pull.");
    const { revision, headCommit, branch, workspace } = run;
    if (!headCommit) throw new TeamError(409, "team-no-result", "This team has no recorded result to pull.");
    this.assertRunPath(stored, workspace);
    const head = await teamCommand({ command: "git", args: teamGitArgs(workspace, ["rev-parse", "--verify", `refs/heads/${branch}`]) }, workspace, undefined, 30000, this.config.teams?.commandPrefix).catch(() => {
      throw new TeamError(409, "team-branch-changed", "The team's integration branch no longer matches its recorded result.");
    });
    if (run.status !== "ready-for-review" || run.revision !== revision || run.headCommit !== headCommit)
      throw new TeamError(409, "team-not-ready", "This team changed while its result was being prepared. Refresh team status and retry.");
    if (head.exitCode !== 0 || head.interrupted || head.truncated || head.stdout.trim() !== headCommit)
      throw new TeamError(409, "team-branch-changed", "The team's integration branch no longer matches its recorded result.");
    return { workspace, branch, head: headCommit };
  }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ run }) => !run.replay && run.projectId === projectId && activeTeamRun(run.status));
  }
  isActiveRun(id: string) { const stored = this.records.get(id); return Boolean(stored && activeTeamRun(stored.run.status)); }
  create(request: CreateTeam): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    return this.createRun(parsed);
  }
  createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false, autonomy: AutonomyMode = "supervised"): Promise<TeamView> {
    return this.createRun(createTeamSchema.parse(request), { goal: teamGoalContextSchema.parse(goal), lineup: teamLineupSchema.parse(lineup), autonomy }, linearTracking);
  }
  createForMission(request: CreateTeam, missionId: string, lineup: TeamLineup, options: { baseRunId?: string; parallelismCeiling?: number; linearTracking?: boolean; requestSource?: ConnectorSource } = {}): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    const project = this.config.projects.find(item => item.id === parsed.projectId);
    return this.createRun(parsed, { missionId, ...(options.requestSource ? { requestSource: structuredClone(options.requestSource) } : {}), ...(options.baseRunId ? { baseRunId: options.baseRunId } : {}), parallelismCeiling: options.parallelismCeiling ?? 4, lineup: teamLineupSchema.parse(lineup) }, options.linearTracking ?? Boolean(project?.linear));
  }
  assertHandoffPolicy(policy: HandoffPolicy) {
    const project = this.config.projects.find(item => item.id === policy.projectId);
    if (!project || JSON.stringify(withoutMainCheck(project.team)) !== JSON.stringify(withoutMainCheck(policy.project)) || JSON.stringify(project.linear) !== JSON.stringify(policy.linear) || realpathSync(project.path) !== policy.path || this.config.teams?.workspaceDir !== policy.workspaceDir || JSON.stringify(this.config.teams?.commandPrefix) !== JSON.stringify(policy.commandPrefix))
      throw new TeamError(409, "handoff-policy-changed", "Project authority changed after the source session started; inspect the checkpoint before creating a new team.");
    for (const selection of lineupProfiles(policy.lineup)) {
      const profile = this.config.agents[selection.provider];
      if (!profile || (/(^|\/)sudo$/.test(profile.command) && !policy.commandPrefix)) throw new TeamError(409, "handoff-provider-unavailable", "A snapshotted provider execution profile is unavailable.");
      teamModelLaunch(profile, selection);
    }
  }
  createForHandoff(request: CreateTeam, handoff: TeamHandoffContext, policy: HandoffPolicy): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    if (policy.sourceSessionId !== handoff.sourceSessionId || policy.projectId !== parsed.projectId || JSON.stringify(policy.project) !== JSON.stringify(handoff.project))
      throw new TeamError(409, "handoff-identity-mismatch", "The handoff policy, source, and team project must match before a team can start.");
    this.assertHandoffPolicy(policy);
    return this.createRun(parsed, { handoff, handoffPolicy: policy, lineup: policy.lineup }, Boolean(policy.linear));
  }
  private createRun(parsed: CreateTeam, internal?: { goal?: TeamGoalContext; missionId?: string; requestSource?: ConnectorSource; parallelismCeiling?: number; baseRunId?: string; handoff?: TeamHandoffContext; handoffPolicy?: HandoffPolicy; lineup: TeamLineup; autonomy?: AutonomyMode }, linearTracking = false): Promise<TeamView> {
    return this.pendingCreates.track(parsed.requestId, [parsed.projectId], this.enqueue(parsed.requestId, () => {
      const { useConfiguredLineup, ...singleProviderRequest } = parsed;
      const { parallelismCeiling: _ceiling, autonomy: _autonomy, ...creationContext } = internal ?? {};
      const prior = this.records.get(parsed.requestId), fingerprint = digest(internal ? { request: parsed, ...creationContext } : useConfiguredLineup ? parsed : singleProviderRequest);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team request.");
        if (internal?.missionId) this.ensureMissionCapacityCeiling(parsed.requestId, internal.missionId, internal.parallelismCeiling ?? 4);
        return this.view(prior);
      }
      return this.queues.enqueue(`project:${parsed.projectId}`, async () => {
        if (this.retiredRunIds.has(parsed.requestId))
          throw new TeamError(409, "team-deleted", "This request's run was deleted under the retention policy. Start a new run with a new request id.");
        const project = this.config.projects.find(item => item.id === parsed.projectId);
        if (!project) throw new TeamError(404, "unknown-project", "The selected project is not configured.");
        const reservedBy = this.missionReservations?.(parsed.projectId, internal?.missionId);
        if (reservedBy) throw new TeamError(409, "mission-repository-reserved", `Mission ${reservedBy} holds repository ${parsed.projectId} for an active subteam or pending launch.`);
        if (internal?.missionId && this.activeForProject(parsed.projectId))
          throw new TeamError(409, "project-team-active", `An active team run already holds repository ${parsed.projectId}; this mission subtask cannot start until it finishes or is cancelled.`);
        if (!this.config.teams || !project.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "teams-not-configured", "Configure a team workspace directory and required checks, or authorize the team to establish checks, before starting a team.");
        const goal = internal ? structuredClone(internal.goal) : undefined;
        const lineup = internal ? structuredClone(internal.lineup) : useConfiguredLineup ? structuredClone(this.config.teams.lineup) : undefined;
        if (useConfiguredLineup && !lineup) throw new TeamError(409, "team-lineup-not-configured", "The requested team lineup is not configured on this host.");
        if (lineup && parsed.provider !== lineup.coordinator.provider)
          throw new TeamError(409, "team-provider-mismatch", "The selected provider must match the configured coordinator provider.");
        const profiles = lineup ? lineupProfiles(lineup) : [];
        const providers = new Set(lineup ? profiles.map(profile => profile.provider) : [parsed.provider]);
        for (const provider of providers) {
          const profile = this.config.agents[provider];
          if (!profile || (provider === "demo" && !this.config.enableDemo)) throw new TeamError(409, "provider-not-configured", "Every selected team provider must be configured and available on this host.");
          if (/(^|\/)sudo$/.test(profile.command) && !this.config.teams.commandPrefix)
            throw new TeamError(409, "team-execution-identity-required", "Configure a team command prefix using the provider's execution identity before starting this team.");
        }
        for (const selection of profiles) {
          try { teamModelLaunch(this.config.agents[selection.provider]!, selection); }
          catch { throw new TeamError(409, "team-model-profile-conflict", "Move model, effort, and fallback-model arguments from provider profiles into the team lineup before starting this team."); }
        }
        if (project.team.permissions && (!lineup || !lineup.permissionReviewer && (lineup.coordinator.tier !== "strong" ||
            lineup.coordinator.limitFallback !== undefined && lineupProfiles(lineup).find(profile => profile.id === lineup.coordinator.limitFallback)?.tier !== "strong")))
          throw new TeamError(409, "permission-lineup-required", "Delegated permissions require a strong coordinator fallback unless a permission reviewer profile is configured.");
        const parentId = goal?.parentRunId ?? internal?.baseRunId;
        const parent = parentId ? this.record(parentId).run : undefined;
        if (parent?.workspaceRemovedAt || parent && this.removingRuns.has(parent.id))
          throw new TeamError(409, "team-workspace-removed", "This run's workspaces are being removed under the retention policy; start a new run.");
        if (parent && (goal
          ? parent.goal?.id !== goal.id || parent.projectId !== parsed.projectId || !["ready-for-review", "merged"].includes(parent.status) || !parent.headCommit
          : parent.projectId !== parsed.projectId || parent.missionId !== internal?.missionId || !["ready-for-review", "merged", "no-change"].includes(parent.status) || !parent.headCommit))
          throw new TeamError(409, goal ? "invalid-goal-parent" : "invalid-mission-base", goal ? "Continue only from a ready, recorded run of this goal and project." : "Continue only from a completed subtask in this mission and project with a recorded workspace head.");
        if (parent) this.assertRunPath(this.record(parent.id), parent.workspace);
        const source = { path: parent?.workspace ?? project.path, ...(parent ? { head: parent.headCommit!, ...(parent.status === "merged" ? { startCommit: parent.deliveryReceipt!.mergeCommit } : {}) } : internal?.handoff ? { head: internal.handoff.checkpointHead } : {}) };
        const githubProject = project.source?.mode === "github" || this.options?.source?.isGithub(project.id) === true;
        const parentRevision = parent?.revision;
        const at = timestamp();
        const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "team";
        const suffix = parsed.requestId.slice(0, 8);
        const directoryName = `${project.teamworkDir ? "" : `${project.id}-`}${at.slice(0, 10)}-${slug}-${suffix}`;
        const branch = `infinite/team-${slug}-${suffix}`;
        const root = project.teamworkDir ?? this.config.teams.workspaceDir;
        let samplePath = resolve(root);
        while (!existsSync(samplePath)) {
          const ancestor = dirname(samplePath);
          if (ancestor === samplePath) throw new TeamError(507, "host-storage-unavailable", "The host could not measure free space for the team workspace volume.");
          samplePath = ancestor;
        }
        let usage: VolumeUsage;
        try { usage = await (this.options?.volumeUsage ?? volumeUsage)(samplePath); }
        catch { throw new TeamError(507, "host-storage-unavailable", "The host could not measure free space for the team workspace volume."); }
        if (parent && (parent.workspaceRemovedAt || this.removingRuns.has(parent.id)))
          throw new TeamError(409, "team-workspace-removed", "This run's workspaces are being removed under the retention policy; start a new run.");
        const reason = storageShortfall(usage, this.config.teams.storageFloor ?? DEFAULT_STORAGE_FLOOR);
        if (reason) throw new TeamError(507, "host-storage-low", reason);
        const fallbackTitle = parsed.objective.trim().split("\n")[0]!.slice(0, 100).trim();
        const titleSource = !internal?.goal && !internal?.handoff && !internal?.missionId && parsed.title === fallbackTitle ? "request" as const : undefined;
        const ceiling = internal?.parallelismCeiling ?? (internal?.handoff ? 2 : 4);
        if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 4 || internal?.handoff && ceiling > 2)
          throw new TeamError(409, "team-parallelism-limit", "The assigned worker capacity ceiling must be between one and the host limit.");
        const initialParallelism = internal?.missionId ? parsed.parallelism : ceiling;
        if (initialParallelism > ceiling)
          throw new TeamError(409, "team-parallelism-limit", "The initial worker limit exceeds this run's capacity ceiling.");
        const run: TeamRun = { linearTracking: internal ? linearTracking : Boolean(project.linear), id: parsed.requestId, projectId: parsed.projectId, provider: parsed.provider, ...(lineup ? { lineup } : {}), ...(project.team.permissions ? { permissions: currentPermissions(structuredClone(project.team.permissions)), permissionDecisions: [] } : {}), ...(goal ? { goal } : {}), ...(internal?.missionId ? { missionId: internal.missionId } : {}), ...(internal?.requestSource ? { requestSource: internal.requestSource } : {}), ...(internal?.handoff ? { handoff: structuredClone(internal.handoff) } : {}), ...(titleSource ? { titleSource } : {}), title: parsed.title, objective: parsed.objective, parallelismCeiling: ceiling, parallelism: initialParallelism, revision: 1, status: "planning", createdAt: at, updatedAt: at, lastActivityAt: at, workspace: teamWorkspacePath(root, directoryName), branch, baseCommit: "", tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 0 };
        const start = startMode(project, lineup); run.autonomy = goal ? autonomyOf(internal) : start.mode;
        const routing = this.router?.pin(project.team.routing, run.autonomy, lineup, run.projectId);
        if (routing) run.routing = routing;
        run.intentCheck = intentCheckPin({ autonomy: run.autonomy, setting: project.team.objective?.intentCheck, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) });
        if (this.config.teams?.blackboard?.tools === true && this.options?.entries?.available()) run.blackboard = { tools: true };
        if (registerPin({ setting: project.team.objective?.register, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) })) run.register = "on";
        if (verdictPin({ evaluator: project.team.objective?.evaluator, register: project.team.objective?.register, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) })) run.verdicts = "on";
        if (project.team.delivery) {
          if (!lineup || lineup.coordinator.tier !== "strong" || lineup.reviewer.tier !== "strong")
            throw new TeamError(409, "delivery-lineup-required", "Automatic delivery requires a configured strong coordinator and independent strong reviewer.");
          run.delivery = structuredClone(project.team.delivery);
        }
        if (parent?.establishChecks || project.team.establishChecks) {
          run.establishChecks = true;
          if (parent?.verification) run.verification = structuredClone(parent.verification);
        }
        this.assertBudget(run);
        const anchor = project.teamworkDir ? realpathSync(this.config.sync?.homeDir ?? homedir()) : undefined;
        if (anchor) {
          assertTeamworkPath(this.config, root);
          ensureHostDirectory(anchor, root, 0o750);
        } else ensureDefaultTeamRoot(root, true);
        const stored: Stored = { run, fingerprint, receipts: {}, prepared: false, root, retention: { status: run.status, statusAt: at, integratedAt: {}, removalErrors: {} }, ...(anchor ? { anchor } : {}), source, ...(internal?.handoffPolicy ? { handoffPolicy: structuredClone(internal.handoffPolicy) } : {}) };
        this.records.set(run.id, stored); this.event(stored, "Team created; preparing an isolated copy of the configured project.");
        if (!goal && start.reason) this.event(stored, autonomyStartEvent("run", start.reason));
        this.emit(stored, "run.created", [], { revision: 1 }, { projectId: run.projectId, purpose: "work", goalId: goal?.id, goalCycle: goal?.cycle,
          missionId: internal?.missionId, handoff: Boolean(internal?.handoff), parentRunId: internal?.baseRunId, lineup: Boolean(lineup), deliveryMode: run.delivery?.mode });
        this.save(stored);
        if (run.titleSource === "request" && this.titler) void this.nameRequest(run.id, parsed.objective).catch(error => console.warn("Best-effort team naming failed.", error));
        this.operation(stored, "prepare", async signal => {
          const assertParent = () => {
            if (parent && (parent.workspaceRemovedAt || !["ready-for-review", "merged", "no-change"].includes(parent.status) || parent.revision !== parentRevision || parent.headCommit !== source.head))
              throw new TeamError(409, "parent-workspace-changed", "The predecessor run changed while its continuation was being prepared.");
          };
          assertParent();
          if (project.teamworkDir) assertTeamworkPath(this.config, root);
          this.assertRunPath(stored, teamWorkspacePath(root, directoryName), true);
          let workspaceSource = source;
          let fromMirror = false;
          if (githubProject && !parent && !internal?.handoff) {
            const projectSource = this.options?.source;
            if (!projectSource) throw new TeamError(409, "source-unavailable", "The host has no copy of this repository from GitHub yet; check the project's source status.");
            const status = await projectSource.refresh(project.id);
            if (!status.mirrorHead) throw new TeamError(409, "source-unavailable", "The host has no copy of this repository from GitHub yet; check the project's source status.");
            workspaceSource = { path: projectSource.mirrorPath(project.id), head: status.mirrorHead };
            fromMirror = true;
            if (status.pending?.reason === "fetch-failed") {
              const pendingCategory = status.pending.category;
              const category = pendingCategory === "auth" || pendingCategory === "network" || pendingCategory === "not-found" || pendingCategory === "other" ? pendingCategory : "other";
              run.baseStale = { ...(status.fetchedAt ? { fetchedAt: status.fetchedAt } : {}), reason: "fetch-failed", category };
              this.event(stored, "GitHub could not be reached; the run starts from the last fetched base.");
            }
          } else if (githubProject && parent && this.options?.source) {
            try { await this.options.source.refresh(project.id, { maxAgeMs: 60_000 }); }
            catch (error) { if (!isBenignSourceRefreshError(error, signal.aborted)) this.diag.warnUnexpected("source-refresh", error); }
            try {
              const mirrorHead = this.options.source.status(project.id).mirrorHead;
              if (mirrorHead && mirrorHead !== parent.headCommit) {
                const fetched = await teamCommand({ command: "git", args: teamGitArgs(source.path, ["fetch", "--no-tags", "--", this.options.source.mirrorPath(project.id), mirrorHead]) }, source.path, signal, 30000, this.config.teams?.commandPrefix);
                if (fetched.exitCode === 0 && !fetched.interrupted && !fetched.truncated) {
                  const ancestry = await teamCommand({ command: "git", args: teamGitArgs(source.path, ["merge-base", "--is-ancestor", parent.headCommit!, mirrorHead]) }, source.path, signal, 30000, this.config.teams?.commandPrefix);
                  if (ancestry.exitCode === 0 && !ancestry.interrupted && !ancestry.truncated) run.baseBehind = { mirrorHead };
                }
              }
            } catch (error) { if (!isBenignSourceRefreshError(error, signal.aborted) && (error as NodeJS.ErrnoException)?.code !== "ENOENT") this.diag.warnUnexpected("source-ancestry", error); }
          }
          const prepareWorkspace = async () => {
            assertParent();
            if (project.teamworkDir) assertTeamworkPath(this.config, root);
            this.assertRunPath(stored, teamWorkspacePath(root, directoryName), true);
            const workspace = fromMirror
              ? await prepareTeamWorkspaceFromMirror(workspaceSource.path, workspaceSource.head!, root, directoryName, branch, this.config.teams?.commandPrefix, signal, anchor)
              : await prepareTeamWorkspace(workspaceSource.path, root, directoryName, branch, this.config.teams?.commandPrefix, signal, workspaceSource.head, anchor, workspaceSource.startCommit);
            assertParent();
            if (project.team?.setup) {
              const setup = await teamCommand(project.team.setup, workspace.workspace, signal, 600000, this.config.teams?.commandPrefix);
              await this.noteLeftover(stored, setup);
              if (setup.exitCode !== 0 || setup.interrupted) throw new TeamError(409, "team-setup-failed", "The configured setup command failed. Inspect the isolated workspace before restarting.");
              await assertMemberReadOnly(workspace.workspace, workspace.baseCommit, this.config.teams?.commandPrefix, signal, "setup");
            }
            assertParent();
            if (workspaceSource.head && !fromMirror) await assertMemberReadOnly(workspaceSource.path, workspaceSource.head, this.config.teams?.commandPrefix, signal, "integration");
            return workspace;
          };
          return this.startInProject(run.projectId, prepareWorkspace);
        }, workspace => {
          Object.assign(run, workspace); run.headCommit = workspace.baseCommit; stored.prepared = true;
          stored.deliveryReviewLineage = internal?.handoff || (parent && parent.status !== "merged")
            ? inheritDeliveryReviewLineage(parent && this.record(parent.id).deliveryReviewLineage, workspace.baseCommit)
            : deliveryReviewLineageAtBase(workspace.baseCommit);
          this.emit(stored, "run.prepared", [], {}, { baseCommit: run.baseCommit }); this.event(stored, "Isolated project ready. Starting the project manager.");
        });
        return this.view(stored);
      });
    }));
  }
  private replay(stored: Stored, operation: string, body: Action | Mutation | TeamContinue | TeamParallelism | VerificationMutation) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== receiptDigest({ operation, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
    return true;
  }
  private mutation(stored: Stored, operation: string, body: Action | Mutation | TeamContinue | TeamParallelism | VerificationMutation) {
    const fingerprint = this.admit(stored, operation, body);
    if (fingerprint) this.recordReceipt(stored, body.requestId, fingerprint);
    return fingerprint !== undefined;
  }
  private admit(stored: Stored, operation: string, body: Action | Mutation | TeamContinue | TeamParallelism | VerificationMutation) {
    const fingerprint = receiptDigest({ operation, ...body });
    const prior = stored.receipts[body.requestId];
    if (prior) {
      if (prior !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
      return undefined;
    }
    if (body.revision !== stored.run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
    if (stored.run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
    return fingerprint;
  }
  private recordReceipt(stored: Stored, requestId: string, fingerprint: string) {
    stored.receipts[requestId] = fingerprint;
    stored.ownerHalt = undefined;
  }
  steer(id: string, input: Mutation, source?: SteeringSource) {
    const body = { ...teamMutationSchema.parse(input), ...(source === undefined ? {} : { source }) };
    return this.enqueue(id, async () => {
      const stored = this.record(id);
      if (this.replay(stored, "steer", body)) return this.view(stored);
      if (stored.deliveryAttempt || stored.run.deliveryReceipt) throw new TeamError(409, "delivery-reconciliation-required", "Inspect the recorded pull request before starting another run; steering cannot replay a started delivery.");
      if (stored.pending && !this.commands.has(id)) throw new TeamError(409, "team-reconciliation-required", "This team has an unresolved workspace or verification operation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (stored.pending && stored.pending.kind !== "check") throw new TeamError(409, "team-operation-running", "A workspace operation is in progress. Retry steering after it settles.");
      if (stored.run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (Buffer.byteLength(stored.run.steering.map(item => item.text).join("")) + Buffer.byteLength(body.text) > 32 * 1024) throw new TeamError(409, "team-steering-limit", "This team reached its 32 KiB steering limit. Start a new team with consolidated requirements.");
      if (stored.run.steering.length >= 20) throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team from the reviewed integration branch.");
      const receipt = this.admit(stored, "steer", body);
      if (!receipt) return this.view(stored);
      if (stored.run.pullRequest && !pullRequestBranch(stored.run)) await this.reviewFeedback.resolveLegacyPullRequestBranch(stored);
      this.commands.get(id)?.abort();
      await this.invalidatePermissionDecisions(stored, "A steer started before the permission request could be answered.");
      this.recordReceipt(stored, body.requestId, receipt);
      if (stored.run.recovery && stored.run.recovery.status !== "exhausted") {
        stored.run.recovery.status = "exhausted";
        this.event(stored, `${source ? inputSourceLabel(source) : "User"} steering superseded automatic recovery; its original report remains recorded as evidence.`);
      }
      if (stored.run.pullRequest && stored.run.deliveryRecovery) { stored.run.deliveryRecoveryAttempts = recoveriesUsed(stored.run); delete stored.run.deliveryRecovery; }
      stored.run.revision++; stored.run.steering.push({ text: body.text, revision: stored.run.revision, at: timestamp(), ...(source ? { source } : {}) });
      const objectiveNote = runObjectiveNote(stored, steerRunObjective(stored, body.requestId, timestamp())); if (objectiveNote) this.event(stored, objectiveNote);
      this.emit(stored, "run.revision-advanced", [stored.run.revision], {}, { cause: "steer", fromRevision: stored.run.revision - 1, baseChanged: false });
      stored.run.status = "planning"; stored.halt = "steer"; stored.run.reason = "Stopping earlier members before planning the updated request."; stored.run.blockCode = undefined;
      stored.run.tasks = []; stored.run.review = undefined; stored.run.round = 0; stored.checkHead = undefined;
      stored.run.brief = undefined; stored.run.noChange = undefined;
      if (stored.run.discovery && !stored.run.discovery.completedAt) stored.run.discovery.completedAt = timestamp();
      this.event(stored, `${source ? inputSourceLabel(source) : "User"} steering recorded. Earlier reports cannot satisfy the new revision.`); this.save(stored);
      return this.view(stored);
    });
  }

  private recoveryHost(): RecoveryHost {
    const service = this;
    return {
      get commands() { return service.commands; }, get config() { return service.config; },
      save: stored => service.save(stored), event: (stored, text) => service.event(stored, text),
      record: id => service.record(id), enqueue: (runId, task) => service.enqueue(runId, task),
      assertRunPath: (stored, path, create) => service.assertRunPath(stored, path, create),
      assertBudget: (run, addingMember) => service.assertBudget(run, addingMember),
      block: (stored, error, sourceMember) => service.block(stored, error, sourceMember),
      get linear() { return service.linear; }, get removingRuns() { return service.removingRuns; },
      confirmed: id => service.confirmed(id), replay: (stored, operation, body) => service.replay(stored, operation, body),
      mutation: (stored, operation, body) => service.mutation(stored, operation, body), view: stored => service.view(stored),
      emit: (stored, kind, keyParts, ids, data) => service.emit(stored, kind, keyParts, ids, data),
      assertDelivery: stored => service.assertDelivery(stored),
      prepareMember: (stored, role, task, feedback, onPrepared) => service.prepareMember(stored, role, task, feedback, onPrepared),
      refreshOperationCensus: (stored, force) => service.refreshOperationCensus(stored, force),
      verificationCommands: run => service.verificationCommands(run),
      canContinue: (stored, linearStatus, allowRemovedWorkspace) => service.canContinue(stored, linearStatus, allowRemovedWorkspace),
      canResume: (stored, linearStatus, allowRemovedWorkspace) => service.canResume(stored, linearStatus, allowRemovedWorkspace),
      invalidatePermissionDecisions: (stored, reason, fenceAgent) => service.invalidatePermissionDecisions(stored, reason, fenceAgent),
      stopObsoletePermissionCoordinators: stored => service.stopObsoletePermissionCoordinators(stored),
      trackBlocked: stored => service.trackBlocked(stored), needsPublication: stored => service.needsPublication(stored),
      startPublication: stored => service.startPublication(stored), publicationGate: (stored, role) => service.publicationGate(stored, role),
    };
  }
  reconcileDelivery(id: string, input: TeamDeliveryReconcile): Promise<TeamView> { return this.recovery.reconcileDelivery(id, input); }
  reconcileVerification(id: string, input: VerificationMutation): Promise<TeamView> { return this.recovery.reconcileVerification(id, input); }
  continueRun(id: string, input: TeamContinue): Promise<TeamView> { return this.recovery.continueRun(id, input); }
  private resumeVerificationRecovery(...args: Parameters<TeamRecovery["resumeVerificationRecovery"]>) { return this.recovery.resumeVerificationRecovery(...args); }
  private queueAutomaticDeliveryRecovery(...args: Parameters<TeamRecovery["queueAutomaticDeliveryRecovery"]>) { return this.recovery.queueAutomaticDeliveryRecovery(...args); }
  private admitBlockedDeliveryRecovery(...args: Parameters<TeamRecovery["admitBlockedDeliveryRecovery"]>) { return this.recovery.admitBlockedDeliveryRecovery(...args); }
  private startAutomaticRecovery(...args: Parameters<TeamRecovery["startAutomaticRecovery"]>) { return this.recovery.startAutomaticRecovery(...args); }
  private queueDeliveryRetryAfterEvidence(...args: Parameters<TeamRecovery["queueDeliveryRetryAfterEvidence"]>) { return this.recovery.queueDeliveryRetryAfterEvidence(...args); }
  inspectMemberRuntime(id: string, memberId: string) {
    const stored = this.record(id), run = stored.run;
    const member = run.members.find(item => item.memberId === memberId && item.revision === run.revision);
    if (!member) throw new TeamError(404, "member-not-found", "The current team revision has no such member.");
    return this.manager.inspectTeamRuntime(member.sessionId, assignment(member));
  }
  retireMember(id: string, memberId: string, input: TeamMemberRetire) {
    const body = teamMemberRetireSchema.parse(input);
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "retire-member", body)) return this.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before retiring a member.");
      const member = run.members.find(item => item.memberId === memberId && item.revision === run.revision);
      const unavailable = () => new TeamError(409, "member-retirement-unavailable", "Only an unreported current reviewer at the verified head can be retired under an unchanged, quiescent team state.");
      if (run.status === "cancelled" || run.status === "paused" || stored.halt || !member || member.role !== "reviewer" || member.report ||
          !["unavailable", "running"].includes(member.status) || member.sessionId !== body.sessionId || member.baseCommit !== run.headCommit ||
          member.baseCommit !== stored.checkHead || stored.pending || this.commands.has(id) || stored.deliveryAttempt || run.deliveryReceipt ||
          deliveredAtRevision(run) || run.stopReason || (run.permissionDecisions ?? []).some(decision => decision.targetSessionId === body.sessionId &&
            ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) throw unavailable();
      this.assertBudget(run, true);
      const revision = run.revision, sessionId = member.sessionId, baseCommit = member.baseCommit;
      const retired = await this.manager.retireTeamRuntime(sessionId, body.requestId, assignment(member), body.identity);
      if (run.revision !== revision || !run.members.includes(member) || member.sessionId !== sessionId || member.baseCommit !== baseCommit)
        throw new TeamError(409, "member-retirement-unavailable", "The reviewer assignment changed while its runtime was being retired.");
      const retirement = { requestId: body.requestId, at: retired.stoppedAt, identity: retired.identity, seq: retired.seq,
        processes: retired.processes.length, unsignalable: retired.unsignalable.length };
      try { await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix); }
      catch (error) {
        if (!this.mutation(stored, "retire-member", body)) return this.view(stored);
        member.status = "stopped"; member.stoppedReason = "Recording failed; runtime retired after confirmed process exit"; member.retirement = retirement;
        this.memberStopped(stored, member, "host", "retired");
        this.block(stored, error, member);
        return this.view(stored);
      }
      if (!this.mutation(stored, "retire-member", body)) return this.view(stored);
      member.status = "stopped"; member.stoppedReason = "Recording failed; runtime retired after confirmed process exit"; member.retirement = retirement;
      this.memberStopped(stored, member, "host", "retired");
      if (run.reason === runtimeUnavailableReason) run.reason = undefined;
      this.event(stored, `The owner authorized retirement of reviewer ${member.memberId} at ${member.baseCommit}. Operator claim, not host-verified: ${JSON.stringify(body.text.slice(0, 500))}. The original journal and reports are retained.`);
      this.save(stored);
      return this.view(stored);
    });
  }
  setParallelism(id: string, input: TeamParallelism) {
    teamParallelismSchema.parse(input);
    this.record(id);
    return Promise.reject(new TeamError(409, "agent-managed-capacity", "Worker capacity is agent-managed. The project manager or mission coordinator selects the worker limit."));
  }
  setMissionParallelism(id: string, input: TeamParallelism) {
    const body = teamParallelismSchema.parse(input);
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "mission-parallelism", body)) return this.view(stored);
      if (!run.missionId) throw new TeamError(409, "agent-managed-capacity", "Mission capacity changes must target a mission subteam.");
      if (["cancelled", "ready-for-review", "merged", "no-change"].includes(run.status))
        throw new TeamError(409, "team-not-running", "The mission subteam has already finished.");
      if (body.parallelism > capacityCeiling(run))
        throw new TeamError(409, "team-parallelism-limit", `This subteam supports at most ${capacityCeiling(run)} workers.`);
      if (!this.mutation(stored, "mission-parallelism", body)) return this.view(stored);
      const previous = run.parallelism;
      run.parallelism = body.parallelism;
      this.event(stored, `The mission coordinator set the worker limit from ${previous} to ${body.parallelism} (capacity ceiling ${capacityCeiling(run)}).`);
      this.save(stored);
      return this.view(stored);
    });
  }
  answer(id: string, decisionId: string, input: Mutation, authorizeNewAnswer?: (held: boolean) => void, by: "owner" | "coordinator" | "connector" = "owner", source?: ConnectorSource) {
    const body = { ...teamMutationSchema.parse(input), ...(by === "owner" && !source ? {} : { by, ...(source ? { source } : {}) }) };
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, `answer:${decisionId}`, body)) return this.view(stored);
      authorizeNewAnswer?.(heldWaiting(stored));
      const decision = run.decisions.find(item => item.id === decisionId && item.revision === run.revision);
      if (!decision) throw new TeamError(404, "decision-not-found", "This decision is no longer current.");
      if (stored.receipts[body.requestId]) { this.mutation(stored, `answer:${decisionId}`, body); return this.view(stored); }
      if (decision.answer) throw new TeamError(409, "decision-answered", "This decision already has an answer.");
      const held = heldWaiting(stored), mark = stored.ownerHalt;
      if (!held && (stored.halt || run.status === "paused")) throw new TeamError(409, "team-paused", "Resume the team before answering its decision.");
      if (!this.mutation(stored, `answer:${decisionId}`, body)) return this.view(stored);
      if (held) stored.ownerHalt = mark;
      decision.answer = body.text; decision.answeredBy = by; decision.answeredAt = timestamp();
      if (decision.recommendation) decision.recommendation.outcome = recommendationOutcome(decision.options, decision.recommendation, body.text);
      if (source) decision.source = source;
      const next = this.intentChecks.answerNote(stored, decision) ?? (held ? "The requesting member will continue in a new attempt when the team resumes." : "The requesting member will continue in a new attempt.");
      this.event(stored, by === "connector" ? `${decisionAnswerLabel(decision)} decision was recorded as delegated agent input. ${next}` : by === "coordinator" ? `A mission coordinator decision was recorded. ${next}` : `A user decision was recorded. ${next}`); this.save(stored);
      if (by === "owner" && (run.permissionDecisions ?? []).some(item => ["pending", "reviewing", "approved", "answering"].includes(item.status)))
        await this.invalidatePermissionDecisions(stored, "The owner answered a team question; a request reviewed before that answer remains with the user.", false);
      return this.view(stored);
    });
  }
  revokePermissions(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.enqueue(id, async () => {
      const stored = this.visible(id), run = stored.run;
      if (this.replay(stored, "revoke-permissions", body)) return this.view(stored);
      if (!run.permissions && !run.permissionsRevokedAt && !this.agentEligible(stored) && !run.permissionAgentDecisions?.length)
        throw new TeamError(409, "permissions-not-enabled", "This team has no delegated permission policy to revoke.");
      const receipt = this.admit(stored, "revoke-permissions", body);
      if (!receipt) return this.view(stored);
      run.permissionsRevokedAt ??= timestamp();
      await this.invalidatePermissionDecisions(stored, "The owner revoked delegated permission decisions.");
      this.recordReceipt(stored, body.requestId, receipt);
      this.event(stored, "Delegated permission decisions were revoked by the owner.");
      this.save(stored);
      return this.view(stored);
    });
  }
  revokeRouting(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (run.routing?.mode !== "auto") throw new TeamError(409, "routing-not-enabled", "This team does not choose worker profiles automatically.");
      if (this.replay(stored, "revoke-routing", body) || !this.mutation(stored, "revoke-routing", body)) return this.view(stored);
      run.routingRevokedAt ??= timestamp();
      this.event(stored, "Host profile routing was revoked by the owner; new tasks start on the coordinator's pick when it passes the fixed rules, else on the first implementer that passes them." + (coversPoint(run, "escalation") || coversPoint(run, "scout") ? " Escalations and scouts use the profile their member names, else the first that passes the fixed rules." : ""));
      this.save(stored); return this.view(stored);
    });
  }
  private async invalidatePermissionDecisions(stored: Stored, reason: string, fenceAgent = true): Promise<boolean> {
    if (fenceAgent && !await this.fenceAgentDeliveries(stored.run.id))
      this.event(stored, "An in-flight permission agent answer could not be conclusively fenced. Inspect the member session before acting.");
    const inFlight: TeamPermissionDecision[] = [];
    for (const decision of stored.run.permissionDecisions ?? []) if (["pending", "reviewing", "approved", "answering"].includes(decision.status)) {
      if (decision.status === "answering") { decision.status = "uncertain"; inFlight.push(decision); }
      else decision.status = "stale";
      decision.reason = reason;
      this.finishLinkedPermissionRecovery(stored, decision, reason, "invalidate-review", decision.status === "uncertain" ? "answer-state-uncertain" : "stop-review",
        decision.status === "uncertain" ? "Inspect the target session before any further action." : "No provider answer was sent; execution is unknown.");
    }
    if (inFlight.length) this.save(stored);
    let uncertain = false;
    for (const decision of inFlight) {
      let fence: "invalidated" | "uncertain" = "uncertain";
      try { fence = await this.manager.invalidateTeamPermission(decision.targetSessionId, decision.id); }
      catch (error) { if (!isBenignFenceError(error, this.closed)) this.diag.warnUnexpected("permission-fence", error); }
      if (fence !== "invalidated") {
        uncertain = true;
        stored.unfencedAnswers = [...new Set([...(stored.unfencedAnswers ?? []), decision.id])];
      } else this.settleAnswerMark(stored, decision.id);
    }
    if (uncertain) this.event(stored, "An in-flight delegated permission answer could not be conclusively fenced. Its decision remains uncertain; inspect the target session.");
    this.save(stored);
    return !uncertain;
  }
  private async refenceCoordinatorAnswers(stored: Stored): Promise<boolean> {
    const open = stored.unfencedAnswers ?? [];
    if (open.length === 0) return true;
    const left: string[] = [];
    for (const decisionId of open) {
      const decision = stored.run.permissionDecisions?.find(item => item.id === decisionId);
      if (!decision) continue;
      let settled = false;
      try { settled = (await this.manager.state(decision.targetSessionId)).status === "exited"; }
      catch (error) { if (!isBenignFenceError(error, this.closed)) this.diag.warnUnexpected("permission-refence-state", error); settled = false; }
      if (!settled) {
        try { settled = await this.manager.invalidateTeamPermission(decision.targetSessionId, decision.id) === "invalidated"; }
        catch (error) { if (!isBenignFenceError(error, this.closed)) this.diag.warnUnexpected("permission-refence", error); settled = false; }
      }
      if (!settled) left.push(decisionId);
    }
    if (left.length !== open.length) {
      if (left.length) stored.unfencedAnswers = left; else delete stored.unfencedAnswers;
      this.save(stored);
    }
    return left.length === 0;
  }
  private settleAnswerMark(stored: Stored, decisionId: string) {
    const left = (stored.unfencedAnswers ?? []).filter(id => id !== decisionId);
    if (left.length) stored.unfencedAnswers = left; else delete stored.unfencedAnswers;
  }
  pause(id: string, input: Action, source?: ConnectorSource) { return this.action(id, "pause", { ...teamActionSchema.parse(input), ...(source ? { source } : {}) }); }
  resume(id: string, input: Action, source?: ConnectorSource) { const body = { ...teamActionSchema.parse(input), ...(source ? { source } : {}) }; return this.confirmed(id).then(() => this.action(id, "resume", body)); }
  cancel(id: string, input: Action, source?: ConnectorSource) { return this.action(id, "cancel", { ...teamActionSchema.parse(input), ...(source ? { source } : {}) }); }
  private async closeStaleBlockedRun(stored: Stored, hours: number) {
    const { run } = stored;
    if (run.status !== "blocked" || !run.workspaceRemovedAt || filesystemEntryExists(teamRunDirectory(run.workspace))) return;
    const reason = hostClosedBlockedReason(hours, run.reason);
    if (run.recovery && run.recovery.status !== "exhausted") {
      run.recovery.status = "exhausted";
      run.recovery.source = { ...run.recovery.source, code: "host-closed-blocked", reason };
    }
    run.status = "cancelled"; stored.halt = "cancel"; run.reason = reason;
    stored.ledgerStatus = "cancelled";
    this.event(stored, reason); this.save(stored);
    this.commands.get(run.id)?.abort();
    await this.invalidatePermissionDecisions(stored, "The host closed the blocked team before the permission request could be answered.");
  }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action & { source?: ConnectorSource }) {
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, action, body)) return this.view(stored);
      if (action === "resume" && (run.linearTracking || run.linear)) {
        const tracking = this.linear?.getTeam(run.id, true) ?? run.linear;
        if (tracking && JSON.stringify(run.linear) !== JSON.stringify(tracking)) { run.linear = tracking; this.save(stored); }
      }
      if (action === "pause" && (["ready-for-review", "merged", "no-change"].includes(run.status) || run.status === "blocked" && !run.workspaceRemovedAt)) throw new TeamError(409, "team-not-running", "This team is not running and cannot be paused.");
      const verificationRecovery = action === "resume" && validVerificationRecovery(stored) ? stored.verificationRecovery : undefined;
      if (action === "resume") { const refusal = this.resumeRefusal(stored, verificationRecovery); if (refusal) throw refusal; }
      if (action === "resume" && verificationRecovery) return this.resumeVerificationRecovery(stored, body, verificationRecovery);
      const inPlace = heldWaiting(stored);
      const receipt = this.admit(stored, action, body);
      if (!receipt) return this.view(stored);
      const record = () => this.recordReceipt(stored, body.requestId, receipt);
      if (action === "resume") {
        if (run.status !== "paused" && !this.canResume(stored)) { record(); this.save(stored); return this.view(stored); }
        await this.resumeRun(stored, inPlace, record);
        this.event(stored, `Team ${inPlace ? "resumed where it waited for input" : "resumed with a fresh plan"}${body.source ? ` by ${inputSourceLabel(body.source)}` : ""}.`); this.save(stored);
      } else { record(); await this.stopRun(stored, action, undefined, body.source, `Team ${action === "pause" ? "paused" : "cancelled"}${body.source ? ` by ${inputSourceLabel(body.source)}` : ""}.`); }
      return this.view(stored);
    });
  }
  private resumeRefusal(stored: Stored, verificationRecovery: Stored["verificationRecovery"]): TeamError | undefined {
    const run = stored.run;
    if (heldWaiting(stored)) {
      if (run.workspaceRemovedAt) return new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (stored.pending || !stored.prepared)
        return new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (stored.halt) return new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
      return undefined;
    }
    if ((stored.pending && !verificationRecovery) || stored.deliveryAttempt || run.deliveryReceipt)
      return new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
    if (run.workspaceRemovedAt) return new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
    if (!stored.prepared || (run.status === "blocked" && !this.canResume(stored, undefined, true)))
      return new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
    if (verificationRecovery && this.commands.has(run.id)) return new TeamError(409, "team-operation-running", "The verification operation is still stopping. Retry Resume after it settles.");
    if (stored.halt) return new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
    return undefined;
  }
  private async resumeRun(stored: Stored, inPlace = false, record?: () => void) {
    const run = stored.run;
    if (!inPlace) await this.invalidatePermissionDecisions(stored, "A resume started before the permission request could be answered.");
    record?.();
    if (inPlace) { run.status = "needs-input"; run.reason = undefined; return; }
    run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
    this.emit(stored, "run.revision-advanced", [run.revision], {}, { cause: "resume", fromRevision: run.revision - 1, baseChanged: false });
    run.brief = undefined; run.noChange = undefined;
    if (run.discovery && !run.discovery.completedAt) run.discovery.completedAt = timestamp();
    run.status = "planning"; run.reason = undefined; run.blockCode = undefined;
  }
  private async stopRun(stored: Stored, action: "pause" | "cancel", ownerHalt?: Stored["ownerHalt"], source?: ConnectorSource, line?: string, reason = "Stopping active team members; any human input lease remains authoritative.") {
    const run = stored.run;
    if (run.recovery && run.recovery.status !== "exhausted") {
      run.recovery.status = "exhausted";
      run.recovery.source = { ...run.recovery.source, code: `${source ? "connector" : "owner"}-${action}`, reason: `${source ? inputSourceLabel(source) : "The owner"} requested ${action} before automatic recovery finished.` };
    }
    run.status = action === "pause" ? "paused" : "cancelled"; stored.halt = action;
    if (ownerHalt) stored.ownerHalt = ownerHalt;
    run.reason = reason;
    if (line) this.event(stored, line);
    if (action === "cancel") this.intentChecks.release(stored, "cancelled");
    await this.invalidatePermissionDecisions(stored, `The team was ${action === "pause" ? "paused" : "cancelled"} before the permission request could be answered.`);
    this.commands.get(run.id)?.abort();
  }
  private waitsWithNothingInFlight(stored: Stored) {
    const run = stored.run;
    const unlaunched = (member: TeamMember) => { try { return member.status === "queued" && !this.hasLaunch(member); } catch { return false; } };
    return run.status === "needs-input" && !stored.halt && !stored.pending && !this.commands.has(run.id) &&
      !run.members.some(member => activeMember(member) && member.role !== "permission-coordinator" && !unlaunched(member));
  }
  private async haltStop(stored: Stored, mark: { haltId: string; reason: string }) {
    const run = stored.run;
    if (this.waitsWithNothingInFlight(stored)) {
      run.status = "paused"; run.reason = mark.reason; stored.ownerHalt = { ...mark, waiting: true };
      this.event(stored, `Team paused where it waits for input: ${mark.reason} Its questions stay open; an answer is kept until it resumes.`);
      await this.invalidatePermissionDecisions(stored, "The team was paused before the permission request could be answered.");
    } else {
      await this.stopRun(stored, "pause", mark, undefined, `Team paused: ${mark.reason}`, mark.reason);
    }
    this.save(stored);
  }
  private releasedMark(stored: Stored, reason: string): NonNullable<Stored["ownerHalt"]> {
    return { reason, ...(stored.ownerHalt?.waiting ? { waiting: true as const } : {}) };
  }
  private async haltResumeRun(stored: Stored) {
    const inPlace = heldWaiting(stored);
    await this.resumeRun(stored, inPlace);
    stored.ownerHalt = undefined;
    this.event(stored, inPlace ? "Team resumed where it waited for input: the owner released the halt." : "Team resumed with a fresh plan: the owner released the halt.");
    this.save(stored);
  }
  haltPause(mark: HaltMark, covers: HaltCovers): Promise<HaltOutcome[]> {
    const task: Promise<HaltOutcome[]> = pauseWithPendingCreates<HaltOutcome>(this.pendingCreates, this.records, covers, id => this.enqueue(id, async () => {
      const stored = this.records.get(id);
      if (!stored) return undefined;
      const run = stored.run;
      if (!HALT_PAUSED_TEAM.has(run.status) || !covers([run.projectId], run.id)) return undefined;
      try {
        await this.haltStop(stored, { haltId: mark.haltId, reason: mark.reason });
        return { kind: "team", id: run.id, title: run.title, result: "paused" } satisfies HaltOutcome;
      } catch (error) { return pauseFailure("team", run.id, run.title, error); }
    })).finally(() => { this.activeTicks.delete(task); });
    this.activeTicks.add(task);
    return task;
  }
  async haltResume(haltId: string, heldBy: HaltHeldBy, keep: boolean): Promise<HaltOutcome[]> {
    const ids = [...this.records.keys()];
    const outcomes = await Promise.all(ids.map(id => this.enqueue<HaltOutcome | undefined>(id, async () => {
      const stored = this.records.get(id);
      if (!stored || stored.ownerHalt?.haltId !== haltId) return undefined;
      const run = stored.run, base = { kind: "team" as const, id: run.id, title: run.title };
      try {
        if (run.status !== "paused") {
          stored.ownerHalt = undefined; this.save(stored);
          return { ...base, result: "left", reason: LEFT_AS_IS } satisfies HaltOutcome;
        }
        if (keep) {
          stored.ownerHalt = this.releasedMark(stored, KEPT_PAUSED);
          if (!stored.halt) run.reason = KEPT_PAUSED;
          this.save(stored);
          return { ...base, result: "kept", reason: KEPT_PAUSED } satisfies HaltOutcome;
        }
        const other = heldBy([run.projectId]);
        if (other) {
          stored.ownerHalt = { ...this.releasedMark(stored, other.reason), haltId: other.haltId };
          if (!stored.halt) run.reason = other.reason;
          this.save(stored);
          return { ...base, result: "held", reason: STILL_HALTED } satisfies HaltOutcome;
        }
        const refusal = this.resumeRefusal(stored, undefined);
        if (refusal) {
          stored.ownerHalt = this.releasedMark(stored, releaseRefusal(refusal.message));
          if (!stored.halt) run.reason = stored.ownerHalt.reason;
          this.save(stored);
          return { ...base, result: "refused", reason: refusal.message } satisfies HaltOutcome;
        }
        await this.haltResumeRun(stored);
        return { ...base, result: "resumed" } satisfies HaltOutcome;
      } catch (error) { return { ...base, result: "refused", reason: error instanceof Error ? error.message : "The run could not resume." } satisfies HaltOutcome; }
    })));
    return outcomes.filter((item): item is HaltOutcome => item !== undefined);
  }
  haltPauseChild(id: string, token: string, reason: string): Promise<boolean> {
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (stored.ownerHalt?.haltId === token) {
        if (run.status === "paused" && stored.ownerHalt.reason !== reason) {
          stored.ownerHalt = { ...stored.ownerHalt, reason };
          if (!stored.halt) run.reason = reason;
          this.save(stored);
        }
        return run.status === "paused";
      }
      if (!HALT_PAUSED_TEAM.has(run.status)) return false;
      await this.haltStop(stored, { haltId: token, reason });
      return true;
    });
  }
  haltResumeChild(id: string, token: string): Promise<boolean> {
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (run.status !== "paused" || stored.ownerHalt?.haltId !== token) return false;
      const refusal = this.resumeRefusal(stored, undefined);
      if (refusal?.code === "members-stopping") throw refusal;
      if (refusal) {
        stored.ownerHalt = this.releasedMark(stored, releaseRefusal(refusal.message));
        if (!stored.halt) run.reason = stored.ownerHalt.reason;
        this.save(stored);
        throw refusal;
      }
      await this.haltResumeRun(stored);
      return true;
    });
  }
  haltSettleChild(id: string, token: string, reason: string): Promise<boolean> {
    return this.enqueue(id, async () => {
      const stored = this.record(id), run = stored.run;
      if (run.status !== "paused" || stored.ownerHalt?.haltId !== token) return false;
      stored.ownerHalt = this.releasedMark(stored, reason);
      if (!stored.halt) run.reason = reason;
      this.save(stored);
      return true;
    });
  }
  start() {
    if (this.running || this.closed) return;
    this.running = true;
    const tick = () => {
      if (this.tickQueued || !this.running) return;
      this.tickQueued = true;
      const run = (async () => {
        try {
          if (Date.now() - this.reconciledAt >= 2000) {
            this.reconciledAt = Date.now();
            const rows = await this.manager.list().catch(() => undefined);
            if (rows) {
              await this.usage?.tick(rows).catch(() => {});
              await this.limits.reconcile(this.manager, rows.filter(row => !isEvalSession(row)), this.currentDate()).catch(() => {});
            }
          }
          await mapConcurrent([...this.records.keys()], 16, id => this.enqueue(id, async () => {
            const stored = this.records.get(id);
            if (stored && !this.closed) { try { await this.step(stored); } catch (error) { if (!this.closed) this.diag.warnUnexpected("step", error); } }
          }));
          if (this.closed) return;
          this.drainEntries();
          this.objectiveTests.drain();
          if (Date.now() - this.entryIngestAt >= ENTRY_INGEST_MS) { this.entryIngestAt = Date.now(); await this.ingestEntriesAsync(); }
        } finally { this.tickQueued = false; }
      })().catch(() => {}).finally(() => { this.activeTicks.delete(run); });
      this.activeTicks.add(run);
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
    void this.reviewFeedback.start(listener => this.options?.source?.onTick?.(listener) ?? (() => {}));
  }
  async close(): Promise<void> { const reviewFeedback = this.reviewFeedback.close(); this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); for (const timer of this.sampleTimers) clearTimeout(timer); this.sampleTimers.clear(); for (const controller of this.commands.values()) controller.abort(); for (const controller of this.publicationControllers.values()) controller.abort(); for (const controller of this.memberWorkSaveControllers.values()) controller.abort(); for (const controller of this.agentControllers.values()) controller.abort(); this.objectiveTests.close(); this.removeAgentSource?.(); while (this.activeTicks.size > 0) await Promise.allSettled([...this.activeTicks]); await Promise.allSettled([reviewFeedback, this.queues.drain()]); }
  async idle() {
    await this.diag.idle.drain({
      reviewFeedback: () => this.reviewFeedback.settled(),
      activeTicks: this.activeTicks, removalTasks: this.removalTasks,
      publicationTasks: this.publicationTasks, memberWorkSaveTasks: this.memberWorkSaveTasks,
      queuesSize: () => this.queues.size, settleQueues: () => this.queues.settle(),
    }, { onUnsettled: detail => this.diag.warnIdleUnsettled(detail) });
  }
  private stallWindow() { return (this.config.teams?.stallMinutes ?? 30) * 60000; }
  private stallWindowFor(member: TeamMember) {
    return member.role === "reviewer" ? Math.min(this.stallWindow(), REVIEW_QUIET_WINDOW_MS) : this.stallWindow();
  }
  private evalStall(stored: Stored, member: TeamMember, attentionState: AttentionState, journalDrained: boolean, phase: "detect" | "replace", activePrompt?: LivePromptRef | null) {
    const nowMs = this.currentDate().getTime();
    return evaluateStallRecovery({ run: stored.run, member, attentionState, ...(activePrompt !== undefined ? { activePrompt } : {}), quietForMs: nowMs - Date.parse(member.lastActivityAt ?? member.startedAt ?? timestamp()), stallWindowMs: this.stallWindowFor(member), journalDrained, hasDeliveryAttempt: Boolean(stored.deliveryAttempt), nowMs, phase });
  }
  private async detectStall(stored: Stored, member: TeamMember, attentionState: AttentionState, journalDrained: boolean, exited = false, activePrompt?: LivePromptRef | null) {
    const stall = this.evalStall(stored, member, attentionState, journalDrained, "detect", activePrompt);
    if (stall.action === "suppress-duplicate" || (exited && stall.action === "none" && stall.guard === "current-assignment" && stall.reason !== "inactive-run-status")) { member.status = "stopped"; this.save(stored); return false; }
    if (stall.action !== "initiate-stop" && stall.action !== "end-replay") return false;
    await this.replaceStalledMember(stored, member, attentionState, activePrompt);
    return Boolean(stored.pending || stored.run.status === "blocked");
  }
  private extendDeadline(run: TeamRun, budget: TeamGoalContext | TeamHandoffContext) {
    if (!budget.extendMinutes || !budget.ceilingAt) return false;
    const ceiling = Date.parse(budget.ceilingAt);
    if (Date.now() >= ceiling) return false;
    const windowMs = this.stallWindow();
    if (!run.members.some(member => member.revision === run.revision && member.status === "running" && !member.report && !member.pendingLimit && member.lastActivityAt && Date.now() - Date.parse(member.lastActivityAt) <= windowMs)) return false;
    const requested = Math.max(Date.now(), Date.parse(budget.deadlineAt)) + budget.extendMinutes * 60000;
    budget.deadlineAt = new Date(Math.min(requested, ceiling)).toISOString();
    runEvent(run, `The time limit was extended by ${budget.extendMinutes} minutes under the approved extension policy (ceiling ${clock(budget.ceilingAt)}) because an agent showed activity within the ${this.config.teams?.stallMinutes ?? 30}-minute stall window.`);
    const stored = this.records.get(run.id);
    if (stored) this.save(stored);
    return true;
  }
  goalExtension(teamId: string, requestId: string) {
    const stored = this.record(teamId), receipt = stored.goalExtensions?.[requestId];
    return receipt && { ...receipt, stopReason: stored.run.stopReason };
  }
  extendGoalTime(teamId: string, requestId: string, minutes: number, goalDeadlineAt: string, goalCeilingAt: string,
    intent?: { deadlineAt: string; ceilingAt: string }) {
    return this.enqueue(teamId, () => {
      const stored = this.record(teamId);
      const recorded = this.goalExtension(teamId, requestId);
      if (recorded) return recorded;
      if (!stored.run.goal) throw new TeamError(409, "not-a-goal-team", "This team does not belong to a goal.");
      if (stored.run.stopReason && stored.run.stopReason !== "deadline") throw new TeamError(409, "team-stopped-at-limit", "The active team has already stopped at its member limit.");
      const deadline = intent?.deadlineAt ?? new Date(Math.max(Date.now(), Date.parse(stored.run.goal.deadlineAt), Date.parse(goalDeadlineAt)) + minutes * 60000).toISOString();
      const ceiling = intent?.ceilingAt ?? new Date(Math.max(Date.parse(stored.run.goal.ceilingAt ?? goalCeilingAt), Date.parse(goalCeilingAt), Date.parse(deadline))).toISOString();
      const goal = { ...stored.run.goal };
      goal.deadlineAt = new Date(Math.max(Date.parse(goal.deadlineAt), Date.parse(deadline))).toISOString();
      goal.ceilingAt = new Date(Math.max(Date.parse(goal.ceilingAt ?? goalCeilingAt), Date.parse(ceiling), Date.parse(goal.deadlineAt))).toISOString();
      goal.ownerExtendedDeadlineAt = goal.deadlineAt;
      const receipt = { deadlineAt: goal.deadlineAt, ceilingAt: goal.ceilingAt };
      const next = { ...stored, run: { ...stored.run, goal }, goalExtensions: { ...stored.goalExtensions, [requestId]: receipt } };
      this.save(next);
      Object.assign(stored.run, next.run); stored.goalExtensions = next.goalExtensions;
      return { ...receipt, stopReason: stored.run.stopReason };
    });
  }
  private assertBudget(run: TeamRun, addingMember = false) {
    const policy = this.records.get(run.id)?.handoffPolicy;
    if (policy) this.assertHandoffPolicy(policy);
    const budget = run.goal ?? run.handoff;
    if (budget && Date.now() >= Date.parse(budget.deadlineAt) && !this.extendDeadline(run, budget)) {
      run.stopReason = "deadline";
      throw new TeamError(409, "goal-deadline", "The goal reached its deadline. Active work is being stopped and retained for inspection.");
    }
    const limit = memberLimit(run);
    if (run.members.length + (addingMember ? 1 : 0) > limit) {
      if (run.goal || run.handoff) run.stopReason = "member-limit";
      throw new TeamError(409, "team-attempt-limit", `The team reached its limit of ${limit} agent attempts. Review its evidence before continuing.`);
    }
  }
  private commandRecorder(stored: Stored, id: string): CommandScope {
    const recorder: OperationRecorder = { pendingId: id, inFlight: 0, spawning: 0 };
    this.recorders.set(stored.run.id, recorder);
    const settle = () => { recorder.inFlight--; this.saveWitnessSoon(stored, recorder); };
    const failed = () => new TeamError(409, "command-unavailable", "The team operation failed; the command was not started.");
    this.saveWitnessSoon(stored, recorder);
    return {
      starting: () => {
        if (this.intent(stored, id)?.failure) return Promise.reject(failed());
        recorder.inFlight++;
        recorder.spawning++;
        if (this.intent(stored, id)?.recording) return undefined;
        return this.enqueue(stored.run.id, () => {
          if (this.closed) throw new TeamError(409, "command-unavailable", "The host is stopping; the command was not started.");
          const pending = this.intent(stored, id);
          if (pending?.failure) throw failed();
          if (!pending || pending.recording) return;
          pending.recording = true;
          try { this.save(stored); } catch (error) { delete pending.recording; throw error; }
        }).catch(error => { recorder.inFlight--; recorder.spawning--; throw error; });
      },
      started: pid => {
        recorder.spawning--;
        const witness = this.intent(stored, id)?.witness;
        if (pid === undefined || !witness) { settle(); return; }
        if (process.platform !== "win32") recordCommand(witness, pid);
        if (!recorder.sampling) {
          recorder.sampling = true;
          this.sampleWitness(stored, id, [250, 1000, 5000]);
        }
        const processes = this.options?.processes ?? hostProcesses;
        void Promise.resolve().then(() => processes.start(pid)).then(start => this.enqueue(stored.run.id, () => {
          const current = this.intent(stored, id)?.witness;
          if (start && current) recordCommand(current, pid, start);
        })).catch(() => {}).finally(settle);
      },
    };
  }
  private intent(stored: Stored, id: string) { return stored.pending?.id === id ? stored.pending : undefined; }
  private recorderOf(stored: Stored, pending: PendingOperation) {
    const recorder = this.recorders.get(stored.run.id);
    return recorder?.pendingId === pending.id ? recorder : undefined;
  }
  private saveWitnessSoon(stored: Stored, recorder: OperationRecorder) {
    if (recorder.save) { clearTimeout(recorder.save); this.sampleTimers.delete(recorder.save); }
    const timer = setTimeout(() => {
      this.sampleTimers.delete(timer);
      if (recorder.save === timer) recorder.save = undefined;
      void this.enqueue(stored.run.id, () => {
        const pending = this.intent(stored, recorder.pendingId);
        if (this.closed || !pending) return;
        const open = pending.recording;
        if (recorder.inFlight === 0) delete pending.recording;
        try { this.save(stored); } catch (error) { if (open) pending.recording = open; throw error; }
      }).catch(() => {});
    }, WITNESS_SAVE_MS);
    timer.unref();
    this.sampleTimers.add(timer);
    recorder.save = timer;
  }
  private sampleWitness(stored: Stored, id: string, delays: number[]) {
    const delay = delays[0] ?? 15000;
    const timer = setTimeout(() => {
      this.sampleTimers.delete(timer);
      if (this.closed || !this.intent(stored, id) || !this.commands.has(stored.run.id)) return;
      const processes = this.options?.processes ?? hostProcesses;
      void Promise.resolve().then(() => processes.table()).then(table => this.enqueue(stored.run.id, () => {
        const witness = this.intent(stored, id)?.witness;
        if (this.closed || !witness) return;
        if (extendWitness(witness, table)) this.save(stored);
      })).catch(() => {}).finally(() => this.sampleWitness(stored, id, delays.slice(1)));
    }, delay);
    timer.unref();
    this.sampleTimers.add(timer);
  }
  private async refreshOperationCensus(stored: Stored, force = false): Promise<OperationCensus["state"] | undefined> {
    const { run } = stored, pending = stored.pending;
    if (!pending?.witness || this.commands.has(run.id)) return undefined;
    const now = this.options?.now?.() ?? Date.now();
    const previous = stored.census?.pendingId === pending.id ? stored.census : undefined;
    if (!force && previous && now - Date.parse(previous.at) < CENSUS_TTL_MS) return previous.state;
    const processes = this.options?.processes ?? hostProcesses;
    let result: CensusResult;
    try { result = await processes.census(pending.witness, teamRunDirectory(run.workspace), this.config.teams?.commandPrefix); }
    catch (error) { result = { ok: false, problem: error instanceof Error ? error.message : "The census failed." }; }
    if (this.records.get(run.id) !== stored || stored.pending?.id !== pending.id || this.commands.has(run.id)) return undefined;
    const count = (reasons: string[]) => result.ok ? result.findings.filter(finding => reasons.includes(finding.reason)).length : 0;
    const recorded = count(["recorded-process", "recorded-session", "recorded-group"]), using = count(["working-directory", "open-file", "command-line"]);
    const unreadable = count(["unreadable"]);
    const recorder = this.recorderOf(stored, pending);
    const incomplete = pending.recording && !recorder && pending.witness.boot === bootId();
    const census: Omit<OperationCensus, "at" | "pendingId"> = !result.ok ? { state: "unknown", detail: result.problem.slice(0, 200) }
      : recorded > 0 ? { state: "running", recorded, ...(using ? { using } : {}) }
        : using > 0 ? { state: "in-use", using }
          : unreadable > 0 ? { state: "unknown", detail: `${unreadable} process(es) of the accounts it inspects could not be inspected` }
            : incomplete ? { state: "unknown", detail: "the host stopped while the operation was starting a command, so its record of the operation's processes may be incomplete" }
              : recorder && recorder.inFlight > 0 ? { state: "unknown", detail: "a command of the operation is still starting" }
                : { state: "ended" };
    stored.census = { pendingId: pending.id, at: new Date(now).toISOString(), ...census };
    if (previous?.state !== census.state || previous.recorded !== census.recorded || previous.using !== census.using || previous.detail !== census.detail) {
      this.event(stored, operationCensusEvent(pending.kind, census));
      this.save(stored);
    }
    return census.state;
  }
  private operation<T>(stored: Stored, kind: NonNullable<Stored["pending"]>["kind"], perform: (signal: AbortSignal) => Promise<T>, complete: (value: T) => void,
    sourceMember?: TeamMember, sourceWorkspace: "member" | "integration" = "member") {
    if (stored.pending) throw new TeamError(409, "team-operation-running", "A team workspace operation is already running.");
    const pending: PendingOperation = { id: randomUUID(), kind, revision: stored.run.revision, witness: newWitness(), recording: true,
      ...(sourceMember ? { source: { memberId: sourceMember.memberId, role: sourceMember.role, cwd: sourceMember.cwd, baseCommit: sourceMember.baseCommit,
        headCommit: stored.run.headCommit ?? sourceMember.baseCommit, workspace: sourceWorkspace } } : {}) };
    const controller = new AbortController(); this.commands.set(stored.run.id, controller);
    stored.pending = pending; this.save(stored);
    void commandScope.run(this.commandRecorder(stored, pending.id), () => perform(controller.signal)).then(value => this.enqueue(stored.run.id, () => {
      if (this.closed || stored.pending?.id !== pending.id) return;
      this.commands.delete(stored.run.id);
      try { this.assertBudget(stored.run); } catch (error) { this.block(stored, error); return; }
      if (stored.run.stopReason) { this.block(stored, new TeamError(409, "goal-budget-exhausted", "The goal exhausted its execution budget.")); return; }
      const held = ["paused", "cancelled", "blocked"].includes(stored.run.status) ? stored.run.status : undefined;
      stored.pending = undefined;
      try { complete(value); } catch (error) { this.block(stored, error); }
      if (held) stored.run.status = held;
      this.save(stored);
    }), error => this.enqueue(stored.run.id, () => {
      if (this.closed || stored.pending?.id !== pending.id) return;
      this.commands.get(stored.run.id)?.abort();
      this.commands.delete(stored.run.id);
      const failed = stored.pending, recorder = this.recorderOf(stored, failed);
      if (recorder?.spawning === 0 && (process.platform !== "win32" || recorder.inFlight === 0)) delete failed.recording;
      failed.failure = { code: error instanceof TeamError ? error.code : "workspace-operation-failed",
        reason: error instanceof Error ? error.message : "A team workspace operation failed.", at: timestamp() };
      this.save(stored);
      this.block(stored, error);
    })).catch(() => {});
  }
  private block(stored: Stored, error: unknown, sourceMember?: TeamMember) {
    if (stored.run.replay) return void this.replays.blocked(stored, error);
    const pending = stored.pending, run = stored.run;
    const code = error instanceof TeamError ? error.code : undefined;
    if (!pending && sourceMember?.role === "delivery" && sourceMember.report?.kind === "blocked" &&
        this.queueAutomaticDeliveryRecovery(stored, sourceMember, sourceMember.report.summary)) return;
    const operationSource = pending && recoverableOperationFailure(stored, pending);
    const unattributedOperation = pending && recoverableUnattributedResult(stored, pending);
    if ((operationSource || unattributedOperation) && !stored.deliveryAttempt && !run.deliveryReceipt && !deliveredAtRevision(run) && !run.stopReason &&
        !run.permissionsRevokedAt && (!run.linearTracking || run.linear?.status === "synced") && !["paused", "cancelled"].includes(run.status) &&
        !["pause", "cancel", "steer"].includes(stored.halt ?? "")) {
      const attempts = run.recovery?.attempts ?? 0;
      const source = { code: pending!.failure?.code ?? "unattributed-result", memberId: operationSource?.memberId ?? "unattributed", revision: pending!.revision,
        ...(operationSource?.report ? { reportKind: operationSource.report.kind } : {}),
        reason: pending!.failure?.reason ?? (error instanceof Error ? error.message : "A retained result intent needs coordinator diagnosis."), at: pending!.failure?.at ?? timestamp() };
      if (attempts < automaticRecoveryLimit) {
        run.recovery = { attempts: attempts + 1, status: "stopping", source };
        this.commands.get(run.id)?.abort();
        void this.invalidatePermissionDecisions(stored, "The team is stopping members before an automatic PM recovery.").catch(error => console.warn("Team permission invalidation failed during automatic recovery.", error));
        run.status = "planning"; stored.halt = "block"; run.blockCode = source.code; run.reason = source.reason;
        this.event(stored, "The project manager will diagnose the retained result after write-capable members stop; no result intent will be replayed.");
        this.save(stored); return;
      }
      run.recovery = { attempts, status: "exhausted", source };
    }
    const permissionUncertain = (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "escalated", "uncertain"].includes(decision.status));
    const recoverable = Boolean(code && automaticRecoveryCodes.has(code) && sourceMember && sourceMember.revision === run.revision &&
      sourceMember.role !== "delivery" && sourceMember.role !== "permission-coordinator" && !pending && !stored.deliveryAttempt &&
      !run.deliveryReceipt && !deliveredAtRevision(run) && !run.stopReason && !run.permissionsRevokedAt && !permissionUncertain &&
      (!run.linearTracking || run.linear?.status === "synced") && !["paused", "cancelled"].includes(run.status));
    if (recoverable && code && sourceMember) {
      const attempts = run.recovery?.attempts ?? 0;
      const source = { code, memberId: sourceMember.memberId, revision: sourceMember.revision,
        ...(sourceMember.report ? { reportKind: sourceMember.report.kind } : {}), reason: error instanceof Error ? error.message : "A team member needs a corrected plan.", at: timestamp() };
      if (attempts < automaticRecoveryLimit) {
        run.recovery = { attempts: attempts + 1, status: "stopping", source };
        this.commands.get(run.id)?.abort();
        void this.invalidatePermissionDecisions(stored, "The team is stopping members before an automatic PM recovery.").catch(error => console.warn("Team permission invalidation failed during automatic recovery.", error));
        run.status = "planning"; stored.halt = "block"; run.blockCode = code; run.reason = source.reason;
        this.event(stored, `The project manager will diagnose ${sourceMember.title}'s ${code} report after all active members stop.`);
        this.save(stored); return;
      }
      run.recovery = { attempts, status: "exhausted", source };
    } else if (run.recovery) {
      run.recovery.status = "exhausted";
    }
    for (const request of run.permissionRecovery?.requests ?? []) if (livePermissionRecoveryStatuses.has(request.status)) {
      const cause = error instanceof Error ? error.message : "The team became blocked during permission recovery.";
      const latest = request.latestDecisionId ? run.permissionDecisions?.find(item => item.id === request.latestDecisionId) : undefined;
      const uncertainAnswer = latest?.status === "answering" || latest?.status === "uncertain";
      this.recordPermissionRecoveryStep(stored, request, { ...(request.latestDecisionId ? { decisionId: request.latestDecisionId } : {}), cause,
        action: "team-blocked", decision: "stop-recovery", consequence: uncertainAnswer ? "An answer may have been sent; inspect the target session before further action." :
          "No answer is in flight; the retained prompt remains for owner review." });
      this.finishPermissionRecovery(stored, request, "interrupted", cause, "team-blocked", "stop-recovery", uncertainAnswer ?
        "An answer may have been sent; inspect the target session before further action. Command execution remains unknown." :
        "No answer is in flight; the retained prompt remains for owner review.", request.latestDecisionId);
    }
    const failure = error instanceof TeamError && (error.code === "setup-changed-files" || error.code === "verification-changed-files") ? error.code : undefined;
    if (failure && pending?.kind === "check" && pending.revision === run.revision && run.status === "verifying" &&
        run.headCommit && commitId.test(run.headCommit) && stored.checkHead !== run.headCommit && !stored.deliveryAttempt &&
        !run.deliveryReceipt && !run.stopReason && !stored.halt && completedChecks(stored, run.revision)) {
      stored.verificationRecovery = { pendingId: pending.id, pendingKind: "check", revision: pending.revision, headCommit: run.headCommit, failure };
    } else if (pending?.kind === "check") delete stored.verificationRecovery;
    this.commands.get(stored.run.id)?.abort();
    void this.invalidatePermissionDecisions(stored, "The team became blocked before the permission request could be answered.").catch(error => console.warn("Team permission invalidation failed while blocking the run.", error));
    if (!["paused", "cancelled"].includes(stored.run.status)) { stored.run.status = "blocked"; stored.halt = "block"; }
    if (run.deliveryRecovery && run.deliveryRecovery.status !== "complete") {
      run.deliveryRecovery.status = "exhausted";
      if (run.recovery) run.recovery.status = "exhausted";
    }
    stored.run.blockCode = code;
    stored.run.reason = stored.run.stopReason === "deadline" ? "The goal reached its deadline. Active work is being stopped and retained for inspection."
      : stored.run.stopReason === "member-limit" ? "The goal reached this run's agent attempt limit. Active work is being stopped and retained for inspection."
        : error instanceof TeamError ? error.message : genericOperationFailureReason;
    if (this.options?.events) stored.ledgerBlockSource = sourceMember?.memberId ?? pending?.source?.memberId;
    this.event(stored, stored.run.reason); this.save(stored); this.trackBlocked(stored);
  }
  private trackBlocked(stored: Stored) {
    if (stored.run.status === "blocked") this.linear?.updateTeam(stored.run, stored.run.linearTracking === true, this.canResume(stored));
  }
  private hasLaunch(member: TeamMember) {
    try { this.manager.meta(member.sessionId); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async stopped(member: TeamMember) {
    const state = await this.manager.stopTeamSession(member.sessionId, member.stopRequestId, assignment(member));
    if (state.status !== "exited") return undefined;
    member.status = "stopped"; return state;
  }
  private expirePermissionDecision(stored: Stored, decision: TeamPermissionDecision, expired: ReturnType<typeof expireQueuedPermissionReview>) {
    if (!expired.decisionChanged) return false;
    if (decision.purpose === "diagnose" && expired.recovery) return this.queuePermissionRecoveryPm(stored, expired.recovery, decision.reason!, decision.id);
    this.finishLinkedPermissionRecovery(stored, decision, decision.reason!, "coordinator-timeout", "review-expired", "No provider answer was sent; the request remains with the owner."); return false;
  }
  private async stopObsoletePermissionCoordinators(stored: Stored) {
    const run = stored.run;
    for (const member of run.members.filter(item => item.role === "permission-coordinator" &&
      (activeMember(item) || item.status === "waiting"))) {
      if (member.status === "unavailable" && terminalPermissionCoordinator(run, member)) continue;
      const terminal = member.revision !== run.revision || run.permissionsRevokedAt !== undefined ||
        !run.permissions || ["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status);
      if (member.status === "waiting") {
        if (terminal) { member.status = "stopped"; member.report = undefined; this.save(stored); }
        continue;
      }
      const decision = permissionCoordinatorDecision(run, member);
      const target = decision && run.members.find(item => item.memberId === decision.targetMemberId && item.sessionId === decision.targetSessionId);
      const recovery = decision?.recoveryRequestId
        ? run.permissionRecovery?.requests.find(request => request.id === decision.recoveryRequestId)
        : undefined;
      let continuedAfterExpansion = false;
      const awaitingExpandedPrompt = Boolean(recovery?.expansion && ["expanded", "uncertain"].includes(recovery.expansion.status) &&
        recovery.expansion.observedPromptId === undefined && livePermissionRecoveryStatuses.has(recovery.status));
      let obsolete = terminal || !decision || decision.status !== "reviewing" || !target || !activeMember(target), promptClosed = !target || !activeMember(target);
      if (!obsolete && decision && target) {
        try {
          const state = await this.manager.state(target.sessionId, true), prompt = state.attention.prompt;
          obsolete = state.status !== "running" || state.attention.state !== "needs-you" || !prompt ||
            prompt.id !== decision.promptId || prompt.hash !== decision.promptHash ||
            permissionEvidenceHash(prompt) !== decision.evidenceHash;
          promptClosed = obsolete && (state.status === "running" || state.status === "exited");
          if (obsolete && state.status === "running" && state.attention.state === "needs-you" &&
              (!state.control || state.control.expiresAt <= Date.now()) && prompt && recovery)
            continuedAfterExpansion = this.advanceExpandedPermissionPrompt(stored, recovery, target, prompt);
        } catch (error) { if (!isBenignFenceError(error, this.closed)) this.diag.warnUnexpected("permission-target-state", error); obsolete = true; }
      }
      if (!obsolete) continue;
      const decisionChanged = decision?.status === "reviewing";
      if (decision && decisionChanged) {
        decision.status = "escalated"; if (promptClosed) decision.promptClosedAt ??= timestamp();
        decision.reason = "The target request or team stage changed while the read-only permission review was running.";
        if (!continuedAfterExpansion && !awaitingExpandedPrompt) this.finishLinkedPermissionRecovery(stored, decision, decision.reason, "target-prompt-changed", "stop-stale-review",
          "No provider answer was sent; the current prompt requires a fresh review or owner attention.");
        else if (recovery) {
          recovery.latestDecisionId = undefined;
          if (!continuedAfterExpansion) recovery.status = "expanding";
        }
      }
      if (member.status === "queued" && !this.hasLaunch(member)) {
        member.status = terminal ? "stopped" : "waiting";
        member.report = undefined;
        this.event(stored, terminal
          ? "The queued permission reviewer was stopped because the run authority or revision changed."
          : "The obsolete queued permission review turn was cleared; the request remains with the user.");
        this.save(stored);
        continue;
      }
      const wasUnavailable = member.status === "unavailable";
      let stopConfirmed = false;
      try { stopConfirmed = Boolean(await this.stopped(member)); }
      catch (error) { if (!isBenignStopError(error, this.closed)) this.diag.warnUnexpected("stop-permission-coordinator", error); }
      if (!stopConfirmed) {
        member.status = "unavailable";
        if (!wasUnavailable) {
          this.event(stored, "The obsolete permission coordinator could not be confirmed stopped and remains unavailable for inspection.");
        }
        if (decisionChanged || !wasUnavailable) this.save(stored);
        continue;
      }
      member.status = terminal ? "stopped" : "waiting";
      member.report = undefined;
      this.event(stored, terminal
        ? "The permission reviewer was stopped because the run authority or revision changed."
        : "The obsolete permission review turn was confirmed stopped; the request remains with the user.");
      this.save(stored);
    }
  }
  private async step(stored: Stored) {
    const run = stored.run;
    await this.retire(stored);
    if (!this.records.has(run.id)) return;
    this.startPublication(stored);
    try {
      const tracking = this.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
      if (JSON.stringify(run.linear) !== JSON.stringify(tracking)) { run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked" && !stored.halt && !["cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) {
        this.block(stored, new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work. Review its requirements before starting another team."));
      }
      const trackingReady = !tracking || tracking.status === "synced";
      const budget = run.goal ?? run.handoff;
      if (!stored.halt && budget?.extendMinutes && budget.ceilingAt && Date.now() >= Date.parse(budget.deadlineAt) && Date.now() < Date.parse(budget.ceilingAt)) {
        for (const member of run.members.filter(item => item.revision === run.revision && item.status === "running" && !item.report)) {
          const state = await this.manager.state(member.sessionId);
          if (state.status !== "running") member.status = "unavailable";
          syncObservedMemberState(run, member, state, timestamp());
        }
        this.save(stored);
      }
      if (!stored.halt && !["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) this.assertBudget(run);
      if (stored.halt) {
        let all = true;
        const drainRevision = stored.halt === "block" && run.recovery?.status === "stopping" ? run.recovery.source.revision
          : stored.halt === "steer" && run.recovery ? run.revision - 1 : undefined;
        const membersToStop = run.members.filter(member => (activeMember(member) ||
          member.role === "permission-coordinator" && member.status === "waiting" ||
          drainRevision !== undefined && member.revision === drainRevision) &&
          !(drainRevision !== undefined && member.revision === drainRevision && member.status !== "waiting" && terminalPermissionCoordinator(run, member)));
        const halt = stored.halt;
        for (const member of membersToStop) {
          const statusBefore = member.status;
          try {
            if (member.role === "permission-coordinator" && member.status === "waiting") {
              member.status = "stopped"; member.report = undefined; continue;
            }
            if (drainRevision === undefined || member.revision !== drainRevision) {
              if (member.status === "queued" && !this.hasLaunch(member)) member.status = "stopped";
              else if (!await this.stopped(member)) {
                if (member.role === "permission-coordinator") member.status = "unavailable";
                all = false;
              }
              continue;
            }
            if (!member.startedAt && !member.report && !this.hasLaunch(member)) { member.status = "stopped"; continue; }
            let stopped = member.status === "stopped" ? await this.manager.state(member.sessionId) : undefined;
            if (stopped?.status !== "exited") stopped = await this.stopped(member);
            if (!stopped) {
              if (member.role === "permission-coordinator") member.status = "unavailable";
              all = false; continue;
            }
            const { page } = this.readMemberJournal(stored, member, false, true);
            member.status = "stopped";
            if (page.more || member.cursor < stopped.seq) all = false;
          } catch { all = false; member.status = "unavailable"; }
          finally {
            if (statusBefore !== "stopped" && member.status === "stopped")
              this.memberStopped(stored, member, halt === "block" ? "host" : "owner", halt);
          }
        }
        const safePendingRecovery = Boolean(run.recovery?.status === "stopping" && stored.pending &&
          (recoverableOperationFailure(stored, stored.pending) || recoverableUnattributedResult(stored, stored.pending)));
        if (all && (!stored.pending || safePendingRecovery || run.status === "blocked" || run.status === "cancelled")) { stored.halt = undefined; if (!["blocked", "cancelled"].includes(run.status)) run.reason = run.status === "paused" ? stored.ownerHalt?.reason : undefined; }
        this.save(stored); return;
      }
      if (await this.startAutomaticRecovery(stored, trackingReady)) return;
      if (!stored.prepared) return;
      this.verdicts.recover(stored);
      if (["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) {
        await this.stopObsoletePermissionCoordinators(stored); return;
      }
      await this.stopObsoletePermissionCoordinators(stored);
      if ([providerInputReason, permissionReviewReason, permissionAgentReason, runtimeUnavailableReason].includes(run.reason ?? "")) {
        const observedMembers = run.members.filter(member => member.revision === run.revision && activeMember(member) && member.status !== "queued" && !member.report);
        const states = await Promise.all(observedMembers.map(member => this.manager.state(member.sessionId)));
        if (this.closed) return;
        const held = states.flatMap((state, index) => state.status !== "exited" && state.attention.state === "needs-you"
          ? [this.promptHolder(run, observedMembers[index].sessionId, state.attention.prompt?.id)] : []);
        const reason = states.some(state => ["unavailable", "recording-error"].includes(state.status)) ? runtimeUnavailableReason
          : held.includes("user") ? providerInputReason : held.includes("agent") ? permissionAgentReason : held.length ? permissionReviewReason : undefined;
        if (run.reason !== reason) { run.reason = reason; this.save(stored); }
      }
      if (stored.pending) return;
      this.assertRunPath(stored, run.workspace);
      for (const member of run.members.filter(item => item.revision === run.revision && activeMember(item))) {
        if (member.status === "queued") {
          const decision = member.role === "permission-coordinator" && !this.hasLaunch(member) ? permissionCoordinatorDecision(run, member) : undefined;
          if (decision && this.currentDate().getTime() >= Date.parse(decision.expiresAt)) {
            if (this.expirePermissionDecision(stored, decision, expireQueuedPermissionReview(run, member, decision, this.limits.active(this.currentDate()), { reviewing: permissionReviewReason, userInput: providerInputReason }))) return;
            this.event(stored, "The permission coordinator exceeded its review window; the request remains with the user."); this.save(stored); continue;
          }
          await this.launch(stored, member);
          if (run.status === "ready-for-review") return;
          continue;
        }
        if (!member.report) {
          if (member.role === "permission-coordinator" && member.startedAt && Date.now() - Date.parse(member.startedAt) > 5 * 60 * 1000) {
            const decision = permissionCoordinatorDecision(run, member), decisionChanged = decision?.status === "reviewing", before = member.status;
            if (decision && decisionChanged) {
              decision.status = "escalated"; decision.reason = "The five-minute review window expired without a decision.";
              const recovery = decision.recoveryRequestId ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId) : undefined;
              if (this.expirePermissionDecision(stored, decision, { decisionChanged: true, recovery })) return;
            }
            let stopConfirmed = false;
            try { stopConfirmed = Boolean(await this.stopped(member)); }
            catch (error) { if (!isBenignStopError(error, this.closed)) this.diag.warnUnexpected("stop-permission-timeout", error); }
            member.status = stopConfirmed ? "waiting" : "unavailable";
            if (stopConfirmed) member.report = undefined;
            if (decisionChanged || before !== "unavailable") this.event(stored, "The permission coordinator exceeded its review window; the request remains with the user.");
            if (decisionChanged || member.status !== before) this.save(stored);
            continue;
          }
          const { page, limit } = this.readMemberJournal(stored, member);
          if (!member.report && limit) {
            await this.switchLimitedMember(stored, member, limit);
            if (stored.pending || run.status === "blocked") return;
            continue;
          }
          if (!member.report) {
            const state = await this.manager.state(member.sessionId);
            syncObservedMemberState(run, member, state, timestamp());
            const journalDrained = !page.more && member.cursor >= state.seq;
            if (state.status === "exited" && (page.more || member.cursor < state.seq)) { this.save(stored); continue; }
            if (member.role === "permission-coordinator" && resumeFailed(state, member.continuation) &&
                member.turns?.at(-1)?.mode === "resume") {
              const decision = permissionCoordinatorDecision(run, member);
              let prompt: string;
              try {
                prompt = teamPrompt(run, "permission-coordinator", undefined, member.pendingFeedback ?? "",
                  member.provider ?? run.provider, member.modelProfile);
              } catch (error) { this.block(stored, error); return; }
              const nativeSessionId = randomUUID(), sessionId = randomUUID(), startedAt = timestamp();
              const turn = member.turns.at(-1)!;
              member.sessionId = sessionId;
              member.stopRequestId = randomUUID();
              member.cursor = 0;
              member.startedAt = undefined;
              member.lastActivityAt = undefined; member.spinnerOnlySince = undefined;
              member.pendingLimit = undefined;
              member.report = undefined;
              member.exitConfirmedAt = undefined;
              member.prompt = prompt;
              member.nativeSessionId = nativeSessionId;
              member.continuation = { mode: "start", nativeSessionId };
              turn.sessionId = sessionId;
              turn.startedAt = startedAt;
              turn.mode = "start";
              if (decision) decision.coordinatorSessionId = sessionId;
              member.status = "queued";
              runEvent(run, "The permission reviewer's conversation could not be resumed; the review restarts with the full assignment.");
              this.save(stored);
              continue;
            }
            if (state.status === "exited") {
              if (member.stalledAt && journalDrained) { if (await this.detectStall(stored, member, state.attention.state, journalDrained, true, null)) return; continue; }
              if (member.role === "permission-coordinator") {
                const decision = permissionCoordinatorDecision(run, member);
                member.status = "waiting";
                member.report = undefined;
                if (decision && ["pending", "reviewing"].includes(decision.status)) {
                  decision.status = "escalated"; decision.reason = "The permission coordinator exited without its assigned decision report.";
                  const recovery = decision.recoveryRequestId ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId) : undefined;
                  if (decision.purpose === "diagnose" && recovery) {
                    if (this.queuePermissionRecoveryPm(stored, recovery, decision.reason, decision.id)) return;
                  } else this.finishLinkedPermissionRecovery(stored, decision, decision.reason, "coordinator-exit", "report-missing",
                    "No provider answer was sent; the request remains with the owner.");
                }
                this.event(stored, "The permission coordinator exited without a decision; the provider request remains with the user."); this.save(stored); continue;
              }
              member.status = "stopped";
              this.memberStopped(stored, member, "no-report");
              if (this.intentChecks.failed(stored, member) || this.verdicts.failed(stored, member)) return;
              this.block(stored, new TeamError(409, "missing-agent-report", "An agent exited without a valid structured report. Its task is unresolved."), member); return;
            }
            if (state.status === "running" && member.status === "unavailable" && member.role !== "permission-coordinator") member.status = "running";
            if (this.agentEligible(stored)) {
              await this.retireCoordinatorReviews(stored);
              if (this.agentServes(stored)) this.handOffPermission(stored, member, state);
            } else {
              this.agentSwitched.delete(run.id);
              if (!this.agentBusy(run.id) && await this.maybeStartPermissionReview(stored, member, state)) return;
            }
            if (["unavailable", "recording-error"].includes(state.status)) { member.status = "unavailable"; run.reason = runtimeUnavailableReason; }
            else if (state.attention.state === "needs-you") {
              const holder = this.promptHolder(run, member.sessionId, state.attention.prompt?.id);
              if (run.replay && holder === "user") return void this.replays.end(stored, "permission");
              run.reason = run.reason === providerInputReason || holder === "user" ? providerInputReason : holder === "agent" ? permissionAgentReason : permissionReviewReason;
            }
            else if (member.status !== "unavailable" || member.role !== "permission-coordinator" ||
              permissionCoordinatorDecision(run, member)?.status === "reviewing") member.status = "running";
            this.save(stored);
            if (state.status === "running" && member.role !== "permission-coordinator" && await this.detectStall(stored, member, state.attention.state, journalDrained, false, state.attention.state === "needs-you" && state.attention.prompt ? { id: state.attention.prompt.id, ...(state.attention.prompt.hash ? { hash: state.attention.prompt.hash } : {}) } : null)) return;
            continue;
          }
          this.save(stored);
        }
        try { if (!await this.stopped(member)) continue; }
        catch { member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); continue; }
        if (!trackingReady) { member.status = "reported"; member.exitConfirmedAt ??= timestamp(); this.save(stored); continue; }
        if (member.role === "implementer" && member.report?.kind === "result") {
          const position = run.tasks.findIndex(task => task.id === member.taskId);
          if (run.tasks.slice(0, position).some(task => task.status !== "integrated")) { member.status = "reported"; member.exitConfirmedAt ??= timestamp(); this.save(stored); continue; }
        }
        this.consume(stored, member);
        if (stored.pending || stored.halt || run.status === "blocked" || run.status === "no-change") return;
      }
      await this.stopObsoletePermissionCoordinators(stored);
      if (!trackingReady) return;
      for (const decision of run.decisions.filter(item => item.revision === run.revision && item.answer)) {
        const prior = run.members.find(member => member.memberId === decision.memberId);
        if (prior === undefined && !run.replay) throw new TeamError(409, "decision-member-missing", "A team decision names a member its run does not hold.");
        if (prior?.status !== "waiting") continue;
        if ((prior.role === "scout" || prior.role === "implementer") && run.members.filter(member => holdsWorkerSlot(member, run.revision)).length >= run.parallelism) continue;
        const answeredBy = decisionAnswerLabel(decision);
        const next = this.newMember(run, prior.role, prior.cwd, prior.baseCommit, prior.taskId, `${prior.prompt}\n\n${answeredBy} answered: ${decision.answer}`, prior.modelProfile);
        next.contextFeedback = [prior.contextFeedback ?? prior.prompt, `${answeredBy} answered: ${decision.answer}`].filter(Boolean).join("\n\n");
        next.provider = next.modelProfile?.provider ?? prior.provider ?? run.provider;
        prior.status = "stopped"; run.members.push(next);
        this.linkReplacement(stored, next, prior, "answer");
        if (prior.role === "delivery" && stored.deliveryAttempt?.memberId === prior.memberId)
          stored.deliveryAttempt.memberId = next.memberId;
        const task = prior.role === "scout" ? run.discovery?.tasks.find(item => item.id === prior.taskId) : run.tasks.find(item => item.id === prior.taskId);
        if (task) { task.memberId = next.memberId; task.status = "running"; }
        if (run.status === "needs-input" && !run.decisions.some(item => item.revision === run.revision && !item.answer) && !run.members.some(item => item.revision === run.revision && item.status === "waiting" && item.role !== "permission-coordinator")) run.status = activeStageForRole(next.role);
        this.save(stored);
      }
      if (run.discovery && !run.discovery.completedAt && run.discovery.revision === run.revision) {
        const scouts = run.discovery.tasks;
        const active = run.members.filter(member => member.role === "scout" && holdsWorkerSlot(member, run.revision)).length;
        const next = scouts.find(scout => scout.status === "pending");
        if (next && active < run.parallelism) { this.prepareMember(stored, "scout", next); return; }
        if (scouts.every(scout => scout.status === "complete")) {
          run.discovery.completedAt = timestamp(); run.status = "planning";
          this.event(stored, "Read-only discovery finished. The coordinator will use its recorded evidence once."); this.save(stored);
        } else {
          run.status = scouts.some(scout => scout.status === "waiting") ? "needs-input" : "discovering";
          this.save(stored); return;
        }
      }
      if (run.members.some(member => member.revision === run.revision && activeMember(member) && member.role !== "implementer" && member.role !== "permission-coordinator")) return;
      if (run.members.some(member => member.revision === run.revision && member.status === "waiting" && member.role !== "implementer" && member.role !== "permission-coordinator")) { run.status = "needs-input"; this.save(stored); return; }
      const reconciledBaseline = run.deliveryRecovery?.status === "replanning" && run.deliveryRecovery.revision === run.revision &&
        Boolean(run.deliveryRecovery.integratedHeadCommit) && run.deliveryRecovery.integratedHeadCommit === run.headCommit;
      if (!run.tasks.length && !reconciledBaseline) {
        if (this.intentChecks.step(stored) || this.verdicts.step(stored) || this.replays.judgeStep(stored)) return;
        if (run.members.some(member => member.revision === run.revision && member.role === "project-manager" && member.status === "waiting")) { run.status = "needs-input"; this.save(stored); return; }
        this.prepareMember(stored, "project-manager"); return;
      }
      const pendingTasks = run.tasks.filter(task => task.status === "pending");
      const activeCount = run.members.filter(member => member.revision === run.revision && activeMember(member) && member.role !== "permission-coordinator").length;
      const workerCount = run.members.filter(member => holdsWorkerSlot(member, run.revision)).length;
      const nextTask = pendingTasks.find(task => task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === "integrated"));
      if (nextTask && workerCount < run.parallelism) { this.prepareMember(stored, "implementer", nextTask); return; }
      if (run.tasks.some(task => task.status !== "integrated")) {
        run.status = run.decisions.some(decision => decision.revision === run.revision && !decision.answer) ? "needs-input" : "implementing";
        this.save(stored); return;
      }
      if (activeCount) return;
      if (run.replay) return void this.replays.step(stored);
      if (run.establishChecks && !run.verification?.checks.length)
        throw new TeamError(409, "verification-required", "Required verification commands have not been established; review cannot start.");
      if (stored.checkHead !== run.headCommit) {
        const hold = this.manager.hostLoad.held();
        if (hold) { this.holdForHostLoad(stored, hold); return; }
        if (run.reason?.startsWith(HOST_LOAD_REASON_PREFIX)) run.reason = undefined;
        this.check(stored); return;
      }
      if (!run.review || run.review.revision !== run.revision) {
        this.prepareMember(stored, "reviewer"); return;
      }
      if (run.review.verdict === "approved") {
        if (this.verdicts.reviewed(stored)) return;
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.config.teams?.commandPrefix, undefined, "integration");
        this.assertBudget(run);
        if (run.delivery) {
          if (run.pullRequest && !pullRequestBranch(run) && !this.reviewFeedback.ensureLegacyPullRequestBranch(stored)) return;
          this.assertDelivery(stored);
          if (stored.deliveryAttempt) throw new TeamError(409, "delivery-reconciliation-required", "Delivery started without a confirmed report. Inspect the recorded branch and pull request before retrying.");
          if (this.holdAutomaticMerge(stored)) return;
          this.prepareMember(stored, "delivery");
        } else {
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          const publication = run.publication?.commit === run.headCommit ? run.publication : undefined;
          this.event(stored, publication
            ? `The reviewer approved the integrated change and configured checks passed. Ready for human review. The host published the integration head to GitHub ${publication.repository} ${publication.branch}.`
            : "The reviewer approved the integrated change and configured checks passed. Ready for human review; nothing was published."); this.save(stored);
        }
      }
    } catch (error) { this.block(stored, error); }
  }

  private permissionHost(): PermissionHost {
    const service = this;
    return {
      get records() { return service.records; },
      get commands() { return service.commands; },
      get manager() { return service.manager; },
      get config() { return service.config; },
      get closed() { return service.closed; },
      save: stored => service.save(stored),
      event: (stored, text) => service.event(stored, text),
      record: id => service.record(id),
      enqueue: (runId, task) => service.enqueue(runId, task),
      operation: (stored, kind, perform, complete, sourceMember, sourceWorkspace) => service.operation(stored, kind, perform, complete, sourceMember, sourceWorkspace),
      assertRunPath: (stored, path, create) => service.assertRunPath(stored, path, create),
      assertBudget: (run, addingMember) => service.assertBudget(run, addingMember),
      block: (stored, error, sourceMember) => service.block(stored, error, sourceMember),
      assertDelivery: stored => service.assertDelivery(stored),
      invalidatePermissionDecisions: (stored, reason, fenceAgent) => service.invalidatePermissionDecisions(stored, reason, fenceAgent),
      newMember: (run, role, cwd, baseCommit, taskId, prompt, pinnedProfile) => service.newMember(run, role, cwd, baseCommit, taskId, prompt, pinnedProfile),
      permissionRecoveryHistory: run => service.permissionRecoveryHistory(run),
      refenceCoordinatorAnswers: stored => service.refenceCoordinatorAnswers(stored),
      requiredChecks: run => service.requiredChecks(run),
      reviewerProfile: run => service.reviewerProfile(run),
      settleAnswerMark: (stored, decisionId) => service.settleAnswerMark(stored, decisionId),
      trackBlocked: stored => service.trackBlocked(stored),
      prefixFor: run => service.prefixFor(run),
    };
  }
  private get agentSwitched() { return this.permissions.agentSwitched; }
  private get agentControllers() { return this.permissions.agentControllers; }
  private get removeAgentSource() { return this.permissions.removeAgentSource; }
  usePermissionAgent(services: PermissionAgentServices) { this.permissions.usePermissionAgent(services); }
  permissionAuthorityChanged(): Promise<void> { return this.permissions.permissionAuthorityChanged(); }
  permissionAgentLive(session: Pick<Session, "id" | "team">): boolean { return this.permissions.permissionAgentLive(session); }
  permissionAgentTask(session: Pick<Session, "team">): { title: string; text: string } | undefined { return this.permissions.permissionAgentTask(session); }
  private finishLinkedPermissionRecovery(...args: Parameters<TeamPermissionReview["finishLinkedPermissionRecovery"]>) { return this.permissions.finishLinkedPermissionRecovery(...args); }
  private advanceExpandedPermissionPrompt(...args: Parameters<TeamPermissionReview["advanceExpandedPermissionPrompt"]>) { return this.permissions.advanceExpandedPermissionPrompt(...args); }
  private recordPermissionRecoveryStep(...args: Parameters<TeamPermissionReview["recordPermissionRecoveryStep"]>) { return this.permissions.recordPermissionRecoveryStep(...args); }
  private finishPermissionRecovery(...args: Parameters<TeamPermissionReview["finishPermissionRecovery"]>) { return this.permissions.finishPermissionRecovery(...args); }
  private queuePermissionRecoveryPm(...args: Parameters<TeamPermissionReview["queuePermissionRecoveryPm"]>) { return this.permissions.queuePermissionRecoveryPm(...args); }
  private agentEligible(...args: Parameters<TeamPermissionReview["agentEligible"]>) { return this.permissions.agentEligible(...args); }
  private retireCoordinatorReviews(...args: Parameters<TeamPermissionReview["retireCoordinatorReviews"]>) { return this.permissions.retireCoordinatorReviews(...args); }
  private agentServes(...args: Parameters<TeamPermissionReview["agentServes"]>) { return this.permissions.agentServes(...args); }
  private agentBusy(...args: Parameters<TeamPermissionReview["agentBusy"]>) { return this.permissions.agentBusy(...args); }
  private promptHolder(...args: Parameters<TeamPermissionReview["promptHolder"]>) { return this.permissions.promptHolder(...args); }
  private fenceAgentDeliveries(...args: Parameters<TeamPermissionReview["fenceAgentDeliveries"]>) { return this.permissions.fenceAgentDeliveries(...args); }
  private endPermissionTask(...args: Parameters<TeamPermissionReview["endPermissionTask"]>) { return this.permissions.endPermissionTask(...args); }
  private handOffPermission(...args: Parameters<TeamPermissionReview["handOffPermission"]>) { return this.permissions.handOffPermission(...args); }
  private maybeStartPermissionReview(...args: Parameters<TeamPermissionReview["maybeStartPermissionReview"]>) { return this.permissions.maybeStartPermissionReview(...args); }
  private consumePermissionCoordinator(...args: Parameters<TeamPermissionReview["consumePermissionCoordinator"]>) { return this.permissions.consumePermissionCoordinator(...args); }
  private assertDelivery(stored: Stored) { assertReviewedDelivery(stored.run, stored.checkHead, this.config.projects.find(project => project.id === stored.run.projectId)?.team?.delivery); }
  private holdAutomaticMerge(stored: Stored, queued?: TeamMember): boolean {
    const { run } = stored;
    if (run.delivery?.mode !== "merge") return false;
    const reason = automaticMergeReviewReason({ run: { headCommit: run.headCommit, revision: run.revision, round: run.round, review: run.review, checkHead: stored.checkHead },
      lineage: stored.deliveryReviewLineage, approval: stored.deliveryReviewApproval, members: run.members });
    if (!reason) return false;
    if (stored.deliveryAttempt) throw new TeamError(409, "delivery-reconciliation-required", "An earlier delivery attempt requires reconciliation before any new merge attempt.");
    if (queued) { queued.status = "stopped"; queued.stoppedReason = reason; }
    run.status = "ready-for-review"; run.reason = reason;
    if (run.recovery) run.recovery.status = "complete";
    this.event(stored, "Ready for human review. Automatic merge requires an exact-head approval from a known model family independent of every contributing family.");
    this.save(stored); return true;
  }
  private memberProfile(run: TeamRun, role: TeamMember["role"], task?: TeamTask | TeamScout): TeamModelProfile | undefined {
    if (!run.lineup) return undefined;
    if (role === "permission-coordinator") return this.reviewerProfile(run);
    if (role === "project-manager" || role === "delivery") return run.lineup.coordinator;
    if (role === "integrator" || role === "reviewer") return run.lineup[role];
    if (!task) throw new TeamError(409, "invalid-agent-profile", "An implementer requires an assigned task and allowed model profile.");
    assertTaskProfiles(run, [task], role === "scout" ? "scouts" : "plan");
    return role === "implementer" && autoPinned(run) ? fallbackProfile(run, task) : run.lineup.implementers.find(profile => profile.id === task.agentProfileId) ?? fallbackProfile(run, task);
  }
  private reviewerProfile(run: TeamRun): TeamModelProfile | undefined {
    return run.lineup?.permissionReviewer ?? run.lineup?.coordinator;
  }
  private newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, prompt?: string, pinnedProfile?: TeamModelProfile, planMemberId?: string): TeamMember {
    this.assertBudget(run, true);
    const memberId = randomUUID();
    const task = role === "scout" ? run.discovery?.tasks.find(task => task.id === taskId) : run.tasks.find(task => task.id === taskId);
    let selected = pinnedProfile ?? this.memberProfile(run, role, task);
    const now = this.currentDate(), targetProvider = selected?.provider ?? run.provider;
    const limit = this.limits.active(now).find(item => item.provider === targetProvider);
    const fallback = !run.replay && selected && limit && run.lineup ? resolveLimitFallback(run.lineup, selected.id, this.limits.limited(now), limitFallbackEligibility(run, role, planMemberId)) : undefined;
    const retargetedRaw = fallback && prompt !== undefined ? retargetPrompt(prompt, { provider: fallback.provider, profile: fallback, role, entryTools: entryToolsFor(run, role), ...(escalationRetargetFor(run, role, selected?.id, fallback.id) ? { escalation: escalationRetargetFor(run, role, selected?.id, fallback.id) } : {}) }) : undefined;
    const retargeted = retargetedRaw !== undefined && Buffer.byteLength(retargetedRaw, "utf8") <= TEAM_PROMPT_LIMIT_BYTES ? retargetedRaw : undefined;
    const switched = Boolean(selected && limit && fallback && (prompt === undefined || retargeted !== undefined));
    if (switched) {
      runEvent(run, `${selected!.label} launched on ${fallback!.label}: ${PROVIDER_NAMES[limit!.provider]} is limited until ${clock(limit!.expiresAt)}`);
      prompt = retargeted; selected = fallback;
    }
    const modelProfile = selected ? structuredClone(selected) : undefined;
    const provider = modelProfile?.provider ?? run.provider;
    const configuredProject = this.config.projects.find(project => project.id === run.projectId)?.team;
    const permissionRecoveryHistory = this.permissionRecoveryHistory(run);
    let instructions = prompt === undefined ? teamPrompt(run, role, task, undefined, provider, modelProfile, configuredProject, permissionRecoveryHistory, this.publishHeadsEnabled()) : refreshReportingInstructions(prompt, provider, role);
    if (role !== "permission-coordinator" && Buffer.byteLength(instructions) > 80 * 1024)
      instructions = teamPrompt(run, role, task, prompt, provider, modelProfile, configuredProject, permissionRecoveryHistory, this.publishHeadsEnabled());
    if (Buffer.byteLength(instructions) > 80 * 1024) throw new TeamError(409, "team-prompt-too-large", "The accumulated team requirements exceed the prompt limit. Start a new team with consolidated requirements.");
    return { runId: run.id, memberId, revision: run.revision, role, ...(role === "project-manager" && !run.establishChecks && !run.verification ? { verificationRefused: true as const } : {}), ...(entryToolsFor(run, role) ? { entryTools: true as const } : {}), ...(hostProfilesFor(run, role, modelProfile?.id) ? { hostProfiles: true as const } : {}), provider, ...(modelProfile ? { modelProfile } : {}), ...(taskId ? { taskId } : {}), ...(limit && !switched ? { pendingLimit: true } : {}), sessionId: randomUUID(), title: `${role}: ${taskId ?? run.title}`.slice(0, 100), status: "queued", cwd, baseCommit, prompt: instructions, ...(prompt ? { contextFeedback: prompt } : {}), cursor: 0, stopRequestId: randomUUID() };
  }
  private readMemberJournal(stored: Stored, member: TeamMember, exited = false, singlePage = false) {
    const run = stored.run;
    let page: ReturnType<Manager["events"]>, limit: LimitSwitch | undefined;
    do {
      page = this.manager.events(member.sessionId, member.cursor, 200, new Set(["team-report", "signal"]));
      member.cursor = page.cursor;
      for (const event of page.events) {
        if (event.type === "signal") {
          const data = event.data;
          if (switchesMember(data)) { if (!limit || (limit.confidence !== "corroborated" && data.confidence === "corroborated")) limit = { ...data, at: event.at, seq: event.seq }; }
          else if (recoveryTurnEnd(data as unknown as SignalData) || (data.kind === "notice" && data.type === "quota_auto_resume_fired")) limit = undefined;
          continue;
        }
        const parsed = recordedTeamReportEnvelopeSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const envelope = parsed.data;
        if (envelope.runId !== run.id || envelope.memberId !== member.memberId || envelope.revision !== member.revision) continue;
        member.report = member.role === "intent-checker" ? this.intentChecks.screen(stored, member, envelope.report) : member.role === "evaluator" ? this.verdicts.screen(stored, member, envelope.report) : envelope.report; member.status = "reported"; member.reportedAt = timestamp(); member.stalledAt = undefined; member.spinnerOnlySince = undefined;
        if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
        if (member.role !== "permission-coordinator") this.emitWith(stored, "member.reported", [member.memberId],
          { memberId: member.memberId, taskId: member.taskId, revision: member.revision }, () => ({ role: member.role, reportKind: envelope.report.kind }));
        break;
      }
    } while (!singlePage && !member.report && (exited || limit) && page.more);
    return { page, limit };
  }
  private async replaceStalledMember(stored: Stored, member: TeamMember, attentionState: AttentionState = "working", activePrompt?: LivePromptRef | null) {
    if (stored.run.replay) return void this.replays.end(stored, "stalled");
    const run = stored.run, minutes = this.stallWindowFor(member) / 60000;
    const pre = this.evalStall(stored, member, attentionState, true, "detect", activePrompt);
    if (pre.action === "suppress-duplicate") { member.status = "stopped"; this.save(stored); return; }
    if (pre.action !== "initiate-stop") return;
    const earlierStop = Boolean(member.stalledAt);
    member.stalledAt ??= timestamp();
    member.stoppedReason ??= `No activity for ${minutes} minutes`;
    this.save(stored);
    let exited;
    try { exited = await this.stopped(member); if (!exited) { this.save(stored); return; } }
    catch (error) {
      const refused = error instanceof TeamStopRefused || error instanceof Error && ["control-busy", "control-lost"].includes((error as WorkerError).code ?? "");
      if (refused && !earlierStop) {
        member.stalledAt = undefined;
        if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
      }
      member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); return;
    }
    const { page, limit } = this.readMemberJournal(stored, member, true);
    if (member.report) { this.save(stored); return; }
    if (page.more || member.cursor < exited.seq) { member.status = "unavailable"; this.save(stored); return; }
    if (limit) { member.stalledAt = undefined; if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined; await this.switchLimitedMember(stored, member, limit); return; }
    this.memberStopped(stored, member, "stall");
    if (this.intentChecks.failed(stored, member) || this.verdicts.failed(stored, member)) return;
    const decision = this.evalStall(stored, member, attentionState, true, "replace", activePrompt);
    if (decision.action === "block") { if (decision.code === "goal-deadline" && (run.goal || run.handoff)) run.stopReason = "deadline"; if (decision.code === "team-attempt-limit" && (run.goal || run.handoff)) run.stopReason = "member-limit"; return this.block(stored, new TeamError(409, decision.code, decision.message)); }
    if (decision.action !== "replace") { if (decision.action !== "wait") this.save(stored); return; }
    const task = member.role === "implementer" ? run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const scout = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const prefix = this.config.teams?.commandPrefix, editing = decision.editing, note = `The previous ${member.role} stalled with no activity for ${minutes} minutes before reporting. Its workspace was preserved. ${editing ? "Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing." : "Its working copy was checked unchanged; complete the same assignment."}`;
    this.operation(stored, "result", signal => editing ? assertMemberScope(member.cwd, member.baseCommit, task ? task.paths : run.goal?.allowedPaths, prefix, signal) : assertMemberReadOnly(member.cwd, member.baseCommit, prefix, signal), () => {
      if (run.members.some(item => item !== member && item.stalledSourceMemberId === member.memberId)) return;
      const next = this.newMember(run, member.role, member.cwd, member.baseCommit, member.taskId, `${member.prompt}\n\n${note}`, member.modelProfile);
      next.stalledSourceMemberId = member.memberId; next.contextFeedback = [member.contextFeedback ?? member.prompt, note].filter(Boolean).join("\n\n");
      if (task) { task.memberId = next.memberId; task.status = "running"; }
      if (scout) scout.memberId = next.memberId;
      run.members.push(next); this.linkReplacement(stored, next, member, "stall");
      this.event(stored, `${member.title} stalled with no activity for ${minutes} minutes; its workspace was preserved and a replacement continues the assignment.`);
    });
  }
  private async switchLimitedMember(stored: Stored, member: TeamMember, limit: LimitSwitch) {
    if (stored.run.replay) return void this.replays.end(stored, "void-limit", limit.resetsAt);
    const run = stored.run, provider = member.provider ?? run.provider, name = PROVIDER_NAMES[provider];
    const kind = limit.limit === "credits" ? "credit limit" : "usage limit", resets = limit.resetsAt ? clock(limit.resetsAt) : undefined;
    if (limit.confidence === "corroborated") this.limits.observe({ provider, detectedAt: limit.at, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), sessionId: member.sessionId, runId: run.id, confidence: "corroborated" });
    try { if (!await this.stopped(member)) { member.cursor = limit.seq - 1; this.save(stored); return; } }
    catch { member.cursor = limit.seq - 1; member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); return; }
    member.stoppedReason = `${name} ${kind}${resets ? `, resets ${resets}` : ""}`;
    if (member.role === "permission-coordinator") {
      const decision = permissionCoordinatorDecision(run, member);
      if (decision && ["pending", "reviewing"].includes(decision.status)) {
        decision.status = "escalated";
        decision.reason = "The permission reviewer reached a provider limit; the request remains with the user.";
      }
      member.status = "waiting";
      member.report = undefined;
      this.event(stored, "The permission reviewer reached a provider limit; the request remains with the user.");
      this.save(stored);
      return;
    }
    this.memberStopped(stored, member, "limit");
    if (this.intentChecks.failed(stored, member) || this.verdicts.failed(stored, member)) return;
    if (member.role === "delivery" && stored.deliveryAttempt) {
      this.block(stored, new TeamError(409, "delivery-reconciliation-required", "The delivery provider stopped at a limit. Inspect the remote branch and PR before replacing a possibly completed publication.")); return;
    }
    const from = member.modelProfile, selected = from && run.lineup ? switchFallback(run.lineup, from.id, provider, this.limits.limited(this.currentDate()), limitFallbackEligibility(run, member.role, stored.intentCheck?.planMemberId)) : undefined;
    const fallback = selected;
    if (!from || !fallback) {
      this.block(stored, new TeamError(409, "provider-limit", `${name} ${kind} reached at ${clock(limit.at)}${resets ? `, resets ${resets}` : ""}; no fallback profile is configured for ${from?.id ?? provider}.`));
      return;
    }
    const task = member.role === "implementer" ? run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    const scout = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const prefix = this.config.teams?.commandPrefix, editing = member.role === "implementer" || member.role === "integrator";
    const note = editing ? `The previous ${member.role} stopped at a ${name} ${kind}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`
      : `The previous ${member.role} stopped at a ${name} ${kind} before reporting. Its working copy was checked unchanged; complete the same assignment.`;
    this.operation(stored, "result", signal => editing ? assertMemberScope(member.cwd, member.baseCommit, task ? task.paths : run.goal?.allowedPaths, prefix, signal) : assertMemberReadOnly(member.cwd, member.baseCommit, prefix, signal), () => {
      const configuredProject = this.config.projects.find(project => project.id === run.projectId)?.team;
      const carried = retargetPrompt(member.prompt, { provider: fallback.provider, profile: fallback, role: member.role, entryTools: entryToolsFor(run, member.role), ...(escalationRetargetFor(run, member.role, from.id, fallback.id, member.hostProfiles === true) ? { escalation: escalationRetargetFor(run, member.role, from.id, fallback.id, member.hostProfiles === true) } : {}) }) ?? [teamPrompt(run, member.role, task ?? scout, undefined, fallback.provider, fallback, configuredProject, this.permissionRecoveryHistory(run), this.publishHeadsEnabled()),
        ...run.decisions.filter(decision => decision.answer && run.members.some(prior => prior.memberId === decision.memberId && prior.role === member.role && prior.taskId === member.taskId && prior.revision === member.revision)).map(decision => `${decisionAnswerLabel(decision)} answered: ${decision.answer}`)].join("\n\n");
      const next = this.newMember(run, member.role, member.cwd, member.baseCommit, member.taskId, `${carried}\n\n${note}`, fallback);
      next.contextFeedback = [member.contextFeedback ?? member.prompt, note].filter(Boolean).join("\n\n");
      if (task) {
        (task.limitSwitches ??= []).push({ fromProfileId: from.id, toProfileId: fallback.id, reason: limit.message, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), memberId: member.memberId, at: timestamp() });
        task.memberId = next.memberId; task.status = "running";
      }
      if (scout) scout.memberId = next.memberId;
      if (member.role === "permission-coordinator") {
        const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
        if (decision && decision.status === "reviewing") decision.coordinatorMemberId = next.memberId;
      }
      run.members.push(next);
      this.linkReplacement(stored, next, member, "limit");
      this.emitWith(stored, "task.limit-switched", [member.memberId], { memberId: member.memberId, taskId: member.taskId, revision: member.revision }, () => ({
        role: member.role, fromProfileId: from.id, toProfileId: fallback.id,
      }));
      this.event(stored, `${from.label} hit a ${name} ${kind}${resets ? ` (resets ${resets})` : ""}; ${task?.title ?? member.title} continues on ${fallback.label}${editing ? " with partial work preserved" : ""}.`);
    });
  }
  private prepareMember(stored: Stored, role: TeamMember["role"], task?: TeamTask | TeamScout, feedback?: string, onPrepared?: (member: TeamMember) => void, prebuilt?: { prompt: string; profile: TeamModelProfile }, onFailed?: () => void) {
    if (this.publicationGate(stored, role)) return;
    const run = stored.run, routed = task && run.routing && this.router && (role === "implementer" || role === "scout") ? this.routerInput(run) : undefined;
    const start = routed && role === "implementer" ? { ...routed, run, task: task as TeamTask } : undefined, scout = routed && role === "scout" ? { run, scout: task as TeamScout, limited: routed.limited, featureMap: routed.featureMap } : undefined;
    const member = this.newMember(run, role, "", run.headCommit!, task?.id, prebuilt?.prompt, prebuilt?.profile ?? (start && autoPinned(run) ? this.router!.applyStart(start) : scout ? this.router!.routeScout(scout) : undefined), stored.intentCheck?.planMemberId);
    if (role === "project-manager" && run.goal?.record) member.goalCriteriaPlan = { objectiveVersion: run.goal.record.version };
    if (start) this.router!.recordStart(start);
    const continuationHead = role === "project-manager" && stored.continuationHead?.revision === run.revision
      ? structuredClone(stored.continuationHead) : undefined;
    if (feedback) {
      member.contextFeedback = feedback;
      member.prompt = teamPrompt(run, role, task, feedback, member.provider ?? run.provider, member.modelProfile,
        this.config.projects.find(project => project.id === run.projectId)?.team, this.permissionRecoveryHistory(run), this.publishHeadsEnabled());
    }
    if (role !== "permission-coordinator") run.status = activeStageForRole(role);
    let failure: string | undefined;
    this.operation(stored, "member", async signal => {
      this.assertRunPath(stored, run.workspace);
      if (continuationHead) await assertMemberReadOnly(run.workspace, continuationHead.headCommit, this.config.teams?.commandPrefix, signal, "integration");
      let cwd: string;
      try { cwd = run.replay ? run.workspace : await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.config.teams?.commandPrefix, signal); }
      catch (error) { if (!onFailed || signal.aborted || (error instanceof TeamError && error.code === "team-root-unsafe")) throw error; failure = error instanceof TeamError ? error.code : "workspace-operation-failed"; return undefined; }
      this.assertRunPath(stored, cwd);
      if (continuationHead) await assertMemberReadOnly(run.workspace, continuationHead.headCommit, this.config.teams?.commandPrefix, signal, "integration");
      const setup = role === "permission-coordinator" || role === "intent-checker" || role === "evaluator" || role === "judge" ? undefined : run.establishChecks
        ? role === "reviewer" ? run.verification?.setup : undefined
        : this.config.projects.find(project => project.id === run.projectId)!.team!.setup;
      if (setup) {
        const setupCommand = this.replays.setupFor(run, this.config.teams?.commandPrefix); const result = await teamCommand(setup, cwd, signal, 600000, setupCommand.prefix, setupCommand.input);
        await this.noteLeftover(stored, result);
        if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "team-setup-failed", "A member's configured setup command failed. Its isolated workspace was preserved.");
        await assertMemberReadOnly(cwd, member.baseCommit, this.prefixFor(run), signal, "setup");
      }
      if (role !== "permission-coordinator" && this.options?.graphs && !run.replay) {
        let graph: RepositoryGraphResult;
        try {
          graph = await this.options.graphs.refresh(run.projectId, cwd, member.baseCommit, `run-${run.id}`, signal);
        } catch (error) {
          graph = { status: "failed", requestedHead: member.baseCommit, reason: error instanceof Error ? error.message.slice(0, 300) : "Graph refresh unavailable." };
        }
        const ready = ["ready", "unchanged"].includes(graph.status) && graph.head === member.baseCommit && graph.graphPath;
        member.prompt += ready
          ? `\n\nRepository graph checkpoint: available at ${graph.graphPath} for exact checkout head ${member.baseCommit}. This code-only Graphify artifact is advisory; verify relevant claims against source files. Do not treat it as approval or permission.`
          : `\n\nRepository graph checkpoint: unavailable for exact checkout head ${member.baseCommit}${graph.reason ? ` (${graph.reason})` : graph.head ? `; last successful artifact is for a different head and must be treated as stale` : ""}. Search the checkout source directly. Graph refresh status is advisory and does not affect permissions or approval.`;
      }
      return cwd;
    }, cwd => {
      if (cwd === undefined) { this.event(stored, `${member.title}'s working copy could not be prepared (${failure}). The run goes on without it.`); onFailed?.(); return; }
      if (continuationHead && stored.continuationHead?.revision === continuationHead.revision && stored.continuationHead.headCommit === continuationHead.headCommit)
        delete stored.continuationHead;
      member.cwd = cwd; run.members.push(member);
      if (task) { task.status = "running"; task.memberId = member.memberId; }
      onPrepared?.(member);
      this.event(stored, `${member.title} queued in an isolated working copy.`);
    });
  }
  private routerInput(run: TeamRun) {
    return { publishHeads: this.publishHeadsEnabled(), entryTools: entryToolsFor(run, "implementer"), objectiveDigest: objectivePromptOf(run), codeMode: memberCodeModeExpected(this.config),
      limited: this.limits.limited(this.currentDate()), featureMap: (run.handoff?.project ?? this.config.projects.find(project => project.id === run.projectId)?.team)?.features };
  }
  private rebuildDeliveryPrompts(stored: Stored, target?: TeamMember): () => void {
    const run = stored.run, members = target ? [target] : run.members.filter(m => m.role === "delivery" && m.revision === run.revision && m.status === "queued");
    const saved = members.filter(m => !this.hasLaunch(m) && deliveryPromptStale(run, m)).map(m => ({ m, prompt: m.prompt, scratch: m.scratchDirectory }));
    for (const { m } of saved) { m.prompt = teamPrompt(run, "delivery", undefined, m.contextFeedback, m.provider ?? run.provider, m.modelProfile, this.config.projects.find(p => p.id === run.projectId)?.team, this.permissionRecoveryHistory(run), this.publishHeadsEnabled()); delete m.scratchDirectory; }
    return () => { for (const { m, prompt, scratch } of saved) { m.prompt = prompt; if (scratch === undefined) delete m.scratchDirectory; else m.scratchDirectory = scratch; } };
  }
  private async launch(stored: Stored, member: TeamMember) {
    if (member.entryTools === true) this.entryQueue.add(stored.run.id, member.memberId);
    if (this.publicationGate(stored, member.role)) return;
    const run = stored.run;
    if (member.role === "delivery" && run.pullRequest && !pullRequestBranch(run) && !this.reviewFeedback.ensureLegacyPullRequestBranch(stored)) return;
    if (member.role === "delivery" && !this.hasLaunch(member) && deliveryPromptStale(run, member)) { this.rebuildDeliveryPrompts(stored, member); this.save(stored); }
    this.assertBudget(stored.run);
    this.assertRunPath(stored, member.cwd);
    if (!this.hasLaunch(member)) {
      const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true) ?? stored.run.linear;
      if (JSON.stringify(stored.run.linear) !== JSON.stringify(tracking)) { stored.run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked") throw new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work.");
      if (tracking && tracking.status !== "synced") return;
    }
    if (this.fuse && !this.hasLaunch(member) && this.fuseWait(stored, this.fuse.check({ projectId: stored.run.projectId, role: member.role }))) return;
    let pendingSwitch: Extract<ReturnType<typeof evaluateLaunchAdmission>, { proceed: true }>["pendingSwitch"];
    if (!this.hasLaunch(member)) {
      const now = this.currentDate(), activeLimits = this.limits.active(now), hostLoadReason = this.manager.hostLoad.held();
      if (run.replay) { const limit = activeLimits.find(item => item.provider === (member.provider ?? run.provider)); if (limit) { this.replays.end(stored, "void-limit", limit.resetsAt ?? limit.expiresAt); return; } }
      const workerCapacityFull = (member.role === "scout" || member.role === "implementer") && run.members.filter(other => other !== member && holdsWorkerSlot(other, run.revision) && (isDeferredWorkerMember(member) || other.status !== "queued")).length >= run.parallelism;
      const sessionSlotFull = !hostLoadReason && (await this.manager.list()).filter(session => session.status === "running" || session.status === "starting").length >= this.config.maxSessions;
      const gate = evaluateLaunchAdmission(run, member, activeLimits, this.limits.limited(now), SESSION_SLOT_REASON, text => this.event(stored, text), { planMemberId: stored.intentCheck?.planMemberId, workerCapacityFull, hostLoadReason, sessionSlotFull });
      if (gate.changed) this.save(stored);
      if (!gate.proceed) return;
      pendingSwitch = gate.pendingSwitch;
    }
    if (member.role === "delivery") {
      this.assertDelivery(stored);
      if (!this.hasLaunch(member) && this.holdAutomaticMerge(stored, member)) return;
      const attempt = stored.deliveryAttempt;
      if (attempt && (attempt.memberId !== member.memberId || attempt.revision !== member.revision || attempt.headCommit !== member.baseCommit))
        throw new TeamError(409, "delivery-reconciliation-required", "A different delivery attempt is unresolved; inspect the remote pull request before continuing.");
      await assertMemberReadOnly(stored.run.workspace, member.baseCommit, this.prefixFor(run), undefined, "integration");
      stored.deliveryAttempt = { memberId: member.memberId, revision: member.revision, headCommit: member.baseCommit };
      if (stored.run.deliveryRecovery && ["planning", "replanning"].includes(stored.run.deliveryRecovery.status)) {
        stored.run.deliveryRecovery.revision = member.revision;
        stored.run.deliveryRecovery.headCommit = member.baseCommit;
        stored.run.deliveryRecovery.policyHash = digest(stored.run.delivery!);
        stored.run.deliveryRecovery.sourceMemberId = member.memberId;
        stored.run.deliveryRecovery.status = "planning";
      }
      this.save(stored);
    }
    const undoSwitch = pendingSwitch ? commitProviderLimitSwitch(run, member, pendingSwitch, text => this.event(stored, text)) : () => false;
    if (!this.hasLaunch(member) && member.role !== "permission-coordinator") {
      if (!member.scratchDirectory && !stored.run.replay) {
        member.scratchDirectory = prepareMemberScratch(stored.run.workspace, member.memberId);
        member.prompt += `\n\nHost-assigned task scratch directory: ${member.scratchDirectory}. Use this directory for temporary scripts, browser probes, and generated check outputs. Keep repository files unchanged in read-only roles. This directory belongs only to your current assignment; do not read other members' scratch files.`;
        this.save(stored);
      }
      const configuredProject = stored.run.handoff?.project ?? this.config.projects.find(project => project.id === stored.run.projectId)?.team;
      const intentContext = member.role === "intent-checker" ? this.intentChecks.context(stored, member) : member.role === "evaluator" ? this.verdicts.context(stored, member) : member.role === "judge" ? this.replays.judgeContext(stored, member) : undefined; if (intentContext === null) { if (undoSwitch()) this.save(stored); return; }
      const launchSeq = this.options?.entries?.launchMark(stored.run.id);
      const digest = intentContext ? undefined : this.options?.entries?.memberDigest(stored.run, member, launchSeq);
      const contextBytes = await writeTeamContext(member.cwd, { ...(intentContext ?? teamContext(stored.run, member.contextFeedback, configuredProject, member.role, this.permissionRecoveryHistory(stored.run))), ...(digest ? { entries: digest } : {}), ...(member.role === "judge" ? {} : { assignment: assignment(member, true) }), memberBaseCommit: member.baseCommit, scratchDirectory: member.scratchDirectory }, this.prefixFor(run));
      this.options?.entries?.recordLaunch(stored.run, member, { launchSeq, promptBytes: Buffer.byteLength(member.prompt, "utf8"), contextBytes, digestBytes: digest ? Buffer.byteLength(canonicalJson(digest), "utf8") : 0 });
    }
    if (this.fuse && !this.hasLaunch(member) && this.fuseWait(stored, this.fuse.admit(workLaunch({ launchId: member.sessionId, projectId: stored.run.projectId,
      provider: member.provider ?? stored.run.provider, team: assignment(member), profile: member.modelProfile })))) { if (undoSwitch()) this.save(stored); return; }
    let result;
    const request = { requestId: member.sessionId, provider: member.provider ?? stored.run.provider,
      projectId: stored.run.projectId, title: member.title, prompt: member.prompt,
      ...(member.role === "permission-coordinator" ? { continuation: member.continuation } : {}) };
    const delivery = stored.run.delivery;
    const github = stored.run.replay ? undefined : sessionGithubScope({ kind: "team", role: member.role,
      repository: delivery?.repository ?? projectGithubRepository(this.config.projects.find(project => project.id === stored.run.projectId)),
      ...(delivery && teamDeliveryBranch(stored.run) ? { delivery: { mode: delivery.mode, repository: delivery.repository, headBranch: teamDeliveryBranch(stored.run)! } } : {}) });
    try { result = await this.startInProject(stored.run.projectId, () => this.manager.createTeamSession(request, assignment(member), member.cwd, member.modelProfile, stored.root, this.replays.trusted(stored.run), this.replays.header(stored.run), github)); }
    catch (error) {
      this.fuse?.release(member.sessionId);
      if (error instanceof LaunchHeldError) { const rolled = undoSwitch(); if (applyLaunchHoldReason(stored.run, error.reason, SESSION_SLOT_REASON) || rolled) this.save(stored); return; }
      if (error instanceof Error && /configured session limit/.test(error.message)) { const rolled = undoSwitch(); if (applyLaunchHoldReason(stored.run, resolveLaunchHoldReason(stored.run, this.limits.active(this.currentDate()), SESSION_SLOT_REASON, { sessionSlotFull: true }), SESSION_SLOT_REASON) || rolled) this.save(stored); return; }
      if (error instanceof TeamError && (error.code === "fuse-open" || error.code === "halted")) { const rolled = undoSwitch(); if (stored.run.reason !== error.message) { stored.run.reason = error.message; this.save(stored); } else if (rolled) this.save(stored); return; }
      throw error;
    }
    applyLaunchHoldReason(stored.run, resolveLaunchHoldReason(stored.run, this.limits.active(this.currentDate()), SESSION_SLOT_REASON), SESSION_SLOT_REASON);
    member.status = result.status === "unavailable" ? "unavailable" : "running";
    member.startedAt ??= timestamp();
    const turn = member.turns?.at(-1);
    if (turn?.sessionId === member.sessionId) turn.startedAt = member.startedAt;
    const replaces = stored.ledgerReplaces?.[member.memberId];
    if (member.role !== "permission-coordinator") this.emitWith(stored, "member.started", [member.memberId],
      { memberId: member.memberId, taskId: member.taskId, revision: member.revision }, () => ({
        role: member.role, purpose: run.replay?.purpose ?? "work", sessionId: member.sessionId, startedAt: member.startedAt, baseCommit: member.baseCommit,
        ...profileIdentity(member.modelProfile, member.provider ?? run.provider),
        ...(result.status === "unavailable" ? { unavailable: true } : {}), ...(replaces ? { replaces } : {}),
      }));
    if (member.role !== "permission-coordinator") {
      const captured = { memberId: member.memberId, taskId: member.taskId, revision: member.revision, workspace: stored.run.workspace,
        baseCommit: member.baseCommit, role: member.role, provider: member.provider ?? run.provider, profile: member.modelProfile,
        publishHeads: this.publishHeadsEnabled(), prefix: this.prefixFor(run), entryTools: Boolean(member.entryTools), objectiveDigest: objectivePromptOf(stored.run), routing: routingComponent(stored.run), shape: run.replay ? "trial" as const : "team" as const, codeMode: result.codeMode === true };
      this.enrich(stored, async signal => {
        const data = await memberConfiguration(captured, signal);
        if (!data) return undefined;
        return () => this.emitWith(stored, "member.configured", [captured.memberId],
          { memberId: captured.memberId, taskId: captured.taskId, revision: captured.revision }, () => configuredData(data));
      });
    }
    if (stored.ledgerReplaces) {
      delete stored.ledgerReplaces[member.memberId];
      if (!Object.keys(stored.ledgerReplaces).length) delete stored.ledgerReplaces;
    }
    this.save(stored);
  }
  private holdForHostLoad(stored: Stored, reason: string) {
    if (applyLaunchHoldReason(stored.run, reason, SESSION_SLOT_REASON)) this.save(stored);
  }
  private applyProjectManagerCapacity(stored: Stored, requested?: number) {
    const run = stored.run, ceiling = capacityCeiling(run), limit = requested ?? ceiling;
    if (limit > ceiling)
      throw new TeamError(409, "team-parallelism-limit", `The project manager selected ${limit} workers, above this run's capacity ceiling of ${ceiling}.`);
    const previous = run.parallelism;
    run.parallelism = limit;
    this.event(stored, `The project manager set the worker limit from ${previous} to ${limit} (capacity ceiling ${ceiling}).`);
  }
  private consume(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    if (stored.run.replay && this.replays.consume(stored, member)) return;
    if (member.role === "permission-coordinator") { this.consumePermissionCoordinator(stored, member); return; }
    if (member.role === "intent-checker") { this.intentChecks.consume(stored, member); return; }
    if (member.role === "evaluator") { this.verdicts.consume(stored, member); return; }
    if (report.kind === "blocked") { this.block(stored, new TeamError(409, "agent-blocked", report.summary), member); return; }
    if (report.kind === "question" && ["implementer", "scout", "integrator", "reviewer"].includes(member.role)) {
      this.block(stored, new TeamError(409, "agent-question", agentQuestionReason(member.role, report)), member); return;
    }
    if (report.kind === "question") {
      if (run.decisions.length >= 40) { this.block(stored, new TeamError(409, "team-decision-limit", "The team reached its limit of 40 decisions. Review its evidence before starting another team.")); return; }
      member.status = "waiting";
      run.decisions.push({ id: randomUUID(), memberId: member.memberId, revision: run.revision, question: report.question, options: report.options,
        ...(report.answerMode ? { answerMode: report.answerMode } : {}), ...(report.recommendation ? { recommendation: { ...report.recommendation } } : {}), createdAt: timestamp() });
      const task = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId) : run.tasks.find(item => item.id === member.taskId); if (task) task.status = "waiting";
      run.status = "needs-input"; this.event(stored, `${member.title} requested a user decision.`); this.save(stored); return;
    }
    const expected = member.role === "project-manager" ? ["plan", "explore", "no-change"] : member.role === "scout" ? ["findings"] : member.role === "reviewer" ? ["review"] : member.role === "delivery" ? ["delivery", "delivery-repair", "delivery-reconciliation", "pull-request"] : member.role === "implementer" ? ["result", "escalate"] : ["result"];
    if (!expected.includes(report.kind)) { this.block(stored, new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role."), member); return; }
    if (report.kind === "no-change") {
      if (this.verdicts.holdNoChange(stored, member)) return;
      if (member.role !== "project-manager" || run.tasks.length || run.headCommit !== run.baseCommit) {
        this.block(stored, new TeamError(409, "invalid-no-change", invalidNoChangeReason), member); return;
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal);
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.prefixFor(run), signal, "integration");
      }, () => {
        run.noChange = { summary: report.summary, evidence: report.evidence }; run.status = "no-change"; run.reason = undefined;
        if (run.recovery) run.recovery.status = "complete";
        this.event(stored, "The coordinator reported no justified change and recorded its evidence. No implementation was started.");
      }, member); return;
    }
    if (report.kind === "explore") {
      if (run.discovery || run.tasks.length || !run.lineup) throw new TeamError(409, "discovery-already-used", "A team may request one read-only discovery batch before implementation planning.");
      if (new Set(report.tasks.map(task => task.id)).size !== report.tasks.length) throw new TeamError(409, "invalid-discovery", "Discovery task IDs must be unique.");
      assertTaskProfiles(run, report.tasks, "scouts");
      assertPlannerCapacity(run, report.parallelism);
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal), () => {
        this.applyProjectManagerCapacity(stored, report.parallelism);
        run.discovery = { revision: run.revision, summary: report.summary, tasks: report.tasks.map(task => ({ ...task, status: "pending" })) };
        run.status = "discovering";
        this.event(stored, `The coordinator requested ${report.tasks.length} read-only discovery tasks.`);
        const map = (run.handoff?.project ?? this.config.projects.find(project => project.id === run.projectId)?.team)?.features;
        this.emitWith(stored, "discovery.accepted", [member.revision], { memberId: member.memberId, revision: member.revision }, () => ({
          parallelism: run.parallelism,
          scouts: (run.discovery?.tasks ?? []).map(scout => ({
            taskId: scout.id, ...(scout.agentProfileId === undefined ? {} : { profileId: scout.agentProfileId }), features: taskFeatures({ role: "scout", paths: [] }, map),
          })),
        }));
      }, member); return;
    }
    if (report.kind === "findings") {
      const scout = run.discovery?.tasks.find(task => task.id === member.taskId && task.memberId === member.memberId);
      if (!scout || run.discovery?.revision !== run.revision) throw new TeamError(409, "invalid-discovery", "The scout does not belong to the current discovery batch.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal), () => {
        scout.status = "complete"; scout.summary = report.summary; scout.evidence = report.evidence;
        this.event(stored, `${member.title} returned evidence without changing its working copy.`);
        this.emitWith(stored, "scout.completed", [member.revision, scout.id], { memberId: member.memberId, taskId: scout.id, revision: member.revision }, () => ({}));
      }, member); return;
    }
    if (report.kind === "escalate") {
      const task = run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId);
      const named = escalationPool(run).find(item => item.id === report.agentProfileId && item.id !== member.modelProfile?.id);
      const profile = !task || task.escalation || (report.agentProfileId !== undefined && !named) || !run.routing || !this.router ? named
        : this.router.routeEscalation({ ...this.routerInput(run), run, task, ownProfileId: member.modelProfile?.id, namedProfileId: named?.id }) ?? named;
      if (!task || task.escalation || !profile || profile.id === member.modelProfile?.id)
        throw new TeamError(409, "invalid-escalation", "An implementer may escalate once to a different profile in the approved escalation pool.");
      this.operation(stored, "result", signal => assertMemberScope(member.cwd, member.baseCommit, task.paths, this.prefixFor(run), signal), () => {
        task.escalation = { ...(member.modelProfile ? { fromProfileId: member.modelProfile.id } : {}), toProfileId: profile.id, reason: report.reason, memberId: member.memberId, at: timestamp() };
        this.emitWith(stored, "task.escalated", [member.revision, task.id], { memberId: member.memberId, taskId: task.id, revision: member.revision }, () => ({
          fromProfileId: task.escalation?.fromProfileId, toProfileId: task.escalation?.toProfileId,
        }));
        const next = this.newMember(run, "implementer", member.cwd, member.baseCommit, task.id, undefined, profile), escalationNote = `The previous implementer requested escalation: ${report.reason}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`;
        next.contextFeedback = [member.contextFeedback ?? member.prompt, escalationNote].filter(Boolean).join("\n\n");
        next.prompt = teamPrompt(run, "implementer", task, escalationNote, next.provider ?? run.provider, next.modelProfile);
        run.members.push(next); this.linkReplacement(stored, next, member, "escalation"); task.memberId = next.memberId; task.status = "running";
        run.status = "implementing";
        this.event(stored, `${task.title} escalated to ${profile.label}; the stopped member's partial work was preserved.`);
      }, member); return;
    }
    if (report.kind === "plan") {
      validateTeamPlan(report.tasks);
      try { validateGoalTaskCriterionRefs(report.tasks, member.goalCriteriaPlan, run.goal?.record); }
      catch (error) {
        if (!(error instanceof TeamError) || error.code !== "goal-task-criteria-invalid" || !run.goal?.record || stored.goalPlanCorrectionRevision === run.revision) throw error;
        stored.goalPlanCorrectionRevision = run.revision;
        this.event(stored, `The plan needs corrected objective links. ${error.message}`);
        this.prepareMember(stored, "project-manager", undefined, plannerCorrectionFeedback(run, error.message));
        this.save(stored); return;
      }
      assertTaskProfiles(run, report.tasks, "plan");
      assertPlannerCapacity(run, report.parallelism);
      if (report.verification && !run.establishChecks && !run.verification) {
        if (run.verificationCorrections?.includes(run.revision)) {
          this.block(stored, new TeamError(409, "verification-not-authorized", "A plan cannot replace the project's configured checks."));
          return;
        }
        run.verificationCorrections = [...(run.verificationCorrections ?? []), run.revision];
        const message = "Plan rejected: this run uses the project's configured checks. Remove verification and submit a corrected plan. If the checks seem insufficient, explain that in the summary and assign tasks to run additional commands themselves and report results.";
        this.event(stored, "The project manager's plan included unauthorized verification; requesting a corrected plan.");
        this.save(stored);
        this.prepareMember(stored, "project-manager", undefined, plannerCorrectionFeedback(run, message));
        return;
      }
      const tasks = plannedTasks(run, report, member.revision);
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal), () => {
        if (this.intentChecks.hold(stored, member)) return;
        this.applyProjectManagerCapacity(stored, report.parallelism);
        run.tasks = tasks;
        applyTeamBriefTitle(run, report.brief, member.revision);
        if (report.verification && !run.verification) {
          run.verification = structuredClone(report.verification);
          this.event(stored, "The coordinator established verification commands under the owner's project opt-in.");
        }
        run.status = "implementing";
        const objectiveNote = runObjectiveNote(stored, planRunObjective(stored, member.memberId, timestamp())); if (objectiveNote) this.event(stored, objectiveNote);
        this.event(stored, `Project manager planned ${run.tasks.length} tasks.`);
        const map = (run.handoff?.project ?? this.config.projects.find(project => project.id === run.projectId)?.team)?.features;
        this.emitWith(stored, "plan.accepted", [member.revision], { memberId: member.memberId, revision: member.revision }, () => ({
          taskCount: run.tasks.length, planDigest: planDigest(run.tasks), parallelism: run.parallelism,
        }));
        for (const task of run.tasks) this.emitWith(stored, "task.planned", [member.revision, task.id], { taskId: task.id, revision: member.revision }, () => ({
          profileId: task.agentProfileId,
          ...(task.criterionRefs && { criterionRefs: task.criterionRefs }),
          ...pathField(task.paths),
          features: taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, map),
        }));
      }, member); return;
    }
    if (report.kind === "delivery-reconciliation") {
      const { run } = stored;
      const attempt = stored.deliveryAttempt;
      if (!run.delivery || report.repository !== run.delivery.repository || !deliveryBranchMatches(run, report.branch) ||
          report.headCommit !== run.headCommit || member.baseCommit !== run.headCommit || attempt?.memberId !== member.memberId ||
          attempt.revision !== run.revision || attempt.headCommit !== run.headCommit ||
          run.deliveryRecovery && (run.deliveryRecovery.status !== "planning" || run.deliveryRecovery.revision !== run.revision ||
            run.deliveryRecovery.headCommit !== run.headCommit || run.deliveryRecovery.policyHash !== digest(run.delivery)))
        throw new TeamError(409, "delivery-reconciliation-stale", "Structured delivery inspection must identify the current pinned repository, branch, and reviewed head for this attempt.");
      this.assertDelivery(stored);
      if (report.disposition === "no-publication" && (report.remoteHeadCommit !== undefined || report.pullRequestUrl !== undefined) ||
          report.disposition === "owned-branch" && (report.remoteHeadCommit !== report.headCommit || report.pullRequestUrl !== undefined) ||
          report.disposition === "pull-request" && (report.remoteHeadCommit !== report.headCommit || !report.pullRequestUrl))
        throw new TeamError(409, "delivery-remote-head-mismatch", "The inspected remote branch or pull request does not identify the exact reviewed head.");
      if (run.pullRequest && (report.disposition !== "pull-request" || report.pullRequestUrl?.toLowerCase() !== run.pullRequest.pullRequestUrl.toLowerCase()))
        throw new TeamError(409, "delivery-pull-request-recorded", "This run delivers only to its recorded pull request; report that pull request at the reviewed head, or report blocked.");
      if (report.disposition === "pull-request") {
        const reconciliationPullRequestUrl = report.pullRequestUrl;
        if (!reconciliationPullRequestUrl) throw new TeamError(409, "delivery-target-mismatch", "The inspected pull request URL is missing.");
        let url: URL;
        try { url = new URL(reconciliationPullRequestUrl); } catch { throw new TeamError(409, "delivery-target-mismatch", "The inspected pull request URL is invalid."); }
        const prefix = `/${run.delivery.repository}/pull/`.toLowerCase();
        if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.pathname.slice(prefix.length)))
          throw new TeamError(409, "delivery-target-mismatch", "The inspected pull request must belong to the configured repository.");
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.prefixFor(run), signal, "integration");
        if (report.disposition !== "no-publication" || report.baseHeadCommit === run.baseCommit) return undefined;
        if (run.goal || run.missionId || run.handoff)
          throw new TeamError(409, "delivery-baseline-parent-owned", "A moved-base delivery recovery requires standalone ownership; preserve this parent branch for explicit reconciliation.");
        const source = this.options?.source;
        if (!source?.isGithub(run.projectId))
          throw new TeamError(409, "delivery-baseline-source-unavailable", "The host cannot confirm the moved delivery base from its configured GitHub source.");
        this.assertBudget(run, true);
        const attempts = recoveriesUsed(run);
        if (attempts >= automaticRecoveryLimit)
          throw new TeamError(409, "delivery-recovery-exhausted", "The team exhausted its automatic delivery recovery allowance. Its reviewed work and remote evidence remain retained.");
        run.deliveryRecovery = { ...run.deliveryRecovery, attempts: attempts + 1, status: "planning", revision: run.revision,
          headCommit: report.headCommit, policyHash: digest(run.delivery!), sourceMemberId: member.memberId,
          baseHeadCommit: report.baseHeadCommit, disposition: report.disposition };
        run.recovery = { attempts: attempts + 1, status: "planning", source: { code: "delivery-baseline-conflict", memberId: member.memberId,
          revision: run.revision, reportKind: report.kind, reason: report.summary, at: timestamp() } };
        this.save(stored);
        const refreshed = await this.startInProject(run.projectId, () => source.refresh(run.projectId, { maxAgeMs: 0, signal }));
        if (refreshed.mode !== "github" || refreshed.repository !== run.delivery!.repository || refreshed.baseBranch !== run.delivery!.baseBranch ||
            refreshed.pending?.reason === "fetch-failed" || refreshed.mirrorHead !== report.baseHeadCommit)
          throw new TeamError(409, "delivery-baseline-source-mismatch", "The host could not confirm the exact reported base head from the pinned source repository and branch.");
        const originalWorkspace = run.workspace;
        const recovered = await prepareRecoveryWorkspaceFromSource(originalWorkspace, source.mirrorPath(run.projectId), randomUUID(), report.baseHeadCommit,
          this.prefixFor(run), signal, run.branch);
        this.assertRunPath(stored, recovered.workspace);
        await assertMemberReadOnly(recovered.workspace, report.baseHeadCommit, this.prefixFor(run), signal, "integration");
        if (await teamHead(originalWorkspace, this.prefixFor(run), signal) !== report.headCommit)
          throw new TeamError(409, "delivery-recovery-head-changed", "The original integration head changed while its fresh-base recovery copy was prepared.");
        return { workspace: recovered.workspace, originalWorkspace, baseHeadCommit: report.baseHeadCommit };
      }, result => {
        if (report.disposition === "pull-request" && run.delivery?.mode === "pr") {
          stored.deliveryAttempt = undefined;
          run.pullRequest = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl!, summary: report.summary, reportedAt: timestamp(), ...(run.pullRequest && !run.pullRequest.branch ? {} : { branch: report.branch }) };
          this.emitWith(stored, "delivery.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => ({
            method: "pull-request", headCommit: report.headCommit }));
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.event(stored, "The delivery coordinator reported an existing pull request for the exact reviewed head. Its repository state remains agent evidence; the owner can review it on GitHub.");
          return;
        }
        if (result) {
          const previousRevision = run.revision, oldBase = run.baseCommit, oldHead = run.headCommit!;
          const originalPath = relative(stored.root ?? this.config.teams?.workspaceDir ?? dirname(result.originalWorkspace), result.originalWorkspace).slice(0, 256);
          delete run.changes;
          for (const task of run.tasks) delete task.changedPaths;
          for (const continuation of run.continuations ?? []) for (const task of continuation.tasks) delete task.changedPaths;
          run.continuations = [...(run.continuations ?? []), {
            revision: previousRevision, requestId: randomUUID(), at: timestamp(),
            reason: "The delivery coordinator reported no publication after the configured base moved; original implementation and review history are retained.",
            baseCommit: oldBase, headCommit: oldHead, tasks: structuredClone(run.tasks), ...(run.review ? { review: structuredClone(run.review) } : {}),
            ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
          }];
          run.workspace = result.workspace; run.baseCommit = result.baseHeadCommit; run.headCommit = result.baseHeadCommit;
          stored.deliveryReviewLineage = rebaseDeliveryReviewLineage(stored.deliveryReviewLineage, oldHead, result.baseHeadCommit);
          run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
          this.emit(stored, "run.revision-advanced", [run.revision], {}, { cause: "moved-base", fromRevision: previousRevision, baseChanged: true });
          run.brief = undefined; run.noChange = undefined; stored.deliveryAttempt = undefined;
          const attempts = run.deliveryRecovery?.attempts ?? run.recovery?.attempts ?? 0;
          run.deliveryRecovery = { attempts, status: "replanning", revision: run.revision, headCommit: run.headCommit,
            policyHash: digest(run.delivery!), sourceMemberId: member.memberId, baseHeadCommit: result.baseHeadCommit, disposition: report.disposition };
          run.recovery = { attempts, status: "planning", source: { code: "delivery-baseline-conflict", memberId: member.memberId, revision: previousRevision,
            reportKind: report.kind, reason: report.summary, at: timestamp() } };
          const feedback = [
            "The delivery coordinator reported that nothing was published and the pinned base branch moved. The host refreshed the configured source and created this clean workspace at the exact reported base head.",
            `The original integration copy is preserved at ${result.originalWorkspace} (workspace path ${originalPath}). Read its diff from ${oldBase} to ${oldHead} without changing it; the implementation and review were not carried into this new workspace automatically.`,
            "Reconcile only the original approved changes into this workspace. Preserve both sides of any conflicting documentation or code rather than dropping either. Keep the existing objective and goal scope. Report only work actually applied; the host will capture and integrate it, then rerun configured checks and independent review before another delivery attempt.",
          ].join("\n\n");
          this.prepareMember(stored, "integrator", undefined, feedback);
          run.status = "planning"; run.reason = undefined; run.blockCode = undefined;
          this.event(stored, `The configured base moved to ${result.baseHeadCommit}; the old implementation copy remains preserved at ${originalPath}. An integrator must carry the authorized delta into the new base before checks and review run again.`);
          return;
        }
        this.queueDeliveryRetryAfterEvidence(stored, member, report);
      }, member); return;
    }
    if (report.kind === "delivery" || report.kind === "delivery-repair" || report.kind === "pull-request") {
      if ((report.kind === "delivery" && run.delivery?.mode !== "merge") || (report.kind === "pull-request" && run.delivery?.mode !== "pr"))
        throw new TeamError(409, "delivery-mode-mismatch", "The delivery report kind does not match the configured delivery mode.");
      this.assertDelivery(stored);
      if (report.headCommit !== run.headCommit || member.baseCommit !== run.headCommit || stored.deliveryAttempt?.memberId !== member.memberId)
        throw new TeamError(409, "stale-delivery", "Delivery evidence must name the checked and independently reviewed commit for this attempt.");
      if (run.deliveryRecovery && (run.deliveryRecovery.status !== "planning" || run.deliveryRecovery.revision !== run.revision ||
          run.deliveryRecovery.headCommit !== run.headCommit || run.deliveryRecovery.policyHash !== digest(run.delivery)))
        throw new TeamError(409, "delivery-recovery-stale", "The active automatic recovery no longer matches the delivery policy, revision, and reviewed head.");
      if (report.kind === "delivery" || report.kind === "pull-request") {
        let url: URL;
        try { url = new URL(report.pullRequestUrl); } catch { throw new TeamError(409, "delivery-target-mismatch", "The delivery report must name a valid pull request URL."); }
        const prefix = `/${run.delivery!.repository}/pull/`.toLowerCase();
        if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.pathname.slice(prefix.length)))
          throw new TeamError(409, "delivery-target-mismatch", "The pull request must belong to the configured repository.");
        if (report.kind === "pull-request" && run.pullRequest && report.pullRequestUrl.toLowerCase() !== run.pullRequest.pullRequestUrl.toLowerCase())
          throw new TeamError(409, "delivery-target-mismatch", "A continued delivery updates the run's recorded pull request; it cannot open another.");
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.prefixFor(run), signal, "integration");
        if (report.kind === "delivery") {
          await this.enqueue(stored.run.id, () => {
            if (this.closed) return;
            run.deliveryReceipt = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, mergeCommit: report.mergeCommit, summary: report.summary, reportedAt: timestamp() };
            this.emitWith(stored, "delivery.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => ({
              method: "merge", headCommit: report.headCommit, mergeCommit: report.mergeCommit }));
            this.save(stored);
          });
          await captureDeliveryBaseline(run.workspace, member.cwd, member.baseCommit, report.mergeCommit, this.prefixFor(run), signal);
        }
      }, () => {
        if (report.kind === "delivery-repair") {
          const recovery = run.deliveryRecovery;
          const inspected = recovery?.lastEvidenceHash && run.members.some(prior => prior.role === "delivery" && prior.status === "stopped" &&
            prior.revision === run.revision && prior.report?.kind === "delivery-reconciliation" && prior.report.headCommit === report.headCommit &&
            prior.report.repository === run.delivery!.repository && deliveryBranchMatches(run, prior.report.branch) &&
            deliveryInspectionHash(prior.report) === recovery.lastEvidenceHash);
          if (recovery && recovery.attempts > 0 && recovery.status !== "complete" && !inspected)
            throw new TeamError(409, "delivery-reconciliation-required", "An automatic recovery requires structured remote evidence before a delivery repair can change the reviewed head.");
          stored.deliveryAttempt = undefined;
          this.repair(stored, `Delivery requires a scoped repair before checks and independent review run again. No merge was reported.\n${report.summary}`, "delivery");
        } else if (report.kind === "pull-request") {
          stored.deliveryAttempt = undefined;
          run.pullRequest = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, summary: report.summary, reportedAt: timestamp(), ...(run.pullRequest && !run.pullRequest.branch ? {} : { branch: teamDeliveryBranch(run) }) };
          this.emitWith(stored, "delivery.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => ({
            method: "pull-request", headCommit: report.headCommit }));
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.event(stored, "The delivery agent reported an open pull request for the reviewed commit. Review and merge it on GitHub; the host refreshes the project after the merge.");
        } else {
          stored.deliveryAttempt = undefined;
          run.status = "merged"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.event(stored, "The delivery agent reported a merged pull request for the reviewed commit. This is agent-reported delivery evidence, not proof of product impact.");
          try { this.options?.onMerged?.(run.projectId); } catch (error) { this.diag.warnUnexpected("on-merged", error); }
        }
      }, member); return;
    }
    if (report.kind === "review") {
      if (member.baseCommit !== run.headCommit || stored.checkHead !== run.headCommit) { this.block(stored, new TeamError(409, "stale-review", "The reviewer did not review the currently verified integration commit.")); return; }
      const evidenceProblems = reviewEvidenceProblems(run.brief, report);
      if (evidenceProblems.length) {
        const problem = evidenceProblems.map(item => item.message).join(" ");
        if (run.reviewCorrections?.includes(run.revision)) { this.block(stored, new TeamError(409, evidenceProblems[0]!.code, problem)); return; }
        run.reviewCorrections = [...(run.reviewCorrections ?? []), run.revision];
        this.event(stored, "The reviewer's evidence was missing or invalid; requesting a corrected review."); this.save(stored);
        this.prepareMember(stored, "reviewer", undefined, `Review rejected: ${problem}\n${evidenceProblems.map(item => item.rule).join("\n")}`); return;
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.prefixFor(run), signal);
      }, () => {
        run.review = { verdict: report.verdict, summary: report.summary, revision: run.revision, ...(report.uiEvidence ? { uiEvidence: report.uiEvidence } : {}), ...(report.acceptance ? { acceptance: report.acceptance } : {}) };
        stored.deliveryReviewApproval = report.verdict === "approved" ? { reviewerMemberId: member.memberId, revision: member.revision, round: run.round, headCommit: member.baseCommit } : undefined;
        const rubricKept: { taskId: string; correctness: number; cleanliness: number; extensibility: number; docs: number }[] = [];
        if (report.verdict === "approved" && report.rubric?.length) {
          const reviewer = member.modelProfile ?? this.memberProfile(run, "reviewer");
          for (const entry of report.rubric) {
            const task = run.tasks.find(item => item.id === entry.taskId && item.status === "integrated");
            if (!task) continue;
            const implementer = run.members.find(candidate => candidate.memberId === task.memberId)?.modelProfile;
            if (reviewer && implementer && reviewer.model === implementer.model) {
              this.event(stored, `The rubric for task ${task.id} was dropped because reviewer and implementer use the same model.`);
              continue;
            }
            task.rubric = { version: 1, correctness: entry.correctness, cleanliness: entry.cleanliness, extensibility: entry.extensibility, docs: entry.docs, reviewerProfileId: reviewer?.id ?? "unknown" };
            rubricKept.push({ taskId: task.id, correctness: entry.correctness.score, cleanliness: entry.cleanliness.score, extensibility: entry.extensibility.score, docs: entry.docs.score });
          }
        }
        this.emitWith(stored, "review.recorded", [member.revision, member.memberId], { memberId: member.memberId, revision: member.revision }, () => {
          const reviewer = member.modelProfile ?? this.memberProfile(run, "reviewer");
          return { verdict: report.verdict, headCommit: member.baseCommit, baseCommit: run.baseCommit,
            reviewer: profileIdentity(reviewer, member.provider ?? run.provider), rubric: rubricKept.length ? rubricKept : undefined,
            acceptance: report.acceptance?.map(({ criterion, verdict }) => ({ criterion, verdict })) };
        });
        if (report.verdict === "approved") this.captureApproved(stored, member.baseCommit);
        if (report.verdict === "changes-requested") {
          for (const task of run.tasks) if (task.status === "integrated") task.reviewRounds = (task.reviewRounds ?? 0) + 1;
          this.repair(stored, report.summary, "review");
        }
        else run.status = "reviewing";
        const reviewed = { revision: member.revision, memberId: member.memberId, headCommit: member.baseCommit };
        this.enrich(stored, async signal => {
          const tree = await this.readTree(run, reviewed.headCommit, signal);
          return tree === undefined ? undefined : () => this.emitWith(stored, "review.tree", [reviewed.revision, reviewed.memberId],
            { memberId: reviewed.memberId, revision: reviewed.revision }, () => ({ headCommit: reviewed.headCommit, tree }));
        });
      }, member); return;
    }
    if (report.kind !== "result") throw new TeamError(409, "wrong-agent-report", "The member did not submit an implementation result.");
    const task = run.tasks.find(item => item.id === member.taskId);
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    run.status = "integrating";
    this.operation(stored, "result", async signal => {
      const commit = await captureMemberResult(member.cwd, member.baseCommit, member.role === "implementer" ? task!.paths : run.goal?.allowedPaths, this.prefixFor(run), signal);
      const head = commit ? (run.replay ? commit : await integrateMemberResult(run.workspace, member.cwd, commit, this.prefixFor(run), signal)) : run.headCommit!;
      const diff = commit ? await teamCommand({ command: "git", args: teamGitArgs(run.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "-z", member.baseCommit, commit, "--"]) }, run.workspace, signal, 30000, this.prefixFor(run)).catch(() => undefined) : undefined;
      const gitRead = (args: string[]) => teamCommand({ command: "git", args: teamGitArgs(run.workspace, args) }, run.workspace, signal, 30000, this.prefixFor(run))
        .then(result => result.exitCode === 0 && !result.interrupted && !result.truncated ? result.stdout : undefined, () => undefined);
      const change = commit ? {
        nameStatus: await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-M", "-z", run.baseCommit, head, "--"]),
        numstat: await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-M", "-z", run.baseCommit, head, "--"]),
        taskPaths: task ? await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", member.baseCommit, commit, "--"]) : undefined,
      } : undefined;
      return { commit, head, diff: diff?.exitCode === 0 ? diff.stdout : undefined,
        changes: change ? changeIndex(change.nameStatus, change.numstat, head, timestamp()) : undefined,
        changedPaths: change?.taskPaths !== undefined ? changedPathList(change.taskPaths) : undefined };
    }, ({ commit, head, diff, changes, changedPaths }) => {
      const headBefore = run.headCommit;
      stored.deliveryReviewLineage = advanceDeliveryReviewLineage(stored.deliveryReviewLineage, { headBefore: headBefore ?? "", headAfter: head,
        contributorFamilies: commit ? workspaceContributorFamilies(run, member) : [] });
      run.headCommit = head; stored.checkHead = undefined; run.review = undefined;
      if (commit) { if (changes) run.changes = changes; else delete run.changes; }
      if (member.role === "integrator" && run.deliveryRecovery?.status === "replanning" && run.deliveryRecovery.revision === run.revision)
        run.deliveryRecovery.integratedHeadCommit = head;
      if (task) {
        task.status = "integrated"; task.commit = commit; task.summary = report.summary; task.limitations = recordedTaskLimitations(report); task.diffStat = diffStat(diff);
        if (changedPaths) task.changedPaths = changedPaths; else delete task.changedPaths;
        this.emitWith(stored, "task.integrated", [member.revision, task.id], { memberId: member.memberId, taskId: task.id, revision: member.revision }, () => ({
          commit, headCommit: head, baseCommit: run.baseCommit, memberBaseCommit: member.baseCommit, diff: task.diffStat,
          integration: integrationGauge({ tasks: run.tasks, taskId: task.id, memberBase: member.baseCommit, headBefore, changedPaths: task.changedPaths ?? (commit ? undefined : { paths: [], truncated: false }) }),
        }));
        if (commit && member.role === "implementer" && !run.replay) this.captureIntegrated(stored, member, task, commit, head);
      }
      if (member.role === "integrator" && run.round > 0) {
        this.emitWith(stored, "repair.integrated", [member.revision, run.round], { memberId: member.memberId, revision: member.revision }, () => ({
          round: run.round, commit, headCommit: head, baseCommit: run.baseCommit,
        }));
        const repaired = { revision: member.revision, memberId: member.memberId, round: run.round, base: member.baseCommit, workspace: run.workspace };
        if (commit) this.enrich(stored, async signal => {
          const result = await teamCommand({ command: "git", args: teamGitArgs(repaired.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", repaired.base, commit, "--"]) },
            repaired.workspace, signal, 30000, this.prefixFor(run)).catch(() => undefined);
          const list = result && result.exitCode === 0 && !result.interrupted ? changedPathList(result.stdout) : undefined;
          return () => this.emitWith(stored, "repair.paths", [repaired.revision, repaired.round], { memberId: repaired.memberId, revision: repaired.revision }, () => ({
            round: repaired.round, commit, ...(list && !list.truncated ? pathField(list.paths) : { pathsOmitted: true }),
          }));
        });
      }
      if (member.role === "implementer" || member.role === "integrator") this.retentionState(stored).integratedAt[member.memberId] = this.retentionNow();
      this.event(stored, `${member.title} reported a result; its validated changes were integrated.`);
      run.status = "implementing";
    }, member, "integration");
  }
  private repair(stored: Stored, feedback: string, cause: "check" | "review" | "delivery") {
    if (stored.halt || ["paused", "cancelled"].includes(stored.run.status)) return;
    if (stored.run.round >= 2) { this.block(stored, new TeamError(409, "repair-limit", repairLimitReason)); return; }
    stored.run.round++; stored.run.review = undefined; stored.checkHead = undefined;
    const round = stored.run.round;
    this.emitWith(stored, "repair.started", [stored.run.revision, round], {}, () => ({ round, cause, headCommit: stored.run.headCommit }));
    this.prepareMember(stored, "integrator", undefined, feedback);
  }
  private requiredChecks(run: TeamRun) {
    return run.establishChecks ? run.verification?.checks : run.handoff?.project.checks ?? this.config.projects.find(project => project.id === run.projectId)?.team?.checks;
  }
  private verificationCommands(run: TeamRun) {
    const required = this.requiredChecks(run);
    if (!required?.length) return [];
    const configuredProject = run.handoff?.project ?? this.config.projects.find(project => project.id === run.projectId)?.team;
    const setup = run.establishChecks ? run.verification?.setup : configuredProject?.setup;
    const commands: { command: { command: string; args: string[] }; phase?: "setup" }[] = [];
    if (setup) commands.push({ command: setup, phase: "setup" });
    commands.push(...required.map(command => ({ command })));
    return commands;
  }
  private enrich(stored: Stored, read: (signal: AbortSignal) => Promise<(() => void) | undefined>): void {
    if (!this.options?.events) return;
    if (this.enrichments >= ENRICH_LIMIT) { this.diag.warnEnrichSkip(); return; }
    this.enrichments += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    timer.unref();
    void (async () => {
      try {
        const emit = await read(controller.signal);
        if (!emit || this.closed || this.records.get(stored.run.id) !== stored) return;
        emit();
        this.flushOutbox(stored);
      } catch (error) { if (!isBenignEnrichError(error, controller.signal.aborted, this.closed)) this.diag.warnUnexpected("enrich", error); }
      finally { clearTimeout(timer); this.enrichments -= 1; }
    })();
  }
  private async readTree(run: TeamRun, commit: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const result = await teamCommand({ command: "git", args: teamGitArgs(run.workspace, ["rev-parse", "--verify", `${commit}^{tree}`]) }, run.workspace, signal, 30000, this.config.teams?.commandPrefix);
      const tree = result.exitCode === 0 && !result.interrupted ? result.stdout.trim() : "";
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) ? tree : undefined;
    } catch (error) { if (!isBenignEnrichError(error, signal.aborted, this.closed)) this.diag.warnUnexpected("read-tree", error); return undefined; }
  }
  private check(stored: Stored) {
    const run = stored.run, revision = run.revision, head = run.headCommit!;
    const required = this.requiredChecks(run);
    if (!required?.length) throw new TeamError(409, "verification-required", "Required verification commands have not been established; the team cannot be ready for review.");
    const commands = this.verificationCommands(run).map((entry, index) => ({ ...entry, context: index === 0 && entry.phase === "setup" ? "setup" as const : "verification" as const }));
    run.status = "verifying";
    this.operation(stored, "check", async signal => {
      const results: typeof run.checks = [];
      this.assertRunPath(stored, run.workspace);
      await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, signal, "integration");
      const verification = await prepareVerificationWorkspace(run.workspace, randomUUID(), head, this.config.teams?.commandPrefix, signal);
      this.assertRunPath(stored, verification.workspace);
      if (verification.baseCommit !== head) throw new TeamError(409, "verification-head-mismatch", "The verification workspace did not start from the recorded integration commit.");
      await this.enqueue(stored.run.id, () => {
        if (this.closed || stored.pending?.kind !== "check" || stored.pending.revision !== revision) return;
        const root = stored.root ?? this.config.teams?.workspaceDir ?? dirname(run.workspace);
        const verificationPath = relative(root, verification.workspace).slice(0, 256);
        this.event(stored, `Configured checks are running in a disposable verification workspace: ${verificationPath}.`);
        this.save(stored);
      });
      for (const { context, ...entry } of commands) {
        const baseCheck = { ...entry, startedAt: timestamp(), revision, round: run.round, headCommit: head }, runningCheck: TeamRun["checks"][number] = { ...baseCheck, status: "running", output: "" };
        await this.enqueue(stored.run.id, () => { if (!this.closed) { run.checks.push(runningCheck); this.save(stored); } });
        const scanner = new CheckOutputScanner(), metrics = metricObserver();
        const result = await teamCommand(entry.command, verification.workspace, signal, (this.config.teams?.checkMinutes ?? 60) * 60000, this.config.teams?.commandPrefix, undefined, undefined, undefined, (chunk, stream) => { metrics.push(chunk, stream); scanner.push(chunk, stream); });
        const finishedCheck: TeamRun["checks"][number] = result.interrupted ? { ...baseCheck, status: "interrupted", finishedAt: timestamp(), exitCode: result.exitCode, output: result.output, scan: scanner.finish() }
          : result.exitCode === 0 ? { ...baseCheck, status: "passed", finishedAt: timestamp(), exitCode: 0, output: result.output }
          : { ...baseCheck, status: "failed", finishedAt: timestamp(), exitCode: result.exitCode, output: result.output, scan: scanner.finish() };
        results.push(finishedCheck);
        await this.enqueue(stored.run.id, () => { if (!this.closed) { const i = run.checks.indexOf(runningCheck); if (i >= 0) run.checks[i] = finishedCheck; metrics.record(stored, finishedCheck); this.save(stored); } });
        await this.noteLeftover(stored, result);
        if (!signal.aborted) await assertMemberReadOnly(verification.workspace, head, this.config.teams?.commandPrefix, signal, context);
        if (finishedCheck.status !== "passed") break;
      }
      if (!this.closed && !signal.aborted) await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, signal, "integration");
      return results;
    }, results => {
      if (results.length) {
        const first = results[0]!;
        this.emitWith(stored, "check.finished", [revision, first.round ?? 0, first.startedAt ?? ""], { revision }, () => ({
          round: first.round, headCommit: head, expected: commands.length,
          passed: results.length === commands.length && results.every(result => result.status === "passed"),
          commands: results.map(result => ({ phase: result.phase ?? "verification", status: result.status, exitCode: result.exitCode ?? null })),
        }));
      }
      if (revision !== run.revision || stored.halt || run.status === "paused" || run.status === "cancelled") return;
      if (results.length === commands.length && results.every(result => result.status === "passed")) {
        stored.checkHead = head; this.event(stored, "All configured verification commands passed against the integrated commit."); run.status = "reviewing";
      } else if (results.some(result => result.status === "interrupted")) {
        this.block(stored, new TeamError(409, "check-timeout", checkTimeoutReason));
      } else {
        const repeated = results.find(result => result.status === "failed" && result.phase !== "setup" && run.checks.some(prior => prior !== result &&
          prior.status === "failed" && prior.revision === revision && prior.round !== undefined && prior.round < run.round &&
          prior.headCommit === head && (prior.phase ?? "verification") === (result.phase ?? "verification") &&
          prior.command.command === result.command.command && JSON.stringify(prior.command.args) === JSON.stringify(result.command.args)));
        if (repeated) this.block(stored, new TeamError(409, "repeated-check-failure", repeatedCheckFailureReason));
        else this.repair(stored, checkFeedback(results), "check");
      }
    });
  }
}
