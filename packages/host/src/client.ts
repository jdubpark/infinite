import { formatUsd } from "./usage.js";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlLease, Receipt, Session, Status, WorkerState } from "./types.js";
import { terminalConnection, TerminalAccessError, TerminalControlError, type TerminalPage } from "./client-transport.js";
import { draftTerminal } from "./client-draft.js";
import { localDraftStore } from "./client-draft-store.js";
import { attachNativeCodex, checkNativeCodex } from "./client-native.js";
import { attachNativeOpenCode, checkNativeOpenCode } from "./client-opencode.js";
import { validateNativeOpenCodeArgs } from "./native-opencode.js";
import { validateNativeCodexArgs } from "./native-codex.js";
import { checkLaptopExecutor, startLaptopService } from "./laptop-service.js";
import { hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, validateWorkspaceManifest } from "./workspace-checkpoint.js";
import { readSyncState, startSyncService, stopSyncService, syncServiceRunning } from "./sync-service.js";
import { localProjectPath } from "./mirrored-projects.js";
import { boundTeamProject, forgetBoundTeamProject, handleTeamClientCommand } from "./team-cli.js";
import { handleBoardClientCommand } from "./board-cli.js";
import type { ProjectGroupList } from "./project-group-types.js";

type ClientConfig = { origin: string; token: string; projectId?: string };
type Me = { role: string; capabilities?: { workspaceMirror?: number; mirrorForget?: number }; machine?: { label?: string }; nativeUi?: string[]; execution?: { laptop: boolean; cloudHandoff: boolean }; terminal?: { stream: boolean; raw: boolean; duplex?: boolean; snapshot?: boolean; control?: boolean }; projects: { id: string; name: string }[] };
const providers = new Set(["claude", "codex", "grok", "opencode"]);
const providerNames: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok", opencode: "OpenCode" };
/** Project IDs name local sync files, so an ID from the host or the command line is checked before it becomes a path. */
const PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function startupProgress() {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearInterval(timer); timer = undefined; };
  return {
    start(message: string) {
      stop();
      const started = Date.now();
      process.stderr.write(`[Infinite] ${message}…\n`);
      timer = setInterval(() => process.stderr.write(`[Infinite] ${message}… ${Math.floor((Date.now() - started) / 1000)}s\n`), 2000);
      timer.unref();
    },
    stop,
  };
}
class HttpError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }
function originOf(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the host origin without credentials, a path, or query parameters");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Remote pairing requires HTTPS");
  return url.origin;
}
function writeClientConfig(path: string, config: ClientConfig) {
  const temporary = path + "." + randomUUID();
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path); chmodSync(path, 0o600);
}
function loadConfig(path: string): ClientConfig {
  if (!existsSync(path)) throw new Error(`Pair this laptop first: infinite pair https://HOST --token-file FILE\nClient configuration: ${path}`);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077)) throw new Error(`Client credentials must be private: chmod 600 ${path}`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (typeof config.token !== "string" || !/^[\x21-\x7e]{32,200}$/.test(config.token)) throw new Error("Invalid device key in client configuration");
  return { ...config, origin: originOf(config.origin) };
}
function connection(config: ClientConfig, clientId = randomUUID()) {
  const request = async (path: string, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}, method?: string) => {
    const response = await fetch(config.origin + "/api" + path, {
      method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error",
      headers: { Authorization: `Bearer ${config.token}`, "X-Infinite-Client": clientId, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body as unknown as BodyInit : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // Server errors may contain request details; report only a bounded category.
      const detail = await response.json().catch(() => ({})) as { code?: unknown };
      const code = typeof detail.code === "string" && /^[a-z0-9-]{1,80}$/.test(detail.code) ? detail.code : undefined;
      const guidance = code === "stale-enrollment-revision" ? "The repository enrollment changed; refresh its status and submit a new request ID." :
        response.status === 401 ? "Pair a current device key." : response.status === 403 ? "This device is not permitted to perform that action." : "Inspect the current state before retrying a mutation.";
      throw new HttpError(response.status, `Host returned HTTP ${response.status}${code ? ` (${code})` : ""}. ${guidance}`, code);
    }
    return response;
  };
  return { request, json: async <T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> => (await request(path, body, signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : undefined, headers, method)).json() as Promise<T> };
}
function sessionCwd(session: Session & Partial<WorkerState>) {
  return (session.execution?.location ?? session.executionLocation) === "laptop" ? session.workspace?.cwd : session.cwd;
}
/** One line per session, with where its tools run: the live executor when the session reports one, else its recorded location. */
function printSessions(sessions: (Session & Partial<WorkerState>)[], machine: string) {
  for (const s of sessions) {
    const execution = s.execution;
    const where = (execution?.location ?? s.executionLocation) === "laptop" ? "laptop tools" : `tools on ${clean(machine)}`;
    const detail = execution ? ` · ${execution.state}${execution.checkpoint ? ` · checkpoint ${Math.max(0, Math.floor((Date.now() - Date.parse(execution.checkpoint.capturedAt)) / 1000))}s old` : ""}${execution.location === "laptop" ? execution.cloudReady ? " · cloud ready" : " · cloud preparing" : ""}` : "";
    console.log(`${s.id}  ${s.provider.padEnd(8)}  ${s.status.padEnd(15)}  ${clean(s.title)}  · project ${clean(s.projectId)} · cwd ${clean(sessionCwd(s) ?? "unavailable")} · ${where}${detail}`);
  }
}

type ResourceSnapshot = {
  capturedAt: string; sampleIntervalMs: number | null; uptimeSeconds: number;
  cpu: { logicalCount: number; usagePercent: number | null; loadAverage: number[] | null };
  memory: { totalBytes: number; availableBytes: number; availableKind: string };
  swap: { totalBytes: number | null; usedBytes: number | null };
  network: { receivedBytes: number | null; sentBytes: number | null; receiveBytesPerSecond: number | null; sendBytesPerSecond: number | null };
  disks: { projectId: string; totalBytes: number | null; availableBytes: number | null }[];
  sessions: { sessionId: string; pid: number | null; cpuPercent: number | null; rssBytes: number | null }[];
  unavailable: { field: string; reason: string }[];
};
function printResources(value: ResourceSnapshot) {
  const bytes = (n: number | null) => n === null ? "unavailable" : `${(n / 1048576).toFixed(1)} MiB`;
  const percent = (n: number | null) => n === null ? "unavailable" : `${n.toFixed(1)}%`;
  const rate = (n: number | null) => n === null ? "unavailable" : `${bytes(n)}/s`;
  console.log(`Captured ${clean(value.capturedAt)} · uptime ${(value.uptimeSeconds / 3600).toFixed(1)} h · interval ${value.sampleIntervalMs === null ? "first sample" : `${value.sampleIntervalMs} ms`}`);
  console.log(`CPU ${percent(value.cpu.usagePercent)} · ${value.cpu.logicalCount} logical CPUs · load ${value.cpu.loadAverage?.map(n => n.toFixed(2)).join(" / ") ?? "unavailable"}`);
  console.log(`Memory ${bytes(value.memory.availableBytes)} ${clean(value.memory.availableKind)} / ${bytes(value.memory.totalBytes)} total · swap ${bytes(value.swap.usedBytes)} used / ${bytes(value.swap.totalBytes)} total`);
  console.log(`Network received ${bytes(value.network.receivedBytes)} (${rate(value.network.receiveBytesPerSecond)}) · sent ${bytes(value.network.sentBytes)} (${rate(value.network.sendBytesPerSecond)})`);
  for (const disk of value.disks) console.log(`Disk ${clean(disk.projectId)} · ${bytes(disk.availableBytes)} available / ${bytes(disk.totalBytes)} total`);
  for (const session of value.sessions) console.log(`Session ${clean(session.sessionId)} · PID ${session.pid ?? "unavailable"} · CPU ${percent(session.cpuPercent)} · RSS ${bytes(session.rssBytes)} (provider process)`);
  for (const item of value.unavailable) console.log(`Unavailable ${clean(item.field)}: ${clean(item.reason)}`);
}
async function resources(api: ReturnType<typeof connection>, options: Record<string, string | boolean>) {
  const abort = new AbortController(), stop = () => abort.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    do {
      const value = await api.json<ResourceSnapshot>("/machine/resources", undefined, abort.signal);
      if (options["--json"]) console.log(JSON.stringify(value, null, options["--watch"] ? undefined : 2));
      else {
        if (options["--watch"] && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
        printResources(value);
      }
      if (!options["--watch"]) return;
      await delay(2000, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) { if (!abort.signal.aborted) throw error; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

async function closeSession(api: ReturnType<typeof connection>, me: Me, selected: Session, options: Record<string, string | boolean>) {
  if (me.role !== "owner") throw new Error("Closing a session requires an owner device key");
  const session = await api.json<Session & WorkerState>(`/sessions/${selected.id}`);
  if (session.status !== "running") throw new Error(`Session is ${clean(session.status)}. Inspect it with infinite monitor ${selected.id}; no close was sent.`);
  if (!options["--yes"]) {
    if (!process.stdin.isTTY) throw new Error("Closing a session ends its provider process. Use --yes with an explicit session ID for noninteractive use.");
    const input = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await input.question(`Close ${clean(session.provider)} ${JSON.stringify(clean(session.title))} (${session.id}) in project ${clean(session.projectId)}, cwd ${clean(sessionCwd(session) ?? "unavailable")}? [y/N] `);
      if (!/^(y|yes)$/i.test(answer.trim())) { console.error("[Infinite] Close cancelled. The session keeps running."); return; }
    } finally { input.close(); }
  }
  let lease: ControlLease | undefined;
  if (session.capabilities?.inputControl) {
    try { lease = (await api.json<{ control: ControlLease }>(`/sessions/${session.id}/control`, { action: "claim", ...(options["--takeover"] ? { takeover: true } : {}) })).control; }
    catch (error) {
      if (error instanceof HttpError && error.status === 409) throw new Error("Session control is held by another client or changed. Release it there, or use close --takeover to replace its control explicitly. No close was sent.");
      throw error;
    }
  }
  const headers = lease ? { "X-Infinite-Control": lease.id } : undefined;
  const requestId = randomUUID();
  console.error(`[Infinite] Close ${requestId} · session ${session.id}`);
  try {
    const receipt = await api.json<Receipt>(`/sessions/${session.id}/stop`, { requestId }, undefined, headers);
    if (receipt.requestId !== requestId || receipt.state !== "delivered") throw new Error("Unconfirmed close receipt");
    if (options["--json"]) console.log(JSON.stringify({ sessionId: session.id, ...receipt }, null, 2));
    else console.log(`Close delivered for ${session.id}. Use infinite list to check process status.`);
  } catch (error) {
    if (error instanceof HttpError && [401, 403, 409].includes(error.status)) throw error;
    throw new Error(`Close delivery is unconfirmed for ${session.id} (request ${requestId}). Nothing was retried. Inspect infinite list or monitor before taking further action.`);
  } finally {
    if (lease) await api.json(`/sessions/${session.id}/control`, { action: "release", leaseId: lease.id }).catch(() => {});
  }
}
async function selectSession(sessions: Session[], requested: string | undefined, monitor: boolean) {
  if (requested) {
    const matches = sessions.filter(s => s.id.startsWith(requested));
    if (matches.length !== 1) throw new Error(matches.length ? "Session prefix is ambiguous; use a longer ID" : "Session was not found");
    return matches[0];
  }
  const candidates = sessions.filter(s => monitor || s.status === "running" || s.status === "starting").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!candidates.length) throw new Error("No matching sessions. Launch one with infinite claude, codex, grok, or opencode");
  if (candidates.length === 1) return candidates[0];
  if (!process.stdin.isTTY) throw new Error("Provide a session ID. Use infinite list to see available sessions");
  candidates.forEach((s, i) => console.error(`${i + 1}. ${s.id.slice(0, 8)}  ${s.provider}  ${s.status}  ${clean(s.title)}`));
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await input.question("Session number: ")).trim();
    if (!/^\d+$/.test(answer) || !candidates[Number(answer) - 1]) throw new Error("Invalid session number");
    return candidates[Number(answer) - 1];
  } finally { input.close(); }
}
// The server's headless terminal already answers device queries. Replaying them
// on a second terminal would inject duplicate answers as if they were user input.
// Clipboard OSC sequences are also excluded from recording replay.
function terminalRenderer() {
  let pending = "";
  return (text: string) => {
    pending += text;
    let rendered = "";
    while (pending) {
      const escape = pending.indexOf("\x1b");
      if (escape < 0) { rendered += pending; pending = ""; break; }
      rendered += pending.slice(0, escape); pending = pending.slice(escape);
      if (pending.length < 2) break;
      if (pending[1] === "[") {
        const csi = pending.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
        if (!csi) { if (pending.length < 1024) break; pending = pending.slice(1); continue; }
        if (!/[cn]$/.test(csi) && csi !== "\x1b[?u" && !csi.endsWith("$p") && !/^\x1b\[(?:14|16|18|19|20|21)t$/.test(csi)) rendered += csi;
        pending = pending.slice(csi.length);
      } else if (pending[1] === "]") {
        const end = /\x07|\x1b\\/.exec(pending);
        if (!end) { if (pending.length < 65536) break; pending = ""; break; }
        const osc = pending.slice(0, end.index + end[0].length);
        if (!osc.startsWith("\x1b]52;") && !/^\x1b\](?:4|10|11|12);.*\?/.test(osc)) rendered += osc;
        pending = pending.slice(osc.length);
      } else { rendered += pending.slice(0, 2); pending = pending.slice(2); }
    }
    return rendered;
  };
}
async function attach(config: ClientConfig, configFile: string, me: Me, session: Session, watch: boolean, launched = false) {
  if (!me.terminal?.stream) throw new Error("Upgrade the host to a version with native CLI streaming support");
  if (!watch && !launched && !["running", "starting"].includes(session.status)) throw new Error("This process is no longer running. Use infinite monitor ID to replay its recording. A server reboot requires explicit provider-native recovery");
  const clientId = randomUUID(), api = connection(config, clientId), abort = new AbortController();
  let render = terminalRenderer();
  const progress = startupProgress();
  const notice = (message: string) => process.stderr.write(`\r\n[Infinite] ${message}\r\n`);
  const screen = draftTerminal(localDraftStore(configFile, { ...config, sessionId: session.id, projectId: session.projectId, runtimeId: session.runtime?.id }, notice));
  let insertingDraft = false;
  let inputDelivered = Promise.resolve();
  let duplex: ReturnType<typeof terminalConnection> | undefined;
  let interactive = !watch && me.role === "owner", online = false, cursor = 0, queued = "", sending = false, warned = false;
  let initialControl = interactive, leasesSupported = false, controlPending = false;
  let handoffTimer: ReturnType<typeof setInterval> | undefined, handoffBusy = false, handoffNotice = "";
  let renewal: ReturnType<typeof setInterval> | undefined;
  let lastStatus: Status = session.status;
  // A detached CLI has no background job to keep alive. Terminate this client
  // after restoring the TTY; an open proxy stream must not prevent detachment.
  const stop = () => { restoreTerminal(); process.exit(0); };
  const owner = me.role === "owner" && me.terminal.raw;
  const resize = () => {
    if (!interactive || !online || !process.stdout.isTTY) return;
    const cols = Math.max(20, Math.min(240, process.stdout.columns || 120)), rows = Math.max(5, Math.min(100, process.stdout.rows || 32));
    screen.resize(cols, rows);
    if (duplex) { try { duplex.resize(cols, rows); } catch {} }
    else void api.json(`/sessions/${session.id}/resize`, { cols, rows }).catch(() => {});
  };
  const loseControl = (message: string) => {
    clearInterval(renewal); renewal = undefined;
    queued = ""; interactive = false;
    if (screen.pause()) notice("Unsent draft kept locally. Take control, then Ctrl+E to restore it.");
    notice(message);
  };
  const acquire = async (takeover = false) => {
    if (controlPending) { notice("Waiting for control acknowledgement…"); return; }
    controlPending = true;
    try {
      if (leasesSupported) {
        interactive = false;
        notice(takeover ? "Taking control…" : "Requesting control…");
        await duplex!.control("claim", takeover);
        clearInterval(renewal);
        renewal = setInterval(() => {
          if (interactive && online && duplex) void duplex.control("renew").catch(error => {
            loseControl(error instanceof TerminalControlError ? error.message : "Control could not be renewed. Monitoring; press Enter to reconnect control.");
          });
        }, 10000);
        renewal.unref();
      }
      if (!online || abort.signal.aborted) return;
      interactive = true;
      notice("Interactive. Ctrl+G returns to monitoring; Ctrl+] detaches. Ctrl+E drafts locally."); resize();
    } catch (error) {
      loseControl(error instanceof TerminalControlError ? error.message : "Control was not confirmed. Monitoring; press Enter to try again.");
    } finally { controlPending = false; }
  };
  const monitor = () => {
    clearInterval(renewal); renewal = undefined;
    interactive = false; queued = "";
    if (screen.active) screen.pause();
    if (leasesSupported && duplex?.lease && !controlPending) {
      controlPending = true;
      void duplex.control("release").catch(() => {}).finally(() => { controlPending = false; });
    }
    notice("Monitoring. Enter enables interaction; Ctrl+T takes over; Ctrl+] detaches.");
  };
  const uncertain = (error?: unknown) => {
    if (abort.signal.aborted || !interactive) return;
    loseControl(error instanceof TerminalControlError ? error.message : "Input delivery is uncertain. Nothing was retried. Inspect the terminal, then press Enter to enable input again.");
  };
  const checkHandoff = async () => {
    if (handoffBusy || abort.signal.aborted) return;
    handoffBusy = true;
    try {
      const handoff = await api.json<{ status: string; reason?: string; teamId?: string }>(`/sessions/${session.id}/handoff`, undefined, AbortSignal.timeout(5000));
      if (handoff.status === "blocked") {
        const message = `Agent handoff is blocked${handoff.reason ? `: ${clean(handoff.reason)}` : ". Inspect the session before continuing."}`;
        if (handoffNotice !== message) notice(handoffNotice = message);
        return;
      }
      if (!["requested", "waiting-for-control", "stopping", "creating", "started"].includes(handoff.status)) return;
      if (handoff.status === "started" || handoff.status === "creating") {
        const message = `Agent handoff ${handoff.status}${handoff.teamId ? ` · team ${clean(handoff.teamId)}` : ""}.`;
        if (handoffNotice !== message) notice(handoffNotice = message);
        stop();
      } else if (screen.active || screen.hasUnsentDraft) {
        const message = `Agent handoff is waiting${handoff.teamId ? ` for team ${clean(handoff.teamId)}` : ""} because this terminal has an unsent local draft. Insert or discard it explicitly, then detach with Ctrl+]; the host will not send or discard it.`;
        if (handoffNotice !== message) notice(handoffNotice = message);
        return;
      } else {
        if (["requested", "waiting-for-control"].includes(handoff.status) && duplex?.lease && leasesSupported && !controlPending) {
          controlPending = true;
          try { await duplex.control("release"); }
          catch { notice("Agent handoff is waiting for this terminal's control lease. Detach with Ctrl+] after checking the terminal."); return; }
          finally { controlPending = false; }
        }
        const message = `Agent handoff accepted${handoff.teamId ? ` · team ${clean(handoff.teamId)}` : ""}. Releasing this terminal and detaching; any other device lease remains untouched.`;
        notice(message);
        stop();
      }
    } catch { /* Older hosts return no handoff route; normal attachment continues. */ }
    finally { handoffBusy = false; }
  };
  const send = async () => {
    if (sending) return;
    sending = true;
    try {
      while (queued && interactive && online && !abort.signal.aborted) {
        const text = queued.slice(0, 8192); queued = queued.slice(text.length);
        if (duplex) { void duplex.raw(text).catch(uncertain); continue; }
        const receipt = await api.json<Receipt>(`/sessions/${session.id}/raw`, { requestId: randomUUID(), text }, abort.signal);
        if (receipt.state !== "delivered") throw new Error("Uncertain input");
      }
    } catch { uncertain(); } finally { sending = false; }
  };
  const input = (data: string) => {
    if (data.includes("\x1d")) { stop(); return; }
    if (screen.active) {
      if (data === "\x1b" || data === "\x03") { screen.finish(false); return; }
      if (data === "\x18") { screen.discard(); return; }
      if (data === "\x12") { screen.reviewed(); return; }
      if (data === "\x13") {
        if (!online || !interactive || lastStatus !== "running") { notice("Draft kept locally. Reconnect and enable interaction before inserting it."); return; }
        const draft = screen.finish(true);
        if (draft) {
          const { text, requestId } = draft;
          insertingDraft = true;
          const insertion = duplex ? duplex.input(text, requestId) : inputDelivered.then(async () => {
            if (!online || !interactive) throw new Error("Terminal disconnected");
            const receipt = await api.json<Receipt>(`/sessions/${session.id}/input`, { requestId, text, submit: false, force: true }, abort.signal);
            if (receipt.state !== "delivered") throw new Error("Uncertain draft insertion");
          });
          void insertion.then(() => screen.inserted()).catch(error => {
            if (error instanceof TerminalControlError) screen.refused();
            uncertain(error);
          }).finally(() => { insertingDraft = false; });
        }
        return;
      }
      if (data.includes("\x07")) { monitor(); return; }
      screen.input(data); return;
    }
    if (insertingDraft) { notice("Waiting for draft insertion. Input is disabled until delivery is confirmed."); return; }
    if (data === "\x05" && interactive && owner) { screen.open(); return; }
    if (!interactive) {
      if (data === "\x03") { stop(); return; }
      if (data === "\r" || data === "\n" || data === "\x14") {
        if (!online) notice("Disconnected. Input is disabled until the recording reconnects.");
        else if (!owner) notice("Read-only device. Pair an owner key to interact through the native terminal.");
        else if (lastStatus !== "running") notice("This process is not running.");
        else void acquire(data === "\x14");
      }
      return;
    }
    if (data.includes("\x07")) { monitor(); return; }
    if (!online) return;
    if (queued.length + data.length > 65536) { queued = ""; interactive = false; notice("Input buffer limit reached. Check the terminal before continuing."); return; }
    queued += data; if (!sending) inputDelivered = send();
  };
  notice(`${clean(session.title)} · ${session.id} · ${config.origin}\n${interactive ? "Interactive. Ctrl+E drafts locally; Ctrl+G monitors; Ctrl+] detaches; Ctrl+C interrupts the agent." : "Monitoring. Enter enables interaction; Ctrl+] detaches."}`);
  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", input); process.stdin.resume();
  process.stdout.on("resize", resize);
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
  handoffTimer = setInterval(() => { void checkHandoff(); }, 1000);
  handoffTimer.unref();
  try {
    while (!abort.signal.aborted) {
      const stalled = new AbortController();
      let watchdog = setTimeout(() => stalled.abort(), 20000);
      const signal = AbortSignal.any([abort.signal, stalled.signal]);
      try {
        if (!warned) progress.start(`Connecting to ${providerNames[session.provider] ?? session.provider} terminal`);
        // A fresh HTTP connection resumes only the recording cursor, never the provider.
        duplex = me.terminal.duplex ? terminalConnection(config.origin, config.token, session.id, cursor, signal, { clientId, snapshot: me.terminal.snapshot, control: me.terminal.control }) : undefined;
        async function* legacyPages(): AsyncGenerator<TerminalPage> {
          const response = await api.request(`/sessions/${session.id}/stream?after=${cursor}`, undefined, signal);
          let buffer = "";
          const decoder = new TextDecoder();
          for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 4 * 1024 * 1024) throw new Error("Oversized recording frame");
            let newline: number;
            while ((newline = buffer.indexOf("\n")) !== -1) {
              const page = JSON.parse(buffer.slice(0, newline)) as TerminalPage;
              buffer = buffer.slice(newline + 1); yield page;
            }
          }
        }
        for await (const page of duplex ? duplex.pages() : legacyPages()) {
            clearTimeout(watchdog); watchdog = setTimeout(() => stalled.abort(), 20000);
            if (page.error) throw new Error("Stream interrupted");
            if (page.refusal) loseControl(new TerminalControlError(page.refusal.code).message);
            if (page.snapshot) {
              render = terminalRenderer();
              await screen.snapshot(render(page.snapshot.ansi), page.snapshot.cols, page.snapshot.rows);
              progress.stop();
            }
            for (const event of page.events ?? []) {
              if (event.type === "output") {
                const text = render(String(event.data.text));
                if (text) progress.stop();
                if (text) await screen.output(text);
              }
            }
            if (page.cursor !== undefined) cursor = page.cursor;
            if (page.state) { lastStatus = page.state.status; if (page.state.exitCode !== undefined) process.exitCode = page.state.exitCode; }
            if (!online && page.state) {
              progress.stop(); online = true;
              leasesSupported = Boolean(duplex && me.terminal.control && page.state.capabilities?.inputControl);
              interactive = false;
              if (warned) notice("Reconnected to the same session. Monitoring; press Enter to steer.");
              else if (lastStatus === "running") {
                if (initialControl) await acquire();
                notice(`Live session connected. ${interactive ? "Interactive." : "Monitoring; press Enter to steer; Ctrl+T to take over."}`);
              }
              initialControl = false; warned = false;
            }
        }
        if (["exited", "unavailable"].includes(lastStatus)) { notice(`Session ${lastStatus}. The recording remains on the host.`); break; }
        throw new Error("Stream ended");
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error instanceof TerminalAccessError || (error instanceof HttpError && [400, 401, 403, 404].includes(error.status))) throw error;
        progress.stop();
        online = false; interactive = false; queued = "";
        initialControl = false; clearInterval(renewal); renewal = undefined;
        if (screen.pause()) notice("Unsent draft kept locally. After reconnecting, press Enter to interact, then Ctrl+E to restore it.");
        if (!warned) notice("Connection lost. Cloud execution continues. Reconnecting; input is disabled and will not be replayed.");
        warned = true;
        await delay(1500, undefined, { signal: abort.signal }).catch(() => {});
      } finally { clearTimeout(watchdog); stalled.abort(); duplex = undefined; }
    }
  } finally { restoreTerminal(); }
  function restoreTerminal() {
    progress.stop(); clearInterval(renewal); clearInterval(handoffTimer); abort.abort(); queued = ""; screen.dispose();
    process.stdin.off("data", input); process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.off("resize", resize);
    process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop);
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[0m\r\n");
  }
}

