import type { ProviderLimit } from "./provider-limits.js";
import { MEMBER_STALL_REASON } from "./stall-recovery.js";
import { ACTIVE_MEMBER_STATUSES, type TeamPermissionDecision, type TeamRun, type TeamView, type TeamWaitReason } from "./team-types.js";

export const PROVIDER_INPUT_REASON = "A provider needs user input. Open the member session to respond; the team will not approve it.";
export const PERMISSION_REVIEW_REASON = "The permission coordinator is reviewing a provider request.";
export const PERMISSION_AGENT_REASON = "The permission agent is deciding a provider request.";
export const SESSION_SLOT_REASON = "Waiting for an available host session slot.";

const TERMINAL_STATUSES = new Set(["cancelled", "ready-for-review", "merged", "no-change"]);
const OPEN_PERMISSION_STATUSES = new Set(["pending", "reviewing", "approved", "answering", "escalated", "uncertain"]);

export type WaitReasonsRun = Pick<
  TeamRun,
  | "id"
  | "provider"
  | "revision"
  | "status"
  | "parallelism"
  | "tasks"
  | "discovery"
  | "decisions"
  | "linearTracking"
  | "linear"
  | "reason"
  | "blockCode"
> & {
  members: readonly TeamView["members"][number][];
  permissionDecisions?: readonly Pick<TeamPermissionDecision, "id" | "revision" | "targetMemberId" | "status">[];
};

function holdsSlot(member: TeamView["members"][number], revision: number): boolean {
  return (
    member.revision === revision &&
    (member.role === "scout" || member.role === "implementer") &&
    (["queued", "running", "unavailable"].includes(member.status) || (member.status === "reported" && !member.exitConfirmedAt))
  );
}

