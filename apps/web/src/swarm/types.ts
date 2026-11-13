import type { Session, TeamModelProfile, UsageTotals } from "../api";

// ---- Inputs: structural subsets of the host's session, team, and mission lists. ----

export type SwarmSession = Session;

export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "delivering"
  | "merged" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";

export type SwarmMember = {
  memberId: string; sessionId: string; role: string; revision: number; title: string; status: string;
  taskId?: string; provider?: string; modelProfile?: TeamModelProfile; usage?: UsageTotals;
  startedAt?: string; reportedAt?: string; lastActivityAt?: string; pendingLimit?: boolean; stalledAt?: string; stoppedReason?: string;
};
export type SwarmTask = {
  id: string; title: string; status: "pending" | "running" | "waiting" | "integrated" | "blocked"; dependsOn: string[]; paths: string[];
  memberId?: string; commit?: string;
  /** Paths the host read from Git for this task's integrated diff. */
  changedPaths?: { paths: string[]; truncated: boolean };
};
export type SwarmTeam = {
  id: string; projectId: string; provider: string; title: string; status: TeamStatus; revision: number;
  createdAt: string; updatedAt: string; baseCommit: string; headCommit?: string; missionId?: string;
  goal?: { id: string; cycle: number };
  lineup?: { coordinator: { tier?: "light" | "strong" } };
  members: SwarmMember[]; tasks: SwarmTask[];
  checks: { status: "running" | "passed" | "failed" | "interrupted"; revision: number }[];
  decisions: { id: string; revision: number; answer?: string }[];
  discovery?: { revision: number }; review?: { revision: number }; pullRequest?: unknown; deliveryReceipt?: unknown;
  /** Owner delegation of routine one-shot permissions; absent on runs without it. */
  permissions?: { maxDecisions: number }; permissionsRevokedAt?: string;
  permissionDecisions?: { targetSessionId: string; promptId: number; status: string }[];
  usage?: { total: UsageTotals };
  workers?: { limit: number; max: number; running: number; ready: number };
};
export type SwarmMission = {
  id: string; title: string; status: "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";
  createdAt: string; updatedAt: string;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  subtasks: { id: string; repoProjectId: string; title: string; dependsOn: string[]; status: "queued" | "running" | "done" | "cancelled" | "blocked"; teamId?: string }[];
  decisions: { id: string; answer?: string }[];
  lineup?: { coordinator: TeamModelProfile };
  usage?: { total: UsageTotals };
};
export type SwarmInput = { sessions: SwarmSession[]; teams: SwarmTeam[]; missions: SwarmMission[]; now: number };

// ---- Model: what the three views render. ----

/** Display order: the states that ask for attention lead. */
export const AGENT_STATES = ["needs-you", "in-review", "working", "waiting", "queued", "reported", "stopped", "fault"] as const;
export type AgentState = typeof AGENT_STATES[number];
export const STATE_LABEL: Record<AgentState, string> = {
  "needs-you": "needs you", "in-review": "in review", working: "working", waiting: "waiting",
  queued: "queued", reported: "reported", stopped: "stopped", fault: "fault",
};

export const STAGES = ["plan", "scout", "build", "integrate", "check", "review", "ship"] as const;
export type Stage = typeof STAGES[number];
export const STAGE_LABEL: Record<Stage, string> = { plan: "plan", scout: "scout", build: "build", integrate: "integ", check: "check", review: "review", ship: "ship" };

/** PM project manager, SC scout, IM implementer, IN integrator, RV reviewer, DL delivery, PR permission reviewer, MC mission coordinator, SO solo session. */
export type RoleCode = "PM" | "SC" | "IM" | "IN" | "RV" | "DL" | "PR" | "MC" | "SO";
export const ROLE_NAME: Record<RoleCode, string> = {
  PM: "Project manager", SC: "Scout", IM: "Implementer", IN: "Integrator", RV: "Reviewer", DL: "Delivery",
  PR: "Permission reviewer", MC: "Mission coordinator", SO: "Solo session",
};

export type Hold = "input" | "paused" | "blocked";
/** Agent or host reports, never host verification of a merge or of completion. */
export type Terminal = "review-ready" | "merge-reported" | "no-change" | "cancelled";

