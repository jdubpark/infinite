import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ASSESSMENT_LABEL, REMOTE_CRITERIA_NOTE, awaitsProvisionalAnswer, countsText, criterionState, newestVerdictId, ownerOutcomeLabel, resultText, type AssessedGoal } from "../apps/mobile/src/features/teams/goal-verdicts.ts";
import type { GoalAssessment } from "../apps/mobile/src/api/client.ts";

const assessment = (overrides: Partial<GoalAssessment> = {}): GoalAssessment => ({
  verdictId: "11111111-1111-4111-8111-111111111111", revision: 1, head: "a".repeat(40), kind: "reviewed", result: "met",
  counts: { met: 3, notMet: 0, inconclusive: 1, pendingOwner: 1 }, criteria: [], at: "2026-11-21T10:00:00.000Z", progress: 2, ...overrides,
});
const cycle = (n: number, value?: GoalAssessment) => ({ teamId: `team-${n}`, cycle: n, goalRevision: 1, status: "ready-for-review", startedAt: "2026-11-21T09:00:00.000Z", memberCount: 3, assessment: value });
const goal = (overrides: Partial<AssessedGoal> = {}) => ({ status: "ready-for-review", stopReason: "provisional-met", cycles: [cycle(1, assessment())], ...overrides }) as Pick<AssessedGoal, "stopReason" | "status" | "cycles">;

test("the phone labels every agent result as provisional and never as achieved", () => {
  assert.equal(ASSESSMENT_LABEL, "Agent assessment, provisional");
  assert.equal(resultText(assessment()), "Result: Met");
  assert.equal(resultText(assessment({ evaluatorResult: "not-met" })), "Result: Met · The evaluator’s own result: Not met");
  assert.equal(countsText(assessment().counts), "3 met · 0 not met · 1 inconclusive · 1 waiting for you");
  assert.equal(criterionState("pending-owner"), "Waiting for you");
  assert.ok(!/achieved|done|passed|verified/i.test([resultText(assessment()), countsText(assessment().counts), criterionState("met")].join(" ")));
});

test("only an owner outcome that answers an assessment reads as your assessment", () => {
  assert.equal(ownerOutcomeLabel({ verdictId: assessment().verdictId }, "Achieved"), "Your assessment: Achieved");
  assert.equal(ownerOutcomeLabel({}, "Achieved"), "Achieved");
});

test("a goal waits for the owner's answer only after a provisional stop with an assessment", () => {
  assert.equal(awaitsProvisionalAnswer(goal()), true);
  assert.equal(awaitsProvisionalAnswer(goal({ status: "achieved" })), false);
  assert.equal(awaitsProvisionalAnswer(goal({ stopReason: "deadline" })), false);
  assert.equal(awaitsProvisionalAnswer(goal({ stopReason: undefined })), false);
  assert.equal(awaitsProvisionalAnswer(goal({ cycles: [cycle(1)] })), false);
});

test("the answer names the newest assessed cycle", () => {
  const newest = assessment({ verdictId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(newestVerdictId([cycle(1, assessment()), cycle(2, newest), cycle(3)]), newest.verdictId);
  assert.equal(newestVerdictId([cycle(1)]), undefined);
});

test("remote mobile criteria note explains the remote boundary honestly without calling verdicts", () => {
  assert.match(REMOTE_CRITERIA_NOTE, /per-criterion/i);
  assert.match(REMOTE_CRITERIA_NOTE, /unavailable over remote access/i);
  assert.match(REMOTE_CRITERIA_NOTE, /web client/i);
  assert.match(REMOTE_CRITERIA_NOTE, /infinite goal verdicts/);
  assert.ok(!/achieved|done|passed|verified/i.test(REMOTE_CRITERIA_NOTE));
  const detailSource = readFileSync(new URL("../apps/mobile/src/features/teams/GoalDetail.tsx", import.meta.url), "utf8");
  assert.ok(!/\/verdicts\b/.test(detailSource));
});
