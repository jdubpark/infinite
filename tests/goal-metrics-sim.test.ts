import test from "node:test";
import assert from "node:assert/strict";
import { recordObservations, reviewedObservationsOf, type CheckObservation, type ObservationHolder } from "../packages/host/src/check-observations.js";
import { goalMetricsRead, GOAL_METRICS, pruneMetrics, settleMetrics, type GoalMetrics, type GoalMetricsView } from "../packages/host/src/goal-metrics.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { TeamCheck } from "../packages/host/src/team-types.js";
import type { Counts } from "./outcome-sim-script.js";
import { simulate, type Variant, Violation } from "./fixtures/goal-metrics-sim.js";

/*
 * Runs the reported-numbers simulator (tests/fixtures/goal-metrics-sim.ts, which states the invariants I1-I5) over the
 * default corpus, and checks that each mutant below is caught through the invariant it names while the same corpus
 * passes without it.
 */

// GOAL_METRICS_SIM_SEED=N runs that seed alone and skips the mutants; GOAL_METRICS_SIM_SEEDS=N runs N seeds from
// GOAL_METRICS_SIM_BASE (default 1). Floors describe the default corpus only.
const DEFAULT_SEEDS = 200;
const ONLY = process.env.GOAL_METRICS_SIM_SEED;
const COUNT = Number(process.env.GOAL_METRICS_SIM_SEEDS ?? DEFAULT_SEEDS);
const BASE_SEED = Number(process.env.GOAL_METRICS_SIM_BASE ?? 1);
const SEEDS = ONLY === undefined ? Array.from({ length: COUNT }, (_, index) => BASE_SEED + index) : [Number(ONLY)];
assert.ok(SEEDS.length > 0 && SEEDS.every(Number.isSafeInteger), "GOAL_METRICS_SIM_SEED, GOAL_METRICS_SIM_SEEDS and GOAL_METRICS_SIM_BASE take integers");
const DEFAULT_CORPUS = ONLY === undefined && COUNT === DEFAULT_SEEDS && BASE_SEED === 1;

const sortedCounts = (counts: Counts) => Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1));

function sweep(seeds: readonly number[], counts: Counts, variant: Variant = {}): Violation | undefined {
  for (const seed of seeds) {
    try { simulate(seed, counts, variant); }
    catch (error) {
      if (error instanceof Violation) return error;
      throw error;
    }
  }
  return undefined;
}

/**
 * Floors for the default corpus at about half of what it produced, so a generator that stops producing a case fails.
 * They follow the cases the design lists: a host stop inside a check, between the run's write and the goal's write,
 * and after a goal write; a repeated settlement; a later revision with fewer values; a fold at a launch and in the same
 * write as a settlement; retention of orphans and past 50 entries; duplicate commands, a failed first occurrence, and
 * a setup row of a checked command; reviews that approve, ask for changes, approve an earlier revision or are missing;
 * a head that moved after its checks; and reads past 8 series, with a tie at the 8th, an unconfigured command and a
 * long label. The thinnest ran 41 to 137 times: retention past 50 entries, a failed first occurrence and an approval
 * of an earlier revision. A load that pruned never ran, since every write prunes first;
 * tests/goal-metrics-service.test.ts seeds a file that needs it.
 */
const FLOORS: Readonly<Record<string, number>> = {
  "seed:long": 11, "seed:fold": 64, "fold:at-launch": 164, "fold:with-settlement": 85, "prune:orphan": 61, "prune:cap": 20,
  "stop:in-check": 524, "stop:between-run-and-goal": 363, "stop:after-goal-write": 88, "restart": 1076,
  "settle:repeated": 465, "settle:values": 1458, "settle:unreviewed": 1635, "settle:no-values": 80, "settle:removed": 188,
  "revision:fewer-values": 142, "entry:over-16": 80,
  "observe:duplicate-command": 709, "observe:first-failed": 49, "observe:setup-same-command": 710, "observe:ambiguous": 3954,
  "observe:invalid": 4443, "observe:whole-invalid": 374, "observe:unslotted": 761, "observe:interrupted-by-stop": 524,
  "review:approved": 1807, "review:changes": 171, "review:older-revision": 68, "review:none": 297,
  "head:moved": 194, "head:repeated": 459, "round:same": 480, "round:reset": 308, "config:changed": 159,
  "read:over-8-series": 1181, "read:boundary-tie": 897, "read:unconfigured": 106, "read:long-label": 553,
};

test("reported numbers keep their invariants across host stops, folds, reopened runs and duplicate commands", t => {
  const counts: Counts = {};
  const started = performance.now();
  const violation = sweep(SEEDS, counts);
  if (violation) throw violation;
  t.diagnostic(`goal-metrics sim: ${SEEDS.length} seeds from ${SEEDS[0]} in ${((performance.now() - started) / 1000).toFixed(1)} s, ${JSON.stringify(Object.fromEntries(sortedCounts(counts)))}`);
  if (!DEFAULT_CORPUS) return t.diagnostic("coverage floors are off: they describe the default corpus, and a GOAL_METRICS_SIM_* setting changed it");
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok((counts[name] ?? 0) >= floor, `${name} ran ${counts[name] ?? 0} times, under its floor of ${floor}: the generator stopped producing it`);
  }
});

// ---- Mutations ---------------------------------------------------------------------------------------------------

type Limits = { -readonly [K in keyof typeof GOAL_METRICS]: number };
/** Runs `run` with one of the module's limits changed, and puts it back. */
function withLimit<T>(key: keyof Limits, value: number, run: () => T): T {
  const limits = GOAL_METRICS as Limits, was = limits[key];
  limits[key] = value;
  try { return run(); } finally { limits[key] = was; }
}

