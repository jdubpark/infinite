import {
  EVAL_PROVIDERS,
  providerBudgetConstraints,
  type EvalBudgetPeriod,
  type EvalProvider,
  type EvalProviderBudgets,
  type HostUsageBudgets,
  type TrialBudgetConstraint,
} from "./eval-config.js";
import type { EvalProviderBudgetStatus } from "./eval-types.js";
import type { FuseCheck, FuseGate } from "./fuse/types.js";
import type { Provider } from "./types.js";
import { periodEnd, periodStart, type ProviderSpendSnapshot, type ProviderSpendUnmeasurableReason } from "./usage.js";

const MICRO_USD = 1_000_000;

export type EvalUsageReader = {
  providerSpend(provider: Provider, period: EvalBudgetPeriod, now?: Date, projectId?: string): ProviderSpendSnapshot;
};

export type EvalBudgetSource = {
  providerSpend?: (provider: Provider, period: EvalBudgetPeriod, now: Date, projectId?: string) => ProviderSpendSnapshot;
  fuseCheck?: (projectId: string) => FuseCheck;
};

export type ProviderBudgetVerdict =
  | { state: "unconfigured"; provider: EvalProvider }
  | { state: "admitted"; provider: EvalProvider; checks: EvalProviderBudgetStatus[] }
  | { state: "exceeded"; provider: EvalProvider; source: "project" | "host"; period: EvalBudgetPeriod; spentUsd: number; limitUsd: number }
  | {
      state: "unmeasurable";
      provider: EvalProvider;
      source: "project" | "host";
      period: EvalBudgetPeriod;
      reason: ProviderSpendUnmeasurableReason;
      limitUsd: number;
      spentUsd: number | null;
    };

export type FuseVerdict =
  | { state: "clear" }
  | { state: "halted" }
  | { state: "open"; cause: "launch-rate" | "unmeasurable" | "unavailable" };

function roundMicroUsd(usd: number): number {
  return Math.round(usd * MICRO_USD) / MICRO_USD;
}

export function usdExceeded(spentUsd: number, limitUsd: number): boolean {
  if (spentUsd >= limitUsd) return true;
  return limitUsd >= 1 / MICRO_USD && roundMicroUsd(spentUsd) >= roundMicroUsd(limitUsd);
}

export function evalBudgetSource(options: {
  usage?: () => EvalUsageReader;
  fuse?: () => Pick<FuseGate, "check">;
}): EvalBudgetSource | undefined {
  if (options.usage === undefined && options.fuse === undefined) return undefined;
  return {
    ...(options.usage === undefined ? {} : {
      providerSpend: (provider: Provider, period: EvalBudgetPeriod, now: Date, projectId?: string): ProviderSpendSnapshot => {
        try {
          return options.usage!().providerSpend(provider, period, now, projectId);
        } catch {
          const start = periodStart(period, now);
          const end = periodEnd(period, start);
          return {
            measured: false,
            provider,
            ...(projectId === undefined ? {} : { projectId }),
            period: { kind: period, start: start.toISOString(), end: end.toISOString() },
            reason: "ledger-unavailable",
          };
        }
      },
    }),
    ...(options.fuse === undefined ? {} : {
      fuseCheck: (projectId: string): FuseCheck => options.fuse!().check({ projectId }),
    }),
  };
}

export function evaluateFuse(
  fuseCheck: ((projectId: string) => FuseCheck) | undefined,
  projectId: string,
): FuseVerdict {
  if (fuseCheck === undefined) return { state: "clear" };
  let check: FuseCheck;
  try {
    check = fuseCheck(projectId);
  } catch {
    return { state: "open", cause: "unavailable" };
  }
  if (check.state === "halted") return { state: "halted" };
  if (check.state === "open") return { state: "open", cause: check.cause };
  return { state: "clear" };
}

