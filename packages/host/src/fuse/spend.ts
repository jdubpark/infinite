import type { FuseConfig } from "../config.js";
import type {
  FuseOpen,
  FusePeriodCeilings,
  FusePeriodReading,
  FuseScope,
  FuseSpendLimits,
  FuseSpendReader,
  FuseSpendSample,
  FuseTripRecord,
} from "./types.js";

export const DEFAULT_UNMEASURED_TOKEN_ESTIMATE = 50_000;
export const DEFAULT_UNMEASURED_USD_ESTIMATE = 0.50;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const SPEND_CAUSES = new Set(["tokens", "list-usd", "spent-usd"]);

const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function hasPeriodCeiling(ceilings: FusePeriodCeilings | undefined): boolean {
  return ceilings !== undefined && (ceilings.tokens !== undefined || ceilings.listUsd !== undefined || ceilings.spentUsd !== undefined);
}

export function hasSpendCeilings(limits: FuseSpendLimits): boolean {
  return hasPeriodCeiling(limits.day) || hasPeriodCeiling(limits.week);
}

export function spendLimitsOf(fuse: FuseConfig | undefined): {
  host: FuseSpendLimits;
  project(projectId: string): FuseSpendLimits;
} {
  const hostCfg = fuse?.host;
  const baseProjectCfg = fuse?.project;
  const host: FuseSpendLimits = {
    ...(hasPeriodCeiling(hostCfg?.day) ? { day: hostCfg!.day } : {}),
    ...(hasPeriodCeiling(hostCfg?.week) ? { week: hostCfg!.week } : {}),
    unmeasuredTokenEstimate: hostCfg?.unmeasuredTokenEstimate ?? DEFAULT_UNMEASURED_TOKEN_ESTIMATE,
    unmeasuredUsdEstimate: hostCfg?.unmeasuredUsdEstimate ?? DEFAULT_UNMEASURED_USD_ESTIMATE,
  };
  return {
    host,
    project(projectId: string): FuseSpendLimits {
      const override = fuse?.projects && Object.hasOwn(fuse.projects, projectId) ? fuse.projects[projectId] : undefined;
      const day = override?.day ?? baseProjectCfg?.day;
      const week = override?.week ?? baseProjectCfg?.week;
      return {
        ...(hasPeriodCeiling(day) ? { day } : {}),
        ...(hasPeriodCeiling(week) ? { week } : {}),
        unmeasuredTokenEstimate:
          override?.unmeasuredTokenEstimate ?? baseProjectCfg?.unmeasuredTokenEstimate ?? host.unmeasuredTokenEstimate,
        unmeasuredUsdEstimate:
          override?.unmeasuredUsdEstimate ?? baseProjectCfg?.unmeasuredUsdEstimate ?? host.unmeasuredUsdEstimate,
      };
    },
  };
}

export function spendWindowStart(
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  window: "day" | "week",
  now: number,
): number {
  const baseStart = window === "day" ? utcDayStart(now) : now - WEEK_MS;
  let ownerClosedCutoff = Number.NEGATIVE_INFINITY;
  for (const trip of trips) {
    if (
      trip.closedBy === "owner" &&
      trip.closedAt !== undefined &&
      trip.closedAt <= now &&
      trip.scope === scope &&
      (scope === "host" || trip.projectId === projectId) &&
      trip.window === window &&
      SPEND_CAUSES.has(trip.cause)
    ) {
      ownerClosedCutoff = Math.max(ownerClosedCutoff, trip.closedAt);
    }
  }
  return ownerClosedCutoff >= baseStart ? ownerClosedCutoff + 1 : baseStart;
}

function readPeriodSample(
  reader: FuseSpendReader | undefined,
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  window: "day" | "week",
  limits: FuseSpendLimits,
  now: number,
): FuseSpendSample & { estimatedTokens: number; estimatedListUsd: number; estimatedSpentUsd: number } {
  if (!reader) {
    return {
      tokens: 0,
      listUsd: 0,
      spentUsd: 0,
      unmeasuredSessions: 0,
      available: false,
      estimatedTokens: 0,
      estimatedListUsd: 0,
      estimatedSpentUsd: 0,
    };
  }
  const sinceMs = spendWindowStart(trips, scope, projectId, window, now);
  let sample: FuseSpendSample;
  try {
    sample = reader({ scope, ...(projectId === undefined ? {} : { projectId }), window, sinceMs, now });
  } catch {
    sample = { tokens: 0, listUsd: 0, spentUsd: 0, unmeasuredSessions: 0, available: false };
  }
  if (!sample.available) {
    return {
      ...sample,
      estimatedTokens: 0,
      estimatedListUsd: 0,
      estimatedSpentUsd: 0,
    };
  }
  if (sinceMs > now) {
    return {
      tokens: 0,
      listUsd: 0,
      spentUsd: 0,
      unmeasuredSessions: 0,
      available: true,
      estimatedTokens: 0,
      estimatedListUsd: 0,
      estimatedSpentUsd: 0,
    };
  }
  return {
    ...sample,
    estimatedTokens: sample.tokens + sample.unmeasuredSessions * limits.unmeasuredTokenEstimate,
    estimatedListUsd: roundUsd(sample.listUsd + (sample.unmeasuredSessions + (sample.unmeasuredListSessions ?? 0)) * limits.unmeasuredUsdEstimate),
    estimatedSpentUsd: roundUsd(sample.spentUsd + (sample.unmeasuredSessions + (sample.unmeasuredSpentSessions ?? 0)) * limits.unmeasuredUsdEstimate),
  };
}

