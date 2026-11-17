import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import { familyOf } from "./permission-families.js";
import type { TeamLineup, TeamModelProfile } from "./team-types.js";
import type { Provider } from "./types.js";

/** The lineup's `evaluators`; without the slot, the reviewer when its tier is "strong", then each strong escalation, first id wins, at most 4. Never written back. */
export function evaluatorProfiles(lineup: TeamLineup): TeamModelProfile[] {
  if (lineup.evaluators) return [...lineup.evaluators];
  const seen = new Set<string>();
  const derived: TeamModelProfile[] = [];
  for (const profile of [lineup.reviewer, ...(lineup.escalations ?? [])]) {
    if (profile.tier !== "strong" || seen.has(profile.id)) continue;
    seen.add(profile.id);
    derived.push(profile);
    if (derived.length === 4) break;
  }
  return derived;
}

export type NotReady = "no-lineup" | "no-eligible-evaluator";
export type AutonomyReadiness = { ready: true } | { ready: false; reason: NotReady };

/** C14, from the lineup alone: ready when an evaluator's family is known and differs from the coordinator's. */
export function autonomyReady(lineup: TeamLineup | undefined): AutonomyReadiness {
  if (!lineup) return { ready: false, reason: "no-lineup" };
  const coordinatorFamily = familyOf(lineup.coordinator);
  const ready = coordinatorFamily !== undefined && evaluatorProfiles(lineup).some(profile => {
    const family = familyOf(profile);
    return family !== undefined && family !== coordinatorFamily;
  });
  return ready ? { ready: true } : { ready: false, reason: "no-eligible-evaluator" };
}

/** The mode a new run or goal pins: an autonomous project whose lineup is not ready starts supervised, with the reason. Never used for a goal cycle. */
export function startMode(project: { autonomy?: unknown } | undefined, lineup: TeamLineup | undefined): { mode: AutonomyMode; reason?: NotReady } {
  if (autonomyOf(project) !== "autonomous") return { mode: "supervised" };
  const readiness = autonomyReady(lineup);
  return readiness.ready ? { mode: "autonomous" } : { mode: "supervised", reason: readiness.reason };
}

/** The fixed event text a C14 pin writes on the run or the goal. */
export function autonomyStartEvent(kind: "run" | "goal", reason: NotReady): string {
  const subject = kind === "run" ? "This run starts supervised:" : "This goal starts supervised:";
  const cause = reason === "no-lineup"
    ? "it has no lineup, so no evaluator of another model family can check it."
    : "no lineup profile of a model family other than the coordinator's can evaluate it.";
  return `${subject} ${cause}`;
}

/** The pin a new run records (part 4): "on" when pinned autonomous unless the setting is "off", or pinned supervised with the setting "on"; always "off" for a mission subteam or a handoff run. */
export function intentCheckPin(input: { autonomy: AutonomyMode; setting?: "on" | "off"; mission: boolean; handoff: boolean }): "on" | "off" {
  if (input.mission || input.handoff || input.setting === "off") return "off";
  if (input.autonomy === "autonomous") return "on";
  return input.setting === "on" ? "on" : "off";
}

export type CheckerChoice = { profile: TeamModelProfile } | { skipped: "no-eligible-profile" };

/**
 * The first evaluator whose family is known and differs from the coordinator's and the plan's author's, on a provider not in `limited`.
 * An unknown coordinator or author family, or no author, makes none eligible.
 */
export function chooseIntentChecker(lineup: TeamLineup | undefined, planAuthor: TeamModelProfile | undefined, limited: ReadonlySet<Provider>): CheckerChoice {
  if (!lineup) return { skipped: "no-eligible-profile" };
  const coordinatorFamily = familyOf(lineup.coordinator);
  const authorFamily = planAuthor ? familyOf(planAuthor) : undefined;
  if (coordinatorFamily === undefined || authorFamily === undefined) return { skipped: "no-eligible-profile" };
  const profile = evaluatorProfiles(lineup).find(candidate => {
    const family = familyOf(candidate);
    return family !== undefined && family !== coordinatorFamily && family !== authorFamily && !limited.has(candidate.provider);
  });
  return profile ? { profile } : { skipped: "no-eligible-profile" };
}