const CLIENT_COMMANDS = new Set(["pair", "resume", "monitor", "recover", "projects", "start", "mission", "board", "list", "usage", "resources", "close", "sync", "pull", "team", "repo"]);
export interface ParsedClientArgs { command: string; args: string[]; options: Record<string, string | boolean>; includes: string[] }

/** Infinite options come before the provider; everything after a provider is passed through unchanged. */
export function parseClientArgs(argv: string[]): ParsedClientArgs {
  const args = [...argv];
  const options: Record<string, string | boolean> = {};
  const includes: string[] = [];
  const strings = new Set(["--client-config", "--project", "--title", "--token-file", "--output", "--prd", "--provider", "--setup-json", "--check-json", "--linear-team", "--linear-project", "--handoff", "--request-id", "--relationship", "--delivery", "--repository", "--base-branch", "--merge-method", "--teamwork", "--permissions", "--permission-scope", "--permission-limit", "--role"]);
  const booleans = new Set(["--detach", "--json", "--local-ui", "--takeover", "--laptop", "--cloud", "--stop", "--status", "--apply", "--force", "--watch", "--yes", "--logs"]);
  const option = () => {
    const name = args.shift()!;
    if (name === "--include" && args.length) includes.push(args.shift()!);
    else if (booleans.has(name)) options[name] = true;
    else if (strings.has(name) && args.length) options[name] = args.shift()!;
    else throw new Error(`Unknown or incomplete Infinite option: ${name}`);
  };
  while (args[0]?.startsWith("--")) option();
  const command = args.shift() ?? "";
  const positional: string[] = [];
  // Unknown commands belong to the server CLI, whose options this parser must not reject.
  if (CLIENT_COMMANDS.has(command)) while (args.length) { if (args[0].startsWith("--")) option(); else positional.push(args.shift()!); }
  // Checked after trailing options, so `infinite sync --include DIR` is refused like the leading form.
  if (options["--cloud"] && options["--laptop"]) throw new Error("Choose either cloud execution or --laptop");
  if (options["--laptop"]) {
    if (command !== "codex") throw new Error("--laptop starts a Codex session in this directory. Resume existing sessions with infinite resume ID.");
    options["--local-ui"] = true;
  }
  if (includes.length && !options["--laptop"]) throw new Error("--include applies to --laptop execution; cloud sessions use the configured project");
  if (["--stop", "--status", "--apply"].filter(name => options[name]).length > 1) throw new Error("Choose one of --stop, --status, or --apply");
  if (options["--force"] && !options["--apply"]) throw new Error("--force applies to infinite sync --apply");
  if (command === "sync" && positional.length) throw new Error("infinite sync takes no arguments; run it inside the checkout and choose the project with --project ID");
  if (command === "pull" && positional.length > 1) throw new Error("infinite pull takes at most one project ID");
  if (options["--watch"] && command !== "resources") throw new Error("--watch applies to infinite resources");
  if (options["--yes"] && command !== "close") throw new Error("--yes applies to infinite close");
  if (options["--logs"] && command !== "team") throw new Error("--logs applies to infinite team status or infinite team watch");
  if (options["--logs"] && options["--json"]) throw new Error("Use either --logs or --json");
  if (command === "resources" && positional.length) throw new Error("infinite resources takes no arguments");
  if (command === "close" && positional.length !== 1) throw new Error("Usage: infinite close SESSION_ID [--yes] [--takeover]");
  return { command, args: providers.has(command) ? args : positional, options, includes };
}

