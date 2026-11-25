import type { GoalCycle, ProductGoal } from "./goal-types.js";
import { verdictIdsOf } from "./goal-verdicts.js";
import type { ReceiptOutcome } from "./objective-receipts.js";
import type { VerdictDetail } from "./team-verdicts.js";
import type { AssessedState, ComposedState, CriterionReason, VerdictCounts, VerdictReason } from "./verdict-types.js";

export const VERDICT_LABEL = "Agent assessment, provisional";

export type GoalVerdictView = {
  cycle: number; teamId: string; verdictId: string; kind: "reviewed" | "no-change"; head: string; at: string;
  label: typeof VERDICT_LABEL;
  result: AssessedState; evaluatorResult?: AssessedState; differs: boolean; reason?: VerdictReason; counts: VerdictCounts; progress: number;
  /** The owner outcome that names this verdict. */
  owner?: { result: "achieved" | "not-achieved" | "inconclusive"; agrees?: boolean };
  criteria: {
    id: string; producer: "host" | "evaluator" | "owner"; state: ComposedState;
    label: "host receipt" | "agent assessment" | "waiting for you" | "your rating";
    reason?: CriterionReason; evaluatorState?: AssessedState; receipt?: { handle: string; outcome: ReceiptOutcome };
    handles?: string[]; note?: string;
  }[];
  evaluator?: { profileId: string; family: string; sharedFamily: boolean; alsoReviewed: boolean };
  /** `expired`: the run's record is gone; only the cycle's summary remains. */
  detail: "available" | "expired";
};

type Criterion = GoalVerdictView["criteria"][number];

function labelOf(criterion: VerdictDetail["criteria"][number]): Criterion["label"] {
  if (criterion.state === "pending-owner") return "waiting for you";
  if (criterion.producer === "host") return "host receipt";
  return criterion.producer === "owner" ? "your rating" : "agent assessment";
}

function criterionView(criterion: VerdictDetail["criteria"][number]): Criterion {
  return {
    id: criterion.id,
    producer: criterion.producer,
    state: criterion.state,
    label: labelOf(criterion),
    ...(criterion.reason === undefined ? {} : { reason: criterion.reason }),
    ...(criterion.evaluatorState === undefined ? {} : { evaluatorState: criterion.evaluatorState }),
    ...(criterion.receipt === undefined ? {} : { receipt: criterion.receipt }),
    ...(criterion.handles.length === 0 ? {} : { handles: criterion.handles }),
    ...(criterion.note === undefined ? {} : { note: criterion.note }),
  };
}

/** The newest outcome that names any of the cycle's verdict ids. Agreement needs the current id: met with achieved, or not-met with not-achieved. */
function ownerOf(goal: ProductGoal, cycle: GoalCycle, result: AssessedState): GoalVerdictView["owner"] {
  const ids = verdictIdsOf(cycle);
  const outcome = [...goal.outcomes].reverse().find(item => item.verdictId !== undefined && ids.includes(item.verdictId));
  if (outcome === undefined) return undefined;
  const agrees = outcome.verdictId === ids[0] && ((result === "met" && outcome.result === "achieved") || (result === "not-met" && outcome.result === "not-achieved"));
  return { result: outcome.result, ...(agrees ? { agrees: true } : {}) };
}

/**
 * The goal's cycle assessments joined with each run's detail while the run's record lasts, and with the owner's answers.
 * Pure: it reads one goal view and at most one in-memory detail per cycle.
 */
export function goalVerdictsView(goal: ProductGoal, details: (teamId: string) => VerdictDetail | undefined): { verdicts: GoalVerdictView[] } {
  const verdicts: GoalVerdictView[] = [];
  for (const cycle of goal.cycles) {
    const { assessment } = cycle;
    if (assessment === undefined) continue;
    const found = details(cycle.teamId);
    const detail = found !== undefined && found.verdictId === assessment.verdictId ? found : undefined;
    const owner = ownerOf(goal, cycle, assessment.result);
    const evaluator = detail?.evaluator;
    verdicts.push({
      cycle: cycle.cycle, teamId: cycle.teamId, verdictId: assessment.verdictId, kind: assessment.kind, head: assessment.head, at: assessment.at,
      label: VERDICT_LABEL,
      result: assessment.result,
      ...(assessment.evaluatorResult === undefined ? {} : { evaluatorResult: assessment.evaluatorResult }),
      differs: assessment.evaluatorResult !== undefined && assessment.evaluatorResult !== assessment.result,
      ...(assessment.reason === undefined ? {} : { reason: assessment.reason }),
      counts: assessment.counts,
      progress: assessment.progress,
      ...(owner === undefined ? {} : { owner }),
      criteria: detail === undefined ? [] : detail.criteria.map(criterionView),
      ...(evaluator === undefined ? {} : {
        evaluator: { profileId: evaluator.profileId, family: evaluator.family, sharedFamily: evaluator.sharedFamily, alsoReviewed: evaluator.alsoReviewed },
      }),
      detail: detail === undefined ? "expired" : "available",
    });
  }
  return { verdicts };
}
