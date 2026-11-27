import { isAbsolute } from "node:path";
import { z } from "zod";
import { ID_RE, ownedPathSchemaFor, teamCommandSchema, type TeamCommand } from "./schema-primitives.js";
import type { TeamModelProfile } from "./team-types.js";
import { agentProfileSchema, type Provider } from "./types.js";

export const EVAL_RETENTION_DAYS_DEFAULT = 365;
export const GRADING_PATHS_MAX = 64;
export const GUARD_CHECKS_MAX = 8;
export const GRADER_CANARIES_MAX = 32;
export const TRIALS_PER_DAY_MAX = 50;
export const EVAL_BUDGET_USD_MAX = 100_000;
export const EVAL_BUDGET_PERIODS = ["day", "week", "month"] as const;
export type EvalBudgetPeriod = typeof EVAL_BUDGET_PERIODS[number];
export const EVAL_PROVIDERS = ["claude", "codex", "opencode"] as const;
export type EvalProvider = typeof EVAL_PROVIDERS[number];
export const TRIAL_MINUTES_DEFAULT = 45;
export const TRIAL_MINUTES_MIN = 10;
export const TRIAL_MINUTES_MAX = 240;
export const CANDIDATE_PROFILES_MAX = 8;
export const MEMBER_CANARIES_MAX = 32;
export const EVAL_AGENT_ARGS_MAX = 64;
export const EVAL_AGENT_TEXT_MAX = 4096;
export const EVAL_REPOSITORY_PREFIX_MAX = 200;
export const FILES_PLACEHOLDER = "{files}";
export const REPORT_PLACEHOLDER = "{report}";

const repositoryPrefix = ownedPathSchemaFor(EVAL_REPOSITORY_PREFIX_MAX, {
  segmentMessage: "Use a repository-relative path without a leading slash, empty, '.', '..', or '.git' segment",
  globMessage: "Use a path without glob syntax",
});

const pathSuffix = z.string().min(1).max(64).refine(value => !value.includes("/") && !value.includes("\\") && !value.includes("\0"), "Use a file-name suffix without a path separator");

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

const focusedTest = teamCommandSchema
  .refine(test => !test.command.includes(FILES_PLACEHOLDER) && !test.command.includes(REPORT_PLACEHOLDER), "Keep {files} and {report} out of the command")
  .refine(test => test.args.filter(arg => arg === FILES_PLACEHOLDER).length === 1 && countOf(test.args.join("\0"), FILES_PLACEHOLDER) === 1, "Use {files} as exactly one whole argument")
  .refine(test => countOf(test.args.join("\0"), REPORT_PLACEHOLDER) === 1, "Use {report} exactly once in the arguments");

export const evalProviderBudgetSchema = z.object({
  usd: z.number().finite().min(0).max(EVAL_BUDGET_USD_MAX),
  period: z.enum(EVAL_BUDGET_PERIODS).default("day"),
}).strict();
export type EvalProviderBudget = z.infer<typeof evalProviderBudgetSchema>;

export const evalProviderBudgetsSchema = z.partialRecord(
  z.enum(EVAL_PROVIDERS),
  evalProviderBudgetSchema,
).refine(budgets => Object.keys(budgets).length > 0, "Configure at least one provider budget");
export type EvalProviderBudgets = z.infer<typeof evalProviderBudgetsSchema>;

export const evalProjectSchema = z.object({
  capture: z.boolean().optional(),
  testPaths: z.object({
    prefixes: z.array(repositoryPrefix).max(32),
    suffixes: z.array(pathSuffix).max(32),
  }).strict().refine(paths => paths.prefixes.length + paths.suffixes.length > 0, "Configure at least one test path prefix or suffix").optional(),
  excludeAreas: z.array(z.string().regex(ID_RE)).max(32).optional(),
  retentionDays: z.number().int().min(30).max(3650).optional(),
  mine: z.boolean().optional(),
  gradingPaths: z.array(repositoryPrefix).max(GRADING_PATHS_MAX).optional(),
  focusedTest: focusedTest.optional(),
  reportFormat: z.enum(["junit", "tap"]).optional(),
  guardChecks: z.array(teamCommandSchema).max(GUARD_CHECKS_MAX).optional(),
  providerBudgets: evalProviderBudgetsSchema.optional(),
  trialsPerDay: z.number().int().min(1).max(TRIALS_PER_DAY_MAX).optional(),
  trialMinutes: z.number().int().min(TRIAL_MINUTES_MIN).max(TRIAL_MINUTES_MAX).optional(),
}).strict();

export type EvalProjectSettings = z.infer<typeof evalProjectSchema>;

const absolutePath = z.string().min(1).max(EVAL_AGENT_TEXT_MAX).refine(value => isAbsolute(value), "Use an absolute path");

const graderSchema = z.object({
  prefix: teamCommandSchema,
  root: absolutePath,
  canaries: z.array(absolutePath).max(GRADER_CANARIES_MAX).optional(),
}).strict();

