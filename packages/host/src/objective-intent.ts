import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./evidence/crypto.js";
import { findSecret } from "./evidence/secret-scan.js";
import { recordDigestFor } from "./objective-digest.js";
import { commandDigest, criterionInputSchema } from "./objective-input.js";
import type { CriterionInput } from "./objective-input.js";
import { CORRECTION_LOG, criterionFromInput, nextCriterionId } from "./objective-ops.js";
import { INTENT_OPS, logValue, objectiveError } from "./objective-record.js";
import { assertLogRoom, nextRecordId, nextSeq, sealRecord } from "./objective-write.js";
import type { ObjectiveState } from "./objective-record.js";
import type { IntentCheckReport, IntentItem } from "./intent-report.js";
import {
  OBJECTIVE_LIMITS,
  assumptionTestSchema,
  canonicalBytes,
  cappedBytes,
  objectiveRecordSchema,
} from "./objective-types.js";
import type { Assumption, AssumptionTest, Criterion, Direction, LogEntry, LogValue, ObjectiveRecord, Question } from "./objective-types.js";
import { RECORD_DIGEST_BYTES, recordDigestBytes, teamCommandSchema } from "./team-types.js";
import type { TeamCommand } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

/** The owner's answer that takes the stated defaults. Any other text is a direction. */
export const INTENT_DEFAULTS_ANSWER = "Use the stated defaults";
export type IntentMode = "autonomous" | "supervised";
export type IntentDrop = "shape" | "secret" | "cap" | "quote" | "command";
export type IntentSkipReason = "checker-failed" | "no-eligible-profile" | "record-unavailable" | "log-full" | "context-too-large";
export type IntentReleaseCause = "replanned" | "cancelled" | "delegated-answer";
export type IntentScreenDrop = Exclude<IntentDrop, "cap">;
export type IntentStatement = { objective: string; directions: string[] };
export type IntentDecision = { id: string; question: string; options: string[]; questions: string[] };
export type IntentApplyContext = {
  runId: string; revision: number; checkerMemberId: string; decisionId: string; mode: IntentMode; goal: boolean;
  configured: readonly TeamCommand[]; at: string; screened?: Partial<Record<IntentScreenDrop, number>>;
};
export type IntentApplied = {
  record: ObjectiveRecord; decision?: IntentDecision;
  added: { assumptions: string[]; questions: string[]; criteria: string[] }; dropped: Record<IntentDrop, number>; converted: number;
  ignored: { criteria: number; outOfScope: number };
};
/** A goal's record in GoalService's memory (Task 10). `write` throws objectiveError("objective-version-stale") when the held version differs,
 *  and rethrows a failed save after restoring the record. */
export type GoalRecordPort = {
  read(goalId: string): ObjectiveState;
  write(goalId: string, expectedVersion: number, next: ObjectiveRecord): void;
};

type SavedQuestion = { id: string; state: Question["state"]; waits: boolean; decisionId?: string };
type Added = { assumptions: string[]; questions: string[]; criteria: string[] };
type Verdict<T, D extends IntentDrop = IntentScreenDrop> = { ok: true; value: T } | { ok: false; drop: D };
const SCREEN_DROPS = ["shape", "secret", "quote", "command"] as const satisfies readonly IntentScreenDrop[];

const L = OBJECTIVE_LIMITS;
const NO_OWN = { token: "", url: "" };
const SUMMARY_WITHHELD = "Summary withheld: it matched a secret shape.";
const DIRECTION_REF = "record:direction:";
/** Steering keeps 20 directions. An answer appends one only while the record holds fewer than this. */
const ANSWER_DIRECTIONS_BELOW = 20;
const DECISION_LINE_CHARS = 440;
const DECISION_CHARS = 4_000;
const reportCommandTest = z.strictObject({ kind: z.literal("command"), run: teamCommandSchema, refutesOn: z.enum(["fail", "pass"]) });

const bytesOf = (value: string): number => Buffer.byteLength(value, "utf8");
const noDrops = (): Record<IntentDrop, number> => ({ shape: 0, secret: 0, cap: 0, quote: 0, command: 0 });
const digestOf = (value: unknown): string => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");

