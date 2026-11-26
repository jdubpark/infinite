import type { ProviderLimit } from "./provider-limits.js";
import { MEMBER_STALL_REASON, type LivePromptRef } from "./stall-recovery.js";
import { isDeferredWorkerMember, PROVIDER_LIMIT_HOLD_PREFIX } from "./team-diagnostics.js";
import { ACTIVE_MEMBER_STATUSES, type TeamPermissionDecision, type TeamRun, type TeamView, type TeamWaitReason, type TeamWaitReasonKind } from "./team-types.js";

export const MAX_WAIT_REASON_SUMMARY = 240;

const WAIT_REASON_ORDER: Record<TeamWaitReasonKind, number> = {
  "owner-decision": 0,
  "provider-prompt": 1,
  stalled: 2,
  "spinner-only": 3,
  "provider-limit": 4,
  "worker-slot": 5,
  dependency: 6,
  "integration-order": 7,
  "linear-sync": 8,
};

function clipSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_WAIT_REASON_SUMMARY) return collapsed;
  return `${collapsed.slice(0, MAX_WAIT_REASON_SUMMARY - 3)}...`;
}

export function orderTeamWaitReasons<T extends { kind?: unknown }>(reasons: readonly T[]): T[] {
  return reasons
    .map((reason, index) => ({ reason, index }))
    .sort((left, right) => {
      const a = WAIT_REASON_ORDER[String(left.reason?.kind ?? "") as TeamWaitReasonKind] ?? 99;
      const b = WAIT_REASON_ORDER[String(right.reason?.kind ?? "") as TeamWaitReasonKind] ?? 99;
      return a - b || left.index - right.index;
    })
    .map(item => item.reason);
}

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
  permissionDecisions?: readonly Pick<
    TeamPermissionDecision,
    "id" | "revision" | "targetMemberId" | "targetSessionId" | "promptId" | "promptHash" | "status" | "promptClosedAt"
  >[];
};

export interface DescribeTeamWaitReasonsOptions {
  livePrompts?: ReadonlyMap<string, LivePromptRef | null>;
}

function holdsSlot(member: TeamView["members"][number], revision: number): boolean {
  return (
    member.revision === revision &&
    (member.role === "scout" || member.role === "implementer") &&
    ((!isDeferredWorkerMember(member) && ["queued", "running", "unavailable"].includes(member.status)) ||
      (member.status === "reported" && !member.exitConfirmedAt))
  );
}

