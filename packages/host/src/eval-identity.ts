import type { Readable } from "node:stream";
import { z } from "zod";
import { evalCommandPrefix, type EvalMemberConfig } from "./eval-config.js";
import { launch, STOP_PAUSE_MS, STOP_ROUNDS, type Channel } from "./eval-grader.js";
import { evidenceDatabasePath } from "./evidence/store.js";
import type { ProjectSourceService } from "./project-source.js";
import type { EvalIdentityState } from "./eval-types.js";
import { inventoryRuntimeProcesses, type RuntimeProcess } from "./team-retirement.js";
import type { TeamCommand } from "./team-types.js";
import type { Config } from "./types.js";

export const EVAL_PROBE_SECONDS = 45, EVAL_RECEIVE_SECONDS = 600, EVAL_PREPARE_SECONDS = 600, EVAL_CHECK_SECONDS = 60, EVAL_STOP_SECONDS = 30,
  EVAL_CLEAN_SECONDS = 600, EVAL_SCRUB_SECONDS = 60, EVAL_GRACE_MS = 30_000, EVAL_PROBE_MAX = 4_096,
  EVAL_FREE_BYTES_MIN = 10_737_418_240, EVAL_FREE_INODES_MIN = 200_000, CHECK_OBJECTS_MAX = 200;

export type EvalProbe = { state: EvalIdentityState; uid?: number; storage?: boolean; fetch?: "refused" | "open" | "skipped" };

export interface EvalIdentity {
  probe(input: { canaries: readonly string[]; graderUid?: number; fetchUrl?: string; proxyUrl?: string }): Promise<EvalProbe>;
  receive(trial: string, input: Readable, maxBytes: number): Promise<"stored" | "too-large" | "failed">;
  prepare(trial: string): Promise<"ready" | "failed">;
  check(trial: string, objects: readonly string[]): Promise<"clean" | "leaked" | "failed">;
  teamPrefix(): TeamCommand | undefined;
  setupPrefix(): TeamCommand | undefined;
  stop(): Promise<boolean>;
  clean(): Promise<boolean>;
  scrub(): Promise<boolean>;
}

const TRIAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REFUSED = 64, TOO_LARGE = 3;

const probeSchema = z.object({
  version: z.literal(1),
  uid: z.number().int().min(0),
  root: z.string(),
  rootMode: z.string(),
  rootOwner: z.number().int().min(0),
  readable: z.array(z.boolean()).max(256),
  metadata: z.enum(["open", "closed"]),
  freeBytes: z.number().min(0),
  freeInodes: z.number().min(0),
  ancestorsWritable: z.boolean(),
  tools: z.boolean(),
  trials: z.number().int().min(0),
  leftovers: z.number().int().min(0).max(10_000),
  fetch: z.enum(["skipped", "open", "refused"]),
});

