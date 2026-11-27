import test from "node:test";
import assert from "node:assert/strict";
import { buildCurves, curveRuns, curveTitle, omittedText, valueText, NO_NUMBERS_NOTE } from "../apps/mobile/src/features/teams/goal-curve.ts";
import type { GoalMetricsView } from "../apps/mobile/src/api/client.ts";

const point = (cycle: number, value: number) => ({ cycle, run: `run-${cycle}`, revision: 1, head: "a".repeat(40), value, at: "2026-11-27T10:00:00.000Z" });
const series = (name: string, points: ReturnType<typeof point>[], extra: Partial<GoalMetricsView["series"][number]> = {}) => ({ command: "c1", name, configured: true, points, ...extra });
const view = (list: GoalMetricsView["series"], extra: Partial<GoalMetricsView> = {}): GoalMetricsView => ({ series: list, omittedSeries: 0, omittedValues: 0, dropped: 0, ...extra });
const cycles = [1, 2, 3, 4].map(cycle => ({ cycle }));

test("a cycle with no reported number stays a gap, never zero and never the last value carried forward", () => {
  const [curve] = buildCurves(view([series("coverage", [point(1, 10), point(3, 30)])]), cycles);
  assert.deepEqual(curve!.slots, [10, null, 30, null]);
  assert.deepEqual(curveRuns(curve!.slots).map(run => run.map(item => item.slot)), [[0], [2]]);
  assert.equal(curve!.min, 10);
});

test("the axis is the goal's cycles in order whatever order the points arrive in", () => {
  const [curve] = buildCurves(view([series("coverage", [point(3, 3), point(1, 1), point(2, 2)])]), cycles);
  assert.deepEqual(curve!.slots, [1, 2, 3, null]);
  assert.deepEqual(curveRuns(curve!.slots).map(run => run.length), [3]);
});

test("the latest value is the last reported one with its cycle, and a zero is a value", () => {
  const [curve] = buildCurves(view([series("failures", [point(1, 5), point(2, 0)])]), cycles);
  assert.deepEqual(curve!.latest, { value: 0, cycle: 2 });
});

test("a series with no point on the goal's cycles draws nothing, and no series gives the quiet line", () => {
  assert.deepEqual(buildCurves(view([series("x", [point(9, 1)])]), cycles), []);
  assert.deepEqual(buildCurves(view([]), cycles), []);
  assert.equal(NO_NUMBERS_NOTE, "No check has reported a number yet.");
});

test("a series keeps its configured flag and a truncated title", () => {
  const long = "x".repeat(80);
  const [curve] = buildCurves(view([series(long, [point(1, 1)], { configured: false, label: "npm run test" })]), cycles);
  assert.equal(curve!.configured, false);
  assert.ok([...curve!.title].length <= 49);
  assert.equal(curveTitle({ name: "coverage", label: "npm test" }), "coverage · npm test");
  assert.match(curveTitle({ name: long }), /…$/);
});

test("omitted counts are named only when non-zero", () => {
  assert.deepEqual(omittedText(view([])), []);
  assert.deepEqual(omittedText(view([], { omittedSeries: 2, omittedValues: 1, dropped: 3 })), [
    "2 more series not shown", "1 value over the per-cycle limit not shown", "3 older cycles no longer kept",
  ]);
  assert.equal(valueText(0.123456789), "0.123457");
  assert.equal(valueText(1234.5678), "1234.57");
  assert.equal(valueText(42), "42");
});
