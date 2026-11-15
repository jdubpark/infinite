import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { BASELINE_FILE, readBaseline } from "../packages/host/src/fuse/baseline.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import type { FuseGate } from "../packages/host/src/fuse/types.js";
import { GoalService } from "../packages/host/src/goals.js";
import { HALT_FILE, MAX_RECEIPTS, writeHaltRecord } from "../packages/host/src/halt/record.js";
import { KEPT_PAUSED, type HaltTargets } from "../packages/host/src/halt/rules.js";
import { RoutineService } from "../packages/host/src/routines.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import { Manager } from "../packages/host/src/manager.js";
import { MissionService } from "../packages/host/src/missions.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { CreateGoal } from "../packages/host/src/goal-types.js";
import type { CreateRoutine } from "../packages/host/src/routine-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { inProcessHost, waitFor } from "./helpers.js";
import { mixedLineup } from "./team-fixture.js";

type Fixture = ReturnType<typeof schedulerFixture>;

const HOST_TEXT = "Halted by the owner for the whole host.";
const PROJECT_TEXT = "Halted by the owner for this project.";
const owner = { deviceId: "owner-device", label: "Owner phone" };
const hostScope = { scope: "host" } as const;
const fixtureScope = { scope: "project", projectId: "fixture" } as const;
const noRoutines: HaltTargets = { haltPause: async () => [], haltResume: async () => [] };
const openFuse: FuseGate = {
  check: () => ({ state: "closed" }), admit: launch => ({ ok: true, launchId: launch.launchId }), release() {}, started() {},
};

/** A lineup with a strong coordinator and reviewer, which a routine needs before it is approved. */
const reviewedLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/** The scheduler's private pass, as tests/fuse-launch.test.ts reaches it. */
async function step(teams: TeamService, id: string) {
  const internal = teams as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };
  await internal.step(internal.record(id));
  await teams.idle();
}

/** The goal service's private pass for one goal. */
function goalStep(goals: GoalService, id: string) {
  const internal = goals as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };
  return internal.step(internal.record(id));
}

/** A Unix socket path must stay short, so the Manager's run directory sits directly under /tmp. */
const runDirs: string[] = [];
after(() => { for (const dir of runDirs) rmSync(dir, { recursive: true, force: true }); });
function shortRun(config: Fixture["config"]) {
  const runDir = mkdtempSync("/tmp/halt-run-");
  runDirs.push(runDir);
  return { ...config, runDir };
}

/** One queued implementer that the scheduler's next pass launches. */
function queueImplementer(f: Fixture) {
  const memberId = randomUUID();
  const queued = { ...f.run.members[0]!, memberId, sessionId: randomUUID(), role: "implementer" as const, title: "Implementer: a", taskId: "a",
    provider: "opencode" as const, modelProfile: mixedLineup.implementers[0]!, status: "queued" as const, cursor: 0, prompt: "Write a.txt" };
  f.run.members = [queued];
  f.run.lineup = mixedLineup; f.run.status = "implementing"; f.run.parallelism = 2;
  f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
  f.writeTeam();
}

/** Another run in the fixture's workspace, written as its own record. */
function writeRun(f: Fixture, extra: Partial<TeamRun>) {
  const run: TeamRun = { ...structuredClone(f.run), id: randomUUID(), members: [], ...extra };
  f.writeRecord("team", run.id, { run, prepared: true, fingerprint: "fixture", receipts: {} });
  return run.id;
}

function writeMission(f: Fixture, projectId: string, subtasks: unknown[] = [], id = randomUUID()) {
  const at = new Date().toISOString();
  const mission = {
    id, groupId: randomUUID(), groupName: "Group", repoProjectIds: [projectId], title: `Mission in ${projectId}`, objective: "Plan the work",
    maxSubtasks: 2, maxMinutes: 60, deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), revision: 1, status: "working",
    createdAt: at, updatedAt: at, lineup: { coordinator: mixedLineup.coordinator }, subtasks, decisions: [], events: [],
  } as unknown as Mission;
  const directory = join(f.config.stateDir, "missions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeSealed(join(directory, `${id}.sealed`), f.key, `mission:${id}`, {
    mission, fingerprint: "fixture", receipts: {}, folder: f.run.workspace, repos: [], attempts: [], inbox: [], notes: [], notified: [], launches: {}, ops: [], refusals: 0,
  });
  return id;
}

