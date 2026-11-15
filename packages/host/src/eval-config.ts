import { z } from "zod";

export const EVAL_RETENTION_DAYS_DEFAULT = 365;

// Repeats the `ownedPath` rule of team-types.ts. Kept here so team-types can import this module without a cycle.
const repositoryPrefix = z.string().min(1).max(200)
  .refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === ".git" || part === "." || part === ""), "Use a repository-relative path without a leading slash, empty, '.', '..', or '.git' segment")
  .refine(value => !/[*?\[\]:]/.test(value), "Use a path without glob syntax");

const pathSuffix = z.string().min(1).max(64).refine(value => !value.includes("/") && !value.includes("\\") && !value.includes("\0"), "Use a file-name suffix without a path separator");

export const evalProjectSchema = z.object({
  /** Turns capture on. Read only for a GitHub project (see captureSettings). */
  capture: z.boolean().optional(),
  /** Paths whose files count as tests. Without it the host rule `isTestPath` applies. */
  testPaths: z.object({
    prefixes: z.array(repositoryPrefix).max(32),
    suffixes: z.array(pathSuffix).max(32),
  }).strict().refine(paths => paths.prefixes.length + paths.suffixes.length > 0, "Configure at least one test path prefix or suffix").optional(),
  /** Feature-map area ids whose tasks never enter the corpus (spec part 9). */
  excludeAreas: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(32).optional(),
  retentionDays: z.number().int().min(30).max(3650).optional(),
}).strict();

export type EvalProjectSettings = z.infer<typeof evalProjectSchema>;

/** The settings when the project turned capture on and follows GitHub; otherwise undefined. */
export function captureSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined {
  const eval_ = project?.team?.eval;
  if (eval_?.capture !== true || project?.source?.mode !== "github") return undefined;
  return eval_;
}
