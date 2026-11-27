import type { ProviderCapabilities, Session, TeamModelProfile, UsageTotals } from "../api";
import type { MissionStatus } from "../mission-model";

export type SwarmSession = Session;

export type TeamStatus = "planning" | "discovering" | "implementing" | "integrating" | "verifying" | "reviewing" | "delivering"
  | "merged" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "no-change" | "cancelled";

export type SwarmWaitReason = {
  kind: string;
  summary: string;
  memberId?: string;
  taskId?: string;
  since?: string;
  resetsAt?: string;
};

export type SwarmMember = {
  memberId: string; sessionId: string; role: string; revision: number; title: string; status: string;
  taskId?: string; provider?: string; modelProfile?: Pick<TeamModelProfile, "label" | "tier">; usage?: Pick<UsageTotals, "cost">;
  startedAt?: string; reportedAt?: string; lastActivityAt?: string; spinnerOnlySince?: string; pendingLimit?: boolean; stalledAt?: string; stoppedReason?: string;
};
export type SwarmTask = {
  id: string; title: string; status: "pending" | "running" | "waiting" | "integrated" | "blocked"; paths: string[];
  memberId?: string;
  changedPaths?: { paths: string[]; truncated: boolean };
};
export type SwarmTeam = {
  id: string; projectId: string; provider: string; title: string; status: TeamStatus; revision: number;
  createdAt: string; updatedAt: string; lastActivityAt?: string; baseCommit: string; headCommit?: string; missionId?: string;
  goal?: { id: string; cycle: number };
  lineup?: { coordinator: { tier?: "light" | "strong" } };
  members: SwarmMember[]; tasks: SwarmTask[];
  checks: { status: "running" | "passed" | "failed" | "interrupted"; revision: number }[];
  decisions: { id: string; revision: number; answer?: string }[];
  discovery?: { revision: number }; review?: { revision: number }; pullRequest?: unknown; deliveryReceipt?: unknown;
  permissions?: { maxDecisions: number }; permissionsRevokedAt?: string;
  permissionDecisions?: { targetSessionId: string; promptId: number; status: string }[];
  usage?: { total: UsageTotals; unmeasuredMembers?: number };
  workers?: { limit: number; max: number; running: number; ready: number };
  waitReasons?: SwarmWaitReason[];
};
export type SwarmMission = {
  id: string; title: string; status: MissionStatus; stopReason?: "deadline";
  createdAt: string; updatedAt: string;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  subtasks: { id: string; repoProjectId: string; title: string; dependsOn: string[]; status: "queued" | "running" | "done" | "cancelled" | "blocked"; teamId?: string }[];
  decisions: { id: string; answer?: string }[];
  lineup?: { coordinator: TeamModelProfile };
  usage?: { total: UsageTotals; unmeasuredMembers?: number };
};
export type SwarmInput = {
  sessions: SwarmSession[];
  teams: SwarmTeam[];
  missions: SwarmMission[];
  providerCapabilities?: Record<string, ProviderCapabilities>;
  now: number;
};

export const AGENT_STATES = ["needs-you", "in-review", "working", "waiting", "queued", "reported", "stopped", "fault"] as const;
export type AgentState = typeof AGENT_STATES[number];
export const STATE_LABEL: Record<AgentState, string> = {
  "needs-you": "needs you", "in-review": "in review", working: "working", waiting: "waiting",
  queued: "queued", reported: "reported", stopped: "stopped", fault: "fault",
};

export const STAGES = ["plan", "scout", "build", "integrate", "check", "review", "ship"] as const;
export type Stage = typeof STAGES[number];
export const STAGE_LABEL: Record<Stage, string> = { plan: "plan", scout: "scout", build: "build", integrate: "integ", check: "check", review: "review", ship: "ship" };

export type RoleCode = "PM" | "SC" | "IM" | "IN" | "RV" | "EV" | "DL" | "PR" | "MC" | "SO";
export const ROLE_NAME: Record<RoleCode, string> = {
  PM: "Project manager", SC: "Scout", IM: "Implementer", IN: "Integrator", RV: "Reviewer", EV: "Evaluator", DL: "Delivery",
  PR: "Permission reviewer", MC: "Mission coordinator", SO: "Solo session",
};

export type Hold = "input" | "paused" | "blocked";
export type Terminal = "review-ready" | "merge-reported" | "no-change" | "cancelled";

export interface Agent {
  id: string;
  sessionId?: string;
  swarmId: string;
  unitId?: string;
  projectId?: string;
  role: RoleCode;
  stage?: Stage;
  state: AgentState;
  earlier: boolean;
  limited: boolean;
  stalled: boolean;
  spinnerOnly: boolean;
  observable: boolean;
  title: string;
  provider: string;
  model?: string;
  tier?: "light" | "strong";
  taskId?: string;
  tool?: string;
  lastActivityAt?: string;
  since?: string;
  costUsd?: number;
}

type UnitBase = {
  id: string;
  swarmId: string;
  title: string;
  projectId: string;
  status: TeamStatus;
  revision: number;
  reached: Stage;
  checks: { passed: number; failed: number; running: number };
  workers?: { running: number; limit: number };
  agents: Agent[];
  side: Agent[];
  dependsOn: string[];
  waiting: number;
  costUsd?: number;
  unmeasured: number;
  goalCycle?: number;
  createdAt: string;
  lastActivityAt: string;
  baseCommit: string;
  headCommit?: string;
  tasks: SwarmTask[];
  waitReasons: SwarmWaitReason[];
};

export type LiveUnit = UnitBase & {
  live: true;
  active?: Stage;
  hold?: Hold;
  terminal?: undefined;
};

export type QuietUnit = UnitBase & {
  live: false;
  active?: undefined;
} & (
  | { hold?: undefined; terminal: Terminal }
  | { hold: Hold; terminal?: undefined }
);

export type Unit = LiveUnit | QuietUnit;

export interface Ghost { id: string; title: string; after: string[]; status: "queued" | "blocked" | "cancelled" }

type SwarmBase = {
  id: string;
  title: string;
  live: boolean;
  waiting: number;
  costUsd?: number;
  unmeasured: number;
  createdAt: string;
};

export type MissionSwarm = SwarmBase & {
  kind: "mission";
  coordinator?: Agent;
  units: Unit[];
  ghosts: Ghost[];
};

export type TeamSwarm = SwarmBase & {
  kind: "team";
  units: Unit[];
};

export type SoloSwarm = SwarmBase & {
  kind: "solo";
  live: true;
  loose: Agent[];
};

export type Swarm = MissionSwarm | TeamSwarm | SoloSwarm;

export interface SwarmTotals {
  byState: Record<AgentState, number>;
  agents: number;
  waitingOnPerson: number;
  slots: { running: number; limit: number };
  costUsd: number;
  unmeasured: number;
}
export interface SwarmModel {
  live: Swarm[];
  held: { id: string; title: string; status: MissionStatus; stopReason?: "deadline" }[];
  quiet: QuietUnit[];
  quietOlder: number;
  totals: SwarmTotals;
}

export type Selection = { kind: "agent"; id: string } | { kind: "unit"; id: string } | { kind: "area"; id: string } | null;

export interface ActivityStore {
  record(agents: { id: string; lastActivityAt?: string }[], now: number): void;
  buckets(id: string, now: number): number[];
}

export interface ViewProps {
  model: SwarmModel;
  selection: Selection;
  onSelect(selection: Selection): void;
  openSession(sessionId: string): void;
  openTeam(teamId: string): void;
  openMission(missionId: string): void;
  activity: ActivityStore;
  now: number;
}

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
