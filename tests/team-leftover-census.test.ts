import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import { GoalService } from "../packages/host/src/goals.js";
import type { Manager } from "../packages/host/src/manager.js";
import { newWitness, recordCommand, type CensusResult, type HostProcesses, type ProcessWitness } from "../packages/host/src/process-census.js";
import type { StoredLeftover } from "../packages/host/src/team-leftover.js";
import { DEFAULT_TEAM_RETENTION, type TeamRun } from "../packages/host/src/team-types.js";
import { COMMAND_STOP_UNCONFIRMED_REASON } from "../packages/host/src/team-workspace.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { mixedLineup } from "./team-fixture.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Pending = { id: string; kind: "check"; revision: number; witness?: ProcessWitness; failure?: { code: string; reason: string; at: string } };
type StoredRun = { run: TeamRun; pending?: Pending; leftover?: StoredLeftover; halt?: string };
type Internals = {
  records: Map<string, StoredRun>;
  operation(stored: StoredRun, kind: "check", perform: () => Promise<void>, complete: () => void): void;
  noteLeftover(stored: StoredRun, result: { leftover: boolean }): Promise<void>;
};

const OPERATION_RUNNING = "The host still sees 1 process(es) that match its record of the interrupted check operation.";
const OPERATION_ENDED = "The host sees no process that matches its record of the interrupted check operation, and none using this run's directory. The intent stays recorded and is not replayed.";
const LEFTOVER_RUNNING = "The host still sees 1 process(es) left behind by an earlier command of this run. It keeps this run's directories until a census finds none.";

function witness(...pids: number[]): ProcessWitness {
  return { ...newWitness(), processes: pids.map(pid => ({ pid, start: `start-${pid}` })), sessions: [...pids], groups: [...pids] };
}

function pidsOf(recorded: ProcessWitness) {
  return [...new Set([...recorded.processes.map(item => item.pid), ...recorded.groups, ...recorded.sessions])].sort((a, b) => a - b);
}

function liveProcesses(alive: Set<number>, seen: ProcessWitness[], hold?: (recorded: ProcessWitness) => Promise<void> | undefined): HostProcesses {
  return { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async (recorded): Promise<CensusResult> => {
      seen.push(structuredClone(recorded));
      await hold?.(recorded);
      return { ok: true, findings: pidsOf(recorded).filter(pid => alive.has(pid)).map(pid => ({ pid, reason: "recorded-process" as const })) };
    } };
}

function openTeam(f: Fixture, now: () => number, processes: HostProcesses) {
  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now, processes });
  return { teams, internal: teams as unknown as Internals };
}

function settledRun(f: Fixture, status: TeamRun["status"]) {
  const at = new Date().toISOString();
  f.run.status = status;
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.members.forEach(member => { member.status = "stopped"; });
  return at;
}

async function until(check: () => boolean, message: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(message);
}

const code = (expected: string) => (error: unknown) => error instanceof TeamError && error.code === expected;

function mixedProcesses(owner: number, reason: "recorded-group" | "working-directory"): HostProcesses {
  return { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async (recorded): Promise<CensusResult> => ({ ok: true, findings: [{ pid: 999, reason: "unreadable" as const },
      ...(pidsOf(recorded).includes(owner) ? [{ pid: reason === "recorded-group" ? owner : 303, reason }] : [])] }) };
}

function mixedRun(owner: number, reason: "recorded-group" | "working-directory") {
  const f = schedulerFixture();
  const at = settledRun(f, "cancelled");
  f.run.events.push({ at, text: "Team cancelled." });
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 600 };
  f.writeTeam();
  const { teams, internal } = openTeam(f, () => Date.parse(at) + 1000, mixedProcesses(owner, reason));
  const stored = internal.records.get(f.run.id)!;
  stored.pending = { id: randomUUID(), kind: "check", revision: 1, witness: witness(101) };
  stored.leftover = { since: at, witness: witness(202) };
  return { f, teams, stored };
}

const MIXED = [
  { owner: 202, reason: "recorded-group", record: "the left process runs", removal: "team-leftover-running", removalText: "left behind", statementText: "left behind", states: ["unknown", "running"] },
  { owner: 101, reason: "recorded-group", record: "the operation runs", removal: "team-operation-running", removalText: "still sees, or cannot rule out", statementText: "processes of this run's operation", states: ["running", "unknown"] },
  { owner: 202, reason: "working-directory", record: "the left-process look finds a process using the directory", removal: "team-leftover-running", removalText: "left behind", statementText: "left behind", states: ["unknown", "in-use"] },
] as const;
const count = (teams: TeamService, run: TeamRun, text: string) => teams.get(run.id).events.filter(event => event.text === text).length;

