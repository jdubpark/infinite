import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RESCUE_USD, TIER_COSTS, choose, chooseScout, screen, screenEscalations, screenProfiles, screenScouts, tierCost, utility, type Scored, type Screened } from "../packages/host/src/routing-choice.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { betaSample, candidateSeed, decisionSeed } from "../packages/host/src/routing-sample.js";
import type { Beta, ProfilePosterior, RoutingKnobs, RoutingPoint, TeamRunRouting } from "../packages/host/src/routing-types.js";
import { coversPoint, type TeamLineup, type TeamModelProfile, type TeamRun } from "../packages/host/src/team-types.js";
import type { Provider } from "../packages/host/src/types.js";
import { mixedLineup } from "./team-fixture.js";

const knobs = (over: Partial<RoutingKnobs> = {}): RoutingKnobs => ({ ...ROUTING_DEFAULTS, ...over });
const beta = (a: number, b: number): Beta => ({ a, b });
const round2 = (value: number) => Math.round(value * 100) / 100 + 0;
const codex = (id: string, model: string, effort: "high" | "xhigh" = "high"): TeamModelProfile => ({ id, label: id, provider: "codex", model, effort });
const lineupWith = (implementers: TeamModelProfile[]): TeamLineup => ({ ...mixedLineup, implementers });
const spark = mixedLineup.implementers[0];

function posterior(theta: Beta, phi: Beta): ProfilePosterior {
  return { reward: [], rescue: [], theta, phi, rows: { production: 0, duel: 0 }, earlierRows: 0, level: "none", untimed: 0 };
}

/** One scored entry per distinct identity, from the shape of the first profile that has it (as `choose` keys by identity). */
function scoredFor(screened: readonly Screened[], shape: (profileId: string) => { theta: Beta; phi: Beta; costUsd: number }): Map<string, Scored> {
  const scored = new Map<string, Scored>();
  for (const item of screened) if (!scored.has(item.identity)) {
    const { theta, phi, costUsd } = shape(item.profile.id);
    scored.set(item.identity, { profile: item.profile, identity: item.identity, posterior: posterior(theta, phi), costUsd });
  }
  return scored;
}

test("a sampled choice is the best of one draw per candidate, with ties to lineup order", () => {
  const example = knobs({ successValueUsd: 2, listWeight: 1 });
  // p1dup shares p1's identity, so it draws the same value: ties go to lineup order.
  const lineup = lineupWith([codex("p1", "m1"), codex("p2", "m2"), codex("p3", "m3", "xhigh"), { ...codex("p1dup", "m1"), label: "dup" }]);
  const screened = screen(lineup, example, new Set<Provider>());
  const shape: Record<string, { theta: Beta; phi: Beta; costUsd: number }> = {
    p1: { theta: beta(1, 1), phi: beta(3, 2), costUsd: 0.4 }, p2: { theta: beta(2, 1), phi: beta(7, 3), costUsd: 0.3 }, p3: { theta: beta(9, 2), phi: beta(9, 1), costUsd: 2.2 },
  };
  const scored = scoredFor(screened, id => shape[id]);
  let explored = 0;
  for (let i = 0; i < 200; i += 1) {
    const seed = `oracle-${i}`;
    const choice = choose(screened, scored, example, "normal", seed)!;
    let best = "", bestU = Number.NEGATIVE_INFINITY;
    screened.forEach((item, index) => {
      const s = scored.get(item.identity)!;
      const draw = betaSample(s.posterior.theta.a, s.posterior.theta.b, candidateSeed(seed, item.identity)).value;
      const u = utility({ theta: draw, phi: s.posterior.phi.a / (s.posterior.phi.a + s.posterior.phi.b), costUsd: s.costUsd }, example, "normal");
      assert.equal(choice.candidates[index].sample, draw);
      assert.equal(choice.candidates[index].sampledUtility, u);
      if (u > bestU) { best = item.profile.id; bestU = u; }
    });
    assert.equal(choice.basis, "sampled");
    assert.equal(choice.chosen, best);
    assert.equal(choice.explore, best !== "p2");
    if (choice.explore) explored += 1;
  }
  assert.ok(explored > 0 && explored < 200, `explored ${explored}`);
});