export const evalAgentSchema = z.strictObject(agentProfileSchema.shape).superRefine((profile, context) => {
  if (profile.command.length < 1 || profile.command.length > EVAL_AGENT_TEXT_MAX)
    context.addIssue({ code: "custom", path: ["command"], message: `Agent command must be 1 to ${EVAL_AGENT_TEXT_MAX} characters` });
  if (profile.args.length > EVAL_AGENT_ARGS_MAX)
    context.addIssue({ code: "custom", path: ["args"], message: `At most ${EVAL_AGENT_ARGS_MAX} agent arguments` });
  profile.args.forEach((arg, index) => {
    if (arg.length > EVAL_AGENT_TEXT_MAX)
      context.addIssue({ code: "custom", path: ["args", index], message: `Agent argument is over ${EVAL_AGENT_TEXT_MAX} characters` });
  });
  if (profile.appServerCommand !== undefined && (profile.appServerCommand.length < 1 || profile.appServerCommand.length > EVAL_AGENT_TEXT_MAX))
    context.addIssue({ code: "custom", path: ["appServerCommand"], message: `App server command must be 1 to ${EVAL_AGENT_TEXT_MAX} characters` });
  if (profile.appServerArgs !== undefined) {
    if (profile.appServerArgs.length > EVAL_AGENT_ARGS_MAX)
      context.addIssue({ code: "custom", path: ["appServerArgs"], message: `At most ${EVAL_AGENT_ARGS_MAX} app server arguments` });
    profile.appServerArgs.forEach((arg, index) => {
      if (arg.length > EVAL_AGENT_TEXT_MAX)
        context.addIssue({ code: "custom", path: ["appServerArgs", index], message: `App server argument is over ${EVAL_AGENT_TEXT_MAX} characters` });
    });
  }
  if (profile.workspaceDir !== undefined && (profile.workspaceDir.length < 1 || profile.workspaceDir.length > EVAL_AGENT_TEXT_MAX))
    context.addIssue({ code: "custom", path: ["workspaceDir"], message: "Use an absolute path" });
});

const evalMemberSchema = z.object({
  prefix: teamCommandSchema,
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

export type HostUsageBudgets = Partial<Record<Provider, { usd: number; period?: EvalBudgetPeriod }>>;
export type TrialBudgetConstraint = { source: "project" | "host"; usd: number; period: EvalBudgetPeriod };
export type TrialSettings = ValidationSettings & {
  trialsPerDay: number | null;
  providerBudgets: EvalProviderBudgets;
  trialMinutes: number;
  candidateProfiles: TeamModelProfile[];
};

type TrialProject = { source?: { mode: string }; team?: { eval?: EvalProjectSettings & { candidateProfiles?: TeamModelProfile[] }; checks?: { command: string; args: string[] }[]; setup?: { command: string; args: string[] } } } | undefined;

export function isEvalProvider(provider: string): provider is EvalProvider {
  return provider === "claude" || provider === "codex" || provider === "opencode";
}

export function providerBudgetConstraints(
  provider: EvalProvider,
  projectBudgets: EvalProviderBudgets | undefined,
  hostBudgets: HostUsageBudgets | undefined,
): TrialBudgetConstraint[] {
  const constraints: TrialBudgetConstraint[] = [];
  const projectBudget = projectBudgets?.[provider];
  if (projectBudget !== undefined) constraints.push({ source: "project", usd: projectBudget.usd, period: projectBudget.period ?? "day" });
  const hostBudget = hostBudgets?.[provider];
  if (hostBudget !== undefined) constraints.push({ source: "host", usd: hostBudget.usd, period: hostBudget.period ?? "month" });
  return constraints;
}

export function hasTrialBudgetFor(
  provider: EvalProvider,
  settings: Pick<TrialSettings, "trialsPerDay" | "providerBudgets">,
  hostBudgets: HostUsageBudgets | undefined,
): boolean {
  return providerBudgetConstraints(provider, settings.providerBudgets, hostBudgets).length > 0
    || settings.trialsPerDay !== null;
}

export function trialSettings(project: TrialProject, hostBudgets?: HostUsageBudgets):
  { settings: TrialSettings } | { missing: "source" | "focusedTest" | "reportFormat" | "budget" } {
  const validation = validationSettings(project);
  if ("missing" in validation) return validation;
  const eval_ = project?.team?.eval;
  const providerBudgets = eval_?.providerBudgets ?? {};
  const trialsPerDay = eval_?.trialsPerDay ?? null;
  const hasProjectBudget = Object.keys(providerBudgets).length > 0;
  const hasHostBudget = hostBudgets !== undefined && EVAL_PROVIDERS.some(provider => hostBudgets[provider] !== undefined);
  if (!hasProjectBudget && !hasHostBudget && trialsPerDay === null) return { missing: "budget" };
  return {
    settings: {
      ...validation.settings,
      trialsPerDay,
      providerBudgets,
      trialMinutes: eval_?.trialMinutes ?? TRIAL_MINUTES_DEFAULT,
      candidateProfiles: eval_?.candidateProfiles ?? [],
    },
  };
}

export function evalCommandPrefix(member: EvalMemberConfig | undefined, op: "exec" | "setup"): TeamCommand | undefined {
  if (!member) return undefined;
  return { command: member.prefix.command, args: [...member.prefix.args, op, "--"] };
}