export function describeTeamWaitReasons(
  run: WaitReasonsRun,
  providerLimits: readonly ProviderLimit[],
  nowMs = Date.now(),
): TeamWaitReason[] {
  if (TERMINAL_STATUSES.has(run.status) || run.status === "paused") return [];

  const reasons: TeamWaitReason[] = [];
  const activeMembers = run.members.filter(
    member => member.revision === run.revision && ACTIVE_MEMBER_STATUSES.includes(member.status),
  );

  if (run.linearTracking && run.linear && run.linear.status !== "synced") {
    reasons.push({
      kind: "linear-sync",
      summary: run.linear.reason ? `Waiting on Linear sync: ${run.linear.reason}` : "Waiting for Linear tracking confirmation.",
      ...(run.linear.checkedAt ? { since: run.linear.checkedAt } : {}),
    });
  } else if (run.linearTracking && !run.linear && run.status !== "blocked") {
    reasons.push({
      kind: "linear-sync",
      summary: "Waiting for initial Linear tracking confirmation.",
    });
  }

  for (const decision of run.decisions) {
    if (decision.revision !== run.revision || decision.answer) continue;
    const member = run.members.find(item => item.memberId === decision.memberId);
    reasons.push({
      kind: "owner-decision",
      decisionId: decision.id,
      memberId: decision.memberId,
      ...(member?.taskId ? { taskId: member.taskId } : {}),
      since: decision.createdAt,
      summary: `Waiting for owner decision: ${decision.question}`,
    });
  }

  const promptedMemberIds = new Set<string>();
  for (const decision of run.permissionDecisions ?? []) {
    if (decision.revision !== run.revision || !OPEN_PERMISSION_STATUSES.has(decision.status)) continue;
    const target = activeMembers.find(member => member.memberId === decision.targetMemberId && !member.report);
    if (!target) continue;
    promptedMemberIds.add(target.memberId);
    reasons.push({
      kind: "provider-prompt",
      decisionId: decision.id,
      memberId: target.memberId,
      ...(target.taskId ? { taskId: target.taskId } : {}),
      summary:
        decision.status === "escalated"
          ? "Provider prompt escalated for owner response."
          : decision.status === "reviewing"
            ? "Permission coordinator is reviewing a provider prompt."
            : "Waiting on a provider prompt.",
    });
  }
  if (
    promptedMemberIds.size === 0 &&
    (run.reason === PROVIDER_INPUT_REASON || run.reason === PERMISSION_REVIEW_REASON || run.reason === PERMISSION_AGENT_REASON)
  ) {
    reasons.push({
      kind: "provider-prompt",
      summary: run.reason,
    });
  }

  const coveredProviders = new Set<string>();
  for (const limit of providerLimits) {
    if (Date.parse(limit.expiresAt) <= nowMs) continue;
    const matched = activeMembers.find(
      member => !member.report && (member.modelProfile?.provider ?? member.provider ?? run.provider) === limit.provider,
    );
    const relevant = limit.runId === run.id || limit.provider === run.provider || Boolean(matched) || run.blockCode === "provider-limit";
    if (!relevant) continue;
    coveredProviders.add(limit.provider);
    reasons.push({
      kind: "provider-limit",
      ...(matched ? { memberId: matched.memberId, ...(matched.taskId ? { taskId: matched.taskId } : {}) } : {}),
      since: limit.detectedAt,
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      summary: `Provider ${limit.provider} limit active${limit.resetsAt ? `, resets ${limit.resetsAt}` : ""}.`,
    });
  }
  for (const member of activeMembers) {
    if (member.report || !member.pendingLimit) continue;
    const provider = member.modelProfile?.provider ?? member.provider ?? run.provider;
    if (coveredProviders.has(provider)) continue;
    reasons.push({
      kind: "provider-limit",
      memberId: member.memberId,
      ...(member.taskId ? { taskId: member.taskId } : {}),
      summary: `${member.title} is observing a pending ${provider} limit.`,
    });
  }

  const stalledActive = activeMembers.filter(member => !member.report && Boolean(member.stalledAt));
  for (const member of stalledActive) {
    reasons.push({
      kind: "stalled",
      memberId: member.memberId,
      ...(member.taskId ? { taskId: member.taskId } : {}),
      since: member.stalledAt,
      summary: `${member.title} stalled without substantive activity and is stopping.`,
    });
  }
  if (stalledActive.length === 0 && run.status === "blocked" && (run.blockCode === "member-stalled" || run.reason === MEMBER_STALL_REASON)) {
    const lastStalled = [...run.members].reverse().find(member => member.revision === run.revision && Boolean(member.stalledAt));
    reasons.push({
      kind: "stalled",
      ...(lastStalled ? { memberId: lastStalled.memberId, ...(lastStalled.taskId ? { taskId: lastStalled.taskId } : {}), since: lastStalled.stalledAt } : {}),
      summary: run.reason ?? MEMBER_STALL_REASON,
    });
  }

  for (const member of activeMembers) {
    if (member.report || member.stalledAt || !member.spinnerOnlySince) continue;
    reasons.push({
      kind: "spinner-only",
      memberId: member.memberId,
      ...(member.taskId ? { taskId: member.taskId } : {}),
      since: member.spinnerOnlySince,
      summary: `${member.title} is showing spinner or status redraws without substantive screen changes.`,
    });
  }

  for (const member of activeMembers) {
    if (member.role !== "implementer" || member.status !== "reported" || member.report?.kind !== "result" || !member.taskId) continue;
    const position = run.tasks.findIndex(task => task.id === member.taskId);
    if (position <= 0) continue;
    const preceding = run.tasks.slice(0, position).filter(task => task.status !== "integrated").map(task => task.id);
    if (preceding.length === 0) continue;
    reasons.push({
      kind: "integration-order",
      taskId: member.taskId,
      memberId: member.memberId,
      blockedByTaskIds: preceding,
      ...(member.reportedAt ? { since: member.reportedAt } : {}),
      summary: `Task ${member.taskId} reported and is waiting to integrate after ${preceding.join(", ")}.`,
    });
  }

  if (run.status !== "blocked") {
    for (const task of run.tasks) {
      if ((task.revision ?? run.revision) !== run.revision || task.status !== "pending") continue;
      const blockedBy = task.dependsOn.filter(depId => run.tasks.find(item => item.id === depId)?.status !== "integrated");
      if (blockedBy.length === 0) continue;
      reasons.push({
        kind: "dependency",
        taskId: task.id,
        blockedByTaskIds: blockedBy,
        summary: `Task ${task.id} is waiting on dependencies: ${blockedBy.join(", ")}.`,
      });
    }

    let slotEmitted = false;
    if (run.discovery && !run.discovery.completedAt && run.discovery.revision === run.revision) {
      const scoutSlots = run.members.filter(
        member =>
          member.revision === run.revision &&
          member.role === "scout" &&
          (["queued", "running", "unavailable"].includes(member.status) || (member.status === "reported" && !member.exitConfirmedAt)),
      ).length;
      if (scoutSlots >= run.parallelism) {
        for (const scout of run.discovery.tasks) {
          if (scout.status !== "pending") continue;
          slotEmitted = true;
          reasons.push({
            kind: "worker-slot",
            taskId: scout.id,
            summary: `Scout ${scout.id} is waiting for an available worker slot (${scoutSlots}/${run.parallelism}).`,
          });
        }
      }
    }

    const workerCount = run.members.filter(member => holdsSlot(member, run.revision)).length;
    if (workerCount >= run.parallelism) {
      for (const task of run.tasks) {
        if ((task.revision ?? run.revision) !== run.revision || task.status !== "pending") continue;
        const ready = task.dependsOn.every(depId => run.tasks.find(item => item.id === depId)?.status === "integrated");
        if (!ready) continue;
        slotEmitted = true;
        reasons.push({
          kind: "worker-slot",
          taskId: task.id,
          summary: `Task ${task.id} is ready and waiting for a worker slot (${workerCount}/${run.parallelism}).`,
        });
      }
    }

    if (!slotEmitted && run.reason === SESSION_SLOT_REASON) {
      reasons.push({
        kind: "worker-slot",
        summary: SESSION_SLOT_REASON,
      });
    }
  }

  return reasons;
}