export interface Agent {
  /** Member ID, or the session ID for a mission coordinator or solo session. */
  id: string;
  sessionId?: string;
  swarmId: string;
  unitId?: string;
  /** The unit's project, or a solo session's project; absent for a mission coordinator. */
  projectId?: string;
  role: RoleCode;
  /** The lane stage this role sits on; absent for PR, MC, and SO. */
  stage?: Stage;
  state: AgentState;
  /** A member of an earlier revision that is still running or waiting. */
  earlier: boolean;
  limited: boolean;
  stalled: boolean;
  /** False when the provider records no tool inputs (anything but Claude Code and Codex). */
  observable: boolean;
  title: string;
  provider: string;
  model?: string;
  tier?: "light" | "strong";
  taskId?: string;
  /** The loud tool the host reports as in flight; often absent. */
  tool?: string;
  lastActivityAt?: string;
  /** When the current attention state began. */
  since?: string;
  costUsd?: number;
}
export interface Unit {
  /** Team run ID. */
  id: string;
  swarmId: string;
  title: string;
  projectId: string;
  status: TeamStatus;
  revision: number;
  live: boolean;
  active?: Stage;
  reached: Stage;
  hold?: Hold;
  terminal?: Terminal;
  checks: { passed: number; failed: number; running: number };
  workers?: { running: number; limit: number };
  /** Agents on a stage, in stage order. Empty for a unit that is not live. */
  agents: Agent[];
  /** Agents drawn beside the lane: the permission reviewer. */
  side: Agent[];
  /** IDs of units this one waits on, from mission subtask dependencies. */
  dependsOn: string[];
  /** Open owner decisions of the current revision; zero for mission-managed units. */
  waiting: number;
  costUsd?: number;
  goalCycle?: number;
  createdAt: string;
  updatedAt: string;
  baseCommit: string;
  headCommit?: string;
  tasks: SwarmTask[];
}
/** A mission subtask that has no team yet. */
export interface Ghost { id: string; title: string; after: string[]; status: "queued" | "blocked" | "cancelled" }
export interface Swarm {
  /** Mission ID, team ID, or "solo". */
  id: string;
  kind: "mission" | "team" | "solo";
  title: string;
  live: boolean;
  coordinator?: Agent;
  units: Unit[];
  ghosts: Ghost[];
  /** Solo sessions; empty for other kinds. */
  loose: Agent[];
  /** Person-owned prompts plus open owner decisions in this swarm. */
  waiting: number;
  costUsd?: number;
  createdAt: string;
}
export interface SwarmTotals {
  /** Agents of live swarms only. */
  byState: Record<AgentState, number>;
  agents: number;
  waitingOnPerson: number;
  slots: { running: number; limit: number };
  costUsd: number;
}
export interface SwarmModel {
  live: Swarm[];
  /** Swarms with no live unit, updated in the last 72 hours, newest first, at most 12. */
  quiet: Swarm[];
  quietOlder: number;
  totals: SwarmTotals;
}

export type Selection = { kind: "agent"; id: string } | { kind: "unit"; id: string } | { kind: "area"; id: string } | null;

/** Page-observed activity: whether each agent's last-activity time advanced, in ten-second buckets. */
export interface ActivityStore {
  record(agents: { id: string; lastActivityAt?: string }[], now: number): void;
  /** Thirty values from oldest to newest, each 0 to 1. */
  buckets(id: string, now: number): number[];
}

export interface ViewProps {
  model: SwarmModel;
  selection: Selection;
  onSelect(selection: Selection): void;
  openSession(sessionId: string): void;
  openTeam(teamId: string): void;
  activity: ActivityStore;
  now: number;
}

// ---- Host context contracts for the Graph view. ----

export type CodeMap =
  | { state: "ready"; lane: string; head: string; builtAt: string;
      areas: { id: string; files: number; symbols: number }[];
      links: { source: string; target: string; weight: number }[];
      truncated: { areas: boolean; links: boolean } }
  | { state: "disabled" }
  | { state: "unavailable"; reason: "none-built" | "too-large" };
export type FileTouch = { path: string; reads: number; edits: number; lastAt: string };
export type SessionTouches = { sessionId: string; observable: boolean; complete: boolean; graphQueries: number; files: FileTouch[]; truncated: boolean };
export type TeamTouches = { teamId: string; revision: number; members: (SessionTouches & { memberId: string })[] };
