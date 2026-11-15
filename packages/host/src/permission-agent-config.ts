import { z } from "zod";
import { teamModelProfileSchema, type TeamModelProfile } from "./team-types.js";

/** The proposed first threshold: the upper end of the 95% interval of the miss rate. */
export const DEFAULT_MAX_MISS_RATE = 0.05;
/** The proposed least number of labelled cases in a replay set. */
export const DEFAULT_MIN_CASES = 100;

/**
 * The `permissionAgent` block of the host configuration. No key is required, so a host without the
 * block parses as before; readiness says what is missing. Profiles reuse the team lineup schema.
 */
export const permissionAgentConfigSchema = z.object({
  /** The light tier: allow or refer only. Until it is set the host reads `teams.lineup.permissionReviewer`. */
  light: teamModelProfileSchema.optional(),
  /** The strong tier, in order of preference. The host is ready only with profiles from at least two families. */
  strong: z.array(teamModelProfileSchema).min(1).max(8).optional(),
  /** The owner's threshold for the upper end of the measured miss rate's 95% interval. */
  maxMissRate: z.number().min(0).max(1).default(DEFAULT_MAX_MISS_RATE),
  /** The least number of labelled cases a replay result needs before the host can be ready. */
  minCases: z.number().int().min(1).max(100_000).default(DEFAULT_MIN_CASES),
}).strict().superRefine((block, context) => {
  const ids = new Set<string>();
  for (const [index, profile] of (block.strong ?? []).entries()) {
    if (ids.has(profile.id)) context.addIssue({ code: "custom", path: ["strong", index, "id"], message: "Strong profile IDs must be unique" });
    ids.add(profile.id);
  }
});
export type PermissionAgentConfig = z.infer<typeof permissionAgentConfigSchema>;

/** What the decision core reads from the host configuration. */
export interface PermissionAgentSettings {
  light?: TeamModelProfile;
  strong: TeamModelProfile[];
  maxMissRate: number;
  minCases: number;
}

/** The effective tiers: `permissionAgent.light`, else the lineup's permission reviewer. */
export function permissionAgentSettings(config: {
  permissionAgent?: Partial<PermissionAgentConfig>;
  teams?: { lineup?: { permissionReviewer?: TeamModelProfile } };
}): PermissionAgentSettings {
  const block = config.permissionAgent;
  return {
    light: block?.light ?? config.teams?.lineup?.permissionReviewer,
    strong: [...(block?.strong ?? [])],
    maxMissRate: block?.maxMissRate ?? DEFAULT_MAX_MISS_RATE,
    minCases: block?.minCases ?? DEFAULT_MIN_CASES,
  };
}

/**
 * Host paths a write to which changes host configuration, the delegation records, the permission policy
 * or journal, or a provider launcher: the state, run and install directories, the vault key, and every
 * absolute launcher command. A class rule sends such a write to the owner.
 */
export function hostProtectedPaths(config: {
  stateDir: string; runDir: string; keyFile: string;
  agents: Partial<Record<string, { command: string; args: string[]; appServerCommand?: string }>>;
  teams?: { commandPrefix?: { command: string } };
  cmux?: { hooksDir?: string };
}, installRoot: string): string[] {
  const paths = [config.stateDir, config.runDir, config.keyFile, installRoot, config.cmux?.hooksDir, config.teams?.commandPrefix?.command];
  for (const profile of Object.values(config.agents)) {
    if (!profile) continue;
    paths.push(profile.command, profile.appServerCommand);
    const boundary = profile.args.indexOf("--");
    if (/(^|\/)sudo$/.test(profile.command) && boundary >= 0) paths.push(profile.args[boundary + 1]);
  }
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && path.startsWith("/")).map(path => path.replace(/\/+$/, "") || "/"))]
    .filter(path => path !== "/");
}

/** The parts of a profile that select the model a turn runs. The id and label do not change a measurement. */
export function profileIdentity(profile: TeamModelProfile): { provider: string; model: string; effort?: string; variant?: string } {
  return profile.provider === "opencode"
    ? { provider: profile.provider, model: profile.model, ...(profile.variant ? { variant: profile.variant } : {}) }
    : { provider: profile.provider, model: profile.model, effort: profile.effort };
}
