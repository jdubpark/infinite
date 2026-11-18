import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  DIGEST_LIMIT_BYTES,
  OMITTED_MAX,
  crossingDigestSchema,
  emptyDigest,
  fitDigest,
  hostDigest,
  mergeDigest,
  withClaims,
  type ClaimInput,
  type CrossingDigest,
  type HostInput,
} from "../packages/host/src/crossing-digest.js";

const OPS = ["read", "changed", "added", "removed"] as const;
type Op = (typeof OPS)[number];
const RANK: Record<Op, number> = { read: 0, changed: 1, added: 2, removed: 3 };
const OUTCOMES = ["complete", "partial", "failed", "refused"] as const;
const CLASSES = ["check", "stop", "refusal", "conflict"] as const;
const LISTS = ["touched", "decisions", "failures", "forSiblings", "open"] as const;
type ListName = (typeof LISTS)[number];

/** Independent measure: the test never calls the module's own byte helper. */
const measure = (digest: CrossingDigest) => Buffer.byteLength(JSON.stringify(digest), "utf8");

function valid(digest: CrossingDigest): CrossingDigest {
  crossingDigestSchema.parse(digest);
  assert.ok(measure(digest) <= DIGEST_LIMIT_BYTES, `digest is ${measure(digest)} bytes`);
  return digest;
}

function omittedOf(digest: CrossingDigest, list: ListName): number {
  return digest.omitted[list] ?? 0;
}

/** Every item given is either kept or counted in `omitted`. Holds when no two given items are duplicates. */
function assertAccounting(result: CrossingDigest, sources: CrossingDigest[], extra: Partial<Record<ListName, number>> = {}) {
  for (const list of LISTS) {
    const given = sources.reduce((sum, digest) => sum + digest[list].length, 0) + (extra[list] ?? 0);
    const dropped = omittedOf(result, list) - sources.reduce((sum, digest) => sum + omittedOf(digest, list), 0);
    assert.equal(result[list].length + dropped, given, `accounting for ${list}`);
  }
}

