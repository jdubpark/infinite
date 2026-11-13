import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Provider } from "./types.js";
import type { Manager } from "./manager.js";
import { writeSealed, unseal } from "./vault.js";
import { accountOf, periodStart, priceUsage, sumUsage, type UsageRecord, type UsageTotals } from "./usage.js";
import { usagePlanSchema, type AccountView, type Balance, type BriefingUsage, type Money, type TaskUsage, type UsageResolvers } from "./usage-api.js";
import { EvidenceError } from "./evidence/types.js";
import type { EvidenceStore } from "./evidence/store.js";
import {
  importLedger, importState, ledgerRecord, readBriefings, readRecords, readSessions, usageModule, writeBriefing, writeRecord, writeSession,
  type LedgerHeader, type LedgerState, type SealedLedger, type StoredSession,
} from "./usage-store.js";

type Period = "day" | "week" | "month";
export interface SessionUsage extends UsageTotals { measured: true }
export type UsageSummary = {
  /** The default month window; each provider carries the window of its own budget period. */
  period: { start: string; end: string };
  providers: Record<Provider, { period: { start: string; end: string }; measured: boolean; spent?: UsageTotals; budget?: { usd: number; period: Period }; previous?: UsageTotals; unmeasuredSessions: number }>;
  month: { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number };
  accounts: AccountView[];
};
/** A session row as `manager.list()` returns it. */
export type UsageSessionRow = Awaited<ReturnType<Manager["list"]>>[number];
/** What the service reads from the store for one call, taken inside one read. Records are kept for measured sessions only. */
type Snapshot = {
  sessions: StoredSession[];
  bySession: Map<string, UsageRecord[]>;
  briefings: { projectId: string; at: string; record?: UsageRecord }[];
  taskKey?: string;
};
/** The state a session row holds after a tick, as the tick compares it with the stored row. */
type Row = Pick<LedgerState, "exited" | "cursor" | "seen" | "refused" | "coverage" | "reason"> & { lastActiveAt?: string };

const PROVIDERS: Provider[] = ["claude", "codex", "grok", "opencode", "demo"];
const PAGE = 200;
/** At most this many journal pages are read in one tick, so a long journal does not hold the team loop. */
const MAX_PAGES = 20;
const periodEnd = (period: Period, start: Date) => period === "month" ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  : new Date(start.getTime() + (period === "week" ? 7 : 1) * 86_400_000);
const SCOPE = "usage";
const PLAN_SCOPE = "usage-plans";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const measured = (session: StoredSession) => session.coverage !== "none";
const same = (a: Row | undefined, b: Row) => a !== undefined && a.exited === b.exited && a.lastActiveAt === b.lastActiveAt && a.cursor === b.cursor
  && a.seen === b.seen && a.refused === b.refused && a.coverage === b.coverage && a.reason === b.reason;

/**
 * The usage ledger on the evidence store. Every other session is counted as unmeasured and never contributes
 * a zero to a total. The sealed `usage.sealed` file is read once, when the store first imports it, and never written.
 */
