import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { GoalService } from "../packages/host/src/goals.js";
import type { Manager } from "../packages/host/src/manager.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import { MissionService } from "../packages/host/src/missions.js";
import { newWitness, type CensusResult, type HostProcesses } from "../packages/host/src/process-census.js";
import { COMMAND_STOP_UNCONFIRMED_REASON } from "../packages/host/src/team-workspace.js";
import { TeamService } from "../packages/host/src/teams.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { waitFor } from "./helpers.js";
import { mixedLineup } from "./team-fixture.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Census = { result: CensusResult; count: number; now: number };
type GoalRecord = { goal: ProductGoal; control?: unknown };
type MissionInternals = { records: Map<string, { ops: { kind: string }[] }>; applyOps(stored: unknown): Promise<void> };
type Outcome = "running" | "unknown";

const RUNNING: CensusResult = { ok: true, findings: [{ pid: 101, reason: "recorded-group" }] };
const ENDED: CensusResult = { ok: true, findings: [] };
const UNKNOWN: CensusResult = { ok: false, problem: "prefix-unsupported" };

function census(outcome: Outcome): Census {
  return { result: outcome === "running" ? RUNNING : UNKNOWN, count: 0, now: Date.now() };
}

function waitingText(id: string, outcome: Outcome) {
  return outcome === "running"
    ? `The stopped command of team run ${id} may still be running.`
    : `states that its processes ended with \`infinite team processes-ended ${id}\``;
}

function fencedTeam(f: Fixture, status: "paused" | "blocked", seen: Census) {
  const at = new Date().toISOString();
  f.run.status = status;
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.reason = COMMAND_STOP_UNCONFIRMED_REASON;
  if (status === "blocked") f.run.blockCode = "command-stop-unconfirmed";
  f.run.members.forEach(member => { member.status = "stopped"; });
  const witness = { ...newWitness(), processes: [{ pid: 101, start: "start-101" }], sessions: [101], groups: [101] };
  f.writeTeam({ pending: { id: randomUUID(), kind: "check", revision: f.run.revision, witness,
    failure: { code: "command-stop-unconfirmed", reason: COMMAND_STOP_UNCONFIRMED_REASON, at } } });
  const processes: HostProcesses = { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async () => { seen.count++; return seen.result; } };
  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => seen.now, processes });
  (teams as unknown as { records: Map<string, { halt?: string }> }).records.get(f.run.id)!.halt = undefined;
  return teams;
}

async function endCommand(f: Fixture, teams: TeamService, seen: Census, outcome: Outcome) {
  if (outcome === "unknown") {
    await teams.processesEnded(f.run.id, { requestId: randomUUID() });
    return;
  }
  seen.result = ENDED;
  seen.now += 31_000;
}

function pausedGoal(f: Fixture, seen: Census) {
  const at = new Date().toISOString();
  const goal: ProductGoal = { id: randomUUID(), projectId: f.run.projectId, title: "Inspect the fixture", objective: "Choose scoped work",
    successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60,
    maxMembers: 4, parallelism: 1, revision: 1, status: "paused", createdAt: at, updatedAt: at,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup: mixedLineup, activeTeamId: f.run.id, memberCount: 1,
    cycles: [{ teamId: f.run.id, cycle: 1, goalRevision: 1, status: "paused", startedAt: at, memberCount: 1 }],
    steering: [], events: [], outcomes: [] };
  f.run.goal = { id: goal.id, revision: 1, cycle: 1, successCriteria: goal.successCriteria, nonGoals: [], allowedPaths: ["."], evidence: [],
    previousWork: [], deadlineAt: goal.deadlineAt, maxMembers: 1 };
  const teams = fencedTeam(f, "paused", seen);
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  return { goal, teams, goals: new GoalService(f.config, f.key, teams) };
}

