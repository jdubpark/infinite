import type { MainCheckPorts } from "../../packages/host/src/main-check-ports.js";
import type { MainCheckRecord } from "../../packages/host/src/main-check-state.js";
import type { CensusFinding, CensusResult, ProcessRow, ProcessTable, ProcessWitness } from "../../packages/host/src/process-census.js";
import type { VolumeUsage } from "../../packages/host/src/storage.js";
import type { TeamCommand } from "../../packages/host/src/team-types.js";
import { commandScope, TeamError, type CommandResult, type CommandScope } from "../../packages/host/src/team-workspace.js";
import { bump, type Counts, type Rand } from "../outcome-sim-script.js";

/*
 * The world of the main-check simulator (tests/fixtures/main-check-sim.ts): a virtual clock, the record files, the
 * processes, Git and the configured commands, the census, removal and the gates, as ports of MainCheckService.
 * Each API process of the host is a Life. When it stops, its timers are dropped and every port it holds fails with
 * HostStopped; the processes it started run on, as detached processes do. A boot ends every process.
 * Commands behave as teamCommand does: they announce themselves to the command scope, start, and on a stop are killed
 * when their group can be signalled; an unkillable one settles as "stop unconfirmed" after forceSettleAfterMs, or never
 * without it (a Git command under a prefix the host cannot signal).
 */

export class HostStopped extends Error {}

/** One API process of the host. */
export type Life = { id: number; stopped: boolean };

type Timer = { at: number; seq: number; owner: Life | undefined; fn: () => void; dead: boolean };

/** Virtual time. A Life's timers die with it; world timers (process ends) do not. */
export class Clock {
  now: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start: number) {
    this.now = start;
  }

  set(owner: Life | undefined, fn: () => void, ms: number): Timer {
    const timer: Timer = { at: this.now + Math.max(0, ms), seq: this.seq, owner, fn, dead: false };
    this.seq += 1;
    let low = 0;
    let high = this.timers.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const other = this.timers[middle]!;
      if (other.at < timer.at || other.at === timer.at && other.seq < timer.seq) low = middle + 1;
      else high = middle;
    }
    this.timers.splice(low, 0, timer);
    return timer;
  }

  cancel(timer: Timer) {
    timer.dead = true;
  }

  drop(owner: Life) {
    for (const timer of this.timers) if (timer.owner === owner) timer.dead = true;
  }

  /** The next live timer due at or before `until`, removed from the queue. */
  take(until: number): Timer | undefined {
    while (this.timers.length > 0 && this.timers[0]!.dead) this.timers.shift();
    const first = this.timers[0];
    if (first === undefined || first.at > until) return undefined;
    this.timers.shift();
    return first;
  }
}

/** How a head's check goes. `at` is a command position, taken modulo the plan's length. */
export type Nature =
  | { kind: "pass" }
  | { kind: "slow" }
  | { kind: "fail"; at: number }
  | { kind: "flaky" }
  | { kind: "hang"; at: number }
  | { kind: "stuck"; at: number }
  | { kind: "dirty"; at: number; heal: boolean }
  | { kind: "unavailable"; at: number }
  | { kind: "prep-fail" }
  | { kind: "prep-hang" }
  | { kind: "wrong-head" };

/** A run directory the main check prepared. `dirtied` is set when the copy was changed at the end of any command. */
export type WorldRun = {
  path: string;
  projectId: string;
  head: string;
  nature: Nature;
  life: number;
  at: number;
  flakyAt: number;
  copyHead?: string;
  dirty: boolean;
  dirtied: boolean;
  commandIndex: number;
  exists: boolean;
};

type Behavior =
  | { end: "exit"; code: number; duration: number; dirty?: boolean; heal?: boolean; output?: string; child?: boolean }
  | { end: "never"; killable: boolean }
  | { end: "unavailable" };

type Proc = {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  start: string;
  run: string;
  hidden: boolean;
  killable: boolean;
  /** No natural end: only a stop, an outside kill or a boot ends it. */
  forever: boolean;
  exitCode: number | null;
  children: Proc[];
  onExit?: () => void;
};