test("retention looks for an unfinished operation's processes and a left process separately, and records each record's result once while it stays the same", async () => {
  const f = schedulerFixture();
  const at = settledRun(f, "cancelled");
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 1 };
  f.writeTeam();
  const seen: ProcessWitness[] = [];
  let now = Date.parse(at) + 60_001;
  const { teams, internal } = openTeam(f, () => now, liveProcesses(new Set([202]), seen));
  try {
    internal.records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1, witness: witness(101) };
    internal.records.get(f.run.id)!.leftover = { since: at, witness: witness(202) };
    teams.start();
    for (let round = 1; round <= 4; round++) {
      await until(() => seen.filter(recorded => pidsOf(recorded).includes(202)).length >= round, `retention round ${round} should look for the left process`);
      await teams.idle();
      now += 10 * 60_000;
    }
    assert.equal(teams.get(f.run.id).pendingOperation?.processes, "ended", "the operation's state covers only its own record");
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "running");
    assert.equal(count(teams, f.run, OPERATION_RUNNING), 0, "the left process is never attributed to the operation");
    assert.equal(count(teams, f.run, OPERATION_ENDED), 1, "the operation's unchanged result is recorded once");
    assert.equal(count(teams, f.run, LEFTOVER_RUNNING), 1, "the left process's unchanged result is recorded once");
    assert.ok(seen.every(recorded => pidsOf(recorded).length === 1), "each census covers one record");
    assert.equal(existsSync(dirname(f.run.workspace)), true);
  } finally {
    await teams.close();
    f.close();
  }
});

test("a census taken for an older left-process record neither clears a newer record nor answers a request made for it", async () => {
  const f = schedulerFixture();
  const at = settledRun(f, "cancelled");
  f.writeTeam();
  const seen: ProcessWitness[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const hold = (recorded: ProcessWitness) => pidsOf(recorded).includes(303) ? undefined : gate;
  const { teams, internal } = openTeam(f, () => Date.parse(at) + 1000, liveProcesses(new Set([303]), seen, hold));
  try {
    const older = witness(202);
    internal.records.get(f.run.id)!.leftover = { since: at, witness: older };
    const first = teams.removeRun(f.run.id);
    first.catch(() => {});
    await until(() => seen.length === 1, "the first removal should start a census of the older record");
    internal.records.get(f.run.id)!.leftover = { since: at, witness: witness(202, 303) };
    const second = teams.removeRun(f.run.id);
    second.catch(() => {});
    const answered = await Promise.race([second.then(() => "removed", (error: unknown) => error), delay(10_000).then(() => "waiting for the older census")]);
    assert.ok(code("team-leftover-running")(answered), `a request for the newer record gets its own census: ${String(answered)}`);
    assert.deepEqual(pidsOf(seen.at(-1)!), [202, 303], "the newer record gets a census of its own");
    release();
    await assert.rejects(first, code("team-leftover-running"), "the older record's census does not clear the newer record");
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "running");
    assert.equal(existsSync(dirname(f.run.workspace)), true);
  } finally {
    release();
    await teams.close();
    f.close();
  }
});

for (const outcome of ["passes", "fails"] as const)
test(`a process an operation records after its command left a process joins the left-process record when the operation ${outcome}`, async () => {
  const f = schedulerFixture();
  settledRun(f, "implementing");
  f.writeTeam();
  const { teams, internal } = openTeam(f, () => Date.now(), liveProcesses(new Set([303]), []));
  try {
    const stored = internal.records.get(f.run.id)!;
    stored.halt = undefined;
    internal.operation(stored, "check", async () => {
      await internal.noteLeftover(stored, { leftover: true });
      recordCommand(stored.pending!.witness!, 303, "start-303");
      if (outcome === "fails") throw new TeamError(409, "team-check-failed", "The check failed.");
    }, () => {});
    await until(() => outcome === "passes" ? !stored.pending : Boolean(stored.pending?.failure), "the operation should settle");
    assert.ok(stored.leftover, "the command's left process is recorded");
    await teams.processesEnded(f.run.id, { requestId: randomUUID() }).catch(() => {});
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "running", "the census of the left-process record covers the process recorded after it");
  } finally {
    await teams.close();
    f.close();
  }
});

