import type { OutcomeRow } from "./outcome-store.js";

export type RoutingMode = "off" | "shadow" | "auto";
export type RoutingPoint = "start" | "escalation" | "scout";
export type RoutingKnobs = { points: RoutingPoint[]; cascade: boolean; successValueUsd: number; maxExploreShare: number;
  exploreWindow: number; minSpareAttempts: number; allowContributor: boolean; listWeight: number; headroomWeight: number };
export type TeamRunRoutingShadow = { mode: "shadow"; requested: "shadow" | "auto"; source: "saved" | "autonomous-default";
  knobs: RoutingKnobs; defaults: (keyof RoutingKnobs)[]; algorithmVersion: number; rewardVersion: number; digest: string };
export type TeamRunRoutingAuto = Omit<TeamRunRoutingShadow, "mode" | "requested"> & { mode: "auto"; requested: "auto"; periodEndedAt: string };
export type TeamRunRouting = TeamRunRoutingShadow | TeamRunRoutingAuto;
export type Identity = { provider: string; model: string; effort: string | null };
export type RoutingEvidenceRow = Pick<OutcomeRow, "outcomeId" | "source" | "projectRef" | "areaRef" | "provider" | "model"
  | "effort" | "profileEpoch" | "kind" | "featureVersion" | "disposition" | "exclusion" | "flags" | "integrated" | "accepted"
  | "firstPass" | "held" | "endedAt" | "frozenAt">
  & { point: "start" | "escalation"; featureMapRef: string | null; ownerScore: number | null; listUsd: number | null; promptVersion: string | null };
export type RuleRemoval = "contributor" | "reviewer-model" | "limited";
export type CostBasis = "tier-default" | "observed";
export type CostsBasis = "tier-default" | "observed" | "mixed";
export type HeadroomBasis = "limited" | "estimated" | "unestimated";
export type ProviderHeadroom = { headroom: number | null; basis: HeadroomBasis; pressure: number; near: boolean; unit?: "usd" | "tokens" };
export type Basis = "sampled" | "greedy-risk" | "greedy-paused" | "greedy-budget" | "greedy-headroom" | "greedy-share" | "greedy-point"
  | "single-candidate" | "default-all-limited";
export type ExploreGuards = { pausedAt: string | null; spareAttempts: number; share: { exploratory: number; of: number }; nearLimit?: boolean };
export type ProjectRoutingState = { periodEndedAt: string | null; explorePausedAt: string | null };
export type Beta = { a: number; b: number };
export type LevelName = "cell" | "project" | "tenant";
export type LevelRecord = { level: LevelName; observed: { success: number; failure: number; rows: number };
  earlier: { success: number; failure: number; rows: number; scale: number }; prior: { strength: number; mean: number }; posterior: Beta };
export type ProfilePosterior = { reward: LevelRecord[]; rescue: LevelRecord[]; theta: Beta; phi: Beta;
  rows: { production: number; duel: number }; earlierRows: number; level: LevelName | "none"; untimed: number };
export type CandidateRecord = { profileId: string; identity: string; tier: "light" | "strong" | null; removed?: RuleRemoval;
  posterior?: ProfilePosterior; costUsd?: number; costBasis?: CostBasis; headroom?: number | null; headroomBasis?: HeadroomBasis;
  pressure?: number; thetaMean?: number; thetaSd?: number; phiMean?: number;
  greedyUtility?: number; sample?: number; sampledUtility?: number; samplerFallback?: true };
export type RoutingPayload = { projectId: string; taskId: string; area: string; featureMap: string; coordinatorProfileId: string | null;
  knobs: RoutingKnobs; costs: { lightUsd: number; strongUsd: number; rescueUsd: number; basis: CostsBasis };
  headroom: "not-modelled" | "modelled"; chosenWeight: number; current: { identity: string; epoch: number; promptVersion: string }[];
  candidates: CandidateRecord[]; elapsedMs: number; guards?: ExploreGuards };
export type DecisionRow = { key: string; runId: string; revision: number; taskKey: string; point: RoutingPoint; ordinal: number;
  projectRef: string; role: "implementer" | "scout"; areaRef: string | null; kind: string | null; risk: "normal" | "elevated";
  featureVersion: number; featureMapRef: string; mode: "shadow" | "auto"; algorithmVersion: number; rewardVersion: number;
  policyDigest: string; seed: string; basis: string; chosenProfileId: string; chosenIdentity: string; greedyProfileId: string;
  coordinatorProfileId: string | null; explore: boolean; state: "pending" | "applied" | "released" | "recorded";
  memberId: string | null; decidedAt: string };
export type StatusProfile = { profileId: string; removed?: "contributor" | "reviewer-model"; rows: { production: number; duel: number };
  earlier: { rows: number; mass: number; appliedMass: number }; mean: number; interval: [number, number]; rescue: number;
  level: LevelName | "none"; costUsd: number; costBasis?: CostBasis; greedy: boolean };
export type StatusCell = { scope: "cell"; area: string; taskKind: string | null; featureVersion: number; featureMap: string } | { scope: "new-task" };
export type RoutingStatus = {
  projectId: string; mode: RoutingMode; requested: RoutingMode | null; source: "saved" | "autonomous-default" | null;
  modeSource: "saved" | "autonomous-default" | null;
  knobs: RoutingKnobs | null; defaults: (keyof RoutingKnobs)[];
  covers: { start: boolean; reason: "off" | "no-lineup" | "no-start-point" | "no-eligible-profile" | null };
  costs: { lightUsd: number; strongUsd: number; rescueUsd: number; basis: CostsBasis };
  headroom: "not-modelled" | "modelled"; providers?: Record<string, ProviderHeadroom>; interval: "normal-approx-90"; chosenWeight: number; limits: "not-applied";
  shadow: { windowDays: 30; decisions: number; withCoordinator: number; agreements: number; greedyAgreements: number; capped: boolean };
  explore: { exploratory: number; of: number; guards: "risk-only" | "applied"; pausedAt: string | null };
  period: { decisions: number; capped: boolean; firstAt: string | null; endsAt: string | null; endedAt: string | null; stored: boolean;
    targetDays: 14; targetDecisions: 50 };
  share: { exploratory: number; of: number; window: number; limit: number } | null;
  auto: { windowDays: 30; pending: number; applied: number; released: number; capped: boolean } | null;
  cells: { cell: StatusCell; profiles: StatusProfile[] }[]; cellsCapped: boolean; unreadableCells: number };
export type ExplainedDecision = Omit<DecisionRow, "projectRef" | "areaRef" | "taskKey" | "featureMapRef"> & { payload: RoutingPayload | null };
export type RoutingExplain = { runId: string; taskId: string; decisions: ExplainedDecision[]; capped: boolean };
