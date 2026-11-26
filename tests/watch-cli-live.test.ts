import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { z } from "zod";
import { createClientApi } from "../packages/host/src/client-api.js";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { ENTRY_KINDS } from "../packages/host/src/evidence/entry-types.js";
import { memberEntryId, memberEntryPostSchema } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { MissionProgressService, missionProgressQuerySchema, projectMissionChild } from "../packages/host/src/mission-progress.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import { runMissionWatch } from "../packages/host/src/mission-watch.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { runTeamWatch } from "../packages/host/src/team-watch-board.js";

const COMMIT_A = "aaaaaaa111111111111111111111111111111111";
const COMMIT_B = "bbbbbbb222222222222222222222222222222222";
const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_1 = "22222222-2222-4222-8222-222222222222";
const TEAM_2 = "33333333-3333-4333-8333-333333333333";
const TOKEN = "live-watch-test-token";
const AT = "2026-11-26T01:00:00.000Z";

const MEMBER_IDS = {
  coord: "44444444-4444-4444-8444-444444444001",
  integrator: "44444444-4444-4444-8444-444444444002",
  reviewer: "44444444-4444-4444-8444-444444444003",
  webImpl: "44444444-4444-4444-8444-444444444004",
} as const;

const SESSION_IDS = {
  coord: "55555555-5555-4555-8555-555555555001",
  integrator: "55555555-5555-4555-8555-555555555002",
  reviewer: "55555555-5555-4555-8555-555555555003",
  webImpl: "55555555-5555-4555-8555-555555555004",
} as const;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

function makeTeam1Run(): TeamRun {
  return {
    id: TEAM_1,
    missionId: MISSION_ID,
    projectId: "repo-api",
    provider: "claude",
    title: "Repair gate run",
    objective: "Fix gate check and verify commit B.",
    parallelism: 2,
    revision: 2,
    status: "verifying",
    createdAt: AT,
    updatedAt: AT,
    workspace: "/home/dev/projects/infinite",
    branch: "infinite/repair-gate",
    baseCommit: COMMIT_A,
    headCommit: COMMIT_B,
    round: 2,
    goal: {
      id: "66666666-6666-4666-8666-666666666666",
      revision: 1,
      cycle: 1,
      successCriteria: "Gate tests pass on commit B",
      nonGoals: [],
      allowedPaths: ["."],
      evidence: [],
      previousWork: [],
      deadlineAt: "2026-11-27T01:00:00.000Z",
      maxMembers: 8,
      record: {
        version: 1,
        criteria: [{ id: "c0", statement: "", check: "npm test passes", producer: "host" }],
      },
    },
    assessment: {
      verdictId: "77777777-7777-4777-8777-777777777777",
      revision: 2,
      head: COMMIT_B,
      kind: "reviewed",
      result: "inconclusive",
      counts: { met: 1, notMet: 0, inconclusive: 0, pendingOwner: 0 },
      criteria: [{ id: "c0", state: "met" }],
      at: AT,
    },
    tasks: [
      {
        id: "t-repair",
        title: "Repair gate assertion",
        instructions: "Fix assertion",
        paths: ["src/gate.ts"],
        dependsOn: [],
        revision: 2,
        status: "integrated",
        memberId: MEMBER_IDS.integrator,
        commit: COMMIT_B,
        changedPaths: { paths: ["src/gate.ts"], truncated: false },
        criterionRefs: { objectiveVersion: 1, criteria: ["c0"] },
      },
    ],
    members: [
      {
        runId: TEAM_1,
        memberId: MEMBER_IDS.integrator,
        sessionId: SESSION_IDS.integrator,
        revision: 2,
        role: "integrator",
        taskId: "t-repair",
        title: "Integrator repair",
        status: "running",
        cwd: "/home/dev/projects/infinite",
        baseCommit: COMMIT_B,
        prompt: "Integrate repair",
        cursor: 0,
        stopRequestId: "88888888-8888-4888-8888-888888888001",
        startedAt: AT,
      },
      {
        runId: TEAM_1,
        memberId: MEMBER_IDS.reviewer,
        sessionId: SESSION_IDS.reviewer,
        revision: 2,
        role: "reviewer",
        title: "Reviewer pass",
        status: "reported",
        cwd: "/home/dev/projects/infinite",
        baseCommit: COMMIT_B,
        prompt: "Review commit B",
        cursor: 0,
        stopRequestId: "88888888-8888-4888-8888-888888888002",
        entryTools: true,
        startedAt: AT,
        reportedAt: "2026-11-26T01:06:00.000Z",
        exitConfirmedAt: "2026-11-26T01:06:30.000Z",
        report: {
          kind: "review",
          verdict: "approved",
          summary: "Commit B repair passes all checks.",
        },
      },
    ],
    decisions: [
      {
        id: "99999999-9999-4999-8999-999999999001",
        memberId: MEMBER_IDS.reviewer,
        revision: 2,
        question: "Confirm release window?",
        options: ["Now", "Later"],
        createdAt: AT,
      },
    ],
    checks: [
      {
        command: { command: "npm", args: ["test"] },
        headCommit: COMMIT_A,
        round: 1,
        status: "failed",
        startedAt: "2026-11-26T01:01:00.000Z",
        finishedAt: "2026-11-26T01:01:30.000Z",
        exitCode: 1,
        output: "FAIL src/gate.test.ts on commit A",
        revision: 2,
      },
      {
        command: { command: "npm", args: ["test"] },
        headCommit: COMMIT_B,
        round: 2,
        status: "passed",
        startedAt: "2026-11-26T01:04:00.000Z",
        finishedAt: "2026-11-26T01:04:30.000Z",
        exitCode: 0,
        output: "PASS src/gate.test.ts on commit B",
        revision: 2,
      },
    ],
    steering: [],
    events: [{ at: AT, text: "Checks passed on commit B" }],
  };
}

