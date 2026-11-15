import { createHash } from "node:crypto";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "./evidence/types.js";
import type { DecisionRow, RoutingPayload, RoutingPoint } from "./routing-types.js";

export const ROUTING_MODULE = "routing";
export const ROUTING_RETENTION_DAYS = 180, TASK_DECISION_LIMIT = 20, PROJECT_DECISION_LIMIT = 500, PAYLOAD_LIMIT_BYTES = 16 * 1024;
const SHADOW_PROGRESS_LIMIT = 50, SWEEP_LIMIT = 100, DAY_MILLISECONDS = 86_400_000;
const TABLE = "routing_decisions";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS routing_decisions (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, "
  + "task_key TEXT NOT NULL, point TEXT NOT NULL, ordinal INTEGER NOT NULL, project_ref TEXT NOT NULL, role TEXT NOT NULL, "
  + "area_ref TEXT, kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL, feature_map_ref TEXT NOT NULL, "
  + "mode TEXT NOT NULL, algorithm_version INTEGER NOT NULL, reward_version INTEGER NOT NULL, policy_digest TEXT NOT NULL, "
  + "seed TEXT NOT NULL, basis TEXT NOT NULL, chosen_profile_id TEXT NOT NULL, chosen_identity TEXT NOT NULL, "
  + "greedy_profile_id TEXT NOT NULL, coordinator_profile_id TEXT, explore INTEGER NOT NULL, state TEXT NOT NULL, "
  + "member_id TEXT, decided_at TEXT NOT NULL, encrypted_payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS routing_by_task ON routing_decisions (run_id, task_key, revision, point, ordinal)",
  "CREATE INDEX IF NOT EXISTS routing_by_project ON routing_decisions (project_ref, point, decided_at, key)",
  "CREATE INDEX IF NOT EXISTS routing_by_time ON routing_decisions (decided_at, key)",
];

const COLUMNS = ["key", "run_id", "revision", "task_key", "point", "ordinal", "project_ref", "role", "area_ref", "kind", "risk",
  "feature_version", "feature_map_ref", "mode", "algorithm_version", "reward_version", "policy_digest", "seed", "basis",
  "chosen_profile_id", "chosen_identity", "greedy_profile_id", "coordinator_profile_id", "explore", "state", "member_id",
  "decided_at", "encrypted_payload"] as const;
const INSERT = `INSERT INTO ${TABLE} (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")}) ON CONFLICT(key) DO NOTHING`;

/** The plain columns in the order of `DecisionSql`, without the sealed payload. */
const PLAIN = "key, run_id, revision, task_key, point, ordinal, project_ref, role, area_ref, kind, risk, feature_version, "
  + "feature_map_ref, mode, algorithm_version, reward_version, policy_digest, seed, basis, chosen_profile_id, chosen_identity, "
  + "greedy_profile_id, coordinator_profile_id, explore, state, member_id, decided_at";

type DecisionSql = {
  key: string; run_id: string; revision: number; task_key: string; point: RoutingPoint; ordinal: number; project_ref: string;
  role: "implementer" | "scout"; area_ref: string | null; kind: string | null; risk: "normal" | "elevated"; feature_version: number;
  feature_map_ref: string; mode: "shadow" | "auto"; algorithm_version: number; reward_version: number; policy_digest: string;
  seed: string; basis: string; chosen_profile_id: string; chosen_identity: string; greedy_profile_id: string;
  coordinator_profile_id: string | null; explore: number; state: DecisionRow["state"]; member_id: string | null; decided_at: string;
};
type SealedSql = DecisionSql & { encrypted_payload: string };

/** Ids, enumerations, numbers, times, and blind indexes only. The payload is sealed. */
function toDecision(row: DecisionSql): DecisionRow {
  return {
    key: row.key, runId: row.run_id, revision: row.revision, taskKey: row.task_key, point: row.point, ordinal: row.ordinal,
    projectRef: row.project_ref, role: row.role, areaRef: row.area_ref, kind: row.kind, risk: row.risk,
    featureVersion: row.feature_version, featureMapRef: row.feature_map_ref, mode: row.mode,
    algorithmVersion: row.algorithm_version, rewardVersion: row.reward_version, policyDigest: row.policy_digest, seed: row.seed,
    basis: row.basis, chosenProfileId: row.chosen_profile_id, chosenIdentity: row.chosen_identity,
    greedyProfileId: row.greedy_profile_id, coordinatorProfileId: row.coordinator_profile_id, explore: row.explore === 1,
    state: row.state, memberId: row.member_id, decidedAt: row.decided_at,
  };
}

