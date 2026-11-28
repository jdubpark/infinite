import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Provider, SessionPurpose } from "./types.js";
import type { Manager } from "./manager.js";
import { writeSealed, unseal } from "./vault.js";
import {
  accountOf, listPriceUsage, periodEnd, periodStart, priceUsage, sumUsage,
  type Pricing, type ProviderSpendSnapshot, type UsagePeriod, type UsageRecord, type UsageTokens, type UsageTotals,
} from "./usage.js";
import { usagePlanSchema, type AccountView, type Balance, type BriefingUsage, type Money, type TaskUsage, type UsageResolvers } from "./usage-api.js";
import { EvidenceError } from "./evidence/types.js";
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceTx } from "./evidence/types.js";
import { OUTCOMES_MODULE } from "./outcome-store.js";
import { refreshOutcomeCostsForSessions } from "./outcome-cost.js";
import {
  SESSION_PURPOSES, closeMissingSession, combineCoverage, importLedger, importState, ledgerRecord, readBriefings, readRecords, readSessions, usageModule, writeBriefing, writeRecordWithOwner, writeSession,
  type LedgerCoverage, type LedgerCoverageReason, type LedgerHeader, type LedgerState, type SealedLedger, type StoredSession,
} from "./usage-store.js";

export { combineCoverage };

type Period = UsagePeriod;
export interface SessionUsage extends UsageTotals { measured: true; coverage: "partial" | "complete"; coverageReason?: LedgerCoverageReason; list?: Money }
export type UnmeasuredUsage = { measured: false; coverage: "none"; coverageReason?: LedgerCoverageReason; unavailable?: true };
export type UsageSummary = {
  period: { start: string; end: string };
  providers: Record<Provider, { period: { start: string; end: string }; measured: boolean; spent?: UsageTotals; budget?: { usd: number; period: Period }; previous?: UsageTotals; unmeasuredSessions: number; partialSessions: number; recorded: { tokens: UsageTokens; messages: number } }>;
  month: { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number; partialSessions: number };
  accounts: AccountView[];
};
export type UsageSessionRow = Awaited<ReturnType<Manager["list"]>>[number];
type Snapshot = {
  sessions: StoredSession[];
  bySession: Map<string, UsageRecord[]>;
  briefings: { projectId: string; at: string; record?: UsageRecord }[];
  byProject: ReadonlyMap<string, readonly StoredSession[]>;
  byRun: ReadonlyMap<string, readonly StoredSession[]>;
  briefingsByProject: ReadonlyMap<string, readonly { projectId: string; at: string; record?: UsageRecord }[]>;
  taskKey?: string;
};
type Ledger = {
  sessions: readonly StoredSession[];
  byId: ReadonlyMap<string, StoredSession>;
  byMember: ReadonlyMap<string, readonly StoredSession[]>;
  byProject: ReadonlyMap<string, readonly StoredSession[]>;
  byRun: ReadonlyMap<string, readonly StoredSession[]>;
  bySession: Map<string, UsageRecord[]>;
  order: ReadonlyMap<UsageRecord, number>;
  briefings: Snapshot["briefings"];
  briefingsByProject: ReadonlyMap<string, Snapshot["briefings"]>;
};
const memberKey = (runId: string, memberId: string) => `${runId}\u0000${memberId}`;
export const LEDGER_KEEP_MS = 2_000;
export const USAGE_RECONCILE_STALE_MS = 15_000;
type Row = Pick<LedgerState, "exited" | "cursor" | "seen" | "refused" | "journaled"> & { lastActiveAt?: string };
type UsageServiceOptions = { now?: () => number; reconcileStaleMs?: number };

const PROVIDERS: Provider[] = ["claude", "codex", "grok", "opencode", "demo"];
const COVERED: ReadonlySet<Provider> = new Set<Provider>(["claude", "codex", "demo"]);
const PAGE = 200;
const MAX_PAGES = 20;
const EXIT_GRACE_MS = 60_000;
const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const SCOPE = "usage";
const PLAN_SCOPE = "usage-plans";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const measured = (session: StoredSession) => session.coverage !== "none";
const partial = (session: StoredSession) => session.coverage === "partial" && session.reason !== "running";
const inWindow = (at: string, from?: Date, to?: Date) => { const time = Date.parse(at); return (!from || time >= from.getTime()) && (!to || time <= to.getTime()); };
const maxIso = (...values: (string | undefined)[]): string | undefined => {
  let best: number | undefined;
  let result: string | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (best === undefined || ms > best) { best = ms; result = new Date(ms).toISOString(); }
  }
  return result;
};
const sessionOverlaps = (session: StoredSession, records: readonly UsageRecord[] | undefined, startMs: number, endMs: number): boolean => {
  const sStart = Date.parse(session.createdAt);
  let sEnd = Math.max(sStart, session.lastActiveAt ? Date.parse(session.lastActiveAt) : sStart);
  if (records) {
    for (const record of records) {
      const at = Date.parse(record.completedAt);
      if (at > sEnd) sEnd = at;
    }
  }
  return sStart < endMs && sEnd >= startMs;
};
const keyOf = (state: { lastActiveAt?: string; exited: boolean; cursor: number; seen: number; refused: number; coverage: string; reason?: string; journaled?: object }) =>
  JSON.stringify([state.lastActiveAt ?? null, state.exited, state.cursor, state.seen, state.refused, state.coverage, state.reason ?? null, state.journaled ?? null]);

function journaledCoverage(data: unknown): LedgerState["journaled"] | undefined {
  if (!isRecord(data)) return undefined;
  const { coverage, reason, finalDrain } = data;
  if (coverage !== "none" && coverage !== "partial" && coverage !== "complete") return undefined;
  if (reason !== undefined && (typeof reason !== "string" || !REASON.test(reason) || coverage === "complete")) return undefined;
  return {
    coverage,
    ...(reason === undefined ? {} : { reason: reason as LedgerCoverageReason }),
    ...(finalDrain === "complete" || finalDrain === "incomplete" || finalDrain === "skipped" ? { finalDrain } : {}),
  };
}

