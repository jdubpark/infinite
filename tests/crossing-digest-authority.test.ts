import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as built from "../packages/host/src/crossing-digest.js";
import type { ClaimInput, CrossingDigest } from "../packages/host/src/crossing-digest.js";

// Receipt space under counter growth, and the text rule. Special characters are built from code points.

const { DIGEST_LIMIT_BYTES, OMITTED_MAX, crossingDigestSchema } = built;
type Outcome = CrossingDigest["outcome"];
const LISTS = ["touched", "decisions", "failures", "forSiblings", "open"] as const;

/** Independent measure: the test never calls the module's own byte helper. */
const measure = (digest: CrossingDigest) => Buffer.byteLength(JSON.stringify(digest), "utf8");
const utf8 = (value: string) => Buffer.byteLength(value, "utf8");

function valid(digest: CrossingDigest | undefined): CrossingDigest {
  assert.ok(digest, "a builder refused an argument the test meant as valid");
  crossingDigestSchema.parse(digest);
  assert.ok(measure(digest) <= DIGEST_LIMIT_BYTES, `digest is ${measure(digest)} bytes`);
  return digest;
}

/** Receipt rows in order, each with its keys in a canonical order. */
const receipts = (digest: CrossingDigest) => [...digest.touched, ...digest.failures]
  .filter(row => row.by === "receipt")
  .map(row => JSON.stringify(row, Object.keys(row).sort()));
const counts = (value: number) => ({ touched: value, decisions: value, failures: value, forSiblings: value, open: value });

test("regression: claims that only raise counters never evict a receipt", () => {
  const read = Array.from({ length: 7 }, (_, index) => String(index).padStart(2, "0") + "x".repeat(227));
  const host = valid(built.hostDigest({ outcome: "partial", read }));
  const claims = { open: Array.from({ length: 100 }, (_, index) => `q${index}`) };
  // Seven such receipts no longer fit beside the counter reserve, so the host digest keeps six and counts one.
  assert.equal(host.touched.length, 6);
  assert.equal(host.omitted.touched, 1);
  assert.deepEqual(receipts(valid(built.withClaims(host, claims))), receipts(host));
  const claimed = valid(built.withClaims(valid(built.emptyDigest("partial")), claims));
  assert.deepEqual(receipts(valid(built.mergeDigest(host, claimed))), receipts(host));
});

/** A stored host digest: five fixed receipt paths, one receipt path of `length` bytes, and a receipt failure. */
function storedHost(outcome: Outcome, count: number, length: number): CrossingDigest {
  return {
    v: 1,
    outcome,
    touched: [
      ...Array.from({ length: 5 }, (_, index) => ({ path: `r${index}/${"p".repeat(265)}`, op: "changed" as const, by: "receipt" as const })),
      { path: "v".repeat(length), op: "read", by: "receipt" },
    ],
    decisions: [],
    failures: [{ signal: "exit 1", where: "npm test", class: "check", by: "receipt" }],
    forSiblings: [],
    open: [],
    omitted: counts(count),
  };
}

/**
 * Host digests near the bound. A series fixes the outcome and the stored counters and steps the last path one byte
 * at a time. `bySize` keeps, for each size from 1,900 bytes up, the first digest reached in growth-prone order
 * (narrowest outcome and smallest counters first); `largest` keeps the largest digest of every series.
 */
function boundaryDigests() {
  const bySize = new Map<number, CrossingDigest>();
  const largest: CrossingDigest[] = [];
  const series: ((length: number) => CrossingDigest | undefined)[] = [
    length => built.hostDigest({
      outcome: "failed",
      changed: Array.from({ length: 5 }, (_, index) => ({ path: `r${index}/${"p".repeat(265)}`, op: "changed" as const })),
      read: ["v".repeat(length)],
      failures: [{ signal: "exit 1", where: "npm test", class: "check" }],
    }),
    ...(["failed", "complete"] as const).flatMap(outcome => [0, 9, 99, 999, OMITTED_MAX].map(count =>
      (length: number) => built.fitDigest(storedHost(outcome, count, length)))),
  ];
  for (const build of series) {
    let top: CrossingDigest | undefined;
    for (let length = 1; length <= 300; length += 1) {
      const digest = valid(build(length));
      const size = measure(digest);
      if (size >= 1900 && !bySize.has(size)) bySize.set(size, digest);
      if (!top || size > measure(top)) top = digest;
    }
    largest.push(valid(top));
  }
  return { bySize, largest };
}
const BOUNDARY = boundaryDigests();
const SWEEP = [...BOUNDARY.bySize.values(), ...BOUNDARY.largest];

