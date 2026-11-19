import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The launcher runs only as copies whose ROOT, ACCOUNT, EVAL_HOME, TEMPLATE, and STOP_DIRS lines are rewritten, as the
// current user. The installed file is never run here. `stop` ends every process of the account and deletes its
// temporary files, so in every copy its kill line becomes `exit 99`: a broken account check fails a test instead of
// ending the test runner's processes. The one test that runs `stop` to the end replaces the kill line with a no-op
// and narrows STOP_DIRS to one directory. Every test skips on a platform other than Linux, and when the test runs as root.
const LAUNCHER = fileURLToPath(new URL("../deploy/ubuntu/eval-command.sh", import.meta.url));
const SKIP = process.platform !== "linux" ? "the launcher runs on Linux only"
  : process.getuid?.() === 0 ? "the launcher test must not run as root" : false;
const TRIAL = "11111111-2222-4333-8444-555555555555";
// The fixed environment of exec and setup, sorted as the tests compare it.
const FIXED = [
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
  "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR",
];
const PROXY = ["HTTPS_PROXY", "HTTP_PROXY", "NODE_USE_ENV_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

type Sandbox = { dir: string; root: string; home: string; template: string; tmp: string; script: string };

function sandbox(account: string = userInfo().username, stopDirs?: string): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eval-launcher-")));
  const root = join(dir, "root");
  const home = join(dir, "home");
  const template = join(dir, "template");
  const tmp = join(dir, "tmp");
  // Probe and stop look here instead of the machine's shared directories, so a test sees only its own files.
  const shared = join(dir, "shared");
  mkdirSync(shared, { mode: 0o700 });
  mkdirSync(root, { mode: 0o711 });
  chmodSync(root, 0o711);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(tmp, { mode: 0o700 });
  chmodSync(tmp, 0o700);
  mkdirSync(template, { mode: 0o755 });
  const script = join(dir, "eval-command.sh");
  const source = readFileSync(LAUNCHER, "utf8");
  const kill = /^ {2}kill -KILL -1 .*$/m;
  assert.equal(source.match(new RegExp(kill.source, "gm"))?.length, 1, "the launcher's kill line moved; move this guard with it");
  const text = source
    .replace(/^ROOT=.*$/m, `ROOT='${root}'`)
    .replace(/^ACCOUNT=.*$/m, `ACCOUNT='${account}'`)
    .replace(/^EVAL_HOME=.*$/m, `EVAL_HOME='${home}'`)
    .replace(/^TEMPLATE=.*$/m, `TEMPLATE='${template}'`)
    .replace(/^EVAL_TMP=.*$/m, `EVAL_TMP='${tmp}'`)
    .replace(/^STOP_DIRS=.*$/m, `STOP_DIRS='${stopDirs ?? shared}'`)
    .replace(kill, stopDirs ? "  :" : "  exit 99");
  assert.match(text, stopDirs ? /^ {2}:$/m : /^ {2}exit 99$/m, "the kill line was not replaced");
  assert.doesNotMatch(text, /kill -KILL -1/);
  writeFileSync(script, text, { mode: 0o700 });
  chmodSync(script, 0o700);
  return { dir, root, home, template, tmp, script };
}

// A failed test can leave a read-only tree, which rmSync cannot empty.
function cleanup(sb: Sandbox): void {
  spawnSync("/bin/chmod", ["-R", "u+rwx", sb.dir]);
  rmSync(sb.dir, { recursive: true, force: true });
}

function run(sb: Sandbox, args: readonly string[], options: { input?: string | Buffer; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("/bin/sh", [sb.script, ...args], {
    input: options.input,
    cwd: options.cwd ?? sb.dir,
    env: options.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    maxBuffer: 1 << 20,
    timeout: 120_000,
  });
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "trial-test",
      GIT_AUTHOR_EMAIL: "trial-test@example.invalid",
      GIT_COMMITTER_NAME: "trial-test",
      GIT_COMMITTER_EMAIL: "trial-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8");
}