test("a halt holds a team launch ahead of the fuse, and the backstop refuses it as halted", async () => {
  const f = schedulerFixture();
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const fuse = new FuseService({ config: f.config, key: f.key, store, sessionExists: () => false });
  const halt = new HaltService({ config: f.config, key: f.key });
  const gate = halt.gate(fuse);
  try {
    queueImplementer(f);
    const teams = f.openTeam();
    teams.useFuse(gate);
    (f.manager as unknown as { list: () => Promise<unknown[]> }).list = async () => [];
    await halt.engage(hostScope, { requestId: randomUUID() }, owner);

    for (let pass = 0; pass < 3; pass++) await step(teams, f.run.id);
    assert.equal(f.launches.length, 0, "no session starts while the host is halted");
    const held = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
    assert.equal(held.reason, HOST_TEXT);
    assert.equal(held.members[0]!.status, "queued");
    assert.equal(fuse.view().host.hour.launches, 0, "a halted launch is not counted by the fuse");

    const manager = new Manager(shortRun(f.config), f.key);
    manager.useFuse(gate);
    const permissionCoordinator = { runId: f.run.id, memberId: randomUUID(), revision: 1, role: "permission-coordinator", taskId: "a" } as never;
    await assert.rejects(manager.createTeamSession({ requestId: randomUUID(), projectId: "fixture", provider: "demo", title: "Review", prompt: "Review" }, permissionCoordinator, f.run.workspace),
      (error: unknown) => error instanceof TeamError && error.code === "halted" && error.status === 409 && error.message === HOST_TEXT,
      "the backstop refuses every role, including one the fuse exempts");
    assert.equal(fuse.view().host.hour.launches, 0);

    await halt.release(hostScope, { requestId: randomUUID() }, owner);
    await step(teams, f.run.id);
    assert.equal(f.launches.length, 1, "the next pass after the release launches");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.reason, undefined);
    assert.equal(fuse.view().host.hour.launches, 1);
  } finally { halt.stop(); store.close(); f.close(); }
});