export type Faults = {
  census: "clean" | "fail" | "finds" | "flaky";
  removal: "ok" | "fail" | "flaky";
  storage: "ok" | "low" | "fail";
  load: "clear" | "held" | "throw";
  halt: { host: boolean; projects: Set<string>; throws: boolean };
};
export const clearFaults = (): Faults => ({ census: "clean", removal: "ok", storage: "ok", load: "clear", halt: { host: false, projects: new Set(), throws: false } });

/** What the simulator learns from the world, and what it decides for it. */
export interface WorldHooks {
  write(projectId: string, record: MainCheckRecord): void;
  census(directory: string, witness: ProcessWitness, result: CensusResult): void;
  remove(directory: string): void;
  /** Checks the names R5 fixes and returns the project the mirror belongs to. */
  prepare(mirror: string, head: string, root: string, directoryName: string, branch: string, teamwork: boolean): string;
  /** Checks the arguments R5 fixes for a configured command. */
  command(run: WorldRun, command: TeamCommand, timeoutMs: number | undefined, forceSettleAfterMs: number | undefined): void;
  natureOf(projectId: string, head: string): { nature: Nature; planLength: number };
  otherHead(projectId: string, head: string): string;
}

const GIT_MS: readonly [number, number] = [20, 250];
const FAILURE_OUTPUT = "✖ the suite failed: expected 1, received 2\n    at check (src/check.ts:12:3)\n";
const inside = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

export function hex(r: Rand, length: number): string {
  return Array.from({ length }, () => r.int(0, 15).toString(16)).join("");
}

