import { existsSync, readFileSync } from "node:fs";
import { recoveryTurnEnd, type SignalData } from "@infinite/attention";
import type { Provider } from "./types.js";
import { writeSealed, unseal } from "./vault.js";

export interface ProviderLimit { provider: Provider; detectedAt: string; resetsAt?: string; expiresAt: string; sessionId: string; runId?: string; confidence: "corroborated" }
/** Journal data of a `provider-limit` signal, as the worker records it. */
export type LimitObservation = { kind: "provider-limit"; limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; message: string; source: "hook" | "screen" | "protocol"; provider: Provider };
/** The session rows and journal reads `reconcile` needs from the manager. */
export interface LimitSessions {
  list(): Promise<{ id: string; provider: Provider; team?: { runId: string }; attention: { limit?: { confidence: string; since: string; resetsAt?: string } } }[]>;
  events(id: string, after: number, limit: number, types?: Set<string>): { events: { at: string; data: Record<string, unknown> }[]; cursor: number; more: boolean };
}
type State = { limits: Partial<Record<Provider, ProviderLimit>>; cleared: Partial<Record<Provider, string>> };

const SCOPE = "provider-limits";
const DAY_MS = 86_400_000;
const UNSTATED_MS = 15 * 60_000;
const time = (value?: string) => { const ms = value === undefined ? NaN : Date.parse(value); return Number.isNaN(ms) ? undefined : ms; };

/** A corroborated observation switches its member; so does a Claude hook alone, because that turn already failed. */
export const switchesMember = (data: Record<string, unknown>): data is LimitObservation =>
  data.kind === "provider-limit" && (data.confidence === "corroborated" || (data.source === "hook" && data.provider === "claude"));

/**
 * Host-level memory of corroborated provider limits, so new members of a limited provider launch on
 * their fallback. An entry lasts until the provider's stated reset, at most 24 hours, or 15 minutes
 * when no reset was stated. It ends early when a session of that provider completes a turn without
 * failing after the limit, as told by a source able to report failure (`recoveryTurnEnd`). A per-provider clear time keeps an exited session's old observation from
 * re-creating a cleared entry.
 */
export class ProviderLimits {
  private state: State = { limits: {}, cleared: {} };
  /** Per-session journal position, latest limit observation, and latest successful turn end. */
  private readonly sessions = new Map<string, { cursor: number; limitAt?: number; turnAt?: string }>();
  constructor(private readonly file: string, private readonly key: Buffer) {
    if (existsSync(file)) this.state = unseal<State>(key, SCOPE, readFileSync(file, "utf8"));
  }
  /** Records a corroborated observation unless a newer one, or a later clear, is already known. */
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
  /**
   * Observes corroborated limits shown on any Claude or Codex session, then clears a provider's entry
   * when one of its sessions journals a recovery turn end after both the entry and that session's
   * own latest limit observation. Activity timestamps are not evidence: a repeated limit bumps them.
   */
  async reconcile(sessions: LimitSessions, now = new Date()) {
    for (const session of await sessions.list()) {
      const shown = session.attention.limit;
      if ((session.provider === "claude" || session.provider === "codex") && shown?.confidence === "corroborated")
        this.observe({ provider: session.provider, detectedAt: shown.since, ...(shown.resetsAt ? { resetsAt: shown.resetsAt } : {}), sessionId: session.id, ...(session.team ? { runId: session.team.runId } : {}), confidence: "corroborated" });
      const entry = this.active(now).find(limit => limit.provider === session.provider);
      if (!entry) continue;
      const seen = this.sessions.get(session.id) ?? { cursor: 0 };
      let page: ReturnType<LimitSessions["events"]>;
      // One unreadable journal must not keep other sessions from clearing the entry.
      try { page = sessions.events(session.id, seen.cursor, 200, new Set(["signal"])); } catch { continue; }
      for (const event of page.events) {
        const at = time(event.at);
        if (at === undefined) continue;
        if (event.data.kind === "provider-limit") seen.limitAt = Math.max(at, seen.limitAt ?? at);
        else if (recoveryTurnEnd(event.data as unknown as SignalData) && at > (time(seen.turnAt) ?? -Infinity)) seen.turnAt = event.at;
      }
      seen.cursor = page.cursor; this.sessions.set(session.id, seen);
      // A later limit may sit in the unread tail; decide once the journal has been read to its end.
      if (page.more) continue;
      const turnAt = time(seen.turnAt);
      if (turnAt !== undefined && turnAt > Date.parse(entry.detectedAt) && (seen.limitAt === undefined || turnAt > seen.limitAt)) this.clear(session.provider, seen.turnAt);
    }
  }
  private save() { writeSealed(this.file, this.key, SCOPE, this.state); }
}
