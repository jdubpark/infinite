import type { TeamEntryAuthorKind, TeamEntryAuthority, TeamEntryHead, TeamEntryKind, TeamEntryPage } from "../../api/client";
import { ROLE_NAMES, type TeamAcceptanceEvidence, type TeamMember, type TeamRole, type TeamTask, type TeamView } from "./model";

export type MobileOutcomeGroup = {
  id: string;
  statement: string;
  check: string;
  producer: "host" | "evaluator" | "owner";
  derived?: true;
  tasks: TeamTask[];
  done: number;
  total: number;
  integrationSummary: string;
  provisionalAssessment?: {
    state: "met" | "not-met" | "inconclusive" | "pending-owner";
    label: "Provisional";
    revision: number;
  };
};

export type ReviewerAcceptanceClaim = TeamAcceptanceEvidence & {
  statement?: string;
  revision: number;
};

export function deriveMobileOutcomeGroups(team: Pick<TeamView, "revision" | "goal" | "tasks" | "assessment">): MobileOutcomeGroup[] {
  const record = team.goal?.record;
  if (!record?.criteria.length) return [];
  const assessmentById = new Map((team.assessment?.criteria ?? []).map(item => [item.id, item.state]));
  return record.criteria.map(criterion => {
    const statement = criterion.id === "c0"
      ? (team.goal?.successCriteria?.trim() || criterion.statement)
      : criterion.statement;
    const tasks = team.tasks.filter(task => {
      const refs = task.criterionRefs;
      if (!refs) return false;
      if (refs.objectiveVersion !== record.version) return false;
      return refs.criteria.includes(criterion.id);
    });
    const done = tasks.filter(task => task.status === "integrated").length;
    const total = tasks.length;
    const assessed = assessmentById.get(criterion.id);
    return {
      id: criterion.id,
      statement,
      check: criterion.check,
      producer: criterion.producer,
      ...(criterion.derived ? { derived: true as const } : {}),
      tasks,
      done,
      total,
      integrationSummary: `${done} of ${total} tasks integrated`,
      ...(assessed && team.assessment ? {
        provisionalAssessment: {
          state: assessed,
          label: "Provisional" as const,
          revision: team.assessment.revision,
        },
      } : {}),
    };
  });
}

export function deriveReviewerAcceptanceClaims(team: Pick<TeamView, "brief" | "review">): ReviewerAcceptanceClaim[] {
  if (!team.review?.acceptance?.length) return [];
  const revision = team.review.revision;
  return team.review.acceptance.map(item => {
    const statement = team.brief?.acceptance[item.criterion - 1];
    return {
      ...item,
      ...(statement ? { statement } : {}),
      revision,
    };
  });
}

export type RosterMemberEntry<T extends TeamMember = TeamMember> = {
  member: T;
  replacedByMemberId?: string;
  replacesMemberId?: string;
};

export type MobileRosterPartition<T extends TeamMember = TeamMember> = {
  active: RosterMemberEntry<T>[];
  finished: RosterMemberEntry<T>[];
};

const ACTIVE_MEMBER_STATUSES = new Set(["queued", "running", "waiting", "unavailable"]);

function isActiveMember(member: Pick<TeamMember, "revision" | "status">, currentRevision: number): boolean {
  return member.revision === currentRevision && ACTIVE_MEMBER_STATUSES.has(member.status);
}

function attemptKey(member: Pick<TeamMember, "revision" | "planRevision" | "taskId" | "role">): string {
  const scopeRevision = member.planRevision ?? member.revision;
  return `${scopeRevision}\0${member.role}\0${member.taskId ?? ""}`;
}

export function partitionMobileRoster<T extends TeamMember>(members: readonly T[], revision: number): MobileRosterPartition<T> {
  const indexed = members.map((member, index) => ({ member, index }));
  const chronological = [...indexed].sort((left, right) => {
    if (left.member.revision !== right.member.revision) return left.member.revision - right.member.revision;
    const leftTime = left.member.startedAt ? Date.parse(left.member.startedAt) : Number.NaN;
    const rightTime = right.member.startedAt ? Date.parse(right.member.startedAt) : Number.NaN;
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.index - right.index;
  });

  const memberIds = new Set(members.map(member => member.memberId));
  const replacedBy = new Map<string, string>();
  const replaces = new Map<string, string>();

  for (const { member } of chronological) {
    const explicit = member.replaces?.memberId ?? member.replacesMemberId;
    if (explicit && explicit !== member.memberId && memberIds.has(explicit)) {
      replacedBy.set(explicit, member.memberId);
      replaces.set(member.memberId, explicit);
    }
  }

  const lastFinishedByKey = new Map<string, T>();

  for (const { member } of chronological) {
    const key = attemptKey(member);
    if (!replaces.has(member.memberId)) {
      const previous = lastFinishedByKey.get(key);
      if (previous && previous.memberId !== member.memberId && !replacedBy.has(previous.memberId)) {
        replacedBy.set(previous.memberId, member.memberId);
        replaces.set(member.memberId, previous.memberId);
      }
    }
    if (!isActiveMember(member, revision)) lastFinishedByKey.set(key, member);
    else lastFinishedByKey.delete(key);
  }

  const active: RosterMemberEntry<T>[] = [];
  const finished: RosterMemberEntry<T>[] = [];

  for (const member of members) {
    const entry: RosterMemberEntry<T> = {
      member,
      ...(replacedBy.has(member.memberId) ? { replacedByMemberId: replacedBy.get(member.memberId) } : {}),
      ...(replaces.has(member.memberId) ? { replacesMemberId: replaces.get(member.memberId) } : {}),
    };
    if (isActiveMember(member, revision)) active.push(entry);
    else finished.push(entry);
  }

  return { active, finished };
}

