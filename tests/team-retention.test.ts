import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { DEFAULT_TEAM_RETENTION, type TeamMember, type TeamRun } from "../packages/host/src/team-types.js";
import type { VolumeUsage } from "../packages/host/src/storage.js";
import { removeTeamWorkspace } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type ServiceOptions = { now?: () => number; volumeUsage?: (path: string) => Promise<VolumeUsage> };

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

test("blocked workspaces remain until blockedHours and removed runs reject resume while pause and cancel still work", async () => {
  const f = schedulerFixture();
  const at = new Date().toISOString();
  f.run.status = "blocked";
  f.run.updatedAt = at;
  f.run.reason = "A worker reported a blocker.";
  f.run.members.forEach(member => { member.status = "stopped"; });
  f.run.events.push({ at, text: f.run.reason });
  retention(f, { blockedHours: 1 });
  let now = Date.parse(at);
  f.writeTeam();
  const teams = openTeam(f, { now: () => now });
  try {
    teams.start();
    await teams.idle();
    assert.ok(existsSync(runDirectory(f.run)), "blocked workspaces stay available before the configured window");
    now += 3_600_001;
    await waitFor(() => Boolean(teams.get(f.run.id).workspaceRemovedAt), "blocked workspace should be removed after blockedHours");
    assert.equal(existsSync(runDirectory(f.run)), false);
    const action = () => ({ requestId: randomUUID(), revision: 1 });
    assert.equal(teams.get(f.run.id).resumable, false);
    assert.equal(teams.get(f.run.id).continuable, false);
    await assert.rejects(teams.resume(f.run.id, action()), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-workspace-removed");
    await assert.rejects(teams.continueRun(f.run.id, action()), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-workspace-removed");
    await assert.rejects(teams.steer(f.run.id, { ...action(), text: "Try a new direction" }), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "team-workspace-removed");
    assert.equal((await teams.pause(f.run.id, action())).status, "paused");
    await assert.rejects(teams.resume(f.run.id, action()), (error: unknown) => error instanceof TeamError && error.code === "team-workspace-removed");
    assert.equal((await teams.cancel(f.run.id, action())).status, "cancelled");
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
    assert.equal(existsSync(pendingSource.cwd), true, "the pending operation's source clone must remain");
    assert.ok(teams.get(f.run.id).members.find(member => member.memberId === integrated.memberId)?.workspaceRemovedAt);
    assert.equal(teams.get(f.run.id).status, "implementing");
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
    catch { /* The synchronous run-record save is expected to fail in this test. */ }
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
    'if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "failed once"); process.exit(73); }',
    'const result = spawnSync(command, args, { stdio: "inherit" });',
    'process.exit(result.status ?? 1);',
  ].join("\n");
  f.config.teams!.commandPrefix = { command: process.execPath, args: ["-e", script, marker] };
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    teams.start();
    await waitFor(() => teams.get(f.run.id).events.some(event => event.text.startsWith("Workspace removal under the retention policy failed")), "failed removal should be recorded");
    const afterFailure = teams.get(f.run.id);
    assert.equal(afterFailure.status, "merged");
    assert.equal(afterFailure.workspaceRemovedAt, undefined);
    assert.equal(existsSync(runDirectory(f.run)), true);
    await waitFor(() => !existsSync(runDirectory(f.run)), "failed removal should be retried on a later tick");
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
  f.config.teams!.commandPrefix = { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", receiptDir] };
  retention(f, { finishedMinutes: 0 });
  f.writeTeam();
  const teams = openTeam(f, { now: () => Date.parse(at) + 1000 });
  try {
    teams.start();
    await waitFor(() => !existsSync(runDirectory(f.run)), "prefixed workspace removal should complete");
    const [line] = readFileSync(join(receiptDir, "commands.jsonl"), "utf8").trim().split("\n");
    assert.deepEqual(JSON.parse(line!), { command: "rm", args: ["-rf", "--", "integration", "members"], cwd: runDirectory(f.run) });
  } finally { await close(f, teams); }
});
