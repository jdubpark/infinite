import type { GoalAssessment, GoalCycle, GoalOutcomeInput, ProductGoal } from "./goal-types.js";
import type { TeamView } from "./team-types.js";
import type { CriteriaRow } from "./verdict-types.js";
import type { Project } from "./types.js";
import { autonomyOf } from "./autonomy.js";
import { goalObjectiveNote, steerGoalObjective, type GoalHolder } from "./objective-goals.js";
import { readStoredRecord } from "./objective-record.js";
import { checkLabel, objectivePromptsOn } from "./objective-digest.js";
import { TeamError } from "./team-workspace.js";

export const PROVISIONAL_REASON = "An agent assessment, provisional, found every criterion met. Record your assessment: achieved, or not achieved with continue.";
export const PROVISIONAL_EVENT = "Agent assessment, provisional: every criterion met. The goal stopped for your assessment and is not marked achieved.";
export const CONTINUE_EVENT = "You recorded not achieved and continued the goal. The next cycle reads your direction.";

const STEERING_ENTRIES = 20;
const STEERING_BYTES = 24000;

/** The newest cycle that holds an assessment. */
const newestAssessed = (cycles: readonly GoalCycle[]): GoalCycle | undefined => [...cycles].reverse().find(item => item.assessment !== undefined);

/**
 * For refresh's Object.assign: {} when neither the team nor the cycle has an assessment; the team's current one with its
 * progress; { assessment: undefined } when the cycle has one and the team's is gone or of another revision.
 */
export function cycleVerdict(goal: Pick<ProductGoal, "cycles">, cycle: GoalCycle, team: Pick<TeamView, "revision" | "assessment">): { assessment?: GoalAssessment } {
  const current = team.assessment !== undefined && team.assessment.revision === team.revision ? team.assessment : undefined;
  if (current === undefined) return cycle.assessment === undefined ? {} : { assessment: undefined };
  const earlier = newestAssessed(goal.cycles.filter(item => item.cycle < cycle.cycle));
  return { assessment: { ...current, progress: current.counts.met - (earlier?.assessment?.counts.met ?? 0) } };
}

/** A cycle with a verdict fails when its result is not met and its progress is not positive. */
export function verdictFailed(cycle: Pick<GoalCycle, "assessment">): boolean {
  return cycle.assessment !== undefined && cycle.assessment.result !== "met" && cycle.assessment.progress <= 0;
}

/** True for a pinned-autonomous finite goal whose cycle for `team` holds a current reviewed `met` assessment. */
export function provisionalStop(goal: Pick<ProductGoal, "autonomy" | "standing" | "cycles">, team: Pick<TeamView, "id" | "revision" | "assessment">): boolean {
  if (autonomyOf(goal) !== "autonomous" || goal.standing !== undefined) return false;
  if (!goal.cycles.some(item => item.teamId === team.id)) return false;
  const verdict = team.assessment;
  return verdict !== undefined && verdict.revision === team.revision && verdict.kind === "reviewed" && verdict.result === "met";
}

const ceilingOf = (goal: ProductGoal) => goal.ceilingAt ?? new Date(Date.parse(goal.createdAt) + (goal.maxTotalMinutes ?? goal.maxMinutes) * 60000).toISOString();

/** Throws TeamError before anything is admitted. */
export function assertVerdictAnswer(goal: ProductGoal, body: GoalOutcomeInput, nowMs: number): void {
  if (body.verdictId === undefined) return;
  if (!goal.cycles.some(item => item.assessment?.verdictId === body.verdictId))
    throw new TeamError(409, "verdict-not-found", "That agent assessment is not one of this goal's.");
  if (body.continue !== true) return;
  if (goal.stopReason !== "provisional-met" || newestAssessed(goal.cycles)?.assessment?.verdictId !== body.verdictId)
    throw new TeamError(409, "goal-not-provisional", "Continue applies only to a goal stopped by a provisional agent assessment.");
  if (nowMs >= Date.parse(goal.deadlineAt) || nowMs >= Date.parse(ceilingOf(goal)) || goal.memberCount >= goal.maxMembers || goal.cycles.length >= (goal.maxRuns ?? 0))
    throw new TeamError(409, "goal-limit-reached", "The goal's time, member, or feature-run allowance is spent. Start a new goal to continue.");
  const directions = [goal.objective, ...goal.steering.map(item => `User direction: ${item.text}`), `User direction: ${body.summary}`];
  if (goal.steering.length >= STEERING_ENTRIES || Buffer.byteLength(directions.join("\n\n")) > STEERING_BYTES)
    throw new TeamError(409, "goal-steering-limit", "Start a new goal with consolidated directions.");
}

/** An owner outcome on a provisional stop ends it: the host drops the stop reason and its text. Any other stop is left alone. */
export function answerProvisional(goal: Pick<ProductGoal, "stopReason" | "reason">): void {
  if (goal.stopReason !== "provisional-met") return;
  delete goal.stopReason;
  delete goal.reason;
}

/**
 * Appends body.summary as a steering entry, syncs the record with steerGoalObjective, and sets the goal running with no
 * stopReason and no reason. Returns goalObjectiveNote's text, or undefined. Never sets `achieved`.
 */
export function continueGoal(holder: GoalHolder, body: GoalOutcomeInput, at: string): string | undefined {
  const goal = holder.goal;
  goal.steering.push({ text: body.summary, revision: goal.revision, at });
  const note = goalObjectiveNote(holder, steerGoalObjective(holder, body.requestId, at));
  goal.status = "running";
  delete goal.stopReason;
  delete goal.reason;
  return note;
}

/**
 * The newest assessment's criteria that are still active in the record, in record order, for the next cycle's context.
 * {} unless the project's prompts and evaluator are on, the goal is pinned autonomous, a cycle holds an assessment, and
 * the record reads.
 */
export function criteriaRowsFor(holder: GoalHolder, project: Pick<Project, "team"> | undefined): { criteria?: CriteriaRow[] } {
  const objective = project?.team?.objective;
  if (!objectivePromptsOn(project) || objective?.evaluator !== "on") return {};
  if (autonomyOf(holder.goal) !== "autonomous") return {};
  const assessed = newestAssessed(holder.goal.cycles)?.assessment;
  if (assessed === undefined) return {};
  const state = readStoredRecord(holder.objectiveRecord, { kind: "goal", goalId: holder.goal.id });
  if (state.kind !== "ready") return {};
  const states = new Map(assessed.criteria.map(item => [item.id, item.state]));
  const configured = project?.team?.checks ?? [];
  const rows: CriteriaRow[] = [];
  for (const item of state.record.criteria) {
    const status = states.get(item.id);
    if (item.state === "active" && status !== undefined && item.latest?.verdictId === assessed.verdictId) rows.push({ criterion: item.id, status, check: checkLabel(item.check, configured) });
  }
  return rows.length === 0 ? {} : { criteria: rows };
}