// A source repository: `trial` is at C1, so the base bundle holds only C1; C2 follows C1 on `later`.
function makeRepo(sb: Sandbox): { bundle: Buffer; source: string; c2: string } {
  const source = join(sb.dir, "source");
  mkdirSync(source);
  git(source, ["init", "--quiet"]);
  writeFileSync(join(source, "a.txt"), "one\n");
  git(source, ["add", "a.txt"]);
  git(source, ["commit", "--quiet", "-m", "one"]);
  git(source, ["branch", "trial"]);
  writeFileSync(join(source, "b.txt"), "two\n");
  git(source, ["add", "b.txt"]);
  git(source, ["commit", "--quiet", "-m", "two"]);
  const c2 = git(source, ["rev-parse", "HEAD"]).trim();
  git(source, ["branch", "later"]);
  const file = join(sb.dir, "base.bundle");
  git(source, ["bundle", "create", file, "trial"]);
  return { bundle: readFileSync(file), source, c2 };
}

// Receives and prepares TRIAL, and returns its work directory.
function prepareTrial(sb: Sandbox, bundle: Buffer): string {
  const received = run(sb, ["receive", TRIAL, "1000000"], { input: bundle });
  assert.equal(received.status, 0, received.stderr.toString("utf8"));
  const prepared = run(sb, ["prepare", TRIAL]);
  assert.equal(prepared.status, 0, prepared.stderr.toString("utf8"));
  return join(sb.root, "trials", TRIAL, "work");
}

function envNames(stdout: Buffer): string[] {
  return stdout.toString("utf8").split("\n").filter(Boolean).map(line => line.slice(0, line.indexOf("="))).sort();
}

function leftovers(sb: Sandbox): number {
  const probe = run(sb, ["probe", "--"]);
  assert.equal(probe.status, 0, probe.stderr.toString("utf8"));
  return JSON.parse(probe.stdout.toString("utf8")).leftovers;
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, name)), { recursive: true });
    writeFileSync(join(base, name), text);
  }
}

test("the eval launcher starts commands with a fixed environment", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const repo = makeRepo(sb);
    const work = prepareTrial(sb, repo.bundle);
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      INFINITE_HOOK_TOKEN: "hook" + "-token",
      INFINITE_GITHUB_GRANT: "grant" + "-value",
      HTTPS_PROXY: "http://127.0.0.1:9",
    };

    const plain = run(sb, ["exec", "--", "/usr/bin/env"], { cwd: work, env });
    assert.equal(plain.status, 0, plain.stderr.toString("utf8"));
    assert.deepEqual(envNames(plain.stdout), FIXED);
    const plainLines = plain.stdout.toString("utf8").split("\n");
    assert.ok(plainLines.includes(`HOME=${sb.home}`));
    assert.ok(plainLines.includes(`TMPDIR=${join(sb.root, "trials", TRIAL, "tmp")}`));
    assert.ok(plainLines.includes("PATH=/usr/local/bin:/usr/bin:/bin"));

    const proxied = run(sb, ["setup", "--", "/usr/bin/env"], { cwd: work, env, input: "http://u:p@127.0.0.1:9/\n" });
    assert.equal(proxied.status, 0, proxied.stderr.toString("utf8"));
    assert.deepEqual(envNames(proxied.stdout), [...FIXED, ...PROXY].sort());
    const proxyLines = proxied.stdout.toString("utf8").split("\n");
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
      assert.ok(proxyLines.includes(`${name}=http://u:p@127.0.0.1:9/`), `${name} carries the stdin proxy`);
    }
    assert.ok(proxyLines.includes("NO_PROXY=localhost,127.0.0.1,::1"));
    assert.ok(proxyLines.includes("no_proxy=localhost,127.0.0.1,::1"));
    assert.ok(proxyLines.includes("NODE_USE_ENV_PROXY=1"), "Node 22 clients use the proxy variables");

    const bare = run(sb, ["setup", "--", "/usr/bin/env"], { cwd: work, env, input: "\n" });
    assert.equal(bare.status, 0, bare.stderr.toString("utf8"));
    assert.deepEqual(envNames(bare.stdout), FIXED);
  } finally {
    cleanup(sb);
  }
});

