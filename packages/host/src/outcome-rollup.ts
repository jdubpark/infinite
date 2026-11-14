import type { MemberResultRow, OutcomeRow, RollupRecords, RunSummaryPayload, RunSummaryRow } from "./outcome-store.js";
import { SOURCES, buildCells, isMetered, type Cell, type CostLookup } from "./outcome-cells.js";
import type { Disposition } from "./outcome-rules.js";
import type { RunSummaryCounts } from "./run-events.js";

/** Pure roll-up rules. No I/O, no clock, no module state. */

export type RollupTarget = { kind: "goal" | "mission"; id: string };
export type GoalAssessment = { result: "achieved" | "not-achieved" | "inconclusive"; at: string; revision: number };
export type RollupCost = { sessions: number; complete: number; noSession: number; tokens: number | null; spentUsd: number | null };
export type RollupRuns = {
  total: number; withSummary: number; withCounts: number; deleted: number;
  status: Record<string, number>; blockCodes: Record<string, number>;
  counts: RunSummaryCounts | null; rounds: RunSummaryPayload["rounds"] | null; flagged: { backfilled: number; gap: number };
};
export type OutcomeRollup = {
  target: RollupTarget; known: boolean; assessment: GoalAssessment | null; runs: RollupRuns;
  attempts: Partial<Record<Disposition, number>>; implementer: Cell[]; scout: Cell[]; members: number; cost: RollupCost;
  unreadable: RollupRecords["unreadable"]; unindexed: number;
};

const COUNT_KEYS: readonly (keyof RunSummaryCounts)[] = [
  "tasks", "integrated", "members", "round", "checks", "recoveries", "decisionsByOwner",
  "decisionsByCoordinator", "steering", "permissionEscalations", "continuations",
];

/** The newest entry of a goal's outcomes, in time order, with its numbers only. The text stays with the goal view. */
export function latestAssessment(outcomes: readonly GoalAssessment[]): GoalAssessment | null {
  const last = outcomes.at(-1);
  if (last === undefined) return null;
  return { result: last.result, at: last.at, revision: last.revision };
}

function countOf(values: readonly string[]): Record<string, number> {
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return Object.fromEntries(tally);
}

function runFacts(records: RollupRecords): RollupRuns {
  const countPayloads = records.summaries.flatMap(summary => (summary.payload.counts ? [summary.payload] : []));
  const counts = countPayloads.length === 0 ? null : sumCounts(countPayloads.map(payload => payload.counts!));
  const rounds = countPayloads.length === 0 ? null : sumRounds(countPayloads.map(payload => payload.rounds));
  const deletedRuns = new Set<string>();
  for (const record of [...records.summaries, ...records.rows, ...records.members]) {
    if (record.runDeletedAt !== null) deletedRuns.add(record.runId);
  }
  return {
    total: records.runIds.length,
    withSummary: records.summaries.length,
    withCounts: countPayloads.length,
    deleted: deletedRuns.size,
    status: countOf(records.summaries.map((summary: RunSummaryRow) => summary.status ?? "unsettled")),
    blockCodes: countOf(records.summaries.flatMap(summary => (summary.blockCode ? [summary.blockCode] : []))),
    counts,
    rounds,
    flagged: {
      backfilled: records.summaries.filter(summary => summary.flags.includes("backfilled")).length,
      gap: records.summaries.filter(summary => summary.flags.includes("gap")).length,
    },
  };
}

function sumCounts(all: readonly RunSummaryCounts[]): RunSummaryCounts {
  const total: RunSummaryCounts = {
    tasks: 0, integrated: 0, members: 0, round: 0, checks: 0, recoveries: 0, decisionsByOwner: 0,
    decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0,
  };
  for (const counts of all) for (const key of COUNT_KEYS) total[key] += counts[key];
  return total;
}

function sumRounds(all: readonly RunSummaryPayload["rounds"][]): RunSummaryPayload["rounds"] {
  const total = { total: 0, attributed: 0, unattributed: 0, unknown: 0 };
  for (const rounds of all) {
    total.total += rounds.total;
    total.attributed += rounds.attributed;
    total.unattributed += rounds.unattributed;
    total.unknown += rounds.unknown;
  }
  return total;
}

function attemptsOf(rows: readonly OutcomeRow[]): Partial<Record<Disposition, number>> {
  const attempts: Partial<Record<Disposition, number>> = {};
  for (const row of rows) attempts[row.disposition] = (attempts[row.disposition] ?? 0) + 1;
  return attempts;
}

/**
 * Cost per distinct session. A session counts only when the lookup gives a complete cost, and it adds spend only when
 * one of its rows or member results has a metered provider. Sums are null when they summed nothing.
 */
function costOf(rows: readonly OutcomeRow[], members: readonly MemberResultRow[], lookup?: CostLookup): RollupCost {
  const metered = new Map<string, boolean>();
  let noSession = 0;
  const visit = (sessionId: string | null, provider: string): void => {
    if (!sessionId) {
      noSession++;
      return;
    }
    metered.set(sessionId, (metered.get(sessionId) ?? false) || isMetered(provider));
  };
  for (const record of rows) visit(record.sessionId, record.provider);
  for (const record of members) visit(record.sessionId, record.provider);

  let complete = 0, tokens = 0, spentUsd = 0, anyTokens = false, anySpend = false;
  if (lookup) {
    for (const [sessionId, isMeteredSession] of metered) {
      const found = lookup(sessionId);
      if (!found?.complete) continue;
      complete++;
      tokens += found.tokens;
      anyTokens = true;
      if (isMeteredSession) {
        spentUsd += found.usd;
        anySpend = true;
      }
    }
  }
  return {
    sessions: metered.size,
    complete,
    noSession,
    tokens: anyTokens ? tokens : null,
    spentUsd: anySpend ? spentUsd : null,
  };
}

/** Builds a roll-up from the records of one target's runs. Levels come from `buildCells`, one counting rule. */
export function buildRollup(
  records: RollupRecords,
  context: { target: RollupTarget; known: boolean; assessment: GoalAssessment | null; cost?: CostLookup },
): OutcomeRollup {
  const cells = (role: "implementer" | "scout"): Cell[] =>
    buildCells(records.rows, { use: "display", sources: [...SOURCES], by: [], role });
  return {
    target: context.target,
    known: context.known,
    assessment: context.assessment,
    runs: runFacts(records),
    attempts: attemptsOf(records.rows),
    implementer: cells("implementer"),
    scout: cells("scout"),
    members: records.members.length,
    cost: costOf(records.rows, records.members, context.cost),
    unreadable: records.unreadable,
    unindexed: records.unindexed,
  };
}

/** True when the host holds no record of the target and the ledger no run of it. The route answers 404. */
export function rollupMissing(rollup: OutcomeRollup): boolean {
  return !rollup.known && rollup.runs.total === 0;
}
