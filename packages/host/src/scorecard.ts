import type { TeamMember, TeamRun, TeamTask } from "./team-types.js";

export type ModelRow = { profileId: string; label: string; provider: string; role: string; metered: boolean;
  attempts: number; integrated: number; rate: number; rateInterval: [number, number] | null;
  medianUsd: number | null; medianTokens: number | null; usdPerMTok: number | null;
  medianMinutes: number | null; meanReviewRounds: number | null;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number; n: number } | null;
  owner: { mean: number; n: number } | null; enough: boolean };
export type Suggestion = { text: string; profileId: string; comparedTo: string; role: string; n: [number, number] };
export type TaskUsage = (sessionId: string) => { cost: number; tokens: number; unpriced: number } | undefined;

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function wilsonInterval(successes: number, attempts: number): [number, number] | null {
  if (!attempts) return null;
  const z = 1.959963984540054, p = successes / attempts, z2 = z * z, denominator = 1 + z2 / attempts;
  const center = (p + z2 / (2 * attempts)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
type ScorecardRun = Pick<TeamRun, "tasks"> & { members: Array<Omit<TeamMember, "prompt">> };
type Attempt = { member: Omit<TeamMember, "prompt">; task?: TeamTask; run: ScorecardRun };
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
  const rows: ModelRow[] = [...grouped.entries()].map(([profileId, attempts]) => {
    const profile = attempts[0].member.modelProfile!;
    const integrated = attempts.filter(({ task, member }) => task?.status === "integrated" && task.memberId === member.memberId);
    const measured = profile.provider === "opencode" ? integrated.map(({ member }) => usage(member.sessionId)) : [];
    const costs = measured.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.unpriced === 0).map(entry => entry!.cost);
    const tokens = measured.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.unpriced === 0).map(entry => entry!.tokens);
    const minutes = integrated.flatMap(({ member }) => member.startedAt ? [Math.max(0, (Date.parse(member.reportedAt ?? new Date().toISOString()) - Date.parse(member.startedAt)) / 60000)] : []);
    const tasks = integrated.map(({ task }) => task!);
    const rubricTasks = tasks.filter(task => task.rubric?.version === 1).map(task => task.rubric!);
    const ownerRatings = tasks.flatMap(task => task.ownerRating ? [task.ownerRating.score] : []);
    const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const isMetered = profile.provider === "opencode";
    const medUsd = isMetered ? median(costs) : null, medTokens = isMetered ? median(tokens) : null;
    return { profileId, label: profile.label, provider: profile.provider, role, metered: isMetered, attempts: attempts.length,
      integrated: integrated.length, rate: integrated.length / attempts.length, rateInterval: wilsonInterval(integrated.length, attempts.length),
      medianUsd: medUsd, medianTokens: medTokens, usdPerMTok: medUsd !== null && medTokens ? medUsd / medTokens * 1_000_000 : null,
      medianMinutes: median(minutes), meanReviewRounds: mean(tasks.flatMap(task => task.reviewRounds === undefined ? [] : [task.reviewRounds])),
      rubric: rubricTasks.length ? { correctness: mean(rubricTasks.map(item => item.correctness.score))!, cleanliness: mean(rubricTasks.map(item => item.cleanliness.score))!, extensibility: mean(rubricTasks.map(item => item.extensibility.score))!, docs: mean(rubricTasks.map(item => item.docs.score))!, n: rubricTasks.length } : null,
      owner: ownerRatings.length ? { mean: mean(ownerRatings)!, n: ownerRatings.length } : null, enough: attempts.length >= minAttempts };
  }).sort((a, b) => a.profileId.localeCompare(b.profileId));
  const suggestions: Suggestion[] = [];
  for (const cheap of rows.filter(row => row.enough && row.metered && row.medianUsd !== null)) for (const other of rows) {
    if (other === cheap || !other.enough || other.role !== cheap.role || (other.metered && (other.medianUsd === null || cheap.medianUsd! >= other.medianUsd))) continue;
    const a = cheap.rateInterval!, b = other.rateInterval!;
    if (a[1] < b[0]) continue;
    const otherUsd = other.metered ? ` at a median $${other.medianUsd}` : "";
    let text = `${cheap.label} integrated ${cheap.integrated}/${cheap.attempts} ${role} tasks at a median $${cheap.medianUsd}; ${other.label} ${other.integrated}/${other.attempts}${otherUsd}`;
    if (cheap.rubric && other.rubric && cheap.rubric.n >= 5 && other.rubric.n >= 5) {
      const quality = (row: ModelRow) => row.owner?.mean ?? (row.rubric!.correctness + row.rubric!.cleanliness + row.rubric!.extensibility + row.rubric!.docs) / 4;
      text += ` (rubric ${quality(cheap).toFixed(1)} vs ${quality(other).toFixed(1)})`;
    }
    suggestions.push({ text, profileId: cheap.profileId, comparedTo: other.profileId, role, n: [cheap.attempts, other.attempts] });
  }
  return { rubricVersion: 1 as const, minAttempts, rows, suggestions };
}
