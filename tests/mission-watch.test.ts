import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { handleBoardClientCommand } from "../packages/host/src/board-cli.js";
import type { EntryHead } from "../packages/host/src/evidence/entry-types.js";
import { MissionProgressService, projectMissionChild, type MissionProgressPage } from "../packages/host/src/mission-progress.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import {
  applyMissionWatchCommand,
  currentWatchAssignmentCount,
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

test("mission watch suppresses blackboard fetches and notices mismatched or unavailable child links", async () => {
  const mission = makeMission();
  const mismatchedProgress = makeProgress({ required: true, reason: "initial" });
  mismatchedProgress.snapshot.subtasks[0]!.child = { kind: "mismatched" };

  const mismatchText = missionWatchText(
    mission,
    mismatchedProgress,
    { ...initialMissionWatchState(), showEntries: true },
  );
  assert.match(mismatchText, /child: mismatched/);
  assert.match(mismatchText, /Blackboard entries suppressed/);
  assert.doesNotMatch(mismatchText, new RegExp(`team ${TEAM_1}`));

  const unavailableText = missionWatchText(
    mission,
    null,
    { ...initialMissionWatchState(), showEntries: true },
  );
  assert.match(unavailableText, /API changes.*\(progress unavailable\)/);
  assert.match(unavailableText, /Web UI.*\(progress unavailable\)/);
  assert.match(unavailableText, /child: unavailable/);
  assert.doesNotMatch(unavailableText, /not-created/);

  const requestedPaths: string[] = [];
  const jsonFrames: string[] = [];
  await runMissionWatch(
    {
      json: async <T>(path: string): Promise<T> => {
        requestedPaths.push(path);
        if (path === `/missions/${MISSION_ID}`) return mission as T;
        return mismatchedProgress as T;
      },
    },
    MISSION_ID,
    {
      json: true,
      once: true,
      initialState: { showEntries: true, showDetail: true },
      onFrame: text => jsonFrames.push(text),
    },
  );
  assert.equal(requestedPaths.some(path => path.includes("/entries")), false);
  const parsed = JSON.parse(jsonFrames[0]!);
  assert.equal(parsed.entries, undefined);
});

