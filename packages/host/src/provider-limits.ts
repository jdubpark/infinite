import { existsSync, readFileSync } from "node:fs";
import type { Provider } from "./types.js";
import { unseal, writeSealed } from "./vault.js";

export interface ProviderLimit {
  provider: Provider;
  detectedAt: string;
  resetsAt?: string;
  expiresAt: string;
  sessionId: string;
  runId?: string;
  confidence: "corroborated";
}
type State = { entries: Partial<Record<Provider, ProviderLimit>>; clearedThrough: Partial<Record<Provider, string>> };

/** Corroborated observations expire; successful turns prevent older sessions from restoring them. */
export class ProviderLimits {
  private state: State = { entries: {}, clearedThrough: {} };
  constructor(private readonly file: string, private readonly key: Buffer) {
    if (existsSync(file)) this.state = unseal<State>(key, "provider-limits", readFileSync(file, "utf8"));
  }
  observe(observation: Omit<ProviderLimit, "expiresAt">) {
    const detected = Date.parse(observation.detectedAt);
    if (!Number.isFinite(detected) || detected <= Date.parse(this.state.clearedThrough[observation.provider] ?? "") || detected <= Date.parse(this.state.entries[observation.provider]?.detectedAt ?? "")) return;
    const reset = Date.parse(observation.resetsAt ?? "");
    const expires = Number.isFinite(reset) ? Math.min(reset, detected + 24 * 60 * 60 * 1000) : detected + 15 * 60 * 1000;
    this.state.entries[observation.provider] = { ...observation, expiresAt: new Date(expires).toISOString() };
    this.save();
  }
  clear(provider: Provider, at = new Date().toISOString()) {
    if (!this.state.entries[provider]) return;
    delete this.state.entries[provider];
    this.state.clearedThrough[provider] = at;
    this.save();
  }
  active(now = new Date()): ProviderLimit[] {
    return structuredClone(Object.values(this.state.entries).filter(entry => Date.parse(entry.expiresAt) > now.getTime()));
  }
  limited(now = new Date()) { return new Set(this.active(now).map(entry => entry.provider)); }
  private save() { writeSealed(this.file, this.key, "provider-limits", this.state); }
}
