import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  applyMissionProgressPage,
  compactAssignments,
  currentAssignmentCount,
  initialMissionProgressState,
  isAwaitingExitMember,
  MAX_PROGRESS_OBSERVATIONS,
  missionProgressResyncNotice,
  parseMissionProgressCursor,
  resolveMissionChild,
  type MissionProgressMember,
  type MissionProgressObservation,
  type MissionProgressPage,
  type MissionProgressResyncReason,
  type MissionProgressSnapshot,
} from "../apps/web/src/mission-inspector/progress-store.ts";
import { MissionProgressService, projectMissionChild } from "../packages/host/src/mission-progress.js";
import type { TeamRun } from "../packages/host/src/team-types.js";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MISSION_ID = "22222222-2222-4222-8222-222222222222";
const GEN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GEN_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INST_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INST_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeCursor(generation: string, missionId: string, instance: string, sequence: number): string {
  return `mp1.${generation}.${missionId}.${instance}.${sequence}`;
}

function makeSnapshot(revision: number, status: MissionProgressSnapshot["mission"]["status"] = "working"): MissionProgressSnapshot {
  return {
    mission: {
      id: MISSION_ID,
      title: `Mission r${revision}`,
      status,
      revision,
      coordinator: {
        runId: MISSION_ID,
        memberId: "coord-1",
        sessionId: "sess-coord",
        revision,
        role: "mission-coordinator",
        recordedStatus: "running",
        workerStatus: "running",
      },
    },
    subtasks: [
      {
        id: "api",
        title: "Update API",
        repoProjectId: "repo-api",
        status: "running",
        child: {
          kind: "linked",
          runId: "run-api",
          missionId: MISSION_ID,
          projectId: "repo-api",
          revision,
          status: "implementing",
          assignments: [],
          checks: [],
        },
      },
    ],
  };
}

function makeObservation(generation: string, instance: string, sequence: number, status: MissionProgressSnapshot["mission"]["status"] = "working"): MissionProgressObservation {
  return {
    cursor: makeCursor(generation, MISSION_ID, instance, sequence),
    sequence,
    observedAt: `2026-11-26T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    snapshot: makeSnapshot(sequence, status),
  };
}

function makePage(
  generation: string,
  instance: string,
  sequence: number,
  resync: MissionProgressPage["resync"],
  observations: MissionProgressObservation[] = [],
  missionId = MISSION_ID,
): MissionProgressPage {
  return {
    missionId,
    generation,
    cursor: makeCursor(generation, missionId, instance, sequence),
    observedAt: `2026-11-26T01:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    resync,
    observations,
    snapshot: { ...makeSnapshot(sequence), mission: { ...makeSnapshot(sequence).mission, id: missionId } },
  };
}

test("initial resync is quiet while all non-initial resync reasons produce truthful notices without losing snapshot", () => {
  assert.equal(missionProgressResyncNotice(null), null);
  assert.equal(missionProgressResyncNotice("initial"), null);

  let state = applyMissionProgressPage(
    initialMissionProgressState(),
    makePage(GEN_1, INST_1, 1, { required: true, reason: "initial" }),
  );
  assert.equal(state.lastResyncReason, "initial");
  assert.equal(state.resyncCount, 0);
  assert.equal(state.generation, GEN_1);
  assert.equal(state.snapshot?.mission.revision, 1);

  const reasons: Exclude<MissionProgressResyncReason, "initial">[] = [
    "invalid-cursor",
    "host-restarted",
    "mission-mismatch",
    "history-evicted",
    "retention-gap",
    "cursor-ahead",
  ];

  for (const [index, reason] of reasons.entries()) {
    const notice = missionProgressResyncNotice(reason);
    assert.ok(notice && notice.length > 20);
    const generation = reason === "host-restarted" ? GEN_2 : GEN_1;
    const instance = reason === "history-evicted" ? INST_2 : INST_1;
    const rev = 10 + index;
    state = applyMissionProgressPage(
      state,
      makePage(generation, instance, rev, { required: true, reason }),
    );
    assert.equal(state.lastResyncReason, reason);
    assert.equal(state.resyncCount, index + 1);
    assert.equal(state.snapshot?.mission.revision, rev);
    assert.equal(state.cursor, makeCursor(generation, MISSION_ID, instance, rev));
    assert.equal(state.lastSequence, rev);
  }
});

