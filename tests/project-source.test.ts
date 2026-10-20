import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.equal(commands.length, 9, "each host Git operation, including init, fetch, and root validation, crosses the prefix");
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

test("partially staged tracked edits preserve both versions on one saved branch", async () => {
  const f = fixture();
  try {
    const commitB = f.push("Remote B\n", "Commit B");
    writeFileSync(join(f.projectPath, "tracked.txt"), "staged B\n");
    git(f.projectPath, "add", "tracked.txt");
    writeFileSync(join(f.projectPath, "tracked.txt"), "worktree C\n");

    const status = await f.service().refresh("example");
    const saved = status.savedBranches?.[0];
    assert.match(saved ?? "", /^infinite\/saved-\d{8}-[0-9a-f]{8}$/);
    assert.equal(git(f.projectPath, "rev-list", "--count", `${f.commitA}..${saved}`), "2");
    assert.deepEqual(
      git(f.projectPath, "log", "--reverse", "--format=%s", `${f.commitA}..${saved}`).split("\n"),
      ["Staged edits left in the host checkout before a refresh from GitHub", "Edits left in the host checkout before a refresh from GitHub"],
    );
    assert.equal(git(f.projectPath, "show", `${saved}~1:tracked.txt`), "staged B");
    assert.equal(git(f.projectPath, "show", `${saved}:tracked.txt`), "worktree C");
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitB);
    assert.equal(git(f.projectPath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(status.appliedHead, commitB);
    assert.equal(git(f.projectPath, "status", "--porcelain", "--untracked-files=no"), "");
  } finally { f.close(); }
});

test("staged-only tracked edits create one saved commit", async () => {
  const f = fixture();
  try {
    const commitB = f.push("Remote B\n", "Commit B");
    writeFileSync(join(f.projectPath, "tracked.txt"), "staged edit\n");
    git(f.projectPath, "add", "tracked.txt");

    const status = await f.service().refresh("example");
    const saved = status.savedBranches?.[0];
    assert.ok(saved);
    assert.equal(git(f.projectPath, "rev-list", "--count", `${f.commitA}..${saved}`), "1");
    assert.equal(git(f.projectPath, "log", "-1", "--format=%s", saved), "Staged edits left in the host checkout before a refresh from GitHub");
    assert.equal(git(f.projectPath, "show", `${saved}:tracked.txt`), "staged edit");
    assert.equal(status.appliedHead, commitB);
  } finally { f.close(); }
});

test("worktree-only tracked edits create one saved commit while untracked files stay in the checkout", async () => {
  const f = fixture();
  try {
    const commitB = f.push("B\n", "Commit B");
    writeFileSync(join(f.projectPath, "tracked.txt"), "session edit\n");
    writeFileSync(join(f.projectPath, "left-untracked.txt"), "keep\n");

    const status = await f.service().refresh("example");
    const saved = status.savedBranches?.[0];
    assert.match(saved ?? "", /^infinite\/saved-\d{8}-[0-9a-f]{8}$/);
    assert.equal(git(f.projectPath, "rev-list", "--count", `${f.commitA}..${saved}`), "1");
    assert.equal(git(f.projectPath, "log", "-1", "--format=%s", saved ?? ""), "Edits left in the host checkout before a refresh from GitHub");
    assert.equal(git(f.projectPath, "show", `${saved}:tracked.txt`), "session edit");
    assert.equal(status.appliedHead, commitB);
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), commitB);
    assert.equal(existsSync(join(f.projectPath, "left-untracked.txt")), true);
    assert.equal(git(f.projectPath, "status", "--porcelain", "--untracked-files=no"), "");
    assert.match(git(f.projectPath, "status", "--short"), /\?\? left-untracked\.txt/);
  } finally { f.close(); }
});

