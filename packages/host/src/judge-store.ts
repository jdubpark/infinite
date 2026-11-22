import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "./evidence/types.js";
import { REPORT_KEEP_DAYS, type TrialCost } from "./eval-trial-store.js";
import { CALIBRATION_VALID_DAYS } from "./judge-calibration-rules.js";
import type { Judgement, JudgeEnding } from "./judge-types.js";

// The judge store: calibrations of a judge profile and the judgements that make them up. The sealed columns hold
// every task, trial, and profile ID. Nothing here is an outcome: a judgement is a model's claim (see PRODUCT.md).

export const JUDGE_MODULE = "judge-calibrations";
export const CALIBRATION_VIEWS_MAX = 20, JUDGE_SWEEP_BATCH = 100, JUDGEMENT_SWEEP_BATCH = 500, LIVE_JUDGEMENTS_MAX = 8;

const DAY_MS = 86_400_000;
const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * DAY_MS).toISOString();

export const SCHEMA_JUDGE_V1 = [
  `CREATE TABLE IF NOT EXISTS judge_calibrations (calibration_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, judge_key TEXT NOT NULL,
    profile_epoch INTEGER NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, state TEXT, pairs_planned INTEGER NOT NULL,
    pairs_counted INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, agree INTEGER NOT NULL DEFAULT 0, accuracy REAL,
    lower_bound REAL, swap_agreement REAL, judge_minutes INTEGER NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, spent_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, completed_at TEXT, valid_until TEXT, payload TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS judge_calibrations_status ON judge_calibrations (status, created_at)",
  "CREATE INDEX IF NOT EXISTS judge_calibrations_key ON judge_calibrations (judge_key, state, completed_at)",
  "CREATE INDEX IF NOT EXISTS judge_calibrations_created ON judge_calibrations (created_at)",
  `CREATE TABLE IF NOT EXISTS judge_judgements (judgement_id TEXT PRIMARY KEY, calibration_id TEXT NOT NULL, pair_index INTEGER NOT NULL,
    ordering INTEGER NOT NULL, attempt INTEGER NOT NULL, project_ref TEXT NOT NULL, state TEXT NOT NULL, ending TEXT, drop_reason TEXT,
    resolved_is_a INTEGER NOT NULL, preferred TEXT, session_id TEXT, tokens INTEGER, spent_usd REAL, cost TEXT, created_at TEXT NOT NULL,
    ended_at TEXT, rubric TEXT, UNIQUE (calibration_id, pair_index, ordering, attempt))`,
  "CREATE INDEX IF NOT EXISTS judge_judgements_state ON judge_judgements (state)",
  "CREATE INDEX IF NOT EXISTS judge_judgements_created ON judge_judgements (created_at)",
  "CREATE INDEX IF NOT EXISTS judge_judgements_sessions ON judge_judgements (ended_at) WHERE session_id IS NOT NULL",
];

const CALIBRATION_COLUMNS = "calibration_id, request_id, judge_key, profile_epoch, prompt_version, status, reason, state, pairs_planned, pairs_counted, "
  + "correct, agree, accuracy, lower_bound, swap_agreement, judge_minutes, tokens, spent_usd, created_at, expires_at, completed_at, valid_until, payload";
const JUDGEMENT_COLUMNS = "judgement_id, calibration_id, pair_index, ordering, attempt, project_ref, state, ending, drop_reason, resolved_is_a, "
  + "preferred, session_id, tokens, spent_usd, cost, created_at, ended_at, rubric";

export const IN_FORCE_SQL = "SELECT calibration_id, accuracy, lower_bound FROM judge_calibrations WHERE judge_key = ? AND state = 'ok' AND status = 'completed' "
  + "AND profile_epoch = ? AND prompt_version = ? AND valid_until > ? ORDER BY completed_at DESC, calibration_id LIMIT 1";
export const ACTIVE_CALIBRATION_SQL = `SELECT ${CALIBRATION_COLUMNS} FROM judge_calibrations WHERE status = 'running' ORDER BY created_at, calibration_id LIMIT 1`;
export const VIEWS_SQL = `SELECT ${CALIBRATION_COLUMNS} FROM judge_calibrations ORDER BY created_at DESC, calibration_id LIMIT ${CALIBRATION_VIEWS_MAX}`;
export const LIVE_JUDGEMENTS_SQL = "SELECT judgement_id, calibration_id, pair_index, ordering, attempt, state, session_id FROM judge_judgements "
  + `WHERE state IN ('preparing', 'live') ORDER BY state, created_at LIMIT ${LIVE_JUDGEMENTS_MAX}`;
export const CALIBRATION_JUDGEMENTS_SQL = `SELECT ${JUDGEMENT_COLUMNS} FROM judge_judgements WHERE calibration_id = ? ORDER BY pair_index, ordering, attempt`;
export const JUDGE_SESSIONS_SQL = "SELECT judgement_id, session_id, ended_at FROM judge_judgements WHERE session_id IS NOT NULL AND ended_at < ? ORDER BY ended_at LIMIT ?";

export type CalibrationStatus = "running" | "completed" | "cancelled" | "expired";
export type CalibrationState = "ok" | "not-ok";
export type CalibrationPairRef = { projectId: string; taskId: string; resolvedTrialId: string; unresolvedTrialId: string };
/** The sealed payload: the request (with the profile ID), the pair list, and the pair count of each project. */
export type CalibrationPayload = { profileId: string; request: Record<string, unknown>; pairs: CalibrationPairRef[];
  perProject: { projectId: string; pairs: number }[] };
export type CalibrationRow = { calibrationId: string; requestId: string; judgeKey: string; profileEpoch: number; promptVersion: string;
  status: CalibrationStatus; reason: string | null; state: CalibrationState | null; pairsPlanned: number; pairsCounted: number; correct: number;
  agree: number; accuracy: number | null; lowerBound: number | null; swapAgreement: number | null; judgeMinutes: number; tokens: number;
  spentUsd: number; createdAt: string; expiresAt: string; completedAt: string | null; validUntil: string | null; payload: CalibrationPayload };
export type NewCalibration = Pick<CalibrationRow, "calibrationId" | "requestId" | "judgeKey" | "profileEpoch" | "promptVersion" | "pairsPlanned"
  | "judgeMinutes" | "createdAt" | "expiresAt" | "payload">;
/** How a calibration ends. `state` is set for `completed` and null for `cancelled` and `expired`. */
export type CalibrationEnd = { status: Exclude<CalibrationStatus, "running">; reason: string | null; state: CalibrationState | null;
  counted: number; correct: number; agree: number; accuracy: number | null; lowerBound: number | null; swapAgreement: number | null };
export type CalibrationView = { calibrationId: string; profileId: string; profileEpoch: number; promptVersion: string;
  status: CalibrationRow["status"]; reason: string | null; state: "ok" | "not-ok" | null;
  pairs: { planned: number; counted: number; correct: number; perProject: { projectId: string; pairs: number }[] };
  accuracy: number | null; lowerBound: number | null; swapAgreement: number | null; judgeMinutes: number;
  cost: { tokens: number; spentUsd: number }; createdAt: string; expiresAt: string; completedAt: string | null;
  validUntil: string | null; inForce: boolean };

export type JudgementState = "preparing" | "live" | "final" | "dropped";
export type JudgementLabel = "A" | "B" | "tie";
export type JudgementRow = { judgementId: string; calibrationId: string; pairIndex: number; ordering: 0 | 1; attempt: number; projectRef: string;
  state: JudgementState; ending: JudgeEnding | null; dropReason: string | null; resolvedIsA: boolean; preferred: JudgementLabel | null;
  rubric: Judgement["rubric"] | null; sessionId: string | null; tokens: number | null; spentUsd: number | null; cost: TrialCost | null;
  createdAt: string; endedAt: string | null };
export type NewJudgement = Pick<JudgementRow, "judgementId" | "calibrationId" | "pairIndex" | "ordering" | "attempt" | "resolvedIsA"> & { projectId: string };
export type JudgementCost = { tokens: number; usd: number; complete: boolean } | "none";
export type JudgementFinal = { ending: JudgeEnding; judgement?: Judgement; sessionId: string | null };

type CalibrationSql = { calibration_id: string; request_id: string; judge_key: string; profile_epoch: number; prompt_version: string; status: CalibrationStatus;
  reason: string | null; state: CalibrationState | null; pairs_planned: number; pairs_counted: number; correct: number; agree: number; accuracy: number | null;
  lower_bound: number | null; swap_agreement: number | null; judge_minutes: number; tokens: number; spent_usd: number; created_at: string;
  expires_at: string; completed_at: string | null; valid_until: string | null; payload: string };
type JudgementSql = { judgement_id: string; calibration_id: string; pair_index: number; ordering: 0 | 1; attempt: number; project_ref: string;
  state: JudgementState; ending: JudgeEnding | null; drop_reason: string | null; resolved_is_a: number; preferred: JudgementLabel | null;
  session_id: string | null; tokens: number | null; spent_usd: number | null; cost: TrialCost | null; created_at: string; ended_at: string | null;
  rubric: string | null };

export function judgeCalibrationsModule(_store: EvidenceStore, _now: () => string): EvidenceModule {
  return {
    name: JUDGE_MODULE,
    version: 1,
    readVersion: 1,
    migrate(tx, from) {
      if (from === 0) {
        for (const statement of SCHEMA_JUDGE_V1) tx.exec(statement);
      }
    },
  };
}

/** Inserts a `running` calibration with its sealed payload. A repeated request ID, or calibration ID, writes nothing and answers `exists`. */
export function insertCalibration(tx: EvidenceTx, row: NewCalibration): "inserted" | "exists" {
  const changes = tx.run(
    "INSERT INTO judge_calibrations (calibration_id, request_id, judge_key, profile_epoch, prompt_version, status, pairs_planned, judge_minutes, "
    + "created_at, expires_at, payload) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    row.calibrationId, row.requestId, row.judgeKey, row.profileEpoch, row.promptVersion, row.pairsPlanned, row.judgeMinutes,
    row.createdAt, row.expiresAt, tx.seal("judge_calibrations", row.calibrationId, row.payload),
  ).changes;
  return changes === 1 ? "inserted" : "exists";
}

function calibrationOf(db: EvidenceDb, row: CalibrationSql): CalibrationRow {
  return {
    calibrationId: row.calibration_id, requestId: row.request_id, judgeKey: row.judge_key, profileEpoch: row.profile_epoch,
    promptVersion: row.prompt_version, status: row.status, reason: row.reason, state: row.state, pairsPlanned: row.pairs_planned,
    pairsCounted: row.pairs_counted, correct: row.correct, agree: row.agree, accuracy: row.accuracy, lowerBound: row.lower_bound,
    swapAgreement: row.swap_agreement, judgeMinutes: row.judge_minutes, tokens: row.tokens, spentUsd: row.spent_usd, createdAt: row.created_at,
    expiresAt: row.expires_at, completedAt: row.completed_at, validUntil: row.valid_until,
    payload: db.open<CalibrationPayload>("judge_calibrations", row.calibration_id, row.payload),
  };
}

export function readCalibration(db: EvidenceDb, id: string): CalibrationRow | undefined {
  const row = db.get<CalibrationSql>(`SELECT ${CALIBRATION_COLUMNS} FROM judge_calibrations WHERE calibration_id = ?`, id);
  return row === undefined ? undefined : calibrationOf(db, row);
}

/** The running calibration, oldest first. Task 8 allows at most one, so this is the one. */
export function activeCalibration(db: EvidenceDb): CalibrationRow | undefined {
  const row = db.get<CalibrationSql>(ACTIVE_CALIBRATION_SQL);
  return row === undefined ? undefined : calibrationOf(db, row);
}

/**
 * The newest completed `ok` calibration with this judge key, epoch, and prompt version whose validity has not ended
 * at `now`. A calibration is in force from its completion until `valid_until` (60 days later), exclusive.
 */
export function calibrationInForce(db: EvidenceDb, input: { judgeKey: string; epoch: number; promptVersion: string; now: string }):
  { calibrationId: string; accuracy: number; lowerBound: number } | undefined {
  const row = db.get<{ calibration_id: string; accuracy: number | null; lower_bound: number | null }>(
    IN_FORCE_SQL, input.judgeKey, input.epoch, input.promptVersion, input.now,
  );
  if (row === undefined || row.accuracy === null || row.lower_bound === null) return undefined;
  return { calibrationId: row.calibration_id, accuracy: row.accuracy, lowerBound: row.lower_bound };
}

/**
 * The newest CALIBRATION_VIEWS_MAX calibrations. `current` gives the judge's current epoch and prompt version for a
 * judge key, or undefined when the judge is gone; `inForce` is true only for the row `calibrationInForce` returns.
 */
export function calibrationViews(db: EvidenceDb, now: string,
  current: (judgeKey: string) => { epoch: number; promptVersion: string } | undefined): CalibrationView[] {
  return db.all<CalibrationSql>(VIEWS_SQL).map(sql => {
    const row = calibrationOf(db, sql);
    const live = current(row.judgeKey);
    const found = live === undefined ? undefined : calibrationInForce(db, { judgeKey: row.judgeKey, epoch: live.epoch, promptVersion: live.promptVersion, now });
    return {
      calibrationId: row.calibrationId, profileId: row.payload.profileId, profileEpoch: row.profileEpoch, promptVersion: row.promptVersion,
      status: row.status, reason: row.reason, state: row.state,
      pairs: { planned: row.pairsPlanned, counted: row.pairsCounted, correct: row.correct, perProject: row.payload.perProject },
      accuracy: row.accuracy, lowerBound: row.lowerBound, swapAgreement: row.swapAgreement, judgeMinutes: row.judgeMinutes,
      cost: { tokens: row.tokens, spentUsd: row.spentUsd }, createdAt: row.createdAt, expiresAt: row.expiresAt,
      completedAt: row.completedAt, validUntil: row.validUntil, inForce: found?.calibrationId === row.calibrationId,
    };
  });
}

/**
 * Ends a running calibration, once. `at` is stored as `completed_at` for every ending; only a `completed` calibration
 * gets `valid_until` (`at` plus 60 days). A calibration that is not running writes nothing and answers false.
 */
export function finishCalibration(tx: EvidenceTx, id: string, end: CalibrationEnd, at: string): boolean {
  const validUntil = end.status === "completed" ? addDays(at, CALIBRATION_VALID_DAYS) : null;
  return tx.run(
    "UPDATE judge_calibrations SET status=?, reason=?, state=?, pairs_counted=?, correct=?, agree=?, accuracy=?, lower_bound=?, swap_agreement=?, "
    + "completed_at=?, valid_until=? WHERE calibration_id=? AND status='running'",
    end.status, end.reason, end.state, end.counted, end.correct, end.agree, end.accuracy, end.lowerBound, end.swapAgreement, at, validUntil, id,
  ).changes === 1;
}

/**
 * Inserts a `preparing` judgement row for one (calibration, pair index, ordering, attempt). The unique key makes a
 * second insert of the same slot, or of the same judgement ID, write nothing and answer `exists`.
 */
export function insertJudgement(tx: EvidenceTx, row: NewJudgement, at: string): "inserted" | "exists" {
  const changes = tx.run(
    "INSERT INTO judge_judgements (judgement_id, calibration_id, pair_index, ordering, attempt, project_ref, state, resolved_is_a, created_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?) ON CONFLICT DO NOTHING",
    row.judgementId, row.calibrationId, row.pairIndex, row.ordering, row.attempt, tx.index("project", row.projectId), row.resolvedIsA ? 1 : 0, at,
  ).changes;
  return changes === 1 ? "inserted" : "exists";
}

/** Moves a `preparing` judgement to `live` and records its session ID (null when the launch made none). Answers false for any other state. */
export function startJudgement(tx: EvidenceTx, judgementId: string, sessionId: string | null): boolean {
  return tx.run("UPDATE judge_judgements SET state='live', session_id=? WHERE judgement_id=? AND state='preparing'", sessionId, judgementId).changes === 1;
}

function addCost(tx: EvidenceTx, judgementId: string, cost: JudgementCost): void {
  const row = tx.get<{ calibration_id: string; cost: string | null }>("SELECT calibration_id, cost FROM judge_judgements WHERE judgement_id=?", judgementId);
  if (row === undefined || row.cost !== null) return;
  if (cost === "none") {
    tx.run("UPDATE judge_judgements SET tokens=NULL, spent_usd=NULL, cost='none' WHERE judgement_id=?", judgementId);
    return;
  }
  tx.run("UPDATE judge_judgements SET tokens=?, spent_usd=?, cost=? WHERE judgement_id=?", cost.tokens, cost.usd, cost.complete ? "complete" : "partial", judgementId);
  tx.run("UPDATE judge_calibrations SET tokens = tokens + ?, spent_usd = spent_usd + ? WHERE calibration_id=?", cost.tokens, cost.usd, row.calibration_id);
}

/**
 * Ends a `preparing` or `live` judgement, once. It stores the ending, the preferred label and sealed rubric of an
 * accepted judgement, and the session ID (kept until `clearJudgementSession`, which records the cost). A judgement
 * that is already final or dropped writes nothing and answers false.
 */
export function finishJudgement(tx: EvidenceTx, judgementId: string, final: JudgementFinal, at: string): boolean {
  const rubric = final.judgement === undefined ? null : tx.seal("judge_judgements", judgementId, final.judgement.rubric);
  const changes = tx.run(
    "UPDATE judge_judgements SET state='final', ending=?, preferred=?, rubric=?, session_id=?, ended_at=? WHERE judgement_id=? AND state IN ('preparing', 'live')",
    final.ending, final.judgement?.preferred ?? null, rubric, final.sessionId, at, judgementId,
  ).changes;
  return changes === 1;
}

/** Ends a `preparing` or `live` judgement as dropped, with a reason. A dropped pair stays a row, so the slot is never selected again. */
export function dropJudgement(tx: EvidenceTx, judgementId: string, reason: string, at: string): boolean {
  return tx.run("UPDATE judge_judgements SET state='dropped', drop_reason=?, ended_at=? WHERE judgement_id=? AND state IN ('preparing', 'live')",
    reason, at, judgementId).changes === 1;
}

/** Clears the session ID. With a cost it records it, once, and a known cost joins the calibration's totals; a cost already stored is kept. */
export function clearJudgementSession(tx: EvidenceTx, judgementId: string, cost?: JudgementCost): void {
  if (cost !== undefined) addCost(tx, judgementId, cost);
  tx.run("UPDATE judge_judgements SET session_id=NULL WHERE judgement_id=?", judgementId);
}

/** Judgements that are `preparing` or `live`, at most LIVE_JUDGEMENTS_MAX. */
export function liveJudgements(db: EvidenceDb): { judgementId: string; calibrationId: string; pairIndex: number; ordering: 0 | 1; attempt: number;
  state: "preparing" | "live"; sessionId: string | null }[] {
  return db.all<{ judgement_id: string; calibration_id: string; pair_index: number; ordering: 0 | 1; attempt: number; state: "preparing" | "live";
    session_id: string | null }>(LIVE_JUDGEMENTS_SQL).map(row => ({ judgementId: row.judgement_id, calibrationId: row.calibration_id,
    pairIndex: row.pair_index, ordering: row.ordering, attempt: row.attempt, state: row.state, sessionId: row.session_id }));
}

/** Every judgement row of one calibration, in pair, ordering, and attempt order, rubrics opened. At most 2 x 60 x 3 rows. */
export function calibrationJudgements(db: EvidenceDb, calibrationId: string): JudgementRow[] {
  return db.all<JudgementSql>(CALIBRATION_JUDGEMENTS_SQL, calibrationId).map(row => ({
    judgementId: row.judgement_id, calibrationId: row.calibration_id, pairIndex: row.pair_index, ordering: row.ordering, attempt: row.attempt,
    projectRef: row.project_ref, state: row.state, ending: row.ending, dropReason: row.drop_reason, resolvedIsA: row.resolved_is_a === 1,
    preferred: row.preferred, rubric: row.rubric === null ? null : db.open<Judgement["rubric"]>("judge_judgements", row.judgement_id, row.rubric),
    sessionId: row.session_id, tokens: row.tokens, spentUsd: row.spent_usd, cost: row.cost, createdAt: row.created_at, endedAt: row.ended_at,
  }));
}

/** Judgements whose session was not yet removed and ended before `endedBefore`, oldest first. */
export function judgeSessions(db: EvidenceDb, endedBefore: string, limit: number): { judgementId: string; sessionId: string; endedAt: string }[] {
  return db.all<{ judgement_id: string; session_id: string; ended_at: string }>(JUDGE_SESSIONS_SQL, endedBefore, limit)
    .map(row => ({ judgementId: row.judgement_id, sessionId: row.session_id, endedAt: row.ended_at }));
}

/** Deletes judgements, then calibrations, created more than REPORT_KEEP_DAYS before `now`, in bounded batches. */
export function sweepJudge(tx: EvidenceTx, now: string): void {
  const cutoff = addDays(now, -REPORT_KEEP_DAYS);
  tx.run("DELETE FROM judge_judgements WHERE judgement_id IN (SELECT judgement_id FROM judge_judgements WHERE created_at < ? ORDER BY created_at LIMIT ?)",
    cutoff, JUDGEMENT_SWEEP_BATCH);
  tx.run("DELETE FROM judge_calibrations WHERE calibration_id IN (SELECT calibration_id FROM judge_calibrations WHERE created_at < ? ORDER BY created_at LIMIT ?)",
    cutoff, JUDGE_SWEEP_BATCH);
}
