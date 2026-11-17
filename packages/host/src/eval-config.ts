import { isAbsolute } from "node:path";
import { z } from "zod";

export const EVAL_RETENTION_DAYS_DEFAULT = 365;
export const GRADING_PATHS_MAX = 64;
export const GUARD_CHECKS_MAX = 8;
export const GRADER_CANARIES_MAX = 32;
export const FILES_PLACEHOLDER = "{files}";
export const REPORT_PLACEHOLDER = "{report}";

// Repeats the `ownedPath` rule of team-types.ts. Kept here so team-types can import this module without a cycle.
const repositoryPrefix = z.string().min(1).max(200)
  .refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === ".git" || part === "." || part === ""), "Use a repository-relative path without a leading slash, empty, '.', '..', or '.git' segment")
  .refine(value => !/[*?\[\]:]/.test(value), "Use a path without glob syntax");

const pathSuffix = z.string().min(1).max(64).refine(value => !value.includes("/") && !value.includes("\\") && !value.includes("\0"), "Use a file-name suffix without a path separator");

// Repeats the `teamCommandSchema` shape of team-types.ts, for the same no-cycle reason.
const command = z.object({
  command: z.string().min(1).max(4096).refine(value => !value.includes("\0")),
  args: z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(64).default([]),
}).strict();

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

const focusedTest = command
  .refine(test => !test.command.includes(FILES_PLACEHOLDER) && !test.command.includes(REPORT_PLACEHOLDER), "Keep {files} and {report} out of the command")
  .refine(test => test.args.filter(arg => arg === FILES_PLACEHOLDER).length === 1 && countOf(test.args.join("\0"), FILES_PLACEHOLDER) === 1, "Use {files} as exactly one whole argument")
  .refine(test => countOf(test.args.join("\0"), REPORT_PLACEHOLDER) === 1, "Use {report} exactly once in the arguments");

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
  /** Turns mining on. Read only for a GitHub project (see mineSettings). */
  mine: z.boolean().optional(),
  /** Repository path prefixes that a grading run takes from the reference. */
  gradingPaths: z.array(repositoryPrefix).max(GRADING_PATHS_MAX).optional(),
  /** The focused test a validation round runs. `{files}` and `{report}` are placeholders. */
  focusedTest: focusedTest.optional(),
  reportFormat: z.enum(["junit", "tap"]).optional(),
  guardChecks: z.array(command).max(GUARD_CHECKS_MAX).optional(),
}).strict();

export type EvalProjectSettings = z.infer<typeof evalProjectSchema>;

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value), "Use an absolute path");

const graderSchema = z.object({
  prefix: command,
  root: absolutePath,
  canaries: z.array(absolutePath).max(GRADER_CANARIES_MAX).optional(),
}).strict();

/** The host's replay eval block. Outside the routine approval digest. */
export const evalHostSchema = z.object({ grader: graderSchema.optional() }).strict();
export type EvalHostConfig = z.infer<typeof evalHostSchema>;
export type EvalGraderConfig = z.infer<typeof graderSchema>;

export type ValidationSettings = {
  focusedTest: { command: string; args: string[] }; reportFormat: "junit" | "tap";
  gradingPaths: string[]; guardChecks: { command: string; args: string[] }[]; setup?: { command: string; args: string[] };
};

/** The settings when the project turned capture on and follows GitHub; otherwise undefined. */
export function captureSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined {
  const eval_ = project?.team?.eval;
  if (eval_?.capture !== true || project?.source?.mode !== "github") return undefined;
  return eval_;
}

/** The settings when the project turned mining on and follows GitHub; otherwise undefined. */
export function mineSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined {
  const eval_ = project?.team?.eval;
  if (eval_?.mine !== true || project?.source?.mode !== "github") return undefined;
  return eval_;
}

/** What a validate job needs, or the first missing key in the order source, focusedTest, reportFormat. */
export function validationSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings; checks?: { command: string; args: string[] }[]; setup?: { command: string; args: string[] } } } | undefined):
  { settings: ValidationSettings } | { missing: "source" | "focusedTest" | "reportFormat" } {
  if (project?.source?.mode !== "github") return { missing: "source" };
  const eval_ = project.team?.eval;
  if (!eval_?.focusedTest) return { missing: "focusedTest" };
  if (!eval_.reportFormat) return { missing: "reportFormat" };
  const setup = project.team?.setup;
  return {
    settings: {
      focusedTest: eval_.focusedTest, reportFormat: eval_.reportFormat,
      gradingPaths: eval_.gradingPaths ?? [],
      guardChecks: eval_.guardChecks ?? project.team?.checks ?? [],
      ...(setup ? { setup } : {}),
    },
  };
}
