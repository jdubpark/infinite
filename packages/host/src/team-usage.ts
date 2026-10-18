import type { Provider } from "./types.js";
import type { UsageTotals } from "./usage.js";
import type { UsageService } from "./usage-service.js";

/** Usage rolled up for a run or a goal. Computed on read; never stored in a sealed record. */
export interface UsageRollup {
  total: UsageTotals;
  byProfile: Record<string, UsageTotals>;
  byProvider: Partial<Record<Provider, UsageTotals>>;
  /** Members whose provider reports no usage. Their cost is unknown, not zero. */
  unmeasuredMembers: number;
}

export const emptyUsage = (): UsageTotals => ({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: 0, pricing: { configured: 0, provider: 0, unknown: 0 } });

export function addUsage(...parts: UsageTotals[]): UsageTotals {
  const sum = emptyUsage();
  let micro = 0;
  for (const part of parts) {
    micro += Math.round(part.cost * 1_000_000);
    for (const key of Object.keys(sum.tokens) as (keyof UsageTotals["tokens"])[]) sum.tokens[key] += part.tokens[key];
    for (const key of Object.keys(sum.pricing) as (keyof UsageTotals["pricing"])[]) sum.pricing[key] += part.pricing[key];
    sum.messages += part.messages;
  }
  sum.cost = micro / 1_000_000;
  return sum;
}

export function emptyRollup(unmeasuredMembers = 0): UsageRollup {
  return { total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers };
}

export function addRollups(rollups: UsageRollup[]): UsageRollup {
  const result = emptyRollup();
  result.total = addUsage(...rollups.map(rollup => rollup.total));
  result.unmeasuredMembers = rollups.reduce((sum, rollup) => sum + rollup.unmeasuredMembers, 0);
  for (const rollup of rollups) {
    for (const [id, totals] of Object.entries(rollup.byProfile)) result.byProfile[id] = addUsage(result.byProfile[id] ?? emptyUsage(), totals);
    for (const [provider, totals] of Object.entries(rollup.byProvider) as [Provider, UsageTotals][]) result.byProvider[provider] = addUsage(result.byProvider[provider] ?? emptyUsage(), totals);
  }
  return result;
}

interface UsageMember { sessionId: string; provider?: Provider; modelProfile?: { id: string } }

/** Attaches `usage` to each measured member and rolls the run up. Members without measurement are only counted. */
export function teamUsage<M extends UsageMember>(members: M[], runProvider: Provider, usage?: UsageService): { members: (M & { usage?: UsageTotals })[]; rollup: UsageRollup } {
  const measured: UsageTotals[] = [];
  const rollup = emptyRollup();
  const out = members.map(member => {
    const found = usage?.session(member.sessionId);
    if (!found || !found.measured) { rollup.unmeasuredMembers += 1; return member; }
    const { measured: _measured, ...totals } = found;
    const provider = member.provider ?? runProvider;
    measured.push(totals);
    rollup.byProvider[provider] = addUsage(rollup.byProvider[provider] ?? emptyUsage(), totals);
    if (member.modelProfile) rollup.byProfile[member.modelProfile.id] = addUsage(rollup.byProfile[member.modelProfile.id] ?? emptyUsage(), totals);
    return { ...member, usage: totals };
  });
  rollup.total = addUsage(...measured);
  return { members: out, rollup };
}