test("the eval launcher confines every operation to its root", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const outside = join(sb.dir, "outside");
    mkdirSync(outside);
    const repo = makeRepo(sb);

    assert.equal(run(sb, ["exec", "--", "/bin/sh", "-c", "echo x > marker"], { cwd: outside }).status, 64);
    assert.equal(run(sb, ["receive", "not-a-uuid", "1000000"], { input: repo.bundle }).status, 64);
    assert.equal(run(sb, ["check", TRIAL, "--", "z".repeat(40)]).status, 64);
    assert.equal(run(sb, ["check", TRIAL, "--", "a".repeat(39)]).status, 64);
    assert.deepEqual(readdirSync(outside), []);

    // A work directory replaced by a link out of the root is refused before the command runs.
    const work = prepareTrial(sb, repo.bundle);
    rmSync(work, { recursive: true, force: true });
    symlinkSync(outside, work);
    assert.equal(run(sb, ["exec", "--", "/bin/sh", "-c", "echo x > marker"], { cwd: work }).status, 64);
    assert.deepEqual(readdirSync(outside), []);

    assert.equal(run(sb, ["clean"]).status, 0);
    assert.deepEqual(readdirSync(join(sb.root, "trials")), []);
    assert.ok(existsSync(outside), "clean must not reach outside the root");
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanup(sb);
  }
});

test("scrub resets the home to the template", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const login = "login" + "-credentials\n";
    writeTree(sb.template, { ".claude/settings.json": '{"owner":"original"}\n' });
    writeTree(sb.home, { ".claude/.credentials.json": login, ".claude/settings.json": '{"owner":"original"}\n' });
    assert.equal(leftovers(sb), 0);

    // One planted top-level file and one changed template file: two leftovers.
    writeFileSync(join(sb.home, "planted.txt"), "x");
    writeFileSync(join(sb.template, ".claude", "settings.json"), '{"owner":"changed"}\n');
    assert.equal(leftovers(sb), 2);

    writeTree(sb.home, {
      ".claude/skills/x/SKILL.md": "skill\n",
      ".claude/projects/p/1.jsonl": "{}\n",
      ".claude/settings.json": '{"owner":"edited"}\n',
    });
    const scrubbed = run(sb, ["scrub"]);
    assert.equal(scrubbed.status, 0, scrubbed.stderr.toString("utf8"));
    assert.equal(readFileSync(join(sb.home, ".claude", ".credentials.json"), "utf8"), login);
    assert.equal(readFileSync(join(sb.home, ".claude", "settings.json"), "utf8"), '{"owner":"changed"}\n');
    assert.equal(existsSync(join(sb.home, "planted.txt")), false);
    assert.equal(existsSync(join(sb.home, ".claude", "skills")), false);
    assert.equal(existsSync(join(sb.home, ".claude", "projects")), false);
    assert.equal(leftovers(sb), 0);
  } finally {
    cleanup(sb);
  }
});

test("prepare leaves only the base", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const repo = makeRepo(sb);
    const work = prepareTrial(sb, repo.bundle);
    const trialDir = join(sb.root, "trials", TRIAL);
    assert.equal(git(work, ["remote"]), "");
    assert.equal(existsSync(join(trialDir, "in")), false);
    assert.equal(run(sb, ["check", TRIAL, "--", repo.c2]).status, 0);

    git(work, ["fetch", "--quiet", repo.source, "later"]);
    assert.equal(run(sb, ["check", TRIAL, "--", repo.c2]).status, 1);
  } finally {
    cleanup(sb);
  }
});

