import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, putWorkspaceBlobs, readWorkspaceBlob, WORKSPACE_LIMITS,
} from "../packages/host/src/workspace-checkpoint.js";
import {
  acquireSharedPoolLease, CLIENT_LAPTOP_STATE_FILE, collectSharedPool, discoverClientWorkspaceScopes,
  hasLegacyClientWriters, HYBRID_POOL_LEASE_MARKER, inspectHybridSessions, pruneScopeRefs,
  SharedPoolLeaseLostError, writeHybridExportRoot,
} from "../packages/host/src/workspace-pool-gc.js";
import { ProjectSync, type SyncWriter } from "../packages/host/src/project-sync.js";
import { createHybridWorkspace } from "../packages/host/src/hybrid-workspace.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";

function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function poolObject(pool: string, hash: string) { return join(pool, "blobs", hash.slice(0, 2), hash); }
function scopeRef(scope: string, hash: string) { return join(scope, "refs", hash.slice(0, 2), hash); }
function ageFile(file: string, ageMs: number, nowMs = Date.now()) { const s = (nowMs - ageMs) / 1000; utimesSync(file, s, s); }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-pool-gc-")));
  const sharedPoolDirectory = join(root, "workspace-pool");
  const target = (name: string) => ({ directory: join(root, name), sharedPoolDirectory });
  return { root, sharedPoolDirectory, target, close: () => rmSync(root, { recursive: true, force: true }) };
}
function deadPid(): number {
  return Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).trim());
}

test("mark-and-sweep reclaims unreferenced pool objects, stale temp files, and dead scope registrations after grace", { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const sharedBytes = randomBytes(4096), onlyABytes = randomBytes(4096), freshOrphanBytes = randomBytes(4096);
    const sharedHash = sha(sharedBytes), onlyAHash = sha(onlyABytes), freshOrphanHash = sha(freshOrphanBytes);
    const scopeA = f.target("scope-a"), scopeB = f.target("scope-b");
    await putWorkspaceBlobs(scopeA, [{ hash: sharedHash, bytes: sharedBytes }, { hash: onlyAHash, bytes: onlyABytes }]);
    await putWorkspaceBlob(scopeB, sharedHash, sharedBytes.toString("base64"));

    const staleTemp = join(f.sharedPoolDirectory, "blobs", sharedHash.slice(0, 2), `.${sharedHash}-${randomUUID()}`);
    const freshTemp = join(f.sharedPoolDirectory, "blobs", sharedHash.slice(0, 2), `.${onlyAHash}-${randomUUID()}`);
    writeFileSync(staleTemp, Buffer.from("partial"), { mode: 0o600 });
    writeFileSync(freshTemp, Buffer.from("active-temp"), { mode: 0o600 });
    const orphanObject = poolObject(f.sharedPoolDirectory, freshOrphanHash);
    mkdirSync(dirname(orphanObject), { recursive: true, mode: 0o700 });
    writeFileSync(orphanObject, freshOrphanBytes, { mode: 0o600 });

    const nowMs = Date.now();
    ageFile(poolObject(f.sharedPoolDirectory, onlyAHash), 30 * 60 * 1000, nowMs);
    ageFile(poolObject(f.sharedPoolDirectory, sharedHash), 30 * 60 * 1000, nowMs);
    ageFile(staleTemp, 30 * 60 * 1000, nowMs);
    rmSync(scopeA.directory, { recursive: true, force: true });

    const first = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => nowMs });
    assert.equal(first.status, "completed");
    assert.equal(first.removedBlobs, 1);
    assert.equal(first.reclaimedBytes, onlyABytes.length);
    assert.equal(first.removedTempFiles, 1);
    assert.equal(first.prunedDeadScopes, 1);
    assert.equal(first.skippedGrace, 1);
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, onlyAHash)), false);
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, sharedHash)), true);
    assert.equal(existsSync(orphanObject), true);
    assert.equal(existsSync(freshTemp), true);
    assert.equal(Buffer.from(await readWorkspaceBlob(scopeB, sharedHash), "base64").compare(sharedBytes), 0);

    const later = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => nowMs + 20 * 60 * 1000 });
    assert.equal(later.removedBlobs, 1);
    assert.equal(later.removedTempFiles, 1);
    assert.equal(existsSync(orphanObject), false);
    assert.equal(existsSync(freshTemp), false);
  } finally { f.close(); }
});