/** Cuts text to `max` characters, the last three of them "..." when it is cut. Characters are code points. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join("")}...`;
}

function statementOf(record: ObjectiveRecord): IntentStatement {
  return { objective: record.statement.objective, directions: record.statement.directions.map(item => item.text) };
}

export function statementDigestOf(statement: IntentStatement): string {
  return digestOf({ objective: statement.objective, directions: statement.directions });
}

function savedOf(question: Question): SavedQuestion {
  const saved: SavedQuestion = { id: question.id, state: question.state, waits: question.waits };
  if (question.decisionId !== undefined) saved.decisionId = question.decisionId;
  return saved;
}

function withoutDecision(question: Question): Question {
  const next = { ...question };
  delete next.decisionId;
  return next;
}

/** The test a report names, as the record stores it. A command must be a configured check; any other test must pass the record's schema. */
/** The verdict on one assumption test. `testOf` is the only rule for a command test. */
export type TestVerdict = Verdict<AssumptionTest, "shape" | "command">;

export function testOf(test: unknown, configured: readonly TeamCommand[]): TestVerdict {
  if (typeof test === "object" && test !== null && (test as { kind?: unknown }).kind === "command") {
    const parsed = reportCommandTest.safeParse(test);
    if (!parsed.success) return { ok: false, drop: "shape" };
    const digest = commandDigest(parsed.data.run);
    if (!configured.some(command => commandDigest(command) === digest)) return { ok: false, drop: "command" };
    return { ok: true, value: { kind: "command", command: digest, refutesOn: parsed.data.refutesOn } };
  }
  const parsed = assumptionTestSchema.safeParse(test);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, drop: "shape" };
}

/** A derived criterion's text: the quote it derives from, and the criterion without it. */
function splitDerived(raw: unknown): { derivedFrom: string; rest: Record<string, unknown> } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { derivedFrom, ...rest } = raw as Record<string, unknown>;
  if (typeof derivedFrom !== "string" || bytesOf(derivedFrom) < 1 || bytesOf(derivedFrom) > L.derivedFromBytes) return undefined;
  return { derivedFrom, rest };
}

/** A derived criterion's shape, secret scan, quote, and command, in that order. */
function criterionVerdict(raw: unknown, statement: IntentStatement | undefined, configured: readonly TeamCommand[]): Verdict<{ input: CriterionInput; derivedFrom: string }> {
  const split = splitDerived(raw);
  const parsed = split ? criterionInputSchema.safeParse(split.rest) : undefined;
  if (!split || !parsed?.success) return { ok: false, drop: "shape" };
  if (findSecret(raw, NO_OWN)) return { ok: false, drop: "secret" };
  const texts = statement ? [statement.objective, ...statement.directions] : [];
  if (!texts.some(text => text.includes(split.derivedFrom))) return { ok: false, drop: "quote" };
  try {
    criterionFromInput(parsed.data, "c1", configured);
  } catch (error) {
    const unknownCommand = error instanceof TeamError && error.code === "objective-command-unknown";
    return { ok: false, drop: unknownCommand ? "command" : "shape" };
  }
  return { ok: true, value: { input: parsed.data, derivedFrom: split.derivedFrom } };
}

/** The report minus every item and criterion that fails shape, secret, command, or quote, and minus secret-shaped outOfScope ids;
 *  a secret-shaped summary becomes "Summary withheld: it matched a secret shape.". Without a statement every criterion drops as quote.
 *  Idempotent: screening a kept report drops nothing. */
