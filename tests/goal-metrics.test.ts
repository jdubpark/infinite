import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CheckObservation } from "../packages/host/src/check-observations.js";
import { cycleEntry, goalMetricsRead, GOAL_METRICS, pruneGoalMetrics, pruneMetrics, settleCycleMetrics, settleMetrics, type CycleMetrics, type GoalMetrics } from "../packages/host/src/goal-metrics.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const HEAD = "c".repeat(40);
const lint: TeamCommand = { command: "npm", args: ["run", "lint"] };
const unit: TeamCommand = { command: "npm", args: ["test"] };
const at = (second: number) => new Date(Date.UTC(2026, 10, 23, 8, 0, second)).toISOString();
function observation(command: TeamCommand | string, name: string, value: number | undefined, fields: Partial<CheckObservation> = {}): CheckObservation {
  return { command: typeof command === "string" ? command : commandDigest(command), name, revision: 1, round: 0, head: HEAD, at: at(0),
    state: value === undefined ? "invalid" : "value", ...(value === undefined ? {} : { value }), ...fields };
}
const cycles = (...runs: string[]) => runs.map((teamId, index) => ({ teamId, cycle: index + 1 }));
const entry = (run: string, values: [command: TeamCommand, name: string, value: number, second: number][], more = 0): CycleMetrics => ({
  run, revision: 1, head: HEAD, more, values: values.map(([command, name, value, second]) => ({ command: commandDigest(command), name, value, at: at(second) })),
});
const identity = (command: string, name: string) => createHash("sha256").update(JSON.stringify({ command, name })).digest("hex");

test("an entry keeps the values in byte order of command digest then name, 16 of them, and counts the rest", () => {
  const [low, high] = [commandDigest(lint), commandDigest(unit)].sort();
  const names = ["a_b", "a0", "a.b", "a-b"];
  const made = cycleEntry("run-1", [...names.map(name => observation(high!, name, 1)), ...names.map(name => observation(low!, name, 2)),
    observation(low!, "flaky", undefined, { state: "ambiguous" }), observation(low!, "broken", undefined)]);
  assert.deepEqual(made?.values.map(value => [value.command === low ? "low" : "high", value.name]),
    ["low", "high"].flatMap(command => ["a-b", "a.b", "a0", "a_b"].map(name => [command, name])), "byte order, not locale order");
  assert.equal(made?.more, 0, "an ambiguous or invalid number is not a value and is not counted");
  assert.deepEqual([made?.run, made?.revision, made?.head], ["run-1", 1, HEAD]);

  const many = cycleEntry("run-2", Array.from({ length: 21 }, (_, index) => observation(lint, `n${String(index).padStart(2, "0")}`, index)));
  assert.equal(many?.values.length, GOAL_METRICS.values);
  assert.deepEqual(many?.values.map(value => value.value), Array.from({ length: 16 }, (_, index) => index));
  assert.equal(many?.more, 5);

  assert.equal(cycleEntry("run-3", []), undefined);
  assert.equal(cycleEntry("run-3", undefined), undefined);
  assert.equal(cycleEntry("run-3", [observation(lint, "flaky", undefined, { state: "ambiguous" })]), undefined);
});

test("a settlement replaces the run's entry whole; no reviewed head or no value removes it uncounted", () => {
  let state = settleCycleMetrics(undefined, "run-1", [observation(lint, "speed", 1), observation(lint, "size", 2)]);
  state = settleCycleMetrics(state, "run-2", [observation(lint, "speed", 3)]);
  state = settleCycleMetrics(state, "run-1", [observation(lint, "speed", 4, { revision: 2 })]);
  assert.deepEqual(state?.entries.map(item => [item.run, item.revision, item.values.map(value => [value.name, value.value])]),
    [["run-2", 1, [["speed", 3]]], ["run-1", 2, [["speed", 4]]]], "the later revision's fewer values replace the earlier entry");

  state = settleCycleMetrics(state, "run-1", undefined);
  assert.deepEqual(state?.entries.map(item => item.run), ["run-2"]);
  assert.equal(state?.dropped, 0, "a settlement's removal is not counted");
  assert.equal(settleCycleMetrics(state, "run-2", []), undefined, "nothing to keep and nothing dropped is no field");
  assert.deepEqual(settleCycleMetrics({ entries: [], dropped: 2 }, "run-9", []), { entries: [], dropped: 2 }, "the dropped count stays");
});

