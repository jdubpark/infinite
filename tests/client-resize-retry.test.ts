import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn as ptySpawn } from "node-pty";
import { startHost, waitFor } from "./helpers.js";

const exec = promisify(execFile);
const RETRIES = 3;

async function rig() {
  const scratch = join(process.env.TMPDIR ?? "/tmp", `inf-resize-${randomUUID()}`);
  mkdirSync(scratch);
  const gate = join(scratch, "gate"), log = join(scratch, "drains.log");
  const host = await startHost({
    env: {
      NODE_OPTIONS: `--import=${pathToFileURL(resolve("tests/fixtures/terminal-drain.mjs")).href}`,
      INFINITE_TEST_TERMINAL_DRAIN_DELAY_MS: "1500",
      INFINITE_TEST_TERMINAL_DRAIN_GATE: gate,
      INFINITE_TEST_TERMINAL_DRAIN_LOG: log,
    },
  });
  const tokenFile = join(scratch, "owner.key"), clientFile = join(scratch, "client.json");
  writeFileSync(tokenFile, host.tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  await exec(process.execPath, [...cli, "pair", host.origin, "--token-file", tokenFile]);
  const id = randomUUID();
  const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Resize retry", prompt: "hello" });
  assert.equal(created.status, 201);
  const sid = created.body.id as string;
  const pty = ptySpawn(process.execPath, [...cli, "resume", sid], { cols: 110, rows: 30, cwd: scratch, env: { ...process.env } });
  let output = "";
  pty.onData(text => { output += text; });
  const size = async () => (await host.fetchApi(`/sessions/${sid}`)).body.terminalSize as { cols: number; rows: number } | undefined;
  await waitFor(() => Promise.resolve(output), text => text.includes("Live session connected") || text.includes("Interactive"), 30000);
  await waitFor(size, value => value?.cols === 110 && value.rows === 30, 30000);
  return {
    pty, size, gate, drains: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
    stop: async () => { try { pty.kill(); } catch {} await host.stop(); rmSync(scratch, { recursive: true, force: true }); },
  };
}

test("after a refused resize the CLI reaches the session's size again without another window resize", { timeout: 90_000 }, async () => {
  const r = await rig();
  try {
    writeFileSync(r.gate, "");
    r.pty.resize(90, 25);
    await waitFor(async () => r.drains(), count => count >= 1, 20_000);
    assert.deepEqual(await r.size(), { cols: 110, rows: 30 }, "the refused resize left the session at the old size");
    rmSync(r.gate);
    await waitFor(r.size, value => value?.cols === 90 && value.rows === 25, 20_000);
    assert.ok(r.drains() >= 1);
  } finally { await r.stop(); }
});

test("a persistently refused resize is retried a bounded number of times and a newer resize supersedes the pending retry", { timeout: 90_000 }, async () => {
  const r = await rig();
  try {
    writeFileSync(r.gate, "");
    r.pty.resize(90, 25);
    await waitFor(async () => r.drains(), count => count >= 1 + RETRIES, 40_000);
    await new Promise(resolve => setTimeout(resolve, 5000));
    assert.equal(r.drains(), 1 + RETRIES, "one send and three retries, then no more");
    assert.deepEqual(await r.size(), { cols: 110, rows: 30 });
    const before = r.drains();
    r.pty.resize(100, 28);
    await waitFor(async () => r.drains(), count => count > before, 20_000);
    rmSync(r.gate);
    await waitFor(r.size, value => value?.cols === 100 && value.rows === 28, 20_000);
  } finally { await r.stop(); }
});
