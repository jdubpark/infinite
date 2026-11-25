import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_MAX_BYTES, caseRef, parseReport, type ParsedReport } from "../packages/host/src/eval-report.js";

const JUNIT_OUT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="outer" time="0.001230" disabled="0" errors="0" tests="3" failures="1" skipped="1" hostname="host">
		<testcase name="passes" time="0.000287" classname="test"/>
		<testcase name="fails" time="0.000387" classname="test" failure="Expected values to be strictly equal:1 !== 2">
			<failure type="testCodeFailure" message="Expected values to be strictly equal:1 !== 2">
Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

1 !== 2

    at async Promise.all (index 0) {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  1 !== 2
  
      at TestContext.&lt;anonymous> (file:///fixture/fixture.test.mjs:5:30)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
      at Suite.processPendingSubtests (node:internal/test_runner/test:744:18)
      at Test.postRun (node:internal/test_runner/test:1173:19)
      at Test.run (node:internal/test_runner/test:1101:12)
      at async Promise.all (index 0)
      at async Suite.run (node:internal/test_runner/test:1442:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 2,
    operator: 'strictEqual',
    diff: 'simple'
  }
}
			</failure>
		</testcase>
		<testcase name="is skipped" time="0.000083" classname="test">
			<skipped type="skipped" message="true"/>
		</testcase>
	</testsuite>
	<!-- tests 3 -->
	<!-- suites 1 -->
	<!-- pass 1 -->
	<!-- fail 1 -->
	<!-- cancelled 0 -->
	<!-- skipped 1 -->
	<!-- todo 0 -->
	<!-- duration_ms 49.292083 -->
</testsuites>
`;

const TAP_OUT = `TAP version 13
# Subtest: outer
    # Subtest: passes
    ok 1 - passes
      ---
      duration_ms: 0.288417
      type: 'test'
      ...
    # Subtest: fails
    not ok 2 - fails
      ---
      duration_ms: 0.392167
      type: 'test'
      location: '/fixture/fixture.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:
        
        1 !== 2
        
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 2
      actual: 1
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///fixture/fixture.test.mjs:5:30)
        Test.runInAsyncScope (node:async_hooks:214:14)
        Test.run (node:internal/test_runner/test:1047:25)
        Suite.processPendingSubtests (node:internal/test_runner/test:744:18)
        Test.postRun (node:internal/test_runner/test:1173:19)
        Test.run (node:internal/test_runner/test:1101:12)
        async Promise.all (index 0)
        async Suite.run (node:internal/test_runner/test:1442:7)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
      ...
    # Subtest: is skipped
    ok 3 - is skipped # SKIP
      ---
      duration_ms: 0.08325
      type: 'test'
      ...
    1..3
not ok 1 - outer
  ---
  duration_ms: 1.266084
  type: 'suite'
  location: '/fixture/fixture.test.mjs:3:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 3
# suites 1
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 46.396167
`;

const keyOf = (...parts: string[]): string => caseRef(parts.join("\0"));

const junitSuite = (cases: string): string => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<testsuite name="s">${cases}</testsuite>\n</testsuites>\n`;
const junitCase = (name: string, body = ""): string => (body ? `<testcase name="${name}" classname="c">${body}</testcase>` : `<testcase name="${name}" classname="c"/>`);

test("node's two reporters parse to the same statuses", () => {
  const junit = parseReport("junit", Buffer.from(JUNIT_OUT, "utf8"));
  const tap = parseReport("tap", Buffer.from(TAP_OUT, "utf8"));
  assert.equal(junit.state, "parsed");
  assert.equal(tap.state, "parsed");
  if (junit.state !== "parsed" || tap.state !== "parsed") return;

  assert.deepEqual(
    new Map(junit.cases),
    new Map([
      [keyOf("outer", "test", "passes"), "passed"],
      [keyOf("outer", "test", "fails"), "failed"],
      [keyOf("outer", "test", "is skipped"), "skipped"],
    ]),
  );
  assert.deepEqual(
    new Map(tap.cases),
    new Map([
      [keyOf("outer", "passes"), "passed"],
      [keyOf("outer", "fails"), "failed"],
      [keyOf("outer", "is skipped"), "skipped"],
    ]),
  );
  assert.deepEqual(
    [...tap.cases.keys()].sort(),
    [caseRef("outer\0passes"), caseRef("outer\0fails"), caseRef("outer\0is skipped")].sort(),
  );
  assert.deepEqual(
    [...junit.cases.keys()].sort(),
    [caseRef("outer\0test\0passes"), caseRef("outer\0test\0fails"), caseRef("outer\0test\0is skipped")].sort(),
  );
});

test("a hostile report is invalid, never a pass", () => {
  const state = (format: "junit" | "tap", text: string): string => parseReport(format, Buffer.from(text, "utf8")).state;

  assert.equal(state("junit", `<!DOCTYPE testsuites [<!ENTITY a "b">]>\n${junitSuite(junitCase("t"))}`), "invalid");
  assert.equal(state("junit", junitSuite(junitCase("t")).replace("<testsuites>", "<testsuites><!ENTITY a 'b'>")), "invalid");
  assert.equal(
    state("junit", junitSuite(Array.from({ length: 20_001 }, (_, i) => junitCase(`t${i}`)).join(""))),
    "invalid",
  );
  assert.equal(state("junit", junitSuite(junitCase("x".repeat(4_097)))), "invalid");
  const whole = junitSuite(junitCase("t"));
  assert.equal(state("junit", whole.slice(0, whole.length - 20)), "invalid");
  assert.equal(state("junit", junitSuite(junitCase("t")).replace("</testsuite>", "")), "invalid");

  const duplicate = parseReport(
    "junit",
    Buffer.from(junitSuite(junitCase("d") + junitCase("d", `<failure type="x" message="m"/>`)), "utf8"),
  );
  assert.deepEqual(duplicate, { state: "parsed", cases: new Map([[keyOf("s", "c", "d"), "failed"]]) });

  assert.equal(state("tap", `TAP version 13\n# ${"x".repeat(16_385)}\n1..0\n`), "invalid");
  assert.equal(state("tap", `TAP version 13\n1..0\n${"\n".repeat(200_001)}`), "invalid");
  assert.equal(state("tap", "TAP version 13\nok 1 - a\n"), "invalid");
  assert.equal(state("junit", " ".repeat(REPORT_MAX_BYTES + 1)), "invalid");
});

test("a report near 8 MiB parses in linear time", () => {
  const head = junitSuite(
    Array.from({ length: 19_000 }, (_, i) => junitCase(`case ${i} &amp; more`, `<failure type="x" message="m"/>`)).join(""),
  );
  const room = REPORT_MAX_BYTES - Buffer.byteLength(head, "utf8") - 200;
  const filler = "&amp;&lt;x&gt;".repeat(Math.floor(room / 14));
  const text = head.replace("</testsuite>", `<system-out>${filler}</system-out></testsuite>`);
  const bytes = Buffer.from(text, "utf8");
  assert.ok(bytes.length > REPORT_MAX_BYTES - 1_000 && bytes.length <= REPORT_MAX_BYTES);

  const started = performance.now();
  const parsed: ParsedReport = parseReport("junit", bytes);
  const elapsed = performance.now() - started;

  assert.equal(parsed.state, "parsed");
  if (parsed.state === "parsed") assert.equal(parsed.cases.size, 19_000);
  assert.ok(elapsed < 2_000, `parsing took ${elapsed.toFixed(0)} ms`);
});
