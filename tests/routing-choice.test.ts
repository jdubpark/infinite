import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RESCUE_USD, TIER_COSTS, choose, screen, tierCost, utility, type Scored, type Screened } from "../packages/host/src/routing-choice.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import { betaSample, candidateSeed, decisionSeed } from "../packages/host/src/routing-sample.js";
import type { Beta, ProfilePosterior, RoutingKnobs } from "../packages/host/src/routing-types.js";
import type { TeamLineup, TeamModelProfile } from "../packages/host/src/team-types.js";
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

  assert.deepEqual(["golden-low-1", "golden-low-2"].map(seed => betaSample(0.3, 0.7, seed).value), GOLDEN_LOW);
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

// Recorded from the implementation on 2026-11-15 on arm64. A changed generator must raise ROUTING_ALGORITHM_VERSION.
// Math.log, Math.cos and ** can differ in the last bits between CPUs: x64 gives 0.10943549295678799 for the third
// value, 2 ULPs away. The pin allows 1e-12, far above that noise and far below what a changed generator moves.
const GOLDEN_VALUES = [0.2881993592935194, 0.35225517656152383, 0.10943549295678802];
const GOLDEN_TOLERANCE = 1e-12;

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

  ["golden-1", "golden-2", "golden-3"].forEach((seed, i) => {
    const value = betaSample(2, 5, seed).value;
    assert.ok(Math.abs(value - GOLDEN_VALUES[i]) <= GOLDEN_TOLERANCE, `${seed}: ${value} is not ${GOLDEN_VALUES[i]}`);
  });
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
