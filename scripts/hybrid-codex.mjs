#!/usr/bin/env node
// Opt-in prototype. Conversation and model authentication remain on Infinite;
// the selected laptop supplies tools only while this process is connected.
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { WebSocket } from "ws";

const { values } = parseArgs({ options: {
  session: { type: "string" }, ssh: { type: "string" }, "ssh-config": { type: "string" },
  cwd: { type: "string" }, prompt: { type: "string" }, "client-config": { type: "string" },
  "no-ui": { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log(`Hybrid Codex prototype — use a disposable Infinite conversation.

node scripts/hybrid-codex.mjs --session UUID --ssh USER@HOST --prompt "Task"
  --cwd DIRECTORY       Laptop workspace (default: current directory)
  --client-config FILE  Paired Infinite client configuration
  --ssh-config FILE     Optional private OpenSSH configuration
  --no-ui               Keep only the laptop executor connected; steer elsewhere

The SSH destination must be the Infinite execution host. Host keys are checked.
This changes the selected conversation's tool environment to this laptop.
No repository is bulk-uploaded. Read files and tool results can enter cloud context.
Closing this process disconnects local tools. There is no automatic cloud fallback.
Reconnect with the same session ID, same cwd, and a NEW explicit follow-up prompt.
Native resume alone does not reconnect the laptop executor.`);
  process.exit(0);
}
if (!/^[a-f0-9-]{36}$/.test(values.session ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(values.ssh ?? "") || !values.prompt?.trim()) {
  console.error("Provide --session UUID, --ssh USER@HOST, and --prompt. See --help."); process.exit(1);
}
const configFile = resolve(values["client-config"] ?? process.env.INFINITE_CLIENT_CONFIG ?? join(homedir(), ".config/infinite/client.json"));
if (statSync(configFile).mode & 0o077) throw new Error("The paired client configuration must have private file permissions");
const config = JSON.parse(readFileSync(configFile, "utf8")), origin = new URL(config.origin);
if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
    !/^[\x21-\x7e]{32,200}$/.test(config.token ?? "")) throw new Error("Invalid private Infinite pairing");
const cwd = realpathSync(values.cwd ?? process.cwd());
if (!statSync(cwd).isDirectory()) throw new Error("The laptop workspace must be a directory");
const clientId = randomUUID(), id = values.session;
const headers = { Authorization: `Bearer ${config.token}`, "X-Infinite-Client": clientId };
const api = async (path, body) => {
  if (interrupted && !closing) throw failure ?? new Error("Hybrid setup interrupted");
  const response = await fetch(origin + "api" + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Infinite refused the operation (HTTP ${response.status}); inspect the conversation before retrying`); }
  return response.json();
};
const children = [], pending = new Map();
let ws, control, renewal, closing = false, interrupted = false, failure;
let finish;
const stopped = new Promise(resolve => { finish = resolve; });
const stop = (error) => { interrupted = true; if (error && !failure) failure = error; finish(); };
const signal = () => stop();
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, signal);
function child(command, args, options, interactive = false) {
  if (interrupted) throw failure ?? new Error("Hybrid setup interrupted");
  // A pipe owned by this client fences the helper lifetime even after SIGKILL.
  // Codex's --exit-on-stdin-close only supports its hosted registration mode.
  const supervisor = `
    const {spawn}=require('node:child_process');
    const {createReadStream}=require('node:fs');
    const interactive=process.argv[1]==='tty';
    const child=spawn(process.argv[2],process.argv.slice(3),{stdio:interactive?'inherit':['ignore','pipe','pipe']});
    if(!interactive){child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr)}
    let ending=false;
    const stop=()=>{if(ending)return;ending=true;child.kill('SIGTERM');setTimeout(()=>{child.kill('SIGKILL');process.exit(1)},3000).unref()};
    const guard=createReadStream(null,{fd:3});guard.resume();guard.on('end',stop);guard.on('error',stop);
    process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('SIGHUP',stop);
    child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));
  `;
  const process = spawn(globalThis.process.execPath, ["-e", supervisor, interactive ? "tty" : "pipe", command, ...args], {
    ...options, stdio: [interactive ? "inherit" : "ignore", interactive ? "inherit" : "pipe", interactive ? "inherit" : "pipe", "pipe"],
  }); children.push(process);
  process.on("error", () => stop(new Error(`Could not start ${command}`)));
  process.on("exit", code => {
    if (closing) return;
    if (interactive) { globalThis.process.exitCode = code ?? 1; stop(); }
    else stop(new Error(`${command} exited; local execution is disconnected`));
  });
  return process;
}
async function ready(process, pattern, label) {
  return new Promise((resolve, reject) => {
    let output = "", finished = false;
    const timer = setTimeout(() => done(new Error(`${label} did not become ready`)), 20000);
    const done = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); process.stderr.off("data", read); process.stdout?.off("data", read); error ? reject(error) : resolve(value); };
    const read = data => { output = (output + data.toString()).slice(-16384); const match = output.match(pattern); if (match) done(undefined, match[1]); };
    process.stderr.on("data", read); process.stdout?.on("data", read);
    void stopped.then(() => done(failure ?? new Error("Hybrid setup interrupted")));
  });
}
const call = (method, params) => new Promise((resolve, reject) => {
  if (interrupted) { reject(failure ?? new Error("Hybrid setup interrupted")); return; }
  const requestId = randomUUID();
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out; it was not retried`)); }, 30000);
  pending.set(requestId, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: requestId, method, params }), error => {
    if (error) { clearTimeout(timer); pending.delete(requestId); reject(new Error(`${method} delivery is uncertain; it was not retried`)); }
  });
});
try {
  const me = await api("/me");
  if (me.role !== "owner" || !me.nativeUi?.includes("codex")) throw new Error("An owner pairing and native Codex host are required");
  if (me.security?.tenancy !== "single-tenant") throw new Error("This prototype requires a trusted single-tenant host");
  const state = await api(`/sessions/${id}`), native = await api(`/sessions/${id}/native`);
  if (state.provider !== "codex" || state.status !== "running" || state.runtime?.nativeUi !== "codex" || !native.sessionId) throw new Error("Select a running native Codex conversation");
  if (state.attention?.source !== "protocol" || !["idle", "turn-finished"].includes(state.attention.state)) throw new Error("Wait for a provider-confirmed finished turn before changing execution environments");
  const { stdout, stderr } = await promisify(execFile)("codex", ["exec-server", "--help"], { timeout: 10000, maxBuffer: 65536 });
  if (!(stdout + stderr).includes("--ws-token-sha256")) throw new Error("The installed Codex lacks authenticated exec-server support");
  console.error("[Infinite prototype] Conversation: cloud. Tools: this laptop. Offline cloud handoff: unavailable.");
  console.error(`[Infinite prototype] Laptop workspace: ${cwd.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`);
  const token = randomBytes(32).toString("hex");
  const executor = child("codex", ["exec-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token",
    "--ws-token-sha256", createHash("sha256").update(token).digest("hex")], { cwd, env: process.env });
  const executorUrl = await ready(executor, /(ws:\/\/127\.0\.0\.1:\d+)/, "Laptop executor");
  executor.stdout.resume(); executor.stderr.resume();
  const ssh = child("ssh", [...(values["ssh-config"] ? ["-F", resolve(values["ssh-config"])] : []), "-N", "-T",
    "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
    "-R", `127.0.0.1:0:127.0.0.1:${new URL(executorUrl).port}`, values.ssh], { env: process.env });
  const remotePort = await ready(ssh, /Allocated port (\d+) for remote forward/, "Private executor tunnel");
  ssh.stderr.resume();
  ({ control } = await api(`/sessions/${id}/control`, { action: "claim" }));
  renewal = setInterval(() => {
    const leaseId = control?.id;
    if (!leaseId) return;
    void api(`/sessions/${id}/control`, { action: "renew", leaseId }).catch(() => {
      if (!closing && control?.id === leaseId) stop(new Error("Control was lost during hybrid setup"));
    });
  }, 10000);
  const url = new URL(`/api/sessions/${id}/native`, origin); url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client", clientId); url.searchParams.set("lease", control.id);
  ws = new WebSocket(url, { headers, maxPayload: 32 * 1024 * 1024, handshakeTimeout: 20000 });
  ws.on("message", data => {
    try {
      const message = JSON.parse(data.toString()), request = pending.get(message.id);
      if (request && !message.method) {
        pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(`Codex refused the ${message.error.code ?? "native"} request`)) : request.resolve(message.result);
      }
      // Provider approval requests remain unanswered here. The native UI and
      // phone terminal show them and require an explicit user decision.
    } catch { stop(new Error("Invalid native response")); }
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.on("error", () => { if (control) stop(new Error("Native setup connection failed")); });
  ws.on("close", () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Native response was lost; no request was retried")); } pending.clear(); });
  await call("initialize", { clientInfo: { name: "infinite_hybrid_prototype", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: "initialized" }));
  // Loaded Codex threads cache executor connections by environment ID. Give
  // each connection a new generation; only the conversation identity persists.
  const environmentId = "infinite-laptop-" + randomUUID();
  await call("environment/add", { environmentId, execServerUrl: `ws://127.0.0.1:${remotePort}`, authBearerToken: token, connectTimeoutMs: 10000 });
  const info = await call("environment/info", { environmentId });
  if (!info.cwd || decodeURIComponent(new URL(info.cwd).pathname) !== cwd) throw new Error("The executor reported a different workspace");
  await call("thread/resume", { threadId: native.sessionId, excludeTurns: true });
  // The native TUI also reads the legacy cwd when it rejoins. Keep that root
  // aligned with the selected environment so its next turn does not reset it.
  await call("turn/start", { threadId: native.sessionId, cwd, input: [{ type: "text", text: values.prompt, text_elements: [] }],
    environments: [{ environmentId, cwd, runtimeWorkspaceRoots: [cwd] }] });
  console.error("[Infinite prototype] Follow-up accepted in the same conversation. Files remain on this laptop; selected tool results enter cloud context.");
  clearInterval(renewal);
  await api(`/sessions/${id}/control`, { action: "release", leaseId: control.id }); control = undefined;
  ws.close();
  if (!values["no-ui"]) {
    child("infinite", ["--client-config", configFile, "resume", id], { env: process.env }, true);
  } else console.error("[Infinite prototype] Laptop executor connected. Monitor or steer this session from another device. Ctrl+C disconnects local tools.");
  await stopped;
  if (failure) throw failure;
} catch (error) {
  console.error(`[Infinite prototype] ${error instanceof Error ? error.message : "Hybrid operation failed"}`); process.exitCode = 1;
} finally {
  closing = true; clearInterval(renewal);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, signal);
  ws?.terminate();
  for (const request of pending.values()) clearTimeout(request.timer);
  if (control) await api(`/sessions/${id}/control`, { action: "release", leaseId: control.id }).catch(() => {});
  for (const process of children) { process.stdio[3]?.destroy(); process.kill("SIGTERM"); }
  await Promise.all(children.map(process => process.exitCode !== null || process.signalCode ? undefined : new Promise(resolve => {
    const timer = setTimeout(() => { process.kill("SIGKILL"); resolve(); }, 4000); process.once("exit", () => { clearTimeout(timer); resolve(); });
  })));
  console.error("[Infinite prototype] Laptop tools disconnected. The cloud conversation remains; inspect interrupted work before continuing. No cloud executor was substituted.");
}
