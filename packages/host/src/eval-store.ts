import type { EvidenceStore } from "./evidence/store.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx, RunEvent } from "./evidence/types.js";
import type { Promotion } from "./eval-rules.js";
import {
  EVAL_MODULE,
  type ApprovalState,
  type ApprovalStart,
  type BaseState,
  type CapturedPayload,
  type Capsule,
  type CaptureStart,
  type EvalFeatures,
  type EvalReason,
  type EvalState,
  type EvalTaskRow,
  type MaterialState,
  type PromotionReason,
  type RejectedPayload,
  type ReconcileResult,
  type StartReason,
  type BaseRead,
  type MaterialReason,
} from "./eval-types.js";

export const PROJECT_TASK_MAX = 20_000;
export const PROJECT_MATERIAL_MAX_BYTES = 134_217_728;
export const HOST_MATERIAL_MAX_BYTES = 536_870_912;
export const SWEEP_BATCH = 100;

const DAY_MS = 86_400_000;

/**
 * The last statuses of a deleted run that keep its tasks. Any other status, or none, takes them. The host deletes a run
 * record only when it is cancelled, merged, or no-change, so any other last status belongs to a run whose later events
 * were lost, and its fate is unknown.
 */
const KEEP_STATUSES: ReadonlySet<string> = new Set(["merged", "no-change"]);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS eval_tasks (
    task_id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    run_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    project_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    material TEXT NOT NULL,
    approval TEXT,
    approved_at TEXT,
    base TEXT NOT NULL,
    material_bytes INTEGER NOT NULL DEFAULT 0,
    captured_at TEXT NOT NULL,
    decided_at TEXT,
    checked_at TEXT NOT NULL,
    run_deleted_at TEXT,
    payload TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS eval_tasks_run ON eval_tasks (run_id)",
  "CREATE INDEX IF NOT EXISTS eval_tasks_project ON eval_tasks (project_ref, captured_at)",
  "CREATE INDEX IF NOT EXISTS eval_tasks_check ON eval_tasks (state, checked_at, task_id)",
  "CREATE INDEX IF NOT EXISTS eval_tasks_bytes ON eval_tasks (project_ref, material_bytes)",
  "CREATE INDEX IF NOT EXISTS eval_tasks_live_runs ON eval_tasks (run_id) WHERE run_deleted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS eval_tasks_captured ON eval_tasks (captured_at, project_ref)",
  `CREATE TABLE IF NOT EXISTS eval_material (
    task_id TEXT NOT NULL,
    part TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, part)
  )`,
];

const TASK_COLUMNS = "task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, approved_at, base, "
  + "material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload";

type TaskRow = {
  task_id: string;
  origin: string;
  run_id: string;
  member_id: string;
  project_ref: string;
  state: string;
  reason: string | null;
  material: string;
  approval: string | null;
  approved_at: string | null;
  base: string;
  material_bytes: number;
  captured_at: string;
  decided_at: string | null;
  checked_at: string;
  run_deleted_at: string | null;
  payload: string;
};

/** The marker's outcome: a captured task with its capsule, or a task refused before any read. */
export type MarkerOutcome = { state: "captured"; capsule: Capsule } | { state: "rejected"; reason: StartReason };

export type MaterialResult =
  | { kind: "reject"; reason: MaterialReason }
  | { kind: "store"; files: string[]; hiddenFiles: string[];
      baseDelta: { state: "none" } | { state: "stored"; bytes: Buffer } | { state: "missing" };
      reference: { state: "stored"; bytes: Buffer } | { state: "missing" }; base: BaseRead };

/**
 * The promotion decision. Declared here with the shape of `eval-rules.ts`, which defines the same type.
 * Both must stay equal, so the coordinator can join them.
 */

export type Decide = (task: EvalTaskRow & { payload: CapturedPayload }) => Promotion | { kind: "wait"; unreadable: true };

