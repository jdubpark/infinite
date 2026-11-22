import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceModule, type EvidenceTx } from "./evidence/types.js";
import { configRef, TRIAL_HARNESS_VERSION, trialPromptVersion, type SlotRow } from "./eval-trial-rules.js";
import { VOID_ENDINGS, type TrialConfiguration, type TrialEnding, type TrialGrade, type TrialState } from "./eval-types.js";

// The trial store: one row per trial, its sealed payload, its patch, and one counts row per replay job.

export const EVAL_TRIALS_MODULE = "eval-trials", TRIAL_KEEP_DAYS_DEFAULT = 365, TRIAL_PATCH_KEEP_DAYS = 90,
  TRIAL_PATCH_MAX_BYTES = 1_048_576, TRIAL_PATCHES_HOST_MAX_BYTES = 268_435_456, TRIAL_SWEEP_BATCH = 100, LIVE_TRIALS_MAX = 8;

export const REUSE_DAYS = 30, REPORT_KEEP_DAYS = 365, JOB_ROWS_MAX = 5_000;

const TRIAL_COUNTS_IDS_MAX = 100;
const DAY_MS = 86_400_000;

export const SCHEMA_TRIALS_V1 = [
  `CREATE TABLE IF NOT EXISTS eval_trials (trial_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, task_id TEXT NOT NULL, project_ref TEXT NOT NULL,
    config_ref TEXT NOT NULL, config_id TEXT, profile_epoch INTEGER, harness INTEGER NOT NULL, slot INTEGER NOT NULL, attempt INTEGER NOT NULL,
    state TEXT NOT NULL, ending TEXT, resolved INTEGER, isolation TEXT, session_id TEXT, created_at TEXT NOT NULL, started_at TEXT,
    ended_at TEXT, expires_at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE (job_id, task_id, config_ref, slot, attempt))`,
  "CREATE INDEX IF NOT EXISTS eval_trials_job ON eval_trials (job_id, task_id, config_ref, slot, attempt)",
  "CREATE INDEX IF NOT EXISTS eval_trials_live ON eval_trials (state, created_at) WHERE state != 'final'",
  "CREATE INDEX IF NOT EXISTS eval_trials_project_day ON eval_trials (project_ref, created_at)",
  "CREATE INDEX IF NOT EXISTS eval_trials_expiry ON eval_trials (expires_at)",
  "CREATE INDEX IF NOT EXISTS eval_trials_sessions ON eval_trials (ended_at) WHERE session_id IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS eval_trial_counts (job_id TEXT PRIMARY KEY, planned_tasks INTEGER NOT NULL, planned_trials INTEGER NOT NULL,
    tasks INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL DEFAULT 0, graded INTEGER NOT NULL DEFAULT 0,
    resolved INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0, voided INTEGER NOT NULL DEFAULT 0, void_streak INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS eval_trial_patches (trial_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, stored_at TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS eval_trial_patches_expiry ON eval_trial_patches (expires_at)",
  "CREATE TABLE IF NOT EXISTS eval_trial_totals (id INTEGER PRIMARY KEY CHECK (id = 1), patch_bytes INTEGER NOT NULL)",
];
export const SCHEMA_TRIALS_V2 = [
  "ALTER TABLE eval_trials ADD COLUMN prompt_version TEXT",
  "ALTER TABLE eval_trials ADD COLUMN reused_from TEXT",
  "ALTER TABLE eval_trials ADD COLUMN tokens INTEGER",
  "ALTER TABLE eval_trials ADD COLUMN spent_usd REAL",
  "ALTER TABLE eval_trials ADD COLUMN cost TEXT",
  "ALTER TABLE eval_trial_counts ADD COLUMN reused INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS eval_trials_reuse ON eval_trials (task_id, config_ref, ended_at) WHERE state = 'final' AND reused_from IS NULL",
  "CREATE INDEX IF NOT EXISTS eval_trials_graded ON eval_trials (project_ref, task_id, resolved, ended_at) WHERE ending = 'graded' AND reused_from IS NULL",
  `CREATE TABLE IF NOT EXISTS eval_reports (job_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    generated_at TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS eval_reports_expiry ON eval_reports (expires_at)",
  `CREATE TABLE IF NOT EXISTS eval_subjects (project_ref TEXT NOT NULL, subject TEXT NOT NULL, job_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (project_ref, subject))`,
  `CREATE TABLE IF NOT EXISTS eval_priors (prior_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, project_ref TEXT NOT NULL, configuration INTEGER NOT NULL,
    profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, effort TEXT, profile_epoch INTEGER NOT NULL, prompt_version TEXT NOT NULL,
    area_ref TEXT, kind TEXT, prompt_origin TEXT NOT NULL, tasks INTEGER NOT NULL, trials INTEGER NOT NULL, resolved INTEGER NOT NULL,
    generated_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS eval_priors_project ON eval_priors (project_ref, generated_at)",
  "CREATE INDEX IF NOT EXISTS eval_priors_expiry ON eval_priors (expires_at)",
];
export const LIVE_TRIALS_SQL = "SELECT trial_id, job_id, task_id, state FROM eval_trials WHERE state != 'final' ORDER BY state, created_at LIMIT 8";
export const JOB_SLOTS_SQL = "SELECT task_id, config_ref, slot, attempt, state, ending FROM eval_trials WHERE job_id = ? AND task_id = ?";
export const JOB_TRIALS_SQL = "SELECT count(*) AS n FROM eval_trials WHERE job_id = ? AND reused_from IS NULL";
export const PROJECT_DAY_SQL = "SELECT count(*) AS n FROM eval_trials WHERE project_ref = ? AND created_at >= ? AND reused_from IS NULL";
export const TRIALS_EXPIRED_SQL = "SELECT trial_id FROM eval_trials WHERE expires_at < ? ORDER BY expires_at LIMIT ?";
export const PATCHES_EXPIRED_SQL = "SELECT trial_id, bytes FROM eval_trial_patches WHERE expires_at < ? ORDER BY expires_at LIMIT ?";
export const TRIAL_SESSIONS_SQL = "SELECT trial_id, session_id, ended_at FROM eval_trials WHERE session_id IS NOT NULL AND ended_at < ? ORDER BY ended_at LIMIT ?";
export const REUSE_SQL = "SELECT t.trial_id, t.ending, t.resolved, t.isolation, t.config_id, t.profile_epoch, t.tokens, t.spent_usd, t.cost, "
  + "t.started_at, t.ended_at FROM eval_trials t JOIN eval_jobs j ON j.job_id = t.job_id WHERE t.task_id = ? AND t.config_ref = ? "
  + "AND t.state = 'final' AND t.reused_from IS NULL AND t.ended_at >= ? AND t.harness = ? AND t.prompt_version = ? AND t.profile_epoch = ? "
  + "AND t.ending NOT IN ('void-limit', 'void-host', 'void-owner') AND j.kind IN ('baseline', 'compare') ORDER BY t.ended_at DESC, t.trial_id LIMIT ?";
export const JOB_ROWS_SQL = "SELECT task_id, config_ref, slot, attempt, state, ending, resolved, isolation, config_id, profile_epoch, prompt_version, "
  + "tokens, spent_usd, cost, started_at, ended_at, reused_from FROM eval_trials WHERE job_id = ? LIMIT 5001";

export type TrialCost = "complete" | "partial" | "none";
export type ReuseSource = { trialId: string; ending: TrialEnding; resolved: boolean; isolation: "isolated" | "none"; configId: string | null;
  profileEpoch: number; tokens: number | null; spentUsd: number | null; cost: TrialCost | null; startedAt: string | null; endedAt: string };
export type JobTrialRow = { taskId: string; configRef: string; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null;
  resolved: boolean | null; isolation: "isolated" | "none" | null; configId: string | null; profileEpoch: number | null;
  promptVersion: string | null; tokens: number | null; spentUsd: number | null; cost: TrialCost | null;
  startedAt: string | null; endedAt: string | null; reused: boolean };

export type TrialPayload = { projectId: string; taskId: string; configuration: TrialConfiguration;
  probes?: { fetch: "refused" | "open" | "skipped"; sourceClean: boolean }; grade?: TrialGrade;
  patch?: "stored" | "too-large" | "secret-shaped" | "dropped" };
export type TrialRow = { trialId: string; jobId: string; taskId: string; projectRef: string; configRef: string; configId: string | null;
  profileEpoch: number | null; harness: number; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null;
  resolved: boolean | null; isolation: "isolated" | "none" | null; createdAt: string; startedAt: string | null; endedAt: string | null; payload: TrialPayload };
export type NewTrial = Pick<TrialRow, "trialId" | "jobId" | "taskId" | "configRef" | "harness" | "slot" | "attempt"> &
  { projectId: string; configuration: TrialConfiguration; keepDays: number };
export type TrialFinal = { grade: TrialGrade; configId: string | null; profileEpoch: number | null; sessionId: string | null;
  probes?: TrialPayload["probes"]; patch?: Buffer | "too-large" | "secret-shaped"; patchKeepDays: number };
export type TrialCounts = { plannedTasks: number; plannedTrials: number; tasks: number; skipped: number;
  started: number; graded: number; resolved: number; ended: number; void: number; voidStreak: number; reused: number };

type TrialSqlRow = { trial_id: string; job_id: string; task_id: string; project_ref: string; config_ref: string; config_id: string | null;
  profile_epoch: number | null; harness: number; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null;
  resolved: number | null; isolation: "isolated" | "none" | null; created_at: string; started_at: string | null; ended_at: string | null; payload: string };

const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * DAY_MS).toISOString();

export function evalTrialsModule(_store: EvidenceStore, _now: () => string): EvidenceModule {
  return {
    name: EVAL_TRIALS_MODULE,
    version: 2,
    readVersion: 2,
    migrate(tx, from) {
      if (from === 0) {
        for (const statement of SCHEMA_TRIALS_V1) tx.exec(statement);
        tx.run("INSERT OR IGNORE INTO eval_trial_totals (id, patch_bytes) VALUES (1, 0)");
      }
      if (from < 2) {
        for (const statement of SCHEMA_TRIALS_V2) tx.exec(statement);
      }
    },
  };
}

export function openTrialCounts(tx: EvidenceTx, jobId: string, planned: { tasks: number; trials: number }): void {
  tx.run("INSERT INTO eval_trial_counts (job_id, planned_tasks, planned_trials) VALUES (?, ?, ?) ON CONFLICT(job_id) DO NOTHING",
    jobId, planned.tasks, planned.trials);
}

/** Inserts a `preparing` row. The unique slot key makes a second insert of the same trial, or of the same attempt, `exists`. */
export function insertTrial(tx: EvidenceTx, trial: NewTrial, at: string): "inserted" | "exists" {
  const payload: TrialPayload = { projectId: trial.projectId, taskId: trial.taskId, configuration: trial.configuration };
  const changes = tx.run(
    "INSERT INTO eval_trials (trial_id, job_id, task_id, project_ref, config_ref, config_id, profile_epoch, harness, slot, attempt, "
    + "state, ending, resolved, isolation, session_id, created_at, started_at, ended_at, expires_at, payload, prompt_version) "
    + "VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'preparing', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?) ON CONFLICT DO NOTHING",
    trial.trialId, trial.jobId, trial.taskId, tx.index("project", trial.projectId), configRef(trial.configuration), trial.harness,
    trial.slot, trial.attempt, at, addDays(at, trial.keepDays), tx.seal("eval_trials", trial.trialId, payload),
    trialPromptVersion(trial.configuration.profile),
  ).changes;
  return changes === 1 ? "inserted" : "exists";
}

/** Removes a trial that never started. A running or graded trial is never dropped. */
export function dropTrial(tx: EvidenceTx, trialId: string): boolean {
  return tx.run("DELETE FROM eval_trials WHERE trial_id=? AND state='preparing'", trialId).changes === 1;
}

export function startTrial(tx: EvidenceTx, trialId: string, at: string): boolean {
  const changes = tx.run("UPDATE eval_trials SET state='running', started_at=? WHERE trial_id=? AND state='preparing'", at, trialId).changes;
  if (changes === 0) return false;
  tx.run("UPDATE eval_trial_counts SET started = started + 1 WHERE job_id = (SELECT job_id FROM eval_trials WHERE trial_id=?)", trialId);
  return true;
}

/** Moves a running trial to grading. The schema has no grading timestamp, so `at` is not stored. */
export function gradingTrial(tx: EvidenceTx, trialId: string, _at: string): boolean {
  return tx.run("UPDATE eval_trials SET state='grading' WHERE trial_id=? AND state='running'", trialId).changes === 1;
}

/**
 * Ends a running or grading trial, once. The grade and probes go into the sealed payload, the patch is stored when
 * its caps allow, and the counts move in the same transaction. A second call writes nothing and answers false.
 */
export function finishTrial(tx: EvidenceTx, trialId: string, final: TrialFinal, at: string): boolean {
  const row = tx.get<{ job_id: string; state: TrialState; payload: string }>("SELECT job_id, state, payload FROM eval_trials WHERE trial_id=?", trialId);
  if (row === undefined || (row.state !== "running" && row.state !== "grading")) return false;
  const payload = tx.open<TrialPayload>("eval_trials", trialId, row.payload);
  const patch = storePatch(tx, trialId, final, at);
  const next: TrialPayload = { ...payload, grade: final.grade };
  if (final.probes) next.probes = final.probes;
  if (patch) next.patch = patch;
  const ending = final.grade.ending;
  const graded = ending === "graded";
  const voided = VOID_ENDINGS.includes(ending);
  tx.run(
    "UPDATE eval_trials SET state='final', ending=?, resolved=?, isolation=?, config_id=?, profile_epoch=?, session_id=?, ended_at=?, payload=? "
    + "WHERE trial_id=? AND state IN ('running', 'grading')",
    ending, final.grade.resolved ? 1 : 0, final.grade.isolation, final.configId, final.profileEpoch, final.sessionId, at,
    tx.seal("eval_trials", trialId, next), trialId,
  );
  tx.run(
    "UPDATE eval_trial_counts SET graded = graded + ?, resolved = resolved + ?, ended = ended + ?, voided = voided + ?, "
    + "void_streak = CASE WHEN ? THEN void_streak + 1 ELSE 0 END WHERE job_id = ?",
    graded ? 1 : 0, final.grade.resolved ? 1 : 0, !graded && !voided ? 1 : 0, voided ? 1 : 0, voided ? 1 : 0, row.job_id,
  );
  return true;
}

/** Stores the patch when its caps allow, and returns what the payload should say. A dropped patch leaves the total unchanged. */
function storePatch(tx: EvidenceTx, trialId: string, final: TrialFinal, at: string): TrialPayload["patch"] {
  const patch = final.patch;
  if (patch === undefined) return undefined;
  if (patch === "too-large" || patch === "secret-shaped") return patch;
  if (patch.length > TRIAL_PATCH_MAX_BYTES) return "too-large";
  const total = tx.get<{ patch_bytes: number }>("SELECT patch_bytes FROM eval_trial_totals WHERE id=1")?.patch_bytes ?? 0;
  if (total + patch.length > TRIAL_PATCHES_HOST_MAX_BYTES) return "dropped";
  tx.run("INSERT INTO eval_trial_patches (trial_id, bytes, stored_at, expires_at, payload) VALUES (?, ?, ?, ?, ?)",
    trialId, patch.length, at, addDays(at, final.patchKeepDays), tx.seal("eval_trial_patches", trialId, { patch: patch.toString("base64") }));
  tx.run("UPDATE eval_trial_totals SET patch_bytes = patch_bytes + ? WHERE id=1", patch.length);
  return "stored";
}

/** Advances the task count of a job, and the skipped count too when the task was skipped. */
export function advanceTask(tx: EvidenceTx, jobId: string, skipped: boolean): void {
  tx.run("UPDATE eval_trial_counts SET tasks = tasks + 1, skipped = skipped + ? WHERE job_id=?", skipped ? 1 : 0, jobId);
}

/** Clears the session id. With a cost it also records the session's tokens and cost; `"none"` records that the ledger had none. */
export function clearTrialSession(tx: EvidenceTx, trialId: string, cost?: { tokens: number; usd: number; complete: boolean } | "none"): void {
  if (cost === undefined) {
    tx.run("UPDATE eval_trials SET session_id=NULL WHERE trial_id=?", trialId);
    return;
  }
  if (cost === "none") {
    tx.run("UPDATE eval_trials SET session_id=NULL, tokens=NULL, spent_usd=NULL, cost='none' WHERE trial_id=?", trialId);
    return;
  }
  tx.run("UPDATE eval_trials SET session_id=NULL, tokens=?, spent_usd=?, cost=? WHERE trial_id=?",
    cost.tokens, cost.usd, cost.complete ? "complete" : "partial", trialId);
}

/** Final, non-void original trials of baseline and compare jobs that a new compare job may copy, newest first. */
export function reusable(db: EvidenceDb, input: { taskId: string; configRef: string; promptVersion: string; profileEpoch: number;
  harness: number; since: string; limit: number }): ReuseSource[] {
  return db.all<{ trial_id: string; ending: TrialEnding; resolved: number | null; isolation: "isolated" | "none" | null; config_id: string | null;
    profile_epoch: number; tokens: number | null; spent_usd: number | null; cost: TrialCost | null; started_at: string | null; ended_at: string }>(
    REUSE_SQL, input.taskId, input.configRef, input.since, input.harness, input.promptVersion, input.profileEpoch, input.limit,
  ).map(row => ({
    trialId: row.trial_id, ending: row.ending, resolved: row.resolved === 1, isolation: row.isolation ?? "none", configId: row.config_id,
    profileEpoch: row.profile_epoch, tokens: row.tokens, spentUsd: row.spent_usd, cost: row.cost, startedAt: row.started_at, endedAt: row.ended_at,
  }));
}

/** Writes a final copy row of a reused trial into one slot of a job. It counts as `reused` and nothing else. */
export function insertCopy(tx: EvidenceTx, copy: { trialId: string; jobId: string; taskId: string; projectId: string;
  configuration: TrialConfiguration; slot: number; promptVersion: string; source: ReuseSource; keepDays: number }, at: string): void {
  const payload: TrialPayload = { projectId: copy.projectId, taskId: copy.taskId, configuration: copy.configuration };
  const source = copy.source;
  const changes = tx.run(
    "INSERT INTO eval_trials (trial_id, job_id, task_id, project_ref, config_ref, config_id, profile_epoch, harness, slot, attempt, "
    + "state, ending, resolved, isolation, session_id, created_at, started_at, ended_at, expires_at, payload, "
    + "prompt_version, reused_from, tokens, spent_usd, cost) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'final', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    copy.trialId, copy.jobId, copy.taskId, tx.index("project", copy.projectId), configRef(copy.configuration), source.configId,
    source.profileEpoch, TRIAL_HARNESS_VERSION, copy.slot, source.ending, source.resolved ? 1 : 0, source.isolation, at,
    source.startedAt, source.endedAt, addDays(at, copy.keepDays), tx.seal("eval_trials", copy.trialId, payload),
    copy.promptVersion, source.trialId, source.tokens, source.spentUsd, source.cost,
  ).changes;
  if (changes === 1) tx.run("UPDATE eval_trial_counts SET reused = reused + 1 WHERE job_id=?", copy.jobId);
}

function trialOf(db: EvidenceDb, row: TrialSqlRow): TrialRow {
  let payload: TrialPayload;
  try {
    payload = db.open<TrialPayload>("eval_trials", row.trial_id, row.payload);
  } catch {
    throw new EvidenceError("unreadable", "An eval trial payload does not open.");
  }
  return {
    trialId: row.trial_id, jobId: row.job_id, taskId: row.task_id, projectRef: row.project_ref, configRef: row.config_ref,
    configId: row.config_id, profileEpoch: row.profile_epoch, harness: row.harness, slot: row.slot, attempt: row.attempt,
    state: row.state, ending: row.ending, resolved: row.resolved === null ? null : row.resolved === 1, isolation: row.isolation,
    createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at, payload,
  };
}

export function readTrial(db: EvidenceDb, trialId: string): TrialRow | undefined {
  const row = db.get<TrialSqlRow>(
    "SELECT trial_id, job_id, task_id, project_ref, config_ref, config_id, profile_epoch, harness, slot, attempt, state, ending, "
    + "resolved, isolation, created_at, started_at, ended_at, payload FROM eval_trials WHERE trial_id=?",
    trialId,
  );
  return row === undefined ? undefined : trialOf(db, row);
}

export function liveTrials(db: EvidenceDb): Pick<TrialRow, "trialId" | "jobId" | "taskId" | "state">[] {
  return db.all<{ trial_id: string; job_id: string; task_id: string; state: TrialState }>(LIVE_TRIALS_SQL)
    .map(row => ({ trialId: row.trial_id, jobId: row.job_id, taskId: row.task_id, state: row.state }));
}

export function jobSlots(db: EvidenceDb, jobId: string, taskId: string): SlotRow[] {
  return db.all<{ task_id: string; config_ref: string; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null }>(
    JOB_SLOTS_SQL, jobId, taskId,
  ).map(row => ({ taskId: row.task_id, configRef: row.config_ref, slot: row.slot, attempt: row.attempt, state: row.state, ending: row.ending }));
}

export function jobTrialCount(db: EvidenceDb, jobId: string): number {
  return db.get<{ n: number }>(JOB_TRIALS_SQL, jobId)?.n ?? 0;
}

/** Trials a project started since a time. `projectId` is the project's id; the index is computed here. */
export function trialsSince(db: EvidenceDb, projectId: string, since: string): number {
  return db.get<{ n: number }>(PROJECT_DAY_SQL, db.index("project", projectId), since)?.n ?? 0;
}

export function trialCounts(db: EvidenceDb, jobIds: readonly string[]): Map<string, TrialCounts> {
  const counts = new Map<string, TrialCounts>();
  if (jobIds.length === 0) return counts;
  if (jobIds.length > TRIAL_COUNTS_IDS_MAX) throw new RangeError(`At most ${TRIAL_COUNTS_IDS_MAX} jobs per count.`);
  const marks = jobIds.map(() => "?").join(", ");
  const rows = db.all<{ job_id: string; planned_tasks: number; planned_trials: number; tasks: number; skipped: number; started: number;
    graded: number; resolved: number; ended: number; voided: number; void_streak: number; reused: number }>(
    "SELECT job_id, planned_tasks, planned_trials, tasks, skipped, started, graded, resolved, ended, voided, void_streak, reused "
    + `FROM eval_trial_counts WHERE job_id IN (${marks})`,
    ...jobIds,
  );
  for (const row of rows) {
    counts.set(row.job_id, {
      plannedTasks: row.planned_tasks, plannedTrials: row.planned_trials, tasks: row.tasks, skipped: row.skipped, started: row.started,
      graded: row.graded, resolved: row.resolved, ended: row.ended, void: row.voided, voidStreak: row.void_streak, reused: row.reused,
    });
  }
  return counts;
}

export function trialSessions(db: EvidenceDb, endedBefore: string, limit: number): { trialId: string; sessionId: string; endedAt: string }[] {
  return db.all<{ trial_id: string; session_id: string; ended_at: string }>(TRIAL_SESSIONS_SQL, endedBefore, limit)
    .map(row => ({ trialId: row.trial_id, sessionId: row.session_id, endedAt: row.ended_at }));
}

/** Every trial row of a job, for the report pass. More than JOB_ROWS_MAX rows is `unreadable`, never a partial answer. */
export function jobRows(db: EvidenceDb, jobId: string): JobTrialRow[] {
  const rows = db.all<{ task_id: string; config_ref: string; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null;
    resolved: number | null; isolation: "isolated" | "none" | null; config_id: string | null; profile_epoch: number | null;
    prompt_version: string | null; tokens: number | null; spent_usd: number | null; cost: TrialCost | null;
    started_at: string | null; ended_at: string | null; reused_from: string | null }>(JOB_ROWS_SQL, jobId);
  if (rows.length > JOB_ROWS_MAX) throw new EvidenceError("unreadable", "A job has more trial rows than a report reads.");
  return rows.map(row => ({
    taskId: row.task_id, configRef: row.config_ref, slot: row.slot, attempt: row.attempt, state: row.state, ending: row.ending,
    resolved: row.resolved === null ? null : row.resolved === 1, isolation: row.isolation, configId: row.config_id,
    profileEpoch: row.profile_epoch, promptVersion: row.prompt_version, tokens: row.tokens, spentUsd: row.spent_usd, cost: row.cost,
    startedAt: row.started_at, endedAt: row.ended_at, reused: row.reused_from !== null,
  }));
}

function releasePatch(tx: EvidenceTx, trialId: string, bytes: number): void {
  tx.run("DELETE FROM eval_trial_patches WHERE trial_id=?", trialId);
  tx.run("UPDATE eval_trial_totals SET patch_bytes = patch_bytes - ? WHERE id=1", bytes);
}

/**
 * Deletes at most TRIAL_SWEEP_BATCH expired patches, then at most TRIAL_SWEEP_BATCH expired trials, and then at most
 * TRIAL_SWEEP_BATCH counts rows of jobs that are gone. Returns the number of trials it deleted.
 */
export function sweepTrials(tx: EvidenceTx, now: string): number {
  for (const row of tx.all<{ trial_id: string; bytes: number }>(PATCHES_EXPIRED_SQL, now, TRIAL_SWEEP_BATCH)) {
    releasePatch(tx, row.trial_id, row.bytes);
  }
  const expired = tx.all<{ trial_id: string }>(TRIALS_EXPIRED_SQL, now, TRIAL_SWEEP_BATCH);
  for (const row of expired) {
    const patch = tx.get<{ bytes: number }>("SELECT bytes FROM eval_trial_patches WHERE trial_id=?", row.trial_id);
    if (patch !== undefined) releasePatch(tx, row.trial_id, patch.bytes);
    tx.run("DELETE FROM eval_trials WHERE trial_id=?", row.trial_id);
  }
  tx.run("DELETE FROM eval_trial_counts WHERE job_id IN (SELECT job_id FROM eval_trial_counts "
    + "WHERE job_id NOT IN (SELECT job_id FROM eval_jobs) LIMIT ?)", TRIAL_SWEEP_BATCH);
  tx.run("DELETE FROM eval_reports WHERE job_id IN (SELECT job_id FROM eval_reports WHERE expires_at < ? ORDER BY expires_at LIMIT ?)",
    now, TRIAL_SWEEP_BATCH);
  tx.run("DELETE FROM eval_priors WHERE prior_id IN (SELECT prior_id FROM eval_priors WHERE expires_at < ? ORDER BY expires_at LIMIT ?)",
    now, TRIAL_SWEEP_BATCH);
  return expired.length;
}
