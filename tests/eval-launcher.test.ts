import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../deploy/ubuntu/eval-command.sh", import.meta.url));
const SKIP = process.platform !== "linux" ? "the launcher runs on Linux only"
  : process.getuid?.() === 0 ? "the launcher test must not run as root" : false;
const TRIAL = "11111111-2222-4333-8444-555555555555";
const NPROC_CAP = /^( {2}\/usr\/bin\/prlimit )--nproc=512 /m;
const IPC_TABLE = /ipc_table=\/proc\/sysvipc\/(shm|sem|msg)\b/g;
const FIXED = [
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
  "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR",
];
const PROXY = ["HTTPS_PROXY", "HTTP_PROXY", "NODE_USE_ENV_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

type Sandbox = { dir: string; root: string; home: string; template: string; tmp: string; script: string };
type Copy = { stop?: string; kernelTables?: boolean };

function rewrite(text: string, pattern: RegExp, to: (...match: string[]) => string, count = 1): string {
  const all = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  assert.equal(text.match(all)?.length ?? 0, count, `the launcher's text for ${pattern} moved; move this rewrite with it`);
  return text.replace(all, to);
}

function sandbox(account: string = userInfo().username, copy: Copy = {}): Sandbox {
  const kernelTables = copy.kernelTables === true || copy.stop !== undefined;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eval-launcher-")));
  const root = join(dir, "root");
  const home = join(dir, "home");
  const template = join(dir, "template");
  const tmp = join(dir, "tmp");
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
  const tables = join(dir, "sysvipc");
  mkdirSync(tables, { mode: 0o700 });
  for (const name of ["shm", "sem", "msg"]) writeFileSync(join(tables, name), `${readFileSync(`/proc/sysvipc/${name}`, "utf8").split("\n", 1)[0]}\n`);
  let text = source;
  for (const [name, value] of Object.entries({ ROOT: root, ACCOUNT: account, EVAL_HOME: home, TEMPLATE: template, EVAL_TMP: tmp, STOP_DIRS: copy.stop ?? shared })) {
    text = rewrite(text, new RegExp(`^${name}=.*$`, "m"), () => `${name}='${value}'`);
  }
  text = rewrite(text, /^ {2}kill -KILL -1 .*\n {2}\/usr\/bin\/sleep 1$/m, () => copy.stop ? "  :" : "  exit 99");
  text = rewrite(text, NPROC_CAP, (_line, command) => command);
  text = rewrite(text, IPC_TABLE, (line, name) => kernelTables ? line : `ipc_table='${join(tables, name)}'`, 3);
  assert.match(text, copy.stop ? /^ {2}:$/m : /^ {2}exit 99$/m, "the kill line was not replaced");
  assert.doesNotMatch(text, /kill -KILL -1/);
  assert.doesNotMatch(text, /^ {2}\/usr\/bin\/sleep 1$/m, "the wait after the kill line was not replaced");
  assert.doesNotMatch(text, /--nproc=/);
  assert.equal(text.includes("/proc/sysvipc/"), kernelTables, "only a copy that asks for the kernel's tables reads them");
  writeFileSync(script, text, { mode: 0o700 });
  chmodSync(script, 0o700);
  return { dir, root, home, template, tmp, script };
}

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

function ownSysV(): string[] {
  const uid = String(process.getuid?.());
  const own: string[] = [];
  for (const name of ["shm", "sem", "msg"]) {
    const [header = [], ...rows] = readFileSync(`/proc/sysvipc/${name}`, "utf8").split("\n").filter(line => line.trim()).map(line => line.trim().split(/\s+/));
    const owner = header.indexOf("uid"), creator = header.indexOf("cuid");
    assert.ok(owner > 1 && creator > owner, `/proc/sysvipc/${name} has no uid and cuid columns`);
    for (const row of rows) if (row[owner] === uid || row[creator] === uid) own.push(`${name}:${row[1]}`);
  }
  return own.sort();
}

function ownEntries(dir: string): string[] {
  const uid = process.getuid?.();
  const own: string[] = [];
  let device: number;
  try { device = lstatSync(dir).dev; } catch { return own; }
  const walk = (at: string): void => {
    let names: string[] = [];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const path = join(at, name);
      let entry;
      try { entry = lstatSync(path); } catch { continue; }
      if (entry.uid === uid) own.push(path);
      if (entry.isDirectory() && entry.dev === device) walk(path);
    }
  };
  walk(dir);
  return own.sort();
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, name)), { recursive: true });
    writeFileSync(join(base, name), text);
  }
}

