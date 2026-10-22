import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUIET_CAPTURE_MS, shouldCaptureWorkspace, watchWorkspaceChanges } from "../packages/host/src/workspace-changes.js";

const macOnly = { skip: process.platform !== "darwin" };

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workspace-changes-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  mkdirSync(root);
  return { root, cacheDir: join(base, "watch-cache") };
}

test("watchWorkspaceChanges is unavailable outside macOS", { skip: process.platform === "darwin" }, async () => {
  assert.equal(await watchWorkspaceChanges([], "unused"), undefined);
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

test("native and fallback watches become quiet, including skipped special files", macOnly, async t => {
  for (const nativeAvailable of [true, false]) {
    const { root, cacheDir } = fixture(t);
    execFileSync("mkfifo", [join(root, "pipe")]);
    // An unusable cache exercises real native startup failure, without a test hook.
    if (!nativeAvailable) writeFileSync(cacheDir, "occupied");
    const changes = await watchWorkspaceChanges([root], cacheDir);
    assert.ok(changes);
    try {
      assert.equal(await changes.take(), true);
      assert.equal(await changes.take(), false, "native unavailability must not force an idle capture every tick");
    } finally { await changes.close(); }
  }
});

test("file writes, new subdirectories, and replaced files mark the workspace dirty", macOnly, async t => {
  const { root, cacheDir } = fixture(t);
  const changes = await watchWorkspaceChanges([root], cacheDir);
  assert.ok(changes);
  try {
    assert.equal(await changes.take(), true);
    assert.equal(await changes.take(), false);
    const directory = join(root, "new");
    mkdirSync(directory);
    const file = join(directory, "change.txt");
    writeFileSync(file, "created");
    assert.equal(await changes.take(), true, "new directory topology marks the workspace dirty");
    assert.equal(await changes.take(), false);
    writeFileSync(file, "edited");
    assert.equal(await changes.take(), true, "the new file stays watched after re-registration");
    assert.equal(await changes.take(), false);
    const replacement = join(root, "replacement");
    writeFileSync(replacement, "replaced");
    renameSync(replacement, file);
    assert.equal(await changes.take(), true, "atomic replacement marks the workspace dirty");
    assert.equal(await changes.take(), false);
    writeFileSync(file, "edited again");
    assert.equal(await changes.take(), true, "the replacement inode stays watched");
    assert.equal(await changes.take(), false);
  } finally { await changes.close(); }
});

test("a Git worktree metadata change marks the workspace dirty", macOnly, async t => {
  const { root, cacheDir } = fixture(t);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  try {
    git("init", "--quiet");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "seed");
    git("worktree", "add", "--quiet", "-b", "linked", worktree);
    const changes = await watchWorkspaceChanges([worktree], cacheDir);
    assert.ok(changes);
    try {
      assert.equal(await changes.take(), true);
      assert.equal(await changes.take(), false);
      writeFileSync(join(repository, ".git", "workspace-watch-marker"), "changed");

      const deadline = Date.now() + 5000;
      let dirty = false;
      while (!dirty && Date.now() < deadline) {
        dirty = await changes.take();
        if (!dirty) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(dirty, true, "the watcher should include the Git common directory");
    } finally {
      await changes.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moving the main repository and repairing the worktree pointer moves the metadata watch", macOnly, async t => {
  const { root, cacheDir } = fixture(t);
  const repository = join(root, "repository"), moved = join(root, "moved");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  const settle = async (changes: { take(): Promise<boolean> }, want: boolean) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const dirty = await changes.take();
      if (dirty === want || Date.now() > deadline) return dirty;
      await new Promise(resolve => setTimeout(resolve, want ? 25 : 300));
    }
  };
  try {
    git(repository, "init", "--quiet");
    git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "seed");
    git(repository, "worktree", "add", "--quiet", "-b", "linked", worktree);
    const changes = await watchWorkspaceChanges([worktree], cacheDir);
    assert.ok(changes);
    try {
      assert.equal(await changes.take(), true);
      renameSync(repository, moved);
      git(moved, "worktree", "repair", worktree);
      assert.equal(await settle(changes, true), true, "the rewritten pointer marks the workspace dirty");
      assert.equal(await settle(changes, false), false, "the workspace settles once the pointer is read");
      writeFileSync(join(moved, ".git", "workspace-watch-marker"), "changed");
      assert.equal(await settle(changes, true), true, "metadata at the new location is watched");
    } finally {
      await changes.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Git metadata resolution failure stays dirty", macOnly, async t => {
  const { root, cacheDir } = fixture(t);
  const changesRoot = join(root, "workspace");
  mkdirSync(changesRoot);
  writeFileSync(join(changesRoot, ".git"), "gitdir: missing\n");
  const changes = await watchWorkspaceChanges([changesRoot], cacheDir);
  assert.ok(changes);
  try {
    assert.equal(await changes.take(), true);
    assert.equal(await changes.take(), true);
  } finally {
    await changes.close();
    rmSync(root, { recursive: true, force: true });
  }
});
