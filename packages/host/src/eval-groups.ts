import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { indexPaths, rejectTask, retireTask, runGroupId } from "./eval-store.js";
import { drawnSet, mergedSet, type GroupSetRow } from "./eval-sets.js";
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
export const LANDING_NEVER = "9999-12-31T23:59:59.999Z";

type DueRow = { group_id: string; project_ref: string; created_at: string };

export { runGroupId };

export function ensureGroup(tx: EvidenceTx, groupId: string, kind: "run" | "mined", projectRef: string, at: string): void {
  const drawn = drawnSet(tx, groupId, at);
  tx.run(
    "INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at, holdout, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    groupId,
    kind,
    projectRef,
    groupId,
    at,
    drawn.holdout,
    drawn.setAt,
  );
}

export function rootOf(db: EvidenceDb, groupId: string): string {
  return db.get<{ root_id: string }>("SELECT root_id FROM eval_groups WHERE group_id = ?", groupId)?.root_id ?? groupId;
}

export function mergeRoots(tx: EvidenceTx, roots: readonly string[], devOnly: boolean): string {
  const unique = [...new Set(roots)].sort(compareText);
  const root = unique[0];
  const rows = tx.all<GroupSetRow>(
    `SELECT dev_only, holdout, exposed, set_at, confirms FROM eval_groups WHERE group_id IN (${placeholders(unique.length)})`,
    ...unique,
  );
  const mark = Math.max(...rows.map(row => row.dev_only), devOnly ? 1 : 0);
  const merged = mergedSet(rows, devOnly);
  tx.run(`UPDATE eval_groups SET root_id = ? WHERE root_id IN (${placeholders(unique.length)})`, root, ...unique);
  tx.run("UPDATE eval_groups SET holdout = 0, set_at = NULL WHERE root_id = ? AND group_id <> ?", root, root);
  tx.run(
    "UPDATE eval_groups SET dev_only = ?, holdout = ?, set_at = ?, exposed = ?, confirms = ? WHERE group_id = ?",
    mark,
    merged.holdout,
    merged.setAt,
    merged.exposed,
    merged.confirms,
    root,
  );
  return root;
}

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

export function recordLanding(tx: EvidenceTx, input: { projectRef: string; groupId: string; landingRef: string; at: string }): boolean {
  tx.run(
    "UPDATE eval_groups SET landing_ref = ?, landing_checked_at = ? WHERE group_id = ?",
    input.landingRef,
    input.at,
    input.groupId,
  );
  const mined = tx.get<{ group_id: string }>(
    "SELECT group_id FROM eval_tasks WHERE project_ref = ? AND commit_ref = ? AND origin = 'mined'",
    input.projectRef,
    input.landingRef,
  );
  if (mined === undefined || mined.group_id === null) return false;
  const root = mergeRoots(tx, [rootOf(tx, input.groupId), rootOf(tx, mined.group_id)], false);
  applyDuplicateRule(tx, root, input.at);
  return true;
}

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

export class GroupPass {
  private readonly store: EvidenceStore;
  private readonly runs: () => readonly TeamRun[];
  private readonly now: () => string;

  constructor(options: GroupPassOptions) {
    this.store = options.store;
    this.runs = options.runs;
    this.now = options.now ?? (() => new Date().toISOString());
  }

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
        const inWindow = due.some(group => Date.parse(group.created_at) >= Date.parse(oldest));
        const merges = inWindow ? this.mergeCommits() : new Map<string, string>();
        const outcomes = this.store.status().modules[OUTCOMES_MODULE] === "ready";
        for (const group of due) {
          result.checked++;
          if (Date.parse(group.created_at) < Date.parse(oldest)) {
            this.stamp(group.group_id, LANDING_NEVER);
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
    }
    return result;
  }

  private mergeCommits(): Map<string, string> {
    const commits = new Map<string, string>();
    for (const run of this.runs()) {
      const commit = run.deliveryReceipt?.mergeCommit;
      if (commit !== undefined && COMMIT_ID.test(commit)) commits.set(runGroupId(run.id), commit);
    }
    return commits;
  }

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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