const ENTRY_STATE_RANK: Record<TeamEntryHead["state"], number> = {
  active: 0,
  superseded: 1,
  withdrawn: 2,
};

export function mergeMobileEntries(existing: readonly TeamEntryHead[], page: Pick<TeamEntryPage, "entries">): TeamEntryHead[] {
  const byId = new Map<string, TeamEntryHead>();
  for (const entry of existing) byId.set(entry.entryId, entry);
  const incomingIds = new Set<string>();
  for (const entry of page.entries) {
    byId.set(entry.entryId, entry);
    incomingIds.add(entry.entryId);
  }
  for (const entry of page.entries) {
    if (!entry.supersedes || entry.state === "withdrawn" || incomingIds.has(entry.supersedes)) continue;
    const prior = byId.get(entry.supersedes);
    if (prior && prior.state === "active") {
      byId.set(prior.entryId, { ...prior, state: "superseded" });
    }
  }
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

export type MobileEvidenceFeedState = {
  key: string;
  entries: TeamEntryHead[];
  cursor: number;
  more: boolean;
  revalidateCursor: number;
  lastLoadedAt?: string;
  lastRevalidatedAtMs?: number;
};

export function createMobileEvidenceFeedState(key: string): MobileEvidenceFeedState {
  return {
    key,
    entries: [],
    cursor: 0,
    more: false,
    revalidateCursor: 0,
  };
}

export function applyMobileEvidencePage(
  state: MobileEvidenceFeedState,
  page: TeamEntryPage,
  options: { mode?: "incremental" | "revalidate"; observedAt?: string } = {},
): MobileEvidenceFeedState {
  const mode = options.mode ?? "incremental";
  const entries = mergeMobileEntries(state.entries, page);
  const cursor = Math.max(state.cursor, page.cursor);
  const more = mode === "incremental"
    ? (page.cursor >= state.cursor ? page.more : state.more)
    : (page.cursor > state.cursor ? page.more : state.more);
  return {
    ...state,
    entries,
    cursor,
    more,
    ...(options.observedAt ? { lastLoadedAt: options.observedAt } : {}),
  };
}

export function applyMobileEvidenceHead(
  state: MobileEvidenceFeedState,
  head: TeamEntryHead,
): MobileEvidenceFeedState {
  return {
    ...state,
    entries: mergeMobileEntries(state.entries, { entries: [head] }),
  };
}

export function resolveSelectedEntryHead(
  detailHead: TeamEntryHead | undefined,
  listHead: TeamEntryHead | undefined,
): TeamEntryHead | undefined {
  if (!listHead) return detailHead;
  if (!detailHead) return listHead;
  if (detailHead.entryId !== listHead.entryId) return listHead;
  if (ENTRY_STATE_RANK[detailHead.state] > ENTRY_STATE_RANK[listHead.state]) {
    return { ...listHead, state: detailHead.state };
  }
  return listHead;
}

export function filterMobileEntries(entries: readonly TeamEntryHead[], kind: TeamEntryKind | "all"): TeamEntryHead[] {
  if (kind === "all") return [...entries];
  return entries.filter(entry => entry.kind === kind);
}

export function authorityLabel(authority: TeamEntryAuthority): string {
  switch (authority) {
    case "receipt": return "Host receipt";
    case "claim": return "Agent claim";
    case "direction": return "Owner direction";
  }
}

export function entryAuthorLabel(author: TeamEntryAuthorKind, authorRole?: TeamRole | "mission-coordinator"): string {
  if (authorRole === "mission-coordinator") return "Mission coordinator";
  if (authorRole) return ROLE_NAMES[authorRole] ?? authorRole;
  return author;
}

export type FormattedEntryBody = {
  headCommit?: string;
  commit?: string;
  exitCode?: number | null;
  round?: number;
  verdict?: string;
  summary?: string;
  changedPaths?: { paths: string[]; truncated: boolean };
  output?: string;
  question?: string;
  answer?: string;
  acceptance?: TeamAcceptanceEvidence[];
  uiEvidence?: string;
  facts: { label: string; value: string }[];
  rawJson: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function pickField(record: Record<string, unknown>, nested: Record<string, unknown> | undefined, key: string): unknown {
  return record[key] !== undefined ? record[key] : nested?.[key];
}

export function formatEntryBodySummary(body: unknown): FormattedEntryBody {
  const rawJson = safeJson(body);
  if (!isRecord(body)) return { facts: [], rawJson };
  const nested = isRecord(body.report) ? body.report : undefined;

  const headCommit = asString(pickField(body, nested, "headCommit"));
  const commit = asString(pickField(body, nested, "commit")) ?? asString(pickField(body, nested, "mergeCommit"));
  const rawExitCode = pickField(body, nested, "exitCode");
  const exitCode = typeof rawExitCode === "number" || rawExitCode === null ? rawExitCode : undefined;
  const rawRound = pickField(body, nested, "round");
  const round = typeof rawRound === "number" ? rawRound : undefined;
  const verdict = asString(pickField(body, nested, "verdict"));
  const summary = asString(pickField(body, nested, "summary"))
    ?? (body.source === "answer" ? undefined : asString(pickField(body, nested, "text")))
    ?? asString(pickField(body, nested, "reason"))
    ?? asString(body.change);
  const output = typeof body.output === "string" ? body.output : undefined;
  const question = asString(pickField(body, nested, "question"));
  const answer = asString(pickField(body, nested, "answer"))
    ?? (body.source === "answer" ? asString(body.text) : undefined);
  const uiEvidence = asString(pickField(body, nested, "uiEvidence"));

  const rawChanged = pickField(body, nested, "changedPaths");
  const changedPaths = isRecord(rawChanged) && Array.isArray(rawChanged.paths)
    ? { paths: asStringArray(rawChanged.paths), truncated: Boolean(rawChanged.truncated) }
    : undefined;

  const rawAcceptance = pickField(body, nested, "acceptance");
  const acceptance = Array.isArray(rawAcceptance)
    ? rawAcceptance.flatMap((item): TeamAcceptanceEvidence[] => {
        if (!isRecord(item)) return [];
        if (typeof item.criterion !== "number" || typeof item.verdict !== "string" || typeof item.evidence !== "string") return [];
        if (item.verdict !== "verified" && item.verdict !== "not-verified" && item.verdict !== "inconclusive") return [];
        return [{ criterion: item.criterion, verdict: item.verdict, evidence: item.evidence }];
      })
    : undefined;

  const facts: { label: string; value: string }[] = [];
  if (isRecord(body.command) && typeof body.command.command === "string") {
    const args = asStringArray(body.command.args);
    facts.push({ label: "Command", value: [body.command.command, ...args].join(" ") });
  }
  const status = asString(pickField(body, nested, "status"));
  if (status) facts.push({ label: "Status", value: status });
  const phase = asString(body.phase);
  if (phase) facts.push({ label: "Phase", value: phase });
  const reportKind = asString(nested?.kind);
  if (reportKind) facts.push({ label: "Report kind", value: reportKind });
  const pullRequestUrl = asString(pickField(body, nested, "pullRequestUrl"));
  if (pullRequestUrl) facts.push({ label: "Pull request", value: pullRequestUrl });
  const baseCommit = asString(body.baseCommit);
  if (baseCommit) facts.push({ label: "Base commit", value: baseCommit });
  const iface = asString(body.interface);
  if (iface) facts.push({ label: "Interface", value: iface });
  const proposedRecovery = asString(body.proposedRecovery);
  if (proposedRecovery) facts.push({ label: "Proposed recovery", value: proposedRecovery });
  const prevention = asString(body.prevention);
  if (prevention) facts.push({ label: "Prevention", value: prevention });
  const done = asStringArray(body.done);
  if (done.length) facts.push({ label: "Done", value: done.join("\n") });
  const remaining = asStringArray(body.remaining);
  if (remaining.length) facts.push({ label: "Remaining", value: remaining.join("\n") });
  const notes = asString(body.notes);
  if (notes) facts.push({ label: "Notes", value: notes });

  return {
    ...(headCommit ? { headCommit } : {}),
    ...(commit ? { commit } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(verdict ? { verdict } : {}),
    ...(summary ? { summary } : {}),
    ...(changedPaths ? { changedPaths } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(question ? { question } : {}),
    ...(answer ? { answer } : {}),
    ...(acceptance?.length ? { acceptance } : {}),
    ...(uiEvidence ? { uiEvidence } : {}),
    facts,
    rawJson,
  };
}
