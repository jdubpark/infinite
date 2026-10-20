import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectSourceError, ProjectSourceService } from "../packages/host/src/project-source.js";
import type { Config } from "../packages/host/src/types.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const idle = async () => false;

function fixture(options: { prefix?: boolean; sharedGroup?: boolean; environment?: Config["environment"] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-project-source-")));
  const origin = join(root, "github.git");
  const seed = join(root, "seed");
  const projectPath = join(root, "project");
  const stateDir = join(root, "state");
  const prefixReceipts = join(root, "prefix-receipts");
  mkdirSync(stateDir);
  mkdirSync(prefixReceipts);

  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "init", "--initial-branch=main", seed);
  writeFileSync(join(seed, "tracked.txt"), "A\n");
  git(seed, "add", "tracked.txt");
  git(seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Commit A");
  const commitA = git(seed, "rev-parse", "HEAD");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");

  git(root, "clone", "--no-checkout", origin, projectPath);
  git(projectPath, "checkout", "--detach", commitA);
  git(projectPath, "remote", "remove", "origin");

  const config: Config = {
    port: 0,
    origin: "http://localhost",
    stateDir,
    runDir: join(root, "runs"),
    keyFile: join(root, "key"),
    tokens: [],
    projects: [{
      id: "example",
      name: "Example",
      path: projectPath,
      source: { mode: "github", repository: "example/product", baseBranch: "main" },
    }],
    agents: {},
    environment: options.environment ?? "local",
    enableDemo: false,
    maxSessions: 1,
    teams: {
      workspaceDir: join(root, "team-workspaces"),
      ...(options.prefix ? { commandPrefix: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", prefixReceipts] } } : {}),
    },
    sync: options.sharedGroup ? { sharedGroup: true } : undefined,
    source: { mirrorDir: join(root, "mirrors"), remoteOverrides: { example: origin } },
  };

  return {
    root,
    origin,
    seed,
    projectPath,
    stateDir,
    prefixReceipts,
    commitA,
    config,
    service: (running: (projectId: string) => Promise<boolean> = idle) => new ProjectSourceService(config, {
      running,
      ...(options.prefix ? { prefix: config.teams?.commandPrefix } : {}),
    }),
    push: (content: string, message: string) => {
      writeFileSync(join(seed, "tracked.txt"), content);
      git(seed, "add", "tracked.txt");
      git(seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
      git(seed, "push", "origin", "main");
      return git(seed, "rev-parse", "HEAD");
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("first refresh creates the mirror and fast-forwards the detached checkout through the command prefix", async () => {
  const f = fixture({ prefix: true });
  try {
    const commitB = f.push("B\n", "Commit B");
    assert.equal(git(f.projectPath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(git(f.projectPath, "remote"), "", "the uploaded working tree has no origin remote");
    mkdirSync(join(f.projectPath, "node_modules"));
    writeFileSync(join(f.projectPath, "node_modules", "x"), "keep\n");

    const service = f.service();
    const status = await service.refresh("example");
    assert.equal(status.mirrorHead, commitB, JSON.stringify(status));
    assert.equal(status.appliedHead, commitB);
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitB);
    assert.equal(readFileSync(join(f.projectPath, "node_modules", "x"), "utf8"), "keep\n");
    assert.equal(statSync(join(f.root, "mirrors")).mode & 0o7777, 0o750);
    const statusFile = join(f.stateDir, "projects", "example", "source", "status.json");
    assert.deepEqual(JSON.parse(readFileSync(statusFile, "utf8")), status);
    assert.equal(service.status("example").appliedHead, commitB);

    const commands = readFileSync(join(f.prefixReceipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(commands.length, 8, "each host Git operation, including init and fetch, crosses the prefix");
    assert.ok(commands.every(command => command.command === "git"));
    assert.ok(commands.some(command => command.args.includes("fetch")));
  } finally { f.close(); }
});

test("a running session defers the working-tree step and a later refresh applies the fetched head", async () => {
  const f = fixture();
  try {
    const commitB = f.push("B\n", "Commit B");
    let running = true;
    const service = f.service(async () => running);
    const deferred = await service.refresh("example");
    assert.equal(deferred.pending?.reason, "session-running");
    assert.equal(deferred.mirrorHead, commitB);
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), f.commitA);

    running = false;
    const applied = await service.refresh("example");
    assert.equal(applied.pending, undefined, JSON.stringify(applied));
    assert.equal(applied.appliedHead, commitB);
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitB);
  } finally { f.close(); }
});

test("tracked edits are saved on a dated branch while untracked files stay in the checkout", async () => {
  const f = fixture();
  try {
    const commitB = f.push("B\n", "Commit B");
    writeFileSync(join(f.projectPath, "tracked.txt"), "session edit\n");
    writeFileSync(join(f.projectPath, "left-untracked.txt"), "keep\n");

    const status = await f.service().refresh("example");
    const saved = status.savedBranches?.[0];
    assert.match(saved ?? "", /^infinite\/saved-\d{8}-[0-9a-f]{8}$/);
    assert.equal(git(f.projectPath, "log", "-1", "--format=%s", saved ?? ""), "Edits left in the host checkout before a refresh from GitHub");
    assert.equal(status.appliedHead, commitB);
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitB);
    assert.equal(existsSync(join(f.projectPath, "left-untracked.txt")), true);
    assert.equal(git(f.projectPath, "status", "--porcelain", "--untracked-files=no"), "");
    assert.match(git(f.projectPath, "status", "--short"), /\?\? left-untracked\.txt/);
  } finally { f.close(); }
});

test("a diverged host checkout is left alone", async () => {
  const f = fixture();
  try {
    const commitB = f.push("B\n", "Commit B");
    git(f.projectPath, "checkout", "-b", "host-work");
    writeFileSync(join(f.projectPath, "tracked.txt"), "host commit\n");
    git(f.projectPath, "add", "tracked.txt");
    git(f.projectPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Host commit C");
    const commitC = git(f.projectPath, "rev-parse", "HEAD");

    const status = await f.service().refresh("example");
    assert.equal(status.mirrorHead, commitB);
    assert.equal(status.pending?.reason, "diverged");
    assert.equal(status.pending?.message, "the host checkout has commits that are not on main");
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitC);
    assert.equal(readFileSync(join(f.projectPath, "tracked.txt"), "utf8"), "host commit\n");
  } finally { f.close(); }
});

test("a fetch failure is categorized and leaves the applied checkout unchanged", async () => {
  const f = fixture();
  try {
    const service = f.service();
    const initial = await service.refresh("example");
    const commitA = initial.appliedHead;
    f.config.source!.remoteOverrides!.example = join(f.root, "missing.git");

    const failed = await service.refresh("example");
    assert.equal(failed.pending?.reason, "fetch-failed");
    assert.ok(failed.pending?.category === "not-found" || failed.pending?.category === "other");
    assert.ok(["GitHub reports no such repository or branch for the configured source", "the fetch from GitHub failed"].includes(failed.pending?.message ?? ""));
    assert.equal(failed.appliedHead, commitA);
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitA);
  } finally { f.close(); }
});

test("the running check is repeated immediately before the working-tree step", async () => {
  const f = fixture();
  try {
    f.push("B\n", "Commit B");
    let calls = 0;
    const service = f.service(async () => ++calls === 2);
    const status = await service.refresh("example");
    assert.equal(calls, 2);
    assert.equal(status.pending?.reason, "session-running");
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), f.commitA);
  } finally { f.close(); }
});

test("maxAgeMs skips a young fetch even when the GitHub base has moved", async () => {
  const f = fixture();
  try {
    const service = f.service();
    const first = await service.refresh("example", { maxAgeMs: 60_000 });
    const commitB = first.mirrorHead;
    const commitD = f.push("D\n", "Commit D");
    assert.notEqual(commitD, commitB);

    const skipped = await service.refresh("example", { maxAgeMs: 60_000 });
    assert.equal(skipped.mirrorHead, commitB);
    assert.notEqual(skipped.mirrorHead, commitD);
  } finally { f.close(); }
});

test("the mirror parent uses shared group permissions when configured", async () => {
  const f = fixture({ sharedGroup: true });
  try {
    await f.service().refresh("example");
    const mode = statSync(join(f.root, "mirrors")).mode & 0o7777;
    if (process.platform === "linux") assert.equal(mode, 0o2770);
    else assert.equal(mode & 0o770, 0o770, "the filesystem preserves the requested group permissions");
  } finally { f.close(); }
});

test("cloud configuration refuses test remote overrides with a plain error", () => {
  const f = fixture({ environment: "cloud" });
  try {
    assert.throws(() => f.service(), error => error instanceof Error && !(error instanceof ProjectSourceError));
  } finally { f.close(); }
});
