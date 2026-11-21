import { publicAttention, type Manager } from "./manager.js";
import { learningPurpose } from "./types.js";
import type { CmuxSessions } from "./cmux/index.js";
import type { TeamService } from "./teams.js";
import type { GoalService } from "./goals.js";
import type { MissionService } from "./missions.js";
import { promptOwner } from "./notifier.js";
import { buildDecisionQueue, type DecisionQueue } from "./decision-queue.js";

/** Reads queue candidates without building list views or scheduling title readings. */
export async function readDecisionQueue(input: {
  manager: Pick<Manager, "list">;
  cmux: Pick<CmuxSessions, "list"> | undefined;
  permissions: { holder(sessionId: string, promptId: number): "agent" | "owner" | "undecided" };
  teams: Pick<TeamService, "decisionQueueCandidates" | "decisionQueueSessionOrigin" | "promptOwner">;
  goals: Pick<GoalService, "decisionAnswerable">;
  missions: Pick<MissionService, "decisionQueueCandidates">;
}): Promise<DecisionQueue> {
  const native = (await input.manager.list({ includeFullMessage: true }))
    .filter(session => !learningPurpose(session.purpose));
  const known = new Set(native.filter(session => session.status === "running" && session.nativeSession && session.pid)
    .map(session => `${session.provider}:${session.nativeSession!.id}:${session.pid}`));
  const external = input.cmux ? (await input.cmux.list()).filter(session => session.status !== "running" || !session.nativeSession || !session.pid ||
    !known.has(`${session.provider}:${session.nativeSession.id}:${session.pid}`)) : [];
  const sessions = [...native, ...external].map(session => {
    const fullAttention = session.attention;
    const waiting = fullAttention.state === "needs-you" && Boolean(fullAttention.prompt);
    const owner = waiting ? promptOwner({ id: session.id, attention: fullAttention }, input.permissions, input.teams) : "undecided";
    return { id: session.id, title: session.title, projectId: session.projectId, status: session.status, attention: publicAttention(fullAttention), owner,
      team: owner === "user" && session.team ? input.teams.decisionQueueSessionOrigin(session.team.runId, session.team.role) : undefined };
  });
  const teams = input.teams.decisionQueueCandidates().map(candidate => ({ ...candidate,
    goalCanAnswer: !candidate.goal || input.goals.decisionAnswerable(candidate.id, candidate.held) }));
  return buildDecisionQueue({ sessions, teams, missions: input.missions.decisionQueueCandidates() });
}