export function evalCorpusModule(store: EvidenceStore, now: () => string): EvidenceModule {
  return {
    name: EVAL_MODULE,
    version: 1,
    readVersion: 1,
    migrate(tx, from) {
      if (from >= 1) return;
      for (const statement of SCHEMA) tx.exec(statement);
    },
    deleteRun(tx, runId) {
      const owned = tx.get<{ n: number }>("SELECT count(*) AS n FROM eval_tasks WHERE run_id=?", runId)?.n ?? 0;
      if (owned === 0) return;
      // Read before the store deletes the run's events: the hook runs first.
      const status = lastRunStatus(store, tx, runId);
      if (status !== undefined && KEEP_STATUSES.has(status)) {
        tx.run("UPDATE eval_tasks SET run_deleted_at=COALESCE(run_deleted_at, ?) WHERE run_id=?", now(), runId);
        return;
      }
      tx.run("DELETE FROM eval_material WHERE task_id IN (SELECT task_id FROM eval_tasks WHERE run_id=?)", runId);
      tx.run("DELETE FROM eval_tasks WHERE run_id=?", runId);
    },
    runIds: db => db.all<{ run_id: string }>(LIVE_RUN_IDS_SQL).map(row => row.run_id),
    counts: db => {
      const row = db.get<{ captured: number; candidate: number; rejected: number; bytes: number }>(
        "SELECT COALESCE(SUM(state='captured'), 0) AS captured, COALESCE(SUM(state='candidate'), 0) AS candidate, "
        + "COALESCE(SUM(state='rejected'), 0) AS rejected, COALESCE(SUM(material_bytes), 0) AS bytes FROM eval_tasks",
      );
      return {
        captured: row?.captured ?? 0,
        candidate: row?.candidate ?? 0,
        rejected: row?.rejected ?? 0,
        materialBytes: row?.bytes ?? 0,
      };
    },
  };
}

export function capturedTaskId(runId: string, memberId: string): string {
  return `captured:${runId}:${memberId}`;
}

/**
 * Writes the marker row, and for a captured task its capsule part. `full` when the project holds 20,000 rows. Nothing
 * is written then. The byte caps apply at completion, in `completeMaterial`.
 */
export function insertMarker(tx: EvidenceTx, start: CaptureStart, outcome: MarkerOutcome, at: string): "inserted" | "exists" | "full" {
  const taskId = capturedTaskId(start.runId, start.memberId);
  const ref = tx.index("project", start.projectId);
  const rows = tx.get<{ n: number }>("SELECT count(*) AS n FROM eval_tasks WHERE project_ref=?", ref)?.n ?? 0;
  if (rows >= PROJECT_TASK_MAX) return "full";
  const capsuleBytes = outcome.state === "captured" ? Buffer.byteLength(canonicalJson(outcome.capsule), "utf8") : 0;
  const captured = outcome.state === "captured";
  const payload: CapturedPayload | RejectedPayload = captured
    ? {
      projectId: start.projectId,
      anchorCommit: start.anchorCommit,
      memberBaseCommit: start.memberBaseCommit,
      commit: start.commit,
      integratedHead: start.integratedHead,
    }
    : { projectId: start.projectId };
  const inserted = tx.run(
    "INSERT OR IGNORE INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, "
    + "approved_at, base, material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload) "
    + "VALUES (?, 'captured', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)",
    taskId,
    start.runId,
    start.memberId,
    ref,
    captured ? "captured" : "rejected",
    captured ? null : outcome.reason,
    captured ? "pending" : "none",
    captured ? "pending" : "none",
    capsuleBytes,
    start.at,
    captured ? null : at,
    at,
    tx.seal("eval_tasks", taskId, payload),
  );
  if (inserted.changes === 0) return "exists";
  if (outcome.state === "captured") {
    tx.run(
      "INSERT INTO eval_material (task_id, part, bytes, payload) VALUES (?, 'capsule', ?, ?)",
      taskId,
      capsuleBytes,
      tx.seal("eval_material", `${taskId}/capsule`, { capsule: outcome.capsule }),
    );
  }
  return "inserted";
}