test("incremental progress pages merge monotonically, deduplicate sequences, and cap observations at 40", () => {
  let state = applyMissionProgressPage(
    initialMissionProgressState(),
    makePage(GEN_1, INST_1, 1, { required: true, reason: "initial" }),
  );

  const batch1 = [makeObservation(GEN_1, INST_1, 2), makeObservation(GEN_1, INST_1, 3)];
  state = applyMissionProgressPage(state, makePage(GEN_1, INST_1, 3, { required: false }, batch1));
  assert.deepEqual(state.observations.map(item => item.sequence), [2, 3]);
  assert.equal(state.lastSequence, 3);

  state = applyMissionProgressPage(
    state,
    makePage(GEN_1, INST_1, 4, { required: false }, [
      makeObservation(GEN_1, INST_1, 2),
      makeObservation(GEN_1, INST_1, 3),
      makeObservation(GEN_1, INST_1, 4),
    ]),
  );
  assert.deepEqual(state.observations.map(item => item.sequence), [2, 3, 4]);

  const stalePage = makePage(GEN_1, INST_1, 2, { required: false }, [makeObservation(GEN_1, INST_1, 2)]);
  const afterStale = applyMissionProgressPage(state, stalePage);
  assert.equal(afterStale.cursor, state.cursor);
  assert.equal(afterStale.lastSequence, 4);

  for (let seq = 5; seq <= 55; seq++) {
    state = applyMissionProgressPage(
      state,
      makePage(GEN_1, INST_1, seq, { required: false }, [makeObservation(GEN_1, INST_1, seq)]),
    );
  }
  assert.equal(state.observations.length, MAX_PROGRESS_OBSERVATIONS);
  assert.equal(state.observations[0]!.sequence, 16);
  assert.equal(state.observations.at(-1)!.sequence, 55);
  assert.equal(state.lastSequence, 55);
});

test("host restart resets generation and allows sequence 1..N again without dropping new observations", () => {
  let state = applyMissionProgressPage(
    initialMissionProgressState(),
    makePage(GEN_1, INST_1, 1, { required: true, reason: "initial" }),
  );
  state = applyMissionProgressPage(
    state,
    makePage(GEN_1, INST_1, 12, { required: false }, [makeObservation(GEN_1, INST_1, 12)]),
  );
  assert.equal(state.lastSequence, 12);

  state = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_2, 1, { required: true, reason: "host-restarted" }),
  );
  assert.equal(state.generation, GEN_2);
  assert.equal(state.lastSequence, 1);
  assert.equal(state.resyncCount, 1);
  assert.equal(state.lastResyncReason, "host-restarted");

  state = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_2, 2, { required: false }, [makeObservation(GEN_2, INST_2, 2, "needs-input")]),
  );
  assert.equal(state.lastSequence, 2);
  assert.equal(state.observations.at(-1)?.snapshot.mission.status, "needs-input");
});

test("switching mission resets prior mission observations cleanly", () => {
  let state = applyMissionProgressPage(
    initialMissionProgressState(),
    makePage(GEN_1, INST_1, 1, { required: true, reason: "initial" }),
  );
  state = applyMissionProgressPage(
    state,
    makePage(GEN_1, INST_1, 2, { required: false }, [makeObservation(GEN_1, INST_1, 2)]),
  );
  assert.equal(state.observations.length, 1);

  state = applyMissionProgressPage(
    state,
    makePage(GEN_1, INST_2, 1, { required: true, reason: "initial" }, [], OTHER_MISSION_ID),
  );
  assert.equal(state.missionId, OTHER_MISSION_ID);
  assert.equal(state.observations.length, 0);
  assert.equal(state.resyncCount, 0);
});

