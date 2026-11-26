import assert from "node:assert/strict";
import test from "node:test";
import { handleBoardClientCommand } from "../packages/host/src/board-cli.js";
import type { EntryHead } from "../packages/host/src/evidence/entry-types.js";
import type { MissionProgressPage } from "../packages/host/src/mission-progress.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import {
  applyMissionWatchCommand,
  initialMissionWatchState,
  missionWatchCommand,
  missionWatchResyncBanner,
  missionWatchText,
  runMissionWatch,
} from "../packages/host/src/mission-watch.js";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_1 = "22222222-2222-4222-8222-222222222222";
const TEAM_2 = "33333333-3333-4333-8333-333333333333";
const GEN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GEN_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INST_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const at = "2026-11-26T01:00:00.000Z";

function makeMission(): Mission {
  return {
    id: MISSION_ID,
    groupId: "proj-group",
    groupName: "Platform",
    repoProjectIds: ["repo-api", "repo-web"],
    title: "Implement mission inspector",
    objective: "Upgrade web and CLI inspection for missions and child runs.",
    maxSubtasks: 8,
    maxMinutes: 240,
    deadlineAt: "2026-11-26T05:00:00.000Z",
    revision: 4,
    status: "needs-input",
    createdAt: at,
    updatedAt: at,
    lineup: {} as Mission["lineup"],
    coordinator: { memberId: "coord-1", sessionId: "sess-coord", status: "running" },
    subtasks: [
      {
        id: "api-task",
        title: "API changes",
        repoProjectId: "repo-api",
        objective: "Add endpoint filters",
        size: "solo",
        parallelism: 1,
        dependsOn: [],
        status: "running",
        teamId: TEAM_1,
        teamStatus: "implementing",
      },
      {
        id: "web-task",
        title: "Web UI",
        repoProjectId: "repo-web",
        objective: "Build inspector panel",
        size: "team",
        parallelism: 2,
        dependsOn: ["api-task"],
        status: "queued",
      },
    ],
    decisions: [
      {
        id: "dec-1",
        question: "Expose raw JSON detail in CLI?",
        options: ["Yes", "No"],
        createdAt: at,
        recommendation: { answers: ["Yes"], reason: "Helps scripted triage" },
      },
    ],
    steering: [],
    events: [{ at, text: "Dispatched two subtasks." }],
  };
}

function makeProgress(resync: MissionProgressPage["resync"] = { required: true, reason: "initial" }, generation = GEN_1, sequence = 1): MissionProgressPage {
  return {
    missionId: MISSION_ID,
    generation,
    cursor: `mp1.${generation}.${MISSION_ID}.${INST_1}.${sequence}`,
    observedAt: at,
    resync,
    observations: resync.required ? [] : [{
      cursor: `mp1.${generation}.${MISSION_ID}.${INST_1}.${sequence}`,
      sequence,
      observedAt: at,
      snapshot: {
        mission: { id: MISSION_ID, title: "Implement mission inspector", status: "needs-input", revision: 4 },
        subtasks: [],
      },
    }],
    snapshot: {
      mission: {
        id: MISSION_ID,
        title: "Implement mission inspector",
        status: "needs-input",
        revision: 4,
        coordinator: {
          runId: MISSION_ID,
          memberId: "coord-1",
          sessionId: "sess-coord",
          revision: 4,
          role: "mission-coordinator",
          recordedStatus: "running",
          workerStatus: "unavailable",
        },
      },
      subtasks: [
        {
          id: "api-task",
          title: "API changes",
          repoProjectId: "repo-api",
          status: "running",
          child: {
            kind: "linked",
            runId: TEAM_1,
            missionId: MISSION_ID,
            projectId: "repo-api",
            revision: 2,
            status: "implementing",
            assignments: [
              {
                runId: TEAM_1,
                memberId: "m-old",
                sessionId: "s-old",
                revision: 1,
                role: "implementer",
                taskId: "t1",
                recordedStatus: "stopped",
                workerStatus: "exited",
              },
              {
                runId: TEAM_1,
                memberId: "m-live",
                sessionId: "s-live",
                revision: 2,
                role: "implementer",
                taskId: "t1",
                recordedStatus: "running",
                workerStatus: "running",
              },
            ],
            checks: [
              {
                revision: 2,
                round: 1,
                headCommit: "abcdef1234567890",
                status: "passed",
                startedAt: at,
                finishedAt: at,
                exitCode: 0,
              },
            ],
          },
        },
        {
          id: "web-task",
          title: "Web UI",
          repoProjectId: "repo-web",
          status: "queued",
          child: { kind: "not-created" },
        },
      ],
    },
  };
}

const sampleEntries: EntryHead[] = [
  {
    entryId: "e-1",
    seq: 42,
    scope: "run",
    runId: TEAM_1,
    revision: 2,
    at,
    kind: "check",
    author: "host",
    authority: "receipt",
    summary: "All unit tests passed",
    paths: ["packages/host/src/mission-watch.ts"],
    bodyBytes: 64,
    state: "active",
  },
  {
    entryId: "e-2",
    seq: 43,
    scope: "run",
    runId: TEAM_1,
    revision: 2,
    at,
    kind: "finding",
    author: "member",
    authority: "claim",
    authorRole: "implementer",
    taskId: "t1",
    summary: "Observed cursor reset behavior",
    paths: [],
    bodyBytes: 96,
    state: "active",
  },
];