/**
 * Completes a pending material. A reject, or a stored size that would take the project past 128 MiB or the host past
 * 512 MiB, removes every part and rejects the row. False when the row is gone or its material is not pending.
 */
export function completeMaterial(tx: EvidenceTx, taskId: string, result: MaterialResult, at: string): boolean {
  const row = tx.get<{ material: string; project_ref: string; material_bytes: number; payload: string }>(
    "SELECT material, project_ref, material_bytes, payload FROM eval_tasks WHERE task_id=?",
    taskId,
  );
  if (!row || row.material !== "pending") return false;
  const payload = tx.open<CapturedPayload>("eval_tasks", taskId, row.payload);
  if (result.kind === "reject") {
    rejectRow(tx, taskId, result.reason, at, payload.projectId);
    return true;
  }
  const baseSize = result.baseDelta.state === "stored" ? result.baseDelta.bytes.length : 0;
  const referenceSize = result.reference.state === "stored" ? result.reference.bytes.length : 0;
  const size = baseSize + referenceSize;
  const projectBytes = materialBytesOf(tx, "project_ref=?", row.project_ref);
  const hostBytes = materialBytesOf(tx, "1=1");
  if (projectBytes + size > PROJECT_MATERIAL_MAX_BYTES || hostBytes + size > HOST_MATERIAL_MAX_BYTES) {
    rejectRow(tx, taskId, "corpus-full", at, payload.projectId);
    return true;
  }
  if (result.baseDelta.state === "stored") insertPart(tx, taskId, "base-delta", result.baseDelta.bytes);
  if (result.reference.state === "stored") insertPart(tx, taskId, "reference", result.reference.bytes);
  const partial = result.baseDelta.state === "missing" || result.reference.state === "missing";
  const next: CapturedPayload = {
    ...payload,
    files: result.files,
    hiddenFiles: result.hiddenFiles,
    baseDelta: result.baseDelta.state,
    reference: result.reference.state === "stored" ? "stored" : "missing",
  };
  tx.run(
    "UPDATE eval_tasks SET material=?, base=?, material_bytes=material_bytes+?, payload=? WHERE task_id=?",
    partial ? "partial" : "stored",
    result.base,
    size,
    tx.seal("eval_tasks", taskId, next),
    taskId,
  );
  return true;
}

/** Marks the run's captured and candidate rows of this anchor. A payload that does not open is marked `unknown`. */
export function markApproval(tx: EvidenceTx, start: ApprovalStart): { taskId: string; integratedHead: string }[] {
  const rows = tx.all<{ task_id: string; payload: string }>(
    "SELECT task_id, payload FROM eval_tasks WHERE run_id=? AND state IN ('captured', 'candidate')",
    start.runId,
  );
  const marked: { taskId: string; integratedHead: string }[] = [];
  for (const row of rows) {
    let payload: CapturedPayload;
    try {
      payload = tx.open<CapturedPayload>("eval_tasks", row.task_id, row.payload);
    } catch {
      tx.run("UPDATE eval_tasks SET approval='unknown', approved_at=? WHERE task_id=?", start.at, row.task_id);
      continue;
    }
    if (payload.anchorCommit !== start.anchorCommit) continue;
    tx.run("UPDATE eval_tasks SET approval='pending', approved_at=? WHERE task_id=?", start.at, row.task_id);
    marked.push({ taskId: row.task_id, integratedHead: payload.integratedHead });
  }
  return marked;
}

/**
 * `later` undefined records `unknown`. False unless the row is captured or candidate and its approval is pending
 * under `approvedAt`, so a read of an earlier approval writes nothing once a later one marked the row.
 */
