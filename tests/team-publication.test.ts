import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { DEFAULT_TEAM_RETENTION, type TeamMember, type TeamRun } from "../packages/host/src/team-types.js";
import { publishTeamHead } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { fixture, git, independentDeliveryLineup } from "./team-fixture.js";

const prefixScript = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const receiptDir = process.argv[1];
const mode = process.argv[2];
const [command, ...args] = process.argv.slice(3);
const isPush = command === "git" && args.includes("push");
if (isPush) {
  const file = join(receiptDir, "pushes.jsonl");
  appendFileSync(file, JSON.stringify({ cwd: process.cwd(), args }) + "\\n", { mode: 0o600 });
  const count = readFileSync(file, "utf8").trim().split("\\n").filter(Boolean).length;
  if (mode === "hold-first" && count === 1) {
    writeFileSync(join(receiptDir, "push-started"), "started", { mode: 0o600 });
    const deadline = Date.now() + 30000;
    while (!existsSync(join(receiptDir, "push-release")) && Date.now() < deadline)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    if (!existsSync(join(receiptDir, "push-release"))) process.exit(74);
  }
}
const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit",
  env: { ...process.env, INFINITE_TEST_COMMAND_IDENTITY: "team-prefix" } });
process.exit(result.status ?? 128);
`;

async function trackedFixture(scenario: string, options: { publishHeads?: boolean } = {}, prefixMode = "pass") {
  const delivery = scenario.startsWith("delivery");
  const f = await fixture(scenario, delivery ? independentDeliveryLineup : undefined, {}, { ...(delivery ? { deliveryMode: "merge" as const } : {}) });
  const remote = join(f.host.root, "publication-remote.git");
  git(f.source, "clone", "--bare", f.source, remote);
  f.host.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
  f.host.config.source = { ...f.host.config.source, remoteOverrides: { rehearsal: remote } };
  f.host.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", prefixScript, f.receipts, prefixMode] };
  Object.assign(f.host.config.teams!, { publishHeads: options.publishHeads ?? true });
  await f.host.stopApi();
  writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
  await f.host.start();
  return { f, remote };
}

function pushAttempts(receipts: string) {
  const path = join(receipts, "pushes.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { cwd: string; args: string[] }) : [];
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until<T>(get: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs: number, message: string) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await get();
    if (predicate(value)) return value;
    await delay(25);
  }
  assert.fail(message);
}

// The API host runs in a child process, so clock-driven backoff and retention use a direct service with an injected clock.
function directFixture(status: "implementing" | "cancelled", retention: Partial<typeof DEFAULT_TEAM_RETENTION>) {
  const f = schedulerFixture();
  const workspaceGit = (...args: string[]) => execFileSync("git", args, { cwd: f.run.workspace, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  writeFileSync(join(f.run.workspace, "a.txt"), "a\n");
  workspaceGit("add", "a.txt");
  workspaceGit("-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Add a");
  workspaceGit("branch", "-M", "infinite/team-fixture-1234abcd");
  const head = workspaceGit("rev-parse", "HEAD"), at = new Date().toISOString();
  const remote = join(dirname(f.config.teams!.workspaceDir), "publication-remote.git");
  const receipts = join(dirname(f.config.stateDir), "receipts");
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  Object.assign(f.run, { status, headCommit: head, branch: "infinite/team-fixture-1234abcd", updatedAt: at });
  f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], revision: 1, reviewRounds: 0, status: "integrated" }];
  f.run.members.forEach(member => { member.status = "stopped"; });
  if (status === "cancelled") f.run.events.push({ at, text: "Team cancelled." });
  f.config.projects[0]!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", ""] }] };
  f.config.source = { ...f.config.source, remoteOverrides: { fixture: remote } };
  Object.assign(f.config.teams!, { publishHeads: true, retention: { ...DEFAULT_TEAM_RETENTION, ...retention } });
  let now = Date.parse(at);
  const clock = { advance: (ms: number) => { now += ms; } };
  const open = (memberWorkTiming: { memberWorkCommandTimeoutMs?: number; memberWorkPushTimeoutMs?: number; memberWorkCommandStopGraceMs?: number } = {}) =>
    new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined,
      { now: () => now, ownerActive: () => false, ...memberWorkTiming });
  const remoteHead = () => existsSync(remote) ? execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${f.run.branch}`], { encoding: "utf8" }).trim() : "";
  return { f, head, remote, receipts, clock, open, remoteHead, createRemote: () => execFileSync("git", ["init", "--bare", "--quiet", remote]) };
}

