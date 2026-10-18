/**
 * Team and Goal records as the host reports them, and the phone's reading of them. This module
 * has no React Native imports so its rules can be tested under Node. The host enforces roles and
 * revisions; these helpers only decide which controls to offer.
 */

export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";
export type TeamRole = "project-manager" | "scout" | "implementer" | "integrator" | "reviewer";
export type TeamCommand = { command: string; args: string[] };
export type ModelProfile = { id: string; label: string; provider: string; model: string; effort?: string; variant?: string; tier?: "light" | "strong"; dataUse?: "standard" | "contributor" };
export type TeamLineup = { coordinator: ModelProfile; integrator: ModelProfile; reviewer: ModelProfile; implementers: ModelProfile[]; escalations?: ModelProfile[]; fallbacks?: ModelProfile[] };
export type LinearTracking = { status: "pending" | "synced" | "blocked" | "error"; reason?: string; checkedAt?: string; issue?: { identifier: string; url: string; title: string; state: { name: string } } };
export type TeamEvidence = { source: string; observation: string };
export type TeamBrief = { title: string; problem: string; evidence: TeamEvidence[]; dataShape: string; acceptance: string[]; expectedOutcome: string; uiChanges: boolean };
export type TeamTask = { id: string; title: string; instructions: string; paths: string[]; dependsOn: string[]; status: "pending" | "running" | "waiting" | "integrated" | "blocked"; memberId?: string; commit?: string; summary?: string; agentProfileId?: string; escalation?: { toProfileId: string; reason: string } };
export type TeamMember = { memberId: string; sessionId: string; role: TeamRole; revision: number; title: string; status: string; taskId?: string; provider?: string; modelProfile?: ModelProfile; stoppedReason?: string };
export type TeamDecision = { id: string; memberId: string; revision: number; question: string; options: string[]; createdAt: string; answer?: string; answeredAt?: string };
export type TeamCheck = { command: TeamCommand; phase?: "setup"; status: "running" | "passed" | "failed" | "interrupted"; startedAt: string; finishedAt?: string; exitCode?: number | null; output: string; revision: number };
export type TeamView = {
  id: string; projectId: string; provider: string; title: string; objective: string; parallelism: number;
  revision: number; status: TeamStatus; createdAt: string; updatedAt: string; workspace: string;
  branch: string; baseCommit: string; headCommit?: string; tasks: TeamTask[]; members: TeamMember[];
  decisions: TeamDecision[]; checks: TeamCheck[]; steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[]; reason?: string; round: number;
  review?: { verdict: "approved" | "changes-requested"; summary: string; revision: number; uiEvidence?: string };
  lineup?: TeamLineup; linear?: LinearTracking; brief?: TeamBrief;
  goal?: { id: string; revision: number; cycle: number };
  noChange?: { summary: string; evidence: TeamEvidence[] };
};

export type GoalStatus = "running" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-opportunity" | "limit-reached" | "cancelled" | "achieved";
export type GoalResult = "achieved" | "not-achieved" | "inconclusive";
export type GoalCycle = { teamId: string; cycle: number; goalRevision: number; status: string; startedAt: string; finishedAt?: string; branch?: string; headCommit?: string; brief?: TeamBrief; reason?: string; memberCount: number };
export type ProductGoal = {
  id: string; projectId: string; title: string; objective: string; successCriteria: string;
  nonGoals: string[]; allowedPaths: string[]; evidence: string[];
  maxRuns: number; maxMinutes: number; maxMembers: number; parallelism: number;
  revision: number; status: GoalStatus; reason?: string; createdAt: string; updatedAt: string; deadlineAt: string;
  lineup: TeamLineup; linear?: LinearTracking; activeTeamId?: string; cycles: GoalCycle[]; memberCount: number;
  steering: { text: string; revision: number; at: string }[]; events: { at: string; text: string }[];
  outcomes: { result: GoalResult; summary: string; evidence: string; at: string; revision: number }[];
};

export type DeviceRole = "owner" | "controller" | "viewer";
export type TeamProject = { id: string; name: string; linear?: { enabled: boolean }; team?: { establishChecks?: true; checks: TeamCommand[]; setup?: TeamCommand } };

export const TEAM_LABELS: Record<TeamStatus, string> = {
  planning: "Planning", discovering: "Investigating", implementing: "Implementing", integrating: "Integrating",
  verifying: "Running checks", reviewing: "Reviewing", "needs-input": "Needs your input", paused: "Paused",
  blocked: "Blocked", "ready-for-review": "Ready for your review", "no-change": "No change proposed", cancelled: "Cancelled",
};
export const GOAL_LABELS: Record<GoalStatus, string> = {
  running: "Working", "needs-input": "Needs your input", paused: "Paused", blocked: "Blocked",
  "ready-for-review": "Ready for your review", "no-opportunity": "No opportunity found", "limit-reached": "Limit reached",
  cancelled: "Cancelled", achieved: "Outcome recorded: achieved",
};
export const OUTCOME_LABELS: Record<GoalResult, string> = { achieved: "Achieved", "not-achieved": "Not achieved", inconclusive: "Inconclusive" };
export const ROLE_NAMES: Record<TeamRole, string> = { "project-manager": "Coordinator", scout: "Scout", implementer: "Implementer", integrator: "Integrator", reviewer: "Reviewer" };

