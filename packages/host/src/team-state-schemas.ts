import type { ConnectorSource } from "./mcp-types.js";
import type { CheckScan } from "./team-check-output.js";
import type { UsageTotals } from "./usage.js";
import type { StoredRollup, UsageRollup } from "./team-usage.js";
import { z } from "zod";
import { questionRecommendationSchema, type DecisionRecommendation } from "./question-recommendation.js";
import { INTERRUPT_CLASSES, REJECT_CODES, type InterruptClass, type RejectCode } from "./permission-policy.js";
import { TEAM_ROLE_VALUES, type TeamRole } from "./team-role.js";
import { teamCommandSchema, type TeamCommand } from "./schema-primitives.js";

export { TEAM_ROLE_VALUES, type TeamRole } from "./team-role.js";
export { teamCommandSchema, type TeamCommand };

const nonNegInt = z.number().int().min(0);
const usageTokensSchema = z.object({
  input: nonNegInt,
  output: nonNegInt,
  reasoning: nonNegInt,
  cacheRead: nonNegInt,
  cacheWrite: nonNegInt,
}).strict();
const usagePricingSchema = z.object({
  configured: nonNegInt,
  catalog: nonNegInt,
  provider: nonNegInt,
  unknown: nonNegInt,
}).strict();
const legacyUsagePricingSchema = z.object({
  configured: nonNegInt,
  catalog: nonNegInt.optional(),
  provider: nonNegInt,
  unknown: nonNegInt,
}).strict();
export const usageTotalsSchema: z.ZodType<UsageTotals> = z.object({
  cost: z.number().min(0),
  tokens: usageTokensSchema,
  messages: nonNegInt,
  pricing: usagePricingSchema,
}).strict();
export type LegacyUsageTotals = Omit<UsageTotals, "pricing"> & {
  pricing: Omit<UsageTotals["pricing"], "catalog"> & { catalog?: number };
  incomplete?: boolean;
};
const legacyTotalsOnlyUsageSchema: z.ZodType<LegacyUsageTotals> = z.object({
  cost: z.number().min(0),
  tokens: usageTokensSchema,
  messages: nonNegInt,
  pricing: legacyUsagePricingSchema,
  incomplete: z.boolean().optional(),
}).strict();
const providerUsageMapSchema = z.object({
  claude: usageTotalsSchema.optional(),
  codex: usageTotalsSchema.optional(),
  grok: usageTotalsSchema.optional(),
  opencode: usageTotalsSchema.optional(),
  demo: usageTotalsSchema.optional(),
}).strict();
export const usageRollupSchema: z.ZodType<UsageRollup> = z.object({
  total: usageTotalsSchema,
  byProfile: z.record(z.string().min(1), usageTotalsSchema),
  byProvider: providerUsageMapSchema,
  unmeasuredMembers: nonNegInt,
  partialMembers: nonNegInt,
  unavailable: z.literal(true).optional(),
}).strict();
export const storedUsageRollupSchema: z.ZodType<StoredRollup> = z.object({
  total: usageTotalsSchema,
  byProfile: z.record(z.string().min(1), usageTotalsSchema),
  byProvider: providerUsageMapSchema,
  unmeasuredMembers: nonNegInt,
  partialMembers: nonNegInt.optional(),
  unavailable: z.literal(true).optional(),
}).strict();
export type GoalCycleUsage =
  | (UsageTotals & StoredRollup)
  | (LegacyUsageTotals & {
      total?: never;
      byProfile?: never;
      byProvider?: never;
      unmeasuredMembers?: never;
      partialMembers?: never;
      unavailable?: never;
    });
export const goalCycleUsageSchema: z.ZodType<GoalCycleUsage> = z.union([
  z.object({
    cost: z.number().min(0),
    tokens: usageTokensSchema,
    messages: nonNegInt,
    pricing: usagePricingSchema,
    total: usageTotalsSchema,
    byProfile: z.record(z.string().min(1), usageTotalsSchema),
    byProvider: providerUsageMapSchema,
    unmeasuredMembers: nonNegInt,
    partialMembers: nonNegInt.optional(),
    unavailable: z.literal(true).optional(),
  }).strict(),
  legacyTotalsOnlyUsageSchema,
]);

export const commitHashSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
export const connectorSourceSchema = z.object({ kind: z.literal("connector"), id: z.string().min(1), name: z.string().min(1) }).strict();
const decisionRecommendationSchema = questionRecommendationSchema.extend({
  outcome: z.enum(["matched", "different", "other"]).optional(),
}).strict();
const teamPublicationCategorySchema = z.enum(["auth", "network", "not-found", "rejected", "nested-repository", "other"]);
export type TeamPublicationCategory = z.infer<typeof teamPublicationCategorySchema>;

