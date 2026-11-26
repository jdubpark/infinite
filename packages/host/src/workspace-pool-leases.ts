import { execFile } from "node:child_process";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { bootId, processStart } from "./process-census.js";

export const HASH = /^[a-f0-9]{64}$/;
export const SHARD = /^[a-f0-9]{2}$/;
const MAX_CONTROL_BYTES = 64 * 1024;
const TMP_LEASE_GRACE_MS = 30_000;

export const WORKSPACE_POOL_GC_DEFAULTS = {
  graceMs: 10 * 60 * 1000,
  refGraceMs: 10 * 60 * 1000,
  leaseTtlMs: 2 * 60 * 1000,
  gcLeaseTtlMs: 2 * 60 * 1000,
  sweepLeaseTtlMs: 15 * 1000,
  sweepBatchSize: 64,
  maxWaitMs: 20 * 1000,
  pollMs: 15,
} as const;

export class SharedPoolLeaseLostError extends Error {
  readonly code = "workspace-pool-lease-lost";
  constructor(message = "Workspace shared pool lease was lost before completion") {
    super(message);
    this.name = "SharedPoolLeaseLostError";
  }
}

export type PoolLeaseKind = "write" | "read";

export interface PoolLeaseRecord {
  version: 1;
  id: string;
  kind: PoolLeaseKind;
  pid: number;
  bootId?: string;
  processStart?: string;
  scope?: string;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface PoolGcLeaseRecord {
  version: 1;
  id: string;
  pid: number;
  bootId?: string;
  processStart?: string;
  phase: "mark" | "sweep";
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface SharedPoolLeaseHandle {
  readonly id: string;
  readonly path: string;
  assertHeld(): Promise<void>;
  refresh(): Promise<void>;
  release(): Promise<void>;
}

export interface AcquireSharedPoolLeaseOptions {
  scope?: string;
  leaseTtlMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export type ScopeRegistration = {
  version: 1;
  directory: string;
  registeredAt: string;
};

const activeInProcessLeases = new Set<string>();
let cachedSelfStart: Promise<string | undefined> | undefined;

export function currentBootId(): string {
  return bootId();
}

export function currentProcessStart(): Promise<string | undefined> {
  if (!cachedSelfStart) {
    cachedSelfStart = processStart(process.pid).catch(() => undefined);
  }
  return cachedSelfStart;
}

export function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function inside(root: string, path: string) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPrivateDirectoryStats(info: { isDirectory(): boolean; uid: number | bigint; mode: number | bigint }) {
  const uid = process.getuid?.();
  if (!info.isDirectory()) return false;
  if (typeof info.uid === "bigint" && typeof info.mode === "bigint") {
    if (uid !== undefined && info.uid !== BigInt(uid)) return false;
    return (info.mode & 0o077n) === 0n;
  }
  if (uid !== undefined && Number(info.uid) !== uid) return false;
  return (Number(info.mode) & 0o077) === 0;
}

export function isPrivateRegularFileStats(info: BigIntStats) {
  const uid = process.getuid?.();
  if (!info.isFile() || info.nlink !== 1n) return false;
  if (uid !== undefined && info.uid !== BigInt(uid)) return false;
  return (info.mode & 0o077n) === 0n;
}

export async function ensurePrivateDirectory(path: string, durable = false) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!isPrivateDirectoryStats(info)) throw new Error("Workspace storage must be a private owner-controlled directory");
  if (durable && created) {
    let current = resolve(path);
    for (;;) {
      await syncDirectory(current);
      if (current === resolve(created)) break;
      current = dirname(current);
    }
    await syncDirectory(dirname(resolve(created)));
  }
}

export async function verifyPrivateDirectory(path: string) {
  const info = await lstat(path);
  if (!isPrivateDirectoryStats(info)) throw new Error("Workspace storage must be a private owner-controlled directory");
}

export async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function readPrivateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!isPrivateRegularFileStats(info) || info.size > BigInt(MAX_CONTROL_BYTES)) {
      throw new Error("Unsafe workspace pool control file");
    }
    const raw = await handle.readFile("utf8");
    return JSON.parse(raw);
  } finally {
    await handle.close();
  }
}

