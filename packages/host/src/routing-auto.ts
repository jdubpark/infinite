import { promptVersion, type ObjectivePrompt } from "./config-identity.js";
import type { UsageConfig } from "./config.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb } from "./evidence/types.js";
import { OUTCOMES_MODULE, selectRoutingEvidence } from "./outcome-store.js";
import type { ProviderLimitEvent } from "./provider-limits.js";
import { profileIdentity } from "./run-events.js";
import { choose, expectedCost, RESCUE_USD, screen, TIER_COSTS, tierCost, type Choice, type Screened, type Scored } from "./routing-choice.js";
import { guardExploration } from "./routing-guards.js";
import { overlayLimitedHeadrooms, readProviderHeadrooms, type ProviderHeadroomCache } from "./routing-headroom.js";
import { COST_HEADROOM_ALGORITHM_VERSION } from "./routing-policy.js";
import { CHOSEN_WEIGHT, MAX_AGE_DAYS, observedCost, posterior, type CurrentConfig, type RoutingTarget } from "./routing-posterior.js";
import { decisionSeed } from "./routing-sample.js";
import { fallbackProfile, spareAttempts } from "./routing-rules.js";
import {
  appliedOutcomeIds, computedPeriodEnd, decisionKey, insertDecision, markPeriodEnded, PAYLOAD_LIMIT_BYTES, readDecision,
  readProjectState, releaseStalePending, ROUTING_MODULE, shareWindow,
} from "./routing-store.js";
import { taskFeatures, type FeatureMap, type TaskFeatures } from "./task-features.js";
import type { CostsBasis, DecisionRow, ExploreGuards, ProviderHeadroom, RoutingKnobs, RoutingPayload } from "./routing-types.js";
import type { TeamModelProfile, TeamRun, TeamTask } from "./team-types.js";
import type { Provider } from "./types.js";

export const DECISION_BUDGET_MS = 250;
const DAY_MS = 86_400_000;
export const REQUIRED_MODULES = [OUTCOMES_MODULE, CONFIGURATIONS_MODULE, ROUTING_MODULE] as const;

export type RouterStart = {
  run: TeamRun;
  task: TeamTask;
  publishHeads: boolean;
  entryTools: boolean;
  objectiveDigest: ObjectivePrompt;
  codeMode: boolean;
  featureMap: FeatureMap | undefined;
  limited: ReadonlySet<Provider>;
  limitHistory?: readonly ProviderLimitEvent[];
  prices?: UsageConfig["prices"];
  headrooms?: ReadonlyMap<Provider, ProviderHeadroom>;
  headroomCache?: ProviderHeadroomCache;
};

export type AutoFailure = "unavailable" | "budget" | "tooLarge" | "write" | "failed";
export type AutoDecision = { profile: TeamModelProfile; by: "router" } | { profile: TeamModelProfile; by: "fallback"; reason: AutoFailure };

export const AUTO_LOG: Record<AutoFailure | "pin" | "uncovered", string> = {
  unavailable: "Routing auto decision fell back: the evidence store is unavailable.",
  budget: `Routing auto decision fell back: it took longer than ${DECISION_BUDGET_MS} ms.`,
  tooLarge: "Routing auto decision fell back: its details are over the size limit.",
  write: "Routing auto decision fell back: the decision could not be stored.",
  failed: "Routing auto decision failed; the task starts on its fallback profile.",
  pin: "Routing auto pin fell back to shadow: the evidence store is unavailable.",
  uncovered: "Routing auto pin stayed in shadow: no implementer profile passes the fixed rules.",
};

export function identityOf(profile: TeamModelProfile): { provider: string; model: string; effort: string | null } {
  const identity = profileIdentity(profile, profile.provider);
  return { provider: identity.provider, model: identity.model ?? profile.model, effort: identity.effort ?? null };
}

export type StartFrame = { features: TaskFeatures; screened: Screened[]; versions: Map<string, { profile: TeamModelProfile; version: string }> };

export function frameOf(input: RouterStart, screened: Screened[]): StartFrame {
  const { task } = input;
  const features = taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, input.featureMap);
  const versions = new Map<string, { profile: TeamModelProfile; version: string }>();
  for (const item of screened) {
    if (item.removed !== undefined && item.removed !== "limited") continue;
    if (versions.has(item.identity)) continue;
    const version = promptVersion("implementer", item.profile.provider, item.profile, input.publishHeads, input.entryTools, input.objectiveDigest, input.codeMode);
    versions.set(item.identity, { profile: item.profile, version });
  }
  return { features, screened, versions };
}