test("a project path nested inside another Git repository is refused without changing its parent", async () => {
  const f = fixture();
  try {
    const nested = join(f.projectPath, "nested-project");
    mkdirSync(nested);
    writeFileSync(join(f.projectPath, "parent-staged.txt"), "staged parent content\n");
    git(f.projectPath, "add", "parent-staged.txt");
    const beforeHead = git(f.projectPath, "rev-parse", "HEAD");
    const beforeIndex = git(f.projectPath, "diff", "--cached", "--binary");
    f.config.projects[0]!.path = nested;

    const status = await f.service().refresh("example");
    assert.equal(status.pending?.reason, "apply-failed");
    assert.equal(status.pending?.category, "other");
    assert.equal(status.pending?.message, "the host checkout is not a Git repository root");
    assert.equal(git(f.projectPath, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(f.projectPath, "diff", "--cached", "--binary"), beforeIndex);
  } finally { f.close(); }
});

test("changing the GitHub source drops old cached heads after a failed fetch and loads the new mirror head", async () => {
  const f = fixture();
  try {
    const service = f.service();
    writeFileSync(join(f.projectPath, "tracked.txt"), "saved before source change\n");
    const first = await service.refresh("example");
    assert.equal(first.mirrorHead, f.commitA);
    assert.equal(first.savedBranches?.length, 1);

    f.config.projects[0]!.source!.repository = "example/other";
    f.config.source!.remoteOverrides!.example = join(f.root, "missing.git");
    const changed = service.status("example");
    assert.equal(changed.repository, "example/other");
    assert.equal(changed.baseBranch, "main");
    assert.equal("mirrorHead" in changed, false);
    assert.equal("appliedHead" in changed, false);
    assert.deepEqual(changed.savedBranches, first.savedBranches);

    const failed = await service.refresh("example");
    assert.equal(failed.pending?.reason, "fetch-failed");
    assert.equal("mirrorHead" in failed, false);

    const originB = join(f.root, "repository-b.git");
    const seedB = join(f.root, "seed-b");
    git(f.root, "init", "--bare", "--initial-branch=main", originB);
    git(f.root, "init", "--initial-branch=main", seedB);
    writeFileSync(join(seedB, "tracked.txt"), "Repository B\n");
    git(seedB, "add", "tracked.txt");
    git(seedB, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Repository B base");
    git(seedB, "remote", "add", "origin", originB);
    git(seedB, "push", "origin", "main");
    const headB = git(seedB, "rev-parse", "HEAD");
    f.config.source!.remoteOverrides!.example = originB;

    const refreshed = await service.refresh("example");
    assert.equal(refreshed.mirrorHead, headB);
    assert.notEqual(refreshed.mirrorHead, first.mirrorHead);
  } finally { f.close(); }
});

test("a missing project directory reports the fixed missing-path apply failure", async () => {
  const f = fixture();
  try {
    f.config.projects[0]!.path = join(f.root, "missing-project");

    const status = await f.service().refresh("example");
    assert.equal(status.pending?.reason, "apply-failed");
    assert.equal(status.pending?.category, "missing-path");
    assert.equal(status.pending?.message, "The cloud project directory is missing.");
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

test("a source change during the running check is not recorded under the new identity", async () => {
  const f = fixture();
  try {
    const first = await f.service().refresh("example");
    assert.equal(first.mirrorHead, f.commitA);
    f.push("second.txt", "B");
    // The running check switches the enrolled repository mid-refresh and then reports a session, as a slow listing could.
    const service = f.service(async () => { f.config.projects[0]!.source = { mode: "github", repository: "example/other", baseBranch: "main" }; return true; });
    const result = await service.refresh("example");
    assert.equal(result.repository, "example/other");
    assert.equal(result.mirrorHead, undefined);
    assert.equal(result.pending, undefined);
    // The fetch that ran while the project still followed example/product was recorded for it; the session-running
    // marker observed after the switch was not written under either identity.
    const saved = JSON.parse(readFileSync(join(f.config.stateDir, "projects", "example", "source", "status.json"), "utf8"));
    assert.equal(saved.repository, "example/product");
    assert.notEqual(saved.mirrorHead, undefined);
    assert.equal(saved.pending, undefined);
  } finally { f.close(); }
});

test("a checkout the host cannot read reports a permission failure, not a missing repository root", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  const f = fixture();
  try {
    const first = await f.service().refresh("example");
    assert.equal(first.appliedHead, f.commitA);
    f.push("second.txt", "B");
    // A parent directory without search permission makes the host's own path check fail with EACCES.
    const locked = join(f.root, "locked");
    mkdirSync(locked);
    renameSync(f.projectPath, join(locked, "project"));
    f.config.projects[0]!.path = join(locked, "project");
    chmodSync(locked, 0o000);
    try {
      const result = await f.service().refresh("example");
      assert.equal(result.pending?.reason, "apply-failed");
      assert.equal(result.pending?.category, "permission");
    } finally { chmodSync(locked, 0o755); }
  } finally { f.close(); }
});
