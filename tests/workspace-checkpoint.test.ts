import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, putWorkspaceBlobs, readWorkspaceBlob, WORKSPACE_LIMITS } from "../packages/host/src/workspace-checkpoint.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "infinite-workspace-store-"));
  const sharedPoolDirectory = join(root, "shared-pool");
  const target = (name: string) => ({ directory: join(root, name), sharedPoolDirectory });
  return { root, sharedPoolDirectory, target, close: () => rmSync(root, { recursive: true, force: true }) };
}

function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function poolObject(pool: string, hash: string) { return join(pool, "blobs", hash.slice(0, 2), hash); }
function scopeReference(scope: string, hash: string) { return join(scope, "refs", hash.slice(0, 2), hash); }
function isCode(code: string) { return (error: unknown) => (error as NodeJS.ErrnoException).code === code; }

test("shared chunks deduplicate across scopes without becoming discoverable before a scope reference", async () => {
  const f = fixture(), bytes = randomBytes(128 * 1024), hash = digest(bytes), base64 = bytes.toString("base64");
  const first = f.target("scope-one"), second = f.target("scope-two");
  try {
    await putWorkspaceBlobs(first, [{ hash, bytes }]);
    assert.deepEqual(await hasWorkspaceBlobs(first, [hash]), []);
    assert.deepEqual(await hasWorkspaceBlobs(second, [hash]), [hash], "pool presence alone is not scope authorization");
    await assert.rejects(readWorkspaceBlob(second, hash), isCode("ENOENT"));

    await putWorkspaceBlob(second, hash, base64);
    assert.equal(Buffer.from(await readWorkspaceBlob(first, hash), "base64").compare(bytes), 0);
    assert.equal(Buffer.from(await readWorkspaceBlob(second, hash), "base64").compare(bytes), 0);
    const shared = poolObject(f.sharedPoolDirectory, hash);
    assert.deepEqual(readFileSync(shared), bytes);
    assert.equal(lstatSync(shared).nlink, 1, "scopes reference the pool without hard links");
    assert.equal(existsSync(join(first.directory, "blobs", hash.slice(0, 2), hash)), false);
    assert.equal(existsSync(join(second.directory, "blobs", hash.slice(0, 2), hash)), false);
    assert.equal(lstatSync(scopeReference(first.directory, hash)).nlink, 1);
    assert.equal(lstatSync(scopeReference(first.directory, hash)).size, 0, "references carry membership without duplicate chunk data");
    assert.equal(lstatSync(scopeReference(second.directory, hash)).nlink, 1);
    assert.equal(lstatSync(scopeReference(second.directory, hash)).size, 0);
  } finally { f.close(); }
});

test("concurrent scopes can publish the same immutable chunk and their own references", async () => {
  const f = fixture(), bytes = randomBytes(96 * 1024), hash = digest(bytes), base64 = bytes.toString("base64");
  const first = f.target("scope-one"), second = f.target("scope-two");
  try {
    await Promise.all([putWorkspaceBlob(first, hash, base64), putWorkspaceBlob(second, hash, base64)]);
    assert.deepEqual(readFileSync(poolObject(f.sharedPoolDirectory, hash)), bytes);
    assert.equal(lstatSync(poolObject(f.sharedPoolDirectory, hash)).nlink, 1);
    assert.equal(Buffer.from(await readWorkspaceBlob(first, hash), "base64").compare(bytes), 0);
    assert.equal(Buffer.from(await readWorkspaceBlob(second, hash), "base64").compare(bytes), 0);
  } finally { f.close(); }
});

