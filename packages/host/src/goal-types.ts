import { z } from "zod";
import type { TeamBrief, TeamLineup } from "./team-types.js";
import type { UsageTotals } from "./usage.js";
import type { UsageRollup } from "./team-usage.js";
import type { LinearTrackingView } from "./linear-types.js";
import type { AutonomyMode } from "./autonomy.js";
import type { RunAssessment } from "./verdict-types.js";
import { signalKinds, type PendingWake } from "./signals/types.js";

export function isScopedPath(value: string): boolean {
  return value === "." || (!value.startsWith("/") && !value.includes("\\") && !/[\0*?\[\]:]/.test(value) && !value.split("/").some(part => ["", ".", "..", ".git"].includes(part)));
}
const scopedPath = z.string().trim().min(1).max(300).refine(isScopedPath, "Use a repository-relative file or folder, or . for the whole project");
/** A finite goal that omits `maxRuns` gets this many cycles. Applied in code so a standing goal can refuse an explicit value. */
export const defaultMaxRuns = 3;
/** A standing objective: a cycle every `cadenceMinutes`, no cycle limit, allowances renewed per cycle. */
export const goalStandingSchema = z.object({
  shape: z.literal("objective"),
  cadenceMinutes: z.number().int().min(30).max(10080).default(1440),
  /** Host signal kinds that may start the next cycle before its cadence. */
  wakeOn: z.array(z.enum(signalKinds)).min(1).max(4).refine(kinds => new Set(kinds).size === kinds.length, "List each signal kind once").optional(),
}).strict();
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
  /** A finite goal defaults to `defaultMaxRuns` through parseCreateGoal; a standing goal refuses it. */
  maxRuns: z.number().int().min(1).max(10).optional(),
  maxMinutes: z.number().int().min(5).max(1440).default(60),
  /** Automatic extensions while an active agent shows activity; 0 disables them. */
  extendMinutes: z.number().int().min(0).max(240).optional(),
  /** Ceiling for the goal's whole time, including extensions. Defaults to maxMinutes. */
  maxTotalMinutes: z.number().int().max(1440).optional(),
  maxMembers: z.number().int().min(4).max(200).default(24),
  parallelism: z.number().int().min(1).max(4).default(3),
  /** Absent on a finite goal. In a standing goal the time and attempt limits apply to each cycle. */
  standing: goalStandingSchema.optional(),
}).strict().refine(value => value.maxTotalMinutes === undefined || value.maxTotalMinutes >= value.maxMinutes, { path: ["maxTotalMinutes"], message: "The total time ceiling cannot be shorter than the time limit." })
  .refine(value => value.standing === undefined || value.maxRuns === undefined, { path: ["maxRuns"], message: "A standing goal has no cycle limit. Omit maxRuns." });
