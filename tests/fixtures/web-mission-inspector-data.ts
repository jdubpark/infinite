import type { Me } from "../../apps/web/src/api";
import type { EntryHeadView, MissionView } from "../../apps/web/src/mission-inspector/MissionInspector";
import type {
  MissionProgressObservation,
  MissionProgressPage,
  MissionProgressSnapshot,
  MissionProgressWorkerStatus,
} from "../../apps/web/src/mission-inspector/progress-store";

export const MISSION_ID = "11111111-1111-4111-8111-111111111111";
export const CHILD_TEAM_1 = "22222222-2222-4222-8222-222222222222";
export const DECISION_ID = "33333333-3333-4333-8333-333333333333";
export const GEN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const GEN_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const INST_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const INST_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const COMMIT_A = "aaaaaaa111111111111111111111111111111111";
export const COMMIT_B = "bbbbbbb222222222222222222222222222222222";

export const MEMBER_IDS = {
  coordinator: "44444444-4444-4444-8444-444444444001",
  scoutOld: "44444444-4444-4444-8444-444444444002",
  implOld: "44444444-4444-4444-8444-444444444003",
  integratorFailed: "44444444-4444-4444-8444-444444444004",
  integratorActive: "44444444-4444-4444-8444-444444444005",
} as const;

export const SESSION_IDS = {
  coordinator: "55555555-5555-4555-8555-555555555001",
  scoutOld: "55555555-5555-4555-8555-555555555002",
  implOld: "55555555-5555-4555-8555-555555555003",
  integratorFailed: "55555555-5555-4555-8555-555555555004",
  integratorActive: "55555555-5555-4555-8555-555555555005",
} as const;

export const ENTRY_IDS = {
  checkFail: "66666666-6666-4666-8666-666666666001",
  handoff: "66666666-6666-4666-8666-666666666002",
  direction: "66666666-6666-4666-8666-666666666003",
} as const;

export const fixtureMe: Me = {
  role: "owner",
  environment: "cloud",
  providers: ["claude"],
  projects: [
    { id: "repo-api", name: "API repo", team: { checks: [{ command: "npm", args: ["test"] }] } },
    { id: "repo-web", name: "Web repo", team: { checks: [{ command: "npm", args: ["test"] }] } },
  ],
  teams: { enabled: true },
  missions: { enabled: true },
};

export function createFixtureMission(): MissionView {
  const baseAt = "2026-11-26T01:00:00.000Z";
  return {
    id: MISSION_ID,
    groupId: "group-core",
    groupName: "Core Platform",
    title: "Verify mission inspector E2E",
    objective: "Coordinate API and web subtasks with truthful host progress.",
    status: "needs-input",
    revision: 4,
    createdAt: baseAt,
    updatedAt: "2026-11-26T01:10:00.000Z",
    deadlineAt: "2026-11-27T05:00:00.000Z",
    maxMinutes: 240,
    repoProjectIds: ["repo-api", "repo-web"],
    coordinator: {
      memberId: MEMBER_IDS.coordinator,
      sessionId: SESSION_IDS.coordinator,
      status: "running",
    },
    dispatchSummary: "Dispatched API subteam first; web waits on API.",
    subtasks: [
      {
        id: "subtask-api",
        title: "API endpoint hardening",
        repoProjectId: "repo-api",
        status: "running",
        objective: "Harden progress cursor resync handling.",
        size: "team",
        parallelism: 2,
        teamId: CHILD_TEAM_1,
        teamStatus: "implementing",
      },
      {
        id: "subtask-web",
        title: "Web inspector layout",
        repoProjectId: "repo-web",
        status: "queued",
        objective: "Verify interactive controls and resync notice.",
        size: "solo",
        parallelism: 1,
        dependsOn: ["subtask-api"],
      },
    ],
    decisions: [
      {
        id: DECISION_ID,
        question: "Roll out strict cursor validation?",
        options: ["Approve", "Defer"],
        createdAt: "2026-11-26T01:08:00.000Z",
        subtaskId: "subtask-api",
        recommendation: { answers: ["Approve"], reason: "Prevents stale progress replays" },
      },
    ],
    steering: [{ text: "Keep repair commits visible", revision: 3, at: "2026-11-26T01:02:00.000Z" }],
    events: [{ at: "2026-11-26T01:05:00.000Z", text: "Dispatched API endpoint hardening subteam" }],
  };
}

