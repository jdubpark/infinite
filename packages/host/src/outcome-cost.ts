import type { UsageConfig } from "./config.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceTx } from "./evidence/types.js";
import { isMetered, type SessionCost } from "./outcome-cells.js";
import { OUTCOMES_MODULE, readOutcome, writeOutcome, type OutcomeRow } from "./outcome-store.js";
import type { UsageCoverage } from "./transcript-usage.js";
import { listPriceUsage, priceUsage, sumUsage } from "./usage.js";
import type { SessionUsage, UnmeasuredUsage } from "./usage-service.js";
import { readRecords, usageModule, type LedgerCoverageReason } from "./usage-store.js";

const COST_SYNC_CURSOR = "cost_sync_cursor";

export type ObservedOutcomeCost = {
  costCoverage: "none" | "partial" | "complete";
  tokens?: number;
  listUsd?: number;
  spentUsd?: number;
};

export type CostSyncResult = {
  updated: number;
  scanned: number;
  done: boolean;
};

type UsageSessionMeta = {
  session_id: string;
  created_at: string;
  coverage: UsageCoverage;
  coverage_reason: LedgerCoverageReason | null;
  exited: number;
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
    "SELECT session_id, created_at, coverage, coverage_reason, exited FROM usage_sessions WHERE run_id=? AND member_id=? ORDER BY created_at, session_id",
    row.runId,
    row.memberId,
  );
  if (byMember.length > 0) return byMember;
  if (row.sessionId === null) return [];
  return db.all<UsageSessionMeta>(
    "SELECT session_id, created_at, coverage, coverage_reason, exited FROM usage_sessions WHERE session_id=?",
    row.sessionId,
  );
}

export function computeOutcomeCost(
  db: EvidenceDb,
  row: Pick<OutcomeRow, "runId" | "memberId" | "sessionId" | "provider">,
  prices?: UsageConfig["prices"],
): ObservedOutcomeCost {
  const sessions = usageSessionsFor(db, row);
  if (sessions.length === 0 || sessions.every(session => session.coverage === "none")) return { costCoverage: "none" };
  if (sessions.some(session => session.coverage !== "complete" || session.exited !== 1)) return { costCoverage: "partial" };
  const records = readRecords(db, { sessionIds: sessions.map(session => session.session_id) });
  if (records.length === 0) return { costCoverage: "none" };
  const listed = sumUsage(records.map(({ record }) => ({ ...listPriceUsage(record, prices), tokens: record.tokens })));
  const totalTokens = listed.tokens.input + listed.tokens.output + listed.tokens.reasoning + listed.tokens.cacheRead + listed.tokens.cacheWrite;
  const metered = isMetered(row.provider)
    ? sumUsage(records.map(({ record }) => ({ ...priceUsage(record, prices), tokens: record.tokens })))
    : undefined;
  const spent = metered !== undefined && metered.pricing.unknown === 0 ? metered.cost : undefined;
  if (listed.pricing.unknown > 0) {
    return { costCoverage: "partial", tokens: totalTokens, ...(spent === undefined ? {} : { spentUsd: spent }) };
  }
  return {
    costCoverage: "complete",
    tokens: totalTokens,
    listUsd: listed.cost,
    ...(spent === undefined ? {} : { spentUsd: spent }),
  };
}

export function applyOutcomeCost(tx: EvidenceTx, row: OutcomeRow, prices?: UsageConfig["prices"]): boolean {
  if (row.source === "legacy") return false;
  const observed = computeOutcomeCost(tx, row, prices);
  const same = row.payload.costCoverage === observed.costCoverage
    && row.payload.tokens === observed.tokens
    && row.payload.listUsd === observed.listUsd
    && row.payload.spentUsd === observed.spentUsd;
  if (same) return false;
  row.payload.costCoverage = observed.costCoverage;
  if (observed.tokens === undefined) delete row.payload.tokens;
  else row.payload.tokens = observed.tokens;
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
    try {
      const row = readOutcome(tx, id);
      if (!row || row.source === "legacy") continue;
      if (row.disposition === "open" && !exited) continue;
      if (applyOutcomeCost(tx, row, prices)) {
        writeOutcome(tx, row);
        updated++;
      }
    } catch {
      continue;
    }
  }
  return updated;
}

export function syncOutcomeCosts(
  store: EvidenceStore,
  prices?: UsageConfig["prices"],
  options?: { limit?: number; reset?: boolean },
): CostSyncResult {
  const modules = store.status().modules;
  if (modules[OUTCOMES_MODULE] !== "ready" || modules[usageModule.name] !== "ready") {
    return { updated: 0, scanned: 0, done: false };
  }
  const limit = options?.limit !== undefined && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 500;
  let result: CostSyncResult = { updated: 0, scanned: 0, done: false };
  store.tryWrite(tx => {
    const after = options?.reset
      ? ""
      : (tx.get<{ value: string }>("SELECT value FROM outcome_state WHERE key=?", COST_SYNC_CURSOR)?.value ?? "");
    const ids = tx.all<{ outcome_id: string }>(
      "SELECT outcome_id FROM outcomes WHERE outcome_id > ? AND source <> 'legacy' AND disposition <> 'open' AND list_usd IS NULL "
      + "AND (session_id IS NOT NULL OR run_id IS NOT NULL) ORDER BY outcome_id ASC LIMIT ?",
      after,
      limit,
    );
    let updated = 0;
    for (const { outcome_id: id } of ids) {
      try {
        const row = readOutcome(tx, id);
        if (!row || row.source === "legacy") continue;
        if (applyOutcomeCost(tx, row, prices)) {
          writeOutcome(tx, row);
          updated++;
        }
      } catch {
        continue;
      }
    }
    const done = ids.length < limit;
    const nextCursor = done ? "" : ids.at(-1)!.outcome_id;
    tx.run(
      "INSERT INTO outcome_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      COST_SYNC_CURSOR,
      nextCursor,
    );
    result = { updated, scanned: ids.length, done };
  });
  return result;
}

export function outcomeCostSync(
  store: EvidenceStore,
  prices?: UsageConfig["prices"],
  options?: { limit?: number },
): () => void {
  let done = false;
  return () => {
    if (done) return;
    const step = syncOutcomeCosts(store, prices, options);
    if (step.done) done = true;
  };
}
