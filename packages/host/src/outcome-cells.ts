import type { OutcomeRow } from "./outcome-store.js";
import { exclusionOf, type Exclusion, type Level, type Levels } from "./outcome-rules.js";

/** Pure outcome cells. No I/O, no clock, no module state, no store import beyond types. */

export type Source = "production" | "duel" | "replay" | "legacy";
export const SOURCES: readonly Source[] = ["production", "duel", "replay", "legacy"];
export type CellUse = "display" | "decision";
export type CellDimension = "project" | "profile" | "area" | "kind" | "risk";
export type CellQuery = {
  use: CellUse;
  sources: Source[];
  by: CellDimension[];
  role: "implementer" | "scout";
  projectId?: string;
  days?: number;
};
export type LevelCount = { yes: number; no: number; unknown: number; rate: number | null; interval: [number, number] | null };
export type Spread = { n: number; median: number; iqr: [number, number] };
export type ExclusionCounts = { limit: number; owner: number; host: number; duel: number };
export type Cell = {
  key: Record<string, string>; sources: Source[]; from: string | null; to: string | null;
  attempts: number; open: number; excluded: ExclusionCounts;
  withheld: { backfilled: number; gap: number; unfrozen: number };
  flagged: { backfilled: number; gap: number; "empty-result": number; "same-model-review": number };
  levels: { integrated: LevelCount; accepted: LevelCount; firstPass: LevelCount; held: LevelCount };
  completed?: LevelCount;                          // role "scout" only
  tokens: Spread | null; spentUsd: Spread | null; listUsd: Spread | null; minutes: Spread | null;
  ownerRating: { mean: number; n: number } | null; enough: boolean;
};
export type SessionCost = { usd: number; tokens: number; complete: boolean };
export type CostLookup = (sessionId: string) => SessionCost | undefined;
export type RowUse = { kind: "open" } | { kind: "excluded"; exclusion: Exclusion }
  | { kind: "withheld"; reason: "backfilled" | "gap" | "unfrozen" } | { kind: "counted"; levels: Levels; completed: boolean };
export type CellRefusal = "no-sources" | "legacy-in-decision" | "decision-without-profile";
export class CellQueryRefused extends Error {
  constructor(readonly code: CellRefusal) {
    super(code);
    this.name = "CellQueryRefused";
  }
}
export const MIN_COUNTED_ROWS = 10;

export function checkCellQuery(query: CellQuery): void {
  if (query.sources.length === 0) throw new CellQueryRefused("no-sources");
  if (query.use === "decision" && query.sources.includes("legacy")) throw new CellQueryRefused("legacy-in-decision");
  if (query.use === "decision" && !query.by.includes("profile")) throw new CellQueryRefused("decision-without-profile");
}

/** The first matching rule decides the bucket of a row. */
export function rowUse(row: OutcomeRow, use: CellUse): RowUse {
  const decision = use === "decision";
  if (decision && row.flags.includes("backfilled")) return { kind: "withheld", reason: "backfilled" };
  if (decision && row.flags.includes("gap")) return { kind: "withheld", reason: "gap" };
  if (row.disposition === "open") return { kind: "open" };
  const exclusion = exclusionOf(row.disposition);
  if (exclusion !== undefined) return { kind: "excluded", exclusion };
  if (decision && row.disposition === "integrated" && row.frozenAt === null) return { kind: "withheld", reason: "unfrozen" };
  const stored: Levels = { integrated: row.integrated, accepted: row.accepted, firstPass: row.firstPass, held: row.held };
  const levels: Levels = decision && row.flags.includes("same-model-review")
    ? { integrated: row.integrated, accepted: null, firstPass: null, held: null }
    : stored;
  return { kind: "counted", levels, completed: row.disposition === "completed" };
}

