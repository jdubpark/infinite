import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cappedBytes, objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const RUN_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const AT = "2026-11-14T10:00:00.000Z";
const VERDICT_ID = "2b7e1c90-5d3a-4f8e-a1b2-c3d4e5f60718";

const parses = (value: unknown) => objectiveRecordSchema.safeParse(value).success;
const withDigest = (record: any) => ({ ...record, digest: recordDigest(record) });

function validGoalRecord(): any {
  return withDigest({
    schemaVersion: 1,
    owner: { kind: "goal", goalId: GOAL_ID },
    version: 2,
    statement: {
      objective: "Ship the record slice.",
      directions: [{ id: "s1", text: "Keep the record beside the goal.", source: "steering", at: AT }],
    },
    definitions: [{ id: "d1", term: "record", meaning: "The sealed objective record." }],
    constraints: { allowedPaths: ["packages/host/src"], excludedPaths: [], rules: [] },
    nonGoals: [],
    ownerEvidence: [],
    criteria: [{
      id: "c0", origin: "owner", statement: "The owner objective is met.",
      check: { kind: "judgement", item: "owner-text" }, producer: "evaluator", threshold: { kind: "pass" }, state: "active",
    }],
    assumptions: [],
    questions: [],
    rubricVersion: 1,
    log: [
      { seq: 1, at: AT, version: 1, actor: "host", authority: "receipt", op: "record.created", target: "c0" },
      { seq: 2, at: AT, version: 2, actor: "owner", authority: "direction", op: "direction.appended", target: "s1" },
    ],
  });
}

function validRunRecord(): any {
  return withDigest({
    schemaVersion: 1,
    owner: { kind: "run", runId: RUN_ID },
    version: 1,
    statement: { objective: "Run the planned slice.", directions: [] },
    definitions: [],
    constraints: { allowedPaths: ["."], excludedPaths: [], rules: [] },
    nonGoals: [],
    ownerEvidence: [],
    criteria: [{
      id: "c0", origin: "owner", statement: "", statementOf: "objective",
      check: { kind: "judgement", item: "owner-text" }, producer: "evaluator", threshold: { kind: "pass" }, state: "active",
    }],
    assumptions: [],
    questions: [],
    rubricVersion: 1,
    log: [{ seq: 1, at: AT, version: 1, actor: "host", authority: "receipt", op: "record.created", target: "c0" }],
  });
}

function criterionOf(check: unknown, producer: string, threshold: unknown, extra: Record<string, unknown> = {}): any {
  return { id: "c1", origin: "owner", statement: "A check.", check, producer, threshold, state: "active", ...extra };
}

function assumptionOf(id: string, test: unknown, extra: Record<string, unknown> = {}): any {
  return {
    id, statement: "A claim.", status: "assumed", origin: "member", criticality: "plan", refutedBy: "Not yet.",
    test, evidence: [], proposals: [], ...extra,
  };
}

test("a goal record and a run record parse unchanged", () => {
  for (const record of [validGoalRecord(), validRunRecord()]) {
    const parsed = objectiveRecordSchema.parse(record);
    assert.deepEqual(parsed, record);
  }
  const goal: any = validGoalRecord();
  assert.ok(!parses({ ...goal, unknown: true }), "an unknown top-level key must fail");
  const inCriterion = structuredClone(goal);
  inCriterion.criteria[0].unknown = true;
  assert.ok(!parses(withDigest(inCriterion)), "an unknown criterion key must fail");
  const inLog = structuredClone(goal);
  inLog.log[0].unknown = true;
  assert.ok(!parses(withDigest(inLog)), "an unknown log key must fail");
});

test("a criterion's producer and threshold fit its check", () => {
  const goal = validGoalRecord();
  const withCriterion = (criterion: unknown) => withDigest({ ...goal, criteria: [goal.criteria[0], criterion] });
  const fits: unknown[] = [
    criterionOf({ kind: "command", command: "npm test" }, "host", { kind: "pass" }),
    criterionOf({ kind: "receipt", receipt: "merged" }, "host", { kind: "pass" }),
    criterionOf({ kind: "artifact", path: "docs/entries.json", count: "/entries" }, "host", { kind: "count", min: 10, max: 25 }),
    criterionOf({ kind: "artifact", path: "docs/spec.md" }, "host", { kind: "pass" }),
    criterionOf({ kind: "citation-form", path: "docs/spec.md", entries: "/entries", perEntry: 1 }, "host", { kind: "share", min: 1 }),
    criterionOf({ kind: "judgement", item: "method-applied" }, "evaluator", { kind: "pass" }),
    criterionOf({ kind: "owner-rating", subject: "quality" }, "owner", { kind: "score", min: 4, of: 5 }),
  ];
  for (const criterion of fits) assert.ok(parses(withCriterion(criterion)), JSON.stringify(criterion));

  const fails: unknown[] = [
    criterionOf({ kind: "judgement", item: "method-applied" }, "host", { kind: "pass" }),
    criterionOf({ kind: "command", command: "npm test" }, "evaluator", { kind: "pass" }),
    criterionOf({ kind: "command", command: "npm test" }, "coordinator", { kind: "pass" }),
    criterionOf({ kind: "command", command: "npm test" }, "host", { kind: "count", min: 1 }),
    criterionOf({ kind: "artifact", path: "docs/entries.json", count: "/entries" }, "host", { kind: "pass" }),
    criterionOf({ kind: "artifact", path: "docs/entries.json", count: "/entries" }, "host", { kind: "count", min: 5, max: 4 }),
    criterionOf({ kind: "artifact", path: "docs/entries.json", count: "/entries" }, "host", { kind: "count" }),
  ];
  for (const criterion of fails) assert.ok(!parses(withCriterion(criterion)), JSON.stringify(criterion));
});

