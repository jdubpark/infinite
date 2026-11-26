import type { AutonomyMode } from "./autonomy.js";
import { promptVersion, type ObjectivePrompt } from "./config-identity.js";
import type { UsageConfig } from "./config.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import type { EvidenceDb } from "./evidence/types.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError } from "./evidence/types.js";
import { OUTCOMES_MODULE, selectRoutingEvidence } from "./outcome-store.js";
import type { ProviderLimitEvent } from "./provider-limits.js";
import { profileIdentity } from "./run-events.js";
import { choose, expectedCost, RESCUE_USD, screen, TIER_COSTS, type Screened, type Scored } from "./routing-choice.js";
import { readProviderHeadrooms } from "./routing-headroom.js";
import { effectiveRouting, type TeamRouting } from "./routing-policy.js";
import {
  betaMean, betaSd, CHOSEN_WEIGHT, MAX_AGE_DAYS, observedCost, posterior, type CurrentConfig, type RoutingTarget,
} from "./routing-posterior.js";
import {
  appliedOutcomeIds, computedPeriodEnd, projectCells, projectDecisions, readProjectState, ROUTING_MODULE, shadowProgress, shareWindow, taskDecisions,
} from "./routing-store.js";
import type {
  CostsBasis, DecisionRow, ExplainedDecision, Identity, ProfilePosterior, ProviderHeadroom, RoutingEvidenceRow, RoutingExplain, RoutingKnobs, RoutingMode, RoutingStatus, StatusCell,
  StatusProfile,
} from "./routing-types.js";
import type { TeamLineup, TeamModelProfile } from "./team-types.js";
import type { Provider } from "./types.js";

export const STATUS_CELL_LIMIT = 50, SHADOW_WINDOW_DAYS = 30;
const Z_90 = 1.645;
const DAY_MS = 86_400_000;
const NEW_TASK_AREA = "(new task)";
const STATUS_RISK = "normal" as const;
const HIDDEN_FIELDS = ["projectRef", "areaRef", "taskKey", "featureMapRef"] as const;
const REQUIRED_MODULES = [OUTCOMES_MODULE, CONFIGURATIONS_MODULE, ROUTING_MODULE] as const;

