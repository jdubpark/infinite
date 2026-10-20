import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { demoProfile, startHost, waitFor } from "./helpers.js";
import { readSyncState, stopSyncService } from "../packages/host/src/sync-service.js";
import { compareLaptop, describeSource } from "../packages/host/src/client.js";
import type { ProjectSourceStatus } from "../packages/host/src/project-source.js";

const exec = promisify(execFile);

const sourceStatus = (changes: Partial<ProjectSourceStatus> = {}): ProjectSourceStatus => ({
  mode: "github", repository: "example/product", baseBranch: "main", ...changes,
});

test("describeSource renders GitHub source heads, pending states, and saved edits", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const appliedHead = "0123456789abcdef0123456789abcdef01234567";
  const mirrorHead = "fedcba9876543210fedcba9876543210fedcba98";
  const minute = (count: number) => new Date(now - count * 60_000).toISOString();

  assert.equal(describeSource(sourceStatus({ appliedHead, mirrorHead: appliedHead, fetchedAt: minute(2), appliedAt: minute(3) }), now),
    "follows github example/product@main · host 01234567 = origin/main · fetched 2m ago · applied 3m ago");
  assert.equal(describeSource(sourceStatus({ appliedHead, mirrorHead, pending: { reason: "fetch-failed", category: "auth", since: minute(14) } }), now),
    "follows github example/product@main · host 01234567, origin/main fedcba98 · fetch failed 14m ago: auth");
  assert.equal(describeSource(sourceStatus({ appliedHead, mirrorHead, pending: { reason: "fetch-failed", category: "auth", message: "grant the GitHub App access", since: minute(14) }, savedBranches: ["infinite/saved-old", "infinite/saved-new"] }), now),
    "follows github example/product@main · host 01234567, origin/main fedcba98 · fetch failed 14m ago: auth · grant the GitHub App access · saved local edits on infinite/saved-new");
  assert.equal(describeSource(sourceStatus({ appliedHead, mirrorHead, pending: { reason: "session-running", since: minute(1) } }), now),
    "follows github example/product@main · host 01234567, origin/main fedcba98 · waiting: session running");
  assert.equal(describeSource(sourceStatus({ appliedHead, mirrorHead, pending: { reason: "diverged", since: minute(1) } }), now),
    "follows github example/product@main · host diverged from origin/main");
  assert.equal(describeSource(sourceStatus({ mirrorHead }), now),
    "follows github example/product@main · host none, origin/main fedcba98");
  assert.equal(describeSource(sourceStatus(), now),
    "follows github example/product@main · host none, origin/main unknown");
  assert.equal(describeSource({ mode: "laptop" }, now), "follows laptop");
});

