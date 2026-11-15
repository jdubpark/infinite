import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./evidence/crypto.js";
import { isScopedPath } from "./goal-types.js";

export const OBJECTIVE_SCHEMA_VERSION = 1;
export const RUBRIC_VERSION_DEFAULT = 1;
/** Every cap of the design's owner decisions, in one place. Values to confirm. Each group names the step that first reads it. */
export const OBJECTIVE_LIMITS = {
  // Owner decision 1. Step 1.
  cappedBytes: 32 * 1024, activeCriteria: 8, assumptions: 32, openQuestions: 8, definitions: 16, rules: 16, logEntries: 400, logBytes: 256 * 1024,
  // Owner decision 2. Step 3.
  intentItems: 16, scoutQuestions: 3, intentChecksPerRevision: 1,
  // Owner decision 3. Step 6.
  followUpsPerReport: 6, openFollowUps: 24, followUpGeneration: 3, repeatWindowCycles: 10, ideas: 20,
  // Owner decision 4. Step 4.
  newAssumptionsPerAttempt: 4, proposalsPerAssumption: 8,
  // Owner decision 5. Step 7: the finding's run plus this many later cycles.
  usedWindowCycles: 1,
  // Field bounds of parts 1 and 3.
  c0Bytes: 16_000, criterionBytes: 1_000, derivedFromBytes: 500, assumptionBytes: 500, noteBytes: 500, inlineValueBytes: 2 * 1024,
  evidenceHandles: 16, pinnedPaths: 8,
  // Builder bounds (my call). Each is at or above the API that feeds it.
  criteria: 64, questions: 64, questionAssumptions: 16, allowedPaths: 32, excludedPaths: 32, pathChars: 300, nonGoals: 20, nonGoalChars: 1_000,
  ownerEvidence: 20, evidenceChars: 2_000, directions: 40, directionChars: 8_000, goalObjectiveChars: 12_000, runObjectiveChars: 24_000,
  termBytes: 100, meaningBytes: 1_000, ruleBytes: 1_000, questionBytes: 1_000, summaryBytes: 500, handleChars: 200,
} as const;

export type ObjectiveOwner = { kind: "goal"; goalId: string } | { kind: "run"; runId: string };
export type Direction = { id: string; text: string; source: "steering" | "correction"; at: string };
export type Threshold = { kind: "pass" } | { kind: "count"; min?: number; max?: number } | { kind: "share"; min: number } | { kind: "score"; min: number; of: 5 };
export type Check =
  | { kind: "command"; command: string }
  | { kind: "receipt"; receipt: "checks-passed" | "review-approved" | "merged" | "landed" }
  | { kind: "artifact"; path: string; schema?: string; count?: string }
  | { kind: "citations" | "citation-form"; path: string; entries: string; perEntry: number }
  | { kind: "judgement"; item: string }
  | { kind: "owner-rating"; subject: string };
export type Criterion = { id: string; origin: "owner" | "derived"; derivedFrom?: string; statement: string;
  /** Only on a run's c0: the statement is `statement.objective`, which is not copied. */
  statementOf?: "objective";
  check: Check; producer: "host" | "evaluator" | "owner"; threshold: Threshold; pinned?: { path: string; blob: string }[];
  latest?: { state: "met" | "not-met" | "inconclusive" | "pending-owner"; note?: string; verdictId: string }; state: "active" | "retired" };
export type AssumptionTest =
  | { kind: "command"; command: string; refutesOn: "fail" | "pass" }
  | { kind: "artifact"; path: string; count: string; citedPerEntry?: number; threshold: Threshold }
  | { kind: "citation"; source: string; quote: string; refutesOn: "absent" | "present" }
  | { kind: "owner"; rating?: { subject: string; below: number } };
export type Assumption = { id: string; statement: string; status: "verified" | "assumed" | "refuted" | "unchecked";
  origin: "intent-check" | "member" | "owner"; criticality: "outcome" | "plan" | "detail"; refutedBy: string; test: AssumptionTest;
  evidence: string[]; proposals: { entryId: string; stance: "supports" | "contradicts"; summary: string; authorRole: string }[];
  question?: string; ownerPinned?: boolean };
export type Question = { id: string; text: string; assumptions: string[]; waits: boolean; decisionId?: string;
  state: "open" | "answered" | "dismissed" | "default-kept" };
