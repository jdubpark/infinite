import type { TeamCommand, TeamMember, TeamModelProfile, TeamPermissionAgentDecision, TeamPermissionRecoveryView, TeamRun } from "./team-types.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Session } from "./types.js";
import type { Manager } from "./manager.js";
import { accountSettingPrompt, type Prompt } from "@infinite/attention";
import { assertMemberReadOnly, memberChangedPaths } from "./team-workspace.js";
import { agentAcceptOption, isCollapsedPermissionPrompt, permissionEvidenceHash } from "./team-permissions.js";
import { collectPermissionEvidence, permissionEvidenceDigest } from "./team-permission-evidence.js";
import type { PermissionAgentServices, PermissionHandled, PermissionRequest } from "./permission-agent-types.js";
import type { PermissionDeliverySource } from "./permission-delivery.js";
import { memberTaskOf, teamPermissionRequest, teamPermissionTarget, teamPermissionTask } from "./team-permission-adapter.js";
import { activeMember, activeTeamRun, assignment, livePermissionRecoveryStatuses, permissionPromptKey, type TeamKernel, timestamp } from "./team-kernel.js";
import type { Stored } from "./teams.js";

export type PermissionHost = TeamKernel & {
  prefixFor(run: TeamRun): TeamCommand | undefined;
  assertDelivery(stored: Stored): void;
  invalidatePermissionDecisions(stored: Stored, reason: string, fenceAgent?: boolean): Promise<boolean>;
  newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, prompt?: string, pinnedProfile?: TeamModelProfile): TeamMember;
  permissionRecoveryHistory(run: TeamRun): TeamPermissionRecoveryView[];
  refenceCoordinatorAnswers(stored: Stored): Promise<boolean>;
  requiredChecks(run: TeamRun): TeamCommand[] | undefined;
  reviewerProfile(run: TeamRun): TeamModelProfile | undefined;
  settleAnswerMark(stored: Stored, decisionId: string): void;
  trackBlocked(stored: Stored): void;
};

const underReview = (run: TeamRun, sessionId: string, promptId?: number) => promptId !== undefined &&
  (run.permissionDecisions ?? []).some(decision => decision.targetSessionId === sessionId && decision.promptId === promptId &&
    ["pending", "reviewing", "approved", "answering"].includes(decision.status)) || promptId !== undefined &&
  (run.permissionRecovery?.requests ?? []).some(request => request.targetSessionId === sessionId && request.promptId === promptId && livePermissionRecoveryStatuses.has(request.status));