test("compareLaptop uses the host mirror commit and exact local graph counts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-source-compare-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (file: string, contents: string) => {
    writeFileSync(join(root, file), contents);
    git("add", file);
    git("-c", "commit.gpgsign=false", "commit", "-m", contents);
    return git("rev-parse", "HEAD");
  };
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", root], { stdio: "ignore" });
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.invalid");
    const base = commit("base.txt", "base");
    git("checkout", "--quiet", "-b", "laptop");
    const laptop = commit("laptop.txt", "laptop");
    git("checkout", "--quiet", "-b", "host", base);
    const host = commit("host.txt", "host");
    const withHead = (mirrorHead?: string) => sourceStatus({ mirrorHead, fetchedAt: new Date(now - 180_000).toISOString() });

    assert.equal(compareLaptop(root, withHead(), now), "host has not fetched origin/main yet");
    assert.equal(compareLaptop(root, withHead("0".repeat(40)), now), "host is ahead; fetch to compare");
    assert.equal(compareLaptop(root, withHead(host), now), `laptop ${host.slice(0, 8)} = origin/main`);
    assert.equal(compareLaptop(root, withHead(base), now), "laptop has 1 unpushed commits; the host runs origin/main");
    git("checkout", "--quiet", base);
    assert.equal(compareLaptop(root, withHead(host), now), "laptop is 1 commits behind origin/main (host fetched 3m ago)");
    git("checkout", "--quiet", laptop);
    assert.equal(compareLaptop(root, withHead(host), now), "laptop and origin/main have diverged (1 and 1 commits)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync refuses a GitHub source before starting the laptop service", { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-source-sync-")));
  const checkout = join(root, "checkout"), hostProject = join(root, "host-project");
  const fallbackProject = join(root, "fallback-project");
  mkdirSync(checkout); mkdirSync(hostProject); mkdirSync(fallbackProject);
  execFileSync("git", ["init", "--quiet", "-b", "main", checkout], { stdio: "ignore" });
  execFileSync("git", ["-C", checkout, "config", "user.name", "Test User"], { stdio: "ignore" });
  execFileSync("git", ["-C", checkout, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  writeFileSync(join(checkout, "file.txt"), "enrolled checkout\n");
  execFileSync("git", ["-C", checkout, "add", "file.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-m", "Initial fixture"], { stdio: "ignore" });
  const host = await startHost({ config: { projects: [
    { id: "rehearsal", name: "Rehearsal", path: hostProject, source: { mode: "github", repository: "example/product", baseBranch: "main" } },
    { id: "fallback", name: "Fallback", path: fallbackProject },
  ] } });
  const clientFile = join(root, "client.json"), stateFile = join(root, "sync", "rehearsal.json");
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner, projectId: "fallback" }), { mode: 0o600 });
  const identity = createHash("sha256").update(`${host.origin}\n${host.tokens.owner}`).digest("hex");
  const mappingsPath = join(root, "team-cli", identity, "repo-mappings.json");
  mkdirSync(join(root, "team-cli", identity), { recursive: true, mode: 0o700 });
  writeFileSync(mappingsPath, JSON.stringify({ [`${host.origin}\n${checkout}`]: { projectId: "rehearsal", source: "test" } }), { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  try {
    await assert.rejects(exec(process.execPath, [...cli, "sync"], { cwd: checkout }),
      (error: { stderr: string }) => /This project follows GitHub; laptop sync is off\. Push to GitHub, or re-enroll with infinite repo init --source laptop\./.test(error.stderr));
    assert.equal(existsSync(stateFile), false);
    await assert.rejects(exec(process.execPath, [...cli, "sync", "--project", "rehearsal"], { cwd: checkout }),
      (error: { stderr: string }) => /This project follows GitHub; laptop sync is off\. Push to GitHub, or re-enroll with infinite repo init --source laptop\./.test(error.stderr));
    assert.equal(existsSync(stateFile), false);
  } finally {
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("cloud launches mirror the local home layout, checkout contents, and nested cwd across API restarts", { timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-folders-")));
  const home = join(root, "local-home"), remoteHome = join(root, "server-home");
  mkdirSync(home);
  const host = await startHost({ agents: { claude: demoProfile() }, config: { sync: { homeDir: remoteHome } } });
  const clientFile = join(root, "client.json");
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal" }), { mode: 0o600 });
  const entry = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const cli = [...entry, "--detach", "claude"];
  const states = new Set<string>();
  try {
    const projects: string[] = [];
    for (const parent of ["Projects", "Work"]) {
      const checkout = join(home, parent, "sample project"), cwd = join(checkout, "apps", "web");
      mkdirSync(cwd, { recursive: true });
      await exec("git", ["init", "--quiet", checkout]);
      writeFileSync(join(checkout, "content.txt"), parent);
      const launched = await exec(process.execPath, cli, { cwd, env: { ...process.env, HOME: home }, timeout: 60000 });
      const session = await host.fetchApi(`/sessions/${launched.stdout.trim()}`);
      assert.equal(session.status, 200);
      assert.notEqual(session.body.projectId, "rehearsal", "pairing's default must not replace the local folder");
      states.add(join(root, "sync", `${session.body.projectId}.json`));
      projects.push(session.body.projectId);
      assert.equal(session.body.cwd, join(remoteHome, parent, "sample project", "apps", "web"));
      assert.equal(readFileSync(join(remoteHome, parent, "sample project", "content.txt"), "utf8"), parent);
      assert.equal(existsSync(join(remoteHome, parent, "sample project", ".git", "HEAD")), true);
    }
    assert.notEqual(projects[0], projects[1], "equal folder names have distinct full-path identities");
    await host.stopApi();
    await host.start();
    const catalog = (await host.fetchApi("/me")).body.projects;
    for (const id of projects) assert.ok(catalog.some((project: { id: string }) => project.id === id));
    const repeated = await exec(process.execPath, cli, { cwd: join(home, "Projects", "sample project", "apps", "web"), env: { ...process.env, HOME: home }, timeout: 60000 });
    const session = (await host.fetchApi(`/sessions/${repeated.stdout.trim()}`)).body;
    assert.equal(session.projectId, projects[0]);
    assert.equal(session.cwd, join(remoteHome, "Projects", "sample project", "apps", "web"));
    symlinkSync(root, join(remoteHome, "Projects", "sample project", "escape"));
    for (const cwd of ["../", root, "content.txt", "escape"])
      assert.equal((await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "claude", projectId: projects[0], title: "Invalid directory", cwd })).status, 400, cwd);
    const outside = join(root, "outside-home"); mkdirSync(outside);
    await assert.rejects(exec(process.execPath, cli, { cwd: outside, env: { ...process.env, HOME: home } }), (error: { stderr: string }) => /below the home directory/.test(error.stderr));
    const conflict = join(home, "Projects", "conflict"), cloud = join(remoteHome, "Projects", "conflict");
    mkdirSync(conflict); mkdirSync(cloud);
    writeFileSync(join(conflict, "local.txt"), "laptop"); writeFileSync(join(cloud, "cloud.txt"), "preserve");
    const project = (await host.fetchApi("/projects/resolve", "owner", { path: "Projects/conflict" })).body.id;
    states.add(join(root, "sync", `${project}.json`));
    await assert.rejects(exec(process.execPath, cli, { cwd: conflict, env: { ...process.env, HOME: home } }), (error: { stderr: string }) => /mirrored workspace has not been applied/.test(error.stderr));
    assert.equal(readFileSync(join(cloud, "cloud.txt"), "utf8"), "preserve");
    assert.equal(existsSync(join(cloud, "local.txt")), false);
    assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 3, "a refused first apply cannot launch on unrelated cloud contents");
    await host.stopApi();
    const stopped = await exec(process.execPath, [...entry, "sync", "--stop"], { cwd: join(home, "Work", "sample project", "apps", "web"), env: { ...process.env, HOME: home } });
    assert.match(stopped.stdout, /stopped/);
    assert.equal(existsSync(join(root, "sync", `${projects[1]}.json`)), false, "offline stop selects this folder instead of the paired default");
  } finally {
    for (const state of states) stopSyncService(state);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("infinite sync, projects, and pull round-trip a checkout through the host", { timeout: 120000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-synccli-"));
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key");
  writeFileSync(tokenFile, host.tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const stateFile = join(root, "sync", "rehearsal.json");
  const server = createServer();
  try {
    await exec(process.execPath, [...cli, "pair", host.origin, "--token-file", tokenFile]);
    writeFileSync(join(checkout, "file.txt"), "from laptop\n");
    await new Promise<void>(resolve => server.listen(join(checkout, "dev.sock"), resolve));
    const started = await exec(process.execPath, [...cli, "sync", "--project", "rehearsal"], { cwd: checkout });
    assert.match(started.stderr, /Left out 1 socket, FIFO, or device file, which sync cannot copy: dev\.sock\n/);
    // Closing the server removes the socket; the next capture clears the recorded count.
    await new Promise(resolve => server.close(resolve));
    await waitFor(async () => readSyncState(stateFile), recorded => Boolean(recorded && !recorded.skipped), 15000);
    const state = readSyncState(stateFile);
    assert.ok(state);
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 30000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "file.txt"), "utf8"), "from laptop\n");
    const listed = await exec(process.execPath, [...cli, "projects"]);
    assert.match(listed.stdout, /rehearsal\s+Rehearsal\s+· synced \d+s ago/);
    const running = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.match(running.stdout, new RegExp(`^rehearsal  service pid ${state.pid} · ${checkout} · synced \\d+s ago`));

    writeFileSync(join(host.config.projects[0].path, "cloud.txt"), "from cloud\n");
    const output = join(root, "pulled");
    const pulled = await exec(process.execPath, [...cli, "pull", "rehearsal", "--output", output]);
    const cwd = pulled.stdout.trim();
    assert.equal(readFileSync(join(cwd, "cloud.txt"), "utf8"), "from cloud\n");
    assert.equal(existsSync(join(checkout, "cloud.txt")), false, "pull never writes into the checkout");
    // The running service would upload a copy pulled into its checkout.
    await assert.rejects(exec(process.execPath, [...cli, "pull", "rehearsal", "--output", join(checkout, "nested", "pulled")]),
      (error: { stderr: string }) => /Choose an --output directory outside every synced checkout/.test(error.stderr));
    assert.equal(existsSync(join(checkout, "nested")), false);

    writeFileSync(join(checkout, "file.txt"), "second\n");
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "cloud-changed", 30000);
    await assert.rejects(exec(process.execPath, [...cli, "sync", "--apply", "--project", "rehearsal"]),
      (error: { stderr: string }) => /Not applied\. synced \d+s ago · applied \d+s ago · pending \(cloud changed; use infinite sync --apply --force/.test(error.stderr));
    const forced = await exec(process.execPath, [...cli, "sync", "--apply", "--force", "--project", "rehearsal"]);
    assert.match(forced.stdout, /^synced \d+s ago · applied \d+s ago\n$/);
    assert.equal(readFileSync(join(host.config.projects[0].path, "file.txt"), "utf8"), "second\n");
    assert.equal(existsSync(join(host.config.projects[0].path, "cloud.txt")), false, "a forced apply replaces cloud edits");

    // A failed apply shows its category and the retry command; the host cannot stage beside the project directory.
    chmodSync(host.root, 0o500);
    try {
      writeFileSync(join(checkout, "file.txt"), "third\n");
      await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "apply-failed", 30000);
      const failure = /· pending \(apply failed: permission\. The host account cannot read, write, or remove part of the cloud project\.[^)]* Retry with infinite sync --apply\)/;
      assert.match((await exec(process.execPath, [...cli, "projects"])).stdout, failure);
      assert.match((await exec(process.execPath, [...cli, "sync", "--status"])).stdout, failure);
    } finally { chmodSync(host.root, 0o700); }

    // Stopping and inspecting the local service work while the host is down.
    await host.stopApi();
    const stopped = await exec(process.execPath, [...cli, "sync", "--stop"]);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(existsSync(stateFile), false);
    await waitFor(async () => { try { process.kill(state.pid, 0); return true; } catch { return false; } }, alive => !alive, 10000);
    const offline = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.equal(offline.stdout, "rehearsal  no local service · host unreachable\n");
    // Without the host to vouch for the ID, a path-like project must not name the client configuration.
    await assert.rejects(exec(process.execPath, [...cli, "sync", "--stop", "--project", "../client"]), (error: { stderr: string }) => /Choose a project with --project ID/.test(error.stderr));
    assert.ok(existsSync(clientFile), "the device credentials stay in place");

    // A record left behind by a killed service names a pid that no longer runs it.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(stateFile, JSON.stringify({ ...state, pid: dead }), { mode: 0o600 });
    await host.start();
    const stale = await exec(process.execPath, [...cli, "sync", "--status"]);
    assert.match(stale.stdout, new RegExp(`^rehearsal  stale service record \\(pid ${dead} not running\\) · synced \\d+s ago`));
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});

test("a cloud launch reports laptop changes that wait for an apply, then starts on the tree in place", { timeout: 120000 }, async () => {
  const host = await startHost({ agents: { demo: demoProfile(), claude: demoProfile() } });
  const root = realpathSync(mkdtempSync("/tmp/inf-synccli-"));
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key");
  writeFileSync(tokenFile, host.tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const stateFile = join(root, "sync", "rehearsal.json");
  try {
    await exec(process.execPath, [...cli, "pair", host.origin, "--token-file", tokenFile]);
    const busy = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: busy, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${busy}`), r => r.body.status === "running");
    writeFileSync(join(checkout, "file.txt"), "from laptop\n");
    await exec(process.execPath, [...cli, "sync", "--project", "rehearsal"], { cwd: checkout });
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "session-running", 30000);
    // Infinite options come before the provider; everything after it belongs to the provider.
    const launched = await exec(process.execPath, [...cli, "--project", "rehearsal", "--detach", "--title", "Next", "claude"], { timeout: 60000 });
    assert.match(launched.stderr, /\[Infinite\] Laptop changes from \d+s ago are pending; run infinite sync --apply\n/);
    assert.match(launched.stdout, /^[0-9a-f-]{36}\n$/, "the launch continues");
    assert.equal(existsSync(join(host.config.projects[0].path, "file.txt")), false, "the session starts on the tree in place");
    // Every listed session names where its tools run.
    const machine = (await host.fetchApi("/me")).body.machine.label;
    const lines = (await exec(process.execPath, [...cli, "list"])).stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(line.endsWith(`· tools on ${machine}`), line);
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
