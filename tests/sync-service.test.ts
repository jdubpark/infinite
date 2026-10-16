import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startSyncService, readSyncState, stopSyncService } from "../packages/host/src/sync-service.js";
import { ProjectSyncError } from "../packages/host/src/project-sync.js";
import { inProcessHost, startHost, waitFor } from "./helpers.js";

test("the detached sync service pushes edits, stays pending while a session runs, and stops on request", { timeout: 90000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const stateFile = join(root, "sync", "rehearsal.json");
  const storeDir = join(root, "sync", "rehearsal-store");
  // An apply renames the cloud tree aside before moving the new one in; a read in between finds nothing.
  const cloudFile = () => { try { return readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"); } catch { return undefined; } };
  // A language-server socket in the checkout is left out and reported once at startup.
  const server = createServer();
  try {
    writeFileSync(join(laptop, "app.ts"), "one\n");
    await new Promise<void>(resolve => server.listen(join(laptop, "lsp.sock"), resolve));
    const started = await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir });
    assert.deepEqual(started.skipped, { count: 1, paths: ["lsp.sock"] });
    const state = readSyncState(stateFile)!;
    assert.ok(state.pid > 0);
    assert.equal(state.root, laptop);
    assert.equal(state.skipped, 1);
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 20000);
    assert.equal(cloudFile(), "one\n");

    writeFileSync(join(laptop, "app.ts"), "two\n");
    // The cloud file reads "two" a moment before the apply is recorded; wait for the record too.
    const pushed = await waitFor(() => host.fetchApi("/projects/rehearsal"),
      r => cloudFile() === "two\n" && !r.body.sync.pendingGeneration && r.body.sync.appliedManifest === r.body.sync.lastSyncedManifest, 20000);
    // Two capture cycles over an unchanged tree must not push or replace the cloud copy again.
    await delay(7000);
    const idle = (await host.fetchApi("/projects/rehearsal")).body.sync;
    const recorded = (sync: Record<string, unknown>) => [sync.appliedAt, sync.lastSyncedManifest, sync.lastSyncedAt];
    assert.deepEqual(recorded(idle), recorded(pushed.body.sync), "no new generation was received or applied");

    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    writeFileSync(join(laptop, "app.ts"), "three\n");
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "session-running", 20000);
    assert.equal(cloudFile(), "two\n");

    assert.equal(stopSyncService(stateFile), true);
    assert.equal(existsSync(stateFile), false);
    await waitFor(async () => { try { process.kill(state.pid, 0); return true; } catch { return false; } }, alive => alive === false, 10000);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("a first upload that outlasts the startup inactivity bound completes while capture and commit report progress", { timeout: 120000 }, async () => {
  const host = await inProcessHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop");
  const stateFile = join(root, "sync", "rehearsal.json");
  for (let d = 0; d < 2; d++) {
    mkdirSync(join(laptop, `d${d}`), { recursive: true });
    for (let f = 0; f < 100; f++) writeFileSync(join(laptop, `d${d}`, `f${f}.txt`), `${d}:${f}\n`);
  }
  // The host answers the commit only after applying; hold it well past the bound.
  const bound = 2000, commit = host.projectSync.commit.bind(host.projectSync);
  host.projectSync.commit = (async (...args: Parameters<typeof commit>) => { await delay(3 * bound); return commit(...args); }) as typeof commit;
  try {
    const started = Date.now();
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir: join(root, "sync", "rehearsal-store"), startupInactivityMs: bound });
    assert.ok(Date.now() - started > 3 * bound, "the first upload outlasted the inactivity bound");
    assert.equal(readFileSync(join(host.config.projects[0].path, "d1/f99.txt"), "utf8"), "1:99\n");
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("failed commits back off, and a lasting apply failure holds the content until an explicit apply", { timeout: 120000 }, async () => {
  const host = await inProcessHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const stateFile = join(root, "sync", "rehearsal.json");
  const commit = host.projectSync.commit.bind(host.projectSync);
  const detail = async () => (await host.fetchApi("/projects/rehearsal")).body.sync;
  try {
    writeFileSync(join(laptop, "app.ts"), "one\n");
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir: join(root, "sync", "rehearsal-store") });

    // A transient refusal is retried with the same content, each wait longer than the last.
    const attempts: number[] = [];
    host.projectSync.commit = (async () => { attempts.push(Date.now()); throw new ProjectSyncError("The host is busy", "apply-failed", 409, "other"); }) as typeof commit;
    writeFileSync(join(laptop, "app.ts"), "two\n");
    await waitFor(async () => attempts.length, count => count >= 3, 40000);
    const [first, second] = [attempts[1] - attempts[0], attempts[2] - attempts[1]];
    assert.ok(second - first >= 2000, `retries back off (${first} ms, then ${second} ms)`);
    stopSyncService(stateFile);
    host.projectSync.commit = commit;

    // A lasting failure: the host cannot create its stage beside the project directory.
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir: join(root, "sync", "rehearsal-store") });
    chmodSync(host.root, 0o500);
    writeFileSync(join(laptop, "app.ts"), "three\n");
    const failed = await waitFor(detail, sync => sync.pendingGeneration?.reason === "apply-failed", 20000);
    assert.equal(failed.pendingGeneration.category, "permission");
    await waitFor(async () => readSyncState(stateFile)?.problem, problem => Boolean(problem?.includes("cannot read, write, or remove")), 10000);
    // The same content is not pushed again.
    await delay(7000);
    assert.equal((await detail()).lastSyncedAt, failed.lastSyncedAt);
    chmodSync(host.root, 0o700);
    assert.equal((await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {})).status, 200);
    assert.equal(readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"), "three\n");
    // The service notices the explicit apply and clears its problem without another push.
    await waitFor(async () => readSyncState(stateFile), state => Boolean(state && !state.problem), 20000);
    assert.equal((await detail()).lastSyncedAt, failed.lastSyncedAt);
  } finally {
    chmodSync(host.root, 0o700);
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("a refused device key fails startup and leaves no service state behind", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const stateFile = join(root, "sync", "rehearsal.json");
  try {
    writeFileSync(join(laptop, "app.ts"), "one\n");
    await assert.rejects(startSyncService({ origin: host.origin, token: "x".repeat(43), projectId: "rehearsal", root: laptop, stateFile, storeDir: join(root, "sync", "rehearsal-store") }),
      /did not complete its first upload\. Nothing was applied on the host\. Host refused sync \(401\): \S/);
    assert.equal(existsSync(stateFile), false);
    assert.equal((await host.fetchApi("/projects/rehearsal")).body.sync.lastSyncedAt, undefined);
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("a state file naming another live process is stale: stop leaves that process alone and start proceeds", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const stateFile = join(root, "sync", "rehearsal.json");
  const other = spawn("sleep", ["60"], { stdio: "ignore" });
  const recordOther = () => writeFileSync(stateFile, JSON.stringify({ pid: other.pid, projectId: "rehearsal", root: laptop, origin: host.origin, startedAt: new Date().toISOString() }));
  try {
    mkdirSync(dirname(stateFile)); writeFileSync(join(laptop, "app.ts"), "one\n");
    recordOther();
    assert.equal(stopSyncService(stateFile), false, "a pid that is not a sync service is not a running service");
    assert.equal(existsSync(stateFile), false);
    recordOther();
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir: join(root, "sync", "rehearsal-store") });
    const state = readSyncState(stateFile)!;
    assert.notEqual(state.pid, other.pid);
    assert.equal(stopSyncService(stateFile), true);
    await waitFor(async () => { try { process.kill(state.pid, 0); return true; } catch { return false; } }, alive => alive === false, 10000);
    assert.deepEqual([other.exitCode, other.signalCode], [null, null], "the unrelated process was never signaled");
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    other.kill("SIGKILL");
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