export const githubRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
export const gitBranchSchema = z.string().min(1).max(255).refine(value =>
  value !== "@" && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("..") && !value.includes("@{") &&
  !value.includes("//") && !value.includes("\\") && !/[~^:?*\s\x00-\x1f\x7f]/.test(value) &&
  !value.includes("[") && !value.includes("]") &&
  value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
"Use a safe Git branch name");

export interface TeamPublicationFailure {
  commit: string;
  category: TeamPublicationCategory;
  attempts: number;
  at: string;
  retryAt: string;
}
export type TeamPublication =
  | { repository: string; branch: string; commit: string; publishedAt: string; failure?: TeamPublicationFailure }
  | { repository: string; branch: string; commit?: never; publishedAt?: never; failure: TeamPublicationFailure };
export type TeamPublicationState = TeamPublication;
const teamPublicationFailureSchema = z.object({
  commit: commitHashSchema,
  category: teamPublicationCategorySchema,
  attempts: z.number().int().min(1),
  at: z.iso.datetime(),
  retryAt: z.iso.datetime(),
}).strict();
export const teamPublicationSchema: z.ZodType<TeamPublicationState> = z.union([
  z.object({
    repository: githubRepositorySchema,
    branch: gitBranchSchema,
    commit: commitHashSchema,
    publishedAt: z.iso.datetime(),
    failure: teamPublicationFailureSchema.optional(),
  }).strict(),
  z.object({
    repository: githubRepositorySchema,
    branch: gitBranchSchema,
    failure: teamPublicationFailureSchema,
  }).strict(),
]);

interface TeamPermissionAgentDecisionBase {
  requestId: string;
  memberId: string;
  sessionId: string;
  role: TeamRole;
  taskId?: string;
  promptId: number;
  at: string;
}
export type TeamPermissionAgentDecision =
  | (TeamPermissionAgentDecisionBase & { result: "allowed"; decisionId: string; delivery: "receipt"; code?: never; interruptClass?: never })
  | (TeamPermissionAgentDecisionBase & { result: "rejected"; decisionId: string; code: RejectCode; delivery: "receipt"; interruptClass?: never })
  | (TeamPermissionAgentDecisionBase & { result: "owner"; decisionId: string; interruptClass: InterruptClass; code?: never; delivery?: never })
  | (TeamPermissionAgentDecisionBase & { result: "undeliverable" | "stale"; decisionId?: string; code?: RejectCode; delivery?: "refusal" | "uncertain"; interruptClass?: never });
export type TeamPermissionAgentDecisionState = TeamPermissionAgentDecision;
const teamPermissionAgentDecisionBaseShape = {
  requestId: z.string().min(1),
  memberId: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(TEAM_ROLE_VALUES),
  taskId: z.string().min(1).optional(),
  promptId: z.number().int().min(1),
  at: z.iso.datetime(),
};
export const teamPermissionAgentDecisionSchema: z.ZodType<TeamPermissionAgentDecisionState> = z.discriminatedUnion("result", [
  z.object({ ...teamPermissionAgentDecisionBaseShape, result: z.literal("allowed"), decisionId: z.string().min(1), delivery: z.literal("receipt") }).strict(),
  z.object({ ...teamPermissionAgentDecisionBaseShape, result: z.literal("rejected"), decisionId: z.string().min(1), code: z.enum(REJECT_CODES), delivery: z.literal("receipt") }).strict(),
  z.object({ ...teamPermissionAgentDecisionBaseShape, result: z.literal("owner"), decisionId: z.string().min(1), interruptClass: z.enum(INTERRUPT_CLASSES) }).strict(),
  z.object({ ...teamPermissionAgentDecisionBaseShape, result: z.literal("undeliverable"), decisionId: z.string().min(1).optional(), code: z.enum(REJECT_CODES).optional(), delivery: z.enum(["refusal", "uncertain"]).optional() }).strict(),
  z.object({ ...teamPermissionAgentDecisionBaseShape, result: z.literal("stale"), decisionId: z.string().min(1).optional(), code: z.enum(REJECT_CODES).optional(), delivery: z.enum(["refusal", "uncertain"]).optional() }).strict(),
]);

interface PermissionDecisionReportBase {
  kind: "permission-decision";
  decisionId: string;
  summary: string;
}
export type PermissionDecisionReport =
  | (PermissionDecisionReportBase & { verdict: "approve-once" | "escalate"; requestedPaths?: never })
  | (PermissionDecisionReportBase & { verdict: "request-evidence"; requestedPaths: string[] });
