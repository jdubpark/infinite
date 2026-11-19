import type { TeamMember, TeamPermissionDecision, TeamPermissionRecoveryOutcome, TeamPermissionRecoveryRequest, TeamPermissionRecoveryStep } from "./team-types.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Manager } from "./manager.js";
import type { Prompt } from "@infinite/attention";
import { TeamError } from "./team-workspace.js";
import { isCollapsedPermissionPrompt, permissionEvidenceHash } from "./team-permissions.js";
import { activeMember, automaticRecoveryLimit, boundedRecoveryText, coordinatorPermissionPrompt, digest, livePermissionRecoveryStatuses, permissionPromptKey, timestamp } from "./team-kernel.js";
import { coordinatorRetiredReason, TeamPermissionAgent } from "./team-permission-agent.js";
import type { Stored } from "./teams.js";

const permissionRecoveryStepLimit = 100;
const permissionRecoveryOutcomeLimit = 100;

/**
 * The coordinator review's bounded recovery of a provider request: display expansion, diagnosis steps and outcomes,
 * and the project-manager correction. Moved from TeamService unchanged. It builds on the permission agent, which
 * retires coordinator recovery once it serves the run.
 */
export class TeamPermissionRecovery extends TeamPermissionAgent {
  private readonly permissionPromptFirstSeen = new Map<string, number>();
  finishLinkedPermissionRecovery(stored: Stored, decision: TeamPermissionDecision, cause: string, action: string, outcome: string, consequence: string) {
    const request = decision.recoveryRequestId
      ? stored.run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId)
      : undefined;
    if (!request || !livePermissionRecoveryStatuses.has(request.status)) return;
    this.recordPermissionRecoveryStep(stored, request, { decisionId: decision.id, cause, action, decision: outcome, consequence });
    this.finishPermissionRecovery(stored, request, "interrupted", cause, action, outcome, consequence, decision.id);
  }
  advanceExpandedPermissionPrompt(stored: Stored, request: TeamPermissionRecoveryRequest, target: TeamMember, prompt: Prompt) {
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
    this.host.save(stored);
    return true;
  }
  protected sameCollapsedExpansionPrompt(request: TeamPermissionRecoveryRequest, prompt: Prompt) {
    return Boolean(request.expansion && isCollapsedPermissionPrompt(prompt) && prompt.id === request.expansion.promptId &&
      prompt.hash === request.expansion.promptHash && permissionEvidenceHash(prompt) === request.evidenceHash);
  }
  protected deferExpandedPermissionRead(stored: Stored, request: TeamPermissionRecoveryRequest, reason: string, humanHeld = false) {
    if (humanHeld) {
      const cause = "A human control lease became active after display expansion; the request remains with its owner.";
      this.finishPermissionRecovery(stored, request, "interrupted", cause, "re-read-after-expansion", "owner-control-took-over",
        "The target was left untouched; no permission answer was sent.");
      this.host.event(stored, cause);
      this.host.save(stored);
      return true;
    }
    const expansion = request.expansion!;
    expansion.rereads = (expansion.rereads ?? 0) + 1;
    if (expansion.rereads < 3) {
      this.recordPermissionRecoveryStep(stored, request, { cause: reason, action: "re-read-after-expansion", decision: "wait-for-screen-settle",
        consequence: `The display state will be checked again without sending another key (${expansion.rereads}/3).` });
      this.host.save(stored);
      return true;
    }
    const cause = "The provider display did not settle into a reviewable permission screen after the bounded rereads. " + boundedRecoveryText(reason);
    this.queuePermissionRecoveryPm(stored, request, cause);
    this.host.save(stored);
    return true;
  }
  protected stableDiagnosticPrompt(target: TeamMember, prompt: Prompt) {
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
  protected escalatePermissionDecision(stored: Stored, decision: TeamPermissionDecision, reason: string, event: string) {
    decision.status = "escalated";
    decision.reason = reason;
    this.finishLinkedPermissionRecovery(stored, decision, reason, "coordinator-review", "review-escalated",
      "No provider answer was sent; the request remains available for owner review.");
    this.host.event(stored, event);
    this.host.save(stored);
  }
  recordPermissionRecoveryStep(stored: Stored, request: TeamPermissionRecoveryRequest, step: Omit<TeamPermissionRecoveryStep, "id" | "requestId" | "at" | "execution"> & { at?: string }) {
    const state = stored.run.permissionRecovery ??= { requests: [], steps: [], outcomes: [] };
    state.steps.push({ id: randomUUID(), requestId: request.id, ...(step.decisionId ? { decisionId: step.decisionId } : {}),
      at: step.at ?? timestamp(), cause: boundedRecoveryText(step.cause), action: boundedRecoveryText(step.action),
      decision: boundedRecoveryText(step.decision), consequence: boundedRecoveryText(step.consequence), execution: "unknown",
      ...(step.receipt ? { receipt: structuredClone(step.receipt) } : {}) });
    if (state.steps.length > permissionRecoveryStepLimit) state.steps.splice(0, state.steps.length - permissionRecoveryStepLimit);
  }
  finishPermissionRecovery(stored: Stored, request: TeamPermissionRecoveryRequest, status: TeamPermissionRecoveryOutcome["status"], cause: string, action: string,
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
  protected permissionRecoveryPromptInvalidReason(stored: Stored, request: TeamPermissionRecoveryRequest, target: TeamMember) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status))
      return "The run is paused, stopped, blocked, or its permission policy was revoked.";
    if (this.agentEligible(stored)) return coordinatorRetiredReason;
    if (request.revision !== run.revision || request.targetMemberId !== target.memberId || request.targetSessionId !== target.sessionId ||
        target.revision !== run.revision || target.role === "permission-coordinator" || !activeMember(target))
      return "The target member assignment is no longer current.";
    if (request.policyHash !== digest(run.permissions) || Date.now() >= Date.parse(request.expiresAt))
      return "The pinned permission policy changed or the five-minute recovery window expired.";
    try {
      const canonicalCwd = realpathSync(target.cwd);
      if (canonicalCwd !== request.targetCwd) return "The target working directory changed.";
      this.host.assertRunPath(stored, canonicalCwd);
      const metadata = this.host.manager.meta(target.sessionId).session;
      const assigned = metadata.team;
      if (!assigned || assigned.runId !== run.id || assigned.memberId !== target.memberId || assigned.revision !== target.revision ||
          assigned.role !== target.role || metadata.cwd !== canonicalCwd) return "The target session no longer matches its recorded assignment and working directory.";
    } catch (error) { return error instanceof TeamError ? error.message : "The target workspace or session could not be verified."; }
    return undefined;
  }
  protected async inspectPermissionRecoveryPrompt(stored: Stored, request: TeamPermissionRecoveryRequest, target: TeamMember, allowPromptRefresh = false):
    Promise<{ state: Awaited<ReturnType<Manager["state"]>>; prompt: Prompt } | { reason: string; humanHeld?: boolean }> {
    const invalid = this.permissionRecoveryPromptInvalidReason(stored, request, target);
    if (invalid) return { reason: invalid } as const;
    try {
      const state = await this.host.manager.state(target.sessionId, true);
      if (state.control && state.control.expiresAt > Date.now())
        return { reason: "The target has an active human control lease.", humanHeld: true } as const;
      if (state.status !== "running" || state.attention.state !== "needs-you")
        return { reason: "The target is unavailable or no longer waiting on this request." } as const;
      const prompt = state.attention.prompt;
      if (!prompt || !allowPromptRefresh && prompt.id !== request.promptId || !prompt.hash ||
          !allowPromptRefresh && (prompt.hash !== request.promptHash || permissionEvidenceHash(prompt) !== request.evidenceHash))
        return { reason: "The current permission prompt changed during recovery." } as const;
      return { state, prompt } as const;
    } catch { return { reason: "The current target session could not be verified." } as const; }
  }
  queuePermissionRecoveryPm(stored: Stored, request: TeamPermissionRecoveryRequest, cause: string, decisionId?: string) {
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
      this.host.event(stored, "Permission diagnosis could not enter automatic PM recovery because the run is stopped, held, revoked, uncertain, or unsynchronized.");
      this.host.save(stored);
      return false;
    }
    if (attempts >= automaticRecoveryLimit) {
      run.recovery = { attempts, status: "exhausted", source };
      run.status = "blocked"; stored.halt = "block"; run.blockCode = "permission-recovery-exhausted";
      run.reason = "Permission recovery reached its bounded PM correction limit. Review the current prompt and retained evidence before acting.";
      this.host.event(stored, run.reason); this.host.save(stored); this.host.trackBlocked(stored);
      return false;
    }
    run.recovery = { attempts: attempts + 1, status: "stopping", source };
    this.host.commands.get(run.id)?.abort();
    void this.host.invalidatePermissionDecisions(stored, "The team is stopping members before bounded permission-recovery diagnosis.");
    run.status = "planning"; stored.halt = "block"; run.blockCode = "permission-recovery"; run.reason = boundedRecoveryText(cause);
    this.host.event(stored, "The project manager will inspect the retained permission blocker after active members are confirmed stopped.");
    this.host.save(stored);
    return true;
  }
  protected newPermissionRecoveryRequest(stored: Stored, target: TeamMember, prompt: Prompt): TeamPermissionRecoveryRequest {
    const run = stored.run;
    const request: TeamPermissionRecoveryRequest = { id: randomUUID(), revision: run.revision, targetMemberId: target.memberId,
      targetSessionId: target.sessionId, promptId: prompt.id, promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt),
      targetCwd: realpathSync(target.cwd), policyHash: digest(run.permissions!), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      status: "diagnosing", rounds: 0 };
    (run.permissionRecovery ??= { requests: [], steps: [], outcomes: [] }).requests.push(request);
    if (run.permissionRecovery.requests.length > permissionRecoveryOutcomeLimit) run.permissionRecovery.requests.splice(0, run.permissionRecovery.requests.length - permissionRecoveryOutcomeLimit);
    return request;
  }
}