test("shared publication syncs preexisting pool and scope directory chains around reference publication", async () => {
  const f = fixture(), bytes = randomBytes(1_024), hash = digest(bytes), target = f.target("scope-preexisting");
  const object = poolObject(f.sharedPoolDirectory, hash), reference = scopeReference(target.directory, hash);
  const preexistingDirectories = [
    target.directory, join(target.directory, "blobs"), join(target.directory, "refs"), dirname(reference),
    f.sharedPoolDirectory, join(f.sharedPoolDirectory, "blobs"), dirname(object),
  ];
  for (const directory of preexistingDirectories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonicalPool = realpathSync(f.sharedPoolDirectory), canonicalScope = realpathSync(target.directory);
  const canonicalObject = join(realpathSync(dirname(object)), hash);
  const canonicalReference = join(realpathSync(dirname(reference)), hash);

  const events: string[] = [];
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const [path, flags] = args;
    const handle = await originalOpen(...args);
    if (flags === "wx" && realpathSync(String(path)) === canonicalReference) events.push("reference-published");
    if (typeof flags === "number" && (flags & constants.O_DIRECTORY)) {
      const sync = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", {
        configurable: true,
        value: async () => { events.push(`sync:${realpathSync(String(path))}`); await sync(); },
      });
    }
    return handle;
  }) as typeof fsp.open;
  syncBuiltinESMExports();
  try {
    await putWorkspaceBlob(target, hash, bytes.toString("base64"));
    const referenceIndex = events.indexOf("reference-published");
    assert.notEqual(referenceIndex, -1, `the scope marker was published; observed ${events.join(", ")}`);
    const poolDirectories = [dirname(canonicalObject), join(canonicalPool, "blobs"), canonicalPool];
    for (let parent = dirname(canonicalPool); ; parent = dirname(parent)) {
      poolDirectories.push(parent);
      if (parent === dirname(parent)) break;
    }
    for (const directory of poolDirectories) {
      const syncIndex = events.indexOf(`sync:${realpathSync(directory)}`);
      assert.ok(syncIndex >= 0 && syncIndex < referenceIndex, `pool directory ${directory} is durable before the scope marker`);
    }
    const scopeDirectories = [dirname(canonicalReference), join(canonicalScope, "refs"), canonicalScope];
    for (const directory of scopeDirectories) {
      const syncIndex = events.lastIndexOf(`sync:${realpathSync(directory)}`);
      assert.ok(syncIndex > referenceIndex, `scope directory ${directory} is durable after the scope marker`);
    }
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    f.close();
  }
});

test("capture continues reporting progress while publishing shared references", async () => {
  const f = fixture(), workspace = join(f.root, "workspace"), target = f.target("progress-scope");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "first.txt"), "first");
  writeFileSync(join(workspace, "second.txt"), "second");
  const referencePrefix = join(realpathSync(f.root), "progress-scope", "refs") + "/";
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalOpen = fsp.open;
  let references = 0, progressDuringPublication = 0;
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args);
    if (args[1] === "wx" && String(args[0]).startsWith(referencePrefix)) {
      references += 1;
      await delay(125);
    }
    return handle;
  }) as typeof fsp.open;
  syncBuiltinESMExports();
  try {
    await captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: target,
      onProgress: () => { if (references > 0 && references < 2) progressDuringPublication += 1; } });
    assert.equal(references, 2);
    assert.ok(progressDuringPublication > 0, "slow reference publication must keep the sync startup watchdog informed");
  } finally {
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    f.close();
  }
});

test("legacy scoped blobs remain readable when shared storage is enabled", async () => {
  const f = fixture(), legacyBytes = Buffer.from("legacy workspace chunk\n"), pooledBytes = Buffer.from("new workspace chunk\n");
  const scope = join(f.root, "legacy-scope"), shared = { directory: scope, sharedPoolDirectory: f.sharedPoolDirectory };
  const legacyHash = digest(legacyBytes), pooledHash = digest(pooledBytes);
  try {
    await putWorkspaceBlob(scope, legacyHash, legacyBytes.toString("base64"));
    await putWorkspaceBlob(shared, pooledHash, pooledBytes.toString("base64"));
    assert.equal(Buffer.from(await readWorkspaceBlob(shared, legacyHash), "base64").compare(legacyBytes), 0);
    assert.equal(Buffer.from(await readWorkspaceBlob(shared, pooledHash), "base64").compare(pooledBytes), 0);
    assert.equal(existsSync(join(scope, "blobs", legacyHash.slice(0, 2), legacyHash)), true);
    assert.equal(existsSync(join(scope, "blobs", pooledHash.slice(0, 2), pooledHash)), false);
  } finally { f.close(); }
});

test("capture and materialization resolve chunks through their scoped shared pool", async () => {
  const f = fixture(), workspace = join(f.root, "workspace"), destination = join(f.root, "materialized");
  const bytes = randomBytes(WORKSPACE_LIMITS.chunkBytes + 37), target = f.target("capture-scope");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "content.bin"), bytes);
  try {
    const manifest = await captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: target });
    const hashes = manifest.entries.flatMap(entry => entry.chunks ?? []);
    assert.equal(hashes.length, 2);
    assert.deepEqual(await hasWorkspaceBlobs(target, hashes), []);
    const restored = await materializeWorkspace({ manifest, storeDir: target, destination });
    assert.deepEqual(readFileSync(join(restored.roots[0], "content.bin")), bytes);
  } finally { f.close(); }
});

