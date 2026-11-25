import type { EvidenceStore } from "./evidence/store.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx, RunEvent } from "./evidence/types.js";
import type { Promotion } from "./eval-rules.js";
import { drawExisting, drawnSet, fillTaskFields } from "./eval-sets.js";
import {
  EVAL_MODULE,
  type ApprovalState,
  type ApprovalStart,
  type BaseState,
  type CapturedPayload,
  type Capsule,
  type CaptureStart,
  type EvalOrigin,
  type EvalReason,
  type Lineage,
  type EvalTaskRow,
  type MaterialState,
  type MinedPayload,
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

const KEEP_STATUSES: ReadonlySet<string> = new Set(["merged", "no-change"]);

export const SCHEMA_V1 = [
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
  `CREATE TABLE IF NOT EXISTS eval_material (
    task_id TEXT NOT NULL,
    part TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, part)
  )`,
];

export const SCHEMA_V2 = [
  "ALTER TABLE eval_tasks ADD COLUMN group_id TEXT",
  "ALTER TABLE eval_tasks ADD COLUMN commit_ref TEXT",
  "ALTER TABLE eval_tasks ADD COLUMN area_ref TEXT",
  "ALTER TABLE eval_tasks ADD COLUMN lineage TEXT",
  "ALTER TABLE eval_tasks ADD COLUMN validated_at TEXT",
  "ALTER TABLE eval_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE eval_tasks ADD COLUMN paths_indexed INTEGER NOT NULL DEFAULT 0",
  "UPDATE eval_tasks SET group_id = 'run:' || run_id WHERE origin = 'captured'",
  "DROP INDEX IF EXISTS eval_tasks_check",
  "CREATE INDEX IF NOT EXISTS eval_tasks_check_captured ON eval_tasks (state, checked_at, task_id) WHERE origin = 'captured'",
  "CREATE INDEX IF NOT EXISTS eval_tasks_group ON eval_tasks (group_id, origin, state)",
  "CREATE UNIQUE INDEX IF NOT EXISTS eval_tasks_commit ON eval_tasks (project_ref, commit_ref) WHERE commit_ref IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS eval_tasks_summary ON eval_tasks (project_ref, origin, state, area_ref)",
  "CREATE INDEX IF NOT EXISTS eval_tasks_next ON eval_tasks (project_ref, state, task_id)",
  "CREATE INDEX IF NOT EXISTS eval_tasks_unindexed ON eval_tasks (project_ref, task_id) WHERE paths_indexed = 0 AND material IN ('stored', 'partial')",
  `CREATE TABLE IF NOT EXISTS eval_groups (
    group_id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_ref TEXT NOT NULL, root_id TEXT NOT NULL,
    dev_only INTEGER NOT NULL DEFAULT 0, landing_ref TEXT, landing_checked_at TEXT, created_at TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS eval_groups_root ON eval_groups (root_id)",
  "CREATE INDEX IF NOT EXISTS eval_groups_project ON eval_groups (project_ref, root_id)",
  "CREATE INDEX IF NOT EXISTS eval_groups_landing ON eval_groups (project_ref, landing_ref) WHERE landing_ref IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS eval_groups_unlanded ON eval_groups (landing_checked_at, group_id) WHERE landing_ref IS NULL AND kind = 'run'",
  "INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at) "
    + "SELECT 'run:' || run_id, 'run', project_ref, 'run:' || run_id, MIN(captured_at) FROM eval_tasks "
    + "WHERE origin = 'captured' GROUP BY run_id, project_ref",
  `CREATE TABLE IF NOT EXISTS eval_paths (
    path_ref TEXT NOT NULL, captured_at TEXT NOT NULL, task_id TEXT NOT NULL,
    PRIMARY KEY (path_ref, captured_at, task_id)) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS eval_paths_task ON eval_paths (task_id)",
  `CREATE TABLE IF NOT EXISTS eval_mining (
    project_ref TEXT PRIMARY KEY, state TEXT NOT NULL, visited INTEGER NOT NULL DEFAULT 0,
    mined INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    retry_at TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS eval_jobs (
    job_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
    waiting TEXT, request_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, started_at TEXT, expires_at TEXT NOT NULL,
    finished_at TEXT, updated_at TEXT NOT NULL, visited INTEGER NOT NULL DEFAULT 0, valid INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0, retired INTEGER NOT NULL DEFAULT 0, undecided INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0, cursor TEXT, payload TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS eval_jobs_project ON eval_jobs (project_ref, status)",
  "CREATE INDEX IF NOT EXISTS eval_jobs_status ON eval_jobs (status, created_at, job_id)",
  "CREATE INDEX IF NOT EXISTS eval_jobs_created ON eval_jobs (created_at, job_id)",
];

export const SCHEMA_V3 = [
  "ALTER TABLE eval_groups ADD COLUMN holdout INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE eval_groups ADD COLUMN set_at TEXT",
  "ALTER TABLE eval_groups ADD COLUMN exposed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE eval_groups ADD COLUMN confirms INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE eval_tasks ADD COLUMN prompt_origin TEXT",
  "ALTER TABLE eval_tasks ADD COLUMN kind TEXT",
  "ALTER TABLE eval_jobs ADD COLUMN reported_at TEXT",
  "CREATE INDEX IF NOT EXISTS eval_groups_holdout_age ON eval_groups (set_at) WHERE holdout = 1",
  "CREATE INDEX IF NOT EXISTS eval_groups_holdout_used ON eval_groups (confirms) WHERE holdout = 1 AND confirms >= 5",
  "CREATE INDEX IF NOT EXISTS eval_jobs_unreported ON eval_jobs (kind, project_ref, finished_at, job_id) WHERE reported_at IS NULL AND kind != 'validate'",
];

const TASK_COLUMNS = "task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, approved_at, base, "
  + "material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload, group_id, lineage, validated_at, attempts";

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
  group_id: string | null;
  lineage: string | null;
  validated_at: string | null;
  attempts: number;
};

export type MarkerOutcome = { state: "captured"; capsule: Capsule } | { state: "rejected"; reason: StartReason };

export type MaterialResult =
  | { kind: "reject"; reason: MaterialReason }
  | { kind: "store"; files: string[]; hiddenFiles: string[];
      baseDelta: { state: "none" } | { state: "stored"; bytes: Buffer } | { state: "missing" };
      reference: { state: "stored"; bytes: Buffer } | { state: "missing" }; base: BaseRead };

type CapturedActiveTask = Extract<EvalTaskRow, { origin: "captured"; state: "captured" | "candidate" | "valid" }>;

export type Decide = (task: CapturedActiveTask) => Promotion | { kind: "wait"; unreadable: true };
export type Promoted = (tx: EvidenceTx, task: EvalTaskRow) => void;

export function evalCorpusModule(store: EvidenceStore, now: () => string): EvidenceModule {
  return {
    name: EVAL_MODULE,
    version: 3,
    readVersion: 3,
    migrate(tx, from) {
      if (from === 0) for (const statement of SCHEMA_V1) tx.exec(statement);
      if (from < 2) for (const statement of SCHEMA_V2) tx.exec(statement);
      if (from < 3) {
        for (const statement of SCHEMA_V3) tx.exec(statement);
        drawExisting(tx);
        fillTaskFields(tx);
      }
    },
    deleteRun(tx, runId) {
      const owned = tx.get<{ n: number }>("SELECT count(*) AS n FROM eval_tasks WHERE run_id=?", runId)?.n ?? 0;
      if (owned === 0) return;
      const status = lastRunStatus(store, tx, runId);
      if (status !== undefined && KEEP_STATUSES.has(status)) {
        tx.run("UPDATE eval_tasks SET run_deleted_at=COALESCE(run_deleted_at, ?) WHERE run_id=?", now(), runId);
        return;
      }
      tx.run("DELETE FROM eval_material WHERE task_id IN (SELECT task_id FROM eval_tasks WHERE run_id=?)", runId);
      tx.run("DELETE FROM eval_paths WHERE task_id IN (SELECT task_id FROM eval_tasks WHERE run_id=?)", runId);
      tx.run("DELETE FROM eval_tasks WHERE run_id=?", runId);
    },
    runIds: db => db.all<{ run_id: string }>(LIVE_RUN_IDS_SQL).map(row => row.run_id),
    counts: db => {
      const row = db.get<{ captured: number; candidate: number; valid: number; rejected: number; retired: number; mined: number; bytes: number }>(
        "SELECT COALESCE(SUM(state='captured'), 0) AS captured, COALESCE(SUM(state='candidate'), 0) AS candidate, "
        + "COALESCE(SUM(state='valid'), 0) AS valid, COALESCE(SUM(state='rejected'), 0) AS rejected, "
        + "COALESCE(SUM(state='retired'), 0) AS retired, COALESCE(SUM(origin='mined'), 0) AS mined, "
        + "COALESCE(SUM(material_bytes), 0) AS bytes FROM eval_tasks",
      );
      const jobs = db.get<{ n: number }>("SELECT count(*) AS n FROM eval_jobs")?.n ?? 0;
      return { captured: row?.captured ?? 0, candidate: row?.candidate ?? 0, valid: row?.valid ?? 0, rejected: row?.rejected ?? 0,
        retired: row?.retired ?? 0, mined: row?.mined ?? 0, jobs, materialBytes: row?.bytes ?? 0 };
    },
  };
}

export function capturedTaskId(runId: string, memberId: string): string {
  return `captured:${runId}:${memberId}`;
}

export function insertMarker(tx: EvidenceTx, start: CaptureStart, outcome: MarkerOutcome, at: string): "inserted" | "exists" | "full" {
  const taskId = capturedTaskId(start.runId, start.memberId);
  const ref = tx.index("project", start.projectId);
  const rows = tx.get<{ n: number }>(CAPTURED_COUNT_SQL, ref)?.n ?? 0;
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
  const groupId = runGroupId(start.runId);
  const drawn = drawnSet(tx, groupId, start.at);
  tx.run("INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, 'run', ?, ?, ?, ?, ?)", groupId, ref, groupId, start.at, drawn.holdout, drawn.setAt);
  const inserted = tx.run(
    "INSERT OR IGNORE INTO eval_tasks (task_id, origin, run_id, member_id, project_ref, state, reason, material, approval, "
    + "approved_at, base, material_bytes, captured_at, decided_at, checked_at, run_deleted_at, payload, group_id) "
    + "VALUES (?, 'captured', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)",
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
    groupId,
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

export function completeMaterial(tx: EvidenceTx, taskId: string, result: MaterialResult, at: string): boolean {
  const row = tx.get<{ material: string; project_ref: string; material_bytes: number; payload: string; captured_at: string }>(
    "SELECT material, project_ref, material_bytes, payload, captured_at FROM eval_tasks WHERE task_id=?",
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
    "UPDATE eval_tasks SET material=?, base=?, material_bytes=material_bytes+?, payload=?, paths_indexed=1 WHERE task_id=?",
    partial ? "partial" : "stored",
    result.base,
    size,
    tx.seal("eval_tasks", taskId, next),
    taskId,
  );
  writePaths(tx, payload.projectId, taskId, row.captured_at, result.files);
  return true;
}

export function markApproval(tx: EvidenceTx, start: ApprovalStart): { taskId: string; integratedHead: string }[] {
  const rows = tx.all<{ task_id: string; payload: string }>(
    "SELECT task_id, payload FROM eval_tasks WHERE run_id=? AND state IN ('captured', 'candidate', 'valid')",
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

export function completeApproval(tx: EvidenceTx, taskId: string, approvedAt: string, later: string[] | undefined): boolean {
  const row = tx.get<{ state: string; approval: string | null; approved_at: string | null; payload: string }>(
    "SELECT state, approval, approved_at, payload FROM eval_tasks WHERE task_id=?",
    taskId,
  );
  if (!row || (row.state !== "captured" && row.state !== "candidate" && row.state !== "valid")) return false;
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

export const RECONCILE_ORDER_SQL = "SELECT task_id, checked_at FROM eval_tasks WHERE origin = 'captured' AND state = ? ORDER BY checked_at, task_id LIMIT ?";
export const CAPTURED_COUNT_SQL = "SELECT count(*) AS n FROM eval_tasks WHERE project_ref = ? AND origin = 'captured'";
export const UNINDEXED_SQL = "SELECT task_id, captured_at, payload FROM eval_tasks WHERE paths_indexed = 0 AND material IN ('stored', 'partial') ORDER BY project_ref, task_id LIMIT ?";
export const PATHS_PENDING_SQL = "SELECT 1 AS one FROM eval_tasks WHERE project_ref = ? AND paths_indexed = 0 AND material IN ('stored','partial') LIMIT 1";
export const PATHS_PER_TASK_MAX = 500;
export const PATHS_BATCH = 100;
export const LIVE_RUN_IDS_SQL = "SELECT DISTINCT run_id FROM eval_tasks WHERE run_deleted_at IS NULL";
export const SWEEP_REFS_MAX = 64;
export const NEXT_PROJECT_REF_SQL = "SELECT project_ref AS ref FROM eval_tasks WHERE project_ref > ? ORDER BY project_ref LIMIT 1";
export const PROJECT_OLD_SQL = "SELECT task_id FROM eval_tasks WHERE project_ref = ? AND captured_at < ? ORDER BY captured_at LIMIT ?";
export type SweepCursor = { after: string };
export const TASK_BY_ID_SQL = `SELECT ${TASK_COLUMNS} FROM eval_tasks WHERE task_id=?`;

export function reconcileBatch(
  tx: EvidenceTx,
  decide: Decide,
  at: string,
  limit = SWEEP_BATCH,
  onPromoted?: Promoted,
): ReconcileResult {
  const result: ReconcileResult = { visited: 0, promoted: 0, rejected: 0, demoted: 0, waiting: 0, unreadable: 0 };
  const order = [
    ...tx.all<{ task_id: string; checked_at: string }>(RECONCILE_ORDER_SQL, "captured", limit),
    ...tx.all<{ task_id: string; checked_at: string }>(RECONCILE_ORDER_SQL, "candidate", limit),
    ...tx.all<{ task_id: string; checked_at: string }>(RECONCILE_ORDER_SQL, "valid", limit),
  ]
    .sort((a, b) => (a.checked_at === b.checked_at ? compareText(a.task_id, b.task_id) : compareText(a.checked_at, b.checked_at)))
    .slice(0, limit);
  for (const picked of order) {
    const row = tx.get<TaskRow>(TASK_BY_ID_SQL, picked.task_id);
    if (!row) continue;
    result.visited++;
    tx.run("UPDATE eval_tasks SET checked_at=? WHERE task_id=?", at, row.task_id);
    let task: CapturedActiveTask;
    try {
      const opened = taskOf(tx, row);
      if (opened.origin !== "captured" || (opened.state !== "captured" && opened.state !== "candidate" && opened.state !== "valid")) continue;
      task = opened;
    } catch {
      dropRow(tx, row, "unreadable", at);
      result.unreadable++;
      if (row.state === "captured") result.rejected++;
      else result.demoted++;
      continue;
    }
    const decision = decide(task);
    if (decision.kind === "wait") {
      result.waiting++;
      if ("unreadable" in decision && decision.unreadable) result.unreadable++;
      continue;
    }
    if (decision.kind === "candidate") {
      if (task.state === "captured") {
        tx.run(
          "UPDATE eval_tasks SET state='candidate', decided_at=?, area_ref=?, payload=?, prompt_origin='assignment', kind=? WHERE task_id=?",
          at,
          tx.index("area", decision.features.area),
          tx.seal("eval_tasks", row.task_id, { ...task.payload, features: decision.features }),
          decision.features.kind,
          row.task_id,
        );
        result.promoted++;
        onPromoted?.(tx, { ...task, state: "candidate", decidedAt: at });
      }
      continue;
    }
    dropRow(tx, row, decision.reason, at, task.payload.projectId);
    if (row.state === "captured") result.rejected++;
    else result.demoted++;
  }
  return result;
}

export function readEvalTask(db: EvidenceDb, taskId: string): EvalTaskRow | undefined {
  const row = db.get<TaskRow>(TASK_BY_ID_SQL, taskId);
  return row === undefined ? undefined : taskOf(db, row);
}

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

export function sweepEvalTasks(
  tx: EvidenceTx,
  now: string,
  projects: readonly { projectId: string; retentionDays: number }[],
  fallbackDays: number,
  limit = SWEEP_BATCH,
  cursor: SweepCursor = { after: "" },
): number {
  const cutoff = (days: number) => new Date(Date.parse(now) - days * DAY_MS).toISOString();
  const retention = new Map<string, number>();
  for (const project of projects) retention.set(tx.index("project", project.projectId), project.retentionDays);
  let remaining = limit;
  let removed = 0;
  for (let visited = 0; visited < SWEEP_REFS_MAX && remaining > 0; visited++) {
    const next = tx.get<{ ref: string }>(NEXT_PROJECT_REF_SQL, cursor.after);
    if (next === undefined) {
      cursor.after = "";
      break;
    }
    const old = tx.all<{ task_id: string }>(
      PROJECT_OLD_SQL,
      next.ref,
      cutoff(retention.get(next.ref) ?? fallbackDays),
      remaining,
    );
    removed += deleteTasks(tx, old.map(row => row.task_id));
    remaining -= old.length;
    if (remaining <= 0) break;
    cursor.after = next.ref;
  }
  return removed;
}

function settle(tx: EvidenceTx, taskId: string, state: "rejected" | "retired", reason: EvalReason, at: string, projectId?: string): void {
  tx.run("DELETE FROM eval_material WHERE task_id=?", taskId);
  tx.run("DELETE FROM eval_paths WHERE task_id=?", taskId);
  const payload = projectId === undefined ? null : tx.seal("eval_tasks", taskId, { projectId } satisfies RejectedPayload);
  tx.run(
    "UPDATE eval_tasks SET state=?, reason=?, material='none', base='none', approval=NULL, approved_at=NULL, "
    + "material_bytes=0, decided_at=?, payload=COALESCE(?, payload) WHERE task_id=?",
    state,
    reason,
    at,
    payload,
    taskId,
  );
}

function rejectRow(tx: EvidenceTx, taskId: string, reason: EvalReason, at: string, projectId?: string): void {
  settle(tx, taskId, "rejected", reason, at, projectId);
}

function dropRow(tx: EvidenceTx, row: TaskRow, reason: EvalReason, at: string, projectId?: string): void {
  settle(tx, row.task_id, row.state === "valid" ? "retired" : "rejected", reason, at, projectId);
}

export function rejectTask(tx: EvidenceTx, taskId: string, reason: EvalReason, at: string, projectId?: string): void {
  rejectRow(tx, taskId, reason, at, projectId);
}

export function retireTask(tx: EvidenceTx, taskId: string, reason: EvalReason, at: string, projectId?: string): void {
  settle(tx, taskId, "retired", reason, at, projectId);
}

export function runGroupId(runId: string): string {
  return `run:${runId}`;
}

export function pathRef(db: EvidenceDb, projectId: string, path: string): string {
  return db.index("eval-path", `${projectId}\u0000${path}`);
}

function writePaths(tx: EvidenceTx, projectId: string, taskId: string, capturedAt: string, files: readonly string[]): void {
  for (const file of files.slice(0, PATHS_PER_TASK_MAX)) {
    tx.run(
      "INSERT OR IGNORE INTO eval_paths (path_ref, captured_at, task_id) VALUES (?, ?, ?)",
      pathRef(tx, projectId, file),
      capturedAt,
      taskId,
    );
  }
}

export function indexPaths(tx: EvidenceTx, limit = PATHS_BATCH): number {
  const rows = tx.all<{ task_id: string; captured_at: string; payload: string }>(UNINDEXED_SQL, limit);
  for (const row of rows) {
    try {
      const payload = tx.open<CapturedPayload>("eval_tasks", row.task_id, row.payload);
      writePaths(tx, payload.projectId, row.task_id, row.captured_at, payload.files ?? []);
    } catch {}
    tx.run("UPDATE eval_tasks SET paths_indexed=1 WHERE task_id=?", row.task_id);
  }
  return rows.length;
}

export function pathsPending(db: EvidenceDb, projectRef: string): boolean {
  return db.get(PATHS_PENDING_SQL, projectRef) !== undefined;
}

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
    tx.run("DELETE FROM eval_paths WHERE task_id=?", taskId);
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
  const base = {
    taskId: row.task_id,
    runId: row.run_id,
    memberId: row.member_id,
    projectRef: row.project_ref,
    material: row.material as MaterialState,
    approvedAt: row.approved_at ?? null,
    base: row.base as BaseState,
    materialBytes: row.material_bytes,
    capturedAt: row.captured_at,
    checkedAt: row.checked_at,
    runDeletedAt: row.run_deleted_at ?? null,
    groupId: row.group_id ?? null,
    lineage: (row.lineage ?? null) as Lineage | null,
    attempts: row.attempts,
  };
  if (row.state === "rejected" || row.state === "retired") {
    return {
      ...base,
      origin: row.origin as EvalOrigin,
      state: row.state,
      reason: (row.reason ?? null) as EvalReason | null,
      approval: null,
      decidedAt: row.decided_at ?? null,
      validatedAt: row.validated_at ?? null,
      payload: db.open<RejectedPayload>("eval_tasks", row.task_id, row.payload),
    };
  }
  if (row.origin === "mined") {
    const payload = db.open<MinedPayload>("eval_tasks", row.task_id, row.payload);
    if (row.state === "valid") {
      return {
        ...base,
        origin: "mined",
        state: "valid",
        reason: null,
        approval: null,
        decidedAt: row.decided_at ?? null,
        validatedAt: row.validated_at ?? null,
        payload,
      };
    }
    return {
      ...base,
      origin: "mined",
      state: "candidate",
      reason: null,
      approval: null,
      decidedAt: row.decided_at ?? null,
      validatedAt: null,
      payload,
    };
  }
  const payload = db.open<CapturedPayload>("eval_tasks", row.task_id, row.payload);
  const approval = (row.approval ?? null) as ApprovalState | null;
  if (row.state === "captured") {
    return {
      ...base,
      origin: "captured",
      state: "captured",
      reason: null,
      approval,
      decidedAt: null,
      validatedAt: null,
      payload,
    };
  }
  if (row.state === "valid") {
    return {
      ...base,
      origin: "captured",
      state: "valid",
      reason: null,
      approval,
      decidedAt: row.decided_at ?? null,
      validatedAt: row.validated_at ?? null,
      payload,
    };
  }
  return {
    ...base,
    origin: "captured",
    state: "candidate",
    reason: null,
    approval,
    decidedAt: row.decided_at ?? null,
    validatedAt: null,
    payload,
  };
}

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
