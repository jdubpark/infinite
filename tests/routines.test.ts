import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoutineService } from "../packages/host/src/routines.js";
import type { CreateRoutine, Routine } from "../packages/host/src/routine-types.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";
import { TeamError } from "../packages/host/src/teams.js";

const lineup = {
  coordinator: { id: "coord", label: "Coordinator", provider: "claude", model: "model", effort: "high", tier: "strong" },
  implementers: [], escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "model", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "model", effort: "high", tier: "strong" },
} as Config["teams"] extends { lineup?: infer T } ? T : never;

function setup(overrides: { busy?: (id: string) => Promise<boolean>; launch?: (request: CreateGoal) => Promise<ProductGoal> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "routine-test-"));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const config = {
    stateDir, projects: [{ id: "demo", name: "Demo", path: root, team: { checks: [{ command: "node", args: ["check.js"] }] } }],
    teams: { lineup, trustWorkspaces: true, commandPrefix: { command: "safe", args: [] } }, agents: { claude: { command: "claude", args: [] } },
  } as unknown as Config;
  const key = Buffer.alloc(32, 7);
  const goals = new Map<string, ProductGoal>();
  const launched: CreateGoal[] = [];
  const hooks = {
    isProjectBusy: overrides.busy ?? (async () => false),
    startGoal: overrides.launch ?? (async (request, admit) => {
      admit();
      launched.push(structuredClone(request));
      const goal = { ...request, id: request.requestId, requestId: undefined, revision: 1, status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(), lineup, cycles: [], memberCount: 0, steering: [], events: [], outcomes: [] } as unknown as ProductGoal;
      goals.set(goal.id, goal); return structuredClone(goal);
    }),
  };
  const createService = () => new RoutineService(config, key, { get: id => { const goal = goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return structuredClone(goal); } } as never, hooks);
  const create = (fields: Partial<CreateRoutine> = {}): CreateRoutine => {
    const start = new Date(Date.now() + 20).toISOString();
    return { requestId: randomUUID(), goal: { projectId: "demo", title: "Small task", objective: "Do the bounded work", successCriteria: "The requested change is available", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 }, intervalMinutes: 5, maxOccurrences: 2, startsAt: start, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), ...fields };
  };
  return { root, config, key, goals, launched, createService, create };
}
const action = (revision: number) => ({ requestId: randomUUID(), revision });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("routine launch intent survives restart and replays the same goal request after an uncertain acknowledgement", async () => {
  const f = setup();
  try {
    let firstCall = true, ids: string[] = [];
    const first = new RoutineService(f.config, f.key, { get: id => { const goal = f.goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return goal; } } as never, {
      isProjectBusy: async () => false,
      startGoal: async (request, admit) => { ids.push(request.requestId); admit(); if (firstCall) { firstCall = false; throw new Error("ack lost"); } return ({ id: request.requestId, status: "running", cycles: [], ...request } as unknown as ProductGoal); },
    });
    const created = await first.create(f.create());
    await wait(30); await first.tick();
    assert.equal(first.get(created.id).status, "blocked");
    first.close();
    const restarted = new RoutineService(f.config, f.key, { get: id => { const goal = f.goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return goal; } } as never, {
      isProjectBusy: async () => false,
      startGoal: async (request, admit) => { ids.push(request.requestId); admit(); return ({ id: request.requestId, status: "running", cycles: [], ...request } as unknown as ProductGoal); },
    });
    await restarted.tick();
    const result = restarted.get(created.id);
    assert.equal(result.occurrences.length, 1);
    assert.equal(result.occurrences[0].goalId, ids[0]);
    assert.deepEqual(ids, [ids[0], ids[0]]);
    restarted.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("changed project authority blocks launch and resume does not renew the approval", async () => {
  const f = setup(); const service = f.createService();
  try {
    const created = await service.create(f.create());
    f.config.projects[0]!.team!.checks[0]!.args = ["different.js"];
    await service.tick();
    const blocked = service.get(created.id);
    assert.equal(blocked.status, "blocked"); assert.equal(f.launched.length, 0);
    await assert.rejects(service.resume(created.id, action(blocked.revision)), /approval policy changed/);
    assert.equal(f.launched.length, 0);
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a pending project run prevents overlap and launch is skipped when the approved budget cannot fit", async () => {
  const f = setup({ busy: async () => true }); const service = f.createService();
  try {
    const created = await service.create(f.create()); await wait(30); await service.tick();
    assert.equal(f.launched.length, 0); assert.match(service.get(created.id).reason!, /active work/);
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
  const second = setup(); const service2 = second.createService();
  try {
    const req = second.create({ expiresAt: new Date(Date.now() + 1000).toISOString(), startsAt: new Date(Date.now() + 10).toISOString() });
    const created = await service2.create(req); await wait(30); await service2.tick();
    assert.equal(service2.get(created.id).status, "expired"); assert.equal(second.launched.length, 0);
  } finally { service2.close(); rmSync(second.root, { recursive: true, force: true }); }
});

test("pause and cancel stop future triggers while preserving the active goal reference", async () => {
  const f = setup(); const service = f.createService();
  try {
    const created = await service.create(f.create()); await wait(30); await service.tick();
    const active = service.get(created.id); assert.equal(active.status, "running"); assert.ok(active.activeGoalId);
    const paused = await service.pause(created.id, action(active.revision));
    assert.match(paused.reason!, /active goal retains/); assert.equal(paused.activeGoalId, active.activeGoalId);
    const cancelled = await service.cancel(created.id, action(paused.revision));
    assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.activeGoalId, active.activeGoalId);
    assert.equal(f.launched.length, 1);
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("owner actions are idempotent and stale revisions are rejected", async () => {
  const f = setup(); const service = f.createService();
  try {
    const created = await service.create(f.create());
    const pause = action(created.revision), result = await service.pause(created.id, pause);
    assert.deepEqual(await service.pause(created.id, pause), result);
    await assert.rejects(service.resume(created.id, action(created.revision)), /changed/);
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("needs-input and failed goals block progression while retaining the child for owner review", async () => {
  const f = setup(); const service = f.createService();
  try {
    const created = await service.create(f.create()); await wait(30); await service.tick();
    const active = service.get(created.id); const goal = f.goals.get(active.activeGoalId!)!;
    f.goals.set(goal.id, { ...goal, status: "needs-input", reason: "owner input required" });
    await service.tick();
    assert.equal(service.get(created.id).status, "blocked"); assert.equal(service.get(created.id).activeGoalId, goal.id);
    assert.equal(f.launched.length, 1);
    const paused = service.get(created.id);
    await service.resume(created.id, action(paused.revision));
    await service.tick();
    assert.equal(service.get(created.id).status, "blocked", "resume rechecks the same unresolved child instead of authorizing another run");
    assert.equal(service.get(created.id).activeGoalId, goal.id);
    f.goals.set(goal.id, { ...goal, status: "blocked", reason: "review failed" });
    await service.tick();
    assert.equal(service.get(created.id).status, "blocked"); assert.equal(service.get(created.id).activeGoalId, goal.id); assert.equal(f.launched.length, 1);
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an achieved child with unmerged cycles cannot unlock another routine occurrence", async () => {
  const f = setup(); const service = f.createService();
  try {
    const created = await service.create(f.create()); await wait(30); await service.tick();
    const routine = service.get(created.id), child = f.goals.get(routine.activeGoalId!)!;
    f.goals.set(child.id, { ...child, status: "achieved", cycles: [{ teamId: randomUUID(), cycle: 1, goalRevision: 1, status: "ready-for-review", startedAt: new Date().toISOString(), memberCount: 1 }] });
    await service.tick();
    const result = service.get(created.id);
    assert.equal(result.status, "blocked");
    assert.equal(result.activeGoalId, child.id);
    assert.match(result.reason!, /unmerged work/);
    assert.equal(f.launched.length, 1);
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a cancelled routine reconciles an accepted uncertain launch after restart without another launch", async () => {
  const f = setup(); let calls = 0, acceptedId = "";
  const service = new RoutineService(f.config, f.key, { get: id => { const goal = f.goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return goal; } } as never, {
    isProjectBusy: async () => false,
    startGoal: async (request, admit) => {
      calls++; admit(); acceptedId = request.requestId;
      const goal = { ...request, id: request.requestId, status: "running", cycles: [], activeTeamId: "team-active" } as unknown as ProductGoal;
      f.goals.set(goal.id, goal);
      throw new Error("ack lost after goal creation");
    },
  });
  try {
    const created = await service.create(f.create()); await wait(30); await service.tick();
    const blocked = service.get(created.id);
    const cancelled = await service.cancel(created.id, action(blocked.revision));
    assert.equal(cancelled.status, "cancelled");
    service.close();
    const restarted = new RoutineService(f.config, f.key, { get: id => { const goal = f.goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return goal; } } as never, {
      isProjectBusy: async () => false,
      startGoal: async () => { calls++; throw new Error("must not launch a second time"); },
    });
    await restarted.tick();
    const result = restarted.get(created.id);
    assert.equal(result.status, "cancelled"); assert.equal(result.activeGoalId, acceptedId);
    assert.equal(result.occurrences.length, 1); assert.equal(calls, 1);
    restarted.close();
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a confirmed launch is reconciled after approval expiry without creating a late goal", async () => {
  const f = setup(); let service: RoutineService | undefined, acceptedId = "";
  service = new RoutineService(f.config, f.key, { get: id => { const goal = f.goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return goal; } } as never, {
    isProjectBusy: async () => false,
    startGoal: async (request, admit) => {
      admit(); acceptedId = request.requestId;
      const goal = { ...request, id: request.requestId, status: "running", cycles: [], activeTeamId: "team-active" } as unknown as ProductGoal;
      f.goals.set(goal.id, goal);
      service!.close(); // Simulate shutdown after GoalService accepts, before the routine receipt is saved.
      return goal;
    },
  });
  const realNow = Date.now;
  try {
    const created = await service.create(f.create({ expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }));
    await wait(30); await service.tick(); service.close();
    Date.now = () => realNow() + 11 * 60_000;
    const restarted = new RoutineService(f.config, f.key, { get: id => { const goal = f.goals.get(id); if (!goal) throw new TeamError(404, "goal-not-found", "missing"); return goal; } } as never, {
      isProjectBusy: async () => false,
      startGoal: async () => { throw new Error("an expired approval must not create a goal"); },
    });
    await restarted.tick();
    assert.equal(restarted.get(created.id).status, "expired");
    assert.equal(restarted.get(created.id).activeGoalId, undefined);
    await restarted.tick();
    assert.equal(restarted.get(created.id).status, "expired");
    assert.equal(restarted.get(created.id).activeGoalId, acceptedId);
    assert.equal(restarted.get(created.id).occurrences.length, 1);
    restarted.close();
  } finally { Date.now = realNow; service?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a settled no-opportunity recurs on cadence and completes at the approved occurrence cap", async () => {
  const f = setup(); const service = f.createService(); const realNow = Date.now;
  try {
    const created = await service.create(f.create({ maxOccurrences: 2 }));
    await wait(30); Date.now = () => realNow() + 60_000; await service.tick();
    let routine = service.get(created.id), first = f.goals.get(routine.activeGoalId!)!;
    f.goals.set(first.id, { ...first, status: "no-opportunity", cycles: [] });
    await service.tick();
    routine = service.get(created.id);
    assert.equal(routine.occurrences.length, 1);
    assert.equal(routine.status, "running");
    assert.ok(Date.parse(routine.nextRunAt) > Date.now());
    Date.now = () => realNow() + 7 * 60_000;
    await service.tick();
    routine = service.get(created.id);
    assert.equal(routine.occurrences.length, 2);
    const second = f.goals.get(routine.activeGoalId!)!;
    f.goals.set(second.id, { ...second, status: "no-opportunity", cycles: [] });
    await service.tick();
    routine = service.get(created.id);
    assert.equal(routine.status, "completed");
    assert.equal(routine.occurrences.length, 2);
    assert.equal(f.launched.length, 2);
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});
