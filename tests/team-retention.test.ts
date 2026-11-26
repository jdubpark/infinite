import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { DEFAULT_TEAM_RETENTION, hostClosedBlockedReason, type TeamMember, type TeamRun } from "../packages/host/src/team-types.js";
import type { VolumeUsage } from "../packages/host/src/storage.js";
import { commandScope, removeMemberWorkspace, removeTeamWorkspace, teamCommand } from "../packages/host/src/team-workspace.js";
import { newWitness, type CensusResult, type HostProcesses } from "../packages/host/src/process-census.js";
import { unseal } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type ServiceOptions = { now?: () => number; volumeUsage?: (path: string) => Promise<VolumeUsage>; processes?: HostProcesses };

function scriptedProcesses(census: () => CensusResult): HostProcesses {
  return { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start", census: async () => census() };
}

function savedRecord(f: ReturnType<typeof schedulerFixture>) {
  return unseal<{ pending?: { recording?: true; witness?: { processes: { pid: number; start: string }[]; sessions: number[]; groups: number[] } } }>(
    f.key, `team:${f.run.id}`, readFileSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`), "utf8"));
}

function openTeam(f: ReturnType<typeof schedulerFixture>, options: ServiceOptions = {}) {
  return new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, options);
}

function retention(f: ReturnType<typeof schedulerFixture>, values: Partial<typeof DEFAULT_TEAM_RETENTION>) {
  f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, ...values };
}

function runDirectory(run: TeamRun) { return dirname(run.workspace); }

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function close(f: ReturnType<typeof schedulerFixture>, teams: TeamService) {
  teams.close();
  await teams.idle();
  f.close();
}

test("merged workspaces are removed after members stop and the run rejects bundles", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "merged";
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    teams.start();
    await waitFor(() => !existsSync(runDirectory(f.run)), "merged workspace should be removed on the scheduler");
    await teams.idle();
    const view = teams.get(f.run.id);
    assert.ok(view.workspaceRemovedAt);
    assert.ok(view.events.some(event => event.text.startsWith("Workspaces removed under the retention policy")));
    await assert.rejects(teams.bundle(f.run.id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-workspace-removed");
  } finally { await close(f, teams); }
});

test("cancelled runs lose their workspaces and sealed record after cancelledMinutes", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "cancelled";
  f.run.updatedAt = at;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: "Team cancelled." });
  retention(f, { cancelledMinutes: 1 });
  let now = Date.parse(at);
  f.writeTeam();
  const teams = openTeam(f, { now: () => now });
  try {
    teams.start();
    await teams.idle();
    assert.ok(existsSync(runDirectory(f.run)), "the settle window must be honored");
    now += 60_001;
    await waitFor(() => !teams.statuses().some(row => row.id === f.run.id), "cancelled run should be deleted after its retention window");
    assert.equal(existsSync(runDirectory(f.run)), false);
    assert.equal(existsSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`)), false);
    assert.throws(() => teams.get(f.run.id), (error: unknown) => error instanceof TeamError && error.status === 404 && error.code === "team-not-found");
  } finally { await close(f, teams); }
});

