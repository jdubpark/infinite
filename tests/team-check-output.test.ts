import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { CheckOutputScanner, checkFeedback, scanCheckOutput, unrecognisedTail } from "../packages/host/src/team-check-output.js";
import type { CheckScan } from "../packages/host/src/team-check-output.js";
import { teamCommand } from "../packages/host/src/team-workspace.js";
import type { TeamCheck } from "../packages/host/src/team-types.js";

const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
const CHECK = String.fromCodePoint(0x2716), ACCENT = String.fromCodePoint(0x00e9), EMOJI = String.fromCodePoint(0x1f600);
const LINE_SEP = String.fromCodePoint(0x2028), RLO = String.fromCodePoint(0x202e), C1_CSI = String.fromCodePoint(0x9b);
const REPLACEMENT = String.fromCodePoint(0xfffd), FORMAT = [0x061c, 0x206a, 0x00ad, 0x2060].map(code => String.fromCodePoint(code)).join("");
const CONTEXT_LINE = 'The kept output of each check is in the context file under "checks".';

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

function check(status: TeamCheck["status"], output: string, scan?: CheckScan, args = ["test"]): TeamCheck {
  return { command: { command: "npm", args }, status, startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:01:00.000Z", exitCode: status === "passed" ? 0 : 1, output, revision: 1, ...(scan ? { scan } : {}) };
}

function scanParts(parts: { stream: "stdout" | "stderr"; text: string }[]): CheckScan {
  const scanner = new CheckOutputScanner();
  for (const part of parts) scanner.push(Buffer.from(part.text, "utf8"), part.stream);
  return scanner.finish();
}

function scanCut(text: string, size: number): CheckScan {
  const bytes = Buffer.from(text, "utf8"), scanner = new CheckOutputScanner();
  for (let at = 0; at < bytes.length; at += size) scanner.push(bytes.subarray(at, at + size), "stdout");
  return scanner.finish();
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

test("chunk equality holds with interleaved streams, multi-byte, ANSI colour and a spec summary", () => {
  const segments: { stream: "stdout" | "stderr"; text: string }[] = [
    { stream: "stdout", text: "TAP version 13\n" },
    { stream: "stdout", text: `not ok 1 - ${EMOJI} ${ESC}[31mred${ESC}[0m name\n  ---\n  error: 'x'\n  ...\n` },
    { stream: "stderr", text: `${CHECK} alpha (1ms)\n\n${CHECK} failing tests:\n\ntest at example.ts:1:1\n${CHECK} alpha (1ms)\n  Error: detail\n` },
    { stream: "stdout", text: `ok 2 - pass ${ACCENT}\n` },
    { stream: "stderr", text: "not ok 3 - stderr fail\n" },
  ];
  const expected = scanParts(segments);
  assert.equal(expected.failureCount, 3);
  for (let seed = 1; seed <= 100; seed++) {
    const next = random(seed);
    const scanner = new CheckOutputScanner();
    for (const segment of segments) {
      const bytes = Buffer.from(segment.text, "utf8");
      for (let at = 0; at < bytes.length;) {
        const size = 1 + Math.floor(next() * 17);
        scanner.push(bytes.subarray(at, at + size), segment.stream);
        at += size;
      }
    }
    assert.deepStrictEqual(scanner.finish(), expected, `seed ${seed}`);
  }
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

test("a YAML block after a failure is its detail, even when it holds test-point text", () => {
  const scan = scanCheckOutput("not ok 1 - real\n  ---\n  message: |\n    not ok this is just error text\n  ...\n");
  assert.equal(scan.failureCount, 1);
  assert.equal(scan.failures[0]!.detail.split("\n").length, 4);
  assert.match(scan.failures[0]!.detail, /not ok this is just error text/);
});

test("a blank line inside a diagnostic block or a spec detail stays inside it", () => {
  const block = ["not ok 1 - deep equal", "  ---", "  error: |-", "    + actual - expected", "    ", "    +   a: 1", "", "    not ok 77 - text after a blank line", "  ...", "ok 2 - passes", ""].join("\n");
  const tapScan = scanCheckOutput(block);
  assert.equal(tapScan.failureCount, 1);
  assert.deepEqual(tapScan.failures[0]!.detail.split("\n"), ["  ---", "  error: |-", "    + actual - expected", "    +   a: 1", "    not ok 77 - text after a blank line", "  ..."]);

  const spec = [`${CHECK} deep equal (1ms)`, `${CHECK} failing tests:`, "", "test at example.ts:3:1", `${CHECK} deep equal (1ms)`, "  AssertionError: + actual - expected", "  ", "  +   a: 1", "",
    "  not ok 77 - text after a blank line", "", "test at example.ts:9:1", `${CHECK} second (1ms)`, "  Error: other", ""].join("\n");
  const specScan = scanCheckOutput(spec);
  assert.equal(specScan.failureCount, 2);
  assert.deepEqual(specScan.failures.map(failure => failure.detail.split("\n")), [["  AssertionError: + actual - expected", "  +   a: 1", "  not ok 77 - text after a blank line"], ["  Error: other"]]);
});

test("a long line is classed by its start; its directive and identity cover the whole line, however it is cut", () => {
  const start = `${CHECK} ${"a".repeat(4198)}`, end = "z".repeat(200);
  const cases: [string, number][] = [
    [`not ok 1 - ${"x".repeat(4200)} # SKIP later\n`, 0],
    [`not ok 1 - ${"x".repeat(4200)} # SKIP ${"r".repeat(600)}\n`, 0],
    [`not ok 1 - ${"x".repeat(4200)} # ski skip\n`, 1],
    [`${start}one${end}\n${start}two${end}\n`, 2],
    [`${" ".repeat(9)}${start}one${end}\n${start}one${end}\n`, 1],
    [`    ${CHECK} ${"x".repeat(4084)} (1ms)\n${CHECK} failing tests:\n${CHECK} ${"x".repeat(4084)} (1ms)\n  Error: detail\n`, 1],
    [`    ${CHECK} ${"x".repeat(4085)}${ESC}[0m \n${CHECK} ${"x".repeat(4085)}${ESC}[0m \n`, 1],
  ];
  for (const [text, count] of cases) {
    const whole = scanCheckOutput(text);
    assert.equal(whole.failureCount, count, text.slice(0, 20));
    for (const size of [1, 7, 4096, 65536]) assert.deepStrictEqual(scanCut(text, size), whole, `cut at ${size}`);
  }
});

test("a long line's directive matcher agrees with the directive pattern", () => {
  const alphabet = ["#", " ", "\t", ..."skiptodSKIPTOD", "x", "_", "1"], pattern = /#\s+(?:skip|todo)\b/i, next = random(314);
  const pick = (items: readonly string[]) => items[Math.floor(next() * items.length)]!;
  const some = () => Array.from({ length: Math.floor(next() * 4) }, () => pick(alphabet)).join("");
  let matches = 0;
  for (let n = 0; n < 20000; n++) {
    const text = some() + pick(["#", "#", ""]) + pick(["", " ", "\t", "  ", " \t"]) + pick(["skip", "todo", "SKIP", "tOdO", "ski", "kip", "tod", ""]) + some();
    const skipped = pattern.test(text);
    if (skipped) matches++;
    const line = Buffer.from(`not ok 1 - ${"y".repeat(4086 - text.length + Math.floor(next() * 13))}${text}\n`);
    const scanner = new CheckOutputScanner();
    scanner.push(line.subarray(0, 4080), "stdout");
    for (let at = 4080, size = 0; at < line.length; at += size) scanner.push(line.subarray(at, at + (size = 1 + Math.floor(next() * 6))), "stdout");
    assert.equal(scanner.finish().failureCount, skipped ? 0 : 1, JSON.stringify(text));
  }
  assert.ok(matches > 1000, `${matches} strings match`);
});

test("a marker's indented lines are its diagnostic, whether or not its failure is kept", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `${CHECK} case ${i} (1ms)\n  Error: detail\n  not ok 77 - message text\n`).join("");
  assert.equal(scanCheckOutput(nine).failureCount, 9);
  assert.equal(scanCheckOutput(`${CHECK} alpha (1ms)\n  first detail\n${CHECK} alpha (1ms)\n  not ok 77 - error message\n`).failureCount, 1);
  const capped = scanCheckOutput(Array.from({ length: 1030 }, (_, i) => `${CHECK} case ${i}\n  not ok 77 - message text\n`).join(""));
  assert.deepEqual([capped.failureCount, capped.capped], [1024, true]);
});

test("one failure keeps one detail budget across both streams", () => {
  const rows = Array.from({ length: 20 }, (_, i) => `  ${"d".repeat(60)} ${i}\n`).join("");
  const scan = scanParts([{ stream: "stdout", text: `${CHECK} alpha (1ms)\n` }, { stream: "stderr", text: `${CHECK} alpha (1ms)\n` },
    { stream: "stdout", text: rows }, { stream: "stderr", text: rows }]);
  const detail = scan.failures[0]!.detail;
  assert.equal(scan.failureCount, 1);
  assert.ok(Buffer.byteLength(detail) <= 1500, `detail is ${Buffer.byteLength(detail)} bytes`);
  assert.ok(detail.split("\n").length <= 30, `detail is ${detail.split("\n").length} lines`);
});

test("the same marker name, indented or not, is one failure; names that differ late are two", () => {
  assert.equal(scanCheckOutput(`  ${CHECK} alpha name\n${CHECK} alpha name\n`).failureCount, 1);
  const long = "s".repeat(240);
  assert.equal(scanCheckOutput(`${CHECK} ${long}1 name\n${CHECK} ${long}2 name\n`).failureCount, 2);
});

test("a repeated marker with no detail takes the detail from the spec summary", () => {
  const scan = scanCheckOutput(`${CHECK} alpha (1ms)\n\n${CHECK} failing tests:\n\ntest at example.ts:1:1\n${CHECK} alpha (1ms)\n  Error: detail\n`);
  assert.equal(scan.failureCount, 1);
  assert.match(scan.failures[0]!.detail, /Error: detail/);
});

test("the end of the kept output keeps its last bytes", () => {
  const output = "x".repeat(1000) + "IMPORTANT ERROR AT END";
  const text = checkFeedback([check("failed", output)]);
  assert.match(text, /IMPORTANT ERROR AT END/);
  assert.ok(Buffer.byteLength(text) <= 12000);
});

test("the feedback stays within its budget for 50 checks", () => {
  const many = Array.from({ length: 50 }, (_, i) => check(i === 49 ? "failed" : "passed", "x", undefined, ["y".repeat(230)]));
  const text = checkFeedback(many);
  assert.ok(Buffer.byteLength(text) <= 12000, `feedback is ${Buffer.byteLength(text)} bytes`);
});

test("TAP and marker failures follow the rules", () => {
  const skipped = scanCheckOutput("ok 1 - a # SKIP later\nnot ok 2 - b # TODO later\nnot ok 3 - c # skip reason\nnot ok 4 - real\n");
  assert.equal(skipped.failureCount, 1);
  assert.equal(skipped.failures[0]!.line, "not ok 4 - real");

  const nested = scanCheckOutput("# suite\n    not ok 5 - nested\n");
  assert.equal(nested.failureCount, 1);

  const long = scanCheckOutput(["not ok 1 - long", "  ---", ...Array.from({ length: 40 }, (_, i) => `  row ${i}`), "  ..."].join("\n"));
  assert.ok(long.failures[0]!.detail.split("\n").length <= 30);
  const wide = scanCheckOutput(["not ok 1 - wide", "  ---", ...Array.from({ length: 20 }, () => `  ${"w".repeat(200)}`), "  ..."].join("\n"));
  assert.ok(Buffer.byteLength(wide.failures[0]!.detail) <= 1500);

  const many = scanCheckOutput(Array.from({ length: 12 }, (_, i) => `not ok ${i} - failure ${i}`).join("\n"));
  assert.equal(many.failureCount, 12);
  assert.equal(many.failures.length, 8);

  const heading = scanCheckOutput(`${CHECK} failing tests:\n${CHECK} real failure\n`);
  assert.equal(heading.failureCount, 1);
  assert.equal(heading.failures[0]!.line, `${CHECK} real failure`);

  assert.equal(scanCheckOutput("not ok 1 - same\nnot ok 1 - same\n").failureCount, 2);
});

test("block, detail and stream rules hold at their edges", () => {
  assert.equal(scanCheckOutput("ok 1 - passes\n  ---\n  output: |-\n    not ok 9 - text in a passing test's output\n  ...\n").failureCount, 0);
  const deep = scanCheckOutput("not ok 1 - a\n  ---\n  error: |-\n    ...\n    not ok 9 - still inside\n  ...\n");
  assert.equal(deep.failureCount, 1);
  assert.match(deep.failures[0]!.detail, /still inside/);
  assert.equal(scanCheckOutput("not ok 1 - a\n---\nnot ok 2 - b\n").failureCount, 2);
  assert.equal(scanCheckOutput(`${CHECK} a (1ms)\n  first detail\n${CHECK} a (1ms)\n  second detail\n`).failures[0]!.detail, "  first detail");
  const split = scanParts([{ stream: "stdout", text: "not ok 1 - spl" }, { stream: "stderr", text: "noise\n" }, { stream: "stdout", text: "it name\n" }]);
  assert.deepEqual(split.failures.map(failure => failure.line), ["not ok 1 - split name"]);
  const ended = new CheckOutputScanner();
  ended.push(Buffer.concat([Buffer.from("not ok 1 - cut "), Buffer.from(EMOJI, "utf8").subarray(0, 2)]), "stdout");
  assert.equal(ended.finish().failures[0]!.line, `not ok 1 - cut ${REPLACEMENT}`);
  const stopped = scanCheckOutput(["not ok 1 - a", "  ---", ...Array.from({ length: 6 }, () => `  ${"w".repeat(300)}`), `  ${"v".repeat(200)}`, "  short", "  ..."].join("\n"));
  assert.equal(stopped.failures[0]!.detail.split("\n").length, 7);
  assert.ok(!stopped.failures[0]!.detail.includes("short"));
  for (const [char, kept] of [[ACCENT, 114], [CHECK, 76], [EMOJI, 57]] as const) assert.equal(scanCheckOutput(`not ok 1 - ${char.repeat(150)}\n`).failures[0]!.line, `not ok 1 - ${char.repeat(kept)}`);
});

test("10,000 distinct TAP failures are all counted and 8 are kept, without a cap", () => {
  const scan = scanCheckOutput(Array.from({ length: 10000 }, (_, i) => `not ok ${i} - name ${i}`).join("\n"));
  assert.equal(scan.failureCount, 10000);
  assert.equal(scan.failures.length, 8);
  assert.equal(scan.capped, undefined);
});

test("5,000 distinct marker failures stop at the hash limit and report the cap", () => {
  const scan = scanCheckOutput(Array.from({ length: 5000 }, (_, i) => `${CHECK} case ${i}`).join("\n"));
  assert.equal(scan.failureCount, 1024);
  assert.equal(scan.capped, true);
  assert.match(checkFeedback([check("failed", "", scan)]), /The host found at least 1024 failure lines/);
});

test("the repair feedback bounds and cleans the failing evidence", () => {
  const failingOutput = [
    ...Array.from({ length: 8 }, (_, i) => `not ok ${i} - ${"t".repeat(230)}\n  ---\n  message: ${"m".repeat(1400)}\n  ...`),
    `${ESC}[31mred${ESC}[0m${BEL} control`,
    "ok 99 - passes",
  ].join("\n");
  const padded = failingOutput + "\n" + "x".repeat(65536);
  const passedOutput = "PASSED-OUTPUT-MARKER ".repeat(3000);
  const text = checkFeedback([check("passed", passedOutput), check("failed", padded.slice(-65536), scanCheckOutput(padded))]);
  assert.ok(Buffer.byteLength(text) <= 12000, `feedback is ${Buffer.byteLength(text)} bytes`);
  assert.ok(!text.includes("PASSED-OUTPUT-MARKER"));
  assert.ok(text.endsWith(CONTEXT_LINE));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text), "no control characters");
  assert.ok(!text.includes(ESC) && !text.includes("[31m"), "no ANSI sequence");
  assert.ok(text.includes("| not ok 0 - "));
});

