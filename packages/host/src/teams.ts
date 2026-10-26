import type { HandoffPolicy, TeamHandoffContext } from "./handoff-types.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from "node:path";
import type { Config, Provider } from "./types.js";
import { TeamStopRefused, type Manager } from "./manager.js";
import type { WorkerError } from "./ipc.js";
import { writeSealed, unseal } from "./vault.js";
import { PROVIDER_NAMES, recoveryTurnEnd, type Prompt, type SignalData } from "@infinite/attention";
import { createTeamSchema, lineupProfiles, resolveLimitFallback, teamActionSchema, teamContinueSchema, teamGoalContextSchema, teamLineupSchema, teamMutationSchema, teamDeliveryReconcileSchema, teamVerificationReconcileSchema, teamMemberRetireSchema, teamParallelismSchema, teamReportEnvelopeSchema, type CreateTeam, type TeamAssignment, type TeamBrief, type TeamContinue, type TeamContinuation, type TeamGoalContext, type TeamLineup, type TeamMember, type TeamMemberRetire, type TeamModelProfile, type TeamParallelism, type TeamPermissionDecision, type TeamPermissionRecoveryOutcome, type TeamPermissionRecoveryRequest, type TeamPermissionRecoveryStep, type TeamPermissionRecoveryView, type TeamReport, type TeamRun, type TeamScout, type TeamTask, type TeamView, type TeamVerificationReconcile, type TeamDeliveryReconcile, currentPermissions, DEFAULT_STORAGE_FLOOR, DEFAULT_TEAM_RETENTION } from "./team-types.js";
import { refreshReportingInstructions, retargetPrompt, teamContext, teamPrompt } from "./team-prompts.js";
import { permissionCoordinatorLaunch, teamModelLaunch } from "./launch.js";
import type { UsageService } from "./usage-service.js";
import { teamUsage } from "./team-usage.js";
import { ProviderLimits, switchesMember, type LimitObservation } from "./provider-limits.js";
import type { LinearService } from "./linear.js";
import type { Readings } from "./readings.js";
import type { ProjectSourceService } from "./project-source.js";
import { LEGACY_READ_ONLY_ROLE_CHANGED_FILES_REASON, TeamError, assertMemberReadOnly, assertMemberScope, assertTeamPath, captureDeliveryBaseline, captureMemberResult, ensureDefaultTeamRoot, ensureHostDirectory, integrateMemberResult, memberChangedPaths, prepareMemberScratch, prepareMemberWorkspace, prepareRecoveredWorkspace, prepareRecoveryWorkspaceFromSource, prepareTeamWorkspace, prepareTeamWorkspaceFromMirror, prepareVerificationWorkspace, removeMemberWorkspace, removeTeamWorkspace, teamCommand, teamHead, teamPathAllowed, teamWorkspacePath, teamGitArgs, validateTeamPlan, writeTeamContext } from "./team-workspace.js";
import { assertTeamworkPath } from "./repo-enrollment.js";
import { isCollapsedPermissionPrompt, oneShotPermissionOption, permissionEvidenceHash, refusedBeforeSend } from "./team-permissions.js";
import { storageShortfall, volumeUsage, type VolumeUsage } from "./storage.js";
import { collectPermissionEvidence } from "./team-permission-evidence.js";
export { TeamError } from "./team-workspace.js";

type Mutation = { requestId: string; revision: number; text: string };
type VerificationMutation = TeamVerificationReconcile;
type Action = { requestId: string; revision: number };
type LimitSwitch = LimitObservation & { at: string; seq: number };
type StartInProject = <T>(projectId: string, start: () => Promise<T>) => Promise<T>;
type MissionReservationLookup = (projectId: string, exceptMissionId?: string) => string | undefined;
type DeliveryReconciliationReport = Extract<TeamReport, { kind: "delivery-reconciliation" }>;
type TeamServiceOptions = {
  source?: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status">;
  onMerged?: (projectId: string) => void;
  ownerActive?: (run: TeamRun) => boolean;
  now?: () => number;
  volumeUsage?: (path: string) => Promise<VolumeUsage>;
};
type RetentionState = { status: TeamRun["status"]; statusAt: string; integratedAt: Record<string, string>; removalErrors: Record<string, string[]> };
function deliveryInspectionHash(report: DeliveryReconciliationReport) {
  return digest({ headCommit: report.headCommit, repository: report.repository, branch: report.branch,
    baseHeadCommit: report.baseHeadCommit, disposition: report.disposition, remoteHeadCommit: report.remoteHeadCommit });
}
type PendingOperation = { id: string; kind: "prepare" | "member" | "result" | "check"; revision: number;
  source?: { memberId: string; role: TeamMember["role"]; cwd: string; baseCommit: string; headCommit: string; workspace: "member" | "integration" };
  failure?: { code?: string; reason: string; at: string };
};
type Stored = {
  run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean; root?: string; anchor?: string;
  retention?: RetentionState;
  pending?: PendingOperation;
  verificationRecovery?: { pendingId: string; pendingKind: "check"; revision: number; headCommit: string; failure: "setup-changed-files" | "verification-changed-files" | "legacy-completed-check" };
  halt?: "pause" | "cancel" | "steer" | "block";
  deliveryAttempt?: { memberId: string; revision: number; headCommit: string };
  continuationHead?: { revision: number; headCommit: string };
  checkHead?: string;
  source?: { path: string; head?: string; startCommit?: string };
  handoffPolicy?: HandoffPolicy;
  goalExtensions?: Record<string, { deadlineAt: string; ceilingAt: string }>;
  ratings?: Record<string, { fingerprint: string; result: TeamTask["ownerRating"] }>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = () => new Date().toISOString();
const activeMember = (member: TeamMember) => ["queued", "running", "reported", "unavailable"].includes(member.status);
const holdsWorkerSlot = (member: TeamMember, revision: number) => member.revision === revision &&
  (member.role === "scout" || member.role === "implementer") &&
  (["queued", "running", "unavailable"].includes(member.status) || member.status === "reported" && !member.exitConfirmedAt);
const inactiveTeamStatuses = new Set(["cancelled", "ready-for-review", "merged", "no-change"]);
const activeTeamRun = (status: string) => !inactiveTeamStatuses.has(status);
const capacityCeiling = (run: Pick<TeamRun, "parallelismCeiling" | "handoff">) => run.parallelismCeiling ?? (run.handoff ? 2 : 4);
export const providerInputReason = "A provider needs user input. Open the member session to respond; the team will not approve it.";
const permissionReviewReason = "The permission coordinator is reviewing a provider request.";
/** Whether a delegated permission decision still holds this member's open prompt. */
const underReview = (run: TeamRun, sessionId: string, promptId?: number) => promptId !== undefined &&
  (run.permissionDecisions ?? []).some(decision => decision.targetSessionId === sessionId && decision.promptId === promptId &&
    ["pending", "reviewing", "approved", "answering"].includes(decision.status)) || promptId !== undefined &&
  (run.permissionRecovery?.requests ?? []).some(request => request.targetSessionId === sessionId && request.promptId === promptId && livePermissionRecoveryStatuses.has(request.status));
const runtimeUnavailableReason = "An agent runtime is unavailable; the team is waiting for confirmed state.";
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;
const runEvent = (run: TeamRun, text: string) => {
  run.events.push({ at: timestamp(), text });
  if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
};
function retentionEventAt(run: TeamRun) {
  const event = [...run.events].reverse().find(item => {
    switch (run.status) {
      case "merged": return item.text.includes("reported a merged pull request");
      case "no-change": return item.text.includes("reported no justified change");
      case "cancelled": return item.text.startsWith("Team cancelled.");
      case "ready-for-review": return item.text.includes("Ready for human review") || item.text.includes("reported an open pull request");
      case "blocked": return item.text === run.reason || item.text.includes("recovery stopped after repeated unchanged remote evidence");
      default: return false;
    }
  });
  return event?.at ?? run.updatedAt ?? run.createdAt;
}
function teamRunDirectory(workspace: string) {
  const parent = dirname(workspace);
  return ["recovery", "verification"].includes(basename(parent)) ? dirname(parent) : parent;
}
function diffStat(output?: string) {
  if (output === undefined) return undefined;
  // `--numstat -z --no-renames` ends every file record with NUL: "added<TAB>removed<TAB>path".
  const rows = output.split("\0").filter(Boolean).map(line => {
    const [added, removed, path] = line.split("\t");
    return { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), path: path ?? "" };
  });
  return { added: rows.reduce((sum, row) => sum + row.added, 0), removed: rows.reduce((sum, row) => sum + row.removed, 0), files: rows.length,
    docs: rows.some(row => row.path.startsWith("docs/") || row.path.endsWith(".md")),
    tests: rows.some(row => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(row.path)) };
}

