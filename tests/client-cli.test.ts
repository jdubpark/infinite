import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { createApp } from "../packages/host/src/server.js";
import { hashToken } from "../packages/host/src/config.js";
import { workerCall } from "../packages/host/src/ipc.js";
import type { Config } from "../packages/host/src/types.js";
import { homedir, tmpdir } from "node:os";
import { claimControl, startHost, waitFor } from "./helpers.js";
import { fixture as teamFixture, mixedLineup } from "./team-fixture.js";

const exec = promisify(execFile);
const wait = async (predicate: () => boolean | Promise<boolean>, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 80)); }
  throw new Error("Timed out waiting for CLI behavior");
};

test("CLI cmux delegates exact arguments without pairing Infinite and preserves the launcher's exit status", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-cmux-cli-"));
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "cmux"];
  writeFileSync(join(root, "infinite-cmux"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n", { mode: 0o700 });
  try {
    const args = ["--json", "workspace", "run", "--", "literal $HOME; `command`", "two\nlines"];
    await assert.rejects(exec(process.execPath, [...cli, ...args], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, INFINITE_CLIENT_CONFIG: join(root, "unpaired.json") } }),
      (error: { code: number; stdout: string }) => error.code === 7 && JSON.stringify(JSON.parse(error.stdout)) === JSON.stringify(args));
    await assert.rejects(exec(process.execPath, cli, { env: { ...process.env, PATH: root + "/missing" } }),
      (error: { stderr: string }) => /standalone infinite-cmux launcher is unavailable/.test(error.stderr));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team CLI starts and reads a real host team, and reports missing host setup before launch", { timeout: 120000 }, async () => {
  const run = await teamFixture("success");
  const clientFile = join(run.host.root, "team-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts")];
  const cli = [...entry, "--client-config", clientFile];
  try {
    const started = JSON.parse((await exec(cli[0], [...cli.slice(1), "team", "start", "Check the project", "--project", "rehearsal", "--provider", "demo", "--json"])).stdout);
    assert.equal(started.projectId, "rehearsal");
    assert.ok(started.id);
    const status = JSON.parse((await exec(cli[0], [...cli.slice(1), "team", "status", started.id, "--json"])).stdout);
    assert.equal(status.id, started.id);
    assert.equal(typeof status.workspace, "string");
    assert.equal(typeof status.branch, "string");

    const unavailable = await startHost();
    const unavailableConfig = join(unavailable.root, "client.json");
    writeFileSync(unavailableConfig, JSON.stringify({ origin: unavailable.origin, token: unavailable.tokens.owner }), { mode: 0o600 });
    try {
      await assert.rejects(exec(entry[0], [...entry.slice(1), "--client-config", unavailableConfig, "team", "start", "Should not launch", "--project", "rehearsal", "--provider", "demo"]),
        (error: { stderr: string }) => /Host team configuration is incomplete: teams.workspaceDir/.test(error.stderr));
      assert.deepEqual((await unavailable.fetchApi("/teams")).body.teams, [], "missing host setup does not create a team");
    } finally { await unavailable.stop(); }
  } finally { await run.close(); }
});