// Golden draws pin the generator: a changed generator must raise ROUTING_ALGORITHM_VERSION. Math.log, Math.cos and **
// can differ in the last bits between CPUs and Node builds, as the plan expects of a recheck, so each value is compared
// within 1e-12: far above that drift, far below what a structural change to the generator moves.
const GOLDEN_TOLERANCE = 1e-12;
function assertGolden(a: number, b: number, seeds: readonly string[], expected: readonly number[]) {
  assert.equal(seeds.length, expected.length);
  seeds.forEach((seed, i) => {
    const value = betaSample(a, b, seed).value;
    assert.ok(Math.abs(value - expected[i]) <= GOLDEN_TOLERANCE, `${seed}: ${value} is not ${expected[i]}`);
  });
}

// Beta(0.3, 0.7): the shape-below-1 path. An independent re-derivation agrees to 1 ulp.
const GOLDEN_LOW = [0.026535592372285116, 0.1874803328660342];

test("rule order, the elevated value, the first of all-limited candidates, the seed formulas, and a shape below 1", () => {
  const removed = (lineup: TeamLineup, limited: Provider[]) => screen(lineup, knobs(), new Set(limited)).map(item => [item.profile.id, item.removed ?? null]);
  assert.deepEqual(removed(mixedLineup, ["opencode"]), [["spark-high", "contributor"], ["astra-xhigh", null]]);
  assert.deepEqual(removed(lineupWith([codex("same", mixedLineup.reviewer.model)]), ["codex"]), [["same", "reviewer-model"]]);

  assert.equal(utility({ theta: 0.5, phi: 1, costUsd: 0 }, knobs({ successValueUsd: 2, listWeight: 1 }), "elevated"), 3);

  const twoCodex = screen(lineupWith([codex("codex-a", "gpt-a"), codex("codex-b", "gpt-b")]), knobs(), new Set<Provider>(["codex"]));
  const all = choose(twoCodex, scoredFor(twoCodex, id => ({ theta: id === "codex-b" ? beta(9, 1) : beta(1, 9), phi: beta(1, 1), costUsd: 0.4 })), knobs(), "normal", "s")!;
  assert.deepEqual([all.basis, all.chosen, all.greedy], ["default-all-limited", "codex-a", "codex-a"]);

  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(decisionSeed("digest", "run-1", 1, "task-a", "start", 0), sha("digest|run-1|1|task-a|start|0"));
  assert.equal(candidateSeed("seed", "identity-a"), sha("seed|identity-a"));

  assertGolden(0.3, 0.7, ["golden-low-1", "golden-low-2"], GOLDEN_LOW);
});

test("fixed rules remove contributor, reviewer-model, and limited candidates", () => {
  const removed = (lineup: TeamLineup, policy: RoutingKnobs, limited = new Set<Provider>()) =>
    screen(lineup, policy, limited).map(item => [item.profile.id, item.removed ?? null]);

  assert.deepEqual(removed(mixedLineup, knobs()), [["spark-high", "contributor"], ["astra-xhigh", null]]);
  assert.deepEqual(removed(mixedLineup, knobs({ allowContributor: true })), [["spark-high", null], ["astra-xhigh", null]]);

  const sameModel = lineupWith([codex("same-model", mixedLineup.reviewer.model), mixedLineup.implementers[1]]);
  assert.deepEqual(removed(sameModel, knobs()), [["same-model", "reviewer-model"], ["astra-xhigh", null]]);

  assert.deepEqual(removed(mixedLineup, knobs(), new Set<Provider>(["codex"])), [["spark-high", "contributor"], ["astra-xhigh", "limited"]]);
  assert.deepEqual(removed(mixedLineup, knobs({ allowContributor: true }), new Set<Provider>(["opencode"])), [["spark-high", "limited"], ["astra-xhigh", null]]);

  // OpenCode profiles differ by variant: two variants of one model are two real candidates, neither dropped.
  const openCode = (id: string, variant: string): TeamModelProfile => ({ id, label: id, provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant });
  const variants = lineupWith([openCode("oc-high", "high"), openCode("oc-low", "low")]);
  const kept = screen(variants, knobs({ allowContributor: true }), new Set<Provider>());
  assert.deepEqual(kept.map(item => [item.profile.id, item.removed ?? null]), [["oc-high", null], ["oc-low", null]]);
  assert.notEqual(kept[0].identity, kept[1].identity);
});

