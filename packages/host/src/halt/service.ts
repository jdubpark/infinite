import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { TeamError } from "../team-workspace.js";
import type { FuseGate } from "../fuse/types.js";
import type { Config } from "../types.js";
import { HALT_EPOCHS_FILE, HALT_FILE, MAX_RECEIPTS, readHaltEpochs, readHaltRecord, writeHaltEpochs, writeHaltRecord, type HaltActor, type HaltEntry, type HaltEpochs, type HaltReceipt, type HaltRecord } from "./record.js";
import { haltReason, STILL_HALTED, type HaltCheck, type HaltCovers, type HaltHeldBy, type HaltItemKind, type HaltOutcome, type HaltTarget, type HaltTargets, type LaunchHalted } from "./rules.js";

export type HaltServiceOptions = { config: Config; key: Buffer; now?: () => number; retryMs?: number };

export type HaltServices = { routines: HaltTargets; goals: HaltTargets; missions: HaltTargets; teams: HaltTargets };

export type HaltState = { haltId: string; at: string; reason?: string; by: string };
export type HaltView =
  | { readable: false; host?: undefined; projects: [] }
  | { readable: true; host?: HaltState; projects: (HaltState & { projectId: string })[] };
export type HaltItem = { kind: HaltItemKind; id: string; title: string; reason?: string };
export type HaltEngageResult = { halt: HaltView; engaged: boolean; paused: HaltItem[]; failed: HaltItem[] };
export type HaltReleaseResult = { halt: HaltView; released: boolean; resumed: HaltItem[]; notResumed: HaltItem[] };

type RecordState = { state: "readable"; record: HaltRecord } | { state: "unreadable" };
type EpochsState = { state: "readable"; epochs: HaltEpochs } | { state: "unreadable" };

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

