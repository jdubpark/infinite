import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MainCheckService, type MainCheckPorts, type MainCheckView } from "../packages/host/src/main-check.js";
import { recordDirectory, recordScope } from "../packages/host/src/main-check-ports.js";
import { checksDigest, type MainCheckRecord } from "../packages/host/src/main-check-state.js";
import { bootId } from "../packages/host/src/process-census.js";
import type { TeamCommand, TeamProject } from "../packages/host/src/team-types.js";
import { teamCommand } from "../packages/host/src/team-workspace.js";
import type { Config } from "../packages/host/src/types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { censusPast, earlierProcesses } from "./main-check-earlier.js";

const PROCESSES = censusPast(await earlierProcesses());

const KEY = Buffer.alloc(32, 7);
const WAIT_MS = 20_000;
const FETCH_EVERY_MS = 1_000;
const CASE = { timeout: 45_000 };
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const sh = (script: string): TeamCommand => ({ command: "sh", args: ["-c", script] });
type View = Extract<MainCheckView, { readable: true }>;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

class Sandbox {
  readonly base = realpathSync(mkdtempSync(join(tmpdir(), "main-check-real-")));
  readonly source = join(this.base, "source");
  readonly mirror = join(this.base, "mirror.git");
  readonly teams = join(this.base, "teams");
  readonly pidFile = join(this.base, "pid");
  readonly config: Config;
  head: string;
  halted = false;
  service?: MainCheckService;

