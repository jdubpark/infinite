import type { OutcomeRow } from "./outcome-store.js";
import { MIN_COUNTED_ROWS, completeCost, isMetered, median, rowMinutes, rowTime, rowUse, wilsonInterval, type CostLookup, type ExclusionCounts, type Source } from "./outcome-cells.js";
import { formatUsd } from "./usage.js";

export { wilsonInterval } from "./outcome-cells.js";

export type ModelRow = {
  profileId: string; label: string; provider: string; role: string; metered: boolean;
  attempts: number; integrated: number; rate: number; rateInterval: [number, number] | null;
  medianUsd: number | null; medianTokens: number | null; usdPerMTok: number | null;
  medianMinutes: number | null; meanReviewRounds: number | null;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number; n: number } | null;
  owner: { mean: number; n: number } | null; enough: boolean; excluded: ExclusionCounts;
};
export type Suggestion = { text: string; profileId: string; comparedTo: string; role: string; n: [number, number] };
export type Scorecard = { rubricVersion: 1; minAttempts: number; sources: Source[]; rows: ModelRow[]; suggestions: Suggestion[] };

/** The identity that the configured lineup gives a profile id now. Undefined when the lineup does not have the id. */
export type ProfileIdentityOf = (profileId: string) => { provider: string; model: string; effort: string | null } | undefined;

type Group = { profileId: string; provider: string; epoch: number; identity: string; newest: number; rows: OutcomeRow[] };

const identityOf = (provider: string, model: string, effort: string | null) => JSON.stringify([provider, model, effort ?? "none"]);

/** Between identities of an id that the lineup no longer has: the newest rowTime, then the smaller identity string. */
function preferred(candidate: Group, current: Group): boolean {
  if (candidate.newest !== current.newest) return candidate.newest > current.newest;
  return candidate.identity < current.identity;
}

function timeOf(row: OutcomeRow): number {
  const time = rowTime(row);
  const milliseconds = time === null ? Number.NaN : Date.parse(time);
  return Number.isFinite(milliseconds) ? milliseconds : -Infinity;
}

const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function modelRowOf(group: Group, role: string, minAttempts: number, cost: CostLookup | undefined): ModelRow | null {
  const excluded: ExclusionCounts = { limit: 0, owner: 0, host: 0, duel: 0 };
  const attempts: Array<{ row: OutcomeRow; success: boolean }> = [];
  for (const row of group.rows) {
    const use = rowUse(row, "display");
    if (use.kind === "excluded") excluded[use.exclusion]++;
    else if (use.kind === "counted") attempts.push({ row, success: row.role === "scout" ? use.completed : use.levels.integrated === 1 });
  }
  if (attempts.length === 0) return null;
  const wins = attempts.filter(attempt => attempt.success).map(attempt => attempt.row);
  const metered = isMetered(group.provider);
  const costs = wins.flatMap(row => { const found = completeCost(row, cost); return found ? [found] : []; });
  const medianUsd = metered ? median(costs.map(found => found.usd)) : null;
  const medianTokens = metered ? median(costs.map(found => found.tokens)) : null;
  const minutes = wins.flatMap(row => { const value = rowMinutes(row); return value === undefined ? [] : [value]; });
  const rubrics = wins.flatMap(row => (row.payload.rubric?.version === 1 ? [row.payload.rubric] : []));
  const ratings = wins.flatMap(row => (row.payload.ownerRating ? [row.payload.ownerRating.score] : []));
  const integrated = wins.length, counted = attempts.length;
  return {
    profileId: group.profileId, label: group.profileId, provider: group.provider, role, metered,
    attempts: counted, integrated, rate: integrated / counted, rateInterval: wilsonInterval(integrated, counted),
    medianUsd, medianTokens, usdPerMTok: medianUsd !== null && medianTokens ? medianUsd / medianTokens * 1_000_000 : null,
    medianMinutes: median(minutes), meanReviewRounds: mean(wins.map(row => row.payload.rounds.run)),
    rubric: rubrics.length ? {
      correctness: mean(rubrics.map(item => item.correctness))!, cleanliness: mean(rubrics.map(item => item.cleanliness))!,
      extensibility: mean(rubrics.map(item => item.extensibility))!, docs: mean(rubrics.map(item => item.docs))!, n: rubrics.length,
    } : null,
    owner: ratings.length ? { mean: mean(ratings)!, n: ratings.length } : null,
    enough: counted >= minAttempts, excluded,
  };
}