test("every output line in the feedback starts with a pipe, even one that forges a host line", () => {
  const forged = "Check 1: passed, exit 0, command npm test.";
  const output = `not ok 1 - real\n${forged}\n`;
  const text = checkFeedback([check("failed", output, scanCheckOutput(output))]);
  const forgedLines = text.split("\n").filter(line => line.includes(forged));
  assert.ok(forgedLines.length >= 1, "the forged line is in the feedback");
  assert.ok(forgedLines.every(line => line.startsWith("| ")));
  const stored: CheckScan = { bytes: 1, failureCount: 1, failures: [{ line: `not ok 1 - a\n${forged}`, detail: `  row\n${forged}${LINE_SEP}${forged}` }] };
  const storedText = checkFeedback([check("failed", "", stored)]);
  const storedLines = storedText.split("\n").filter(line => line.includes(forged));
  assert.equal(storedLines.length, 2);
  assert.ok(storedLines.every(line => line.startsWith("| ")), storedLines.join("\n"));
  assert.ok(!storedText.includes(LINE_SEP));
});

test("control and format characters in output lines and command arguments never reach the feedback", () => {
  const output = `not ok 1 - a${LINE_SEP}b${RLO}c${C1_CSI}d${ESC}]0;title${BEL}e\tf${FORMAT}g\n`;
  const text = checkFeedback([check("failed", output, scanCheckOutput(output), ["test", `--name=x${FORMAT}y`])]);
  for (const code of [0x2028, 0x202e, 0x9b, 0x1b, 0x07, 0x09, 0x061c, 0x206a, 0x00ad, 0x2060]) assert.ok(!text.includes(String.fromCodePoint(code)), `code ${code.toString(16)}`);
  assert.match(text, /not ok 1 - a/);
  assert.match(text, /command npm test --name=x {4}y\./);
});