/** Opens the sealed payload. An unreadable one gives null; the plain row still returns. */
function openPayload(db: EvidenceDb, row: SealedSql): RoutingPayload | null {
  try {
    return db.open<RoutingPayload>(TABLE, row.key, row.encrypted_payload);
  } catch {
    return null;
  }
}

export function routingModule(): EvidenceModule {
  return {
    name: ROUTING_MODULE,
    version: 1,
    readVersion: 1,
    migrate(tx) {
      for (const statement of SCHEMA) tx.exec(statement);
    },
    counts(db) {
      return { decisions: db.get<{ n: number }>(`SELECT count(*) AS n FROM ${TABLE}`)?.n ?? 0 };
    },
  };
}

/** SHA-256 hex of `${runId}|${revision}|${taskKey}|${point}|${ordinal}`. `taskKey` is the task's blind index. */
export function decisionKey(runId: string, revision: number, taskKey: string, point: RoutingPoint, ordinal: number): string {
  return createHash("sha256").update(`${runId}|${revision}|${taskKey}|${point}|${ordinal}`, "utf8").digest("hex");
}

/** One row by its key. Plain columns only: a key read opens no payload. */
export function readDecision(db: EvidenceDb, key: string): DecisionRow | undefined {
  const row = db.get<DecisionSql>(`SELECT ${PLAIN} FROM ${TABLE} WHERE key=?`, key);
  return row === undefined ? undefined : toDecision(row);
}

/**
 * INSERT ... ON CONFLICT(key) DO NOTHING. True when this call stored the row. Throws RangeError when the payload's
 * JSON is over PAYLOAD_LIMIT_BYTES, so nothing is stored. `explore` is stored as 0 or 1.
 */
export function insertDecision(tx: EvidenceTx, row: DecisionRow, payload: RoutingPayload): boolean {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_LIMIT_BYTES) {
    throw new RangeError("A routing decision payload is over its limit.");
  }
  const sealed = tx.seal(TABLE, row.key, payload);
  const result = tx.run(
    INSERT,
    row.key, row.runId, row.revision, row.taskKey, row.point, row.ordinal, row.projectRef, row.role, row.areaRef, row.kind,
    row.risk, row.featureVersion, row.featureMapRef, row.mode, row.algorithmVersion, row.rewardVersion, row.policyDigest,
    row.seed, row.basis, row.chosenProfileId, row.chosenIdentity, row.greedyProfileId, row.coordinatorProfileId,
    row.explore ? 1 : 0, row.state, row.memberId, row.decidedAt, sealed,
  );
  return result.changes === 1;
}

/**
 * The decisions of one task of one run, in revision, point, ordinal order. `taskId` is the task's plain id; the read
 * takes its blind index. At most TASK_DECISION_LIMIT rows, and `capped` says when more exist.
 */
export function taskDecisions(db: EvidenceDb, runId: string, taskId: string): { rows: (DecisionRow & { payload: RoutingPayload | null })[]; capped: boolean } {
  const taskKey = db.index("task", taskId);
  const found = db.all<SealedSql>(
    `SELECT ${PLAIN}, encrypted_payload FROM ${TABLE} WHERE run_id=? AND task_key=? ORDER BY revision, point, ordinal LIMIT ?`,
    runId, taskKey, TASK_DECISION_LIMIT + 1,
  );
  const kept = found.slice(0, TASK_DECISION_LIMIT);
  return {
    rows: kept.map(row => ({ ...toDecision(row), payload: openPayload(db, row) })),
    capped: found.length > TASK_DECISION_LIMIT,
  };
}

