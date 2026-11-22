import { z } from "zod";

/** The record's ID_RE, copied: team-types loads this module, and importing objective-types here would close an import cycle. */
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

export const VERDICT_LIMITS = { criteria: 8, handles: 8, handleChars: 400, noteBytes: 500, labelBytes: 120 } as const;
const L = VERDICT_LIMITS;
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export type AssessedState = "met" | "not-met" | "inconclusive";
export type ComposedState = AssessedState | "pending-owner";

const assessedStates = ["met", "not-met", "inconclusive"] as const;
const composedStates = ["met", "not-met", "inconclusive", "pending-owner"] as const;

/** The evaluator's report. Notes and handles are evaluator text: they are screened and sealed, never shown. */
export const verdictReportSchema = z.object({
  kind: z.literal("verdict"),
  result: z.enum(assessedStates),
  criteria: z.array(z.object({
    id: z.string().regex(ID_RE),
    state: z.enum(assessedStates),
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

/** Why a verdict has no evaluator answer. */
export type VerdictReason = "no-independent-evaluator" | "evaluator-unavailable" | "record-unavailable" | "context-too-large";
/** Why one criterion is inconclusive or waits. */
export type CriterionReason = "no-receipt" | "receipt-unknown" | "before-delivery" | "pinned-changed" | "unresolved-evidence" | "not-assessed" | "no-evaluator";
export type VerdictCounts = { met: number; notMet: number; inconclusive: number; pendingOwner: number };

/** The run's summary: ids, enumerations, and counts only. It reaches every team view and relay device. */
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
  result: z.enum(assessedStates),
  evaluatorResult: z.enum(assessedStates).optional(),
  reason: z.enum(["no-independent-evaluator", "evaluator-unavailable", "record-unavailable", "context-too-large"]).optional(),
  counts: z.object({ met: countSchema, notMet: countSchema, inconclusive: countSchema, pendingOwner: countSchema }).strict(),
  criteria: z.array(z.object({ id: z.string().regex(ID_RE), state: z.enum(composedStates) }).strict()).max(L.criteria),
  at: z.iso.datetime(),
}).strict();

/** One criterion row of the coordinator's prompt: id, status, and the record digest's check label. No note, score, or threshold. */
export const criteriaRowSchema = z.object({
  criterion: z.string().regex(ID_RE),
  status: z.enum(composedStates),
  check: z.string().refine(value => byteLength(value) >= 1 && byteLength(value) <= L.labelBytes, { message: `A label is 1 to ${L.labelBytes} bytes` }),
}).strict();
export type CriteriaRow = z.infer<typeof criteriaRowSchema>;
export const criteriaRowsSchema = z.array(criteriaRowSchema).min(1).max(L.criteria);

/**
 * The coordinator's lines for the rows: id, status, and check label, led by the label that marks them an agent assessment.
 * It lives here, not beside the evaluator's prompt, so team-prompts can import it without an import cycle.
 */
export function criteriaRowsText(rows: readonly CriteriaRow[]): string {
  return ["Agent assessment, provisional, of the latest assessed cycle:", ...rows.map(row => `- ${row.criterion}: ${row.status} (${row.check})`)].join("\n");
}
