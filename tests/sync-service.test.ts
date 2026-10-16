import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startSyncService, readSyncState, stopSyncService } from "../packages/host/src/sync-service.js";
import { startHost, waitFor } from "./helpers.js";

test("the detached sync service pushes edits, stays pending while a session runs, and stops on request", { timeout: 90000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const stateFile = join(root, "sync", "rehearsal.json");
  const storeDir = join(root, "sync", "rehearsal-store");
  // An apply renames the cloud tree aside before moving the new one in; a read in between finds nothing.
  const cloudFile = () => { try { return readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"); } catch { return undefined; } };
  try {
    writeFileSync(join(laptop, "app.ts"), "one\n");
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir });
    const state = readSyncState(stateFile)!;
    assert.ok(state.pid > 0);
    assert.equal(state.root, laptop);
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 20000);
    assert.equal(cloudFile(), "one\n");

    writeFileSync(join(laptop, "app.ts"), "two\n");
    const pushed = await waitFor(() => host.fetchApi("/projects/rehearsal"), r => cloudFile() === "two\n" && !r.body.sync.pendingGeneration, 20000);
    // Two capture cycles over an unchanged tree must not push or replace the cloud copy again.
    await delay(7000);
    assert.equal((await host.fetchApi("/projects/rehearsal")).body.sync.appliedAt, pushed.body.sync.appliedAt);

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
