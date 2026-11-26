import type { TeamMember, TeamPermissionDecision, TeamPermissionRecoveryOutcome, TeamPermissionRecoveryRequest, TeamPermissionRecoveryView, TeamReport, TeamRun } from "./team-types.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Manager } from "./manager.js";
import { accountSettingPrompt, type Prompt } from "@infinite/attention";
import { ownerDirectionLines, permissionFollowUpPrompt, teamDeliveryBranch, teamPrompt, withoutRouting } from "./team-prompts.js";
import { permissionCoordinatorLaunch, teamModelLaunch } from "./launch.js";
import { assertMemberReadOnly, memberChangedPaths, prepareMemberWorkspace, TeamError } from "./team-workspace.js";
import { isCollapsedPermissionPrompt, oneShotPermissionOption, permissionAuthorityHash, permissionEvidenceHash, permissionReuseKey, refusedBeforeSend } from "./team-permissions.js";
import { collectPermissionEvidence } from "./team-permission-evidence.js";
import { activeMember, assignment, boundedRecoveryText, coordinatorPermissionPrompt, digest, livePermissionRecoveryStatuses, permissionCoordinatorDecision, permissionRequestCount, screenPermissionPrompt, timestamp } from "./team-kernel.js";
import { coordinatorRetiredReason } from "./team-permission-agent.js";
import { TeamPermissionRecovery } from "./team-permission-recovery.js";
import type { Stored } from "./teams.js";

const ownerAuthorityHash = (run: TeamRun) => permissionAuthorityHash(run.permissions, ownerDirectionLines(run));
const permissionRecoveryRoundLimit = 2;
function sameRecoveryRequest(request: TeamPermissionRecoveryRequest, target: TeamMember, prompt: Prompt, revision: number) {
  return request.revision === revision && request.targetMemberId === target.memberId && request.targetSessionId === target.sessionId &&
    request.promptId === prompt.id && request.promptHash === prompt.hash && request.evidenceHash === permissionEvidenceHash(prompt);
}