export type LogValue = { inline: unknown } | { ref: string; digest: string; bytes: number };
export type LogEntry = { seq: number; at: string; version: number;
  actor: "host" | "owner" | "intent-check" | "coordinator" | "evaluator" | "member"; authority: "receipt" | "direction" | "claim";
  op: string; target: string; before?: LogValue; after?: LogValue; handle?: string };
export type ObjectiveRecord = { schemaVersion: 1; owner: ObjectiveOwner; version: number; digest: string;
  statement: { objective: string; directions: Direction[] }; definitions: { id: string; term: string; meaning: string }[];
  constraints: { allowedPaths: string[]; excludedPaths: string[]; rules: { id: string; text: string }[] };
  nonGoals: { id: string; text: string }[]; ownerEvidence: string[]; criteria: Criterion[]; assumptions: Assumption[];
  questions: Question[]; rubricVersion: number; log: LogEntry[] };

const L = OBJECTIVE_LIMITS;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const HANDLE_RE = /^[A-Za-z0-9:._-]{1,200}$/;
const OP_RE = /^[a-z]+(?:[.-][a-z]+)*$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BLOB_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const POINTER_RE = /^(?:\/[^/\x00-\x1f]{1,64}){1,8}$/;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
/** Characters as the goal and team APIs count them: zod's `max` counts UTF-16 code units. */
const charLength = (value: string): number => value.length;
const bytesBetween = (min: number, max: number) =>
  z.string().refine(value => byteLength(value) >= min && byteLength(value) <= max, `Text must be ${min} to ${max} bytes`);
const charsBetween = (min: number, max: number) =>
  z.string().refine(value => charLength(value) >= min && charLength(value) <= max, `Text must be ${min} to ${max} characters`);

const idSchema = z.string().regex(ID_RE);
const handleSchema = z.string().regex(HANDLE_RE);
const hex64 = z.string().regex(HEX64_RE);
const pointer = z.string().regex(POINTER_RE);
const isoTime = z.iso.datetime();
const pathSchema = z.string().refine(value => charLength(value) <= L.pathChars && isScopedPath(value), "Use a repository-relative file or folder, or . for the whole project");
const positiveInt = z.number().int().min(1);
const perEntry = z.number().int().min(1).max(8);
const countBound = z.number().int().min(0).max(1_000_000);

export const thresholdSchema: z.ZodType<Threshold> = z.union([
  z.strictObject({ kind: z.literal("pass") }),
  z.strictObject({ kind: z.literal("count"), min: countBound.optional(), max: countBound.optional() })
    .refine(value => value.min !== undefined || value.max !== undefined, "A count threshold needs min or max")
    .refine(value => value.min === undefined || value.max === undefined || value.min <= value.max, "A count threshold needs min at most max"),
  z.strictObject({ kind: z.literal("share"), min: z.number().min(0).max(1) }),
  z.strictObject({ kind: z.literal("score"), min: z.number().int().min(1).max(5), of: z.literal(5) }),
]);

const commandDigest = z.string().regex(/^[0-9a-f]{64}$/, "A command is a 64-character lower-case hex digest");

export const checkSchema: z.ZodType<Check> = z.union([
  z.strictObject({ kind: z.literal("command"), command: commandDigest }),
  z.strictObject({ kind: z.literal("receipt"), receipt: z.enum(["checks-passed", "review-approved", "merged", "landed"]) }),
  z.strictObject({ kind: z.literal("artifact"), path: pathSchema, schema: handleSchema.optional(), count: pointer.optional() }),
  z.strictObject({ kind: z.enum(["citations", "citation-form"]), path: pathSchema, entries: pointer, perEntry }),
  z.strictObject({ kind: z.literal("judgement"), item: idSchema }),
  z.strictObject({ kind: z.literal("owner-rating"), subject: idSchema }),
]);

