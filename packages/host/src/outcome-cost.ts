import type { UsageConfig } from "./config.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceTx } from "./evidence/types.js";
import { isMetered, type SessionCost } from "./outcome-cells.js";
import { OUTCOMES_MODULE, readOutcome, writeOutcome, type OutcomeRow } from "./outcome-store.js";
import type { UsageCoverage } from "./transcript-usage.js";
import { priceUsage, sumUsage } from "./usage.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";
import { combineCoverage, readRecords, usageModule, type LedgerCoverageReason } from "./usage-store.js";

export type ObservedOutcomeCost = {
  costCoverage: "none" | "partial" | "complete";
  listUsd?: number;
  spentUsd?: number;
};

type UsageSessionMeta = {
  session_id: string;
  created_at: string;
  coverage: UsageCoverage;
  coverage_reason: LedgerCoverageReason | null;
};

export function sessionCostOf(found: SessionUsage | UnmeasuredUsage): SessionCost | undefined {
  if (!found.measured) {
    if (found.unavailable) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    return undefined;
  }
  const tokens = found.tokens.input + found.tokens.output + found.tokens.reasoning + found.tokens.cacheRead + found.tokens.cacheWrite;
  const listUsd = found.coverage === "complete" && found.list !== undefined && found.list.unpriced === 0 && found.messages > 0
    ? found.list.usd
    : undefined;
  return {
    usd: found.cost,
    tokens,
    complete: found.coverage === "complete" && found.pricing.unknown === 0,
    ...(listUsd === undefined ? {} : { listUsd }),
  };
}

function usageSessionsFor(db: EvidenceDb, row: Pick<OutcomeRow, "runId" | "memberId" | "sessionId">): UsageSessionMeta[] {
  const byMember = db.all<UsageSessionMeta>(
    "SELECT session_id, created_at, coverage, coverage_reason FROM usage_sessions WHERE run_id=? AND member_id=? ORDER BY created_at, session_id",
    row.runId,
    row.memberId,
  );
  if (byMember.length > 0) return byMember;
  if (row.sessionId === null) return [];
  return db.all<UsageSessionMeta>(
    "SELECT session_id, created_at, coverage, coverage_reason FROM usage_sessions WHERE session_id=?",
    row.sessionId,
  );
}

export function computeOutcomeCost(
  db: EvidenceDb,
  row: Pick<OutcomeRow, "runId" | "memberId" | "sessionId" | "provider">,
  prices?: UsageConfig["prices"],
): ObservedOutcomeCost {
  const sessions = usageSessionsFor(db, row);
  if (sessions.length === 0) return { costCoverage: "none" };
  const combined = combineCoverage(sessions.map(session => ({
    coverage: session.coverage,
    ...(session.coverage_reason === null ? {} : { coverageReason: session.coverage_reason }),
  })));
  if (combined.coverage === "none") return { costCoverage: "none" };
  const measuredIds = sessions.filter(session => session.coverage !== "none").map(session => session.session_id);
  const records = readRecords(db, { sessionIds: measuredIds });
  if (records.length === 0) return { costCoverage: "none" };
  const priced = records.map(({ record }) => ({ ...priceUsage(record, prices), tokens: record.tokens }));
  const totals = sumUsage(priced);
  if (combined.coverage !== "complete" || totals.pricing.unknown > 0) {
    return { costCoverage: "partial" };
  }
  return {
    costCoverage: "complete",
    listUsd: totals.cost,
    ...(isMetered(row.provider) ? { spentUsd: totals.cost } : {}),
  };
}

export function applyOutcomeCost(tx: EvidenceTx, row: OutcomeRow, prices?: UsageConfig["prices"]): boolean {
  if (row.source === "legacy") return false;
  const observed = computeOutcomeCost(tx, row, prices);
  const same = row.payload.costCoverage === observed.costCoverage
    && row.payload.listUsd === observed.listUsd
    && row.payload.spentUsd === observed.spentUsd;
  if (same) return false;
  row.payload.costCoverage = observed.costCoverage;
  if (observed.listUsd === undefined) delete row.payload.listUsd;
  else row.payload.listUsd = observed.listUsd;
  if (observed.spentUsd === undefined) delete row.payload.spentUsd;
  else row.payload.spentUsd = observed.spentUsd;
  return true;
}

export function refreshOutcomeCostsForSessions(
  tx: EvidenceTx,
  targets: readonly { sessionId: string; runId?: string; memberId?: string; exited?: boolean }[],
  prices?: UsageConfig["prices"],
): number {
  const seen = new Map<string, boolean>();
  for (const target of targets) {
    const exited = target.exited === true;
    if (target.runId !== undefined && target.memberId !== undefined) {
      const id = `${target.runId}:${target.memberId}`;
      seen.set(id, (seen.get(id) ?? false) || exited);
    }
    const bySession = tx.all<{ outcome_id: string }>("SELECT outcome_id FROM outcomes WHERE session_id=?", target.sessionId);
    for (const found of bySession) seen.set(found.outcome_id, (seen.get(found.outcome_id) ?? false) || exited);
  }
  let updated = 0;
  for (const [id, exited] of seen) {
    let row: OutcomeRow | undefined;
    try { row = readOutcome(tx, id); } catch { continue; }
    if (!row || row.source === "legacy") continue;
    if (row.disposition === "open" && !exited) continue;
    if (applyOutcomeCost(tx, row, prices)) {
      writeOutcome(tx, row);
      updated++;
    }
  }
  return updated;
}

export function syncOutcomeCosts(
  store: EvidenceStore,
  prices?: UsageConfig["prices"],
  options?: { limit?: number },
): number {
  const modules = store.status().modules;
  if (modules[OUTCOMES_MODULE] !== "ready" || modules[usageModule.name] !== "ready") return 0;
  const limit = options?.limit !== undefined && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 500;
  let updated = 0;
  store.tryWrite(tx => {
    const ids = tx.all<{ outcome_id: string }>(
      "SELECT outcome_id FROM outcomes WHERE source <> 'legacy' AND disposition <> 'open' AND list_usd IS NULL "
      + "AND (session_id IS NOT NULL OR run_id IS NOT NULL) ORDER BY ended_at DESC, outcome_id DESC LIMIT ?",
      limit,
    );
    for (const { outcome_id: id } of ids) {
      let row: OutcomeRow | undefined;
      try { row = readOutcome(tx, id); } catch { continue; }
      if (!row || row.source === "legacy") continue;
      if (applyOutcomeCost(tx, row, prices)) {
        writeOutcome(tx, row);
        updated++;
      }
    }
  });
  return updated;
}
