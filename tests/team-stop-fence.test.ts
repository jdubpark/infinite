import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Manager } from "../packages/host/src/manager.js";
import { newWitness, type CensusResult, type HostProcesses, type ProcessWitness } from "../packages/host/src/process-census.js";
import { handleTeamClientCommand } from "../packages/host/src/team-cli.js";
import { COMMAND_STOP_UNCONFIRMED_REASON, STOP_GRACE_MS } from "../packages/host/src/team-workspace.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;
type Internals = { records: Map<string, { halt?: string; ownerHalt?: { haltId?: string } }> };

const RUNNING: CensusResult = { ok: true, findings: [{ pid: 101, reason: "recorded-group" }] };
const ENDED: CensusResult = { ok: true, findings: [] };
const UNKNOWN: CensusResult = { ok: false, problem: "prefix-unsupported" };
const STATED = "The owner stated that the processes of the run's check operation have ended. The host's process census could not tell (prefix-unsupported); the host accepts the statement in place of a census that finds none.";
const CLEARED_ON_STATEMENT = "The host cleared the stopped command's operation on the owner's statement that its processes ended.";

function witness(pid: number): ProcessWitness {
  return { ...newWitness(), processes: [{ pid, start: `start-${pid}` }], sessions: [pid], groups: [pid] };
}

function fencedRun(f: Fixture, status: "blocked" | "paused" | "cancelled", extra: object = {}) {
  const at = new Date().toISOString();
  f.run.status = status;
  f.run.updatedAt = at;
  f.run.headCommit = f.run.baseCommit;
  f.run.reason = COMMAND_STOP_UNCONFIRMED_REASON;
  f.run.blockCode = "command-stop-unconfirmed";
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.writeTeam({ pending: { id: randomUUID(), kind: "check", revision: f.run.revision, witness: witness(101),
    failure: { code: "command-stop-unconfirmed", reason: COMMAND_STOP_UNCONFIRMED_REASON, at } }, ...extra });
}

function openTeam(f: Fixture, census: () => CensusResult | Promise<CensusResult>, seen: { count: number }, now: () => number = () => Date.now()) {
  const processes: HostProcesses = { table: async () => ({ boot: "test-boot", rows: [] }), start: async () => "test-start",
    census: async () => { seen.count++; return census(); } };
  const teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now, processes });
  (teams as unknown as Internals).records.get(f.run.id)!.halt = undefined;
  return teams;
}

const code = (expected: string, message?: RegExp) => (error: unknown) =>
  error instanceof TeamError && error.code === expected && (!message || message.test(error.message));

async function close(f: Fixture, teams: TeamService) {
  await teams.close();
  f.close();
}

test("the owner's statement is refused while a census sees the stopped command's process, accepted once while the census cannot tell, and then lets Resume pass", async () => {
  const f = schedulerFixture();
  fencedRun(f, "blocked");
  let result = RUNNING;
  const seen = { count: 0 };
  const teams = openTeam(f, () => result, seen);
  try {
    await assert.rejects(teams.processesEnded(f.run.id, { requestId: randomUUID() }), code("team-command-running"), "a statement is refused while the census sees the process");
    assert.equal(teams.get(f.run.id).reason, COMMAND_STOP_UNCONFIRMED_REASON);
    result = UNKNOWN;
    await assert.rejects(teams.resume(f.run.id, { requestId: randomUUID(), revision: 1 }), code("team-command-running", /infinite team processes-ended/));
    assert.match(teams.get(f.run.id).reason ?? "", /only way out.*infinite team processes-ended/, "the reason names the statement and its command");
    const statement = { requestId: randomUUID() };
    const stated = await teams.processesEnded(f.run.id, statement);
    assert.equal(stated.events.filter(event => event.text === STATED).length, 1, JSON.stringify(stated.events.slice(-3)));
    assert.equal(stated.resumable, true);
    const counted = seen.count;
    const again = await teams.processesEnded(f.run.id, statement);
    assert.equal(seen.count, counted, "a replayed statement takes no census");
    assert.equal(again.events.filter(event => event.text === STATED).length, 1, "a replayed statement records nothing more");
    await assert.rejects(teams.cancel(f.run.id, { requestId: statement.requestId, revision: 1 }), code("request-conflict"));
    const resumed = await teams.resume(f.run.id, { requestId: randomUUID(), revision: 1 });
    assert.equal(resumed.status, "planning");
    assert.equal(resumed.pendingOperation, undefined);
    assert.ok(resumed.events.some(event => event.text === CLEARED_ON_STATEMENT), JSON.stringify(resumed.events.slice(-3)));
    await assert.rejects(teams.processesEnded(f.run.id, { requestId: randomUUID() }), code("team-no-process-record"));
  } finally { await close(f, teams); }
});

test("a cancelled run whose census cannot tell is removed only after the owner's statement", async () => {
  const f = schedulerFixture();
  fencedRun(f, "cancelled");
  const teams = openTeam(f, () => UNKNOWN, { count: 0 });
  try {
    await assert.rejects(teams.removeRun(f.run.id), code("team-operation-running", /infinite team processes-ended/));
    assert.equal(existsSync(dirname(f.run.workspace)), true);
    await teams.processesEnded(f.run.id, { requestId: randomUUID() });
    await teams.removeRun(f.run.id);
    assert.equal(existsSync(dirname(f.run.workspace)), false);
  } finally { await close(f, teams); }
});

