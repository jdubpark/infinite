import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertMemberReadOnly, prepareRecoveredWorkspace, prepareRecoveryWorkspaceFromSource, prepareTeamWorkspaceFromMirror, prepareVerificationWorkspace, teamCommand, teamGitArgs, TeamError, writeTeamContext } from "../packages/host/src/team-workspace.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "team-workspace-test-"));
  git(root, "init", "--initial-branch=main");
  writeFileSync(join(root, "tracked.txt"), "committed content\n");
  git(root, "add", "tracked.txt");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

test("verification and recovery clones pin exact commits and keep recovery siblings flat", async () => {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), "team-workspace-clone-")));
  const integration = join(runRoot, "integration");
  mkdirSync(integration);
  git(integration, "init", "--initial-branch=main");
  writeFileSync(join(integration, "tracked.txt"), "committed content\n");
  git(integration, "add", "tracked.txt");
  git(integration, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
  const base = git(integration, "rev-parse", "HEAD");
  const prefix = {
    command: process.execPath,
    args: ["-e", "const {spawnSync}=require('node:child_process');const r=spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)"],
  };
  try {
    const verification = await prepareVerificationWorkspace(integration, "check-1", base, prefix);
    assert.equal(verification.workspace, join(runRoot, "verification", "check-1"));
    assert.equal(git(verification.workspace, "rev-parse", "HEAD"), base);
    assert.equal(git(verification.workspace, "status", "--porcelain"), "");
    assert.equal(git(verification.workspace, "remote"), "");
    assert.throws(() => git(verification.workspace, "symbolic-ref", "--short", "HEAD"), "verification must be detached");

    const first = await prepareRecoveredWorkspace(integration, "resume-1", base, prefix, undefined, "infinite/test");
    const second = await prepareRecoveredWorkspace(first.workspace, "resume-2", base, prefix, undefined, "infinite/test");
    assert.equal(first.workspace, join(runRoot, "recovery", "resume-1"));
    assert.equal(second.workspace, join(runRoot, "recovery", "resume-2"));
    for (const recovery of [first, second]) {
      assert.equal(recovery.branch, "infinite/test");
      assert.equal(git(recovery.workspace, "rev-parse", "HEAD"), base);
      assert.equal(git(recovery.workspace, "symbolic-ref", "--short", "HEAD"), "infinite/test");
      assert.equal(git(recovery.workspace, "status", "--porcelain"), "");
      assert.equal(git(recovery.workspace, "remote"), "");
    }
    assert.equal(git(integration, "rev-parse", "HEAD"), base, "recovery must preserve the original integration checkout");
    assert.equal(git(integration, "status", "--porcelain"), "");
  } finally { rmSync(runRoot, { recursive: true, force: true }); }
});