/** Wilson score interval at 95%. Moved unchanged from scorecard.ts. */
export function wilsonInterval(successes: number, attempts: number): [number, number] | null {
  if (!attempts) return null;
  const z = 1.959963984540054, p = successes / attempts, z2 = z * z, denominator = 1 + z2 / attempts;
  const center = (p + z2 / (2 * attempts)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** Linear interpolation between closest ranks at position (n - 1) * p of the sorted values. */
function quantile(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (position - low) * (sorted[high]! - sorted[low]!);
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return quantile(sortedNumbers(values), 0.5);
}

export function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = sortedNumbers(values);
  return { n: sorted.length, median: quantile(sorted, 0.5), iqr: [quantile(sorted, 0.25), quantile(sorted, 0.75)] };
}

export function levelCount(values: readonly Level[]): LevelCount {
  const yes = values.filter(value => value === 1).length;
  const no = values.filter(value => value === 0).length;
  const unknown = values.filter(value => value === null).length;
  const decided = yes + no;
  return { yes, no, unknown, rate: decided === 0 ? null : yes / decided, interval: wilsonInterval(yes, decided) };
}

/** Today's rule (umbrella C5): only the metered provider reports a spend. */
export function isMetered(provider: string): boolean {
  return provider === "opencode";
}

/** A cost counts only when the lookup gives a complete session. A missing fact is never zero. */
export function completeCost(row: OutcomeRow, cost: CostLookup | undefined): SessionCost | undefined {
  if (cost === undefined || !row.sessionId) return undefined;
  const found = cost(row.sessionId);
  return found?.complete ? found : undefined;
}

export function rowMinutes(row: OutcomeRow): number | undefined {
  if (!row.startedAt || !row.endedAt) return undefined;
  const milliseconds = Date.parse(row.endedAt) - Date.parse(row.startedAt);
  if (!Number.isFinite(milliseconds)) return undefined;
  return Math.max(0, milliseconds / 60_000);
}

export function rowTime(row: OutcomeRow): string | null {
  return row.endedAt ?? row.startedAt;
}

/** Key entries in a fixed order. A dimension adds its entries; a replay or legacy row adds its source. */
export function cellKey(row: OutcomeRow, by: readonly CellDimension[]): Record<string, string> {
  const dimensions = new Set(by);
  const key: Record<string, string> = {};
  if (dimensions.has("project")) key.project = row.payload.projectId;
  if (dimensions.has("profile")) {
    key.profile = row.profileId;
    key.provider = row.provider;
    key.model = row.model;
    // A missing effort adds no entry: OpenCode allows the variant `none`, which is another identity.
    if (row.effort !== null) key.effort = row.effort;
    key.epoch = String(row.profileEpoch);
  }
  if (dimensions.has("area")) {
    key.area = row.payload.area;
    key.featureMap = row.payload.featureMap;
  }
  if (dimensions.has("kind")) key.kind = row.kind ?? "none";
  if (dimensions.has("risk")) key.risk = row.risk;
  if (dimensions.has("area") || dimensions.has("kind") || dimensions.has("risk")) key.featureVersion = String(row.featureVersion);
  if (row.source === "replay" || row.source === "legacy") key.source = row.source;
  return key;
}

type CountedRow = { row: OutcomeRow; levels: Levels; completed: boolean };

function summarize(key: Record<string, string>, rows: readonly OutcomeRow[], query: CellQuery, cost: CostLookup | undefined): Cell {
  const counted: CountedRow[] = [];
  let open = 0;
  const excluded: ExclusionCounts = { limit: 0, owner: 0, host: 0, duel: 0 };
  const withheld = { backfilled: 0, gap: 0, unfrozen: 0 };
  const flagged = { backfilled: 0, gap: 0, "empty-result": 0, "same-model-review": 0 };
  for (const row of rows) {
    const use = rowUse(row, query.use);
    if (use.kind === "open") open++;
    else if (use.kind === "excluded") excluded[use.exclusion]++;
    else if (use.kind === "withheld") withheld[use.reason]++;
    else {
      counted.push({ row, levels: use.levels, completed: use.completed });
      // A row can carry a flag this code does not know. It is ignored, and never makes a count NaN.
      for (const flag of row.flags) if (Object.hasOwn(flagged, flag)) flagged[flag]++;
    }
  }

  const scout = query.role === "scout";
  const levelOf = (pick: (levels: Levels) => Level): LevelCount =>
    scout ? levelCount([]) : levelCount(counted.map(item => pick(item.levels)));

  const tokens: number[] = [], usd: number[] = [], minutes: number[] = [];
  for (const { row } of counted) {
    const found = completeCost(row, cost);
    if (found !== undefined) {
      tokens.push(found.tokens);
      if (isMetered(row.provider)) usd.push(found.usd);
    }
    const rowMinute = rowMinutes(row);
    if (rowMinute !== undefined) minutes.push(rowMinute);
  }

  const ratings = counted.flatMap(({ row }) => (row.payload.ownerRating ? [row.payload.ownerRating.score] : []));
  const times = rows.map(rowTime).filter((time): time is string => time !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  const sources = [...new Set(rows.map(row => row.source as Source))].sort();

  const cell: Cell = {
    key,
    sources,
    from: times[0] ?? null,
    to: times.at(-1) ?? null,
    attempts: counted.length,
    open,
    excluded,
    withheld,
    flagged,
    levels: {
      integrated: levelOf(levels => levels.integrated),
      accepted: levelOf(levels => levels.accepted),
      firstPass: levelOf(levels => levels.firstPass),
      held: levelOf(levels => levels.held),
    },
    tokens: spread(tokens),
    spentUsd: spread(usd),
    listUsd: null,
    minutes: spread(minutes),
    ownerRating: ratings.length ? { mean: ratings.reduce((sum, value) => sum + value, 0) / ratings.length, n: ratings.length } : null,
    enough: counted.length >= MIN_COUNTED_ROWS,
  };
  if (scout) cell.completed = levelCount(counted.map(item => (item.completed ? 1 : 0)));
  return cell;
}

function compareKeyValue(left: string, right: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(left) && numeric.test(right)) return Number(left) - Number(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Cells sort by their key entries, in key order. */
function compareCells(left: Cell, right: Cell): number {
  const leftEntries = Object.entries(left.key), rightEntries = Object.entries(right.key);
  for (let index = 0; index < Math.min(leftEntries.length, rightEntries.length); index++) {
    const [leftName, leftValue] = leftEntries[index]!, [rightName, rightValue] = rightEntries[index]!;
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    const order = compareKeyValue(leftValue, rightValue);
    if (order !== 0) return order;
  }
  return leftEntries.length - rightEntries.length;
}

/** Calls checkCellQuery. Ignores `projectId` and `days`, which the reader applies. */
export function buildCells(rows: readonly OutcomeRow[], query: CellQuery, cost?: CostLookup): Cell[] {
  checkCellQuery(query);
  const by = [...new Set(query.by)];
  const groups = new Map<string, { key: Record<string, string>; rows: OutcomeRow[] }>();
  for (const row of rows) {
    if (row.role !== query.role || !query.sources.includes(row.source as Source)) continue;
    const key = cellKey(row, by);
    const id = JSON.stringify(Object.entries(key));
    const group = groups.get(id) ?? { key, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()].map(group => summarize(group.key, group.rows, query, cost)).sort(compareCells);
}
