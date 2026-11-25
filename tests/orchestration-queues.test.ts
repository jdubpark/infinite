import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyedQueue, mapConcurrent } from "../packages/host/src/keyed-queue.js";
import { GoalService } from "../packages/host/src/goals.js";
import { RoutineService } from "../packages/host/src/routines.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { CreateRoutine } from "../packages/host/src/routine-types.js";
import type { TeamLineup, TeamRun } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { memberEntryId } from "../packages/host/src/evidence/member-entry.js";
import type { ProjectSignal, SignalKind, SignalReader } from "../packages/host/src/signals/types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const lineup: TeamLineup = {
  coordinator: { id: "coord", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  implementers: [{ id: "light", label: "Light", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
};

test("KeyedQueue runs independent keys concurrently, serializes same key FIFO, and evicts settled entries", async () => {
  const queue = new KeyedQueue();
  const gate = deferred();
  const order: string[] = [];

  const a1 = queue.enqueue("a", async () => {
    order.push("a1-start");
    await gate.promise;
    order.push("a1-end");
    return "a1";
  });
  const a2 = queue.enqueue("a", () => {
    order.push("a2");
    return "a2";
  });
  const b1 = queue.enqueue("b", () => {
    order.push("b1");
    return "b1";
  });

  assert.equal(await b1, "b1");
  assert.deepEqual(order, ["a1-start", "b1"]);

  const bad = queue.enqueue("c", () => {
    throw new Error("boom");
  });
  await assert.rejects(bad, /boom/);
  const c2 = queue.enqueue("c", () => "recovered");
  assert.equal(await c2, "recovered");

  gate.resolve();
  assert.deepEqual(await Promise.all([a1, a2]), ["a1", "a2"]);
  assert.deepEqual(order, ["a1-start", "b1", "a1-end", "a2"]);
  assert.deepEqual(await mapConcurrent([1, 2, 3], 0, async value => value * 2), [2, 4, 6]);
  assert.deepEqual(await mapConcurrent([], 0, async value => value), []);
  await queue.drain();
  assert.equal((queue as unknown as { queues: Map<string, Promise<unknown>> }).queues.size, 0);
});

test("GoalService processes independent goals concurrently, serializes same-goal mutations, and drains on close", async () => {
  const f = schedulerFixture();
  const extendGate = deferred();
  const secondGate = deferred();
  let extendStarted = false;
  const fakeTeams = {
    goalIdOf: () => undefined,
    get: () => { throw new Error("unexpected get"); },
    goalExtension: () => undefined,
    extendGoalTime: async (_teamId: string, _req: string, _min: number, deadlineAt: string, ceilingAt: string) => {
      extendStarted = true;
      await extendGate.promise;
      return { deadlineAt, ceilingAt };
    },
  } as unknown as TeamService;

  const config = {
    ...f.config,
    teams: { ...f.config.teams, lineup },
    projects: [{ id: "fixture", name: "Fixture", path: f.workspace, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } }],
  } as Config;
  const goals = new GoalService(config, f.key, fakeTeams);

  const makeGoal = (title: string): CreateGoal => ({
    requestId: randomUUID(), projectId: "fixture", title, objective: `Complete ${title}`,
    successCriteria: "Checks pass", nonGoals: ["No unrelated edits"], allowedPaths: ["src"],
    evidence: ["Spec"], maxRuns: 1, maxMinutes: 10, maxMembers: 4,
  });

  try {
    const gA = await goals.create(makeGoal("Goal A"));
    const gB = await goals.create(makeGoal("Goal B"));
    const storedA = (goals as unknown as { records: Map<string, { goal: ProductGoal }> }).records.get(gA.id)!;
    storedA.goal.activeTeamId = randomUUID();

    const extendA = goals.extend(gA.id, { requestId: randomUUID(), revision: gA.revision, minutes: 5 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(extendStarted, true);

    const steerA = goals.steer(gA.id, { requestId: randomUUID(), revision: gA.revision, text: "Queued behind extend" });
    let steerASettled = false;
    void steerA.then(() => { steerASettled = true; }, () => { steerASettled = true; });

    const steeredB = await goals.steer(gB.id, { requestId: randomUUID(), revision: gB.revision, text: "Goal B direction" });
    assert.equal(steeredB.steering.length, 1);
    const pausedB = await goals.pause(gB.id, { requestId: randomUUID(), revision: steeredB.revision });
    assert.equal(pausedB.status, "paused");
    assert.equal(steerASettled, false);

    extendGate.resolve();
    const extendedA = await extendA;
    assert.ok(Date.parse(extendedA.deadlineAt) >= Date.parse(gA.deadlineAt));
    await assert.rejects(steerA, { code: "stale-goal-revision" });

    const storedB = (goals as unknown as { records: Map<string, { goal: ProductGoal }> }).records.get(gB.id)!;
    storedB.goal.activeTeamId = randomUUID();
    fakeTeams.extendGoalTime = async () => {
      await secondGate.promise;
      throw new Error("transient failure");
    };
    const pendingCloseOp = goals.extend(gB.id, { requestId: randomUUID(), revision: pausedB.revision, minutes: 5 });
    let closedDone = false;
    const closing = goals.close().then(() => { closedDone = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closedDone, false);

    secondGate.resolve();
    await assert.rejects(pendingCloseOp, /transient failure/);
    await closing;
    assert.equal(closedDone, true);
  } finally {
    await goals.close();
    f.close();
  }
});

test("RoutineService ticks and mutates independent routines concurrently and drains on close", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "routine-conc-")));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    stateDir,
    projects: [
      { id: "demo-a", name: "Demo A", path: root, team: { checks: [{ command: "node", args: ["-e", "0"] }] } },
      { id: "demo-b", name: "Demo B", path: root, team: { checks: [{ command: "node", args: ["-e", "0"] }] } },
      { id: "demo-c", name: "Demo C", path: root, team: { checks: [{ command: "node", args: ["-e", "0"] }] } },
    ],
    teams: { lineup, trustWorkspaces: true },
    agents: { claude: { command: "claude", args: [] } },
  } as unknown as Config;
  const key = randomBytes(32);
  const gateA = deferred();
  const closeGate = deferred();
  let holdClose = false;
  const launched: string[] = [];

  const routines = new RoutineService(config, key, { get: () => { throw new TeamError(404, "goal-not-found", "missing"); } } as never, {
    isProjectBusy: async () => false,
    startGoal: async (request, admit) => {
      admit();
      if (request.title === "Routine A") await gateA.promise;
      if (holdClose) {
        await closeGate.promise;
        throw new Error("aborted at close");
      }
      launched.push(request.title);
      return {
        ...request, id: request.requestId, revision: 1, status: "running",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(), lineup, cycles: [],
        memberCount: 0, steering: [], events: [], outcomes: [],
      } as unknown as ProductGoal;
    },
  });

  const makeRoutine = (title: string, projectId: string): CreateRoutine => ({
    requestId: randomUUID(),
    goal: { projectId, title, objective: `Run ${title}`, successCriteria: "Done", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 },
    intervalMinutes: 5, maxOccurrences: 2,
    startsAt: new Date(Date.now() + 5).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });

  try {
    const rA = await routines.create(makeRoutine("Routine A", "demo-a"));
    const rB = await routines.create(makeRoutine("Routine B", "demo-b"));
    await new Promise(resolve => setTimeout(resolve, 20));

    const ticking = routines.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(launched, ["Routine B"]);

    const pausedB = await routines.pause(rB.id, { requestId: randomUUID(), revision: routines.get(rB.id).revision });
    assert.equal(pausedB.status, "paused");

    let pauseASettled = false;
    const pauseA = routines.pause(rA.id, { requestId: randomUUID(), revision: rA.revision }).then(value => {
      pauseASettled = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pauseASettled, false);

    gateA.resolve();
    await ticking;
    await assert.rejects(pauseA, { code: "stale-routine-revision" });
    assert.deepEqual(launched, ["Routine B", "Routine A"]);

    const rC = await routines.create(makeRoutine("Routine C", "demo-c"));
    await new Promise(resolve => setTimeout(resolve, 20));
    holdClose = true;
    const closeTick = routines.tick();
    await new Promise(resolve => setTimeout(resolve, 15));
    let closedDone = false;
    const closing = routines.close().then(() => { closedDone = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closedDone, false);

    closeGate.resolve();
    await Promise.all([closeTick, closing]);
    assert.equal(closedDone, true);
    assert.ok(routines.get(rC.id));
  } finally {
    await routines.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MissionService steps independent missions concurrently, serializes same-mission mutations, and drains on close", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-conc-")));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "teams");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const config: Config = {
    port: 0, origin: "http://127.0.0.1", keyFile: join(root, "key"), stateDir, runDir: join(root, "run"),
    tokens: [], environment: "local", enableDemo: false, maxSessions: 24,
    agents: { claude: { command: process.execPath, args: [] } },
    projects: [
      { id: "repo-a", name: "Repo A", path: repoA, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } },
      { id: "repo-b", name: "Repo B", path: repoB, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } },
    ],
    teams: { workspaceDir, lineup },
  };
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = {
    get: id => ({
      id, name: id, kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [{ projectId: id, name: id, path: id === "repo-a" ? repoA : repoB, checkouts: [{ projectId: id, name: id, path: id === "repo-a" ? repoA : repoB, primary: true, teamReady: true }] }],
    }),
  };

  const gateA = deferred();
  const closeGate = deferred();
  const createdSessions: string[] = [];
  let holdNext = false;
  const manager = {
    hostLoad: { held: () => undefined },
    meta: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    createTeamSession: async (request: { requestId: string; title: string }) => {
      if (request.title.includes("Mission A")) await gateA.promise;
      if (holdNext) {
        await closeGate.promise;
        throw new Error("stopped on close");
      }
      createdSessions.push(request.title);
      return { status: "running" };
    },
    state: async () => ({ status: "running", seq: 0, screen: "", attention: { state: "working", since: at, lastActivityAt: at } }),
    events: () => ({ events: [], cursor: 0, more: false }),
    stopTeamSession: async () => ({ status: "exited", seq: 0 }),
  } as unknown as Manager;
  const fakeTeams = {
    useMissionReservations() {},
    ensureMissionCapacityCeiling() { return undefined; },
    isActiveRun() { return false; },
    activeForProject() { return false; },
  } as unknown as TeamService;

  const missions = new MissionService(config, randomBytes(32), manager, fakeTeams, groups);
  try {
    const mA = await missions.create({ requestId: randomUUID(), groupId: "repo-a", title: "Mission A", objective: "Work A", maxSubtasks: 2, maxMinutes: 30 });
    const mB = await missions.create({ requestId: randomUUID(), groupId: "repo-b", title: "Mission B", objective: "Work B", maxSubtasks: 2, maxMinutes: 30 });

    missions.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(createdSessions.some(title => title.includes("Mission B")));

    const steeredB = await missions.steer(mB.id, { requestId: randomUUID(), revision: mB.revision, text: "Direction for B" });
    assert.equal(steeredB.steering.length, 1);

    let steerASettled = false;
    const steerA = missions.steer(mA.id, { requestId: randomUUID(), revision: mA.revision, text: "Direction for A" }).then(value => {
      steerASettled = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(steerASettled, false);

    gateA.resolve();
    const steeredA = await steerA;
    assert.equal(steeredA.steering.length, 1);

    const mC = await missions.create({ requestId: randomUUID(), groupId: "repo-a", title: "Mission C", objective: "Work C", maxSubtasks: 2, maxMinutes: 30 });
    holdNext = true;
    await new Promise(resolve => setTimeout(resolve, 600));
    let closedDone = false;
    const closing = missions.close().then(() => { closedDone = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closedDone, false);

    closeGate.resolve();
    await closing;
    assert.equal(closedDone, true);
    assert.ok(missions.get(mC.id));
  } finally {
    await missions.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TeamService isolates per-run queues, serializes same-run actions, and drains on close", async () => {
  const f = schedulerFixture();
  f.writeTeam();
  const runA = f.run.id;
  const runB = randomUUID();
  const secondRun: TeamRun = {
    ...structuredClone(f.run),
    id: runB,
    title: "Second run",
    members: [],
  };
  f.writeRecord("team", runB, {
    run: secondRun,
    fingerprint: randomUUID(),
    receipts: {},
    prepared: true,
  });

  const gateA = deferred();
  const closeGate = deferred();
  let holdSecond = false;
  (f.manager as unknown as { invalidateTeamPermission: () => Promise<string> }).invalidateTeamPermission = async () => {
    if (holdSecond) {
      await closeGate.promise;
      throw new Error("fence failed");
    }
    await gateA.promise;
    return "invalidated";
  };

  const teams = f.openTeam();
  const internal = teams as unknown as { records: Map<string, { run: TeamRun }> };
  internal.records.get(runA)!.run.permissionDecisions = [{
    id: "dec-a",
    revision: 1,
    policyHash: "p",
    targetMemberId: f.run.members[0]!.memberId,
    targetSessionId: f.run.members[0]!.sessionId,
    targetCwd: f.workspace,
    promptId: 1,
    promptHash: "h",
    evidenceHash: "e",
    prompt: { id: 1, kind: "permission", source: "screen", title: "Allow?", options: ["Yes", "No"] } as never,
    option: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    answerRequestId: randomUUID(),
    purpose: "answer",
    reviewerProfileId: "reviewer",
    reviewerProfileHash: "r",
    authorityHash: "a",
    status: "answering",
  }];
  internal.records.get(runB)!.run.permissionDecisions = [];

  try {
    const pauseA = teams.pause(runA, { requestId: randomUUID(), revision: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));

    let steerASettled = false;
    const steerA = teams.steer(runA, { requestId: randomUUID(), revision: 1, text: "Waits for pause A" }).then(value => {
      steerASettled = true;
      return value;
    });

    const steeredB = await teams.steer(runB, { requestId: randomUUID(), revision: 1, text: "Independent run B" });
    assert.equal(steeredB.revision, 2);
    assert.equal(steerASettled, false);

    gateA.resolve();
    const pausedA = await pauseA;
    assert.equal(pausedA.status, "paused");
    const steeredA = await steerA;
    assert.equal(steeredA.revision, 2);

    internal.records.get(runB)!.run.permissionDecisions = [{
      ...structuredClone(internal.records.get(runA)!.run.permissionDecisions![0]!),
      id: "dec-b",
      revision: 2,
      status: "answering",
    }];
    holdSecond = true;
    const pauseB = teams.pause(runB, { requestId: randomUUID(), revision: 2 });
    await new Promise(resolve => setTimeout(resolve, 10));
    let closedDone = false;
    const closing = teams.close().then(() => { closedDone = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closedDone, false);

    closeGate.resolve();
    await Promise.all([pauseB, closing]);
    assert.equal(closedDone, true);
  } finally {
    await teams.close();
    f.close();
  }
});

test("RoutineService same-project race defers losing routine cleanly and preserves pending wakes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "routine-project-race-")));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    stateDir,
    projects: [{ id: "demo", name: "Demo", path: root, team: { checks: [{ command: "node", args: ["-e", "0"] }] } }],
    teams: { lineup, trustWorkspaces: true },
    agents: { claude: { command: "claude", args: [] } },
  } as unknown as Config;
  const key = randomBytes(32);

  let signalSeq = 0;
  const signalsList: ProjectSignal[] = [];
  const signalReader: SignalReader = {
    head: () => signalSeq,
    after: (projectId: string, afterSeq: number, options?: { kinds?: readonly SignalKind[]; limit?: number }) => {
      const filtered = signalsList.filter(item =>
        item.projectId === projectId && item.seq > afterSeq && (!options?.kinds || options.kinds.includes(item.kind)));
      return options?.limit ? filtered.slice(0, options.limit) : filtered;
    },
  };

  let projectBusy = false;
  let forceConflictOnNext = false;
  const startEntered = deferred();
  const startGate = deferred();
  let startCount = 0;
  const routines = new RoutineService(config, key, { get: () => { throw new TeamError(404, "goal-not-found", "missing"); } } as never, {
    isProjectBusy: async () => projectBusy,
    startGoal: async (request, admit) => {
      admit();
      startCount++;
      startEntered.resolve();
      if (startCount === 1) await startGate.promise;
      if (forceConflictOnNext) throw new TeamError(409, "routine-starting", "A scheduled goal is being admitted for this project.");
      projectBusy = true;
      return {
        ...request, id: request.requestId, revision: 1, status: "running",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(), lineup, cycles: [],
        memberCount: 0, steering: [], events: [], outcomes: [],
      } as unknown as ProductGoal;
    },
  });
  routines.useSignals(signalReader, () => []);

  const makeRoutine = (title: string): CreateRoutine => ({
    requestId: randomUUID(),
    goal: { projectId: "demo", title, objective: `Run ${title}`, successCriteria: "Done", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 },
    intervalMinutes: 5, maxOccurrences: 2,
    startsAt: new Date(Date.now() + 20).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    wakeOn: ["owner"],
  });

  try {
    const r1 = await routines.create(makeRoutine("First"));
    const r2 = await routines.create(makeRoutine("Second"));
    const wakeSignal: ProjectSignal = {
      id: randomUUID(), seq: ++signalSeq, kind: "owner", projectId: "demo",
      summary: "Urgent check", detail: {}, at: new Date().toISOString(),
    };
    signalsList.push(wakeSignal);
    await new Promise(resolve => setTimeout(resolve, 35));

    const ticking = routines.tick();
    await startEntered.promise;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(startCount, 1, "project lock serializes project checks and launches");
    startGate.resolve();
    await ticking;

    const afterFirst = routines.get(r1.id);
    const afterSecond = routines.get(r2.id);
    assert.equal(afterFirst.status, "running");
    assert.ok(afterFirst.activeGoalId);
    assert.equal(afterFirst.pendingWake, undefined);
    assert.equal(afterSecond.status, "scheduled", "second routine defers rather than blocking");
    assert.equal(afterSecond.wakeDeferred, true);
    assert.deepEqual(afterSecond.pendingWake?.signals.map(item => item.id), [wakeSignal.id]);

    const r3 = await routines.create(makeRoutine("Conflict"));
    const secondWake: ProjectSignal = {
      id: randomUUID(), seq: ++signalSeq, kind: "owner", projectId: "demo",
      summary: "Retry signal", detail: {}, at: new Date().toISOString(),
    };
    signalsList.push(secondWake);
    await new Promise(resolve => setTimeout(resolve, 35));
    projectBusy = false;
    forceConflictOnNext = true;
    await routines.tick();

    const afterThird = routines.get(r3.id);
    assert.equal(afterThird.status, "scheduled", "routine-starting error defers instead of blocking");
    assert.equal(afterThird.wakeDeferred, true);
    assert.equal(afterThird.pendingWake?.signals.some(item => item.id === secondWake.id), true);
  } finally {
    await routines.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TeamService deletion purges entry ingest queue, blocks rateTask, and does not resurrect sealed record", async () => {
  const f = schedulerFixture();
  f.run.status = "merged";
  f.run.workspaceRemovedAt = new Date().toISOString();
  f.run.blackboard = { tools: true };
  f.run.tasks = [{
    id: "a", title: "Task A", role: "implementer", profileId: "light",
    dependsOn: [], paths: ["src"], objective: "Do A", status: "integrated",
    memberId: f.run.members[0]!.memberId, revision: 1,
  }] as never;
  const pm = f.run.members[0]!;
  pm.status = "stopped";
  pm.entryTools = true;
  pm.startedAt = new Date().toISOString();
  pm.workspaceRemovedAt = f.run.workspaceRemovedAt;
  f.writeTeam();

  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const entries = new Blackboard(store);
  const teams = f.openTeam({ entries });
  const internal = teams as unknown as {
    records: Map<string, { run: TeamRun }>;
    ingestEntriesAsync(): Promise<void>;
    retention: {
      removingRuns: Set<string>;
      memberTraces?: { inUse: () => boolean; settle: () => Promise<void>; forget: () => Promise<void> };
    };
  };

  const forgetGate = deferred();
  internal.retention.memberTraces = {
    inUse: () => true,
    settle: async () => {},
    forget: async () => { await forgetGate.promise; },
  };

  const binding = { runId: f.run.id, memberId: pm.memberId, revision: 1 };
  const contractEntry = { kind: "contract" as const, summary: "Contract after settle", paths: [], body: { scope: "demo", guarantees: ["g1"] } };
  f.post(pm.sessionId, "team-entry", { op: "post", ...binding, requestId: memberEntryId(binding, contractEntry), entry: contractEntry });

  const sealedPath = join(f.config.stateDir, "teams", `${f.run.id}.sealed`);
  try {
    internal.retention.removingRuns.add(f.run.id);
    const rated = teams.rateTask(f.run.id, "a", { requestId: randomUUID(), score: 4 });
    assert.equal(rated.ownerRating?.score, 4, "background workspace cleanup (removingRuns) must not block rateTask");
    await internal.ingestEntriesAsync();
    assert.equal(entries.list(f.run.id).entries.length, 1, "background workspace cleanup (removingRuns) must not drop entry ingestion");
    internal.retention.removingRuns.delete(f.run.id);

    const secondEntry = { kind: "finding" as const, summary: "Finding during deletion", paths: [], body: { finding: "f1" } };
    f.post(pm.sessionId, "team-entry", { op: "post", ...binding, requestId: memberEntryId(binding, secondEntry), entry: secondEntry });

    const removal = teams.removeRun(f.run.id);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.throws(
      () => teams.rateTask(f.run.id, "a", { requestId: randomUUID(), score: 5 }),
      { code: "team-not-found" },
      "rateTask refuses runs undergoing async deletion",
    );

    const ingesting = internal.ingestEntriesAsync();
    forgetGate.resolve();

    await Promise.all([removal, ingesting]);
    assert.equal(existsSync(sealedPath), false, "entry ingestion must not resurrect sealed file");
    assert.equal(internal.records.has(f.run.id), false);
    assert.throws(() => teams.get(f.run.id), { code: "team-not-found" });
  } finally {
    internal.retention.removingRuns.delete(f.run.id);
    forgetGate.resolve();
    await teams.close();
    store.close();
    f.close();
  }
});

test("HaltService.engage pauses existing runs immediately, drains in-flight TeamService.create awaiting volumeUsage, and keeps it paused on keepPaused release", async () => {
  const f = schedulerFixture();
  f.writeTeam();
  const existingId = f.run.id;
  const entered = deferred();
  const unblock = deferred();
  f.config.projects[0]!.team = { checks: [{ name: "check", command: process.execPath, args: ["--version"] }] };
  f.config.agents.demo = { command: process.execPath, args: [] };

  const teams = f.openTeam({
    volumeUsage: async path => {
      entered.resolve();
      await unblock.promise;
      return { path, totalBytes: 1e12, availableBytes: 9e11, totalInodes: 1e8, availableInodes: 9e7 };
    },
  });
  const halt = new HaltService({ config: f.config, key: f.key });
  const empty = { haltPause: async () => [], haltResume: async () => [] };
  const scope = { scope: "project" as const, projectId: "fixture" };
  const owner = { deviceId: "fixture", label: "Owner" };
  halt.useServices({ teams, routines: empty, goals: empty, missions: empty }, () => false);
  const gate = halt.gate({
    check: () => ({ state: "clear" }),
    admit: launch => ({ ok: true, launchId: launch.launchId }),
    release: () => {},
    started: () => {},
  });
  teams.useFuse(gate);

  const id = randomUUID();
  try {
    const created = teams.create({
      requestId: id,
      projectId: "fixture",
      provider: "demo",
      title: "Local review",
      objective: "Run fixture smoke check",
      parallelism: 1,
    });
    await Promise.race([entered.promise, created]);

    const engaging = halt.engage(scope, { requestId: randomUUID() }, owner);
    for (let i = 0; i < 40 && teams.get(existingId).status !== "paused"; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(teams.get(existingId).status, "paused", "existing run pauses immediately without waiting for blocked volumeUsage()");
    unblock.resolve();

    await created;
    const engaged = await engaging;
    assert.equal(engaged.paused.length, 2);
    assert.equal(teams.get(id).status, "paused");
    assert.equal(gate.check({ projectId: "fixture" }).state, "halted");

    await halt.release(scope, { requestId: randomUUID(), keepPaused: true }, owner);
    assert.equal(teams.get(id).status, "paused");
  } finally {
    unblock.resolve();
    halt.stop();
    await teams.close();
    await teams.idle();
    f.close();
  }
});

test("HaltService.engage drains held Goal, Routine, and Mission creates and close() awaits active haltPause", async () => {
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams, lineup };
  f.config.agents.claude = { command: process.execPath, args: [] };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] };

  const fakeTeams = {
    goalIdOf: () => undefined,
    get: () => { throw new TeamError(404, "team-not-found", "missing"); },
    useGoalRecords() {},
    useMissionReservations() {},
    ensureMissionCapacityCeiling() { return undefined; },
    isActiveRun() { return false; },
    activeForProject() { return false; },
  } as unknown as TeamService;

  const goals = new GoalService(f.config, f.key, fakeTeams);
  const routines = new RoutineService(f.config, f.key, goals, { isProjectBusy: async () => false, startGoal: async () => { throw new Error("unused"); } });
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = {
    get: id => ({
      id, name: id, kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [{ projectId: "fixture", name: "Fixture", path: f.workspace, checkouts: [{ projectId: "fixture", name: "Fixture", path: f.workspace, primary: true, teamReady: true }] }],
    }),
  };
  const missions = new MissionService(f.config, f.key, f.manager, fakeTeams, groups);
  const halt = new HaltService({ config: f.config, key: f.key });
  const empty = { haltPause: async () => [], haltResume: async () => [] };
  const owner = { deviceId: "fixture", label: "Owner" };
  halt.useServices({ teams: empty, routines, goals, missions }, () => false);

  const routineGate = deferred();
  const goalGate = deferred();
  const missionGate = deferred();
  const routineEntered = deferred();
  const goalEntered = deferred();
  const missionEntered = deferred();

  const origRoutinePause = routines.haltPause.bind(routines);
  routines.haltPause = (mark, covers) => { const p = origRoutinePause(mark, covers); routineEntered.resolve(); return p; };
  const origGoalPause = goals.haltPause.bind(goals);
  goals.haltPause = (mark, covers) => { const p = origGoalPause(mark, covers); goalEntered.resolve(); return p; };
  const origMissionPause = missions.haltPause.bind(missions);
  missions.haltPause = (mark, covers) => { const p = origMissionPause(mark, covers); missionEntered.resolve(); return p; };

  try {
    const goalReqId = randomUUID();
    const routineReqId = randomUUID();
    const missionReqId = randomUUID();

    void (routines as unknown as { queues: KeyedQueue }).queues.enqueue("admission", () => routineGate.promise);
    void (goals as unknown as { queues: KeyedQueue }).queues.enqueue(goalReqId, () => goalGate.promise);
    void (missions as unknown as { queues: KeyedQueue }).queues.enqueue(missionReqId, () => missionGate.promise);

    const creatingRoutine = routines.create({
      requestId: routineReqId,
      goal: { projectId: "fixture", title: "Routine", objective: "Do routine", successCriteria: "Done", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 10, maxMembers: 4 },
      intervalMinutes: 5, maxOccurrences: 2,
      startsAt: new Date(Date.now() + 5_000).toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const creatingGoal = goals.create({
      requestId: goalReqId, projectId: "fixture", title: "Goal", objective: "Do goal",
      successCriteria: "Done", nonGoals: [], allowedPaths: ["src"], evidence: ["Spec"],
      maxRuns: 1, maxMinutes: 10, maxMembers: 4,
    });
    const creatingMission = missions.create({
      requestId: missionReqId, groupId: "fixture", title: "Mission", objective: "Do mission", maxSubtasks: 2, maxMinutes: 30,
    });

    const engaging = halt.engage({ scope: "project", projectId: "fixture" }, { requestId: randomUUID() }, owner);
    await routineEntered.promise;
    routineGate.resolve();
    await goalEntered.promise;
    goalGate.resolve();
    await missionEntered.promise;
    let closeSettled = false;
    const closingMissions = missions.close().then(() => { closeSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closeSettled, false, "close() must wait for active haltPause()");
    missionGate.resolve();

    await closingMissions;
    assert.equal(closeSettled, true);
    assert.equal(missions.get(missionReqId).status, "paused", "close() must not settle before haltPause finishes pausing the mission");

    const [, , , engaged] = await Promise.all([creatingGoal, creatingRoutine, creatingMission, engaging]);

    assert.equal(engaged.paused.length, 3);
    assert.equal(goals.get(goalReqId).status, "paused");
    assert.equal(routines.get(routineReqId).status, "paused");
    assert.equal(missions.get(missionReqId).status, "paused");
  } finally {
    routineGate.resolve();
    goalGate.resolve();
    missionGate.resolve();
    halt.stop();
    await Promise.all([goals.close(), routines.close(), missions.close()]);
    f.close();
  }
});

test("MissionService.pendingProjectIds covers default checkouts of un-overridden repos and PendingCreates isolates colliding requestIds", async () => {
  const f = schedulerFixture();
  const repoPath = f.config.projects[0]!.path;
  f.config.teams = { ...f.config.teams, lineup };
  f.config.agents.claude = { command: process.execPath, args: [] };
  f.config.agents.demo = { command: process.execPath, args: [] };
  f.config.projects = [
    { id: "proj-a", name: "Proj A", path: repoPath, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } },
    { id: "proj-b", name: "Proj B", path: repoPath, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } },
  ];

  const fakeTeams = {
    useMissionReservations() {},
    ensureMissionCapacityCeiling() { return undefined; },
    isActiveRun() { return false; },
    activeForProject() { return false; },
  } as unknown as TeamService;
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = {
    get: id => ({
      id, name: id, kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [
        { projectId: "proj-a", name: "Repo A", path: repoPath, checkouts: [{ projectId: "proj-a", name: "Proj A", path: repoPath, primary: true, teamReady: true }] },
        { projectId: "proj-b", name: "Repo B", path: repoPath, checkouts: [{ projectId: "proj-b", name: "Proj B", path: repoPath, primary: true, teamReady: true }] },
      ],
    }),
  };
  const missions = new MissionService(f.config, f.key, f.manager, fakeTeams, groups);
  const unblockA = deferred();
  const enteredA = deferred();
  const teams = f.openTeam({
    volumeUsage: async path => {
      enteredA.resolve();
      await unblockA.promise;
      return { path, totalBytes: 1e12, availableBytes: 9e11, totalInodes: 1e8, availableInodes: 9e7 };
    },
  });
  const halt = new HaltService({ config: f.config, key: f.key });
  const empty = { haltPause: async () => [], haltResume: async () => [] };
  const owner = { deviceId: "fixture", label: "Owner" };
  halt.useServices({ teams, routines: empty, goals: empty, missions }, () => false);

  const missionGate = deferred();
  const missionEntered = deferred();
  const origMissionPause = missions.haltPause.bind(missions);
  missions.haltPause = (mark, covers) => { const p = origMissionPause(mark, covers); missionEntered.resolve(); return p; };

  try {
    const missionId = randomUUID();
    void (missions as unknown as { queues: KeyedQueue }).queues.enqueue(missionId, () => missionGate.promise);
    const creatingMission = missions.create({
      requestId: missionId, groupId: "two-repo", checkouts: ["proj-a"], title: "Two repo", objective: "Work", maxSubtasks: 2, maxMinutes: 30,
    });

    const haltB = halt.engage({ scope: "project", projectId: "proj-b" }, { requestId: randomUUID() }, owner);
    await missionEntered.promise;
    missionGate.resolve();
    const [missionView, engagedB] = await Promise.all([creatingMission, haltB]);
    assert.equal(missionView.id, missionId);
    assert.equal(engagedB.paused.length, 1);
    assert.equal(missions.get(missionId).status, "paused");

    const sharedId = randomUUID();
    const createA = teams.create({ requestId: sharedId, projectId: "proj-a", provider: "demo", title: "Run A", objective: "Work A", parallelism: 1 });
    await Promise.race([enteredA.promise, createA]);
    const createB = teams.create({ requestId: sharedId, projectId: "proj-b", provider: "demo", title: "Run B", objective: "Work B", parallelism: 1 });
    void createB.catch(() => {});

    const haltA = halt.engage({ scope: "project", projectId: "proj-a" }, { requestId: randomUUID() }, owner);
    await new Promise(resolve => setTimeout(resolve, 20));
    unblockA.resolve();

    await createA;
    await assert.rejects(createB, { code: "request-conflict" });
    const engagedA = await haltA;
    assert.equal(engagedA.paused.length, 1);
    assert.equal(teams.get(sharedId).status, "paused");
  } finally {
    missionGate.resolve();
    unblockA.resolve();
    halt.stop();
    await Promise.all([missions.close(), teams.close()]);
    await teams.idle();
    f.close();
  }
});