test("stale blocked runs close after workspace removal and keep one host-closed event across restart", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  const blocker = "A worker reported a blocker.";
  f.run.status = "blocked";
  f.run.updatedAt = at;
  f.run.reason = blocker;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: blocker });
  retention(f, { blockedHours: 1, cancelledMinutes: 1 });
  let now = Date.parse(at);
  f.writeTeam();
  let teams = openTeam(f, { now: () => now });
  try {
    teams.start();
    await teams.idle();
    assert.ok(existsSync(runDirectory(f.run)), "blocked workspaces stay available before the configured window");
    assert.equal(teams.get(f.run.id).status, "blocked");
    now += 3_600_001;
    await waitFor(() => !existsSync(runDirectory(f.run)), "blocked workspace should be removed after blockedHours");
    await teams.idle();
    assert.equal(existsSync(runDirectory(f.run)), false);
    const closedReason = hostClosedBlockedReason(1, blocker);
    await waitFor(() => teams.get(f.run.id).status === "cancelled", "removed blocked run should be closed by the host");
    const closed = teams.get(f.run.id);
    assert.ok(closed.workspaceRemovedAt);
    assert.equal(closed.reason, closedReason);
    assert.equal(closed.events.filter(event => event.text === closedReason).length, 1);
    assert.equal(closed.resumable, false);

    teams.close(); await teams.idle();
    teams = openTeam(f, { now: () => now });
    teams.start(); await teams.idle();
    await waitFor(() => teams.get(f.run.id).status === "cancelled", "the closed run should survive restart");
    assert.equal(teams.get(f.run.id).events.filter(event => event.text === closedReason).length, 1);
    now += 60_001;
    await waitFor(() => !teams.statuses().some(row => row.id === f.run.id), "the closed run should use cancelledMinutes before deleting its record");
    assert.equal(existsSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`)), false);
  } finally { await close(f, teams); }
});

test("a blocked run with an unresolved operation keeps its workspace and stays blocked past blockedHours", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = "A worker reported a blocker.";
  f.run.members.forEach(member => { member.status = "stopped"; });
  retention(f, { blockedHours: 1 }); f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 3_600_001 });
  try {
    (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1 };
    teams.start(); await teams.idle();
    assert.equal(existsSync(runDirectory(f.run)), true);
    assert.equal(teams.get(f.run.id).status, "blocked");
  } finally { await close(f, teams); }
});

test("a blocked run keeps its workspace while the host sees a process of the interrupted check or a process using the run directory, and closes once it sees neither", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  const blocker = "A worker reported a blocker.";
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = blocker;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: blocker });
  retention(f, { blockedHours: 1 }); f.writeTeam();
  let result: CensusResult = { ok: true, findings: [{ pid: 4242, reason: "recorded-session" }] };
  let now = Date.parse(at) + 3_600_001, looks = 0;
  const teams = openTeam(f, { now: () => now, processes: scriptedProcesses(() => { looks++; return result; }) });
  const eventCount = (text: string) => teams.get(f.run.id).events.filter(event => event.text === text).length;
  const sees = "The host still sees 1 process(es) that match its record of the interrupted check operation.";
  const inUse = "The host sees 1 process(es) using this run's directory. None matches its record of the interrupted check operation.";
  try {
    (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1, witness: newWitness() };
    teams.start(); await teams.idle();
    await waitFor(() => eventCount(sees) === 1, "the host should report the process it still sees");
    await new Promise(resolve => setTimeout(resolve, 1200)); await teams.idle();
    assert.equal(eventCount(sees), 1, "an unchanged census adds no second event");
    assert.equal(looks, 1, "a look that found a process stands until the next scheduled look, though the pass runs on every tick");
    assert.equal(teams.get(f.run.id).pendingOperation?.processes, "running");

    result = { ok: true, findings: [{ pid: 4243, reason: "working-directory" }] }; now += 10 * 60_000;
    await waitFor(() => eventCount(inUse) === 1, "the host should report a process that uses the run directory as such");
    assert.equal(teams.get(f.run.id).pendingOperation?.processes, "in-use");
    assert.equal(existsSync(runDirectory(f.run)), true);
    assert.equal(teams.get(f.run.id).status, "blocked");

    result = { ok: true, findings: [] }; now += 10 * 60_000;
    await waitFor(() => teams.get(f.run.id).status === "cancelled", "a blocked run should close once the host sees no process");
    assert.equal(existsSync(runDirectory(f.run)), false);
    assert.equal(teams.get(f.run.id).reason, hostClosedBlockedReason(1, blocker));
    assert.equal(eventCount("The host sees no process that matches its record of the interrupted check operation, and none using this run's directory. The intent stays recorded and is not replayed."), 1);
  } finally { await close(f, teams); }
});

test("a blocked run whose census cannot finish keeps its workspace and says the host cannot tell", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = "A worker reported a blocker.";
  f.run.members.forEach(member => { member.status = "stopped"; });
  retention(f, { blockedHours: 1 }); f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 3_600_001, processes: scriptedProcesses(() => ({ ok: false, problem: "The process table is unreadable" })) });
  const cannotTell = "The host cannot tell whether the interrupted check operation left processes: The process table is unreadable.";
  try {
    (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1, witness: newWitness() };
    teams.start(); await teams.idle();
    await waitFor(() => teams.get(f.run.id).events.some(event => event.text === cannotTell), "the host should say when it cannot finish its census");
    await new Promise(resolve => setTimeout(resolve, 1200)); await teams.idle();
    assert.equal(teams.get(f.run.id).events.filter(event => event.text === cannotTell).length, 1);
    assert.equal(existsSync(runDirectory(f.run)), true);
    assert.equal(teams.get(f.run.id).status, "blocked");
  } finally { await close(f, teams); }
});

test("a blocked run stays blocked when the census finds only a process it cannot inspect, and the host does not call it the check's process", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = "A worker reported a blocker.";
  f.run.members.forEach(member => { member.status = "stopped"; });
  retention(f, { blockedHours: 1 }); f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 3_600_001, processes: scriptedProcesses(() => ({ ok: true, findings: [{ pid: 4242, reason: "unreadable" }] })) });
  const cannotTell = "The host cannot tell whether the interrupted check operation left processes: 1 process(es) of the accounts it inspects could not be inspected.";
  try {
    (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1, witness: newWitness() };
    teams.start(); await teams.idle();
    await waitFor(() => teams.get(f.run.id).events.some(event => event.text === cannotTell), "the host should say when it cannot finish its census");
    await new Promise(resolve => setTimeout(resolve, 1200)); await teams.idle();
    assert.equal(teams.get(f.run.id).events.filter(event => event.text === cannotTell).length, 1);
    assert.equal(existsSync(runDirectory(f.run)), true);
    assert.equal(teams.get(f.run.id).status, "blocked");
  } finally { await close(f, teams); }
});

test("a command inside a command scope waits for the scope before it starts and reports its process id; outside one nothing is reported", async () => {
  const seen: (string | number | undefined)[] = [];
  const scope = { starting: () => new Promise<void>(resolve => setTimeout(() => { seen.push("announced"); resolve(); }, 30)), started: (pid: number | undefined) => { seen.push(pid); } };
  const scoped = await commandScope.run(scope, () => teamCommand({ command: process.execPath, args: ["-e", ""] }, process.cwd()));
  assert.equal(scoped.exitCode, 0);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], "announced", "the command starts only after the scope has announced it");
  assert.ok(typeof seen[1] === "number" && seen[1] > 0);
  const refused = { starting: () => Promise.reject(new Error("not announced")), started: () => { seen.push("started"); } };
  await assert.rejects(commandScope.run(refused, () => teamCommand({ command: process.execPath, args: ["-e", ""] }, process.cwd())), /not announced/);
  const unscoped = await teamCommand({ command: process.execPath, args: ["-e", ""] }, process.cwd());
  assert.equal(unscoped.exitCode, 0);
  assert.equal(seen.length, 2, "a command that could not be announced does not start, and one outside a scope reports nothing");
});

test("verification reconciliation is refused while the host sees the interrupted check, and once workspace removal has started", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  const interrupted = "The host restarted during a workspace or verification operation. Inspect the isolated workspace before starting a new team; the operation will not be replayed.";
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = interrupted; f.run.headCommit = f.run.baseCommit;
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.writeTeam();
  let result: CensusResult = { ok: true, findings: [{ pid: 4242, reason: "recorded-process" }, { pid: 4243, reason: "open-file" }] };
  const teams = openTeam(f, { processes: scriptedProcesses(() => result) });
  const pendingId = randomUUID();
  const body = () => ({ requestId: randomUUID(), revision: 1, pendingId, headCommit: f.run.baseCommit,
    attestation: { boundary: "check-only", processesStopped: true, text: "Confirmed the interrupted check is quiescent." } });
  try {
    const stored = (teams as unknown as { records: Map<string, { run: TeamRun; pending?: unknown; workspaceRemovedAt?: string }> }).records.get(f.run.id)!;
    stored.pending = { id: pendingId, kind: "check", revision: 1, witness: newWitness() };
    await assert.rejects(teams.reconcileVerification(f.run.id, body()), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-operation-running" &&
      error.message === "The host still sees 1 process(es) that match its record of the interrupted check. Reconcile verification after they have exited.");
    assert.ok(stored.pending, "a refused reconciliation keeps the pending check");

    result = { ok: true, findings: [{ pid: 4243, reason: "open-file" }, { pid: 4244, reason: "working-directory" }] };
    await assert.rejects(teams.reconcileVerification(f.run.id, body()), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-directory-in-use" &&
      error.message === "The host sees 2 process(es) using this run's directory. Reconcile verification after they have exited or left it.");

    stored.run.workspaceRemovedAt = at;
    await assert.rejects(teams.reconcileVerification(f.run.id, body()), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-workspace-removed");
  } finally { await close(f, teams); }
});

test("an operation's intent says its record may be incomplete until a save holds the command it started", async () => {
  const f = schedulerFixture();
  f.writeTeam();
  const teams = openTeam(f, { processes: scriptedProcesses(() => ({ ok: true, findings: [] })) });
  try {
    const internals = teams as unknown as { records: Map<string, { pending?: { recording?: true; witness?: { processes: { pid: number; start: string }[]; sessions: number[]; groups: number[] } } }>;
      operation: (stored: unknown, kind: string, perform: () => Promise<unknown>, complete: () => void) => void };
    const stored = internals.records.get(f.run.id)!;
    internals.operation(stored, "check", () => teamCommand({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 1500)"] }, process.cwd()), () => {});
    const pid = stored.pending!.witness!.sessions[0]!;
    assert.ok(pid > 0, "the command's session and group are recorded as it starts");
    assert.deepEqual(stored.pending!.witness!.groups, [pid]);
    assert.equal(savedRecord(f).pending?.recording, true);
    assert.deepEqual(savedRecord(f).pending?.witness?.sessions, []);
    await waitFor(() => savedRecord(f).pending !== undefined && savedRecord(f).pending!.recording === undefined, "the save that holds the command should close the record");
    assert.deepEqual(savedRecord(f).pending?.witness?.sessions, [pid]);
    assert.deepEqual(savedRecord(f).pending?.witness?.processes, [{ pid, start: "test-start" }]);
    await waitFor(() => stored.pending === undefined, "the operation should finish and clear its intent");
  } finally { await close(f, teams); }
});

test("a host stop inside a command's drain signals nothing, and after a restart the census still sees what the command left", { skip: process.platform === "win32" && "process groups are POSIX" }, async t => {
  const f = schedulerFixture();
  f.writeTeam();
  const directory = runDirectory(f.run);
  const leaderFile = join(directory, "leader"), leftFile = join(directory, "left"), release = join(directory, "release");
  const pidIn = (file: string) => { const text = existsSync(file) ? readFileSync(file, "utf8") : ""; return text.endsWith("\n") ? Number.parseInt(text, 10) : undefined; };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const realSetTimeout = globalThis.setTimeout;
  const waitReal = async (check: () => boolean, message: string, timeoutMs = 10_000) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (check()) return;
      await new Promise(resolve => realSetTimeout(resolve, 10));
    }
    assert.fail(message);
  };
  type Internals = { records: Map<string, { pending?: unknown }>; operation: (stored: unknown, kind: string, perform: (signal: AbortSignal) => Promise<unknown>, complete: () => void) => void;
    refreshOperationCensus: (stored: unknown, force: boolean) => Promise<string | undefined> };
  const teams = openTeam(f);
  let restarted: TeamService | undefined;
  try {
    const internals = teams as unknown as Internals;
    const stored = internals.records.get(f.run.id)!;
    const script = `echo $$ > '${leaderFile}'; sleep 30 & echo $! > '${leftFile}'; i=0; while [ ! -f '${release}' ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i + 1)); done; exit 0`;
    let commandSettled = false;
    internals.operation(stored, "check", signal => teamCommand({ command: "sh", args: ["-c", script] }, f.run.workspace, signal).finally(() => { commandSettled = true; }), () => {});
    await waitFor(() => pidIn(leftFile) !== undefined && savedRecord(f).pending?.recording === undefined && (savedRecord(f).pending?.witness?.sessions.length ?? 0) > 0,
      "the saved intent should hold the command", 10_000);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    writeFileSync(release, "");
    const leader = pidIn(leaderFile)!;
    await waitReal(() => !alive(leader), "the leader exits once released", 10_000);
    assert.equal(commandSettled, false, "the command stays in its drain until the host stops");
    teams.close();
    await teams.idle();
    t.mock.timers.tick(300);
    t.mock.timers.reset();
    assert.ok(stored.pending, "a stop during the drain leaves the operation's intent for the next start");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(alive(pidIn(leftFile)!), true, "the host stop signalled nothing after the leader's exit");
    restarted = openTeam(f);
    const restartedInternals = restarted as unknown as Internals;
    assert.equal(await restartedInternals.refreshOperationCensus(restartedInternals.records.get(f.run.id)!, true), "running", "the census finds the sleep in the recorded group");
  } finally {
    t.mock.timers.reset();
    for (const pid of [pidIn(leaderFile), pidIn(leftFile)])
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    if (restarted) { restarted.close(); await restarted.idle(); }
    else teams.close();
    f.close();
  }
});

test("a blocked run whose intent was still recording when the host stopped stays blocked though the host finds no process, unless the host has rebooted since", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = "A worker reported a blocker.";
  f.run.members.forEach(member => { member.status = "stopped"; });
  retention(f, { blockedHours: 1 }); f.writeTeam();
  let now = Date.parse(at) + 3_600_001;
  const teams = openTeam(f, { now: () => now, processes: scriptedProcesses(() => ({ ok: true, findings: [] })) });
  const cannotTell = "The host cannot tell whether the interrupted check operation left processes: the host stopped while the operation was starting a command, so its record of the operation's processes may be incomplete.";
  try {
    const witness = newWitness();
    (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!.pending = { id: randomUUID(), kind: "check", revision: 1, witness, recording: true };
    teams.start(); await teams.idle();
    await waitFor(() => teams.get(f.run.id).events.some(event => event.text === cannotTell), "the host should say that its record may be incomplete");
    await new Promise(resolve => setTimeout(resolve, 1200)); await teams.idle();
    assert.equal(existsSync(runDirectory(f.run)), true);
    assert.equal(teams.get(f.run.id).status, "blocked");

    witness.boot = "an-earlier-boot"; now += 10 * 60_000;
    await waitFor(() => teams.get(f.run.id).status === "cancelled", "after a reboot the run should close once the host sees no process");
    assert.equal(existsSync(runDirectory(f.run)), false);
  } finally { await close(f, teams); }
});

test("a blocked run of an ended goal, with its workspace already removed, closes on the first sweep", async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 3_600_001).toISOString();
  const blocker = "A worker reported a blocker.";
  f.run.status = "blocked"; f.run.updatedAt = at; f.run.reason = blocker; f.run.workspaceRemovedAt = at; f.run.goal = {};
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: blocker });
  rmSync(runDirectory(f.run), { recursive: true, force: true });
  retention(f, { blockedHours: 1 }); f.writeTeam();
  const teams = openTeam(f, { ownerActive: () => false });
  try {
    teams.start(); await teams.idle();
    const closed = teams.get(f.run.id);
    const reason = hostClosedBlockedReason(1, blocker);
    assert.equal(closed.status, "cancelled");
    assert.equal(closed.reason, reason);
    assert.equal(closed.events.filter(event => event.text === reason).length, 1);
  } finally { await close(f, teams); }
});

test("integrated stopped member copies are removed while a pending operation source stays in place", async () => {
  const f = schedulerFixture();
  f.run.status = "implementing";
  f.run.headCommit = f.run.baseCommit;
  const membersRoot = join(runDirectory(f.run), "members");
  mkdirSync(membersRoot, { recursive: true });
  const baseMember = f.run.members[0]!;
  const makeMember = (taskId: string, title: string): TeamMember => {
    const memberId = randomUUID();
    const cwd = join(membersRoot, memberId);
    mkdirSync(cwd);
    return { ...structuredClone(baseMember), memberId, sessionId: randomUUID(), revision: 1, role: "implementer", taskId, title,
      status: "stopped", cwd, report: { kind: "result", summary: "Validated task result." } };
  };
  const integrated = makeMember("done", "implementer: done");
  const pendingSource = makeMember("pending", "implementer: pending");
  f.run.members.push(integrated, pendingSource);
  f.run.tasks = [
    { id: "done", title: "Completed task", instructions: "Complete the task", paths: ["src"], dependsOn: [], revision: 1, status: "integrated", memberId: integrated.memberId, commit: f.run.baseCommit },
    { id: "pending", title: "Pending source task", instructions: "Complete the task", paths: ["src"], dependsOn: [], revision: 1, status: "integrated", memberId: pendingSource.memberId, commit: f.run.baseCommit },
  ];
  const at = new Date().toISOString();
  f.run.updatedAt = at;
  f.run.events.push({ at, text: `${integrated.title} reported a result; its validated changes were integrated.` });
  f.run.events.push({ at, text: `${pendingSource.title} reported a result; its validated changes were integrated.` });
  retention(f, { memberMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    const stored = (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!;
    stored.pending = { id: randomUUID(), kind: "result", revision: 1, source: { memberId: pendingSource.memberId, role: "implementer", cwd: pendingSource.cwd,
      baseCommit: f.run.baseCommit, headCommit: f.run.headCommit, workspace: "integration" } };
    teams.start();
    await waitFor(() => !existsSync(integrated.cwd), "the integrated member clone should be removed");
    await teams.idle();
    assert.equal(existsSync(pendingSource.cwd), true, "the pending operation's source clone must remain");
    assert.ok(teams.get(f.run.id).members.find(member => member.memberId === integrated.memberId)?.workspaceRemovedAt);
    assert.equal(teams.get(f.run.id).status, "implementing");
  } finally { await close(f, teams); }
});

test("member retention removes an integrated clone at its recorded recovery path", async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  const memberId = randomUUID();
  const cwd = join(runDirectory(f.run), "recovery", "members", memberId);
  mkdirSync(cwd, { recursive: true });
  const receiptDir = join(f.config.stateDir, "recovered-member-receipts");
  mkdirSync(receiptDir, { recursive: true });
  f.config.teams!.commandPrefix = { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", receiptDir] };
  const base = f.run.members[0]!;
  const member: TeamMember = { ...base, memberId, sessionId: randomUUID(), revision: 1, role: "implementer", taskId: "integrated",
    title: "Implementer: integrated", status: "stopped", cwd, report: { kind: "result", summary: "Validated task result." } };
  f.run.status = "implementing";
  f.run.updatedAt = at;
  f.run.members = [member];
  f.run.tasks = [{ id: "integrated", title: "Integrated task", instructions: "Complete the task", paths: ["src"], dependsOn: [], revision: 1,
    status: "integrated", memberId, commit: f.run.baseCommit }];
  f.run.events.push({ at, text: `${member.title} reported a result; its validated changes were integrated.` });
  retention(f, { memberMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    const stored = (teams as unknown as { records: Map<string, unknown> }).records.get(f.run.id)!;
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    await teams.idle();
    assert.equal(existsSync(cwd), false);
    assert.ok(teams.get(f.run.id).members.find(item => item.memberId === memberId)?.workspaceRemovedAt);
    assert.ok(teams.get(f.run.id).events.some(event => event.text.includes("Member workspace removed under the retention policy")));
    const [line] = readFileSync(join(receiptDir, "commands.jsonl"), "utf8").trim().split("\n");
    assert.deepEqual(JSON.parse(line!), { command: "rm", args: ["-rf", "--", memberId], cwd: dirname(cwd) });
  } finally { await close(f, teams); }
});

test("each successful member cleanup records its own completion event", async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString(), base = f.run.members[0]!;
  const members = ["first", "second"].map((taskId): TeamMember => {
    const memberId = randomUUID(), cwd = join(runDirectory(f.run), "members", memberId);
    mkdirSync(cwd, { recursive: true });
    return { ...base, memberId, sessionId: randomUUID(), revision: 1, role: "implementer", taskId, title: `Implementer: ${taskId}`,
      status: "stopped", cwd, report: { kind: "result", summary: "Validated task result." } };
  });
  f.run.status = "implementing";
  f.run.updatedAt = at;
  f.run.members = members;
  f.run.tasks = members.map(member => ({ id: member.taskId!, title: member.taskId!, instructions: "Complete the task", paths: ["src"], dependsOn: [],
    revision: 1, status: "integrated", memberId: member.memberId, commit: f.run.baseCommit }));
  f.run.events.push(...members.map(member => ({ at, text: `${member.title} reported a result; its validated changes were integrated.` })));
  retention(f, { memberMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    const stored = (teams as unknown as { records: Map<string, unknown> }).records.get(f.run.id)!;
    for (const member of members) {
      await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
      await teams.idle();
      assert.equal(existsSync(member.cwd), false);
    }
    const events = teams.get(f.run.id).events.filter(event => event.text.startsWith("Member workspace removed under the retention policy"));
    assert.equal(events.length, 2);
    for (const member of members) assert.ok(events.some(event => event.text.includes(`(member ${member.memberId})`)));
  } finally { await close(f, teams); }
});

test("a missing recorded member clone is marked removed without a workspace event", async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  const memberId = randomUUID(), cwd = join(runDirectory(f.run), "members", memberId), base = f.run.members[0]!;
  const member: TeamMember = { ...base, memberId, sessionId: randomUUID(), revision: 1, role: "implementer", taskId: "integrated",
    title: "Implementer: integrated", status: "stopped", cwd, report: { kind: "result", summary: "Validated task result." } };
  f.run.status = "implementing";
  f.run.updatedAt = at;
  f.run.members = [member];
  f.run.tasks = [{ id: "integrated", title: "Integrated task", instructions: "Complete the task", paths: ["src"], dependsOn: [], revision: 1,
    status: "integrated", memberId, commit: f.run.baseCommit }];
  f.run.events.push({ at, text: `${member.title} reported a result; its validated changes were integrated.` });
  retention(f, { memberMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    const stored = (teams as unknown as { records: Map<string, unknown> }).records.get(f.run.id)!;
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    assert.ok(teams.get(f.run.id).members.find(item => item.memberId === memberId)?.workspaceRemovedAt);
    assert.equal(teams.get(f.run.id).events.some(event => event.text.includes("Member workspace")), false);
  } finally { await close(f, teams); }
});

test("retention retries a persisted run-removal intent after restart", async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  f.run.status = "cancelled";
  f.run.updatedAt = at;
  f.run.members = [];
  f.run.workspaceRemovedAt = at;
  f.run.events.push({ at, text: "Workspace removal under the retention policy started." });
  retention(f, { cancelledMinutes: 0 });
  f.writeTeam();
  assert.equal(existsSync(runDirectory(f.run)), true, "the persisted intent still has a workspace to clean up");
  const teams = openTeam(f);
  try {
    const stored = (teams as unknown as { records: Map<string, unknown> }).records.get(f.run.id)!;
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    await teams.idle();
    assert.equal(existsSync(runDirectory(f.run)), false);
    assert.throws(() => teams.get(f.run.id), (error: unknown) => error instanceof TeamError && error.code === "team-not-found");
  } finally { await close(f, teams); }
});

test("retention retries a persisted member-removal intent after restart", async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  const memberId = randomUUID(), cwd = join(runDirectory(f.run), "members", memberId), base = f.run.members[0]!;
  mkdirSync(cwd, { recursive: true });
  const member: TeamMember = { ...base, memberId, sessionId: randomUUID(), revision: 1, role: "implementer", taskId: "integrated",
    title: "Implementer: integrated", status: "stopped", cwd, workspaceRemovedAt: at, report: { kind: "result", summary: "Validated task result." } };
  f.run.status = "implementing";
  f.run.updatedAt = at;
  f.run.members = [member];
  f.run.tasks = [{ id: "integrated", title: "Integrated task", instructions: "Complete the task", paths: ["src"], dependsOn: [], revision: 1,
    status: "integrated", memberId, commit: f.run.baseCommit }];
  f.run.events.push({ at, text: `${member.title} reported a result; its validated changes were integrated.` });
  f.run.events.push({ at, text: "Member workspace removal under the retention policy started." });
  retention(f, { memberMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f);
  try {
    const stored = (teams as unknown as { records: Map<string, unknown> }).records.get(f.run.id)!;
    await (teams as unknown as { retire(record: unknown): Promise<void> }).retire(stored);
    await teams.idle();
    assert.equal(existsSync(cwd), false);
    assert.ok(teams.get(f.run.id).events.some(event => event.text.includes("Member workspace removed under the retention policy")));
  } finally { await close(f, teams); }
});

test("removeRun refuses an implementing team", async () => {
  const f = schedulerFixture();
  f.run.status = "implementing";
  f.writeTeam();
  const teams = openTeam(f);
  try {
    await assert.rejects(teams.removeRun(f.run.id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-active");
  } finally { await close(f, teams); }
});

test("removeRun deletes a settled record even when preparation never created its workspace", async () => {
  const f = schedulerFixture();
  f.run.status = "no-change";
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.writeTeam();
  const teams = openTeam(f);
  try {
    rmSync(runDirectory(f.run), { recursive: true, force: true });
    const removed = await teams.removeRun(f.run.id);
    assert.equal(removed.status, "no-change");
    assert.ok(removed.workspaceRemovedAt);
    assert.equal(existsSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`)), false);
    assert.throws(() => teams.get(f.run.id), (error: unknown) => error instanceof TeamError && error.code === "team-not-found");
  } finally { await close(f, teams); }
});

