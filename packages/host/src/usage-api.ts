import { z } from "zod";
import type { UsageTokens } from "./usage.js";
import type { LedgerCoverageReason } from "./usage-store.js";

export type Money = { usd: number; unpriced: number };
export type Balance = { amount: number; currency: string; asOf: string; stale: boolean } | null;
export type PlanSource = "owner" | "config";
export type AccountView = { id: string; kind: "metered" | "subscription"; month?: Money; planUsd?: number; planSource?: PlanSource; balance: Balance };
const planUsdSchema = z.number().finite().min(0).max(100_000).refine(value => {
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent)) <= 2;
}, "Plan fees may have at most two decimal places");
export const usagePlanSchema = z.object({ planUsd: planUsdSchema.nullable() }).strict();
export type TaskUsage = { usd: number; unpriced: number; tokens: number; attempts: number; profiles: string[]; coverage: "partial" | "complete"; coverageReason?: LedgerCoverageReason };
export type BriefingUsage = { providerId: string; modelId: string; tokens: UsageTokens; reportedCost?: number };
export type UsageResolvers = {
  goalOfRun(runId: string): { id: string; title: string } | undefined;
  runTitle(runId: string): string | undefined;
  projectName(id: string): string | undefined;
  sessionTitle(id: string): string | undefined;
};
