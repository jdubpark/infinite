import { existsSync, readFileSync } from "node:fs";
import { recoveryTurnEnd, type SignalData } from "@infinite/attention";
import type { Provider } from "./types.js";
import { writeSealed, unseal } from "./vault.js";

export interface ProviderLimit { provider: Provider; detectedAt: string; resetsAt?: string; expiresAt: string; sessionId: string; runId?: string; confidence: "corroborated" }
export type LimitObservation = { kind: "provider-limit"; limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; message: string; source: "hook" | "screen" | "protocol"; provider: Provider };
export interface LimitRow { id: string; provider: Provider; team?: { runId: string }; attention: { limit?: { confidence: string; since: string; resetsAt?: string } } }
export interface LimitSessions {
  events(id: string, after: number, limit: number, types?: Set<string>): { events: { at: string; data: Record<string, unknown> }[]; cursor: number; more: boolean };
}
type State = { limits: Partial<Record<Provider, ProviderLimit>>; cleared: Partial<Record<Provider, string>> };

const SCOPE = "provider-limits";
const DAY_MS = 86_400_000;
const UNSTATED_MS = 15 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const time = (value?: string) => { const ms = value === undefined ? NaN : Date.parse(value); return Number.isNaN(ms) ? undefined : ms; };

export const switchesMember = (data: Record<string, unknown>): data is LimitObservation =>
  data.kind === "provider-limit" && (data.confidence === "corroborated" || (data.source === "hook" && data.provider === "claude"));

export class ProviderLimits {
  private state: State = { limits: {}, cleared: {} };
  private readonly sessions = new Map<string, { provider: Provider; cursor: number; limitAt?: number; turnAt?: string }>();
  constructor(private readonly file: string, private readonly key: Buffer) {
    if (existsSync(file)) try {
      const stored = unseal<State>(key, SCOPE, readFileSync(file, "utf8"));
      if (!isRecord(stored) || !isRecord(stored.limits) || !isRecord(stored.cleared)) throw new Error("unexpected provider limit shape");
      this.state = stored;
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
