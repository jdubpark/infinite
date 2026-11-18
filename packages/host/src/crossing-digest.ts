import { Buffer } from "node:buffer";
import { z } from "zod";

// Crossing digest (design part 9). Pure: no I/O, clock, globals or model calls.
// Every list is newest first, so the oldest item sits at the end of each array.
// Callers pass parsed JSON (a member's report, a stored digest), so every exported builder reads its arguments as
// unknown values and is total over any JSON-like input: it never throws, and it never coerces a value to text.

/** Byte bound for a digest, measured as JSON. */
export const DIGEST_LIMIT_BYTES = 2048;
/** Counters saturate here. A counter at the cap means "this many or more". PROPOSED. */
export const OMITTED_MAX = 9999;
const TEXT_BYTES = 240;
const SHORT_BYTES = 120;
const PATH_BYTES = 300;
const ID_LIMIT = 8;
const SIBLING_PATH_LIMIT = 8;
const CAPS = { touched: 24, decisions: 6, failures: 6, forSiblings: 4, open: 4 } as const;
const OPS = ["read", "changed", "added", "removed"] as const;
const CHANGE_OPS = ["changed", "added", "removed"] as const;
const OP_RANK: Record<(typeof OPS)[number], number> = { read: 0, changed: 1, added: 2, removed: 3 };
const OUTCOMES = ["complete", "partial", "failed", "refused"] as const;
const CLASSES = ["check", "stop", "refusal", "conflict", "claim"] as const;
const HOST_CLASSES = ["check", "stop", "refusal", "conflict"] as const;
const AUTHORITIES = ["receipt", "claim"] as const;
const COUNTERS = ["touched", "decisions", "failures", "forSiblings", "open"] as const;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");
/** C0 and C1 controls, DEL, the line and paragraph separators, and the bidirectional controls. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** A literal repository path. Brackets, colons, spaces, backslashes and non-ASCII names are allowed. */
function isRepoPath(value: string): boolean {
  const size = bytes(value);
  return size >= 1 && size <= PATH_BYTES && !LONE_SURROGATE.test(value) && !CONTROL.test(value)
    && !value.startsWith("/") && !value.split("/").includes("..");
}

const boundedText = (max: number) => z.string().refine(
  value => bytes(value) <= max && !LONE_SURROGATE.test(value),
  `Use at most ${max} well-formed UTF-8 bytes`,
);
const text = boundedText(TEXT_BYTES);
const shortText = boundedText(SHORT_BYTES);
const repoPath = z.string().refine(isRepoPath, "Use a repository path of 1 to 300 UTF-8 bytes without control, separator or direction characters, lone surrogates, a leading slash or a .. segment");
const authority = z.enum(AUTHORITIES);
const counter = z.number().int().min(0).max(OMITTED_MAX);

/*
 * PROPOSED rules (design part 9 states none of them):
 * (a) `omitted` counts whole rows dropped by a cap, by the size trim, for an invalid path, or as malformed: a row
 *     that is not an object, lacks a required string, or holds an invalid enum value. A row folded into another
 *     row for the same path, failure or note is not counted. A list that is not an array reads as empty, and
 *     nothing is counted for it. An argument that is not an object reads as empty.
 * (b) `ids` and sibling `paths` are capped at 8 without a count. An entry in them that is not a string or not a
 *     valid path is dropped without a count. A malformed optional field (`ids`, `paths`, `where`) is dropped and
 *     its row kept.
 * (c) A received counter that is NaN, negative or not a number reads as 0, a fraction floors, and a value above
 *     the cap, Infinity included, reads as the cap. Counters saturate at OMITTED_MAX.
 * (d) hostDigest refuses class "claim" on a failure and "read" in `changed`, as HostInput types them.
 * `forSiblings` and `open` counters are a proposed amendment too.
 */
export const crossingDigestSchema = z.object({
  v: z.literal(1),
  outcome: z.enum(OUTCOMES),
  touched: z.array(z.object({
    path: repoPath,
    ids: z.array(shortText).max(ID_LIMIT).optional(),
    op: z.enum(OPS),
    by: authority,
  }).strict()).max(CAPS.touched),
  decisions: z.array(z.object({ what: text, why: text }).strict()).max(CAPS.decisions),
  failures: z.array(z.object({
    signal: text,
    where: text.optional(),
    class: z.enum(CLASSES),
    by: authority,
  }).strict()).max(CAPS.failures),
  forSiblings: z.array(z.object({
    note: text,
    paths: z.array(repoPath).max(SIBLING_PATH_LIMIT).optional(),
  }).strict()).max(CAPS.forSiblings),
  open: z.array(text).max(CAPS.open),
  omitted: z.object({
    touched: counter,
    decisions: counter,
    failures: counter,
    forSiblings: counter.optional(),
    open: counter.optional(),
  }).strict(),
}).strict();
export type CrossingDigest = z.infer<typeof crossingDigestSchema>;
type Touched = CrossingDigest["touched"][number];
type Failure = CrossingDigest["failures"][number];
type Decision = CrossingDigest["decisions"][number];
type Sibling = CrossingDigest["forSiblings"][number];
type Omitted = CrossingDigest["omitted"];
type Counts = Required<Omitted>;
type Outcome = CrossingDigest["outcome"];

