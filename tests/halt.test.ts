import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { BASELINE_FILE, readBaseline } from "../packages/host/src/fuse/baseline.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import type { FuseGate } from "../packages/host/src/fuse/types.js";
import { GoalService } from "../packages/host/src/goals.js";
import { HALT_EPOCHS_FILE, HALT_FILE, MAX_RECEIPTS, writeHaltRecord } from "../packages/host/src/halt/record.js";
import { KEPT_PAUSED, type HaltTargets } from "../packages/host/src/halt/rules.js";
import { RoutineService } from "../packages/host/src/routines.js";
import { HaltService } from "../packages/host/src/halt/service.js";
import { Manager } from "../packages/host/src/manager.js";
import { MissionService } from "../packages/host/src/missions.js";
import { buildDecisionQueue } from "../packages/host/src/decision-queue.js";
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

function teamDecisionQueue(teams: TeamService, goals: GoalService) {
  return buildDecisionQueue({ sessions: [], missions: [], teams: teams.decisionQueueCandidates().map(candidate => ({ ...candidate,
    goalCanAnswer: !candidate.goal || goals.decisionAnswerable(candidate.id, candidate.held) })) });
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

/** A run whose coordinator asked the owner a question and stopped to wait for the answer. */
function waitingRun(f: Fixture, extra: Partial<TeamRun> = {}) {
  const memberId = randomUUID();
  const member = { ...f.run.members[0]!, memberId, sessionId: randomUUID(), status: "waiting" as const };
  const decision = { id: randomUUID(), memberId, revision: 1, question: "Which file should change?", options: ["a.txt", "b.txt"], createdAt: new Date().toISOString() };
  return { id: writeRun(f, { status: "needs-input", members: [member], decisions: [decision], ...extra }), decisionId: decision.id };
}

/** A running goal whose active cycle is this team run. */
function writeGoal(f: Fixture, teamId: string, status: "running" | "needs-input" = "running", id = randomUUID()) {
  const at = new Date().toISOString();
  const goal = {
    id, projectId: "fixture", title: `Goal over ${teamId}`, objective: "Choose scoped work", successCriteria: "Evidence",
    nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 1, revision: 1, status,
    createdAt: at, updatedAt: at, deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup: mixedLineup, memberCount: 0,
    activeTeamId: teamId, cycles: [{ teamId, cycle: 1, goalRevision: 1, status: "implementing", startedAt: at, memberCount: 0 }],
    steering: [], events: [], outcomes: [],
  } as unknown as ProductGoal;
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  return goal.id;
}

function writeMission(f: Fixture, projectId: string, subtasks: unknown[] = [], id = randomUUID(), extra: Record<string, unknown> = {}, record: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  const mission = {
    id, groupId: randomUUID(), groupName: "Group", repoProjectIds: [projectId], title: `Mission in ${projectId}`, objective: "Plan the work",
    maxSubtasks: 2, maxMinutes: 60, deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), revision: 1, status: "working",
    createdAt: at, updatedAt: at, lineup: { coordinator: mixedLineup.coordinator }, subtasks, decisions: [], events: [], ...extra,
  } as unknown as Mission;
  const directory = join(f.config.stateDir, "missions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeSealed(join(directory, `${id}.sealed`), f.key, `mission:${id}`, {
    mission, fingerprint: "fixture", receipts: {}, folder: f.run.workspace, repos: [], attempts: [], inbox: [], notes: [], notified: [], launches: {}, ops: [], refusals: 0, ...record,
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
  const ownerPaused = writeRun(f, { title: "Owner paused", status: "paused", reason: "Paused by the owner.",
    decisions: [{ id: randomUUID(), memberId: f.run.members[0]!.memberId, revision: 1, question: "Which file?", options: ["a", "b"], createdAt: at }] });
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
  assert.deepEqual(teamDecisionQueue(teams, goals).decisions, [], "an ordinary owner-paused run cannot take its unanswered decision");
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

test("halt epochs live apart from the halt record: each engage and release renews its scope's, and a restored or removed record keeps them", async () => {
  const f = schedulerFixture();
  const halt = new HaltService({ config: f.config, key: f.key });
  const recordFile = join(f.config.stateDir, HALT_FILE), epochsFile = join(f.config.stateDir, HALT_EPOCHS_FILE);
  const open = () => new HaltService({ config: f.config, key: f.key });
  const request = () => ({ requestId: randomUUID() });
  try {
    const start = halt.epoch("fixture"), other = halt.epoch("other");
    assert.ok(start && other);
    await halt.engage(fixtureScope, request(), owner);
    const engaged = halt.epoch("fixture");
    assert.notEqual(engaged, start);
    assert.equal(halt.epoch("other"), other, "a project halt leaves other projects' epochs");
    const copy = readFileSync(recordFile, "utf8");
    await halt.engage(fixtureScope, request(), owner);
    assert.equal(halt.epoch("fixture"), engaged, "an engage that found the scope halted changes nothing");
    await halt.release(fixtureScope, request(), owner);
    const released = halt.epoch("fixture");
    assert.notEqual(released, engaged);
    await halt.release(fixtureScope, request(), owner);
    assert.equal(halt.epoch("fixture"), released, "a release that found no halt changes nothing");
    await halt.engage(hostScope, request(), owner);
    assert.notEqual(halt.epoch("other"), other, "a host halt covers every project");
    assert.notEqual(halt.epoch("fixture"), released);
    await halt.release(hostScope, request(), owner);
    const current = halt.epoch("fixture");
    // Accepted requests that change nothing push the engaging receipts out of the record; the epochs stay.
    for (let index = 0; index < MAX_RECEIPTS; index++) await halt.release(hostScope, request(), owner);
    assert.equal(halt.epoch("fixture"), current);
    halt.stop();
    const restarted = open();
    assert.equal(restarted.epoch("fixture"), current, "a restart keeps the epochs");
    restarted.stop();
    // An older copy of the record is restored: its halt is in force again, and its release renews the epoch.
    writeFileSync(recordFile, copy, { mode: 0o600 });
    const restored = open();
    assert.equal(restored.epoch("fixture"), current);
    assert.equal(restored.check({ projectId: "fixture" }).state, "halted");
    await restored.release(fixtureScope, request(), owner);
    const afterRestore = restored.epoch("fixture");
    assert.notEqual(afterRestore, current);
    restored.stop();
    rmSync(recordFile);
    const removed = open();
    assert.equal(removed.epoch("fixture"), afterRestore, "a removed record keeps the epochs");
    removed.stop();
    // A removed epochs file gets a new host epoch: no earlier epoch comes back.
    rmSync(epochsFile);
    const renewed = open().epoch("fixture");
    assert.ok(renewed);
    assert.ok(![start, engaged, released, current, afterRestore].includes(renewed));
    // Epochs that cannot be read leave every epoch unknown until a halt change writes new ones; so does an unreadable record.
    writeFileSync(epochsFile, "not sealed epochs", { mode: 0o600 });
    const reset = open();
    assert.equal(reset.epoch("fixture"), undefined);
    await reset.engage(fixtureScope, request(), owner);
    const rewritten = reset.epoch("fixture");
    assert.ok(rewritten && rewritten !== renewed);
    reset.stop();
    writeFileSync(recordFile, "not a sealed record");
    assert.equal(open().epoch("fixture"), undefined);
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

test("a mission halt pauses its working and waiting subteams, and its release resumes each as it was paused", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const child = (status: TeamRun["status"]) => writeRun(f, { status, missionId, title: `Subteam ${status}` } as Partial<TeamRun>);
  const working = child("implementing"), turning = child("implementing");
  const waiting = waitingRun(f, { missionId, title: "Subteam needs-input" } as Partial<TeamRun>);
  const subtask = (id: string, teamId: string) => ({ id, title: id, instructions: id, repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId });
  writeMission(f, "fixture", [subtask("a", working), subtask("b", waiting.id), subtask("c", turning)], missionId);
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
    assert.deepEqual(stored.ops.map(op => `${op.kind}:${op.teamId}`), [`pause:${working}`, `pause:${waiting.id}`, `pause:${turning}`],
      "a subteam waiting for input is paused too");

    // One subteam starts waiting for input before the mission delivers its pause.
    (teams as unknown as { record(id: string): { run: TeamRun } }).record(turning).run.status = "needs-input";
    await applyOps();
    for (const id of [working, waiting.id, turning]) {
      assert.equal(teams.get(id).status, "paused");
      assert.equal(teams.get(id).reason, PROJECT_TEXT);
    }
    assert.deepEqual(stored.ownerHalt?.children, [working, waiting.id, turning]);
    await step(teams, working);

    const revisions = { waiting: teams.get(waiting.id).revision, turning: teams.get(turning).revision };
    const released = await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => item.kind), ["mission"]);
    assert.deepEqual(stored.ops.map(op => `${op.kind}:${op.teamId}`), [`resume:${working}`, `resume:${waiting.id}`, `resume:${turning}`]);
    await applyOps();
    assert.equal(teams.get(working).status, "planning", "a working subteam resumes with a fresh plan");
    assert.equal(teams.get(waiting.id).status, "needs-input", "a waiting subteam resumes where it waited");
    assert.equal(teams.get(turning).status, "needs-input");
    assert.deepEqual({ waiting: teams.get(waiting.id).revision, turning: teams.get(turning).revision }, revisions, "neither waiting subteam replans");
    assert.equal(teams.get(waiting.id).decisions[0]!.answer, undefined, "its question is still open");
  } finally { halt.stop(); missions.close(); f.close(); }
});

test("a halt pauses a run that waits for input where it stands: an answer during the halt starts nothing, and the release keeps the question", async () => {
  const f = schedulerFixture();
  const answered = waitingRun(f), open = waitingRun(f);
  const teams = f.openTeam();
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions: noRoutines, teams }, () => false);
  const both = [answered.id, open.id].sort();
  try {
    const engaged = await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused.map(item => item.id).sort(), both, "a run waiting for input is paused");
    for (const id of both) {
      assert.equal(teams.get(id).status, "paused");
      assert.equal(teams.get(id).reason, PROJECT_TEXT);
      assert.equal(teams.get(id).revision, 1);
    }

    // The owner answers one question during the halt: the answer is kept, and nothing starts.
    await teams.answer(answered.id, answered.decisionId, { requestId: randomUUID(), revision: 1, text: "Change a.txt" });
    for (let pass = 0; pass < 2; pass++) await step(teams, answered.id);
    assert.equal(f.launches.length, 0, "an answer given during the halt starts nothing");
    assert.equal(teams.get(answered.id).members.length, 1, "no replacement is queued");
    assert.equal(teams.get(answered.id).status, "paused");
    assert.equal(teams.get(answered.id).reason, PROJECT_TEXT);

    const released = await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => item.id).sort(), both);
    for (const id of both) {
      assert.equal(teams.get(id).status, "needs-input", "the release resumes the run where it waited");
      assert.equal(teams.get(id).revision, 1, "without a fresh plan");
      assert.equal(teams.get(id).reason, undefined);
    }
    assert.equal(teams.get(answered.id).decisions[0]!.answer, "Change a.txt", "the answer given during the halt is kept");
    assert.equal(teams.get(open.id).decisions[0]!.answer, undefined, "the open question is still there");

    await step(teams, answered.id); await step(teams, answered.id);
    assert.equal(f.launches.length, 1, "after the release the answer starts the requesting member's next attempt");
    assert.match(f.launches[0]!.prompt, /User answered: Change a\.txt/);
    await teams.answer(open.id, open.decisionId, { requestId: randomUUID(), revision: 1, text: "Change b.txt" });
    assert.equal(teams.get(open.id).decisions[0]!.answer, "Change b.txt", "the kept question can be answered after the release");
  } finally { halt.stop(); f.close(); }
});

