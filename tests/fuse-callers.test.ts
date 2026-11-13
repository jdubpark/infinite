import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { GoalService } from "../packages/host/src/goals.js";
import { RoutineService } from "../packages/host/src/routines.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
import { emptyUsage } from "../packages/host/src/team-usage.js";
import type { FuseAdmission, FuseCheck, FuseGate, FuseLaunch, FuseOpen } from "../packages/host/src/fuse/types.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { CreateRoutine, Routine } from "../packages/host/src/routine-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { Mission, CreateMission } from "../packages/host/src/mission-types.js";
import type { TeamAssignment, TeamLineup, TeamView } from "../packages/host/src/team-types.js";

/** A gate that records every call and answers from the test's settings. */
function stubGate(open?: FuseOpen) {
  const gate = {
    open, refuse: false,
    checks: [] as { projectId: string; role?: string }[],
    admits: [] as FuseLaunch[],
    releases: [] as string[],
    check(input: { projectId: string; role?: string }): FuseCheck { gate.checks.push(input); return gate.open ? { ...gate.open } : { state: "closed" }; },
    admit(launch: FuseLaunch): FuseAdmission {
      gate.admits.push(structuredClone(launch));
      return gate.refuse ? { ok: false, launchId: launch.launchId, open: { ...openRate } } : { ok: true, launchId: launch.launchId };
    },
    release(launchId: string) { gate.releases.push(launchId); },
    started() {},
  };
  return gate;
}
type Gate = ReturnType<typeof stubGate>;

const openRate: FuseOpen = { state: "open", scope: "project", projectId: "fixture", window: "hour", cause: "launch-rate", ownerClose: false };
const fuseReasonText = "Waiting for the spend fuse: this project reached its hourly launch limit.";
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

test("a goal waits at check before it prepares a cycle", async () => {
  const f = schedulerFixture(), at = new Date().toISOString();
  const goal: ProductGoal = { id: randomUUID(), projectId: f.run.projectId, title: "Inspect the fixture", objective: "Choose scoped work",
    successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60,
    maxMembers: 4, parallelism: 1, revision: 1, status: "running", createdAt: at, updatedAt: at,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup, memberCount: 0,
    cycles: [], steering: [], events: [], outcomes: [] };
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  const created: string[] = [];
  const teams = {
    get: (id: string) => { throw new TeamError(404, "team-not-found", `Team ${id} was not found.`); },
    createForGoal: async (request: { requestId: string }) => {
      created.push(request.requestId);
      return { id: request.requestId, status: "planning", createdAt: at, updatedAt: at, members: [], usage: { total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers: 0 }, branch: "main", baseCommit: "a" } as unknown as TeamView;
    },
  } as unknown as TeamService;
  const gate: Gate = stubGate(openRate);
  const goals = new GoalService(f.config, f.key, teams);
  goals.useFuse(gate);
  goals.start();
  try {
    await waitFor(async () => gate.checks.length, count => count >= 3, 5000);
    const waiting = goals.get(goal.id);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.reason, fuseReasonText);
    assert.doesNotMatch(waiting.reason ?? "", /\d/, "The wait reason names no figure");
    assert.deepEqual(created, [], "No cycle is prepared while the fuse is open");
    assert.equal(waiting.events.filter(event => event.text === fuseReasonText).length, 1, "One event for the wait, however many passes");

    gate.open = undefined;
    const started = await waitFor(async () => goals.get(goal.id), value => value.reason === undefined, 5000);
    await waitFor(async () => created.length, count => count === 1, 5000);
    assert.equal(started.events.filter(event => event.text === fuseReasonText).length, 1, "Clearing the wait adds no event");
  } finally { goals.close(); f.close(); }

  // Without a fuse the first pass starts a cycle, as before.
  const g = schedulerFixture();
  const plain: ProductGoal = { ...goal, id: randomUUID(), events: [], cycles: [], reason: undefined };
  g.writeRecord("goal", plain.id, { goal: plain, receipts: {}, fingerprint: "fixture" });
  const plainCreated: string[] = [];
  const plainTeams = {
    get: (id: string) => { throw new TeamError(404, "team-not-found", `Team ${id} was not found.`); },
    createForGoal: async (request: { requestId: string }) => {
      plainCreated.push(request.requestId);
      return { id: request.requestId, status: "planning", createdAt: at, updatedAt: at, members: [], usage: { total: emptyUsage(), byProfile: {}, byProvider: {}, unmeasuredMembers: 0 }, branch: "main", baseCommit: "a" } as unknown as TeamView;
    },
  } as unknown as TeamService;
  const bare = new GoalService(g.config, g.key, plainTeams);
  bare.start();
  try {
    await waitFor(async () => plainCreated.length, count => count === 1, 5000);
    assert.equal(bare.get(plain.id).reason, undefined);
  } finally { bare.close(); g.close(); }
});

