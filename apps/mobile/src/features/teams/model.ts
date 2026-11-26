import type { StatusKind } from "../../status";
import type { OwnerRating, Rubric, TaskUsage } from "../cost/model";

export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "delivering" | "merged" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";
export type TeamRole = "project-manager" | "intent-checker" | "permission-coordinator" | "scout" | "implementer" | "integrator" | "reviewer" | "delivery" | "evaluator";
export type TeamCommand = { command: string; args: string[] };
export type ModelProfile = { id: string; label: string; provider: string; model: string; effort?: string; variant?: string; tier?: "light" | "strong"; dataUse?: "standard" | "contributor" };
export type TeamLineup = { coordinator: ModelProfile; integrator: ModelProfile; reviewer: ModelProfile; implementers: ModelProfile[]; escalations?: ModelProfile[]; fallbacks?: ModelProfile[] };
export type LinearTracking = { status: "pending" | "synced" | "blocked" | "error"; reason?: string; checkedAt?: string; issue?: { identifier: string; url: string; title: string; state: { name: string } } };
export type TeamEvidence = { source: string; observation: string };
export type TeamBrief = { title: string; problem: string; evidence: TeamEvidence[]; dataShape: string; acceptance: string[]; expectedOutcome: string; uiChanges: boolean };
export type TeamCriterion = {
  id: string;
  statement: string;
  check: string;
  producer: "host" | "evaluator" | "owner";
  derived?: true;
};
export type TeamRecordDigest = {
  version: number;
  criteria: TeamCriterion[];
};
export type TeamTaskCriterionRefs = {
  objectiveVersion: number;
  criteria: string[];
};
export type TeamAcceptanceEvidence = {
  criterion: number;
  verdict: "verified" | "not-verified" | "inconclusive";
  evidence: string;
};
export type TeamRunAssessment = {
  verdictId: string;
  revision: number;
  head: string;
  kind: "reviewed" | "no-change";
  result: "met" | "not-met" | "inconclusive";
  evaluatorResult?: "met" | "not-met" | "inconclusive";
  reason?: "no-independent-evaluator" | "evaluator-unavailable" | "record-unavailable" | "context-too-large";
  counts: { met: number; notMet: number; inconclusive: number; pendingOwner: number };
  criteria: { id: string; state: "met" | "not-met" | "inconclusive" | "pending-owner" }[];
  at: string;
};
export type TeamTask = {
  id: string; title: string; instructions: string; paths: string[]; dependsOn: string[];
  status: "pending" | "running" | "waiting" | "integrated" | "blocked";
  memberId?: string; commit?: string; summary?: string; limitations?: string[]; agentProfileId?: string;
  criterionRefs?: TeamTaskCriterionRefs;
  escalation?: { toProfileId: string; reason: string };
  usage?: TaskUsage; ownerRating?: OwnerRating; rubric?: Rubric;
};
export type TeamContinuation = { revision: number; requestId: string; at: string; reason: string; headCommit: string; tasks: TeamTask[]; review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string; acceptance?: TeamAcceptanceEvidence[] }; brief?: TeamBrief };
export type TeamMember = {
  memberId: string; sessionId: string; role: TeamRole; revision: number; title: string; status: string;
  taskId?: string; provider?: string; modelProfile?: ModelProfile; stoppedReason?: string;
  startedAt?: string; reportedAt?: string; lastActivityAt?: string; spinnerOnlySince?: string; stalledAt?: string;
};
export type TeamWaitReasonKind =
  | "worker-slot"
  | "dependency"
  | "owner-decision"
  | "provider-prompt"
  | "provider-limit"
  | "integration-order"
  | "linear-sync"
  | "spinner-only"
  | "stalled";
