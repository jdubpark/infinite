import test from "node:test";
import assert from "node:assert/strict";
import {
  observe,
  posterior,
  type CurrentConfig,
  type RoutingTarget,
} from "../packages/host/src/routing-posterior.js";
import type { RoutingEvidenceRow } from "../packages/host/src/routing-types.js";

const NOW = "2026-11-15T00:00:00.000Z";
const DAY = 86_400_000;
const TARGET: RoutingTarget = { projectRef: "p", areaRef: "a", kind: null, featureVersion: 1, featureMapRef: "fm", point: "start" };
const CURRENT: CurrentConfig = { epoch: 1, promptVersion: "pv" };

function ago(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY).toISOString();
}

let sequence = 0;

function row(overrides: Partial<RoutingEvidenceRow> = {}): RoutingEvidenceRow {
  sequence++;
  return {
    outcomeId: `o-${String(sequence).padStart(6, "0")}`,
    source: "production",
    projectRef: "p",
    areaRef: "a",
    provider: "provider",
    model: "model",
    effort: null,
    profileEpoch: 1,
    kind: null,
    featureVersion: 1,
    disposition: "integrated",
    exclusion: null,
    flags: [],
    integrated: 1,
    accepted: 1,
    firstPass: 1,
    held: 1,
    endedAt: NOW,
    frozenAt: NOW,
    point: "start",
    featureMapRef: "fm",
    ownerScore: null,
    promptVersion: "pv",
    ...overrides,
  };
}

test("the reward table", () => {
  assert.deepEqual(observe(row({ disposition: "stalled", integrated: 0, accepted: 0, firstPass: 0 }), NOW, 1)?.reward, { r: 0, w: 1 });
  assert.deepEqual(observe(row({ accepted: 0 }), NOW, 1)?.reward, { r: 0, w: 1 });
  assert.deepEqual(observe(row({ accepted: 1, held: 0 }), NOW, 1)?.reward, { r: 0, w: 1 });
  assert.equal(observe(row({ accepted: null, firstPass: 1, held: 1, flags: ["same-model-review"] }), NOW, 1), undefined);
  const rated = observe(row({ ownerScore: 3, held: null, firstPass: 1 }), NOW, 1);
  assert.deepEqual(rated?.reward, { r: 0.5, w: 0.5 });
  assert.deepEqual(rated?.rescue, { x: 1, w: 1 });
  assert.deepEqual(observe(row({ held: null }), NOW, 1)?.reward, { r: 1, w: 0.5 });
  assert.deepEqual(observe(row({ held: null, firstPass: 1 }), NOW, 1)?.rescue, { x: 1, w: 1 });
  assert.deepEqual(observe(row({ held: null, firstPass: 1 }), NOW, 0.5)?.rescue, { x: 1, w: 0.5 });
  assert.deepEqual(observe(row({ held: 1, firstPass: 1 }), NOW, 1)?.reward, { r: 1, w: 1 });
  const notFirst = observe(row({ held: 1, firstPass: 0 }), NOW, 1);
  assert.deepEqual(notFirst?.reward, { r: 0.5, w: 1 });
  assert.deepEqual(notFirst?.rescue, { x: 0, w: 1 });
  const provisional = observe(row({ held: null, firstPass: 1 }), NOW, 1)!.reward!;
  assert.equal(provisional.w * provisional.r, 0.5);
  assert.equal(provisional.w * (1 - provisional.r), 0);
  const withheldHold = observe(row({ held: 0, firstPass: 1 }), NOW, 1)!.reward!;
  assert.equal(withheldHold.w * (1 - withheldHold.r), 1);
});

test("withheld and excluded rows give nothing", () => {
  const withheld = [
    row({ flags: ["backfilled"] }),
    row({ flags: ["gap"] }),
    row({ frozenAt: null }),
  ];
  const excluded = [
    row({ disposition: "open", integrated: null, accepted: null, firstPass: null, held: null }),
    row({ disposition: "limit", exclusion: null }),
    row({ disposition: "owner-stop", exclusion: null }),
    row({ disposition: "host-stop", exclusion: null }),
  ];
  for (const item of [...withheld, ...excluded]) {
    assert.equal(observe(item, NOW, 1), undefined, `${item.outcomeId} gives an observation`);
  }
});