export function screenIntentReport(report: IntentCheckReport, input: { statement?: IntentStatement; configured: readonly TeamCommand[] }): {
  kept: IntentCheckReport; dropped: Record<IntentScreenDrop, number>;
} {
  const dropped: Record<IntentScreenDrop, number> = { shape: 0, secret: 0, quote: 0, command: 0 };
  const items: IntentItem[] = [];
  for (const item of report.items) {
    const verdict = testOf(item.assumption.test, input.configured);
    if (!verdict.ok) {
      dropped[verdict.drop] += 1;
      continue;
    }
    if (findSecret(item, NO_OWN)) {
      dropped.secret += 1;
      continue;
    }
    items.push(item);
  }
  const criteria: unknown[] = [];
  for (const raw of report.criteria ?? []) {
    const verdict = criterionVerdict(raw, input.statement, input.configured);
    if (verdict.ok) criteria.push(raw);
    else dropped[verdict.drop] += 1;
  }
  const outOfScope = (report.outOfScope ?? []).filter(id => {
    if (!findSecret(id, NO_OWN)) return true;
    dropped.secret += 1;
    return false;
  });
  let summary = report.summary;
  if (findSecret(summary, NO_OWN)) {
    summary = SUMMARY_WITHHELD;
    dropped.secret += 1;
  }
  const kept: IntentCheckReport = {
    kind: "intent-check",
    summary,
    items,
    ...(report.criteria !== undefined && criteria.length > 0 ? { criteria } : {}),
    ...(report.outOfScope !== undefined ? { outOfScope } : {}),
  };
  return { kept, dropped };
}

/** The questions that wait on `decisionId`, as a decision. Built from the record alone, so a restart rebuilds the same decision. */
function decisionFrom(record: ObjectiveRecord, decisionId: string): IntentDecision | undefined {
  const waiting = record.questions.filter(item => item.waits && item.decisionId === decisionId);
  if (waiting.length === 0) return undefined;
  const lines = waiting.map((item, index) => cut(`${index + 1}. ${item.text}`, DECISION_LINE_CHARS));
  const header = `The intent check needs your answer on ${waiting.length} item(s) before the plan proceeds. Answer in one message.`;
  const defaults = waiting.every(item => {
    const linked = record.assumptions.filter(assumption => item.assumptions.includes(assumption.id));
    return linked.length > 0 && linked.every(assumption => assumption.status === "assumed");
  });
  return {
    id: decisionId,
    question: cut([header, ...lines].join("\n"), DECISION_CHARS),
    options: defaults ? [INTENT_DEFAULTS_ANSWER] : [],
    questions: waiting.map(item => item.id),
  };
}

/** The blocking question for the questions that wait on `decisionId`, built from the record alone; undefined when none waits. */
export function intentDecision(record: ObjectiveRecord, decisionId: string): IntentDecision | undefined {
  return decisionFrom(record, decisionId);
}

/** The `intent-check.applied` entry whose handle is this checker. */
export function intentApplied(record: ObjectiveRecord, checkerMemberId: string): LogEntry | undefined {
  return record.log.find(entry => entry.op === INTENT_OPS.applied && entry.handle === checkerMemberId);
}

/** No applied entry carries `statementDigest`, or the latest one differs from the current statement's. */
export function criteriaDue(record: ObjectiveRecord): boolean {
  for (let index = record.log.length - 1; index >= 0; index -= 1) {
    const entry = record.log[index]!;
    if (entry.op !== INTENT_OPS.applied || entry.after === undefined || !("inline" in entry.after)) continue;
    const digest = (entry.after.inline as { statementDigest?: unknown }).statementDigest;
    if (typeof digest === "string") return digest !== statementDigestOf(statementOf(record));
  }
  return true;
}

/** Working state of one apply: the arrays it changes, and the environment every step reads. */
type Draft = { assumptions: Assumption[]; questions: Question[]; criteria: Criterion[] };
type Effect = { converted: boolean; capQuestion: boolean; closed?: string; added: Partial<Record<keyof Added, string>> };
type Step = { ok: true; draft: Draft; effect: Effect } | { ok: false; drop: IntentDrop };
type Env = { base: ObjectiveRecord; mode: IntentMode; decisionId: string; configured: readonly TeamCommand[]; original: Map<string, Question> };

/** The record's capped bytes with a draft's arrays. A draft over 32 KiB is a cap refusal. */
function fits(draft: Draft, env: Env): boolean {
  return cappedBytes({ ...env.base, assumptions: draft.assumptions, questions: draft.questions, criteria: draft.criteria }) <= L.cappedBytes;
}

function questionTextOf(item: IntentItem, question: NonNullable<IntentItem["question"]>): string {
  const options = question.options.length > 0 ? ` Options: ${question.options.join("; ")}.` : "";
  const tail = question.default !== undefined ? ` Default: ${question.default}.` : " No default.";
  return `${item.dimension}: ${question.text}${options}${tail}`;
}