  constructor(files: Record<string, string>, checks: (sandbox: Sandbox) => TeamCommand[], projects: string[] = ["alpha"]) {
    mkdirSync(this.source);
    git(this.source, "init", "-q", "-b", "main");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(this.source, name), text);
    this.head = this.commit("first");
    git(this.base, "clone", "-q", "--bare", "--", this.source, this.mirror);
    const team = { checks: checks(this), mainCheck: { minutes: 1 } };
    this.config = {
      stateDir: join(this.base, "state"),
      projects: projects.map(id => ({ id, name: id.toUpperCase(), path: this.source, source: { mode: "github", repository: `example/${id}`, baseBranch: "main" }, team: structuredClone(team) })),
      agents: { claude: { command: "claude", args: [] } },
      teams: { workspaceDir: this.teams, storageFloor: { inodes: 0, bytes: 0 } },
    } as unknown as Config;
  }

  get digest() { return checksDigest(this.config.projects[0]!.team as TeamProject); }

  commit(message: string) {
    git(this.source, "add", "-A");
    git(this.source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
    return git(this.source, "rev-parse", "HEAD");
  }

  push(change: () => void) {
    change();
    this.head = this.commit("next");
    git(this.mirror, "fetch", "-q", "--no-tags", "--", this.source, "+refs/heads/main:refs/heads/main");
  }

  async start(ports?: Partial<MainCheckPorts>) {
    this.service = new MainCheckService({
      config: this.config, key: KEY, mirrorPath: () => this.mirror,
      halt: { check: () => ({ state: this.halted ? "halted" : "clear" }) }, hostLoad: { held: () => undefined }, ports: { processes: PROCESSES, ...ports },
    });
    await this.service.start();
    return this.service;
  }

  fetch(projectId = "alpha") {
    this.service!.observe({ projectId, repository: `example/${projectId}`, baseBranch: "main", head: this.head, fetchedAt: new Date().toISOString() });
  }

  view(projectId = "alpha"): View {
    const view = this.service!.view(projectId);
    if (!view?.readable) throw new Error(`${projectId} has no readable record`);
    return view;
  }

  record(projectId = "alpha"): MainCheckRecord {
    return unseal<MainCheckRecord>(KEY, recordScope(projectId), readFileSync(join(recordDirectory(this.config), `${projectId}.sealed`), "utf8"));
  }

  seed(projectId: string, record: MainCheckRecord) {
    writeSealed(join(recordDirectory(this.config), `${projectId}.sealed`), KEY, recordScope(projectId), record);
  }

  async until(what: string, ready: () => boolean, drive?: string) {
    const deadline = Date.now() + WAIT_MS;
    let next = Date.now() + FETCH_EVERY_MS;
    while (!ready()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; alpha: ${JSON.stringify(this.service?.view("alpha"))}`);
      if (drive && Date.now() >= next) {
        this.fetch(drive);
        next = Date.now() + FETCH_EVERY_MS;
      }
      await delay(50);
    }
  }

  pid(): number | undefined {
    if (!existsSync(this.pidFile)) return undefined;
    const pid = Number.parseInt(readFileSync(this.pidFile, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }

  runDirectories() { return existsSync(this.teams) ? readdirSync(this.teams) : []; }

  async dispose() {
    await this.service?.close();
    const pid = this.pid();
    if (pid !== undefined && !gone(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { }
      try { process.kill(pid, "SIGKILL"); } catch { }
    }
    rmSync(this.base, { recursive: true, force: true });
  }
}

const sleeper = (sandbox: Sandbox) => [sh(`echo $$ > '${sandbox.pidFile}'; exec sleep 30`)];
const runningEntry = (sandbox: Sandbox, directory: string, boot: string, recording: boolean): NonNullable<MainCheckRecord["running"]> => ({
  directory, root: sandbox.teams, witness: { boot, processes: [], sessions: [], groups: [] }, ...(recording ? { recording: true as const } : {}),
  head: sandbox.head, checks: sandbox.digest, startedAt: new Date(Date.now() - 60_000).toISOString(),
});

test("a. a passing check records passed at the head, offers nothing, and leaves no run directory", CASE, async () => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, () => [sh("test -f tracked.txt")]);
  try {
    const service = await sandbox.start();
    sandbox.fetch();
    await sandbox.until("a result", () => sandbox.view().results.length === 1);
    const view = sandbox.view();
    assert.equal(view.results[0]!.head, sandbox.head);
    assert.equal(view.results[0]!.outcome, "passed");
    assert.equal(view.last?.outcome, "passed");
    assert.deepEqual(view.last?.commands.map(command => [command.status, command.exitCode]), [["passed", 0]]);
    assert.equal(view.health?.outcome, "passed");
    assert.equal(view.current, true);
    assert.deepEqual(view.attempts, []);
    assert.deepEqual(service.notices(), []);
    await sandbox.until("retirement", () => sandbox.view().retiring === 0, "alpha");
    assert.deepEqual(sandbox.runDirectories(), [], "no run directory is left under the team root");
  } finally {
    await sandbox.dispose();
  }
});

test("b. a failing check (exit 3) offers a failed notice; once told, a passing head offers a passed one", CASE, async () => {
  const check = sh("if [ -f broken ]; then echo 'FAIL the build is broken' >&2; exit 3; fi");
  const sandbox = new Sandbox({ "tracked.txt": "one\n", broken: "yes\n" }, () => [check]);
  try {
    const service = await sandbox.start();
    const first = sandbox.head;
    sandbox.fetch();
    await sandbox.until("a result", () => sandbox.view().results.length === 1);
    const failed = sandbox.view();
    assert.equal(failed.results[0]!.outcome, "failed");
    assert.deepEqual(failed.health?.failed, { index: 1, exitCode: 3 });
    assert.equal(failed.last?.outcome, "failed");
    assert.deepEqual(failed.last?.commands.map(command => [command.status, command.exitCode]), [["failed", 3]]);
    const notices = service.notices();
    assert.deepEqual(notices, [{ projectId: "alpha", label: "ALPHA", notice: 1, outcome: "failed", summary: sandbox.view().health }]);
    assert.equal(notices[0]!.summary.head, first);
    service.accepted("alpha", 1, "failed");
    assert.deepEqual(sandbox.view().told, { notice: 1, outcome: "failed" });
    assert.deepEqual(service.notices(), [], "the owner was told");
    sandbox.push(() => unlinkSync(join(sandbox.source, "broken")));
    sandbox.fetch();
    await sandbox.until("the second result", () => sandbox.view().results.length === 2, "alpha");
    const fixed = sandbox.view();
    assert.equal(fixed.results[1]!.head, sandbox.head);
    assert.equal(fixed.health?.outcome, "passed");
    assert.equal(fixed.notice, 2);
    assert.deepEqual(service.notices(), [{ projectId: "alpha", label: "ALPHA", notice: 2, outcome: "passed", summary: sandbox.view().health }]);
  } finally {
    await sandbox.dispose();
  }
});

test("c. a command that changes a tracked file and exits 0 is an error with copy-changed, and the admission stays charged", CASE, async () => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, () => [sh("echo changed > tracked.txt")]);
  try {
    await sandbox.start();
    sandbox.fetch();
    await sandbox.until("the end of the check", () => sandbox.view().last !== undefined);
    const view = sandbox.view();
    assert.equal(view.last?.outcome, "error");
    assert.equal(view.last?.reason, "copy-changed");
    assert.deepEqual(view.last?.commands.map(command => [command.status, command.exitCode]), [["passed", 0]]);
    assert.deepEqual(view.results, []);
    assert.equal(view.health, undefined);
    assert.deepEqual(view.attempts, [{ head: sandbox.head, checks: sandbox.digest, count: 1 }]);
  } finally {
    await sandbox.dispose();
  }
});

test("d. a real sleep past the time limit is interrupted with time-limit, the process is gone and the directory removed", CASE, async () => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, sleeper);
  try {
    const run: MainCheckPorts["run"] = (command, cwd, signal, _timeoutMs, prefix, input, extraEnv, forceSettleAfterMs, onOutput) => teamCommand(command, cwd, signal, 1_500, prefix, input, extraEnv, forceSettleAfterMs, onOutput);
    await sandbox.start({ run });
    sandbox.fetch();
    await sandbox.until("the end of the check", () => sandbox.view().last !== undefined);
    const view = sandbox.view();
    assert.equal(view.last?.outcome, "interrupted");
    assert.equal(view.last?.reason, "time-limit");
    assert.deepEqual(view.last?.commands.map(command => [command.status, command.exitCode]), [["interrupted", null]]);
    const pid = sandbox.pid();
    assert.ok(pid !== undefined && gone(pid), "the sleep is gone");
    const directory = sandbox.record().retiring![0]!.directory;
    assert.ok(existsSync(join(sandbox.teams, directory)), "the copy existed");
    sandbox.halted = true;
    await sandbox.until("retirement", () => sandbox.view().retiring === 0, "alpha");
    assert.equal(existsSync(join(sandbox.teams, directory)), false);
    assert.deepEqual(sandbox.view().attempts, [{ head: sandbox.head, checks: sandbox.digest, count: 1 }]);
  } finally {
    await sandbox.dispose();
  }
});

test("e. a halt during a real long command interrupts it with halt, gives the admission back and removes the directory", CASE, async () => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, sleeper);
  try {
    await sandbox.start();
    sandbox.fetch();
    await sandbox.until("the sleep", () => sandbox.pid() !== undefined);
    const pid = sandbox.pid()!;
    assert.equal(gone(pid), false);
    sandbox.halted = true;
    await sandbox.until("the end of the check", () => sandbox.view().last !== undefined);
    const view = sandbox.view();
    assert.equal(view.last?.outcome, "interrupted");
    assert.equal(view.last?.reason, "halt");
    assert.deepEqual(view.attempts, [], "the admission was given back");
    assert.ok(gone(pid), "the sleep is gone");
    await sandbox.until("retirement and the halt recorded", () => sandbox.view().retiring === 0 && sandbox.view().waiting === "halt", "alpha");
    assert.deepEqual(sandbox.runDirectories(), []);
    assert.equal(sandbox.view().running, undefined);
  } finally {
    await sandbox.dispose();
  }
});

test("f. entries whose directories never existed leave retiring, with no team root at all", CASE, async () => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, () => [sh("true")]);
  try {
    sandbox.seed("alpha", {
      version: 1,
      attempts: [{ head: sandbox.head, checks: sandbox.digest, count: 1 }],
      running: runningEntry(sandbox, "alpha-2026-11-20-main-check-0000f00d", "an-earlier-boot", true),
      retiring: [{ directory: "alpha-2026-11-20-main-check-0000beef", root: sandbox.teams, witness: { boot: bootId(), processes: [], sessions: [], groups: [] } }],
    });
    await sandbox.start();
    assert.equal(sandbox.view().retiring, 2, "R8 moved running to retiring");
    await sandbox.until("retirement", () => sandbox.view().retiring === 0);
    const view = sandbox.view();
    assert.equal(view.last?.outcome, "interrupted");
    assert.equal(view.last?.reason, "host-stop");
    assert.equal(existsSync(sandbox.teams), false, "retirement creates nothing");
  } finally {
    await sandbox.dispose();
  }
});

test("g. host start with running and a real directory: retired without recording; kept, and nothing admitted, with recording in this boot", CASE, async () => {
  const directory = "alpha-2026-11-20-main-check-0000c0de";
  const prepare = (sandbox: Sandbox) => {
    mkdirSync(join(sandbox.teams, directory, "integration"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sandbox.teams, directory, "integration", "left.txt"), "left\n");
  };
  const plain = new Sandbox({ "tracked.txt": "one\n" }, () => [sh("true")]);
  try {
    prepare(plain);
    plain.seed("alpha", { version: 1, attempts: [{ head: plain.head, checks: plain.digest, count: 1 }], running: runningEntry(plain, directory, bootId(), false) });
    await plain.start();
    await plain.until("retirement", () => plain.view().retiring === 0);
    assert.deepEqual(plain.runDirectories(), []);
    assert.equal(plain.view().last?.reason, "host-stop");
    assert.deepEqual(plain.view().attempts, [{ head: plain.head, checks: plain.digest, count: 1 }], "R8 keeps the admission charged");
  } finally {
    await plain.dispose();
  }
  const recording = new Sandbox({ "tracked.txt": "one\n" }, () => [sh("true")], ["alpha", "beta"]);
  try {
    prepare(recording);
    recording.seed("alpha", { version: 1, attempts: [{ head: recording.head, checks: recording.digest, count: 1 }], running: runningEntry(recording, directory, bootId(), true) });
    await recording.start();
    recording.fetch("beta");
    await recording.until("both projects waiting", () => recording.view("alpha").waiting === "processes" && recording.service!.view("beta")?.readable === true && recording.view("beta").waiting === "another-check");
    assert.deepEqual(recording.runDirectories(), [directory], "the directory stays");
    assert.equal(recording.view("alpha").retiring, 1);
    const beta = recording.view("beta");
    assert.equal(beta.running, undefined);
    assert.equal(beta.last, undefined);
    assert.deepEqual(beta.attempts, [], "nothing was admitted for any project");
  } finally {
    await recording.dispose();
  }
});

test("h. close during a real long command finishes it as host-stop within the bound and gives the admission back", CASE, async t => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, sleeper);
  try {
    const service = await sandbox.start();
    sandbox.fetch();
    await sandbox.until("the sleep", () => sandbox.pid() !== undefined);
    const pid = sandbox.pid()!;
    const begun = Date.now();
    await service.close();
    const took = Date.now() - begun;
    t.diagnostic(`close returned after ${took} ms`);
    assert.ok(took < 10_000, `close took ${took} ms`);
    const record = sandbox.record();
    assert.equal(record.last?.outcome, "interrupted");
    assert.equal(record.last?.reason, "host-stop");
    assert.equal(record.attempts, undefined, "the admission was given back");
    assert.equal(record.running, undefined);
    assert.equal(record.retiring?.length, 1);
    assert.ok(gone(pid), "the sleep is gone");
    sandbox.halted = true;
    await sandbox.start();
    await sandbox.until("retirement", () => sandbox.view().retiring === 0);
    assert.deepEqual(sandbox.runDirectories(), []);
  } finally {
    await sandbox.dispose();
  }
});

test("i. a check that leaves a real sleep behind passes when its leader exits; the sleep is never signalled, and its directory retires after it", CASE, async t => {
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, s => [sh(`sleep 4 & echo $! > '${s.pidFile}'; exit 0`)]);
  try {
    await sandbox.start();
    sandbox.fetch();
    await sandbox.until("the result", () => sandbox.view().last !== undefined);
    const pid = sandbox.pid()!;
    const spawned = statSync(sandbox.pidFile).mtimeMs;
    const took = Date.now() - spawned;
    assert.equal(gone(pid), false, `the result came ${took} ms after the sleep started, once it had ended: the check waited for its leftover`);
    assert.ok(took < 3_500, `the result came ${took} ms after the sleep started`);
    const view = sandbox.view();
    assert.equal(view.last?.outcome, "passed");
    assert.deepEqual(view.last?.commands.map(command => [command.status, command.exitCode]), [["passed", 0]]);
    assert.equal(view.results[0]?.outcome, "passed");
    await sandbox.until("the entry waiting on the sleep", () => sandbox.view().retiring === 1 && sandbox.view().waiting === "processes", "alpha");
    assert.equal(gone(pid), false, "the census found the sleep while it lives");
    assert.deepEqual(sandbox.runDirectories().length, 1, "the copy stays while the sleep lives");
    sandbox.halted = true;
    await sandbox.until("the sleep's own exit", () => gone(pid), "alpha");
    const lived = Date.now() - spawned;
    t.diagnostic(`result ${took} ms after the sleep started; the sleep lived about ${lived} ms`);
    assert.ok(lived >= 3_500, `the sleep ended ${lived} ms after it started, before its 4 seconds`);
    await sandbox.until("retirement", () => sandbox.view().retiring === 0, "alpha");
    assert.deepEqual(sandbox.runDirectories(), []);
  } finally {
    await sandbox.dispose();
  }
});

test("j. under a command prefix the removal of a copy ends with its launcher: a host stop after that exit signals nothing", CASE, async () => {
  const directory = "alpha-2026-11-20-main-check-0000d00d";
  const sandbox = new Sandbox({ "tracked.txt": "one\n" }, () => [sh("true")]);
  try {
    mkdirSync(join(sandbox.teams, directory, "integration"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sandbox.teams, directory, "integration", "left.txt"), "left\n");
    const launcher = join(sandbox.base, "launcher.sh");
    const leaderFile = join(sandbox.base, "leader");
    writeFileSync(launcher, `echo $$ > '${leaderFile}'\n"$@"\nstatus=$?\nsleep 30 &\necho $! > '${sandbox.pidFile}'\nexit $status\n`);
    sandbox.config.teams!.commandPrefix = { command: "sh", args: [launcher] };
    sandbox.seed("alpha", { version: 1, retiring: [{ directory, root: sandbox.teams, witness: { boot: bootId(), processes: [], sessions: [], groups: [] } }] });
    sandbox.halted = true;
    const processes: MainCheckPorts["processes"] = { table: async () => ({ boot: bootId(), rows: [] }), start: async () => undefined, census: async () => ({ ok: true, findings: [] }) };
    const service = await sandbox.start({ processes });
    await sandbox.until("the launcher's sleep", () => sandbox.pid() !== undefined);
    const pid = sandbox.pid()!;
    const leader = Number.parseInt(readFileSync(leaderFile, "utf8"), 10);
    await sandbox.until("the launcher's exit", () => gone(leader));
    assert.equal(existsSync(join(sandbox.teams, directory, "integration")), false, "the launcher's rm ran");
    await service.close();
    await delay(500);
    assert.equal(gone(pid), false, "the sleep the launcher left behind still runs half a second after the host stop");
  } finally {
    await sandbox.dispose();
  }
});
