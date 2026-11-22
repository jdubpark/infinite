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

export type EvaluatorChoice =
  | { profile: TeamModelProfile; family: string; sharedFamily: boolean; alsoReviewed: boolean }
  | { skipped: "no-independent-evaluator" | "evaluator-unavailable" };

/** A model is its provider and model id together; a profile without a model is the provider's default. */
function sameModel(a: TeamModelProfile, b: TeamModelProfile): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * C14 rules 1 to 3 over evaluatorProfiles(lineup). `authors`: the profiles of implementer and integrator members whose work
 * integrated in the run. `reviewers`: the run's reviewer profiles. `excluded`: profile ids that already failed this verdict.
 */
export function chooseEvaluator(
  lineup: TeamLineup | undefined,
  cycle: { authors: readonly TeamModelProfile[]; reviewers: readonly TeamModelProfile[] },
  limited: ReadonlySet<Provider>,
  excluded?: ReadonlySet<string>,
): EvaluatorChoice {
  if (!lineup) return { skipped: "no-independent-evaluator" };
  const coordinatorFamily = familyOf(lineup.coordinator);
  if (coordinatorFamily === undefined) return { skipped: "no-independent-evaluator" };
  const eligible: Array<{ profile: TeamModelProfile; family: string }> = [];
  for (const profile of evaluatorProfiles(lineup)) {
    const family = familyOf(profile);
    if (family === undefined || family === coordinatorFamily) continue;
    if (cycle.authors.some(author => sameModel(author, profile))) continue;
    eligible.push({ profile, family });
  }
  if (eligible.length === 0) return { skipped: "no-independent-evaluator" };
  const available = eligible.filter(entry => !limited.has(entry.profile.provider) && !excluded?.has(entry.profile.id));
  if (available.length === 0) return { skipped: "evaluator-unavailable" };
  const authorFamilies = new Set<string | undefined>(cycle.authors.map(author => familyOf(author)));
  const reviewerFamilies = new Set<string | undefined>(cycle.reviewers.map(reviewer => familyOf(reviewer)));
  const chosen = available.find(entry => !authorFamilies.has(entry.family) && !reviewerFamilies.has(entry.family))
    ?? available.find(entry => !authorFamilies.has(entry.family))
    ?? available[0]!;
  return {
    profile: chosen.profile,
    family: chosen.family,
    sharedFamily: authorFamilies.has(chosen.family),
    alsoReviewed: cycle.reviewers.some(reviewer => sameModel(reviewer, chosen.profile)),
  };
}

/** True only for evaluator "on" with register "on", on a run that is neither a mission subteam nor a handoff run. */
export function verdictPin(input: { evaluator?: "on" | "off"; register?: "on" | "off"; mission: boolean; handoff: boolean }): boolean {
  if (input.mission || input.handoff) return false;
  return input.evaluator === "on" && input.register === "on";
}

/** The ids of evaluator profiles whose model is also an implementer's or an escalation's (the lineup warning of part 5). */
export function evaluatorOverlaps(lineup: TeamLineup): string[] {
  const others = [...lineup.implementers, ...(lineup.escalations ?? [])];
  return evaluatorProfiles(lineup)
    .filter(profile => others.some(other => sameModel(other, profile)))
    .map(profile => profile.id);
}