function addMemberClone(d: ReturnType<typeof directFixture>, options: { edit?: boolean; integrated?: boolean } = {}) {
  const memberId = randomUUID(), cwd = join(dirname(d.f.run.workspace), "members", memberId);
  mkdirSync(dirname(cwd), { recursive: true });
  git(dirname(cwd), "clone", "--no-hardlinks", "--", d.f.run.workspace, cwd);
  git(cwd, "checkout", "--detach", d.head);
  const member: TeamMember = { runId: d.f.run.id, memberId, revision: 1, role: "implementer", taskId: `task-${memberId}`,
    sessionId: randomUUID(), title: "Implementer", status: "stopped", cwd, baseCommit: d.head, prompt: "", cursor: 0, stopRequestId: randomUUID() };
  d.f.run.members.push(member);
  if (options.edit !== false) {
    writeFileSync(join(cwd, "unfinished.txt"), "Unfinished member edit.\n");
    git(cwd, "add", "unfinished.txt");
    if (options.integrated) {
      git(cwd, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "commit", "-m", "Integrated member result");
      git(cwd, "branch", "infinite-result");
      member.report = { kind: "result" } as never;
      d.f.run.tasks.push({ id: member.taskId!, title: "Implement unfinished edit", instructions: "Edit the member file", paths: ["unfinished.txt"],
        dependsOn: [], revision: 1, reviewRounds: 0, status: "integrated", memberId });
    }
  }
  return { member, cwd };
}

function remoteRef(remote: string, branch: string) {
  try { return execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

function wipPushes(receipts: string) {
  const path = join(receipts, "wip-pushes.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
}

function recordMemberWorkPushes(d: ReturnType<typeof directFixture>, fail = false) {
  const script = `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const receipts = process.argv[1];
const mode = process.argv[2];
const [command, ...args] = process.argv.slice(3);
const refspec = args.at(-1) ?? "";
if (command === "git" && refspec.includes(":refs/heads/") && refspec.includes("-wip-")) {
  appendFileSync(join(receipts, "wip-pushes.jsonl"), JSON.stringify({ refspec }) + "\\n");
  if (mode === "fail") process.exit(73);
}
const child = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit" });
process.exit(child.status ?? 128);
`;
  d.f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", script, d.receipts, fail ? "fail" : "pass"] };
}

function startMemberWorkSave(teams: TeamService, id: string) {
  const internal = teams as unknown as {
    records: Map<string, { run: TeamRun }>;
    retention: { startMemberWorkSave: (stored: { run: TeamRun }) => boolean };
  };
  return internal.retention.startMemberWorkSave(internal.records.get(id)!);
}

function storedRun(teams: TeamService, id: string) {
  return (teams as unknown as { records: Map<string, { run: TeamRun }> }).records.get(id)!.run;
}

function runRetentionPass(teams: TeamService, id: string) {
  const internal = teams as unknown as {
    records: Map<string, { run: TeamRun }>;
    retire: (stored: { run: TeamRun }) => Promise<void>;
  };
  return internal.retire(internal.records.get(id)!);
}

async function closeDirect(f: ReturnType<typeof schedulerFixture>, teams: TeamService) {
  teams.close();
  await teams.idle();
  f.close();
}

test("cancelled retention publishes an uncommitted member clone before removing the workspace", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 0 });
  d.createRemote();
  const { member } = addMemberClone(d);
  d.f.run.missionId = randomUUID();
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id, branch = `${d.f.run.branch}-wip-${member.memberId}`;
  try {
    teams.start();
    const saved = await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork,
      value => value?.state === "published", 10000, "retention did not publish unfinished member work");
    assert.equal(remoteRef(d.remote, branch), saved!.commit);
    assert.equal(execFileSync("git", ["--git-dir", d.remote, "show", `${branch}:unfinished.txt`], { encoding: "utf8" }), "Unfinished member edit.\n");
    const event = `Saved unfinished work of member ${member.memberId} as ${saved!.commit!.slice(0, 12)} to GitHub example/app ${branch} before its workspace is removed.`;
    assert.equal(teams.get(id).events.filter(item => item.text === event).length, 1);
    await until(() => existsSync(dirname(d.f.run.workspace)), present => !present, 10000, "retention did not remove the saved workspace");
    assert.equal(teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork?.state, "published");
  } finally { await closeDirect(d.f, teams); }
});

test("a member clone with no changes records nothing-to-save and retention removes it", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 0 });
  d.createRemote();
  const { member } = addMemberClone(d, { edit: false });
  d.f.run.missionId = randomUUID();
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id, branch = `${d.f.run.branch}-wip-${member.memberId}`;
  try {
    teams.start();
    const saved = await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork,
      value => value?.state === "nothing-to-save", 10000, "retention did not record an unchanged member clone");
    assert.equal(remoteRef(d.remote, branch), "");
    assert.equal(teams.get(id).events.some(item => item.text.includes(`Saved unfinished work of member ${member.memberId}`)), false);
    await until(() => existsSync(dirname(d.f.run.workspace)), present => !present, 10000, "retention held an unchanged member clone");
    assert.equal(saved?.revision, d.f.run.revision);
  } finally { await closeDirect(d.f, teams); }
});