test("coverage and the default profile", () => {
  const contributorOnly = lineupWith([spark, codex("same-model", mixedLineup.reviewer.model)]);
  const none = screen(contributorOnly, knobs(), new Set<Provider>());
  assert.equal(choose(none, new Map(), knobs(), "normal", "seed"), undefined);

  const twoCodex = lineupWith([codex("codex-a", "gpt-a"), codex("codex-b", "gpt-b")]);
  const limited = screen(twoCodex, knobs(), new Set<Provider>(["codex"]));
  const allLimited = choose(limited, scoredFor(limited, () => ({ theta: beta(2, 1), phi: beta(1, 1), costUsd: 0.4 })), knobs(), "normal", "seed");
  assert.ok(allLimited);
  assert.equal(allLimited.basis, "default-all-limited");
  assert.equal(allLimited.chosen, "codex-a");
  assert.equal(allLimited.greedy, "codex-a");
  assert.equal(allLimited.explore, false);

  const single = lineupWith([spark, codex("codex-a", "gpt-a")]);
  const one = screen(single, knobs(), new Set<Provider>());
  const onlyPass = choose(one, scoredFor(one, () => ({ theta: beta(2, 1), phi: beta(1, 1), costUsd: 0.4 })), knobs(), "normal", "seed");
  assert.ok(onlyPass);
  assert.equal(onlyPass.basis, "single-candidate");
  assert.equal(onlyPass.chosen, "codex-a");
  assert.equal(onlyPass.explore, false);
});

test("the worked example", () => {
  assert.equal(RESCUE_USD, 1.5);
  assert.equal(TIER_COSTS.light, 0.4);
  assert.equal(TIER_COSTS.strong, 2.2);
  assert.equal(tierCost({ id: "x", label: "x", provider: "codex", model: "m", effort: "high" }), 0.4);
  assert.equal(tierCost({ id: "x", label: "x", provider: "codex", model: "m", effort: "high", tier: "strong" }), 2.2);

  const example = knobs({ successValueUsd: 2, listWeight: 1 });
  assert.equal(round2(utility({ theta: 0.5, phi: 0.6, costUsd: 0.4 }, example, "normal")), 0);
  assert.equal(round2(utility({ theta: 2 / 3, phi: 0.7, costUsd: 0.3 }, example, "normal")), 0.58);
  assert.equal(round2(utility({ theta: 9 / 11, phi: 0.9, costUsd: 2.2 }, example, "normal")), -0.71);
  assert.equal(round2(utility({ theta: 0.72, phi: 0.6, costUsd: 0.4 }, example, "normal")), 0.44);
  assert.equal(round2(utility({ theta: 0.44, phi: 0.7, costUsd: 0.3 }, example, "normal")), 0.13);
  assert.equal(round2(utility({ theta: 0.86, phi: 0.9, costUsd: 2.2 }, example, "normal")), -0.63);

  const lineup = lineupWith([codex("p1", "m1"), codex("p2", "m2"), codex("p3", "m3", "xhigh")]);
  const screened = screen(lineup, example, new Set<Provider>());
  const shape: Record<string, { theta: Beta; phi: Beta; costUsd: number }> = {
    p1: { theta: beta(1, 1), phi: beta(3, 2), costUsd: 0.4 },
    p2: { theta: beta(2, 1), phi: beta(7, 3), costUsd: 0.3 },
    p3: { theta: beta(9, 2), phi: beta(9, 1), costUsd: 2.2 },
  };
  const choice = choose(screened, scoredFor(screened, id => shape[id]), example, "normal", "seed-example");
  assert.ok(choice);
  assert.equal(choice.greedy, "p2");
  assert.equal(choice.basis, "sampled");
});

