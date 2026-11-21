import test from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapStream,
  comparisonStats,
  holm,
  signTest,
  xoshiro128ss,
  type StatInput,
  type StatTask,
  type StatTrial,
} from "../packages/host/src/eval-stats.js";
import type { PromptOrigin, TrialEnding } from "../packages/host/src/eval-types.js";

const near = (actual: number | null, expected: number, label: string): void => {
  assert.notEqual(actual, null, label);
  assert.ok(Math.abs((actual as number) - expected) < 1e-6, `${label}: ${actual} vs ${expected}`);
};
const nearInterval = (actual: [number, number] | null, expected: [number, number], label: string): void => {
  assert.ok(actual !== null, label);
  near(actual[0], expected[0], `${label} low`);
  near(actual[1], expected[1], `${label} high`);
};

function trial(configuration: number, slot: number, resolved: boolean, extra: Partial<StatTrial> = {}): StatTrial {
  return {
    configuration,
    slot,
    ending: "graded" as TrialEnding,
    resolved,
    matches: true,
    tokens: null,
    spentUsd: null,
    cost: null,
    minutes: null,
    ...extra,
  };
}

/** Slot s of configuration c is resolved when s < r(c). */
function fixtureTasks(rows: number[][], trialsPerTask = 3): StatTask[] {
  const count = rows[0]?.length ?? 0;
  const tasks: StatTask[] = [];
  for (let i = 0; i < count; i += 1) {
    const trials: StatTrial[] = [];
    rows.forEach((row, c) => {
      for (let s = 0; s < trialsPerTask; s += 1) trials.push(trial(c, s, s < (row[i] ?? 0)));
    });
    tasks.push({ key: `task-${String(i + 1).padStart(2, "0")}`, area: "host", promptOrigin: null, leftHoldout: false, trials });
  }
  return tasks;
}

const P0 = [1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 1, 0];
const P1 = [2, 1, 2, 3, 3, 2, 1, 0, 3, 3, 2, 1];
const input = (seed: string, configurations: number, tasks: StatTask[], plannedTasks = tasks.length): StatInput =>
  ({ seed, configurations, trialsPerTask: 3, plannedTasks, tasks });
const fixtureP = (): StatInput => input("job-fixture", 2, fixtureTasks([P0, P1]));

test("the generator follows the reference", () => {
  const next = xoshiro128ss([1, 2, 3, 4]);
  assert.deepEqual([next(), next(), next(), next(), next()], [11520, 0, 5927040, 70819200, 2031721883]);
  const stream = bootstrapStream("job-fixture", "0:1", "all");
  assert.deepEqual([stream(), stream(), stream()], [914680446, 1482476434, 3845691706]);
});

test("a two-configuration result gives the planned figures", () => {
  const stats = comparisonStats(fixtureP());
  assert.equal(stats.pairs.length, 1);
  const pair = stats.pairs[0];
  assert.equal(pair.a, 0);
  assert.equal(pair.b, 1);
  assert.equal(pair.n, 12);
  // D = r1 - r0 = 1,1,0,0,2,0,1,-1,0,1,1,1; sum 7; mean 7 / (12 * 3).
  assert.equal(pair.mean, 7 / 36);
  assert.deepEqual(pair.interval, [2 / 36, 12 / 36]);
  // 7 wins, 1 loss, 4 ties; p = 2 * (C(8,0) + C(8,1)) / 2^8 = 18 / 256.
  assert.deepEqual(pair.sign, { wins: 7, losses: 1, ties: 4, p: 0.0703125 });
  assert.equal(pair.holm, 0.0703125);
  // D / 3 has sum of squares 11 / 9 over 12 values; mean 7/36; sample variance (11/9 - 49/108) / 11 = 0.069865; s = 0.264320.
  // observed = 2.801585 * 0.264320 / sqrt(12) = 0.213769.
  near(pair.detectable.observed, 0.213769, "observed");
  // planning = 2.801585 * [0.35, 0.41] / sqrt(12) = [0.283062, 0.331587].
  nearInterval(pair.detectable.planning, [0.283062, 0.331587], "planning");
  assert.equal(stats.tasks.analysed, 12);
  assert.equal(stats.conclusive, true);
});