export function ledgerCoverage(input: { provider: Provider; measuredLaunch: boolean; closed: boolean; journaled?: LedgerCoverage; valid: number; refused: number; drained?: boolean; recordingError?: boolean }): LedgerCoverage {
  const { provider, measuredLaunch, closed, journaled, valid, refused, drained = true, recordingError = false } = input;
  if (provider === "opencode" && measuredLaunch) {
    if (recordingError) return { coverage: "partial", reason: "recording-error" };
    if (!drained) return { coverage: "partial", reason: "drain-incomplete" };
    return refused > 0 ? { coverage: "partial", reason: "row-dropped" } : { coverage: "complete" };
  }
  if (!COVERED.has(provider)) return { coverage: "none", reason: "unsupported" };
  if (recordingError) return { coverage: "partial", reason: "recording-error" };
  if (journaled) {
    if (!drained) return { coverage: "partial", reason: "drain-incomplete" };
    if (journaled.coverage === "complete" && refused > 0) return { coverage: "partial", reason: "row-dropped" };
    return { coverage: journaled.coverage, ...(journaled.reason ? { reason: journaled.reason } : {}) };
  }
  if (!closed) return valid > 0 ? { coverage: "partial", reason: "running" } : { coverage: "none", reason: "running" };
  return valid > 0 ? { coverage: "partial", reason: "drain-incomplete" } : { coverage: "none", reason: "unsupported" };
}

