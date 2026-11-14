import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      ["git", ...teamGitArgs(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", from, to, "--"])],
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
