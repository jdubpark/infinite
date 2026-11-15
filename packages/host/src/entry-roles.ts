import type { TeamMember, TeamRole, TeamRun } from "./team-types.js";

/** Roles that may hold the entry tools (spec part 4). Permission coordinators, delivery, and mission coordinators hold none. */
export const ENTRY_ROLES: ReadonlySet<TeamRole> = new Set<TeamRole>(["project-manager", "scout", "implementer", "integrator", "reviewer"]);

/** True only when the run pinned the switch and the role holds the entry tools. */
export function entryToolsFor(run: Pick<TeamRun, "blackboard">, role: TeamMember["role"] | "mission-coordinator"): boolean {
  return run.blackboard?.tools === true && ENTRY_ROLES.has(role as TeamRole);
}
