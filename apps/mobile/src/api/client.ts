import type { Attention, Provider } from "@infinite/attention";
import { createRemoteClient, RemoteError, sessionListReader, type RemoteAccessToken, type RemoteEvents, type RemoteRequestOptions } from "@infinite/remote";
import * as Crypto from "expo-crypto";
import { loadClientId } from "../store/connection";
import type { TeamLineup, TeamProject, TeamRole, TeamStatus } from "../features/teams/model";
import { APP_BACKGROUND_GRACE_MS, inForeground, onForegroundChange } from "./foreground";

export type Connection = { id?: string; machineId?: string; label?: string; url: string; token: string; relay?: { machineId: string }; access?: RemoteAccessToken };
export const connectionKey = (connection: Connection) => connection.id ?? `${connection.url}/${connection.relay?.machineId ?? "direct"}`;
type Remote = { secrets: string; client: ReturnType<typeof createRemoteClient>; calls: number };
const remotes = new Map<string, Remote>();
const sessionReaders = new Map<string, ReturnType<typeof sessionListReader<SessionRow>>>();
const remoteKey = (connection: Connection) => `${connectionKey(connection)}/${connection.url}/${connection.relay?.machineId ?? "direct"}`;
export function closeConnection(connection: Connection) {
  remotes.get(remoteKey(connection))?.client.close();
  remotes.delete(remoteKey(connection));
  sessionReaders.delete(remoteKey(connection));
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
    control?: string;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const { timeoutMs = 12000, ...options } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const read = (init.method ?? "GET") === "GET" && init.body === undefined;
  let saved: Remote | undefined;
  try {
    const headers = {
      "X-Infinite-Client": await loadClientId(),
      ...(init.control ? { "X-Infinite-Control": init.control } : {}),
    };
    const request = { ...options, headers, signal: controller.signal };
    saved = remote(connection);
    try {
      try {
        return await call<T>(saved, path, request);
      } catch (error) {
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

export function listSessions(connection: Connection): Promise<SessionRow[]> {
  const key = remoteKey(connection);
  let read = sessionReaders.get(key);
  if (!read) sessionReaders.set(key, read = sessionListReader<SessionRow>());
  return read(path => api(connection, path));
}

export function openEvents(connection: Connection, options: {
  topics: string[];
  after?: number;
  onEvent(event: { topic: string; data: unknown }): void;
  onClose(event: { code: number; error?: RemoteError }): void;
}): Promise<RemoteEvents> {
  return remote(connection).client.openEvents(options);
}

export type ControlLease = { id: string; label: string; expiresAt: number };
export type SessionRow = {
  id: string;
  machineId?: string;
  executionLocation?: "cloud" | "laptop";
  backend?: "infinite" | "cmux";
  projectId?: string;
  team?: { runId: string; memberId: string; revision: number; role: TeamRole; taskId?: string };
  managedBy?: { kind: "mission"; missionId: string; teamId?: string };
  resumable?: boolean;
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
  outputTailIncomplete?: true;
  seq: number;
  attention: Attention;
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
  teams?: { enabled: boolean; lineup?: TeamLineup };
  goals?: { enabled: boolean };
  usage?: { enabled: boolean; budgets?: Record<string, unknown> };
};

export type ProjectGroupKind = "owner" | "repository" | "implicit";
export type ProjectGroupCheckout = { projectId: string; name: string; path: string; primary: boolean; teamReady: boolean; identityFrom?: "source" | "host-scan" };
export type ProjectGroupRepo = { projectId: string; name: string; path: string; key?: string; checkouts: ProjectGroupCheckout[] };
export type ProjectGroup = {
  id: string; name: string; kind: ProjectGroupKind; hidden: boolean; repos: ProjectGroupRepo[]; implicit: boolean; revision: number;
  createdAt: string; updatedAt: string;
};
export type ProjectGroupSuggestion = { name: string; repos: string[]; groupIds: string[]; reason: "shared-parent" | "shared-linear-project" };
export type ProjectGroupList = { groups: ProjectGroup[]; suggestions: ProjectGroupSuggestion[] };
export type ProjectGroupUpdateRequest = { requestId: string; revision: number; name?: string; repos?: string[]; hidden?: boolean; primary?: string[] };
export type MissionStatus = "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";
export type MissionSubtask = {
  id: string; repoProjectId: string; title: string; objective: string; size: "solo" | "team"; parallelism: number;
  dependsOn: string[]; status: "queued" | "running" | "done" | "cancelled" | "blocked"; teamId?: string; teamStatus?: TeamStatus;
};
export type MissionDecision = {
  id: string; question: string; options: string[]; createdAt: string; subtaskId?: string; childDecisionId?: string;
  answer?: string; answeredAt?: string; answeredBy?: "owner" | "coordinator" | "connector"; source?: { kind: "connector"; id: string; name: string };
  recommendation?: { answers: string[]; reason: string; outcome?: "matched" | "different" | "other" };
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
  reason?: string;
  stopReason?: "deadline";
  clockStoppedAt?: string;
  createdAt: string; updatedAt: string; lineup: TeamLineup;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  dispatchSummary?: string; subtasks: MissionSubtask[]; decisions: MissionDecision[];
  steering: { text: string; revision: number; at: string; source?: { kind: "connector" | "github-review"; id: string; name: string } | "coordinator" | "slack" }[]; events: { at: string; text: string }[];
  result?: { summary: string; revision: number; at: string };
  usage?: MissionUsage;
};
export type BoardColumn = "needs-input" | "working" | "review" | "ended";
export type BoardAttempt = { workId: string; number: number; of: number; superseded: boolean };
export type BoardItem = {
  kind: "mission" | "team" | "goal"; id: string; title: string; groupId?: string; projectName: string;
  column: BoardColumn; status: string; detail: string; stopReason?: "deadline"; createdAt?: string; updatedAt: string;
  subtasks?: { total: number; running: number; done: number };
  attempt?: BoardAttempt;
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
export function pendingLabel(pending: PendingGeneration) {
  if (pending.reason === "session-running") return "a session is running";
  if (pending.reason === "cloud-changed") return "cloud files changed";
  if (pending.reason === "apply-failed") return `apply failed (${pending.category ?? "other"})${pending.message ? `: ${pending.message}` : ""}`;
  return "no session is running; ready to apply";
}
export type SourcePendingStatus = { reason: "session-running" | "fetch-failed" | "diverged" | "apply-failed"; category?: string; message?: string; since: string };
export type ProjectSourceStatus = { mode: "github" | "laptop"; repository?: string; baseBranch?: string; mirrorHead?: string; appliedHead?: string; fetchedAt?: string; appliedAt?: string; pending?: SourcePendingStatus; savedBranches?: string[] };
export type ProjectDetail = { id: string; name: string; sync: ProjectSyncStatus; source?: ProjectSourceStatus };
export function sourceLabel(source: ProjectSourceStatus, now = Date.now()) {
  const head = source.appliedHead ? source.appliedHead.slice(0, 8) : "none";
  const parts = [`Follows GitHub ${source.repository}@${source.baseBranch} · host ${head} · fetched ${ago(source.fetchedAt, now)}`];
  const pending = source.pending;
  if (pending?.reason === "session-running") parts.push("waiting: session running");
  else if (pending?.reason === "fetch-failed") parts.push(`fetch failed: ${pending.category ?? "other"}${pending.message ? `: ${pending.message}` : ""}`);
  else if (pending?.reason === "diverged") parts.push(`host diverged from origin/${source.baseBranch}`);
  else if (pending?.reason === "apply-failed") parts.push(`apply failed (${pending.category ?? "other"})`);
  const lastSaved = source.savedBranches?.[source.savedBranches.length - 1];
  if (lastSaved) parts.push(`saved local edits on ${lastSaved}`);
  return parts.join(" · ");
}
export function ago(iso?: string, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

export type AssessedState = "met" | "not-met" | "inconclusive";
export type ComposedState = AssessedState | "pending-owner";
export type VerdictCounts = { met: number; notMet: number; inconclusive: number; pendingOwner: number };
export type GoalAssessment = {
  verdictId: string; revision: number; head: string; kind: "reviewed" | "no-change";
  result: AssessedState; evaluatorResult?: AssessedState;
  reason?: "no-independent-evaluator" | "evaluator-unavailable" | "record-unavailable" | "context-too-large";
  counts: VerdictCounts; criteria: { id: string; state: ComposedState }[]; at: string; progress: number;
};
export type GoalVerdictView = {
  cycle: number; teamId: string; verdictId: string; kind: "reviewed" | "no-change"; head: string; at: string;
  label: "Agent assessment, provisional";
  result: AssessedState; evaluatorResult?: AssessedState; differs: boolean; reason?: string; counts: VerdictCounts; progress: number;
  owner?: { result: "achieved" | "not-achieved" | "inconclusive"; agrees?: boolean };
  criteria: { id: string; producer: "host" | "evaluator" | "owner"; state: ComposedState; label: "host receipt" | "agent assessment" | "waiting for you" | "your rating";
    reason?: string; evaluatorState?: AssessedState; receipt?: { handle: string; outcome: "pass" | "fail" | "unknown" }; handles?: string[]; note?: string }[];
  evaluator?: { profileId: string; family: string; sharedFamily: boolean; alsoReviewed: boolean };
  detail: "available" | "expired";
};
