import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { Signal } from "@infinite/attention";
import type { AgentProfile, InputControl } from "./types.js";
import { NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";
import { connectCodexEnvironments, type CodexEnvironmentClient, type CodexExecutor } from "./codex-environment.js";

/** The native frontend is opt-in; ordinary PTY launches retain unrestricted argv passthrough. */
export function validateNativeCodexArgs(args: string[], initialPrompt = "", allowEmpty = false) {
  const values = new Set(["-m", "--model", "-c", "--config", "-a", "--ask-for-approval", "-s", "--sandbox"]);
  const flags = new Set(["--no-alt-screen", "--search"]);
  let prompt: string | undefined;
  const launch: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (values.has(value)) {
      if (++i >= args.length) throw new Error(`Missing value for ${value}`);
      launch.push(value, args[i]);
    } else if (flags.has(value) || (value.includes("=") && values.has(value.split("=", 1)[0]))) launch.push(value);
    else if (value === "--" && i === args.length - 2 && prompt === undefined) prompt = args[++i];
    else if (!value.startsWith("-") && prompt === undefined) prompt = value;
    else throw new Error("Local Codex UI supports a prompt, --model, --config, --ask-for-approval, --sandbox, --search and --no-alt-screen. Use terminal mode for other native arguments.");
  }
  // Codex does not materialize an empty thread for a second native frontend.
  // Require a real user prompt instead of injecting one or manufacturing history.
  if (!(prompt ?? initialPrompt).trim()) {
    if (allowEmpty) return launch;
    throw new Error("Cloud Codex's local interface requires an initial prompt. Use infinite codex to start in your laptop project, or --cloud without --local-ui for a cloud terminal.");
  }
  // A prompt such as "login" is text, never a provider administration command.
  return [...launch, "--", prompt ?? initialPrompt];
}

type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: unknown };
type Attachment = { authority: InputControl; used: boolean };
type Executor = CodexExecutor;

/** A prepared host uses the qualified backend automatically; wrapped profiles
 * select their backend explicitly so a different Unix identity is never bypassed. */
function appServerLaunch(profile: AgentProfile) {
  if (profile.appServerCommand) return { command: profile.appServerCommand, args: profile.appServerArgs ?? [] };
  const prepared = fileURLToPath(new URL("../../../.local/codex-handoff/bin/codex-app-server", import.meta.url));
  if (profile.command === "codex" && profile.args.length === 0 && existsSync(prepared)) return { command: prepared, args: [] };
  return { command: profile.command, args: [...profile.args, "app-server"] };
}

/**
 * One cloud backend and one cloud observer TUI per Infinite session. Provider credentials
 * never leave this process. Every local frontend frame is fenced by the worker's lease.
 */