export function completeApproval(tx: EvidenceTx, taskId: string, approvedAt: string, later: string[] | undefined): boolean {
  const row = tx.get<{ state: string; approval: string | null; approved_at: string | null; payload: string }>(
    "SELECT state, approval, approved_at, payload FROM eval_tasks WHERE task_id=?",
    taskId,
  );
  if (!row || (row.state !== "captured" && row.state !== "candidate")) return false;
  if (row.approval !== "pending" || row.approved_at !== approvedAt) return false;
  if (later === undefined) {
    tx.run("UPDATE eval_tasks SET approval='unknown' WHERE task_id=?", taskId);
    return true;
  }
  const payload = tx.open<CapturedPayload>("eval_tasks", taskId, row.payload);
  tx.run(
    "UPDATE eval_tasks SET approval='read', payload=? WHERE task_id=?",
    tx.seal("eval_tasks", taskId, { ...payload, laterFiles: [...later] }),
    taskId,
  );
  return true;
}

/**
 * The restart rule. Material pending outside `materialInFlight` is rejected `capture-failed`; approval pending outside
 * `approvalInFlight` becomes `unknown`. Each half looks only at its own kind of job. Returns the number of tasks changed.
 */
export function failPending(
  tx: EvidenceTx,
  materialInFlight: ReadonlySet<string>,
  approvalInFlight: ReadonlySet<string>,
  at: string,
): number {
  const touched = new Set<string>();
  const material = tx.all<{ task_id: string; payload: string }>("SELECT task_id, payload FROM eval_tasks WHERE material='pending'");
  for (const row of material) {
    if (materialInFlight.has(row.task_id)) continue;
    rejectRow(tx, row.task_id, "capture-failed", at, projectIdOf(tx, row.task_id, row.payload));
    touched.add(row.task_id);
  }
  const approvals = tx.all<{ task_id: string }>("SELECT task_id FROM eval_tasks WHERE approval='pending'");
  for (const row of approvals) {
    if (approvalInFlight.has(row.task_id)) continue;
    tx.run("UPDATE eval_tasks SET approval='unknown' WHERE task_id=?", row.task_id);
    touched.add(row.task_id);
  }
  return touched.size;
}

/** The reconcile pass's order query, run once per state through `eval_tasks_check`. */
export const RECONCILE_ORDER_SQL = "SELECT task_id, checked_at FROM eval_tasks WHERE state = ? ORDER BY checked_at, task_id LIMIT ?";
/** The runs with rows still held, read through `eval_tasks_live_runs`. */
export const LIVE_RUN_IDS_SQL = "SELECT DISTINCT run_id FROM eval_tasks WHERE run_deleted_at IS NULL";
/** The sweep's fallback for rows of no configured project, read through `eval_tasks_captured`. */
export function sweepFallbackSql(configuredCount: number): string {
  const exclude = configuredCount === 0 ? "" : ` AND project_ref NOT IN (${Array.from({ length: configuredCount }, () => "?").join(", ")})`;
  return `SELECT task_id FROM eval_tasks WHERE captured_at < ?${exclude} ORDER BY captured_at LIMIT ?`;
}
/** One task's full row, by its key. */
export const TASK_BY_ID_SQL = `SELECT ${TASK_COLUMNS} FROM eval_tasks WHERE task_id=?`;

/**
 * Visits at most `limit` captured or candidate rows, oldest `checked_at` first. A payload that does not open rejects
 * its row `unreadable`. `decide` gives the promotion; a candidate is written once, and a reject removes the material.
 */