test("discoverClientWorkspaceScopes protects pre-upgrade unregistered sync, pull, and workspace scopes", { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const syncStore = join(f.root, "sync", "proj-a-store");
    const pullScope = join(f.root, "pulls", "proj-b", "objects");
    const workspaceScope = join(f.root, "workspaces", randomUUID(), "objects");
    const nowMs = Date.now();
    const plantPreUpgrade = (scopeDir: string, label: string) => {
      const bytes = Buffer.from(`pre-upgrade-${label}`);
      const hash = sha(bytes);
      const blob = poolObject(f.sharedPoolDirectory, hash);
      const ref = scopeRef(scopeDir, hash);
      mkdirSync(dirname(blob), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(ref), { recursive: true, mode: 0o700 });
      writeFileSync(blob, bytes, { mode: 0o600 });
      writeFileSync(ref, Buffer.alloc(0), { mode: 0o600 });
      ageFile(blob, 30 * 60 * 1000, nowMs);
      return { hash, bytes };
    };
    const syncChunk = plantPreUpgrade(syncStore, "sync");
    const pullChunk = plantPreUpgrade(pullScope, "pull");
    const wsChunk = plantPreUpgrade(workspaceScope, "workspace");
    const orphanBytes = Buffer.from("true-orphan");
    const orphanHash = sha(orphanBytes);
    mkdirSync(dirname(poolObject(f.sharedPoolDirectory, orphanHash)), { recursive: true, mode: 0o700 });
    writeFileSync(poolObject(f.sharedPoolDirectory, orphanHash), orphanBytes, { mode: 0o600 });
    ageFile(poolObject(f.sharedPoolDirectory, orphanHash), 30 * 60 * 1000, nowMs);

    assert.equal(existsSync(join(f.sharedPoolDirectory, "scopes")), false, "pre-upgrade scopes have no registry");
    const discovered = await discoverClientWorkspaceScopes(f.sharedPoolDirectory);
    assert.equal(discovered.length, 3);

    const spawnReady = async (extraArgs: string[] = []) => {
      const child = spawn(process.execPath, ["-e", "process.stdout.write('ok\\n'); setInterval(() => {}, 1000)", ...extraArgs], { stdio: ["ignore", "pipe", "ignore"] });
      await new Promise<void>(resolve => child.stdout!.once("data", () => resolve()));
      return child;
    };
    const legacySyncChild = await spawnReady();
    const legacyLaptopChild = await spawnReady(["--", "--laptop-service"]);
    try {
      const legacySyncState = join(f.root, "sync", "proj-a.json");
      writeFileSync(legacySyncState, JSON.stringify({ pid: legacySyncChild.pid, projectId: "proj-a", root: f.root, origin: "http://127.0.0.1:1", startedAt: new Date().toISOString() }), { mode: 0o600 });
      assert.equal(await hasLegacyClientWriters(f.root, process.pid), true, "live sync state without poolLeases defers client GC");
      const deferredSync = await collectSharedPool({
        sharedPoolDirectory: f.sharedPoolDirectory,
        scopeDirectories: discovered,
        hasLegacyWriters: () => hasLegacyClientWriters(f.root, process.pid),
        graceMs: 10 * 60 * 1000,
        now: () => nowMs,
      });
      assert.equal(deferredSync.status, "deferred-legacy-writer");
      assert.equal(existsSync(poolObject(f.sharedPoolDirectory, orphanHash)), true);

      writeFileSync(legacySyncState, JSON.stringify({ pid: legacySyncChild.pid, projectId: "proj-a", root: f.root, origin: "http://127.0.0.1:1", startedAt: new Date().toISOString(), poolLeases: true }), { mode: 0o600 });
      assert.equal(await hasLegacyClientWriters(f.root, process.pid), true, "unregistered live --laptop-service without state defers client GC");

      const { bootId, processStart } = await import("../packages/host/src/process-census.js");
      const laptopStateDir = dirname(workspaceScope);
      writeFileSync(join(laptopStateDir, CLIENT_LAPTOP_STATE_FILE), JSON.stringify({
        version: 1, pid: legacyLaptopChild.pid, sessionId: "sess-1", poolLeases: true,
        bootId: bootId(), processStart: await processStart(legacyLaptopChild.pid!), startedAt: new Date().toISOString(),
      }), { mode: 0o600 });
      assert.equal(await hasLegacyClientWriters(f.root, process.pid), false, "all live client services verified with poolLeases");

      const brokenState = join(f.root, "sync", "corrupt.json");
      writeFileSync(brokenState, "{not-json", { mode: 0o600 });
      assert.equal(await hasLegacyClientWriters(f.root, process.pid), true, "unreadable client state fails closed");
      rmSync(brokenState, { force: true });

      const res = await collectSharedPool({
        sharedPoolDirectory: f.sharedPoolDirectory,
        scopeDirectories: discovered,
        hasLegacyWriters: () => hasLegacyClientWriters(f.root, process.pid),
        graceMs: 10 * 60 * 1000,
        now: () => nowMs,
      });
      assert.equal(res.status, "completed");
      assert.equal(res.removedBlobs, 1);
      assert.equal(existsSync(poolObject(f.sharedPoolDirectory, orphanHash)), false);
      assert.equal(existsSync(poolObject(f.sharedPoolDirectory, syncChunk.hash)), true);
      assert.equal(existsSync(poolObject(f.sharedPoolDirectory, pullChunk.hash)), true);
      assert.equal(existsSync(poolObject(f.sharedPoolDirectory, wsChunk.hash)), true);
    } finally {
      if (legacySyncChild.exitCode === null) legacySyncChild.kill("SIGKILL");
      if (legacyLaptopChild.exitCode === null) legacyLaptopChild.kill("SIGKILL");
    }
  } finally { f.close(); }
});

test("first-time scope registration fsyncs the registration file and scopes directory before acknowledging writes", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  let syncedTempScopeFile = false;
  let syncedScopesDir = false;
  try {
    const scope = f.target("durable-reg-scope");
    const scopesDir = join(f.sharedPoolDirectory, "scopes");
    fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
      const [filePath, flags] = args;
      const handle = await originalOpen(...args);
      const targetPath = String(filePath);
      const origSync = handle.sync.bind(handle);
      if (flags === "wx" && targetPath.startsWith(`${scopesDir}/`)) {
        Object.defineProperty(handle, "sync", { configurable: true, value: async () => { syncedTempScopeFile = true; await origSync(); } });
      }
      if (typeof flags === "number" && (flags & constants.O_DIRECTORY) && targetPath === scopesDir) {
        Object.defineProperty(handle, "sync", { configurable: true, value: async () => { syncedScopesDir = true; await origSync(); } });
      }
      return handle;
    }) as typeof fsp.open;
    syncBuiltinESMExports();

    const bytes = randomBytes(512);
    await putWorkspaceBlob(scope, sha(bytes), bytes.toString("base64"));
    assert.equal(syncedTempScopeFile, true, "scope registration file was fsynced before rename");
    assert.equal(syncedScopesDir, true, "scopes directory was fsynced after rename");
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    f.close();
  }
});