test("a goal's resume within the census reuse window is not refused for a left process when the stopped command's own processes ended", async () => {
  const f = schedulerFixture();
  const at = settledRun(f, "paused");
  const goal: ProductGoal = { id: randomUUID(), projectId: f.run.projectId, title: "Inspect the fixture", objective: "Choose scoped work",
    successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 2, maxMinutes: 60,
    maxMembers: 4, parallelism: 1, revision: 1, status: "paused", createdAt: at, updatedAt: at,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup: mixedLineup, activeTeamId: f.run.id, memberCount: 1,
    cycles: [{ teamId: f.run.id, cycle: 1, goalRevision: 1, status: "paused", startedAt: at, memberCount: 1 }],
    steering: [], events: [], outcomes: [] };
  f.run.goal = { id: goal.id, revision: 1, cycle: 1, successCriteria: goal.successCriteria, nonGoals: [], allowedPaths: ["."], evidence: [],
    previousWork: [], deadlineAt: goal.deadlineAt, maxMembers: 1 };
  f.run.reason = COMMAND_STOP_UNCONFIRMED_REASON;
  f.writeTeam({ pending: { id: randomUUID(), kind: "check", revision: f.run.revision, witness: witness(101),
    failure: { code: "command-stop-unconfirmed", reason: COMMAND_STOP_UNCONFIRMED_REASON, at } }, leftover: { since: at, witness: witness(202) } });
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  const seen: ProcessWitness[] = [], now = Date.now();
  const { teams, internal } = openTeam(f, () => now, liveProcesses(new Set([202]), seen));
  internal.records.get(f.run.id)!.halt = undefined;
  const goals = new GoalService(f.config, f.key, teams);
  const resume = teams.resume.bind(teams);
  let attempts = 0;
  teams.resume = (...args: Parameters<TeamService["resume"]>) => { attempts++; return resume(...args); };
  try {
    await assert.rejects(teams.processesEnded(f.run.id, { requestId: randomUUID() }), code("team-command-running"), "the statement is refused while the left process runs");
    const looked = seen.length;
    await goals.resume(goal.id, { requestId: randomUUID(), revision: 1 });
    goals.start();
    await until(() => attempts >= 3 || f.readRecord<{ control?: unknown }>("goal", goal.id).control === undefined, "the goal should apply its resume");
    assert.equal(f.readRecord<{ control?: unknown }>("goal", goal.id).control, undefined, `the resume reached the team: ${f.readRecord<{ goal: ProductGoal }>("goal", goal.id).goal.reason}`);
    assert.notEqual(teams.get(f.run.id).status, "paused");
    assert.equal(seen.length, looked, "the resume reused the census");
  } finally {
    await goals.close();
    await teams.close();
    f.close();
  }
});

test("removal answers from the record whose own look finds a process when the other record's look cannot tell", async () => {
  for (const mixed of MIXED) {
    const { f, teams } = mixedRun(mixed.owner, mixed.reason);
    try {
      const answered = await teams.removeRun(f.run.id).then(() => "removed", (error: unknown) => error);
      assert.ok(code(mixed.removal)(answered) && (answered as TeamError).message.includes(mixed.removalText), `${mixed.record}: ${String(answered)}`);
      const view = teams.get(f.run.id);
      assert.deepEqual([view.pendingOperation?.processes, view.leftoverProcesses?.state], mixed.states);
      assert.equal(existsSync(dirname(f.run.workspace)), true);
    } finally {
      await teams.close();
      f.close();
    }
  }
});

test("the owner's statement is refused while either record's own look finds a process, and the refusal names that record", async () => {
  for (const mixed of MIXED) {
    const { f, teams, stored } = mixedRun(mixed.owner, mixed.reason);
    try {
      const answered = await teams.processesEnded(f.run.id, { requestId: randomUUID() }).then(() => "accepted", (error: unknown) => error);
      assert.ok(code("team-command-running")(answered) && (answered as TeamError).message.includes(mixed.statementText), `${mixed.record}: ${String(answered)}`);
      const view = teams.get(f.run.id);
      assert.deepEqual([view.pendingOperation?.processes, view.leftoverProcesses?.state], mixed.states);
      assert.equal((stored.pending as { processesEnded?: unknown }).processesEnded, undefined, "the statement is not recorded for the operation");
      assert.equal(view.events.some(event => event.text.startsWith("The owner stated")), false);
    } finally {
      await teams.close();
      f.close();
    }
  }
});