test("seeded randomized progress state machine preserves cursor monotonicity and bounds under restarts and faults", () => {
  let seed = 0x5eed1234;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let generation = GEN_1;
  let instance = INST_1;
  let hostSeq = 1;
  let retained: MissionProgressObservation[] = [];
  let state = initialMissionProgressState();
  const MAX_HOST_RETAINED = 8;

  state = applyMissionProgressPage(
    state,
    makePage(generation, instance, hostSeq, { required: true, reason: "initial" }),
  );

  for (let step = 0; step < 150; step++) {
    const roll = nextRand();
    if (roll < 0.08) {
      generation = randomUUID();
      instance = randomUUID();
      hostSeq = 1;
      retained = [];
    } else if (roll < 0.14) {
      instance = randomUUID();
      hostSeq = 1;
      retained = [];
    } else if (roll < 0.24) {
      for (let skip = 0; skip < 10; skip++) {
        hostSeq++;
        retained.push(makeObservation(generation, instance, hostSeq));
        if (retained.length > MAX_HOST_RETAINED) retained.shift();
      }
    } else if (roll < 0.8) {
      hostSeq++;
      retained.push(makeObservation(generation, instance, hostSeq));
      if (retained.length > MAX_HOST_RETAINED) retained.shift();
    }

    const parsed = parseMissionProgressCursor(state.cursor);
    let page: MissionProgressPage;
    if (!parsed) {
      page = makePage(generation, instance, hostSeq, { required: true, reason: "invalid-cursor" });
    } else if (parsed.generation !== generation) {
      page = makePage(generation, instance, hostSeq, { required: true, reason: "host-restarted" });
    } else if (parsed.instance !== instance) {
      page = makePage(generation, instance, hostSeq, { required: true, reason: "history-evicted" });
    } else if (parsed.sequence > hostSeq) {
      page = makePage(generation, instance, hostSeq, { required: true, reason: "cursor-ahead" });
    } else {
      const oldest = retained[0]?.sequence ?? hostSeq;
      if (parsed.sequence < oldest - 1) {
        page = makePage(generation, instance, hostSeq, { required: true, reason: "retention-gap" });
      } else {
        page = makePage(
          generation,
          instance,
          hostSeq,
          { required: false },
          retained.filter(item => item.sequence > parsed.sequence),
        );
      }
    }

    const prevGen = state.generation;
    const prevSeq = state.lastSequence;
    state = applyMissionProgressPage(state, page);

    assert.ok(state.observations.length <= MAX_PROGRESS_OBSERVATIONS);
    assert.equal(state.snapshot !== null, true);
    assert.equal(state.generation, generation);
    if (!page.resync.required && prevGen === generation) {
      assert.ok(state.lastSequence >= prevSeq);
    }
  }
});