export type RoutingStatusInput = {
  projectId: string;
  saved: TeamRouting | undefined;
  autonomy: AutonomyMode;
  lineup: TeamLineup | undefined;
  publishHeads: boolean;
  entryTools: boolean;
  objectiveDigest: ObjectivePrompt;
  codeMode: boolean;
  now: string;
  limited?: ReadonlySet<Provider>;
  limitHistory?: readonly ProviderLimitEvent[];
  prices?: UsageConfig["prices"];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clip = (value: number) => Math.min(1, Math.max(0, value));
const daysBefore = (now: string, days: number) => new Date(Date.parse(now) - days * DAY_MS).toISOString();

function requireReady(store: EvidenceStore, names: readonly string[]): void {
  const modules = store.status().modules;
  if (names.some(name => modules[name] !== "ready")) throw new EvidenceError("unavailable", "The evidence store is unavailable.");
}

function identityOf(profile: TeamModelProfile): Identity {
  const identity = profileIdentity(profile, profile.provider);
  return { provider: identity.provider, model: identity.model ?? profile.model, effort: identity.effort ?? null };
}

type Evidence = { representative: Map<string, TeamModelProfile>; rows: Map<string, RoutingEvidenceRow[]>; current: Map<string, CurrentConfig>;
  applied: Map<string, Set<string>> };

function readEvidence(db: EvidenceDb, screened: readonly Screened[], publishHeads: boolean, entryTools: boolean, objectiveDigest: ObjectivePrompt, codeMode: boolean, now: string): Evidence {
  const since = daysBefore(now, MAX_AGE_DAYS);
  const representative = new Map<string, TeamModelProfile>();
  for (const item of [...screened.filter(item => item.removed === undefined), ...screened.filter(item => item.removed !== undefined)]) {
    if (!representative.has(item.identity)) representative.set(item.identity, item.profile);
  }
  const rows = new Map<string, RoutingEvidenceRow[]>();
  const current = new Map<string, CurrentConfig>();
  const applied = new Map<string, Set<string>>();
  for (const [identity, profile] of representative) {
    current.set(identity, {
      epoch: epochAt(db, identity, now),
      promptVersion: promptVersion("implementer", profile.provider, profile, publishHeads, entryTools, objectiveDigest, codeMode),
    });
    rows.set(identity, selectRoutingEvidence(db, identityOf(profile), "start", since));
    applied.set(identity, appliedOutcomeIds(db, identity, since));
  }
  return { representative, rows, current, applied };
}

function scoreAt(
  screened: readonly Screened[],
  evidence: Evidence,
  target: RoutingTarget,
  knobs: RoutingKnobs,
  now: string,
  headrooms: ReadonlyMap<Provider, ProviderHeadroom>,
): StatusProfile[] {
  const posteriors = new Map<string, ProfilePosterior>();
  const scored = new Map<string, Scored>();
  for (const [identity, profile] of evidence.representative) {
    const rows = evidence.rows.get(identity) ?? [];
    const current = evidence.current.get(identity)!;
    const found = posterior(rows, target, current, now, CHOSEN_WEIGHT, evidence.applied.get(identity));
    const cost = expectedCost(profile, observedCost(rows, target, current.epoch, now).listUsd);
    posteriors.set(identity, found);
    scored.set(identity, { profile, identity, posterior: found, costUsd: cost.costUsd, costBasis: cost.basis, headroom: headrooms.get(profile.provider) });
  }
  const choice = choose(screened, scored, knobs, STATUS_RISK, "status");
  return screened.map(item => {
    const found = posteriors.get(item.identity)!;
    const entry = scored.get(item.identity)!;
    const theta = found.theta, mean = betaMean(theta), sd = betaSd(theta);
    const earlier = found.reward.reduce((sum, level) => {
      const raw = level.earlier.success + level.earlier.failure;
      return { rows: sum.rows + level.earlier.rows, mass: sum.mass + raw, appliedMass: sum.appliedMass + level.earlier.scale * raw };
    }, { rows: 0, mass: 0, appliedMass: 0 });
    return {
      profileId: item.profile.id,
      ...(item.removed === "contributor" || item.removed === "reviewer-model" ? { removed: item.removed } : {}),
      rows: found.rows,
      earlier: { rows: earlier.rows, mass: round3(earlier.mass), appliedMass: round3(earlier.appliedMass) },
      mean: round3(mean),
      interval: [round3(clip(mean - Z_90 * sd)), round3(clip(mean + Z_90 * sd))],
      rescue: round3(betaMean(found.phi)),
      level: found.level,
      costUsd: entry.costUsd,
      ...(entry.costBasis === undefined ? {} : { costBasis: entry.costBasis }),
      greedy: choice?.greedy === item.profile.id,
    };
  });
}

export function routingStatus(store: EvidenceStore, input: RoutingStatusInput): RoutingStatus {
  requireReady(store, REQUIRED_MODULES);
  const effective = effectiveRouting(input.saved, input.autonomy);
  const knobs = effective.mode === "shadow" ? effective.knobs : null;
  const screened = input.lineup && knobs ? screen(input.lineup, knobs, new Set()) : [];
  const eligible = screened.some(item => item.removed === undefined);
  const reason: RoutingStatus["covers"]["reason"] = effective.mode === "off" ? "off"
    : !input.lineup ? "no-lineup"
    : !effective.knobs.points.includes("start") ? "no-start-point"
    : eligible ? null
    : "no-eligible-profile";
  const since = daysBefore(input.now, SHADOW_WINDOW_DAYS);
  const pinsAuto = knobs !== null && knobs.points.includes("start") && input.lineup !== undefined
    && (input.saved?.mode === "auto" || (input.saved?.mode === undefined && input.autonomy === "autonomous" && reason === null));

  return store.read(db => {
    const decided = projectDecisions(db, input.projectId, since);
    const rows = decided.rows;
    const recorded = rows.filter(row => row.state === "recorded");
    const withCoordinator = recorded.filter(row => row.coordinatorProfileId !== null);
    const progress = shadowProgress(db, input.projectId);
    const state = readProjectState(db, input.projectId);
    const computed = computedPeriodEnd(db, input.projectId);
    const endedAt = state.periodEndedAt ?? (computed !== undefined && Date.parse(computed.endsAt) <= Date.parse(input.now) ? computed.endsAt : null);
    const mode: RoutingMode = effective.mode === "off" ? "off" : pinsAuto && endedAt !== null ? "auto" : "shadow";
    const autoMode = mode === "auto";
    const headrooms = input.lineup
      ? readProviderHeadrooms(db, input.lineup.implementers.map(profile => profile.provider), input.limited ?? new Set(), input.limitHistory ?? [], input.prices, input.now)
      : new Map<Provider, ProviderHeadroom>();
    let cells: { cell: StatusCell; profiles: StatusProfile[] }[] = [];
    let cellsCapped = false, unreadableCells = 0;
    if (knobs && reason === null && input.lineup) {
      const evidence = readEvidence(db, screened, input.publishHeads, input.entryTools, input.objectiveDigest, input.codeMode, input.now);
      const projectRef = db.index("project", input.projectId);
      const found = projectCells(db, input.projectId, since, STATUS_CELL_LIMIT);
      cellsCapped = found.capped;
      for (const cell of found.cells) {
        if (cell.payload === null) {
          unreadableCells++;
          continue;
        }
        const target: RoutingTarget = {
          projectRef, areaRef: cell.areaRef ?? "", kind: cell.kind, featureVersion: cell.featureVersion,
          featureMapRef: cell.featureMapRef, point: "start",
        };
        cells.push({
          cell: { scope: "cell", area: cell.payload.area, taskKind: cell.kind, featureVersion: cell.featureVersion, featureMap: cell.payload.featureMap },
          profiles: scoreAt(screened, evidence, target, knobs, input.now, headrooms),
        });
      }
      const newTask: RoutingTarget = {
        projectRef, areaRef: db.index("area", NEW_TASK_AREA), kind: null, featureVersion: 0, featureMapRef: "", point: "start",
      };
      cells.push({ cell: { scope: "new-task" }, profiles: scoreAt(screened, evidence, newTask, knobs, input.now, headrooms) });
    }
    const bases = cells.flatMap(entry => entry.profiles.filter(profile => profile.removed === undefined).map(profile => profile.costBasis ?? "tier-default"));
    const observedBases = bases.filter(basis => basis === "observed").length;
    const costsBasis: CostsBasis = observedBases === 0 ? "tier-default" : observedBases === bases.length ? "observed" : "mixed";
    const exploring = autoMode ? rows.filter(row => row.state === "pending" || row.state === "applied") : recorded;
    const explore: RoutingStatus["explore"] = {
      exploratory: exploring.filter(row => row.explore).length, of: exploring.length, guards: autoMode ? "applied" : "risk-only",
      pausedAt: state.explorePausedAt,
    };
    const count = (name: DecisionRow["state"]) => rows.filter(row => row.state === name).length;
    return {
      projectId: input.projectId,
      mode,
      requested: effective.mode === "shadow" ? effective.requested : null,
      source: effective.mode === "shadow" ? effective.source : null,
      modeSource: effective.mode === "off" ? null : input.saved?.mode !== undefined ? "saved" : "autonomous-default",
      knobs,
      defaults: effective.mode === "shadow" ? effective.defaults : [],
      covers: { start: reason === null, reason },
      costs: { lightUsd: TIER_COSTS.light, strongUsd: TIER_COSTS.strong, rescueUsd: RESCUE_USD, basis: costsBasis },
      headroom: "modelled",
      ...(headrooms.size > 0 ? { providers: Object.fromEntries(headrooms) } : {}),
      interval: "normal-approx-90",
      chosenWeight: CHOSEN_WEIGHT,
      limits: "not-applied",
      shadow: {
        windowDays: SHADOW_WINDOW_DAYS,
        decisions: recorded.length,
        withCoordinator: withCoordinator.length,
        agreements: withCoordinator.filter(row => row.chosenProfileId === row.coordinatorProfileId).length,
        greedyAgreements: withCoordinator.filter(row => row.greedyProfileId === row.coordinatorProfileId).length,
        capped: decided.capped,
      },
      explore,
      period: {
        decisions: progress.decisions, capped: progress.capped, firstAt: progress.firstAt,
        endsAt: computed?.endsAt ?? null, endedAt, stored: state.periodEndedAt !== null, targetDays: 14, targetDecisions: 50,
      },
      share: autoMode && knobs
        ? { ...shareWindow(db, input.projectId, knobs.exploreWindow, input.now), window: knobs.exploreWindow, limit: knobs.maxExploreShare }
        : null,
      auto: autoMode
        ? { windowDays: SHADOW_WINDOW_DAYS, pending: count("pending"), applied: count("applied"), released: count("released"), capped: decided.capped }
        : null,
      cells,
      cellsCapped,
      unreadableCells,
    };
  });
}

export function routingExplain(store: EvidenceStore, runId: string, taskId: string): RoutingExplain | undefined {
  requireReady(store, [ROUTING_MODULE]);
  const found = store.read(db => taskDecisions(db, runId, taskId));
  if (found.rows.length === 0) return undefined;
  const decisions = found.rows.map(row => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of HIDDEN_FIELDS) delete copy[field];
    return copy as ExplainedDecision;
  });
  return { runId, taskId, decisions, capped: found.capped };
}
