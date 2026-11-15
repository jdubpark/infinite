import test from "node:test";
import assert from "node:assert/strict";
import { captureSettings, evalProjectSchema } from "../packages/host/src/eval-config.js";
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
});

test("capture is on only for a GitHub project that asks for it", () => {
  const github = { mode: "github" };
  assert.equal(captureSettings(undefined), undefined);
  assert.equal(captureSettings({ source: github }), undefined);
  assert.equal(captureSettings({ source: github, team: { eval: { capture: false } } }), undefined);
  assert.equal(captureSettings({ source: { mode: "laptop" }, team: { eval: { capture: true } } }), undefined);
  assert.deepEqual(captureSettings({ source: github, team: { eval: { capture: true } } }), { capture: true });
});
