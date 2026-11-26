import { existsSync, readFileSync } from "node:fs";
import { recoveryTurnEnd, type SignalData } from "@infinite/attention";
import type { Provider } from "./types.js";
import { writeSealed, unseal } from "./vault.js";

export interface ProviderLimit { provider: Provider; limit?: "usage" | "credits"; detectedAt: string; resetsAt?: string; expiresAt: string; sessionId: string; runId?: string; confidence: "corroborated" }
export interface ProviderLimitEvent { provider: Provider; limit: "usage" | "credits"; detectedAt: string; resetsAt?: string; sessionId: string; runId?: string }
export type LimitObservation = { kind: "provider-limit"; limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; message: string; source: "hook" | "screen" | "protocol"; provider: Provider };
export interface LimitRow { id: string; provider: Provider; team?: { runId: string }; attention: { limit?: { confidence: string; since: string; resetsAt?: string } } }
export interface LimitSessions {
  events(id: string, after: number, limit: number, types?: Set<string>): { events: { at: string; data: Record<string, unknown> }[]; cursor: number; more: boolean };
}
type State = { limits: Partial<Record<Provider, ProviderLimit>>; cleared: Partial<Record<Provider, string>>; history?: ProviderLimitEvent[] };

const SCOPE = "provider-limits";
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 30;
const MAX_HISTORY = 500;
const UNSTATED_MS = 15 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const time = (value?: string) => { const ms = value === undefined ? NaN : Date.parse(value); return Number.isNaN(ms) ? undefined : ms; };

function validEvent(value: unknown): value is ProviderLimitEvent {
  return isRecord(value) && typeof value.provider === "string" && (value.limit === "usage" || value.limit === "credits")
    && typeof value.detectedAt === "string" && time(value.detectedAt) !== undefined && typeof value.sessionId === "string"
    && (value.resetsAt === undefined || (typeof value.resetsAt === "string" && time(value.resetsAt) !== undefined))
    && (value.runId === undefined || typeof value.runId === "string");
}

export const switchesMember = (data: Record<string, unknown>): data is LimitObservation =>
  data.kind === "provider-limit" && (data.confidence === "corroborated" || (data.source === "hook" && data.provider === "claude"));

export class ProviderLimits {
  private state: State = { limits: {}, cleared: {} };
  private readonly sessions = new Map<string, { provider: Provider; cursor: number; limitAt?: number; turnAt?: string }>();
  constructor(private readonly file: string, private readonly key: Buffer) {
    if (existsSync(file)) try {
      const stored = unseal<State>(key, SCOPE, readFileSync(file, "utf8"));
      if (!isRecord(stored) || !isRecord(stored.limits) || !isRecord(stored.cleared)) throw new Error("unexpected provider limit shape");
      const history = Array.isArray(stored.history) ? stored.history.filter(validEvent) : undefined;
      this.state = { limits: stored.limits, cleared: stored.cleared, ...(history && history.length > 0 ? { history } : {}) };
    } catch (error) {
      console.warn(`[Infinite] Provider limits cannot be read and start empty: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  observe(limit: Omit<ProviderLimit, "expiresAt">) {
    const detected = time(limit.detectedAt);
    if (detected === undefined) return;
    const floor = Math.max(time(this.state.limits[limit.provider]?.detectedAt) ?? -Infinity, time(this.state.cleared[limit.provider]) ?? -Infinity);
    if (detected <= floor) return;
    const { resetsAt, ...entry } = limit, resets = time(resetsAt);
    this.state.limits[limit.provider] = { ...entry, ...(resets === undefined ? {} : { resetsAt }),
      expiresAt: new Date(resets === undefined ? detected + UNSTATED_MS : Math.min(resets, detected + DAY_MS)).toISOString() };
    const event: ProviderLimitEvent = {
      provider: limit.provider,
      limit: limit.limit ?? "usage",
      detectedAt: limit.detectedAt,
      ...(resets === undefined ? {} : { resetsAt }),
      sessionId: limit.sessionId,
      ...(limit.runId === undefined ? {} : { runId: limit.runId }),
    };
    const cutoff = detected - HISTORY_DAYS * DAY_MS;
    const kept = (this.state.history ?? []).filter(item => {
      const at = time(item.detectedAt);
      return at !== undefined && at >= cutoff && !(item.provider === event.provider && item.detectedAt === event.detectedAt);
    });
    kept.push(event);
    kept.sort((a, b) => (time(a.detectedAt) ?? 0) - (time(b.detectedAt) ?? 0));
    this.state.history = kept.slice(-MAX_HISTORY);
    this.save();
  }
  clear(provider: Provider, at = new Date().toISOString()) {
    if (!this.state.limits[provider]) return;
    delete this.state.limits[provider];
    this.state.cleared[provider] = at;
    this.save();
  }
  active(now = new Date()): ProviderLimit[] {
    return Object.values(this.state.limits).filter(limit => Date.parse(limit.expiresAt) > now.getTime());
  }
  limited(now = new Date()): Set<Provider> { return new Set(this.active(now).map(limit => limit.provider)); }
  history(now = new Date()): ProviderLimitEvent[] {
    const nowMs = now.getTime(), cutoff = nowMs - HISTORY_DAYS * DAY_MS;
    return (this.state.history ?? []).filter(item => {
      const at = time(item.detectedAt);
      return at !== undefined && at >= cutoff && at <= nowMs;
    });
  }
  async reconcile(sessions: LimitSessions, rows: LimitRow[], now = new Date()) {
    for (const session of rows) {
      const shown = session.attention.limit;
      if ((session.provider === "claude" || session.provider === "codex") && shown?.confidence === "corroborated")
        this.observe({ provider: session.provider, detectedAt: shown.since, ...(shown.resetsAt ? { resetsAt: shown.resetsAt } : {}), sessionId: session.id, ...(session.team ? { runId: session.team.runId } : {}), confidence: "corroborated" });
      const entry = this.active(now).find(limit => limit.provider === session.provider);
      if (!entry) continue;
      const seen = this.sessions.get(session.id) ?? { provider: session.provider, cursor: 0 };
      let page: ReturnType<LimitSessions["events"]>;
      try { page = sessions.events(session.id, seen.cursor, 200, new Set(["signal"])); } catch { continue; }
      for (const event of page.events) {
        const at = time(event.at);
        if (at === undefined) continue;
        if (event.data.kind === "provider-limit") seen.limitAt = Math.max(at, seen.limitAt ?? at);
        else if (recoveryTurnEnd(event.data as unknown as SignalData) && at > (time(seen.turnAt) ?? -Infinity)) seen.turnAt = event.at;
      }
      seen.cursor = page.cursor; this.sessions.set(session.id, seen);
      if (page.more) continue;
      const turnAt = time(seen.turnAt);
      if (turnAt !== undefined && turnAt > Date.parse(entry.detectedAt) && (seen.limitAt === undefined || turnAt > seen.limitAt)) this.clear(session.provider, seen.turnAt);
    }
    const listed = new Set(rows.map(row => row.id)), limited = this.limited(now);
    for (const [sessionId, seen] of this.sessions) if (!listed.has(sessionId) || !limited.has(seen.provider)) this.sessions.delete(sessionId);
  }
  private save() { writeSealed(this.file, this.key, SCOPE, this.state); }
}