function periodCheck(
  scope: FuseScope,
  projectId: string | undefined,
  window: "day" | "week",
  ceilings: FusePeriodCeilings,
  reading: ReturnType<typeof readPeriodSample>,
): FuseOpen | undefined {
  if (!reading.available) {
    return {
      state: "open",
      scope,
      ...(scope === "project" ? { projectId } : {}),
      window,
      cause: "unmeasurable",
      ownerClose: false,
    };
  }
  if (ceilings.tokens !== undefined && reading.estimatedTokens >= ceilings.tokens) {
    return {
      state: "open",
      scope,
      ...(scope === "project" ? { projectId } : {}),
      window,
      cause: "tokens",
      ownerClose: true,
    };
  }
  if (ceilings.listUsd !== undefined && reading.estimatedListUsd >= ceilings.listUsd) {
    return {
      state: "open",
      scope,
      ...(scope === "project" ? { projectId } : {}),
      window,
      cause: "list-usd",
      ownerClose: true,
    };
  }
  if (ceilings.spentUsd !== undefined && reading.estimatedSpentUsd >= ceilings.spentUsd) {
    return {
      state: "open",
      scope,
      ...(scope === "project" ? { projectId } : {}),
      window,
      cause: "spent-usd",
      ownerClose: true,
    };
  }
  return undefined;
}

export function checkSpendScope(
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  limits: FuseSpendLimits,
  reader: FuseSpendReader | undefined,
  now: number,
): FuseOpen | { state: "closed" } {
  for (const window of ["day", "week"] as const) {
    const ceilings = limits[window];
    if (!hasPeriodCeiling(ceilings)) continue;
    const reading = readPeriodSample(reader, trips, scope, projectId, window, limits, now);
    const open = periodCheck(scope, projectId, window, ceilings!, reading);
    if (open !== undefined) return open;
  }
  return { state: "closed" };
}

export function evaluateSpendScope(
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  limits: FuseSpendLimits,
  reader: FuseSpendReader | undefined,
  now: number,
): { state: FuseOpen | { state: "closed" }; readings: { day?: FusePeriodReading; week?: FusePeriodReading } } {
  const readings: { day?: FusePeriodReading; week?: FusePeriodReading } = {};
  let openState: FuseOpen | undefined;
  for (const window of ["day", "week"] as const) {
    const ceilings = limits[window];
    if (!hasPeriodCeiling(ceilings)) continue;
    const reading = readPeriodSample(reader, trips, scope, projectId, window, limits, now);
    if (openState === undefined) openState = periodCheck(scope, projectId, window, ceilings!, reading);
    const unmeasured = reading.available
      ? reading.unmeasuredSessions + Math.max(
          ceilings!.listUsd !== undefined ? (reading.unmeasuredListSessions ?? 0) : 0,
          ceilings!.spentUsd !== undefined ? (reading.unmeasuredSpentSessions ?? 0) : 0,
        )
      : 0;
    readings[window] = {
      tokens: reading.available ? reading.estimatedTokens : 0,
      ...(ceilings!.tokens === undefined ? {} : { tokensLimit: ceilings!.tokens }),
      listUsd: reading.available ? reading.estimatedListUsd : 0,
      ...(ceilings!.listUsd === undefined ? {} : { listUsdLimit: ceilings!.listUsd }),
      spentUsd: reading.available ? reading.estimatedSpentUsd : 0,
      ...(ceilings!.spentUsd === undefined ? {} : { spentUsdLimit: ceilings!.spentUsd }),
      unmeasuredSessions: unmeasured,
      available: reading.available,
    };
  }
  return { state: openState ?? { state: "closed" }, readings };
}

export function buildPeriodReadings(
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  limits: FuseSpendLimits,
  reader: FuseSpendReader | undefined,
  now: number,
): { day?: FusePeriodReading; week?: FusePeriodReading } {
  return evaluateSpendScope(trips, scope, projectId, limits, reader, now).readings;
}