export type TeamWaitReason = {
  kind: TeamWaitReasonKind;
  summary: string;
  taskId?: string;
  memberId?: string;
  decisionId?: string;
  blockedByTaskIds?: string[];
  since?: string;
  resetsAt?: string;
};
export type TeamDecision = { id: string; memberId: string; revision: number; question: string; options: string[]; createdAt: string; answer?: string; answeredAt?: string; answeredBy?: "owner" | "coordinator" | "connector"; source?: { kind: "connector"; id: string; name: string }; recommendation?: { answers: string[]; reason: string; outcome?: "matched" | "different" | "other" } };
export type TeamWorkers = { limit: number; max: number; running: number; ready: number };
export type PermissionDecision = { id: string; revision: number; targetMemberId: string; targetSessionId: string; promptId: number; expiresAt: string; status: "pending" | "reviewing" | "approved" | "answering" | "answered" | "escalated" | "stale" | "uncertain"; reason?: string };
export type TeamCheck = { command: TeamCommand; phase?: "setup"; headCommit?: string; round?: number; status: "running" | "passed" | "failed" | "interrupted"; startedAt: string; finishedAt?: string; exitCode?: number | null; output: string; revision: number };
export type TeamView = {
  id: string; projectId: string; provider: string; title: string; objective: string; parallelism: number;
  workers?: TeamWorkers;
  waitReasons?: TeamWaitReason[];
  revision: number; status: TeamStatus; createdAt: string; updatedAt: string; workspace: string;
  branch: string; baseCommit: string; headCommit?: string; tasks: TeamTask[]; members: TeamMember[];
  decisions: TeamDecision[]; checks: TeamCheck[]; steering: { text: string; revision: number; at: string; source?: { kind: "connector" | "github-review"; id: string; name: string } | "coordinator" | "slack" }[];
  events: { at: string; text: string }[]; reason?: string; round: number;
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string; acceptance?: TeamAcceptanceEvidence[] };
  assessment?: TeamRunAssessment;
  deliveryReceipt?: { revision: number; headCommit: string; pullRequestUrl: string; mergeCommit: string; summary: string; reportedAt: string };
  pullRequest?: { revision: number; headCommit: string; pullRequestUrl: string; summary: string; reportedAt: string };
  lineup?: TeamLineup; linear?: LinearTracking; brief?: TeamBrief;
  goal?: { id: string; revision: number; cycle: number; successCriteria?: string; record?: TeamRecordDigest };
  missionId?: string;
  noChange?: { summary: string; evidence: TeamEvidence[] };
  resumable?: boolean;
  continuable?: boolean;
  continuations?: TeamContinuation[];
  delivery?: { mode: "merge"; repository: string; baseBranch: string };
  permissions?: { mode: "coordinator"; scope: string; maxDecisions: number };
  permissionsRevokedAt?: string;
  permissionDecisions?: PermissionDecision[];
};
export type TeamListItem = Pick<TeamView, "id" | "projectId" | "provider" | "title" | "parallelism" | "workers" | "waitReasons" | "revision" | "status" | "createdAt" | "updatedAt"
  | "workspace" | "branch" | "baseCommit" | "headCommit" | "decisions" | "events" | "reason" | "linear" | "goal" | "missionId" | "resumable" | "continuable" | "permissionsRevokedAt"> & {
  members: (Omit<TeamMember, "modelProfile"> & { modelProfile?: Pick<ModelProfile, "label" | "provider" | "tier"> })[];
  tasks: Pick<TeamTask, "id" | "title" | "status" | "paths" | "memberId" | "ownerRating">[];
  checks: Pick<TeamCheck, "status" | "revision">[];
  lineup?: Pick<TeamLineup, "coordinator">;
  review?: Pick<NonNullable<TeamView["review"]>, "verdict" | "revision">;
  deliveryReceipt?: Omit<NonNullable<TeamView["deliveryReceipt"]>, "summary">;
  pullRequest?: Omit<NonNullable<TeamView["pullRequest"]>, "summary">;
  permissions?: Pick<NonNullable<TeamView["permissions"]>, "mode" | "maxDecisions">;
  permissionDecisions?: Pick<PermissionDecision, "targetSessionId" | "promptId" | "status">[];
};

export function workerStatus(team: Pick<TeamView, "parallelism" | "workers">): string {
  if (!team.workers) return `Up to ${team.parallelism} workers`;
  const { running, limit, ready } = team.workers;
  const status = `${running} of ${limit} workers running`;
  if (ready > 0 && running >= limit) return `${status} · ${ready} ready task${ready === 1 ? "" : "s"} waiting for a worker`;
  return status;
}

export function blockedTeamsFirst<T extends Pick<TeamListItem, "status">>(teams: T[]) {
  return teams.map((team, index) => ({ team, index }))
    .sort((a, b) => Number(b.team.status === "blocked") - Number(a.team.status === "blocked") || a.index - b.index)
    .map(({ team }) => team);
}

export function canResumeBlockedTeam(team: TeamListItem, role: DeviceRole | undefined) {
  return role === "owner" && team.status === "blocked" && team.resumable === true && team.continuable !== true && !team.goal && !team.missionId && !team.deliveryReceipt && !team.pullRequest;
}

export function canContinueBlockedTeam(team: TeamListItem, role: DeviceRole | undefined) {
  return role === "owner" && team.status === "blocked" && team.continuable === true
    && !team.goal && !team.missionId && !team.deliveryReceipt && !team.pullRequest;
}

