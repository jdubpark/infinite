import { Buffer } from "node:buffer";
import { z } from "zod";

/*
 * Crossing digest (design part 9). Pure: no I/O, clock, globals or model calls. Every list is newest first, so the
 * oldest item sits at the end of each array; `touched` and `failures` hold their receipts before their claims.
 *
 * Input boundary. Arguments are JSON values as JSON.parse returns them. Objects with getters, proxies or a toJSON
 * method are outside the contract. The output bounds do not bound processing time: the caller must bound the input
 * size, and claims must reach this module from a report whose schema bounds each list.
 *
 * Authority boundary. Every argument is host-owned except the claims argument of withClaims: the host builds it from
 * run state, Git and check results. Member JSON enters only through that claims argument, and every row read from it
 * becomes a claim. crossingDigestSchema checks shape, never provenance, so a digest that passes it is not thereby
 * host-built. A forged digest passed in a host-owned position keeps its receipts and outcome by design, so the
 * storage slice must never put member JSON there.
 *
 * PROPOSED refusal contract. A host-owned argument that is not an object or has no valid outcome refuses the call:
 * the builder returns undefined, throws nothing and invents no outcome (part 9: the outcome comes from run state and
 * is a receipt). Inside a valid host-owned argument, and anywhere in the claims argument, a malformed row is dropped
 * and counted, and no value is coerced to text. The claims argument never refuses a call.
 *
 * Claims are invisible to receipts. Receipt rows are the `touched` rows marked as receipts and the `failures` rows of
 * a host class. For every digest this module returned and every sequence of module calls on it, the receipt rows of
 * the result (their content, their order, and which ones survive every cap and the byte fit) are exactly those of the
 * same sequence with every claim removed. This holds by construction: `combine` folds, caps and fits the receipts of
 * each list alone, as if no claim existed, and only then lets claims take the slots and bytes that are left, for keys
 * no receipt holds (rule (f)).
 * PROPOSED order: within `touched` and `failures` every receipt precedes every claim, and each group is newest first.
 *
 * Receipt space. PROPOSED reserve: fitting measures a digest as if all five `omitted` counters stood at OMITTED_MAX
 * and the outcome were the widest one, so later counting or a newer outcome never takes receipt space. The reserve is
 * 0 to 17 bytes, so a receipt that would fit without it can be dropped: with the outcome `partial`, seven 229-byte
 * paths measure 2,047 bytes, and six are kept.
 */

/** Byte bound for a digest, measured as JSON. */
export const DIGEST_LIMIT_BYTES = 2048;
/** Counters saturate here, by rule (c). */
export const OMITTED_MAX = 9999;
/** PROPOSED sizes the design does not state: a failure's signal and place 240 bytes, an id 120, a path 300. */
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
/**
 * PROPOSED path rule: a literal repository path of 1 to 300 bytes, without a leading slash, a .. segment, a lone
 * surrogate, or any of C0 and C1 controls, DEL, the line and paragraph separators and the bidirectional controls.
 * Zero-width and tag characters (U+200B, U+2060, U+FEFF, U+E0000 to U+E007F) are kept, because real file names can
 * hold them; a presentation layer must show them.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/*
 * PROPOSED text rule (design part 9 states none). Text reaches other members' prompts, so every text field and every
 * id is normalized before any clipping. CR LF, a lone CR, U+2028 and U+2029 each become one line feed. Every other C0
 * control except tab and line feed, DEL, the C1 controls and the bidirectional controls of the path rule become a
 * visible escape: a backslash, "u{", the code point in lower-case hex without leading zeros, and "}", so U+0007 reads
 * as \u{7}. Every other character, ordinary whitespace included, is kept, and a lone surrogate becomes U+FFFD.
 * Clipping keeps whole characters and whole escapes, and normalizing twice equals normalizing once.
 * PROPOSED, for the owner: the escape form is not reversible. Text a member typed that looks like an escape cannot be
 * told from an escaped control character.
 * PROPOSED, for the owner: the schema refuses text that is not in this normal form, so a digest stored before this
 * rule needs a migration or a lenient read.
 */
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const LINE_BREAKS = new Set([0x0d, 0x2028, 0x2029]);

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** A literal repository path, by the path rule. Brackets, colons, spaces, backslashes and non-ASCII names pass. */
function isRepoPath(value: string): boolean {
  const size = bytes(value);
  return size >= 1 && size <= PATH_BYTES && !LONE_SURROGATE.test(value) && !CONTROL.test(value)
    && !value.startsWith("/") && !value.split("/").includes("..");
}