export class HaltService {
  private readonly key: Buffer;
  private readonly file: string;
  private readonly now: () => number;
  private readonly retryMs: number;
  private recordState: RecordState = { state: "readable", record: { version: 1, halts: [], receipts: [] } };
  private readonly epochsFile: string;
  private epochsState: EpochsState = { state: "readable", epochs: { version: 1, host: "", projects: {} } };
  private services?: HaltServices;
  private ownedTeam: (teamId: string) => boolean = () => false;
  private serial: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HaltServiceOptions) {
    this.key = options.key;
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.file = join(options.config.stateDir, HALT_FILE);
    this.epochsFile = join(options.config.stateDir, HALT_EPOCHS_FILE);
    this.load();
  }

  useServices(services: HaltServices, ownedTeam: (teamId: string) => boolean) {
    this.services = services;
    this.ownedTeam = ownedTeam;
  }

  check(input: { projectId: string }): HaltCheck {
    return this.hold([input.projectId]) ?? { state: "clear" };
  }

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

  epoch(projectId: string): string | undefined {
    if (this.recordState.state !== "readable" || this.epochsState.state !== "readable") return undefined;
    return `${this.epochsState.epochs.host}:${this.epochsState.epochs.projects[projectId] ?? ""}`;
  }

  view(): HaltView {
    if (this.recordState.state !== "readable") return { readable: false, projects: [] };
    const state = (entry: HaltEntry): HaltState => ({
      haltId: entry.haltId, at: new Date(entry.at).toISOString(), ...(entry.reason === undefined ? {} : { reason: entry.reason }), by: entry.by.label,
    });
    const host = this.recordState.record.halts.find(entry => entry.scope === "host");
    return {
      readable: true,
      ...(host ? { host: state(host) } : {}),
      projects: this.recordState.record.halts.flatMap(entry => entry.scope === "project" ? [{ projectId: entry.projectId, ...state(entry) }] : []),
    };
  }

  engage(target: HaltTarget, body: { requestId: string; reason?: string }, by: HaltActor): Promise<HaltEngageResult> {
    return this.enqueue(async () => {
      const record = await this.recover();
      if (!record) throw unreadableError();
      const fingerprint = digest({ action: "engage", ...target, reason: body.reason ?? null });
      const prior = this.receipt(record, body.requestId, fingerprint);
      if (prior) {
        if (!prior.settled) await this.finishEngage(prior);
        return this.engageResult(prior);
      }
      const existing = record.halts.find(entry => sameTarget(entry, target));
      const at = this.now();
      if (existing) {
        const receipt: HaltReceipt = { requestId: body.requestId, action: "engage", fingerprint, haltId: existing.haltId, changed: false, at, by, settled: true, outcomes: [] };
        if (!this.persist({ ...record, receipts: this.withReceipt(record, receipt) })) throw writeError();
        return this.engageResult(receipt);
      }
      const baseEntry = {
        haltId: randomUUID(), at, ...(body.reason === undefined ? {} : { reason: body.reason }), requestId: body.requestId, by, settled: false,
      };
      const entry: HaltEntry = target.scope === "host"
        ? { ...baseEntry, scope: "host" }
        : { ...baseEntry, scope: "project", projectId: target.projectId };
      const receipt: HaltReceipt = { requestId: body.requestId, action: "engage", fingerprint, haltId: entry.haltId, changed: true, at, by, settled: false, outcomes: [] };
      if (!this.renewEpoch(target)) throw writeError();
      if (!this.persist({ ...record, halts: [...record.halts, entry], receipts: this.withReceipt(record, receipt) })) throw writeError();
      await this.finishEngage(receipt);
      const current = this.currentRecord();
      return this.engageResult(current?.receipts.find(value => value.requestId === receipt.requestId) ?? receipt);
    });
  }

  release(target: HaltTarget, body: { requestId: string; keepPaused?: boolean }, by: HaltActor): Promise<HaltReleaseResult> {
    return this.enqueue(async () => {
      const record = await this.recover();
      if (!record) throw unreadableError();
      const keepPaused = body.keepPaused === true;
      const fingerprint = digest({ action: "release", ...target, keepPaused });
      const prior = this.receipt(record, body.requestId, fingerprint);
      if (prior) {
        if (!prior.settled) await this.finishRelease(prior);
        return this.releaseResult(prior);
      }
      const existing = record.halts.find(entry => sameTarget(entry, target));
      const at = this.now();
      const receipt: HaltReceipt = {
        requestId: body.requestId, action: "release", fingerprint, ...(existing ? { haltId: existing.haltId } : {}), changed: Boolean(existing),
        keepPaused, at, by, settled: !existing, outcomes: [],
      };
      if (existing && !this.renewEpoch(target)) throw writeError();
      const halts = existing ? record.halts.filter(entry => entry !== existing) : record.halts;
      if (!this.persist({ ...record, halts, receipts: this.withReceipt(record, receipt) })) throw writeError();
      if (!receipt.settled) await this.finishRelease(receipt);
      const current = this.currentRecord();
      return this.releaseResult(current?.receipts.find(value => value.requestId === receipt.requestId) ?? receipt);
    });
  }

  start(): Promise<void> {
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        if (this.recordState.state !== "readable") void this.enqueue(() => this.recover()).catch(() => {});
        else if (this.epochsState.state !== "readable") void this.enqueue(() => this.reloadEpochs()).catch(() => {});
      }, this.retryMs);
      this.timer.unref();
    }
    return this.enqueue(async () => { if (this.recordState.state === "readable") await this.finishUnsettled(); });
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private currentRecord(): HaltRecord | undefined {
    return this.recordState.state === "readable" ? this.recordState.record : undefined;
  }

  private hold(projectIds: readonly string[]): LaunchHalted | undefined {
    if (this.recordState.state !== "readable") return { state: "halted", scope: "host", haltId: "unreadable", at: this.now(), unreadable: true };
    const entry = this.covering(projectIds, this.recordState.record.halts);
    if (!entry) return undefined;
    const base = {
      state: "halted" as const, haltId: entry.haltId, at: entry.at, ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
    return entry.scope === "host" ? { ...base, scope: "host" } : { ...base, scope: "project", projectId: entry.projectId };
  }

  private covering(projectIds: readonly string[], halts: readonly HaltEntry[]): HaltEntry | undefined {
    return halts.find(entry => entry.scope === "host") ?? halts.find(entry => entry.scope === "project" && projectIds.includes(entry.projectId));
  }

  private async finishEngage(receipt: HaltReceipt) {
    const record = this.currentRecord();
    const entry = record?.halts.find(value => value.haltId === receipt.haltId);
    let outcomes: HaltOutcome[] = [];
    if (entry && this.services) {
      const mark = { haltId: entry.haltId, reason: haltReason(entry) };
      const covers: HaltCovers = entry.scope === "host" ? () => true : ids => ids.includes(entry.projectId);
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

  private async finishRelease(receipt: HaltReceipt) {
    let outcomes: HaltOutcome[] = [];
    if (receipt.haltId && this.services) {
      const keep = receipt.keepPaused === true;
      const haltId = receipt.haltId;
      const heldBy: HaltHeldBy = ids => {
        const record = this.currentRecord();
        if (!record) return undefined;
        const other = this.covering(ids, record.halts);
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

  private async pass(kind: HaltItemKind, run: () => Promise<HaltOutcome[]>): Promise<HaltOutcome[]> {
    try { return (await run()).map(clip); }
    catch (error) {
      return [{ kind, id: "", title: `Every ${kind}`, result: "failed", reason: error instanceof Error ? error.message.slice(0, 4000) : "The service could not be reached." }];
    }
  }

  private settle(receipt: HaltReceipt, outcomes: HaltOutcome[], engage: boolean) {
    const record = this.currentRecord();
    if (!record) return;
    const settled: HaltReceipt = { ...receipt, settled: true, outcomes: [...receipt.outcomes, ...outcomes].slice(0, 5000) };
    const halts = engage ? record.halts.map(entry => entry.haltId === receipt.haltId ? { ...entry, settled: true } : entry) : record.halts;
    const next: HaltRecord = { ...record, halts, receipts: record.receipts.map(value => value.requestId === receipt.requestId ? settled : value) };
    if (!this.persist(next)) this.recordState = { state: "readable", record: next };
  }

  private receipt(record: HaltRecord, requestId: string, fingerprint: string): HaltReceipt | undefined {
    const prior = record.receipts.find(value => value.requestId === requestId);
    if (prior && prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different halt action.");
    return prior;
  }

  private withReceipt(record: HaltRecord, receipt: HaltReceipt): HaltReceipt[] {
    return [...record.receipts, receipt].slice(-MAX_RECEIPTS);
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

  private async recover(): Promise<HaltRecord | undefined> {
    if (this.recordState.state === "readable") return this.recordState.record;
    const loaded = this.load();
    if (loaded.state !== "readable") return undefined;
    await this.finishUnsettled();
    return this.currentRecord();
  }

  private async finishUnsettled() {
    const record = this.currentRecord();
    if (!this.services || !record) return;
    for (const receipt of record.receipts.filter(value => !value.settled)) {
      if (receipt.action === "engage") await this.finishEngage(receipt);
      else await this.finishRelease(receipt);
    }
  }

  private persist(next: HaltRecord): boolean {
    if (!writeHaltRecord(this.file, this.key, next)) return false;
    this.recordState = { state: "readable", record: next };
    return true;
  }

  private renewEpoch(target: HaltTarget): boolean {
    const base: HaltEpochs = this.epochsState.state === "readable" ? this.epochsState.epochs : { version: 1, host: randomUUID(), projects: {} };
    const next: HaltEpochs = target.scope === "host"
      ? { ...base, host: randomUUID() }
      : { ...base, projects: { ...base.projects, [target.projectId]: randomUUID() } };
    if (!writeHaltEpochs(this.epochsFile, this.key, next)) return false;
    this.epochsState = { state: "readable", epochs: next };
    return true;
  }

  private reloadEpochs() {
    const read = readHaltEpochs(this.epochsFile, this.key);
    if (read.state === "readable") { this.epochsState = { state: "readable", epochs: read.epochs }; return; }
    this.epochsState = { state: "unreadable" };
    if (read.state === "missing") {
      const fresh: HaltEpochs = { version: 1, host: randomUUID(), projects: {} };
      if (writeHaltEpochs(this.epochsFile, this.key, fresh)) this.epochsState = { state: "readable", epochs: fresh };
    }
  }

  private load(): RecordState {
    this.reloadEpochs();
    const read = readHaltRecord(this.file, this.key);
    if (read.state === "unreadable") {
      this.recordState = { state: "unreadable" };
      return this.recordState;
    }
    this.recordState = { state: "readable", record: read.state === "readable" ? read.record : { version: 1, halts: [], receipts: [] } };
    return this.recordState;
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task);
    this.serial = next.catch(() => {});
    return next;
  }
}