const permissionDecisionBaseShape = {
  kind: z.literal("permission-decision"),
  decisionId: z.uuid(),
  summary: z.string().trim().min(1).max(2000),
};
export const permissionDecisionReportSchema = z.discriminatedUnion("verdict", [
  z.object({ ...permissionDecisionBaseShape, verdict: z.literal("approve-once") }).strict(),
  z.object({ ...permissionDecisionBaseShape, verdict: z.literal("escalate") }).strict(),
  z.object({ ...permissionDecisionBaseShape, verdict: z.literal("request-evidence"), requestedPaths: z.array(z.string().trim().min(1).max(512)).min(1).max(8) }).strict(),
]) satisfies z.ZodType<PermissionDecisionReport>;

interface DeliveryReconciliationReportBase {
  kind: "delivery-reconciliation";
  headCommit: string;
  repository: string;
  branch: string;
  baseHeadCommit: string;
  summary: string;
}
export type DeliveryReconciliationReport =
  | (DeliveryReconciliationReportBase & { disposition: "no-publication"; remoteHeadCommit?: never; pullRequestUrl?: never })
  | (DeliveryReconciliationReportBase & { disposition: "owned-branch"; remoteHeadCommit: string; pullRequestUrl?: never })
  | (DeliveryReconciliationReportBase & { disposition: "pull-request"; remoteHeadCommit: string; pullRequestUrl: string });
const deliveryReconciliationBaseShape = {
  kind: z.literal("delivery-reconciliation"),
  headCommit: commitHashSchema,
  repository: githubRepositorySchema,
  branch: gitBranchSchema,
  baseHeadCommit: commitHashSchema,
  summary: z.string().trim().min(1).max(4000),
};
export const deliveryReconciliationReportSchema = z.discriminatedUnion("disposition", [
  z.object({ ...deliveryReconciliationBaseShape, disposition: z.literal("no-publication") }).strict(),
  z.object({ ...deliveryReconciliationBaseShape, disposition: z.literal("owned-branch"), remoteHeadCommit: commitHashSchema }).strict(),
  z.object({ ...deliveryReconciliationBaseShape, disposition: z.literal("pull-request"), remoteHeadCommit: commitHashSchema, pullRequestUrl: z.string().trim().min(1).max(500) }).strict(),
]) satisfies z.ZodType<DeliveryReconciliationReport>;

export interface TeamSavedWorkFailure {
  category: TeamPublicationCategory;
  attempts: number;
  at: string;
  retryAt: string;
}
interface TeamMemberSavedWorkBase {
  revision: number;
  at: string;
}
export type TeamMemberSavedWork =
  | (TeamMemberSavedWorkBase & { state: "published"; repository: string; branch: string; commit: string; failure?: never })
  | (TeamMemberSavedWorkBase & { state: "nothing-to-save"; repository?: never; branch?: never; commit?: never; failure?: never })
  | (TeamMemberSavedWorkBase & { state: "retrying" | "gave-up"; repository: string; branch: string; commit?: string; failure: TeamSavedWorkFailure });
const teamSavedWorkFailureSchema = z.object({
  category: teamPublicationCategorySchema,
  attempts: z.number().int().min(1),
  at: z.iso.datetime(),
  retryAt: z.iso.datetime(),
}).strict();
export const teamMemberSavedWorkSchema: z.ZodType<TeamMemberSavedWork> = z.discriminatedUnion("state", [
  z.object({ revision: z.number().int().min(1), state: z.literal("published"), repository: githubRepositorySchema, branch: gitBranchSchema, commit: commitHashSchema, at: z.iso.datetime() }).strict(),
  z.object({ revision: z.number().int().min(1), state: z.literal("nothing-to-save"), at: z.iso.datetime() }).strict(),
  z.object({ revision: z.number().int().min(1), state: z.literal("retrying"), repository: githubRepositorySchema, branch: gitBranchSchema, commit: commitHashSchema.optional(), at: z.iso.datetime(), failure: teamSavedWorkFailureSchema }).strict(),
  z.object({ revision: z.number().int().min(1), state: z.literal("gave-up"), repository: githubRepositorySchema, branch: gitBranchSchema, commit: commitHashSchema.optional(), at: z.iso.datetime(), failure: teamSavedWorkFailureSchema }).strict(),
]);

