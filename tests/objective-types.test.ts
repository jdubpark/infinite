import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import ts from "typescript";
import { createGoalSchema, goalSteerSchema, type ProductGoal } from "../packages/host/src/goal-types.js";
import { INTENT_REPORT_LIMITS, intentCheckReportSchema } from "../packages/host/src/intent-report.js";
import { CORRECTION_LIMITS } from "../packages/host/src/objective-input.js";
import { applyIntentReport } from "../packages/host/src/objective-intent.js";
import { CORRECTION_LOG } from "../packages/host/src/objective-ops.js";
import { PROPOSAL_LIMITS } from "../packages/host/src/objective-proposals.js";
import { goalRecord, runRecord } from "../packages/host/src/objective-record.js";
import { OBJECTIVE_LIMITS, cappedBytes, logValueOf, objectiveRecordSchema, producerOf, recordDigest, thresholdFits } from "../packages/host/src/objective-types.js";
import { SHARED_INPUT_LIMITS } from "../packages/host/src/schema-primitives.js";
import { RECORD_LABEL_BYTES, createTeamSchema, recordDigestSchema, teamContinueSchema, teamGoalContextSchema, teamMutationSchema, teamTaskPlanSchema, type TeamRun } from "../packages/host/src/team-types.js";
import { VERDICT_LIMITS } from "../packages/host/src/verdict-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const RUN_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const AT = "2026-11-14T10:00:00.000Z";
const VERDICT_ID = "2b7e1c90-5d3a-4f8e-a1b2-c3d4e5f60718";

const parses = (value: unknown) => objectiveRecordSchema.safeParse(value).success;
const withDigest = (record: any) => ({ ...record, digest: recordDigest(record) });
function withHistory(record: any): any {
  const steered = record.statement.directions.filter((item: any) => item.source === "steering");
  record.log = [record.log[0], ...steered.map((item: any, index: number) => ({
    seq: index + 2, at: AT, version: index + 2, actor: "owner", authority: "direction", op: "direction.appended", target: item.id,
    after: logValueOf(item, `record:direction:${item.id}`),
  }))];
  record.version = record.log[record.log.length - 1].version;
  return record;
}

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
      { seq: 2, at: AT, version: 2, actor: "owner", authority: "direction", op: "direction.appended", target: "s1",
        after: { inline: { id: "s1", text: "Keep the record beside the goal.", source: "steering", at: AT } } },
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
    criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "host", { kind: "pass" }),
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
    criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "evaluator", { kind: "pass" }),
    criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "coordinator", { kind: "pass" }),
    criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "host", { kind: "count", min: 1 }),
    criterionOf({ kind: "command", command: "npm test" }, "host", { kind: "pass" }),
    criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a0" }, "host", { kind: "pass" }),
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
  extraStatementOf.criteria.push(criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "host", { kind: "pass" }, { statementOf: "objective" }));
  assert.ok(!parses(withDigest(extraStatementOf)), "statementOf on c1 must fail");
});

