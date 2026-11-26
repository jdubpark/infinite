import type { TeamBrief, TeamGoalContext, TeamModelProfile } from "./team-types.js";
import type { RoutineStatus } from "./routine-types.js";

export const EVAL_MODULE = "eval-corpus";
export const EVAL_STATES = ["captured", "candidate", "valid", "rejected", "retired"] as const;
export const MINE_REASONS = ["too-large", "binary-change", "revert", "secret-shaped", "lineage-too-wide", "duplicate-of-captured"] as const;
export const VALIDATION_REASONS = ["not-fail-to-pass", "guard-failed", "flaky", "too-slow", "anchor-missing", "unvalidated", "owner-retired"] as const;

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
  workspace: string;
  anchorCommit: string;
  memberBaseCommit: string;
  commit: string;
  integratedHead: string;
  at: string;
  uiChanges: boolean;
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
  enabled(projectId: string): boolean;
  integrated(start: CaptureStart): void;
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
export type MineReason = typeof MINE_REASONS[number];
export type ValidationReason = typeof VALIDATION_REASONS[number];
export type EvalReason = StartReason | MaterialReason | PromotionReason | MineReason | ValidationReason;
export type EvalState = typeof EVAL_STATES[number];
export type EvalOrigin = "captured" | "mined";
export type Lineage = "clear" | "unclear";
export type MaterialState = "pending" | "stored" | "partial" | "none";
export type ApprovalState = "pending" | "read" | "unknown";
export type BaseState = "pending" | "proven" | "not-proven" | "none";

export type EvalFeatures = { role: "implementer"; area: string; kind: string | null; risk: "normal" | "elevated"; featureVersion: number };

export type CapturedPayload = {
  projectId: string;
  anchorCommit: string;
  memberBaseCommit: string;
  commit: string;
  integratedHead: string;
  files?: string[];
  hiddenFiles?: string[];
  baseDelta?: "none" | "stored" | "missing";
  reference?: "stored" | "missing";
  laterFiles?: string[];
  features?: EvalFeatures;
  expectedCases?: string[];
};

export type MinedPayload = {
  projectId: string; anchorCommit: string; commit: string; commitTime: string;
  promptOrigin: "run-objective" | "commit-message"; runId?: string;
  files: string[]; hiddenFiles: string[]; features: EvalFeatures;
  expectedCases?: string[];
};

export type RejectedPayload = { projectId: string };

type EvalTaskCommon = {
  taskId: string;
  runId: string;
  memberId: string;
  projectRef: string;
  material: MaterialState;
  approvedAt: string | null;
  base: BaseState;
  materialBytes: number;
  capturedAt: string;
  checkedAt: string;
  runDeletedAt: string | null;
  groupId: string | null;
  lineage: Lineage | null;
  attempts: number;
};

export type EvalTaskRow =
  | (EvalTaskCommon & {
      origin: "captured";
      state: "captured";
      reason: null;
      approval: ApprovalState | null;
      decidedAt: null;
      validatedAt: null;
      payload: CapturedPayload;
    })
  | (EvalTaskCommon & {
      origin: "captured";
      state: "candidate";
      reason: null;
      approval: ApprovalState | null;
      decidedAt: string | null;
      validatedAt: null;
      payload: CapturedPayload;
    })
  | (EvalTaskCommon & {
      origin: "captured";
      state: "valid";
      reason: null;
      approval: ApprovalState | null;
      decidedAt: string | null;
      validatedAt: string | null;
      payload: CapturedPayload;
    })
  | (EvalTaskCommon & {
      origin: "mined";
      state: "candidate";
      reason: null;
      approval: null;
      decidedAt: string | null;
      validatedAt: null;
      payload: MinedPayload;
    })
  | (EvalTaskCommon & {
      origin: "mined";
      state: "valid";
      reason: null;
      approval: null;
      decidedAt: string | null;
      validatedAt: string | null;
      payload: MinedPayload;
    })
  | (EvalTaskCommon & {
      origin: EvalOrigin;
      state: "rejected" | "retired";
      reason: EvalReason | null;
      approval: null;
      decidedAt: string | null;
      validatedAt: string | null;
      payload: RejectedPayload;
    });

export type PatchRead =
  | { state: "read"; bytes: Buffer }
  | { state: "empty" }
  | { state: "missing" }
  | { state: "too-large" }
  | { state: "failed" };
export type NameRead = { state: "read"; names: string[] } | { state: "too-wide" } | { state: "failed" };
export type BaseRead = "proven" | "not-proven";

