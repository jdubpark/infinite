import type { LinearIssueView } from "./linear-types.js";
import type { TeamModelProfile, TeamView } from "./team-types.js";
import type { UsageTotals } from "./usage.js";

type ViewMember = TeamView["members"][number];
type ViewTask = TeamView["tasks"][number];
type ViewPermissionDecision = NonNullable<TeamView["permissionDecisions"]>[number];

/** A list row names at most this many of a task's changed paths and marks the rest `truncated`, as the host's own bound does. */
export const LIST_CHANGED_PATHS = 20;

export type TeamListMember = Pick<ViewMember, "memberId" | "sessionId" | "role" | "revision" | "title" | "status" | "taskId" | "provider"
  | "startedAt" | "reportedAt" | "lastActivityAt" | "pendingLimit" | "stalledAt" | "stoppedReason"> & {
  modelProfile?: Pick<TeamModelProfile, "label" | "provider" | "tier">;
  usage?: Pick<UsageTotals, "cost">;
};
export type TeamListTask = Pick<ViewTask, "id" | "title" | "status" | "paths" | "dependsOn" | "memberId" | "changedPaths" | "ownerRating">;

/**
 * One run as `GET /api/teams?view=list` lists it, and as the remote channel answers a full list too large for it. It
 * keeps, under the same keys and with the same meaning, every field the web, phone and Mac list code reads, and drops
 * the long text that only a run's detail shows: check output, member reports, task instructions and summaries,
 * continuations, the objective, steering, briefs and issue bodies. Arrays that list code counts or filters keep every
 * item, reduced. A client built before rows existed may show a row as a whole run, so a row also keeps what a run's
 * check summary and task order are computed from: each check's command and phase, and each task's dependencies.
 * `GET /api/teams` without `view` and `GET /api/teams/:id` keep the full record.
 */
export type TeamListItem = Pick<TeamView, "id" | "projectId" | "provider" | "title" | "status" | "revision" | "parallelism" | "createdAt" | "updatedAt"
  | "workspace" | "branch" | "baseCommit" | "headCommit" | "reason" | "missionId" | "permissionsRevokedAt" | "decisions" | "workers" | "resumable" | "continuable"> & {
  members: TeamListMember[];
  tasks: TeamListTask[];
  checks: Pick<TeamView["checks"][number], "command" | "phase" | "status" | "revision">[];
  /** The latest history entry only. */
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
  const { memberId, sessionId, role, revision, title, status, taskId, provider, startedAt, reportedAt, lastActivityAt, pendingLimit, stalledAt, stoppedReason, modelProfile, usage } = member;
  return {
    memberId, sessionId, role, revision, title, status, taskId, provider, startedAt, reportedAt, lastActivityAt, pendingLimit, stalledAt, stoppedReason,
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

/** The compact list row for one run's full view. Pure: it reads nothing but `view` and adds nothing the view lacks. */
export function teamListItem(view: TeamView): TeamListItem {
  const { id, projectId, provider, title, status, revision, parallelism, createdAt, updatedAt, workspace, branch, baseCommit, headCommit, reason,
    missionId, permissionsRevokedAt, decisions, workers, resumable, continuable, lineup, goal, linear, review, discovery, deliveryReceipt, pullRequest,
    permissions, permissionDecisions, usage } = view;
  return {
    id, projectId, provider, title, status, revision, parallelism, createdAt, updatedAt, workspace, branch, baseCommit, headCommit, reason,
    missionId, permissionsRevokedAt, decisions, workers, resumable, continuable,
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
