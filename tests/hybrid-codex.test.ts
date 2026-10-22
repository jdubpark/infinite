import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { waitFor } from "./helpers.js";
import { createHybridWorkspace } from "../packages/host/src/hybrid-workspace.js";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import type { ExecutionState } from "../packages/host/src/types.js";

test("hybrid wrapper leaves no executor, tunnel or native UI after abrupt client loss", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-hybrid-")));
  const bin = join(root, "bin"), workspace = join(root, "workspace"), pids = join(root, "helpers.jsonl");
  mkdirSync(bin); mkdirSync(workspace);
  const id = randomUUID(), threadId = randomUUID(), token = randomUUID(), leaseId = randomUUID();
  const calls: any[] = [], requests: string[] = [];
  // Only external executables are fixtures. The real wrapper supervises their
  // OS processes and owns the pipes whose closure must stop every helper.
  const executable = `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
const name=basename(process.argv[1]);
if(name==='codex' && process.argv.includes('--help')){console.log('--ws-token-sha256');process.exit(0)}
appendFileSync(process.env.HYBRID_FIXTURE_PIDS,JSON.stringify({pid:process.pid,name})+'\\n');
if(name==='codex')console.error('ws://127.0.0.1:43210');
if(name==='ssh')console.error('Allocated port 43211 for remote forward');
if(name==='infinite')console.log('Fixture native interface ready');
setInterval(()=>{},1000);
`;
  for (const name of ["codex", "ssh", "infinite"]) writeFileSync(join(bin, name), executable, { mode: 0o700 });
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let body = ""; for await (const data of req) body += data;
    requests.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/me") return void res.end(JSON.stringify({ role: "owner", nativeUi: ["codex"], security: { tenancy: "single-tenant" } }));
    if (req.url === `/api/sessions/${id}`) return void res.end(JSON.stringify({ provider: "codex", status: "running", runtime: { nativeUi: "codex" }, attention: { state: "turn-finished", source: "protocol" } }));
    if (req.url === `/api/sessions/${id}/native`) return void res.end(JSON.stringify({ sessionId: threadId }));
    if (req.url === `/api/sessions/${id}/control`) return void res.end(JSON.stringify({ control: { id: leaseId }, action: JSON.parse(body).action }));
    res.writeHead(404); res.end("{}");
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", ws => ws.on("message", data => {
    const request = JSON.parse(data.toString()); calls.push(request);
    if (!request.method || request.id === undefined) return;
    if (request.method === "environment/info") return void ws.send(JSON.stringify({ id: request.id, result: { cwd: pathToFileURL(workspace).href } }));
    if (request.method === "turn/start") {
      ws.send(JSON.stringify({ id: "fixture-approval", method: "item/commandExecution/requestApproval", params: { command: "fixture requires explicit approval" } }));
    }
    ws.send(JSON.stringify({ id: request.id, result: {} }));
  }));
  let child: ChildProcess | undefined;
  const helpers = (): { pid: number; name: string }[] => existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = join(root, "client.json"); writeFileSync(config, JSON.stringify({ origin, token }), { mode: 0o600 });
    child = spawn(process.execPath, [resolve("scripts/hybrid-codex.mjs"), "--session", id, "--ssh", "fixture-host", "--cwd", workspace, "--prompt", "Inspect the fixture", "--client-config", config], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH, HYBRID_FIXTURE_PIDS: pids }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", ended = false;
    child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; }); child.on("exit", () => { ended = true; });
    await waitFor(async () => output.includes("Fixture native interface ready") || ended, Boolean, 10000);
    assert.equal(ended, false, output);
    assert.deepEqual(helpers().map(helper => helper.name).sort(), ["codex", "infinite", "ssh"]);
    const turn = calls.find(request => request.method === "turn/start");
    assert.equal(turn.params.threadId, threadId);
    assert.equal(turn.params.cwd, workspace, "Native UI resumes must keep the laptop working directory");
    assert.equal(calls.some(request => request.id === "fixture-approval" && !request.method), false, "The prototype must not answer provider approvals");
    child.kill("SIGKILL");
    await waitFor(async () => helpers().filter(helper => alive(helper.pid)), running => running.length === 0, 6000);
    assert.equal(requests.some(path => path.endsWith("/stop")), false, "Losing the laptop must not stop the cloud conversation");
  } finally {
    child?.kill("SIGKILL"); for (const helper of helpers()) if (alive(helper.pid)) process.kill(helper.pid, "SIGKILL");
    for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});


test("duplicate laptop disconnects and an early grace callback hand off the verified checkpoint once", { timeout: 20000 }, async context => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-disconnect-")));
  const cwd = join(root, "laptop"), localStore = join(root, "local-blobs");
  mkdirSync(cwd); writeFileSync(join(cwd, "evidence.txt"), "preserved");
  let state: ExecutionState | undefined;
  const selected: string[] = [], records: Record<string, unknown>[] = [];
  const hybrid = await createHybridWorkspace({
    workspace: { cwd, roots: [cwd] }, directory: join(root, "host"),
    command: process.execPath, commandArgs: [resolve("tests/fixtures/native-codex.mjs")],
    record: value => records.push(value), publish: value => { state = value; },
    // Provider selection is a separate boundary; this coordinator must reach
    // it once with the materialized, verified tree after the grace period.
    select: async execution => { selected.push(execution.cwd); },
  });
  try {
    hybrid.connection(true); hybrid.providerReady(true);
    const boundary = await hybrid.control("sync/begin", {});
    const manifest = await captureWorkspace({ cwd, roots: [cwd], storeDir: localStore });
    for (const hash of new Set(manifest.entries.flatMap(entry => entry.chunks ?? [])))
      await hybrid.control("sync/blob", { hash, base64: await readWorkspaceBlob(localStore, hash) });
    await hybrid.control("sync/commit", { ...boundary, manifest });
    assert.equal(state?.cloudReady, true);
    let now = Date.now();
    const began = now;
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const clock = context.mock.method(Date, "now", () => now);
    hybrid.connection(false);
    hybrid.connection(false);
    // Timer and wall clocks need not agree exactly. Run the grace callback
    // just before its wall-clock deadline, then cross the deadline without
    // another connection or activity event to rescue a lost callback.
    now = began + 4999;
    context.mock.timers.tick(5000);
    await hybrid.control("sync/status", {});
    assert.equal(selected.length, 0, "The original grace deadline must still be respected");
    now = began + 5000;
    context.mock.timers.tick(1);
    await hybrid.control("sync/status", {});
    context.mock.timers.reset();
    clock.mock.restore();
    const handedOff = await waitFor(async () => state, value => value?.location === "cloud" && value.state === "online", 10000);
    assert.equal(handedOff?.checkpoint?.id, manifest.id);
    assert.equal(selected.length, 1);
    assert.equal(readFileSync(join(selected[0], "evidence.txt"), "utf8"), "preserved");
    assert.equal(records.filter(value => value.action === "cloud-handoff-intent").length, 1);
    assert.equal(records.filter(value => value.action === "cloud-handoff-selected").length, 1);
  } finally { hybrid.close(); rmSync(root, { recursive: true, force: true }); }
});