export interface CaptureGit {
  patch(cwd: string, from: string, to: string): Promise<PatchRead>;
  names(cwd: string, from: string, to: string, max: number): Promise<NameRead>;
  onBaseBranch(mirror: string, anchor: string, head: string): Promise<BaseRead>;
  close?(): void;
}

export type ReconcileResult = { visited: number; promoted: number; rejected: number; demoted: number; waiting: number; unreadable: number };

export type GraderState = "not-configured" | "unavailable" | "misconfigured" | "exposed" | "network-open" | "ready";
export type MiningState = "off" | "waiting" | "mining" | "caught-up" | "full" | "failing";
export type MiningStatus = { state: MiningState; visited: number | null; mined: number | null; skipped: number | null; failures: number | null; backfillDone: boolean | null };
export type EvalJobReason = "owner" | "validation-stuck" | "configuration-changed" | "grader-processes-alive" | "limit-reached" | "done" | "expired"
  | "trial-voids" | "eval-processes-alive" | "identity-changed";
export type EvalJobWait = "grader" | "window" | "host-load" | "halt" | "storage" | "bundle" | "mirror" | "another-job"
  | "eval-identity" | "provider-limit" | "session-slots" | "daily-cap" | "grader-failed" | "eval-failed" | "bundle-missing";
export type ValidateJobView = {
  jobId: string; projectId: string | null; kind: "validate"; status: RoutineStatus;
  reason: EvalJobReason | null; waiting: EvalJobWait | null;
  createdAt: string; startedAt: string | null; expiresAt: string; finishedAt: string | null;
  counts: { visited: number; valid: number; rejected: number; retired: number; undecided: number };
};
export const TRIAL_ENDINGS = ["graded", "no-result", "escalated", "question", "blocked", "permission", "stalled",
  "scope-violation", "timeout", "void-limit", "void-host", "void-owner"] as const;