export function createProgressSnapshot(
  revision = 4,
  status: MissionProgressSnapshot["mission"]["status"] = "needs-input",
  workerCoordinator: MissionProgressWorkerStatus = "unavailable",
): MissionProgressSnapshot {
  const baseAt = "2026-11-26T01:00:00.000Z";
  return {
    mission: {
      id: MISSION_ID,
      title: "Verify mission inspector E2E",
      status,
      revision,
      coordinator: {
        runId: MISSION_ID,
        memberId: MEMBER_IDS.coordinator,
        sessionId: SESSION_IDS.coordinator,
        revision,
        role: "mission-coordinator",
        recordedStatus: "running",
        workerStatus: workerCoordinator,
      },
    },
    subtasks: [
      {
        id: "subtask-api",
        title: "API endpoint hardening",
        repoProjectId: "repo-api",
        status: "running",
        child: {
          kind: "linked",
          runId: CHILD_TEAM_1,
          missionId: MISSION_ID,
          projectId: "repo-api",
          revision: 2,
          status: "implementing",
          assignments: [
            {
              runId: CHILD_TEAM_1,
              memberId: MEMBER_IDS.scoutOld,
              sessionId: SESSION_IDS.scoutOld,
              revision: 1,
              role: "scout",
              taskId: "t-discovery",
              recordedStatus: "stopped",
              exitConfirmedAt: "2026-11-26T01:01:00.000Z",
              workerStatus: "exited",
            },
            {
              runId: CHILD_TEAM_1,
              memberId: MEMBER_IDS.implOld,
              sessionId: SESSION_IDS.implOld,
              revision: 1,
              role: "implementer",
              taskId: "t-legacy",
              recordedStatus: "reported",
              exitConfirmedAt: "2026-11-26T01:02:00.000Z",
              workerStatus: "exited",
            },
            {
              runId: CHILD_TEAM_1,
              memberId: MEMBER_IDS.integratorFailed,
              sessionId: SESSION_IDS.integratorFailed,
              revision: 1,
              role: "integrator",
              taskId: "t-api",
              recordedStatus: "stopped",
              exitConfirmedAt: "2026-11-26T01:04:00.000Z",
              workerStatus: "exited",
            },
            {
              runId: CHILD_TEAM_1,
              memberId: MEMBER_IDS.integratorActive,
              sessionId: SESSION_IDS.integratorActive,
              revision: 2,
              role: "integrator",
              taskId: "t-api",
              recordedStatus: "running",
              workerStatus: "running",
            },
          ],
          checks: [
            {
              revision: 1,
              round: 1,
              headCommit: COMMIT_A,
              status: "failed",
              startedAt: baseAt,
              finishedAt: "2026-11-26T01:03:00.000Z",
              exitCode: 1,
            },
            {
              revision: 2,
              round: 2,
              headCommit: COMMIT_B,
              status: "passed",
              startedAt: "2026-11-26T01:06:00.000Z",
              finishedAt: "2026-11-26T01:06:30.000Z",
              exitCode: 0,
            },
          ],
        },
      },
      {
        id: "subtask-web",
        title: "Web inspector layout",
        repoProjectId: "repo-web",
        status: "queued",
        child: { kind: "not-created" },
      },
    ],
  };
}

function makeCursor(generation: string, instance: string, sequence: number): string {
  return `mp1.${generation}.${MISSION_ID}.${instance}.${sequence}`;
}

function makeObservation(
  generation: string,
  instance: string,
  sequence: number,
  revision: number,
  status: MissionProgressSnapshot["mission"]["status"],
): MissionProgressObservation {
  return {
    cursor: makeCursor(generation, instance, sequence),
    sequence,
    observedAt: `2026-11-26T01:1${sequence}:00.000Z`,
    snapshot: createProgressSnapshot(revision, status, "running"),
  };
}

export function buildResyncPolls(): MissionProgressPage[] {
  const poll1Obs = [
    makeObservation(GEN_1, INST_1, 2, 4, "working"),
    makeObservation(GEN_1, INST_1, 3, 4, "needs-input"),
  ];
  const poll3Obs = [
    makeObservation(GEN_2, INST_2, 2, 5, "working"),
    makeObservation(GEN_2, INST_2, 3, 6, "ready-for-review"),
  ];
  return [
    {
      missionId: MISSION_ID,
      generation: GEN_1,
      cursor: makeCursor(GEN_1, INST_1, 3),
      observedAt: "2026-11-26T01:13:00.000Z",
      resync: { required: true, reason: "initial" },
      observations: poll1Obs,
      snapshot: poll1Obs[1]!.snapshot,
    },
    {
      missionId: MISSION_ID,
      generation: GEN_2,
      cursor: makeCursor(GEN_2, INST_2, 1),
      observedAt: "2026-11-26T01:14:00.000Z",
      resync: { required: true, reason: "host-restarted" },
      observations: [],
      snapshot: createProgressSnapshot(5, "working", "unavailable"),
    },
    {
      missionId: MISSION_ID,
      generation: GEN_2,
      cursor: makeCursor(GEN_2, INST_2, 3),
      observedAt: "2026-11-26T01:16:00.000Z",
      resync: { required: false },
      observations: poll3Obs,
      snapshot: poll3Obs[1]!.snapshot,
    },
  ];
}

export const fixtureChildEntries: { head: EntryHeadView; body: unknown }[] = [
  {
    head: {
      entryId: ENTRY_IDS.checkFail,
      seq: 101,
      scope: "run",
      runId: CHILD_TEAM_1,
      revision: 1,
      at: "2026-11-26T01:03:00.000Z",
      kind: "check",
      author: "host",
      authority: "receipt",
      paths: [],
      summary: "check failed (exit 1): npm test",
      bodyBytes: 180,
      state: "active",
    },
    body: {
      command: { command: "npm", args: ["test"] },
      status: "failed",
      exitCode: 1,
      headCommit: COMMIT_A,
      output: "FAIL src/progress.test.ts on commit A",
    },
  },
  {
    head: {
      entryId: ENTRY_IDS.handoff,
      seq: 102,
      scope: "run",
      runId: CHILD_TEAM_1,
      revision: 2,
      at: "2026-11-26T01:05:30.000Z",
      kind: "handoff",
      author: "member",
      authority: "claim",
      authorRole: "integrator",
      taskId: "t-api",
      paths: ["packages/host/src/mission-progress.ts"],
      summary: "Repaired cursor generation check on commit B",
      bodyBytes: 210,
      state: "active",
    },
    body: {
      done: ["Updated generation check"],
      remaining: [],
      commands: ["npm test"],
      headCommit: COMMIT_B,
    },
  },
  {
    head: {
      entryId: ENTRY_IDS.direction,
      seq: 103,
      scope: "run",
      runId: CHILD_TEAM_1,
      revision: 2,
      at: "2026-11-26T01:07:00.000Z",
      kind: "direction",
      author: "owner",
      authority: "direction",
      paths: [],
      summary: "owner steering: Keep repair commits visible",
      bodyBytes: 96,
      state: "active",
    },
    body: {
      source: "steering",
      text: "Keep repair commits visible",
    },
  },
];
