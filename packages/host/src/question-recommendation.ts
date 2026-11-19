import { z } from "zod";

/**
 * What the asking agent would answer, and why. A recommendation is evidence shown beside a question. The answer stays
 * with whoever may answer the question: nothing answers a question with its recommendation.
 */
export const questionRecommendationSchema = z.object({
  /**
   * The recommended answer. For a question with options: option texts copied exactly, one of them, or several only
   * for a multiple-selection question. For a question without options: one short answer in words.
   */
  answers: z.array(z.string().min(1).max(500)).min(1).max(4),
  /** One line: why this answer. */
  reason: z.string().trim().min(1).max(300),
}).strict();
export type QuestionRecommendation = z.infer<typeof questionRecommendationSchema>;
/** What a question without a recommendation is told. A member whose prompt predates recommendations reads only this. */
export const RECOMMENDATION_REQUIRED = `A question needs "recommendation": {"answers": ["the answer you would give"], "reason": "one line why"}. Copy option text exactly into "answers", one option unless answerMode is "multiple"; for a question without options, give one short answer in words.`;
/** The report tools' form of the field: required, and refused with the shape to send when it is missing. */
export const requiredQuestionRecommendationSchema = z.object(questionRecommendationSchema.shape,
  { error: issue => issue.input === undefined ? RECOMMENDATION_REQUIRED : undefined }).strict();
export type QuestionAnswerMode = "approval" | "single" | "multiple";
/** How an answer compared with the recommendation: the same, another option, or words that are neither. */
export type RecommendationOutcome = "matched" | "different" | "other";
/** A recommendation as a decision records it. `outcome` is set when the decision is answered. */
export type DecisionRecommendation = QuestionRecommendation & { outcome?: RecommendationOutcome };

type Question = { options: readonly string[]; recommendation?: QuestionRecommendation };
/** The field a refused question must change, and why. */
export type QuestionProblem = { path: "options" | "recommendation"; message: string };

/**
 * Why a question's options, mode and recommendation do not fit together, or undefined when they do. Team and mission
 * question reports share these rules. `inherited` is a forwarded question that names no mode: it takes the subteam
 * decision's mode, which only the host knows, so the rules that depend on the mode wait for the host's own call.
 */
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

/** The refinement of both question report schemas. */
export function refineQuestion(report: Question & { answerMode?: QuestionAnswerMode; childDecisionId?: string }, context: z.RefinementCtx): void {
  const problem = questionProblem(report, report.answerMode ?? (report.childDecisionId ? "inherited" : undefined));
  if (problem) context.addIssue({ code: "custom", path: [problem.path], message: problem.message });
}

const same = (left: string, right: string) => left.trim() === right.trim();

/**
 * The options a multiple selection names. It is written as numbered lines ("1. text") in the order chosen, each with
 * the option's text as the question gave it, which may itself span lines. Undefined when the text is not that.
 */
function numberedOptions(options: readonly string[], text: string, chosen: readonly string[] = []): string[] | undefined {
  if (!text) return chosen.length ? [...chosen] : undefined;
  const number = /^\d+\. /.exec(text)?.[0];
  if (!number) return undefined;
  const rest = text.slice(number.length);
  for (const option of options) {
    const after = rest.startsWith(option) ? rest.slice(option.length) : undefined;
    if (after === undefined || (after && after[0] !== "\n")) continue;
    const found = numberedOptions(options, after.slice(1), [...chosen, option]);
    if (found) return found;
  }
  return undefined;
}

/**
 * The options an answer text selects: the option it equals, exactly before apart from surrounding spaces, or the
 * options of a multiple selection. Undefined when the text is neither.
 */
function selectedOptions(options: readonly string[], answer: string): Set<string> | undefined {
  const whole = options.find(option => option === answer) ?? options.find(option => same(option, answer));
  if (whole !== undefined) return new Set([whole]);
  const lines = answer.replace(/\r\n/g, "\n");
  const numbered = numberedOptions(options, lines) ?? numberedOptions(options, lines.trim());
  return numbered && new Set(numbered);
}

/**
 * How an answer compares with a recommendation. A question without options matches only word for word, as when a
 * client sends the recommended answer itself; any other text is `other`, because the host does not judge whether
 * free text agrees.
 */
export function recommendationOutcome(options: readonly string[], recommendation: QuestionRecommendation, answer: string): RecommendationOutcome {
  const recommended = recommendation.answers;
  if (options.length === 0) return recommended.some(item => same(item, answer)) ? "matched" : "other";
  const selected = selectedOptions(options, answer);
  if (!selected) return "other";
  return selected.size === recommended.length && recommended.every(item => selected.has(item)) ? "matched" : "different";
}

/** The one line every text surface prints for a recommendation. It names the agent, so it never reads as the owner's choice. */
export const recommendationLine = (recommendation: QuestionRecommendation) =>
  `The asking agent recommends: ${recommendation.answers.join("; ")}. Reason: ${recommendation.reason}`;