export class TeamPermissionReview extends TeamPermissionRecovery {
  async maybeStartPermissionReview(stored: Stored, target: TeamMember, observedState?: Awaited<ReturnType<Manager["state"]>>) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || target.status !== "running" || stored.halt ||
        ["paused", "cancelled", "blocked"].includes(run.status) || target.revision !== run.revision || this.agentEligible(stored)) return false;
    if (run.members.some(member => {
      if (member.memberId === target.memberId || member.revision !== run.revision || member.role !== "permission-coordinator" || !activeMember(member)) return false;
      const decision = permissionCoordinatorDecision(run, member);
      return !decision || !["answered", "escalated", "stale"].includes(decision.status);
    })) return false;
    let state;
    try { state = observedState ?? await this.host.manager.state(target.sessionId, true); } catch { return false; }
    const prompt = state.attention.prompt;
    if (prompt && accountSettingPrompt(prompt)) return false;
    const pendingExpansion = (run.permissionRecovery?.requests ?? []).filter(item => item.revision === run.revision &&
      item.targetMemberId === target.memberId && item.targetSessionId === target.sessionId && item.status === "expanding" &&
      item.expansion && ["expanded", "uncertain"].includes(item.expansion.status)).at(-1);
    if (pendingExpansion && state.control && state.control.expiresAt > Date.now()) {
      const cause = "A human control lease became active after display expansion; the request remains with its owner.";
      this.finishPermissionRecovery(stored, pendingExpansion, "interrupted", cause, "re-read-after-expansion", "owner-control-took-over",
        "The target was left untouched; no permission answer was sent.");
      this.host.event(stored, cause);
      this.host.save(stored);
      return true;
    }
    if (pendingExpansion && (state.status !== "running" || state.attention.state !== "needs-you" || !prompt))
      return this.deferExpandedPermissionRead(stored, pendingExpansion,
        "The expanded request no longer has a reviewable screen; the prompt remains unanswered.");
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
          return this.deferExpandedPermissionRead(stored, currentRecovery, reason, fresh.humanHeld);
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
          this.host.save(stored);
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
    if (!run.lineup || !run.lineup.permissionReviewer && run.lineup.coordinator.tier !== "strong" || permissionRequestCount(run) >= run.permissions.maxDecisions) return false;
    if (target.role === "permission-coordinator") return this.startPermissionCoordinatorReview(stored, target, prompt);
    if (collapsed) {
      try { this.host.assertRunPath(stored, realpathSync(target.cwd)); }
      catch { return this.startPermissionCoordinatorReview(stored, target, prompt); }
      const request = this.newPermissionRecoveryRequest(stored, target, prompt);
      request.status = "expanding";
      request.expansion = { requestId: request.id, promptId: request.promptId, promptHash: prompt.hash!, status: "intent", at: timestamp() };
      this.recordPermissionRecoveryStep(stored, request, { cause: "The provider showed a supported collapsed command dialog.", action: "expand-display",
        decision: "request-one-display-expansion", consequence: "Only Ctrl+A will be sent; no provider permission answer will be sent." });
      this.host.save(stored);
      let receipt;
      try {
        receipt = await this.host.manager.expandTeamPermission(target.sessionId, request.expansion.requestId, assignment(target), {
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
        this.host.event(stored, "The permission dialog was not expanded automatically; the prompt remains unanswered for owner review.");
        this.host.save(stored);
        return true;
      }
      request.expansion.receipt = receipt;
      request.expansion.status = receipt.state === "delivered" ? "expanded" : "uncertain";
      this.recordPermissionRecoveryStep(stored, request, { cause: "A guarded display-expansion request was sent.", action: "expand-display",
        decision: receipt.state === "delivered" ? "display-expansion-delivered" : "display-expansion-uncertain",
        consequence: "The receipt records input delivery only; provider command execution remains unknown.", receipt });
      this.host.save(stored);
      const fresh = await this.inspectPermissionRecoveryPrompt(stored, request, target, true);
      if (!("state" in fresh)) {
        const reason = fresh.reason ?? "The current target state could not be confirmed after expansion.";
        return this.deferExpandedPermissionRead(stored, request, reason, fresh.humanHeld);
      }
      if (!coordinatorPermissionPrompt(fresh.prompt)) {
        const cause = "The fresh target screen no longer contains a supported permission prompt.";
        this.finishPermissionRecovery(stored, request, "interrupted", cause, "re-read-after-expansion", "stop-review", "The prompt remains unanswered and requires owner attention.");
        this.recordPermissionRecoveryStep(stored, request, { cause, action: "re-read-after-expansion", decision: "stop-review", consequence: "No answer was sent." });
        this.host.save(stored);
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
        this.host.save(stored);
        return true;
      }
      request.status = "diagnosing";
      return this.startPermissionCoordinatorReview(stored, target, fresh.prompt, request);
    }
    if (oneShotPermissionOption(prompt) === undefined && !screenPermissionPrompt(prompt)) return false;
    let request: TeamPermissionRecoveryRequest | undefined;
    if (oneShotPermissionOption(prompt) === undefined) {
      try { this.host.assertRunPath(stored, realpathSync(target.cwd)); }
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
      this.host.save(stored);
      return false;
    };
    const reviewer = this.host.reviewerProfile(run);
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status) ||
        target.status !== "running" || target.revision !== run.revision || !run.lineup || !reviewer ||
        !run.lineup.permissionReviewer && run.lineup.coordinator.tier !== "strong" || this.agentEligible(stored))
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
    if (!evidenceOverride && (run.permissionDecisions ?? []).some(prior => !(prior.status === "stale" && !prior.authorityHash) &&
        prior.targetMemberId === target.memberId && prior.targetSessionId === target.sessionId && prior.promptId === prompt.id &&
        prior.promptHash === promptHash && prior.evidenceHash === evidenceHash)) {
      const cause = "This exact target prompt already has a coordinator decision; it will not be assigned twice.";
      if (recovery) {
        this.recordPermissionRecoveryStep(stored, recovery, { cause, action: "fresh-review", decision: "refuse-duplicate-prompt",
          consequence: "No additional coordinator was launched and no provider answer was sent." });
        this.finishPermissionRecovery(stored, recovery, "interrupted", cause, "fresh-review", "refuse-duplicate-prompt",
          "No provider answer was sent; the prior decision remains immutable.", recovery.latestDecisionId);
        this.host.save(stored);
      }
      return false;
    }
    const createDecision = (targetCwd: string, expiresAt: string): TeamPermissionDecision => ({ id: randomUUID(), revision: run.revision,
      policyHash: digest(run.permissions!), targetMemberId: target.memberId, targetSessionId: target.sessionId, targetCwd,
      promptId: prompt.id, promptHash, evidenceHash, prompt: structuredClone(prompt), option: option ?? -1, expiresAt,
      answerRequestId: randomUUID(), purpose: option === undefined ? "diagnose" : "answer",
      reviewerProfileId: reviewer.id, reviewerProfileHash: digest(reviewer), authorityHash: ownerAuthorityHash(run),
      ...(recovery ? { recoveryRequestId: recovery.id } : {}), ...(recovery?.requestedPaths ? { requestedPaths: [...recovery.requestedPaths] } : {}), status: "pending" });
    let targetCwd: string;
    try { targetCwd = realpathSync(target.cwd); this.host.assertRunPath(stored, targetCwd); }
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
    const task = target.role === "scout" ? run.discovery?.tasks.find(item => item.id === target.taskId) : run.tasks.find(item => item.id === target.taskId);
    let changedPaths: string[], permissionEvidence: ReturnType<typeof collectPermissionEvidence>;
    try {
      if (evidenceOverride) { changedPaths = evidenceOverride.changedPaths; permissionEvidence = evidenceOverride.evidence; }
      else {
        changedPaths = await memberChangedPaths(targetCwd, target.baseCommit, this.host.config.teams?.commandPrefix);
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
      const state = await this.host.manager.state(target.sessionId, true), livePrompt = state.attention.prompt;
      const metadata = this.host.manager.meta(target.sessionId).session, assigned = metadata.team;
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
      this.host.save(stored);
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
      this.host.save(stored);
      return false;
    }
    decision.workspaceEvidenceHash = workspaceEvidenceHash;
    const acceptedChecks = this.host.requiredChecks(run) ?? null;
    if (decision.purpose === "answer" && option !== undefined && !recovery && !evidenceOverride) {
      const reuseKey = permissionReuseKey({ policyHash: digest(run.permissions!), prompt, option, targetTaskId: target.taskId, changedPaths, acceptedChecks });
      decision.reuseKey = reuseKey;
      const earlier = [...(run.permissionDecisions ?? [])].reverse().find(item => {
        const sourceTarget = run.members.find(member => member.memberId === item.targetMemberId && member.sessionId === item.targetSessionId);
        return item.reuseKey === reuseKey && item.revision === run.revision && item.workspaceEvidenceHash === workspaceEvidenceHash &&
          item.purpose !== "diagnose" && !item.recoveryRequestId &&
          item.authorityHash === decision.authorityHash && item.reviewerProfileHash === decision.reviewerProfileHash &&
          item.targetCwd === decision.targetCwd && sourceTarget?.role === target.role && Boolean(item.coordinatorMemberId) &&
          (item.status === "answered" && item.verdict === "approve-once" || item.status === "escalated" && item.verdict === "escalate");
      });
      if (earlier?.status === "answered" && earlier.verdict === "approve-once") {
        decision.status = "approved";
        decision.reusedFromDecisionId = earlier.id;
        decision.reason = `Reused the recorded approve-once verdict from decision ${earlier.id}.`;
        this.host.event(stored, "An identical one-shot request was approved from the recorded review.");
        this.host.save(stored);
        await this.deliverApprovedDecision(stored, decision);
        return true;
      }
      if (earlier?.status === "escalated" && earlier.verdict === "escalate") {
        decision.reusedFromDecisionId = earlier.id;
        this.escalatePermissionDecision(stored, decision, `The identical request was already escalated by reviewer decision ${earlier.id}.`,
          "An identical request was already escalated by the reviewer; it remains with the user.");
        return false;
      }
    }
    if (!this.host.config.agents[reviewer.provider]) {
      this.escalatePermissionDecision(stored, decision, "The pinned permission reviewer provider is not configured on this host.", "The permission request remains with the user because its pinned permission reviewer provider is not configured on this host.");
      stopRecovery(decision.reason!);
      return false;
    }
    const waitingReviewer = run.members.find(member => member.revision === run.revision &&
      member.role === "permission-coordinator" && member.status === "waiting");
    const resumesExistingReviewer = Boolean(waitingReviewer?.nativeSessionId);
    try { this.host.assertBudget(run, !resumesExistingReviewer); }
    catch (error) {
      this.escalatePermissionDecision(stored, decision, error instanceof TeamError ? error.message : "The team has no remaining agent or deadline budget for a permission review.",
        "A permission request remains with the user because the team has no review budget.");
      stopRecovery(decision.reason!);
      return false;
    }
    if (reviewer.provider !== "claude") {
      this.escalatePermissionDecision(stored, decision, "The pinned permission reviewer provider is not qualified for report-only permission review.", "The permission request remains with the user because the selected permission reviewer provider is not qualified for report-only review.");
      stopRecovery(decision.reason!);
      return false;
    }
    let deliveryAuthority = null;
    if (target.role === "delivery") {
      try { this.host.assertDelivery(stored); await assertMemberReadOnly(targetCwd, run.headCommit!, this.host.config.teams?.commandPrefix); }
      catch {
        this.escalatePermissionDecision(stored, decision, "The delivery policy, reviewed head, or required checks are no longer current.", "The delivery permission request could not be matched to current delivery authority.");
        stopRecovery(decision.reason!);
        return false;
      }
      deliveryAuthority = { policy: run.delivery!, branch: teamDeliveryBranch(run), headCommit: run.headCommit!, review: run.review!,
        checks: run.checks.filter(check => check.revision === run.revision).map(({ command, status, exitCode }) => ({ command, status, exitCode })) };
    }
    const permissionRecoveryHistory = this.host.permissionRecoveryHistory(run);
    const feedbackBase = { decisionId: decision.id, recoveryRequestId: recovery?.id ?? null, reviewPurpose: decision.purpose,
      targetAssignment: assignment(target, true), targetCwd: decision.targetCwd, targetScratchDirectory: target.scratchDirectory ?? null, targetTask: task ? withoutRouting(task) : null,
      targetChangedPaths: changedPaths.slice(0, 100), targetChangedPathCount: changedPaths.length, acceptedChecks,
      permissionEvidence, deliveryAuthority, prompt: decision.prompt };
    const feedback = (history: TeamPermissionRecoveryView[]) => JSON.stringify({ ...feedbackBase, ...(history.length ? { priorPermissionRecovery: history } : {}) });
    const tooLarge = (error: unknown) => error instanceof TeamError && error.code === "team-prompt-too-large";
    const escalateTooLarge = () => {
      if (recovery) {
        const cause = "The complete evidence exceeds the permission reviewer prompt limit and cannot be reviewed without truncation.";
        decision.status = "escalated"; decision.reason = cause;
        this.queuePermissionRecoveryPm(stored, recovery, cause, decision.id);
      } else this.escalatePermissionDecision(stored, decision, "The complete evidence exceeds the 80 KiB permission reviewer prompt limit and cannot be reviewed without truncation.", "The permission request remains with the user because its complete evidence exceeds the review limit.");
    };
    const assignedEvent = decision.purpose === "diagnose"
      ? "An incomplete or unrecognized screen permission prompt was assigned for report-only diagnosis; it cannot be approved from this assignment."
      : "A screen-verified one-shot permission request was assigned to the pinned permission reviewer for read-only review.";
    if (waitingReviewer?.nativeSessionId) {
      const member = waitingReviewer;
      if (member.modelProfile) {
        decision.reviewerProfileId = member.modelProfile.id;
        decision.reviewerProfileHash = digest(member.modelProfile);
      }
      let turnPrompt: string;
      try {
        try { turnPrompt = permissionFollowUpPrompt(feedback(permissionRecoveryHistory), ownerDirectionLines(run)); }
        catch (error) {
          if (!tooLarge(error) || !permissionRecoveryHistory.length) throw error;
          turnPrompt = permissionFollowUpPrompt(feedback([]), ownerDirectionLines(run));
        }
      } catch (error) {
        if (!tooLarge(error)) throw error;
        escalateTooLarge();
        return false;
      }
      if (recovery) recovery.status = recovery.rounds ? "reviewing-evidence" : "diagnosing";
      const sessionId = randomUUID(), stopRequestId = randomUUID(), startedAt = timestamp();
      this.host.operation(stored, "member", async signal => {
        this.host.assertRunPath(stored, run.workspace);
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.prefixFor(run), signal);
      }, () => {
        member.sessionId = sessionId;
        member.stopRequestId = stopRequestId;
        member.cursor = 0;
        member.startedAt = undefined;
        member.lastActivityAt = undefined;
        member.pendingLimit = undefined;
        member.report = undefined;
        member.exitConfirmedAt = undefined;
        member.prompt = turnPrompt;
        member.pendingFeedback = feedback(permissionRecoveryHistory);
        member.continuation = { mode: "resume", nativeSessionId: member.nativeSessionId! };
        (member.turns ??= []).push({ sessionId, decisionId: decision.id, startedAt, mode: "resume" });
        member.status = "queued";
        decision.coordinatorMemberId = member.memberId;
        decision.coordinatorSessionId = sessionId;
        decision.status = "reviewing";
        if (recovery) recovery.status = recovery.rounds ? "reviewing-evidence" : "diagnosing";
        this.host.event(stored, decision.purpose === "diagnose" ? assignedEvent : "A new permission request was assigned as a turn in the existing permission review conversation.");
      }, member);
      return true;
    }
    if (waitingReviewer) waitingReviewer.status = "stopped";
    let member: TeamMember;
    try {
      member = this.host.newMember(run, "permission-coordinator", "", run.headCommit!, undefined, undefined, reviewer);
      try {
        member.prompt = teamPrompt(run, "permission-coordinator", undefined, feedback(permissionRecoveryHistory), member.provider ?? run.provider,
          member.modelProfile, undefined, permissionRecoveryHistory);
      } catch (error) {
        if (!tooLarge(error) || !permissionRecoveryHistory.length) throw error;
        member.prompt = teamPrompt(run, "permission-coordinator", undefined, feedback([]), member.provider ?? run.provider, member.modelProfile, undefined, []);
      }
    } catch (error) {
      if (!tooLarge(error)) throw error;
      escalateTooLarge();
      return false;
    }
    const nativeSessionId = randomUUID(), startedAt = timestamp();
    member.nativeSessionId = nativeSessionId;
    member.continuation = { mode: "start", nativeSessionId };
    member.pendingFeedback = feedback(permissionRecoveryHistory);
    member.turns = [{ sessionId: member.sessionId, decisionId: decision.id, startedAt, mode: "start" }];
    decision.coordinatorMemberId = member.memberId;
    decision.coordinatorSessionId = member.sessionId;
    const selectedProfile = this.host.config.agents[reviewer.provider];
    if (member.provider !== "claude" || !selectedProfile) {
      this.escalatePermissionDecision(stored, decision, "The selected permission reviewer provider is not qualified for report-only review.", "The permission request remains with the user because the selected permission reviewer provider is not qualified for report-only review.");
      stopRecovery(decision.reason!);
      return false;
    }
    try { permissionCoordinatorLaunch("claude", teamModelLaunch(selectedProfile, member.modelProfile!)); }
    catch (error) {
      decision.status = "escalated";
      decision.reason = error instanceof Error ? error.message : "The selected permission reviewer profile cannot launch in report-only mode.";
      if (recovery) {
        this.finishPermissionRecovery(stored, recovery, "interrupted", decision.reason, "fresh-review", "launch-refused", "No permission answer was sent.", decision.id);
      }
      this.host.event(stored, "The permission request remains with the user because the pinned permission reviewer profile cannot launch safely in report-only mode.");
      this.host.save(stored);
      return false;
    }
    if (recovery) {
      recovery.latestDecisionId = decision.id;
      recovery.status = recovery.rounds ? "reviewing-evidence" : "diagnosing";
    }
    this.host.save(stored);
    this.host.operation(stored, "member", async signal => {
      this.host.assertRunPath(stored, run.workspace);
      const cwd = await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.host.prefixFor(run), signal);
      await assertMemberReadOnly(cwd, member.baseCommit, this.host.prefixFor(run), signal);
      return cwd;
    }, cwd => {
      member.cwd = cwd; run.members.push(member); decision.status = "reviewing";
      if (recovery) recovery.status = recovery.rounds ? "reviewing-evidence" : "diagnosing";
      this.host.event(stored, assignedEvent);
    });
    return true;
  }
  private requestPermissionEvidence(stored: Stored, decision: TeamPermissionDecision, member: TeamMember,
    report: Extract<TeamReport, { kind: "permission-decision"; verdict: "request-evidence" }>) {
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
      this.host.save(stored);
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
      this.host.save(stored);
      member.status = "waiting";
      return;
    }
    if (this.permissionRecoveryPromptInvalidReason(stored, request, target)) {
      const reason = this.permissionRecoveryPromptInvalidReason(stored, request, target)!;
      decision.status = "escalated"; decision.reason = reason;
      this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause: reason, action: "collect-requested-evidence",
        decision: "stop-stale-review", consequence: "No new files were collected and no answer was sent." });
      this.finishPermissionRecovery(stored, request, "interrupted", reason, "collect-requested-evidence", "stop-stale-review", "The request remains with the owner.", decision.id);
      member.status = "waiting"; this.host.save(stored); return;
    }
    request.requestedPaths = requestedPaths;
    request.rounds++;
    request.status = "reviewing-evidence";
    this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action: "collect-requested-evidence",
      decision: "collect-bounded-in-scope-files", consequence: "The host will validate the same target assignment and prompt before launching a fresh review." });
    this.host.save(stored);
    this.host.operation(stored, "result", async signal => {
      await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.config.teams?.commandPrefix, signal);
      const before = await this.inspectPermissionRecoveryPrompt(stored, request, target);
      if (!("state" in before)) return { status: "interrupted" as const, reason: before.reason ?? "The target state could not be confirmed before evidence collection." };
      let changedPaths: string[], evidence: ReturnType<typeof collectPermissionEvidence>;
      try {
        changedPaths = await memberChangedPaths(request.targetCwd, target.baseCommit, this.host.config.teams?.commandPrefix, signal);
        evidence = collectPermissionEvidence({ prompt: before.prompt, cwd: request.targetCwd, changedPaths, requestedPaths,
          approvedScratchRoots: target.scratchDirectory ? [target.scratchDirectory] : [] });
      } catch (error) {
        if (signal.aborted) return { status: "interrupted" as const,
          reason: this.permissionRecoveryPromptInvalidReason(stored, request, target) ?? "The team stopped while requested evidence was being collected." };
        return { status: "exhausted" as const, reason: error instanceof Error ? error.message : "Requested evidence could not be collected safely." };
      }
      const after = await this.inspectPermissionRecoveryPrompt(stored, request, target);
      if (!("state" in after)) return { status: "interrupted" as const, reason: after.reason ?? "The target state could not be confirmed after evidence collection." };
      if (after.prompt.hash !== before.prompt.hash || permissionEvidenceHash(after.prompt) !== permissionEvidenceHash(before.prompt))
        return { status: "interrupted" as const, reason: "The target prompt changed while requested evidence was being collected." };
      if (digest({ changedPaths, evidence: evidence.digest }) === decision.workspaceEvidenceHash)
        return { status: "exhausted" as const, reason: "The requested paths did not add a different complete evidence snapshot." };
      return { status: "ready" as const, prompt: after.prompt, changedPaths, evidence };
    }, result => {
      member.status = "waiting";
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
      void this.host.enqueue(stored.run.id, async () => {
        const launched = await this.startPermissionCoordinatorReview(stored, target, result.prompt, request,
          { changedPaths: result.changedPaths, evidence: result.evidence });
        if (!launched && livePermissionRecoveryStatuses.has(request.status)) {
          const reason = "A fresh coordinator review could not be launched under the current run authority or budget.";
          this.finishPermissionRecovery(stored, request, "interrupted", reason, "fresh-review", "launch-refused", "No permission answer was sent.", decision.id);
          this.host.save(stored);
        }
      });
    }, member);
  }
  private async permissionAnswerInvalidReason(stored: Stored, decision: TeamPermissionDecision, coordinator?: TeamMember, signal?: AbortSignal) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status)) return "The team is paused, stopped, blocked, or its permission policy was revoked.";
    if (this.agentEligible(stored)) return coordinatorRetiredReason;
    if (decision.purpose === "diagnose" || decision.option < 0) return "A diagnostic permission review has no authority to answer a provider prompt.";
    if (decision.status !== "approved" || decision.revision !== run.revision || coordinator &&
        (coordinator.revision !== run.revision || decision.coordinatorMemberId !== coordinator.memberId || decision.targetMemberId === coordinator.memberId))
      return "The decision or coordinator assignment is no longer current.";
    if (decision.policyHash !== digest(run.permissions))
      return "The pinned permission policy no longer matches this decision.";
    if (!decision.authorityHash) return "This decision predates owner-authority pinning; the request remains with the user.";
    if (decision.authorityHash !== ownerAuthorityHash(run))
      return "The owner's steering or answers changed since this decision was assigned.";
    if (Date.now() >= Date.parse(decision.expiresAt)) return "The five-minute permission review window expired.";
    if (decision.reviewerProfileHash) {
      const reviewer = this.host.reviewerProfile(run);
      if (!reviewer || digest(reviewer) !== decision.reviewerProfileHash)
        return "The permission reviewer profile changed since this decision was assigned.";
    } else if (!run.lineup || run.lineup.coordinator.tier !== "strong") return "The pinned coordinator profile is no longer eligible.";
    try {
      this.host.assertBudget(run);
      const target = run.members.find(member => member.memberId === decision.targetMemberId && member.sessionId === decision.targetSessionId);
      if (!target || target.revision !== run.revision || target.status === "stopped" || !activeMember(target) || target.role === "permission-coordinator")
        return "The target member assignment is no longer active.";
      const canonicalCwd = realpathSync(target.cwd);
      if (canonicalCwd !== decision.targetCwd) return "The target working directory changed.";
      this.host.assertRunPath(stored, canonicalCwd);
      if (target.role === "delivery") {
        this.host.assertDelivery(stored);
        await assertMemberReadOnly(canonicalCwd, run.headCommit!, this.host.config.teams?.commandPrefix, signal);
      }
      if (decision.workspaceEvidenceHash) {
        const changedPaths = await memberChangedPaths(canonicalCwd, target.baseCommit, this.host.config.teams?.commandPrefix, signal);
        const evidence = collectPermissionEvidence({ prompt: decision.prompt, cwd: canonicalCwd, changedPaths, requestedPaths: decision.requestedPaths,
          approvedScratchRoots: target.scratchDirectory ? [target.scratchDirectory] : [] });
        if (decision.workspaceEvidenceHash !== digest({ changedPaths, evidence: evidence.digest }))
          return "The inspected command sources or changed paths changed during permission review. Nothing was sent.";
      }
      const metadata = this.host.manager.meta(target.sessionId).session;
      const sessionAssignment = metadata.team;
      if (!sessionAssignment || sessionAssignment.runId !== run.id || sessionAssignment.memberId !== target.memberId ||
          sessionAssignment.revision !== target.revision || sessionAssignment.role !== target.role || metadata.cwd !== canonicalCwd)
        return "The target session no longer matches its recorded assignment and working directory.";
      const state = await this.host.manager.state(target.sessionId, true);
      if (state.status !== "running" || state.control && state.control.expiresAt > Date.now()) return "The target is unavailable or a human control lease is active.";
      const prompt = state.attention.prompt;
      if (!prompt || state.attention.state !== "needs-you" || prompt.id !== decision.promptId || prompt.hash !== decision.promptHash ||
          permissionEvidenceHash(prompt) !== decision.evidenceHash || oneShotPermissionOption(prompt) !== decision.option)
        return "The target permission prompt or its one-shot option changed.";
    } catch (error) {
      if (signal?.aborted) return "The team is paused, stopped, blocked, or its permission policy was revoked.";
      return error instanceof TeamError ? error.message : "The current target session could not be verified.";
    }
    return undefined;
  }
  consumePermissionCoordinator(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    const decision = permissionCoordinatorDecision(run, member);
    if (!decision) { this.host.block(stored, new TeamError(409, "invalid-permission-decision", "The permission coordinator has no recorded decision assignment.")); return; }
    if (decision.status !== "reviewing") {
      if (member.status !== "unavailable") member.status = member.revision === run.revision && !run.permissionsRevokedAt && !stored.halt &&
        !["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status) ? "waiting" : "stopped";
      this.host.event(stored, "A late permission coordinator report was ignored because its one-shot review is no longer current.");
      this.host.save(stored);
      return;
    }
    const acceptedReport = report.kind === "permission-decision" && report.decisionId === decision.id ? report : undefined;
    if (acceptedReport?.verdict === "request-evidence") {
      this.requestPermissionEvidence(stored, decision, member, acceptedReport);
      return;
    }
    const verdict = (acceptedReport?.verdict ?? "escalate") as "approve-once" | "escalate";
    if (acceptedReport) decision.verdict = verdict;
    const summary = acceptedReport?.summary ?? (report.kind === "blocked" ? report.summary : report.kind === "question" ? report.question
      : "The coordinator did not submit the assigned permission decision report.");
    const diagnosticApproval = verdict === "approve-once" && (decision.purpose === "diagnose" || decision.option < 0);
    if (verdict === "approve-once" && !diagnosticApproval) {
      void this.deliverApprovedDecision(stored, decision, member, summary);
      return;
    }
    const reason = diagnosticApproval ? "A diagnostic permission assignment cannot approve a provider request." : summary;
    this.host.operation(stored, "result", async signal => {
      await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.config.teams?.commandPrefix, signal);
      return { status: "escalated" as const, reason };
    }, result => {
      if (["reviewing", "approved", "answering"].includes(decision.status)) { decision.status = result.status; decision.reason = result.reason ?? summary; }
      else decision.reason = "The decision changed while the answer was in flight. Inspect the target session before acting.";
      member.status = "waiting";
      this.recordPermissionReviewOutcome(stored, decision, result, summary, diagnosticApproval);
      this.host.event(stored, "The permission request remains with the user.");
    }, member);
  }
  private recordPermissionReviewOutcome(stored: Stored, decision: TeamPermissionDecision,
    result: { status: "answered" | "uncertain" | "escalated"; reason?: string; receipt?: TeamPermissionDecision["receipt"] }, summary: string, diagnosticApproval: boolean) {
    const run = stored.run;
    const request = decision.recoveryRequestId ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId) : undefined;
    if (!request) return;
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
  private async deliverApprovedDecision(stored: Stored, decision: TeamPermissionDecision, coordinator?: TeamMember, summary?: string) {
    const run = stored.run;
    this.host.operation(stored, "result", async signal => {
      if (coordinator) await assertMemberReadOnly(coordinator.cwd, coordinator.baseCommit, this.host.config.teams?.commandPrefix, signal);
      if (coordinator) {
        decision.status = "approved";
        decision.reason = summary;
        this.host.save(stored);
      }
      const reason = await this.permissionAnswerInvalidReason(stored, decision, coordinator, signal);
      if (reason) return { status: "escalated" as const, reason };
      if (decision.authorityHash !== ownerAuthorityHash(run))
        return { status: "escalated" as const, reason: "The owner's steering or answers changed while the target session was being checked." };
      if (decision.status !== "approved" || !run.permissions || run.permissionsRevokedAt || stored.halt || this.agentEligible(stored) ||
          ["paused", "cancelled", "blocked"].includes(run.status) || decision.revision !== run.revision ||
          (coordinator && decision.coordinatorMemberId !== coordinator.memberId) || decision.policyHash !== digest(run.permissions) ||
          Date.now() >= Date.parse(decision.expiresAt))
        return { status: "escalated" as const, reason: "The permission decision changed while the target session was being checked." };
      decision.status = "answering";
      stored.unfencedAnswers = [...new Set([...(stored.unfencedAnswers ?? []), decision.id])];
      if (coordinator) decision.reason = summary;
      this.host.save(stored);
      try {
        const target = run.members.find(member => member.memberId === decision.targetMemberId && member.sessionId === decision.targetSessionId);
        if (!target) return { status: "escalated" as const, reason: "The target assignment disappeared before the answer." };
        const sourceCoordinatorMemberId = decision.coordinatorMemberId
          ? undefined
          : decision.reusedFromDecisionId
            ? run.permissionDecisions?.find(item => item.id === decision.reusedFromDecisionId)?.coordinatorMemberId
            : undefined;
        if (!decision.coordinatorMemberId && !sourceCoordinatorMemberId)
          return { status: "escalated" as const, reason: "The recorded reviewer assignment for this reused approval is unavailable. The request remains with the user." };
        const receipt = await this.host.manager.answerTeamPermission(decision.targetSessionId, decision.answerRequestId,
          assignment(target), decision, () => !this.agentEligible(stored), sourceCoordinatorMemberId);
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
      if (["reviewing", "approved", "answering"].includes(decision.status)) { decision.status = result.status; decision.reason = result.reason ?? decision.reason; }
      else decision.reason = "The decision changed while the answer was in flight. Inspect the target session before acting.";
      if ("receipt" in result) decision.receipt = result.receipt;
      if (result.status !== "uncertain") this.host.settleAnswerMark(stored, decision.id);
      if (coordinator) coordinator.status = "waiting";
      this.recordPermissionReviewOutcome(stored, decision, result, summary ?? decision.reason ?? "", false);
      this.host.event(stored, result.status === "answered" ? "A one-shot permission option was delivered and the prompt closed; command execution remains unknown." : "The permission request remains with the user.");
    }, coordinator);
  }
}
