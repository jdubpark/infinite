import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  OMITTED_MAX, boundedText, cleanText, crossingDigestSchema, failureKey, field, listOf, readDecision, readFailure, readTouched,
  sanitize, unionTouched, unique, type CrossingDigest,
} from "./crossing-digest.js";

/*
 * Goal digest (design part 10). Pure: no I/O, clock, globals or model calls. It carries a goal into its next cycle in
 * place of `previousWork`. Every list is newest first, so the oldest item sits at the end of each array.
 *
 * Input boundary. Arguments are JSON values as JSON.parse returns them, of any size. Objects with getters, proxies or a
 * toJSON method are outside the contract. Every function is total on such values, and its work is linear in the size
 * of its input: each row is read once, text is clipped as it is read, every list is cut to its cap before it is spread
 * into a call or fitted, and fitting therefore works on a digest whose size the caps bound.
 *
 * Authority boundary. Both arguments are host-owned. `previous` is a digest this module returned, and GoalService
 * builds `ended` from host records; EndedCycle says which of them exist today. Text that members wrote reaches `ended` in
 * three places only: the claim lists of `ended.run`, the brief of a `brief` line, and the criteria, whose statuses
 * record an evaluator's assessment. Every row is rebuilt from named fields, so no other field of any input reaches the
 * digest: no report, transcript, check output, score, rating, usage, routing decision or quarantined text. The run
 * digest's sibling notes and claim `touched` rows do not carry either, because part 10 has no field for them.
 *
 * Fields by authority.
 * - Receipts. `cycle`, `handles`, `outsideContent` and `unclearedHead` are host facts from the goal and run records.
 *   `touched` holds the receipt rows of run digests, which come from Git. A `failures` row of a host class comes from
 *   a check exit code, a stop reason or a refusal code. No member text reaches a receipt: claim rows of a run digest
 *   never enter `touched`, and a claim failure never replaces, reorders or evicts a receipt failure.
 * - Claims. `decisions`, `open` and failures of class `claim` are member notes. `criteria` is an agent assessment
 *   under C14, so it is a claim although the host passes it.
 * - History. A row's cycle and status are host facts. Its line is host vocabulary when made from a block code and a
 *   stop class, and text a project manager wrote when made from a brief. Both kinds are history, which is neither a
 *   receipt nor a claim: brief text reaches no field but `history[].line`.
 * - Host-computed. `omitted` and `claimsUnavailable`.
 *
 * PROPOSED tiers, which reconcile part 10's drop order with authority. `assemble` builds three tiers in turn. Receipts
 * are capped and fitted alone, as if no claim and no history existed. Claims then take the slots and bytes left, and
 * history takes what is left after them. At the bound the oldest history lines therefore go first, then claims, then
 * receipts, as part 10 orders, and neither a claim nor a history line can change a receipt's content, order or
 * survival. For the owner: a block line is a host fact, but as history it yields to claims at the bound, so a large
 * set of claims can evict every history line, the newest one included.
 *
 * PROPOSED refusal contract. A call returns undefined, throws nothing and invents no host fact when `ended` is not an
 * object, or has no valid `cycle`, `handles`, `outsideContent` or `unclearedHead`, or its `run` has no valid
 * outcome; and when `previous` is neither undefined nor an object with `v` 1 and those same host fields valid.
 * fitGoalDigest refuses the same way. Inside a usable argument a malformed row is dropped and counted, a malformed
 * history line or status leaves its cycle without a line, and no value is coerced to text.
 *
 * PROPOSED replay rule. GoalService builds the digest when it starts the next cycle, and a restart can repeat that.
 * An ended cycle whose number is not above `previous.cycle` changes nothing: the call returns `previous` refitted,
 * which for any digest this module returned is `previous` itself. Applying one ended cycle twice therefore gives the
 * digest of applying it once, and an older cycle cannot corrupt a digest. The first record applied for a cycle number
 * wins, so a corrected record for that cycle is ignored.
 */

/** Byte bound for a goal digest, measured as JSON (part 10). */
export const GOAL_DIGEST_LIMIT_BYTES = 8192;
const CAPS = { history: 16, touched: 24, failures: 6, decisions: 6, open: 4, criteria: 8 } as const;
/**
 * PROPOSED sizes and identifiers. A history line holds at most 240 bytes and a criterion 240, both in the normal form
 * of the text rule; a check label holds 120, per part 10. A status, block code and stop class are codes: a lower-case
 * letter, then up to 63 lower-case letters, digits or hyphens. A run id is a lower-case UUID. A head is a lower-case
 * Git object id of 40 or 64 hexadecimal digits. A cycle number is a safe integer of at least 1.
 */
