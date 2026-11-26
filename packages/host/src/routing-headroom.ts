import type { UsageConfig } from "./config.js";
import type { EvidenceDb } from "./evidence/types.js";
import { median } from "./outcome-cells.js";
import type { ProviderLimitEvent } from "./provider-limits.js";
import type { ProviderHeadroom } from "./routing-types.js";
import type { Provider } from "./types.js";
import { listPriceUsage } from "./usage.js";
import { providerUsageRevision, readRecords } from "./usage-store.js";

export const SHORT_WINDOW_MS = 5 * 3_600_000;
export const LONG_WINDOW_MS = 7 * 86_400_000;
export const SHORT_RESET_MAX_MS = 24 * 3_600_000;
export const LIMIT_LOOKBACK_MS = 30 * 86_400_000;
export const MIN_LIMIT_EVENTS = 2;
export const PRESSURE_KNEE = 0.5;
export const NEAR_HEADROOM = 0.2;
const MICRO_DOLLARS = 1_000_000;

export type HeadroomUsagePoint = {
  completedAt: string;
  listUsd: number | null;
  tokens: number;
};

type ParsedPoint = { at: number; microUsd: number | null; tokens: number };
type PrefixIndex = { times: number[]; microUsd: number[]; tokens: number[]; unpriced: number[] };

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

function buildIndex(points: readonly ParsedPoint[]): PrefixIndex {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const count = sorted.length;
  const times = new Array<number>(count);
  const microUsd = new Array<number>(count + 1);
  const tokens = new Array<number>(count + 1);
  const unpriced = new Array<number>(count + 1);
  microUsd[0] = 0;
  tokens[0] = 0;
  unpriced[0] = 0;
  for (let i = 0; i < count; i++) {
    const point = sorted[i]!;
    times[i] = point.at;
    microUsd[i + 1] = microUsd[i]! + (point.microUsd ?? 0);
    tokens[i + 1] = tokens[i]! + point.tokens;
    unpriced[i + 1] = unpriced[i]! + (point.microUsd === null ? 1 : 0);
  }
  return { times, microUsd, tokens, unpriced };
}

function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function classHeadroom(
  eventTimes: readonly number[],
  windowMs: number,
  index: PrefixIndex,
  nowMs: number,
): { headroom: number; near: boolean; unit: "usd" | "tokens" } | undefined {
  if (eventTimes.length < MIN_LIMIT_EVENTS) return undefined;
  const rangeOf = (endMs: number): [number, number] => [
    upperBound(index.times, endMs - windowMs),
    upperBound(index.times, endMs),
  ];
  const eventRanges = eventTimes.map(rangeOf);
  const currentRange = rangeOf(nowMs);
  const useUsd = index.unpriced[currentRange[1]] === index.unpriced[currentRange[0]]
    && eventRanges.every(([lo, hi]) => index.unpriced[hi] === index.unpriced[lo]);
  const totals = useUsd ? index.microUsd : index.tokens;
  const ceiling = median(eventRanges.map(([lo, hi]) => totals[hi]! - totals[lo]!));
  if (ceiling === null || ceiling <= 0) return undefined;
  const used = totals[currentRange[1]]! - totals[currentRange[0]]!;
  const remaining = Math.max(0, ceiling - used);
  const headroom = Math.min(1, remaining / ceiling);
  const near = Math.round(remaining * 2) * 5 < Math.round(ceiling * 2);
  return { headroom, near, unit: useUsd ? "usd" : "tokens" };
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
    if (!Number.isFinite(at)) continue;
    const microUsd = item.listUsd !== null && Number.isFinite(item.listUsd) && item.listUsd >= 0
      ? Math.round(item.listUsd * MICRO_DOLLARS)
      : null;
    points.push({ at, microUsd, tokens: item.tokens });
  }
  const index = buildIndex(points);
  const estimates = [
    classHeadroom(shortTimes, SHORT_WINDOW_MS, index, nowMs),
    classHeadroom(longTimes, LONG_WINDOW_MS, index, nowMs),
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (estimates.length === 0) return { headroom: null, basis: "unestimated", pressure: 0, near: false };
  const lowest = estimates.reduce((best, item) => (
    item.headroom < best.headroom || (item.headroom === best.headroom && item.near && !best.near) ? item : best
  ));
  return {
    headroom: lowest.headroom,
    basis: "estimated",
    pressure: limitPressure(lowest.headroom),
    near: lowest.near,
    unit: lowest.unit,
  };
}

