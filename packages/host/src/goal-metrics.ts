import { createHash } from "node:crypto";
import type { CheckObservation } from "./check-observations.js";
import { canonicalJson } from "./evidence/crypto.js";
import type { GoalCycle } from "./goal-types.js";
import { commandDigest } from "./objective-input.js";
import type { TeamCommand } from "./team-types.js";

/** Values kept per cycle, entries kept per goal, series per read, and characters of a configured command's label. */
export const GOAL_METRICS = { values: 16, entries: 50, series: 8, label: 200 } as const;

export type CycleValue = { command: string; name: string; value: number; at: string };
/** What one cycle's run measured at its reviewed head. A function of the run's reviewed observations alone. */
export type CycleMetrics = { run: string; revision: number; head: string; values: CycleValue[]; more: number };
/**
 * The entries beside the goal in its stored holder, never inside `goal` or a cycle: every goal read selects `goal`, so
 * no goal view, Understanding record, relay read or member context carries them. `dropped` counts the entries
 * retention removed; an entry that a settlement removed is not counted.
 */
export type GoalMetrics = { entries: CycleMetrics[]; dropped: number };
export type MetricPoint = { cycle: number; run: string; revision: number; head: string; value: number; at: string };
export type MetricSeries = { command: string; label?: string; name: string; configured: boolean; points: MetricPoint[] };
export type GoalMetricsView = { series: MetricSeries[]; omittedSeries: number; omittedValues: number; dropped: number };
type Cycles = readonly Pick<GoalCycle, "teamId">[];
/** `metrics` is `unknown`: a later release may have stored another shape before a rollback to this one (`isGoalMetrics`). */
type MetricsHolder = { goal: { cycles: Cycles }; metrics?: unknown };

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const identity = (command: string, name: string) => createHash("sha256").update(canonicalJson({ command, name })).digest("hex");
/** Nothing to keep is no field at all, so a goal without numbers keeps its stored shape. */
const kept = (state: GoalMetrics): GoalMetrics | undefined => state.entries.length || state.dropped ? state : undefined;
function assign(holder: MetricsHolder, next: GoalMetrics | undefined) {
  if (next) holder.metrics = next;
  else delete holder.metrics;
}

const record = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isValue = (value: unknown) => record(value, ["command", "name", "value", "at"]) && typeof value.command === "string"
  && typeof value.name === "string" && typeof value.value === "number" && Number.isFinite(value.value) && typeof value.at === "string";
const isEntry = (value: unknown) => record(value, ["run", "revision", "head", "values", "more"]) && typeof value.run === "string"
  && Number.isSafeInteger(value.revision) && typeof value.head === "string" && count(value.more) && Array.isArray(value.values) && value.values.every(isValue);

/**
 * Whether a stored `metrics` value has exactly the shape this version writes. Anything else, such as a later release's
 * shape kept across a rollback, is left as stored: retention does not prune it, a settlement does not replace it, and
 * the read answers the empty curve. Overwriting it would destroy that release's history.
 */
export function isGoalMetrics(value: unknown): value is GoalMetrics {
  return record(value, ["entries", "dropped"]) && count(value.dropped) && Array.isArray(value.entries) && value.entries.every(isEntry);
}

/** The entry of one run: its observations with a value, in byte order of command digest then name; the first 16 kept, the rest counted. */
export function cycleEntry(run: string, observations: readonly CheckObservation[] | undefined): CycleMetrics | undefined {
  const values = (observations ?? []).filter(item => item.state === "value" && typeof item.value === "number")
    .sort((a, b) => byteOrder(a.command, b.command) || byteOrder(a.name, b.name));
  const first = values[0];
  if (first === undefined) return undefined;
  return { run, revision: first.revision, head: first.head, more: Math.max(0, values.length - GOAL_METRICS.values),
    values: values.slice(0, GOAL_METRICS.values).map(item => ({ command: item.command, name: item.name, value: item.value!, at: item.at })) };
}

/** Replaces a cycle's entry as a whole. No reviewed head or no value removes it, uncounted. Nothing of an earlier settlement survives. */
export function settleCycleMetrics(state: GoalMetrics | undefined, run: string, observations: readonly CheckObservation[] | undefined): GoalMetrics | undefined {
  const entry = cycleEntry(run, observations);
  const others = (state?.entries ?? []).filter(item => item.run !== run);
  return kept({ entries: entry ? [...others, entry] : others, dropped: state?.dropped ?? 0 });
}