test("the same result set gives the same interval on every run", () => {
  const results = Array.from({ length: 10 }, () => comparisonStats(fixtureP()));
  for (const result of results) assert.deepEqual(result.pairs[0].interval, results[0].pairs[0].interval);
  assert.equal(results[0].pairs.length, 1);
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("the figures do not depend on row order", () => {
  const base = comparisonStats(fixtureP());
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const shuffle = <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = rand(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  for (let round = 0; round < 50; round += 1) {
    const tasks = shuffle(fixtureP().tasks).map((task) => ({ ...task, trials: shuffle(task.trials) }));
    const result = comparisonStats({ ...fixtureP(), tasks });
    assert.equal(result.pairs.length, base.pairs.length);
    assert.equal(result.byArea.length, base.byArea.length);
    assert.deepEqual(result, base);
  }
});

test("three configurations report Holm-adjusted p-values", () => {
  const h0 = [1, 2, 0, 1, 2, 1, 0, 3, 1, 2, 1, 0];
  const h1 = [2, 2, 1, 1, 3, 1, 0, 3, 2, 2, 1, 1];
  const h2 = [1, 3, 2, 2, 3, 2, 1, 2, 2, 3, 2, 1];
  const stats = comparisonStats(input("job-holm", 3, fixtureTasks([h0, h1, h2])));
  assert.equal(stats.pairs.length, 3);
  assert.deepEqual(stats.pairs.map((pair) => [pair.a, pair.b]), [[0, 1], [0, 2], [1, 2]]);
  // Sums of D: 0:1 -> 5 (5 wins, 0 losses), 0:2 -> 10 (10 wins, 1 loss), 1:2 -> 5 (7 wins, 2 losses).
  assert.deepEqual(stats.pairs.map((pair) => (pair.mean as number) * 36), [5, 10, 5]);
  assert.deepEqual(stats.pairs[0].interval, [2 / 36, 8 / 36]);
  assert.deepEqual(stats.pairs[1].interval, [5 / 36, 14 / 36]);
  assert.deepEqual(stats.pairs[2].interval, [0, 10 / 36]);
  // p(0:1) = 2 * 1 / 2^5 = 0.0625; p(0:2) = 2 * (1 + 11) / 2^11 = 24 / 2048; p(1:2) = 2 * (1 + 9 + 36) / 2^9 = 92 / 512.
  assert.deepEqual(stats.pairs.map((pair) => pair.sign.p), [0.0625, 0.01171875, 0.1796875]);
  // Holm: sorted p = 0.01171875, 0.0625, 0.1796875; adjusted = 3 * 0.01171875, 2 * 0.0625, max(0.125, 0.1796875).
  assert.deepEqual(stats.pairs.map((pair) => pair.holm), [0.125, 0.03515625, 0.1796875]);
});

test("the Holm adjustment holds at two, three, and six pairs", () => {
  // Two: sorted 0.01, 0.04 -> 2 * 0.01 = 0.02, then max(0.02, 1 * 0.04) = 0.04. Input order is kept.
  assert.deepEqual(holm([0.04, 0.01]), [0.04, 0.02]);
  // Three: 0.01, 0.02, 0.03 -> 0.03, 2 * 0.02 = 0.04, max(0.04, 0.03) = 0.04.
  assert.deepEqual(holm([0.03, 0.01, 0.02]).map((v) => Number(v.toFixed(12))), [0.04, 0.03, 0.04]);
  // Six: p = 0.001, 0.005, 0.01, 0.02, 0.04, 0.5 -> 6 * 0.001 = 0.006, 5 * 0.005 = 0.025, 4 * 0.01 = 0.04,
  // 3 * 0.02 = 0.06, 2 * 0.04 = 0.08, 1 * 0.5 = 0.5; already non-decreasing.
  const six = holm([0.5, 0.04, 0.02, 0.01, 0.005, 0.001]).map((v) => Number(v.toFixed(12)));
  assert.deepEqual(six, [0.5, 0.08, 0.06, 0.04, 0.025, 0.006]);
  // A cap at 1 and a monotone step: 0.3 * 3 = 0.9 is raised by nothing; 0.5 * 2 = 1 (capped), 0.9 * 1 -> max(1, 0.9) = 1.
  assert.deepEqual(holm([0.3, 0.5, 0.9]).map((v) => Number(v.toFixed(12))), [0.9, 1, 1]);
  // A later smaller product is lifted to the running maximum: p = 0.01, 0.011 -> 0.02, max(0.02, 0.011) = 0.02.
  assert.deepEqual(holm([0.01, 0.011]), [0.02, 0.02]);
  assert.deepEqual(holm([]), []);
  assert.deepEqual(holm([0.2]), [0.2]);
  // Four configurations give six pairs.
  const rows = [P0, P1, [2, 2, 1, 1, 3, 1, 0, 3, 2, 2, 1, 1], [1, 3, 2, 2, 3, 2, 1, 2, 2, 3, 2, 1]];
  const stats = comparisonStats(input("job-six", 4, fixtureTasks(rows)));
  assert.equal(stats.pairs.length, 6);
  for (const pair of stats.pairs) assert.ok(pair.holm >= pair.sign.p && pair.holm <= 1);
});

test("attrition, the share rule, and the sensitivity figure", () => {
  const r0 = [1, 2, 0, 3, 1, 2, 2, 1];
  const r1 = [2, 2, 1, 3, 2, 3, 2, 2];
  const build = (task09Slot2: StatTrial[]): StatTask[] => {
    const tasks = fixtureTasks([r0, r1]);
    tasks.push({
      key: "task-09",
      area: "host",
      promptOrigin: null,
      leftHoldout: false,
      trials: [
        trial(0, 0, true),
        trial(0, 1, true),
        trial(0, 2, false),
        trial(1, 0, true),
        trial(1, 1, false),
        ...task09Slot2,
      ],
    });
    tasks.push({
      key: "task-10",
      area: "host",
      promptOrigin: null,
      leftHoldout: false,
      trials: [
        trial(0, 0, true),
        trial(0, 1, true, { matches: false }),
        trial(0, 2, true),
        trial(1, 0, true),
        trial(1, 1, true),
        trial(1, 2, true),
      ],
    });
    return tasks;
  };
  const voids = [0, 1, 2].map((attempt) => trial(1, 2, false, { ending: "void-limit", resolved: attempt < 0 }));
  const stats = comparisonStats(input("job-attrition", 2, build(voids), 10));
  assert.equal(stats.tasks.analysed, 8);
  assert.equal(stats.conclusive, false);
  const pair = stats.pairs[0];
  assert.equal(pair.n, 8);
  // D over tasks 01-08 = 1,0,1,0,1,1,0,1 -> sum 5, mean 5 / 24.
  assert.equal(pair.mean, 5 / 24);
  assert.deepEqual(pair.interval, [2 / 24, 7 / 24]);
  // 5 wins, 0 losses: p = 2 * 1 / 2^5.
  assert.deepEqual(pair.sign, { wins: 5, losses: 0, ties: 3, p: 0.0625 });
  assert.deepEqual(stats.attrition[0], { configuration: 0, void: { "void-limit": 0, "void-host": 0, "void-owner": 0 }, changed: 1, short: 1 });
  assert.deepEqual(stats.attrition[1], { configuration: 1, void: { "void-limit": 3, "void-host": 0, "void-owner": 0 }, changed: 0, short: 1 });
  // Sensitivity over 10 tasks: tasks 01-08 sum 5; task 09 r0 = 2, r1 = 1 -> -1; task 10 r0 = 2 valid, r1 = 3 -> +1; total 5; mean 5 / 30.
  assert.equal(stats.sensitivity[0].n, 10);
  assert.equal(stats.sensitivity[0].mean, 5 / 30);
  // Task 09's slot 2 graded and unresolved in place of the voids: configuration 1 now has 3 valid trials, so 9 tasks are analysed (90 >= 9 * 10).
  const fixed = comparisonStats(input("job-attrition", 2, build([trial(1, 2, false)]), 10));
  assert.equal(fixed.tasks.analysed, 9);
  assert.equal(fixed.conclusive, true);
});

test("a confirm task that left holdout counts against the share", () => {
  const mark = (count: number): StatInput => {
    const tasks = fixtureTasks([P0, P1]);
    for (const task of tasks.slice(12 - count)) task.leftHoldout = true;
    return input("job-fixture", 2, tasks);
  };
  const one = comparisonStats(mark(1));
  assert.equal(one.tasks.analysed, 11);
  assert.equal(one.tasks.leftHoldout, 1);
  // 11 * 10 = 110 >= 12 * 9 = 108.
  assert.equal(one.conclusive, true);
  const two = comparisonStats(mark(2));
  assert.equal(two.tasks.analysed, 10);
  assert.equal(two.tasks.leftHoldout, 2);
  // 10 * 10 = 100 < 108.
  assert.equal(two.conclusive, false);
});

test("subgroups by area and prompt origin", () => {
  const tasks = fixtureTasks([P0, P1]);
  tasks.forEach((task, i) => {
    task.area = i < 6 ? "host" : "web";
    task.promptOrigin = (i % 2 === 0 ? "assignment" : "commit-message") as PromptOrigin;
  });
  const stats = comparisonStats(input("job-fixture", 2, tasks));
  assert.deepEqual(stats.byArea.map((g) => [g.area, g.n]), [["host", 6], ["web", 6]]);
  assert.deepEqual(stats.byPromptOrigin.map((g) => [g.promptOrigin, g.n]), [["assignment", 6], ["commit-message", 6]]);
  const [host, web] = stats.byArea.map((g) => g.pairs[0]);
  // host tasks 01-06: D = 1,1,0,0,2,0 -> 4/18; 3 wins -> p = 2 / 8.
  assert.equal(host.mean, 4 / 18);
  assert.deepEqual(host.interval, [1 / 18, 8 / 18]);
  assert.equal(host.sign.p, 0.25);
  // web tasks 07-12: D = 1,-1,0,1,1,1 -> 3/18; 4 wins, 1 loss -> p = 2 * 6 / 32.
  assert.equal(web.mean, 3 / 18);
  assert.deepEqual(web.interval, [-1 / 18, 6 / 18]);
  assert.equal(web.sign.p, 0.375);
  const [assignment, commit] = stats.byPromptOrigin.map((g) => g.pairs[0]);
  // odd tasks: D = 1,0,2,1,0,1 -> 5/18; 4 wins -> p = 2 / 16.
  assert.equal(assignment.mean, 5 / 18);
  assert.deepEqual(assignment.interval, [2 / 18, 8 / 18]);
  assert.equal(assignment.sign.p, 0.125);
  // even tasks: D = 1,0,0,-1,1,1 -> 2/18; 3 wins, 1 loss -> p = 2 * 5 / 16.
  assert.equal(commit.mean, 2 / 18);
  assert.deepEqual(commit.interval, [-2 / 18, 5 / 18]);
  assert.equal(commit.sign.p, 0.625);
  assert.equal(stats.byPromptOrigin.some((g) => g.promptOrigin === "run-objective"), false);
  // A null origin is left out of the origin groups but stays in the area groups.
  tasks[0].promptOrigin = null;
  const withNull = comparisonStats(input("job-fixture", 2, tasks));
  assert.equal(withNull.byPromptOrigin[0].n, 5);
  assert.equal(withNull.byArea[0].n, 6);
});

test("the sign test and the power figure follow their formulas", () => {
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(7, 1), 0.0703125);
  assert.equal(signTest(10, 1), 0.01171875);
  // 5 and 5: twice the lower tail through k = 5 is 2 * 638 / 1024 > 1, capped at 1.
  assert.equal(signTest(5, 5), 1);
  // 4 and 0: 2 * 1 / 16.
  assert.equal(signTest(4, 0), 0.125);
  // 2.801585 * [0.35, 0.41] / sqrt(n): n 15 -> 0.98055 / 3.872983, 1.148650 / 3.872983.
  const planningAt = (n: number): [number, number] | null => {
    const tasks = fixtureTasks([Array(n).fill(1), Array(n).fill(2)]);
    return comparisonStats(input("job-power", 2, tasks)).pairs[0].detectable.planning;
  };
  nearInterval(planningAt(15), [0.253178, 0.29658], "n 15");
  nearInterval(planningAt(30), [0.179024, 0.209714], "n 30");
  nearInterval(planningAt(60), [0.126589, 0.14829], "n 60");
  // One pair: observed is null, planning is defined.
  const one = comparisonStats(input("job-one", 2, fixtureTasks([[1], [2]]))).pairs[0];
  assert.equal(one.n, 1);
  assert.equal(one.detectable.observed, null);
  near(one.detectable.planning?.[0] ?? null, 2.801585 * 0.35, "n 1 planning");
  assert.equal(one.mean, 1 / 3);
  // The interval of one task is its own value in every resample: D = 1 -> [1/3, 1/3].
  assert.deepEqual(one.interval, [1 / 3, 1 / 3]);
  // Zero pairs: no mean, no interval, no planning, p = 1.
  const zero = comparisonStats(input("job-zero", 2, [], 0)).pairs[0];
  assert.equal(zero.n, 0);
  assert.equal(zero.mean, null);
  assert.equal(zero.interval, null);
  assert.equal(zero.detectable.planning, null);
  assert.equal(zero.detectable.observed, null);
  assert.equal(zero.sign.p, 1);
  assert.equal(comparisonStats(input("job-zero", 2, [], 0)).conclusive, false);
});

test("all ties give a zero mean and a p of one", () => {
  const stats = comparisonStats(input("job-ties", 2, fixtureTasks([[1, 2, 3, 0], [1, 2, 3, 0]])));
  const pair = stats.pairs[0];
  assert.equal(pair.n, 4);
  assert.equal(pair.mean, 0);
  assert.deepEqual(pair.interval, [0, 0]);
  assert.deepEqual(pair.sign, { wins: 0, losses: 0, ties: 4, p: 1 });
  assert.equal(pair.holm, 1);
  // Every D is 0, so the sample standard deviation is 0.
  assert.equal(pair.detectable.observed, 0);
});

test("cost per resolved trial counts only complete costs", () => {
  const build = (slot0Cost: "complete" | "partial"): StatInput => input("job-cost", 1, [{
    key: "task-01",
    area: "host",
    promptOrigin: null,
    leftHoldout: false,
    trials: [
      trial(0, 0, true, { tokens: 1000, spentUsd: 0.5, cost: slot0Cost, minutes: 10 }),
      trial(0, 1, false, { tokens: 3000, spentUsd: 1.5, cost: "complete", minutes: 20 }),
      trial(0, 2, true, { tokens: 2000, spentUsd: 1.0, cost: "partial", minutes: 30 }),
      trial(0, 2, false, { ending: "void-host", tokens: 500, spentUsd: 0.25, cost: "complete", minutes: null }),
    ],
  }]);
  const cost = comparisonStats(build("complete")).cost[0];
  assert.equal(cost.trials, 4);
  assert.equal(cost.resolved, 2);
  assert.equal(cost.costed, 3);
  // Costed = slot 0, slot 1, the void attempt: tokens 4500, USD 2.25, over 1 resolved valid trial among them.
  assert.equal(cost.tokensPerResolved, 4500);
  assert.equal(cost.spentUsdPerResolved, 2.25);
  // Minutes 10 + 20 + 30 = 60 over the 2 resolved among the timed trials.
  assert.equal(cost.minutesPerResolved, 30);
  assert.equal(cost.listUsdPerResolved, null);
  // Slot 0 partial: the costed trials are slot 1 and the void, with no resolved trial among them.
  const partial = comparisonStats(build("partial")).cost[0];
  assert.equal(partial.costed, 2);
  assert.equal(partial.tokensPerResolved, null);
  assert.equal(partial.spentUsdPerResolved, null);
  assert.equal(partial.minutesPerResolved, 30);
});