export interface TeamDecision {
  id: string;
  memberId: string;
  revision: number;
  question: string;
  options: string[];
  answerMode?: "approval" | "single" | "multiple";
  createdAt: string;
  answer?: string;
  answeredBy?: "owner" | "coordinator" | "connector";
  source?: ConnectorSource;
  answeredAt?: string;
  intentQuestions?: string[];
  recommendation?: DecisionRecommendation;
}
type TeamDecisionCore = Omit<TeamDecision, "answer" | "answeredBy" | "source" | "answeredAt">;
export type OpenTeamDecision = TeamDecisionCore & {
  answer?: never;
  answeredBy?: never;
  source?: never;
  answeredAt?: never;
};
export type AnsweredTeamDecision = TeamDecisionCore & (
  | { answer: string; answeredBy?: "owner" | "coordinator"; source?: never; answeredAt?: string }
  | { answer: string; answeredBy: "connector"; source?: ConnectorSource; answeredAt?: string }
);
export type TeamDecisionState =
  | { state: "open"; decision: OpenTeamDecision }
  | { state: "answered"; decision: AnsweredTeamDecision };
export function isOpenTeamDecision(decision: TeamDecision): decision is OpenTeamDecision {
  return decision.answer === undefined
    && decision.answeredBy === undefined
    && decision.answeredAt === undefined
    && decision.source === undefined;
}
export function isAnsweredTeamDecision(decision: TeamDecision): decision is AnsweredTeamDecision {
  if (typeof decision.answer !== "string" || decision.answer.length === 0) return false;
  if (decision.source !== undefined && decision.answeredBy !== "connector") return false;
  return true;
}
export function projectTeamDecision(decision: TeamDecision): TeamDecisionState {
  if (isOpenTeamDecision(decision)) return { state: "open", decision };
  if (isAnsweredTeamDecision(decision)) return { state: "answered", decision };
  throw new Error("Invalid team decision state: answer, answeredBy, answeredAt, and source are inconsistent.");
}
const teamDecisionBaseShape = {
  id: z.string().min(1),
  memberId: z.string().min(1),
  revision: z.number().int().min(1),
  question: z.string().min(1),
  options: z.array(z.string()),
  answerMode: z.enum(["approval", "single", "multiple"]).optional(),
  createdAt: z.iso.datetime(),
  intentQuestions: z.array(z.string().min(1)).optional(),
  recommendation: decisionRecommendationSchema.optional(),
};
export const teamDecisionSchema: z.ZodType<OpenTeamDecision | AnsweredTeamDecision> = z.union([
  z.object(teamDecisionBaseShape).strict(),
  z.object({
    ...teamDecisionBaseShape,
    answer: z.string().min(1),
    answeredBy: z.enum(["owner", "coordinator"]).optional(),
    answeredAt: z.iso.datetime().optional(),
  }).strict(),
  z.object({
    ...teamDecisionBaseShape,
    answer: z.string().min(1),
    answeredBy: z.literal("connector"),
    source: connectorSourceSchema.optional(),
    answeredAt: z.iso.datetime().optional(),
  }).strict(),
]);

interface TeamCheckBase {
  command: TeamCommand;
  phase?: "setup";
  headCommit?: string;
  startedAt: string;
  output: string;
  revision: number;
  round?: number;
}
export type RunningTeamCheck = TeamCheckBase & { status: "running"; finishedAt?: never; exitCode?: never; scan?: never };
export type PassedTeamCheck = TeamCheckBase & { status: "passed"; finishedAt: string; exitCode?: 0; scan?: never };
export type FailedTeamCheck = TeamCheckBase & { status: "failed" | "interrupted"; finishedAt: string; exitCode?: number | null; scan?: CheckScan };
export type TeamCheck = RunningTeamCheck | PassedTeamCheck | FailedTeamCheck;
export type TeamCheckState = TeamCheck;
export function isRunningTeamCheck(check: TeamCheck): check is RunningTeamCheck {
  const raw = check as TeamCheckBase & { status: string; finishedAt?: unknown; exitCode?: unknown; scan?: unknown };
  return raw.status === "running"
    && raw.finishedAt === undefined
    && raw.exitCode === undefined
    && raw.scan === undefined;
}
export function isPassedTeamCheck(check: TeamCheck): check is PassedTeamCheck {
  const raw = check as TeamCheckBase & { status: string; finishedAt?: unknown; exitCode?: unknown; scan?: unknown };
  return raw.status === "passed"
    && typeof raw.finishedAt === "string"
    && (raw.exitCode === undefined || raw.exitCode === 0)
    && raw.scan === undefined;
}
export function isFailedTeamCheck(check: TeamCheck): check is FailedTeamCheck {
  const raw = check as TeamCheckBase & { status: string; finishedAt?: unknown };
  return (raw.status === "failed" || raw.status === "interrupted")
    && typeof raw.finishedAt === "string";
}
const checkScanSchema = z.object({
  bytes: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  failures: z.array(z.object({ line: z.string(), detail: z.string() }).strict()),
  capped: z.literal(true).optional(),
}).strict();
const teamCheckBaseShape = {
  command: teamCommandSchema,
  phase: z.literal("setup").optional(),
  headCommit: commitHashSchema.optional(),
  startedAt: z.iso.datetime(),
  output: z.string(),
  revision: z.number().int().min(1),
  round: z.number().int().min(0).optional(),
};
export const teamCheckSchema: z.ZodType<TeamCheckState> = z.discriminatedUnion("status", [
  z.object({ ...teamCheckBaseShape, status: z.literal("running") }).strict(),
  z.object({ ...teamCheckBaseShape, status: z.literal("passed"), finishedAt: z.iso.datetime(), exitCode: z.literal(0).optional() }).strict(),
  z.object({ ...teamCheckBaseShape, status: z.literal("failed"), finishedAt: z.iso.datetime(), exitCode: z.number().int().nullable().optional(), scan: checkScanSchema.optional() }).strict(),
  z.object({ ...teamCheckBaseShape, status: z.literal("interrupted"), finishedAt: z.iso.datetime(), exitCode: z.number().int().nullable().optional(), scan: checkScanSchema.optional() }).strict(),
]);