test("createRun refuses a low storage floor before it creates a workspace", async () => {
  const f = schedulerFixture();
  f.config.projects[0]!.team = { checks: [{ command: "true", args: [] }] };
  f.config.agents.demo = { command: process.execPath, args: [] };
  f.config.teams!.storageFloor = { inodes: 100, bytes: 100 };
  const teams = openTeam(f, { volumeUsage: async path => ({ path, totalBytes: 1000, availableBytes: 1000, totalInodes: 1000, availableInodes: 10 }) });
  try {
    const requestId = randomUUID();
    await assert.rejects(teams.create({ requestId, projectId: "fixture", provider: "demo", title: "Low storage", objective: "Refuse admission", parallelism: 1 }),
      (error: unknown) => error instanceof TeamError && error.status === 507 && error.code === "host-storage-low");
    assert.equal(readdirSync(f.config.teams!.workspaceDir).some(name => name.includes(requestId.slice(0, 8))), false);
  } finally { await close(f, teams); }
});

test("createRun measures the nearest existing ancestor when the workspace root is new", async () => {
  const f = schedulerFixture();
  f.config.projects[0]!.team = { checks: [{ command: "true", args: [] }] };
  f.config.agents.demo = { command: process.execPath, args: [] };
  const existingRoot = f.config.teams!.workspaceDir;
  const newRoot = join(existingRoot, "not-created", "nested");
  f.config.teams!.workspaceDir = newRoot;
  f.config.teams!.storageFloor = { inodes: 100, bytes: 100 };
  let sampled: string | undefined;
  const teams = openTeam(f, { volumeUsage: async path => {
    sampled = path;
    return { path, totalBytes: 1000, availableBytes: 1000, totalInodes: 1000, availableInodes: 10 };
  } });
  try {
    await assert.rejects(teams.create({ requestId: randomUUID(), projectId: "fixture", provider: "demo", title: "Low storage", objective: "Refuse admission", parallelism: 1 }),
      (error: unknown) => error instanceof TeamError && error.status === 507 && error.code === "host-storage-low");
    assert.equal(sampled, existingRoot);
    assert.equal(existsSync(newRoot), false, "the missing root remains uncreated after admission is refused");
  } finally { await close(f, teams); }
});

