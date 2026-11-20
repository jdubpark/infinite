import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The launcher runs only as copies whose ROOT and ACCOUNT lines are rewritten, as the current user. The installed
// file is never run here. `stop` kills every process of the account and deletes its temporary files, so in every copy
// its first line becomes `exit 99`: a broken account check fails a test instead of ending the test runner's processes.
// Every test but the installed-file checks skips on a platform other than Linux, and when the test runs as root.
const LAUNCHER = fileURLToPath(new URL("../deploy/ubuntu/grader-command.sh", import.meta.url));
const SKIP = process.platform !== "linux" ? "the launcher runs on Linux only"
  : process.getuid?.() === 0 ? "the launcher test must not run as root" : false;
const JOB = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const UNUSED = "99999999-8888-4777-8666-555555555555";

// The installed launcher caps the child with `prlimit --nproc=512`. On Linux that cap counts every thread the real
// user owns, so a test user that owns more than 512 threads cannot fork. The copy drops the cap: prlimit then leaves
// the limit alone, and no value has to fit under the user's hard limit (a raise above it fails with EPERM). The cap
// itself is checked against the installed file by its own test, on every platform.
const NPROC_CAP = /--nproc=512 /;

type Sandbox = { dir: string; root: string; script: string };

function sandbox(account: string = userInfo().username): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "grader-launcher-"));
  const root = join(dir, "root");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const script = join(dir, "grader-command.sh");
  const source = readFileSync(LAUNCHER, "utf8");
  const kill = /^ {2}kill -KILL -1 .*$/m;
  assert.equal(source.match(new RegExp(kill.source, "gm"))?.length, 1, "the launcher's kill line moved; move this guard with it");
  // Throws when the installed cap is no longer spelled as NPROC_CAP expects, so the rewrite cannot silently skip it.
  assert.equal(source.match(new RegExp(NPROC_CAP.source, "g"))?.length, 1, "the launcher's --nproc=512 cap moved; move this guard with it");
  const text = source
    .replace(/^ROOT=.*$/m, `ROOT='${root}'`)
    .replace(/^ACCOUNT=.*$/m, `ACCOUNT='${account}'`)
    .replace(kill, "  exit 99")
    .replace(NPROC_CAP, "");
  assert.doesNotMatch(text, /kill -KILL -1/);
  assert.doesNotMatch(text, /--nproc=/);
  writeFileSync(script, text, { mode: 0o700 });
  chmodSync(script, 0o700);
  return { dir, root, script };
}

// A failed test can leave a read-only tree, which rmSync cannot empty.
function cleanup(sb: Sandbox): void {
  spawnSync("/bin/chmod", ["-R", "u+rwx", sb.dir]);
  rmSync(sb.dir, { recursive: true, force: true });
}

function jobPath(sb: Sandbox, ...parts: string[]): string {
  return join(sb.root, "jobs", JOB, ...parts);
}

function grader(sb: Sandbox, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("/bin/sh", [sb.script, ...args], {
    input: options.input,
    env: options.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    maxBuffer: 1 << 20,
    timeout: 60_000,
  });
}

test("the installed launcher keeps its process cap", () => {
  const source = readFileSync(LAUNCHER, "utf8");
  assert.equal(source.match(new RegExp(NPROC_CAP.source, "g"))?.length, 1, "the installed launcher must still cap the child with --nproc=512");
});

test("the launcher starts the child with an empty environment", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      INFINITE_GITHUB_GRANT: "grant" + "-value",
      HTTPS_PROXY: "http://127.0.0.1:9",
      INFINITE_HOOK_TOKEN: "hook" + "-value",
    };
    const result = grader(sb, ["run", JOB, "round-1", "10", "--", "/usr/bin/env"], { env });
    assert.equal(result.status, 0, result.stderr.toString("utf8"));
    const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
    const names = lines.map(line => line.slice(0, line.indexOf("="))).sort();
    assert.deepEqual(names, [
      "CI", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT",
      "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR",
    ]);
    assert.ok(lines.includes("PATH=/usr/local/bin:/usr/bin:/bin"));
    assert.ok(lines.includes(`HOME=${jobPath(sb, "home")}`));
    assert.ok(lines.includes(`TMPDIR=${jobPath(sb, "tmp")}`));
  } finally {
    cleanup(sb);
  }
});

