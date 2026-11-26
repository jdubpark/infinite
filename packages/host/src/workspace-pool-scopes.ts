import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  currentBootId, currentProcessStart, ensurePrivateDirectory, HASH, inspectProcessIdentity,
  isPidSignallable, isPrivateRegularFileStats, listOwnClientServicePids, readPrivateJson,
  verifyPrivateDirectory, writeAtomicJson,
} from "./workspace-pool-leases.js";

const MAX_HYBRID_MANIFEST_BYTES = 32 * 1024 * 1024 + 4096;
export const HYBRID_POOL_LEASE_MARKER = "pool-leases.json";
export const HYBRID_EXPORT_RETENTION_MS = 60 * 60 * 1000;
export const CLIENT_LAPTOP_STATE_FILE = "laptop.state";

export interface HybridSessionLike {
  id: string;
  status: string;
  pid?: number;
  workerPid?: number;
  workspace?: unknown;
  executionLocation?: string;
}

export interface HybridSessionsInspection {
  legacyActive: boolean;
  liveSessionIds: Set<string>;
}

type HybridExportRootRecord = {
  version: 1;
  manifestId: string;
  hashes: string[];
  exportedAt: number;
  expiresAt: number;
};

export function manifestChunkHashes(manifests: readonly ({ entries: readonly { chunks?: readonly string[] }[] } | undefined)[]): Set<string> {
  const hashes = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest) continue;
    for (const entry of manifest.entries) {
      if (!entry.chunks) continue;
      for (const hash of entry.chunks) {
        if (HASH.test(hash)) hashes.add(hash);
      }
    }
  }
  return hashes;
}

export async function recordHybridPoolLeaseCapability(workspaceDirectory: string): Promise<void> {
  const hostBoot = currentBootId();
  const procStart = await currentProcessStart();
  await writeAtomicJson(join(workspaceDirectory, HYBRID_POOL_LEASE_MARKER), {
    version: 1,
    pid: process.pid,
    ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
    ...(procStart !== undefined ? { processStart: procStart } : {}),
    recordedAt: new Date().toISOString(),
  }, true);
}

export async function recordClientLaptopState(workspaceDirectory: string, sessionId: string): Promise<void> {
  const hostBoot = currentBootId();
  const procStart = await currentProcessStart();
  await writeAtomicJson(join(workspaceDirectory, CLIENT_LAPTOP_STATE_FILE), {
    version: 1,
    pid: process.pid,
    sessionId,
    poolLeases: true,
    ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
    ...(procStart !== undefined ? { processStart: procStart } : {}),
    startedAt: new Date().toISOString(),
  }, true);
}

export async function removeClientLaptopState(workspaceDirectory: string): Promise<void> {
  const file = join(workspaceDirectory, CLIENT_LAPTOP_STATE_FILE);
  try {
    const existing = await readPrivateJson(file) as { pid?: unknown };
    if (existing?.pid === process.pid) await unlink(file).catch(() => {});
  } catch {}
}

export async function inspectHybridSessions(
  stateDir: string,
  listSessions: () => Promise<readonly HybridSessionLike[]>,
): Promise<HybridSessionsInspection> {
  const liveSessionIds = new Set<string>();
  let sessions: readonly HybridSessionLike[];
  try {
    sessions = await listSessions();
  } catch {
    return { legacyActive: true, liveSessionIds };
  }
  let legacyActive = false;
  for (const session of sessions) {
    const live = ["running", "starting"].includes(session.status) ||
      (["unavailable", "recording-error"].includes(session.status) &&
        (isPidSignallable(session.pid) || isPidSignallable(session.workerPid)));
    if (!live) continue;
    liveSessionIds.add(session.id);
    if (legacyActive) continue;
    const workspaceDir = join(stateDir, "sessions", session.id, "workspace");
    let hasWorkspaceDir = false;
    try {
      hasWorkspaceDir = (await lstat(workspaceDir)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        legacyActive = true;
        continue;
      }
    }
    const hybrid = Boolean(session.workspace) || session.executionLocation === "laptop" || hasWorkspaceDir;
    if (!hybrid) continue;
    let marker: unknown;
    try {
      marker = await readPrivateJson(join(workspaceDir, HYBRID_POOL_LEASE_MARKER));
    } catch {
      legacyActive = true;
      continue;
    }
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
      legacyActive = true;
      continue;
    }
    const record = marker as { version?: unknown; pid?: unknown; bootId?: unknown; processStart?: unknown };
    if (record.version !== 1 || !Number.isInteger(record.pid) || (record.pid as number) <= 0) {
      legacyActive = true;
      continue;
    }
    if (Number.isInteger(session.workerPid) && (session.workerPid as number) > 0 && record.pid !== session.workerPid) {
      legacyActive = true;
      continue;
    }
    const liveness = await inspectProcessIdentity({
      pid: record.pid as number,
      ...(typeof record.bootId === "string" ? { bootId: record.bootId } : {}),
      ...(typeof record.processStart === "string" ? { processStart: record.processStart } : {}),
    });
    if (liveness !== "alive") legacyActive = true;
  }
  return { legacyActive, liveSessionIds };
}

