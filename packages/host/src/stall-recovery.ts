import type { AttentionState } from "@infinite/attention";
import { memberLimit, type TeamMember, type TeamRun } from "./team-types.js";

export const MEMBER_STALL_REASON = "An agent showed no activity twice on the same assignment. Its workspace was preserved.";

const ACTIVE_STALL_RUN_STATUSES = new Set<TeamRun["status"]>([
  "planning",
  "discovering",
  "implementing",
  "integrating",
  "verifying",
  "reviewing",
  "delivering",
]);
const OPEN_PERMISSION_DECISION_STATUSES = new Set(["pending", "reviewing", "approved", "answering", "escalated", "uncertain"]);
const LIVE_PERMISSION_RECOVERY_STATUSES = new Set(["expanding", "diagnosing", "reviewing-evidence"]);

export type StallRecoveryGuard =
  | "current-assignment"
  | "eligible-cause"
  | "retry-budget"
  | "duplicate-suppression";

export type StallRecoveryDecision =
  | { action: "none"; guard: StallRecoveryGuard; reason: string }
  | { action: "wait"; guard: "eligible-cause"; reason: "journal-not-drained" }
  | { action: "report-won"; guard: "current-assignment"; reason: "member-reported" }
  | { action: "suppress-duplicate"; guard: "duplicate-suppression"; reason: "replacement-already-exists" }
  | { action: "end-replay"; reason: "stalled" }
  | { action: "initiate-stop" }
  | {
      action: "block";
      guard: StallRecoveryGuard;
      code: "delivery-reconciliation-required" | "member-stalled" | "team-attempt-limit" | "goal-deadline";
      message: string;
    }
  | { action: "replace"; editing: boolean };

export interface StallRecoveryInput {
  run: Pick<
    TeamRun,
    | "id"
    | "revision"
    | "status"
    | "members"
    | "tasks"
    | "discovery"
    | "decisions"
    | "permissionDecisions"
    | "permissionRecovery"
    | "goal"
    | "handoff"
    | "stopReason"
    | "replay"
  >;
  member: TeamMember;
  attentionState: AttentionState;
  quietForMs: number;
  stallWindowMs: number;
  journalDrained: boolean;
  hasDeliveryAttempt: boolean;
  nowMs: number;
  phase: "detect" | "replace";
}

