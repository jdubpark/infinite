import { createContext, useContext } from "react";
import { createRemoteClient, RemoteError } from "@infinite/remote";
import type { Attention } from "@infinite/attention";
export type Connection = { id: string; label: string; url: string; token: string; relay?: { machineId: string } };
export type ControlLease = { id: string; label: string; expiresAt: number };
export type Session = {
  id: string;
  machineId?: string;
  executionLocation?: "cloud" | "laptop";
  backend?: "infinite" | "cmux";
  resumable?: boolean;
  title: string;
  provider: string;
  projectId: string;
  status: string;
  createdAt: string;
  pid?: number;
  seq: number;
  screen?: string;
  initialPrompt?: string;
  context?: string;
  contextVersion: number;
  capabilities?: { terminalSnapshot?: 1; inputControl?: 1 };
  control?: ControlLease | null;
  runtime?: { id: string; location: string; transport: "pty" | "cmux" };
  execution?: { location: "laptop" | "cloud"; state: "connecting" | "online" | "offline" | "preparing" | "paused"; cloudReady: boolean; checkpoint?: { id: string; capturedAt: string }; reason?: string; reconciliation?: "available" };
  attention?: Attention;
};
export type LogEvent = {
  seq: number;
  at: string;
  type: "signal" | (string & {});
  data: Record<string, unknown>;
};
export type Me = {
  role: "owner" | "controller" | "viewer";
  environment: "cloud" | "local";
  machine?: { id: string; label: string; environment: string };
  backends?: ("infinite" | "cmux")[];
  backendProviders?: { infinite: string[]; cmux?: string[] };
  capabilities?: { signals: boolean; answer: boolean; push: boolean };
  providers: string[];
  projects: { id: string; name: string }[];
  terminal?: { stream: boolean; duplex: boolean; raw: boolean; snapshot?: boolean; control?: boolean };
};
// One identity per running browser tab, independent of its shared login cookie.
const clientId = crypto.randomUUID();
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly control?: ControlLease | null) {
    super(message);
  }
}
export function isControlRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 &&
    (error.code === "control-busy" || error.code === "control-lost");
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  controlId?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "X-Infinite-Client": clientId,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(controlId ? { "X-Infinite-Control": controlId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: controller.signal,
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "Connection failed", response.status, data.code ?? data.error, data.control);
  return data as T;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("The host did not respond.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export const names: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  opencode: "OpenCode",
  demo: "Rehearsal",
};

export type Api = typeof api;
export const ApiContext = createContext<Api>(api);
export const useApi = () => useContext(ApiContext);
export function connectApi(connection: Connection): { api: Api; close: () => void } {
  const client = createRemoteClient(connection);
  return { close: () => client.close(), api: async <T>(path: string, body?: unknown, method?: string, controlId?: string): Promise<T> => {
    try {
      return await client.request<T>(path, { method: (method ?? (body ? "POST" : "GET")) as "GET" | "POST" | "PUT" | "DELETE", body,
        headers: { "X-Infinite-Client": clientId, ...(controlId ? { "X-Infinite-Control": controlId } : {}) } });
    } catch (error) {
      if (error instanceof RemoteError) {
        const value = error.body as { error?: string; code?: string; control?: ControlLease } | undefined;
        throw new ApiError(error.message, error.status, value?.code ?? value?.error ?? error.code, value?.control);
      }
      throw error;
    }
  } };
}
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
