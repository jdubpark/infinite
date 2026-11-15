import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { TeamError } from "../team-workspace.js";
import type { FuseGate } from "../fuse/types.js";
import type { Config } from "../types.js";
import { HALT_FILE, MAX_RECEIPTS, readHaltRecord, writeHaltRecord, type HaltActor, type HaltEntry, type HaltReceipt, type HaltRecord } from "./record.js";
import { haltReason, STILL_HALTED, type HaltCheck, type HaltCovers, type HaltHeldBy, type HaltItemKind, type HaltOutcome, type HaltTarget, type HaltTargets, type LaunchHalted } from "./rules.js";

export type HaltServiceOptions = { config: Config; key: Buffer; now?: () => number; /** How often an unreadable record is read again. */ retryMs?: number };

/** The services a halt stops, in the order it stops them. A release resumes them in reverse. */
export type HaltServices = { routines: HaltTargets; goals: HaltTargets; missions: HaltTargets; teams: HaltTargets };

export type HaltState = { haltId: string; at: string; reason?: string; by: string };
export type HaltView = {
  /** False when the host cannot read its halt record. The whole host is then halted until it can. */
  readable: boolean;
  host?: HaltState;
  projects: (HaltState & { projectId: string })[];
};
export type HaltItem = { kind: HaltItemKind; id: string; title: string; reason?: string };
export type HaltEngageResult = { halt: HaltView; engaged: boolean; paused: HaltItem[]; failed: HaltItem[] };
export type HaltReleaseResult = { halt: HaltView; released: boolean; resumed: HaltItem[]; notResumed: HaltItem[] };

const RETRY_MS = 60_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const item = ({ kind, id, title, reason }: HaltOutcome): HaltItem => ({ kind, id, title, ...(reason === undefined ? {} : { reason }) });
const clip = (outcome: HaltOutcome): HaltOutcome => ({
  ...outcome, id: outcome.id.slice(0, 200), title: outcome.title.slice(0, 500),
  ...(outcome.reason === undefined ? {} : { reason: outcome.reason.slice(0, 4000) }),
});
const sameTarget = (entry: HaltEntry, target: HaltTarget) =>
  entry.scope === target.scope && (target.scope === "host" || entry.projectId === target.projectId);
const unreadableError = () => new TeamError(409, "halt-unreadable", "The host cannot read its halt record, so every launch waits. Restore the record before changing the halt.");
const writeError = () => new TeamError(503, "write-failed", "The host could not record the halt change. Nothing changed.");

/**
 * The owner's halt: one action that stops autonomous work on the whole host or in one project, and keeps it stopped
 * until the owner releases it. The sealed file is the authority: each change is written there first, then memory.
 * A missing file is no halt. A file that cannot be read halts the whole host until it can be read.
 */
