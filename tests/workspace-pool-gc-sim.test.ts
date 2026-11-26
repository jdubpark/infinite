import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hasWorkspaceBlobs, putWorkspaceBlob, readWorkspaceBlob, type WorkspaceStoreTarget } from "../packages/host/src/workspace-checkpoint.js";
import {
  acquireSharedPoolLease, collectSharedPool, pruneScopeRefs, type CollectSharedPoolOptions, type CollectSharedPoolResult, type SharedPoolLeaseHandle,
} from "../packages/host/src/workspace-pool-gc.js";

const DEFAULT_SEEDS = 20;
const ONLY = process.env.WORKSPACE_POOL_GC_SIM_SEED;
const COUNT = Number(process.env.WORKSPACE_POOL_GC_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.WORKSPACE_POOL_GC_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "WORKSPACE_POOL_GC_SIM_SEED, WORKSPACE_POOL_GC_SIM_SEEDS and WORKSPACE_POOL_GC_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const GRACE_MS = 10 * 60 * 1000;
const LEASE_TTL_MS = 2 * 60 * 1000;
const GC_TTL_MS = 60 * 1000;
const SWEEP_TTL_MS = 15 * 1000;
const STEPS_PER_SEED = 30;
const DEAD_PID = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).trim());

class Violation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Violation";
  }
}

type Counts = Record<string, number>;
function bump(counts: Counts, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

class Rand {
  private state: number;
  constructor(seed: number) {
    this.state = (seed | 0) || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}

type ScopeModel = {
  id: string;
  directory: string;
  exists: boolean;
  committed: Set<string>;
  refMtime: Map<string, number>;
};

type LeaseModel = {
  handle: SharedPoolLeaseHandle;
  kind: "write" | "read";
  scopeId?: string;
  expiresAt: number;
};

type Variant = {
  collect?: (options: CollectSharedPoolOptions, context: {
    sharedPoolDirectory: string;
    scopes: ScopeModel[];
    leases: LeaseModel[];
    nowMs: number;
  }) => Promise<CollectSharedPoolResult>;
  skipSweepRefRecheck?: boolean;
  skipUploadPruneFence?: boolean;
  corruptScopePassThrough?: boolean;
  refuseExpiredGcRecovery?: boolean;
};

function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function poolObject(pool: string, hash: string) {
  return join(pool, "blobs", hash.slice(0, 2), hash);
}

function scopeRef(scopeDir: string, hash: string) {
  return join(scopeDir, "refs", hash.slice(0, 2), hash);
}

function stampFile(file: string, ms: number) {
  const sec = ms / 1000;
  utimesSync(file, sec, sec);
}

function listPoolBlobs(pool: string): Set<string> {
  const blobsDir = join(pool, "blobs");
  const result = new Set<string>();
  if (!existsSync(blobsDir)) return result;
  for (const shard of readdirSync(blobsDir)) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    for (const entry of readdirSync(join(blobsDir, shard))) {
      if (/^[a-f0-9]{64}$/.test(entry)) result.add(entry);
    }
  }
  return result;
}

function listPoolTemps(pool: string): string[] {
  const blobsDir = join(pool, "blobs");
  const result: string[] = [];
  if (!existsSync(blobsDir)) return result;
  for (const shard of readdirSync(blobsDir)) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    for (const entry of readdirSync(join(blobsDir, shard))) {
      if (entry.startsWith(".")) result.push(join(blobsDir, shard, entry));
    }
  }
  return result;
}