/*
 * PROPOSED: an invalid or missing outcome reads as "failed", the outcome that claims least. "complete" and
 * "partial" claim finished work, and "refused" claims a cause (a refusal) that the host did not record. "failed"
 * claims neither.
 */
const FALLBACK_OUTCOME: Outcome = "failed";

export type HostInput = {
  outcome: Outcome;
  changed?: { path: string; op: "changed" | "added" | "removed" }[];
  read?: string[];
  failures?: { signal: string; where?: string; class: "check" | "stop" | "refusal" | "conflict" }[];
};

export type ClaimInput = {
  decisions?: { what: string; why: string }[];
  forSiblings?: { note: string; paths?: string[] }[];
  open?: string[];
  touched?: { path: string; ids?: string[]; op: (typeof OPS)[number] }[];
  failures?: { signal: string; where?: string }[];
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
/** An own property of an object. Anything else, an inherited property included, reads as missing. */
const field = (value: unknown, key: string): unknown => (isRow(value) && Object.hasOwn(value, key) ? value[key] : undefined);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isText = (value: unknown): value is string => typeof value === "string";
const isPath = (value: unknown): value is string => isText(value) && isRepoPath(value);
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find(option => option === value);

export function digestBytes(digest: CrossingDigest): number {
  return bytes(JSON.stringify(digest));
}

export function emptyDigest(outcome: Outcome): CrossingDigest {
  return checked("emptyDigest", combine(outcome, []));
}

export function hostDigest(input: HostInput): CrossingDigest {
  return checked("hostDigest", combine(field(input, "outcome"), [{
    touched: [
      ...listOf(field(input, "changed")).map(change => ({
        path: field(change, "path"),
        op: oneOf(CHANGE_OPS, field(change, "op")),
        by: "receipt",
      })),
      ...listOf(field(input, "read")).map(path => ({ path, op: "read", by: "receipt" })),
    ],
    failures: listOf(field(input, "failures")).map(failure => ({
      signal: field(failure, "signal"),
      where: field(failure, "where"),
      class: oneOf(HOST_CLASSES, field(failure, "class")),
      by: "receipt",
    })),
  }]));
}

/**
 * Adds member text as claims. Claim arrays are newest first, like digest arrays. A claim never replaces a receipt.
 * Rows are rebuilt from named fields, so a member's `by`, `class`, `outcome` or `omitted` never reaches the digest.
 */
export function withClaims(digest: CrossingDigest, claims: ClaimInput): CrossingDigest {
  const fresh = {
    touched: listOf(field(claims, "touched")).map(row => ({
      path: field(row, "path"),
      ids: field(row, "ids"),
      op: field(row, "op"),
      by: "claim",
    })),
    decisions: field(claims, "decisions"),
    failures: listOf(field(claims, "failures")).map(failure => ({
      signal: field(failure, "signal"),
      where: field(failure, "where"),
      class: "claim",
      by: "claim",
    })),
    forSiblings: field(claims, "forSiblings"),
    open: field(claims, "open"),
  };
  return checked("withClaims", combine(field(digest, "outcome"), [fresh, digest]));
}

/** `b` is the newer digest. Its outcome wins, and its items come first in every list. */
export function mergeDigest(a: CrossingDigest, b: CrossingDigest): CrossingDigest {
  return checked("mergeDigest", combine(field(b, "outcome"), [b, a]));
}

/** Re-normalizes any digest-shaped input, then trims it to the 2 KiB bound. */
export function fitDigest(digest: CrossingDigest): CrossingDigest {
  return checked("fitDigest", combine(field(digest, "outcome"), [digest]));
}

function zeroCounts(): Counts {
  return { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 };
}

/** A received counter as a count, by PROPOSED rule (c). */
function sanitize(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), OMITTED_MAX);
}

function add(a: number, b: number): number {
  return Math.min(OMITTED_MAX, a + b);
}

