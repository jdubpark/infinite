import { join } from "node:path";
import { defaultMainCheckPorts, type MainCheckHalt, type MainCheckHostLoad, type MainCheckPorts, type MainCheckTimer } from "./main-check-ports.js";
import { accept, admit, candidate, checksDigest, emptyRecord, entryOf, finish, hostStart, isCommit, MAX_FAILURES, mainCheckRecordSchema, mainCheckSetting, noticeDue, observe, outcomeOf, PROJECT_ID, retire, setWaiting, settle, viewOf, withWitness, type CheckSummary, type MainCheckCommand, type MainCheckReason, type MainCheckRecord, type MainCheckResult, type MainCheckView, type MainCheckWaiting, type Retiring } from "./main-check-state.js";
import { extendWitness, recordCommand, type CensusResult, type ProcessWitness } from "./process-census.js";
import type { MirrorFetch } from "./project-source.js";
import { storageShortfall } from "./storage.js";
import { CheckOutputScanner } from "./team-check-output.js";
import { DEFAULT_STORAGE_FLOOR, type TeamCommand, type TeamProject } from "./team-types.js";
import { commandScope, TeamError, type CommandResult, type CommandScope } from "./team-workspace.js";
import type { Config, Project } from "./types.js";

export type { CheckSummary, MainCheckRecord, MainCheckResult, MainCheckView, MainCheckWaiting } from "./main-check-state.js";
export type { MainCheckPorts } from "./main-check-ports.js";

/*
 * Main check (INF-388, slice 1 of INF-346): the host runs a project's configured setup and checks at the newest head
 * its mirror received for the base branch, in a disposable copy, as the agent account, and offers one notice when
 * main's health changes. It starts no agent, records no project signal and kills no process. The rules are pure
 * functions in main-check-state.ts; this service applies them, and every side effect goes through `ports`.
 * Every record change is one synchronous write of the whole record, and memory follows only a write that landed.
 */

/** A notice the push service may send. `summary` is health's; it is absent when the checks changed and no result has the current digest. */
export type MainCheckNotice = { projectId: string; label: string; notice: number; outcome: "passed" | "failed"; summary?: CheckSummary };
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
/** One witness save this long after the last recorded command covers a burst of commands. */
const WITNESS_SAVE_MS = 200;
const WITNESS_SAMPLES = [250, 1_000, 5_000];
const WITNESS_SAMPLE_MS = 15_000;