function makeTeam2Run(): TeamRun {
  return {
    id: TEAM_2,
    missionId: MISSION_ID,
    projectId: "repo-web",
    provider: "claude",
    title: "Web inspector subteam",
    objective: "Verify web panel behavior.",
    parallelism: 1,
    revision: 1,
    status: "implementing",
    createdAt: AT,
    updatedAt: AT,
    workspace: "/home/dev/projects/infinite",
    branch: "infinite/web-panel",
    baseCommit: COMMIT_B,
    round: 1,
    tasks: [
      {
        id: "t-web",
        title: "Web layout task",
        instructions: "Build panel",
        paths: ["apps/web/src/missions.tsx"],
        dependsOn: [],
        revision: 1,
        status: "running",
        memberId: MEMBER_IDS.webImpl,
      },
    ],
    members: [
      {
        runId: TEAM_2,
        memberId: MEMBER_IDS.webImpl,
        sessionId: SESSION_IDS.webImpl,
        revision: 1,
        role: "implementer",
        taskId: "t-web",
        title: "Web implementer",
        status: "running",
        cwd: "/home/dev/projects/infinite",
        baseCommit: COMMIT_B,
        prompt: "Update web view",
        cursor: 0,
        stopRequestId: "88888888-8888-4888-8888-888888888003",
        startedAt: AT,
      },
    ],
    decisions: [],
    checks: [
      {
        command: { command: "npm", args: ["run", "typecheck"] },
        headCommit: COMMIT_B,
        round: 1,
        status: "passed",
        startedAt: "2026-11-26T01:08:00.000Z",
        finishedAt: "2026-11-26T01:08:30.000Z",
        exitCode: 0,
        output: "TEAM2 typecheck clean",
        revision: 1,
      },
    ],
    steering: [],
    events: [],
  };
}

