import { createHash } from "node:crypto";
import { z } from "zod";
import type { AutonomyMode } from "./autonomy.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { RoutingKnobs, RoutingPoint, TeamRunRouting } from "./routing-types.js";
import type { TeamLineup } from "./team-types.js";

export const ROUTING_ALGORITHM_VERSION = 1;
export const POINTS_ALGORITHM_VERSION = 2;
export const REWARD_VERSION = 1;

export const ROUTING_DEFAULTS: RoutingKnobs = {
  points: ["start"], cascade: false, successValueUsd: 2, maxExploreShare: 0.2, exploreWindow: 50,
  minSpareAttempts: 4, allowContributor: false, listWeight: 0.25, headroomWeight: 1,
};
export const AUTONOMOUS_DEFAULTS: RoutingKnobs = { ...ROUTING_DEFAULTS, points: [...ROUTING_DEFAULTS.points], cascade: true };

const KNOB_KEYS = ["points", "cascade", "successValueUsd", "maxExploreShare", "exploreWindow", "minSpareAttempts",
  "allowContributor", "listWeight", "headroomWeight"] as const satisfies readonly (keyof RoutingKnobs)[];
const POINT_ORDER: readonly RoutingPoint[] = ["start", "escalation", "scout"];

export const teamRoutingSchema = z.object({
  mode: z.enum(["off", "shadow", "auto"]).optional(),
  points: z.array(z.enum(["start", "escalation", "scout"])).min(1).optional(),
  cascade: z.boolean().optional(),
  successValueUsd: z.number().min(0).max(100).optional(),
  maxExploreShare: z.number().min(0).max(0.5).optional(),
  exploreWindow: z.number().int().min(10).max(500).optional(),
  minSpareAttempts: z.number().int().min(0).max(20).optional(),
  allowContributor: z.boolean().optional(),
  listWeight: z.number().min(0).max(1).optional(),
  headroomWeight: z.number().min(0).max(4).optional(),
}).strict();
export type TeamRouting = z.infer<typeof teamRoutingSchema>;

export type EffectiveRouting = { mode: "off" }
  | { mode: "shadow"; requested: "shadow" | "auto"; source: "saved" | "autonomous-default"; knobs: RoutingKnobs; defaults: (keyof RoutingKnobs)[] };

function normalizePoints(points: readonly RoutingPoint[]): RoutingPoint[] {
  return POINT_ORDER.filter(point => points.includes(point));
}

function knobsOver(saved: TeamRouting, base: RoutingKnobs): { knobs: RoutingKnobs; defaults: (keyof RoutingKnobs)[] } {
  const knobs: Record<string, unknown> = { ...base };
  const defaults: (keyof RoutingKnobs)[] = [];
  for (const key of KNOB_KEYS) {
    const value = saved[key];
    if (value === undefined) defaults.push(key);
    else knobs[key] = value;
  }
  return { knobs: { ...(knobs as unknown as RoutingKnobs), points: normalizePoints(knobs.points as RoutingPoint[]) }, defaults };
}

export function effectiveRouting(saved: TeamRouting | undefined, autonomy: AutonomyMode): EffectiveRouting {
  if (saved === undefined) {
    if (autonomy !== "autonomous") return { mode: "off" };
    return { mode: "shadow", requested: "shadow", source: "autonomous-default", knobs: { ...AUTONOMOUS_DEFAULTS, points: normalizePoints(AUTONOMOUS_DEFAULTS.points) }, defaults: [...KNOB_KEYS] };
  }
  const mode = saved.mode ?? (autonomy === "autonomous" ? "shadow" : "off");
  if (mode === "off") return { mode: "off" };
  const { knobs, defaults } = knobsOver(saved, ROUTING_DEFAULTS);
  return { mode: "shadow", requested: mode === "auto" ? "auto" : "shadow", source: "saved", knobs, defaults };
}

export function algorithmVersionOf(knobs: Pick<RoutingKnobs, "points">): number {
  return knobs.points.some(point => point !== "start") ? POINTS_ALGORITHM_VERSION : ROUTING_ALGORITHM_VERSION;
}

export function policyDigest(effective: Extract<EffectiveRouting, { mode: "shadow" }>, mode: "shadow" | "auto" = "shadow"): string {
  const knobs = { ...effective.knobs, points: normalizePoints(effective.knobs.points) };
  return createHash("sha256").update(canonicalJson({ algorithmVersion: algorithmVersionOf(knobs), rewardVersion: REWARD_VERSION, mode, knobs })).digest("hex");
}

export function pinRouting(saved: TeamRouting | undefined, autonomy: AutonomyMode, lineup: TeamLineup | undefined, periodEndedAt?: string): TeamRunRouting | undefined {
  const effective = effectiveRouting(saved, autonomy);
  if (effective.mode !== "shadow" || !effective.knobs.points.includes("start") || !lineup) return undefined;
  const auto = saved?.mode === "auto" || (saved?.mode === undefined && autonomy === "autonomous");
  if (periodEndedAt !== undefined && auto) {
    return {
      mode: "auto", requested: "auto", source: effective.source, knobs: effective.knobs, defaults: effective.defaults,
      algorithmVersion: algorithmVersionOf(effective.knobs), rewardVersion: REWARD_VERSION, digest: policyDigest(effective, "auto"), periodEndedAt,
    };
  }
  return {
    mode: "shadow", requested: effective.requested, source: effective.source, knobs: effective.knobs, defaults: effective.defaults,
    algorithmVersion: algorithmVersionOf(effective.knobs), rewardVersion: REWARD_VERSION, digest: policyDigest(effective),
  };
}
