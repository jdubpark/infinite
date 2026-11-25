import { join } from "node:path";
import { defaultMainCheckPorts, type MainCheckHalt, type MainCheckHostLoad, type MainCheckPorts, type MainCheckTimer } from "./main-check-ports.js";
import { accept, admit, candidate, checksDigest, emptyRecord, entryOf, finish, hostStart, isCommit, MAX_FAILURES, mainCheckRecordSchema, mainCheckRunnable, mainCheckSetting, noticeDue, observe, PROJECT_ID, retire, setWaiting, settle, viewOf, withWitness, type CheckSummary, type MainCheckCommand, type MainCheckErrorReason, type MainCheckInterruptReason, type MainCheckRecord, type MainCheckResult, type MainCheckView, type MainCheckWaiting, type Retiring } from "./main-check-state.js";
import { extendWitness, recordCommand, type CensusResult, type ProcessWitness } from "./process-census.js";
import type { MirrorFetch } from "./project-source.js";
import { storageShortfall } from "./storage.js";
import { CheckOutputScanner, OutputTail } from "./team-check-output.js";
import { DEFAULT_STORAGE_FLOOR, type TeamCommand, type TeamProject } from "./team-types.js";
import { commandScope, TeamError, type CommandResult, type CommandScope } from "./team-workspace.js";
import type { Config, Project } from "./types.js";

export type { CheckSummary, MainCheckRecord, MainCheckResult, MainCheckView, MainCheckWaiting } from "./main-check-state.js";
export type { MainCheckPorts } from "./main-check-ports.js";

export type MainCheckNotice = { projectId: string; label: string; notice: number; outcome: "passed" | "failed"; summary: CheckSummary };
export type MainCheckOptions = {
  config: Config;
  key: Buffer;
  mirrorPath: (projectId: string) => string;
  halt: MainCheckHalt;
  hostLoad: MainCheckHostLoad;
  ports?: Partial<MainCheckPorts>;
};

const PASS_MS = 30_000;
const HALT_POLL_MS = 2_000;
const STOP_BOUND_MS = 10_000;
const NOTICE_FLIGHT_MS = 60_000;
const WITNESS_SAVE_MS = 200;
const WITNESS_SAMPLES = [250, 1_000, 5_000];
const WITNESS_SAMPLE_MS = 15_000;

type Slot = { record?: MainCheckRecord; unreadable?: true };
type Step = { phase: "setup" | "verification"; command: TeamCommand };
type StopReason = MainCheckInterruptReason;
type RunEnd =
  | { outcome: "passed" | "failed" }
  | { outcome: "interrupted"; reason: MainCheckInterruptReason }
  | { outcome: "error"; reason: MainCheckErrorReason };
type Decision = { waiting?: MainCheckWaiting; head?: string };
type Active = {
  readonly projectId: string;
  readonly directory: string;
  readonly root: string;
  readonly hex: string;
  readonly head: string;
  readonly checks: string;
  readonly startedAt: string;
  readonly plan: Step[];
  readonly teamwork: boolean;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  seenAt: string;
  witness: ProcessWitness;
  commands: MainCheckCommand[];
  inFlight: number;
  sampling: boolean;
  timers: { save?: MainCheckTimer; poll?: MainCheckTimer; limit?: MainCheckTimer; bound?: MainCheckTimer; sample?: MainCheckTimer };
  stopReason?: StopReason;
  finished: boolean;
  result?: MainCheckResult;
};

type ServicePhase =
  | { kind: "unstarted" }
  | { kind: "running"; passing: boolean; again: boolean; active?: Active; passTimer?: MainCheckTimer }
  | { kind: "closing"; done: Promise<void>; active?: Active }
  | { kind: "closed" };

const entryKey = (projectId: string, directory: string) => `${projectId}/${directory}`;
const planOf = (team: TeamProject): Step[] => structuredClone([
  ...(team.setup ? [{ phase: "setup" as const, command: team.setup }] : []),
  ...team.checks.map(command => ({ phase: "verification" as const, command })),
]);
const codeOf = (error: unknown) => error instanceof TeamError ? error.code : undefined;