/**
 * `count` rows in every list, none sharing a path or a signal with a receipt. Rows past the first 100 are malformed
 * unless `allValid`: dropped and counted exactly like rows over a cap, at a fraction of the cost.
 */
function claimRows(count: number, allValid = false): ClaimInput {
  const make = <T>(row: (index: number) => T) =>
    Array.from({ length: count }, (_, index) => (allValid || index < 100 ? row(index) : null));
  return {
    touched: make(index => ({ path: `claim/${index}.ts`, op: "added" as const, ids: [`id${index}`] })),
    decisions: make(index => ({ what: `decision ${index}`, why: "because" })),
    failures: make(index => ({ signal: `claim signal ${index}`, where: "member" })),
    forSiblings: make(index => ({ note: `note ${index}`, paths: [`claim/${index}.ts`] })),
    open: make(index => `question ${index}`),
  } as ClaimInput;
}

test("boundary sweep: withClaims keeps every receipt of a host digest from 1,900 to 2,048 bytes, whatever the claims", () => {
  for (let size = 1900; size <= DIGEST_LIMIT_BYTES; size += 1) assert.ok(BOUNDARY.bySize.has(size), `no host digest of ${size} bytes`);
  const claimSets = [0, 1, 10, 100, 10_000].map(count => [count, claimRows(count)] as const);
  for (const digest of SWEEP) {
    for (const [count, claims] of claimSets) {
      const where = `${measure(digest)}-byte ${digest.outcome} digest, counters ${digest.omitted.open}, ${count} rows per list`;
      const result = valid(built.withClaims(digest, claims));
      assert.deepEqual(receipts(result), receipts(digest), where);
      // The rows were dropped and counted: a list keeps at most 24 rows.
      for (const list of LISTS) {
        assert.ok((result.omitted[list] ?? 0) >= Math.min(OMITTED_MAX, (digest.omitted[list] ?? 0) + count - 24), `${where}: ${list}`);
      }
    }
  }
  const heavy = claimRows(10_000, true);
  for (const digest of BOUNDARY.largest) {
    assert.deepEqual(receipts(valid(built.withClaims(digest, heavy))), receipts(digest), `${measure(digest)} bytes, 10,000 valid rows`);
  }
});

test("mergeDigest keeps every receipt of the older digest when the newer one holds only counters or claims", () => {
  const countersOnly = valid(built.fitDigest({ ...valid(built.emptyDigest("complete")), omitted: counts(OMITTED_MAX) }));
  const claimsOnly = valid(built.withClaims(valid(built.emptyDigest("complete")), claimRows(100)));
  for (const digest of SWEEP) {
    for (const newer of [countersOnly, claimsOnly]) {
      const merged = valid(built.mergeDigest(digest, newer));
      assert.deepEqual(receipts(merged), receipts(digest), `${measure(digest)}-byte ${digest.outcome} digest`);
      assert.equal(merged.outcome, "complete");
    }
  }
});

// The text rule.

const char = (code: number) => String.fromCodePoint(code);
const escapeOf = (code: number) => "\\u{" + code.toString(16) + "}";
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const BIDI = [0x061c, 0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2066, 0x2069)];
/** Shown as a visible escape: C0 but tab, line feed and carriage return; DEL; C1; the bidirectional controls. */
const ESCAPED = [...range(0x00, 0x08), 0x0b, 0x0c, ...range(0x0e, 0x1f), 0x7f, ...range(0x80, 0x9f), ...BIDI];
const LONE_HIGH = String.fromCharCode(0xd800);
const kept = (value: string): [string, string] => [value, value];