test("an integrated result tree is not published again as unfinished member work", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 0 });
  d.createRemote();
  const { member } = addMemberClone(d, { integrated: true });
  d.f.run.missionId = randomUUID();
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id, branch = `${d.f.run.branch}-wip-${member.memberId}`;
  try {
    teams.start();
    const saved = await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork,
      value => value?.state === "nothing-to-save", 10000, "the integrated result tree was not recognized");
    assert.equal(remoteRef(d.remote, branch), "");
    await until(() => existsSync(dirname(d.f.run.workspace)), present => !present, 10000, "retention held an already integrated result");
    assert.equal(saved?.revision, d.f.run.revision);
  } finally { await closeDirect(d.f, teams); }
});

test("nested submodule edits stay retryable even when parent work is saved", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 60 });
  const nestedSource = join(d.receipts, "nested-source");
  mkdirSync(nestedSource, { recursive: true });
  git(nestedSource, "init", "--quiet");
  writeFileSync(join(nestedSource, "nested.txt"), "base nested content.\n");
  git(nestedSource, "add", "nested.txt");
  git(nestedSource, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "commit", "-m", "Add nested content");
  git(d.f.run.workspace, "-c", "protocol.file.allow=always", "submodule", "add", "--", nestedSource, "nested");
  git(d.f.run.workspace, "add", ".gitmodules", "nested");
  git(d.f.run.workspace, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "commit", "-m", "Add nested repository");
  d.head = git(d.f.run.workspace, "rev-parse", "HEAD");
  d.f.run.headCommit = d.head;
  d.createRemote();
  const { member } = addMemberClone(d, { edit: false });
  git(member.cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
  writeFileSync(join(member.cwd, "nested", "nested.txt"), "uncommitted nested edit.\n");
  writeFileSync(join(member.cwd, "parent-edit.txt"), "parent work is saveable.\n");
  recordMemberWorkPushes(d);
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id, branch = `${d.f.run.branch}-wip-${member.memberId}`;
  try {
    assert.equal(startMemberWorkSave(teams, id), true);
    const saved = await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork,
      value => value?.failure?.attempts === 1, 10000, "nested work did not record a failed member save");
    assert.equal(saved?.state, "retrying");
    assert.equal(saved?.failure?.category, "nested-repository");
    assert.equal(saved?.repository, "example/app");
    assert.notEqual(remoteRef(d.remote, branch), "", "the saveable parent snapshot is still pushed");
    assert.equal(wipPushes(d.receipts), 1);
    const nestedEvent = `Member ${member.memberId} has changes inside a nested repository or submodule that the host cannot save to GitHub. The workspace will be removed after the remaining attempts unless the owner saves the work.`;
    assert.equal(teams.get(id).events.filter(item => item.text === nestedEvent).length, 1);
    assert.notEqual(saved?.state, "published");
    assert.notEqual(saved?.state, "nothing-to-save");
    assert.equal(existsSync(member.cwd), true);
  } finally { await closeDirect(d.f, teams); }
});

test("member work save retries with exponential backoff and gives up on attempt five", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 60 });
  d.createRemote();
  const { member } = addMemberClone(d);
  d.f.run.missionId = randomUUID();
  recordMemberWorkPushes(d, true);
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id;
  const savedWork = () => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork;
  try {
    teams.start();
    await until(() => teams.get(id).publication?.commit, commit => commit === d.head, 10000, "the integration head was not published first");
    await assert.rejects(teams.removeRun(id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "member-work-not-saved");
    let saved = await until(savedWork, value => value?.failure?.attempts === 1, 10000, "the first member work push failure was not recorded");
    assert.equal(saved?.state, "retrying");
    assert.equal(Date.parse(saved!.failure!.retryAt) - Date.parse(saved!.failure!.at), 60_000);
    assert.equal(existsSync(dirname(d.f.run.workspace)), true, "retention is held while the member save can still retry");
    await delay(600);
    assert.equal(wipPushes(d.receipts), 1, "the first retry waited for its backoff");

    for (const [advance, attempt, backoff] of [[60_001, 2, 120_000], [120_001, 3, 240_000], [240_001, 4, 480_000]] as const) {
      d.clock.advance(advance);
      saved = await until(savedWork, value => value?.failure?.attempts === attempt, 10000, `member work attempt ${attempt} did not run`);
      assert.equal(saved?.state, "retrying");
      assert.equal(Date.parse(saved!.failure!.retryAt) - Date.parse(saved!.failure!.at), backoff);
      assert.equal(wipPushes(d.receipts), attempt);
    }
    d.clock.advance(480_001);
    saved = await until(savedWork, value => value?.failure?.attempts === 5, 10000, "member work attempt five did not run");
    assert.equal(saved?.state, "gave-up");
    assert.equal(wipPushes(d.receipts), 5);
    const memberEvent = `Could not save unfinished work of member ${member.memberId} to GitHub (other); the host retries before removing the workspace.`;
    const gaveUpEvent = `Could not save unfinished work of member ${member.memberId} to GitHub after 5 attempts (other); its workspace is removed with the run.`;
    assert.equal(teams.get(id).events.filter(item => item.text === memberEvent).length, 1);
    assert.equal(teams.get(id).events.filter(item => item.text === gaveUpEvent).length, 1);
    assert.equal(existsSync(dirname(d.f.run.workspace)), true, "the requested retries finish before the one-hour retention deadline");
    d.clock.advance(60 * 60_000);
    await until(() => existsSync(dirname(d.f.run.workspace)), present => !present, 10000, "retention did not proceed after the fifth failed attempt");
  } finally { await closeDirect(d.f, teams); }
});

