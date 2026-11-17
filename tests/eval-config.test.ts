import test from "node:test";
import assert from "node:assert/strict";
import { captureSettings, evalHostSchema, evalProjectSchema, mineSettings, validationSettings } from "../packages/host/src/eval-config.js";
import { teamProjectSchema } from "../packages/host/src/team-types.js";

const base = { checks: [], establishChecks: true } as const;

test("the eval block is optional and strict", () => {
  const without = teamProjectSchema.parse(base);
  assert.deepEqual(without, { checks: [], establishChecks: true });
  assert.equal("eval" in without, false);

  assert.deepEqual(teamProjectSchema.parse({ ...base, eval: { capture: true } }).eval, { capture: true });

  const rejects = (eval_: unknown) => assert.equal(teamProjectSchema.safeParse({ ...base, eval: eval_ }).success, false);
  rejects({ capture: true, unknownKey: 1 });
  rejects({ capture: true, retentionDays: 29 });
  rejects({ capture: true, retentionDays: 3651 });
  rejects({ testPaths: { prefixes: Array.from({ length: 33 }, (_, i) => `dir${i}/`), suffixes: [] } });
  rejects({ testPaths: { prefixes: [], suffixes: [] } });
  rejects({ testPaths: { prefixes: ["/abs"], suffixes: [] } });
  rejects({ testPaths: { prefixes: ["a/../b"], suffixes: [] } });
  rejects({ testPaths: { prefixes: ["a\\b"], suffixes: [] } });
  rejects({ testPaths: { prefixes: [], suffixes: ["a/b"] } });
  rejects({ excludeAreas: ["UI"] });
  rejects({ excludeAreas: Array.from({ length: 33 }, (_, i) => `area-${i}`) });
  assert.equal(evalProjectSchema.safeParse({ testPaths: { prefixes: ["tests"], suffixes: [".test.ts"] }, excludeAreas: ["ui-shell"], retentionDays: 30 }).success, true);

  const validation = {
    mine: true,
    gradingPaths: ["packages/host/src"],
    focusedTest: { command: "node", args: ["--import", "tsx", "--test", "{files}", "--test-reporter-destination={report}"] },
    reportFormat: "junit",
    guardChecks: [{ command: "node", args: ["scripts/check.mjs"] }],
  };
  assert.deepEqual(evalProjectSchema.parse({ mine: true }), { mine: true });
  assert.deepEqual(evalProjectSchema.parse(validation), validation);
  const focused = (args: string[], command = "node") => ({ ...validation, focusedTest: { command, args } });
  const refuses = (value: unknown) => assert.equal(evalProjectSchema.safeParse(value).success, false);
  refuses(focused(["{files}", "{files}", "--test-reporter-destination={report}"]));
  refuses(focused(["--x={files}", "--test-reporter-destination={report}"]));
  refuses(focused(["{files}"]));
  refuses(focused(["{files}", "{report}", "{report}"]));
  refuses(focused(["{files}", "{report}"], "{report}"));
  refuses({ ...validation, gradingPaths: Array.from({ length: 65 }, (_, i) => `dir${i}`) });
  refuses({ ...validation, gradingPaths: ["a/../b"] });
  refuses({ ...validation, reportFormat: "xml" });
  refuses({ ...validation, guardChecks: Array.from({ length: 9 }, () => ({ command: "node", args: [] })) });
});

test("mining is on only for a GitHub project that asks for it", () => {
  const github = { mode: "github" };
  assert.equal(mineSettings(undefined), undefined);
  assert.equal(mineSettings({ source: github }), undefined);
  assert.equal(mineSettings({ source: github, team: { eval: {} } }), undefined);
  assert.equal(mineSettings({ source: github, team: { eval: { mine: false } } }), undefined);
  assert.equal(mineSettings({ source: { mode: "laptop" }, team: { eval: { mine: true } } }), undefined);
  assert.equal(mineSettings({ source: github, team: { eval: { capture: true } } }), undefined);
  assert.deepEqual(mineSettings({ source: github, team: { eval: { mine: true } } }), { mine: true });
});

test("a validate job names the first missing setting", () => {
  const github = { mode: "github" };
  const focusedTest = { command: "node", args: ["--import", "tsx", "--test", "{files}", "--test-reporter-destination={report}"] };
  const checks = [{ command: "node", args: ["check.js"] }];
  const setup = { command: "npm", args: ["ci"] };
  const complete = { checks, setup, eval: { focusedTest, reportFormat: "junit" as const } };
  assert.deepEqual(validationSettings({ source: { mode: "laptop" }, team: complete }), { missing: "source" });
  assert.deepEqual(validationSettings({ source: github, team: { checks, eval: { reportFormat: "junit" } } }), { missing: "focusedTest" });
  assert.deepEqual(validationSettings({ source: github, team: { checks, eval: { focusedTest } } }), { missing: "reportFormat" });
  assert.deepEqual(validationSettings({ source: github, team: complete }), {
    settings: { focusedTest, reportFormat: "junit", gradingPaths: [], guardChecks: checks, setup },
  });
  const overridden = [{ command: "node", args: ["guard.js"] }];
  const withGuards = validationSettings({ source: github, team: { checks, eval: { focusedTest, reportFormat: "tap", guardChecks: overridden } } });
  assert.deepEqual(withGuards, { settings: { focusedTest, reportFormat: "tap", gradingPaths: [], guardChecks: overridden } });

  const grader = { prefix: { command: "sudo", args: ["-n", "-u", "infinite-grader", "--", "/usr/local/libexec/infinite/grader-command"] }, root: "/var/lib/infinite-grader" };
  assert.equal(evalHostSchema.safeParse({ grader }).success, true);
  assert.equal(evalHostSchema.safeParse({ grader: { ...grader, root: "relative/root" } }).success, false);
  assert.equal(evalHostSchema.safeParse({ grader: { ...grader, canaries: ["relative/key"] } }).success, false);
  assert.equal(evalHostSchema.safeParse({ grader: { ...grader, canaries: Array.from({ length: 33 }, (_, i) => `/canary/${i}`) } }).success, false);
  assert.equal(evalHostSchema.safeParse({ grader, unknownKey: 1 }).success, false);
});

test("capture is on only for a GitHub project that asks for it", () => {
  const github = { mode: "github" };
  assert.equal(captureSettings(undefined), undefined);
  assert.equal(captureSettings({ source: github }), undefined);
  assert.equal(captureSettings({ source: github, team: { eval: { capture: false } } }), undefined);
  assert.equal(captureSettings({ source: { mode: "laptop" }, team: { eval: { capture: true } } }), undefined);
  assert.deepEqual(captureSettings({ source: github, team: { eval: { capture: true } } }), { capture: true });
});
