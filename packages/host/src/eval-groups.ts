import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { indexPaths, rejectTask, retireTask, runGroupId } from "./eval-store.js";
import { EVAL_MODULE } from "./eval-types.js";
import { COMMIT_ID } from "./outcome-hold.js";
import { landingSignalId } from "./outcome-signals.js";
import { OUTCOMES_MODULE, readSignal } from "./outcome-store.js";
import type { TeamRun } from "./team-types.js";

export const GROUP_BATCH = 100, LINEAGE_DAYS = 90, LINEAGE_GROUPS_MAX = 64, LINEAGE_ROWS_MAX = 1_000, LANDING_CHECK_DAYS = 90, LANDING_RECHECK_MS = 600_000;

export const ROOT_TASKS_SQL = "SELECT t.task_id, t.origin, t.state FROM eval_groups g JOIN eval_tasks t ON t.group_id = g.group_id WHERE g.root_id = ?";
export const LINEAGE_SQL = "SELECT t.group_id, t.approved_at FROM eval_paths p JOIN eval_tasks t ON t.task_id = p.task_id "
  + "WHERE p.path_ref = ? AND p.captured_at >= ? AND p.captured_at < ? AND t.origin = 'captured' AND t.state IN ('captured', 'candidate', 'valid') LIMIT ?";
export const LANDINGS_DUE_SQL = "SELECT group_id, project_ref, created_at FROM eval_groups WHERE landing_ref IS NULL AND kind = 'run' "
  + "AND (landing_checked_at IS NULL OR landing_checked_at < ?) ORDER BY landing_checked_at, group_id LIMIT ?";

const DAY_MS = 86_400_000;
const RUN_PREFIX = "run:";

type DueRow = { group_id: string; project_ref: string; created_at: string };

export { runGroupId };

export function ensureGroup(tx: EvidenceTx, groupId: string, kind: "run" | "mined", projectRef: string, at: string): void {
  tx.run(
    "INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at) VALUES (?, ?, ?, ?, ?)",
    groupId,
    kind,
    projectRef,
    groupId,
    at,
  );
}

/** The root of a group: its `root_id`, or the group id itself when the group has no row. */
export function rootOf(db: EvidenceDb, groupId: string): string {
  return db.get<{ root_id: string }>("SELECT root_id FROM eval_groups WHERE group_id = ?", groupId)?.root_id ?? groupId;
}

/** Merges roots into the smallest id. `devOnly` marks the result; a merged root keeps any earlier mark. */
export function mergeRoots(tx: EvidenceTx, roots: readonly string[], devOnly: boolean): string {
  const unique = [...new Set(roots)].sort(compareText);
  const root = unique[0];
  const marks = tx.get<{ n: number }>(
    `SELECT COALESCE(MAX(dev_only), 0) AS n FROM eval_groups WHERE group_id IN (${placeholders(unique.length)})`,
    ...unique,
  );
  const mark = Math.max(marks?.n ?? 0, devOnly ? 1 : 0);
  tx.run(`UPDATE eval_groups SET root_id = ? WHERE root_id IN (${placeholders(unique.length)})`, root, ...unique);
  tx.run("UPDATE eval_groups SET dev_only = ? WHERE group_id = ?", mark, root);
  return root;
}

/**
 * In a root with a captured `candidate` or `valid` task: a mined `candidate` is rejected and a mined `valid` task
 * retired, both `duplicate-of-captured`. Returns the number of rows changed.
 */
export function applyDuplicateRule(tx: EvidenceTx, root: string, at: string): number {
  const rows = tx.all<{ task_id: string; origin: string; state: string }>(ROOT_TASKS_SQL, root);
  const captured = rows.some(row => row.origin === "captured" && (row.state === "candidate" || row.state === "valid"));
  if (!captured) return 0;
  let changed = 0;
  for (const row of rows) {
    if (row.origin !== "mined") continue;
    if (row.state === "candidate") {
      rejectTask(tx, row.task_id, "duplicate-of-captured", at);
      changed++;
    } else if (row.state === "valid") {
      retireTask(tx, row.task_id, "duplicate-of-captured", at);
      changed++;
    }
  }
  return changed;
}