/** One report item on a draft. A converted ask is assumed with no question; a remaining ask opens one, which waits in supervised mode. */
function addItem(draft: Draft, item: IntentItem, env: Env): Step {
  const verdict = testOf(item.assumption.test, env.configured);
  if (!verdict.ok) return { ok: false, drop: verdict.drop };
  const test = verdict.value;
  const ask = item.disposition === "ask";
  const convert = item.disposition === "scout"
    || (ask && env.mode === "autonomous" && !(item.criticality === "outcome" && test.kind === "owner"));
  const question = ask && !convert ? item.question : undefined;
  if (draft.assumptions.length >= L.assumptions) return { ok: false, drop: "cap" };
  if (question !== undefined && draft.questions.length >= L.questions) return { ok: false, drop: "cap" };

  const effect: Effect = { converted: convert, capQuestion: false, added: {} };
  const assumptionId = nextRecordId("a", draft.assumptions.map(item => item.id));
  let questions = draft.questions;
  let questionId: string | undefined;
  if (question !== undefined) {
    const waits = env.mode === "supervised" || question.interrupt !== undefined;
    let opens = true;
    if (questions.filter(item => item.state === "open").length >= L.openQuestions) {
      // The oldest open question that does not wait closes. Only a question of the record before this apply may close.
      const candidate = questions.find(item => item.state === "open" && !item.waits && env.original.has(item.id));
      if (candidate !== undefined) {
        questions = questions.map(item => (item.id === candidate.id ? { ...item, state: "default-kept" as const } : item));
        effect.closed = candidate.id;
      } else {
        opens = false;
        effect.capQuestion = true;
      }
    }
    if (opens) {
      questionId = nextRecordId("q", questions.map(item => item.id));
      const opened: Question = {
        id: questionId, text: questionTextOf(item, question), assumptions: [assumptionId], waits, state: "open",
      };
      if (waits) opened.decisionId = env.decisionId;
      questions = [...questions, opened];
      effect.added.questions = questionId;
    }
  }
  const assumption: Assumption = {
    id: assumptionId,
    statement: item.assumption.statement,
    status: question === undefined || question.default !== undefined ? "assumed" : "unchecked",
    origin: "intent-check",
    criticality: item.criticality,
    refutedBy: item.assumption.refutedBy,
    test,
    evidence: [],
    proposals: [],
    ...(questionId !== undefined ? { question: questionId } : {}),
  };
  effect.added.assumptions = assumptionId;
  const next: Draft = { assumptions: [...draft.assumptions, assumption], questions, criteria: draft.criteria };
  if (!fits(next, env)) return { ok: false, drop: "cap" };
  return { ok: true, draft: next, effect };
}

/** One derived criterion on a draft: active and digest caps, then the record's own bytes. */
function addCriterion(draft: Draft, input: CriterionInput, derivedFrom: string, env: Env): Step {
  if (draft.criteria.filter(item => item.state === "active").length >= L.activeCriteria || draft.criteria.length >= L.criteria) {
    return { ok: false, drop: "cap" };
  }
  let created: Criterion;
  try {
    created = criterionFromInput(input, nextCriterionId({ ...env.base, criteria: draft.criteria }), env.configured);
  } catch {
    return { ok: false, drop: "shape" };
  }
  const criterion: Criterion = { ...created, origin: "derived", derivedFrom };
  const next: Draft = { ...draft, criteria: [...draft.criteria, criterion] };
  const digest = recordDigestBytes(recordDigestFor({ ...env.base, criteria: next.criteria }, env.configured));
  if (digest > RECORD_DIGEST_BYTES || !fits(next, env)) return { ok: false, drop: "cap" };
  return { ok: true, draft: next, effect: { converted: false, capQuestion: false, added: { criteria: criterion.id } } };
}

/** One version up and one `intent-check.applied` entry. A bad item is dropped and counted, never thrown.
 *  Throws objectiveError("objective-log-full") past CORRECTION_LOG, and objectiveError("objective-op-refused") when the result fails objectiveRecordSchema. */