test("a project halt pauses running work in scope and its release resumes only what it paused", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  // A: the fixture's standalone run, planning with a running coordinator. B: paused by the owner. C: a goal's cycle.
  f.writeTeam();
  const standalone = f.run.id;
  const ownerPaused = writeRun(f, { title: "Owner paused", status: "paused", reason: "Paused by the owner." });
  const goalTeam = writeRun(f, { title: "Goal cycle", status: "implementing" });
  const goal = {
    id: randomUUID(), projectId: "fixture", title: "Improve the fixture", objective: "Choose scoped work", successCriteria: "Evidence",
    nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 1, revision: 1, status: "running",
    createdAt: at, updatedAt: at, deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup: mixedLineup, memberCount: 0,
    activeTeamId: goalTeam, cycles: [{ teamId: goalTeam, cycle: 1, goalRevision: 1, status: "implementing", startedAt: at, memberCount: 0 }],
    steering: [], events: [], outcomes: [],
  } as unknown as ProductGoal;
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  const mission = writeMission(f, "fixture");
  const elsewhere = writeMission(f, "other");

  const teams = f.openTeam();
  const goals = new GoalService(f.config, f.key, teams);
  const manager = { meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); }, hostLoad: { held: () => undefined } } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  const missionOf = (id: string) => (missions as unknown as { records: Map<string, { mission: Mission; ownerHalt?: unknown }> }).records.get(id)!;
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals, missions, teams }, id => goals.ownsActiveTeam(id) || missions.ownsActiveSubteam(id));
  const gate = halt.gate(openFuse);
  try {
    const engageId = randomUUID();
    const engaged = await halt.engage(fixtureScope, { requestId: engageId, reason: "Checking spend" }, owner);
    assert.equal(engaged.engaged, true);
    assert.deepEqual(engaged.paused.map(item => `${item.kind}:${item.id}`), [`goal:${goal.id}`, `mission:${mission}`, `team:${standalone}`],
      "routines, goals, missions, then runs that no goal or mission owns");
    assert.deepEqual(engaged.failed, []);
    assert.equal(gate.check({ projectId: "fixture" }).state, "halted");
    assert.equal(gate.check({ projectId: "other" }).state, "closed", "another project's launches pass to the fuse");
    assert.equal(gate.held?.(["other", "fixture"])?.state, "halted", "work that spans a halted project is held");

    assert.equal(teams.get(standalone).status, "paused");
    assert.equal(teams.get(ownerPaused).reason, "Paused by the owner.", "an owner-paused run is not touched");
    assert.equal(teams.get(goalTeam).status, "implementing", "the goal pauses its own team");
    assert.equal(goals.get(goal.id).status, "paused");
    assert.equal(goals.get(goal.id).reason, PROJECT_TEXT);
    assert.equal(missionOf(mission).mission.status, "paused");
    assert.equal(missionOf(elsewhere).mission.status, "working", "a mission in another project keeps running");

    // The stopped members settle, and the goal delivers its pause to its team.
    await step(teams, standalone);
    assert.equal(teams.get(standalone).reason, PROJECT_TEXT, "the paused run still says why after its members stop");
    await goalStep(goals, goal.id);
    assert.equal(teams.get(goalTeam).status, "paused");
    await step(teams, goalTeam);

    const replayed = await halt.engage(fixtureScope, { requestId: engageId, reason: "Checking spend" }, owner);
    assert.deepEqual(replayed.paused, engaged.paused, "a replayed engage returns the first result");

    const releaseId = randomUUID();
    const released = await halt.release(fixtureScope, { requestId: releaseId }, owner);
    assert.equal(released.released, true);
    assert.deepEqual(released.resumed.map(item => `${item.kind}:${item.id}`), [`team:${standalone}`, `mission:${mission}`, `goal:${goal.id}`],
      "a release resumes in reverse order");
    assert.deepEqual(released.notResumed, []);
    assert.equal(gate.check({ projectId: "fixture" }).state, "closed");
    assert.equal(teams.get(standalone).status, "planning");
    assert.equal(teams.get(ownerPaused).status, "paused", "a release never resumes what the owner paused");
    assert.notEqual(missionOf(mission).mission.status, "paused");
    assert.equal(missionOf(mission).ownerHalt, undefined);
    assert.equal(goals.get(goal.id).status, "running");
    await goalStep(goals, goal.id);
    assert.equal(teams.get(goalTeam).status, "planning", "the goal resumes its own team");

    const standaloneRevision = teams.get(standalone).revision;
    assert.deepEqual((await halt.release(fixtureScope, { requestId: releaseId }, owner)).resumed, released.resumed, "a replayed release returns the first result");
    assert.equal(teams.get(standalone).revision, standaloneRevision, "and resumes nothing twice");
    assert.equal((await halt.engage(fixtureScope, { requestId: engageId, reason: "Checking spend" }, owner)).engaged, true);
    assert.deepEqual(halt.view().projects, [], "a replayed engage after the release does not halt again");
    await assert.rejects(halt.engage(fixtureScope, { requestId: engageId }, owner),
      (error: unknown) => error instanceof TeamError && error.code === "request-conflict");
  } finally { halt.stop(); goals.close(); missions.close(); f.close(); }
});

test("a halt survives a restart, finishes an interrupted pass, and fails closed when unreadable", async () => {
  const f = schedulerFixture();
  try {
    f.writeTeam();
    const teams = f.openTeam();
    const services = { routines: noRoutines, goals: noRoutines, missions: noRoutines, teams };

    // A host stopped after the halt was written and before any item was paused.
    const haltId = randomUUID(), requestId = randomUUID(), at = Date.now();
    assert.ok(writeHaltRecord(join(f.config.stateDir, HALT_FILE), f.key, {
      version: 1,
      halts: [{ haltId, scope: "host", at, requestId, by: owner, settled: false }],
      receipts: [{ requestId, action: "engage", fingerprint: "0".repeat(64), haltId, changed: true, at, by: owner, settled: false, outcomes: [] }],
    }));
    const restarted = new HaltService({ config: f.config, key: f.key });
    assert.equal(restarted.check({ projectId: "fixture" }).state, "halted", "the gate holds before the pass finishes");
    restarted.useServices(services, () => false);
    await restarted.start();
    restarted.stop();
    assert.equal(teams.get(f.run.id).status, "paused", "start finishes the interrupted pass");
    await step(teams, f.run.id);

    const again = new HaltService({ config: f.config, key: f.key });
    again.useServices(services, () => false);
    assert.equal(again.view().host?.by, owner.label);
    const kept = await again.release(hostScope, { requestId: randomUUID(), keepPaused: true }, owner);
    assert.equal(kept.released, true);
    assert.deepEqual(kept.resumed, []);
    assert.deepEqual(kept.notResumed.map(item => [item.id, item.reason]), [[f.run.id, KEPT_PAUSED]]);
    assert.equal(again.check({ projectId: "fixture" }).state, "clear");
    assert.equal(teams.get(f.run.id).status, "paused");
    assert.equal(teams.get(f.run.id).reason, KEPT_PAUSED, "a kept item no longer claims a halt");

    writeFileSync(join(f.config.stateDir, HALT_FILE), "not a sealed record");
    const unreadable = new HaltService({ config: f.config, key: f.key });
    const held = unreadable.check({ projectId: "fixture" });
    assert.equal(held.state === "halted" && held.unreadable, true, "an unreadable record halts the whole host");
    assert.equal(unreadable.gate(openFuse).admit({ launchId: randomUUID(), projectId: "fixture", purpose: "work", role: "implementer", profileId: "p" }).ok, false);
    assert.equal(unreadable.view().readable, false);
    await assert.rejects(unreadable.release(hostScope, { requestId: randomUUID() }, owner),
      (error: unknown) => error instanceof TeamError && error.code === "halt-unreadable");
  } finally { f.close(); }
});