const UNESTIMATED: ProviderHeadroom = { headroom: null, basis: "unestimated", pressure: 0, near: false };
const LIMITED: ProviderHeadroom = { headroom: 0, basis: "limited", pressure: 1, near: true };

function hasUsageRecords(db: EvidenceDb): boolean {
  return db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='usage_records'") !== undefined;
}

function providerEventsKey(provider: Provider, events: readonly ProviderLimitEvent[]): string {
  return events
    .filter(event => event.provider === provider && event.limit === "usage")
    .map(event => `${event.detectedAt}|${event.resetsAt ?? ""}`)
    .sort()
    .join("\n");
}

function pricesKeyOf(prices: UsageConfig["prices"] | undefined): string {
  return prices === undefined ? "" : JSON.stringify(prices);
}

type ProviderWindowPlan = {
  qualifies: boolean;
  shortQualifies: boolean;
  longQualifies: boolean;
  earliest: number;
  validUntilMs: number;
};

function windowPlanFor(provider: Provider, events: readonly ProviderLimitEvent[], nowMs: number): ProviderWindowPlan {
  if (!Number.isFinite(nowMs)) {
    return { qualifies: false, shortQualifies: false, longQualifies: false, earliest: Number.POSITIVE_INFINITY, validUntilMs: Number.POSITIVE_INFINITY };
  }
  const cutoff = nowMs - LIMIT_LOOKBACK_MS;
  const shortTimes: number[] = [];
  const longTimes: number[] = [];
  let validUntilMs = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.provider !== provider || event.limit !== "usage") continue;
    const at = Date.parse(event.detectedAt);
    if (!Number.isFinite(at)) continue;
    if (at > nowMs) {
      validUntilMs = Math.min(validUntilMs, at);
      continue;
    }
    if (at < cutoff) continue;
    validUntilMs = Math.min(validUntilMs, at + LIMIT_LOOKBACK_MS + 1);
    if (windowClass(at, event.resetsAt) === "short") shortTimes.push(at);
    else longTimes.push(at);
  }
  const shortQualifies = shortTimes.length >= MIN_LIMIT_EVENTS;
  const longQualifies = longTimes.length >= MIN_LIMIT_EVENTS;
  let earliest = Number.POSITIVE_INFINITY;
  if (shortQualifies) earliest = Math.min(earliest, ...shortTimes.map(at => at - SHORT_WINDOW_MS), nowMs - SHORT_WINDOW_MS);
  if (longQualifies) earliest = Math.min(earliest, ...longTimes.map(at => at - LONG_WINDOW_MS), nowMs - LONG_WINDOW_MS);
  return { qualifies: shortQualifies || longQualifies, shortQualifies, longQualifies, earliest, validUntilMs };
}

function computeProviderHeadroom(
  db: EvidenceDb,
  provider: Provider,
  events: readonly ProviderLimitEvent[],
  prices: UsageConfig["prices"] | undefined,
  now: string,
  nowMs: number,
  plan: ProviderWindowPlan,
): { headroom: ProviderHeadroom; validUntilMs: number } {
  if (!plan.qualifies || !Number.isFinite(plan.earliest)) {
    return { headroom: UNESTIMATED, validUntilMs: plan.validUntilMs };
  }
  let records: ReturnType<typeof readRecords>;
  try {
    records = readRecords(db, {
      providers: [provider],
      from: new Date(plan.earliest).toISOString(),
    });
  } catch {
    return { headroom: UNESTIMATED, validUntilMs: plan.validUntilMs };
  }
  let validUntilMs = plan.validUntilMs;
  const points: HeadroomUsagePoint[] = [];
  for (const { record } of records) {
    const at = Date.parse(record.completedAt);
    if (!Number.isFinite(at)) continue;
    if (at > nowMs) {
      validUntilMs = Math.min(validUntilMs, at);
      continue;
    }
    if (plan.shortQualifies && at > nowMs - SHORT_WINDOW_MS) {
      validUntilMs = Math.min(validUntilMs, at + SHORT_WINDOW_MS);
    }
    if (plan.longQualifies && at > nowMs - LONG_WINDOW_MS) {
      validUntilMs = Math.min(validUntilMs, at + LONG_WINDOW_MS);
    }
    const priced = listPriceUsage(record, prices);
    const { input, output, reasoning, cacheRead, cacheWrite } = record.tokens;
    points.push({
      completedAt: record.completedAt,
      listUsd: priced.pricing === "unknown" ? null : priced.cost,
      tokens: input + output + reasoning + cacheRead + cacheWrite,
    });
  }
  return {
    headroom: providerHeadroom({ provider, limited: new Set(), events, usage: points, now }),
    validUntilMs,
  };
}