export type GoalStatus = "running" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-opportunity" | "limit-reached" | "cancelled" | "achieved";
export type GoalResult = "achieved" | "not-achieved" | "inconclusive";
export type GoalCycle = { teamId: string; cycle: number; goalRevision: number; status: string; startedAt: string; finishedAt?: string; branch?: string; headCommit?: string; brief?: TeamBrief; reason?: string; memberCount: number };
export type ProductGoal = {
  id: string; projectId: string; title: string; objective: string; successCriteria: string;
  nonGoals: string[]; allowedPaths: string[]; evidence: string[];
  maxRuns: number; maxMinutes: number; maxMembers: number; parallelism: number;
  revision: number; status: GoalStatus; reason?: string; createdAt: string; updatedAt: string; deadlineAt: string;
  lineup: TeamLineup; linear?: LinearTracking; activeTeamId?: string; cycles: GoalCycle[]; memberCount: number;
  steering: { text: string; revision: number; at: string }[]; events: { at: string; text: string }[];
  outcomes: { result: GoalResult; summary: string; evidence: string; at: string; revision: number }[];
  tasks?: { teamId: string; taskId: string; title: string; usage?: TaskUsage }[];
};

export type DeviceRole = "owner" | "controller" | "viewer";
export type TeamProject = { id: string; name: string; linear?: { enabled: boolean }; team?: { establishChecks?: true; checks: TeamCommand[]; setup?: TeamCommand } };

export const TEAM_LABELS: Record<TeamStatus, string> = {
  planning: "Planning", discovering: "Investigating", implementing: "Implementing", integrating: "Integrating",
  verifying: "Running checks", reviewing: "Reviewing", "needs-input": "Needs your input", paused: "Paused",
  delivering: "Delivering", merged: "Merge reported", blocked: "Blocked", "ready-for-review": "Ready for your review", "no-change": "No change proposed", cancelled: "Cancelled",
};
export const GOAL_LABELS: Record<GoalStatus, string> = {
  running: "Working", "needs-input": "Needs your input", paused: "Paused", blocked: "Blocked",
  "ready-for-review": "Ready for your review", "no-opportunity": "No opportunity found", "limit-reached": "Limit reached",
  cancelled: "Cancelled", achieved: "Outcome recorded: achieved",
};
export const OUTCOME_LABELS: Record<GoalResult, string> = { achieved: "Achieved", "not-achieved": "Not achieved", inconclusive: "Inconclusive" };
export const ROLE_NAMES: Record<TeamRole, string> = { "project-manager": "Coordinator", "intent-checker": "Intent checker", "permission-coordinator": "Permission coordinator", scout: "Scout", implementer: "Implementer", integrator: "Integrator", reviewer: "Reviewer", delivery: "Delivery", evaluator: "Evaluator" };

export type Tone = "amber" | "forest" | "muted" | "error";
export function teamTone(status: TeamStatus): Tone {
  if (status === "needs-input" || status === "paused") return "amber";
  if (status === "blocked") return "error";
  if (status === "cancelled" || status === "no-change") return "muted";
  return "forest";
}

export function newer<T extends { revision: number; updatedAt: string }>(previous: T | null, next: T): T {
  if (!previous || next.revision > previous.revision || (next.revision === previous.revision && next.updatedAt >= previous.updatedAt)) return next;
  return previous;
}

export function openDecisions(team: TeamListItem) {
  return team.decisions.filter(decision => decision.revision === team.revision && decision.answer == null);
}

export function teamProgress(team: TeamListItem) {
  return { done: team.tasks.filter(task => task.status === "integrated").length, total: team.tasks.length };
}

const PHASE_FLOOR: Partial<Record<TeamStatus, number>> = {
  planning: 0.25, discovering: 0.25, implementing: 0.25, integrating: 0.5, verifying: 0.75, reviewing: 0.75, delivering: 1,
};

export function teamKind(team: TeamListItem, approvals = 0): { kind: StatusKind; fraction: number } {
  if (team.status === "cancelled") return { kind: "cancelled", fraction: 0 };
  if (team.status === "no-change") return { kind: "stopped", fraction: 0 };
  if (team.status === "paused") return { kind: "paused", fraction: 0 };
  if (team.status === "blocked") return { kind: "blocked", fraction: 0 };
  if ((!team.missionId && (team.status === "needs-input" || openDecisions(team).length)) || approvals) return { kind: "attention", fraction: 0 };
  if (team.status === "ready-for-review" || team.status === "merged") return { kind: "review", fraction: 1 };
  const { done, total } = teamProgress(team);
  return { kind: "progress", fraction: Math.max(PHASE_FLOOR[team.status] ?? 0.25, total ? done / total : 0) };
}