type TeamPendingOperationFailure =
  | { failed: false; failureCode?: never }
  | { failed: true; failureCode?: string };
type TeamPendingOperationSource =
  | { sourceMemberId?: never; sourceRole?: never }
  | { sourceMemberId: string; sourceRole: TeamRole };
type TeamPendingOperationCensus =
  | { processes?: never; processesCheckedAt?: never }
  | { processes: "running" | "in-use" | "ended" | "unknown"; processesCheckedAt: string };
export type TeamPendingOperation = {
  id: string;
  kind: "prepare" | "member" | "result" | "check";
  revision: number;
} & TeamPendingOperationFailure & TeamPendingOperationSource & TeamPendingOperationCensus;
export type TeamLeftoverProcesses =
  | { since: string; state: "unchecked"; checkedAt?: never }
  | { since: string; state: "running" | "in-use" | "unknown"; checkedAt: string };
export function buildTeamPendingOperation(input: {
  id: string;
  kind: TeamPendingOperation["kind"];
  revision: number;
  failure?: { code?: string };
  source?: { memberId: string; role: TeamRole };
  census?: { state: "running" | "in-use" | "ended" | "unknown"; at: string };
}): TeamPendingOperation {
  const failure: TeamPendingOperationFailure = input.failure
    ? { failed: true, ...(input.failure.code ? { failureCode: input.failure.code } : {}) }
    : { failed: false };
  const source: TeamPendingOperationSource = input.source
    ? { sourceMemberId: input.source.memberId, sourceRole: input.source.role }
    : {};
  const census: TeamPendingOperationCensus = input.census
    ? { processes: input.census.state, processesCheckedAt: input.census.at }
    : {};
  return { id: input.id, kind: input.kind, revision: input.revision, ...failure, ...source, ...census };
}
export const teamPendingOperationSchema: z.ZodType<TeamPendingOperation> = z.object({
  id: z.string().min(1),
  kind: z.enum(["prepare", "member", "result", "check"]),
  revision: z.number().int().min(1),
  failed: z.boolean(),
  failureCode: z.string().min(1).optional(),
  sourceMemberId: z.string().min(1).optional(),
  sourceRole: z.enum(TEAM_ROLE_VALUES).optional(),
  processes: z.enum(["running", "in-use", "ended", "unknown"]).optional(),
  processesCheckedAt: z.iso.datetime().optional(),
}).strict().superRefine((operation, context) => {
  if (!operation.failed && operation.failureCode !== undefined)
    context.addIssue({ code: "custom", path: ["failureCode"], message: "A non-failed pending operation cannot carry a failureCode." });
  if ((operation.sourceMemberId === undefined) !== (operation.sourceRole === undefined))
    context.addIssue({ code: "custom", path: ["sourceMemberId"], message: "Pending operation sourceMemberId and sourceRole must appear together." });
  if ((operation.processes === undefined) !== (operation.processesCheckedAt === undefined))
    context.addIssue({ code: "custom", path: ["processes"], message: "Pending operation processes and processesCheckedAt must appear together." });
}) as unknown as z.ZodType<TeamPendingOperation>;