export function startFrame(input: RouterStart): StartFrame {
  const { run } = input;
  const { routing, lineup } = run;
  if (routing === undefined || lineup === undefined) throw new Error("A routed start needs a routing pin and a lineup.");
  return frameOf(input, screen(lineup, routing.knobs, input.limited));
}

export type Evaluated = { row: DecisionRow; payload: RoutingPayload };

function guardsAt(db: EvidenceDb, run: TeamRun, knobs: RoutingKnobs, now: string): ExploreGuards {
  const state = readProjectState(db, run.projectId);
  return {
    pausedAt: state.explorePausedAt,
    spareAttempts: spareAttempts(run),
    share: shareWindow(db, run.projectId, knobs.exploreWindow, now),
  };
}

export function evaluateImplementer(db: EvidenceDb, input: RouterStart, frame: StartFrame, keys: { taskKey: string; key: string },
  now: string, auto: boolean, at: { point: "start" | "escalation"; named: string | null }): Evaluated | undefined {
  const { run, task } = input;
  const { routing, lineup } = run;
  if (routing === undefined || lineup === undefined) throw new Error("A routed start needs a routing pin and a lineup.");
  const knobs = routing.knobs;
  const { features } = frame;
  const target: RoutingTarget = {
    projectRef: db.index("project", run.projectId),
    areaRef: db.index("area", features.area),
    kind: features.kind,
    featureVersion: features.featureVersion,
    featureMapRef: db.index("feature-map", features.featureMap),
    point: at.point,
  };
  const since = new Date(Date.parse(now) - MAX_AGE_DAYS * DAY_MS).toISOString();
  const useCostHeadroom = routing.algorithmVersion >= COST_HEADROOM_ALGORITHM_VERSION;
  const providers = [...new Set(frame.screened.map(item => item.profile.provider))];
  const headrooms = !useCostHeadroom ? undefined
    : input.headrooms ? overlayLimitedHeadrooms(providers, input.headrooms, input.limited)
    : input.headroomCache ? input.headroomCache.read(db, providers, input.limited, input.limitHistory ?? [], input.prices, now)
    : readProviderHeadrooms(db, providers, input.limited, input.limitHistory ?? [], input.prices, now);
  const scored = new Map<string, Scored>();
  const current: { identity: string; epoch: number; promptVersion: string }[] = [];
  let observedCount = 0;
  let defaultCount = 0;
  for (const [identity, { profile, version }] of frame.versions) {
    const found: CurrentConfig = { epoch: epochAt(db, identity, now), promptVersion: version };
    const rows = selectRoutingEvidence(db, identityOf(profile), at.point, since);
    const applied = appliedOutcomeIds(db, identity, since, at.point);
    const cost = useCostHeadroom
      ? expectedCost(profile, observedCost(rows, target, found.epoch, now).listUsd)
      : { costUsd: tierCost(profile), basis: "tier-default" as const };
    if (cost.basis === "observed") observedCount++;
    else defaultCount++;
    scored.set(identity, {
      profile, identity, posterior: posterior(rows, target, found, now, CHOSEN_WEIGHT, applied),
      costUsd: cost.costUsd,
      ...(useCostHeadroom ? { costBasis: cost.basis, headroom: headrooms?.get(profile.provider) } : {}),
    });
    current.push({ identity, ...found });
  }
  const costsBasis: CostsBasis = !useCostHeadroom || observedCount === 0 ? "tier-default" : defaultCount === 0 ? "observed" : "mixed";
  const seed = decisionSeed(routing.digest, run.id, run.revision, keys.taskKey, at.point, 1);
  const raw = choose(frame.screened, scored, knobs, features.risk, seed, at.point);
  if (raw === undefined) return undefined;
  const chosenProvider = frame.screened.find(item => item.profile.id === raw.chosen)?.profile.provider;
  const nearLimit = useCostHeadroom && raw.explore && chosenProvider !== undefined && Boolean(headrooms?.get(chosenProvider)?.near);
  const guards = auto && at.point === "start"
    ? { ...guardsAt(db, run, knobs, now), ...(nearLimit ? { nearLimit: true } : {}) }
    : undefined;
  const choice: Choice = guards === undefined ? raw : guardExploration(raw, guards, knobs);
  const chosen = choice.candidates.find(candidate => candidate.profileId === choice.chosen)!;
  const row: DecisionRow = {
    key: keys.key,
    runId: run.id,
    revision: run.revision,
    taskKey: keys.taskKey,
    point: at.point,
    ordinal: 1,
    projectRef: target.projectRef,
    role: "implementer",
    areaRef: target.areaRef,
    kind: features.kind,
    risk: features.risk,
    featureVersion: features.featureVersion,
    featureMapRef: target.featureMapRef,
    mode: auto ? "auto" : "shadow",
    algorithmVersion: routing.algorithmVersion,
    rewardVersion: routing.rewardVersion,
    policyDigest: routing.digest,
    seed,
    basis: choice.basis,
    chosenProfileId: choice.chosen,
    chosenIdentity: chosen.identity,
    greedyProfileId: choice.greedy,
    coordinatorProfileId: at.named,
    explore: choice.explore,
    state: auto ? "pending" : "recorded",
    memberId: null,
    decidedAt: now,
  };
  const payload: RoutingPayload = {
    projectId: run.projectId,
    taskId: task.id,
    area: features.area,
    featureMap: features.featureMap,
    coordinatorProfileId: row.coordinatorProfileId,
    knobs,
    costs: { lightUsd: TIER_COSTS.light, strongUsd: TIER_COSTS.strong, rescueUsd: RESCUE_USD, basis: costsBasis },
    headroom: useCostHeadroom ? "modelled" : "not-modelled",
    chosenWeight: CHOSEN_WEIGHT,
    current,
    candidates: choice.candidates,
    elapsedMs: 0,
    ...(guards === undefined ? {} : { guards }),
  };
  return { row, payload };
}

