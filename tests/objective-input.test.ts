import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { createGoalSchema } from "../packages/host/src/goal-types.js";
import { CORRECTION_LIMITS, commandDigest, correctionSchema, criterionInputSchema, parseGoalCreateBody } from "../packages/host/src/objective-input.js";
import { TeamError } from "../packages/host/src/team-workspace.js";

const REQUEST = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const judgement = { kind: "judgement", item: "method-applied" };
const criterion = (overrides: Record<string, unknown> = {}) => ({ statement: "The method is applied.", check: judgement, threshold: { kind: "pass" }, ...overrides });
const correction = (ops: unknown[], version = 2) => ({ requestId: REQUEST, version, ops });
const parsesCriterion = (value: unknown) => criterionInputSchema.safeParse(value).success;
const parsesCorrection = (value: unknown) => correctionSchema.safeParse(value).success;

test("inputs are checked strictly", () => {
  assert.equal(CORRECTION_LIMITS.ops, 16);
  assert.ok(parsesCriterion(criterion()), "a judgement criterion parses");
  assert.ok(parsesCriterion(criterion({ producer: "evaluator" })), "a producer from the three values parses");
  assert.ok(!parsesCriterion(criterion({ statement: "x".repeat(1001) })), "a statement of 1,001 bytes fails");
  assert.ok(!parsesCriterion(criterion({ statement: "é".repeat(501) })), "a statement of 1,002 bytes fails");
  assert.ok(!parsesCriterion(criterion({ statement: "" })), "an empty statement fails");
  assert.ok(!parsesCriterion(criterion({ extra: true })), "an unknown key fails");
  assert.ok(!parsesCriterion(criterion({ check: { kind: "artifact", path: "docs/spec.md", schema: "spec" } })), "an artifact schema fails");
  assert.ok(!parsesCriterion(criterion({ pinned: [] })), "a pinned field fails");
  assert.ok(!parsesCriterion(criterion({ producer: "coordinator" })), "producer coordinator fails");

  assert.ok(parsesCorrection(correction([{ op: "criterion.retire", id: "c1" }])), "one retire parses");
  assert.ok(!parsesCorrection(correction(Array.from({ length: 17 }, (_, index) => ({ op: "criterion.confirm", id: `c${index + 1}` })))), "17 ops fail");
  assert.ok(!parsesCorrection(correction([{ op: "criterion.retire", id: "c1" }, { op: "criterion.confirm", id: "c1" }])), "two ops on c1 fail");
  assert.ok(!parsesCorrection(correction([{ op: "criterion.edit", id: "c1" }])), "an edit with no field fails");
  assert.ok(!parsesCorrection(correction([{ op: "criterion.retire", id: "c1", statement: "x" }])), "a retire with a statement fails");
  assert.ok(!parsesCorrection(correction([{ op: "criterion.retire", id: "c1" }], 0)), "version 0 fails");
  assert.ok(!parsesCorrection(correction([{ op: "criterion.retire", id: "c1" }], 1_000_001)), "version 1,000,001 fails");
  assert.ok(!parsesCorrection({ ...correction([{ op: "criterion.retire", id: "c1" }]), extra: true }), "an unknown key fails");
  assert.ok(!parsesCorrection(correction([{ op: "criterion.retire", id: "C1" }])), "an uppercase id fails");

  const command = criterionInputSchema.parse(criterion({ check: { kind: "command", run: { command: "npm" } }, threshold: { kind: "pass" } }));
  assert.deepEqual(command.check, { kind: "command", run: { command: "npm", args: [] } }, "a command with no args parses with args []");
});

test("a command digest is stable and bound to its arguments", () => {
  const digest = commandDigest({ command: "npm", args: ["test"] });
  assert.equal(digest, commandDigest({ command: "npm", args: ["test"] }));
  assert.notEqual(digest, commandDigest({ command: "npm", args: ["test", "--x"] }));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, createHash("sha256").update(canonicalJson({ command: "npm", args: ["test"] })).digest("hex"));
});

test("the goal create body keeps criteria apart", () => {
  const goal = {
    requestId: REQUEST, projectId: "infinite", title: "Ship the record", objective: "Ship the record slice.",
    successCriteria: "The record slice ships.", maxRuns: 2,
  };
  const creation = { statement: "Lint passes.", check: { kind: "command", run: { command: "npm", args: ["run", "lint"] } }, threshold: { kind: "pass" } };

  const split = parseGoalCreateBody({ ...goal, criteria: [creation] });
  assert.deepEqual(split.goal, createGoalSchema.parse(goal), "the goal parses as the body without criteria");
  assert.equal(split.criteria?.length, 1);
  assert.equal(split.criteria?.[0]?.check.kind, "command");
  assert.equal(parseGoalCreateBody(goal).criteria, undefined, "a body without criteria gives criteria undefined");

  const refusal = (body: unknown): TeamError => {
    try {
      parseGoalCreateBody(body);
    } catch (error) {
      assert.ok(error instanceof TeamError, "the refusal is a TeamError");
      return error;
    }
    assert.fail("the body was accepted");
  };
  for (const error of [
    refusal({ ...goal, criteria: Array.from({ length: 8 }, () => creation) }),
    refusal({ ...goal, criteria: [{ ...creation, statement: "Ship the record slice." }, { ...creation, statement: "" }] }),
    refusal({ ...goal, criteria: [{ ...creation, check: { kind: "command", run: { command: "npm", args: "lint" } } }] }),
  ]) {
    assert.equal(error.status, 400);
    assert.equal(error.code, "objective-op-invalid");
    assert.ok(!error.message.includes("Ship the record"), "the message holds no input text");
  }
});
