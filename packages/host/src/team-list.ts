import type { LinearIssueView } from "./linear-types.js";
import type { TeamModelProfile, TeamView } from "./team-types.js";
import type { UsageTotals } from "./usage.js";

type ViewMember = TeamView["members"][number];
type ViewTask = TeamView["tasks"][number];
type ViewPermissionDecision = NonNullable<TeamView["permissionDecisions"]>[number];

export const LIST_CHANGED_PATHS = 20;

export type TeamListMember = Pick<ViewMember, "memberId" | "sessionId" | "role" | "revision" | "title" | "status" | "taskId" | "provider"
  | "startedAt" | "reportedAt" | "lastActivityAt" | "spinnerOnlySince" | "pendingLimit" | "stalledAt" | "stoppedReason"> & {
  modelProfile?: Pick<TeamModelProfile, "label" | "provider" | "tier">;
  usage?: Pick<UsageTotals, "cost">;
};
export type TeamListTask = Pick<ViewTask, "id" | "title" | "status" | "paths" | "dependsOn" | "memberId" | "changedPaths" | "ownerRating">;

export type TeamListItem = Pick<TeamView, "id" | "projectId" | "provider" | "title" | "status" | "revision" | "parallelism" | "createdAt" | "updatedAt" | "lastActivityAt"
  | "workspace" | "branch" | "baseCommit" | "headCommit" | "reason" | "missionId" | "permissionsRevokedAt" | "decisions" | "workers" | "waitReasons" | "resumable" | "continuable"> & {
  members: TeamListMember[];
  tasks: TeamListTask[];
  checks: Pick<TeamView["checks"][number], "command" | "phase" | "status" | "revision">[];
  events: TeamView["events"];
  lineup?: Pick<NonNullable<TeamView["lineup"]>, "coordinator">;
  goal?: Pick<NonNullable<TeamView["goal"]>, "id" | "revision" | "cycle">;
  linear?: Omit<NonNullable<TeamView["linear"]>, "issue"> & { issue?: Pick<LinearIssueView, "identifier" | "url" | "title" | "state"> };
  review?: Pick<NonNullable<TeamView["review"]>, "verdict" | "revision">;
  discovery?: Pick<NonNullable<TeamView["discovery"]>, "revision">;
  deliveryReceipt?: Omit<NonNullable<TeamView["deliveryReceipt"]>, "summary">;
  pullRequest?: Omit<NonNullable<TeamView["pullRequest"]>, "summary">;
  permissions?: Pick<NonNullable<TeamView["permissions"]>, "mode" | "maxDecisions">;
  permissionDecisions?: Pick<ViewPermissionDecision, "targetSessionId" | "promptId" | "status">[];
  usage: Pick<TeamView["usage"], "total" | "unmeasuredMembers">;
};

function memberRow(member: ViewMember): TeamListMember {
  const { memberId, sessionId, role, revision, title, status, taskId, provider, startedAt, reportedAt, lastActivityAt, spinnerOnlySince, pendingLimit, stalledAt, stoppedReason, modelProfile, usage } = member;
  return {
    memberId, sessionId, role, revision, title, status, taskId, provider, startedAt, reportedAt, lastActivityAt, spinnerOnlySince, pendingLimit, stalledAt, stoppedReason,
    modelProfile: modelProfile && { label: modelProfile.label, provider: modelProfile.provider, tier: modelProfile.tier },
    usage: usage && { cost: usage.cost },
  };
}

function taskRow(task: ViewTask): TeamListTask {
  const { id, title, status, paths, dependsOn, memberId, changedPaths, ownerRating } = task;
  return {
    id, title, status, paths, dependsOn, memberId, ownerRating,
    changedPaths: changedPaths && changedPaths.paths.length > LIST_CHANGED_PATHS ? { paths: changedPaths.paths.slice(0, LIST_CHANGED_PATHS), truncated: true } : changedPaths,
  };
}

export function teamListItem(view: TeamView): TeamListItem {
  const { id, projectId, provider, title, status, revision, parallelism, createdAt, updatedAt, lastActivityAt, workspace, branch, baseCommit, headCommit, reason,
    missionId, permissionsRevokedAt, decisions, workers, waitReasons, resumable, continuable, lineup, goal, linear, review, discovery, deliveryReceipt, pullRequest,
    permissions, permissionDecisions, usage } = view;
  return {
    id, projectId, provider, title, status, revision, parallelism, createdAt, updatedAt, lastActivityAt, workspace, branch, baseCommit, headCommit, reason,
    missionId, permissionsRevokedAt, decisions, workers, waitReasons, resumable, continuable,
    members: view.members.map(memberRow),
    tasks: view.tasks.map(taskRow),
    checks: view.checks.map(check => ({ command: check.command, phase: check.phase, status: check.status, revision: check.revision })),
    events: view.events.slice(-1),
    lineup: lineup && { coordinator: lineup.coordinator },
    goal: goal && { id: goal.id, revision: goal.revision, cycle: goal.cycle },
    linear: linear && { status: linear.status, reason: linear.reason, checkedAt: linear.checkedAt, retryAt: linear.retryAt,
      issue: linear.issue && { identifier: linear.issue.identifier, url: linear.issue.url, title: linear.issue.title, state: linear.issue.state } },
    review: review && { verdict: review.verdict, revision: review.revision },
    discovery: discovery && { revision: discovery.revision },
    deliveryReceipt: deliveryReceipt && { revision: deliveryReceipt.revision, headCommit: deliveryReceipt.headCommit, pullRequestUrl: deliveryReceipt.pullRequestUrl,
      mergeCommit: deliveryReceipt.mergeCommit, reportedAt: deliveryReceipt.reportedAt },
    pullRequest: pullRequest && { revision: pullRequest.revision, headCommit: pullRequest.headCommit, pullRequestUrl: pullRequest.pullRequestUrl, reportedAt: pullRequest.reportedAt },
    permissions: permissions && { mode: permissions.mode, maxDecisions: permissions.maxDecisions },
    permissionDecisions: permissionDecisions?.map(decision => ({ targetSessionId: decision.targetSessionId, promptId: decision.promptId, status: decision.status })),
    usage: { total: usage.total, unmeasuredMembers: usage.unmeasuredMembers },
  };
}