test("a check without a scan gives the same feedback as one with it", () => {
  const output = "not ok 1 - alpha\n  ---\n  error: 'a'\n  ...\nnot ok 2 - beta\n";
  assert.equal(checkFeedback([check("failed", output)]), checkFeedback([check("failed", output, scanCheckOutput(output))]));
});

test("the fallback scan counts a test point inside a block that began before the kept output", () => {
  const kept = "    not ok 77 - inside lost YAML header\n  ...\nnot ok 2 - actual\n";
  assert.match(checkFeedback([check("failed", kept)]), /The host found 2 failure lines/);
});

test("teamCommand feeds the observer while the command runs and survives an observer that throws", async () => {
  const code = `process.stdout.write("not ok 1 - early failure\\n"); for (let i = 0; i < 8000; i++) process.stdout.write("ok " + (i + 2) + " - passing line padding\\n"); process.exitCode = 1;`;
  const command = { command: process.execPath, args: ["-e", code] };
  const scanner = new CheckOutputScanner();
  const result = await teamCommand(command, tmpdir(), undefined, 60000, undefined, undefined, undefined, undefined, (chunk, stream) => scanner.push(chunk, stream));
  const scan = scanner.finish();
  assert.equal(result.exitCode, 1);
  assert.ok(scan.bytes > 70000, `the command wrote ${scan.bytes} bytes`);
  assert.equal(scan.failures[0]!.line, "not ok 1 - early failure");
  assert.ok(!result.output.includes("early failure"), "the early failure is outside the kept output");

  const thrown = await teamCommand(command, tmpdir(), undefined, 60000, undefined, undefined, undefined, undefined, () => { throw new Error("observer"); });
  assert.equal(thrown.exitCode, 1);
  assert.ok(thrown.output.includes("passing line padding"));
});

