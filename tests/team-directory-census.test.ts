import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Manager } from "../packages/host/src/manager.js";
import { directoryCensus, excuseEarlier, newWitness, type CensusFinding, type HostProcesses, type ProcessWitness } from "../packages/host/src/process-census.js";
import type { StoredLeftover } from "../packages/host/src/team-leftover.js";
import { DEFAULT_TEAM_RETENTION, type TeamRun } from "../packages/host/src/team-types.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type StoredRun = { run: TeamRun; pending?: { id: string; kind: "check"; revision: number; witness: ProcessWitness }; leftover?: StoredLeftover };
type Internals = { records: Map<string, StoredRun> };

const POSIX = { timeout: 120_000, skip: process.platform === "win32" && "the census reads POSIX process tables" };
const code = (expected: string) => (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === expected;
const runDirectory = (run: TeamRun) => dirname(run.workspace);

function cancelled(f: Fixture, cancelledMinutes = 1) {
  const at = new Date().toISOString();
  f.run.status = "cancelled";
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: "Team cancelled." });
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes };
  f.writeTeam();
  return at;
}

function open(f: Fixture, now: () => number, processes?: HostProcesses) {
  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now, ...(processes ? { processes } : {}) });
  return { teams, stored: (teams as unknown as Internals).records.get(f.run.id)! };
}

function witness(pid: number): ProcessWitness {
  return { ...newWitness(), processes: [{ pid, start: `start-${pid}` }], sessions: [pid], groups: [pid] };
}

function standIn(findings: CensusFinding[]): HostProcesses {
  return { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async (_witness, _directory, _prefix, earlier) => ({ ok: true, findings: await excuseEarlier(findings, earlier, async () => undefined) }) };
}

async function sleeperIn(directory: string) {
  const child = spawn("sh", ["-c", "cd \"$1\" && exec sleep 600", "sh", directory], { stdio: "ignore" });
  const pid = child.pid!;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await delay(50)) {
    const seen = await directoryCensus(directory);
    if (seen.ok && seen.findings.some(finding => finding.pid === pid && finding.reason === "working-directory")) return child;
  }
  child.kill("SIGKILL");
  assert.fail("the test process should enter the run directory");
}

async function ended(child: ChildProcess) {
  const gone = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await gone;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 30_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await delay(25)) if (check()) return;
  assert.fail(message);
}

test("a cancelled run with no witness and no leftover record is not removed while a process uses its directory, and is removed once it ends", POSIX, async () => {
  const f = schedulerFixture();
  const at = cancelled(f, 600);
  const { teams, stored } = open(f, () => Date.parse(at) + 1000);
  let child: ChildProcess | undefined;
  try {
    assert.equal(stored.leftover, undefined);
    child = await sleeperIn(runDirectory(f.run));
    await assert.rejects(teams.removeRun(f.run.id), code("team-leftover-running"));
    assert.equal(existsSync(runDirectory(f.run)), true, "the directories stay");
    const held = teams.get(f.run.id);
    assert.equal(held.leftoverProcesses?.state, "in-use");
    const text = held.events.at(-1)?.text ?? "";
    assert.match(text, /1 process\(es\) use this run's directories\. The host keeps them until a census finds none\./);
    assert.doesNotMatch(text, /earlier command|left behind/);
    await ended(child);
    child = undefined;
    await teams.removeRun(f.run.id);
    assert.equal(existsSync(runDirectory(f.run)), false);
    assert.equal(teams.statuses().some(row => row.id === f.run.id), false);
  } finally {
    if (child) await ended(child);
    await teams.close();
    f.close();
  }
});

test("retention keeps a run's directories while a process uses them, the view shows the hold, and a later census that finds none removes them", POSIX, async () => {
  const f = schedulerFixture();
  const at = cancelled(f, 1);
  let now = Date.parse(at) + 60_001;
  const { teams, stored } = open(f, () => now);
  let child: ChildProcess | undefined;
  try {
    child = await sleeperIn(runDirectory(f.run));
    teams.start();
    await waitFor(() => teams.get(f.run.id).leftoverProcesses?.state === "in-use", "the view should show the hold");
    await teams.idle();
    assert.equal(existsSync(runDirectory(f.run)), true, "retention keeps the directories");
    assert.equal(teams.get(f.run.id).workspaceRemovedAt, undefined);
    assert.equal(stored.leftover?.directory, true);
    await ended(child);
    child = undefined;
    now += 10 * 60_000;
    await waitFor(() => !existsSync(runDirectory(f.run)), "retention removes the directories once a census finds none");
  } finally {
    if (child) await ended(child);
    await teams.close();
    f.close();
  }
});

test("a process the census cannot inspect does not hold a run that has a leftover record, and a recorded process still does", async () => {
  const f = schedulerFixture();
  const at = cancelled(f, 600);
  const unreadable = open(f, () => Date.parse(at) + 1000, standIn([{ pid: 999, reason: "unreadable" }]));
  try {
    unreadable.stored.leftover = { since: at, witness: witness(202) };
    await unreadable.teams.removeRun(f.run.id);
    assert.equal(existsSync(runDirectory(f.run)), false, "an uninspectable process does not hold the directories");
  } finally {
    await unreadable.teams.close();
    f.close();
  }
  const g = schedulerFixture();
  const when = cancelled(g, 600);
  const recorded = open(g, () => Date.parse(when) + 1000, standIn([{ pid: 999, reason: "unreadable" }, { pid: 202, reason: "recorded-group" }]));
  try {
    recorded.stored.leftover = { since: when, witness: witness(202) };
    await assert.rejects(recorded.teams.removeRun(g.run.id), code("team-leftover-running"));
    assert.equal(existsSync(runDirectory(g.run)), true);
  } finally {
    await recorded.teams.close();
    g.close();
  }
});

test("the stop fence's operation census still answers unknown for a process it cannot inspect", async () => {
  const f = schedulerFixture();
  const at = cancelled(f, 600);
  const { teams, stored } = open(f, () => Date.parse(at) + 1000, standIn([{ pid: 999, reason: "unreadable" }]));
  try {
    stored.pending = { id: randomUUID(), kind: "check", revision: 1, witness: witness(101) };
    await assert.rejects(teams.removeRun(f.run.id), code("team-operation-running"));
    assert.equal(teams.get(f.run.id).pendingOperation?.processes, "unknown");
    assert.equal(existsSync(runDirectory(f.run)), true);
  } finally {
    await teams.close();
    f.close();
  }
});