export async function hasLegacyHybridWriters(
  stateDir: string,
  listSessions: () => Promise<readonly HybridSessionLike[]>,
): Promise<boolean> {
  return (await inspectHybridSessions(stateDir, listSessions)).legacyActive;
}

async function listMatchingFiles(dir: string, match: (name: string) => boolean): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || !match(name)) continue;
    const candidate = join(dir, name);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("Unsafe client state file");
      if (info.isFile()) files.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return files;
}

export async function hasLegacyClientWriters(cacheRoot: string, currentPid = process.pid): Promise<boolean> {
  const verifiedPids = new Set<number>([currentPid]);
  let stateFiles: string[] = [];
  try {
    const syncFiles = await listMatchingFiles(join(cacheRoot, "sync"), name => name.endsWith(".json") || name.endsWith(".state"));
    const rootLaptopFiles = await listMatchingFiles(cacheRoot, name => name.startsWith("laptop") && name.endsWith(".state"));
    const workspaceFiles: string[] = [];
    let workspaceIds: string[] = [];
    try {
      workspaceIds = await readdir(join(cacheRoot, "workspaces"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const id of workspaceIds) {
      const dir = join(cacheRoot, "workspaces", id);
      let info;
      try { info = await lstat(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (info.isSymbolicLink()) return true;
      if (!info.isDirectory()) continue;
      workspaceFiles.push(...await listMatchingFiles(dir, name => name === CLIENT_LAPTOP_STATE_FILE || name === "service.json" || name.endsWith(".state")));
    }
    stateFiles = [...syncFiles, ...rootLaptopFiles, ...workspaceFiles];
  } catch {
    return true;
  }

  for (const file of stateFiles) {
    let parsed: unknown;
    try {
      parsed = await readPrivateJson(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
    const record = parsed as { pid?: unknown; poolLeases?: unknown; bootId?: unknown; processStart?: unknown };
    if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return true;
    const pid = record.pid as number;
    if (pid === currentPid) continue;
    const liveness = await inspectProcessIdentity({
      pid,
      ...(typeof record.bootId === "string" ? { bootId: record.bootId } : {}),
      ...(typeof record.processStart === "string" ? { processStart: record.processStart } : {}),
    });
    if (liveness === "dead") continue;
    if (liveness === "unknown") return true;
    if (record.poolLeases !== true) return true;
    verifiedPids.add(pid);
  }

  let running: { pid: number; command: string }[];
  try {
    running = await listOwnClientServicePids();
  } catch {
    return true;
  }
  for (const proc of running) {
    if (!verifiedPids.has(proc.pid)) return true;
  }
  return false;
}

async function collectSubdirScopes(parent: string, suffix: readonly string[], predicate?: (name: string) => boolean): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const scopes: string[] = [];
  for (const name of entries) {
    if (predicate && !predicate(name)) continue;
    const candidate = join(parent, name, ...suffix);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("Workspace scope must be a private owner-controlled directory");
      if (info.isDirectory()) scopes.push(await realpath(candidate));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }
  return scopes;
}

export async function discoverHostWorkspaceScopes(stateDir: string): Promise<string[]> {
  const [projects, sessions] = await Promise.all([
    collectSubdirScopes(join(stateDir, "projects"), ["sync", "blobs"]),
    collectSubdirScopes(join(stateDir, "sessions"), ["workspace", "blobs"]),
  ]);
  return [...new Set([...projects, ...sessions])];
}

export async function discoverClientWorkspaceScopes(sharedPoolDirectory: string): Promise<string[]> {
  let canonicalPool: string;
  try {
    canonicalPool = await realpath(sharedPoolDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const clientRoot = dirname(canonicalPool);
  const [syncStores, workspaces, pulls] = await Promise.all([
    collectSubdirScopes(join(clientRoot, "sync"), [], name => name.endsWith("-store")),
    collectSubdirScopes(join(clientRoot, "workspaces"), ["objects"]),
    collectSubdirScopes(join(clientRoot, "pulls"), ["objects"]),
  ]);
  return [...new Set([...syncStores, ...workspaces, ...pulls])];
}

export async function writeHybridExportRoot(
  workspaceDirectory: string,
  manifestId: string,
  hashes: readonly string[],
  nowMs: number,
  retentionMs = HYBRID_EXPORT_RETENTION_MS,
): Promise<void> {
  if (!HASH.test(manifestId)) throw new Error("Invalid hybrid export manifest id");
  const exportsDir = join(workspaceDirectory, "exports");
  await ensurePrivateDirectory(exportsDir, true);
  const uniqueHashes = [...new Set(hashes.filter(hash => HASH.test(hash)))].sort();
  const record: HybridExportRootRecord = {
    version: 1,
    manifestId,
    hashes: uniqueHashes,
    exportedAt: nowMs,
    expiresAt: nowMs + retentionMs,
  };
  await writeAtomicJson(join(exportsDir, `${manifestId}.json`), record, true);
}

export async function readHybridManifestFile(file: string): Promise<{ manifest?: { id?: string; entries: { chunks?: string[] }[] } } | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!isPrivateRegularFileStats(info) || info.size > BigInt(MAX_HYBRID_MANIFEST_BYTES)) {
      throw new Error("Unsafe hybrid workspace state file");
    }
    const parsed = JSON.parse(await handle.readFile("utf8")) as { manifest?: { id?: unknown; entries?: unknown } };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid hybrid workspace state file");
    if (parsed.manifest !== undefined && (!parsed.manifest || typeof parsed.manifest !== "object" || !Array.isArray(parsed.manifest.entries))) {
      throw new Error("Invalid hybrid workspace manifest");
    }
    return parsed as { manifest?: { id?: string; entries: { chunks?: string[] }[] } };
  } finally {
    await handle.close();
  }
}

export async function collectHybridExportRoots(
  workspaceDirectory: string,
  nowMs: number,
  retentionMs?: number,
): Promise<{ liveHashes: Set<string>; expiredFiles: string[]; removeLegacyExportJson: boolean }> {
  const liveHashes = new Set<string>();
  const expiredFiles: string[] = [];
  const coveredIds = new Set<string>();
  const expiredIds = new Set<string>();
  const exportsDir = join(workspaceDirectory, "exports");
  let entries: string[] | undefined;
  try {
    await verifyPrivateDirectory(exportsDir);
    entries = await readdir(exportsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entries) {
    for (const name of entries) {
      if (name.startsWith(".") && name.endsWith(".tmp")) continue;
      if (!name.endsWith(".json")) throw new Error("Unexpected hybrid export root entry");
      const id = name.slice(0, -5);
      if (!HASH.test(id)) throw new Error("Invalid hybrid export root filename");
      const file = join(exportsDir, name);
      let parsed: unknown;
      try {
        parsed = await readPrivateJson(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid hybrid export root record");
      const rec = parsed as Record<string, unknown>;
      if (rec.version !== 1 || rec.manifestId !== id || !Array.isArray(rec.hashes) ||
          !rec.hashes.every(item => typeof item === "string" && HASH.test(item)) ||
          typeof rec.exportedAt !== "number" || !Number.isFinite(rec.exportedAt) ||
          typeof rec.expiresAt !== "number" || !Number.isFinite(rec.expiresAt)) {
        throw new Error("Invalid hybrid export root record");
      }
      const deadline = retentionMs !== undefined ? rec.exportedAt + retentionMs : rec.expiresAt;
      if (nowMs < deadline) {
        coveredIds.add(id);
        for (const hash of rec.hashes as string[]) liveHashes.add(hash);
      } else {
        expiredIds.add(id);
        expiredFiles.push(file);
      }
    }
  }
  const legacy = await readHybridManifestFile(join(workspaceDirectory, "export.json"));
  let removeLegacyExportJson = false;
  if (legacy?.manifest) {
    const legacyId = typeof legacy.manifest.id === "string" ? legacy.manifest.id : undefined;
    if (legacyId && expiredIds.has(legacyId) && !coveredIds.has(legacyId)) {
      removeLegacyExportJson = true;
    } else if (!legacyId || !coveredIds.has(legacyId)) {
      for (const hash of manifestChunkHashes([legacy.manifest])) liveHashes.add(hash);
    }
  }
  return { liveHashes, expiredFiles, removeLegacyExportJson };
}
