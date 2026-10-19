import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Provider } from "./types.js";
import type { Manager } from "./manager.js";
import type { TeamAssignment } from "./team-types.js";
import { writeSealed, unseal } from "./vault.js";
import { accountOf, periodStart, priceUsage, sumUsage, type UsageRecord, type UsageTotals, type UsageTokens } from "./usage.js";
import type { AccountView, Balance, BriefingUsage, Money, TaskUsage, UsageResolvers } from "./usage-api.js";

type Period = "day" | "week" | "month";
export interface SessionUsage extends UsageTotals { measured: true }
export type UsageSummary = {
  /** The default month window; each provider carries the window of its own budget period. */
  period: { start: string; end: string };
  providers: Record<Provider, { period: { start: string; end: string }; measured: boolean; spent?: UsageTotals; budget?: { usd: number; period: Period }; previous?: UsageTotals; unmeasuredSessions: number }>;
  month: { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number };
  accounts: AccountView[];
};
/** `exited` records that the session had exited and its journal was read to its end: nothing in it can change. */
type LedgerSession = { provider: Provider; projectId: string; createdAt: string; lastActiveAt?: string; measured: boolean; team?: TeamAssignment; profileId?: string; exited?: true };
/** A session row as `manager.list()` returns it. */
export type UsageSessionRow = Awaited<ReturnType<Manager["list"]>>[number];
type Ledger = { cursors: Record<string, number>; sessions: Record<string, LedgerSession>; rows: Record<string, UsageRecord>; briefings: Record<string, { projectId: string; at: string; record?: UsageRecord }> };

const PROVIDERS: Provider[] = ["claude", "codex", "grok", "opencode", "demo"];
const PAGE = 200;
const periodEnd = (period: Period, start: Date) => period === "month" ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  : new Date(start.getTime() + (period === "week" ? 7 : 1) * 86_400_000);
const SCOPE = "usage";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Sealed ledger of per-step OpenCode and reported briefing usage. Every other session is counted
 * as unmeasured and never contributes a zero to a total.
 */