test("elevated risk is greedy at the mean minus one deviation with triple value", () => {
  const lineup = lineupWith([codex("bee", "model-b"), codex("ay", "model-a")]);
  const screened = screen(lineup, knobs(), new Set<Provider>());
  const scored = scoredFor(screened, id => ({ theta: id === "bee" ? beta(3, 1) : beta(30, 10), phi: beta(1, 1), costUsd: 0.4 }));

  const normal = choose(screened, scored, knobs(), "normal", "seed");
  assert.ok(normal);
  assert.equal(normal.greedy, "bee");

  for (let i = 0; i < 1000; i += 1) {
    const elevated = choose(screened, scored, knobs(), "elevated", `seed-${i}`);
    assert.ok(elevated);
    assert.equal(elevated.basis, "greedy-risk");
    assert.equal(elevated.chosen, "ay");
    assert.equal(elevated.explore, false);
  }
});

// Recorded from the implementation on 2026-11-15 on arm64. x64 gives 0.10943549295678799 for the third, 2 ULPs away.
const GOLDEN_VALUES = [0.2881993592935194, 0.35225517656152383, 0.10943549295678802];

test("the sampler is deterministic and matches its Beta", () => {
  assert.deepEqual(betaSample(2, 5, "repeat"), betaSample(2, 5, "repeat"));

  const drawsOf = (a: number, b: number) => {
    let sum = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const draw = betaSample(a, b, `beta-${a}-${b}-${i}`);
      assert.equal(draw.fallback, false);
      assert.ok(draw.value > 0 && draw.value < 1, `draw ${draw.value} outside (0, 1)`);
      sum += draw.value;
    }
    return sum / 20_000;
  };
  assert.ok(Math.abs(drawsOf(2, 5) - 2 / 7) < 0.01);
  assert.ok(Math.abs(drawsOf(0.3, 0.7) - 0.3) < 0.01);

  for (const [a, b] of [[0, 1], [1, -1], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]] as const) {
    assert.throws(() => betaSample(a, b, "s"), RangeError);
  }

  assertGolden(2, 5, ["golden-1", "golden-2", "golden-3"], GOLDEN_VALUES);
});

test("the seed binds every part of the key", () => {
  const base = decisionSeed("digest", "run-1", 1, "task-a", "start", 0);
  assert.equal(base, decisionSeed("digest", "run-1", 1, "task-a", "start", 0));
  const variants = [
    decisionSeed("digest-2", "run-1", 1, "task-a", "start", 0),
    decisionSeed("digest", "run-2", 1, "task-a", "start", 0),
    decisionSeed("digest", "run-1", 2, "task-a", "start", 0),
    decisionSeed("digest", "run-1", 1, "task-b", "start", 0),
    decisionSeed("digest", "run-1", 1, "task-a", "escalation", 0),
    decisionSeed("digest", "run-1", 1, "task-a", "start", 1),
  ];
  for (const variant of variants) assert.notEqual(variant, base);

  assert.notEqual(candidateSeed(base, "identity-a"), candidateSeed(base, "identity-b"));
  assert.notEqual(candidateSeed(base, "identity-a"), base);
});

const ALL_POINTS: RoutingPoint[] = ["start", "escalation", "scout"];

// The point lineup: the reviewer is on claude-opus-5-5, as in tests/routing-points-rules.test.ts.
const claudeAt = (id: string, model: string, effort: "high" | "xhigh", tier?: "light" | "strong"): TeamModelProfile =>
  ({ id, label: id, provider: "claude", model, effort, ...(tier ? { tier } : {}) }) as TeamModelProfile;
const contributorAt = (id: string): TeamModelProfile =>
  ({ id, label: id, provider: "opencode", model: "contrib/spark", variant: "high", tier: "light", dataUse: "contributor" }) as TeamModelProfile;
const POINT_LINEUP = {
  coordinator: claudeAt("coord", "claude-sonnet-5-5", "high"),
  integrator: claudeAt("integ", "claude-sonnet-5-5", "high"),
  reviewer: claudeAt("reviewer", "claude-opus-5-5", "xhigh"),
  implementers: [
    contributorAt("spark-high"),
    codex("astra-xhigh", "gpt-6-astra", "xhigh"),
    claudeAt("haiku-light", "claude-haiku-5-5", "high", "light"),
    claudeAt("opus-strong", "claude-opus-5-5", "xhigh", "strong"),
  ],
  escalations: [
    claudeAt("opus-escalation", "claude-opus-5-5", "xhigh", "strong"),
    codex("astra-escalation", "gpt-6-astra", "high"),
    claudeAt("sonnet-escalation", "claude-sonnet-5-5", "high", "strong"),
    contributorAt("spark-escalation"),
  ],
} as unknown as TeamLineup;