for (const outcome of ["running", "unknown"] as const)
test(`a goal's resume waits, not blocked, while its team's stopped command census is ${outcome}, says why once, and resumes the team once the command ${outcome === "running" ? "ended" : "is stated ended"}`, async () => {
  const f = schedulerFixture();
  const seen = census(outcome);
  const { goal, teams, goals } = pausedGoal(f, seen);
  const resume = teams.resume.bind(teams);
  let attempts = 0;
  teams.resume = (...args: Parameters<TeamService["resume"]>) => { attempts++; return resume(...args); };
  const read = async () => f.readRecord<GoalRecord>("goal", goal.id);
  try {
    await goals.resume(goal.id, { requestId: randomUUID(), revision: 1 });
    goals.start();
    const waiting = await waitFor(read, value => value.goal.status === "blocked" || attempts >= 3, 10_000);
    assert.equal(waiting.goal.status, "running", `the goal waits instead of blocking: ${waiting.goal.reason}`);
    assert.ok(waiting.control, "the goal keeps its resume");
    assert.ok(waiting.goal.reason?.startsWith("The goal's resume waits for its team."), waiting.goal.reason);
    assert.ok(waiting.goal.reason?.includes(waitingText(f.run.id, outcome)), waiting.goal.reason);
    assert.equal(waiting.goal.events.filter(event => event.text === waiting.goal.reason).length, 1, "one event, not one per pass");
    assert.equal(teams.get(f.run.id).status, "paused");
    assert.equal(seen.count, 1, "retries within 30 seconds reuse the census");
    await endCommand(f, teams, seen, outcome);
    const resumed = await waitFor(read, value => !value.control || value.goal.status === "blocked", 10_000);
    assert.equal(resumed.goal.status, "running", JSON.stringify(resumed.goal.reason));
    assert.equal(resumed.control, undefined);
    assert.notEqual(teams.get(f.run.id).status, "paused", "the goal's resume reached the team");
    assert.equal(teams.get(f.run.id).pendingOperation, undefined);
  } finally {
    await goals.close();
    await teams.close();
    f.close();
  }
});

function fencedMission(f: Fixture, seen: Census, kind: "resume" | "steer") {
  const missionId = randomUUID(), at = new Date().toISOString();
  f.run.missionId = missionId;
  const teams = fencedTeam(f, kind === "resume" ? "paused" : "blocked", seen);
  const mission: Mission = {
    id: missionId, groupId: "fixture-group", groupName: "Fixture", repoProjectIds: ["fixture"],
    title: "Mission", objective: "Complete one subtask", maxSubtasks: 1, maxMinutes: 60,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), revision: 1, status: kind === "resume" ? "paused" : "working",
    createdAt: at, updatedAt: at, lineup: mixedLineup,
    subtasks: [{ id: "a", repoProjectId: "fixture", title: "Subteam", objective: "Complete the task", size: "team", parallelism: 1, dependsOn: [], status: "running", teamId: f.run.id }],
    decisions: [], steering: [], events: [],
  };
  const ops = kind === "steer" ? [{ kind: "steer", subtaskId: "a", teamId: f.run.id, requestId: randomUUID(), revision: f.run.revision, text: "Use the smaller fix.", by: "coordinator" }] : [];
  const directory = join(f.config.stateDir, "missions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeSealed(join(directory, `${missionId}.sealed`), f.key, `mission:${missionId}`, {
    mission, fingerprint: "fixture", receipts: {}, folder: f.run.workspace, repos: [], attempts: [],
    inbox: [], notes: [], notified: [], launches: {}, ops, refusals: 0,
  });
  const manager = {
    list: async () => [],
    meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); },
    hostLoad: { held: () => undefined },
  } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, { get: () => { throw new Error("The test mission has no group lookup."); } });
  const internal = missions as unknown as MissionInternals;
  return {
    missionId, teams, missions,
    applyOps: () => internal.applyOps(internal.records.get(missionId)!),
    ops: () => internal.records.get(missionId)!.ops.map(op => op.kind),
  };
}

for (const kind of ["resume", "steer"] as const)
for (const outcome of ["running", "unknown"] as const)
test(`a mission's ${kind} of a subteam whose stopped command census is ${outcome} stays queued with one event, and reaches the subteam once the command ${outcome === "running" ? "ended" : "is stated ended"}`, async () => {
  const f = schedulerFixture();
  const seen = census(outcome);
  const m = fencedMission(f, seen, kind);
  try {
    if (kind === "resume") await m.missions.resume(m.missionId, { requestId: randomUUID(), revision: 1 });
    for (let pass = 0; pass < 3; pass++) await m.applyOps();
    assert.deepEqual(m.ops(), [kind], `the mission keeps its ${kind}`);
    const events = m.missions.get(m.missionId).events.filter(event => event.text.startsWith(`A ${kind} for subtask a`));
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.ok(events[0]!.text.includes("waits for its subteam."), events[0]!.text);
    assert.ok(events[0]!.text.includes(waitingText(f.run.id, outcome)), events[0]!.text);
    assert.equal(m.teams.get(f.run.id).status, kind === "resume" ? "paused" : "blocked");
    assert.equal(seen.count, 1, "retries within 30 seconds reuse the census");
    await endCommand(f, m.teams, seen, outcome);
    await m.applyOps();
    assert.deepEqual(m.ops(), [], `the ${kind} reached the subteam`);
    const team = m.teams.get(f.run.id);
    assert.equal(team.status, "planning");
    assert.equal(team.pendingOperation, undefined);
    if (kind === "steer") assert.equal(team.steering.at(-1)?.text, "Use the smaller fix.");
  } finally {
    await m.missions.close();
    await m.teams.close();
    f.close();
  }
});