export async function startNativeCodex(options: {
  profile: AgentProfile; cwd: string; env: Record<string, string>;
  execution?: Executor;
  onExecutionUnavailable?: () => void;
  checkControl: (authority: InputControl) => void;
  onThread: (id: string) => void;
  onExit: () => void;
  onSignal: (signal: Signal) => void;
  noAltScreen: boolean;
  record: (method: string) => void;
}) {
  const token = randomBytes(32).toString("hex");
  const observerToken = randomBytes(32).toString("hex");
  const attachments = new Map<string, Attachment>();
  let threadId: string | undefined, ready = false, stopped = false;
  let lastMessage: string | undefined;
  let execution = options.execution, selecting = false;
  let environments: CodexEnvironmentClient | undefined;
  let child: ChildProcess | undefined;
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false });
  const upstreams = new Set<WebSocket>();
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    for (const socket of [...sockets.clients, ...upstreams]) socket.terminate();
    sockets.close(); http.close();
    child?.kill("SIGTERM");
    attachments.clear();
    environments?.close();
  };
  try {
    const backend = appServerLaunch(options.profile);
    child = spawn(backend.command, [...backend.args, "--listen", "ws://127.0.0.1:0",
      "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(token).digest("hex")], {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", () => { if (!stopped) { shutdown(); options.onExit(); } });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("Codex backend did not become ready")), 15000);
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer); child!.stdout!.off("data", read); child!.stderr!.off("data", read);
        child!.off("error", failed); child!.off("exit", exited);
        if (error) reject(error); else resolve(url!);
      };
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16384);
        const match = output.match(/listening on: (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) finish(undefined, match[1]);
      };
      const failed = () => finish(new Error("Could not launch Codex backend"));
      const exited = () => finish(new Error("Codex backend exited during startup"));
      child!.stdout!.on("data", read); child!.stderr!.on("data", read);
      child!.once("error", failed); child!.once("exit", exited);
    });
    // Continue draining diagnostics; they can contain local paths and are not public records.
    child.stdout!.resume(); child.stderr!.resume();
    if (execution) {
      environments = await connectCodexEnvironments({ endpoint, token, onDisconnect: options.onExecutionUnavailable });
      await environments.register(execution);
    }
    http.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      const credential = req.headers.authorization?.match(/^Bearer ([a-f\d]{64})$/)?.[1];
      const observer = credential === observerToken;
      const attachment = credential ? attachments.get(credential) : undefined;
      try {
        if (req.headers.origin || req.url !== "/" || sockets.clients.size >= 8 || (!observer && (!attachment || attachment.used || !ready))) throw new Error("Denied");
        if (attachment) { options.checkControl(attachment.authority); attachment.used = true; }
      } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      sockets.handleUpgrade(req, socket, head, frontend => {
        const upstream = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: 10000 });
        upstreams.add(upstream);
        const queue: string[] = [];
        let bytes = 0, startRequest: number | string | undefined;
        const checkpointRequest = `infinite-checkpoint-${randomBytes(16).toString("hex")}`;
        let checking = false;
        const pending = new Map<number | string, string>();
        const close = () => { frontend.terminate(); upstream.terminate(); };
        const authority = () => { if (!observer) options.checkControl(attachment!.authority); };
        const timer = setInterval(() => { try { authority(); } catch { close(); } }, 1000);
        const send = (target: WebSocket, data: string) => {
          if (target.bufferedAmount + Buffer.byteLength(data) > NATIVE_MAX_BUFFERED) throw new Error("Native connection is too slow");
          target.send(data);
        };
        frontend.on("close", () => { clearInterval(timer); upstream.close(); if (credential && !observer) attachments.delete(credential); });
        upstream.on("close", () => { clearInterval(timer); upstreams.delete(upstream); frontend.close(); });
        frontend.on("error", close); upstream.on("error", close);
        frontend.on("message", (data, binary) => {
          try {
            authority();
            if (binary) throw new Error("Expected native JSON");
            const message = JSON.parse(data.toString()) as Message;
            const method = message.method, params = message.params;
            const refuse = (reason = "This Infinite attachment is pinned to one conversation. Start or switch sessions through Infinite.") => {
              if (message.id !== undefined) send(frontend, JSON.stringify({ id: message.id, error: { code: -32600, message: reason } }));
            };
            if (method === "thread/start") {
              if (!observer || threadId || startRequest !== undefined || message.id === undefined) { refuse(); return; }
              // The installed app-server cannot hydrate the TUI's paginated default.
              // Legacy history supports same-thread rejoin once a user message exists.
              message.params = { ...params, historyMode: "legacy" };
              startRequest = message.id;
            } else if (method === "thread/fork" || method === "thread/delete" || method === "thread/archive" || method === "thread/unarchive") { refuse(); return; }
            if (params?.threadId !== undefined && params.threadId !== threadId) { refuse(); return; }
            if (method === "thread/resume" && (params?.path || params?.history || !threadId || params?.threadId !== threadId)) { refuse(); return; }
            if (execution && method) {
              if (selecting && ["thread/start", "thread/resume", "thread/settings/update", "turn/start", "turn/settings/update"].includes(method)) { refuse("Execution is moving to the cloud. Retry after handoff completes."); return; }
              const executor = execution;
              if (method === "initialize") message.params = { ...params, capabilities: { ...params?.capabilities, experimentalApi: true } };
              if (method === "thread/start" || method === "turn/start") {
                message.params = { ...message.params, cwd: executor.cwd, runtimeWorkspaceRoots: executor.roots,
                  environments: [{ environmentId: executor.environmentId, cwd: executor.cwd, runtimeWorkspaceRoots: executor.roots }] };
              }
              // Resume/settings cwd overrides can reset Codex's sticky environment to
              // the app-server host. The session's selected workspace stays authoritative.
              if (method === "thread/resume" || method === "thread/settings/update") {
                message.params = { ...params };
                delete message.params.cwd;
                delete message.params.runtimeWorkspaceRoots;
                delete message.params.environments;
              }
              if (method === "environment/add" || method === "environment/remove" ||
                  (method === "environment/info" && params?.environmentId !== executor.environmentId) ||
                  /^(fs|process)\//.test(method) ||
                  /^command\/exec(?:\/|$)/.test(method) || /^fuzzyFileSearch(?:\/|$)/.test(method) ||
                  method === "gitDiffToRemote" || method === "thread/shellCommand" ||
                  (method === "turn/settings/update" && params?.environments !== undefined)) {
                refuse("This workspace action is unavailable for laptop execution. Use the conversation's laptop tools; the cloud workspace will not be substituted."); return;
              }
            }
            if (method && message.id !== undefined) {
              if (pending.size >= 1024) throw new Error("Too many pending native requests");
              pending.set(message.id, method);
            }
            if (!observer && method && !/^(initialize|.*\/read|.*\/list|thread\/resume)$/.test(method)) options.record(method);
            const text = JSON.stringify(message);
            if (upstream.readyState === WebSocket.OPEN) send(upstream, text);
            else if (upstream.readyState === WebSocket.CONNECTING) { bytes += Buffer.byteLength(text); if (bytes > 256 * 1024) throw new Error("Native queue is full"); queue.push(text); }
            else close();
          } catch { close(); }
        });
        upstream.on("open", () => { try { for (const data of queue) { authority(); send(upstream, data); } queue.length = 0; bytes = 0; } catch { close(); } });
        upstream.on("message", (data, binary) => {
          try {
            if (binary) throw new Error("Expected native JSON");
            const message = JSON.parse(data.toString()) as Message;
            if (message.id === checkpointRequest) {
              checking = false;
              ready = !message.error && message.result?.thread?.id === threadId;
              return;
            }
            if (observer && startRequest !== undefined && message.id === startRequest && message.result?.thread?.id) {
              if (threadId && threadId !== message.result.thread.id) throw new Error("Native conversation changed");
              threadId = message.result.thread.id;
              environments?.observe({ method: "thread/started", params: { thread: { id: threadId } } });
              options.onThread(threadId!);
            }
            if (observer && threadId && !ready && !checking && ["turn/started", "turn/completed"].includes(message.method ?? "")) {
              checking = true;
              send(upstream, JSON.stringify({ id: checkpointRequest, method: "thread/read", params: { threadId, includeTurns: true } }));
            }
            if (observer) environments?.observe(message);
            // Only the persistent observer records provider events, so extra UIs do
            // not duplicate timeline entries. A provider turn ending is not task completion.
            if (observer && message.params?.threadId === threadId) {
              if (message.method === "turn/started") { lastMessage = undefined; options.onSignal({ kind: "turn-start" }); }
              if (message.method === "item/completed" && message.params?.item?.type === "agentMessage" && typeof message.params.item.text === "string")
                lastMessage = message.params.item.text.slice(0, 4000);
              if (message.method === "turn/completed") options.onSignal({ kind: "turn-end", message: message.params?.turn?.status === "interrupted" ? "Turn interrupted" : lastMessage, failed: message.params?.turn?.status === "failed" });
            }
            const method = message.id === undefined ? undefined : pending.get(message.id);
            if (message.id !== undefined && !message.method) pending.delete(message.id);
            if (method === "thread/list" && Array.isArray(message.result?.data)) {
              message.result.data = message.result.data.filter((thread: { id: string }) => thread.id === threadId);
              message.result.nextCursor = null;
            }
            if (method === "thread/loaded/list" && Array.isArray(message.result?.data)) message.result.data = message.result.data.filter((id: string) => id === threadId);
            if (frontend.readyState === WebSocket.OPEN) send(frontend, JSON.stringify(message));
          } catch { close(); }
        });
      });
    });
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/`;
    return {
      url, observerToken,
      info: () => ({ provider: "codex" as const, sessionId: ready ? threadId : undefined, noAltScreen: options.noAltScreen }),
      connect(authority: InputControl) {
        options.checkControl(authority);
        if (!ready || !threadId || stopped) throw new Error("Native frontend is not ready");
        // Unused credentials are bounded and valid only while their control lease survives.
        for (const [key, value] of attachments) { try { options.checkControl(value.authority); } catch { attachments.delete(key); } }
        if (attachments.size >= 32) throw new Error("Too many native attachments");
        const credential = randomBytes(32).toString("hex");
        attachments.set(credential, { authority, used: false });
        return { url, token: credential, sessionId: threadId };
      },
      supportsExecutionSelection: environments?.supportsSelection ?? false,
      async selectExecution(next: Executor, release: () => void) {
        if (!environments || !threadId || selecting || stopped) throw new Error("Execution selection is unavailable");
        selecting = true;
        try {
          const current = environments.current(threadId);
          if (!current.observed) throw new Error("The provider conversation has not been observed");
          const receipt = await environments.select({ threadId, turnId: current.turnId, executor: next,
            releaseHeldOperation: () => { execution = next; release(); } });
          return receipt;
        } finally { selecting = false; }
      },
      stop: shutdown,
      suspend: () => { child?.kill("SIGSTOP"); },
    };
  } catch (error) { shutdown(); throw error; }
}