/** The first-occurrence rule turned around: a later passed occurrence of a command replaces what an earlier one kept. */
function lastOccurrence(holder: ObservationHolder, check: TeamCheck, scan: Parameters<typeof recordObservations>[2]) {
  const command = commandDigest(check.command), round = check.round ?? 0;
  const sameTriple = (revision: number, itemRound: number, head: string | undefined) => revision === check.revision && itemRound === round && head === check.headCommit;
  if (check.status === "passed" && check.phase === undefined) {
    const left = observationsOf(holder)?.filter(item => !(item.command === command && sameTriple(item.revision, item.round, item.head)));
    if (left?.length) holder.checkObservations = left;
    else delete holder.checkObservations;
  }
  const view: ObservationHolder = { ...holder, run: { ...holder.run, checks: holder.run.checks.filter(row => row === check ||
    !(row.phase === undefined && commandDigest(row.command) === command && sameTriple(row.revision, row.round ?? 0, row.headCommit))) } };
  recordObservations(view, check, scan);
  if (view.checkObservations) holder.checkObservations = view.checkObservations;
  else delete holder.checkObservations;
}

/** The read with ties on the newest time ranked by the larger identity digest: every series ranked, tie groups reversed, then cut. */
function reversedTies(...args: Parameters<typeof goalMetricsRead>): GoalMetricsView {
  const all = withLimit("series", Number.MAX_SAFE_INTEGER, () => goalMetricsRead(...args));
  const newest = (series: GoalMetricsView["series"][number]) => series.points.reduce((max, point) => (point.at > max ? point.at : max), "");
  const ranked: GoalMetricsView["series"] = [];
  for (let start = 0; start < all.series.length;) {
    let end = start;
    while (end < all.series.length && newest(all.series[end]!) === newest(all.series[start]!)) end++;
    ranked.push(...all.series.slice(start, end).reverse());
    start = end;
  }
  const shown = ranked.slice(0, GOAL_METRICS.series);
  return { ...all, series: shown, omittedSeries: ranked.length - shown.length };
}

/** The mutants run only on what this version writes, so they read the stored fields as its shapes. */
const metricsOf = (holder: { metrics?: unknown }) => holder.metrics as GoalMetrics | undefined;
const observationsOf = (holder: ObservationHolder) => holder.checkObservations as CheckObservation[] | undefined;

type Mutation = { name: string; invariant: string; variant: Variant };

const MUTATIONS: readonly Mutation[] = [
  { name: "retention puts back the entries of cycles the goal no longer holds", invariant: "I1",
    variant: { prune: holder => {
      const before = metricsOf(holder)?.entries ?? [];
      pruneMetrics(holder);
      const held = new Set(holder.goal.cycles.map(cycle => cycle.teamId)), orphans = before.filter(entry => !held.has(entry.run));
      if (orphans.length) holder.metrics = { entries: [...metricsOf(holder)?.entries ?? [], ...orphans], dropped: metricsOf(holder)?.dropped ?? 0 };
    } } },
  { name: "a settlement merges the earlier entry's values into the new one", invariant: "I2",
    variant: { settle: (holder, run, observations) => {
      const before = metricsOf(holder)?.entries.find(entry => entry.run === run);
      settleMetrics(holder, run, observations);
      const after = metricsOf(holder)?.entries.find(entry => entry.run === run);
      if (before && after) for (const value of before.values) {
        if (!after.values.some(item => item.command === value.command && item.name === value.name)) after.values.push(value);
      }
    } } },
  { name: "a later occurrence of a command at the same (revision, round, head) replaces the first one's numbers", invariant: "I2",
    variant: { record: lastOccurrence } },
  { name: "the goal's read takes the kept numbers of any round of the revision, not only its final round", invariant: "I2",
    variant: { reviewed: holder => {
      const answer = reviewedObservationsOf(holder);
      return answer && holder ? (observationsOf(holder) ?? []).filter(item => item.revision === holder.run.revision && item.head === holder.run.headCommit) : answer;
    } } },
  { name: "retention keeps 51 entries", invariant: "I3",
    variant: { prune: holder => withLimit("entries", 51, () => pruneMetrics(holder)) } },
  { name: "a settlement that removes an entry counts it as dropped", invariant: "I4",
    variant: { settle: (holder, run, observations) => {
      const had = metricsOf(holder)?.entries.some(entry => entry.run === run);
      settleMetrics(holder, run, observations);
      if (had && !metricsOf(holder)?.entries.some(entry => entry.run === run)) holder.metrics = { entries: metricsOf(holder)?.entries ?? [], dropped: (metricsOf(holder)?.dropped ?? 0) + 1 };
    } } },
  { name: "series that share their newest time rank by the larger identity digest", invariant: "I5",
    variant: { read: reversedTies } },
];

for (const mutation of MUTATIONS) {
  test(`the simulator catches a mutant: ${mutation.name} (${mutation.invariant})`, { skip: ONLY !== undefined && "GOAL_METRICS_SIM_SEED reruns one corpus seed" }, t => {
    const violation = sweep(SEEDS, {}, mutation.variant);
    assert.ok(violation, `none of ${SEEDS.length} seeds caught it`);
    assert.match(violation.message, new RegExp(`: ${mutation.invariant}: `), `caught by another invariant first: ${violation.message}`);
    t.diagnostic(`caught at ${violation.message.split("; rerun")[0]}`);
  });
}
