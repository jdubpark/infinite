import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MissionProgressService, projectMissionChild, type MissionProgressChild, type MissionProgressMissionSource } from "../packages/host/src/mission-progress.js";
import type { TeamAssignment, TeamRun } from "../packages/host/src/team-types.js";

const missionId = randomUUID();
const childId = randomUUID();
const coordinatorId = randomUUID();
const coordinatorSession = randomUUID();
const memberId = randomUUID();
const memberSession = randomUUID();
const at = "2026-11-24T12:00:00.000Z";

function source(status: MissionProgressMissionSource["status"] = "working"): MissionProgressMissionSource {
  return {
    id: missionId,
    title: "Trace one mission",
    status,
    revision: 4,
    updatedAt: at,
    coordinator: { runId: missionId, memberId: coordinatorId, sessionId: coordinatorSession, revision: 7, role: "mission-coordinator", status: "running" },
    subtasks: [{ id: "api", title: "Inspect API", repoProjectId: "api", status: "running", teamId: childId }],
  };
}

function linkedChild(overrides: Partial<Extract<MissionProgressChild, { kind: "linked" }>> = {}): MissionProgressChild {
  return {
    kind: "linked",
    runId: childId,
    missionId,
    projectId: "api",
    revision: 2,
    status: "implementing",
    updatedAt: at,
    assignments: [{ runId: childId, memberId, sessionId: memberSession, revision: 2, role: "implementer", taskId: "task-api", status: "running" }],
    checks: [{ revision: 2, round: 1, headCommit: "a".repeat(40), status: "passed", startedAt: at, finishedAt: at, exitCode: 0 }],
    ...overrides,
  };
}

function fixture(options: { mission?: () => MissionProgressMissionSource; child?: () => MissionProgressChild; worker?: () => "starting" | "running" | "exited" | "unavailable" | "recording-error" } = {}) {
  let mission = options.mission ?? (() => source());
  let child = options.child ?? (() => linkedChild());
  let worker = options.worker ?? (() => "running");
  const states: string[] = [];
  const missionAssignments: Record<string, TeamAssignment> = {
    [coordinatorSession]: { runId: missionId, memberId: coordinatorId, revision: 7, role: "mission-coordinator" },
    [memberSession]: { runId: childId, memberId, revision: 2, role: "implementer", taskId: "task-api" },
  };
  const service = new MissionProgressService({
    missions: { progressSource: () => mission() },
    teams: { missionProgressChild: () => child() },
    manager: {
      meta: (sessionId: string) => ({ session: { team: missionAssignments[sessionId] } }),
      state: async (sessionId: string) => { states.push(sessionId); return { status: worker() }; },
    },
  });
  return {
    service,
    states,
    setMission: (next: () => MissionProgressMissionSource) => { mission = next; },
    setChild: (next: () => MissionProgressChild) => { child = next; },
    setWorker: (next: typeof worker) => { worker = next; },
    assignments: missionAssignments,
  };
}

