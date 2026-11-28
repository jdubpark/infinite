import type { BigIntStats } from "node:fs";
import { lstat, opendir, readdir, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireGcLease, HASH, inside, inspectProcessIdentity, isPrivateDirectoryStats,
  isPrivateRegularFileStats, parseScopeRegistration, readPrivateJson, releaseGcLease,
  scanPoolLeases, SHARD, syncDirectory, updateGcLease, verifyPrivateDirectory,
  WORKSPACE_POOL_GC_DEFAULTS, type ScopeRegistration,
} from "./workspace-pool-leases.js";
import {
  collectHybridExportRoots, HYBRID_POOL_LEASE_MARKER, manifestChunkHashes, readHybridManifestFile,
} from "./workspace-pool-scopes.js";

export {
  acquireSharedPoolLease, currentBootId, currentProcessStart, registerSharedPoolScope, SharedPoolLeaseLostError,
  withSharedPoolLease, WORKSPACE_POOL_GC_DEFAULTS,
  type AcquireSharedPoolLeaseOptions, type PoolGcLeaseRecord, type PoolLeaseKind, type PoolLeaseRecord, type SharedPoolLeaseHandle,
} from "./workspace-pool-leases.js";
export {
  CLIENT_LAPTOP_STATE_FILE, collectHybridExportRoots, discoverClientWorkspaceScopes, discoverHostWorkspaceScopes,
  hasLegacyClientWriters, hasLegacyHybridWriters, HYBRID_EXPORT_RETENTION_MS, HYBRID_POOL_LEASE_MARKER,
  inspectHybridSessions, manifestChunkHashes, recordClientLaptopState, recordHybridPoolLeaseCapability,
  removeClientLaptopState, writeHybridExportRoot,
  type HybridSessionLike, type HybridSessionsInspection,
} from "./workspace-pool-scopes.js";

