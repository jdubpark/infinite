import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { DEFAULT_TEAM_RETENTION, type TeamMember, type TeamRun } from "../packages/host/src/team-types.js";
import { newWitness, type CensusResult, type HostProcesses, type ProcessWitness } from "../packages/host/src/process-census.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Internals = { records: Map<string, { pending?: unknown; leftover?: unknown }>; step(stored: unknown): Promise<void> };

const RUNNING = "The host still sees 1 process(es) left behind by an earlier command of this run. It keeps this run's directories until a census finds none.";
const ENDED = "The host sees no process left behind by an earlier command of this run, and none using this run's directory. Its directories can be removed.";

function processes(census: () => CensusResult, seen: ProcessWitness[] = []): HostProcesses {
  return { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async witness => { seen.push(structuredClone(witness)); return census(); } };
}

function byWitness(alive: Set<number>, seen: ProcessWitness[]): HostProcesses {
  return { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async recorded => {
      seen.push(structuredClone(recorded));
      return { ok: true, findings: recorded.processes.filter(item => alive.has(item.pid)).map(item => ({ pid: item.pid, reason: "recorded-process" as const })) };
    } };
}

function countSteps(teams: TeamService) {
  const internal = teams as unknown as Internals, step = internal.step.bind(teams), passes = { count: 0 };
  internal.step = async stored => {
    await step(stored);
    passes.count++;
  };
  return passes;
}

function openTeam(f: Fixture, now: () => number, hostProcesses: HostProcesses) {
  return new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now, processes: hostProcesses });
}

function retention(f: Fixture, values: Partial<typeof DEFAULT_TEAM_RETENTION>) {
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, ...values };
}

function witness(pid: number): ProcessWitness {
  return { ...newWitness(), processes: [{ pid, start: `start-${pid}` }], sessions: [pid], groups: [pid] };
}

function leftover(teams: TeamService, run: TeamRun, at: string, recorded = witness(4242)) {
  (teams as unknown as Internals).records.get(run.id)!.leftover = { since: at, witness: recorded };
}

function settled(f: Fixture, status: TeamRun["status"], text: string) {
  const at = new Date().toISOString();
  f.run.status = status;
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text });
  return at;
}

const runDirectory = (run: TeamRun) => dirname(run.workspace);
const count = (teams: TeamService, run: TeamRun, text: string) => teams.get(run.id).events.filter(event => event.text === text).length;

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function close(f: Fixture, teams: TeamService) {
  teams.close();
  await teams.idle();
  f.close();
}

for (const [status, text, limit] of [
  ["ready-for-review", "Ready for human review.", { reviewHours: 1 }],
  ["merged", "The delivery agent reported a merged pull request for the reviewed commit.", { finishedMinutes: 0 }],
] as const) {
  test(`a ${status} run past its retention limit keeps its directories while the host sees a process an earlier command left, and removes them once it sees none`, async () => {
    const f = schedulerFixture();
    const at = settled(f, status, text);
    retention(f, limit);
    f.writeTeam();
    let result: CensusResult = { ok: true, findings: [{ pid: 4242, reason: "recorded-group" }] };
    let now = Date.parse(at) + 3_600_001, looks = 0;
    const teams = openTeam(f, () => now, processes(() => { looks++; return result; }));
    const passes = countSteps(teams);
    try {
      leftover(teams, f.run, at);
      teams.start();
      await waitFor(() => looks >= 1 && count(teams, f.run, RUNNING) === 1, "the host should look for the process", 30_000);
      const looked = passes.count;
      await waitFor(() => passes.count >= looked + 2, "the scheduler should step the run again", 30_000);
      await teams.idle();
      assert.equal(existsSync(runDirectory(f.run)), true, "the directories stay while the process runs");
      assert.equal(count(teams, f.run, RUNNING), 1, "the host says it still sees the process");
      assert.equal(teams.get(f.run.id).workspaceRemovedAt, undefined);
      assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "running");
      assert.equal(looks, 1, "a census that found the process stands until the next scheduled look");
      result = { ok: true, findings: [] };
      now += 10 * 60_000;
      await waitFor(() => !existsSync(runDirectory(f.run)), "the directories should be removed once the census finds no process", 30_000);
      await teams.idle();
      assert.equal(count(teams, f.run, ENDED), 1);
      assert.equal(teams.get(f.run.id).leftoverProcesses, undefined);
      assert.equal(teams.get(f.run.id).status, status);
    } finally { await close(f, teams); }
  });
}

