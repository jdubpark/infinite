import { TeamError } from "./team-workspace.js";
import { autoPinned, autoRouted, fixedRuleFailure, memberLimit, scoutPool, type TeamMember, type TeamModelProfile, type TeamRun, type TeamTask } from "./team-types.js";

/** Refusal texts. `singleProvider` and `pool` are main's, verbatim; the others are new in `auto`. */
export const PROFILE_MESSAGES = {
  singleProvider: "A single-provider team cannot select profiles from a configured lineup.",
  pool: "Every task must select an agentProfileId from the team's configured implementer pool.",
  autoPool: "A task's agentProfileId must name a profile in the team's configured implementer pool.",
  scoutPool: "Every scout must select an agentProfileId from the approved scout pool.",
  noEligible: "Auto routing needs an implementer profile that passes the fixed rules: not a contributor profile unless the policy allows one, and not on the reviewer's model.",
} as const;

/** Moved from TeamService.taskProfiles. Outside an auto-pinned run this is main's check, message for message. */
export function assertTaskProfiles(run: TeamRun, tasks: readonly { agentProfileId?: string }[], use: "plan" | "scouts"): void {
  for (const task of tasks) {
    const id = task.agentProfileId;
    if (!run.lineup) {
      if (id !== undefined) throw new TeamError(409, "invalid-agent-profile", PROFILE_MESSAGES.singleProvider);
      continue;
    }
    if (!autoPinned(run)) {
      if (!id || !run.lineup.implementers.some(profile => profile.id === id)) throw new TeamError(409, "invalid-agent-profile", PROFILE_MESSAGES.pool);
      continue;
    }
    // A plan may omit the profile: the host chooses it at the start. A named one must still be in the lineup.
    if (use === "plan") {
      if (id !== undefined && !run.lineup.implementers.some(profile => profile.id === id)) throw new TeamError(409, "invalid-agent-profile", PROFILE_MESSAGES.autoPool);
      continue;
    }
    if (!id || !scoutPool(run).some(profile => profile.id === id)) throw new TeamError(409, "invalid-agent-profile", PROFILE_MESSAGES.scoutPool);
  }
}

/**
 * The limit fallback predicate of an implementer or a scout in an auto-pinned run; undefined for every other role and run.
 * A member's fallback follows the rule of the pool it starts from: an implementer, escalated or not, passes rules 1 and 2;
 * a scout passes rule 1, as `scoutPool` does.
 */
export function fallbackRule(run: TeamRun, role: TeamMember["role"]): ((profile: TeamModelProfile) => boolean) | undefined {
  const { routing, lineup } = run;
  if (routing?.mode !== "auto" || !lineup || (role !== "implementer" && role !== "scout")) return undefined;
  if (role === "scout") return profile => fixedRuleFailure(lineup, routing.knobs, profile) !== "contributor";
  return profile => fixedRuleFailure(lineup, routing.knobs, profile) === undefined;
}

/** The coordinator's pick when it passes rules 1 and 2, else the default profile. Throws 409 `routing-no-eligible-profile` when none passes. */
export function fallbackProfile(run: TeamRun, task: Pick<TeamTask, "agentProfileId">): TeamModelProfile {
  const { lineup, routing } = run;
  const passes = (profile: TeamModelProfile) => lineup !== undefined && routing !== undefined && fixedRuleFailure(lineup, routing.knobs, profile) === undefined;
  const picked = lineup?.implementers.find(profile => profile.id === task.agentProfileId && passes(profile));
  const chosen = picked ?? lineup?.implementers.find(passes);
  if (!chosen) throw new TeamError(409, "routing-no-eligible-profile", PROFILE_MESSAGES.noEligible);
  return chosen;
}

/** memberLimit(run) − run.members.length − (tasks whose status is not "integrated") − 3. May be negative. */
export function spareAttempts(run: TeamRun): number {
  const open = run.tasks.filter(task => task.status !== "integrated").length;
  return memberLimit(run) - run.members.length - open - 3;
}

/** C7 component 5: run.routing.digest while autoRouted(run), else "off". */
export function routingComponent(run: Pick<TeamRun, "routing" | "routingRevokedAt">): string {
  return autoRouted(run) && run.routing ? run.routing.digest : "off";
}
