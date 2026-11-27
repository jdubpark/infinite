import { z } from "zod";

export const JUDGE_PACKAGE_DIR = "infinite-judge";

export const RUBRIC_V1_DIMENSIONS = ["correctness", "cleanliness", "extensibility", "docs"] as const;
const score = z.number().int().min(1).max(5);
export const judgeScoresSchema = z.object({ correctness: score, cleanliness: score, extensibility: score, docs: score }).strict();
export const judgementReportSchema = z.object({
  kind: z.literal("judgement"),
  duelId: z.uuid(),
  preferred: z.enum(["A", "B", "tie"]),
  rubric: z.object({ a: judgeScoresSchema, b: judgeScoresSchema }).strict(),
  summary: z.string().trim().min(1).max(2000),
}).strict();
export type JudgeScores = z.infer<typeof judgeScoresSchema>;
export type JudgementReport = z.infer<typeof judgementReportSchema>;
export type Judgement = { preferred: "A" | "B" | "tie"; rubric: { a: JudgeScores; b: JudgeScores } };
export const JUDGE_ENDINGS = ["judged", "no-result", "question", "blocked", "permission", "stalled", "changed", "mismatch", "timeout", "void-limit", "void-host", "void-owner"] as const;
export type JudgeEnding = typeof JUDGE_ENDINGS[number];
export const JUDGE_VOID_ENDINGS: readonly JudgeEnding[] = ["void-limit", "void-host", "void-owner"];
