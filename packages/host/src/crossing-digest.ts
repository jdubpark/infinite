import { Buffer } from "node:buffer";
import { z } from "zod";
import { ownedPathSchema } from "./team-types.js";

// Crossing digest (design part 9). Pure: no I/O, clock, globals or model calls.
// Every list is newest first, so the oldest item is at the end of each array.

/** Byte bound for a whole digest, measured as JSON. Design part 9: "a digest is at most 2 KiB". */
export const DIGEST_LIMIT_BYTES = 2048;
const TEXT_BYTES = 240;
const SHORT_BYTES = 120;
const ID_LIMIT = 8;
const SIBLING_PATH_LIMIT = 8;
const CAPS = { touched: 24, decisions: 6, failures: 6, forSiblings: 4, open: 4 } as const;

const OPS = ["read", "changed", "added", "removed"] as const;
const OP_RANK: Record<(typeof OPS)[number], number> = { read: 0, changed: 1, added: 2, removed: 3 };
const OUTCOMES = ["complete", "partial", "failed", "refused"] as const;

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const boundedText = (max: number) => z.string().refine(value => bytes(value) <= max, `Use at most ${max} UTF-8 bytes`);
const text = boundedText(TEXT_BYTES);
const shortText = boundedText(SHORT_BYTES);
const authority = z.enum(["receipt", "claim"]);
const count = z.number().int().min(0);