export function evaluateConstraint(
  provider: EvalProvider,
  projectId: string,
  constraint: TrialBudgetConstraint,
  spend: EvalBudgetSource["providerSpend"],
  now: Date,
): EvalProviderBudgetStatus {
  const base = { provider, source: constraint.source, period: constraint.period, limitUsd: constraint.usd };
  if (!Number.isFinite(constraint.usd) || constraint.usd < 0) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "invalid-measurement" };
  }
  const scopeProjectId = constraint.source === "project" ? projectId : undefined;
  if (constraint.source === "project" && !scopeProjectId) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "invalid-measurement" };
  }
  if (spend === undefined) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "ledger-unavailable" };
  }
  let snapshot: ProviderSpendSnapshot;
  try {
    snapshot = spend(provider, constraint.period, now, scopeProjectId);
  } catch {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "ledger-unavailable" };
  }
  if (snapshot.provider !== provider) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "invalid-measurement" };
  }
  if (constraint.source === "project" && snapshot.projectId !== undefined && snapshot.projectId !== projectId) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "invalid-measurement" };
  }
  if (constraint.source === "host" && snapshot.projectId !== undefined) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "invalid-measurement" };
  }
  const validUsd = typeof snapshot.usd === "number" && Number.isFinite(snapshot.usd) && snapshot.usd >= 0;
  if (validUsd && usdExceeded(snapshot.usd!, constraint.usd)) {
    return { ...base, spentUsd: snapshot.usd!, state: "exceeded" };
  }
  if (!snapshot.measured) {
    return { ...base, spentUsd: validUsd ? snapshot.usd! : null, state: "unmeasurable", reason: snapshot.reason };
  }
  if (!validUsd) {
    return { ...base, spentUsd: null, state: "unmeasurable", reason: "invalid-measurement" };
  }
  if (snapshot.unmeasuredSessions > 0) {
    return { ...base, spentUsd: snapshot.usd, state: "unmeasurable", reason: "unmeasured-sessions" };
  }
  if (snapshot.partialSessions > 0) {
    return { ...base, spentUsd: snapshot.usd, state: "unmeasurable", reason: "partial-sessions" };
  }
  if (snapshot.unpriced > 0) {
    return { ...base, spentUsd: snapshot.usd, state: "unmeasurable", reason: "unpriced-records" };
  }
  return { ...base, spentUsd: snapshot.usd, state: "admitted" };
}

export function evaluateProviderBudget(
  provider: EvalProvider,
  projectId: string,
  constraints: readonly TrialBudgetConstraint[],
  spend: EvalBudgetSource["providerSpend"],
  now: Date,
): ProviderBudgetVerdict {
  if (constraints.length === 0) return { state: "unconfigured", provider };
  const checks = constraints.map(constraint => evaluateConstraint(provider, projectId, constraint, spend, now));
  const exceeded = checks.find(item => item.state === "exceeded");
  if (exceeded !== undefined) {
    return {
      state: "exceeded",
      provider,
      source: exceeded.source,
      period: exceeded.period,
      spentUsd: exceeded.spentUsd!,
      limitUsd: exceeded.limitUsd,
    };
  }
  const unmeasurable = checks.find(item => item.state === "unmeasurable");
  if (unmeasurable !== undefined) {
    return {
      state: "unmeasurable",
      provider,
      source: unmeasurable.source,
      period: unmeasurable.period,
      reason: unmeasurable.reason!,
      limitUsd: unmeasurable.limitUsd,
      spentUsd: unmeasurable.spentUsd,
    };
  }
  return { state: "admitted", provider, checks };
}

export function summarizeProjectBudgets(
  projectId: string,
  projectBudgets: EvalProviderBudgets | undefined,
  hostBudgets: HostUsageBudgets | undefined,
  budget: EvalBudgetSource | undefined,
  now: Date,
): EvalProviderBudgetStatus[] {
  const statuses: EvalProviderBudgetStatus[] = [];
  for (const provider of EVAL_PROVIDERS) {
    const constraints = providerBudgetConstraints(provider, projectBudgets, hostBudgets);
    for (const constraint of constraints) {
      statuses.push(evaluateConstraint(provider, projectId, constraint, budget?.providerSpend, now));
    }
  }
  return statuses;
}