test("mission progress returns a sanitized snapshot and separates worker liveness from sealed assignment state", async () => {
  const f = fixture({ worker: () => "unavailable" });
  const page = await f.service.read(missionId);
  assert.equal(page.resync.required, true);
  assert.equal(page.resync.reason, "initial");
  assert.deepEqual(page.observations, []);
  assert.deepEqual(page.snapshot.mission.coordinator, {
    runId: missionId, memberId: coordinatorId, sessionId: coordinatorSession, revision: 7, role: "mission-coordinator", recordedStatus: "running", workerStatus: "unavailable",
  });
  assert.deepEqual(page.snapshot.subtasks[0]?.child, {
    kind: "linked", runId: childId, missionId, projectId: "api", revision: 2, status: "implementing",
    assignments: [{ runId: childId, memberId, sessionId: memberSession, revision: 2, role: "implementer", taskId: "task-api", recordedStatus: "running", workerStatus: "unavailable" }],
    checks: [{ revision: 2, round: 1, headCommit: "a".repeat(40), status: "passed", startedAt: at, finishedAt: at, exitCode: 0 }],
  });
  assert.equal(f.states.includes(coordinatorSession), true);
  assert.equal(f.states.includes(memberSession), true);
  assert.equal(JSON.stringify(page).includes("prompt"), false);
  assert.equal(JSON.stringify(page).includes("output"), false);
  assert.equal(JSON.stringify(page).includes("command"), false);

  const repeated = await f.service.read(missionId, page.cursor);
  assert.equal(repeated.resync.required, false);
  assert.deepEqual(repeated.observations, [], "repeating a cursor does not replay its own current state");
  assert.equal(repeated.cursor, page.cursor);
  assert.deepEqual(repeated.snapshot.mission.status, "working", "an unavailable worker does not stop or complete the sealed mission");

  const exited = fixture({ worker: () => "exited" });
  const exitPage = await exited.service.read(missionId);
  assert.equal(exitPage.snapshot.mission.coordinator?.workerStatus, "exited", "an explicit worker exit stays distinct from unavailability");
  assert.equal(exitPage.snapshot.mission.coordinator?.recordedStatus, "running", "worker exit alone does not change the sealed assignment state");
  assert.equal(exitPage.snapshot.mission.status, "working", "worker exit alone does not complete the mission");
});

test("mission progress replays distinct observed A to B to A snapshots with stable cursors", async () => {
  const f = fixture();
  const first = await f.service.read(missionId);
  f.setMission(() => source("needs-input"));
  const second = await f.service.read(missionId, first.cursor);
  assert.equal(second.resync.required, false);
  assert.equal(second.observations.length, 1);
  assert.equal(second.observations[0]?.snapshot.mission.status, "needs-input");
  assert.notEqual(second.cursor, first.cursor);

  f.setMission(() => source("working"));
  const third = await f.service.read(missionId, second.cursor);
  assert.equal(third.observations.length, 1);
  assert.equal(third.observations[0]?.snapshot.mission.status, "working");
  assert.notEqual(third.cursor, first.cursor, "returning to an earlier content hash still advances the observation cursor");

  const replay = await f.service.read(missionId, first.cursor);
  assert.equal(replay.resync.required, false);
  assert.deepEqual(replay.observations.map(item => item.snapshot.mission.status), ["needs-input", "working"]);
  assert.equal(replay.cursor, third.cursor);
});

test("restart, retention gaps, and mission-cache eviction request a full current snapshot", async () => {
  const f = fixture();
  const first = await f.service.read(missionId);
  const restarted = new MissionProgressService({
    missions: { progressSource: () => source("needs-input") },
    teams: { missionProgressChild: () => linkedChild() },
    manager: { meta: () => { throw new Error("metadata missing"); }, state: async () => ({ status: "unavailable" }) },
  });
  const afterRestart = await restarted.read(missionId, first.cursor);
  assert.deepEqual(afterRestart.resync, { required: true, reason: "host-restarted" });
  assert.equal(afterRestart.snapshot.mission.status, "needs-input");
  assert.deepEqual(afterRestart.observations, []);

  let current = source("working");
  f.setMission(() => current);
  let cursor = first.cursor;
  for (let n = 0; n < 40; n++) {
    current = source(n % 2 === 0 ? "needs-input" : "working");
    const page = await f.service.read(missionId, cursor);
    cursor = page.cursor;
  }
  const gap = await f.service.read(missionId, first.cursor);
  assert.deepEqual(gap.resync, { required: true, reason: "retention-gap" });
  assert.deepEqual(gap.observations, []);
  assert.equal(gap.snapshot.mission.status, current.status);

  const evictedId = randomUUID();
  const bounded = new MissionProgressService({
    missions: { progressSource: id => ({ ...source(), id }) },
    teams: { missionProgressChild: () => ({ kind: "missing" }) },
    manager: { meta: () => { throw new Error("metadata missing"); }, state: async () => ({ status: "unavailable" }) },
  });
  const evictedPage = await bounded.read(evictedId);
  for (let n = 0; n < 20; n++) await bounded.read(randomUUID());
  await bounded.read(evictedId);
  const evicted = await bounded.read(evictedId, evictedPage.cursor);
  assert.deepEqual(evicted.resync, { required: true, reason: "history-evicted" }, "warming an evicted mission makes a new history instance");
});