function bump(omitted: Omitted, key: keyof Counts, amount = 1): void {
  omitted[key] = add(omitted[key] ?? 0, amount);
}

/** Makes text well-formed (lone surrogates become U+FFFD) and clips it on a code point boundary. */
function clipText(value: string, max = TEXT_BYTES): string {
  return clip(value.replace(LONE_SURROGATES, "�"), max);
}

function clip(value: string, max: number): string {
  if (bytes(value) <= max) return value;
  let out = "";
  let used = 0;
  for (const character of value) {
    const size = bytes(character);
    if (used + size > max) break;
    out += character;
    used += size;
  }
  return out;
}

// Row readers. Each returns a normalized row, or undefined for a malformed row, which the caller counts.

function readTouched(row: unknown): Touched | undefined {
  const path = field(row, "path");
  const op = oneOf(OPS, field(row, "op"));
  const by = oneOf(AUTHORITIES, field(row, "by"));
  if (!isPath(path) || !op || !by) return undefined;
  const ids = listOf(field(row, "ids")).filter(isText).slice(0, ID_LIMIT).map(id => clipText(id, SHORT_BYTES));
  return { path, op, by, ...withIds(ids) };
}

function readDecision(row: unknown): Decision | undefined {
  const what = field(row, "what");
  const why = field(row, "why");
  return isText(what) && isText(why) ? { what: clipText(what), why: clipText(why) } : undefined;
}

function readFailure(row: unknown): Failure | undefined {
  const signal = field(row, "signal");
  const where = field(row, "where");
  const kind = oneOf(CLASSES, field(row, "class"));
  const by = oneOf(AUTHORITIES, field(row, "by"));
  if (!isText(signal) || !kind || !by) return undefined;
  return { signal: clipText(signal), ...(isText(where) ? { where: clipText(where) } : {}), class: kind, by };
}

function readSibling(row: unknown): Sibling | undefined {
  const note = field(row, "note");
  const paths = field(row, "paths");
  if (!isText(note)) return undefined;
  return { note: clipText(note), ...(Array.isArray(paths) ? { paths: paths.filter(isPath).slice(0, SIBLING_PATH_LIMIT) } : {}) };
}

const readOpen = (item: unknown): string | undefined => (isText(item) ? clipText(item) : undefined);

/**
 * The single builder. Reads every source through the row readers first (text clipped, malformed rows and invalid
 * paths dropped and counted), so every dedupe key is computed from the stored text. Then merges, applies the
 * caps, and trims to the size bound.
 */
function combine(outcome: unknown, sources: unknown[]): CrossingDigest {
  const omitted = zeroCounts();
  const touched: Touched[] = [];
  const decisions: Decision[] = [];
  const failures: Failure[] = [];
  const forSiblings: Sibling[] = [];
  const open: string[] = [];
  const collect = <T>(rows: unknown, read: (row: unknown) => T | undefined, into: T[], key: keyof Counts) => {
    for (const row of listOf(rows)) {
      const value = read(row);
      if (value === undefined) bump(omitted, key);
      else into.push(value);
    }
  };
  for (const source of sources) {
    const received = field(source, "omitted");
    for (const key of COUNTERS) omitted[key] = add(omitted[key], sanitize(field(received, key)));
    collect(field(source, "touched"), readTouched, touched, "touched");
    collect(field(source, "decisions"), readDecision, decisions, "decisions");
    collect(field(source, "failures"), readFailure, failures, "failures");
    collect(field(source, "forSiblings"), readSibling, forSiblings, "forSiblings");
    collect(field(source, "open"), readOpen, open, "open");
  }

  const digest: CrossingDigest = {
    v: 1,
    outcome: oneOf(OUTCOMES, outcome) ?? FALLBACK_OUTCOME,
    touched: unionTouched(touched),
    decisions: unique(decisions, item => JSON.stringify([item.what, item.why])),
    failures: latestFailures(failures),
    forSiblings: mergeSiblings(forSiblings),
    open: unique(open, item => item),
    omitted,
  };
  const isClaim = (row: { by: string }) => row.by === "claim";
  bump(omitted, "touched", trimTo(digest.touched, CAPS.touched, isClaim));
  bump(omitted, "decisions", trimTo(digest.decisions, CAPS.decisions));
  bump(omitted, "failures", trimTo(digest.failures, CAPS.failures, isClaim));
  bump(omitted, "forSiblings", trimTo(digest.forSiblings, CAPS.forSiblings));
  bump(omitted, "open", trimTo(digest.open, CAPS.open));
  return trimBytes(digest);
}

