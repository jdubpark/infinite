import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import type { EvalOrigin, PromptOrigin } from "./eval-types.js";

/** 0.3 of 2^32, rounded up: the first 8 hex digits of the draw, read as an unsigned integer, are below it for holdout. */
export const HOLDOUT_THRESHOLD = 1_288_490_189;
export const HOLDOUT_CONFIRMS_MAX = 5;
export const HOLDOUT_DAYS_MAX = 120;
export const CONFIRM_TASKS_MIN = 15;
export const ROTATION_BATCH = 100;

const DAY_MS = 86_400_000;
const FILL_PAGE = 500;

/** A page of valid tasks with each task's root and set; a task without a group row is dev. */
export const TRIAL_TASKS_SQL = "SELECT t.task_id, t.origin, t.area_ref, t.prompt_origin, COALESCE(g.root_id, t.group_id) AS root_id, "
  + "COALESCE(r.holdout, 0) AS holdout FROM eval_tasks t LEFT JOIN eval_groups g ON g.group_id = t.group_id "
  + "LEFT JOIN eval_groups r ON r.group_id = g.root_id WHERE t.project_ref = ? AND t.state = 'valid' AND t.task_id > ? ORDER BY t.task_id LIMIT 200";
export const SET_COUNTS_SQL = "SELECT COALESCE(r.holdout, 0) AS holdout, count(*) AS n FROM eval_tasks t LEFT JOIN eval_groups g "
  + "ON g.group_id = t.group_id LEFT JOIN eval_groups r ON r.group_id = g.root_id WHERE t.project_ref = ? AND t.state = 'valid' GROUP BY 1";
export const GROUP_SETS_SQL = "SELECT COALESCE(SUM(holdout), 0) AS holdout, COALESCE(SUM(exposed), 0) AS exposed FROM eval_groups "
  + "WHERE project_ref = ? AND root_id = group_id";
/** Leaves out every project that has a confirm job without a report: the job still reads its groups, and an active confirm job has no report
 *  either. The first two terms of the inner statement select the partial index `eval_jobs_unreported`. */
const UNBLOCKED = "AND project_ref NOT IN (SELECT project_ref FROM eval_jobs WHERE reported_at IS NULL AND kind != 'validate' AND kind = 'confirm')";
export const HOLDOUT_USED_SQL = `SELECT group_id, project_ref FROM eval_groups WHERE holdout = 1 AND confirms >= 5 ${UNBLOCKED} LIMIT ?`;
export const HOLDOUT_AGED_SQL = `SELECT group_id, project_ref FROM eval_groups WHERE holdout = 1 AND set_at <= ? ${UNBLOCKED} ORDER BY set_at LIMIT ?`;

export type TrialTaskRow = {
  task_id: string;
  origin: EvalOrigin;
  area_ref: string | null;
  prompt_origin: PromptOrigin | null;
  root_id: string;
  holdout: 0 | 1;
};
export type GroupSetRow = { holdout: number; exposed: number; dev_only: number; set_at: string | null; confirms: number };

/** The draw: pure in the index value. */
export function drawsHoldout(indexHex: string): boolean {
  return parseInt(indexHex.slice(0, 8), 16) < HOLDOUT_THRESHOLD;
}

export function drawnSet(tx: EvidenceTx, groupId: string, at: string): { holdout: 0 | 1; setAt: string | null } {
  if (drawsHoldout(tx.index("eval-set", groupId))) return { holdout: 1, setAt: at };
  return { holdout: 0, setAt: null };
}

/** A merged root is holdout only when every part was, none was dev-only or exposed, and the merge is not dev-only. */
export function mergedSet(
  roots: readonly GroupSetRow[],
  devOnly: boolean,
): { holdout: 0 | 1; setAt: string | null; exposed: 0 | 1; confirms: number } {
  const exposed: 0 | 1 = roots.some(row => row.exposed === 1) ? 1 : 0;
  const confirms = roots.reduce((most, row) => Math.max(most, row.confirms), 0);
  const holdout = roots.length > 0
    && !devOnly
    && roots.every(row => row.holdout === 1 && row.dev_only === 0 && row.exposed === 0);
  if (!holdout) return { holdout: 0, setAt: null, exposed, confirms };
  let setAt: string | null = null;
  for (const row of roots) {
    if (row.set_at !== null && (setAt === null || row.set_at < setAt)) setAt = row.set_at;
  }
  return { holdout: 1, setAt, exposed, confirms };
}

function rootId(db: EvidenceDb, groupId: string): string {
  return db.get<{ root_id: string }>("SELECT root_id FROM eval_groups WHERE group_id = ?", groupId)?.root_id ?? groupId;
}