test("an owner's halt release takes a census for a paused run whose stopped command ended, and resumes it", async () => {
  const f = schedulerFixture();
  const haltId = randomUUID();
  fencedRun(f, "paused", { ownerHalt: { haltId, reason: "The owner halted the project." } });
  const teams = openTeam(f, () => ENDED, { count: 0 });
  try {
    const outcomes = await teams.haltResume(haltId, () => undefined, false);
    assert.deepEqual(outcomes.map(outcome => outcome.result), ["resumed"], JSON.stringify(outcomes));
    const resumed = teams.get(f.run.id);
    assert.equal(resumed.status, "planning");
    assert.equal(resumed.pendingOperation, undefined);
  } finally { await close(f, teams); }
});

test("a mission's halt release keeps the halt while the stopped command runs, reuses a recent census, and resumes once a census finds none", async () => {
  const f = schedulerFixture();
  const token = randomUUID();
  fencedRun(f, "paused", { ownerHalt: { haltId: token, reason: "The mission was halted." } });
  let result = RUNNING, now = Date.now();
  const seen = { count: 0 };
  const teams = openTeam(f, () => result, seen, () => now);
  try {
    await assert.rejects(teams.haltResumeChild(f.run.id, token), code("team-operation-running"), "the mission keeps the release and retries it");
    assert.equal((teams as unknown as Internals).records.get(f.run.id)!.ownerHalt?.haltId, token, "the halt mark stays");
    await assert.rejects(teams.haltResumeChild(f.run.id, token), code("team-operation-running"));
    assert.equal(seen.count, 1, "a retry within the reuse window takes no new census");
    result = ENDED;
    now += 31_000;
    assert.equal(await teams.haltResumeChild(f.run.id, token), true);
    assert.equal(teams.get(f.run.id).status, "planning");
    assert.equal(seen.count, 2);
  } finally { await close(f, teams); }
});

test("requests on a run with a stopped command share one census taken outside the run's queue", async () => {
  const f = schedulerFixture();
  fencedRun(f, "blocked");
  let release: (result: CensusResult) => void = () => {};
  const gate = new Promise<CensusResult>(resolve => { release = resolve; });
  const seen = { count: 0 };
  const teams = openTeam(f, () => gate, seen);
  try {
    const first = teams.resume(f.run.id, { requestId: randomUUID(), revision: 1 });
    const second = teams.resume(f.run.id, { requestId: randomUUID(), revision: 1 });
    const removal = teams.removeRun(f.run.id);
    for (const request of [first, second, removal]) request.catch(() => {});
    await delay(200);
    assert.equal(seen.count, 1, "the requests wait on one census");
    const paused = teams.pause(f.run.id, { requestId: randomUUID(), revision: 1 }).then(() => "answered", () => "answered");
    assert.equal(await Promise.race([paused, delay(1_000).then(() => "waiting")]), "answered", "the run's queue answers another request while the census runs");
    release(RUNNING);
    for (const request of [first, second]) await assert.rejects(request, code("team-command-running"));
    await assert.rejects(removal, code("team-active"));
    assert.equal(seen.count, 1);
  } finally {
    release(RUNNING);
    await close(f, teams);
  }
});

test("team processes-ended CLI posts only a request ID to the statement endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "team-processes-ended-cli-"));
  const id = randomUUID(), posts: { path: string; body: unknown; method?: string }[] = [];
  const api = {
    request: async () => { throw new Error("The statement uses the JSON API only."); },
    json: async (path: string, body?: unknown, _signal?: AbortSignal, _headers?: Record<string, string>, method?: string) => {
      if (body === undefined) return { id, revision: 4, status: "blocked", title: "Fixture run" };
      posts.push({ path, body, method });
      return { id, revision: 4, status: "blocked", title: "Fixture run" };
    },
  };
  const output: string[] = [], log = console.log, write = process.stderr.write;
  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    process.stderr.write = (() => true) as typeof process.stderr.write;
    assert.equal(await handleTeamClientCommand("team", ["processes-ended", id], {}, { origin: "http://fixture.invalid", token: "fixture-token" }, api, join(root, "client.json"), ["team", "processes-ended", id]), true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, `/teams/${id}/processes-ended`);
    assert.deepEqual(Object.keys(posts[0]!.body as object), ["requestId"]);
  } finally {
    console.log = log;
    process.stderr.write = write;
    rmSync(root, { recursive: true, force: true });
  }
});

test("under a prefix the watch of a stopped command takes its census after the anchor's grace, and without a prefix at once", async () => {
  for (const prefixed of [true, false]) {
    const f = schedulerFixture();
    fencedRun(f, "blocked");
    if (prefixed) f.config.teams!.commandPrefix = { command: "env", args: [] };
    const seen = { count: 0 };
    const teams = openTeam(f, () => ENDED, seen);
    try {
      const internals = teams as unknown as { fence: { watch(stored: unknown): void }; records: Map<string, unknown> };
      internals.fence.watch(internals.records.get(f.run.id));
      await delay(prefixed ? STOP_GRACE_MS - 1_000 : 500);
      assert.equal(seen.count, prefixed ? 0 : 1, prefixed ? "no census before the grace ended" : "a census at once");
      if (prefixed) {
        await delay(2_000);
        assert.equal(seen.count, 1, "the census follows the grace");
      }
    } finally { await close(f, teams); }
  }
});