const boundedText = (max: number) => z.string().refine(
  value => bytes(value) <= max && !LONE_SURROGATE.test(value) && !UNSAFE_TEXT.test(value),
  `Use at most ${max} well-formed UTF-8 bytes in the normal form of the text rule`,
);
const text = boundedText(TEXT_BYTES);
const shortText = boundedText(SHORT_BYTES);
const repoPath = z.string().refine(isRepoPath, "Use a repository path of 1 to 300 UTF-8 bytes without control, separator or direction characters, lone surrogates, a leading slash or a .. segment");
const authority = z.enum(AUTHORITIES);
const counter = z.number().int().min(0).max(OMITTED_MAX);

/*
 * Rules design part 9 does not state, each proposed to the owner.
 * PROPOSED (a) `omitted` counts whole rows dropped by a cap, by the size trim, for an invalid path, or as malformed:
 *     a row that is not an object, lacks a required string, or holds an invalid enum value. A row folded into another
 *     row is not counted. A list that is not an array reads as empty, and nothing is counted for it. A claims
 *     argument that is not an object reads as empty.
 * PROPOSED (b) `ids` and sibling `paths` are capped at 8 without a count. An entry in them that is not a string or
 *     not a valid path is dropped without a count. A malformed optional field (`ids`, `paths`, `where`) is dropped
 *     and its row kept.
 * PROPOSED (c) A received counter that is NaN, negative or not a number reads as 0, a fraction floors, and a value
 *     above OMITTED_MAX, Infinity included, reads as OMITTED_MAX. Counters saturate there, and a counter at
 *     OMITTED_MAX means "this many or more".
 * PROPOSED (d) hostDigest refuses class "claim" on a failure and "read" in `changed`, as HostInput types them.
 * PROPOSED (e) A failure row is a receipt exactly when its class is a host class; a row whose `by` and `class`
 *     disagree is malformed.
 * PROPOSED (f) Folding: rows of one authority with the same path union their ids (at most 8) and keep the stronger
 *     operation; the newest failure per signal and place wins; sibling notes with the same text union their paths.
 *     A claim whose path, or signal and place, a receipt holds is folded into that receipt without a count, even
 *     when a cap or the fit later drops the receipt.
 * PROPOSED (g) `forSiblings` and `open` get counters in `omitted`, beside the three of the design.
 */
/** Checks shape, never provenance: a digest that passes is not thereby host-built. */
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
  }).strict().refine(row => (row.class === "claim") === (row.by === "claim"), "A failure is a claim exactly when its class is claim")).max(CAPS.failures),
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

/** The widest serialized counters and outcome, reserved whenever a digest is fitted. */
const WIDEST_COUNTS: Counts = { touched: OMITTED_MAX, decisions: OMITTED_MAX, failures: OMITTED_MAX, forSiblings: OMITTED_MAX, open: OMITTED_MAX };
const WIDEST_OUTCOME: Outcome = OUTCOMES.reduce((wide, next) => (next.length > wide.length ? next : wide));

/** Host-owned: the argument of hostDigest, built from run state, Git and check results. Never member JSON. */
export type HostInput = {
  outcome: Outcome;
  changed?: { path: string; op: "changed" | "added" | "removed" }[];
  read?: string[];
  failures?: { signal: string; where?: string; class: "check" | "stop" | "refusal" | "conflict" }[];
};

/** Member JSON: the claims argument of withClaims. The type documents the expected shape; any JSON value is read. */
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
const isReceipt = (row: unknown): boolean => field(row, "by") === "receipt";
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find(option => option === value);
/** The outcome of a host-owned argument, or undefined when it is not an object or has no valid outcome. */
const hostOutcome = (value: unknown): Outcome | undefined => oneOf(OUTCOMES, field(value, "outcome"));

/** Host-owned: `digest`. Its byte size as JSON, which says nothing about its provenance. */
export function digestBytes(digest: CrossingDigest): number {
  return bytes(JSON.stringify(digest));
}

/** Host-owned: `outcome`, from run state. Returns undefined when it is not a valid outcome. */
export function emptyDigest(outcome: Outcome): CrossingDigest | undefined {
  const valid = oneOf(OUTCOMES, outcome);
  return valid === undefined ? undefined : checked("emptyDigest", combine(valid, []));
}