test("a halt holds a run whose answer queued a replacement that has not launched, and the release launches it with the answer", async () => {
  const f = schedulerFixture();
  const waiting = waitingRun(f);
  const teams = f.openTeam();
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions: noRoutines, teams }, () => false);
  try {
    // The owner answers before the halt; the next pass queues the replacement while the run still shows needs-input.
    await teams.answer(waiting.id, waiting.decisionId, { requestId: randomUUID(), revision: 1, text: "Change a.txt" });
    await step(teams, waiting.id);
    assert.equal(teams.get(waiting.id).status, "needs-input");
    assert.deepEqual(teams.get(waiting.id).members.map(member => member.status), ["stopped", "queued"]);
    assert.equal(f.launches.length, 0);

    await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    await step(teams, waiting.id); await step(teams, waiting.id);
    assert.equal(teams.get(waiting.id).status, "paused");
    assert.equal(teams.get(waiting.id).reason, PROJECT_TEXT);
    assert.equal(teams.get(waiting.id).members[1]!.status, "queued", "the queued replacement is held, not stopped");
    assert.equal(f.launches.length, 0, "and does not launch during the halt");

    await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.equal(teams.get(waiting.id).status, "needs-input", "the release resumes the run where it waited");
    assert.equal(teams.get(waiting.id).revision, 1, "without a fresh plan");
    await step(teams, waiting.id);
    assert.equal(f.launches.length, 1, "the replacement launches after the release");
    assert.match(f.launches[0]!.prompt, /User answered: Change a\.txt/, "with the answer");
  } finally { halt.stop(); f.close(); }
});

