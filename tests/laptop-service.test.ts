import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { synchronizeWorkspace } from "../packages/host/src/laptop-service.js";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import type { ExecutorControl } from "../packages/host/src/executor-tunnel.js";

test("laptop sync commits once while idle, follows file changes, and recommits until acknowledged", {
  skip: process.platform !== "darwin",
  timeout: 30000,
}, async t => {
  const base = mkdtempSync(join(tmpdir(), "laptop-service-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "file.txt"), "one\n");

  const revision = 7;
  const checkpoint = { id: "initial" };
  const commits: string[] = [];
  let acknowledged = true;
  let epoch = 0;
  let begins = 0;
  const control: ExecutorControl = async (method, params) => {
    switch (method) {
      case "sync/status":
        return { location: "laptop", revision, checkpoint, acknowledged };
      case "sync/begin":
        begins += 1;
        epoch += 1;
        return { revision, epoch };
      case "sync/has":
        return { missing: [] };
      case "sync/commit": {
        const manifest = (params as { manifest: { id: string } }).manifest;
        commits.push(manifest.id);
        checkpoint.id = manifest.id;
        return { checkpoint, epoch };
      }
      case "sync/problem":
        return { received: true };
      default:
        throw new Error(`Unexpected control call: ${method}`);
    }
  };

  const waitForCommitCount = async (count: number) => {
    const deadline = Date.now() + 6000;
    while (commits.length < count && Date.now() < deadline) await delay(25);
    assert.equal(commits.length, count, `expected ${count} commits within one loop interval`);
  };

  const abort = new AbortController();
  const running = synchronizeWorkspace({
    origin: "https://example.invalid",
    token: "test-token",
    sessionId: randomUUID(),
    workspaceToken: "test-workspace-token",
    cwd: root,
    roots: [root],
    configFile: join(base, "config.json"),
  }, control, abort.signal);

  try {
    await delay(7000);
    assert.equal(commits.length, 1, "an acknowledged idle checkpoint is not committed again");
    assert.equal(begins, 1, "an acknowledged idle checkpoint is not begun again");

    writeFileSync(join(root, "file.txt"), "two\n");
    await waitForCommitCount(2);
    assert.equal(begins, 2, "a file change starts another checkpoint");

    assert.equal(checkpoint.id, commits[1]);
    acknowledged = false;
    await waitForCommitCount(3);
    assert.equal(begins, 3, "an unacknowledged checkpoint is recommitted at the same revision and ID");
  } finally {
    abort.abort();
    await running;
  }
});

test("laptop checkpoint uploads overlap but stay bounded and finish before commit", {
  skip: process.platform !== "darwin",
  timeout: 30000,
}, async t => {
  const base = mkdtempSync(join(tmpdir(), "laptop-service-transfer-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  mkdirSync(root);
  const chunkBytes = 256 * 1024;
  writeFileSync(join(root, "chunks.bin"), Buffer.concat(Array.from({ length: 8 }, (_, index) => Buffer.alloc(chunkBytes, index + 1))));

  const checkpoint = { id: "initial" };
  const started: string[] = [];
  const settled = new Set<string>();
  let active = 0;
  let maxActive = 0;
  let releaseTransfers!: () => void;
  const transfersReleased = new Promise<void>(resolve => { releaseTransfers = resolve; });
  let committedTransfers = -1;
  const control: ExecutorControl = async (method, params) => {
    switch (method) {
      case "sync/status":
        return { location: "laptop", revision: 3, checkpoint, acknowledged: false };
      case "sync/begin":
        return { revision: 3, epoch: 1 };
      case "sync/has":
        return { missing: (params as { hashes: string[] }).hashes };
      case "sync/blob": {
        const hash = (params as { hash: string }).hash;
        started.push(hash);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await transfersReleased;
          settled.add(hash);
          return { stored: true };
        } finally { active -= 1; }
      }
      case "sync/commit": {
        const hashes = (params as { manifest: { entries: { chunks?: string[] }[] } }).manifest.entries.flatMap(entry => entry.chunks ?? []);
        committedTransfers = settled.size;
        assert.equal(settled.size, hashes.length, "commit waits until every missing blob upload settles");
        checkpoint.id = "uploaded";
        return { checkpoint, epoch: 1 };
      }
      case "sync/problem":
        return { received: true };
      default:
        throw new Error(`Unexpected control call: ${method}`);
    }
  };

  const abort = new AbortController();
  const running = synchronizeWorkspace({
    origin: "https://example.invalid",
    token: "test-token",
    sessionId: randomUUID(),
    workspaceToken: "test-workspace-token",
    cwd: root,
    roots: [root],
    configFile: join(base, "config.json"),
  }, control, abort.signal);

  try {
    const deadline = Date.now() + 5000;
    while (started.length < 4 && Date.now() < deadline) await delay(10);
    assert.equal(started.length, 4, "four transfers should be active before any upload completes");
    assert.equal(maxActive, 4, "the laptop does not consume the whole executor control allowance");
  } finally {
    releaseTransfers();
    const deadline = Date.now() + 5000;
    while (committedTransfers < 0 && Date.now() < deadline && !abort.signal.aborted) await delay(10);
    abort.abort();
    await running;
  }

  assert.equal(started.length, 8, "all missing chunks were uploaded");
  assert.equal(committedTransfers, 8, "the checkpoint is committed only after all uploads settle");
  assert.equal(maxActive, 4, "uploads use bounded concurrency");
});

test("a failed checkpoint upload drains active requests before reporting the retry", {
  skip: process.platform !== "darwin",
  timeout: 30000,
}, async t => {
  const base = mkdtempSync(join(tmpdir(), "laptop-service-failed-transfer-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  mkdirSync(root);
  const chunkBytes = 256 * 1024;
  writeFileSync(join(root, "chunks.bin"), Buffer.concat(Array.from({ length: 8 }, (_, index) => Buffer.alloc(chunkBytes, index + 1))));

  const started: string[] = [];
  const failure = new Error("injected transfer failure");
  let release!: () => void;
  const transfersReleased = new Promise<void>(resolve => { release = resolve; });
  let releaseFailedTransfer!: () => void;
  const firstWindowStarted = new Promise<void>(resolve => { releaseFailedTransfer = resolve; });
  let reportRetry!: () => void;
  const retryReported = new Promise<void>(resolve => { reportRetry = resolve; });
  let problems = 0, commits = 0;
  const control: ExecutorControl = async (method, params) => {
    switch (method) {
      case "sync/status": return { location: "laptop", revision: 3, checkpoint: { id: "initial" }, acknowledged: false };
      case "sync/begin": return { revision: 3, epoch: 1 };
      case "sync/has": return { missing: (params as { hashes: string[] }).hashes };
      case "sync/blob": {
        const hash = (params as { hash: string }).hash;
        started.push(hash);
        if (started.length === 4) releaseFailedTransfer();
        if (started.length === 1) { await firstWindowStarted; throw failure; }
        await transfersReleased;
        return { stored: true };
      }
      case "sync/commit": commits += 1; return { checkpoint: { id: "unexpected" }, epoch: 1 };
      case "sync/problem": problems += 1; reportRetry(); return { received: true };
      default: throw new Error(`Unexpected control call: ${method}`);
    }
  };

  const abort = new AbortController();
  const running = synchronizeWorkspace({
    origin: "https://example.invalid",
    token: "test-token",
    sessionId: randomUUID(),
    workspaceToken: "test-workspace-token",
    cwd: root,
    roots: [root],
    configFile: join(base, "config.json"),
  }, control, abort.signal);

  try {
    const deadline = Date.now() + 5000;
    while (started.length < 4 && Date.now() < deadline) await delay(10);
    assert.equal(started.length, 4, "the first window has four active requests");
    await delay(50);
    assert.equal(problems, 0, "the failed attempt does not report or retry before active requests settle");
    release();
    await retryReported;
    abort.abort();
    await running;
  } finally {
    releaseFailedTransfer();
    release();
    abort.abort();
    await running;
  }

  assert.equal(started.length, 4, "no later chunk starts after the failure");
  assert.equal(commits, 0, "a partial upload is never committed");
  assert.equal(problems, 1, "one settled failed attempt is reported");
});

test("cloud recovery downloads overlap and materialize only after every blob settles", {
  skip: process.platform !== "darwin",
  timeout: 30000,
}, async t => {
  const base = mkdtempSync(join(tmpdir(), "laptop-service-recovery-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace"), cloudRoot = join(base, "cloud-source");
  mkdirSync(root); mkdirSync(cloudRoot);
  const chunkBytes = 256 * 1024;
  const contents = Buffer.concat(Array.from({ length: 8 }, (_, index) => Buffer.alloc(chunkBytes, index + 1)));
  writeFileSync(join(cloudRoot, "chunks.bin"), contents);
  const canonicalCloudRoot = realpathSync(cloudRoot);
  const cloudStore = join(base, "cloud-store");
  const manifest = await captureWorkspace({ roots: [canonicalCloudRoot], cwd: canonicalCloudRoot, storeDir: cloudStore });
  const blobs = new Map(await Promise.all([...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))]
    .map(async hash => [hash, await readWorkspaceBlob(cloudStore, hash)] as const)));
  const sessionId = randomUUID(), directory = join(base, "workspaces", sessionId);
  const destination = join(directory, "recovered", manifest.id);
  const recoveryMarker = join(directory, "recovery.json");
  const configFile = join(base, "config.json");

  const started: string[] = [];
  let active = 0, maxActive = 0;
  let release!: () => void;
  const transfersReleased = new Promise<void>(resolve => { release = resolve; });
  const control: ExecutorControl = async (method, params) => {
    switch (method) {
      case "sync/status": return { location: "cloud", revision: 3, checkpoint: { id: manifest.id }, acknowledged: true };
      case "sync/export": return { manifest };
      case "sync/blob": {
        const hash = (params as { hash: string }).hash;
        started.push(hash);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try { await transfersReleased; return { base64: blobs.get(hash) }; }
        finally { active -= 1; }
      }
      case "sync/problem": return { received: true };
      default: throw new Error(`Unexpected control call: ${method}`);
    }
  };

  const abort = new AbortController();
  const running = synchronizeWorkspace({
    origin: "https://example.invalid",
    token: "test-token",
    sessionId,
    workspaceToken: "test-workspace-token",
    cwd: root,
    roots: [root],
    configFile,
  }, control, abort.signal);

  try {
    const deadline = Date.now() + 5000;
    while (started.length < 4 && Date.now() < deadline) await delay(10);
    assert.equal(started.length, 4, "the recovery fetch uses a four-request window");
    assert.equal(maxActive, 4, "the recovery fetch is bounded");
    assert.equal(existsSync(destination), false, "no recovery tree is visible while chunks remain outstanding");
    release();
    const materializeDeadline = Date.now() + 5000;
    while (!existsSync(recoveryMarker) && Date.now() < materializeDeadline) await delay(10);
    assert.ok(existsSync(recoveryMarker), "the recovery receipt follows complete download and materialization");
    assert.deepEqual(readFileSync(join(destination, "workspace", canonicalCloudRoot.slice(1), "chunks.bin")), contents);
  } finally {
    release();
    abort.abort();
    await running;
  }
  assert.equal(started.length, 8, "all cloud checkpoint chunks were fetched");
  assert.equal(maxActive, 4, "recovery never exceeds the shared transfer bound");
});
