import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { EvalGraderConfig } from "./eval-config.js";
import type { GraderState } from "./eval-types.js";
import { inventoryRuntimeProcesses, type RuntimeProcess } from "./team-retirement.js";

export const PROBE_SECONDS = 30, STOP_ROUNDS = 3, STOP_PAUSE_MS = 1_000, GRADER_GRACE_MS = 30_000, PROBE_FRESH_MS = 600_000,
  GRADER_OUTPUT_MAX = 65_536, GRADER_FREE_BYTES_MIN = 10_737_418_240, GRADER_FREE_INODES_MIN = 200_000;
export const GRADER_ROUNDS = ["round-1", "round-2", "round-3", "round-4", "round-5", "round-6"] as const;
export type GraderDir = "." | "task" | typeof GRADER_ROUNDS[number];
export type GraderInput = "base.bundle" | "base-delta.patch" | "reference.patch";
export type GraderProbe = { state: GraderState; uid?: number; storage?: boolean };
export type GraderRun = { exitCode: number | null; timedOut: boolean; stdout?: Buffer; truncated: boolean; failed: boolean };
export interface Grader {
  probe(canaries: readonly string[]): Promise<GraderProbe>;
  receive(job: string, name: GraderInput, input: Readable | Buffer, maxBytes: number): Promise<"stored" | "too-large" | "failed">;
  /** `stdout` is kept, at most 64 KiB, only when `keepStdout` is true. `input` goes to the child's stdin. */
  run(job: string, dir: GraderDir, seconds: number, argv: readonly string[], options?: { input?: Buffer; keepStdout?: boolean }): Promise<GraderRun>;
  read(job: string, report: string, maxBytes: number): Promise<{ state: "read"; bytes: Buffer } | { state: "missing" | "too-large" | "failed" }>;
  digest(job: string): Promise<{ state: "read"; sha256: string } | { state: "missing" | "failed" }>;
  stop(): Promise<boolean>;
  clean(job: string): Promise<boolean>;
  remove(job: string): Promise<boolean>;
}

const JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPORT_RE = /^reports\/round-[1-6]\.(xml|tap)$/;
const DIGEST_RE = /^[0-9a-f]{64}\n?$/;
/** Launcher time limits, in seconds. A round's clones and installed dependencies can hold hundreds of thousands of files, so `clean` and `remove` get the longer limit. */
export const READ_SECONDS = 30, STOP_SECONDS = 30, RECEIVE_SECONDS = 600, DIGEST_SECONDS = 600, CLEAN_SECONDS = 600;
const LAUNCHER_SECONDS = STOP_SECONDS;
/** Exit codes that only the launcher returns, before a child starts. */
const REFUSED = 64, LAUNCHER_FAILED = 125, RUN_TIMEOUT = 124, MISSING = 2, TOO_LARGE = 3;
const FAILED_RUN: GraderRun = { exitCode: null, timedOut: false, truncated: false, failed: true };

const probeSchema = z.object({
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
});

type Spawned = { code: number | null; out: Buffer; truncated: boolean; failed: boolean; elapsedMs: number };
type Channel = { held: boolean; graceMs: number };

/**
 * Runs one launcher operation. The host never signals the child: it runs as another account behind sudo. A call that
 * does not close within its limit plus the grace counts as failed, and the channel stays held until the child closes,
 * so no further call starts meanwhile.
 */
function launch(
  channel: Channel,
  prefix: EvalGraderConfig["prefix"],
  operation: string,
  args: readonly string[],
  limit: { ms: number; keep: number; input?: Readable | Buffer; bypass?: boolean },
): Promise<Spawned> {
  const failed: Spawned = { code: null, out: Buffer.alloc(0), truncated: false, failed: true, elapsedMs: 0 };
  // A bypass call (`stop`) neither waits for nor holds the channel, so it reaches a command that is still running.
  if (channel.held && !limit.bypass) return Promise.resolve(failed);
  const started = Date.now();
  return new Promise(resolve => {
    const env: Record<string, string> = {};
    if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
    if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
    let child: ChildProcess;
    try {
      child = spawn(prefix.command, [...prefix.args, operation, ...args], {
        env, stdio: [limit.input ? "pipe" : "ignore", "pipe", "pipe"], detached: false,
      });
    } catch {
      resolve(failed);
      return;
    }
    if (!limit.bypass) channel.held = true;
    const chunks: Buffer[] = [];
    let kept = 0, total = 0, truncated = false, settled = false;
    const finish = (result: Partial<Spawned>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out: Buffer.concat(chunks), truncated, failed: false, elapsedMs: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => finish({ failed: true }), limit.ms + channel.graceMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit.keep) truncated = true;
      if (kept < limit.keep) {
        const take = chunk.subarray(0, limit.keep - kept);
        chunks.push(take);
        kept += take.length;
      }
    });
    child.stderr!.resume();
    child.stdin?.on("error", () => undefined);
    if (Buffer.isBuffer(limit.input)) child.stdin?.end(limit.input);
    else if (limit.input) limit.input.pipe(child.stdin!);
    child.on("error", () => {
      if (!limit.bypass) channel.held = false;
      finish({ failed: true });
    });
    child.on("close", code => {
      if (!limit.bypass) channel.held = false;
      finish({ code, failed: false });
    });
  });
}

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

