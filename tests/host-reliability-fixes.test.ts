import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialAttention } from "@infinite/attention";
import { createRemoteClient, RemoteError } from "@infinite/remote";
import { hashToken } from "../packages/host/src/config.js";
import type { Manager } from "../packages/host/src/manager.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";
import { STOP_REFUSED_REASON } from "../packages/host/src/stall-recovery.js";
import { TeamService } from "../packages/host/src/teams.js";
import type { TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { Config } from "../packages/host/src/types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { waitFor } from "./helpers.js";
import { listen } from "./remote-fixture.js";

test("stalled implementer with active control lease avoids stop retry storm and clears stopRefusedReason on recovery", async () => {
  const f = schedulerFixture();
  try {
    const member = f.run.members[0]!;
    member.role = "implementer";
    member.taskId = "task-1";
    f.run.status = "implementing";
    f.run.tasks = [{ id: "task-1", title: "Task 1", instructions: "Implement task 1", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running", memberId: member.memberId }];
    f.state.control = { id: randomUUID(), label: "Owner", expiresAt: Date.now() + 30_000 };

    let stops = 0;
    f.manager.stopTeamSession = async () => {
      stops++;
      if (f.state.control && f.state.control.expiresAt > Date.now()) {
        throw Object.assign(new Error("Input control is held"), { code: "control-busy" });
      }
      f.state.status = "exited";
      return f.manager.state();
    };
    f.writeTeam();
    const teams = f.openTeam();
    const internals = teams as unknown as {
      records: Map<string, { run: TeamRun }>;
      step(stored: unknown): Promise<void>;
    };
    const stored = internals.records.get(f.run.id)!;

    await internals.step(stored);
    await internals.step(stored);
    await internals.step(stored);
    assert.equal(stops, 0);

    stored.run.reason = STOP_REFUSED_REASON;
    await internals.step(stored);
    await internals.step(stored);
    assert.equal(stops, 0);
    assert.equal(teams.get(f.run.id).reason, STOP_REFUSED_REASON);

    f.state.control = { id: randomUUID(), label: "Owner", expiresAt: Date.now() - 1000 };
    await internals.step(stored);
    const updated = await waitFor(
      () => Promise.resolve(teams.get(f.run.id)),
      run => run.members.length === 2 && !run.pendingOperation,
    );
    assert.equal(stops, 1);
    assert.equal(updated.reason, undefined);
    assert.equal(updated.members.length, 2);
    assert.equal(updated.members[1]!.stalledSourceMemberId, member.memberId);
  } finally {
    f.close();
  }
});

test("remote events() handles null server.address() during server.close() drain without unhandledRejection", async () => {
  const token = randomBytes(32).toString("base64url");
  const machineId = randomUUID();
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const config = {
    origin: "http://127.0.0.1",
    port: 0,
    environment: "local",
    machine: { id: machineId, label: "Test runner" },
    remote: { enabled: true },
    tokens: [{ id: "owner", label: "Owner", role: "owner", hash: hashToken(token) }],
  } as Config;
  const closeRemote = connectRemoteAccess(server, config);
  const url = await listen(server);
  const client = createRemoteClient({ url, token });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await client.request("/me");
    server.close();
    assert.equal(server.address(), null);
    await assert.rejects(
      client.openEvents({ topics: ["sessions"], onEvent: () => {}, onClose: () => {} }),
      (error: RemoteError) => (error.status === 502 && error.code === "upstream-unavailable") || error.code === "disconnected" || error.code === "closed",
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    client.close();
    closeRemote();
    server.closeAllConnections();
  }
});

test("TeamService.launch() skips manager.list() when blocked by workerCapacityFull or active provider limit", async () => {
  const f = schedulerFixture();
  try {
    const runningMember = f.run.members[0]!;
    const freshAt = new Date().toISOString();
    runningMember.role = "implementer";
    runningMember.taskId = "task-0";
    runningMember.lastActivityAt = freshAt;
    f.state.attention.lastActivityAt = freshAt;
    f.run.status = "implementing";
    f.run.parallelism = 1;
    const queuedMembers: TeamMember[] = [];
    const tasks: TeamTask[] = [
      { id: "task-0", title: "Task 0", instructions: "Do 0", paths: ["a.txt"], dependsOn: [], revision: 1, status: "running", memberId: runningMember.memberId },
    ];
    for (let i = 1; i <= 6; i++) {
      const memberId = randomUUID();
      const cwd = join(f.run.workspace, "..", "members", memberId);
      mkdirSync(cwd, { recursive: true, mode: 0o750 });
      const member: TeamMember = {
        runId: f.run.id,
        memberId,
        revision: 1,
        role: "implementer",
        provider: "demo",
        sessionId: randomUUID(),
        title: `Task ${i}`,
        status: "queued",
        cwd,
        baseCommit: f.run.baseCommit,
        prompt: `Implement ${i}`,
        taskId: `task-${i}`,
        cursor: 0,
        stopRequestId: randomUUID(),
      };
      queuedMembers.push(member);
      tasks.push({ id: `task-${i}`, title: `Task ${i}`, instructions: `Do ${i}`, paths: [`f${i}.txt`], dependsOn: [], revision: 1, status: "running", memberId });
    }
    f.run.members.push(...queuedMembers);
    f.run.tasks = tasks;
    f.writeTeam();

    let listCalls = 0;
    f.manager.list = async () => { listCalls++; return []; };
    const teams = f.openTeam();
    const internals = teams as unknown as {
      records: Map<string, { run: TeamRun }>;
      step(stored: unknown): Promise<void>;
      limits: { observe(input: { provider: "demo"; limit: "usage"; detectedAt: string; resetsAt?: string; sessionId: string; runId: string; confidence: "corroborated" }): void };
    };
    const stored = internals.records.get(f.run.id)!;

    await internals.step(stored);
    assert.equal(listCalls, 0);
    assert.ok(queuedMembers.every(member => member.pendingCapacity === true));

    runningMember.status = "stopped";
    f.run.parallelism = 8;
    internals.limits.observe({
      provider: "demo",
      limit: "usage",
      detectedAt: new Date().toISOString(),
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      sessionId: runningMember.sessionId,
      runId: f.run.id,
      confidence: "corroborated",
    });
    await internals.step(stored);
    assert.equal(listCalls, 0);
    assert.ok(queuedMembers.every(member => member.pendingLimit === true));
  } finally {
    f.close();
  }
});

test("MissionService.reportHeld() and willWake() use projectHolders without calling teams.list()", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-holders-")));
  const repoPath = join(root, "repo-a");
  mkdirSync(repoPath, { recursive: true });
  const key = randomBytes(32);
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1",
    keyFile: join(root, "key"),
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    tokens: [],
    environment: "local",
    enableDemo: true,
    maxSessions: 8,
    projects: [{ id: "repo-a", name: "Repo A", path: repoPath }],
    agents: {},
    teams: { workspaceDir: join(root, "teams") },
  };
  const manager = { hostLoad: { held: () => undefined } } as unknown as Manager;
  const teams = new TeamService(config, key, manager, (_project, start) => start());
  const groups: ProjectGroupLookup = {
    get: id => ({
      id,
      name: "Group",
      kind: "owner",
      hidden: false,
      implicit: false,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repos: [{ projectId: "repo-a", name: "Repo A", path: repoPath, checkouts: [] }],
    }),
  };
  const missions = new MissionService(config, key, manager, teams, groups);
  try {
    const teamInternals = teams as unknown as { records: Map<string, { run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean }> };
    const at = new Date().toISOString();
    const makeRun = (status: TeamRun["status"], reason?: string): TeamRun => ({
      id: randomUUID(),
      projectId: "repo-a",
      provider: "demo",
      title: "Run",
      objective: "Obj",
      parallelism: 1,
      revision: 1,
      status,
      ...(reason ? { reason } : {}),
      createdAt: at,
      updatedAt: at,
      workspace: join(config.teams!.workspaceDir, randomUUID(), "integration"),
      branch: "main",
      baseCommit: "a".repeat(40),
      tasks: [],
      members: [],
      decisions: [],
      checks: [],
      steering: [],
      events: [],
      round: 0,
    });
    for (let i = 0; i < 50; i++) {
      const done = makeRun("ready-for-review");
      teamInternals.records.set(done.id, { run: done, fingerprint: "f", receipts: {}, prepared: true });
    }
    const paused = makeRun("paused", "Paused by owner");
    teamInternals.records.set(paused.id, { run: paused, fingerprint: "f", receipts: {}, prepared: true });

    let listCalls = 0;
    const origList = teams.list.bind(teams);
    teams.list = () => { listCalls++; return origList(); };

    const missionId = randomUUID();
    const stored = {
      mission: {
        id: missionId,
        groupId: "g1",
        groupName: "Group",
        title: "Mission",
        objective: "Obj",
        status: "working" as const,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        lineup: {
          coordinator: { id: "coord", label: "Coord", provider: "demo", model: "demo", tier: "strong" },
          implementers: [{ id: "imp", label: "Imp", provider: "demo", model: "demo", tier: "light" }],
          integrator: { id: "int", label: "Int", provider: "demo", model: "demo", tier: "strong" },
          reviewer: { id: "rev", label: "Rev", provider: "demo", model: "demo", tier: "strong" },
        },
        subtasks: [
          { id: "sub-1", title: "Sub 1", repoProjectId: "repo-a", objective: "Do work", dependsOn: [], parallelism: 1, status: "queued" as const },
        ],
        decisions: [],
        steering: [],
        events: [],
      },
      fingerprint: "m",
      receipts: {},
      folder: join(config.stateDir, "missions", missionId),
      repos: [],
      attempts: [{ memberId: randomUUID(), sessionId: randomUUID(), revision: 1, prompt: "p", cursor: 0, stopRequestId: randomUUID(), status: "stopped" as const }],
      inbox: [] as unknown[],
      notes: [],
      notified: [] as string[],
      launches: {},
      ops: [],
      refusals: 0,
    };

    const missionInternals = missions as unknown as {
      reportHeld(stored: unknown, subtask: unknown): void;
      willWake(stored: unknown): boolean;
    };
    missionInternals.reportHeld(stored, stored.mission.subtasks[0]!);
    const wakes = missionInternals.willWake(stored);

    assert.equal(listCalls, 0);
    assert.equal(wakes, false);
    assert.deepEqual(stored.inbox, [
      {
        type: "repository-held",
        subtaskId: "sub-1",
        repoProjectId: "repo-a",
        teamId: paused.id,
        teamStatus: "paused",
        reason: "Paused by owner",
      },
    ]);
  } finally {
    missions.close();
    teams.close();
    rmSync(root, { recursive: true, force: true });
  }
});
