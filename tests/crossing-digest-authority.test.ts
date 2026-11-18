import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as built from "../packages/host/src/crossing-digest.js";
import type { ClaimInput, CrossingDigest, HostInput } from "../packages/host/src/crossing-digest.js";

// Receipt space under counter growth, claims invisible to receipts, and the text rule. Special characters are built
// from code points.

const { DIGEST_LIMIT_BYTES, OMITTED_MAX, crossingDigestSchema } = built;
type Outcome = CrossingDigest["outcome"];
const LISTS = ["touched", "decisions", "failures", "forSiblings", "open"] as const;
const OUTCOMES = ["complete", "partial", "failed", "refused"] as const;

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
      assert.ok(receipts(digest).length > 0, `${where}: no receipt to keep`);
      const result = valid(built.withClaims(digest, claims));
      assert.deepEqual(receipts(result), receipts(digest), where);
      // The rows were dropped and counted: a list keeps at most 24 rows.
      for (const list of LISTS) {
        assert.ok((result.omitted[list] ?? 0) >= Math.min(OMITTED_MAX, (digest.omitted[list] ?? 0) + count - 24), `${where}: ${list}`);
      }
    }
  }
  const heavy = claimRows(10_000, true);
  assert.ok(BOUNDARY.largest.length > 0, "no largest digest");
  for (const digest of BOUNDARY.largest) {
    assert.deepEqual(receipts(valid(built.withClaims(digest, heavy))), receipts(digest), `${measure(digest)} bytes, 10,000 valid rows`);
  }
});

test("mergeDigest keeps every receipt of the older digest when the newer one holds only counters or claims", () => {
  const countersOnly = valid(built.fitDigest({ ...valid(built.emptyDigest("complete")), omitted: counts(OMITTED_MAX) }));
  const claimsOnly = valid(built.withClaims(valid(built.emptyDigest("complete")), claimRows(100)));
  assert.ok(SWEEP.length > DIGEST_LIMIT_BYTES - 1900, `the sweep holds only ${SWEEP.length} digests`);
  for (const digest of SWEEP) {
    assert.ok(receipts(digest).length > 0, `${measure(digest)}-byte digest: no receipt to keep`);
    for (const newer of [countersOnly, claimsOnly]) {
      const merged = valid(built.mergeDigest(digest, newer));
      assert.deepEqual(receipts(merged), receipts(digest), `${measure(digest)}-byte ${digest.outcome} digest`);
      assert.equal(merged.outcome, "complete");
    }
  }
});

// Claims are invisible to receipts: receipt rows, their order and their survival never depend on claims.

/** Receipt rows per list, in order: `touched` rows marked as receipts and `failures` rows of a host class. */
const receiptRows = (digest: CrossingDigest) => ({
  touched: digest.touched.filter(row => row.by === "receipt").map(row => JSON.stringify(row, Object.keys(row).sort())),
  failures: digest.failures.filter(row => row.class !== "claim").map(row => JSON.stringify(row, Object.keys(row).sort())),
});
const paths = (digest: CrossingDigest) => digest.touched.map(row => `${row.path}:${row.by}`);
const signals = (digest: CrossingDigest) => digest.failures.map(row => `${row.signal}:${row.by}`);

test("reproduction: a claim on a receipt's path leaves the receipts' order and content alone", () => {
  const d = valid(built.hostDigest({ outcome: "partial", read: ["a", "b"] }));
  const claimed = valid(built.withClaims(d, { touched: [{ path: "b", op: "removed", ids: ["fake"] }] }));
  assert.deepEqual(claimed.touched, d.touched);
  assert.deepEqual(paths(claimed), ["a:receipt", "b:receipt"]);
});

test("reproduction: a claim duplicating the second host failure leaves the failure order alone", () => {
  const host = valid(built.hostDigest({ outcome: "failed", failures: [{ signal: "s1", class: "check" }, { signal: "s2", where: "w", class: "stop" }] }));
  const claimed = valid(built.withClaims(host, { failures: [{ signal: "s2", where: "w" }] }));
  assert.deepEqual(claimed.failures, host.failures);
  assert.deepEqual(signals(claimed), ["s1:receipt", "s2:receipt"]);
});

