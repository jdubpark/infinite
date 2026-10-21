import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMemberReadOnly, prepareRecoveredWorkspace, prepareVerificationWorkspace, TeamError } from "../packages/host/src/team-workspace.js";

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