/** The StatePill tones: amber waits on a person, forest is working or ready, error is stuck. */
export type Tone = "amber" | "forest" | "muted" | "error";
export function teamTone(status: TeamStatus): Tone {
  if (status === "needs-input" || status === "paused") return "amber";
  if (status === "blocked") return "error";
  if (status === "cancelled" || status === "no-change") return "muted";
  return "forest";
}
export function goalTone(status: GoalStatus): Tone {
  if (status === "needs-input" || status === "paused" || status === "limit-reached") return "amber";
  if (status === "blocked") return "error";
  if (status === "cancelled" || status === "no-opportunity") return "muted";
  return "forest";
}

/** Newer revisions always win; within a revision the later update does. A late poll cannot undo a mutation's result. */
export function newer<T extends { revision: number; updatedAt: string }>(previous: T | null, next: T): T {
  if (!previous || next.revision > previous.revision || (next.revision === previous.revision && next.updatedAt >= previous.updatedAt)) return next;
  return previous;
}

/** Questions of the current revision that nobody has answered. Earlier revisions' questions no longer apply. */
export function openDecisions(team: TeamView) {
  return team.decisions.filter(decision => decision.revision === team.revision && decision.answer == null);
}

/** Members of the current revision whose agent sessions are live. */
export function activeMembers(team: TeamView) {
  return team.members.filter(member => member.revision === team.revision && ["running", "waiting"].includes(member.status));
}

/** One line under a list row's status pill: what the run waits on, why it stopped, or how far the plan got. */
export function teamRowLine(team: TeamView) {
  const open = openDecisions(team).length;
  if (open) return open === 1 ? "1 decision waits for you" : `${open} decisions wait for you`;
  const finished = ["ready-for-review", "cancelled", "no-change"].includes(team.status);
  if (team.reason && !finished) return team.reason;
  const integrated = team.tasks.filter(task => task.status === "integrated").length;
  if (team.tasks.length && !finished) return `${integrated}/${team.tasks.length} tasks integrated`;
  return team.objective.split("\n")[0];
}

/** A workspace can run a team once it has required checks or authorizes the team to establish them. */
export function teamReady(project?: TeamProject) {
  return Boolean(project?.team?.checks.length || project?.team?.establishChecks);
}

export function leadLabel(team: TeamView, providerName: (provider: string) => string) {
  return team.lineup ? `Coordinator: ${team.lineup.coordinator.label}` : providerName(team.provider);
}

export function profileSetting(profile: ModelProfile) {
  return profile.provider === "opencode" ? (profile.variant ? `variant ${profile.variant}` : "default variant") : `effort ${profile.effort}`;
}

/**
 * Which team controls to offer. Steering and lifecycle belong to standalone teams; a goal-owned
 * team is controlled from its goal, though its decisions stay answerable here. Pause, resume and
 * cancel are owner actions. Every control waits for a fresh poll.
 */
export function teamControls(team: TeamView, role: DeviceRole | undefined, fresh: boolean) {
  const acts = fresh && role !== undefined && role !== "viewer";
  const owns = fresh && role === "owner" && !team.goal && team.status !== "cancelled";
  return {
    answer: acts && !["paused", "cancelled"].includes(team.status),
    steer: acts && !team.goal && team.status !== "cancelled",
    pause: owns && !["paused", "blocked", "ready-for-review", "no-change"].includes(team.status),
    resume: owns && team.status === "paused",
    cancel: owns,
  };
}

/** A goal has stopped for good when it starts no further cycles and has none running. */
export function goalStopped(goal: ProductGoal) {
  return !goal.activeTeamId && ["blocked", "ready-for-review", "no-opportunity", "limit-reached", "cancelled", "achieved"].includes(goal.status);
}

/**
 * Which goal controls to offer. Resuming does not extend the deadline, so an expired goal cannot
 * resume; outcome assessment waits until no cycle can still change the work.
 */
export function goalControls(goal: ProductGoal, role: DeviceRole | undefined, fresh: boolean, now = 0) {
  const acts = fresh && role !== undefined && role !== "viewer";
  const owns = fresh && role === "owner" && !["cancelled", "achieved"].includes(goal.status);
  return {
    steer: acts && ["running", "needs-input"].includes(goal.status),
    pause: owns && ["running", "needs-input"].includes(goal.status),
    resume: owns && goal.status === "paused" && now < Date.parse(goal.deadlineAt),
    cancel: owns,
    outcome: acts && goalStopped(goal),
  };
}

/** One entry per non-empty line, as the goal form collects lists. */
export function lines(value: string) {
  return value.split("\n").map(line => line.trim()).filter(Boolean);
}

export function shortDate(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