test("missionWatchText keeps reported workers without exitConfirmedAt visible and marks withdrawn/superseded entries", async () => {
  const mission = makeMission();
  const progress = makeProgress({ required: true, reason: "initial" });
  const linked = progress.snapshot.subtasks[0]!.child;
  assert.equal(linked.kind, "linked");
  if (linked.kind !== "linked") return;
  linked.assignments = [
    {
      runId: TEAM_1,
      memberId: "m-reported-live",
      sessionId: "s-reported-live",
      revision: 2,
      role: "implementer",
      taskId: "t1",
      recordedStatus: "reported",
      workerStatus: "running",
    },
  ];

  const liveText = missionWatchText(mission, progress, initialMissionWatchState());
  assert.match(liveText, /recorded:reported \(awaiting exit\)\s+worker:running/);
  assert.doesNotMatch(liveText, /Finished \(1\)/);
  assert.doesNotMatch(liveText, /No current child assignments/);

  linked.assignments[0]!.exitConfirmedAt = at;
  const confirmedText = missionWatchText(mission, progress, initialMissionWatchState());
  assert.match(confirmedText, /Finished \(1\)/);

  const withdrawnEntry: EntryHead = { ...sampleEntries[0]!, entryId: "e-w", seq: 44, state: "withdrawn", summary: "Retracted check" };
  const supersededEntry: EntryHead = { ...sampleEntries[1]!, entryId: "e-s", seq: 45, state: "superseded", summary: "Replaced finding" };
  const markedText = missionWatchText(
    mission,
    progress,
    {
      ...initialMissionWatchState(),
      showEntries: true,
      showDetail: true,
      entriesByTeam: {
        [TEAM_1]: {
          teamId: TEAM_1,
          entries: [withdrawnEntry, supersededEntry],
          cursor: 45,
          more: false,
          selectedEntry: { head: supersededEntry, body: { detail: "old" } },
        },
      },
    },
  );
  assert.match(markedText, /blackboard #44\s+check\s+host receipt\s+\[withdrawn\]/);
  assert.match(markedText, /blackboard #45\s+finding\s+agent claim\s+\[superseded\]/);
  assert.match(markedText, /ENTRY DETAIL\s+blackboard #45\s+finding\s+agent claim\s+\[superseded\]/);
});

test("real projectMissionChild projection surfaces replaced implementer attempts in missionWatchText", async () => {
  const mission = makeMission();
  const replacedId = randomUUID();
  const liveId = randomUUID();
  const liveSession = randomUUID();
  const run = {
    id: TEAM_1,
    projectId: "repo-api",
    missionId: MISSION_ID,
    revision: 2,
    status: "implementing",
    updatedAt: at,
    tasks: [{ id: "t1", revision: 2, memberId: liveId }],
    members: [
      {
        runId: TEAM_1,
        memberId: replacedId,
        sessionId: randomUUID(),
        revision: 2,
        role: "implementer",
        taskId: "t1",
        status: "stopped",
        exitConfirmedAt: at,
      },
      {
        runId: TEAM_1,
        memberId: liveId,
        sessionId: liveSession,
        revision: 2,
        role: "implementer",
        taskId: "t1",
        status: "running",
      },
    ],
    checks: [],
  } as unknown as TeamRun;

  const service = new MissionProgressService({
    missions: {
      progressSource: () => ({
        id: MISSION_ID,
        title: mission.title,
        status: mission.status,
        revision: mission.revision,
        updatedAt: at,
        subtasks: [{ id: "api-task", title: "API changes", repoProjectId: "repo-api", status: "running", teamId: TEAM_1 }],
      }),
    },
    teams: { missionProgressChild: () => projectMissionChild(run, MISSION_ID, "repo-api") },
    manager: {
      meta: sessionId => ({
        session: {
          team: sessionId === liveSession
            ? { runId: TEAM_1, memberId: liveId, revision: 2, role: "implementer", taskId: "t1" }
            : undefined,
        },
      }),
      state: async () => ({ status: "running" }),
    },
  });

  const page = await service.read(MISSION_ID);
  const linked = page.snapshot.subtasks[0]?.child;
  assert.equal(linked?.kind, "linked");
  if (linked?.kind === "linked") {
    assert.equal(linked.assignments.length, 2);
    assert.equal(currentWatchAssignmentCount(linked.assignments), 1);
  }
  const text = missionWatchText(mission, page, initialMissionWatchState());
  assert.match(text, /API changes.*\(implementing · 1 assigned\)/);
  assert.match(text, /implementer · t1\s+recorded:running\s+worker:running\s+r2/);
  assert.match(text, /earlier attempt: recorded:stopped\s+r2/);
});

test("runMissionWatch advances blackboard cursor past 500 entries across follow polls and resets cursor on team switch", async () => {
  const mission = makeMission();
  mission.subtasks[1] = {
    ...mission.subtasks[1]!,
    status: "running",
    teamId: TEAM_2,
    teamStatus: "implementing",
  };
  const totalEntries = 550;
  const allTeam1Entries: EntryHead[] = Array.from({ length: totalEntries }, (_, index) => ({
    ...sampleEntries[0]!,
    entryId: `e-${index + 1}`,
    seq: index + 1,
    summary: `Team1 entry ${index + 1}`,
  }));
  const team2Entry: EntryHead = {
    ...sampleEntries[1]!,
    runId: TEAM_2,
    entryId: "t2-e-1",
    seq: 7,
    summary: "Team2 fresh entry",
  };

  const entryPaths: string[] = [];
  const frames: string[] = [];
  const abort = new AbortController();
  let poll = 0;

  await runMissionWatch(
    {
      json: async <T>(path: string): Promise<T> => {
        if (path === `/missions/${MISSION_ID}`) {
          poll += 1;
          if (poll === 4) {
            return { ...mission, subtasks: [mission.subtasks[1]!] } as T;
          }
          return mission as T;
        }
        if (path.startsWith(`/missions/${MISSION_ID}/progress`)) {
          const page = makeProgress({ required: poll === 1, reason: "initial" }, GEN_1, poll);
          if (poll === 4) {
            page.snapshot.subtasks = [
              {
                id: "web-task",
                title: "Web UI",
                repoProjectId: "repo-web",
                status: "running",
                child: {
                  kind: "linked",
                  runId: TEAM_2,
                  missionId: MISSION_ID,
                  projectId: "repo-web",
                  revision: 1,
                  status: "implementing",
                  assignments: [],
                  checks: [],
                },
              },
            ];
            abort.abort();
          }
          return page as T;
        }
        if (path.startsWith(`/teams/${TEAM_1}/entries`)) {
          entryPaths.push(path);
          const match = /\?since=(\d+)/.exec(path);
          const since = match ? Number(match[1]) : 0;
          const slice = allTeam1Entries.filter(item => item.seq > since).slice(0, 50);
          const cursor = slice.length ? slice[slice.length - 1]!.seq : since;
          const more = allTeam1Entries.some(item => item.seq > cursor);
          return { entries: slice, cursor, more } as T;
        }
        if (path.startsWith(`/teams/${TEAM_2}/entries`)) {
          entryPaths.push(path);
          return { entries: [team2Entry], cursor: 7, more: false } as T;
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    },
    MISSION_ID,
    {
      tty: false,
      interactive: false,
      pollIntervalMs: 1,
      signal: abort.signal,
      initialState: { showEntries: true, follow: true },
      onFrame: text => frames.push(text),
    },
  );

  assert.equal(entryPaths.includes(`/teams/${TEAM_1}/entries?since=500`), true);
  assert.equal(entryPaths.includes(`/teams/${TEAM_1}/entries?since=550`), true);
  assert.equal(entryPaths.includes(`/teams/${TEAM_2}/entries`), true);
  assert.equal(entryPaths.some(path => path.startsWith(`/teams/${TEAM_2}/entries?since=`)), false);
  assert.ok(frames.some(frame => frame.includes("Team1 entry 550")));
  assert.ok(frames.some(frame => frame.includes("Team2 fresh entry")));
});

test("runMissionWatch --json keeps stdout valid NDJSON and routes transient poll errors to stderr", async () => {
  const mission = makeMission();
  const jsonFrames: string[] = [];
  const stderrChunks: string[] = [];
  const abort = new AbortController();
  let poll = 0;

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await runMissionWatch(
      {
        json: async <T>(path: string): Promise<T> => {
          if (path === `/missions/${MISSION_ID}`) {
            poll += 1;
            if (poll === 2) throw new Error("upstream poll timeout");
            if (poll === 3) {
              abort.abort();
              return { ...mission, revision: 5, status: "working" } as T;
            }
            return mission as T;
          }
          if (poll === 2) throw new Error("upstream poll timeout");
          return makeProgress(
            poll === 1 ? { required: true, reason: "initial" } : { required: false },
            GEN_1,
            poll === 1 ? 1 : 2,
          ) as T;
        },
      },
      MISSION_ID,
      {
        json: true,
        pollIntervalMs: 1,
        signal: abort.signal,
        onFrame: text => jsonFrames.push(text),
      },
    );
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  assert.equal(jsonFrames.length, 2);
  const parsed = jsonFrames.map(line => JSON.parse(line));
  assert.equal(parsed[0].mission.revision, 4);
  assert.equal(parsed[1].mission.revision, 5);
  assert.equal(jsonFrames.some(line => line.includes("Update failed") || line.includes("Ctrl+C")), false);
  assert.match(stderrChunks.join(""), /Update failed: upstream poll timeout/);
});

test("runMissionWatch refreshes cached entry states to withdrawn and superseded while following", async () => {
  const mission = makeMission();
  let serverEntries: EntryHead[] = [
    { ...sampleEntries[0]!, entryId: "e-1", seq: 42, state: "active", summary: "Initial check" },
    { ...sampleEntries[1]!, entryId: "e-2", seq: 43, state: "active", summary: "Initial finding" },
  ];
  const frames: string[] = [];
  const abort = new AbortController();
  let poll = 0;

  await runMissionWatch(
    {
      json: async <T>(path: string): Promise<T> => {
        if (path === `/missions/${MISSION_ID}`) {
          poll += 1;
          if (poll === 2) {
            serverEntries = [
              { ...serverEntries[0]!, state: "withdrawn" },
              { ...serverEntries[1]!, state: "superseded" },
              {
                ...sampleEntries[1]!,
                entryId: "e-3",
                seq: 44,
                supersedes: "e-2",
                state: "active",
                summary: "Updated finding",
              },
            ];
          } else if (poll === 3) {
            serverEntries = [
              serverEntries[0]!,
              serverEntries[1]!,
              { ...serverEntries[2]!, state: "withdrawn" },
            ];
            abort.abort();
          }
          return mission as T;
        }
        if (path.startsWith(`/missions/${MISSION_ID}/progress`)) {
          return makeProgress(
            poll === 1 ? { required: true, reason: "initial" } : { required: false },
            GEN_1,
            poll,
          ) as T;
        }
        if (path.startsWith(`/teams/${TEAM_1}/entries/`)) {
          const entryId = path.slice(`/teams/${TEAM_1}/entries/`.length);
          const head = serverEntries.find(item => item.entryId === entryId)!;
          return { head, body: { entryId } } as T;
        }
        if (path.startsWith(`/teams/${TEAM_1}/entries`)) {
          const match = /\?since=(\d+)/.exec(path);
          const since = match ? Number(match[1]) : 0;
          const slice = serverEntries.filter(item => item.seq > since).slice(0, 50);
          const cursor = slice.length ? slice[slice.length - 1]!.seq : since;
          const more = serverEntries.some(item => item.seq > cursor);
          return { entries: slice, cursor, more } as T;
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    },
    MISSION_ID,
    {
      tty: false,
      interactive: false,
      pollIntervalMs: 1,
      signal: abort.signal,
      initialState: { showEntries: true, showDetail: true, follow: true },
      onFrame: text => frames.push(text),
    },
  );

  assert.equal(frames.length, 3);
  assert.doesNotMatch(frames[0]!, /\[withdrawn\]|\[superseded\]/);
  assert.match(frames[1]!, /blackboard #42\s+check\s+host receipt\s+\[withdrawn\]/);
  assert.match(frames[1]!, /blackboard #43\s+finding\s+agent claim\s+\[superseded\]/);
  assert.match(frames[1]!, /blackboard #44\s+finding\s+agent claim\s+implementer/);
  assert.match(frames[2]!, /blackboard #44\s+finding\s+agent claim\s+\[withdrawn\]/);
  assert.match(frames[2]!, /ENTRY DETAIL\s+blackboard #44\s+finding\s+agent claim\s+\[withdrawn\]/);
});
