import type { TeamMember, TeamRun, TeamTask } from "./team-types.js";
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
export type TaskUsage = (sessionId: string) => { cost: number; tokens: number; unpriced: number } | undefined;

type Group = { profileId: string; provider: string; epoch: number; identity: string; newest: number; rows: OutcomeRow[] };

/** Newest rowTime first, then the higher epoch, then the smaller identity string. */
function preferred(candidate: Group, current: Group): boolean {
  if (candidate.newest !== current.newest) return candidate.newest > current.newest;
  if (candidate.epoch !== current.epoch) return candidate.epoch > current.epoch;
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
export function scorecardFromRows(rows: readonly OutcomeRow[], options: { role: string; label: (profileId: string) => string | undefined; cost?: CostLookup; minAttempts?: number }): Scorecard {
  const minAttempts = options.minAttempts ?? MIN_COUNTED_ROWS;
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.source !== "production" || row.role !== options.role) continue;
    if (row.profileId === "default" || row.profileId === "unknown") continue;
    const identity = JSON.stringify([row.provider, row.model, row.effort ?? "none"]);
    const key = JSON.stringify([row.profileId, identity, row.profileEpoch]);
    const group = groups.get(key) ?? { profileId: row.profileId, provider: row.provider, epoch: row.profileEpoch, identity, newest: -Infinity, rows: [] };
    group.rows.push(row);
    group.newest = Math.max(group.newest, timeOf(row));
    groups.set(key, group);
  }
  const chosen = new Map<string, Group>();
  for (const group of groups.values()) {
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

// Legacy path: `scorecard(runs, usage)` over run records. server.ts is its only caller; Task 4 removes it.
type LegacyModelRow = Omit<ModelRow, "excluded">;
type ScorecardRun = Pick<TeamRun, "tasks"> & { members: Array<Omit<TeamMember, "prompt">> };
type Attempt = { member: Omit<TeamMember, "prompt">; task?: TeamTask; run: ScorecardRun };
const legacyMedian = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function scorecard(runs: ScorecardRun[], usage: TaskUsage, options: { role?: string; minAttempts?: number } = {}) {
  const role = options.role ?? "implementer", minAttempts = options.minAttempts ?? 10;
  const grouped = new Map<string, Attempt[]>();
  for (const run of runs) for (const member of run.members) {
    if (member.role !== role || !member.taskId || member.stoppedReason && /usage limit|credit limit|provider limit/i.test(member.stoppedReason)) continue;
    const profile = member.modelProfile;
    if (!profile) continue;
    const key = profile.id;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push({ member, task: run.tasks.find(task => task.id === member.taskId), run });
  }
  const rows: LegacyModelRow[] = [...grouped.entries()].map(([profileId, attempts]) => {
    const profile = attempts[0].member.modelProfile!;
    const integrated = attempts.filter(({ task, member }) => task?.status === "integrated" && task.memberId === member.memberId);
    const measured = profile.provider === "opencode" ? integrated.map(({ member }) => usage(member.sessionId)) : [];
    const costs = measured.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.unpriced === 0).map(entry => entry!.cost);
    const tokens = measured.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.unpriced === 0).map(entry => entry!.tokens);
    const minutes = integrated.flatMap(({ member }) => member.startedAt && member.reportedAt ? [Math.max(0, (Date.parse(member.reportedAt) - Date.parse(member.startedAt)) / 60000)] : []);
    const tasks = integrated.map(({ task }) => task!);
    const rubricTasks = tasks.filter(task => task.rubric?.version === 1).map(task => task.rubric!);
    const ownerRatings = tasks.flatMap(task => task.ownerRating ? [task.ownerRating.score] : []);
    const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const isLegacyMetered = profile.provider === "opencode";
    const medUsd = isLegacyMetered ? legacyMedian(costs) : null, medTokens = isLegacyMetered ? legacyMedian(tokens) : null;
    return { profileId, label: profile.label, provider: profile.provider, role, metered: isLegacyMetered, attempts: attempts.length,
      integrated: integrated.length, rate: integrated.length / attempts.length, rateInterval: wilsonInterval(integrated.length, attempts.length),
      medianUsd: medUsd, medianTokens: medTokens, usdPerMTok: medUsd !== null && medTokens ? medUsd / medTokens * 1_000_000 : null,
      medianMinutes: legacyMedian(minutes), meanReviewRounds: mean(tasks.flatMap(task => task.reviewRounds === undefined ? [] : [task.reviewRounds])),
      rubric: rubricTasks.length ? { correctness: mean(rubricTasks.map(item => item.correctness.score))!, cleanliness: mean(rubricTasks.map(item => item.cleanliness.score))!, extensibility: mean(rubricTasks.map(item => item.extensibility.score))!, docs: mean(rubricTasks.map(item => item.docs.score))!, n: rubricTasks.length } : null,
      owner: ownerRatings.length ? { mean: mean(ownerRatings)!, n: ownerRatings.length } : null, enough: attempts.length >= minAttempts };
  }).sort((a, b) => a.profileId.localeCompare(b.profileId));
  return { rubricVersion: 1 as const, minAttempts, rows, suggestions: suggestionsOf(rows, role) };
}