test("the launcher confines every operation to its root", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const outside = join(sb.dir, "outside");
    mkdirSync(outside);

    assert.equal(grader(sb, ["run", JOB, "../x", "10", "--", "/bin/true"]).status, 64);
    assert.equal(grader(sb, ["receive", JOB, "x", "10"], { input: "data" }).status, 64);
    assert.equal(grader(sb, ["run", "not-a-uuid", "round-1", "10", "--", "/bin/true"]).status, 64);
    assert.equal(grader(sb, ["run", "-".repeat(36), "round-1", "10", "--", "/bin/true"]).status, 64);
    assert.equal(grader(sb, ["digest", "not-a-uuid"]).status, 64);
    assert.equal(grader(sb, ["clean", "not-a-uuid"]).status, 64);

    // A work/round-1 that is a link out of the root is refused before anything runs.
    mkdirSync(jobPath(sb, "work", "reports"), { recursive: true });
    symlinkSync(outside, jobPath(sb, "work", "round-1"));
    assert.equal(grader(sb, ["run", JOB, "round-1", "10", "--", "/bin/sh", "-c", "echo x > marker"]).status, 64);
    assert.deepEqual(readdirSync(outside), []);

    // A report that is a link out of the root is refused by read.
    writeFileSync(join(outside, "report.tap"), "x");
    symlinkSync(join(outside, "report.tap"), jobPath(sb, "work", "reports", "round-1.tap"));
    assert.equal(grader(sb, ["read", JOB, "reports/round-1.tap", "100"]).status, 64);
    assert.equal(grader(sb, ["read", JOB, "reports/../in/base.bundle", "100"]).status, 64);

    // clean keeps exactly ROOT/jobs/JOB/in/base.bundle, and digest reads it.
    const bundle = "bundle-bytes";
    assert.equal(grader(sb, ["receive", JOB, "base.bundle", "1000"], { input: bundle }).status, 0);
    mkdirSync(join(sb.root, "node_modules"));
    mkdirSync(join(sb.root, "jobs", OTHER, "in"), { recursive: true });
    writeFileSync(join(sb.root, "jobs", OTHER, "in", "base.bundle"), "other-project");
    writeFileSync(jobPath(sb, "extra"), "x");

    assert.equal(grader(sb, ["clean", JOB]).status, 0);
    assert.deepEqual(readdirSync(sb.root, { recursive: true }).map(String).sort(), [
      "jobs", `jobs/${JOB}`, `jobs/${JOB}/in`, `jobs/${JOB}/in/base.bundle`,
    ]);
    assert.ok(existsSync(outside), "clean must not reach outside the root");

    const digest = grader(sb, ["digest", JOB]);
    assert.equal(digest.status, 0, digest.stderr.toString("utf8"));
    assert.equal(digest.stdout.toString("utf8"), `${createHash("sha256").update(bundle).digest("hex")}\n`);
    assert.equal(grader(sb, ["digest", UNUSED]).status, 2);
  } finally {
    cleanup(sb);
  }
});

test("the launcher ends a round at its limit", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const unique = String(randomInt(100_000, 900_000));
    const started = Date.now();
    const result = grader(sb, ["run", JOB, "round-1", "2", "--", "sleep", unique]);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 124, result.stderr.toString("utf8"));
    assert.ok(elapsed < 15_000, `the round took ${elapsed} ms`);
    const left = spawnSync("/usr/bin/pgrep", ["-f", `^sleep ${unique}$`]);
    assert.equal(left.status, 1, `a sleep of the round is still running: ${left.stdout.toString("utf8")}`);
  } finally {
    cleanup(sb);
  }
});

test("clean and remove empty a read-only tree", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const readOnly = "mkdir -p ro/inner && echo z > ro/inner/f && chmod 555 ro/inner ro";
    assert.equal(grader(sb, ["receive", JOB, "base.bundle", "1000"], { input: "bundle" }).status, 0);
    assert.equal(grader(sb, ["run", JOB, "round-1", "10", "--", "/bin/sh", "-c", readOnly]).status, 0);

    assert.equal(grader(sb, ["clean", JOB]).status, 0);
    assert.deepEqual(readdirSync(sb.root, { recursive: true }).map(String).sort(), [
      "jobs", `jobs/${JOB}`, `jobs/${JOB}/in`, `jobs/${JOB}/in/base.bundle`,
    ]);

    assert.equal(grader(sb, ["run", JOB, "round-2", "10", "--", "/bin/sh", "-c", readOnly]).status, 0);
    assert.equal(grader(sb, ["remove", JOB]).status, 0);
    assert.equal(existsSync(join(sb.root, "jobs", JOB)), false);
  } finally {
    cleanup(sb);
  }
});

test("receive and read keep their limits", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const over = grader(sb, ["receive", JOB, "base.bundle", "10"], { input: "x".repeat(11) });
    assert.equal(over.status, 3);
    assert.equal(grader(sb, ["receive", JOB, "base.bundle", "010"], { input: "x" }).status, 64);
    assert.equal(existsSync(jobPath(sb, "in", "base.bundle")), false);

    const exact = grader(sb, ["receive", JOB, "base.bundle", "10"], { input: "x".repeat(10) });
    assert.equal(exact.status, 0, exact.stderr.toString("utf8"));

    mkdirSync(jobPath(sb, "work", "reports"), { recursive: true });
    writeFileSync(jobPath(sb, "work", "reports", "round-1.tap"), "x".repeat(11));
    assert.equal(grader(sb, ["read", JOB, "reports/round-1.tap", "10"]).status, 3);

    writeFileSync(jobPath(sb, "work", "reports", "round-1.tap"), "x".repeat(10));
    const read = grader(sb, ["read", JOB, "reports/round-1.tap", "10"]);
    assert.equal(read.status, 0);
    assert.equal(read.stdout.length, 10);
    assert.equal(grader(sb, ["read", JOB, "reports/round-2.xml", "10"]).status, 2);
  } finally {
    cleanup(sb);
  }
});

