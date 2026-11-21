import type { Attention, Prompt } from "@infinite/attention";
import { publicAttention } from "./manager.js";
import type { Mission, MissionDecision, MissionStatus } from "./mission-types.js";
import type { TeamDecision, TeamStatus } from "./team-types.js";
import type { Session } from "./types.js";

/** One decision that waits on a person, from anywhere on the host. */
export type QueueDecision =
  | { kind: "session"; key: string; since: string; origin: QueueOrigin; answerPath: string; prompt: Prompt }
  | { kind: "team"; key: string; since: string; origin: QueueOrigin; answerPath: string; revision: number; decision: TeamDecision }
  | { kind: "mission"; key: string; since: string; origin: QueueOrigin; answerPath: string; revision: number; decision: MissionDecision };

export interface QueueOrigin {
  id: string;
  title: string;
  projectId?: string;
  team?: { id: string; title: string; role: string };
}

export interface DecisionQueue {
  decisions: QueueDecision[];
}

export interface DecisionQueueInput {
  sessions: {
    id: string;
    title: string;
    projectId?: string;
    status: Session["status"];
    attention: Attention;
    owner: "user" | "coordinator" | "undecided";
    team: { id: string; title: string; role: string } | undefined;
  }[];
  teams: {
    id: string;
    title: string;
    projectId: string;
    revision: number;
    status: TeamStatus;
    missionId: string | undefined;
    goal: boolean;
    goalCanAnswer: boolean;
    decisions: TeamDecision[];
  }[];
  missions: {
    id: string;
    title: string;
    projectId?: string;
    revision: number;
    status: MissionStatus;
    takesAnswers: boolean;
    decisions: MissionDecision[];
  }[];
}

const closedTeamStatuses = new Set<TeamStatus>(["cancelled", "ready-for-review", "merged", "no-change"]);

function originForSession(session: DecisionQueueInput["sessions"][number]): QueueOrigin {
  return {
    id: session.id,
    title: session.title,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    ...(session.team === undefined ? {} : { team: { ...session.team } }),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareQueueDecision(left: QueueDecision, right: QueueDecision): number {
  const leftTime = Date.parse(left.since);
  const rightTime = Date.parse(right.since);
  const byTime = Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime - rightTime
    : compareText(left.since, right.since);
  return byTime || compareText(left.key, right.key);
}

/** Selects answerable mission decisions from stored records without constructing views. */
export function missionDecisionQueueCandidates(
  records: Iterable<{ mission: Mission; ownerHalt?: { revision: number } }>,
  live: ReadonlySet<Mission["status"]>,
) {
  return [...records].flatMap(({ mission, ownerHalt }) => {
    const takesAnswers = live.has(mission.status) || mission.status === "paused" && ownerHalt?.revision === mission.revision;
    const decisions = mission.decisions.filter(item => !item.answer);
    return takesAnswers && decisions.length ? [{ id: mission.id, title: mission.title, revision: mission.revision,
      status: mission.status, takesAnswers, decisions: structuredClone(decisions) }] : [];
  });
}

/** Collects unanswered prompts and decisions that a person can answer now. */
export function buildDecisionQueue(input: DecisionQueueInput): DecisionQueue {
  const decisions: QueueDecision[] = [];

  for (const session of input.sessions) {
    if (session.status === "exited" || session.attention.state !== "needs-you" || session.owner !== "user") continue;
    const prompt = publicAttention(session.attention).prompt;
    if (!prompt) continue;
    decisions.push({
      kind: "session",
      key: `session:${session.id}:${prompt.id}`,
      since: session.attention.since,
      origin: originForSession(session),
      answerPath: `/api/sessions/${session.id}/answer`,
      prompt,
    });
  }

  for (const team of input.teams) {
    if (team.status === "paused" || closedTeamStatuses.has(team.status) || team.missionId !== undefined || (team.goal && !team.goalCanAnswer)) continue;
    for (const decision of team.decisions) {
      if (decision.revision !== team.revision || decision.answer) continue;
      decisions.push({
        kind: "team",
        key: `team:${team.id}:${decision.id}`,
        since: decision.createdAt,
        origin: { id: team.id, title: team.title, projectId: team.projectId },
        answerPath: `/api/teams/${team.id}/decisions/${decision.id}/answer`,
        revision: team.revision,
        decision: structuredClone(decision),
      });
    }
  }

  for (const mission of input.missions) {
    if (!mission.takesAnswers) continue;
    for (const decision of mission.decisions) {
      if (decision.answer) continue;
      decisions.push({
        kind: "mission",
        key: `mission:${mission.id}:${decision.id}`,
        since: decision.createdAt,
        origin: { id: mission.id, title: mission.title },
        answerPath: `/api/missions/${mission.id}/answer/${decision.id}`,
        revision: mission.revision,
        decision: structuredClone(decision),
      });
    }
  }

  decisions.sort(compareQueueDecision);
  return { decisions };
}