test("a prior revision's retry backoff does not delay saving the current revision", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 60 });
  d.createRemote();
  const { member } = addMemberClone(d);
  const at = new Date().toISOString();
  member.savedWork = { revision: 1, state: "retrying", repository: "example/app", branch: `${d.f.run.branch}-wip-${member.memberId}`, at,
    failure: { category: "other", attempts: 4, at, retryAt: new Date(Date.parse(at) + 60 * 60_000).toISOString() } };
  d.f.run.revision = 2;
  recordMemberWorkPushes(d, true);
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id;
  try {
    teams.start();
    await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork,
      value => value?.revision === 2 && value.failure?.attempts === 1, 10000, "the stale retry deadline delayed the current revision");
    assert.equal(teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork?.state, "retrying");
    assert.equal(wipPushes(d.receipts), 1);
  } finally { await closeDirect(d.f, teams); }
});

test("removeRun returns member-work-not-saved until the background save completes", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 60 });
  d.createRemote();
  const { member } = addMemberClone(d);
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id, branch = `${d.f.run.branch}-wip-${member.memberId}`;
  try {
    teams.start();
    await until(() => teams.get(id).publication?.commit, commit => commit === d.head, 10000, "the integration head was not published first");
    await assert.rejects(teams.removeRun(id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "member-work-not-saved");
    await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork?.state,
      state => state === "published", 10000, "removeRun did not start the member work save");
    const removed = await teams.removeRun(id);
    assert.equal(removed.members.find(item => item.memberId === member.memberId)?.savedWork?.state, "published");
    assert.equal(remoteRef(d.remote, branch), removed.members.find(item => item.memberId === member.memberId)?.savedWork?.commit);
    assert.equal(existsSync(dirname(d.f.run.workspace)), false);
  } finally { await closeDirect(d.f, teams); }
});

test("removeRun refuses a running member before snapshot, even with a recorded result", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 60 });
  d.createRemote();
  const { member } = addMemberClone(d);
  member.status = "running";
  member.sessionId = d.f.run.members[0]!.sessionId;
  recordMemberWorkPushes(d);
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id;
  try {
    teams.start();
    await until(() => teams.get(id).publication?.commit, commit => commit === d.head, 10000, "the integration head was not published first");
    await assert.rejects(teams.removeRun(id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-active");
    assert.equal(teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork, undefined,
      "owner removal refuses before any snapshot result is recorded");
    await delay(200);
    assert.equal(wipPushes(d.receipts), 0, "an unsettled member did not start a snapshot or WIP push");
    assert.equal(existsSync(dirname(d.f.run.workspace)), true);
  } finally { await closeDirect(d.f, teams); }

  const stale = directFixture("cancelled", { cancelledMinutes: 60 });
  stale.createRemote();
  const { member: staleMember } = addMemberClone(stale);
  staleMember.status = "running";
  staleMember.sessionId = stale.f.run.members[0]!.sessionId;
  staleMember.savedWork = { revision: stale.f.run.revision, state: "published", repository: "example/app",
    branch: `${stale.f.run.branch}-wip-${staleMember.memberId}`, commit: stale.head, at: new Date().toISOString() };
  recordMemberWorkPushes(stale);
  stale.f.writeTeam();
  const staleTeams = stale.open(), staleId = stale.f.run.id;
  try {
    staleTeams.start();
    await until(() => staleTeams.get(staleId).publication?.commit, commit => commit === stale.head, 10000, "the stale-result run head was not published");
    await assert.rejects(staleTeams.removeRun(staleId), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-active",
      "a recorded save cannot authorize removal while a member may still write");
    assert.equal(wipPushes(stale.receipts), 0);
    assert.equal(existsSync(dirname(stale.f.run.workspace)), true);
  } finally { await closeDirect(stale.f, staleTeams); }
});

