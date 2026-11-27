import type { ConnectorSource } from "./mcp-types.js";
import { coversPoint, decisionAnswerLabel, inputSourceLabel, teamActionSchema, teamMemberRetireSchema, teamMutationSchema, teamParallelismSchema, type SteeringSource, type TeamMember, type TeamMemberRetire, type TeamParallelism, type TeamPermissionDecision, type TeamView } from "./team-types.js";
import { pullRequestBranch } from "./team-prompts.js";
import type { MemberStopDetail, MemberStopReason } from "./run-events.js";
import { TeamError, assertMemberReadOnly } from "./team-workspace.js";
import { stopFenceLifted, type CommandFence } from "./team-command-fence.js";
import { assignment, deliveredAtRevision, recoveriesUsed, timestamp, type TeamKernel } from "./team-kernel.js";
import { isBenignFenceError, type TeamDiagnostics } from "./team-diagnostics.js";
import type { TeamReviewFeedback } from "./team-review-feedback.js";
import { runObjectiveNote, steerRunObjective } from "./objective-runs.js";
import type { TeamIntent } from "./team-intent.js";
import { capacityCeiling } from "./team-planning.js";
import { recommendationOutcome } from "./question-recommendation.js";
import type { Action, Mutation, Stored } from "./teams.js";

export const heldWaiting = (stored: Stored) => stored.run.status === "paused" && stored.ownerHalt?.waiting === true;
export const runtimeUnavailableReason = "An agent runtime is unavailable; the team is waiting for confirmed state.";

