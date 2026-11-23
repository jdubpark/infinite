import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandScope, EXIT_DRAIN_MS, teamCommand, type CommandResult, type CommandScope } from "../packages/host/src/team-workspace.js";

/*
 * `CommandScope.endsWithLeader` on real processes (INF-388): a command whose leader exited settles without a signal,
 * marked truncated since its output never closed, so a process it left in its group lives on. Without the flag a
 * command settles only when its pipes close, and a stop kills the whole group: the team behaviour, pinned here.
 */

const CASE = { timeout: 20_000, skip: process.platform === "win32" && "process groups are POSIX" };
const WAIT_MS = 10_000;
/** The leader starts a background sleep that holds its pipes, writes the sleep's pid, and exits 0 at once. */
const leaves = (pidFile: string) => ({ command: "sh", args: ["-c", `sleep 30 & echo $! > '${pidFile}'; exit 0`] });
/** The same, but the leader waits for the sleep. */
const waits = (pidFile: string) => ({ command: "sh", args: ["-c", `sleep 30 & echo $! > '${pidFile}'; wait`] });

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
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** One command under a scope that records the leader's pid, with the flag or without it. */
class Run {
  readonly base = mkdtempSync(join(tmpdir(), "team-command-leader-"));
  readonly pidFile = join(this.base, "pid");
  readonly controller = new AbortController();
  leader?: number;
  settledAt?: number;
  result?: Promise<CommandResult>;

  start(command: (pidFile: string) => { command: string; args: string[] }, endsWithLeader: boolean) {
    const scope: CommandScope = {
      starting: () => undefined,
      started: pid => { this.leader = pid; },
      ...(endsWithLeader ? { endsWithLeader: true as const } : {}),
    };
    this.result = commandScope.run(scope, () => teamCommand(command(this.pidFile), this.base, this.controller.signal, 60_000))
      .finally(() => { this.settledAt = performance.now(); });
    return this.result;
  }

  /** The background sleep, once the leader wrote its pid. */
  async left(): Promise<number> {
    await until("the leader writes the pid of its sleep", () => existsSync(this.pidFile) && readFileSync(this.pidFile, "utf8").endsWith("\n"));
    return Number.parseInt(readFileSync(this.pidFile, "utf8"), 10);
  }

  /** Node reaps the leader as it emits `exit`, so a reaped leader means the runner heard its exit. */
  async leaderExited() {
    await until("the leader is reaped", () => this.leader !== undefined && gone(this.leader));
  }

  dispose() {
    if (existsSync(this.pidFile)) {
      const pid = Number.parseInt(readFileSync(this.pidFile, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 1 && !gone(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(this.base, { recursive: true, force: true });
  }
}

test("with endsWithLeader, a command whose output closes at its exit settles on the close, whole and not truncated", CASE, async () => {
  const run = new Run();
  try {
    const started = performance.now();
    const result = await run.start(() => ({ command: "sh", args: ["-c", "echo whole; echo also >&2; exit 4"] }), true);
    const elapsed = run.settledAt! - started;
    assert.equal(result.exitCode, 4);
    assert.equal(result.interrupted, false);
    assert.equal(result.truncated, false, "the output closed");
    assert.equal(result.stdout, "whole\n");
    // Two pipes: their chunks arrive in either order.
    assert.deepEqual(result.output.split("\n").filter(Boolean).sort(), ["also", "whole"]);
    assert.ok(elapsed < EXIT_DRAIN_MS, `settled ${elapsed.toFixed(0)} ms after the start: it waited out the drain`);
  } finally {
    run.dispose();
  }
});

test("with endsWithLeader, a command whose leader exited settles a drain later with its exit code, and its leftover lives", CASE, async () => {
  const run = new Run();
  try {
    const started = performance.now();
    const result = await run.start(leaves, true);
    const sleep = await run.left();
    const elapsed = run.settledAt! - started;
    assert.equal(result.exitCode, 0);
    assert.equal(result.interrupted, false);
    assert.equal(result.truncated, true, "the output never closed");
    assert.ok(elapsed >= EXIT_DRAIN_MS, `settled ${elapsed.toFixed(0)} ms after the start, before the drain ended`);
    assert.ok(elapsed < EXIT_DRAIN_MS + 4_000, `settled ${elapsed.toFixed(0)} ms after the start: it waited for the pipes`);
    assert.equal(gone(sleep), false, "the leftover sleep runs");
  } finally {
    run.dispose();
  }
});

test("with endsWithLeader, a stop inside the drain settles at once and signals nothing", CASE, async () => {
  const run = new Run();
  try {
    const result = run.start(leaves, true);
    const sleep = await run.left();
    await run.leaderExited();
    assert.equal(run.settledAt, undefined, "the drain is still pending when the stop comes");
    const stoppedAt = performance.now();
    run.controller.abort();
    const settled = await result;
    const waited = run.settledAt! - stoppedAt;
    assert.ok(waited >= 0 && waited < 250, `settled ${waited.toFixed(0)} ms after the stop`);
    assert.equal(settled.exitCode, 0);
    assert.equal(settled.interrupted, false);
    assert.equal(settled.truncated, true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(gone(sleep), false, "the leftover sleep still runs half a second after the stop");
  } finally {
    run.dispose();
  }
});

test("with endsWithLeader, a stop while the leader runs kills its group as before", CASE, async () => {
  const run = new Run();
  try {
    const result = run.start(waits, true);
    const sleep = await run.left();
    assert.equal(gone(run.leader!), false, "the leader waits for its sleep");
    run.controller.abort();
    const settled = await result;
    assert.equal(settled.interrupted, true);
    await until("the sleep in the leader's group ends", () => gone(sleep));
  } finally {
    run.dispose();
  }
});

test("without endsWithLeader, a stop after the leader's exit kills the group that still holds the pipes", CASE, async () => {
  const run = new Run();
  try {
    const result = run.start(leaves, false);
    const sleep = await run.left();
    await run.leaderExited();
    await new Promise(resolve => setTimeout(resolve, EXIT_DRAIN_MS + 200));
    assert.equal(run.settledAt, undefined, "the command waits for its pipes past the drain");
    run.controller.abort();
    const settled = await result;
    assert.equal(settled.interrupted, true);
    await until("the sleep in the leader's group ends", () => gone(sleep));
  } finally {
    run.dispose();
  }
});
