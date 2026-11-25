import { z } from "zod";
import { goalCycleUsageSchema, teamBriefSchema, teamLineupSchema, type GoalCycleUsage, type TeamBrief, type TeamLineup } from "./team-types.js";
import type { UsageRollup } from "./team-usage.js";
import type { LinearTrackingView } from "./linear-types.js";
import type { AutonomyMode } from "./autonomy.js";
import { VERDICT_LIMITS, type RunAssessment } from "./verdict-types.js";
import { signalKinds, type PendingWake } from "./signals/types.js";

export function isScopedPath(value: string): boolean {
  return value === "." || (!value.startsWith("/") && !value.includes("\\") && !/[\0*?\[\]:]/.test(value) && !value.split("/").some(part => ["", ".", "..", ".git"].includes(part)));
}
const scopedPath = z.string().trim().min(1).max(300).refine(isScopedPath, "Use a repository-relative file or folder, or . for the whole project");
export const defaultMaxRuns = 3;
export const goalStandingSchema = z.object({
  shape: z.literal("objective"),
  cadenceMinutes: z.number().int().min(30).max(10080).default(1440),
  wakeOn: z.array(z.enum(signalKinds)).min(1).max(4).refine(kinds => new Set(kinds).size === kinds.length, "List each signal kind once").optional(),
}).strict();
export type GoalStanding = z.infer<typeof goalStandingSchema>;
export const createGoalSchema = z.object({
  requestId: z.uuid(),
  projectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  linearIssueId: z.union([z.uuid(), z.string().trim().max(100).regex(/^[A-Z][A-Z0-9]*-\d+$/i)]).optional(),
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(12000),
  successCriteria: z.string().trim().min(1).max(4000),
  nonGoals: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  allowedPaths: z.array(scopedPath).min(1).max(32).default(["."]),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
  maxRuns: z.number().int().min(1).max(10).optional(),
  maxMinutes: z.number().int().min(5).max(1440).default(60),
  extendMinutes: z.number().int().min(0).max(240).optional(),
  maxTotalMinutes: z.number().int().max(1440).optional(),
  maxMembers: z.number().int().min(4).max(200).default(24),
  parallelism: z.number().int().min(1).max(4).default(3),
  standing: goalStandingSchema.optional(),
}).strict().refine(value => value.maxTotalMinutes === undefined || value.maxTotalMinutes >= value.maxMinutes, { path: ["maxTotalMinutes"], message: "The total time ceiling cannot be shorter than the time limit." })
  .refine(value => value.standing === undefined || value.maxRuns === undefined, { path: ["maxRuns"], message: "A standing goal has no cycle limit. Omit maxRuns." });
export type CreateGoal = z.infer<typeof createGoalSchema>;
export type FiniteCreateGoal = Omit<CreateGoal, "standing" | "maxRuns"> & { standing?: never; maxRuns?: number };
export type StandingCreateGoal = Omit<CreateGoal, "standing" | "maxRuns"> & { standing: GoalStanding; maxRuns?: never };
export type CreateGoalState =
  | { kind: "finite"; goal: FiniteCreateGoal }
  | { kind: "standing"; goal: StandingCreateGoal };