export async function writeAtomicJson(file: string, value: unknown, durable = false): Promise<void> {
  const dir = dirname(file);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    if (durable) await syncDirectory(dir);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export function isPidSignallable(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function inspectProcessIdentity(identity: { pid: number; bootId?: string; processStart?: string }): Promise<ProcessLiveness> {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) return "dead";
  const hostBoot = currentBootId();
  if (identity.bootId && hostBoot !== "unsupported" && identity.bootId !== hostBoot) return "dead";
  if (!isPidSignallable(identity.pid)) return "dead";
  if (identity.processStart !== undefined) {
    let observed: string | undefined;
    try {
      observed = identity.pid === process.pid ? await processStart(process.pid) : await processStart(identity.pid);
    } catch {
      return isPidSignallable(identity.pid) ? "unknown" : "dead";
    }
    if (observed === undefined) {
      return isPidSignallable(identity.pid) ? "unknown" : "dead";
    }
    return observed === identity.processStart ? "alive" : "dead";
  }
  return "alive";
}

export async function isProcessIdentityAlive(identity: { pid: number; bootId?: string; processStart?: string }): Promise<boolean> {
  return (await inspectProcessIdentity(identity)) === "alive";
}

const execFileAsync = promisify(execFile);

export async function listOwnClientServicePids(): Promise<{ pid: number; command: string }[]> {
  const uid = process.getuid?.();
  if (process.platform === "linux") {
    const results: { pid: number; command: string }[] = [];
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const dir = `/proc/${pid}`;
      try {
        if (uid !== undefined) {
          const info = await stat(dir);
          if (info.uid !== uid) continue;
        }
        const cmdline = (await readFile(`${dir}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
        if (cmdline.includes("--sync-service") || cmdline.includes("--laptop-service")) {
          results.push({ pid, command: cmdline });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") continue;
        throw error;
      }
    }
    return results;
  }
  if (process.platform === "darwin") {
    const args = uid !== undefined ? ["-u", String(uid), "-o", "pid=,command="] : ["-axo", "pid=,command="];
    const { stdout } = await execFileAsync("/bin/ps", args, { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const results: { pid: number; command: string }[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const command = match[2] ?? "";
      if (command.includes("--sync-service") || command.includes("--laptop-service")) {
        results.push({ pid: Number(match[1]), command });
      }
    }
    return results;
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

function parsePoolLease(value: unknown): PoolLeaseRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !value.id ||
      (value.kind !== "write" && value.kind !== "read") ||
      !Number.isInteger(value.pid) || (value.pid as number) <= 0 ||
      (value.bootId !== undefined && typeof value.bootId !== "string") ||
      (value.processStart !== undefined && typeof value.processStart !== "string") ||
      (value.scope !== undefined && (typeof value.scope !== "string" || !value.scope || value.scope.includes("\0"))) ||
      typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) ||
      typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) ||
      typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) {
    return undefined;
  }
  return {
    version: 1,
    id: value.id,
    kind: value.kind,
    pid: value.pid as number,
    ...(value.bootId !== undefined ? { bootId: value.bootId } : {}),
    ...(value.processStart !== undefined ? { processStart: value.processStart } : {}),
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  };
}

function parseGcLease(value: unknown): PoolGcLeaseRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !value.id ||
      (value.phase !== "mark" && value.phase !== "sweep") ||
      !Number.isInteger(value.pid) || (value.pid as number) <= 0 ||
      (value.bootId !== undefined && typeof value.bootId !== "string") ||
      (value.processStart !== undefined && typeof value.processStart !== "string") ||
      typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) ||
      typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) ||
      typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) {
    return undefined;
  }
  return {
    version: 1,
    id: value.id,
    pid: value.pid as number,
    ...(value.bootId !== undefined ? { bootId: value.bootId } : {}),
    ...(value.processStart !== undefined ? { processStart: value.processStart } : {}),
    phase: value.phase,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  };
}

export function parseScopeRegistration(value: unknown, expectedId: string): ScopeRegistration | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.directory !== "string" || !value.directory ||
      value.directory.includes("\0") || !isAbsolute(value.directory) ||
      typeof value.registeredAt !== "string" || !Number.isFinite(Date.parse(value.registeredAt))) {
    return undefined;
  }
  if (sha(value.directory) !== expectedId) return undefined;
  return { version: 1, directory: value.directory, registeredAt: value.registeredAt };
}

export async function inspectLeaseState(
  lease: { id: string; pid: number; bootId?: string; processStart?: string; expiresAt: number },
  nowMs: number,
): Promise<ProcessLiveness> {
  const hostBoot = currentBootId();
  if (lease.bootId && hostBoot !== "unsupported" && lease.bootId !== hostBoot) return "dead";
  if (lease.pid === process.pid) {
    if (activeInProcessLeases.has(lease.id)) return "alive";
    if (lease.processStart !== undefined) {
      const state = await inspectProcessIdentity(lease);
      if (state !== "alive") return state;
    }
    return lease.expiresAt > nowMs ? "alive" : "dead";
  }
  if (!isPidSignallable(lease.pid)) return "dead";
  if (lease.processStart !== undefined) {
    return inspectProcessIdentity(lease);
  }
  return lease.expiresAt > nowMs ? "alive" : "dead";
}

export async function isLeaseLive(
  lease: { id: string; pid: number; bootId?: string; processStart?: string; expiresAt: number },
  nowMs: number,
): Promise<boolean> {
  return (await inspectLeaseState(lease, nowMs)) !== "dead";
}

export async function readGcLease(sharedRoot: string): Promise<{ record?: PoolGcLeaseRecord; corrupt: boolean; info?: BigIntStats }> {
  const file = join(sharedRoot, "gc.lease");
  let info: BigIntStats;
  try {
    info = await lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { corrupt: false };
    throw error;
  }
  try {
    const parsed = parseGcLease(await readPrivateJson(file));
    return parsed ? { record: parsed, corrupt: false, info } : { corrupt: true, info };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { corrupt: false };
    return { corrupt: true, info };
  }
}

export async function registerSharedPoolScope(sharedRoot: string, scopeRoot: string): Promise<void> {
  const fastFile = join(sharedRoot, "scopes", `${sha(scopeRoot)}.json`);
  try {
    const info = await lstat(fastFile, { bigint: true });
    if (isPrivateRegularFileStats(info)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const canonicalPool = await realpath(sharedRoot);
  const canonicalScope = await realpath(scopeRoot);
  if (inside(canonicalPool, canonicalScope) || inside(canonicalScope, canonicalPool)) {
    throw new Error("Workspace scope and shared pool must use separate directories");
  }
  const scopesDir = join(canonicalPool, "scopes");
  await ensurePrivateDirectory(scopesDir, true);
  const id = sha(canonicalScope);
  const file = join(scopesDir, `${id}.json`);
  try {
    const info = await lstat(file, { bigint: true });
    if (isPrivateRegularFileStats(info)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const record: ScopeRegistration = { version: 1, directory: canonicalScope, registeredAt: new Date().toISOString() };
  await writeAtomicJson(file, record, true);
}

export async function acquireSharedPoolLease(
  sharedPoolDirectory: string,
  kind: PoolLeaseKind,
  options: AcquireSharedPoolLeaseOptions = {},
): Promise<SharedPoolLeaseHandle> {
  const now = options.now ?? Date.now;
  const leaseTtlMs = options.leaseTtlMs ?? WORKSPACE_POOL_GC_DEFAULTS.leaseTtlMs;
  const maxWaitMs = options.maxWaitMs ?? WORKSPACE_POOL_GC_DEFAULTS.maxWaitMs;
  const pollMs = options.pollMs ?? WORKSPACE_POOL_GC_DEFAULTS.pollMs;
  await ensurePrivateDirectory(sharedPoolDirectory);
  const sharedRoot = await realpath(sharedPoolDirectory);
  const leasesDir = join(sharedRoot, "leases");
  await ensurePrivateDirectory(leasesDir);
  const scope = options.scope ? await realpath(options.scope).catch(() => resolve(options.scope!)) : undefined;
  const id = randomUUID();
  const leasePath = join(leasesDir, `${id}.lease`);
  const waitDeadline = Date.now() + maxWaitMs;
  const hostBoot = currentBootId();
  const procStart = await currentProcessStart();
  let startedAt = now();
  let lastRefreshedAt = startedAt;

  for (;;) {
    options.signal?.throwIfAborted();
    startedAt = now();
    lastRefreshedAt = startedAt;
    const record: PoolLeaseRecord = {
      version: 1,
      id,
      kind,
      pid: process.pid,
      ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
      ...(procStart !== undefined ? { processStart: procStart } : {}),
      ...(scope !== undefined ? { scope } : {}),
      startedAt,
      updatedAt: startedAt,
      expiresAt: startedAt + leaseTtlMs,
    };
    activeInProcessLeases.add(id);
    await writeAtomicJson(leasePath, record);
    const gc = await readGcLease(sharedRoot);
    if (gc.record && gc.record.phase === "sweep" && await isLeaseLive(gc.record, now())) {
      activeInProcessLeases.delete(id);
      await rm(leasePath, { force: true }).catch(() => {});
      if (Date.now() >= waitDeadline) throw new Error("Timed out waiting for workspace pool garbage collection");
      await delay(pollMs, undefined, { signal: options.signal });
      continue;
    }
    break;
  }

  let released = false;
  let lost = false;
  let inFlightRefresh: Promise<void> | undefined;
  const refreshIntervalMs = Math.max(1000, Math.floor(leaseTtlMs / 4));

  const verifyStillHeld = async () => {
    if (released || lost) throw new SharedPoolLeaseLostError();
    let parsed: PoolLeaseRecord | undefined;
    try {
      parsed = parsePoolLease(await readPrivateJson(leasePath));
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.id !== id || parsed.pid !== process.pid ||
        (procStart !== undefined && parsed.processStart !== procStart)) {
      lost = true;
      activeInProcessLeases.delete(id);
      throw new SharedPoolLeaseLostError();
    }
    const gc = await readGcLease(sharedRoot);
    if (gc.record && gc.record.phase === "sweep" && await isLeaseLive(gc.record, now())) {
      lost = true;
      activeInProcessLeases.delete(id);
      throw new SharedPoolLeaseLostError("Workspace shared pool entered sweep while operation lease was lost");
    }
  };

  return {
    id,
    path: leasePath,
    async assertHeld() {
      if (inFlightRefresh) await inFlightRefresh;
      await verifyStillHeld();
    },
    async refresh() {
      if (released || lost) throw new SharedPoolLeaseLostError();
      if (now() - lastRefreshedAt < refreshIntervalMs) return;
      if (inFlightRefresh) return inFlightRefresh;
      const run = (async () => {
        await verifyStillHeld();
        if (released || lost) throw new SharedPoolLeaseLostError();
        const current = now();
        const record: PoolLeaseRecord = {
          version: 1,
          id,
          kind,
          pid: process.pid,
          ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
          ...(procStart !== undefined ? { processStart: procStart } : {}),
          ...(scope !== undefined ? { scope } : {}),
          startedAt,
          updatedAt: current,
          expiresAt: current + leaseTtlMs,
        };
        await writeAtomicJson(leasePath, record);
        lastRefreshedAt = current;
      })().finally(() => {
        if (inFlightRefresh === run) inFlightRefresh = undefined;
      });
      inFlightRefresh = run;
      return run;
    },
    async release() {
      if (released) return;
      released = true;
      if (inFlightRefresh) await inFlightRefresh.catch(() => {});
      activeInProcessLeases.delete(id);
      try {
        const existing = parsePoolLease(await readPrivateJson(leasePath));
        if (existing?.id === id) await rm(leasePath, { force: true }).catch(() => {});
      } catch {}
    },
  };
}

export async function withSharedPoolLease<T>(
  sharedPoolDirectory: string,
  kind: PoolLeaseKind,
  options: AcquireSharedPoolLeaseOptions,
  run: (lease: SharedPoolLeaseHandle) => Promise<T>,
): Promise<T> {
  const lease = await acquireSharedPoolLease(sharedPoolDirectory, kind, options);
  try {
    return await run(lease);
  } finally {
    await lease.release();
  }
}

export async function scanPoolLeases(
  sharedRoot: string,
  nowMs: number,
  options: { cleanupExpired: boolean; filterScope?: string },
): Promise<{ active: number; unverifiable: number; removedExpired: number }> {
  const leasesDir = join(sharedRoot, "leases");
  try {
    await verifyPrivateDirectory(leasesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: 0, unverifiable: 0, removedExpired: 0 };
    throw error;
  }
  let active = 0;
  let unverifiable = 0;
  let removedExpired = 0;
  const entries = await readdir(leasesDir);
  for (const name of entries) {
    const file = join(leasesDir, name);
    let info: BigIntStats;
    try {
      info = await lstat(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      const ageMs = nowMs - Number(info.mtimeNs / 1_000_000n);
      if (ageMs < TMP_LEASE_GRACE_MS) active += 1;
      else if (options.cleanupExpired && isPrivateRegularFileStats(info)) {
        await unlink(file).catch(() => {});
        removedExpired += 1;
      }
      continue;
    }
    if (!name.endsWith(".lease")) continue;
    let parsed: PoolLeaseRecord | undefined;
    try {
      parsed = parsePoolLease(await readPrivateJson(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      parsed = undefined;
    }
    if (!parsed) {
      const ageMs = nowMs - Number(info.mtimeNs / 1_000_000n);
      if (ageMs < WORKSPACE_POOL_GC_DEFAULTS.leaseTtlMs) active += 1;
      else if (options.cleanupExpired && isPrivateRegularFileStats(info)) {
        await unlink(file).catch(() => {});
        removedExpired += 1;
      }
      continue;
    }
    const state = await inspectLeaseState(parsed, nowMs);
    if (state === "dead") {
      if (options.cleanupExpired) {
        await unlink(file).catch(() => {});
        removedExpired += 1;
      }
      continue;
    }
    if (state === "unknown") {
      active += 1;
      unverifiable += 1;
      continue;
    }
    if (!options.filterScope || !parsed.scope || parsed.scope === options.filterScope) {
      active += 1;
    }
  }
  return { active, unverifiable, removedExpired };
}

export async function acquireGcLease(
  sharedRoot: string,
  gcId: string,
  ttlMs: number,
  now: () => number,
): Promise<{ acquired: boolean; startedAt: number }> {
  const gcLeasePath = join(sharedRoot, "gc.lease");
  const hostBoot = currentBootId();
  const procStart = await currentProcessStart();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = now();
    const record: PoolGcLeaseRecord = {
      version: 1,
      id: gcId,
      pid: process.pid,
      ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
      ...(procStart !== undefined ? { processStart: procStart } : {}),
      phase: "mark",
      startedAt,
      updatedAt: startedAt,
      expiresAt: startedAt + ttlMs,
    };
    const tmp = join(sharedRoot, `.gc.lease.${gcId}.${attempt}.tmp`);
    const handle = await open(tmp, "wx", 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(record)); }
      finally { await handle.close(); }
      try {
        activeInProcessLeases.add(gcId);
        await link(tmp, gcLeasePath);
        return { acquired: true, startedAt };
      } catch (error) {
        activeInProcessLeases.delete(gcId);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }

    const existing = await readGcLease(sharedRoot);
    if (existing.record && await isLeaseLive(existing.record, now())) {
      return { acquired: false, startedAt: 0 };
    }
    if (existing.corrupt && existing.info) {
      const ageMs = now() - Number(existing.info.mtimeNs / 1_000_000n);
      if (ageMs < ttlMs) return { acquired: false, startedAt: 0 };
    }
    if (existing.info) {
      try {
        const current = await lstat(gcLeasePath, { bigint: true });
        if (current.dev === existing.info.dev && current.ino === existing.info.ino) {
          await unlink(gcLeasePath).catch(() => {});
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return { acquired: false, startedAt: 0 };
}

export async function updateGcLease(
  sharedRoot: string,
  gcId: string,
  startedAt: number,
  phase: "mark" | "sweep",
  ttlMs: number,
  now: () => number,
): Promise<boolean> {
  const existing = await readGcLease(sharedRoot);
  if (existing.record?.id !== gcId) return false;
  const hostBoot = currentBootId();
  const procStart = await currentProcessStart();
  const current = now();
  const record: PoolGcLeaseRecord = {
    version: 1,
    id: gcId,
    pid: process.pid,
    ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
    ...(procStart !== undefined ? { processStart: procStart } : {}),
    phase,
    startedAt,
    updatedAt: current,
    expiresAt: current + ttlMs,
  };
  await writeAtomicJson(join(sharedRoot, "gc.lease"), record);
  return true;
}

export async function releaseGcLease(sharedRoot: string, gcId: string): Promise<void> {
  activeInProcessLeases.delete(gcId);
  const existing = await readGcLease(sharedRoot).catch(() => ({ record: undefined }));
  if (existing.record?.id === gcId) {
    await unlink(join(sharedRoot, "gc.lease")).catch(() => {});
  }
}