async function simulate(seed: number, counts: Counts, variant: Variant = {}): Promise<void> {
  const r = new Rand(seed);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-pool-gc-sim-")));
  const sharedPoolDirectory = join(root, "pool");
  mkdirSync(sharedPoolDirectory, { recursive: true, mode: 0o700 });
  const reproduce = `reproduce with WORKSPACE_POOL_GC_SIM_SEED=${seed}`;

  let nowMs = Math.floor(Date.now() / 1000) * 1000 - 30 * 24 * 3600 * 1000;
  const knownContent = new Map<string, Buffer>();
  const poolBlobMtime = new Map<string, number>();
  const tempFileMtime = new Map<string, number>();
  const scopes: ScopeModel[] = ["scope-a", "scope-b", "scope-c"].map(id => ({
    id,
    directory: join(root, id),
    exists: true,
    committed: new Set<string>(),
    refMtime: new Map<string, number>(),
  }));
  const leases: LeaseModel[] = [];
  let crashedGcExpiresAt: number | undefined;

  const targetOf = (scope: ScopeModel): WorkspaceStoreTarget => ({ directory: scope.directory, sharedPoolDirectory });

  const makePayload = (tag: string): { hash: string; bytes: Buffer } => {
    const bytes = Buffer.from(`sim:${seed}:${tag}:${r.int(1, 999_999)}`);
    const hash = sha(bytes);
    knownContent.set(hash, bytes);
    return { hash, bytes };
  };

  const hasLiveLease = () => leases.length > 0;

  const runCollect = async (where: string, expectRecoverExpiredGc = false): Promise<CollectSharedPoolResult> => {
    const beforeBlobs = listPoolBlobs(sharedPoolDirectory);
    const activeBefore = hasLiveLease();
    const expiredGcBefore = crashedGcExpiresAt !== undefined && crashedGcExpiresAt <= nowMs;
    const scopeDirectories = scopes.filter(s => s.exists).map(s => s.directory);
    const options: CollectSharedPoolOptions = {
      sharedPoolDirectory,
      scopeDirectories,
      graceMs: GRACE_MS,
      gcLeaseTtlMs: GC_TTL_MS,
      sweepLeaseTtlMs: SWEEP_TTL_MS,
      now: () => nowMs,
    };

    let result: CollectSharedPoolResult;
    if (variant.refuseExpiredGcRecovery && expiredGcBefore) {
      result = {
        status: "skipped-gc-active", scannedScopes: 0, prunedDeadScopes: 0, liveHashes: 0, scannedBlobs: 0,
        removedBlobs: 0, reclaimedBytes: 0, removedTempFiles: 0, removedExpiredLeases: 0, skippedGrace: 0, skippedReReferenced: 0, activeLeases: 0, sweepBatches: 0,
      };
    } else if (variant.collect) {
      result = await variant.collect(options, { sharedPoolDirectory, scopes, leases, nowMs });
    } else {
      result = await collectSharedPool(options);
    }

    const afterBlobs = listPoolBlobs(sharedPoolDirectory);
    if (activeBefore) {
      for (const hash of beforeBlobs) {
        if (!afterBlobs.has(hash)) {
          throw new Violation(`${where}: I2: pool blob ${hash} was deleted while an active lease was held`);
        }
      }
      if (result.removedBlobs > 0) {
        throw new Violation(`${where}: I2: GC reported ${result.removedBlobs} removed blobs while an active lease was held`);
      }
    }
    for (const [hash, mtime] of poolBlobMtime) {
      if (beforeBlobs.has(hash) && mtime >= nowMs - GRACE_MS && !afterBlobs.has(hash)) {
        throw new Violation(`${where}: I3: pool blob ${hash} within grace window (age ${nowMs - mtime} ms < ${GRACE_MS} ms) was deleted`);
      }
    }
    if (expectRecoverExpiredGc && expiredGcBefore && !activeBefore && result.status === "skipped-gc-active") {
      throw new Violation(`${where}: I5: GC failed to recover an expired gc.lease`);
    }
    if (result.status === "completed") {
      if (expiredGcBefore) crashedGcExpiresAt = undefined;
    }
    for (const hash of [...poolBlobMtime.keys()]) {
      if (!afterBlobs.has(hash)) poolBlobMtime.delete(hash);
    }
    for (const temp of [...tempFileMtime.keys()]) {
      if (!existsSync(temp)) tempFileMtime.delete(temp);
    }
    return result;
  };

  const checkInvariants = async (where: string) => {
    const diskBlobs = listPoolBlobs(sharedPoolDirectory);
    for (const scope of scopes) {
      if (!scope.exists) continue;
      for (const hash of scope.committed) {
        if (!diskBlobs.has(hash)) {
          throw new Violation(`${where}: I1: committed blob ${hash} for ${scope.id} is missing from the shared pool`);
        }
        const expected = knownContent.get(hash)!;
        let actual: Buffer;
        try {
          actual = Buffer.from(await readWorkspaceBlob(targetOf(scope), hash), "base64");
        } catch (error) {
          throw new Violation(`${where}: I1: committed blob ${hash} for ${scope.id} is unreadable (${error instanceof Error ? error.message : String(error)})`);
        }
        if (actual.compare(expected) !== 0) {
          throw new Violation(`${where}: I1: committed blob ${hash} for ${scope.id} content mismatch`);
        }
      }
    }
    for (const [hash, mtime] of poolBlobMtime) {
      if (mtime >= nowMs - GRACE_MS && !diskBlobs.has(hash)) {
        throw new Violation(`${where}: I3: recently written blob ${hash} disappeared within grace window`);
      }
    }
  };

  try {
    for (let step = 1; step <= STEPS_PER_SEED; step += 1) {
      const where = `seed ${seed} step ${step}; ${reproduce}`;
      const draw = r.next();

      if (draw < 0.24) {
        const liveScopes = scopes.filter(s => s.exists);
        const scope = r.pick(liveScopes);
        const existingPoolHashes = [...poolBlobMtime.keys()];
        const reuse = existingPoolHashes.length > 0 && r.next() < 0.45;
        const { hash, bytes } = reuse
          ? { hash: r.pick(existingPoolHashes), bytes: knownContent.get(existingPoolHashes[0]!)! }
          : makePayload(`s${step}`);
        const content = reuse ? knownContent.get(hash)! : bytes;
        const alreadyInPool = existsSync(poolObject(sharedPoolDirectory, hash));
        await putWorkspaceBlob(targetOf(scope), hash, content.toString("base64"));
        if (!alreadyInPool) {
          stampFile(poolObject(sharedPoolDirectory, hash), nowMs);
          poolBlobMtime.set(hash, nowMs);
        }
        stampFile(scopeRef(scope.directory, hash), nowMs);
        scope.committed.add(hash);
        scope.refMtime.set(hash, nowMs);
        bump(counts, reuse ? "op:put-dedup" : "op:put-new");
      } else if (draw < 0.34) {
        const { hash, bytes } = makePayload(`orphan-${step}`);
        const file = poolObject(sharedPoolDirectory, hash);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, bytes, { mode: 0o600 });
        stampFile(file, nowMs);
        poolBlobMtime.set(hash, nowMs);
        const tempFile = join(dirname(file), `.${hash}-${randomUUID()}`);
        writeFileSync(tempFile, Buffer.from("partial"), { mode: 0o600 });
        stampFile(tempFile, nowMs);
        tempFileMtime.set(tempFile, nowMs);
        bump(counts, "op:orphan-and-temp");
      } else if (draw < 0.44) {
        const candidates = scopes.filter(s => s.exists && s.committed.size > 0);
        if (candidates.length > 0) {
          const scope = r.pick(candidates);
          const dropped = r.pick([...scope.committed]);
          scope.committed.delete(dropped);
          bump(counts, "op:supersede");
        }
      } else if (draw < 0.54) {
        const candidates = scopes.filter(s => s.exists && existsSync(join(s.directory, "refs")));
        if (candidates.length > 0) {
          const scope = r.pick(candidates);
          await pruneScopeRefs({
            scopeDirectory: scope.directory,
            keepHashes: scope.committed,
            sharedPoolDirectory,
            graceMs: GRACE_MS,
            now: () => nowMs,
          });
          for (const hash of [...scope.refMtime.keys()]) {
            if (!existsSync(scopeRef(scope.directory, hash))) scope.refMtime.delete(hash);
          }
          bump(counts, "op:prune-refs");
        }
      } else if (draw < 0.64) {
        if (leases.length === 0 || (leases.length < 2 && r.next() < 0.5)) {
          const kind = r.next() < 0.5 ? "write" : "read";
          const liveScopes = scopes.filter(s => s.exists);
          const scope = r.pick(liveScopes);
          try {
            const handle = await acquireSharedPoolLease(sharedPoolDirectory, kind, {
              scope: scope.directory,
              leaseTtlMs: LEASE_TTL_MS,
              maxWaitMs: 25,
              pollMs: 5,
              now: () => nowMs,
            });
            leases.push({ handle, kind, scopeId: scope.id, expiresAt: nowMs + LEASE_TTL_MS });
            bump(counts, `op:lease-open-${kind}`);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("Timed out waiting for workspace pool garbage collection")) throw error;
            if (crashedGcExpiresAt === undefined || crashedGcExpiresAt <= nowMs) {
              throw new Violation(`${where}: I5: lease acquisition timed out without an active sweep lease`);
            }
            bump(counts, "fault:lease-blocked-by-sweep");
          }
        } else {
          const idx = r.int(0, leases.length - 1);
          const lease = leases.splice(idx, 1)[0]!;
          await lease.handle.release();
          if (r.next() < 0.4) {
            mkdirSync(join(sharedPoolDirectory, "leases"), { recursive: true, mode: 0o700 });
            writeFileSync(join(sharedPoolDirectory, "leases", `${randomUUID()}.lease`), JSON.stringify({
              version: 1, id: randomUUID(), kind: lease.kind, pid: DEAD_PID,
              startedAt: nowMs, updatedAt: nowMs, expiresAt: nowMs + LEASE_TTL_MS,
            }), { mode: 0o600 });
            bump(counts, "fault:lease-crash");
          } else {
            bump(counts, "op:lease-close");
          }
        }
      } else if (draw < 0.74) {
        const kind = r.next();
        if (kind < 0.35) {
          nowMs += r.int(5_000, 60_000);
          bump(counts, "op:time-short");
        } else if (kind < 0.85) {
          nowMs += GRACE_MS + LEASE_TTL_MS + 60_000;
          bump(counts, "op:time-long");
        } else {
          nowMs -= r.int(1_000, 30_000);
          bump(counts, "fault:clock-step-back");
        }
      } else if (draw < 0.83) {
        await runCollect(where, true);
        bump(counts, "op:gc-sweep");
      } else if (draw < 0.89) {
        const removable = scopes.filter(s => s.exists && s.id !== "scope-a");
        if (removable.length > 0 && r.next() < 0.5) {
          const scope = r.pick(removable);
          rmSync(scope.directory, { recursive: true, force: true });
          scope.exists = false;
          scope.committed.clear();
          scope.refMtime.clear();
          bump(counts, "op:delete-scope");
        } else {
          const dead = scopes.filter(s => !s.exists);
          if (dead.length > 0) {
            const scope = r.pick(dead);
            scope.exists = true;
            bump(counts, "op:recreate-scope");
          }
        }
      } else if (draw < 0.925) {
        const scope = scopes.find(s => s.exists)!;
        let reusedHash = [...scope.refMtime.entries()].find(([hash, mtime]) =>
          !scope.committed.has(hash) && mtime < nowMs - GRACE_MS && existsSync(scopeRef(scope.directory, hash)) && existsSync(poolObject(sharedPoolDirectory, hash)),
        )?.[0];
        if (!reusedHash && !hasLiveLease() && crashedGcExpiresAt === undefined) {
          const { hash, bytes } = makePayload(`pub-reuse-${step}`);
          await putWorkspaceBlob(targetOf(scope), hash, bytes.toString("base64"));
          const agedAt = nowMs - GRACE_MS - 60_000;
          stampFile(poolObject(sharedPoolDirectory, hash), agedAt);
          stampFile(scopeRef(scope.directory, hash), agedAt);
          poolBlobMtime.set(hash, agedAt);
          scope.refMtime.set(hash, agedAt);
          reusedHash = hash;
        }
        if (reusedHash && !hasLiveLease() && crashedGcExpiresAt === undefined) {
          const pubLease = await acquireSharedPoolLease(sharedPoolDirectory, "write", {
            scope: scope.directory,
            leaseTtlMs: LEASE_TTL_MS,
            maxWaitMs: 25,
            pollMs: 5,
            now: () => nowMs,
          });
          try {
            const missingBefore = await hasWorkspaceBlobs(targetOf(scope), [reusedHash]);
            if (missingBefore.length === 0) {
              const prunedDuringPub = await pruneScopeRefs({
                scopeDirectory: scope.directory,
                keepHashes: scope.committed,
                sharedPoolDirectory: variant.skipUploadPruneFence ? undefined : sharedPoolDirectory,
                graceMs: GRACE_MS,
                now: () => nowMs,
              });
              if (!variant.skipUploadPruneFence && !prunedDuringPub.aborted) {
                throw new Violation(`${where}: I7: pruneScopeRefs did not abort while scoped write lease was held during manifest publication`);
              }
              const missingAtCommit = await hasWorkspaceBlobs(targetOf(scope), [reusedHash]);
              if (missingAtCommit.length > 0) {
                throw new Violation(`${where}: I7: manifest publication reusing aged ref ${reusedHash} failed because concurrent pruning removed its ref`);
              }
              scope.committed.add(reusedHash);
            }
          } finally {
            await pubLease.release();
          }
          if (scope.committed.has(reusedHash)) {
            await runCollect(where);
            if (!existsSync(poolObject(sharedPoolDirectory, reusedHash))) {
              throw new Violation(`${where}: I7: committed manifest blob ${reusedHash} disappeared after fenced manifest publication`);
            }
            bump(counts, "fault:manifest-publish-race");
          }
        }
      } else if (draw < 0.955) {
        let agedDead = [...poolBlobMtime.entries()].find(([hash, mtime]) =>
          mtime < nowMs - GRACE_MS &&
          !scopes.some(s => s.exists && existsSync(scopeRef(s.directory, hash))),
        );
        if (!agedDead && !hasLiveLease() && crashedGcExpiresAt === undefined) {
          const { hash, bytes } = makePayload(`reref-seed-${step}`);
          const file = poolObject(sharedPoolDirectory, hash);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, bytes, { mode: 0o600 });
          const agedAt = nowMs - GRACE_MS - 60_000;
          stampFile(file, agedAt);
          poolBlobMtime.set(hash, agedAt);
          agedDead = [hash, agedAt];
        }
        if (agedDead && !hasLiveLease() && crashedGcExpiresAt === undefined) {
          const [hash] = agedDead;
          const targetScope = scopes.find(s => s.exists)!;
          const bytes = knownContent.get(hash)!;
          const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
          const originalRename = fsp.rename;
          const originalLstat = fsp.lstat;
          let triggered = false;
          let sweepActive = false;
          const targetRefPath = scopeRef(targetScope.directory, hash);
          fsp.rename = (async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
            if (!triggered && String(to).endsWith("/gc.lease")) {
              triggered = true;
              await putWorkspaceBlob(targetOf(targetScope), hash, bytes.toString("base64"));
              stampFile(targetRefPath, nowMs);
              targetScope.committed.add(hash);
              targetScope.refMtime.set(hash, nowMs);
              const res = await originalRename(from, to);
              sweepActive = true;
              return res;
            }
            return originalRename(from, to);
          }) as typeof fsp.rename;
          if (variant.skipSweepRefRecheck) {
            fsp.lstat = (async (...args: Parameters<typeof fsp.lstat>) => {
              if (sweepActive && String(args[0]) === targetRefPath) {
                throw Object.assign(new Error("mutated missing ref recheck"), { code: "ENOENT" });
              }
              return originalLstat(...args);
            }) as typeof fsp.lstat;
          }
          syncBuiltinESMExports();
          try {
            await runCollect(where);
          } finally {
            fsp.rename = originalRename;
            fsp.lstat = originalLstat;
            syncBuiltinESMExports();
          }
          if (triggered) {
            bump(counts, "fault:rereference-race");
            if (!existsSync(poolObject(sharedPoolDirectory, hash))) {
              throw new Violation(`${where}: I4: re-referenced aged blob ${hash} was deleted during concurrent GC`);
            }
            const readBack = Buffer.from(await readWorkspaceBlob(targetOf(targetScope), hash), "base64");
            if (readBack.compare(bytes) !== 0) {
              throw new Violation(`${where}: I4: re-referenced blob ${hash} corrupted`);
            }
          }
        }
      } else if (draw < 0.98) {
        if (!existsSync(join(sharedPoolDirectory, "gc.lease"))) {
          const phase = r.next() < 0.5 ? "mark" : "sweep";
          const expiresAt = nowMs + SWEEP_TTL_MS;
          writeFileSync(join(sharedPoolDirectory, "gc.lease"), JSON.stringify({
            version: 1, id: randomUUID(), pid: process.pid, phase,
            startedAt: nowMs, updatedAt: nowMs, expiresAt,
          }), { mode: 0o600 });
          crashedGcExpiresAt = expiresAt;
          bump(counts, `fault:crashed-gc-${phase}`);
        }
      } else {
        const scopesDir = join(sharedPoolDirectory, "scopes");
        mkdirSync(scopesDir, { recursive: true, mode: 0o700 });
        const corruptFile = join(scopesDir, `${"f".repeat(64)}.json`);
        writeFileSync(corruptFile, "{corrupt", { mode: 0o600 });
        try {
          const beforeBlobs = listPoolBlobs(sharedPoolDirectory);
          if (variant.corruptScopePassThrough) rmSync(corruptFile, { force: true });
          const res = await collectSharedPool({ sharedPoolDirectory, scopeDirectories: scopes.filter(s => s.exists).map(s => s.directory), graceMs: GRACE_MS, now: () => nowMs });
          const afterBlobs = listPoolBlobs(sharedPoolDirectory);
          if (res.status !== "aborted-unsafe-root" && res.status !== "skipped-gc-active") {
            throw new Violation(`${where}: I5: corrupt scope registry did not fail closed (got ${res.status})`);
          }
          if (res.removedBlobs > 0 || afterBlobs.size < beforeBlobs.size) {
            throw new Violation(`${where}: I5: GC deleted blobs despite corrupt scope registry`);
          }
          bump(counts, "fault:corrupt-scope");
        } finally {
          rmSync(corruptFile, { force: true });
        }
      }

      await checkInvariants(where);
    }

    const drainWhere = `seed ${seed} final drain; ${reproduce}`;
    for (const lease of leases.splice(0)) {
      await lease.handle.release();
    }
    nowMs += GRACE_MS + LEASE_TTL_MS + GC_TTL_MS + 60_000;
    for (const scope of scopes) {
      if (!scope.exists) continue;
      await pruneScopeRefs({
        scopeDirectory: scope.directory,
        keepHashes: scope.committed,
        sharedPoolDirectory,
        graceMs: GRACE_MS,
        now: () => nowMs,
      });
    }
    await runCollect(drainWhere, true);
    await checkInvariants(drainWhere);

    const expectedLive = new Set<string>();
    for (const scope of scopes) {
      if (!scope.exists) continue;
      for (const hash of scope.committed) expectedLive.add(hash);
    }
    const finalDiskBlobs = listPoolBlobs(sharedPoolDirectory);
    for (const hash of finalDiskBlobs) {
      if (!expectedLive.has(hash)) {
        throw new Violation(`${drainWhere}: I6: unreferenced aged blob ${hash} was not reclaimed on final drain`);
      }
    }
    const remainingTemps = listPoolTemps(sharedPoolDirectory);
    if (remainingTemps.length > 0) {
      throw new Violation(`${drainWhere}: I6: ${remainingTemps.length} stale temp file(s) not reclaimed on final drain`);
    }
  } finally {
    for (const lease of leases) await lease.handle.release().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

const FLOORS: Readonly<Record<string, number>> = {
  "op:put-new": 45,
  "op:put-dedup": 25,
  "op:orphan-and-temp": 30,
  "op:supersede": 25,
  "op:prune-refs": 25,
  "op:lease-open-write": 8,
  "op:lease-open-read": 8,
  "op:lease-close": 5,
  "fault:lease-crash": 3,
  "op:time-short": 8,
  "op:time-long": 12,
  "fault:clock-step-back": 4,
  "op:gc-sweep": 25,
  "op:delete-scope": 6,
  "fault:rereference-race": 5,
  "fault:manifest-publish-race": 5,
  "fault:corrupt-scope": 5,
};

test("shared workspace pool GC preserves all durability and concurrency invariants under seeded faults", { timeout: 120000 }, async t => {
  const counts: Counts = {};
  const started = performance.now();
  for (const seed of SEEDS) await simulate(seed, counts);
  t.diagnostic(`workspace-pool-gc sim: ${SEEDS.length} seeds from ${SEEDS[0]} in ${((performance.now() - started) / 1000).toFixed(2)}s, ${JSON.stringify(counts)}`);
  if (!DEFAULT_CORPUS) return;
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[name] ?? 0) >= floor, `${name} ran ${counts[name] ?? 0} times, under its floor of ${floor}`);
  }
});