export function describeTeamWaitReasons(
  run: WaitReasonsRun,
  providerLimits: readonly ProviderLimit[],
  nowMs = Date.now(),
  options?: DescribeTeamWaitReasonsOptions,
): TeamWaitReason[] {
  if (TERMINAL_STATUSES.has(run.status) || run.status === "paused") return [];

  const reasons: TeamWaitReason[] = [];
  const activeMembers = run.members.filter(
    member => member.revision === run.revision && ACTIVE_MEMBER_STATUSES.includes(member.status),
  );
  const blocked = run.status === "blocked";
  const livePrompts = options?.livePrompts;

  if (!blocked && run.linearTracking) {
    if (run.linear && run.linear.status !== "synced" && run.linear.status !== "blocked") {
      reasons.push({
        kind: "linear-sync",
        summary: run.linear.reason ? `Waiting on Linear sync: ${run.linear.reason}` : "Waiting for Linear tracking confirmation.",
        ...(run.linear.checkedAt ? { since: run.linear.checkedAt } : {}),
      });
    } else if (!run.linear) {
      reasons.push({
        kind: "linear-sync",
        summary: "Waiting for initial Linear tracking confirmation.",
      });
    }
  }

  const promptedMemberIds = new Set<string>();
  if (!blocked) {
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

    const latestPermissionByTarget = new Map<string, { decision: NonNullable<WaitReasonsRun["permissionDecisions"]>[number]; target: TeamView["members"][number] }>();
    for (const decision of run.permissionDecisions ?? []) {
      if (decision.revision !== run.revision || !OPEN_PERMISSION_STATUSES.has(decision.status)) continue;
      if (decision.status !== "uncertain" && decision.promptClosedAt !== undefined) continue;
      const target = activeMembers.find(
        member => member.memberId === decision.targetMemberId && member.sessionId === decision.targetSessionId && !member.report,
      );
      if (!target) continue;
      if (decision.status !== "uncertain" && livePrompts?.has(target.sessionId)) {
        const live = livePrompts.get(target.sessionId);
        if (!live || live.id !== decision.promptId || (live.hash !== undefined && live.hash !== decision.promptHash)) continue;
      }
      latestPermissionByTarget.set(target.memberId, { decision, target });
    }
    for (const { decision, target } of latestPermissionByTarget.values()) {
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
  }

  const activeLimits = providerLimits.filter(limit => Date.parse(limit.expiresAt) > nowMs);
  const activeUnreported = activeMembers.filter(member => !member.report);
  if (blocked) {
    if (run.blockCode === "provider-limit") {
      for (const limit of activeLimits) {
        const matched = run.members.find(
          member =>
            member.revision === run.revision &&
            (member.sessionId === limit.sessionId ||
              (member.pendingLimit === true && (member.modelProfile?.provider ?? member.provider ?? run.provider) === limit.provider)),
        );
        const relevant = limit.runId === run.id || limit.provider === run.provider || Boolean(matched);
        if (!relevant) continue;
        reasons.push({
          kind: "provider-limit",
          ...(matched ? { memberId: matched.memberId, ...(matched.taskId ? { taskId: matched.taskId } : {}) } : {}),
          since: limit.detectedAt,
          ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          summary: `Provider ${limit.provider} limit active${limit.resetsAt ? `, resets ${limit.resetsAt}` : ""}.`,
        });
      }
    }
  } else {
    let emittedLimit = false;
    for (const member of activeUnreported) {
      const provider = member.modelProfile?.provider ?? member.provider ?? run.provider;
      const observedLimit = activeLimits.find(limit => limit.sessionId === member.sessionId);
      if (!member.pendingLimit && !observedLimit) continue;
      emittedLimit = true;
      const matchedLimit = observedLimit ?? activeLimits.find(limit => limit.provider === provider);
      if (matchedLimit) {
        reasons.push({
          kind: "provider-limit",
          memberId: member.memberId,
          ...(member.taskId ? { taskId: member.taskId } : {}),
          since: matchedLimit.detectedAt,
          ...(matchedLimit.resetsAt ? { resetsAt: matchedLimit.resetsAt } : {}),
          summary: `Provider ${matchedLimit.provider} limit active${matchedLimit.resetsAt ? `, resets ${matchedLimit.resetsAt}` : ""}.`,
        });
      } else {
        reasons.push({
          kind: "provider-limit",
          memberId: member.memberId,
          ...(member.taskId ? { taskId: member.taskId } : {}),
          summary: `${member.title} is observing a pending ${provider} limit.`,
        });
      }
    }
    if (!emittedLimit && activeUnreported.length === 0) {
      const limitHeld = Boolean(run.reason?.startsWith(PROVIDER_LIMIT_HOLD_PREFIX));
      for (const limit of activeLimits) {
        if (limit.runId !== run.id && !(limitHeld && limit.provider === run.provider)) continue;
        reasons.push({
          kind: "provider-limit",
          since: limit.detectedAt,
          ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          summary: `Provider ${limit.provider} limit active${limit.resetsAt ? `, resets ${limit.resetsAt}` : ""}.`,
        });
      }
    }
  }

  const stalledActive = blocked ? [] : activeUnreported.filter(member => Boolean(member.stalledAt));
  for (const member of stalledActive) {
    reasons.push({
      kind: "stalled",
      memberId: member.memberId,
      ...(member.taskId ? { taskId: member.taskId } : {}),
      since: member.stalledAt,
      summary: `${member.title} stalled without substantive activity and is stopping.`,
    });
  }
  if (stalledActive.length === 0 && blocked && (run.blockCode === "member-stalled" || run.reason === MEMBER_STALL_REASON)) {
    const lastStalled = [...run.members].reverse().find(member => member.revision === run.revision && Boolean(member.stalledAt));
    reasons.push({
      kind: "stalled",
      ...(lastStalled ? { memberId: lastStalled.memberId, ...(lastStalled.taskId ? { taskId: lastStalled.taskId } : {}), since: lastStalled.stalledAt } : {}),
      summary: run.reason ?? MEMBER_STALL_REASON,
    });
  }

  if (!blocked) {
    for (const member of activeUnreported) {
      if (member.stalledAt || !member.spinnerOnlySince || promptedMemberIds.has(member.memberId) || member.pendingLimit) continue;
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
    for (const member of activeMembers) {
      if (member.status !== "queued" || member.pendingCapacity !== true) continue;
      slotEmitted = true;
      reasons.push({
        kind: "worker-slot",
        memberId: member.memberId,
        ...(member.taskId ? { taskId: member.taskId } : {}),
        summary: `${member.title} is waiting for an available worker capacity slot.`,
      });
    }
    if (run.discovery && !run.discovery.completedAt && run.discovery.revision === run.revision) {
      const scoutSlots = run.members.filter(member => member.role === "scout" && holdsSlot(member, run.revision)).length;
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

  return orderTeamWaitReasons(reasons).map(reason => ({
    ...reason,
    summary: clipSummary(reason.summary),
  }));
}
