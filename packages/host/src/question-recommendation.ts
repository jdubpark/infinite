import { z } from "zod";

export const questionRecommendationSchema = z.object({
  answers: z.array(z.string().min(1).max(500)).min(1).max(4),
  reason: z.string().trim().min(1).max(300),
}).strict();
export type QuestionRecommendation = z.infer<typeof questionRecommendationSchema>;
export const RECOMMENDATION_REQUIRED = `A question needs "recommendation": {"answers": ["the answer you would give"], "reason": "one line why"}. Copy option text exactly into "answers", one option unless answerMode is "multiple"; for a question without options, give one short answer in words.`;
export const requiredQuestionRecommendationSchema = z.object(questionRecommendationSchema.shape,
  { error: issue => issue.input === undefined ? RECOMMENDATION_REQUIRED : undefined }).strict();
export type QuestionAnswerMode = "approval" | "single" | "multiple";
export type RecommendationOutcome = "matched" | "different" | "other";
export type DecisionRecommendation = QuestionRecommendation & { outcome?: RecommendationOutcome };

type Question = { options: readonly string[]; recommendation?: QuestionRecommendation };
export type QuestionProblem = { path: "options" | "recommendation"; message: string };

export function questionProblem(question: Question, mode: QuestionAnswerMode | "inherited" | undefined): QuestionProblem | undefined {
  const { options } = question, answers = question.recommendation?.answers;
  const about = (path: QuestionProblem["path"], message: string): QuestionProblem => ({ path, message });
  if (mode === "approval" && options.length !== 2) return about("options", "Approval questions require exactly two options: approve first and deny second.");
  if (mode === "multiple" && options.length < 2) return about("options", "Multiple-selection questions require at least two options.");
  if (!answers) return undefined;
  if (new Set(answers).size !== answers.length) return about("recommendation", "The recommendation repeats an answer.");
  if (options.length === 0) return answers.length === 1 ? undefined : about("recommendation", "A question without options takes exactly one recommended answer.");
  if (answers.some(answer => !options.includes(answer))) return about("recommendation", "Each recommended answer must equal one of the options exactly.");
  if (mode !== "multiple" && mode !== "inherited" && answers.length !== 1) return about("recommendation", "Recommend exactly one option unless the question is a multiple-selection question.");
  return undefined;
}

export function refineQuestion(report: Question & { answerMode?: QuestionAnswerMode; childDecisionId?: string }, context: z.RefinementCtx): void {
  const problem = questionProblem(report, report.answerMode ?? (report.childDecisionId ? "inherited" : undefined));
  if (problem) context.addIssue({ code: "custom", path: [problem.path], message: problem.message });
}

const plain = (text: string) => text.replace(/\r\n/g, "\n").trim();

function orderedSelections(options: readonly string[], chosen: readonly number[] = []): string[][] {
  return options.flatMap((_, index) => {
    if (chosen.includes(index)) return [];
    const next = [...chosen, index];
    return [next.map(position => options[position]), ...orderedSelections(options, next)];
  });
}

function selectedOptions(options: readonly string[], answer: string): Set<string> | undefined {
  const reply = plain(answer);
  const numbered = (selection: readonly string[]) => selection.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const readings = [
    ...options.filter(option => plain(option) === reply).map(option => [option]),
    ...orderedSelections(options).filter(selection => plain(numbered(selection)) === reply),
  ].map(selection => [...new Set(selection.map(plain))].sort());
  return new Set(readings.map(reading => JSON.stringify(reading))).size === 1 ? new Set(readings[0]) : undefined;
}

export function recommendationOutcome(options: readonly string[], recommendation: QuestionRecommendation, answer: string): RecommendationOutcome {
  const recommended = new Set(recommendation.answers.map(plain));
  if (options.length === 0) return recommended.has(plain(answer)) ? "matched" : "other";
  const selected = selectedOptions(options, answer);
  if (!selected) return "other";
  return selected.size === recommended.size && [...recommended].every(item => selected.has(item)) ? "matched" : "different";
}

export const recommendationLine = (recommendation: QuestionRecommendation) =>
  `The asking agent recommends: ${recommendation.answers.join("; ")}. Reason: ${recommendation.reason}`;