test("reproduction: merging a claims-only digest leaves both receipt orders alone", () => {
  const host = valid(built.hostDigest({
    outcome: "partial", read: ["a", "b"], failures: [{ signal: "s1", class: "check" }, { signal: "s2", where: "w", class: "stop" }],
  }));
  const claimsOnly = valid(built.withClaims(valid(built.emptyDigest("partial")), {
    touched: [{ path: "b", op: "removed", ids: ["fake"] }], failures: [{ signal: "s2", where: "w" }],
  }));
  const merged = valid(built.mergeDigest(host, claimsOnly));
  assert.deepEqual([paths(merged), signals(merged)], [["a:receipt", "b:receipt"], ["s1:receipt", "s2:receipt"]]);
});

test("reproduction: a claim on the oldest of 24 receipts does not change which receipt a later merge drops", () => {
  const reads = Array.from({ length: 24 }, (_, index) => `r${index}`);
  const full = valid(built.hostDigest({ outcome: "partial", read: reads }));
  const fresh = valid(built.hostDigest({ outcome: "partial", read: ["new"] }));
  const expected = ["new", ...reads.slice(0, 23)].map(path => `${path}:receipt`);
  for (const claims of [{ touched: [{ path: "r23", op: "removed" as const }] }, {}]) {
    const merged = valid(built.mergeDigest(valid(built.withClaims(full, claims)), fresh));
    assert.deepEqual(paths(merged), expected, JSON.stringify(claims));
    assert.equal(merged.omitted.touched, 1);
  }
});