test("createRun fails closed when storage usage cannot be measured", async () => {
  const f = schedulerFixture();
  f.config.projects[0]!.team = { checks: [{ command: "true", args: [] }] };
  f.config.agents.demo = { command: process.execPath, args: [] };
  const teams = openTeam(f, { volumeUsage: async () => { throw new Error("sample unavailable"); } });
  try {
    await assert.rejects(teams.create({ requestId: randomUUID(), projectId: "fixture", provider: "demo", title: "Unavailable storage", objective: "Refuse admission", parallelism: 1 }),
      (error: unknown) => error instanceof TeamError && error.status === 507 && error.code === "host-storage-unavailable" &&
        error.message === "The host could not measure free space for the team workspace volume.");
  } finally { await close(f, teams); }
});

test("a failed permission invalidation save during block is observed without unhandled rejection", async () => {
  const f = schedulerFixture();
  f.writeTeam();
  const teams = openTeam(f);
  const restore = f.blockRecordWrites("team", f.run.id);
  const unhandled: unknown[] = [];
  const handler = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", handler);
  try {
    const scheduler = teams as unknown as { block(stored: unknown, error: TeamError): void; record(id: string): unknown };
    try { scheduler.block(scheduler.record(f.run.id), new TeamError(409, "test-block", "Injected failure.")); }
    catch { }
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", handler);
    restore();
    await close(f, teams);
  }
});