test("a goal whose team waits for input is paused by the halt, and the release resumes the team with its question", async () => {
  const f = schedulerFixture();
  const goalId = randomUUID();
  const context = { id: goalId, revision: 1, cycle: 1, successCriteria: "Evidence", nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [],
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), maxMembers: 4 };
  const team = waitingRun(f, { title: "Goal cycle", goal: context });
  const goal = writeGoal(f, team.id, "needs-input", goalId);
  const teams = f.openTeam();
  const goals = new GoalService(f.config, f.key, teams);
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals, missions: noRoutines, teams }, id => goals.ownsActiveTeam(id));
  try {
    const engaged = await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused.map(item => `${item.kind}:${item.id}`), [`goal:${goal}`], "the goal pauses its own waiting team");
    assert.equal(goals.get(goal).status, "paused");
    await goalStep(goals, goal);
    assert.equal(teams.get(team.id).status, "paused");
    assert.equal(teams.get(team.id).reason, PROJECT_TEXT);
    assert.equal(teams.get(team.id).revision, 1);

    const heldQueue = teamDecisionQueue(teams, goals);
    assert.equal(heldQueue.decisions.length, 1);
    assert.equal(heldQueue.decisions[0]?.kind, "team");
    assert.equal(heldQueue.decisions[0]?.kind === "team" && heldQueue.decisions[0].held, true);
    assert.equal(heldQueue.decisions[0]?.kind === "team" && heldQueue.decisions[0].answerPath,
      `/api/teams/${team.id}/decisions/${team.decisionId}/answer`);

    // The team answer route dispatches this goal-owned decision to GoalService during the halt.
    await goals.answer(team.id, team.decisionId, { requestId: randomUUID(), revision: 1, text: "Change a.txt" });
    await step(teams, team.id); await step(teams, team.id);
    assert.equal(f.launches.length, 0, "an answer given during the halt starts nothing");
    assert.equal(teams.get(team.id).status, "paused");

    const released = await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => `${item.kind}:${item.id}`), [`goal:${goal}`]);
    await goalStep(goals, goal);
    assert.equal(teams.get(team.id).status, "needs-input", "the goal's team resumes where it waited");
    assert.equal(teams.get(team.id).revision, 1);
    assert.equal(teams.get(team.id).decisions[0]!.answer, "Change a.txt", "the answer given during the halt is kept");
  } finally { halt.stop(); goals.close(); f.close(); }
});

test("a keep-paused release settles a goal's run that saved the halt's pause just before a restart lost the goal's acknowledgement", async () => {
  const f = schedulerFixture();
  const teamId = writeRun(f, { status: "implementing", title: "Goal cycle" });
  const goal = writeGoal(f, teamId);
  const open = () => {
    const teams = f.openTeam(), goals = new GoalService(f.config, f.key, teams);
    const halt = new HaltService({ config: f.config, key: f.key });
    halt.useServices({ routines: noRoutines, goals, missions: noRoutines, teams }, id => goals.ownsActiveTeam(id));
    return { teams, goals, halt, close: () => { halt.stop(); goals.close(); } };
  };
  const first = open();
  let second: ReturnType<typeof open> | undefined;
  try {
    await first.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    // The host stops right after the run saves the goal's halt pause, before the goal records that the pause arrived.
    const internal = first.teams as unknown as { haltPauseChild(id: string, token: string, reason: string): Promise<boolean> };
    const deliver = internal.haltPauseChild.bind(first.teams);
    internal.haltPauseChild = async (id, token, reason) => { await deliver(id, token, reason); throw new Error("The host stopped."); };
    await assert.rejects(goalStep(first.goals, goal), /The host stopped/);
    assert.equal(f.readRecord<{ run: TeamRun }>("team", teamId).run.status, "paused");
    assert.ok(f.readRecord<{ control?: unknown }>("goal", goal).control, "the goal still holds its pause as pending");
    first.close();

    second = open();
    await step(second.teams, teamId);
    assert.equal(second.teams.get(teamId).reason, PROJECT_TEXT, "the run's members have stopped under the halt");
    await second.halt.release(fixtureScope, { requestId: randomUUID(), keepPaused: true }, owner);
    assert.equal(second.goals.get(goal).reason, KEPT_PAUSED);
    assert.equal(second.teams.get(teamId).reason, KEPT_PAUSED, "the release settles the run that already holds the pause");
    assert.ok(f.readRecord<{ control?: unknown }>("goal", goal).control, "the pending pause is kept until the run acknowledges it");
    await goalStep(second.goals, goal);
    assert.equal(f.readRecord<{ control?: unknown }>("goal", goal).control, undefined);
    assert.equal(second.teams.get(teamId).status, "paused");
    assert.equal(second.teams.get(teamId).reason, KEPT_PAUSED, "and the replayed pause leaves the kept-paused text");
  } finally { first.close(); second?.close(); f.close(); }
});