/** Real path of `path`, resolving the nearest existing ancestor when the path does not exist yet. */
function realPath(path: string): string {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...missing); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      missing.unshift(basename(current));
    }
  }
}
/** Checkout roots recorded by sync services in `syncDir`, running or not. An unreadable record names no root. */
function syncRoots(syncDir: string) {
  if (!existsSync(syncDir)) return [];
  return readdirSync(syncDir).flatMap(name => {
    if (!/^[a-z0-9-]{1,80}\.json$/.test(name)) return [];
    try { const root = readSyncState(join(syncDir, name))?.root; return typeof root === "string" ? [root] : []; } catch { return []; }
  });
}
function gitRoot(cwd: string) {
  try { return realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { return cwd; }
}
/** A local sync record keeps offline stop and explicit apply/pull pointed at this checkout. */
function localSyncProject(syncDir: string, origin: string): string | undefined {
  if (!existsSync(syncDir)) return undefined;
  const root = gitRoot(realpathSync(process.cwd()));
  const matches = readdirSync(syncDir).flatMap(name => {
    if (!/^[a-z0-9-]{1,80}\.json$/.test(name)) return [];
    try {
      const state = readSyncState(join(syncDir, name));
      return state?.root === root && state.origin === origin ? [name.slice(0, -5)] : [];
    } catch { return []; }
  });
  return matches.length === 1 ? matches[0] : undefined;
}
function age(iso?: string) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
type Pending = { reason: string; receivedAt: string; capturedAt?: string; category?: string; message?: string };
type ProjectDetail = { id: string; name: string; sync: { lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: Pending; skipped?: number } };
function describePending(pending: Pending) {
  if (pending.reason === "session-running") return "session running";
  if (pending.reason === "cloud-changed") return "cloud changed; use infinite sync --apply --force or infinite pull";
  if (pending.reason === "awaiting-apply") return "no session running; apply with infinite sync --apply";
  if (pending.reason === "apply-failed") return `apply failed: ${clean(pending.category ?? "other")}${pending.message ? `. ${clean(pending.message)}` : ""} Retry with infinite sync --apply`;
  return clean(pending.reason);
}
function describeSync(sync: ProjectDetail["sync"]) {
  const pending = sync.pendingGeneration ? ` · pending (${describePending(sync.pendingGeneration)})` : "";
  const skipped = sync.skipped ? ` · ${sync.skipped} special file${sync.skipped === 1 ? "" : "s"} left out of the cloud scan` : "";
  return `synced ${age(sync.lastSyncedAt)} · applied ${age(sync.appliedAt)}${pending}${skipped}`;
}
async function listLegacyProjects(projects: Me["projects"], api: { json<T>(path: string): Promise<T> }) {
  for (const project of projects) {
    const detail = await api.json<ProjectDetail>(`/projects/${project.id}`).catch(() => undefined);
    console.log(`${project.id}  ${clean(project.name)}${detail ? `  · ${describeSync(detail.sync)}` : ""}`);
  }
}
function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function listProjects(groups: ProjectGroupList, api: { json<T>(path: string): Promise<T> }, json: boolean) {
  if (json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }
  for (const group of groups.groups) {
    console.log(`${group.id}  ${clean(group.name)}${group.implicit ? "  (single-repo)" : ""}`);
    for (const repo of group.repos) {
      const detail = await api.json<ProjectDetail>(`/projects/${repo.projectId}`).catch(() => undefined);
      console.log(`  ${repo.projectId}  ${clean(repo.name)}${detail ? `  · ${describeSync(detail.sync)}` : ""}`);
    }
  }
  if (groups.suggestions.length) {
    console.log("\nSuggested groups (accept with the command shown):");
    for (const suggestion of groups.suggestions) {
      const command = ["infinite projects group", shellQuote(suggestion.name), ...suggestion.repos.map(shellQuote)].join(" ");
      console.log(`${suggestion.name}  (${suggestion.reason})\n  ${command}`);
    }
  }
  if (!groups.groups.length && !groups.suggestions.length) console.log("No projects are enrolled.");
}
async function showProjects(me: Me, api: { json<T>(path: string): Promise<T> }, json: boolean) {
  let groups: ProjectGroupList;
  try {
    groups = await api.json<ProjectGroupList>("/project-groups");
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    await listLegacyProjects(me.projects, api);
    return;
  }
  await listProjects(groups, api, json);
}

/** One line per provider. Period words come from each provider's own window, never a fixed "month". */
export function usageLines(summary: import("./usage-service.js").UsageSummary): string[] {
  const width = Math.max(...Object.keys(summary.providers).map(name => name.length));
  return Object.entries(summary.providers).map(([name, entry]) => {
    const label = name.padEnd(width);
    if (!entry.measured || !entry.spent) return `${label}  unmeasured (${entry.unmeasuredSessions} session${entry.unmeasuredSessions === 1 ? "" : "s"}, no usage is recorded for this provider)`;
    const days = Math.round((Date.parse(entry.period.end) - Date.parse(entry.period.start)) / 86_400_000);
    const word = entry.budget?.period ?? (days <= 1 ? "day" : days <= 7 ? "week" : "month");
    const unpriced = entry.spent.pricing.unknown;
    const detail = [`${entry.spent.messages} steps`, ...(unpriced ? [`${unpriced} unpriced`] : []), `${entry.unmeasuredSessions} unmeasured sessions`].join(", ");
    const { messages, pricing } = entry.spent, noPrice = messages > 0 && pricing.unknown === messages;
    const figure = noPrice ? "— (no price available)" : `${pricing.unknown > 0 ? "at least " : ""}$${formatUsd(entry.spent.cost)}`;
    const spent = `spent ${figure}${entry.budget ? ` of $${formatUsd(entry.budget.usd)}` : ""}`;
    return `${label}  ${spent} for ${word} from ${entry.period.start.slice(0, 10)} (${detail})${entry.budget && entry.spent.cost > entry.budget.usd ? " OVER BUDGET" : ""}`;
  });
}

export function usageBars(values: number[]): string {
  const levels = "▁▂▃▄▅▆▇█", max = Math.max(0, ...values);
  return values.map(value => levels[max > 0 ? Math.max(0, Math.min(7, Math.floor(value / max * 7))) : 0]).join("");
}
function usageOverview(summary: import("./usage-service.js").UsageSummary, daily: { days: { date: string; usd: number }[] }) {
  const money = (value: { usd: number; unpriced: number }) => `${value.unpriced ? "≥ " : ""}$${formatUsd(value.usd)}`;
  const lines = [`Month ${money(summary.month.spent)} · previous ${money(summary.month.previous)} · plans $${formatUsd(summary.month.plansUsd)}`,
    `Unmeasured sessions ${summary.month.unmeasuredSessions}`,
    ...summary.accounts.map(account => `${account.id}  ${account.kind === "subscription" ? `plan $${formatUsd(account.planUsd ?? 0)}` : money(account.month ?? { usd: 0, unpriced: 0 })} · balance ${account.balance ? `${account.balance.currency} ${account.balance.amount.toFixed(2)}${account.balance.stale ? " stale" : ""} as of ${account.balance.asOf}` : "—"}`),
    usageBars(daily.days.map(day => day.usd)),
    ...(daily.days.length ? [`${daily.days[0].date} — ${daily.days.at(-1)!.date}`] : [])];
  return lines;
}

export async function handleClientCommand(argv: string[]): Promise<boolean> {
  if (argv[0] === "cmux") {
    try {
      const child = spawn("infinite-cmux", argv.slice(1), { stdio: "inherit" });
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
    } catch { console.error("[Infinite] The standalone infinite-cmux launcher is unavailable. Install and pair it before using infinite cmux."); process.exitCode = 1; }
    return true;
  }
  const progress = startupProgress();
  const args = [...argv];
  // Keep server administration commands and their --config semantics intact.
  const candidate = args.find(a => providers.has(a) || CLIENT_COMMANDS.has(a));
  if (!candidate || (candidate === "list" && args.includes("--config"))) return false;
  try {
    const parsed = parseClientArgs(args);
    const { command, options, includes } = parsed;
    if (!providers.has(command) && !CLIENT_COMMANDS.has(command)) return false;
    const positional = providers.has(command) ? [] : parsed.args;
    const nativeArgs = providers.has(command) ? parsed.args : [];
    const path = resolve(String(options["--client-config"] ?? process.env.INFINITE_CLIENT_CONFIG ?? join(homedir(), ".config/infinite/client.json")));
    if (command === "pair") {
      if (!positional[0] || !options["--token-file"]) throw new Error("Usage: infinite pair https://HOST --token-file FILE (use - to read the key from stdin)");
      const file = String(options["--token-file"]);
      let token = "";
      if (file === "-") { for await (const chunk of process.stdin) { token += chunk; if (token.length > 4096) throw new Error("Invalid device key"); } }
      else token = readFileSync(file, "utf8");
      token = token.trim();
      if (!/^[\x21-\x7e]{32,200}$/.test(token)) throw new Error("Provide a device key, not the devices JSON file");
      const config: ClientConfig = { origin: originOf(positional[0]), token };
      const me = await connection(config).json<Me>("/me");
      if (!me.terminal?.stream) throw new Error("Upgrade the host before pairing this native CLI");
      config.projectId = String(options["--project"] ?? me.projects[0]?.id ?? "");
      if (!me.projects.some(p => p.id === config.projectId)) throw new Error("Unknown project ID");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeClientConfig(path, config);
      console.log(`Paired ${config.origin} as ${me.role}. Credentials saved privately at ${path}`);
      return true;
    }
    // Existing local-host list remains available before a laptop is paired.
    if (command === "list" && !existsSync(path) && !options["--client-config"] && !process.env.INFINITE_CLIENT_CONFIG) return false;
    const config = loadConfig(path), api = connection(config);
    if (command === "team" || command === "repo") {
      return await handleTeamClientCommand(command, positional, options, config, api, path, argv);
    }
    if (command === "list") {
      const { sessions } = await api.json<{ sessions: Session[] }>("/sessions");
      if (options["--json"]) console.log(JSON.stringify(sessions, null, 2));
      else printSessions(sessions, (await api.json<Me>("/me")).machine?.label || new URL(config.origin).hostname);
      return true;
    }
    if (command === "usage") {
      const sub = positional[0], tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", query = `?tz=${encodeURIComponent(tz)}`;
      if (sub === "projects") { const result = await api.json("/usage/projects" + query); if (options["--json"]) console.log(JSON.stringify(result, null, 2)); else console.log(JSON.stringify(result, null, 2)); return true; }
      if (sub === "project" || sub === "goal") { if (!positional[1]) throw new Error(`Usage: infinite usage ${sub} ID [--json]`); const result = await api.json(sub === "project" ? `/usage/projects/${encodeURIComponent(positional[1])}${query}` : `/goals/${encodeURIComponent(positional[1])}`); if (options["--json"]) console.log(JSON.stringify(result, null, 2)); else console.log(JSON.stringify(result, null, 2)); return true; }
      if (sub === "models") { const result = await api.json(`/usage/models?role=${encodeURIComponent(String(options["--role"] ?? "implementer"))}`); if (options["--json"]) console.log(JSON.stringify(result, null, 2)); else console.log(JSON.stringify(result, null, 2)); return true; }
      if (sub || positional.length) throw new Error("Usage: infinite usage [projects|project ID|goal ID|models [--role ROLE]] [--json]");
      const [summary, daily] = await Promise.all([api.json<import("./usage-service.js").UsageSummary>("/usage"), api.json<{ days: { date: string; usd: number }[] }>(`/usage/daily?days=30&tz=${encodeURIComponent(tz)}`)]);
      if (options["--json"]) console.log(JSON.stringify({ ...summary, daily }, null, 2));
      else for (const line of usageOverview(summary, daily)) console.log(line);
      return true;
    }
    if (command === "resources") { await resources(api, options); return true; }
    if (command === "sync" && (options["--stop"] || options["--status"])) {
      // The service is a local process: stopping or inspecting it must not depend on reaching the host.
      const syncDir = join(dirname(path), "sync");
      const recorded = existsSync(syncDir) ? readdirSync(syncDir).flatMap(name => /^([a-z0-9-]{1,80})\.json$/.exec(name)?.[1] ?? []) : [];
      if (options["--stop"]) {
        const projectId = String(options["--project"] ?? localSyncProject(syncDir, config.origin) ?? config.projectId ?? (recorded.length === 1 ? recorded[0] : ""));
        if (!PROJECT_ID.test(projectId)) throw new Error(`Choose a project with --project ID${recorded.length ? ` (recorded: ${recorded.join(", ")})` : ""}`);
        console.log(stopSyncService(join(syncDir, `${projectId}.json`)) ? "Sync service stopped. The cloud copy keeps its last applied generation." : "No sync service was running for this project.");
        return true;
      }
      let me: Me | undefined, offline = "";
      try { me = await api.json<Me>("/me", undefined, AbortSignal.timeout(5000)); }
      catch (error) { offline = error instanceof HttpError ? `host returned HTTP ${error.status}` : "host unreachable"; }
      for (const id of new Set([...(me ? me.projects.map(p => p.id) : config.projectId ? [config.projectId] : []).filter(id => PROJECT_ID.test(id)), ...recorded])) {
        const state = recorded.includes(id) ? readSyncState(join(syncDir, `${id}.json`)) : undefined;
        const local = !state ? "no local service" : !syncServiceRunning(state) ? `stale service record (pid ${state.pid} not running)`
          : `service pid ${state.pid} · ${clean(state.root)}${state.skipped ? ` · ${state.skipped} special file${state.skipped === 1 ? "" : "s"} left out` : ""}${state.problem ? ` · problem: ${clean(state.problem)}` : ""}`;
        const detail = me && await api.json<ProjectDetail>(`/projects/${id}`).catch(() => undefined);
        console.log(`${id}  ${local}${detail ? ` · ${describeSync(detail.sync)}` : offline ? ` · ${offline}` : ""}`);
      }
      return true;
    }
    if (command !== "projects") progress.start(`Connecting to ${new URL(config.origin).hostname}`);
    const me = await api.json<Me>("/me");
    progress.stop();
    const mappedProject = async () => {
      if (me.capabilities?.workspaceMirror !== 1) throw new Error("Upgrade the host for local folder mapping, or select a configured cloud project with --project ID.");
      const cwd = realpathSync(process.cwd()), root = gitRoot(cwd);
      const project = await api.json<{ id: string; name: string; path: string }>("/projects/resolve", { path: localProjectPath(root) });
      if (!PROJECT_ID.test(project.id)) throw new Error("Invalid mirrored project response");
      return { ...project, root, cwd: relative(root, cwd).split(sep).join("/") };
    };
    const syncProject = async (projectId: string, root: string, reuse: boolean) => {
      const syncDir = join(dirname(path), "sync"), stateFile = join(syncDir, `${projectId}.json`);
      const existing = readSyncState(stateFile);
      if (reuse && existing && syncServiceRunning(existing)) {
        if (existing.root !== root || existing.origin !== config.origin) throw new Error("A different checkout already syncs this cloud project. Stop its sync service before changing folders.");
        if (!existing.lastCommitAt) throw new Error("Workspace sync is still preparing its first upload. Wait for it before launching a session.");
        return { skipped: { count: existing.skipped ?? 0, paths: [] as string[] } };
      }
      return startSyncService({ origin: config.origin, token: config.token, projectId, root, stateFile, storeDir: join(syncDir, `${projectId}-store`) });
    };
    if (command === "close") {
      const { sessions } = await api.json<{ sessions: Session[] }>("/sessions");
      await closeSession(api, me, await selectSession(sessions, positional[0], true), options);
      return true;
    }
    if (command === "projects") {
      if (positional[0] !== "forget") {
        if (!positional.length) { await showProjects(me, api, Boolean(options["--json"])); return true; }
        return await handleBoardClientCommand(command, positional, options, config, api, path);
      }
      if (positional[0] === "forget") {
        if (me.capabilities?.mirrorForget !== 1) throw new Error("Upgrade the host before forgetting a mirrored project.");
        if (positional.length > 2) throw new Error("Usage: infinite projects forget [DIRECTORY] [--project ID]");
        const projectId = options["--project"] === undefined ? undefined : String(options["--project"]);
        let selected = projectId;
        if (!selected) {
          const directory = realpathSync(resolve(String(positional[1] ?? process.cwd())));
          const relativePath = localProjectPath(gitRoot(directory));
          const matches = me.projects.filter(project => project.name === relativePath);
          if (matches.length !== 1) throw new Error(matches.length ? "More than one mirrored project matches this directory; use --project ID." : "No mirrored project matches this directory. Resolve it with a native launch before forgetting it.");
          selected = matches[0].id;
        }
        if (!PROJECT_ID.test(selected)) throw new Error("Invalid project ID.");
        const retained = await api.json<{ id: string; name: string; path: string }>(`/projects/${selected}/mirror`, undefined, undefined, undefined, "DELETE");
        forgetBoundTeamProject(config, path, selected);
        if (config.projectId === selected) {
          delete config.projectId;
          writeClientConfig(path, config);
        }
        console.log(`Forgot mirrored project ${clean(retained.id)} (${clean(retained.name)}). Server directory retained at ${clean(retained.path)}; cloud files were kept.`);
        return true;
      }
    }
    if (["start", "mission", "board"].includes(command)) {
      return await handleBoardClientCommand(command as "start" | "mission" | "board", positional, options, config, api, path);
    }
    if (command === "recover") {
      if (me.role !== "owner") throw new Error("Workspace recovery requires an owner device key");
      const { sessions } = await api.json<{ sessions: Session[] }>("/sessions");
      const selected = await selectSession(sessions, positional[0], true);
      progress.start("Downloading a cloud checkpoint for reconciliation");
      const call = async (method: string, extra: Record<string, unknown> = {}) =>
        (await api.request(`/sessions/${selected.id}/workspace-export`, { method, ...extra }, AbortSignal.timeout(300000))).json();
      const exported = await call("sync/export");
      const manifest = validateWorkspaceManifest(exported.manifest);
      const directory = join(dirname(path), "workspaces", selected.id), storeDir = join(directory, "objects");
      const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
      for (let offset = 0; offset < hashes.length; offset += 512) {
        for (const hash of await hasWorkspaceBlobs(storeDir, hashes.slice(offset, offset + 512))) {
          const { base64 } = await call("sync/blob", { hash });
          await putWorkspaceBlob(storeDir, hash, base64);
        }
      }
      const destination = resolve(String(options["--output"] ?? join(directory, "recovered", manifest.id)));
      const recovered = await materializeWorkspace({ manifest, storeDir, destination });
      progress.stop();
      console.log(recovered.cwd);
      console.error("[Infinite] Cloud checkpoint downloaded. Compare this copy with your preserved laptop project; tools remain in the cloud.");
      return true;
    }
    if (command === "sync") {
      if (me.role !== "owner") throw new Error("Workspace sync requires an owner device key");
      const mapped = !options["--project"] && !options["--apply"] ? await mappedProject() : undefined;
      const projectId = String(mapped?.id ?? options["--project"] ?? localSyncProject(join(dirname(path), "sync"), config.origin) ?? config.projectId ?? me.projects[0]?.id ?? "");
      if (!PROJECT_ID.test(projectId) || (!mapped && !me.projects.some(p => p.id === projectId))) throw new Error("Unknown project. Use infinite projects");
      if (options["--apply"]) {
        // A large tree can take minutes to publish; a refusal (409) leaves its reason in the pending marker.
        const applied = await api.request(`/projects/${projectId}/sync/apply`, options["--force"] ? { force: true } : {}, AbortSignal.timeout(300000)).catch(async (error: unknown) => {
          if (!(error instanceof HttpError) || error.status !== 409) throw error;
          throw new Error(`Not applied. ${describeSync((await api.json<ProjectDetail>(`/projects/${projectId}`)).sync)}`);
        });
        console.log(describeSync(await applied.json() as ProjectDetail["sync"])); return true;
      }
      const root = mapped?.root ?? gitRoot(realpathSync(process.cwd()));
      if (root === realpathSync(homedir()) || root === dirname(root)) throw new Error("Run inside a project directory; selecting the entire home or filesystem is not supported");
      progress.start(`Uploading ${clean(root)} to project ${projectId}`);
      const { skipped } = await syncProject(projectId, root, Boolean(mapped));
      progress.stop();
      if (skipped.count) console.error(`[Infinite] Left out ${skipped.count} socket, FIFO, or device file${skipped.count === 1 ? "" : "s"}, which sync cannot copy: ${skipped.paths.map(clean).join(", ")}${skipped.count > skipped.paths.length ? ", …" : ""}`);
      const detail = await api.json<ProjectDetail>(`/projects/${projectId}`);
      console.error(`[Infinite] Sync service running for ${clean(root)} → ${projectId}. ${describeSync(detail.sync)}. It keeps running after this command exits; stop it with infinite sync --stop --project ${projectId}.`);
      return true;
    }
    if (command === "pull") {
      if (me.role !== "owner") throw new Error("Workspace pull requires an owner device key");
      const projectId = positional[0] ?? String(localSyncProject(join(dirname(path), "sync"), config.origin) ?? config.projectId ?? me.projects[0]?.id ?? "");
      if (!PROJECT_ID.test(projectId) || !me.projects.some(p => p.id === projectId)) throw new Error("Unknown project. Use infinite projects");
      const directory = join(dirname(path), "pulls", projectId), storeDir = join(directory, "objects");
      const output = options["--output"] === undefined ? undefined : resolve(String(options["--output"]));
      // A sync service uploads everything under its root, so a pulled copy there would travel back to the cloud.
      const target = realPath(output ?? directory);
      if (syncRoots(join(dirname(path), "sync")).some(root => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)))
        throw new Error("Choose an --output directory outside every synced checkout; the sync service would upload the pulled copy");
      progress.start("Downloading the cloud project tree");
      // The host scans the whole cloud tree before replying; api.json would cap that at 15 s.
      const { manifest: exported } = await (await api.request(`/projects/${projectId}/sync/export`, {}, AbortSignal.timeout(300000))).json() as { manifest: unknown };
      const manifest = validateWorkspaceManifest(exported);
      const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
      for (let offset = 0; offset < hashes.length; offset += 512)
        for (const hash of await hasWorkspaceBlobs(storeDir, hashes.slice(offset, offset + 512))) {
          const { base64 } = await api.json<{ base64: string }>(`/projects/${projectId}/sync/blob/${hash}`);
          await putWorkspaceBlob(storeDir, hash, base64);
        }
      const destination = output ?? join(directory, manifest.id);
      const pulled = await materializeWorkspace({ manifest, storeDir, destination });
      progress.stop();
      console.log(pulled.cwd);
      console.error("[Infinite] Cloud project downloaded into a new directory. Compare it with your checkout; nothing on this computer was overwritten.");
      return true;
    }
    let session: Session;
    let emptyLaptopPrompt = false;
    if (providers.has(command)) {
      if (me.role !== "owner") throw new Error("Only an owner device can launch native sessions");
      if (!me.terminal?.stream) throw new Error("Upgrade the host to support native CLI sessions");
      let workspace: { cwd: string; roots: string[]; token: string } | undefined;
      if (options["--laptop"]) {
        if (!me.execution?.laptop) throw new Error("Upgrade the single-tenant host for laptop execution, or omit --laptop to use its configured cloud project");
        await checkLaptopExecutor();
        const cwd = realpathSync(process.cwd()), root = gitRoot(cwd);
        const roots = [...new Set([root, ...includes.map(value => realpathSync(resolve(value)))])];
        if (roots.length > 16 || roots.some(value => !statSync(value).isDirectory())) throw new Error("Select at most 16 project directories");
        if (roots.some(value => value === dirname(value) || value === realpathSync(homedir()))) throw new Error("Run inside a project directory; selecting the entire home or filesystem is not supported");
        workspace = { cwd, roots, token: randomBytes(32).toString("hex") };
      }
      if (options["--local-ui"]) {
        if (!["codex", "opencode"].includes(command) || !me.nativeUi?.includes(command)) throw new Error("This host does not support this provider’s local UI. Other providers retain their native cloud terminal.");
        if (command === "codex") {
          const launch = validateNativeCodexArgs(nativeArgs, "", Boolean(workspace));
          emptyLaptopPrompt = Boolean(workspace) && launch.at(-2) !== "--";
        } else validateNativeOpenCodeArgs(nativeArgs);
        if (!options["--detach"]) await (command === "codex" ? checkNativeCodex : checkNativeOpenCode)();
      }
      const bound = !workspace && !options["--project"] ? boundTeamProject(config, path) : undefined;
      const boundCwd = bound ? relative(gitRoot(realpathSync(process.cwd())), realpathSync(process.cwd())).split(sep).join("/") : undefined;
      const mapped = !workspace && !options["--project"] && !bound ? await mappedProject() : undefined;
      const projectId = String(bound ?? mapped?.id ?? options["--project"] ?? config.projectId ?? me.projects[0]?.id ?? "");
      if (!mapped && !me.projects.some(p => p.id === projectId)) throw new Error("Unknown project. Use infinite projects");
      if (mapped) {
        progress.start(`Syncing ${clean(mapped.root)} to ${clean(mapped.path)}`);
        await syncProject(projectId, mapped.root, true);
        const detail = await api.json<ProjectDetail>(`/projects/${projectId}`);
        if (!detail.sync.appliedManifest) throw new Error(`The mirrored workspace has not been applied. Inspect infinite sync --status; apply it with infinite sync --apply --project ${projectId} before launching.`);
        progress.stop();
      }
      if (!workspace) {
        // A cloud session starts on the tree in place; laptop changes that wait for an apply are not in it.
        const pending = (await api.json<ProjectDetail>(`/projects/${projectId}`).catch(() => undefined))?.sync?.pendingGeneration;
        if (pending) console.error(`[Infinite] Laptop changes from ${age(pending.capturedAt ?? pending.receivedAt)} are pending; run infinite sync --apply`);
      }
      const requestId = randomUUID();
      console.error(`[Infinite] Launch ${requestId} on ${config.origin} · project ${projectId}`);
      progress.start(`Starting ${providerNames[command]} on ${new URL(config.origin).hostname}`);
      const generatedTitle = !String(options["--title"] ?? "").trim();
      session = await api.json<Session>("/sessions", { requestId, provider: command, projectId, title: String(options["--title"] ?? "").trim() || `${command} session`, ...(generatedTitle ? { generatedTitle: true } : {}), nativeArgs, ...((boundCwd ?? mapped?.cwd) ? { cwd: boundCwd ?? mapped!.cwd } : {}), ...(options["--local-ui"] ? { localUi: true } : {}), ...(workspace ? { workspace } : {}) });
      if (workspace) {
        progress.start("Connecting the laptop executor");
        await startLaptopService({ ...config, sessionId: session.id, workspaceToken: workspace.token, cwd: workspace.cwd, roots: workspace.roots, configFile: path });
        // Tunnel readiness precedes provider admission. Detached launch must not
        // report success if the backend rejects this executor or the first thread.
        progress.start("Preparing the first laptop turn");
        const deadline = Date.now() + 30000;
        while (true) {
          const current = await api.json<Session & WorkerState>(`/sessions/${session.id}`);
          if (["exited", "recording-error", "unavailable"].includes(current.status))
            throw new Error("Codex could not prepare laptop execution. Inspect this session with infinite monitor; the original request was not replayed.");
          if (current.status === "running" && current.nativeSession?.source === "protocol" && current.execution?.state === "online") { session = current; break; }
          if (Date.now() >= deadline) throw new Error("Laptop execution is still preparing. Inspect the existing session with infinite monitor before retrying; do not create a duplicate task.");
          await delay(100);
        }
        console.error(`[Infinite] Tools use ${clean(workspace.cwd)} on this laptop. Cloud preparation runs in the background; the session shows readiness and checkpoint age. Closing the interface leaves the laptop service running.`);
      }
      progress.stop();
      if (options["--detach"]) { console.log(session.id); return true; }
    } else {
      progress.start("Loading sessions");
      const { sessions } = await api.json<{ sessions: Session[] }>("/sessions");
      progress.stop();
      session = await selectSession(sessions, positional[0], command === "monitor");
    }
    if (command === "resume" && session.workspace && session.runtime?.nativeUi === "codex" && me.role === "owner") {
      const info = await api.json<{ sessionId?: string }>(`/sessions/${session.id}/native`);
      emptyLaptopPrompt = !info.sessionId;
    }
    if (session.runtime?.nativeUi && command !== "monitor" && !emptyLaptopPrompt) {
      if (me.role !== "owner") throw new Error("Pair an owner device to open the native frontend");
      await (session.runtime.nativeUi === "codex" ? attachNativeCodex : attachNativeOpenCode)(config, session, Boolean(options["--takeover"]));
    } else {
      if (options["--takeover"]) throw new Error("--takeover applies to local native UI sessions. Use the terminal's control command for this session.");
      if (options["--local-ui"] && !providers.has(command)) throw new Error("This existing session retains its original terminal. Native UI requires a session created with --local-ui.");
      await attach(config, path, me, session, command === "monitor", providers.has(command));
    }
  } catch (error) {
    progress.stop();
    console.error(`[Infinite] ${error instanceof Error ? error.message : "Client operation failed"}`);
    process.exitCode = 1;
  } finally { progress.stop(); }
  return true;
}
