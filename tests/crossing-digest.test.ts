import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  DIGEST_LIMIT_BYTES,
  crossingDigestSchema,
  digestBytes,
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

function valid(digest: CrossingDigest): CrossingDigest {
  crossingDigestSchema.parse(digest);
  assert.ok(digestBytes(digest) <= DIGEST_LIMIT_BYTES, `digest is ${digestBytes(digest)} bytes`);
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

// Seeded PRNG (mulberry32), so the random inputs are the same on every run.
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
const int = (random: Random, min: number, max: number) => min + Math.floor(random() * (max - min + 1));
function pick<T>(random: Random, items: readonly T[]): T {
  return items[int(random, 0, items.length - 1)];
}

let serial = 0;
const tag = () => `#${++serial}`;
const WORD_CHARS = ["a", "b", "é", "漢", "Z", "0", "_", "ß"];
const TEXT_CHARS = ["a", "é", "漢", "🙂", " "];

function word(random: Random, length: number): string {
  return Array.from({ length }, () => pick(random, WORD_CHARS)).join("");
}

/** Repository-relative, unique per call, up to about 260 characters, with multi-byte names. */
function randomPath(random: Random): string {
  const parts: string[] = [];
  let length = 0;
  const target = int(random, 20, 240);
  while (length < target) {
    const part = word(random, int(random, 1, 20));
    parts.push(part);
    length += part.length + 1;
  }
  return `${parts.join("/")}/f${tag()}.ts`;
}

/** Unique text with multi-byte characters, up to `maxChars` characters. */
function randomText(random: Random, maxChars: number): string {
  return `${tag()} ${Array.from({ length: int(random, 0, maxChars) }, () => pick(random, TEXT_CHARS)).join("")}`;
}

function randomHostInput(random: Random): Required<HostInput> {
  return {
    outcome: pick(random, OUTCOMES),
    changed: Array.from({ length: int(random, 0, 30) }, () => ({ path: randomPath(random), op: pick(random, ["changed", "added", "removed"] as const) })),
    read: Array.from({ length: int(random, 0, 12) }, () => randomPath(random)),
    failures: Array.from({ length: int(random, 0, 9) }, () => ({
      signal: randomText(random, 120),
      ...(random() < 0.5 ? { where: randomText(random, 120) } : {}),
      class: pick(random, CLASSES),
    })),
  };
}

function randomClaims(random: Random): ClaimInput {
  return {
    decisions: Array.from({ length: int(random, 0, 8) }, () => ({ what: randomText(random, 150), why: randomText(random, 150) })),
    forSiblings: Array.from({ length: int(random, 0, 6) }, () => ({
      note: randomText(random, 150),
      ...(random() < 0.5 ? { paths: Array.from({ length: int(random, 0, 10) }, () => randomPath(random)) } : {}),
    })),
    open: Array.from({ length: int(random, 0, 6) }, () => randomText(random, 150)),
    touched: Array.from({ length: int(random, 0, 10) }, () => ({
      path: randomPath(random),
      op: pick(random, OPS),
      ...(random() < 0.5 ? { ids: Array.from({ length: int(random, 0, 10) }, () => randomText(random, 40)) } : {}),
    })),
    failures: Array.from({ length: int(random, 0, 8) }, () => ({
      signal: randomText(random, 150),
      ...(random() < 0.5 ? { where: randomText(random, 150) } : {}),
    })),
  };
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

  const failures = Array.from({ length: 8 }, (_, index) => ({ signal: `signal ${index}` }));
  const withFailures = valid(withClaims(emptyDigest("failed"), { failures }));
  assert.equal(withFailures.failures.length, 6);
  assert.equal(withFailures.omitted.failures, 2);

  const siblings = Array.from({ length: 6 }, (_, index) => ({ note: `note ${index}` }));
  const withSiblings = valid(withClaims(emptyDigest("complete"), { forSiblings: siblings }));
  assert.equal(withSiblings.forSiblings.length, 4);
  assert.equal(withSiblings.omitted.forSiblings, 2);

  const open = withClaims(emptyDigest("partial"), { open: ["a1", "a2", "a3", "a4", "a5", "a6"] });
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

test("sibling notes are unique by note, newest first", () => {
  const older = withClaims(emptyDigest("complete"), { forSiblings: [{ note: "shared helper moved", paths: ["packages/host/src/a.ts"] }] });
  const newer = withClaims(emptyDigest("complete"), {
    forSiblings: [{ note: "shared helper moved", paths: ["packages/host/src/b.ts"] }, { note: "other note" }],
  });
  const merged = valid(mergeDigest(older, newer));
  assert.deepEqual(merged.forSiblings.map(item => item.note), ["shared helper moved", "other note"]);
  assert.deepEqual(merged.forSiblings[0].paths, ["packages/host/src/b.ts"]);
});

test("random inputs stay schema-valid, bounded and fully accounted for", () => {
  const random = prng(304);
  for (let run = 0; run < 300; run += 1) {
    const input = randomHostInput(random);
    const host = valid(hostDigest(input));
    assertAccounting(host, [], {
      touched: input.changed.length + input.read.length,
      failures: input.failures.length,
    });

    const claims = randomClaims(random);
    const claimed = valid(withClaims(host, claims));
    assertAccounting(claimed, [host], claimCounts(claims));

    let accumulated = claimed;
    for (let step = 0; step < 20; step += 1) {
      const next = valid(step % 2
        ? hostDigest(randomHostInput(random))
        : withClaims(emptyDigest("partial"), randomClaims(random)));
      const merged = valid(mergeDigest(accumulated, next));
      assertAccounting(merged, [accumulated, next]);
      accumulated = merged;
    }
  }
});

type Stage = "open" | "forSiblings" | "decisions" | "claimTouched" | "claimFailures" | "receiptTouched" | "receiptFailures";
const TRIM_ORDER: Stage[] = ["open", "forSiblings", "decisions", "claimTouched", "claimFailures", "receiptTouched", "receiptFailures"];

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
  TRIM_ORDER.forEach((stage, index) => {
    if (kept[stage] < given[stage]) {
      for (const earlier of TRIM_ORDER.slice(0, index)) {
        assert.equal(kept[earlier], 0, `${stage} dropped while ${earlier} still held ${kept[earlier]}`);
      }
    }
  });
}

const long = (fill: string, bytes = 240) => fill.repeat(bytes);
const row = (path: string, by: "receipt" | "claim") => ({ path, op: "changed" as const, by });

test("fitDigest drops open, then forSiblings, decisions, claim rows, and receipt failures last", () => {
  const oversized: CrossingDigest = {
    v: 1,
    outcome: "partial",
    touched: [
      ...Array.from({ length: 12 }, (_, index) => row(`claim/${index}/${long("p", 200)}`, "claim")),
      ...Array.from({ length: 12 }, (_, index) => row(`receipt/${index}/${long("q", 200)}`, "receipt")),
    ],
    decisions: Array.from({ length: 6 }, () => ({ what: long("d"), why: long("w") })),
    failures: [
      ...Array.from({ length: 3 }, () => ({ signal: long("c"), class: "claim" as const, by: "claim" as const })),
      ...Array.from({ length: 3 }, () => ({ signal: long("r"), class: "check" as const, by: "receipt" as const })),
    ],
    forSiblings: Array.from({ length: 4 }, () => ({ note: long("s") })),
    open: Array.from({ length: 4 }, () => long("o")),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  assert.ok(digestBytes(oversized) > DIGEST_LIMIT_BYTES);
  const fitted = valid(fitDigest(oversized));
  assertTrimOrder(oversized, fitted);
  assertAccounting(fitted, [oversized]);
});

test("fitDigest drops only open when open alone is enough", () => {
  const digest: CrossingDigest = {
    v: 1,
    outcome: "complete",
    touched: [],
    decisions: Array.from({ length: 6 }, () => ({ what: long("d", 100), why: long("w", 100) })),
    failures: [],
    forSiblings: [],
    open: Array.from({ length: 4 }, () => long("o")),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  assert.ok(digestBytes(digest) > DIGEST_LIMIT_BYTES);
  const fitted = valid(fitDigest(digest));
  assert.equal(fitted.decisions.length, 6);
  assert.ok(fitted.open.length < 4);
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
    open: Array.from({ length: 4 }, () => long("o")),
    omitted: { touched: 0, decisions: 0, failures: 0, forSiblings: 0, open: 0 },
  };
  assert.ok(digestBytes(digest) > DIGEST_LIMIT_BYTES);
  const fitted = valid(fitDigest(digest));
  assert.equal(fitted.open.length, 0);
  assert.equal(fitted.failures.filter(failure => failure.by === "receipt").length, 6);
  assert.equal(fitted.omitted.open, 4);
});

test("text longer than 240 bytes is clipped on a code point boundary", () => {
  const digest = withClaims(emptyDigest("complete"), {
    open: ["漢".repeat(100)],
    decisions: [{ what: "é".repeat(150), why: "short" }],
  });
  const [open] = digest.open;
  assert.equal(open, "漢".repeat(80));
  assert.ok(Buffer.byteLength(open, "utf8") <= 240);
  assert.equal(Buffer.from(open, "utf8").toString("utf8"), open);
  assert.equal(digest.decisions[0].what, "é".repeat(120));
  valid(digest);
});
