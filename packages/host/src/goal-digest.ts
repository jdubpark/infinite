import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  OMITTED_MAX, boundedText, cleanText, crossingDigestSchema, failureKey, field, listOf, readDecision, readFailure, readTouched,
  sanitize, unionTouched, unique, type CrossingDigest,
} from "./crossing-digest.js";

export const GOAL_DIGEST_LIMIT_BYTES = 8192;
const CAPS = { history: 16, touched: 24, failures: 6, decisions: 6, open: 4, criteria: 8 } as const;
const LINE_BYTES = 240;
const CRITERION_BYTES = 240;
const CHECK_BYTES = 120;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CRITERION_STATUSES = ["met", "not-met", "inconclusive", "pending-owner"] as const;
const LISTS = ["touched", "failures", "decisions", "open", "criteria"] as const;

const code = z.string().regex(CODE);
const runId = z.string().regex(RUN_ID);
const head = z.string().regex(HEAD);
const cycleNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().min(0).max(OMITTED_MAX);
const crossing = crossingDigestSchema.shape;

export const goalDigestSchema = z.object({
  v: z.literal(1),
  cycle: cycleNumber,
  history: z.array(z.object({ cycle: cycleNumber, status: code, line: boundedText(LINE_BYTES) }).strict()).max(CAPS.history),
  touched: crossing.touched.refine(rows => rows.every(row => row.by === "receipt"), "touched holds receipts only"),
  failures: crossing.failures.refine(rows => rows.every((row, index) => row.by === "claim" || rows[index - 1]?.by !== "claim"), "receipt failures precede claim failures"),
  decisions: crossing.decisions,
  open: crossing.open,
  criteria: z.array(z.object({
    criterion: boundedText(CRITERION_BYTES),
    status: z.enum(CRITERION_STATUSES),
    check: boundedText(CHECK_BYTES).optional(),
  }).strict()).max(CAPS.criteria).optional(),
  handles: z.object({ runId, reviewedHead: head.optional() }).strict(),
  outsideContent: z.boolean(),
  unclearedHead: z.object({ runId, head }).strict().optional(),
  claimsUnavailable: z.literal(true).optional(),
  omitted: z.object({ cycles: counter, touched: counter, failures: counter, decisions: counter, open: counter, criteria: counter }).strict(),
}).strict()
  .refine(digest => digest.history.every((row, index) => row.cycle < (digest.history[index - 1]?.cycle ?? digest.cycle + 1)), "history is newest first, one row per cycle, none after `cycle`")
  .refine(digest => digest.unclearedHead === undefined || digest.outsideContent, "an uncleared head needs outsideContent")
  .refine(digest => digest.omitted.cycles === Math.min(OMITTED_MAX, digest.cycle - digest.history.length), "omitted.cycles counts the cycles without a line")
  .refine(digest => jsonBytes(digest) <= GOAL_DIGEST_LIMIT_BYTES, `Use at most ${GOAL_DIGEST_LIMIT_BYTES} bytes as JSON`);
export type GoalDigest = z.infer<typeof goalDigestSchema>;
type Touched = CrossingDigest["touched"][number];
type Failure = CrossingDigest["failures"][number];
type Decision = CrossingDigest["decisions"][number];
type History = GoalDigest["history"][number];
type Criterion = NonNullable<GoalDigest["criteria"]>[number];
type Counts = GoalDigest["omitted"];
type Fixed = Pick<GoalDigest, "cycle" | "handles" | "outsideContent" | "unclearedHead">;

export type HistoryLineInput =
  | { kind: "brief"; title: string; expectedOutcome: string }
  | { kind: "stop"; blockCode?: string; stopClass?: string };

export type CriterionInput = { criterion: string; status: (typeof CRITERION_STATUSES)[number]; check?: string };

export type EndedCycle = {
  cycle: number;
  status: string;
  line: HistoryLineInput;
  run: CrossingDigest;
  claimsUnavailable?: boolean;
  criteria?: CriterionInput[];
  handles: { runId: string; reviewedHead?: string };
  outsideContent: boolean;
  unclearedHead?: { runId: string; head: string };
};

