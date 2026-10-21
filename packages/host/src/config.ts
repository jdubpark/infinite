import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./types.js";
import { assertRunnerDeployment, parseDeployment } from "./deployment.js";
import { machineIdentity } from "./machine.js";
import { projectSourceSchema, teamProjectSchema, teamCommandSchema, teamLineupSchema } from "./team-types.js";

/**
 * Provider hooks injected at launch when the config does not say. Codex hooks stay off until
 * spike S2 confirms that `-c hooks.*` and `--dangerously-bypass-hook-trust` work as intended.
 */
export const DEFAULT_HOOKS = { claude: true, codex: false } as const;
const nonNegative = z.number().min(0).finite();
export const usageConfigSchema = z.object({
  /** USD per million tokens, keyed `provider/model`. */
  prices: z.record(z.string().min(1), z.object({ input: nonNegative, output: nonNegative, cacheRead: nonNegative.optional(), cacheWrite: nonNegative.optional() }).strict()).default({}),
  accounts: z.record(z.string().min(1), z.object({ kind: z.enum(["metered", "subscription"]), match: z.array(z.string().min(1)).default([]), planUsd: nonNegative.optional(), balance: z.object({ source: z.literal("deepseek"), apiKeyFile: z.string().refine(isAbsolute, "Balance key file must be absolute") }).strict().optional() }).strict()).default({}),
  budgets: z.partialRecord(z.enum(["claude", "codex", "grok", "opencode", "demo"]), z.object({ usd: nonNegative, period: z.enum(["day", "week", "month"]).default("month") }).strict()).default({}),
}).strict();
export type UsageConfig = z.infer<typeof usageConfigSchema>;
export const machineLabelSchema = z.string().trim().min(1).max(80);

