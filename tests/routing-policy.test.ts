import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { AUTONOMOUS_DEFAULTS, ROUTING_DEFAULTS, effectiveRouting, pinRouting, policyDigest, teamRoutingSchema } from "../packages/host/src/routing-policy.js";
import type { RoutingKnobs } from "../packages/host/src/routing-types.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";

const lineup = {} as unknown as TeamLineup;
const allKnobs = ["points", "cascade", "successValueUsd", "maxExploreShare", "exploreWindow", "minSpareAttempts", "allowContributor", "listWeight", "headroomWeight"] as const;

test("the policy schema takes each knob and refuses the rest", () => {
  const atBounds = {
    mode: "auto", points: ["start", "escalation", "scout"], cascade: true, successValueUsd: 100, maxExploreShare: 0.5,
    exploreWindow: 500, minSpareAttempts: 20, allowContributor: true, listWeight: 1, headroomWeight: 4,
  };
  assert.deepEqual(teamRoutingSchema.parse(atBounds), atBounds);
  for (const bad of [
    { successValueUsd: 100.01 }, { maxExploreShare: 0.51 }, { exploreWindow: 9 }, { minSpareAttempts: 21 },
    { listWeight: 1.1 }, { headroomWeight: 4.1 }, { points: [] }, { unknown: true }, { mode: "on" },
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
  assert.equal(defaulted.mode === "shadow" && defaulted.knobs.cascade, true);
  assert.deepEqual(effectiveRouting(undefined, "supervised"), { mode: "off" });
  const valued = effectiveRouting({ successValueUsd: 8 }, "autonomous");
  assert.ok(valued.mode === "shadow" && valued.source === "saved");
  assert.ok(valued.mode === "shadow" && valued.knobs.successValueUsd === 8);
  assert.ok(valued.mode === "shadow" && !valued.defaults.includes("successValueUsd"));
  assert.deepEqual(effectiveRouting({ successValueUsd: 8 }, "supervised"), { mode: "off" });
});

test("a pin needs shadow, the start point, and a lineup", () => {
  assert.equal(pinRouting({ mode: "off" }, "autonomous", lineup), undefined);
  assert.equal(pinRouting({ mode: "shadow", points: ["escalation"] }, "autonomous", lineup), undefined);
  assert.equal(pinRouting({ mode: "shadow" }, "autonomous", undefined), undefined);
  const pin = pinRouting({ mode: "shadow" }, "supervised", lineup);
  assert.ok(pin);
  assert.equal(pin.mode, "shadow");
  assert.equal(pin.algorithmVersion, 1);
  assert.equal(pin.rewardVersion, 1);
  assert.equal(Object.keys(pin.knobs).length, 9);
  const effective = effectiveRouting({ mode: "shadow" }, "supervised");
  assert.ok(effective.mode === "shadow");
  assert.equal(pin.digest, policyDigest(effective));
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