const criterion = z.strictObject({
  id: idSchema,
  origin: z.enum(["owner", "derived"]),
  derivedFrom: bytesBetween(1, L.derivedFromBytes).optional(),
  statement: z.string().refine(value => byteLength(value) <= L.c0Bytes, "Criterion statement is over 16,000 bytes"),
  statementOf: z.literal("objective").optional(),
  check: checkSchema,
  producer: z.enum(["host", "evaluator", "owner"]),
  threshold: thresholdSchema,
  pinned: z.array(z.strictObject({ path: pathSchema, blob: z.string().regex(BLOB_RE) })).max(L.pinnedPaths).optional(),
  latest: z.strictObject({
    state: z.enum(["met", "not-met", "inconclusive", "pending-owner"]),
    note: bytesBetween(1, L.noteBytes).optional(),
    verdictId: z.uuid(),
  }).optional(),
  state: z.enum(["active", "retired"]),
});

const assumptionTest = z.union([
  z.strictObject({ kind: z.literal("command"), command: commandDigest, refutesOn: z.enum(["fail", "pass"]) }),
  z.strictObject({ kind: z.literal("artifact"), path: pathSchema, count: pointer, citedPerEntry: perEntry.optional(), threshold: thresholdSchema }),
  z.strictObject({ kind: z.literal("citation"), source: bytesBetween(1, L.summaryBytes), quote: bytesBetween(1, L.summaryBytes), refutesOn: z.enum(["absent", "present"]) }),
  z.strictObject({
    kind: z.literal("owner"),
    rating: z.strictObject({ subject: idSchema, below: z.number().int().min(1).max(5) }).optional(),
  }),
]);

const assumption = z.strictObject({
  id: idSchema,
  statement: bytesBetween(1, L.assumptionBytes),
  status: z.enum(["verified", "assumed", "refuted", "unchecked"]),
  origin: z.enum(["intent-check", "member", "owner"]),
  criticality: z.enum(["outcome", "plan", "detail"]),
  refutedBy: bytesBetween(1, L.assumptionBytes),
  test: assumptionTest,
  evidence: z.array(handleSchema).max(L.evidenceHandles),
  proposals: z.array(z.strictObject({
    entryId: handleSchema,
    stance: z.enum(["supports", "contradicts"]),
    summary: bytesBetween(1, L.summaryBytes),
    authorRole: idSchema,
  })).max(L.proposalsPerAssumption),
  question: idSchema.optional(),
  ownerPinned: z.boolean().optional(),
});

const question = z.strictObject({
  id: idSchema,
  text: bytesBetween(1, L.questionBytes),
  assumptions: z.array(idSchema).max(L.questionAssumptions),
  waits: z.boolean(),
  decisionId: z.uuid().optional(),
  state: z.enum(["open", "answered", "dismissed", "default-kept"]),
});

const logValue = z.union([
  z.strictObject({ inline: z.json() }),
  z.strictObject({ ref: handleSchema, digest: hex64, bytes: positiveInt }),
]);

const logEntry = z.strictObject({
  seq: positiveInt,
  at: isoTime,
  version: positiveInt,
  actor: z.enum(["host", "owner", "intent-check", "coordinator", "evaluator", "member"]),
  authority: z.enum(["receipt", "direction", "claim"]),
  op: z.string().max(64).regex(OP_RE),
  target: handleSchema,
  before: logValue.optional(),
  after: logValue.optional(),
  handle: handleSchema.optional(),
});

const direction = z.strictObject({
  id: idSchema,
  text: charsBetween(1, L.directionChars),
  source: z.enum(["steering", "correction"]),
  at: isoTime,
});

const owner = z.union([
  z.strictObject({ kind: z.literal("goal"), goalId: z.uuid() }),
  z.strictObject({ kind: z.literal("run"), runId: z.uuid() }),
]);

/** The producer a check implies: host for command, receipt, artifact, and citation checks; evaluator for judgement; owner for owner-rating. */
export function producerOf(check: Check): Criterion["producer"] {
  if (check.kind === "judgement") return "evaluator";
  if (check.kind === "owner-rating") return "owner";
  return "host";
}

/** A count threshold for an artifact with a count, a share for citations, a score for owner ratings, and pass for the rest. */
export function thresholdFits(check: Check, threshold: Threshold): boolean {
  switch (check.kind) {
    case "artifact": return check.count !== undefined ? threshold.kind === "count" : threshold.kind === "pass";
    case "citations": case "citation-form": return threshold.kind === "share";
    case "owner-rating": return threshold.kind === "score";
    default: return threshold.kind === "pass";
  }
}

