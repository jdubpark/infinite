import test from "node:test";
import assert from "node:assert/strict";
import { CheckOutputScanner, checkFeedback, scanCheckOutput } from "../packages/host/src/team-check-output.js";
import type { CheckScan } from "../packages/host/src/team-check-output.js";
import type { TeamCheck } from "../packages/host/src/team-types.js";

const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
const CHECK = String.fromCodePoint(0x2716), ACCENT = String.fromCodePoint(0x00e9), EMOJI = String.fromCodePoint(0x1f600);
const CONTEXT_LINE = 'The kept output of each check is in the context file under "checks".';

/** Seeded generator (mulberry32), so every failing run names its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function check(status: TeamCheck["status"], output: string, scan?: CheckScan): TeamCheck {
  return { command: { command: "npm", args: ["test"] }, status, startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:01:00.000Z", exitCode: status === "passed" ? 0 : 1, output, revision: 1, ...(scan ? { scan } : {}) };
}

const tap = [
  "TAP version 13",
  `ok 1 - caf${ACCENT} ${EMOJI} passes`,
  "not ok 2 - rounds half up",
  "  ---",
  "  error: 'expected 2 got 3'",
  "  ...",
  "ok 3 - fine",
  "not ok 4 - writes the file",
  "  ---",
  "  error: 'EACCES'",
  "  ...",
  "not ok 5 - parses the date",
  "  ---",
  "  error: 'bad date'",
  "  ...",
  "",
].join("\n");

test("the scan does not depend on where the chunks are cut", () => {
  const bytes = Buffer.from(tap, "utf8");
  const expected = scanCheckOutput(tap);
  assert.equal(expected.failureCount, 3);
  assert.equal(expected.bytes, bytes.length);
  const accent = bytes.indexOf(Buffer.from(ACCENT, "utf8"));
  assert.ok(accent > 0, "the fixture holds a multi-byte character");
  let insideCharacter = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const scanner = new CheckOutputScanner();
    for (let at = 0; at < bytes.length;) {
      const size = 1 + Math.floor(next() * 40);
      if (at + size === accent + 1) insideCharacter++;
      scanner.push(bytes.subarray(at, at + size), "stdout");
      at += size;
    }
    assert.deepStrictEqual(scanner.finish(), expected, `seed ${seed}`);
  }
  assert.ok(insideCharacter > 0, "some run cut inside a multi-byte character");
});

test("a failure early in a long run reaches the repair feedback", () => {
  const head = "not ok 1 - billing rounds half up\n  ---\n  error: 'expected 2 got 3'\n  ...\n";
  const output = head + "ok 2 - passes\n".repeat(6000);
  assert.ok(output.length > 65536);
  const scanner = new CheckOutputScanner();
  scanner.push(Buffer.from(output, "utf8"), "stdout");
  const scan = scanner.finish();
  const kept = output.slice(-65536);
  assert.ok(!kept.includes("billing"), "the failure is outside the kept output");
  const text = checkFeedback([check("failed", kept, scan)]);
  assert.match(text, /billing rounds half up/);
  assert.match(text, /expected 2 got 3/);
});

test("TAP and marker failures follow the rules", () => {
  const skipped = scanCheckOutput("ok 1 - a # SKIP later\nnot ok 2 - b # TODO later\nnot ok 3 - c # skip reason\nnot ok 4 - real\n");
  assert.equal(skipped.failureCount, 1);
  assert.equal(skipped.failures[0]!.line, "not ok 4 - real");

  const nested = scanCheckOutput("# suite\n    not ok 5 - nested\n");
  assert.equal(nested.failureCount, 1);

  const long = scanCheckOutput(["not ok 1 - long", "  ---", ...Array.from({ length: 40 }, (_, i) => `  row ${i}`), "  ..."].join("\n"));
  const detail = long.failures[0]!.detail;
  assert.ok(detail.split("\n").length <= 30);
  const wide = scanCheckOutput(["not ok 1 - wide", "  ---", ...Array.from({ length: 20 }, () => `  ${"w".repeat(200)}`), "  ..."].join("\n"));
  assert.ok(Buffer.byteLength(wide.failures[0]!.detail) <= 1500);
  assert.ok(wide.failures[0]!.detail.length > 0, "the detail keeps its first lines");

  const many = scanCheckOutput(Array.from({ length: 12 }, (_, i) => `not ok ${i} - failure ${i}`).join("\n"));
  assert.equal(many.failureCount, 12);
  assert.equal(many.failures.length, 8);

  const heading = scanCheckOutput(`${CHECK} failing tests:\n${CHECK} real failure\n`);
  assert.equal(heading.failureCount, 1);
  assert.equal(heading.failures[0]!.line, `${CHECK} real failure`);

  const repeated = scanCheckOutput("not ok 1 - same\nnot ok 1 - same\n");
  assert.equal(repeated.failureCount, 1);
});

test("the repair feedback is bounded and shows only failing evidence", () => {
  const failingOutput = [
    ...Array.from({ length: 8 }, (_, i) => `not ok ${i} - ${"t".repeat(230)}\n  ---\n  message: ${"m".repeat(1400)}\n  ...`),
    `${ESC}[31mred${ESC}[0m${BEL} control`,
    "ok 99 - passes",
  ].join("\n");
  const padded = failingOutput + "\n" + "x".repeat(65536);
  const failedScan = scanCheckOutput(padded);
  const passedOutput = "PASSED-OUTPUT-MARKER ".repeat(3000);
  const text = checkFeedback([check("passed", passedOutput), check("failed", padded.slice(-65536), failedScan)]);
  assert.ok(Buffer.byteLength(text) <= 12000, `feedback is ${Buffer.byteLength(text)} bytes`);
  assert.ok(!text.includes("PASSED-OUTPUT-MARKER"));
  assert.ok(text.endsWith(CONTEXT_LINE));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text), "no control characters");
  assert.ok(!text.includes(ESC) && !text.includes("[31m"), "no ANSI sequence");
  assert.ok(text.includes("not ok 0 - "));
});

test("a check without a scan gives the same failures as one with it", () => {
  const output = "not ok 1 - alpha\n  ---\n  error: 'a'\n  ...\nnot ok 2 - beta\n";
  const withScan = checkFeedback([check("failed", output, scanCheckOutput(output))]);
  const withoutScan = checkFeedback([check("failed", output)]);
  // Failure blocks are indented; the kept-output tail repeats the raw lines unindented.
  const failureBlocks = (text: string) => text.split("\n").filter(line => line.startsWith("  not ok"));
  assert.equal(failureBlocks(withScan).length, 2);
  assert.deepStrictEqual(failureBlocks(withoutScan), failureBlocks(withScan));
});