const LINE_BYTES = 240;
const CRITERION_BYTES = 240;
const CHECK_BYTES = 120;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CRITERION_STATUSES = ["met", "not-met", "inconclusive", "pending-owner"] as const;
/** Counted lists. `omitted.cycles` is derived, never counted. */
const LISTS = ["touched", "failures", "decisions", "open", "criteria"] as const;

const code = z.string().regex(CODE);
const runId = z.string().regex(RUN_ID);
const head = z.string().regex(HEAD);
const cycleNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().min(0).max(OMITTED_MAX);
const crossing = crossingDigestSchema.shape;

/**
 * Checks shape, bounds and the byte bound, never provenance: a digest that passes is not thereby host-built.
 * PROPOSED counters. `omitted.cycles` is the number of cycles up to `cycle` without a history line: lines dropped by
 * the cap or the bound, malformed lines, and cycles never applied, such as those before a goal's first digest. It is
 * derived, so it needs no replay care. `decisions`, `open` and `criteria` get counters beside the three of part 10.
 * `touched` accumulates across cycles; the other list counters describe the last cycle only, like their lists. Each
 * adds the run digest's own counter for its list, which counts rows of both authorities, so claims change
 * `omitted.touched` and `omitted.failures` as well as the claim counters. Both mean "the list may be incomplete" and
 * never "a host fact was lost": seven claim failures beside no host failure give `omitted.failures` 1.
 * PROPOSED marker. `claimsUnavailable: true` stands for part 10's failure-mode row "marks claim fields unavailable":
 * the run digest's claim lists could not be read, so `decisions`, `open` and claim failures are empty for that reason.
 */
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

/**
 * What the ended cycle's history line is made from. `brief`: the cycle's brief, written by its project manager.
 * `stop`: host codes, at least one of the two. GoalService passes `stop` for a blocked, failed or stopped cycle.
 */
export type HistoryLineInput =
  | { kind: "brief"; title: string; expectedOutcome: string }
  | { kind: "stop"; blockCode?: string; stopClass?: string };

/** One C14 criterion as the evaluator last assessed it. The status is an agent assessment, a claim. */
export type CriterionInput = { criterion: string; status: (typeof CRITERION_STATUSES)[number]; check?: string };

/**
 * Host-owned: the facts of the cycle that ended, which GoalService passes when it starts the next cycle. The only
 * member text is named in the module comment. No field takes a report, transcript, check output, score, rating, usage
 * figure, routing decision or quarantined text.
 *
 * Sources. Records that exist today hold the cycle number, status, run id and reviewed head (the goal record's cycle:
 * `cycle`, `status`, `teamId`, `headCommit`), the brief (the cycle's `brief`), the block code (the run record's
 * `blockCode`) and the stop class (the cycle's `class` or the run's `stopReason`). Later slices supply the rest: no
 * production code stores or builds a run digest yet, so `run` and `claimsUnavailable` wait for the crossings slice;
 * no goal or run record holds an outside-content lineage, so `outsideContent` and `unclearedHead` wait for part 11;
 * and nothing produces C14 criteria rows, so `criteria` waits for C14.
 */
export type EndedCycle = {
  /** The number of the cycle that ended. Becomes the digest's `cycle`. */
  cycle: number;
  /** The cycle's status as the goal record holds it, such as `blocked` or `merged`. Goes into its history row. */
  status: string;
  /** What the cycle's history line is made from. */
  line: HistoryLineInput;
  /**
   * The cycle's run digest: the merge of the run's crossings, or, when the store is unavailable, hostDigest over the
   * run record. Its receipt `touched` rows join the goal's `touched`; its failures, decisions and open questions
   * describe the cycle that ended. Its claim lists are member JSON; the rest is host-owned.
   * PROPOSED, for the wiring slice: the `where` of a receipt failure must be host vocabulary, such as a check's
   * position in the run's check list, and never the text of a command. A check's command can come from a member's
   * report (TeamService copies a plan's `verification` into the checks it runs), and a receipt carries no member text.
   */
  run: CrossingDigest;
  /** True when the run digest's claim lists could not be read (the store was unavailable). */
  claimsUnavailable?: boolean;
  /** The evaluator's provisional status per named criterion. Absent when no evaluator assessed the cycle. */
  criteria?: CriterionInput[];
  /** The ended run's id, and its reviewed head when the cycle ended reviewed. */
  handles: { runId: string; reviewedHead?: string };
  /** Part 11: whether uncleared outside content applies to the next cycle's base, from the goal record's lineages. */
  outsideContent: boolean;
  /** Part 11: the run id and newest head of the uncleared entry that applies. Only with `outsideContent` true. */
  unclearedHead?: { runId: string; head: string };
};