export function reconcileBatch(tx: EvidenceTx, decide: Decide, at: string, limit = SWEEP_BATCH): ReconcileResult {
  const result: ReconcileResult = { visited: 0, promoted: 0, rejected: 0, demoted: 0, waiting: 0, unreadable: 0 };
  const order = [
    ...tx.all<{ task_id: string; checked_at: string }>(RECONCILE_ORDER_SQL, "captured", limit),
    ...tx.all<{ task_id: string; checked_at: string }>(RECONCILE_ORDER_SQL, "candidate", limit),
  ]
    .sort((a, b) => (a.checked_at === b.checked_at ? compareText(a.task_id, b.task_id) : compareText(a.checked_at, b.checked_at)))
    .slice(0, limit);
  for (const picked of order) {
    const row = tx.get<TaskRow>(TASK_BY_ID_SQL, picked.task_id);
    if (!row) continue;
    result.visited++;
    tx.run("UPDATE eval_tasks SET checked_at=? WHERE task_id=?", at, row.task_id);
    let task: EvalTaskRow & { payload: CapturedPayload };
    try {
      task = taskOf(tx, row) as EvalTaskRow & { payload: CapturedPayload };
    } catch {
      rejectRow(tx, row.task_id, "unreadable", at);
      if (row.state === "candidate") result.demoted++;
      else result.rejected++;
      result.unreadable++;
      continue;
    }
    const decision = decide(task);
    if (decision.kind === "wait") {
      result.waiting++;
      if ("unreadable" in decision && decision.unreadable) result.unreadable++;
      continue;
    }
    if (decision.kind === "candidate") {
      if (row.state === "captured") {
        tx.run(
          "UPDATE eval_tasks SET state='candidate', decided_at=?, payload=? WHERE task_id=?",
          at,
          tx.seal("eval_tasks", row.task_id, { ...task.payload, features: decision.features }),
          row.task_id,
        );
        result.promoted++;
      }
      continue;
    }
    rejectRow(tx, row.task_id, decision.reason, at, task.payload.projectId);
    if (row.state === "candidate") result.demoted++;
    else result.rejected++;
  }
  return result;
}

export function readEvalTask(db: EvidenceDb, taskId: string): EvalTaskRow | undefined {
  const row = db.get<TaskRow>(TASK_BY_ID_SQL, taskId);
  return row === undefined ? undefined : taskOf(db, row);
}

/** Every row of the run. A payload that does not open throws. */
export function runEvalTasks(db: EvidenceDb, runId: string): EvalTaskRow[] {
  return db.all<TaskRow>(`SELECT ${TASK_COLUMNS} FROM eval_tasks WHERE run_id=? ORDER BY captured_at, task_id`, runId)
    .map(row => taskOf(db, row));
}

export function readMaterial(db: EvidenceDb, taskId: string): { capsule?: Capsule; baseDelta?: Buffer; reference?: Buffer } {
  const result: { capsule?: Capsule; baseDelta?: Buffer; reference?: Buffer } = {};
  const rows = db.all<{ part: string; payload: string }>("SELECT part, payload FROM eval_material WHERE task_id=?", taskId);
  for (const row of rows) {
    const rowId = `${taskId}/${row.part}`;
    if (row.part === "capsule") {
      result.capsule = db.open<{ capsule: Capsule }>("eval_material", rowId, row.payload).capsule;
    } else if (row.part === "base-delta" || row.part === "reference") {
      const { patch } = db.open<{ patch: string }>("eval_material", rowId, row.payload);
      if (row.part === "base-delta") result.baseDelta = Buffer.from(patch, "base64");
      else result.reference = Buffer.from(patch, "base64");
    }
  }
  return result;
}

/**
 * Deletes rows older than their project's retention, and older than `fallbackDays` for a project ref that no
 * configured project matches. At most `limit` rows per call, oldest first within each project.
 */
export function sweepEvalTasks(
  tx: EvidenceTx,
  now: string,
  projects: readonly { projectId: string; retentionDays: number }[],
  fallbackDays: number,
  limit = SWEEP_BATCH,
): number {
  const cutoff = (days: number) => new Date(Date.parse(now) - days * DAY_MS).toISOString();
  let remaining = limit;
  let removed = 0;
  const configured: string[] = [];
  for (const project of projects) {
    const ref = tx.index("project", project.projectId);
    configured.push(ref);
    if (remaining <= 0) continue;
    const old = tx.all<{ task_id: string }>(
      "SELECT task_id FROM eval_tasks WHERE project_ref=? AND captured_at < ? ORDER BY captured_at LIMIT ?",
      ref,
      cutoff(project.retentionDays),
      remaining,
    );
    removed += deleteTasks(tx, old.map(row => row.task_id));
    remaining -= old.length;
  }
  if (remaining > 0) {
    const old = tx.all<{ task_id: string }>(
      sweepFallbackSql(configured.length),
      cutoff(fallbackDays),
      ...configured,
      remaining,
    );
    removed += deleteTasks(tx, old.map(row => row.task_id));
  }
  return removed;
}