/**
 * One standalone run, one goal's run, and one mission's subteam, each working or each waiting for input, with the halt,
 * goal, and mission services over them. `settle` delivers the goal's and the mission's pauses and lets every run stop.
 */
function keepScenario(f: Fixture, waiting: boolean) {
  const run = (extra: Partial<TeamRun>) => waiting ? waitingRun(f, extra).id : writeRun(f, { status: "implementing", ...extra });
  const standalone = run({ title: "Standalone" }), goalTeam = run({ title: "Goal cycle" });
  const goal = writeGoal(f, goalTeam, waiting ? "needs-input" : "running");
  const missionId = randomUUID(), subteam = run({ missionId, title: "Subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [{ id: "a", title: "a", instructions: "a", repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId: subteam }], missionId);
  const teams = f.openTeam();
  const goals = new GoalService(f.config, f.key, teams);
  const manager = { meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); }, hostLoad: { held: () => undefined } } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  const stored = (missions as unknown as { records: Map<string, { mission: Mission }> }).records.get(missionId)!;
  const applyOps = () => (missions as unknown as { applyOps(stored: unknown): Promise<void> }).applyOps(stored);
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals, missions, teams }, id => goals.ownsActiveTeam(id) || missions.ownsActiveSubteam(id));
  const runs = [standalone, goalTeam, subteam];
  const settle = async () => { await goalStep(goals, goal); await applyOps(); for (const id of runs) await step(teams, id); };
  return { teams, goals, missions, halt, stored, applyOps, settle, runs, standalone, goalTeam, goal, subteam, missionId,
    close: () => { halt.stop(); goals.close(); missions.close(); } };
}

test("a keep-paused release leaves the kept-paused text, not the halt reason, on every item the halt paused", async () => {
  const f = schedulerFixture();
  const s = keepScenario(f, false);
  try {
    const engaged = await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused.map(item => item.kind), ["goal", "mission", "team"]);
    await s.settle();
    for (const id of s.runs) assert.equal(s.teams.get(id).status, "paused");
    assert.equal(s.teams.get(s.subteam).reason, PROJECT_TEXT);

    const kept = await s.halt.release(fixtureScope, { requestId: randomUUID(), keepPaused: true }, owner);
    assert.deepEqual(kept.resumed, []);
    assert.deepEqual(kept.notResumed.map(item => [item.kind, item.reason]), [["team", KEPT_PAUSED], ["mission", KEPT_PAUSED], ["goal", KEPT_PAUSED]]);
    assert.equal(s.teams.get(s.subteam).reason, KEPT_PAUSED, "the mission's subteam no longer shows the halt's reason");
    for (const id of s.runs) {
      assert.equal(s.teams.get(id).status, "paused");
      assert.equal(s.teams.get(id).reason, KEPT_PAUSED, `${s.teams.get(id).title} says the owner kept it paused`);
    }
    assert.equal(s.goals.get(s.goal).reason, KEPT_PAUSED);
    assert.equal(s.stored.mission.reason, KEPT_PAUSED);
  } finally { s.close(); f.close(); }
});

