import { z } from "zod";
import {
  ASSESSED_STATES,
  COMPOSED_STATES,
  CRITERIA_LABEL_BYTES,
  CRITERIA_ROWS_MAX,
  ID_RE,
  criteriaRowSchema,
  criteriaRowsSchema,
  criteriaRowsText,
  type AssessedState,
  type ComposedState,
  type CriteriaRow,
} from "./schema-primitives.js";

export {
  criteriaRowSchema,
  criteriaRowsSchema,
  criteriaRowsText,
  type AssessedState,
  type ComposedState,
  type CriteriaRow,
};

export const VERDICT_LIMITS = { criteria: CRITERIA_ROWS_MAX, handles: 8, handleChars: 400, noteBytes: 500, labelBytes: CRITERIA_LABEL_BYTES } as const;
const L = VERDICT_LIMITS;
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export type DeliveryFact = "none" | "landed" | "reverted";

export const verdictReportSchema = z.object({
  kind: z.literal("verdict"),
  result: z.enum(ASSESSED_STATES),
  criteria: z.array(z.object({
    id: z.string().regex(ID_RE),
    state: z.enum(ASSESSED_STATES),
    evidence: z.array(z.string().min(1).max(L.handleChars)).max(L.handles),
    note: z.string().optional(),
  }).strict()).min(1).max(L.criteria),
}).strict().superRefine((report, context) => {
  const seen = new Set<string>();
  report.criteria.forEach((item, index) => {
    if (seen.has(item.id)) context.addIssue({ code: "custom", path: ["criteria", index, "id"], message: "Each criterion id appears once" });
    seen.add(item.id);
    if (item.note !== undefined && (byteLength(item.note) < 1 || byteLength(item.note) > L.noteBytes))
      context.addIssue({ code: "custom", path: ["criteria", index, "note"], message: `A note is 1 to ${L.noteBytes} bytes` });
  });
});
export type VerdictReport = z.infer<typeof verdictReportSchema>;

export type VerdictReason = "no-independent-evaluator" | "evaluator-unavailable" | "record-unavailable" | "context-too-large";
export type CriterionReason = "no-receipt" | "receipt-unknown" | "before-delivery" | "pinned-changed" | "unresolved-evidence" | "not-assessed" | "no-evaluator";
export type VerdictCounts = { met: number; notMet: number; inconclusive: number; pendingOwner: number };

export type RunAssessment = {
  verdictId: string; revision: number; head: string; kind: "reviewed" | "no-change";
  result: AssessedState; evaluatorResult?: AssessedState; reason?: VerdictReason;
  counts: VerdictCounts; criteria: { id: string; state: ComposedState }[]; at: string;
};

const countSchema = z.number().int().min(0).max(L.criteria);
export const runAssessmentSchema: z.ZodType<RunAssessment> = z.object({
  verdictId: z.uuid(),
  revision: z.number().int().min(1),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  kind: z.enum(["reviewed", "no-change"]),
  result: z.enum(ASSESSED_STATES),
  evaluatorResult: z.enum(ASSESSED_STATES).optional(),
  reason: z.enum(["no-independent-evaluator", "evaluator-unavailable", "record-unavailable", "context-too-large"]).optional(),
  counts: z.object({ met: countSchema, notMet: countSchema, inconclusive: countSchema, pendingOwner: countSchema }).strict(),
  criteria: z.array(z.object({ id: z.string().regex(ID_RE), state: z.enum(COMPOSED_STATES) }).strict()).max(L.criteria),
  at: z.iso.datetime(),
}).strict();