test("time and who-chose weights", () => {
  assert.equal(observe(row({ endedAt: ago(30) }), NOW, 1)?.reward?.w, 0.5);
  assert.equal(observe(row({ endedAt: ago(60) }), NOW, 1)?.reward?.w, 0.25);
  assert.equal(observe(row({ endedAt: ago(181) }), NOW, 1), undefined);
  assert.equal(observe(row({ endedAt: new Date(Date.parse(NOW) + 3_600_000).toISOString() }), NOW, 1)?.reward?.w, 1);
  assert.equal(observe(row({ endedAt: null }), NOW, 1), undefined);
  assert.equal(observe(row({ held: 1, firstPass: 1 }), NOW, 0.5)?.reward?.w, 0.5);

  const old = posterior([row({ endedAt: ago(181) })], TARGET, CURRENT, NOW, 1);
  assert.equal(old.untimed, 0);
  assert.equal(old.rows.production + old.rows.duel, 0);
  const untimed = posterior([row({ endedAt: null })], TARGET, CURRENT, NOW, 1);
  assert.equal(untimed.untimed, 1);
  assert.equal(untimed.rows.production + untimed.rows.duel, 0);
});

test("with no rows every level is Beta(1, 1)", () => {
  const empty = posterior([], TARGET, CURRENT, NOW, 1);
  assert.deepEqual(empty.theta, { a: 1, b: 1 });
  assert.deepEqual(empty.phi, { a: 1, b: 1 });
  assert.equal(empty.level, "none");
  assert.equal(empty.earlierRows, 0);
  assert.equal(empty.untimed, 0);
  for (const record of [...empty.reward, ...empty.rescue]) {
    assert.deepEqual(record.posterior, { a: 1, b: 1 }, `${record.level} is not Beta(1, 1)`);
    assert.equal(record.observed.rows, 0);
  }
});

test("levels hold their own rows", () => {
  const tenant = [
    ...Array.from({ length: 6 }, () => row({ projectRef: "other" })),
    ...Array.from({ length: 2 }, () => row({ projectRef: "other", accepted: 0 })),
  ];
  const project = [
    row({ areaRef: "b" }),
    row({ areaRef: "b", accepted: 0 }),
  ];
  const tenantOnly = posterior(tenant, TARGET, CURRENT, NOW, 1);
  assert.deepEqual(tenantOnly.reward[0]!.posterior, { a: 7, b: 3 });
  assert.equal(tenantOnly.reward[0]!.observed.rows, 8);

  const withProject = posterior([...tenant, ...project], TARGET, CURRENT, NOW, 1);
  assert.deepEqual(withProject.reward[1]!.posterior, { a: 8, b: 4 });
  assert.equal(withProject.reward[1]!.observed.rows, 2);
  assert.deepEqual(withProject.reward[2]!.posterior, { a: 8, b: 4 });
  assert.equal(withProject.reward[2]!.prior.strength, 12);
  assert.equal(withProject.level, "project");

  const large = posterior([
    ...Array.from({ length: 24 }, () => row({ projectRef: "other" })),
    ...Array.from({ length: 6 }, () => row({ projectRef: "other", accepted: 0 })),
  ], TARGET, CURRENT, NOW, 1);
  assert.equal(large.reward[1]!.prior.strength, 20);
  assert.deepEqual(large.reward[1]!.posterior, { a: 15.625, b: 4.375 });

  const mismatched = posterior([
    row({ featureMapRef: "other" }),
    row({ featureVersion: 2 }),
    row({ kind: "k" }),
    row({ areaRef: "b" }),
  ], TARGET, CURRENT, NOW, 1);
  assert.equal(mismatched.reward[2]!.observed.rows, 0);
  assert.equal(mismatched.reward[1]!.observed.rows, 4);
  assert.equal(mismatched.level, "project");

  const matching = posterior([row()], TARGET, CURRENT, NOW, 1);
  assert.equal(matching.reward[2]!.observed.rows, 1);
  assert.equal(matching.level, "cell");

  const other = posterior([row({ point: "escalation" }), row({ point: "escalation", projectRef: "other" })], TARGET, CURRENT, NOW, 1);
  assert.equal(other.rows.production + other.rows.duel, 0);
  assert.equal(other.level, "none");
  for (const record of other.reward) assert.equal(record.observed.rows, 0);
});

