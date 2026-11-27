import type { QueueDecisionRecord } from "./api";

type AnswerMode = QueueDecisionRecord["answerMode"];

export function decisionChoices(options: readonly string[], recommended: readonly string[] = [], answerMode?: AnswerMode): string[] {
  const first = answerMode === "approval" && options.length > 0 ? [] : [...new Set(recommended)];
  return [...first, ...options.filter(option => !first.includes(option))];
}

export function formatDecisionAnswer(answers: readonly string[], answerMode?: AnswerMode): string {
  if (answerMode !== "multiple") return answers[0] ?? "";
  return answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
}