test("mismatched mission children are not projected or checked for worker liveness", async () => {
  const f = fixture({ child: () => ({ kind: "mismatched" }) });
  const page = await f.service.read(missionId);
  assert.deepEqual(page.snapshot.subtasks[0]?.child, { kind: "mismatched" });
  assert.equal(f.states.includes(memberSession), false, "a child outside the mission never causes member state reads");
  assert.equal(page.snapshot.mission.coordinator?.workerStatus, "running");
});

test("a session with a different recorded assignment is not sampled as the mission coordinator", async () => {
  const f = fixture();
  f.assignments[coordinatorSession] = { runId: missionId, memberId: coordinatorId, revision: 8, role: "mission-coordinator" };
  const page = await f.service.read(missionId);
  assert.equal(page.snapshot.mission.coordinator?.recordedStatus, "running");
  assert.equal(page.snapshot.mission.coordinator?.workerStatus, "mismatched");
  assert.equal(f.states.includes(coordinatorSession), false, "a mismatched session is not read for liveness");
});

test("queued current unscoped team roles stay visible without worker probes", async () => {
  const queuedMemberId = randomUUID();
  const queuedSessionId = randomUUID();
  const run = {
    id: childId, projectId: "api", missionId, revision: 2, status: "integrating", updatedAt: at,
    tasks: [{ id: "task-api", revision: 2, memberId }], discovery: undefined,
    members: [
      { runId: childId, memberId, sessionId: memberSession, revision: 2, role: "implementer", taskId: "task-api", status: "running" },
      { runId: childId, memberId: queuedMemberId, sessionId: queuedSessionId, revision: 2, role: "project-manager", status: "queued" },
    ],
    checks: [],
  } as unknown as TeamRun;
  const child = projectMissionChild(run, missionId, "api");
  assert.equal(child.kind, "linked");
  if (child.kind !== "linked") return;
  assert.equal(child.assignments.some(assignment => assignment.memberId === queuedMemberId && assignment.status === "queued"), true);

  const f = fixture({ child: () => child });
  const page = await f.service.read(missionId);
  const queued = page.snapshot.subtasks[0]?.child.kind === "linked"
    ? page.snapshot.subtasks[0].child.assignments.find(assignment => assignment.memberId === queuedMemberId)
    : undefined;
  assert.equal(queued?.role, "project-manager");
  assert.equal(queued?.recordedStatus, "queued");
  assert.equal(queued?.workerStatus, "not-sampled");
  assert.equal(f.states.includes(queuedSessionId), false);
});

test("completed writers leave room for the live reviewer in a full work plan", async () => {
  const writers = Array.from({ length: 12 }, (_, index) => ({
    runId: childId, memberId: randomUUID(), sessionId: randomUUID(), revision: 2,
    role: "implementer", taskId: `task-${index}`, status: "stopped",
  }));
  const reviewer = { runId: childId, memberId, sessionId: memberSession, revision: 2, role: "reviewer" as const, status: "running" as const };
  const run = { id: childId, projectId: "api", missionId, revision: 2, status: "reviewing", updatedAt: at, checks: [],
    members: [...writers, reviewer], tasks: writers.map(row => ({ id: row.taskId, memberId: row.memberId, revision: row.revision })),
  } as unknown as TeamRun;
  const f = fixture({ child: () => projectMissionChild(run, missionId, "api") });
  f.assignments[memberSession] = { runId: childId, memberId, revision: 2, role: "reviewer" };
  const child = (await f.service.read(missionId)).snapshot.subtasks[0]!.child;
  assert.equal(child.kind, "linked");
  if (child.kind !== "linked") return;
  assert.equal(child.assignmentsTruncated, true);
  assert.equal(child.assignments[0]?.memberId, reviewer.memberId);
  assert.ok(f.states.includes(memberSession), "the active reviewer's process is sampled");
});

