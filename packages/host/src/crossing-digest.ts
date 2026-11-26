import { Buffer } from "node:buffer";
import { z } from "zod";

export const DIGEST_LIMIT_BYTES = 2048;
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
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const LINE_BREAKS = new Set([0x0d, 0x2028, 0x2029]);

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

function isRepoPath(value: string): boolean {
  const size = bytes(value);
  return size >= 1 && size <= PATH_BYTES && !LONE_SURROGATE.test(value) && !CONTROL.test(value)
    && !value.startsWith("/") && !value.split("/").includes("..");
}

export const boundedText = (max: number) => z.string().refine(
  value => bytes(value) <= max && !LONE_SURROGATE.test(value) && !UNSAFE_TEXT.test(value),
  `Use at most ${max} well-formed UTF-8 bytes in the normal form of the text rule`,
);
const rawBoundedText = (max: number) => z.string().refine(
  value => bytes(value) <= max,
  `Use at most ${max} UTF-8 bytes`,
);
const text = boundedText(TEXT_BYTES);
const shortText = boundedText(SHORT_BYTES);
const repoPath = z.string().refine(isRepoPath, "Use a repository path of 1 to 300 UTF-8 bytes without control, separator or direction characters, lone surrogates, a leading slash or a .. segment");
const authority = z.enum(AUTHORITIES);
const counter = z.number().int().min(0).max(OMITTED_MAX);
const MAX_PLAIN_DEPTH = 4;
const MAX_PLAIN_ARRAY = 64;
const MAX_PLAIN_KEYS = 32;

function digestObjectSchema<T extends z.ZodType<string>, S extends z.ZodType<string>>(
  textField: T,
  shortTextField: S,
) {
  return z.object({
    v: z.literal(1),
    outcome: z.enum(OUTCOMES),
    touched: z.array(z.object({
      path: repoPath,
      ids: z.array(shortTextField).max(ID_LIMIT).optional(),
      op: z.enum(OPS),
      by: authority,
    }).strict()).max(CAPS.touched),
    decisions: z.array(z.object({ what: textField, why: textField }).strict()).max(CAPS.decisions),
    failures: z.array(z.object({
      signal: textField,
      where: textField.optional(),
      class: z.enum(CLASSES),
      by: authority,
    }).strict().refine(row => (row.class === "claim") === (row.by === "claim"), "A failure is a claim exactly when its class is claim")).max(CAPS.failures),
    forSiblings: z.array(z.object({
      note: textField,
      paths: z.array(repoPath).max(SIBLING_PATH_LIMIT).optional(),
    }).strict()).max(CAPS.forSiblings),
    open: z.array(textField).max(CAPS.open),
    omitted: z.object({
      touched: counter,
      decisions: counter,
      failures: counter,
      forSiblings: counter.optional(),
      open: counter.optional(),
    }).strict(),
  }).strict();
}

export const crossingDigestSchema = digestObjectSchema(text, shortText);
export type CrossingDigest = z.infer<typeof crossingDigestSchema>;
type Touched = CrossingDigest["touched"][number];
type Failure = CrossingDigest["failures"][number];
type Decision = CrossingDigest["decisions"][number];
type Sibling = CrossingDigest["forSiblings"][number];
type Omitted = CrossingDigest["omitted"];
type Counts = Required<Omitted>;
type Outcome = CrossingDigest["outcome"];

const WIDEST_COUNTS: Counts = { touched: OMITTED_MAX, decisions: OMITTED_MAX, failures: OMITTED_MAX, forSiblings: OMITTED_MAX, open: OMITTED_MAX };
const WIDEST_OUTCOME: Outcome = OUTCOMES.reduce((wide, next) => (next.length > wide.length ? next : wide));

function reservedBytes(digest: CrossingDigest): number {
  return digestBytes({ ...digest, outcome: WIDEST_OUTCOME, omitted: WIDEST_COUNTS });
}

