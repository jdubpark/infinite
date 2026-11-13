import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "./evidence/types.js";
import type { Disposition, Exclusion, Flag, Level, RowState } from "./outcome-rules.js";
import type { ReplacementCause, RunSummaryCounts } from "./run-events.js";
import type { TeamTask } from "./team-types.js";

export const OUTCOMES_MODULE = "outcomes";
export const OUTCOME_RETENTION_DAYS = 730;

const OUTCOMES = "outcomes";
const OUTCOME_ROUNDS = "outcome_rounds";
const OUTCOME_ROUND_LINKS = "outcome_round_links";
const RUN_SUMMARIES = "run_summaries";
const MEMBER_RESULTS = "member_results";
const BACKFILL_RUNS = "backfill_runs";
const DAY_MS = 86_400_000;
const DEFAULT_SWEEP_LIMIT = 100;
const LAST_SEQ = "last_seq";
/** The four tables with a `run_deleted_at` column. The deletion stamp and the retention sweep both use them. */
const RUN_TABLES = [OUTCOMES, OUTCOME_ROUNDS, RUN_SUMMARIES, MEMBER_RESULTS] as const;

/** The kinds the projector reads. A run with an unseen event of one of these gains `gap`. */
export const OUTCOME_KINDS: readonly string[] = [
  "run.created", "run.prepared", "member.started", "member.configured", "member.reported", "member.stopped",
  "task.integrated", "scout.completed", "task.escalated", "review.recorded", "review.tree", "repair.started",
  "repair.integrated", "repair.paths", "delivery.recorded", "rating.recorded", "run.blocked",
  "run.revision-advanced", "run.settled", "run.deleted", "ledger.gap",
];

/** A member result's disposition. It is not a row disposition, because `reported` names a report, not an attempt. */
export type MemberResultDisposition = "open" | "reported" | "stalled" | "no-report" | "limit" | "owner-stop" | "host-stop";

/** Sealed in `outcomes.payload`. A row never holds an objective, instructions, a summary, a path, or a URL. */
export type OutcomePayload = {
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
  diff?: TeamTask["diffStat"];
  wallMs?: number;
  limitEvents: number;
  costCoverage: "none";
};

/** Sealed in `run_summaries.payload`. */
export type RunSummaryPayload = {
  projectId: string;
  goal?: { id: string; cycle: number };
  missionId?: string;
  counts?: RunSummaryCounts;
  attempts: Partial<Record<Disposition, number>>;
  rounds: { total: number; attributed: number; unattributed: number; unknown: number };
  currentBase?: string;
  reviewedHead?: string;
  reviewedTree?: string;
  mergeCommit?: string;
  deliveryMethod?: "merge" | "pull-request";
};

/** Sealed in `member_results.payload`. A member result has no task, so it carries no task id. */
export type MemberResultPayload = {
  projectId: string;
  replaces?: { memberId: string; cause: ReplacementCause };
};

/**
 * One attempt's row. `projectRef`, `taskRef`, and `areaRef` are blind indexes of the payload's values. `writeOutcome`
 * derives them from `payload`, so a caller's values for them are ignored. Reads return the stored values.
 */
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
  firstPass: Level;
  held: Level;
  startedAt: string | null;
  endedAt: string | null;
  frozenAt: string | null;
  holdUntil: string | null;
  runDeletedAt: string | null;
  payload: OutcomePayload;
};

/** One run's summary. `projectRef` is derived on write, as for `OutcomeRow`. */
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

/** One member that has no task. `projectRef` is derived on write, as for `OutcomeRow`. */
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

const OUTCOME_COLUMNS = [
  "outcome_id", "source", "project_ref", "task_ref", "run_id", "revision", "member_id", "session_id",
  "attempt_index", "inherited", "role", "profile_id", "provider", "model", "effort", "profile_epoch", "config_id",
  "experiment_ref", "area_ref", "kind", "risk", "feature_version", "disposition", "exclusion", "flags",
  "integrated", "accepted", "first_pass", "held", "started_at", "ended_at", "frozen_at", "hold_until",
  "run_deleted_at", "payload",
] as const;
const SUMMARY_COLUMNS = [
  "run_id", "source", "project_ref", "revision", "status", "block_code", "flags", "created_at", "settled_at",
  "approved_at", "run_deleted_at", "payload",
] as const;
const MEMBER_COLUMNS = [
  "result_id", "source", "project_ref", "run_id", "revision", "member_id", "session_id", "role", "profile_id",
  "provider", "model", "effort", "profile_epoch", "config_id", "report_kind", "disposition", "flags", "started_at",
  "ended_at", "run_deleted_at", "payload",
] as const;

const OUTCOME_UPSERT = upsertSql(OUTCOMES, "outcome_id", OUTCOME_COLUMNS);
const SUMMARY_UPSERT = upsertSql(RUN_SUMMARIES, "run_id", SUMMARY_COLUMNS);
const MEMBER_UPSERT = upsertSql(MEMBER_RESULTS, "result_id", MEMBER_COLUMNS);

/** The raw columns of `outcomes`. Plain columns hold ids, enumerations, numbers, and times. */
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
  first_pass: Level;
  held: Level;
  started_at: string | null;
  ended_at: string | null;
  frozen_at: string | null;
  hold_until: string | null;
  run_deleted_at: string | null;
  payload: string;
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