export const crossingDigestSchema = z.object({
  v: z.literal(1),
  outcome: z.enum(OUTCOMES),
  touched: z.array(z.object({
    path: ownedPathSchema,
    ids: z.array(shortText).max(ID_LIMIT).optional(),
    op: z.enum(OPS),
    by: authority,
  }).strict()).max(CAPS.touched),
  decisions: z.array(z.object({ what: text, why: text }).strict()).max(CAPS.decisions),
  failures: z.array(z.object({
    signal: text,
    where: text.optional(),
    class: z.enum(["check", "stop", "refusal", "conflict", "claim"]),
    by: authority,
  }).strict()).max(CAPS.failures),
  forSiblings: z.array(z.object({
    note: text,
    paths: z.array(ownedPathSchema).max(SIBLING_PATH_LIMIT).optional(),
  }).strict()).max(CAPS.forSiblings),
  open: z.array(text).max(CAPS.open),
  // Proposed amendment: `forSiblings` and `open` counters, so every list reports what it drops (design part 9 gives none).
  omitted: z.object({
    touched: count,
    decisions: count,
    failures: count,
    forSiblings: count.optional(),
    open: count.optional(),
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

/** The lists a merge works on. Shared by digests and by claims that have not been assembled yet. */
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
  return { v: 1, outcome, touched: [], decisions: [], failures: [], forSiblings: [], open: [], omitted: counts({}) };
}

export function hostDigest(input: HostInput): CrossingDigest {
  const touched = unionTouched([
    ...(input.changed ?? []).map(change => ({ path: change.path, op: change.op, by: "receipt" as const })),
    ...(input.read ?? []).map(path => ({ path, op: "read" as const, by: "receipt" as const })),
  ]);
  const failures = latestFailures((input.failures ?? []).map(failure => ({
    signal: failure.signal,
    ...(failure.where === undefined ? {} : { where: failure.where }),
    class: failure.class,
    by: "receipt" as const,
  })));
  return assemble(input.outcome, { touched, decisions: [], failures, forSiblings: [], open: [], omitted: counts({}) });
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
    omitted: counts({}),
  };
  return assemble(digest.outcome, mergeLists(digest, fresh));
}

/** `b` is the newer digest. Its outcome wins, and its items come first in every list. */
export function mergeDigest(a: CrossingDigest, b: CrossingDigest): CrossingDigest {
  return assemble(b.outcome, mergeLists(a, b));
}

/**
 * Trims to the 2 KiB bound. Proposed rule: the design gives no trim order. Drop order is open, forSiblings,
 * decisions, claim touched, claim failures, receipt touched, receipt failures, oldest first within each.
 */
export function fitDigest(digest: CrossingDigest): CrossingDigest {
  const fit: CrossingDigest = {
    ...digest,
    touched: [...digest.touched],
    decisions: [...digest.decisions],
    failures: [...digest.failures],
    forSiblings: [...digest.forSiblings],
    open: [...digest.open],
    omitted: counts(digest.omitted),
  };
  const isClaim = (row: { by: string }) => row.by === "claim";
  const isReceipt = (row: { by: string }) => row.by === "receipt";
  const steps: [() => boolean, keyof Counts][] = [
    [() => dropOldest(fit.open), "open"],
    [() => dropOldest(fit.forSiblings), "forSiblings"],
    [() => dropOldest(fit.decisions), "decisions"],
    [() => dropOldest(fit.touched, isClaim), "touched"],
    [() => dropOldest(fit.failures, isClaim), "failures"],
    [() => dropOldest(fit.touched, isReceipt), "touched"],
    [() => dropOldest(fit.failures, isReceipt), "failures"],
  ];
  for (const [drop, counter] of steps) {
    while (digestBytes(fit) > DIGEST_LIMIT_BYTES && drop()) fit.omitted[counter] += 1;
  }
  return fit;
}

function counts(omitted: Partial<Omitted>): Counts {
  return {
    touched: omitted.touched ?? 0,
    decisions: omitted.decisions ?? 0,
    failures: omitted.failures ?? 0,
    forSiblings: omitted.forSiblings ?? 0,
    open: omitted.open ?? 0,
  };
}

function mergeLists(a: Lists, b: Lists): Lists {
  // `b` is newer, so its items precede `a`'s in every list.
  const left = counts(a.omitted);
  const right = counts(b.omitted);
  return {
    touched: unionTouched([...b.touched, ...a.touched]),
    decisions: unique([...b.decisions, ...a.decisions], item => JSON.stringify([item.what, item.why])),
    failures: latestFailures([...b.failures, ...a.failures]),
    forSiblings: unique([...b.forSiblings, ...a.forSiblings], item => item.note),
    open: unique([...b.open, ...a.open], item => item),
    omitted: {
      touched: left.touched + right.touched,
      decisions: left.decisions + right.decisions,
      failures: left.failures + right.failures,
      forSiblings: left.forSiblings + right.forSiblings,
      open: left.open + right.open,
    },
  };
}

/** Unions rows by path. A receipt beats a claim, and with equal authority the stronger operation wins. First-seen order is kept. */
function unionTouched(rows: Touched[]): Touched[] {
  const merged = new Map<string, Touched>();
  for (const row of rows) {
    const previous = merged.get(row.path);
    merged.set(row.path, previous ? joinTouched(previous, row) : row);
  }
  return [...merged.values()];
}

function joinTouched(previous: Touched, next: Touched): Touched {
  const winner = previous.by !== next.by
    ? (previous.by === "receipt" ? previous : next)
    : (OP_RANK[next.op] > OP_RANK[previous.op] ? next : previous);
  const ids = [...new Set([...(previous.ids ?? []), ...(next.ids ?? [])])];
  return { path: previous.path, op: winner.op, by: winner.by, ...(ids.length ? { ids } : {}) };
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

function unique<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalizes every list, then applies the caps. Text is clipped and invalid paths are dropped here, so every
 * builder goes through one check. Drops from a cap are counted in `omitted`. Superseded duplicates are not.
 */
function assemble(outcome: Outcome, lists: Lists): CrossingDigest {
  const omitted = counts(lists.omitted);
  const touched: Touched[] = [];
  for (const row of lists.touched) {
    if (!validPath(row.path)) {
      omitted.touched += 1;
      continue;
    }
    const ids = row.ids?.slice(0, ID_LIMIT).map(id => clip(id, SHORT_BYTES));
    touched.push({ path: row.path, op: row.op, by: row.by, ...(ids?.length ? { ids } : {}) });
  }
  const decisions = lists.decisions.map(item => ({ what: clip(item.what), why: clip(item.why) }));
  const failures: Failure[] = lists.failures.map(failure => ({
    signal: clip(failure.signal),
    ...(failure.where === undefined ? {} : { where: clip(failure.where) }),
    class: failure.class,
    by: failure.by,
  }));
  const forSiblings: Sibling[] = lists.forSiblings.map(sibling => {
    const paths = sibling.paths?.filter(validPath).slice(0, SIBLING_PATH_LIMIT);
    return { note: clip(sibling.note), ...(paths ? { paths } : {}) };
  });
  const open = lists.open.map(item => clip(item));

  const isClaim = (row: { by: string }) => row.by === "claim";
  omitted.touched += trimTo(touched, CAPS.touched, isClaim);
  omitted.decisions += trimTo(decisions, CAPS.decisions);
  omitted.failures += trimTo(failures, CAPS.failures, isClaim);
  omitted.forSiblings += trimTo(forSiblings, CAPS.forSiblings);
  omitted.open += trimTo(open, CAPS.open);
  return fitDigest({ v: 1, outcome, touched, decisions, failures, forSiblings, open, omitted });
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

function dropOldest<T>(items: T[], pick: (item: T) => boolean = () => true): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (pick(items[index])) {
      items.splice(index, 1);
      return true;
    }
  }
  return false;
}

function validPath(path: string): boolean {
  return ownedPathSchema.safeParse(path).success;
}

/** Clips at a code point boundary so the result is at most `max` UTF-8 bytes. */
function clip(value: string, max = TEXT_BYTES): string {
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
