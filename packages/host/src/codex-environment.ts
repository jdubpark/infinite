import { isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { replyDeadline } from "./deadline.js";
import { NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  MAX_CODEX_ENVIRONMENT_STATE_BYTES,
  activeSelectionOf,
  clonePlacement,
  cloneSelection,
  generationOf,
  hydrateThreadPlacements,
  openCodexEnvironmentStore,
  pathWithinRoots,
  revisionOf,
  serializeThreadPlacements,
  usedOf,
  type CodexEnvironmentPersistenceOptions,
  type CodexEnvironmentStore,
  type CodexPlacementRecord,
  type PersistedCodexEnvironmentState,
  type PersistedCodexSelection,
  type PersistedCodexThreadPlacement,
  type ThreadPlacementState,
} from "./codex-environment-store.js";
import { createCodexToolFence, type CodexToolFence, type FenceDecision, type FencedDispatchEvent } from "./codex-environment-fence.js";

export {
  CODEX_ENVIRONMENT_STATE_FILE,
  MAX_CODEX_ENVIRONMENT_STATE_BYTES,
  openCodexEnvironmentStore,
  type CodexEnvironmentPersistenceOptions,
  type CodexEnvironmentStore,
  type PersistedCodexEnvironmentState,
  type PersistedCodexSelection,
  type PersistedCodexThreadPlacement,
};

export interface CodexExecutor {
  environmentId: string;
  url: string;
  token: string;
  cwd: string;
  roots: string[];
}

export type CodexEnvironmentSelection = PersistedCodexSelection;
export type CodexPlacement = CodexPlacementRecord;

export interface CodexSelectionReceipt {
  threadId: string;
  turnId?: string;
  environmentId: string;
  generation: number;
  live: "published" | "idle";
  future: "verified";
}

export interface CodexSelectionRequest {
  threadId: string;
  turnId?: string;
  executor: CodexExecutor;
  releaseHeldOperation?: () => void | Promise<void>;
}

export interface CodexDispatchCheck {
  threadId: string;
  environmentId?: string;
  cwd?: string;
  roots?: string[];
  generation?: number;
  toolName?: string;
}

export type CodexDispatchDecision =
  | { allowed: true; placement: CodexPlacement }
  | { allowed: false; code: CodexEnvironmentError["code"]; reason: string };

export type CodexThreadPlacementView =
  | { status: "unassigned" }
  | { status: "pending-verification"; expected: CodexEnvironmentSelection; generation: number }
  | { status: "selecting"; target: CodexEnvironmentSelection; generation: number }
  | { status: "verified"; placement: CodexPlacement }
  | { status: "uncertain"; generation: number; reason: string; expected?: CodexEnvironmentSelection }
  | { status: "corrupted"; reason: string };

export class CodexEnvironmentError extends Error {
  constructor(readonly code: "unsupported" | "rejected" | "unavailable" | "conflict" | "uncertain", message: string) {
    super(message);
    this.name = "CodexEnvironmentError";
  }
}

type RecordValue = Record<string, unknown>;
type StoreHealth = { ok: true } | { ok: false; reason: string };

const STARTUP_DISCOVERY_METHODS = new Set(["fs/getMetadata", "fs/readFile"]);

const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

const nativePath = (value: unknown): string => {
  if (typeof value !== "string") throw new CodexEnvironmentError("rejected", "The provider returned an invalid workspace path");
  const path = value.startsWith("file:") ? fileURLToPath(value) : value;
  if (!isAbsolute(path)) throw new CodexEnvironmentError("rejected", "The provider returned a relative workspace path");
  return normalize(path);
};

const discoveryPathWithinRoots = (params: RecordValue | undefined, cwd: string, roots: string[]): boolean => {
  const raw = params?.path;
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return false;
  try {
    const converted = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
    const target = isAbsolute(converted) ? normalize(converted) : normalize(resolve(cwd, converted));
    return pathWithinRoots(target, roots);
  } catch {
    return false;
  }
};

const authenticatedUrl = (value: string): string => {
  const url = new URL(value);
  if (url.username || url.password || url.hash ||
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw new CodexEnvironmentError("rejected", "Executor authentication requires a private or encrypted connection");
  return url.href;
};

const validToken = (value: string) => /^[\x21-\x7e]{32,200}$/.test(value);

const sameRoots = (actual: string[], expected: string[]): boolean => {
  if (actual.length !== expected.length) return false;
  const actualUnique = new Set(actual);
  return actualUnique.size === expected.length && expected.every(root => actualUnique.has(root));
};

const sameSelectionValues = (actual: CodexEnvironmentSelection, expected: CodexEnvironmentSelection): boolean =>
  actual.environmentId === expected.environmentId &&
  actual.cwd === expected.cwd &&
  sameRoots(actual.runtimeWorkspaceRoots, expected.runtimeWorkspaceRoots);

const sameSelection = (actual: CodexEnvironmentSelection[], executor: { environmentId: string; cwd: string; roots: string[] }): boolean =>
  actual.length === 1 && sameSelectionValues(actual[0], {
    environmentId: executor.environmentId,
    cwd: executor.cwd,
    runtimeWorkspaceRoots: executor.roots,
  });

const parseEnvironments = (raw: unknown): CodexEnvironmentSelection[] => {
  if (!Array.isArray(raw)) {
    throw new CodexEnvironmentError("rejected", "The provider returned an invalid environment selection");
  }
  return raw.map(value => {
    const entry = object(value);
    if (typeof entry?.environmentId !== "string" || !Array.isArray(entry.runtimeWorkspaceRoots)) {
      throw new CodexEnvironmentError("rejected", "The provider returned an invalid environment selection");
    }
    return {
      environmentId: entry.environmentId,
      cwd: nativePath(entry.cwd),
      runtimeWorkspaceRoots: entry.runtimeWorkspaceRoots.map(nativePath),
    };
  });
};

const normalizeExecutor = (executor: CodexExecutor): CodexExecutor => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(executor.environmentId) || !validToken(executor.token) ||
      !Array.isArray(executor.roots) || !executor.roots.length || executor.roots.length > 32) {
    throw new CodexEnvironmentError("rejected", "Invalid execution environment registration");
  }
  const validated: CodexExecutor = {
    ...executor,
    url: authenticatedUrl(executor.url),
    cwd: nativePath(executor.cwd),
    roots: [...new Set(executor.roots.map(nativePath))],
  };
  if (!pathWithinRoots(validated.cwd, validated.roots)) {
    throw new CodexEnvironmentError("rejected", "The execution directory is outside its selected roots");
  }
  return validated;
};