test("escalation and scout choices never sample, over 1,000 seeds", () => {
  const example = knobs({ successValueUsd: 2, listWeight: 1 });
  const escalations = screenEscalations(POINT_LINEUP, example, new Set<Provider>(), undefined);
  assert.deepEqual(escalations.filter(item => item.removed === undefined).map(item => item.profile.id), ["astra-escalation", "sonnet-escalation"]);
  const shape: Record<string, { theta: Beta; phi: Beta; costUsd: number }> = {
    "astra-escalation": { theta: beta(2, 1), phi: beta(7, 3), costUsd: 2.2 },
    "sonnet-escalation": { theta: beta(9, 2), phi: beta(9, 1), costUsd: 2.2 },
  };
  const scored = scoredFor(escalations, id => shape[id] ?? { theta: beta(1, 1), phi: beta(1, 1), costUsd: 2.2 });
  for (const risk of ["normal", "elevated"] as const) {
    for (let i = 0; i < 1000; i += 1) {
      const choice = choose(escalations, scored, example, risk, `seed-${risk}-${i}`, "escalation")!;
      assert.equal(choice.basis, "greedy-point");
      assert.equal(choice.explore, false);
      assert.equal(choice.chosen, choice.greedy);
      for (const record of choice.candidates) {
        assert.equal(record.sample, undefined);
        assert.equal(record.sampledUtility, undefined);
      }
    }
  }

  const scouts = screenScouts(POINT_LINEUP, example, new Set<Provider>());
  const first = chooseScout(scouts)!;
  for (let i = 0; i < 1000; i += 1) {
    const again = chooseScout(scouts)!;
    assert.notEqual(again.basis, "sampled");
    assert.equal(again.explore, false);
    assert.deepEqual(again, first);
  }
});

test("the scout rule takes the lowest tier cost and screens rules 1 to 3", () => {
  const example = knobs({ successValueUsd: 2, listWeight: 1 });

  const nothing = chooseScout(screenScouts(POINT_LINEUP, example, new Set<Provider>()))!;
  assert.deepEqual([nothing.basis, nothing.chosen, nothing.greedy, nothing.explore], ["greedy-point", "astra-xhigh", "astra-xhigh", false]);
  assert.deepEqual(nothing.candidates.map(record => [record.profileId, record.removed ?? null, record.costUsd ?? null]),
    [["spark-high", "contributor", null], ["astra-xhigh", null, 0.4], ["haiku-light", null, 0.4]]);
  assert.equal(nothing.candidates.some(record => record.profileId === "opus-strong"), false);

  const codexLimited = chooseScout(screenScouts(POINT_LINEUP, example, new Set<Provider>(["codex"])))!;
  assert.deepEqual([codexLimited.basis, codexLimited.chosen], ["single-candidate", "haiku-light"]);

  const allLimited = chooseScout(screenScouts(POINT_LINEUP, example, new Set<Provider>(["codex", "claude"])))!;
  assert.deepEqual([allLimited.basis, allLimited.chosen], ["default-all-limited", "astra-xhigh"]);

  const contributorOk = chooseScout(screenScouts(POINT_LINEUP, knobs({ allowContributor: true, successValueUsd: 2, listWeight: 1 }), new Set<Provider>()))!;
  assert.deepEqual([contributorOk.basis, contributorOk.chosen], ["greedy-point", "spark-high"]);

  // Rule 2 applies to the scout's candidates when they come through screenProfiles: opus-strong is on the reviewer's model.
  const unscreenedScouts = chooseScout(screenProfiles(POINT_LINEUP.implementers, POINT_LINEUP, example, new Set<Provider>()))!;
  assert.equal(unscreenedScouts.candidates.find(record => record.profileId === "opus-strong")?.removed, "reviewer-model");
  assert.equal(unscreenedScouts.chosen, "astra-xhigh");

  // Lowest tier cost, not lineup order: the strong profile comes first and costs 2.20; the light one costs 0.40.
  const cheapest = chooseScout(screenProfiles([claudeAt("strong-first", "claude-sonnet-5-5", "high", "strong"), codex("light-second", "gpt-6-astra", "high")],
    POINT_LINEUP, example, new Set<Provider>()))!;
  assert.deepEqual([cheapest.basis, cheapest.chosen], ["greedy-point", "light-second"]);
  assert.deepEqual(cheapest.candidates.map(record => record.costUsd), [2.2, 0.4]);

  // No candidate passes rules 1 and 2: undefined, so the caller writes no row.
  assert.equal(chooseScout(screenProfiles([contributorAt("spark-only")], POINT_LINEUP, example, new Set<Provider>())), undefined);
  assert.equal(chooseScout([] as Screened[]), undefined);
});