/** Marks the group's root exposed. True when the root was holdout and moved to dev. */
export function markExposed(tx: EvidenceTx, groupId: string): boolean {
  const root = rootId(tx, groupId);
  const row = tx.get<{ holdout: number }>("SELECT holdout FROM eval_groups WHERE group_id = ?", root);
  if (row === undefined) return false;
  tx.run("UPDATE eval_groups SET exposed = 1, holdout = 0, set_at = NULL WHERE group_id = ?", root);
  return row.holdout === 1;
}

/** Moves used and aged holdout roots to dev, at most `limit` roots, none in a project with an unreported confirm job. */
export function rotateHoldout(tx: EvidenceTx, now: string, limit = ROTATION_BATCH): number {
  const cutoff = new Date(Date.parse(now) - HOLDOUT_DAYS_MAX * DAY_MS).toISOString();
  let moved = 0;
  const move = (rows: { group_id: string; project_ref: string }[]): void => {
    for (const row of rows) {
      if (moved >= limit) return;
      moved += tx.run("UPDATE eval_groups SET holdout = 0, set_at = NULL WHERE group_id = ? AND holdout = 1", row.group_id).changes;
    }
  };
  move(tx.all<{ group_id: string; project_ref: string }>(HOLDOUT_USED_SQL, limit));
  if (moved < limit) move(tx.all<{ group_id: string; project_ref: string }>(HOLDOUT_AGED_SQL, cutoff, limit));
  return moved;
}

export function setCounts(db: EvidenceDb, projectRef: string): { dev: number; holdout: number; holdoutGroups: number; exposedGroups: number } {
  let dev = 0;
  let holdout = 0;
  for (const row of db.all<{ holdout: number; n: number }>(SET_COUNTS_SQL, projectRef)) {
    if (row.holdout === 1) holdout += row.n;
    else dev += row.n;
  }
  const groups = db.get<{ holdout: number; exposed: number }>(GROUP_SETS_SQL, projectRef);
  return { dev, holdout, holdoutGroups: groups?.holdout ?? 0, exposedGroups: groups?.exposed ?? 0 };
}

/** The v3 migration, once: draws every existing root. Dev-only roots and roots with a measured task go to dev. */
export function drawExisting(tx: EvidenceTx): void {
  const hasTrials = tx.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'eval_trials'")?.n ?? 0;
  const measured = new Set<string>();
  if (hasTrials > 0) {
    const rows = tx.all<{ root_id: string }>(
      "SELECT DISTINCT m.root_id FROM eval_trials r JOIN eval_tasks t ON t.task_id = r.task_id JOIN eval_groups m ON m.group_id = t.group_id",
    );
    for (const row of rows) measured.add(row.root_id);
  }
  const roots = tx.all<{ group_id: string; dev_only: number; created_at: string }>(
    "SELECT group_id, dev_only, created_at FROM eval_groups WHERE group_id = root_id ORDER BY group_id",
  );
  for (const root of roots) {
    if (root.dev_only !== 0 || measured.has(root.group_id)) continue;
    if (!drawsHoldout(tx.index("eval-set", root.group_id))) continue;
    tx.run("UPDATE eval_groups SET holdout = 1, set_at = ? WHERE group_id = ?", root.created_at, root.group_id);
  }
}

type SealedTask = { promptOrigin?: unknown; features?: { kind?: unknown } };

/** The v3 migration, once: fills `prompt_origin` and `kind` of each candidate or valid task from its sealed payload. */
export function fillTaskFields(tx: EvidenceTx): void {
  let after = "";
  for (;;) {
    const rows = tx.all<{ task_id: string; origin: string; payload: string }>(
      "SELECT task_id, origin, payload FROM eval_tasks WHERE state IN ('candidate', 'valid') AND task_id > ? ORDER BY task_id LIMIT ?",
      after,
      FILL_PAGE,
    );
    for (const row of rows) {
      after = row.task_id;
      let payload: SealedTask;
      try {
        payload = tx.open<SealedTask>("eval_tasks", row.task_id, row.payload);
      } catch {
        continue;
      }
      const origin = row.origin === "captured" ? "assignment" : payload.promptOrigin;
      const kind = payload.features?.kind;
      tx.run(
        "UPDATE eval_tasks SET prompt_origin = ?, kind = ? WHERE task_id = ?",
        typeof origin === "string" ? origin : null,
        typeof kind === "string" ? kind : null,
        row.task_id,
      );
    }
    if (rows.length < FILL_PAGE) return;
  }
}