test("a keep-paused release keeps a waiting run where it waits, and the owner's later resume continues it with its question", async () => {
  const f = schedulerFixture();
  const s = keepScenario(f, true);
  try {
    const engaged = await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused.map(item => item.kind), ["goal", "mission", "team"], "waiting work is paused too");
    await s.settle();
    for (const id of s.runs) assert.equal(s.teams.get(id).status, "paused");

    await s.halt.release(fixtureScope, { requestId: randomUUID(), keepPaused: true }, owner);
    for (const id of s.runs) {
      assert.equal(s.teams.get(id).status, "paused");
      assert.equal(s.teams.get(id).reason, KEPT_PAUSED, `${s.teams.get(id).title} says the owner kept it paused`);
    }
    assert.equal(s.goals.get(s.goal).reason, KEPT_PAUSED);
    assert.equal(s.stored.mission.reason, KEPT_PAUSED);

    // The owner resumes each later: the run, the goal, and the mission.
    await s.teams.resume(s.standalone, { requestId: randomUUID(), revision: 1 });
    await s.goals.resume(s.goal, { requestId: randomUUID(), revision: s.goals.get(s.goal).revision });
    await goalStep(s.goals, s.goal);
    await s.missions.resume(s.missionId, { requestId: randomUUID(), revision: s.stored.mission.revision });
    await s.applyOps();
    for (const id of s.runs) {
      const run = s.teams.get(id);
      assert.equal(run.status, "needs-input", `${run.title} continues where it waited`);
      assert.equal(run.revision, 1, `${run.title} does not replan`);
      assert.equal(run.decisions[0]!.answer, undefined, `${run.title} still has its question`);
    }
  } finally { s.close(); f.close(); }
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

    // A keep-paused release leaves the routine paused with the kept-paused text.
    await engage(demo);
    const kept = await halt.release(demo, { requestId: randomUUID(), keepPaused: true }, owner);
    assert.deepEqual(kept.notResumed.map(item => [item.id, item.reason]), [[routine.id, KEPT_PAUSED]]);
    assert.equal(routines.get(routine.id).status, "paused");
    assert.equal(routines.get(routine.id).reason, KEPT_PAUSED);
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
    assert.equal(teams.get(turning).status, "paused", "a subteam that now waits for input is held where it waits");
    assert.equal(teams.get(turning).revision, turningRevision);
    assert.deepEqual(stored.ownerHalt?.children, [ownerPaused, ownerCycled, turning], "and is recorded");
    await step(teams, ownerPaused); await step(teams, ownerCycled);

    // (a) The owner pauses a subteam the halt paused.
    await ownerAction(ownerPaused, "pause");
    await step(teams, ownerPaused);
    await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(stored.ops.map(op => `${op.kind}:${op.teamId}`), [`resume:${ownerPaused}`, `resume:${ownerCycled}`, `resume:${turning}`]);

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
  const stored = (missions as unknown as { records: Map<string, { mission: Mission; ops: { kind: string; teamId: string; halt?: unknown }[]; ownerHalt?: { token: string; children: string[] } }> }).records.get(missionId)!;
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
    const durable = f.readRecord<{ run: TeamRun; ownerHalt?: { haltId?: string; reason: string } }>("team", teamId);
    assert.equal(durable.run.status, "paused");
    assert.equal(durable.ownerHalt?.haltId, first.stored.ownerHalt?.token, "the first paused record already carries the halt's mark");
    assert.equal(durable.run.reason, durable.ownerHalt?.reason, "and the halt's reason");
    assert.ok(durable.run.events.some(event => event.text === `Team paused: ${durable.ownerHalt?.reason}`), "and its event line");
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

test("a mission that waits for the owner is paused by the halt; an owner answer during the halt starts nothing, and the release applies it", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID(), child = waitingRun(f, { missionId, title: "Subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [{ id: "a", title: "a", instructions: "a", repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId: child.id }], missionId);
  const { teams, missions, halt, stored, applyOps, close } = missionWithSubteam(f, missionId);
  try {
    // The coordinator forwards the subteam's question to the owner and asks one of its own, through its question reports.
    const coordinator = missions as unknown as { consume(stored: unknown, report: unknown, attempt: unknown): void };
    coordinator.consume(stored, { kind: "question", question: "Which file should change?", options: ["a.txt", "b.txt"], subtaskId: "a", childDecisionId: child.decisionId }, {});
    coordinator.consume(stored, { kind: "question", question: "Ship it this week?", options: [] }, {});
    const asked = missions.get(missionId);
    assert.equal(asked.status, "needs-input");
    const [forwarded, own] = asked.decisions;
    assert.equal(forwarded!.childDecisionId, child.decisionId);

    const engaged = await halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused.map(item => item.kind), ["mission"], "a mission that waits for the owner is paused");
    await applyOps();
    assert.equal(teams.get(child.id).status, "paused", "and pauses its waiting subteam");

    // The owner answers the forwarded question during the halt: the answer reaches the held subteam, and nothing starts.
    const answered = await missions.answer(missionId, forwarded!.id, { requestId: randomUUID(), revision: missions.get(missionId).revision, text: "Change a.txt" });
    assert.equal(answered.status, "paused");
    assert.equal(answered.decisions[0]!.answeredBy, "owner");
    await applyOps();
    await step(teams, child.id); await step(teams, child.id);
    assert.equal(teams.get(child.id).decisions[0]!.answer, "Change a.txt");
    assert.equal(teams.get(child.id).status, "paused");
    assert.equal(f.launches.length, 0, "an answer given during the halt starts nothing");

    const released = await halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => item.kind), ["mission"], "an answer does not keep the mission paused");
    assert.equal(missions.get(missionId).status, "needs-input", "the mission waits again on its open question");
    assert.equal(missions.get(missionId).decisions.find(item => item.id === own!.id)!.answer, undefined);
    await applyOps();
    assert.equal(teams.get(child.id).status, "needs-input", "the subteam resumes where it waited");
    assert.equal(teams.get(child.id).revision, 1);
    await step(teams, child.id); await step(teams, child.id);
    assert.equal(f.launches.length, 1, "after the release the answer starts the subteam member's next attempt");
    assert.match(f.launches[0]!.prompt, /User answered: Change a\.txt/);
  } finally { close(); f.close(); }
});

type MissionRecord = { mission: Mission; ops: { kind: string; teamId: string; halt?: unknown }[]; ownerHalt?: { token: string; children: string[] }; haltSettlements?: unknown[]; clockStoppedAt?: string };
const timeLimitText = /approved time limit has expired/;
const subtaskOf = (id: string, teamId: string) => ({ id, title: id, instructions: id, repoProjectId: "fixture", dependsOn: [], size: "team", status: "running", teamId });

/** The team, mission, and halt services over the fixture's records, with the halt's gate as the missions' fuse, as the host wires them. */
function missionsUnderHalt(f: Fixture) {
  const teams = f.openTeam();
  const manager = { meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); }, hostLoad: { held: () => undefined } } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("Not queried in this test"); } });
  const halt = new HaltService({ config: f.config, key: f.key });
  missions.useFuse(halt.gate(openFuse));
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions, teams }, id => missions.ownsActiveSubteam(id));
  const internal = missions as unknown as { records: Map<string, MissionRecord>; applyOps(stored: unknown): Promise<void>; step(stored: unknown): Promise<void>; settleClock(stored: unknown): void };
  const record = (id: string) => internal.records.get(id)!;
  return {
    teams, missions, halt, record,
    applyOps: (id: string) => internal.applyOps(record(id)),
    /** The mission's scheduler pass. Used only while no coordinator can start: the mission is paused, blocked, or halted. */
    stepMission: (id: string) => internal.step(record(id)),
    settleClock: (id: string) => internal.settleClock(record(id)),
    extend: (id: string, minutes = 30) => missions.extend(id, { requestId: randomUUID(), revision: record(id).mission.revision, minutes }),
    close: () => { halt.stop(); missions.close(); },
  };
}

