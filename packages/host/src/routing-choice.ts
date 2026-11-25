import { profileIdentityKey } from "./config-identity.js";
import { profileIdentity } from "./run-events.js";
import { betaMean, betaSd } from "./routing-posterior.js";
import { betaSample, candidateSeed } from "./routing-sample.js";
import type { Basis, CandidateRecord, ProfilePosterior, RoutingKnobs, RoutingPoint, RuleRemoval } from "./routing-types.js";
import type { TeamLineup, TeamModelProfile } from "./team-types.js";
import type { Provider } from "./types.js";

export const TIER_COSTS = { light: 0.40, strong: 2.20 } as const;
export const RESCUE_USD = 1.50;

export type Screened = { profile: TeamModelProfile; identity: string; removed?: RuleRemoval };
export type Scored = { profile: TeamModelProfile; identity: string; posterior: ProfilePosterior; costUsd: number };
export type Choice = { basis: Basis; chosen: string; greedy: string; explore: boolean; candidates: CandidateRecord[] };

function identityOf(profile: TeamModelProfile): string {
  const { provider, model, effort } = profileIdentity(profile, profile.provider);
  return profileIdentityKey({ provider, model: model ?? null, effort: effort ?? null });
}

export function screenProfiles(profiles: readonly TeamModelProfile[], lineup: Pick<TeamLineup, "reviewer">, knobs: RoutingKnobs,
  limited: ReadonlySet<Provider>): Screened[] {
  return profiles.map(profile => {
    const identity = identityOf(profile);
    if (profile.dataUse === "contributor" && !knobs.allowContributor) return { profile, identity, removed: "contributor" };
    if (profile.model === lineup.reviewer.model) return { profile, identity, removed: "reviewer-model" };
    if (limited.has(profile.provider)) return { profile, identity, removed: "limited" };
    return { profile, identity };
  });
}

export function screen(lineup: TeamLineup, knobs: RoutingKnobs, limited: ReadonlySet<Provider>): Screened[] {
  return screenProfiles(lineup.implementers, lineup, knobs, limited);
}

export function screenEscalations(lineup: TeamLineup, knobs: RoutingKnobs, limited: ReadonlySet<Provider>, ownProfileId: string | undefined): Screened[] {
  return screenProfiles((lineup.escalations ?? []).filter(profile => profile.id !== ownProfileId), lineup, knobs, limited);
}

export function screenScouts(lineup: TeamLineup, knobs: RoutingKnobs, limited: ReadonlySet<Provider>): Screened[] {
  return screenProfiles(lineup.implementers.filter(profile => profile.tier !== "strong"), lineup, knobs, limited);
}

export function tierCost(profile: TeamModelProfile): number {
  return TIER_COSTS[profile.tier ?? "light"];
}

export function utility(input: { theta: number; phi: number; costUsd: number }, knobs: Pick<RoutingKnobs, "successValueUsd" | "listWeight">,
  risk: "normal" | "elevated", rescueUsd: number = RESCUE_USD): number {
  const value = risk === "elevated" ? 3 * knobs.successValueUsd : knobs.successValueUsd;
  return value * input.theta - knobs.listWeight * (input.costUsd + (1 - input.phi) * rescueUsd);
}

interface Entry {
  item: Screened;
  record: CandidateRecord;
  scored: Scored;
  phiMean: number;
  greedyUtility: number;
}

