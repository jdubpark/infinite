import type { TeamMember, TeamTask, TeamView } from "../teams";
import type {
  TeamAcceptanceEvidence,
  TeamComposedState,
  TeamCriterionProducer,
  TeamEntryAuthority,
  TeamEntryHead,
  TeamEntryKind,
  TeamEntryPage,
  TeamRunAssessment,
  TeamWaitReason,
  TeamWaitReasonKind,
} from "./types";

export type ReviewerClaimRow = {
  criterion: number;
  label: string;
  verdict: TeamAcceptanceEvidence["verdict"];
  evidence: string;
};

export type OutcomeCriterionGroup = {
  id: string;
  label: string;
  check: string;
  producer: TeamCriterionProducer;
  derived?: true;
  tasks: TeamTask[];
  integratedCount: number;
  totalCount: number;
  progressText: string;
  provisionalState?: TeamComposedState;
};

export type OutcomeTaskCounts = {
  total: number;
  integrated: number;
  running: number;
  waiting: number;
  pending: number;
  blocked: number;
};

export type OutcomeOverview =
  | {
      mode: "criteria";
      groups: OutcomeCriterionGroup[];
      unassignedTasks: TeamTask[];
      taskCounts: OutcomeTaskCounts;
      assessment?: TeamRunAssessment;
      reviewerClaims: ReviewerClaimRow[];
    }
  | {
      mode: "summary";
      groups: [];
      taskCounts: OutcomeTaskCounts;
      integratedSummary: string;
      briefAcceptance: string[];
      assessment?: TeamRunAssessment;
      reviewerClaims: ReviewerClaimRow[];
    };

export type RosterMemberNode = {
  member: TeamMember;
  replacedByMemberId?: string;
  replacesMemberId?: string;
};

export type PartitionedRoster = {
  active: RosterMemberNode[];
  finished: RosterMemberNode[];
  byMemberId: Record<string, RosterMemberNode>;
};

export type EntryFilter = {
  kind?: TeamEntryKind | "all";
  taskId?: string;
  memberId?: string;
  revision?: number | "all";
  query?: string;
};

export type AuthorityMeta = {
  label: string;
  tone: "receipt" | "claim" | "direction";
  description: string;
};

export type TeamEntryHashMatch = {
  machine: string;
  teamId: string;
  entryId: string | null;
};

export const INSPECTOR_ROLE_LABELS: Record<string, string> = {
  "project-manager": "Coordinator",
  "intent-checker": "Intent checker",
  scout: "Scout",
  implementer: "Implementer",
  integrator: "Integrator",
  reviewer: "Reviewer",
  delivery: "Delivery",
  evaluator: "Evaluator",
  judge: "Judge",
  "permission-coordinator": "Permission coordinator",
  "mission-coordinator": "Mission coordinator",
};

export function inspectorRoleLabel(role: string | undefined): string {
  if (!role) return "Member";
  return INSPECTOR_ROLE_LABELS[role] ?? role;
}

export function summarizeTaskCounts(tasks: readonly TeamTask[]): OutcomeTaskCounts {
  const counts: OutcomeTaskCounts = {
    total: tasks.length,
    integrated: 0,
    running: 0,
    waiting: 0,
    pending: 0,
    blocked: 0,
  };
  for (const task of tasks) {
    if (task.status === "integrated") counts.integrated += 1;
    else if (task.status === "running") counts.running += 1;
    else if (task.status === "waiting") counts.waiting += 1;
    else if (task.status === "pending") counts.pending += 1;
    else if (task.status === "blocked") counts.blocked += 1;
  }
  return counts;
}

export function deriveReviewerClaims(team: Pick<TeamView, "brief" | "review">): ReviewerClaimRow[] {
  const acceptance = team.review?.acceptance ?? [];
  const briefAcceptance = team.brief?.acceptance ?? [];
  return acceptance.map(item => ({
    criterion: item.criterion,
    label: briefAcceptance[item.criterion - 1] ?? `Criterion ${item.criterion}`,
    verdict: item.verdict,
    evidence: item.evidence,
  }));
}