test("team pull imports an integrated branch without changing the checkout and refuses a divergent branch", { timeout: 120000 }, async () => {
  const run = await teamFixture("success");
  const localRoot = mkdtempSync(join(tmpdir(), "infinite-team-pull-"));
  const checkout = join(localRoot, "checkout"), otherCheckout = join(localRoot, "other-checkout");
  const clientFile = join(run.host.root, "pull-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  try {
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    assert.equal(team.status, "ready-for-review");
    const checks = JSON.stringify([{ command: process.execPath, args: ["check.mjs", "--prefix"] }]);
    await exec("git", ["clone", "--no-hardlinks", run.source, checkout]);
    const enroll = await exec(entry[0], [...entry.slice(1), "repo", "init", "--project", "rehearsal", "--check-json", checks], { cwd: checkout });
    assert.match(enroll.stdout, /"id": "rehearsal"/);

    const pull = async (directory = checkout, ...args: string[]) => exec(entry[0], [...entry.slice(1), "team", "pull", team.id, ...args], { cwd: directory });
    const first = JSON.parse((await pull(checkout, "--json")).stdout);
    assert.deepEqual(first, { teamId: team.id, branch: team.branch, head: team.headCommit });
    assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", `refs/heads/${team.branch}`], { encoding: "utf8" }).trim(), team.headCommit);
    assert.equal(execFileSync("git", ["-C", checkout, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim(), "main");
    const second = JSON.parse((await pull(checkout, "--json")).stdout);
    assert.deepEqual(second, { teamId: team.id, branch: team.branch, head: team.headCommit, upToDate: true });

    await exec("git", ["-C", checkout, "switch", team.branch]);
    writeFileSync(join(checkout, "local.txt"), "Local work on top of the team result.\n");
    await exec("git", ["-C", checkout, "add", "local.txt"]);
    await exec("git", ["-C", checkout, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Local work"]);
    assert.deepEqual(JSON.parse((await pull(checkout, "--json")).stdout), { teamId: team.id, branch: team.branch, head: team.headCommit, upToDate: true });

    await exec("git", ["-C", checkout, "checkout", "-B", team.branch, run.base]);
    writeFileSync(join(checkout, "diverged.txt"), "Independent local result.\n");
    await exec("git", ["-C", checkout, "add", "diverged.txt"]);
    await exec("git", ["-C", checkout, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Diverged local work"]);
    const diverged = execFileSync("git", ["-C", checkout, "rev-parse", `refs/heads/${team.branch}`], { encoding: "utf8" }).trim();
    await exec("git", ["-C", checkout, "switch", "main"]);
    await assert.rejects(pull(checkout, "--json"), (error: { stderr: string }) => /Git refused to update .*local branch was left unchanged/i.test(error.stderr));
    assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", `refs/heads/${team.branch}`], { encoding: "utf8" }).trim(), diverged);
    assert.equal(execFileSync("git", ["-C", checkout, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim(), "main");

    await exec("git", ["clone", "--no-hardlinks", run.source, otherCheckout]);
    await exec(entry[0], [...entry.slice(1), "repo", "init", "--project", "rehearsal", "--check-json", checks], { cwd: otherCheckout });
    const identity = createHash("sha256").update(`${run.host.origin}\n${run.host.tokens.owner}`).digest("hex");
    const mappingsPath = join(dirname(clientFile), "team-cli", identity, "repo-mappings.json");
    const mappings = JSON.parse(readFileSync(mappingsPath, "utf8"));
    mappings[`${run.host.origin}\n${realpathSync(otherCheckout)}`].projectId = "another-project";
    writeFileSync(mappingsPath, JSON.stringify(mappings), { mode: 0o600 });
    await assert.rejects(pull(otherCheckout, "--json"), (error: { stderr: string }) => /another-project.*rehearsal|rehearsal.*another-project/.test(error.stderr));
  } finally { await run.close(); rmSync(localRoot, { recursive: true, force: true }); }
});

test("team pull refuses a lifecycle run before review", { timeout: 60000 }, async () => {
  const run = await teamFixture("lifecycle");
  const localRoot = mkdtempSync(join(tmpdir(), "infinite-team-pull-not-ready-"));
  const checkout = join(localRoot, "checkout");
  const clientFile = join(run.host.root, "pull-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  try {
    // Readiness is checked before the repository binding, so no enrollment is needed;
    // enrolling would also replace the fixture's held check.
    await exec("git", ["clone", "--no-hardlinks", run.source, checkout]);
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    assert.ok([200, 201].includes(created.status));
    await waitFor(() => run.host.fetchApi(`/teams/${created.body.id}`), response => response.body.status === "verifying" && response.body.checks.some((check: { status: string }) => check.status === "running"), 30000);
    await assert.rejects(
      exec(entry[0], [...entry.slice(1), "team", "pull", created.body.id], { cwd: checkout }),
      (error: { stderr: string }) => /team is not ready to pull/i.test(error.stderr),
    );
  } finally { await run.close(); rmSync(localRoot, { recursive: true, force: true }); }
});

test("repo init configures an explicit project without resolving or replacing its checkout", { timeout: 120000 }, async () => {
  const run = await teamFixture("success", mixedLineup);
  const clientFile = join(run.host.root, "repo-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts")];
  const cli = [...entry, "--client-config", clientFile];
  const head = (await exec("git", ["-C", run.source, "rev-parse", "HEAD"])).stdout.trim();
  const checks = JSON.stringify([{ command: "git", args: ["status", "--short"] }]);
  try {
    for (let index = 0; index < 2; index++) {
      const output = JSON.parse((await exec(cli[0], [...cli.slice(1), "repo", "init", run.source, "--project", "rehearsal", "--check-json", checks, "--json"])).stdout);
      assert.equal(output.id, "rehearsal");
      assert.equal(output.source, "configured project checkout");
      assert.equal(output.team.handoff, "auto");
    }
    assert.equal((await exec("git", ["-C", run.source, "rev-parse", "HEAD"])).stdout.trim(), head);
    const before = await run.host.fetchApi("/me");
    await exec(cli[0], [...cli.slice(1), "--detach", "--title", "Bound team project", "claude"], { cwd: run.source });
    const sessions = (await run.host.fetchApi("/sessions")).body.sessions;
    const launched = sessions.find((session: { title: string }) => session.title === "Bound team project");
    assert.equal(launched?.projectId, "rehearsal", "normal launches use the saved directory binding without --project");
    assert.deepEqual((await run.host.fetchApi("/me")).body.projects.map((project: { id: string }) => project.id), before.body.projects.map((project: { id: string }) => project.id), "a bound launch does not resolve a second workspace");
  } finally { await run.close(); }
});

test("projects forget matches the Git root and removes local repository bindings and the paired default", { timeout: 30000 }, async () => {
  const localRoot = mkdtempSync(join(homedir(), "infinite-cli-forget-"));
  const cloudHome = mkdtempSync(join(tmpdir(), "infinite-cli-forget-cloud-"));
  const host = await startHost({ config: { sync: { homeDir: cloudHome } } });
  const configFile = join(host.root, "forget-client.json");
  const client = { origin: host.origin, token: host.tokens.owner, projectId: "placeholder" };
  writeFileSync(configFile, JSON.stringify(client), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", configFile];
  try {
    await exec("git", ["init", "--initial-branch=main"], { cwd: localRoot });
    const mapping = await host.fetchApi("/projects/resolve", "owner", { path: relative(homedir(), localRoot) });
    assert.equal(mapping.status, 200);
    client.projectId = mapping.body.id;
    writeFileSync(configFile, JSON.stringify(client), { mode: 0o600 });
    const identity = createHash("sha256").update(`${host.origin}\n${host.tokens.owner}`).digest("hex");
    const mappingsPath = join(dirname(configFile), "team-cli", identity, "repo-mappings.json");
    mkdirSync(dirname(mappingsPath), { recursive: true, mode: 0o700 });
    writeFileSync(mappingsPath, JSON.stringify({ [`${host.origin}\n${realpathSync(localRoot)}`]: { projectId: mapping.body.id, source: "test" } }), { mode: 0o600 });

    const output = await exec(entry[0], [...entry.slice(1), "projects", "forget"], { cwd: localRoot });
    assert.match(output.stdout, /cloud files were kept/);
    assert.ok(output.stdout.includes(mapping.body.path));
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).projectId, undefined);
    assert.deepEqual(JSON.parse(readFileSync(mappingsPath, "utf8")), {});
    assert.equal(existsSync(mapping.body.path), true);
    assert.equal((await host.fetchApi("/me")).body.projects.some((project: { id: string }) => project.id === mapping.body.id), false);
  } finally { await host.stop(); rmSync(localRoot, { recursive: true, force: true }); rmSync(cloudHome, { recursive: true, force: true }); }
});

test("repo init sends, removes, and omits the teamwork setting as requested", { timeout: 120000 }, async () => {
  const run = await teamFixture("success", mixedLineup);
  const localRoot = mkdtempSync(join(homedir(), "infinite-cli-teamwork-"));
  const checkout = join(localRoot, "checkout"), teamwork = join(localRoot, "teamwork");
  mkdirSync(checkout); mkdirSync(teamwork);
  await exec("git", ["init", "--initial-branch=main"], { cwd: checkout });
  writeFileSync(join(checkout, "source.txt"), "local checkout\n");
  await exec("git", ["-C", checkout, "add", "source.txt"]);
  await exec("git", ["-C", checkout, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture"]);
  const clientFile = join(run.host.root, "teamwork-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const checks = ["--check-json", JSON.stringify([{ command: "node", args: ["-e", "process.exit(0)"] }])];
  const invoke = (args: string[]) => exec(entry[0], [...entry.slice(1), "repo", "init", checkout, "--project", "rehearsal", ...checks, ...args], { cwd: checkout });
  try {
    const selected = JSON.parse((await invoke(["--teamwork", "../teamwork", "--json"])).stdout);
    const relativeTeamwork = relative(realpathSync(homedir()), realpathSync(teamwork)).split(/[\\/]/).join("/");
    assert.equal(selected.teamwork, relativeTeamwork);
    const omitted = JSON.parse((await invoke(["--json"])).stdout);
    assert.equal(omitted.teamwork, relativeTeamwork, "omission retains the saved host setting");
    const removed = JSON.parse((await invoke(["--teamwork", "none", "--json"])).stdout);
    assert.equal(removed.teamwork, null);
  } finally { await run.close(); rmSync(localRoot, { recursive: true, force: true }); }
});

test("repo init enrolls an unborn local repository without changing it and uploads an empty cloud baseline", { timeout: 120000 }, async () => {
  const localRoot = mkdtempSync(join(homedir(), "infinite-cli-unborn-repo-"));
  const cloudHome = mkdtempSync(join(tmpdir(), "infinite-cli-unborn-cloud-"));
  const run = await teamFixture("success", undefined, { sync: { homeDir: cloudHome } });
  const clientFile = join(run.host.root, "unborn-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const invoke = (args: string[], gitEnv: NodeJS.ProcessEnv = {}) => exec(entry[0], [...entry.slice(1), "repo", "init", ...args], { env: { ...process.env, ...gitEnv } });
  const snapshot = (path: string): string => {
    const hash = createHash("sha256");
    const visit = (current: string, prefix = "") => {
      for (const name of readdirSync(current).sort()) {
        const child = join(current, name), relativePath = prefix ? `${prefix}/${name}` : name;
        const info = statSync(child);
        hash.update(`${relativePath}\0${info.mode}\0`);
        if (info.isDirectory()) visit(child, relativePath);
        else hash.update(readFileSync(child));
      }
    };
    visit(path);
    return hash.digest("hex");
  };
  try {
    await exec("git", ["init", "--initial-branch=main"], { cwd: localRoot });
    mkdirSync(join(localRoot, ".git", "info"), { recursive: true });
    writeFileSync(join(localRoot, ".git", "info", "exclude"), "private.local\n");
    writeFileSync(join(localRoot, "private.local"), "ignored local content\n");
    const before = snapshot(localRoot);
    const output = JSON.parse((await invoke([localRoot, "--json"], {
      GIT_DIR: join(localRoot, ".git"),
      GIT_WORK_TREE: localRoot,
      GIT_INDEX_FILE: join(localRoot, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(localRoot, ".git", "objects"),
      GIT_COMMON_DIR: join(localRoot, ".git"),
    })).stdout);
    assert.equal(output.source, "empty cloud baseline");
    assert.deepEqual(output.team, { checks: [], establishChecks: true, handoff: "auto" });
    assert.equal(snapshot(localRoot), before, "repo init leaves all source and Git metadata bytes unchanged");
    assert.equal((await exec("git", ["-C", localRoot, "status", "--porcelain", "--ignored", "--untracked-files=all"])).stdout, "!! private.local\n");
    await assert.rejects(exec("git", ["-C", localRoot, "rev-parse", "--verify", "HEAD"]), "the local repository remains unborn");

    const detail = (await run.host.fetchApi(`/projects/${output.id}`)).body;
    assert.ok(detail.sync?.appliedManifest, "the temporary baseline is applied to the cloud project");
    assert.equal(readdirSync(detail.path).some(name => name !== ".git"), false, "ignored local content is never uploaded");
    assert.equal((await exec("git", ["-C", detail.path, "status", "--porcelain", "--untracked-files=all"])).stdout, "");
    const remoteLog = (await exec("git", ["-C", detail.path, "log", "--format=%H %P", "-1"])).stdout.trim().split(" ");
    assert.match(remoteLog[0], /^[a-f0-9]{40,64}$/);
    assert.equal(remoteLog.length, 1, "the cloud baseline has no parent commit");
    assert.equal((await exec("git", ["-C", detail.path, "ls-tree", "-r", "--name-only", "HEAD"])).stdout, "", "the cloud baseline has an empty tree");

    const cloudNote = join(detail.path, "cloud-note.txt");
    writeFileSync(cloudNote, "cloud-side change\n");
    await exec("git", ["-C", detail.path, "add", "cloud-note.txt"]);
    await exec("git", ["-C", detail.path, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Cloud-side change"]);
    const cloudHead = (await exec("git", ["-C", detail.path, "rev-parse", "HEAD"])).stdout.trim();
    const repeated = JSON.parse((await invoke([localRoot, "--json"])).stdout);
    assert.equal(repeated.id, output.id);
    assert.equal(repeated.source, "existing cloud checkout retained");
    assert.equal((await exec("git", ["-C", detail.path, "rev-parse", "HEAD"])).stdout.trim(), cloudHead, "repeated init does not replace the existing cloud snapshot");
    assert.equal(readFileSync(cloudNote, "utf8"), "cloud-side change\n");

    const configured = (await run.host.fetchApi("/projects/rehearsal/team")).body.team;
    const explicit = JSON.parse((await invoke([localRoot, "--project", "rehearsal", "--json"])).stdout);
    assert.deepEqual(explicit.team.checks, configured.checks, "an explicit target keeps its configured checks");
    assert.equal(explicit.team.establishChecks, undefined, "an explicit target with checks does not enable check establishment");
    assert.equal(explicit.source, "configured project checkout", "an explicit target retains its checkout");
    assert.equal(snapshot(localRoot), before, "an explicit target does not replace the source checkout");
  } finally { await run.close(); rmSync(localRoot, { recursive: true, force: true }); rmSync(cloudHome, { recursive: true, force: true }); }
});

test("repo init refuses dirty unborn repositories and damaged Git HEAD metadata", { timeout: 120000 }, async () => {
  const dirtyRoot = mkdtempSync(join(homedir(), "infinite-cli-dirty-unborn-"));
  const damagedRoot = mkdtempSync(join(homedir(), "infinite-cli-damaged-head-"));
  const run = await teamFixture("success");
  const clientFile = join(run.host.root, "unborn-refusal-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const invoke = (path: string) => exec(entry[0], [...entry.slice(1), "repo", "init", path]);
  try {
    await exec("git", ["init", "--initial-branch=main"], { cwd: dirtyRoot });
    writeFileSync(join(dirtyRoot, "untracked.txt"), "must remain local\n");
    await assert.rejects(invoke(dirtyRoot), (error: { stderr: string }) => /Repository must be clean/.test(error.stderr));

    await exec("git", ["init", "--initial-branch=main"], { cwd: damagedRoot });
    writeFileSync(join(damagedRoot, ".git", "HEAD"), "not-a-symbolic-ref\n");
    await assert.rejects(invoke(damagedRoot), (error: { stderr: string }) => /Git|git|HEAD/.test(error.stderr));
    assert.equal(readFileSync(join(dirtyRoot, "untracked.txt"), "utf8"), "must remain local\n");
    assert.equal(readFileSync(join(damagedRoot, ".git", "HEAD"), "utf8"), "not-a-symbolic-ref\n");
  } finally { await run.close(); rmSync(dirtyRoot, { recursive: true, force: true }); rmSync(damagedRoot, { recursive: true, force: true }); }
});

test("repo init keeps directory Linear defaults local, inherits the nearest mapping, and persists enrollment precedence", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-defaults-"));
  const localRoot = mkdtempSync(join(homedir(), "infinite-linear-defaults-"));
  const hostRepos = join(root, "host-repositories"); mkdirSync(hostRepos);
  const cloudHome = join(root, "cloud-home"); mkdirSync(cloudHome);
  const apiKeyFile = join(root, "linear-key"); writeFileSync(apiKeyFile, "fixture-credential\n", { mode: 0o600 });
  const makeGitRepo = async (path: string) => {
    mkdirSync(path, { recursive: true });
    await exec("git", ["init", "--initial-branch=main"], { cwd: path });
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { check: "node -e process.exit(0)" } }));
    await exec("git", ["-C", path, "add", "package.json"]);
    await exec("git", ["-C", path, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture"]);
  };
  const existing = { teamId: randomUUID(), projectId: randomUUID() };
  const hostProjects = [
    { id: "existing-target", name: "Existing target", path: join(hostRepos, "existing"), team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] }, linear: existing },
    { id: "explicit-target", name: "Explicit target", path: join(hostRepos, "explicit"), team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] } },
    { id: "descendant-target", name: "Descendant target", path: join(hostRepos, "descendant"), team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] } },
    { id: "isolated-target", name: "Isolated target", path: join(hostRepos, "isolated"), team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] } },
  ];
  for (const project of hostProjects) await makeGitRepo(project.path);

  const run = await teamFixture("success", undefined, {
    projects: hostProjects,
    linear: { apiKeyFile },
    sync: { homeDir: cloudHome },
  });
  const ownerConfig = join(run.host.root, "owner-client.json");
  const otherPairingConfig = join(run.host.root, "other-pairing-client.json");
  writeFileSync(ownerConfig, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  writeFileSync(otherPairingConfig, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.viewer }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts")];
  const invoke = (config: string, args: string[], cwd?: string) => exec(entry[0], [...entry.slice(1), "--client-config", config, "repo", "init", ...args], cwd ? { cwd } : undefined);
  const parent = join(localRoot, "checkout"); mkdirSync(parent);
  const nested = join(parent, "nested"); mkdirSync(nested);
  const childInherits = join(nested, "inherited-child");
  const childExisting = join(nested, "existing-child");
  const childExplicit = join(nested, "explicit-child");
  const childDescendant = join(childInherits, "descendant");
  const isolatedParent = join(localRoot, "other-pairing"); mkdirSync(isolatedParent);
  const isolatedChild = join(isolatedParent, "child");
  const checks = ["--check-json", JSON.stringify([{ command: "node", args: ["-e", "process.exit(0)"] }])];
  const parentTeam = randomUUID(), parentProject = randomUUID();
  const nestedTeam = randomUUID(), nestedProject = randomUUID();
  const explicitTeam = randomUUID();
  const otherPairingTeam = randomUUID(), otherPairingProject = randomUUID();
  let hostStopped = false;
  try {
    // Both defaults are saved while the host is unreachable. A parent folder must not resolve,
    // upload, or enroll anything on the host.
    await run.host.stopApi(); hostStopped = true;
    const parentResult = JSON.parse((await invoke(ownerConfig, [parent, "--linear-team", parentTeam, "--linear-project", parentProject])).stdout);
    assert.equal(parentResult.kind, "directory");
    assert.deepEqual(parentResult.linear, { teamId: parentTeam, projectId: parentProject });
    const nestedResult = JSON.parse((await invoke(ownerConfig, [nested, "--linear-team", nestedTeam, "--linear-project", nestedProject])).stdout);
    assert.deepEqual(nestedResult.linear, { teamId: nestedTeam, projectId: nestedProject });
    const isolatedResult = JSON.parse((await invoke(otherPairingConfig, [isolatedParent, "--linear-team", otherPairingTeam, "--linear-project", otherPairingProject])).stdout);
    assert.deepEqual(isolatedResult.linear, { teamId: otherPairingTeam, projectId: otherPairingProject });
    await run.host.start(); hostStopped = false;

    for (const path of [childInherits, childExisting, childExplicit, isolatedChild]) await makeGitRepo(path);
    const inheritedOutput = JSON.parse((await invoke(ownerConfig, [childInherits, ...checks])).stdout);
    const inheritedTarget = inheritedOutput.id as string;
    assert.deepEqual(inheritedOutput.linear, { teamId: nestedTeam, projectId: nestedProject }, "the nearest directory default applies when the target has no mapping");
    assert.equal(inheritedOutput.linearDefaultsFrom, realpathSync(nested));

    await makeGitRepo(childDescendant);

    const existingOutput = JSON.parse((await invoke(ownerConfig, [childExisting, "--project", "existing-target", ...checks])).stdout);
    assert.deepEqual(existingOutput.linear, existing, "the target project's saved mapping takes precedence over its parent defaults");

    const explicitOutput = JSON.parse((await invoke(ownerConfig, [childExplicit, "--project", "explicit-target", "--linear-team", explicitTeam, ...checks])).stdout);
    assert.deepEqual(explicitOutput.linear, { teamId: explicitTeam }, "an explicit different team does not keep the inherited project");

    const descendantOutput = JSON.parse((await invoke(ownerConfig, [childDescendant, "--project", "descendant-target", ...checks])).stdout);
    assert.deepEqual(descendantOutput.linear, { teamId: nestedTeam, projectId: nestedProject }, "an enrolled Git repository supplies defaults to its own descendant");
    assert.equal(descendantOutput.linearDefaultsFrom, realpathSync(childInherits));

    const isolatedOutput = JSON.parse((await invoke(ownerConfig, [isolatedChild, "--project", "isolated-target", ...checks])).stdout);
    assert.equal(isolatedOutput.linear, undefined, "defaults saved under another pairing do not cross into this pairing");

    const inheritedApi = await run.host.fetchApi(`/projects/${inheritedTarget}/team`);
    assert.deepEqual(inheritedApi.body.linear, { teamId: nestedTeam, projectId: nestedProject });
    assert.deepEqual((await run.host.fetchApi("/projects/existing-target/team")).body.linear, existing);
    assert.deepEqual((await run.host.fetchApi("/projects/explicit-target/team")).body.linear, { teamId: explicitTeam });
    assert.deepEqual((await run.host.fetchApi("/projects/descendant-target/team")).body.linear, { teamId: nestedTeam, projectId: nestedProject });
    assert.equal((await run.host.fetchApi("/projects/isolated-target/team")).body.linear, undefined);

    // Editing the directory default later does not rebind an already-enrolled repository.
    const changedParentProject = randomUUID();
    await invoke(ownerConfig, [nested, "--linear-team", nestedTeam, "--linear-project", changedParentProject]);
    rmSync(childDescendant, { recursive: true, force: true });
    const unchangedChild = JSON.parse((await invoke(ownerConfig, [childInherits, ...checks])).stdout);
    assert.deepEqual(unchangedChild.linear, { teamId: nestedTeam, projectId: nestedProject });

    await run.host.stopApi(); hostStopped = true;
    await run.host.start(); hostStopped = false;
    assert.deepEqual((await run.host.fetchApi(`/projects/${inheritedTarget}/team`)).body.linear, { teamId: nestedTeam, projectId: nestedProject }, "the effective mapping survives host restart");
    assert.deepEqual((await run.host.fetchApi("/projects/descendant-target/team")).body.linear, { teamId: nestedTeam, projectId: nestedProject });
  } finally {
    if (hostStopped) await run.host.start();
    await run.close(); rmSync(root, { recursive: true, force: true }); rmSync(localRoot, { recursive: true, force: true });
  }
});

test("a lost child enrollment receipt preserves concurrent defaults and requires exact-ID replay", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-default-race-"));
  const apiKeyFile = join(root, "linear-key"); writeFileSync(apiKeyFile, "fixture-credential\n", { mode: 0o600 });
  const hostRepos = join(root, "host-repositories"); mkdirSync(hostRepos);
  const hostProjects = ["race-target", "lost-target"].map(id => ({ id, name: id, path: join(hostRepos, id), team: { checks: [{ command: "node", args: ["-e", "process.exit(0)"] }] } }));
  const run = await teamFixture("success", undefined, { linear: { apiKeyFile }, projects: hostProjects });
  const proxy = createServer();
  let announcePut!: () => void;
  const putReceived = new Promise<void>(resolve => announcePut = resolve);
  let releasePut: (() => void) | undefined;
  let holdNextPut = false, dropNextPut = false, putCount = 0;
  let enrollmentChild: ReturnType<typeof spawn> | undefined;
  const clientFile = join(run.host.root, "race-client.json");
  const parent = join(root, "parent"); mkdirSync(parent);
  const childRepo = join(parent, "child"); mkdirSync(childRepo);
  const lostChild = join(parent, "lost-child"); mkdirSync(lostChild);
  const teamBefore = randomUUID(), projectBefore = randomUUID();
  const teamAfter = randomUUID(), projectAfter = randomUUID();
  const makeRepo = async (path: string) => {
    mkdirSync(path, { recursive: true });
    await exec("git", ["init", "--initial-branch=main"], { cwd: path });
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { check: "node -e process.exit(0)" } }));
    await exec("git", ["-C", path, "add", "package.json"]);
    await exec("git", ["-C", path, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture"]);
  };
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts")];
  const invoke = (args: string[]) => exec(entry[0], [...entry.slice(1), "--client-config", clientFile, "repo", "init", ...args]);
  let proxyOrigin = "";
  try {
    for (const project of hostProjects) await makeRepo(project.path);
    await makeRepo(childRepo); await makeRepo(lostChild);
    proxy.on("request", (req, res) => {
      const upstream = httpRequest(run.host.origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(run.host.origin).host } }, response => {
        if (req.method === "PUT" && /^\/api\/projects\/(?:race-target|lost-target)\/team$/.test(req.url ?? "")) {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            putCount++;
            if (dropNextPut) { dropNextPut = false; res.destroy(); }
            else if (holdNextPut) {
              holdNextPut = false;
              releasePut = () => { res.writeHead(response.statusCode ?? 500, response.headers); res.end(Buffer.concat(chunks)); };
              announcePut();
            }
            else {
              res.writeHead(response.statusCode ?? 500, response.headers); res.end(Buffer.concat(chunks));
            }
          });
        } else {
          res.writeHead(response.statusCode ?? 500, response.headers); response.pipe(res);
        }
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    writeFileSync(clientFile, JSON.stringify({ origin: proxyOrigin, token: run.host.tokens.owner }), { mode: 0o600 });

    await invoke([parent, "--linear-team", teamBefore, "--linear-project", projectBefore]);
    const startEnrollment = (path: string, projectId: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      enrollmentChild = spawn(entry[0], [...entry.slice(1), "--client-config", clientFile, "repo", "init", path, "--project", projectId, "--check-json", JSON.stringify([{ command: "node", args: ["-e", "process.exit(0)"] }])], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      enrollmentChild.stdout.on("data", value => stdout += value); enrollmentChild.stderr.on("data", value => stderr += value);
      enrollmentChild.once("error", reject);
      enrollmentChild.once("exit", code => resolve({ code, stdout, stderr }));
    });
    holdNextPut = true;
    const pending = startEnrollment(childRepo, "race-target");
    await wait(() => releasePut !== undefined, 20000);
    await putReceived;
    await invoke([parent, "--linear-team", teamAfter, "--linear-project", projectAfter]);
    releasePut!(); releasePut = undefined;
    const result = await pending;
    enrollmentChild = undefined;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).linear, { teamId: teamBefore, projectId: projectBefore });
    const currentParent = JSON.parse((await invoke([parent])).stdout);
    assert.deepEqual(currentParent.linear, { teamId: teamAfter, projectId: projectAfter }, "the successful child save merges with the latest parent defaults");
    assert.deepEqual((await run.host.fetchApi("/projects/race-target/team")).body.linear, { teamId: teamBefore, projectId: projectBefore });

    // A first inherited request can commit even though its response is lost. Natural retry must
    // preserve that uncertain request instead of creating another mutation.
    const lostArgs = [lostChild, "--project", "lost-target", "--check-json", JSON.stringify([{ command: "node", args: ["-e", "process.exit(0)"] }])];
    dropNextPut = true;
    let lostError: { stderr?: string } | undefined;
    try { await invoke(lostArgs); assert.fail("the proxy dropped the committed response"); }
    catch (error) { lostError = error as { stderr?: string }; }
    const requestId = /\[Infinite\] Request ([a-f0-9-]{36})/.exec(lostError?.stderr ?? "")?.[1];
    assert.ok(requestId, "the request ID is recorded before the uncertain mutation");
    const saved = await run.host.fetchApi("/projects/lost-target/team");
    assert.deepEqual(saved.body.linear, { teamId: teamAfter, projectId: projectAfter });
    assert.equal(saved.body.revision, 1);
    await assert.rejects(invoke(lostArgs), (error: { stderr: string }) => /earlier request has an uncertain result/.test(error.stderr) && error.stderr.includes(requestId));
    assert.equal(putCount, 2, "the natural retry is stopped before another host mutation");
    const replay = JSON.parse((await invoke([...lostArgs, "--request-id", requestId])).stdout);
    assert.deepEqual(replay.linear, { teamId: teamAfter, projectId: projectAfter });
    const afterReplay = await run.host.fetchApi("/projects/lost-target/team");
    assert.equal(afterReplay.body.revision, saved.body.revision, "exact-ID replay returns the committed enrollment without a new revision");
    assert.deepEqual(afterReplay.body.linear, { teamId: teamAfter, projectId: projectAfter });
    assert.equal(putCount, 3, "only explicit replay sends another request, and the host deduplicates it");
  } finally {
    releasePut?.(); enrollmentChild?.kill();
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await run.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("repo init refuses to enroll a source snapshot while its sync generation is pending", { timeout: 120000 }, async () => {
  const localRoot = mkdtempSync(join(homedir(), "infinite-cli-pending-repo-"));
  const cloudHome = mkdtempSync(join(tmpdir(), "infinite-cli-cloud-home-"));
  const run = await teamFixture("success", undefined, {
    sync: { homeDir: cloudHome },
    agents: { demo: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 120000)"] } },
  });
  const clientFile = join(run.host.root, "pending-repo-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  let sessionId: string | undefined;
  let enrollmentRequestId: string | undefined;
  try {
    await exec("git", ["init", "--initial-branch=main"], { cwd: localRoot });
    writeFileSync(join(localRoot, "README.md"), "source snapshot\n");
    await exec("git", ["-C", localRoot, "add", "README.md"]);
    await exec("git", ["-C", localRoot, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial source"]);
    const resolved = await run.host.fetchApi("/projects/resolve", "owner", { path: relative(homedir(), localRoot) });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const projectId = resolved.body.id;
    const started = await run.host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId, title: "Hold source apply", prompt: "" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    sessionId = started.body.id;
    await waitFor(() => run.host.fetchApi(`/sessions/${sessionId}`), response => ["starting", "running"].includes(response.body.status), 15000);

    await assert.rejects(exec(entry[0], [...entry.slice(1), "repo", "init", localRoot, "--check-json", JSON.stringify([{ command: "git", args: ["status", "--short"] }])]), (error: { stderr: string }) => {
      assert.match(error.stderr, /source snapshot is pending \(session-running\)/);
      assert.match(error.stderr, /sync --apply --project/);
      assert.match(error.stderr, /--request-id/);
      enrollmentRequestId = /\[Infinite\] Request ([a-f0-9-]{36})/.exec(error.stderr)?.[1];
      assert.ok(enrollmentRequestId, "source capture request ID is printed before upload");
      return true;
    });
    const pending = await run.host.fetchApi(`/projects/${projectId}`);
    assert.equal(pending.body.sync.pendingGeneration.reason, "session-running");
    assert.equal(pending.body.sync.appliedManifest, undefined);
    assert.equal((await run.host.fetchApi(`/projects/${projectId}/team`)).body.team, undefined, "pending source never receives team configuration");

    await workerCall(run.host.config.runDir, sessionId, { op: "stop", requestId: randomUUID() });
    await waitFor(() => run.host.fetchApi(`/sessions/${sessionId}`), response => response.body.status === "exited", 15000);
    await exec(entry[0], [...entry.slice(1), "sync", "--apply", "--project", projectId]);
    const applied = await run.host.fetchApi(`/projects/${projectId}`);
    assert.equal(applied.body.sync.pendingGeneration, undefined);
    assert.ok(applied.body.sync.appliedManifest);
    assert.equal(readFileSync(join(applied.body.path, "README.md"), "utf8"), "source snapshot\n");
    const enrolled = JSON.parse((await exec(entry[0], [...entry.slice(1), "repo", "init", localRoot, "--check-json", JSON.stringify([{ command: "git", args: ["status", "--short"] }]), "--request-id", enrollmentRequestId!])).stdout);
    assert.equal(enrolled.id, projectId);
    assert.equal(enrolled.team.checks[0].command, "git");
  } finally {
    if (sessionId) try { await workerCall(run.host.config.runDir, sessionId, { op: "stop", requestId: randomUUID() }); } catch {}
    await run.close(); rmSync(localRoot, { recursive: true, force: true }); rmSync(cloudHome, { recursive: true, force: true });
  }
});

test("team request receipts stay bound to the paired host", { timeout: 120000 }, async () => {
  const first = await teamFixture("success"), second = await teamFixture("success");
  const clientFile = join(first.host.root, "shared-client.json"), requestId = randomUUID();
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts")];
  try {
    for (const [host, objective] of [[first.host, "First host objective"], [second.host, "Second host objective"]] as const) {
      writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
      const result = JSON.parse((await exec(entry[0], [...entry.slice(1), "--client-config", clientFile, "team", "start", objective, "--project", "rehearsal", "--provider", "demo", "--request-id", requestId, "--json"])).stdout);
      assert.equal(result.id, requestId);
      assert.equal(result.objective, objective);
    }
    assert.equal((await first.host.fetchApi(`/teams/${requestId}`)).body.objective, "First host objective");
    assert.equal((await second.host.fetchApi(`/teams/${requestId}`)).body.objective, "Second host objective");
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("an uncertain team start blocks a duplicate and shows the saved request ID", { timeout: 120000 }, async () => {
  const run = await teamFixture("success"), clientFile = join(run.host.root, "lost-start.json");
  let dropped = false;
  const proxy = createServer((req, res) => {
    const drop = !dropped && req.url === "/api/teams" && req.method === "POST";
    const upstream = httpRequest(run.host.origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(run.host.origin).host } }, response => {
      response.on("error", () => res.destroy());
      if (drop) { response.resume(); response.on("end", () => { dropped = true; res.destroy(); }); }
      else { res.writeHead(response.statusCode!, response.headers); response.pipe(res); }
    });
    upstream.on("error", () => res.destroy()); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  writeFileSync(clientFile, JSON.stringify({ origin: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile, "team", "start", "Unique retry objective", "--project", "rehearsal", "--provider", "demo"];
  try {
    await assert.rejects(exec(entry[0], entry.slice(1)), () => dropped);
    await assert.rejects(exec(entry[0], entry.slice(1)), (error: { stderr: string }) => {
      assert.match(error.stderr, /earlier request has an uncertain result/i);
      assert.match(error.stderr, /'--request-id' '[a-f0-9-]{36}'/);
      return true;
    });
    const teams = (await run.host.fetchApi("/teams")).body.teams;
    assert.equal(teams.length, 1);
    assert.equal(teams[0].objective, "Unique retry objective");
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await run.close(); }
});

test("team CLI answers a decision and steers through the host API", { timeout: 120000 }, async () => {
  const run = await teamFixture("question"), clientFile = join(run.host.root, "question-client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const created = run.create();
  try {
    const response = await run.host.fetchApi("/teams", "owner", created);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const id = response.body.id;
    const waiting = await waitFor(() => run.get(id), team => team.decisions.some(decision => !decision.answer), 90000);
    const question = waiting.decisions.find(decision => !decision.answer)!;
    const answered = JSON.parse((await exec(entry[0], [...entry.slice(1), "team", "answer", id, question.id, "Compact", "--json"])).stdout);
    assert.equal(answered.decisions.find((decision: { id: string }) => decision.id === question.id).answer, "Compact");
    const steered = JSON.parse((await exec(entry[0], [...entry.slice(1), "team", "steer", id, "Keep the existing route", "--json"])).stdout);
    assert.ok(steered.steering.some((item: { text: string }) => item.text === "Keep the existing route"));
  } finally { await run.close(); }
});

test("local draft recovery isolates pairings and runtimes, preserves concurrent drafts, and refuses tampered ciphertext", async () => {
  const { localDraftStore } = await import("../packages/host/src/client-draft-store.js");
  const { draftTerminal } = await import("../packages/host/src/client-draft.js");
  const root = mkdtempSync(join(tmpdir(), "infinite-drafts-")), path = join(root, "client.json");
  const identity = { origin: "https://host.example", token: randomBytes(32).toString("hex"), sessionId: randomUUID(), projectId: "project", runtimeId: randomUUID() };
  const notices: string[] = [], report = (s: string) => notices.push(s);
  try {
    const first = localDraftStore(path, identity, report), second = localDraftStore(path, identity, report);
    assert.ok(first.save({ text: "first private draft", state: "draft" }, true));
    assert.equal(second.restore(), undefined, "another live editor's file is not taken over");
    assert.ok(second.save({ text: "second private draft", state: "draft" }, true));
    first.close(); second.close();
    for (const variant of [{ token: randomBytes(32).toString("hex") }, { origin: "https://other.example" }, { runtimeId: randomUUID() }, { sessionId: randomUUID() }]) {
      assert.equal(localDraftStore(path, { ...identity, ...variant }, report).restore(), undefined);
    }
    const restored = localDraftStore(path, identity, report), remaining = new Set(["first private draft", "second private draft"]);
    const draft = restored.restore()!; assert.ok(remaining.delete(draft.text));
    const screen = draftTerminal(restored);
    assert.equal(screen.hasUnsentDraft, true, "handoff preflight can detect a recovered draft even while its editor is closed");
    screen.dispose();
    restored.clear();
    assert.ok(remaining.has(restored.restore()!.text), "discarding one recovered draft preserves the other client's work");
    const files = readdirSync(join(root, "drafts"), { recursive: true }).map(String).filter(p => p.endsWith(".sealed"));
    const file = join(root, "drafts", files[0]);
    const envelope = JSON.parse(readFileSync(file, "utf8")); envelope.t = Buffer.alloc(16).toString("base64");
    writeFileSync(file, JSON.stringify(envelope));
    const damaged = localDraftStore(path, identity, report);
    assert.equal(damaged.restore(), undefined); damaged.close();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).t, envelope.t, "an unreadable recovery is retained rather than overwritten");
    assert.match(notices.at(-1)!, /recovery is unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI reports each startup wait before the host responds and leaves native output clean", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/inf-start-");
  const config = join(root, "client.json"), sessionId = randomUUID();
  const requests = new Map<string, import("node:http").ServerResponse>();
  const server = createServer((req, res) => { req.resume(); requests.set(req.url!, res); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  writeFileSync(config, JSON.stringify({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: randomBytes(32).toString("base64url"), projectId: "project" }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", config, "--project", "project", "grok"], { stdio: "pipe" });
  let stdout = "", stderr = "", exited = false;
  child.stdout.on("data", s => stdout += s); child.stderr.on("data", s => stderr += s); child.on("exit", () => exited = true);
  const reply = (path: string, body: unknown) => requests.get(path)!.end(JSON.stringify(body));
  try {
    await wait(() => requests.has("/api/me"));
    assert.match(stderr, /Connecting to 127\.0\.0\.1/, "connecting is visible before authentication completes");
    reply("/api/me", { role: "owner", terminal: { stream: true, raw: true }, projects: [{ id: "project", name: "Project" }] });
    await wait(() => requests.has("/api/projects/project"));
    reply("/api/projects/project", { id: "project", name: "Project", sync: {} });
    await wait(() => requests.has("/api/sessions"));
    assert.match(stderr, /Starting Grok/, "launch progress precedes session creation");
    reply("/api/sessions", { id: sessionId, provider: "grok", status: "running", title: "Grok", projectId: "project" });
    const path = `/api/sessions/${sessionId}/stream?after=0`;
    await wait(() => requests.has(path));
    assert.match(stderr, /Connecting to .*terminal/);
    await wait(() => /\d+s/.test(stderr), 4000);
    const response = requests.get(path)!;
    response.write(JSON.stringify({ events: [{ type: "output", data: { text: "NATIVE READY\n" } }], state: { status: "running" } }) + "\n");
    await wait(() => stdout.includes("NATIVE READY"));
    const afterHandoff = stderr.length;
    await new Promise(r => setTimeout(r, 2200));
    assert.equal(stderr.slice(afterHandoff), "", "startup status stops when the native terminal takes over");
    response.end(JSON.stringify({ state: { status: "exited", exitCode: 0 } }) + "\n");
    await wait(() => exited);
    assert.equal(stdout, "NATIVE READY\n");
  } finally { child.kill(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});

test("CLI resources preserve unavailable measurements and close requires confirmation, owner authority, and session control", { timeout: 45000 }, async () => {
  const host = await startHost();
  const clientFile = join(host.root, "client.json"), viewerFile = join(host.root, "viewer.json");
  const entry = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts")];
  const cli = [...entry, "--client-config", clientFile];
  for (const [file, token] of [[clientFile, host.tokens.owner], [viewerFile, host.tokens.viewer]])
    writeFileSync(file, JSON.stringify({ origin: host.origin, token, projectId: "rehearsal" }), { mode: 0o600 });
  const ids = [randomUUID(), randomUUID()];
  const clients: IPty[] = [];
  let watch: ReturnType<typeof spawn> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  try {
    for (const id of ids) {
      assert.equal((await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "CLI close rehearsal", prompt: "" })).status, 201);
      await waitFor(() => host.fetchApi(`/sessions/${id}`), response => response.body.status === "running");
    }
    const listing = await exec(process.execPath, [...cli, "list"]);
    const cwd = realpathSync(host.config.projects[0].path);
    assert.ok(listing.stdout.includes(`project rehearsal · cwd ${cwd}`));
    const json = JSON.parse((await exec(process.execPath, [...cli, "list", "--json"])).stdout);
    assert.equal(json.find((s: { id: string }) => s.id === ids[0]).cwd, cwd);
    const resource = JSON.parse((await exec(process.execPath, [...entry, "--client-config", viewerFile, "resources", "--json"])).stdout);
    assert.ok(Number.isFinite(Date.parse(resource.capturedAt)));
    assert.equal(resource.cpu.usagePercent, null, "the first sample is unknown rather than zero");
    assert.equal(resource.network.receiveBytesPerSecond, null);
    assert.ok(resource.sessions.some((s: { sessionId: string }) => s.sessionId === ids[0]));
    assert.match((await exec(process.execPath, [...cli, "resources"])).stdout, /Memory .* available|Memory .* free/);
    watch = spawn(process.execPath, [...cli, "resources", "--watch", "--json"], { stdio: "pipe" });
    let samples = ""; watch.stdout!.on("data", chunk => samples += chunk);
    await wait(() => samples.trim().split("\n").length >= 2);
    const frames = samples.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(frames[1].sampleIntervalMs > 0);
    assert.equal(typeof frames[1].cpu.usagePercent, "number");
    const stopped = new Promise<number | null>(resolve => watch!.once("exit", resolve)); watch.kill("SIGINT");
    assert.equal(await stopped, 0); watch = undefined;

    await assert.rejects(exec(process.execPath, [...cli, "close", ids[0]]), (error: { stderr: string }) => /Use --yes/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [...cli, "close", "--yes"]), (error: { stderr: string }) => /Usage: infinite close SESSION_ID/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [...entry, "--client-config", viewerFile, "close", ids[0], "--yes"]), (error: { stderr: string }) => /owner device key/.test(error.stderr));
    const cancelled = ptySpawn(process.execPath, [...cli, "close", ids[0]], { cols: 160, rows: 30, cwd: host.root, env: { ...process.env } });
    clients.push(cancelled); let output = ""; let cancelledExit = false;
    cancelled.onData(value => output += value); cancelled.onExit(() => cancelledExit = true);
    await wait(() => output.includes("[y/N]")); cancelled.write("n\r"); await wait(() => cancelledExit);
    assert.match(output, /Close cancelled/);
    assert.equal((await host.fetchApi(`/sessions/${ids[0]}`)).body.status, "running");

    await claimControl(host, ids[0], "owner");
    await assert.rejects(exec(process.execPath, [...cli, "close", ids[0], "--yes"]), (error: { stderr: string }) => /control is held by another client or changed/.test(error.stderr));
    assert.equal((await host.fetchApi(`/sessions/${ids[0]}`)).body.status, "running");
    const receipt = JSON.parse((await exec(process.execPath, [...cli, "close", ids[0].slice(0, 8), "--yes", "--takeover", "--json"])).stdout);
    assert.equal(receipt.sessionId, ids[0]); assert.equal(receipt.state, "delivered");
    await waitFor(() => host.fetchApi(`/sessions/${ids[0]}`), response => response.body.status === "exited");
    assert.equal((await host.fetchApi(`/sessions/${ids[1]}`)).body.status, "running", "closing one session preserves its neighbor");

    let stops = 0;
    proxy = createServer((req, res) => {
      const drop = req.url?.endsWith("/stop"); if (drop) stops++;
      const upstream = httpRequest(host.origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(host.origin).host } }, response => {
        response.on("error", () => res.destroy());
        if (drop) { response.resume(); response.on("end", () => res.destroy()); }
        else { res.writeHead(response.statusCode!, response.headers); response.pipe(res); }
      });
      upstream.on("error", () => res.destroy()); req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    const droppedConfig = join(host.root, "dropped-receipt.json");
    writeFileSync(droppedConfig, JSON.stringify({ origin: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, token: host.tokens.owner }), { mode: 0o600 });
    await assert.rejects(exec(process.execPath, [...entry, "--client-config", droppedConfig, "close", ids[1], "--yes"]),
      (error: { stderr: string }) => /Close delivery is unconfirmed/.test(error.stderr) && /Nothing was retried/.test(error.stderr));
    await waitFor(() => host.fetchApi(`/sessions/${ids[1]}`), response => response.body.status === "exited");
    assert.equal(stops, 1, "a lost stop receipt never replays the mutation");
  } finally {
    watch?.kill(); for (const child of clients) { try { child.kill(); } catch {} }
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
    await host.stop();
  }
});

test("native cloud CLI preserves argv, enforces monitor mode, and reconnects without duplicating a process or input", { timeout: 45000 }, async () => {
  const root = mkdtempSync("/tmp/inf-cli-");
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const key = randomBytes(32), keyFile = join(root, "vault.key"); writeFileSync(keyFile, key);
  const tokens = { owner: randomBytes(32).toString("base64url"), controller: randomBytes(32).toString("base64url"), viewer: randomBytes(32).toString("base64url") };
  const fixture = join(root, "native.cjs");
  writeFileSync(fixture, `const fs = require('node:fs');
    fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
    if (process.argv.includes('--version')) { console.log('native-version-1'); process.exit(0); }
    fs.writeFileSync('input.txt', ''); process.stdin.setRawMode(true);
    process.stdout.write('\\x1b[?2004h\\x1b[32mNATIVE READY\\x1b[0m\\r\\n');
    process.stdin.on('data', text => { fs.appendFileSync('input.txt', text); process.stdout.write('RECEIVED:' + JSON.stringify(text.toString()) + '\\r\\n'); });`);
  const config: Config = { port: 0, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
    environment: "local", enableDemo: false, maxSessions: 10,
    tokens: Object.entries(tokens).map(([role, token]) => ({ id: role, label: role, role: role as keyof typeof tokens, hash: hashToken(token) })),
    projects: [{ id: "project", name: "Project", path: workspace }], agents: { codex: { command: process.execPath, args: [fixture] } } };
  let app = createApp(config, key);
  let server = app.server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  config.port = (server.address() as { port: number }).port; config.origin = `http://127.0.0.1:${config.port}`;
  // Recreate after selecting a port so the Host/Origin policy uses the real origin.
  await new Promise<void>(r => server.close(() => r()));
  app = createApp(config, key); server = app.server.listen(config.port, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  // A real transport proxy delays only acknowledgments. Provider input and
  // output remain live, exposing accidental per-key round-trip serialization.
  let holdReceipts = false;
  const held: (() => void)[] = [];
  const relaySockets = new Set<WebSocket>();
  const proxy = createServer((req, res) => {
    const upstream = httpRequest(config.origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(config.origin).host } }, response => {
      response.on("error", () => res.destroy());
      res.writeHead(response.statusCode!, response.headers);
      if (holdReceipts && req.url?.endsWith("/raw")) {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => held.push(() => res.end(Buffer.concat(chunks))));
      } else response.pipe(res);
    });
    upstream.on("error", () => res.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  const relay = new WebSocketServer({ noServer: true });
  proxy.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, client => {
    const upstream = new WebSocket(config.origin.replace("http:", "ws:") + req.url);
    relaySockets.add(client); relaySockets.add(upstream);
    const beforeOpen: Buffer[] = [];
    client.on("message", data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false }); else beforeOpen.push(Buffer.from(data as Buffer)); });
    upstream.on("open", () => { for (const data of beforeOpen) upstream.send(data, { binary: false }); });
    upstream.on("message", data => {
      const deliver = () => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false }); };
      if (holdReceipts && JSON.parse(data.toString()).receipt) held.push(deliver); else deliver();
    });
    upstream.on("close", code => { relaySockets.delete(upstream); client.close(code === 1000 ? 1000 : 1011); });
    client.on("close", () => { relaySockets.delete(client); upstream.close(); });
    upstream.on("error", () => client.close()); client.on("error", () => upstream.close());
  }));
  await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
  const clientOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key"); writeFileSync(tokenFile, tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const clients: IPty[] = [];
  const start = (args: string[]) => { const process = ptySpawn(globalThis.process.execPath, [...cli, ...args], { cols: 110, rows: 30, cwd: root, env: { ...globalThis.process.env } }); clients.push(process); let output = ""; let exited = false; process.onData(s => output += s); process.onExit(() => exited = true); return { process, output: () => output, exited: () => exited }; };
  const call = async (path: string, role: keyof typeof tokens, body?: unknown, cookie?: string) => fetch(config.origin + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { Cookie: cookie, Origin: config.origin } : { Authorization: `Bearer ${tokens[role]}` }), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    await exec(process.execPath, [...cli, "pair", clientOrigin, "--token-file", tokenFile]);
    app.manager.setContext("project", "Do not append me to native argv", 0);
    const nativeArgs = ["--model", "example/model", "--config", "literal=value", "--", "spaces, $HOME and `printf literal`", "line\nbreak"];
    const launched = await exec(process.execPath, [...cli, "--project", "project", "--cloud", "--detach", "codex", ...nativeArgs]);
    const sid = launched.stdout.trim(); assert.match(sid, /^[a-f0-9-]{36}$/);
    await wait(() => { try { return JSON.parse(readFileSync(join(workspace, "argv.json"), "utf8")).length === nativeArgs.length; } catch { return false; } });
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, "argv.json"), "utf8")), nativeArgs, "all provider args are exact, including --config and --");
    const before = await app.manager.state(sid);
    assert.equal((await call(`/sessions/${sid}/raw`, "viewer", { requestId: randomUUID(), text: "X" })).status, 403);
    assert.equal((await call(`/sessions/${sid}/raw`, "controller", { requestId: randomUUID(), text: "X" })).status, 403);
    const login = await fetch(config.origin + "/api/login", { method: "POST", headers: { Origin: config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: tokens.owner }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await call(`/sessions/${sid}/raw`, "owner", { requestId: randomUUID(), text: "X" }, cookie)).status, 403);
    const terminalUrl = config.origin.replace("http:", "ws:") + `/api/sessions/${sid}/terminal`;
    for (const role of ["viewer", "controller"] as const) {
      const socket = new WebSocket(terminalUrl);
      const closed = new Promise<number>(resolve => socket.once("close", resolve));
      let sawState = false;
      socket.on("open", () => socket.send(JSON.stringify({ token: tokens[role] })));
      socket.on("message", data => { if (!sawState && JSON.parse(data.toString()).state) { sawState = true; socket.send(JSON.stringify({ op: "raw", requestId: randomUUID(), text: "FORBIDDEN" })); } });
      assert.equal(await closed, 1008); assert.equal(sawState, true, "read-only roles can monitor but cannot send native keys");
    }
    const unauthenticated = new WebSocket(terminalUrl, { headers: { Cookie: cookie } });
    const unauthenticatedClosed = new Promise<number>(r => unauthenticated.once("close", r));
    let leakedOutput = false;
    unauthenticated.on("message", () => leakedOutput = true);
    unauthenticated.on("open", () => unauthenticated.send(JSON.stringify({ token: "x".repeat(40) })));
    assert.equal(await unauthenticatedClosed, 1008); assert.equal(leakedOutput, false, "cookies cannot authorize a native socket or reveal output");
    const crossOrigin = new WebSocket(terminalUrl, { origin: "https://untrusted.example" });
    crossOrigin.on("error", () => {});
    const rejected = new Promise<number>(resolve => crossOrigin.once("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); crossOrigin.terminate(); }));
    assert.equal(await rejected, 403);
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "");
    assert.equal((await call("/sessions", "owner", { requestId: randomUUID(), provider: "codex", projectId: "project", title: "invalid", nativeArgs: ["bad\0argument"] })).status, 400);
    const list = JSON.parse((await exec(process.execPath, [...cli, "list", "--json"])).stdout);
    assert.equal(list[0].id, sid); assert.equal(list[0].nativeArgs, undefined);
    const monitor = start(["monitor", sid.slice(0, 8)]);
    await wait(() => monitor.output().includes("NATIVE READY"));
    monitor.process.write("ignored"); await new Promise(r => setTimeout(r, 200));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "");
    monitor.process.write("\r"); await wait(() => monitor.output().includes("Interactive. Ctrl+G"));
    monitor.process.write("steer\x1b[A\r");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8") === "steer\x1b[A\r");
    monitor.process.write("\x07ignored again"); await wait(() => monitor.output().includes("Monitoring. Enter enables interaction;")); await new Promise(r => setTimeout(r, 200));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "steer\x1b[A\r");
    monitor.process.write("\r"); await new Promise(r => setTimeout(r, 100));
    monitor.process.write("\x05"); await wait(() => monitor.output().includes("Local draft"));
    monitor.process.write("preserve this unsent draft"); await wait(() => monitor.output().includes("preserve this unsent draft"));
    app.closeConnections(); await new Promise<void>(r => server.close(() => r()));
    await wait(() => monitor.output().includes("Connection lost")); monitor.process.write("offline-input");
    assert.match(monitor.output(), /Unsent draft kept locally/);
    app = createApp(config, key); server = app.server.listen(config.port, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    await wait(() => monitor.output().includes("Reconnected to the same session"));
    assert.equal((await app.manager.state(sid)).pid, before.pid);
    assert.equal((await app.manager.list()).length, 1);
    monitor.process.write("\r"); await new Promise(r => setTimeout(r, 120));
    const draftOffset = monitor.output().length;
    monitor.process.write("\x05"); await wait(() => monitor.output().slice(draftOffset).includes("preserve this unsent draft"));
    monitor.process.write("\x18"); await new Promise(r => setTimeout(r, 100)); monitor.process.write("after");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8").endsWith("after"));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "steer\x1b[A\rafter");
    monitor.process.write("\x1d"); await wait(monitor.exited);
    assert.equal((await app.manager.state(sid)).pid, before.pid);
    const resumed = start(["resume", sid]); await wait(() => resumed.output().includes("Live session connected"));
    holdReceipts = true;
    resumed.process.write("A");
    await wait(() => held.length > 0 && readFileSync(join(workspace, "input.txt"), "utf8").endsWith("A"));
    resumed.process.write("B");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8").endsWith("AB"), 1000);
    holdReceipts = false; held.splice(0).forEach(deliver => deliver());
    const inputBeforeDraft = readFileSync(join(workspace, "input.txt"), "utf8");
    resumed.process.write("\x05"); await wait(() => resumed.output().includes("Local draft"));
    resumed.process.write("instant local text"); await wait(() => resumed.output().includes("instant local text"), 500);
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), inputBeforeDraft, "editing stays entirely local");
    resumed.process.write("\x18"); await new Promise(r => setTimeout(r, 100));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), inputBeforeDraft, "cancelling never sends a draft");
    resumed.process.write("\x05"); await new Promise(r => setTimeout(r, 100));
    resumed.process.write("draft first\rdraft second"); await wait(() => resumed.output().includes("draft second"));
    resumed.process.write("\x13");
    await wait(() => readFileSync(join(workspace, "input.txt"), "utf8") === inputBeforeDraft + "\x1b[200~draft first\ndraft second\x1b[201~");
    await new Promise(r => setTimeout(r, 100));
    resumed.process.write("\x05"); await new Promise(r => setTimeout(r, 100));
    resumed.process.write("survive a killed client"); await wait(() => resumed.output().includes("survive a killed client"));
    const saved = () => readdirSync(join(root, "drafts"), { recursive: true }).map(String).filter(p => p.endsWith(".sealed")).map(p => join(root, "drafts", p));
    await wait(() => { try { return saved().length === 1; } catch { return false; } });
    assert.equal(statSync(saved()[0]).mode & 0o777, 0o600);
    assert.ok(!readFileSync(saved()[0], "utf8").includes("survive a killed client"), "draft content is encrypted at rest");
    resumed.process.kill("SIGKILL"); await wait(resumed.exited);
    const recovered = start(["resume", sid]);
    await wait(() => recovered.output().includes("Live session connected"));
    assert.match(recovered.output(), /Recovered an unsent local draft/);
    recovered.process.write("\x05"); await wait(() => recovered.output().includes("survive a killed client"));
    holdReceipts = true;
    recovered.process.write("\x13");
    await wait(() => held.length > 0 && readFileSync(join(workspace, "input.txt"), "utf8").endsWith("survive a killed client\x1b[201~"));
    const uncertainInput = readFileSync(join(workspace, "input.txt"), "utf8");
    recovered.process.kill("SIGKILL"); await wait(recovered.exited);
    holdReceipts = false; held.splice(0).forEach(deliver => deliver());
    const uncertainDraft = start(["resume", sid]);
    await wait(() => uncertainDraft.output().includes("Live session connected"));
    assert.match(uncertainDraft.output(), /previous draft insertion is unconfirmed/);
    uncertainDraft.process.write("\x05"); await wait(() => uncertainDraft.output().includes("Previous insertion unconfirmed"));
    uncertainDraft.process.write("\x13"); await wait(() => uncertainDraft.output().includes("Insertion blocked"));
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), uncertainInput, "an uncertain insertion is never automatically repeated, even after process death");
    uncertainDraft.process.write("\x18"); await wait(() => saved().length === 0);
    uncertainDraft.process.write("\x1d"); await wait(uncertainDraft.exited);
    assert.equal((await app.manager.list()).length, 1);
    const oneShot = await exec(process.execPath, [...cli, "--project", "project", "--cloud", "codex", "--version"]);
    assert.match(oneShot.stdout, /native-version-1/);
    await workerCall(config.runDir, sid, { op: "stop", requestId: randomUUID() });
    await wait(async () => (await app.manager.state(sid)).status === "exited");
    const ended = start(["resume", sid]); await wait(ended.exited); assert.match(ended.output(), /no longer running/);
  } finally {
    holdReceipts = false; held.splice(0).forEach(deliver => deliver());
    for (const client of clients) { try { client.kill(); } catch {} }
    for (const socket of relaySockets) socket.terminate();
    proxy.closeAllConnections(); await new Promise<void>(r => proxy.close(() => r()));
    for (const s of await app.manager.list()) {
      try { await workerCall(config.runDir, s.id, { op: "stop", requestId: randomUUID() }); } catch {}
      await wait(async () => ["exited", "unavailable"].includes((await app.manager.state(s.id)).status));
    }
    app.closeConnections(); await new Promise<void>(r => server.close(() => r()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a new API lists and streams a pre-attention worker without replacing it", async () => {
  const { createServer } = await import("node:net");
  const { writeSealed, Journal } = await import("../packages/host/src/vault.js");
  const root = mkdtempSync("/tmp/inf-old-");
  const id = randomUUID(), key = randomBytes(32), token = randomBytes(32).toString("base64url");
  const config: Config = { port: 0, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"), environment: "local", enableDemo: false, maxSessions: 2, tokens: [{ id: "owner", label: "owner", role: "owner", hash: hashToken(token) }], projects: [], agents: {} };
  const dir = join(config.stateDir, "sessions", id); mkdirSync(dir, { recursive: true }); mkdirSync(config.runDir);
  writeSealed(join(dir, "meta.sealed"), key, `${id}:meta`, { session: { id, provider: "codex", title: "Older session", projectId: "old", createdAt: new Date().toISOString(), status: "running", context: "", contextVersion: 0, initialPrompt: "", cwd: root }, fingerprint: "old" });
  const journal = new Journal(join(dir, "events"), key, id); journal.append("output", { text: "older-worker-output" });
  // This is the actual pre-attention IPC response shape: the worker sends no attention block.
  // Pre-control workers fingerprint the complete IPC input shape. Seed a
  // delivered request from before upgrade, then retry it through the new API.
  const oldInput = { op: "input", requestId: randomUUID(), text: "before-upgrade", submit: true };
  const oldDigest = createHash("sha256").update(JSON.stringify(oldInput)).digest("hex");
  const oldReceipt = { requestId: oldInput.requestId, state: "delivered", seq: 3 };
  const legacy = createServer(socket => socket.once("data", data => {
    const request = JSON.parse(data.toString());
    const response = request.op === "state"
      ? { result: { status: "running", pid: 12345, seq: 3, screen: "older-worker-output" } }
      : request.op === "input" && createHash("sha256").update(JSON.stringify(request)).digest("hex") === oldDigest
        ? { result: oldReceipt } : { error: "Request ID already belongs to different input" };
    socket.end(JSON.stringify(response) + "\n");
  }));
  await new Promise<void>(r => legacy.listen(join(config.runDir, id + ".sock"), r));
  const app = createApp(config, key); const server = app.server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  config.port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(origin + "/api/sessions", { headers });
    assert.equal(response.status, 200);
    const list = (await response.json() as { sessions: { id: string; pid: number; status: string; attention?: { state: string; now: string } }[] }).sessions;
    assert.equal(list.length, 1); assert.equal(list[0].pid, 12345); assert.equal(list[0].status, "running");
    // The API fills the missing block so clients never break, but invents no idle or finished state.
    assert.equal(list[0].attention?.state, "unavailable"); assert.equal(list[0].attention?.now, "");
    const { op: _op, ...retry } = oldInput;
    const receipt = await fetch(origin + `/api/sessions/${id}/input`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(retry) });
    assert.equal(receipt.status, 200, "rolling upgrade must preserve the old worker's input digest");
    assert.deepEqual(await receipt.json(), oldReceipt);
    const stream = await fetch(origin + `/api/sessions/${id}/stream`, { headers });
    const reader = stream.body!.getReader();
    const chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /older-worker-output/); await reader.cancel();
  } finally { app.closeConnections(); await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => legacy.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});

