import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Receipt, Session, Status } from "./types.js";
import { terminalConnection, TerminalAccessError, TerminalControlError, type TerminalPage } from "./client-transport.js";
import { draftTerminal } from "./client-draft.js";
import { localDraftStore } from "./client-draft-store.js";
import { attachNativeCodex, checkNativeCodex } from "./client-native.js";
import { attachNativeOpenCode, checkNativeOpenCode } from "./client-opencode.js";
import { validateNativeOpenCodeArgs } from "./native-opencode.js";
import { validateNativeCodexArgs } from "./native-codex.js";

type ClientConfig = { origin: string; token: string; projectId?: string };
type Me = { role: string; nativeUi?: string[]; terminal?: { stream: boolean; raw: boolean; duplex?: boolean; snapshot?: boolean; control?: boolean }; projects: { id: string; name: string }[] };
const providers = new Set(["claude", "codex", "grok", "opencode"]);
const providerNames: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok", opencode: "OpenCode" };
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
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function originOf(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the host origin without credentials, a path, or query parameters");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Remote pairing requires HTTPS");
  return url.origin;
}
function loadConfig(path: string): ClientConfig {
  if (!existsSync(path)) throw new Error(`Pair this laptop first: infinite pair https://HOST --token-file FILE\nClient configuration: ${path}`);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077)) throw new Error(`Client credentials must be private: chmod 600 ${path}`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (typeof config.token !== "string" || !/^[\x21-\x7e]{32,200}$/.test(config.token)) throw new Error("Invalid device key in client configuration");
  return { ...config, origin: originOf(config.origin) };
}
function connection(config: ClientConfig, clientId = randomUUID()) {
  const request = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(config.origin + "/api" + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Bearer ${config.token}`, "X-Infinite-Client": clientId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // Server errors may contain request details; report only a bounded category.
      await response.body?.cancel();
      throw new HttpError(response.status, `Host returned HTTP ${response.status}. ${response.status === 401 ? "Pair a current device key." : response.status === 403 ? "This device is not permitted to perform that action." : "Check the session before retrying an input or launch."}`);
    }
    return response;
  };
  return { request, json: async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => (await request(path, body, signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : undefined)).json() as Promise<T> };
}
function printSessions(sessions: Session[]) {
  for (const s of sessions) console.log(`${s.id}  ${s.provider.padEnd(8)}  ${s.status.padEnd(15)}  ${clean(s.title)}`);
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
    progress.stop(); clearInterval(renewal); abort.abort(); queued = ""; screen.dispose();
    process.stdin.off("data", input); process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.off("resize", resize);
    process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop);
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[0m\r\n");
  }
}

export async function handleClientCommand(argv: string[]): Promise<boolean> {
  const progress = startupProgress();
  const args = [...argv];
  const options: Record<string, string | boolean> = {};
  const strings = new Set(["--client-config", "--project", "--title", "--token-file"]);
  const booleans = new Set(["--detach", "--json", "--local-ui", "--takeover"]);
  const option = () => {
    const name = args.shift()!;
    if (booleans.has(name)) options[name] = true;
    else if (strings.has(name) && args.length) options[name] = args.shift()!;
    else throw new Error(`Unknown or incomplete Infinite option: ${name}`);
  };
  // Keep server administration commands and their --config semantics intact.
  const candidate = args.find(a => providers.has(a) || ["pair", "resume", "monitor", "projects", "list"].includes(a));
  if (!candidate || (candidate === "list" && args.includes("--config"))) return false;
  try {
    while (args[0]?.startsWith("--")) option();
    const command = args.shift()!;
    if (!providers.has(command) && !["pair", "resume", "monitor", "projects", "list"].includes(command)) return false;
    const positional: string[] = [];
    if (!providers.has(command)) while (args.length) { if (args[0].startsWith("--")) option(); else positional.push(args.shift()!); }
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
      const temporary = path + "." + randomUUID();
      writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, path); chmodSync(path, 0o600);
      console.log(`Paired ${config.origin} as ${me.role}. Credentials saved privately at ${path}`);
      return true;
    }
    // Existing local-host list remains available before a laptop is paired.
    if (command === "list" && !existsSync(path) && !options["--client-config"] && !process.env.INFINITE_CLIENT_CONFIG) return false;
    const config = loadConfig(path), api = connection(config);
    if (command === "list") { const { sessions } = await api.json<{ sessions: Session[] }>("/sessions"); if (options["--json"]) console.log(JSON.stringify(sessions, null, 2)); else printSessions(sessions); return true; }
    if (command !== "projects") progress.start(`Connecting to ${new URL(config.origin).hostname}`);
    const me = await api.json<Me>("/me");
    progress.stop();
    if (command === "projects") { me.projects.forEach(p => console.log(`${p.id}  ${clean(p.name)}`)); return true; }
    let session: Session;
    if (providers.has(command)) {
      if (me.role !== "owner") throw new Error("Only an owner device can launch native sessions");
      if (!me.terminal?.stream) throw new Error("Upgrade the host to support native CLI sessions");
      if (options["--local-ui"]) {
        if (!["codex", "opencode"].includes(command) || !me.nativeUi?.includes(command)) throw new Error("This host does not support this provider’s local UI. Other providers retain their native cloud terminal.");
        (command === "codex" ? validateNativeCodexArgs : validateNativeOpenCodeArgs)(args);
        if (!options["--detach"]) await (command === "codex" ? checkNativeCodex : checkNativeOpenCode)();
      }
      const projectId = String(options["--project"] ?? config.projectId ?? me.projects[0]?.id ?? "");
      if (!me.projects.some(p => p.id === projectId)) throw new Error("Unknown project. Use infinite projects");
      const requestId = randomUUID();
      console.error(`[Infinite] Launch ${requestId} on ${config.origin} · project ${projectId}`);
      progress.start(`Starting ${providerNames[command]} on ${new URL(config.origin).hostname}`);
      session = await api.json<Session>("/sessions", { requestId, provider: command, projectId, title: String(options["--title"] ?? `${command} session`), nativeArgs: args, ...(options["--local-ui"] ? { localUi: true } : {}) });
      progress.stop();
      if (options["--detach"]) { console.log(session.id); return true; }
    } else {
      progress.start("Loading sessions");
      const { sessions } = await api.json<{ sessions: Session[] }>("/sessions");
      progress.stop();
      session = await selectSession(sessions, positional[0], command === "monitor");
    }
    if (session.runtime?.nativeUi && command !== "monitor") {
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
