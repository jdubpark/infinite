import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { egressCredential } from "../packages/host/src/egress.js";
import type { CheckInput, Correction, CorrectionOp } from "../packages/host/src/objective-input.js";
import { applyOwnerOps } from "../packages/host/src/objective-ops.js";
import type { OwnerOpContext } from "../packages/host/src/objective-ops.js";
import {
  INTENT_OPS,
  goalRecord,
  rebuildVersion,
  runRecord,
  syncDirections,
} from "../packages/host/src/objective-record.js";
import type { ObjectiveRecord, LogEntry, Threshold } from "../packages/host/src/objective-types.js";
import { objectiveRecordSchema } from "../packages/host/src/objective-types.js";
import type { IntentCheckReport, IntentItem } from "../packages/host/src/intent-report.js";
import {
  INTENT_DEFAULTS_ANSWER,
  answerIntentQuestions,
  applyIntentReport,
  criteriaDue,
  intentApplied,
  intentDecision,
  releaseIntentQuestions,
  screenIntentReport,
  skipIntentCheck,
} from "../packages/host/src/objective-intent.js";
import type { IntentApplyContext, IntentMode } from "../packages/host/src/objective-intent.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import type { TeamCommand, TeamRun } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const RUN_ID = "7a2d3b4f-9c5e-4d6f-8a71-8293a4b5c6d7";
const REQUEST = "8b3e4c5a-0d6f-4e7a-9b82-93a4b5c6d7e8";
const DECISION_1 = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const DECISION_2 = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const CHECKER = "intent-checker-1";
const AT = "2026-11-17T09:00:00.000Z";
const at = (second: number) => new Date(Date.UTC(2026, 10, 17, 9, 0, 0) + second * 1000).toISOString();
const uuidFor = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const LINT: TeamCommand = { command: "npm", args: ["run", "lint"] };
const CONFIGURED: TeamCommand[] = [LINT];
const JUDGEMENT: CheckInput = { kind: "judgement", item: "method-applied" };
const PASS: Threshold = { kind: "pass" };
const OWNER_TEST = { kind: "owner" };
const LINT_TEST = { kind: "command", run: LINT, refutesOn: "fail" };
const OWNER_CONTEXT: OwnerOpContext = { configured: CONFIGURED, requestId: REQUEST, at: AT };

function goalFixture(): ProductGoal {
  return {
    id: GOAL_ID,
    objective: "Find ranked sources for the research brief.",
    successCriteria: "A ranked shortlist with reasons and sources",
    nonGoals: ["no paid sources"],
    allowedPaths: ["research"],
    evidence: ["notes.md"],
    steering: [],
  } as unknown as ProductGoal;
}

/** Version 1 of a goal's record: c0 only, one log entry. */
function v1(): ObjectiveRecord {
  const record = goalRecord(goalFixture(), AT, "created");
  if (typeof record === "string") throw new Error(`the fixture record is ${record}`);
  return record;
}

/** A standalone run's record, whose objective is the run's text. */
function runFixture(): ObjectiveRecord {
  const run = { id: RUN_ID, objective: "Find ranked sources for the research brief.", steering: [] } as unknown as TeamRun;
  const record = runRecord(run, AT, "run-handle");
  if (typeof record === "string") throw new Error(`the run fixture record is ${record}`);
  return record;
}

const normal = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));

function context(overrides: Partial<IntentApplyContext> = {}): IntentApplyContext {
  return {
    runId: RUN_ID, revision: 1, checkerMemberId: CHECKER, decisionId: DECISION_1, mode: "autonomous", goal: true,
    configured: CONFIGURED, at: at(1), ...overrides,
  };
}

function report(items: IntentItem[], extra: Partial<IntentCheckReport> = {}): IntentCheckReport {
  return { kind: "intent-check", summary: "The plan leaves two items open.", items, ...extra };
}

function askItem(dimension: string, options: {
  criticality?: IntentItem["criticality"]; test?: unknown; def?: string; interrupt?: boolean; choices?: string[];
} = {}): IntentItem {
  return {
    dimension, why: `${dimension} changes the result`, criticality: options.criticality ?? "outcome", disposition: "ask",
    assumption: { statement: `${dimension} is the default`, refutedBy: "the owner names another", test: options.test ?? OWNER_TEST },
    question: {
      text: `Which ${dimension}?`,
      options: options.choices ?? [],
      ...(options.interrupt ? { interrupt: "definition" as const } : { default: options.def ?? "the stated default" }),
    },
  } as IntentItem;
}