test("a halt release neither resumes the subteams of a mission stopped at its time limit nor drops its time-limit pause", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const stopped = writeRun(f, { status: "paused", missionId, title: "Paused at the limit" } as Partial<TeamRun>);
  const stopping = writeRun(f, { status: "implementing", missionId, title: "Pause on its way" } as Partial<TeamRun>);
  writeMission(f, "fixture", [subtaskOf("a", stopped), subtaskOf("b", stopping)], missionId,
    { status: "blocked", stopReason: "deadline", reason: "The approved time limit has expired.", deadlineAt: new Date(Date.now() - 60000).toISOString() },
    { blockedAt: new Date().toISOString(), ops: [{ kind: "pause", subtaskId: "b", teamId: stopping, requestId: randomUUID() }] });
  const s = missionsUnderHalt(f);
  try {
    const engaged = await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(engaged.paused, [], "the halt pauses neither the stopped mission nor its subteams");
    const released = await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed, [], "and its release resumes none of them");
    await s.applyOps(missionId);
    assert.equal(s.teams.get(stopped).status, "paused");
    assert.equal(s.teams.get(stopping).status, "paused", "the time-limit pause still reaches its subteam");
    assert.equal(s.record(missionId).mission.status, "blocked");
    assert.equal(s.record(missionId).mission.stopReason, "deadline");
    assert.deepEqual(s.record(missionId).ops, []);
  } finally { s.close(); f.close(); }
});

test("an extension during the halt moves the deadline and leaves the subteams paused until the release", async () => {
  const f = schedulerFixture();
  const paused = randomUUID(), blocked = randomUUID();
  const pausedTeam = writeRun(f, { status: "implementing", missionId: paused, title: "Subteam of the paused mission" } as Partial<TeamRun>);
  const blockedTeam = writeRun(f, { status: "implementing", missionId: blocked, title: "Subteam of the blocked mission" } as Partial<TeamRun>);
  writeMission(f, "fixture", [subtaskOf("a", pausedTeam)], paused);
  writeMission(f, "fixture", [subtaskOf("a", blockedTeam)], blocked);
  const s = missionsUnderHalt(f);
  try {
    await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    for (const id of [paused, blocked]) await s.applyOps(id);
    for (const id of [pausedTeam, blockedTeam]) await step(s.teams, id);
    // One mission's time limit passes during the halt.
    s.record(blocked).mission.deadlineAt = new Date(Date.now() - 60000).toISOString();
    await s.stepMission(blocked);
    assert.equal(s.record(blocked).mission.stopReason, "deadline");

    // The owner extends both during the halt.
    const deadline = Date.parse(s.record(paused).mission.deadlineAt);
    await s.extend(paused);
    assert.equal(Date.parse(s.record(paused).mission.deadlineAt), deadline + 30 * 60000, "the paused mission's deadline moves");
    assert.equal(s.record(paused).mission.status, "paused", "and it stays paused under the halt");
    await s.extend(blocked);
    assert.equal(s.record(blocked).mission.status, "working", "the extension ends the time-limit stop");
    assert.ok(Date.parse(s.record(blocked).mission.deadlineAt) > Date.now());
    for (const id of [paused, blocked]) await s.applyOps(id);
    for (const id of [pausedTeam, blockedTeam]) assert.equal(s.teams.get(id).status, "paused", `${s.teams.get(id).title} stays paused during the halt`);
    assert.deepEqual(s.record(blocked).ops.map(op => op.kind), ["resume"], "the extension's resume waits for the halt");

    const released = await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => item.id), [paused], "an extension does not keep the halt from resuming the paused mission");
    for (const id of [paused, blocked]) await s.applyOps(id);
    for (const id of [pausedTeam, blockedTeam]) assert.equal(s.teams.get(id).status, "planning", `${s.teams.get(id).title} resumes after the release`);
    assert.deepEqual(s.record(blocked).ops, []);
  } finally { s.close(); f.close(); }
});

test("a time limit that passes during the halt blocks the mission without unpausing anything, and the release keeps it blocked", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const working = writeRun(f, { status: "implementing", missionId, title: "Working subteam" } as Partial<TeamRun>);
  const waiting = waitingRun(f, { missionId, title: "Waiting subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [subtaskOf("a", working), subtaskOf("b", waiting.id)], missionId);
  const s = missionsUnderHalt(f);
  const subteams = [working, waiting.id];
  try {
    await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    await s.applyOps(missionId); await step(s.teams, working);
    s.record(missionId).mission.deadlineAt = new Date(Date.now() - 60000).toISOString();
    await s.stepMission(missionId); await s.applyOps(missionId);
    assert.equal(s.record(missionId).mission.status, "blocked");
    assert.equal(s.record(missionId).mission.stopReason, "deadline");
    for (const id of subteams) assert.equal(s.teams.get(id).status, "paused", "the time limit unpauses nothing");

    const released = await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed, []);
    await s.applyOps(missionId); await step(s.teams, working);
    assert.equal(s.record(missionId).mission.status, "blocked", "the release keeps the mission blocked at its time limit");
    assert.equal(s.record(missionId).mission.stopReason, "deadline");
    assert.equal(s.record(missionId).ownerHalt, undefined);
    for (const id of subteams) {
      assert.equal(s.teams.get(id).status, "paused", "and its subteams paused");
      assert.match(s.teams.get(id).reason ?? "", timeLimitText, "showing the time limit, not the halt");
    }
    assert.equal(s.teams.get(waiting.id).revision, 1);

    // The owner's extension after the release resumes each subteam as the halt paused it.
    await s.extend(missionId);
    await s.applyOps(missionId);
    assert.equal(s.teams.get(working).status, "planning");
    assert.equal(s.teams.get(waiting.id).status, "needs-input", "the waiting subteam continues where it waited");
    assert.equal(s.teams.get(waiting.id).revision, 1);
  } finally { s.close(); f.close(); }
});

