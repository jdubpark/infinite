import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { DEFAULT_TEAM_RETENTION, type TeamRun } from "../packages/host/src/team-types.js";
import { teamCommand, type CommandResult } from "../packages/host/src/team-workspace.js";
import { hostProcesses, type HostProcesses } from "../packages/host/src/process-census.js";
import { unseal } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Witness = { processes: { pid: number; start: string }[]; sessions: number[]; groups: number[] };
type Saved = { run: { status: string }; pending?: { recording?: true; failure?: object; witness?: Witness } };
type Stored = { run: TeamRun; pending?: { recording?: true; witness?: Witness }; census?: { state: string; detail?: string } };
type Internals = {
  records: Map<string, Stored>;
  recorders: Map<string, { inFlight: number; spawning: number }>;
  save: (stored: unknown) => void;
  enqueue: (runId: string, task: () => unknown) => Promise<unknown>;
  operation: (stored: unknown, kind: string, perform: (signal: AbortSignal) => Promise<unknown>, complete: () => void) => void;
};
type Command = { command: string; args: string[] };

const CASE = { timeout: 60_000, skip: process.platform === "win32" && "process groups are POSIX" };

function blockedRunFixture() {
  const f = schedulerFixture();
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, blockedHours: 1 };
  f.writeTeam();
  return f;
}

function openTeam(f: Fixture, options: { now?: () => number; processes?: HostProcesses } = {}) {
  return new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, options);
}

function internalsOf(teams: TeamService) { return teams as unknown as Internals; }