/** Everything assemble needs. Lists hold normalized rows, newest first, before any cap or fit. */
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
/** The widest serialized counters, reserved whenever a digest is fitted. */
const WIDEST: Counts = { cycles: OMITTED_MAX, touched: OMITTED_MAX, failures: OMITTED_MAX, decisions: OMITTED_MAX, open: OMITTED_MAX, criteria: OMITTED_MAX };

/** Host-owned: `digest`. Its byte size as JSON, which says nothing about its provenance. */
export function goalDigestBytes(digest: GoalDigest): number {
  return jsonBytes(digest);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Host-owned: `previous` (undefined for a goal's first digest) and `ended`. Returns the digest for the next cycle, or
 * undefined by the refusal contract. Applies the replay rule when `ended.cycle` is not above `previous.cycle`.
 */
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
  /*
   * PROPOSED merge of `touched` across cycles: the ended run's receipt rows come first and fold with the carried rows
   * by crossing-digest.ts's rule, so the stronger operation and the union of ids win. For the owner: a path removed in
   * one cycle and added again in a later one reads as removed.
   */
  const fresh = readRows(field(run, "touched"), readTouched, omitted, "touched").filter(row => row.by === "receipt");
  omitted.touched = add(omitted.touched, sanitize(field(received, "touched")));
  /*
   * PROPOSED unresolved failures. The host decides, through the ended run's reviewed head: a cycle that ended without
   * one carries every failure of its run digest, receipts first and claims after them; a cycle with one carries none.
   * Failures never carry from an earlier cycle. For the owner: a failure that was fixed later in a blocked cycle still
   * carries, because a run digest keeps a failure without its later pass; a reviewed cycle's refusal or conflict does
   * not carry; and an earlier cycle's failure drops out once a later cycle ends, leaving only its history line.
   * PROPOSED handle. Acceptance 11's "check failure with its handle" is a failure row plus `handles.runId`. Every
   * failure row comes from that run, whose check receipts hold the output. For the owner: a row names no single check
   * entry, because a run digest's rows carry no handle; a reader finds the check by the run id and the row's `where`.
   */
  const unresolved = fixed.handles.reviewedHead === undefined;
  const failures = unresolved ? readRows(field(run, "failures"), readFailure, omitted, "failures") : [];
  if (unresolved) omitted.failures = add(omitted.failures, sanitize(field(received, "failures")));
  /*
   * PROPOSED last cycle only. `decisions`, `open` and `criteria` come from the ended cycle and replace the previous
   * digest's; they do not merge across cycles, so claims do not pile up and no stale claim outlives its cycle. For the
   * owner: the reasons behind an earlier cycle's changes do not reach later cycles, beyond its history line.
   */
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

/** Host-owned: `digest`. Re-normalizes a stored goal digest and fits it to the bound; it checks shape, not provenance. */
export function fitGoalDigest(digest: GoalDigest): GoalDigest | undefined {
  const stored = readStored(digest);
  return stored === undefined ? undefined : checked("fitGoalDigest", assemble(storedParts(digest, stored)));
}

/** The host fields of a stored goal digest, or undefined when it is unusable by the refusal contract. */
function readStored(digest: unknown): Fixed | undefined {
  return field(digest, "v") === 1 ? readFixed(digest) : undefined;
}

/**
 * The host fields shared by `ended` and a stored digest, or undefined when one is invalid.
 * PROPOSED outside content. `outsideContent` and `unclearedHead` come from the latest argument alone and are never
 * carried from `previous`, so an owner's clearance, recorded in the goal record, turns them off. An uncleared head
 * without `outsideContent` is a contradiction, and the argument is refused.
 */
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

/** A stored digest as parts: its own counters, plus every row it holds that is malformed. */
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

/**
 * Decisions and open questions from `source`, and criteria when `criteria` is an array. Duplicates fold into their
 * first row without a count.
 * PROPOSED criteria. `criteria` is present exactly when GoalService passes an array, and the first row per criterion
 * wins. A row with an unknown status is malformed. A check label that is not text is dropped and its row kept.
 */
function claimLists(source: unknown, criteria: unknown, omitted: Counts): Pick<Parts, "decisions" | "open" | "criteria"> {
  return {
    decisions: unique(readRows(field(source, "decisions"), readDecision, omitted, "decisions"), row => JSON.stringify([row.what, row.why])),
    open: unique(readRows(field(source, "open"), readOpen, omitted, "open"), item => item),
    ...(Array.isArray(criteria) ? { criteria: unique(readRows(criteria, readCriterion, omitted, "criteria"), row => row.criterion) } : {}),
  };
}

/** The rows `read` accepts. A malformed row is dropped and counted under `key`; a list that is not an array is empty. */
function readRows<T>(list: unknown, read: (row: unknown) => T | undefined, omitted: Counts, key: (typeof LISTS)[number]): T[] {
  const rows: T[] = [];
  for (const row of listOf(list)) {
    const value = read(row);
    if (value === undefined) omitted[key] = add(omitted[key], 1);
    else rows.push(value);
  }
  return rows;
}

/** A `touched` row of a goal digest: a claim row there is malformed. */
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

/**
 * Receipt failures first, the newest per signal and place; then claim failures whose signal and place no receipt
 * holds, by crossing-digest.ts's rule (h). A claim never displaces or reorders a receipt.
 */
function foldFailures(rows: Failure[]): Failure[] {
  const receipts = unique(rows.filter(row => row.by === "receipt"), failureKey);
  const held = new Set(receipts.map(failureKey));
  return [...receipts, ...unique(rows.filter(row => row.by === "claim" && !held.has(failureKey(row))), failureKey)];
}

/** Stored history rows: newest first, one per cycle, none after `newest`. A row that breaks this is malformed. */
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

/**
 * The ended cycle's history row, or undefined when its status or line is malformed.
 * PROPOSED line format. A `brief` line is "title: expected outcome", each part and then the whole normalized by the
 * text rule and clipped to 240 bytes, as `previousWork` joins them today. A `stop` line is "block CODE, stop CLASS",
 * with either part left out when absent, so it holds host codes only.
 */
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

/**
 * The single builder: the three tiers of the module comment. Each tier is capped, then fitted with every lower tier
 * empty, and a lower tier takes only the slots and bytes left. A digest that was fitted fits again unchanged.
 */
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
  /*
   * PROPOSED reserve: receipts are fitted as if every counter stood at OMITTED_MAX, `criteria` were present and empty,
   * and `claimsUnavailable` were set, so neither later counting nor the presence of claims takes receipt space. The
   * reserve is at most 57 bytes, so a receipt that would fit without it can be dropped. Claims and history are fitted
   * with the widest counters, at most 18 bytes.
   */
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
    // Cut to the cap first, so the spread passes at most CAPS[key] arguments.
    omitted[key] = add(omitted[key], cut(rows, CAPS[key] - list.length));
    (list as unknown[]).push(...rows);
  }
  fit(digest, ["open", "decisions", "failures", "criteria"], restBytes, row => field(row, "by") !== "receipt");
  digest.history = parts.history.slice(0, CAPS.history);
  fit(digest, ["history"], restBytes, () => true);
  omitted.cycles = Math.min(OMITTED_MAX, digest.cycle - digest.history.length);
  return digest;
}

/** Drops the oldest rows past `max`. Returns how many went. */
function cut(items: unknown[], max: number): number {
  return items.splice(Math.max(0, max)).length;
}

/**
 * PROPOSED trim order inside the tiers: receipts drop the oldest `touched` rows, then the oldest receipt failures;
 * claims drop the oldest open questions, then decisions, then claim failures, then criteria; history drops its
 * oldest lines. A receipt failure is never dropped in the claim tier. Each step drops the oldest droppable row of its
 * list until `measure` fits the bound, and counts it, except a history line, which `omitted.cycles` counts.
 */
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

/**
 * Every builder that returns a digest ends here. An internal invariant: the readers admit only valid rows and
 * assemble fits every tier, so no input reaches this throw. A failure is a bug in this module, not in the input.
 */
function checked(name: string, digest: GoalDigest): GoalDigest {
  if (!goalDigestSchema.safeParse(digest).success) {
    throw new Error(`${name} built a goal digest that fails the schema or the ${GOAL_DIGEST_LIMIT_BYTES}-byte bound`);
  }
  return digest;
}
