import assert from "node:assert/strict";
import test from "node:test";
import { decisionChoices, formatDecisionAnswer } from "../apps/web/src/decision-answer.js";

test("formats multiple-choice answers in the host's numbered-line contract", () => {
  assert.equal(formatDecisionAnswer(["CSV", "JSON"], "multiple"), "1. CSV\n2. JSON");
});

test("keeps a single-choice answer as raw text", () => {
  assert.equal(formatDecisionAnswer(["CSV"], "single"), "CSV");
});

test("lists the recommended answers first and keeps the rest in the question's order", () => {
  assert.deepEqual(decisionChoices(["North", "South", "East"], ["East"]), ["East", "North", "South"]);
  assert.deepEqual(decisionChoices(["North", "South", "East"], ["East", "North"], "multiple"), ["East", "North", "South"]);
  assert.deepEqual(decisionChoices(["North", "South"]), ["North", "South"]);
});

test("an approval question keeps approve first and deny second, whatever the agent recommends", () => {
  assert.deepEqual(decisionChoices(["Approve the merge", "Deny"], ["Deny"], "approval"), ["Approve the merge", "Deny"]);
});

test("a question without options offers the agent's own answer once", () => {
  assert.deepEqual(decisionChoices([], ["Use the staging bucket", "Use the staging bucket"]), ["Use the staging bucket"]);
  assert.deepEqual(decisionChoices([], ["Use the staging bucket"], "approval"), ["Use the staging bucket"]);
  assert.deepEqual(decisionChoices([]), []);
});
