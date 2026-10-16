import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./types.js";
import { assertRunnerDeployment, parseDeployment } from "./deployment.js";
import { machineIdentity } from "./machine.js";

/**
 * Provider hooks injected at launch when the config does not say. Codex hooks stay off until
 * spike S2 confirms that `-c hooks.*` and `--dangerously-bypass-hook-trust` work as intended.
 */
export const DEFAULT_HOOKS = { claude: true, codex: false } as const;
export const machineLabelSchema = z.string().trim().min(1).max(80);

const schema = z
  .object({
    machine: z.object({ id: z.uuid(), label: machineLabelSchema }).strict().optional(),
    cmux: z.object({ enabled: z.boolean(), command: z.string().min(1).optional(), hooksDir: z.string().refine(isAbsolute).optional() }).strict().optional(),
    remote: z.object({ enabled: z.boolean(), relay: z.object({ url: z.url(), tokenFile: z.string().refine(isAbsolute) }).strict().optional() }).strict().optional(),
    deployment: z.unknown().optional(),
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
          .array(z.enum(["needs-you", "turn-finished", "exited", "recording-error"]))
          .default(["needs-you", "turn-finished", "exited", "recording-error"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function readConfig(file: string): { config: Config; key: Buffer } {
  const config = schema.parse(JSON.parse(readFileSync(file, "utf8"))) as Config;
  config.deployment = parseDeployment(config.deployment);
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