/**
 * Records a run group's landing and joins the mined task of that commit, if one exists. The join merges the two roots
 * without the dev-only mark and applies the duplicate rule. Returns true when a mined task was joined.
 */
export function recordLanding(tx: EvidenceTx, input: { projectRef: string; groupId: string; landingRef: string; at: string }): boolean {
  tx.run(
    "UPDATE eval_groups SET landing_ref = ?, landing_checked_at = ? WHERE group_id = ?",
    input.landingRef,
    input.at,
    input.groupId,
  );
  const mined = tx.get<{ group_id: string }>(
    "SELECT group_id FROM eval_tasks WHERE project_ref = ? AND commit_ref = ?",
    input.projectRef,
    input.landingRef,
  );
  if (mined === undefined || mined.group_id === null) return false;
  const root = mergeRoots(tx, [rootOf(tx, input.groupId), rootOf(tx, mined.group_id)], false);
  applyDuplicateRule(tx, root, input.at);
  return true;
}

/**
 * The roots of the runs that may have produced this commit, or `tooWide`. A row counts when its approval is set and
 * earlier than the commit and its run group has no landing. More than 64 roots, or 1,000 rows on one path, is `tooWide`.
 */
export function lineageRoots(
  db: EvidenceDb,
  input: { pathRefs: readonly string[]; commitTime: string },
): { roots: string[] } | { tooWide: true } {
  const from = isoAt(Date.parse(input.commitTime) - LINEAGE_DAYS * DAY_MS);
  const roots = new Set<string>();
  for (const ref of new Set(input.pathRefs)) {
    const rows = db.all<{ group_id: string; approved_at: string | null }>(
      LINEAGE_SQL,
      ref,
      from,
      input.commitTime,
      LINEAGE_ROWS_MAX + 1,
    );
    if (rows.length > LINEAGE_ROWS_MAX) return { tooWide: true };
    for (const row of rows) {
      if (row.approved_at === null || row.approved_at >= input.commitTime) continue;
      const group = db.get<{ root_id: string; landing_ref: string | null }>(
        "SELECT root_id, landing_ref FROM eval_groups WHERE group_id = ?",
        row.group_id,
      );
      if (group?.landing_ref !== undefined && group.landing_ref !== null) continue;
      roots.add(group?.root_id ?? row.group_id);
    }
  }
  if (roots.size > LINEAGE_GROUPS_MAX) return { tooWide: true };
  return { roots: [...roots].sort(compareText) };
}

/** Roots of one project, their devOnly roots, and the most tasks one root holds. */
export function groupStats(db: EvidenceDb, projectRef: string): { total: number; devOnly: number; largest: number } {
  const roots = db.get<{ total: number; dev: number }>(
    "SELECT count(*) AS total, COALESCE(SUM(dev_only), 0) AS dev FROM eval_groups WHERE project_ref = ? AND root_id = group_id",
    projectRef,
  );
  const largest = db.get<{ n: number }>(
    "SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT g.root_id, COUNT(t.task_id) AS n FROM eval_groups g "
    + "JOIN eval_tasks t ON t.group_id = g.group_id WHERE g.project_ref = ? GROUP BY g.root_id)",
    projectRef,
  );
  return { total: roots?.total ?? 0, devOnly: roots?.dev ?? 0, largest: largest?.n ?? 0 };
}

/**
 * Deletes group rows that no task names and that no other row has as its root, oldest first, at most `limit`.
 * Returns the number deleted.
 */