test("shutdown fences a save whose settlement check resumes after close", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 0 });
  const { member } = addMemberClone(d);
  member.status = "running";
  member.sessionId = d.f.run.members[0]!.sessionId;
  d.f.run.publication = { repository: "example/app", branch: d.f.run.branch, commit: d.head, publishedAt: new Date().toISOString() };
  recordMemberWorkPushes(d);
  d.f.writeTeam();
  const manager = d.f.manager as unknown as { state: (sessionId?: string) => Promise<{ status: string }> };
  const originalState = manager.state.bind(manager);
  let enteredState!: () => void, releaseState!: () => void, settledStatus = "running";
  const entered = new Promise<void>(resolve => { enteredState = resolve; });
  const gate = new Promise<void>(resolve => { releaseState = resolve; });
  manager.state = async sessionId => {
    if (sessionId === member.sessionId) {
      enteredState();
      await gate;
      return { ...(await originalState(sessionId)), status: settledStatus };
    }
    return originalState(sessionId);
  };
  const teams = d.open(), id = d.f.run.id;
  try {
    const retention = runRetentionPass(teams, id);
    await entered;
    teams.close();
    settledStatus = "exited";
    releaseState();
    await retention;
    await teams.idle();
    assert.equal(wipPushes(d.receipts), 0, "a settlement check completing after close did not launch a snapshot");
    assert.equal(teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork, undefined);
    assert.equal(existsSync(dirname(d.f.run.workspace)), true);
  } finally {
    releaseState();
    await closeDirect(d.f, teams);
  }
});