test("retention removes entries of cycles the goal no longer holds and keeps the newest 50 in cycle order, counting each", () => {
  assert.equal(pruneGoalMetrics(undefined, cycles("run-1")), undefined);
  const held = Array.from({ length: 55 }, (_, index) => `run-${index}`);
  const state: GoalMetrics = { dropped: 3, entries: [...held].reverse().map(run => entry(run, [[lint, "speed", 1, 0]])) };
  state.entries.push(entry("folded-1", [[lint, "speed", 1, 0]]), entry("folded-2", [[lint, "speed", 1, 0]]));
  const pruned = pruneGoalMetrics(state, cycles(...held));
  assert.deepEqual(pruned?.entries.map(item => item.run), held.slice(5), "the newest 50 by cycle position, in cycle order");
  assert.equal(pruned?.dropped, 3 + 5 + 2);
  assert.equal(state.entries.length, 57, "the input is not changed");
  assert.deepEqual(pruneGoalMetrics(pruned, cycles(...held)), pruned, "a second pass removes nothing");
  assert.equal(pruneGoalMetrics({ entries: [entry("folded", [[lint, "speed", 1, 0]])], dropped: 0 }, cycles("run-1"))?.dropped, 1);
  assert.equal(pruneGoalMetrics({ entries: [], dropped: 0 }, cycles("run-1")), undefined);
});

test("the read derives one series per (command, name), in cycle order, with gaps, configured state and label", () => {
  const state: GoalMetrics = { dropped: 4, entries: [
    entry("run-3", [[lint, "speed", 30, 30], [unit, "size", 7, 31]], 2),
    entry("run-1", [[lint, "speed", 10, 10]]),
    entry("gone", [[lint, "speed", 99, 99]]),
  ] };
  const read = goalMetricsRead(state, cycles("run-1", "run-2", "run-3"), [lint]);
  assert.deepEqual(read, {
    series: [
      { command: commandDigest(unit), name: "size", configured: false, points: [{ cycle: 3, run: "run-3", revision: 1, head: HEAD, value: 7, at: at(31) }] },
      { command: commandDigest(lint), label: "npm run lint", name: "speed", configured: true, points: [
        { cycle: 1, run: "run-1", revision: 1, head: HEAD, value: 10, at: at(10) },
        { cycle: 3, run: "run-3", revision: 1, head: HEAD, value: 30, at: at(30) },
      ] },
    ],
    omittedSeries: 0, omittedValues: 2, dropped: 4,
  });
  assert.equal("label" in read.series[0]!, false, "an unconfigured series has no label key");
  assert.equal(JSON.stringify(read).includes("npm test"), false, "an unconfigured command's text is nowhere in the read");
  assert.deepEqual(goalMetricsRead(undefined, cycles("run-1"), [lint]), { series: [], omittedSeries: 0, omittedValues: 0, dropped: 0 });
});

