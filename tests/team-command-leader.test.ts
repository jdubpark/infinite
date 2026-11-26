import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_ANCHOR } from "../packages/host/src/group-supervisor.js";
import { commandScope, EXIT_DRAIN_MS, STOP_GRACE_MS, STOP_SETTLE_MS, TeamError, teamCommand, teamHead, teamOperationCommand, type CommandResult, type CommandScope } from "../packages/host/src/team-workspace.js";

const CASE = { timeout: 20_000, skip: process.platform === "win32" && "process groups are POSIX" };
const WAIT_MS = 10_000;
const realSetTimeout = globalThis.setTimeout;
type Command = { command: string; args: string[] };
const leaves = (leader: string, left: string): Command => ({ command: "sh", args: ["-c", `echo $$ > '${leader}'; sleep 30 & echo $! > '${left}'; exit 3`] });
const waits = (leader: string, left: string): Command => ({ command: "sh", args: ["-c", `echo $$ > '${leader}'; sleep 30 & echo $! > '${left}'; wait`] });
const escapes = (leader: string, left: string): Command => ({ command: process.execPath, args: ["-e", [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(process.argv[1], process.pid + '\\n');",
  "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
  "writeFileSync(process.argv[2], child.pid + '\\n');",
  "process.exit(0);",
].join("\n"), leader, left] });

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function ended(pid: number): boolean {
  if (gone(pid)) return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) === "Z";
  } catch {
    return false;
  }
}

async function until(what: string, ready: () => boolean) {
  const deadline = Date.now() + WAIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`${what} within ${WAIT_MS} ms`);
    await new Promise(resolve => realSetTimeout(resolve, 10));
  }
}

function pidIn(file: string): number | undefined {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return text.endsWith("\n") ? Number.parseInt(text, 10) : undefined;
}

class Run {
  readonly base = mkdtempSync(join(tmpdir(), "team-command-leader-"));
  readonly leaderFile = join(this.base, "leader");
  readonly leftFile = join(this.base, "left");
  readonly controller = new AbortController();
  settledAt?: number;
  private drainTimers?: TestContext["mock"]["timers"];

  holdDrain(t: TestContext) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    this.drainTimers = t.mock.timers;
  }

  releaseDrain(tickMs = 0) {
    if (!this.drainTimers) return;
    const timers = this.drainTimers;
    this.drainTimers = undefined;
    try {
      if (tickMs > 0) timers.tick(tickMs);
    } finally {
      timers.reset();
    }
  }

  start(command: (leader: string, left: string) => Command, scope?: CommandScope): Promise<CommandResult> {
    const run = () => teamCommand(command(this.leaderFile, this.leftFile), this.base, this.controller.signal, 60_000);
    return (scope ? commandScope.run(scope, run) : run()).finally(() => { this.settledAt = performance.now(); });
  }

  async left(): Promise<number> {
    await until("the leader writes the pid of what it leaves", () => pidIn(this.leftFile) !== undefined);
    return pidIn(this.leftFile)!;
  }

  async leaderExited() {
    await until("the leader is reaped", () => { const leader = pidIn(this.leaderFile); return leader !== undefined && gone(leader); });
  }

  dispose() {
    this.releaseDrain();
    const left = pidIn(this.leftFile);
    if (left !== undefined && Number.isSafeInteger(left) && left > 1 && !gone(left)) process.kill(left, "SIGKILL");
    rmSync(this.base, { recursive: true, force: true });
  }
}

test("a command whose output closes at its exit settles on the close, whole, not truncated and with no leftover", CASE, async () => {
  const run = new Run();
  try {
    const started = performance.now();
    const result = await run.start(() => ({ command: "sh", args: ["-c", "echo whole; echo also >&2; exit 4"] }));
    const elapsed = run.settledAt! - started;
    assert.equal(result.exitCode, 4);
    assert.equal(result.interrupted, false);
    assert.equal(result.truncated, false, "the output closed");
    assert.equal(result.leftover, false);
    assert.equal(result.stdout, "whole\n");
    assert.deepEqual(result.output.split("\n").filter(Boolean).sort(), ["also", "whole"]);
    assert.ok(elapsed < EXIT_DRAIN_MS, `settled ${elapsed.toFixed(0)} ms after the start: it waited out the drain`);
  } finally {
    run.dispose();
  }
});