export class MainCheckService {
  private readonly config: Config;
  private readonly mirrorPath: (projectId: string) => string;
  private readonly ports: MainCheckPorts;
  private readonly slots = new Map<string, Slot>();
  private readonly earlier = new Set<string>();
  private readonly tails = new Map<string, Active>();
  private readonly unwritten = new Set<Active>();
  private readonly flights = new Map<string, { notice: number; until: number }>();
  private retirement = new Map<string, "processes" | "cleanup">();
  private readonly removals = new AbortController();
  private listed = false;
  private phase: ServicePhase = { kind: "unstarted" };

  constructor(options: MainCheckOptions) {
    this.config = options.config;
    this.mirrorPath = options.mirrorPath;
    this.ports = { ...defaultMainCheckPorts(options), ...options.ports };
  }

  private isStoppingOrClosed(): boolean {
    return this.phase.kind === "closing" || this.phase.kind === "closed";
  }

  private activeRun(): Active | undefined {
    return this.phase.kind === "running" || this.phase.kind === "closing" ? this.phase.active : undefined;
  }

  async start(): Promise<void> {
    if (this.phase.kind !== "unstarted") return;
    this.phase = { kind: "running", passing: false, again: false };
    this.loadAll();
    this.schedulePass();
    this.requestPass();
  }

  observe(fetch: MirrorFetch): void {
    try {
      if (this.phase.kind !== "running") return;
      const project = this.project(fetch.projectId);
      if (!this.enabled(project) || project.source?.mode !== "github") return;
      if (fetch.repository !== project.source.repository || fetch.baseBranch !== project.source.baseBranch) return;
      if (!isCommit(fetch.head) || Number.isNaN(Date.parse(fetch.fetchedAt))) return;
      const slot = this.slots.get(fetch.projectId);
      if (slot?.unreadable) return;
      const before = slot?.record ?? emptyRecord();
      const next = observe(before, fetch.head, fetch.fetchedAt);
      if (next === before || !this.commit(fetch.projectId, next)) return;
      const active = this.phase.active;
      if (active?.projectId === fetch.projectId && active.head === fetch.head) active.seenAt = fetch.fetchedAt;
      this.requestPass();
    } catch {}
  }

  notices(): MainCheckNotice[] {
    const now = this.ports.now();
    const offered: MainCheckNotice[] = [];
    for (const [projectId, slot] of this.slots) {
      const notice = this.offer(projectId, slot, now);
      if (notice) offered.push(notice);
    }
    return offered;
  }

  accepted(projectId: string, notice: number, outcome: "passed" | "failed"): void {
    if (!Number.isSafeInteger(notice) || notice < 0 || outcome !== "passed" && outcome !== "failed") return;
    if (this.flights.get(projectId)?.notice === notice) this.flights.delete(projectId);
    const record = this.slots.get(projectId)?.record;
    if (!record) return;
    const next = accept(record, notice, outcome);
    if (next !== record) this.commit(projectId, next);
  }

  view(projectId: string): MainCheckView | undefined {
    const slot = this.slots.get(projectId);
    if (slot?.unreadable) return { readable: false };
    if (!slot?.record) return undefined;
    return viewOf(slot.record, mainCheckSetting(this.project(projectId)?.team) !== undefined);
  }

  close(): Promise<void> {
    if (this.phase.kind === "closed") return Promise.resolve();
    if (this.phase.kind === "closing") return this.phase.done;
    if (this.phase.kind === "unstarted") {
      this.removals.abort();
      this.phase = { kind: "closed" };
      return Promise.resolve();
    }
    this.clear(this.phase.passTimer);
    this.removals.abort();
    const active = this.phase.active;
    let resolveClosing!: () => void;
    const done = new Promise<void>(resolve => { resolveClosing = resolve; });
    this.phase = { kind: "closing", done, ...(active ? { active } : {}) };
    void this.shutdown(active).finally(resolveClosing);
    return done;
  }

