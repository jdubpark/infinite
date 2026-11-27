import type { AssessedState, ComposedState, GoalAssessment, VerdictCounts } from "../../api/client";
import type { GoalCycle, GoalResult, ProductGoal } from "./model";

export const ASSESSMENT_LABEL = "Agent assessment, provisional";
export const REMOTE_CRITERIA_NOTE = "Per-criterion verdict details are unavailable over remote access. View them in the web client or with infinite goal verdicts.";
export const ASSESSED_LABELS: Record<AssessedState, string> = { met: "Met", "not-met": "Not met", inconclusive: "Inconclusive" };
export type AssessedGoal = Omit<ProductGoal, "cycles" | "outcomes"> & {
  stopReason?: "deadline" | "member-limit" | "provisional-met";
  cycles: (GoalCycle & { assessment?: GoalAssessment })[];
  outcomes: { result: GoalResult; summary: string; evidence: string; at: string; revision: number; verdictId?: string }[];
};

export const countsText = (counts: VerdictCounts) => `${counts.met} met · ${counts.notMet} not met · ${counts.inconclusive} inconclusive · ${counts.pendingOwner} waiting for you`;
export const resultText = (assessment: Pick<GoalAssessment, "result" | "evaluatorResult">) =>
  `Result: ${ASSESSED_LABELS[assessment.result]}${assessment.evaluatorResult && assessment.evaluatorResult !== assessment.result ? ` · The evaluator’s own result: ${ASSESSED_LABELS[assessment.evaluatorResult]}` : ""}`;
export const criterionState = (state: ComposedState) => state === "pending-owner" ? "Waiting for you" : ASSESSED_LABELS[state];
export const newestVerdictId = (cycles: { assessment?: GoalAssessment }[]) => [...cycles].reverse().find(cycle => cycle.assessment)?.assessment?.verdictId;
export const ownerOutcomeLabel = (outcome: { verdictId?: string }, label: string) => outcome.verdictId ? `Your assessment: ${label}` : label;
export const awaitsProvisionalAnswer = (goal: Pick<AssessedGoal, "stopReason" | "status" | "cycles">) =>
  goal.stopReason === "provisional-met" && goal.status !== "achieved" && newestVerdictId(goal.cycles) !== undefined;
