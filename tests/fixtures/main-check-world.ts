import type { MainCheckPorts } from "../../packages/host/src/main-check-ports.js";
import type { MainCheckRecord } from "../../packages/host/src/main-check-state.js";
import { excuseEarlier, type CensusFinding, type CensusResult, type EarlierProcesses, type ProcessRow, type ProcessTable, type ProcessWitness } from "../../packages/host/src/process-census.js";
import type { VolumeUsage } from "../../packages/host/src/storage.js";
import type { TeamCommand } from "../../packages/host/src/team-types.js";
import { commandScope, EXIT_DRAIN_MS, TeamError, type CommandResult, type CommandScope } from "../../packages/host/src/team-workspace.js";
import { bump, type Counts, type Rand } from "../outcome-sim-script.js";

export class HostStopped extends Error {}

export type Life = { id: number; stopped: boolean };

type Timer = { at: number; seq: number; owner: Life | undefined; fn: () => void; dead: boolean };

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

  take(until: number): Timer | undefined {
    while (this.timers.length > 0 && this.timers[0]!.dead) this.timers.shift();
    const first = this.timers[0];
    if (first === undefined || first.at > until) return undefined;
    this.timers.shift();
    return first;
  }
}

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
  uninspectable: boolean;
  killable: boolean;
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

export interface WorldHooks {
  write(projectId: string, record: MainCheckRecord): void;
  census(directory: string, witness: ProcessWitness, result: CensusResult): void;
  remove(directory: string): void;
  prepare(mirror: string, head: string, root: string, directoryName: string, branch: string, teamwork: boolean): string;
  command(run: WorldRun, command: TeamCommand, timeoutMs: number | undefined, forceSettleAfterMs: number | undefined): void;
  limit(run: WorldRun, at: number): void;
  natureOf(projectId: string, head: string): { nature: Nature; planLength: number };
  otherHead(projectId: string, head: string): string;
}

const GIT_MS: readonly [number, number] = [20, 250];
const ESCAPE_CHANCE = 0.15;
const ESCAPER_MS: readonly [number, number] = [1_000, 180_000];
const ARRIVAL_MS: readonly [number, number] = [20_000, 120_000];
const FAILURE_OUTPUT = "✖ the suite failed: expected 1, received 2\n    at check (src/check.ts:12:3)\n";
const inside = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

export function hex(r: Rand, length: number): string {
  return Array.from({ length }, () => r.int(0, 15).toString(16)).join("");
}