test("workspace removal refuses outside and symlinked run directories and is idempotent", async () => {
  const f = schedulerFixture();
  try {
    const root = f.config.teams!.workspaceDir;
    const outside = join(dirname(root), "outside-run");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "stay outside the team root");
    await assert.rejects(removeTeamWorkspace(outside, undefined, undefined, root), (error: unknown) => error instanceof TeamError && error.code === "team-root-unsafe");
    const symlinkedRun = join(root, "linked-run");
    symlinkSync(outside, symlinkedRun, "dir");
    await assert.rejects(removeTeamWorkspace(symlinkedRun, undefined, undefined, root), (error: unknown) => error instanceof TeamError && error.code === "team-root-unsafe");
    assert.equal(existsSync(join(outside, "keep.txt")), true);

    const emptyRun = join(root, "empty-run");
    mkdirSync(join(emptyRun, "integration"), { recursive: true });
    mkdirSync(join(emptyRun, "members"));
    await removeTeamWorkspace(emptyRun, undefined, undefined, root);
    await removeTeamWorkspace(emptyRun, undefined, undefined, root);
    assert.equal(existsSync(emptyRun), false);
  } finally { f.close(); }
});

test("failed workspace removal records one event, retries later, and does not block the run", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "merged";
  f.run.updatedAt = at;
  f.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  f.run.members.forEach(member => { member.status = "stopped"; });
  const marker = join(f.config.stateDir, "fail-prefix-once");
  const script = [
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    'const marker = process.argv[1];',
    'const [command, ...args] = process.argv.slice(2);',
    'if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "failed once"); fs.mkdirSync("locked", { recursive: true }); fs.writeFileSync("locked/keep", ""); fs.chmodSync("locked", 0); process.exit(73); }',
    'if (fs.existsSync("locked")) fs.chmodSync("locked", 0o755);',
    'const result = spawnSync(command, args, { stdio: "inherit" });',
    'process.exit(result.status ?? 1);',
  ].join("\n");
  f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", script, marker] };
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  let now = Date.parse(at) + 1000;
  const teams = openTeam(f, { now: () => now });
  try {
    teams.start();
    await waitFor(() => teams.get(f.run.id).events.some(event => event.text.startsWith("Workspace removal under the retention policy failed")), "failed removal should be recorded");
    const afterFailure = teams.get(f.run.id);
    assert.equal(afterFailure.status, "merged");
    assert.ok(afterFailure.workspaceRemovedAt, "the removal intent stays durable after a failure so a partially removed tree is never resumed");
    assert.equal(existsSync(runDirectory(f.run)), true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(existsSync(runDirectory(f.run)), true, "a failed removal waits out its backoff before the next attempt");
    now += 5 * 60_000 + 1;
    await waitFor(() => !existsSync(runDirectory(f.run)), "failed removal should be retried once the backoff elapses");
    const afterRetry = teams.get(f.run.id);
    assert.equal(afterRetry.status, "merged");
    assert.ok(afterRetry.workspaceRemovedAt);
    assert.equal(afterRetry.events.filter(event => event.text.startsWith("Workspace removal under the retention policy failed")).length, 1);
  } finally { await close(f, teams); }
});

