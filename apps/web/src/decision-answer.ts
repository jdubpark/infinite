import type { QueueDecisionRecord } from "./api";

type AnswerMode = QueueDecisionRecord["answerMode"];

/**
 * The options in the order a client lists them: the agent's recommended answers first, then the rest as asked.
 * An approval question keeps its own order, because its first option approves and its second denies.
 */
export function decisionChoices(options: readonly string[], recommended: readonly string[] = [], answerMode?: AnswerMode): string[] {
  const first = answerMode === "approval" && options.length > 0 ? [] : [...new Set(recommended)];
  return [...first, ...options.filter(option => !first.includes(option))];
}

export function formatDecisionAnswer(answers: readonly string[], answerMode?: AnswerMode): string {
  if (answerMode !== "multiple") return answers[0] ?? "";
  return answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
}