/** [input, normalized] for each class of the text rule. */
const TEXT_CASES: [string, string][] = [
  ...ESCAPED.map((code): [string, string] => [`a${char(code)}b`, `a${escapeOf(code)}b`]),
  ["a\r\nb", "a\nb"], ["a\rb", "a\nb"], [`a${char(0x2028)}b`, "a\nb"], [`a${char(0x2029)}b`, "a\nb"],
  ["a\r\r\nb", "a\n\nb"], ["a\n\rb", "a\n\nb"],
  kept("a\tb"), kept("a\nb"), kept("a b"), kept(`a${char(0xa0)}b`), kept(`a${char(0x3000)}b`), kept(`a${char(0x200b)}b`),
  kept(`${char(0x1f469)}${char(0x200d)}${char(0x1f4bb)}`), kept("café 漢字 \u{1f642}"),
  kept(`typed ${escapeOf(0x202e)} by a member`),
  [`a${LONE_HIGH}b`, `a${char(0xfffd)}b`],
];

/** The seven text positions a digest holds: what, why, open, note, signal, where, and an id. */
const textFields = (digest: CrossingDigest) => [
  digest.decisions[0]?.what, digest.decisions[0]?.why, digest.open[0], digest.forSiblings[0]?.note,
  digest.failures[0]?.signal, digest.failures[0]?.where, digest.touched[0]?.ids?.[0],
];

test("text rule: each character class in every text field and in ids, through every builder that reads text", () => {
  const empty = valid(built.emptyDigest("partial"));
  for (const [input, expected] of TEXT_CASES) {
    const label = JSON.stringify(input);
    const want = Array.from({ length: 7 }, () => expected);
    const claims: ClaimInput = {
      decisions: [{ what: input, why: input }],
      open: [input],
      forSiblings: [{ note: input }],
      failures: [{ signal: input, where: input }],
      touched: [{ path: "src/a.ts", op: "read", ids: [input] }],
    };
    const stored: CrossingDigest = {
      v: 1,
      outcome: "partial",
      touched: [{ path: "src/a.ts", op: "read", by: "receipt", ids: [input] }],
      decisions: [{ what: input, why: input }],
      failures: [{ signal: input, where: input, class: "check", by: "receipt" }],
      forSiblings: [{ note: input }],
      open: [input],
      omitted: counts(0),
    };
    assert.deepEqual(textFields(valid(built.withClaims(empty, claims))), want, `withClaims ${label}`);
    assert.deepEqual(textFields(valid(built.fitDigest(stored))), want, `fitDigest ${label}`);
    assert.deepEqual(textFields(valid(built.mergeDigest(stored, empty))), want, `mergeDigest older ${label}`);
    assert.deepEqual(textFields(valid(built.mergeDigest(empty, stored))), want, `mergeDigest newer ${label}`);
    const host = valid(built.hostDigest({ outcome: "failed", failures: [{ signal: input, where: input, class: "check" }] }));
    assert.deepEqual([host.failures[0]?.signal, host.failures[0]?.where], [expected, expected], `hostDigest ${label}`);
  }
});

test("text rule: the reproduction keeps no override, and the schema refuses raw control text", () => {
  const empty = valid(built.emptyDigest("partial"));
  assert.deepEqual(valid(built.withClaims(empty, { open: [`A${char(0x202e)}B`] })).open, [`A${escapeOf(0x202e)}B`]);
  for (const code of [...ESCAPED, 0x0d, 0x2028, 0x2029]) {
    const raw = { ...empty, open: [`a${char(code)}b`] };
    assert.equal(crossingDigestSchema.safeParse(raw).success, false, `schema accepted U+${code.toString(16)} in text`);
  }
});

/** Independent reference: the whole input normalized with replace, without clipping. */
function normalizedWhole(value: string): string {
  const unsafe = new RegExp(`[${ESCAPED.map(code => `\\u{${code.toString(16)}}`).join("")}]`, "gu");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  return value.replace(lone, char(0xfffd))
    .replace(new RegExp(`\\r\\n|[\\r${char(0x2028)}${char(0x2029)}]`, "g"), "\n")
    .replace(unsafe, found => escapeOf(found.codePointAt(0) ?? 0));
}