test("same-mission reads coalesce and concurrent worker probes stay under the host cap", async () => {
  const id = randomUUID();
  let missionReads = 0;
  let stateReads = 0;
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const coalesced = new MissionProgressService({
    missions: { progressSource: requestedId => {
      missionReads++;
      return { ...source(), id: requestedId, coordinator: { runId: requestedId, memberId: requestedId, sessionId: requestedId, revision: 1, role: "mission-coordinator", status: "running" }, subtasks: [] };
    } },
    teams: { missionProgressChild: () => ({ kind: "missing" }) },
    manager: {
      meta: sessionId => ({ session: { team: { runId: sessionId, memberId: sessionId, revision: 1, role: "mission-coordinator" } } }),
      state: async () => { stateReads++; await blocker; return { status: "running" }; },
    },
  });
  const firstRead = coalesced.read(id);
  const secondRead = coalesced.read(id);
  assert.equal(missionReads, 1);
  assert.equal(stateReads, 1);
  release();
  const [firstPage, secondPage] = await Promise.all([firstRead, secondRead]);
  assert.equal(firstPage.cursor, secondPage.cursor);

  let active = 0;
  let maximumActive = 0;
  const releases: (() => void)[] = [];
  const ids = Array.from({ length: 20 }, () => randomUUID());
  const bounded = new MissionProgressService({
    missions: { progressSource: requestedId => ({ ...source(), id: requestedId, coordinator: { runId: requestedId, memberId: requestedId, sessionId: requestedId, revision: 1, role: "mission-coordinator", status: "running" }, subtasks: [] }) },
    teams: { missionProgressChild: () => ({ kind: "missing" }) },
    manager: {
      meta: sessionId => ({ session: { team: { runId: sessionId, memberId: sessionId, revision: 1, role: "mission-coordinator" } } }),
      state: async () => {
        stateReads++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active--;
        return { status: "running" };
      },
    },
  });
  const pages = Promise.all(ids.map(requestedId => bounded.read(requestedId)));
  assert.equal(maximumActive, 8);
  assert.equal(stateReads, 9, "only eight cross-mission liveness calls start while one prior call is still blocked");
  for (const done of releases) done();
  const results = await pages;
  assert.equal(maximumActive, 8);
  assert.equal(results.filter(page => page.snapshot.mission.coordinator?.workerStatus === "not-sampled").length, 12);
});

test("child projection rejects a run whose mission or project binding does not match", () => {
  const run = {
    id: childId, projectId: "api", missionId, replay: undefined, revision: 2, status: "implementing", updatedAt: at,
    tasks: [{ id: "task-api", revision: 2, memberId }],
    members: [{ runId: childId, memberId, sessionId: memberSession, revision: 2, role: "implementer", taskId: "task-api", status: "running" }],
    checks: [{ revision: 2, round: 1, headCommit: "a".repeat(40), status: "passed", startedAt: at, finishedAt: at, exitCode: 0 }],
  } as unknown as TeamRun;
  assert.deepEqual(projectMissionChild(run, randomUUID(), "api"), { kind: "mismatched" });
  assert.deepEqual(projectMissionChild(run, missionId, "web"), { kind: "mismatched" });
  const projected = projectMissionChild(run, missionId, "api");
  assert.equal(projected.kind, "linked");
  if (projected.kind === "linked") {
    assert.equal(projected.assignments.length, 1);
    assert.equal(projected.assignments[0]?.memberId, memberId);
    assert.equal(projected.checks[0]?.status, "passed");
    assert.equal(JSON.stringify(projected).includes("prompt"), false);
    assert.equal(JSON.stringify(projected).includes("output"), false);
  }
});
