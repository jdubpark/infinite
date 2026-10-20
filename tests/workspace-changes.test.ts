import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUIET_CAPTURE_MS, shouldCaptureWorkspace, watchWorkspaceChanges } from "../packages/host/src/workspace-changes.js";

const macOnly = { skip: process.platform !== "darwin" };

test("watchWorkspaceChanges is unavailable outside macOS", { skip: process.platform === "darwin" }, () => {
  assert.equal(watchWorkspaceChanges([]), undefined);
});

test("the quiet-window gate captures only when a reason requires it", () => {
  const recentStart = 1000;
  const quiet = { changed: false, previousFailed: false, lastCaptureStartedAt: recentStart, checkpointCurrent: true };
  assert.equal(shouldCaptureWorkspace({ ...quiet, now: recentStart + QUIET_CAPTURE_MS }), false);
  assert.equal(shouldCaptureWorkspace({ ...quiet, now: recentStart + QUIET_CAPTURE_MS + 1 }), true);
  assert.equal(shouldCaptureWorkspace({ ...quiet, changed: true, now: recentStart }), true);
  assert.equal(shouldCaptureWorkspace({ ...quiet, previousFailed: true, now: recentStart }), true);
  assert.equal(shouldCaptureWorkspace({ ...quiet, checkpointCurrent: false, now: recentStart }), true);
  assert.equal(shouldCaptureWorkspace({ ...quiet, lastCaptureStartedAt: 0, now: recentStart }), true);
  assert.equal(shouldCaptureWorkspace({ changed: false, previousFailed: false, lastCaptureStartedAt: recentStart, now: recentStart }), true);
});

test("starts dirty and becomes quiet after take", macOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-changes-"));
  const changes = watchWorkspaceChanges([root]);
  assert.ok(changes);
  try {
    assert.equal(changes.take(), true);
    assert.equal(changes.take(), false);
  } finally {
    changes.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file write marks the workspace dirty", macOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-changes-"));
  const changes = watchWorkspaceChanges([root]);
  assert.ok(changes);
  try {
    assert.equal(changes.take(), true);
    assert.equal(changes.take(), false);
    writeFileSync(join(root, "change.txt"), "changed");

    const deadline = Date.now() + 5000;
    let dirty = false;
    while (!dirty && Date.now() < deadline) {
      dirty = changes.take();
      if (!dirty) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(dirty, true, "the watcher should report the file write within five seconds");
  } finally {
    changes.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Git worktree metadata change marks the workspace dirty", macOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-changes-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  try {
    git("init", "--quiet");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "seed");
    git("worktree", "add", "--quiet", "-b", "linked", worktree);
    const changes = watchWorkspaceChanges([worktree]);
    assert.ok(changes);
    try {
      assert.equal(changes.take(), true);
      assert.equal(changes.take(), false);
      writeFileSync(join(repository, ".git", "workspace-watch-marker"), "changed");

      const deadline = Date.now() + 5000;
      let dirty = false;
      while (!dirty && Date.now() < deadline) {
        dirty = changes.take();
        if (!dirty) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(dirty, true, "the watcher should include the Git common directory");
    } finally {
      changes.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moving the main repository and repairing the worktree pointer moves the metadata watch", macOnly, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-changes-")));
  const repository = join(root, "repository"), moved = join(root, "moved");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  const settle = async (changes: { take(): boolean }, want: boolean) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const dirty = changes.take();
      if (dirty === want || Date.now() > deadline) return dirty;
      await new Promise(resolve => setTimeout(resolve, want ? 25 : 300));
    }
  };
  try {
    git(repository, "init", "--quiet");
    git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "seed");
    git(repository, "worktree", "add", "--quiet", "-b", "linked", worktree);
    const changes = watchWorkspaceChanges([worktree]);
    assert.ok(changes);
    try {
      assert.equal(changes.take(), true);
      renameSync(repository, moved);
      git(moved, "worktree", "repair", worktree);
      assert.equal(await settle(changes, true), true, "the rewritten pointer marks the workspace dirty");
      assert.equal(await settle(changes, false), false, "the workspace settles once the pointer is read");
      writeFileSync(join(moved, ".git", "workspace-watch-marker"), "changed");
      assert.equal(await settle(changes, true), true, "metadata at the new location is watched");
    } finally {
      changes.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Git metadata resolution failure stays dirty", macOnly, () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-changes-"));
  const changesRoot = join(root, "workspace");
  mkdirSync(changesRoot);
  writeFileSync(join(changesRoot, ".git"), "gitdir: missing\n");
  const changes = watchWorkspaceChanges([changesRoot]);
  assert.ok(changes);
  try {
    assert.equal(changes.take(), true);
    assert.equal(changes.take(), true);
  } finally {
    changes.close();
    rmSync(root, { recursive: true, force: true });
  }
});
