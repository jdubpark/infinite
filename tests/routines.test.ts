import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoutineService } from "../packages/host/src/routines.js";
import type { CreateRoutine, Routine } from "../packages/host/src/routine-types.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { ProjectSignal, SignalKind, SignalReader } from "../packages/host/src/signals/types.js";
import type { Config } from "../packages/host/src/types.js";
import { TeamError } from "../packages/host/src/teams.js";
import { teamProjectSchema } from "../packages/host/src/team-types.js";
import { unseal } from "../packages/host/src/vault.js";

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

test("outcome settings stay out of the routine approval digest", async () => {
  const f = setup(); const service = f.createService();
  try {
    await service.create(f.create()); await wait(30); await service.tick();
    f.config.teams!.outcomes = { holdDays: 14, retentionDays: 365 };
    await service.tick();
    const active = service.list()[0]!;
    assert.equal(active.status, "running");
    f.config.teams!.stallMinutes = 30;
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked");
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("blackboard switches change the routine approval digest", async () => {
  const f = setup(); const service = f.createService();
  try {
    await service.create(f.create()); await wait(30); await service.tick();
    f.config.teams!.blackboard = { tools: true };
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked");
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("eval settings stay out of the routine approval digest", async () => {
  const f = setup(); const service = f.createService();
  try {
    await service.create(f.create()); await wait(30); await service.tick();
    f.config.projects[0]!.team!.eval = { capture: true, retentionDays: 90, mine: true, focusedTest: { command: "node", args: ["{files}", "--test-reporter-destination={report}"] }, reportFormat: "junit", gradingPaths: ["package.json"] };
    f.config.eval = { grader: { prefix: { command: "sudo", args: ["-n", "-u", "infinite-grader", "--", "/usr/local/libexec/infinite/grader-command"] }, root: "/var/lib/infinite-grader" } };
    await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    f.config.projects[0]!.team!.features = { areas: [{ id: "host", paths: ["src"] }] };
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked");
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("routing settings change the approval digest, and their absence keeps it", async () => {
  const f = setup(); const service = f.createService();
  try {
    await service.create(f.create()); await wait(30); await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    f.config.projects[0]!.team!.routing = undefined;
    await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    f.config.projects[0]!.team!.routing = { mode: "shadow" };
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked");
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("the objective switch is inside the routine approval digest", async () => {
  const f = setup(); let service = f.createService();
  try {
    const team = teamProjectSchema.parse(f.config.projects[0]!.team);
    assert.equal(Object.hasOwn(team, "objective"), false, "the schema adds no objective key by default");
    f.config.projects[0]!.team = team;
    await service.create(f.create()); await wait(30); await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    service.close(); service = f.createService(); await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    f.config.projects[0]!.team = teamProjectSchema.parse({ ...team, objective: { prompts: "off" } });
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked");
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("the intent check settings are inside the routine approval digest", async () => {
  const f = setup(); let service = f.createService();
  try {
    await service.create(f.create()); await wait(30); await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    service.close(); service = f.createService(); await service.tick();
    assert.equal(service.list()[0]!.status, "running", "a reload keeps the stored authority with both keys absent");
    f.config.projects[0]!.team = { ...f.config.projects[0]!.team!, objective: { intentCheck: "off" } };
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked");
    const second = await service.create(f.create()); await wait(30); await service.tick();
    assert.equal(service.get(second.id).status, "running", "a second routine starts under the current authority");
    f.config.teams!.lineup = { ...f.config.teams!.lineup!, evaluators: [{ id: "astra", label: "Astra", provider: "codex", model: "astra", effort: "high", tier: "strong" }] } as never;
    await service.tick();
    assert.equal(service.get(second.id).status, "blocked", "the lineup's evaluators change the authority digest");
  } finally { service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("the register setting is inside the routine approval digest", async () => {
  const f = setup(); let service = f.createService();
  try {
    await service.create(f.create()); await wait(30); await service.tick();
    assert.equal(service.list()[0]!.status, "running");
    service.close(); service = f.createService(); await service.tick();
    assert.equal(service.list()[0]!.status, "running", "a reload keeps the stored authority with the key absent");
    f.config.projects[0]!.team = { ...f.config.projects[0]!.team!, objective: { register: "on" } };
    await service.tick();
    assert.equal(service.list()[0]!.status, "blocked", "writing the register key blocks the active routine");
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

/** An in-memory inbox for project "demo" that counts its reads. */
function inbox() {
  const signals: ProjectSignal[] = [];
  let reads = 0, unreadable = false;
  const reader: SignalReader = {
    head: () => unreadable ? undefined : signals.at(-1)?.seq ?? 0,
    after: (projectId, seq, options) => {
      if (unreadable) return [];
      reads++;
      return signals.filter(signal => signal.projectId === projectId && signal.seq > seq && (!options?.kinds || options.kinds.includes(signal.kind))).slice(0, options?.limit ?? 50);
    },
  };
  const add = (kind: SignalKind, runId?: string) => {
    const signal: ProjectSignal = { seq: signals.length + 1, id: randomUUID(), projectId: "demo", kind, key: randomUUID(), at: new Date().toISOString(), ...(runId ? { runId } : {}) };
    signals.push(signal);
    return signal;
  };
  return { reader, add, reads: () => reads, down: (value: boolean) => { unreadable = value; } };
}
const settle = (f: ReturnType<typeof setup>, goalId: string, cycles: ProductGoal["cycles"] = []) =>
  f.goals.set(goalId, { ...f.goals.get(goalId)!, status: cycles.length ? "achieved" : "no-opportunity", cycles });

test("a waiting signal starts one early occurrence after the gap, and signals during a run start one follow-on", async () => {
  const f = setup(); const service = f.createService(); const signals = inbox(); const realNow = Date.now;
  service.useSignals(signals.reader, () => []);
  const at = (minutes: number) => { Date.now = () => realNow() + minutes * 60_000; };
  try {
    const created = await service.create(f.create({ intervalMinutes: 60, maxOccurrences: 3, wakeOn: ["owner"] }));
    assert.equal(service.get(created.id).signalCursor, 0);
    at(1); await service.tick();
    const firstGoal = service.get(created.id).activeGoalId!;
    const first = signals.add("owner");
    await service.tick();
    assert.deepEqual(service.get(created.id).pendingWake?.signals.map(signal => signal.id), [first.id]);
    settle(f, firstGoal); await service.tick();
    assert.ok(service.get(created.id).occurrences[0]!.endedAt);

    at(3); await service.tick();
    assert.equal(f.launched.length, 1, "the 5-minute gap since the occurrence ended still holds");
    at(7); await service.tick();
    let routine = service.get(created.id);
    assert.equal(f.launched.length, 2);
    assert.deepEqual(routine.occurrences[1]!.wake, { signalIds: [first.id], dropped: 0 });
    assert.equal(routine.pendingWake, undefined);
    assert.ok(Date.parse(routine.nextRunAt) > Date.now(), "nextRunAt is set as a normal start sets it");
    const { requestId: _first, ...template } = f.launched[0]!, { requestId: _second, ...early } = f.launched[1]!;
    assert.deepEqual(early, template, "the goal template is unchanged");

    const during = [signals.add("owner"), signals.add("owner")];
    await service.tick();
    settle(f, routine.activeGoalId!); await service.tick();
    at(13); await service.tick();
    routine = service.get(created.id);
    assert.equal(f.launched.length, 3, "two signals during a run start one follow-on");
    assert.deepEqual(routine.occurrences[2]!.wake?.signalIds, during.map(signal => signal.id));
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("signals that arrive together start one occurrence, however many there are", async () => {
  const f = setup(); const service = f.createService(); const signals = inbox(); const realNow = Date.now;
  service.useSignals(signals.reader, () => []);
  const at = (minutes: number) => { Date.now = () => realNow() + minutes * 60_000; };
  try {
    const created = await service.create(f.create({ intervalMinutes: 60, maxOccurrences: 3, wakeOn: ["owner"], expiresAt: new Date(realNow() + 3 * 3_600_000).toISOString() }));
    at(1); await service.tick();
    settle(f, service.get(created.id).activeGoalId!); await service.tick();
    // One more signal than a pass reads, all recorded before the next pass and after the gap.
    at(10);
    const batch = Array.from({ length: 51 }, () => signals.add("owner"));
    await service.tick();
    assert.equal(f.launched.length, 1, "more signals wait than the pass read, so nothing starts yet");
    await service.tick();
    const routine = service.get(created.id);
    assert.equal(f.launched.length, 2);
    assert.deepEqual(routine.occurrences[1]!.wake, { signalIds: batch.slice(-20).map(signal => signal.id), dropped: 31 });
    assert.equal(routine.signalCursor, 51);
    assert.equal(routine.pendingWake, undefined);
    settle(f, routine.activeGoalId!); await service.tick();
    at(20); await service.tick();
    assert.equal(f.launched.length, 2, "the rest of the batch starts no second occurrence");
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an unreadable inbox starts nothing early and never uses up a waiting batch", async () => {
  let duringBusyCheck = () => {};
  const f = setup({ busy: async () => { duringBusyCheck(); return false; } }); const service = f.createService(); const signals = inbox(); const realNow = Date.now;
  service.useSignals(signals.reader, () => []);
  const at = (minutes: number) => { Date.now = () => realNow() + minutes * 60_000; };
  try {
    const created = await service.create(f.create({ intervalMinutes: 60, maxOccurrences: 4, wakeOn: ["owner"], expiresAt: new Date(realNow() + 5 * 3_600_000).toISOString() }));
    at(1); await service.tick();
    settle(f, service.get(created.id).activeGoalId!); await service.tick();

    // The inbox fails between the first read and the launch: the early start waits for a readable inbox.
    at(10);
    const early = signals.add("owner");
    duringBusyCheck = () => signals.down(true);
    await service.tick();
    assert.equal(f.launched.length, 1);
    duringBusyCheck = () => {};
    signals.down(false);
    await service.tick();
    assert.equal(f.launched.length, 2);
    assert.deepEqual(service.get(created.id).occurrences[1]!.wake, { signalIds: [early.id], dropped: 0 });
    settle(f, service.get(created.id).activeGoalId!); await service.tick();

    // A batch is half read when the inbox fails and the scheduled time comes. The schedule runs without the batch.
    at(69);
    const batch = Array.from({ length: 51 }, () => signals.add("owner"));
    await service.tick();
    assert.equal(f.launched.length, 2);
    signals.down(true);
    at(71); await service.tick();
    let routine = service.get(created.id);
    assert.equal(f.launched.length, 3, "the schedule does not wait for the inbox");
    assert.equal(routine.occurrences[2]!.wake, undefined);
    assert.equal(routine.pendingWake?.signals.length, 20, "the half-read batch still waits");

    // With the inbox back, the whole batch starts one occurrence.
    signals.down(false);
    settle(f, routine.activeGoalId!); await service.tick();
    at(77); await service.tick();
    routine = service.get(created.id);
    assert.equal(f.launched.length, 4);
    assert.deepEqual(routine.occurrences[3]!.wake, { signalIds: batch.slice(-20).map(signal => signal.id), dropped: 31 });
    assert.equal(routine.pendingWake, undefined);
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a routine ignores signals about its own goals' runs", async () => {
  const f = setup(); const service = f.createService(); const signals = inbox(); const realNow = Date.now;
  const ownRun = randomUUID();
  service.useSignals(signals.reader, goalIds => goalIds.flatMap(id => f.goals.get(id)?.cycles.map(cycle => cycle.teamId) ?? []));
  const at = (minutes: number) => { Date.now = () => realNow() + minutes * 60_000; };
  try {
    const created = await service.create(f.create({ intervalMinutes: 60, wakeOn: ["delivery-landed"] }));
    at(1); await service.tick();
    const goalId = service.get(created.id).activeGoalId!;
    const cycles = [{ teamId: ownRun, cycle: 1, goalRevision: 1, status: "merged", startedAt: new Date().toISOString(), memberCount: 1 }] as ProductGoal["cycles"];
    f.goals.set(goalId, { ...f.goals.get(goalId)!, cycles });
    signals.add("delivery-landed", ownRun);
    await service.tick();
    assert.equal(service.get(created.id).pendingWake, undefined);
    assert.equal(service.get(created.id).signalCursor, 1, "the cursor moves past the dropped signal");
    settle(f, goalId, cycles); await service.tick();
    at(7); await service.tick();
    assert.equal(f.launched.length, 1);
    signals.add("delivery-landed", randomUUID());
    await service.tick();
    assert.equal(f.launched.length, 2, "another run's landing does wake it");
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("the busy rule and the occurrence cap win over a waiting signal", async () => {
  let busy = false;
  const f = setup({ busy: async () => busy }); const service = f.createService(); const signals = inbox(); const realNow = Date.now;
  service.useSignals(signals.reader, () => []);
  const at = (minutes: number) => { Date.now = () => realNow() + minutes * 60_000; };
  try {
    const created = await service.create(f.create({ intervalMinutes: 60, maxOccurrences: 2, wakeOn: ["owner", "revert"], expiresAt: new Date(realNow() + 3 * 3_600_000).toISOString() }));
    at(1); await service.tick();
    settle(f, service.get(created.id).activeGoalId!);
    const waiting = signals.add("revert");
    await service.tick();
    busy = true;
    at(7); await service.tick();
    assert.equal(f.launched.length, 1);
    assert.equal(service.get(created.id).wakeDeferred, true);
    busy = false;
    at(8); await service.tick();
    assert.equal(f.launched.length, 1, "after a busy refusal the wake waits for the next interval");
    at(68); await service.tick();
    let routine = service.get(created.id);
    assert.equal(f.launched.length, 2);
    assert.deepEqual(routine.occurrences[1]!.wake?.signalIds, [waiting.id]);

    settle(f, routine.activeGoalId!); await service.tick();
    routine = service.get(created.id);
    assert.equal(routine.status, "completed");
    signals.add("owner");
    at(80); await service.tick();
    assert.equal(f.launched.length, 2);
    assert.equal(service.get(created.id).signalCursor, routine.signalCursor, "an ended routine reads nothing and keeps its cursor");
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a routine without wakeOn keeps its approval fingerprint and reads no signals", async () => {
  const f = setup(); const service = f.createService(); const signals = inbox(); const realNow = Date.now;
  service.useSignals(signals.reader, () => []);
  signals.add("owner");
  try {
    Date.now = () => Date.parse("2029-12-31T23:00:00.000Z");
    const request = {
      requestId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      goal: { projectId: "demo", title: "Small task", objective: "Do the bounded work", successCriteria: "The requested change is available", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 },
      intervalMinutes: 5, maxOccurrences: 2, startsAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-20T00:00:00.000Z",
    };
    const created = await service.create(request);
    Date.now = () => Date.parse("2030-01-01T00:01:00.000Z");
    await service.tick(); await service.tick();
    const stored = unseal<{ routine: Routine; fingerprint: string }>(f.key, `routine:${created.id}`, readFileSync(join(f.config.stateDir, "routines", `${created.id}.sealed`), "utf8"));
    // The digest of this request as the host computed it before routines could carry wakeOn.
    assert.equal(stored.fingerprint, "f0153ac51484bc8d9c5c0eedb7f0f6b7c22b6fd2e9ddd504a7bca85ea52cf604");
    assert.equal(stored.routine.status, "running");
    for (const field of ["wakeOn", "signalCursor", "pendingWake", "wakeDeferred"]) assert.equal(field in stored.routine, false, field);
    assert.equal(signals.reads(), 0);
  } finally { Date.now = realNow; service.close(); rmSync(f.root, { recursive: true, force: true }); }
});