const schema = z
  .object({
    linear: z.object({ apiKeyFile: z.string().refine(isAbsolute), endpoint: z.url().optional() }).strict().optional(),
    teams: z.object({ workspaceDir: z.string().refine(isAbsolute), commandPrefix: teamCommandSchema.optional(), lineup: teamLineupSchema.optional(), trustWorkspaces: z.boolean().optional(), stallMinutes: z.number().int().min(5).max(1440).optional(), checkMinutes: z.number().positive().max(240).optional() }).strict().optional(),
    machine: z.object({ id: z.uuid(), label: machineLabelSchema }).strict().optional(),
    cmux: z.object({ enabled: z.boolean(), command: z.string().min(1).optional(), hooksDir: z.string().refine(isAbsolute).optional() }).strict().optional(),
    remote: z.object({ enabled: z.boolean(), relay: z.object({ url: z.url(), tokenFile: z.string().refine(isAbsolute) }).strict().optional() }).strict().optional(),
    deployment: z.unknown().optional(),
    usage: usageConfigSchema.optional(),
    sync: z.object({ sharedGroup: z.boolean().optional(), homeDir: z.string().refine(isAbsolute).optional() }).strict().optional(),
    source: z.object({ mirrorDir: z.string().refine(isAbsolute).optional(), refreshMinutes: z.number().int().min(1).max(1440).optional(), remoteOverrides: z.record(z.string(), z.string()).optional() }).strict().optional(),
    // Model-written chat digests. The key file is read once at startup and never logged.
    summaries: z.object({
      model: z.string().min(1).max(100),
      apiKeyFile: z.string().refine(isAbsolute, "Summary key file must be absolute"),
      baseUrl: z.url().default("https://api.openai.com"),
    }).strict().optional(),
    jev: z.object({
      apiKeyFile: z.string().refine(isAbsolute, "Jev key file must be absolute"),
      model: z.string().min(1).max(100).default("jev-latest"),
      baseUrl: z.url().default("https://api.typesafe.ai"),
    }).strict().optional(),
    // Optional cleanup for platform-generated speech transcripts. The key is read once at startup.
    dictation: z.object({
      model: z.string().min(1).max(100).default("gpt-6-luna"),
      apiKeyFile: z.string().refine(isAbsolute, "Dictation key file must be absolute"),
      baseUrl: z.url().default("https://api.openai.com"),
    }).strict().optional(),
    repositoryBriefings: z.object({
      command: z.string().refine(isAbsolute, "Repository briefing command must be absolute"),
      args: z.array(z.string().max(4096)).default([]),
      runner: z.enum(["muse", "deepseek", "codex"]).optional(),
      model: z.string().min(1).max(100).optional(),
      automatic: z.boolean().default(true),
      intervalMs: z.number().int().min(100).default(5000),
      cooldownMs: z.number().int().min(0).default(60000),
      timeoutMs: z.number().int().min(10000).max(1800000).default(300000),
    }).strict().optional(),
    port: z.number().int().min(0).max(65535),
    origin: z.url(),
    stateDir: z.string(),
    runDir: z.string(),
    keyFile: z.string(),
    environment: z.enum(["local", "cloud"]),
    enableDemo: z.boolean().default(false),
    maxSessions: z.number().int().min(1).max(100).default(24),
    tokens: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          role: z.enum(["owner", "controller", "viewer"]),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .min(1),
    projects: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          name: z.string(),
          path: z.string(),
          team: teamProjectSchema.optional(),
          linear: z.object({ teamId: z.uuid(), projectId: z.uuid().optional() }).strict().optional(),
          source: projectSourceSchema.optional(),
        }),
      )
      .min(1),
    agents: z
      .partialRecord(
        z.enum(["claude", "codex", "grok", "opencode", "demo"]),
        z.object({ command: z.string(), args: z.array(z.string()), appServerCommand: z.string().optional(), appServerArgs: z.array(z.string()).optional(),
          workspaceDir: z.string().refine(isAbsolute, "Workspace directory must be absolute").optional(), sharedWorkspace: z.boolean().optional() }),
      )
      .default({}),
    attention: z
      .object({
        idleAfterMs: z.number().int().min(1000).max(600000).default(20000),
        limitConfirmMs: z.number().int().min(1000).max(600000).default(30000),
        hooks: z
          .object({
            claude: z.boolean().default(DEFAULT_HOOKS.claude),
            codex: z.boolean().default(DEFAULT_HOOKS.codex),
          })
          .default(DEFAULT_HOOKS),
      })
      .optional(),
    push: z
      .object({
        enabled: z.boolean().default(false),
        accessTokenFile: z.string().optional(),
        endpoint: z.url().default("https://exp.host/--/api/v2/push/send"),
        detail: z.enum(["minimal", "full"]).default("minimal"),
        events: z
          .array(z.enum(["needs-you", "turn-finished", "exited", "recording-error", "goal-started", "goal-finished", "goal-stuck", "goal-cancelled", "team-started", "team-finished", "team-stuck", "team-cancelled", "team-blocked"]))
          .default(["needs-you", "recording-error", "goal-started", "goal-finished", "goal-stuck", "goal-cancelled", "team-started", "team-finished", "team-stuck", "team-cancelled"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function validateLinearConfig(config: Config) {
  if (config.projects.some(project => project.linear) && !config.linear)
    throw new Error("Linear projects require a host credential configuration");
  if (!config.linear) return;
  const endpoint = new URL(config.linear.endpoint ?? "https://api.linear.app/graphql");
  const local = config.environment === "local" && endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if ((!local && endpoint.href !== "https://api.linear.app/graphql") || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/graphql")
    throw new Error("Linear requires its official HTTPS endpoint; loopback HTTP is allowed for local development");
  try {
    const file = config.linear.apiKeyFile;
    if (!isAbsolute(file) || (statSync(file).mode & 0o777) !== 0o600 || !statSync(file).isFile()) throw new Error();
    const actual = realpathSync(file);
    for (const directory of [config.stateDir, config.runDir, config.teams?.workspaceDir, ...config.projects.flatMap(project => [project.path, project.teamworkDir])].filter((value): value is string => Boolean(value))) {
      let base: string;
      try { base = realpathSync(directory); } catch { base = resolve(directory); }
      const rel = relative(base, actual);
      if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) throw new Error();
    }
    const credential = readFileSync(file, "utf8").trim();
    if (!credential || credential.length > 4096 || /\s/.test(credential)) throw new Error();
  } catch { throw new Error("Linear API key must be a nonempty private 0600 file outside runtime state and project workspaces"); }
}
export function readConfig(file: string): { config: Config; key: Buffer } {
  const config = schema.parse(JSON.parse(readFileSync(file, "utf8"))) as Config;
  config.deployment = parseDeployment(config.deployment);
  validateLinearConfig(config);
  assertRunnerDeployment(config);
  for (const path of [
    config.stateDir,
    config.runDir,
    config.keyFile,
    ...config.projects.map((p) => p.path),
  ]) {
    if (!isAbsolute(path))
      throw new Error("Configuration paths must be absolute");
  }
  const rel = relative(resolve(config.stateDir), resolve(config.keyFile));
  if (!rel.startsWith("..") && !isAbsolute(rel))
    throw new Error("Keep the encryption key outside the state directory");
  const mode = statSync(config.keyFile).mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw new Error(
      "Encryption key must not be readable by other users (chmod 600)",
    );
  if (config.push?.enabled && config.push.accessTokenFile) {
    const file = config.push.accessTokenFile;
    const message =
      "Push access token file must be absolute, outside stateDir, chmod 600";
    if (!isAbsolute(file)) throw new Error(message);
    const fileRel = relative(resolve(config.stateDir), resolve(file));
    if (!fileRel.startsWith("..") && !isAbsolute(fileRel))
      throw new Error(message);
    if ((statSync(file).mode & 0o777) !== 0o600) throw new Error(message);
    if (!readFileSync(file, "utf8").trim()) throw new Error(message);
  }
  if (config.jev) {
    const file = config.jev.apiKeyFile;
    const message = "Jev API key must be a private 0600 file outside runtime state and project workspaces";
    if (!isAbsolute(file)) throw new Error(message);
    const info = statSync(file);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error(message);
    const actual = realpathSync(file);
    for (const directory of [config.stateDir, config.runDir, config.teams?.workspaceDir, ...config.projects.flatMap(project => [project.path, project.teamworkDir])].filter((value): value is string => Boolean(value))) {
      let base: string;
      try { base = realpathSync(directory); } catch { base = resolve(directory); }
      const rel = relative(base, actual);
      if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) throw new Error(message);
    }
  }
  const key = readFileSync(config.keyFile);
  if (key.length !== 32)
    throw new Error("Encryption key must contain exactly 32 random bytes");
  config.machine = machineIdentity(config, key);
  if ((config.cmux?.enabled || config.remote?.enabled) && config.deployment?.mode !== "single-tenant")
    throw new Error("Machine access and cmux require a single-tenant host");
  if (config.remote?.relay) {
    if (!config.remote.enabled) throw new Error("Enable remote access before configuring a relay");
    const relay = new URL(config.remote.relay.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(relay.hostname);
    if (!(relay.protocol === "https:" || (loopback && relay.protocol === "http:")) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/")
      throw new Error("Relay must be a bare HTTPS origin (HTTP is allowed for loopback development)");
    const file = config.remote.relay.tokenFile;
    const rel = relative(resolve(config.stateDir), resolve(file));
    if ((!rel.startsWith("..") && !isAbsolute(rel)) || (statSync(file).mode & 0o777) !== 0o600)
      throw new Error("Relay registration key must be private and outside the state directory");
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(readFileSync(file, "utf8").trim())) throw new Error("Invalid relay registration key");
  }
  const origin = new URL(config.origin);
  if (config.environment === "cloud" && origin.protocol !== "https:")
    throw new Error("Cloud clients require an HTTPS origin");
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("Origin must be a bare HTTP(S) origin");
  if (!["http:", "https:"].includes(origin.protocol))
    throw new Error("Invalid origin protocol");
  return { config, key };
}