/** Record-level rules. Each returns a fixed message, and the schema reports every one. */
function recordProblems(record: ObjectiveRecord): string[] {
  const problems: string[] = [];
  const fail = (message: string) => { problems.push(message); };

  const ids = [
    ...record.statement.directions.map(item => item.id),
    ...record.definitions.map(item => item.id),
    ...record.constraints.rules.map(item => item.id),
    ...record.nonGoals.map(item => item.id),
    ...record.criteria.map(item => item.id),
    ...record.assumptions.map(item => item.id),
    ...record.questions.map(item => item.id),
  ];
  if (new Set(ids).size !== ids.length) fail("Ids must be unique across the record");

  const objectiveLimit = record.owner.kind === "goal" ? L.goalObjectiveChars : L.runObjectiveChars;
  if (charLength(record.statement.objective) > objectiveLimit) fail("The objective is over its limit");

  const c0s = record.criteria.filter(item => item.id === "c0");
  if (c0s.length !== 1) {
    fail("The record needs exactly one criterion c0");
  } else {
    const c0 = c0s[0];
    if (c0.origin !== "owner" || c0.state !== "active" || c0.check.kind !== "judgement" || c0.check.item !== "owner-text" ||
      c0.producer !== "evaluator" || c0.threshold.kind !== "pass") {
      fail("c0 must be the owner's text, judged by the evaluator");
    }
    if (record.owner.kind === "goal") {
      const size = byteLength(c0.statement);
      if (size < 1 || size > L.c0Bytes) fail("A goal's c0 statement is 1 to 16,000 bytes");
      if (c0.statementOf !== undefined) fail("A goal's c0 has no statementOf");
    } else {
      if (c0.statement !== "") fail("A run's c0 statement is empty");
      if (c0.statementOf !== "objective") fail("A run's c0 must have statementOf objective");
    }
  }
  for (const item of record.criteria) {
    if (item.id !== "c0" && item.statementOf !== undefined) fail("Only c0 may have statementOf");
    if (item.id !== "c0") {
      const size = byteLength(item.statement);
      if (size < 1 || size > L.criterionBytes) fail("A criterion statement is 1 to 1,000 bytes");
    }
  }

  for (const item of record.criteria) {
    if (item.producer !== producerOf(item.check)) fail("A criterion's producer must fit its check");
    if (!thresholdFits(item.check, item.threshold)) fail("A criterion's threshold must fit its check");
  }

  const texts = [record.statement.objective, ...record.statement.directions.map(item => item.text)];
  for (const item of record.criteria) {
    if (item.origin === "derived") {
      if (item.derivedFrom === undefined || !texts.some(text => text.includes(item.derivedFrom as string))) {
        fail("A derived criterion must quote the objective or a direction");
      }
    } else if (item.derivedFrom !== undefined) {
      fail("An owner criterion has no derivedFrom");
    }
  }

  if (record.criteria.filter(item => item.state === "active").length > L.activeCriteria) fail("At most 8 criteria are active");
  if (record.questions.filter(item => item.state === "open").length > L.openQuestions) fail("At most 8 questions are open");
  const assumptionIds = new Set(record.assumptions.map(item => item.id));
  for (const item of record.questions) {
    if (!item.assumptions.every(name => assumptionIds.has(name))) fail("A question names an assumption of the record");
  }
  for (const item of record.assumptions) {
    if ((item.status === "verified" || item.status === "refuted") && item.evidence.length === 0) {
      fail("A verified or refuted assumption needs evidence");
    }
  }

  if (record.log.length < 1) fail("The log needs at least one entry");
  for (let index = 1; index < record.log.length; index++) {
    const previous = record.log[index - 1];
    const current = record.log[index];
    if (current.seq <= previous.seq) fail("Log seq must rise strictly");
    if (current.version !== previous.version && current.version !== previous.version + 1) fail("Log versions must stay or rise by one");
  }
  const last = record.log[record.log.length - 1];
  if (last !== undefined && last.version !== record.version) fail("The last log entry must have the record's version");
  if (canonicalBytes(record.log) > L.logBytes) fail("The log is over 256 KiB");
  for (const entry of record.log) {
    for (const value of [entry.before, entry.after]) {
      if (value === undefined) continue;
      if ("inline" in value && canonicalBytes(value.inline) > L.inlineValueBytes) fail("An inline value is over 2,048 bytes");
      if ("ref" in value && value.bytes <= L.inlineValueBytes) fail("A ref value must be over 2,048 bytes");
    }
  }

  // Rule 9: the direction log agrees with the steering directions, in order, with their own values.
  const directionOps = record.log.filter(entry => entry.op === "direction.appended" || entry.op === "direction.copied");
  const steered = record.statement.directions.filter(item => item.source === "steering");
  let historyOk = directionOps.length === steered.length;
  let previousVersion = 1;
  directionOps.forEach((entry, index) => {
    if (!historyOk) return;
    const direction = steered[index]!;
    const expected = logValueOf(direction, `record:direction:${direction.id}`);
    if (entry.target !== direction.id || entry.after === undefined || canonicalJson(JSON.parse(JSON.stringify(entry.after))) !== canonicalJson(expected)) historyOk = false;
    if (entry.version <= previousVersion) historyOk = false;
    previousVersion = entry.version;
  });
  if (!historyOk) fail("objective-history-invalid");

  if (recordDigest(record) !== record.digest) fail("The digest must match the record");
  if (cappedBytes(record) > L.cappedBytes) fail("objective-too-large");
  return problems;
}

