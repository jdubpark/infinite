import { z } from "zod";
import type { TeamBrief, TeamLineup } from "./team-types.js";
import type { UsageTotals } from "./usage.js";
import type { UsageRollup } from "./team-usage.js";
import type { LinearTrackingView } from "./linear-types.js";

const scopedPath = z.string().trim().min(1).max(300).refine(value => value === "." || (!value.startsWith("/") && !value.includes("\\") && !/[\0*?\[\]:]/.test(value) && !value.split("/").some(part => ["", ".", "..", ".git"].includes(part))), "Use a repository-relative file or folder, or . for the whole project");
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
  maxRuns: z.number().int().min(1).max(10).default(3),
  maxMinutes: z.number().int().min(5).max(1440).default(60),
  maxMembers: z.number().int().min(4).max(200).default(24),
  parallelism: z.number().int().min(1).max(4).default(3),
}).strict();
export type CreateGoal = z.infer<typeof createGoalSchema>;
export const goalActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const goalSteerSchema = goalActionSchema.extend({ text: z.string().trim().min(1).max(8000) }).strict();
export const goalOutcomeSchema = goalActionSchema.extend({
  result: z.enum(["achieved", "not-achieved", "inconclusive"]),
  summary: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().min(1).max(8000),
}).strict();
export type GoalStatus = "running" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-opportunity" | "limit-reached" | "cancelled" | "achieved";
export interface GoalCycle {
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
  /** Computed on read from the cycle's team; never stored. */
  usage?: UsageTotals;
}
export interface ProductGoal extends Omit<CreateGoal, "requestId"> {
  linear?: LinearTrackingView;
  id: string;
  revision: number;
  status: GoalStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  lineup: TeamLineup;
  activeTeamId?: string;
  cycles: GoalCycle[];
  memberCount: number;
  /** Computed on read, summed over cycles; never stored. */
  usage?: UsageRollup;
  steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[];
  outcomes: { result: "achieved" | "not-achieved" | "inconclusive"; summary: string; evidence: string; at: string; revision: number }[];
}
