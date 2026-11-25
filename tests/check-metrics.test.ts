import test from "node:test";
import assert from "node:assert/strict";
import { CheckMetricScanner, METRIC_LINE_MAX_BYTES, type CheckMetricScan } from "../packages/host/src/check-metrics.js";

// Inputs are byte strings: latin1 maps each character to one byte, so 0xe9 is a single non-ASCII byte.
function scanWhole(input: string | Buffer, stream: "stdout" | "stderr" = "stdout"): CheckMetricScan {
  const scanner = new CheckMetricScanner();
  scanner.push(typeof input === "string" ? Buffer.from(input, "latin1") : input, stream);
  return scanner.finish();
}

const NAME40 = "n".repeat(40);
// Exactly 200 content bytes: "infinite-metric " (16) + name (40) + space (1) + number (143).
const LINE200 = `infinite-metric ${NAME40} 0.${"0".repeat(141)}`;
// Exactly 201 content bytes.
const LINE201 = `infinite-metric ${NAME40} 0.${"0".repeat(142)}`;

const CASES: { rule: number; name: string; input: string | Buffer; expected: CheckMetricScan }[] = [
  // Rule 1: stdout only, LF ends a line, text after the last LF counts.
  { rule: 1, name: "LF ends each line", input: "infinite-metric p 1\ninfinite-metric p 2\n", expected: { metrics: [{ name: "p", state: "ambiguous" }], more: 0 } },
  { rule: 1, name: "text after the last LF counts as a line", input: "infinite-metric p 1", expected: { metrics: [{ name: "p", state: "value", value: 1 }], more: 0 } },

  // Rule 2: one CR directly before the LF is dropped.
  { rule: 2, name: "CRLF ends a line", input: "infinite-metric p 1\r\n", expected: { metrics: [{ name: "p", state: "value", value: 1 }], more: 0 } },
  { rule: 2, name: "only one CR before LF is dropped", input: "infinite-metric p 1\r\r\n", expected: { metrics: [{ name: "p", state: "invalid" }], more: 0 } },
  { rule: 2, name: "a CR at the end of the stream is content", input: "infinite-metric p 1\r", expected: { metrics: [{ name: "p", state: "invalid" }], more: 0 } },
  { rule: 2, name: "a CR inside a line is content", input: "infinite-metric p\r1\n", expected: { metrics: [], more: 0 } },

  // Rule 3: only the marker "infinite-metric " (one space) starts a marker line.
  { rule: 3, name: "a word without the space is not a marker", input: "infinite-metrics p 1\ninfinite-metric\n", expected: { metrics: [], more: 0 } },
  { rule: 3, name: "leading text before the marker is not a marker", input: "  infinite-metric p 1\nx infinite-metric p 1\n", expected: { metrics: [], more: 0 } },

  // Rule 4: number grammar, range, and the single-space line shape.
  { rule: 4, name: "valid number forms are accepted", input: "infinite-metric a 0\ninfinite-metric b 1.5e3\ninfinite-metric c 1E-2\ninfinite-metric d -7\n", expected: { metrics: [{ name: "a", state: "value", value: 0 }, { name: "b", state: "value", value: 1500 }, { name: "c", state: "value", value: 0.01 }, { name: "d", state: "value", value: -7 }], more: 0 } },
  { rule: 4, name: "negative zero is stored as zero", input: "infinite-metric a -0\n", expected: { metrics: [{ name: "a", state: "value", value: 0 }], more: 0 } },
  { rule: 4, name: "1e15 is accepted", input: "infinite-metric a 1e15\n", expected: { metrics: [{ name: "a", state: "value", value: 1e15 }], more: 0 } },
  { rule: 4, name: "just above 1e15 is invalid", input: "infinite-metric a 1000000000000001\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "a number that overflows to Infinity is invalid", input: "infinite-metric a 1e400\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "leading plus is invalid", input: "infinite-metric a +1\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "NaN is invalid", input: "infinite-metric a NaN\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "Infinity is invalid", input: "infinite-metric a Infinity\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "trailing text after the number is invalid", input: "infinite-metric a 1 x\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "trailing space is invalid", input: "infinite-metric a 1 \n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "leading zero is invalid", input: "infinite-metric a 01\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "digit separators are invalid", input: "infinite-metric a 1_000\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "a tab in a marker line is not a single space and makes the whole check invalid", input: "infinite-metric a 1\ninfinite-metric b\t1\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 4, name: "a non-ASCII byte after a valid name makes that name invalid", input: "infinite-metric a 1é\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },

  // Rule 5: the name token is the bytes up to the next space; it must match NAME.
  { rule: 5, name: "a name with an exclamation mark makes the whole check invalid", input: "infinite-metric latency! 18\n", expected: { metrics: [], more: 0 } },
  { rule: 5, name: "a missing name makes the whole check invalid", input: "infinite-metric ! 1\n", expected: { metrics: [], more: 0 } },
  { rule: 5, name: "a name starting with a digit is not a name", input: "infinite-metric 1abc 1\n", expected: { metrics: [], more: 0 } },
  { rule: 5, name: "an upper-case name is not a name", input: "infinite-metric P90 1\n", expected: { metrics: [], more: 0 } },
  { rule: 5, name: "a 40-byte name is a name", input: `infinite-metric ${NAME40} 1\n`, expected: { metrics: [{ name: NAME40, state: "value", value: 1 }], more: 0 } },
  { rule: 5, name: "a 41-byte name is not a name", input: `infinite-metric ${NAME40}x 1\n`, expected: { metrics: [], more: 0 } },

  // Rule 6: an invalid marker line with a valid name token invalidates that name; otherwise the whole check.
  { rule: 6, name: "an invalid line with a valid name token invalidates that name", input: "infinite-metric p90 x\n", expected: { metrics: [{ name: "p90", state: "invalid" }], more: 0 } },
  { rule: 6, name: "two spaces after the marker make the whole check invalid", input: "infinite-metric p 1\ninfinite-metric  p 1\n", expected: { metrics: [{ name: "p", state: "invalid" }], more: 0 } },
  { rule: 6, name: "a bad token invalidates names seen before and after it", input: "infinite-metric a 1\ninfinite-metric ! 1\ninfinite-metric b 2\n", expected: { metrics: [{ name: "a", state: "invalid" }, { name: "b", state: "invalid" }], more: 0 } },

  // Rule 7: a line is at most 200 content bytes; the CR of CRLF is not content.
  { rule: 7, name: "200 bytes followed by CRLF is a valid line", input: `${LINE200}\r\n`, expected: { metrics: [{ name: NAME40, state: "value", value: 0 }], more: 0 } },
  { rule: 7, name: "200 bytes followed by LF is a valid line", input: `${LINE200}\n`, expected: { metrics: [{ name: NAME40, state: "value", value: 0 }], more: 0 } },
  { rule: 7, name: "201 bytes followed by LF is too long, so its name is invalid", input: `${LINE201}\n`, expected: { metrics: [{ name: NAME40, state: "invalid" }], more: 0 } },
  { rule: 7, name: "201 bytes followed by CRLF is too long", input: `${LINE201}\r\n`, expected: { metrics: [{ name: NAME40, state: "invalid" }], more: 0 } },
  { rule: 7, name: "a long line without the marker is ignored", input: `${"x".repeat(300)}\n`, expected: { metrics: [], more: 0 } },
  { rule: 7, name: "a long marker line with a bad token makes the whole check invalid", input: `infinite-metric ${"!".repeat(300)}\n`, expected: { metrics: [], more: 0 } },

  // Rule 8: invalid and ambiguous are final; invalid wins.
  { rule: 8, name: "a valid line does not clear an invalid name", input: "infinite-metric a x\ninfinite-metric a 1\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },
  { rule: 8, name: "a valid line does not clear an ambiguous name", input: "infinite-metric a 1\ninfinite-metric a 2\ninfinite-metric a 1\n", expected: { metrics: [{ name: "a", state: "ambiguous" }], more: 0 } },
  { rule: 8, name: "invalid wins over ambiguous", input: "infinite-metric a 1\ninfinite-metric a 2\ninfinite-metric a x\n", expected: { metrics: [{ name: "a", state: "invalid" }], more: 0 } },

  // Rule 9: the same parsed number is one value; a different number is ambiguous.
  { rule: 9, name: "the same number in another spelling is one value", input: "infinite-metric a 1.0\ninfinite-metric a 1\n", expected: { metrics: [{ name: "a", state: "value", value: 1 }], more: 0 } },
  { rule: 9, name: "zero and negative zero are the same value", input: "infinite-metric a 0\ninfinite-metric a -0\n", expected: { metrics: [{ name: "a", state: "value", value: 0 }], more: 0 } },
  { rule: 9, name: "a different number makes the name ambiguous", input: "infinite-metric a 1\ninfinite-metric a 2\n", expected: { metrics: [{ name: "a", state: "ambiguous" }], more: 0 } },

  // Rule 10: the first 8 distinct names take a slot; each later line that names another name adds one to `more`.
  { rule: 10, name: "the 9th distinct name has no slot", input: Array.from({ length: 9 }, (_, i) => `infinite-metric n${i + 1} ${i + 1}\n`).join(""), expected: { metrics: Array.from({ length: 8 }, (_, i) => ({ name: `n${i + 1}`, state: "value" as const, value: i + 1 })), more: 1 } },
  { rule: 10, name: "each line for a name without a slot is counted", input: Array.from({ length: 8 }, (_, i) => `infinite-metric n${i + 1} 1\n`).join("") + "infinite-metric x 1\ninfinite-metric x 2\n", expected: { metrics: Array.from({ length: 8 }, (_, i) => ({ name: `n${i + 1}`, state: "value" as const, value: 1 })), more: 2 } },
  { rule: 10, name: "a late conflict changes a name that has a slot", input: Array.from({ length: 8 }, (_, i) => `infinite-metric n${i + 1} 1\n`).join("") + "infinite-metric x 1\ninfinite-metric n1 2\n", expected: { metrics: [{ name: "n1", state: "ambiguous" }, ...Array.from({ length: 7 }, (_, i) => ({ name: `n${i + 2}`, state: "value" as const, value: 1 }))], more: 1 } },
  { rule: 10, name: "an invalid line for a name without a slot is counted, not kept", input: Array.from({ length: 8 }, (_, i) => `infinite-metric n${i + 1} 1\n`).join("") + "infinite-metric x y\n", expected: { metrics: Array.from({ length: 8 }, (_, i) => ({ name: `n${i + 1}`, state: "value" as const, value: 1 })), more: 1 } },
  { rule: 10, name: "a late invalid line changes a name that has a slot", input: "infinite-metric a 1\ninfinite-metric b 1\ninfinite-metric a x\n", expected: { metrics: [{ name: "a", state: "invalid" }, { name: "b", state: "value", value: 1 }], more: 0 } },
];

for (const c of CASES) {
  test(`rule ${c.rule}: ${c.name}`, () => {
    assert.deepStrictEqual(scanWhole(c.input), c.expected);
  });
}

test("rule 1: a marker in stderr does not count when stdout has no marker", () => {
  const scanner = new CheckMetricScanner();
  scanner.push(Buffer.from("ordinary output\n", "latin1"), "stdout");
  scanner.push(Buffer.from("infinite-metric a 1\n", "latin1"), "stderr");
  assert.deepStrictEqual(scanner.finish(), { metrics: [], more: 0 });
});

test("rule 1: a stderr chunk does not complete a stdout line", () => {
  const scanner = new CheckMetricScanner();
  scanner.push(Buffer.from("infinite-metric a ", "latin1"), "stdout");
  scanner.push(Buffer.from("1\n", "latin1"), "stderr");
  scanner.push(Buffer.from("2\n", "latin1"), "stdout");
  // Stdout alone reads "infinite-metric a 2", so the stderr "1" is not part of the value.
  assert.deepStrictEqual(scanner.finish(), { metrics: [{ name: "a", state: "value", value: 2 }], more: 0 });
});

test("rule 2: a CR and an LF in separate chunks end the line once", () => {
  const scanner = new CheckMetricScanner();
  scanner.push(Buffer.from("infinite-metric p 1\r", "latin1"), "stdout");
  scanner.push(Buffer.from("\n", "latin1"), "stdout");
  assert.deepStrictEqual(scanner.finish(), { metrics: [{ name: "p", state: "value", value: 1 }], more: 0 });
});

test("finish is idempotent and pushes after finish are ignored", () => {
  const scanner = new CheckMetricScanner();
  scanner.push(Buffer.from("infinite-metric a 1\n", "latin1"), "stdout");
  const first = scanner.finish();
  scanner.push(Buffer.from("infinite-metric a 2\n", "latin1"), "stdout");
  assert.deepStrictEqual(scanner.finish(), first);
  assert.deepStrictEqual(first, { metrics: [{ name: "a", state: "value", value: 1 }], more: 0 });
});

test("rule 11: a 16 MB line without LF keeps memory bounded, buffers included", () => {
  const scanner = new CheckMetricScanner();
  const chunk = Buffer.alloc(64 * 1024, "a");
  // Buffer contents live outside the V8 heap, so a scanner that kept a copy of each chunk would show only here.
  const used = () => { const usage = process.memoryUsage(); return usage.heapUsed + usage.arrayBuffers; };
  const before = used();
  for (let i = 0; i < 256; i++) scanner.push(chunk, "stdout");
  const grown = used() - before;
  assert.ok(grown < 4 * 1024 * 1024, `memory grew by ${grown} bytes while scanning 16 MB`);
  assert.deepStrictEqual(scanner.finish(), { metrics: [], more: 0 });
});

test("rule 11: a million distinct names without a slot keep the heap bounded and are counted per line", () => {
  const scanner = new CheckMetricScanner();
  for (let i = 0; i < 8; i++) scanner.push(Buffer.from(`infinite-metric n${i + 1} 1\n`, "latin1"), "stdout");
  const before = process.memoryUsage().heapUsed;
  const LINES = 1_000_000;
  for (let at = 0; at < LINES; at += 1_000) {
    let text = "";
    for (let i = at; i < at + 1_000; i++) text += `infinite-metric extra-name-number-${i} 1\n`;
    scanner.push(Buffer.from(text, "latin1"), "stdout");
  }
  const grown = process.memoryUsage().heapUsed - before;
  // Measured: 4 to 8 MB of uncollected garbage as written, 72 MB when the names are kept in a set.
  assert.ok(grown < 32 * 1024 * 1024, `heap grew by ${grown} bytes while scanning ${LINES} names without a slot`);
  const scan = scanner.finish();
  assert.equal(scan.metrics.length, 8);
  assert.equal(scan.more, LINES);
});

test("rule 11: a 5 MB marker line is one invalid line of bounded size", () => {
  const scanner = new CheckMetricScanner();
  const chunk = Buffer.alloc(64 * 1024, "1");
  scanner.push(Buffer.from("infinite-metric a 1", "latin1"), "stdout");
  for (let i = 0; i < 80; i++) scanner.push(chunk, "stdout");
  scanner.push(Buffer.from("\n", "latin1"), "stdout");
  assert.deepStrictEqual(scanner.finish(), { metrics: [{ name: "a", state: "invalid" }], more: 0 });
});

// Seeded property test: the same stream gives the same result whatever the chunk sizes.
const SEED = 0x1399;
const STREAMS = 400;

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

const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
const VALUES = ["0", "-0", "1", "1.0", "2", "1e15", "1000000000000001", "0.5", "1e-3"];
const BAD_LINES = ["infinite-metric a +1", "infinite-metric a NaN", "infinite-metric a 1 x", "infinite-metric ! 1", "infinite-metric a\t1", "infinite-metric a 1é", "infinite-metric  a 1", "infinite-metric a 01"];

function randomStream(rng: () => number): Buffer {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
  const lines: string[] = [];
  const count = 1 + Math.floor(rng() * 14);
  for (let i = 0; i < count; i++) {
    const kind = rng();
    if (kind < 0.4) lines.push(`infinite-metric ${pick(NAMES)} ${pick(VALUES)}`);
    else if (kind < 0.55) lines.push(pick(BAD_LINES));
    else if (kind < 0.65) lines.push(`infinite-metric ${"n".repeat(1 + Math.floor(rng() * 60))} 1`);
    else if (kind < 0.75) lines.push(`infinite-metric ${pick(NAMES)} 0.${"0".repeat(Math.floor(rng() * 200))}`);
    else if (kind < 0.85) lines.push("ordinary output line");
    else if (kind < 0.9) lines.push("");
    else lines.push("x".repeat(Math.floor(rng() * 260)));
  }
  let text = "";
  for (const line of lines) text += line + pick(["\n", "\r\n", "\r\r\n", "\n", "\r"]);
  if (rng() < 0.3) text = text.slice(0, text.length - 1);
  return Buffer.from(text, "latin1");
}

function feedInChunks(stream: Buffer, sizes: (index: number) => number): CheckMetricScan {
  const scanner = new CheckMetricScanner();
  let at = 0;
  let index = 0;
  while (at < stream.length) {
    const size = Math.max(1, sizes(index++));
    scanner.push(stream.subarray(at, at + size), "stdout");
    at += size;
  }
  return scanner.finish();
}

test(`property: chunking does not change the result (seed ${SEED}, ${STREAMS} streams)`, () => {
  const rng = mulberry32(SEED);
  for (let i = 0; i < STREAMS; i++) {
    const stream = randomStream(rng);
    const whole = scanWhole(stream);
    const oneByte = feedInChunks(stream, () => 1);
    const random = feedInChunks(stream, () => 1 + Math.floor(rng() * 70));
    const where = `seed ${SEED}, stream ${i}, bytes ${JSON.stringify(stream.toString("latin1"))}`;
    assert.deepStrictEqual(oneByte, whole, `1-byte chunks differ: ${where}`);
    assert.deepStrictEqual(random, whole, `random chunks differ: ${where}`);
  }
});

test("the line limit is the same constant the tests assume", () => {
  assert.equal(METRIC_LINE_MAX_BYTES, 200);
});