test("prefix removal runs the exact rm command in the team run directory", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "merged";
  f.run.updatedAt = at;
  f.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  f.run.members.forEach(member => { member.status = "stopped"; });
  const receiptDir = join(f.config.stateDir, "prefix-receipts");
  mkdirSync(receiptDir, { recursive: true });
  mkdirSync(join(runDirectory(f.run), "members"), { recursive: true });
  mkdirSync(join(runDirectory(f.run), "recovery", "x"), { recursive: true });
  mkdirSync(join(runDirectory(f.run), "verification", "y"), { recursive: true });
  f.config.teams!.commandPrefix = { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", receiptDir] };
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    teams.start();
    await waitFor(() => !existsSync(runDirectory(f.run)), "prefixed workspace removal should complete");
    await teams.idle();
    const [line] = readFileSync(join(receiptDir, "commands.jsonl"), "utf8").trim().split("\n");
    const command = JSON.parse(line!) as { command: string; args: string[]; cwd: string };
    assert.equal(command.command, "rm");
    assert.deepEqual(command.args.slice(0, 2), ["-rf", "--"]);
    assert.deepEqual(new Set(command.args.slice(2)), new Set(["integration", "members", "recovery", "verification"]));
    assert.equal(new Set(command.args.slice(2)).size, 4, "every top-level run entry is passed once in one removal command");
    assert.equal(command.cwd, runDirectory(f.run));
  } finally { await close(f, teams); }
});