test("the halt count keeps every engaged halt after its release and after its receipt is dropped, and a restart reads it", async () => {
  const f = schedulerFixture();
  const halt = new HaltService({ config: f.config, key: f.key });
  try {
    assert.deepEqual(halt.engagements(), { count: 0, halts: [] });
    const project = await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    const host = await halt.engage(hostScope, { requestId: randomUUID() }, owner);
    await halt.engage(hostScope, { requestId: randomUUID() }, owner);
    const projectId = project.halt.projects[0]!.haltId, hostId = host.halt.host!.haltId;
    const generation = halt.engagements()!.generation!;
    assert.match(generation, /^[0-9a-f-]{36}$/, "the record's first write gives it its generation");
    assert.deepEqual(halt.engagements(), { generation, count: 2, halts: [{ haltId: projectId, projectId: "fixture", serial: 1 }, { haltId: hostId, serial: 2 }] },
      "an engage that found the scope halted counts nothing");
    await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    await halt.release(hostScope, { requestId: randomUUID() }, owner);
    // Accepted requests that change nothing push the engaging receipts out of the record; the count stays.
    for (let index = 0; index < MAX_RECEIPTS; index++) await halt.release(hostScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(halt.engagements(), { generation, count: 2, halts: [] });
    halt.stop();
    assert.deepEqual(new HaltService({ config: f.config, key: f.key }).engagements(), { generation, count: 2, halts: [] });
    // A removed record starts again from zero under a new generation.
    rmSync(join(f.config.stateDir, HALT_FILE));
    const fresh = new HaltService({ config: f.config, key: f.key });
    assert.deepEqual(fresh.engagements(), { count: 0, halts: [] });
    await fresh.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.equal(fresh.engagements()!.count, 1);
    assert.notEqual(fresh.engagements()!.generation, generation);
    fresh.stop();
  } finally { halt.stop(); f.close(); }
});

test("any device reads the halt; only the owner engages or releases it", async () => {
  const host = await inProcessHost();
  try {
    assert.deepEqual((await host.fetchApi("/halt", "viewer")).body, { readable: true, projects: [] });
    const engage = { requestId: randomUUID(), scope: "host", reason: "Reviewing costs" };
    for (const role of ["viewer", "controller"] as const) assert.equal((await host.fetchApi("/halt", role, engage)).status, 403);
    assert.equal((await host.fetchApi("/halt", "owner", { requestId: randomUUID(), scope: "project", projectId: "missing" })).status, 404);

    const engaged = await host.fetchApi("/halt", "owner", engage);
    assert.equal(engaged.status, 200, JSON.stringify(engaged.body));
    assert.equal(engaged.body.engaged, true);
    const seen = (await host.fetchApi("/halt", "viewer")).body;
    assert.equal(seen.host.reason, "Reviewing costs");
    assert.equal(seen.host.by, "owner");

    const release = { requestId: randomUUID(), scope: "host" };
    assert.equal((await host.fetchApi("/halt/release", "controller", release)).status, 403);
    const released = await host.fetchApi("/halt/release", "owner", release);
    assert.equal(released.status, 200);
    assert.equal(released.body.released, true);
    assert.equal((await host.fetchApi("/halt/release", "owner", { ...release, keepPaused: true })).status, 409, "a request ID is bound to its body");
  } finally { await host.stop(); }
});

test("a coordinator for several projects is refused at final admission when one is halted, and the fuse gives its admission back", async () => {
  const f = schedulerFixture();
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const fuse = new FuseService({ config: f.config, key: f.key, store, sessionExists: () => false });
  const halt = new HaltService({ config: f.config, key: f.key });
  const gate = halt.gate(fuse);
  const manager = new Manager(shortRun(f.config), f.key);
  manager.useFuse(gate);
  const teams = { useMissionReservations() {}, isActiveRun() { return false; } } as unknown as TeamService;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  missions.useFuse(gate);
  try {
    // 29 earlier launches, so this coordinator's admission is the 30th and opens a project trip.
    for (let i = 0; i < 29; i++) fuse.admit({ launchId: `earlier-${i}`, projectId: "fixture", purpose: "work", role: "implementer", profileId: "p" });
    const at = new Date().toISOString();
    const mission = {
      id: randomUUID(), title: "Two repositories", status: "working", revision: 1, repoProjectIds: ["fixture", "other"], events: [], subtasks: [], decisions: [],
      lineup: { coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" } },
      deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), createdAt: at, updatedAt: at,
    } as unknown as Mission;
    const attempt = { memberId: randomUUID(), sessionId: randomUUID(), revision: 1, prompt: "Plan the mission", cursor: 0, stopRequestId: randomUUID(), status: "queued", ownerInputs: 0 };
    const stored = { mission, fingerprint: "fixture", receipts: {}, folder: f.run.workspace, repos: [], attempts: [attempt], inbox: [], notes: [], notified: [], launches: {}, ops: [], refusals: 0 };
    (missions as unknown as { records: Map<string, unknown> }).records.set(mission.id, stored);

    // The scheduler admits the launch; the owner halts the second repository while the Manager reads its sessions.
    let openWhileWaiting: string | undefined;
    (manager as unknown as { list: () => Promise<unknown[]> }).list = async () => {
      openWhileWaiting = fuse.check({ projectId: "fixture" }).state;
      await halt.engage({ scope: "project", projectId: "other" }, { requestId: randomUUID() }, owner);
      return [];
    };
    await (missions as unknown as { launch(stored: unknown, attempt: unknown): Promise<void> }).launch(stored, attempt);

    assert.equal(openWhileWaiting, "open", "the admission counted and opened a trip before the halt");
    assert.equal(existsSync(join(f.config.stateDir, "sessions", attempt.sessionId)), false, "no coordinator session starts");
    assert.equal(attempt.status, "queued");
    assert.equal(fuse.view().projects.find(project => project.projectId === "fixture")?.hour.launches, 29, "the refused launch is not counted");
    assert.equal(fuse.check({ projectId: "fixture" }).state, "closed", "the trip that only this admission opened is gone");
    const baseline = readBaseline(join(f.config.stateDir, BASELINE_FILE), f.key)!;
    assert.equal(baseline.launches.some(launch => launch.launchId === attempt.sessionId), false);
    assert.deepEqual(baseline.trips.filter(trip => trip.closedAt === undefined), []);
  } finally { halt.stop(); missions.close(); store.close(); f.close(); }
});

test("a record that becomes readable again finishes the pass it left unsettled", async () => {
  const f = schedulerFixture();
  try {
    f.writeTeam();
    const teams = f.openTeam();
    const file = join(f.config.stateDir, HALT_FILE);
    writeFileSync(file, "not a sealed record");
    const halt = new HaltService({ config: f.config, key: f.key, retryMs: 20 });
    halt.useServices({ routines: noRoutines, goals: noRoutines, missions: noRoutines, teams }, () => false);
    await halt.start();
    assert.equal(halt.view().readable, false);
    assert.equal(teams.get(f.run.id).status, "planning");

    // The owner restores a record whose engage was written but whose pause pass never ran.
    const haltId = randomUUID(), requestId = randomUUID(), at = Date.now();
    assert.ok(writeHaltRecord(file, f.key, {
      version: 1,
      halts: [{ haltId, scope: "host", at, requestId, by: owner, settled: false }],
      receipts: [{ requestId, action: "engage", fingerprint: "0".repeat(64), haltId, changed: true, at, by: owner, settled: false, outcomes: [] }],
    }));
    await waitFor(async () => teams.get(f.run.id).status, status => status === "paused", 5000);
    halt.stop();
    assert.equal(teams.get(f.run.id).reason, HOST_TEXT);
    await waitFor(async () => new HaltService({ config: f.config, key: f.key }).view(), view => view.readable && view.host !== undefined, 5000);
  } finally { f.close(); }
});

test("a mission halt pauses only working subteams and resumes only the ones it paused", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const child = (status: TeamRun["status"]) => writeRun(f, { status, missionId, title: `Subteam ${status}` } as Partial<TeamRun>);
  const working = child("implementing"), waiting = child("needs-input"), turning = child("implementing");
  const subtask = (id: string, teamId: string) => ({ id, title: id, instructions: id, repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId });
  writeMission(f, "fixture", [subtask("a", working), subtask("b", waiting), subtask("c", turning)], missionId);
  const teams = f.openTeam();
  const manager = { meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); }, hostLoad: { held: () => undefined } } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  const records = (missions as unknown as { records: Map<string, { mission: Mission; ops: { kind: string; teamId: string }[]; ownerHalt?: { children: string[] } }> }).records;
  const stored = [...records.values()][0]!;
  const applyOps = () => (missions as unknown as { applyOps(stored: unknown): Promise<void> }).applyOps(stored);
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions, teams }, id => missions.ownsActiveSubteam(id));
  try {
    const engaged = await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused.map(item => item.kind), ["mission"], "the mission pauses its own subteams");
    assert.deepEqual(stored.ops.map(op => `${op.kind}:${op.teamId}`), [`pause:${working}`, `pause:${turning}`], "no pause for a subteam waiting for input");

    // One subteam starts waiting for input before the mission delivers its pause.
    (teams as unknown as { record(id: string): { run: TeamRun } }).record(turning).run.status = "needs-input";
    await applyOps();
    assert.equal(teams.get(working).status, "paused");
    assert.equal(teams.get(waiting).status, "needs-input");
    assert.equal(teams.get(turning).status, "needs-input", "a pause never reaches a subteam that now waits for input");
    assert.deepEqual(stored.ownerHalt?.children, [working]);
    await step(teams, working);

    const revisions = { waiting: teams.get(waiting).revision, turning: teams.get(turning).revision };
    const released = await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => item.kind), ["mission"]);
    assert.deepEqual(stored.ops.map(op => `${op.kind}:${op.teamId}`), [`resume:${working}`], "only the subteam the halt paused resumes");
    await applyOps();
    assert.equal(teams.get(working).status, "planning");
    assert.equal(teams.get(waiting).status, "needs-input");
    assert.equal(teams.get(turning).status, "needs-input");
    assert.deepEqual({ waiting: teams.get(waiting).revision, turning: teams.get(turning).revision }, revisions, "neither waiting subteam replans");
  } finally { halt.stop(); missions.close(); f.close(); }
});