function assumeItem(dimension: string, criticality: IntentItem["criticality"] = "detail", test: unknown = OWNER_TEST): IntentItem {
  return {
    dimension, why: `${dimension} is settled`, criticality, disposition: "assume",
    assumption: { statement: `${dimension} holds`, refutedBy: "a counter example", test },
  } as IntentItem;
}

function scoutItem(dimension: string): IntentItem {
  return {
    dimension, why: `${dimension} needs a read`, criticality: "detail", disposition: "scout",
    assumption: { statement: `${dimension} is small`, refutedBy: "a large file", test: OWNER_TEST }, scout: "read the file list",
  } as IntentItem;
}

function derived(derivedFrom: string, statement: string) {
  return { derivedFrom, statement, check: JUDGEMENT, threshold: PASS };
}

/** Applies a report and returns the one result, failing the test on a refusal. */
function apply(record: ObjectiveRecord, input: IntentCheckReport, overrides: Partial<IntentApplyContext> = {}) {
  return applyIntentReport(record, input, context(overrides));
}

/** An answer that must be written. */
function answer(record: ObjectiveRecord, decisionId: string, text: string, second: number): ObjectiveRecord {
  const next = answerIntentQuestions(record, { decisionId, runId: RUN_ID, text, at: at(second) });
  assert.ok(next, "the answer is written");
  return next;
}

function lastEntry(record: ObjectiveRecord): LogEntry {
  const entry = record.log[record.log.length - 1];
  assert.ok(entry, "the record has a log entry");
  return entry;
}

function inline(entry: LogEntry, field: "before" | "after"): Record<string, unknown> {
  const value = entry[field];
  assert.ok(value !== undefined && "inline" in value, `the ${field} value is inline`);
  return value.inline as Record<string, unknown>;
}