test("text rule: a clip keeps whole escapes, line breaks and characters, is maximal, and normalizing twice changes nothing", () => {
  const empty = valid(built.emptyDigest("partial"));
  const viaOpen = (value: string) => valid(built.withClaims(empty, { open: [value] })).open[0] ?? "";
  const viaId = (value: string) => valid(built.withClaims(empty, { touched: [{ path: "src/a.ts", op: "read", ids: [value] }] })).touched[0]?.ids?.[0] ?? "";
  const tails = [...ESCAPED.map(char), "\r\n", "\r", char(0x2028), char(0x1f642), "é", "漢", LONE_HIGH];
  for (const [clean, max] of [[viaOpen, 240], [viaId, 120]] as const) {
    for (const tail of tails) {
      for (let lead = max - 16; lead <= max + 1; lead += 1) {
        const input = "a".repeat(lead) + tail + "bc";
        const text = clean(input);
        const whole = normalizedWhole(input);
        const tokens = whole.match(/\\u\{[0-9a-f]+\}|[\s\S]/gu) ?? [];
        const where = `${max}-byte field, ${lead} leading bytes, tail U+${(tail.codePointAt(0) ?? 0).toString(16)}`;
        assert.ok(utf8(text) <= max && text.isWellFormed(), where);
        assert.equal(clean(text), text, `${where}: not idempotent`);
        // The result is a prefix of the whole normalized text, cut between whole tokens, and the next token would not fit.
        let prefix = "";
        for (const token of tokens) {
          if (utf8(prefix + token) > max) break;
          prefix += token;
        }
        assert.equal(text, prefix, where);
      }
    }
  }
  // Literal cases: an escape that would cross the bound is dropped whole.
  const bidi = char(0x202e);
  assert.equal(viaOpen("a".repeat(236) + bidi), "a".repeat(236));
  assert.equal(viaOpen("a".repeat(232) + bidi), "a".repeat(232) + escapeOf(0x202e));
  assert.equal(viaOpen("a".repeat(239) + "\r\n"), "a".repeat(239) + "\n");
  assert.equal(viaId("a".repeat(116) + char(0x07)), "a".repeat(116));
  assert.equal(viaId("a".repeat(115) + char(0x07)), "a".repeat(115) + escapeOf(0x07));
  // Escape-shaped text typed by a member is ordinary text: kept, and stable under a second pass.
  const typed = `${"a".repeat(236)}${escapeOf(0x202e)}`;
  assert.equal(viaOpen(viaOpen(typed)), viaOpen(typed));
});

test("text rule: text made only of expanding characters stays within every bound", () => {
  const empty = valid(built.emptyDigest("partial"));
  for (const code of [0x202e, 0x01, 0x85]) {
    const fill = (index: number) => `${index}${char(code).repeat(240)}`;
    const rows = (count: number) => Array.from({ length: count }, (_, index) => index);
    const claims: ClaimInput = {
      decisions: rows(6).map(index => ({ what: fill(index), why: fill(index) })),
      open: rows(4).map(fill),
      forSiblings: rows(4).map(index => ({ note: fill(index) })),
      failures: rows(6).map(index => ({ signal: fill(index), where: fill(index) })),
      touched: rows(24).map(index => ({ path: `src/${index}.ts`, op: "read", ids: rows(8).map(fill) })),
    };
    const digest = valid(built.withClaims(empty, claims));
    const texts = [
      ...digest.decisions.flatMap(row => [row.what, row.why]), ...digest.open, ...digest.forSiblings.map(row => row.note),
      ...digest.failures.flatMap(row => [row.signal, row.where ?? ""]),
    ];
    for (const text of texts) assert.ok(utf8(text) <= 240 && /^\d+(\\u\{[0-9a-f]+\})*$/.test(text), JSON.stringify(text));
    for (const id of digest.touched.flatMap(row => row.ids ?? [])) assert.ok(utf8(id) <= 120 && /^\d+(\\u\{[0-9a-f]+\})*$/.test(id), id);
    const refit = valid(built.fitDigest({ ...empty, open: [fill(0)], decisions: [{ what: fill(1), why: fill(2) }] }));
    assert.equal(refit.open[0], valid(built.fitDigest(refit)).open[0]);
  }
});