export const objectiveRecordSchema: z.ZodType<ObjectiveRecord> = z.strictObject({
  schemaVersion: z.literal(OBJECTIVE_SCHEMA_VERSION),
  owner,
  version: positiveInt,
  digest: hex64,
  statement: z.strictObject({
    objective: charsBetween(1, L.runObjectiveChars),
    directions: z.array(direction).max(L.directions),
  }),
  definitions: z.array(z.strictObject({ id: idSchema, term: bytesBetween(1, L.termBytes), meaning: bytesBetween(1, L.meaningBytes) })).max(L.definitions),
  constraints: z.strictObject({
    allowedPaths: z.array(pathSchema).min(1).max(L.allowedPaths),
    excludedPaths: z.array(pathSchema).max(L.excludedPaths),
    rules: z.array(z.strictObject({ id: idSchema, text: bytesBetween(1, L.ruleBytes) })).max(L.rules),
  }),
  nonGoals: z.array(z.strictObject({ id: idSchema, text: charsBetween(1, L.nonGoalChars) })).max(L.nonGoals),
  ownerEvidence: z.array(charsBetween(1, L.evidenceChars)).max(L.ownerEvidence),
  criteria: z.array(criterion).max(L.criteria),
  assumptions: z.array(assumption).max(L.assumptions),
  questions: z.array(question).max(L.questions),
  rubricVersion: z.number().int().min(1).max(1000),
  log: z.array(logEntry).min(1).max(L.logEntries),
}).superRefine((record, context) => {
  for (const message of recordProblems(record as ObjectiveRecord)) context.addIssue({ code: "custom", message });
});

/** UTF-8 bytes of canonicalJson after a JSON round trip, which drops undefined values. */
export function canonicalBytes(value: unknown): number {
  return byteLength(canonicalJson(JSON.parse(JSON.stringify(value))));
}

/** Inline when the canonical value fits 2 KiB; otherwise a reference with the digest and size. */
export function logValueOf(value: unknown, ref: string): LogValue {
  const json = JSON.parse(JSON.stringify(value));
  const bytes = canonicalBytes(json);
  if (bytes <= L.inlineValueBytes) return { inline: json };
  return { ref, digest: createHash("sha256").update(canonicalJson(json)).digest("hex"), bytes };
}

/** SHA-256 hex of the canonical record without `log` and `digest`. */
export function recordDigest(record: Omit<ObjectiveRecord, "digest" | "log"> & Partial<Pick<ObjectiveRecord, "digest" | "log">>): string {
  const body: Record<string, unknown> = { ...record };
  delete body.log;
  delete body.digest;
  return createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(body)))).digest("hex");
}

/** The bytes that count against `cappedBytes`: everything but the log, the digest, the statement, non-goals, owner evidence, and c0's statement. */
export function cappedBytes(record: ObjectiveRecord): number {
  return canonicalBytes({
    schemaVersion: record.schemaVersion,
    owner: record.owner,
    version: record.version,
    definitions: record.definitions,
    constraints: record.constraints,
    criteria: record.criteria.map(item => (item.id === "c0" ? { ...item, statement: undefined } : item)),
    assumptions: record.assumptions,
    questions: record.questions,
    rubricVersion: record.rubricVersion,
  });
}