export function isStandingCreateGoal(goal: CreateGoal): goal is StandingCreateGoal {
  return goal.standing !== undefined && goal.maxRuns === undefined;
}
export function isFiniteCreateGoal(goal: CreateGoal): goal is FiniteCreateGoal {
  return goal.standing === undefined;
}
export function projectCreateGoal(goal: CreateGoal): CreateGoalState {
  if (goal.standing !== undefined && goal.maxRuns !== undefined) {
    throw new Error("Invalid goal creation state: standing goals cannot specify maxRuns.");
  }
  if (isStandingCreateGoal(goal)) return { kind: "standing", goal };
  return { kind: "finite", goal: goal as FiniteCreateGoal };
}
export function parseCreateGoal(input: unknown): CreateGoal {
  const parsed = createGoalSchema.parse(input);
  if (parsed.standing || parsed.maxRuns !== undefined) return parsed;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(createGoalSchema.shape)) {
    if (key === "maxRuns") ordered.maxRuns = defaultMaxRuns;
    else if (Object.hasOwn(parsed, key)) ordered[key] = parsed[key as keyof CreateGoal];
  }
  return ordered as CreateGoal;
}
export type CycleClass = "reviewed" | "no-change" | "failed" | "excluded";
export type GoalReasonCode = "supervised-mode" | "repeated-failures" | "external-operation";
export interface CycleWake { signalIds: string[]; dropped: number; owner?: true }
export const goalActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const goalExtendSchema = goalActionSchema.extend({ minutes: z.number().int().min(5).max(1440) }).strict();
export const goalSteerSchema = goalActionSchema.extend({ text: z.string().trim().min(1).max(8000) }).strict();
export const goalParallelismSchema = goalActionSchema.extend({ parallelism: z.number().int().min(1).max(4) }).strict();
interface GoalOutcomeInputBase {
  requestId: string;
  revision: number;
  summary: string;
  evidence: string;
}
export type GoalOutcomeInput =
  | (GoalOutcomeInputBase & {
      result: "achieved" | "not-achieved" | "inconclusive";
      verdictId?: string;
      continue?: never;
    })
  | (GoalOutcomeInputBase & {
      result: "not-achieved";
      verdictId: string;
      continue: true;
    });
const goalOutcomeDetailsShape = {
  summary: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().min(1).max(8000),
};
export const goalOutcomeSchema: z.ZodType<GoalOutcomeInput> = z.union([
  z.object({
    ...goalActionSchema.shape,
    result: z.enum(["achieved", "not-achieved", "inconclusive"]),
    ...goalOutcomeDetailsShape,
    verdictId: z.uuid().optional(),
  }).strict(),
  z.object({
    ...goalActionSchema.shape,
    result: z.literal("not-achieved"),
    ...goalOutcomeDetailsShape,
    verdictId: z.uuid(),
    continue: z.literal(true),
  }).strict(),
]);
export type GoalAssessment = RunAssessment & { progress: number };
export type GoalStatus = "running" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-opportunity" | "limit-reached" | "cancelled" | "achieved";
export interface GoalCycle {
  autonomy?: AutonomyMode;
  teamId: string;
  cycle: number;
  goalRevision: number;
  status: string;
  startedAt: string;
  finishedAt?: string;
  baseCommit?: string;
  headCommit?: string;
  branch?: string;
  workspace?: string;
  brief?: TeamBrief;
  reason?: string;
  memberCount: number;
  usage?: GoalCycleUsage;
  lineup?: TeamLineup;
  deadlineStop?: { at: string; fuseOpen?: true };
  class?: CycleClass;
  assessment?: GoalAssessment;
  supersededVerdictIds?: string[];
  settledAt?: string;
  wake?: CycleWake;
}
export type ActiveGoalCycle = Omit<GoalCycle, "finishedAt" | "class" | "settledAt"> & {
  finishedAt?: never;
  class?: never;
  settledAt?: never;
};
export type UnclassifiedGoalCycle = Omit<GoalCycle, "finishedAt" | "class" | "settledAt"> & {
  finishedAt: string;
  class?: never;
  settledAt?: never;
};
export type SettledGoalCycle = Omit<GoalCycle, "class" | "settledAt"> & { class: CycleClass; settledAt: string };
export type GoalCycleState =
  | { state: "active"; cycle: ActiveGoalCycle }
  | { state: "unclassified"; cycle: UnclassifiedGoalCycle }
  | { state: "settled"; cycle: SettledGoalCycle };