test("earlier evidence is capped at a mass of 10", () => {
  const earlier = (count: number, overrides: Partial<RoutingEvidenceRow> = {}) =>
    Array.from({ length: count }, () => row({ projectRef: "other", profileEpoch: 1, ...overrides }));
  const current: CurrentConfig = { epoch: 2, promptVersion: "pv" };

  const forty = posterior(earlier(40), TARGET, current, NOW, 1);
  assert.deepEqual(forty.reward[0]!.posterior, { a: 11, b: 1 });
  assert.equal(forty.reward[0]!.earlier.scale, 0.25);
  assert.equal(forty.reward[0]!.earlier.rows, 40);
  assert.equal(forty.earlierRows, 40);

  const four = posterior(earlier(4), TARGET, current, NOW, 1);
  assert.deepEqual(four.reward[0]!.posterior, { a: 5, b: 1 });

  const mixed = posterior([
    ...earlier(40, { promptVersion: null }),
    row({ projectRef: "other", profileEpoch: 2 }),
  ], TARGET, current, NOW, 1);
  assert.deepEqual(mixed.reward[0]!.posterior, { a: 12, b: 1 });
  assert.equal(mixed.reward[0]!.observed.rows, 1);
  assert.equal(mixed.earlierRows, 40);
});

test("the posterior does not depend on row order", () => {
  let seed = 20261115;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const rows = Array.from({ length: 50 }, (_, index) => row({
    outcomeId: `r-${String(index).padStart(3, "0")}`,
    source: pick(["production", "duel", "legacy"]),
    projectRef: pick(["p", "other"]),
    areaRef: pick(["a", "b"]),
    kind: pick([null, "k"]),
    featureVersion: pick([1, 2]),
    featureMapRef: pick(["fm", "x"]),
    point: pick(["start", "escalation"]),
    profileEpoch: pick([1, 2]),
    promptVersion: pick(["pv", null]),
    disposition: pick(["integrated", "stalled"]),
    accepted: pick([0, 1, null] as const),
    firstPass: pick([0, 1, null] as const),
    held: pick([0, 1, null] as const),
    ownerScore: pick([null, 1, 3, 5]),
    endedAt: ago(Math.floor(random() * 200)),
  }));
  const base = posterior(rows, TARGET, CURRENT, NOW, 1);
  assert.ok(base.rows.production + base.rows.duel + base.earlierRows > 0, "the fixture has no counted rows");
  for (let trial = 0; trial < 200; trial++) {
    const shuffled = [...rows];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
    }
    assert.deepStrictEqual(posterior(shuffled, TARGET, CURRENT, NOW, 1), base, `trial ${trial} differs`);
  }
});

test("legacy rows change nothing", () => {
  const rows = [row(), row({ accepted: 0 }), row({ projectRef: "other", firstPass: 0, held: 1 })];
  const legacy = Array.from({ length: 20 }, () => row({ source: "legacy", areaRef: "a", kind: null }));
  assert.deepStrictEqual(posterior([...rows, ...legacy], TARGET, CURRENT, NOW, 1), posterior(rows, TARGET, CURRENT, NOW, 1));
});

