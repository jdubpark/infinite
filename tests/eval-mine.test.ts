import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { messageArgs, mineGit, numstatArgs } from "../packages/host/src/eval-mine-git.js";
import { capsuleVerdict, isRevert, minedCapsule, mineVerdict, type NumstatEntry, parentDirectories, parseMessage, parseNumstat } from "../packages/host/src/eval-mine-rules.js";
import { teamGitArgs } from "../packages/host/src/team-workspace.js";
import type { TeamCommand, TeamRun } from "../packages/host/src/team-types.js";
import type { EvalProjectSettings } from "../packages/host/src/eval-config.js";
import { FEATURE_VERSION } from "../packages/host/src/task-features.js";

const settings: EvalProjectSettings = { testPaths: { prefixes: ["tests"], suffixes: [".test.ts"] } };
const FAKE_HEX = "a".repeat(39);

function run(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function commit(dir: string, files: Record<string, string | Buffer>, message: string) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "--allow-empty", "-m", message);
  return run(dir, "rev-parse", "HEAD");
}

/** Commits the given trees in a work repository, pushes them to a bare repository, and returns that mirror and the commit ids. */
function mirrorWith(dir: string, commits: Record<string, string | Buffer>[]) {
  const work = join(dir, "work");
  mkdirSync(work);
  run(work, "init", "-q", "--template=");
  run(work, "config", "user.name", "Placeholder Author");
  run(work, "config", "user.email", "placeholder@example.invalid");
  const ids = commits.map((files, index) => commit(work, files, `commit ${index}`));
  const mirror = join(dir, "mirror.git");
  run(dir, "init", "-q", "--bare", "--template=", mirror);
  run(work, "push", "-q", mirror, "HEAD:refs/heads/main");
  return { mirror, ids };
}