type Parts = {
  fixed: Fixed;
  claimsUnavailable: boolean;
  history: History[];
  touched: Touched[];
  failures: Failure[];
  decisions: Decision[];
  open: string[];
  criteria?: Criterion[];
  omitted: Counts;
};

const isCycle = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);
const isOutcome = (value: unknown): boolean => crossing.outcome.safeParse(value).success;
const add = (a: number, b: number): number => Math.min(OMITTED_MAX, a + b);
const zeroCounts = (): Counts => ({ cycles: 0, touched: 0, failures: 0, decisions: 0, open: 0, criteria: 0 });
const WIDEST: Counts = { cycles: OMITTED_MAX, touched: OMITTED_MAX, failures: OMITTED_MAX, decisions: OMITTED_MAX, open: OMITTED_MAX, criteria: OMITTED_MAX };

export function goalDigestBytes(digest: GoalDigest): number {
  return jsonBytes(digest);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function nextGoalDigest(previous: GoalDigest | undefined, ended: EndedCycle): GoalDigest | undefined {
  const fixed = readFixed(ended);
  const run = field(ended, "run");
  if (fixed === undefined || !isOutcome(field(run, "outcome"))) return undefined;
  const omitted = zeroCounts();
  let carriedTouched: Touched[] = [];
  let carriedHistory: History[] = [];
  if (previous !== undefined) {
    const stored = readStored(previous);
    if (stored === undefined) return undefined;
    if (fixed.cycle <= stored.cycle) return checked("nextGoalDigest", assemble(storedParts(previous, stored)));
    carriedTouched = readRows(field(previous, "touched"), readReceipt, omitted, "touched");
    carriedHistory = readHistory(field(previous, "history"), stored.cycle);
    omitted.touched = add(omitted.touched, sanitize(field(field(previous, "omitted"), "touched")));
  }
  const received = field(run, "omitted");
  const unavailable = field(ended, "claimsUnavailable") === true;
  const fresh = readRows(field(run, "touched"), readTouched, omitted, "touched").filter(row => row.by === "receipt");
  omitted.touched = add(omitted.touched, sanitize(field(received, "touched")));
  const unresolved = fixed.handles.reviewedHead === undefined;
  const failures = unresolved ? readRows(field(run, "failures"), readFailure, omitted, "failures") : [];
  if (unresolved) omitted.failures = add(omitted.failures, sanitize(field(received, "failures")));
  if (!unavailable) {
    omitted.decisions = add(omitted.decisions, sanitize(field(received, "decisions")));
    omitted.open = add(omitted.open, sanitize(field(received, "open")));
  }
  const line = lineOf(ended, fixed.cycle);
  return checked("nextGoalDigest", assemble({
    fixed,
    claimsUnavailable: unavailable,
    history: line === undefined ? carriedHistory : [line, ...carriedHistory],
    touched: unionTouched([...fresh, ...carriedTouched]),
    failures: foldFailures(unavailable ? failures.filter(row => row.by === "receipt") : failures),
    ...claimLists(unavailable ? undefined : run, field(ended, "criteria"), omitted),
    omitted,
  }));
}

export function fitGoalDigest(digest: GoalDigest): GoalDigest | undefined {
  const stored = readStored(digest);
  return stored === undefined ? undefined : checked("fitGoalDigest", assemble(storedParts(digest, stored)));
}

function readStored(digest: unknown): Fixed | undefined {
  return field(digest, "v") === 1 ? readFixed(digest) : undefined;
}

function readFixed(source: unknown): Fixed | undefined {
  const cycle = field(source, "cycle");
  const handles = field(source, "handles");
  const id = field(handles, "runId");
  const reviewedHead = field(handles, "reviewedHead");
  const outsideContent = field(source, "outsideContent");
  const uncleared = field(source, "unclearedHead");
  if (!isCycle(cycle) || !matches(RUN_ID, id) || typeof outsideContent !== "boolean") return undefined;
  if (reviewedHead !== undefined && !matches(HEAD, reviewedHead)) return undefined;
  const fixed: Fixed = { cycle, handles: { runId: id, ...(reviewedHead === undefined ? {} : { reviewedHead }) }, outsideContent };
  if (uncleared === undefined) return fixed;
  const unclearedRun = field(uncleared, "runId");
  const unclearedHead = field(uncleared, "head");
  if (!outsideContent || !matches(RUN_ID, unclearedRun) || !matches(HEAD, unclearedHead)) return undefined;
  return { ...fixed, unclearedHead: { runId: unclearedRun, head: unclearedHead } };
}

function storedParts(digest: unknown, fixed: Fixed): Parts {
  const omitted = zeroCounts();
  const received = field(digest, "omitted");
  for (const key of LISTS) omitted[key] = sanitize(field(received, key));
  return {
    fixed,
    claimsUnavailable: field(digest, "claimsUnavailable") === true,
    history: readHistory(field(digest, "history"), fixed.cycle),
    touched: unionTouched(readRows(field(digest, "touched"), readReceipt, omitted, "touched")),
    failures: foldFailures(readRows(field(digest, "failures"), readFailure, omitted, "failures")),
    ...claimLists(digest, field(digest, "criteria"), omitted),
    omitted,
  };
}

function claimLists(source: unknown, criteria: unknown, omitted: Counts): Pick<Parts, "decisions" | "open" | "criteria"> {
  return {
    decisions: unique(readRows(field(source, "decisions"), readDecision, omitted, "decisions"), row => JSON.stringify([row.what, row.why])),
    open: unique(readRows(field(source, "open"), readOpen, omitted, "open"), item => item),
    ...(Array.isArray(criteria) ? { criteria: unique(readRows(criteria, readCriterion, omitted, "criteria"), row => row.criterion) } : {}),
  };
}

function readRows<T>(list: unknown, read: (row: unknown) => T | undefined, omitted: Counts, key: (typeof LISTS)[number]): T[] {
  const rows: T[] = [];
  for (const row of listOf(list)) {
    const value = read(row);
    if (value === undefined) omitted[key] = add(omitted[key], 1);
    else rows.push(value);
  }
  return rows;
}

function readReceipt(row: unknown): Touched | undefined {
  const value = readTouched(row);
  return value?.by === "receipt" ? value : undefined;
}

const readOpen = (item: unknown): string | undefined => (typeof item === "string" ? cleanText(item) : undefined);

function readCriterion(row: unknown): Criterion | undefined {
  const criterion = field(row, "criterion");
  const status = CRITERION_STATUSES.find(option => option === field(row, "status"));
  const check = field(row, "check");
  if (typeof criterion !== "string" || status === undefined) return undefined;
  return { criterion: cleanText(criterion, CRITERION_BYTES), status, ...(typeof check === "string" ? { check: cleanText(check, CHECK_BYTES) } : {}) };
}

function foldFailures(rows: Failure[]): Failure[] {
  const receipts = unique(rows.filter(row => row.by === "receipt"), failureKey);
  const held = new Set(receipts.map(failureKey));
  return [...receipts, ...unique(rows.filter(row => row.by === "claim" && !held.has(failureKey(row))), failureKey)];
}

function readHistory(list: unknown, newest: number): History[] {
  const rows: History[] = [];
  let bound = newest;
  for (const row of listOf(list)) {
    const cycle = field(row, "cycle");
    const status = field(row, "status");
    const line = field(row, "line");
    if (!isCycle(cycle) || cycle > bound || !matches(CODE, status) || typeof line !== "string") continue;
    rows.push({ cycle, status, line: cleanText(line, LINE_BYTES) });
    bound = cycle - 1;
  }
  return rows;
}

function lineOf(ended: unknown, cycle: number): History | undefined {
  const status = field(ended, "status");
  const line = field(ended, "line");
  const kind = field(line, "kind");
  if (!matches(CODE, status)) return undefined;
  if (kind === "brief") {
    const title = field(line, "title");
    const outcome = field(line, "expectedOutcome");
    if (typeof title !== "string" || typeof outcome !== "string") return undefined;
    return { cycle, status, line: cleanText(`${cleanText(title, LINE_BYTES)}: ${cleanText(outcome, LINE_BYTES)}`, LINE_BYTES) };
  }
  if (kind !== "stop") return undefined;
  const block = field(line, "blockCode");
  const stop = field(line, "stopClass");
  if ((block !== undefined && !matches(CODE, block)) || (stop !== undefined && !matches(CODE, stop))) return undefined;
  const parts = [...(block === undefined ? [] : [`block ${block}`]), ...(stop === undefined ? [] : [`stop ${stop}`])];
  return parts.length === 0 ? undefined : { cycle, status, line: parts.join(", ") };
}

function assemble(parts: Parts): GoalDigest {
  const { fixed, omitted } = parts;
  const digest: GoalDigest = {
    v: 1,
    cycle: fixed.cycle,
    history: [],
    touched: parts.touched,
    failures: parts.failures.filter(row => row.by === "receipt"),
    decisions: [],
    open: [],
    ...(parts.criteria ? { criteria: [] } : {}),
    handles: fixed.handles,
    outsideContent: fixed.outsideContent,
    ...(fixed.unclearedHead ? { unclearedHead: fixed.unclearedHead } : {}),
    ...(parts.claimsUnavailable ? { claimsUnavailable: true as const } : {}),
    omitted,
  };
  const receiptBytes = () => goalDigestBytes({ ...digest, criteria: [], claimsUnavailable: true, omitted: WIDEST });
  const restBytes = () => goalDigestBytes({ ...digest, omitted: WIDEST });
  omitted.touched = add(omitted.touched, cut(digest.touched, CAPS.touched));
  omitted.failures = add(omitted.failures, cut(digest.failures, CAPS.failures));
  fit(digest, ["touched", "failures"], receiptBytes, () => true);
  const claims = { failures: parts.failures.filter(row => row.by === "claim"), decisions: parts.decisions, open: parts.open, criteria: parts.criteria };
  for (const key of ["failures", "decisions", "open", "criteria"] as const) {
    const rows = claims[key];
    const list = digest[key];
    if (rows === undefined || list === undefined) continue;
    omitted[key] = add(omitted[key], cut(rows, CAPS[key] - list.length));
    (list as unknown[]).push(...rows);
  }
  fit(digest, ["open", "decisions", "failures", "criteria"], restBytes, row => field(row, "by") !== "receipt");
  digest.history = parts.history.slice(0, CAPS.history);
  fit(digest, ["history"], restBytes, () => true);
  omitted.cycles = Math.min(OMITTED_MAX, digest.cycle - digest.history.length);
  return digest;
}

function cut(items: unknown[], max: number): number {
  return items.splice(Math.max(0, max)).length;
}

function fit(digest: GoalDigest, order: readonly ("history" | (typeof LISTS)[number])[], measure: () => number, droppable: (row: unknown) => boolean): void {
  for (const key of order) {
    const items: unknown[] | undefined = digest[key];
    if (items === undefined) continue;
    for (let index = items.length - 1; index >= 0 && measure() > GOAL_DIGEST_LIMIT_BYTES; index -= 1) {
      if (!droppable(items[index])) continue;
      items.splice(index, 1);
      if (key !== "history") digest.omitted[key] = add(digest.omitted[key], 1);
    }
  }
}

function checked(name: string, digest: GoalDigest): GoalDigest {
  if (!goalDigestSchema.safeParse(digest).success) {
    throw new Error(`${name} built a goal digest that fails the schema or the ${GOAL_DIGEST_LIMIT_BYTES}-byte bound`);
  }
  return digest;
}
