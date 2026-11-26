import type { UsageConfig } from "./config.js";
import type { EvidenceDb } from "./evidence/types.js";
import { median } from "./outcome-cells.js";
import type { ProviderLimitEvent } from "./provider-limits.js";
import type { ProviderHeadroom } from "./routing-types.js";
import type { Provider } from "./types.js";
import { priceUsage } from "./usage.js";
import { readRecords } from "./usage-store.js";

export const SHORT_WINDOW_MS = 5 * 3_600_000;
export const LONG_WINDOW_MS = 7 * 86_400_000;
export const SHORT_RESET_MAX_MS = 24 * 3_600_000;
export const LIMIT_LOOKBACK_MS = 30 * 86_400_000;
export const MIN_LIMIT_EVENTS = 2;
export const PRESSURE_KNEE = 0.5;
export const NEAR_HEADROOM = 0.2;

export type HeadroomUsagePoint = {
  completedAt: string;
  listUsd: number | null;
  tokens: number;
};

type ParsedPoint = { at: number; listUsd: number | null; tokens: number };

export function limitPressure(headroom: number | null | undefined): number {
  if (headroom === null || headroom === undefined || !Number.isFinite(headroom)) return 0;
  if (headroom >= PRESSURE_KNEE) return 0;
  const clamped = Math.max(0, headroom);
  return (PRESSURE_KNEE - clamped) / PRESSURE_KNEE;
}

export function isNearLimit(headroom: number | null | undefined): boolean {
  return headroom !== null && headroom !== undefined && Number.isFinite(headroom) && headroom < NEAR_HEADROOM;
}

function windowClass(detectedMs: number, resetsAt?: string): "short" | "long" {
  if (resetsAt === undefined) return "long";
  const resetsMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetsMs)) return "long";
  const delta = resetsMs - detectedMs;
  return delta >= 0 && delta <= SHORT_RESET_MAX_MS ? "short" : "long";
}

function classHeadroom(
  eventTimes: readonly number[],
  windowMs: number,
  points: readonly ParsedPoint[],
  nowMs: number,
): { headroom: number; unit: "usd" | "tokens" } | undefined {
  if (eventTimes.length < MIN_LIMIT_EVENTS) return undefined;
  const sliceOf = (endMs: number) => points.filter(point => point.at > endMs - windowMs && point.at <= endMs);
  const eventSlices = eventTimes.map(sliceOf);
  const currentSlice = sliceOf(nowMs);
  const allPoints = [...eventSlices.flat(), ...currentSlice];
  const useUsd = allPoints.every(point => point.listUsd !== null && Number.isFinite(point.listUsd));
  const sumOf = (slice: readonly ParsedPoint[]) => slice.reduce((sum, point) => sum + (useUsd ? point.listUsd! : point.tokens), 0);
  const ceiling = median(eventSlices.map(sumOf));
  if (ceiling === null || ceiling <= 0) return undefined;
  const used = sumOf(currentSlice);
  const headroom = Math.min(1, Math.max(0, 1 - used / ceiling));
  return { headroom, unit: useUsd ? "usd" : "tokens" };
}

export function providerHeadroom(input: {
  provider: Provider;
  limited: ReadonlySet<Provider>;
  events: readonly Pick<ProviderLimitEvent, "provider" | "limit" | "detectedAt" | "resetsAt">[];
  usage: readonly HeadroomUsagePoint[];
  now: string;
}): ProviderHeadroom {
  if (input.limited.has(input.provider)) {
    return { headroom: 0, basis: "limited", pressure: 1, near: true };
  }
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) return { headroom: null, basis: "unestimated", pressure: 0, near: false };
  const cutoff = nowMs - LIMIT_LOOKBACK_MS;
  const shortTimes: number[] = [];
  const longTimes: number[] = [];
  for (const event of input.events) {
    if (event.provider !== input.provider || event.limit !== "usage") continue;
    const at = Date.parse(event.detectedAt);
    if (!Number.isFinite(at) || at < cutoff || at > nowMs) continue;
    if (windowClass(at, event.resetsAt) === "short") shortTimes.push(at);
    else longTimes.push(at);
  }
  if (shortTimes.length < MIN_LIMIT_EVENTS && longTimes.length < MIN_LIMIT_EVENTS) {
    return { headroom: null, basis: "unestimated", pressure: 0, near: false };
  }
  const points: ParsedPoint[] = [];
  for (const item of input.usage) {
    const at = Date.parse(item.completedAt);
    if (Number.isFinite(at)) points.push({ at, listUsd: item.listUsd, tokens: item.tokens });
  }
  const estimates = [
    classHeadroom(shortTimes, SHORT_WINDOW_MS, points, nowMs),
    classHeadroom(longTimes, LONG_WINDOW_MS, points, nowMs),
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (estimates.length === 0) return { headroom: null, basis: "unestimated", pressure: 0, near: false };
  const lowest = estimates.reduce((best, item) => (item.headroom < best.headroom ? item : best));
  return {
    headroom: lowest.headroom,
    basis: "estimated",
    pressure: limitPressure(lowest.headroom),
    near: isNearLimit(lowest.headroom),
    unit: lowest.unit,
  };
}

