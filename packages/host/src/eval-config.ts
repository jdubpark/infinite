import { isAbsolute } from "node:path";
import { z } from "zod";
import type { TeamCommand, TeamModelProfile } from "./team-types.js";

export const EVAL_RETENTION_DAYS_DEFAULT = 365;
export const GRADING_PATHS_MAX = 64;
export const GUARD_CHECKS_MAX = 8;
export const GRADER_CANARIES_MAX = 32;
export const TRIALS_PER_DAY_MAX = 50;
export const TRIAL_MINUTES_DEFAULT = 45;
export const TRIAL_MINUTES_MIN = 10;
export const TRIAL_MINUTES_MAX = 240;
export const CANDIDATE_PROFILES_MAX = 8;
export const MEMBER_CANARIES_MAX = 32;
export const EVAL_AGENT_ARGS_MAX = 64;
export const FILES_PLACEHOLDER = "{files}";
export const REPORT_PLACEHOLDER = "{report}";

const repositoryPrefix = z.string().min(1).max(200)
  .refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === ".git" || part === "." || part === ""), "Use a repository-relative path without a leading slash, empty, '.', '..', or '.git' segment")
  .refine(value => !/[*?\[\]:]/.test(value), "Use a path without glob syntax");

const pathSuffix = z.string().min(1).max(64).refine(value => !value.includes("/") && !value.includes("\\") && !value.includes("\0"), "Use a file-name suffix without a path separator");

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
  capture: z.boolean().optional(),
  testPaths: z.object({
    prefixes: z.array(repositoryPrefix).max(32),
    suffixes: z.array(pathSuffix).max(32),
  }).strict().refine(paths => paths.prefixes.length + paths.suffixes.length > 0, "Configure at least one test path prefix or suffix").optional(),
  excludeAreas: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(32).optional(),
  retentionDays: z.number().int().min(30).max(3650).optional(),
  mine: z.boolean().optional(),
  gradingPaths: z.array(repositoryPrefix).max(GRADING_PATHS_MAX).optional(),
  focusedTest: focusedTest.optional(),
  reportFormat: z.enum(["junit", "tap"]).optional(),
  guardChecks: z.array(command).max(GUARD_CHECKS_MAX).optional(),
  trialsPerDay: z.number().int().min(1).max(TRIALS_PER_DAY_MAX).optional(),
  trialMinutes: z.number().int().min(TRIAL_MINUTES_MIN).max(TRIAL_MINUTES_MAX).optional(),
}).strict();

export type EvalProjectSettings = z.infer<typeof evalProjectSchema>;

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value), "Use an absolute path");

const graderSchema = z.object({
  prefix: command,
  root: absolutePath,
  canaries: z.array(absolutePath).max(GRADER_CANARIES_MAX).optional(),
}).strict();

const evalAgentSchema = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(EVAL_AGENT_ARGS_MAX),
  appServerCommand: z.string().min(1).max(4096).optional(),
  appServerArgs: z.array(z.string().max(4096)).max(EVAL_AGENT_ARGS_MAX).optional(),
  workspaceDir: absolutePath.optional(),
  sharedWorkspace: z.boolean().optional(),
}).strict();

const evalMemberSchema = z.object({
  prefix: command,
  root: absolutePath,
  agents: z.object({ claude: evalAgentSchema.optional(), codex: evalAgentSchema.optional(), opencode: evalAgentSchema.optional() }).strict(),
  canaries: z.array(absolutePath).max(MEMBER_CANARIES_MAX).optional(),
}).strict();

export const evalHostSchema = z.object({ grader: graderSchema.optional(), member: evalMemberSchema.optional() }).strict();
export type EvalHostConfig = z.infer<typeof evalHostSchema>;
export type EvalGraderConfig = z.infer<typeof graderSchema>;
export type EvalMemberConfig = z.infer<typeof evalMemberSchema>;

export type ValidationSettings = {
  focusedTest: { command: string; args: string[] }; reportFormat: "junit" | "tap";
  gradingPaths: string[]; guardChecks: { command: string; args: string[] }[]; setup?: { command: string; args: string[] };
};

export function captureSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined {
  const eval_ = project?.team?.eval;
  if (eval_?.capture !== true || project?.source?.mode !== "github") return undefined;
  return eval_;
}

export function mineSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined {
  const eval_ = project?.team?.eval;
  if (eval_?.mine !== true || project?.source?.mode !== "github") return undefined;
  return eval_;
}

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

export type TrialSettings = ValidationSettings & { trialsPerDay: number; trialMinutes: number; candidateProfiles: TeamModelProfile[] };

type TrialProject = { source?: { mode: string }; team?: { eval?: EvalProjectSettings & { candidateProfiles?: TeamModelProfile[] }; checks?: { command: string; args: string[] }[]; setup?: { command: string; args: string[] } } } | undefined;

export function trialSettings(project: TrialProject):
  { settings: TrialSettings } | { missing: "source" | "focusedTest" | "reportFormat" | "trialsPerDay" } {
  const validation = validationSettings(project);
  if ("missing" in validation) return validation;
  const eval_ = project?.team?.eval;
  if (eval_?.trialsPerDay === undefined) return { missing: "trialsPerDay" };
  return {
    settings: {
      ...validation.settings,
      trialsPerDay: eval_.trialsPerDay,
      trialMinutes: eval_.trialMinutes ?? TRIAL_MINUTES_DEFAULT,
      candidateProfiles: eval_.candidateProfiles ?? [],
    },
  };
}

export function evalCommandPrefix(member: EvalMemberConfig | undefined, op: "exec" | "setup"): TeamCommand | undefined {
  if (!member) return undefined;
  return { command: member.prefix.command, args: [...member.prefix.args, op, "--"] };
}
