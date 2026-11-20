import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./evidence/crypto.js";
import { isScopedPath, parseCreateGoal } from "./goal-types.js";
import type { CreateGoal } from "./goal-types.js";
import { OBJECTIVE_LIMITS, thresholdSchema } from "./objective-types.js";
import type { Check, Criterion, Threshold } from "./objective-types.js";
import { objectiveError } from "./objective-record.js";
import { teamCommandSchema } from "./team-types.js";
import type { TeamCommand } from "./team-types.js";

/** Input bounds of owner corrections and creation criteria. `criterionCanonicalBytes` is checked where a criterion is built. */
export const CORRECTION_LIMITS = { ops: 16, creationCriteria: 7, version: 1_000_000, criterionCanonicalBytes: 2_048 } as const;

/** A check as an owner writes it: a command names its run, not its digest, and an artifact has no schema. */
export type CheckInput = Exclude<Check, { kind: "command" } | { kind: "artifact" }>
  | { kind: "command"; run: TeamCommand }
  | { kind: "artifact"; path: string; count?: string };
export type CriterionInput = { statement: string; check: CheckInput; threshold: Threshold; producer?: Criterion["producer"] };
export type CorrectionOp =
  | { op: "criterion.add"; criterion: CriterionInput }
  | { op: "criterion.edit"; id: string; statement?: string; check?: CheckInput; threshold?: Threshold }
  | { op: "criterion.retire"; id: string }
  | { op: "criterion.confirm"; id: string }
  | { op: "assumption.set"; id: string; status: "verified" | "refuted" }
  | { op: "rating.record"; subject: string; score: number };
/** Owner ratings run from 1 to 5 in halves, so every score is exact in binary floating point. */
export const RATING_SCALE = { min: 1, max: 5, step: 0.5 } as const;
export type Correction = { requestId: string; version: number; ops: CorrectionOp[] };

const L = OBJECTIVE_LIMITS;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const POINTER_RE = /^(?:\/[^/\x00-\x1f]{1,64}){1,8}$/;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const idSchema = z.string().regex(ID_RE);
const pointer = z.string().regex(POINTER_RE);
const pathSchema = z.string().refine(value => value.length <= L.pathChars && isScopedPath(value), "Use a repository-relative file or folder, or . for the whole project");
const statementSchema = z.string().refine(value => byteLength(value) >= 1 && byteLength(value) <= L.criterionBytes, "A criterion statement is 1 to 1,000 bytes");

const checkInputSchema = z.union([
  z.strictObject({ kind: z.literal("command"), run: teamCommandSchema }),
  z.strictObject({ kind: z.literal("receipt"), receipt: z.enum(["checks-passed", "review-approved", "merged", "landed"]) }),
  z.strictObject({ kind: z.literal("artifact"), path: pathSchema, count: pointer.optional() }),
  z.strictObject({ kind: z.enum(["citations", "citation-form"]), path: pathSchema, entries: pointer, perEntry: z.number().int().min(1).max(8) }),
  z.strictObject({ kind: z.literal("judgement"), item: idSchema }),
  z.strictObject({ kind: z.literal("owner-rating"), subject: idSchema }),
]);

export const criterionInputSchema: z.ZodType<CriterionInput> = z.strictObject({
  statement: statementSchema,
  check: checkInputSchema,
  threshold: thresholdSchema,
  producer: z.enum(["host", "evaluator", "owner"]).optional(),
});

const correctionOpSchema: z.ZodType<CorrectionOp> = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("criterion.add"), criterion: criterionInputSchema }),
  z.strictObject({
    op: z.literal("criterion.edit"),
    id: idSchema,
    statement: statementSchema.optional(),
    check: checkInputSchema.optional(),
    threshold: thresholdSchema.optional(),
  }).refine(value => value.statement !== undefined || value.check !== undefined || value.threshold !== undefined, "An edit names at least one field"),
  z.strictObject({ op: z.literal("criterion.retire"), id: idSchema }),
  z.strictObject({ op: z.literal("criterion.confirm"), id: idSchema }),
  z.strictObject({ op: z.literal("assumption.set"), id: idSchema, status: z.enum(["verified", "refuted"]) }),
  z.strictObject({
    op: z.literal("rating.record"),
    subject: idSchema,
    score: z.number().min(RATING_SCALE.min).max(RATING_SCALE.max).refine(value => Number.isInteger(value / RATING_SCALE.step), "A rating is a whole number or a half"),
  }),
]);

export const correctionSchema: z.ZodType<Correction> = z.strictObject({
  requestId: z.uuid(),
  version: z.number().int().min(1).max(CORRECTION_LIMITS.version),
  ops: z.array(correctionOpSchema).min(1).max(CORRECTION_LIMITS.ops),
}).refine(value => {
  const named = value.ops.flatMap(op => (op.op.startsWith("criterion.") && "id" in op ? [op.id] : []));
  return new Set(named).size === named.length;
}, "Each criterion is named by at most one op").refine(value => {
  const assumptions = value.ops.flatMap(op => (op.op === "assumption.set" ? [op.id] : []));
  const subjects = value.ops.flatMap(op => (op.op === "rating.record" ? [op.subject] : []));
  return new Set(assumptions).size === assumptions.length && new Set(subjects).size === subjects.length;
}, "Each assumption and each rating subject is named by at most one op");

/** SHA-256 hex of the canonical JSON of a command's program and arguments. */
export function commandDigest(command: TeamCommand): string {
  return createHash("sha256").update(canonicalJson({ command: command.command, args: command.args })).digest("hex");
}

/**
 * Splits a goal create body. `criteria` (1 to 7) is parsed here and the rest is the goal, parsed as the goal route
 * parses it, so a finite goal without `maxRuns` still gets the default.
 */
export function parseGoalCreateBody(input: unknown): { goal: CreateGoal; criteria?: CriterionInput[] } {
  if (typeof input !== "object" || input === null || !Object.hasOwn(input, "criteria")) return { goal: parseCreateGoal(input) };
  const { criteria, ...rest } = input as Record<string, unknown>;
  const parsed = z.array(criterionInputSchema).min(1).max(CORRECTION_LIMITS.creationCriteria).safeParse(criteria);
  if (!parsed.success) throw objectiveError("objective-op-invalid");
  return { goal: parseCreateGoal(rest), criteria: parsed.data };
}
