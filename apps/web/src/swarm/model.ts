import { approvalOwner } from "./approval";
import {
  AGENT_STATES, STAGES,
  type Agent, type AgentState, type Ghost, type Hold, type RoleCode, type Stage, type Swarm, type SwarmInput, type SwarmMember,
  type SwarmMission, type SwarmModel, type SwarmSession, type SwarmTeam, type SwarmTask, type Terminal, type TeamStatus, type Unit,
} from "./types";

type Attention = NonNullable<SwarmSession["attention"]>;
type Owner = "coordinator" | "person";

const HOUR_MS = 3_600_000;
const QUIET_WINDOW_MS = 72 * HOUR_MS;
const QUIET_LIMIT = 12;
const LIVE_AGENT_STATES: AgentState[] = ["queued", "working", "waiting", "in-review", "needs-you"];
const OBSERVABLE_PROVIDERS = new Set(["claude", "codex"]);

/** Status to the stage it is working on. Verifying runs the checks. */
const STAGE_BY_STATUS: Partial<Record<TeamStatus, Stage>> = {
  planning: "plan", discovering: "scout", implementing: "build", integrating: "integrate",
  verifying: "check", reviewing: "review", delivering: "ship",
};
const HOLD_BY_STATUS: Partial<Record<TeamStatus, Hold>> = { "needs-input": "input", paused: "paused", blocked: "blocked" };
const TERMINAL_BY_STATUS: Partial<Record<TeamStatus, Terminal>> = {
  "ready-for-review": "review-ready", merged: "merge-reported", "no-change": "no-change", cancelled: "cancelled",
};
const ROLES = new Map<string, { code: RoleCode; stage?: Stage }>([
  ["project-manager", { code: "PM", stage: "plan" }],
  ["scout", { code: "SC", stage: "scout" }],
  ["implementer", { code: "IM", stage: "build" }],
  ["integrator", { code: "IN", stage: "integrate" }],
  ["reviewer", { code: "RV", stage: "review" }],
  ["delivery", { code: "DL", stage: "ship" }],
  ["permission-coordinator", { code: "PR" }],
]);

const timeOf = (iso: string | undefined) => (iso === undefined ? 0 : Date.parse(iso) || 0);
const isFault = (attention?: Attention) => attention?.state === "recording-error" || attention?.state === "unavailable";

/** A member's state, applying the table's rows in order. */
function memberState(status: string, attention: Attention | undefined, owner: Owner): AgentState {
  const state = attention?.state;
  if (status === "queued") return "queued";
  if ((status === "running" || status === "waiting") && state === "needs-you") return owner === "coordinator" ? "in-review" : "needs-you";
  if (status === "running" && state === "working") return "working";
  if (status === "running" && (state === "turn-finished" || state === "idle")) return "waiting";
  if (status === "waiting") return "waiting";
  if (status === "reported") return "reported";
  if (status === "stopped") return "stopped";
  if (status === "unavailable" || isFault(attention)) return "fault";
  // A running member with no attention reading goes by its status alone.
  if (status === "running") return attention ? "waiting" : "working";
  return "waiting";
}

/** A mission coordinator stops with its status; otherwise its attention decides. */
function coordinatorState(status: "running" | "waiting" | "stopped", session?: SwarmSession): AgentState {
  if (status === "stopped") return "stopped";
  const attention = session?.attention;
  if (!attention) return status === "running" ? "working" : "waiting";
  if (attention.state === "needs-you") return "needs-you";
  if (isFault(attention)) return "fault";
  if (attention.state === "working") return "working";
  return "waiting";
}

/** A solo session is running or starting; its attention decides, defaulting to waiting. */
function soloState(session: SwarmSession): AgentState {
  if (session.status === "starting") return "queued";
  const attention = session.attention;
  if (attention?.state === "needs-you") return "needs-you";
  if (attention?.state === "working") return "working";
  if (isFault(attention)) return "fault";
  return "waiting";
}

/**
 * When a run last did something. The host rewrites a run's `updatedAt` on every save, including for settled runs,
 * so a run's age comes from what its agents did.
 */
function lastActivity(team: SwarmTeam): string {
  let latest = timeOf(team.createdAt);
  for (const member of team.members)
    latest = Math.max(latest, timeOf(member.startedAt), timeOf(member.lastActivityAt), timeOf(member.reportedAt));
  return new Date(latest).toISOString();
}

const stageIndex = (stage: Stage | undefined) => (stage === undefined ? STAGES.length : STAGES.indexOf(stage));