/** A prefix that records its argv (one argument per line, starting with "git") and then runs the rest. */
function recordingPrefix(dir: string): { prefix: TeamCommand; record: string } {
  const record = join(dir, "argv.txt");
  const script = join(dir, "prefix.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nshift\nexec git "$@"\n`);
  return { prefix: { command: "/bin/sh", args: [script] }, record };
}

function failingPrefix(dir: string): TeamCommand {
  const script = join(dir, "fail.sh");
  writeFileSync(script, "#!/bin/sh\nexit 1\n");
  return { command: "/bin/sh", args: [script] };
}

test("the mining forms are exact and checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-mine-"));
  try {
    const { mirror, ids } = mirrorWith(dir, [
      { "src/a.ts": "one\n", "tests/a.test.ts": "one\n" },
      { "src/a.ts": "two\n", "tests/a.test.ts": "two\n" },
    ]);
    const base = ids[0]!, to = ids[1]!;
    const { prefix, record } = recordingPrefix(dir);
    const argv = () => readFileSync(record, "utf8").split("\n").filter(Boolean);
    const git = mineGit(() => prefix);

    // Form E1 and E2.
    assert.deepEqual(numstatArgs(base, to), ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "--ignore-submodules=none", "--diff-algorithm=myers", "-z", base, to, "--"]);
    assert.equal((await git.numstat(mirror, base, to)).state, "read");
    assert.deepEqual(argv(), ["git", ...teamGitArgs(mirror, numstatArgs(base, to))]);

    assert.deepEqual(messageArgs(to), ["log", "--no-walk=unsorted", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=%ct%x00%B", to]);
    assert.equal((await git.message(mirror, to)).state, "read");
    assert.deepEqual(argv(), ["git", ...teamGitArgs(mirror, messageArgs(to))]);

    // Forms 1 to 4 of the outcome-ledger plan's "Git commands of the scan".
    assert.equal(await git.isAncestor(mirror, base, to), "yes");
    assert.deepEqual(argv(), ["git", ...teamGitArgs(mirror, ["merge-base", "--is-ancestor", base, to])]);
    assert.equal(await git.isAncestor(mirror, to, base), "no");

    assert.deepEqual(await git.firstParents(mirror, to), { ids: [to, base], more: false });
    assert.deepEqual(argv(), ["git", ...teamGitArgs(mirror, ["rev-list", "--first-parent", "--max-count=500", to])]);
    assert.deepEqual(await git.firstParents(mirror, to, base), { ids: [to], more: false });
    assert.deepEqual(argv(), ["git", ...teamGitArgs(mirror, ["rev-list", "--first-parent", "--max-count=501", to, `^${base}`])]);

    assert.deepEqual(await git.parents(mirror, [to, base]), new Map([[to, [base]], [base, []]]));
    assert.deepEqual(argv(), ["git", ...teamGitArgs(mirror, ["log", "--no-walk=unsorted", "--no-show-signature", "--format=%H %T %P", to, base])]);

    // A malformed id never reaches an argument.
    for (const bad of ["HEAD", "-x", FAKE_HEX]) {
      rmSync(record, { force: true });
      assert.throws(() => numstatArgs(bad, to), TypeError);
      assert.throws(() => numstatArgs(base, bad), TypeError);
      assert.throws(() => messageArgs(bad), TypeError);
      assert.deepEqual(await git.numstat(mirror, bad, to), { state: "failed" });
      assert.deepEqual(await git.numstat(mirror, base, bad), { state: "failed" });
      assert.deepEqual(await git.message(mirror, bad), { state: "failed" });
      assert.equal(await git.isAncestor(mirror, bad, to), "failed");
      assert.equal(await git.firstParents(mirror, bad), undefined);
      assert.equal(await git.firstParents(mirror, to, bad), undefined);
      assert.equal(await git.parents(mirror, [bad]), undefined);
      assert.equal(existsSync(record), false);
    }
    assert.equal(await git.parents(mirror, Array.from({ length: 51 }, () => to)), undefined);
    assert.equal(existsSync(record), false);

    // A refused launcher is a failed read.
    assert.deepEqual(await mineGit(() => failingPrefix(dir)).numstat(mirror, base, to), { state: "failed" });
    assert.deepEqual(await mineGit(() => failingPrefix(dir)).message(mirror, to), { state: "failed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the verdict follows the design's limits", () => {
  const read = (entries: NumstatEntry[]) => ({ state: "read" as const, entries });
  const source = { path: "src/a.ts", added: 1, removed: 0 };
  const test1 = { path: "tests/a.test.ts", added: 1, removed: 0 };

  const verdict = mineVerdict(read([source, test1]), settings, undefined);
  assert.equal(verdict.kind, "read-message");
  if (verdict.kind !== "read-message") return;
  assert.deepEqual(verdict.hiddenFiles, ["tests/a.test.ts"]);
  assert.deepEqual(verdict.paths, ["src", "tests"]);
  assert.equal(verdict.features.featureVersion, FEATURE_VERSION);
  assert.equal(verdict.features.kind, null);

  assert.deepEqual(mineVerdict(read([test1]), settings, undefined), { kind: "skip" });
  assert.deepEqual(mineVerdict(read([source]), settings, undefined), { kind: "skip" });

  const sources = (count: number): NumstatEntry[] => Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, added: 1, removed: 0 }));
  assert.equal(mineVerdict(read([...sources(28), test1]), settings, undefined).kind, "read-message");
  assert.deepEqual(mineVerdict(read([...sources(29), test1]), settings, undefined), { kind: "reject", reason: "too-large" });

  const lines = (added: number): NumstatEntry[] => [{ path: "src/a.ts", added, removed: 0 }, { path: "tests/a.test.ts", added: 0, removed: 0 }];
  assert.equal(mineVerdict(read(lines(1499)), settings, undefined).kind, "read-message");
  assert.deepEqual(mineVerdict(read(lines(1500)), settings, undefined), { kind: "reject", reason: "too-large" });

  const excluded = { ...settings, excludeAreas: ["docs"] };
  assert.deepEqual(mineVerdict(read([source, test1]), excluded, undefined), { kind: "reject", reason: "excluded-area-unknown" });
  const map = { areas: [{ id: "docs", paths: ["docs"] }] };
  const docs = { path: "docs/guide.md", added: 1, removed: 0 };
  assert.deepEqual(mineVerdict(read([docs, test1]), excluded, map), { kind: "reject", reason: "excluded-area" });
});