export function deriveOutcomeGroups(team: Pick<TeamView, "goal" | "tasks" | "assessment" | "review" | "brief">): OutcomeOverview {
  const taskCounts = summarizeTaskCounts(team.tasks);
  const reviewerClaims = deriveReviewerClaims(team);
  const criteria = team.goal?.record?.criteria;
  if (criteria && criteria.length > 0) {
    const assessmentById = new Map((team.assessment?.criteria ?? []).map(item => [item.id, item.state]));
    const pinnedIds = new Set(criteria.map(criterion => criterion.id));
    const groups: OutcomeCriterionGroup[] = criteria.map(criterion => {
      const tasks = team.tasks.filter(task => task.criterionRefs?.criteria.includes(criterion.id));
      const integratedCount = tasks.filter(task => task.status === "integrated").length;
      const totalCount = tasks.length;
      const label = criterion.id === "c0" && criterion.statement === ""
        ? team.goal?.successCriteria || "Primary objective"
        : criterion.statement;
      return {
        id: criterion.id,
        label,
        check: criterion.check,
        producer: criterion.producer,
        ...(criterion.derived ? { derived: true as const } : {}),
        tasks,
        integratedCount,
        totalCount,
        progressText: totalCount > 0 ? `${integratedCount} of ${totalCount} tasks integrated` : "No tasks linked",
        ...(assessmentById.has(criterion.id) ? { provisionalState: assessmentById.get(criterion.id) } : {}),
      };
    });
    const unassignedTasks = team.tasks.filter(task => {
      const refs = task.criterionRefs?.criteria ?? [];
      return refs.length === 0 || !refs.some(id => pinnedIds.has(id));
    });
    return {
      mode: "criteria",
      groups,
      unassignedTasks,
      taskCounts,
      ...(team.assessment ? { assessment: team.assessment } : {}),
      reviewerClaims,
    };
  }
  const integratedSummary = taskCounts.total > 0
    ? `${taskCounts.integrated} of ${taskCounts.total} tasks integrated`
    : "No tasks planned yet";
  return {
    mode: "summary",
    groups: [],
    taskCounts,
    integratedSummary,
    briefAcceptance: team.brief?.acceptance ?? [],
    ...(team.assessment ? { assessment: team.assessment } : {}),
    reviewerClaims,
  };
}

const SINGLETON_REPLACEMENT_ROLES = new Set(["project-manager", "integrator", "reviewer"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "waiting"]);
const ROLE_SORT_ORDER = ["project-manager", "intent-checker", "scout", "implementer", "integrator", "reviewer", "evaluator", "judge", "delivery"];

function memberGroupKey(member: TeamMember): string | null {
  if (member.taskId) return `task:${member.taskId}`;
  if (SINGLETON_REPLACEMENT_ROLES.has(member.role)) return `role:${member.role}`;
  return null;
}

function compareAttemptOrder(a: { member: TeamMember; index: number }, b: { member: TeamMember; index: number }): number {
  if (a.member.revision !== b.member.revision) return a.member.revision - b.member.revision;
  const aTime = a.member.startedAt ? Date.parse(a.member.startedAt) : Number.NaN;
  const bTime = b.member.startedAt ? Date.parse(b.member.startedAt) : Number.NaN;
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return aTime - bTime;
  return a.index - b.index;
}

function isLiveMember(member: TeamMember, revision: number): boolean {
  return member.revision === revision && ACTIVE_STATUSES.has(member.status);
}

function sortRosterNodes(nodes: RosterMemberNode[], revision: number): RosterMemberNode[] {
  return [...nodes].sort((left, right) => {
    const rank = (member: TeamMember) => {
      const roleIndex = ROLE_SORT_ORDER.indexOf(member.role);
      return [
        member.revision === revision ? 0 : 1,
        ACTIVE_STATUSES.has(member.status) ? 0 : 1,
        roleIndex < 0 ? ROLE_SORT_ORDER.length : roleIndex,
      ];
    };
    const a = rank(left.member);
    const b = rank(right.member);
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return left.member.title.localeCompare(right.member.title) || left.member.memberId.localeCompare(right.member.memberId);
  });
}

export function partitionRoster(members: readonly TeamMember[], revision: number): PartitionedRoster {
  const byMemberId: Record<string, RosterMemberNode> = {};
  for (const member of members) {
    byMemberId[member.memberId] = { member };
  }
  const groups = new Map<string, { member: TeamMember; index: number }[]>();
  members.forEach((member, index) => {
    const key = memberGroupKey(member);
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push({ member, index });
    groups.set(key, list);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareAttemptOrder);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const prev = ordered[i]!.member;
      const next = ordered[i + 1]!.member;
      if (isLiveMember(prev, revision) && prev.revision === next.revision) continue;
      const prevNode = byMemberId[prev.memberId]!;
      const nextNode = byMemberId[next.memberId]!;
      prevNode.replacedByMemberId = next.memberId;
      nextNode.replacesMemberId = prev.memberId;
    }
  }
  const active: RosterMemberNode[] = [];
  const finished: RosterMemberNode[] = [];
  for (const member of members) {
    const node = byMemberId[member.memberId]!;
    if (isLiveMember(member, revision)) active.push(node);
    else finished.push(node);
  }
  return {
    active: sortRosterNodes(active, revision),
    finished: sortRosterNodes(finished, revision),
    byMemberId,
  };
}