  private async shutdown(active: Active | undefined): Promise<void> {
    if (active && !active.finished) {
      this.stop(active, "host-stop");
      await active.done;
    }
    for (const unwritten of [...this.unwritten]) this.writeFinish(unwritten);
    this.phase = { kind: "closed" };
  }

  private project(projectId: string): Project | undefined {
    return this.config.projects.find(project => project.id === projectId);
  }

  private enabled(project: Project | undefined): project is Project & { team: TeamProject } {
    return project?.team !== undefined && mainCheckSetting(project.team) !== undefined && mainCheckRunnable(this.config, project);
  }

  private loadAll() {
    let ids: string[];
    try { ids = this.ports.records.list(); } catch { return; }
    this.listed = true;
    for (const projectId of ids) if (PROJECT_ID.test(projectId) && !this.slots.has(projectId)) this.load(projectId);
  }

  private load(projectId: string) {
    let value: unknown;
    try { value = this.ports.records.read(projectId); } catch { value = null; }
    if (value === undefined) {
      this.slots.delete(projectId);
      return;
    }
    const parsed = mainCheckRecordSchema.safeParse(value);
    if (!parsed.success) {
      this.slots.set(projectId, { unreadable: true });
      return;
    }
    const record = parsed.data;
    for (const entry of [...(record.retiring ?? []), ...(record.running ? [record.running] : [])]) this.earlier.add(entryKey(projectId, entry.directory));
    this.slots.set(projectId, { record });
    this.recoverRunning(projectId);
  }

  private recoverRunning(projectId: string) {
    const record = this.slots.get(projectId)?.record;
    const running = record?.running;
    if (!record || !running || this.owns(projectId, running.directory)) return;
    const team = this.project(projectId)?.team;
    const expected = team && checksDigest(team) === running.checks ? planOf(team).length : 0;
    this.commit(projectId, hostStart(record, this.iso(), expected));
  }

  private owns(projectId: string, directory: string) {
    const mine = (active: Active | undefined) => active?.projectId === projectId && active.directory === directory;
    return mine(this.activeRun()) || [...this.unwritten].some(mine);
  }

  private commit(projectId: string, next: MainCheckRecord): boolean {
    if (this.phase.kind === "closed" || !this.listed) return false;
    const slot = this.slots.get(projectId);
    if (slot?.unreadable) return false;
    const record = structuredClone(this.settled(projectId, next));
    if (slot?.record !== undefined && JSON.stringify(slot.record) === JSON.stringify(record)) return true;
    if (!mainCheckRecordSchema.safeParse(record).success) return false;
    try { this.ports.records.write(projectId, record); } catch { return false; }
    this.slots.set(projectId, { record });
    return true;
  }

  private settled(projectId: string, record: MainCheckRecord): MainCheckRecord {
    const team = this.project(projectId)?.team;
    return team ? settle(record, checksDigest(team)) : record;
  }

  private iso() { return new Date(this.ports.now()).toISOString(); }

  private timer(callback: () => void, ms: number): MainCheckTimer | undefined {
    try {
      return this.ports.setTimer(() => {
        try { callback(); } catch {}
      }, ms);
    } catch {
      return undefined;
    }
  }

  private clear(timer: MainCheckTimer | undefined) {
    if (timer === undefined) return;
    try { this.ports.clearTimer(timer); } catch {}
  }

  private schedulePass() {
    if (this.phase.kind !== "running") return;
    this.phase.passTimer = this.timer(() => {
      this.requestPass();
      this.schedulePass();
    }, PASS_MS);
  }

  private requestPass() {
    if (this.phase.kind !== "running") return;
    this.phase.again = true;
    if (this.phase.passing) return;
    this.phase.passing = true;
    void this.passes().catch(() => undefined);
  }

  private async passes() {
    try {
      while (this.phase.kind === "running" && this.phase.again) {
        this.phase.again = false;
        try { await this.pass(); } catch {}
      }
    } finally {
      if (this.phase.kind === "running") this.phase.passing = false;
    }
  }