test("missionWatchText renders coordinator state, decisions, subtask selection, resync banner, and child blackboard entries", () => {
  const mission = makeMission();
  const initialProgress = makeProgress({ required: true, reason: "initial" });
  const baseText = missionWatchText(mission, initialProgress, initialMissionWatchState(), { interactive: true });

  assert.doesNotMatch(baseText, /RESYNC NOTICE/);
  assert.match(baseText, /COORDINATOR\s+recorded:running\s+·\s+worker:unavailable/);
  assert.match(baseText, /DECISIONS FOR YOU \(1\)/);
  assert.match(baseText, /Expose raw JSON detail in CLI\?/);
  assert.match(baseText, /> 1\. API changes/);
  assert.match(baseText, /recorded:running\s+worker:running/);
  assert.match(baseText, /earlier attempt: recorded:stopped\s+r1/);
  assert.match(baseText, /passed\s+r2 round:1 abcdef12 exit:0/);
  assert.match(baseText, /j\/k ↑↓ subtask · e entries · enter detail · f follow\(on\) · q quit/);

  const resyncText = missionWatchText(
    mission,
    makeProgress({ required: true, reason: "host-restarted" }, GEN_2, 1),
    initialMissionWatchState(),
    { interactive: true },
  );
  assert.match(resyncText, /RESYNC NOTICE \(host-restarted\)/);
  assert.equal(missionWatchResyncBanner("initial"), null);

  const selectedSecond = applyMissionWatchCommand(initialMissionWatchState(), "nextSubtask", mission.subtasks.length);
  const secondText = missionWatchText(mission, initialProgress, selectedSecond, { interactive: true });
  assert.match(secondText, /> 2\. Web UI/);
  assert.match(secondText, /child: not-created/);

  const withEntriesState = {
    ...initialMissionWatchState(),
    showEntries: true,
    showDetail: true,
    follow: false,
    entriesByTeam: {
      [TEAM_1]: {
        teamId: TEAM_1,
        entries: sampleEntries,
        cursor: 43,
        more: false,
        selectedEntry: { head: sampleEntries[1]!, body: { detail: "verified" } },
      },
    },
  };
  const entriesText = missionWatchText(
    mission,
    makeProgress({ required: false }, GEN_1, 3),
    withEntriesState,
    { interactive: true },
  );
  assert.match(entriesText, /CHILD BLACKBOARD ENTRIES/);
  assert.match(entriesText, /blackboard #42\s+check\s+host receipt\s+host/);
  assert.match(entriesText, /blackboard #43\s+finding\s+agent claim\s+implementer\s+task:t1/);
  assert.match(entriesText, /ENTRY DETAIL\s+blackboard #43/);
  assert.match(entriesText, /progress #3/);
  assert.match(entriesText, /follow\(off\)/);
});

test("missionWatchCommand parses subtask navigation, entry/detail/follow toggles, scroll keys, and quit", () => {
  assert.equal(missionWatchCommand("j"), "nextSubtask");
  assert.equal(missionWatchCommand("\u001b[B"), "nextSubtask");
  assert.equal(missionWatchCommand("\u001bOB"), "nextSubtask");
  assert.equal(missionWatchCommand("k"), "prevSubtask");
  assert.equal(missionWatchCommand("\u001b[A"), "prevSubtask");
  assert.equal(missionWatchCommand("\u001bOA"), "prevSubtask");
  assert.equal(missionWatchCommand("e"), "toggleEntries");
  assert.equal(missionWatchCommand("\r"), "toggleDetail");
  assert.equal(missionWatchCommand("\n"), "toggleDetail");
  assert.equal(missionWatchCommand("f"), "toggleFollow");
  assert.equal(missionWatchCommand("q"), "quit");
  assert.equal(missionWatchCommand("\u0003"), "quit");
  assert.equal(missionWatchCommand("j\u0003"), "quit");
  assert.equal(missionWatchCommand("\u001b[5~"), "pageUp");
  assert.equal(missionWatchCommand("\u001b[6~"), "pageDown");
  assert.equal(missionWatchCommand(" "), "pageDown");
  assert.equal(missionWatchCommand("g"), "top");
  assert.equal(missionWatchCommand("G"), "bottom");
  assert.equal(missionWatchCommand("z"), null);

  let state = initialMissionWatchState();
  state = applyMissionWatchCommand(state, "nextSubtask", 2);
  assert.equal(state.selectedSubtaskIndex, 1);
  state = applyMissionWatchCommand(state, "nextSubtask", 2);
  assert.equal(state.selectedSubtaskIndex, 1);
  state = applyMissionWatchCommand(state, "prevSubtask", 2);
  assert.equal(state.selectedSubtaskIndex, 0);
  state = applyMissionWatchCommand(state, "toggleEntries", 2);
  assert.equal(state.showEntries, true);
  state = applyMissionWatchCommand(state, "toggleDetail", 2);
  assert.equal(state.showDetail, true);
  state = applyMissionWatchCommand(state, "toggleFollow", 2);
  assert.equal(state.follow, false);
});

test("runMissionWatch updates progress cursor across polls, survives resync, and wires into infinite mission watch", async () => {
  const mission = makeMission();
  const paths: string[] = [];
  const frames: string[] = [];
  const abort = new AbortController();
  let poll = 0;

  const api = {
    json: async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path === `/missions/${MISSION_ID}`) return mission as T;
      poll += 1;
      if (poll === 1) return makeProgress({ required: true, reason: "initial" }, GEN_1, 1) as T;
      if (poll === 2) return makeProgress({ required: true, reason: "host-restarted" }, GEN_2, 1) as T;
      abort.abort();
      return makeProgress({ required: false }, GEN_2, 2) as T;
    },
  };

  await runMissionWatch(api, MISSION_ID, {
    tty: false,
    interactive: false,
    pollIntervalMs: 1,
    signal: abort.signal,
    onFrame: text => frames.push(text),
  });

  assert.equal(paths.includes(`/missions/${MISSION_ID}/progress`), true);
  assert.equal(paths.includes(`/missions/${MISSION_ID}/progress?cursor=mp1.${GEN_1}.${MISSION_ID}.${INST_1}.1`), true);
  assert.equal(paths.includes(`/missions/${MISSION_ID}/progress?cursor=mp1.${GEN_2}.${MISSION_ID}.${INST_1}.1`), true);
  assert.ok(frames.some(frame => frame.includes("RESYNC NOTICE (host-restarted)")));

  const jsonFrames: string[] = [];
  const jsonAbort = new AbortController();
  let jsonPoll = 0;
  await runMissionWatch(
    {
      json: async <T>(path: string): Promise<T> => {
        if (path === `/missions/${MISSION_ID}`) return mission as T;
        if (path.startsWith(`/teams/${TEAM_1}/entries/`)) return { head: sampleEntries[1]!, body: { ok: true } } as T;
        if (path === `/teams/${TEAM_1}/entries`) return { entries: sampleEntries, cursor: 43, more: false } as T;
        jsonPoll += 1;
        if (jsonPoll >= 1) jsonAbort.abort();
        return makeProgress({ required: true, reason: "initial" }, GEN_1, 1) as T;
      },
    },
    MISSION_ID,
    {
      json: true,
      pollIntervalMs: 1,
      signal: jsonAbort.signal,
      initialState: { showEntries: true, showDetail: true },
      onFrame: text => jsonFrames.push(text),
    },
  );
  const parsed = JSON.parse(jsonFrames[0]!);
  assert.equal(parsed.mission.id, MISSION_ID);
  assert.equal(parsed.progress.generation, GEN_1);
  assert.equal(parsed.entries.entries.length, 2);
  assert.equal(parsed.entries.selectedEntry.head.seq, 43);

  await assert.rejects(
    handleBoardClientCommand(
      "mission",
      ["watch", MISSION_ID, "extra"],
      {},
      { origin: "https://host.example.test", token: "tok" },
      { json: async () => mission } as never,
      "/unused",
    ),
    { message: "Usage: infinite mission watch ID [--json]" },
  );
  assert.equal(TEAM_2.length > 0, true);
});

test("runMissionWatch pages past entry 50 with since and surfaces detail errors even when follow is off", async () => {
  const mission = makeMission();
  const pagedPaths: string[] = [];
  const pagedFrames: string[] = [];
  const page1Entries = Array.from({ length: 50 }, (_, index) => ({
    ...sampleEntries[0]!,
    entryId: `e-${index + 1}`,
    seq: index + 1,
    summary: `Entry ${index + 1}`,
  }));
  const page2Entries = [
    {
      ...sampleEntries[1]!,
      entryId: "e-51",
      seq: 51,
      summary: "Latest paged entry 51",
    },
  ];

  await runMissionWatch(
    {
      json: async <T>(path: string): Promise<T> => {
        pagedPaths.push(path);
        if (path === `/missions/${MISSION_ID}`) return mission as T;
        if (path === `/teams/${TEAM_1}/entries`) return { entries: page1Entries, cursor: 50, more: true } as T;
        if (path === `/teams/${TEAM_1}/entries?since=50`) return { entries: page2Entries, cursor: 51, more: false } as T;
        if (path === `/teams/${TEAM_1}/entries/e-51`) throw new Error("detail store timeout");
        return makeProgress({ required: true, reason: "initial" }, GEN_1, 1) as T;
      },
    },
    MISSION_ID,
    {
      tty: false,
      interactive: false,
      once: true,
      initialState: { showEntries: true, showDetail: true, follow: false },
      onFrame: text => pagedFrames.push(text),
    },
  );

  assert.equal(pagedPaths.includes(`/teams/${TEAM_1}/entries?since=50`), true);
  assert.equal(pagedPaths.includes(`/teams/${TEAM_1}/entries/e-51`), true);
  assert.match(pagedFrames[0]!, /Latest paged entry 51/);
  assert.match(pagedFrames[0]!, /Error loading entry detail: detail store timeout/);
});
