import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceModule, type EvidenceTx } from "./evidence/types.js";
import type {
  Coverage,
  Disposition,
  Exclusion,
  Flag,
  LandingMethod,
  Level,
  RowState,
  ScanGap,
  ScanPoint,
} from "./outcome-rules.js";
import type { ReplacementCause, RunSummaryCounts } from "./run-events.js";
import type { TeamTask } from "./team-types.js";
import type { Identity, RoutingEvidenceRow } from "./routing-types.js";

export const OUTCOMES_MODULE = "outcomes";
export const OUTCOME_RETENTION_DAYS = 730;

const OUTCOMES = "outcomes";
const OUTCOME_ROUNDS = "outcome_rounds";
const OUTCOME_ROUND_LINKS = "outcome_round_links";
const RUN_SUMMARIES = "run_summaries";
const MEMBER_RESULTS = "member_results";
const OUTCOME_SIGNALS = "outcome_signals";
const BASE_SCANS = "base_scans";
const BASE_SCAN_STATE = "base_scan_state";
const BACKFILL_RUNS = "backfill_runs";
const LEGACY_LINES = "legacy_lines";
const DAY_MS = 86_400_000;
const DEFAULT_SWEEP_LIMIT = 100;
export const UNREADABLE_REF = "unreadable";
const IN_CHUNK = 500;
const LAST_SEQ = "last_seq";
const RUN_TABLES = [OUTCOMES, OUTCOME_ROUNDS, RUN_SUMMARIES, MEMBER_RESULTS] as const;
const POINT_CHAIN_LIMIT = 64;
export const ROUTING_ROWS_PER_SOURCE = 1000;

export const OUTCOME_KINDS: readonly string[] = [
  "run.created", "run.prepared", "member.started", "member.configured", "member.reported", "member.stopped",
  "task.integrated", "scout.completed", "task.escalated", "review.recorded", "review.tree", "repair.started",
  "repair.integrated", "repair.paths", "delivery.recorded", "rating.recorded", "run.blocked",
  "run.revision-advanced", "run.settled", "run.deleted", "ledger.gap",
];

export type MemberResultDisposition = "open" | "reported" | "stalled" | "no-report" | "limit" | "owner-stop" | "host-stop";

export type OutcomePayload = import("./outcome-gauges.js").GaugePayload & {
  projectId: string;
  taskId: string;
  area: string;
  featureMap: string;
  goal?: { id: string; cycle: number };
  missionId?: string;
  replaces?: { memberId: string; cause: ReplacementCause };
  failureKind?: string;
  baseCommit?: string;
  lastReview?: "approved" | "changes-requested";
  rounds: { run: number; attributed: number; unknown: number };
  rubric?: { version: 1; correctness: number; cleanliness: number; extensibility: number; docs: number; reviewerProfileId: string };
  ownerRating?: { score: number; at: string };
  landing?: { at: string; method: LandingMethod };
  legacy?: LegacyPayload;
  diff?: TeamTask["diffStat"];
  wallMs?: number;
  tokens?: number;
  spentUsd?: number;
  listUsd?: number;
  limitEvents: number;
  costCoverage: "none" | "partial" | "complete";
};

export type RunSummaryPayload = {
  projectId: string;
  goal?: { id: string; cycle: number };
  missionId?: string; trialId?: string;
  counts?: RunSummaryCounts;
  attempts: Partial<Record<Disposition, number>>;
  rounds: { total: number; attributed: number; unattributed: number; unknown: number };
  currentBase?: string;
  reviewedHead?: string;
  reviewedTree?: string;
  mergeCommit?: string;
  deliveryMethod?: "merge" | "pull-request";
};

export type MemberResultPayload = {
  projectId: string;
  replaces?: { memberId: string; cause: ReplacementCause };
};

export type OutcomeRow = {
  outcomeId: string;
  source: string;
  projectRef: string;
  taskRef: string;
  areaRef: string;
  runId: string;
  revision: number;
  memberId: string;
  sessionId: string | null;
  attemptIndex: number;
  inherited: boolean;
  role: RowState["role"];
  profileId: string;
  provider: string;
  model: string;
  effort: string | null;
  profileEpoch: number;
  configId: string | null;
  experimentRef: string | null;
  kind: string | null;
  risk: string;
  featureVersion: number;
  disposition: Disposition;
  exclusion: Exclusion | null;
  flags: Flag[];
  integrated: Level;
  accepted: Level;
  acceptance?: Level;
  firstPass: Level;
  held: Level;
  startedAt: string | null;
  endedAt: string | null;
  frozenAt: string | null;
  holdUntil: string | null;
  runDeletedAt: string | null;
  payload: OutcomePayload;
};

export type LegacyPayload = {
  id: string;
  label?: string;
  result: "accepted" | "rejected" | "excluded";
  attempts: number;
  totalTokens?: number;
  reviewerModel?: string;
  supersedes?: string;
};

export type LegacyLineState = { state: "imported" | "superseded"; lineHash: string | null; recordedAt: string };

export type SignalKind = "rating" | "landing" | "revert" | "linked-fix" | "exclusion";
export type ExclusionReason = "outside-cause" | "invalid-task" | "trial" | "other";
export const EXCLUSION_REASONS: readonly ExclusionReason[] = ["outside-cause", "invalid-task", "trial", "other"];

export type SignalPayload =
  | { kind: "rating"; score: number }
  | {
    kind: "landing";
    commit: string;
    method: LandingMethod;
    scanSeq: number;
    holdDays: number;
    holdUntil: string;
    reviewedHead?: string;
    window?: { state: Exclude<Coverage, "open">; decidedAt: string };
  }
  | { kind: "revert"; commit: string; reverts: string; landingSignalId: string; scanSeq: number }
  | { kind: "linked-fix"; issue?: string; commit?: string; request: string; withdrawnAt?: string }
  | { kind: "exclusion"; reason: ExclusionReason; request: string; withdrawnAt?: string };

export type SignalRow = {
  signalId: string;
  runId: string;
  outcomeId: string | null;
  kind: SignalKind;
  author: "host" | "owner";
  authority: "receipt" | "claim";
  state: "active" | "withdrawn";
  at: string;
  payload: SignalPayload;
};

export type ScanRow = {
  projectRef: string;
  seq: number;
  at: string;
  checkedAt: string;
  commits: number;
  gap: ScanGap | null;
  payload: { from?: string; to: string; oldest?: string };
};

export type ScanState = {
  projectRef: string;
  seq: number;
  payload: { head: string; repository: string; baseBranch: string };
};

