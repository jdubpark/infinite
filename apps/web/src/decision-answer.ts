import type { QueueDecisionRecord } from "./api";

export function formatDecisionAnswer(answers: readonly string[], answerMode?: QueueDecisionRecord["answerMode"]): string {
  if (answerMode !== "multiple") return answers[0] ?? "";
  return answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
}
