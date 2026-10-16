import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
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
  try {
    writeFileSync(join(laptop, "app.ts"), "one\n");
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir });
    const state = readSyncState(stateFile)!;
    assert.ok(state.pid > 0);
    assert.equal(state.root, laptop);
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 20000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"), "one\n");

    writeFileSync(join(laptop, "app.ts"), "two\n");
    const pushed = await waitFor(() => host.fetchApi("/projects/rehearsal"), r => readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8") === "two\n" && !r.body.sync.pendingGeneration, 20000);
    // Two capture cycles over an unchanged tree must not push or replace the cloud copy again.
    await delay(7000);
    assert.equal((await host.fetchApi("/projects/rehearsal")).body.sync.appliedAt, pushed.body.sync.appliedAt);

    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    writeFileSync(join(laptop, "app.ts"), "three\n");
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "session-running", 20000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"), "two\n");

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
      /did not complete its first upload/);
    assert.equal(existsSync(stateFile), false);
    assert.equal((await host.fetchApi("/projects/rehearsal")).body.sync.lastSyncedAt, undefined);
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