test("a cancelled run whose census cannot tell refuses removal, is removed after the owner's statement that the processes ended, and that statement is refused while the census sees the process", async () => {
  const f = schedulerFixture();
  const at = settled(f, "cancelled", "Team cancelled.");
  retention(f, { cancelledMinutes: 60 });
  f.writeTeam();
  let result: CensusResult = { ok: false, problem: "The process table is unreadable" };
  const teams = openTeam(f, () => Date.parse(at) + 1000, processes(() => result));
  try {
    leftover(teams, f.run, at);
    teams.start();
    await assert.rejects(teams.removeRun(f.run.id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-leftover-unknown");
    assert.equal(existsSync(runDirectory(f.run)), true);
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "unknown");
    assert.equal(count(teams, f.run, "The host cannot tell whether a process left behind by an earlier command of this run still runs: The process table is unreadable. It keeps this run's directories; after checking the host, the owner can state that it ended with `infinite team processes-ended RUN_ID`."), 1);
    result = { ok: true, findings: [{ pid: 4242, reason: "recorded-process" }] };
    await assert.rejects(teams.processesEnded(f.run.id, { requestId: randomUUID() }), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-command-running");
    assert.equal(existsSync(runDirectory(f.run)), true, "the statement is refused while the census sees the process");
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "running");
    result = { ok: false, problem: "The process table is unreadable" };
    const statement = { requestId: randomUUID() };
    const stated = await teams.processesEnded(f.run.id, statement);
    assert.equal(stated.leftoverProcesses, undefined, "the statement lifts the hold");
    assert.equal(stated.events.filter(event => event.text === "The owner stated that the processes an earlier command of this run left behind have ended. The host's census could not tell (The process table is unreadable); it no longer keeps this run's directories for them.").length, 1,
      JSON.stringify(stated.events.slice(-4)));
    assert.equal((await teams.processesEnded(f.run.id, statement)).events.length, stated.events.length, "a repeated statement records nothing more");
    await teams.removeRun(f.run.id);
    assert.equal(existsSync(runDirectory(f.run)), false);
    assert.equal(teams.statuses().some(row => row.id === f.run.id), false);
  } finally { await close(f, teams); }
});

test("an active run keeps an integrated member clone while it records a process an earlier command left, and removes the clone once that record is gone", async () => {
  const f = schedulerFixture();
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  const cwd = join(runDirectory(f.run), "members", randomUUID());
  mkdirSync(cwd, { recursive: true });
  const member: TeamMember = { ...structuredClone(f.run.members[0]!), memberId: randomUUID(), sessionId: randomUUID(), revision: 1, role: "implementer", taskId: "done",
    title: "implementer: done", status: "stopped", cwd, report: { kind: "result", summary: "Validated task result." } };
  f.run.members.push(member);
  f.run.tasks = [{ id: "done", title: "Completed task", instructions: "Complete the task", paths: ["src"], dependsOn: [], revision: 1, status: "integrated", memberId: member.memberId, commit: f.run.baseCommit }];
  const at = new Date().toISOString();
  f.run.updatedAt = at;
  f.run.events.push({ at, text: `${member.title} reported a result; its validated changes were integrated.` });
  retention(f, { memberMinutes: 0 });
  f.config.teams!.stallMinutes = 600;
  f.writeTeam();
  const teams = openTeam(f, () => Date.parse(at) + 1000, processes(() => ({ ok: true, findings: [{ pid: 4242, reason: "recorded-group" }] })));
  const passes = countSteps(teams);
  try {
    leftover(teams, f.run, at);
    teams.start();
    await waitFor(() => passes.count >= 2, "the scheduler should step the run", 30_000);
    await teams.idle();
    assert.equal(existsSync(cwd), true, "the clone stays while the run records the process");
    assert.equal(teams.get(f.run.id).members.find(item => item.memberId === member.memberId)?.workspaceRemovedAt, undefined);
    assert.equal(teams.get(f.run.id).leftoverProcesses?.state, "unchecked", "an active run takes no census for the record");
    (teams as unknown as Internals).records.get(f.run.id)!.leftover = undefined;
    await waitFor(() => !existsSync(cwd), "the clone should be removed once the record is gone");
    assert.equal(teams.get(f.run.id).status, "implementing");
  } finally { await close(f, teams); }
});

test("a cancelled run with both an unfinished operation and a process an earlier command left waits on both, with one census of each record per removal decision", async () => {
  const f = schedulerFixture();
  const at = settled(f, "cancelled", "Team cancelled.");
  retention(f, { cancelledMinutes: 1 });
  f.writeTeam();
  const seen: ProcessWitness[] = [], alive = new Set([101, 202]);
  let now = Date.parse(at) + 60_001;
  const teams = openTeam(f, () => now, byWitness(alive, seen));
  const passes = countSteps(teams);
  try {
    (teams as unknown as Internals).records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1, witness: witness(101) };
    leftover(teams, f.run, at, witness(202));
    teams.start();
    await waitFor(() => teams.get(f.run.id).pendingOperation?.processes === "running", "the host should look for the operation's processes", 30_000);
    await teams.idle();
    const before = seen.length;
    await assert.rejects(teams.removeRun(f.run.id), (error: unknown) => error instanceof TeamError && error.code === "team-leftover-running");
    assert.deepEqual(seen.slice(before).map(recorded => recorded.processes.map(item => item.pid).join(",")).sort(), ["101", "202"], "one removal decision takes one census of each record");
    now += 10 * 60_000;
    const looked = seen.length, stepped = passes.count;
    await waitFor(() => seen.length > looked && passes.count >= stepped + 2, "the host should look again after ten minutes", 30_000);
    await teams.idle();
    assert.equal(existsSync(runDirectory(f.run)), true);
    alive.clear();
    now += 10 * 60_000;
    await waitFor(() => !existsSync(runDirectory(f.run)), "the directories should be removed once the census finds neither record's processes", 30_000);
  } finally { await close(f, teams); }
});