test("multi-chunk captureWorkspace holds its own write lease until refs publish and defers concurrent zero-grace GC", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  try {
    const workspace = join(f.root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "large.bin"), randomBytes(WORKSPACE_LIMITS.chunkBytes + 128));
    const scope = f.target("capture-scope");
    const refsPrefix = join(scope.directory, "refs") + "/";

    let enteredPublish!: () => void;
    let releasePublish!: () => void;
    const atPublish = new Promise<void>(resolve => { enteredPublish = resolve; });
    const allowPublish = new Promise<void>(resolve => { releasePublish = resolve; });
    let paused = false;

    fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
      if (!paused && args[1] === "wx" && String(args[0]).startsWith(refsPrefix)) {
        paused = true;
        enteredPublish();
        await allowPublish;
      }
      return originalOpen(...args);
    }) as typeof fsp.open;
    syncBuiltinESMExports();

    const capturePromise = captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: scope });
    await atPublish;

    const blobCount = readdirSync(join(f.sharedPoolDirectory, "blobs")).reduce((sum, shard) =>
      sum + readdirSync(join(f.sharedPoolDirectory, "blobs", shard)).length, 0);
    assert.equal(blobCount, 2, "both chunks are written to the pool before refs publish");

    const gcResult = await collectSharedPool({
      sharedPoolDirectory: f.sharedPoolDirectory,
      graceMs: 0,
      now: () => Date.now() + 60_000,
    });
    assert.equal(gcResult.status, "deferred-active-lease");
    assert.equal(gcResult.removedBlobs, 0);
    assert.ok(gcResult.activeLeases >= 1);

    releasePublish();
    const manifest = await capturePromise;
    const hashes = manifest.entries.flatMap(entry => entry.chunks ?? []);
    assert.equal(hashes.length, 2);
    assert.deepEqual(await hasWorkspaceBlobs(scope, hashes), []);
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    f.close();
  }
});

test("external lease revocation mid-capture fails closed with SharedPoolLeaseLostError without publishing refs", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalRename = fsp.rename;
  try {
    const workspace = join(f.root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "revoked capture test\n");
    const scope = f.target("revoked-scope");
    let revoked = false;

    fsp.rename = (async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
      const result = await originalRename(from, to);
      if (!revoked && String(to).startsWith(join(f.sharedPoolDirectory, "blobs") + "/")) {
        revoked = true;
        const leasesDir = join(f.sharedPoolDirectory, "leases");
        for (const name of readdirSync(leasesDir)) {
          if (name.endsWith(".lease")) rmSync(join(leasesDir, name), { force: true });
        }
      }
      return result;
    }) as typeof fsp.rename;
    syncBuiltinESMExports();

    await assert.rejects(
      captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: scope }),
      error => error instanceof SharedPoolLeaseLostError,
    );
    assert.equal(revoked, true);
    const refsDir = join(scope.directory, "refs");
    const publishedRefs = existsSync(refsDir)
      ? readdirSync(refsDir).flatMap(shard => readdirSync(join(refsDir, shard)))
      : [];
    assert.deepEqual(publishedRefs, [], "no scope refs are published after lease loss");

    fsp.rename = originalRename;
    syncBuiltinESMExports();

    let clock = Date.now();
    const lease = await acquireSharedPoolLease(f.sharedPoolDirectory, "write", { scope: scope.directory, leaseTtlMs: 4_000, now: () => clock });
    rmSync(lease.path, { force: true });
    await assert.rejects(lease.assertHeld(), error => error instanceof SharedPoolLeaseLostError);
    clock += 2_000;
    await assert.rejects(lease.refresh(), error => error instanceof SharedPoolLeaseLostError);
    assert.equal(existsSync(lease.path), false, "refresh never recreates a revoked lease file");
    await lease.release();

    const lostLease = await acquireSharedPoolLease(f.sharedPoolDirectory, "write", { scope: scope.directory, leaseTtlMs: 4_000, now: () => clock });
    writeFileSync(join(f.sharedPoolDirectory, "gc.lease"), JSON.stringify({
      version: 1, id: randomUUID(), pid: process.pid, phase: "sweep",
      startedAt: clock, updatedAt: clock, expiresAt: clock + 60_000,
    }), { mode: 0o600 });
    await assert.rejects(lostLease.assertHeld(), error => error instanceof SharedPoolLeaseLostError);
    assert.equal(existsSync(lostLease.path), true, "owned lease file still exists before release");
    await lostLease.release();
    assert.equal(existsSync(lostLease.path), false, "release still unlinks owned lease file after lease loss");
    rmSync(join(f.sharedPoolDirectory, "gc.lease"), { force: true });

    const unknownSweepLease = await acquireSharedPoolLease(f.sharedPoolDirectory, "write", { scope: scope.directory, leaseTtlMs: 4_000, now: () => clock });
    writeFileSync(join(f.sharedPoolDirectory, "gc.lease"), JSON.stringify({
      version: 1, id: randomUUID(), pid: process.pid, phase: "sweep", sweepState: "future-state",
      startedAt: clock, updatedAt: clock, expiresAt: clock + 60_000,
    }), { mode: 0o600 });
    await assert.rejects(unknownSweepLease.assertHeld(), error => error instanceof SharedPoolLeaseLostError);
    await unknownSweepLease.release();
    rmSync(join(f.sharedPoolDirectory, "gc.lease"), { force: true });

    const overlapLease = await acquireSharedPoolLease(f.sharedPoolDirectory, "write", { scope: scope.directory, leaseTtlMs: 4_000, now: () => clock });
    clock += 2_000;
    let enteredRefreshRename!: () => void;
    let releaseRefreshRename!: () => void;
    const atRefreshRename = new Promise<void>(resolve => { enteredRefreshRename = resolve; });
    const allowRefreshRename = new Promise<void>(resolve => { releaseRefreshRename = resolve; });
    let pausedRefresh = false;
    fsp.rename = (async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
      if (!pausedRefresh && String(to) === overlapLease.path) {
        pausedRefresh = true;
        enteredRefreshRename();
        await allowRefreshRename;
      }
      return originalRename(from, to);
    }) as typeof fsp.rename;
    syncBuiltinESMExports();
    const refreshPromise = overlapLease.refresh();
    await atRefreshRename;
    const releasePromise = overlapLease.release();
    await delay(25);
    releaseRefreshRename();
    await Promise.all([refreshPromise, releasePromise]);
    assert.equal(existsSync(overlapLease.path), false, "release awaits in-flight refresh so rename never resurrects lease");
  } finally {
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    f.close();
  }
});

