import assert from "node:assert/strict";
import test from "node:test";
import { formatDecisionAnswer } from "../apps/web/src/decision-answer.js";

test("formats multiple-choice answers in the host's numbered-line contract", () => {
  assert.equal(formatDecisionAnswer(["CSV", "JSON"], "multiple"), "1. CSV\n2. JSON");
});

test("keeps a single-choice answer as raw text", () => {
  assert.equal(formatDecisionAnswer(["CSV"], "single"), "CSV");
});
