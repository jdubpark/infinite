/** Usage records shared by the phone's Cost screens; kept platform-free for simple calculation tests. */
export type Pricing = "configured" | "catalog" | "provider" | "unknown";
export type Money = { usd: number; unpriced: number };
export type Balance = { amount: number; currency: string; asOf: string; stale: boolean } | null;
export type AccountView = { id: string; kind: "metered" | "subscription"; month?: Money; planUsd?: number; balance: Balance };
export type UsageOverview = { month: { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number }; accounts: AccountView[] };
export type DailyPoint = { date: string; usd: number; byAccount: Record<string, number> };
export type DailySeries = { tz: string; accounts: string[]; days: DailyPoint[] };
/** `unmeasured` counts sessions and briefings that ran without usage; older hosts omit it. */
export type ProjectCostRow = { id: string; name: string; total: Money; month: Money; spark: number[]; unmeasured?: number };
export type ProjectsList = { projects: ProjectCostRow[] };
export type ProjectCost = {
  id: string; name: string; total: Money; unmeasured?: number;
  /** USD per kind of work, not counts. */
  byKind: { goals: number; teams: number; sessions: number; briefings: number };
  goals: { id: string; title: string; total: Money; tasks: number }[];
  teams: { id: string; title: string; goalId?: string; total: Money }[];
  sessions: { id: string; title: string; total: Money }[];
  briefings: { total: Money; runs: number; unmeasured: number };
};
export type RubricScore = { score: 1 | 2 | 3 | 4 | 5; why: string };
export type Rubric = { version: 1; correctness: RubricScore; cleanliness: RubricScore; extensibility: RubricScore; docs: RubricScore; reviewerProfileId: string };
export type TaskUsage = { usd: number; unpriced: number; tokens: number; attempts: number; profiles: string[] };
export type OwnerRating = { score: 1 | 2 | 3 | 4 | 5; note?: string; at: string };
export type ModelRow = {
  profileId: string; label: string; provider: string; role: string; metered: boolean;
  attempts: number; integrated: number; rate: number; rateInterval: [number, number] | null;
  medianUsd: number | null; medianTokens: number | null; usdPerMTok: number | null;
  medianMinutes: number | null; meanReviewRounds: number | null;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number; n: number } | null;
  owner: { mean: number; n: number } | null; enough: boolean;
};
export type Suggestion = { text: string; profileId: string; comparedTo: string; role: string; n: [number, number] };
export type ModelsScorecard = { rubricVersion: 1; minAttempts: number; rows: ModelRow[]; suggestions: Suggestion[] };

export function deviceTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Dollars with cents; a priced fraction of a cent reads "<$0.01" rather than $0.00. */
export function usd(value: number, opts?: { compact?: boolean }): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  if (opts?.compact && value >= 1000) return `$${(value / 1000).toLocaleString([], { maximumFractionDigits: 1 })}K`;
  if (opts?.compact && value >= 100) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * How a figure reads: exact, a lower bound ("≥") when steps were unpriced or some work went
 * unmeasured beside measured dollars, or nothing at all ("—") when only unmeasured work exists.
 */
export function money(value: Money & { unmeasured?: number }) {
  const unmeasured = value.unmeasured ?? 0;
  const none = value.usd === 0 && value.unpriced === 0 && unmeasured > 0;
  return { text: none ? "—" : usd(value.usd), atLeast: !none && (value.unpriced > 0 || (unmeasured > 0 && value.usd > 0)), none };
}

/** Change against last month: a percentage once last month reached a dollar, otherwise the amount. */
export function delta(current: Money, previous: Money): { text: string; direction: "up" | "down" | "flat" } | null {
  if (previous.usd === 0) return null;
  const change = current.usd - previous.usd;
  if (Math.abs(change) < 0.01 || Math.abs(change / previous.usd) < 0.005) return { text: "no change", direction: "flat" };
  const direction = change > 0 ? "up" : "down";
  const amount = previous.usd >= 1 ? `${Math.round(Math.abs(change / previous.usd) * 100)}%` : usd(Math.abs(change));
  return { text: `${change > 0 ? "+" : "−"}${amount}`, direction };
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString([], { maximumFractionDigits: 1 })}M`;
  if (n >= 1000) return `${(n / 1000).toLocaleString([], { maximumFractionDigits: 1 })}K`;
  return String(n);
}

/** Day strings are local calendar dates; parsing them through `new Date(string)` would shift them to UTC. */
function localDate(date: string) {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}
export function monthName(start: string): string { return localDate(start).toLocaleDateString([], { month: "long" }); }
export function shortDay(date: string): string { return localDate(date).toLocaleDateString([], { month: "short", day: "numeric" }); }

/** The shared account palette, in slot order; every client draws the same account in the same hue. */
export const ACCOUNT_PALETTE = ["#3987E5", "#C98500", "#9085E9", "#199E70", "#D95926"] as const;
export const OTHER_COLOR = "#8f978f";
const KNOWN_COLORS: Record<string, string> = { deepseek: "#3987E5", meta: "#C98500", claude: "#9085E9", codex: "#199E70" };
/**
 * Colour follows the account, never its position in one screen's list. Known accounts keep their
 * hue; any other account takes, in sorted id order, a slot no known account present is using, and
 * muted once the slots run out. A project showing only Meta draws it as the overview does.
 */
export function accountColors(accounts: string[]): Record<string, string> {
  const taken = new Set(accounts.map(account => KNOWN_COLORS[account]).filter(Boolean));
  const free = ACCOUNT_PALETTE.filter(color => !taken.has(color));
  const colors: Record<string, string> = {};
  for (const account of [...accounts].sort()) colors[account] = KNOWN_COLORS[account] ?? free.shift() ?? OTHER_COLOR;
  return colors;
}

export const ACCOUNT_NAMES: Record<string, string> = { deepseek: "DeepSeek", meta: "Meta", claude: "Claude", codex: "Codex" };
export function accountName(id: string): string { return ACCOUNT_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1); }
export const ROLE_OPTIONS = ["implementer", "reviewer", "coordinator"] as const;
export const ROLE_LABELS: Record<(typeof ROLE_OPTIONS)[number], string> = { implementer: "Implementer", reviewer: "Reviewer", coordinator: "Coordinator" };
export function rubricMean(r: ModelRow["rubric"]): number | null {
  return r ? (r.correctness + r.cleanliness + r.extensibility + r.docs) / 4 : null;
}