test("a child cannot borrow the launcher's codes", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const cases: Array<[number, number]> = [[125, 1], [64, 1], [7, 7]];
    for (const [code, expected] of cases) {
      const result = grader(sb, ["run", JOB, "round-1", "10", "--", "/bin/sh", "-c", `exit ${code}`]);
      assert.equal(result.status, expected, `the child exits ${code}`);
    }
  } finally {
    cleanup(sb);
  }
});

test("the launcher refuses an operation as another account, and stop leaves processes alone", { skip: SKIP }, async () => {
  const sb = sandbox(`not-${userInfo().username}`);
  const sleeper = spawn("sleep", [String(randomInt(100_000, 900_000))], { stdio: "ignore" });
  try {
    assert.equal(grader(sb, ["clean", JOB]).status, 64);
    assert.equal(grader(sb, ["receive", JOB, "base.bundle", "10"], { input: "x" }).status, 64);
    assert.equal(grader(sb, ["stop"]).status, 64);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(sleeper.exitCode, null, "stop under another account must not end the test's sleep");
    assert.equal(sleeper.signalCode, null);
  } finally {
    sleeper.kill("SIGKILL");
    cleanup(sb);
  }
});

test("the probe reports the root and the tools", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const canary = join(sb.dir, "canary");
    writeFileSync(canary, "x");
    const result = grader(sb, ["probe", "--", canary, join(sb.dir, "absent")]);
    assert.equal(result.status, 0, result.stderr.toString("utf8"));
    const probe = JSON.parse(result.stdout.toString("utf8"));
    const uid = process.getuid ? process.getuid() : -1;
    assert.equal(probe.uid, uid);
    assert.equal(probe.root, sb.root);
    assert.equal(probe.rootMode, "700");
    assert.equal(probe.rootOwner, uid);
    assert.deepEqual(probe.readable, [true, false]);
    assert.ok(["open", "closed"].includes(probe.metadata));
    assert.ok(probe.freeBytes > 0 && probe.freeInodes > 0);
    assert.equal(probe.tools, true);
  } finally {
    cleanup(sb);
  }
});

test("the launcher refuses a root that is not a private directory", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    chmodSync(sb.root, 0o755);
    assert.equal(grader(sb, ["probe", "--"]).status, 64);
  } finally {
    chmodSync(sb.root, 0o700);
    cleanup(sb);
  }
});

test("the grader exports only the trial branch", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    // C1 is the trial branch; C2 is on the default branch only, so the bundle must not carry it.
    const identity = "-c user.name=t -c user.email=t@example.invalid";
    const made = grader(sb, ["run", JOB, "task", "60", "--", "/bin/sh", "-c",
      `git init -q && git ${identity} commit -q --allow-empty -m c1 && git branch trial && git ${identity} commit -q --allow-empty -m c2`]);
    assert.equal(made.status, 0, made.stderr.toString("utf8"));

    const exported = grader(sb, ["export", JOB]);
    assert.equal(exported.status, 0, exported.stderr.toString("utf8"));
    const out = join(sb.dir, "out");
    mkdirSync(out);
    const bundle = join(out, "trial.bundle");
    writeFileSync(bundle, exported.stdout);
    // The test's own git calls run in the sandbox, never in the checkout under test.
    const heads = spawnSync("git", ["bundle", "list-heads", bundle], { cwd: out }).stdout.toString("utf8").trim().split("\n");
    assert.deepEqual(heads.map(line => line.split(" ")[1]), ["refs/heads/trial"]);

    const clone = join(out, "clone");
    assert.equal(spawnSync("git", ["clone", "-q", "--branch", "trial", bundle, clone], { cwd: out }).status, 0);
    assert.deepEqual(spawnSync("git", ["-C", clone, "log", "--all", "--format=%s"], { cwd: out }).stdout.toString("utf8").trim().split("\n"), ["c1"]);

    // A missing trial branch refuses with status 2.
    assert.equal(grader(sb, ["export", OTHER]).status, 2);

    assert.equal(grader(sb, ["receive", JOB, "result.patch", "10"], { input: "0123456789" }).status, 0);
    assert.equal(readFileSync(jobPath(sb, "in", "result.patch"), "utf8"), "0123456789");

    assert.match(grader(sb, ["probe", "--"]).stdout.toString("utf8"), /"version":2/);
  } finally {
    cleanup(sb);
  }
});