test("a truncated or binary read is never small", async () => {
  assert.deepEqual(mineVerdict({ state: "too-large" }, settings, undefined), { kind: "reject", reason: "too-large" });
  assert.deepEqual(
    mineVerdict({ state: "read", entries: [{ path: "src/bin.dat", added: null, removed: null }, { path: "tests/a.test.ts", added: 1, removed: 0 }] }, settings, undefined),
    { kind: "reject", reason: "binary-change" },
  );
  assert.equal(parseNumstat("1\t2\tsrc/a.ts"), undefined);
  assert.deepEqual(parseNumstat("1\t2\tsrc/a.ts\0"), [{ path: "src/a.ts", added: 1, removed: 2 }]);
  assert.deepEqual(parseNumstat("-\t-\tbin.dat\0"), [{ path: "bin.dat", added: null, removed: null }]);

  const dir = mkdtempSync(join(tmpdir(), "eval-mine-"));
  try {
    const wide = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`wide/f${String(index).padStart(4, "0")}-${"x".repeat(48)}.txt`, "x\n"]));
    const { mirror, ids } = mirrorWith(dir, [
      { "README.md": "base\n" },
      { "tests/a.test.ts": "one\n", "bin.dat": randomBytes(4096) },
      wide,
    ]);
    const base = ids[0]!, binary = ids[1]!, big = ids[2]!;

    // A real binary change beside a test file is never counted as a small change.
    const read = await mineGit(() => undefined).numstat(mirror, base, binary);
    assert.equal(read.state, "read");
    if (read.state !== "read") return;
    assert.deepEqual(mineVerdict(read, settings, undefined), { kind: "reject", reason: "binary-change" });

    // Output past 64 KiB is cut by the launcher, and the read says so.
    assert.deepEqual(await mineGit(() => undefined).numstat(mirror, binary, big), { state: "too-large" });

    // A launcher that prints a record without its NUL is a failed read, and no record is read from it.
    const script = join(dir, "no-nul.sh");
    writeFileSync(script, "#!/bin/sh\nprintf '1\\t2\\tsrc/a.ts'\n");
    assert.deepEqual(await mineGit(() => ({ command: "/bin/sh", args: [script] })).numstat(mirror, base, binary), { state: "failed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the message decides revert, origin, and secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-mine-"));
  try {
    run(dir, "init", "-q", "--template=");
    run(dir, "config", "user.name", "Placeholder Author");
    run(dir, "config", "user.email", "placeholder@example.invalid");
    commit(dir, { "a.txt": "one\n" }, "first");
    commit(dir, { "a.txt": "two\n" }, "second");
    run(dir, "revert", "--no-edit", "HEAD");
    assert.equal(isRevert(run(dir, "log", "-1", "--format=%B")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(isRevert("Undo the parser\n\nThis reverts commit " + "a".repeat(40) + "."), true);
  assert.equal(isRevert("Add the parser"), false);

  const origin = minedCapsule("Fix the parser", ["src"], undefined);
  assert.ok("capsule" in origin);
  if (!("capsule" in origin)) return;
  assert.equal(origin.promptOrigin, "commit-message");
  assert.equal(origin.capsule.objective, "Fix the parser");

  const fromRun = minedCapsule("Merge the parser", ["src"], { objective: "Ship the parser" });
  assert.ok("capsule" in fromRun);
  if (!("capsule" in fromRun)) return;
  assert.equal(fromRun.promptOrigin, "run-objective");
  assert.equal(fromRun.capsule.objective, "Ship the parser");
  assert.deepEqual(minedCapsule("x", [], { objective: "y", brief: { uiChanges: true } as NonNullable<TeamRun["brief"]> }), { reject: "ui-changes" });

  // Secret shapes are built at run time, so this file holds no credential-shaped literal.
  const ghp = "gh" + "p_" + "a".repeat(36);
  const grant = "v1." + "eyJ" + "a".repeat(20) + "." + "b".repeat(43);
  for (const text of [`Fix ${ghp}`, `Fix ${grant}`]) {
    const result = minedCapsule(text, [], undefined);
    assert.ok("capsule" in result);
    if (!("capsule" in result)) return;
    assert.equal(capsuleVerdict(result.capsule), "secret-shaped");
  }

  const large = minedCapsule("x".repeat(70_000), [], undefined);
  assert.ok("capsule" in large);
  if (!("capsule" in large)) return;
  assert.equal(capsuleVerdict(large.capsule), "capsule-too-large");

  assert.deepEqual(parseMessage("1700000000\0Subject\n\nBody\n"), { commitTime: "2023-11-14T22:13:20.000Z", message: "Subject\n\nBody" });
  assert.equal(parseMessage("1700000000\0" + "x".repeat(24_001)), undefined);
  assert.deepEqual(parentDirectories(["src/a.ts", "tests/a.test.ts", "README.md"]), ["README.md", "src", "tests"]);
});