test("an admitted writer keeps its lease while GC closes admission for a sweep", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalRename = fsp.rename;
  let lease: Awaited<ReturnType<typeof acquireSharedPoolLease>> | undefined;
  let injected = false;
  try {
    const deadScope = f.target("dead-scope"), writerScope = f.target("writer-scope");
    const deadBytes = Buffer.from(`closing-barrier-dead-${randomUUID()}`), deadHash = sha(deadBytes);
    await putWorkspaceBlob(deadScope, deadHash, deadBytes.toString("base64"));
    const baseNow = Date.now();
    await pruneScopeRefs({ scopeDirectory: deadScope.directory, keepHashes: new Set(), graceMs: 0, now: () => baseNow + 60_000 });
    ageFile(poolObject(f.sharedPoolDirectory, deadHash), 30 * 60 * 1000, baseNow);

    fsp.rename = (async (...args: Parameters<typeof fsp.rename>) => {
      if (!injected && String(args[1]).endsWith("/gc.lease")) {
        const record = JSON.parse(readFileSync(String(args[0]), "utf8")) as { phase?: string };
        if (record.phase === "sweep") {
          injected = true;
          // Admit a real writer after GC has chosen to close admission but
          // before that barrier is published. The ensuing assertion checks
          // whether this handoff revoked a lease GC must drain first.
          const admittedLease = await acquireSharedPoolLease(f.sharedPoolDirectory, "write", { scope: writerScope.directory });
          lease = admittedLease;
          const result = await originalRename(...args);
          await admittedLease.assertHeld();
          return result;
        }
      }
      return originalRename(...args);
    }) as typeof fsp.rename;
    syncBuiltinESMExports();

    const deferred = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow });
    assert.equal(injected, true);
    assert.equal(deferred.status, "deferred-active-lease");
    assert.equal(deferred.activeLeases, 1);
    assert.equal(deferred.removedBlobs, 0);
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, deadHash)), true);
    const heldLease = lease;
    assert.ok(heldLease);
    await heldLease.assertHeld();
    await heldLease.release();
    lease = undefined;
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    const finish = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow });
    assert.equal(finish.status, "completed");
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, deadHash)), false);
  } finally {
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    await lease?.release();
    f.close();
  }
});

test("live stalled process leases and unreadable process identities are never evicted while alive, and exit cleanly reclaims", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalReadFile = fsp.readFile;
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const scope = f.target("stalled-scope");
    const bytes = randomBytes(1024), hash = sha(bytes);
    const baseNow = Date.now();
    await putWorkspaceBlob(scope, hash, bytes.toString("base64"));
    await pruneScopeRefs({ scopeDirectory: scope.directory, keepHashes: new Set(), graceMs: 0, now: () => baseNow + 60_000 });
    ageFile(poolObject(f.sharedPoolDirectory, hash), 30 * 60 * 1000, baseNow);

    const liveLease = await acquireSharedPoolLease(f.sharedPoolDirectory, "write", { scope: scope.directory, leaseTtlMs: 1_000, now: () => baseNow });
    const farFuture = baseNow + 60 * 60 * 1000;
    const whileStalledInProc = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => farFuture });
    assert.equal(whileStalledInProc.status, "deferred-active-lease", "live in-process lease is never evicted by TTL");
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, hash)), true);
    await liveLease.release();

    const { bootId, processStart } = await import("../packages/host/src/process-census.js");
    const childStart = await processStart(helper.pid!);
    assert.ok(childStart, "child process start identity is observable");
    const extLeasePath = join(f.sharedPoolDirectory, "leases", `${randomUUID()}.lease`);
    writeFileSync(extLeasePath, JSON.stringify({
      version: 1, id: randomUUID(), kind: "write", pid: helper.pid,
      bootId: bootId(), processStart: childStart,
      startedAt: baseNow, updatedAt: baseNow, expiresAt: baseNow + 1_000,
    }), { mode: 0o600 });

    const whileChildAlive = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => farFuture });
    assert.equal(whileChildAlive.status, "deferred-active-lease", "live stalled peer process lease is never evicted by TTL");
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, hash)), true);

    if (process.platform === "linux") {
      fsp.readFile = (async (filePath: Parameters<typeof fsp.readFile>[0], ...rest: unknown[]) => {
        if (String(filePath) === `/proc/${helper.pid}/stat`) throw Object.assign(new Error("transient proc failure"), { code: "EIO" });
        return (originalReadFile as (...a: unknown[]) => unknown)(filePath, ...rest);
      }) as typeof fsp.readFile;
      syncBuiltinESMExports();
      const whileUnreadable = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => farFuture });
      fsp.readFile = originalReadFile;
      syncBuiltinESMExports();
      assert.equal(whileUnreadable.status, "deferred-active-lease", "unreadable processStart on live PID defers GC");
      assert.equal(existsSync(extLeasePath), true, "unreadable processStart never unlinks the lease file");
      assert.equal(existsSync(poolObject(f.sharedPoolDirectory, hash)), true);
    }

    helper.kill("SIGKILL");
    await new Promise<void>(resolve => helper.once("exit", () => resolve()));

    const afterChildDead = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => farFuture });
    assert.equal(afterChildDead.status, "completed");
    assert.equal(afterChildDead.removedBlobs, 1);
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, hash)), false);
  } finally {
    fsp.readFile = originalReadFile;
    syncBuiltinESMExports();
    if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
    f.close();
  }
});

