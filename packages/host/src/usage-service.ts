import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Provider } from "./types.js";
import type { Manager } from "./manager.js";
import type { TeamAssignment } from "./team-types.js";
import { writeSealed, unseal } from "./vault.js";
import { periodStart, priceUsage, sumUsage, type UsageRecord, type UsageTotals } from "./usage.js";

type Period = "day" | "week" | "month";
export interface SessionUsage extends UsageTotals { measured: true }
export type UsageSummary = {
  period: { start: string; end: string };
  providers: Record<Provider, { measured: boolean; spent?: UsageTotals; budget?: { usd: number; period: Period }; previous?: UsageTotals; unmeasuredSessions: number }>;
};
type LedgerSession = { provider: Provider; projectId: string; createdAt: string; measured: boolean; team?: TeamAssignment; profileId?: string };
type Ledger = { cursors: Record<string, number>; sessions: Record<string, LedgerSession>; rows: Record<string, UsageRecord> };

const PROVIDERS: Provider[] = ["claude", "codex", "grok", "opencode", "demo"];
const PAGE = 200;
const SCOPE = "usage";

/**
 * Sealed ledger of per-step OpenCode usage. Only OpenCode sessions started with JSON output
 * (team members with an OpenCode model profile, and local-UI sessions) journal usage; every
 * other session is counted as unmeasured and never contributes a zero to a total.
 */
export class UsageService {
  private ledger: Ledger = { cursors: {}, sessions: {}, rows: {} };
  private index?: Map<string, UsageRecord[]>;
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private ticking = false;
  private readonly file: string;
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager) {
    this.file = join(config.stateDir, "usage.sealed");
    if (existsSync(this.file)) this.ledger = unseal<Ledger>(key, SCOPE, readFileSync(this.file, "utf8"));
  }
  start() {
    if (this.running || this.closed) return;
    this.running = true;
    const tick = () => { void this.tick().catch(() => {}); };
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick();
  }
  close() { this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); }

  private async tick() {
    if (this.ticking || !this.running) return;
    this.ticking = true;
    try {
      let changed = false;
      for (const session of await this.manager.list()) {
        const measured = session.provider === "opencode" && (session.teamModelProfile ? session.teamModelProfile.provider === "opencode" : !session.team && session.runtime?.nativeUi === "opencode");
        const entry: LedgerSession = { provider: session.provider, projectId: session.projectId, createdAt: session.createdAt, measured,
          ...(session.team ? { team: session.team } : {}), ...(session.teamModelProfile ? { profileId: session.teamModelProfile.id } : {}) };
        if (JSON.stringify(this.ledger.sessions[session.id]) !== JSON.stringify(entry)) { this.ledger.sessions[session.id] = entry; changed = true; }
        if (!measured) continue;
        let cursor = this.ledger.cursors[session.id] ?? 0;
        for (let more = true; more && this.running;) {
          const page = this.manager.events(session.id, cursor, PAGE, new Set(["usage"]));
          for (const event of page.events) {
            if (event.type !== "usage") continue;
            const record = event.data as unknown as UsageRecord;
            this.ledger.rows[`${session.id}/${record.messageId}/${record.partId}`] = record; changed = true;
          }
          if (page.cursor !== cursor) { cursor = page.cursor; this.ledger.cursors[session.id] = cursor; changed = true; }
          more = page.more;
        }
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
      const unmeasuredSessions = sessions.filter(([, s]) => !s.measured && Date.parse(s.createdAt) >= start.getTime()).length;
      const within = (from: Date, to: Date) => this.priced(sessions.filter(([, s]) => s.measured).flatMap(([id]) => this.rowsBySession().get(id) ?? [])
        .filter(record => { const at = Date.parse(record.completedAt); return at >= from.getTime() && at < to.getTime(); }));
      providers[provider] = {
        measured, unmeasuredSessions,
        ...(measured ? { spent: sumUsage(within(start, new Date(now.getTime() + 1))), previous: sumUsage(within(previousStart, start)) } : {}),
        ...(budget ? { budget: { usd: budget.usd, period } } : {}),
      };
    }
    const end = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
    return { period: { start: monthStart.toISOString(), end: end.toISOString() }, providers };
  }
}