test("a command whose leader exited while its group holds the output settles a drain later with the leader's code, and a later stop signals nothing", CASE, async () => {
  const run = new Run();
  try {
    const started = performance.now();
    const result = await run.start(leaves);
    const sleep = await run.left();
    const elapsed = run.settledAt! - started;
    assert.equal(result.exitCode, 3);
    assert.equal(result.interrupted, false);
    assert.equal(result.truncated, true, "the output never closed");
    assert.equal(result.leftover, true);
    assert.ok(elapsed >= EXIT_DRAIN_MS, `settled ${elapsed.toFixed(0)} ms after the start, before the drain ended`);
    assert.ok(elapsed < EXIT_DRAIN_MS + 4_000, `settled ${elapsed.toFixed(0)} ms after the start: it waited for the pipes`);
    run.controller.abort();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(gone(sleep), false, "the leftover sleep runs after the settled command's stop");
  } finally {
    run.dispose();
  }
});

test("a leftover that left the leader's group and session is neither waited for nor signalled", CASE, async t => {
  const run = new Run();
  try {
    run.holdDrain(t);
    const result = run.start(escapes);
    const child = await run.left();
    await run.leaderExited();
    assert.equal(run.settledAt, undefined, "the command stays in its drain until stopped");
    const stoppedAt = performance.now();
    run.controller.abort();
    const settled = await result;
    run.releaseDrain(500);
    const waited = run.settledAt! - stoppedAt;
    assert.ok(waited >= 0 && waited < 250, `settled ${waited.toFixed(0)} ms after the stop`);
    assert.equal(settled.exitCode, 0);
    assert.equal(settled.interrupted, false);
    assert.equal(settled.leftover, true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(gone(child), false, "the child in its own session still runs half a second after the stop");
  } finally {
    run.dispose();
  }
});

test("a stop inside the drain settles at once and signals nothing", CASE, async t => {
  const run = new Run();
  try {
    run.holdDrain(t);
    const result = run.start(leaves);
    const sleep = await run.left();
    await run.leaderExited();
    assert.equal(run.settledAt, undefined, "the command stays in its drain until stopped");
    const stoppedAt = performance.now();
    run.controller.abort();
    const settled = await result;
    run.releaseDrain(500);
    const waited = run.settledAt! - stoppedAt;
    assert.ok(waited >= 0 && waited < 250, `settled ${waited.toFixed(0)} ms after the stop`);
    assert.equal(settled.exitCode, 3);
    assert.equal(settled.interrupted, false);
    assert.equal(settled.truncated, true);
    assert.equal(settled.leftover, true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(gone(sleep), false, "the leftover sleep still runs half a second after the stop");
  } finally {
    run.dispose();
  }
});

test("a stop while the leader runs kills its group as before", CASE, async () => {
  const run = new Run();
  try {
    const result = run.start(waits);
    const sleep = await run.left();
    assert.equal(gone(pidIn(run.leaderFile)!), false, "the leader waits for its sleep");
    run.controller.abort();
    const settled = await result;
    assert.equal(settled.interrupted, true);
    assert.equal(settled.leftover, false);
    await until("the sleep in the leader's group ends", () => ended(sleep));
  } finally {
    run.dispose();
  }
});

test("a command whose stop comes before its start never starts, whether it was asked for after the stop or stopped while it waited for its turn, and its scope hears of no process (INF-505)", CASE, async () => {
  const stopped = new Run(), waiting = new Run();
  const heard: (number | undefined)[] = [];
  const started = (pid: number | undefined) => { heard.push(pid); };
  let open!: () => void;
  const turn = new Promise<void>(resolve => { open = resolve; });
  try {
    stopped.controller.abort();
    const asked = await stopped.start(waits, { starting: () => undefined, started });
    const queued = waiting.start(waits, { starting: () => turn, started });
    waiting.controller.abort();
    open();
    const results = [asked, await queued];
    assert.deepEqual(heard, [undefined, undefined], "the scope heard of a started process");
    for (const result of results) assert.deepEqual(result, { exitCode: null, output: "", stdout: "", interrupted: true, notStarted: true, truncated: false, leftover: false });
    assert.deepEqual([existsSync(stopped.leaderFile), existsSync(waiting.leaderFile)], [false, false], "a command ran");
  } finally {
    open();
    stopped.dispose();
    waiting.dispose();
  }
});

test("a command inside a scope that records it ends with its leader the same way", CASE, async t => {
  const run = new Run();
  let recorded: number | undefined;
  try {
    run.holdDrain(t);
    const result = run.start(leaves, { starting: () => undefined, started: pid => { recorded = pid; } });
    const sleep = await run.left();
    await run.leaderExited();
    assert.equal(recorded, pidIn(run.leaderFile), "the scope recorded the leader");
    assert.equal(run.settledAt, undefined, "the command stays in its drain until stopped");
    run.controller.abort();
    const settled = await result;
    run.releaseDrain(500);
    assert.equal(settled.interrupted, false);
    assert.equal(settled.leftover, true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(gone(sleep), false, "the leftover sleep still runs half a second after the stop");
  } finally {
    run.dispose();
  }
});

test("a Git helper refuses a read whose output a leftover held, a drain after Git exited, and stops nothing", CASE, async () => {
  const base = mkdtempSync(join(tmpdir(), "team-command-leader-git-"));
  const leftFile = join(base, "left");
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: base, env });
    execFileSync("git", ["-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: base, env });
    const launcher = join(base, "launcher.sh");
    writeFileSync(launcher, `sleep 30 &\necho $! > '${leftFile}'\nexec "$@"\n`);
    const started = performance.now();
    await assert.rejects(teamHead(base, { command: "/bin/sh", args: [launcher] }),
      (error: unknown) => error instanceof TeamError && error.code === "workspace-operation-failed");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 15_000, `refused ${elapsed.toFixed(0)} ms after the start, not at the 30 s limit`);
    await until("the launcher writes the pid of its sleep", () => pidIn(leftFile) !== undefined);
    assert.equal(gone(pidIn(leftFile)!), false, "the sleep the launcher left still runs");
  } finally {
    const left = pidIn(leftFile);
    if (left !== undefined && Number.isSafeInteger(left) && left > 1 && !gone(left)) process.kill(left, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test("a command whose output ended while the loop was busy past the drain settles whole, with no leftover", CASE, async () => {
  const run = new Run();
  const holds = (_leader: string, left: string): Command => ({ command: "sh", args: ["-c", `echo first; (sleep 0.3; echo late) & echo $! > '${left}'; exit 0`] });
  let leader: number | undefined, busy = false, done = false;
  const tick = () => {
    if (done) return;
    if (!busy && leader !== undefined && gone(leader)) {
      busy = true;
      const from = performance.now(), holder = pidIn(run.leftFile);
      const holding = () => holder !== undefined && !gone(holder) && performance.now() - from < 5_000;
      while (performance.now() - from < EXIT_DRAIN_MS + 300 || holding()) { }
    }
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    const result = await run.start(holds, { starting: () => undefined, started: pid => { leader = pid; } });
    assert.ok(busy, "the loop was busy after the leader's exit was heard");
    assert.equal(result.exitCode, 0);
    assert.equal(result.leftover, false, "the output had ended before the drain decided");
    assert.equal(result.truncated, false);
    assert.equal(result.stdout, "first\nlate\n");
  } finally {
    done = true;
    run.dispose();
  }
});

const SUDO_ACCOUNT = "nobody";
const SUDO_BASE = "/tmp";
function sharedDirectory() {
  const base = mkdtempSync(join(SUDO_BASE, "team-command-stop-"));
  chmodSync(base, 0o777);
  return base;
}
const sudoUnavailable = (() => {
  if (process.platform !== "linux") return "the sudo cases run on Linux";
  const probe = sharedDirectory();
  try {
    execFileSync("sudo", ["-n", "-u", SUDO_ACCOUNT, "--", "sh", "-c", ": > \"$1\"", "probe", join(probe, "probe")], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch {
    return `sudo -n -u ${SUDO_ACCOUNT} cannot write to a directory under ${SUDO_BASE} on this machine`;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const PREFIX_CASE = { timeout: 40_000, skip: process.platform === "win32" && "process groups are POSIX" };
const SUDO_CASE = { timeout: 40_000, skip: sudoUnavailable };
const SUDO: Command = { command: "sudo", args: ["-n", "-u", SUDO_ACCOUNT, "--"] };
const RELAY: Command = { command: process.execPath, args: ["-e", [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit', detached: true });",
  "process.on('SIGTERM', () => child.kill('SIGTERM'));",
  "child.on('exit', code => process.exit(code ?? 1));",
].join("\n")] };
const nodeCommand = (lines: string[], ...args: string[]): Command => ({ command: process.execPath, args: ["-e", lines.join("\n"), ...args] });
const endsOnTerm = (marker: string, leader: string) => nodeCommand([
  "const { writeFileSync } = require('node:fs');",
  "process.on('SIGTERM', () => { writeFileSync(process.argv[1], 'SIGTERM'); process.exit(0); });",
  "writeFileSync(process.argv[2], process.pid + '\\n');",
  "setInterval(() => {}, 1000);",
], marker, leader);
const ignoresTerm = (leader: string) => nodeCommand([
  "process.on('SIGTERM', () => {});",
  "require('node:fs').writeFileSync(process.argv[1], process.pid + '\\n');",
  "setInterval(() => {}, 1000);",
], leader);

function groupSignal(pid: number) {
  try {
    process.kill(-pid, 0);
    return "accepted";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "failed";
  }
}

function unconfirmed(outcome: { value: CommandResult } | { error: unknown }) {
  return "error" in outcome && outcome.error instanceof TeamError && outcome.error.code === "command-stop-unconfirmed";
}

async function stopRun(t: TestContext, command: Command, cwd: string, pidFile: string, prefix?: Command) {
  const controller = new AbortController();
  let leader: number | undefined;
  const scope: CommandScope = { starting: () => undefined, started: pid => { leader = pid; } };
  const result = commandScope.run(scope, () => teamOperationCommand(command, cwd, controller.signal, 60_000, prefix));
  result.catch(() => {});
  await until("the command writes its pid", () => pidIn(pidFile) !== undefined);
  t.diagnostic(`signal 0 to the prefix's group ${leader}: ${groupSignal(leader!)}`);
  const stoppedAt = performance.now();
  controller.abort();
  let prefixAfterOneSecond: boolean | undefined, timer: NodeJS.Timeout | undefined;
  const probe = setTimeout(() => { prefixAfterOneSecond = !gone(leader!); }, 1_000);
  const unsettled = new Promise<{ error: unknown }>(resolve => { timer = setTimeout(() => resolve({ error: new Error("the command did not settle after the stop") }), STOP_SETTLE_MS + WAIT_MS); });
  const outcome = await Promise.race([result.then(value => ({ value }), (error: unknown) => ({ error })), unsettled]);
  const waited = performance.now() - stoppedAt;
  clearTimeout(timer);
  if (waited < 1_000) clearTimeout(probe);
  else await new Promise(resolve => setTimeout(resolve, 0));
  return { outcome, waited, leader: leader!, pid: pidIn(pidFile)!, prefixAfterOneSecond };
}

test("through a relaying prefix the stop sends SIGTERM first: the command that ends on it gets it, and the operation still counts the stop unconfirmed once the output closes", PREFIX_CASE, async t => {
  const base = mkdtempSync(join(tmpdir(), "team-command-relay-"));
  const marker = join(base, "marker"), pidFile = join(base, "pid");
  try {
    const stopped = await stopRun(t, endsOnTerm(marker, pidFile), base, pidFile, RELAY);
    assert.equal(existsSync(marker) ? readFileSync(marker, "utf8") : "nothing", "SIGTERM", "the relayed SIGTERM reached the command");
    assert.ok(stopped.waited < STOP_GRACE_MS, `the output closed ${stopped.waited.toFixed(0)} ms after the stop`);
    assert.ok(unconfirmed(stopped.outcome), "closed output under a prefix does not count as a finished stop");
  } finally {
    const pid = pidIn(pidFile);
    if (pid !== undefined && pid > 1 && !gone(pid)) process.kill(pid, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test("through a relaying prefix a command that ignores SIGTERM is ended by the anchor's own SIGKILL when the grace ends, inside the operation's bound", PREFIX_CASE, async t => {
  const base = mkdtempSync(join(tmpdir(), "team-command-relay-"));
  const pidFile = join(base, "pid");
  try {
    const stopped = await stopRun(t, ignoresTerm(pidFile), base, pidFile, RELAY);
    assert.equal(stopped.prefixAfterOneSecond, true, "the prefix still runs one second after the stop");
    assert.ok(unconfirmed(stopped.outcome), "the operation counts the stop unconfirmed");
    assert.ok(stopped.waited >= STOP_GRACE_MS - 200, `answered ${stopped.waited.toFixed(0)} ms after the stop, before the grace ended`);
    assert.ok(stopped.waited < STOP_SETTLE_MS - 1_000, `answered ${stopped.waited.toFixed(0)} ms after the stop, at the operation's bound`);
    assert.equal(gone(stopped.leader), true, "the prefix ended");
    await until("the command outside the prefix's group ended", () => ended(stopped.pid));
  } finally {
    const pid = pidIn(pidFile);
    if (pid !== undefined && pid > 1 && !gone(pid)) process.kill(pid, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

const leadsStubbornMember = (leader: string, member: string): Command => ({ command: "sh", args: ["-c", `echo $$ > '${leader}'; (trap "" TERM; echo $$ > '${member}'; exec sleep 30) & wait`] });

test("a stop ends a group member that ignores SIGTERM whose leader obeys it: through a relaying prefix at the anchor's grace, and without a prefix at once", PREFIX_CASE, async t => {
  for (const prefix of [RELAY, undefined]) {
    const base = mkdtempSync(join(tmpdir(), "team-command-member-"));
    const leaderFile = join(base, "leader"), memberFile = join(base, "member");
    try {
      const stopped = await stopRun(t, leadsStubbornMember(leaderFile, memberFile), base, memberFile, prefix);
      await until("the member is recorded", () => pidIn(memberFile) !== undefined);
      const member = pidIn(memberFile)!;
      if (prefix) {
        assert.ok(unconfirmed(stopped.outcome), "the operation counts the stop unconfirmed");
        assert.ok(stopped.waited >= STOP_GRACE_MS - 200, `answered ${stopped.waited.toFixed(0)} ms after the stop, before the grace ended`);
        assert.ok(stopped.waited < STOP_SETTLE_MS - 1_000, `answered ${stopped.waited.toFixed(0)} ms after the stop, at the operation's bound`);
      } else {
        assert.ok(!unconfirmed(stopped.outcome), "a command without a prefix needs no anchor: the group is killed at once");
        assert.ok(stopped.waited < 1_000, `answered ${stopped.waited.toFixed(0)} ms after the stop`);
      }
      await until(`the member that ignores SIGTERM ended${prefix ? " behind the prefix" : ""}`, () => ended(member));
    } finally {
      const member = pidIn(memberFile);
      if (member !== undefined && member > 1 && !gone(member)) process.kill(member, "SIGKILL");
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("an anchor whose command ends by itself exits with its status and has started no sleeper, so nothing of it outlives the command", { ...PREFIX_CASE, skip: process.platform !== "linux" && "the anchor runs under dash on Linux" }, async () => {
  const anchor = spawn("sh", ["-c", TEAM_ANCHOR, "sh", "3", "sh", "-c", "exit 5"], { detached: true, stdio: "ignore" });
  const exit = await new Promise<number | null>(resolve => anchor.once("exit", code => resolve(code)));
  assert.equal(exit, 5);
  const left = execFileSync("ps", ["-e", "-o", "pgid=,args="], { encoding: "utf8" }).split("\n").filter(line => line.trim().startsWith(`${anchor.pid} `));
  assert.deepEqual(left, [], "no process of the anchor's group remains");
});

test("a hangup, interrupt or quit sent to the anchor alone is handled like SIGTERM: the group gets SIGTERM and the anchor's KILL ends what ignores it", { ...PREFIX_CASE, skip: process.platform !== "linux" && "the anchor runs under dash on Linux" }, async () => {
  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT"] as const) {
    const base = mkdtempSync(join(tmpdir(), "team-command-hup-"));
    const marker = join(base, "marker"), pidFile = join(base, "pid");
    const anchor = spawn("sh", ["-c", TEAM_ANCHOR, "sh", "3", ...[endsOnTerm(marker, pidFile)].flatMap(command => [command.command, ...command.args])], { detached: true, stdio: "ignore" });
    try {
      await until("the command writes its pid", () => pidIn(pidFile) !== undefined);
      process.kill(anchor.pid!, signal);
      await until(`the command got SIGTERM after ${signal}`, () => existsSync(marker) && readFileSync(marker, "utf8") === "SIGTERM");
    } finally {
      try { process.kill(-anchor.pid!, "SIGKILL"); } catch { }
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("the anchor keeps the command's stdin and default SIGINT and SIGQUIT, passes its exit status, and a second SIGTERM starts no second sleeper", { ...PREFIX_CASE, skip: process.platform !== "linux" && "the anchor runs under dash on Linux" }, async () => {
  const report = nodeCommand([
    "const { readFileSync } = require('node:fs');",
    "let data = '';",
    "process.stdin.on('data', chunk => { data += chunk; });",
    "process.stdin.on('end', () => {",
    "  const ignored = BigInt('0x' + /SigIgn:\\s+([0-9a-f]+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]);",
    "  process.stdout.write(JSON.stringify({ data, interrupts: Number(ignored & 6n) }));",
    "  process.exit(7);",
    "});",
  ]);
  const result = await teamOperationCommand(report, tmpdir(), undefined, 30_000, RELAY, "typed input");
  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.stdout), { data: "typed input", interrupts: 0 }, result.stdout);
});

test("a second SIGTERM to the anchor starts no second sleeper", { ...PREFIX_CASE, skip: process.platform !== "linux" && "the anchor runs under dash on Linux" }, async () => {
  const anchor = spawn("sh", ["-c", TEAM_ANCHOR, "sh", "3", "sh", "-c", "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
  const group = anchor.pid!;
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    process.kill(group, "SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 300));
    process.kill(group, "SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 300));
    const sleepers = execFileSync("ps", ["-e", "-o", "pgid=,args="], { encoding: "utf8" }).split("\n").filter(line => line.trim().startsWith(`${group} `) && /sleep 3$/.test(line.trim()));
    assert.equal(sleepers.length, 1, sleepers.join("\n"));
    await until("the anchor's KILL ended the group", () => gone(group));
  } finally {
    try { process.kill(-group, "SIGKILL"); } catch { }
  }
});

test("simulated EPERM: a prefixed command the host may not signal runs to its own end, and the operation counts the stop unconfirmed", PREFIX_CASE, async t => {
  const base = mkdtempSync(join(tmpdir(), "team-command-eperm-"));
  const pidFile = join(base, "pid");
  const kill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0 && signal !== 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    const stopped = await stopRun(t, { command: "sh", args: ["-c", `echo $$ > '${pidFile}'; sleep 1`] }, base, pidFile, { command: "env", args: [] });
    t.diagnostic("the host's group signals were answered with a simulated EPERM");
    assert.ok(unconfirmed(stopped.outcome), "the operation counts the stop unconfirmed");
    assert.equal(ended(stopped.pid), true, "the command ran to its own end");
  } finally {
    process.kill = kill;
    const pid = pidIn(pidFile);
    if (pid !== undefined && pid > 1 && !gone(pid)) process.kill(pid, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test("under sudo the relayed SIGTERM ends a command that ends on it, and the operation counts the stop unconfirmed at once", SUDO_CASE, async t => {
  const base = sharedDirectory(), pidFile = join(base, "pid");
  try {
    const stopped = await stopRun(t, { command: "sh", args: ["-c", `echo $$ > '${pidFile}' || exit 1; exec sleep 30`] }, base, pidFile, SUDO);
    assert.ok(stopped.waited < STOP_GRACE_MS, `the output closed ${stopped.waited.toFixed(0)} ms after the stop`);
    assert.ok(unconfirmed(stopped.outcome), "the operation counts the stop unconfirmed");
    await until("the command run as the other account ends", () => ended(stopped.pid));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("under sudo the anchor's SIGKILL ends a command that ignores SIGTERM when the grace ends, inside the operation's bound", SUDO_CASE, async t => {
  const base = sharedDirectory(), pidFile = join(base, "pid");
  let group: number | undefined;
  try {
    const stopped = await stopRun(t, { command: "sh", args: ["-c", `trap '' TERM; echo $$ > '${pidFile}' || exit 1; while :; do sleep 1; done`] }, base, pidFile, SUDO);
    group = stopped.leader;
    assert.equal(stopped.prefixAfterOneSecond, true, "sudo still runs one second after the stop");
    assert.ok(unconfirmed(stopped.outcome), "the operation counts the stop unconfirmed");
    assert.ok(stopped.waited >= STOP_GRACE_MS - 200, `answered ${stopped.waited.toFixed(0)} ms after the stop, before the grace ended`);
    assert.ok(stopped.waited < STOP_SETTLE_MS - 1_000, `answered ${stopped.waited.toFixed(0)} ms after the stop, at the operation's bound`);
    assert.equal(gone(stopped.leader), true, "sudo ended with the command");
    await until("the command run as the other account ended", () => ended(stopped.pid));
  } finally {
    if (group !== undefined) try { execFileSync("sudo", ["-n", "-u", SUDO_ACCOUNT, "--", "kill", "-KILL", "--", `-${group}`], { stdio: "ignore", timeout: 10_000 }); } catch { }
    rmSync(base, { recursive: true, force: true });
  }
});

test("under sudo the anchor passes the relayed SIGTERM to the whole group: the first process and its child both end, and the operation answers inside its bound", SUDO_CASE, async t => {
  const base = sharedDirectory(), firstFile = join(base, "first"), pidFile = join(base, "pid");
  let group: number | undefined;
  try {
    const stopped = await stopRun(t, { command: "sh", args: ["-c", `echo $$ > '${firstFile}' || exit 1; sleep 30 & echo $! > '${pidFile}' || { kill $!; exit 1; }; wait`] }, base, pidFile, SUDO);
    group = stopped.leader;
    assert.equal(ended(pidIn(firstFile)!), true, "the relayed SIGTERM ended the first process");
    await until("the first process's child ended", () => ended(stopped.pid));
    assert.ok(unconfirmed(stopped.outcome), "the operation counts the stop unconfirmed");
    assert.ok(stopped.waited < STOP_SETTLE_MS - 1_000, `answered ${stopped.waited.toFixed(0)} ms after the stop, at the operation's bound`);
  } finally {
    if (group !== undefined) try { execFileSync("sudo", ["-n", "-u", SUDO_ACCOUNT, "--", "kill", "-KILL", "--", `-${group}`], { stdio: "ignore", timeout: 10_000 }); } catch { }
    rmSync(base, { recursive: true, force: true });
  }
});

test("under a prefix, a stop that lands before the command's turn resolves as interrupted without spawning it and without an unconfirmed-stop error", PREFIX_CASE, async () => {
  const base = mkdtempSync(join(tmpdir(), "team-command-early-"));
  const marker = join(base, "marker");
  try {
    const controller = new AbortController();
    controller.abort();
    const started: Array<number | undefined> = [];
    const scope: CommandScope = { starting: () => undefined, started: pid => { started.push(pid); } };
    const command = nodeCommand(["require('node:fs').writeFileSync(process.argv[1], 'ran');"], marker);
    const result = await commandScope.run(scope, () => teamOperationCommand(command, base, controller.signal, 60_000, RELAY));
    assert.equal(result.interrupted, true, "the command counts as interrupted");
    assert.equal(result.exitCode, null);
    assert.deepEqual(started, [undefined], "no process was started");
    assert.equal(existsSync(marker), false, "the command never ran");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