test("a routine pauses and resumes under a halt, and host and project halts overlap in either order", async () => {
  const root = mkdtempSync(join(tmpdir(), "halt-routine-"));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const config = {
    stateDir, projects: [{ id: "demo", name: "Demo", path: root, team: { checks: [{ command: "node", args: ["check.js"] }] } }],
    teams: { lineup: reviewedLineup, trustWorkspaces: true, commandPrefix: { command: "safe", args: [] } }, agents: { claude: { command: "claude", args: [] } },
  } as unknown as Config;
  const key = Buffer.alloc(32, 7);
  const started: CreateGoal[] = [];
  const hooks = {
    isProjectBusy: async () => false,
    startGoal: async (request: CreateGoal, admit: () => void) => {
      admit(); started.push(structuredClone(request));
      return { ...request, id: request.requestId, status: "running", cycles: [] } as unknown as ProductGoal;
    },
  };
  const goalStub = { get: () => { throw new TeamError(404, "goal-not-found", "missing"); } } as never;
  const routines = new RoutineService(config, key, goalStub, hooks);
  const halt = new HaltService({ config, key });
  halt.useServices({ routines, goals: noRoutines, missions: noRoutines, teams: noRoutines }, () => false);
  routines.useFuse(halt.gate(openFuse));
  const demo = { scope: "project", projectId: "demo" } as const;
  const request: CreateRoutine = { requestId: randomUUID(), goal: { projectId: "demo", title: "Small task", objective: "Do the bounded work", successCriteria: "The requested change is available", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 },
    intervalMinutes: 5, maxOccurrences: 2, startsAt: new Date(Date.now() + 1500).toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  const engage = (target: typeof hostScope | typeof demo) => halt.engage(target, { requestId: randomUUID() }, owner);
  const release = (target: typeof hostScope | typeof demo) => halt.release(target, { requestId: randomUUID() }, owner);
  try {
    const routine = await routines.create(request);
    await new Promise(resolve => setTimeout(resolve, Date.parse(request.startsAt) - Date.now() + 20));

    // Project, then host: releasing the project leaves the routine under the host halt.
    assert.deepEqual((await engage(demo)).paused.map(item => item.id), [routine.id]);
    assert.equal(routines.get(routine.id).status, "paused");
    assert.deepEqual((await engage(hostScope)).paused, [], "an item already paused is not paused again");
    await routines.tick();
    assert.equal(started.length, 0, "a paused routine starts nothing");
    const first = await release(demo);
    assert.deepEqual(first.notResumed.map(item => item.reason), ["Another halt still covers it."]);
    assert.equal(routines.get(routine.id).reason, HOST_TEXT);
    assert.deepEqual((await release(hostScope)).resumed.map(item => item.id), [routine.id]);
    assert.equal(routines.get(routine.id).status, "scheduled");

    // Host, then project: releasing the host leaves the routine under the project halt.
    await engage(hostScope);
    await engage(demo);
    await release(hostScope);
    assert.equal(routines.get(routine.id).status, "paused");
    assert.equal(routines.get(routine.id).reason, PROJECT_TEXT);
    assert.deepEqual((await release(demo)).resumed.map(item => item.id), [routine.id]);
    await routines.tick();
    assert.equal(started.length, 1, "the routine starts its goal once no halt covers it");
  } finally { halt.stop(); routines.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a subteam's halt pause and resume are decided in its own queue, and the owner's later actions win", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const child = (title: string) => writeRun(f, { status: "implementing", missionId, title } as Partial<TeamRun>);
  const ownerPaused = child("Owner pauses it"), ownerCycled = child("Owner resumes then pauses it"), turning = child("Turns to input");
  const subtask = (id: string, teamId: string) => ({ id, title: id, instructions: id, repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId });
  writeMission(f, "fixture", [subtask("a", ownerPaused), subtask("b", ownerCycled), subtask("c", turning)], missionId);
  const teams = f.openTeam();
  const internal = teams as unknown as { record(id: string): { run: TeamRun }; enqueue<T>(task: () => Promise<T>): Promise<T> };
  const manager = { meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); }, hostLoad: { held: () => undefined } } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  const stored = [...(missions as unknown as { records: Map<string, { ops: { kind: string; teamId: string }[]; ownerHalt?: { children: string[] } }> }).records.values()][0]!;
  const applyOps = () => (missions as unknown as { applyOps(stored: unknown): Promise<void> }).applyOps(stored);
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions, teams }, id => missions.ownsActiveSubteam(id));
  const ownerAction = (id: string, action: "pause" | "resume") => teams[action](id, { requestId: randomUUID(), revision: teams.get(id).revision });
  try {
    await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(stored.ops.map(op => op.teamId), [ownerPaused, ownerCycled, turning], "every subteam was working when the mission read it");

    // (c) A team pass already in the queue finds pending input before the halt's pause reaches the team.
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const tick = internal.enqueue(async () => { await gate; internal.record(turning).run.status = "needs-input"; });
    const turningRevision = teams.get(turning).revision;
    const delivered = applyOps();
    await new Promise(resolve => setTimeout(resolve, 20));
    open();
    await tick; await delivered;
    assert.equal(teams.get(turning).status, "needs-input", "a subteam waiting for input is not paused");
    assert.deepEqual(stored.ownerHalt?.children, [ownerPaused, ownerCycled], "and is not recorded");
    await step(teams, ownerPaused); await step(teams, ownerCycled);

    // (a) The owner pauses a subteam the halt paused.
    await ownerAction(ownerPaused, "pause");
    await step(teams, ownerPaused);
    await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(stored.ops.map(op => `${op.kind}:${op.teamId}`), [`resume:${ownerPaused}`, `resume:${ownerCycled}`]);

    // (b) Before the queued resumes are delivered, the owner resumes one subteam and pauses it again.
    await ownerAction(ownerCycled, "resume");
    await ownerAction(ownerCycled, "pause");
    await step(teams, ownerCycled);
    const revisions = [ownerPaused, ownerCycled].map(id => teams.get(id).revision);
    await applyOps();
    assert.equal(teams.get(ownerPaused).status, "paused", "the owner's pause outlasts the release");
    assert.equal(teams.get(ownerCycled).status, "paused", "a newer owner pause is not overridden by the queued resume");
    assert.deepEqual([ownerPaused, ownerCycled].map(id => teams.get(id).revision), revisions, "neither replans");
    assert.equal(teams.get(turning).status, "needs-input");
    assert.equal(teams.get(turning).revision, turningRevision, "the waiting subteam does not replan on release");
  } finally { halt.stop(); missions.close(); f.close(); }
});

