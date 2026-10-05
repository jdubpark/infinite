import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./types.js";
import { assertRunnerDeployment, parseDeployment } from "./deployment.js";

/**
 * Provider hooks injected at launch when the config does not say. Codex hooks stay off until
 * spike S2 confirms that `-c hooks.*` and `--dangerously-bypass-hook-trust` work as intended.
 */
export const DEFAULT_HOOKS = { claude: true, codex: false } as const;

const schema = z
  .object({
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
        z.object({ command: z.string(), args: z.array(z.string()) }),
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