/**
 * Retention, before every save of the goal's holder: an entry whose cycle the goal no longer holds goes, and of the rest
 * only the newest 50 in the order of the goal's cycles stay. Each entry removed here counts once in `dropped`.
 */
export function pruneGoalMetrics(state: GoalMetrics | undefined, cycles: Cycles): GoalMetrics | undefined {
  if (!state) return undefined;
  const order = new Map(cycles.map((cycle, index) => [cycle.teamId, index]));
  const held = state.entries.filter(item => order.has(item.run)).sort((a, b) => order.get(a.run)! - order.get(b.run)!);
  const entries = held.slice(-GOAL_METRICS.entries);
  return kept({ entries, dropped: state.dropped + state.entries.length - entries.length });
}

/** Settles a cycle's entry on the holder, unless the holder keeps a value this version does not recognise. */
export function settleMetrics(holder: MetricsHolder, run: string, observations: readonly CheckObservation[] | undefined) {
  if (holder.metrics !== undefined && !isGoalMetrics(holder.metrics)) return;
  assign(holder, settleCycleMetrics(holder.metrics, run, observations));
}
/** Retention on the holder, unless the holder keeps a value this version does not recognise. */
export function pruneMetrics(holder: MetricsHolder) {
  if (isGoalMetrics(holder.metrics)) assign(holder, pruneGoalMetrics(holder.metrics, holder.goal.cycles));
}

/** The command and its arguments, cut at 200 code points so no character is split. */
function label(command: TeamCommand) {
  const characters = [...[command.command, ...command.args].join(" ")];
  return characters.length <= GOAL_METRICS.label ? characters.join("") : `${characters.slice(0, GOAL_METRICS.label - 1).join("")}…`;
}

/**
 * The owner's curve, derived on each read from the entries and the configuration; nothing about a series is stored. A
 * series is every value of one (command digest, name), as points in the order of the goal's cycles; a cycle without an
 * entry is a gap. At most 8 series: those whose newest point is newest by `at`, then the smaller identity digest.
 * `configured` and `label` come from the project's checks now; a removed command's series has neither. A stored value
 * this version does not recognise reads as the empty curve.
 */
export function goalMetricsRead(stored: unknown, cycles: readonly Pick<GoalCycle, "teamId" | "cycle">[], configured: readonly TeamCommand[]): GoalMetricsView {
  const state = isGoalMetrics(stored) ? stored : undefined;
  const position = new Map(cycles.map((cycle, index) => [cycle.teamId, index]));
  const entries = (state?.entries ?? []).filter(item => position.has(item.run)).sort((a, b) => position.get(a.run)! - position.get(b.run)!);
  const labels = new Map<string, string>();
  for (const command of configured) { const digest = commandDigest(command); if (!labels.has(digest)) labels.set(digest, label(command)); }
  const series = new Map<string, { id: string; command: string; name: string; newest: string; points: MetricPoint[] }>();
  for (const entry of entries) {
    const cycle = cycles[position.get(entry.run)!]!.cycle;
    for (const value of entry.values) {
      const id = identity(value.command, value.name);
      const found = series.get(id) ?? { id, command: value.command, name: value.name, newest: value.at, points: [] };
      if (value.at > found.newest) found.newest = value.at;
      found.points.push({ cycle, run: entry.run, revision: entry.revision, head: entry.head, value: value.value, at: value.at });
      series.set(id, found);
    }
  }
  // `at` is an ISO 8601 UTC time from toISOString, so its string order is its time order.
  const ranked = [...series.values()].sort((a, b) => (a.newest === b.newest ? byteOrder(a.id, b.id) : a.newest > b.newest ? -1 : 1));
  const shown = ranked.slice(0, GOAL_METRICS.series).map(({ command, name, points }): MetricSeries => {
    const text = labels.get(command);
    return { command, ...(text === undefined ? {} : { label: text }), name, configured: text !== undefined, points };
  });
  return { series: shown, omittedSeries: ranked.length - shown.length, omittedValues: entries.reduce((sum, entry) => sum + entry.more, 0), dropped: state?.dropped ?? 0 };
}