export function overlayLimitedHeadrooms(
  providers: readonly Provider[],
  cached: ReadonlyMap<Provider, ProviderHeadroom>,
  limited: ReadonlySet<Provider>,
): Map<Provider, ProviderHeadroom> {
  const result = new Map<Provider, ProviderHeadroom>();
  for (const provider of new Set(providers)) {
    result.set(provider, limited.has(provider) ? LIMITED : (cached.get(provider) ?? UNESTIMATED));
  }
  return result;
}

type CachedEntry = {
  eventsKey: string;
  pricesKey: string;
  usageRev: string;
  computedAtMs: number;
  validUntilMs: number;
  headroom: ProviderHeadroom;
};

export class ProviderHeadroomCache {
  private readonly entries = new Map<Provider, CachedEntry>();

  clear(): void {
    this.entries.clear();
  }

  refresh(
    db: EvidenceDb,
    providers: readonly Provider[],
    events: readonly ProviderLimitEvent[],
    prices: UsageConfig["prices"] | undefined,
    now: string,
  ): void {
    const unique = [...new Set(providers)];
    const nowMs = Date.parse(now);
    const pricesKey = pricesKeyOf(prices);
    let tableReady: boolean | undefined;
    for (const provider of unique) {
      const plan = windowPlanFor(provider, events, nowMs);
      if (!plan.qualifies) {
        this.entries.delete(provider);
        continue;
      }
      if (tableReady === undefined) tableReady = hasUsageRecords(db);
      if (!tableReady) {
        this.entries.delete(provider);
        continue;
      }
      const eventsKey = providerEventsKey(provider, events);
      const usageRev = providerUsageRevision(db, provider);
      const existing = this.entries.get(provider);
      if (
        existing !== undefined
        && existing.eventsKey === eventsKey
        && existing.pricesKey === pricesKey
        && existing.usageRev === usageRev
        && nowMs >= existing.computedAtMs
        && nowMs < existing.validUntilMs
      ) {
        continue;
      }
      const computed = computeProviderHeadroom(db, provider, events, prices, now, nowMs, plan);
      this.entries.set(provider, {
        eventsKey,
        pricesKey,
        usageRev,
        computedAtMs: nowMs,
        validUntilMs: computed.validUntilMs,
        headroom: computed.headroom,
      });
    }
  }

  read(
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
    const pricesKey = pricesKeyOf(prices);
    let tableReady: boolean | undefined;
    for (const provider of unique) {
      if (limited.has(provider)) {
        result.set(provider, LIMITED);
        continue;
      }
      const plan = windowPlanFor(provider, events, nowMs);
      if (!plan.qualifies) {
        result.set(provider, UNESTIMATED);
        continue;
      }
      if (tableReady === undefined) tableReady = hasUsageRecords(db);
      if (!tableReady) {
        result.set(provider, UNESTIMATED);
        continue;
      }
      const eventsKey = providerEventsKey(provider, events);
      const usageRev = providerUsageRevision(db, provider);
      const existing = this.entries.get(provider);
      if (
        existing !== undefined
        && existing.eventsKey === eventsKey
        && existing.pricesKey === pricesKey
        && existing.usageRev === usageRev
        && nowMs >= existing.computedAtMs
        && nowMs < existing.validUntilMs
      ) {
        result.set(provider, existing.headroom);
        continue;
      }
      const computed = computeProviderHeadroom(db, provider, events, prices, now, nowMs, plan);
      this.entries.set(provider, {
        eventsKey,
        pricesKey,
        usageRev,
        computedAtMs: nowMs,
        validUntilMs: computed.validUntilMs,
        headroom: computed.headroom,
      });
      result.set(provider, computed.headroom);
    }
    return result;
  }
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
  let tableReady: boolean | undefined;
  for (const provider of unique) {
    if (limited.has(provider)) {
      result.set(provider, LIMITED);
      continue;
    }
    const plan = windowPlanFor(provider, events, nowMs);
    if (!plan.qualifies) {
      result.set(provider, UNESTIMATED);
      continue;
    }
    if (tableReady === undefined) tableReady = hasUsageRecords(db);
    if (!tableReady) {
      result.set(provider, UNESTIMATED);
      continue;
    }
    result.set(provider, computeProviderHeadroom(db, provider, events, prices, now, nowMs, plan).headroom);
  }
  return result;
}