  private async pass() {
    if (!this.listed) this.loadAll();
    for (const [projectId, slot] of [...this.slots]) if (slot.unreadable) this.load(projectId);
    for (const projectId of [...this.slots.keys()]) this.recoverRunning(projectId);
    for (const active of [...this.unwritten]) this.writeFinish(active);
    for (const active of [...this.tails.values()]) if (active.finished && !this.unwritten.has(active) && active.inFlight === 0 && active.timers.save === undefined) this.closeTail(active);
    for (const [projectId, slot] of [...this.slots]) if (slot.record) this.commit(projectId, slot.record);
    await this.retireAll();
    if (this.phase.kind === "running") await this.admitOne();
  }

  private async retireAll() {
    const status = new Map<string, "processes" | "cleanup">();
    for (const [projectId, slot] of [...this.slots]) {
      for (const entry of slot.record?.retiring ?? []) {
        if (this.isStoppingOrClosed()) return;
        const left = await this.retireEntry(projectId, entry);
        if (left === "cleanup" || left === "processes" && status.get(projectId) !== "cleanup") status.set(projectId, left);
      }
    }
    this.retirement = status;
  }

  private async retireEntry(projectId: string, entry: Retiring): Promise<"processes" | "cleanup" | undefined> {
    const directory = join(entry.root, entry.directory);
    const prefix = this.config.teams?.commandPrefix;
    let result: CensusResult;
    try { result = await this.ports.processes.census(entry.witness, directory, prefix); }
    catch (error) { result = { ok: false, problem: error instanceof Error ? error.message : "The census failed." }; }
    if (this.isStoppingOrClosed()) return "processes";
    const current = this.slots.get(projectId)?.record?.retiring?.find(item => item.directory === entry.directory);
    if (!current) return undefined;
    if (JSON.stringify(current) !== JSON.stringify(entry) || !this.removable(projectId, current, result)) return "processes";
    try { await commandScope.exit(() => this.ports.remove(directory, prefix, this.removals.signal, entry.root)); }
    catch { return "cleanup"; }
    const record = this.slots.get(projectId)?.record;
    if (record) this.commit(projectId, retire(record, entry.directory));
    return undefined;
  }

  private removable(projectId: string, entry: Retiring, result: CensusResult): boolean {
    if (!result.ok || result.findings.length > 0) return false;
    const key = entryKey(projectId, entry.directory);
    if (entry.recording && this.earlier.has(key) && entry.witness.boot === this.ports.bootId()) return false;
    return !this.tails.has(key);
  }

  private order(): string[] {
    const at = (slot: Slot) => Date.parse(slot.record?.observed?.at ?? "") || 0;
    return [...this.slots].filter(([, slot]) => slot.record).sort(([a, x], [b, y]) => at(x) - at(y) || (a < b ? -1 : 1)).map(([projectId]) => projectId);
  }

  private async admitOne() {
    for (const projectId of this.order()) {
      if (this.isStoppingOrClosed()) return;
      const decision = await this.gates(projectId);
      if (this.isStoppingOrClosed()) return;
      if (decision.head !== undefined && this.admit(projectId, decision.head)) continue;
      const record = this.slots.get(projectId)?.record;
      if (record && record.waiting !== decision.waiting) this.commit(projectId, setWaiting(record, decision.waiting));
    }
  }

  private async gates(projectId: string): Promise<Decision> {
    const record = this.slots.get(projectId)?.record;
    const project = this.project(projectId);
    const own = this.retirement.get(projectId);
    if (!record || !this.enabled(project)) return { waiting: own };
    const pick = this.pick(record, checksDigest(project.team));
    if (!pick) return { waiting: own };
    if ("waiting" in pick) return { waiting: own ?? pick.waiting };
    if (this.identityMissing()) return { waiting: "execution-identity" };
    if (!(await this.censusWorks(project))) return { waiting: "census-unavailable" };
    if (this.halted(projectId)) return { waiting: "halt" };
    if (this.loadHeld()) return { waiting: "host-load" };
    if (await this.storageLow(project)) return { waiting: "storage" };
    const busy = this.hostBusy(projectId);
    if (busy) return { waiting: busy };
    return { head: pick.head };
  }