type Slot = { record?: MainCheckRecord; unreadable?: true };
type Step = { phase: "setup" | "verification"; command: TeamCommand };
type RunEnd = { outcome: MainCheckResult["outcome"]; reason?: MainCheckReason };
type StopReason = "halt" | "host-stop" | "time-limit";
type Decision = { waiting?: MainCheckWaiting; head?: string };
/** A check this API process started, from its admission until its commands are all recorded. */
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
  /** The stamp of the latest observation of `head`, for the result's `observedAt`. */
  seenAt: string;
  witness: ProcessWitness;
  commands: MainCheckCommand[];
  /** Commands between their announcement and their record. */
  inFlight: number;
  sampling: boolean;
  timers: { save?: MainCheckTimer; poll?: MainCheckTimer; limit?: MainCheckTimer; bound?: MainCheckTimer; sample?: MainCheckTimer };
  stopReason?: StopReason;
  finished: boolean;
  result?: MainCheckResult;
};

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
  /** Entries this API process found on disk: an earlier process left them. */
  private readonly earlier = new Set<string>();
  /** Checks of this process, by entry key, until every command they started is in a saved witness. */
  private readonly tails = new Map<string, Active>();
  /** Finished checks whose finish is not written yet. */
  private readonly unwritten = new Set<Active>();
  private readonly flights = new Map<string, { notice: number; until: number }>();
  /** What the last retirement pass left each project waiting on. */
  private retirement = new Map<string, "processes" | "cleanup">();
  private readonly removals = new AbortController();
  private active?: Active;
  /** False until the record files were listed: before that a record not yet read may exist, so nothing is written. */
  private listed = false;
  private passTimer?: MainCheckTimer;
  private passing = false;
  private again = false;
  private started = false;
  private closed = false;
  private ended = false;
  private closing?: Promise<void>;

  constructor(options: MainCheckOptions) {
    this.config = options.config;
    this.mirrorPath = options.mirrorPath;
    this.ports = { ...defaultMainCheckPorts(options), ...options.ports };
  }

  /** Host start: applies R8 to every record, then starts the pass timer. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.loadAll();
    this.schedulePass();
    this.requestPass();
  }

  /** For `ProjectSourceOptions.onMirror`. Never throws. An observation before `start` is dropped; the next fetch repeats it. */
  observe(fetch: MirrorFetch): void {
    try {
      if (this.closed || !this.started) return;
      const project = this.project(fetch.projectId);
      // R11: with the setting off nothing new is observed; a running check still finishes and retirement continues.
      if (!this.enabled(project) || project.source?.mode !== "github") return;
      if (fetch.repository !== project.source.repository || fetch.baseBranch !== project.source.baseBranch) return;
      if (!isCommit(fetch.head) || Number.isNaN(Date.parse(fetch.fetchedAt))) return;
      const slot = this.slots.get(fetch.projectId);
      if (slot?.unreadable) return;
      const before = slot?.record ?? emptyRecord();
      const next = observe(before, fetch.head, fetch.fetchedAt);
      if (next === before || !this.commit(fetch.projectId, next)) return;
      const active = this.active;
      if (active?.projectId === fetch.projectId && active.head === fetch.head) active.seenAt = fetch.fetchedAt;
      this.requestPass();
    } catch { /* An observation never fails the fetch that reported it. */ }
  }

  /** R9: the due notices that are not in flight. A returned notice is in flight for 60 seconds or until it is answered. */
  notices(): MainCheckNotice[] {
    const now = this.ports.now();
    const offered: MainCheckNotice[] = [];
    for (const [projectId, slot] of this.slots) {
      const notice = this.offer(projectId, slot, now);
      if (notice) offered.push(notice);
    }
    return offered;
  }

  /** The push service accepted the notice for a device: the owner was told this outcome. */
  accepted(projectId: string, notice: number, outcome: "passed" | "failed"): void {
    if (!Number.isSafeInteger(notice) || notice < 0 || outcome !== "passed" && outcome !== "failed") return;
    if (this.flights.get(projectId)?.notice === notice) this.flights.delete(projectId);
    const record = this.slots.get(projectId)?.record;
    if (!record) return;
    const next = accept(record, notice, outcome);
    if (next !== record) this.commit(projectId, next);
  }

  refused(projectId: string, notice: number): void {
    if (this.flights.get(projectId)?.notice === notice) this.flights.delete(projectId);
  }

  /** For the owner's read route: the record without directories, roots and witnesses, plus whether `health` belongs to the observed head. */
  view(projectId: string): MainCheckView | undefined {
    const slot = this.slots.get(projectId);
    if (slot?.unreadable) return { readable: false };
    if (!slot?.record) return undefined;
    return viewOf(slot.record, mainCheckSetting(this.project(projectId)?.team) !== undefined);
  }

  /**
   * Shutdown: aborts the running check and waits at most 10 seconds for it to settle. Its finish is written as
   * interrupted when it settled (the admission is given back) and as `stop-unconfirmed` when it did not. A removal in
   * progress is not awaited.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown() {
    this.closed = true;
    this.clear(this.passTimer);
    this.removals.abort();
    const active = this.active;
    if (active && !active.finished) {
      this.stop(active, "host-stop");
      await active.done;
    }
    for (const unwritten of [...this.unwritten]) this.writeFinish(unwritten);
    this.ended = true;
  }

  // ---- Records ---------------------------------------------------------------------------------------------------

  private project(projectId: string): Project | undefined {
    return this.config.projects.find(project => project.id === projectId);
  }

  /** R3 gate 1, with what a run needs: the setting, configured checks, a team root and a GitHub source. */
  private enabled(project: Project | undefined): project is Project & { team: TeamProject } {
    return project?.team !== undefined && mainCheckSetting(project.team) !== undefined && project.team.checks.length > 0 &&
      this.config.teams !== undefined && project.source?.mode === "github" && PROJECT_ID.test(project.id);
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
    // Limit: a record that exists and cannot be unsealed or parsed may hide an unretired run directory. It is never
    // overwritten or taken as empty, and nothing is admitted on the whole host until it reads again.
    if (!parsed.success) {
      this.slots.set(projectId, { unreadable: true });
      return;
    }
    const record = parsed.data;
    for (const entry of [...(record.retiring ?? []), ...(record.running ? [record.running] : [])]) this.earlier.add(entryKey(projectId, entry.directory));
    this.slots.set(projectId, { record });
    this.recoverRunning(projectId);
  }

  /** R8 for a `running` entry that no check of this process owns. */
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
    return mine(this.active) || [...this.unwritten].some(mine);
  }

  /** One write of the whole record, settled against the current checks. Memory changes only when the write landed. */
  private commit(projectId: string, next: MainCheckRecord): boolean {
    if (this.ended || !this.listed) return false;
    const slot = this.slots.get(projectId);
    if (slot?.unreadable) return false;
    const record = structuredClone(this.settled(projectId, next));
    if (slot?.record !== undefined && JSON.stringify(slot.record) === JSON.stringify(record)) return true;
    if (!mainCheckRecordSchema.safeParse(record).success) return false;
    try { this.ports.records.write(projectId, record); } catch { return false; }
    this.slots.set(projectId, { record });
    return true;
  }

  /** settle at every write, so the service sees changed checks as soon as it writes; passes write it otherwise. */
  private settled(projectId: string, record: MainCheckRecord): MainCheckRecord {
    const team = this.project(projectId)?.team;
    return team ? settle(record, checksDigest(team)) : record;
  }

  private iso() { return new Date(this.ports.now()).toISOString(); }

  /** A timer whose callback cannot throw into the event loop. Undefined when the timer could not be set. */
  private timer(callback: () => void, ms: number): MainCheckTimer | undefined {
    try {
      return this.ports.setTimer(() => {
        try { callback(); } catch { /* The next pass asks again. */ }
      }, ms);
    } catch {
      return undefined;
    }
  }

  private clear(timer: MainCheckTimer | undefined) {
    if (timer === undefined) return;
    try { this.ports.clearTimer(timer); } catch { /* Already gone. */ }
  }

  // ---- Passes ----------------------------------------------------------------------------------------------------

  private schedulePass() {
    if (this.closed) return;
    this.passTimer = this.timer(() => {
      this.requestPass();
      this.schedulePass();
    }, PASS_MS);
  }

  private requestPass() {
    if (this.closed || !this.started) return;
    this.again = true;
    if (this.passing) return;
    this.passing = true;
    void this.passes().catch(() => undefined);
  }

  private async passes() {
    try {
      while (this.again && !this.closed) {
        this.again = false;
        try { await this.pass(); } catch { /* The next pass asks again. */ }
      }
    } finally {
      this.passing = false;
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
    if (!this.closed) await this.admitOne();
  }

  /** R7, before any admission and also for projects whose setting is off. */
  private async retireAll() {
    const status = new Map<string, "processes" | "cleanup">();
    for (const [projectId, slot] of [...this.slots]) {
      for (const entry of slot.record?.retiring ?? []) {
        if (this.closed) return;
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
    if (this.closed) return "processes";
    // The entry may have changed while the census ran: a result for another witness is not acted on.
    const current = this.slots.get(projectId)?.record?.retiring?.find(item => item.directory === entry.directory);
    if (!current) return undefined;
    if (JSON.stringify(current) !== JSON.stringify(entry) || !this.removable(projectId, current, result)) return "processes";
    try { await this.ports.remove(directory, prefix, this.removals.signal, entry.root); }
    catch { return "cleanup"; }
    const record = this.slots.get(projectId)?.record;
    if (record) this.commit(projectId, retire(record, entry.directory));
    return undefined;
  }

  /** R7's test: only a finished census that found nothing proves the directory quiet. The host kills nothing here. */
  private removable(projectId: string, entry: Retiring, result: CensusResult): boolean {
    if (!result.ok || result.findings.length > 0) return false;
    const key = entryKey(projectId, entry.directory);
    // An earlier API process stopped while this entry said a command might be unrecorded. Within the same boot such a
    // command can still run where no look finds it, so finding nothing proves nothing.
    if (entry.recording && this.earlier.has(key) && entry.witness.boot === this.ports.bootId()) return false;
    // A command of this process is between its start and its record.
    return !this.tails.has(key);
  }

  private order(): string[] {
    const at = (slot: Slot) => Date.parse(slot.record?.observed?.at ?? "") || 0;
    return [...this.slots].filter(([, slot]) => slot.record).sort(([a, x], [b, y]) => at(x) - at(y) || (a < b ? -1 : 1)).map(([projectId]) => projectId);
  }

  /** At most one admission per pass; the gates record what each project waits on. */
  private async admitOne() {
    for (const projectId of this.order()) {
      if (this.closed) return;
      const decision = await this.gates(projectId);
      if (this.closed) return;
      if (decision.head !== undefined && this.admit(projectId, decision.head)) continue;
      const record = this.slots.get(projectId)?.record;
      if (record && record.waiting !== decision.waiting) this.commit(projectId, setWaiting(record, decision.waiting));
    }
  }

  /** R2 and the R3 gates in order. The first gate that holds is what the project waits on. */
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

  /** R2 for one record, as both the gates and the admission's second look ask it. */
  private pick(record: MainCheckRecord, digest: string) {
    return candidate(record, digest);
  }

  /** R0, as team creation refuses it: a sudo provider profile needs a team command prefix. */
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

  /** A halt record the host cannot read, or a throw, counts as a halt. */
  private halted(projectId: string): boolean {
    try { return this.ports.halt.check({ projectId }).state !== "clear"; } catch { return true; }
  }

  private loadHeld(): boolean {
    try { return this.ports.hostLoad.held() !== undefined; } catch { return true; }
  }

  /** A failed read counts as low, as it refuses a team run. */
  private async storageLow(project: Project): Promise<boolean> {
    try {
      const usage = await this.ports.storage(this.rootOf(project));
      return storageShortfall(usage, this.config.teams?.storageFloor ?? DEFAULT_STORAGE_FLOOR) !== undefined;
    } catch {
      return true;
    }
  }

  /** R3 gate 7, over the whole host. An unreadable record may hide a run directory, so it counts as one. */
  private hostBusy(projectId: string): MainCheckWaiting | undefined {
    if (this.slots.get(projectId)?.record?.retiring?.length) return this.retirement.get(projectId) ?? "processes";
    if (!this.listed || this.active || this.unwritten.size > 0) return "another-check";
    for (const slot of this.slots.values()) {
      if (slot.unreadable || slot.record?.running || slot.record?.retiring?.length) return "another-check";
    }
    return undefined;
  }

  private rootOf(project: Project) { return project.teamworkDir ?? this.config.teams!.workspaceDir; }

  /** R4. The gates that can change during the pass's reads are asked again right before the write. */
  private admit(projectId: string, head: string): boolean {
    const project = this.project(projectId);
    const record = this.slots.get(projectId)?.record;
    if (this.closed || !record || !this.enabled(project)) return false;
    const digest = checksDigest(project.team);
    const pick = this.pick(record, digest);
    if (!pick || !("head" in pick) || pick.head !== head) return false;
    if (this.identityMissing() || this.halted(projectId) || this.loadHeld() || this.hostBusy(projectId)) return false;
    const hex = this.ports.randomHex(8);
    const startedAt = this.iso();
    // A deployed launcher recognises a run directory and a team branch by these names.
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
    this.active = active;
    this.tails.set(entryKey(projectId, directory), active);
    this.launch(active, project.team);
    return true;
  }

  // ---- The check -------------------------------------------------------------------------------------------------

  private launch(active: Active, team: TeamProject) {
    const minutes = mainCheckSetting(team)?.minutes ?? this.config.teams?.checkMinutes ?? 60;
    const prefix = this.config.teams?.commandPrefix;
    this.pollHalt(active);
    void commandScope.run(this.recorder(active), () => this.execute(active, prefix, minutes * 60_000))
      .catch((): RunEnd => ({ outcome: "error", reason: "workspace" }))
      .then(end => this.settleRun(active, end))
      .catch(() => undefined);
  }

  /** R5: the copy, then setup and each check, stopping at the first command that does not pass. */
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
      active.timers.limit = this.timer(() => this.stop(active, "time-limit"), timeoutMs);
      let result: CommandResult;
      try {
        result = await this.ports.run(step.command, workspace, signal, timeoutMs, prefix, undefined, undefined, STOP_BOUND_MS, (chunk, stream) => scanner.push(chunk, stream));
      } catch (error) {
        return { outcome: "error", reason: codeOf(error) === "command-stop-unconfirmed" ? "stop-unconfirmed" : "command-unavailable" };
      } finally {
        this.clear(active.timers.limit);
        active.timers.limit = undefined;
      }
      const status = result.interrupted ? "interrupted" : result.exitCode === 0 ? "passed" : "failed";
      const failures = status === "passed" ? [] : scanner.finish().failures.slice(0, MAX_FAILURES).map(failure => failure.detail ? `${failure.line}\n${failure.detail}` : failure.line);
      active.commands.push({ ...structuredClone(step), status, exitCode: result.exitCode, ...(failures.length ? { failures } : {}) });
      if (status === "interrupted") return { outcome: "interrupted", reason: active.stopReason ?? "time-limit" };
      try { await this.ports.assertClean(workspace, active.head, prefix, signal, step.phase); }
      catch { return { outcome: "error", reason: "copy-changed" }; }
      if (status === "failed") return { outcome: "failed" };
    }
    return { outcome: "passed" };
  }

  /** A check told to stop ends as interrupted, unless its command could not be confirmed stopped. */
  private settleRun(active: Active, end: RunEnd) {
    if (active.finished) return;
    if (end.reason === "stop-unconfirmed" || !active.stopReason) this.finish(active, end);
    else this.finish(active, { outcome: "interrupted", reason: active.stopReason });
  }

  /** The halt is read every 2 seconds for the whole check, the copy included. */
  private pollHalt(active: Active) {
    active.timers.poll = this.timer(() => {
      if (active.finished || active.stopReason) return;
      if (this.halted(active.projectId)) this.stop(active, "halt");
      else this.pollHalt(active);
    }, HALT_POLL_MS);
  }

  /** Aborts the check. One that has not settled 10 seconds later is recorded as it is, without waiting for its helper. */
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
      head: active.head, checks: active.checks, startedAt: active.startedAt, finishedAt: this.iso(), outcome: end.outcome,
      ...(end.reason ? { reason: end.reason } : {}), expected: active.plan.length, commands: structuredClone(active.commands),
    };
    if (this.active === active) this.active = undefined;
    this.unwritten.add(active);
    this.writeFinish(active);
    active.resolveDone();
  }

  /** R6, one write. The witness is this process's, which holds every command it started; `recording` stays while one is still starting. */
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

  // ---- The witness -----------------------------------------------------------------------------------------------

  /**
   * Records the commands the check starts, as the team recorder does. `recording` is saved before a command starts
   * and cleared only by a save that holds every started command, so a host that stops in between leaves a witness
   * that says it may be incomplete. After the check ended no command starts.
   */
  private recorder(active: Active): CommandScope {
    return {
      starting: () => {
        if (active.finished || this.closed) return Promise.reject(new TeamError(409, "command-unavailable", "The main check ended; the command was not started."));
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
        // The command leads its own session and group, so both are known now, without a read that could come too late.
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

  /** Saves the witness wherever the check's entry is. `recording` stays set while a command is still starting. */
  private saveEntry(active: Active): boolean {
    const record = this.slots.get(active.projectId)?.record;
    const next = record && withWitness(record, active.directory, structuredClone(active.witness), active.inFlight > 0);
    return next !== undefined && this.commit(active.projectId, next);
  }

  private commandSettled(active: Active) {
    active.inFlight -= 1;
    this.clear(active.timers.save);
    active.timers.save = this.timer(() => {
      active.timers.save = undefined;
      if (!this.unwritten.has(active) && this.saveEntry(active) && active.finished) this.closeTail(active);
    }, WITNESS_SAVE_MS);
  }

  /** A finished check whose commands are all in its saved entry no longer holds its directory back from R7. */
  private closeTail(active: Active) {
    if (active.inFlight > 0 || !this.saveEntry(active)) return;
    this.tails.delete(entryKey(active.projectId, active.directory));
  }

  /** Extends the witness after 250 ms, 1 s, 5 s, then every 15 s while the check runs. */
  private sample(active: Active, delays: readonly number[]) {
    active.timers.sample = this.timer(() => {
      if (active.finished || this.closed) return;
      void Promise.resolve()
        .then(() => this.ports.processes.table())
        .then(table => { if (!active.finished && extendWitness(active.witness, table)) this.saveEntry(active); })
        .catch(() => undefined)
        .then(() => { if (!active.finished) this.sample(active, delays.slice(1)); })
        .catch(() => undefined);
    }, delays[0] ?? WITNESS_SAMPLE_MS);
  }

  // ---- Notices ---------------------------------------------------------------------------------------------------

  /** One project's due notice, when none of its notices is in flight. */
  private offer(projectId: string, slot: Slot, now: number): MainCheckNotice | undefined {
    const record = slot.record;
    const project = this.project(projectId);
    if (!record || !project || mainCheckSetting(project.team) === undefined || !noticeDue(record)) return undefined;
    const flight = this.flights.get(projectId);
    if (flight && flight.until > now) return undefined;
    const notice = record.notice ?? 0;
    this.flights.set(projectId, { notice, until: now + NOTICE_FLIGHT_MS });
    return { projectId, label: project.name, notice, outcome: outcomeOf(record.health), ...(record.health ? { summary: structuredClone(record.health) } : {}) };
  }
}