function sessionAgent(args: {
  id: string; swarmId: string; unitId?: string; projectId?: string; role: RoleCode; stage?: Stage; state: AgentState; earlier: boolean;
  session?: SwarmSession; title: string; provider: string; model?: string; tier?: "light" | "strong"; taskId?: string; costUsd?: number;
}): Agent {
  const attention = args.session?.attention;
  return {
    id: args.id,
    sessionId: args.session?.id,
    swarmId: args.swarmId,
    unitId: args.unitId,
    projectId: args.projectId,
    role: args.role,
    stage: args.stage,
    state: args.state,
    earlier: args.earlier,
    limited: Boolean(attention?.limit),
    stalled: false,
    observable: OBSERVABLE_PROVIDERS.has(args.provider),
    title: args.title,
    provider: args.provider,
    model: args.model,
    tier: args.tier,
    taskId: args.taskId,
    tool: attention?.lastTool?.tool,
    lastActivityAt: attention?.lastActivityAt,
    since: attention?.since,
    costUsd: args.costUsd,
  };
}

function memberAgent(team: SwarmTeam, member: SwarmMember, role: { code: RoleCode; stage?: Stage }, swarmId: string, sessions: Map<string, SwarmSession>): Agent {
  const session = sessions.get(member.sessionId);
  const attention = session?.attention;
  const owner: Owner = attention?.state === "needs-you" ? approvalOwner(team, member.sessionId, attention.prompt) : "person";
  const agent = sessionAgent({
    id: member.memberId, swarmId, unitId: team.id, projectId: team.projectId, role: role.code, stage: role.stage,
    state: memberState(member.status, attention, owner), earlier: member.revision !== team.revision, session,
    title: member.title, provider: member.provider ?? team.provider, model: member.modelProfile?.label,
    tier: member.modelProfile?.tier, taskId: member.taskId, costUsd: member.usage?.cost,
  });
  return {
    ...agent,
    sessionId: member.sessionId,
    limited: Boolean(member.pendingLimit) || agent.limited,
    stalled: Boolean(member.stalledAt),
    lastActivityAt: attention?.lastActivityAt ?? member.lastActivityAt,
  };
}

/** Stages with evidence in the current revision, plus the stage the status is working on. */
function reachedStage(team: SwarmTeam, members: SwarmMember[], active: Stage | undefined): Stage {
  const currentIds = new Set(members.filter(member => member.revision === team.revision).map(member => member.memberId));
  const hasRole = (role: string) => members.some(member => member.revision === team.revision && member.role === role);
  const taskHere = (task: SwarmTask) => task.memberId !== undefined && currentIds.has(task.memberId);
  const evidence: Stage[] = ["plan"];
  if (team.discovery?.revision === team.revision) evidence.push("scout");
  if (team.tasks.some(task => task.memberId !== undefined ? currentIds.has(task.memberId) : task.status !== "pending")) evidence.push("build");
  if (hasRole("integrator") || team.tasks.some(task => task.status === "integrated" && (task.memberId === undefined || taskHere(task)))) evidence.push("integrate");
  if (team.checks.some(check => check.revision === team.revision)) evidence.push("check");
  if (team.review?.revision === team.revision || hasRole("reviewer")) evidence.push("review");
  if (hasRole("delivery") || team.pullRequest !== undefined || team.deliveryReceipt !== undefined) evidence.push("ship");
  const furthest = Math.max(...evidence.map(stage => STAGES.indexOf(stage)), active ? STAGES.indexOf(active) : 0);
  return STAGES[furthest];
}

