import { epochAt } from "./configuration-store.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "./evidence/types.js";
import { selectScoutEvidence } from "./outcome-store.js";
import {
  DECISION_BUDGET_MS, evaluateImplementer, frameOf, identityOf, REQUIRED_MODULES, type AutoDecision, type AutoFailure, type Evaluated, type RouterStart,
} from "./routing-auto.js";
import { chooseScout, expectedCost, RESCUE_USD, screenEscalations, screenScouts, TIER_COSTS } from "./routing-choice.js";
import { COST_HEADROOM_ALGORITHM_VERSION } from "./routing-policy.js";
import { CHOSEN_WEIGHT, MAX_AGE_DAYS, observedCost, type RoutingTarget } from "./routing-posterior.js";
import { decisionSeed } from "./routing-sample.js";
import { escalationFallback, scoutFallback } from "./routing-rules.js";
import { decisionKey, insertDecision, PAYLOAD_LIMIT_BYTES, readDecision, ROUTING_MODULE } from "./routing-store.js";
import { taskFeatures, type FeatureMap } from "./task-features.js";
import type { CostBasis, CostsBasis, DecisionRow, RoutingPayload } from "./routing-types.js";
import type { TeamModelProfile, TeamRun, TeamScout } from "./team-types.js";
import type { Provider } from "./types.js";

const DAY_MS = 86_400_000;

export type RouterEscalation = RouterStart & { ownProfileId: string | undefined; namedProfileId: string | undefined };
export type RouterScout = { run: TeamRun; scout: TeamScout; featureMap: FeatureMap | undefined; limited: ReadonlySet<Provider> };

function hasScoutEvidenceTables(db: EvidenceDb): boolean {
  const rows = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('outcomes', 'configurations', 'profile_epochs')");
  return rows.length === 3;
}

export function evaluateScout(db: EvidenceDb, input: RouterScout, keys: { taskKey: string; key: string }, now: string, auto: boolean): Evaluated | undefined {
  const { run, scout } = input;
  const { routing, lineup } = run;
  if (routing === undefined || lineup === undefined) throw new Error("A routed scout needs a routing pin and a lineup.");
  const features = taskFeatures({ role: "scout", paths: [] }, input.featureMap);
  const screened = screenScouts(lineup, routing.knobs, input.limited);
  const projectRef = db.index("project", run.projectId);
  const areaRef = db.index("area", features.area);
  const featureMapRef = db.index("feature-map", features.featureMap);
  const useObserved = routing.algorithmVersion >= COST_HEADROOM_ALGORITHM_VERSION && hasScoutEvidenceTables(db);
  let costs: Map<string, { costUsd: number; basis?: CostBasis }> | undefined;
  let costsBasis: CostsBasis = "tier-default";
  if (useObserved) {
    const since = new Date(Date.parse(now) - MAX_AGE_DAYS * DAY_MS).toISOString();
    const target: RoutingTarget = { projectRef, areaRef, kind: features.kind, featureVersion: features.featureVersion, featureMapRef, point: "scout" };
    costs = new Map<string, { costUsd: number; basis?: CostBasis }>();
    let observedCount = 0;
    let defaultCount = 0;
    for (const item of screened) {
      if ((item.removed !== undefined && item.removed !== "limited") || costs.has(item.identity)) continue;
      const epoch = epochAt(db, item.identity, now);
      const rows = selectScoutEvidence(db, identityOf(item.profile), since);
      const found = expectedCost(item.profile, observedCost(rows, target, epoch, now).listUsd);
      if (found.basis === "observed") observedCount++;
      else defaultCount++;
      costs.set(item.identity, found);
    }
    costsBasis = observedCount === 0 ? "tier-default" : defaultCount === 0 ? "observed" : "mixed";
  }
  const choice = chooseScout(screened, costs);
  if (choice === undefined) return undefined;
  const chosen = choice.candidates.find(candidate => candidate.profileId === choice.chosen)!;
  const row: DecisionRow = {
    key: keys.key,
    runId: run.id,
    revision: run.revision,
    taskKey: keys.taskKey,
    point: "scout",
    ordinal: 1,
    projectRef,
    role: "scout",
    areaRef,
    kind: features.kind,
    risk: features.risk,
    featureVersion: features.featureVersion,
    featureMapRef,
    mode: auto ? "auto" : "shadow",
    algorithmVersion: routing.algorithmVersion,
    rewardVersion: routing.rewardVersion,
    policyDigest: routing.digest,
    seed: decisionSeed(routing.digest, run.id, run.revision, keys.taskKey, "scout", 1),
    basis: choice.basis,
    chosenProfileId: choice.chosen,
    chosenIdentity: chosen.identity,
    greedyProfileId: choice.greedy,
    coordinatorProfileId: scout.agentProfileId ?? null,
    explore: choice.explore,
    state: auto ? "pending" : "recorded",
    memberId: null,
    decidedAt: now,
  };
  const payload: RoutingPayload = {
    projectId: run.projectId,
    taskId: scout.id,
    area: features.area,
    featureMap: features.featureMap,
    coordinatorProfileId: row.coordinatorProfileId,
    knobs: routing.knobs,
    costs: { lightUsd: TIER_COSTS.light, strongUsd: TIER_COSTS.strong, rescueUsd: RESCUE_USD, basis: costsBasis },
    headroom: "not-modelled",
    chosenWeight: CHOSEN_WEIGHT,
    current: [],
    candidates: choice.candidates,
    elapsedMs: 0,
  };
  return { row, payload };
}

