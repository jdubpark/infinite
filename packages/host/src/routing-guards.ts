import type { Choice } from "./routing-choice.js";
import type { Basis, ExploreGuards, RoutingKnobs } from "./routing-types.js";

export const SHARE_EPSILON = 1e-9;

export function shareAllows(share: { exploratory: number; of: number }, maxExploreShare: number): boolean {
  return share.exploratory + 1 <= maxExploreShare * (share.of + 1) + SHARE_EPSILON;
}

export function guardExploration(choice: Choice, guards: ExploreGuards,
  knobs: Pick<RoutingKnobs, "minSpareAttempts" | "maxExploreShare">): Choice {
  if (!choice.explore) return choice;
  let basis: Basis | undefined;
  if (guards.pausedAt !== null) basis = "greedy-paused";
  else if (guards.spareAttempts < knobs.minSpareAttempts) basis = "greedy-budget";
  else if (guards.nearLimit) basis = "greedy-headroom";
  else if (!shareAllows(guards.share, knobs.maxExploreShare)) basis = "greedy-share";
  if (basis === undefined) return choice;
  return { ...choice, chosen: choice.greedy, explore: false, basis };
}
