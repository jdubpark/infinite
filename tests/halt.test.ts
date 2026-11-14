import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import type { FuseGate } from "../packages/host/src/fuse/types.js";
import { GoalService } from "../packages/host/src/goals.js";
import { HALT_FILE, writeHaltRecord } from "../packages/host/src/halt/record.js";
import { KEPT_PAUSED, type HaltTargets } from "../packages/host/src/halt/rules.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import { Manager } from "../packages/host/src/manager.js";
import { MissionService } from "../packages/host/src/missions.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { inProcessHost } from "./helpers.js";
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

function writeMission(f: Fixture, projectId: string) {
  const at = new Date().toISOString(), id = randomUUID();
  const mission = {
    id, groupId: randomUUID(), groupName: "Group", repoProjectIds: [projectId], title: `Mission in ${projectId}`, objective: "Plan the work",
    maxSubtasks: 2, maxMinutes: 60, deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), revision: 1, status: "working",
    createdAt: at, updatedAt: at, lineup: { coordinator: mixedLineup.coordinator }, subtasks: [], decisions: [], events: [],
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