export interface PruneScopeRefsOptions {
  scopeDirectory: string;
  keepHashes: ReadonlySet<string>;
  sharedPoolDirectory?: string;
  graceMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PruneScopeRefsResult {
  kept: number;
  removed: number;
  skippedGrace: number;
  aborted: boolean;
  error?: string;
}

export interface CollectSharedPoolOptions {
  sharedPoolDirectory: string;
  scopeDirectories?: readonly string[];
  graceMs?: number;
  gcLeaseTtlMs?: number;
  sweepLeaseTtlMs?: number;
  sweepBatchSize?: number;
  hasLegacyWriters?: () => Promise<boolean>;
  now?: () => number;
  signal?: AbortSignal;
}

export interface CollectSharedPoolResult {
  status: "completed" | "skipped-missing" | "skipped-gc-active" | "deferred-active-lease" | "deferred-legacy-writer" | "aborted-unsafe-root";
  scannedScopes: number;
  prunedDeadScopes: number;
  liveHashes: number;
  scannedBlobs: number;
  removedBlobs: number;
  reclaimedBytes: number;
  removedTempFiles: number;
  removedExpiredLeases: number;
  skippedGrace: number;
  skippedReReferenced: number;
  activeLeases: number;
  sweepBatches: number;
  error?: string;
}

type BlobCandidate = {
  hash: string;
  file: string;
  shard: string;
  size: number;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type TempCandidate = {
  file: string;
  shard: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
};

export function emptyCollectResult(status: CollectSharedPoolResult["status"], error?: string): CollectSharedPoolResult {
  return {
    status,
    scannedScopes: 0,
    prunedDeadScopes: 0,
    liveHashes: 0,
    scannedBlobs: 0,
    removedBlobs: 0,
    reclaimedBytes: 0,
    removedTempFiles: 0,
    removedExpiredLeases: 0,
    skippedGrace: 0,
    skippedReReferenced: 0,
    activeLeases: 0,
    sweepBatches: 0,
    ...(error !== undefined ? { error } : {}),
  };
}

export async function pruneHybridSessionRefs(options: {
  stateDir: string;
  sharedPoolDirectory: string;
  liveSessionIds?: ReadonlySet<string>;
  graceMs?: number;
  exportRetentionMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<{ prunedSessions: number; removedRefs: number }> {
  const sessionsRoot = join(options.stateDir, "sessions");
  let sessionIds: string[];
  try {
    sessionIds = await readdir(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prunedSessions: 0, removedRefs: 0 };
    throw error;
  }
  const now = options.now ?? Date.now;
  const nowMs = now();
  const graceMs = options.graceMs ?? WORKSPACE_POOL_GC_DEFAULTS.refGraceMs;
  const cutoffNs = BigInt(Math.floor(nowMs - graceMs)) * 1_000_000n;
  let prunedSessions = 0;
  let removedRefs = 0;
  for (const sessionId of sessionIds) {
    options.signal?.throwIfAborted();
    if (options.liveSessionIds?.has(sessionId)) continue;
    const workspaceDir = join(sessionsRoot, sessionId, "workspace");
    const scopeDirectory = join(workspaceDir, "blobs");
    try {
      await verifyPrivateDirectory(join(scopeDirectory, "refs"));
    } catch {
      continue;
    }
    try {
      const marker = await readPrivateJson(join(workspaceDir, HYBRID_POOL_LEASE_MARKER)) as { pid?: unknown; bootId?: unknown; processStart?: unknown };
      if (!marker || typeof marker !== "object" || !Number.isInteger(marker.pid) || (marker.pid as number) <= 0) continue;
      const state = await inspectProcessIdentity({
        pid: marker.pid as number,
        ...(typeof marker.bootId === "string" ? { bootId: marker.bootId } : {}),
        ...(typeof marker.processStart === "string" ? { processStart: marker.processStart } : {}),
      });
      if (state !== "dead") continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    let placement: unknown;
    let checkpoint: { manifest?: { entries: { chunks?: string[] }[] } } | undefined;
    let exportRoots: { liveHashes: Set<string>; expiredFiles: string[]; removeLegacyExportJson: boolean };
    try {
      const placementFile = join(workspaceDir, "placement.json");
      try {
        const placementInfo = await lstat(placementFile, { bigint: true });
        if (placementInfo.mtimeNs >= cutoffNs) continue;
        placement = await readPrivateJson(placementFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (placement && typeof placement === "object" && (placement as { phase?: unknown }).phase === "selecting") continue;
      checkpoint = await readHybridManifestFile(join(workspaceDir, "checkpoint.json"));
      exportRoots = await collectHybridExportRoots(workspaceDir, nowMs, options.exportRetentionMs);
    } catch {
      continue;
    }
    for (const file of exportRoots.expiredFiles) await unlink(file).catch(() => {});
    if (exportRoots.removeLegacyExportJson) await unlink(join(workspaceDir, "export.json")).catch(() => {});
    const keepHashes = new Set([...manifestChunkHashes([checkpoint?.manifest]), ...exportRoots.liveHashes]);
    const pruned = await pruneScopeRefs({
      scopeDirectory,
      keepHashes,
      sharedPoolDirectory: options.sharedPoolDirectory,
      graceMs: options.graceMs,
      now: options.now,
      signal: options.signal,
    });
    if (pruned.removed > 0) {
      prunedSessions += 1;
      removedRefs += pruned.removed;
    }
  }
  return { prunedSessions, removedRefs };
}

export async function pruneScopeRefs(options: PruneScopeRefsOptions): Promise<PruneScopeRefsResult> {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? WORKSPACE_POOL_GC_DEFAULTS.refGraceMs;
  const result: PruneScopeRefsResult = { kept: 0, removed: 0, skippedGrace: 0, aborted: false };
  let canonicalScope: string;
  try {
    await verifyPrivateDirectory(options.scopeDirectory);
    canonicalScope = await realpath(options.scopeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    return { ...result, aborted: true, error: error instanceof Error ? error.message : String(error) };
  }
  const refsDir = join(canonicalScope, "refs");
  try {
    await verifyPrivateDirectory(refsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    return { ...result, aborted: true, error: error instanceof Error ? error.message : String(error) };
  }
  let canonicalPool: string | undefined;
  if (options.sharedPoolDirectory) {
    try {
      canonicalPool = await realpath(options.sharedPoolDirectory);
      const leaseCheck = await scanPoolLeases(canonicalPool, now(), { cleanupExpired: false, filterScope: canonicalScope });
      if (leaseCheck.active > 0) return { ...result, aborted: true, error: "active-lease" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ...result, aborted: true, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  const cutoffNs = BigInt(Math.floor(now() - graceMs)) * 1_000_000n;
  const uid = process.getuid?.();
  const touchedShards = new Set<string>();
  const shardEntries = await readdir(refsDir);
  for (const shardName of shardEntries) {
    options.signal?.throwIfAborted();
    if (!SHARD.test(shardName)) continue;
    const shardDir = join(refsDir, shardName);
    try {
      await verifyPrivateDirectory(shardDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ...result, aborted: true, error: error instanceof Error ? error.message : String(error) };
    }
    const dir = await opendir(shardDir);
    for await (const entry of dir) {
      options.signal?.throwIfAborted();
      if (!HASH.test(entry.name) || !entry.name.startsWith(shardName)) continue;
      if (options.keepHashes.has(entry.name)) {
        result.kept += 1;
        continue;
      }
      const file = join(shardDir, entry.name);
      let info: BigIntStats;
      try {
        info = await lstat(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.size !== 0n || info.nlink !== 1n || (uid !== undefined && info.uid !== BigInt(uid)) || (info.mode & 0o077n) !== 0n) {
        continue;
      }
      if (info.mtimeNs >= cutoffNs) {
        result.skippedGrace += 1;
        continue;
      }
      if (canonicalPool && result.removed % 16 === 0) {
        const recheck = await scanPoolLeases(canonicalPool, now(), { cleanupExpired: false, filterScope: canonicalScope });
        if (recheck.active > 0) return { ...result, aborted: true, error: "active-lease" };
      }
      try {
        await unlink(file);
        result.removed += 1;
        touchedShards.add(shardDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  await Promise.all([...touchedShards].map(shard => syncDirectory(shard).catch(() => {})));
  return result;
}

async function discoverRegisteredScopes(
  sharedRoot: string,
  explicitScopes: readonly string[],
): Promise<{ liveScopes: string[]; deadScopeFiles: { file: string; directory: string }[] }> {
  const liveSet = new Set<string>();
  const deadScopeFiles: { file: string; directory: string }[] = [];

  for (const rawScope of explicitScopes) {
    let info: BigIntStats;
    try {
      info = await lstat(rawScope, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      throw error;
    }
    if (!isPrivateDirectoryStats(info)) throw new Error("Workspace scope must be a private owner-controlled directory");
    const canonicalScope = await realpath(rawScope);
    if (inside(sharedRoot, canonicalScope) || inside(canonicalScope, sharedRoot)) {
      throw new Error("Workspace scope and shared pool must use separate directories");
    }
    liveSet.add(canonicalScope);
  }

  const scopesDir = join(sharedRoot, "scopes");
  let entries: string[];
  try {
    await verifyPrivateDirectory(scopesDir);
    entries = await readdir(scopesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { liveScopes: [...liveSet], deadScopeFiles };
    throw error;
  }

  for (const name of entries) {
    if (name.startsWith(".") && name.endsWith(".tmp")) continue;
    if (!name.endsWith(".json")) continue;
    const expectedId = name.slice(0, -5);
    if (!HASH.test(expectedId)) throw new Error("Corrupt workspace pool scope registry entry");
    const file = join(scopesDir, name);
    let parsed: ScopeRegistration | undefined;
    try {
      parsed = parseScopeRegistration(await readPrivateJson(file), expectedId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!parsed) throw new Error("Corrupt workspace pool scope registry entry");
    if (inside(sharedRoot, parsed.directory) || inside(parsed.directory, sharedRoot)) {
      throw new Error("Workspace scope and shared pool must use separate directories");
    }
    let info: BigIntStats;
    try {
      info = await lstat(parsed.directory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        deadScopeFiles.push({ file, directory: parsed.directory });
        continue;
      }
      throw error;
    }
    if (!isPrivateDirectoryStats(info)) throw new Error("Workspace scope must be a private owner-controlled directory");
    try {
      liveSet.add(await realpath(parsed.directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        deadScopeFiles.push({ file, directory: parsed.directory });
        continue;
      }
      throw error;
    }
  }
  return { liveScopes: [...liveSet], deadScopeFiles };
}

async function markScopeRefs(scope: string, liveHashes: Set<string>, signal?: AbortSignal): Promise<void> {
  const refsDir = join(scope, "refs");
  let shards: string[];
  try {
    await verifyPrivateDirectory(refsDir);
    shards = await readdir(refsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  for (const shardName of shards) {
    signal?.throwIfAborted();
    if (!SHARD.test(shardName)) continue;
    const shardDir = join(refsDir, shardName);
    let dir;
    try {
      await verifyPrivateDirectory(shardDir);
      dir = await opendir(shardDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    try {
      for await (const entry of dir) {
        signal?.throwIfAborted();
        if (HASH.test(entry.name) && entry.name.startsWith(shardName)) {
          liveHashes.add(entry.name);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }
}

async function hashReferencedInScopes(scopes: readonly string[], hash: string): Promise<boolean> {
  const shard = hash.slice(0, 2);
  for (const scope of scopes) {
    try {
      await lstat(join(scope, "refs", shard, hash));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }
  return false;
}

export async function collectSharedPool(options: CollectSharedPoolOptions): Promise<CollectSharedPoolResult> {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? WORKSPACE_POOL_GC_DEFAULTS.graceMs;
  const gcLeaseTtlMs = options.gcLeaseTtlMs ?? WORKSPACE_POOL_GC_DEFAULTS.gcLeaseTtlMs;
  const sweepLeaseTtlMs = options.sweepLeaseTtlMs ?? WORKSPACE_POOL_GC_DEFAULTS.sweepLeaseTtlMs;
  const sweepBatchSize = Math.max(1, options.sweepBatchSize ?? WORKSPACE_POOL_GC_DEFAULTS.sweepBatchSize);
  const explicitScopes = options.scopeDirectories ?? [];
  const baseResult = emptyCollectResult("completed");

  let sharedRoot: string;
  try {
    await verifyPrivateDirectory(options.sharedPoolDirectory);
    sharedRoot = await realpath(options.sharedPoolDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCollectResult("skipped-missing");
    return emptyCollectResult("aborted-unsafe-root", error instanceof Error ? error.message : String(error));
  }

  if (options.hasLegacyWriters) {
    let legacyActive = true;
    try { legacyActive = await options.hasLegacyWriters(); } catch { legacyActive = true; }
    if (legacyActive) return emptyCollectResult("deferred-legacy-writer");
  }

  const gcId = randomUUID();
  const lease = await acquireGcLease(sharedRoot, gcId, gcLeaseTtlMs, now);
  if (!lease.acquired) return emptyCollectResult("skipped-gc-active");
  let lastLeaseTouch = lease.startedAt;
  const touchedShards = new Set<string>();

  try {
    options.signal?.throwIfAborted();
    const markStartedAt = now();
    const cutoffNs = BigInt(Math.floor(markStartedAt - graceMs)) * 1_000_000n;

    let discovered: { liveScopes: string[]; deadScopeFiles: { file: string; directory: string }[] };
    try {
      discovered = await discoverRegisteredScopes(sharedRoot, explicitScopes);
    } catch (error) {
      return { ...baseResult, status: "aborted-unsafe-root", error: error instanceof Error ? error.message : String(error) };
    }
    baseResult.scannedScopes = discovered.liveScopes.length;

    const liveHashes = new Set<string>();
    try {
      for (const scope of discovered.liveScopes) {
        options.signal?.throwIfAborted();
        await markScopeRefs(scope, liveHashes, options.signal);
        if (now() - lastLeaseTouch >= Math.max(1000, Math.floor(gcLeaseTtlMs / 3))) {
          if (!(await updateGcLease(sharedRoot, gcId, lease.startedAt, "mark", gcLeaseTtlMs, now))) {
            return { ...baseResult, status: "skipped-gc-active" };
          }
          lastLeaseTouch = now();
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { ...baseResult, status: "aborted-unsafe-root", error: error instanceof Error ? error.message : String(error) };
    }
    baseResult.liveHashes = liveHashes.size;

    const blobCandidates: BlobCandidate[] = [];
    const tempCandidates: TempCandidate[] = [];
    const blobsDir = join(sharedRoot, "blobs");
    let hasBlobsDir = true;
    try {
      await verifyPrivateDirectory(blobsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") hasBlobsDir = false;
      else return { ...baseResult, status: "aborted-unsafe-root", error: error instanceof Error ? error.message : String(error) };
    }

    if (hasBlobsDir) {
      const shards = await readdir(blobsDir);
      for (const shardName of shards) {
        options.signal?.throwIfAborted();
        if (!SHARD.test(shardName)) continue;
        const shardDir = join(blobsDir, shardName);
        try {
          await verifyPrivateDirectory(shardDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          return { ...baseResult, status: "aborted-unsafe-root", error: error instanceof Error ? error.message : String(error) };
        }
        const dir = await opendir(shardDir);
        for await (const entry of dir) {
          options.signal?.throwIfAborted();
          if (now() - lastLeaseTouch >= Math.max(1000, Math.floor(gcLeaseTtlMs / 3))) {
            if (!(await updateGcLease(sharedRoot, gcId, lease.startedAt, "mark", gcLeaseTtlMs, now))) {
              return { ...baseResult, status: "skipped-gc-active" };
            }
            lastLeaseTouch = now();
          }
          const file = join(shardDir, entry.name);
          let info: BigIntStats;
          try {
            info = await lstat(file, { bigint: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (HASH.test(entry.name) && entry.name.startsWith(shardName)) {
            baseResult.scannedBlobs += 1;
            if (liveHashes.has(entry.name)) continue;
            if (!isPrivateRegularFileStats(info)) continue;
            if (info.mtimeNs >= cutoffNs) {
              baseResult.skippedGrace += 1;
              continue;
            }
            blobCandidates.push({
              hash: entry.name,
              file,
              shard: shardDir,
              size: Number(info.size),
              dev: info.dev,
              ino: info.ino,
              mtimeNs: info.mtimeNs,
              ctimeNs: info.ctimeNs,
            });
          } else if (entry.name.startsWith(".") && isPrivateRegularFileStats(info) && info.mtimeNs < cutoffNs) {
            tempCandidates.push({ file, shard: shardDir, dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs });
          }
        }
      }
    }

    const preSweepLeases = await scanPoolLeases(sharedRoot, now(), { cleanupExpired: true });
    baseResult.removedExpiredLeases += preSweepLeases.removedExpired;
    if (preSweepLeases.active > 0) {
      baseResult.activeLeases = preSweepLeases.active;
      return { ...baseResult, status: "deferred-active-lease" };
    }
    if (blobCandidates.length === 0 && tempCandidates.length === 0 && discovered.deadScopeFiles.length === 0) {
      return baseResult;
    }

    const enterSweepWindow = async () => {
      if (!(await updateGcLease(sharedRoot, gcId, lease.startedAt, "sweep", sweepLeaseTtlMs, now))) {
        return { ok: false as const, status: "skipped-gc-active" as const };
      }
      const postBarrierLeases = await scanPoolLeases(sharedRoot, now(), { cleanupExpired: true });
      baseResult.removedExpiredLeases += postBarrierLeases.removedExpired;
      if (postBarrierLeases.active > 0) {
        baseResult.activeLeases = postBarrierLeases.active;
        return { ok: false as const, status: "deferred-active-lease" as const };
      }
      try {
        const freshScopes = await discoverRegisteredScopes(sharedRoot, explicitScopes);
        baseResult.scannedScopes = freshScopes.liveScopes.length;
        return { ok: true as const, freshScopes };
      } catch (error) {
        return { ok: false as const, status: "aborted-unsafe-root" as const, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const totalBatches = Math.max(1, Math.ceil(blobCandidates.length / sweepBatchSize));
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
      options.signal?.throwIfAborted();
      const entered = await enterSweepWindow();
      if (!entered.ok) {
        return { ...baseResult, status: entered.status, ...(entered.error ? { error: entered.error } : {}) };
      }
      baseResult.sweepBatches += 1;
      const batch = blobCandidates.slice(batchIndex * sweepBatchSize, (batchIndex + 1) * sweepBatchSize);

      for (const candidate of batch) {
        options.signal?.throwIfAborted();
        let referenced: boolean;
        try {
          referenced = await hashReferencedInScopes(entered.freshScopes.liveScopes, candidate.hash);
        } catch (error) {
          return { ...baseResult, status: "aborted-unsafe-root", error: error instanceof Error ? error.message : String(error) };
        }
        if (referenced) {
          baseResult.skippedReReferenced += 1;
          continue;
        }
        let current: BigIntStats;
        try {
          current = await lstat(candidate.file, { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!isPrivateRegularFileStats(current) || current.dev !== candidate.dev || current.ino !== candidate.ino ||
            current.mtimeNs !== candidate.mtimeNs || current.ctimeNs !== candidate.ctimeNs || current.mtimeNs >= cutoffNs) {
          baseResult.skippedReReferenced += 1;
          continue;
        }
        try {
          await unlink(candidate.file);
          baseResult.removedBlobs += 1;
          baseResult.reclaimedBytes += candidate.size;
          touchedShards.add(candidate.shard);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      if (batchIndex === totalBatches - 1) {
        for (const temp of tempCandidates) {
          options.signal?.throwIfAborted();
          let current: BigIntStats;
          try {
            current = await lstat(temp.file, { bigint: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (!isPrivateRegularFileStats(current) || current.dev !== temp.dev || current.ino !== temp.ino ||
              current.mtimeNs !== temp.mtimeNs || current.mtimeNs >= cutoffNs) {
            continue;
          }
          try {
            await unlink(temp.file);
            baseResult.removedTempFiles += 1;
            touchedShards.add(temp.shard);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        for (const dead of entered.freshScopes.deadScopeFiles) {
          options.signal?.throwIfAborted();
          try {
            await lstat(dead.directory);
            continue;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") continue;
          }
          try {
            await unlink(dead.file);
            baseResult.prunedDeadScopes += 1;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } else {
        if (!(await updateGcLease(sharedRoot, gcId, lease.startedAt, "mark", gcLeaseTtlMs, now))) {
          return { ...baseResult, status: "skipped-gc-active" };
        }
        await delay(WORKSPACE_POOL_GC_DEFAULTS.pollMs, undefined, { signal: options.signal });
      }
    }

    return baseResult;
  } finally {
    await Promise.all([...touchedShards].map(shard => syncDirectory(shard).catch(() => {})));
    await releaseGcLease(sharedRoot, gcId);
  }
}
