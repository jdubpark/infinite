import type { Choice } from "./routing-choice.js";
import type { Basis, ExploreGuards, RoutingKnobs } from "./routing-types.js";

export const SHARE_EPSILON = 1e-9;

/** One more exploratory start keeps the window's share, itself included, within the limit: E + 1 ≤ s·(N + 1) + ε. */
export function shareAllows(share: { exploratory: number; of: number }, maxExploreShare: number): boolean {
  return share.exploratory + 1 <= maxExploreShare * (share.of + 1) + SHARE_EPSILON;
}

/**
 * Step 2's guards on an exploratory choice, in this order: paused, budget, share. A choice that does not explore is
 * returned unchanged. A guarded choice takes the greedy profile, and its candidates keep their samples.
 */
export function guardExploration(choice: Choice, guards: ExploreGuards,
  knobs: Pick<RoutingKnobs, "minSpareAttempts" | "maxExploreShare">): Choice {
  if (!choice.explore) return choice;
  let basis: Basis | undefined;
  if (guards.pausedAt !== null) basis = "greedy-paused";
  else if (guards.spareAttempts < knobs.minSpareAttempts) basis = "greedy-budget";
  else if (!shareAllows(guards.share, knobs.maxExploreShare)) basis = "greedy-share";
  if (basis === undefined) return choice;
  return { ...choice, chosen: choice.greedy, explore: false, basis };
}