function buildUnit(args: {
  team: SwarmTeam; swarmId: string; sessions: Map<string, SwarmSession>; managed: boolean; dependsOn: string[];
}): Unit {
  const { team, swarmId, sessions, managed, dependsOn } = args;
  const shown = team.members.filter(member => member.revision === team.revision || member.status === "running" || member.status === "waiting");
  const agents: Agent[] = [];
  const side: Agent[] = [];
  for (const member of shown) {
    const role = ROLES.get(member.role);
    if (!role) continue;
    const agent = memberAgent(team, member, role, swarmId, sessions);
    (role.code === "PR" ? side : agents).push(agent);
  }
  const byStage = (a: Agent, b: Agent) => stageIndex(a.stage) - stageIndex(b.stage);
  agents.sort(byStage);

  const working = STAGE_BY_STATUS[team.status] !== undefined || team.status === "needs-input" || team.status === "paused";
  const live = working || [...agents, ...side].some(agent => LIVE_AGENT_STATES.includes(agent.state));
  const active = STAGE_BY_STATUS[team.status];
  const openDecisions = team.decisions.filter(decision => decision.revision === team.revision && decision.answer === undefined).length;
  const waiting = managed ? 0 : openDecisions;
  const currentChecks = team.checks.filter(check => check.revision === team.revision);

  return {
    id: team.id,
    swarmId,
    title: team.title,
    projectId: team.projectId,
    status: team.status,
    revision: team.revision,
    live,
    active,
    reached: reachedStage(team, team.members, active),
    hold: HOLD_BY_STATUS[team.status] ?? (waiting > 0 ? "input" : undefined),
    terminal: TERMINAL_BY_STATUS[team.status],
    checks: {
      passed: currentChecks.filter(check => check.status === "passed").length,
      failed: currentChecks.filter(check => check.status === "failed").length,
      running: currentChecks.filter(check => check.status === "running").length,
    },
    workers: team.workers ? { running: team.workers.running, limit: team.workers.limit } : undefined,
    agents: live ? agents : [],
    side: live ? side : [],
    dependsOn,
    waiting,
    costUsd: team.usage?.total.cost,
    goalCycle: team.goal?.cycle,
    createdAt: team.createdAt,
    lastActivityAt: lastActivity(team),
    baseCommit: team.baseCommit,
    headCommit: team.headCommit,
    tasks: team.tasks,
  };
}

/** Agents a swarm shows as needing a person: needs-you agents, unit decisions, and mission decisions. */
function waitingOn(swarm: Pick<Swarm, "units" | "coordinator" | "loose">, missionDecisions: number) {
  const agents = [...(swarm.coordinator ? [swarm.coordinator] : []), ...swarm.units.flatMap(unit => [...unit.agents, ...unit.side]), ...swarm.loose];
  return agents.filter(agent => agent.state === "needs-you").length + swarm.units.reduce((sum, unit) => sum + unit.waiting, 0) + missionDecisions;
}