export function goalKind(goal: ProductGoal): { kind: StatusKind; fraction: number } {
  switch (goal.status) {
    case "needs-input": return { kind: "attention", fraction: 0 };
    case "paused": case "limit-reached": return { kind: "paused", fraction: 0 };
    case "blocked": return { kind: "blocked", fraction: 0 };
    case "ready-for-review": return { kind: "review", fraction: 1 };
    case "achieved": return { kind: "done", fraction: 1 };
    case "cancelled": return { kind: "cancelled", fraction: 0 };
    case "no-opportunity": return { kind: "stopped", fraction: 0 };
    default: return { kind: "progress", fraction: Math.max(0.25, goal.maxRuns ? goal.cycles.length / goal.maxRuns : 0) };
  }
}

export type RunGroup = "attention" | "active" | "review" | "closed";
export const RUN_GROUPS: { group: RunGroup; title: string; kind: StatusKind }[] = [
  { group: "attention", title: "Needs you", kind: "attention" },
  { group: "active", title: "In progress", kind: "progress" },
  { group: "review", title: "For review", kind: "review" },
  { group: "closed", title: "Closed", kind: "cancelled" },
];

export function teamGroup(team: TeamListItem, approvals = 0): RunGroup {
  if (team.status === "cancelled" || team.status === "no-change") return "closed";
  if (team.status === "needs-input" || team.status === "blocked" || openDecisions(team).length || approvals) return "attention";
  if (team.status === "ready-for-review" || team.status === "merged") return "review";
  return "active";
}

export function goalGroup(goal: ProductGoal): RunGroup {
  if (["cancelled", "no-opportunity", "achieved"].includes(goal.status)) return "closed";
  if (["needs-input", "blocked", "limit-reached"].includes(goal.status)) return "attention";
  if (goal.status === "ready-for-review") return "review";
  return "active";
}

export function groupRuns<T>(items: T[], groupOf: (item: T) => RunGroup) {
  return RUN_GROUPS.map(entry => ({ ...entry, items: items.filter(item => groupOf(item) === entry.group) })).filter(entry => entry.items.length);
}

export const TASK_LABELS: Record<TeamTask["status"], string> = { pending: "To do", running: "In progress", waiting: "Waiting", integrated: "Integrated", blocked: "Blocked" };
const TASK_ORDER: TeamTask["status"][] = ["blocked", "running", "waiting", "pending", "integrated"];

export function taskKind(task: TeamTask, tasks: TeamTask[]): StatusKind {
  switch (task.status) {
    case "running": return "progress";
    case "waiting": return "paused";
    case "integrated": return "done";
    case "blocked": return "blocked";
    default: return task.dependsOn.some(id => tasks.find(other => other.id === id)?.status !== "integrated") ? "backlog" : "todo";
  }
}

export function taskGroups(tasks: TeamTask[]) {
  return TASK_ORDER.map(status => ({ status, title: TASK_LABELS[status], tasks: tasks.filter(task => task.status === status) })).filter(group => group.tasks.length);
}

export const MEMBER_LABELS: Record<string, string> = { queued: "Queued", running: "Working", waiting: "Waiting", reported: "Reported", stopped: "Stopped", unavailable: "Unreachable" };
export function memberKind(status: string): StatusKind {
  switch (status) {
    case "running": return "progress";
    case "waiting": return "paused";
    case "reported": return "review";
    case "stopped": return "stopped";
    case "unavailable": return "error";
    default: return "todo";
  }
}

export type WaitingSession = { id: string; attention: { state: string; prompt?: { id: number; kind: string; destructive?: unknown; multiSelect?: boolean; delegable?: boolean } } };

export function approvalOwner(team: TeamListItem, sessionId: string, prompt?: WaitingSession["attention"]["prompt"]): "coordinator" | "person" {
  const decision = [...(team.permissionDecisions ?? [])].reverse().find(item => item.targetSessionId === sessionId && item.promptId === prompt?.id);
  if (decision) return ["pending", "reviewing", "approved", "answering"].includes(decision.status) ? "coordinator" : "person";
  const delegated = Boolean(team.permissions) && !team.permissionsRevokedAt && (team.permissionDecisions?.length ?? 0) < (team.permissions?.maxDecisions ?? 0);
  return delegated && team.lineup?.coordinator.tier === "strong" && prompt?.delegable === true && prompt.kind === "permission" && !prompt.destructive && !prompt.multiSelect ? "coordinator" : "person";
}