/**
 * The one reject rule. Every part goes, the row resets, and no later completion can match it. The payload is replaced
 * only when the project is known; an unreadable payload stays sealed as it was.
 */
function rejectRow(tx: EvidenceTx, taskId: string, reason: EvalReason, at: string, projectId?: string): void {
  tx.run("DELETE FROM eval_material WHERE task_id=?", taskId);
  const payload = projectId === undefined ? null : tx.seal("eval_tasks", taskId, { projectId } satisfies RejectedPayload);
  tx.run(
    "UPDATE eval_tasks SET state='rejected', reason=?, material='none', base='none', approval=NULL, approved_at=NULL, "
    + "material_bytes=0, decided_at=?, payload=COALESCE(?, payload) WHERE task_id=?",
    reason,
    at,
    payload,
    taskId,
  );
}

/** Code-unit order, the order SQLite's BINARY collation gives for these ASCII keys. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function insertPart(tx: EvidenceTx, taskId: string, part: "base-delta" | "reference", bytes: Buffer): void {
  tx.run(
    "INSERT INTO eval_material (task_id, part, bytes, payload) VALUES (?, ?, ?, ?)",
    taskId,
    part,
    bytes.length,
    tx.seal("eval_material", `${taskId}/${part}`, { patch: bytes.toString("base64") }),
  );
}

function deleteTasks(tx: EvidenceTx, taskIds: readonly string[]): number {
  for (const taskId of taskIds) {
    tx.run("DELETE FROM eval_material WHERE task_id=?", taskId);
    tx.run("DELETE FROM eval_tasks WHERE task_id=?", taskId);
  }
  return taskIds.length;
}

function materialBytesOf(db: EvidenceDb, where: string, ...params: string[]): number {
  return db.get<{ n: number }>(`SELECT COALESCE(SUM(material_bytes), 0) AS n FROM eval_tasks WHERE ${where}`, ...params)?.n ?? 0;
}

function projectIdOf(db: EvidenceDb, taskId: string, sealed: string): string | undefined {
  try {
    const payload = db.open<{ projectId?: unknown }>("eval_tasks", taskId, sealed);
    return typeof payload.projectId === "string" ? payload.projectId : undefined;
  } catch {
    return undefined;
  }
}

function taskOf(db: EvidenceDb, row: TaskRow): EvalTaskRow {
  return {
    taskId: row.task_id,
    origin: "captured",
    runId: row.run_id,
    memberId: row.member_id,
    projectRef: row.project_ref,
    state: row.state as EvalState,
    reason: (row.reason ?? null) as EvalReason | null,
    material: row.material as MaterialState,
    approval: (row.approval ?? null) as ApprovalState | null,
    approvedAt: row.approved_at ?? null,
    base: row.base as BaseState,
    materialBytes: row.material_bytes,
    capturedAt: row.captured_at,
    decidedAt: row.decided_at ?? null,
    checkedAt: row.checked_at,
    runDeletedAt: row.run_deleted_at ?? null,
    payload: db.open<CapturedPayload | RejectedPayload>("eval_tasks", row.task_id, row.payload),
  };
}

/**
 * The status of the run's last `run.settled` or `run.deleted` event. Undefined when there is no such event, when it
 * does not open, or when its status is not a string: the caller then deletes, because the fate is unknown.
 */
function lastRunStatus(store: EvidenceStore, tx: EvidenceTx, runId: string): string | undefined {
  let last: RunEvent | undefined;
  try {
    let after = 0;
    for (;;) {
      const page = store.eventsIn(tx, { runId, kinds: ["run.settled", "run.deleted"], after, limit: 100 });
      if (page.events.length > 0) last = page.events[page.events.length - 1];
      if (!page.more) break;
      after = page.cursor;
    }
  } catch {
    return undefined;
  }
  const status = last?.data.status;
  return typeof status === "string" ? status : undefined;
}