test("nothing outlives a trial", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    writeTree(sb.template, { ".claude/settings.json": '{"owner":"original"}\n' });
    // A skill a trial left in ROOT, and a home link that stands on the way to a login path.
    writeTree(join(sb.root, "stash"), { ".claude/skills/x/SKILL.md": "skill\n" });
    symlinkSync(join(sb.root, "stash", ".claude"), join(sb.home, ".claude"));
    // Three leftovers: the link on the way to the login path; the template's settings file, which the home path
    // reaches through the link and does not find there (cmp fails); and the stash entry in ROOT.
    assert.equal(leftovers(sb), 3);

    const scrubbed = run(sb, ["scrub"]);
    assert.equal(scrubbed.status, 0, scrubbed.stderr.toString("utf8"));
    assert.equal(lstatSync(join(sb.home, ".claude")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(sb.home, ".claude", "settings.json"), "utf8"), '{"owner":"original"}\n');
    assert.equal(existsSync(join(sb.home, ".claude", "skills")), false);
    // scrub leaves ROOT alone, so only the stash entry remains.
    assert.equal(leftovers(sb), 1);

    assert.equal(run(sb, ["clean"]).status, 0);
    assert.equal(existsSync(join(sb.root, "stash")), false);
    assert.equal(leftovers(sb), 0);

    // A file in EVAL_TMP is one leftover, and clean removes it.
    writeFileSync(join(sb.tmp, "solution.txt"), "x");
    assert.equal(leftovers(sb), 1);
    assert.equal(run(sb, ["clean"]).status, 0);
    assert.equal(existsSync(join(sb.tmp, "solution.txt")), false);
    assert.equal(leftovers(sb), 0);
  } finally {
    cleanup(sb);
  }
});

test("stop refuses another account", { skip: SKIP }, async () => {
  const sb = sandbox(`not-${userInfo().username}`);
  const sleeper = spawn("sleep", [String(randomInt(100_000, 900_000))], { stdio: "ignore" });
  try {
    assert.equal(run(sb, ["stop"]).status, 64);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(sleeper.exitCode, null, "stop under another account must not end the test's sleep");
    assert.equal(sleeper.signalCode, null);
  } finally {
    sleeper.kill("SIGKILL");
    cleanup(sb);
  }
});