const JEST_OUTPUT = [
  "FAIL modules/example/example.spec.ts (5.123 s)",
  "  ● Example suite › does the thing",
  "",
  "    expect(received).toBe(expected) // Object.is equality",
  "",
  "    Expected: 1",
  "    Received: 2",
  "",
  "      at Object.<anonymous> (modules/example/example.spec.ts:11:19)",
  "",
  "Test Suites: 1 failed, 510 passed, 511 total",
  "Tests:       1 failed, 8363 passed, 8364 total",
  "",
].join("\n");

const VITEST_OUTPUT = [
  " FAIL  src/example.test.ts > Example suite > does the thing",
  "AssertionError: expected 2 to be 1",
  " ❯ src/example.test.ts:11:19",
  " Test Files  1 failed | 3 passed (4)",
  "      Tests  1 failed | 20 passed (21)",
  "",
].join("\n");

test("Jest and Vitest failures yield the failing test, a missing-test line yields itself, and Console yields nothing", () => {
  const jest = scanParts([{ stream: "stderr", text: JEST_OUTPUT }]);
  assert.deepEqual(jest.failures.map(failure => failure.line), ["● Example suite › does the thing"]);
  assert.ok(jest.failures[0]!.detail.includes("Expected: 1"));
  assert.deepEqual(scanParts([{ stream: "stderr", text: "  ● Console\n\n    console.log\n      hello\n\n" }]).failures, []);
  const vitest = scanCheckOutput(VITEST_OUTPUT);
  assert.deepEqual(vitest.failures.map(failure => failure.line), ["FAIL  src/example.test.ts > Example suite > does the thing"]);
  assert.ok(vitest.failures[0]!.detail.includes("AssertionError: expected 2 to be 1"));
  assert.ok(!vitest.failures[0]!.detail.includes("Test Files"));
  assert.deepEqual(scanCheckOutput("No tests found, exiting with code 1\n").failures.map(failure => failure.line), ["No tests found, exiting with code 1"]);
});

