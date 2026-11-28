import type { ReplayPrior } from "./eval-types.js";
import { rowUse } from "./outcome-cells.js";
import type { Beta, LevelName, LevelRecord, ProfilePosterior, RoutingEvidenceRow, RoutingPoint } from "./routing-types.js";

export const HALF_LIFE_DAYS = 30, MAX_AGE_DAYS = 180, LEVEL_STRENGTH = 20, EARLIER_MASS = 10, REPLAY_PRIOR_MASS = 4, MIN_COST_ROWS = 5;
export const CHOSEN_WEIGHT = 0.5;

export type RoutingTarget = { projectRef: string; areaRef: string; kind: string | null; featureVersion: number; featureMapRef: string; point: RoutingPoint; projectId?: string; area?: string };
export type CurrentConfig = { epoch: number; promptVersion: string };
export type Observation = { reward?: { r: number; w: number }; rescue?: { x: 0 | 1; w: number } };
export type ObservedCost = { listUsd: number | null; level: LevelName | "none"; rows: number };

const DAY_MILLISECONDS = 86_400_000;
const LEVELS: readonly LevelName[] = ["tenant", "project", "cell"];

type Sums = { success: number; failure: number; rows: number };
type Tally = Record<LevelName, { observed: Sums; earlier: Sums }>;

function emptyTally(): Tally {
  const sums = (): Sums => ({ success: 0, failure: 0, rows: 0 });
  return {
    tenant: { observed: sums(), earlier: sums() },
    project: { observed: sums(), earlier: sums() },
    cell: { observed: sums(), earlier: sums() },
  };
}

function ageDays(endedAt: string, now: string): number {
  return Math.max(0, (Date.parse(now) - Date.parse(endedAt)) / DAY_MILLISECONDS);
}

function rewardOf(row: RoutingEvidenceRow, levels: { accepted: 0 | 1 | null; firstPass: 0 | 1 | null; held: 0 | 1 | null }, nonIntegrated: boolean): { r: number; w: number } | undefined {
  if (nonIntegrated) return { r: 0, w: 1 };
  if (levels.accepted === 0) return { r: 0, w: 1 };
  if (levels.accepted === null) return undefined;
  if (levels.held === 0) return { r: 0, w: 1 };
  const provisional = levels.held === null ? 0.5 : 1;
  if (row.ownerScore !== null) return { r: (row.ownerScore - 1) / 4, w: provisional };
  return { r: levels.firstPass === 1 ? 1 : 0.5, w: provisional };
}

export function observe(row: RoutingEvidenceRow, now: string, chosenWeight: number): Observation | undefined {
  const use = rowUse(row, "decision");
  if (use.kind !== "counted" || row.endedAt === null) return undefined;
  const age = ageDays(row.endedAt, now);
  if (!Number.isFinite(age) || age > MAX_AGE_DAYS) return undefined;
  const weight = 0.5 ** (age / HALF_LIFE_DAYS) * chosenWeight;
  const nonIntegrated = row.disposition !== "integrated";
  const observation: Observation = {};
  const reward = rewardOf(row, use.levels, nonIntegrated);
  if (reward !== undefined) observation.reward = { r: reward.r, w: reward.w * weight };
  if (nonIntegrated) observation.rescue = { x: 0, w: weight };
  else if (use.levels.firstPass !== null) observation.rescue = { x: use.levels.firstPass, w: weight };
  return observation.reward || observation.rescue ? observation : undefined;
}

function levelOf(row: RoutingEvidenceRow, target: RoutingTarget): LevelName {
  if (row.projectRef !== target.projectRef) return "tenant";
  const inCell = row.areaRef === target.areaRef && row.kind === target.kind
    && row.featureVersion === target.featureVersion && row.featureMapRef === target.featureMapRef;
  return inCell ? "cell" : "project";
}