export class UsageService {
  private index?: Map<string, UsageRecord[]>;
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private ticking = false;
  private imported = false;
  private tickFailed = false;
  private readonly failed = new Set<string>();
  private readonly planFile: string;
  private planOverrides: Record<string, number> = Object.create(null) as Record<string, number>;
  private balances?: { get(id: string): Balance };
  private resolvers: UsageResolvers = { goalOfRun: () => undefined, runTitle: () => undefined, projectName: id => id, sessionTitle: () => undefined };
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly store: EvidenceStore) {
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
  /**
   * Runs the ledger on its own 2 s timer. The host's TeamService drives `tick(rows)` from the session
   * listing it already takes, so this is only for a host composed without one.
   */
  start() {
    if (this.running || this.closed) return;
    this.running = true;
    const tick = () => { void this.tick().catch(() => {}); };
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick();
  }
  close() { this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); }
  useBalances(service: { get(id: string): Balance }) { this.balances = service; }
  useResolvers(resolvers: UsageResolvers) { this.resolvers = resolvers; }

  /** True when the usage module is ready and the sealed ledger's import has been recorded. */
  available(): boolean { return this.imported && this.store.status().modules[usageModule.name] === "ready"; }

  /** Updates a subscription plan override, retaining config as the default. */
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

  /**
   * Folds new journal usage into the store. Each journal page is one write holding its session row and its records,
   * so a failed write leaves the page and its cursor both unstored. `rows` is a listing the caller already took;
   * without one, the manager is asked. A failed write ends the tick with one warning and never throws.
   */
  async tick(rows?: UsageSessionRow[]) {
    if (this.ticking || this.closed || !this.available()) return;
    this.ticking = true;
    try {
      const stored = new Map(this.store.read(db => readSessions(db)).map(row => [row.sessionId, row]));
      let pages = MAX_PAGES;
      for (const session of rows ?? await this.manager.list()) {
        if (this.closed) break;
        const previous = stored.get(session.id);
        if (previous?.exited) continue;
        const observed = session.provider === "opencode" && (session.teamModelProfile ? session.teamModelProfile.provider === "opencode" : !session.team && session.runtime?.nativeUi === "opencode");
        const active = ["starting", "running"].includes(session.status);
        // Refreshed at most once a minute so a running session does not rewrite its row on every tick.
        const stale = !previous?.lastActiveAt || Date.now() - Date.parse(previous.lastActiveAt) > 60_000;
        const lastActiveAt = active && stale ? new Date().toISOString() : previous?.lastActiveAt;
        const header: LedgerHeader = {
          sessionId: session.id, provider: session.provider, projectId: session.projectId, createdAt: session.createdAt,
          ...(lastActiveAt ? { lastActiveAt } : {}),
          ...(session.team ? { team: session.team } : {}), ...(session.teamModelProfile ? { profileId: session.teamModelProfile.id } : {}),
          ...(session.purpose ? { purpose: session.purpose } : {}), ...(session.configId ? { configId: session.configId } : {}),
        };
        const exitedListed = session.status === "exited";
        let current: Row = observed
          ? { exited: false, lastActiveAt, coverage: "complete", cursor: previous?.cursor ?? 0, seen: previous?.seen ?? 0, refused: previous?.refused ?? 0 }
          : { exited: false, lastActiveAt, coverage: "none", reason: "unsupported", cursor: 0, seen: 0, refused: 0 };
        let wrote = previous !== undefined, complete = !observed;
        if (observed) {
          while (!this.closed && pages > 0) {
            let page: ReturnType<Manager["events"]>;
            try {
              page = this.manager.events(session.id, current.cursor, PAGE, new Set(["usage"]));
              this.failed.delete(session.id);
            } catch (error) {
              // One unreadable journal must not strand the rows other sessions produced in this tick.
              if (!this.failed.has(session.id)) {
                this.failed.add(session.id);
                console.warn(`[Infinite] Usage for session ${session.id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
              }
              break;
            }
            pages--;
            const records: UsageRecord[] = [];
            let seen = 0, refused = 0;
            for (const event of page.events) {
              if (event.type !== "usage") continue;
              seen++;
              const record = ledgerRecord(event.data);
              if (record) records.push(record); else refused++;
            }
            const next: Row = { exited: exitedListed && !page.more, lastActiveAt, coverage: "complete", cursor: page.cursor,
              seen: current.seen + seen, refused: current.refused + refused };
            if (!same(current, next)) {
              const stored = this.store.write(tx => {
                if (!writeSession(tx, header, { coverage: next.coverage, cursor: next.cursor, seen: next.seen, refused: next.refused, exited: next.exited })) return false;
                for (const record of records) writeRecord(tx, session.id, record);
                return true;
              });
              if (!stored) {
                console.warn(`[Infinite] Usage for session ${session.id} cannot be stored and is read again next tick.`);
                break;
              }
              wrote = true;
              current = next;
            }
            if (!page.more) { complete = true; break; }
          }
        }
        // The session closes only when its journal was read to its end and it is listed as exited.
        const final: Row = { ...current, exited: complete && exitedListed };
        if (!wrote || !same(current, final)) {
          this.store.write(tx => writeSession(tx, header, { coverage: final.coverage, ...(final.reason ? { reason: final.reason } : {}),
            cursor: final.cursor, seen: final.seen, refused: final.refused, exited: final.exited }));
        }
      }
      this.tickFailed = false;
    } catch (error) {
      if (!this.tickFailed) console.warn(`[Infinite] The usage ledger could not record this tick: ${error instanceof Error ? error.message : String(error)}`);
      this.tickFailed = true;
    } finally { this.ticking = false; }
  }

  /**
   * Imports the sealed ledger once, in one write. An unreadable file is recorded as its outcome and never retried.
   * A failed import leaves the ledger unavailable until the next start.
   */
  private importOnce(): boolean {
    if (this.store.status().modules[usageModule.name] !== "ready") return false;
    try {
      if (this.store.read(db => importState(db)) === "done") return true;
      const sealed = this.sealedLedger();
      this.store.write(tx => importLedger(tx, sealed.ledger, sealed.outcome));
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
      // Entries that are not objects are dropped here, so one malformed entry cannot fail the whole import.
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

  /**
   * Reads the ledger inside one store read. A failure of the store, or an unavailable ledger, throws `unavailable`.
   * Only the store's read is guarded, so an invalid argument still throws its own error.
   */
  private snapshot(options: { sessionIds?: string[]; taskId?: string } = {}): Snapshot {
    if (!this.available()) throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    let data: { sessions: StoredSession[]; records: { sessionId: string; record: UsageRecord }[]; briefings: Snapshot["briefings"]; taskKey?: string };
    try {
      data = this.store.read(db => ({
        sessions: readSessions(db),
        records: readRecords(db, options.sessionIds ? { sessionIds: options.sessionIds } : {}),
        briefings: readBriefings(db),
        taskKey: options.taskId === undefined ? undefined : db.index("task", options.taskId),
      }));
    } catch {
      throw new EvidenceError("unavailable", "The usage ledger is unavailable.");
    }
    const measuredIds = new Set(data.sessions.filter(measured).map(session => session.sessionId));
    const bySession = new Map<string, UsageRecord[]>();
    for (const { sessionId, record } of data.records) {
      if (!measuredIds.has(sessionId)) continue;
      (bySession.get(sessionId) ?? bySession.set(sessionId, []).get(sessionId)!).push(record);
    }
    return { sessions: data.sessions, bySession, briefings: data.briefings, ...(data.taskKey === undefined ? {} : { taskKey: data.taskKey }) };
  }
  private priced(records: UsageRecord[]) {
    return records.map(record => ({ ...priceUsage(record, this.config.usage?.prices), tokens: record.tokens }));
  }
  private measuredRecords(data: Snapshot) {
    const sessions = new Map(data.sessions.map(session => [session.sessionId, session]));
    return [...data.bySession].flatMap(([id, records]) => { const session = sessions.get(id); return session ? records.map(record => ({ id, projectId: session.projectId, record, ...priceUsage(record, this.config.usage?.prices) })) : []; });
  }
  private allMeasuredRecords(data: Snapshot) {
    return [...this.measuredRecords(data), ...data.briefings.flatMap(row => row.record ? [{ id: `briefing:${row.at}`, projectId: row.projectId, record: row.record, ...priceUsage(row.record, this.config.usage?.prices) }] : [])];
  }
  private money(rows: { cost: number; pricing: string }[]): Money { return { usd: Math.round(rows.reduce((sum, row) => sum + row.cost, 0) * 1_000_000) / 1_000_000, unpriced: rows.filter(row => row.pricing === "unknown").length }; }
  private dateKey(at: string, tz: string) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
    const value = Object.fromEntries(parts.map(part => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`;
  }
  daily({ days, tz = "UTC", projectId, now = new Date() }: { days: number; tz?: string; projectId?: string; now?: Date }) {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new RangeError("days must be between 1 and 366");
    this.dateKey(now.toISOString(), tz);
    return this.dailyFrom(this.snapshot(), { days, tz, projectId, now });
  }
  private dailyFrom(data: Snapshot, { days, tz, projectId, now }: { days: number; tz: string; projectId?: string; now: Date }) {
    const last = this.dateKey(now.toISOString(), tz), [year, month, day] = last.split("-").map(Number), date = new Date(Date.UTC(year, month - 1, day));
    const dates = Array.from({ length: days }, (_, index) => { const d = new Date(date.getTime() - (days - index - 1) * 86_400_000); return d.toISOString().slice(0, 10); });
    const accounts = new Set<string>(Object.keys(this.config.usage?.accounts ?? {})), map = new Map(dates.map(key => [key, {} as Record<string, number>]));
    for (const row of this.allMeasuredRecords(data)) {
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
    return { projects: [...ids].map(id => { const rows = this.projectRows(data, id), recent = this.dailyFrom(data, { days: 30, tz, projectId: id, now }), monthStart = periodStart("month", now); return { id, name: this.resolvers.projectName(id) ?? id, total: this.money(rows), month: { ...this.money(rows.filter(row => { const at = Date.parse(row.at); return at >= monthStart.getTime() && at <= now.getTime(); })), unmeasured: this.projectUnmeasured(data, id, monthStart, now) }, unmeasured: this.projectUnmeasured(data, id), spark: recent.days.map(day => day.usd) }; }).sort((a, b) => b.total.usd - a.total.usd) };
  }
  private projectUnmeasured(data: Snapshot, id: string, from?: Date, to?: Date) {
    const inRange = (at: string) => { const time = Date.parse(at); return (!from || time >= from.getTime()) && (!to || time <= to.getTime()); };
    return data.sessions.filter(session => session.projectId === id && !measured(session) && inRange(session.lastActiveAt ?? session.createdAt)).length
      + data.briefings.filter(row => row.projectId === id && !row.record && inRange(row.at)).length;
  }
  private projectRows(data: Snapshot, id: string) {
    return this.allMeasuredRecords(data).filter(row => row.projectId === id).map(row => ({ ...row, at: row.record.completedAt }));
  }
  project(id: string, { tz = "UTC", now = new Date() }: { tz?: string; now?: Date } = {}) {
    this.dateKey(now.toISOString(), tz);
    const data = this.snapshot();
    const sessions = data.sessions.filter(session => session.projectId === id), briefings = data.briefings.filter(row => row.projectId === id);
    if (!sessions.length && !briefings.length) return undefined;
    const total = this.money(this.projectRows(data, id)), unmeasured = this.projectUnmeasured(data, id), grouped = { goals: [] as any[], teams: [] as any[], sessions: [] as any[], briefings: [] as any[] };
    for (const session of sessions) {
      const records = this.priced(data.bySession.get(session.sessionId) ?? []), sum = this.money(records);
      if (!measured(session)) continue;
      if (session.runId !== undefined) {
        const goal = this.resolvers.goalOfRun(session.runId), prior = grouped.teams.find(row => row.id === session.runId);
        if (prior) { prior.total.usd = Math.round((prior.total.usd + sum.usd) * 1_000_000) / 1_000_000; prior.total.unpriced += sum.unpriced; }
        else grouped.teams.push({ id: session.runId, title: this.resolvers.runTitle(session.runId) ?? session.runId, total: sum, ...(goal ? { goalId: goal.id } : {}) });
      }
      else grouped.sessions.push({ id: session.sessionId, title: this.resolvers.sessionTitle(session.sessionId) ?? session.sessionId, total: sum });
    }
    for (const row of briefings) { const cost = row.record ? priceUsage(row.record, this.config.usage?.prices) : undefined; grouped.briefings.push({ row, cost }); }
    const goals = new Map<string, { id: string; title: string; total: Money; tasks: number }>(), goalTasks = new Map<string, Set<string>>();
    for (const row of grouped.teams.filter(item => item.goalId)) {
      const goal = this.resolvers.goalOfRun(row.id)!; const current = goals.get(goal.id) ?? { id: goal.id, title: goal.title, total: { usd: 0, unpriced: 0 }, tasks: 0 };
      current.total.usd = Math.round((current.total.usd + row.total.usd) * 1_000_000) / 1_000_000; current.total.unpriced += row.total.unpriced; goals.set(goal.id, current);
      const ids = goalTasks.get(goal.id) ?? new Set<string>(); for (const session of data.sessions) { if (!session.runId || session.runId !== row.id || !session.taskKey) continue; ids.add(`${row.id}/${session.taskKey}`); } goalTasks.set(goal.id, ids);
    }
    for (const [goalId, row] of goals) row.tasks = goalTasks.get(goalId)?.size ?? 0;
    const briefingMoney = this.money(grouped.briefings.flatMap(({ cost }) => cost ? [cost] : []));
    return { id, name: this.resolvers.projectName(id) ?? id, total, unmeasured, byKind: { goals: [...goals.values()].reduce((n, g) => n + g.total.usd, 0), teams: grouped.teams.filter(row => !row.goalId).reduce((n, x) => n + x.total.usd, 0), sessions: grouped.sessions.reduce((n, x) => n + x.total.usd, 0), briefings: briefingMoney.usd }, goals: [...goals.values()], teams: grouped.teams, sessions: grouped.sessions, briefings: { total: briefingMoney, runs: briefings.length, unmeasured: briefings.filter(row => !row.record).length } };
  }
  taskUsage(runId: string, taskId: string, revision: number): TaskUsage | undefined {
    let data: Snapshot;
    try { data = this.snapshot({ taskId }); } catch { return undefined; }
    const sessions = data.sessions.filter(session => session.runId === runId && session.taskKey === data.taskKey && session.revision === revision);
    if (!sessions.length) return undefined;
    const rows = sessions.flatMap(session => data.bySession.get(session.sessionId) ?? []), totals = this.priced(rows), sum = sumUsage(totals);
    if (!rows.length) return undefined;
    return { usd: sum.cost, unpriced: totals.filter(row => row.pricing === "unknown").length, tokens: Object.values(sum.tokens).reduce((a, b) => a + b, 0), attempts: new Set(sessions.map(session => session.memberId)).size, profiles: [...new Set(sessions.map(session => session.profileId).filter((id): id is string => Boolean(id)))].sort() };
  }
  /** A briefing whose record is refused is stored without its record. A briefing the store cannot take is lost with one warning. */
  recordBriefing(projectId: string, sessionId: string, at: string, usage: BriefingUsage | null) {
    const record = usage ? { provider: "opencode" as const, providerId: usage.providerId, modelId: usage.modelId, messageId: sessionId, partId: at, modelSource: "reported" as const, completedAt: at, tokens: usage.tokens, reportedCost: usage.reportedCost ?? 0 } : undefined;
    const checked = record === undefined ? undefined : ledgerRecord(record);
    if (record && !checked) console.warn("[Infinite] A usage briefing record is invalid and is stored without its figures.");
    if (!this.available()) return void console.warn("[Infinite] A usage briefing was lost because the usage ledger is unavailable.");
    try {
      this.store.write(tx => writeBriefing(tx, `${sessionId}/${at}`, projectId, at, checked));
    } catch {
      console.warn("[Infinite] A usage briefing was lost because the usage ledger could not store it.");
    }
  }

  session(sessionId: string): SessionUsage | { measured: false; unavailable?: true } {
    let data: Snapshot;
    try { data = this.snapshot({ sessionIds: [sessionId] }); } catch { return { measured: false, unavailable: true }; }
    const session = data.sessions.find(item => item.sessionId === sessionId);
    if (!session || !measured(session)) return { measured: false };
    return { ...sumUsage(this.priced(data.bySession.get(sessionId) ?? [])), measured: true };
  }
  /** Sum over the measured sessions among `ids`; unmeasured ones contribute nothing. */
  sessions(ids: string[]): UsageTotals {
    const data = this.snapshot({ sessionIds: ids });
    const measuredIds = new Set(data.sessions.filter(measured).map(session => session.sessionId));
    return sumUsage(this.priced(ids.filter(id => measuredIds.has(id)).flatMap(id => data.bySession.get(id) ?? [])));
  }

  summary(now = new Date()): UsageSummary {
    const data = this.snapshot();
    const monthStart = periodStart("month", now);
    const providers = {} as UsageSummary["providers"];
    for (const provider of PROVIDERS) {
      const budget = this.config.usage?.budgets[provider];
      const period: Period = budget?.period ?? "month";
      const start = periodStart(period, now), previousStart = periodStart(period, new Date(start.getTime() - 1));
      const observed = provider === "opencode";
      const sessions = data.sessions.filter(s => s.provider === provider);
      const unmeasuredBriefings = provider === "opencode" ? data.briefings.filter(row => !row.record && Date.parse(row.at) >= start.getTime() && Date.parse(row.at) <= now.getTime()).length : 0;
      const unmeasuredSessions = sessions.filter(s => !measured(s) && Date.parse(s.lastActiveAt ?? s.createdAt) >= start.getTime()).length + unmeasuredBriefings;
      const within = (from: Date, to: Date) => {
        const rows = this.priced(sessions.filter(measured).flatMap(s => data.bySession.get(s.sessionId) ?? [])
          .filter(record => { const at = Date.parse(record.completedAt); return at >= from.getTime() && at < to.getTime(); }));
        if (provider === "opencode") rows.push(...data.briefings.flatMap(row => row.record && Date.parse(row.at) >= from.getTime() && Date.parse(row.at) < to.getTime() ? this.priced([row.record]) : []));
        return rows;
      };
      providers[provider] = {
        period: { start: start.toISOString(), end: periodEnd(period, start).toISOString() },
        measured: observed, unmeasuredSessions,
        ...(observed ? { spent: sumUsage(within(start, new Date(now.getTime() + 1))), previous: sumUsage(within(previousStart, start)) } : {}),
        ...(budget ? { budget: { usd: budget.usd, period } } : {}),
      };
    }
    const end = periodEnd("month", monthStart);
    const records = this.allMeasuredRecords(data), previousStart = periodStart("month", new Date(monthStart.getTime() - 1));
    const inRange = (from: Date, to: Date) => records.filter(row => Date.parse(row.record.completedAt) >= from.getTime() && Date.parse(row.record.completedAt) < to.getTime());
    const accountConfigs = this.config.usage?.accounts ?? {};
    const accounts: AccountView[] = Object.entries(accountConfigs).map(([id, account]) => {
      const matching = (rows: typeof records) => rows.filter(({ record }) => accountOf(record.providerId, record.modelId, accountConfigs) === id);
      const monthRows = matching(inRange(monthStart, new Date(now.getTime() + 1)));
      const overridden = account.kind === "subscription" && Object.hasOwn(this.planOverrides, id);
      const planUsd = overridden ? this.planOverrides[id] : account.planUsd;
      const planSource = account.kind === "subscription" ? overridden ? "owner" as const : account.planUsd !== undefined ? "config" as const : undefined : undefined;
      return { id, kind: account.kind, ...(account.kind === "metered" ? { month: this.money(monthRows) } : {}),
        ...(planUsd !== undefined ? { planUsd } : {}), ...(planSource ? { planSource } : {}),
        balance: this.balances?.get(id) ?? null };
    });
    const unmeasuredSessions = data.sessions.filter(session => !measured(session) && Date.parse(session.lastActiveAt ?? session.createdAt) >= monthStart.getTime() && Date.parse(session.lastActiveAt ?? session.createdAt) < end.getTime()).length + data.briefings.filter(row => !row.record && Date.parse(row.at) >= monthStart.getTime() && Date.parse(row.at) <= now.getTime()).length;
    return { period: { start: monthStart.toISOString(), end: end.toISOString() }, providers,
      month: { start: monthStart.toISOString(), end: end.toISOString(), spent: this.money(inRange(monthStart, new Date(now.getTime() + 1))), previous: this.money(inRange(previousStart, monthStart)), plansUsd: accounts.filter(account => account.kind === "subscription").reduce((sum, account) => sum + (account.planUsd ?? 0), 0), unmeasuredSessions }, accounts };
  }
}
