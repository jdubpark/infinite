import type { RecordDigest, TeamGoalCriteriaPlanPin, TeamTaskPlan } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

const invalidReport = (message: string) => new TeamError(409, "goal-task-criteria-invalid", message);

export function validateGoalTaskCriterionRefs(
  tasks: readonly TeamTaskPlan[],
  pin: TeamGoalCriteriaPlanPin | undefined,
  record: Pick<RecordDigest, "version" | "criteria"> | undefined,
): void {
  if (!pin) {
    if (tasks.some(task => task.criterionRefs !== undefined))
      throw invalidReport("Task criterion references are not bound to a host-pinned goal objective.");
    return;
  }
  if (!record)
    throw new TeamError(409, "goal-criteria-pin-unavailable", "The host-pinned goal objective record is unavailable; this plan cannot be attributed to criteria.");
  if (pin.objectiveVersion !== record.version)
    throw new TeamError(409, "goal-criteria-pin-stale", "The project manager's goal objective pin does not match the run's pinned record.");

  const active = new Set(record.criteria.map(criterion => criterion.id));
  for (const task of tasks) {
    const refs = task.criterionRefs;
    if (!refs)
      throw invalidReport(`Task ${task.id} must name at least one active criterion from objective version ${pin.objectiveVersion}.`);
    if (refs.objectiveVersion !== pin.objectiveVersion)
      throw invalidReport(`Task ${task.id} names objective version ${refs.objectiveVersion}; this plan is pinned to version ${pin.objectiveVersion}.`);
    const obsolete = refs.criteria.find(id => !active.has(id));
    if (obsolete)
      throw invalidReport(`Task ${task.id} names criterion ${obsolete}, which is not active in objective version ${pin.objectiveVersion}.`);
  }
}
