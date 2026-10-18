export type MonitorMember = {
  memberId: string;
  sessionId: string;
  role: string;
  revision: number;
  title: string;
  status: string;
};

export type BriefClaim = { text: string };
export type BriefReview = { priority: string; area: string; why: string; question: string };
export type BriefGuidance = { text: string; basis: string };
export type RepositoryBrief = {
  summary: string;
  architecture?: BriefClaim[];
  review?: BriefReview[];
  changes?: BriefClaim[];
  checks?: BriefClaim[];
  guidance?: BriefGuidance[];
  unknowns?: string[];
};
export type RepositorySummaryView = {
  engine?: string;
  model?: string;
  text?: string;
  at?: string;
  repository?: { generatedAt?: string; brief?: RepositoryBrief };
};
export type BriefingView = {
  state: "pending" | "running" | "ready" | "failed" | "unavailable" | "empty" | "unknown";
  error?: string;
  summary?: RepositorySummaryView;
};

const roleOrder = ["project-manager", "scout", "implementer", "integrator", "reviewer", "delivery"];

function rank(member: MonitorMember, revision: number) {
  const role = roleOrder.indexOf(member.role);
  return [
    member.revision === revision ? 0 : 1,
    member.status === "running" || member.status === "waiting" ? 0 : 1,
    role < 0 ? roleOrder.length : role,
  ];
}

export function monitorMembers<T extends MonitorMember>(members: T[], revision: number): T[] {
  return [...members].sort((left, right) => {
    const a = rank(left, revision);
    const b = rank(right, revision);
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return left.title.localeCompare(right.title) || left.memberId.localeCompare(right.memberId);
  });
}

export function summarySessionId(members: MonitorMember[], revision: number): string | undefined {
  const current = monitorMembers(members, revision).filter(member => member.revision === revision);
  return (current.find(member => member.role === "project-manager") ?? current[0] ?? monitorMembers(members, revision)[0])?.sessionId;
}

export function briefText(status: BriefingView | undefined): string {
  return status?.summary?.repository?.brief?.summary || status?.summary?.text || "";
}

function briefTime(status: BriefingView): string {
  return status.summary?.repository?.generatedAt ?? status.summary?.at ?? "";
}

export function chooseBrief(
  rows: { sessionId: string; status: BriefingView }[],
  coordinatorSessionId?: string,
): { sessionId: string; status: BriefingView } | undefined {
  const withText = rows.filter(row => briefText(row.status));
  const coordinator = rows.find(row => row.sessionId === coordinatorSessionId);
  const coordinatorText = withText.find(row => row.sessionId === coordinatorSessionId);
  if (coordinatorText) return coordinatorText;
  const newest = [...withText].sort((left, right) => briefTime(right.status).localeCompare(briefTime(left.status)))[0];
  if (newest) return newest;
  return coordinator ?? rows[0];
}
