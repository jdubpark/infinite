import { z } from "zod";
import type { EventOutbox, EventProjector } from "./evidence/outbox.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceModule } from "./evidence/types.js";
import { ID_RE } from "./objective-types.js";

export const VERDICTS_MODULE = "objective-verdicts";
export const VERDICT_RETENTION_DAYS = 730;

const TABLE = "objective_verdicts";
const DAY_MS = 86_400_000;
const DEFAULT_SWEEP_LIMIT = 100;

const count = z.number().int().min(0).max(8);
const assessed = z.enum(["met", "not-met", "inconclusive"]);

/** The data of a `verdict.recorded` run event. Ids, enumerations, counts, and flags only: no text. */
export const verdictEventDataSchema = z.strictObject({
  verdictId: z.uuid(),
  projectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  goalId: z.uuid().optional(),
  cycle: z.number().int().min(1).optional(),
  kind: z.enum(["reviewed", "no-change"]),
  recordVersion: z.number().int().min(1),
  rubricVersion: z.number().int().min(1),
  profileId: z.string().regex(ID_RE).optional(),
  provider: z.enum(["claude", "codex", "opencode"]).optional(),
  model: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).optional(),
  family: z.string().regex(ID_RE).optional(),
  sharedFamily: z.boolean(),
  alsoReviewed: z.boolean(),
  result: assessed,
  evaluatorResult: assessed.optional(),
  reason: z.enum(["no-independent-evaluator", "evaluator-unavailable", "record-unavailable", "context-too-large"]).optional(),
  met: count,
  notMet: count,
  inconclusive: count,
  pendingOwner: count,
});
export type VerdictEventData = z.infer<typeof verdictEventDataSchema>;

/** The pattern of outcomeModule: one table, two blind indexes, a deleteRun hook that stamps and never removes. */
export function verdictModule(options?: { now?: () => string }): EvidenceModule {
  const now = options?.now ?? (() => new Date().toISOString());
  return {
    name: VERDICTS_MODULE,
    version: 1,
    readVersion: 1,
    migrate(tx, from) {
      if (from >= 1) return;
      tx.exec(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (`
        + "verdict_id TEXT PRIMARY KEY, project_ref BLOB NOT NULL, goal_ref BLOB, run_id TEXT NOT NULL, cycle INTEGER, "
        + "revision INTEGER NOT NULL, kind TEXT NOT NULL, record_version INTEGER NOT NULL, rubric_version INTEGER NOT NULL, "
        + "profile_id TEXT, provider TEXT, model TEXT, family TEXT, shared_family INTEGER NOT NULL, also_reviewed INTEGER NOT NULL, "
        + "result TEXT NOT NULL, evaluator_result TEXT, reason TEXT, "
        + "met INTEGER NOT NULL, not_met INTEGER NOT NULL, inconclusive INTEGER NOT NULL, pending_owner INTEGER NOT NULL, "
        + "at TEXT NOT NULL, run_deleted_at TEXT)",
      );
      tx.exec(`CREATE INDEX IF NOT EXISTS objective_verdicts_project ON ${TABLE} (project_ref, at)`);
      tx.exec(`CREATE INDEX IF NOT EXISTS objective_verdicts_goal ON ${TABLE} (goal_ref, at)`);
    },
    deleteRun(tx, runId) {
      tx.run(`UPDATE ${TABLE} SET run_deleted_at=COALESCE(run_deleted_at, ?) WHERE run_id=?`, now(), runId);
    },
    runIds(db) {
      return db.all<{ run_id: string }>(`SELECT DISTINCT run_id FROM ${TABLE} WHERE run_deleted_at IS NULL`).map(row => row.run_id);
    },
    counts(db) {
      return { verdicts: db.get<{ n: number }>(`SELECT count(*) AS n FROM ${TABLE}`)?.n ?? 0 };
    },
  };
}

/**
 * Projects run events of kind "verdict.recorded" into one row each; a repeated verdictId writes nothing. Data that
 * fails the schema writes nothing and never blocks later events. The event carries its own project id.
 */
export function verdictProjector(): EventProjector {
  return {
    name: "verdicts",
    module: VERDICTS_MODULE,
    kinds: ["verdict.recorded"],
    project(tx, event) {
      const parsed = verdictEventDataSchema.safeParse(event.data);
      if (!parsed.success) return;
      const data = parsed.data;
      tx.run(
        `INSERT OR IGNORE INTO ${TABLE} (verdict_id, project_ref, goal_ref, run_id, cycle, revision, kind, record_version, `
        + "rubric_version, profile_id, provider, model, family, shared_family, also_reviewed, result, evaluator_result, reason, "
        + "met, not_met, inconclusive, pending_owner, at, run_deleted_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        data.verdictId,
        tx.index("project", data.projectId),
        data.goalId === undefined ? null : tx.index("goal", data.goalId),
        event.runId,
        data.cycle ?? null,
        event.revision,
        data.kind,
        data.recordVersion,
        data.rubricVersion,
        data.profileId ?? null,
        data.provider ?? null,
        data.model ?? null,
        data.family ?? null,
        data.sharedFamily ? 1 : 0,
        data.alsoReviewed ? 1 : 0,
        data.result,
        data.evaluatorResult ?? null,
        data.reason ?? null,
        data.met,
        data.notMet,
        data.inconclusive,
        data.pendingOwner,
        event.at,
      );
    },
  };
}

/** Registers the module, then its projector. */
export function registerVerdicts(store: EvidenceStore, outbox: EventOutbox): void {
  store.register(verdictModule());
  outbox.registerProjector(verdictProjector());
}

/**
 * Deletes rows whose `at` is more than VERDICT_RETENTION_DAYS before `now`, at most `limit` (default 100) per call.
 * Never throws: it returns 0 when the module is not ready or the write fails.
 */
export function sweepExpiredVerdicts(store: EvidenceStore, now: string, limit: number = DEFAULT_SWEEP_LIMIT): number {
  try {
    if (store.status().modules[VERDICTS_MODULE] !== "ready") return 0;
    const cutoff = new Date(Date.parse(now) - VERDICT_RETENTION_DAYS * DAY_MS).toISOString();
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_SWEEP_LIMIT;
    return store.write(tx => tx.run(
      `DELETE FROM ${TABLE} WHERE verdict_id IN (SELECT verdict_id FROM ${TABLE} WHERE at<? ORDER BY at, verdict_id LIMIT ?)`,
      cutoff,
      max,
    ).changes);
  } catch {
    console.warn("Verdict retention sweep failed.");
    return 0;
  }
}