test("a snapshot command that never closes records a bounded failure and reaches the removal cap", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 0 });
  d.createRemote();
  const { member } = addMemberClone(d);
  d.f.run.missionId = randomUUID();
  const prefixScript = `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const receiptDir = process.argv[1];
const [command, ...args] = process.argv.slice(2);
if (command === "git" && args.includes("add")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "inherit" });
  appendFileSync(join(receiptDir, "hung-snapshot-pids"), String(child.pid) + "\\n");
  process.exit(0);
}
const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit" });
process.exit(result.status ?? 128);
`;
  d.f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", prefixScript, d.receipts] };
  d.f.writeTeam();
  const timing = { memberWorkCommandTimeoutMs: 100, memberWorkPushTimeoutMs: 100, memberWorkCommandStopGraceMs: 40 };
  let teams = d.open(timing), id = d.f.run.id;
  const savedWork = () => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork;
  const pidFile = join(d.receipts, "hung-snapshot-pids");
  const pids = () => existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
  const killHungChild = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } };
  const killHungChildren = () => { for (const pid of pids()) killHungChild(pid); };
  try {
    teams.start();
    let saved: ReturnType<typeof savedWork>;
    try { saved = await until(savedWork, value => value?.failure?.attempts === 1, 5000, "the hung snapshot did not settle into a recorded failure"); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(savedWork())}; hungPids=${JSON.stringify(pids())}`); }
    assert.equal(saved?.state, "retrying");
    assert.equal(saved?.failure?.category, "other");
    assert.ok(pids().length > 0, "the test prefix left a descendant holding the command pipes open");
    assert.equal(existsSync(dirname(d.f.run.workspace)), true, "retention stays held before the attempt cap");

    const firstHungPid = pids()[0]!;
    d.clock.advance(60_001);
    await until(pids, values => values.length >= 2, 5000, "the retry snapshot did not start");
    const closeStarted = performance.now();
    teams.close();
    await teams.idle();
    assert.ok(performance.now() - closeStarted < 1000, "close and idle settle a snapshot with a held pipe within the stop grace");

    teams = d.open(timing);
    teams.start();
    for (const [attempt, advance] of [[2, 0], [3, 120_001], [4, 240_001], [5, 480_001]] as const) {
      if (advance) d.clock.advance(advance);
      saved = await until(savedWork, value => value?.failure?.attempts === attempt, 5000, `the hung snapshot did not record failure ${attempt}`);
      assert.equal(saved?.failure?.category, "other");
      assert.equal(saved?.state, attempt === 5 ? "gave-up" : "retrying");
      if (attempt === 2) {
        killHungChild(firstHungPid);
        await delay(100);
        assert.equal(savedWork()?.failure?.attempts, 2, "the abandoned command's late close cannot replace the newer failure record");
      }
    }
    await until(() => existsSync(dirname(d.f.run.workspace)), present => !present, 5000, "retention stayed held after five bounded snapshot failures");
  } finally {
    killHungChildren();
    await closeDirect(d.f, teams);
  }
});

test("publishHeads false does not snapshot member work or hold retention", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 0 });
  d.createRemote();
  const { member } = addMemberClone(d);
  d.f.run.missionId = randomUUID();
  d.f.config.teams!.publishHeads = false;
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id, branch = `${d.f.run.branch}-wip-${member.memberId}`;
  try {
    teams.start();
    await until(() => existsSync(dirname(d.f.run.workspace)), present => !present, 10000, "disabled publication held cancelled retention");
    assert.equal(teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork, undefined);
    assert.equal(remoteRef(d.remote, branch), "");
  } finally { await closeDirect(d.f, teams); }
});

test("a saved revision is not resnapshotted while its clone remains, but a new revision is saved", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 60 });
  d.createRemote();
  const { member } = addMemberClone(d);
  d.f.run.publication = { repository: "example/app", branch: d.f.run.branch, commit: d.head, publishedAt: new Date().toISOString() };
  recordMemberWorkPushes(d);
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id;
  try {
    assert.equal(startMemberWorkSave(teams, id), true);
    await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork?.state,
      state => state === "published", 10000, "the first save did not publish member work");
    assert.equal(existsSync(member.cwd), true, "the member clone remains available for the next pass");
    assert.equal(wipPushes(d.receipts), 1);
    assert.equal(startMemberWorkSave(teams, id), false, "the same saved revision does not start another snapshot");
    await delay(100);
    assert.equal(wipPushes(d.receipts), 1);
    assert.equal(existsSync(member.cwd), true);

    writeFileSync(join(member.cwd, "second-revision.txt"), "Changed member work for the next revision.\n");
    storedRun(teams, id).revision++;
    assert.equal(startMemberWorkSave(teams, id), true, "a changed run revision requests a fresh snapshot despite its prior result");
    const saved = await until(() => teams.get(id).members.find(item => item.memberId === member.memberId)?.savedWork,
      value => value?.revision === 2 && value.state === "published", 10000, "the changed revision was not published");
    assert.equal(saved?.revision, 2);
    assert.equal(wipPushes(d.receipts), 3, "the new snapshot pushes on the diverged primary and its SHA sibling");
    assert.equal(existsSync(member.cwd), true);
  } finally { await closeDirect(d.f, teams); }
});

test("the integration head is published before reviewer and delivery members start", { timeout: 120000 }, async () => {
  const h = await trackedFixture("delivery-hold", {}, "hold-first");
  try {
    const created = await h.f.host.fetchApi("/teams", "owner", h.f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await until(() => existsSync(join(h.f.receipts, "push-started")), Boolean, 60000, "the first head publication did not start");
    const waiting = await h.f.get(created.body.id);
    assert.ok(waiting.headCommit);
    assert.equal(waiting.members.some(member => member.role === "reviewer" || member.role === "delivery"), false,
      "neither review nor delivery starts while the integration head is unpublished");

    writeFileSync(join(h.f.receipts, "push-release"), "continue");
    const delivering = await until(() => h.f.get(created.body.id), run =>
      run.status === "delivering" && existsSync(join(h.f.receipts, "delivery-started.json")), 90000, "delivery did not start after publication and review");
    assert.equal(delivering.review?.verdict, "approved");
    assert.equal(delivering.publication?.commit, delivering.headCommit);
    assert.equal(git(h.remote, "rev-parse", `refs/heads/${delivering.branch}`), delivering.headCommit,
      "the exact reviewed head is already present on the remote branch when delivery starts");
  } finally {
    writeFileSync(join(h.f.receipts, "push-release"), "continue after test cleanup");
    writeFileSync(join(h.f.receipts, "delivery-release"), "continue after test cleanup");
    await h.f.close();
  }
});

test("a diverged run branch is preserved and the exact head is published on its SHA-suffixed sibling", { timeout: 120000 }, async () => {
  const h = await trackedFixture("delivery-hold", {}, "hold-first");
  try {
    const created = await h.f.host.fetchApi("/teams", "owner", h.f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await until(() => existsSync(join(h.f.receipts, "push-started")), Boolean, 60000, "the first head publication did not start");
    const paused = await h.f.get(created.body.id);
    const diverged = join(h.f.host.root, "diverged-remote-branch");
    git(h.f.host.root, "clone", h.remote, diverged);
    git(diverged, "checkout", "-b", paused.branch, "main");
    writeFileSync(join(diverged, "external-change.txt"), "A separate remote change.\n");
    git(diverged, "add", "external-change.txt");
    git(diverged, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Independent remote update");
    git(diverged, "push", "origin", `HEAD:refs/heads/${paused.branch}`);
    const existingRemoteHead = git(h.remote, "rev-parse", `refs/heads/${paused.branch}`);

    writeFileSync(join(h.f.receipts, "push-release"), "continue");
    const ready = await until(() => h.f.get(created.body.id), run =>
      run.status === "delivering" && existsSync(join(h.f.receipts, "delivery-started.json")), 90000,
    "delivery did not start after sibling publication and review");
    assert.equal(git(h.remote, "rev-parse", `refs/heads/${ready.branch}`), existingRemoteHead,
      "the host does not replace the branch that has moved independently");
    const sibling = `${ready.branch}-${ready.headCommit!.slice(0, 8)}`;
    assert.equal(git(h.remote, "rev-parse", `refs/heads/${sibling}`), ready.headCommit,
      "the run's exact head is available on a separate SHA-bound branch");
    assert.equal(ready.publication?.commit, ready.headCommit);
    assert.equal(ready.publication?.branch, sibling);
    const deliveryAttempt = JSON.parse(readFileSync(join(h.f.receipts, "delivery-attempts.jsonl"), "utf8").trim().split("\n").at(-1)!);
    assert.match(deliveryAttempt.prompt, new RegExp(`pinned repository's branch ${sibling}, so a remote branch`),
      "provider delivery follows the host-published sibling branch");
    assert.match(deliveryAttempt.prompt, /That host publication alone is not a delivery: if no pull request exists for it and the base moved, report the "no-publication" disposition\./,
      "a host-published branch keeps clean-base delivery recovery reachable");
  } finally {
    writeFileSync(join(h.f.receipts, "push-release"), "continue after test cleanup");
    writeFileSync(join(h.f.receipts, "delivery-release"), "continue after test cleanup");
    await h.f.close();
  }
});

