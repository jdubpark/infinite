import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGit, patchArgs } from "../packages/host/src/eval-git.js";
import { teamGitArgs } from "../packages/host/src/team-workspace.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";

const FAKE_HEX = "a".repeat(39);

function run(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "eval-git-"));
  run(dir, "init", "-q", "--template=");
  run(dir, "config", "user.name", "Placeholder Author");
  run(dir, "config", "user.email", "placeholder@example.invalid");
  return dir;
}

function commit(dir: string, write: (dir: string) => void, message: string) {
  write(dir);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "--allow-empty", "-m", message);
  return run(dir, "rev-parse", "HEAD");
}

function writeFiles(files: Record<string, string | Buffer>) {
  return (dir: string) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  };
}

/** A prefix that records its argv (one argument per line, starting with "git") and then runs the rest. */
function recordingPrefix(dir: string): { prefix: TeamCommand; record: string } {
  const record = join(dir, "argv.txt");
  const script = join(dir, "prefix.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nshift\nexec git "$@"\n`);
  return { prefix: { command: "/bin/sh", args: [script] }, record };
}

/** Writes a marker before it sleeps, so a test can tell that the read really started. */
function sleepingPrefix(dir: string): { prefix: TeamCommand; marker: string } {
  const marker = join(dir, "started.txt");
  const script = join(dir, "sleep.sh");
  writeFileSync(script, `#!/bin/sh\necho started > "${marker}"\nsleep 10\n`);
  return { prefix: { command: "/bin/sh", args: [script] }, marker };
}

function failingPrefix(dir: string): TeamCommand {
  const script = join(dir, "fail.sh");
  writeFileSync(script, "#!/bin/sh\nexit 1\n");
  return { command: "/bin/sh", args: [script] };
}

test("the patch form is exact and checked", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    const to = commit(dir, writeFiles({ "a.txt": "two\n" }), "to");
    const { prefix, record } = recordingPrefix(dir);
    const git = captureGit(() => prefix);

    assert.equal((await git.patch(dir, from, to)).state, "read");
    assert.deepEqual(
      readFileSync(record, "utf8").split("\n").filter(Boolean),
      ["git", ...teamGitArgs(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", "--submodule=short", "--ignore-submodules=none", "--unified=3", "--inter-hunk-context=0", from, to, "--"])],
    );

    for (const bad of ["HEAD", "-x", FAKE_HEX]) {
      rmSync(record, { force: true });
      assert.throws(() => patchArgs(bad, to), TypeError);
      assert.throws(() => patchArgs(from, bad), TypeError);
      assert.deepEqual(await git.patch(dir, bad, to), { state: "failed" });
      assert.equal(existsSync(record), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a binary patch reproduces the reference tree", async () => {
  const dir = makeRepo();
  const clone = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "keep\n", "c.txt": "gone\n" }), "from");
    const to = commit(dir, (root) => {
      writeFileSync(join(root, "b.txt"), "added\n");
      writeFileSync(join(root, "bin.dat"), randomBytes(4096));
      rmSync(join(root, "c.txt"));
    }, "to");
    const read = await captureGit(() => undefined).patch(dir, from, to);
    assert.equal(read.state, "read");
    if (read.state !== "read") return;

    const patchFile = join(clone, "change.patch");
    writeFileSync(patchFile, read.bytes);
    run(clone, "fetch", "-q", dir, "HEAD");
    run(clone, "checkout", "-q", "--detach", from);
    run(clone, "apply", "--index", patchFile);
    assert.equal(run(clone, "write-tree"), run(dir, "rev-parse", `${to}^{tree}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("an over-limit patch is refused, never cut", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, () => {}, "from");
    const to = commit(dir, writeFiles({ "big.bin": randomBytes(1_200_000) }), "to");
    const started = Date.now();
    const read = await captureGit(() => undefined).patch(dir, from, to);
    assert.equal(read.state, "too-large");
    assert.ok(Date.now() - started < 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("names and the base check", async () => {
  const dir = makeRepo();
  try {
    const base = commit(dir, writeFiles({ "a.txt": "a\n" }), "base");
    const three = commit(dir, writeFiles({ "a.txt": "a2\n", "b.txt": "b\n", "c.txt": "c\n" }), "three");
    const wide = commit(dir, (root) => {
      for (let index = 0; index < 501; index++) writeFileSync(join(root, `f${String(index).padStart(3, "0")}.txt`), "x\n");
    }, "wide");
    const git = captureGit(() => undefined);

    assert.deepEqual(await git.names(dir, base, three, 500), { state: "read", names: ["a.txt", "b.txt", "c.txt"] });
    assert.deepEqual(await git.names(dir, base, wide, 500), { state: "too-wide" });

    assert.equal(await git.onBaseBranch(dir, base, three), "proven");
    assert.equal(await git.onBaseBranch(dir, three, base), "not-proven");
    assert.equal(await git.onBaseBranch(dir, "0".repeat(40), three), "not-proven");

    run(dir, "checkout", "-q", "--detach", base);
    const side = commit(dir, writeFiles({ "side.txt": "s\n" }), "side");
    assert.equal(await git.onBaseBranch(dir, side, three), "not-proven");

    const refused = captureGit(() => failingPrefix(dir));
    assert.equal(await refused.onBaseBranch(dir, base, three), "not-proven");
    assert.deepEqual(await refused.names(dir, base, three, 500), { state: "failed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused patch is failed, and a cut name list is too-wide", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    const to = commit(dir, writeFiles({ "a.txt": "two\n" }), "to");
    // A launcher that refuses the form exits 1: the answer is a failed read, never an empty patch.
    const refused = captureGit(() => failingPrefix(dir));
    assert.deepEqual(await refused.patch(dir, from, to), { state: "failed" });

    // About 400 names of about 180 characters each: more than 64 KiB of names, so teamCommand cuts the list.
    const wide = commit(dir, (root) => {
      for (let index = 0; index < 400; index++) {
        writeFileSync(join(root, `n${String(index).padStart(3, "0")}-${"x".repeat(170)}.txt`), "x\n");
      }
    }, "wide names");
    assert.deepEqual(await captureGit(() => undefined).names(dir, from, wide, 500), { state: "too-wide" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read that cannot end", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    const to = commit(dir, writeFiles({ "a.txt": "two\n" }), "to");
    const { prefix, marker } = sleepingPrefix(dir);
    const git = captureGit(() => prefix, 200);

    let started = Date.now();
    assert.deepEqual(await git.patch(dir, from, to), { state: "failed" });
    assert.ok(Date.now() - started < 2000);
    assert.equal(existsSync(marker), true);

    rmSync(marker, { force: true });
    started = Date.now();
    assert.deepEqual(await git.names(dir, from, to, 500), { state: "failed" });
    assert.ok(Date.now() - started < 2000);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a replace ref changes no capture read", async () => {
  const dir = makeRepo();
  const clone = makeRepo();
  try {
    const base = commit(dir, writeFiles({ "a.txt": "one\n", "b.txt": "one\n" }), "base");
    const to = commit(dir, writeFiles({ "a.txt": "two\n" }), "to");
    run(dir, "checkout", "-q", "--detach", base);
    const other = commit(dir, writeFiles({ "b.txt": "two\n" }), "other");
    run(dir, "checkout", "-q", "--detach", to);
    run(dir, "replace", to, other);
    const git = captureGit(() => undefined);

    assert.deepEqual(await git.names(dir, base, to, 500), { state: "read", names: ["a.txt"] });

    run(clone, "fetch", "-q", dir, "HEAD");
    run(clone, "checkout", "-q", "--detach", base);
    const read = await git.patch(dir, base, to);
    assert.equal(read.state, "read");
    if (read.state !== "read") return;
    const patchFile = join(clone, "change.patch");
    writeFileSync(patchFile, read.bytes);
    run(clone, "apply", "--index", patchFile);
    assert.equal(run(clone, "write-tree"), run(dir, "--no-replace-objects", "rev-parse", `${to}^{tree}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a copy's diff settings change no patch", async () => {
  const dir = makeRepo();
  const clone = makeRepo();
  try {
    run(dir, "config", "diff.context", "1000");
    run(dir, "config", "diff.interHunkContext", "1000");
    const lines = (changed: number[] = []) => Array.from({ length: 400 }, (_, index) => (changed.includes(index + 1) ? "changed\n" : `line ${index + 1}\n`)).join("");
    const from = commit(dir, writeFiles({ "long.txt": lines() }), "from");
    // Two changes ten lines apart: two hunks with three lines of context, or one hunk when a setting joins them.
    const to = commit(dir, writeFiles({ "long.txt": lines([200, 210]) }), "to");

    run(clone, "fetch", "-q", dir, "HEAD");
    const inCopy = await captureGit(() => undefined).patch(dir, from, to);
    const plain = await captureGit(() => undefined).patch(clone, from, to);
    assert.equal(inCopy.state, "read");
    assert.equal(plain.state, "read");
    if (inCopy.state !== "read" || plain.state !== "read") return;
    assert.ok(inCopy.bytes.length < 1000);
    assert.deepEqual(inCopy.bytes, plain.bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a copy's submodule setting hides no name", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    // The link to FROM is added without `git add -A`, which would drop it.
    writeFileSync(join(dir, "a.txt"), "two\n");
    run(dir, "add", "a.txt");
    run(dir, "update-index", "--add", "--cacheinfo", `160000,${from},sub`);
    run(dir, "commit", "-q", "-m", "to");
    const to = run(dir, "rev-parse", "HEAD");
    run(dir, "update-index", "--cacheinfo", `160000,${to},sub`);
    run(dir, "commit", "-q", "-m", "later");
    const later = run(dir, "rev-parse", "HEAD");
    run(dir, "config", "diff.ignoreSubmodules", "all");
    const git = captureGit(() => undefined);

    assert.deepEqual(await git.names(dir, from, to, 500), { state: "read", names: ["a.txt", "sub"] });
    assert.deepEqual(await git.names(dir, to, later, 2000), { state: "read", names: ["sub"] });

    const { prefix, record } = recordingPrefix(dir);
    assert.equal((await captureGit(() => prefix).names(dir, from, to, 500)).state, "read");
    assert.deepEqual(
      readFileSync(record, "utf8").split("\n").filter(Boolean),
      ["git", ...teamGitArgs(dir, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", from, to, "--"])],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a patch child that cannot be stopped counts until it exits", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    const to = commit(dir, writeFiles({ "a.txt": "two\n" }), "to");
    const script = join(dir, "slow.sh");
    writeFileSync(script, "#!/bin/sh\nsleep 2\nexit 0\n");
    const seen: ChildProcess[] = [];
    let stoppedAt = 0, releasedAt = 0;
    // A host that may not signal the child: the stop is refused, and the child runs out its sleep.
    const git = captureGit(() => ({ command: "/bin/sh", args: [script] }), 100, child => {
      seen.push(child);
      stoppedAt = Date.now();
      const unref = child.unref.bind(child);
      child.unref = () => { releasedAt = Date.now(); unref(); };
      return false;
    }, 200);
    const started = Date.now();
    const pending = git.patch(dir, from, to);
    // A referenced timer keeps the loop alive: the child no longer does once it is released.
    const keep = setInterval(() => undefined, 1_000);
    try {
      const until = Date.now() + 1_500;
      while (releasedAt === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(seen.length, 1);
      assert.ok(releasedAt > 0, "the handle is released while the child still runs");
      assert.ok(releasedAt - stoppedAt >= 150, "the handle is not released at the refused stop");
      assert.equal(seen[0]!.stdout?.destroyed, true);
      assert.equal(seen[0]!.stderr?.destroyed, true);
      const probe = await Promise.race([
        pending.then(() => "settled"),
        new Promise(resolve => setTimeout(() => resolve("pending"), 10)),
      ]);
      assert.equal(probe, "pending");
      assert.deepEqual(await pending, { state: "failed" });
      assert.ok(Date.now() - started >= 1_500, "the read settles only when the child has ended");
    } finally {
      clearInterval(keep);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused stop of a child that has already ended still settles the read", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    const big = commit(dir, writeFiles({ "big.bin": randomBytes(1_200_000) }), "big");
    // On macOS the group of a child that has already ended refuses the signal, as another account's group does. The
    // read must still settle, and this test holds no timer: a handle released at the refusal would end the process.
    const git = captureGit(() => undefined, 10_000, child => {
      try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* It may already be gone. */ }
      return false;
    });
    // Compare the state alone: a failing deepEqual on a megabyte of bytes makes node's assert diff exhaust memory.
    assert.equal((await git.patch(dir, from, big)).state, "too-large");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close stops the reads in flight", async () => {
  const dir = makeRepo();
  try {
    const from = commit(dir, writeFiles({ "a.txt": "one\n" }), "from");
    const to = commit(dir, writeFiles({ "a.txt": "two\n" }), "to");
    const { prefix, marker } = sleepingPrefix(dir);
    const git = captureGit(() => prefix, 10_000);
    const patch = git.patch(dir, from, to);
    const names = git.names(dir, from, to, 500);

    const waited = Date.now();
    while (!existsSync(marker) && Date.now() - waited < 2000) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true);

    git.close?.();
    const both = Promise.all([patch, names]);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>(resolve => { timer = setTimeout(() => resolve("late"), 2000); });
    const settled = await Promise.race([both, late]);
    clearTimeout(timer);
    assert.deepEqual(settled, [{ state: "failed" }, { state: "failed" }]);

    rmSync(marker, { force: true });
    assert.deepEqual(await git.patch(dir, from, to), { state: "failed" });
    assert.deepEqual(await git.names(dir, from, to, 500), { state: "failed" });
    assert.equal(await git.onBaseBranch(dir, from, to), "not-proven");
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
