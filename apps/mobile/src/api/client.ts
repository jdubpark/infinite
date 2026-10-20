import type { Attention, Provider } from "@infinite/attention";
import { createRemoteClient, RemoteError, type RemoteAccessToken, type RemoteEvents, type RemoteRequestOptions } from "@infinite/remote";
import * as Crypto from "expo-crypto";
import { loadClientId } from "../store/connection";
import type { TeamLineup, TeamProject, TeamRole, TeamStatus } from "../features/teams/model";
import { APP_BACKGROUND_GRACE_MS, inForeground, onForegroundChange } from "./foreground";

export type Connection = { id?: string; machineId?: string; label?: string; url: string; token: string; relay?: { machineId: string }; access?: RemoteAccessToken };
export const connectionKey = (connection: Connection) => connection.id ?? `${connection.url}/${connection.relay?.machineId ?? "direct"}`;
/** `calls` counts api() requests in flight on this channel. */
type Remote = { secrets: string; client: ReturnType<typeof createRemoteClient>; calls: number };
const remotes = new Map<string, Remote>();
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
    saved = { secrets, client: createRemoteClient(connection, { randomBytes: Crypto.getRandomBytes }), calls: 0 };
    remotes.set(key, saved);
  }
  return saved;
}
function drop(key: string, entry: Remote) {
  if (remotes.get(key) === entry) remotes.delete(key);
  entry.client.close();
}
/** Replace idle channels after the same grace used by the live stream. */
let backgroundedAt = 0;
let backgroundResetTimer: ReturnType<typeof setTimeout> | undefined;
onForegroundChange((foreground) => {
  if (!foreground) {
    backgroundedAt = Date.now();
    clearTimeout(backgroundResetTimer);
    backgroundResetTimer = setTimeout(() => {
      backgroundResetTimer = undefined;
      if (!inForeground())
        for (const [key, entry] of remotes) if (entry.calls === 0) drop(key, entry);
    }, APP_BACKGROUND_GRACE_MS);
    return;
  }
  clearTimeout(backgroundResetTimer); backgroundResetTimer = undefined;
  if (Date.now() - backgroundedAt < APP_BACKGROUND_GRACE_MS) return;
  for (const [key, entry] of remotes) if (entry.calls === 0) drop(key, entry);
});
async function call<T>(entry: Remote, path: string, options: RemoteRequestOptions): Promise<T> {
  entry.calls++;
  try {
    return await entry.client.request<T>(path, options);
  } finally {
    entry.calls--;
  }
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
    /** Abort after this many milliseconds. Defaults to 12 seconds. */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const { timeoutMs = 12000, ...options } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Only reads (GET without a body) are retried or dropped on timeout; mutations never are.
  const read = (init.method ?? "GET") === "GET" && init.body === undefined;
  let saved: Remote | undefined;
  try {
    const headers = {
      "X-Infinite-Client": await loadClientId(),
      ...(init.control ? { "X-Infinite-Control": init.control } : {}),
    };
    const request = { ...options, headers, signal: controller.signal };
    // Both direct and relayed connections use the authenticated encrypted
    // channel. An unavailable endpoint never falls back to plaintext API calls.
    saved = remote(connection);
    try {
      try {
        return await call<T>(saved, path, request);
      } catch (error) {
        // A backgrounded app does not reconnect; its return poll recovers instead.
        if (!read || !(error instanceof RemoteError) || error.code !== "disconnected" || !inForeground()) throw error;
        return await call<T>(saved, path, request);
      }
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
    // A timed-out read may have left the channel unusable; don't drop it under another call.
    if (read && controller.signal.aborted && saved && saved.calls === 0) drop(remoteKey(connection), saved);
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
  return remote(connection).client.openEvents(options);
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
  /** Set on a session a mission coordinator runs (its coordinator or a subteam member). The host refuses input, stop, resume and control for it. */
  managedBy?: { kind: "mission"; missionId: string; teamId?: string };
  resumable?: boolean;
  /** Set once the owner archived this exited session; it leaves the live lists but keeps its record. */
  archivedAt?: string;
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
  capabilities?: { signals: boolean; answer: boolean; push: boolean; dictation?: { model: string } };
  teams?: { enabled: boolean; maxParallelism: number; lineup?: TeamLineup };
  goals?: { enabled: boolean };
  usage?: { enabled: boolean; budgets?: Record<string, unknown> };
};

/** Project group contract mirrored from the host for the mobile project picker. */
export type ProjectGroupRepo = { projectId: string; name: string; path: string };
export type ProjectGroup = {
  id: string; name: string; repos: ProjectGroupRepo[]; implicit: boolean; revision: number;
  createdAt: string; updatedAt: string;
};
export type ProjectGroupList = {
  groups: ProjectGroup[];
  suggestions: { name: string; repos: string[]; reason: "shared-parent" | "shared-linear-project" }[];
};
export type MissionStatus = "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";
export type CreateMissionRequest = {
  requestId: string; groupId: string; title?: string; objective: string; maxSubtasks?: number; maxMinutes?: number;
};
export type MissionActionRequest = { requestId: string; revision: number };
export type MissionTextRequest = MissionActionRequest & { text: string };
export type MissionSubtask = {
  id: string; repoProjectId: string; title: string; objective: string; size: "solo" | "team"; parallelism: number;
  dependsOn: string[]; status: "queued" | "running" | "done" | "cancelled" | "blocked"; teamId?: string; teamStatus?: TeamStatus;
};
export type MissionDecision = {
  id: string; question: string; options: string[]; createdAt: string; subtaskId?: string; childDecisionId?: string;
  answer?: string; answeredAt?: string; answeredBy?: "owner" | "coordinator";
};
export type MissionUsageTotals = {
  cost: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  messages: number; pricing: { configured: number; provider: number; unknown: number };
};
export type MissionUsage = {
  total: MissionUsageTotals; byProfile: Record<string, MissionUsageTotals>;
  byProvider: Partial<Record<Provider, MissionUsageTotals>>; unmeasuredMembers: number;
};
export type Mission = {
  id: string; groupId: string; groupName: string; repoProjectIds: string[]; title: string; objective: string;
  maxSubtasks: number; maxMinutes: number; deadlineAt: string; revision: number; status: MissionStatus;
  reason?: string; createdAt: string; updatedAt: string; lineup: TeamLineup;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  dispatchSummary?: string; subtasks: MissionSubtask[]; decisions: MissionDecision[];
  steering: { text: string; revision: number; at: string }[]; events: { at: string; text: string }[];
  result?: { summary: string; revision: number; at: string };
  usage?: MissionUsage;
};
export type BoardColumn = "needs-input" | "working" | "review" | "ended";
export type BoardItem = {
  kind: "mission" | "team" | "goal"; id: string; title: string; groupId?: string; projectName: string;
  column: BoardColumn; status: string; detail: string; updatedAt: string;
  subtasks?: { total: number; running: number; done: number };
};
export type Board = { items: BoardItem[] };

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