export function pendingApprovals<M extends TeamListItem["members"][number], S extends WaitingSession>(team: Omit<TeamListItem, "members"> & { members: M[] }, sessions: S[]) {
  const listed = new Map(sessions.map(session => [session.id, session]));
  return team.members.flatMap(member => {
    const session = listed.get(member.sessionId);
    if (member.revision !== team.revision || !["running", "waiting"].includes(member.status) || session?.attention.state !== "needs-you") return [];
    return approvalOwner(team, member.sessionId, session.attention.prompt) === "person" ? [{ member, session }] : [];
  });
}

export type PhaseState = "done" | "current" | "todo";
export function teamPhases(team: TeamView): { label: string; state: PhaseState }[] {
  const labels = ["Plan", "Build", "Integrate", "Check", "Review", ...(team.delivery || team.status === "delivering" || team.status === "merged" || team.deliveryReceipt ? ["Deliver"] : [])];
  const byStatus: Partial<Record<TeamStatus, number>> = { planning: 0, discovering: 0, implementing: 1, integrating: 2, verifying: 3, reviewing: 4, delivering: 5 };
  const reviewed = team.review?.revision === team.revision && team.review.verdict === "approved";
  const finished = team.status === "merged" || Boolean(team.deliveryReceipt) || (team.status === "ready-for-review" && reviewed && labels.length === 5);
  let current = byStatus[team.status]
    ?? (team.status === "ready-for-review" ? labels.length - 1
      : !team.tasks.length ? 0
        : team.tasks.some(task => task.status !== "integrated") ? 1
          : team.review?.revision === team.revision ? 4
            : team.checks.some(check => check.revision === team.revision) ? 3 : 2);
  current = Math.min(current, labels.length - 1);
  return labels.map((label, index) => ({ label, state: finished || index < current ? "done" : index === current ? "current" : "todo" }));
}

export function teamReady(project?: TeamProject) {
  return Boolean(project?.team?.checks.length || project?.team?.establishChecks);
}

export function profileSetting(profile: ModelProfile) {
  return profile.provider === "opencode" ? (profile.variant ? `variant ${profile.variant}` : "default variant") : `effort ${profile.effort}`;
}

export function teamControls(team: TeamView, role: DeviceRole | undefined, fresh: boolean) {
  const acts = fresh && role !== undefined && role !== "viewer";
  const managed = Boolean(team.missionId);
  const owns = fresh && role === "owner" && !team.goal && !managed && team.status !== "cancelled";
  const deliveryStarted = team.status === "delivering" || team.status === "merged" || Boolean(team.deliveryReceipt);
  const deliveryReported = team.status === "merged" || Boolean(team.deliveryReceipt);
  const orphanBlocked = fresh && role === "owner" && team.status === "blocked" && Boolean(team.goal || managed);
  return {
    answer: acts && !managed && !["paused", "cancelled"].includes(team.status),
    steer: acts && !managed && !team.goal && team.status !== "cancelled" && !deliveryStarted && !canContinueBlockedTeam(team, "owner"),
    pause: owns && !deliveryReported && !["paused", "blocked", "ready-for-review", "no-change", "merged"].includes(team.status),
    resume: owns && (team.status === "paused" || team.resumable === true) && !deliveryReported && !canContinueBlockedTeam(team, "owner"),
    cancel: owns || orphanBlocked,
  };
}

export function goalStopped(goal: ProductGoal) {
  return !goal.activeTeamId && ["blocked", "ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"].includes(goal.status);
}

export function goalControls(goal: ProductGoal, role: DeviceRole | undefined, fresh: boolean, now = 0) {
  const acts = fresh && role !== undefined && role !== "viewer";
  const owns = fresh && role === "owner" && !["cancelled", "achieved"].includes(goal.status);
  return {
    steer: acts && ["running", "needs-input"].includes(goal.status),
    pause: owns && ["running", "needs-input"].includes(goal.status),
    resume: owns && goal.status === "paused" && now < Date.parse(goal.deadlineAt),
    cancel: owns,
    outcome: acts && goalStopped(goal),
  };
}

export function lines(value: string) {
  return value.split("\n").map(line => line.trim()).filter(Boolean);
}

export function directionSourceLabel(source: { kind: string; name: string } | string | undefined): string {
  if (typeof source === "object") return source.kind === "github-review" ? "Owner (GitHub review)" : source.name;
  return source === "coordinator" ? "Mission coordinator" : "You";
}

export function shortDate(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