export function mergeEntryPage(existing: readonly TeamEntryHead[], page: TeamEntryPage): TeamEntryHead[] {
  const map = new Map<string, TeamEntryHead>();
  for (const entry of existing) map.set(entry.entryId, entry);
  for (const entry of page.entries) map.set(entry.entryId, entry);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function filterEntries(entries: readonly TeamEntryHead[], filter: EntryFilter): TeamEntryHead[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return entries.filter(entry => {
    if (filter.kind && filter.kind !== "all" && entry.kind !== filter.kind) return false;
    if (filter.taskId && filter.taskId !== "all" && entry.taskId !== filter.taskId) return false;
    if (filter.memberId && filter.memberId !== "all" && entry.authorMemberId !== filter.memberId) return false;
    if (filter.revision !== undefined && filter.revision !== "all" && entry.revision !== filter.revision) return false;
    if (!query) return true;
    const haystack = [
      String(entry.seq),
      entry.entryId,
      entry.kind,
      entry.authority,
      entry.author,
      entry.authorRole ?? "",
      entry.authorMemberId ?? "",
      entry.taskId ?? "",
      entry.headCommit ?? "",
      entry.summary,
      ...entry.paths,
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

export function entryAuthorityMeta(authority: TeamEntryAuthority): AuthorityMeta {
  if (authority === "receipt") {
    return {
      label: "Host receipt",
      tone: "receipt",
      description: "Recorded by the host from git, checks, or process state.",
    };
  }
  if (authority === "direction") {
    return {
      label: "Owner direction",
      tone: "direction",
      description: "Recorded from an owner steering message or decision answer.",
    };
  }
  return {
    label: "Agent claim",
    tone: "claim",
    description: "Reported by an agent member; not independently verified by the host.",
  };
}

export function buildSupersessionIndex(entries: readonly TeamEntryHead[]): Map<string, TeamEntryHead[]> {
  const index = new Map<string, TeamEntryHead[]>();
  for (const entry of entries) {
    if (!entry.supersedes) continue;
    const list = index.get(entry.supersedes) ?? [];
    list.push(entry);
    index.set(entry.supersedes, list);
  }
  return index;
}

export function parseTeamEntryHash(hash: string, teamId?: string): TeamEntryHashMatch | null {
  const match = hash.match(/^#(?:\/machines\/([^/]+))?\/teams\/([^/]+)(?:\/entries\/([^/]+))?$/i);
  if (!match) return null;
  const machine = match[1] ? decodeURIComponent(match[1]) : "direct";
  const matchedTeamId = decodeURIComponent(match[2]!);
  const entryId = match[3] ? decodeURIComponent(match[3]) : null;
  if (teamId && matchedTeamId.toLowerCase() !== teamId.toLowerCase()) return null;
  return { machine, teamId: matchedTeamId, entryId };
}

export function buildTeamEntryHash(machine: string, teamId: string, entryId?: string | null): string {
  const prefix = !machine || machine === "direct" ? "" : `/machines/${encodeURIComponent(machine)}`;
  return `#${prefix}/teams/${encodeURIComponent(teamId)}${entryId ? `/entries/${encodeURIComponent(entryId)}` : ""}`;
}

export type WaitReasonMeta = {
  label: string;
  tone: "attention" | "warning" | "muted";
};

const WAIT_REASON_META: Record<TeamWaitReasonKind, WaitReasonMeta> = {
  "owner-decision": { label: "Owner decision", tone: "attention" },
  "provider-prompt": { label: "Provider prompt", tone: "attention" },
  stalled: { label: "Stalled", tone: "attention" },
  "spinner-only": { label: "Spinner-only screen", tone: "warning" },
  "provider-limit": { label: "Provider limit", tone: "warning" },
  "worker-slot": { label: "Worker slot", tone: "muted" },
  dependency: { label: "Task dependency", tone: "muted" },
  "integration-order": { label: "Integration order", tone: "muted" },
  "linear-sync": { label: "Linear sync", tone: "muted" },
};

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

export function waitReasonMeta(kind: TeamWaitReasonKind): WaitReasonMeta {
  return WAIT_REASON_META[kind];
}

export function orderWaitReasons(reasons: readonly TeamWaitReason[]): TeamWaitReason[] {
  return reasons
    .map((reason, index) => ({ reason, index }))
    .sort((left, right) => {
      const a = WAIT_REASON_ORDER[left.reason.kind] ?? 99;
      const b = WAIT_REASON_ORDER[right.reason.kind] ?? 99;
      return a - b || left.index - right.index;
    })
    .map(item => item.reason);
}