export function evaluateStallRecovery(input: StallRecoveryInput): StallRecoveryDecision {
  const { run, member, attentionState, quietForMs, stallWindowMs, journalDrained, hasDeliveryAttempt, nowMs, phase } = input;

  if (run.members.some(item => item !== member && item.stalledSourceMemberId === member.memberId)) {
    return { action: "suppress-duplicate", guard: "duplicate-suppression", reason: "replacement-already-exists" };
  }

  if (!ACTIVE_STALL_RUN_STATUSES.has(run.status)) {
    return { action: "none", guard: "current-assignment", reason: "inactive-run-status" };
  }
  if (member.role === "permission-coordinator") {
    return { action: "none", guard: "current-assignment", reason: "permission-coordinator-excluded" };
  }
  if (member.revision !== run.revision) {
    return { action: "none", guard: "current-assignment", reason: "stale-revision" };
  }
  if (member.report) {
    return { action: "report-won", guard: "current-assignment", reason: "member-reported" };
  }
  if (member.status === "queued" || member.status === "waiting" || member.status === "reported") {
    return { action: "none", guard: "current-assignment", reason: "member-not-running" };
  }
  if (phase === "detect" && member.status === "stopped") {
    return { action: "none", guard: "current-assignment", reason: "member-already-stopped" };
  }
  if (member.role === "implementer") {
    const task = run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId);
    if (!task || (task.revision ?? run.revision) !== run.revision || task.status === "integrated") {
      return { action: "none", guard: "current-assignment", reason: "not-current-task-member" };
    }
  }
  if (member.role === "scout") {
    if (!run.discovery || run.discovery.revision !== run.revision || run.discovery.completedAt) {
      return { action: "none", guard: "current-assignment", reason: "discovery-inactive" };
    }
    const scout = run.discovery.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId);
    if (!scout || scout.status === "complete") {
      return { action: "none", guard: "current-assignment", reason: "not-current-scout-member" };
    }
  }
  const superseded = run.members.some(
    item =>
      item !== member &&
      item.revision === member.revision &&
      item.role === member.role &&
      item.taskId === member.taskId &&
      !item.stalledAt &&
      (item.report !== undefined || item.status === "queued" || item.status === "running" || item.status === "unavailable"),
  );
  if (superseded) {
    return { action: "none", guard: "current-assignment", reason: "already-superseded" };
  }

  if (!journalDrained) {
    return { action: "wait", guard: "eligible-cause", reason: "journal-not-drained" };
  }

  const memberPermissionDecisions = (run.permissionDecisions ?? []).filter(
    decision => decision.revision === run.revision && decision.targetMemberId === member.memberId,
  );
  if (memberPermissionDecisions.some(decision => decision.status === "uncertain")) {
    return { action: "none", guard: "eligible-cause", reason: "uncertain-permission-decision" };
  }

  const hasOpenOwnerDecision = run.decisions.some(
    decision => decision.revision === run.revision && !decision.answer && decision.memberId === member.memberId,
  );
  const hasOpenPermissionDecision = memberPermissionDecisions.some(decision => OPEN_PERMISSION_DECISION_STATUSES.has(decision.status));
  const hasLivePermissionRecovery = (run.permissionRecovery?.requests ?? []).some(
    request => request.revision === run.revision && request.targetMemberId === member.memberId && LIVE_PERMISSION_RECOVERY_STATUSES.has(request.status),
  );

  if (!member.stalledAt) {
    if (attentionState === "needs-you") {
      return { action: "none", guard: "eligible-cause", reason: "waiting-on-prompt" };
    }
    if (member.pendingLimit) {
      return { action: "none", guard: "eligible-cause", reason: "waiting-on-limit" };
    }
    if (hasOpenOwnerDecision) {
      return { action: "none", guard: "eligible-cause", reason: "waiting-on-owner-decision" };
    }
    if (hasOpenPermissionDecision) {
      return { action: "none", guard: "eligible-cause", reason: "waiting-on-permission-decision" };
    }
    if (hasLivePermissionRecovery) {
      return { action: "none", guard: "eligible-cause", reason: "waiting-on-permission-recovery" };
    }
    if (quietForMs <= stallWindowMs) {
      return { action: "none", guard: "eligible-cause", reason: "within-stall-window" };
    }
  }

  if (phase === "detect") {
    if (run.replay) {
      return { action: "end-replay", reason: "stalled" };
    }
    return { action: "initiate-stop" };
  }

  if (run.replay) {
    return { action: "end-replay", reason: "stalled" };
  }
  if (member.role === "delivery" && hasDeliveryAttempt) {
    return {
      action: "block",
      guard: "eligible-cause",
      code: "delivery-reconciliation-required",
      message: "The delivery agent stalled after a publication attempt. Inspect the remote branch and PR before replacing it.",
    };
  }

  const priorStalled = run.members.some(
    item =>
      item !== member &&
      item.revision === member.revision &&
      item.role === member.role &&
      item.taskId === member.taskId &&
      Boolean(item.stalledAt),
  );
  if (priorStalled) {
    return {
      action: "block",
      guard: "retry-budget",
      code: "member-stalled",
      message: MEMBER_STALL_REASON,
    };
  }

  const limit = memberLimit(run);
  if (run.stopReason === "member-limit" || run.members.length + 1 > limit) {
    return {
      action: "block",
      guard: "retry-budget",
      code: "team-attempt-limit",
      message: `The team reached its limit of ${limit} agent attempts. Review its evidence before continuing.`,
    };
  }

  const budget = run.goal ?? run.handoff;
  const canExtendDeadline = Boolean(
    budget?.extendMinutes &&
      budget.ceilingAt &&
      nowMs < Date.parse(budget.ceilingAt) &&
      run.members.some(
        item =>
          item.revision === run.revision &&
          item.status === "running" &&
          !item.report &&
          !item.pendingLimit &&
          item.lastActivityAt &&
          nowMs - Date.parse(item.lastActivityAt) <= stallWindowMs,
      ),
  );
  if (run.stopReason === "deadline" || (budget && nowMs >= Date.parse(budget.deadlineAt) && !canExtendDeadline)) {
    return {
      action: "block",
      guard: "retry-budget",
      code: "goal-deadline",
      message: "The goal reached its deadline. Active work is being stopped and retained for inspection.",
    };
  }

  return {
    action: "replace",
    editing: member.role === "implementer" || member.role === "integrator",
  };
}