function refusedWith(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof TeamError, `the refusal is a TeamError, not ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`the call was accepted, expected ${code}`);
}

/** A log padded with skipped entries to `length` entries, all at the record's version. */
function padded(record: ObjectiveRecord, length: number): ObjectiveRecord {
  const log = [...record.log];
  while (log.length < length) {
    log.push({
      seq: (log[log.length - 1]?.seq ?? 0) + 1, at: AT, version: record.version, actor: "host", authority: "receipt",
      op: INTENT_OPS.skipped, target: RUN_ID,
    });
  }
  return { ...record, log };
}

test("acceptance 4: an autonomous detail ask is assumed and logged", () => {
  const result = apply(v1(), report([askItem("scope", { criticality: "detail" })]));
  assert.equal(result.record.version, 2);
  assert.equal(result.record.assumptions.length, 1);
  assert.equal(result.record.assumptions[0]!.status, "assumed");
  assert.equal(result.record.questions.length, 0, "no question opens");
  assert.equal(result.decision, undefined);
  assert.equal(result.converted, 1);
  const entry = intentApplied(result.record, CHECKER);
  assert.ok(entry, "the applied entry names the checker");
  assert.equal(entry.op, INTENT_OPS.applied);
  assert.equal(entry.actor, "intent-check");
  assert.equal(entry.authority, "claim", "the checker's entry is a claim, never a direction");
  assert.equal(intentApplied(result.record, "someone-else"), undefined);
  assert.equal(inline(entry, "after").converted, 1);
});

test("acceptance 3, record side: an outcome ask waits and a scout is assumed", () => {
  const items = [askItem("outcome-x", { criticality: "outcome", interrupt: true }), scoutItem("reading")];
  const autonomous = apply(v1(), report(items));
  const [first, second] = autonomous.record.assumptions;
  assert.equal(first!.status, "unchecked");
  assert.equal(first!.question, "q1");
  assert.equal(second!.status, "assumed");
  assert.equal(autonomous.converted, 1, "the scout is converted");
  const [question] = autonomous.record.questions;
  assert.equal(question!.id, "q1");
  assert.equal(question!.waits, true);
  assert.equal(question!.decisionId, DECISION_1);
  assert.ok(autonomous.decision, "one decision is returned");
  assert.ok(autonomous.decision.question.includes("outcome-x"), "the decision names the dimension");
  assert.deepEqual(autonomous.decision.options, [], "an unchecked item offers no defaults");
  assert.deepEqual(autonomous.decision.questions, ["q1"]);

  const supervised = apply(v1(), report([askItem("outcome-x", { criticality: "outcome", def: "x" })]), { mode: "supervised" });
  assert.equal(supervised.record.questions[0]!.waits, true);
  assert.equal(supervised.record.assumptions[0]!.status, "assumed");
  assert.deepEqual(supervised.decision?.options, [INTENT_DEFAULTS_ANSWER]);
});

test("every item is written down or counted", () => {
  const items: IntentItem[] = [];
  for (let index = 0; index < 13; index += 1) items.push(assumeItem(`fact${index}`));
  items.push(assumeItem("bad-shape", "detail", { kind: "bogus" }));
  items.push(assumeItem("unconfigured", "detail", { kind: "command", run: { command: "rm", args: ["-rf", "docs"] }, refutesOn: "fail" }));
  items.push(assumeItem(`secret ${"gh" + "p_" + "a".repeat(36)}`));
  const input = report(items);
  const record = v1();
  const direct = apply(record, input);
  assert.equal(direct.record.assumptions.length, 13);
  assert.equal(direct.dropped.shape, 1);
  assert.equal(direct.dropped.command, 1);
  assert.equal(direct.dropped.secret, 1);
  assert.equal(direct.dropped.cap, 0);

  const screened = screenIntentReport(input, { statement: { objective: record.statement.objective, directions: [] }, configured: CONFIGURED });
  const viaKept = apply(record, screened.kept, { screened: screened.dropped });
  assert.deepEqual(viaKept.record, direct.record, "the kept report gives the same record");
  assert.deepEqual(viaKept.dropped, direct.dropped);
});

test("secret-shaped items are dropped and never echoed", () => {
  const privateKey = "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----";
  const token = "gh" + "p_" + "b".repeat(36);
  const proxy = egressCredential(randomBytes(32), "project-1", "session-1", Math.floor(Date.now() / 1000) + 3600);
  const proxyUrl = `http://${proxy.username}:${proxy.password}@127.0.0.1:9`;
  const items = [
    assumeItem(`key ${privateKey}`),
    askItem("question", { interrupt: true, choices: [] }),
    scoutItem("scout"),
  ];
  items[1] = { ...items[1]!, question: { text: `Use ${token}?`, options: [], interrupt: "definition" } } as IntentItem;
  items[2] = { ...items[2]!, scout: `read ${proxyUrl}` } as IntentItem;
  const input = report(items, {
    summary: `Summary ${privateKey}`,
    criteria: [derived("ranked", `Ship with ${token}`)],
    outOfScope: [proxyUrl],
  });
  const screened = screenIntentReport(input, { statement: { objective: "Find ranked sources.", directions: [] }, configured: CONFIGURED });
  assert.equal(screened.dropped.secret, 6, "three items, one criterion, one follow-up id, and the summary");
  assert.equal(screened.kept.summary, "Summary withheld: it matched a secret shape.");
  const result = apply(v1(), input);
  for (const text of [privateKey, token, proxyUrl]) {
    assert.equal(JSON.stringify(screened.kept).includes(text), false, "the kept report holds no secret");
    assert.equal(JSON.stringify(result).includes(text), false, "the result holds no secret");
  }
  const again = screenIntentReport(screened.kept, { statement: { objective: "Find ranked sources.", directions: [] }, configured: CONFIGURED });
  assert.deepEqual(Object.values(again.dropped).reduce((sum, count) => sum + count, 0), 0, "screening a kept report drops nothing");
});