test("compactAssignments splits active from finished and links prior stopped/reported attempts to matching replacements", () => {
  const member = (overrides: Partial<MissionProgressMember>): MissionProgressMember => ({
    runId: "run-1",
    memberId: randomUUID(),
    sessionId: randomUUID(),
    revision: 1,
    role: "implementer",
    recordedStatus: "running",
    workerStatus: "running",
    ...overrides,
  });

  const oldImpl1 = member({ memberId: "m-old-1", taskId: "task-a", recordedStatus: "stopped", workerStatus: "exited", revision: 1 });
  const oldImpl2 = member({
    memberId: "m-old-2",
    taskId: "task-a",
    recordedStatus: "reported",
    exitConfirmedAt: "2026-11-26T00:05:00.000Z",
    workerStatus: "exited",
    revision: 2,
  });
  const activeImpl = member({ memberId: "m-active", taskId: "task-a", recordedStatus: "running", workerStatus: "running", revision: 3 });
  const unavailableReviewer = member({ memberId: "m-rev", role: "reviewer", recordedStatus: "unavailable", workerStatus: "unavailable", revision: 3 });
  const queuedPm = member({ memberId: "m-pm", role: "project-manager", recordedStatus: "queued", workerStatus: "not-sampled", revision: 3 });
  const finishedScout = member({
    memberId: "m-scout-done",
    role: "scout",
    recordedStatus: "reported",
    exitConfirmedAt: "2026-11-26T00:04:00.000Z",
    workerStatus: "exited",
    revision: 1,
  });
  const finishedOtherTask = member({ memberId: "m-task-b", taskId: "task-b", recordedStatus: "stopped", workerStatus: "exited", revision: 1 });

  const result = compactAssignments([
    oldImpl2,
    oldImpl1,
    activeImpl,
    unavailableReviewer,
    queuedPm,
    finishedScout,
    finishedOtherTask,
  ]);

  assert.equal(result.active.length, 3);
  const implGroup = result.active.find(group => group.member.memberId === "m-active");
  assert.ok(implGroup);
  assert.deepEqual(implGroup.priorAttempts.map(item => item.memberId), ["m-old-1", "m-old-2"]);
  assert.deepEqual(result.finished.map(item => item.memberId), ["m-scout-done", "m-task-b"]);
});

test("resync clears prior observations so matching sequences in new generation or instance are never dropped, and stale generation pages are ignored", () => {
  const INST_3 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  let state = applyMissionProgressPage(
    initialMissionProgressState(),
    makePage(GEN_1, INST_1, 1, { required: true, reason: "initial" }),
  );
  state = applyMissionProgressPage(
    state,
    makePage(GEN_1, INST_1, 3, { required: false }, [
      makeObservation(GEN_1, INST_1, 2, "working"),
      makeObservation(GEN_1, INST_1, 3, "needs-input"),
    ]),
  );
  assert.deepEqual(state.observations.map(item => item.sequence), [2, 3]);

  state = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_2, 1, { required: true, reason: "host-restarted" }),
  );
  assert.equal(state.observations.length, 0);
  state = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_2, 3, { required: false }, [
      makeObservation(GEN_2, INST_2, 2, "paused"),
      makeObservation(GEN_2, INST_2, 3, "working"),
    ]),
  );
  assert.deepEqual(state.observations.map(item => [item.cursor, item.sequence]), [
    [makeCursor(GEN_2, MISSION_ID, INST_2, 2), 2],
    [makeCursor(GEN_2, MISSION_ID, INST_2, 3), 3],
  ]);

  state = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_3, 1, { required: true, reason: "history-evicted" }),
  );
  assert.equal(state.observations.length, 0);
  state = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_3, 3, { required: false }, [
      makeObservation(GEN_2, INST_3, 2, "blocked"),
      makeObservation(GEN_2, INST_3, 3, "ready-for-review"),
    ]),
  );
  assert.deepEqual(state.observations.map(item => [item.cursor, item.sequence]), [
    [makeCursor(GEN_2, MISSION_ID, INST_3, 2), 2],
    [makeCursor(GEN_2, MISSION_ID, INST_3, 3), 3],
  ]);

  const afterStaleGen1 = applyMissionProgressPage(
    state,
    makePage(GEN_1, INST_1, 4, { required: false }, [makeObservation(GEN_1, INST_1, 4, "cancelled")]),
  );
  assert.equal(afterStaleGen1, state);
  assert.equal(afterStaleGen1.generation, GEN_2);
  assert.equal(afterStaleGen1.cursor, makeCursor(GEN_2, MISSION_ID, INST_3, 3));

  const afterStaleInst2 = applyMissionProgressPage(
    state,
    makePage(GEN_2, INST_2, 4, { required: false }, [makeObservation(GEN_2, INST_2, 4, "cancelled")]),
  );
  assert.equal(afterStaleInst2, state);
});