function parseProbe(text: string) {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = probeSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export function launcherEvalIdentity(config: () => EvalMemberConfig | undefined, options: { hostUid?: number; graceMs?: number } = {}): EvalIdentity {
  const channel: Channel = { held: false, graceMs: options.graceMs ?? EVAL_GRACE_MS };
  const hostUid = options.hostUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);

  return {
    async probe(input) {
      const current = config();
      if (!current) return { state: "not-configured" };
      const canaries = [...new Set([...input.canaries, ...(current.canaries ?? [])])];
      const fetchArgs = input.fetchUrl ? ["--fetch", input.fetchUrl] : [];
      const stdin = input.fetchUrl ? Buffer.from(`${input.proxyUrl ?? ""}\n`) : undefined;
      const result = await launch(channel, current.prefix, "probe", [...fetchArgs, "--", ...canaries], { ms: EVAL_PROBE_SECONDS * 1000, keep: EVAL_PROBE_MAX, input: stdin });
      if (result.failed || result.code === null) return { state: "unavailable" };
      if (result.code === REFUSED) return { state: "misconfigured" };
      if (result.code !== 0 || result.truncated) return { state: "unavailable" };
      const p = parseProbe(result.out.toString("utf8"));
      if (!p) return { state: "unavailable" };
      if (p.uid === hostUid || p.uid === 0 || p.uid === input.graderUid || p.root !== current.root || p.rootMode !== "711" || p.rootOwner !== p.uid || p.ancestorsWritable || !p.tools) {
        return { state: "misconfigured", uid: p.uid };
      }
      if (p.readable.some(Boolean)) return { state: "exposed", uid: p.uid };
      if (p.metadata === "open") return { state: "network-open", uid: p.uid };
      if (p.trials > 0 || p.leftovers > 0) return { state: "busy", uid: p.uid };
      return {
        state: "ready", uid: p.uid, fetch: p.fetch,
        storage: p.freeBytes >= EVAL_FREE_BYTES_MIN && p.freeInodes >= EVAL_FREE_INODES_MIN,
      };
    },

    async receive(trial, input, maxBytes) {
      const current = config();
      if (!current || !TRIAL_RE.test(trial) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return "failed";
      const result = await launch(channel, current.prefix, "receive", [trial, String(maxBytes)], { ms: EVAL_RECEIVE_SECONDS * 1000, keep: 0, input });
      if (result.failed) return "failed";
      if (result.code === 0) return "stored";
      if (result.code === TOO_LARGE) return "too-large";
      return "failed";
    },

    async prepare(trial) {
      const current = config();
      if (!current || !TRIAL_RE.test(trial)) return "failed";
      const result = await launch(channel, current.prefix, "prepare", [trial], { ms: EVAL_PREPARE_SECONDS * 1000, keep: 0 });
      return !result.failed && result.code === 0 ? "ready" : "failed";
    },

    async check(trial, objects) {
      const current = config();
      if (!current || !TRIAL_RE.test(trial) || objects.length > CHECK_OBJECTS_MAX || !objects.every(object => OBJECT_RE.test(object))) return "failed";
      const result = await launch(channel, current.prefix, "check", [trial, "--", ...objects], { ms: EVAL_CHECK_SECONDS * 1000, keep: 0 });
      if (result.failed || result.code === null) return "failed";
      if (result.code === 0) return "clean";
      if (result.code === 1) return "leaked";
      return "failed";
    },

    teamPrefix() {
      return evalCommandPrefix(config(), "exec");
    },

    setupPrefix() {
      return evalCommandPrefix(config(), "setup");
    },

    async stop() {
      const current = config();
      if (!current) return false;
      const result = await launch(channel, current.prefix, "stop", [], { ms: EVAL_STOP_SECONDS * 1000, keep: 0, bypass: true });
      return !result.failed && result.code === 0;
    },

    async clean() {
      return simple(config, channel, "clean", EVAL_CLEAN_SECONDS);
    },

    async scrub() {
      return simple(config, channel, "scrub", EVAL_SCRUB_SECONDS);
    },
  };
}

async function simple(config: () => EvalMemberConfig | undefined, channel: Channel, operation: "clean" | "scrub", seconds: number): Promise<boolean> {
  const current = config();
  if (!current) return false;
  const result = await launch(channel, current.prefix, operation, [], { ms: seconds * 1000, keep: 0 });
  return !result.failed && result.code === 0;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function stopEvalIdentity(identity: EvalIdentity, uid: number, inventory: () => Promise<RuntimeProcess[]> = inventoryRuntimeProcesses): Promise<"stopped" | "alive" | "failed"> {
  for (let round = 1; round <= STOP_ROUNDS; round++) {
    if (!(await identity.stop())) return "failed";
    let rows: RuntimeProcess[];
    try {
      rows = await inventory();
    } catch {
      return "failed";
    }
    const alive = rows.some(row => (row.ruid === uid || row.euid === uid) && !row.state.startsWith("Z"));
    if (!alive) return "stopped";
    if (round < STOP_ROUNDS) await sleep(STOP_PAUSE_MS);
  }
  return "alive";
}

export function evalCanaries(config: Config, source: Pick<ProjectSourceService, "mirrorPath">): string[] {
  const paths = [evidenceDatabasePath(config.stateDir), config.keyFile, config.stateDir, config.runDir, ...(config.socketDir ? [config.socketDir] : [])];
  if (config.teams?.workspaceDir) paths.push(config.teams.workspaceDir);
  for (const project of config.projects) {
    if (project.source?.mode === "github") paths.push(source.mirrorPath(project.id));
  }
  for (const project of config.projects) paths.push(project.path);
  if (config.eval?.grader?.root) paths.push(config.eval.grader.root);
  paths.push(...(config.eval?.member?.canaries ?? []));
  return [...new Set(paths)];
}

export function repositoryUrl(config: Pick<Config, "source">, projectId: string, repository: string): string {
  return config.source?.remoteOverrides?.[projectId] ?? `https://github.com/${repository}.git`;
}