test("team context streams large snapshots through the command prefix into Git metadata only", async () => {
  const root = realpathSync(repository().root);
  const prefix = {
    command: process.execPath,
    args: ["-e", "const {spawnSync}=require('node:child_process');const r=spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)"],
  };
  const context = { runId: "run-id", revision: 7, payload: "🧭".repeat(40000) };
  const target = join(root, ".git", "infinite-team-context.json");
  try {
    await writeTeamContext(root, context, prefix);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), context);
    assert.equal(lstatSync(target).mode & 0o777, 0o400, "agents receive a read-only snapshot");
    assert.equal(git(root, "status", "--porcelain"), "", "Git metadata writes do not alter tracked or untracked project files");

    const retry = { ...context, revision: 8, payload: "replacement context" };
    await writeTeamContext(root, retry, prefix);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), retry, "a retry atomically replaces a regular prior snapshot");
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team context refuses Git metadata and destination symlinks", async () => {
  const firstRepo = repository();
  const first = { ...firstRepo, root: realpathSync(firstRepo.root) };
  const outside = mkdtempSync(join(tmpdir(), "team-context-outside-"));
  const sentinel = join(outside, "sentinel.txt");
  writeFileSync(sentinel, "keep this file");
  try {
    symlinkSync(sentinel, join(first.root, ".git", "infinite-team-context.json"));
    await assert.rejects(writeTeamContext(first.root, { safe: true }), (error: unknown) =>
      error instanceof TeamError && error.code === "team-context-write-failed");
    assert.equal(readFileSync(sentinel, "utf8"), "keep this file");
    assert.equal(git(first.root, "status", "--porcelain"), "");
  } finally { rmSync(first.root, { recursive: true, force: true }); }

  const secondRepo = repository();
  const second = { ...secondRepo, root: realpathSync(secondRepo.root) };
  const realMetadata = join(outside, "real-git");
  try {
    renameSync(join(second.root, ".git"), realMetadata);
    symlinkSync(realMetadata, join(second.root, ".git"));
    await assert.rejects(writeTeamContext(second.root, { safe: true }), (error: unknown) =>
      error instanceof TeamError && ["team-context-write-failed", "workspace-operation-failed"].includes(error.code));
    assert.equal(readFileSync(sentinel, "utf8"), "keep this file");
    assert.equal(existsSync(join(realMetadata, "infinite-team-context.json")), false);
  } finally {
    rmSync(second.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("read-only diagnostics identify the workspace context and safely bound changed paths", async () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, "!line\nbreak\u001b[31mred\u001b[0m.txt"), "private file contents");
    for (let index = 0; index < 20; index++) writeFileSync(join(root, `change-${String(index).padStart(2, "0")}-${"x".repeat(180)}.txt`), "private file contents");

    let caught: unknown;
    try { await assertMemberReadOnly(root, base, undefined, undefined, "verification"); }
    catch (error) { caught = error; }

    assert.ok(caught instanceof TeamError);
    assert.equal(caught.code, "verification-changed-files");
    assert.match(caught.message, /verification workspace/);
    assert.match(caught.message, /changed paths/);
    assert.match(caught.message, /additional changed path/);
    assert.ok(caught.message.includes("u000abreak"), "newlines must be visible as quoted escapes");
    assert.ok(!caught.message.includes("\u001b"), "terminal control characters must not reach the diagnostic");
    assert.ok(!caught.message.includes("private file contents"), "diagnostics must not expose file contents");
    assert.ok(caught.message.length < 2000, "the diagnostic must remain bounded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("read-only diagnostics reject a changed HEAD even when the worktree is clean", async () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, "tracked.txt"), "second committed version\n");
    git(root, "add", "tracked.txt");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "advanced head");
    const head = git(root, "rev-parse", "HEAD");

    let caught: unknown;
    try { await assertMemberReadOnly(root, base, undefined, undefined, "integration"); }
    catch (error) { caught = error; }

    assert.ok(caught instanceof TeamError);
    assert.equal(caught.code, "integration-changed-files");
    assert.match(caught.message, new RegExp(`HEAD changed from ${base.slice(0, 12)} to ${head.slice(0, 12)}`));
    assert.match(caught.message, /no working-tree paths/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Git inspection failures stay distinct from read-only change diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "team-workspace-error-"));
  try {
    await assert.rejects(assertMemberReadOnly(root, "0".repeat(40)), (error: unknown) =>
      error instanceof TeamError && error.code === "workspace-operation-failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("moved-base recovery copies from a source mirror through the restricted launcher", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "team-workspace-mirror-")));
  const source = join(sandbox, "source");
  const mirror = join(sandbox, "mirror.git");
  const receipts = join(sandbox, "receipts");
  const runRoot = join(sandbox, "run");
  const integration = join(runRoot, "integration");
  const prefix = { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--mirror-restricted-prefix", receipts] };
  const refusals = () => {
    const file = join(receipts, "mirror-commands.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  };
  const commit = (cwd: string, message: string) => {
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  try {
    mkdirSync(source);
    mkdirSync(receipts, { mode: 0o700 });
    git(source, "init", "--initial-branch=main");
    writeFileSync(join(source, "README.md"), "Base README heading\n");
    const base = commit(source, "base");
    git(sandbox, "clone", "--bare", "--", source, mirror);
    mkdirSync(runRoot);
    git(runRoot, "clone", "--", source, "integration");
    writeFileSync(join(source, "README.md"), "Upstream README heading\n");
    const moved = commit(source, "move the base");
    git(mirror, "fetch", "--no-tags", "--", source, "+refs/heads/main:refs/heads/main");

    // The restriction is real: the mirror refuses object inspection but accepts the pinned fetch and rev-parse.
    const inspected = await teamCommand({ command: "git", args: teamGitArgs(mirror, ["cat-file", "-t", moved]) }, mirror, undefined, 30000, prefix);
    assert.equal(inspected.exitCode, 126);
    assert.match(inspected.output, /only the pinned base-branch fetch and rev-parse are permitted/);
    const pinned = await teamCommand({ command: "git", args: teamGitArgs(mirror, ["rev-parse", "refs/heads/main"]) }, mirror, undefined, 30000, prefix);
    assert.equal(pinned.exitCode, 0);
    assert.equal(pinned.stdout.trim(), moved);
    const refusedBefore = refusals();

    const recovery = await prepareRecoveryWorkspaceFromSource(integration, mirror, "moved-1", moved, prefix, undefined, "infinite/test");
    assert.equal(recovery.workspace, join(runRoot, "recovery", "moved-1"));
    assert.equal(recovery.baseCommit, moved);
    assert.equal(recovery.branch, "infinite/test");
    assert.equal(git(recovery.workspace, "rev-parse", "HEAD"), moved);
    assert.equal(git(recovery.workspace, "symbolic-ref", "--short", "HEAD"), "infinite/test");
    assert.equal(git(recovery.workspace, "status", "--porcelain"), "");
    assert.equal(git(recovery.workspace, "remote"), "");
    assert.equal(readFileSync(join(recovery.workspace, "README.md"), "utf8"), "Upstream README heading\n");
    assert.equal(refusals(), refusedBefore, "the recovery copy must not inspect the mirror");

    const tree = git(mirror, "rev-parse", `${moved}^{tree}`);
    await assert.rejects(prepareRecoveryWorkspaceFromSource(integration, mirror, "tree-1", tree, prefix, undefined, "infinite/test"), (error: unknown) =>
      error instanceof TeamError && error.code === "invalid-workspace-baseline");
    const absent = "0123456789abcdef0123456789abcdef01234567";
    await assert.rejects(prepareRecoveryWorkspaceFromSource(integration, mirror, "absent-1", absent, prefix, undefined, "infinite/test"), (error: unknown) =>
      error instanceof TeamError && error.status === 409 && error.code === "workspace-operation-failed");
    assert.ok(existsSync(join(runRoot, "recovery", "tree-1")), "a failed copy is retained for inspection");
    assert.ok(existsSync(join(runRoot, "recovery", "absent-1")), "a failed copy is retained for inspection");

    assert.equal(git(mirror, "rev-parse", "refs/heads/main"), moved, "the mirror must not change");
    assert.equal(git(integration, "rev-parse", "HEAD"), base, "recovery must preserve the original integration checkout");
    assert.equal(git(integration, "status", "--porcelain"), "");

    const team = await prepareTeamWorkspaceFromMirror(mirror, moved, join(sandbox, "teams"), "team-1", "infinite/test", prefix);
    assert.equal(git(team.workspace, "rev-parse", "HEAD"), moved);
    assert.equal(git(team.workspace, "status", "--porcelain"), "");
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