test("compactAssignments keeps reported workers without exitConfirmedAt active until exit is established", () => {
  const reportedRunning: MissionProgressMember = {
    runId: "run-1",
    memberId: "m-reported-live",
    sessionId: "s-reported-live",
    revision: 2,
    role: "implementer",
    taskId: "task-a",
    recordedStatus: "reported",
    workerStatus: "running",
  };
  const reportedConfirmed: MissionProgressMember = {
    ...reportedRunning,
    memberId: "m-reported-confirmed",
    exitConfirmedAt: "2026-11-26T00:10:00.000Z",
    workerStatus: "exited",
  };

  assert.equal(isAwaitingExitMember(reportedRunning), true);
  assert.equal(isAwaitingExitMember(reportedConfirmed), false);

  const liveOnly = compactAssignments([reportedRunning]);
  assert.equal(liveOnly.active.length, 1);
  assert.equal(liveOnly.active[0]?.member.memberId, "m-reported-live");
  assert.equal(liveOnly.finished.length, 0);

  const afterConfirm = compactAssignments([reportedConfirmed]);
  assert.equal(afterConfirm.active.length, 0);
  assert.deepEqual(afterConfirm.finished.map(item => item.memberId), ["m-reported-confirmed"]);
});

test("resolveMissionChild requires a verified linked child and distinguishes unavailable or loading progress from not-created", () => {
  const mission = { id: MISSION_ID };
  const linkedSubtask = { id: "api", repoProjectId: "repo-api", teamId: "run-api" };
  const uncreatedSubtask = { id: "web", repoProjectId: "repo-web" };

  assert.equal(
    resolveMissionChild(mission, linkedSubtask, null, { progressLoading: true }).kind,
    "loading",
  );
  assert.equal(
    resolveMissionChild(mission, uncreatedSubtask, null, { progressLoading: true }).kind,
    "loading",
  );
  const failed = resolveMissionChild(mission, linkedSubtask, null, { progressError: "timeout" });
  assert.equal(failed.kind, "unavailable");
  if (failed.kind === "unavailable") assert.match(failed.reason, /timeout/);

  const baseSnapshot = makeSnapshot(3);
  const verified = resolveMissionChild(mission, linkedSubtask, baseSnapshot);
  assert.equal(verified.kind, "linked");
  if (verified.kind === "linked") assert.equal(verified.verifiedTeamId, "run-api");

  const mismatchedSnapshot: MissionProgressSnapshot = {
    ...baseSnapshot,
    subtasks: [{ ...baseSnapshot.subtasks[0]!, child: { kind: "mismatched" } }],
  };
  assert.equal(resolveMissionChild(mission, linkedSubtask, mismatchedSnapshot).kind, "mismatched");

  const missingSnapshot: MissionProgressSnapshot = {
    ...baseSnapshot,
    subtasks: [{ ...baseSnapshot.subtasks[0]!, child: { kind: "missing" } }],
  };
  assert.equal(resolveMissionChild(mission, linkedSubtask, missingSnapshot).kind, "missing");

  const wrongRunSnapshot: MissionProgressSnapshot = {
    ...baseSnapshot,
    subtasks: [{
      ...baseSnapshot.subtasks[0]!,
      child: {
        kind: "linked",
        runId: "run-other-team",
        missionId: MISSION_ID,
        projectId: "repo-api",
        revision: 3,
        status: "implementing",
        assignments: [],
        checks: [],
      },
    }],
  };
  assert.equal(resolveMissionChild(mission, linkedSubtask, wrongRunSnapshot).kind, "mismatched");
  assert.equal(resolveMissionChild(mission, { id: "api", repoProjectId: "repo-api" }, baseSnapshot).kind, "mismatched");

  const notCreatedSnapshot: MissionProgressSnapshot = {
    ...baseSnapshot,
    subtasks: [
      { id: "web", title: "Web", repoProjectId: "repo-web", status: "queued", child: { kind: "not-created" } },
      { id: "api", title: "API", repoProjectId: "repo-api", status: "running", child: { kind: "not-created" } },
    ],
  };
  assert.equal(resolveMissionChild(mission, uncreatedSubtask, notCreatedSnapshot).kind, "not-created");
  assert.equal(resolveMissionChild(mission, linkedSubtask, notCreatedSnapshot).kind, "unavailable");
  assert.equal(
    resolveMissionChild(mission, { id: "unlisted", repoProjectId: "repo-api" }, baseSnapshot).kind,
    "unavailable",
  );
});

