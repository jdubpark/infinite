import { spawn, type ChildProcess } from "node:child_process";
import { MAX_RECORDED_MESSAGE, type TranscriptMessage } from "./transcript.js";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { Signal } from "@infinite/attention";
import type { AgentProfile, InputControl } from "./types.js";
import { NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  connectCodexEnvironments,
  openCodexEnvironmentStore,
  parseCodexUserAgentVersion,
  supportsCodexPaginatedHistory,
  type CodexEnvironmentClient,
  type CodexEnvironmentPersistenceOptions,
  type CodexEnvironmentStore,
  type CodexExecutor,
  type CodexSemver,
} from "./codex-environment.js";
export { CODEX_ENVIRONMENT_STATE_FILE, parseCodexUserAgentVersion, supportsCodexPaginatedHistory, type CodexSemver };

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
  if (!(prompt ?? initialPrompt).trim()) {
    if (allowEmpty) return launch;
    throw new Error("Cloud Codex's local interface requires an initial prompt. Use infinite --laptop codex to start in your laptop project, or omit --local-ui for a cloud terminal.");
  }
  return [...launch, "--", prompt ?? initialPrompt];
}

export function nativeCodexObserverArgs(args: string[], initialPrompt = "", allowEmpty = false, restoredThreadId?: string) {
  if (!restoredThreadId) return validateNativeCodexArgs(args, initialPrompt, allowEmpty);
  const values = new Set(["-m", "--model", "-c", "--config", "-a", "--ask-for-approval", "-s", "--sandbox"]);
  const flags = new Set(["--no-alt-screen", "--search"]);
  const launch: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (values.has(value)) {
      if (++i < args.length) launch.push(value, args[i]);
    } else if (flags.has(value) || (value.includes("=") && values.has(value.split("=", 1)[0]))) {
      launch.push(value);
    } else if (value === "--") {
      break;
    }
  }
  return [...launch, "resume", restoredThreadId];
}

export function prepareCodexWorkerExecution(options: {
  file: string;
  key: Buffer;
  scope: string;
  workspace: { cwd: string; roots: string[] };
  resumeThreadId?: string;
}): {
  environmentState: CodexEnvironmentPersistenceOptions;
  environmentId?: string;
  resumeThreadId?: string;
} {
  const environmentState: CodexEnvironmentPersistenceOptions = {
    file: options.file,
    key: options.key,
    scope: options.scope,
  };
  const loaded = openCodexEnvironmentStore(environmentState).read();
  if (loaded.state === "unreadable") return { environmentState };
  if (loaded.state === "missing") {
    return {
      environmentState,
      ...(options.resumeThreadId ? { resumeThreadId: options.resumeThreadId } : {}),
    };
  }
  const threadIds = Object.keys(loaded.record.threads);
  const savedThreadId = options.resumeThreadId ?? (threadIds.length === 1 ? threadIds[0] : undefined);
  if (!savedThreadId) return { environmentState };
  const entry = loaded.record.threads[savedThreadId];
  const normalizedCwd = normalize(options.workspace.cwd);
  const normalizedRoots = [...new Set(options.workspace.roots.map(root => normalize(root)))];
  const rootsMatch = entry?.status === "verified" &&
    entry.placement.runtimeWorkspaceRoots.length === normalizedRoots.length &&
    normalizedRoots.every(root => entry.placement.runtimeWorkspaceRoots.includes(root));
  if (entry?.status === "verified" && entry.placement.cwd === normalizedCwd && rootsMatch) {
    return {
      environmentState,
      environmentId: entry.placement.environmentId,
      resumeThreadId: savedThreadId,
    };
  }
  return { environmentState, resumeThreadId: savedThreadId };
}

type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: unknown };
type Attachment = { authority: InputControl; used: boolean };
type Executor = CodexExecutor;
type PendingRequest = { method: string; generation?: number; trackedResume?: boolean };
type ThreadHistoryMode = "paginated" | "legacy";
type PendingStart = {
  id: number | string;
  canFallbackToLegacy: boolean;
  requestedHistoryMode: ThreadHistoryMode;
  fallbackRetryMessage?: Message;
};
type CheckpointStep = "legacy-read" | "paginated-turns" | "paginated-env";

