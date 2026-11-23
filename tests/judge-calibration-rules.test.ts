import test from "node:test";
import assert from "node:assert/strict";
import {
  calibrationSummary, judgeWeight, pairAgrees, pairCorrect, preferredResolved, wilsonLower,
  type OrderingResult,
} from "../packages/host/src/judge-calibration-rules.js";

const resolved: OrderingResult = { resolvedIsA: true, preferred: "A" };
const resolvedSwapped: OrderingResult = { resolvedIsA: false, preferred: "B" };
const unresolved: OrderingResult = { resolvedIsA: true, preferred: "B" };
const tie: OrderingResult = { resolvedIsA: true, preferred: "tie" };
const failure: OrderingResult = { resolvedIsA: true, preferred: null };
const near = (value: number | null, expected: number) =>
  assert.ok(value !== null && Math.abs(value - expected) < 1e-6, `${value} is not near ${expected}`);

function pairs(correct: number, total: number) {
  return Array.from({ length: total }, (_, index) => index < correct
    ? { first: resolved, second: resolvedSwapped }
    : { first: unresolved, second: resolvedSwapped });
}

test("23 correct pairs of 30 is not ok", () => {
  const summary = calibrationSummary(pairs(23, 30));
  assert.equal(summary.state, "not-ok");
  near(summary.lowerBound, 0.590713);
});

test("24 correct pairs of 30 is ok", () => {
  const summary = calibrationSummary(pairs(24, 30));
  assert.equal(summary.state, "ok");
  near(summary.lowerBound, 0.62694);
  assert.equal(summary.accuracy, 0.8);
});

test("29 pairs is never ok", () => {
  assert.equal(calibrationSummary(pairs(29, 29)).state, "not-ok");
});

test("the bound is clamped and tracks n", () => {
  assert.equal(wilsonLower(0, 30), 0);
  near(wilsonLower(30, 30), 0.886483);
  near(wilsonLower(32, 40), 0.652424);
  near(wilsonLower(26, 40), 0.495056);
});

test("a pair needs both orderings for the resolved trial", () => {
  assert.equal(pairCorrect(resolved, tie), false);
  assert.equal(pairCorrect(resolved, failure), false);
  assert.equal(pairCorrect(resolved, { resolvedIsA: false, preferred: "A" }), false);
  assert.equal(pairCorrect(resolved, resolvedSwapped), true);
  assert.equal(preferredResolved(tie), null);
  assert.equal(preferredResolved(failure), null);
  assert.equal(preferredResolved(unresolved), false);
});

test("an always-A judge scores no correct pair", () => {
  const first = { resolvedIsA: true, preferred: "A" } as const;
  const second = { resolvedIsA: false, preferred: "A" } as const;
  assert.equal(pairCorrect(first, second), false);
  assert.equal(pairAgrees(first, second), false);
});

test("swap agreement counts consistent pairs", () => {
  const first = { resolvedIsA: true, preferred: "B" } as const;
  const second = { resolvedIsA: false, preferred: "A" } as const;
  assert.equal(pairAgrees(first, second), true);
  assert.equal(pairCorrect(first, second), false);
  assert.equal(pairAgrees(tie, tie), false);
});

test("accuracy 0.8 weighs 0.6", () => {
  assert.ok(Math.abs(judgeWeight(0.8) - 0.6) < 1e-12);
  assert.equal(judgeWeight(0.5), 0);
  assert.equal(judgeWeight(0.3), 0);
});

test("no counted pair has no accuracy", () => {
  const summary = calibrationSummary([]);
  assert.equal(summary.accuracy, null);
  assert.equal(summary.lowerBound, null);
  assert.equal(summary.swapAgreement, null);
  assert.equal(summary.state, "not-ok");
});