/** Host-owned: all of `input`, from run state, Git and check results. Every row it yields is a receipt. */
export function hostDigest(input: HostInput): CrossingDigest | undefined {
  const outcome = hostOutcome(input);
  if (outcome === undefined) return undefined;
  return checked("hostDigest", combine(outcome, [{
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
 * Host-owned: `digest`. Member JSON: `claims`, the only argument where it may enter, read as any JSON value. Claim
 * arrays are newest first, like digest arrays. Rows are rebuilt from named fields, so a member's `by`, `class`,
 * `outcome` or `omitted` never reaches the digest, and no claim changes a receipt row.
 */
export function withClaims(digest: CrossingDigest, claims: ClaimInput): CrossingDigest | undefined {
  const outcome = hostOutcome(digest);
  if (outcome === undefined) return undefined;
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
  return checked("withClaims", combine(outcome, [fresh, digest]));
}

/** Host-owned: `a` and `b`. `b` is the newer digest. Its outcome wins, and its items come first in each group. */
export function mergeDigest(a: CrossingDigest, b: CrossingDigest): CrossingDigest | undefined {
  const outcome = hostOutcome(b);
  if (outcome === undefined || hostOutcome(a) === undefined) return undefined;
  return checked("mergeDigest", combine(outcome, [b, a]));
}

/** Host-owned: `digest`. Re-normalizes it and fits it to the bound; it checks shape, not provenance. */
export function fitDigest(digest: CrossingDigest): CrossingDigest | undefined {
  const outcome = hostOutcome(digest);
  return outcome === undefined ? undefined : checked("fitDigest", combine(outcome, [digest]));
}

function zeroCounts(): Counts {
  return { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 };
}

/** A received counter as a count, by rule (c). */
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

/**
 * Normalizes text by the text rule and clips it to `max` UTF-8 bytes in the same pass, one whole character or escape
 * at a time, so a clip never splits either. Reads no further than the clip.
 */
function cleanText(value: string, max = TEXT_BYTES): string {
  let out = "";
  let used = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index) ?? 0;
    let width = code > 0xffff ? 2 : 1;
    let token: string;
    if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) {
      token = "\n";
      width = 2;
    } else if (LINE_BREAKS.has(code)) {
      token = "\n";
    } else if (code >= 0xd800 && code <= 0xdfff) {
      token = "\ufffd";
    } else {
      const character = String.fromCodePoint(code);
      token = UNSAFE_TEXT.test(character) ? `\\u{${code.toString(16)}}` : character;
    }
    const size = bytes(token);
    if (used + size > max) break;
    out += token;
    used += size;
    index += width;
  }
  return out;
}

// Row readers. Each returns a normalized row, or undefined for a malformed row, which the caller counts.

function readTouched(row: unknown): Touched | undefined {
  const path = field(row, "path");
  const op = oneOf(OPS, field(row, "op"));
  const by = oneOf(AUTHORITIES, field(row, "by"));
  if (!isPath(path) || !op || !by) return undefined;
  const ids = listOf(field(row, "ids")).filter(isText).slice(0, ID_LIMIT).map(id => cleanText(id, SHORT_BYTES));
  return { path, op, by, ...withIds(ids) };
}

function readDecision(row: unknown): Decision | undefined {
  const what = field(row, "what");
  const why = field(row, "why");
  return isText(what) && isText(why) ? { what: cleanText(what), why: cleanText(why) } : undefined;
}

function readFailure(row: unknown): Failure | undefined {
  const signal = field(row, "signal");
  const where = field(row, "where");
  const kind = oneOf(CLASSES, field(row, "class"));
  const by = oneOf(AUTHORITIES, field(row, "by"));
  if (!isText(signal) || !kind || !by || (kind === "claim") !== (by === "claim")) return undefined;
  return { signal: cleanText(signal), ...(isText(where) ? { where: cleanText(where) } : {}), class: kind, by };
}

function readSibling(row: unknown): Sibling | undefined {
  const note = field(row, "note");
  const paths = field(row, "paths");
  if (!isText(note)) return undefined;
  return { note: cleanText(note), ...(Array.isArray(paths) ? { paths: paths.filter(isPath).slice(0, SIBLING_PATH_LIMIT) } : {}) };
}

const readOpen = (item: unknown): string | undefined => (isText(item) ? cleanText(item) : undefined);

const failureKey = (row: Failure) => JSON.stringify([row.signal, row.where ?? null]);

/**
 * The single builder. Reads every source through the row readers (text normalized and clipped, malformed rows and
 * invalid paths dropped and counted), so every dedupe key is computed from the stored text. Then builds the receipts
 * alone (fold, caps, fit) and lets claims fill what is left, which makes claims invisible to receipts.
 */
function combine(outcome: Outcome, sources: unknown[]): CrossingDigest {
  const omitted = zeroCounts();
  const rows = { touched: [] as Touched[], decisions: [] as Decision[], failures: [] as Failure[], forSiblings: [] as Sibling[], open: [] as string[] };
  const collect = <T>(list: unknown, read: (row: unknown) => T | undefined, into: T[], key: keyof Counts) => {
    for (const row of listOf(list)) {
      const value = read(row);
      if (value === undefined) bump(omitted, key);
      else into.push(value);
    }
  };
  for (const source of sources) {
    const received = field(source, "omitted");
    for (const key of COUNTERS) omitted[key] = add(omitted[key], sanitize(field(received, key)));
    collect(field(source, "touched"), readTouched, rows.touched, "touched");
    collect(field(source, "decisions"), readDecision, rows.decisions, "decisions");
    collect(field(source, "failures"), readFailure, rows.failures, "failures");
    collect(field(source, "forSiblings"), readSibling, rows.forSiblings, "forSiblings");
    collect(field(source, "open"), readOpen, rows.open, "open");
  }
  const [touched, claimTouched] = tiers(rows.touched, unionTouched, row => row.path);
  const [failures, claimFailures] = tiers(rows.failures, list => unique(list, failureKey), failureKey);
  const claims: Record<keyof Counts, unknown[]> = {
    touched: claimTouched,
    decisions: unique(rows.decisions, item => JSON.stringify([item.what, item.why])),
    failures: claimFailures,
    forSiblings: mergeSiblings(rows.forSiblings),
    open: unique(rows.open, item => item),
  };

  // Receipts alone, as if no claim existed: each list's cap, then the byte fit with every claim list empty.
  const digest: CrossingDigest = { v: 1, outcome, touched, decisions: [], failures, forSiblings: [], open: [], omitted };
  for (const key of COUNTERS) bump(omitted, key, cut(digest[key], CAPS[key]));
  fit(digest, ["touched", "failures"], () => true);
  // Claims take only the slots and bytes that are left, after the receipts of their list, and never move a receipt.
  for (const key of COUNTERS) {
    bump(omitted, key, cut(claims[key], CAPS[key] - digest[key].length));
    (digest[key] as unknown[]).push(...claims[key]);
  }
  fit(digest, ["open", "forSiblings", "decisions", "touched", "failures"], row => !isReceipt(row));
  return digest;
}

/**
 * Splits rows into receipts and claims and folds each group alone, so a claim never takes a receipt's position or
 * slot. A claim whose key a receipt holds is folded away without a count, as any folded row is.
 */
function tiers<T>(rows: T[], fold: (rows: T[]) => T[], key: (row: T) => string): [T[], T[]] {
  const receipts = rows.filter(isReceipt);
  const held = new Set(receipts.map(key));
  return [fold(receipts), fold(rows.filter(row => !isReceipt(row) && !held.has(key(row))))];
}

/** Folds rows of one authority by path: the stronger operation wins and ids are unioned, newest first. */
function unionTouched(rows: Touched[]): Touched[] {
  const merged = new Map<string, Touched>();
  for (const row of rows) {
    const previous = merged.get(row.path);
    if (!previous) {
      merged.set(row.path, row);
      continue;
    }
    const op = OP_RANK[row.op] > OP_RANK[previous.op] ? row.op : previous.op;
    const ids = [...new Set([...(previous.ids ?? []), ...(row.ids ?? [])])].slice(0, ID_LIMIT);
    merged.set(row.path, { path: previous.path, op, by: previous.by, ...withIds(ids) });
  }
  return [...merged.values()];
}

function withIds(ids: string[] | undefined): { ids?: string[] } {
  return ids?.length ? { ids } : {};
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

/** The first row per key, so the newest of each kept. */
function unique<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Drops the oldest rows past `max`. Returns how many went. */
function cut(items: unknown[], max: number): number {
  return items.splice(Math.max(0, max)).length;
}

/**
 * PROPOSED trim order (design part 9 gives none): receipts are fitted alone first, oldest receipt touched rows and then
 * oldest receipt failures; claims are fitted afterwards in the order open, forSiblings, decisions, claim touched,
 * claim failures. Each step drops the oldest droppable row of its list until the digest fits, measured with the
 * reserve.
 */
function fit(digest: CrossingDigest, order: readonly (keyof Counts)[], droppable: (row: unknown) => boolean): void {
  const reserved = () => digestBytes({ ...digest, outcome: WIDEST_OUTCOME, omitted: WIDEST_COUNTS });
  for (const key of order) {
    const items: unknown[] = digest[key];
    for (let index = items.length - 1; index >= 0 && reserved() > DIGEST_LIMIT_BYTES; index -= 1) {
      if (!droppable(items[index])) continue;
      items.splice(index, 1);
      bump(digest.omitted, key);
    }
  }
}

/**
 * Every builder that returns a digest ends here. An internal invariant: the row readers admit only valid rows, so no
 * input reaches this throw. A failure is a bug in this module, not in the caller's input.
 */
function checked(name: string, digest: CrossingDigest): CrossingDigest {
  if (!crossingDigestSchema.safeParse(digest).success || digestBytes(digest) > DIGEST_LIMIT_BYTES) {
    throw new Error(`${name} built a crossing digest that fails the schema or the ${DIGEST_LIMIT_BYTES}-byte bound`);
  }
  return digest;
}