function poolNamed(pool: readonly TeamModelProfile[] | undefined, profileId: string): TeamModelProfile {
  const profile = pool?.find(item => item.id === profileId);
  if (profile === undefined) throw new Error("A routing decision names a profile outside its pool.");
  return profile;
}

function settle(store: EvidenceStore, row: DecisionRow, payload: RoutingPayload, elapsed: number): DecisionRow | AutoFailure {
  if (elapsed > DECISION_BUDGET_MS) return "budget";
  payload.elapsedMs = Math.round(elapsed);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_LIMIT_BYTES) return "tooLarge";
  const holder: { stored?: DecisionRow } = {};
  const written = store.tryWrite((tx: EvidenceTx) => {
    if (!insertDecision(tx, row, payload)) holder.stored = readDecision(tx, row.key);
  });
  if (!written) return "write";
  return holder.stored ?? row;
}

export function decideAutoEscalation(store: EvidenceStore, input: RouterEscalation, now: () => string, clock: () => number): AutoDecision | undefined {
  const { run, task, ownProfileId, namedProfileId } = input;
  const { lineup, routing } = run;
  const fallbackProfile = escalationFallback(run, ownProfileId, namedProfileId);
  if (fallbackProfile === undefined || lineup === undefined || routing === undefined) return undefined;
  const fallback = (reason: AutoFailure): AutoDecision => ({ profile: fallbackProfile, by: "fallback", reason });
  try {
    const modules = store.status().modules;
    if (REQUIRED_MODULES.some(name => modules[name] !== "ready")) return fallback("unavailable");
    const frame = frameOf(input, screenEscalations(lineup, routing.knobs, input.limited, ownProfileId));
    const at = now();
    const started = clock();
    const decided = store.read(db => {
      const taskKey = db.index("task", task.id);
      const key = decisionKey(run.id, run.revision, taskKey, "escalation", 1);
      const existing = readDecision(db, key);
      if (existing !== undefined) return { existing };
      return evaluateImplementer(db, input, frame, { taskKey, key }, at, true, { point: "escalation", named: namedProfileId ?? null });
    });
    if (decided === undefined) return fallback("failed");
    if ("existing" in decided) return { profile: poolNamed(lineup.escalations, decided.existing.chosenProfileId), by: "router" };
    const stored = settle(store, decided.row, decided.payload, clock() - started);
    if (typeof stored === "string") return fallback(stored);
    return { profile: poolNamed(lineup.escalations, stored.chosenProfileId), by: "router" };
  } catch {
    return fallback("failed");
  }
}

export function decideAutoScout(store: EvidenceStore, input: RouterScout, now: () => string, clock: () => number): AutoDecision | undefined {
  const { run, scout } = input;
  const { lineup } = run;
  const fallbackProfile = scoutFallback(run, scout);
  if (fallbackProfile === undefined || lineup === undefined) return undefined;
  const fallback = (reason: AutoFailure): AutoDecision => ({ profile: fallbackProfile, by: "fallback", reason });
  try {
    if (store.status().modules[ROUTING_MODULE] !== "ready") return fallback("unavailable");
    const at = now();
    const started = clock();
    const decided = store.read(db => {
      const taskKey = db.index("task", scout.id);
      const key = decisionKey(run.id, run.revision, taskKey, "scout", 1);
      const existing = readDecision(db, key);
      if (existing !== undefined) return { existing };
      return evaluateScout(db, input, { taskKey, key }, at, true);
    });
    if (decided === undefined) return fallback("failed");
    if ("existing" in decided) return { profile: poolNamed(lineup.implementers, decided.existing.chosenProfileId), by: "router" };
    const stored = settle(store, decided.row, decided.payload, clock() - started);
    if (typeof stored === "string") return fallback(stored);
    return { profile: poolNamed(lineup.implementers, stored.chosenProfileId), by: "router" };
  } catch {
    return fallback("failed");
  }
}