test("c0 is the owner's text", () => {
  const goal = validGoalRecord();
  const withC0 = (patch: Record<string, unknown>) => {
    const copy = structuredClone(goal);
    Object.assign(copy.criteria[0], patch);
    return withDigest(copy);
  };
  const noC0 = structuredClone(goal);
  noC0.criteria = [];
  assert.ok(!parses(withDigest(noC0)), "a goal without c0 must fail");
  const twoC0 = structuredClone(goal);
  twoC0.criteria.push(structuredClone(goal.criteria[0]));
  assert.ok(!parses(withDigest(twoC0)), "two c0 must fail");
  assert.ok(!parses(withC0({ origin: "derived", derivedFrom: "record" })), "a derived c0 must fail");
  assert.ok(!parses(withC0({ state: "retired" })), "a retired c0 must fail");
  assert.ok(!parses(withC0({ check: { kind: "judgement", item: "method-applied" } })), "c0 on another item must fail");
  assert.ok(!parses(withC0({ statementOf: "objective" })), "statementOf on a goal c0 must fail");
  assert.ok(parses(withC0({ statement: "é".repeat(8000) })), "a goal c0 of 16,000 bytes must pass");
  assert.ok(!parses(withC0({ statement: "é".repeat(8000) + "a" })), "a goal c0 of 16,001 bytes must fail");

  const run = validRunRecord();
  const runC0 = (patch: Record<string, unknown>) => {
    const copy = structuredClone(run);
    Object.assign(copy.criteria[0], patch);
    return withDigest(copy);
  };
  assert.ok(!parses(runC0({ statement: "x" })), "a run c0 with text must fail");
  assert.ok(!parses(runC0({ statementOf: undefined })), "a run c0 without statementOf must fail");
  const extraStatementOf = structuredClone(goal);
  extraStatementOf.criteria.push(criterionOf({ kind: "command", command: "npm test" }, "host", { kind: "pass" }, { statementOf: "objective" }));
  assert.ok(!parses(withDigest(extraStatementOf)), "statementOf on c1 must fail");
});

test("a derived criterion quotes the statement", () => {
  const goal = validGoalRecord();
  const derived = (derivedFrom: unknown, origin = "derived") => withDigest({
    ...goal,
    criteria: [goal.criteria[0], { ...criterionOf({ kind: "command", command: "npm test" }, "host", { kind: "pass" }, { origin }), derivedFrom }],
  });
  assert.ok(parses(derived("record")), "a substring of the objective passes");
  assert.ok(parses(derived("Keep the record beside")), "a substring of a direction passes");
  assert.ok(!parses(derived("not in the record")), "a non-substring fails");
  assert.ok(!parses(derived(undefined)), "a derived criterion without derivedFrom fails");
  assert.ok(!parses(derived("é".repeat(250) + "a")), "501 bytes fails");
  assert.ok(!parses(derived("record", "owner")), "an owner criterion with derivedFrom fails");
});