test("stop removes the account's System V objects and its files in the added directories", { skip: SKIP || !["ipcs", "ipcrm", "ipcmk"].every(tool => existsSync(`/usr/bin/${tool}`)) && "util-linux ipcs, ipcrm, and ipcmk are missing" }, t => {
  // The launcher's own list names the directories the review found, and each is used only when it exists.
  const listed = readFileSync(LAUNCHER, "utf8").match(/^STOP_DIRS="([^"]*)"$/m)?.[1].split(" ") ?? [];
  for (const dir of ["/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue", "/run/lock", "/var/crash"]) assert.ok(listed.includes(dir), `${dir} is in STOP_DIRS`);

  const sb = sandbox(undefined, "/run/lock");
  const lockFile = join("/run/lock", `eval-launcher-test-${process.pid}`);
  let segment = "";
  try {
    let writable = true;
    try { accessSync("/run/lock", constants.W_OK); } catch { writable = false; }
    if (writable) writeFileSync(lockFile, "x");
    else t.diagnostic("/run/lock is not writable by the test user, so the file in it is not asserted");
    const made = spawnSync("/usr/bin/ipcmk", ["-M", "4096"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    segment = /(\d+)\s*$/m.exec(made.stdout)?.[1] ?? "";
    assert.match(segment, /^\d+$/, `ipcmk printed no id: ${made.stdout}`);
    const listing = () => spawnSync("/usr/bin/ipcs", ["-m"], { encoding: "utf8" }).stdout.split("\n").map(line => line.trim().split(/\s+/));
    const present = () => listing().some(fields => fields[0]?.startsWith("0x") && fields[1] === segment);
    assert.equal(present(), true, "the segment exists before stop");
    // The probe reports the segment, and the file when there is one, as leftovers.
    assert.ok(leftovers(sb) >= (writable ? 2 : 1), "the probe counts the account's shared memory and its file");

    const stopped = run(sb, ["stop"]);
    assert.equal(stopped.status, 0, stopped.stderr.toString("utf8"));
    assert.equal(present(), false, "stop removed the segment");
    assert.equal(existsSync(lockFile), false, "stop removed the file");
    assert.equal(leftovers(sb), 0);
  } finally {
    if (segment) spawnSync("/usr/bin/ipcrm", ["-m", segment]);
    rmSync(lockFile, { force: true });
    cleanup(sb);
  }
});

test("the proxy credential is in no process's arguments while a command runs", { skip: SKIP }, async () => {
  const sb = sandbox();
  let child: ReturnType<typeof spawn> | undefined;
  let sleeperPid = 0;
  try {
    const repo = makeRepo(sb);
    const work = prepareTrial(sb, repo.bundle);
    const secret = `credential-part-${randomInt(1_000_000, 9_000_000)}`;
    const duration = String(randomInt(100_000, 900_000));
    child = spawn("/bin/sh", [sb.script, "setup", "--", "/bin/sleep", duration], {
      cwd: work,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin?.end(`http://user:${secret}@127.0.0.1:9/\n`);
    const processes = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(pid => {
      try { return [{ pid: Number(pid), args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0") }]; } catch { return []; }
    });
    const deadline = Date.now() + 20_000;
    while (!sleeperPid && Date.now() < deadline) {
      sleeperPid = processes().find(p => p.args[0]?.endsWith("sleep") && p.args[1] === duration)?.pid ?? 0;
      if (!sleeperPid) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(sleeperPid, "the command started");
    const all = processes();
    assert.ok(all.some(p => p.args.includes("--kill-after=10")), "the launcher's timeout is running, so its arguments were checked");
    assert.deepEqual(all.filter(p => p.args.join(" ").includes(secret)).map(p => p.args[0]), []);
  } finally {
    if (sleeperPid) { try { process.kill(sleeperPid, "SIGKILL"); } catch { /* already gone */ } }
    if (child) {
      const ended = new Promise(resolve => child?.once("exit", resolve));
      child.kill("SIGKILL");
      await ended;
    }
    cleanup(sb);
  }
});

test("clean replaces a trials link or file with a directory and never follows the link", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const elsewhere = join(sb.dir, "elsewhere");
    writeTree(elsewhere, { "keep.txt": "keep\n" });
    const trials = join(sb.root, "trials");
    symlinkSync(elsewhere, trials);
    assert.equal(run(sb, ["clean"]).status, 0);
    assert.equal(lstatSync(trials).isSymbolicLink(), false);
    assert.equal(lstatSync(trials).isDirectory(), true);
    assert.equal(statSync(trials).mode & 0o777, 0o711);
    assert.deepEqual(readdirSync(trials), []);
    assert.equal(readFileSync(join(elsewhere, "keep.txt"), "utf8"), "keep\n", "the link's target is untouched");

    // A plain file in its place is replaced the same way.
    rmSync(trials, { recursive: true });
    writeFileSync(trials, "x");
    assert.equal(run(sb, ["clean"]).status, 0);
    assert.equal(lstatSync(trials).isDirectory(), true);
    assert.deepEqual(readdirSync(trials), []);
  } finally {
    cleanup(sb);
  }
});

test("every operation but clean refuses a trials link", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const repo = makeRepo(sb);
    const elsewhere = join(sb.dir, "elsewhere");
    mkdirSync(join(elsewhere, TRIAL, "work"), { recursive: true });
    symlinkSync(elsewhere, join(sb.root, "trials"));
    assert.equal(run(sb, ["receive", TRIAL, "1000000"], { input: repo.bundle }).status, 64);
    assert.equal(run(sb, ["prepare", TRIAL]).status, 64);
    assert.equal(run(sb, ["check", TRIAL, "--", "a".repeat(40)]).status, 64);
    assert.equal(run(sb, ["exec", "--", "/bin/sh", "-c", "echo x > marker"], { cwd: join(sb.root, "trials", TRIAL, "work") }).status, 64);
    assert.equal(run(sb, ["setup", "--", "/bin/sh", "-c", "echo x > marker"], { cwd: join(sb.root, "trials", TRIAL, "work"), input: "\n" }).status, 64);
    assert.deepEqual(readdirSync(join(elsewhere, TRIAL, "work")), []);
    assert.equal(lstatSync(join(sb.root, "trials")).isSymbolicLink(), true, "only clean repairs the link");
  } finally {
    cleanup(sb);
  }
});