export function applyIntentReport(record: ObjectiveRecord, report: IntentCheckReport, context: IntentApplyContext): IntentApplied {
  const statement = statementOf(record);
  const screened = screenIntentReport(report, { statement, configured: context.configured });
  const dropped = noDrops();
  for (const key of SCREEN_DROPS) dropped[key] += screened.dropped[key] + (context.screened?.[key] ?? 0);
  const due = context.goal && criteriaDue(record);
  const original = new Map(record.questions.map(item => [item.id, item]));
  const released = record.questions.filter(item => item.waits && item.decisionId !== context.decisionId).map(item => item.id);
  const before = new Map<string, SavedQuestion>();
  for (const item of record.questions) if (released.includes(item.id)) before.set(item.id, savedOf(item));
  const env: Env = { base: record, mode: context.mode, decisionId: context.decisionId, configured: context.configured, original };

  let draft: Draft = {
    assumptions: [...record.assumptions],
    questions: record.questions.map(item => (released.includes(item.id) ? { ...withoutDecision(item), waits: false } : item)),
    criteria: [...record.criteria],
  };
  const closed: string[] = [];
  const added: Added = { assumptions: [], questions: [], criteria: [] };
  const ignored = { criteria: 0, outOfScope: screened.kept.outOfScope?.length ?? 0 };
  let converted = 0;
  const note = (effect: Effect): void => {
    if (effect.converted) converted += 1;
    if (effect.capQuestion) dropped.cap += 1;
    if (effect.closed !== undefined) {
      closed.push(effect.closed);
      if (!before.has(effect.closed)) before.set(effect.closed, savedOf(original.get(effect.closed)!));
    }
    for (const key of Object.keys(added) as (keyof Added)[]) {
      const id = effect.added[key];
      if (id !== undefined) added[key].push(id);
    }
  };

  for (const item of screened.kept.items) {
    const step = addItem(draft, item, env);
    if (!step.ok) {
      dropped[step.drop] += 1;
      continue;
    }
    draft = step.draft;
    note(step.effect);
  }
  if (due) {
    for (const raw of screened.kept.criteria ?? []) {
      const verdict = criterionVerdict(raw, statement, context.configured);
      if (!verdict.ok) {
        dropped[verdict.drop] += 1;
        continue;
      }
      const step = addCriterion(draft, verdict.value.input, verdict.value.derivedFrom, env);
      if (!step.ok) {
        dropped[step.drop] += 1;
        continue;
      }
      draft = step.draft;
      note(step.effect);
    }
  } else {
    ignored.criteria = screened.kept.criteria?.length ?? 0;
  }

  const waiting = draft.questions.filter(item => item.waits && item.decisionId === context.decisionId).map(item => item.id);
  const addedObjects = {
    assumptions: draft.assumptions.filter(item => added.assumptions.includes(item.id)),
    questions: draft.questions.filter(item => added.questions.includes(item.id)),
    criteria: draft.criteria.filter(item => added.criteria.includes(item.id)),
  };
  const after: Record<string, unknown> = {
    revision: context.revision,
    mode: context.mode,
    added,
    addedDigest: digestOf(addedObjects),
    released,
    closed,
    waiting,
    ...(waiting.length > 0 ? { decision: context.decisionId } : {}),
    converted,
    dropped,
    ignored,
    ...(due ? { statementDigest: statementDigestOf(statement) } : {}),
  };
  const entry: LogEntry = {
    seq: nextSeq(record),
    at: context.at,
    version: record.version + 1,
    actor: "intent-check",
    authority: "claim",
    op: INTENT_OPS.applied,
    target: context.runId,
    before: { inline: { questions: record.questions.filter(item => before.has(item.id)).map(item => before.get(item.id)!) } },
    after: { inline: after },
    handle: context.checkerMemberId,
  };
  assertLogRoom(record, [entry]);
  const next = sealRecord(record, { assumptions: draft.assumptions, questions: draft.questions, criteria: draft.criteria }, [entry]);
  return { record: next, decision: decisionFrom(next, context.decisionId), added, dropped, converted, ignored };
}

/** The owner's answer to the questions waiting on `decisionId`; each stops waiting and drops decisionId. One version up, one `intent-check.answered` entry.
 *  Undefined when none waits, so a replayed answer writes nothing (R9). The defaults text keeps defaults only when the decision offers it.
 *  Throws objectiveError("objective-log-full"). */
