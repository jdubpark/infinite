import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHost, waitFor } from "./helpers.js";
import { readSyncState, stopSyncService } from "../packages/host/src/sync-service.js";

const exec = promisify(execFile);

test("infinite sync, projects, and pull round-trip a checkout through the host", { timeout: 120000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-synccli-"));
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key");
  writeFileSync(tokenFile, host.tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const stateFile = join(root, "sync", "rehearsal.json");
  try {
    await exec(process.execPath, [...cli, "pair", host.origin, "--token-file", tokenFile]);
    writeFileSync(join(checkout, "file.txt"), "from laptop\n");
    await exec(process.execPath, [...cli, "sync", "--project", "rehearsal"], { cwd: checkout });
    const state = readSyncState(stateFile);
    assert.ok(state);
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 30000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "file.txt"), "utf8"), "from laptop\n");
    const listed = await exec(process.execPath, [...cli, "projects"]);
    assert.match(listed.stdout, /rehearsal\s+Rehearsal\s+· synced \d+s ago/);
    const running = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.match(running.stdout, new RegExp(`^rehearsal  service pid ${state.pid} · ${checkout} · synced \\d+s ago`));

    writeFileSync(join(host.config.projects[0].path, "cloud.txt"), "from cloud\n");
    const output = join(root, "pulled");
    const pulled = await exec(process.execPath, [...cli, "pull", "rehearsal", "--output", output]);
    const cwd = pulled.stdout.trim();
    assert.equal(readFileSync(join(cwd, "cloud.txt"), "utf8"), "from cloud\n");
    assert.equal(existsSync(join(checkout, "cloud.txt")), false, "pull never writes into the checkout");

    writeFileSync(join(checkout, "file.txt"), "second\n");
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "cloud-changed", 30000);
    await assert.rejects(exec(process.execPath, [...cli, "sync", "--apply", "--project", "rehearsal"]),
      (error: { stderr: string }) => /Not applied\. synced \d+s ago · applied \d+s ago · pending \(cloud changed; use infinite sync --apply --force/.test(error.stderr));
    const forced = await exec(process.execPath, [...cli, "sync", "--apply", "--force", "--project", "rehearsal"]);
    assert.match(forced.stdout, /^synced \d+s ago · applied \d+s ago\n$/);
    assert.equal(readFileSync(join(host.config.projects[0].path, "file.txt"), "utf8"), "second\n");
    assert.equal(existsSync(join(host.config.projects[0].path, "cloud.txt")), false, "a forced apply replaces cloud edits");

    // A failed apply shows its category and the retry command; the host cannot stage beside the project directory.
    chmodSync(host.root, 0o500);
    try {
      writeFileSync(join(checkout, "file.txt"), "third\n");
      await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "apply-failed", 30000);
      const failure = /· pending \(apply failed: permission\. The host account cannot read, write, or remove part of the cloud project\.[^)]* Retry with infinite sync --apply\)/;
      assert.match((await exec(process.execPath, [...cli, "projects"])).stdout, failure);
      assert.match((await exec(process.execPath, [...cli, "sync", "--status"])).stdout, failure);
    } finally { chmodSync(host.root, 0o700); }

    // Stopping and inspecting the local service work while the host is down.
    await host.stopApi();
    const stopped = await exec(process.execPath, [...cli, "sync", "--stop"]);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(existsSync(stateFile), false);
    await waitFor(async () => { try { process.kill(state.pid, 0); return true; } catch { return false; } }, alive => !alive, 10000);
    const offline = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.equal(offline.stdout, "rehearsal  no local service · host unreachable\n");
    // Without the host to vouch for the ID, a path-like project must not name the client configuration.
    await assert.rejects(exec(process.execPath, [...cli, "sync", "--stop", "--project", "../client"]), (error: { stderr: string }) => /Choose a project with --project ID/.test(error.stderr));
    assert.ok(existsSync(clientFile), "the device credentials stay in place");

    // A record left behind by a killed service names a pid that no longer runs it.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(stateFile, JSON.stringify({ ...state, pid: dead }), { mode: 0o600 });
    await host.start();
    const stale = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.match(stale.stdout, new RegExp(`^rehearsal  stale service record \\(pid ${dead} not running\\) · synced \\d+s ago`));
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