/** Launcher and grader are one account per host; the host never runs a second probe while one is open. */
export function launcherGrader(config: () => EvalGraderConfig | undefined, options: { hostUid?: number; graceMs?: number } = {}): Grader {
  const channel: Channel = { held: false, graceMs: options.graceMs ?? GRADER_GRACE_MS };
  const hostUid = options.hostUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);

  return {
    async probe(canaries) {
      const current = config();
      if (!current) return { state: "not-configured" };
      const all = [...new Set([...canaries, ...(current.canaries ?? [])])];
      const result = await launch(channel, current.prefix, "probe", ["--", ...all], { ms: PROBE_SECONDS * 1000, keep: 4096 });
      if (result.failed || result.code === null) return { state: "unavailable" };
      if (result.code === REFUSED) return { state: "misconfigured" };
      if (result.code !== 0 || result.truncated) return { state: "unavailable" };
      const p = parseProbe(result.out.toString("utf8"));
      if (!p) return { state: "unavailable" };
      if (p.uid === hostUid || p.uid === 0 || p.root !== current.root || p.rootMode !== "700" || p.rootOwner !== p.uid || p.ancestorsWritable || !p.tools) {
        return { state: "misconfigured", uid: p.uid };
      }
      if (p.readable.some(Boolean)) return { state: "exposed", uid: p.uid };
      if (p.metadata === "open") return { state: "network-open", uid: p.uid };
      return { state: "ready", uid: p.uid, storage: p.freeBytes >= GRADER_FREE_BYTES_MIN && p.freeInodes >= GRADER_FREE_INODES_MIN };
    },

    async receive(job, name, input, maxBytes) {
      const current = config();
      if (!current || !JOB_RE.test(job) || !["base.bundle", "base-delta.patch", "reference.patch"].includes(name)) return "failed";
      const result = await launch(channel, current.prefix, "receive", [job, name, String(maxBytes)], { ms: RECEIVE_SECONDS * 1000, keep: 0, input });
      if (result.failed) return "failed";
      if (result.code === 0) return "stored";
      if (result.code === TOO_LARGE) return "too-large";
      return "failed";
    },

    async run(job, dir, seconds, argv, runOptions) {
      const current = config();
      if (!current || !JOB_RE.test(job) || !(dir === "." || dir === "task" || (GRADER_ROUNDS as readonly string[]).includes(dir))) return FAILED_RUN;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return FAILED_RUN;
      const limitMs = seconds * 1000;
      const keepStdout = runOptions?.keepStdout === true;
      const result = await launch(channel, current.prefix, "run", [job, dir, String(seconds), "--", ...argv], {
        ms: limitMs, keep: keepStdout ? GRADER_OUTPUT_MAX : 0, input: runOptions?.input,
      });
      if (result.failed || result.code === null) return FAILED_RUN;
      const launcherRefused = result.code === REFUSED || result.code === LAUNCHER_FAILED;
      return {
        exitCode: result.code,
        timedOut: result.code === RUN_TIMEOUT && result.elapsedMs >= limitMs - 1000,
        stdout: keepStdout ? result.out : undefined,
        truncated: result.truncated,
        failed: launcherRefused,
      };
    },

    async read(job, report, maxBytes) {
      const current = config();
      if (!current || !JOB_RE.test(job) || !REPORT_RE.test(report)) return { state: "failed" };
      const result = await launch(channel, current.prefix, "read", [job, report, String(maxBytes)], { ms: READ_SECONDS * 1000, keep: maxBytes });
      if (result.failed) return { state: "failed" };
      if (result.code === TOO_LARGE || (result.code === 0 && result.truncated)) return { state: "too-large" };
      if (result.code === 0) return { state: "read", bytes: result.out };
      if (result.code === MISSING) return { state: "missing" };
      return { state: "failed" };
    },

    async digest(job) {
      const current = config();
      if (!current || !JOB_RE.test(job)) return { state: "failed" };
      const result = await launch(channel, current.prefix, "digest", [job], { ms: DIGEST_SECONDS * 1000, keep: 128 });
      if (result.failed || result.code === null) return { state: "failed" };
      if (result.code === MISSING) return { state: "missing" };
      if (result.code !== 0 || result.truncated) return { state: "failed" };
      const text = result.out.toString("utf8");
      return DIGEST_RE.test(text) ? { state: "read", sha256: text.trim() } : { state: "failed" };
    },

    async stop() {
      const current = config();
      if (!current) return false;
      const result = await launch(channel, current.prefix, "stop", [], { ms: LAUNCHER_SECONDS * 1000, keep: 0, bypass: true });
      return !result.failed && result.code === 0;
    },

    async clean(job) {
      return simple(config, channel, "clean", job, CLEAN_SECONDS);
    },

    async remove(job) {
      return simple(config, channel, "remove", job, CLEAN_SECONDS);
    },
  };
}

async function simple(config: () => EvalGraderConfig | undefined, channel: Channel, operation: "clean" | "remove", job: string, seconds: number): Promise<boolean> {
  const current = config();
  if (!current || !JOB_RE.test(job)) return false;
  const result = await launch(channel, current.prefix, operation, [job], { ms: seconds * 1000, keep: 0 });
  return !result.failed && result.code === 0;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Stops every process of the grader's account. Up to three rounds: a stop, then a process inventory, one second
 * apart. A launcher that fails stops at once. Processes that remain after the third round make the stop alive.
 */
export async function stopGrader(grader: Grader, uid: number, inventory: () => Promise<RuntimeProcess[]> = inventoryRuntimeProcesses): Promise<"stopped" | "alive" | "failed"> {
  for (let round = 1; round <= STOP_ROUNDS; round++) {
    if (!(await grader.stop())) return "failed";
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