export function isActiveGoalCycle(cycle: GoalCycle): cycle is ActiveGoalCycle {
  return cycle.finishedAt === undefined && cycle.class === undefined && cycle.settledAt === undefined;
}
export function isUnclassifiedGoalCycle(cycle: GoalCycle): cycle is UnclassifiedGoalCycle {
  return cycle.finishedAt !== undefined && cycle.class === undefined && cycle.settledAt === undefined;
}
export function isSettledGoalCycle(cycle: GoalCycle): cycle is SettledGoalCycle {
  return cycle.class !== undefined && cycle.settledAt !== undefined;
}
export function projectGoalCycle(cycle: GoalCycle): GoalCycleState {
  if (isSettledGoalCycle(cycle)) return { state: "settled", cycle };
  if (isUnclassifiedGoalCycle(cycle)) return { state: "unclassified", cycle };
  if (isActiveGoalCycle(cycle)) return { state: "active", cycle };
  throw new Error("Invalid goal cycle state: class and settledAt must appear together.");
}
const assessmentCountSchema = z.number().int().min(0).max(VERDICT_LIMITS.criteria);
const goalAssessmentSchema: z.ZodType<GoalAssessment> = z.object({
  verdictId: z.uuid(),
  revision: z.number().int().min(1),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  kind: z.enum(["reviewed", "no-change"]),
  result: z.enum(["met", "not-met", "inconclusive"]),
  evaluatorResult: z.enum(["met", "not-met", "inconclusive"]).optional(),
  reason: z.enum(["no-independent-evaluator", "evaluator-unavailable", "record-unavailable", "context-too-large"]).optional(),
  counts: z.object({ met: assessmentCountSchema, notMet: assessmentCountSchema, inconclusive: assessmentCountSchema, pendingOwner: assessmentCountSchema }).strict(),
  criteria: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), state: z.enum(["met", "not-met", "inconclusive", "pending-owner"]) }).strict()).max(VERDICT_LIMITS.criteria),
  at: z.iso.datetime(),
  progress: z.number().int(),
}).strict();
const goalCycleBaseShape = {
  autonomy: z.enum(["supervised", "autonomous"]).optional(),
  teamId: z.string().min(1),
  cycle: z.number().int().min(1),
  goalRevision: z.number().int().min(1),
  status: z.string().min(1),
  startedAt: z.iso.datetime(),
  baseCommit: z.string().optional(),
  headCommit: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  brief: teamBriefSchema.optional(),
  reason: z.string().optional(),
  memberCount: z.number().int().min(0),
  usage: goalCycleUsageSchema.optional(),
  lineup: teamLineupSchema.optional(),
  deadlineStop: z.object({ at: z.iso.datetime(), fuseOpen: z.literal(true).optional() }).strict().optional(),
  assessment: goalAssessmentSchema.optional(),
  wake: z.object({ signalIds: z.array(z.string().min(1)), dropped: z.number().int().min(0), owner: z.literal(true).optional() }).strict().optional(),
};
export const goalCycleSchema: z.ZodType<ActiveGoalCycle | UnclassifiedGoalCycle | SettledGoalCycle> = z.union([
  z.object(goalCycleBaseShape).strict(),
  z.object({
    ...goalCycleBaseShape,
    finishedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    ...goalCycleBaseShape,
    finishedAt: z.iso.datetime().optional(),
    class: z.enum(["reviewed", "no-change", "failed", "excluded"]),
    settledAt: z.iso.datetime(),
  }).strict(),
]);
export interface ProductGoal extends Omit<CreateGoal, "requestId"> {
  linearTracking?: boolean;
  linear?: LinearTrackingView;
  id: string;
  revision: number;
  status: GoalStatus;
  stopReason?: "deadline" | "member-limit" | "provisional-met";
  blockedAt?: string;
  deadlineContinuation?: boolean;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  ceilingAt?: string;
  lineup: TeamLineup;
  autonomy?: AutonomyMode;
  activeTeamId?: string;
  cycles: GoalCycle[];
  memberCount: number;
  usage?: UsageRollup;
  cycleTotals?: Record<CycleClass, number>;
  foldedUsage?: UsageRollup;
  foldedMembers?: number;
  failedCycles?: number;
  reasonCode?: GoalReasonCode;
  signalCursor?: number;
  pendingWake?: PendingWake;
  nextCycleAt?: string;
  steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[];
  outcomes: { result: "achieved" | "not-achieved" | "inconclusive"; summary: string; evidence: string; at: string; revision: number; verdictId?: string }[];
}