/** Joins the host's session, team, and mission lists into the model the Swarm views render. */
export function buildSwarm(input: SwarmInput): SwarmModel {
  const sessions = new Map(input.sessions.map(session => [session.id, session]));
  const teamsById = new Map(input.teams.map(team => [team.id, team]));
  const missions = new Map(input.missions.map(mission => [mission.id, mission]));
  const memberSessions = new Set([
    ...input.teams.flatMap(team => team.members.map(member => member.sessionId)),
    ...input.missions.flatMap(mission => mission.coordinator ? [mission.coordinator.sessionId] : []),
  ]);
  const built: Swarm[] = [];

  for (const mission of input.missions) {
    const subtaskTeams = mission.subtasks.flatMap(subtask => subtask.teamId ? [subtask.teamId] : []);
    const ordered = [
      ...subtaskTeams.filter(id => teamsById.get(id)?.missionId === mission.id),
      ...input.teams.filter(team => team.missionId === mission.id && !subtaskTeams.includes(team.id)).map(team => team.id),
    ];
    const units = [...new Set(ordered)].map(id => {
      const team = teamsById.get(id) as SwarmTeam;
      const dependsOn = mission.subtasks
        .filter(subtask => subtask.teamId === team.id)
        .flatMap(subtask => subtask.dependsOn)
        .flatMap(dep => mission.subtasks.find(subtask => subtask.id === dep)?.teamId ?? []);
      return buildUnit({ team, swarmId: mission.id, sessions, managed: true, dependsOn });
    });
    const titles = new Map(mission.subtasks.map(subtask => [subtask.id, subtask.title]));
    const ghosts: Ghost[] = mission.subtasks.flatMap(subtask => {
      if (subtask.teamId && teamsById.has(subtask.teamId)) return [];
      if (subtask.status !== "queued" && subtask.status !== "blocked") return [];
      return [{ id: subtask.id, title: subtask.title, after: subtask.dependsOn.flatMap(dep => titles.get(dep) ?? []), status: subtask.status }];
    });
    const coordinatorSession = mission.coordinator ? sessions.get(mission.coordinator.sessionId) : undefined;
    const coordinator = mission.coordinator ? {
      ...sessionAgent({
        id: mission.coordinator.sessionId, swarmId: mission.id, role: "MC",
        state: coordinatorState(mission.coordinator.status, coordinatorSession), earlier: false,
        session: coordinatorSession, title: coordinatorSession?.title ?? "Mission coordinator",
        provider: coordinatorSession?.provider ?? mission.lineup?.coordinator.provider ?? "",
        model: mission.lineup?.coordinator.label, tier: mission.lineup?.coordinator.tier,
        costUsd: coordinatorSession?.usage?.cost,
      }),
      sessionId: mission.coordinator.sessionId,
    } : undefined;
    const swarm: Swarm = {
      id: mission.id, kind: "mission", title: mission.title,
      live: (coordinator !== undefined && mission.coordinator?.status !== "stopped") || units.some(unit => unit.live),
      coordinator, units, ghosts, loose: [],
      waiting: 0, costUsd: mission.usage?.total.cost, createdAt: mission.createdAt,
    };
    const openMissionDecisions = mission.decisions.filter(decision => decision.answer === undefined).length;
    swarm.waiting = waitingOn(swarm, openMissionDecisions);
    built.push(swarm);
  }

  for (const team of input.teams) {
    if (team.missionId !== undefined && missions.has(team.missionId)) continue;
    const unit = buildUnit({ team, swarmId: team.id, sessions, managed: false, dependsOn: [] });
    const swarm: Swarm = {
      id: team.id, kind: "team", title: team.title, live: unit.live, units: [unit], ghosts: [], loose: [],
      waiting: waitingOn({ units: [unit], loose: [] }, 0), costUsd: team.usage?.total.cost, createdAt: team.createdAt,
    };
    built.push(swarm);
  }

  const loose = input.sessions
    .filter(session => (session.status === "running" || session.status === "starting") && !session.archivedAt && !session.managedBy && !memberSessions.has(session.id))
    .map(session => sessionAgent({
      id: session.id, swarmId: "solo", projectId: session.projectId, role: "SO", state: soloState(session), earlier: false, session,
      title: session.title, provider: session.provider, costUsd: session.usage?.cost,
    }));
  if (loose.length > 0) {
    built.push({
      id: "solo", kind: "solo", title: "solo", live: true, units: [], ghosts: [], loose,
      waiting: loose.filter(agent => agent.state === "needs-you").length,
      costUsd: loose.reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0),
      createdAt: new Date(input.now).toISOString(),
    });
  }

  // Order never depends on state: a swarm that starts waiting on a person keeps its row. Its marks and the vitals carry that.
  const rank = (swarm: Swarm) => (swarm.kind === "solo" ? 1 : 0);
  const live = built
    .filter(swarm => swarm.live)
    .sort((a, b) => rank(a) - rank(b) || timeOf(b.createdAt) - timeOf(a.createdAt) || a.id.localeCompare(b.id));

  // Quiet runs are counted one by one, by the age of their own last activity: a mission's twenty finished runs are twenty rows to cap, not one.
  const cutoff = input.now - QUIET_WINDOW_MS;
  const quietAll = built.filter(swarm => !swarm.live && swarm.kind !== "solo").flatMap(swarm => swarm.units);
  const quiet = quietAll
    .filter(unit => timeOf(unit.lastActivityAt) >= cutoff)
    .sort((a, b) => timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt) || a.id.localeCompare(b.id))
    .slice(0, QUIET_LIMIT);

  const byState = Object.fromEntries(AGENT_STATES.map(state => [state, 0])) as Record<AgentState, number>;
  let agentCount = 0;
  for (const swarm of live) for (const agent of allAgents(swarm)) {
    byState[agent.state] += 1;
    agentCount += 1;
  }
  const units = live.flatMap(swarm => swarm.units);

  return {
    live,
    quiet,
    quietOlder: quietAll.length - quiet.length,
    totals: {
      byState,
      agents: agentCount,
      waitingOnPerson: live.reduce((sum, swarm) => sum + swarm.waiting, 0),
      slots: {
        running: units.reduce((sum, unit) => sum + (unit.workers?.running ?? 0), 0),
        limit: units.reduce((sum, unit) => sum + (unit.workers?.limit ?? 0), 0),
      },
      costUsd: live.reduce((sum, swarm) => sum + (swarm.costUsd ?? 0), 0),
    },
  };
}

/** The coordinator, then each unit's agents and side agents, then solo sessions. */
export function allAgents(swarm: Swarm): Agent[] {
  return [...(swarm.coordinator ? [swarm.coordinator] : []), ...swarm.units.flatMap(unit => [...unit.agents, ...unit.side]), ...swarm.loose];
}

export function findAgent(model: SwarmModel, id: string): Agent | undefined {
  for (const swarm of model.live) for (const agent of allAgents(swarm)) if (agent.id === id) return agent;
  return undefined;
}

export function findUnit(model: SwarmModel, id: string): Unit | undefined {
  for (const swarm of model.live) for (const unit of swarm.units) if (unit.id === id) return unit;
  return model.quiet.find(unit => unit.id === id);
}