test("recorded recovery member cwd is removed from its actual members directory", async () => {
  const f = schedulerFixture();
  try {
    const root = f.config.teams!.workspaceDir;
    const run = runDirectory(f.run);
    const recoveryMembers = join(run, "recovery", "x", "members");
    const memberCwd = join(recoveryMembers, "y");
    mkdirSync(memberCwd, { recursive: true });
    writeFileSync(join(memberCwd, "keep-until-removed.txt"), "member clone");
    const receiptDir = join(f.config.stateDir, "member-prefix-receipts");
    mkdirSync(receiptDir, { recursive: true });
    const prefix = { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", receiptDir] };

    await removeMemberWorkspace(run, memberCwd, prefix, undefined, root);

    assert.equal(existsSync(memberCwd), false);
    const [line] = readFileSync(join(receiptDir, "commands.jsonl"), "utf8").trim().split("\n");
    assert.deepEqual(JSON.parse(line!), { command: "rm", args: ["-rf", "--", "y"], cwd: recoveryMembers });
  } finally { f.close(); }
});

test("background retention is bounded, leaves the mutation queue responsive, and is included in idle", { timeout: 15000 }, async () => {
  const f = schedulerFixture();
  const at = new Date(Date.now() - 1000).toISOString();
  const started = join(f.config.stateDir, "removal-started"), release = join(f.config.stateDir, "removal-release");
  mkdirSync(started, { recursive: true });
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawnSync } = require("node:child_process");',
    'const [started, release, command, ...args] = process.argv.slice(1);',
    'fs.writeFileSync(path.join(started, path.basename(process.cwd())), "started");',
    'const run = () => { if (!fs.existsSync(release)) { setTimeout(run, 10); return; } const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit" }); process.exit(result.status ?? 1); };',
    'run();',
  ].join("\n");
  f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", script, started, release] };
  f.run.status = "merged";
  f.run.updatedAt = at;
  f.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  f.run.members = [];
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f);
  const ids = [f.run.id, randomUUID(), randomUUID()];
  try {
    const records = (teams as unknown as { records: Map<string, any> }).records;
    for (const id of ids.slice(1)) {
      const run = structuredClone(f.run) as TeamRun;
      run.id = id;
      run.workspace = join(f.config.teams!.workspaceDir, id, "integration");
      mkdirSync(run.workspace, { recursive: true });
      records.set(id, { run, fingerprint: "fixture", receipts: {}, prepared: true, root: f.config.teams!.workspaceDir,
        retention: { status: "merged", statusAt: at, integratedAt: {}, removalErrors: {} } });
    }
    teams.start();
    await waitFor(() => readdirSync(started).length === 2, "two background removals should begin concurrently");
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(readdirSync(started).length, 2, "a third cleanup waits for one of the two removal slots");
    await assert.rejects(teams.removeRun(ids[0]!), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-operation-running");

    const queuedId = randomUUID(), queuedRun = structuredClone(f.run) as TeamRun;
    queuedRun.id = queuedId;
    queuedRun.status = "planning";
    queuedRun.workspace = join(f.config.teams!.workspaceDir, queuedId, "integration");
    mkdirSync(queuedRun.workspace, { recursive: true });
    records.set(queuedId, { run: queuedRun, fingerprint: "fixture", receipts: {}, prepared: true, root: f.config.teams!.workspaceDir });
    const deletion = await Promise.race([
      teams.cancel(queuedId, { requestId: randomUUID(), revision: 1 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("The mutation queue waited for background removal.")), 1000)),
    ]);
    assert.equal(deletion.id, queuedId, "another team's cancellation completes while cleanup is blocked");

    let idleSettled = false;
    const idle = teams.idle().then(() => { idleSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(idleSettled, false, "idle waits for background removal jobs");
    writeFileSync(release, "continue");
    await idle;
    assert.equal(idleSettled, true);
    assert.equal(readdirSync(started).length, 3);
    for (const id of ids) assert.equal(existsSync(join(f.config.teams!.workspaceDir, id)), false);
  } finally {
    if (!existsSync(release)) writeFileSync(release, "continue after test cleanup");
    await close(f, teams);
  }
});