test("the record's caps hold", () => {
  const goal = validGoalRecord();
  const derivedCriterion = (i: number) => ({
    ...criterionOf({ kind: "command", command: "npm test" }, "host", { kind: "pass" }, { origin: "derived", derivedFrom: "record" }),
    id: `c${i}`, statement: "A derived check.",
  });
  const withCriteria = (criteria: unknown[]) => withDigest({ ...goal, criteria: [goal.criteria[0], ...criteria] });
  const retired = (i: number) => ({ ...derivedCriterion(i), state: "retired" });

  const activeSeven = Array.from({ length: 7 }, (_, i) => derivedCriterion(i + 1));
  assert.ok(parses(withCriteria([...activeSeven, retired(8), retired(9), retired(10)])), "8 active and 3 retired pass");
  const activeEight = Array.from({ length: 8 }, (_, i) => derivedCriterion(i + 1));
  assert.ok(!parses(withCriteria(activeEight)), "9 active fails");

  const assumptions = (count: number) => Array.from({ length: count }, (_, i) => assumptionOf(`a${i}`, { kind: "owner" }));
  assert.ok(!parses(withDigest({ ...goal, assumptions: assumptions(33) })), "33 assumptions fail");
  assert.ok(parses(withDigest({ ...goal, assumptions: assumptions(32) })), "32 assumptions pass");

  const questions = (open: number, answered: number) => [
    ...Array.from({ length: open }, (_, i) => ({ id: `q${i}`, text: "Which?", assumptions: [], waits: false, state: "open" })),
    ...Array.from({ length: answered }, (_, i) => ({ id: `qa${i}`, text: "Which?", assumptions: [], waits: false, state: "answered" })),
  ];
  assert.ok(!parses(withDigest({ ...goal, questions: questions(9, 0) })), "9 open questions fail");
  assert.ok(parses(withDigest({ ...goal, questions: questions(8, 2) })), "8 open and 2 answered pass");

  const definitions = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `d${i}`, term: "term", meaning: "meaning" }));
  assert.ok(!parses(withDigest({ ...goal, definitions: definitions(17) })), "17 definitions fail");
  const rules = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, text: "rule" }));
  assert.ok(!parses(withDigest({ ...goal, constraints: { ...goal.constraints, rules: rules(17) } })), "17 rules fail");
  const directions = Array.from({ length: 41 }, (_, i) => ({ id: `s${i + 1}`, text: "Direction.", source: "steering", at: AT }));
  assert.ok(!parses(withDigest({ ...goal, statement: { ...goal.statement, directions } })), "41 directions fail");
  assert.ok(!parses(withDigest({ ...goal, nonGoals: [{ id: "c1", text: "Not this." }], criteria: [goal.criteria[0], derivedCriterion(1)] })), "a shared id fails");
  assert.ok(!parses(withDigest({ ...goal, questions: [{ id: "q1", text: "Which?", assumptions: ["a404"], waits: false, state: "open" }] })), "an unknown assumption fails");

  const capped = (target: number) => {
    const record = structuredClone(goal);
    record.constraints.excludedPaths = Array.from({ length: 32 }, (_, i) => `${"a".repeat(298)}${String(i).padStart(2, "0")}`);
    record.definitions = Array.from({ length: 16 }, (_, i) => ({ id: `d${i}`, term: "term", meaning: "m".repeat(1000) }));
    record.constraints.rules = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, text: "x".repeat(1000) }));
    const probe = structuredClone(record);
    probe.constraints.rules.push({ id: "r5", text: "x" });
    const length = 1 + target - cappedBytes(probe);
    assert.ok(length >= 1 && length <= 1000, `last rule length ${length} is out of range`);
    record.constraints.rules.push({ id: "r5", text: "x".repeat(length) });
    return record;
  };
  assert.equal(cappedBytes(capped(32768)), 32768);
  assert.ok(parses(withDigest(capped(32768))), "32,768 capped bytes pass");
  const over = withDigest(capped(32769));
  assert.equal(cappedBytes(over), 32769);
  const overResult = objectiveRecordSchema.safeParse(over);
  assert.ok(!overResult.success, "32,769 capped bytes fail");
  assert.ok(JSON.stringify(overResult.error?.issues).includes("objective-too-large"));
});

test("owner text does not count against the cap", () => {
  const goal = validGoalRecord();
  goal.statement.objective = "é".repeat(12000);
  goal.statement.directions = Array.from({ length: 20 }, (_, i) => ({ id: `s${i + 1}`, text: "d".repeat(8000), source: "steering", at: AT }));
  goal.nonGoals = Array.from({ length: 20 }, (_, i) => ({ id: `n${i + 1}`, text: "n".repeat(1000) }));
  goal.ownerEvidence = Array.from({ length: 20 }, () => "e".repeat(2000));
  goal.criteria[0].statement = "é".repeat(8000);
  const big = withDigest(goal);
  assert.ok(parses(big), "a goal with the largest owner text parses");
  assert.ok(cappedBytes(big) < 2048, `cappedBytes was ${cappedBytes(big)}`);

  const paths = validGoalRecord();
  paths.constraints.allowedPaths = Array.from({ length: 32 }, () => "é".repeat(300));
  assert.ok(cappedBytes(paths) < 30720, `cappedBytes was ${cappedBytes(paths)}`);
});