const THREAD_SCOPED_READ_METHODS = new Set([
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/items/read",
  "thread/timeline/list",
]);
const UNSUPPORTED_PAGINATED_ERROR_PATTERNS = [
  /paginated threads require thread\/turns\/list and thread\/items\/list support/i,
  /\binvalid_history_mode\b/i,
  /\bpaginated\b[^.\n]*\b(?:not supported|unsupported|requires?\s+thread\/turns\/list)/i,
  /\b(?:not supported|unsupported|does not support)\b[^.\n]*\bpaginated\b/i,
  /\b(?:historyMode|history_mode|history mode)\b[^.\n]*\b(?:not supported|unsupported|unknown field|unknown variant|invalid|legacy)/i,
  /\b(?:unknown field|unknown variant|unsupported|invalid|requires?)\b[^.\n]*\b(?:historyMode|history_mode|history mode)\b/i,
];

export function isUnsupportedPaginatedHistoryError(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const row = error as Record<string, unknown>;
  if (row.code !== -32600 && row.code !== -32602) return false;
  const candidates: string[] = [];
  if (typeof row.message === "string") candidates.push(row.message);
  if (typeof row.data === "string") candidates.push(row.data);
  else if (row.data && typeof row.data === "object" && !Array.isArray(row.data)) {
    const data = row.data as Record<string, unknown>;
    for (const key of ["code", "error", "reason", "message"]) {
      if (typeof data[key] === "string") candidates.push(data[key]);
    }
  }
  return candidates.some(text => UNSUPPORTED_PAGINATED_ERROR_PATTERNS.some(pattern => pattern.test(text)));
}

function appServerLaunch(profile: AgentProfile) {
  if (profile.appServerCommand) return { command: profile.appServerCommand, args: profile.appServerArgs ?? [] };
  const prepared = fileURLToPath(new URL("../../../.local/codex-handoff/bin/codex-app-server", import.meta.url));
  if (profile.command === "codex" && profile.args.length === 0 && existsSync(prepared)) return { command: prepared, args: [] };
  return { command: profile.command, args: [...profile.args, "app-server"] };
}