export function evaluateStart(db: EvidenceDb, input: RouterStart, frame: StartFrame, keys: { taskKey: string; key: string },
  now: string, auto: boolean): Evaluated | undefined {
  return evaluateImplementer(db, input, frame, keys, now, auto, { point: "start", named: input.task.agentProfileId ?? null });
}

function profileNamed(run: TeamRun, profileId: string): TeamModelProfile {
  const profile = run.lineup?.implementers.find(item => item.id === profileId);
  if (profile === undefined) throw new Error("A routing decision names a profile outside the lineup.");
  return profile;
}

export function decideAutoStart(store: EvidenceStore, input: RouterStart, now: () => string, clock: () => number): AutoDecision {
  const { run, task } = input;
  const fallback = (reason: AutoFailure): AutoDecision => ({ profile: fallbackProfile(run, task), by: "fallback", reason });
  try {
    const modules = store.status().modules;
    if (REQUIRED_MODULES.some(name => modules[name] !== "ready")) return fallback("unavailable");
    const frame = startFrame(input);
    const at = now();
    const started = clock();
    const decided = store.read(db => {
      const taskKey = db.index("task", task.id);
      const key = decisionKey(run.id, run.revision, taskKey, "start", 1);
      const existing = readDecision(db, key);
      if (existing !== undefined) return { existing };
      return evaluateStart(db, input, frame, { taskKey, key }, at, true);
    });
    if (decided === undefined) return fallback("failed");
    if ("existing" in decided) return { profile: profileNamed(run, decided.existing.chosenProfileId), by: "router" };

    const elapsed = clock() - started;
    if (elapsed > DECISION_BUDGET_MS) return fallback("budget");
    const { row, payload } = decided;
    payload.elapsedMs = Math.round(elapsed);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_LIMIT_BYTES) return fallback("tooLarge");

    const holder: { stored?: DecisionRow } = {};
    const written = store.tryWrite(tx => {
      releaseStalePending(tx, run.projectId, at);
      if (!insertDecision(tx, row, payload)) holder.stored = readDecision(tx, row.key);
    });
    if (!written) return fallback("write");
    return { profile: profileNamed(run, (holder.stored ?? row).chosenProfileId), by: "router" };
  } catch {
    return fallback("failed");
  }
}

export function periodEnd(store: EvidenceStore, projectId: string, now: string): string | undefined {
  if (store.status().modules[ROUTING_MODULE] !== "ready") throw new Error("The routing module is unavailable.");
  const found = store.read((db): { stored: string } | { computed: string } | undefined => {
    const state = readProjectState(db, projectId);
    if (state.periodEndedAt !== null) return { stored: state.periodEndedAt };
    const computed = computedPeriodEnd(db, projectId);
    if (computed === undefined || Date.parse(computed.endsAt) > Date.parse(now)) return undefined;
    return { computed: computed.endsAt };
  });
  if (found === undefined) return undefined;
  if ("stored" in found) return found.stored;
  const holder: { stored?: string } = {};
  const written = store.tryWrite(tx => {
    holder.stored = markPeriodEnded(tx, projectId, found.computed, now);
  });
  if (!written || holder.stored === undefined) throw new Error("The period end could not be stored.");
  return holder.stored;
}
