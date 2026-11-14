import type { TeamBrief, TeamGoalContext } from "./team-types.js";

export const EVAL_MODULE = "eval-corpus";

export type Capsule = {
  objective: string;
  steering: string[];
  ownerAnswers: { question: string; answer: string }[];
  brief?: TeamBrief;
  goal?: TeamGoalContext;
  task: { id: string; title: string; instructions: string; paths: string[] };
};

export type CaptureStart = {
  runId: string;
  memberId: string;
  projectId: string;
  /** TeamRun.workspace, the integration checkout where every read of this capture runs. */
  workspace: string;
  /** TeamRun.baseCommit. */
  anchorCommit: string;
  /** TeamMember.baseCommit. */
  memberBaseCommit: string;
  /** TeamTask.commit. */
  commit: string;
  /** The run head after this task's cherry-pick. */
  integratedHead: string;
  at: string;
  /** TeamRun.brief?.uiChanges === true. */
  uiChanges: boolean;
  /** Null when the member has no start time. */
  capsule: Capsule | null;
};

export type ApprovalStart = {
  runId: string;
  workspace: string;
  anchorCommit: string;
  reviewedHead: string;
  at: string;
};

export interface CaptureSink {
  /** Cheap and synchronous. False unless the project turned capture on and the store can take it. */
  enabled(projectId: string): boolean;
  /** Writes a marker, then reads in the background. Never throws. */
  integrated(start: CaptureStart): void;
  /** Marks the run's captured tasks, then reads in the background. Never throws. */
  approved(start: ApprovalStart): void;
}

export const START_REASONS = ["ui-changes", "start-unknown", "capsule-too-large", "excluded-area-unknown", "capture-busy"] as const;
export const MATERIAL_REASONS = ["capture-failed", "reference-too-wide", "excluded-area", "no-hidden-tests", "patch-too-large", "corpus-full"] as const;
export const PROMOTION_REASONS = [
  "ledger-missing", "ledger-withheld", "excluded", "same-model-review", "not-accepted", "acceptance-unknown",
  "patch-missing", "reference-unknown", "reference-ambiguous", "base-not-proven", "features-unknown", "unreadable",
] as const;

export type StartReason = typeof START_REASONS[number];
export type MaterialReason = typeof MATERIAL_REASONS[number];
export type PromotionReason = typeof PROMOTION_REASONS[number];
export type EvalReason = StartReason | MaterialReason | PromotionReason;
export type EvalState = "captured" | "candidate" | "rejected";
export type MaterialState = "pending" | "stored" | "partial" | "none";
export type ApprovalState = "pending" | "read" | "unknown";
export type BaseState = "pending" | "proven" | "not-proven" | "none";

export type EvalFeatures = { role: "implementer"; area: string; kind: string | null; risk: "normal" | "elevated"; featureVersion: number };

/** Sealed in `eval_tasks.payload` for a task that passed the start verdict. */
export type CapturedPayload = {
  projectId: string;
  anchorCommit: string;
  memberBaseCommit: string;
  commit: string;
  integratedHead: string;
  /** The reference's names and its test files, after the name read. */
  files?: string[];
  hiddenFiles?: string[];
  baseDelta?: "none" | "stored" | "missing";
  reference?: "stored" | "missing";
  /** After the latest approval's read. */
  laterFiles?: string[];
  /** On promotion. */
  features?: EvalFeatures;
};

/** Sealed in `eval_tasks.payload` for a rejected task: nothing but the project. */
export type RejectedPayload = { projectId: string };

export type EvalTaskRow = {
  taskId: string;
  origin: "captured";
  runId: string;
  memberId: string;
  projectRef: string;
  state: EvalState;
  reason: EvalReason | null;
  material: MaterialState;
  approval: ApprovalState | null;
  approvedAt: string | null;
  base: BaseState;
  materialBytes: number;
  capturedAt: string;
  decidedAt: string | null;
  checkedAt: string;
  runDeletedAt: string | null;
  payload: CapturedPayload | RejectedPayload;
};

export type PatchRead = { state: "read"; bytes: Buffer } | { state: "too-large" } | { state: "failed" };
export type NameRead = { state: "read"; names: string[] } | { state: "too-wide" } | { state: "failed" };
export type BaseRead = "proven" | "not-proven";

export interface CaptureGit {
  patch(cwd: string, from: string, to: string): Promise<PatchRead>;
  names(cwd: string, from: string, to: string, max: number): Promise<NameRead>;
  onBaseBranch(mirror: string, anchor: string, head: string): Promise<BaseRead>;
}

export type ReconcileResult = { visited: number; promoted: number; rejected: number; demoted: number; waiting: number; unreadable: number };