test("dedup reuse between mark and sweep is preserved and writers arriving during sweep proceed after batch yield", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalRename = fsp.rename;
  const originalUnlink = fsp.unlink;
  try {
    const scope1 = f.target("scope-one"), scope2 = f.target("scope-two");
    const baseNow = Date.now();
    const reuseBytes = randomBytes(2048), reuseHash = sha(reuseBytes);
    await putWorkspaceBlob(scope1, reuseHash, reuseBytes.toString("base64"));
    await pruneScopeRefs({ scopeDirectory: scope1.directory, keepHashes: new Set(), graceMs: 0, now: () => baseNow + 60_000 });
    ageFile(poolObject(f.sharedPoolDirectory, reuseHash), 30 * 60 * 1000, baseNow);

    let injected = false;
    fsp.rename = (async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
      if (!injected && String(to).endsWith("/gc.lease")) {
        injected = true;
        await putWorkspaceBlob(scope2, reuseHash, reuseBytes.toString("base64"));
      }
      return originalRename(from, to);
    }) as typeof fsp.rename;
    syncBuiltinESMExports();

    const reref = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow });
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    assert.equal(reref.status, "completed");
    assert.equal(reref.removedBlobs, 0);
    assert.equal(reref.skippedReReferenced, 1);
    assert.equal(Buffer.from(await readWorkspaceBlob(scope2, reuseHash), "base64").compare(reuseBytes), 0);

    const deadChunks = Array.from({ length: 6 }, (_, i) => {
      const bytes = Buffer.from(`batch-dead-${i}-${randomUUID()}`);
      return { hash: sha(bytes), bytes };
    });
    await putWorkspaceBlobs(scope1, deadChunks);
    await pruneScopeRefs({ scopeDirectory: scope1.directory, keepHashes: new Set(), graceMs: 0, now: () => baseNow + 60_000 });
    for (const chunk of deadChunks) ageFile(poolObject(f.sharedPoolDirectory, chunk.hash), 30 * 60 * 1000, baseNow);

    let enteredFirstBatch!: () => void;
    let releaseFirstBatch!: () => void;
    const atFirstBatch = new Promise<void>(resolve => { enteredFirstBatch = resolve; });
    const allowFirstBatch = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
    let paused = false;
    fsp.unlink = (async (filePath: Parameters<typeof fsp.unlink>[0]) => {
      if (!paused && String(filePath).includes(`${join(f.sharedPoolDirectory, "blobs")}/`)) {
        paused = true;
        enteredFirstBatch();
        await allowFirstBatch;
      }
      return originalUnlink(filePath);
    }) as typeof fsp.unlink;
    syncBuiltinESMExports();

    const gcPromise = collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, sweepBatchSize: 2, now: () => baseNow });
    await atFirstBatch;
    const fgBytes = randomBytes(512), fgHash = sha(fgBytes);
    const fgWriter = putWorkspaceBlob(scope2, fgHash, fgBytes.toString("base64"));
    await delay(25);
    releaseFirstBatch();
    const [batchRes] = await Promise.all([gcPromise, fgWriter]);
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();

    assert.ok(batchRes.sweepBatches >= 1);
    assert.ok(batchRes.status === "completed" || batchRes.status === "deferred-active-lease");
    assert.equal(Buffer.from(await readWorkspaceBlob(scope2, fgHash), "base64").compare(fgBytes), 0);
    const finish = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, sweepBatchSize: 2, now: () => baseNow });
    assert.equal(finish.status, "completed");
    for (const chunk of deadChunks) assert.equal(existsSync(poolObject(f.sharedPoolDirectory, chunk.hash)), false);
  } finally {
    fsp.rename = originalRename;
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    f.close();
  }
});

test("materializeWorkspace read lease, dead-PID crash recovery, mid-sweep crash, and corrupt registry fail-closed", { timeout: 30000 }, async () => {
  const f = fixture();
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  const originalUnlink = fsp.unlink;
  try {
    const workspace = join(f.root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "hello materialize\n");
    const liveScope = f.target("live-scope"), deadScope = f.target("dead-scope");
    const manifest = await captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: liveScope });
    const baseNow = Date.now();
    const deadHashes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const bytes = randomBytes(1024), hash = sha(bytes);
      deadHashes.push(hash);
      await putWorkspaceBlob(deadScope, hash, bytes.toString("base64"));
      ageFile(poolObject(f.sharedPoolDirectory, hash), 30 * 60 * 1000, baseNow);
    }
    await pruneScopeRefs({ scopeDirectory: deadScope.directory, keepHashes: new Set(), graceMs: 0, now: () => baseNow + 60_000 });

    let enteredMat!: () => void;
    let releaseMat!: () => void;
    const atMat = new Promise<void>(resolve => { enteredMat = resolve; });
    const allowMat = new Promise<void>(resolve => { releaseMat = resolve; });
    let paused = false;
    fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
      if (!paused && args[1] === "wx" && String(args[0]).endsWith("/a.txt")) { paused = true; enteredMat(); await allowMat; }
      return originalOpen(...args);
    }) as typeof fsp.open;
    syncBuiltinESMExports();

    const matPromise = materializeWorkspace({ manifest, storeDir: liveScope, destination: join(f.root, "restored") });
    await atMat;
    const deferred = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow });
    assert.equal(deferred.status, "deferred-active-lease");
    releaseMat();
    await matPromise;
    fsp.open = originalOpen;
    syncBuiltinESMExports();

    const badReg = join(f.sharedPoolDirectory, "scopes", `${"a".repeat(64)}.json`);
    writeFileSync(badReg, "{corrupt", { mode: 0o600 });
    const aborted = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow });
    assert.equal(aborted.status, "aborted-unsafe-root");
    assert.equal(aborted.removedBlobs, 0);
    rmSync(badReg, { force: true });

    const exitedPid = deadPid();
    writeFileSync(join(f.sharedPoolDirectory, "gc.lease"), JSON.stringify({
      version: 1, id: randomUUID(), pid: exitedPid, phase: "sweep",
      startedAt: baseNow, updatedAt: baseNow, expiresAt: baseNow + 60 * 60 * 1000,
    }), { mode: 0o600 });
    writeFileSync(join(f.sharedPoolDirectory, "leases", `${randomUUID()}.lease`), JSON.stringify({
      version: 1, id: randomUUID(), kind: "write", pid: exitedPid,
      startedAt: baseNow, updatedAt: baseNow, expiresAt: baseNow + 60 * 60 * 1000,
    }), { mode: 0o600 });

    let unlinks = 0;
    fsp.unlink = (async (filePath: Parameters<typeof fsp.unlink>[0]) => {
      if (String(filePath).includes(`${join(f.sharedPoolDirectory, "blobs")}/`)) {
        unlinks += 1;
        if (unlinks === 2) throw Object.assign(new Error("injected crash mid-sweep"), { code: "EIO" });
      }
      return originalUnlink(filePath);
    }) as typeof fsp.unlink;
    syncBuiltinESMExports();

    await assert.rejects(collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow }), /injected crash mid-sweep/);
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();

    assert.equal(existsSync(join(f.sharedPoolDirectory, "gc.lease")), false);
    const recovered = await collectSharedPool({ sharedPoolDirectory: f.sharedPoolDirectory, graceMs: 10 * 60 * 1000, now: () => baseNow });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.removedBlobs, 3);
    for (const hash of deadHashes) assert.equal(existsSync(poolObject(f.sharedPoolDirectory, hash)), false);
  } finally {
    fsp.open = originalOpen;
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    f.close();
  }
});