/** Unions rows by path. A receipt beats a claim, and with equal authority the stronger operation wins. */
function unionTouched(rows: Touched[]): Touched[] {
  const merged = new Map<string, Touched>();
  for (const row of rows) {
    const previous = merged.get(row.path);
    merged.set(row.path, previous ? joinTouched(previous, row) : row);
  }
  return [...merged.values()];
}

/** Across authorities the receipt's operation and ids stand alone, so member ids never reach a receipt. */
function joinTouched(previous: Touched, next: Touched): Touched {
  if (previous.by !== next.by) {
    const receipt = previous.by === "receipt" ? previous : next;
    return { path: receipt.path, op: receipt.op, by: "receipt", ...withIds(receipt.ids) };
  }
  const op = OP_RANK[next.op] > OP_RANK[previous.op] ? next.op : previous.op;
  const ids = [...new Set([...(previous.ids ?? []), ...(next.ids ?? [])])].slice(0, ID_LIMIT);
  return { path: previous.path, op, by: previous.by, ...withIds(ids) };
}

function withIds(ids: string[] | undefined): { ids?: string[] } {
  return ids?.length ? { ids } : {};
}

/** Keeps one failure per signal and place. The first row in the list wins, and a receipt beats a claim. */
function latestFailures(rows: Failure[]): Failure[] {
  const best = new Map<string, Failure>();
  for (const row of rows) {
    const key = JSON.stringify([row.signal, row.where ?? null]);
    const previous = best.get(key);
    if (!previous || (row.by === "receipt" && previous.by !== "receipt")) best.set(key, row);
  }
  return [...best.values()];
}

/** Sibling notes with the same text fold into one row whose paths are the union, capped at 8. */
function mergeSiblings(rows: Sibling[]): Sibling[] {
  const merged = new Map<string, Sibling>();
  for (const row of rows) {
    const previous = merged.get(row.note);
    if (!previous) {
      merged.set(row.note, row);
    } else if (previous.paths || row.paths) {
      const paths = [...new Set([...(previous.paths ?? []), ...(row.paths ?? [])])].slice(0, SIBLING_PATH_LIMIT);
      merged.set(row.note, { note: previous.note, paths });
    }
  }
  return [...merged.values()];
}

function unique<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Drops claims first, then the oldest rows, until the list fits. Returns how many rows went. */
function trimTo<T>(items: T[], max: number, isClaim: (item: T) => boolean = () => false): number {
  let dropped = 0;
  for (let index = items.length - 1; index >= 0 && items.length > max; index -= 1) {
    if (isClaim(items[index])) {
      items.splice(index, 1);
      dropped += 1;
    }
  }
  while (items.length > max) {
    items.pop();
    dropped += 1;
  }
  return dropped;
}

/**
 * Proposed trim order (design part 9 gives none): open, forSiblings, decisions, claim touched, claim failures,
 * receipt touched, receipt failures. Each step drops the oldest row of its kind until the digest fits.
 */
function trimBytes(digest: CrossingDigest): CrossingDigest {
  const dropOldest = <T>(items: T[], pick: (item: T) => boolean = () => true): boolean => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (pick(items[index])) {
        items.splice(index, 1);
        return true;
      }
    }
    return false;
  };
  const isClaim = (row: { by: string }) => row.by === "claim";
  const isReceipt = (row: { by: string }) => row.by === "receipt";
  const steps: [() => boolean, keyof Counts][] = [
    [() => dropOldest(digest.open), "open"],
    [() => dropOldest(digest.forSiblings), "forSiblings"],
    [() => dropOldest(digest.decisions), "decisions"],
    [() => dropOldest(digest.touched, isClaim), "touched"],
    [() => dropOldest(digest.failures, isClaim), "failures"],
    [() => dropOldest(digest.touched, isReceipt), "touched"],
    [() => dropOldest(digest.failures, isReceipt), "failures"],
  ];
  for (const [drop, counter] of steps) {
    while (digestBytes(digest) > DIGEST_LIMIT_BYTES && drop()) bump(digest.omitted, counter);
  }
  return digest;
}

/**
 * Every exported builder ends here. An internal invariant: the row readers above admit only valid rows, so no
 * input reaches this throw. A failure is a bug in this module, not in the caller's input.
 */
function checked(name: string, digest: CrossingDigest): CrossingDigest {
  if (!crossingDigestSchema.safeParse(digest).success || digestBytes(digest) > DIGEST_LIMIT_BYTES) {
    throw new Error(`${name} built a crossing digest that fails the schema or the ${DIGEST_LIMIT_BYTES}-byte bound`);
  }
  return digest;
}
