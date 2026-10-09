import { isAbsolute, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";

export interface CodexExecutor {
  /** Each placement needs a fresh ID; Codex caches connections by this ID. */
  environmentId: string;
  url: string;
  token: string;
  cwd: string;
  roots: string[];
}

export interface CodexEnvironmentSelection {
  environmentId: string;
  cwd: string;
  runtimeWorkspaceRoots: string[];
}

export interface CodexSelectionReceipt {
  threadId: string;
  turnId?: string;
  environmentId: string;
  live: "published" | "idle";
  future: "verified";
}

export class CodexEnvironmentError extends Error {
  constructor(readonly code: "unsupported" | "rejected" | "unavailable" | "conflict" | "uncertain", message: string) {
    super(message);
    this.name = "CodexEnvironmentError";
  }
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const nativePath = (value: unknown): string => {
  if (typeof value !== "string") throw new CodexEnvironmentError("rejected", "The provider returned an invalid workspace path");
  const path = value.startsWith("file:") ? fileURLToPath(value) : value;
  if (!isAbsolute(path)) throw new CodexEnvironmentError("rejected", "The provider returned a relative workspace path");
  return normalize(path);
};
const authenticatedUrl = (value: string): string => {
  const url = new URL(value);
  if (url.username || url.password || url.hash ||
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw new CodexEnvironmentError("rejected", "Executor authentication requires a private or encrypted connection");
  return url.href;
};
const validToken = (value: string) => /^[\x21-\x7e]{32,200}$/.test(value);
const sameSelection = (actual: CodexEnvironmentSelection[], executor: CodexExecutor) =>
  actual.length === 1 && actual[0].environmentId === executor.environmentId && actual[0].cwd === executor.cwd &&
  actual[0].runtimeWorkspaceRoots.length === executor.roots.length && executor.roots.every(root => actual[0].runtimeWorkspaceRoots.includes(root));

/** Internal provider connection. UI input leases do not authorize its mutations. */
export async function connectCodexEnvironments(options: {
  endpoint: string;
  token: string;
  onDisconnect?: () => void;
}) {
  if (!validToken(options.token)) throw new CodexEnvironmentError("rejected", "Invalid internal provider credential");
  const socket = new WebSocket(authenticatedUrl(options.endpoint), {
    headers: { Authorization: `Bearer ${options.token}` }, maxPayload: NATIVE_MAX_MESSAGE,
    perMessageDeflate: false, handshakeTimeout: 10000,
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const registered = new Map<string, CodexExecutor>();
  const turns = new Map<string, { turnId?: string; revision: number }>();
  const selected = new Map<string, string>();
  const used = new Map<string, Set<string>>();
  let nextId = 0, closed = false, closing = false, uncertain = false;
  let sequence: Promise<unknown> = Promise.resolve();

  function observe(value: unknown) {
    const message = object(value), params = object(message?.params);
    if (!params || typeof message?.method !== "string") return;
    const thread = object(params.thread);
    const threadId = typeof params.threadId === "string" ? params.threadId : typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) return;
    const prior = turns.get(threadId);
    if (message.method === "thread/started" && !prior) turns.set(threadId, { revision: 0 });
    const turnId = object(params.turn)?.id;
    if (typeof turnId !== "string") return;
    if (message.method === "turn/started" && prior?.turnId !== turnId) turns.set(threadId, { turnId, revision: (prior?.revision ?? 0) + 1 });
    if (message.method === "turn/completed" && (!prior || prior.turnId === turnId)) turns.set(threadId, { revision: (prior?.revision ?? 0) + 1 });
  }

  function lost() {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CodexEnvironmentError("unavailable", "The provider connection closed; no request was retried"));
    }
    pending.clear();
    if (!closing) options.onDisconnect?.();
  }
  socket.on("error", lost);
  socket.on("close", lost);
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("Expected provider JSON");
      const message = object(JSON.parse(data.toString()));
      if (!message) throw new Error("Invalid provider JSON");
      observe(message);
      if (message.method !== undefined || typeof message.id !== "number") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new CodexEnvironmentError("rejected", "The provider rejected the execution environment request"));
      else entry.resolve(message.result);
    } catch { socket.terminate(); lost(); }
  });
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed || socket.readyState !== WebSocket.OPEN) { reject(new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CodexEnvironmentError("uncertain", "The provider acknowledgement timed out; keep execution held and reconcile before continuing"));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    const text = JSON.stringify({ id, method, params });
    if (socket.bufferedAmount + Buffer.byteLength(text) > NATIVE_MAX_BUFFERED) { socket.terminate(); lost(); return; }
    socket.send(text, error => { if (error) { socket.terminate(); lost(); } });
  });
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = sequence.then(action);
    sequence = result.catch(() => {});
    return result;
  };
  const close = () => { closing = true; socket.terminate(); lost(); };

  async function register(executor: CodexExecutor): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(executor.environmentId) || !validToken(executor.token) ||
        !Array.isArray(executor.roots) || !executor.roots.length || executor.roots.length > 32)
      throw new CodexEnvironmentError("rejected", "Invalid execution environment registration");
    const validated: CodexExecutor = { ...executor, url: authenticatedUrl(executor.url), cwd: nativePath(executor.cwd), roots: [...new Set(executor.roots.map(nativePath))] };
    if (!validated.roots.some(root => {
      const path = relative(root, validated.cwd);
      return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    })) throw new CodexEnvironmentError("rejected", "The execution directory is outside its selected roots");
    const existing = registered.get(validated.environmentId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(validated))
      throw new CodexEnvironmentError("conflict", "An environment ID cannot be rebound; use a fresh placement ID");
    if (!existing) {
      // Reserve before sending: a lost acknowledgement cannot make this ID safe
      // to reuse for a different connection or silently repeat registration.
      registered.set(validated.environmentId, validated);
      await call("environment/add", { environmentId: validated.environmentId, execServerUrl: validated.url,
        authBearerToken: validated.token, connectTimeoutMs: 10000 });
    }
    const info = object(await call("environment/info", { environmentId: validated.environmentId }));
    if (nativePath(info?.cwd) !== validated.cwd) throw new CodexEnvironmentError("rejected", "The executor reported a different working directory");
  }

  async function read(threadId: string) {
    const response = object(await call("thread/read", { threadId, includeTurns: false }));
    const thread = object(response?.thread);
    if (thread?.id !== threadId || !Array.isArray(thread.environments))
      throw new CodexEnvironmentError("unavailable", "The provider did not return the loaded thread's environment selection");
    const environments: CodexEnvironmentSelection[] = thread.environments.map(value => {
      const entry = object(value);
      if (typeof entry?.environmentId !== "string" || !Array.isArray(entry.runtimeWorkspaceRoots))
        throw new CodexEnvironmentError("rejected", "The provider returned an invalid environment selection");
      return { environmentId: entry.environmentId, cwd: nativePath(entry.cwd), runtimeWorkspaceRoots: entry.runtimeWorkspaceRoots.map(nativePath) };
    });
    // The protocol's top-level thread.cwd is its historical launch directory.
    // Loaded environment selections carry the current execution directories.
    return { threadId, environments };
  }

  let supportsSelection = false;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new CodexEnvironmentError("unavailable", "Could not connect to the provider")));
      socket.once("close", () => reject(new CodexEnvironmentError("unavailable", "Provider closed during initialization")));
    });
    await call("initialize", { clientInfo: { name: "infinite_execution", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    try {
      const diagnostics = object(await call("server/diagnostics", {}));
      supportsSelection = diagnostics?.executionEnvironmentUpdates === 1;
    } catch (error) {
      if (!(error instanceof CodexEnvironmentError) || error.code !== "rejected") throw error;
      // Older providers still support first-turn laptop registration.
    }
  } catch (error) { close(); throw error; }

  return {
    supportsSelection,
    register: (executor: CodexExecutor) => serial(() => register(executor)),
    observe,
    current: (threadId: string) => {
      const state = turns.get(threadId);
      return { observed: Boolean(state), turnId: state?.turnId };
    },
    read,
    close,
    /**
     * Caller holds dispatch/results and settles the old operation first. A live
     * selection publishes only future captures. Its callback releases the known
     * outcome; it must never replay an operation. This method does not fence tools.
     * Future selection is verified in this provider process, not across restart.
     */
    select: (request: { threadId: string; turnId?: string; executor: CodexExecutor; releaseHeldOperation?: () => void | Promise<void> }): Promise<CodexSelectionReceipt> => serial(async () => {
      if (!supportsSelection) throw new CodexEnvironmentError("unsupported", "This provider does not support qualified execution selection; cloud handoff is unavailable");
      if (uncertain) throw new CodexEnvironmentError("uncertain", "A previous selection is unresolved; keep execution held for reconciliation");
      const { threadId, turnId } = request;
      const captured = turns.get(threadId);
      if (!captured || captured.turnId !== turnId || (turnId && !request.releaseHeldOperation))
        throw new CodexEnvironmentError("conflict", "Execution selection requires the current provider turn and a held operation outcome");
      const checkTurn = () => {
        const current = turns.get(threadId);
        if (!current || current.revision !== captured.revision || current.turnId !== turnId)
          throw new CodexEnvironmentError("conflict", "The provider turn changed during execution selection; keep execution held");
      };
      await register(request.executor);
      const executor = registered.get(request.executor.environmentId)!;
      if (used.get(threadId)?.has(executor.environmentId) && selected.get(threadId) !== executor.environmentId)
        throw new CodexEnvironmentError("conflict", "Returning to an executor requires a fresh placement ID");
      const environments = [{ environmentId: executor.environmentId, cwd: executor.cwd, runtimeWorkspaceRoots: executor.roots }];
      checkTurn();
      // Both API calls can mutate provider state. Any loss after this point keeps
      // the held result unpublished, even if only one selection was accepted.
      uncertain = true;
      try {
        if (turnId) {
          const live = object(await call("turn/settings/update", { threadId, turnId, environments }));
          if (live?.status !== "applied") throw new CodexEnvironmentError("conflict", "The requested provider turn is no longer available");
        }
        checkTurn();
        await call("thread/settings/update", { threadId, cwd: executor.cwd, environments });
        const verified = await read(threadId);
        if (!sameSelection(verified.environments, executor))
          throw new CodexEnvironmentError("uncertain", "The provider's future selection did not match the requested executor");
        checkTurn();
        selected.set(threadId, executor.environmentId);
        const placements = used.get(threadId) ?? new Set<string>(); placements.add(executor.environmentId); used.set(threadId, placements);
        await request.releaseHeldOperation?.();
        uncertain = false;
        return { threadId, ...(turnId ? { turnId } : {}), environmentId: executor.environmentId, live: turnId ? "published" : "idle", future: "verified" };
      } catch (error) {
        if (error instanceof CodexEnvironmentError && error.code === "uncertain") throw error;
        throw new CodexEnvironmentError("uncertain", "Execution selection was not fully confirmed; keep dispatch held and reconcile the provider state");
      }
    }),
  };
}

export type CodexEnvironmentClient = Awaited<ReturnType<typeof connectCodexEnvironments>>;
