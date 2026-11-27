import { z } from "zod";

export const INTENT_REPORT_LIMITS = {
  items: 16, scouts: 3, criteria: 8, outOfScope: 24, summaryChars: 4_000,
  dimensionBytes: 200, whyBytes: 500, statementBytes: 500, refutedByBytes: 500, questionBytes: 400,
  options: 4, optionBytes: 40, defaultBytes: 200, scoutBytes: 500, testBytes: 1_024, criterionBytes: 2_048, followUpChars: 64,
} as const;

export type IntentItem = {
  dimension: string; why: string; criticality: "outcome" | "plan" | "detail"; disposition: "ask" | "scout" | "assume";
  assumption: { statement: string; refutedBy: string; test: unknown };
  question?: { text: string; options: string[]; default?: string; interrupt?: "definition" };
  scout?: string;
};

const L = INTENT_REPORT_LIMITS;
export const bytes = (max: number) => z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= max, { message: `At most ${max} bytes` });
export const boundedJson = (max: number) => z.unknown().refine(value => value !== undefined && Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= max, { message: `JSON of at most ${max} bytes` });

const questionSchema = z.object({
  text: bytes(L.questionBytes),
  options: z.array(bytes(L.optionBytes)).max(L.options),
  default: bytes(L.defaultBytes).optional(),
  interrupt: z.literal("definition").optional(),
}).strict().refine(question => (question.default === undefined) !== (question.interrupt === undefined), { message: "A question has exactly one of default and interrupt" });

export const intentItemSchema: z.ZodType<IntentItem> = z.object({
  dimension: bytes(L.dimensionBytes),
  why: bytes(L.whyBytes),
  criticality: z.enum(["outcome", "plan", "detail"]),
  disposition: z.enum(["ask", "scout", "assume"]),
  assumption: z.object({ statement: bytes(L.statementBytes), refutedBy: bytes(L.refutedByBytes), test: boundedJson(L.testBytes) }).strict(),
  question: questionSchema.optional(),
  scout: bytes(L.scoutBytes).optional(),
}).strict().superRefine((item, context) => {
  if ((item.disposition === "ask") !== (item.question !== undefined))
    context.addIssue({ code: "custom", path: ["question"], message: "An ask item has a question, and only an ask item does" });
  if ((item.disposition === "scout") !== (item.scout !== undefined))
    context.addIssue({ code: "custom", path: ["scout"], message: "A scout item names its scout, and only a scout item does" });
}) as z.ZodType<IntentItem>;

export const intentCheckReportSchema = z.object({
  kind: z.literal("intent-check"),
  summary: z.string().min(1).max(L.summaryChars),
  items: z.array(intentItemSchema).max(L.items),
  criteria: z.array(boundedJson(L.criterionBytes)).min(1).max(L.criteria).optional(),
  outOfScope: z.array(z.string().min(1).max(L.followUpChars)).max(L.outOfScope).optional(),
}).strict().superRefine((report, context) => {
  if (report.items.filter(item => item.disposition === "scout").length > L.scouts)
    context.addIssue({ code: "custom", path: ["items"], message: `At most ${L.scouts} scout items` });
});
export type IntentCheckReport = z.infer<typeof intentCheckReportSchema>;
