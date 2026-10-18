import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../packages/host/src/types.js";
import { RepoEnrollmentService } from "../packages/host/src/repo-enrollment.js";
import { unseal } from "../packages/host/src/vault.js";
import { startHost } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "infinite-enrollment-"));
  const projectPath = join(root, "project");
  const stateDir = join(root, "state");
  const runDir = join(root, "runs");
  const prefixReceipts = join(root, "prefix-receipts");
  mkdirSync(projectPath); mkdirSync(stateDir); mkdirSync(runDir);
  mkdirSync(prefixReceipts);
  git(projectPath, "init", "--initial-branch=main");
  writeFileSync(join(projectPath, "tracked.txt"), "committed\n");
  git(projectPath, "add", "tracked.txt");
  git(projectPath, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const project = { id: "example", name: "Example", path: projectPath, team: { checks: [{ command: "node", args: ["-e", "require('fs').writeFileSync('must-not-run', 'ran')"] }] }, linear: { teamId: "11111111-1111-4111-8111-111111111111" } };
  const apiKeyFile = join(root, "linear-key"); writeFileSync(apiKeyFile, "fixture-key", { mode: 0o600 });
  const config = (): Config => ({
    port: 0, origin: "http://localhost", stateDir, runDir, keyFile: join(root, "key"), tokens: [],
    projects: [structuredClone(project)], agents: {}, environment: "cloud", enableDemo: false, maxSessions: 1,
    teams: { workspaceDir: join(root, "team-workspaces"), commandPrefix: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", prefixReceipts] } },
    linear: { apiKeyFile },
  });
  const key = randomBytes(32);
  return { root, projectPath, prefixReceipts, config, key, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("repository enrollment validates Git, persists a path-bound overlay, and replays the same request", async () => {
  const f = fixture();
  try {
    let config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    const request = {
      requestId: randomUUID(), revision: 0,
      team: { checks: [{ command: "node", args: ["-e", "require('fs').writeFileSync('must-not-run', 'ran')"] }], handoff: "auto" as const },
      linear: null,
    };
    const saved = await service.put("example", request);
    assert.equal(saved.revision, 1);
    assert.equal(saved.execution, "cloud");
    assert.deepEqual(saved.team, request.team);
    assert.deepEqual(saved.hostSetup, { ready: true, missing: [] });
    assert.equal(readFileSync(join(f.projectPath, "tracked.txt"), "utf8"), "committed\n");
    const commands = readFileSync(join(f.prefixReceipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(commands[0], { command: "git", args: ["-c", `safe.directory=${realpathSync(f.projectPath)}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "user.name=Infinite", "-c", "user.email=agent@example.invalid", "rev-parse", "--show-toplevel"], cwd: realpathSync(f.projectPath) });
    assert.deepEqual(commands[2].args.slice(-2), ["rev-parse", "HEAD"]);

    const file = join(f.root, "state", "repo-enrollments.sealed");
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes(f.projectPath), false);
    assert.equal(raw.includes(request.requestId), false);
    const stored = unseal<{ projects: Record<string, { path: string; revision: number }>; requests: Record<string, { fingerprint: string }> }>(f.key, "repo-enrollments", raw);
    assert.equal(stored.projects.example.path, realpathSync(f.projectPath));
    assert.equal(stored.projects.example.revision, 1);
    assert.ok(stored.requests[request.requestId]?.fingerprint);
    const moved = f.config(); const movedPath = join(f.root, "moved-project"); mkdirSync(movedPath); moved.projects[0].path = movedPath;
    assert.throws(() => new RepoEnrollmentService(moved, f.key).get("example"), /path no longer matches/);

    config = f.config();
    const restarted = new RepoEnrollmentService(config, f.key);
    assert.deepEqual(restarted.get("example"), saved);
    assert.deepEqual(await restarted.put("example", request), saved);
    await assert.rejects(restarted.put("example", { ...request, team: { ...request.team, handoff: "off" } }), /request ID belongs/);
    const competing = await Promise.allSettled([
      restarted.put("example", { requestId: randomUUID(), revision: 1, team: request.team }),
      restarted.put("example", { requestId: randomUUID(), revision: 1, team: { ...request.team, handoff: "off" } }),
    ]);
    assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter(result => result.status === "rejected").length, 1);
    assert.match(String((competing.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /changed. Refresh/);
    assert.equal(Reflect.get(config.projects[0].team!, "handoff"), Reflect.get(restarted.get("example").team!, "handoff"));
    assert.equal(config.projects[0].linear, undefined);
    assert.equal(existsSync(join(f.projectPath, "must-not-run")), false);
  } finally { f.close(); }
});

test("teamwork enrollment persists a home-relative folder and rejects protected, overlapping, or symlink paths", async () => {
  const f = fixture();
  try {
    const homeDir = f.root;
    const config = f.config(); config.sync = { homeDir };
    const service = new RepoEnrollmentService(config, f.key);
    const request = { requestId: randomUUID(), revision: 0, team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] }, teamwork: "Projects/teamwork" };
    const saved = await service.put("example", request);
    assert.equal(saved.teamwork, "Projects/teamwork");
    assert.equal(config.projects[0].teamworkDir, join(realpathSync(homeDir), "Projects/teamwork"));
    const restartedConfig = f.config(); restartedConfig.sync = { homeDir };
    assert.equal(new RepoEnrollmentService(restartedConfig, f.key).get("example").teamwork, "Projects/teamwork");
  } finally { f.close(); }
  const rejects = async (path: string, code: string | undefined, change?: (root: string, value: Config) => void) => {
    const g = fixture();
    try {
      const value = g.config(); value.sync = { homeDir: g.root }; change?.(g.root, value);
      const enrollment = new RepoEnrollmentService(value, g.key);
      const request = { requestId: randomUUID(), revision: 0, team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] }, teamwork: path };
      await assert.rejects(enrollment.put("example", request), (error: { code?: string }) => code === undefined || error.code === code, path);
      assert.equal(value.projects[0].teamworkDir, undefined, "a refused folder is not applied");
    } finally { g.close(); }
  };
  await rejects("project/work", "teamwork-path-conflict");
  await rejects("Projects", "teamwork-path-conflict", (root, value) => {
    const child = join(root, "Projects/child"); mkdirSync(child, { recursive: true });
    value.projects.push({ id: "nested", name: "Nested", path: child });
  });
  await rejects("linked/teamwork", "teamwork-path-symlink", root => {
    const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(root, "linked"));
  });
  await rejects("team-workspaces/sample", "teamwork-path-conflict");
  await rejects("state", "teamwork-path-conflict");
  await rejects("../outside", undefined);
});

test("repository enrollment rejects stale revisions, dirty worktrees, and in-flight changes", async () => {
  const f = fixture();
  try {
    const service = new RepoEnrollmentService(f.config(), f.key, { isBusy: id => id === "example" });
    const request = { requestId: randomUUID(), revision: 0, team: { checks: [{ command: "git", args: ["status"] }] } };
    await assert.rejects(service.put("example", request), /cannot change while a team run/);

    const missingWorkspace = f.config(); delete missingWorkspace.teams;
    const missingSetupService = new RepoEnrollmentService(missingWorkspace, f.key);
    assert.deepEqual(missingSetupService.get("example").hostSetup, { ready: false, missing: ["teams.workspaceDir"] });
    await assert.rejects(missingSetupService.put("example", { ...request, requestId: randomUUID() }), /Configure the host team workspace/);
    const privilegedProvider = f.config(); privilegedProvider.agents.codex = { command: "sudo", args: [] }; delete privilegedProvider.teams!.commandPrefix;
    await assert.rejects(new RepoEnrollmentService(privilegedProvider, f.key).put("example", { ...request, requestId: randomUUID() }), /command prefix/);
    const overlappingProject = f.config(); overlappingProject.projects[0].path = overlappingProject.stateDir;
    await assert.rejects(new RepoEnrollmentService(overlappingProject, f.key).put("example", { ...request, requestId: randomUUID() }), /overlaps host runtime/);

    const idle = new RepoEnrollmentService(f.config(), f.key);
    writeFileSync(join(f.projectPath, "untracked.txt"), "uncommitted\n");
    await assert.rejects(idle.put("example", { ...request, requestId: randomUUID() }), /Commit or separately preserve/);
    await assert.rejects(idle.put("example", { ...request, requestId: randomUUID(), revision: 1 }), /changed. Refresh/);
  } finally { f.close(); }
});

test("owner CLI enrolls a mirrored repository, while other roles and browser owners cannot change it", { timeout: 45000 }, async () => {
  const external = mkdtempSync(join(tmpdir(), "infinite-enrollment-route-"));
  const homeDir = join(external, "home");
  const teamWorkspace = join(external, "team-workspaces");
  mkdirSync(homeDir); mkdirSync(teamWorkspace);
  const host = await startHost({ config: { sync: { homeDir }, teams: { workspaceDir: teamWorkspace } } });
  try {
    const mapped = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/sample" });
    assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
    const projectPath = mapped.body.path as string;
    git(projectPath, "init", "--initial-branch=main");
    writeFileSync(join(projectPath, "tracked.txt"), "committed\n");
    git(projectPath, "add", "tracked.txt");
    git(projectPath, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");

    const endpoint = `/projects/${mapped.body.id}/team`;
    const initial = await host.fetchApi(endpoint);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.revision, 0);
    const teamsBefore = JSON.stringify(host.config.teams), agentsBefore = JSON.stringify(host.config.agents);
    const request = { requestId: randomUUID(), revision: 0, team: { checks: [{ command: "node", args: ["-e", "require('fs').writeFileSync('route-check-ran', 'yes')"] }], handoff: "off" }, linear: null };
    const saved = await host.fetchApi(endpoint, "owner", request, {}, "PUT");
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.team.handoff, "off");
    assert.deepEqual(saved.body.hostSetup, { ready: true, missing: [] });
    assert.equal(JSON.stringify(host.config.teams), teamsBefore);
    assert.equal(JSON.stringify(host.config.agents), agentsBefore);
    assert.equal(existsSync(join(projectPath, "route-check-ran")), false, "enrollment stores commands without executing them");

    for (const role of ["controller", "viewer"] as const) {
      assert.equal((await host.fetchApi(endpoint, role)).status, 403);
      assert.equal((await host.fetchApi(endpoint, role, { ...request, requestId: randomUUID() }, {}, "PUT")).status, 403);
    }
    const login = await host.fetchApi("/login", null, { token: host.tokens.owner }, { Origin: host.config.origin });
    assert.equal(login.status, 200);
    const browser = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: host.config.origin };
    assert.equal((await host.fetchApi(endpoint, null, undefined, browser)).status, 403);
    assert.equal((await host.fetchApi(endpoint, null, request, browser, "PUT")).status, 403);
    assert.equal((await host.fetchApi(endpoint, "owner", { ...request, requestId: randomUUID(), agents: { codex: { command: "sudo", args: [] } } }, {}, "PUT")).status, 400);

    await host.stopApi();
    await host.start();
    const afterRestart = await host.fetchApi(endpoint);
    assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
    assert.equal(afterRestart.body.revision, 1);
    assert.deepEqual(afterRestart.body.team, saved.body.team);
    assert.equal(JSON.stringify(host.config.teams), teamsBefore);
    assert.equal(JSON.stringify(host.config.agents), agentsBefore);
    assert.equal((await host.fetchApi(endpoint, "owner", request, {}, "PUT")).body.revision, 1, "the durable request receipt is replayed after host restart");
  } finally { await host.stop(); rmSync(external, { recursive: true, force: true }); }
});