/**
 * The `outcomes` module (spec part 3). A `deleteRun` hook stamps and never removes, so a deleted run's rows stay
 * readable until the retention sweep. `now` stamps the deletion; it defaults to the wall clock.
 */
export function outcomeModule(options?: { now?: () => string }): EvidenceModule {
  const now = options?.now ?? (() => new Date().toISOString());
  return {
    name: OUTCOMES_MODULE,
    version: 1,
    readVersion: 1,
    migrate(tx) {
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
        outcomes: count("SELECT count(*) AS n FROM outcomes"),
        open: count("SELECT count(*) AS n FROM outcomes WHERE disposition='open'"),
        gap: count("SELECT count(*) AS n FROM outcomes WHERE (','||flags||',') LIKE '%,gap,%'"),
        backfilled: count("SELECT count(*) AS n FROM outcomes WHERE (','||flags||',') LIKE '%,backfilled,%'"),
        summaries: count("SELECT count(*) AS n FROM run_summaries"),
        memberResults: count("SELECT count(*) AS n FROM member_results"),
      };
    },
  };
}

export function readOutcome(db: EvidenceDb, outcomeId: string): OutcomeRow | undefined {
  const row = db.get<OutcomeSql>("SELECT * FROM outcomes WHERE outcome_id=?", outcomeId);
  return row === undefined ? undefined : toOutcome(db, row);
}

/** The rows of one run, in `outcome_id` order. */
export function runOutcomes(db: EvidenceDb, runId: string): OutcomeRow[] {
  return db.all<OutcomeSql>("SELECT * FROM outcomes WHERE run_id=? ORDER BY outcome_id", runId)
    .map(row => toOutcome(db, row));
}

/** Writes the whole row. The three blind-index fields are derived from `payload`, never taken from the caller. */
export function writeOutcome(tx: EvidenceTx, row: OutcomeRow): void {
  const payload = row.payload;
  tx.run(
    OUTCOME_UPSERT,
    row.outcomeId,
    row.source,
    tx.index("project", payload.projectId),
    tx.index("task", payload.taskId),
    row.runId,
    row.revision,
    row.memberId,
    row.sessionId,
    row.attemptIndex,
    row.inherited ? 1 : 0,
    row.role,
    row.profileId,
    row.provider,
    row.model,
    row.effort,
    row.profileEpoch,
    row.configId,
    row.experimentRef,
    tx.index("area", payload.area),
    row.kind,
    row.risk,
    row.featureVersion,
    row.disposition,
    row.exclusion,
    joinFlags(row.flags),
    row.integrated,
    row.accepted,
    row.firstPass,
    row.held,
    row.startedAt,
    row.endedAt,
    row.frozenAt,
    row.holdUntil,
    row.runDeletedAt,
    tx.seal(OUTCOMES, row.outcomeId, payload),
  );
}

export function readSummary(db: EvidenceDb, runId: string): RunSummaryRow | undefined {
  const row = db.get<SummarySql>("SELECT * FROM run_summaries WHERE run_id=?", runId);
  if (row === undefined) return undefined;
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

/** The summary, the rows, and the member results of one run. Undefined when the store holds none of them. */
export function runOutcomeView(
  store: EvidenceStore,
  runId: string,
): { summary?: RunSummaryRow; rows: OutcomeRow[]; members: MemberResultRow[] } | undefined {
  return store.read(db => {
    const summary = readSummary(db, runId);
    const rows = runOutcomes(db, runId);
    const members = db.all<MemberSql>("SELECT * FROM member_results WHERE run_id=? ORDER BY result_id", runId)
      .map(row => toMember(db, row));
    if (summary === undefined && rows.length === 0 && members.length === 0) return undefined;
    return { summary, rows, members };
  });
}

/**
 * Removes the rows of runs whose rows were stamped more than 730 days before `now`, at most `limit` runs per call.
 * A run with any unstamped row is kept. Never throws: it returns 0 when the store cannot take the write.
 */
export function sweepExpiredOutcomes(store: EvidenceStore, now: string, limit: number = DEFAULT_SWEEP_LIMIT): number {
  try {
    const cutoff = new Date(Date.parse(now) - OUTCOME_RETENTION_DAYS * DAY_MS).toISOString();
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
        for (const table of [...RUN_TABLES, OUTCOME_ROUND_LINKS, BACKFILL_RUNS]) {
          tx.run(`DELETE FROM ${table} WHERE run_id=?`, runId);
        }
      }
      return runIds.length;
    });
    if (removed > 0) console.log(`Outcome retention removed ${removed} run(s).`);
    return removed;
  } catch {
    console.warn("Outcome retention sweep failed.");
    return 0;
  }
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

/** Adds `gap` to each row of a run in one table. Rows that already hold it are left as they are. */
function addGap(tx: EvidenceTx, table: string, key: string, runId: string): void {
  const rows = tx.all<{ key: string; flags: string }>(`SELECT ${key} AS key, flags FROM ${table} WHERE run_id=?`, runId);
  for (const row of rows) {
    const flags = splitFlags(row.flags);
    if (flags.includes("gap")) continue;
    tx.run(`UPDATE ${table} SET flags=? WHERE ${key}=?`, joinFlags([...flags, "gap"]), row.key);
  }
}

/** The stored form of a flag set: sorted, comma-joined, and empty for none. */
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
