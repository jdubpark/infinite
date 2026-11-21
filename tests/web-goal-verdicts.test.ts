import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ASSESSMENT_LABEL, CycleAssessment, ProvisionalStop, countsText, newestVerdictId } from "../apps/web/src/goals";
import type { GoalAssessment, GoalVerdictView } from "../apps/web/src/api";

// The tests run without the web build's JSX transform, so the classic runtime reads React from the global scope.
(globalThis as { React?: unknown }).React = React;

const assessment = (overrides: Partial<GoalAssessment> = {}): GoalAssessment => ({
  verdictId: "11111111-1111-4111-8111-111111111111", revision: 1, head: "a".repeat(40), kind: "reviewed", result: "met",
  counts: { met: 3, notMet: 0, inconclusive: 1, pendingOwner: 1 }, criteria: [], at: "2026-11-21T10:00:00.000Z", progress: 2, ...overrides,
});
const row: GoalVerdictView = {
  cycle: 1, teamId: "team", verdictId: assessment().verdictId, kind: "reviewed", head: "a".repeat(40), at: "2026-11-21T10:00:00.000Z", label: ASSESSMENT_LABEL,
  result: "met", differs: false, counts: assessment().counts, progress: 2, detail: "available",
  criteria: [{ id: "c1", producer: "host", state: "met", label: "host receipt", receipt: { handle: "check", outcome: "pass" } }, { id: "c2", producer: "owner", state: "pending-owner", label: "waiting for you" }],
};
const noop = () => undefined;
const view = (value: GoalAssessment, extra: { row?: GoalVerdictView; loading?: boolean; error?: string } = {}) =>
  renderToStaticMarkup(createElement(CycleAssessment, { assessment: value, row: extra.row, loading: extra.loading ?? false, error: extra.error ?? "", onOpen: noop }));

test("a cycle assessment is labelled provisional and never reads as achieved", () => {
  const html = view(assessment());
  assert.ok(html.includes("Agent assessment, provisional"));
  assert.ok(html.includes("Result: Met"));
  assert.ok(html.includes("3 met · 0 not met · 1 inconclusive · 1 waiting for you"));
  assert.ok(!/achieved|done|passed|verified/i.test(html));
  assert.ok(!html.includes("The evaluator’s own result"));
});

test("a differing evaluator result is shown, and criteria rows only once loaded", () => {
  assert.ok(view(assessment({ evaluatorResult: "not-met" })).includes("The evaluator’s own result: Not met"));
  assert.ok(!view(assessment()).includes("<code>c1</code>"));
  const html = view(assessment(), { row });
  assert.ok(html.includes("<code>c1</code>"));
  assert.ok(html.includes("Host receipt"));
  assert.ok(html.includes("Waiting for you"));
});

test("the provisional stop offers exactly the two owner actions", () => {
  const html = renderToStaticMarkup(createElement(ProvisionalStop, { reason: "Record your assessment.", disabled: false, submit: noop }));
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.ok(html.includes(">Achieved<"));
  assert.ok(html.includes(">Not achieved, continue<"));
  assert.ok(html.includes("Record your assessment."));
});

test("the newest verdict id comes from the newest assessed cycle", () => {
  const older = assessment({ verdictId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(newestVerdictId([{ assessment: older }, {}, { assessment: assessment() }, {}]), assessment().verdictId);
  assert.equal(newestVerdictId([{}, {}]), undefined);
  assert.equal(countsText(assessment().counts), "3 met · 0 not met · 1 inconclusive · 1 waiting for you");
});