test("snapshot attachments and fenced device takeover preserve one live process across API restart", { timeout: 35000 }, async () => {
  const { startHost, waitFor } = await import("./helpers.js");
  const { terminalConnection, TerminalControlError } = await import("../packages/host/src/client-transport.js");
  const host = await startHost({ agents: { demo: { command: process.execPath, args: ["-e", `
    process.stdin.setRawMode(true);
    for (let i = 0; i < 1500; i++) console.log('history-row-' + i);
    console.log('snapshot-ready');
    process.stdin.on('data', data => console.log('accepted:' + data.toString()));
  `] } } });
  const clients: ReturnType<typeof terminalConnection>[] = [], aborts: AbortController[] = [];
  const connect = (sid: string, role: "owner" | "viewer", clientId: string, cursor = 0) => {
    const abort = new AbortController(); aborts.push(abort);
    const client = terminalConnection(host.origin, host.tokens[role], sid, cursor, abort.signal, { snapshot: true, control: true, clientId }); clients.push(client);
    const pages: import("../packages/host/src/client-transport.js").TerminalPage[] = [];
    const finished = (async () => { try { for await (const page of client.pages()) pages.push(page); } catch {} })();
    return { client, pages, finished, abort };
  };
  try {
    const created = await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Device transfer" });
    assert.equal(created.status, 201);
    const sid = created.body.id, pid = created.body.pid, runtimeId = created.body.runtime.id;
    const path = `/sessions/${sid}`;
    await waitFor(() => host.fetchApi(path), r => r.body.screen.includes("snapshot-ready"));
    const aId = randomUUID(), a = connect(sid, "owner", aId);
    await wait(() => a.pages.some(p => p.state?.status === "running"));
    const snapshot = a.pages.find(p => p.snapshot)?.snapshot;
    assert.ok(snapshot, "attachment restores a bounded snapshot instead of replaying 1,500 lines");
    assert.match(snapshot.ansi, /snapshot-ready/);
    assert.doesNotMatch(snapshot.ansi, /history-row-0\r?\n/);
    assert.equal(a.pages.flatMap(p => p.events ?? []).filter(e => e.type === "output" && e.seq <= snapshot.seq).length, 0, "no output prefix is replayed twice");
    const leaseA = await a.client.control("claim"); assert.ok(leaseA);
    await a.client.raw("first-owner");
    const bId = randomUUID(), b = connect(sid, "owner", bId);
    await wait(() => b.pages.some(p => p.state));
    await assert.rejects(b.client.control("claim"), error => error instanceof TerminalControlError && error.code === "control-busy");
    const viewer = await host.fetchApi(path + "/control", "viewer", { action: "claim", takeover: true });
    assert.equal(viewer.status, 403);
    const oldHttp = await host.fetchApi(path + "/key", "owner", { requestId: randomUUID(), key: "enter" });
    assert.equal(oldHttp.body.code, "control-busy", "old HTTP clients cannot bypass a new terminal's lease");
    const forged = await host.fetchApi(path + "/input", "owner", { requestId: randomUUID(), text: "forged", submit: false }, { "X-Infinite-Control": leaseA.id, "X-Infinite-Client": bId });
    assert.equal(forged.body.code, "control-lost", "knowing a lease id is insufficient on another authenticated client");
    const leaseB = await b.client.control("claim", true); assert.ok(leaseB); assert.notEqual(leaseB.id, leaseA.id);
    await assert.rejects(a.client.raw("stale-owner"), error => error instanceof TerminalControlError && error.code === "control-lost");
    const staleSize = await host.fetchApi(path + "/resize", "owner", { cols: 42, rows: 11 }, { "X-Infinite-Control": leaseA.id, "X-Infinite-Client": aId });
    assert.equal(staleSize.body.code, "control-lost");
    a.abort.abort(); await a.finished;
    await b.client.raw("second-owner");
    assert.equal((await host.fetchApi(path)).body.control.id, leaseB.id, "stale socket close cannot release a takeover");
    await host.stopApi();
    await b.finished;
    await host.start();
    const next = connect(sid, "owner", bId, snapshot.seq);
    await wait(() => next.pages.some(p => p.state));
    const resumedLease = await next.client.control("claim");
    assert.notEqual(resumedLease!.id, leaseB.id, "same client recovery fences its former connection");
    await next.client.raw("after-restart");
    const state = (await host.fetchApi(path)).body;
    assert.equal(state.pid, pid); assert.equal(state.runtime.id, runtimeId);
    await waitFor(() => host.fetchApi(path), r => r.body.screen.includes("after-restart"));
    const events = (await host.fetchApi(path + "/events?types=input-intent&limit=200")).body.events;
    assert.deepEqual(events.map((e: { data: { text: string } }) => e.data.text), ["first-owner", "second-owner", "after-restart"]);
    await next.client.control("release");
    const phoneHeaders = { "X-Infinite-Client": randomUUID() };
    const phoneLease = await host.fetchApi(path + "/control", "controller", { action: "claim" }, phoneHeaders);
    assert.equal(phoneLease.status, 200);
    const inputId = randomUUID();
    const phoneInput = { requestId: inputId, text: "mobile-steering", submit: false };
    const sendHeaders = { ...phoneHeaders, "X-Infinite-Control": phoneLease.body.control.id };
    const first = await host.fetchApi(path + "/input", "controller", phoneInput, sendHeaders);
    const retry = await host.fetchApi(path + "/input", "controller", phoneInput, sendHeaders);
    assert.equal(first.body.state, "delivered"); assert.deepEqual(first.body, retry.body);
    await host.fetchApi(path + "/control", "controller", { action: "release", leaseId: phoneLease.body.control.id }, phoneHeaders);
    // Device labels were always free-form configuration. Display sanitization
    // must not turn an accepted key into one that can no longer steer a worker.
    for (const label of ["", "long-label-".repeat(20)]) {
      host.config.tokens.find(t => t.role === "owner")!.label = label;
      await host.stopApi();
      writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config), { mode: 0o600 });
      await host.start();
      const headers = { "X-Infinite-Client": randomUUID() };
      const claim = await host.fetchApi(path + "/control", "owner", { action: "claim" }, headers);
      assert.equal(claim.status, 200, "accepted device labels cannot break session control");
      const sent = await host.fetchApi(path + "/input", "owner", { requestId: randomUUID(), text: "label-compatibility", submit: false }, { ...headers, "X-Infinite-Control": claim.body.control.id });
      assert.equal(sent.body.state, "delivered");
      await host.fetchApi(path + "/control", "owner", { action: "release", leaseId: claim.body.control.id }, headers);
    }
  } finally {
    for (const abort of aborts) abort.abort();
    for (const client of clients) client.close();
    await host.stop();
  }
});

