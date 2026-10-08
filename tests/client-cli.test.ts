import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { createApp } from "../packages/host/src/server.js";
import { hashToken } from "../packages/host/src/config.js";
import { workerCall } from "../packages/host/src/ipc.js";
import type { Config } from "../packages/host/src/types.js";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const wait = async (predicate: () => boolean | Promise<boolean>, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 80)); }
  throw new Error("Timed out waiting for CLI behavior");
};

test("local draft recovery isolates pairings and runtimes, preserves concurrent drafts, and refuses tampered ciphertext", async () => {
  const { localDraftStore } = await import("../packages/host/src/client-draft-store.js");
  const root = mkdtempSync(join(tmpdir(), "infinite-drafts-")), path = join(root, "client.json");
  const identity = { origin: "https://host.example", token: randomBytes(32).toString("hex"), sessionId: randomUUID(), projectId: "project", runtimeId: randomUUID() };
  const notices: string[] = [], report = (s: string) => notices.push(s);
  try {
    const first = localDraftStore(path, identity, report), second = localDraftStore(path, identity, report);
    assert.ok(first.save({ text: "first private draft", state: "draft" }, true));
    assert.equal(second.restore(), undefined, "another live editor's file is not taken over");
    assert.ok(second.save({ text: "second private draft", state: "draft" }, true));
    first.close(); second.close();
    for (const variant of [{ token: randomBytes(32).toString("hex") }, { origin: "https://other.example" }, { runtimeId: randomUUID() }, { sessionId: randomUUID() }]) {
      assert.equal(localDraftStore(path, { ...identity, ...variant }, report).restore(), undefined);
    }
    const restored = localDraftStore(path, identity, report), remaining = new Set(["first private draft", "second private draft"]);
    const draft = restored.restore()!; assert.ok(remaining.delete(draft.text));
    restored.clear();
    assert.ok(remaining.has(restored.restore()!.text), "discarding one recovered draft preserves the other client's work");
    const files = readdirSync(join(root, "drafts"), { recursive: true }).map(String).filter(p => p.endsWith(".sealed"));
    const file = join(root, "drafts", files[0]);
    const envelope = JSON.parse(readFileSync(file, "utf8")); envelope.t = Buffer.alloc(16).toString("base64");
    writeFileSync(file, JSON.stringify(envelope));
    const damaged = localDraftStore(path, identity, report);
    assert.equal(damaged.restore(), undefined); damaged.close();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).t, envelope.t, "an unreadable recovery is retained rather than overwritten");
    assert.match(notices.at(-1)!, /recovery is unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI reports each startup wait before the host responds and leaves native output clean", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/inf-start-");
  const config = join(root, "client.json"), sessionId = randomUUID();
  const requests = new Map<string, import("node:http").ServerResponse>();
  const server = createServer((req, res) => { req.resume(); requests.set(req.url!, res); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  writeFileSync(config, JSON.stringify({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: randomBytes(32).toString("base64url"), projectId: "project" }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", config, "grok"], { stdio: "pipe" });
  let stdout = "", stderr = "", exited = false;
  child.stdout.on("data", s => stdout += s); child.stderr.on("data", s => stderr += s); child.on("exit", () => exited = true);
  const reply = (path: string, body: unknown) => requests.get(path)!.end(JSON.stringify(body));
  try {
    await wait(() => requests.has("/api/me"));
    assert.match(stderr, /Connecting to 127\.0\.0\.1/, "connecting is visible before authentication completes");
    reply("/api/me", { role: "owner", terminal: { stream: true, raw: true }, projects: [{ id: "project", name: "Project" }] });
    await wait(() => requests.has("/api/sessions"));
    assert.match(stderr, /Starting Grok/, "launch progress precedes session creation");
    reply("/api/sessions", { id: sessionId, provider: "grok", status: "running", title: "Grok", projectId: "project" });
    const path = `/api/sessions/${sessionId}/stream?after=0`;
    await wait(() => requests.has(path));
    assert.match(stderr, /Connecting to .*terminal/);
    await wait(() => /\d+s/.test(stderr), 4000);
    const response = requests.get(path)!;
    response.write(JSON.stringify({ events: [{ type: "output", data: { text: "NATIVE READY\n" } }], state: { status: "running" } }) + "\n");
    await wait(() => stdout.includes("NATIVE READY"));
    const afterHandoff = stderr.length;
    await new Promise(r => setTimeout(r, 2200));
    assert.equal(stderr.slice(afterHandoff), "", "startup status stops when the native terminal takes over");
    response.end(JSON.stringify({ state: { status: "exited", exitCode: 0 } }) + "\n");
    await wait(() => exited);
    assert.equal(stdout, "NATIVE READY\n");
  } finally { child.kill(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});

test("native cloud CLI preserves argv, enforces monitor mode, and reconnects without duplicating a process or input", { timeout: 45000 }, async () => {
  const root = mkdtempSync("/tmp/inf-cli-");
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const key = randomBytes(32), keyFile = join(root, "vault.key"); writeFileSync(keyFile, key);
  const tokens = { owner: randomBytes(32).toString("base64url"), controller: randomBytes(32).toString("base64url"), viewer: randomBytes(32).toString("base64url") };
  const fixture = join(root, "native.cjs");
  writeFileSync(fixture, `const fs = require('node:fs');
    fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
    if (process.argv.includes('--version')) { console.log('native-version-1'); process.exit(0); }
    fs.writeFileSync('input.txt', ''); process.stdin.setRawMode(true);
    process.stdout.write('\\x1b[?2004h\\x1b[32mNATIVE READY\\x1b[0m\\r\\n');
    process.stdin.on('data', text => { fs.appendFileSync('input.txt', text); process.stdout.write('RECEIVED:' + JSON.stringify(text.toString()) + '\\r\\n'); });`);
  const config: Config = { port: 0, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
    environment: "local", enableDemo: false, maxSessions: 10,
    tokens: Object.entries(tokens).map(([role, token]) => ({ id: role, label: role, role: role as keyof typeof tokens, hash: hashToken(token) })),
    projects: [{ id: "project", name: "Project", path: workspace }], agents: { codex: { command: process.execPath, args: [fixture] } } };
  let app = createApp(config, key);
  let server = app.server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  config.port = (server.address() as { port: number }).port; config.origin = `http://127.0.0.1:${config.port}`;
  // Recreate after selecting a port so the Host/Origin policy uses the real origin.
  await new Promise<void>(r => server.close(() => r()));
  app = createApp(config, key); server = app.server.listen(config.port, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  // A real transport proxy delays only acknowledgments. Provider input and
  // output remain live, exposing accidental per-key round-trip serialization.
  let holdReceipts = false;
  const held: (() => void)[] = [];
  const relaySockets = new Set<WebSocket>();
  const proxy = createServer((req, res) => {
    const upstream = httpRequest(config.origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(config.origin).host } }, response => {
      response.on("error", () => res.destroy());
      res.writeHead(response.statusCode!, response.headers);
      if (holdReceipts && req.url?.endsWith("/raw")) {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => held.push(() => res.end(Buffer.concat(chunks))));
      } else response.pipe(res);
    });
    upstream.on("error", () => res.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  const relay = new WebSocketServer({ noServer: true });
  proxy.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, client => {
    const upstream = new WebSocket(config.origin.replace("http:", "ws:") + req.url);
    relaySockets.add(client); relaySockets.add(upstream);
    const beforeOpen: Buffer[] = [];
    client.on("message", data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false }); else beforeOpen.push(Buffer.from(data as Buffer)); });
    upstream.on("open", () => { for (const data of beforeOpen) upstream.send(data, { binary: false }); });
    upstream.on("message", data => {
      const deliver = () => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false }); };
      if (holdReceipts && JSON.parse(data.toString()).receipt) held.push(deliver); else deliver();
    });
    upstream.on("close", code => { relaySockets.delete(upstream); client.close(code === 1000 ? 1000 : 1011); });
    client.on("close", () => { relaySockets.delete(client); upstream.close(); });
    upstream.on("error", () => client.close()); client.on("error", () => upstream.close());
  }));
  await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
  const clientOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key"); writeFileSync(tokenFile, tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const clients: IPty[] = [];
  const start = (args: string[]) => { const process = ptySpawn(globalThis.process.execPath, [...cli, ...args], { cols: 110, rows: 30, cwd: root, env: { ...globalThis.process.env } }); clients.push(process); let output = ""; let exited = false; process.onData(s => output += s); process.onExit(() => exited = true); return { process, output: () => output, exited: () => exited }; };
  const call = async (path: string, role: keyof typeof tokens, body?: unknown, cookie?: string) => fetch(config.origin + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { Cookie: cookie, Origin: config.origin } : { Authorization: `Bearer ${tokens[role]}` }), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    await exec(process.execPath, [...cli, "pair", clientOrigin, "--token-file", tokenFile]);
    app.manager.setContext("project", "Do not append me to native argv", 0);
    const nativeArgs = ["--model", "example/model", "--config", "literal=value", "--", "spaces, $HOME and `printf literal`", "line\nbreak"];
    const launched = await exec(process.execPath, [...cli, "--detach", "codex", ...nativeArgs]);
    const sid = launched.stdout.trim(); assert.match(sid, /^[a-f0-9-]{36}$/);
    await wait(() => { try { return JSON.parse(readFileSync(join(workspace, "argv.json"), "utf8")).length === nativeArgs.length; } catch { return false; } });
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, "argv.json"), "utf8")), nativeArgs, "all provider args are exact, including --config and --");
    const before = await app.manager.state(sid);
    assert.equal((await call(`/sessions/${sid}/raw`, "viewer", { requestId: randomUUID(), text: "X" })).status, 403);
    assert.equal((await call(`/sessions/${sid}/raw`, "controller", { requestId: randomUUID(), text: "X" })).status, 403);
    const login = await fetch(config.origin + "/api/login", { method: "POST", headers: { Origin: config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: tokens.owner }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await call(`/sessions/${sid}/raw`, "owner", { requestId: randomUUID(), text: "X" }, cookie)).status, 403);
    const terminalUrl = config.origin.replace("http:", "ws:") + `/api/sessions/${sid}/terminal`;
    for (const role of ["viewer", "controller"] as const) {
      const socket = new WebSocket(terminalUrl);
      const closed = new Promise<number>(resolve => socket.once("close", resolve));
      let sawState = false;
      socket.on("open", () => socket.send(JSON.stringify({ token: tokens[role] })));
      socket.on("message", data => { if (!sawState && JSON.parse(data.toString()).state) { sawState = true; socket.send(JSON.stringify({ op: "raw", requestId: randomUUID(), text: "FORBIDDEN" })); } });
      assert.equal(await closed, 1008); assert.equal(sawState, true, "read-only roles can monitor but cannot send native keys");
    }
    const unauthenticated = new WebSocket(terminalUrl, { headers: { Cookie: cookie } });
    const unauthenticatedClosed = new Promise<number>(r => unauthenticated.once("close", r));
    let leakedOutput = false;
    unauthenticated.on("message", () => leakedOutput = true);
    unauthenticated.on("open", () => unauthenticated.send(JSON.stringify({ token: "x".repeat(40) })));
    assert.equal(await unauthenticatedClosed, 1008); assert.equal(leakedOutput, false, "cookies cannot authorize a native socket or reveal output");
    const crossOrigin = new WebSocket(terminalUrl, { origin: "https://untrusted.example" });
    crossOrigin.on("error", () => {});
    const rejected = new Promise<number>(resolve => crossOrigin.once("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); crossOrigin.terminate(); }));
    assert.equal(await rejected, 403);
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "");
    assert.equal((await call("/sessions", "owner", { requestId: randomUUID(), provider: "codex", projectId: "project", title: "invalid", nativeArgs: ["bad\0argument"] })).status, 400);
    const list = JSON.parse((await exec(process.execPath, [...cli, "list", "--json"])).stdout);
    assert.equal(list[0].id, sid); assert.equal(list[0].nativeArgs, undefined);
    const monitor = start(["monitor", sid.slice(0, 8)]);
    await wait(() => monitor.output().includes("NATIVE READY"));
    monitor.process.write("ignored"); await new Promise(r => setTimeout(r, 200));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "");
    monitor.process.write("\r"); await wait(() => monitor.output().includes("Interactive. Ctrl+G"));
    monitor.process.write("steer\x1b[A\r");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8") === "steer\x1b[A\r");
    monitor.process.write("\x07ignored again"); await wait(() => monitor.output().includes("Monitoring. Enter enables interaction;")); await new Promise(r => setTimeout(r, 200));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "steer\x1b[A\r");
    monitor.process.write("\r"); await new Promise(r => setTimeout(r, 100));
    monitor.process.write("\x05"); await wait(() => monitor.output().includes("Local draft"));
    monitor.process.write("preserve this unsent draft"); await wait(() => monitor.output().includes("preserve this unsent draft"));
    app.closeConnections(); await new Promise<void>(r => server.close(() => r()));
    await wait(() => monitor.output().includes("Connection lost")); monitor.process.write("offline-input");
    assert.match(monitor.output(), /Unsent draft kept locally/);
    app = createApp(config, key); server = app.server.listen(config.port, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    await wait(() => monitor.output().includes("Reconnected to the same session"));
    assert.equal((await app.manager.state(sid)).pid, before.pid);
    assert.equal((await app.manager.list()).length, 1);
    monitor.process.write("\r"); await new Promise(r => setTimeout(r, 120));
    const draftOffset = monitor.output().length;
    monitor.process.write("\x05"); await wait(() => monitor.output().slice(draftOffset).includes("preserve this unsent draft"));
    monitor.process.write("\x18"); await new Promise(r => setTimeout(r, 100)); monitor.process.write("after");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8").endsWith("after"));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "steer\x1b[A\rafter");
    monitor.process.write("\x1d"); await wait(monitor.exited);
    assert.equal((await app.manager.state(sid)).pid, before.pid);
    const resumed = start(["resume", sid]); await wait(() => resumed.output().includes("Live session connected"));
    holdReceipts = true;
    resumed.process.write("A");
    await wait(() => held.length > 0 && readFileSync(join(workspace, "input.txt"), "utf8").endsWith("A"));
    resumed.process.write("B");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8").endsWith("AB"), 1000);
    holdReceipts = false; held.splice(0).forEach(deliver => deliver());
    const inputBeforeDraft = readFileSync(join(workspace, "input.txt"), "utf8");
    resumed.process.write("\x05"); await wait(() => resumed.output().includes("Local draft"));
    resumed.process.write("instant local text"); await wait(() => resumed.output().includes("instant local text"), 500);
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), inputBeforeDraft, "editing stays entirely local");
    resumed.process.write("\x18"); await new Promise(r => setTimeout(r, 100));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), inputBeforeDraft, "cancelling never sends a draft");
    resumed.process.write("\x05"); await new Promise(r => setTimeout(r, 100));
    resumed.process.write("draft first\rdraft second"); await wait(() => resumed.output().includes("draft second"));
    resumed.process.write("\x13");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8") === inputBeforeDraft + "\x1b[200~draft first\ndraft second\x1b[201~");
    await new Promise(r => setTimeout(r, 100));
    resumed.process.write("\x05"); await new Promise(r => setTimeout(r, 100));
    resumed.process.write("survive a killed client"); await wait(() => resumed.output().includes("survive a killed client"));
    const saved = () => readdirSync(join(root, "drafts"), { recursive: true }).map(String).filter(p => p.endsWith(".sealed")).map(p => join(root, "drafts", p));
    await wait(() => { try { return saved().length === 1; } catch { return false; } });
    assert.equal(statSync(saved()[0]).mode & 0o777, 0o600);
    assert.ok(!readFileSync(saved()[0], "utf8").includes("survive a killed client"), "draft content is encrypted at rest");
    resumed.process.kill("SIGKILL"); await wait(resumed.exited);
    const recovered = start(["resume", sid]);
    await wait(() => recovered.output().includes("Live session connected"));
    assert.match(recovered.output(), /Recovered an unsent local draft/);
    recovered.process.write("\x05"); await wait(() => recovered.output().includes("survive a killed client"));
    holdReceipts = true;
    recovered.process.write("\x13");
    await wait(() => held.length > 0 && readFileSync(join(workspace, "input.txt"), "utf8").endsWith("survive a killed client\x1b[201~"));
    const uncertainInput = readFileSync(join(workspace, "input.txt"), "utf8");
    recovered.process.kill("SIGKILL"); await wait(recovered.exited);
    holdReceipts = false; held.splice(0).forEach(deliver => deliver());
    const uncertainDraft = start(["resume", sid]);
    await wait(() => uncertainDraft.output().includes("Live session connected"));
    assert.match(uncertainDraft.output(), /previous draft insertion is unconfirmed/);
    uncertainDraft.process.write("\x05"); await wait(() => uncertainDraft.output().includes("Previous insertion unconfirmed"));
    uncertainDraft.process.write("\x13"); await wait(() => uncertainDraft.output().includes("Insertion blocked"));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), uncertainInput, "an uncertain insertion is never automatically repeated, even after process death");
    uncertainDraft.process.write("\x18"); await wait(() => saved().length === 0);
    uncertainDraft.process.write("\x1d"); await wait(uncertainDraft.exited);
    assert.equal((await app.manager.list()).length, 1);
    const oneShot = await exec(process.execPath, [...cli, "codex", "--version"]);
    assert.match(oneShot.stdout, /native-version-1/);
    await workerCall(config.runDir, sid, { op: "stop", requestId: randomUUID() });
    await wait(async () => (await app.manager.state(sid)).status === "exited");
    const ended = start(["resume", sid]); await wait(ended.exited); assert.match(ended.output(), /no longer running/);
  } finally {
    holdReceipts = false; held.splice(0).forEach(deliver => deliver());
    for (const client of clients) { try { client.kill(); } catch {} }
    for (const socket of relaySockets) socket.terminate();
    proxy.closeAllConnections(); await new Promise<void>(r => proxy.close(() => r()));
    for (const s of await app.manager.list()) {
      try { await workerCall(config.runDir, s.id, { op: "stop", requestId: randomUUID() }); } catch {}
      await wait(async () => ["exited", "unavailable"].includes((await app.manager.state(s.id)).status));
    }
    app.closeConnections(); await new Promise<void>(r => server.close(() => r()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a new API lists and streams a pre-attention worker without replacing it", async () => {
  const { createServer } = await import("node:net");
  const { writeSealed, Journal } = await import("../packages/host/src/vault.js");
  const root = mkdtempSync("/tmp/inf-old-");
  const id = randomUUID(), key = randomBytes(32), token = randomBytes(32).toString("base64url");
  const config: Config = { port: 0, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"), environment: "local", enableDemo: false, maxSessions: 2, tokens: [{ id: "owner", label: "owner", role: "owner", hash: hashToken(token) }], projects: [], agents: {} };
  const dir = join(config.stateDir, "sessions", id); mkdirSync(dir, { recursive: true }); mkdirSync(config.runDir);
  writeSealed(join(dir, "meta.sealed"), key, `${id}:meta`, { session: { id, provider: "codex", title: "Older session", projectId: "old", createdAt: new Date().toISOString(), status: "running", context: "", contextVersion: 0, initialPrompt: "", cwd: root }, fingerprint: "old" });
  const journal = new Journal(join(dir, "events"), key, id); journal.append("output", { text: "older-worker-output" });
  // This is the actual pre-attention IPC response shape: the worker sends no attention block.
  // Pre-control workers fingerprint the complete IPC input shape. Seed a
  // delivered request from before upgrade, then retry it through the new API.
  const oldInput = { op: "input", requestId: randomUUID(), text: "before-upgrade", submit: true };
  const oldDigest = createHash("sha256").update(JSON.stringify(oldInput)).digest("hex");
  const oldReceipt = { requestId: oldInput.requestId, state: "delivered", seq: 3 };
  const legacy = createServer(socket => socket.once("data", data => {
    const request = JSON.parse(data.toString());
    const response = request.op === "state"
      ? { result: { status: "running", pid: 12345, seq: 3, screen: "older-worker-output" } }
      : request.op === "input" && createHash("sha256").update(JSON.stringify(request)).digest("hex") === oldDigest
        ? { result: oldReceipt } : { error: "Request ID already belongs to different input" };
    socket.end(JSON.stringify(response) + "\n");
  }));
  await new Promise<void>(r => legacy.listen(join(config.runDir, id + ".sock"), r));
  const app = createApp(config, key); const server = app.server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  config.port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(origin + "/api/sessions", { headers });
    assert.equal(response.status, 200);
    const list = (await response.json() as { sessions: { id: string; pid: number; status: string; attention?: { state: string; now: string } }[] }).sessions;
    assert.equal(list.length, 1); assert.equal(list[0].pid, 12345); assert.equal(list[0].status, "running");
    // The API fills the missing block so clients never break, but invents no idle or finished state.
    assert.equal(list[0].attention?.state, "unavailable"); assert.equal(list[0].attention?.now, "");
    const { op: _op, ...retry } = oldInput;
    const receipt = await fetch(origin + `/api/sessions/${id}/input`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(retry) });
    assert.equal(receipt.status, 200, "rolling upgrade must preserve the old worker's input digest");
    assert.deepEqual(await receipt.json(), oldReceipt);
    const stream = await fetch(origin + `/api/sessions/${id}/stream`, { headers });
    const reader = stream.body!.getReader();
    const chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /older-worker-output/); await reader.cancel();
  } finally { app.closeConnections(); await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => legacy.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});