export type MutationsHost = Pick<TeamKernel, "commands" | "manager" | "config" | "closed" | "save" | "event" | "record" | "enqueue" | "assertBudget" | "block"> & {
  readonly diag: Pick<TeamDiagnostics, "warnUnexpected">;
  readonly fence: Pick<CommandFence, "recent" | "check" | "lift">;
  readonly reviewFeedback: Pick<TeamReviewFeedback, "resolveLegacyPullRequestBranch">;
  readonly intentChecks: Pick<TeamIntent, "answerNote">;
  visible(id: string): Stored;
  view(stored: Stored): TeamView;
  emit(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  replay(stored: Stored, operation: string, body: Action | Mutation | TeamParallelism): boolean;
  mutation(stored: Stored, operation: string, body: Action | Mutation | TeamParallelism): boolean;
  admit(stored: Stored, operation: string, body: Action | Mutation | TeamParallelism): string | undefined;
  recordReceipt(stored: Stored, requestId: string, fingerprint: string): void;
  memberStopped(stored: Stored, member: TeamMember, reason: MemberStopReason, detail?: MemberStopDetail): void;
  agentEligible(stored: Stored): boolean;
  fenceAgentDeliveries(runId: string): Promise<boolean>;
  finishLinkedPermissionRecovery(stored: Stored, decision: TeamPermissionDecision, cause: string, action: string, outcome: string, consequence: string): void;
};

export class TeamMutations {
  constructor(private readonly host: MutationsHost) {}
  steer(id: string, input: Mutation, source?: SteeringSource, censusReuseMs = 0) {
    const body = { ...teamMutationSchema.parse(input), ...(source === undefined ? {} : { source }) };
    return this.host.fence.recent(id, censusReuseMs).then(taken => this.host.enqueue(id, async () => {
      const stored = this.host.record(id);
      if (this.host.replay(stored, "steer", body)) return this.host.view(stored);
      if (stored.deliveryAttempt || stored.run.deliveryReceipt) throw new TeamError(409, "delivery-reconciliation-required", "Inspect the recorded pull request before starting another run; steering cannot replay a started delivery.");
      this.host.fence.check(stored, taken);
      const pending = stopFenceLifted(stored) ? undefined : stored.pending;
      if (pending && !this.host.commands.has(id)) throw new TeamError(409, "team-reconciliation-required", "This team has an unresolved workspace or verification operation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (pending && pending.kind !== "check") throw new TeamError(409, "team-operation-running", "A workspace operation is in progress. Retry steering after it settles.");
      if (stored.run.workspaceRemovedAt) throw new TeamError(409, "team-workspace-removed", "This run's workspaces were removed under the retention policy; start a new run.");
      if (Buffer.byteLength(stored.run.steering.map(item => item.text).join("")) + Buffer.byteLength(body.text) > 32 * 1024) throw new TeamError(409, "team-steering-limit", "This team reached its 32 KiB steering limit. Start a new team with consolidated requirements.");
      if (stored.run.steering.length >= 20) throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team from the reviewed integration branch.");
      const receipt = this.host.admit(stored, "steer", body);
      if (!receipt) return this.host.view(stored);
      if (stored.run.pullRequest && !pullRequestBranch(stored.run)) await this.host.reviewFeedback.resolveLegacyPullRequestBranch(stored);
      this.host.commands.get(id)?.abort();
      await this.invalidatePermissionDecisions(stored, "A steer started before the permission request could be answered.");
      this.host.recordReceipt(stored, body.requestId, receipt);
      this.host.fence.lift(stored);
      if (stored.run.recovery && stored.run.recovery.status !== "exhausted") {
        stored.run.recovery.status = "exhausted";
        this.host.event(stored, `${source ? inputSourceLabel(source) : "User"} steering superseded automatic recovery; its original report remains recorded as evidence.`);
      }
      if (stored.run.pullRequest && stored.run.deliveryRecovery) { stored.run.deliveryRecoveryAttempts = recoveriesUsed(stored.run); delete stored.run.deliveryRecovery; }
      stored.run.revision++; stored.run.steering.push({ text: body.text, revision: stored.run.revision, at: timestamp(), ...(source ? { source } : {}) });
      const objectiveNote = runObjectiveNote(stored, steerRunObjective(stored, body.requestId, timestamp())); if (objectiveNote) this.host.event(stored, objectiveNote);
      this.host.emit(stored, "run.revision-advanced", [stored.run.revision], {}, { cause: "steer", fromRevision: stored.run.revision - 1, baseChanged: false });
      stored.run.status = "planning"; stored.halt = "steer"; stored.run.reason = "Stopping earlier members before planning the updated request."; stored.run.blockCode = undefined;
      stored.run.tasks = []; stored.run.review = undefined; stored.run.round = 0; stored.checkHead = undefined;
      stored.run.brief = undefined; stored.run.noChange = undefined;
      if (stored.run.discovery && !stored.run.discovery.completedAt) stored.run.discovery.completedAt = timestamp();
      this.host.event(stored, `${source ? inputSourceLabel(source) : "User"} steering recorded. Earlier reports cannot satisfy the new revision.`); this.host.save(stored);
      return this.host.view(stored);
    }));
  }
  inspectMemberRuntime(id: string, memberId: string) {
    const stored = this.host.record(id), run = stored.run;
    const member = run.members.find(item => item.memberId === memberId && item.revision === run.revision);
    if (!member) throw new TeamError(404, "member-not-found", "The current team revision has no such member.");
    return this.host.manager.inspectTeamRuntime(member.sessionId, assignment(member));
  }
  retireMember(id: string, memberId: string, input: TeamMemberRetire) {
    const body = teamMemberRetireSchema.parse(input);
    return this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (this.host.replay(stored, "retire-member", body)) return this.host.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before retiring a member.");
      const member = run.members.find(item => item.memberId === memberId && item.revision === run.revision);
      const unavailable = () => new TeamError(409, "member-retirement-unavailable", "Only an unreported current reviewer at the verified head can be retired under an unchanged, quiescent team state.");
      if (run.status === "cancelled" || run.status === "paused" || stored.halt || !member || member.role !== "reviewer" || member.report ||
          !["unavailable", "running"].includes(member.status) || member.sessionId !== body.sessionId || member.baseCommit !== run.headCommit ||
          member.baseCommit !== stored.checkHead || stored.pending || this.host.commands.has(id) || stored.deliveryAttempt || run.deliveryReceipt ||
          deliveredAtRevision(run) || run.stopReason || (run.permissionDecisions ?? []).some(decision => decision.targetSessionId === body.sessionId &&
            ["pending", "reviewing", "approved", "answering", "uncertain"].includes(decision.status))) throw unavailable();
      this.host.assertBudget(run, true);
      const revision = run.revision, sessionId = member.sessionId, baseCommit = member.baseCommit;
      const retired = await this.host.manager.retireTeamRuntime(sessionId, body.requestId, assignment(member), body.identity);
      if (run.revision !== revision || !run.members.includes(member) || member.sessionId !== sessionId || member.baseCommit !== baseCommit)
        throw new TeamError(409, "member-retirement-unavailable", "The reviewer assignment changed while its runtime was being retired.");
      const retirement = { requestId: body.requestId, at: retired.stoppedAt, identity: retired.identity, seq: retired.seq,
        processes: retired.processes.length, unsignalable: retired.unsignalable.length };
      try { await assertMemberReadOnly(member.cwd, member.baseCommit, this.host.config.teams?.commandPrefix); }
      catch (error) {
        if (!this.host.mutation(stored, "retire-member", body)) return this.host.view(stored);
        member.status = "stopped"; member.stoppedReason = "Recording failed; runtime retired after confirmed process exit"; member.retirement = retirement;
        this.host.memberStopped(stored, member, "host", "retired");
        this.host.block(stored, error, member);
        return this.host.view(stored);
      }
      if (!this.host.mutation(stored, "retire-member", body)) return this.host.view(stored);
      member.status = "stopped"; member.stoppedReason = "Recording failed; runtime retired after confirmed process exit"; member.retirement = retirement;
      this.host.memberStopped(stored, member, "host", "retired");
      if (run.reason === runtimeUnavailableReason) run.reason = undefined;
      this.host.event(stored, `The owner authorized retirement of reviewer ${member.memberId} at ${member.baseCommit}. Operator claim, not host-verified: ${JSON.stringify(body.text.slice(0, 500))}. The original journal and reports are retained.`);
      this.host.save(stored);
      return this.host.view(stored);
    });
  }
  setParallelism(id: string, input: TeamParallelism) {
    teamParallelismSchema.parse(input);
    this.host.record(id);
    return Promise.reject(new TeamError(409, "agent-managed-capacity", "Worker capacity is agent-managed. The project manager or mission coordinator selects the worker limit."));
  }
  setMissionParallelism(id: string, input: TeamParallelism) {
    const body = teamParallelismSchema.parse(input);
    return this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (this.host.replay(stored, "mission-parallelism", body)) return this.host.view(stored);
      if (!run.missionId) throw new TeamError(409, "agent-managed-capacity", "Mission capacity changes must target a mission subteam.");
      if (["cancelled", "ready-for-review", "merged", "no-change"].includes(run.status))
        throw new TeamError(409, "team-not-running", "The mission subteam has already finished.");
      if (body.parallelism > capacityCeiling(run))
        throw new TeamError(409, "team-parallelism-limit", `This subteam supports at most ${capacityCeiling(run)} workers.`);
      if (!this.host.mutation(stored, "mission-parallelism", body)) return this.host.view(stored);
      const previous = run.parallelism;
      run.parallelism = body.parallelism;
      this.host.event(stored, `The mission coordinator set the worker limit from ${previous} to ${body.parallelism} (capacity ceiling ${capacityCeiling(run)}).`);
      this.host.save(stored);
      return this.host.view(stored);
    });
  }
  answer(id: string, decisionId: string, input: Mutation, authorizeNewAnswer?: (held: boolean) => void, by: "owner" | "coordinator" | "connector" = "owner", source?: ConnectorSource) {
    const body = { ...teamMutationSchema.parse(input), ...(by === "owner" && !source ? {} : { by, ...(source ? { source } : {}) }) };
    return this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (this.host.replay(stored, `answer:${decisionId}`, body)) return this.host.view(stored);
      authorizeNewAnswer?.(heldWaiting(stored));
      const decision = run.decisions.find(item => item.id === decisionId && item.revision === run.revision);
      if (!decision) throw new TeamError(404, "decision-not-found", "This decision is no longer current.");
      if (stored.receipts[body.requestId]) { this.host.mutation(stored, `answer:${decisionId}`, body); return this.host.view(stored); }
      if (decision.answer) throw new TeamError(409, "decision-answered", "This decision already has an answer.");
      const held = heldWaiting(stored), mark = stored.ownerHalt;
      if (!held && (stored.halt || run.status === "paused")) throw new TeamError(409, "team-paused", "Resume the team before answering its decision.");
      if (!this.host.mutation(stored, `answer:${decisionId}`, body)) return this.host.view(stored);
      if (held) stored.ownerHalt = mark;
      decision.answer = body.text; decision.answeredBy = by; decision.answeredAt = timestamp();
      if (decision.recommendation) decision.recommendation.outcome = recommendationOutcome(decision.options, decision.recommendation, body.text);
      if (source) decision.source = source;
      const next = this.host.intentChecks.answerNote(stored, decision) ?? (held ? "The requesting member will continue in a new attempt when the team resumes." : "The requesting member will continue in a new attempt.");
      this.host.event(stored, by === "connector" ? `${decisionAnswerLabel(decision)} decision was recorded as delegated agent input. ${next}` : by === "coordinator" ? `A mission coordinator decision was recorded. ${next}` : `A user decision was recorded. ${next}`); this.host.save(stored);
      if (by === "owner" && (run.permissionDecisions ?? []).some(item => ["pending", "reviewing", "approved", "answering"].includes(item.status)))
        await this.invalidatePermissionDecisions(stored, "The owner answered a team question; a request reviewed before that answer remains with the user.", false);
      return this.host.view(stored);
    });
  }
  revokePermissions(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.host.enqueue(id, async () => {
      const stored = this.host.visible(id), run = stored.run;
      if (this.host.replay(stored, "revoke-permissions", body)) return this.host.view(stored);
      if (!run.permissions && !run.permissionsRevokedAt && !this.host.agentEligible(stored) && !run.permissionAgentDecisions?.length)
        throw new TeamError(409, "permissions-not-enabled", "This team has no delegated permission policy to revoke.");
      const receipt = this.host.admit(stored, "revoke-permissions", body);
      if (!receipt) return this.host.view(stored);
      run.permissionsRevokedAt ??= timestamp();
      await this.invalidatePermissionDecisions(stored, "The owner revoked delegated permission decisions.");
      this.host.recordReceipt(stored, body.requestId, receipt);
      this.host.event(stored, "Delegated permission decisions were revoked by the owner.");
      this.host.save(stored);
      return this.host.view(stored);
    });
  }
  revokeRouting(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.host.enqueue(id, async () => {
      const stored = this.host.record(id), run = stored.run;
      if (run.routing?.mode !== "auto") throw new TeamError(409, "routing-not-enabled", "This team does not choose worker profiles automatically.");
      if (this.host.replay(stored, "revoke-routing", body) || !this.host.mutation(stored, "revoke-routing", body)) return this.host.view(stored);
      run.routingRevokedAt ??= timestamp();
      this.host.event(stored, "Host profile routing was revoked by the owner; new tasks start on the coordinator's pick when it passes the fixed rules, else on the first implementer that passes them." + (coversPoint(run, "escalation") || coversPoint(run, "scout") ? " Escalations and scouts use the profile their member names, else the first that passes the fixed rules." : ""));
      this.host.save(stored); return this.host.view(stored);
    });
  }
  async invalidatePermissionDecisions(stored: Stored, reason: string, fenceAgent = true): Promise<boolean> {
    if (fenceAgent && !await this.host.fenceAgentDeliveries(stored.run.id))
      this.host.event(stored, "An in-flight permission agent answer could not be conclusively fenced. Inspect the member session before acting.");
    const inFlight: TeamPermissionDecision[] = [];
    for (const decision of stored.run.permissionDecisions ?? []) if (["pending", "reviewing", "approved", "answering"].includes(decision.status)) {
      if (decision.status === "answering") { decision.status = "uncertain"; inFlight.push(decision); }
      else decision.status = "stale";
      decision.reason = reason;
      this.host.finishLinkedPermissionRecovery(stored, decision, reason, "invalidate-review", decision.status === "uncertain" ? "answer-state-uncertain" : "stop-review",
        decision.status === "uncertain" ? "Inspect the target session before any further action." : "No provider answer was sent; execution is unknown.");
    }
    if (inFlight.length) this.host.save(stored);
    let uncertain = false;
    for (const decision of inFlight) {
      let fence: "invalidated" | "uncertain" = "uncertain";
      try { fence = await this.host.manager.invalidateTeamPermission(decision.targetSessionId, decision.id); }
      catch (error) { if (!isBenignFenceError(error, this.host.closed)) this.host.diag.warnUnexpected("permission-fence", error); }
      if (fence !== "invalidated") {
        uncertain = true;
        stored.unfencedAnswers = [...new Set([...(stored.unfencedAnswers ?? []), decision.id])];
      } else this.settleAnswerMark(stored, decision.id);
    }
    if (uncertain) this.host.event(stored, "An in-flight delegated permission answer could not be conclusively fenced. Its decision remains uncertain; inspect the target session.");
    this.host.save(stored);
    return !uncertain;
  }
  async refenceCoordinatorAnswers(stored: Stored): Promise<boolean> {
    const open = stored.unfencedAnswers ?? [];
    if (open.length === 0) return true;
    const left: string[] = [];
    for (const decisionId of open) {
      const decision = stored.run.permissionDecisions?.find(item => item.id === decisionId);
      if (!decision) continue;
      let settled = false;
      try { settled = (await this.host.manager.state(decision.targetSessionId)).status === "exited"; }
      catch (error) { if (!isBenignFenceError(error, this.host.closed)) this.host.diag.warnUnexpected("permission-refence-state", error); settled = false; }
      if (!settled) {
        try { settled = await this.host.manager.invalidateTeamPermission(decision.targetSessionId, decision.id) === "invalidated"; }
        catch (error) { if (!isBenignFenceError(error, this.host.closed)) this.host.diag.warnUnexpected("permission-refence", error); settled = false; }
      }
      if (!settled) left.push(decisionId);
    }
    if (left.length !== open.length) {
      if (left.length) stored.unfencedAnswers = left; else delete stored.unfencedAnswers;
      this.host.save(stored);
    }
    return left.length === 0;
  }
  settleAnswerMark(stored: Stored, decisionId: string) {
    const left = (stored.unfencedAnswers ?? []).filter(id => id !== decisionId);
    if (left.length) stored.unfencedAnswers = left; else delete stored.unfencedAnswers;
  }
}
