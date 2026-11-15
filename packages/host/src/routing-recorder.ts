import { promptVersion } from "./config-identity.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import type { EvidenceStore } from "./evidence/store.js";
import { OUTCOMES_MODULE, selectRoutingEvidence } from "./outcome-store.js";
import { profileIdentity } from "./run-events.js";
import { choose, RESCUE_USD, screen, TIER_COSTS, tierCost, type Scored } from "./routing-choice.js";
import { CHOSEN_WEIGHT, MAX_AGE_DAYS, posterior, type CurrentConfig, type RoutingTarget } from "./routing-posterior.js";
import { decisionSeed } from "./routing-sample.js";
import { decisionKey, insertDecision, PAYLOAD_LIMIT_BYTES, readDecision, ROUTING_MODULE } from "./routing-store.js";
import { taskFeatures, type FeatureMap } from "./task-features.js";
import type { DecisionRow, RoutingPayload } from "./routing-types.js";
import type { TeamModelProfile, TeamRun, TeamTask } from "./team-types.js";
import type { Provider } from "./types.js";

export type RouterStart = {
  run: TeamRun;
  task: TeamTask;
  publishHeads: boolean;
  entryTools: boolean;
  featureMap: FeatureMap | undefined;
  limited: ReadonlySet<Provider>;
};

/** The start decision's budget. A decision that takes longer writes no row. */
export const DECISION_BUDGET_MS = 250;
const DAY_MS = 86_400_000;
const REQUIRED_MODULES = [OUTCOMES_MODULE, CONFIGURATIONS_MODULE, ROUTING_MODULE] as const;

/** The fixed log texts. Each names no id and no value. */
const LOG = {
  unavailable: "Routing shadow decision skipped: the evidence store is unavailable.",
  budget: `Routing shadow decision skipped: it took longer than ${DECISION_BUDGET_MS} ms.`,
  failed: "Routing shadow decision failed.",
} as const;

type Reason = keyof typeof LOG;

/** The identity a profile has in the outcome ledger: provider, model, and effort (or the OpenCode variant). */
function identityOf(profile: TeamModelProfile): { provider: string; model: string; effort: string | null } {
  const identity = profileIdentity(profile, profile.provider);
  return { provider: identity.provider, model: identity.model ?? profile.model, effort: identity.effort ?? null };
}

/**
 * Records the router's pick for the implementer of a task, when the task starts, in shadow. It writes at most one row
 * per run, revision, and task. It never throws, changes no field of the member, the task, or the run, and writes nothing
 * when the store or one of its modules is unavailable.
 */
export class RoutingRecorder {
  private readonly store: EvidenceStore;
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private readonly logged = new Set<Reason>();

  constructor(options: { store: EvidenceStore; now?: () => string; clock?: () => number; log?: (line: string) => void }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? (() => performance.now());
    this.log = options.log ?? (line => console.warn(line));
  }

  /** Never throws. Writes at most one row. */
  recordStart(input: RouterStart): void {
    try {
      this.record(input);
    } catch {
      this.once("failed");
    }
  }

  private once(reason: Reason): void {
    if (this.logged.has(reason)) return;
    this.logged.add(reason);
    this.log(LOG[reason]);
  }

  private record(input: RouterStart): void {
    const { run, task } = input;
    const routing = run.routing;
    if (routing === undefined || run.lineup === undefined || !routing.knobs.points.includes("start")) return;
    const modules = this.store.status().modules;
    if (REQUIRED_MODULES.some(name => modules[name] !== "ready")) {
      this.once("unavailable");
      return;
    }

    const knobs = routing.knobs;
    const features = taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, input.featureMap);
    const screened = screen(run.lineup, knobs, input.limited);
    const kept = screened.filter(item => item.removed === undefined || item.removed === "limited");
    // One prompt version per identity, from the first kept profile with it, in lineup order.
    const versions = new Map<string, { profile: TeamModelProfile; version: string }>();
    for (const item of kept) {
      if (versions.has(item.identity)) continue;
      const version = promptVersion("implementer", item.profile.provider, item.profile, input.publishHeads, input.entryTools);
      versions.set(item.identity, { profile: item.profile, version });
    }

    const started = this.clock();
    const decided = this.store.read(db => {
      // The task's blind index, never its plain id: the key and the seed are stored as plain columns.
      const taskKey = db.index("task", task.id);
      const key = decisionKey(run.id, run.revision, taskKey, "start", 1);
      const existing = readDecision(db, key);
      if (existing !== undefined) return { existing };
      const now = this.now();
      const since = new Date(Date.parse(now) - MAX_AGE_DAYS * DAY_MS).toISOString();
      const target: RoutingTarget = {
        projectRef: db.index("project", run.projectId),
        areaRef: db.index("area", features.area),
        kind: features.kind,
        featureVersion: features.featureVersion,
        featureMapRef: db.index("feature-map", features.featureMap),
        point: "start",
      };
      const scored = new Map<string, Scored>();
      const current: { identity: string; epoch: number; promptVersion: string }[] = [];
      for (const [identity, { profile, version }] of versions) {
        const found: CurrentConfig = { epoch: epochAt(db, identity, now), promptVersion: version };
        const rows = selectRoutingEvidence(db, identityOf(profile), "start", since);
        scored.set(identity, { profile, identity, posterior: posterior(rows, target, found, now, CHOSEN_WEIGHT), costUsd: tierCost(profile) });
        current.push({ identity, ...found });
      }
      const seed = decisionSeed(routing.digest, run.id, run.revision, taskKey, "start", 1);
      const choice = choose(screened, scored, knobs, features.risk, seed);
      if (choice === undefined) return undefined;
      const chosen = choice.candidates.find(candidate => candidate.profileId === choice.chosen)!;
      const row: DecisionRow = {
        key,
        runId: run.id,
        revision: run.revision,
        taskKey,
        point: "start",
        ordinal: 1,
        projectRef: target.projectRef,
        role: "implementer",
        areaRef: target.areaRef,
        kind: features.kind,
        risk: features.risk,
        featureVersion: features.featureVersion,
        featureMapRef: target.featureMapRef,
        mode: "shadow",
        algorithmVersion: routing.algorithmVersion,
        rewardVersion: routing.rewardVersion,
        policyDigest: routing.digest,
        seed,
        basis: choice.basis,
        chosenProfileId: choice.chosen,
        chosenIdentity: chosen.identity,
        greedyProfileId: choice.greedy,
        coordinatorProfileId: task.agentProfileId ?? null,
        explore: choice.explore,
        state: "recorded",
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
        costs: { lightUsd: TIER_COSTS.light, strongUsd: TIER_COSTS.strong, rescueUsd: RESCUE_USD, basis: "tier-default" },
        headroom: "not-modelled",
        chosenWeight: CHOSEN_WEIGHT,
        current,
        candidates: choice.candidates,
        elapsedMs: 0,
      };
      return { row, payload };
    });
    if (decided === undefined || "existing" in decided) return;

    const elapsed = this.clock() - started;
    if (elapsed > DECISION_BUDGET_MS) {
      this.once("budget");
      return;
    }
    const { row, payload } = decided;
    payload.elapsedMs = Math.round(elapsed);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_LIMIT_BYTES) throw new RangeError("A routing decision payload is over its limit.");
    this.store.tryWrite(tx => {
      insertDecision(tx, row, payload);
    });
  }
}
