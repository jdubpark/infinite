import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
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

    const stopped = await exec(process.execPath, [...cli, "sync", "--stop", "--project", "rehearsal"]);
    assert.match(stopped.stdout, /stopped/);
    const idle = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.match(idle.stdout, /^rehearsal  no local service · synced \d+s ago/);
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