test("snapshot attachments and fenced device takeover preserve one live process across API restart", { timeout: 35000 }, async () => {
  const { startHost, waitFor } = await import("./helpers.js");
  const { terminalConnection, TerminalControlError } = await import("../packages/host/src/client-transport.js");
  const host = await startHost({ agents: { demo: { command: process.execPath, args: ["-e", `
    process.stdin.setRawMode(true);
    for (let i = 0; i < 1500; i++) console.log('history-row-' + i);
    console.log('snapshot-ready');
    process.stdin.on('data', data => console.log('accepted:' + data.toString()));
  `] } } });
  const clients: ReturnType<typeof terminalConnection>[] = [], aborts: AbortController[] = [];
  const connect = (sid: string, role: "owner" | "viewer", clientId: string, cursor = 0) => {
    const abort = new AbortController(); aborts.push(abort);
    const client = terminalConnection(host.origin, host.tokens[role], sid, cursor, abort.signal, { snapshot: true, control: true, clientId }); clients.push(client);
    const pages: import("../packages/host/src/client-transport.js").TerminalPage[] = [];
    const finished = (async () => { try { for await (const page of client.pages()) pages.push(page); } catch {} })();
    return { client, pages, finished, abort };
  };
  try {
    const created = await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Device transfer" });
    assert.equal(created.status, 201);
    const sid = created.body.id, pid = created.body.pid, runtimeId = created.body.runtime.id;
    const path = `/sessions/${sid}`;
    await waitFor(() => host.fetchApi(path), r => r.body.screen.includes("snapshot-ready"));
    const aId = randomUUID(), a = connect(sid, "owner", aId);
    await wait(() => a.pages.some(p => p.state?.status === "running"));
    const snapshot = a.pages.find(p => p.snapshot)?.snapshot;
    assert.ok(snapshot, "attachment restores a bounded snapshot instead of replaying 1,500 lines");
    assert.match(snapshot.ansi, /snapshot-ready/);
    assert.doesNotMatch(snapshot.ansi, /history-row-0\r?\n/);
    assert.equal(a.pages.flatMap(p => p.events ?? []).filter(e => e.type === "output" && e.seq <= snapshot.seq).length, 0, "no output prefix is replayed twice");
    const leaseA = await a.client.control("claim"); assert.ok(leaseA);
    await a.client.raw("first-owner");
    const bId = randomUUID(), b = connect(sid, "owner", bId);
    await wait(() => b.pages.some(p => p.state));
    await assert.rejects(b.client.control("claim"), error => error instanceof TerminalControlError && error.code === "control-busy");
    const viewer = await host.fetchApi(path + "/control", "viewer", { action: "claim", takeover: true });
    assert.equal(viewer.status, 403);
    const oldHttp = await host.fetchApi(path + "/key", "owner", { requestId: randomUUID(), key: "enter" });
    assert.equal(oldHttp.body.code, "control-busy", "old HTTP clients cannot bypass a new terminal's lease");
    const forged = await host.fetchApi(path + "/input", "owner", { requestId: randomUUID(), text: "forged", submit: false }, { "X-Infinite-Control": leaseA.id, "X-Infinite-Client": bId });
    assert.equal(forged.body.code, "control-lost", "knowing a lease id is insufficient on another authenticated client");
    const leaseB = await b.client.control("claim", true); assert.ok(leaseB); assert.notEqual(leaseB.id, leaseA.id);
    await assert.rejects(a.client.raw("stale-owner"), error => error instanceof TerminalControlError && error.code === "control-lost");
    const staleSize = await host.fetchApi(path + "/resize", "owner", { cols: 42, rows: 11 }, { "X-Infinite-Control": leaseA.id, "X-Infinite-Client": aId });
    assert.equal(staleSize.body.code, "control-lost");
    a.abort.abort(); await a.finished;
    await b.client.raw("second-owner");
    assert.equal((await host.fetchApi(path)).body.control.id, leaseB.id, "stale socket close cannot release a takeover");
    await host.stopApi();
    await b.finished;
    await host.start();
    const next = connect(sid, "owner", bId, snapshot.seq);
    await wait(() => next.pages.some(p => p.state));
    const resumedLease = await next.client.control("claim");
    assert.notEqual(resumedLease!.id, leaseB.id, "same client recovery fences its former connection");
    await next.client.raw("after-restart");
    const state = (await host.fetchApi(path)).body;
    assert.equal(state.pid, pid); assert.equal(state.runtime.id, runtimeId);
    await waitFor(() => host.fetchApi(path), r => r.body.screen.includes("after-restart"));
    const events = (await host.fetchApi(path + "/events?types=input-intent&limit=200")).body.events;
    assert.deepEqual(events.map((e: { data: { text: string } }) => e.data.text), ["first-owner", "second-owner", "after-restart"]);
    await next.client.control("release");
    const phoneHeaders = { "X-Infinite-Client": randomUUID() };
    const phoneLease = await host.fetchApi(path + "/control", "controller", { action: "claim" }, phoneHeaders);
    assert.equal(phoneLease.status, 200);
    const inputId = randomUUID();
    const phoneInput = { requestId: inputId, text: "mobile-steering", submit: false };
    const sendHeaders = { ...phoneHeaders, "X-Infinite-Control": phoneLease.body.control.id };
    const first = await host.fetchApi(path + "/input", "controller", phoneInput, sendHeaders);
    const retry = await host.fetchApi(path + "/input", "controller", phoneInput, sendHeaders);
    assert.equal(first.body.state, "delivered"); assert.deepEqual(first.body, retry.body);
    await host.fetchApi(path + "/control", "controller", { action: "release", leaseId: phoneLease.body.control.id }, phoneHeaders);
    // Device labels were always free-form configuration. Display sanitization
    // must not turn an accepted key into one that can no longer steer a worker.
    for (const label of ["", "long-label-".repeat(20)]) {
      host.config.tokens.find(t => t.role === "owner")!.label = label;
      await host.stopApi();
      writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config), { mode: 0o600 });
      await host.start();
      const headers = { "X-Infinite-Client": randomUUID() };
      const claim = await host.fetchApi(path + "/control", "owner", { action: "claim" }, headers);
      assert.equal(claim.status, 200, "accepted device labels cannot break session control");
      const sent = await host.fetchApi(path + "/input", "owner", { requestId: randomUUID(), text: "label-compatibility", submit: false }, { ...headers, "X-Infinite-Control": claim.body.control.id });
      assert.equal(sent.body.state, "delivered");
      await host.fetchApi(path + "/control", "owner", { action: "release", leaseId: claim.body.control.id }, headers);
    }
  } finally {
    for (const abort of aborts) abort.abort();
    for (const client of clients) client.close();
    await host.stop();
  }
});