test("acceptance 2: a derived criterion must quote the statement", () => {
  const first = apply(v1(), report([], { criteria: [derived("ranked sources", "Rank each source"), derived("unrelated words", "Cite a date")] }));
  const criteria = first.record.criteria.filter(item => item.origin === "derived");
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!.id, "c1");
  assert.equal(criteria[0]!.derivedFrom, "ranked sources");
  assert.equal(first.dropped.quote, 1);
  assert.equal(first.ignored.criteria, 0);

  const standalone = apply(runFixture(), report([], { criteria: [derived("ranked sources", "Rank each source"), derived("ranked", "Rank sources")] }), { goal: false });
  assert.equal(standalone.record.criteria.length, 1, "a standalone run takes no derived criterion");
  assert.equal(standalone.ignored.criteria, 2);

  const second = apply(first.record, report([], { criteria: [derived("ranked sources", "Cite each source")] }), { decisionId: DECISION_2, revision: 2, at: at(2) });
  assert.equal(second.record.criteria.length, first.record.criteria.length, "an unchanged statement is not checked again");
  assert.equal(second.ignored.criteria, 1);

  const owner: Correction["ops"] = [1, 2, 3, 4, 5, 6].map(index => ({ op: "criterion.add", criterion: { statement: `owner ${index}`, check: JUDGEMENT, threshold: PASS } }) as CorrectionOp);
  const full = applyOwnerOps(v1(), { version: 1, ops: owner }, OWNER_CONTEXT);
  const capped = apply(full, report([], { criteria: [derived("ranked", "Rank one"), derived("ranked", "Rank two")] }));
  assert.equal(capped.record.criteria.filter(item => item.state === "active").length, 8);
  assert.equal(capped.dropped.cap, 1, "the second of two is dropped at 8 active criteria");
});

test("criteria are due on the first check and after a statement change", () => {
  const record = v1();
  assert.equal(criteriaDue(record), true);
  const first = apply(record, report([askItem("reading", { interrupt: true })]));
  assert.equal(criteriaDue(first.record), false, "an applied entry with the statement digest is not due");
  const steered = syncDirections(first.record, [{ text: "Also cover blogs", revision: 1, at: at(2) }], at(2));
  assert.notEqual(steered, "source-invalid");
  assert.equal(criteriaDue(steered as ObjectiveRecord), true, "a steering direction makes criteria due again");
  const decided = apply(steered as ObjectiveRecord, report([]), { decisionId: DECISION_2, revision: 2, at: at(3) });
  assert.equal(criteriaDue(decided.record), false);
  const answered = answer(first.record, DECISION_1, "Prefer journals.", 4);
  assert.equal(criteriaDue(answered), true, "an answer direction makes criteria due again");
});

test("a ninth open question closes the oldest that does not wait", () => {
  const first = apply(v1(), report([askItem("first", { interrupt: true })]));
  const seven = [1, 2, 3, 4, 5, 6, 7].map(index => askItem(`d${index}`, { def: "x" }));
  const second = apply(first.record, report(seven), { revision: 2, at: at(2) });
  assert.equal(second.record.questions.filter(item => item.state === "open").length, 8);
  const ninth = apply(second.record, report([askItem("ninth", { def: "y" })]), { revision: 3, at: at(3) });
  const closed = ninth.record.questions.find(item => item.id === "q2")!;
  assert.equal(closed.state, "default-kept");
  assert.equal(closed.waits, false);
  assert.deepEqual(inline(lastEntry(ninth.record), "after").closed, ["q2"]);
  assert.deepEqual(inline(lastEntry(ninth.record), "before").questions, [{ id: "q2", state: "open", waits: false }]);
  assert.ok(ninth.record.questions.some(item => item.id === "q9" && item.state === "open"), "the new question opens");
  assert.equal(ninth.record.questions.find(item => item.id === "q1")!.waits, true, "the waiting question stays");
});

test("with 8 waiting questions, a ninth is dropped and its assumption kept", () => {
  const eight = Array.from({ length: 8 }, (_, index) => askItem(`w${index}`, { interrupt: true }));
  const full = apply(v1(), report(eight), { mode: "supervised" });
  assert.equal(full.record.questions.filter(item => item.waits).length, 8);
  const more = apply(full.record, report([askItem("extra", { def: "z" })]), { mode: "supervised", revision: 2, at: at(2) });
  assert.equal(more.record.questions.length, 8, "the new question is dropped");
  assert.equal(more.record.assumptions.length, 9, "its assumption is kept");
  assert.equal(more.record.assumptions[8]!.question, undefined);
  assert.equal(more.dropped.cap, 1);
});