test("entries the agent account cannot remove are finished by the host", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "merged";
  f.run.updatedAt = at;
  f.run.events.push({ at, text: "The delivery agent reported a merged pull request for the reviewed commit." });
  f.run.members.forEach(member => { member.status = "stopped"; });
  mkdirSync(join(runDirectory(f.run), "scratch", "notes"), { recursive: true });
  f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", "process.exit(1)"] };
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    teams.start();
    await waitFor(() => !existsSync(runDirectory(f.run)), "the host removes what the agent account could not");
    const run = teams.get(f.run.id);
    assert.ok(run.workspaceRemovedAt);
    assert.ok(run.events.some(event => event.text.startsWith("Workspaces removed under the retention policy after this merged run settled")));
    assert.ok(!run.events.some(event => event.text.startsWith("Workspace removal under the retention policy failed")), "no failure is recorded when the host finishes the removal");
  } finally { await close(f, teams); }
});

test("a cancelled run with an interrupted operation and members whose sessions are gone still settles", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "cancelled";
  f.run.updatedAt = at;
  f.run.members.forEach(member => { member.status = "stopped"; });
  const ghost = structuredClone(f.run.members[0]!);
  Object.assign(ghost, { memberId: randomUUID(), sessionId: randomUUID(), status: "unavailable", title: "implementer: ghost" });
  const waiting = structuredClone(f.run.members[0]!);
  Object.assign(waiting, { memberId: randomUUID(), sessionId: randomUUID(), status: "waiting", title: "implementer: waiting" });
  f.run.members.push(ghost, waiting);
  f.run.events.push({ at, text: "Team cancelled." }, { at, text: "The host restarted with an unresolved operation from a cancelled team. The intent will not be replayed." });
  retention(f, { cancelledMinutes: 0 });
  f.writeTeam();
  (f.manager as unknown as { meta: (id: string) => unknown }).meta = () => { throw Object.assign(new Error("Session not found"), { code: "ENOENT" }); };
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    const stored = (teams as unknown as { records: Map<string, { pending?: unknown }> }).records.get(f.run.id)!;
    stored.pending = { id: randomUUID(), kind: "prepare", revision: 1 };
    teams.start();
    await waitFor(() => !teams.statuses().some(row => row.id === f.run.id), "a cancelled run settles once nothing is left to stop, interrupted operation or not");
    assert.equal(existsSync(runDirectory(f.run)), false);
  } finally { await close(f, teams); }
});