export class UsageService {
  private ledger: Ledger = { cursors: {}, sessions: {}, rows: {}, briefings: {} };
  private index?: Map<string, UsageRecord[]>;
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private ticking = false;
  private readonly failed = new Set<string>();
  private readonly file: string;
  private balances?: { get(id: string): Balance };
  private resolvers: UsageResolvers = { goalOfRun: () => undefined, runTitle: () => undefined, projectName: id => id, sessionTitle: () => undefined };
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager) {
    this.file = join(config.stateDir, "usage.sealed");
    // The ledger is derived from session journals, so an unreadable one is rebuilt rather than fatal.
    if (existsSync(this.file)) try {
      const stored = unseal<Ledger>(key, SCOPE, readFileSync(this.file, "utf8"));
      if (!isRecord(stored) || !isRecord(stored.rows) || !isRecord(stored.cursors) || !isRecord(stored.sessions)) throw new Error("unexpected ledger shape");
      this.ledger = stored;
      this.ledger.briefings ??= {};
    } catch (error) {
      console.warn(`[Infinite] The usage ledger cannot be read and is rebuilt from session journals: ${error instanceof Error ? error.message : String(error)}`);
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

  /** Folds new journal usage into the ledger. `rows` is a listing the caller already took; without one, the manager is asked. */
  async tick(rows?: UsageSessionRow[]) {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      let changed = false;
      for (const session of rows ?? await this.manager.list()) {
        const previous = this.ledger.sessions[session.id];
        if (previous?.exited) continue;
        const measured = session.provider === "opencode" && (session.teamModelProfile ? session.teamModelProfile.provider === "opencode" : !session.team && session.runtime?.nativeUi === "opencode");
        const active = ["starting", "running"].includes(session.status);
        // Refreshed at most once a minute so a running session does not rewrite the ledger on every tick.
        const stale = !previous?.lastActiveAt || Date.now() - Date.parse(previous.lastActiveAt) > 60_000;
        const lastActiveAt = active && stale ? new Date().toISOString() : previous?.lastActiveAt;
        let readToEnd = !measured;
        // One unreadable journal must not strand the rows other sessions produced in this tick.
        if (measured) try {
          let cursor = this.ledger.cursors[session.id] ?? 0, more = true;
          while (more && !this.closed) {
            const page = this.manager.events(session.id, cursor, PAGE, new Set(["usage"]));
            for (const event of page.events) {
              if (event.type !== "usage") continue;
              const record = event.data as unknown as UsageRecord;
              this.ledger.rows[`${session.id}/${record.messageId}/${record.partId}`] = record; changed = true; this.index = undefined;
            }
            if (page.cursor !== cursor) { cursor = page.cursor; this.ledger.cursors[session.id] = cursor; changed = true; }
            more = page.more;
          }
          readToEnd = !more;
          this.failed.delete(session.id);
        } catch (error) {
          if (!this.failed.has(session.id)) {
            this.failed.add(session.id);
            console.warn(`[Infinite] Usage for session ${session.id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const entry: LedgerSession = { provider: session.provider, projectId: session.projectId, createdAt: session.createdAt, measured,
          ...(lastActiveAt ? { lastActiveAt } : {}),
          ...(session.team ? { team: session.team } : {}), ...(session.teamModelProfile ? { profileId: session.teamModelProfile.id } : {}),
          // A session id never runs again once exited, so later ticks can skip it.
          ...(session.status === "exited" && readToEnd ? { exited: true as const } : {}) };
        if (JSON.stringify(previous) !== JSON.stringify(entry)) { this.ledger.sessions[session.id] = entry; changed = true; }
      }
      if (changed) { this.index = undefined; writeSealed(this.file, this.key, SCOPE, this.ledger); }
    } finally { this.ticking = false; }
  }

  private rowsBySession() {
    if (!this.index) {
      this.index = new Map();
      for (const [key, record] of Object.entries(this.ledger.rows)) {
        const id = key.slice(0, key.indexOf("/"));
        (this.index.get(id) ?? this.index.set(id, []).get(id)!).push(record);
      }
    }
    return this.index;
  }
  private priced(records: UsageRecord[]) {
    return records.map(record => ({ ...priceUsage(record, this.config.usage?.prices), tokens: record.tokens }));
  }

  private measuredRecords() { return Object.entries(this.ledger.rows).flatMap(([key, record]) => { const id = key.slice(0, key.indexOf("/")), session = this.ledger.sessions[id]; return session?.measured ? [{ id, projectId: session.projectId, record, ...priceUsage(record, this.config.usage?.prices) }] : []; }); }
  private allMeasuredRecords() {
    return [...this.measuredRecords(), ...Object.entries(this.ledger.briefings).flatMap(([id, row]) => row.record ? [{ id: `briefing:${id}`, projectId: row.projectId, record: row.record, ...priceUsage(row.record, this.config.usage?.prices) }] : [])];
  }
  private money(rows: { cost: number; pricing: string }[]): Money { return { usd: Math.round(rows.reduce((sum, row) => sum + row.cost, 0) * 1_000_000) / 1_000_000, unpriced: rows.filter(row => row.pricing === "unknown").length }; }
  private dateKey(at: string, tz: string) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
    const value = Object.fromEntries(parts.map(part => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`;
  }
  daily({ days, tz = "UTC", projectId, now = new Date() }: { days: number; tz?: string; projectId?: string; now?: Date }) {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new RangeError("days must be between 1 and 366");
    this.dateKey(now.toISOString(), tz);
    const last = this.dateKey(now.toISOString(), tz), [year, month, day] = last.split("-").map(Number), date = new Date(Date.UTC(year, month - 1, day));
    const dates = Array.from({ length: days }, (_, index) => { const d = new Date(date.getTime() - (days - index - 1) * 86_400_000); return d.toISOString().slice(0, 10); });
    const accounts = new Set<string>(Object.keys(this.config.usage?.accounts ?? {})), map = new Map(dates.map(key => [key, {} as Record<string, number>]));
    for (const row of this.allMeasuredRecords()) {
      if (projectId && row.projectId !== projectId) continue;
      const key = this.dateKey(row.record.completedAt, tz), account = accountOf(row.record.providerId, row.record.modelId, this.config.usage?.accounts ?? {});
      accounts.add(account); if (map.has(key)) map.get(key)![account] = (map.get(key)![account] ?? 0) + row.cost;
    }
    return { tz, accounts: [...accounts].sort(), days: dates.map(date => { const byAccount = map.get(date)!; const rounded = Object.fromEntries(Object.entries(byAccount).map(([id, usd]) => [id, Math.round(usd * 1_000_000) / 1_000_000])); return { date, usd: Math.round(Object.values(rounded).reduce((a, b) => a + b, 0) * 1_000_000) / 1_000_000, byAccount: rounded }; }) };
  }
  projects({ tz = "UTC", now = new Date() }: { tz?: string; now?: Date }) {
    this.dateKey(now.toISOString(), tz);
    const ids = new Set([...Object.values(this.ledger.sessions).map(s => s.projectId), ...Object.values(this.ledger.briefings).map(b => b.projectId)]);
    return { projects: [...ids].map(id => { const rows = this.projectRows(id), recent = this.daily({ days: 30, tz, projectId: id, now }); return { id, name: this.resolvers.projectName(id) ?? id, total: this.money(rows), month: this.money(rows.filter(row => { const at = Date.parse(row.at); return at >= periodStart("month", now).getTime() && at <= now.getTime(); })), spark: recent.days.map(day => day.usd) }; }).sort((a, b) => b.total.usd - a.total.usd) };
  }
  private projectRows(id: string) {
    const rows = this.allMeasuredRecords().filter(row => row.projectId === id).map(row => ({ ...row, at: row.record.completedAt }));
    return rows;
  }
  project(id: string, { tz = "UTC", now = new Date() }: { tz?: string; now?: Date } = {}) {
    this.dateKey(now.toISOString(), tz);
    const sessions = Object.entries(this.ledger.sessions).filter(([, session]) => session.projectId === id), briefings = Object.values(this.ledger.briefings).filter(row => row.projectId === id);
    if (!sessions.length && !briefings.length) return undefined;
    const total = this.money(this.projectRows(id)), grouped = { goals: [] as any[], teams: [] as any[], sessions: [] as any[], briefings: [] as any[] };
    for (const [sessionId, session] of sessions) {
      const records = this.priced(this.rowsBySession().get(sessionId) ?? []), sum = this.money(records);
      if (!session.measured) continue;
      if (session.team) {
        const goal = this.resolvers.goalOfRun(session.team.runId), prior = grouped.teams.find(row => row.id === session.team!.runId);
        if (prior) { prior.total.usd = Math.round((prior.total.usd + sum.usd) * 1_000_000) / 1_000_000; prior.total.unpriced += sum.unpriced; }
        else grouped.teams.push({ id: session.team.runId, title: this.resolvers.runTitle(session.team.runId) ?? session.team.runId, total: sum, ...(goal ? { goalId: goal.id } : {}) });
      }
      else grouped.sessions.push({ id: sessionId, title: this.resolvers.sessionTitle(sessionId) ?? sessionId, total: sum });
    }
    for (const row of briefings) { const cost = row.record ? priceUsage(row.record, this.config.usage?.prices) : undefined; grouped.briefings.push({ row, cost }); }
    const goals = new Map<string, { id: string; title: string; total: Money; tasks: number }>(), goalTasks = new Map<string, Set<string>>();
    for (const row of grouped.teams.filter(item => item.goalId)) {
      const goal = this.resolvers.goalOfRun(row.id)!; const current = goals.get(goal.id) ?? { id: goal.id, title: goal.title, total: { usd: 0, unpriced: 0 }, tasks: 0 };
      current.total.usd = Math.round((current.total.usd + row.total.usd) * 1_000_000) / 1_000_000; current.total.unpriced += row.total.unpriced; goals.set(goal.id, current);
      const ids = goalTasks.get(goal.id) ?? new Set<string>(); for (const session of Object.values(this.ledger.sessions)) { const team = session.team; if (!team || team.runId !== row.id || !team.taskId) continue; ids.add(`${row.id}/${team.taskId}`); } goalTasks.set(goal.id, ids);
    }
    for (const [goalId, row] of goals) row.tasks = goalTasks.get(goalId)?.size ?? 0;
    const briefingMoney = this.money(grouped.briefings.flatMap(({ cost }) => cost ? [cost] : []));
    return { id, name: this.resolvers.projectName(id) ?? id, total, byKind: { goals: [...goals.values()].reduce((n, g) => n + g.total.usd, 0), teams: grouped.teams.filter(row => !row.goalId).reduce((n, x) => n + x.total.usd, 0), sessions: grouped.sessions.reduce((n, x) => n + x.total.usd, 0), briefings: briefingMoney.usd }, goals: [...goals.values()], teams: grouped.teams, sessions: grouped.sessions, briefings: { total: briefingMoney, runs: briefings.length, unmeasured: briefings.filter(row => !row.record).length } };
  }
  taskUsage(runId: string, taskId: string): TaskUsage | undefined {
    const sessions = Object.entries(this.ledger.sessions).filter(([, session]) => session.team?.runId === runId && session.team.taskId === taskId);
    if (!sessions.length) return undefined;
    const rows = sessions.flatMap(([id]) => this.rowsBySession().get(id) ?? []), totals = this.priced(rows), sum = sumUsage(totals);
    if (!rows.length) return undefined;
    return { usd: sum.cost, unpriced: totals.filter(row => row.pricing === "unknown").length, tokens: Object.values(sum.tokens).reduce((a, b) => a + b, 0), attempts: new Set(sessions.map(([, session]) => session.team!.memberId)).size, profiles: [...new Set(sessions.map(([, session]) => session.profileId).filter((id): id is string => Boolean(id)))].sort() };
  }
  recordBriefing(projectId: string, sessionId: string, at: string, usage: BriefingUsage | null) {
    const record = usage ? { provider: "opencode" as const, providerId: usage.providerId, modelId: usage.modelId, messageId: sessionId, partId: at, modelSource: "reported" as const, completedAt: at, tokens: usage.tokens, reportedCost: usage.reportedCost ?? 0 } : undefined;
    this.ledger.briefings[`${sessionId}/${at}`] = { projectId, at, ...(record ? { record } : {}) };
    writeSealed(this.file, this.key, SCOPE, this.ledger);
  }

  session(sessionId: string): SessionUsage | { measured: false } {
    if (!this.ledger.sessions[sessionId]?.measured) return { measured: false };
    return { ...sumUsage(this.priced(this.rowsBySession().get(sessionId) ?? [])), measured: true };
  }
  /** Sum over the measured sessions among `ids`; unmeasured ones contribute nothing. */
  sessions(ids: string[]): UsageTotals {
    return sumUsage(this.priced(ids.filter(id => this.ledger.sessions[id]?.measured).flatMap(id => this.rowsBySession().get(id) ?? [])));
  }

  summary(now = new Date()): UsageSummary {
    const monthStart = periodStart("month", now);
    const providers = {} as UsageSummary["providers"];
    for (const provider of PROVIDERS) {
      const budget = this.config.usage?.budgets[provider];
      const period: Period = budget?.period ?? "month";
      const start = periodStart(period, now), previousStart = periodStart(period, new Date(start.getTime() - 1));
      const measured = provider === "opencode";
      const sessions = Object.entries(this.ledger.sessions).filter(([, s]) => s.provider === provider);
      const unmeasuredBriefings = provider === "opencode" ? Object.values(this.ledger.briefings).filter(row => !row.record && Date.parse(row.at) >= start.getTime() && Date.parse(row.at) <= now.getTime()).length : 0;
      const unmeasuredSessions = sessions.filter(([, s]) => !s.measured && Date.parse(s.lastActiveAt ?? s.createdAt) >= start.getTime()).length + unmeasuredBriefings;
      const within = (from: Date, to: Date) => {
        const rows = this.priced(sessions.filter(([, s]) => s.measured).flatMap(([id]) => this.rowsBySession().get(id) ?? [])
          .filter(record => { const at = Date.parse(record.completedAt); return at >= from.getTime() && at < to.getTime(); }));
        if (provider === "opencode") rows.push(...Object.values(this.ledger.briefings).flatMap(row => row.record && Date.parse(row.at) >= from.getTime() && Date.parse(row.at) < to.getTime() ? this.priced([row.record]) : []));
        return rows;
      };
      providers[provider] = {
        period: { start: start.toISOString(), end: periodEnd(period, start).toISOString() },
        measured, unmeasuredSessions,
        ...(measured ? { spent: sumUsage(within(start, new Date(now.getTime() + 1))), previous: sumUsage(within(previousStart, start)) } : {}),
        ...(budget ? { budget: { usd: budget.usd, period } } : {}),
      };
    }
    const end = periodEnd("month", monthStart);
    const records = this.allMeasuredRecords(), previousStart = periodStart("month", new Date(monthStart.getTime() - 1));
    const inRange = (from: Date, to: Date) => records.filter(row => Date.parse(row.record.completedAt) >= from.getTime() && Date.parse(row.record.completedAt) < to.getTime());
    const accountConfigs = this.config.usage?.accounts ?? {};
    const accounts: AccountView[] = Object.entries(accountConfigs).map(([id, account]) => {
      const matching = (rows: typeof records) => rows.filter(({ record }) => accountOf(record.providerId, record.modelId, accountConfigs) === id);
      const monthRows = matching(inRange(monthStart, new Date(now.getTime() + 1)));
      return { id, kind: account.kind, ...(account.kind === "metered" ? { month: this.money(monthRows) } : {}), ...(account.planUsd !== undefined ? { planUsd: account.planUsd } : {}), balance: this.balances?.get(id) ?? null };
    });
    const unmeasuredSessions = Object.values(this.ledger.sessions).filter(session => !session.measured && Date.parse(session.lastActiveAt ?? session.createdAt) >= monthStart.getTime() && Date.parse(session.lastActiveAt ?? session.createdAt) < end.getTime()).length + Object.values(this.ledger.briefings).filter(row => !row.record && Date.parse(row.at) >= monthStart.getTime() && Date.parse(row.at) <= now.getTime()).length;
    return { period: { start: monthStart.toISOString(), end: end.toISOString() }, providers,
      month: { start: monthStart.toISOString(), end: end.toISOString(), spent: this.money(inRange(monthStart, new Date(now.getTime() + 1))), previous: this.money(inRange(previousStart, monthStart)), plansUsd: accounts.filter(account => account.kind === "subscription").reduce((sum, account) => sum + (account.planUsd ?? 0), 0), unmeasuredSessions }, accounts };
  }
}
