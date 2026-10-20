import type { UsageConfig } from "./config.js";
import { PRICE_CATALOG, type CatalogPrice } from "./price-catalog.js";

export interface UsageTokens { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
/** `modelSource: "unknown"` means neither OpenCode nor the launch named a model; its ids are then "unknown". */
export interface UsageRecord { provider: "opencode"; providerId: string; modelId: string; messageId: string; partId: string; modelSource: "requested" | "reported" | "unknown"; completedAt: string; tokens: UsageTokens; reportedCost: number }
export type Pricing = "configured" | "catalog" | "provider" | "unknown";
export interface UsageTotals { cost: number; tokens: UsageTokens; messages: number; pricing: Record<Pricing, number> }

const MICRO_DOLLARS_PER_DOLLAR = 1_000_000;

/**
 * Prices one record: configured price, dated catalog, provider-reported cost, then unknown. Prices
 * are USD per million tokens, so tokens times price gives micro-dollars directly. Reasoning tokens
 * bill at the output rate. A never-observed model stays unknown whatever its reported cost.
 */
export function priceUsage(record: UsageRecord, prices: UsageConfig["prices"] | undefined, catalog: Record<string, CatalogPrice> = PRICE_CATALOG): { cost: number; pricing: Pricing } {
  if (record.modelSource === "unknown") return { cost: 0, pricing: "unknown" };
  const key = `${record.providerId}/${record.modelId}`;
  const configured = prices?.[key], catalogPrice = catalog[key], price = configured ?? catalogPrice;
  if (price) {
    const { tokens } = record;
    const date = new Date(record.completedAt);
    const peak = !configured && catalogPrice?.peak && catalogPrice.peak.days.includes(date.getUTCDay()) && catalogPrice.peak.hoursUtc.some(([start, end]) => date.getUTCHours() >= start && date.getUTCHours() < end);
    const multiplier = peak && catalogPrice?.peak ? catalogPrice.peak.multiplier : 1;
    const microDollars = (tokens.input * price.input
      + (tokens.output + tokens.reasoning) * price.output
      + tokens.cacheRead * (price.cacheRead ?? price.input)
      + tokens.cacheWrite * (price.cacheWrite ?? price.input)) * multiplier;
    return { cost: Math.round(microDollars) / MICRO_DOLLARS_PER_DOLLAR, pricing: configured ? "configured" : "catalog" };
  }
  if (record.reportedCost > 0) return { cost: record.reportedCost, pricing: "provider" };
  return { cost: 0, pricing: "unknown" };
}

export function accountOf(providerId: string, modelId: string, accounts: UsageConfig["accounts"]): string {
  const value = `${providerId}/${modelId}`;
  for (const [id, account] of Object.entries(accounts)) if (account.match.some(pattern => glob(pattern, value))) return id;
  return providerId;
}
function glob(pattern: string, value: string) {
  const escaped = pattern.split("*").map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(value);
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
  const pricing: Record<Pricing, number> = { configured: 0, catalog: 0, provider: 0, unknown: 0 };
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