/** The start decisions of one project, newest first, decided at or after `since`. `projectId` is the plain id. */
function projectRows(db: EvidenceDb, projectId: string, since: string): { rows: SealedSql[]; capped: boolean } {
  const projectRef = db.index("project", projectId);
  const found = db.all<SealedSql>(
    `SELECT ${PLAIN}, encrypted_payload FROM ${TABLE} WHERE project_ref=? AND point='start' AND decided_at>=? `
    + "ORDER BY decided_at DESC, key DESC LIMIT ?",
    projectRef, since, PROJECT_DECISION_LIMIT + 1,
  );
  return { rows: found.slice(0, PROJECT_DECISION_LIMIT), capped: found.length > PROJECT_DECISION_LIMIT };
}

/**
 * The newest PROJECT_DECISION_LIMIT start decisions of a project decided at or after `since`, newest first. The
 * `point` filter follows the index; only start decisions exist before escalation and scout decisions are recorded.
 */
export function projectDecisions(db: EvidenceDb, projectId: string, since: string): { rows: DecisionRow[]; capped: boolean } {
  const { rows, capped } = projectRows(db, projectId, since);
  return { rows: rows.map(toDecision), capped };
}

/**
 * The newest decision of each distinct cell (area, kind, feature version, feature map) among the project's newest
 * rows, at most `limit` cells. Opens the payload of those cells only.
 */
export function projectCells(db: EvidenceDb, projectId: string, since: string, limit: number): {
  cells: { areaRef: string | null; kind: string | null; featureVersion: number; featureMapRef: string; payload: RoutingPayload | null }[];
  capped: boolean;
} {
  const { rows, capped: rowsCapped } = projectRows(db, projectId, since);
  const seen = new Set<string>();
  const cells: { areaRef: string | null; kind: string | null; featureVersion: number; featureMapRef: string; payload: RoutingPayload | null }[] = [];
  let capped = rowsCapped;
  for (const row of rows) {
    const cell = JSON.stringify([row.area_ref, row.kind, row.feature_version, row.feature_map_ref]);
    if (seen.has(cell)) continue;
    if (cells.length === limit) {
      capped = true;
      break;
    }
    seen.add(cell);
    cells.push({
      areaRef: row.area_ref, kind: row.kind, featureVersion: row.feature_version, featureMapRef: row.feature_map_ref,
      payload: openPayload(db, row),
    });
  }
  return { cells, capped };
}

/** The start decisions of a project (at most SHADOW_PROGRESS_LIMIT counted) and the first one's time. */
export function shadowProgress(db: EvidenceDb, projectId: string): { decisions: number; capped: boolean; firstAt: string | null } {
  const projectRef = db.index("project", projectId);
  const counted = db.get<{ n: number }>(
    "SELECT count(*) AS n FROM (SELECT 1 FROM routing_decisions WHERE project_ref=? AND point='start' LIMIT ?)",
    projectRef, SHADOW_PROGRESS_LIMIT,
  )?.n ?? 0;
  const first = db.get<{ decided_at: string }>(
    "SELECT decided_at FROM routing_decisions WHERE project_ref=? AND point='start' ORDER BY decided_at ASC LIMIT 1",
    projectRef,
  );
  return { decisions: counted, capped: counted >= SHADOW_PROGRESS_LIMIT, firstAt: first?.decided_at ?? null };
}

/**
 * Removes up to `limit` decisions decided more than ROUTING_RETENTION_DAYS before `now`, oldest first, and returns
 * how many it removed. Returns 0 when the store or the table is unavailable. It never throws.
 */
export function sweepExpiredDecisions(store: EvidenceStore, now: string, limit: number = SWEEP_LIMIT): number {
  const cutoff = new Date(Date.parse(now) - ROUTING_RETENTION_DAYS * DAY_MILLISECONDS).toISOString();
  try {
    return store.write(tx => tx.run(
      "DELETE FROM routing_decisions WHERE key IN (SELECT key FROM routing_decisions WHERE decided_at < ? ORDER BY decided_at, key LIMIT ?)",
      cutoff, limit,
    ).changes);
  } catch {
    return 0;
  }
}
