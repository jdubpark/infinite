import type { ProductGoal } from "./goal-types.js";
import type { TeamView } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

export type GoalReleaseRecord = {
  goal: ProductGoal;
  control?: { teamId?: string };
  extensionIntent?: { teamId?: string };
  launch?: { request: { requestId: string } };
};

type Action = { requestId: string; revision: number };

type CancelReleasedGoalRunDeps<T extends GoalReleaseRecord> = {
  records: ReadonlyMap<string, T>;
  terminal: ReadonlySet<string>;
  teams: {
    get(id: string): TeamView;
    cancel(id: string, body: Action): Promise<TeamView>;
  };
  enqueue(id: string, task: () => Promise<TeamView>): Promise<TeamView>;
  refresh(stored: T, team: TeamView): void;
  event(stored: T, text: string): void;
  save(stored: T): void;
};

const GOAL_OWNED_MESSAGE = "Control this feature from its goal. Team decisions can still be answered here.";

export function goalOwnerId<T extends GoalReleaseRecord>(records: ReadonlyMap<string, T>, teamId: string, goalId?: string): string | undefined {
  if (goalId && records.has(goalId)) return goalId;
  for (const entry of records.values()) {
    if (entry.goal.activeTeamId === teamId
      || entry.goal.cycles.some(cycle => cycle.teamId === teamId)
      || entry.control?.teamId === teamId
      || entry.extensionIntent?.teamId === teamId
      || entry.launch?.request.requestId === teamId) return entry.goal.id;
  }
  return undefined;
}

export function goalHoldsTeamRun<T extends GoalReleaseRecord>(records: ReadonlyMap<string, T>, terminal: ReadonlySet<string>, teamId: string): boolean {
  for (const { goal, control, extensionIntent, launch } of records.values()) {
    const referencesCycle = goal.activeTeamId === teamId || goal.cycles.some(cycle => cycle.teamId === teamId);
    if (!terminal.has(goal.status) && (referencesCycle || launch?.request.requestId === teamId)) return true;
    if (control?.teamId === teamId || extensionIntent?.teamId === teamId) return true;
    if (goal.status === "limit-reached" && goal.stopReason === "deadline" && !(goal.standing && !goal.activeTeamId) && referencesCycle) return true;
  }
  return false;
}

export function cancelReleasedGoalRun<T extends GoalReleaseRecord>(deps: CancelReleasedGoalRunDeps<T>, teamId: string, body: Action): Promise<TeamView> {
  const team = deps.teams.get(teamId);
  const ownerId = goalOwnerId(deps.records, teamId, team.goal?.id);
  const execute = async () => {
    if (goalHoldsTeamRun(deps.records, deps.terminal, teamId)) throw new TeamError(409, "goal-owned-team", GOAL_OWNED_MESSAGE);
    const current = deps.teams.get(teamId);
    if (!["blocked", "paused", "cancelled"].includes(current.status)) throw new TeamError(409, "goal-owned-team", GOAL_OWNED_MESSAGE);
    const cancelled = await deps.teams.cancel(teamId, body);
    const stored = ownerId ? deps.records.get(ownerId) : undefined;
    const cycle = stored?.goal.cycles.find(value => value.teamId === teamId);
    if (stored && cycle && cycle.status !== "cancelled") {
      deps.refresh(stored, cancelled);
      deps.event(stored, `The owner cancelled feature ${cycle.cycle}'s stopped run after the goal had stopped.`);
      deps.save(stored);
    }
    return cancelled;
  };
  return ownerId ? deps.enqueue(ownerId, execute) : execute();
}