/** Written by hosts before stall detection; still resumable. */
export const memberTimeLimitReason = "An agent exceeded its one-hour runtime limit. Its workspace was preserved.";
export const memberStallReason = "An agent showed no activity twice on the same assignment. Its workspace was preserved.";
export const checkTimeoutReason = "A configured check ran past the team check time limit (teams.checkMinutes) and was stopped. No correction round was used; the integrated work was preserved.";
export const repeatedCheckFailureReason = "The same required verification command failed again against an unchanged integration commit. No further identical repair was attempted; inspect the check output and continue with owner direction.";
const repairLimitReason = "The team exhausted its two correction rounds. Review the check and agent evidence before continuing manually.";
const promptTooLargeReason = "The accumulated team requirements exceed the prompt limit. Start a new team with consolidated requirements.";
const missingAgentReportReason = "An agent exited without a valid structured report. Its task is unresolved.";
const invalidNoChangeReason = "A no-change report is valid only before implementation tasks are planned and when the integration head is unchanged from the base.";
const wrongAgentReportReason = "An agent's report does not match its assigned role.";
const automaticRecoveryCodes = new Set(["agent-blocked", "agent-question", "missing-agent-report", "invalid-no-change", "wrong-agent-report"]);
const automaticRecoveryLimit = 2;
const permissionRecoveryRoundLimit = 2;
const permissionRecoveryStepLimit = 100;
const permissionRecoveryOutcomeLimit = 100;
const automaticOperationRecoveryCodes = new Set(["workspace-operation-failed", "read-only-role-changed-files", "task-scope-violation", "integration-conflict", "integration-changed-files"]);
function roleAcceptsReport(role: TeamMember["role"], kind: NonNullable<TeamMember["report"]>["kind"]) {
  const expected: Record<TeamMember["role"], string[]> = {
    "permission-coordinator": ["permission-decision"], "project-manager": ["plan", "explore", "no-change"], scout: ["findings"],
    implementer: ["result", "escalate"], integrator: ["result"], reviewer: ["review"], delivery: ["delivery", "delivery-repair", "delivery-reconciliation", "pull-request"],
  };
  return kind === "question" || kind === "blocked" || expected[role].includes(kind);
}
const recoverableContinueCodes = new Set(["repair-limit", "team-prompt-too-large", "repeated-check-failure", "agent-blocked", "missing-agent-report"]);
const interruptedOperationReason = "The host restarted during a workspace or verification operation. Inspect the isolated workspace before starting a new team; the operation will not be replayed.";
const genericOperationFailureReason = "A team operation failed. Its workspaces and recorded evidence were preserved for inspection.";
const verificationRecoveryReason = "A read-only verification command changed its workspace. Inspect the check evidence before resuming from the recorded integration commit.";
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const livePermissionRecoveryStatuses = new Set(["expanding", "diagnosing", "reviewing-evidence"]);
const screenPermissionPrompt = (prompt: Prompt) => prompt.source === "screen" && prompt.kind === "permission" && prompt.pinned === true && Boolean(prompt.hash);
const coordinatorPermissionPrompt = (prompt: Prompt) => oneShotPermissionOption(prompt) !== undefined || isCollapsedPermissionPrompt(prompt) || screenPermissionPrompt(prompt);
const permissionPromptKey = (targetSessionId: string, promptId: number, promptHash: string) => `${targetSessionId}:${promptId}:${promptHash}`;
const boundedRecoveryText = (value: string, max = 400) => [...value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
function permissionRequestCount(run: TeamRun) {
  return new Set((run.permissionDecisions ?? [])
    .map(item => item.recoveryRequestId ?? run.permissionRecovery?.requests.find(request => request.revision === item.revision &&
      request.targetSessionId === item.targetSessionId && request.promptId === item.promptId)?.id ?? permissionPromptKey(item.targetSessionId, item.promptId, item.promptHash))).size;
}
function sameRecoveryRequest(request: TeamPermissionRecoveryRequest, target: TeamMember, prompt: Prompt, revision: number) {
  return request.revision === revision && request.targetMemberId === target.memberId && request.targetSessionId === target.sessionId &&
    request.promptId === prompt.id && request.promptHash === prompt.hash && request.evidenceHash === permissionEvidenceHash(prompt);
}
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
function terminalPermissionCoordinator(run: TeamRun, member: TeamMember) {
  if (member.role !== "permission-coordinator") return false;
  const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId && item.revision === member.revision);
  return Boolean(decision && (["stale", "escalated"].includes(decision.status) ||
    decision.status === "answered" && decision.receipt?.state === "delivered" && decision.receipt.result === "closed"));
}
function obsoletePermissionResult(stored: Stored, pending: PendingOperation) {
  const { run } = stored;
  if (run.status === "paused" || run.status === "cancelled" || stored.halt === "pause" || stored.halt === "cancel" || pending.kind !== "result" || pending.revision !== run.revision) return undefined;
  const reported = run.members.filter(member => member.revision === pending.revision && member.report && roleAcceptsReport(member.role, member.report.kind));
  const candidates = reported.filter(member => {
    const report = member.report;
    return member.role === "permission-coordinator" &&
      (!pending.source || pending.source.memberId === member.memberId) && report?.kind === "permission-decision" &&
      Boolean(run.permissionDecisions?.some(decision => decision.coordinatorMemberId === member.memberId && decision.id === report.decisionId &&
        decision.revision === member.revision && terminalPermissionCoordinator(run, member)));
  });
  return candidates.length === 1 && (pending.source || reported.length === 1) ? candidates[0] : undefined;
}
function recoverableOperationFailure(stored: Stored, pending: PendingOperation) {
  const { run } = stored, source = pending.source, failure = pending.failure;
  if (!source || !failure || !failure.code || !automaticOperationRecoveryCodes.has(failure.code) || pending.kind !== "result" || pending.revision !== run.revision ||
      source.role === "delivery" || source.role === "permission-coordinator" || source.headCommit !== run.headCommit ||
      stored.deliveryAttempt || run.deliveryReceipt || run.pullRequest || run.stopReason || run.permissionsRevokedAt ||
      run.linearTracking && run.linear?.status !== "synced" || ["paused", "cancelled"].includes(run.status) || stored.halt === "pause" || stored.halt === "cancel" ||
      (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) return undefined;
  const member = run.members.find(item => item.memberId === source.memberId && item.revision === pending.revision && item.role === source.role &&
    item.cwd === source.cwd && item.baseCommit === source.baseCommit && item.report);
  return member;
}
function recoverableUnattributedResult(stored: Stored, pending: PendingOperation) {
  const { run } = stored;
  const failureCode = pending.failure?.code ?? run.blockCode ?? (run.reason === genericOperationFailureReason ? "unattributed-result" : undefined);
  const settledLegacy = !pending.failure && run.status === "blocked" && (run.reason === genericOperationFailureReason ||
    Boolean(failureCode && automaticOperationRecoveryCodes.has(failureCode)));
  if (pending.kind !== "result" || pending.source || !failureCode ||
      !automaticOperationRecoveryCodes.has(failureCode) && failureCode !== "unattributed-result" || !pending.failure && !settledLegacy ||
      pending.revision !== run.revision || stored.deliveryAttempt || run.deliveryReceipt || run.pullRequest ||
      run.stopReason || run.permissionsRevokedAt || run.linearTracking && run.linear?.status !== "synced" ||
      ["paused", "cancelled"].includes(run.status) || ["pause", "cancel", "steer"].includes(stored.halt ?? "") ||
      (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) return false;
  return true;
}

export function applyTeamBriefTitle(run: TeamRun, brief: TeamBrief | undefined, revision = run.revision) {
  run.brief = brief;
  if (brief && run.status !== "cancelled" && revision === run.revision && (run.titleSource === "request" || run.titleSource === "model" || run.titleSource === "brief")) {
    run.title = brief.title;
    run.titleSource = "brief";
  }
}

/**
 * The fallback for a member stopped at a provider limit. Its own provider counts as limited even when
 * only a single-source observation saw the limit, so a second hop never returns to that account.
 */
export function switchFallback(lineup: TeamLineup, profileId: string, provider: Provider, limited: Set<Provider>) {
  return resolveLimitFallback(lineup, profileId, new Set([...limited, provider]));
}

/** A stalled or legacy one-hour member stop can replan. Interrupted workspace operations cannot. */
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
/** Milliseconds since the member last showed attention activity, or since it started before any was observed. */
const quietFor = (member: TeamMember) => Date.now() - Date.parse(member.lastActivityAt ?? member.startedAt ?? timestamp());
// The flag is persisted on the member at creation, so a recovered or stopped session keeps the fingerprint it launched with.
const assignment = (member: TeamMember): TeamAssignment => ({ runId: member.runId, memberId: member.memberId, revision: member.revision, role: member.role, ...(member.taskId ? { taskId: member.taskId } : {}),
  ...(member.verificationRefused ? { verificationRefused: true } : {}) });

/** Durable orchestration; reports describe agent claims, configured checks describe host evidence. */
export class TeamService {
  private readonly records = new Map<string, Stored>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private tickQueued = false;
  private readonly commands = new Map<string, AbortController>();
  private readonly permissionPromptFirstSeen = new Map<string, number>();
  private readonly directory: string;
  private usage?: UsageService;
  private missionReservations?: MissionReservationLookup;
  private readonly limits: ProviderLimits;
  private reconciledAt = 0;
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly startInProject: StartInProject, private readonly linear?: LinearService, private readonly titler?: Pick<Readings, "requestTitle">, private readonly options?: TeamServiceOptions) {
    this.directory = join(config.stateDir, "teams");
    this.limits = new ProviderLimits(join(config.stateDir, "provider-limits.sealed"), key);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `team:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.run.id !== id) throw new TeamError(409, "invalid-team-record", "A team record cannot be authenticated.");
      this.records.set(id, stored);
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
      // Older standalone runs persisted the owner's chosen parallelism. Move them to host-owned
      // capacity on restore; mission runs are migrated by MissionService, which knows solo/team size.
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
        for (const check of stored.run.checks) if (check.status === "running") { check.status = "interrupted"; check.finishedAt = timestamp(); }
        const pending = stored.pending, run = stored.run;
        const recoverableMarker = validVerificationRecovery(stored);
        // Only the current reason is provenance. Historical event text may describe an unrelated revision.
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
        // Retain the intent so resume cannot disguise an ambiguous operation.
        this.save(stored); this.trackBlocked(stored);
      }
      for (const decision of stored.run.permissionDecisions ?? []) if (decision.status === "answering") {
        decision.status = "uncertain";
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
      this.recoverLegacyBlocked(stored);
      this.admitBlockedDeliveryRecovery(stored);
    }
  }
  /** The usage ledger this service prices member usage from; its tick also drives the ledger's reads. */
  useUsage(service: UsageService) { this.usage = service; }
  /** MissionService supplies active-subteam and pending-launch reservations without a reverse import. */
  useMissionReservations(lookup: MissionReservationLookup) { this.missionReservations = lookup; }
  /** Active host-level provider limits; new members of a limited provider launch on their fallback. */
  providerLimits() { return this.limits.active(); }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "team-not-found", "This team does not exist.");
    return stored;
  }
  private retentionNow() { return new Date(this.options?.now?.() ?? Date.now()).toISOString(); }
  private retentionState(stored: Stored) {
    if (!stored.retention) stored.retention = { status: stored.run.status, statusAt: retentionEventAt(stored.run), integratedAt: {}, removalErrors: {} };
    else if (stored.retention.status !== stored.run.status) {
      stored.retention.status = stored.run.status;
      stored.retention.statusAt = this.retentionNow();
    }
    stored.retention.integratedAt ??= {};
    stored.retention.removalErrors ??= {};
    return stored.retention;
  }
  private assertRunPath(stored: Stored, path: string, create = false) {
    const root = stored.root ?? this.config.teams?.workspaceDir;
    if (!root) throw new TeamError(409, "invalid-workspace", "The team workspace is outside its configured root.");
    if (!stored.anchor && root !== this.config.teams?.workspaceDir)
      throw new TeamError(409, "team-root-unsafe", "A team root outside the configured workspace directory requires a trusted anchor.");
    const canonical = stored.anchor ? ensureHostDirectory(stored.anchor, root, 0o750, create) : ensureDefaultTeamRoot(root, create);
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
        run.deliveryReceipt || run.pullRequest || run.goal || run.missionId || run.handoff || run.stopReason || run.permissionsRevokedAt ||
        run.linearTracking && run.linear?.status !== "synced" ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "escalated", "uncertain"].includes(decision.status)) ||
        !code || !automaticRecoveryCodes.has(code)) return;
    if (code === "invalid-no-change" && (run.headCommit !== run.baseCommit || run.tasks.some(task => task.status === "integrated"))) return;
    const candidates = run.members.filter(member => member.revision === run.revision && member.status === "stopped" &&
      member.role !== "delivery" && member.role !== "permission-coordinator" && (
        code === "agent-blocked" ? member.report?.kind === "blocked" && member.report.summary === run.reason :
          code === "agent-question" ? member.report?.kind === "question" && `The ${member.role} requested an owner decision: ${member.report.question}` === run.reason :
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
        stored.deliveryAttempt || run.deliveryReceipt || run.stopReason || run.members.length >= 60 || run.members.some(member => member.status !== "stopped") ||
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
  private view(stored: Stored): TeamView {
    const { members, permissionRecovery, ...run } = structuredClone(stored.run);
    // Queue evidence from this exact state before a goal can use its sync gate
    // to continue from a newly reviewed or no-change result.
    const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true, this.canResume(stored));
    run.linear = this.linear?.getTeam(run.id) ?? tracking ?? run.linear;
    const safeRun = {
      ...run,
      resumable: this.canResume(stored, run.linear?.status),
      continuable: this.canContinue(stored, run.linear?.status),
      ...(run.permissionDecisions ? { permissionDecisions: run.permissionDecisions.map(({ prompt: _prompt, ...decision }) => decision) } : {}),
      ...(permissionRecovery ? { permissionRecovery: { outcomes: permissionRecovery.outcomes.slice(-10).map(({ requestId: _requestId, ...outcome }) => ({
        ...outcome, cause: boundedRecoveryText(outcome.cause), action: boundedRecoveryText(outcome.action),
        decision: boundedRecoveryText(outcome.decision), consequence: boundedRecoveryText(outcome.consequence),
      })) } } : {}),
    };
    const withUsage = teamUsage(members.map(({ prompt: _prompt, contextFeedback: _feedback, ...member }) => member), run.provider, this.usage);
    const max = capacityCeiling(run);
    const ready = run.tasks.filter(task => task.status === "pending" && task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === "integrated")).length +
      (run.discovery && run.discovery.revision === run.revision && !run.discovery.completedAt ? run.discovery.tasks.filter(task => task.status === "pending").length : 0);
    const workers = { limit: run.parallelism, max, running: members.filter(member => holdsWorkerSlot(member, run.revision)).length, ready };
    return { ...safeRun, ...(stored.pending ? { pendingOperation: { id: stored.pending.id, kind: stored.pending.kind, revision: stored.pending.revision, failed: Boolean(stored.pending.failure), ...(stored.pending.failure?.code ? { failureCode: stored.pending.failure.code } : {}), ...(stored.pending.source ? { sourceMemberId: stored.pending.source.memberId, sourceRole: stored.pending.source.role } : {}) } } : {}), tasks: safeRun.tasks.map(task => { // Older records predate task.revision; steering clears the task list, so the retained run revision identifies their plan.
      const revision = task.revision ?? safeRun.revision;
      const attempts = withUsage.members.filter(member => member.taskId === task.id && member.revision === revision);
      const usage = attempts.flatMap(member => member.usage?.messages ? [member.usage] : []);
      return { ...task, revision, ...(usage.length ? { usage: { usd: Math.round(usage.reduce((n, row) => n + row.cost, 0) * 1_000_000) / 1_000_000, unpriced: usage.reduce((n, row) => n + row.pricing.unknown, 0), tokens: usage.reduce((n, row) => n + Object.values(row.tokens).reduce((a, b) => a + b, 0), 0), attempts: attempts.length, profiles: [...new Set(attempts.map(member => member.modelProfile?.id).filter((id): id is string => Boolean(id)))].sort() } } : {}) };
    }), members: withUsage.members, usage: withUsage.rollup, providerLimits: this.limits.active(), workers };
  }
  private save(stored: Stored) {
    const retention = this.retentionState(stored);
    if (retention.status !== stored.run.status) {
      retention.status = stored.run.status;
      retention.statusAt = this.retentionNow();
    }
    stored.run.updatedAt = timestamp();
    writeSealed(join(this.directory, `${stored.run.id}.sealed`), this.key, `team:${stored.run.id}`, stored);
  }
  private async nameRequest(id: string, objective: string) {
    try {
      const title = (await this.titler!.requestTitle(objective))?.text;
      if (!title) return;
      await this.enqueue(() => {
        const stored = this.records.get(id), run = stored?.run;
        if (this.closed || !stored || !run || run.titleSource !== "request" || !["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering", "needs-input", "paused"].includes(run.status)) return;
        run.title = title;
        run.titleSource = "model";
        this.save(stored);
      });
    } catch { /* Best-effort naming never affects team creation or execution. */ }
  }
  private event(stored: Stored, text: string) { runEvent(stored.run, text); }
  list(): TeamView[] { return [...this.records.values()].map(record => this.view(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  /** Persisted team records for the read-only Understanding view; performs no tracker or usage refresh. */
  understandingRecords() { return [...this.records.values()].map(stored => structuredClone(stored.run)); }
  understandingOwnsSession(runId: string, memberId: string, sessionId: string, projectId: string): boolean {
    const stored = this.records.get(runId);
    return Boolean(stored && stored.run.projectId === projectId && stored.run.members.some(member =>
      member.memberId === memberId && member.sessionId === sessionId && member.runId === runId));
  }
  /** Status rows for owner alerts. Unlike list(), reading them does not refresh tracker state. */
  statuses() { return [...this.records.values()].map(stored => ({ id: stored.run.id, title: stored.run.title, status: stored.run.status, reason: stored.run.reason, resumable: this.canResume(stored) && !stored.run.goal && !stored.run.missionId, goal: Boolean(stored.run.goal), mission: Boolean(stored.run.missionId) })); }
  /**
   * Who a member session's open prompt waits on. "coordinator" while a delegated decision is live
   * for it, "undecided" while the run could still start one, otherwise "user": the prompt stays
   * with the owner because the run is not delegated, cannot act, has spent its decisions, or the
   * prompt lacks complete one-shot evidence. Sessions outside any current run are the owner's.
   */
  promptOwner(sessionId: string, prompt: Prompt): "coordinator" | "user" | "undecided" {
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
      if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status) ||
          !activeMember(member) || member.role === "permission-coordinator" || !run.lineup || run.lineup.coordinator.tier !== "strong" ||
          permissionRequestCount(run) >= run.permissions.maxDecisions || !coordinatorPermissionPrompt(prompt))
        return "user";
      return "undecided";
    }
    return "user";
  }
  /** Read mission ownership without building a view or updating external tracking. */
  missionIdOf(id: string): string | undefined { return this.record(id).run.missionId; }
  /** Restores the mission-authored size boundary for subteams persisted before ceilings were stored. */
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
  get(id: string): TeamView { return this.view(this.record(id)); }
  private teamRoot(stored: Stored) {
    const root = stored.root ?? this.config.teams?.workspaceDir;
    if (!root) throw new TeamError(409, "invalid-workspace", "The team workspace is outside its configured root.");
    return stored.anchor ? ensureHostDirectory(stored.anchor, root, 0o750, false) : ensureDefaultTeamRoot(root, false);
  }
  private async deleteRecord(stored: Stored) {
    const finalView = this.view(stored);
    try { await rmAsync(join(this.directory, `${stored.run.id}.sealed`), { force: true }); }
    catch { throw new TeamError(500, "team-record-removal-failed", "The settled team's record could not be removed."); }
    this.commands.get(stored.run.id)?.abort();
    this.commands.delete(stored.run.id);
    this.records.delete(stored.run.id);
    return finalView;
  }
  removeRun(id: string): Promise<TeamView> {
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (!(["cancelled", "merged", "no-change"].includes(run.status) && await this.membersSettled(stored)))
        throw new TeamError(409, "team-active", "Only a settled cancelled, merged or no-change run can be removed.");
      if (!run.workspaceRemovedAt) {
        this.assertRunPath(stored, run.workspace);
        await removeTeamWorkspace(teamRunDirectory(run.workspace), this.config.teams?.commandPrefix, undefined, this.teamRoot(stored));
        run.workspaceRemovedAt = this.retentionNow();
        for (const member of run.members) member.workspaceRemovedAt ??= run.workspaceRemovedAt;
        this.event(stored, "Workspaces removed by the owner through removeRun after the run settled.");
        this.save(stored);
      }
      return this.deleteRecord(stored);
    });
  }
  rateTask(id: string, taskId: string, input: { requestId: string; score: number; note?: string }) {
    const stored = this.record(id), task = stored.run.tasks.find(item => item.id === taskId);
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
    this.event(stored, `The owner rated task ${taskId}.`); this.save(stored);
    return task;
  }
  async bundle(id: string) {
    const stored = this.record(id), run = stored.run;
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
    return [...this.records.values()].some(({ run }) => run.projectId === projectId && activeTeamRun(run.status));
  }
  isActiveRun(id: string) { const stored = this.records.get(id); return Boolean(stored && activeTeamRun(stored.run.status)); }
  create(request: CreateTeam): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    return this.createRun(parsed);
  }
  /** Goal authority and model snapshots come from the host, never from a public create body. */
  createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false): Promise<TeamView> {
    return this.createRun(createTeamSchema.parse(request), { goal: teamGoalContextSchema.parse(goal), lineup: teamLineupSchema.parse(lineup) }, linearTracking);
  }
  /** A mission subteam is an ordinary run of one repository under that repository's own policies; the mission pins its lineup. */
  createForMission(request: CreateTeam, missionId: string, lineup: TeamLineup, options: { baseRunId?: string; parallelismCeiling?: number } = {}): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    const project = this.config.projects.find(item => item.id === parsed.projectId);
    return this.createRun(parsed, { missionId, ...(options.baseRunId ? { baseRunId: options.baseRunId } : {}), parallelismCeiling: options.parallelismCeiling ?? 4, lineup: teamLineupSchema.parse(lineup) }, Boolean(project?.linear));
  }
  assertHandoffPolicy(policy: HandoffPolicy) {
    const project = this.config.projects.find(item => item.id === policy.projectId);
    if (!project || JSON.stringify(project.team) !== JSON.stringify(policy.project) || JSON.stringify(project.linear) !== JSON.stringify(policy.linear) || realpathSync(project.path) !== policy.path || this.config.teams?.workspaceDir !== policy.workspaceDir || JSON.stringify(this.config.teams?.commandPrefix) !== JSON.stringify(policy.commandPrefix))
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
  private createRun(parsed: CreateTeam, internal?: { goal?: TeamGoalContext; missionId?: string; parallelismCeiling?: number; baseRunId?: string; handoff?: TeamHandoffContext; handoffPolicy?: HandoffPolicy; lineup: TeamLineup }, linearTracking = false): Promise<TeamView> {
    return this.enqueue(async () => {
      // Preserve the fingerprints written before lineup selection existed.
      const { useConfiguredLineup, ...singleProviderRequest } = parsed;
      // The host derives the ceiling; adding it must not change a pending mission launch's identity.
      const { parallelismCeiling: _ceiling, ...creationContext } = internal ?? {};
      const prior = this.records.get(parsed.requestId), fingerprint = digest(internal ? { request: parsed, ...creationContext } : useConfiguredLineup ? parsed : singleProviderRequest);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team request.");
        if (internal?.missionId) this.ensureMissionCapacityCeiling(parsed.requestId, internal.missionId, internal.parallelismCeiling ?? 4);
        return this.view(prior);
      }
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
      if (project.team.permissions && (!lineup || lineup.coordinator.tier !== "strong" ||
          lineup.coordinator.limitFallback !== undefined && lineupProfiles(lineup).find(profile => profile.id === lineup.coordinator.limitFallback)?.tier !== "strong"))
        throw new TeamError(409, "permission-lineup-required", "Delegated permissions require a strong coordinator and any configured coordinator fallback must also be strong.");
      const parentId = goal?.parentRunId ?? internal?.baseRunId;
      const parent = parentId ? this.record(parentId).run : undefined;
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
      // The `infinite/team-` prefix keeps constrained launchers that allow only team branches working.
      const branch = `infinite/team-${slug}-${suffix}`;
      const root = project.teamworkDir ?? this.config.teams.workspaceDir;
      let usage: VolumeUsage | undefined;
      try { usage = await (this.options?.volumeUsage ?? volumeUsage)(root); } catch { /* A filesystem stat failure must not prevent admission. */ }
      if (usage) {
        const reason = storageShortfall(usage, this.config.teams.storageFloor ?? DEFAULT_STORAGE_FLOOR);
        if (reason) throw new TeamError(507, "host-storage-low", reason);
      }
      const fallbackTitle = parsed.objective.trim().split("\n")[0]!.slice(0, 100).trim();
      const titleSource = !internal?.goal && !internal?.handoff && !internal?.missionId && parsed.title === fallbackTitle ? "request" as const : undefined;
      const ceiling = internal?.parallelismCeiling ?? (internal?.handoff ? 2 : 4);
      if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 4 || internal?.handoff && ceiling > 2)
        throw new TeamError(409, "team-parallelism-limit", "The assigned worker capacity ceiling must be between one and the host limit.");
      const initialParallelism = internal?.missionId ? parsed.parallelism : ceiling;
      if (initialParallelism > ceiling)
        throw new TeamError(409, "team-parallelism-limit", "The initial worker limit exceeds this run's capacity ceiling.");
      const run: TeamRun = { linearTracking: internal ? linearTracking : Boolean(project.linear), id: parsed.requestId, projectId: parsed.projectId, provider: parsed.provider, ...(lineup ? { lineup } : {}), ...(project.team.permissions ? { permissions: currentPermissions(structuredClone(project.team.permissions)), permissionDecisions: [] } : {}), ...(goal ? { goal } : {}), ...(internal?.missionId ? { missionId: internal.missionId } : {}), ...(internal?.handoff ? { handoff: structuredClone(internal.handoff) } : {}), ...(titleSource ? { titleSource } : {}), title: parsed.title, objective: parsed.objective, parallelismCeiling: ceiling, parallelism: initialParallelism, revision: 1, status: "planning", createdAt: at, updatedAt: at, workspace: teamWorkspacePath(root, directoryName), branch, baseCommit: "", tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 0 };
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
      this.records.set(run.id, stored); this.event(stored, "Team created; preparing an isolated copy of the configured project."); this.save(stored);
      if (run.titleSource === "request" && this.titler) void this.nameRequest(run.id, parsed.objective).catch(error => console.warn("Best-effort team naming failed.", error));
      this.operation(stored, "prepare", async signal => {
        const assertParent = () => {
          if (parent && (!["ready-for-review", "merged", "no-change"].includes(parent.status) || parent.revision !== parentRevision || parent.headCommit !== source.head))
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
          try { await this.options.source.refresh(project.id, { maxAgeMs: 60_000 }); } catch { /* A continuation keeps its parent's base when refresh is unavailable. */ }
          try {
            const mirrorHead = this.options.source.status(project.id).mirrorHead;
            if (mirrorHead && mirrorHead !== parent.headCommit) {
              const fetched = await teamCommand({ command: "git", args: teamGitArgs(source.path, ["fetch", "--no-tags", "--", this.options.source.mirrorPath(project.id), mirrorHead]) }, source.path, signal, 30000, this.config.teams?.commandPrefix);
              if (fetched.exitCode === 0 && !fetched.interrupted && !fetched.truncated) {
                const ancestry = await teamCommand({ command: "git", args: teamGitArgs(source.path, ["merge-base", "--is-ancestor", parent.headCommit!, mirrorHead]) }, source.path, signal, 30000, this.config.teams?.commandPrefix);
                if (ancestry.exitCode === 0 && !ancestry.interrupted && !ancestry.truncated) run.baseBehind = { mirrorHead };
              }
            }
          } catch { /* Refresh and ancestry checks do not move a continuation off its parent workspace. */ }
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
            if (setup.exitCode !== 0 || setup.interrupted) throw new TeamError(409, "team-setup-failed", "The configured setup command failed. Inspect the isolated workspace before restarting.");
            await assertMemberReadOnly(workspace.workspace, workspace.baseCommit, this.config.teams?.commandPrefix, signal, "setup");
          }
          assertParent();
          if (workspaceSource.head && !fromMirror) await assertMemberReadOnly(workspaceSource.path, workspaceSource.head, this.config.teams?.commandPrefix, signal, "integration");
          return workspace;
        };
        // The refresh above has released its working-tree hold by now, so the ordinary project gate still applies:
        // it keeps a run from preparing while repository setup changes and lets a sync apply see the start.
        return this.startInProject(run.projectId, prepareWorkspace);
      }, workspace => { Object.assign(run, workspace); run.headCommit = workspace.baseCommit; stored.prepared = true; this.event(stored, "Isolated project ready. Starting the project manager."); });
      return this.view(stored);
    });
  }
  private replay(stored: Stored, operation: string, body: Action | Mutation | TeamContinue | TeamParallelism | VerificationMutation) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== digest({ operation, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
    return true;
  }
  private mutation(stored: Stored, operation: string, body: Action | Mutation | TeamContinue | TeamParallelism | VerificationMutation) {
    const fingerprint = digest({ operation, ...body });
    const prior = stored.receipts[body.requestId];
    if (prior) {
      if (prior !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
      return false;
    }
    if (body.revision !== stored.run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
    if (stored.run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
    stored.receipts[body.requestId] = fingerprint;
    return true;
  }
  steer(id: string, input: Mutation) {
    const body = teamMutationSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id);
      if (this.replay(stored, "steer", body)) return this.view(stored);
      if (stored.deliveryAttempt || stored.run.deliveryReceipt) throw new TeamError(409, "delivery-reconciliation-required", "Inspect the recorded pull request before starting another run; steering cannot replay a started delivery.");
      if (stored.pending && !this.commands.has(id)) throw new TeamError(409, "team-reconciliation-required", "This team has an unresolved workspace or verification operation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (stored.pending && stored.pending.kind !== "check") throw new TeamError(409, "team-operation-running", "A workspace operation is in progress. Retry steering after it settles.");
      if (stored.run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (Buffer.byteLength(stored.run.steering.map(item => item.text).join("")) + Buffer.byteLength(body.text) > 32 * 1024) throw new TeamError(409, "team-steering-limit", "This team reached its 32 KiB steering limit. Start a new team with consolidated requirements.");
      if (stored.run.steering.length >= 20) throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team from the reviewed integration branch.");
      if (!this.mutation(stored, "steer", body)) return this.view(stored);
      this.commands.get(id)?.abort();
      await this.invalidatePermissionDecisions(stored, "The team revision changed before the permission request could be answered.");
      if (stored.run.recovery && stored.run.recovery.status !== "exhausted") {
        stored.run.recovery.status = "exhausted";
        this.event(stored, "User steering superseded automatic recovery; its original report remains recorded as evidence.");
      }
      stored.run.revision++; stored.run.steering.push({ text: body.text, revision: stored.run.revision, at: timestamp() });
      stored.run.status = "planning"; stored.halt = "steer"; stored.run.reason = "Stopping earlier members before planning the updated request."; stored.run.blockCode = undefined;
      stored.run.tasks = []; stored.run.review = undefined; stored.run.round = 0; stored.checkHead = undefined;
      stored.run.brief = undefined; stored.run.noChange = undefined;
      if (stored.run.discovery && !stored.run.discovery.completedAt) stored.run.discovery.completedAt = timestamp();
      this.event(stored, "User steering recorded. Earlier reports cannot satisfy the new revision."); this.save(stored);
      return this.view(stored);
    });
  }
  reconcileDelivery(id: string, input: TeamDeliveryReconcile) {
    const body: TeamDeliveryReconcile = teamDeliveryReconcileSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "reconcile-delivery", body)) return this.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before reconciling delivery.");
      if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
      if (run.linearTracking || run.linear) {
        const refreshed = this.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
        const tracking = this.linear?.getTeam(run.id) ?? refreshed;
        if (tracking && run.linear !== tracking) { run.linear = tracking; this.save(stored); }
        if (!this.linear || tracking?.status !== "synced")
          throw new TeamError(409, "linear-reconciliation-required", "Linear has not confirmed the current issue and requirements. Refresh tracking before delivery reconciliation.");
      }
      const pending = stored.pending;
      const failedOperation = body.failedOperation;
      const unavailable = () => new TeamError(409, "delivery-reconciliation-unavailable", "Delivery reconciliation requires a blocked, prepared team with settled delivery evidence and no active halt.");
      if (pending && !failedOperation) throw unavailable();
      if (failedOperation && (!pending || pending.id !== failedOperation.pendingId))
        throw new TeamError(409, "delivery-reconciliation-operation-changed", "The pending operation changed. Refresh the team and inspect its current evidence.");
      if (failedOperation && failedOperation.headCommit !== run.headCommit)
        throw new TeamError(409, "delivery-reconciliation-head-changed", "The attestation must name the current reviewed head.");
      if (run.status !== "blocked" || !stored.prepared || this.commands.has(id) || stored.halt) throw unavailable();
      if (run.goal || run.missionId || run.handoff)
        throw new TeamError(409, "delivery-reconciliation-unavailable", "Only standalone teams can reconcile a delivery attempt.");
      if (run.stopReason || run.members.length >= 60)
        throw new TeamError(409, "team-stopped-at-limit", "The team reached its execution limit and cannot retry delivery.");

      const attempt = stored.deliveryAttempt;
      const previous = attempt && run.members.find(member => member.memberId === attempt.memberId);
      const reconciliation = previous?.report?.kind === "delivery-reconciliation" ? previous.report : undefined;
      const failureCodes = new Set(["workspace-operation-failed", "invalid-workspace-baseline", "workspace-copy-changed", "delivery-baseline-source-mismatch"]);
      const recoveryAttempts = Math.max(run.deliveryRecovery?.attempts ?? 0, run.recovery?.attempts ?? 0);
      const failedPendingEligible = Boolean(failedOperation && pending?.kind === "result" && pending.revision === run.revision &&
        pending.failure?.code && failureCodes.has(pending.failure.code) && pending.source?.role === "delivery" && pending.source.workspace === "member" &&
        pending.source.memberId === previous?.memberId && pending.source.memberId === attempt?.memberId && pending.source.cwd === previous?.cwd &&
        pending.source.baseCommit === run.headCommit && pending.source.headCommit === run.headCommit && previous?.report?.kind === "delivery-reconciliation" &&
        previous.report.disposition === "no-publication" && previous.report.repository === run.delivery?.repository &&
        previous.report.branch === run.branch && previous.report.headCommit === run.headCommit && previous.report.remoteHeadCommit === undefined &&
        previous.report.pullRequestUrl === undefined && previous.report.baseHeadCommit !== run.baseCommit && run.deliveryRecovery?.revision === run.revision &&
        run.deliveryRecovery.headCommit === run.headCommit && run.deliveryRecovery.policyHash === digest(run.delivery) &&
        run.deliveryRecovery.sourceMemberId === previous.memberId && run.deliveryRecovery.disposition === "no-publication" &&
        run.deliveryRecovery.baseHeadCommit === previous.report.baseHeadCommit && ["planning", "exhausted"].includes(run.deliveryRecovery.status) &&
        run.recovery?.source.code === "delivery-baseline-conflict" && run.recovery.source.memberId === previous.memberId &&
        run.recovery.source.revision === run.revision);
      if (failedOperation && !failedPendingEligible) throw unavailable();
      if (failedPendingEligible && recoveryAttempts >= automaticRecoveryLimit)
        throw new TeamError(409, "delivery-recovery-exhausted", "The team exhausted its delivery recovery allowance. Its failed operation and remote report remain retained.");
      const retainedFailure = previous?.report?.kind === "blocked" || Boolean(reconciliation && reconciliation.disposition !== "pull-request" &&
        reconciliation.repository === run.delivery?.repository && reconciliation.branch === run.branch && reconciliation.headCommit === run.headCommit);
      if (!attempt || !previous || previous.role !== "delivery" || previous.revision !== run.revision || previous.status !== "stopped" ||
          !retainedFailure || attempt.revision !== run.revision || !run.headCommit ||
          attempt.headCommit !== run.headCommit || previous.baseCommit !== run.headCommit || !run.branch)
        throw new TeamError(409, "delivery-reconciliation-unavailable", "The recorded delivery attempt does not identify a stopped, blocked delivery report for the current reviewed head.");
      if (run.deliveryReceipt || run.pullRequest)
        throw new TeamError(409, "delivery-reconciliation-unavailable", "A recorded pull request or delivery receipt must be reconciled before starting another delivery attempt.");
      if (run.members.some(member => member.status !== "stopped"))
        throw new TeamError(409, "delivery-reconciliation-unavailable", "Every team member must be confirmed stopped before delivery reconciliation.");
      if ((run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status)))
        throw new TeamError(409, "delivery-reconciliation-unavailable", "An unresolved permission decision must be reconciled before delivery can continue.");
      if (!run.lineup?.coordinator || run.lineup.coordinator.tier !== "strong")
        throw new TeamError(409, "delivery-lineup-required", "Delivery reconciliation requires the configured strong coordinator profile.");

      this.assertBudget(run, true);
      this.assertDelivery(stored);
      const head = run.headCommit;
      this.assertRunPath(stored, run.workspace);
      this.assertRunPath(stored, previous.cwd);
      if (await teamHead(run.workspace, this.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "delivery-reconciliation-head-changed", "The integration workspace no longer matches the reviewed delivery head.");
      await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, undefined, "integration");
      await assertMemberReadOnly(previous.cwd, head, this.config.teams?.commandPrefix);

      const priorRun = structuredClone(run);
      if (!this.mutation(stored, "reconcile-delivery", body)) return this.view(stored);
      const priorAttempt = structuredClone(attempt);
      const priorReport = structuredClone(previous.report);
      const failedReceipt = failedPendingEligible && pending?.failure && failedOperation ? {
        requestId: body.requestId, pendingId: pending.id, pendingKind: "result" as const, revision: pending.revision, headCommit: failedOperation.headCommit,
        source: { memberId: pending.source!.memberId, role: "delivery" as const }, failure: { ...structuredClone(pending.failure), code: pending.failure.code! },
        report: structuredClone(priorReport) as DeliveryReconciliationReport & { disposition: "no-publication" },
        recoveryAttempts, attestation: structuredClone(failedOperation.attestation), at: timestamp(),
      } : undefined;
      const feedback = [
        "Owner-authorized reconciliation of an interrupted delivery attempt.",
        `Owner reconciliation instructions: ${body.text}`,
        `Prior delivery member: ${previous.memberId}; prior revision: ${previous.revision}; pinned head: ${priorAttempt.headCommit}; branch: ${run.branch}.`,
        `Prior ${priorReport?.kind === "blocked" ? "blocked" : "delivery"} report (preserved verbatim in the original member record): ${JSON.stringify(priorReport)}`,
        ...(failedReceipt ? [`The failure of pending operation ${failedReceipt.pendingId} (${failedReceipt.failure.code}, ${failedReceipt.failure.at}) is preserved in deliveryOperationReconciliations.`,
          `Operator process-quiescence claim, not host-verified: ${JSON.stringify(failedReceipt.attestation.text)}`,
          "The prior no-publication report is historical, not current remote evidence. Before any write or publication, re-inspect the remote branch, any pull request, CI, and the pinned base head, then report a fresh structured result."] :
          ["Before any write or publication action, inspect the current remote branch, pull request, and CI state for this exact head."]),
        "Reuse an existing branch or pull request and report completed work; never create a duplicate pull request.",
        "Keep the pinned delivery policy, repository, branch, base branch, reviewed head, required checks, and review unchanged. Do not bypass a denied action by switching credentials, tools, or routes. If required capability is still missing, stop and report the blocker. The host has not authorized a new credential or a broader permission.",
      ].join("\n\n");
      try {
        if (failedReceipt) {
          run.deliveryOperationReconciliations ??= [];
          run.deliveryOperationReconciliations.push(failedReceipt);
          delete stored.pending;
        }
        this.event(stored, `Owner authorized a fresh delivery reconciliation at ${head} on ${run.branch}; prior attempt ${previous.memberId} and its delivery report remain in team history.${failedReceipt ? ` Failed operation ${failedReceipt.pendingId} (${failedReceipt.failure.code}, ${failedReceipt.failure.at}) was preserved. Operator claim, not host-verified: ${JSON.stringify(failedReceipt.attestation.text.slice(0, 500))}` : ""}`);
        // prepareMember persists the receipt and replacement member intent together, before any copy work.
        this.prepareMember(stored, "delivery", undefined, feedback, member => {
          stored.deliveryAttempt = { memberId: member.memberId, revision: member.revision, headCommit: head };
          run.deliveryRecovery = { attempts: recoveryAttempts, status: "planning", revision: run.revision, headCommit: head,
            policyHash: digest(run.delivery!), sourceMemberId: member.memberId };
          run.recovery = { attempts: recoveryAttempts, status: "planning", source: { code: "delivery-recovery", memberId: previous.memberId,
            revision: previous.revision, reportKind: previous.report!.kind, reason: body.text, at: timestamp() } };
          run.reason = undefined; run.blockCode = undefined;
        });
      } catch (error) {
        // A synchronous failure has not started the copy. Restore the whole run so newly added
        // receipt fields cannot survive a rejected request, including on the next disk restore.
        this.commands.get(id)?.abort(); this.commands.delete(id);
        stored.pending = pending;
        stored.run = priorRun;
        stored.deliveryAttempt = priorAttempt;
        delete stored.receipts[body.requestId];
        this.save(stored);
        throw error;
      }
      return this.view(stored);
    });
  }
  reconcileVerification(id: string, input: VerificationMutation) {
    const body = teamVerificationReconcileSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "reconcile-verification", body)) return this.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before reconciling verification.");
      if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
      if (run.linearTracking || run.linear) {
        const refreshed = this.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
        const tracking = this.linear?.getTeam(run.id) ?? refreshed;
        if (tracking && run.linear !== tracking) { run.linear = tracking; this.save(stored); }
        if (!this.linear || tracking?.status !== "synced") throw new TeamError(409, "linear-reconciliation-required", "Linear has not confirmed the current issue and requirements. Refresh tracking before reconciling verification.");
      }
      const unavailable = (message: string) => new TeamError(409, "verification-reconciliation-unavailable", message);
      const pending = stored.pending;
      if (run.status !== "blocked" || stored.halt || !stored.prepared || run.reason !== interruptedOperationReason)
        throw unavailable("Verification reconciliation requires a prepared blocked team with restart-interruption evidence and no active halt.");
      if (!pending || pending.kind !== "check" || pending.failure || pending.revision !== run.revision)
        throw unavailable("Only an unresolved restart-interrupted check can be reconciled; other uncertain operations remain fenced.");
      if (pending.id !== body.pendingId) throw new TeamError(409, "verification-reconciliation-operation-changed", "The pending check changed. Refresh the team and inspect its evidence.");
      if (this.commands.has(id) || stored.deliveryAttempt || run.deliveryReceipt || run.pullRequest || run.stopReason || run.permissionsRevokedAt ||
          run.members.some(member => member.status !== "stopped") ||
          (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status)))
        throw unavailable("Members, permission decisions, delivery state, or the operation are not fully quiescent for verification reconciliation.");
      const head = run.headCommit;
      if (!head || !commitId.test(head) || body.headCommit !== head || stored.checkHead === head)
        throw new TeamError(409, "verification-reconciliation-head-changed", "The requested head is not the current unchecked integration commit.");
      const attempt = run.checks.filter(check => check.revision === run.revision && check.round === run.round && check.headCommit === head);
      if (!attempt.length || attempt.at(-1)?.status !== "interrupted" || attempt.slice(0, -1).some(check => check.status !== "passed") ||
          run.checks.some(check => check.status === "running"))
        throw unavailable("The retained check records do not prove a single interrupted final check attempt.");
      const expected = this.verificationCommands(run);
      if (attempt.length > expected.length || attempt.some((check, index) => check.command.command !== expected[index]?.command.command ||
          JSON.stringify(check.command.args ?? []) !== JSON.stringify(expected[index]?.command.args ?? []) || (check.phase ?? "verification") !== (expected[index]?.phase ?? "verification")))
        throw new TeamError(409, "verification-policy-changed", "The retained check commands do not match the current verification policy.");
      this.assertBudget(run);
      this.assertRunPath(stored, run.workspace);
      if (await teamHead(run.workspace, this.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "verification-reconciliation-head-changed", "The integration workspace no longer matches the recorded commit.");
      await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, undefined, "integration");
      if (!this.mutation(stored, "reconcile-verification", body)) return this.view(stored);
      run.verificationReconciliations ??= [];
      run.verificationReconciliations.push({ requestId: body.requestId, pendingId: pending.id, revision: run.revision, round: run.round, headCommit: head,
        interruptedChecks: attempt.filter(check => check.status === "interrupted").length, attestation: body.attestation.text, at: timestamp() });
      stored.pending = undefined;
      delete stored.verificationRecovery;
      run.status = "verifying"; run.reason = undefined; run.blockCode = undefined;
      this.event(stored, `An operator attested that processes for the interrupted check had stopped. The ${head} integration and earlier evidence are retained; fresh verification will use a new disposable workspace. Operator claim, not host-verified: ${JSON.stringify(body.attestation.text.slice(0, 500))}`);
      this.save(stored);
      return this.view(stored);
    });
  }
  inspectMemberRuntime(id: string, memberId: string) {
    const stored = this.record(id), run = stored.run;
    const member = run.members.find(item => item.memberId === memberId && item.revision === run.revision);
    if (!member) throw new TeamError(404, "member-not-found", "The current team revision has no such member.");
    return this.manager.inspectTeamRuntime(member.sessionId, assignment(member));
  }
  retireMember(id: string, memberId: string, input: TeamMemberRetire) {
    const body = teamMemberRetireSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "retire-member", body)) return this.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before retiring a member.");
      const member = run.members.find(item => item.memberId === memberId && item.revision === run.revision);
      const unavailable = () => new TeamError(409, "member-retirement-unavailable", "Only an unreported current reviewer at the verified head can be retired under an unchanged, quiescent team state.");
      if (run.status === "cancelled" || run.status === "paused" || stored.halt || !member || member.role !== "reviewer" || member.report ||
          !["unavailable", "running"].includes(member.status) || member.sessionId !== body.sessionId || member.baseCommit !== run.headCommit ||
          member.baseCommit !== stored.checkHead || stored.pending || this.commands.has(id) || stored.deliveryAttempt || run.deliveryReceipt ||
          run.pullRequest || run.stopReason || (run.permissionDecisions ?? []).some(decision => decision.targetSessionId === body.sessionId &&
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
        this.block(stored, error, member);
        return this.view(stored);
      }
      if (!this.mutation(stored, "retire-member", body)) return this.view(stored);
      member.status = "stopped"; member.stoppedReason = "Recording failed; runtime retired after confirmed process exit"; member.retirement = retirement;
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
    return this.enqueue(async () => {
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
  answer(id: string, decisionId: string, input: Mutation, authorizeNewAnswer?: () => void, by: "owner" | "coordinator" = "owner") {
    const body = teamMutationSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, `answer:${decisionId}`, body)) return this.view(stored);
      authorizeNewAnswer?.();
      const decision = run.decisions.find(item => item.id === decisionId && item.revision === run.revision);
      if (!decision) throw new TeamError(404, "decision-not-found", "This decision is no longer current.");
      if (stored.receipts[body.requestId]) { this.mutation(stored, `answer:${decisionId}`, body); return this.view(stored); }
      if (decision.answer) throw new TeamError(409, "decision-answered", "This decision already has an answer.");
      if (stored.halt || run.status === "paused") throw new TeamError(409, "team-paused", "Resume the team before answering its decision.");
      if (!this.mutation(stored, `answer:${decisionId}`, body)) return this.view(stored);
      decision.answer = body.text; decision.answeredBy = by; decision.answeredAt = timestamp();
      this.event(stored, by === "coordinator" ? "A mission coordinator decision was recorded. The requesting member will continue in a new attempt." : "A user decision was recorded. The requesting member will continue in a new attempt."); this.save(stored);
      return this.view(stored);
    });
  }
  revokePermissions(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (!run.permissions) throw new TeamError(409, "permissions-not-enabled", "This team has no delegated permission policy to revoke.");
      if (this.replay(stored, "revoke-permissions", body)) return this.view(stored);
      if (!this.mutation(stored, "revoke-permissions", body)) return this.view(stored);
      run.permissionsRevokedAt ??= timestamp();
      await this.invalidatePermissionDecisions(stored, "The owner revoked delegated permission decisions.");
      this.event(stored, "Delegated permission decisions were revoked by the owner.");
      this.save(stored);
      return this.view(stored);
    });
  }
  private async invalidatePermissionDecisions(stored: Stored, reason: string) {
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
      try {
        const fence = await this.manager.invalidateTeamPermission(decision.targetSessionId, decision.id);
        if (fence !== "invalidated") uncertain = true;
      } catch { uncertain = true; }
    }
    if (uncertain) this.event(stored, "An in-flight delegated permission answer could not be conclusively fenced. Its decision remains uncertain; inspect the target session.");
    this.save(stored);
  }
  pause(id: string, input: Action) { return this.action(id, "pause", teamActionSchema.parse(input)); }
  resume(id: string, input: Action) { return this.action(id, "resume", teamActionSchema.parse(input)); }
  cancel(id: string, input: Action) { return this.action(id, "cancel", teamActionSchema.parse(input)); }
  continueRun(id: string, input: TeamContinue) {
    const body = teamContinueSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "continue", body)) return this.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
      if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");

      if (run.linearTracking || run.linear) {
        const refreshed = this.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
        const tracking = this.linear?.getTeam(run.id) ?? refreshed;
        if (tracking && run.linear !== tracking) { run.linear = tracking; this.save(stored); }
        if (!this.linear || tracking?.status !== "synced")
          throw new TeamError(409, "linear-reconciliation-required", "Linear has not confirmed the current issue and requirements. Refresh tracking before continuing this run.");
      }
      if (run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (!this.canContinue(stored, run.linear?.status, true))
        throw new TeamError(409, "team-continuation-unavailable", "This blocked run has unresolved work, an uncertain side effect, or no safely continuable standalone revision.");
      this.assertBudget(run, true);

      const head = run.headCommit;
      if (!head || !commitId.test(head)) throw new TeamError(409, "team-continuation-head-unavailable", "The run has no valid recorded integration commit to continue from.");
      this.assertRunPath(stored, run.workspace);
      await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, undefined, "integration");
      if (body.text && (Buffer.byteLength(run.steering.map(item => item.text).join("")) + Buffer.byteLength(body.text) > 32 * 1024 || run.steering.length >= 20))
        throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team with consolidated requirements.");

      const continuation: TeamContinuation = {
        revision: run.revision,
        requestId: body.requestId,
        at: timestamp(),
        reason: run.reason ?? run.blockCode ?? "Blocked run continued by its owner.",
        headCommit: head,
        tasks: structuredClone(run.tasks),
        ...(run.review ? { review: structuredClone(run.review) } : {}),
        ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
      };
      const next = structuredClone(stored);
      if (!this.mutation(next, "continue", body)) return this.view(stored);
      const nextRevision = next.run.revision + 1;
      next.run.continuations = [...(next.run.continuations ?? []), continuation];
      next.run.revision = nextRevision;
      next.run.tasks = [];
      next.run.review = undefined;
      next.run.round = 0;
      next.checkHead = undefined;
      next.verificationRecovery = undefined;
      next.run.brief = undefined;
      next.run.noChange = undefined;
      next.run.blockCode = undefined;
      next.run.reason = undefined;
      if (next.run.discovery && !next.run.discovery.completedAt) next.run.discovery.completedAt = timestamp();
      if (body.text) next.run.steering.push({ text: body.text, revision: nextRevision, at: timestamp() });
      next.run.status = "planning";
      next.halt = undefined;
      next.continuationHead = { revision: nextRevision, headCommit: head };
      this.event(next, `Owner continued the run from its clean integration commit at revision ${nextRevision}. Prior tasks, checks, member records, permissions, and review evidence remain available in the run history.`);
      this.save(next);
      Object.assign(stored, next);
      return this.view(stored);
    });
  }
  private async resumeVerificationRecovery(stored: Stored, body: Action, recovery: NonNullable<Stored["verificationRecovery"]>) {
    const run = stored.run;
    if (!this.canResume(stored) || this.commands.has(run.id))
      throw new TeamError(409, "team-reconciliation-required", "This verification failure is no longer eligible for Resume. Inspect the retained workspace and evidence.");
    if (stored.halt) throw new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
    if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
    if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
    this.assertBudget(run);

    const prefix = this.config.teams?.commandPrefix;
    const originalWorkspace = run.workspace;
    this.assertRunPath(stored, originalWorkspace);
    const head = await teamHead(originalWorkspace, prefix);
    if (head !== recovery.headCommit)
      throw new TeamError(409, "verification-recovery-head-changed", "The integration HEAD changed after the verification failure. Its original workspace was preserved for reconciliation.");
    const recovered = await prepareRecoveredWorkspace(originalWorkspace, randomUUID(), recovery.headCommit, prefix, undefined, run.branch);
    this.assertRunPath(stored, recovered.workspace);
    await assertMemberReadOnly(recovered.workspace, recovery.headCommit, prefix, undefined, "integration");
    if (await teamHead(originalWorkspace, prefix) !== recovery.headCommit)
      throw new TeamError(409, "verification-recovery-head-changed", "The integration HEAD changed while Resume prepared a clean copy. Its original workspace was preserved for reconciliation.");

    await this.invalidatePermissionDecisions(stored, "The team resumed under a new revision.");
    const next = structuredClone(stored);
    if (!this.mutation(next, "resume", body)) return this.view(stored);
    next.run.workspace = recovered.workspace;
    next.pending = undefined;
    next.verificationRecovery = undefined;
    next.halt = undefined;
    next.run.revision++; next.run.tasks = []; next.run.review = undefined; next.run.round = 0; next.checkHead = undefined;
    next.run.brief = undefined; next.run.noChange = undefined;
    if (next.run.discovery && !next.run.discovery.completedAt) next.run.discovery.completedAt = timestamp();
    next.run.status = "planning"; next.run.reason = undefined; next.run.blockCode = undefined;
    const workspaceRoot = stored.root ?? this.config.teams?.workspaceDir ?? dirname(originalWorkspace);
    const originalPath = relative(workspaceRoot, originalWorkspace).slice(0, 256);
    const recoveredPath = relative(workspaceRoot, recovered.workspace).slice(0, 256);
    this.event(next, `The team resumed from a clean workspace at the recorded integration commit. Original integration copy preserved at ${originalPath}; fresh workspace at ${recoveredPath}. Prior member and check evidence remains available under its original revision.`);
    this.save(next);
    Object.assign(stored, next);
    return this.view(stored);
  }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action) {
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, action, body)) return this.view(stored);
      if (action === "pause" && (["ready-for-review", "merged", "no-change"].includes(run.status) || run.status === "blocked" && !run.workspaceRemovedAt)) throw new TeamError(409, "team-not-running", "This team is not running and cannot be paused.");
      const verificationRecovery = action === "resume" && validVerificationRecovery(stored) ? stored.verificationRecovery : undefined;
      // Uncertain operations and started deliveries keep their reconciliation contract; a removed
      // workspace is reported next, before the generic blocked-run resume check it would otherwise fail.
      if (action === "resume" && ((stored.pending && !verificationRecovery) || stored.deliveryAttempt || run.deliveryReceipt))
        throw new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (action === "resume" && run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (action === "resume" && (!stored.prepared || (run.status === "blocked" && !this.canResume(stored, undefined, true))))
        throw new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (action === "resume" && verificationRecovery && this.commands.has(id)) throw new TeamError(409, "team-operation-running", "The verification operation is still stopping. Retry Resume after it settles.");
      if (action === "resume" && stored.halt) throw new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
      if (action === "resume" && verificationRecovery) return this.resumeVerificationRecovery(stored, body, verificationRecovery);
      if (!this.mutation(stored, action, body)) return this.view(stored);
      if (action === "resume") {
        if (run.status !== "paused" && !this.canResume(stored)) { this.save(stored); return this.view(stored); }
        // Pausing stopped native agents. Replan from the confirmed integration head, preserving stopped copies for inspection.
        run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
        run.brief = undefined; run.noChange = undefined;
        if (run.discovery && !run.discovery.completedAt) run.discovery.completedAt = timestamp();
        await this.invalidatePermissionDecisions(stored, "The team resumed under a new revision.");
        run.status = "planning"; run.reason = undefined; run.blockCode = undefined;
      } else {
        if (run.recovery && run.recovery.status !== "exhausted") {
          run.recovery.status = "exhausted";
          run.recovery.source = { ...run.recovery.source, code: `owner-${action}`, reason: `The owner ${action} the team before automatic recovery finished.` };
        }
        run.status = action === "pause" ? "paused" : "cancelled"; stored.halt = action;
        await this.invalidatePermissionDecisions(stored, `The team was ${action} before the permission request could be answered.`);
        run.reason = "Stopping active team members; any human input lease remains authoritative.";
        this.commands.get(id)?.abort();
      }
      this.event(stored, `Team ${action === "resume" ? "resumed with a fresh plan" : action === "pause" ? "paused" : "cancelled"}.`); this.save(stored);
      return this.view(stored);
    });
  }
  start() {
    if (this.running || this.closed) return;
    this.running = true;
    const tick = () => {
      if (this.tickQueued || !this.running) return;
      this.tickQueued = true;
      void this.enqueue(async () => {
        try {
          // One session listing every 2 s feeds the usage ledger and the limit memory, which follows
          // every session on the host, not only team members.
          if (Date.now() - this.reconciledAt >= 2000) {
            this.reconciledAt = Date.now();
            const rows = await this.manager.list().catch(() => undefined);
            if (rows) {
              await this.usage?.tick(rows).catch(() => {});
              await this.limits.reconcile(this.manager, rows).catch(() => {});
            }
          }
          for (const stored of this.records.values()) await this.step(stored);
        }
        finally { this.tickQueued = false; }
      }).catch(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); for (const controller of this.commands.values()) controller.abort(); }
  /** Settles once work queued before now has finished, so a caller can stop sessions it may still launch. */
  idle() { return this.serial.then(() => undefined); }
  private stallWindow() { return (this.config.teams?.stallMinutes ?? 30) * 60000; }
  /**
   * Extends a deadline only under the owner's recorded policy, and only while an active member of this
   * revision showed activity within the stall window. The extension never passes the policy's ceiling.
   */
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
  /** Owner extensions reach the active goal team, so its own deadline check and the goal agree. */
  goalExtension(teamId: string, requestId: string) {
    const stored = this.record(teamId), receipt = stored.goalExtensions?.[requestId];
    return receipt && { ...receipt, stopReason: stored.run.stopReason };
  }
  extendGoalTime(teamId: string, requestId: string, minutes: number, goalDeadlineAt: string, goalCeilingAt: string,
    intent?: { deadlineAt: string; ceilingAt: string }) {
    return this.enqueue(() => {
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
      // Publish only after persistence: a failed write must not leave a replayable in-memory receipt.
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
    const limit = (run.goal ?? run.handoff)?.maxMembers ?? 60;
    if (run.members.length + (addingMember ? 1 : 0) > limit) {
      if (run.goal || run.handoff) run.stopReason = "member-limit";
      throw new TeamError(409, "team-attempt-limit", `The team reached its limit of ${limit} agent attempts. Review its evidence before continuing.`);
    }
  }
  /** Persist an intent before external work. A restart keeps the unresolved intent blocked. */
  private operation<T>(stored: Stored, kind: NonNullable<Stored["pending"]>["kind"], perform: (signal: AbortSignal) => Promise<T>, complete: (value: T) => void,
    sourceMember?: TeamMember, sourceWorkspace: "member" | "integration" = "member") {
    if (stored.pending) throw new TeamError(409, "team-operation-running", "A team workspace operation is already running.");
    const pending: PendingOperation = { id: randomUUID(), kind, revision: stored.run.revision,
      ...(sourceMember ? { source: { memberId: sourceMember.memberId, role: sourceMember.role, cwd: sourceMember.cwd, baseCommit: sourceMember.baseCommit,
        headCommit: stored.run.headCommit ?? sourceMember.baseCommit, workspace: sourceWorkspace } } : {}) };
    const controller = new AbortController(); this.commands.set(stored.run.id, controller);
    stored.pending = pending; this.save(stored);
    void perform(controller.signal).then(value => this.enqueue(() => {
      if (this.closed || stored.pending?.id !== pending.id) return;
      this.commands.delete(stored.run.id);
      try { this.assertBudget(stored.run); } catch (error) { this.block(stored, error); return; }
      if (stored.run.stopReason) { this.block(stored, new TeamError(409, "goal-budget-exhausted", "The goal exhausted its execution budget.")); return; }
      const held = ["paused", "cancelled", "blocked"].includes(stored.run.status) ? stored.run.status : undefined;
      stored.pending = undefined;
      try { complete(value); } catch (error) { this.block(stored, error); }
      if (held) stored.run.status = held;
      this.save(stored);
    }), error => this.enqueue(() => {
      if (this.closed || stored.pending?.id !== pending.id) return;
      this.commands.delete(stored.run.id);
      // Failed side effects retain their intent; a pause must not make them replayable.
      pending.failure = { code: error instanceof TeamError ? error.code : "workspace-operation-failed",
        reason: error instanceof Error ? error.message : "A team workspace operation failed.", at: timestamp() };
      this.save(stored);
      this.block(stored, error);
    })).catch(() => {});
  }
  private queueAutomaticDeliveryRecovery(stored: Stored, member: TeamMember, reason: string) {
    const { run } = stored, attempt = stored.deliveryAttempt, policyHash = run.delivery ? digest(run.delivery) : undefined;
    if (!attempt || !policyHash || member.role !== "delivery" || member.status !== "stopped" || member.report?.kind !== "blocked" || attempt.memberId !== member.memberId ||
        attempt.revision !== run.revision || attempt.headCommit !== run.headCommit || member.baseCommit !== run.headCommit ||
        run.deliveryReceipt || run.pullRequest || run.stopReason || run.permissionsRevokedAt || !run.delivery ||
        !run.lineup?.coordinator || run.lineup.coordinator.tier !== "strong" || !run.headCommit ||
        run.recovery?.status === "exhausted" || run.recovery?.status === "stopping" ||
        ["complete", "exhausted"].includes(run.deliveryRecovery?.status ?? "") ||
        !["blocked", "delivering", "planning"].includes(run.status) || ["paused", "cancelled"].includes(run.status) ||
        stored.halt === "pause" || stored.halt === "cancel" || stored.halt === "steer" ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status)) ||
        run.linearTracking && run.linear?.status !== "synced") return false;
    try { this.assertDelivery(stored); } catch { return false; }
    const prior = run.deliveryRecovery;
    const failureHash = digest({ headCommit: run.headCommit, policyHash, reason });
    const attempts = Math.max(prior?.attempts ?? 0, run.recovery?.attempts ?? 0);
    if (attempts >= automaticRecoveryLimit || prior?.lastFailureHash === failureHash) {
      run.deliveryRecovery = { ...prior, attempts, status: "exhausted", revision: run.revision, headCommit: run.headCommit, policyHash,
        sourceMemberId: member.memberId, lastFailureHash: failureHash };
      run.recovery = { attempts, status: "exhausted", source: { code: "delivery-recovery", memberId: member.memberId, revision: member.revision,
        reportKind: member.report.kind, reason, at: timestamp() } };
      return false;
    }
    run.deliveryRecovery = { attempts: attempts + 1, status: "stopping", revision: run.revision, headCommit: run.headCommit, policyHash,
      sourceMemberId: member.memberId, lastFailureHash: failureHash };
    run.recovery = { attempts: attempts + 1, status: "stopping", source: { code: "delivery-recovery", memberId: member.memberId, revision: member.revision,
      reportKind: member.report.kind, reason, at: timestamp() } };
    run.status = "planning"; stored.halt = "block"; run.blockCode = "delivery-recovery"; run.reason = reason;
    this.commands.get(run.id)?.abort();
    this.event(stored, `The strong coordinator will inspect the exact remote branch and pull request before another delivery attempt (${attempts + 1} of ${automaticRecoveryLimit}).`);
    this.save(stored);
    return true;
  }
  private admitBlockedDeliveryRecovery(stored: Stored) {
    const { run } = stored, attempt = stored.deliveryAttempt;
    if (run.status !== "blocked" || stored.pending || this.commands.has(run.id) || !attempt ||
        run.recovery?.status === "exhausted" || run.deliveryRecovery?.status === "exhausted") return;
    const member = run.members.find(item => item.memberId === attempt.memberId && item.revision === attempt.revision);
    if (member?.status === "stopped" && member.report?.kind === "blocked")
      this.queueAutomaticDeliveryRecovery(stored, member, member.report.summary);
  }
  private block(stored: Stored, error: unknown, sourceMember?: TeamMember) {
    const pending = stored.pending, run = stored.run;
    const code = error instanceof TeamError ? error.code : undefined;
    if (!pending && sourceMember?.role === "delivery" && sourceMember.report?.kind === "blocked" &&
        this.queueAutomaticDeliveryRecovery(stored, sourceMember, sourceMember.report.summary)) return;
    const operationSource = pending && recoverableOperationFailure(stored, pending);
    const unattributedOperation = pending && recoverableUnattributedResult(stored, pending);
    if ((operationSource || unattributedOperation) && !stored.deliveryAttempt && !run.deliveryReceipt && !run.pullRequest && !run.stopReason &&
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
      !run.deliveryReceipt && !run.pullRequest && !run.stopReason && !run.permissionsRevokedAt && !permissionUncertain &&
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
    this.event(stored, stored.run.reason); this.save(stored); this.trackBlocked(stored);
  }
  private async startAutomaticDeliveryRecovery(stored: Stored, trackingReady: boolean) {
    const { run } = stored, recovery = run.recovery, delivery = run.deliveryRecovery;
    const attempt = stored.deliveryAttempt;
    const previous = attempt && run.members.find(member => member.memberId === attempt.memberId);
    if (!recovery || !delivery || !attempt || !previous || previous.role !== "delivery" || previous.report?.kind !== "blocked" ||
        delivery.status !== "stopping" || delivery.revision !== run.revision || delivery.headCommit !== run.headCommit ||
        delivery.policyHash !== digest(run.delivery ?? null) || attempt.revision !== run.revision || attempt.headCommit !== run.headCommit ||
        attempt.memberId !== previous.memberId || !trackingReady || stored.pending || this.commands.has(run.id) || run.deliveryReceipt || run.pullRequest ||
        run.stopReason || run.permissionsRevokedAt || run.linearTracking && run.linear?.status !== "synced" ||
        run.members.some(member => member.revision === recovery.source.revision && activeMember(member) && !terminalPermissionCoordinator(run, member)) ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) {
      this.block(stored, new TeamError(409, "delivery-reconciliation-required", "Automatic delivery recovery could not establish the same reviewed head, policy, stopped members, and permissions. Inspect retained delivery evidence."));
      return true;
    }
    try {
      this.assertBudget(run, true);
      this.assertDelivery(stored);
      this.assertRunPath(stored, run.workspace);
      const head = run.headCommit;
      if (!head || await teamHead(run.workspace, this.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "delivery-recovery-head-changed", "The integration HEAD changed before delivery inspection.");
      await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, undefined, "integration");
      const feedback = [
        `Automatic delivery reconciliation ${delivery.attempts} of ${automaticRecoveryLimit} under the unchanged owner policy.`,
        `Prior delivery attempt ${previous.memberId} reported blocked at revision ${previous.revision}, head ${head}. Its full report remains in team history: ${JSON.stringify(previous.report)}`,
        `Before any write or publication, inspect the exact remote repository ${run.delivery!.repository}, branch ${run.branch}, base ${run.delivery!.baseBranch}, and any pull request for this head. Reuse existing matching work and never create a duplicate PR.`,
        `If no publication exists, report the structured delivery-reconciliation disposition with exact repository, branch, reviewed head, and current base head. A moved base with no publication may return to implementation for a fresh review. An owned branch or open PR must keep its exact remote head; do not rewrite or force-push it.`,
        `If the same capability is still missing, report blocked. Do not switch tools, credentials, or routes, or request broader permissions.`,
      ].join("\n\n");
      this.prepareMember(stored, "delivery", undefined, feedback, member => {
        stored.deliveryAttempt = { memberId: member.memberId, revision: member.revision, headCommit: head };
        delivery.status = "planning"; delivery.sourceMemberId = member.memberId;
        recovery.status = "planning";
        run.reason = undefined; run.blockCode = undefined;
        this.event(stored, `A fresh strong-coordinator delivery inspection is queued for the same reviewed head ${head}; the previous blocked attempt remains in history.`);
      });
      run.status = "planning";
      this.save(stored);
    } catch (error) {
      this.block(stored, error);
    }
    return true;
  }
  private async startAutomaticRecovery(stored: Stored, trackingReady: boolean) {
    const { run } = stored, recovery = run.recovery;
    if (!recovery || recovery.status !== "stopping" || run.status !== "planning" || stored.halt) return false;
    if (recovery.source.code === "delivery-recovery") return this.startAutomaticDeliveryRecovery(stored, trackingReady);
    const operationPending = Boolean(stored.pending && (recoverableOperationFailure(stored, stored.pending) || recoverableUnattributedResult(stored, stored.pending)) &&
      stored.pending.revision === recovery.source.revision && (recovery.source.memberId === "unattributed" || recovery.source.memberId === stored.pending.source?.memberId));
    if (!trackingReady || stored.pending && !operationPending || stored.deliveryAttempt || run.deliveryReceipt || run.pullRequest || run.stopReason ||
        run.permissionsRevokedAt ||
        run.linearTracking && run.linear?.status !== "synced" ||
        run.members.some(member => member.revision === recovery.source.revision && activeMember(member) && !terminalPermissionCoordinator(run, member)) ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) {
      this.block(stored, new TeamError(409, "recovery-reconciliation-required", "The automatic recovery could not establish safe, authorized continuation. Inspect retained evidence and continue manually."));
      return true;
    }
    try {
      this.assertBudget(run);
      const head = run.headCommit;
      if (!head || !commitId.test(head) || await teamHead(run.workspace, this.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "recovery-head-changed", "The integration HEAD changed before automatic recovery. Inspect the retained workspace before continuing.");
      this.assertRunPath(stored, run.workspace);
      const originalWorkspace = run.workspace;
      let preservedWorkspace: string | undefined;
      try { await assertMemberReadOnly(originalWorkspace, head, this.config.teams?.commandPrefix, undefined, "integration"); }
      catch (error) {
        if (!operationPending) throw error;
        const clean = await prepareRecoveredWorkspace(originalWorkspace, randomUUID(), head, this.config.teams?.commandPrefix, undefined, run.branch);
        this.assertRunPath(stored, clean.workspace);
        await assertMemberReadOnly(clean.workspace, head, this.config.teams?.commandPrefix, undefined, "integration");
        if (await teamHead(originalWorkspace, this.config.teams?.commandPrefix) !== head)
          throw new TeamError(409, "recovery-head-changed", "The original integration HEAD changed while a clean recovery copy was prepared.");
        run.workspace = clean.workspace;
        preservedWorkspace = originalWorkspace;
      }
      const source = recovery.source;
      const preservedCopy = preservedWorkspace
        ? `The original integration workspace is preserved at ${preservedWorkspace}. Inspect its exact state and retained diff read-only against ${head}; its dirty or conflicted edits were not imported into the clean recovery workspace. Carry only approved work forward through a new assignment.`
        : "The integration workspace matched the recorded head and was clean.";
      const retainedMemberWorkspaces = run.members.filter(member => member.revision === source.revision && member.role !== "permission-coordinator").slice(0, 60)
        .map(member => `${member.memberId} (${member.role}${member.taskId ? `, task ${member.taskId}` : ""}; ${member.status}; base ${member.baseCommit}): ${member.cwd}`);
      const memberCopies = retainedMemberWorkspaces.length
        ? `Retained member workspaces for affected revision ${source.revision} are listed below. Inspect them read-only at their recorded base commits; preserve the original copies and use a new assignment to carry only approved work forward.\n${retainedMemberWorkspaces.join("\n")}`
        : "No non-permission member workspace was recorded for the affected revision.";
      const feedback = `Automatic PM recovery ${recovery.attempts} of ${automaticRecoveryLimit}. Diagnose and resolve the reported ${source.code} from member ${source.memberId} at revision ${source.revision}. The original report and every sibling report remain in team history. ${preservedCopy} ${memberCopies} Replan only within the existing objective, pinned verification, permissions, and parent scope. Do not bypass a provider denial or infer owner approval; ask the owner if a material decision is needed. Source evidence: ${source.reason}`;
      const nextRevision = run.revision + 1;
      run.continuations = [...(run.continuations ?? []), {
        revision: run.revision, requestId: randomUUID(), at: timestamp(), reason: `Automatic PM recovery after ${source.code}: ${source.reason}`,
        headCommit: head, tasks: structuredClone(run.tasks), ...(run.review ? { review: structuredClone(run.review) } : {}),
        ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
      }];
      run.revision = nextRevision;
      run.tasks = [];
      run.review = undefined;
      run.round = 0;
      stored.checkHead = undefined;
      run.brief = undefined;
      run.noChange = undefined;
      run.blockCode = undefined;
      run.reason = undefined;
      if (run.discovery && !run.discovery.completedAt) run.discovery.completedAt = timestamp();
      recovery.status = "planning";
      run.status = "planning";
      if (operationPending) stored.pending = undefined;
      stored.continuationHead = { revision: nextRevision, headCommit: head };
      this.event(stored, `The project manager is starting bounded recovery attempt ${recovery.attempts} from the clean integration head.`);
      this.prepareMember(stored, "project-manager", undefined, feedback);
    } catch (error) {
      this.block(stored, error);
    }
    return true;
  }
  /** Queue the blocked evidence with the host's resume answer, so it is written even when no client is reading. */
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
  private async stopObsoletePermissionCoordinators(stored: Stored) {
    const run = stored.run;
    for (const member of run.members.filter(item => item.revision === run.revision && item.role === "permission-coordinator" && activeMember(item))) {
      const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
      const target = decision && run.members.find(item => item.memberId === decision.targetMemberId && item.sessionId === decision.targetSessionId);
      const recovery = decision?.recoveryRequestId
        ? run.permissionRecovery?.requests.find(request => request.id === decision.recoveryRequestId)
        : undefined;
      let continuedAfterExpansion = false;
      const awaitingExpandedPrompt = Boolean(recovery?.expansion && ["expanded", "uncertain"].includes(recovery.expansion.status) &&
        recovery.expansion.observedPromptId === undefined && livePermissionRecoveryStatuses.has(recovery.status));
      let obsolete = !decision || decision.status !== "reviewing" || run.permissionsRevokedAt || !run.permissions ||
        ["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status) || !target || !activeMember(target);
      if (!obsolete && decision && target) {
        try {
          const state = await this.manager.state(target.sessionId, true), prompt = state.attention.prompt;
          obsolete = state.status !== "running" || state.attention.state !== "needs-you" || !prompt ||
            prompt.id !== decision.promptId || prompt.hash !== decision.promptHash ||
            permissionEvidenceHash(prompt) !== decision.evidenceHash;
          if (obsolete && state.status === "running" && state.attention.state === "needs-you" &&
              (!state.control || state.control.expiresAt <= Date.now()) && prompt && recovery)
            continuedAfterExpansion = this.advanceExpandedPermissionPrompt(stored, recovery, target, prompt);
        } catch { obsolete = true; }
      }
      if (!obsolete) continue;
      const decisionChanged = decision?.status === "reviewing";
      if (decision && decisionChanged) {
        decision.status = "escalated";
        decision.reason = "The target request or team stage changed while the read-only permission review was running.";
        if (!continuedAfterExpansion && !awaitingExpandedPrompt) this.finishLinkedPermissionRecovery(stored, decision, decision.reason, "target-prompt-changed", "stop-stale-review",
          "No provider answer was sent; the current prompt requires a fresh review or owner attention.");
        else if (recovery) {
          recovery.latestDecisionId = undefined;
          if (!continuedAfterExpansion) recovery.status = "expanding";
        }
      }
      const wasUnavailable = member.status === "unavailable";
      let stopConfirmed = false;
      try { stopConfirmed = Boolean(await this.stopped(member)); }
      catch { /* Keep the member visible as unavailable until its process is confirmed stopped. */ }
      if (!stopConfirmed) {
        member.status = "unavailable";
        if (!wasUnavailable) {
          this.event(stored, "The obsolete permission coordinator could not be confirmed stopped and remains unavailable for inspection.");
        }
        if (decisionChanged || !wasUnavailable) this.save(stored);
        continue;
      }
      this.event(stored, "The obsolete permission coordinator was confirmed stopped; it cannot authorize a later request."); this.save(stored);
    }
  }
  private async membersSettled(stored: Stored) {
    if (stored.pending || this.commands.has(stored.run.id)) return false;
    for (const member of stored.run.members) {
      if (member.status === "stopped") continue;
      if (member.status !== "unavailable" && member.status !== "reported") return false;
      try { if ((await this.manager.state(member.sessionId)).status !== "exited") return false; }
      catch { return false; }
    }
    return true;
  }
  private memberIntegratedAt(stored: Stored, member: TeamMember) {
    if (member.status !== "stopped" || member.report?.kind !== "result") return undefined;
    const retention = this.retentionState(stored), existing = retention.integratedAt[member.memberId];
    if (existing) return existing;
    const integratedTask = member.role === "implementer" && stored.run.tasks.some(task => task.id === member.taskId && task.memberId === member.memberId && task.status === "integrated");
    const integratedEvent = [...stored.run.events].reverse().find(event => event.text === `${member.title} reported a result; its validated changes were integrated.`);
    if (!integratedTask && !(member.role === "integrator" && integratedEvent)) return undefined;
    const at = integratedEvent?.at ?? member.exitConfirmedAt ?? stored.run.updatedAt ?? stored.run.createdAt;
    retention.integratedAt[member.memberId] = at;
    return at;
  }
  private async reportRemovalFailure(stored: Stored, scope: string, error: unknown) {
    const retention = this.retentionState(stored);
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
    const fingerprint = digest({ code, message });
    const seen = (retention.removalErrors[scope] ??= []);
    if (seen.includes(fingerprint)) return;
    const previousEvents = stored.run.events.slice();
    seen.push(fingerprint);
    this.event(stored, `Workspace removal under the retention policy failed (failure ${fingerprint.slice(0, 12)}); the host will retry. See docs/teams.md.`);
    try { this.save(stored); }
    catch (saveError) {
      seen.pop();
      stored.run.events = previousEvents;
      console.warn("Could not record a team workspace retention failure.", saveError);
    }
  }
  private async retire(stored: Stored) {
    try {
      const { run } = stored, retention = this.retentionState(stored), policy = this.config.teams?.retention ?? DEFAULT_TEAM_RETENTION;
      const ownedActive = Boolean(run.goal || run.missionId || run.handoff) && (this.options?.ownerActive?.(run) ?? true);
      if (ownedActive && ["merged", "no-change", "ready-for-review"].includes(run.status)) return;
      const runDirectory = teamRunDirectory(run.workspace);
      const now = this.options?.now?.() ?? Date.now();
      const elapsed = Math.max(0, now - Date.parse(retention.statusAt));
      const retentionMs = run.status === "merged" || run.status === "no-change" ? policy.finishedMinutes * 60000
        : run.status === "cancelled" ? policy.cancelledMinutes * 60000
          : run.status === "ready-for-review" ? policy.reviewHours * 3600000
            : run.status === "blocked" ? policy.blockedHours * 3600000 : undefined;

      if (!run.workspaceRemovedAt && !["cancelled", "merged", "no-change", "ready-for-review", "blocked"].includes(run.status)) {
        const memberRetentionMs = policy.memberMinutes * 60000;
        for (const [index, member] of run.members.entries()) {
          const newerMemberSharesWorkspace = run.members.slice(index + 1).some(candidate => candidate.cwd === member.cwd);
          if (member.workspaceRemovedAt || stored.pending?.source?.cwd === member.cwd || newerMemberSharesWorkspace) continue;
          const integratedAt = this.memberIntegratedAt(stored, member);
          if (!integratedAt || now - Date.parse(integratedAt) < memberRetentionMs) continue;
          try {
            await removeMemberWorkspace(runDirectory, member.memberId, this.config.teams?.commandPrefix, undefined, this.teamRoot(stored));
          } catch (error) {
            await this.reportRemovalFailure(stored, `member:${member.memberId}`, error);
            continue;
          }
          member.workspaceRemovedAt = this.retentionNow();
          this.event(stored, `Member workspace removed under the retention policy after its integrated result was consumed. See docs/teams.md.`);
          try { this.save(stored); } catch (error) { console.warn("Could not persist a removed member workspace marker.", error); }
        }
      }

      if (run.workspaceRemovedAt) {
        if (run.status === "cancelled" && !run.goal && !run.missionId && retentionMs !== undefined && elapsed >= retentionMs && await this.membersSettled(stored)) {
          try { await this.deleteRecord(stored); }
          catch (error) { await this.reportRemovalFailure(stored, "record", error); }
        }
        return;
      }
      if (retentionMs === undefined || elapsed < retentionMs || !(await this.membersSettled(stored))) return;

      try { await removeTeamWorkspace(runDirectory, this.config.teams?.commandPrefix, undefined, this.teamRoot(stored)); }
      catch (error) { await this.reportRemovalFailure(stored, "workspaces", error); return; }
      run.workspaceRemovedAt = this.retentionNow();
      for (const member of run.members) member.workspaceRemovedAt ??= run.workspaceRemovedAt;
      this.event(stored, `Workspaces removed under the retention policy after this ${run.status} run settled. See docs/teams.md.`);
      try { this.save(stored); }
      catch (error) { console.warn("Could not persist a removed team workspace marker.", error); }
      if (run.status === "cancelled" && !run.goal && !run.missionId) {
        try { await this.deleteRecord(stored); }
        catch (error) { await this.reportRemovalFailure(stored, "record", error); }
      }
    } catch (error) {
      console.warn("Team workspace retention could not be evaluated; the run was left unchanged.", error);
    }
  }
  private async step(stored: Stored) {
    const run = stored.run;
    await this.retire(stored);
    if (!this.records.has(run.id)) return;
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
          member.lastActivityAt = state.attention.lastActivityAt;
          member.pendingLimit = Boolean(state.attention.limit);
        }
        this.save(stored);
      }
      if (!stored.halt && !["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) this.assertBudget(run);
      if (stored.halt) {
        let all = true;
        const drainRevision = stored.halt === "block" && run.recovery?.status === "stopping" ? run.recovery.source.revision
          : stored.halt === "steer" && run.recovery ? run.revision - 1 : undefined;
        const membersToStop = run.members.filter(member => (activeMember(member) || drainRevision !== undefined && member.revision === drainRevision) &&
          !(drainRevision !== undefined && member.revision === drainRevision && terminalPermissionCoordinator(run, member)));
        for (const member of membersToStop) {
          try {
            if (drainRevision === undefined || member.revision !== drainRevision) {
              // Keep ordinary stop behavior for pause/cancel/block and any active member outside the recovery revision.
              if (member.status === "queued" && !this.hasLaunch(member)) member.status = "stopped";
              else if (!await this.stopped(member)) all = false;
              continue;
            }
            // A launch may already have spawned before the API stopped; never-launched members have no journal to drain.
            if (!member.startedAt && !member.report && !this.hasLaunch(member)) { member.status = "stopped"; continue; }
            let stopped = member.status === "stopped" ? await this.manager.state(member.sessionId) : undefined;
            if (stopped?.status !== "exited") stopped = await this.stopped(member);
            if (!stopped) { all = false; continue; }
            const { page } = this.readMemberJournal(run, member, false, true);
            member.status = "stopped";
            if (page.more || member.cursor < stopped.seq) all = false;
          } catch { all = false; member.status = "unavailable"; }
        }
        const safePendingRecovery = Boolean(run.recovery?.status === "stopping" && stored.pending &&
          (recoverableOperationFailure(stored, stored.pending) || recoverableUnattributedResult(stored, stored.pending)));
        if (all && (!stored.pending || safePendingRecovery || run.status === "blocked" || run.status === "cancelled")) { stored.halt = undefined; if (!["blocked", "cancelled"].includes(run.status)) run.reason = undefined; }
        this.save(stored); return;
      }
      if (await this.startAutomaticRecovery(stored, trackingReady)) return;
      if (!stored.prepared) return;
      if (["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) {
        await this.stopObsoletePermissionCoordinators(stored); return;
      }
      // Reconcile one-shot reviews before consuming reports from their reviewer. The owner may
      // have answered the target prompt since the previous pass, making that report obsolete.
      await this.stopObsoletePermissionCoordinators(stored);
      if ([providerInputReason, permissionReviewReason, runtimeUnavailableReason].includes(run.reason ?? "")) {
        const observedMembers = run.members.filter(member => member.revision === run.revision && activeMember(member) && member.status !== "queued" && !member.report);
        const states = await Promise.all(observedMembers.map(member => this.manager.state(member.sessionId)));
        if (this.closed) return;
        const held = states.flatMap((state, index) => state.status !== "exited" && state.attention.state === "needs-you"
          ? [underReview(run, observedMembers[index].sessionId, state.attention.prompt?.id)] : []);
        const reason = states.some(state => ["unavailable", "recording-error"].includes(state.status)) ? runtimeUnavailableReason
          : held.includes(false) ? providerInputReason : held.length ? permissionReviewReason : undefined;
        if (run.reason !== reason) { run.reason = reason; this.save(stored); }
      }
      if (stored.pending) return;
      this.assertRunPath(stored, run.workspace);
      for (const member of run.members.filter(item => item.revision === run.revision && activeMember(item))) {
        if (member.status === "queued") { await this.launch(stored, member); continue; }
        if (!member.report) {
          if (member.role === "permission-coordinator" && member.startedAt && Date.now() - Date.parse(member.startedAt) > 5 * 60 * 1000) {
            const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
            const decisionChanged = decision?.status === "reviewing", before = member.status;
            if (decision && decisionChanged) {
              decision.status = "escalated"; decision.reason = "The five-minute review window expired without a decision.";
              const recovery = decision.recoveryRequestId ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId) : undefined;
              if (decision.purpose === "diagnose" && recovery) {
                if (this.queuePermissionRecoveryPm(stored, recovery, decision.reason, decision.id)) return;
              } else this.finishLinkedPermissionRecovery(stored, decision, decision.reason, "coordinator-timeout", "review-expired",
                "No provider answer was sent; the request remains with the owner.");
            }
            try { if (!await this.stopped(member)) member.status = "unavailable"; }
            catch { member.status = "unavailable"; }
            // A coordinator that will not exit is retried each pass; report the expiry once.
            if (decisionChanged || before !== "unavailable") this.event(stored, "The permission coordinator exceeded its review window; the request remains with the user.");
            if (decisionChanged || member.status !== before) this.save(stored);
            continue;
          }
          const { page, limit } = this.readMemberJournal(run, member);
          if (!member.report && limit) {
            await this.switchLimitedMember(stored, member, limit);
            if (stored.pending || run.status === "blocked") return;
            continue;
          }
          if (!member.report) {
            const state = await this.manager.state(member.sessionId);
            member.lastActivityAt = state.attention.lastActivityAt;
            member.pendingLimit = Boolean(state.attention.limit);
            const journalDrained = !page.more && member.cursor >= state.seq;
            if (state.status === "exited" && (page.more || member.cursor < state.seq)) { this.save(stored); continue; }
            if (state.status === "exited") {
              if (member.stalledAt && journalDrained) {
                await this.replaceStalledMember(stored, member);
                if (stored.pending || run.status === "blocked") return;
                continue;
              }
              member.status = "stopped";
              if (member.role === "permission-coordinator") {
                const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
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
              this.block(stored, new TeamError(409, "missing-agent-report", "An agent exited without a valid structured report. Its task is unresolved."), member); return;
            }
            // A member back from an outage may come back straight into a prompt; it is running again.
            if (state.status === "running" && member.status === "unavailable" && member.role !== "permission-coordinator") member.status = "running";
            if (state.attention.state === "needs-you" && await this.maybeStartPermissionReview(stored, member)) return;
            if (["unavailable", "recording-error"].includes(state.status)) { member.status = "unavailable"; run.reason = runtimeUnavailableReason; }
            // A prompt that waits on a person outranks one the coordinator is still reviewing.
            else if (state.attention.state === "needs-you")
              run.reason = underReview(run, member.sessionId, state.attention.prompt?.id) && run.reason !== providerInputReason ? permissionReviewReason : providerInputReason;
            // A coordinator back from an outage runs again only while its review is current; an obsolete or
            // expired one (its decision already moved on) stays unavailable until its exit is confirmed.
            else if (member.status !== "unavailable" || member.role !== "permission-coordinator" ||
              run.permissionDecisions?.some(item => item.coordinatorMemberId === member.memberId && item.status === "reviewing")) member.status = "running";
            this.save(stored);
            if (state.status === "running" && journalDrained && member.role !== "permission-coordinator" &&
                (member.stalledAt || state.attention.state !== "needs-you" && !member.pendingLimit && quietFor(member) > this.stallWindow())) {
              await this.replaceStalledMember(stored, member);
              if (stored.pending || run.status === "blocked") return;
            }
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
      // A recorded answer creates one replacement only after the original has confirmed exit.
      for (const decision of run.decisions.filter(item => item.revision === run.revision && item.answer)) {
        const prior = run.members.find(member => member.memberId === decision.memberId)!;
        if (prior.status !== "waiting") continue;
        // An answered scout or implementer keeps waiting, answer intact, until a worker slot frees under the current limit.
        if ((prior.role === "scout" || prior.role === "implementer") && run.members.filter(member => holdsWorkerSlot(member, run.revision)).length >= run.parallelism) continue;
        const answeredBy = decision.answeredBy === "coordinator" ? "Mission coordinator" : "User";
        const next = this.newMember(run, prior.role, prior.cwd, prior.baseCommit, prior.taskId, `${prior.prompt}\n\n${answeredBy} answered: ${decision.answer}`, prior.modelProfile);
        next.contextFeedback = [prior.contextFeedback ?? prior.prompt, `${answeredBy} answered: ${decision.answer}`].filter(Boolean).join("\n\n");
        // A limit substitution may have pinned a fallback profile on another provider.
        next.provider = next.modelProfile?.provider ?? prior.provider ?? run.provider;
        prior.status = "stopped"; run.members.push(next);
        if (prior.role === "delivery" && stored.deliveryAttempt?.memberId === prior.memberId)
          stored.deliveryAttempt.memberId = next.memberId;
        const task = prior.role === "scout" ? run.discovery?.tasks.find(item => item.id === prior.taskId) : run.tasks.find(item => item.id === prior.taskId);
        if (task) { task.memberId = next.memberId; task.status = "running"; }
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
      if (run.establishChecks && !run.verification?.checks.length)
        throw new TeamError(409, "verification-required", "Required verification commands have not been established; review cannot start.");
      if (stored.checkHead !== run.headCommit) { this.check(stored); return; }
      if (!run.review || run.review.revision !== run.revision) {
        this.prepareMember(stored, "reviewer"); return;
      }
      if (run.review.verdict === "approved") {
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.config.teams?.commandPrefix, undefined, "integration");
        this.assertBudget(run);
        if (run.delivery) {
          this.assertDelivery(stored);
          if (stored.deliveryAttempt) throw new TeamError(409, "delivery-reconciliation-required", "Delivery started without a confirmed report. Inspect the recorded branch and pull request before retrying.");
          this.prepareMember(stored, "delivery");
        } else {
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          this.event(stored, "The reviewer approved the integrated change and configured checks passed. Ready for human review; nothing was published."); this.save(stored);
        }
      }
    } catch (error) { this.block(stored, error); }
  }
  private finishLinkedPermissionRecovery(stored: Stored, decision: TeamPermissionDecision, cause: string, action: string, outcome: string, consequence: string) {
    const request = decision.recoveryRequestId
      ? stored.run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId)
      : undefined;
    if (!request || !livePermissionRecoveryStatuses.has(request.status)) return;
    this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action, decision: outcome, consequence });
    this.finishPermissionRecovery(stored, request, "interrupted", cause, action, outcome, consequence, decision.id);
  }
  private advanceExpandedPermissionPrompt(stored: Stored, request: TeamPermissionRecoveryRequest, target: TeamMember, prompt: Prompt) {
    const expansion = request.expansion;
    if (!expansion || !["expanded", "uncertain"].includes(expansion.status) || !expansion.receipt || expansion.observedPromptId !== undefined ||
        !livePermissionRecoveryStatuses.has(request.status) || request.targetMemberId !== target.memberId || request.targetSessionId !== target.sessionId ||
        request.revision !== stored.run.revision || prompt.source !== "screen" || prompt.pinned !== true || !coordinatorPermissionPrompt(prompt) || !prompt.hash ||
        prompt.id === request.promptId && prompt.hash === request.promptHash && permissionEvidenceHash(prompt) === request.evidenceHash)
      return false;
    expansion.observedPromptId = prompt.id;
    expansion.observedPromptHash = prompt.hash;
    request.promptId = prompt.id;
    request.promptHash = prompt.hash;
    request.evidenceHash = permissionEvidenceHash(prompt);
    request.latestDecisionId = undefined;
    request.status = "diagnosing";
    this.recordPermissionRecoveryStep(stored, request, { cause: "A fresh pinned permission screen appeared after the guarded display expansion.",
      action: "bind-expanded-prompt", decision: "review-new-screen-identity",
      consequence: "The coordinator will inspect the newly observed prompt; the display receipt does not authorize an answer." });
    this.save(stored);
    return true;
  }
  private sameCollapsedExpansionPrompt(request: TeamPermissionRecoveryRequest, prompt: Prompt) {
    return Boolean(request.expansion && isCollapsedPermissionPrompt(prompt) && prompt.id === request.expansion.promptId &&
      prompt.hash === request.expansion.promptHash && permissionEvidenceHash(prompt) === request.evidenceHash);
  }
  private deferExpandedPermissionRead(stored: Stored, request: TeamPermissionRecoveryRequest, reason: string) {
    const expansion = request.expansion!;
    expansion.rereads = (expansion.rereads ?? 0) + 1;
    if (expansion.rereads < 3) {
      this.recordPermissionRecoveryStep(stored, request, { cause: reason, action: "re-read-after-expansion", decision: "wait-for-screen-settle",
        consequence: `The display state will be checked again without sending another key (${expansion.rereads}/3).` });
      this.save(stored);
      return true;
    }
    const cause = "The provider display did not settle into a reviewable permission screen after the bounded rereads. " + boundedRecoveryText(reason);
    this.queuePermissionRecoveryPm(stored, request, cause);
    this.save(stored);
    return true;
  }
  private stableDiagnosticPrompt(target: TeamMember, prompt: Prompt) {
    const now = Date.now(), key = `${permissionPromptKey(target.sessionId, prompt.id, prompt.hash!)}:${permissionEvidenceHash(prompt)}`;
    for (const [seenKey, at] of this.permissionPromptFirstSeen) if (now - at > 10_000) this.permissionPromptFirstSeen.delete(seenKey);
    if (this.permissionPromptFirstSeen.size >= 256 && !this.permissionPromptFirstSeen.has(key)) {
      const oldest = this.permissionPromptFirstSeen.keys().next().value;
      if (oldest) this.permissionPromptFirstSeen.delete(oldest);
    }
    const first = this.permissionPromptFirstSeen.get(key);
    if (first === undefined) {
      this.permissionPromptFirstSeen.set(key, now);
      return false;
    }
    return now - first >= 300;
  }
  private escalatePermissionDecision(stored: Stored, decision: TeamPermissionDecision, reason: string, event: string) {
    decision.status = "escalated";
    decision.reason = reason;
    this.finishLinkedPermissionRecovery(stored, decision, reason, "coordinator-review", "review-escalated",
      "No provider answer was sent; the request remains available for owner review.");
    this.event(stored, event);
    this.save(stored);
  }
  private recordPermissionRecoveryStep(stored: Stored, request: TeamPermissionRecoveryRequest, step: Omit<TeamPermissionRecoveryStep, "id" | "requestId" | "at" | "execution"> & { at?: string }) {
    const state = stored.run.permissionRecovery ??= { requests: [], steps: [], outcomes: [] };
    state.steps.push({ id: randomUUID(), requestId: request.id, ...(step.decisionId ? { decisionId: step.decisionId } : {}),
      at: step.at ?? timestamp(), cause: boundedRecoveryText(step.cause), action: boundedRecoveryText(step.action),
      decision: boundedRecoveryText(step.decision), consequence: boundedRecoveryText(step.consequence), execution: "unknown",
      ...(step.receipt ? { receipt: structuredClone(step.receipt) } : {}) });
    if (state.steps.length > permissionRecoveryStepLimit) state.steps.splice(0, state.steps.length - permissionRecoveryStepLimit);
  }
  private finishPermissionRecovery(stored: Stored, request: TeamPermissionRecoveryRequest, status: TeamPermissionRecoveryOutcome["status"], cause: string, action: string,
    decision: string, consequence: string, decisionId?: string) {
    const state = stored.run.permissionRecovery ??= { requests: [], steps: [], outcomes: [] };
    request.status = status;
    const prior = state.outcomes.find(outcome => outcome.requestId === request.id);
    if (prior) return prior;
    const outcome: TeamPermissionRecoveryOutcome = { id: randomUUID(), requestId: request.id, ...(decisionId ? { decisionId } : {}),
      revision: request.revision, promptId: request.promptId, status, cause: boundedRecoveryText(cause), action: boundedRecoveryText(action),
      decision: boundedRecoveryText(decision), consequence: boundedRecoveryText(consequence), execution: "unknown", at: timestamp() };
    state.outcomes.push(outcome);
    if (state.outcomes.length > permissionRecoveryOutcomeLimit) state.outcomes.splice(0, state.outcomes.length - permissionRecoveryOutcomeLimit);
    return outcome;
  }
  private permissionRecoveryPromptInvalidReason(stored: Stored, request: TeamPermissionRecoveryRequest, target: TeamMember) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status))
      return "The run is paused, stopped, blocked, or its permission policy was revoked.";
    if (request.revision !== run.revision || request.targetMemberId !== target.memberId || request.targetSessionId !== target.sessionId ||
        target.revision !== run.revision || target.role === "permission-coordinator" || !activeMember(target))
      return "The target member assignment is no longer current.";
    if (request.policyHash !== digest(run.permissions) || Date.now() >= Date.parse(request.expiresAt))
      return "The pinned permission policy changed or the five-minute recovery window expired.";
    try {
      const canonicalCwd = realpathSync(target.cwd);
      if (canonicalCwd !== request.targetCwd) return "The target working directory changed.";
      this.assertRunPath(stored, canonicalCwd);
      const metadata = this.manager.meta(target.sessionId).session;
      const assigned = metadata.team;
      if (!assigned || assigned.runId !== run.id || assigned.memberId !== target.memberId || assigned.revision !== target.revision ||
          assigned.role !== target.role || metadata.cwd !== canonicalCwd) return "The target session no longer matches its recorded assignment and working directory.";
    } catch (error) { return error instanceof TeamError ? error.message : "The target workspace or session could not be verified."; }
    return undefined;
  }
  private async inspectPermissionRecoveryPrompt(stored: Stored, request: TeamPermissionRecoveryRequest, target: TeamMember, allowPromptRefresh = false):
    Promise<{ state: Awaited<ReturnType<Manager["state"]>>; prompt: Prompt } | { reason: string }> {
    const invalid = this.permissionRecoveryPromptInvalidReason(stored, request, target);
    if (invalid) return { reason: invalid } as const;
    try {
      const state = await this.manager.state(target.sessionId, true);
      if (state.status !== "running" || state.attention.state !== "needs-you" || state.control && state.control.expiresAt > Date.now())
        return { reason: "The target is unavailable, no longer waiting on this request, or a human control lease is active." } as const;
      const prompt = state.attention.prompt;
      if (!prompt || !allowPromptRefresh && prompt.id !== request.promptId || !prompt.hash ||
          !allowPromptRefresh && (prompt.hash !== request.promptHash || permissionEvidenceHash(prompt) !== request.evidenceHash))
        return { reason: "The current permission prompt changed during recovery." } as const;
      return { state, prompt } as const;
    } catch { return { reason: "The current target session could not be verified." } as const; }
  }
  private normalizeRequestedPermissionPaths(paths: string[], targetCwd: string, scratchDirectory?: string) {
    if (!paths.length || paths.length > 8) return undefined;
    const root = realpathSync(targetCwd), scratch = scratchDirectory ? realpathSync(scratchDirectory) : undefined;
    const inside = (base: string, candidate: string) => candidate === base || candidate.startsWith(`${base}${sep}`);
    const normalized: string[] = [];
    for (const item of paths) {
      if (!item.trim() || item.includes("\0")) return undefined;
      let candidate = item;
      const scratchMatch = /^@scratch\/0\/(.+)$/.exec(item);
      if (scratchMatch) {
        if (!scratch) return undefined;
        candidate = join(scratch, scratchMatch[1]!);
      }
      if (isAbsolute(candidate)) {
        const absolute = resolve(candidate);
        if (inside(root, absolute)) candidate = relative(root, absolute);
        else if (!scratch || !inside(scratch, absolute)) return undefined;
        else candidate = absolute;
      } else {
        if (candidate.split(/[\\/]/).some(part => part === ".." || part === "")) return undefined;
        const absolute = resolve(root, candidate);
        if (!inside(root, absolute) || absolute === root) return undefined;
        candidate = relative(root, absolute);
      }
      if (!candidate || candidate === ".") return undefined;
      if (!normalized.includes(candidate)) normalized.push(candidate);
    }
    return normalized.length ? normalized : undefined;
  }
  private queuePermissionRecoveryPm(stored: Stored, request: TeamPermissionRecoveryRequest, cause: string, decisionId?: string) {
    const { run } = stored;
    const canRecover = run.permissions && !run.permissionsRevokedAt && !stored.halt && !run.stopReason && !stored.deliveryAttempt && !run.deliveryReceipt && !run.pullRequest &&
      !(run.permissions && (run.permissionDecisions ?? []).some(item => item.status === "uncertain" || item.status === "answering")) &&
      (!run.linearTracking || run.linear?.status === "synced") && !["paused", "cancelled", "blocked"].includes(run.status);
    const attempts = run.recovery?.attempts ?? 0;
    const sourceDecision = decisionId ? run.permissionDecisions?.find(item => item.id === decisionId) : undefined;
    const source = { code: "permission-recovery", memberId: sourceDecision?.coordinatorMemberId ?? request.targetMemberId, revision: request.revision,
      ...(decisionId ? { reportKind: "permission-decision" as const } : {}), reason: boundedRecoveryText(cause), at: timestamp() };
    const queuePm = canRecover && attempts < automaticRecoveryLimit;
    this.recordPermissionRecoveryStep(stored, request, { ...(decisionId ? { decisionId } : {}), cause,
      action: "project-manager-correction", decision: queuePm ? "queue-bounded-pm-recovery" : "leave-for-owner",
      consequence: queuePm ? "The host will stop and confirm existing members before starting a fresh project-manager revision." : "No member is restarted and the retained evidence remains available for owner review." });
    this.finishPermissionRecovery(stored, request, canRecover ? "exhausted" : "interrupted", cause,
      "project-manager-correction", queuePm ? "bounded-pm-recovery-queued" : "owner-attention-required",
      queuePm ? "A PM correction will inspect the retained prompt and workspace; no permission answer was sent." : "The team remains fenced for owner review; no permission answer was sent.", decisionId);
    if (!canRecover) {
      this.event(stored, "Permission diagnosis could not enter automatic PM recovery because the run is stopped, held, revoked, uncertain, or unsynchronized.");
      this.save(stored);
      return false;
    }
    if (attempts >= automaticRecoveryLimit) {
      run.recovery = { attempts, status: "exhausted", source };
      run.status = "blocked"; stored.halt = "block"; run.blockCode = "permission-recovery-exhausted";
      run.reason = "Permission recovery reached its bounded PM correction limit. Review the current prompt and retained evidence before acting.";
      this.event(stored, run.reason); this.save(stored); this.trackBlocked(stored);
      return false;
    }
    run.recovery = { attempts: attempts + 1, status: "stopping", source };
    this.commands.get(run.id)?.abort();
    void this.invalidatePermissionDecisions(stored, "The team is stopping members before bounded permission-recovery diagnosis.");
    run.status = "planning"; stored.halt = "block"; run.blockCode = "permission-recovery"; run.reason = boundedRecoveryText(cause);
    this.event(stored, "The project manager will inspect the retained permission blocker after active members are confirmed stopped.");
    this.save(stored);
    return true;
  }
  private newPermissionRecoveryRequest(stored: Stored, target: TeamMember, prompt: Prompt): TeamPermissionRecoveryRequest {
    const run = stored.run;
    const request: TeamPermissionRecoveryRequest = { id: randomUUID(), revision: run.revision, targetMemberId: target.memberId,
      targetSessionId: target.sessionId, promptId: prompt.id, promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt),
      targetCwd: realpathSync(target.cwd), policyHash: digest(run.permissions!), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      status: "diagnosing", rounds: 0 };
    (run.permissionRecovery ??= { requests: [], steps: [], outcomes: [] }).requests.push(request);
    if (run.permissionRecovery.requests.length > permissionRecoveryOutcomeLimit) run.permissionRecovery.requests.splice(0, run.permissionRecovery.requests.length - permissionRecoveryOutcomeLimit);
    return request;
  }
  private async maybeStartPermissionReview(stored: Stored, target: TeamMember) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || target.status !== "running" || stored.halt ||
        ["paused", "cancelled", "blocked"].includes(run.status) || target.revision !== run.revision) return false;
    if (run.members.some(member => {
      if (member.memberId === target.memberId || member.revision !== run.revision || member.role !== "permission-coordinator" || !activeMember(member)) return false;
      const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId && item.revision === member.revision);
      return !decision || !["answered", "escalated", "stale"].includes(decision.status);
    })) return false;
    let state;
    try { state = await this.manager.state(target.sessionId, true); } catch { return false; }
    const prompt = state.attention.prompt;
    if (state.status !== "running" || state.attention.state !== "needs-you" || !prompt) return false;
    const currentRecovery = (run.permissionRecovery?.requests ?? []).filter(item => item.revision === run.revision &&
      item.targetMemberId === target.memberId && item.targetSessionId === target.sessionId &&
      (item.promptId === prompt.id || item.expansion?.observedPromptId === prompt.id ||
        item.status === "expanding" && item.expansion?.observedPromptId === undefined)).at(-1);
    if (currentRecovery && (sameRecoveryRequest(currentRecovery, target, prompt, run.revision) ||
        currentRecovery.status === "expanding" && currentRecovery.expansion !== undefined)) {
      if (["complete", "exhausted", "interrupted"].includes(currentRecovery.status)) return false;
      if (currentRecovery.status === "expanding" && currentRecovery.expansion && ["expanded", "uncertain"].includes(currentRecovery.expansion.status)) {
        const fresh = await this.inspectPermissionRecoveryPrompt(stored, currentRecovery, target, true);
        if (!("state" in fresh)) {
          const reason = fresh.reason ?? "The current target state could not be confirmed after expansion.";
          return this.deferExpandedPermissionRead(stored, currentRecovery, reason);
        }
        if (!coordinatorPermissionPrompt(fresh.prompt))
          return this.deferExpandedPermissionRead(stored, currentRecovery, "The latest display refresh is not yet a complete reviewable permission screen.");
        if (this.sameCollapsedExpansionPrompt(currentRecovery, fresh.prompt))
          return this.deferExpandedPermissionRead(stored, currentRecovery, "The display refresh still shows the original collapsed permission menu.");
        if (fresh.prompt.id !== currentRecovery.promptId || fresh.prompt.hash !== currentRecovery.promptHash ||
            permissionEvidenceHash(fresh.prompt) !== currentRecovery.evidenceHash)
          this.advanceExpandedPermissionPrompt(stored, currentRecovery, target, fresh.prompt);
        if (fresh.prompt.id !== currentRecovery.promptId || fresh.prompt.hash !== currentRecovery.promptHash ||
            permissionEvidenceHash(fresh.prompt) !== currentRecovery.evidenceHash) {
          const cause = "The prompt identity changed after display expansion without a fresh supported screen.";
          this.finishPermissionRecovery(stored, currentRecovery, "interrupted", cause, "re-read-after-expansion", "stop-review", "No permission answer was sent.");
          this.save(stored);
          return true;
        }
        currentRecovery.status = "diagnosing";
        return this.startPermissionCoordinatorReview(stored, target, fresh.prompt, currentRecovery);
      }
      if (currentRecovery.status === "diagnosing" && !currentRecovery.latestDecisionId)
        return this.startPermissionCoordinatorReview(stored, target, prompt, currentRecovery);
      return false;
    }
    if (!coordinatorPermissionPrompt(prompt)) return false;
    const collapsed = isCollapsedPermissionPrompt(prompt);
    if (oneShotPermissionOption(prompt) === undefined && !collapsed && !this.stableDiagnosticPrompt(target, prompt)) return false;
    if (!run.lineup || run.lineup.coordinator.tier !== "strong" || permissionRequestCount(run) >= run.permissions.maxDecisions) return false;
    if (target.role === "permission-coordinator") return this.startPermissionCoordinatorReview(stored, target, prompt);
    if (collapsed) {
      try { this.assertRunPath(stored, realpathSync(target.cwd)); }
      catch { return this.startPermissionCoordinatorReview(stored, target, prompt); }
      const request = this.newPermissionRecoveryRequest(stored, target, prompt);
      request.status = "expanding";
      request.expansion = { requestId: request.id, promptId: request.promptId, promptHash: prompt.hash!, status: "intent", at: timestamp() };
      this.recordPermissionRecoveryStep(stored, request, { cause: "The provider showed a supported collapsed command dialog.", action: "expand-display",
        decision: "request-one-display-expansion", consequence: "Only Ctrl+A will be sent; no provider permission answer will be sent." });
      this.save(stored);
      let receipt;
      try {
        receipt = await this.manager.expandTeamPermission(target.sessionId, request.expansion.requestId, assignment(target), {
          promptId: request.promptId, promptHash: request.promptHash, evidenceHash: request.evidenceHash, targetCwd: request.targetCwd, expiresAt: request.expiresAt,
        });
      } catch (error) {
        const refused = refusedBeforeSend(error);
        request.expansion.status = refused ? "refused" : "uncertain";
        request.status = "interrupted";
        const cause = refused ? (error instanceof Error ? error.message : "The display-expansion request was refused before input was sent.")
          : "The host could not confirm whether the display-expansion keystroke was sent; it will not be repeated.";
        this.recordPermissionRecoveryStep(stored, request, { cause, action: "expand-display", decision: refused ? "do-not-retry-refusal" : "do-not-replay-uncertain-intent",
          consequence: "The provider prompt remains unanswered and the owner retains control." });
        this.finishPermissionRecovery(stored, request, "interrupted", cause, "expand-display", "no-repeat", "The display state is uncertain; no permission answer was sent.");
        this.event(stored, "The permission dialog was not expanded automatically; the prompt remains unanswered for owner review.");
        this.save(stored);
        return true;
      }
      request.expansion.receipt = receipt;
      request.expansion.status = receipt.state === "delivered" ? "expanded" : "uncertain";
      this.recordPermissionRecoveryStep(stored, request, { cause: "A guarded display-expansion request was sent.", action: "expand-display",
        decision: receipt.state === "delivered" ? "display-expansion-delivered" : "display-expansion-uncertain",
        consequence: "The receipt records input delivery only; provider command execution remains unknown.", receipt });
      this.save(stored);
      const fresh = await this.inspectPermissionRecoveryPrompt(stored, request, target, true);
      if (!("state" in fresh)) {
        const reason = fresh.reason ?? "The current target state could not be confirmed after expansion.";
        return this.deferExpandedPermissionRead(stored, request, reason);
      }
      if (!coordinatorPermissionPrompt(fresh.prompt)) {
        const cause = "The fresh target screen no longer contains a supported permission prompt.";
        this.finishPermissionRecovery(stored, request, "interrupted", cause, "re-read-after-expansion", "stop-review", "The prompt remains unanswered and requires owner attention.");
        this.recordPermissionRecoveryStep(stored, request, { cause, action: "re-read-after-expansion", decision: "stop-review", consequence: "No answer was sent." });
        this.save(stored);
        return true;
      }
      if (this.sameCollapsedExpansionPrompt(request, fresh.prompt))
        return this.deferExpandedPermissionRead(stored, request, "The display refresh still shows the original collapsed permission menu.");
      if (fresh.prompt.id !== request.promptId || fresh.prompt.hash !== request.promptHash ||
          permissionEvidenceHash(fresh.prompt) !== request.evidenceHash)
        this.advanceExpandedPermissionPrompt(stored, request, target, fresh.prompt);
      if (fresh.prompt.id !== request.promptId || fresh.prompt.hash !== request.promptHash ||
          permissionEvidenceHash(fresh.prompt) !== request.evidenceHash) {
        const cause = "The prompt identity changed after display expansion without a fresh supported screen.";
        this.finishPermissionRecovery(stored, request, "interrupted", cause, "re-read-after-expansion", "stop-review", "No permission answer was sent.");
        this.recordPermissionRecoveryStep(stored, request, { cause, action: "re-read-after-expansion", decision: "stop-review", consequence: "The request remains with the owner." });
        this.save(stored);
        return true;
      }
      request.status = "diagnosing";
      return this.startPermissionCoordinatorReview(stored, target, fresh.prompt, request);
    }
    if (oneShotPermissionOption(prompt) === undefined && !screenPermissionPrompt(prompt)) return false;
    let request: TeamPermissionRecoveryRequest | undefined;
    if (oneShotPermissionOption(prompt) === undefined) {
      try { this.assertRunPath(stored, realpathSync(target.cwd)); }
      catch { return this.startPermissionCoordinatorReview(stored, target, prompt); }
      request = this.newPermissionRecoveryRequest(stored, target, prompt);
    }
    return this.startPermissionCoordinatorReview(stored, target, prompt, request);
  }
  private async startPermissionCoordinatorReview(stored: Stored, target: TeamMember, prompt: Prompt, recovery?: TeamPermissionRecoveryRequest,
    evidenceOverride?: { changedPaths: string[]; evidence: ReturnType<typeof collectPermissionEvidence> }) {
    const run = stored.run;
    const stopRecovery = (cause: string, status: TeamPermissionRecoveryOutcome["status"] = "interrupted") => {
      if (!recovery) return false;
      this.recordPermissionRecoveryStep(stored, recovery, { ...(recovery.latestDecisionId ? { decisionId: recovery.latestDecisionId } : {}), cause,
        action: "fresh-review", decision: "stop-review", consequence: "No provider answer was sent; the request remains available for owner review." });
      this.finishPermissionRecovery(stored, recovery, status, cause, "fresh-review", "stop-review", "No provider answer was sent.", recovery.latestDecisionId);
      this.save(stored);
      return false;
    };
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status) ||
        target.status !== "running" || target.revision !== run.revision || !run.lineup || run.lineup.coordinator.tier !== "strong")
      return stopRecovery("The current run authority no longer permits a fresh permission review.");
    if (recovery && (recovery.policyHash !== digest(run.permissions) || !Number.isFinite(Date.parse(recovery.expiresAt)) || Date.now() >= Date.parse(recovery.expiresAt)))
      return stopRecovery("The original permission policy or recovery deadline is no longer current.");
    const collapsed = isCollapsedPermissionPrompt(prompt);
    const option = collapsed ? undefined : oneShotPermissionOption(prompt);
    if (option === undefined && !screenPermissionPrompt(prompt) && !collapsed) return stopRecovery("The refreshed prompt is not eligible for report-only review.");
    if (recovery && (["complete", "exhausted", "interrupted"].includes(recovery.status) || recovery.rounds > permissionRecoveryRoundLimit)) return false;
    if (permissionRequestCount(run) >= run.permissions.maxDecisions && !recovery) return false;
    const promptHash = prompt.hash;
    if (!promptHash || prompt.id !== (recovery?.promptId ?? prompt.id)) return stopRecovery("The refreshed prompt identity is incomplete or changed.");
    const evidenceHash = permissionEvidenceHash(prompt);
    if (!evidenceOverride && (run.permissionDecisions ?? []).some(prior => prior.targetMemberId === target.memberId &&
        prior.targetSessionId === target.sessionId && prior.promptId === prompt.id && prior.promptHash === promptHash && prior.evidenceHash === evidenceHash)) {
      const cause = "This exact target prompt already has a coordinator decision; it will not be assigned twice.";
      if (recovery) {
        this.recordPermissionRecoveryStep(stored, recovery, { cause, action: "fresh-review", decision: "refuse-duplicate-prompt",
          consequence: "No additional coordinator was launched and no provider answer was sent." });
        this.finishPermissionRecovery(stored, recovery, "interrupted", cause, "fresh-review", "refuse-duplicate-prompt",
          "No provider answer was sent; the prior decision remains immutable.", recovery.latestDecisionId);
        this.save(stored);
      }
      return false;
    }
    const createDecision = (targetCwd: string, expiresAt: string): TeamPermissionDecision => ({ id: randomUUID(), revision: run.revision,
      policyHash: digest(run.permissions!), targetMemberId: target.memberId, targetSessionId: target.sessionId, targetCwd,
      promptId: prompt.id, promptHash, evidenceHash, prompt: structuredClone(prompt), option: option ?? -1, expiresAt,
      answerRequestId: randomUUID(), purpose: option === undefined ? "diagnose" : "answer",
      ...(recovery ? { recoveryRequestId: recovery.id } : {}), ...(recovery?.requestedPaths ? { requestedPaths: [...recovery.requestedPaths] } : {}), status: "pending" });
    let targetCwd: string;
    try { targetCwd = realpathSync(target.cwd); this.assertRunPath(stored, targetCwd); }
    catch (error) {
      const cause = error instanceof TeamError ? error.message : "The target workspace could not be resolved for permission review.";
      const failedDecision = createDecision(target.cwd, recovery?.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString());
      (run.permissionDecisions ??= []).push(failedDecision);
      if (recovery) recovery.latestDecisionId = failedDecision.id;
      this.escalatePermissionDecision(stored, failedDecision, cause, "The permission request remains with the user because its target workspace could not be verified.");
      stopRecovery(cause);
      return false;
    }
    if (recovery && recovery.targetCwd !== targetCwd) return stopRecovery("The original permission recovery working directory changed.");
    const expiresAt = new Date(Math.min(Date.now() + 5 * 60 * 1000, recovery ? Date.parse(recovery.expiresAt) : Infinity)).toISOString();
    const decision = createDecision(targetCwd, expiresAt);
    (run.permissionDecisions ??= []).push(decision);
    if (recovery) recovery.latestDecisionId = decision.id;
    if (target.role === "permission-coordinator") {
      this.escalatePermissionDecision(stored, decision, "A permission request from the permission coordinator cannot be delegated again.", "The permission request remains with the user because it came from the permission coordinator.");
      stopRecovery(decision.reason!);
      return false;
    }
    if (!this.config.agents[run.lineup.coordinator.provider]) {
      this.escalatePermissionDecision(stored, decision, "The pinned permission coordinator provider is not configured on this host.", "The permission request remains with the user because its pinned coordinator provider is not configured on this host.");
      stopRecovery(decision.reason!);
      return false;
    }
    try { this.assertBudget(run, true); }
    catch (error) {
      this.escalatePermissionDecision(stored, decision, error instanceof TeamError ? error.message : "The team has no remaining agent or deadline budget for a permission review.",
        "A permission request remains with the user because the team has no review budget.");
      stopRecovery(decision.reason!);
      return false;
    }
    if (run.lineup.coordinator.provider !== "claude") {
      this.escalatePermissionDecision(stored, decision, "The pinned permission coordinator provider is not qualified for report-only permission review.", "The permission request remains with the user because the selected coordinator provider is not qualified for report-only review.");
      stopRecovery(decision.reason!);
      return false;
    }
    const task = target.role === "scout" ? run.discovery?.tasks.find(item => item.id === target.taskId) : run.tasks.find(item => item.id === target.taskId);
    let changedPaths: string[], permissionEvidence: ReturnType<typeof collectPermissionEvidence>;
    try {
      if (evidenceOverride) { changedPaths = evidenceOverride.changedPaths; permissionEvidence = evidenceOverride.evidence; }
      else {
        changedPaths = await memberChangedPaths(targetCwd, target.baseCommit, this.config.teams?.commandPrefix);
        permissionEvidence = collectPermissionEvidence({ prompt: decision.prompt, cwd: targetCwd, changedPaths, requestedPaths: decision.requestedPaths,
          approvedScratchRoots: target.scratchDirectory ? [target.scratchDirectory] : [] });
      }
    } catch {
      this.escalatePermissionDecision(stored, decision, "The target's changed files could not be listed for review.", "The permission request remains with the user because its changed files could not be listed for review.");
      if (recovery) {
        const cause = decision.reason!;
        this.queuePermissionRecoveryPm(stored, recovery, cause, decision.id);
      }
      return false;
    }
    try {
      const state = await this.manager.state(target.sessionId, true), livePrompt = state.attention.prompt;
      const metadata = this.manager.meta(target.sessionId).session, assigned = metadata.team;
      if (state.status !== "running" || state.attention.state !== "needs-you" || state.control && state.control.expiresAt > Date.now() ||
          !livePrompt || livePrompt.id !== decision.promptId || livePrompt.hash !== decision.promptHash ||
          permissionEvidenceHash(livePrompt) !== decision.evidenceHash ||
          ((isCollapsedPermissionPrompt(livePrompt) ? undefined : oneShotPermissionOption(livePrompt)) ?? -1) !== decision.option ||
          !assigned || assigned.runId !== run.id || assigned.memberId !== target.memberId || assigned.revision !== run.revision ||
          assigned.role !== target.role || metadata.cwd !== targetCwd)
        throw new Error("The target assignment, prompt, or human control lease changed before the review began.");
    } catch (error) {
      decision.status = "stale";
      const cause = error instanceof Error ? error.message : "The target prompt could not be re-read before review.";
      decision.reason = cause;
      if (recovery) {
        this.recordPermissionRecoveryStep(stored, recovery, { decisionId: decision.id, cause, action: "re-read-before-review", decision: "stop-stale-review",
          consequence: "No coordinator was launched and no provider answer was sent." });
        this.finishPermissionRecovery(stored, recovery, "interrupted", cause, "re-read-before-review", "stop-stale-review", "The request remains with the owner.", decision.id);
      }
      this.save(stored);
      return false;
    }
    const workspaceEvidenceHash = digest({ changedPaths, evidence: permissionEvidence.digest });
    if (recovery && (run.permissionDecisions ?? []).some(prior => prior.recoveryRequestId === recovery.id && prior.targetMemberId === target.memberId &&
        prior.targetSessionId === target.sessionId && prior.promptId === prompt.id && prior.promptHash === promptHash && prior.evidenceHash === evidenceHash &&
        prior.workspaceEvidenceHash === workspaceEvidenceHash)) {
      const cause = "The fresh evidence snapshot is identical to one already assigned to a coordinator.";
      decision.status = "stale"; decision.reason = cause;
      this.recordPermissionRecoveryStep(stored, recovery, { decisionId: decision.id, cause, action: "fresh-review", decision: "refuse-duplicate-snapshot",
        consequence: "No duplicate coordinator was launched and no provider answer was sent." });
      this.finishPermissionRecovery(stored, recovery, "interrupted", cause, "fresh-review", "refuse-duplicate-snapshot", "No provider answer was sent.", decision.id);
      this.save(stored);
      return false;
    }
    decision.workspaceEvidenceHash = workspaceEvidenceHash;
    let deliveryAuthority = null;
    if (target.role === "delivery") {
      try { this.assertDelivery(stored); await assertMemberReadOnly(targetCwd, run.headCommit!, this.config.teams?.commandPrefix); }
      catch {
        this.escalatePermissionDecision(stored, decision, "The delivery policy, reviewed head, or required checks are no longer current.", "The delivery permission request could not be matched to current delivery authority.");
        stopRecovery(decision.reason!);
        return false;
      }
      deliveryAuthority = { policy: run.delivery!, branch: run.branch, headCommit: run.headCommit!, review: run.review!,
        checks: run.checks.filter(check => check.revision === run.revision).map(({ command, status, exitCode }) => ({ command, status, exitCode })) };
    }
    const permissionRecoveryHistory = this.permissionRecoveryHistory(run);
    const feedbackBase = { decisionId: decision.id, recoveryRequestId: recovery?.id ?? null, reviewPurpose: decision.purpose,
      targetAssignment: assignment(target), targetCwd: decision.targetCwd, targetScratchDirectory: target.scratchDirectory ?? null, targetTask: task ?? null,
      targetChangedPaths: changedPaths.slice(0, 100), targetChangedPathCount: changedPaths.length, acceptedChecks: this.requiredChecks(run) ?? null,
      permissionEvidence, deliveryAuthority, prompt: decision.prompt };
    const feedback = (history: TeamPermissionRecoveryView[]) => JSON.stringify({ ...feedbackBase, ...(history.length ? { priorPermissionRecovery: history } : {}) });
    let member: TeamMember;
    try {
      member = this.newMember(run, "permission-coordinator", "", run.headCommit!, undefined, undefined, run.lineup.coordinator);
      try {
        member.prompt = teamPrompt(run, "permission-coordinator", undefined, feedback(permissionRecoveryHistory), member.provider ?? run.provider,
          member.modelProfile, undefined, permissionRecoveryHistory);
      } catch (error) {
        if (!(error instanceof TeamError) || error.code !== "team-prompt-too-large" || !permissionRecoveryHistory.length) throw error;
        member.prompt = teamPrompt(run, "permission-coordinator", undefined, feedback([]), member.provider ?? run.provider, member.modelProfile, undefined, []);
      }
    } catch (error) {
      if (!(error instanceof TeamError) || error.code !== "team-prompt-too-large") throw error;
      if (recovery) {
        const cause = "The complete evidence exceeds the coordinator prompt limit and cannot be reviewed without truncation.";
        decision.status = "escalated"; decision.reason = cause;
        this.queuePermissionRecoveryPm(stored, recovery, cause, decision.id);
      } else this.escalatePermissionDecision(stored, decision, "The complete evidence exceeds the 80 KiB coordinator prompt limit and cannot be reviewed without truncation.", "The permission request remains with the user because its complete evidence exceeds the review limit.");
      return false;
    }
    decision.coordinatorMemberId = member.memberId;
    const selectedProfile = this.config.agents[member.provider ?? run.provider];
    if (member.provider !== "claude" || !selectedProfile) {
      this.escalatePermissionDecision(stored, decision, "The selected permission coordinator provider is not qualified for report-only review.", "The permission request remains with the user because the selected coordinator provider is not qualified for report-only review.");
      stopRecovery(decision.reason!);
      return false;
    }
    try { permissionCoordinatorLaunch("claude", teamModelLaunch(selectedProfile, member.modelProfile!)); }
    catch (error) {
      decision.status = "escalated";
      decision.reason = error instanceof Error ? error.message : "The selected coordinator profile cannot launch in report-only mode.";
      if (recovery) {
        this.finishPermissionRecovery(stored, recovery, "interrupted", decision.reason, "fresh-review", "launch-refused", "No permission answer was sent.", decision.id);
      }
      this.event(stored, "The permission request remains with the user because the pinned coordinator profile cannot launch safely in report-only mode.");
      this.save(stored);
      return false;
    }
    if (recovery) {
      recovery.latestDecisionId = decision.id;
      recovery.status = recovery.rounds ? "reviewing-evidence" : "diagnosing";
    }
    this.save(stored);
    this.operation(stored, "member", async signal => {
      this.assertRunPath(stored, run.workspace);
      const cwd = await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.config.teams?.commandPrefix, signal);
      await assertMemberReadOnly(cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
      return cwd;
    }, cwd => {
      member.cwd = cwd; run.members.push(member); decision.status = "reviewing";
      if (recovery) recovery.status = recovery.rounds ? "reviewing-evidence" : "diagnosing";
      const message = decision.purpose === "diagnose"
        ? "An incomplete or unrecognized screen permission prompt was assigned for report-only diagnosis; it cannot be approved from this assignment."
        : "A screen-verified one-shot permission request was assigned to the pinned strong coordinator for read-only review.";
      this.event(stored, message);
    });
    return true;
  }
  private requestPermissionEvidence(stored: Stored, decision: TeamPermissionDecision, member: TeamMember,
    report: Extract<TeamReport, { kind: "permission-decision" }>) {
    const run = stored.run;
    const target = run.members.find(item => item.memberId === decision.targetMemberId && item.sessionId === decision.targetSessionId);
    if (!target || !report.requestedPaths?.length) {
      if (decision.recoveryRequestId) {
        const request = run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId);
        if (request) {
          const cause = "The coordinator requested evidence without a valid active target assignment or path list.";
          decision.status = "escalated"; decision.reason = cause;
          this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action: "collect-requested-evidence",
            decision: "refuse-invalid-request", consequence: "No files were collected and no provider answer was sent." });
          this.queuePermissionRecoveryPm(stored, request, cause, decision.id);
        }
      }
      return;
    }
    const request = decision.recoveryRequestId
      ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId)
      : this.newPermissionRecoveryRequest(stored, target, decision.prompt);
    if (!request) {
      decision.status = "escalated";
      decision.reason = "The recorded recovery request no longer exists.";
      this.save(stored);
      return;
    }
    request.latestDecisionId = decision.id;
    const normalized = this.normalizeRequestedPermissionPaths(report.requestedPaths, request.targetCwd, target.scratchDirectory);
    const previous = request.requestedPaths ?? [];
    const newlyRequested = normalized?.filter(path => !previous.includes(path));
    const requestedPaths = normalized && newlyRequested?.length ? [...previous, ...newlyRequested] : undefined;
    const cause = boundedRecoveryText(report.summary);
    if (decision.status !== "reviewing" || decision.revision !== run.revision || request.revision !== run.revision ||
        request.rounds >= permissionRecoveryRoundLimit || !requestedPaths || requestedPaths.length > 8) {
      decision.status = "escalated";
      decision.reason = request.rounds >= permissionRecoveryRoundLimit ? "The two fresh evidence-review rounds are exhausted." : "The evidence request is stale, unsafe, repeated, or outside its bounded path limit.";
      const terminalCause = decision.reason;
      this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action: "collect-requested-evidence",
        decision: "refuse-or-exhaust-evidence-request", consequence: "No new files were collected and no permission answer was sent." });
      this.queuePermissionRecoveryPm(stored, request, terminalCause, decision.id);
      this.save(stored);
      member.status = "stopped";
      return;
    }
    if (this.permissionRecoveryPromptInvalidReason(stored, request, target)) {
      const reason = this.permissionRecoveryPromptInvalidReason(stored, request, target)!;
      decision.status = "escalated"; decision.reason = reason;
      this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause: reason, action: "collect-requested-evidence",
        decision: "stop-stale-review", consequence: "No new files were collected and no answer was sent." });
      this.finishPermissionRecovery(stored, request, "interrupted", reason, "collect-requested-evidence", "stop-stale-review", "The request remains with the owner.", decision.id);
      member.status = "stopped"; this.save(stored); return;
    }
    request.requestedPaths = requestedPaths;
    request.rounds++;
    request.status = "reviewing-evidence";
    this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action: "collect-requested-evidence",
      decision: "collect-bounded-in-scope-files", consequence: "The host will validate the same target assignment and prompt before launching a fresh review." });
    this.save(stored);
    this.operation(stored, "result", async signal => {
      await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
      const before = await this.inspectPermissionRecoveryPrompt(stored, request, target);
      if (!("state" in before)) return { status: "interrupted" as const, reason: before.reason ?? "The target state could not be confirmed before evidence collection." };
      let changedPaths: string[], evidence: ReturnType<typeof collectPermissionEvidence>;
      try {
        changedPaths = await memberChangedPaths(request.targetCwd, target.baseCommit, this.config.teams?.commandPrefix);
        evidence = collectPermissionEvidence({ prompt: before.prompt, cwd: request.targetCwd, changedPaths, requestedPaths,
          approvedScratchRoots: target.scratchDirectory ? [target.scratchDirectory] : [] });
      } catch (error) { return { status: "exhausted" as const, reason: error instanceof Error ? error.message : "Requested evidence could not be collected safely." }; }
      const after = await this.inspectPermissionRecoveryPrompt(stored, request, target);
      if (!("state" in after)) return { status: "interrupted" as const, reason: after.reason ?? "The target state could not be confirmed after evidence collection." };
      if (after.prompt.hash !== before.prompt.hash || permissionEvidenceHash(after.prompt) !== permissionEvidenceHash(before.prompt))
        return { status: "interrupted" as const, reason: "The target prompt changed while requested evidence was being collected." };
      if (digest({ changedPaths, evidence: evidence.digest }) === decision.workspaceEvidenceHash)
        return { status: "exhausted" as const, reason: "The requested paths did not add a different complete evidence snapshot." };
      return { status: "ready" as const, prompt: after.prompt, changedPaths, evidence };
    }, result => {
      member.status = "stopped";
      decision.status = "escalated";
      decision.reason = result.status === "ready" ? "The requested evidence was collected for a fresh, separate coordinator decision." : result.reason;
      request.latestDecisionId = decision.id;
      if (result.status === "interrupted" || result.status === "exhausted") {
        this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause: result.reason, action: "collect-requested-evidence",
          decision: result.status === "interrupted" ? "stop-stale-review" : "evidence-unavailable-or-unchanged",
          consequence: "No permission answer was sent; the retained evidence stays available for correction." });
        if (result.status === "interrupted")
          this.finishPermissionRecovery(stored, request, "interrupted", result.reason, "collect-requested-evidence", "stop-stale-review",
            "No provider answer was sent; the current prompt requires fresh owner review.", decision.id);
        else this.queuePermissionRecoveryPm(stored, request, result.reason, decision.id);
        return;
      }
      request.status = "reviewing-evidence";
      this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action: "collect-requested-evidence",
        decision: "complete-fresh-evidence-snapshot", consequence: "A distinct coordinator assignment will inspect the collected snapshot; command execution remains unknown." });
      void this.enqueue(async () => {
        const launched = await this.startPermissionCoordinatorReview(stored, target, result.prompt, request,
          { changedPaths: result.changedPaths, evidence: result.evidence });
        if (!launched && livePermissionRecoveryStatuses.has(request.status)) {
          const reason = "A fresh coordinator review could not be launched under the current run authority or budget.";
          this.finishPermissionRecovery(stored, request, "interrupted", reason, "fresh-review", "launch-refused", "No permission answer was sent.", decision.id);
          this.save(stored);
        }
      });
    }, member);
  }
  private async permissionAnswerInvalidReason(stored: Stored, decision: TeamPermissionDecision, coordinator: TeamMember) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status)) return "The team is paused, stopped, blocked, or its permission policy was revoked.";
    if (decision.purpose === "diagnose" || decision.option < 0) return "A diagnostic permission review has no authority to answer a provider prompt.";
    if (decision.status !== "approved" || decision.revision !== run.revision || coordinator.revision !== run.revision ||
        decision.coordinatorMemberId !== coordinator.memberId || decision.targetMemberId === coordinator.memberId)
      return "The decision or coordinator assignment is no longer current.";
    if (decision.policyHash !== digest(run.permissions))
      return "The pinned permission policy no longer matches this decision.";
    if (Date.now() >= Date.parse(decision.expiresAt)) return "The five-minute permission review window expired.";
    if (!run.lineup || run.lineup.coordinator.tier !== "strong") return "The pinned coordinator profile is no longer eligible.";
    try {
      this.assertBudget(run);
      const target = run.members.find(member => member.memberId === decision.targetMemberId && member.sessionId === decision.targetSessionId);
      if (!target || target.revision !== run.revision || target.status === "stopped" || !activeMember(target) || target.role === "permission-coordinator")
        return "The target member assignment is no longer active.";
      const canonicalCwd = realpathSync(target.cwd);
      if (canonicalCwd !== decision.targetCwd) return "The target working directory changed.";
      this.assertRunPath(stored, canonicalCwd);
      if (target.role === "delivery") {
        this.assertDelivery(stored);
        await assertMemberReadOnly(canonicalCwd, run.headCommit!, this.config.teams?.commandPrefix);
      }
      if (decision.workspaceEvidenceHash) {
        const changedPaths = await memberChangedPaths(canonicalCwd, target.baseCommit, this.config.teams?.commandPrefix);
        const evidence = collectPermissionEvidence({ prompt: decision.prompt, cwd: canonicalCwd, changedPaths, requestedPaths: decision.requestedPaths,
          approvedScratchRoots: target.scratchDirectory ? [target.scratchDirectory] : [] });
        if (decision.workspaceEvidenceHash !== digest({ changedPaths, evidence: evidence.digest }))
          return "The inspected command sources or changed paths changed during permission review. Nothing was sent.";
      }
      const metadata = this.manager.meta(target.sessionId).session;
      const sessionAssignment = metadata.team;
      if (!sessionAssignment || sessionAssignment.runId !== run.id || sessionAssignment.memberId !== target.memberId ||
          sessionAssignment.revision !== target.revision || sessionAssignment.role !== target.role || metadata.cwd !== canonicalCwd)
        return "The target session no longer matches its recorded assignment and working directory.";
      const state = await this.manager.state(target.sessionId, true);
      if (state.status !== "running" || state.control && state.control.expiresAt > Date.now()) return "The target is unavailable or a human control lease is active.";
      const prompt = state.attention.prompt;
      if (!prompt || state.attention.state !== "needs-you" || prompt.id !== decision.promptId || prompt.hash !== decision.promptHash ||
          permissionEvidenceHash(prompt) !== decision.evidenceHash || oneShotPermissionOption(prompt) !== decision.option)
        return "The target permission prompt or its one-shot option changed.";
    } catch (error) {
      return error instanceof TeamError ? error.message : "The current target session could not be verified.";
    }
    return undefined;
  }
  private consumePermissionCoordinator(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId && item.revision === member.revision);
    if (!decision) { this.block(stored, new TeamError(409, "invalid-permission-decision", "The permission coordinator has no recorded decision assignment.")); return; }
    if (decision.status !== "reviewing") {
      this.event(stored, "A late permission coordinator report was ignored because its one-shot review is no longer current.");
      this.save(stored);
      return;
    }
    const acceptedReport = report.kind === "permission-decision" && report.decisionId === decision.id ? report : undefined;
    if (acceptedReport?.verdict === "request-evidence") {
      this.requestPermissionEvidence(stored, decision, member, acceptedReport);
      return;
    }
    const verdict = acceptedReport?.verdict ?? "escalate";
    const summary = acceptedReport?.summary ?? (report.kind === "blocked" ? report.summary : report.kind === "question" ? report.question
      : "The coordinator did not submit the assigned permission decision report.");
    const diagnosticApproval = verdict === "approve-once" && (decision.purpose === "diagnose" || decision.option < 0);
    this.operation(stored, "result", async signal => {
      await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
      if (verdict !== "approve-once") return { status: "escalated" as const, reason: summary };
      if (diagnosticApproval) return { status: "escalated" as const, reason: "A diagnostic permission assignment cannot approve a provider request." };
      decision.status = "approved";
      decision.reason = summary;
      this.save(stored);
      const reason = await this.permissionAnswerInvalidReason(stored, decision, member);
      if (reason) return { status: "escalated" as const, reason };
      if (decision.status !== "approved" || !run.permissions || run.permissionsRevokedAt || stored.halt ||
          ["paused", "cancelled", "blocked"].includes(run.status) || decision.revision !== run.revision ||
          decision.coordinatorMemberId !== member.memberId || decision.policyHash !== digest(run.permissions) ||
          Date.now() >= Date.parse(decision.expiresAt))
        return { status: "escalated" as const, reason: "The permission decision changed while the target session was being checked." };
      decision.status = "answering";
      decision.reason = summary;
      this.save(stored);
      try {
        const target = run.members.find(item => item.memberId === decision.targetMemberId && item.sessionId === decision.targetSessionId);
        if (!target) return { status: "escalated" as const, reason: "The target assignment disappeared before the answer." };
        const receipt = await this.manager.answerTeamPermission(decision.targetSessionId, decision.answerRequestId, assignment(target), decision);
        return receipt.state === "delivered" && receipt.result === "closed"
          ? { status: "answered" as const, receipt }
          : receipt.state === "uncertain" ? { status: "uncertain" as const, receipt, reason: "The host could not confirm whether the target prompt closed. Inspect the target session before acting." }
            : { status: "escalated" as const, receipt, reason: `The target prompt did not close (${receipt.result ?? receipt.state}). The request remains with the user.` };
      } catch (error) {
        if (refusedBeforeSend(error))
          return { status: "escalated" as const, reason: "The target prompt changed or became unavailable before the answer, and nothing was sent. The request remains with the user." };
        return { status: "uncertain" as const, reason: "The host could not confirm whether the target prompt was answered. Inspect the target session before acting." };
      }
    }, result => {
      if (["reviewing", "approved", "answering"].includes(decision.status)) { decision.status = result.status; decision.reason = result.reason ?? summary; }
      else decision.reason = "The decision changed while the answer was in flight. Inspect the target session before acting.";
      if ("receipt" in result) decision.receipt = result.receipt;
      member.status = "stopped";
      const request = decision.recoveryRequestId ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId) : undefined;
      if (request) {
        this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause: result.reason ?? summary,
          action: result.status === "answered" ? "answer-final-review" : "finish-coordinator-review",
          decision: result.status === "answered" ? "one-shot-answer-delivered" : result.status === "uncertain" ? "answer-state-uncertain" : diagnosticApproval ? "reject-diagnostic-approval" : "coordinator-escalated",
          consequence: result.status === "answered" ? "The provider prompt closed; command execution remains unknown." : "No successful command execution was observed.",
          ...(result.receipt ? { receipt: result.receipt } : {}) });
        if (result.status === "answered") {
          this.finishPermissionRecovery(stored, request, "complete", result.reason ?? summary, "answer-final-review", "one-shot-answer-delivered",
            "The provider prompt closed; the command's execution result remains unknown.", decision.id);
        } else if (result.status === "uncertain") {
          this.finishPermissionRecovery(stored, request, "interrupted", result.reason ?? summary, "answer-final-review", "answer-state-uncertain",
            "The target session must be inspected before any further action.", decision.id);
        } else if (decision.purpose === "diagnose" || diagnosticApproval) {
          this.queuePermissionRecoveryPm(stored, request, result.reason ?? summary, decision.id);
        } else {
          this.finishPermissionRecovery(stored, request, "exhausted", result.reason ?? summary, "fresh-review", "owner-attention-required",
            "The coordinator declined the one-shot request; no permission was sent.", decision.id);
        }
      }
      this.event(stored, result.status === "answered" ? "A one-shot permission option was delivered and the prompt closed; command execution remains unknown." : "The permission request remains with the user.");
    }, member);
  }
  private taskProfiles(run: TeamRun, tasks: { agentProfileId?: string }[]) {
    for (const task of tasks) {
      if (!run.lineup) {
        if (task.agentProfileId !== undefined) throw new TeamError(409, "invalid-agent-profile", "A single-provider team cannot select profiles from a configured lineup.");
      } else if (!task.agentProfileId || !run.lineup.implementers.some(profile => profile.id === task.agentProfileId)) {
        throw new TeamError(409, "invalid-agent-profile", "Every task must select an agentProfileId from the team's configured implementer pool.");
      }
    }
  }
  private assertDelivery(stored: Stored) {
    const run = stored.run, configured = this.config.projects.find(project => project.id === run.projectId)?.team?.delivery;
    if (!run.delivery || !configured || digest(configured) !== digest(run.delivery))
      throw new TeamError(409, "delivery-policy-changed", "The repository delivery policy changed or was removed; publication is blocked.");
    if (!run.headCommit || stored.checkHead !== run.headCommit || run.review?.revision !== run.revision || run.review.verdict !== "approved")
      throw new TeamError(409, "delivery-not-reviewed", "Delivery requires passing checks and independent approval for the current integration commit.");
  }
  private memberProfile(run: TeamRun, role: TeamMember["role"], task?: TeamTask | TeamScout): TeamModelProfile | undefined {
    if (!run.lineup) return undefined;
    if (role === "project-manager" || role === "delivery" || role === "permission-coordinator") return run.lineup.coordinator;
    if (role === "integrator") return run.lineup.integrator;
    if (role === "reviewer") return run.lineup.reviewer;
    if (!task) throw new TeamError(409, "invalid-agent-profile", "An implementer requires an assigned task and allowed model profile.");
    this.taskProfiles(run, [task]);
    return run.lineup.implementers.find(profile => profile.id === task.agentProfileId)!;
  }
  private newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, prompt?: string, pinnedProfile?: TeamModelProfile): TeamMember {
    this.assertBudget(run, true);
    const memberId = randomUUID();
    const task = role === "scout" ? run.discovery?.tasks.find(task => task.id === taskId) : run.tasks.find(task => task.id === taskId);
    let selected = pinnedProfile ?? this.memberProfile(run, role, task);
    const limit = selected && this.limits.active().find(item => item.provider === selected!.provider);
    const fallback = limit && run.lineup ? resolveLimitFallback(run.lineup, selected!.id, this.limits.limited()) : undefined;
    const retargeted = fallback && prompt !== undefined ? retargetPrompt(prompt, { provider: fallback.provider, profile: fallback }) : undefined;
    // Without a resolvable fallback, or with a passed prompt it cannot carry, the launch proceeds: the limit may have lifted.
    if (selected && limit && fallback && (prompt === undefined || retargeted !== undefined)) {
      runEvent(run, `${selected.label} launched on ${fallback.label}: ${PROVIDER_NAMES[limit.provider]} is limited until ${clock(limit.expiresAt)}`);
      prompt = retargeted; selected = fallback;
    }
    const modelProfile = selected ? structuredClone(selected) : undefined;
    const provider = modelProfile?.provider ?? run.provider;
    const configuredProject = this.config.projects.find(project => project.id === run.projectId)?.team;
    const permissionRecoveryHistory = this.permissionRecoveryHistory(run);
    let instructions = prompt === undefined ? teamPrompt(run, role, task, undefined, provider, modelProfile, configuredProject, permissionRecoveryHistory) : refreshReportingInstructions(prompt, provider);
    // Carried questions and recovery notes can outgrow an otherwise bounded prompt.
    // Keep them complete in the context file and rebuild the role's current authority.
    if (role !== "permission-coordinator" && Buffer.byteLength(instructions) > 80 * 1024)
      instructions = teamPrompt(run, role, task, prompt, provider, modelProfile, configuredProject, permissionRecoveryHistory);
    if (Buffer.byteLength(instructions) > 80 * 1024) throw new TeamError(409, "team-prompt-too-large", "The accumulated team requirements exceed the prompt limit. Start a new team with consolidated requirements.");
    return { runId: run.id, memberId, revision: run.revision, role, ...(role === "project-manager" && !run.establishChecks && !run.verification ? { verificationRefused: true as const } : {}), provider, ...(modelProfile ? { modelProfile } : {}), ...(taskId ? { taskId } : {}), sessionId: randomUUID(), title: `${role}: ${taskId ?? run.title}`.slice(0, 100), status: "queued", cwd, baseCommit, prompt: instructions, ...(prompt ? { contextFeedback: prompt } : {}), cursor: 0, stopRequestId: randomUUID() };
  }
  /**
   * A limit acts only on the whole journal: a report or recovery in an unread tail wins.
   * After a confirmed exit, drain the tail even without a limit before considering replacement.
   */
  private readMemberJournal(run: TeamRun, member: TeamMember, exited = false, singlePage = false) {
    let page: ReturnType<Manager["events"]>, limit: LimitSwitch | undefined;
    do {
      page = this.manager.events(member.sessionId, member.cursor, 200, new Set(["team-report", "signal"]));
      member.cursor = page.cursor;
      for (const event of page.events) {
        if (event.type === "signal") {
          const data = event.data;
          // Prefer a corroborated observation; a later successful turn means the member recovered.
          if (switchesMember(data)) { if (!limit || (limit.confidence !== "corroborated" && data.confidence === "corroborated")) limit = { ...data, at: event.at, seq: event.seq }; }
          else if (recoveryTurnEnd(data as unknown as SignalData) || (data.kind === "notice" && data.type === "quota_auto_resume_fired")) limit = undefined;
          continue;
        }
        const parsed = teamReportEnvelopeSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const envelope = parsed.data;
        if (envelope.runId !== run.id || envelope.memberId !== member.memberId || envelope.revision !== member.revision) continue;
        member.report = envelope.report; member.status = "reported"; member.reportedAt = timestamp(); member.stalledAt = undefined;
        if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
        break;
      }
    } while (!singlePage && !member.report && (exited || limit) && page.more);
    return { page, limit };
  }
  /**
   * Stops a member with no attention activity for the stall window and continues its assignment once in
   * the same working copy. A second stall on the same assignment blocks the run for the owner.
   */
  private async replaceStalledMember(stored: Stored, member: TeamMember) {
    const run = stored.run, minutes = this.stallWindow() / 60000;
    const earlierStop = Boolean(member.stalledAt);
    member.stalledAt ??= timestamp();
    member.stoppedReason ??= `No activity for ${minutes} minutes`;
    this.save(stored);
    let exited;
    try { exited = await this.stopped(member); if (!exited) { this.save(stored); return; } }
    catch (error) {
      // A preflight or lease refusal proves only this attempt sent nothing, not an earlier uncertain attempt.
      const refused = error instanceof TeamStopRefused || error instanceof Error && ["control-busy", "control-lost"].includes((error as WorkerError).code ?? "");
      if (refused && !earlierStop) {
        member.stalledAt = undefined;
        if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
      }
      member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); return;
    }
    const { page, limit } = this.readMemberJournal(run, member, true);
    if (member.report) { this.save(stored); return; }
    if (page.more || member.cursor < exited.seq) { member.status = "unavailable"; this.save(stored); return; }
    if (limit) {
      member.stalledAt = undefined;
      if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
      await this.switchLimitedMember(stored, member, limit); return;
    }
    // A delivery member may already have published; a replacement must not repeat it unseen.
    if (member.role === "delivery" && stored.deliveryAttempt) {
      this.block(stored, new TeamError(409, "delivery-reconciliation-required", "The delivery agent stalled after a publication attempt. Inspect the remote branch and PR before replacing it.")); return;
    }
    if (run.members.some(item => item !== member && item.revision === member.revision && item.role === member.role && item.taskId === member.taskId && item.stalledAt)) {
      this.block(stored, new TeamError(409, "member-stalled", memberStallReason)); return;
    }
    const task = member.role === "implementer" ? run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    const scout = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const prefix = this.config.teams?.commandPrefix, editing = member.role === "implementer" || member.role === "integrator";
    const note = `The previous ${member.role} stalled with no activity for ${minutes} minutes before reporting. Its workspace was preserved. ${editing ? "Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing." : "Its working copy was checked unchanged; complete the same assignment."}`;
    this.operation(stored, "result", signal => editing ? assertMemberScope(member.cwd, member.baseCommit, task ? task.paths : run.goal?.allowedPaths, prefix, signal) : assertMemberReadOnly(member.cwd, member.baseCommit, prefix, signal), () => {
      const next = this.newMember(run, member.role, member.cwd, member.baseCommit, member.taskId, `${member.prompt}\n\n${note}`, member.modelProfile);
      next.contextFeedback = [member.contextFeedback ?? member.prompt, note].filter(Boolean).join("\n\n");
      if (task) { task.memberId = next.memberId; task.status = "running"; }
      if (scout) scout.memberId = next.memberId;
      run.members.push(next);
      this.event(stored, `${member.title} stalled with no activity for ${minutes} minutes; its workspace was preserved and a replacement continues the assignment.`);
    });
  }
  /**
   * Stops a member whose provider hit a limit and continues its assignment on the profile's limit
   * fallback in the same working copy. The host only stops the member; it never sends it input.
   */
  private async switchLimitedMember(stored: Stored, member: TeamMember, limit: LimitSwitch) {
    const run = stored.run, provider = member.provider ?? run.provider, name = PROVIDER_NAMES[provider];
    const kind = limit.limit === "credits" ? "credit limit" : "usage limit", resets = limit.resetsAt ? clock(limit.resetsAt) : undefined;
    if (limit.confidence === "corroborated") this.limits.observe({ provider, detectedAt: limit.at, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), sessionId: member.sessionId, runId: run.id, confidence: "corroborated" });
    // Until the member's exit is confirmed, the next tick reads this observation again.
    try { if (!await this.stopped(member)) { member.cursor = limit.seq - 1; this.save(stored); return; } }
    catch { member.cursor = limit.seq - 1; member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); return; }
    member.stoppedReason = `${name} ${kind}${resets ? `, resets ${resets}` : ""}`;
    // A delivery member may already have published; a replacement must not repeat it unseen.
    if (member.role === "delivery" && stored.deliveryAttempt) {
      this.block(stored, new TeamError(409, "delivery-reconciliation-required", "The delivery provider stopped at a limit. Inspect the remote branch and PR before replacing a possibly completed publication.")); return;
    }
    const from = member.modelProfile, selected = from && run.lineup ? switchFallback(run.lineup, from.id, provider, this.limits.limited()) : undefined;
    // Only a Claude profile can run report-only permission review.
    const fallback = member.role === "permission-coordinator" && selected?.provider !== "claude" ? undefined : selected;
    if (!from || !fallback) {
      if (member.role === "permission-coordinator") {
        const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
        if (decision) { decision.status = "escalated"; decision.reason = "The coordinator provider reached a limit and no eligible strong fallback is available."; }
        member.status = "stopped"; this.save(stored);
        this.event(stored, "The permission review could not continue on an eligible coordinator profile; the request remains with the user.");
        return;
      }
      this.block(stored, new TeamError(409, "provider-limit", `${name} ${kind} reached at ${clock(limit.at)}${resets ? `, resets ${resets}` : ""}; no fallback profile is configured for ${from?.id ?? provider}.`));
      return;
    }
    const task = member.role === "implementer" ? run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    const scout = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const prefix = this.config.teams?.commandPrefix, editing = member.role === "implementer" || member.role === "integrator";
    const note = editing ? `The previous ${member.role} stopped at a ${name} ${kind}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`
      : `The previous ${member.role} stopped at a ${name} ${kind} before reporting. Its working copy was checked unchanged; complete the same assignment.`;
    // Editing roles keep in-scope partial work; read-only roles must have left their copy unchanged.
    this.operation(stored, "result", signal => editing ? assertMemberScope(member.cwd, member.baseCommit, task ? task.paths : run.goal?.allowedPaths, prefix, signal) : assertMemberReadOnly(member.cwd, member.baseCommit, prefix, signal), () => {
      // The prompt keeps its feedback and user answers. An unrecognized prompt is rebuilt with its answers.
      const configuredProject = this.config.projects.find(project => project.id === run.projectId)?.team;
      const carried = retargetPrompt(member.prompt, { provider: fallback.provider, profile: fallback }) ?? [teamPrompt(run, member.role, task ?? scout, undefined, fallback.provider, fallback, configuredProject, this.permissionRecoveryHistory(run)),
        ...run.decisions.filter(decision => decision.answer && run.members.some(prior => prior.memberId === decision.memberId && prior.role === member.role && prior.taskId === member.taskId && prior.revision === member.revision)).map(decision => `${decision.answeredBy === "coordinator" ? "Mission coordinator" : "User"} answered: ${decision.answer}`)].join("\n\n");
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
      this.event(stored, `${from.label} hit a ${name} ${kind}${resets ? ` (resets ${resets})` : ""}; ${task?.title ?? member.title} continues on ${fallback.label}${editing ? " with partial work preserved" : ""}.`);
    });
  }
  private prepareMember(stored: Stored, role: TeamMember["role"], task?: TeamTask | TeamScout, feedback?: string, onPrepared?: (member: TeamMember) => void) {
    const run = stored.run, member = this.newMember(run, role, "", run.headCommit!, task?.id);
    const continuationHead = role === "project-manager" && stored.continuationHead?.revision === run.revision
      ? structuredClone(stored.continuationHead) : undefined;
    if (feedback) {
      member.contextFeedback = feedback;
      member.prompt = teamPrompt(run, role, task, feedback, member.provider ?? run.provider, member.modelProfile,
        this.config.projects.find(project => project.id === run.projectId)?.team, this.permissionRecoveryHistory(run));
    }
    if (role !== "permission-coordinator") run.status = role === "project-manager" ? "planning" : role === "scout" ? "discovering" : role === "reviewer" ? "reviewing" : role === "delivery" ? "delivering" : role === "integrator" ? "integrating" : "implementing";
    this.operation(stored, "member", async signal => {
      this.assertRunPath(stored, run.workspace);
      if (continuationHead) await assertMemberReadOnly(run.workspace, continuationHead.headCommit, this.config.teams?.commandPrefix, signal, "integration");
      const cwd = await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.config.teams?.commandPrefix, signal);
      this.assertRunPath(stored, cwd);
      if (continuationHead) await assertMemberReadOnly(run.workspace, continuationHead.headCommit, this.config.teams?.commandPrefix, signal, "integration");
      // Bootstrap dependencies exist only after the first implementation. A failed
      // setup must not prevent the integrator from repairing the project.
      const setup = role === "permission-coordinator" ? undefined : run.establishChecks
        ? role === "reviewer" ? run.verification?.setup : undefined
        : this.config.projects.find(project => project.id === run.projectId)!.team!.setup;
      if (setup) {
        const result = await teamCommand(setup, cwd, signal, 600000, this.config.teams?.commandPrefix);
        if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "team-setup-failed", "A member's configured setup command failed. Its isolated workspace was preserved.");
        await assertMemberReadOnly(cwd, member.baseCommit, this.config.teams?.commandPrefix, signal, "setup");
      }
      return cwd;
    }, cwd => {
      if (continuationHead && stored.continuationHead?.revision === continuationHead.revision && stored.continuationHead.headCommit === continuationHead.headCommit)
        delete stored.continuationHead;
      member.cwd = cwd; run.members.push(member);
      if (task) { task.status = "running"; task.memberId = member.memberId; }
      onPrepared?.(member);
      this.event(stored, `${member.title} queued in an isolated working copy.`);
    });
  }
  private queueDeliveryRetryAfterEvidence(stored: Stored, member: TeamMember, report: DeliveryReconciliationReport) {
    const { run } = stored, policyHash = digest(run.delivery ?? null), prior = run.deliveryRecovery;
    const evidenceHash = deliveryInspectionHash(report);
    const attempts = Math.max(prior?.attempts ?? 0, run.recovery?.attempts ?? 0);
    if (attempts >= automaticRecoveryLimit || prior?.lastEvidenceHash === evidenceHash) {
      run.deliveryRecovery = { attempts, status: "exhausted", revision: run.revision, headCommit: report.headCommit, policyHash,
        sourceMemberId: member.memberId, lastEvidenceHash: evidenceHash, baseHeadCommit: report.baseHeadCommit, disposition: report.disposition };
      run.recovery = { attempts, status: "exhausted", source: { code: "delivery-recovery", memberId: member.memberId, revision: member.revision,
        reportKind: report.kind, reason: "The same no-publication or owned-branch evidence repeated without progress.", at: timestamp() } };
      run.status = "blocked"; run.blockCode = "delivery-reconciliation-required";
      run.reason = "Delivery inspection found no new remote evidence after the bounded recovery attempts. Review the retained reports before continuing.";
      stored.halt = "block";
      this.event(stored, "Automatic delivery recovery stopped after repeated unchanged remote evidence; no publication was inferred or repeated.");
      this.save(stored); this.trackBlocked(stored); return;
    }
    this.assertBudget(run, true);
    run.deliveryRecovery = { attempts: attempts + 1, status: "planning", revision: run.revision, headCommit: report.headCommit, policyHash,
      sourceMemberId: member.memberId, lastEvidenceHash: evidenceHash, baseHeadCommit: report.baseHeadCommit, disposition: report.disposition };
    run.recovery = { attempts: attempts + 1, status: "planning", source: { code: "delivery-recovery", memberId: member.memberId, revision: member.revision,
      reportKind: report.kind, reason: report.summary, at: timestamp() } };
    const feedback = [
      `Automatic delivery attempt ${attempts + 1} of ${automaticRecoveryLimit}, after structured remote inspection.`,
      `Prior attempt ${member.memberId} reported ${report.disposition} for exact reviewed head ${report.headCommit}, branch ${report.branch}, repository ${report.repository}, current base head ${report.baseHeadCommit}.`,
      `Its report is agent evidence, not host verification: ${JSON.stringify(report)}`,
      `Before any write or publication, inspect the current remote branch and PR again. Reuse the exact matching branch/PR; do not create a duplicate, rewrite an owned branch, force-push, or change credentials/tools.`,
    ].join("\n\n");
    this.prepareMember(stored, "delivery", undefined, feedback, next => {
      stored.deliveryAttempt = { memberId: next.memberId, revision: next.revision, headCommit: report.headCommit };
      run.deliveryRecovery!.sourceMemberId = next.memberId;
      run.reason = undefined; run.blockCode = undefined;
      this.event(stored, `A bounded delivery retry is queued for the unchanged reviewed head ${report.headCommit}; it must inspect remote state again.`);
    });
    run.status = "planning";
    this.save(stored);
  }
  private async launch(stored: Stored, member: TeamMember) {
    this.assertBudget(stored.run);
    this.assertRunPath(stored, member.cwd);
    // Recover an already-created assignment even while Linear is unavailable. A new
    // process requires the bridge's fresh feature and parent issue observations.
    if (!this.hasLaunch(member)) {
      const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true) ?? stored.run.linear;
      if (JSON.stringify(stored.run.linear) !== JSON.stringify(tracking)) { stored.run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked") throw new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work.");
      if (tracking && tracking.status !== "synced") return;
    }
    if (!this.hasLaunch(member) && (await this.manager.list()).filter(session => session.status === "running" || session.status === "starting").length >= this.config.maxSessions) { stored.run.reason = "Waiting for an available host session slot."; this.save(stored); return; }
    if (member.role === "delivery") {
      this.assertDelivery(stored);
      const attempt = stored.deliveryAttempt;
      if (attempt && (attempt.memberId !== member.memberId || attempt.revision !== member.revision || attempt.headCommit !== member.baseCommit))
        throw new TeamError(409, "delivery-reconciliation-required", "A different delivery attempt is unresolved; inspect the remote pull request before continuing.");
      await assertMemberReadOnly(stored.run.workspace, member.baseCommit, this.config.teams?.commandPrefix, undefined, "integration");
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
    // All launch fields were persisted with the queued member before this call.
    if (!this.hasLaunch(member) && member.role !== "permission-coordinator") {
      if (!member.scratchDirectory) {
        member.scratchDirectory = prepareMemberScratch(stored.run.workspace, member.memberId);
        member.prompt += `\n\nHost-assigned task scratch directory: ${member.scratchDirectory}. Use this directory for temporary scripts, browser probes, and generated check outputs. Keep repository files unchanged in read-only roles. This directory belongs only to your current assignment; do not read other members' scratch files.`;
        this.save(stored);
      }
      const configuredProject = stored.run.handoff?.project ?? this.config.projects.find(project => project.id === stored.run.projectId)?.team;
      await writeTeamContext(member.cwd, { ...teamContext(stored.run, member.contextFeedback, configuredProject, member.role, this.permissionRecoveryHistory(stored.run)), assignment: assignment(member), memberBaseCommit: member.baseCommit, scratchDirectory: member.scratchDirectory }, this.config.teams?.commandPrefix);
    }
    let result;
    try { result = await this.startInProject(stored.run.projectId, () => this.manager.createTeamSession({ requestId: member.sessionId, provider: member.provider ?? stored.run.provider, projectId: stored.run.projectId, title: member.title, prompt: member.prompt }, assignment(member), member.cwd, member.modelProfile, stored.root, this.config.teams?.trustWorkspaces === true)); }
    catch (error) { if (error instanceof Error && /configured session limit/.test(error.message)) { stored.run.reason = "Waiting for an available host session slot."; this.save(stored); return; } throw error; }
    member.status = result.status === "unavailable" ? "unavailable" : "running"; member.startedAt ??= timestamp(); this.save(stored);
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
    if (member.role === "permission-coordinator") { this.consumePermissionCoordinator(stored, member); return; }
    if (report.kind === "blocked") { this.block(stored, new TeamError(409, "agent-blocked", report.summary), member); return; }
    if (report.kind === "question" && ["implementer", "scout", "integrator", "reviewer"].includes(member.role)) {
      this.block(stored, new TeamError(409, "agent-question", `The ${member.role} requested an owner decision: ${report.question}`), member); return;
    }
    if (report.kind === "question") {
      if (run.decisions.length >= 40) { this.block(stored, new TeamError(409, "team-decision-limit", "The team reached its limit of 40 decisions. Review its evidence before starting another team.")); return; }
      member.status = "waiting";
      run.decisions.push({ id: randomUUID(), memberId: member.memberId, revision: run.revision, question: report.question, options: report.options, createdAt: timestamp() });
      const task = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId) : run.tasks.find(item => item.id === member.taskId); if (task) task.status = "waiting";
      run.status = "needs-input"; this.event(stored, `${member.title} requested a user decision.`); this.save(stored); return;
    }
    const expected = member.role === "project-manager" ? ["plan", "explore", "no-change"] : member.role === "scout" ? ["findings"] : member.role === "reviewer" ? ["review"] : member.role === "delivery" ? ["delivery", "delivery-repair", "delivery-reconciliation", "pull-request"] : member.role === "implementer" ? ["result", "escalate"] : ["result"];
    if (!expected.includes(report.kind)) { this.block(stored, new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role."), member); return; }
    if (report.kind === "no-change") {
      if (member.role !== "project-manager" || run.tasks.length || run.headCommit !== run.baseCommit) {
        this.block(stored, new TeamError(409, "invalid-no-change", invalidNoChangeReason), member); return;
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.config.teams?.commandPrefix, signal, "integration");
      }, () => {
        run.noChange = { summary: report.summary, evidence: report.evidence }; run.status = "no-change"; run.reason = undefined;
        if (run.recovery) run.recovery.status = "complete";
        this.event(stored, "The coordinator reported no justified change and recorded its evidence. No implementation was started.");
      }, member); return;
    }
    if (report.kind === "explore") {
      if (run.discovery || run.tasks.length || !run.lineup) throw new TeamError(409, "discovery-already-used", "A team may request one read-only discovery batch before implementation planning.");
      if (new Set(report.tasks.map(task => task.id)).size !== report.tasks.length) throw new TeamError(409, "invalid-discovery", "Discovery task IDs must be unique.");
      this.taskProfiles(run, report.tasks);
      if (report.parallelism !== undefined && report.parallelism > capacityCeiling(run))
        throw new TeamError(409, "team-parallelism-limit", `The project manager selected ${report.parallelism} workers, above this run's capacity ceiling of ${capacityCeiling(run)}.`);
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        this.applyProjectManagerCapacity(stored, report.parallelism);
        run.discovery = { revision: run.revision, summary: report.summary, tasks: report.tasks.map(task => ({ ...task, status: "pending" })) };
        run.status = "discovering";
        this.event(stored, `The coordinator requested ${report.tasks.length} read-only discovery tasks.`);
      }, member); return;
    }
    if (report.kind === "findings") {
      const scout = run.discovery?.tasks.find(task => task.id === member.taskId && task.memberId === member.memberId);
      if (!scout || run.discovery?.revision !== run.revision) throw new TeamError(409, "invalid-discovery", "The scout does not belong to the current discovery batch.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        scout.status = "complete"; scout.summary = report.summary; scout.evidence = report.evidence;
        this.event(stored, `${member.title} returned evidence without changing its working copy.`);
      }, member); return;
    }
    if (report.kind === "escalate") {
      const task = run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId);
      const profile = run.lineup?.escalations?.find(item => item.id === report.agentProfileId);
      if (!task || task.escalation || !profile || profile.id === member.modelProfile?.id)
        throw new TeamError(409, "invalid-escalation", "An implementer may escalate once to a different profile in the approved escalation pool.");
      this.operation(stored, "result", signal => assertMemberScope(member.cwd, member.baseCommit, task.paths, this.config.teams?.commandPrefix, signal), () => {
        task.escalation = { ...(member.modelProfile ? { fromProfileId: member.modelProfile.id } : {}), toProfileId: profile.id, reason: report.reason, memberId: member.memberId, at: timestamp() };
        const next = this.newMember(run, "implementer", member.cwd, member.baseCommit, task.id, undefined, profile);
        next.prompt = teamPrompt(run, "implementer", task, `The previous implementer requested escalation: ${report.reason}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`, next.provider ?? run.provider, next.modelProfile);
        run.members.push(next); task.memberId = next.memberId; task.status = "running";
        run.status = "implementing";
        this.event(stored, `${task.title} escalated to ${profile.label}; the stopped member's partial work was preserved.`);
      }, member); return;
    }
    if (report.kind === "plan") {
      validateTeamPlan(report.tasks);
      this.taskProfiles(run, report.tasks);
      if (report.parallelism !== undefined && report.parallelism > capacityCeiling(run))
        throw new TeamError(409, "team-parallelism-limit", `The project manager selected ${report.parallelism} workers, above this run's capacity ceiling of ${capacityCeiling(run)}.`);
      if (report.verification && !run.establishChecks && !run.verification) {
        if (run.verificationCorrections?.includes(run.revision)) {
          this.block(stored, new TeamError(409, "verification-not-authorized", "A plan cannot replace the project's configured checks."));
          return;
        }
        run.verificationCorrections = [...(run.verificationCorrections ?? []), run.revision];
        const message = "Plan rejected: this run uses the project's configured checks. Remove verification and submit a corrected plan. If the checks seem insufficient, explain that in the summary and assign tasks to run additional commands themselves and report results.";
        this.event(stored, "The project manager's plan included unauthorized verification; requesting a corrected plan.");
        this.save(stored);
        // Carry the owner's answers to this revision's planning questions into the corrected plan.
        const answers = run.decisions.filter(decision => decision.answer && decision.revision === run.revision && run.members.some(prior => prior.memberId === decision.memberId && prior.role === "project-manager"))
          .map(decision => `Earlier planning question: ${decision.question}\n${decision.answeredBy === "coordinator" ? "Mission coordinator" : "User"} answered: ${decision.answer}`);
        this.prepareMember(stored, "project-manager", undefined, [message, ...answers].join("\n\n"));
        return;
      }
      if (run.establishChecks && !run.verification && !report.verification)
        throw new TeamError(409, "verification-required", "The first plan must establish project verification commands before implementation.");
      if (run.verification && report.verification && digest(run.verification) !== digest(report.verification))
        throw new TeamError(409, "verification-changed", "The accepted verification commands cannot change during this run or its goal continuation.");
      if (run.goal && !report.brief) throw new TeamError(409, "goal-brief-required", "A goal plan must include an evidence-backed brief with acceptance criteria.");
      if (run.goal && report.tasks.some(task => task.paths.some(path => !teamPathAllowed(path, run.goal!.allowedPaths))))
        throw new TeamError(409, "goal-scope-violation", "The plan proposes paths outside the approved goal scope.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        this.applyProjectManagerCapacity(stored, report.parallelism);
        const remaining = [...report.tasks];
        run.tasks = [];
        while (remaining.length) {
          const index = remaining.findIndex(task => task.dependsOn.every(id => run.tasks.some(done => done.id === id)));
          run.tasks.push({ ...remaining.splice(index, 1)[0], revision: member.revision, reviewRounds: 0, status: "pending" });
        }
        applyTeamBriefTitle(run, report.brief, member.revision);
        if (report.verification && !run.verification) {
          run.verification = structuredClone(report.verification);
          this.event(stored, "The coordinator established verification commands under the owner's project opt-in.");
        }
        run.status = "implementing";
        this.event(stored, `Project manager planned ${run.tasks.length} tasks.`);
      }, member); return;
    }
    if (report.kind === "delivery-reconciliation") {
      const { run } = stored;
      const attempt = stored.deliveryAttempt;
      if (!run.delivery || report.repository !== run.delivery.repository || report.branch !== run.branch ||
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
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.config.teams?.commandPrefix, signal, "integration");
        if (report.disposition !== "no-publication" || report.baseHeadCommit === run.baseCommit) return undefined;
        if (run.goal || run.missionId || run.handoff)
          throw new TeamError(409, "delivery-baseline-parent-owned", "A moved-base delivery recovery requires standalone ownership; preserve this parent branch for explicit reconciliation.");
        const source = this.options?.source;
        if (!source?.isGithub(run.projectId))
          throw new TeamError(409, "delivery-baseline-source-unavailable", "The host cannot confirm the moved delivery base from its configured GitHub source.");
        this.assertBudget(run, true);
        const attempts = Math.max(run.deliveryRecovery?.attempts ?? 0, run.recovery?.attempts ?? 0);
        if (attempts >= automaticRecoveryLimit)
          throw new TeamError(409, "delivery-recovery-exhausted", "The team exhausted its automatic delivery recovery allowance. Its reviewed work and remote evidence remain retained.");
        // A direct moved-base report can arrive without an earlier blocked report. Charge
        // every fresh-base recovery before creating its copy, including later revisions.
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
          this.config.teams?.commandPrefix, signal, run.branch);
        this.assertRunPath(stored, recovered.workspace);
        await assertMemberReadOnly(recovered.workspace, report.baseHeadCommit, this.config.teams?.commandPrefix, signal, "integration");
        if (await teamHead(originalWorkspace, this.config.teams?.commandPrefix, signal) !== report.headCommit)
          throw new TeamError(409, "delivery-recovery-head-changed", "The original integration head changed while its fresh-base recovery copy was prepared.");
        return { workspace: recovered.workspace, originalWorkspace, baseHeadCommit: report.baseHeadCommit };
      }, result => {
        if (report.disposition === "pull-request" && run.delivery?.mode === "pr") {
          stored.deliveryAttempt = undefined;
          run.pullRequest = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl!, summary: report.summary, reportedAt: timestamp() };
          run.status = "ready-for-review"; run.reason = undefined;
          if (run.recovery) run.recovery.status = "complete";
          if (run.deliveryRecovery) run.deliveryRecovery.status = "complete";
          this.event(stored, "The delivery coordinator reported an existing pull request for the exact reviewed head. Its repository state remains agent evidence; the owner can review it on GitHub.");
          return;
        }
        if (result) {
          const previousRevision = run.revision, oldBase = run.baseCommit, oldHead = run.headCommit!;
          const originalPath = relative(stored.root ?? this.config.teams?.workspaceDir ?? dirname(result.originalWorkspace), result.originalWorkspace).slice(0, 256);
          run.continuations = [...(run.continuations ?? []), {
            revision: previousRevision, requestId: randomUUID(), at: timestamp(),
            reason: "The delivery coordinator reported no publication after the configured base moved; original implementation and review history are retained.",
            baseCommit: oldBase, headCommit: oldHead, tasks: structuredClone(run.tasks), ...(run.review ? { review: structuredClone(run.review) } : {}),
            ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
          }];
          run.workspace = result.workspace; run.baseCommit = result.baseHeadCommit; run.headCommit = result.baseHeadCommit;
          run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
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
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.config.teams?.commandPrefix, signal, "integration");
        if (report.kind === "delivery") {
          await this.enqueue(() => {
            if (this.closed) return;
            run.deliveryReceipt = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, mergeCommit: report.mergeCommit, summary: report.summary, reportedAt: timestamp() };
            this.save(stored);
          });
          await captureDeliveryBaseline(run.workspace, member.cwd, member.baseCommit, report.mergeCommit, this.config.teams?.commandPrefix, signal);
        }
      }, () => {
        if (report.kind === "delivery-repair") {
          const recovery = run.deliveryRecovery;
          const inspected = recovery?.lastEvidenceHash && run.members.some(prior => prior.role === "delivery" && prior.status === "stopped" &&
            prior.revision === run.revision && prior.report?.kind === "delivery-reconciliation" && prior.report.headCommit === report.headCommit &&
            prior.report.repository === run.delivery!.repository && prior.report.branch === run.branch &&
            deliveryInspectionHash(prior.report) === recovery.lastEvidenceHash);
          if (recovery && recovery.attempts > 0 && recovery.status !== "complete" && !inspected)
            throw new TeamError(409, "delivery-reconciliation-required", "An automatic recovery requires structured remote evidence before a delivery repair can change the reviewed head.");
          stored.deliveryAttempt = undefined;
          this.repair(stored, `Delivery requires a scoped repair before checks and independent review run again. No merge was reported.\n${report.summary}`);
        } else if (report.kind === "pull-request") {
          stored.deliveryAttempt = undefined;
          run.pullRequest = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, summary: report.summary, reportedAt: timestamp() };
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
          try { this.options?.onMerged?.(run.projectId); } catch { /* A refresh callback cannot undo a completed merge report. */ }
        }
      }, member); return;
    }
    if (report.kind === "review") {
      if (member.baseCommit !== run.headCommit || stored.checkHead !== run.headCommit) { this.block(stored, new TeamError(409, "stale-review", "The reviewer did not review the currently verified integration commit.")); return; }
      if (run.brief?.uiChanges && report.verdict === "approved" && !report.uiEvidence)
        throw new TeamError(409, "ui-review-evidence-required", "Approval of UI changes requires the reviewer's evidence from inspecting the runnable interface.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        run.review = { verdict: report.verdict, summary: report.summary, revision: run.revision, ...(report.uiEvidence ? { uiEvidence: report.uiEvidence } : {}) };
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
          }
        }
        if (report.verdict === "changes-requested") {
          for (const task of run.tasks) if (task.status === "integrated") task.reviewRounds = (task.reviewRounds ?? 0) + 1;
          this.repair(stored, report.summary);
        }
        else run.status = "reviewing";
      }, member); return;
    }
    if (report.kind !== "result") throw new TeamError(409, "wrong-agent-report", "The member did not submit an implementation result.");
    const task = run.tasks.find(item => item.id === member.taskId);
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    run.status = "integrating";
    this.operation(stored, "result", async signal => {
      const commit = await captureMemberResult(member.cwd, member.baseCommit, member.role === "implementer" ? task!.paths : run.goal?.allowedPaths, this.config.teams?.commandPrefix, signal);
      const head = commit ? await integrateMemberResult(run.workspace, member.cwd, commit, this.config.teams?.commandPrefix, signal) : run.headCommit!;
      // Diff stats are scorecard evidence only: a launcher that refuses the command must not block integration.
      const diff = commit ? await teamCommand({ command: "git", args: teamGitArgs(run.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "-z", member.baseCommit, commit, "--"]) }, run.workspace, signal, 30000, this.config.teams?.commandPrefix).catch(() => undefined) : undefined;
      return { commit, head, diff: diff?.exitCode === 0 ? diff.stdout : undefined };
    }, ({ commit, head, diff }) => {
      run.headCommit = head; stored.checkHead = undefined; run.review = undefined;
      if (member.role === "integrator" && run.deliveryRecovery?.status === "replanning" && run.deliveryRecovery.revision === run.revision)
        run.deliveryRecovery.integratedHeadCommit = head;
      if (task) { task.status = "integrated"; task.commit = commit; task.summary = report.summary; task.diffStat = diffStat(diff); }
      if (member.role === "implementer" || member.role === "integrator") this.retentionState(stored).integratedAt[member.memberId] = this.retentionNow();
      this.event(stored, `${member.title} reported a result; its validated changes were integrated.`);
      run.status = "implementing";
    }, member, "integration");
  }
  private repair(stored: Stored, feedback: string) {
    if (stored.halt || ["paused", "cancelled"].includes(stored.run.status)) return;
    if (stored.run.round >= 2) { this.block(stored, new TeamError(409, "repair-limit", repairLimitReason)); return; }
    stored.run.round++; stored.run.review = undefined; stored.checkHead = undefined;
    this.prepareMember(stored, "integrator", undefined, feedback);
  }
  /** The checks the host runs after integration: established by the plan, or configured for the project. */
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
      await this.enqueue(() => {
        if (this.closed || stored.pending?.kind !== "check" || stored.pending.revision !== revision) return;
        const root = stored.root ?? this.config.teams?.workspaceDir ?? dirname(run.workspace);
        const verificationPath = relative(root, verification.workspace).slice(0, 256);
        this.event(stored, `Configured checks are running in a disposable verification workspace: ${verificationPath}.`);
        this.save(stored);
      });
      for (const { context, ...entry } of commands) {
        const check: TeamRun["checks"][number] = { ...entry, status: "running", startedAt: timestamp(), output: "", revision, round: run.round, headCommit: head };
        await this.enqueue(() => { if (!this.closed) { run.checks.push(check); this.save(stored); } });
        const result = await teamCommand(entry.command, verification.workspace, signal, (this.config.teams?.checkMinutes ?? 60) * 60000, this.config.teams?.commandPrefix);
        Object.assign(check, { status: result.interrupted ? "interrupted" : result.exitCode === 0 ? "passed" : "failed", finishedAt: timestamp(), exitCode: result.exitCode, output: result.output });
        results.push(check);
        await this.enqueue(() => { if (!this.closed) this.save(stored); });
        if (!signal.aborted) await assertMemberReadOnly(verification.workspace, head, this.config.teams?.commandPrefix, signal, context);
        if (check.status !== "passed") break;
      }
      if (!this.closed && !signal.aborted) await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix, signal, "integration");
      return results;
    }, results => {
      if (revision !== run.revision || stored.halt || run.status === "paused" || run.status === "cancelled") return;
      if (results.length === commands.length && results.every(result => result.status === "passed")) {
        stored.checkHead = head; this.event(stored, "All configured verification commands passed against the integrated commit."); run.status = "reviewing";
      } else if (results.some(result => result.status === "interrupted")) {
        // A timeout is host evidence about the check, not the agents' work; it must not spend a correction round.
        this.block(stored, new TeamError(409, "check-timeout", checkTimeoutReason));
      } else {
        const repeated = results.find(result => result.status === "failed" && result.phase !== "setup" && run.checks.some(prior => prior !== result &&
          prior.status === "failed" && prior.revision === revision && prior.round !== undefined && prior.round < run.round &&
          prior.headCommit === head && (prior.phase ?? "verification") === (result.phase ?? "verification") &&
          prior.command.command === result.command.command && JSON.stringify(prior.command.args) === JSON.stringify(result.command.args)));
        if (repeated) this.block(stored, new TeamError(409, "repeated-check-failure", repeatedCheckFailureReason));
        else this.repair(stored, `Configured verification failed:\n${JSON.stringify(results)}`);
      }
    });
  }
}