  private pick(record: MainCheckRecord, digest: string) {
    return candidate(record, digest);
  }

  private identityMissing() {
    return !this.config.teams?.commandPrefix && Object.values(this.config.agents).some(profile => profile !== undefined && /(^|\/)sudo$/.test(profile.command));
  }

  private async censusWorks(project: Project) {
    const witness: ProcessWitness = { boot: this.ports.bootId(), processes: [], sessions: [], groups: [] };
    try {
      const result = await this.ports.processes.census(witness, this.rootOf(project), this.config.teams?.commandPrefix);
      return result.ok;
    } catch {
      return false;
    }
  }

  private halted(projectId: string): boolean {
    try { return this.ports.halt.check({ projectId }).state !== "clear"; } catch { return true; }
  }

  private loadHeld(): boolean {
    try { return this.ports.hostLoad.held() !== undefined; } catch { return true; }
  }

  private async storageLow(project: Project): Promise<boolean> {
    try {
      const usage = await this.ports.storage(this.rootOf(project));
      return storageShortfall(usage, this.config.teams?.storageFloor ?? DEFAULT_STORAGE_FLOOR) !== undefined;
    } catch {
      return true;
    }
  }

  private hostBusy(projectId: string): MainCheckWaiting | undefined {
    if (this.slots.get(projectId)?.record?.retiring?.length) return this.retirement.get(projectId) ?? "processes";
    if (!this.listed || this.activeRun() || this.unwritten.size > 0) return "another-check";
    for (const slot of this.slots.values()) {
      if (slot.unreadable || slot.record?.running || slot.record?.retiring?.length) return "another-check";
    }
    return undefined;
  }

  private rootOf(project: Project) { return project.teamworkDir ?? this.config.teams!.workspaceDir; }

  private admit(projectId: string, head: string): boolean {
    const project = this.project(projectId);
    const record = this.slots.get(projectId)?.record;
    if (this.phase.kind !== "running" || !record || !this.enabled(project)) return false;
    const digest = checksDigest(project.team);
    const pick = this.pick(record, digest);
    if (!pick || !("head" in pick) || pick.head !== head) return false;
    if (this.identityMissing() || this.halted(projectId) || this.loadHeld() || this.hostBusy(projectId)) return false;
    const hex = this.ports.randomHex(8);
    const startedAt = this.iso();
    const directory = `${project.teamworkDir ? "" : `${project.id}-`}${startedAt.slice(0, 10)}-main-check-${hex}`;
    const witness: ProcessWitness = { boot: this.ports.bootId(), processes: [], sessions: [], groups: [] };
    const root = this.rootOf(project);
    if (!this.commit(projectId, admit(record, { directory, root, witness, recording: true, head, checks: digest, startedAt }))) return false;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const active: Active = {
      projectId, directory, root, hex, head, checks: digest, startedAt, plan: planOf(project.team), teamwork: Boolean(project.teamworkDir),
      controller: new AbortController(), done, resolveDone, seenAt: record.observed!.at, witness: structuredClone(witness), commands: [],
      inFlight: 0, sampling: false, timers: {}, finished: false,
    };
    if (this.phase.kind === "running") this.phase.active = active;
    this.tails.set(entryKey(projectId, directory), active);
    this.launch(active, project.team);
    return true;
  }

  private launch(active: Active, team: TeamProject) {
    const minutes = mainCheckSetting(team)?.minutes ?? this.config.teams?.checkMinutes ?? 60;
    const prefix = this.config.teams?.commandPrefix;
    this.pollHalt(active);
    void commandScope.run(this.recorder(active), () => this.execute(active, prefix, minutes * 60_000))
      .catch((): RunEnd => ({ outcome: "error", reason: "workspace" }))
      .then(end => this.settleRun(active, end))
      .catch(() => undefined);
  }

