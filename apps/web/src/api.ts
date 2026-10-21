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
  archivedAt?: string;
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
  usage?: UsageTotals;
  /** Set while a mission coordinator runs this session; people may only answer its provider prompts. */
  managedBy?: { kind: "mission"; missionId: string; teamId?: string };
};
export type LogEvent = {
  seq: number;
  at: string;
  type: "signal" | (string & {});
  data: Record<string, unknown>;
};
type TeamProfileDetails = { id: string; label: string; model: string; tier?: "light" | "strong"; dataUse?: "standard" | "contributor"; limitFallback?: string };
export type TeamModelProfile = TeamProfileDetails & ({ provider: "claude" | "codex"; effort: string } | { provider: "opencode"; variant?: string });
export type TeamLineup = { coordinator: TeamModelProfile; implementers: TeamModelProfile[]; integrator: TeamModelProfile; reviewer: TeamModelProfile; escalations?: TeamModelProfile[]; fallbacks?: TeamModelProfile[] };
export type TeamEvidence = { source: string; observation: string };
export type TeamBrief = { title: string; problem: string; evidence: TeamEvidence[]; dataShape: string; acceptance: string[]; expectedOutcome: string; uiChanges: boolean };
export type LinearTrackingView = {
  status: "pending" | "synced" | "blocked" | "error";
  reason?: string;
  checkedAt?: string;
  issue?: { id: string; identifier: string; url: string; title: string; description: string | null; state: { name: string; type: string }; updatedAt: string };
};
export type UsageTotals = { cost: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }; messages: number; pricing: { configured: number; provider: number; unknown: number } };
export type TeamUsage = { total: UsageTotals; byProfile: Record<string, UsageTotals>; byProvider: Partial<Record<string, UsageTotals>>; unmeasuredMembers: number };
export type UsageBudget = { usd: number; period: "day" | "week" | "month" };
/** A dollar figure plus the count of steps it could not price. A lower bound whenever `unpriced > 0`. */
export type Money = { usd: number; unpriced: number };
/** Only a provider's own API fills this in; it stays null otherwise and renders "—". */
export type Balance = { amount: number; currency: string; asOf: string; stale: boolean } | null;
/** `planSource` says whether a subscription fee is the config default or an owner edit; older hosts omit it. */
export type AccountView = { id: string; kind: "metered" | "subscription"; month?: Money; planUsd?: number; planSource?: "config" | "owner"; balance: Balance };
export type UsageSummary = {
  period: { start: string; end: string };
  providers: Record<string, { measured: boolean; period: { start: string; end: string }; spent?: UsageTotals; previous?: UsageTotals; budget?: UsageBudget; unmeasuredSessions: number }>;
  month: { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number };
  accounts: AccountView[];
};
export type UsageDaily = { tz: string; accounts: string[]; days: { date: string; usd: number; byAccount: Record<string, number> }[] };
/** `unmeasured` counts sessions and briefing runs that produced no usage data; older hosts omit it. */
export type UsageProjectRow = { id: string; name: string; total: Money; month: Money; spark: number[]; unmeasured?: number };
export type UsageProject = {
  id: string; name: string; total: Money; unmeasured?: number;
  byKind: { goals: number; teams: number; sessions: number; briefings: number };
  goals: { id: string; title: string; total: Money; tasks: number }[];
  teams: { id: string; title: string; goalId?: string; total: Money }[];
  sessions: { id: string; title: string; total: Money }[];
  briefings: { total: Money; runs: number; unmeasured: number };
};
export type TaskUsage = { usd: number; unpriced: number; tokens: number; attempts: number; profiles: string[] };
export type OwnerRating = { score: 1 | 2 | 3 | 4 | 5; note?: string; at: string };
export type RubricScore = { score: 1 | 2 | 3 | 4 | 5; why: string };
export type Rubric = { version: 1; correctness: RubricScore; cleanliness: RubricScore; extensibility: RubricScore; docs: RubricScore; reviewerProfileId: string };
export type ModelRow = {
  profileId: string; label: string; provider: string; role: string; metered: boolean;
  attempts: number; integrated: number; rate: number; rateInterval: [number, number] | null;
  medianUsd: number | null; medianTokens: number | null; usdPerMTok: number | null;
  medianMinutes: number | null; meanReviewRounds: number | null;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number; n: number } | null;
  owner: { mean: number; n: number } | null; enough: boolean;
};
export type Suggestion = { text: string; profileId: string; comparedTo: string; role: string; n: [number, number] };
export type Scorecard = { rubricVersion: 1; minAttempts: number; rows: ModelRow[]; suggestions: Suggestion[] };
/** A host-level record that a provider's account was seen at its limit. The reset time is the provider's own statement. */
export type ProviderLimit = { provider: string; detectedAt: string; resetsAt?: string; expiresAt: string; sessionId: string; runId?: string; confidence: "corroborated" };
export type LimitSwitch = { fromProfileId?: string; toProfileId: string; reason: string; resetsAt?: string; memberId: string; at: string };
/** Clock time as HH:MM with a zone abbreviation, in the viewer's time zone. */
export const clock = (iso: string) => new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(iso));
export type Me = {
  role: "owner" | "controller" | "viewer";
  environment: "cloud" | "local";
  machine?: { id: string; label: string; environment: string };
  backends?: ("infinite" | "cmux")[];
  backendProviders?: { infinite: string[]; cmux?: string[] };
  capabilities?: { signals: boolean; answer: boolean; push: boolean; dictation?: { model: string } };
  providers: string[];
  projects: { id: string; name: string; linear?: { enabled: boolean }; team?: { establishChecks?: true; checks: { command: string; args: string[] }[]; setup?: { command: string; args: string[] } } }[];
  teams?: { enabled: boolean; maxParallelism: number; lineup?: TeamLineup };
  goals?: { enabled: boolean };
  providerLimits?: ProviderLimit[];
  usage?: { enabled: boolean; budgets: Partial<Record<string, UsageBudget>> };
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
/** The host refused input for a session or team that a mission coordinator runs. Its error text is the message to show. */
export function isMissionManaged(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === "mission-managed";
}
export const missionManagedLine = "Run by its mission coordinator. Talk to the coordinator from the mission.";
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  controlId?: string,
  timeoutMs = 12000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
export type PendingGeneration = { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" | "apply-failed" | "awaiting-apply"; category?: string; message?: string };
export type ProjectSyncStatus = { projectId: string; lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: PendingGeneration };
/** Why a laptop generation waits, in the words the Create screen shows. */
export function pendingLabel(pending: PendingGeneration) {
  if (pending.reason === "session-running") return "a session is running";
  if (pending.reason === "cloud-changed") return "cloud files changed";
  if (pending.reason === "apply-failed") return `apply failed (${pending.category ?? "other"})${pending.message ? `: ${pending.message}` : ""}`;
  return "no session is running; ready to apply";
}
export type SourcePendingStatus = { reason: "session-running" | "fetch-failed" | "diverged" | "apply-failed"; category?: string; message?: string; since: string };
/** Where a workspace's files come from: the laptop, or a GitHub base branch the host mirrors. */
export type ProjectSourceStatus = { mode: "github" | "laptop"; repository?: string; baseBranch?: string; mirrorHead?: string; appliedHead?: string; fetchedAt?: string; appliedAt?: string; pending?: SourcePendingStatus; savedBranches?: string[] };
export type ProjectDetail = { id: string; name: string; sync: ProjectSyncStatus; source?: ProjectSourceStatus };
/** One line for a GitHub-tracked workspace, worded like the CLI status line. */
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