test("the read shows 8 series, newest first, ties by the smaller identity digest, and caps a long label", () => {
  const names = Array.from({ length: 10 }, (_, index) => `m${index}`);
  const state: GoalMetrics = { dropped: 0, entries: [entry("run-1", [...names.map((name): [TeamCommand, string, number, number] => [lint, name, 1, 5]), [unit, "late", 1, 6]])] };
  const read = goalMetricsRead(state, cycles("run-1"), []);
  const digest = commandDigest(lint);
  const tied = names.map(name => ({ name, id: identity(digest, name) })).sort((a, b) => (a.id < b.id ? -1 : 1)).map(item => item.name);
  assert.deepEqual(read.series.map(item => item.name), ["late", ...tied.slice(0, 7)]);
  assert.equal(read.omittedSeries, 3);

  const long: TeamCommand = { command: "node", args: ["x".repeat(300)] };
  const labelled = goalMetricsRead({ dropped: 0, entries: [{ run: "run-1", revision: 1, head: HEAD, more: 0, values: [{ command: commandDigest(long), name: "speed", value: 1, at: at(0) }] }] },
    cycles("run-1"), [long, { command: "node", args: ["x".repeat(300)] }]);
  assert.equal(labelled.series[0]?.label?.length, GOAL_METRICS.label);
  assert.equal(labelled.series[0]?.label, `node ${"x".repeat(194)}…`);
});

test("a label is cut at 200 code points, so no character is split", () => {
  const read = (command: TeamCommand) => goalMetricsRead({ dropped: 0, entries: [{ run: "run-1", revision: 1, head: HEAD, more: 0,
    values: [{ command: commandDigest(command), name: "speed", value: 1, at: at(0) }] }] }, cycles("run-1"), [command]).series[0]!.label!;
  const cut = read({ command: "node", args: [`${"x".repeat(193)}\u{1F600}yyy`] });
  assert.equal(cut, `node ${"x".repeat(193)}\u{1F600}…`);
  assert.doesNotThrow(() => encodeURIComponent(cut), "a half character would make this throw");
  assert.equal([...cut].length, GOAL_METRICS.label);
  const whole = read({ command: "node", args: ["\u{1F600}".repeat(195)] });
  assert.equal(whole, `node ${"\u{1F600}".repeat(195)}`, "200 code points in 395 UTF-16 units stay whole");
});

const FOREIGN: readonly [string, unknown][] = [
  ["null", null], ["{}", {}], ["[null]", [null]], ["{ v: 2 }", { v: 2 }],
  ["a version key beside the entries", { entries: [], dropped: 0, v: 2 }],
  ["an entry with a key this version does not write", { dropped: 0, entries: [{ ...entry("run-1", [[lint, "speed", 1, 0]]), unit: "ms" }] }],
];

for (const [label, value] of FOREIGN) {
  test(`retention, a settlement and the read leave a stored value of another shape as it was: ${label}`, () => {
    const holder = { goal: { cycles: cycles("run-1", "run-2") }, metrics: value as unknown };
    const stored = structuredClone(value);
    pruneMetrics(holder);
    settleMetrics(holder, "run-2", [observation(lint, "speed", 4)]);
    settleMetrics(holder, "run-1", undefined);
    assert.equal(holder.metrics, value, "the stored value is not replaced");
    assert.deepEqual(holder.metrics, stored, "the stored value is not changed");
    assert.deepEqual(goalMetricsRead(value, cycles("run-1", "run-2"), [lint]), { series: [], omittedSeries: 0, omittedValues: 0, dropped: 0 });
  });
}

test("an absent field and the shape this version writes are settled and pruned as before", () => {
  const holder: { goal: { cycles: { teamId: string; cycle: number }[] }; metrics?: unknown } = { goal: { cycles: cycles("run-1", "run-2") } };
  settleMetrics(holder, "run-1", [observation(lint, "speed", 4)]);
  settleMetrics(holder, "run-2", [observation(lint, "speed", 5)]);
  assert.deepEqual((holder.metrics as GoalMetrics).entries.map(item => item.run), ["run-1", "run-2"]);
  holder.goal.cycles = cycles("run-2");
  pruneMetrics(holder);
  assert.deepEqual((holder.metrics as GoalMetrics).entries.map(item => item.run), ["run-2"]);
  assert.equal((holder.metrics as GoalMetrics).dropped, 1);
});