const unreadPermissionPrompt = (prompt: Prompt) => !accountSettingPrompt(prompt) && !prompt.hash && prompt.kind === "permission";
const agentPermissionPrompt = (prompt: Prompt) => !accountSettingPrompt(prompt) && Boolean(prompt.hash) && (prompt.kind === "permission" || isCollapsedPermissionPrompt(prompt));
const coordinatorReviewLive = (run: TeamRun) =>
  run.members.some(member => member.revision === run.revision && member.role === "permission-coordinator" && activeMember(member)) ||
  (run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering"].includes(decision.status)) ||
  (run.permissionRecovery?.requests ?? []).some(request => livePermissionRecoveryStatuses.has(request.status));
const coordinatorRetiredEvent = "The permission agent now decides this run's provider requests; its coordinator reviews were retired.";
export const coordinatorRetiredReason = "The permission agent now decides this run's provider requests; the coordinator review has no authority to answer.";
type AgentHandOff = { runId: string; running: boolean; attempted: boolean; at: number; expandedAt?: number;
  outcome?: { request: PermissionRequest; handled: PermissionHandled } };
const AGENT_EVIDENCE_SETTLE_MS = 1_500;
const AGENT_EXPANSION_SETTLE_MS = 5_000;
const AGENT_RETRY_MS = 30_000;
const AGENT_STALE_RETRY_MS = 10_000;
const AGENT_HANDOFF_LIMIT = 2048;
const holdingHandOff = (entry: AgentHandOff, now: number) =>
  entry.running || !entry.attempted && now - (entry.expandedAt ?? 0) < AGENT_EXPANSION_SETTLE_MS;
const retryAgentHandOff = (entry: AgentHandOff, now: number) => {
  if (!entry.attempted) return true;
  const handled = entry.outcome?.handled;
  if (!handled || !handled.handled) return now - entry.at >= AGENT_RETRY_MS;
  return handled.result === "stale" && now - entry.at >= AGENT_STALE_RETRY_MS;
};
const AGENT_RESULT_TEXT: Record<TeamPermissionAgentDecision["result"], string> = {
  allowed: "The permission agent allowed a provider request",
  rejected: "The permission agent rejected a provider request",
  owner: "A provider request needs the owner's own answer",
  undeliverable: "The permission agent could not answer a provider request; it remains with the owner",
  stale: "A provider request changed or closed before it was answered; nothing was sent",
};
const agentResultEvent = (decision: TeamPermissionAgentDecision) => `${AGENT_RESULT_TEXT[decision.result]} (member ${decision.memberId}, ${decision.role}` +
  `${decision.code ? `, code ${decision.code}` : ""}${decision.interruptClass ? `, class ${decision.interruptClass}` : ""}` +
  `${decision.delivery === "uncertain" ? ", delivery unconfirmed and not repeated" : ""}).`;

export class TeamPermissionAgent {
  readonly agentSwitched = new Set<string>();
  private permissionAgent?: PermissionAgentServices;
  removeAgentSource?: () => void;
  private readonly agentHandOffs = new Map<string, AgentHandOff>();
  private readonly agentFirstSeen = new Map<string, number>();
  private readonly agentObserved = new Map<string, { promptId?: number; eligible: boolean; unreadAt?: number }>();
  readonly agentControllers = new Map<string, AbortController>();
  private readonly agentDeliveries = new Map<string, Map<string, string>>();
  constructor(protected readonly host: PermissionHost) {}

  usePermissionAgent(services: PermissionAgentServices) {
    this.permissionAgent = services;
    this.removeAgentSource?.();
    const delivery = services.delivery as { addSource?(source: PermissionDeliverySource): () => void } | undefined;
    this.removeAgentSource = delivery?.addSource?.({ claims: (sessionId, promptId) => this.agentClaims(sessionId, promptId) });
  }
  agentEligible(stored: Stored): boolean {
    const services = this.permissionAgent, run = stored.run;
    if (!services?.delivery || !services.pipeline || run.permissionsRevokedAt) return false;
    try { return services.pipeline.serves(run.projectId).served; } catch { return false; }
  }
  async retireCoordinatorReviews(stored: Stored) {
    if (this.coordinatorReviewsLive(stored)) {
      this.host.event(stored, coordinatorRetiredEvent);
      await this.host.invalidatePermissionDecisions(stored, coordinatorRetiredReason, false);
    }
    if (!await this.host.refenceCoordinatorAnswers(stored)) return;
    if (this.agentEligible(stored)) this.agentSwitched.add(stored.run.id);
  }
  agentServes(stored: Stored): boolean {
    if (!this.agentEligible(stored)) { this.agentSwitched.delete(stored.run.id); return false; }
    return this.agentSwitched.has(stored.run.id);
  }
  private coordinatorReviewsLive(stored: Stored) {
    return (stored.run.permissionDecisions ?? []).some(decision => ["pending", "reviewing", "approved", "answering"].includes(decision.status));
  }
  permissionAuthorityChanged(): Promise<void> {
    const affected = () => [...this.host.records.values()].filter(stored => this.agentEligible(stored) &&
      (this.coordinatorReviewsLive(stored) || !this.agentSwitched.has(stored.run.id)));
    const ids = affected().map(stored => stored.run.id);
    if (this.host.closed || ids.length === 0) return Promise.resolve();
    return Promise.all(ids.map(id => this.host.enqueue(id, async () => {
      if (this.host.closed) return;
      const stored = this.host.records.get(id);
      if (stored && this.agentEligible(stored) && (this.coordinatorReviewsLive(stored) || !this.agentSwitched.has(id)))
        await this.retireCoordinatorReviews(stored);
    }))).then(() => undefined);
  }
  private agentHolds(sessionId: string, promptId: number | undefined) {
    if (promptId === undefined) return false;
    const prefix = `${sessionId}:${promptId}:`, now = Date.now();
    for (const [key, entry] of this.agentHandOffs) if (key.startsWith(prefix) && holdingHandOff(entry, now)) return true;
    for (const [key, at] of this.agentFirstSeen) if (key.startsWith(prefix) && now - at < AGENT_EVIDENCE_SETTLE_MS) return true;
    const observed = this.agentObserved.get(sessionId);
    if (observed?.promptId !== promptId || observed.unreadAt === undefined) return false;
    const age = now - observed.unreadAt;
    return age >= 0 && age < AGENT_EVIDENCE_SETTLE_MS;
  }
  agentBusy(runId: string) {
    const now = Date.now();
    for (const entry of this.agentHandOffs.values()) if (entry.runId === runId && holdingHandOff(entry, now)) return true;
    return Boolean(this.agentDeliveries.get(runId)?.size);
  }
  promptHolder(run: TeamRun, sessionId: string, promptId: number | undefined): "agent" | "coordinator" | "user" {
    if (this.agentHolds(sessionId, promptId)) return "agent";
    return underReview(run, sessionId, promptId) ? "coordinator" : "user";
  }
  private agentClaims(sessionId: string, promptId: number): boolean {
    for (const stored of this.host.records.values()) {
      const run = stored.run;
      const member = run.members.find(item => item.sessionId === sessionId && item.revision === run.revision);
      if (!member) continue;
      if (!activeMember(member) || member.role === "permission-coordinator" || stored.halt ||
          ["paused", "cancelled", "blocked"].includes(run.status) || !this.agentEligible(stored)) return false;
      if (this.agentHolds(sessionId, promptId)) return true;
      const prefix = `${sessionId}:${promptId}:`;
      const observed = this.agentObserved.get(sessionId);
      return observed?.promptId !== promptId || observed.eligible && ![...this.agentHandOffs.keys()].some(key => key.startsWith(prefix));
    }
    return false;
  }
  private trimFirstSeen(now: number) {
    for (const [key, at] of this.agentFirstSeen) if (now - at > 60_000 || this.agentFirstSeen.size > AGENT_HANDOFF_LIMIT) this.agentFirstSeen.delete(key);
  }
  private rememberHandOff(key: string, entry: AgentHandOff) {
    this.agentHandOffs.delete(key);
    this.agentHandOffs.set(key, entry);
    for (const [oldest, value] of this.agentHandOffs) {
      if (this.agentHandOffs.size <= AGENT_HANDOFF_LIMIT) break;
      if (!value.running) this.agentHandOffs.delete(oldest);
    }
  }
  private agentController(runId: string) {
    let controller = this.agentControllers.get(runId);
    if (!controller || controller.signal.aborted) { controller = new AbortController(); this.agentControllers.set(runId, controller); }
    return controller;
  }
  private trackAgentDelivery(runId: string, sessionId: string, deliveryId: string, active: boolean) {
    const deliveries = this.agentDeliveries.get(runId) ?? new Map<string, string>();
    if (active) deliveries.set(deliveryId, sessionId); else deliveries.delete(deliveryId);
    if (deliveries.size) this.agentDeliveries.set(runId, deliveries); else this.agentDeliveries.delete(runId);
  }
  async fenceAgentDeliveries(runId: string) {
    this.agentControllers.get(runId)?.abort();
    this.agentControllers.delete(runId);
    let fenced = true;
    for (const [deliveryId, sessionId] of [...(this.agentDeliveries.get(runId) ?? [])]) {
      try { if (await this.host.manager.invalidateTeamPermission(sessionId, deliveryId) !== "invalidated") fenced = false; }
      catch { fenced = false; }
    }
    return fenced;
  }
  endPermissionTask(stored: Stored) {
    if (activeTeamRun(stored.run.status)) { delete stored.permissionTaskEnded; return; }
    const pipeline = this.permissionAgent?.pipeline;
    if (stored.permissionTaskEnded || !pipeline) return;
    try { pipeline.taskEnded(stored.run.id); stored.permissionTaskEnded = true; }
    catch {}
  }
  private agentRunCheck(runId: string, memberId: string, sessionId: string) {
    const stored = this.host.records.get(runId);
    if (!stored) return { stale: true, reason: "The run no longer exists." };
    const run = stored.run;
    if (stored.halt || ["paused", "cancelled", "blocked"].includes(run.status) || !activeTeamRun(run.status) || !this.agentServes(stored))
      return { stale: false, reason: "The run is paused or stopped, or the permission agent no longer serves it." };
    const member = run.members.find(item => item.memberId === memberId && item.sessionId === sessionId);
    if (!member || member.revision !== run.revision || member.status !== "running" || member.role === "permission-coordinator")
      return { stale: true, reason: "The member assignment is no longer active." };
    return undefined;
  }
  permissionAgentLive(session: Pick<Session, "id" | "team">): boolean {
    const team = session.team;
    return Boolean(team) && this.agentRunCheck(team!.runId, team!.memberId, session.id) === undefined;
  }
  permissionAgentTask(session: Pick<Session, "team">): { title: string; text: string } | undefined {
    const team = session.team, run = team ? this.host.records.get(team.runId)?.run : undefined;
    return run ? teamPermissionTask(run, memberTaskOf(run, team?.taskId)) : undefined;
  }
  handOffPermission(stored: Stored, member: TeamMember, state: Awaited<ReturnType<Manager["state"]>>) {
    const run = stored.run, prompt = state.attention.prompt;
    const open = state.status === "running" && state.attention.state === "needs-you" && prompt !== undefined;
    const served = open && !(state.control && state.control.expiresAt > Date.now()) &&
      member.status === "running" && member.role !== "permission-coordinator" && member.revision === run.revision &&
      !stored.halt && !["paused", "cancelled", "blocked"].includes(run.status) && !coordinatorReviewLive(run);
    const eligible = served && agentPermissionPrompt(prompt!);
    const seen = this.agentObserved.get(member.sessionId);
    const unreadAt = served && unreadPermissionPrompt(prompt!) ? (seen?.promptId === prompt!.id ? seen.unreadAt : undefined) ?? Date.now() : undefined;
    this.agentObserved.set(member.sessionId, { ...(open ? { promptId: prompt!.id } : {}), eligible, ...(unreadAt !== undefined ? { unreadAt } : {}) });
    if (this.agentObserved.size > AGENT_HANDOFF_LIMIT) this.agentObserved.delete(this.agentObserved.keys().next().value!);
    if (!eligible || !prompt) return;
    const key = `${permissionPromptKey(member.sessionId, prompt.id, prompt.hash!)}:${permissionEvidenceHash(prompt)}`, now = Date.now();
    if (this.agentHolds(member.sessionId, prompt.id)) return;
    const known = this.agentHandOffs.get(key);
    if (known && (known.running || !retryAgentHandOff(known, now))) return;
    if (agentAcceptOption(prompt) === undefined && !isCollapsedPermissionPrompt(prompt)) {
      const first = this.agentFirstSeen.get(key);
      if (first === undefined) { this.agentFirstSeen.set(key, now); this.trimFirstSeen(now); return; }
      if (now - first < AGENT_EVIDENCE_SETTLE_MS) return;
    }
    if (isCollapsedPermissionPrompt(prompt) && known?.expandedAt === undefined) { this.expandForAgent(stored, member, prompt, key); return; }
    if (known?.expandedAt !== undefined && !known.attempted && now - known.expandedAt < AGENT_EXPANSION_SETTLE_MS) return;
    const entry: AgentHandOff = { runId: run.id, running: true, attempted: true, at: now, ...(known?.expandedAt !== undefined ? { expandedAt: known.expandedAt } : {}) };
    this.rememberHandOff(key, entry);
    const { memberId, sessionId } = member;
    void this.agentHandOff(stored, member, prompt).then(outcome => { entry.outcome = outcome; }, () => {})
      .finally(() => {
        entry.running = false; entry.at = Date.now();
        void this.host.enqueue(run.id, () => this.recordAgentResult(run.id, memberId, sessionId, prompt.id, entry.outcome)).catch(() => {});
      });
  }
  private expandForAgent(stored: Stored, member: TeamMember, prompt: Prompt, key: string) {
    const runId = stored.run.id;
    const entry: AgentHandOff = { runId, running: true, attempted: false, at: Date.now(), expandedAt: Date.now() };
    this.rememberHandOff(key, entry);
    void (async () => {
      let expanded = false;
      try {
        const cwd = realpathSync(member.cwd);
        this.host.assertRunPath(stored, cwd);
        const receipt = await this.host.manager.expandTeamPermission(member.sessionId, randomUUID(), assignment(member), {
          promptId: prompt.id, promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt), targetCwd: cwd,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expanded = receipt.state === "delivered";
      } catch {}
      entry.running = false; entry.expandedAt = Date.now();
      await this.host.enqueue(runId, () => {
        const current = this.host.records.get(runId);
        if (!current) return;
        this.host.event(current, expanded ? "The host expanded a collapsed permission dialog once to show its whole command."
          : "A collapsed permission dialog could not be expanded; it is decided from what it shows, and the expansion is not repeated.");
        this.host.save(current);
      });
    })().catch(() => {});
  }
  private async agentHandOff(stored: Stored, member: TeamMember, prompt: Prompt) {
    const delivery = this.permissionAgent?.delivery;
    if (!delivery) return undefined;
    const run = stored.run, runId = run.id, { memberId, sessionId } = member;
    const sessionRoot = realpathSync(member.cwd);
    this.host.assertRunPath(stored, sessionRoot);
    const prefix = this.host.prefixFor(run);
    const scratch = member.scratchDirectory ? [member.scratchDirectory] : [];
    const workspace = async () => {
      const changedPaths = await memberChangedPaths(sessionRoot, member.baseCommit, prefix);
      return { changedPaths, evidence: collectPermissionEvidence({ prompt, cwd: sessionRoot, changedPaths, approvedScratchRoots: scratch }) };
    };
    const task = memberTaskOf(run, member.taskId);
    const request = teamPermissionRequest({ run, member, task, prompt, sessionRoot, workspace: await workspace(), acceptedChecks: this.host.requiredChecks(run) ?? null });
    const target = teamPermissionTarget(request, {
      manager: this.host.manager,
      assignment: assignment(member),
      runCheck: () => this.agentRunCheck(runId, memberId, sessionId),
      sessionRoot: () => {
        const root = realpathSync(member.cwd);
        this.host.assertRunPath(this.host.record(runId), root);
        return root;
      },
      ...(member.role === "delivery" ? { roleCheck: async () => {
        const current = this.host.record(runId);
        this.host.assertDelivery(current);
        await assertMemberReadOnly(sessionRoot, current.run.headCommit!, prefix);
      } } : {}),
      workspace,
      task: () => { const current = this.host.record(runId).run; return teamPermissionTask(current, memberTaskOf(current, member.taskId)); },
      collect: async paths => {
        const normalized = this.normalizeRequestedPermissionPaths(paths, sessionRoot, member.scratchDirectory);
        if (!normalized) {
          const limitations = ["The requested paths are malformed or outside the member's workspace; nothing was collected."];
          return { files: [], limitations, digest: permissionEvidenceDigest({ files: [], limitations }) };
        }
        const changedPaths = await memberChangedPaths(sessionRoot, member.baseCommit, prefix);
        return collectPermissionEvidence({ prompt, cwd: sessionRoot, changedPaths, approvedScratchRoots: scratch, requestedPaths: normalized });
      },
      delivering: (deliveryId, active) => this.trackAgentDelivery(runId, sessionId, deliveryId, active),
      signal: this.agentController(runId).signal,
    });
    return { request, handled: await delivery.handle(target) };
  }
  private recordAgentResult(runId: string, memberId: string, sessionId: string, promptId: number, outcome?: { request: PermissionRequest; handled: PermissionHandled }) {
    const stored = this.host.records.get(runId), handled = outcome?.handled;
    if (!stored || !outcome || !handled?.handled) return;
    const run = stored.run;
    const member = run.members.find(item => item.memberId === memberId && item.sessionId === sessionId);
    const list = run.permissionAgentDecisions ??= [];
    if (list.some(item => item.requestId === outcome.request.id && item.result === handled.result)) return;
    const decision: TeamPermissionAgentDecision = {
      ...(handled.decisionId ? { decisionId: handled.decisionId } : {}), requestId: outcome.request.id, memberId, sessionId,
      role: member?.role ?? outcome.request.requester.role as TeamMember["role"], ...(member?.taskId ? { taskId: member.taskId } : {}), promptId,
      result: handled.result, ...(handled.code ? { code: handled.code } : {}), ...(handled.interruptClass ? { interruptClass: handled.interruptClass } : {}),
      ...(handled.delivery ? { delivery: handled.delivery } : {}), at: timestamp(),
    };
    list.push(decision);
    if (list.length > 200) list.splice(0, list.length - 200);
    this.host.event(stored, agentResultEvent(decision));
    if (member && handled.code === "locked") {
      if (!member.permissionBlocked) this.host.event(stored, `Member ${memberId} (${member.role}) is blocked on a permission: its assignment repeated a rejected request and stays locked until the owner unlocks it, reopens that reject, or the run ends.`);
      member.permissionBlocked ??= { code: "locked", at: decision.at };
    } else if (member && (handled.result === "allowed" || handled.result === "rejected")) delete member.permissionBlocked;
    this.host.save(stored);
  }
  protected normalizeRequestedPermissionPaths(paths: string[], targetCwd: string, scratchDirectory?: string) {
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
}
