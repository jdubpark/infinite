export const TEAM_ENTRY_KINDS = [
  "contract",
  "finding",
  "blocker",
  "handoff",
  "report",
  "integration",
  "check",
  "direction",
] as const;

export type TeamEntryKind = typeof TEAM_ENTRY_KINDS[number];
export type TeamEntryAuthority = "receipt" | "claim" | "direction";
export type TeamEntryAuthor = "host" | "member" | "owner";
export type TeamEntryState = "active" | "superseded" | "withdrawn";

export type TeamEntryHead = {
  entryId: string;
  seq: number;
  scope: "run" | "mission";
  runId: string;
  revision: number;
  at: string;
  kind: TeamEntryKind;
  author: TeamEntryAuthor;
  authority: TeamEntryAuthority;
  authorMemberId?: string;
  authorRole?: string;
  taskId?: string;
  headCommit?: string;
  paths: string[];
  subtaskIds?: string[];
  summary: string;
  bodyBytes: number;
  supersedes?: string;
  unreadRequired?: string[];
  state: TeamEntryState;
};

export type TeamEntryPage = {
  entries: TeamEntryHead[];
  cursor: number;
  more: boolean;
};

export type TeamEntryDetail = {
  head: TeamEntryHead;
  body: unknown;
};

export type TeamCriterionProducer = "host" | "evaluator" | "owner";
export type TeamComposedState = "met" | "not-met" | "inconclusive" | "pending-owner";
export type TeamAssessedState = "met" | "not-met" | "inconclusive";

export type TeamCriterionRecord = {
  id: string;
  statement: string;
  check: string;
  producer: TeamCriterionProducer;
  derived?: true;
};

export type TeamGoalRecord = {
  version: number;
  criteria: TeamCriterionRecord[];
};

export type TeamRunAssessment = {
  verdictId: string;
  revision: number;
  head: string;
  kind: "reviewed" | "no-change";
  result: TeamAssessedState;
  evaluatorResult?: TeamAssessedState;
  reason?: string;
  counts: { met: number; notMet: number; inconclusive: number; pendingOwner: number };
  criteria: { id: string; state: TeamComposedState }[];
  at: string;
};

export type TeamAcceptanceEvidence = {
  criterion: number;
  verdict: "verified" | "not-verified" | "inconclusive";
  evidence: string;
};

export type TeamCriterionRefs = {
  objectiveVersion: number;
  criteria: string[];
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