test("contract: a claim on a receipt's path is dropped with its ids, and overlapping merges count omissions twice", () => {
  // Rule (h): the claim's ids and operation do not survive, and nothing is counted.
  const held = valid(built.withClaims(valid(built.hostDigest({ outcome: "partial", read: ["a"] })), {
    touched: [{ path: "a", op: "removed", ids: ["symbol"] }, { path: "new", op: "added" }],
  }));
  assert.deepEqual(held.touched, [{ path: "a", op: "read", by: "receipt" }, { path: "new", op: "added", by: "claim" }]);
  assert.equal(held.omitted.touched, 0);
  // The merge contract: counters add, so a digest merged with itself or with its own descendant counts twice.
  const d = valid(built.hostDigest({ outcome: "partial", read: Array.from({ length: 25 }, (_, index) => `r${index}`) }));
  assert.equal(d.omitted.touched, 1);
  assert.equal(valid(built.fitDigest(d)).omitted.touched, 1);
  for (const other of [d, valid(built.withClaims(d, { open: ["q"] }))]) {
    const merged = valid(built.mergeDigest(d, other));
    assert.deepEqual(merged.touched, d.touched);
    assert.equal(merged.omitted.touched, 2);
  }
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Call =
  | { kind: "host"; input: HostInput }
  | { kind: "claims"; target: number; claims: ClaimInput }
  | { kind: "claimsOnly"; outcome: Outcome; claims: ClaimInput }
  | { kind: "merge"; older: number; newer: number }
  | { kind: "fit"; target: number };

/**
 * A random call sequence. Claims draw most paths and failure keys from the pools the host inputs use, so they often
 * collide with a receipt (same path with another op or with ids, same signal and place). Short paths reach the
 * 24-row cap, long ones the byte limit.
 */
function randomCalls(seed: number, length: number): Call[] {
  const random = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const longOdds = pick([0, 0.2, 0.6]);
  const pool = Array.from({ length: 40 }, (_, index) => `src/${index}/${"x".repeat(random() < longOdds ? int(80, 220) : int(1, 12))}.ts`);
  const failureKeys = ["exit 1", "exit 2", "timeout", "lint", "denied", "merge"].flatMap(signal => [{ signal }, { signal, where: "npm test" }]);
  const list = <T>(max: number, row: () => T) => Array.from({ length: int(0, max) }, row);
  const text = (prefix: string) => `${prefix} ${int(0, 30)} ${"t".repeat(int(0, 200))}`;
  const host = (): HostInput => ({
    outcome: pick(OUTCOMES),
    changed: list(30, () => ({ path: pick(pool), op: pick(["changed", "added", "removed"] as const) })),
    read: list(12, () => pick(pool)),
    failures: list(8, () => ({ ...pick(failureKeys), class: pick(["check", "stop", "refusal", "conflict"] as const) })),
  });
  const claims = (): ClaimInput => ({
    touched: list(12, () => ({
      path: random() < 0.7 ? pick(pool) : `claim/${int(0, 40)}.ts`,
      op: pick(["read", "changed", "added", "removed"] as const),
      ...(random() < 0.5 ? { ids: list(3, () => `id${int(0, 9)}`) } : {}),
    })),
    failures: list(8, () => (random() < 0.7 ? pick(failureKeys) : { signal: `member ${int(0, 9)}` })),
    decisions: list(7, () => ({ what: text("decision"), why: text("because") })),
    forSiblings: list(5, () => ({ note: text("note"), paths: [pick(pool)] })),
    open: list(5, () => text("question")),
  });
  const calls: Call[] = [{ kind: "host", input: host() }];
  while (calls.length < length) {
    const recent = () => int(Math.max(0, calls.length - 6), calls.length - 1);
    const roll = random();
    if (roll < 0.2) calls.push({ kind: "host", input: host() });
    else if (roll < 0.5) calls.push({ kind: "claims", target: recent(), claims: claims() });
    else if (roll < 0.62) calls.push({ kind: "claimsOnly", outcome: pick(OUTCOMES), claims: claims() });
    else if (roll < 0.9) calls.push({ kind: "merge", older: recent(), newer: recent() });
    else calls.push({ kind: "fit", target: recent() });
  }
  return calls;
}

/** One call. With `erase`, every claims argument is {} and every claims-only digest is an empty digest. */
function apply(call: Call, results: CrossingDigest[], erase: boolean): CrossingDigest | undefined {
  switch (call.kind) {
    case "host": return built.hostDigest(call.input);
    case "claims": return built.withClaims(results[call.target], erase ? {} : call.claims);
    case "claimsOnly": return erase ? built.emptyDigest(call.outcome) : built.withClaims(valid(built.emptyDigest(call.outcome)), call.claims);
    case "merge": return built.mergeDigest(results[call.older], results[call.newer]);
    case "fit": return built.fitDigest(results[call.target]);
  }
}

/** The digests a call reads, so a counter's growth shows what the call itself dropped. */
const inputsOf = (call: Call, results: CrossingDigest[]) =>
  call.kind === "merge" ? [results[call.older], results[call.newer]] : call.kind === "claims" || call.kind === "fit" ? [results[call.target]] : [];

test("differential: every call sequence gives the same receipt rows with its claims erased", t => {
  const seeds = Array.from({ length: 240 }, (_, index) => 304_000 + index);
  const reached = { touchedCap: new Set<number>(), failureCap: new Set<number>(), bytes: new Set<number>() };
  let calls = 0;
  let collisions = 0;
  for (const seed of seeds) {
    const sequence = randomCalls(seed, 32);
    const claimed: CrossingDigest[] = [];
    const erased: CrossingDigest[] = [];
    for (const [index, call] of sequence.entries()) {
      const where = `seed ${seed}, call ${index} (${call.kind})`;
      if (call.kind === "claims") {
        const held = receiptRows(claimed[call.target]);
        const hits = [...held.touched, ...held.failures].map(row => JSON.parse(row) as Record<string, string>);
        collisions += (call.claims.touched ?? []).filter(row => hits.some(hit => hit.path === row.path)).length;
        collisions += (call.claims.failures ?? []).filter(row => hits.some(hit => hit.signal === row.signal && hit.where === row.where)).length;
      }
      let left: CrossingDigest;
      let right: CrossingDigest;
      try {
        left = valid(apply(call, claimed, false));
        right = valid(apply(call, erased, true));
      } catch (error) {
        throw new Error(`${where}: ${(error as Error).message}`);
      }
      assert.deepEqual(receiptRows(left), receiptRows(right), where);
      claimed.push(left);
      erased.push(right);
      calls += 1;
      // What the erased run dropped is receipts alone: at a full list it is the cap, below it the byte fit.
      const before = (key: "touched" | "failures") => Math.min(OMITTED_MAX, inputsOf(call, erased).reduce((sum, digest) => sum + digest.omitted[key], 0));
      const grew = (key: "touched" | "failures") => right.omitted[key] > before(key);
      if (grew("touched") && right.touched.length === 24) reached.touchedCap.add(seed);
      if (grew("failures") && right.failures.length === 6) reached.failureCap.add(seed);
      if ((grew("touched") && right.touched.length < 24) || (grew("failures") && right.failures.length < 6)) reached.bytes.add(seed);
    }
  }
  t.diagnostic(`${seeds.length} seeds, ${calls} calls, ${collisions} colliding claim rows; sequences reaching the touched cap ${reached.touchedCap.size}, the failures cap ${reached.failureCap.size}, the byte limit ${reached.bytes.size}`);
  assert.equal(calls, seeds.length * 32);
  for (const [name, set] of Object.entries(reached)) assert.ok(set.size >= seeds.length / 5, `only ${set.size} sequences reached ${name}`);
  assert.ok(collisions >= seeds.length * 4, `only ${collisions} colliding claim rows`);
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

test("text rule: text made only of expanding characters stays within every bound, field by field", () => {
  const empty = valid(built.emptyDigest("partial"));
  for (const code of [0x202e, 0x01, 0x85]) {
    const fill = char(code).repeat(240);
    /** As many whole escapes as fit after `prefix` in `max` bytes. */
    const clipped = (prefix: string, max: number) => prefix + escapeOf(code).repeat(Math.floor((max - prefix.length) / escapeOf(code).length));
    // One field per fixture, small enough to survive the fit: [name, claims, the field read back, expected values].
    const ids = Array.from({ length: 8 }, (_, index) => `${index}${fill}`);
    const cases: [string, ClaimInput, (digest: CrossingDigest) => unknown[], string[]][] = [
      ["decision", { decisions: [{ what: fill, why: fill }] }, digest => [digest.decisions[0]?.what, digest.decisions[0]?.why], [clipped("", 240), clipped("", 240)]],
      ["open", { open: [fill] }, digest => [digest.open[0]], [clipped("", 240)]],
      ["note", { forSiblings: [{ note: fill }] }, digest => [digest.forSiblings[0]?.note], [clipped("", 240)]],
      ["failure", { failures: [{ signal: fill, where: fill }] }, digest => [digest.failures[0]?.signal, digest.failures[0]?.where], [clipped("", 240), clipped("", 240)]],
      ["ids", { touched: [{ path: "src/a.ts", op: "read", ids }] }, digest => digest.touched[0]?.ids ?? [], ids.map((_, index) => clipped(String(index), 120))],
    ];
    for (const [name, claims, read, expected] of cases) {
      const where = `${name}, U+${code.toString(16)}`;
      const values = read(valid(built.withClaims(empty, claims)));
      assert.equal(values.length, expected.length, `${where}: field count`);
      for (const value of values) assert.equal(typeof value, "string", `${where}: field missing`);
      assert.deepEqual(values, expected, where);
      for (const value of values as string[]) assert.ok(utf8(value) <= (name === "ids" ? 120 : 240), where);
      assert.deepEqual(read(valid(built.fitDigest(valid(built.withClaims(empty, claims))))), expected, `${where}: refit`);
    }
    // Every field at once is still within the byte bound (the fit decides which rows remain).
    valid(built.withClaims(empty, {
      decisions: [{ what: fill, why: fill }], open: [fill], forSiblings: [{ note: fill }],
      failures: [{ signal: fill, where: fill }], touched: [{ path: "src/a.ts", op: "read", ids }],
    }));
  }
});
