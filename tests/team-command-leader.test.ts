import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandScope, EXIT_DRAIN_MS, TeamError, teamCommand, teamHead, type CommandResult, type CommandScope } from "../packages/host/src/team-workspace.js";

const CASE = { timeout: 20_000, skip: process.platform === "win32" && "process groups are POSIX" };
const WAIT_MS = 10_000;
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

  async left(): Promise<number> {
    await until("the leader writes the pid of what it leaves", () => pidIn(this.leftFile) !== undefined);
    return pidIn(this.leftFile)!;
  }

  async leaderExited() {
    await until("the leader is reaped", () => { const leader = pidIn(this.leaderFile); return leader !== undefined && gone(leader); });
  }

  drainEnded(t: TestContext): boolean {
    if (this.settledAt === undefined) return false;
    t.skip("the command settled at the end of the drain before the test could stop it inside the drain");
    return true;
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
    const result = run.start(escapes);
    const child = await run.left();
    await run.leaderExited();
    if (run.drainEnded(t)) return;
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

test("a stop inside the drain settles at once and signals nothing", CASE, async t => {
  const run = new Run();
  try {
    const result = run.start(leaves);
    const sleep = await run.left();
    await run.leaderExited();
    if (run.drainEnded(t)) return;
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

test("a command inside a scope that records it ends with its leader the same way", CASE, async t => {
  const run = new Run();
  let recorded: number | undefined;
  try {
    const result = run.start(leaves, { starting: () => undefined, started: pid => { recorded = pid; } });
    const sleep = await run.left();
    await run.leaderExited();
    assert.equal(recorded, pidIn(run.leaderFile), "the scope recorded the leader");
    if (run.drainEnded(t)) return;
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