type Mutation = { name: string; invariant: string; variant: Variant };

const MUTATIONS: readonly Mutation[] = [
  {
    name: "GC drops a live scope from root discovery and deletes its committed blob",
    invariant: "I1",
    variant: {
      collect: async (options, ctx) => {
        const victim = ctx.scopes.find(s => s.exists && s.committed.size > 0);
        if (!victim) return collectSharedPool(options);
        const regFile = join(ctx.sharedPoolDirectory, "scopes", `${createHash("sha256").update(victim.directory).digest("hex")}.json`);
        const savedReg = existsSync(regFile) ? readFileSync(regFile) : undefined;
        rmSync(regFile, { force: true });
        try {
          return await collectSharedPool({
            ...options,
            scopeDirectories: (options.scopeDirectories ?? []).filter(dir => dir !== victim.directory),
          });
        } finally {
          if (savedReg) writeFileSync(regFile, savedReg, { mode: 0o600 });
        }
      },
    },
  },
  {
    name: "GC ignores active writer and reader leases during sweep",
    invariant: "I2",
    variant: {
      collect: async (options, ctx) => {
        const leasesDir = join(ctx.sharedPoolDirectory, "leases");
        const backups: { file: string; bytes: Buffer }[] = [];
        if (existsSync(leasesDir)) {
          for (const name of readdirSync(leasesDir)) {
            if (!name.endsWith(".lease")) continue;
            const file = join(leasesDir, name);
            backups.push({ file, bytes: readFileSync(file) });
            rmSync(file, { force: true });
          }
        }
        try {
          return await collectSharedPool(options);
        } finally {
          for (const item of backups) writeFileSync(item.file, item.bytes, { mode: 0o600 });
        }
      },
    },
  },
  {
    name: "GC ignores the safety grace window and deletes freshly orphaned blobs",
    invariant: "I3",
    variant: {
      collect: async options => collectSharedPool({ ...options, graceMs: 0 }),
    },
  },
  {
    name: "GC omits post-mark re-verification and unlinks a blob re-referenced before sweep",
    invariant: "I4",
    variant: {
      skipSweepRefRecheck: true,
    },
  },
  {
    name: "GC fails open when scope registry metadata is corrupt",
    invariant: "I5",
    variant: { corruptScopePassThrough: true },
  },
  {
    name: "GC refuses to recover an expired crashed gc.lease",
    invariant: "I5",
    variant: { refuseExpiredGcRecovery: true },
  },
  {
    name: "GC sweeps nothing and leaks dead blobs and stale temp files",
    invariant: "I6",
    variant: {
      collect: async () => ({
        status: "completed", scannedScopes: 0, prunedDeadScopes: 0, liveHashes: 0, scannedBlobs: 0,
        removedBlobs: 0, reclaimedBytes: 0, removedTempFiles: 0, removedExpiredLeases: 0, skippedGrace: 0, skippedReReferenced: 0, activeLeases: 0, sweepBatches: 0,
      }),
    },
  },
  {
    name: "Pruning runs concurrently with manifest publication reusing an aged ref",
    invariant: "I7",
    variant: { skipUploadPruneFence: true },
  },
];

for (const mutation of MUTATIONS) {
  test(`workspace-pool-gc simulator catches mutant: ${mutation.name} (${mutation.invariant})`, { skip: ONLY !== undefined, timeout: 60000 }, async t => {
    let caught: Violation | undefined;
    for (const seed of SEEDS) {
      try {
        await simulate(seed, {}, mutation.variant);
      } catch (error) {
        if (error instanceof Violation) {
          caught = error;
          break;
        }
        throw error;
      }
    }
    assert.ok(caught, `none of ${SEEDS.length} seeds caught mutant: ${mutation.name}`);
    assert.match(caught.message, new RegExp(`: ${mutation.invariant}: `), `caught by another invariant first: ${caught.message}`);
    t.diagnostic(`caught at ${caught.message.split("; reproduce")[0]}`);
  });
}