export function choose(screened: readonly Screened[], scored: ReadonlyMap<string, Scored>, knobs: RoutingKnobs,
  risk: "normal" | "elevated", seed: string, point: RoutingPoint = "start"): Choice | undefined {
  const candidates: CandidateRecord[] = screened.map(item => ({
    profileId: item.profile.id, identity: item.identity, tier: item.profile.tier ?? null,
    ...(item.removed === undefined ? {} : { removed: item.removed }),
  }));

  const entries: Entry[] = [];
  screened.forEach((item, index) => {
    if (item.removed !== undefined && item.removed !== "limited") return;
    const found = scored.get(item.identity);
    if (found === undefined) throw new Error(`No posterior for routing candidate ${item.profile.id}`);
    const record = candidates[index];
    const thetaMean = betaMean(found.posterior.theta);
    const thetaSd = betaSd(found.posterior.theta);
    const phiMean = betaMean(found.posterior.phi);
    const greedyTheta = risk === "elevated" ? thetaMean - thetaSd : thetaMean;
    const greedyUtility = utility({ theta: greedyTheta, phi: phiMean, costUsd: found.costUsd }, knobs, risk);
    record.posterior = found.posterior;
    record.costUsd = found.costUsd;
    record.thetaMean = thetaMean;
    record.thetaSd = thetaSd;
    record.phiMean = phiMean;
    record.greedyUtility = greedyUtility;
    entries.push({ item, record, scored: found, phiMean, greedyUtility });
  });
  if (entries.length === 0) return undefined;

  const open = entries.filter(entry => entry.item.removed === undefined);
  if (open.length === 0) {
    const first = entries[0].item.profile.id;
    return { basis: "default-all-limited", chosen: first, greedy: first, explore: false, candidates };
  }
  if (open.length === 1) {
    const only = open[0].item.profile.id;
    return { basis: "single-candidate", chosen: only, greedy: only, explore: false, candidates };
  }

  let top = open[0];
  for (const entry of open) if (entry.greedyUtility > top.greedyUtility) top = entry;
  const greedy = top.item.profile.id;
  if (point !== "start") return { basis: "greedy-point", chosen: greedy, greedy, explore: false, candidates };
  if (risk === "elevated") return { basis: "greedy-risk", chosen: greedy, greedy, explore: false, candidates };

  let pick = open[0];
  let pickUtility = Number.NEGATIVE_INFINITY;
  for (const entry of open) {
    const { theta } = entry.scored.posterior;
    const draw = betaSample(theta.a, theta.b, candidateSeed(seed, entry.item.identity));
    const sampledUtility = utility({ theta: draw.value, phi: entry.phiMean, costUsd: entry.scored.costUsd }, knobs, risk);
    entry.record.sample = draw.value;
    entry.record.sampledUtility = sampledUtility;
    if (draw.fallback) entry.record.samplerFallback = true;
    if (sampledUtility > pickUtility) {
      pick = entry;
      pickUtility = sampledUtility;
    }
  }
  const chosen = pick.item.profile.id;
  return { basis: "sampled", chosen, greedy, explore: chosen !== greedy, candidates };
}

export function chooseScout(screened: readonly Screened[]): Choice | undefined {
  const candidates: CandidateRecord[] = screened.map(item => ({
    profileId: item.profile.id, identity: item.identity, tier: item.profile.tier ?? null,
    ...(item.removed === undefined ? {} : { removed: item.removed }),
  }));

  const entries: { item: Screened; costUsd: number }[] = [];
  screened.forEach((item, index) => {
    if (item.removed !== undefined && item.removed !== "limited") return;
    const costUsd = tierCost(item.profile);
    candidates[index].costUsd = costUsd;
    entries.push({ item, costUsd });
  });
  if (entries.length === 0) return undefined;

  const open = entries.filter(entry => entry.item.removed === undefined);
  if (open.length === 0) {
    const first = entries[0].item.profile.id;
    return { basis: "default-all-limited", chosen: first, greedy: first, explore: false, candidates };
  }
  if (open.length === 1) {
    const only = open[0].item.profile.id;
    return { basis: "single-candidate", chosen: only, greedy: only, explore: false, candidates };
  }

  let low = open[0];
  for (const entry of open) if (entry.costUsd < low.costUsd) low = entry;
  const cheapest = low.item.profile.id;
  return { basis: "greedy-point", chosen: cheapest, greedy: cheapest, explore: false, candidates };
}