test("ProjectSync GC fences concurrent begin/missing, retains multiple unexpired exports across restart, and protects forgotten projects", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-psync-gc-")));
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalUnlink = fsp.unlink;
  try {
    const laptopA = join(root, "laptop-a"), cloudA = join(root, "cloud-a");
    const laptopForgotten = join(root, "laptop-forgotten"), cloudForgotten = join(root, "cloud-forgotten");
    for (const d of [laptopA, cloudA, laptopForgotten, cloudForgotten]) mkdirSync(d);
    const key = randomBytes(32), keyFile = join(root, "key");
    writeFileSync(keyFile, key, { mode: 0o600 });
    const config: Config = {
      port: 0, origin: "http://127.0.0.1:1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
      environment: "local", enableDemo: true, maxSessions: 8, agents: {},
      projects: [{ id: "alpha", name: "Alpha", path: cloudA }, { id: "forgotten", name: "Forgotten", path: cloudForgotten }],
      tokens: [{ id: "o", label: "o", role: "owner", hash: hashToken("x".repeat(40)) }],
    };
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    let sync = new ProjectSync(config, key);
    const writer: SyncWriter = { deviceId: "owner-device", publisherId: randomUUID() };
    const idle = async () => false;
    const pushDir = async (projectId: string, sourceDir: string) => {
      const localStore = join(root, `local-${projectId}`);
      const manifest = await captureWorkspace({ roots: [sourceDir], cwd: sourceDir, storeDir: localStore });
      const { generation } = await sync.begin(projectId, writer);
      const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
      for (const hash of await sync.missing(projectId, hashes, writer, generation)) {
        await sync.putBlob(projectId, hash, Buffer.from(await readWorkspaceBlob(localStore, hash), "base64"), writer, generation);
      }
      await sync.commit(projectId, generation, manifest, idle, writer);
      return manifest;
    };

    writeFileSync(join(laptopA, "file.txt"), "generation-one\n");
    const gen1 = await pushDir("alpha", laptopA);
    const gen1Hash = gen1.entries.find(e => e.path === "file.txt")!.chunks![0]!;
    writeFileSync(join(laptopForgotten, "keep.txt"), "forgotten-content\n");
    const forgottenHash = (await pushDir("forgotten", laptopForgotten)).entries.find(e => e.path === "keep.txt")!.chunks![0]!;
    writeFileSync(join(laptopA, "file.txt"), "generation-two\n");
    const gen2 = await pushDir("alpha", laptopA);
    const gen2Hash = gen2.entries.find(e => e.path === "file.txt")!.chunks![0]!;

    writeFileSync(join(cloudA, "export-a.txt"), "export-one-unique\n");
    const exp1 = await sync.exportTree("alpha");
    const exp1Hash = exp1.entries.find(e => e.path === "export-a.txt")!.chunks![0]!;
    const exportsDir = join(config.stateDir, "projects", "alpha", "sync", "exports");
    const exp1File = join(exportsDir, `${exp1.id}.sealed`);
    const exp1Content = readFileSync(exp1File, "utf8");
    rmSync(join(cloudA, "export-a.txt"));
    writeFileSync(join(cloudA, "export-b.txt"), "export-two-unique\n");
    const exp2 = await sync.exportTree("alpha");
    const exp2Hash = exp2.entries.find(e => e.path === "export-b.txt")!.chunks![0]!;
    assert.equal(readFileSync(exp1File, "utf8"), exp1Content, "second export never rewrites first export root file");
    assert.equal(existsSync(join(exportsDir, `${exp2.id}.sealed`)), true, "second export writes its own compact root file");

    config.projects = config.projects.filter(p => p.id !== "forgotten");
    await sync.close();
    sync = new ProjectSync(config, key);

    const poolDir = join(config.stateDir, "workspace-pool");
    const future20m = Date.now() + 20 * 60 * 1000;
    const corruptExport = join(exportsDir, `${"e".repeat(64)}.sealed`);
    writeFileSync(corruptExport, "{corrupt", { mode: 0o600 });
    const failedClosed = await sync.collectGarbage({ now: () => future20m });
    assert.equal(failedClosed.prunedProjects, 0, "corrupt export root fails project ref pruning closed");
    assert.equal(existsSync(poolObject(poolDir, gen1Hash)), true);
    assert.equal(existsSync(exp1File), true);
    rmSync(corruptExport, { force: true });
    const refsDir = join(config.stateDir, "projects", "alpha", "sync", "blobs", "refs");
    let enteredPruneUnlink!: () => void;
    let releasePruneUnlink!: () => void;
    const atPruneUnlink = new Promise<void>(resolve => { enteredPruneUnlink = resolve; });
    const allowPruneUnlink = new Promise<void>(resolve => { releasePruneUnlink = resolve; });
    let pausedPrune = false;
    fsp.unlink = (async (filePath: Parameters<typeof fsp.unlink>[0]) => {
      if (!pausedPrune && String(filePath).startsWith(`${refsDir}/`) && String(filePath).endsWith(`/${gen1Hash}`)) {
        pausedPrune = true;
        enteredPruneUnlink();
        await allowPruneUnlink;
      }
      return originalUnlink(filePath);
    }) as typeof fsp.unlink;
    syncBuiltinESMExports();

    const gcPromise = sync.collectGarbage({ now: () => future20m });
    await atPruneUnlink;
    let beginDone = false;
    const concurrentWriter: SyncWriter = { deviceId: "owner-device", publisherId: randomUUID() };
    const beginPromise = sync.begin("alpha", concurrentWriter).then(r => { beginDone = true; return r; });
    await delay(25);
    assert.equal(beginDone, false, "begin() waits for in-flight ref pruning on the same project");
    releasePruneUnlink();
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();

    const [gcRes, began] = await Promise.all([gcPromise, beginPromise]);
    assert.equal(gcRes.pool.status, "completed");
    assert.deepEqual(await sync.missing("alpha", [gen1Hash], concurrentWriter, began.generation), [gen1Hash], "missing() observes pruned ref cleanly");
    assert.equal(existsSync(poolObject(poolDir, gen1Hash)), false);
    assert.equal(existsSync(poolObject(poolDir, gen2Hash)), true);
    assert.equal(existsSync(poolObject(poolDir, exp1Hash)), true, "first export stays intact across second export and restart");
    assert.equal(existsSync(poolObject(poolDir, exp2Hash)), true, "second export stays intact across restart");
    assert.equal(existsSync(poolObject(poolDir, forgottenHash)), true);

    const afterExpiry = await sync.collectGarbage({ now: () => future20m + 2 * 60 * 60 * 1000 });
    assert.equal(afterExpiry.pool.status, "completed");
    assert.equal(existsSync(poolObject(poolDir, exp1Hash)), false);
    assert.equal(existsSync(poolObject(poolDir, exp2Hash)), false);
    assert.equal(existsSync(poolObject(poolDir, gen2Hash)), true);
    assert.equal(existsSync(poolObject(poolDir, forgottenHash)), true);
    await sync.close();
  } finally {
    fsp.unlink = originalUnlink;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hybrid GC owns live worker pruning across long uploads and concurrent exports while host prunes only stopped sessions", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-hybrid-gc-")));
  const stateDir = join(root, "state"), poolDir = join(stateDir, "workspace-pool");
  const sessionId = randomUUID();
  const sessionWorkspaceDir = join(stateDir, "sessions", sessionId, "workspace");
  const laptopRoot = join(root, "laptop"), cloudDir = join(root, "cloud");
  mkdirSync(laptopRoot, { recursive: true });
  mkdirSync(cloudDir, { recursive: true });
  const key = randomBytes(32), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1:1", stateDir, runDir: join(root, "run"), keyFile,
    environment: "local", enableDemo: true, maxSessions: 8, agents: {},
    projects: [{ id: "alpha", name: "Alpha", path: cloudDir }],
    tokens: [{ id: "o", label: "o", role: "owner", hash: hashToken("x".repeat(40)) }],
  };
  const canonicalLaptop = realpathSync(laptopRoot);
  let hybridClock = Date.now();
  const hybrid = await createHybridWorkspace({
    workspace: { cwd: canonicalLaptop, roots: [canonicalLaptop] },
    directory: sessionWorkspaceDir,
    sharedPoolDirectory: poolDir,
    gc: { graceMs: 80, exportRetentionMs: 10_000, readGraceMs: 0, now: () => hybridClock },
    record: () => {},
    publish: () => {},
    select: async () => {},
  });
  let sessionStatus = "running";
  const sync = new ProjectSync(config, key, {
    inspectHybridSessions: () => inspectHybridSessions(stateDir, async () => [{
      id: sessionId, status: sessionStatus, workerPid: process.pid, workspace: { cwd: canonicalLaptop, roots: [canonicalLaptop] },
    }]),
  });
  try {
    hybrid.connection(true);
    hybrid.providerReady(true);
    const localStore = join(root, "local-store");
    const uploadCheckpoint = async (revision: number, content: string) => {
      writeFileSync(join(canonicalLaptop, "work.txt"), content);
      const manifest = await captureWorkspace({ roots: [canonicalLaptop], cwd: canonicalLaptop, storeDir: localStore });
      hybrid.activity({ revision, busy: false, uncertain: false });
      const begin = await hybrid.control("sync/begin");
      const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
      const { missing } = await hybrid.control("sync/has", { hashes });
      for (const hash of missing as string[]) {
        await hybrid.control("sync/blob", { hash, base64: await readWorkspaceBlob(localStore, hash) });
      }
      await hybrid.control("sync/commit", { ...begin, manifest });
      return { manifest, hash: manifest.entries.find(e => e.path === "work.txt")!.chunks![0]! };
    };

    const cp1 = await uploadCheckpoint(1, "checkpoint-one\n");
    const cp2 = await uploadCheckpoint(2, "checkpoint-two\n");
    assert.equal(existsSync(scopeRef(join(sessionWorkspaceDir, "blobs"), cp1.hash)), true, "checkpoint-one stays within grace");

    const markerPath = join(sessionWorkspaceDir, HYBRID_POOL_LEASE_MARKER);
    const savedMarker = readFileSync(markerPath);
    rmSync(markerPath);
    const future30m = hybridClock + 30 * 60 * 1000;
    const legacyDeferred = await sync.collectGarbage({ now: () => future30m });
    assert.equal(legacyDeferred.pool.status, "deferred-legacy-writer", "GC defers while live hybrid worker lacks lease capability");
    assert.equal(existsSync(poolObject(poolDir, cp1.hash)), true);
    writeFileSync(markerPath, savedMarker, { mode: 0o600 });

    hybrid.activity({ revision: 3, busy: false, uncertain: false });
    const longBegin = await hybrid.control("sync/begin");
    assert.deepEqual((await hybrid.control("sync/has", { hashes: [cp1.hash] })).missing, [], "aged superseded ref is observed present by sync/has");
    hybridClock += 5_000;
    await delay(160);
    const hostWhileLive = await sync.collectGarbage({ now: () => future30m });
    assert.equal(hostWhileLive.prunedSessions, 0, "host GC never prunes a live hybrid worker's refs");
    assert.equal(existsSync(scopeRef(join(sessionWorkspaceDir, "blobs"), cp1.hash)), true, "active long upload >graceMs protects aged ref from worker prune timer");
    await hybrid.control("sync/commit", { ...longBegin, manifest: cp1.manifest });
    assert.equal(existsSync(poolObject(poolDir, cp1.hash)), true, "long upload reusing aged ref commits cleanly");

    const exp1Bytes = Buffer.from("hybrid-export-1\n"), exp2Bytes = Buffer.from("hybrid-export-2\n");
    const exp1Hash = sha(exp1Bytes), exp2Hash = sha(exp2Bytes);
    hybridClock = Date.now();
    const tExport = hybridClock;
    await writeHybridExportRoot(sessionWorkspaceDir, sha(Buffer.from("m1")), [exp1Hash], tExport, 10_000);
    await writeHybridExportRoot(sessionWorkspaceDir, sha(Buffer.from("m2")), [exp2Hash], tExport, 20_000);
    await hybrid.control("sync/blob", { hash: exp1Hash, base64: exp1Bytes.toString("base64") });
    await hybrid.control("sync/blob", { hash: exp2Hash, base64: exp2Bytes.toString("base64") });
    const cp3 = await uploadCheckpoint(4, "checkpoint-three\n");

    hybridClock = tExport + 5_000;
    await delay(250);
    assert.equal(existsSync(scopeRef(join(sessionWorkspaceDir, "blobs"), cp2.hash)), false, "live worker delayed timer prunes superseded cp2 ref after grace");
    assert.equal(existsSync(scopeRef(join(sessionWorkspaceDir, "blobs"), cp1.hash)), false, "live worker delayed timer prunes superseded cp1 ref after grace");
    assert.equal(existsSync(scopeRef(join(sessionWorkspaceDir, "blobs"), exp1Hash)), true, "overlapping hybrid export 1 retained until expiry");
    assert.equal(existsSync(scopeRef(join(sessionWorkspaceDir, "blobs"), exp2Hash)), true, "overlapping hybrid export 2 retained until expiry");

    const afterWorkerPrune = await sync.collectGarbage({ now: () => future30m });
    assert.equal(afterWorkerPrune.pool.status, "completed");
    assert.equal(existsSync(poolObject(poolDir, cp2.hash)), false, "pool reclaims blob after live worker prunes superseded ref");
    assert.equal(existsSync(poolObject(poolDir, cp1.hash)), false, "pool reclaims superseded cp1 blob after live worker prunes ref");
    assert.equal(existsSync(poolObject(poolDir, exp1Hash)), true);
    assert.equal(existsSync(poolObject(poolDir, exp2Hash)), true);

    await hybrid.close();
    sessionStatus = "exited";
    writeFileSync(markerPath, JSON.stringify({ version: 1, pid: deadPid(), recordedAt: new Date().toISOString() }), { mode: 0o600 });

    const corruptHybridExport = join(sessionWorkspaceDir, "exports", `${"d".repeat(64)}.json`);
    writeFileSync(corruptHybridExport, "{corrupt", { mode: 0o600 });
    const failClosedHybrid = await sync.collectGarbage({ refGraceMs: 80, graceMs: 80, now: () => tExport + 15_000 });
    assert.equal(failClosedHybrid.prunedSessions, 0, "corrupt hybrid export root fails stopped-session pruning closed");
    assert.equal(existsSync(poolObject(poolDir, exp1Hash)), true);
    rmSync(corruptHybridExport, { force: true });

    const afterExp1Expiry = await sync.collectGarbage({ refGraceMs: 80, graceMs: 80, now: () => tExport + 15_000 });
    assert.equal(afterExp1Expiry.pool.status, "completed");
    assert.equal(afterExp1Expiry.prunedSessions, 1, "host GC prunes stopped session's expired export 1");
    assert.equal(existsSync(poolObject(poolDir, exp1Hash)), false, "expired export 1 reclaimed");
    assert.equal(existsSync(poolObject(poolDir, exp2Hash)), true, "unexpired export 2 still retained");

    const afterExp2Expiry = await sync.collectGarbage({ refGraceMs: 80, graceMs: 80, now: () => tExport + 25_000 });
    assert.equal(afterExp2Expiry.pool.status, "completed");
    assert.equal(existsSync(poolObject(poolDir, exp2Hash)), false, "export 2 reclaimed after its own expiry");
    assert.equal(existsSync(poolObject(poolDir, cp3.hash)), true, "latest checkpoint preserved on stopped session");

    rmSync(join(stateDir, "sessions", sessionId), { recursive: true, force: true });
    const afterDelete = await sync.collectGarbage({ now: () => future30m + 3 * 60 * 60 * 1000 });
    assert.equal(afterDelete.pool.status, "completed");
    assert.equal(existsSync(poolObject(poolDir, cp3.hash)), false);
    assert.equal(readdirSync(join(poolDir, "scopes")).length, 0);
  } finally {
    await sync.close();
    await hybrid.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