test("a derived criterion quotes the statement", () => {
  const goal = validGoalRecord();
  const derived = (derivedFrom: unknown, origin = "derived") => withDigest({
    ...goal,
    criteria: [goal.criteria[0], { ...criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "host", { kind: "pass" }, { origin }), derivedFrom }],
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
    ...criterionOf({ kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }, "host", { kind: "pass" }, { origin: "derived", derivedFrom: "record" }),
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
  const big = withDigest(withHistory(goal));
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
    record.statement.directions = [];
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
    { kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", refutesOn: "fail" },
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

test("a record's direction history agrees with its directions", () => {
  const history = (mutate?: (record: any) => void, texts = ["Prefer seed stage.", "Exclude current holdings."]) => {
    const record: any = validGoalRecord();
    record.statement.directions = texts.map((text, index) => ({ id: `s${index + 2}`, text, source: "steering", at: AT }));
    withHistory(record);
    mutate?.(record);
    return withDigest(record);
  };
  const large = ["é".repeat(2000), "Exclude current holdings."];

  assert.ok(parses(history()), "the unchanged record passes");
  assert.ok(parses(history(undefined, large)), "a direction of 2,000 é logged by reference passes");
  assert.ok("ref" in history(undefined, large).log[1].after, "that direction is logged by reference");
  assert.ok(!parses(history(r => { r.log[2].target = "s2"; })), "a version-3 entry that targets s2 fails");
  assert.ok(!parses(history(r => { r.log[1].after.inline.text = "Changed."; })), "a changed inline text fails");
  assert.ok(!parses(history(r => { r.log.splice(2, 1); r.version = 2; })), "a steering direction with no entry fails");
  assert.ok(!parses(history(r => { r.log.push({ ...r.log[2], seq: 4 }); })), "a doubled entry fails");
  assert.ok(!parses(history(r => {
    [r.log[1], r.log[2]] = [{ ...r.log[2], seq: r.log[1].seq, version: r.log[1].version }, { ...r.log[1], seq: r.log[2].seq, version: r.log[2].version }];
  })), "swapped entries fail");
  assert.ok(!parses(history(r => { r.log[1].after.digest = "0".repeat(64); }, large)), "a reference with a wrong digest fails");
  assert.ok(!parses(history(r => { r.log[2].version = r.log[1].version; r.version = r.log[1].version; })), "two direction entries at one version fail");
  assert.ok(!parses(history(r => { r.log[1].version = 1; })), "a direction entry at version 1 fails");
});

test("producer and threshold rules are shared", () => {
  const command = { kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" } as const;
  const judgement = { kind: "judgement", item: "method-applied" } as const;
  const owner = { kind: "owner-rating", subject: "quality" } as const;
  const artifact = { kind: "artifact", path: "docs/entries.json", count: "/entries" } as const;
  const citations = { kind: "citations", path: "docs/spec.md", entries: "/entries", perEntry: 1 } as const;
  assert.equal(producerOf(command), "host");
  assert.equal(producerOf({ kind: "receipt", receipt: "merged" }), "host");
  assert.equal(producerOf(artifact), "host");
  assert.equal(producerOf(citations), "host");
  assert.equal(producerOf(judgement), "evaluator");
  assert.equal(producerOf(owner), "owner");

  assert.equal(thresholdFits(artifact, { kind: "count", min: 1 }), true);
  assert.equal(thresholdFits(artifact, { kind: "pass" }), false, "an artifact with a count takes a count threshold only");
  assert.equal(thresholdFits({ kind: "artifact", path: "docs/spec.md" }, { kind: "pass" }), true);
  assert.equal(thresholdFits({ kind: "artifact", path: "docs/spec.md" }, { kind: "count", min: 1 }), false);
  assert.equal(thresholdFits(citations, { kind: "share", min: 1 }), true);
  assert.equal(thresholdFits(citations, { kind: "pass" }), false);
  assert.equal(thresholdFits(owner, { kind: "score", min: 4, of: 5 }), true);
  assert.equal(thresholdFits(owner, { kind: "share", min: 1 }), false);
  assert.equal(thresholdFits(command, { kind: "pass" }), true);
  assert.equal(thresholdFits(judgement, { kind: "count", min: 1 }), false);
  const receipt = { kind: "receipt", receipt: "merged" } as const;
  const citationForm = { kind: "citation-form", path: "docs/spec.md", entries: "/entries", perEntry: 1 } as const;
  assert.equal(thresholdFits(receipt, { kind: "pass" }), true);
  assert.equal(thresholdFits(receipt, { kind: "count", min: 1 }), false, "a receipt takes a pass threshold only");
  assert.equal(thresholdFits(citationForm, { kind: "share", min: 1 }), true);
  assert.equal(thresholdFits(citationForm, { kind: "pass" }), false, "a citation form takes a share threshold only");
  assert.equal(thresholdFits(citationForm, { kind: "count", min: 1 }), false);

  const record: any = validGoalRecord();
  record.criteria[0].producer = "host";
  const result = objectiveRecordSchema.safeParse(withDigest(record));
  assert.equal(result.success, false, "a judgement criterion with producer host fails the record");
  assert.ok(result.error?.issues.some(issue => issue.message === "A criterion's producer must fit its check"), "with the shared message");
});

test("the record digest schema holds c0 exactly once, first", () => {
  const criterion = (id: string) => ({ id, statement: "Ship it", check: "receipt:checks-passed", producer: "host" });
  const c0 = { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" };
  assert.equal(recordDigestSchema.safeParse({ version: 2, criteria: [c0, criterion("c1")] }).success, true);
  assert.equal(recordDigestSchema.safeParse({ version: 2, criteria: [criterion("c1"), c0] }).success, false, "c0 is not first");
  assert.equal(recordDigestSchema.safeParse({ version: 2, criteria: [c0, criterion("c0")] }).success, false, "a second c0 is refused");
});

test("OBJECTIVE_LIMITS caps align with API schemas and storage budgets", () => {
  const L = OBJECTIVE_LIMITS;
  const API = SHARED_INPUT_LIMITS;

  assert.ok(L.goalObjectiveChars >= API.goalObjectiveChars);
  assert.ok(L.runObjectiveChars >= API.runObjectiveChars);
  assert.ok(L.c0Bytes >= API.goalSuccessCriteriaChars * 3);
  assert.ok(L.nonGoals >= API.nonGoals);
  assert.ok(L.nonGoalChars >= API.nonGoalChars);
  assert.ok(L.allowedPaths >= API.allowedPaths);
  assert.ok(L.excludedPaths >= API.allowedPaths);
  assert.ok(L.pathChars >= API.pathChars);
  assert.ok(L.ownerEvidence >= API.evidence);
  assert.ok(L.evidenceChars >= API.evidenceChars);
  assert.ok(L.directionChars >= API.steeringChars);
  assert.ok(L.directions >= API.steeringEntries * 2);

  assert.ok(L.criteria >= L.activeCriteria);
  assert.ok(L.questions >= L.openQuestions);
  assert.ok(L.questionAssumptions <= L.assumptions);
  assert.equal(CORRECTION_LIMITS.creationCriteria, L.activeCriteria - 1);
  assert.equal(CORRECTION_LIMITS.criterionCanonicalBytes, L.inlineValueBytes);
  assert.ok(CORRECTION_LOG.entries + API.steeringEntries <= L.logEntries);
  assert.ok(CORRECTION_LOG.bytes < L.logBytes);
  assert.ok(PROPOSAL_LIMITS.log.entries < CORRECTION_LOG.entries);
  assert.ok(PROPOSAL_LIMITS.log.bytes < CORRECTION_LOG.bytes);
  assert.ok(PROPOSAL_LIMITS.cappedBytes < L.cappedBytes);
  assert.ok(PROPOSAL_LIMITS.assumptions <= L.assumptions);
  assert.equal(PROPOSAL_LIMITS.addedPerEntry, L.newAssumptionsPerAttempt);
  assert.equal(INTENT_REPORT_LIMITS.items, L.intentItems);
  assert.equal(INTENT_REPORT_LIMITS.scouts, L.scoutQuestions);
  assert.equal(INTENT_REPORT_LIMITS.criteria, L.activeCriteria);
  assert.equal(INTENT_REPORT_LIMITS.outOfScope, L.openFollowUps);
  assert.equal(INTENT_REPORT_LIMITS.statementBytes, L.assumptionBytes);
  assert.equal(INTENT_REPORT_LIMITS.refutedByBytes, L.assumptionBytes);
  assert.equal(INTENT_REPORT_LIMITS.criterionBytes, L.inlineValueBytes);
  assert.equal(VERDICT_LIMITS.criteria, L.activeCriteria);
  assert.equal(VERDICT_LIMITS.noteBytes, L.noteBytes);
  assert.equal(VERDICT_LIMITS.labelBytes, RECORD_LABEL_BYTES);

  const maxIntentReport = intentCheckReportSchema.parse({
    kind: "intent-check",
    summary: "Maximal intent question bounds check.",
    items: [{
      dimension: "d".repeat(INTENT_REPORT_LIMITS.dimensionBytes),
      why: "w".repeat(INTENT_REPORT_LIMITS.whyBytes),
      criticality: "outcome",
      disposition: "ask",
      assumption: {
        statement: "a".repeat(INTENT_REPORT_LIMITS.statementBytes),
        refutedBy: "r".repeat(INTENT_REPORT_LIMITS.refutedByBytes),
        test: { kind: "owner" },
      },
      question: {
        text: "q".repeat(INTENT_REPORT_LIMITS.questionBytes),
        options: Array.from({ length: INTENT_REPORT_LIMITS.options }, () => "o".repeat(INTENT_REPORT_LIMITS.optionBytes)),
        default: "f".repeat(INTENT_REPORT_LIMITS.defaultBytes),
      },
    }],
  });
  const intentApplied = applyIntentReport(validGoalRecord(), maxIntentReport, {
    runId: RUN_ID,
    revision: 1,
    checkerMemberId: "checker-1",
    decisionId: GOAL_ID,
    mode: "supervised",
    goal: true,
    configured: [],
    at: AT,
  });
  assert.equal(intentApplied.added.questions.length, 1);
  assert.equal(intentApplied.dropped.cap, 0);
  assert.equal(intentApplied.dropped.shape, 0);
  const formattedQuestion = intentApplied.record.questions.find(item => item.id === intentApplied.added.questions[0]);
  assert.ok(formattedQuestion);
  assert.ok(Buffer.byteLength(formattedQuestion.text, "utf8") <= L.questionBytes);
  assert.ok(objectiveRecordSchema.safeParse(intentApplied.record).success);

  const maxGoalInput = createGoalSchema.parse({
    requestId: GOAL_ID,
    projectId: "infinite",
    title: "Maximal goal",
    objective: "o".repeat(API.goalObjectiveChars),
    successCriteria: "\u20ac".repeat(API.goalSuccessCriteriaChars),
    nonGoals: Array.from({ length: API.nonGoals }, () => "n".repeat(API.nonGoalChars)),
    allowedPaths: Array.from({ length: API.allowedPaths }, (_, index) => `${"\u20ac".repeat(API.pathChars - 2)}${String(index).padStart(2, "0")}`),
    evidence: Array.from({ length: API.evidence }, () => "e".repeat(API.evidenceChars)),
  });
  const maxGoalSteering = Array.from({ length: API.steeringEntries }, (_, index) => {
    const parsed = goalSteerSchema.parse({ requestId: GOAL_ID, revision: index + 1, text: "s".repeat(API.steeringChars) });
    return { text: parsed.text, revision: parsed.revision, at: AT };
  });
  const builtGoal = goalRecord({ ...maxGoalInput, id: GOAL_ID, steering: maxGoalSteering } as unknown as ProductGoal, AT, "created");
  assert.notEqual(builtGoal, "source-invalid");
  if (builtGoal !== "source-invalid") {
    assert.ok(objectiveRecordSchema.safeParse(builtGoal).success);
    assert.ok(cappedBytes(builtGoal) < 30 * 1024);
    assert.ok(cappedBytes(builtGoal) <= L.cappedBytes);
  }

  const escapedControlGoal = createGoalSchema.parse({
    requestId: GOAL_ID,
    projectId: "infinite",
    title: "Escaped control paths",
    objective: "Track JSON-escaped control path cap.",
    successCriteria: "Fail closed at cappedBytes.",
    allowedPaths: Array.from({ length: 20 }, (_, index) => `${"\u0001".repeat(288)}${String(index).padStart(2, "0")}`),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(escapedControlGoal), "utf8") <= API.goalPayloadBytes);
  assert.equal(goalRecord({ ...escapedControlGoal, id: GOAL_ID, steering: [] } as unknown as ProductGoal, AT, "created"), "source-invalid");

  const maxTeamInput = createTeamSchema.parse({
    requestId: RUN_ID,
    projectId: "infinite",
    provider: "claude",
    title: "Maximal run",
    objective: "r".repeat(API.runObjectiveChars),
  });
  const maxRunSteering = Array.from({ length: API.steeringEntries }, (_, index) => {
    const parsed = teamMutationSchema.parse({ requestId: RUN_ID, revision: index + 1, text: "t".repeat(API.steeringChars) });
    return { text: parsed.text, revision: parsed.revision, at: AT };
  });
  assert.ok(teamContinueSchema.safeParse({ requestId: RUN_ID, revision: 1, text: "c".repeat(API.steeringChars) }).success);
  assert.ok(teamGoalContextSchema.safeParse({
    id: GOAL_ID,
    revision: 1,
    cycle: 1,
    successCriteria: "s".repeat(API.goalContextSuccessCriteriaChars),
    nonGoals: maxGoalInput.nonGoals,
    allowedPaths: maxGoalInput.allowedPaths,
    evidence: maxGoalInput.evidence,
    previousWork: [],
    deadlineAt: AT,
    maxMembers: 10,
  }).success);
  assert.ok(teamTaskPlanSchema.safeParse({
    id: "t1",
    title: "Max paths",
    instructions: "Do work.",
    paths: maxGoalInput.allowedPaths,
    dependsOn: [],
  }).success);
  const builtRun = runRecord({ id: RUN_ID, objective: maxTeamInput.objective, steering: maxRunSteering } as unknown as TeamRun, AT, "member-1");
  assert.notEqual(builtRun, "source-invalid");
  if (builtRun !== "source-invalid") assert.ok(objectiveRecordSchema.safeParse(builtRun).success);
});

test("shared schema modules have zero runtime circular imports", () => {
  const parseSource = (relativeFile: string) => {
    const source = readFileSync(new URL(`../packages/host/src/${relativeFile}`, import.meta.url), "utf8");
    return ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  };
  const resolveLocal = (relativeFile: string, specifier: string) =>
    posix.normalize(posix.join(dirname(relativeFile), specifier.replace(/\.js$/, ".ts")));
  const runtimeImportsOf = (relativeFile: string): string[] => {
    const file = parseSource(relativeFile);
    const edges: string[] = [];
    for (const stmt of file.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith(".")) {
        const clause = stmt.importClause;
        if (!clause) {
          edges.push(resolveLocal(relativeFile, stmt.moduleSpecifier.text));
          continue;
        }
        if (clause.isTypeOnly) continue;
        const hasRuntimeBinding = clause.name !== undefined
          || (clause.namedBindings !== undefined && (
            ts.isNamespaceImport(clause.namedBindings)
            || clause.namedBindings.elements.some(element => !element.isTypeOnly)
          ));
        if (hasRuntimeBinding) edges.push(resolveLocal(relativeFile, stmt.moduleSpecifier.text));
        continue;
      }
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith(".")) {
        if (stmt.isTypeOnly) continue;
        const hasRuntimeExport = !stmt.exportClause
          || ts.isNamespaceExport(stmt.exportClause)
          || stmt.exportClause.elements.some(element => !element.isTypeOnly);
        if (hasRuntimeExport) edges.push(resolveLocal(relativeFile, stmt.moduleSpecifier.text));
      }
    }
    return edges;
  };
  const anyLocalImportsOf = (relativeFile: string): string[] => {
    const file = parseSource(relativeFile);
    const specifiers: string[] = [];
    const visitNode = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".")) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal) && node.argument.literal.text.startsWith(".")) {
        specifiers.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visitNode);
    };
    visitNode(file);
    return specifiers;
  };

  assert.deepEqual(anyLocalImportsOf("schema-primitives.ts"), []);
  assert.deepEqual(runtimeImportsOf("types.ts"), []);
  assert.deepEqual(runtimeImportsOf("eval-types.ts"), []);

  const roots = [
    "schema-primitives.ts",
    "types.ts",
    "eval-types.ts",
    "eval-config.ts",
    "eval-jobs.ts",
    "eval-trial-jobs.ts",
    "eval-compare-jobs.ts",
    "verdict-types.ts",
    "verdict-store.ts",
    "team-state-schemas.ts",
    "team-types.ts",
    "goal-types.ts",
    "objective-types.ts",
    "objective-input.ts",
    "objective-ops.ts",
    "objective-intent.ts",
    "objective-proposals.ts",
    "evidence/member-proposal.ts",
  ];
  const owned = new Set(roots);
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (file: string) => {
    const current = state.get(file);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(file)), file];
      if (cycle.some(node => owned.has(node))) assert.fail(`Runtime import cycle detected: ${cycle.join(" -> ")}`);
      return;
    }
    state.set(file, "visiting");
    stack.push(file);
    for (const dep of runtimeImportsOf(file)) visit(dep);
    stack.pop();
    state.set(file, "done");
  };
  for (const root of roots) visit(root);
});
