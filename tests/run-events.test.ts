import test from "node:test";
import assert from "node:assert/strict";
import { pathField, planDigest, runEventKey, runSummaryCounts } from "../packages/host/src/run-events.js";
import type { TeamRun, TeamTaskPlan } from "../packages/host/src/team-types.js";

test("a run event key joins the kind, the run, and the parts", () => {
  assert.equal(runEventKey("run.created", "r1"), "run.created:r1");
  assert.equal(runEventKey("run.blocked", "r1", [2, "2026-01-01T00:00:00.000Z"]), "run.blocked:r1:2:2026-01-01T00:00:00.000Z");
});

test("run summary counts read the record", () => {
  const task = (id: string, status: string) => ({ id, status }) as unknown as TeamRun["tasks"][number];
  const decision = (answeredBy?: "owner" | "coordinator") => ({ id: "d", answeredBy }) as unknown as TeamRun["decisions"][number];
  const run = {
    tasks: [task("a", "integrated"), task("b", "running")],
    members: [{}, {}, {}],
    round: 2,
    checks: [{}, {}, {}, {}],
    recovery: { attempts: 1 },
    decisions: [decision("owner"), decision("coordinator"), decision()],
    steering: [{}, {}],
    permissionDecisions: [{ status: "escalated" }, { status: "approved" }],
    continuations: [{}],
  } as unknown as TeamRun;
  assert.deepEqual(runSummaryCounts(run), {
    tasks: 2, integrated: 1, members: 3, round: 2, checks: 4, recoveries: 1,
    decisionsByOwner: 1, decisionsByCoordinator: 1, steering: 2, permissionEscalations: 1, continuations: 1,
  });
  const minimal = { tasks: [], members: [], round: 0, checks: [], decisions: [], steering: [] } as unknown as TeamRun;
  assert.deepEqual(runSummaryCounts(minimal), {
    tasks: 0, integrated: 0, members: 0, round: 0, checks: 0, recoveries: 0,
    decisionsByOwner: 0, decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0,
  });
});

test("a plan digest covers every planned field", () => {
  const task = (overrides: Partial<TeamTaskPlan> = {}): TeamTaskPlan => ({
    id: "a", title: "Title", instructions: "Do it", paths: ["src/a.ts"], dependsOn: [], ...overrides,
  });
  const second = task({ id: "b", paths: ["src/b.ts"], dependsOn: ["a"] });
  const plan = [task(), second];
  const digest = planDigest(plan);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(planDigest(structuredClone(plan)), digest);
  assert.notEqual(planDigest([task({ instructions: "Do something else" }), second]), digest, "instructions");
  assert.notEqual(planDigest([task({ kind: "fix" }), second]), digest, "kind");
  assert.notEqual(planDigest([task({ risk: "elevated" }), second]), digest, "risk");
  assert.notEqual(planDigest([second, task()]), digest, "task order");
});

test("a path list over its byte budget is omitted", () => {
  assert.deepEqual(pathField(["a.ts"]), { paths: ["a.ts"] });
  // The JSON of ["abcdef"] is ten bytes.
  assert.deepEqual(pathField(["abcdef"], 10), { paths: ["abcdef"] });
  assert.deepEqual(pathField(["abcdefg"], 10), { pathsOmitted: true });
});
