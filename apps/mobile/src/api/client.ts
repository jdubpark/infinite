import type { Attention, Provider } from "@infinite/attention";
import { createRemoteClient, RemoteError, type RemoteAccessToken, type RemoteEvents } from "@infinite/remote";
import * as Crypto from "expo-crypto";
import { loadClientId } from "../store/connection";
import type { TeamLineup, TeamProject, TeamRole } from "../features/teams/model";

export type Connection = { id?: string; machineId?: string; label?: string; url: string; token: string; relay?: { machineId: string }; access?: RemoteAccessToken };
export const connectionKey = (connection: Connection) => connection.id ?? `${connection.url}/${connection.relay?.machineId ?? "direct"}`;
const remotes = new Map<string, { secrets: string; client: ReturnType<typeof createRemoteClient> }>();
const remoteKey = (connection: Connection) => `${connectionKey(connection)}/${connection.url}/${connection.relay?.machineId ?? "direct"}`;
export function closeConnection(connection: Connection) {
  remotes.get(remoteKey(connection))?.client.close();
  remotes.delete(remoteKey(connection));
}
function remote(connection: Connection) {
  const key = remoteKey(connection);
  let saved = remotes.get(key);
  const secrets = JSON.stringify([connection.token, connection.access?.clientId, connection.access?.clientSecret]);
  if (!saved || saved.secrets !== secrets) {
    saved?.client.close();
    saved = { secrets, client: createRemoteClient(connection, { randomBytes: Crypto.getRandomBytes }) };
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
    // Both direct and relayed connections use the authenticated encrypted
    // channel. An unavailable endpoint never falls back to plaintext API calls.
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

export function openEvents(connection: Connection, options: {
  topics: string[];
  after?: number;
  onEvent(event: { topic: string; data: unknown }): void;
  onClose(event: { code: number; error?: RemoteError }): void;
}): Promise<RemoteEvents> {
  return remote(connection).openEvents(options);
}

/** One device's input lease; the host refuses input from every other device while it lasts. */
export type ControlLease = { id: string; label: string; expiresAt: number };
export type SessionRow = {
  id: string;
  machineId?: string;
  executionLocation?: "cloud" | "laptop";
  backend?: "infinite" | "cmux";
  projectId?: string;
  /** Present on a team member; the team scheduler owns its lifecycle. */
  team?: { runId: string; memberId: string; revision: number; role: TeamRole; taskId?: string };
  resumable?: boolean;
  title: string;
  reading?: {
    now?: { text: string; source: "jev"; for: string; at: string };
    waitingOnYou?: boolean;
    title?: { text: string; source: "first-line" | "jev-first-line" | "writer"; model?: string };
  };
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
  projects?: TeamProject[];
  capabilities?: { signals: boolean; answer: boolean; push: boolean };
  teams?: { enabled: boolean; maxParallelism: number; lineup?: TeamLineup };
  goals?: { enabled: boolean };
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
export type PendingGeneration = { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" | "apply-failed" | "awaiting-apply"; category?: string; message?: string };
export type ProjectSyncStatus = { projectId: string; lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: PendingGeneration };
/** Why a laptop generation waits, in the words the Create screen shows. */
export function pendingLabel(pending: PendingGeneration) {
  if (pending.reason === "session-running") return "a session is running";
  if (pending.reason === "cloud-changed") return "cloud files changed";
  if (pending.reason === "apply-failed") return `apply failed (${pending.category ?? "other"})${pending.message ? `: ${pending.message}` : ""}`;
  return "no session is running; ready to apply";
}
export type ProjectDetail = { id: string; name: string; sync: ProjectSyncStatus };
export function ago(iso?: string, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
