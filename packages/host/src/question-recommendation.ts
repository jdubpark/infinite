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

/** An answer arrives trimmed, and a client may send its line ends either way. Option text is compared in the same form. */
const plain = (text: string) => text.replace(/\r\n/g, "\n").trim();

/**
 * Every ordered choice of one or more options, each chosen once. Options are told apart by position, because two may
 * carry the same text. A question has four options at most, so 64 choices at most.
 */
function orderedSelections(options: readonly string[], chosen: readonly number[] = []): string[][] {
  return options.flatMap((_, index) => {
    if (chosen.includes(index)) return [];
    const next = [...chosen, index];
    return [next.map(position => options[position]), ...orderedSelections(options, next)];
  });
}

/**
 * The options an answer selects, in their plain form. An answer is one option's text, or a multiple selection as a
 * client writes it: numbered lines ("1. text") in the order chosen. The answer is compared with each selection written
 * that way, so its length never drives the work. Undefined when the answer is neither, or reads as two different
 * selections, as it can when one option's text looks like numbered lines. Options that differ only in surrounding
 * spaces are one answer, because the answer's own were trimmed.
 */
function selectedOptions(options: readonly string[], answer: string): Set<string> | undefined {
  const reply = plain(answer);
  const numbered = (selection: readonly string[]) => selection.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const readings = [
    ...options.filter(option => plain(option) === reply).map(option => [option]),
    ...orderedSelections(options).filter(selection => plain(numbered(selection)) === reply),
  ].map(selection => [...new Set(selection.map(plain))].sort());
  return new Set(readings.map(reading => JSON.stringify(reading))).size === 1 ? new Set(readings[0]) : undefined;
}

/**
 * How an answer compares with a recommendation. A question without options matches only word for word, as when a
 * client sends the recommended answer itself; any other text is `other`, because the host does not judge whether
 * free text agrees.
 */
export function recommendationOutcome(options: readonly string[], recommendation: QuestionRecommendation, answer: string): RecommendationOutcome {
  const recommended = new Set(recommendation.answers.map(plain));
  if (options.length === 0) return recommended.has(plain(answer)) ? "matched" : "other";
  const selected = selectedOptions(options, answer);
  if (!selected) return "other";
  return selected.size === recommended.size && [...recommended].every(item => selected.has(item)) ? "matched" : "different";
}

/** The one line every text surface prints for a recommendation. It names the agent, so it never reads as the owner's choice. */
export const recommendationLine = (recommendation: QuestionRecommendation) =>
  `The asking agent recommends: ${recommendation.answers.join("; ")}. Reason: ${recommendation.reason}`;
