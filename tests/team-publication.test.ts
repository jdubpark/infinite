import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import type { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { DEFAULT_TEAM_RETENTION } from "../packages/host/src/team-types.js";
import { publishTeamHead } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { fixture, git, limitLineup } from "./team-fixture.js";

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
  const f = await fixture(scenario, delivery ? limitLineup : undefined, {}, { ...(delivery ? { deliveryMode: "merge" as const } : {}) });
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
  const open = () => new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { now: () => now });
  const remoteHead = () => existsSync(remote) ? execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${f.run.branch}`], { encoding: "utf8" }).trim() : "";
  return { f, head, remote, clock, open, remoteHead, createRemote: () => execFileSync("git", ["init", "--bare", "--quiet", remote]) };
}

async function closeDirect(f: ReturnType<typeof schedulerFixture>, teams: TeamService) {
  teams.close();
  await teams.idle();
  f.close();
}

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