  private async execute(active: Active, prefix: TeamCommand | undefined, timeoutMs: number): Promise<RunEnd> {
    const signal = active.controller.signal;
    let workspace: string;
    try {
      const branch = `infinite/team-main-check-${active.hex}`;
      const prepared = await this.ports.prepareWorkspace(this.mirrorPath(active.projectId), active.head, active.root, active.directory, branch, prefix, signal, active.teamwork);
      const verification = await this.ports.prepareVerification(prepared.workspace, this.ports.uuid(), active.head, prefix, signal);
      if (verification.baseCommit !== active.head) return { outcome: "error", reason: "workspace" };
      workspace = verification.workspace;
    } catch {
      return { outcome: "error", reason: "workspace" };
    }
    for (const step of active.plan) {
      if (active.stopReason) return { outcome: "interrupted", reason: active.stopReason };
      if (this.halted(active.projectId)) {
        this.stop(active, "halt");
        return { outcome: "interrupted", reason: "halt" };
      }
      const scanner = new CheckOutputScanner();
      const tail = new OutputTail();
      active.timers.limit = this.timer(() => this.stop(active, "time-limit"), timeoutMs);
      let result: CommandResult;
      try {
        result = await this.ports.run(step.command, workspace, signal, timeoutMs, prefix, undefined, undefined, STOP_BOUND_MS, (chunk, stream) => { scanner.push(chunk, stream); tail.push(chunk); });
      } catch (error) {
        return { outcome: "error", reason: codeOf(error) === "command-stop-unconfirmed" ? "stop-unconfirmed" : "command-unavailable" };
      } finally {
        this.clear(active.timers.limit);
        active.timers.limit = undefined;
      }
      const status = result.interrupted ? "interrupted" : result.exitCode === 0 ? "passed" : "failed";
      const scan = status === "passed" ? undefined : scanner.finish();
      const failures = scan === undefined ? [] : scan.failures.length > 0 ? scan.failures.slice(0, MAX_FAILURES).map(failure => failure.detail ? `${failure.line}\n${failure.detail}` : failure.line) : [tail.unrecognised()];
      active.commands.push({ ...structuredClone(step), status, exitCode: result.exitCode, ...(failures.length ? { failures } : {}) });
      if (status === "interrupted") return { outcome: "interrupted", reason: active.stopReason ?? "time-limit" };
      if (active.stopReason) return { outcome: "interrupted", reason: active.stopReason };
      try { await this.ports.assertClean(workspace, active.head, prefix, signal, step.phase); }
      catch { return { outcome: "error", reason: "copy-changed" }; }
      if (status === "failed") return { outcome: "failed" };
    }
    return { outcome: "passed" };
  }

  private settleRun(active: Active, end: RunEnd) {
    if (active.finished) return;
    if ((end.outcome === "error" && end.reason === "stop-unconfirmed") || !active.stopReason) this.finish(active, end);
    else this.finish(active, { outcome: "interrupted", reason: active.stopReason });
  }

  private pollHalt(active: Active) {
    active.timers.poll = this.timer(() => {
      if (active.finished || active.stopReason) return;
      if (this.halted(active.projectId)) this.stop(active, "halt");
      else this.pollHalt(active);
    }, HALT_POLL_MS);
  }

  private stop(active: Active, reason: StopReason) {
    if (active.finished) return;
    active.stopReason ??= reason;
    active.controller.abort();
    active.timers.bound ??= this.timer(() => {
      if (!active.finished) this.finish(active, { outcome: "error", reason: "stop-unconfirmed" });
    }, STOP_BOUND_MS);
  }

  private finish(active: Active, end: RunEnd) {
    if (active.finished) return;
    active.finished = true;
    for (const timer of Object.values(active.timers)) this.clear(timer);
    active.timers = {};
    active.result = {
      head: active.head, checks: active.checks, startedAt: active.startedAt, finishedAt: this.iso(),
      ...end, expected: active.plan.length, commands: structuredClone(active.commands),
    };
    if ((this.phase.kind === "running" || this.phase.kind === "closing") && this.phase.active === active) {
      this.phase.active = undefined;
    }
    this.unwritten.add(active);
    this.writeFinish(active);
    active.resolveDone();
  }

