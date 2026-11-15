import type { AutonomyMode } from "./autonomy.js";
import { promptVersion } from "./config-identity.js";
import { CONFIGURATIONS_MODULE, epochAt } from "./configuration-store.js";
import type { EvidenceDb } from "./evidence/types.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError } from "./evidence/types.js";
import { OUTCOMES_MODULE, selectRoutingEvidence } from "./outcome-store.js";
import { profileIdentity } from "./run-events.js";
import { choose, RESCUE_USD, screen, TIER_COSTS, tierCost, type Screened, type Scored } from "./routing-choice.js";
import { effectiveRouting, type TeamRouting } from "./routing-policy.js";
import {
  betaMean, betaSd, CHOSEN_WEIGHT, MAX_AGE_DAYS, posterior, type CurrentConfig, type RoutingTarget,
} from "./routing-posterior.js";
import { projectCells, projectDecisions, ROUTING_MODULE, shadowProgress, taskDecisions } from "./routing-store.js";
import type {
  ExplainedDecision, Identity, ProfilePosterior, RoutingEvidenceRow, RoutingExplain, RoutingKnobs, RoutingStatus, StatusCell,
  StatusProfile,
} from "./routing-types.js";
import type { TeamLineup, TeamModelProfile } from "./team-types.js";

export const STATUS_CELL_LIMIT = 50, SHADOW_WINDOW_DAYS = 30;
/** The z value of a 90% normal interval. */
const Z_90 = 1.645;
const DAY_MS = 86_400_000;
/** The area of the new-task line. It holds no blind index in any row, so its target is the project level. */
const NEW_TASK_AREA = "(new task)";
/**
 * The status reads every cell at normal risk. Risk is a plain column of a decision row, but it is not part of the cell
 * key (area, kind, feature version, feature map), so a cell has no one risk to read.
 */
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
  now: string;
};

/** Three decimals, so a mean is never shown to more digits than the evidence carries. */
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clip = (value: number) => Math.min(1, Math.max(0, value));
const daysBefore = (now: string, days: number) => new Date(Date.parse(now) - days * DAY_MS).toISOString();

function requireReady(store: EvidenceStore, names: readonly string[]): void {
  const modules = store.status().modules;
  if (names.some(name => modules[name] !== "ready")) throw new EvidenceError("unavailable", "The evidence store is unavailable.");
}

/** The route identity's plain form, as the recorder builds it: effort, or the variant for OpenCode. */
function identityOf(profile: TeamModelProfile): Identity {
  const identity = profileIdentity(profile, profile.provider);
  return { provider: identity.provider, model: identity.model ?? profile.model, effort: identity.effort ?? null };
}

/**
 * Each identity's representative profile, rows, and current configuration, read once for the whole status. The
 * representative is the first eligible profile of the identity in lineup order, or its first removed profile when no
 * eligible one exists, as the recorder picks it. Keyed by the screened identity.
 */
type Evidence = { representative: Map<string, TeamModelProfile>; rows: Map<string, RoutingEvidenceRow[]>; current: Map<string, CurrentConfig> };

function readEvidence(db: EvidenceDb, screened: readonly Screened[], publishHeads: boolean, entryTools: boolean, now: string): Evidence {
  const since = daysBefore(now, MAX_AGE_DAYS);
  const representative = new Map<string, TeamModelProfile>();
  for (const item of [...screened.filter(item => item.removed === undefined), ...screened.filter(item => item.removed !== undefined)]) {
    if (!representative.has(item.identity)) representative.set(item.identity, item.profile);
  }
  const rows = new Map<string, RoutingEvidenceRow[]>();
  const current = new Map<string, CurrentConfig>();
  for (const [identity, profile] of representative) {
    current.set(identity, {
      epoch: epochAt(db, identity, now),
      promptVersion: promptVersion("implementer", profile.provider, profile, publishHeads, entryTools),
    });
    rows.set(identity, selectRoutingEvidence(db, identityOf(profile), "start", since));
  }
  return { representative, rows, current };
}

/**
 * The posterior of every identity at one target, and the greedy pick of `choose`. Each identity is scored at its
 * representative profile's cost, so every profile of one identity shows the same cost. Removed profiles are scored too.
 */