function seedBlackboard(blackboard: Blackboard, team1: TeamRun, team2: TeamRun): { supersededFindingId: string; latestFindingId: string } {
  assert.equal(blackboard.mirror(team1), true);
  assert.equal(blackboard.mirror(team2), true);
  const reviewer = team1.members.find(member => member.memberId === MEMBER_IDS.reviewer)!;
  assert.equal(blackboard.recordLaunch(team1, reviewer, { launchSeq: 1, promptBytes: 600, contextBytes: 1200 }), true);

  const binding = { runId: team1.id, memberId: reviewer.memberId, revision: reviewer.revision };
  const firstEntry = memberEntryPostSchema.parse({
    kind: "finding",
    summary: "Reviewer initial finding on commit A",
    paths: ["src/gate.ts"],
    body: {
      items: [{ source: "src/gate.test.ts", observation: "Failed assertion before repair" }],
    },
  });
  const firstId = memberEntryId(binding, firstEntry);

  const secondEntry = memberEntryPostSchema.parse({
    kind: "finding",
    summary: "Reviewer verified repair on commit B",
    paths: ["src/gate.ts"],
    supersedes: firstId,
    body: {
      items: [{ source: "src/gate.test.ts", observation: "Verified repair passes on commit B" }],
    },
  });
  const secondId = memberEntryId(binding, secondEntry);

  const ingested = blackboard.ingest(
    team1,
    reviewer,
    [
      {
        seq: 1,
        at: "2026-11-26T01:02:00.000Z",
        envelope: { op: "post", ...binding, requestId: firstId, entry: firstEntry },
      },
      {
        seq: 2,
        at: "2026-11-26T01:06:15.000Z",
        envelope: { op: "post", ...binding, requestId: secondId, entry: secondEntry },
      },
    ],
    [],
  );
  assert.equal(ingested.result, "stored");
  assert.equal(ingested.stored, 2);
  return { supersededFindingId: firstId, latestFindingId: secondId };
}

