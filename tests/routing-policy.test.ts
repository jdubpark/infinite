import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { AUTONOMOUS_DEFAULTS, ROUTING_DEFAULTS, effectiveRouting, pinRouting, policyDigest, teamRoutingSchema } from "../packages/host/src/routing-policy.js";
import type { RoutingKnobs, RoutingPoint } from "../packages/host/src/routing-types.js";
import { mixedLineup } from "./team-fixture.js";

const lineup = mixedLineup;
const allKnobs = ["points", "cascade", "successValueUsd", "maxExploreShare", "exploreWindow", "minSpareAttempts", "allowContributor", "listWeight", "headroomWeight"] as const;

test("the policy schema takes each knob and refuses the rest", () => {
  const atBounds = {
    mode: "auto", points: ["start", "escalation", "scout"], cascade: true, successValueUsd: 100, maxExploreShare: 0.5,
    exploreWindow: 500, minSpareAttempts: 20, allowContributor: true, listWeight: 1, headroomWeight: 4,
  };
  assert.deepEqual(teamRoutingSchema.parse(atBounds), atBounds);
  const atLowerBounds = { successValueUsd: 0, maxExploreShare: 0, exploreWindow: 10, minSpareAttempts: 0, listWeight: 0, headroomWeight: 0 };
  assert.deepEqual(teamRoutingSchema.parse(atLowerBounds), atLowerBounds);
  for (const bad of [
    { successValueUsd: 100.01 }, { maxExploreShare: 0.51 }, { exploreWindow: 9 }, { minSpareAttempts: 21 },
    { listWeight: 1.1 }, { headroomWeight: 4.1 }, { points: [] }, { unknown: true }, { mode: "on" },
    { successValueUsd: -0.01 }, { maxExploreShare: -0.01 }, { minSpareAttempts: -0.01 }, { listWeight: -0.01 },
    { headroomWeight: -0.01 }, { exploreWindow: 10.5 }, { minSpareAttempts: 1.5 },
  ]) assert.equal(teamRoutingSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.deepEqual(teamRoutingSchema.parse({}), {});
  assert.deepEqual(teamRoutingSchema.parse({ mode: "shadow" }), { mode: "shadow" });
});

test("the effective mode follows the saved mode and the project's autonomy", () => {
  assert.deepEqual(effectiveRouting({ mode: "off" }, "autonomous"), { mode: "off" });
  assert.deepEqual(effectiveRouting({ mode: "off" }, "supervised"), { mode: "off" });
  const saved = effectiveRouting({ mode: "shadow" }, "supervised");
  assert.equal(saved.mode, "shadow");
  assert.ok(saved.mode === "shadow" && saved.requested === "shadow" && saved.source === "saved");
  const auto = effectiveRouting({ mode: "auto" }, "supervised");
  assert.ok(auto.mode === "shadow" && auto.requested === "auto" && auto.source === "saved");
  const defaulted = effectiveRouting(undefined, "autonomous");
  assert.ok(defaulted.mode === "shadow" && defaulted.requested === "shadow" && defaulted.source === "autonomous-default");
  assert.deepEqual(defaulted, { mode: "shadow", requested: "shadow", source: "autonomous-default", knobs: AUTONOMOUS_DEFAULTS, defaults: allKnobs });
  assert.deepEqual(effectiveRouting(undefined, "supervised"), { mode: "off" });
  const valued = effectiveRouting({ successValueUsd: 8 }, "autonomous");
  assert.ok(valued.mode === "shadow" && valued.source === "saved");
  assert.deepEqual(valued, {
    mode: "shadow", requested: "shadow", source: "saved", knobs: { ...ROUTING_DEFAULTS, successValueUsd: 8 },
    defaults: allKnobs.filter(knob => knob !== "successValueUsd"),
  });
  assert.deepEqual(effectiveRouting({ successValueUsd: 8 }, "supervised"), { mode: "off" });
});

test("a pin needs shadow, the start point, and a lineup", () => {
  assert.equal(pinRouting({ mode: "off" }, "autonomous", lineup), undefined);
  assert.equal(pinRouting({ mode: "shadow", points: ["escalation"] }, "autonomous", lineup), undefined);
  assert.equal(pinRouting({ mode: "shadow" }, "autonomous", undefined), undefined);
  const pin = pinRouting({ mode: "shadow" }, "supervised", lineup);
  assert.ok(pin);
  assert.equal(pin.mode, "shadow");
  assert.equal(pin.requested, "shadow");
  const autoPin = pinRouting({ mode: "auto" }, "supervised", lineup);
  assert.ok(autoPin);
  assert.equal(autoPin.mode, "shadow");
  assert.equal(autoPin.requested, "auto");
  assert.equal(autoPin.source, "saved");
  assert.equal(pin.algorithmVersion, 1);
  assert.equal(pin.rewardVersion, 1);
  assert.equal(Object.keys(pin.knobs).length, 9);
  const effective = effectiveRouting({ mode: "shadow" }, "supervised");
  assert.ok(effective.mode === "shadow");
  assert.equal(pin.digest, policyDigest(effective));
});

const AUTONOMOUS_DEFAULT_DIGEST = "ff4bbf1b489460809a862aa215af23d77e9afad6704072231c6e4ad06d012a34";
const PERIOD_END = "2026-11-01T00:00:00.000Z";

test("off and shadow pins are byte-equal to step 1", () => {
  const cases: [Parameters<typeof pinRouting>[0], Parameters<typeof pinRouting>[1]][] = [
    [{ mode: "off" }, "autonomous"], [{ mode: "off" }, "supervised"], [{ mode: "shadow" }, "supervised"],
    [{ mode: "shadow" }, "autonomous"], [undefined, "autonomous"], [undefined, "supervised"],
    [{ successValueUsd: 8 }, "autonomous"], [{ successValueUsd: 8 }, "supervised"],
  ];
  for (const lineupCase of [lineup, undefined]) {
    for (const [saved, autonomy] of cases) {
      const step1 = JSON.stringify(pinRouting(saved, autonomy, lineupCase, undefined));
      assert.equal(JSON.stringify(pinRouting(saved, autonomy, lineupCase)), step1, JSON.stringify({ saved, autonomy }));
      // A saved off or shadow mode keeps step 1's pin with an end too. So does a supervised project without a mode.
      const ended = pinRouting(saved, autonomy, lineupCase, PERIOD_END);
      const autoWithEnd = saved?.mode === "auto" || (saved?.mode === undefined && autonomy === "autonomous");
      if (!autoWithEnd) {
        assert.equal(JSON.stringify(ended), step1, JSON.stringify({ saved, autonomy, ended: true }));
      }
    }
  }
  const defaultPin = pinRouting(undefined, "autonomous", lineup);
  assert.ok(defaultPin);
  assert.equal(defaultPin.mode, "shadow");
  assert.equal(defaultPin.requested, "shadow");
  assert.equal(defaultPin.digest, AUTONOMOUS_DEFAULT_DIGEST);
  const effective = effectiveRouting(undefined, "autonomous");
  assert.ok(effective.mode === "shadow");
  assert.equal(policyDigest(effective), AUTONOMOUS_DEFAULT_DIGEST);
  assert.equal(policyDigest(effective, "shadow"), policyDigest(effective));
});

test("an auto pin needs a saved auto mode or the autonomous default, and a period end", () => {
  // The autonomous default with a stored end pins auto, and its digest is the auto digest of the same policy.
  const defaultAuto = pinRouting(undefined, "autonomous", lineup, PERIOD_END);
  assert.ok(defaultAuto);
  assert.equal(defaultAuto.mode, "auto");
  assert.equal(defaultAuto.requested, "auto");
  assert.equal(defaultAuto.source, "autonomous-default");
  assert.equal(defaultAuto.periodEndedAt, PERIOD_END);
  const effective = effectiveRouting(undefined, "autonomous");
  assert.ok(effective.mode === "shadow");
  assert.equal(defaultAuto.digest, policyDigest(effective, "auto"));
  assert.notEqual(defaultAuto.digest, policyDigest(effective));
  // A saved auto mode pins auto with an end, in either autonomy.
  for (const autonomy of ["autonomous", "supervised"] as const) {
    const savedAuto = pinRouting({ mode: "auto" }, autonomy, lineup, PERIOD_END);
    assert.ok(savedAuto);
    assert.equal(savedAuto.mode, "auto");
    assert.equal(savedAuto.requested, "auto");
    assert.equal(savedAuto.source, "saved");
    assert.equal(savedAuto.periodEndedAt, PERIOD_END);
  }
  // A saved policy with no mode keeps its own knobs and source, and the autonomous project's default decides the mode.
  const savedNoMode = pinRouting({ allowContributor: true }, "autonomous", lineup, PERIOD_END);
  assert.ok(savedNoMode);
  assert.equal(savedNoMode.mode, "auto");
  assert.equal(savedNoMode.requested, "auto");
  assert.equal(savedNoMode.source, "saved");
  assert.equal(savedNoMode.knobs.allowContributor, true);
  assert.equal(savedNoMode.periodEndedAt, PERIOD_END);
  assert.deepEqual(pinRouting({ allowContributor: true }, "supervised", lineup, PERIOD_END), pinRouting({ allowContributor: true }, "supervised", lineup));
  // With an end, these give step 1's result: a saved shadow, a supervised project without a policy, points without start, no lineup.
  for (const [saved, autonomy, l, points] of [
    [{ mode: "shadow" }, "autonomous", lineup, "start"],
    [undefined, "supervised", lineup, "start"],
    [{ mode: "auto", points: ["escalation"] }, "autonomous", lineup, "escalation"],
    [{ mode: "auto" }, "autonomous", undefined, "start"],
  ] as const) {
    assert.deepEqual(pinRouting(saved, autonomy, l, PERIOD_END), pinRouting(saved, autonomy, l), `${points} ${autonomy}`);
  }
  assert.equal(pinRouting(undefined, "supervised", lineup, PERIOD_END), undefined);
  // With no end, the autonomous default keeps step 1's shadow pin, byte for byte.
  const noEnd = pinRouting(undefined, "autonomous", lineup);
  assert.ok(noEnd);
  assert.equal(noEnd.mode, "shadow");
  assert.equal(noEnd.requested, "shadow");
  assert.equal(noEnd.source, "autonomous-default");
  assert.equal(noEnd.digest, AUTONOMOUS_DEFAULT_DIGEST);
  assert.equal("periodEndedAt" in noEnd, false);
});

/** SHA-256 hex of the digest's canonical form at one algorithm version, over the knobs a pin stores. */
function digestAt(version: number, mode: "shadow" | "auto", knobs: RoutingKnobs): string {
  return createHash("sha256").update(canonicalJson({ algorithmVersion: version, rewardVersion: 1, mode, knobs })).digest("hex");
}

test("a pin names version 2 only when its points list escalation or scout", () => {
  for (const saved of [{ mode: "auto" }, { mode: "shadow" }] as const) {
    const plain = pinRouting(saved, "supervised", lineup, PERIOD_END);
    assert.ok(plain);
    assert.equal(plain.algorithmVersion, 1, JSON.stringify(saved));
    assert.equal(plain.digest, digestAt(1, plain.mode, plain.knobs), JSON.stringify(saved));
  }
  const listed: [RoutingPoint[], RoutingPoint[]][] = [
    [["start", "escalation"], ["start", "escalation"]],
    [["start", "scout"], ["start", "scout"]],
    [["scout", "start", "escalation"], ["start", "escalation", "scout"]],
  ];
  for (const saved of [{ mode: "auto" }, { mode: "shadow" }] as const) {
    for (const [points, ordered] of listed) {
      const pin = pinRouting({ ...saved, points }, "supervised", lineup, PERIOD_END);
      assert.ok(pin, JSON.stringify({ saved, points }));
      assert.equal(pin.algorithmVersion, 2, JSON.stringify({ saved, points }));
      assert.deepEqual(pin.knobs.points, ordered);
      assert.equal(pin.digest, digestAt(2, pin.mode, { ...pin.knobs, points: ordered }), JSON.stringify({ saved, points }));
    }
  }
  assert.equal(pinRouting({ mode: "auto", points: ["escalation"] }, "supervised", lineup, PERIOD_END), undefined);
});

test("the digest changes with every knob and with nothing else", () => {
  const base = effectiveRouting({ mode: "shadow" }, "supervised");
  assert.ok(base.mode === "shadow");
  const digest = policyDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const changed: Partial<RoutingKnobs>[] = [
    { points: ["start", "escalation"] }, { cascade: true }, { successValueUsd: 3 }, { maxExploreShare: 0.3 },
    { exploreWindow: 60 }, { minSpareAttempts: 5 }, { allowContributor: true }, { listWeight: 0.5 }, { headroomWeight: 2 },
  ];
  assert.equal(changed.length, allKnobs.length);
  for (const knob of changed) {
    const other = effectiveRouting({ mode: "shadow", ...knob }, "supervised");
    assert.ok(other.mode === "shadow");
    assert.notEqual(policyDigest(other), digest, JSON.stringify(knob));
  }
  const ordered = effectiveRouting({ mode: "shadow", points: ["escalation", "start"] }, "supervised");
  const repeated = effectiveRouting({ mode: "shadow", points: ["start", "escalation", "start"] }, "supervised");
  const plain = effectiveRouting({ mode: "shadow", points: ["start", "escalation"] }, "supervised");
  assert.ok(ordered.mode === "shadow" && repeated.mode === "shadow" && plain.mode === "shadow");
  assert.equal(policyDigest(ordered), policyDigest(plain));
  assert.equal(policyDigest(repeated), policyDigest(plain));
  // A saved policy whose knobs equal the autonomous defaults hashes like the default, whatever its source.
  const fromSaved = effectiveRouting({ mode: "shadow", cascade: true }, "supervised");
  const fromDefault = effectiveRouting(undefined, "autonomous");
  assert.ok(fromSaved.mode === "shadow" && fromDefault.mode === "shadow");
  assert.equal(policyDigest(fromSaved), policyDigest(fromDefault));
  assert.equal(policyDigest(fromDefault), createHash("sha256").update(canonicalJson({ algorithmVersion: 1, rewardVersion: 1, mode: "shadow", knobs: AUTONOMOUS_DEFAULTS })).digest("hex"));
});