function scoreAt(screened: readonly Screened[], evidence: Evidence, target: RoutingTarget, knobs: RoutingKnobs, now: string): StatusProfile[] {
  const posteriors = new Map<string, ProfilePosterior>();
  const scored = new Map<string, Scored>();
  for (const [identity, profile] of evidence.representative) {
    const found = posterior(evidence.rows.get(identity) ?? [], target, evidence.current.get(identity)!, now, CHOSEN_WEIGHT);
    posteriors.set(identity, found);
    scored.set(identity, { profile, identity, posterior: found, costUsd: tierCost(profile) });
  }
  const choice = choose(screened, scored, knobs, STATUS_RISK, "status");
  return screened.map(item => {
    const found = posteriors.get(item.identity)!;
    const cost = scored.get(item.identity)!.costUsd;
    const theta = found.theta, mean = betaMean(theta), sd = betaSd(theta);
    // The raw earlier mass, and the mass the posterior applied after each level's cap (scale times the raw mass).
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
      costUsd: cost,
      greedy: choice?.greedy === item.profile.id,
    };
  });
}

/**
 * The shadow status of one project: the coverage of the start point, the shadow agreement of the last 30 days, the
 * shadow period, and the posterior of each profile at each recorded cell (at most 50) and at the new-task line.
 * Throws EvidenceError `unavailable` unless `outcomes`, `configurations`, and `routing` are ready. Writes nothing.
 */
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

  return store.read(db => {
    const decided = projectDecisions(db, input.projectId, since);
    const rows = decided.rows;
    const withCoordinator = rows.filter(row => row.coordinatorProfileId !== null);
    const progress = shadowProgress(db, input.projectId);
    let cells: { cell: StatusCell; profiles: StatusProfile[] }[] = [];
    let cellsCapped = false, unreadableCells = 0;
    if (knobs && reason === null && input.lineup) {
      const evidence = readEvidence(db, screened, input.publishHeads, input.entryTools, input.now);
      const projectRef = db.index("project", input.projectId);
      const recorded = projectCells(db, input.projectId, since, STATUS_CELL_LIMIT);
      cellsCapped = recorded.capped;
      for (const cell of recorded.cells) {
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
          profiles: scoreAt(screened, evidence, target, knobs, input.now),
        });
      }
      // No row holds this area's blind index and the feature version is 0, so only the project level applies.
      const newTask: RoutingTarget = {
        projectRef, areaRef: db.index("area", NEW_TASK_AREA), kind: null, featureVersion: 0, featureMapRef: "", point: "start",
      };
      cells.push({ cell: { scope: "new-task" }, profiles: scoreAt(screened, evidence, newTask, knobs, input.now) });
    }
    return {
      projectId: input.projectId,
      mode: effective.mode,
      requested: effective.mode === "shadow" ? effective.requested : null,
      source: effective.mode === "shadow" ? effective.source : null,
      knobs,
      defaults: effective.mode === "shadow" ? effective.defaults : [],
      covers: { start: reason === null, reason },
      costs: { lightUsd: TIER_COSTS.light, strongUsd: TIER_COSTS.strong, rescueUsd: RESCUE_USD, basis: "tier-default" },
      headroom: "not-modelled",
      interval: "normal-approx-90",
      chosenWeight: CHOSEN_WEIGHT,
      limits: "not-applied",
      shadow: {
        windowDays: SHADOW_WINDOW_DAYS,
        decisions: rows.length,
        withCoordinator: withCoordinator.length,
        agreements: withCoordinator.filter(row => row.chosenProfileId === row.coordinatorProfileId).length,
        greedyAgreements: withCoordinator.filter(row => row.greedyProfileId === row.coordinatorProfileId).length,
        capped: decided.capped,
      },
      explore: { exploratory: rows.filter(row => row.explore).length, of: rows.length, guards: "risk-only" },
      period: { decisions: progress.decisions, capped: progress.capped, firstAt: progress.firstAt, targetDays: 14, targetDecisions: 50 },
      cells,
      cellsCapped,
      unreadableCells,
    };
  });
}

/** The start decisions of one task of one run, revision order, without the blind indexes. Undefined when none exists. */
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