export class HaltService {
  private readonly key: Buffer;
  private readonly file: string;
  private readonly now: () => number;
  private readonly retryMs: number;
  private record: HaltRecord = { version: 1, halts: [], receipts: [] };
  private readable = true;
  private services?: HaltServices;
  private ownedTeam: (teamId: string) => boolean = () => false;
  private serial: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HaltServiceOptions) {
    this.key = options.key;
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.file = join(options.config.stateDir, HALT_FILE);
    this.load();
  }

  /** The services the halt pauses and resumes. A team that a live goal or mission owns is stopped through its owner. */
  useServices(services: HaltServices, ownedTeam: (teamId: string) => boolean) {
    this.services = services;
    this.ownedTeam = ownedTeam;
  }

  /** Reads memory only. The host halt wins over a project halt. */
  check(input: { projectId: string }): HaltCheck {
    return this.hold([input.projectId]) ?? { state: "clear" };
  }

  /**
   * The launch gate the schedulers and the Manager use: the halt first, then the fuse. A halted launch never reaches
   * the fuse, so it is not counted or charged, and no role is exempt from the halt.
   */
  gate(fuse: FuseGate): FuseGate {
    return {
      check: input => this.hold([input.projectId]) ?? fuse.check(input),
      admit: launch => {
        const halted = this.hold([launch.projectId]);
        return halted ? { ok: false, launchId: launch.launchId, halted } : fuse.admit(launch);
      },
      release: launchId => fuse.release(launchId),
      started: launchId => fuse.started(launchId),
      held: projectIds => this.hold(projectIds),
      refund: launchId => fuse.refund?.(launchId),
    };
  }

  /**
   * The halts in force, each with its place in the count, how many halts the record has engaged in all, and the
   * record's generation (absent until its first write). The count is never lowered by a release or a dropped receipt.
   * Undefined while the record cannot be read.
   */
  engagements(): { generation?: string; count: number; halts: { haltId: string; projectId?: string; serial?: number }[] } | undefined {
    if (!this.readable) return undefined;
    return {
      ...(this.record.generation === undefined ? {} : { generation: this.record.generation }),
      count: this.record.engaged ?? 0,
      halts: this.record.halts.map(entry => ({
        haltId: entry.haltId, ...(entry.scope === "project" && entry.projectId ? { projectId: entry.projectId } : {}),
        ...(entry.serial === undefined ? {} : { serial: entry.serial }),
      })),
    };
  }

  view(): HaltView {
    if (!this.readable) return { readable: false, projects: [] };
    const state = (entry: HaltEntry): HaltState => ({
      haltId: entry.haltId, at: new Date(entry.at).toISOString(), ...(entry.reason === undefined ? {} : { reason: entry.reason }), by: entry.by.label,
    });
    const host = this.record.halts.find(entry => entry.scope === "host");
    return {
      readable: true,
      ...(host ? { host: state(host) } : {}),
      projects: this.record.halts.filter(entry => entry.scope === "project").map(entry => ({ projectId: entry.projectId!, ...state(entry) })),
    };
  }

  engage(target: HaltTarget, body: { requestId: string; reason?: string }, by: HaltActor): Promise<HaltEngageResult> {
    return this.enqueue(async () => {
      if (!await this.recover()) throw unreadableError();
      const fingerprint = digest({ action: "engage", ...target, reason: body.reason ?? null });
      const prior = this.receipt(body.requestId, fingerprint);
      if (prior) {
        if (!prior.settled) await this.finishEngage(prior);
        return this.engageResult(prior);
      }
      const existing = this.record.halts.find(entry => sameTarget(entry, target));
      const at = this.now();
      if (existing) {
        const receipt: HaltReceipt = { requestId: body.requestId, action: "engage", fingerprint, haltId: existing.haltId, changed: false, at, by, settled: true, outcomes: [] };
        if (!this.persist({ ...this.record, receipts: this.withReceipt(receipt) })) throw writeError();
        return this.engageResult(receipt);
      }
      const serial = (this.record.engaged ?? 0) + 1;
      const entry: HaltEntry = {
        haltId: randomUUID(), scope: target.scope, ...(target.scope === "project" ? { projectId: target.projectId } : {}), at,
        ...(body.reason === undefined ? {} : { reason: body.reason }), requestId: body.requestId, by, settled: false, serial,
      };
      const receipt: HaltReceipt = { requestId: body.requestId, action: "engage", fingerprint, haltId: entry.haltId, changed: true, at, by, settled: false, outcomes: [] };
      // The gate holds every new launch in scope from this write on, before any running item is paused.
      if (!this.persist({ ...this.record, engaged: serial, halts: [...this.record.halts, entry], receipts: this.withReceipt(receipt) })) throw writeError();
      await this.finishEngage(receipt);
      return this.engageResult(this.record.receipts.find(value => value.requestId === receipt.requestId) ?? receipt);
    });
  }

  release(target: HaltTarget, body: { requestId: string; keepPaused?: boolean }, by: HaltActor): Promise<HaltReleaseResult> {
    return this.enqueue(async () => {
      if (!await this.recover()) throw unreadableError();
      const keepPaused = body.keepPaused === true;
      const fingerprint = digest({ action: "release", ...target, keepPaused });
      const prior = this.receipt(body.requestId, fingerprint);
      if (prior) {
        if (!prior.settled) await this.finishRelease(prior);
        return this.releaseResult(prior);
      }
      const existing = this.record.halts.find(entry => sameTarget(entry, target));
      const at = this.now();
      const receipt: HaltReceipt = {
        requestId: body.requestId, action: "release", fingerprint, ...(existing ? { haltId: existing.haltId } : {}), changed: Boolean(existing),
        keepPaused, at, by, settled: !existing, outcomes: [],
      };
      // The gate lifts with this write. Marked items resume after it, so nothing resumes into a closed gate.
      const halts = existing ? this.record.halts.filter(entry => entry !== existing) : this.record.halts;
      if (!this.persist({ ...this.record, halts, receipts: this.withReceipt(receipt) })) throw writeError();
      if (!receipt.settled) await this.finishRelease(receipt);
      return this.releaseResult(this.record.receipts.find(value => value.requestId === receipt.requestId) ?? receipt);
    });
  }

  /**
   * Finishes any pass a previous process left unsettled, and reads an unreadable record again every minute. A record
   * that becomes readable has its unsettled passes finished the same way, in turn with engage and release.
   */
  start(): Promise<void> {
    if (this.timer === undefined) {
      this.timer = setInterval(() => { if (!this.readable) void this.enqueue(() => this.recover()).catch(() => {}); }, this.retryMs);
      this.timer.unref();
    }
    return this.enqueue(async () => { if (this.readable) await this.finishUnsettled(); });
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The halt that covers a launch in any of these projects, or undefined. Reads memory only. */
  private hold(projectIds: readonly string[]): LaunchHalted | undefined {
    if (!this.readable) return { state: "halted", scope: "host", haltId: "unreadable", at: this.now(), unreadable: true };
    const entry = this.covering(projectIds);
    if (!entry) return undefined;
    return {
      state: "halted", scope: entry.scope, ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
      haltId: entry.haltId, at: entry.at, ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  }

  private covering(projectIds: readonly string[], halts: readonly HaltEntry[] = this.record.halts): HaltEntry | undefined {
    return halts.find(entry => entry.scope === "host") ?? halts.find(entry => entry.scope === "project" && projectIds.includes(entry.projectId!));
  }

  /**
   * Pauses every running item in the halt's scope: routines first, so they start nothing, then goals, missions, and
   * the team runs that no live goal or mission owns. A failed item is reported; the pass goes on and the gate stays.
   */
  private async finishEngage(receipt: HaltReceipt) {
    const entry = this.record.halts.find(value => value.haltId === receipt.haltId);
    let outcomes: HaltOutcome[] = [];
    if (entry && this.services) {
      const mark = { haltId: entry.haltId, reason: haltReason(entry) };
      const covers: HaltCovers = ids => entry.scope === "host" || ids.includes(entry.projectId!);
      const { routines, goals, missions, teams } = this.services;
      outcomes = [
        ...await this.pass("routine", () => routines.haltPause(mark, covers)),
        ...await this.pass("goal", () => goals.haltPause(mark, covers)),
        ...await this.pass("mission", () => missions.haltPause(mark, covers)),
        ...await this.pass("team", () => teams.haltPause(mark, (ids, id) => covers(ids, id) && !this.ownedTeam(id))),
      ];
    }
    this.settle(receipt, outcomes, true);
  }

  /**
   * Resumes the items this halt paused, in reverse order. An item that another halt still covers moves to that halt.
   * With `keepPaused`, nothing resumes and each item says the owner kept it paused.
   */
  private async finishRelease(receipt: HaltReceipt) {
    let outcomes: HaltOutcome[] = [];
    if (receipt.haltId && this.services) {
      const keep = receipt.keepPaused === true;
      const haltId = receipt.haltId;
      const heldBy: HaltHeldBy = ids => {
        const other = this.covering(ids);
        return other && { haltId: other.haltId, reason: haltReason(other) };
      };
      const { routines, goals, missions, teams } = this.services;
      outcomes = [
        ...await this.pass("team", () => teams.haltResume(haltId, heldBy, keep)),
        ...await this.pass("mission", () => missions.haltResume(haltId, heldBy, keep)),
        ...await this.pass("goal", () => goals.haltResume(haltId, heldBy, keep)),
        ...await this.pass("routine", () => routines.haltResume(haltId, heldBy, keep)),
      ];
    }
    this.settle(receipt, outcomes, false);
  }

  /** One service's part of a pass. A service that fails as a whole is one failed line; the pass goes on. */
  private async pass(kind: HaltItemKind, run: () => Promise<HaltOutcome[]>): Promise<HaltOutcome[]> {
    try { return (await run()).map(clip); }
    catch (error) {
      return [{ kind, id: "", title: `Every ${kind}`, result: "failed", reason: error instanceof Error ? error.message.slice(0, 4000) : "The service could not be reached." }];
    }
  }

  /** Records the pass. A failed write keeps the result in memory; a restart runs the pass again, which repeats nothing done. */
  private settle(receipt: HaltReceipt, outcomes: HaltOutcome[], engage: boolean) {
    const settled: HaltReceipt = { ...receipt, settled: true, outcomes: [...receipt.outcomes, ...outcomes].slice(0, 5000) };
    const halts = engage ? this.record.halts.map(entry => entry.haltId === receipt.haltId ? { ...entry, settled: true } : entry) : this.record.halts;
    const next: HaltRecord = { ...this.record, halts, receipts: this.record.receipts.map(value => value.requestId === receipt.requestId ? settled : value) };
    if (!this.persist(next)) this.record = next;
  }

  private receipt(requestId: string, fingerprint: string): HaltReceipt | undefined {
    const prior = this.record.receipts.find(value => value.requestId === requestId);
    if (prior && prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different halt action.");
    return prior;
  }

  private withReceipt(receipt: HaltReceipt): HaltReceipt[] {
    return [...this.record.receipts, receipt].slice(-MAX_RECEIPTS);
  }

  private engageResult(receipt: HaltReceipt): HaltEngageResult {
    return {
      halt: this.view(), engaged: receipt.changed,
      paused: receipt.outcomes.filter(value => value.result === "paused").map(item),
      failed: receipt.outcomes.filter(value => value.result === "failed").map(item),
    };
  }

  private releaseResult(receipt: HaltReceipt): HaltReleaseResult {
    return {
      halt: this.view(), released: receipt.changed,
      resumed: receipt.outcomes.filter(value => value.result === "resumed").map(item),
      notResumed: receipt.outcomes.filter(value => value.result !== "resumed").map(value => item(value.result === "held" ? { ...value, reason: value.reason ?? STILL_HALTED } : value)),
    };
  }

  /** True when the record is readable. A record read again after it was unreadable first finishes its unsettled passes. */
  private async recover(): Promise<boolean> {
    if (this.readable) return true;
    this.load();
    if (!this.readable) return false;
    await this.finishUnsettled();
    return true;
  }

  /** Runs every pass the record holds as unsettled. Without the services there is nothing to pause yet, so it waits. */
  private async finishUnsettled() {
    if (!this.services) return;
    for (const receipt of this.record.receipts.filter(value => !value.settled)) {
      if (receipt.action === "engage") await this.finishEngage(receipt);
      else await this.finishRelease(receipt);
    }
  }

  /** Writes the file, then memory. False when the write failed; memory is unchanged then. A record's first write gives it its generation. */
  private persist(next: HaltRecord): boolean {
    const record = next.generation === undefined ? { ...next, generation: randomUUID() } : next;
    if (!writeHaltRecord(this.file, this.key, record)) return false;
    this.record = record;
    return true;
  }

  private load() {
    const read = readHaltRecord(this.file, this.key);
    if (read.state === "unreadable") { this.readable = false; return; }
    this.readable = true;
    this.record = read.state === "readable" ? read.record : { version: 1, halts: [], receipts: [] };
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task);
    this.serial = next.catch(() => {});
    return next;
  }
}