test("the installed launcher keeps its process cap", () => {
  const source = readFileSync(LAUNCHER, "utf8");
  assert.equal(source.match(new RegExp(NPROC_CAP.source, "gm"))?.length, 1, "the installed launcher's prlimit command must still cap a trial's command with --nproc=512");
});

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
    writeTree(join(sb.root, "stash"), { ".claude/skills/x/SKILL.md": "skill\n" });
    symlinkSync(join(sb.root, "stash", ".claude"), join(sb.home, ".claude"));
    assert.equal(leftovers(sb), 3);

    const scrubbed = run(sb, ["scrub"]);
    assert.equal(scrubbed.status, 0, scrubbed.stderr.toString("utf8"));
    assert.equal(lstatSync(join(sb.home, ".claude")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(sb.home, ".claude", "settings.json"), "utf8"), '{"owner":"original"}\n');
    assert.equal(existsSync(join(sb.home, ".claude", "skills")), false);
    assert.equal(leftovers(sb), 1);

    assert.equal(run(sb, ["clean"]).status, 0);
    assert.equal(existsSync(join(sb.root, "stash")), false);
    assert.equal(leftovers(sb), 0);

    writeFileSync(join(sb.tmp, "solution.txt"), "x");
    assert.equal(leftovers(sb), 1);
    assert.equal(run(sb, ["clean"]).status, 0);
    assert.equal(existsSync(join(sb.tmp, "solution.txt")), false);
    assert.equal(leftovers(sb), 0);
  } finally {
    cleanup(sb);
  }
});

function fromClosed(sb: Sandbox, args: readonly string[]) {
  const closed = mkdtempSync(join(sb.dir, "closed-"));
  return spawnSync("/bin/sh", ["-c", 'cd "$1" && chmod 000 . && [ ! -r . ] && shift && exec /bin/sh "$@"', "sh", closed, sb.script, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    maxBuffer: 1 << 20,
    timeout: 120_000,
  });
}