test("the log is ordered and ends at the record's version", () => {
  const entry = (seq: number, version: number, extra: Record<string, unknown> = {}) => ({
    seq, at: AT, version, actor: "host", authority: "receipt", op: "record.created", target: "c0", ...extra,
  });
  const withLog = (log: unknown[], version = 2) => {
    const record: any = validGoalRecord();
    record.version = version;
    record.log = log;
    return withDigest(record);
  };

  assert.ok(!parses(withLog([])), "an empty log fails");
  assert.ok(!parses(withLog([entry(1, 1), entry(1, 2)])), "seq 1 then 1 fails");
  assert.ok(!parses(withLog([entry(1, 1), entry(2, 3)])), "versions 1 then 3 fail");
  assert.ok(!parses(withLog([entry(1, 2), entry(2, 1)])), "versions 2 then 1 fail");
  assert.ok(!parses(withLog([entry(1, 1), entry(2, 2)], 3)), "a last version of 2 on a record of version 3 fails");
  assert.ok(!parses(withLog(Array.from({ length: 401 }, (_, i) => entry(i + 1, 2)))), "401 entries fail");
  const big = Array.from({ length: 130 }, (_, i) => entry(i + 1, 2, { after: { inline: "x".repeat(2000) } }));
  assert.ok(!parses(withLog(big)), "a log of over 256 KiB fails");
  assert.ok(!parses(withLog([entry(1, 2, { after: { inline: "x".repeat(2047) } })])), "an inline value of 2,049 canonical bytes fails");
  assert.ok(!parses(withLog([entry(1, 2, { after: { ref: "ev:1", digest: "a".repeat(64), bytes: 2048 } })])), "a ref value of 2,048 bytes fails");
  assert.ok(parses(withLog([entry(1, 1), entry(2, 2), entry(3, 2), entry(4, 3)], 3)), "versions 1, 2, 2, 3 on version 3 pass");
});

test("a stored digest must match", () => {
  const goal: any = validGoalRecord();
  const changed = (mutate: (record: any) => void) => {
    const copy = structuredClone(goal);
    mutate(copy);
    return copy;
  };
  assert.ok(!parses(changed(r => { r.statement.objective = "Changed."; })), "the objective");
  assert.ok(!parses(changed(r => { r.statement.directions[0].text = "Changed."; })), "a direction");
  assert.ok(!parses(changed(r => { r.criteria[0].statement = "Changed."; })), "c0");
  assert.ok(!parses(changed(r => { r.rubricVersion = 2; })), "rubricVersion");
  assert.equal(recordDigest({ ...goal, log: [] }), goal.digest, "the log is outside the digest");
  assert.equal(recordDigest({ ...goal, digest: "0".repeat(64) }), goal.digest, "the digest is outside the digest");
  const reversed = Object.fromEntries(Object.entries(goal).reverse());
  assert.equal(recordDigest(reversed as any), goal.digest, "key order is outside the digest");
});

test("assumptions and questions keep their rules", () => {
  const goal = validGoalRecord();
  const withAssumptions = (assumptions: unknown[]) => withDigest({ ...goal, assumptions });
  const handles = (count: number) => Array.from({ length: count }, (_, i) => `ev:${i + 1}`);
  const proposal = { entryId: "p1", stance: "supports", summary: "A summary.", authorRole: "reviewer" };

  assert.ok(!parses(withAssumptions([assumptionOf("a1", { kind: "owner" }, { status: "verified", evidence: [] })])), "verified with no evidence fails");
  assert.ok(parses(withAssumptions([assumptionOf("a1", { kind: "owner" }, { status: "refuted", evidence: ["ev:1"] })])), "refuted with one handle passes");
  assert.ok(!parses(withAssumptions([assumptionOf("a1", { kind: "owner" }, { status: "refuted", evidence: handles(17) })])), "17 handles fail");
  assert.ok(!parses(withAssumptions([assumptionOf("a1", { kind: "owner" }, { proposals: Array.from({ length: 9 }, () => proposal) })])), "9 proposals fail");

  const tests = [
    { kind: "command", command: "npm test", refutesOn: "fail" },
    { kind: "artifact", path: "docs/entries.json", count: "/entries", threshold: { kind: "count", min: 1 } },
    { kind: "citation", source: "docs/spec.md", quote: "a quote", refutesOn: "absent" },
    { kind: "owner", rating: { subject: "quality", below: 3 } },
  ];
  assert.ok(parses(withAssumptions(tests.map((test, i) => assumptionOf(`a${i + 1}`, test)))), "each test kind parses");
});

test("team prompts never import the record", () => {
  const importsOf = (file: string) => {
    const source = readFileSync(new URL(`../packages/host/src/${file}`, import.meta.url), "utf8");
    return [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]);
  };
  for (const file of ["team-prompts.ts", "team-mcp.ts"]) {
    const specifiers = importsOf(file);
    assert.ok(specifiers.length > 0, `${file} has imports`);
    for (const specifier of specifiers) assert.ok(!specifier.includes("objective"), `${file} imports ${specifier}`);
  }
});