function withInteractiveStreams(options: { ttyOut: boolean; onOut?: (chunk: string) => void }): () => void {
  const stdout = process.stdout as NodeJS.WriteStream & Record<string, unknown>;
  const stdin = process.stdin as NodeJS.ReadStream & Record<string, unknown>;

  const savedStdoutIsTty = Object.getOwnPropertyDescriptor(stdout, "isTTY");
  const savedStdoutRows = Object.getOwnPropertyDescriptor(stdout, "rows");
  const savedStdoutCols = Object.getOwnPropertyDescriptor(stdout, "columns");
  const savedStdoutWrite = stdout.write;

  const savedStdinIsTty = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  const savedStdinRaw = Object.getOwnPropertyDescriptor(stdin, "setRawMode");
  const savedStdinEncoding = stdin.setEncoding;
  const savedStdinResume = stdin.resume;
  const savedStdinPause = stdin.pause;

  Object.defineProperty(stdout, "isTTY", { value: options.ttyOut, configurable: true });
  Object.defineProperty(stdout, "rows", { value: 60, configurable: true });
  Object.defineProperty(stdout, "columns", { value: 120, configurable: true });
  if (options.onOut) {
    stdout.write = ((chunk: string | Uint8Array) => {
      options.onOut!(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  }

  Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(stdin, "setRawMode", { value: () => stdin, configurable: true });
  stdin.setEncoding = (() => stdin) as typeof process.stdin.setEncoding;
  stdin.resume = (() => stdin) as typeof process.stdin.resume;
  stdin.pause = (() => stdin) as typeof process.stdin.pause;

  return () => {
    if (savedStdoutIsTty) Object.defineProperty(stdout, "isTTY", savedStdoutIsTty);
    else delete stdout.isTTY;
    if (savedStdoutRows) Object.defineProperty(stdout, "rows", savedStdoutRows);
    else delete stdout.rows;
    if (savedStdoutCols) Object.defineProperty(stdout, "columns", savedStdoutCols);
    else delete stdout.columns;
    stdout.write = savedStdoutWrite;

    if (savedStdinIsTty) Object.defineProperty(stdin, "isTTY", savedStdinIsTty);
    else delete stdin.isTTY;
    if (savedStdinRaw) Object.defineProperty(stdin, "setRawMode", savedStdinRaw);
    else delete stdin.setRawMode;
    stdin.setEncoding = savedStdinEncoding;
    stdin.resume = savedStdinResume;
    stdin.pause = savedStdinPause;
  };
}

function createWatchServer(blackboard: Blackboard, team1: TeamRun, team2: TeamRun) {
  let workerCoordinatorStatus: "running" | "unavailable" = "running";
  let mission: Mission = {
    id: MISSION_ID,
    groupId: "group-core",
    groupName: "Core Platform",
    repoProjectIds: ["repo-api", "repo-web"],
    title: "Live CLI watch mission",
    objective: "Verify progress cursor, host restart resync, and child blackboard drilldown.",
    maxSubtasks: 8,
    maxMinutes: 240,
    deadlineAt: "2026-11-27T01:00:00.000Z",
    revision: 4,
    status: "working",
    createdAt: AT,
    updatedAt: AT,
    lineup: {} as Mission["lineup"],
    coordinator: { memberId: MEMBER_IDS.coord, sessionId: SESSION_IDS.coord, status: "running" },
    subtasks: [
      {
        id: "api-task",
        title: "API changes",
        repoProjectId: "repo-api",
        objective: "Repair gate assertion",
        size: "team",
        parallelism: 2,
        dependsOn: [],
        status: "running",
        teamId: TEAM_1,
        teamStatus: "verifying",
      },
      {
        id: "web-task",
        title: "Web UI",
        repoProjectId: "repo-web",
        objective: "Update panel",
        size: "solo",
        parallelism: 1,
        dependsOn: ["api-task"],
        status: "running",
        teamId: TEAM_2,
        teamStatus: "implementing",
      },
    ],
    decisions: [
      {
        id: "dec-live-1",
        question: "Confirm release window?",
        options: ["Now", "Later"],
        createdAt: AT,
      },
    ],
    steering: [],
    events: [{ at: AT, text: "Dispatched API and Web subteams" }],
  };

  const teamsById = new Map<string, TeamRun>([
    [TEAM_1, team1],
    [TEAM_2, team2],
  ]);

  const progressSources = {
    missions: {
      progressSource: () => ({
        id: mission.id,
        title: mission.title,
        status: mission.status,
        revision: mission.revision,
        updatedAt: mission.updatedAt,
        coordinator: {
          runId: mission.id,
          memberId: MEMBER_IDS.coord,
          sessionId: SESSION_IDS.coord,
          revision: mission.revision,
          role: "mission-coordinator" as const,
          status: "running" as const,
        },
        subtasks: mission.subtasks.map(subtask => ({
          id: subtask.id,
          title: subtask.title,
          repoProjectId: subtask.repoProjectId,
          status: subtask.status,
          ...(subtask.teamId ? { teamId: subtask.teamId } : {}),
        })),
      }),
    },
    teams: {
      missionProgressChild: (runId: string, expectedMissionId: string, expectedProjectId: string) => {
        const found = teamsById.get(runId);
        if (!found) return { kind: "missing" as const };
        return projectMissionChild(found, expectedMissionId, expectedProjectId);
      },
    },
    manager: {
      meta: (sessionId: string) => {
        if (sessionId === SESSION_IDS.coord) {
          return { session: { team: { runId: MISSION_ID, memberId: MEMBER_IDS.coord, revision: mission.revision, role: "mission-coordinator" as const } } };
        }
        if (sessionId === SESSION_IDS.integrator) {
          return { session: { team: { runId: TEAM_1, memberId: MEMBER_IDS.integrator, revision: team1.revision, role: "integrator" as const, taskId: "t-repair" } } };
        }
        return { session: {} };
      },
      state: async (sessionId: string) => ({
        status: sessionId === SESSION_IDS.coord ? workerCoordinatorStatus : "running",
      }),
    },
  };

  let progressService = new MissionProgressService(progressSources);

  const app = express();
  app.use("/api", (req, res, next) => {
    if (req.header("authorization") !== `Bearer ${TOKEN}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.get("/api/teams/:id", (req, res) => {
    const found = teamsById.get(req.params.id);
    if (!found) {
      res.status(404).json({ code: "team-not-found" });
      return;
    }
    res.json(found);
  });

  const entryQuerySchema = z.object({
    kind: z.union([z.enum(ENTRY_KINDS), z.array(z.enum(ENTRY_KINDS))]).optional(),
    since: z.string().regex(/^\d+$/).transform(Number).optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).optional(),
  }).strict();

  app.get("/api/teams/:id/entries", (req, res) => {
    if (!teamsById.has(req.params.id)) {
      res.status(404).json({ code: "team-not-found" });
      return;
    }
    const query = entryQuerySchema.parse(req.query);
    const kinds = query.kind === undefined ? undefined : Array.isArray(query.kind) ? query.kind : [query.kind];
    res.json(blackboard.list(req.params.id, {
      ...(kinds ? { kinds } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    }));
  });

  app.get("/api/teams/:id/entries/:entryId", (req, res) => {
    const found = blackboard.get(req.params.id, req.params.entryId);
    if (!found) {
      res.status(404).json({ code: "entry-not-found" });
      return;
    }
    res.json(found);
  });

  app.get("/api/sessions/:id", (req, res) => {
    res.json({
      id: req.params.id,
      seq: 3,
      screen: req.params.id === SESSION_IDS.integrator ? "Integrator screen: commit B ready" : "Session active",
    });
  });

  app.get("/api/sessions/:id/events", (_req, res) => {
    res.json({
      events: [{ at: AT, type: "lifecycle", data: { status: "running", message: "Worker active on commit B" } }],
      cursor: 3,
      more: false,
    });
  });

  app.get("/api/sessions/:id/summary", (_req, res) => {
    res.json({
      state: "ready",
      summary: {
        text: "Repair on commit B verified by host checks.",
        at: AT,
      },
    });
  });

  app.get("/api/missions/:id", (req, res) => {
    if (req.params.id !== mission.id) {
      res.status(404).json({ code: "mission-not-found" });
      return;
    }
    res.json(mission);
  });

  app.get("/api/missions/:id/progress", async (req, res) => {
    const query = missionProgressQuerySchema.parse(req.query);
    res.json(await progressService.read(req.params.id, query.cursor));
  });

  return {
    app,
    setCoordinatorWorkerStatus: (next: "running" | "unavailable") => {
      workerCoordinatorStatus = next;
    },
    markApiTaskDone: () => {
      mission = {
        ...mission,
        revision: mission.revision + 1,
        updatedAt: "2026-11-26T01:12:00.000Z",
        subtasks: mission.subtasks.map(item => (item.id === "api-task" ? { ...item, status: "done" } : item)),
      };
    },
    simulateHostRestart: () => {
      progressService = new MissionProgressService(progressSources);
    },
  };
}

test("runTeamWatch --board drives real HTTP Blackboard, supersedes, filters, member jump, summary/logs/board modes, and exits cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-live-team-watch-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(root), vaultKey: key });
  const blackboard = new Blackboard(store);
  const team1 = makeTeam1Run();
  const team2 = makeTeam2Run();
  const { supersededFindingId } = seedBlackboard(blackboard, team1, team2);
  const controller = createWatchServer(blackboard, team1, team2);
  const server = controller.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const api = createClientApi({ origin: `http://127.0.0.1:${port}`, token: TOKEN });

  const frames: string[] = [];
  const restoreStreams = withInteractiveStreams({
    ttyOut: true,
    onOut: chunk => frames.push(stripAnsi(chunk)),
  });

  try {
    const watchDone = runTeamWatch({
      subcommand: "watch",
      id: TEAM_1,
      options: { json: false, logs: false, board: true },
      api,
    });

    const latestScreen = () => frames[frames.length - 1] ?? "";

    await waitFor(
      () =>
        latestScreen().includes("DECISIONS FOR YOU (1)") &&
        latestScreen().includes("Confirm release window?") &&
        latestScreen().includes(COMMIT_A.slice(0, 7)) &&
        latestScreen().includes(COMMIT_B.slice(0, 7)) &&
        latestScreen().includes("seq 7"),
      "initial team board frame with decisions, seq, and commit hashes",
    );

    process.stdin.emit("data", "k");
    await waitFor(
      () => latestScreen().includes("follow off") && latestScreen().includes("> seq 6"),
      "k moves selection up and disables follow",
    );

    process.stdin.emit("data", "j");
    await waitFor(() => latestScreen().includes("> seq 7"), "j moves selection down to seq 7");

    process.stdin.emit("data", "\r");
    await waitFor(
      () =>
        latestScreen().includes("ENTRY DETAIL · seq 7") &&
        latestScreen().includes(`Supersedes: ${supersededFindingId}`) &&
        latestScreen().includes("Reviewer verified repair on commit B"),
      "enter fetches real entry detail and renders supersedes link",
    );

    process.stdin.emit("data", "p");
    await waitFor(
      () => latestScreen().includes("filter check") && latestScreen().includes("PASS src/gate.test.ts on commit B"),
      "p filters to check entries and loads passing check detail",
    );

    process.stdin.emit("data", "k");
    await waitFor(
      () => latestScreen().includes("FAIL src/gate.test.ts on commit A"),
      "k selects failed check on commit A and loads its detail",
    );

    process.stdin.emit("data", "p");
    await waitFor(
      () => latestScreen().includes("filter integration") && latestScreen().includes("t-repair"),
      "second p filters to integration entry with authorMemberId",
    );

    process.stdin.emit("data", "o");
    await waitFor(
      () => latestScreen().includes("review logs") && latestScreen().includes("Integrator screen: commit B ready"),
      "o jumps to integrator member logs",
    );

    process.stdin.emit("data", "s");
    await waitFor(
      () => latestScreen().includes("SESSION SUMMARY") && latestScreen().includes("Repair on commit B verified by host checks."),
      "s switches to summary view",
    );

    process.stdin.emit("data", "l");
    await waitFor(() => latestScreen().includes("review logs"), "l switches to logs view");

    process.stdin.emit("data", "b");
    await waitFor(
      () => latestScreen().includes("BLACKBOARD ENTRIES") && latestScreen().includes("filter integration"),
      "b returns to board view",
    );

    process.stdin.emit("data", "f");
    await waitFor(() => latestScreen().includes("follow on"), "f toggles follow on");

    process.stdin.emit("data", "q");
    const result = await watchDone;
    assert.equal(result, true);
  } finally {
    restoreStreams();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMissionWatch drives real MissionProgressService cursor advance, restart resync, subtask switch, and Enter detail with follow off", async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-live-mission-watch-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(root), vaultKey: key });
  const blackboard = new Blackboard(store);
  const team1 = makeTeam1Run();
  const team2 = makeTeam2Run();
  seedBlackboard(blackboard, team1, team2);
  const controller = createWatchServer(blackboard, team1, team2);
  const server = controller.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const api = createClientApi({ origin: `http://127.0.0.1:${port}`, token: TOKEN });

  const frames: string[] = [];
  const restoreStreams = withInteractiveStreams({ ttyOut: false });

  try {
    const watchDone = runMissionWatch(api, MISSION_ID, {
      tty: false,
      interactive: true,
      pollIntervalMs: 25,
      onFrame: frame => frames.push(stripAnsi(frame)),
    });

    const latestFrame = () => frames[frames.length - 1] ?? "";

    await waitFor(
      () =>
        latestFrame().includes("COORDINATOR  recorded:running  ·  worker:running") &&
        latestFrame().includes("> 1. API changes"),
      "initial mission watch frame",
    );

    controller.setCoordinatorWorkerStatus("unavailable");
    await waitFor(
      () =>
        latestFrame().includes("worker:unavailable") &&
        latestFrame().includes("progress #2"),
      "real MissionProgressService cursor advance to progress #2",
    );

    controller.simulateHostRestart();
    await waitFor(
      () => latestFrame().includes("RESYNC NOTICE (host-restarted)"),
      "real MissionProgressService host-restarted resync",
    );

    controller.markApiTaskDone();
    await waitFor(
      () =>
        latestFrame().includes("API changes  [done]") &&
        latestFrame().includes("progress #2"),
      "post-restart progress #2 observation rendered",
    );

    process.stdin.emit("data", "e");
    await waitFor(
      () =>
        latestFrame().includes("CHILD BLACKBOARD ENTRIES") &&
        latestFrame().includes("blackboard #7") &&
        latestFrame().includes("Reviewer verified repair on commit B"),
      "e loads real SQLite blackboard entries for selected child",
    );

    process.stdin.emit("data", "f");
    await waitFor(() => latestFrame().includes("follow(off)"), "f turns follow off");

    process.stdin.emit("data", "\r");
    await waitFor(
      () =>
        latestFrame().includes("ENTRY DETAIL  blackboard #7") &&
        latestFrame().includes("Verified repair passes on commit B"),
      "enter fetches real entry detail even with follow off",
    );

    process.stdin.emit("data", "j");
    await waitFor(
      () =>
        latestFrame().includes("> 2. Web UI") &&
        latestFrame().includes(`team ${TEAM_2}`) &&
        latestFrame().includes("TEAM2 typecheck clean"),
      "j switches subtask to TEAM_2 and fetches its blackboard entry detail",
    );

    process.stdin.emit("data", "q");
    await watchDone;
  } finally {
    restoreStreams();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