  private writeFinish(active: Active) {
    const record = this.slots.get(active.projectId)?.record;
    if (record?.running?.directory !== active.directory) {
      this.unwritten.delete(active);
      return;
    }
    const entry: Retiring = { directory: active.directory, root: active.root, witness: structuredClone(active.witness), ...(active.inFlight > 0 ? { recording: true as const } : {}) };
    if (!this.commit(active.projectId, finish(record, active.result!, entry, active.seenAt))) return;
    this.unwritten.delete(active);
    if (active.inFlight === 0) this.tails.delete(entryKey(active.projectId, active.directory));
    this.requestPass();
  }

  private recorder(active: Active): CommandScope {
    return {
      starting: () => {
        if (active.finished || this.isStoppingOrClosed()) return Promise.reject(new TeamError(409, "command-unavailable", "The main check ended; the command was not started."));
        active.inFlight += 1;
        if (this.recordingSaved(active) || this.saveEntry(active)) return undefined;
        active.inFlight -= 1;
        return Promise.reject(new TeamError(409, "command-unavailable", "The host could not record the command before it started."));
      },
      started: pid => {
        if (pid === undefined) {
          this.commandSettled(active);
          return;
        }
        recordCommand(active.witness, pid);
        if (!active.sampling) {
          active.sampling = true;
          this.sample(active, WITNESS_SAMPLES);
        }
        void Promise.resolve()
          .then(() => this.ports.processes.start(pid))
          .then(start => { if (start) recordCommand(active.witness, pid, start); })
          .catch(() => undefined)
          .then(() => this.commandSettled(active))
          .catch(() => undefined);
      },
    };
  }

  private recordingSaved(active: Active) {
    const record = this.slots.get(active.projectId)?.record;
    return record !== undefined && entryOf(record, active.directory)?.recording === true;
  }

  private saveEntry(active: Active): boolean {
    const record = this.slots.get(active.projectId)?.record;
    const next = record && withWitness(record, active.directory, structuredClone(active.witness), active.inFlight > 0);
    return next !== undefined && this.commit(active.projectId, next);
  }

  private commandSettled(active: Active) {
    active.inFlight -= 1;
    this.clear(active.timers.save);
    if (this.phase.kind === "closed") return;
    active.timers.save = this.timer(() => {
      active.timers.save = undefined;
      if (!this.unwritten.has(active) && this.saveEntry(active) && active.finished) this.closeTail(active);
    }, WITNESS_SAVE_MS);
  }

  private closeTail(active: Active) {
    if (active.inFlight > 0 || !this.saveEntry(active)) return;
    this.tails.delete(entryKey(active.projectId, active.directory));
  }

  private sample(active: Active, delays: readonly number[]) {
    active.timers.sample = this.timer(() => {
      if (active.finished || this.isStoppingOrClosed()) return;
      void Promise.resolve()
        .then(() => this.ports.processes.table())
        .then(table => { if (!active.finished && extendWitness(active.witness, table)) this.saveEntry(active); })
        .catch(() => undefined)
        .then(() => { if (!active.finished) this.sample(active, delays.slice(1)); })
        .catch(() => undefined);
    }, delays[0] ?? WITNESS_SAMPLE_MS);
  }

  private offer(projectId: string, slot: Slot, now: number): MainCheckNotice | undefined {
    const record = slot.record;
    const project = this.project(projectId);
    if (!record || !project || mainCheckSetting(project.team) === undefined || !noticeDue(record)) return undefined;
    const flight = this.flights.get(projectId);
    if (flight && flight.until > now) return undefined;
    const notice = record.notice ?? 0;
    this.flights.set(projectId, { notice, until: now + NOTICE_FLIGHT_MS });
    return { projectId, label: project.name, notice, outcome: record.health.outcome, summary: structuredClone(record.health) };
  }
}
