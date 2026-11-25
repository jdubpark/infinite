import { TeamError } from "./team-workspace.js";
import { autoPinned, autoRouted, coversPoint, escalationCandidates, fixedRuleFailure, memberLimit, scoutCandidates, scoutPool, type TeamMember, type TeamModelProfile, type TeamRun, type TeamScout, type TeamTask } from "./team-types.js";

export const PROFILE_MESSAGES = {
  singleProvider: "A single-provider team cannot select profiles from a configured lineup.",
  pool: "Every task must select an agentProfileId from the team's configured implementer pool.",
  autoPool: "A task's agentProfileId must name a profile in the team's configured implementer pool.",
  scoutPool: "Every scout must select an agentProfileId from the approved scout pool.",
  noEligible: "Auto routing needs an implementer profile that passes the fixed rules: not a contributor profile unless the policy allows one, and not on the reviewer's model.",
} as const;

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
    if (use === "plan") {
      if (id !== undefined && !run.lineup.implementers.some(profile => profile.id === id)) throw new TeamError(409, "invalid-agent-profile", PROFILE_MESSAGES.autoPool);
      continue;
    }
    if (id === undefined && coversPoint(run, "scout")) continue;
    if (!id || !scoutPool(run).some(profile => profile.id === id)) throw new TeamError(409, "invalid-agent-profile", PROFILE_MESSAGES.scoutPool);
  }
}

export function fallbackRule(run: TeamRun, role: TeamMember["role"]): ((profile: TeamModelProfile) => boolean) | undefined {
  const { routing, lineup } = run;
  if (routing?.mode !== "auto" || !lineup || (role !== "implementer" && role !== "scout")) return undefined;
  if (role === "scout" && !coversPoint(run, "scout")) return profile => fixedRuleFailure(lineup, routing.knobs, profile) !== "contributor";
  return profile => fixedRuleFailure(lineup, routing.knobs, profile) === undefined;
}

export function fallbackProfile(run: TeamRun, task: Pick<TeamTask, "agentProfileId">): TeamModelProfile {
  const { lineup, routing } = run;
  const passes = (profile: TeamModelProfile) => lineup !== undefined && routing !== undefined && fixedRuleFailure(lineup, routing.knobs, profile) === undefined;
  const picked = lineup?.implementers.find(profile => profile.id === task.agentProfileId && passes(profile));
  const chosen = picked ?? lineup?.implementers.find(passes);
  if (!chosen) throw new TeamError(409, "routing-no-eligible-profile", PROFILE_MESSAGES.noEligible);
  return chosen;
}

export function spareAttempts(run: TeamRun): number {
  const open = run.tasks.filter(task => task.status !== "integrated").length;
  return memberLimit(run) - run.members.length - open - 3;
}

export function routingComponent(run: Pick<TeamRun, "routing" | "routingRevokedAt">): string {
  return autoRouted(run) && run.routing ? run.routing.digest : "off";
}

export function escalationFallback(run: TeamRun, ownProfileId: string | undefined, namedProfileId: string | undefined): TeamModelProfile | undefined {
  const { lineup, routing } = run;
  if (!lineup || !routing) return undefined;
  const candidates = escalationCandidates(lineup, routing.knobs, ownProfileId);
  return candidates.find(profile => profile.id === namedProfileId) ?? candidates[0];
}

export function scoutFallback(run: TeamRun, scout: Pick<TeamScout, "agentProfileId">): TeamModelProfile | undefined {
  const { lineup, routing } = run;
  if (!lineup || !routing) return undefined;
  const candidates = scoutCandidates(lineup, routing.knobs);
  return candidates.find(profile => profile.id === scout.agentProfileId) ?? candidates[0];
}