export type RunSummaryRow = {
  runId: string;
  source: string;
  projectRef: string;
  revision: number;
  status: string | null;
  blockCode: string | null;
  flags: Flag[];
  createdAt: string | null;
  settledAt: string | null;
  approvedAt: string | null;
  runDeletedAt: string | null;
  payload: RunSummaryPayload;
};

export type MemberResultRow = {
  resultId: string;
  source: string;
  projectRef: string;
  runId: string;
  revision: number;
  memberId: string;
  sessionId: string | null;
  role: string;
  profileId: string;
  provider: string;
  model: string;
  effort: string | null;
  profileEpoch: number;
  configId: string | null;
  reportKind: string | null;
  disposition: MemberResultDisposition;
  flags: Flag[];
  startedAt: string | null;
  endedAt: string | null;
  runDeletedAt: string | null;
  payload: MemberResultPayload;
};

export type RollupRecords = {
  runIds: string[];
  summaries: RunSummaryRow[];
  rows: OutcomeRow[];
  members: MemberResultRow[];
  unreadable: { summaries: number; rows: number; members: number };
  unindexed: number;
};

const OUTCOME_COLUMNS = [
  "outcome_id", "source", "project_ref", "task_ref", "run_id", "revision", "member_id", "session_id",
  "attempt_index", "inherited", "role", "profile_id", "provider", "model", "effort", "profile_epoch", "config_id",
  "experiment_ref", "area_ref", "kind", "risk", "feature_version", "disposition", "exclusion", "flags",
  "integrated", "accepted", "acceptance", "first_pass", "held", "started_at", "ended_at", "frozen_at", "hold_until",
  "run_deleted_at", "payload", "goal_ref", "mission_ref", "point", "feature_map_ref", "owner_score", "list_usd",
] as const;
const SUMMARY_COLUMNS = [
  "run_id", "source", "project_ref", "revision", "status", "block_code", "flags", "created_at", "settled_at",
  "approved_at", "run_deleted_at", "payload", "goal_ref", "mission_ref",
] as const;
const MEMBER_COLUMNS = [
  "result_id", "source", "project_ref", "run_id", "revision", "member_id", "session_id", "role", "profile_id",
  "provider", "model", "effort", "profile_epoch", "config_id", "report_kind", "disposition", "flags", "started_at",
  "ended_at", "run_deleted_at", "payload",
] as const;

const OUTCOME_UPSERT = upsertSql(OUTCOMES, "outcome_id", OUTCOME_COLUMNS);
const SUMMARY_UPSERT = upsertSql(RUN_SUMMARIES, "run_id", SUMMARY_COLUMNS);
const MEMBER_UPSERT = upsertSql(MEMBER_RESULTS, "result_id", MEMBER_COLUMNS);

type OutcomeSql = {
  outcome_id: string;
  source: string;
  project_ref: string;
  task_ref: string;
  run_id: string;
  revision: number;
  member_id: string;
  session_id: string | null;
  attempt_index: number;
  inherited: number;
  role: RowState["role"];
  profile_id: string;
  provider: string;
  model: string;
  effort: string | null;
  profile_epoch: number;
  config_id: string | null;
  experiment_ref: string | null;
  area_ref: string;
  kind: string | null;
  risk: string;
  feature_version: number;
  disposition: Disposition;
  exclusion: Exclusion | null;
  flags: string;
  integrated: Level;
  accepted: Level;
  acceptance: Level;
  first_pass: Level;
  held: Level;
  started_at: string | null;
  ended_at: string | null;
  frozen_at: string | null;
  hold_until: string | null;
  run_deleted_at: string | null;
  payload: string;
  goal_ref: string | null;
  mission_ref: string | null;
  point: RoutingPointValue | null;
  feature_map_ref: string | null;
  owner_score: number | null;
  list_usd: number | null;
};

type SummarySql = {
  run_id: string;
  source: string;
  project_ref: string;
  revision: number;
  status: string | null;
  block_code: string | null;
  flags: string;
  created_at: string | null;
  settled_at: string | null;
  approved_at: string | null;
  run_deleted_at: string | null;
  payload: string;
  goal_ref: string | null;
  mission_ref: string | null;
};

type MemberSql = {
  result_id: string;
  source: string;
  project_ref: string;
  run_id: string;
  revision: number;
  member_id: string;
  session_id: string | null;
  role: string;
  profile_id: string;
  provider: string;
  model: string;
  effort: string | null;
  profile_epoch: number;
  config_id: string | null;
  report_kind: string | null;
  disposition: MemberResultDisposition;
  flags: string;
  started_at: string | null;
  ended_at: string | null;
  run_deleted_at: string | null;
  payload: string;
};

export function outcomeModule(options?: { now?: () => string }): EvidenceModule {
  const now = options?.now ?? (() => new Date().toISOString());
  return {
    name: OUTCOMES_MODULE,
    version: 5,
    readVersion: 2,
    migrate(tx, from) {
      if (from < 1) migrateVersion1(tx);
      if (from < 2) migrateVersion2(tx);
      if (from < 3) migrateVersion3(tx);
      if (from < 4) migrateVersion4(tx);
      if (from < 5) migrateVersion5(tx);
    },
    deleteRun(tx, runId) {
      const stamp = now();
      for (const table of RUN_TABLES) {
        tx.run(`UPDATE ${table} SET run_deleted_at=COALESCE(run_deleted_at, ?) WHERE run_id=?`, stamp, runId);
      }
      const lastSeq = tx.get<{ value: number }>("SELECT value FROM outcome_state WHERE key=?", LAST_SEQ)?.value ?? 0;
      const kindMarks = OUTCOME_KINDS.map(() => "?").join(", ");
      const unseen = tx.get(
        `SELECT seq FROM run_events WHERE run_id=? AND seq>? AND kind IN (${kindMarks}) LIMIT 1`,
        runId,
        lastSeq,
        ...OUTCOME_KINDS,
      );
      if (unseen !== undefined) {
        addGap(tx, OUTCOMES, "outcome_id", runId);
        addGap(tx, MEMBER_RESULTS, "result_id", runId);
        addGap(tx, RUN_SUMMARIES, "run_id", runId);
      }
    },
    runIds(db) {
      const rows = db.all<{ run_id: string }>(
        "SELECT run_id FROM outcomes WHERE run_deleted_at IS NULL "
        + "UNION SELECT run_id FROM run_summaries WHERE run_deleted_at IS NULL "
        + "UNION SELECT run_id FROM member_results WHERE run_deleted_at IS NULL "
        + "UNION SELECT run_id FROM outcome_rounds WHERE run_deleted_at IS NULL",
      );
      return rows.map(row => row.run_id);
    },
    counts(db) {
      const count = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
      return {
        outcomes: count("SELECT count(*) AS n FROM outcomes WHERE source<>'legacy'"),
        open: count("SELECT count(*) AS n FROM outcomes WHERE disposition='open'"),
        gap: count("SELECT count(*) AS n FROM outcomes WHERE (','||flags||',') LIKE '%,gap,%'"),
        backfilled: count("SELECT count(*) AS n FROM outcomes WHERE (','||flags||',') LIKE '%,backfilled,%'"),
        summaries: count("SELECT count(*) AS n FROM run_summaries"),
        memberResults: count("SELECT count(*) AS n FROM member_results"),
        signals: count("SELECT count(*) AS n FROM outcome_signals"),
        scans: count("SELECT count(*) AS n FROM base_scans"),
        legacy: count("SELECT count(*) AS n FROM outcomes WHERE source='legacy'"),
        legacyLines: count("SELECT count(*) AS n FROM legacy_lines"),
      };
    },
  };
}

