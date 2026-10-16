import type { Attention, Provider } from "@infinite/attention";
import { createRemoteClient, RemoteError } from "@infinite/remote";
import * as Crypto from "expo-crypto";
import { loadClientId } from "../store/connection";

export type Connection = { id?: string; machineId?: string; label?: string; url: string; token: string; relay?: { machineId: string } };
export const connectionKey = (connection: Connection) => connection.id ?? `${connection.url}/${connection.relay?.machineId ?? "direct"}`;
const remotes = new Map<string, { token: string; client: ReturnType<typeof createRemoteClient> }>();
const remoteKey = (connection: Connection) => `${connectionKey(connection)}/${connection.url}/${connection.relay?.machineId ?? "direct"}`;
export function closeConnection(connection: Connection) {
  remotes.get(remoteKey(connection))?.client.close();
  remotes.delete(remoteKey(connection));
}
function remote(connection: Connection) {
  const key = remoteKey(connection);
  let saved = remotes.get(key);
  if (!saved || saved.token !== connection.token) {
    saved?.client.close();
    saved = { token: connection.token, client: createRemoteClient(connection, { randomBytes: Crypto.getRandomBytes }) };
    remotes.set(key, saved);
  }
  return saved.client;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly attention?: Attention,
  ) {
    super(message);
  }
}

export type ControlCode = "control-busy" | "control-lost";
/**
 * The host refused input before anything was typed: another device holds control
 * (`control-busy`), or this phone's lease changed or expired (`control-lost`).
 */
export class ControlRefusal extends ApiError {
  constructor(
    message: string,
    readonly code: ControlCode,
  ) {
    super(message, 409, code);
  }
}

export async function api<T>(
  connection: Connection,
  path: string,
  init: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    /** The lease id this phone holds; the host refuses input without it. */
    control?: string;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = {
      "X-Infinite-Client": await loadClientId(),
      ...(init.control ? { "X-Infinite-Control": init.control } : {}),
    };
    if (connection.relay) {
      try {
        return await remote(connection).request<T>(path, { ...init, headers, signal: controller.signal });
      } catch (error) {
        if (error instanceof RemoteError) {
          const value = error.body as { error?: string; code?: string; attention?: Attention } | undefined;
          const code = value?.code ?? value?.error ?? error.code;
          if (code === "control-busy" || code === "control-lost") throw new ControlRefusal(error.message, code);
          throw new ApiError(error.message, error.status, code, value?.attention);
        }
        throw error;
      }
    }
    const response = await fetch(`${connection.url}/api${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...headers,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok) {
      const message = value.error ?? "Host request failed";
      // Control refusals carry `code` and a sentence; attention refusals carry the code as `error`.
      if (value.code === "control-busy" || value.code === "control-lost")
        throw new ControlRefusal(message, value.code);
      throw new ApiError(
        message,
        response.status,
        typeof value.code === "string"
          ? value.code
          : typeof value.error === "string"
            ? value.error
            : undefined,
        value.attention,
      );
    }
    return value as T;
  } catch (error) {
    if ((error as Error).name === "AbortError")
      throw new ApiError(
        "The host did not respond. Input delivery may be uncertain.",
        0,
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One device's input lease; the host refuses input from every other device while it lasts. */
export type ControlLease = { id: string; label: string; expiresAt: number };
export type SessionRow = {
  id: string;
  machineId?: string;
  executionLocation?: "cloud" | "laptop";
  backend?: "infinite" | "cmux";
  projectId?: string;
  resumable?: boolean;
  title: string;
  provider: Provider;
  status: string;
  createdAt: string;
  pid?: number;
  exitCode?: number;
  seq: number;
  attention: Attention;
  /** Present on workers that enforce input control; older workers take shared input. */
  capabilities?: { terminalSnapshot?: 1; inputControl?: 1 };
  control?: ControlLease | null;
  execution?: { location: "laptop" | "cloud"; state: "connecting" | "online" | "offline" | "preparing" | "paused"; cloudReady: boolean; checkpoint?: { id: string; capturedAt: string }; reason?: string; reconciliation?: "available" };
};
export type SessionDetail = SessionRow & {
  screen?: string;
  context: string;
  contextVersion: number;
  initialPrompt: string;
};
/** `POST /sessions/:id/answer` receipt; refusals arrive as HTTP 409 instead. */
export type AnswerReceipt = {
  requestId: string;
  state: "delivered" | "uncertain";
  seq: number;
  result: "closed" | "still-open" | "changed";
};
export type Me = {
  role: "owner" | "controller" | "viewer";
  environment: string;
  machine?: { id: string; label: string; environment: string };
  backends?: ("infinite" | "cmux")[];
  providers?: Provider[];
  backendProviders?: { infinite: Provider[]; cmux?: Provider[] };
  projects?: { id: string; name: string }[];
  capabilities?: { signals: boolean; answer: boolean; push: boolean };
};
export type LogEvent = {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
};

export type ChatMessage = { id: string; role: string; text: string; toolName?: string; ts?: string };
export type MessagesPage = { messages: ChatMessage[]; cursor: string | number; more?: boolean; source?: string; available?: boolean };
export type ProjectFile = { path: string; name: string; text?: string; mimeType: string; size: number; modifiedAt: string; base64?: string };
export type PendingGeneration = { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" | "apply-failed"; category?: string; message?: string };
export type ProjectSyncStatus = { projectId: string; lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: PendingGeneration };
/** Why a laptop generation waits, in the words the Create screen shows. */
export function pendingLabel(pending: PendingGeneration) {
  if (pending.reason === "session-running") return "a session is running";
  if (pending.reason === "cloud-changed") return "cloud files changed";
  if (pending.reason === "apply-failed") return `apply failed (${pending.category ?? "other"})${pending.message ? `: ${pending.message}` : ""}`;
  return "waiting to apply";
}
export type ProjectDetail = { id: string; name: string; sync: ProjectSyncStatus };
export function ago(iso?: string, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
