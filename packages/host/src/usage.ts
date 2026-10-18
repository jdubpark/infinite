import type { UsageConfig } from "./config.js";

export interface UsageTokens { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
/** `modelSource: "unknown"` means neither OpenCode nor the launch named a model; its ids are then "unknown". */
export interface UsageRecord { provider: "opencode"; providerId: string; modelId: string; messageId: string; partId: string; modelSource: "requested" | "reported" | "unknown"; completedAt: string; tokens: UsageTokens; reportedCost: number }
export type Pricing = "configured" | "provider" | "unknown";
export interface UsageTotals { cost: number; tokens: UsageTokens; messages: number; pricing: Record<Pricing, number> }

const MICRO_DOLLARS_PER_DOLLAR = 1_000_000;

/**
 * Prices one record. A configured price table wins over the reported cost. Prices are USD per
 * million tokens, so tokens times price gives micro-dollars directly. Reasoning tokens bill at
 * the output rate. A record whose model was never observed cannot be priced or attributed, so it
 * is unknown whatever its reported cost; its tokens still count.
 */
export function priceUsage(record: UsageRecord, prices: UsageConfig["prices"] | undefined): { cost: number; pricing: Pricing } {
  if (record.modelSource === "unknown") return { cost: 0, pricing: "unknown" };
  const price = prices?.[`${record.providerId}/${record.modelId}`];
  if (price) {
    const { tokens } = record;
    const microDollars = tokens.input * price.input
      + (tokens.output + tokens.reasoning) * price.output
      + tokens.cacheRead * (price.cacheRead ?? price.input)
      + tokens.cacheWrite * (price.cacheWrite ?? price.input);
    return { cost: Math.round(microDollars) / MICRO_DOLLARS_PER_DOLLAR, pricing: "configured" };
  }
  if (record.reportedCost > 0) return { cost: record.reportedCost, pricing: "provider" };
  return { cost: 0, pricing: "unknown" };
}

/** Start of the budget period containing `now`, in UTC. Weeks start on Monday. */
export function periodStart(period: "day" | "week" | "month", now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (period === "month") return new Date(Date.UTC(year, month, 1));
  if (period === "day") return new Date(Date.UTC(year, month, day));
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(year, month, day - daysSinceMonday));
}

export function sumUsage(rows: { cost: number; pricing: Pricing; tokens: UsageTokens }[]): UsageTotals {
  const tokens: UsageTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const pricing: Record<Pricing, number> = { configured: 0, provider: 0, unknown: 0 };
  let dollars = 0;
  for (const row of rows) {
    dollars += row.cost;
    pricing[row.pricing] += 1;
    tokens.input += row.tokens.input;
    tokens.output += row.tokens.output;
    tokens.reasoning += row.tokens.reasoning;
    tokens.cacheRead += row.tokens.cacheRead;
    tokens.cacheWrite += row.tokens.cacheWrite;
  }
  return { cost: Math.round(dollars * MICRO_DOLLARS_PER_DOLLAR) / MICRO_DOLLARS_PER_DOLLAR, tokens, messages: rows.length, pricing };
}

/** USD for display: two decimals from one cent, four below it, and "0.00" only for a true zero. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "0.00";
  if (usd >= 0.01) return usd.toFixed(2);
  return usd < 0.0001 ? "<0.0001" : usd.toFixed(4);
}
