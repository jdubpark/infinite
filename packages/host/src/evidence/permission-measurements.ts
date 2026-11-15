/**
 * The permission agent's own durable state: replay measurements, replay results, and the usage of every
 * model turn. It is not the decision journal: a replay turn decides no request, and nothing here is
 * ever replayed as a verdict. Case details and notes contain commands and paths, so they are sealed.
 */
import { randomUUID } from "node:crypto";
import type { EvidenceModule, EvidenceTx } from "./types.js";
import type { EvidenceStore } from "./store.js";
import type { ReplayResultSummary, ReplayResults } from "../permission-core.js";
import type { PermissionTurnUsage } from "../permission-reviewer.js";

const MODULE = "permission-measurements";
const RUNS = "permission_replay_runs";
const CASES = "permission_replay_cases";
const USAGE = "permission_turn_usage";

export const permissionMeasurementsModule: EvidenceModule = {
  name: MODULE,
  version: 1,
  readVersion: 1,
  migrate(tx: EvidenceTx) {
    tx.exec(`CREATE TABLE IF NOT EXISTS ${RUNS} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, `
      + "set_digest TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, cases INTEGER NOT NULL, "
      + "misses INTEGER NOT NULL, relevant INTEGER NOT NULL, miss_upper REAL NOT NULL, result_sealed TEXT NOT NULL)");
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_replay_runs_binding ON ${RUNS}(binding, seq DESC)`);
    tx.exec(`CREATE TABLE IF NOT EXISTS ${CASES} (seq INTEGER PRIMARY KEY AUTOINCREMENT, row_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, `
      + "case_id TEXT NOT NULL, label TEXT NOT NULL, outcome TEXT NOT NULL, tier TEXT NOT NULL, at TEXT NOT NULL, detail_sealed TEXT NOT NULL)");
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_replay_cases_run ON ${CASES}(run_id, seq)`);
    tx.exec(`CREATE TABLE IF NOT EXISTS ${USAGE} (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, purpose TEXT NOT NULL, tier TEXT NOT NULL, `
      + "profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, "
      + "reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost_usd REAL)");
    tx.exec(`CREATE INDEX IF NOT EXISTS permission_turn_usage_at ON ${USAGE}(at)`);
  },
  counts(db) {
    const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
    return { replayRuns: count(RUNS), replayCases: count(CASES), turnUsage: count(USAGE) };
  },
};

/** One case's measurement, as the runner stores it. */
export interface ReplayCaseMeasurement {
  caseId: string;
  label: string;
  outcome: string;
  tier: string;
  at: string;
  detail: Record<string, unknown>;
}

export interface StoredReplayResult extends ReplayResultSummary {
  startedAt: string;
  setDigest: string;
  result: Record<string, unknown>;
}

export class PermissionMeasurements implements ReplayResults {
  constructor(private readonly store: EvidenceStore) {
    if (store.status().modules[MODULE] !== "ready") throw new TypeError("The permission-measurements evidence module must be registered and ready.");
  }

  recordCase(runId: string, measurement: ReplayCaseMeasurement): void {
    const rowId = randomUUID();
    this.store.write(tx => tx.run(
      `INSERT INTO ${CASES} (row_id, run_id, case_id, label, outcome, tier, at, detail_sealed) VALUES (?,?,?,?,?,?,?,?)`,
      rowId, runId, measurement.caseId, measurement.label, measurement.outcome, measurement.tier, measurement.at,
      tx.seal(CASES, rowId, measurement.detail),
    ));
  }

  cases(runId: string): ReplayCaseMeasurement[] {
    return this.store.read(db => db.all<{ row_id: string; case_id: string; label: string; outcome: string; tier: string; at: string; detail_sealed: string }>(
      `SELECT row_id, case_id, label, outcome, tier, at, detail_sealed FROM ${CASES} WHERE run_id=? ORDER BY seq`, runId,
    ).map(row => ({ caseId: row.case_id, label: row.label, outcome: row.outcome, tier: row.tier, at: row.at,
      detail: db.open<Record<string, unknown>>(CASES, row.row_id, row.detail_sealed) })));
  }

  recordRun(run: StoredReplayResult): void {
    this.store.write(tx => tx.run(
      `INSERT INTO ${RUNS} (id, binding, set_digest, started_at, finished_at, cases, misses, relevant, miss_upper, result_sealed) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      run.id, run.binding, run.setDigest, run.startedAt, run.finishedAt, run.cases, run.missRate.count, run.missRate.relevant,
      run.missRate.upper, tx.seal(RUNS, run.id, { missRate: run.missRate, result: run.result }),
    ));
  }

  latest(binding: string): StoredReplayResult | undefined {
    return this.store.read(db => {
      const row = db.get<{ id: string; binding: string; set_digest: string; started_at: string; finished_at: string; cases: number; result_sealed: string }>(
        `SELECT id, binding, set_digest, started_at, finished_at, cases, result_sealed FROM ${RUNS} WHERE binding=? ORDER BY seq DESC LIMIT 1`, binding);
      if (!row) return undefined;
      const sealed = db.open<{ missRate: ReplayResultSummary["missRate"]; result: Record<string, unknown> }>(RUNS, row.id, row.result_sealed);
      return { id: row.id, binding: row.binding, setDigest: row.set_digest, startedAt: row.started_at, finishedAt: row.finished_at,
        cases: row.cases, missRate: sealed.missRate, result: sealed.result };
    });
  }

  /** Turn usage is host usage: it belongs to no run and no budget reads it. A store failure loses one row with a warning. */
  recordUsage(usage: PermissionTurnUsage): void {
    this.store.tryWrite(tx => tx.run(
      `INSERT INTO ${USAGE} (at, purpose, tier, profile_id, provider, model, input, output, reasoning, cache_read, cache_write, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      usage.at, usage.purpose, usage.tier, usage.profileId, usage.provider, usage.model, usage.tokens.input, usage.tokens.output,
      usage.tokens.reasoning, usage.tokens.cacheRead, usage.tokens.cacheWrite, usage.costUsd ?? null,
    ));
  }

  usage(since: string): { turns: number; costUsd: number; byPurpose: Record<string, number> } {
    return this.store.read(db => {
      const rows = db.all<{ purpose: string; n: number; cost: number | null }>(
        `SELECT purpose, COUNT(*) AS n, SUM(cost_usd) AS cost FROM ${USAGE} WHERE at>=? GROUP BY purpose`, since);
      return { turns: rows.reduce((sum, row) => sum + row.n, 0), costUsd: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        byPurpose: Object.fromEntries(rows.map(row => [row.purpose, row.n])) };
    });
  }
}