export type CreateGoal = z.infer<typeof createGoalSchema>;
/**
 * Parses a creation request. A finite goal without `maxRuns` gets `defaultMaxRuns` in schema key order, so its
 * fingerprint and record match those written when the schema applied the default itself.
 */
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
/** How a settled standing cycle counts (design 3.3). */
export type CycleClass = "reviewed" | "no-change" | "failed" | "excluded";
/** Why the host paused or blocked a standing goal. */
export type GoalReasonCode = "supervised-mode" | "repeated-failures" | "external-operation";
export interface CycleWake { signalIds: string[]; dropped: number; owner?: true }
export const goalActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const goalExtendSchema = goalActionSchema.extend({ minutes: z.number().int().min(5).max(1440) }).strict();
export const goalSteerSchema = goalActionSchema.extend({ text: z.string().trim().min(1).max(8000) }).strict();
export const goalParallelismSchema = goalActionSchema.extend({ parallelism: z.number().int().min(1).max(4) }).strict();
export const goalOutcomeSchema = goalActionSchema.extend({
  result: z.enum(["achieved", "not-achieved", "inconclusive"]),
  summary: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().min(1).max(8000),
  /** The agent assessment this answer is about: one of the goal's cycle assessments. */
  verdictId: z.uuid().optional(),
  /** Not achieved, and the goal goes on: needs the `verdictId` of the provisional assessment that stopped it. */
  continue: z.literal(true).optional(),
}).strict().refine(value => value.continue === undefined || (value.verdictId !== undefined && value.result === "not-achieved"), { path: ["continue"], message: "Continue needs the verdictId of the assessment and the result not-achieved." });
export type GoalOutcomeInput = z.infer<typeof goalOutcomeSchema>;
/** A cycle's agent assessment with its progress: met criteria gained over the newest earlier assessed cycle. */
export type GoalAssessment = RunAssessment & { progress: number };
export type GoalStatus = "running" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-opportunity" | "limit-reached" | "cancelled" | "achieved";
export interface GoalCycle {
  /** The mode the cycle's launch was prepared in; read once, when the launch is prepared. */
  autonomy?: AutonomyMode;
  teamId: string;
  cycle: number;
  goalRevision: number;
  status: string;
  startedAt: string;
  finishedAt?: string;
  baseCommit?: string;
  headCommit?: string;
  endedAs?: { status: string; headCommit?: string };
  branch?: string;
  workspace?: string;
  brief?: TeamBrief;
  reason?: string;
  memberCount: number;
  /** Retained cycle rollup plus flattened totals for existing display clients. */
  usage?: UsageTotals & UsageRollup;
  /** Standing goals: the lineup this cycle started with. */
  lineup?: TeamLineup;
  /** Standing goals: the host stopped the cycle at its time limit; `fuseOpen` when a spend fuse was open then. */
  deadlineStop?: { at: string; fuseOpen?: true };
  /** Standing goals: how the cycle counts, recorded once when its members have stopped. */
  class?: CycleClass;
  /** The cycle's agent assessment, provisional; copied from its run. */
  assessment?: GoalAssessment;
  settledAt?: string;
  /** Standing goals: the pending wake this cycle consumed. */
  wake?: CycleWake;
}
export interface ProductGoal extends Omit<CreateGoal, "requestId"> {
  linearTracking?: boolean;
  linear?: LinearTrackingView;
  id: string;
  revision: number;
  status: GoalStatus;
  /** Structured budget stop reason; absent on legacy goals until migrated or stopped. */
  stopReason?: "deadline" | "member-limit" | "provisional-met";
  /** When the goal entered its current blocked period; a record from before this field takes its last save time. */
  blockedAt?: string;
  /** A deadline-stopped child should be replaced after an owner extends the goal. */
  deadlineContinuation?: boolean;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  /** Absent on goals recorded before time ceilings existed; they use createdAt plus maxTotalMinutes or maxMinutes. */
  ceilingAt?: string;
  lineup: TeamLineup;
  /** The mode the goal started in. Absent on goals recorded before the mode existed; read with autonomyOf(). */
  autonomy?: AutonomyMode;
  activeTeamId?: string;
  /** A standing goal keeps its newest 50 cycles, and always the latest reviewed one. */
  cycles: GoalCycle[];
  memberCount: number;
  /** Computed on read, summed over cycles and `foldedUsage`; never stored. */
  usage?: UsageRollup;
  /** Standing goals: a count per class of the cycles folded out of `cycles`. */
  cycleTotals?: Record<CycleClass, number>;
  /** Standing goals: the summed usage and member attempts of folded cycles. */
  foldedUsage?: UsageRollup;
  foldedMembers?: number;
  /** Standing goals: failed cycles in a row since the last reviewed or no-change cycle or owner resume. */
  failedCycles?: number;
  /** Standing goals: why the host paused or blocked the goal. */
  reasonCode?: GoalReasonCode;
  /** Standing goals with `wakeOn`: the last signal seq read. Unset until the inbox is readable. */
  signalCursor?: number;
  /** Standing goals: signals and owner direction waiting to start the next cycle early. */
  pendingWake?: PendingWake;
  /** Computed on read for a standing goal between cycles: the earliest cadence start. Never stored. */
  nextCycleAt?: string;
  steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[];
  outcomes: { result: "achieved" | "not-achieved" | "inconclusive"; summary: string; evidence: string; at: string; revision: number; verdictId?: string }[];
}
