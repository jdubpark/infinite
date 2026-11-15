import { theme } from "../../theme";

/** The owner's view of the permission journal, as `GET /api/permissions/log` and `/decisions/:id` serve it. */
export type Verdict = "allow" | "reject" | "owner";
export type Mark = { requestId: string; decisionId: string; at: string; by: string; label: "wrong"; note: string };
export type DecisionEntry = {
  id: string; at: string; workspaceId: string; workspaceName?: string; projectId: string; projectName?: string;
  taskId: string; assignment: string; sessionId: string; role?: string; provider: string; family?: string;
  evidenceHash: string; action: { tool: string; summary: string }; rules: string[];
  tiers: { tier: "light" | "strong"; profileId: string; family: string; startedAt: string; endedAt: string }[];
  verdict: Verdict; code?: string; interruptClass?: string; note?: string; replayOf?: string; repeats?: string;
  raised: boolean; durationMs: number | null; rejectState?: "open" | "reopened" | "closed"; rateFlagged?: true;
  deliveries: { seq: number; at: string; kind: string; detail?: string }[]; marks: Mark[];
  controls: { kind: "reopen" | "close"; at: string; reason?: string }[];
};
export type RateFlag = { sessionId: string; workspaceId: string; lastHour: number; baselineMedian: number; threshold: number };
export type LogPage = { entries: DecisionEntry[]; next?: string; rateFlags: RateFlag[] | null };
export type Candidate = { decisionId: string; label: string; sources: ("marked-wrong" | "reopened")[]; decision: Omit<DecisionEntry, "note">; offeredAt: string };
export type LogFilter = "all" | "rejected" | "raised";

/** Hosts that serve the log say so in `/me`; older hosts and other roles see no entry point. */
export const decisionLogAvailable = (me: { role: string; permissions?: { decisionLog?: number } }) =>
  me.role === "owner" && me.permissions?.decisionLog === 1;

export function logPath(filter: LogFilter, before?: string) {
  const params = [filter === "all" ? "" : `${filter}=1`, before ? `before=${encodeURIComponent(before)}` : ""].filter(Boolean);
  return `/permissions/log${params.length ? `?${params.join("&")}` : ""}`;
}

const codeLabels: Record<string, string> = {
  "outside-workspace": "outside the workspace", unrelated: "not for the task", unsafe: "unsafe", incomplete: "incomplete evidence",
  uncertain: "uncertain", unavailable: "no reviewer in time", locked: "assignment locked", "needs-owner": "needs your answer", pending: "another call waits",
};
const classLabels: Record<string, string> = {
  "production-or-staging": "production or staging", credentials: "credentials", money: "money",
  "destructive-outside-workspace": "destructive outside the workspace", "global-or-account-settings": "global or account settings",
};
export const deliveryLabels: Record<string, string> = { intent: "Delivery started", receipt: "Delivered", refusal: "Refused before sending", uncertain: "Delivery uncertain", stale: "Request had changed" };
export const rejectStates: Record<string, string> = { open: "Open for its task", reopened: "Reopened by you", closed: "Closed with its task or direction" };
export const verdictColors: Record<Verdict, string> = { allow: theme.colors.running, reject: theme.colors.error, owner: theme.colors.warningInk };

export function verdictWords(entry: Pick<DecisionEntry, "verdict" | "code" | "interruptClass">) {
  if (entry.verdict === "allow") return "Allowed";
  if (entry.verdict === "owner") return `Sent to you · ${classLabels[entry.interruptClass ?? ""] ?? entry.interruptClass ?? "owner"}`;
  return `Rejected · ${codeLabels[entry.code ?? ""] ?? entry.code ?? "no code"}`;
}
export const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
export const isSessionId = (value: string) => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
