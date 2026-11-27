import { z } from "zod";

export const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const idSchema = z.string().regex(ID_RE);

export const OWNED_PATH_MAX_CHARS = 300;

export const SHARED_INPUT_LIMITS = {
  goalObjectiveChars: 12_000,
  runObjectiveChars: 24_000,
  goalSuccessCriteriaChars: 4_000,
  goalContextSuccessCriteriaChars: 8_000,
  nonGoals: 20,
  nonGoalChars: 1_000,
  allowedPaths: 32,
  pathChars: OWNED_PATH_MAX_CHARS,
  evidence: 20,
  evidenceChars: 2_000,
  steeringChars: 8_000,
  steeringEntries: 20,
  goalPayloadBytes: 40_000,
  goalSteeringBytes: 24_000,
} as const;

export function isOwnedPathSegmentSafe(value: string): boolean {
  return !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.split("/").some(part => part === ".." || part === ".git" || part === "." || part === "");
}

export function hasNoGlobChars(value: string): boolean {
  return !/[*?\[\]:]/.test(value);
}

export function isOwnedPath(value: string): boolean {
  return isOwnedPathSegmentSafe(value) && hasNoGlobChars(value);
}

export function isScopedPath(value: string): boolean {
  return value === "." || isOwnedPath(value);
}

export function ownedPathSchemaFor(maxChars: number, options?: { segmentMessage?: string; globMessage?: string }) {
  const base = z.string().min(1).max(maxChars)
    .refine(isOwnedPathSegmentSafe, options?.segmentMessage ?? "Use a repository-relative file or directory without glob syntax");
  return options?.globMessage !== undefined ? base.refine(hasNoGlobChars, options.globMessage) : base.refine(hasNoGlobChars);
}

export const ownedPathSchema = ownedPathSchemaFor(OWNED_PATH_MAX_CHARS);

export const teamCommandSchema = z.object({
  command: z.string().min(1).max(4096).refine(value => !value.includes("\0")),
  args: z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(64).default([]),
}).strict();
export type TeamCommand = z.infer<typeof teamCommandSchema>;

export const CRITERIA_ROWS_MAX = 8;
export const CRITERIA_LABEL_BYTES = 120;
export const ASSESSED_STATES = ["met", "not-met", "inconclusive"] as const;
export const COMPOSED_STATES = ["met", "not-met", "inconclusive", "pending-owner"] as const;
export type AssessedState = typeof ASSESSED_STATES[number];
export type ComposedState = typeof COMPOSED_STATES[number];

export const criteriaRowSchema = z.object({
  criterion: z.string().regex(ID_RE),
  status: z.enum(COMPOSED_STATES),
  check: z.string().refine(
    value => Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= CRITERIA_LABEL_BYTES,
    { message: `A label is 1 to ${CRITERIA_LABEL_BYTES} bytes` },
  ),
}).strict();
export type CriteriaRow = z.infer<typeof criteriaRowSchema>;
export const criteriaRowsSchema = z.array(criteriaRowSchema).min(1).max(CRITERIA_ROWS_MAX);

export function criteriaRowsText(rows: readonly CriteriaRow[]): string {
  return ["Agent assessment, provisional, of the latest assessed cycle:", ...rows.map(row => `- ${row.criterion}: ${row.status} (${row.check})`)].join("\n");
}