export type TrialEnding = typeof TRIAL_ENDINGS[number];
export const VOID_ENDINGS: readonly TrialEnding[] = ["void-limit", "void-host", "void-owner"];
export type TrialConfiguration = { profile: TeamModelProfile; guidance: "as-of-base"; knowledge: "none" };
export type TrialGrade = {
  ending: TrialEnding;
  expectedPassed: number | null; expectedTotal: number;
  guardPassed: boolean | null;
  resolved: boolean;
  overwritten: number;
  diff: { added: number; removed: number; referenceAdded: number; referenceRemoved: number } | null;
  isolation: "isolated" | "none";
};
export type TrialState = "preparing" | "running" | "grading" | "final";
export type EvalIdentityState = "not-configured" | "unavailable" | "misconfigured" | "exposed" | "network-open" | "busy" | "ready";
export type BaselineJobRequest = {
  kind: "baseline";
  configurations: TrialConfiguration[];
  taskFilter?: { taskIds?: string[]; origins?: EvalOrigin[]; areas?: string[]; maxTasks?: number };
  trialsPerTask?: number;
  limits: { maxTrials: number; maxWallMinutes: number };
  windows?: { startHourUtc: number; endHourUtc: number }[];
  expiresAt?: string;
};
export type BaselineJobView = Omit<ValidateJobView, "kind" | "counts"> & {
  kind: "baseline";
  tasks: { planned: number; reached: number; skipped: number };
  trials: { planned: number; started: number; graded: number; resolved: number; ended: number; void: number };
  dailyCap: number | null;
};
export type EvalSet = "dev" | "holdout";
export const PROMPT_ORIGINS = ["assignment", "run-objective", "commit-message"] as const;
export type PromptOrigin = typeof PROMPT_ORIGINS[number];
export type ComparisonJobRequest = {
  kind: "compare" | "confirm";
  configurations: TrialConfiguration[];
  taskFilter?: {
    taskIds?: string[]; origins?: EvalOrigin[]; areas?: string[]; promptOrigins?: PromptOrigin[];
    excludeGroups?: string[]; maxTasks?: number;
  };
  trialsPerTask?: number;
  limits: { maxTrials: number; maxWallMinutes: number };
  windows?: { startHourUtc: number; endHourUtc: number }[];
  expiresAt?: string;
};
export type ComparisonPin = { configRef: string; profileEpoch: number; promptVersion: string };
export type TrialJobPayload = {
  projectId: string; request: BaselineJobRequest | ComparisonJobRequest; requestDigest: string; jobDigest: string;
  tasks?: string[]; pins?: ComparisonPin[]; subject?: string;
};
export type ComparisonJobView = Omit<BaselineJobView, "kind" | "trials"> & {
  kind: "compare" | "confirm";
  set: EvalSet;
  trials: { planned: number; started: number; graded: number; resolved: number | null; ended: number; void: number; reused: number };
  report: "pending" | "ready" | "unreadable" | null;
};
export type EvalJobView = ValidateJobView | BaselineJobView | ComparisonJobView;
export type PairResult = {
  a: number; b: number; n: number; mean: number | null; interval: [number, number] | null;
  sign: { wins: number; losses: number; ties: number; p: number }; holm: number;
  detectable: { observed: number | null; planning: [number, number] | null };
};
export type ComparisonStats = {
  trialsPerTask: number; conclusive: boolean;
  tasks: { planned: number; analysed: number; leftHoldout: number };
  pairs: PairResult[];
  sensitivity: { a: number; b: number; n: number; mean: number | null }[];
  attrition: {
    configuration: number; void: Record<"void-limit" | "void-host" | "void-owner", number>; changed: number; short: number;
  }[];
  cost: {
    configuration: number; trials: number; resolved: number; costed: number; tokensPerResolved: number | null;
    spentUsdPerResolved: number | null; listUsdPerResolved: null; minutesPerResolved: number | null;
  }[];
  byPromptOrigin: { promptOrigin: PromptOrigin; n: number; pairs: PairResult[] }[];
  byArea: { area: string; n: number; pairs: PairResult[] }[];
};
export type ComparisonReport = ComparisonStats & {
  jobId: string; projectId: string; kind: "compare" | "confirm"; set: EvalSet; source: "replay"; metric: "resolved";
  status: RoutineStatus; reason: EvalJobReason | null; generatedAt: string;
  configurations: { index: number; profileId: string; provider: string; profileEpoch: number; promptVersion: string }[];
};
export type ReplayPrior = {
  projectId: string; profileId: string; profile: { provider: string; model: string | null; effort: string | null };
  profileEpoch: number; promptVersion: string; role: "implementer"; area: string; kind: string | null;
  tasks: number; trials: number; resolved: number; source: "replay"; promptOrigin: PromptOrigin; generatedAt: string; jobId: string;
};
export type ValidateJobRequest = {
  kind: "validate";
  taskFilter?: { taskIds?: string[]; origins?: EvalOrigin[]; areas?: string[]; revalidate?: boolean; maxTasks?: number };
  limits: { maxWallMinutes: number };
  windows?: { startHourUtc: number; endHourUtc: number }[];
  expiresAt?: string;
};
export type EvalSummary = {
  projectId: string;
  capture: { on: boolean };
  mining: { on: boolean } & MiningStatus;
  tasks: { byState: Record<EvalState, number>; byOrigin: Record<EvalOrigin, Record<EvalState, number>>;
           byArea: { area: string; candidate: number; valid: number }[]; bySet: { dev: number; holdout: number } | null };
  groups: { total: number; devOnly: number; largest: number; holdout: number; exposed: number };
  coverage: { days: number; validCaptured: number; accepted: number; share: number } | null;
  grader: { state: GraderState; version: number | null };
  evalIdentity: { state: EvalIdentityState; lastProbe?: { state: EvalIdentityState; at: string } | null };
  trials: { today: number; dailyCap: number | null };
  jobs: EvalJobView[];
};
export type EvalRefusal = { status: 400 | 404 | 409 | 503; code: "invalid-eval-request" | "unknown-project" | "unknown-job" | "unknown-task"
  | "job-active" | "request-conflict" | "eval-config-incomplete" | "invalid-job-transition" | "task-not-active" | "evidence-unavailable"
  | "profile-not-approved" | "too-few-tasks" | "subject-confirmed" | "report-not-ready" | "report-unreadable" | "no-report" };
export interface EvalHostApi {
  summary(projectId: string): Promise<EvalSummary | EvalRefusal>;
  jobs(): EvalJobView[] | EvalRefusal;
  job(jobId: string): EvalJobView | EvalRefusal;
  create(projectId: string, request: ValidateJobRequest | BaselineJobRequest | ComparisonJobRequest, requestId: string): { created: boolean; job: EvalJobView } | EvalRefusal;
  control(jobId: string, action: "pause" | "resume" | "cancel"): EvalJobView | EvalRefusal;
  retire(taskId: string): { taskId: string; state: "retired" } | EvalRefusal;
  report(jobId: string): ComparisonReport | EvalRefusal;
  priors(projectId: string): { projectId: string; priors: ReplayPrior[] } | EvalRefusal;
}