function chain(tally: Tally): LevelRecord[] {
  const records: LevelRecord[] = [];
  let parent: Beta | undefined;
  for (const level of LEVELS) {
    const { observed, earlier } = tally[level];
    const earlierMass = earlier.success + earlier.failure;
    const scale = earlierMass > EARLIER_MASS ? EARLIER_MASS / earlierMass : 1;
    const priorSuccess = scale * earlier.success, priorFailure = scale * earlier.failure;
    let strength: number, baseA: number, baseB: number;
    if (parent === undefined) {
      strength = 2;
      baseA = 1;
      baseB = 1;
    } else {
      const mass = parent.a + parent.b;
      strength = Math.min(LEVEL_STRENGTH, mass);
      baseA = (strength * parent.a) / mass;
      baseB = (strength * parent.b) / mass;
    }
    const posterior: Beta = {
      a: baseA + priorSuccess + observed.success,
      b: baseB + priorFailure + observed.failure,
    };
    records.push({
      level,
      observed: { success: observed.success, failure: observed.failure, rows: observed.rows },
      earlier: { success: earlier.success, failure: earlier.failure, rows: earlier.rows, scale },
      prior: { strength, mean: baseA / (baseA + baseB) },
      posterior,
    });
    parent = posterior;
  }
  return records;
}