export function answerIntentQuestions(record: ObjectiveRecord, answer: { decisionId: string; runId: string; text: string; at: string }): ObjectiveRecord | undefined {
  if (answer.text.length < 1 || answer.text.length > L.directionChars) throw objectiveError("objective-op-invalid");
  const decision = decisionFrom(record, answer.decisionId);
  if (decision === undefined) return undefined;
  const waiting = record.questions.filter(item => item.waits && item.decisionId === answer.decisionId);
  const ids = decision.questions;
  const defaults = answer.text === INTENT_DEFAULTS_ANSWER && decision.options.includes(INTENT_DEFAULTS_ANSWER);
  const state: Question["state"] = defaults ? "default-kept" : "answered";
  const questions = record.questions.map(item => (ids.includes(item.id) ? { ...withoutDecision(item), state, waits: false } : item));
  const directions: Direction[] = [...record.statement.directions];
  let wrapped: LogValue;
  if (defaults) {
    wrapped = { inline: { mode: "defaults", questions: ids } };
  } else if (directions.length < ANSWER_DIRECTIONS_BELOW) {
    const id = nextRecordId("ans", directions.map(item => item.id));
    const direction: Direction = { id, text: answer.text, source: "correction", at: answer.at };
    directions.push(direction);
    wrapped = logValue({ mode: "text", questions: ids, direction }, `${DIRECTION_REF}${id}`);
  } else {
    wrapped = { inline: { mode: "text", questions: ids, directionsFull: true } };
  }
  const entry: LogEntry = {
    seq: nextSeq(record),
    at: answer.at,
    version: record.version + 1,
    actor: "owner",
    authority: "direction",
    op: INTENT_OPS.answered,
    target: answer.decisionId,
    before: { inline: { questions: waiting.map(savedOf) } },
    after: wrapped,
    handle: answer.runId,
  };
  assertLogRoom(record, [entry]);
  return sealRecord(record, { questions, statement: { ...record.statement, directions } }, [entry]);
}

/** The questions waiting on `decisionId` stop waiting; undefined when none waits. One version up, one `intent-check.released` entry. Throws objectiveError("objective-log-full"). */
export function releaseIntentQuestions(record: ObjectiveRecord, input: { decisionId: string; runId: string; cause: IntentReleaseCause; at: string }): ObjectiveRecord | undefined {
  const waiting = record.questions.filter(item => item.waits && item.decisionId === input.decisionId);
  if (waiting.length === 0) return undefined;
  const ids = waiting.map(item => item.id);
  const questions = record.questions.map(item => (ids.includes(item.id) ? { ...withoutDecision(item), waits: false } : item));
  const entry: LogEntry = {
    seq: nextSeq(record),
    at: input.at,
    version: record.version + 1,
    actor: "host",
    authority: "receipt",
    op: INTENT_OPS.released,
    target: input.decisionId,
    before: { inline: { questions: waiting.map(savedOf) } },
    after: { inline: { cause: input.cause, questions: ids } },
    handle: input.runId,
  };
  assertLogRoom(record, [entry]);
  return sealRecord(record, { questions }, [entry]);
}

/** One `intent-check.skipped` entry at the current version; the body is unchanged. Undefined when the log has no room. */
export function skipIntentCheck(record: ObjectiveRecord, input: { runId: string; revision: number; reason: IntentSkipReason; at: string }): ObjectiveRecord | undefined {
  const entry: LogEntry = {
    seq: nextSeq(record),
    at: input.at,
    version: record.version,
    actor: "host",
    authority: "receipt",
    op: INTENT_OPS.skipped,
    target: input.runId,
    after: { inline: { revision: input.revision, reason: input.reason } },
  };
  if (record.log.length + 1 > CORRECTION_LOG.entries || canonicalBytes([...record.log, entry]) > CORRECTION_LOG.bytes) return undefined;
  const next = { ...record, log: [...record.log, entry] };
  if (!objectiveRecordSchema.safeParse(next).success) throw objectiveError("objective-op-refused");
  return next;
}