export function sweepGroups(tx: EvidenceTx, limit = GROUP_BATCH): number {
  const rows = tx.all<{ group_id: string }>(
    "SELECT g.group_id FROM eval_groups g WHERE NOT EXISTS (SELECT 1 FROM eval_tasks t WHERE t.group_id = g.group_id) "
    + "AND NOT EXISTS (SELECT 1 FROM eval_groups o WHERE o.root_id = g.group_id AND o.group_id <> g.group_id) "
    + "ORDER BY g.created_at, g.group_id LIMIT ?",
    limit,
  );
  for (const row of rows) tx.run("DELETE FROM eval_groups WHERE group_id = ?", row.group_id);
  return rows.length;
}

export type GroupPassOptions = { store: EvidenceStore; runs: () => readonly TeamRun[]; now?: () => string };
export type GroupPassResult = { checked: number; landed: number; joined: number; indexed: number };

/**
 * The groups pass. It reads landings for run groups that have none, from a run record's merge commit or from a `landing`
 * signal of the run, then indexes path rows. It never throws.
 */
export class GroupPass {
  private readonly store: EvidenceStore;
  private readonly runs: () => readonly TeamRun[];
  private readonly now: () => string;

  constructor(options: GroupPassOptions) {
    this.store = options.store;
    this.runs = options.runs;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Up to 100 landing checks and 100 path-index rows. Never throws. */
  run(): GroupPassResult {
    const result: GroupPassResult = { checked: 0, landed: 0, joined: 0, indexed: 0 };
    try {
      if (this.store.status().modules[EVAL_MODULE] !== "ready") return result;
      const at = this.now();
      const nowMs = Date.parse(at);
      const recheck = isoAt(nowMs - LANDING_RECHECK_MS);
      const oldest = isoAt(nowMs - LANDING_CHECK_DAYS * DAY_MS);
      const due = this.store.read(db => db.all<DueRow>(LANDINGS_DUE_SQL, recheck, GROUP_BATCH));
      if (due.length > 0) {
        const merges = this.mergeCommits();
        const outcomes = this.store.status().modules[OUTCOMES_MODULE] === "ready";
        for (const group of due) {
          result.checked++;
          if (Date.parse(group.created_at) < Date.parse(oldest)) {
            this.stamp(group.group_id, at);
            continue;
          }
          const commit = merges.get(group.group_id) ?? (outcomes ? this.signalCommit(group.group_id) : undefined);
          if (commit === undefined) {
            this.stamp(group.group_id, at);
            continue;
          }
          let joined = false;
          const wrote = this.store.tryWrite(tx => {
            joined = recordLanding(tx, {
              projectRef: group.project_ref,
              groupId: group.group_id,
              landingRef: tx.index("eval-commit", commit),
              at,
            });
          });
          if (wrote) {
            result.landed++;
            if (joined) result.joined++;
          }
        }
      }
      this.store.tryWrite(tx => {
        result.indexed = indexPaths(tx, GROUP_BATCH);
      });
    } catch {
      // The pass never throws; a failed step leaves its rows for the next pass.
    }
    return result;
  }

  /** The merge commit of each run record, keyed by its run group id. */
  private mergeCommits(): Map<string, string> {
    const commits = new Map<string, string>();
    for (const run of this.runs()) {
      const commit = run.deliveryReceipt?.mergeCommit;
      if (commit !== undefined && COMMIT_ID.test(commit)) commits.set(runGroupId(run.id), commit);
    }
    return commits;
  }

  /** The commit of the run's `landing` signal. Undefined when the signal is missing, unopenable, or not a landing. */
  private signalCommit(groupId: string): string | undefined {
    try {
      const row = this.store.read(db => readSignal(db, landingSignalId(groupId.slice(RUN_PREFIX.length))));
      return row?.payload.kind === "landing" && COMMIT_ID.test(row.payload.commit) ? row.payload.commit : undefined;
    } catch {
      return undefined;
    }
  }

  private stamp(groupId: string, at: string): void {
    this.store.tryWrite(tx => {
      tx.run("UPDATE eval_groups SET landing_checked_at = ? WHERE group_id = ?", at, groupId);
    });
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/** Code-unit order, the order SQLite's BINARY collation gives for these ASCII keys. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
