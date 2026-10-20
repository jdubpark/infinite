/**
 * The phone's reading of a team's Jevcode summaries and agent logs. Like model.ts, this module has
 * no React Native imports so its choices can be tested under Node beside the web and CLI versions.
 */

export type TeamPerson = {
  memberId: string;
  sessionId: string;
  role: string;
  revision: number;
  title: string;
  status: string;
};

export type TeamBriefView = {
  state?: string;
  error?: string;
  summary?: {
    engine?: string;
    text?: string;
    at?: string;
    repository?: {
      generatedAt?: string;
      brief?: {
        summary?: string;
        architecture?: { text?: string }[];
        review?: { priority?: string; area?: string; why?: string; question?: string }[];
        changes?: { text?: string }[];
        checks?: { text?: string }[];
        guidance?: { basis?: string; text?: string }[];
        unknowns?: string[];
      };
    };
  };
};

const roleRank = ["project-manager", "scout", "implementer", "integrator", "reviewer", "delivery"];

export function orderedMembers<T extends Pick<TeamPerson, "memberId" | "role" | "revision" | "title" | "status">>(members: T[], revision: number): T[] {
  return [...members].sort((left, right) => {
    const rank = (member: T) => {
      const role = roleRank.indexOf(member.role);
      return [
        member.revision === revision ? 0 : 1,
        member.status === "running" || member.status === "waiting" ? 0 : 1,
        role < 0 ? roleRank.length : role,
      ];
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index += 1) if (leftRank[index] !== rightRank[index]) return leftRank[index]! - rightRank[index]!;
    return left.title.localeCompare(right.title) || left.memberId.localeCompare(right.memberId);
  });
}

export function summarySessionId(members: TeamPerson[], revision: number): string | undefined {
  const ordered = orderedMembers(members, revision);
  const current = ordered.filter(member => member.revision === revision);
  return (current.find(member => member.role === "project-manager") ?? current[0] ?? ordered[0])?.sessionId;
}

export function briefText(status: TeamBriefView | undefined): string {
  return (status?.summary?.repository?.brief?.summary || status?.summary?.text || "").trim();
}

export function briefTime(status: TeamBriefView | undefined): string {
  return status?.summary?.repository?.generatedAt || status?.summary?.at || "";
}

/** Prefer the coordinator's written brief, then the newest written brief, then the coordinator's status. */
export function chooseBrief(rows: { sessionId: string; status: TeamBriefView }[], coordinatorSessionId?: string) {
  const written = rows.filter(row => briefText(row.status));
  const coordinator = rows.find(row => row.sessionId === coordinatorSessionId);
  const coordinatorText = written.find(row => row.sessionId === coordinatorSessionId);
  if (coordinatorText) return coordinatorText;
  const newest = [...written].sort((left, right) => briefTime(right.status).localeCompare(briefTime(left.status)))[0];
  return newest ?? coordinator ?? rows[0];
}

/** Terminal text with color codes removed. Trailing blank lines go before the last `maxLines` are kept, so a bottom prompt stays in view. */
export function plainScreen(value: unknown, maxLines = 24): string {
  const raw = String(value ?? "");
  const plain = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  const lines = plain.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return lines.slice(-maxLines).join("\n").trim();
}

export function controlEventText(event: { type?: string; data?: Record<string, unknown> }): string {
  const data = event.data ?? {};
  const label = event.type === "signal" ? String(data.kind ?? "Signal")
    : event.type === "input-result" ? (data.state === "delivered" ? "Input delivered" : "Input")
    : event.type === "lifecycle" ? String(data.status ?? "Session updated")
    : String(event.type ?? "Event");
  const detail = data.message ?? data.text ?? data.error;
  return typeof detail === "string" && detail.trim() ? `${label}: ${detail}` : label;
}

/** "4 min ago" for a summary's age; empty when the time is unknown. */
export function relativeAge(iso: string | undefined, now: number): string {
  const time = Date.parse(iso ?? "");
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