function applyReplayPriors(
  reward: Tally,
  replayPriors: readonly ReplayPrior[],
  target: RoutingTarget,
  now: string,
): number {
  if (target.point !== "start" || replayPriors.length === 0) return 0;
  const replay = {
    project: { success: 0, failure: 0, rows: 0 },
    cell: { success: 0, failure: 0, rows: 0 },
  };
  const targetArea = target.area ?? target.areaRef;
  const ordered = [...replayPriors].sort((left, right) => {
    const a = `${left.jobId}\u0000${left.area}\u0000${left.kind ?? ""}\u0000${left.promptOrigin}\u0000${left.profileEpoch}\u0000${left.promptVersion}\u0000${left.generatedAt}\u0000${left.profileId}`;
    const b = `${right.jobId}\u0000${right.area}\u0000${right.kind ?? ""}\u0000${right.promptOrigin}\u0000${right.profileEpoch}\u0000${right.promptVersion}\u0000${right.generatedAt}\u0000${right.profileId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const prior of ordered) {
    if (prior.role !== "implementer") continue;
    if (target.projectId !== undefined && prior.projectId !== target.projectId) continue;
    if (prior.trials <= 0 || prior.resolved < 0 || prior.resolved > prior.trials) continue;
    const age = ageDays(prior.generatedAt, now);
    if (!Number.isFinite(age) || age > MAX_AGE_DAYS) continue;
    const decay = 0.5 ** (age / HALF_LIFE_DAYS);
    const level = prior.area === targetArea && prior.kind === target.kind ? "cell" : "project";
    replay[level].success += decay * prior.resolved;
    replay[level].failure += decay * (prior.trials - prior.resolved);
    replay[level].rows += prior.trials;
  }
  let addedRows = 0;
  for (const level of ["project", "cell"] as const) {
    const bucket = replay[level];
    const mass = bucket.success + bucket.failure;
    if (mass <= 0) continue;
    const scale = mass > REPLAY_PRIOR_MASS ? REPLAY_PRIOR_MASS / mass : 1;
    reward[level].earlier.success += scale * bucket.success;
    reward[level].earlier.failure += scale * bucket.failure;
    reward[level].earlier.rows += bucket.rows;
    addedRows += bucket.rows;
  }
  return addedRows;
}

export function posterior(
  rows: readonly RoutingEvidenceRow[],
  target: RoutingTarget,
  current: CurrentConfig,
  now: string,
  chosenWeight: number = CHOSEN_WEIGHT,
  routerChosen?: ReadonlySet<string>,
  replayPriors?: readonly ReplayPrior[],
): ProfilePosterior {
  const reward = emptyTally(), rescue = emptyTally();
  const counts = { production: 0, duel: 0 };
  let earlierRows = 0, untimed = 0;
  const ordered = rows
    .filter(row => (row.source === "production" || row.source === "duel") && row.point === target.point)
    .sort((left, right) => (left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0));
  for (const row of ordered) {
    const use = rowUse(row, "decision");
    if (use.kind !== "counted") continue;
    if (row.endedAt === null) {
      untimed++;
      continue;
    }
    const found = observe(row, now, routerChosen?.has(row.outcomeId) ? 1 : chosenWeight);
    if (found === undefined) continue;
    const at = levelOf(row, target);
    const isCurrent = row.profileEpoch === current.epoch && row.promptVersion === current.promptVersion;
    const bucket = isCurrent ? "observed" : "earlier";
    if (found.reward !== undefined) {
      const sums = reward[at][bucket];
      sums.success += found.reward.w * found.reward.r;
      sums.failure += found.reward.w * (1 - found.reward.r);
      sums.rows++;
      if (isCurrent) counts[row.source === "duel" ? "duel" : "production"]++;
      else earlierRows++;
    }
    if (found.rescue !== undefined) {
      const sums = rescue[at][bucket];
      sums.success += found.rescue.w * found.rescue.x;
      sums.failure += found.rescue.w * (1 - found.rescue.x);
      sums.rows++;
    }
  }
  if (replayPriors !== undefined) earlierRows += applyReplayPriors(reward, replayPriors, target, now);
  const rewardRecords = chain(reward), rescueRecords = chain(rescue);
  const level: LevelName | "none" = reward.cell.observed.rows > 0 ? "cell"
    : reward.project.observed.rows > 0 ? "project"
    : reward.tenant.observed.rows > 0 ? "tenant"
    : "none";
  return {
    reward: rewardRecords,
    rescue: rescueRecords,
    theta: rewardRecords[2]!.posterior,
    phi: rescueRecords[2]!.posterior,
    rows: counts,
    earlierRows,
    level,
    untimed,
  };
}

export function observedCost(
  rows: readonly RoutingEvidenceRow[],
  target: RoutingTarget,
  currentEpoch: number,
  now: string,
): ObservedCost {
  const buckets: Record<LevelName, { weightedSum: number; weight: number; rows: number }> = {
    cell: { weightedSum: 0, weight: 0, rows: 0 },
    project: { weightedSum: 0, weight: 0, rows: 0 },
    tenant: { weightedSum: 0, weight: 0, rows: 0 },
  };
  const ordered = rows
    .filter(row => (row.source === "production" || row.source === "duel") && row.point === target.point
      && row.profileEpoch === currentEpoch && row.endedAt !== null && row.listUsd !== null
      && Number.isFinite(row.listUsd) && row.listUsd >= 0)
    .sort((left, right) => (left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0));
  for (const row of ordered) {
    if (rowUse(row, "decision").kind !== "counted") continue;
    const age = ageDays(row.endedAt!, now);
    if (!Number.isFinite(age) || age > MAX_AGE_DAYS) continue;
    const weight = 0.5 ** (age / HALF_LIFE_DAYS);
    const level = levelOf(row, target);
    const scopes: readonly LevelName[] = level === "cell" ? ["cell", "project", "tenant"]
      : level === "project" ? ["project", "tenant"]
      : ["tenant"];
    for (const scope of scopes) {
      buckets[scope].weightedSum += weight * row.listUsd!;
      buckets[scope].weight += weight;
      buckets[scope].rows++;
    }
  }
  for (const level of ["cell", "project", "tenant"] as const) {
    const bucket = buckets[level];
    if (bucket.rows >= MIN_COST_ROWS && bucket.weight > 0) {
      return {
        listUsd: Math.round((bucket.weightedSum / bucket.weight) * 1_000_000) / 1_000_000,
        level,
        rows: bucket.rows,
      };
    }
  }
  return { listUsd: null, level: "none", rows: buckets.tenant.rows };
}

export function betaMean(beta: Beta): number {
  return beta.a / (beta.a + beta.b);
}

export function betaSd(beta: Beta): number {
  const mass = beta.a + beta.b;
  return Math.sqrt((beta.a * beta.b) / (mass * mass * (mass + 1)));
}