test("publishHeads false completes a run without pushing any branch", { timeout: 90000 }, async () => {
  const h = await trackedFixture("success", { publishHeads: false });
  try {
    const created = await h.f.host.fetchApi("/teams", "owner", h.f.create());
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const ready = await until(() => h.f.get(created.body.id), run => run.status === "ready-for-review", 90000, "the run did not complete with publication disabled");
    assert.notEqual(ready.headCommit, ready.baseCommit);
    assert.deepEqual(pushAttempts(h.f.receipts), []);
    assert.equal(git(h.remote, "for-each-ref", "--format=%(refname)", "refs/heads/infinite"), "");
  } finally { await h.f.close(); }
});

test("failed head publication backs off up to hourly without blocking, and review starts once GitHub accepts the head", { timeout: 30000 }, async () => {
  const d = directFixture("implementing", {});
  d.f.writeTeam({ checkHead: d.head });
  const teams = d.open(), id = d.f.run.id;
  const attempts = () => teams.get(id).publication?.failure?.attempts;
  try {
    teams.start();
    await until(attempts, value => value === 1, 5000, "the first publication failure was not recorded");
    await delay(1200);
    assert.equal(attempts(), 1, "a failed push is not retried before its backoff expires");
    assert.equal(teams.get(id).members.some(member => member.role === "reviewer"), false, "review waits for the head to be published");

    d.clock.advance(60_001);
    await until(attempts, value => value === 2, 5000, "the first backoff retry did not occur");
    d.clock.advance(120_001);
    const waiting = await until(() => teams.get(id), run => run.publication?.failure?.attempts === 3, 5000, "the third attempt did not occur");
    assert.notEqual(waiting.status, "blocked", "a failing push keeps the run waiting instead of blocking it");
    assert.equal(waiting.members.some(member => member.role === "reviewer"), false);
    assert.equal(waiting.events.filter(event => event.text.startsWith(`Could not publish head ${d.head.slice(0, 12)}`)).length, 1, "a repeated failure category is recorded once");
    assert.equal(waiting.events.filter(event => event.text.includes("three times")).length, 1);

    for (const expected of [4, 5, 6, 7]) {
      d.clock.advance(3_600_001);
      await until(attempts, value => value === expected, 5000, `publication attempt ${expected} did not occur`);
    }
    const capped = teams.get(id).publication!.failure!;
    assert.equal(Date.parse(capped.retryAt) - Date.parse(capped.at), 3_600_000, "the backoff is capped at one hour");

    d.createRemote();
    d.clock.advance(3_600_001);
    await until(() => teams.get(id).publication?.commit, commit => commit === d.head, 5000, "the head was not published once GitHub accepted it");
    assert.equal(d.remoteHead(), d.head);
    await until(() => teams.get(id).members.some(member => member.role === "reviewer"), Boolean, 5000, "review did not start after the head was published");
  } finally { await closeDirect(d.f, teams); }
});

test("a retained operation intent does not hold back head publication", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", {});
  d.createRemote();
  d.f.writeTeam({ pending: { id: "retained-check", kind: "check", revision: 1 } });
  const teams = d.open(), id = d.f.run.id;
  try {
    teams.start();
    await until(() => teams.get(id).publication?.commit, commit => commit === d.head, 5000, "a retained intent prevented publication");
    assert.equal(d.remoteHead(), d.head);
  } finally { await closeDirect(d.f, teams); }
});