test("coverage agrees with the router's screen at both new points", () => {
  const autoPin = (points: RoutingPoint[], over: Partial<RoutingKnobs> = {}) => ({
    mode: "auto", requested: "auto", periodEndedAt: "2026-11-01T00:00:00.000Z", source: "saved",
    knobs: { ...ROUTING_DEFAULTS, points, ...over }, defaults: [], algorithmVersion: 2, rewardVersion: 1, digest: "d",
  }) as unknown as TeamRunRouting;
  const withLineup = (over: Partial<TeamLineup>): TeamLineup => ({ ...POINT_LINEUP, ...over }) as TeamLineup;
  const sonnetStrong = claudeAt("sonnet-strong", "claude-sonnet-5-5", "high", "strong");
  const opusEscalation = POINT_LINEUP.escalations![0];
  const sonnetEscalation = POINT_LINEUP.escalations![2];
  const contributorScoutLineup = withLineup({ implementers: [contributorAt("spark-high"), POINT_LINEUP.implementers[3]] });
  const contributorOnly = withLineup({ implementers: [contributorAt("spark-high")], escalations: [POINT_LINEUP.escalations![3]] });

  // The nine lineups and knob sets: the point lineup, with and without contributors, and variants that cover or uncover each point.
  const cases: { lineup: TeamLineup; over: Partial<RoutingKnobs> }[] = [
    { lineup: POINT_LINEUP, over: {} },
    { lineup: POINT_LINEUP, over: { allowContributor: true } },
    { lineup: withLineup({ escalations: [opusEscalation] }), over: {} },
    { lineup: withLineup({ escalations: undefined }), over: {} },
    { lineup: withLineup({ escalations: [sonnetEscalation, opusEscalation] }), over: {} },
    { lineup: contributorScoutLineup, over: {} },
    { lineup: contributorScoutLineup, over: { allowContributor: true } },
    { lineup: withLineup({ implementers: [sonnetStrong] }), over: {} },
    { lineup: contributorOnly, over: {} },
  ];
  assert.equal(cases.length, 9);

  const escalationCovered: boolean[] = [];
  const scoutCovered: boolean[] = [];
  for (const { lineup, over } of cases) {
    const routing = autoPin(ALL_POINTS, over);
    const knobsOf = routing.knobs as RoutingKnobs;
    const run = { routing, lineup } as Pick<TeamRun, "routing" | "lineup">;
    const escalationKept = screenEscalations(lineup, knobsOf, new Set<Provider>(), undefined).some(item => item.removed === undefined);
    const scoutKept = screenScouts(lineup, knobsOf, new Set<Provider>()).some(item => item.removed === undefined);
    assert.equal(coversPoint(run, "escalation"), escalationKept);
    assert.equal(coversPoint(run, "scout"), scoutKept);
    escalationCovered.push(escalationKept);
    scoutCovered.push(scoutKept);
    // The member's own profile is never its escalation candidate, in the coverage check or in the screen.
    for (const own of (lineup.escalations ?? []).map(profile => profile.id)) {
      const screened = screenEscalations(lineup, knobsOf, new Set<Provider>(), own);
      assert.equal(screened.some(item => item.profile.id === own), false);
      assert.equal(coversPoint(run, "escalation", own), screened.some(item => item.removed === undefined));
    }
  }
  assert.ok(escalationCovered.includes(true) && escalationCovered.includes(false));
  assert.ok(scoutCovered.includes(true) && scoutCovered.includes(false));
});