export async function connectCodexEnvironments(options: {
  endpoint: string;
  token: string;
  onDisconnect?: () => void;
  persistence?: CodexEnvironmentPersistenceOptions;
  store?: CodexEnvironmentStore;
  onDispatchFenced?: (event: FencedDispatchEvent & { threadId?: string }) => void;
}) {
  if (!validToken(options.token)) throw new CodexEnvironmentError("rejected", "Invalid internal provider credential");
  const store = options.store ?? (options.persistence ? openCodexEnvironmentStore(options.persistence) : undefined);
  let placements = new Map<string, ThreadPlacementState>();
  let storeHealth: StoreHealth = { ok: true };
  if (store) {
    const loaded = store.read();
    if (loaded.state === "unreadable") storeHealth = { ok: false, reason: loaded.reason };
    else if (loaded.state === "readable") placements = hydrateThreadPlacements(loaded.record);
  }

  const socket = new WebSocket(authenticatedUrl(options.endpoint), {
    headers: { Authorization: `Bearer ${options.token}` }, maxPayload: NATIVE_MAX_MESSAGE,
    perMessageDeflate: false, handshakeTimeout: 10000,
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const reserved = new Map<string, CodexExecutor>();
  const validatedExecutors = new Map<string, CodexExecutor>();
  const registering = new Map<string, Promise<void>>();
  const bootstrapDiscovery = new Map<string, { cwd: string; roots: string[]; count: number }>();
  const turns = new Map<string, { turnId?: string; revision: number }>();
  const threadQueues = new Map<string, Promise<unknown>>();
  let fence: CodexToolFence | undefined;
  let nextId = 0, closed = false, closing = false;

  const persistStore = () => {
    if (!store) throw new CodexEnvironmentError("unavailable", "Durable execution environment persistence is required before confirming placement");
    if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
    try {
      store.write(serializeThreadPlacements(store.scope, placements));
    } catch {
      throw new CodexEnvironmentError("uncertain", "Could not persist execution environment placement; keep tool dispatch fenced");
    }
  };

  const clearDiscovery = (environmentId: string, reason: string) => {
    if (bootstrapDiscovery.delete(environmentId)) fence?.revoke(environmentId, reason);
  };

  const findThreadByEnvironment = (environmentId: string): string | undefined => {
    for (const [threadId, state] of placements) {
      if (state.kind === "verified" && state.placement.environmentId === environmentId) return threadId;
      if (state.kind === "pending-verification" && state.persisted.placement.environmentId === environmentId) return threadId;
      if (state.kind === "selecting" && (state.target.environmentId === environmentId || state.previous?.environmentId === environmentId)) return threadId;
      if (state.kind === "uncertain" && (state.expected?.environmentId === environmentId || state.used.has(environmentId))) return threadId;
      if (usedOf(state).has(environmentId)) return threadId;
    }
    return undefined;
  };

  const checkEnvironmentDispatch = (environmentId: string, method?: string, params?: RecordValue): FenceDecision => {
    if (closed) return { allowed: false, code: "unavailable", reason: "The internal provider connection is unavailable" };
    if (!storeHealth.ok) return { allowed: false, code: "uncertain", reason: storeHealth.reason };
    const reg = validatedExecutors.get(environmentId);
    if (!reg) {
      return { allowed: false, code: "conflict", reason: "Executor has not completed validated registration on this provider connection" };
    }
    for (const state of placements.values()) {
      if (state.kind === "verified" && state.placement.environmentId === environmentId) {
        if (!sameSelectionValues(state.placement, { environmentId: reg.environmentId, cwd: reg.cwd, runtimeWorkspaceRoots: reg.roots })) {
          return { allowed: false, code: "conflict", reason: "Registered executor does not match verified placement" };
        }
        return { allowed: true, generation: state.placement.generation };
      }
    }
    const discovery = bootstrapDiscovery.get(environmentId);
    if (discovery && method && STARTUP_DISCOVERY_METHODS.has(method)) {
      if (discoveryPathWithinRoots(params, discovery.cwd, discovery.roots)) {
        return { allowed: true, generation: 0, bootstrap: true };
      }
      return { allowed: false, code: "conflict", reason: "Startup discovery path is outside the registered workspace roots" };
    }
    for (const state of placements.values()) {
      if (state.kind === "selecting" && (state.target.environmentId === environmentId || state.previous?.environmentId === environmentId)) {
        return { allowed: false, code: "conflict", reason: "Execution environment selection is in progress; tool dispatch is held" };
      }
      if (state.kind === "uncertain" && (state.expected?.environmentId === environmentId || state.used.has(environmentId))) {
        return { allowed: false, code: "uncertain", reason: state.reason };
      }
      if (state.kind === "pending-verification" &&
          (state.persisted.placement.environmentId === environmentId || state.persisted.usedEnvironmentIds.includes(environmentId))) {
        return { allowed: false, code: "uncertain", reason: "Persisted execution environment placement must be verified after restart before tool dispatch" };
      }
    }
    for (const state of placements.values()) {
      if (usedOf(state).has(environmentId)) {
        return { allowed: false, code: "conflict", reason: "Execution environment placement is stale and has been superseded" };
      }
    }
    return { allowed: false, code: "conflict", reason: "Execution environment placement has not been verified for tool dispatch" };
  };

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
    bootstrapDiscovery.clear();
    fence?.revokeAll("The internal provider connection closed; tool dispatch is fenced");
    fence?.close();
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
      if (message.method !== undefined || typeof message.id !== "number") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new CodexEnvironmentError("rejected", "The provider rejected the execution environment request"));
      else entry.resolve(message.result);
    } catch { socket.terminate(); lost(); }
  });
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolveCall, rejectCall) => {
    if (closed || socket.readyState !== WebSocket.OPEN) { rejectCall(new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable")); return; }
    const id = ++nextId;
    const timer = replyDeadline(15000, () => {
      if (!pending.delete(id)) return;
      rejectCall(new CodexEnvironmentError("uncertain", "The provider acknowledgement timed out; keep execution held and reconcile before continuing"));
    });
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    const text = JSON.stringify({ id, method, params });
    if (socket.bufferedAmount + Buffer.byteLength(text) > NATIVE_MAX_BUFFERED) { socket.terminate(); lost(); return; }
    socket.send(text, error => { if (error) { socket.terminate(); lost(); } });
  });
  const serialThread = <T>(threadId: string, action: () => Promise<T>): Promise<T> => {
    const previous = threadQueues.get(threadId) ?? Promise.resolve();
    const next = previous.then(action, action);
    const settled = next.catch(() => {});
    threadQueues.set(threadId, settled);
    void settled.finally(() => {
      if (threadQueues.get(threadId) === settled) threadQueues.delete(threadId);
    });
    return next;
  };
  const close = () => { closing = true; socket.terminate(); lost(); };

  async function register(executor: CodexExecutor): Promise<void> {
    const validated = normalizeExecutor(executor);
    const existing = reserved.get(validated.environmentId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(validated)) {
      throw new CodexEnvironmentError("conflict", "An environment ID cannot be rebound; use a fresh placement ID");
    }
    const inflight = registering.get(validated.environmentId);
    if (inflight) return inflight;
    if (!existing) reserved.set(validated.environmentId, validated);
    const needsAdd = !validatedExecutors.has(validated.environmentId);
    const promise = (async () => {
      try {
        if (needsAdd) {
          if (!fence) throw new CodexEnvironmentError("unavailable", "The tool dispatch fence is unavailable");
          const proxy = fence.add({ environmentId: validated.environmentId, url: validated.url, token: validated.token });
          await call("environment/add", {
            environmentId: validated.environmentId,
            execServerUrl: proxy.url,
            authBearerToken: proxy.token,
            connectTimeoutMs: 10000,
          });
        }
        const info = object(await call("environment/info", { environmentId: validated.environmentId }));
        if (nativePath(info?.cwd) !== validated.cwd) {
          throw new CodexEnvironmentError("rejected", "The executor reported a different working directory");
        }
        validatedExecutors.set(validated.environmentId, validated);
      } catch (error) {
        validatedExecutors.delete(validated.environmentId);
        bootstrapDiscovery.delete(validated.environmentId);
        fence?.remove(validated.environmentId, "Executor registration failed validation");
        throw error;
      }
    })();
    registering.set(validated.environmentId, promise);
    try { await promise; } finally {
      if (registering.get(validated.environmentId) === promise) registering.delete(validated.environmentId);
    }
  }

  async function read(threadId: string) {
    const response = object(await call("thread/read", { threadId, includeTurns: false }));
    const thread = object(response?.thread);
    if (thread?.id !== threadId || !Array.isArray(thread.environments)) {
      throw new CodexEnvironmentError("unavailable", "The provider did not return the loaded thread's environment selection");
    }
    return { threadId, environments: parseEnvironments(thread.environments) };
  }

  const beginStartupDiscovery = (environmentId: string): (() => void) => {
    if (closed) throw new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable");
    if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
    const reg = validatedExecutors.get(environmentId);
    if (!reg) throw new CodexEnvironmentError("conflict", "Executor has not completed validated registration on this provider connection");
    for (const state of placements.values()) {
      if (state.kind === "selecting" && (state.target.environmentId === environmentId || state.previous?.environmentId === environmentId)) {
        throw new CodexEnvironmentError("conflict", "Execution environment selection is in progress");
      }
      if (state.kind === "uncertain" && (state.expected?.environmentId === environmentId || state.used.has(environmentId))) {
        throw new CodexEnvironmentError("uncertain", state.reason);
      }
      if (state.kind === "verified" && state.placement.environmentId !== environmentId && state.used.has(environmentId)) {
        throw new CodexEnvironmentError("conflict", "Execution environment placement is stale and has been superseded");
      }
      if (state.kind === "pending-verification" && state.persisted.placement.environmentId !== environmentId &&
          state.persisted.usedEnvironmentIds.includes(environmentId)) {
        throw new CodexEnvironmentError("conflict", "Execution environment placement is stale and has been superseded");
      }
    }
    const existing = bootstrapDiscovery.get(environmentId);
    if (existing) existing.count += 1;
    else bootstrapDiscovery.set(environmentId, { cwd: reg.cwd, roots: [...reg.roots], count: 1 });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const entry = bootstrapDiscovery.get(environmentId);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) {
        bootstrapDiscovery.delete(environmentId);
        fence?.revoke(environmentId, "Startup discovery window closed");
      }
    };
  };

  const assertNotOwnedByOtherThread = (threadId: string, environmentId: string) => {
    for (const [otherThreadId, state] of placements) {
      if (otherThreadId !== threadId && usedOf(state).has(environmentId)) {
        throw new CodexEnvironmentError("conflict", "An environment ID cannot be shared across threads; use a fresh placement ID");
      }
    }
  };

  const markUncertain = (threadId: string, reason: string, expected?: PersistedCodexSelection, used?: Set<string>) => {
    const current = placements.get(threadId);
    const nextUsed = used ? new Set(used) : usedOf(current);
    const nextExpected = expected ?? activeSelectionOf(current);
    if (nextExpected) nextUsed.add(nextExpected.environmentId);
    placements.set(threadId, {
      kind: "uncertain",
      generation: Math.max(1, generationOf(current)),
      revision: revisionOf(current) + 1,
      ...(nextExpected ? { expected: cloneSelection(nextExpected) } : {}),
      used: nextUsed,
      reason,
      updatedAt: new Date().toISOString(),
    });
    for (const id of nextUsed) {
      bootstrapDiscovery.delete(id);
      fence?.revoke(id, reason);
    }
    if (store && storeHealth.ok) { try { persistStore(); } catch {} }
  };

  const confirmInitialPlacement = (request: {
    threadId: string;
    executor: CodexExecutor;
    reportedEnvironments?: unknown;
  }): Promise<CodexPlacement> => serialThread(request.threadId, async () => {
    if (closed) throw new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable");
    if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
    const validated = normalizeExecutor(request.executor);
    clearDiscovery(validated.environmentId, "Startup discovery window closed");
    const reg = validatedExecutors.get(validated.environmentId);
    if (!reg || JSON.stringify(reg) !== JSON.stringify(validated)) {
      throw new CodexEnvironmentError("conflict", "Executor has not completed validated registration on this provider connection");
    }
    const requestedSelection: PersistedCodexSelection = {
      environmentId: validated.environmentId,
      cwd: validated.cwd,
      runtimeWorkspaceRoots: [...validated.roots],
    };
    let reported: CodexEnvironmentSelection[];
    if (request.reportedEnvironments !== undefined) {
      try {
        reported = parseEnvironments(request.reportedEnvironments);
      } catch {
        markUncertain(request.threadId, "The provider returned an invalid initial thread environment", requestedSelection);
        throw new CodexEnvironmentError("uncertain", "The provider returned an invalid initial thread environment");
      }
    } else {
      try {
        reported = (await read(request.threadId)).environments;
      } catch {
        markUncertain(request.threadId, "The provider did not confirm the initial thread environment via thread/read", requestedSelection);
        throw new CodexEnvironmentError("uncertain", "The provider did not confirm the initial thread environment; tool dispatch remains fenced");
      }
    }
    if (!sameSelection(reported, validated)) {
      markUncertain(request.threadId, "The provider's initial thread environment did not match the requested executor", requestedSelection);
      throw new CodexEnvironmentError("uncertain", "The provider's initial thread environment did not match the requested executor");
    }
    assertNotOwnedByOtherThread(request.threadId, validated.environmentId);
    const existing = placements.get(request.threadId);
    if (existing) {
      if (existing.kind === "verified") {
        if (sameSelectionValues(existing.placement, requestedSelection)) return clonePlacement(existing.placement);
        throw new CodexEnvironmentError("conflict", "The thread already has a different verified execution placement");
      }
      if (existing.kind === "pending-verification") {
        const expected = existing.persisted.placement;
        if (sameSelectionValues(reported[0], expected) && sameSelectionValues(expected, requestedSelection)) {
          const placement: CodexPlacement = {
            threadId: request.threadId,
            ...cloneSelection(expected),
            generation: existing.persisted.generation,
            ...(existing.persisted.turnId ? { turnId: existing.persisted.turnId } : {}),
            verifiedAt: existing.persisted.verifiedAt,
          };
          placements.set(request.threadId, {
            kind: "verified",
            placement,
            revision: existing.persisted.revision,
            used: new Set(existing.persisted.usedEnvironmentIds),
            updatedAt: existing.persisted.updatedAt,
          });
          return clonePlacement(placement);
        }
        markUncertain(request.threadId, "Initial thread placement drifted from persisted state; reconcile before dispatching tools", expected);
        throw new CodexEnvironmentError("conflict", "Initial thread placement does not match persisted state");
      }
      throw new CodexEnvironmentError("uncertain", "A previous selection is unresolved; keep execution held for reconciliation");
    }
    const now = new Date().toISOString();
    const placement: CodexPlacement = { threadId: request.threadId, ...requestedSelection, generation: 1, verifiedAt: now };
    const used = new Set([validated.environmentId]);
    placements.set(request.threadId, { kind: "verified", placement, revision: 1, used, updatedAt: now });
    if (store) {
      try { persistStore(); } catch (error) {
        markUncertain(request.threadId, "Could not persist initial execution environment placement; tool dispatch remains fenced", requestedSelection, used);
        throw error;
      }
    }
    return clonePlacement(placement);
  });

  const assertObservedEnvironments = (threadId: string, rawEnvironments: unknown): CodexPlacement => {
    if (closed) throw new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable");
    if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
    const current = placements.get(threadId);
    if (!current || current.kind !== "verified") throw new CodexEnvironmentError("uncertain", "Thread placement is not verified");
    let observed: CodexEnvironmentSelection[];
    try { observed = parseEnvironments(rawEnvironments); } catch {
      markUncertain(threadId, "Provider reported an invalid execution environment; tool dispatch is fenced");
      throw new CodexEnvironmentError("conflict", "Provider reported an invalid execution environment");
    }
    if (observed.length !== 1 || !sameSelectionValues(observed[0], current.placement)) {
      markUncertain(threadId, "Provider environment placement drifted from verified state; reconcile before dispatching tools");
      throw new CodexEnvironmentError("conflict", "Provider environment placement drifted from verified state");
    }
    return clonePlacement(current.placement);
  };

  const verifyUnlocked = async (threadId: string): Promise<CodexPlacement> => {
    if (closed) throw new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable");
    if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
    const current = placements.get(threadId);
    if (!current) throw new CodexEnvironmentError("conflict", "No persisted execution environment placement exists for this thread");
    if (current.kind === "selecting") throw new CodexEnvironmentError("conflict", "Execution environment selection is in progress; wait for completion");
    if (current.kind === "uncertain") throw new CodexEnvironmentError("uncertain", current.reason);
    const expected = activeSelectionOf(current)!;
    const generation = generationOf(current);
    const revision = revisionOf(current);
    const used = usedOf(current);
    const turnId = current.kind === "pending-verification" ? current.persisted.turnId : current.placement.turnId;
    const verifiedAt = current.kind === "pending-verification" ? current.persisted.verifiedAt : current.placement.verifiedAt;
    const updatedAt = current.kind === "pending-verification" ? current.persisted.updatedAt : current.updatedAt;
    const reg = validatedExecutors.get(expected.environmentId);
    if (!reg || !sameSelectionValues(expected, { environmentId: reg.environmentId, cwd: reg.cwd, runtimeWorkspaceRoots: reg.roots })) {
      markUncertain(threadId, "Executor has not completed validated registration matching persisted placement; reconcile before dispatching tools", expected, used);
      throw new CodexEnvironmentError("conflict", "Executor has not completed validated registration matching persisted placement");
    }
    let live: { threadId: string; environments: CodexEnvironmentSelection[] };
    try { live = await read(threadId); } catch (error) {
      if (error instanceof CodexEnvironmentError && error.code === "rejected") {
        markUncertain(threadId, "Provider returned an invalid environment selection during verification", expected, used);
      }
      throw error;
    }
    if (live.environments.length !== 1 || !sameSelectionValues(live.environments[0], expected)) {
      markUncertain(threadId, "Provider environment placement does not match persisted state; reconcile before dispatching tools", expected, used);
      throw new CodexEnvironmentError("conflict", "Provider environment placement does not match persisted state; tool dispatch remains fenced until reconciled");
    }
    const placement: CodexPlacement = { threadId, ...cloneSelection(expected), generation, ...(turnId ? { turnId } : {}), verifiedAt };
    placements.set(threadId, { kind: "verified", placement, revision, used, updatedAt });
    return clonePlacement(placement);
  };

  const verify = (threadId: string): Promise<CodexPlacement> => serialThread(threadId, () => verifyUnlocked(threadId));

  const restoreThread = (threadId: string): Promise<CodexPlacement> => serialThread(threadId, async () => {
    if (closed) throw new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable");
    if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
    const current = placements.get(threadId);
    if (!current) throw new CodexEnvironmentError("conflict", "No persisted execution environment placement exists for this thread");
    if (current.kind === "selecting") throw new CodexEnvironmentError("conflict", "Execution environment selection is in progress; wait for completion");
    if (current.kind === "uncertain") throw new CodexEnvironmentError("uncertain", current.reason);
    const expected = activeSelectionOf(current)!;
    const endDiscovery = beginStartupDiscovery(expected.environmentId);
    let resumed: RecordValue | undefined;
    try {
      resumed = object(await call("thread/resume", { threadId }));
    } finally {
      endDiscovery();
    }
    const thread = object(resumed?.thread);
    if (thread?.id !== threadId) {
      markUncertain(threadId, "Provider failed to resume the saved thread during restart recovery", expected);
      throw new CodexEnvironmentError("unavailable", "Provider did not resume the requested thread");
    }
    if (thread.environments !== undefined) {
      let reported: CodexEnvironmentSelection[];
      try { reported = parseEnvironments(thread.environments); } catch {
        markUncertain(threadId, "Provider returned an invalid environment selection during thread resume", expected);
        throw new CodexEnvironmentError("conflict", "Provider returned an invalid environment selection during thread resume");
      }
      if (reported.length !== 1 || !sameSelectionValues(reported[0], expected)) {
        markUncertain(threadId, "Resumed thread environment placement drifted from persisted state; reconcile before dispatching tools", expected);
        throw new CodexEnvironmentError("conflict", "Resumed thread environment placement does not match persisted state");
      }
    }
    observe({ method: "thread/started", params: { thread: { id: threadId } } });
    return verifyUnlocked(threadId);
  });

  const checkDispatch = (request: CodexDispatchCheck): CodexDispatchDecision => {
    if (closed) return { allowed: false, code: "unavailable", reason: "The internal provider connection is unavailable" };
    if (!storeHealth.ok) return { allowed: false, code: "uncertain", reason: storeHealth.reason };
    const state = placements.get(request.threadId);
    if (!state) return { allowed: false, code: "conflict", reason: "No verified execution environment placement exists for this thread" };
    if (state.kind === "pending-verification") return { allowed: false, code: "uncertain", reason: "Persisted execution environment placement must be verified after restart before tool dispatch" };
    if (state.kind === "selecting") return { allowed: false, code: "conflict", reason: "Execution environment selection is in progress; tool dispatch is held" };
    if (state.kind === "uncertain") return { allowed: false, code: "uncertain", reason: state.reason };
    const reg = validatedExecutors.get(state.placement.environmentId);
    if (!reg || !sameSelectionValues(state.placement, { environmentId: reg.environmentId, cwd: reg.cwd, runtimeWorkspaceRoots: reg.roots })) {
      return { allowed: false, code: "conflict", reason: "Executor has not completed validated registration on this provider connection" };
    }
    if (request.environmentId !== undefined && request.environmentId !== state.placement.environmentId) {
      return { allowed: false, code: "conflict", reason: "Requested execution environment does not match the verified placement" };
    }
    if (request.generation !== undefined && request.generation !== state.placement.generation) {
      return { allowed: false, code: "conflict", reason: "Execution placement generation is stale" };
    }
    if (request.cwd !== undefined) {
      let normalizedCwd: string;
      try { normalizedCwd = nativePath(request.cwd); } catch {
        return { allowed: false, code: "rejected", reason: "Requested execution directory is invalid" };
      }
      if (normalizedCwd !== state.placement.cwd) {
        return { allowed: false, code: "conflict", reason: "Requested execution directory does not match the verified placement" };
      }
    }
    if (request.roots !== undefined) {
      let normalizedRoots: string[];
      try { normalizedRoots = [...new Set(request.roots.map(nativePath))]; } catch {
        return { allowed: false, code: "rejected", reason: "Requested workspace roots are invalid" };
      }
      if (!sameRoots(normalizedRoots, state.placement.runtimeWorkspaceRoots)) {
        return { allowed: false, code: "conflict", reason: "Requested workspace roots do not match the verified placement" };
      }
    }
    return { allowed: true, placement: clonePlacement(state.placement) };
  };

  const assertDispatchAllowed = (request: CodexDispatchCheck): CodexPlacement => {
    const decision = checkDispatch(request);
    if (!decision.allowed) throw new CodexEnvironmentError(decision.code, decision.reason);
    return decision.placement;
  };

  const dispatchTool = async <T>(
    request: CodexDispatchCheck,
    dispatch: (placement: CodexPlacement) => Promise<T> | T,
  ): Promise<T> => dispatch(assertDispatchAllowed(request));

  const placementView = (threadId: string): CodexThreadPlacementView => {
    if (!storeHealth.ok) return { status: "corrupted", reason: storeHealth.reason };
    const state = placements.get(threadId);
    if (!state) return { status: "unassigned" };
    if (state.kind === "pending-verification") return { status: "pending-verification", expected: cloneSelection(state.persisted.placement), generation: state.persisted.generation };
    if (state.kind === "selecting") return { status: "selecting", target: cloneSelection(state.target), generation: state.generation };
    if (state.kind === "verified") return { status: "verified", placement: clonePlacement(state.placement) };
    return { status: "uncertain", generation: state.generation, reason: state.reason, ...(state.expected ? { expected: cloneSelection(state.expected) } : {}) };
  };

  const applySelection = (request: CodexSelectionRequest, allowReconcile: boolean): Promise<CodexSelectionReceipt> =>
    serialThread(request.threadId, async () => {
      if (closed) throw new CodexEnvironmentError("unavailable", "The internal provider connection is unavailable");
      if (!storeHealth.ok) throw new CodexEnvironmentError("uncertain", storeHealth.reason);
      if (!store) throw new CodexEnvironmentError("unavailable", "Durable execution environment persistence is required before confirming placement");
      if (!providerSupportsSelection) {
        throw new CodexEnvironmentError("unsupported", "This provider does not support qualified execution selection; cloud handoff is unavailable");
      }
      const { threadId, turnId } = request;
      const current = placements.get(threadId);
      if (!allowReconcile && current?.kind === "uncertain") {
        throw new CodexEnvironmentError("uncertain", "A previous selection is unresolved; keep execution held for reconciliation");
      }
      const captured = turns.get(threadId);
      if (!captured || captured.turnId !== turnId || (turnId && !request.releaseHeldOperation)) {
        throw new CodexEnvironmentError("conflict", "Execution selection requires the current provider turn and a held operation outcome");
      }
      const checkTurn = () => {
        const latest = turns.get(threadId);
        if (!latest || latest.revision !== captured.revision || latest.turnId !== turnId) {
          throw new CodexEnvironmentError("conflict", "The provider turn changed during execution selection; keep execution held");
        }
      };
      await register(request.executor);
      const executor = validatedExecutors.get(request.executor.environmentId);
      if (!executor) throw new CodexEnvironmentError("conflict", "Executor has not completed validated registration on this provider connection");
      assertNotOwnedByOtherThread(threadId, executor.environmentId);
      const priorUsed = usedOf(current);
      const priorActive = activeSelectionOf(current);
      if (priorUsed.has(executor.environmentId) && priorActive?.environmentId !== executor.environmentId) {
        throw new CodexEnvironmentError("conflict", "Returning to an executor requires a fresh placement ID");
      }
      checkTurn();

      const nextGeneration = generationOf(current) + 1;
      const selectingRevision = revisionOf(current) + 1;
      const nextUsed = new Set(priorUsed);
      nextUsed.add(executor.environmentId);
      const nextSelection: PersistedCodexSelection = {
        environmentId: executor.environmentId,
        cwd: executor.cwd,
        runtimeWorkspaceRoots: [...executor.roots],
      };
      const environments = [cloneSelection(nextSelection)];

      clearDiscovery(executor.environmentId, "Execution environment selection is in progress; tool dispatch is held");
      if (priorActive) clearDiscovery(priorActive.environmentId, "Execution environment selection is in progress; tool dispatch is held");
      placements.set(threadId, {
        kind: "selecting",
        generation: nextGeneration,
        revision: selectingRevision,
        target: nextSelection,
        ...(priorActive ? { previous: cloneSelection(priorActive) } : {}),
        used: nextUsed,
        ...(turnId ? { turnId } : {}),
        updatedAt: new Date().toISOString(),
      });
      if (priorActive) {
        fence?.revoke(priorActive.environmentId, "Execution environment selection is in progress; tool dispatch is held");
      }
      if (!priorActive || priorActive.environmentId !== executor.environmentId) {
        fence?.revoke(executor.environmentId, "Execution environment selection is in progress; tool dispatch is held");
      }
      try { persistStore(); } catch (error) {
        markUncertain(threadId, "Could not persist execution environment transition; tool dispatch remains fenced", nextSelection, nextUsed);
        throw error;
      }

      try {
        if (turnId) {
          const live = object(await call("turn/settings/update", { threadId, turnId, environments }));
          if (live?.status !== "applied") throw new CodexEnvironmentError("conflict", "The requested provider turn is no longer available");
        }
        checkTurn();
        await call("thread/settings/update", { threadId, cwd: executor.cwd, environments });
        const verified = await read(threadId);
        if (!sameSelection(verified.environments, executor)) {
          throw new CodexEnvironmentError("uncertain", "The provider's future selection did not match the requested executor");
        }
        checkTurn();
        const now = new Date().toISOString();
        const nextPlacement: CodexPlacement = {
          threadId,
          ...cloneSelection(nextSelection),
          generation: nextGeneration,
          ...(turnId ? { turnId } : {}),
          verifiedAt: now,
        };
        placements.set(threadId, { kind: "verified", placement: nextPlacement, revision: selectingRevision + 1, used: nextUsed, updatedAt: now });
        persistStore();
        if (priorActive && priorActive.environmentId !== executor.environmentId) {
          fence?.revoke(priorActive.environmentId, "Execution environment placement is stale and has been superseded");
        }
        await request.releaseHeldOperation?.();
        return {
          threadId,
          ...(turnId ? { turnId } : {}),
          environmentId: executor.environmentId,
          generation: nextGeneration,
          live: turnId ? "published" : "idle",
          future: "verified",
        };
      } catch (error) {
        const message = error instanceof CodexEnvironmentError && error.code === "uncertain"
          ? error.message
          : "Execution selection was not fully confirmed; keep dispatch held and reconcile the provider state";
        markUncertain(threadId, message, nextSelection, nextUsed);
        throw new CodexEnvironmentError("uncertain", message);
      }
    });

  let providerSupportsSelection = false;
  try {
    fence = await createCodexToolFence({
      authorize: (environmentId, method, params) => checkEnvironmentDispatch(environmentId, method, params),
      onFenced: event => options.onDispatchFenced?.({ ...event, threadId: findThreadByEnvironment(event.environmentId) }),
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", () => rejectOpen(new CodexEnvironmentError("unavailable", "Could not connect to the provider")));
      socket.once("close", () => rejectOpen(new CodexEnvironmentError("unavailable", "Provider closed during initialization")));
    });
    await call("initialize", { clientInfo: { name: "infinite_execution", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    try {
      const diagnostics = object(await call("server/diagnostics", {}));
      providerSupportsSelection = diagnostics?.executionEnvironmentUpdates === 1;
    } catch (error) {
      if (!(error instanceof CodexEnvironmentError) || error.code !== "rejected") throw error;
    }
  } catch (error) { close(); throw error; }

  const storeStatus: "ok" | "corrupted" | "unconfigured" = !store ? "unconfigured" : storeHealth.ok ? "ok" : "corrupted";
  const supportsSelection = providerSupportsSelection && storeStatus === "ok";

  return {
    supportsSelection,
    storeStatus,
    register,
    observe,
    current: (threadId: string) => {
      const state = turns.get(threadId);
      return { observed: Boolean(state), turnId: state?.turnId };
    },
    placement: placementView,
    read,
    beginStartupDiscovery,
    confirmInitialPlacement,
    assertObservedEnvironments,
    verify,
    restoreThread,
    checkDispatch,
    assertDispatchAllowed,
    dispatchTool,
    select: (request: CodexSelectionRequest): Promise<CodexSelectionReceipt> => applySelection(request, false),
    reconcile: (request: CodexSelectionRequest): Promise<CodexSelectionReceipt> => applySelection(request, true),
    close,
  };
}

export type CodexEnvironmentClient = Awaited<ReturnType<typeof connectCodexEnvironments>>;