test("real projectMissionChild projection feeds replaced implementer prior attempts into compactAssignments", async () => {
  const childRunId = randomUUID();
  const replacedId = randomUUID();
  const replacementId = randomUUID();
  const replacementSession = randomUUID();
  const run = {
    id: childRunId,
    projectId: "repo-api",
    missionId: MISSION_ID,
    revision: 2,
    status: "implementing",
    updatedAt: "2026-11-26T02:00:00.000Z",
    tasks: [{ id: "task-api", revision: 2, memberId: replacementId }],
    members: [
      {
        runId: childRunId,
        memberId: replacedId,
        sessionId: randomUUID(),
        revision: 2,
        role: "implementer",
        taskId: "task-api",
        status: "stopped",
        exitConfirmedAt: "2026-11-26T01:55:00.000Z",
      },
      {
        runId: childRunId,
        memberId: replacementId,
        sessionId: replacementSession,
        revision: 2,
        role: "implementer",
        taskId: "task-api",
        status: "running",
      },
    ],
    checks: [],
  } as unknown as TeamRun;

  const service = new MissionProgressService({
    missions: {
      progressSource: () => ({
        id: MISSION_ID,
        title: "Mission with replacement",
        status: "working",
        revision: 2,
        updatedAt: "2026-11-26T02:00:00.000Z",
        subtasks: [{ id: "api", title: "API", repoProjectId: "repo-api", status: "running", teamId: childRunId }],
      }),
    },
    teams: { missionProgressChild: () => projectMissionChild(run, MISSION_ID, "repo-api") },
    manager: {
      meta: sessionId => ({
        session: {
          team: sessionId === replacementSession
            ? { runId: childRunId, memberId: replacementId, revision: 2, role: "implementer", taskId: "task-api" }
            : undefined,
        },
      }),
      state: async () => ({ status: "running" }),
    },
  });

  const page = await service.read(MISSION_ID);
  const resolved = resolveMissionChild(
    { id: MISSION_ID },
    { id: "api", repoProjectId: "repo-api", teamId: childRunId },
    page.snapshot,
  );
  assert.equal(resolved.kind, "linked");
  if (resolved.kind !== "linked") return;
  const compacted = compactAssignments(resolved.child.assignments);
  assert.equal(resolved.child.assignments.length, 2);
  assert.equal(currentAssignmentCount(resolved.child.assignments), 1);
  assert.equal(compacted.active.length, 1);
  assert.equal(compacted.active[0]?.member.memberId, replacementId);
  assert.deepEqual(compacted.active[0]?.priorAttempts.map(item => item.memberId), [replacedId]);
  assert.equal(compacted.finished.length, 0);

  const finishedWithReplacement: MissionProgressMember[] = [
    { ...resolved.child.assignments[0]!, recordedStatus: "stopped", exitConfirmedAt: "2026-11-26T02:05:00.000Z" },
    resolved.child.assignments[1]!,
    {
      runId: childRunId,
      memberId: randomUUID(),
      sessionId: randomUUID(),
      revision: 2,
      role: "reviewer",
      recordedStatus: "running",
      workerStatus: "running",
    },
  ];
  assert.equal(currentAssignmentCount(finishedWithReplacement), 2);
});