test("the halt adds no clock rule: its pause stops an intake mission's clock as any pause does, and an ordinary mission keeps wall-clock time", async () => {
  const f = schedulerFixture();
  const intake = randomUUID(), ordinary = randomUUID();
  const intakeTeam = writeRun(f, { status: "implementing", missionId: intake, title: "Intake subteam" } as Partial<TeamRun>);
  const ordinaryTeam = writeRun(f, { status: "implementing", missionId: ordinary, title: "Ordinary subteam" } as Partial<TeamRun>);
  const soon = new Date(Date.now() + 10 * 60000).toISOString();
  writeMission(f, "fixture", [subtaskOf("a", intakeTeam)], intake,
    { deadlineAt: soon, origin: { kind: "intake", issueId: randomUUID(), identifier: "ISSUE-1", url: "https://linear.example/ISSUE-1", rule: "rule" } });
  writeMission(f, "fixture", [subtaskOf("a", ordinaryTeam)], ordinary, { deadlineAt: soon });
  const s = missionsUnderHalt(f);
  try {
    await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    for (const id of [intake, ordinary]) await s.stepMission(id);
    assert.ok(s.record(intake).clockStoppedAt, "the halt's pause stops the intake mission's clock");
    assert.equal(s.record(ordinary).clockStoppedAt, undefined);

    // The halt lasts an hour, past both wall-clock deadlines; the intake mission had 10 minutes left when it stopped.
    const hour = 60 * 60000;
    s.record(intake).clockStoppedAt = new Date(Date.now() - hour).toISOString();
    for (const id of [intake, ordinary]) s.record(id).mission.deadlineAt = new Date(Date.now() - hour + 10 * 60000).toISOString();
    for (const id of [intake, ordinary]) await s.stepMission(id);
    assert.equal(s.record(intake).mission.status, "paused", "the halted hour does not use up the intake mission's time");
    assert.equal(s.record(ordinary).mission.status, "blocked", "an ordinary mission's deadline passes during the halt, as during the owner's pause");
    assert.equal(s.record(ordinary).mission.stopReason, "deadline");

    const released = await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    assert.deepEqual(released.resumed.map(item => item.id), [intake]);
    s.settleClock(intake);
    const left = Date.parse(s.record(intake).mission.deadlineAt) - Date.now();
    assert.ok(left > 9 * 60000 && left <= 10 * 60000, "the intake mission keeps the 10 minutes it had when the halt paused it");
  } finally { s.close(); f.close(); }
});

