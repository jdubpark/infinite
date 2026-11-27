import type { TeamMember, TeamRole, TeamRun } from "./team-types.js";

export const ENTRY_ROLES: ReadonlySet<TeamRole> = new Set<TeamRole>(["project-manager", "scout", "implementer", "integrator", "reviewer"]);

export function entryToolsFor(run: Pick<TeamRun, "blackboard">, role: TeamMember["role"] | "mission-coordinator"): boolean {
  return run.blackboard?.tools === true && ENTRY_ROLES.has(role as TeamRole);
}
