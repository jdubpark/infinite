import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn as ptySpawn } from "node-pty";
import { claimControl, startHost, waitFor } from "./helpers.js";
import { terminalConnection } from "../packages/host/src/client-transport.js";

const exec = promisify(execFile);
const RETRIES = 3;

async function rig(withCli = true) {
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
  const pty = withCli ? ptySpawn(process.execPath, [...cli, "resume", sid], { cols: 110, rows: 30, cwd: scratch, env: { ...process.env } }) : undefined;
  let output = "";
  pty?.onData(text => { output += text; });
  const size = async () => (await host.fetchApi(`/sessions/${sid}`)).body.terminalSize as { cols: number; rows: number } | undefined;
  if (withCli) {
    await waitFor(() => Promise.resolve(output), text => text.includes("Live session connected") || text.includes("Interactive"), 30000);
    await waitFor(size, value => value?.cols === 110 && value.rows === 30, 30000);
  }
  return {
    host, sid, pty: pty!, size, gate, drains: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
    stop: async () => { try { pty?.kill(); } catch {} await host.stop(); rmSync(scratch, { recursive: true, force: true }); },
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

test("a refused resize arrives as a resizeRefusal frame on an open duplex stream and as a 503 over HTTP", { timeout: 60_000 }, async () => {
  const r = await rig(false);
  const abort = new AbortController();
  try {
    const connection = terminalConnection(r.host.origin, r.host.tokens.owner, r.sid, 0, abort.signal, { control: true });
    const frames: Record<string, unknown>[] = [];
    const reading = (async () => { try { for await (const page of connection.pages()) frames.push(page as Record<string, unknown>); } catch {} })();
    await waitFor(async () => frames.length, count => count > 0, 20_000);
    await connection.control("claim", true);
    writeFileSync(r.gate, "");
    connection.resize(90, 25);
    const refused = await waitFor(async () => frames.find(frame => frame.resizeRefusal), Boolean, 20_000) as { resizeRefusal: { code: string; error: string } };
    assert.equal(refused.resizeRefusal.code, "resize-refused");
    assert.match(refused.resizeRefusal.error, /Terminal renderer is busy|Snapshot output queue is full/);
    assert.equal(frames.some(frame => frame.refusal), false, "a refused resize is not a control refusal");
    await connection.raw("still-open");
    const http = await claimControl(r.host, r.sid, "owner", { takeover: true });
    const response = await r.host.fetchApi(`/sessions/${r.sid}/resize`, "owner", { cols: 91, rows: 26 }, http.headers);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "resize-refused");
    abort.abort(); await reading;
  } finally { abort.abort(); await r.stop(); }
});

test("a newer resize cancels the pending retry of a refused one and restarts the bounded retries", { timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    writeFileSync(r.gate, "");
    r.pty.resize(90, 25);
    while (r.drains() < 3) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 1500));
    r.pty.resize(100, 28);
    await waitFor(async () => r.drains(), count => count >= 7, 60_000);
    await new Promise(resolve => setTimeout(resolve, 6000));
    assert.equal(r.drains(), 7, "three drains before the newer resize, the newer send, then three retries: the stale retry did not fire");
    assert.deepEqual(await r.size(), { cols: 110, rows: 30 });
  } finally { await r.stop(); }
});
