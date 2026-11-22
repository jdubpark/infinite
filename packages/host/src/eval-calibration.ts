import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceTx } from "./evidence/types.js";
import { markExposed } from "./eval-sets.js";

// The calibration read: pairs of a resolved and an unresolved graded trial patch for one dev task.
// Only a host-internal caller reads it. No route, command, log line, or event carries a pair.

export const CALIBRATION_PAIRS_MAX = 20;

export const CALIBRATION_TASKS_SQL = "SELECT x.task_id FROM eval_trials x JOIN eval_tasks t ON t.task_id = x.task_id "
  + "LEFT JOIN eval_groups g ON g.group_id = t.group_id LEFT JOIN eval_groups r ON r.group_id = g.root_id "
  + "WHERE x.project_ref = ? AND x.ending = 'graded' AND x.reused_from IS NULL AND x.task_id > ? AND t.state = 'valid' "
  + "AND COALESCE(r.holdout, 0) = 0 GROUP BY x.task_id HAVING MIN(x.resolved) = 0 AND MAX(x.resolved) = 1 ORDER BY x.task_id LIMIT ?";

export const PAIR_TRIAL_SQL = "SELECT x.trial_id FROM eval_trials x JOIN eval_trial_patches p ON p.trial_id = x.trial_id "
  + "WHERE x.project_ref = ? AND x.task_id = ? AND x.ending = 'graded' AND x.reused_from IS NULL AND x.resolved = ? "
  + "ORDER BY x.ended_at DESC, x.trial_id LIMIT 1";

export type CalibrationPair = {
  taskId: string;
  resolved: { trialId: string; patch: Buffer };
  unresolved: { trialId: string; patch: Buffer };
};

type Side = { trialId: string; patch: Buffer };

function sideOf(tx: EvidenceTx, projectRef: string, taskId: string, resolved: 0 | 1): Side | undefined {
  const row = tx.get<{ trial_id: string }>(PAIR_TRIAL_SQL, projectRef, taskId, resolved);
  if (row === undefined) return undefined;
  const stored = tx.get<{ payload: string }>("SELECT payload FROM eval_trial_patches WHERE trial_id = ?", row.trial_id);
  if (stored === undefined) return undefined;
  const opened = tx.open<{ patch: string }>("eval_trial_patches", row.trial_id, stored.payload);
  return { trialId: row.trial_id, patch: Buffer.from(opened.patch, "base64") };
}

/**
 * Reads at most `limit` (at most CALIBRATION_PAIRS_MAX) dev tasks that have both a resolved and an unresolved graded
 * trial, and returns the newest stored patch of each side. The group of each returned task is marked exposed in the
 * same write. `next` is the last task id read when the page was full, else null.
 */
export function calibrationPairs(
  store: EvidenceStore,
  input: { projectId: string; after?: string; limit?: number },
): { pairs: CalibrationPair[]; next: string | null } {
  const limit = Math.max(1, Math.min(CALIBRATION_PAIRS_MAX, Math.floor(input.limit ?? CALIBRATION_PAIRS_MAX)));
  return store.write(tx => {
    const projectRef = tx.index("project", input.projectId);
    const tasks = tx.all<{ task_id: string }>(CALIBRATION_TASKS_SQL, projectRef, input.after ?? "", limit);
    const pairs: CalibrationPair[] = [];
    for (const { task_id: taskId } of tasks) {
      const resolved = sideOf(tx, projectRef, taskId, 1);
      const unresolved = sideOf(tx, projectRef, taskId, 0);
      if (resolved === undefined || unresolved === undefined) continue;
      pairs.push({ taskId, resolved, unresolved });
      const group = tx.get<{ group_id: string | null }>("SELECT group_id FROM eval_tasks WHERE task_id = ?", taskId);
      if (group?.group_id) markExposed(tx, group.group_id);
    }
    const last = tasks[tasks.length - 1];
    return { pairs, next: tasks.length === limit && last !== undefined ? last.task_id : null };
  });
}