test("an owner's pause after a halted extension supersedes the extension's waiting resume, so the release resumes nothing", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID(), child = waitingRun(f, { missionId, title: "Waiting subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [subtaskOf("a", child.id)], missionId);
  const s = missionsUnderHalt(f);
  try {
    await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
    await s.applyOps(missionId);
    s.record(missionId).mission.deadlineAt = new Date(Date.now() - 60000).toISOString();
    await s.stepMission(missionId);
    await s.extend(missionId);
    await s.applyOps(missionId);
    assert.deepEqual(s.record(missionId).ops.map(op => op.kind), ["resume"], "the extension's resume waits behind the halt");

    // The owner pauses the mission before the halt is released.
    await s.missions.pause(missionId, { requestId: randomUUID(), revision: s.record(missionId).mission.revision });
    await s.applyOps(missionId);
    assert.deepEqual(s.record(missionId).ops, [], "the owner's later pause supersedes the waiting resume");
    await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
    await s.applyOps(missionId);
    assert.equal(s.record(missionId).mission.status, "paused");
    assert.equal(s.teams.get(child.id).status, "paused", "the release does not resume the subteam of a mission the owner paused");
    assert.deepEqual(s.record(missionId).ops, []);

    // The owner's resume of the mission continues the subteam where it waited.
    await s.missions.resume(missionId, { requestId: randomUUID(), revision: s.record(missionId).mission.revision });
    await s.applyOps(missionId);
    assert.equal(s.teams.get(child.id).status, "needs-input");
    assert.equal(s.teams.get(child.id).revision, 1);
  } finally { s.close(); f.close(); }
});

test("a halt engaged before an earlier halt's resume reaches a subteam holds that resume, and its own release decides it", async () => {
  for (const mode of ["resume", "keep", "deadline"] as const) {
    const f = schedulerFixture();
    const missionId = randomUUID(), child = waitingRun(f, { missionId, title: "Waiting subteam" } as Partial<TeamRun>);
    writeMission(f, "fixture", [subtaskOf("a", child.id)], missionId);
    const s = missionsUnderHalt(f);
    try {
      await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
      await s.applyOps(missionId);
      assert.equal(s.teams.get(child.id).status, "paused");
      // The first halt is released, and a second engages before its resume reaches the subteam.
      await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
      assert.deepEqual(s.record(missionId).ops.map(op => op.kind), ["resume"]);
      await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
      assert.equal(s.record(missionId).mission.status, "paused");
      await s.applyOps(missionId); await step(s.teams, child.id);
      assert.equal(s.teams.get(child.id).status, "paused", "the earlier halt's resume waits under the second halt");
      assert.equal(f.launches.length, 0);
      if (mode === "deadline") {
        // The time limit passes during the second halt, and its pause supersedes the earlier halt's waiting resume.
        s.record(missionId).mission.deadlineAt = new Date(Date.now() - 60000).toISOString();
        await s.stepMission(missionId);
        assert.equal(s.record(missionId).mission.stopReason, "deadline");
        assert.equal(s.teams.get(child.id).status, "paused");
      }

      await s.halt.release(fixtureScope, { requestId: randomUUID(), keepPaused: mode === "keep" }, owner);
      await s.applyOps(missionId);
      if (mode === "resume") {
        assert.equal(s.teams.get(child.id).status, "needs-input", "the second release lets the waiting resume continue the subteam where it waited");
        assert.equal(s.teams.get(child.id).revision, 1);
      } else {
        if (mode === "deadline") {
          assert.equal(s.record(missionId).mission.status, "blocked", "the release keeps the mission blocked at its time limit");
          assert.equal(s.record(missionId).mission.stopReason, "deadline");
        }
        assert.equal(s.record(missionId).ownerHalt, undefined);
        assert.equal(s.teams.get(child.id).status, "paused", "a release that keeps the mission paused or blocked keeps the subteam paused");
        if (mode === "keep") assert.equal(s.teams.get(child.id).reason, KEPT_PAUSED, "and the subteam no longer shows the first halt's reason");
        else assert.match(s.teams.get(child.id).reason ?? "", timeLimitText, "and the subteam shows the time limit, not the first halt");
        assert.equal(f.readRecord<{ ownerHalt?: { haltId?: string } }>("team", child.id).ownerHalt?.haltId, undefined, "the subteam no longer carries the first halt's token");
        assert.deepEqual(s.record(missionId).ops, [], "the earlier resume is retired");
        assert.equal(s.record(missionId).haltSettlements, undefined);
        if (mode === "keep") await s.missions.resume(missionId, { requestId: randomUUID(), revision: s.record(missionId).mission.revision });
        else await s.extend(missionId);
        await s.applyOps(missionId);
        assert.equal(s.teams.get(child.id).status, "needs-input", `the owner's ${mode === "keep" ? "resume" : "extension"} continues the subteam where it waited`);
        assert.equal(s.teams.get(child.id).revision, 1);
      }
      assert.deepEqual(s.record(missionId).ops, []);
      assert.equal(s.record(missionId).haltSettlements, undefined);
    } finally { s.close(); f.close(); }
  }
});

test("an owner's pause that supersedes a halt release's resume shows the pause on the subteam, and a resume continues it even before that pause arrives", async () => {
  for (const resumeFirst of [false, true]) {
    const f = schedulerFixture();
    const missionId = randomUUID(), child = waitingRun(f, { missionId, title: "Waiting subteam" } as Partial<TeamRun>);
    writeMission(f, "fixture", [subtaskOf("a", child.id)], missionId);
    const s = missionsUnderHalt(f);
    try {
      await s.halt.engage(fixtureScope, { requestId: randomUUID() }, owner);
      await s.applyOps(missionId);
      await s.halt.release(fixtureScope, { requestId: randomUUID() }, owner);
      assert.deepEqual(s.record(missionId).ops.map(op => op.kind), ["resume"], "the release's resume has not reached the subteam");

      await s.missions.pause(missionId, { requestId: randomUUID(), revision: s.record(missionId).mission.revision });
      if (!resumeFirst) {
        await s.applyOps(missionId);
        assert.equal(s.teams.get(child.id).status, "paused");
        assert.equal(s.teams.get(child.id).reason, s.record(missionId).mission.reason, "the subteam shows the owner's pause, not the halt");
        assert.equal(f.readRecord<{ ownerHalt?: { haltId?: string } }>("team", child.id).ownerHalt?.haltId, undefined);
        assert.deepEqual(s.record(missionId).ops, []);
        assert.equal(s.record(missionId).haltSettlements, undefined);
      }
      // With resumeFirst, the owner resumes before the pause is delivered, which withdraws that pause.
      await s.missions.resume(missionId, { requestId: randomUUID(), revision: s.record(missionId).mission.revision });
      await s.applyOps(missionId);
      assert.equal(s.teams.get(child.id).status, "needs-input", resumeFirst ? "the subteam resumes as the halt paused it" : "the owner's resume continues the subteam where it waited");
      assert.equal(s.teams.get(child.id).revision, 1);
      assert.deepEqual(s.record(missionId).ops, []);
      assert.equal(s.record(missionId).haltSettlements, undefined);
    } finally { s.close(); f.close(); }
  }
});

test("an owner's resume that withdraws an undelivered pause still resumes a subteam whose earlier resume that pause superseded", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID(), child = writeRun(f, { status: "paused", missionId, title: "Paused subteam" } as Partial<TeamRun>);
  writeMission(f, "fixture", [subtaskOf("a", child)], missionId, { status: "paused", reason: "Paused by the owner." });
  const s = missionsUnderHalt(f);
  const action = () => ({ requestId: randomUUID(), revision: s.record(missionId).mission.revision });
  try {
    await s.missions.resume(missionId, action());
    assert.deepEqual(s.record(missionId).ops.map(op => op.kind), ["resume"]);
    // Before that resume reaches the subteam, a pause supersedes it, and the owner resumes again.
    await s.missions.pause(missionId, action());
    assert.deepEqual(s.record(missionId).ops.map(op => op.kind), ["pause"]);
    await s.missions.resume(missionId, action());
    await s.applyOps(missionId);
    assert.equal(s.record(missionId).mission.status, "working");
    assert.equal(s.teams.get(child).status, "planning", "the subteam resumes with its mission");
    assert.deepEqual(s.record(missionId).ops, []);
  } finally { s.close(); f.close(); }
});

test("an extension that withdraws undelivered time-limit pauses resumes a subteam paused now and leaves a working one working", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const paused = writeRun(f, { status: "paused", missionId, title: "Paused subteam" } as Partial<TeamRun>);
  const working = writeRun(f, { status: "implementing", missionId, title: "Working subteam" } as Partial<TeamRun>);
  const pause = (subtaskId: string, teamId: string) => ({ kind: "pause", subtaskId, teamId, requestId: randomUUID() });
  // A pause still queued for each: the time limit's, after it superseded the paused subteam's resume; and both the
  // owner's and the time limit's for the working subteam, which neither reached.
  writeMission(f, "fixture", [subtaskOf("a", paused), subtaskOf("b", working)], missionId,
    { status: "blocked", stopReason: "deadline", reason: "The approved time limit has expired.", deadlineAt: new Date(Date.now() - 60000).toISOString() },
    { blockedAt: new Date().toISOString(), ops: [pause("a", paused), pause("b", working), pause("b", working)] });
  const s = missionsUnderHalt(f);
  try {
    await s.extend(missionId);
    await s.applyOps(missionId);
    assert.equal(s.record(missionId).mission.status, "working");
    assert.equal(s.teams.get(paused).status, "planning", "the paused subteam resumes with its mission");
    assert.equal(s.teams.get(working).status, "implementing", "no second pause reaches the working subteam");
    assert.deepEqual(s.record(missionId).ops, []);
  } finally { s.close(); f.close(); }
});