// Seeded generator: mulberry32 plus a per-run serial, so one seed always gives the same inputs.
type Random = () => number;
function prng(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Gen = { random: Random; serial: number; adversarial: boolean };
const generator = (seed: number, adversarial: boolean): Gen => ({ random: prng(seed), serial: 0, adversarial });
const int = (gen: Gen, min: number, max: number) => min + Math.floor(gen.random() * (max - min + 1));
const chance = (gen: Gen, odds: number) => gen.random() < odds;
function pick<T>(gen: Gen, items: readonly T[]): T {
  return items[int(gen, 0, items.length - 1)];
}
const tag = (gen: Gen) => `#${++gen.serial}`;

const WORDS = ["a", "b", "é", "漢", "Z", "0", "_", "ß", "[id]", ":", " ", "\\"];
const TEXT_CHARS = ["a", "é", "漢", "🙂", " "];
const HOSTILE_CHARS = ['"', "\\", "\u0007", "\n", " ", "\ud800", "\udc00", "🙂", "漢"];
const DUPLICATE_TEXT = ["shared note", "same signal", "\ud800", "x".repeat(300)];
const HOSTILE_PATHS = [
  "app/[id]/page.tsx", "a:b.ts", "x y/é.ts", "a/../b", "/abs", "line\nbreak.ts", "p".repeat(301), "back\\slash.ts", "\ud800.ts", "docs/é.md",
];

/** A unique path, up to about 260 characters with multi-byte names. Adversarial runs may pick a hostile one. */
function randomPath(gen: Gen): string {
  if (gen.adversarial && chance(gen, 0.3)) return pick(gen, HOSTILE_PATHS);
  const parts: string[] = [];
  let length = 0;
  const target = int(gen, 20, 240);
  while (length < target) {
    const part = Array.from({ length: int(gen, 1, 20) }, () => pick(gen, WORDS)).join("");
    parts.push(part);
    length += part.length + 1;
  }
  return `${parts.join("/")}/f${tag(gen)}.ts`;
}

/** Text with a unique tag, up to `maxChars` characters. Adversarial runs add quotes, controls and duplicates. */
function randomText(gen: Gen, maxChars: number): string {
  if (gen.adversarial && chance(gen, 0.2)) return pick(gen, DUPLICATE_TEXT);
  const pool = gen.adversarial ? [...TEXT_CHARS, ...HOSTILE_CHARS] : TEXT_CHARS;
  const body = Array.from({ length: int(gen, 0, maxChars) }, () => pick(gen, pool)).join("");
  return `${tag(gen)} ${body}`;
}

function randomHostInput(gen: Gen): Required<HostInput> {
  return {
    outcome: pick(gen, OUTCOMES),
    changed: Array.from({ length: int(gen, 0, 30) }, () => ({ path: randomPath(gen), op: pick(gen, ["changed", "added", "removed"] as const) })),
    read: Array.from({ length: int(gen, 0, 12) }, () => randomPath(gen)),
    failures: Array.from({ length: int(gen, 0, 9) }, () => ({
      signal: randomText(gen, 120),
      ...(chance(gen, 0.5) ? { where: randomText(gen, 120) } : {}),
      class: pick(gen, CLASSES),
    })),
  };
}

function randomClaims(gen: Gen): ClaimInput {
  return {
    decisions: Array.from({ length: int(gen, 0, 8) }, () => ({ what: randomText(gen, 150), why: randomText(gen, 150) })),
    forSiblings: Array.from({ length: int(gen, 0, 6) }, () => ({
      note: randomText(gen, 150),
      ...(chance(gen, 0.5) ? { paths: Array.from({ length: int(gen, 0, 10) }, () => randomPath(gen)) } : {}),
    })),
    open: Array.from({ length: int(gen, 0, 6) }, () => randomText(gen, 150)),
    touched: Array.from({ length: int(gen, 0, 10) }, () => ({
      path: randomPath(gen),
      op: pick(gen, OPS),
      ...(chance(gen, 0.5) ? { ids: Array.from({ length: int(gen, 0, 10) }, () => randomText(gen, 40)) } : {}),
    })),
    failures: Array.from({ length: int(gen, 0, 8) }, () => ({
      signal: randomText(gen, 150),
      ...(chance(gen, 0.5) ? { where: randomText(gen, 150) } : {}),
    })),
  };
}

/** Counters near the cap, including values above it. Adversarial runs only. */
function nearCap(gen: Gen, digest: CrossingDigest): CrossingDigest {
  const high = () => pick(gen, [OMITTED_MAX, OMITTED_MAX - int(gen, 0, 5), Number.MAX_SAFE_INTEGER]);
  return { ...digest, omitted: { touched: high(), decisions: high(), failures: high(), forSiblings: high(), open: high() } };
}

function claimCounts(claims: ClaimInput): Record<ListName, number> {
  return {
    touched: claims.touched?.length ?? 0,
    decisions: claims.decisions?.length ?? 0,
    failures: claims.failures?.length ?? 0,
    forSiblings: claims.forSiblings?.length ?? 0,
    open: claims.open?.length ?? 0,
  };
}

const long = (fill: string, count = 240) => fill.repeat(count);
/** Distinct ASCII text of `total` bytes, so duplicate-folding does not shrink the fixture. */
const numbered = (fill: string, index: number, total = 240) => `${index}${fill.repeat(total - String(index).length)}`;

test("empty and host-built digests are schema-valid and bounded", () => {
  valid(emptyDigest("refused"));
  const host = valid(hostDigest({
    outcome: "partial",
    changed: [{ path: "packages/host/src/a.ts", op: "changed" }, { path: "docs/new.md", op: "added" }],
    read: ["packages/host/src/b.ts"],
    failures: [{ signal: "exit 1", where: "npm run typecheck", class: "check" }],
  }));
  assert.deepEqual(host.touched, [
    { path: "packages/host/src/a.ts", op: "changed", by: "receipt" },
    { path: "docs/new.md", op: "added", by: "receipt" },
    { path: "packages/host/src/b.ts", op: "read", by: "receipt" },
  ]);
  assert.deepEqual(host.failures, [{ signal: "exit 1", where: "npm run typecheck", class: "check", by: "receipt" }]);
  assert.equal(host.outcome, "partial");
});

test("every list keeps its cap through hostDigest, withClaims and mergeDigest", () => {
  const changed = Array.from({ length: 30 }, (_, index) => ({ path: `src/file-${index}.ts`, op: "changed" as const }));
  const host = valid(hostDigest({ outcome: "partial", changed }));
  assert.equal(host.touched.length, 24);
  assert.equal(host.omitted.touched, 6);

  const decisions = Array.from({ length: 8 }, (_, index) => ({ what: `decision ${index}`, why: "why" }));
  const withDecisions = valid(withClaims(emptyDigest("complete"), { decisions }));
  assert.deepEqual(withDecisions.decisions.map(item => item.what), ["decision 0", "decision 1", "decision 2", "decision 3", "decision 4", "decision 5"]);
  assert.equal(withDecisions.omitted.decisions, 2);

  const withFailures = valid(withClaims(emptyDigest("failed"), { failures: Array.from({ length: 8 }, (_, index) => ({ signal: `signal ${index}` })) }));
  assert.equal(withFailures.failures.length, 6);
  assert.equal(withFailures.omitted.failures, 2);

  const withSiblings = valid(withClaims(emptyDigest("complete"), { forSiblings: Array.from({ length: 6 }, (_, index) => ({ note: `note ${index}` })) }));
  assert.equal(withSiblings.forSiblings.length, 4);
  assert.equal(withSiblings.omitted.forSiblings, 2);

  const open = valid(withClaims(emptyDigest("partial"), { open: ["a1", "a2", "a3", "a4", "a5", "a6"] }));
  assert.equal(open.open.length, 4);
  assert.equal(open.omitted.open, 2);

  const older = withClaims(emptyDigest("partial"), { open: ["a1", "a2", "a3"] });
  const newer = withClaims(emptyDigest("partial"), { open: ["b1", "b2", "b3"] });
  const merged = valid(mergeDigest(older, newer));
  assert.deepEqual(merged.open, ["b1", "b2", "b3", "a1"]);
  assert.equal(merged.omitted.open, 2);
});

test("a claim drops before a receipt when touched is over its cap", () => {
  const receipts = hostDigest({
    outcome: "complete",
    changed: Array.from({ length: 20 }, (_, index) => ({ path: `src/receipt-${index}.ts`, op: "changed" as const })),
  });
  const claimed = valid(withClaims(receipts, {
    touched: Array.from({ length: 10 }, (_, index) => ({ path: `src/claim-${index}.ts`, op: "added" as const })),
  }));
  assert.equal(claimed.touched.length, 24);
  assert.equal(claimed.touched.filter(row => row.by === "receipt").length, 20);
  assert.equal(claimed.omitted.touched, 6);
});

test("a claim never replaces a receipt for the same path, signal or place", () => {
  const receipt = hostDigest({
    outcome: "partial",
    changed: [{ path: "src/a.ts", op: "changed" }],
    failures: [{ signal: "exit 1", where: "tests", class: "check" }],
  });
  const claimed = withClaims(receipt, {
    touched: [{ path: "src/a.ts", op: "removed" }],
    failures: [{ signal: "exit 1", where: "tests" }],
  });
  assert.deepEqual(claimed.touched, receipt.touched);
  assert.deepEqual(claimed.failures, receipt.failures);
});

test("a receipt replaces a claim for the same path and signal, including its operation", () => {
  const claimOnly = withClaims(emptyDigest("partial"), {
    touched: [{ path: "src/a.ts", op: "added" }],
    failures: [{ signal: "exit 1", where: "tests" }],
  });
  const receipt = hostDigest({
    outcome: "partial",
    changed: [{ path: "src/a.ts", op: "changed" }],
    failures: [{ signal: "exit 1", where: "tests", class: "check" }],
  });
  const merged = mergeDigest(claimOnly, receipt);
  assert.deepEqual(merged.touched, [{ path: "src/a.ts", op: "changed", by: "receipt" }]);
  assert.deepEqual(merged.failures, [{ signal: "exit 1", where: "tests", class: "check", by: "receipt" }]);
});

test("member ids never reach a receipt row, in withClaims or in either merge order", () => {
  const receipt = hostDigest({ outcome: "partial", read: ["a"] });
  const claimed = withClaims(receipt, { touched: [{ path: "a", op: "removed", ids: ["MEMBER TEXT"] }] });
  assert.deepEqual(claimed.touched, [{ path: "a", op: "read", by: "receipt" }]);

  const claimOnly = withClaims(emptyDigest("partial"), { touched: [{ path: "a", op: "removed", ids: ["MEMBER TEXT"] }] });
  for (const merged of [mergeDigest(claimOnly, receipt), mergeDigest(receipt, claimOnly)]) {
    assert.deepEqual(merged.touched, [{ path: "a", op: "read", by: "receipt" }]);
    assert.equal(JSON.stringify(merged).includes("MEMBER TEXT"), false);
  }
});

test("equal-authority rows union their ids, newest first", () => {
  const older = withClaims(emptyDigest("partial"), { touched: [{ path: "a", op: "added", ids: ["x"] }] });
  const newer = withClaims(emptyDigest("partial"), { touched: [{ path: "a", op: "added", ids: ["y", "x"] }] });
  assert.deepEqual(mergeDigest(older, newer).touched, [{ path: "a", op: "added", by: "claim", ids: ["y", "x"] }]);
  const receiptA: CrossingDigest = { ...emptyDigest("partial"), touched: [{ path: "a", op: "read", by: "receipt", ids: ["p"] }] };
  const receiptB: CrossingDigest = { ...emptyDigest("partial"), touched: [{ path: "a", op: "changed", by: "receipt", ids: ["q"] }] };
  assert.deepEqual(mergeDigest(receiptA, receiptB).touched, [{ path: "a", op: "changed", by: "receipt", ids: ["q", "p"] }]);
});

function operationDigest(op: Op, by: "receipt" | "claim") {
  if (by === "claim") return withClaims(emptyDigest("partial"), { touched: [{ path: "src/p.ts", op }] });
  return hostDigest(op === "read"
    ? { outcome: "partial", read: ["src/p.ts"] }
    : { outcome: "partial", changed: [{ path: "src/p.ts", op }] });
}

test("for equal authority the stronger operation wins, for every pair", () => {
  for (const first of OPS) {
    for (const second of OPS) {
      const stronger = RANK[first] >= RANK[second] ? first : second;
      for (const by of ["receipt", "claim"] as const) {
        const forward = valid(mergeDigest(operationDigest(first, by), operationDigest(second, by)));
        const backward = valid(mergeDigest(operationDigest(second, by), operationDigest(first, by)));
        assert.equal(forward.touched[0]?.op, stronger, `${first} with ${second} as ${by}`);
        assert.equal(backward.touched[0]?.op, stronger, `${second} with ${first} as ${by}`);
      }
    }
  }
});

test("a receipt sets the operation whatever its strength when a claim is the other row", () => {
  for (const claimed of OPS) {
    for (const receipted of OPS) {
      const merged = valid(mergeDigest(operationDigest(claimed, "claim"), operationDigest(receipted, "receipt")));
      assert.deepEqual(merged.touched, [{ path: "src/p.ts", op: receipted, by: "receipt" }], `${receipted} receipt over ${claimed} claim`);
    }
  }
});

test("merge keeps the newest decisions and open questions first, without repeats", () => {
  const older = withClaims(emptyDigest("partial"), {
    decisions: [{ what: "use zod", why: "matches the host" }],
    open: ["older question"],
  });
  const newer = withClaims(emptyDigest("partial"), {
    decisions: [{ what: "keep schema", why: "strict objects" }],
    open: ["newer question"],
  });
  const merged = valid(mergeDigest(older, newer));
  assert.deepEqual(merged.decisions.map(item => item.what), ["keep schema", "use zod"]);
  assert.deepEqual(merged.open, ["newer question", "older question"]);
  assert.equal(valid(mergeDigest(older, older)).decisions.length, 1);
  assert.equal(mergeDigest(older, newer).outcome, "partial");
  assert.equal(mergeDigest(hostDigest({ outcome: "failed" }), hostDigest({ outcome: "complete" })).outcome, "complete");
});

test("merge keeps the latest failure per signal and place", () => {
  const first = hostDigest({ outcome: "failed", failures: [{ signal: "exit 1", where: "tests", class: "check" }] });
  const second = hostDigest({ outcome: "failed", failures: [{ signal: "exit 1", where: "tests", class: "stop" }] });
  assert.deepEqual(mergeDigest(first, second).failures, [{ signal: "exit 1", where: "tests", class: "stop", by: "receipt" }]);
  assert.deepEqual(mergeDigest(second, first).failures, [{ signal: "exit 1", where: "tests", class: "check", by: "receipt" }]);
  const otherPlace = hostDigest({ outcome: "failed", failures: [{ signal: "exit 1", where: "lint", class: "check" }] });
  assert.equal(mergeDigest(first, otherPlace).failures.length, 2);
});

test("sibling notes fold by note, newest first, with the union of their paths", () => {
  const older = withClaims(emptyDigest("complete"), { forSiblings: [{ note: "shared helper moved", paths: ["a"] }] });
  const newer = withClaims(emptyDigest("complete"), {
    forSiblings: [{ note: "shared helper moved", paths: ["b"] }, { note: "other note" }],
  });
  const merged = valid(mergeDigest(older, newer));
  assert.deepEqual(merged.forSiblings, [{ note: "shared helper moved", paths: ["b", "a"] }, { note: "other note" }]);
  assert.deepEqual(valid(mergeDigest(older, older)).forSiblings, [{ note: "shared helper moved", paths: ["a"] }]);
});

test("failures are deduplicated after clipping, so long signals that match after clipping fold to one row", () => {
  const older = hostDigest({ outcome: "failed", failures: [{ signal: long("a") + "1", class: "check" }] });
  const newer = hostDigest({ outcome: "failed", failures: [{ signal: long("a") + "2", class: "stop" }] });
  const merged = valid(mergeDigest(older, newer));
  assert.deepEqual(merged.failures, [{ signal: long("a"), class: "stop", by: "receipt" }]);
});

test("a lone surrogate becomes U+FFFD and the stored text is well formed", () => {
  const digest = valid(withClaims(emptyDigest("partial"), { open: ["\ud800"] }));
  assert.deepEqual(digest.open, ["�"]);
  assert.equal(digest.open[0].isWellFormed(), true);
});

test("counters saturate at the cap, and the result still passes the schema", () => {
  const atCap: CrossingDigest = { ...emptyDigest("partial"), omitted: { touched: OMITTED_MAX, decisions: OMITTED_MAX, failures: OMITTED_MAX, forSiblings: OMITTED_MAX, open: OMITTED_MAX } };
  const merged = valid(mergeDigest(atCap, atCap));
  assert.equal(merged.omitted.touched, OMITTED_MAX);
  assert.equal(merged.omitted.open, OMITTED_MAX);
  const huge: CrossingDigest = { ...emptyDigest("partial"), omitted: { touched: Number.MAX_SAFE_INTEGER, decisions: 0, failures: 0 } };
  assert.equal(valid(mergeDigest(huge, huge)).omitted.touched, OMITTED_MAX);
  assert.equal(valid(fitDigest(huge)).omitted.touched, OMITTED_MAX);
});

test("fitDigest on a digest at the cap with one oversized failure passes the schema", () => {
  const digest: CrossingDigest = {
    v: 1,
    outcome: "failed",
    touched: [],
    decisions: Array.from({ length: 6 }, () => ({ what: long("d"), why: long("w") })),
    failures: [{ signal: long("f"), where: long("g"), class: "check", by: "receipt" }],
    forSiblings: [],
    open: Array.from({ length: 4 }, () => long("o")),
    omitted: { touched: OMITTED_MAX, decisions: OMITTED_MAX, failures: OMITTED_MAX, forSiblings: OMITTED_MAX, open: OMITTED_MAX },
  };
  const fitted = valid(fitDigest(digest));
  assert.equal(fitted.omitted.touched, OMITTED_MAX);
  assert.equal(fitted.failures.length, 1);
});

test("fitDigest rebuilds its input: extra items, oversized text and unknown properties do not survive", () => {
  const five = fitDigest({ ...emptyDigest("partial"), open: ["1", "2", "3", "4", "5"].map(item => item.repeat(2)) });
  assert.equal(five.open.length, 4);
  assert.equal(five.omitted.open, 1);

  const wide = valid(fitDigest({ ...emptyDigest("partial"), open: ["a".repeat(241)] }));
  assert.equal(wide.open[0].length, 240);

  const extra = { ...emptyDigest("partial"), unknown: "x".repeat(3000) } as unknown as CrossingDigest;
  const stripped = valid(fitDigest(extra));
  assert.equal("unknown" in stripped, false);
  assert.ok(measure(stripped) < 500);
});

test("repository paths: Git names pass, and malformed or oversized paths are dropped and counted", () => {
  const kept = ["app/[id]/page.tsx", "a:b.ts", "a b/c.ts", "docs/é.md", "back\\slash.ts"];
  const dropped = ["a/../b", "/absolute.ts", "line\nbreak.ts", "p".repeat(301), "tab\tfile.ts"];
  const digest = hostDigest({
    outcome: "complete",
    changed: [...kept, ...dropped].map(path => ({ path, op: "added" as const })),
  });
  assert.deepEqual(digest.touched.map(row => row.path), kept);
  assert.equal(digest.omitted.touched, dropped.length);
});

test("sibling paths follow the same rule", () => {
  const digest = valid(withClaims(emptyDigest("complete"), { forSiblings: [{ note: "n", paths: ["app/[id]/x.ts", "a/../b", "/abs"] }] }));
  assert.deepEqual(digest.forSiblings, [{ note: "n", paths: ["app/[id]/x.ts"] }]);
});

const ORDER = ["open", "forSiblings", "decisions", "claimTouched", "claimFailures", "receiptTouched", "receiptFailures"] as const;
type Stage = (typeof ORDER)[number];

function survivors(digest: CrossingDigest): Record<Stage, number> {
  return {
    open: digest.open.length,
    forSiblings: digest.forSiblings.length,
    decisions: digest.decisions.length,
    claimTouched: digest.touched.filter(row => row.by === "claim").length,
    claimFailures: digest.failures.filter(row => row.by === "claim").length,
    receiptTouched: digest.touched.filter(row => row.by === "receipt").length,
    receiptFailures: digest.failures.filter(row => row.by === "receipt").length,
  };
}

/** A stage loses items only after every stage before it in the trim order has lost all of its items. */
function assertTrimOrder(before: CrossingDigest, after: CrossingDigest) {
  const given = survivors(before);
  const kept = survivors(after);
  ORDER.forEach((stage, index) => {
    if (kept[stage] < given[stage]) {
      for (const earlier of ORDER.slice(0, index)) {
        assert.equal(kept[earlier], 0, `${stage} dropped while ${earlier} still held ${kept[earlier]}`);
      }
    }
  });
}

test("trim order holds for an oversized digest, with the drops counted", () => {
  const oversized: CrossingDigest = {
    v: 1,
    outcome: "partial",
    touched: [
      ...Array.from({ length: 12 }, (_, index) => ({ path: `claim/${index}/${long("p", 200)}`, op: "changed" as const, by: "claim" as const })),
      ...Array.from({ length: 12 }, (_, index) => ({ path: `receipt/${index}/${long("q", 200)}`, op: "changed" as const, by: "receipt" as const })),
    ],
    decisions: Array.from({ length: 6 }, (_, index) => ({ what: numbered("d", index), why: numbered("w", index) })),
    failures: [
      ...Array.from({ length: 3 }, (_, index) => ({ signal: numbered("c", index), class: "claim" as const, by: "claim" as const })),
      ...Array.from({ length: 3 }, (_, index) => ({ signal: numbered("r", index), class: "check" as const, by: "receipt" as const })),
    ],
    forSiblings: Array.from({ length: 4 }, (_, index) => ({ note: numbered("s", index) })),
    open: Array.from({ length: 4 }, (_, index) => numbered("o", index)),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  assert.ok(measure(oversized) > DIGEST_LIMIT_BYTES);
  const fitted = valid(fitDigest(oversized));
  assertTrimOrder(oversized, fitted);
  assertAccounting(fitted, [oversized]);
});

test("trim order with literal survivors: the oldest open items go and the newest stay", () => {
  const digest: CrossingDigest = {
    v: 1,
    outcome: "complete",
    touched: [],
    decisions: Array.from({ length: 5 }, (_, index) => ({ what: `D${index}${long("d", 118)}`, why: long("w", 120) })),
    failures: [],
    forSiblings: [],
    open: ["O1", "O2", "O3", "O4"].map(prefix => `${prefix}${long("o", 238)}`),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  const fitted = valid(fitDigest(digest));
  assert.deepEqual(fitted.open, digest.open.slice(0, 2));
  assert.equal(fitted.omitted.open, 2);
  assert.deepEqual(fitted.decisions, digest.decisions);
});

test("fitDigest drops only open when open alone is enough", () => {
  const digest: CrossingDigest = {
    v: 1,
    outcome: "complete",
    touched: [],
    decisions: Array.from({ length: 6 }, (_, index) => ({ what: numbered("d", index, 100), why: numbered("w", index, 100) })),
    failures: [],
    forSiblings: [],
    open: Array.from({ length: 4 }, (_, index) => numbered("o", index)),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  const fitted = valid(fitDigest(digest));
  assert.equal(fitted.decisions.length, 6);
  assert.equal(fitted.open.length + (fitted.omitted.open ?? 0), 4);
});

test("receipt failures survive when only claims and open have to go", () => {
  const digest: CrossingDigest = {
    v: 1,
    outcome: "failed",
    touched: [],
    decisions: [],
    failures: Array.from({ length: 6 }, (_, index) => ({ signal: `${index}${long("r", 239)}`, class: "check" as const, by: "receipt" as const })),
    forSiblings: [],
    open: Array.from({ length: 4 }, (_, index) => numbered("o", index)),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  const fitted = valid(fitDigest(digest));
  assert.equal(fitted.open.length, 0);
  assert.equal(fitted.failures.filter(failure => failure.by === "receipt").length, 6);
  assert.equal(fitted.omitted.open, 4);
});

test("clipping keeps a prefix, stays within 240 bytes and never splits a character", () => {
  const cases = [
    "a".repeat(300),
    "é".repeat(150),
    "漢".repeat(100),
    "🙂".repeat(80),
    "a".repeat(239) + "é",
    "a".repeat(239) + "🙂",
    "é".repeat(120),
    "漢".repeat(81),
  ];
  for (const input of cases) {
    const digest = withClaims(emptyDigest("complete"), { open: [input] });
    const [output] = digest.open;
    assert.ok(Buffer.byteLength(output, "utf8") <= 240, `clipped ${input.slice(0, 8)} to ${Buffer.byteLength(output, "utf8")} bytes`);
    assert.equal(output.isWellFormed(), true);
    assert.ok(input.startsWith(output), "result is a prefix of the input");
    valid(digest);
  }
  assert.equal(withClaims(emptyDigest("complete"), { open: ["漢".repeat(100)] }).open[0], "漢".repeat(80));
  assert.equal(withClaims(emptyDigest("complete"), { open: ["🙂".repeat(80)] }).open[0], "🙂".repeat(60));
});

test("random inputs with unique text and paths stay valid, bounded and fully accounted for", () => {
  const gen = generator(304, false);
  for (let run = 0; run < 300; run += 1) {
    const input = randomHostInput(gen);
    const host = valid(hostDigest(input));
    assertAccounting(host, [], { touched: input.changed.length + input.read.length, failures: input.failures.length });

    const claims = randomClaims(gen);
    const claimed = valid(withClaims(host, claims));
    assertAccounting(claimed, [host], claimCounts(claims));

    let accumulated = claimed;
    for (let step = 0; step < 20; step += 1) {
      const next = valid(step % 2 ? hostDigest(randomHostInput(gen)) : withClaims(emptyDigest("partial"), randomClaims(gen)));
      const merged = valid(mergeDigest(accumulated, next));
      assertAccounting(merged, [accumulated, next]);
      accumulated = merged;
    }
  }
});

test("adversarial inputs (duplicates, hostile text and paths, counters near the cap) stay valid and bounded", () => {
  const gen = generator(9304, true);
  for (let run = 0; run < 300; run += 1) {
    const host = valid(hostDigest(randomHostInput(gen)));
    const claimed = valid(withClaims(host, randomClaims(gen)));
    let accumulated = valid(mergeDigest(emptyDigest("partial"), nearCap(gen, claimed)));
    for (let step = 0; step < 20; step += 1) {
      const next = step % 3 === 0
        ? nearCap(gen, hostDigest(randomHostInput(gen)))
        : withClaims(emptyDigest("partial"), randomClaims(gen));
      accumulated = valid(mergeDigest(accumulated, next));
    }
    assert.ok(measure(accumulated) <= DIGEST_LIMIT_BYTES);
  }
});

test("the same inputs give byte-identical digests on every run", () => {
  const run = () => {
    const gen = generator(77, true);
    const out: string[] = [];
    for (let step = 0; step < 50; step += 1) {
      const digest = mergeDigest(
        withClaims(emptyDigest("partial"), randomClaims(gen)),
        hostDigest(randomHostInput(gen)),
      );
      out.push(JSON.stringify(digest));
    }
    return out;
  };
  assert.deepEqual(run(), run());
});