test("owner removal and cancelled retention wait for an unpublished head", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 1 });
  d.f.writeTeam();
  const teams = d.open(), id = d.f.run.id;
  try {
    teams.start();
    await until(() => teams.get(id).publication?.failure?.attempts, attempts => attempts === 1, 5000, "the first publication failure was not recorded");
    d.clock.advance(30 * 60_000);
    await until(() => teams.get(id).publication?.failure?.attempts, attempts => attempts === 2, 5000, "the cancelled run did not retry");
    await teams.idle();
    assert.ok(existsSync(dirname(d.f.run.workspace)), "cancelled retention keeps an unpublished head's workspace");
    await assert.rejects(teams.removeRun(id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "head-not-published");

    d.createRemote();
    d.clock.advance(30 * 60_000);
    await until(() => teams.statuses().some(row => row.id === id), present => !present, 5000, "the cancelled run was not deleted after its head was published");
    assert.equal(d.remoteHead(), d.head);
    assert.equal(existsSync(dirname(d.f.run.workspace)), false);
  } finally { await closeDirect(d.f, teams); }
});

test("a run whose workspace was removed before publication is never pushed and its retention completes", { timeout: 30000 }, async () => {
  const d = directFixture("cancelled", { cancelledMinutes: 1 });
  d.createRemote();
  d.f.run.workspaceRemovedAt = new Date().toISOString();
  d.f.writeTeam();
  rmSync(dirname(d.f.run.workspace), { recursive: true, force: true });
  const teams = d.open(), id = d.f.run.id;
  try {
    teams.start();
    await teams.idle();
    assert.equal(teams.get(id).publication, undefined, "a removed workspace has no head left to push");
    d.clock.advance(2 * 60_000);
    await until(() => teams.statuses().some(row => row.id === id), present => !present, 5000, "the cancelled record was not deleted");
    assert.equal(d.remoteHead(), "");
  } finally { await closeDirect(d.f, teams); }
});

test("only Git's divergence status routes a push to a sibling branch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "infinite-publication-"));
  const failWith = (output: string) => ({ command: process.execPath, args: ["-e", "process.stderr.write(process.argv[1]); process.exit(1)", output] });
  const sha = "a".repeat(40), url = "https://github.com/example/app.git";
  try {
    const diverged = " ! [rejected]        " + sha + " -> infinite/team-x-1234abcd (non-fast-forward)\nerror: failed to push some refs to '" + url + "'\n";
    const moved = " ! [rejected]        " + sha + " -> infinite/team-x-1234abcd (fetch first)\nerror: failed to push some refs to '" + url + "'\n";
    const protectedBranch = " ! [remote rejected] " + sha + " -> infinite/team-fix-non-fast-forward-abcd1234 (protected branch hook declined)\nerror: failed to push some refs to '" + url + "'\n";
    assert.deepEqual(await publishTeamHead(workspace, url, sha, "infinite/team-x-1234abcd", failWith(diverged)), { published: false, category: "rejected" });
    assert.deepEqual(await publishTeamHead(workspace, url, sha, "infinite/team-x-1234abcd", failWith(moved)), { published: false, category: "rejected" });
    assert.deepEqual(await publishTeamHead(workspace, url, sha, "infinite/team-fix-non-fast-forward-abcd1234", failWith(protectedBranch)), { published: false, category: "other" },
      "a branch name containing divergence words is not a divergence");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a delivery member queued before publication launches with the host-publication instructions", { timeout: 30000 }, async () => {
  const d = directFixture("implementing", {});
  const run = d.f.run, at = new Date().toISOString();
  Object.assign(run, { status: "delivering", review: { verdict: "approved", summary: "Approved.", revision: 1 }, delivery: { mode: "pr", repository: "example/app", baseBranch: "main" },
    publication: { repository: "example/app", branch: run.branch, commit: d.head, publishedAt: at } });
  d.f.config.projects[0]!.team = { ...d.f.config.projects[0]!.team!, delivery: run.delivery };
  run.members.push({ runId: run.id, memberId: randomUUID(), revision: 1, role: "delivery", sessionId: randomUUID(), title: "delivery: stale",
    status: "queued", cwd: run.workspace, baseCommit: d.head, prompt: "A delivery prompt written before the head was published.", cursor: 0, stopRequestId: randomUUID() });
  d.f.writeTeam({ checkHead: d.head });
  const teams = d.open();
  try {
    teams.start();
    const launched = await until(() => d.f.launches.find(item => item.prompt.includes("Publish only the exact host-reviewed commit")), Boolean, 5000, "the queued delivery member did not launch");
    assert.match(launched!.prompt, new RegExp(`The host has already published ${d.head} to the pinned repository's branch ${run.branch}`));
    assert.doesNotMatch(launched!.prompt, /written before the head was published/);
  } finally { await closeDirect(d.f, teams); }
});
