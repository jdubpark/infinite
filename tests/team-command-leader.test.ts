import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandScope, EXIT_DRAIN_MS, TeamError, teamCommand, teamHead, type CommandResult, type CommandScope } from "../packages/host/src/team-workspace.js";

/*
 * The leader rule on real processes (INF-388, INF-393). Every team command ends with its leader: once the process the
 * host started exits, the command settles when its pipes close or a drain later, marked `leftover` and `truncated`
 * when they did not close, and nothing is signalled after that exit. A stop while the leader runs still kills its group.
 */

const CASE = { timeout: 20_000, skip: process.platform === "win32" && "process groups are POSIX" };
const WAIT_MS = 10_000;
type Command = { command: string; args: string[] };
/** The leader writes its pid, starts a background sleep in its own group that holds its pipes, writes the sleep's pid, and exits 3 at once. */
const leaves = (leader: string, left: string): Command => ({ command: "sh", args: ["-c", `echo $$ > '${leader}'; sleep 30 & echo $! > '${left}'; exit 3`] });
/** The same, but the leader waits for the sleep. */
const waits = (leader: string, left: string): Command => ({ command: "sh", args: ["-c", `echo $$ > '${leader}'; sleep 30 & echo $! > '${left}'; wait`] });
/** The leader starts a child in a session and group of its own that holds the leader's pipes, then exits 0. */
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

async function until(what: string, ready: () => boolean) {
  const deadline = Date.now() + WAIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`${what} within ${WAIT_MS} ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function pidIn(file: string): number | undefined {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return text.endsWith("\n") ? Number.parseInt(text, 10) : undefined;
}

/** One command, outside any scope unless one is given. Ends what the command left behind when the test is done. */
class Run {
  readonly base = mkdtempSync(join(tmpdir(), "team-command-leader-"));
  readonly leaderFile = join(this.base, "leader");
  readonly leftFile = join(this.base, "left");
  readonly controller = new AbortController();
  settledAt?: number;

  start(command: (leader: string, left: string) => Command, scope?: CommandScope): Promise<CommandResult> {
    const run = () => teamCommand(command(this.leaderFile, this.leftFile), this.base, this.controller.signal, 60_000);
    return (scope ? commandScope.run(scope, run) : run()).finally(() => { this.settledAt = performance.now(); });
  }

  /** The process the leader left, once its pid is written. */
  async left(): Promise<number> {
    await until("the leader writes the pid of what it leaves", () => pidIn(this.leftFile) !== undefined);
    return pidIn(this.leftFile)!;
  }

  /** Node reaps the leader as it emits `exit`, so a reaped leader means the runner heard its exit. */
  async leaderExited() {
    await until("the leader is reaped", () => { const leader = pidIn(this.leaderFile); return leader !== undefined && gone(leader); });
  }

  dispose() {
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
    // Two pipes: their chunks arrive in either order.
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

test("a leftover that left the leader's group and session is neither waited for nor signalled", CASE, async () => {
  const run = new Run();
  try {
    const result = run.start(escapes);
    const child = await run.left();
    await run.leaderExited();
    assert.equal(run.settledAt, undefined, "the drain is still pending when the stop comes");
    const stoppedAt = performance.now();
    run.controller.abort();
    const settled = await result;
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

test("a stop inside the drain settles at once and signals nothing", CASE, async () => {
  const run = new Run();
  try {
    const result = run.start(leaves);
    const sleep = await run.left();
    await run.leaderExited();
    assert.equal(run.settledAt, undefined, "the drain is still pending when the stop comes");
    const stoppedAt = performance.now();
    run.controller.abort();
    const settled = await result;
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
    await until("the sleep in the leader's group ends", () => gone(sleep));
  } finally {
    run.dispose();
  }
});

test("a command inside a scope that records it ends with its leader the same way", CASE, async () => {
  const run = new Run();
  let recorded: number | undefined;
  try {
    const result = run.start(leaves, { starting: () => undefined, started: pid => { recorded = pid; } });
    const sleep = await run.left();
    await run.leaderExited();
    assert.equal(recorded, pidIn(run.leaderFile), "the scope recorded the leader");
    assert.equal(run.settledAt, undefined, "the drain is still pending when the stop comes");
    run.controller.abort();
    const settled = await result;
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
    // A launcher that leaves a sleep holding the output, then runs Git as the leader.
    const launcher = join(base, "launcher.sh");
    writeFileSync(launcher, `sleep 30 &\necho $! > '${leftFile}'\nexec "$@"\n`);
    const started = performance.now();
    await assert.rejects(teamHead(base, { command: "/bin/sh", args: [launcher] }),
      (error: unknown) => error instanceof TeamError && error.code === "workspace-operation-failed");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < EXIT_DRAIN_MS + 2_000, `refused ${elapsed.toFixed(0)} ms after the start, not at the 30 s limit`);
    await until("the launcher writes the pid of its sleep", () => pidIn(leftFile) !== undefined);
    assert.equal(gone(pidIn(leftFile)!), false, "the sleep the launcher left still runs");
  } finally {
    const left = pidIn(leftFile);
    if (left !== undefined && Number.isSafeInteger(left) && left > 1 && !gone(left)) process.kill(left, "SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test("a command with no leftover keeps its whole output when the event loop stalls past the drain as its last output arrives", CASE, async t => {
  // Small enough to fit the pipe, so the leader writes it all and exits while the host stalls.
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index} ${"x".repeat(40)}`);
  const expected = lines.map(line => `${line}\n`).join("");
  const script = "for (const line of JSON.parse(process.argv[1])) process.stdout.write(line + '\\n'); process.stderr.write('done\\n');";
  let leader: number | undefined, exitedFirst = false;
  const stalled = new Set<"stdout" | "stderr">();
  // The loop stalls at the first chunk of each pipe: the leader exits during the first stall, and the second may come after
  // its exit was heard. When Node has already reaped the leader then, the drain runs out during the second stall.
  const stall = (_chunk: Buffer, stream: "stdout" | "stderr") => {
    if (stalled.has(stream)) return;
    stalled.add(stream);
    if (stream === "stderr") exitedFirst = leader !== undefined && gone(leader);
    const until = performance.now() + EXIT_DRAIN_MS + 500;
    while (performance.now() < until) { /* The host's event loop is blocked. */ }
  };
  const scope: CommandScope = { starting: () => undefined, started: pid => { leader = pid; } };
  const result = await commandScope.run(scope, () => teamCommand({ command: process.execPath, args: ["-e", script, JSON.stringify(lines)] }, tmpdir(), undefined, 60_000,
    undefined, undefined, undefined, undefined, stall));
  t.diagnostic(`leader exit heard before the stall: ${exitedFirst}`);
  assert.equal(stalled.size, 2, "the observer stalled the loop at both pipes");
  assert.equal(result.exitCode, 0);
  assert.equal(result.leftover, false, "nothing held the output");
  assert.equal(result.truncated, false, "a stalled loop did not cut a clean command");
  assert.equal(result.stdout, expected);
  assert.ok(result.output.includes("done\n"));
});