test("a routine waits at check and keeps its schedule", async () => {
  const root = mkdtempSync(join(tmpdir(), "fuse-routine-"));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const config = {
    stateDir, projects: [{ id: "demo", name: "Demo", path: root, team: { checks: [{ command: "node", args: ["check.js"] }] } }],
    teams: { lineup, trustWorkspaces: true, commandPrefix: { command: "safe", args: [] } }, agents: { claude: { command: "claude", args: [] } },
  } as unknown as Config;
  const key = Buffer.alloc(32, 7);
  const started: CreateGoal[] = [];
  let busyChecks = 0;
  const hooks = {
    isProjectBusy: async () => { busyChecks++; return false; },
    startGoal: async (request: CreateGoal, admit: () => void) => {
      admit(); started.push(structuredClone(request));
      return { ...request, id: request.requestId, status: "running", cycles: [] } as unknown as ProductGoal;
    },
  };
  const goalStub = { get: () => { throw new TeamError(404, "goal-not-found", "missing"); } } as never;
  const routines = new RoutineService(config, key, goalStub, hooks);
  const gate = stubGate(openRate);
  routines.useFuse(gate);
  const start = new Date(Date.now() + 20).toISOString();
  const routine: CreateRoutine = { requestId: randomUUID(), goal: { projectId: "demo", title: "Small task", objective: "Do the bounded work", successCriteria: "The requested change is available", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 },
    intervalMinutes: 5, maxOccurrences: 2, startsAt: start, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  try {
    const created: Routine = await routines.create(routine);
    await new Promise(resolve => setTimeout(resolve, 30));
    await routines.tick();
    await routines.tick();
    const waiting = routines.get(created.id);
    assert.equal(started.length, 0, "No goal starts while the fuse is open");
    assert.equal(busyChecks, 0, "The busy check is not reached while the fuse is open");
    assert.equal(waiting.status, created.status);
    assert.equal(waiting.nextRunAt, created.nextRunAt);
    assert.equal(waiting.revision, created.revision);
    assert.equal(waiting.reason, fuseReasonText);

    gate.open = undefined;
    await routines.tick();
    assert.equal(started.length, 1, "The first tick after the fuse closes starts one goal");
    assert.equal(routines.get(created.id).reason, undefined);
  } finally { routines.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a mission coordinator waits at check and at admit", async () => {
  const root = mkdtempSync(join(tmpdir(), "fuse-mission-"));
  const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
  const config = { stateDir, projects: [], agents: {}, teams: { lineup } } as unknown as Config;
  const key = randomBytes(32);
  const created: { request: { requestId: string }; assignment: TeamAssignment; profile?: { id: string } }[] = [];
  let limit: string | undefined;
  const manager = {
    meta: () => { throw Object.assign(new Error("Session metadata is unavailable."), { code: "ENOENT" }); },
    createTeamSession: async (request: { requestId: string }, assignment: TeamAssignment, _cwd: string, profile?: { id: string }) => {
      if (limit) throw new Error(limit);
      created.push({ request, assignment, ...(profile ? { profile } : {}) });
      return { status: "running" };
    },
  } as unknown as Manager;
  const groups: ProjectGroupLookup = { get: () => { throw new Error("Not queried in this test"); } };
  const missions = new MissionService(config, key, manager, { useMissionReservations() {}, isActiveRun() { return false; } } as unknown as TeamService, groups);
  const gate = stubGate(openRate);
  missions.useFuse(gate);
  const mission = {
    id: randomUUID(), title: "Fuse fixture", status: "working", repoProjectIds: ["fixture"], lineup: { coordinator: lineup.coordinator },
    events: [], subtasks: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as Mission;
  const attemptOf = () => ({ memberId: randomUUID(), sessionId: randomUUID(), revision: 1, prompt: "Plan the mission", cursor: 0, stopRequestId: randomUUID(), status: "queued", ownerInputs: 0 });
  const attempt = attemptOf();
  const stored = { mission, fingerprint: "fixture", receipts: {}, folder: root, repos: [], attempts: [attempt], inbox: [], notes: [], notified: [], launches: {}, ops: [], refusals: 0 };
  missions["records"].set(mission.id, stored as never);
  const launch = (value: typeof attempt) => missions["launch"](stored, value) as Promise<void>;
  const eventCount = () => mission.events.filter(event => event.text === fuseReasonText).length;
  try {
    gate.open = openRate;
    await launch(attempt);
    assert.equal(gate.checks.length, 1);
    assert.deepEqual(gate.checks[0], { projectId: "fixture" });
    assert.equal(gate.admits.length, 0, "Admit is not reached while check is open");
    assert.equal(created.length, 0, "No session starts while the fuse is open");
    assert.equal(attempt.status, "queued");
    assert.equal(mission.reason, fuseReasonText);
    assert.equal(eventCount(), 1);

    await launch(attempt);
    assert.equal(gate.checks.length, 2);
    assert.equal(eventCount(), 1, "A repeated wait records no second event");

    gate.open = undefined; gate.refuse = true;
    await launch(attempt);
    assert.equal(gate.admits.length, 1, "Admit is reached once check is closed");
    assert.equal(created.length, 0);
    assert.equal(attempt.status, "queued");
    assert.equal(mission.reason, fuseReasonText);
    // The closed check cleared the wait, so the refused admit starts a new one: one more event.
    assert.equal(eventCount(), 2);

    gate.refuse = false;
    await launch(attempt);
    assert.equal(gate.admits.length, 2);
    assert.deepEqual(gate.admits[1], {
      launchId: attempt.sessionId, projectId: "fixture", purpose: "work", role: "mission-coordinator", profileId: "coordinator",
      assignment: { runId: mission.id, memberId: attempt.memberId, revision: 1 },
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].request.requestId, attempt.sessionId);
    assert.equal(mission.reason, undefined);
    assert.equal(attempt.status, "running");

    const limited = attemptOf();
    stored.attempts.push(limited as never);
    limit = "The configured session limit has been reached.";
    await launch(limited as never);
    assert.deepEqual(gate.releases, [limited.sessionId], "A failed launch releases its admitted slot");
  } finally { missions.close(); rmSync(root, { recursive: true, force: true }); }
});