test("infinite usage prints the host summary as JSON and readable output", { timeout: 20000 }, async () => {
  const { startHost } = await import("./helpers.js");
  const host = await startHost({ config: { usage: { budgets: { opencode: { usd: 10, period: "month" } } } } });
  const config = join(host.root, "client.json");
  writeFileSync(config, JSON.stringify({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal" }), { mode: 0o600 });
  const cli = resolve("packages/host/src/client-entry.ts");
  try {
    const json = await exec(process.execPath, ["--import", "tsx", cli, "--client-config", config, "usage", "--json"]);
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.providers.opencode.budget.usd, 10);
    assert.equal(summary.providers.opencode.budget.period, "month");
    const readable = await exec(process.execPath, ["--import", "tsx", cli, "--client-config", config, "usage"]);
    assert.match(readable.stdout, /^OpenCode  \S+ to \S+ · no measured usage · budget \$10\.00 per month$/m);
    assert.match(readable.stdout, /^Codex  \S+ to \S+ · unmeasured · no budget configured$/m);
  } finally { await host.stop(); }
});

test("repository CLI pins, preserves and removes owner permission delegation", { timeout: 120000 }, async () => {
  const run = await teamFixture("success");
  const localRoot = mkdtempSync(join(tmpdir(), "infinite-permission-cli-"));
  const checkout = join(localRoot, "checkout");
  const configFile = join(localRoot, "client.json");
  writeFileSync(configFile, JSON.stringify({ origin: run.host.origin, token: run.host.tokens.owner }), { mode: 0o600 });
  const args = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", configFile,
    "repo", "init", "--project", "rehearsal", "--check-json", JSON.stringify([{ command: process.execPath, args: ["check.mjs", "--prefix"] }])];
  const enroll = (...extra: string[]) => exec(process.execPath, [...args, ...extra], { cwd: checkout });
  try {
    await exec("git", ["clone", "--no-hardlinks", run.source, checkout]);
    const first = JSON.parse((await enroll()).stdout);
    assert.deepEqual(first.team.permissions, {
      mode: "coordinator",
      scope: "Approve one-time repository read, edit, build and test operations required by the accepted task within its assigned workspace. Delivery operations require the run's separate pinned delivery policy. Escalate new credentials, other repositories, global settings, deployment, destructive operations, permission bypasses and unclear effects.",
      maxDecisions: 10,
    });
    const delegated = JSON.parse((await enroll("--permissions", "coordinator", "--permission-scope", "Read files and run the configured check only.", "--permission-limit", "3")).stdout);
    assert.deepEqual(delegated.team.permissions, { mode: "coordinator", scope: "Read files and run the configured check only.", maxDecisions: 3 });
    const retained = JSON.parse((await enroll()).stdout);
    assert.deepEqual(retained.team.permissions, delegated.team.permissions);
    await assert.rejects(enroll("--permissions", "coordinator", "--permission-limit", "21"));
    assert.deepEqual((await run.host.fetchApi("/projects/rehearsal/team")).body.team.permissions, delegated.team.permissions);
    const forbidden = await run.host.fetchApi("/projects/rehearsal/team", "controller", {
      requestId: randomUUID(), revision: retained.revision, team: { ...retained.team, permissions: { ...delegated.team.permissions, scope: "Broaden scope" } },
    }, undefined, "PUT");
    assert.equal(forbidden.status, 403);
    const removed = JSON.parse((await enroll("--permissions", "off")).stdout);
    assert.equal(removed.team.permissions, undefined);
    const retainedOff = JSON.parse((await enroll()).stdout);
    assert.equal(retainedOff.team.permissions, undefined, "plain repo init preserves an explicitly saved off policy");
  } finally { await run.close(); rmSync(localRoot, { recursive: true, force: true }); }
});