export class UsageService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private ticking = false;
  private imported = false;
  private tickFailed = false;
  private lastReconciledAt?: number;
  private backlogOffset = 0;
  private readonly clock: () => number;
  private readonly reconcileStaleMs: number;
  private readonly failed = new Set<string>();
  private readonly ingestionGaps = new Map<string, { provider: Provider; projectId: string; reason: "read-failed" | "ingestion-incomplete" }>();
  private readonly exitedAt = new Map<string, number>();
  private kept?: Ledger;
  private keptAt = 0;
  private failedAt?: number;
  private readonly dateFormatters = new Map<string, Intl.DateTimeFormat>();
  private readonly planFile: string;
  private planOverrides: Record<string, number> = Object.create(null) as Record<string, number>;
  private balances?: { get(id: string): Balance };
  private onWritten?: () => void;
  private resolvers: UsageResolvers = { goalOfRun: () => undefined, runTitle: () => undefined, projectName: id => id, sessionTitle: () => undefined };
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly store: EvidenceStore, options: UsageServiceOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.reconcileStaleMs = options.reconcileStaleMs ?? USAGE_RECONCILE_STALE_MS;
    this.planFile = join(config.stateDir, "usage-plans.sealed");
    store.register(usageModule);
    this.imported = this.importOnce();
    if (existsSync(this.planFile)) try {
      const stored = unseal<unknown>(key, PLAN_SCOPE, readFileSync(this.planFile, "utf8"));
      if (!isRecord(stored) || Object.entries(stored).some(([id, value]) => !id || typeof value !== "number" || !usagePlanSchema.safeParse({ planUsd: value }).success))
        throw new Error("unexpected plan overrides shape");
      this.planOverrides = Object.assign(Object.create(null), stored) as Record<string, number>;
    } catch (error) {
      console.warn(`[Infinite] Owner usage plans cannot be read and are ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  start() {
    if (this.running || this.closed) return;
    this.running = true;
    const tick = () => { void this.tick().catch(() => {}); };
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick();
  }
  close() { this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); }
  useBalances(service: { get(id: string): Balance }) { this.balances = service; }
  useResolvers(resolvers: UsageResolvers) { this.resolvers = resolvers; }
  onUpdated(listener: () => void) { this.onWritten = listener; }

  available(): boolean { return this.storeReady() && !this.tickFailed; }
  markReconciliationFailed(): void { this.tickFailed = true; }
  readable(): boolean {
    if (!this.available()) return false;
    try { this.store.read(db => importState(db)); return true; } catch { return false; }
  }
  private write<T>(fn: (tx: EvidenceTx) => T): T {
    try { return this.store.write(fn); } finally { this.kept = undefined; this.failedAt = undefined; }
  }
  private storeReady(): boolean { return this.imported && this.store.status().modules[usageModule.name] === "ready"; }

  setPlan(accountId: string, planUsd: number | null): "missing" | "metered" | "updated" {
    const accounts = this.config.usage?.accounts;
    const account = accounts && Object.hasOwn(accounts, accountId) ? accounts[accountId] : undefined;
    if (!account) return "missing";
    if (account.kind !== "subscription") return "metered";
    const next = Object.assign(Object.create(null), this.planOverrides) as Record<string, number>;
    if (planUsd === null) delete next[accountId];
    else next[accountId] = planUsd;
    writeSealed(this.planFile, this.key, PLAN_SCOPE, next);
    this.planOverrides = next;
    return "updated";
  }

  private sessionRemoved(sessionId: string): boolean {
    if (typeof (this.manager as { meta?: unknown }).meta === "function") {
      try {
        this.manager.meta(sessionId);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    }
    return true;
  }

  async tick(rows?: UsageSessionRow[]) {
    if (this.ticking || this.closed || !this.storeReady()) return;
    this.ticking = true;
    try {
      const stored = new Map(this.store.read(db => readSessions(db)).map(row => [row.sessionId, row]));
      for (const id of [...this.ingestionGaps.keys()]) if (stored.get(id)?.exited) this.ingestionGaps.delete(id);
      const now = this.clock();
      const nowIso = new Date(now).toISOString();
      const list = rows ?? await this.manager.list();
      const listedIds = new Set(list.map(item => item.id));
      for (const [sessionId, previous] of stored) {
        if (previous.exited || listedIds.has(sessionId)) continue;
        const missingGap = this.ingestionGaps.has(sessionId) || (previous.coverage === "partial" && previous.reason === "drain-incomplete");
        if (!missingGap || !this.sessionRemoved(sessionId)) continue;
        const reason: LedgerCoverageReason = previous.reason === "recording-error" ? "recording-error" : "drain-incomplete";
        const closedAt = maxIso(previous.lastActiveAt, previous.createdAt, nowIso) ?? nowIso;
        this.write(tx => {
          if (closeMissingSession(tx, sessionId, closedAt, reason) && this.store.status().modules[OUTCOMES_MODULE] === "ready") {
            refreshOutcomeCostsForSessions(tx, [{ sessionId, runId: previous.runId, memberId: previous.memberId, exited: true }], this.config.usage?.prices);
          }
        });
        this.ingestionGaps.delete(sessionId);
        this.exitedAt.delete(sessionId);
      }
      let backlogPages = MAX_PAGES - 1;
      let nextOffset: number | undefined;
      let wroteRecords = false;
      const startOffset = list.length > 0 ? this.backlogOffset % list.length : 0;
      for (let step = 0; step < list.length; step++) {
        if (this.closed) break;
        const listIndex = (startOffset + step) % list.length;
        const session = list[listIndex]!;
        const previous = stored.get(session.id);
        if (previous?.exited) {
          this.ingestionGaps.delete(session.id);
          continue;
        }
        const observed = session.provider === "opencode" && (session.teamModelProfile ? session.teamModelProfile.provider === "opencode" : !session.team && session.runtime?.nativeUi === "opencode");
        const covered = COVERED.has(session.provider);
        const read = observed || covered;
        const active = ["starting", "running"].includes(session.status);
        const recordingError = session.status === "recording-error" || previous?.reason === "recording-error";
        const exitedListed = session.status === "exited";
        const stale = !previous?.lastActiveAt || now - Date.parse(previous.lastActiveAt) > 60_000;
        const baseLastActiveAt = active && stale ? nowIso : previous?.lastActiveAt;
        const headerOf = (lastActiveAt: string | undefined): LedgerHeader => ({
          sessionId: session.id, provider: session.provider, projectId: session.projectId, createdAt: session.createdAt,
          ...(lastActiveAt ? { lastActiveAt } : {}),
          ...(session.team ? { team: session.team } : {}), ...(session.teamModelProfile ? { profileId: session.teamModelProfile.id } : {}),
          ...(session.purpose ? { purpose: session.purpose } : {}), ...(session.configId ? { configId: session.configId } : {}),
        });
        if (covered && exitedListed && !this.exitedAt.has(session.id)) this.exitedAt.set(session.id, now);
        const exitedSince = this.exitedAt.get(session.id);
        const closes = (complete: boolean, journaled: LedgerState["journaled"]) => exitedListed && complete
          && (!covered || journaled !== undefined || (exitedSince !== undefined && now - exitedSince >= EXIT_GRACE_MS));
        const stateOf = (row: Row, drained = true): LedgerState => {
          const coverage = ledgerCoverage({ provider: session.provider, measuredLaunch: observed, closed: row.exited, journaled: row.journaled,
            valid: row.seen - row.refused, refused: row.refused, drained, recordingError });
          return { ...coverage, cursor: row.cursor, seen: row.seen, refused: row.refused, exited: row.exited, ...(row.journaled ? { journaled: row.journaled } : {}) };
        };
        const keyed = (row: Row, drained = true) => keyOf({ lastActiveAt: row.lastActiveAt, ...stateOf(row, drained) });
        let current: Row = read
          ? { exited: false, lastActiveAt: baseLastActiveAt, cursor: previous?.cursor ?? 0, seen: previous?.seen ?? 0, refused: previous?.refused ?? 0, ...(previous?.journaled ? { journaled: previous.journaled } : {}) }
          : { exited: false, lastActiveAt: baseLastActiveAt, cursor: 0, seen: 0, refused: 0 };
        let saved = previous ? keyOf(previous) : undefined, complete = !read, readFailed = false, headChecked = false;
        if (read) {
          while (!this.closed && (!headChecked || backlogPages > 0)) {
            if (headChecked) backlogPages--;
            headChecked = true;
            let page: ReturnType<Manager["events"]>;
            try {
              page = this.manager.events(session.id, current.cursor, PAGE, new Set(["usage", "usage-coverage"]));
              this.failed.delete(session.id);
            } catch (error) {
              readFailed = true;
              if (!this.failed.has(session.id)) {
                this.failed.add(session.id);
                console.warn(`[Infinite] Usage for session ${session.id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
              }
              break;
            }
            const records: UsageRecord[] = [];
            let seen = 0, refused = 0, journaled = current.journaled, maxEventAt: string | undefined;
            for (const event of page.events) {
              maxEventAt = maxIso(maxEventAt, typeof event.at === "string" ? event.at : undefined);
              if (event.type === "usage") {
                seen++;
                const record = ledgerRecord(event.data);
                if (record) {
                  records.push(record);
                  maxEventAt = maxIso(maxEventAt, record.completedAt);
                } else refused++;
              } else journaled = journaledCoverage(event.data) ?? journaled;
            }
            const drained = !page.more;
            const sawEvents = seen > 0 || refused > 0;
            const stepLastActiveAt = recordingError || !drained || ((exitedListed || sawEvents) && (previous !== undefined || active))
              ? maxIso(current.lastActiveAt, nowIso, maxEventAt)
              : sawEvents
                ? maxIso(current.lastActiveAt, maxEventAt)
                : current.lastActiveAt;
            const next: Row = { exited: closes(drained, journaled), lastActiveAt: stepLastActiveAt, cursor: page.cursor,
              seen: current.seen + seen, refused: current.refused + refused, ...(journaled ? { journaled } : {}) };
            const key = keyed(next, drained);
            if (key !== saved || records.length > 0) {
              const written = this.write(tx => {
                const header = headerOf(next.lastActiveAt);
                if (!writeSession(tx, header, stateOf(next, drained))) return false;
                const owners = new Set<string>([session.id]);
                for (const record of records) {
                  const res = writeRecordWithOwner(tx, session.id, record);
                  if (res.status !== "kept") {
                    owners.add(res.ownerSessionId);
                    wroteRecords = true;
                  }
                }
                if (this.store.status().modules[OUTCOMES_MODULE] === "ready") {
                  const targets: { sessionId: string; runId?: string; memberId?: string; exited?: boolean }[] = [];
                  for (const ownerId of owners) {
                    if (ownerId === session.id) {
                      targets.push({ sessionId: session.id, runId: header.team?.runId, memberId: header.team?.memberId, exited: next.exited });
                      continue;
                    }
                    const meta = tx.get<{ run_id: string | null; member_id: string | null; exited: number }>(
                      "SELECT run_id, member_id, exited FROM usage_sessions WHERE session_id=?", ownerId,
                    );
                    targets.push({
                      sessionId: ownerId,
                      ...(meta?.run_id ? { runId: meta.run_id } : {}),
                      ...(meta?.member_id ? { memberId: meta.member_id } : {}),
                      exited: meta?.exited === 1,
                    });
                  }
                  refreshOutcomeCostsForSessions(tx, targets, this.config.usage?.prices);
                }
                return true;
              });
              if (!written) {
                console.warn(`[Infinite] Usage for session ${session.id} cannot be stored and is read again next tick.`);
                break;
              }
              saved = key;
            }
            current = next;
            if (drained) { complete = true; break; }
          }
          if (complete) this.ingestionGaps.delete(session.id);
          else {
            if (!readFailed && nextOffset === undefined && list.length > 0) nextOffset = (listIndex + 1) % list.length;
            this.ingestionGaps.set(session.id, { provider: session.provider, projectId: session.projectId, reason: readFailed ? "read-failed" : "ingestion-incomplete" });
          }
        } else {
          this.ingestionGaps.delete(session.id);
        }
        const finalState = stateOf({ ...current, exited: closes(complete, current.journaled) }, complete);
        const finalLastActiveAt = recordingError || !complete || (previous !== undefined && exitedListed) || (finalState.coverage === "none" && active)
          ? maxIso(current.lastActiveAt, nowIso)
          : current.lastActiveAt;
        const final: Row = { ...current, lastActiveAt: finalLastActiveAt, exited: closes(complete, current.journaled) };
        if (final.exited) this.exitedAt.delete(session.id);
        if (keyed(final, complete) !== saved) {
          this.write(tx => {
            const header = headerOf(final.lastActiveAt);
            if (writeSession(tx, header, stateOf(final, complete)) && this.store.status().modules[OUTCOMES_MODULE] === "ready") {
              refreshOutcomeCostsForSessions(tx, [{ sessionId: session.id, runId: header.team?.runId, memberId: header.team?.memberId, exited: final.exited }], this.config.usage?.prices);
            }
          });
        }
      }
      if (nextOffset !== undefined) this.backlogOffset = nextOffset;
      if (!this.closed) {
        this.lastReconciledAt = this.clock();
        this.tickFailed = false;
      }
      if (wroteRecords) try { this.onWritten?.(); } catch {}
    } catch (error) {
      if (!this.tickFailed) console.warn(`[Infinite] The usage ledger could not record this tick: ${error instanceof Error ? error.message : String(error)}`);
      this.tickFailed = true;
    } finally { this.ticking = false; }
  }

  private importOnce(): boolean {
    if (this.store.status().modules[usageModule.name] !== "ready") return false;
    try {
      if (this.store.read(db => importState(db)) === "done") return true;
      const sealed = this.sealedLedger();
      this.write(tx => importLedger(tx, sealed.ledger, sealed.outcome));
      return true;
    } catch {
      console.warn("[Infinite] The usage ledger could not be imported and stays unavailable until the next start.");
      return false;
    }
  }
  private sealedLedger(): { outcome: "imported" | "absent" | "unreadable"; ledger?: SealedLedger } {
    const file = join(this.config.stateDir, "usage.sealed");
    if (!existsSync(file)) return { outcome: "absent" };
    try {
      const stored = unseal<SealedLedger>(this.key, SCOPE, readFileSync(file, "utf8"));
      if (!isRecord(stored) || !isRecord(stored.rows) || !isRecord(stored.cursors) || !isRecord(stored.sessions)) throw new Error("unexpected ledger shape");
      const objects = <T>(value: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => isRecord(item))) as Record<string, T>;
      return { outcome: "imported", ledger: {
        cursors: stored.cursors as Record<string, number>,
        sessions: objects<SealedLedger["sessions"][string]>(stored.sessions),
        rows: objects<UsageRecord>(stored.rows),
        briefings: objects<SealedLedger["briefings"][string]>(stored.briefings as Record<string, unknown> | undefined),
      } };
    } catch (error) {
      console.warn(`[Infinite] The usage ledger cannot be read and is rebuilt from session journals: ${error instanceof Error ? error.message : String(error)}`);
      return { outcome: "unreadable" };
    }
  }

  private ledger(): Ledger {
    if (!this.available()) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    const now = Date.now();
    if (this.kept && now >= this.keptAt && now - this.keptAt < LEDGER_KEEP_MS) return this.kept;
    this.kept = undefined;
    if (this.failedAt !== undefined && now >= this.failedAt && now - this.failedAt < LEDGER_KEEP_MS) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    let data: { sessions: StoredSession[]; records: { sessionId: string; record: UsageRecord }[]; briefings: Snapshot["briefings"] };
    try {
      data = this.store.read(db => ({ sessions: readSessions(db), records: readRecords(db), briefings: readBriefings(db) }));
    } catch {
      this.failedAt = now;
      throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    }
    this.failedAt = undefined;
    const byId = new Map<string, StoredSession>(), members = new Map<string, StoredSession[]>();
    const byProject = new Map<string, StoredSession[]>(), byRun = new Map<string, StoredSession[]>();
    const briefingsByProject = new Map<string, Snapshot["briefings"]>();
    for (const session of data.sessions) {
      Object.freeze(session);
      byId.set(session.sessionId, session);
      (byProject.get(session.projectId) ?? byProject.set(session.projectId, []).get(session.projectId)!).push(session);
      if (session.runId !== undefined) {
        (byRun.get(session.runId) ?? byRun.set(session.runId, []).get(session.runId)!).push(session);
      }
      if (session.runId === undefined || session.memberId === undefined) continue;
      const key = memberKey(session.runId, session.memberId);
      (members.get(key) ?? members.set(key, []).get(key)!).push(session);
    }
    for (const row of data.briefings) {
      (briefingsByProject.get(row.projectId) ?? briefingsByProject.set(row.projectId, []).get(row.projectId)!).push(row);
    }
    const bySession = new Map<string, UsageRecord[]>(), order = new Map<UsageRecord, number>();
    data.records.forEach(({ sessionId, record }, index) => {
      const session = byId.get(sessionId);
      if (!session || !measured(session)) return;
      order.set(record, index);
      (bySession.get(sessionId) ?? bySession.set(sessionId, []).get(sessionId)!).push(record);
    });
    for (const list of members.values()) Object.freeze(list);
    for (const list of byProject.values()) Object.freeze(list);
    for (const list of byRun.values()) Object.freeze(list);
    for (const list of briefingsByProject.values()) Object.freeze(list);
    for (const list of bySession.values()) Object.freeze(list);
    this.kept = { sessions: Object.freeze(data.sessions), byId, byMember: members, byProject, byRun, bySession, order, briefings: Object.freeze(data.briefings) as Snapshot["briefings"], briefingsByProject };
    this.keptAt = now;
    return this.kept;
  }
  private snapshot(options: { taskId?: string } = {}): Snapshot {
    const ledger = this.ledger();
    let taskKey: string | undefined;
    if (options.taskId !== undefined) {
      const taskId = options.taskId;
      try { taskKey = this.store.read(db => db.index("task", taskId)); }
      catch { throw new EvidenceError("unavailable", "The usage ledger is unavailable."); }
    }
    return {
      sessions: ledger.sessions as StoredSession[],
      bySession: ledger.bySession,
      briefings: ledger.briefings,
      byProject: ledger.byProject,
      byRun: ledger.byRun,
      briefingsByProject: ledger.briefingsByProject,
      ...(taskKey === undefined ? {} : { taskKey }),
    };
  }
  private price(record: UsageRecord): { cost: number; pricing: Pricing } {
    return record.provider === "opencode" ? priceUsage(record, this.config.usage?.prices) : { cost: 0, pricing: "unknown" };
  }
  private listMoney(records: UsageRecord[]): Money {
    return this.money(records.map(record => listPriceUsage(record, this.config.usage?.prices)));
  }
  private priced(records: UsageRecord[]) {
    return records.map(record => ({ ...this.price(record), tokens: record.tokens }));
  }
  private measuredRecords(data: Snapshot, projectId?: string) {
    const sessions = projectId === undefined ? data.sessions : (data.byProject.get(projectId) ?? []);
    const rows: { id: string; projectId: string; record: UsageRecord; cost: number; pricing: Pricing }[] = [];
    for (const session of sessions) {
      if (!measured(session)) continue;
      const records = data.bySession.get(session.sessionId);
      if (!records) continue;
      for (const record of records) rows.push({ id: session.sessionId, projectId: session.projectId, record, ...this.price(record) });
    }
    return rows;
  }
  private allMeasuredRecords(data: Snapshot, projectId?: string) {
    const briefings = projectId === undefined ? data.briefings : (data.briefingsByProject.get(projectId) ?? []);
    const rows = this.measuredRecords(data, projectId);
    for (const row of briefings) {
      if (row.record) rows.push({ id: `briefing:${row.at}`, projectId: row.projectId, record: row.record, ...this.price(row.record) });
    }
    return rows;
  }
  private money(rows: { cost: number; pricing: string }[]): Money { return { usd: Math.round(rows.reduce((sum, row) => sum + row.cost, 0) * 1_000_000) / 1_000_000, unpriced: rows.filter(row => row.pricing === "unknown").length }; }
  private dateKey(at: string, tz: string) {
    let formatter = this.dateFormatters.get(tz);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      if (this.dateFormatters.size >= 64) this.dateFormatters.delete(this.dateFormatters.keys().next().value!);
      this.dateFormatters.set(tz, formatter);
    }
    let year = "", month = "", day = "";
    for (const part of formatter.formatToParts(new Date(at))) {
      if (part.type === "year") year = part.value;
      else if (part.type === "month") month = part.value;
      else if (part.type === "day") day = part.value;
    }
    return `${year}-${month}-${day}`;
  }
  daily({ days, tz = "UTC", projectId, now = new Date() }: { days: number; tz?: string; projectId?: string; now?: Date }) {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new RangeError("days must be between 1 and 366");
    this.dateKey(now.toISOString(), tz);
    return this.dailyFrom(this.snapshot(), { days, tz, projectId, now });
  }
  private dailyFrom(data: Snapshot, { days, tz, projectId, now }: { days: number; tz: string; projectId?: string; now: Date }, precomputed?: ReturnType<UsageService["allMeasuredRecords"]>) {
    const last = this.dateKey(now.toISOString(), tz), [year, month, day] = last.split("-").map(Number), date = new Date(Date.UTC(year, month - 1, day));
    const dates = Array.from({ length: days }, (_, index) => { const d = new Date(date.getTime() - (days - index - 1) * 86_400_000); return d.toISOString().slice(0, 10); });
    const accounts = new Set<string>(Object.keys(this.config.usage?.accounts ?? {})), map = new Map(dates.map(key => [key, {} as Record<string, number>]));
    const rows = precomputed ?? this.allMeasuredRecords(data, projectId);
    for (const row of rows) {
      if (projectId && row.projectId !== projectId) continue;
      const key = this.dateKey(row.record.completedAt, tz), account = accountOf(row.record.providerId, row.record.modelId, this.config.usage?.accounts ?? {});
      accounts.add(account); if (map.has(key)) map.get(key)![account] = (map.get(key)![account] ?? 0) + row.cost;
    }
    return { tz, accounts: [...accounts].sort(), days: dates.map(date => { const byAccount = map.get(date)!; const rounded = Object.fromEntries(Object.entries(byAccount).map(([id, usd]) => [id, Math.round(usd * 1_000_000) / 1_000_000])); return { date, usd: Math.round(Object.values(rounded).reduce((a, b) => a + b, 0) * 1_000_000) / 1_000_000, byAccount: rounded }; }) };
  }
  projects({ tz = "UTC", now = new Date() }: { tz?: string; now?: Date }) {
    this.dateKey(now.toISOString(), tz);
    const data = this.snapshot();
    const ids = new Set([...data.sessions.map(s => s.projectId), ...data.briefings.map(b => b.projectId)]);
    const byProject = new Map<string, ReturnType<UsageService["allMeasuredRecords"]>>();
    for (const row of this.allMeasuredRecords(data)) {
      (byProject.get(row.projectId) ?? byProject.set(row.projectId, []).get(row.projectId)!).push(row);
    }
    const monthStart = periodStart("month", now);
    const monthStartMs = monthStart.getTime(), nowMs = now.getTime();
    return { projects: [...ids].map(id => {
      const projectRecords = byProject.get(id) ?? [];
      const rows = projectRecords.map(row => ({ ...row, at: row.record.completedAt }));
      const recent = this.dailyFrom(data, { days: 30, tz, projectId: id, now }, projectRecords);
      return { id, name: this.resolvers.projectName(id) ?? id, total: this.money(rows), month: { ...this.money(rows.filter(row => { const at = Date.parse(row.at); return at >= monthStartMs && at <= nowMs; })), unmeasured: this.projectUnmeasured(data, id, monthStart, now), partial: this.projectPartial(data, id, monthStart, now) }, unmeasured: this.projectUnmeasured(data, id), partial: this.projectPartial(data, id), spark: recent.days.map(day => day.usd) };
    }).sort((a, b) => b.total.usd - a.total.usd) };
  }
  private projectUnmeasured(data: Snapshot, id: string, from?: Date, to?: Date) {
    const sessions = data.byProject.get(id) ?? [];
    const briefings = data.briefingsByProject.get(id) ?? [];
    return sessions.filter(session => !measured(session) && inWindow(session.lastActiveAt ?? session.createdAt, from, to)).length
      + briefings.filter(row => !row.record && inWindow(row.at, from, to)).length;
  }
  private projectPartial(data: Snapshot, id: string, from?: Date, to?: Date) {
    const sessions = data.byProject.get(id) ?? [];
    return sessions.filter(session => partial(session) && inWindow(session.lastActiveAt ?? session.createdAt, from, to)).length;
  }
  private projectRows(data: Snapshot, id: string) {
    return this.allMeasuredRecords(data, id).map(row => ({ ...row, at: row.record.completedAt }));
  }
  private byPurpose(data: Snapshot, id: string): Record<SessionPurpose, { total: Money; members: number }> {
    const members = (data.byProject.get(id) ?? []).filter(session => session.runId !== undefined && session.memberId !== undefined);
    return Object.fromEntries(SESSION_PURPOSES.map(purpose => {
      const mine = members.filter(session => session.purpose === purpose);
      const records = this.priced(mine.filter(measured).flatMap(session => data.bySession.get(session.sessionId) ?? []));
      const distinct = new Set(mine.map(session => JSON.stringify([session.runId, session.memberId])));
      return [purpose, { total: this.money(records), members: distinct.size }];
    })) as Record<SessionPurpose, { total: Money; members: number }>;
  }
  project(id: string, { tz = "UTC", now = new Date() }: { tz?: string; now?: Date } = {}) {
    this.dateKey(now.toISOString(), tz);
    const data = this.snapshot();
    const sessions = data.byProject.get(id) ?? [], briefings = data.briefingsByProject.get(id) ?? [];
    if (!sessions.length && !briefings.length) return undefined;
    const total = this.money(this.projectRows(data, id)), unmeasured = this.projectUnmeasured(data, id), partialCount = this.projectPartial(data, id), grouped = { goals: [] as any[], teams: [] as any[], sessions: [] as any[], briefings: [] as any[] };
    const resolved = new Map<string, ReturnType<UsageResolvers["goalOfRun"]>>();
    const goalOfRun = (runId: string) => {
      if (!resolved.has(runId)) resolved.set(runId, this.resolvers.goalOfRun(runId));
      return resolved.get(runId);
    };
    for (const session of sessions) {
      const records = this.priced(data.bySession.get(session.sessionId) ?? []), sum = this.money(records);
      if (!measured(session)) continue;
      if (session.runId !== undefined) {
        const goal = goalOfRun(session.runId), prior = grouped.teams.find(row => row.id === session.runId);
        if (prior) { prior.total.usd = Math.round((prior.total.usd + sum.usd) * 1_000_000) / 1_000_000; prior.total.unpriced += sum.unpriced; }
        else grouped.teams.push({ id: session.runId, title: this.resolvers.runTitle(session.runId) ?? session.runId, total: sum, ...(goal ? { goalId: goal.id } : {}) });
      }
      else grouped.sessions.push({ id: session.sessionId, title: this.resolvers.sessionTitle(session.sessionId) ?? session.sessionId, total: sum });
    }
    for (const row of briefings) { const cost = row.record ? this.price(row.record) : undefined; grouped.briefings.push({ row, cost }); }
    const goals = new Map<string, { id: string; title: string; total: Money; tasks: number }>(), goalTasks = new Map<string, Set<string>>();
    for (const row of grouped.teams.filter(item => item.goalId)) {
      const goal = goalOfRun(row.id)!; const current = goals.get(goal.id) ?? { id: goal.id, title: goal.title, total: { usd: 0, unpriced: 0 }, tasks: 0 };
      current.total.usd = Math.round((current.total.usd + row.total.usd) * 1_000_000) / 1_000_000; current.total.unpriced += row.total.unpriced; goals.set(goal.id, current);
      const ids = goalTasks.get(goal.id) ?? new Set<string>(); for (const session of data.byRun.get(row.id) ?? []) { if (!session.taskKey) continue; ids.add(`${row.id}/${session.taskKey}`); } goalTasks.set(goal.id, ids);
    }
    for (const [goalId, row] of goals) row.tasks = goalTasks.get(goalId)?.size ?? 0;
    const briefingMoney = this.money(grouped.briefings.flatMap(({ cost }) => cost ? [cost] : []));
    return { id, name: this.resolvers.projectName(id) ?? id, total, unmeasured, partial: partialCount, byPurpose: this.byPurpose(data, id), byKind:{ goals: [...goals.values()].reduce((n, g) => n + g.total.usd, 0), teams: grouped.teams.filter(row => !row.goalId).reduce((n, x) => n + x.total.usd, 0), sessions: grouped.sessions.reduce((n, x) => n + x.total.usd, 0), briefings: briefingMoney.usd }, goals: [...goals.values()], teams: grouped.teams, sessions: grouped.sessions, briefings: { total: briefingMoney, runs: briefings.length, unmeasured: briefings.filter(row => !row.record).length } };
  }
  taskUsage(runId: string, taskId: string, revision: number): TaskUsage | undefined {
    let data: Snapshot;
    try { data = this.snapshot({ taskId }); } catch { return undefined; }
    const sessions = (data.byRun.get(runId) ?? []).filter(session => session.taskKey === data.taskKey && session.revision === revision);
    if (!sessions.length) return undefined;
    const rows = sessions.flatMap(session => data.bySession.get(session.sessionId) ?? []), totals = this.priced(rows), sum = sumUsage(totals);
    if (!rows.length) return undefined;
    const ordered = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId));
    const coverage = combineCoverage(ordered.map(session => ({ coverage: session.coverage, coverageReason: session.reason })));
    return { usd: sum.cost, unpriced: totals.filter(row => row.pricing === "unknown").length, tokens: Object.values(sum.tokens).reduce((a, b) => a + b, 0), attempts: new Set(sessions.map(session => session.memberId)).size, profiles: [...new Set(sessions.map(session => session.profileId).filter((id): id is string => Boolean(id)))].sort(),
      coverage: coverage.coverage as "partial" | "complete", ...(coverage.reason ? { coverageReason: coverage.reason } : {}) };
  }
  recordBriefing(projectId: string, sessionId: string, at: string, usage: BriefingUsage | null) {
    const record = usage ? { provider: "opencode" as const, providerId: usage.providerId, modelId: usage.modelId, messageId: sessionId, partId: at, modelSource: "reported" as const, completedAt: at, tokens: usage.tokens, reportedCost: usage.reportedCost ?? 0 } : undefined;
    const checked = record === undefined ? undefined : ledgerRecord(record);
    if (record && !checked) console.warn("[Infinite] A usage briefing record is invalid and is stored without its figures.");
    if (!this.available()) return void console.warn("[Infinite] A usage briefing was lost because the usage ledger is unavailable.");
    try {
      this.write(tx => writeBriefing(tx, `${sessionId}/${at}`, projectId, at, checked));
    } catch {
      console.warn("[Infinite] A usage briefing was lost because the usage ledger could not store it.");
    }
  }

  session(sessionId: string): SessionUsage | UnmeasuredUsage {
    let data: Ledger;
    try { data = this.ledger(); } catch { return { measured: false, coverage: "none", unavailable: true }; }
    const session = data.byId.get(sessionId);
    if (!session || !measured(session)) return { measured: false, coverage: "none", ...(session?.reason ? { coverageReason: session.reason } : {}) };
    const rows = data.bySession.get(sessionId) ?? [];
    return { ...sumUsage(this.priced(rows)), measured: true, coverage: session.coverage as "partial" | "complete", list: this.listMoney(rows), ...(session.reason ? { coverageReason: session.reason } : {}) };
  }
  member(runId: string, memberId: string): SessionUsage | UnmeasuredUsage {
    let data: Ledger;
    try { data = this.ledger(); } catch { return { measured: false, coverage: "none", unavailable: true }; }
    const sessions = data.byMember.get(memberKey(runId, memberId)) ?? [];
    const ordered = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId));
    const coverage = combineCoverage(ordered.map(session => ({ coverage: session.coverage, coverageReason: session.reason })));
    if (coverage.coverage === "none") return { measured: false, coverage: "none" };
    const rows = sessions.flatMap(session => data.bySession.get(session.sessionId) ?? []).sort((a, b) => data.order.get(a)! - data.order.get(b)!);
    return { ...sumUsage(this.priced(rows)), measured: true, coverage: coverage.coverage as "partial" | "complete", list: this.listMoney(rows), ...(coverage.reason ? { coverageReason: coverage.reason } : {}) };
  }
  memberFinal(runId: string, memberId: string): SessionUsage | UnmeasuredUsage {
    let data: Ledger;
    try { data = this.ledger(); } catch { return { measured: false, coverage: "none", unavailable: true }; }
    const sessions = data.byMember.get(memberKey(runId, memberId)) ?? [];
    if (!sessions.length) return { measured: false, coverage: "none" };
    const ordered = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId));
    if (ordered.some(session => !session.exited)) return { measured: false, coverage: "none", coverageReason: "running" };
    if (ordered.every(session => session.coverage === "none")) {
      const reason = ordered.find(session => session.reason)?.reason;
      return { measured: false, coverage: "none", ...(reason ? { coverageReason: reason } : {}) };
    }
    const incomplete = ordered.find(session => session.coverage !== "complete" && session.reason)
      ?? ordered.find(session => session.coverage !== "complete");
    const rows = ordered.flatMap(session => data.bySession.get(session.sessionId) ?? []).sort((a, b) => data.order.get(a)! - data.order.get(b)!);
    if (incomplete) {
      return {
        ...sumUsage(this.priced(rows)),
        measured: true,
        coverage: "partial",
        ...(incomplete.reason ? { coverageReason: incomplete.reason } : {}),
      };
    }
    return { ...sumUsage(this.priced(rows)), measured: true, coverage: "complete" };
  }
  sessions(ids: string[]): UsageTotals {
    let data: Ledger;
    try { data = this.ledger(); } catch { return sumUsage([]); }
    return sumUsage(this.priced(ids.flatMap(id => data.bySession.get(id) ?? [])));
  }

  private ingestionGap(provider: Provider, projectId?: string): "read-failed" | "ingestion-incomplete" | undefined {
    let incomplete = false;
    for (const gap of this.ingestionGaps.values()) {
      if (gap.provider !== provider) continue;
      if (projectId !== undefined && gap.projectId !== projectId) continue;
      if (gap.reason === "read-failed") return "read-failed";
      incomplete = true;
    }
    return incomplete ? "ingestion-incomplete" : undefined;
  }

  private providerWindow(data: Snapshot, provider: Provider, period: Period, now: Date, includePrevious: boolean, projectId?: string) {
    const start = periodStart(period, now);
    const end = periodEnd(period, start);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const nowMs = now.getTime();
    const observed = provider === "opencode";
    const baseSessions = projectId === undefined ? data.sessions : (data.byProject.get(projectId) ?? []);
    const briefings = provider === "opencode"
      ? (projectId === undefined ? data.briefings : (data.briefingsByProject.get(projectId) ?? []))
      : [];
    const measuredSessions: StoredSession[] = [];
    let unmeasuredSessions = 0, partialSessions = 0, recordingErrorSessions = 0;
    for (const s of baseSessions) {
      if (s.provider !== provider) continue;
      if (measured(s)) measuredSessions.push(s);
      const overlaps = sessionOverlaps(s, data.bySession.get(s.sessionId), startMs, endMs);
      if (!overlaps) continue;
      if (!measured(s)) unmeasuredSessions++;
      if (partial(s)) partialSessions++;
      if (s.coverage === "partial" && s.reason === "recording-error") recordingErrorSessions++;
    }
    if (provider === "opencode") {
      for (const row of briefings) {
        if (!row.record) {
          const at = Date.parse(row.at);
          if (at >= startMs && at <= nowMs) unmeasuredSessions++;
        }
      }
    }
    const within = (from: Date, to: Date) => {
      const fromMs = from.getTime(), toMs = to.getTime();
      const rows = this.priced(measuredSessions.flatMap(s => data.bySession.get(s.sessionId) ?? [])
        .filter(record => { const at = Date.parse(record.completedAt); return at >= fromMs && at < toMs; }));
      if (provider === "opencode") {
        for (const row of briefings) {
          if (!row.record) continue;
          const at = Date.parse(row.at);
          if (at >= fromMs && at < toMs) rows.push(...this.priced([row.record]));
        }
      }
      return rows;
    };
    const current = sumUsage(within(start, new Date(nowMs + 1)));
    const previous = includePrevious && observed ? sumUsage(within(periodStart(period, new Date(startMs - 1)), start)) : undefined;
    return { start, end, observed, unmeasuredSessions, partialSessions, recordingErrorSessions, current, previous };
  }

  providerSpend(provider: Provider, period: Period, now = new Date(), projectId?: string): ProviderSpendSnapshot {
    const start = periodStart(period, now);
    const end = periodEnd(period, start);
    const window = { kind: period, start: start.toISOString(), end: end.toISOString() };
    const scoped = projectId === undefined ? {} : { projectId };
    let data: Snapshot;
    try {
      data = this.snapshot();
    } catch {
      return { measured: false, provider, ...scoped, period: window, reason: "ledger-unavailable" };
    }
    const metrics = this.providerWindow(data, provider, period, now, false, projectId);
    if (!metrics.observed) {
      return {
        measured: false,
        provider,
        ...scoped,
        period: window,
        reason: "provider-unmeasured",
        tokens: metrics.current.tokens,
        messages: metrics.current.messages,
        unmeasuredSessions: metrics.unmeasuredSessions,
        partialSessions: metrics.partialSessions,
      };
    }
    const unpriced = metrics.current.pricing.unknown;
    const reconciliation = this.lastReconciledAt === undefined ? "reconciliation-pending" as const
      : this.clock() - this.lastReconciledAt > this.reconcileStaleMs ? "reconciliation-stale" as const
      : undefined;
    const ingestion = this.ingestionGap(provider, projectId);
    const baseSessions = projectId === undefined ? data.sessions : (data.byProject.get(projectId) ?? []);
    const undrainedStored = baseSessions.some(session => session.provider === provider
      && !session.exited && session.coverage === "partial" && session.reason === "drain-incomplete");
    const gap = reconciliation !== undefined ? reconciliation
      : ingestion !== undefined ? ingestion
      : undrainedStored ? "ingestion-incomplete" as const
      : metrics.recordingErrorSessions > 0 ? "recording-error" as const
      : metrics.unmeasuredSessions > 0 ? "unmeasured-sessions" as const
      : metrics.partialSessions > 0 ? "partial-sessions" as const
      : unpriced > 0 ? "unpriced-records" as const
      : undefined;
    if (gap !== undefined) {
      return {
        measured: false,
        provider,
        ...scoped,
        period: window,
        reason: gap,
        usd: metrics.current.cost,
        tokens: metrics.current.tokens,
        messages: metrics.current.messages,
        unpriced,
        unmeasuredSessions: metrics.unmeasuredSessions,
        partialSessions: metrics.partialSessions,
      };
    }
    return {
      measured: true,
      provider,
      ...scoped,
      period: window,
      usd: metrics.current.cost,
      tokens: metrics.current.tokens,
      messages: metrics.current.messages,
      unpriced: 0,
      unmeasuredSessions: 0,
      partialSessions: 0,
    };
  }

  summary(now = new Date()): UsageSummary {
    const data = this.snapshot();
    const monthStart = periodStart("month", now);
    const providers = {} as UsageSummary["providers"];
    for (const provider of PROVIDERS) {
      const budget = this.config.usage?.budgets[provider];
      const period: Period = budget?.period ?? "month";
      const metrics = this.providerWindow(data, provider, period, now, true);
      providers[provider] = {
        period: { start: metrics.start.toISOString(), end: metrics.end.toISOString() },
        measured: metrics.observed,
        unmeasuredSessions: metrics.unmeasuredSessions,
        partialSessions: metrics.partialSessions,
        recorded: { tokens: metrics.current.tokens, messages: metrics.current.messages },
        ...(metrics.observed ? { spent: metrics.current, previous: metrics.previous } : {}),
        ...(budget ? { budget: { usd: budget.usd, period } } : {}),
      };
    }
    const end = periodEnd("month", monthStart);
    const monthStartMs = monthStart.getTime(), endMs = end.getTime(), nowPlus1Ms = now.getTime() + 1;
    const previousStartMs = periodStart("month", new Date(monthStartMs - 1)).getTime();
    const records = this.allMeasuredRecords(data);
    const currentMonthRows: typeof records = [];
    const previousMonthRows: typeof records = [];
    for (const row of records) {
      const at = Date.parse(row.record.completedAt);
      if (at >= monthStartMs && at < nowPlus1Ms) currentMonthRows.push(row);
      else if (at >= previousStartMs && at < monthStartMs) previousMonthRows.push(row);
    }
    const accountConfigs = this.config.usage?.accounts ?? {};
    const rowsByAccount = new Map<string, typeof records>();
    for (const row of currentMonthRows) {
      const accountId = accountOf(row.record.providerId, row.record.modelId, accountConfigs);
      (rowsByAccount.get(accountId) ?? rowsByAccount.set(accountId, []).get(accountId)!).push(row);
    }
    const accounts: AccountView[] = Object.entries(accountConfigs).map(([id, account]) => {
      const monthRows = rowsByAccount.get(id) ?? [];
      const overridden = account.kind === "subscription" && Object.hasOwn(this.planOverrides, id);
      const planUsd = overridden ? this.planOverrides[id] : account.planUsd;
      const planSource = account.kind === "subscription" ? overridden ? "owner" as const : account.planUsd !== undefined ? "config" as const : undefined : undefined;
      return { id, kind: account.kind, ...(account.kind === "metered" ? { month: this.money(monthRows) } : {}),
        ...(planUsd !== undefined ? { planUsd } : {}), ...(planSource ? { planSource } : {}),
        balance: this.balances?.get(id) ?? null };
    });
    let unmeasuredSessions = 0, partialSessions = 0;
    for (const session of data.sessions) {
      const at = Date.parse(session.lastActiveAt ?? session.createdAt);
      if (!(at >= monthStartMs && at < endMs)) continue;
      if (!measured(session)) unmeasuredSessions++;
      if (partial(session)) partialSessions++;
    }
    for (const row of data.briefings) {
      if (row.record) continue;
      const at = Date.parse(row.at);
      if (at >= monthStartMs && at <= now.getTime()) unmeasuredSessions++;
    }
    return { period: { start: monthStart.toISOString(), end: end.toISOString() }, providers,
      month: { start: monthStart.toISOString(), end: end.toISOString(), spent: this.money(currentMonthRows), previous: this.money(previousMonthRows), plansUsd: accounts.filter(account => account.kind === "subscription").reduce((sum, account) => sum + (account.planUsd ?? 0), 0), unmeasuredSessions,
        partialSessions }, accounts };
  }
}