function hasUsageRecords(db: EvidenceDb): boolean {
  return db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='usage_records'") !== undefined;
}

export function readProviderHeadrooms(
  db: EvidenceDb,
  providers: readonly Provider[],
  limited: ReadonlySet<Provider>,
  events: readonly ProviderLimitEvent[],
  prices: UsageConfig["prices"] | undefined,
  now: string,
): Map<Provider, ProviderHeadroom> {
  const unique = [...new Set(providers)];
  const result = new Map<Provider, ProviderHeadroom>();
  const nowMs = Date.parse(now);
  const cutoff = Number.isFinite(nowMs) ? nowMs - LIMIT_LOOKBACK_MS : Infinity;
  const needUsage: Provider[] = [];
  let earliest = Number.POSITIVE_INFINITY;

  for (const provider of unique) {
    if (limited.has(provider)) {
      result.set(provider, { headroom: 0, basis: "limited", pressure: 1, near: true });
      continue;
    }
    const shortTimes: number[] = [];
    const longTimes: number[] = [];
    for (const event of events) {
      if (event.provider !== provider || event.limit !== "usage") continue;
      const at = Date.parse(event.detectedAt);
      if (!Number.isFinite(at) || at < cutoff || at > nowMs) continue;
      if (windowClass(at, event.resetsAt) === "short") shortTimes.push(at);
      else longTimes.push(at);
    }
    if (shortTimes.length < MIN_LIMIT_EVENTS && longTimes.length < MIN_LIMIT_EVENTS) {
      result.set(provider, { headroom: null, basis: "unestimated", pressure: 0, near: false });
      continue;
    }
    needUsage.push(provider);
    if (shortTimes.length >= MIN_LIMIT_EVENTS) earliest = Math.min(earliest, ...shortTimes.map(at => at - SHORT_WINDOW_MS), nowMs - SHORT_WINDOW_MS);
    if (longTimes.length >= MIN_LIMIT_EVENTS) earliest = Math.min(earliest, ...longTimes.map(at => at - LONG_WINDOW_MS), nowMs - LONG_WINDOW_MS);
  }

  if (needUsage.length === 0 || !Number.isFinite(earliest) || !hasUsageRecords(db)) {
    for (const provider of needUsage) result.set(provider, { headroom: null, basis: "unestimated", pressure: 0, near: false });
    return result;
  }

  const byProvider = new Map<Provider, HeadroomUsagePoint[]>();
  const records = readRecords(db, { from: new Date(earliest).toISOString(), to: new Date(nowMs + 1).toISOString() });
  for (const { record } of records) {
    const priced = priceUsage(record, prices);
    const { input, output, reasoning, cacheRead, cacheWrite } = record.tokens;
    const list = byProvider.get(record.provider) ?? [];
    list.push({
      completedAt: record.completedAt,
      listUsd: priced.pricing === "unknown" ? null : priced.cost,
      tokens: input + output + reasoning + cacheRead + cacheWrite,
    });
    byProvider.set(record.provider, list);
  }
  for (const provider of needUsage) {
    result.set(provider, providerHeadroom({ provider, limited, events, usage: byProvider.get(provider) ?? [], now }));
  }
  return result;
}