export function nativeItemMessage(item: unknown): TranscriptMessage | undefined {
  if (!item || typeof item !== "object") return undefined;
  const row = item as Record<string, unknown>;
  const id = typeof row.id === "string" && row.id ? row.id : undefined;
  if (!id) return undefined;
  const text = (value: unknown) => typeof value === "string" ? value.trim()
    : Array.isArray(value) ? value.map(block => block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join("\n").trim() : "";
  switch (row.type) {
    case "agentMessage": { const body = text(row.text); return body ? { id, role: "assistant", text: body.slice(0, MAX_RECORDED_MESSAGE) } : undefined; }
    case "userMessage": { const body = text(row.content ?? row.text); return body ? { id, role: "user", text: body.slice(0, MAX_RECORDED_MESSAGE) } : undefined; }
    case "commandExecution": { const command = text(row.command); return command ? { id, role: "tool", toolName: "shell", text: command.slice(0, 2000) } : undefined; }
    case "fileChange": {
      const paths = Array.isArray(row.changes) ? row.changes.map(change => change && typeof change === "object" ? (change as { path?: unknown }).path : undefined).filter((p): p is string => typeof p === "string") : [];
      return { id, role: "tool", toolName: "edit", text: (paths.join(", ") || "file change").slice(0, 2000) };
    }
    case "mcpToolCall": { const tool = text(row.tool) || text(row.name); return { id, role: "tool", toolName: tool || "tool", text: (tool || "tool").slice(0, 2000) }; }
    default: return undefined;
  }
}

export async function startNativeCodex(options: {
  profile: AgentProfile; cwd: string; env: Record<string, string>;
  execution?: Executor;
  resumeThreadId?: string;
  environmentState?: CodexEnvironmentPersistenceOptions;
  environmentStore?: CodexEnvironmentStore;
  onExecutionUnavailable?: () => void;
  onProviderRestart?: (phase: "restarting" | "restored" | "fenced", threadId?: string) => void;
  checkControl: (authority: InputControl) => void;
  onThread: (id: string) => void;
  onExit: () => void;
  onSignal: (signal: Signal) => void;
  onMessage?: (message: TranscriptMessage) => void;
  noAltScreen: boolean;
  record: (method: string) => void;
}) {
  let token = randomBytes(32).toString("hex");
  const observerToken = randomBytes(32).toString("hex");
  const attachments = new Map<string, Attachment>();
  let endpoint = "";
  let threadId: string | undefined = options.resumeThreadId, ready = false, stopped = false;
  let restarting = false, providerRestarts = 0;
  let lastMessage: string | undefined;
  let execution = options.execution, selecting = false;
  let environments: CodexEnvironmentClient | undefined;
  let child: ChildProcess | undefined;
  let restoredClean = true;
  let verifyingResumes = 0;
  let backendGeneration = 0;
  let supportsPaginatedHistory = false;
  let backendCapabilitiesKnown = false;
  let activeThreadHistoryMode: ThreadHistoryMode = "legacy";
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false });
  const upstreams = new Set<WebSocket>();
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    restarting = false;
    for (const socket of [...sockets.clients, ...upstreams]) socket.terminate();
    sockets.close(); http.close();
    child?.kill("SIGTERM");
    attachments.clear();
    environments?.close();
  };
  const backend = appServerLaunch(options.profile);
  const handleBackendExit = () => {
    if (stopped || restarting) return;
    const recoverable = Boolean(execution && threadId && (options.environmentState || options.environmentStore) && providerRestarts < 5 && !selecting);
    if (!recoverable) {
      shutdown();
      options.onExit();
      return;
    }
    providerRestarts += 1;
    restarting = true;
    ready = false;
    options.onProviderRestart?.("restarting");
    environments?.close();
    environments = undefined;
    for (const socket of [...sockets.clients, ...upstreams]) socket.terminate();
    upstreams.clear();
    attachments.clear();
    void (async () => {
      try {
        const outcome = await bootProvider(threadId);
        restarting = false;
        if (stopped) return;
        options.onProviderRestart?.(outcome === "restored" ? "restored" : "fenced", outcome === "restored" ? threadId : undefined);
      } catch {
        restarting = false;
        if (!stopped) {
          shutdown();
          options.onExit();
        }
      }
    })();
  };
  const bootProvider = async (targetThreadId?: string): Promise<"started" | "restored" | "fenced"> => {
    backendGeneration += 1;
    supportsPaginatedHistory = false;
    backendCapabilitiesKnown = false;
    const nextToken = randomBytes(32).toString("hex");
    const spawned = spawn(backend.command, [...backend.args, "--listen", "ws://127.0.0.1:0",
      "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(nextToken).digest("hex")], {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    const nextEndpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("Codex backend did not become ready")), 15000);
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer); spawned.stdout!.off("data", read); spawned.stderr!.off("data", read);
        spawned.off("error", failed); spawned.off("exit", exited);
        if (error) reject(error); else resolve(url!);
      };
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16384);
        const match = output.match(/listening on: (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) finish(undefined, match[1]);
      };
      const failed = () => finish(new Error("Could not launch Codex backend"));
      const exited = () => finish(new Error("Codex backend exited during startup"));
      spawned.stdout!.on("data", read); spawned.stderr!.on("data", read);
      spawned.once("error", failed); spawned.once("exit", exited);
    });
    if (stopped) {
      spawned.kill("SIGTERM");
      throw new Error("Codex native backend stopped during startup");
    }
    spawned.stdout!.resume(); spawned.stderr!.resume();
    token = nextToken;
    endpoint = nextEndpoint;
    spawned.on("exit", () => { if (!stopped && child === spawned) handleBackendExit(); });
    if (execution) {
      const nextEnvironments = await connectCodexEnvironments({
        endpoint: nextEndpoint,
        token: nextToken,
        onDisconnect: () => { if (!restarting) options.onExecutionUnavailable?.(); },
        ...(options.environmentState ? { persistence: options.environmentState } : {}),
        ...(options.environmentStore ? { store: options.environmentStore } : {}),
      });
      environments = nextEnvironments;
      supportsPaginatedHistory = supportsCodexPaginatedHistory(nextEnvironments.initializeResult);
      backendCapabilitiesKnown = true;
      await nextEnvironments.register(execution);
      if (targetThreadId) {
        try {
          await nextEnvironments.restoreThread(targetThreadId, { excludeTurns: supportsPaginatedHistory });
          ready = true;
          restoredClean = true;
          options.onThread(targetThreadId);
          return "restored";
        } catch {
          ready = false;
          restoredClean = false;
          options.onExecutionUnavailable?.();
          return "fenced";
        }
      }
    }
    return "started";
  };
  try {
    await bootProvider(options.resumeThreadId);
    http.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      const credential = req.headers.authorization?.match(/^Bearer ([a-f\d]{64})$/)?.[1];
      const observer = credential === observerToken;
      const attachment = credential ? attachments.get(credential) : undefined;
      try {
        if (stopped || restarting || !endpoint || req.headers.origin || req.url !== "/" || sockets.clients.size >= 8 || (!observer && (!attachment || attachment.used || !ready))) throw new Error("Denied");
        if (attachment) { options.checkControl(attachment.authority); attachment.used = true; }
      } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      sockets.handleUpgrade(req, socket, head, frontend => {
        const socketGeneration = backendGeneration;
        const upstream = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: 10000 });
        upstreams.add(upstream);
        const queue: string[] = [];
        let bytes = 0;
        let pendingStart: PendingStart | undefined;
        let endStartupDiscovery: (() => void) | undefined;
        let holdingFrontend = 0;
        const heldUpstream: string[] = [];
        let heldUpstreamBytes = 0;
        let socketPendingResumes = 0;
        const checkpointRequest = `infinite-checkpoint-${randomBytes(16).toString("hex")}`;
        let checking = false;
        let recheckCheckpoint = false;
        let checkpointStep: CheckpointStep | undefined;
        let checkpointGeneration: number | undefined;
        const pending = new Map<number | string, PendingRequest>();
        const releaseDiscovery = () => {
          const end = endStartupDiscovery;
          endStartupDiscovery = undefined;
          end?.();
        };
        const releaseAllSocketResumes = () => {
          if (socketPendingResumes > 0) {
            verifyingResumes = Math.max(0, verifyingResumes - socketPendingResumes);
            socketPendingResumes = 0;
          }
        };
        const finishSocketResume = () => {
          if (socketPendingResumes > 0) {
            socketPendingResumes -= 1;
            verifyingResumes = Math.max(0, verifyingResumes - 1);
          }
        };
        const close = () => {
          releaseDiscovery();
          releaseAllSocketResumes();
          holdingFrontend = 0;
          heldUpstream.length = 0;
          heldUpstreamBytes = 0;
          frontend.terminate();
          upstream.terminate();
        };
        const authority = () => { if (!observer) options.checkControl(attachment!.authority); };
        const timer = setInterval(() => { try { authority(); } catch { close(); } }, 1000);
        const send = (target: WebSocket, data: string) => {
          if (target.bufferedAmount + Buffer.byteLength(data) > NATIVE_MAX_BUFFERED) throw new Error("Native connection is too slow");
          target.send(data);
        };
        const deliverFrontend = (payload: string) => {
          if (holdingFrontend > 0) {
            const nextBytes = heldUpstreamBytes + Buffer.byteLength(payload);
            if (nextBytes > NATIVE_MAX_BUFFERED) {
              close();
              return;
            }
            heldUpstreamBytes = nextBytes;
            heldUpstream.push(payload);
            return;
          }
          if (frontend.readyState === WebSocket.OPEN) send(frontend, payload);
        };
        const drainHeld = (firstPayload?: string) => {
          try {
            if (stopped || frontend.readyState !== WebSocket.OPEN) {
              heldUpstream.length = 0;
              heldUpstreamBytes = 0;
              return;
            }
            if (firstPayload !== undefined) send(frontend, firstPayload);
            if (holdingFrontend > 0) return;
            const buffered = heldUpstream.splice(0, heldUpstream.length);
            heldUpstreamBytes = 0;
            for (const frame of buffered) {
              if (frontend.readyState !== WebSocket.OPEN) break;
              send(frontend, frame);
            }
          } catch {
            close();
          }
        };
        frontend.on("close", () => { clearInterval(timer); releaseDiscovery(); releaseAllSocketResumes(); upstream.close(); if (credential && !observer) attachments.delete(credential); });
        upstream.on("close", () => { clearInterval(timer); releaseDiscovery(); releaseAllSocketResumes(); upstreams.delete(upstream); frontend.close(); });
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
            let pendingStartCandidate: { canFallbackToLegacy: boolean; requestedHistoryMode: ThreadHistoryMode } | undefined;
            if (method === "thread/start") {
              if (!observer || threadId || pendingStart !== undefined || message.id === undefined) { refuse(); return; }
              if (execution && selecting) { refuse("Execution is moving to the cloud. Retry after handoff completes."); return; }
              if (params?.threadId !== undefined && params.threadId !== threadId) { refuse(); return; }
              if (execution && environments) {
                try {
                  endStartupDiscovery = environments.beginStartupDiscovery(execution.environmentId);
                } catch (error) {
                  refuse(error instanceof Error ? error.message : "Execution environment startup is unavailable");
                  return;
                }
              }
              const explicitHistoryMode = params?.historyMode;
              const useLegacyOverride = !supportsPaginatedHistory;
              if (useLegacyOverride) {
                message.params = { ...params, historyMode: "legacy" };
              }
              pendingStartCandidate = {
                canFallbackToLegacy: !useLegacyOverride && (explicitHistoryMode === undefined || explicitHistoryMode === null),
                requestedHistoryMode: useLegacyOverride || explicitHistoryMode === "legacy" ? "legacy" : "paginated",
              };
            } else if (method === "thread/fork" || method === "thread/delete" || method === "thread/archive" || method === "thread/unarchive") { refuse(); return; }
            if (params?.threadId !== undefined && params.threadId !== threadId) { refuse(); return; }
            if (method && THREAD_SCOPED_READ_METHODS.has(method) && (!threadId || params?.threadId !== threadId)) { refuse(); return; }
            if (method === "thread/resume" && (params?.path || params?.history || !threadId || params?.threadId !== threadId)) { refuse(); return; }
            if (execution && method) {
              if (selecting && ["thread/start", "thread/resume", "thread/settings/update", "turn/start", "turn/settings/update"].includes(method)) { refuse("Execution is moving to the cloud. Retry after handoff completes."); return; }
              const executor = execution;
              if (method === "turn/start" && threadId && environments) {
                if (verifyingResumes > 0) {
                  refuse("Execution placement verification is in progress; retry after thread resume completes.");
                  return;
                }
                const decision = environments.checkDispatch({
                  threadId,
                  environmentId: executor.environmentId,
                  cwd: executor.cwd,
                  roots: executor.roots,
                });
                if (!decision.allowed) { refuse(decision.reason); return; }
              }
              if (method === "initialize") message.params = { ...params, capabilities: { ...params?.capabilities, experimentalApi: true } };
              if (method === "thread/start" || method === "turn/start") {
                message.params = { ...message.params, cwd: executor.cwd, runtimeWorkspaceRoots: executor.roots,
                  environments: [{ environmentId: executor.environmentId, cwd: executor.cwd, runtimeWorkspaceRoots: executor.roots }] };
              }
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
            if (pendingStartCandidate && message.id !== undefined) {
              pendingStart = {
                id: message.id,
                canFallbackToLegacy: pendingStartCandidate.canFallbackToLegacy,
                requestedHistoryMode: pendingStartCandidate.requestedHistoryMode,
                ...(pendingStartCandidate.canFallbackToLegacy
                  ? { fallbackRetryMessage: { ...message, params: { ...message.params, historyMode: "legacy" } } }
                  : {}),
              };
            }
            if (method && message.id !== undefined) {
              if (pending.size >= 1024) throw new Error("Too many pending native requests");
              const currentView = environments && threadId ? environments.placement(threadId) : undefined;
              const observedGeneration = currentView?.status === "verified" ? currentView.placement.generation : undefined;
              const trackedResume = method === "thread/resume" && Boolean(execution && environments && threadId);
              if (trackedResume) {
                verifyingResumes += 1;
                socketPendingResumes += 1;
              }
              pending.set(message.id, {
                method,
                ...(observedGeneration !== undefined ? { generation: observedGeneration } : {}),
                ...(trackedResume ? { trackedResume: true } : {}),
              });
            }
            if (!observer && method && !/^(initialize|.*\/read|.*\/list|thread\/resume)$/.test(method)) options.record(method);
            const text = JSON.stringify(message);
            if (upstream.readyState === WebSocket.OPEN) send(upstream, text);
            else if (upstream.readyState === WebSocket.CONNECTING) { bytes += Buffer.byteLength(text); if (bytes > 256 * 1024) throw new Error("Native queue is full"); queue.push(text); }
            else close();
          } catch { close(); }
        });
        const startCheckpoint = () => {
          if (!threadId || upstream.readyState !== WebSocket.OPEN) return;
          checking = true;
          recheckCheckpoint = false;
          const view = environments ? environments.placement(threadId) : undefined;
          checkpointGeneration = view?.status === "verified" ? view.placement.generation : undefined;
          if (activeThreadHistoryMode === "paginated") {
            checkpointStep = "paginated-turns";
            send(upstream, JSON.stringify({ id: checkpointRequest, method: "thread/turns/list", params: { threadId, limit: 1 } }));
          } else {
            checkpointStep = "legacy-read";
            send(upstream, JSON.stringify({ id: checkpointRequest, method: "thread/read", params: { threadId, includeTurns: true } }));
          }
        };
        const maybeRecheckCheckpoint = () => {
          if (ready) {
            recheckCheckpoint = false;
            return;
          }
          if (!checking && recheckCheckpoint && threadId && upstream.readyState === WebSocket.OPEN) {
            recheckCheckpoint = false;
            startCheckpoint();
          }
        };
        const verifyCheckpointEnvironment = (thread: Record<string, any> | undefined, observedCheckpointGen: number | undefined, retryStep: "legacy-read" | "paginated-env") => {
          if (!environments || !execution || !threadId) return;
          const view = environments.placement(threadId);
          if (!restoredClean || view.status !== "verified") {
            ready = false;
          } else if (observedCheckpointGen !== undefined && observedCheckpointGen !== view.placement.generation) {
            ready = false;
            if (upstream.readyState === WebSocket.OPEN) {
              checking = true;
              checkpointStep = retryStep;
              checkpointGeneration = view.placement.generation;
              send(upstream, JSON.stringify({
                id: checkpointRequest,
                method: "thread/read",
                params: { threadId, includeTurns: retryStep === "legacy-read" },
              }));
            }
          } else if (!Array.isArray(thread?.environments)) {
            ready = false;
          } else {
            try { environments.assertObservedEnvironments(threadId, thread.environments); } catch { ready = false; }
          }
        };
        upstream.on("open", () => { try { for (const data of queue) { authority(); send(upstream, data); } queue.length = 0; bytes = 0; } catch { close(); } });
        upstream.on("message", (data, binary) => {
          try {
            if (binary) throw new Error("Expected native JSON");
            const message = JSON.parse(data.toString()) as Message;
            if (message.id === checkpointRequest && !message.method) {
              const step = checkpointStep;
              const observedCheckpointGen = checkpointGeneration;
              checkpointStep = undefined;
              checkpointGeneration = undefined;
              if (step === "paginated-turns") {
                const hasPersistedTurns = !message.error && Array.isArray(message.result?.data) && message.result.data.length > 0;
                if (!hasPersistedTurns) {
                  checking = false;
                  ready = false;
                  maybeRecheckCheckpoint();
                  return;
                }
                if (environments && execution && threadId) {
                  const view = environments.placement(threadId);
                  if (!restoredClean || view.status !== "verified" || upstream.readyState !== WebSocket.OPEN) {
                    checking = false;
                    ready = false;
                    maybeRecheckCheckpoint();
                    return;
                  }
                  checkpointStep = "paginated-env";
                  checkpointGeneration = view.placement.generation;
                  send(upstream, JSON.stringify({ id: checkpointRequest, method: "thread/read", params: { threadId, includeTurns: false } }));
                  return;
                }
                checking = false;
                ready = true;
                recheckCheckpoint = false;
                return;
              }
              checking = false;
              const thread = message.result?.thread;
              if (step === "paginated-env") {
                ready = !message.error && thread?.id === threadId;
                if (ready) verifyCheckpointEnvironment(thread, observedCheckpointGen, "paginated-env");
                maybeRecheckCheckpoint();
                return;
              }
              ready = !message.error && thread?.id === threadId && Array.isArray(thread?.turns) && thread.turns.length > 0;
              if (ready) verifyCheckpointEnvironment(thread, observedCheckpointGen, "legacy-read");
              maybeRecheckCheckpoint();
              return;
            }
            if (observer && pendingStart !== undefined && message.id === pendingStart.id && !message.method) {
              const currentStart = pendingStart;
              if (
                message.error &&
                currentStart.canFallbackToLegacy &&
                currentStart.fallbackRetryMessage &&
                isUnsupportedPaginatedHistoryError(message.error) &&
                socketGeneration === backendGeneration &&
                upstream.readyState === WebSocket.OPEN
              ) {
                supportsPaginatedHistory = false;
                backendCapabilitiesKnown = true;
                pendingStart = {
                  id: currentStart.id,
                  canFallbackToLegacy: false,
                  requestedHistoryMode: "legacy",
                };
                send(upstream, JSON.stringify(currentStart.fallbackRetryMessage));
                return;
              }
              pendingStart = undefined;
              pending.delete(message.id);
              releaseDiscovery();
              if (message.error || typeof message.result?.thread?.id !== "string" || !message.result.thread.id) {
                deliverFrontend(JSON.stringify(message));
                return;
              }
              const startedThreadId: string = message.result.thread.id;
              if (threadId && threadId !== startedThreadId) throw new Error("Native conversation changed");
              threadId = startedThreadId;
              activeThreadHistoryMode =
                message.result.thread.historyMode === "legacy" || currentStart.requestedHistoryMode === "legacy"
                  ? "legacy"
                  : "paginated";
              environments?.observe({ method: "thread/started", params: { thread: { id: startedThreadId } } });
              if (environments && execution) {
                const startPayload = JSON.stringify(message);
                const startId = message.id;
                holdingFrontend += 1;
                void environments.confirmInitialPlacement({
                  threadId: startedThreadId,
                  executor: execution,
                  reportedEnvironments: message.result.thread.environments,
                }).then(
                  () => {
                    holdingFrontend = Math.max(0, holdingFrontend - 1);
                    if (stopped || frontend.readyState !== WebSocket.OPEN) {
                      heldUpstream.length = 0;
                      heldUpstreamBytes = 0;
                      return;
                    }
                    options.onThread(startedThreadId);
                    drainHeld(startPayload);
                  },
                  error => {
                    holdingFrontend = Math.max(0, holdingFrontend - 1);
                    heldUpstream.length = 0;
                    heldUpstreamBytes = 0;
                    ready = false;
                    if (!stopped && frontend.readyState === WebSocket.OPEN) {
                      try {
                        send(frontend, JSON.stringify({
                          id: startId,
                          error: { code: -32000, message: error instanceof Error ? error.message : "Initial execution placement verification failed" },
                        }));
                      } catch {}
                    }
                    close();
                  },
                );
                return;
              }
              options.onThread(startedThreadId);
            }
            if (observer && threadId && !ready && ["turn/started", "item/completed", "turn/completed"].includes(message.method ?? "")) {
              if (checking) recheckCheckpoint = true;
              else startCheckpoint();
            }
            if (observer) environments?.observe(message);
            if (observer && message.params?.threadId === threadId) {
              if (message.method === "turn/started") { lastMessage = undefined; options.onSignal({ kind: "turn-start" }); }
              if (message.method === "item/completed" && message.params?.item?.type === "agentMessage" && typeof message.params.item.text === "string")
                lastMessage = message.params.item.text.slice(0, 4000);
              if (message.method === "item/completed") { const item = nativeItemMessage(message.params?.item); if (item) options.onMessage?.(item); }
              if (message.method === "turn/completed" && message.params?.turn?.status === "failed" && message.params.turn.error?.codexErrorInfo === "usageLimitExceeded")
                options.onSignal({ kind: "provider-limit", limit: "usage", confidence: "corroborated", message: "Codex reported usageLimitExceeded" });
              if (message.method === "turn/completed") options.onSignal({ kind: "turn-end", message: message.params?.turn?.status === "interrupted" ? "Turn interrupted" : lastMessage, failed: message.params?.turn?.status === "failed" });
            }
            const req = message.id === undefined ? undefined : pending.get(message.id);
            if (message.id !== undefined && !message.method) pending.delete(message.id);
            const method = req?.method;
            if (!message.method && method === "initialize" && !message.error && socketGeneration === backendGeneration && !backendCapabilitiesKnown) {
              supportsPaginatedHistory = supportsCodexPaginatedHistory(message.result);
              backendCapabilitiesKnown = true;
            }
            if (!message.method && method === "thread/resume" && !message.error &&
                (message.result?.thread?.historyMode === "paginated" || message.result?.thread?.historyMode === "legacy")) {
              activeThreadHistoryMode = message.result.thread.historyMode;
            }
            if (method === "thread/resume" && req?.trackedResume) {
              if (message.error || !execution || !environments || !threadId) {
                finishSocketResume();
              } else if (Array.isArray(message.result?.thread?.environments)) {
                const view = environments.placement(threadId);
                if (!selecting && view.status === "verified" && (req.generation === undefined || req.generation === view.placement.generation)) {
                  try { environments.assertObservedEnvironments(threadId, message.result.thread.environments); } catch { ready = false; }
                }
                finishSocketResume();
              } else {
                const resumePayload = JSON.stringify(message);
                const resumeId = message.id;
                holdingFrontend += 1;
                void environments.verify(threadId).then(
                  () => {
                    holdingFrontend = Math.max(0, holdingFrontend - 1);
                    finishSocketResume();
                    drainHeld(resumePayload);
                  },
                  error => {
                    holdingFrontend = Math.max(0, holdingFrontend - 1);
                    finishSocketResume();
                    heldUpstream.length = 0;
                    heldUpstreamBytes = 0;
                    ready = false;
                    if (!stopped && frontend.readyState === WebSocket.OPEN && resumeId !== undefined) {
                      try {
                        send(frontend, JSON.stringify({
                          id: resumeId,
                          error: { code: -32000, message: error instanceof Error ? error.message : "Thread resume placement verification failed" },
                        }));
                      } catch {}
                    }
                    close();
                  },
                );
                return;
              }
            } else if (method === "thread/read" && !message.error && !selecting && environments && threadId &&
                Array.isArray(message.result?.thread?.environments)) {
              const view = environments.placement(threadId);
              if (view.status === "verified" && req?.generation === view.placement.generation) {
                try { environments.assertObservedEnvironments(threadId, message.result.thread.environments); } catch { ready = false; }
              }
            }
            if (method === "thread/list" && Array.isArray(message.result?.data)) {
              message.result.data = message.result.data.filter((thread: { id: string }) => thread.id === threadId);
              message.result.nextCursor = null;
            }
            if (method === "thread/loaded/list" && Array.isArray(message.result?.data)) message.result.data = message.result.data.filter((id: string) => id === threadId);
            deliverFrontend(JSON.stringify(message));
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
        for (const [key, value] of attachments) { try { options.checkControl(value.authority); } catch { attachments.delete(key); } }
        if (attachments.size >= 32) throw new Error("Too many native attachments");
        const credential = randomBytes(32).toString("hex");
        attachments.set(credential, { authority, used: false });
        return { url, token: credential, sessionId: threadId };
      },
      get supportsExecutionSelection() {
        return (environments?.supportsSelection ?? false) && restoredClean;
      },
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
      async reconcileExecution(next: Executor, release?: () => void) {
        if (!environments || !threadId || selecting || stopped) throw new Error("Execution reconciliation is unavailable");
        selecting = true;
        try {
          const receipt = await environments.reconcileThread({
            threadId,
            executor: next,
            releaseHeldOperation: () => { execution = next; release?.(); },
          }, { excludeTurns: supportsPaginatedHistory });
          restoredClean = true;
          ready = true;
          options.onThread(threadId);
          return receipt;
        } finally { selecting = false; }
      },
      stop: shutdown,
      suspend: () => { child?.kill("SIGSTOP"); },
    };
  } catch (error) { shutdown(); throw error; }
}
