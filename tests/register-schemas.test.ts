import test from "node:test";
import assert from "node:assert/strict";
import { registerPin } from "../packages/host/src/objective-digest.js";
import { RECORD_DIGEST_BYTES, RECORD_REGISTER_BYTES, recordDigestBytes, recordDigestSchema, registerDigestBytes, registerDigestSchema, teamProjectSchema } from "../packages/host/src/team-types.js";

const checks = [{ command: "node", args: ["check.js"] }];

/** The digest below on the base commit, captured before the register existed. */
const BASE_JSON = '{"version":2,"criteria":[{"id":"c0","statement":"","check":"judgement:owner-text","producer":"evaluator"},{"id":"c1","statement":"Tests pass.","check":"command:npm test","producer":"host"}]}';
const BASE_BYTES = 190;
const baseDigest = { version: 2, criteria: [
  { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" },
  { id: "c1", statement: "Tests pass.", check: "command:npm test", producer: "host" },
] };

const entry = (id: string, statement = `Statement ${id}.`) => ({ id, statement, check: "judgement:owner-text", producer: "owner" as const });
/** Criteria whose bytes sum to exactly RECORD_DIGEST_BYTES, as in tests/objective-digest.test.ts. */
const padded = (pad: number) => ({ version: 2, criteria: [entry("c0", ""), ...Array.from({ length: 5 }, (_, index) => entry(`c${index + 1}`, "x".repeat(1000))), entry("c6", "y".repeat(pad))] });

test("the register setting stands alone and pins only plain runs", () => {
  // Parsing: the key takes "on" or "off", and nothing else.
  assert.ok(teamProjectSchema.safeParse({ checks, objective: { register: "on" } }).success, "register on parses");
  assert.ok(teamProjectSchema.safeParse({ checks, objective: { register: "off", intentCheck: "off" } }).success, "register off with the intent check parses");
  assert.equal(teamProjectSchema.safeParse({ checks, objective: { register: "maybe" } }).success, false, "any other value is refused");
  assert.equal(teamProjectSchema.safeParse({ checks, objective: { registers: "on" } }).success, false, "an unknown key is refused");

  // The pin: only a plain run of a project whose setting is "on".
  const plain = { mission: false, handoff: false };
  assert.equal(registerPin({ setting: "on", ...plain }), true, "a plain run of an on project pins the register");
  assert.equal(registerPin({ ...plain }), false, "an absent setting does not pin");
  assert.equal(registerPin({ setting: "off", ...plain }), false, "an off setting does not pin");
  assert.equal(registerPin({ setting: "on", mission: true, handoff: false }), false, "a mission subteam does not pin");
  assert.equal(registerPin({ setting: "on", mission: false, handoff: true }), false, "a handoff run does not pin");

  // The digest: its own 6,144-byte budget, which ten 500-byte assumptions fit and eleven do not.
  const assumption = (n: number, statement: string) => ({ id: `a${n}`, status: "unchecked", criticality: "plan", statement });
  const ten = { assumptions: Array.from({ length: 10 }, (_, index) => assumption(index + 1, "x".repeat(500))), questions: [] };
  const eleven = { assumptions: Array.from({ length: 11 }, (_, index) => assumption(index + 1, "x".repeat(500))), questions: [] };
  assert.ok(registerDigestBytes(ten as never) <= RECORD_REGISTER_BYTES, "ten 500-byte assumptions fit");
  assert.ok(registerDigestSchema.safeParse(ten).success, "ten 500-byte assumptions parse");
  assert.ok(registerDigestBytes(eleven as never) > RECORD_REGISTER_BYTES, "eleven 500-byte assumptions are over the budget");
  assert.equal(registerDigestSchema.safeParse(eleven).success, false, "a register over 6,144 bytes is refused");
  const one = (statement: string) => ({ assumptions: [assumption(1, statement)], questions: [] });
  assert.equal(registerDigestSchema.safeParse(one("x".repeat(501))).success, false, "a 501-byte statement is refused");
  assert.equal(registerDigestSchema.safeParse(one("")).success, false, "an empty statement is refused");
  assert.equal(registerDigestSchema.safeParse({ assumptions: [], questions: [{ id: "q1", text: "y".repeat(1001) }] }).success, false, "a 1,001-byte question is refused");
});

test("a register digest fits beside a full criteria digest, and an absent one changes nothing", () => {
  // Six KiB of criteria, sized as in tests/objective-digest.test.ts, plus a maximal register.
  let atCap = 0;
  for (let pad = 1; pad <= 1000 && !atCap; pad += 1) if (Buffer.byteLength(JSON.stringify(padded(pad))) === RECORD_DIGEST_BYTES) atCap = pad;
  assert.ok(atCap > 0, "a criteria digest of exactly 6,144 bytes exists");
  const register = {
    assumptions: Array.from({ length: 32 }, (_, index) => ({ id: `a${index + 1}`, status: "unchecked", criticality: "plan", statement: "s" })),
    questions: Array.from({ length: 8 }, (_, index) => ({ id: `q${index + 1}`, text: "q" })),
  };
  assert.ok(registerDigestBytes(register as never) <= RECORD_REGISTER_BYTES, "the maximal register is within its budget");
  assert.ok(recordDigestSchema.safeParse({ ...padded(atCap), register }).success, "a full criteria digest with a maximal register parses");

  // A digest without a register keeps today's bytes, and so does a digest with one, because the register is not counted.
  assert.equal(JSON.stringify(baseDigest), BASE_JSON, "a digest without a register is byte for byte the base digest");
  assert.equal(recordDigestBytes(baseDigest), BASE_BYTES, "its byte count is the base count");
  assert.equal(recordDigestBytes({ ...baseDigest, register: { assumptions: [], questions: [] } } as never), BASE_BYTES, "a register does not count against the criteria budget");
  assert.ok(recordDigestSchema.safeParse(baseDigest).success, "the base digest parses without a register");
});
