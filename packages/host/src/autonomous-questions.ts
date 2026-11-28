import { z } from "zod";
import type { AutonomyMode } from "./autonomy.js";
import type { QuestionAnswerMode, QuestionRecommendation } from "./question-recommendation.js";

export const QUESTION_INTERRUPT_KINDS = ["definition", "authority", "irreversible"] as const;
export type QuestionInterruptKind = (typeof QUESTION_INTERRUPT_KINDS)[number];
export const questionInterruptSchema = z.enum(QUESTION_INTERRUPT_KINDS);

export type AutonomousQuestionDecision =
  | { action: "continue"; answer: string; reason: string }
  | { action: "wait" };

export function evaluateAutonomousQuestion(input: {
  autonomy: AutonomyMode;
  answerMode?: QuestionAnswerMode;
  interrupt?: QuestionInterruptKind;
  recommendation?: QuestionRecommendation;
  hasChildDecision?: boolean;
}): AutonomousQuestionDecision {
  if (
    input.autonomy !== "autonomous"
    || input.answerMode === "approval"
    || input.interrupt !== undefined
    || input.hasChildDecision === true
    || !input.recommendation
    || input.recommendation.answers.length === 0
  ) {
    return { action: "wait" };
  }
  return {
    action: "continue",
    answer: input.recommendation.answers.join("\n"),
    reason: input.recommendation.reason,
  };
}