test("a failure's rescue counts zero, the owner rating maps 1 to 0 and 5 to 1, a row 180 days old has weight 0.5^6, and only counted rows are untimed", () => {
  assert.deepEqual(observe(row({ disposition: "stalled", integrated: 0, accepted: 0, firstPass: 0, held: 0 }), NOW, 1)?.rescue, { x: 0, w: 1 });
  assert.deepEqual(observe(row({ ownerScore: 5, held: 1 }), NOW, 1)?.reward, { r: 1, w: 1 });
  assert.deepEqual(observe(row({ ownerScore: 1, held: 1 }), NOW, 1)?.reward, { r: 0, w: 1 });
  assert.deepEqual(observe(row({ ownerScore: 5, held: 0 }), NOW, 1)?.reward, { r: 0, w: 1 });
  assert.equal(observe(row({ endedAt: ago(180) }), NOW, 1)?.reward?.w, 0.5 ** 6);
  assert.equal(posterior([row({ flags: ["gap"], endedAt: null })], TARGET, CURRENT, NOW, 1).untimed, 0);
});

test("earlier evidence is capped at 10 below tenant, a row of another or no prompt version is earlier, phi has its own cap, and rows and level count rewards only", () => {
  const current: CurrentConfig = { epoch: 1, promptVersion: "pv" };
  const cellEarlier = posterior(Array.from({ length: 40 }, () => row({ profileEpoch: 1, promptVersion: "old", held: null })), TARGET, current, NOW, 1);
  assert.deepEqual(cellEarlier.reward[2]!.earlier, { success: 20, failure: 0, rows: 40, scale: 0.5 });
  assert.deepEqual(cellEarlier.theta, { a: 11, b: 1 });
  assert.deepEqual(cellEarlier.rescue[2]!.earlier, { success: 40, failure: 0, rows: 40, scale: 0.25 });
  assert.deepEqual(cellEarlier.phi, { a: 11, b: 1 });
  assert.deepEqual([cellEarlier.level, cellEarlier.earlierRows, cellEarlier.rows], ["none", 40, { production: 0, duel: 0 }]);
  assert.equal(posterior([row({ profileEpoch: 1, promptVersion: null })], TARGET, current, NOW, 1).earlierRows, 1);
  assert.equal(posterior([row({ projectRef: "other" })], TARGET, CURRENT, NOW, 1).level, "tenant");
  const rewardOnly = posterior([row({ accepted: 1, firstPass: null, held: 1 })], TARGET, CURRENT, NOW, 1);
  assert.deepEqual([rewardOnly.level, rewardOnly.rows, rewardOnly.phi], ["cell", { production: 1, duel: 0 }, { a: 1, b: 1 }]);
  assert.deepEqual(posterior([row({ source: "duel" })], TARGET, CURRENT, NOW, 1).rows, { production: 0, duel: 1 });
});

function assertBeta(actual: { a: number; b: number }, expected: { a: number; b: number }): void {
  assert.ok(Math.abs(actual.a - expected.a) <= 1e-12, `a ${actual.a} is not ${expected.a}`);
  assert.ok(Math.abs(actual.b - expected.b) <= 1e-12, `b ${actual.b} is not ${expected.b}`);
}

test("an applied row counts at full weight", () => {
  const applied = row({ outcomeId: "applied-row" });
  assertBeta(posterior([applied], TARGET, CURRENT, NOW, 0.5, new Set(["applied-row"])).theta, { a: 2, b: 1 });
  assertBeta(posterior([applied], TARGET, CURRENT, NOW, 0.5).theta, { a: 1.5, b: 1 });
  assertBeta(posterior([applied], TARGET, CURRENT, NOW, 0.5, new Set(["other-row"])).theta, { a: 1.5, b: 1 });

  const rows = Array.from({ length: 8 }, (_, index) => row({ outcomeId: `ordered-${index}`, accepted: index % 3 === 0 ? 0 : 1 }));
  const chosen = new Set(rows.filter((_, index) => index % 2 === 0).map(item => item.outcomeId));
  assert.deepEqual(posterior([...rows].reverse(), TARGET, CURRENT, NOW, 0.5, chosen), posterior(rows, TARGET, CURRENT, NOW, 0.5, chosen));
});
