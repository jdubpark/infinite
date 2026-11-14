import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";
import type { UsageService } from "./usage-service.js";
import type { LedgerCoverageReason } from "./usage-store.js";

/** Usage rolled up for a run or a goal. Computed on read; never stored in a sealed record. */
export interface UsageRollup {
  total: UsageTotals;
  byProfile: Record<string, UsageTotals>;
  byProvider: Partial<Record<Provider, UsageTotals>>;
  /** Members whose provider reports no usage. Their cost is unknown, not zero. */
  unmeasuredMembers: number;
  /** Measured members with a gap that can no longer close. Their usage is still in the totals. */
  partialMembers: number;
  /** Set when the usage ledger could not be read, so every member counts as unmeasured. */
  unavailable?: true;
}

/** A member's usage with the coverage of its sessions. */
export type MemberUsage = UsageTotals & { coverage: "partial" | "complete"; coverageReason?: LedgerCoverageReason };

export const emptyUsage = (): UsageTotals => ({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 0, pricing: { configured: 0, catalog: 0, provider: 0, unknown: 0 } });

export function addUsage(...parts: UsageTotals[]): UsageTotals {
  const sum = emptyUsage();
  let micro = 0;
  for (const part of parts) {
    micro += Math.round(part.cost * 1_000_000);
    for (const key of Object.keys(sum.tokens) as (keyof UsageTotals["tokens"])[]) sum.tokens[key] += part.tokens[key];
    for (const key of Object.keys(sum.pricing) as (keyof UsageTotals["pricing"])[]) sum.pricing[key] += part.pricing[key] ?? 0;
    sum.messages += part.messages;
  }
  sum.cost = micro / 1_000_000;
  return sum;
}

export function emptyRollup(unmeasuredMembers = 0): UsageRollup {
  return { total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers, partialMembers: 0 };
}

/** A rollup as goal records store it; snapshots written before `partialMembers` existed omit it. */
export type StoredRollup = Omit<UsageRollup, "partialMembers" | "unavailable"> & Partial<Pick<UsageRollup, "partialMembers" | "unavailable">>;

export function addRollups(rollups: StoredRollup[]): UsageRollup {
  const result = emptyRollup();
  result.total = addUsage(...rollups.map(rollup => rollup.total));
  result.unmeasuredMembers = rollups.reduce((sum, rollup) => sum + rollup.unmeasuredMembers, 0);
  // Goal records written before partialMembers existed have no such key, so a missing value counts as 0.
  result.partialMembers = rollups.reduce((sum, rollup) => sum + (rollup.partialMembers ?? 0), 0);
  if (rollups.some(rollup => rollup.unavailable)) result.unavailable = true;
  for (const rollup of rollups) {
    for (const [id, totals] of Object.entries(rollup.byProfile)) result.byProfile[id] = addUsage(result.byProfile[id] ?? emptyUsage(), totals);
    for (const [provider, totals] of Object.entries(rollup.byProvider) as [Provider, UsageTotals][]) result.byProvider[provider] = addUsage(result.byProvider[provider] ?? emptyUsage(), totals);
  }
  return result;
}

interface UsageMember { sessionId: string; runId?: string; memberId?: string; provider?: Provider; modelProfile?: { id: string } }

/**
 * Attaches `usage` to each measured member and rolls the run up. A member with a run and member id is read over every
 * session it ran; any other member is read by its session. Members without measurement are only counted.
 */
export function teamUsage<M extends UsageMember>(members: M[], runProvider: Provider, usage?: UsageService): { members: (M & { usage?: MemberUsage })[]; rollup: UsageRollup } {
  const measured: MemberUsage[] = [];
  const rollup = emptyRollup();
  const out = members.map(member => {
    const found = member.runId !== undefined && member.memberId !== undefined ? usage?.member(member.runId, member.memberId) : usage?.session(member.sessionId);
    if (found && !found.measured && found.unavailable) rollup.unavailable = true;
    if (!found || !found.measured) { rollup.unmeasuredMembers += 1; return member; }
    const { measured: _measured, ...totals } = found;
    if (totals.coverage === "partial" && totals.coverageReason !== "running") rollup.partialMembers += 1;
    const provider = member.provider ?? runProvider;
    measured.push(totals);
    rollup.byProvider[provider] = addUsage(rollup.byProvider[provider] ?? emptyUsage(), totals);
    if (member.modelProfile) rollup.byProfile[member.modelProfile.id] = addUsage(rollup.byProfile[member.modelProfile.id] ?? emptyUsage(), totals);
    return { ...member, usage: totals };
  });
  rollup.total = addUsage(...measured);
  return { members: out, rollup };
}