test("an unrecognised failure keeps the last 20 non-empty lines, cleaned, and cuts from the front to 2,000 characters", () => {
  const rows = Array.from({ length: 25 }, (_, index) => `row ${index + 1}`);
  const short = unrecognisedTail([...rows, "", "  "].join("\n"));
  assert.equal(short, ["No failure line was recognised. Last lines of the output:", ...rows.slice(5)].join("\n"));
  const long = unrecognisedTail(`${"x".repeat(3000)}\n${"y".repeat(1500)}\nend\u001b[31m\n`);
  assert.ok(long.length <= 2000, `tail is ${long.length} characters`);
  assert.ok(long.endsWith("\nend"));
  assert.ok(long.startsWith("No failure line was recognised. Last lines of the output:\n"));
});

test("the unrecognised tail stays within 2,000 characters, keeps the last row and drops the first", () => {
  const rows = Array.from({ length: 20 }, (_, index) => `row-${index + 1}-${"x".repeat(100)}`);
  const entry = unrecognisedTail(rows.join("\n"));
  assert.ok(entry.length <= 2000, `entry is ${entry.length} characters`);
  assert.ok(entry.startsWith("No failure line was recognised. Last lines of the output:\n"));
  assert.ok(entry.endsWith(rows[19]!));
  assert.equal(entry.includes("row-1-"), false);
});

test("a tail row keeps its end, so a long line still shows its final error", () => {
  const entry = unrecognisedTail(`${"x".repeat(100000)} ERROR: build failed\n`);
  assert.ok(entry.endsWith("ERROR: build failed"));
});

test("no output, or only blank lines, gives the fixed no-output text", () => {
  assert.equal(unrecognisedTail(""), "The command wrote no output.");
  assert.equal(unrecognisedTail("\n  \n\t\n"), "The command wrote no output.");
});

test("a Jest warning and its coverage line are not failures", () => {
  const warning = [
    "  ● Validation Warning:",
    "",
    "    Unknown option \"testURL\" with value \"http://localhost\" was found.",
    "",
    "Jest: \"global\" coverage threshold for lines (80%) not met: 75%",
    "",
  ].join("\n");
  assert.deepEqual(scanParts([{ stream: "stderr", text: warning }]).failures, []);
});
