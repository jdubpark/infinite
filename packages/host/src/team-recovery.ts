import type { ConnectorSource } from "./mcp-types.js";
import { inputSourceLabel, type TeamContinuation, type TeamContinue, teamContinueSchema, type TeamDeliveryReconcile, teamDeliveryReconcileSchema, type TeamMember, type TeamReport, type TeamRun, type TeamScout, type TeamTask, teamVerificationReconcileSchema, type TeamView } from "./team-types.js";
import { includeDeliveryReviewContributors, potentialRecoveryContributorFamilies } from "./delivery-review.js";
import { randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";
import { pullRequestBranch, teamDeliveryBranch, UNREPORTED_ROLES } from "./team-prompts.js";
import type { LinearService } from "./linear.js";
import { assertMemberReadOnly, prepareRecoveredWorkspace, TeamError, teamHead } from "./team-workspace.js";
import { activeMember, automaticRecoveryLimit, commitId, deliveredAtRevision, digest, recoveriesUsed, type TeamKernel, terminalPermissionCoordinator, timestamp } from "./team-kernel.js";
import { runObjectiveNote, steerRunObjective } from "./objective-runs.js";
import type { Action, PendingOperation, Stored, VerificationMutation } from "./teams.js";

export type RecoveryHost = Pick<TeamKernel, "commands" | "config" | "save" | "event" | "record" | "enqueue" | "assertRunPath" | "assertBudget" | "block"> & {
  readonly linear: LinearService | undefined;
  readonly removingRuns: ReadonlySet<string>;
  confirmed(id: string): Promise<void>;
  replay(stored: Stored, operation: string, body: Action): boolean;
  mutation(stored: Stored, operation: string, body: Action): boolean;
  view(stored: Stored): TeamView;
  emit(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  assertDelivery(stored: Stored): void;
  prepareMember(stored: Stored, role: TeamMember["role"], task?: TeamTask | TeamScout, feedback?: string, onPrepared?: (member: TeamMember) => void): void;
  refreshOperationCensus(stored: Stored, force?: boolean): Promise<NonNullable<Stored["census"]>["state"] | undefined>;
  verificationCommands(run: TeamRun): { command: { command: string; args: string[] }; phase?: "setup" }[];
  canContinue(stored: Stored, linearStatus?: NonNullable<TeamRun["linear"]>["status"], allowRemovedWorkspace?: boolean): boolean;
  canResume(stored: Stored, linearStatus?: NonNullable<TeamRun["linear"]>["status"], allowRemovedWorkspace?: boolean): boolean;
  invalidatePermissionDecisions(stored: Stored, reason: string, fenceAgent?: boolean): Promise<boolean>;
  stopObsoletePermissionCoordinators(stored: Stored): Promise<void>;
  trackBlocked(stored: Stored): void;
  needsPublication(stored: Stored): boolean;
  startPublication(stored: Stored): boolean;
  publicationGate(stored: Stored, role: TeamMember["role"]): boolean;
};

export function roleAcceptsReport(role: TeamMember["role"], kind: NonNullable<TeamMember["report"]>["kind"]) {
  const expected: Record<TeamMember["role"], string[]> = {
    "permission-coordinator": ["permission-decision"], "project-manager": ["plan", "explore", "no-change"], scout: ["findings"],
    implementer: ["result", "escalate"], integrator: ["result"], reviewer: ["review"], delivery: ["delivery", "delivery-repair", "delivery-reconciliation", "pull-request"], "intent-checker": ["intent-check"], evaluator: ["verdict"], judge: ["judgement"],
  };
  return kind === "question" || kind === "blocked" || expected[role].includes(kind);
}
export function completedChecks(stored: Stored, revision: number) {
  const checks = stored.run.checks.filter(check => check.revision === revision);
  return checks.length > 0 && checks.every(check => (check.status === "passed" || check.status === "failed") && Boolean(check.finishedAt));
}
export function validVerificationRecovery(stored: Stored) {
  const { run, pending, verificationRecovery } = stored;
  const head = run.headCommit;
  return Boolean(pending && verificationRecovery && run.status === "blocked" && pending.kind === "check" &&
    pending.id === verificationRecovery.pendingId && verificationRecovery.pendingKind === "check" &&
    pending.revision === run.revision && verificationRecovery.revision === run.revision &&
    head && commitId.test(head) && verificationRecovery.headCommit === head && stored.checkHead !== head &&
    !stored.deliveryAttempt && !run.deliveryReceipt && !run.stopReason && completedChecks(stored, run.revision) &&
    (verificationRecovery.failure === "legacy-completed-check" || verificationRecovery.failure === "setup-changed-files" || verificationRecovery.failure === "verification-changed-files"));
}
export function obsoletePermissionResult(stored: Stored, pending: PendingOperation) {
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
export type DeliveryReconciliationReport = Extract<TeamReport, { kind: "delivery-reconciliation" }>;
export function deliveryInspectionHash(report: DeliveryReconciliationReport) {
  return digest({ headCommit: report.headCommit, repository: report.repository, branch: report.branch,
    baseHeadCommit: report.baseHeadCommit, disposition: report.disposition, remoteHeadCommit: report.remoteHeadCommit });
}
function workspaceRemovedError() {
  return new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
}
export const automaticOperationRecoveryCodes = new Set(["workspace-operation-failed", "read-only-role-changed-files", "task-scope-violation", "integration-conflict", "integration-changed-files"]);
export const interruptedOperationReason = "The host restarted during a workspace or verification operation. Inspect the isolated workspace before starting a new team; the operation will not be replayed.";
export const genericOperationFailureReason = "A team operation failed. Its workspaces and recorded evidence were preserved for inspection.";
export function recoverableOperationFailure(stored: Stored, pending: PendingOperation) {
  const { run } = stored, source = pending.source, failure = pending.failure;
  if (!source || !failure || !failure.code || !automaticOperationRecoveryCodes.has(failure.code) || pending.kind !== "result" || pending.revision !== run.revision ||
      source.role === "delivery" || source.role === "permission-coordinator" || source.headCommit !== run.headCommit ||
      stored.deliveryAttempt || run.deliveryReceipt || deliveredAtRevision(run) || run.stopReason || run.permissionsRevokedAt ||
      run.linearTracking && run.linear?.status !== "synced" || ["paused", "cancelled"].includes(run.status) || stored.halt === "pause" || stored.halt === "cancel" ||
      (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) return undefined;
  const member = run.members.find(item => item.memberId === source.memberId && item.revision === pending.revision && item.role === source.role &&
    item.cwd === source.cwd && item.baseCommit === source.baseCommit && item.report);
  return member;
}
export function recoverableUnattributedResult(stored: Stored, pending: PendingOperation) {
  const { run } = stored;
  const failureCode = pending.failure?.code ?? run.blockCode ?? (run.reason === genericOperationFailureReason ? "unattributed-result" : undefined);
  const settledLegacy = !pending.failure && run.status === "blocked" && (run.reason === genericOperationFailureReason ||
    Boolean(failureCode && automaticOperationRecoveryCodes.has(failureCode)));
  if (pending.kind !== "result" || pending.source || !failureCode ||
      !automaticOperationRecoveryCodes.has(failureCode) && failureCode !== "unattributed-result" || !pending.failure && !settledLegacy ||
      pending.revision !== run.revision || stored.deliveryAttempt || run.deliveryReceipt || deliveredAtRevision(run) ||
      run.stopReason || run.permissionsRevokedAt || run.linearTracking && run.linear?.status !== "synced" ||
      ["paused", "cancelled"].includes(run.status) || ["pause", "cancel", "steer"].includes(stored.halt ?? "") ||
      (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) return false;
  return true;
}
export function deliveryBranchMatches(run: TeamRun, branch: string) {
  const recorded = pullRequestBranch(run);
  return recorded ? branch === recorded : branch === run.branch || branch === teamDeliveryBranch(run);
}

export class TeamRecovery {
  constructor(private readonly host: RecoveryHost) {}
  reconcileDelivery(id: string, input: TeamDeliveryReconcile) {
    const body: TeamDeliveryReconcile = teamDeliveryReconcileSchema.parse(input);
    return this.host.confirmed(id).then(() => this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (this.host.replay(stored, "reconcile-delivery", body)) return this.host.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before reconciling delivery.");
      if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
      if (run.workspaceRemovedAt || this.host.removingRuns.has(id)) throw workspaceRemovedError();
      if (this.host.needsPublication(stored)) {
        this.host.startPublication(stored);
        throw new TeamError(409, "head-not-published", "The reviewed head is still being published to GitHub. Retry reconciliation after it is published.");
      }
      if (run.linearTracking || run.linear) {
        const refreshed = this.host.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
        const tracking = this.host.linear?.getTeam(run.id, true) ?? refreshed;
        if (tracking && run.linear !== tracking) { run.linear = tracking; this.host.save(stored); }
        if (!this.host.linear || tracking?.status !== "synced")
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
      if (run.status !== "blocked" || !stored.prepared || this.host.commands.has(id) || stored.halt) throw unavailable();
      if (run.goal || run.missionId || run.handoff)
        throw new TeamError(409, "delivery-reconciliation-unavailable", "Only standalone teams can reconcile a delivery attempt.");
      if (run.stopReason || run.members.length >= 60)
        throw new TeamError(409, "team-stopped-at-limit", "The team reached its execution limit and cannot retry delivery.");

      const attempt = stored.deliveryAttempt;
      const previous = attempt && run.members.find(member => member.memberId === attempt.memberId);
      const reconciliation = previous?.report?.kind === "delivery-reconciliation" ? previous.report : undefined;
      const failureCodes = new Set(["workspace-operation-failed", "invalid-workspace-baseline", "workspace-copy-changed", "delivery-baseline-source-mismatch"]);
      const recoveryAttempts = recoveriesUsed(run);
      const failedPendingEligible = Boolean(failedOperation && pending?.kind === "result" && pending.revision === run.revision &&
        pending.failure?.code && failureCodes.has(pending.failure.code) && pending.source?.role === "delivery" && pending.source.workspace === "member" &&
        pending.source.memberId === previous?.memberId && pending.source.memberId === attempt?.memberId && pending.source.cwd === previous?.cwd &&
        pending.source.baseCommit === run.headCommit && pending.source.headCommit === run.headCommit && previous?.report?.kind === "delivery-reconciliation" &&
        previous.report.disposition === "no-publication" && previous.report.repository === run.delivery?.repository &&
        deliveryBranchMatches(run, previous.report.branch) && previous.report.headCommit === run.headCommit && previous.report.remoteHeadCommit === undefined &&
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
        reconciliation.repository === run.delivery?.repository && deliveryBranchMatches(run, reconciliation.branch) && reconciliation.headCommit === run.headCommit);
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

      this.host.assertBudget(run, true);
      this.host.assertDelivery(stored);
      const head = run.headCommit;
      this.host.assertRunPath(stored, run.workspace);
      this.host.assertRunPath(stored, previous.cwd);
      if (await teamHead(run.workspace, this.host.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "delivery-reconciliation-head-changed", "The integration workspace no longer matches the reviewed delivery head.");
      await assertMemberReadOnly(run.workspace, head, this.host.config.teams?.commandPrefix, undefined, "integration");
      await assertMemberReadOnly(previous.cwd, head, this.host.config.teams?.commandPrefix);

      const priorRun = structuredClone(run);
      if (!this.host.mutation(stored, "reconcile-delivery", body)) return this.host.view(stored);
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
        `Prior delivery member: ${previous.memberId}; prior revision: ${previous.revision}; pinned head: ${priorAttempt.headCommit}; branch: ${teamDeliveryBranch(run)}.`,
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
        this.host.event(stored, `Owner authorized a fresh delivery reconciliation at ${head} on ${teamDeliveryBranch(run)}; prior attempt ${previous.memberId} and its delivery report remain in team history.${failedReceipt ? ` Failed operation ${failedReceipt.pendingId} (${failedReceipt.failure.code}, ${failedReceipt.failure.at}) was preserved. Operator claim, not host-verified: ${JSON.stringify(failedReceipt.attestation.text.slice(0, 500))}` : ""}`);
        this.host.prepareMember(stored, "delivery", undefined, feedback, member => {
          stored.deliveryAttempt = { memberId: member.memberId, revision: member.revision, headCommit: head };
          run.deliveryRecovery = { attempts: recoveryAttempts, status: "planning", revision: run.revision, headCommit: head,
            policyHash: digest(run.delivery!), sourceMemberId: member.memberId };
          run.recovery = { attempts: recoveryAttempts, status: "planning", source: { code: "delivery-recovery", memberId: previous.memberId,
            revision: previous.revision, reportKind: previous.report!.kind, reason: body.text, at: timestamp() } };
          run.reason = undefined; run.blockCode = undefined;
        });
      } catch (error) {
        this.host.commands.get(id)?.abort(); this.host.commands.delete(id);
        stored.pending = pending;
        stored.run = priorRun;
        stored.deliveryAttempt = priorAttempt;
        delete stored.receipts[body.requestId];
        this.host.save(stored);
        throw error;
      }
      return this.host.view(stored);
    }));
  }
  reconcileVerification(id: string, input: VerificationMutation) {
    const body = teamVerificationReconcileSchema.parse(input);
    return this.host.confirmed(id).then(() => this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (this.host.replay(stored, "reconcile-verification", body)) return this.host.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before reconciling verification.");
      if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
      if (run.workspaceRemovedAt || this.host.removingRuns.has(id)) throw workspaceRemovedError();
      if (run.linearTracking || run.linear) {
        const refreshed = this.host.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
        const tracking = this.host.linear?.getTeam(run.id, true) ?? refreshed;
        if (tracking && run.linear !== tracking) { run.linear = tracking; this.host.save(stored); }
        if (!this.host.linear || tracking?.status !== "synced") throw new TeamError(409, "linear-reconciliation-required", "Linear has not confirmed the current issue and requirements. Refresh tracking before reconciling verification.");
      }
      const unavailable = (message: string) => new TeamError(409, "verification-reconciliation-unavailable", message);
      const pending = stored.pending;
      if (run.status !== "blocked" || stored.halt || !stored.prepared || run.reason !== interruptedOperationReason)
        throw unavailable("Verification reconciliation requires a prepared blocked team with restart-interruption evidence and no active halt.");
      if (!pending || pending.kind !== "check" || pending.failure || pending.revision !== run.revision)
        throw unavailable("Only an unresolved restart-interrupted check can be reconciled; other uncertain operations remain fenced.");
      if (pending.id !== body.pendingId) throw new TeamError(409, "verification-reconciliation-operation-changed", "The pending check changed. Refresh the team and inspect its evidence.");
      if (this.host.commands.has(id) || stored.deliveryAttempt || run.deliveryReceipt || deliveredAtRevision(run) || run.stopReason || run.permissionsRevokedAt ||
          run.members.some(member => member.status !== "stopped") ||
          (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status)))
        throw unavailable("Members, permission decisions, delivery state, or the operation are not fully quiescent for verification reconciliation.");
      if (pending.witness) {
        const seen = await this.host.refreshOperationCensus(stored, true);
        if (seen === "running") throw new TeamError(409, "team-operation-running", `The host still sees ${stored.census?.recorded} process(es) that match its record of the interrupted check. Reconcile verification after they have exited.`);
        if (seen === "in-use") throw new TeamError(409, "team-directory-in-use", `The host sees ${stored.census?.using} process(es) using this run's directory. Reconcile verification after they have exited or left it.`);
      }
      const head = run.headCommit;
      if (!head || !commitId.test(head) || body.headCommit !== head || stored.checkHead === head)
        throw new TeamError(409, "verification-reconciliation-head-changed", "The requested head is not the current unchecked integration commit.");
      const attempt = run.checks.filter(check => check.revision === run.revision && check.round === run.round && check.headCommit === head);
      if (!attempt.length || attempt.at(-1)?.status !== "interrupted" || attempt.slice(0, -1).some(check => check.status !== "passed") ||
          run.checks.some(check => check.status === "running"))
        throw unavailable("The retained check records do not prove a single interrupted final check attempt.");
      const expected = this.host.verificationCommands(run);
      if (attempt.length > expected.length || attempt.some((check, index) => check.command.command !== expected[index]?.command.command ||
          JSON.stringify(check.command.args ?? []) !== JSON.stringify(expected[index]?.command.args ?? []) || (check.phase ?? "verification") !== (expected[index]?.phase ?? "verification")))
        throw new TeamError(409, "verification-policy-changed", "The retained check commands do not match the current verification policy.");
      this.host.assertBudget(run);
      this.host.assertRunPath(stored, run.workspace);
      if (await teamHead(run.workspace, this.host.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "verification-reconciliation-head-changed", "The integration workspace no longer matches the recorded commit.");
      await assertMemberReadOnly(run.workspace, head, this.host.config.teams?.commandPrefix, undefined, "integration");
      if (!this.host.mutation(stored, "reconcile-verification", body)) return this.host.view(stored);
      run.verificationReconciliations ??= [];
      run.verificationReconciliations.push({ requestId: body.requestId, pendingId: pending.id, revision: run.revision, round: run.round, headCommit: head,
        interruptedChecks: attempt.filter(check => check.status === "interrupted").length, attestation: body.attestation.text, at: timestamp() });
      stored.pending = undefined;
      delete stored.verificationRecovery;
      run.status = "verifying"; run.reason = undefined; run.blockCode = undefined;
      this.host.event(stored, `An operator attested that processes for the interrupted check had stopped. The ${head} integration and earlier evidence are retained; fresh verification will use a new disposable workspace. Operator claim, not host-verified: ${JSON.stringify(body.attestation.text.slice(0, 500))}`);
      this.host.save(stored);
      return this.host.view(stored);
    }));
  }
  continueRun(id: string, input: TeamContinue) {
    const body = teamContinueSchema.parse(input);
    return this.host.confirmed(id).then(() => this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (this.host.replay(stored, "continue", body)) return this.host.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
      if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");

      if (run.linearTracking || run.linear) {
        const refreshed = this.host.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
        const tracking = this.host.linear?.getTeam(run.id, true) ?? refreshed;
        if (tracking && run.linear !== tracking) { run.linear = tracking; this.host.save(stored); }
        if (!this.host.linear || tracking?.status !== "synced")
          throw new TeamError(409, "linear-reconciliation-required", "Linear has not confirmed the current issue and requirements. Refresh tracking before continuing this run.");
      }
      if (run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (!this.host.canContinue(stored, run.linear?.status, true))
        throw new TeamError(409, "team-continuation-unavailable", "This blocked run has unresolved work, an uncertain side effect, or no safely continuable standalone revision.");
      this.host.assertBudget(run, true);

      const head = run.headCommit;
      if (!head || !commitId.test(head)) throw new TeamError(409, "team-continuation-head-unavailable", "The run has no valid recorded integration commit to continue from.");
      this.host.assertRunPath(stored, run.workspace);
      await assertMemberReadOnly(run.workspace, head, this.host.config.teams?.commandPrefix, undefined, "integration");
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
      if (!this.host.mutation(next, "continue", body)) return this.host.view(stored);
      const nextRevision = next.run.revision + 1;
      for (const member of next.run.members) if (member.revision === next.run.revision &&
          member.role === "permission-coordinator" && member.status === "waiting") member.status = "stopped";
      next.run.continuations = [...(next.run.continuations ?? []), continuation];
      next.run.revision = nextRevision;
      this.host.emit(next, "run.revision-advanced", [nextRevision], {}, { cause: "continue", fromRevision: nextRevision - 1, baseChanged: false });
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
      if (body.text) { const objectiveNote = runObjectiveNote(next, steerRunObjective(next, body.requestId, timestamp())); if (objectiveNote) this.host.event(next, objectiveNote); }
      next.run.status = "planning";
      next.halt = undefined;
      next.continuationHead = { revision: nextRevision, headCommit: head };
      this.host.event(next, `Owner continued the run from its clean integration commit at revision ${nextRevision}. Prior tasks, checks, member records, permissions, and review evidence remain available in the run history.`);
      this.host.save(next);
      Object.assign(stored, next);
      if (!("objectiveNotice" in next)) delete stored.objectiveNotice;
      return this.host.view(stored);
    }));
  }
  async resumeVerificationRecovery(stored: Stored, body: Action & { source?: ConnectorSource }, recovery: NonNullable<Stored["verificationRecovery"]>) {
    const run = stored.run;
    if (!this.host.canResume(stored) || this.host.commands.has(run.id))
      throw new TeamError(409, "team-reconciliation-required", "This verification failure is no longer eligible for Resume. Inspect the retained workspace and evidence.");
    if (stored.halt) throw new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
    if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
    if (run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
    this.host.assertBudget(run);

    const prefix = this.host.config.teams?.commandPrefix;
    const originalWorkspace = run.workspace;
    this.host.assertRunPath(stored, originalWorkspace);
    const head = await teamHead(originalWorkspace, prefix);
    if (head !== recovery.headCommit)
      throw new TeamError(409, "verification-recovery-head-changed", "The integration HEAD changed after the verification failure. Its original workspace was preserved for reconciliation.");
    const recovered = await prepareRecoveredWorkspace(originalWorkspace, randomUUID(), recovery.headCommit, prefix, undefined, run.branch);
    this.host.assertRunPath(stored, recovered.workspace);
    await assertMemberReadOnly(recovered.workspace, recovery.headCommit, prefix, undefined, "integration");
    if (await teamHead(originalWorkspace, prefix) !== recovery.headCommit)
      throw new TeamError(409, "verification-recovery-head-changed", "The integration HEAD changed while Resume prepared a clean copy. Its original workspace was preserved for reconciliation.");

    await this.host.invalidatePermissionDecisions(stored, "A resume started before the permission request could be answered.");
    const next = structuredClone(stored);
    if (!this.host.mutation(next, "resume", body)) return this.host.view(stored);
    next.run.workspace = recovered.workspace;
    next.pending = undefined;
    next.verificationRecovery = undefined;
    next.halt = undefined;
    next.run.revision++; next.run.tasks = []; next.run.review = undefined; next.run.round = 0; next.checkHead = undefined;
    this.host.emit(next, "run.revision-advanced", [next.run.revision], {}, { cause: "verification-recovery", fromRevision: next.run.revision - 1, baseChanged: false });
    next.run.brief = undefined; next.run.noChange = undefined;
    if (next.run.discovery && !next.run.discovery.completedAt) next.run.discovery.completedAt = timestamp();
    next.run.status = "planning"; next.run.reason = undefined; next.run.blockCode = undefined;
    const workspaceRoot = stored.root ?? this.host.config.teams?.workspaceDir ?? dirname(originalWorkspace);
    const originalPath = relative(workspaceRoot, originalWorkspace).slice(0, 256);
    const recoveredPath = relative(workspaceRoot, recovered.workspace).slice(0, 256);
    this.host.event(next, `The team resumed${body.source ? ` by ${inputSourceLabel(body.source)}` : ""} from a clean workspace at the recorded integration commit. Original integration copy preserved at ${originalPath}; fresh workspace at ${recoveredPath}. Prior member and check evidence remains available under its original revision.`);
    this.host.save(next);
    Object.assign(stored, next);
    return this.host.view(stored);
  }
  queueAutomaticDeliveryRecovery(stored: Stored, member: TeamMember, reason: string) {
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
    try { this.host.assertDelivery(stored); } catch { return false; }
    const prior = run.deliveryRecovery;
    const failureHash = digest({ headCommit: run.headCommit, policyHash, reason });
    const attempts = recoveriesUsed(run);
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
    this.host.commands.get(run.id)?.abort();
    this.host.event(stored, `The strong coordinator will inspect the exact remote branch and pull request before another delivery attempt (${attempts + 1} of ${automaticRecoveryLimit}).`);
    this.host.save(stored);
    return true;
  }
  admitBlockedDeliveryRecovery(stored: Stored) {
    const { run } = stored, attempt = stored.deliveryAttempt;
    if (run.status !== "blocked" || stored.pending || this.host.commands.has(run.id) || !attempt ||
        run.recovery?.status === "exhausted" || run.deliveryRecovery?.status === "exhausted") return;
    const member = run.members.find(item => item.memberId === attempt.memberId && item.revision === attempt.revision);
    if (member?.status === "stopped" && member.report?.kind === "blocked")
      this.queueAutomaticDeliveryRecovery(stored, member, member.report.summary);
  }
  private async startAutomaticDeliveryRecovery(stored: Stored, trackingReady: boolean) {
    const { run } = stored, recovery = run.recovery, delivery = run.deliveryRecovery;
    if (recovery?.status === "stopping" && delivery?.status === "stopping" && stored.pending?.kind === "member" &&
        !stored.pending.failure && this.host.commands.has(run.id)) return true;
    if (this.host.publicationGate(stored, "delivery")) return true;
    const attempt = stored.deliveryAttempt;
    const previous = attempt && run.members.find(member => member.memberId === attempt.memberId);
    if (!recovery || !delivery || !attempt || !previous || previous.role !== "delivery" || previous.report?.kind !== "blocked" ||
        delivery.status !== "stopping" || delivery.revision !== run.revision || delivery.headCommit !== run.headCommit ||
        delivery.policyHash !== digest(run.delivery ?? null) || attempt.revision !== run.revision || attempt.headCommit !== run.headCommit ||
        attempt.memberId !== previous.memberId || !trackingReady || stored.pending || this.host.commands.has(run.id) || run.deliveryReceipt || run.pullRequest ||
        run.stopReason || run.permissionsRevokedAt || run.linearTracking && run.linear?.status !== "synced" ||
        run.members.some(member => member.revision === recovery.source.revision && activeMember(member) && !terminalPermissionCoordinator(run, member)) ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) {
      this.host.block(stored, new TeamError(409, "delivery-reconciliation-required", "Automatic delivery recovery could not establish the same reviewed head, policy, stopped members, and permissions. Inspect retained delivery evidence."));
      return true;
    }
    try {
      this.host.assertBudget(run, true);
      this.host.assertDelivery(stored);
      this.host.assertRunPath(stored, run.workspace);
      const head = run.headCommit;
      if (!head || await teamHead(run.workspace, this.host.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "delivery-recovery-head-changed", "The integration HEAD changed before delivery inspection.");
      await assertMemberReadOnly(run.workspace, head, this.host.config.teams?.commandPrefix, undefined, "integration");
      const feedback = [
        `Automatic delivery reconciliation ${delivery.attempts} of ${automaticRecoveryLimit} under the unchanged owner policy.`,
        `Prior delivery attempt ${previous.memberId} reported blocked at revision ${previous.revision}, head ${head}. Its full report remains in team history: ${JSON.stringify(previous.report)}`,
        `Before any write or publication, inspect the exact remote repository ${run.delivery!.repository}, branch ${teamDeliveryBranch(run)}, base ${run.delivery!.baseBranch}, and any pull request for this head. Reuse existing matching work and never create a duplicate PR.`,
        `If no publication exists, report the structured delivery-reconciliation disposition with exact repository, branch, reviewed head, and current base head. A moved base with no publication may return to implementation for a fresh review. An owned branch or open PR must keep its exact remote head; do not rewrite or force-push it.`,
        `If the same capability is still missing, report blocked. Do not switch tools, credentials, or routes, or request broader permissions.`,
      ].join("\n\n");
      this.host.prepareMember(stored, "delivery", undefined, feedback, member => {
        stored.deliveryAttempt = { memberId: member.memberId, revision: member.revision, headCommit: head };
        delivery.status = "planning"; delivery.sourceMemberId = member.memberId;
        recovery.status = "planning";
        run.reason = undefined; run.blockCode = undefined;
        this.host.event(stored, `A fresh strong-coordinator delivery inspection is queued for the same reviewed head ${head}; the previous blocked attempt remains in history.`);
      });
      run.status = "planning";
      this.host.save(stored);
    } catch (error) {
      this.host.block(stored, error);
    }
    return true;
  }
  async startAutomaticRecovery(stored: Stored, trackingReady: boolean) {
    const { run } = stored, recovery = run.recovery;
    if (!recovery || recovery.status !== "stopping" || run.status !== "planning" || stored.halt) return false;
    if (recovery.source.code === "delivery-recovery") return this.startAutomaticDeliveryRecovery(stored, trackingReady);
    const operationPending = Boolean(stored.pending && (recoverableOperationFailure(stored, stored.pending) || recoverableUnattributedResult(stored, stored.pending)) &&
      stored.pending.revision === recovery.source.revision && (recovery.source.memberId === "unattributed" || recovery.source.memberId === stored.pending.source?.memberId));
    if (!trackingReady || stored.pending && !operationPending || stored.deliveryAttempt || run.deliveryReceipt || deliveredAtRevision(run) || run.stopReason ||
        run.permissionsRevokedAt ||
        run.linearTracking && run.linear?.status !== "synced" ||
        run.members.some(member => member.revision === recovery.source.revision && activeMember(member) && !terminalPermissionCoordinator(run, member)) ||
        (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) {
      this.host.block(stored, new TeamError(409, "recovery-reconciliation-required", "The automatic recovery could not establish safe, authorized continuation. Inspect retained evidence and continue manually."));
      return true;
    }
    try {
      this.host.assertBudget(run);
      const head = run.headCommit;
      if (!head || !commitId.test(head) || await teamHead(run.workspace, this.host.config.teams?.commandPrefix) !== head)
        throw new TeamError(409, "recovery-head-changed", "The integration HEAD changed before automatic recovery. Inspect the retained workspace before continuing.");
      this.host.assertRunPath(stored, run.workspace);
      await this.host.stopObsoletePermissionCoordinators(stored);
      if (run.members.some(member => member.revision === recovery.source.revision &&
          member.role === "permission-coordinator" && activeMember(member) && !terminalPermissionCoordinator(run, member))) {
        this.host.block(stored, new TeamError(409, "recovery-reviewer-stop-unconfirmed", "Automatic recovery could not confirm that the prior permission reviewer stopped."));
        return true;
      }
      for (const member of run.members) if (member.revision === recovery.source.revision &&
          member.role === "permission-coordinator" && member.status === "waiting") member.status = "stopped";
      const originalWorkspace = run.workspace;
      let preservedWorkspace: string | undefined;
      try { await assertMemberReadOnly(originalWorkspace, head, this.host.config.teams?.commandPrefix, undefined, "integration"); }
      catch (error) {
        if (!operationPending) throw error;
        const clean = await prepareRecoveredWorkspace(originalWorkspace, randomUUID(), head, this.host.config.teams?.commandPrefix, undefined, run.branch);
        this.host.assertRunPath(stored, clean.workspace);
        await assertMemberReadOnly(clean.workspace, head, this.host.config.teams?.commandPrefix, undefined, "integration");
        if (await teamHead(originalWorkspace, this.host.config.teams?.commandPrefix) !== head)
          throw new TeamError(409, "recovery-head-changed", "The original integration HEAD changed while a clean recovery copy was prepared.");
        run.workspace = clean.workspace;
        preservedWorkspace = originalWorkspace;
      }
      const source = recovery.source;
      const preservedCopy = preservedWorkspace
        ? `The original integration workspace is preserved at ${preservedWorkspace}. Inspect its exact state and retained diff read-only against ${head}; its dirty or conflicted edits were not imported into the clean recovery workspace. Carry only approved work forward through a new assignment.`
        : "The integration workspace matched the recorded head and was clean.";
      const retainedMemberWorkspaces = run.members.filter(member => member.revision === source.revision && !UNREPORTED_ROLES.has(member.role)).slice(0, 60)
        .map(member => `${member.memberId} (${member.role}${member.taskId ? `, task ${member.taskId}` : ""}; ${member.status}; base ${member.baseCommit}): ${member.cwd}`);
      const memberCopies = retainedMemberWorkspaces.length
        ? `Retained member workspaces for affected revision ${source.revision} are listed below. Inspect them read-only at their recorded base commits; preserve the original copies and use a new assignment to carry only approved work forward.\n${retainedMemberWorkspaces.join("\n")}`
        : "No non-permission member workspace was recorded for the affected revision.";
      const feedback = `Automatic PM recovery ${recovery.attempts} of ${automaticRecoveryLimit}. Diagnose and resolve the reported ${source.code} from member ${source.memberId} at revision ${source.revision}. The original report and every sibling report remain in team history. ${preservedCopy} ${memberCopies} Replan only within the existing objective, pinned verification, permissions, and parent scope. Do not bypass a provider denial or infer owner approval; ask the owner if a material decision is needed. Source evidence: ${source.reason}`;
      stored.deliveryReviewLineage = includeDeliveryReviewContributors(stored.deliveryReviewLineage, head,
        potentialRecoveryContributorFamilies(run, source.revision));
      const nextRevision = run.revision + 1;
      run.continuations = [...(run.continuations ?? []), {
        revision: run.revision, requestId: randomUUID(), at: timestamp(), reason: `Automatic PM recovery after ${source.code}: ${source.reason}`,
        headCommit: head, tasks: structuredClone(run.tasks), ...(run.review ? { review: structuredClone(run.review) } : {}),
        ...(run.brief ? { brief: structuredClone(run.brief) } : {}),
      }];
      run.revision = nextRevision;
      this.host.emit(stored, "run.revision-advanced", [nextRevision], {}, { cause: "automatic-recovery", fromRevision: nextRevision - 1, baseChanged: false, sourceCode: source.code, sourceMemberId: source.memberId === "unattributed" ? undefined : source.memberId });
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
      this.host.event(stored, `The project manager is starting bounded recovery attempt ${recovery.attempts} from the clean integration head.`);
      this.host.prepareMember(stored, "project-manager", undefined, feedback);
    } catch (error) {
      this.host.block(stored, error);
    }
    return true;
  }
  queueDeliveryRetryAfterEvidence(stored: Stored, member: TeamMember, report: DeliveryReconciliationReport) {
    const { run } = stored, policyHash = digest(run.delivery ?? null), prior = run.deliveryRecovery;
    const evidenceHash = deliveryInspectionHash(report);
    const attempts = recoveriesUsed(run);
    if (attempts >= automaticRecoveryLimit || prior?.lastEvidenceHash === evidenceHash) {
      run.deliveryRecovery = { attempts, status: "exhausted", revision: run.revision, headCommit: report.headCommit, policyHash,
        sourceMemberId: member.memberId, lastEvidenceHash: evidenceHash, baseHeadCommit: report.baseHeadCommit, disposition: report.disposition };
      run.recovery = { attempts, status: "exhausted", source: { code: "delivery-recovery", memberId: member.memberId, revision: member.revision,
        reportKind: report.kind, reason: "The same no-publication or owned-branch evidence repeated without progress.", at: timestamp() } };
      run.status = "blocked"; run.blockCode = "delivery-reconciliation-required";
      run.reason = "Delivery inspection found no new remote evidence after the bounded recovery attempts. Review the retained reports before continuing.";
      stored.halt = "block";
      this.host.event(stored, "Automatic delivery recovery stopped after repeated unchanged remote evidence; no publication was inferred or repeated.");
      this.host.save(stored); this.host.trackBlocked(stored); return;
    }
    this.host.assertBudget(run, true);
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
    this.host.prepareMember(stored, "delivery", undefined, feedback, next => {
      stored.deliveryAttempt = { memberId: next.memberId, revision: next.revision, headCommit: report.headCommit };
      run.deliveryRecovery!.sourceMemberId = next.memberId;
      run.reason = undefined; run.blockCode = undefined;
      this.host.event(stored, `A bounded delivery retry is queued for the unchanged reviewed head ${report.headCommit}; it must inspect remote state again.`);
    });
    run.status = "planning";
    this.host.save(stored);
  }
}
