import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { teamModelProfileSchema, type TeamModelProfile } from "./team-types.js";

export const DEFAULT_MAX_MISS_RATE = 0.05;
export const DEFAULT_MIN_CASES = 100;

export const permissionAgentConfigSchema = z.object({
  light: teamModelProfileSchema.optional(),
  strong: z.array(teamModelProfileSchema).min(1).max(8).optional(),
  maxMissRate: z.number().min(0).max(1).default(DEFAULT_MAX_MISS_RATE),
  minCases: z.number().int().min(1).max(100_000).default(DEFAULT_MIN_CASES),
  releaseCommands: z.array(z.array(z.string().min(1).max(200)).min(1).max(8)).max(64).optional(),
}).strict().superRefine((block, context) => {
  const ids = new Set<string>();
  for (const [index, profile] of (block.strong ?? []).entries()) {
    if (ids.has(profile.id)) context.addIssue({ code: "custom", path: ["strong", index, "id"], message: "Strong profile IDs must be unique" });
    ids.add(profile.id);
  }
});
export type PermissionAgentConfig = z.infer<typeof permissionAgentConfigSchema>;

export interface PermissionAgentSettings {
  light?: TeamModelProfile;
  strong: TeamModelProfile[];
  maxMissRate: number;
  minCases: number;
}

const RELEASE_MARKER = ".infinite-release.json";

export function protectedInstallPath(installRoot: string, marked = isMarkedRelease(installRoot)): string {
  if (!marked) return installRoot;
  const container = dirname(installRoot);
  return container === "/" ? installRoot : container;
}

function isMarkedRelease(installRoot: string): boolean {
  try {
    return lstatSync(join(installRoot, RELEASE_MARKER)).isFile();
  } catch {
    return false;
  }
}

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

export function hostProtectedPaths(config: {
  stateDir: string; runDir: string; keyFile: string;
  agents: Partial<Record<string, { command: string; args: string[]; appServerCommand?: string }>>;
  teams?: { commandPrefix?: { command: string } };
  cmux?: { hooksDir?: string };
}, installRoot: string, extra: readonly string[] = []): string[] {
  const paths = [config.stateDir, config.runDir, config.keyFile, protectedInstallPath(installRoot), config.cmux?.hooksDir, config.teams?.commandPrefix?.command, ...extra];
  for (const profile of Object.values(config.agents)) {
    if (!profile) continue;
    paths.push(profile.command, profile.appServerCommand);
    const boundary = profile.args.indexOf("--");
    if (/(^|\/)sudo$/.test(profile.command) && boundary >= 0) paths.push(profile.args[boundary + 1]);
  }
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && path.startsWith("/")).map(path => path.replace(/\/+$/, "") || "/"))]
    .filter(path => path !== "/");
}

export function profileIdentity(profile: TeamModelProfile): { provider: string; model: string; effort?: string; variant?: string } {
  return profile.provider === "opencode"
    ? { provider: profile.provider, model: profile.model, ...(profile.variant ? { variant: profile.variant } : {}) }
    : { provider: profile.provider, model: profile.model, effort: profile.effort };
}