function uuid(r: Rand): string {
  const text = hex(r, 32);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-a${text.slice(17, 20)}-${text.slice(20, 32)}`;
}

/** Wraps every port: once `life` stopped, a call reaches nothing and fails with HostStopped. */
export function guard<T extends object>(life: Life, target: T, counts: Counts, path = ""): T {
  return new Proxy(target, {
    get: (object, key) => {
      const value: unknown = Reflect.get(object, key);
      const name = `${path}${String(key)}`;
      if (typeof value === "object" && value !== null) return guard(life, value, counts, `${name}.`);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!life.stopped) return value.apply(object, args);
        bump(counts, `after-stop:${name}`);
        const error = new HostStopped(`The host stopped before ${name}.`);
        if (value.constructor.name === "AsyncFunction") return Promise.reject(error);
        throw error;
      };
    },
  });
}

export class World {
  boot = "boot-1";
  faults: Faults = clearFaults();
  readonly records = new Map<string, string>();
  readonly runs = new Map<string, WorldRun>();
  readonly processes = new Map<number, Proc>();
  private boots = 1;
  private nextPid = 2000;

  constructor(readonly clock: Clock, private readonly r: Rand, private readonly counts: Counts, private readonly hooks: WorldHooks) {}

  ports(life: Life): MainCheckPorts {
    return {
      now: () => this.clock.now,
      setTimer: (callback, ms) => this.clock.set(life, callback, ms),
      clearTimer: timer => this.clock.cancel(timer as Timer),
      records: {
        list: () => [...this.records.keys()],
        read: projectId => {
          const text = this.records.get(projectId);
          return text === undefined ? undefined : JSON.parse(text) as unknown;
        },
        write: (projectId, record) => this.hooks.write(projectId, record),
      },
      prepareWorkspace: async (mirror, head, root, directoryName, branch, _prefix, signal, teamwork) => this.prepare(life, mirror, head, root, directoryName, branch, signal, teamwork),
      prepareVerification: async (workspace, id, baseCommit, _prefix, signal) => this.verification(life, workspace, id, baseCommit, signal),
      run: async (command, cwd, signal, timeoutMs, _prefix, _input, _env, forceSettleAfterMs, onOutput) => this.configured(life, command, cwd, signal, timeoutMs, forceSettleAfterMs, onOutput),
      assertClean: async (cwd, base, _prefix, signal) => this.assertClean(life, cwd, base, signal),
      processes: {
        table: async () => this.table(),
        start: async pid => this.processes.get(pid)?.start,
        census: async (witness, directory) => this.census(witness, directory),
      },
      remove: async runDirectory => this.remove(runDirectory),
      halt: { check: input => this.haltCheck(input.projectId) },
      hostLoad: { held: () => this.held() },
      storage: async root => this.storage(root),
      bootId: () => this.boot,
      randomHex: length => hex(this.r, length),
      uuid: () => uuid(this.r),
    };
  }

  // ---- Processes -------------------------------------------------------------------------------------------------

  private spawn(run: WorldRun, killable: boolean, forever: boolean): Proc {
    const pid = this.nextPid;
    this.nextPid += 1;
    const proc: Proc = { pid, ppid: 1, pgid: pid, sid: pid, start: `${this.boot}:${pid}`, run: run.path, hidden: this.r.chance(0.35), killable, forever, exitCode: null, children: [] };
    this.processes.set(pid, proc);
    return proc;
  }

  /** A child in its parent's group and session that may outlive it. */
  private spawnChild(parent: Proc) {
    const pid = this.nextPid;
    this.nextPid += 1;
    const child: Proc = { ...parent, pid, ppid: parent.pid, start: `${this.boot}:${pid}`, hidden: this.r.chance(0.35), forever: this.r.chance(0.15), children: [], onExit: undefined };
    this.processes.set(pid, child);
    parent.children.push(child);
  }

  private exit(proc: Proc, code: number | null) {
    if (!this.processes.has(proc.pid)) return;
    this.processes.delete(proc.pid);
    proc.exitCode = code;
    for (const child of proc.children) {
      if (!this.processes.has(child.pid) || child.forever) continue;
      child.ppid = 1;
      this.clock.set(undefined, () => this.exit(child, 0), this.r.int(500, 40_000));
    }
    proc.onExit?.();
  }

  private killGroup(pgid: number) {
    for (const proc of [...this.processes.values()]) if (proc.pgid === pgid && proc.killable) this.exit(proc, null);
  }

  /** An outside kill of every process that would never end, less those of `except` (a run directory). */
  endStuck(except?: string): number {
    let ended = 0;
    for (const proc of [...this.processes.values()]) {
      if (!proc.forever || proc.run === except) continue;
      this.exit(proc, null);
      ended += 1;
    }
    return ended;
  }

  /** The host boots again: no process outlives a boot. */
  reboot() {
    this.boots += 1;
    this.boot = `boot-${this.boots}`;
    for (const proc of [...this.processes.values()]) this.exit(proc, null);
  }

  private table(): ProcessTable {
    const rows: ProcessRow[] = [...this.processes.values()].map(proc => ({ pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, sid: proc.sid, uid: 1000, start: proc.start, command: "check" }));
    return { boot: this.boot, rows };
  }

  // ---- Commands --------------------------------------------------------------------------------------------------

  private runAt(cwd: string): WorldRun {
    for (const run of this.runs.values()) if (run.exists && inside(cwd, run.path)) return run;
    throw new TeamError(409, "invalid-workspace", "No prepared copy holds this directory.");
  }

  /** teamCommand's shape: the scope hears of the command before it starts, and of its pid right after. */
  private command(life: Life, run: WorldRun, behavior: Behavior, signal: AbortSignal | undefined, timeoutMs: number, forceSettleAfterMs: number | undefined, onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void): Promise<CommandResult> {
    const scope = commandScope.getStore();
    const ready = scope?.starting();
    const start = () => this.start(life, scope, run, behavior, signal, timeoutMs, forceSettleAfterMs, onOutput);
    return ready ? ready.then(start) : start();
  }

  private start(life: Life, scope: CommandScope | undefined, run: WorldRun, behavior: Behavior, signal: AbortSignal | undefined, timeoutMs: number, forceSettleAfterMs: number | undefined, onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void): Promise<CommandResult> {
    // The host process ended right after a write: the command it was about to start never starts.
    if (life.stopped) return new Promise<CommandResult>(() => undefined);
    if (behavior.end === "unavailable") {
      scope?.started(undefined);
      return Promise.reject(new TeamError(409, "command-unavailable", "A configured team command could not be started."));
    }
    const proc = this.spawn(run, behavior.end === "exit" || behavior.killable, behavior.end === "never");
    if (behavior.end === "exit" && behavior.child) this.spawnChild(proc);
    scope?.started(proc.pid);
    return new Promise<CommandResult>((resolve, reject) => {
      let settled = false;
      let interrupted = false;
      let stopRequested = false;
      const timers: Timer[] = [];
      let output = "";
      const done = () => {
        settled = true;
        for (const timer of timers) this.clock.cancel(timer);
        signal?.removeEventListener("abort", stop);
        proc.onExit = undefined;
      };
      const stop = () => {
        // A host that stopped signals nothing.
        if (life.stopped || stopRequested || settled) return;
        stopRequested = true;
        interrupted = true;
        if (proc.killable) {
          this.killGroup(proc.pgid);
          return;
        }
        if (forceSettleAfterMs === undefined) return;
        timers.push(this.clock.set(life, () => {
          if (settled) return;
          done();
          reject(new TeamError(409, "command-stop-unconfirmed", "A configured team command did not close after the host tried to stop it."));
        }, forceSettleAfterMs));
      };
      proc.onExit = () => {
        if (settled) return;
        done();
        resolve({ exitCode: proc.exitCode, output, stdout: output, interrupted, truncated: false });
      };
      timers.push(this.clock.set(life, stop, timeoutMs));
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      if (behavior.end !== "exit" || settled) return;
      this.clock.set(undefined, () => {
        if (!this.processes.has(proc.pid)) return;
        if (behavior.output) {
          output += behavior.output;
          onOutput?.(Buffer.from(behavior.output), "stdout");
        }
        if (behavior.dirty) run.dirty = true;
        if (behavior.heal) run.dirty = false;
        if (run.dirty) run.dirtied = true;
        this.exit(proc, behavior.code);
      }, behavior.duration);
    });
  }

  private git(life: Life, run: WorldRun, signal: AbortSignal | undefined, behavior: Behavior = { end: "exit", code: 0, duration: this.r.int(...GIT_MS) }) {
    return this.command(life, run, behavior, signal, 30_000, undefined);
  }

  private async prepare(life: Life, mirror: string, head: string, root: string, directoryName: string, branch: string, signal: AbortSignal, teamwork: boolean) {
    const projectId = this.hooks.prepare(mirror, head, root, directoryName, branch, teamwork);
    const path = `${root}/${directoryName}`;
    if (this.runs.get(path)?.exists) throw new TeamError(409, "workspace-exists", "This team workspace already exists and needs explicit reconciliation.");
    const { nature, planLength } = this.hooks.natureOf(projectId, head);
    const at = "at" in nature ? nature.at % planLength : 0;
    const flakyAt = nature.kind === "flaky" && this.r.chance(0.5) ? this.r.int(0, planLength - 1) : -1;
    const run: WorldRun = { path, projectId, head, nature, life: life.id, at, flakyAt, dirty: false, dirtied: false, commandIndex: 0, exists: true };
    this.runs.set(path, run);
    bump(this.counts, `nature:${nature.kind}`);
    for (const step of ["clone", "remote", "cat-file", "checkout"]) {
      const hangs = step === "clone" && nature.kind === "prep-hang";
      const fails = step === "cat-file" && nature.kind === "prep-fail";
      const behavior: Behavior = hangs ? { end: "never", killable: false } : { end: "exit", code: fails ? 128 : 0, duration: this.r.int(...GIT_MS) };
      const result = await this.git(life, run, signal, behavior);
      if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
    }
    return { workspace: `${path}/integration`, baseCommit: head };
  }

  private async verification(life: Life, workspace: string, id: string, baseCommit: string, signal: AbortSignal | undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new TeamError(409, "invalid-workspace", "A copied workspace needs a path-safe identity.");
    const run = this.runAt(workspace);
    for (let step = 0; step < 3; step += 1) {
      const result = await this.git(life, run, signal);
      if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
    }
    run.copyHead = run.nature.kind === "wrong-head" ? this.hooks.otherHead(run.projectId, baseCommit) : baseCommit;
    return { workspace: `${run.path}/verification/${id}`, baseCommit: run.copyHead };
  }

  private behaviorOf(run: WorldRun, index: number): Behavior {
    const nature = run.nature;
    const duration = nature.kind === "slow" ? this.r.int(15_000, 45_000) : this.r.int(300, 6_000);
    const child = this.r.chance(0.3);
    const failing: Behavior = { end: "exit", code: this.r.int(1, 2), duration, output: FAILURE_OUTPUT, child };
    if (nature.kind === "fail" && index === run.at) return failing;
    if (nature.kind === "flaky" && index === run.flakyAt) return failing;
    if (nature.kind === "hang" && index === run.at) return { end: "never", killable: true };
    if (nature.kind === "stuck" && index === run.at) return { end: "never", killable: false };
    if (nature.kind === "unavailable" && index === run.at) return { end: "unavailable" };
    if (nature.kind === "dirty" && index === run.at) return { ...failing, code: this.r.chance(0.7) ? 0 : 1, dirty: true };
    if (nature.kind === "dirty" && nature.heal && index === run.at + 1) return { end: "exit", code: 0, duration, heal: true, child };
    return { end: "exit", code: 0, duration, child };
  }

  private async configured(life: Life, command: TeamCommand, cwd: string, signal: AbortSignal | undefined, timeoutMs: number | undefined, forceSettleAfterMs: number | undefined, onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void) {
    const run = this.runAt(cwd);
    this.hooks.command(run, command, timeoutMs, forceSettleAfterMs);
    const behavior = this.behaviorOf(run, run.commandIndex);
    run.commandIndex += 1;
    return this.command(life, run, behavior, signal, timeoutMs ?? 600_000, forceSettleAfterMs, onOutput);
  }

  private async assertClean(life: Life, cwd: string, base: string, signal: AbortSignal | undefined) {
    const run = this.runAt(cwd);
    for (let step = 0; step < 3; step += 1) {
      const result = await this.git(life, run, signal);
      if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
    }
    if (run.copyHead !== base || run.dirty) throw new TeamError(409, "verification-changed-files", "The verification workspace is not read-only.");
  }

  // ---- Census, removal and gates ---------------------------------------------------------------------------------

  private census(witness: ProcessWitness, directory: string): CensusResult {
    const mode = this.faults.census;
    const roll = mode === "flaky" ? this.r.int(0, 4) : -1;
    const kind = this.runs.has(directory) ? "run" : "root";
    let result: CensusResult;
    if (mode === "fail" || roll === 0) result = { ok: false, problem: "simulated census failure" };
    else {
      const findings: CensusFinding[] = [];
      for (const proc of this.processes.values()) {
        const recorded = witness.boot === this.boot && (witness.processes.some(item => item.pid === proc.pid && item.start === proc.start) || witness.groups.includes(proc.pgid) || witness.sessions.includes(proc.sid));
        if (recorded) findings.push({ pid: proc.pid, reason: "recorded-group" });
        else if (!proc.hidden && inside(proc.run, directory)) findings.push({ pid: proc.pid, reason: "working-directory" });
      }
      // A process that is no part of the check, such as an editor, holding a file below the directory.
      if (mode === "finds" || roll === 1) findings.push({ pid: 1, reason: "open-file" });
      result = { ok: true, findings };
    }
    bump(this.counts, `census:${kind}:${!result.ok ? "fail" : result.findings.length > 0 ? "finds" : "clean"}`);
    this.hooks.census(directory, witness, result);
    return result;
  }

  private remove(runDirectory: string) {
    this.hooks.remove(runDirectory);
    const mode = this.faults.removal;
    if (mode === "fail" || mode === "flaky" && this.r.chance(0.4)) {
      bump(this.counts, "removal:fail");
      throw new TeamError(409, "workspace-removal-failed", "The team workspace could not be removed completely.");
    }
    const run = this.runs.get(runDirectory);
    if (run) run.exists = false;
    bump(this.counts, "removal:ok");
  }

  private haltCheck(projectId: string): { state: string } {
    const halt = this.faults.halt;
    if (halt.throws) throw new Error("The halt record could not be read.");
    return halt.host || halt.projects.has(projectId) ? { state: "halted" } : { state: "clear" };
  }

  private held(): string | undefined {
    if (this.faults.load === "throw") throw new Error("The host load could not be read.");
    return this.faults.load === "held" ? "Waiting for host capacity: simulated." : undefined;
  }

  private storage(root: string): VolumeUsage {
    if (this.faults.storage === "fail") throw new Error("The volume could not be measured.");
    const available = this.faults.storage === "low" ? 1 : 500 * 1024 ** 3;
    return { path: root, totalBytes: 1024 ** 4, availableBytes: available, totalInodes: 100_000_000, availableInodes: 50_000_000 };
  }
}