function migrateVersion1(tx: EvidenceTx): void {
  tx.exec(
    "CREATE TABLE IF NOT EXISTS outcomes (outcome_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
    + "project_ref TEXT NOT NULL, task_ref TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, "
    + "member_id TEXT NOT NULL, session_id TEXT, attempt_index INTEGER NOT NULL, inherited INTEGER NOT NULL, "
    + "role TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, "
    + "profile_epoch INTEGER NOT NULL, config_id TEXT, experiment_ref TEXT, area_ref TEXT NOT NULL, kind TEXT, "
    + "risk TEXT NOT NULL, feature_version INTEGER NOT NULL, disposition TEXT NOT NULL, exclusion TEXT, "
    + "flags TEXT NOT NULL, integrated INTEGER, accepted INTEGER, first_pass INTEGER, held INTEGER, "
    + "started_at TEXT, ended_at TEXT, frozen_at TEXT, hold_until TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS outcome_rounds (run_id TEXT NOT NULL, revision INTEGER NOT NULL, "
    + "round INTEGER NOT NULL, cause TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, "
    + "run_deleted_at TEXT, PRIMARY KEY (run_id, revision, round))",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS outcome_round_links (outcome_id TEXT NOT NULL, run_id TEXT NOT NULL, "
    + "revision INTEGER NOT NULL, round INTEGER NOT NULL, state TEXT NOT NULL, "
    + "PRIMARY KEY (outcome_id, revision, round))",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS run_summaries (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
    + "project_ref TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT, block_code TEXT, flags TEXT NOT NULL, "
    + "created_at TEXT, settled_at TEXT, approved_at TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS member_results (result_id TEXT PRIMARY KEY, source TEXT NOT NULL, "
    + "project_ref TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL, "
    + "session_id TEXT, role TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, "
    + "effort TEXT, profile_epoch INTEGER NOT NULL, config_id TEXT, report_kind TEXT, disposition TEXT NOT NULL, "
    + "flags TEXT NOT NULL, started_at TEXT, ended_at TEXT, run_deleted_at TEXT, payload TEXT NOT NULL)",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS backfill_runs (run_id TEXT PRIMARY KEY, at TEXT NOT NULL, rows INTEGER NOT NULL, "
    + "skipped INTEGER NOT NULL)",
  );
  tx.exec("CREATE TABLE IF NOT EXISTS outcome_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_run ON outcomes (run_id)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_session ON outcomes (session_id)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_deleted ON outcomes (run_deleted_at)");
  tx.exec("CREATE INDEX IF NOT EXISTS member_results_by_run ON member_results (run_id)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcome_round_links_by_run ON outcome_round_links (run_id)");
}

function migrateVersion2(tx: EvidenceTx): void {
  tx.exec("ALTER TABLE outcomes ADD COLUMN acceptance INTEGER");
  tx.exec("UPDATE outcomes SET acceptance = accepted");
  tx.exec(
    "CREATE TABLE IF NOT EXISTS outcome_signals (signal_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, outcome_id TEXT, "
    + "kind TEXT NOT NULL, author TEXT NOT NULL, authority TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, "
    + "payload TEXT NOT NULL)",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS base_scans (project_ref TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, "
    + "checked_at TEXT NOT NULL, commits INTEGER NOT NULL, gap TEXT, payload TEXT NOT NULL, "
    + "PRIMARY KEY (project_ref, seq))",
  );
  tx.exec(
    "CREATE TABLE IF NOT EXISTS base_scan_state (project_ref TEXT PRIMARY KEY, seq INTEGER NOT NULL, "
    + "payload TEXT NOT NULL)",
  );
  tx.exec("CREATE INDEX IF NOT EXISTS outcome_signals_by_run ON outcome_signals (run_id)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcome_signals_by_outcome ON outcome_signals (outcome_id)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcome_signals_by_kind ON outcome_signals (kind, at)");
}

function migrateVersion3(tx: EvidenceTx): void {
  tx.exec("ALTER TABLE outcomes ADD COLUMN goal_ref TEXT");
  tx.exec("ALTER TABLE outcomes ADD COLUMN mission_ref TEXT");
  tx.exec("ALTER TABLE run_summaries ADD COLUMN goal_ref TEXT");
  tx.exec("ALTER TABLE run_summaries ADD COLUMN mission_ref TEXT");
  tx.exec(
    "CREATE TABLE IF NOT EXISTS legacy_lines (line_ref TEXT PRIMARY KEY, state TEXT NOT NULL, "
    + "recorded_at TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_goal ON outcomes (goal_ref)");
  tx.exec("CREATE INDEX IF NOT EXISTS outcomes_by_mission ON outcomes (mission_ref)");
  tx.exec("CREATE INDEX IF NOT EXISTS run_summaries_by_goal ON run_summaries (goal_ref)");
  tx.exec("CREATE INDEX IF NOT EXISTS run_summaries_by_mission ON run_summaries (mission_ref)");
  tx.exec("CREATE INDEX IF NOT EXISTS legacy_lines_by_recorded ON legacy_lines (recorded_at)");
  for (const row of tx.all<{ outcome_id: string; payload: string }>("SELECT outcome_id, payload FROM outcomes")) {
    const refs = migrationRefs(tx, OUTCOMES, row.outcome_id, row.payload);
    tx.run("UPDATE outcomes SET goal_ref=?, mission_ref=? WHERE outcome_id=?", refs.goalRef, refs.missionRef, row.outcome_id);
  }
  for (const row of tx.all<{ run_id: string; payload: string }>("SELECT run_id, payload FROM run_summaries")) {
    const refs = migrationRefs(tx, RUN_SUMMARIES, row.run_id, row.payload);
    tx.run("UPDATE run_summaries SET goal_ref=?, mission_ref=? WHERE run_id=?", refs.goalRef, refs.missionRef, row.run_id);
  }
}

function migrateVersion4(tx: EvidenceTx): void {
  tx.exec("ALTER TABLE outcomes ADD COLUMN point TEXT");
  tx.exec("ALTER TABLE outcomes ADD COLUMN feature_map_ref TEXT");
  tx.exec("ALTER TABLE outcomes ADD COLUMN owner_score INTEGER");
  tx.exec(
    "CREATE INDEX IF NOT EXISTS outcomes_by_route ON outcomes (source, role, point, provider, model, effort, ended_at, outcome_id)",
  );
  const bases = new Map<string, PointBase>();
  const stored: { outcomeId: string; featureMapRef: string; ownerScore: number | null }[] = [];
  for (const row of tx.all<{ outcome_id: string; run_id: string; source: string; role: string; attempt_index: number; payload: string }>(
    "SELECT outcome_id, run_id, source, role, attempt_index, payload FROM outcomes",
  )) {
    try {
      const payload = tx.open<OutcomePayload>(OUTCOMES, row.outcome_id, row.payload);
      bases.set(row.outcome_id, {
        runId: row.run_id,
        source: row.source,
        role: row.role,
        attemptIndex: row.attempt_index,
        replaces: payload.replaces,
      });
      stored.push({
        outcomeId: row.outcome_id,
        featureMapRef: tx.index("feature-map", payload.featureMap),
        ownerScore: payload.ownerRating?.score ?? null,
      });
    } catch {
      stored.push({ outcomeId: row.outcome_id, featureMapRef: UNREADABLE_REF, ownerScore: null });
    }
  }
  const pointOfOutcome = (outcomeId: string, depth: number): RoutingPointValue | null => {
    const base = bases.get(outcomeId);
    if (base === undefined || depth > POINT_CHAIN_LIMIT) return null;
    return pointOf(base, predecessor => pointOfOutcome(predecessor, depth + 1));
  };
  for (const row of stored) {
    tx.run(
      "UPDATE outcomes SET point=?, feature_map_ref=?, owner_score=? WHERE outcome_id=?",
      pointOfOutcome(row.outcomeId, 0),
      row.featureMapRef,
      row.ownerScore,
      row.outcomeId,
    );
  }
}

function outcomeListUsd(payload: Pick<OutcomePayload, "costCoverage" | "listUsd">): number | null {
  return payload.costCoverage === "complete" && typeof payload.listUsd === "number" && Number.isFinite(payload.listUsd) && payload.listUsd >= 0
    ? payload.listUsd
    : null;
}

function migrateVersion5(tx: EvidenceTx): void {
  tx.exec("ALTER TABLE outcomes ADD COLUMN list_usd REAL");
  for (const row of tx.all<{ outcome_id: string; payload: string }>("SELECT outcome_id, payload FROM outcomes")) {
    try {
      const listUsd = outcomeListUsd(tx.open<OutcomePayload>(OUTCOMES, row.outcome_id, row.payload));
      if (listUsd !== null) tx.run("UPDATE outcomes SET list_usd=? WHERE outcome_id=?", listUsd, row.outcome_id);
    } catch {
    }
  }
}

type RoutingPointValue = "start" | "escalation";
type PointBase = { runId: string; source: string; role: string; attemptIndex: number; replaces: Replaces };
type Replaces = OutcomePayload["replaces"];

function pointOf(base: PointBase, predecessorPoint: (outcomeId: string) => RoutingPointValue | null): RoutingPointValue | null {
  if (base.source === "legacy" || base.role !== "implementer" || base.attemptIndex === 0) return null;
  if (base.replaces === undefined) return "start";
  if (base.replaces.cause === "escalation") return "escalation";
  return predecessorPoint(`${base.runId}:${base.replaces.memberId}`);
}

function migrationRefs(tx: EvidenceTx, table: string, rowId: string, sealed: string): GoalMissionRefs {
  try {
    return refsOf(tx, tx.open<GoalMissionPayload>(table, rowId, sealed));
  } catch {
    return { goalRef: UNREADABLE_REF, missionRef: UNREADABLE_REF };
  }
}

type GoalMissionPayload = { goal?: { id: string }; missionId?: string };
type GoalMissionRefs = { goalRef: string | null; missionRef: string | null };

function refsOf(db: EvidenceDb, payload: GoalMissionPayload): GoalMissionRefs {
  return {
    goalRef: payload.goal === undefined ? null : db.index("goal", payload.goal.id),
    missionRef: payload.missionId === undefined ? null : db.index("mission", payload.missionId),
  };
}

export function readOutcome(db: EvidenceDb, outcomeId: string): OutcomeRow | undefined {
  const row = db.get<OutcomeSql>("SELECT * FROM outcomes WHERE outcome_id=?", outcomeId);
  return row === undefined ? undefined : toOutcome(db, row);
}

export function runOutcomes(db: EvidenceDb, runId: string): OutcomeRow[] {
  return db.all<OutcomeSql>("SELECT * FROM outcomes WHERE run_id=? ORDER BY outcome_id", runId)
    .map(row => toOutcome(db, row));
}

export type OutcomeFilter = { sources: readonly string[]; role: "implementer" | "scout"; projectRef?: string; since?: string };

export function selectOutcomes(db: EvidenceDb, filter: OutcomeFilter): { rows: OutcomeRow[]; unreadable: number } {
  if (filter.sources.length === 0) return { rows: [], unreadable: 0 };
  const params: string[] = [...filter.sources, filter.role];
  const clauses = [`source IN (${filter.sources.map(() => "?").join(", ")})`, "role = ?"];
  if (filter.projectRef !== undefined) {
    clauses.push("project_ref = ?");
    params.push(filter.projectRef);
  }
  if (filter.since !== undefined) {
    clauses.push("COALESCE(ended_at, started_at) >= ?");
    params.push(filter.since);
  }
  const sql = `SELECT * FROM outcomes WHERE ${clauses.join(" AND ")} ORDER BY outcome_id`;
  const rows: OutcomeRow[] = [];
  let unreadable = 0;
  for (const row of db.all<OutcomeSql>(sql, ...params)) {
    try {
      rows.push(toOutcome(db, row));
    } catch {
      unreadable += 1;
    }
  }
  return { rows, unreadable };
}

export const ROUTING_EVIDENCE_SQL = "SELECT o.outcome_id, o.source, o.project_ref, o.area_ref, o.provider, o.model, o.effort, "
  + "o.profile_epoch, o.kind, o.feature_version, o.disposition, o.exclusion, o.flags, o.integrated, o.accepted, "
  + "o.first_pass, o.held, o.ended_at, o.frozen_at, o.point, o.feature_map_ref, o.owner_score, o.list_usd, c.prompt_version "
  + "FROM outcomes o LEFT JOIN configurations c ON c.config_id = o.config_id "
  + "WHERE o.source = ? AND o.role = 'implementer' AND o.point = ? AND o.provider = ? AND o.model = ? AND o.effort IS ? "
  + "AND o.ended_at >= ? ORDER BY o.ended_at DESC, o.outcome_id DESC LIMIT ?";

export const SCOUT_EVIDENCE_SQL = "SELECT o.outcome_id, o.source, o.project_ref, o.area_ref, o.provider, o.model, o.effort, "
  + "o.profile_epoch, o.kind, o.feature_version, o.disposition, o.exclusion, o.flags, o.integrated, o.accepted, "
  + "o.first_pass, o.held, o.ended_at, o.frozen_at, o.point, o.feature_map_ref, o.owner_score, o.list_usd, c.prompt_version "
  + "FROM outcomes o LEFT JOIN configurations c ON c.config_id = o.config_id "
  + "WHERE o.source = ? AND o.role = 'scout' AND o.point IS NULL AND o.provider = ? AND o.model = ? AND o.effort IS ? "
  + "AND o.ended_at >= ? ORDER BY o.ended_at DESC, o.outcome_id DESC LIMIT ?";

const ROUTING_SOURCES = ["production", "duel"] as const;

export function selectRoutingEvidence(
  db: EvidenceDb,
  identity: Identity,
  point: RoutingPointValue,
  since: string,
): RoutingEvidenceRow[] {
  const rows: RoutingEvidenceRow[] = [];
  for (const source of ROUTING_SOURCES) {
    const found = db.all<RoutingSql>(
      ROUTING_EVIDENCE_SQL,
      source,
      point,
      identity.provider,
      identity.model,
      identity.effort,
      since,
      ROUTING_ROWS_PER_SOURCE,
    );
    for (const row of found) rows.push(toRoutingEvidence(row));
  }
  return rows.sort((a, b) => compareKeys(a.outcomeId, b.outcomeId));
}

export function selectScoutEvidence(db: EvidenceDb, identity: Identity, since: string): RoutingEvidenceRow[] {
  const rows: RoutingEvidenceRow[] = [];
  for (const source of ROUTING_SOURCES) {
    const found = db.all<RoutingSql>(SCOUT_EVIDENCE_SQL, source, identity.provider, identity.model, identity.effort, since, ROUTING_ROWS_PER_SOURCE);
    for (const row of found) rows.push({ ...toRoutingEvidence(row), point: "scout" });
  }
  return rows.sort((a, b) => compareKeys(a.outcomeId, b.outcomeId));
}

type RoutingSql = Pick<OutcomeSql, "outcome_id" | "source" | "project_ref" | "area_ref" | "provider" | "model" | "effort"
  | "profile_epoch" | "kind" | "feature_version" | "disposition" | "exclusion" | "integrated" | "accepted" | "first_pass" | "held"
  | "ended_at" | "frozen_at"> & { flags: string; point: RoutingPointValue; feature_map_ref: string | null; owner_score: number | null; list_usd: number | null; prompt_version: string | null };

function toRoutingEvidence(row: RoutingSql): RoutingEvidenceRow {
  return {
    outcomeId: row.outcome_id, source: row.source, projectRef: row.project_ref, areaRef: row.area_ref,
    provider: row.provider, model: row.model, effort: row.effort, profileEpoch: row.profile_epoch,
    kind: row.kind, featureVersion: row.feature_version, disposition: row.disposition, exclusion: row.exclusion,
    flags: splitFlags(row.flags), integrated: row.integrated, accepted: row.accepted, firstPass: row.first_pass,
    held: row.held, endedAt: row.ended_at, frozenAt: row.frozen_at, point: row.point,
    featureMapRef: row.feature_map_ref, ownerScore: row.owner_score, listUsd: row.list_usd, promptVersion: row.prompt_version,
  };
}

export function writeOutcome(tx: EvidenceTx, row: OutcomeRow): void {
  const payload = row.payload;
  const refs = refsOf(tx, payload);
  const routing = routingColumns(tx, row);
  tx.run(
    OUTCOME_UPSERT,
    row.outcomeId, row.source, tx.index("project", payload.projectId), tx.index("task", payload.taskId),
    row.runId, row.revision, row.memberId, row.sessionId, row.attemptIndex, row.inherited ? 1 : 0,
    row.role, row.profileId, row.provider, row.model, row.effort, row.profileEpoch, row.configId, row.experimentRef,
    tx.index("area", payload.area), row.kind, row.risk, row.featureVersion, row.disposition, row.exclusion,
    joinFlags(row.flags), row.integrated, row.accepted, row.acceptance === undefined ? row.accepted : row.acceptance,
    row.firstPass, row.held, row.startedAt, row.endedAt, row.frozenAt, row.holdUntil, row.runDeletedAt,
    tx.seal(OUTCOMES, row.outcomeId, payload), refs.goalRef, refs.missionRef,
    routing.point, routing.featureMapRef, routing.ownerScore, routing.listUsd,
  );
}

function routingColumns(tx: EvidenceTx, row: OutcomeRow): { point: RoutingPointValue | null; featureMapRef: string; ownerScore: number | null; listUsd: number | null } {
  const payload = row.payload;
  return {
    point: pointOf(
      { runId: row.runId, source: row.source, role: row.role, attemptIndex: row.attemptIndex, replaces: payload.replaces },
      outcomeId => tx.get<{ point: RoutingPointValue | null }>("SELECT point FROM outcomes WHERE outcome_id=?", outcomeId)?.point ?? null,
    ),
    featureMapRef: tx.index("feature-map", payload.featureMap),
    ownerScore: payload.ownerRating?.score ?? null,
    listUsd: outcomeListUsd(payload),
  };
}

export function readSummary(db: EvidenceDb, runId: string): RunSummaryRow | undefined {
  const row = db.get<SummarySql>("SELECT * FROM run_summaries WHERE run_id=?", runId);
  return row === undefined ? undefined : toSummary(db, row);
}

function toSummary(db: EvidenceDb, row: SummarySql): RunSummaryRow {
  return {
    runId: row.run_id,
    source: row.source,
    projectRef: row.project_ref,
    revision: row.revision,
    status: row.status,
    blockCode: row.block_code,
    flags: splitFlags(row.flags),
    createdAt: row.created_at,
    settledAt: row.settled_at,
    approvedAt: row.approved_at,
    runDeletedAt: row.run_deleted_at,
    payload: db.open<RunSummaryPayload>(RUN_SUMMARIES, row.run_id, row.payload),
  };
}

export function writeSummary(tx: EvidenceTx, row: RunSummaryRow): void {
  const refs = refsOf(tx, row.payload);
  tx.run(
    SUMMARY_UPSERT,
    row.runId,
    row.source,
    tx.index("project", row.payload.projectId),
    row.revision,
    row.status,
    row.blockCode,
    joinFlags(row.flags),
    row.createdAt,
    row.settledAt,
    row.approvedAt,
    row.runDeletedAt,
    tx.seal(RUN_SUMMARIES, row.runId, row.payload),
    refs.goalRef,
    refs.missionRef,
  );
}

export function readMemberResult(db: EvidenceDb, resultId: string): MemberResultRow | undefined {
  const row = db.get<MemberSql>("SELECT * FROM member_results WHERE result_id=?", resultId);
  return row === undefined ? undefined : toMember(db, row);
}

export function writeMemberResult(tx: EvidenceTx, row: MemberResultRow): void {
  tx.run(
    MEMBER_UPSERT,
    row.resultId,
    row.source,
    tx.index("project", row.payload.projectId),
    row.runId,
    row.revision,
    row.memberId,
    row.sessionId,
    row.role,
    row.profileId,
    row.provider,
    row.model,
    row.effort,
    row.profileEpoch,
    row.configId,
    row.reportKind,
    row.disposition,
    joinFlags(row.flags),
    row.startedAt,
    row.endedAt,
    row.runDeletedAt,
    tx.seal(MEMBER_RESULTS, row.resultId, row.payload),
  );
}

export function runOutcomeView(
  store: EvidenceStore,
  runId: string,
): { summary?: RunSummaryRow; rows: OutcomeRow[]; members: MemberResultRow[]; signals: SignalRow[]; unreadable: number } | undefined {
  return store.read(db => {
    const summary = readSummary(db, runId);
    const rows = runOutcomes(db, runId);
    const members = db.all<MemberSql>("SELECT * FROM member_results WHERE run_id=? ORDER BY result_id", runId)
      .map(row => toMember(db, row));
    const { signals, unreadable } = readSignalRows(db, "SELECT * FROM outcome_signals WHERE run_id=? ORDER BY at, signal_id", runId);
    if (summary === undefined && rows.length === 0 && members.length === 0 && signals.length === 0 && unreadable === 0) {
      return undefined;
    }
    return { summary, rows, members, signals, unreadable };
  });
}

export function sweepExpiredOutcomes(
  store: EvidenceStore,
  now: string,
  limit: number = DEFAULT_SWEEP_LIMIT,
  retentionDays: number = OUTCOME_RETENTION_DAYS,
): number {
  try {
    if (store.status().modules[OUTCOMES_MODULE] !== "ready") return 0;
    const cutoff = new Date(Date.parse(now) - retentionDays * DAY_MS).toISOString();
    const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_SWEEP_LIMIT;
    const removed = store.write(tx => {
      const runIds = tx.all<{ run_id: string }>(
        "SELECT run_id FROM ("
        + "SELECT run_id, run_deleted_at FROM outcomes UNION ALL "
        + "SELECT run_id, run_deleted_at FROM outcome_rounds UNION ALL "
        + "SELECT run_id, run_deleted_at FROM run_summaries UNION ALL "
        + "SELECT run_id, run_deleted_at FROM member_results) "
        + "GROUP BY run_id HAVING MIN(run_deleted_at) <= ? AND COUNT(run_deleted_at) = COUNT(*) "
        + "ORDER BY run_id LIMIT ?",
        cutoff,
        max,
      );
      for (const { run_id: runId } of runIds) {
        for (const table of [...RUN_TABLES, OUTCOME_ROUND_LINKS, BACKFILL_RUNS, OUTCOME_SIGNALS]) {
          tx.run(`DELETE FROM ${table} WHERE run_id=?`, runId);
        }
      }
      tx.run(
        "DELETE FROM legacy_lines WHERE line_ref IN "
        + "(SELECT line_ref FROM legacy_lines WHERE recorded_at<=? ORDER BY line_ref LIMIT ?)",
        cutoff,
        max,
      );
      return runIds.length;
    });
    if (removed > 0) console.log(`Outcome retention removed ${removed} run(s).`);
    return removed;
  } catch {
    console.warn("Outcome retention sweep failed.");
    return 0;
  }
}

export function rollupRecords(db: EvidenceDb, by: "goal" | "mission", ref: string): RollupRecords {
  const column = by === "goal" ? "goal_ref" : "mission_ref";
  const runIds = db.all<{ run_id: string }>(
    `SELECT run_id FROM run_summaries WHERE ${column}=? UNION SELECT run_id FROM outcomes WHERE ${column}=? ORDER BY run_id`,
    ref,
    ref,
  ).map(row => row.run_id);
  const records: RollupRecords = {
    runIds,
    summaries: [],
    rows: [],
    members: [],
    unreadable: { summaries: 0, rows: 0, members: 0 },
    unindexed: 0,
  };
  for (const keys of chunks(runIds)) {
    const marks = placeholders(keys.length);
    for (const row of db.all<SummarySql>(`SELECT * FROM run_summaries WHERE run_id IN (${marks})`, ...keys)) {
      try {
        records.summaries.push(toSummary(db, row));
      } catch {
        records.unreadable.summaries += 1;
      }
    }
    for (const row of db.all<OutcomeSql>(`SELECT * FROM outcomes WHERE run_id IN (${marks})`, ...keys)) {
      try {
        records.rows.push(toOutcome(db, row));
      } catch {
        records.unreadable.rows += 1;
      }
    }
    for (const row of db.all<MemberSql>(`SELECT * FROM member_results WHERE run_id IN (${marks})`, ...keys)) {
      try {
        records.members.push(toMember(db, row));
      } catch {
        records.unreadable.members += 1;
      }
    }
  }
  records.summaries.sort((a, b) => compareKeys(a.runId, b.runId));
  records.rows.sort((a, b) => compareKeys(a.outcomeId, b.outcomeId));
  records.members.sort((a, b) => compareKeys(a.resultId, b.resultId));
  records.unindexed = db.get<{ n: number }>(
    "SELECT (SELECT count(*) FROM outcomes WHERE goal_ref=?) + (SELECT count(*) FROM run_summaries WHERE goal_ref=?) AS n",
    UNREADABLE_REF,
    UNREADABLE_REF,
  )?.n ?? 0;
  return records;
}

export function readLegacyLines(db: EvidenceDb, refs: readonly string[]): Map<string, LegacyLineState> {
  const lines = new Map<string, LegacyLineState>();
  for (const keys of chunks(refs)) {
    const rows = db.all<LegacyLineSql>(`SELECT * FROM legacy_lines WHERE line_ref IN (${placeholders(keys.length)})`, ...keys);
    for (const row of rows) {
      let sealed: { lineHash: string | null };
      try {
        sealed = db.open<{ lineHash: string | null }>(LEGACY_LINES, row.line_ref, row.payload);
      } catch {
        throw new EvidenceError("unavailable", "A stored legacy line does not open.");
      }
      lines.set(row.line_ref, { state: row.state, lineHash: sealed.lineHash, recordedAt: row.recorded_at });
    }
  }
  return lines;
}

export function writeLegacyLine(tx: EvidenceTx, ref: string, state: LegacyLineState): void {
  tx.run(LEGACY_LINE_UPSERT, ref, state.state, state.recordedAt, tx.seal(LEGACY_LINES, ref, { lineHash: state.lineHash }));
}

export function legacyLineCount(db: EvidenceDb): number {
  return db.get<{ n: number }>("SELECT count(*) AS n FROM legacy_lines")?.n ?? 0;
}

export function outcomeSources(db: EvidenceDb, outcomeIds: readonly string[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const keys of chunks(outcomeIds)) {
    const rows = db.all<{ outcome_id: string; source: string }>(
      `SELECT outcome_id, source FROM outcomes WHERE outcome_id IN (${placeholders(keys.length)})`,
      ...keys,
    );
    for (const row of rows) sources.set(row.outcome_id, row.source);
  }
  return sources;
}

export function deleteLegacyOutcome(tx: EvidenceTx, outcomeId: string): boolean {
  return tx.run("DELETE FROM outcomes WHERE outcome_id=? AND source='legacy'", outcomeId).changes > 0;
}

type LegacyLineSql = { line_ref: string; state: LegacyLineState["state"]; recorded_at: string; payload: string };

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IN_CHUNK) out.push(items.slice(start, start + IN_CHUNK));
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toOutcome(db: EvidenceDb, row: OutcomeSql): OutcomeRow {
  return {
    outcomeId: row.outcome_id,
    source: row.source,
    projectRef: row.project_ref,
    taskRef: row.task_ref,
    areaRef: row.area_ref,
    runId: row.run_id,
    revision: row.revision,
    memberId: row.member_id,
    sessionId: row.session_id,
    attemptIndex: row.attempt_index,
    inherited: row.inherited === 1,
    role: row.role,
    profileId: row.profile_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    profileEpoch: row.profile_epoch,
    configId: row.config_id,
    experimentRef: row.experiment_ref,
    kind: row.kind,
    risk: row.risk,
    featureVersion: row.feature_version,
    disposition: row.disposition,
    exclusion: row.exclusion,
    flags: splitFlags(row.flags),
    integrated: row.integrated,
    accepted: row.accepted,
    acceptance: row.acceptance,
    firstPass: row.first_pass,
    held: row.held,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    frozenAt: row.frozen_at,
    holdUntil: row.hold_until,
    runDeletedAt: row.run_deleted_at,
    payload: db.open<OutcomePayload>(OUTCOMES, row.outcome_id, row.payload),
  };
}

function toMember(db: EvidenceDb, row: MemberSql): MemberResultRow {
  return {
    resultId: row.result_id,
    source: row.source,
    projectRef: row.project_ref,
    runId: row.run_id,
    revision: row.revision,
    memberId: row.member_id,
    sessionId: row.session_id,
    role: row.role,
    profileId: row.profile_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    profileEpoch: row.profile_epoch,
    configId: row.config_id,
    reportKind: row.report_kind,
    disposition: row.disposition,
    flags: splitFlags(row.flags),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    runDeletedAt: row.run_deleted_at,
    payload: db.open<MemberResultPayload>(MEMBER_RESULTS, row.result_id, row.payload),
  };
}

function addGap(tx: EvidenceTx, table: string, key: string, runId: string): void {
  const rows = tx.all<{ key: string; flags: string }>(`SELECT ${key} AS key, flags FROM ${table} WHERE run_id=?`, runId);
  for (const row of rows) {
    const flags = splitFlags(row.flags);
    if (flags.includes("gap")) continue;
    tx.run(`UPDATE ${table} SET flags=? WHERE ${key}=?`, joinFlags([...flags, "gap"]), row.key);
  }
}

function joinFlags(flags: readonly Flag[]): string {
  return [...flags].sort().join(",");
}

function splitFlags(text: string): Flag[] {
  return text === "" ? [] : (text.split(",") as Flag[]);
}

function upsertSql(table: string, key: string, columns: readonly string[]): string {
  const values = columns.map(() => "?").join(", ");
  const updates = columns.filter(column => column !== key).map(column => `${column}=excluded.${column}`).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values}) ON CONFLICT(${key}) DO UPDATE SET ${updates}`;
}

const LEGACY_LINE_UPSERT = upsertSql(LEGACY_LINES, "line_ref", ["line_ref", "state", "recorded_at", "payload"]);
const SIGNAL_UPSERT = upsertSql(OUTCOME_SIGNALS, "signal_id", [
  "signal_id", "run_id", "outcome_id", "kind", "author", "authority", "state", "at", "payload",
]);
const SCAN_UPSERT = "INSERT INTO base_scans (project_ref, seq, at, checked_at, commits, gap, payload) "
  + "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_ref, seq) DO UPDATE SET at=excluded.at, "
  + "checked_at=excluded.checked_at, commits=excluded.commits, gap=excluded.gap, payload=excluded.payload";
const SCAN_STATE_UPSERT = upsertSql(BASE_SCAN_STATE, "project_ref", ["project_ref", "seq", "payload"]);

type SignalSql = {
  signal_id: string;
  run_id: string;
  outcome_id: string | null;
  kind: SignalKind;
  author: SignalRow["author"];
  authority: SignalRow["authority"];
  state: SignalRow["state"];
  at: string;
  payload: string;
};

type ScanSql = {
  project_ref: string;
  seq: number;
  at: string;
  checked_at: string;
  commits: number;
  gap: ScanGap | null;
  payload: string;
};

type ScanStateSql = { project_ref: string; seq: number; payload: string };

export function readSignal(db: EvidenceDb, signalId: string): SignalRow | undefined {
  return readSignalRows(db, "SELECT * FROM outcome_signals WHERE signal_id=?", signalId).signals[0];
}

export function runSignals(db: EvidenceDb, runId: string): SignalRow[] {
  return readSignalRows(db, "SELECT * FROM outcome_signals WHERE run_id=? ORDER BY at, signal_id", runId).signals;
}

export function writeSignal(tx: EvidenceTx, row: SignalRow): void {
  tx.run(
    SIGNAL_UPSERT,
    row.signalId,
    row.runId,
    row.outcomeId,
    row.kind,
    row.author,
    row.authority,
    row.state,
    row.at,
    tx.seal(OUTCOME_SIGNALS, row.signalId, row.payload),
  );
}

export function projectLandings(db: EvidenceDb, projectRef: string, since: string): SignalRow[] {
  return readSignalRows(
    db,
    "SELECT outcome_signals.* FROM outcome_signals JOIN run_summaries ON run_summaries.run_id=outcome_signals.run_id "
    + "WHERE run_summaries.project_ref=? AND outcome_signals.kind='landing' AND outcome_signals.state='active' "
    + "AND outcome_signals.at>=? ORDER BY outcome_signals.at, outcome_signals.signal_id",
    projectRef,
    since,
  ).signals;
}

export function readScanState(db: EvidenceDb, projectRef: string): ScanState | undefined {
  const row = db.get<ScanStateSql>("SELECT * FROM base_scan_state WHERE project_ref=?", projectRef);
  if (row === undefined) return undefined;
  return {
    projectRef: row.project_ref,
    seq: row.seq,
    payload: db.open<ScanState["payload"]>(BASE_SCAN_STATE, row.project_ref, row.payload),
  };
}

export function lastScan(db: EvidenceDb, projectRef: string): ScanRow | undefined {
  const row = db.get<ScanSql>("SELECT * FROM base_scans WHERE project_ref=? ORDER BY seq DESC LIMIT 1", projectRef);
  return row === undefined ? undefined : toScan(db, row);
}

export function writeScan(tx: EvidenceTx, scan: ScanRow, state: ScanState): void {
  tx.run(
    SCAN_UPSERT,
    scan.projectRef,
    scan.seq,
    scan.at,
    scan.checkedAt,
    scan.commits,
    scan.gap,
    tx.seal(BASE_SCANS, scanRowId(scan.projectRef, scan.seq), scan.payload),
  );
  tx.run(SCAN_STATE_UPSERT, state.projectRef, state.seq, tx.seal(BASE_SCAN_STATE, state.projectRef, state.payload));
}

export function checkScan(tx: EvidenceTx, projectRef: string, seq: number, at: string): void {
  tx.run("UPDATE base_scans SET checked_at=MAX(checked_at, ?) WHERE project_ref=? AND seq=?", at, projectRef, seq);
}

export function scanPoints(
  db: EvidenceDb,
  projectRef: string,
  landingSeq: number,
  holdUntil: string,
): { last?: ScanPoint; next?: ScanPoint; gapInside: boolean } {
  const lastRow = db.get<ScanSql>(
    "SELECT * FROM base_scans WHERE project_ref=? AND seq>=? AND at<=? ORDER BY seq DESC LIMIT 1",
    projectRef,
    landingSeq,
    holdUntil,
  );
  if (lastRow === undefined) return { gapInside: false };
  const last = toScanPoint(lastRow);
  const nextRow = db.get<ScanSql>(
    "SELECT * FROM base_scans WHERE project_ref=? AND seq>? ORDER BY seq LIMIT 1",
    projectRef,
    last.seq,
  );
  const gaps = db.get<{ n: number }>(
    "SELECT count(*) AS n FROM base_scans WHERE project_ref=? AND seq>? AND seq<=? AND gap IS NOT NULL",
    projectRef,
    landingSeq,
    last.seq,
  );
  return {
    last,
    ...(nextRow === undefined ? {} : { next: toScanPoint(nextRow) }),
    gapInside: (gaps?.n ?? 0) > 0,
  };
}

export function landingCandidates(
  db: EvidenceDb,
  projectRef: string,
  approvedSince: string,
): { runId: string; payload: RunSummaryPayload }[] {
  const rows = db.all<{ run_id: string; payload: string }>(
    "SELECT run_id, payload FROM run_summaries WHERE project_ref=? AND approved_at>=? "
    + "AND NOT EXISTS (SELECT 1 FROM outcome_signals WHERE outcome_signals.run_id=run_summaries.run_id "
    + "AND outcome_signals.kind='landing' AND outcome_signals.state='active') ORDER BY run_id",
    projectRef,
    approvedSince,
  );
  const candidates: { runId: string; payload: RunSummaryPayload }[] = [];
  for (const row of rows) {
    try {
      candidates.push({ runId: row.run_id, payload: db.open<RunSummaryPayload>(RUN_SUMMARIES, row.run_id, row.payload) });
    } catch {
    }
  }
  return candidates;
}

function toSignal(db: EvidenceDb, row: SignalSql): SignalRow {
  return {
    signalId: row.signal_id,
    runId: row.run_id,
    outcomeId: row.outcome_id,
    kind: row.kind,
    author: row.author,
    authority: row.authority,
    state: row.state,
    at: row.at,
    payload: db.open<SignalPayload>(OUTCOME_SIGNALS, row.signal_id, row.payload),
  };
}

function readSignalRows(
  db: EvidenceDb,
  sql: string,
  ...params: string[]
): { signals: SignalRow[]; unreadable: number } {
  const signals: SignalRow[] = [];
  let unreadable = 0;
  for (const row of db.all<SignalSql>(sql, ...params)) {
    try {
      signals.push(toSignal(db, row));
    } catch {
      unreadable += 1;
    }
  }
  return { signals, unreadable };
}

function toScan(db: EvidenceDb, row: ScanSql): ScanRow {
  return {
    projectRef: row.project_ref,
    seq: row.seq,
    at: row.at,
    checkedAt: row.checked_at,
    commits: row.commits,
    gap: row.gap,
    payload: db.open<ScanRow["payload"]>(BASE_SCANS, scanRowId(row.project_ref, row.seq), row.payload),
  };
}

function toScanPoint(row: ScanSql): ScanPoint {
  return { seq: row.seq, at: row.at, checkedAt: row.checked_at, gap: row.gap };
}

function scanRowId(projectRef: string, seq: number): string {
  return `${projectRef}:${seq}`;
}