function isPlainTree(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") return true;
  if (depth > MAX_PLAIN_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_PLAIN_ARRAY && value.every(item => isPlainTree(item, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.hasOwn(value, "__proto__")) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_PLAIN_KEYS) return false;
  return keys.every(key => isPlainTree((value as Row)[key], depth + 1));
}

function foldFailures(rows: Failure[]): Failure[] {
  const [receipts, claims] = tiers(rows, list => unique(list, failureKey), failureKey);
  return [...receipts, ...claims];
}

function normalizeDigestText(digest: CrossingDigest): CrossingDigest {
  return {
    v: digest.v,
    outcome: digest.outcome,
    touched: digest.touched.map(row => ({
      path: row.path,
      op: row.op,
      by: row.by,
      ...(row.ids === undefined ? {} : { ids: row.ids.map(id => cleanText(id, SHORT_BYTES)) }),
    })),
    decisions: unique(
      digest.decisions.map(row => ({ what: cleanText(row.what), why: cleanText(row.why) })),
      item => JSON.stringify([item.what, item.why]),
    ),
    failures: foldFailures(digest.failures.map(row => ({
      signal: cleanText(row.signal),
      ...(row.where === undefined ? {} : { where: cleanText(row.where) }),
      class: row.class,
      by: row.by,
    }))),
    forSiblings: mergeSiblings(digest.forSiblings.map(row => ({
      note: cleanText(row.note),
      ...(row.paths === undefined ? {} : { paths: [...row.paths] }),
    }))),
    open: unique(digest.open.map(item => cleanText(item)), item => item),
    omitted: {
      touched: digest.omitted.touched,
      decisions: digest.omitted.decisions,
      failures: digest.omitted.failures,
      ...(digest.omitted.forSiblings === undefined ? {} : { forSiblings: digest.omitted.forSiblings }),
      ...(digest.omitted.open === undefined ? {} : { open: digest.omitted.open }),
    },
  };
}

function normalizeStoredDigest(digest: CrossingDigest): CrossingDigest {
  const normalized = normalizeDigestText(digest);
  const bounded = reservedBytes(normalized) <= DIGEST_LIMIT_BYTES
    ? normalized
    : combine(normalized.outcome, [normalized]);
  return checked("storedCrossingDigestSchema", bounded);
}

export const storedCrossingDigestSchema = z.unknown()
  .refine(value => isPlainTree(value), "Use a plain crossing digest object")
  .pipe(digestObjectSchema(rawBoundedText(TEXT_BYTES), rawBoundedText(SHORT_BYTES)))
  .refine(digest => digestBytes(digest) <= DIGEST_LIMIT_BYTES, `Use at most ${DIGEST_LIMIT_BYTES} bytes as JSON`)
  .transform(normalizeStoredDigest);

export function readStoredCrossingDigest(value: unknown): CrossingDigest | undefined {
  const parsed = storedCrossingDigestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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
export const field = (value: unknown, key: string): unknown => (isRow(value) && Object.hasOwn(value, key) ? value[key] : undefined);
export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isText = (value: unknown): value is string => typeof value === "string";
const isPath = (value: unknown): value is string => isText(value) && isRepoPath(value);
const isReceipt = (row: unknown): boolean => field(row, "by") === "receipt";
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find(option => option === value);
const hostOutcome = (value: unknown): Outcome | undefined => oneOf(OUTCOMES, field(value, "outcome"));

export function digestBytes(digest: CrossingDigest): number {
  return bytes(JSON.stringify(digest));
}

export function emptyDigest(outcome: Outcome): CrossingDigest | undefined {
  const valid = oneOf(OUTCOMES, outcome);
  return valid === undefined ? undefined : checked("emptyDigest", combine(valid, []));
}

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

export function mergeDigest(a: CrossingDigest, b: CrossingDigest): CrossingDigest | undefined {
  const outcome = hostOutcome(b);
  if (outcome === undefined || hostOutcome(a) === undefined) return undefined;
  return checked("mergeDigest", combine(outcome, [b, a]));
}

export function fitDigest(digest: CrossingDigest): CrossingDigest | undefined {
  const outcome = hostOutcome(digest);
  return outcome === undefined ? undefined : checked("fitDigest", combine(outcome, [digest]));
}

function zeroCounts(): Counts {
  return { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 };
}

export function sanitize(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), OMITTED_MAX);
}

function add(a: number, b: number): number {
  return Math.min(OMITTED_MAX, a + b);
}

function bump(omitted: Omitted, key: keyof Counts, amount = 1): void {
  omitted[key] = add(omitted[key] ?? 0, amount);
}

export function cleanText(value: string, max = TEXT_BYTES): string {
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

export function readTouched(row: unknown): Touched | undefined {
  const path = field(row, "path");
  const op = oneOf(OPS, field(row, "op"));
  const by = oneOf(AUTHORITIES, field(row, "by"));
  if (!isPath(path) || !op || !by) return undefined;
  const ids = listOf(field(row, "ids")).filter(isText).slice(0, ID_LIMIT).map(id => cleanText(id, SHORT_BYTES));
  return { path, op, by, ...withIds(ids) };
}

export function readDecision(row: unknown): Decision | undefined {
  const what = field(row, "what");
  const why = field(row, "why");
  return isText(what) && isText(why) ? { what: cleanText(what), why: cleanText(why) } : undefined;
}

export function readFailure(row: unknown): Failure | undefined {
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

export const failureKey = (row: Failure) => JSON.stringify([row.signal, row.where ?? null]);

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

  const digest: CrossingDigest = { v: 1, outcome, touched, decisions: [], failures, forSiblings: [], open: [], omitted };
  for (const key of COUNTERS) bump(omitted, key, cut(digest[key], CAPS[key]));
  fit(digest, ["touched", "failures"], () => true);
  for (const key of COUNTERS) {
    bump(omitted, key, cut(claims[key], CAPS[key] - digest[key].length));
    (digest[key] as unknown[]).push(...claims[key]);
  }
  fit(digest, ["open", "forSiblings", "decisions", "touched", "failures"], row => !isReceipt(row));
  return digest;
}

function tiers<T>(rows: T[], fold: (rows: T[]) => T[], key: (row: T) => string): [T[], T[]] {
  const receipts = rows.filter(isReceipt);
  const held = new Set(receipts.map(key));
  return [fold(receipts), fold(rows.filter(row => !isReceipt(row) && !held.has(key(row))))];
}

export function unionTouched(rows: Touched[]): Touched[] {
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

export function unique<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cut(items: unknown[], max: number): number {
  return items.splice(Math.max(0, max)).length;
}

function fit(digest: CrossingDigest, order: readonly (keyof Counts)[], droppable: (row: unknown) => boolean): void {
  for (const key of order) {
    const items: unknown[] = digest[key];
    for (let index = items.length - 1; index >= 0 && reservedBytes(digest) > DIGEST_LIMIT_BYTES; index -= 1) {
      if (!droppable(items[index])) continue;
      items.splice(index, 1);
      bump(digest.omitted, key);
    }
  }
}

function checked(name: string, digest: CrossingDigest): CrossingDigest {
  if (!crossingDigestSchema.safeParse(digest).success || digestBytes(digest) > DIGEST_LIMIT_BYTES) {
    throw new Error(`${name} built a crossing digest that fails the schema or the ${DIGEST_LIMIT_BYTES}-byte bound`);
  }
  return digest;
}