function uuid(r: Rand): string {
  const text = hex(r, 32);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-a${text.slice(17, 20)}-${text.slice(20, 32)}`;
}

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
  readonly anchors = new Map<string, { projectId: string; text: string }>();
  private boots = 1;
  private nextPid = 2000;
  private reused = 0;
  private arrivals = true;
  private readonly freed: number[] = [];

  constructor(readonly clock: Clock, private readonly r: Rand, private readonly counts: Counts, private readonly hooks: WorldHooks, private readonly ambient?: Rand) {
    if (!ambient) return;
    this.residents();
    this.arrive();
  }

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
        census: async (witness, directory, _prefix, earlier) => this.census(witness, directory, earlier),
      },
      anchors: {
        list: () => [...this.anchors.keys()],
        read: (projectId, directory) => {
          const stored = this.anchors.get(directory);
          if (stored === undefined) return undefined;
          if (stored.projectId !== projectId) throw new Error("The anchor was sealed for another project.");
          return JSON.parse(stored.text) as unknown;
        },
        write: (projectId, directory, anchor) => {
          this.anchors.set(directory, { projectId, text: JSON.stringify(anchor) });
        },
        remove: directory => {
          this.anchors.delete(directory);
        },
      },
      remove: async runDirectory => this.remove(runDirectory),
      halt: { check: input => this.haltCheck(input.projectId) },
      hostLoad: { held: () => this.held() },
      storage: async root => this.storage(root),
      bootId: () => this.boot,
      platform: "linux",
      randomHex: length => hex(this.r, length),
      uuid: () => uuid(this.r),
    };
  }

  private spawn(run: WorldRun, killable: boolean, forever: boolean): Proc {
    const pid = this.nextPid;
    this.nextPid += 1;
    const proc: Proc = { pid, ppid: 1, pgid: pid, sid: pid, start: `${this.boot}:${pid}`, run: run.path, hidden: this.r.chance(0.35), uninspectable: false, killable, forever, exitCode: null, children: [] };
    this.processes.set(pid, proc);
    return proc;
  }

  private spawnChild(parent: Proc) {
    const pid = this.nextPid;
    this.nextPid += 1;
    const child: Proc = { ...parent, pid, ppid: parent.pid, start: `${this.boot}:${pid}`, hidden: this.r.chance(0.35), forever: this.r.chance(0.15), children: [], onExit: undefined };
    this.processes.set(pid, child);
    parent.children.push(child);
  }

  hide(run = "", reuse?: number): number {
    const pid = reuse !== undefined && !this.processes.has(reuse) ? reuse : this.nextPid;
    if (pid === this.nextPid) this.nextPid += 1;
    else this.reused += 1;
    const start = pid === reuse ? `${this.boot}:${pid}:${this.reused}` : `${this.boot}:${pid}`;
    this.processes.set(pid, { pid, ppid: 1, pgid: pid, sid: pid, start, run, hidden: true, uninspectable: true, killable: false, forever: false, exitCode: null, children: [] });
    return pid;
  }

  end(pid: number) {
    const proc = this.processes.get(pid);
    if (proc) this.exit(proc, 0);
  }

  stopArrivals() {
    this.arrivals = false;
  }

  private residents() {
    for (let count = this.ambient!.int(0, 3); count > 0; count -= 1) this.ambientProcess();
  }

  private arrive() {
    this.clock.set(undefined, () => {
      if (!this.arrivals) return;
      this.ambientProcess();
      this.arrive();
    }, this.ambient!.int(...ARRIVAL_MS));
  }

  private ambientProcess() {
    const a = this.ambient!;
    const pid = this.hide();
    const proc = this.processes.get(pid)!;
    bump(this.counts, "ambient:started");
    this.clock.set(undefined, () => {
      if (this.processes.get(pid) !== proc) return;
      this.exit(proc, 0);
      this.freed.push(pid);
    }, a.chance(0.7) ? a.int(1_000, 20_000) : a.int(60_000, 1_200_000));
  }

  private escape(run: WorldRun) {
    const a = this.ambient;
    if (!a || !a.chance(ESCAPE_CHANCE)) return;
    const reuse = a.chance(0.6) ? this.freed.pop() : undefined;
    const pid = this.hide(run.path, reuse);
    const proc = this.processes.get(pid)!;
    bump(this.counts, reuse === pid ? "escaper:reused-pid" : "escaper:new-pid");
    this.clock.set(undefined, () => {
      if (this.processes.get(pid) === proc) this.exit(proc, 0);
    }, a.int(...ESCAPER_MS));
  }

  private exit(proc: Proc, code: number | null) {
    if (this.processes.get(proc.pid) !== proc) return;
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

  endStuck(except?: string): number {
    let ended = 0;
    for (const proc of [...this.processes.values()]) {
      if (!proc.forever || proc.run === except) continue;
      this.exit(proc, null);
      ended += 1;
    }
    return ended;
  }

  reboot() {
    this.boots += 1;
    this.boot = `boot-${this.boots}`;
    for (const proc of [...this.processes.values()]) this.exit(proc, null);
    if (this.ambient && this.arrivals) this.residents();
  }

  private table(): ProcessTable {
    const rows: ProcessRow[] = [...this.processes.values()].map(proc => ({ pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, sid: proc.sid, uid: 1000, start: proc.start, command: "check" }));
    return { boot: this.boot, rows };
  }

  private runAt(cwd: string): WorldRun {
    for (const run of this.runs.values()) if (run.exists && inside(cwd, run.path)) return run;
    throw new TeamError(409, "invalid-workspace", "No prepared copy holds this directory.");
  }

  private command(life: Life, run: WorldRun, behavior: Behavior, signal: AbortSignal | undefined, timeoutMs: number, forceSettleAfterMs: number | undefined, onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void, limited?: (at: number) => void): Promise<CommandResult> {
    const scope = commandScope.getStore();
    const ready = scope?.starting();
    const start = () => this.start(life, scope, run, behavior, signal, timeoutMs, forceSettleAfterMs, onOutput, limited);
    return ready ? ready.then(start) : start();
  }

  private start(life: Life, scope: CommandScope | undefined, run: WorldRun, behavior: Behavior, signal: AbortSignal | undefined, timeoutMs: number, forceSettleAfterMs: number | undefined, onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void, limited?: (at: number) => void): Promise<CommandResult> {
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
      const limit = this.clock.now + timeoutMs;
      const done = () => {
        settled = true;
        for (const timer of timers) this.clock.cancel(timer);
        signal?.removeEventListener("abort", stop);
        proc.onExit = undefined;
        if (this.clock.now >= limit) limited?.(limit);
      };
      const settle = () => {
        if (settled) return;
        done();
        resolve({ exitCode: proc.exitCode, output, stdout: output, interrupted, truncated: draining, leftover: draining });
      };
      let draining = false;
      const stop = () => {
        if (life.stopped || stopRequested || settled) return;
        if (draining) {
          bump(this.counts, "command:drain-stopped");
          settle();
          return;
        }
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
        if (stopRequested || !proc.children.some(child => this.processes.has(child.pid))) {
          settle();
          return;
        }
        draining = true;
        bump(this.counts, "command:drained");
        timers.push(this.clock.set(life, settle, EXIT_DRAIN_MS));
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
    if (!life.stopped && behavior.end !== "unavailable") this.escape(run);
    return this.command(life, run, behavior, signal, timeoutMs ?? 600_000, forceSettleAfterMs, onOutput, at => this.hooks.limit(run, at));
  }

  private async assertClean(life: Life, cwd: string, base: string, signal: AbortSignal | undefined) {
    const run = this.runAt(cwd);
    for (let step = 0; step < 3; step += 1) {
      const result = await this.git(life, run, signal);
      if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
    }
    if (run.copyHead !== base || run.dirty) throw new TeamError(409, "verification-changed-files", "The verification workspace is not read-only.");
  }

  private async census(witness: ProcessWitness, directory: string, earlier?: EarlierProcesses): Promise<CensusResult> {
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
        else if (proc.uninspectable) findings.push({ pid: proc.pid, reason: "unreadable" });
        else if (!proc.hidden && inside(proc.run, directory)) findings.push({ pid: proc.pid, reason: "working-directory" });
      }
      if (mode === "finds" || roll === 1) findings.push({ pid: 1, reason: "open-file" });
      const kept = await excuseEarlier(findings, earlier, async pid => this.processes.get(pid)?.start);
      if (kept.length < findings.length) bump(this.counts, `census:${kind}:excused${earlier === "all" ? ":after-boot" : ""}`);
      result = { ok: true, findings: kept };
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