test("shared pool symlinks and hard links are rejected before the scope can reference them", async () => {
  for (const kind of ["symlink", "hardlink"] as const) {
    const f = fixture(), bytes = randomBytes(512), hash = digest(bytes), target = f.target(`scope-${kind}`);
    try {
      const object = poolObject(f.sharedPoolDirectory, hash), external = join(f.root, `external-${kind}`);
      mkdirSync(dirname(object), { recursive: true, mode: 0o700 });
      writeFileSync(external, bytes, { mode: 0o600 });
      if (kind === "symlink") symlinkSync(external, object);
      else linkSync(external, object);
      await assert.rejects(putWorkspaceBlob(target, hash, bytes.toString("base64")), /Unsafe workspace blob/);
      assert.deepEqual(await hasWorkspaceBlobs(target, [hash]), [hash]);
      assert.equal(existsSync(scopeReference(target.directory, hash)), false);
    } finally { f.close(); }
  }
});

test("scope references reject symlinks and hard links", async () => {
  for (const kind of ["symlink", "hardlink"] as const) {
    const f = fixture(), bytes = randomBytes(384), hash = digest(bytes), target = f.target(`scope-${kind}`);
    try {
      await putWorkspaceBlob(target, hash, bytes.toString("base64"));
      const reference = scopeReference(target.directory, hash), external = join(f.root, `external-${kind}`);
      unlinkSync(reference);
      writeFileSync(external, Buffer.alloc(0), { mode: 0o600 });
      if (kind === "symlink") symlinkSync(external, reference);
      else linkSync(external, reference);
      await assert.rejects(readWorkspaceBlob(target, hash), /Unsafe workspace reference/);
    } finally { f.close(); }
  }
});

test("failed captures can leave pool objects but do not publish scope references", async () => {
  const f = fixture(), workspace = join(f.root, "workspace");
  const bytes = Buffer.concat([randomBytes(WORKSPACE_LIMITS.chunkBytes), randomBytes(1)]);
  const chunks = [bytes.subarray(0, WORKSPACE_LIMITS.chunkBytes), bytes.subarray(WORKSPACE_LIMITS.chunkBytes)];
  const hashes = chunks.map(digest);
  const target = f.target("capture-scope");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "a.txt"), bytes);
  const rejectedObject = poolObject(f.sharedPoolDirectory, hashes[1]);
  mkdirSync(dirname(rejectedObject), { recursive: true, mode: 0o700 });
  const external = join(f.root, "external-pool-object");
  writeFileSync(external, chunks[1], { mode: 0o600 });
  symlinkSync(external, rejectedObject);
  try {
    await assert.rejects(captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: target }), /Unsafe workspace blob/);
    assert.equal(existsSync(poolObject(f.sharedPoolDirectory, hashes[0])), true, "the earlier immutable write may be orphaned");
    assert.equal(existsSync(scopeReference(target.directory, hashes[0])), false, "failed captures do not expose unreturned chunks");
    assert.deepEqual(await hasWorkspaceBlobs(target, hashes), hashes);
  } finally { f.close(); }
});

test("capture rejects a shared pool inside a selected root before creating storage", async () => {
  const f = fixture(), workspace = join(f.root, "workspace"), bytes = Buffer.from("inside selected root");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "a.txt"), bytes);
  const target = { directory: join(f.root, "capture-scope"), sharedPoolDirectory: join(workspace, "pool") };
  try {
    await assert.rejects(captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: target }), /outside all selected roots/);
    assert.equal(existsSync(target.directory), false);
    assert.equal(existsSync(target.sharedPoolDirectory), false);
  } finally { f.close(); }
});

test("capture rejects a shared pool inside an external Git directory before creating storage", async () => {
  const f = fixture(), workspace = join(f.root, "workspace"), externalRepo = join(f.root, "external-repo");
  mkdirSync(workspace);
  execFileSync("git", ["init", externalRepo], { stdio: "ignore" });
  writeFileSync(join(workspace, ".git"), `gitdir: ${join(externalRepo, ".git")}\n`);
  const target = { directory: join(f.root, "git-scope"), sharedPoolDirectory: join(externalRepo, ".git", "shared-pool") };
  try {
    await assert.rejects(captureWorkspace({ roots: [workspace], cwd: workspace, storeDir: target }), /outside Git metadata/);
    assert.equal(existsSync(target.directory), false);
    assert.equal(existsSync(target.sharedPoolDirectory), false);
  } finally { f.close(); }
});