/** A mission with one working subteam, and the halt and mission services over it, opened from the records on disk. */
function missionWithSubteam(f: Fixture, missionId: string) {
  const teams = f.openTeam();
  const manager = { meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); }, hostLoad: { held: () => undefined } } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  const stored = (missions as unknown as { records: Map<string, { ops: { kind: string; teamId: string; halt?: unknown }[]; ownerHalt?: { token: string; children: string[] } }> }).records.get(missionId)!;
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions, teams }, id => missions.ownsActiveSubteam(id));
  return { teams, missions, halt, stored, applyOps: () => (missions as unknown as { applyOps(stored: unknown): Promise<void> }).applyOps(stored), close: () => { halt.stop(); missions.close(); } };
}

test("a subteam's first paused record carries the halt's mark, so a restart keeps it and the release resumes it", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID(), teamId = writeRun(f, { status: "implementing", missionId, title: "Subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [{ id: "a", title: "a", instructions: "a", repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId }], missionId);
  const first = missionWithSubteam(f, missionId);
  let second: ReturnType<typeof missionWithSubteam> | undefined;
  try {
    await first.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    // The host stops right after the pause path writes the subteam's first paused record.
    const internal = first.teams as unknown as { save(stored: { run: TeamRun }): void };
    const save = internal.save.bind(first.teams);
    internal.save = stored => { save(stored); if (stored.run.id === teamId && stored.run.status === "paused") throw new Error("The host stopped."); };
    await assert.rejects(first.applyOps(), /The host stopped/);
    const durable = f.readRecord<{ run: TeamRun; ownerHalt?: { haltId?: string } }>("team", teamId);
    assert.equal(durable.run.status, "paused");
    assert.equal(durable.ownerHalt?.haltId, first.stored.ownerHalt?.token, "the first paused record already carries the halt's mark");
    first.close();

    second = missionWithSubteam(f, missionId);
    await second.applyOps();
    assert.deepEqual(second.stored.ownerHalt?.children, [teamId], "the replayed pause finds its mark and is recorded");
    await step(second.teams, teamId);
    await second.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    await second.applyOps();
    assert.equal(second.teams.get(teamId).status, "planning", "the release resumes the subteam");
  } finally { first.close(); second?.close(); f.close(); }
});

test("a release that ends a mission's halt mark retires the halt's undelivered pauses", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID(), teamId = writeRun(f, { status: "implementing", missionId, title: "Subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [{ id: "a", title: "a", instructions: "a", repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId }], missionId);
  const { teams, halt, applyOps, close } = missionWithSubteam(f, missionId);
  const ownerAction = (action: "pause" | "resume") => teams[action](teamId, { requestId: randomUUID(), revision: teams.get(teamId).revision });
  try {
    await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    // The owner releases and keeps the mission paused before its pause reaches the subteam, then pauses and resumes the subteam.
    await halt.release(fixtureScope, { requestId: randomUUID(), keepPaused: true }, owner);
    await ownerAction("pause"); await step(teams, teamId); await ownerAction("resume");
    await applyOps(); await step(teams, teamId);
    assert.equal(teams.get(teamId).status, "paused", "the kept mission pauses its subteam the way the owner's pause of a mission does");
    assert.equal(teams.get(teamId).reason, undefined, "no halt claims the pause once the halt is off");
  } finally { close(); f.close(); }
});