type SuggestableRow = Omit<ModelRow, "excluded">;

function suggestionsOf(rows: readonly SuggestableRow[], role: string): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const cheap of rows.filter(row => row.enough && row.metered && row.medianUsd !== null)) for (const other of rows) {
    if (other === cheap || !other.enough || other.role !== cheap.role || (other.metered && (other.medianUsd === null || cheap.medianUsd! >= other.medianUsd))) continue;
    const a = cheap.rateInterval!, b = other.rateInterval!;
    if (a[1] < b[0]) continue;
    const otherUsd = other.metered ? ` at a median $${formatUsd(other.medianUsd!)}` : "";
    let text = `${cheap.label} integrated ${cheap.integrated}/${cheap.attempts} ${role} tasks at a median $${formatUsd(cheap.medianUsd!)}; ${other.label} ${other.integrated}/${other.attempts}${otherUsd}`;
    if (cheap.rubric && other.rubric && cheap.rubric.n >= 5 && other.rubric.n >= 5) {
      const quality = (row: SuggestableRow) => row.owner?.mean ?? (row.rubric!.correctness + row.rubric!.cleanliness + row.rubric!.extensibility + row.rubric!.docs) / 4;
      text += ` (rubric ${quality(cheap).toFixed(1)} vs ${quality(other).toFixed(1)})`;
    }
    suggestions.push({ text, profileId: cheap.profileId, comparedTo: other.profileId, role, n: [cheap.attempts, other.attempts] });
  }
  return suggestions;
}

/** One row per profile id, from production rows of one role. Reads the display use of each row. */
export function scorecardFromRows(rows: readonly OutcomeRow[], options: { role: string; label: (profileId: string) => string | undefined; identity?: ProfileIdentityOf; cost?: CostLookup; minAttempts?: number }): Scorecard {
  const minAttempts = options.minAttempts ?? MIN_COUNTED_ROWS;
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.source !== "production" || row.role !== options.role) continue;
    if (row.profileId === "default" || row.profileId === "unknown") continue;
    const identity = identityOf(row.provider, row.model, row.effort);
    const key = JSON.stringify([row.profileId, identity, row.profileEpoch]);
    const group = groups.get(key) ?? { profileId: row.profileId, provider: row.provider, epoch: row.profileEpoch, identity, newest: -Infinity, rows: [] };
    group.rows.push(row);
    group.newest = Math.max(group.newest, timeOf(row));
    groups.set(key, group);
  }
  // Within one identity the higher epoch is always the newer one: an attempt keeps the epoch it started in, so an
  // attempt from before an advance can end after it, and its end time must not bring the retired epoch back.
  const candidates = new Map<string, Group>();
  for (const group of groups.values()) {
    const key = JSON.stringify([group.profileId, group.identity]);
    const current = candidates.get(key);
    if (!current || group.epoch > current.epoch) candidates.set(key, group);
  }
  // The configured lineup says which identity an id names now. A goal or a mission pins its lineup, so two
  // identities behind one id can both keep ending attempts, and end times cannot choose between them.
  const chosen = new Map<string, Group>();
  const configured = new Map<string, string | undefined>();
  for (const group of candidates.values()) {
    if (!configured.has(group.profileId)) {
      const named = options.identity?.(group.profileId);
      configured.set(group.profileId, named ? identityOf(named.provider, named.model, named.effort) : undefined);
    }
    const wanted = configured.get(group.profileId);
    if (wanted !== undefined) {
      if (group.identity === wanted) chosen.set(group.profileId, group);
      continue;
    }
    const current = chosen.get(group.profileId);
    if (!current || preferred(group, current)) chosen.set(group.profileId, group);
  }
  const modelRows: ModelRow[] = [];
  for (const group of chosen.values()) {
    const entry = modelRowOf(group, options.role, minAttempts, options.cost);
    if (entry) modelRows.push({ ...entry, label: options.label(group.profileId) ?? group.profileId });
  }
  modelRows.sort((a, b) => a.profileId.localeCompare(b.profileId));
  return { rubricVersion: 1, minAttempts, sources: ["production"], rows: modelRows, suggestions: suggestionsOf(modelRows, options.role) };
}