test("a new check releases earlier waits", () => {
  const first = apply(v1(), report([askItem("old", { interrupt: true })]));
  assert.equal(first.record.questions[0]!.waits, true);
  const next = apply(first.record, report([assumeItem("fresh")]), { decisionId: DECISION_2, revision: 2, at: at(2) });
  assert.equal(next.record.questions[0]!.waits, false);
  assert.equal(next.record.questions[0]!.decisionId, undefined);
  assert.deepEqual(inline(lastEntry(next.record), "after").released, ["q1"]);
  assert.deepEqual(inline(lastEntry(next.record), "before").questions, [{ id: "q1", state: "open", waits: true, decisionId: DECISION_1 }]);
  assert.equal(intentDecision(next.record, DECISION_1), undefined);
});

test("answers: defaults keep, text directs, a delegate releases", () => {
  const base = apply(v1(), report([askItem("a", { def: "x" }), askItem("b", { interrupt: true })]), { mode: "supervised" }).record;
  const decision = intentDecision(base, DECISION_1);
  assert.ok(decision, "the decision exists");
  assert.deepEqual(decision.questions, ["q1", "q2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(intentDecision(JSON.parse(JSON.stringify(base)), DECISION_1))), JSON.parse(JSON.stringify(decision)));

  const offered = apply(v1(), report([askItem("a", { def: "x" }), askItem("b", { def: "y" })]), { mode: "supervised" }).record;
  assert.deepEqual(intentDecision(offered, DECISION_1)?.options, [INTENT_DEFAULTS_ANSWER]);
  const defaults = answer(offered, DECISION_1, INTENT_DEFAULTS_ANSWER, 5);
  assert.deepEqual(defaults.questions.map(item => item.state), ["default-kept", "default-kept"]);
  assert.deepEqual(defaults.questions.map(item => item.waits), [false, false]);
  assert.deepEqual(inline(lastEntry(defaults), "after"), { mode: "defaults", questions: ["q1", "q2"] });
  assert.equal(defaults.version, offered.version + 1);
  assert.equal(defaults.log.length, offered.log.length + 1);
  assert.equal(defaults.statement.directions.length, 0, "defaults append no direction");

  const text = answer(base, DECISION_1, "Use the journal list.", 5);
  assert.deepEqual(text.questions.map(item => item.state), ["answered", "answered"]);
  assert.equal(text.statement.directions[0]!.id, "ans1");
  assert.equal(text.statement.directions[0]!.source, "correction");
  assert.equal(text.statement.directions[0]!.text, "Use the journal list.");
  assert.equal(text.assumptions[1]!.status, "unchecked", "an answer sets no assumption status");
  assert.equal(answerIntentQuestions(text, { decisionId: DECISION_1, runId: RUN_ID, text: "Use the journal list.", at: at(6) }), undefined, "a replayed answer writes nothing");
  const unoffered = answer(base, DECISION_1, INTENT_DEFAULTS_ANSWER, 6);
  assert.deepEqual(unoffered.questions.map(item => item.state), ["answered", "answered"], "the defaults text without the option is a text answer");
  assert.equal(unoffered.statement.directions[0]!.text, INTENT_DEFAULTS_ANSWER);

  const released = releaseIntentQuestions(base, { decisionId: DECISION_1, runId: RUN_ID, cause: "delegated-answer", at: at(5) });
  assert.ok(released, "a release is written");
  assert.deepEqual(released.questions.map(item => item.state), ["open", "open"]);
  assert.deepEqual(inline(lastEntry(released), "after"), { cause: "delegated-answer", questions: ["q1", "q2"] });
  assert.equal(releaseIntentQuestions(released, { decisionId: DECISION_1, runId: RUN_ID, cause: "cancelled", at: at(6) }), undefined);

  for (const answered of [defaults, text, released]) {
    assert.ok(answered.questions.every(item => !item.waits && item.decisionId === undefined), "no question waits or names the decision");
    assert.equal(intentDecision(answered, DECISION_1), undefined);
  }

  const long = answer(base, DECISION_1, "z".repeat(8_000), 7);
  const longEntry = lastEntry(long);
  assert.ok(longEntry.after !== undefined && "ref" in longEntry.after, "an 8,000-character answer is logged by reference");
  assert.equal(longEntry.after.ref, "record:direction:ans1");
  assert.equal(long.statement.directions[0]!.text.length, 8_000);
});

test("intent writes keep room for steering", () => {
  const waiting = apply(v1(), report([askItem("held", { interrupt: true })]));
  const full = padded(waiting.record, 380);
  refusedWith(() => apply(full, report([assumeItem("late")]), { revision: 2, at: at(2) }), "objective-log-full");
  refusedWith(() => answerIntentQuestions(full, { decisionId: DECISION_1, runId: RUN_ID, text: "No.", at: at(3) }), "objective-log-full");
  refusedWith(() => releaseIntentQuestions(full, { decisionId: DECISION_1, runId: RUN_ID, cause: "cancelled", at: at(3) }), "objective-log-full");
  assert.equal(skipIntentCheck(full, { runId: RUN_ID, revision: 2, reason: "checker-failed", at: at(3) }), undefined);

  const steer = (record: ObjectiveRecord, from: number, count: number): ObjectiveRecord => {
    const entries = Array.from({ length: count }, (_, index) => ({ text: "s".repeat(8_000), revision: from + index, at: at(from + index) }));
    const next = syncDirections(record, entries, at(from));
    assert.notEqual(next, "source-invalid");
    assert.ok(objectiveRecordSchema.safeParse(next).success, "the steered record parses");
    return next as ObjectiveRecord;
  };
  assert.equal(steer(padded(v1(), 380), 1, 20).log.length, 400, "20 maximal steers still fit");

  const nineteen = answer(steer(waiting.record, 1, 19), DECISION_1, "Correction.", 30);
  assert.equal(nineteen.statement.directions.length, 20);
  assert.equal(nineteen.statement.directions[19]!.id, "ans1");
  assert.ok(objectiveRecordSchema.safeParse(steer(nineteen, 20, 20)).success);
  assert.equal(steer(nineteen, 20, 20).statement.directions.length, 40);

  const twenty = steer(waiting.record, 1, 20);
  const full20 = answer(twenty, DECISION_1, "Correction.", 30);
  assert.equal(full20.statement.directions.length, 20, "no direction is appended at 20");
  assert.deepEqual(inline(lastEntry(full20), "after"), { mode: "text", questions: ["q1"], directionsFull: true });
  assert.equal(full20.questions[0]!.state, "answered", "the question is still answered");
  assert.ok(objectiveRecordSchema.safeParse(steer(full20, 21, 20)).success);
  assert.equal(steer(full20, 21, 20).statement.directions.length, 40);
});

/** A small deterministic generator, so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomReport(random: () => number, step: number): IntentCheckReport {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const count = 1 + Math.floor(random() * 5);
  const items: IntentItem[] = [];
  let scouts = 0;
  for (let index = 0; index < count; index += 1) {
    const dimension = `d${step}x${index}`;
    const roll = random();
    if (roll < 0.06) {
      items.push(assumeItem(dimension, "detail", { kind: "bogus" }));
    } else if (roll < 0.1) {
      items.push(assumeItem(dimension, "detail", { kind: "command", run: { command: "rm", args: ["-rf"] }, refutesOn: "fail" }));
    } else if (roll < 0.65) {
      const test = pick<unknown>([OWNER_TEST, LINT_TEST, { kind: "artifact", path: "docs/plan.md", count: "/items", threshold: { kind: "count", min: 1 } }]);
      items.push(askItem(dimension, {
        criticality: pick(["outcome", "plan", "detail"] as const),
        test,
        ...(random() < 0.5 ? { interrupt: true } : { def: "the default" }),
        choices: random() < 0.3 ? ["yes", "no"] : [],
      }));
    } else if (roll < 0.9 || scouts >= 3) {
      items.push(assumeItem(dimension, pick(["outcome", "plan", "detail"] as const)));
    } else {
      scouts += 1;
      items.push(scoutItem(dimension));
    }
  }
  const criteria = random() < 0.3 ? [derived("ranked", `Rank the sources at step ${step}`)] : undefined;
  return {
    kind: "intent-check",
    summary: `Step ${step}.`,
    items,
    ...(criteria ? { criteria } : {}),
    ...(random() < 0.3 ? { outOfScope: [`follow-up ${step}`] } : {}),
  };
}

test("every version rebuilds after random intent writes", () => {
  const tally = { released: 0, closed: 0, referenced: 0 };
  const refusals = new Set(["objective-log-full", "objective-criteria-limit", "objective-digest-too-large", "objective-too-large"]);
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    let record = v1();
    const snapshots = new Map<number, string>([[1, normal(record)]]);
    const steering: { text: string; revision: number; at: string }[] = [];
    const pending: string[] = [];
    let revision = 0;
    let decisions = 0;
    for (let step = 0; step < 60; step += 1) {
      record = JSON.parse(JSON.stringify(record)) as ObjectiveRecord;
      const roll = random();
      const live = pending.filter(id => intentDecision(record, id) !== undefined);
      pending.splice(0, pending.length, ...live);
      try {
        if (roll < 0.35) {
          revision += 1;
          decisions += 1;
          const decisionId = uuidFor(decisions);
          const mode: IntentMode = random() < 0.5 ? "autonomous" : "supervised";
          const result = applyIntentReport(record, randomReport(random, step), context({ revision, decisionId, mode, at: at(step) }));
          const after = inline(lastEntry(result.record), "after");
          if ((after.released as string[]).length > 0) tally.released += 1;
          if ((after.closed as string[]).length > 0) tally.closed += 1;
          if (result.decision !== undefined) pending.push(decisionId);
          record = result.record;
        } else if (roll < 0.5 && live.length > 0) {
          const decisionId = pick(live);
          const text = pick([INTENT_DEFAULTS_ANSWER, "A short correction.", "c".repeat(2_100), "d".repeat(7_000)]);
          record = answer(record, decisionId, text, step);
          if (lastEntry(record).after !== undefined && "ref" in lastEntry(record).after!) tally.referenced += 1;
          pending.splice(pending.indexOf(decisionId), 1);
        } else if (roll < 0.6 && live.length > 0) {
          const decisionId = pick(live);
          const next = releaseIntentQuestions(record, { decisionId, runId: RUN_ID, cause: pick(["replanned", "cancelled", "delegated-answer"] as const), at: at(step) });
          if (next !== undefined) record = next;
          pending.splice(pending.indexOf(decisionId), 1);
        } else if (roll < 0.66) {
          const next = skipIntentCheck(record, { runId: RUN_ID, revision: revision + 1, reason: "checker-failed", at: at(step) });
          if (next !== undefined) record = next;
        } else if (roll < 0.84) {
          const entry = { text: `steer ${step}`, revision: steering.length + 1, at: at(step) };
          steering.push(entry);
          const next = syncDirections(record, [entry], at(step), random() < 0.5 ? { revision: entry.revision, handle: `steer-${entry.revision}` } : undefined);
          assert.notEqual(next, "source-invalid", `seed ${seed} step ${step}: the steer parses`);
          record = next as ObjectiveRecord;
        } else {
          const extra = record.criteria.filter(item => item.state === "active" && item.id !== "c0");
          const op: CorrectionOp = extra.length > 0 && random() < 0.4
            ? { op: "criterion.retire", id: pick(extra).id }
            : { op: "criterion.add", criterion: { statement: `criterion ${step}`, check: JUDGEMENT, threshold: PASS } };
          record = applyOwnerOps(record, { version: record.version, ops: [op] }, { configured: CONFIGURED, requestId: uuidFor(10_000 + step), at: at(step) });
        }
      } catch (error) {
        if (error instanceof TeamError && refusals.has(error.code)) continue;
        throw error;
      }
      snapshots.set(record.version, normal(record));
    }
    for (let version = 1; version <= record.version; version += 1) {
      const expected = snapshots.get(version);
      assert.notEqual(expected, undefined, `seed ${seed}: a snapshot for version ${version}`);
      assert.ok(objectiveRecordSchema.safeParse(JSON.parse(expected!)).success, `seed ${seed}: version ${version} parses`);
      assert.equal(normal(rebuildVersion(record, version)), expected, `seed ${seed}: version ${version} rebuilds`);
    }
  }
  assert.ok(tally.released > 0, "some apply released a question that waited on an older decision");
  assert.ok(tally.closed > 0, "some apply closed the oldest open question when a ninth opened");
  assert.ok(tally.referenced > 0, "some text answer was longer than the inline bound and logged by reference");
});
