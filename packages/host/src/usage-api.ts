import { z } from "zod";
import type { UsageTokens } from "./usage.js";

export type Money = { usd: number; unpriced: number };
export type Balance = { amount: number; currency: string; asOf: string; stale: boolean } | null;
export type PlanSource = "owner" | "config";
export type AccountView = { id: string; kind: "metered" | "subscription"; month?: Money; planUsd?: number; planSource?: PlanSource; balance: Balance };
const planUsdSchema = z.number().finite().min(0).max(100_000).refine(value => {
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent)) <= 2;
}, "Plan fees may have at most two decimal places");
export const usagePlanSchema = z.object({ planUsd: planUsdSchema.nullable() }).strict();
export type UsagePlanRequest = z.infer<typeof usagePlanSchema>;
export type TaskUsage = { usd: number; unpriced: number; tokens: number; attempts: number; profiles: string[] };
export type BriefingUsage = { providerId: string; modelId: string; tokens: UsageTokens; reportedCost?: number };
export type UsageResolvers = {
  goalOfRun(runId: string): { id: string; title: string } | undefined;
  runTitle(runId: string): string | undefined;
  projectName(id: string): string | undefined;
  sessionTitle(id: string): string | undefined;
};
export type UsageMonth = { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number };
export type UsageApiSummary = import("./usage-service.js").UsageSummary;
export type DailyUsage = { tz: string; accounts: string[]; days: { date: string; usd: number; byAccount: Record<string, number> }[] };
export type ProjectUsage = { id: string; name: string; total: Money; month: Money & { unmeasured: number }; unmeasured: number; spark: number[] };
export type ProjectUsageDetail = {
  id: string; name: string; total: Money; unmeasured: number;
  byKind: { goals: number; teams: number; sessions: number; briefings: number };
  goals: { id: string; title: string; total: Money; tasks: number }[];
  teams: { id: string; title: string; goalId?: string; total: Money }[];
  sessions: { id: string; title: string; total: Money }[];
  briefings: { total: Money; runs: number; unmeasured: number };
};
export type GoalTaskUsage = { teamId: string; taskId: string; title: string; usage?: TaskUsage };
export type Score = { score: 1 | 2 | 3 | 4 | 5; why: string };
export type Rubric = { version: 1; correctness: Score; cleanliness: Score; extensibility: Score; docs: Score; reviewerProfileId: string };
export type ModelRow = {
  profileId: string; label: string; provider: string; role: string; metered: boolean;
  attempts: number; integrated: number; rate: number; rateInterval: [number, number] | null;
  medianUsd: number | null; medianTokens: number | null; usdPerMTok: number | null;
  medianMinutes: number | null; meanReviewRounds: number | null;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number; n: number } | null;
  owner: { mean: number; n: number } | null; enough: boolean;
};
export type Suggestion = { text: string; profileId: string; comparedTo: string; role: string; n: [number, number] };
export type ModelUsage = { rubricVersion: 1; minAttempts: number; rows: ModelRow[]; suggestions: Suggestion[] };