test("probe, clean, and scrub work from a directory the account cannot enter", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    writeFileSync(join(sb.tmp, "solution.txt"), "x");
    writeFileSync(join(sb.home, "planted"), "x");
    const probe = fromClosed(sb, ["probe", "--"]);
    assert.equal(probe.status, 0, probe.stderr.toString("utf8"));
    assert.equal(probe.stderr.toString("utf8"), "");
    assert.equal(JSON.parse(probe.stdout.toString("utf8")).leftovers, 2);

    const cleaned = fromClosed(sb, ["clean"]);
    assert.equal(cleaned.status, 0, cleaned.stderr.toString("utf8"));
    assert.equal(existsSync(join(sb.tmp, "solution.txt")), false);
    const scrubbed = fromClosed(sb, ["scrub"]);
    assert.equal(scrubbed.status, 0, scrubbed.stderr.toString("utf8"));
    assert.equal(existsSync(join(sb.home, "planted")), false);
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

test("stop removes the account's System V objects and its files in the added directories", { skip: SKIP || !["ipcrm", "ipcmk"].every(tool => existsSync(`/usr/bin/${tool}`)) && "util-linux ipcrm and ipcmk are missing" }, t => {
  const listed = readFileSync(LAUNCHER, "utf8").match(/^STOP_DIRS="([^"]*)"$/m)?.[1].split(" ") ?? [];
  for (const dir of ["/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue", "/run/lock", "/var/crash"]) assert.ok(listed.includes(dir), `${dir} is in STOP_DIRS`);

  const sb = sandbox(undefined, { stop: "/run/lock" });
  const lockFile = join("/run/lock", `eval-launcher-test-${process.pid}`);
  let segment = "", created = false;
  try {
    const before = [...ownSysV(), ...ownEntries("/run/lock")];
    if (before.length > 0) { t.skip(`the test user already owns ${before.length} System V objects or entries in /run/lock, and stop would remove them`); return; }
    assert.equal(leftovers(sb), 0, "the probe counts nothing for a user that owns nothing");
    let writable = true;
    try { accessSync("/run/lock", constants.W_OK); } catch { writable = false; }
    if (writable) { closeSync(openSync(lockFile, "wx")); created = true; }
    else t.diagnostic("/run/lock is not writable by the test user, so the file in it is not asserted");
    const made = spawnSync("/usr/bin/ipcmk", ["-M", "4096"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    segment = /(\d+)\s*$/m.exec(made.stdout)?.[1] ?? "";
    assert.match(segment, /^\d+$/, `ipcmk printed no id: ${made.stdout}`);
    assert.equal(leftovers(sb), writable ? 2 : 1, "the probe counts the account's shared memory and its file, and nothing else");
    assert.deepEqual(ownSysV(), [`shm:${segment}`], "the user owns the test's segment and no other System V object");
    assert.deepEqual(ownEntries("/run/lock"), writable ? [lockFile] : [], "the user owns the test's file in /run/lock and nothing else there");

    const stopped = run(sb, ["stop"]);
    assert.equal(stopped.status, 0, stopped.stderr.toString("utf8"));
    assert.deepEqual(ownSysV(), [], "stop removed the segment");
    segment = "";
    assert.equal(existsSync(lockFile), false, "stop removed the file");
    assert.equal(leftovers(sb), 0);
  } finally {
    try {
      if (segment && ownSysV().includes(`shm:${segment}`)) spawnSync("/usr/bin/ipcrm", ["-m", segment]);
    } finally {
      if (created) rmSync(lockFile, { force: true });
      cleanup(sb);
    }
  }
});

test("the probe counts the test user's System V objects as the kernel lists them", { skip: SKIP }, t => {
  const sb = sandbox(undefined, { kernelTables: true });
  try {
    const disagreed: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = ownSysV(), counted = leftovers(sb), after = ownSysV();
      if (before.join() !== after.join()) continue;
      if (counted === before.length) return;
      disagreed.push(`${counted} for ${before.length}`);
    }
    if (disagreed.length === 0) { t.skip("the test user's System V objects changed during every probe"); return; }
    assert.fail(`the probe counts the user's objects, and no other user's: it counted ${disagreed.join(", ")}`);
  } finally {
    cleanup(sb);
  }
});

test("the proxy credential is in no process's arguments while a command runs", { skip: SKIP }, async () => {
  const sb = sandbox();
  let child: ReturnType<typeof spawn> | undefined;
  let sleeperPid = 0;
  const duration = String(randomInt(100_000, 900_000));
  const processes = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try { return [{ pid: Number(pid), args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0") }]; } catch { return []; }
  });
  const sleeper = () => processes().find(p => p.args[0]?.endsWith("sleep") && p.args[1] === duration)?.pid ?? 0;
  try {
    const repo = makeRepo(sb);
    const work = prepareTrial(sb, repo.bundle);
    const secret = `credential-part-${randomInt(1_000_000, 9_000_000)}`;
    child = spawn("/bin/sh", [sb.script, "setup", "--", "/bin/sleep", duration], {
      cwd: work,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin?.end(`http://user:${secret}@127.0.0.1:9/\n`);
    const deadline = Date.now() + 20_000;
    while (!sleeperPid && Date.now() < deadline) {
      sleeperPid = sleeper();
      if (!sleeperPid) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(sleeperPid, "the command started");
    const all = processes();
    assert.ok(all.some(p => p.args.includes("--kill-after=10")), "the launcher's timeout is running, so its arguments were checked");
    assert.deepEqual(all.filter(p => p.args.join(" ").includes(secret)).map(p => p.args[0]), []);
  } finally {
    sleeperPid ||= sleeper();
    if (sleeperPid) { try { process.kill(sleeperPid, "SIGKILL"); } catch { } }
    if (child && child.exitCode === null && child.signalCode === null) {
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