function savedRecord(f: Fixture) {
  return unseal<Saved>(f.key, `team:${f.run.id}`, readFileSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`), "utf8"));
}

function heldStartTokens(reading: Promise<void>): HostProcesses {
  return { ...hostProcesses, start: async pid => { const start = await hostProcesses.start(pid); await reading; return start; } };
}

function stopAtSave(teams: TeamService, f: Fixture, stopsHere: (saved: Saved) => boolean) {
  const internals = internalsOf(teams), save = internals.save, stop: { restore?: () => void } = {};
  internals.save = function (this: unknown, stored: unknown) {
    save.call(this, stored);
    if (!stop.restore && stopsHere(savedRecord(f))) stop.restore = f.blockRecordWrites("team", f.run.id);
  };
  return stop;
}

function failCheckAfter(teams: TeamService, f: Fixture, command: Command) {
  const stored = internalsOf(teams).records.get(f.run.id)!;
  internalsOf(teams).operation(stored, "check", signal => teamCommand(command, f.run.workspace, signal).then(() => {
    throw new TeamError(409, "workspace-operation-failed", "The check failed.");
  }), () => {});
  return stored;
}

async function restartAfterBlockedHours(f: Fixture) {
  let now = Date.now();
  const restarted = openTeam(f, { now: () => now });
  restarted.start();
  await restarted.idle();
  now += 3_600_001;
  return restarted;
}

function handled<T>(promise: Promise<T>) {
  promise.catch(() => {});
  return promise;
}

function runDirectory(run: TeamRun) { return dirname(run.workspace); }

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function outcomeOf(command: Promise<CommandResult> | undefined) {
  return Promise.race([
    command!.then(result => result.interrupted ? "stopped" : `exited ${result.exitCode}`, (error: unknown) => error instanceof TeamError ? error.code : String(error)),
    new Promise(resolve => setTimeout(resolve, 5000, "still running")),
  ]);
}

test("a host stop after a failed operation was saved while the start token of its ended command was still being read holds the run's workspace no longer than the command's processes (INF-505)", CASE, async () => {
  const stops: [string, (saved: Saved, pid: number | undefined) => boolean][] = [
    ["after the failure's save", saved => saved.pending?.failure !== undefined],
    ["after the save that blocked the run", saved => saved.run.status === "blocked"],
    ["after the save of the start token", (saved, pid) => saved.pending?.witness?.processes.some(entry => entry.pid === pid) === true],
  ];
  const outcomes: string[] = [];
  for (const [stop, stopsHere] of stops) {
    const f = blockedRunFixture();
    let release!: () => void, pid: number | undefined, restarted: TeamService | undefined, running = true;
    const reading = new Promise<void>(resolve => { release = resolve; });
    const first = openTeam(f, { processes: heldStartTokens(reading) });
    try {
      const stopped = stopAtSave(first, f, saved => stopsHere(saved, pid));
      const stored = failCheckAfter(first, f, { command: process.execPath, args: ["-e", ""] });
      pid = stored.pending!.witness!.groups[0]!;
      await waitFor(() => stored.run.status === "blocked", `${stop}: the failed check should block the run`);
      release();
      await waitFor(() => stopped.restore !== undefined, `${stop}: the host should stop at that write`);
      running = false;
      await first.close();
      stopped.restore!();
      const saved = savedRecord(f).pending;
      assert.ok(saved?.failure && saved.witness?.groups.includes(pid) && saved.witness.sessions.includes(pid), `${stop}: the saved failure holds command ${pid} as a group and a session`);
      assert.equal(alive(pid), false, `${stop}: command ${pid} has ended`);
      restarted = await restartAfterBlockedHours(f);
      const deadline = Date.now() + 10_000;
      while (restarted.get(f.run.id).status !== "cancelled" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      const census = internalsOf(restarted).records.get(f.run.id)!.census;
      outcomes.push(`${stop}: workspace ${existsSync(runDirectory(f.run)) ? "kept" : "removed"}, run ${restarted.get(f.run.id).status}, processes ${census?.state}${census?.detail ? ` (${census.detail})` : ""}`);
    } finally {
      release();
      if (running) await first.close();
      if (restarted) await restarted.close();
      f.close();
    }
  }
  assert.deepEqual(outcomes, stops.map(([stop]) => `${stop}: workspace removed, run cancelled, processes ended`));
});

test("after a host stop at a failed operation's save, a process left in its command's group and session holds the workspace, and once it ends the workspace is removed in the same boot (INF-505)", CASE, async () => {
  const f = blockedRunFixture();
  const leaderFile = join(dirname(f.config.stateDir), "leader"), leftFile = join(dirname(f.config.stateDir), "left");
  let release!: () => void, left: number | undefined, restarted: TeamService | undefined, running = true;
  const reading = new Promise<void>(resolve => { release = resolve; });
  const first = openTeam(f, { processes: heldStartTokens(reading) });
  try {
    const stopped = stopAtSave(first, f, saved => saved.pending?.failure !== undefined);
    failCheckAfter(first, f, { command: "sh", args: ["-c", `echo $$ > '${leaderFile}'; (cd / && exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > '${leftFile}'`] });
    await waitFor(() => stopped.restore !== undefined, "the host should stop at the failure's save");
    release();
    running = false;
    await first.close();
    stopped.restore!();
    const leader = Number.parseInt(readFileSync(leaderFile, "utf8"), 10);
    left = Number.parseInt(readFileSync(leftFile, "utf8"), 10);
    assert.ok(alive(left) && !alive(leader), `command ${leader} has ended and left process ${left} running`);
    restarted = await restartAfterBlockedHours(f);
    const census = () => internalsOf(restarted!).records.get(f.run.id)!.census?.state;
    await waitFor(() => census() === "running", `the restarted host should find process ${left} by the group and session of command ${leader}`, 10_000);
    await restarted.idle();
    assert.ok(existsSync(runDirectory(f.run)) && restarted.get(f.run.id).status === "blocked", "the workspace is kept while the process runs");
    process.kill(left, "SIGKILL");
    await waitFor(() => !alive(left!), `process ${left} should end`);
    await waitFor(() => restarted!.get(f.run.id).status === "cancelled", "once the process has ended, the run should close in the same boot", 10_000);
    assert.equal(existsSync(runDirectory(f.run)), false);
    assert.equal(census(), "ended");
  } finally {
    release();
    if (left !== undefined && alive(left)) process.kill(left, "SIGKILL");
    if (running) await first.close();
    if (restarted) await restarted.close();
    f.close();
  }
});

test("a failed operation stops its commands: a running one is stopped, one still starting keeps the record incomplete until it is refused before its spawn, and one asked for after the failure never starts (INF-505)", CASE, async () => {
  const f = blockedRunFixture();
  const teams = openTeam(f);
  const internals = internalsOf(teams), stored = internals.records.get(f.run.id)!, save = internals.save;
  const sleep = { command: "sleep", args: ["30"] };
  let failureRecording: boolean | undefined, open!: () => void, failed = false;
  internals.save = function (this: unknown, record: unknown) {
    save.call(this, record);
    const saved = savedRecord(f).pending;
    if (failureRecording === undefined && saved?.failure) failureRecording = saved.recording === true;
  };
  const gate = new Promise<void>(resolve => { open = resolve; });
  const commands: { running?: Promise<CommandResult>; starting?: Promise<CommandResult>; late?: Promise<CommandResult> } = {};
  try {
    internals.operation(stored, "check", signal => {
      void (async () => {
        await waitFor(() => stored.run.status === "blocked", "the failure should block the run", 15_000);
        commands.late = handled(teamCommand(sleep, f.run.workspace, signal));
      })().catch(() => {});
      return (async () => {
        commands.running = handled(teamCommand(sleep, f.run.workspace, signal));
        await waitFor(() => stored.pending?.recording === undefined, "a witness save should mark the record complete once the running command is recorded");
        void internals.enqueue(f.run.id, () => gate);
        commands.starting = handled(teamCommand(sleep, f.run.workspace, signal));
        throw new TeamError(409, "workspace-operation-failed", "The check failed.");
      })().catch(error => {
        failed = true;
        throw error;
      });
    }, () => {});
    await waitFor(() => failed, "the operation should fail");
    await new Promise(resolve => setTimeout(resolve, 50));
    open();
    await waitFor(() => commands.late !== undefined, "a branch should ask for a command after the failure", 15_000);
    const [running, starting, late] = await Promise.all([outcomeOf(commands.running), outcomeOf(commands.starting), outcomeOf(commands.late)]);
    const deadline = Date.now() + 5000;
    while (savedRecord(f).pending?.recording && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual({ failureRecording, running, starting, late, spawned: stored.pending?.witness?.groups.length, recordingAfter: savedRecord(f).pending?.recording === true },
      { failureRecording: true, running: "stopped", starting: "stopped", late: "command-unavailable", spawned: 1, recordingAfter: false });
  } finally {
    open();
    for (const pid of stored.pending?.witness?.groups ?? []) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    await teams.close();
    f.close();
  }
});

test("a command asked for after an operation rejected but before its failure was saved is refused at its turn in the queue, and leaves no count behind (INF-505)", CASE, async () => {
  const f = blockedRunFixture();
  const teams = openTeam(f);
  const internals = internalsOf(teams), stored = internals.records.get(f.run.id)!;
  const sleep = { command: "sleep", args: ["30"] };
  let open!: () => void, failed = false;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const commands: { running?: Promise<CommandResult>; queued?: Promise<CommandResult> } = {};
  try {
    internals.operation(stored, "check", signal => {
      void (async () => {
        await waitFor(() => failed, "the operation should reject", 15_000);
        commands.queued = handled(teamCommand(sleep, f.run.workspace, signal));
      })().catch(() => {});
      return (async () => {
        commands.running = handled(teamCommand(sleep, f.run.workspace, signal));
        await waitFor(() => stored.pending?.recording === undefined, "a witness save should mark the record complete once the running command is recorded");
        void internals.enqueue(f.run.id, () => gate);
        throw new TeamError(409, "workspace-operation-failed", "The check failed.");
      })().catch(error => {
        failed = true;
        throw error;
      });
    }, () => {});
    await waitFor(() => commands.queued !== undefined, "a branch should ask for a command before the failure is saved", 15_000);
    const recorder = internals.recorders.get(f.run.id)!;
    const queued = { inFlight: recorder.inFlight, spawning: recorder.spawning, failureSaved: savedRecord(f).pending?.failure !== undefined };
    open();
    const [running, refused] = await Promise.all([outcomeOf(commands.running), outcomeOf(commands.queued)]);
    assert.deepEqual({ queued, running, refused, after: { inFlight: recorder.inFlight, spawning: recorder.spawning }, spawned: stored.pending?.witness?.groups.length },
      { queued: { inFlight: 1, spawning: 1, failureSaved: false }, running: "stopped", refused: "command-unavailable", after: { inFlight: 0, spawning: 0 }, spawned: 1 });
  } finally {
    open();
    for (const pid of stored.pending?.witness?.groups ?? []) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    await teams.close();
    f.close();
  }
});
