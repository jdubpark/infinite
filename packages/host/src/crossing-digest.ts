import { Buffer } from "node:buffer";
import { z } from "zod";

// Crossing digest (design part 9). Pure: no I/O, clock, globals or model calls.
// Every list is newest first, so the oldest item sits at the end of each array.

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
const OP_RANK: Record<(typeof OPS)[number], number> = { read: 0, changed: 1, added: 2, removed: 3 };
const OUTCOMES = ["complete", "partial", "failed", "refused"] as const;
const CLASSES = ["check", "stop", "refusal", "conflict", "claim"] as const;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");
const CONTROL = /[\u0000-\u001f\u007f]/;

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
const repoPath = z.string().refine(isRepoPath, "Use a repository path of 1 to 300 UTF-8 bytes without control characters, lone surrogates, a leading slash or a .. segment");
const authority = z.enum(["receipt", "claim"]);
const counter = z.number().int().min(0).max(OMITTED_MAX);

/*
 * PROPOSED rules (design part 9 states neither):
 * (a) `omitted` counts whole rows dropped by a cap, by the size trim, or for an invalid path. A row folded into
 *     another row for the same path, failure or note is not counted.
 * (b) `ids` and sibling `paths` are capped at 8 without a count.
 * Counters saturate at OMITTED_MAX. `forSiblings` and `open` counters are a proposed amendment too.
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

/** One source of rows, newest first. Every builder passes its rows through `combine`. */
type Lists = {
  touched: Touched[];
  decisions: Decision[];
  failures: Failure[];
  forSiblings: Sibling[];
  open: string[];
  omitted: Omitted;
};

export function digestBytes(digest: CrossingDigest): number {
  return bytes(JSON.stringify(digest));
}

export function emptyDigest(outcome: Outcome): CrossingDigest {
  return checked("emptyDigest", combine(outcome, []));
}

export function hostDigest(input: HostInput): CrossingDigest {
  return checked("hostDigest", combine(input.outcome, [{
    touched: [
      ...(input.changed ?? []).map(change => ({ path: change.path, op: change.op, by: "receipt" as const })),
      ...(input.read ?? []).map(path => ({ path, op: "read" as const, by: "receipt" as const })),
    ],
    decisions: [],
    failures: (input.failures ?? []).map(failure => ({
      signal: failure.signal,
      ...(failure.where === undefined ? {} : { where: failure.where }),
      class: failure.class,
      by: "receipt" as const,
    })),
    forSiblings: [],
    open: [],
    omitted: zeroCounts(),
  }]));
}

/** Adds member text as claims. Claim arrays are newest first, like digest arrays. A claim never replaces a receipt. */
export function withClaims(digest: CrossingDigest, claims: ClaimInput): CrossingDigest {
  const fresh: Lists = {
    touched: (claims.touched ?? []).map(row => ({ ...row, by: "claim" as const })),
    decisions: claims.decisions ?? [],
    failures: (claims.failures ?? []).map(failure => ({
      signal: failure.signal,
      ...(failure.where === undefined ? {} : { where: failure.where }),
      class: "claim" as const,
      by: "claim" as const,
    })),
    forSiblings: claims.forSiblings ?? [],
    open: claims.open ?? [],
    omitted: zeroCounts(),
  };
  return checked("withClaims", combine(digest.outcome, [fresh, digest]));
}

/** `b` is the newer digest. Its outcome wins, and its items come first in every list. */
export function mergeDigest(a: CrossingDigest, b: CrossingDigest): CrossingDigest {
  return checked("mergeDigest", combine(b.outcome, [b, a]));
}

/** Re-normalizes any digest-shaped input, then trims it to the 2 KiB bound. */
export function fitDigest(digest: CrossingDigest): CrossingDigest {
  return checked("fitDigest", combine(digest.outcome, [digest]));
}

function zeroCounts(): Counts {
  return { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 };
}

function sanitize(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), OMITTED_MAX) : 0;
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

/**
 * The single builder. Normalizes every source first (text clipped, invalid paths dropped and counted), so every
 * dedupe key is computed from the stored text. Then merges, applies the caps, and trims to the size bound.
 */
function combine(outcome: Outcome, sources: Lists[]): CrossingDigest {
  const omitted = zeroCounts();
  const touched: Touched[] = [];
  const decisions: Decision[] = [];
  const failures: Failure[] = [];
  const forSiblings: Sibling[] = [];
  const open: string[] = [];
  for (const source of sources) {
    const received = source.omitted;
    omitted.touched = add(omitted.touched, sanitize(received.touched));
    omitted.decisions = add(omitted.decisions, sanitize(received.decisions));
    omitted.failures = add(omitted.failures, sanitize(received.failures));
    omitted.forSiblings = add(omitted.forSiblings, sanitize(received.forSiblings));
    omitted.open = add(omitted.open, sanitize(received.open));
    for (const row of source.touched) {
      if (!isRepoPath(row.path)) {
        bump(omitted, "touched");
        continue;
      }
      const ids = row.ids?.slice(0, ID_LIMIT).map(id => clipText(id, SHORT_BYTES));
      touched.push({ path: row.path, op: row.op, by: row.by, ...(ids?.length ? { ids } : {}) });
    }
    for (const item of source.decisions) decisions.push({ what: clipText(item.what), why: clipText(item.why) });
    for (const failure of source.failures) {
      failures.push({
        signal: clipText(failure.signal),
        ...(failure.where === undefined ? {} : { where: clipText(failure.where) }),
        class: failure.class,
        by: failure.by,
      });
    }
    for (const sibling of source.forSiblings) {
      const paths = sibling.paths?.filter(isRepoPath).slice(0, SIBLING_PATH_LIMIT);
      forSiblings.push({ note: clipText(sibling.note), ...(paths ? { paths } : {}) });
    }
    for (const item of source.open) open.push(clipText(item));
  }

  const digest: CrossingDigest = {
    v: 1,
    outcome,
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

/** Every exported builder ends here. A failure is a bug in this module, not in the caller's input. */
function checked(name: string, digest: CrossingDigest): CrossingDigest {
  if (!crossingDigestSchema.safeParse(digest).success || digestBytes(digest) > DIGEST_LIMIT_BYTES) {
    throw new Error(`${name} built a crossing digest that fails the schema or the ${DIGEST_LIMIT_BYTES}-byte bound`);
  }
  return digest;
}
