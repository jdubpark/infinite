import type { UsageRecord } from "./usage.js";

const MAX_PARTIAL_LINE = 1024 * 1024;

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/**
 * Turns an OpenCode `message.updated` event into a usage record. Only a completed assistant
 * message counts, because streaming updates carry partial totals. Numbers are coerced to finite
 * non-negative values so malformed provider data cannot reach pricing.
 */
export function usageFromMessageUpdated(event: unknown): UsageRecord | undefined {
  const root = event as { type?: unknown; properties?: { info?: Record<string, any> } } | null;
  if (root?.type !== "message.updated") return undefined;
  const info = root.properties?.info;
  if (!info || info.role !== "assistant") return undefined;
  const completed = info.time?.completed;
  const messageId = text(info.id), providerId = text(info.providerID), modelId = text(info.modelID);
  if (typeof completed !== "number" || !Number.isFinite(completed) || !messageId || !providerId || !modelId) return undefined;
  const completedAt = new Date(completed);
  if (Number.isNaN(completedAt.getTime())) return undefined;
  const tokens = info.tokens ?? {};
  return { provider: "opencode", providerId, modelId, messageId, completedAt: completedAt.toISOString(),
    tokens: { input: count(tokens.input), output: count(tokens.output), reasoning: count(tokens.reasoning),
      cacheRead: count(tokens.cache?.read), cacheWrite: count(tokens.cache?.write) },
    reportedCost: amount(info.cost) };
}

/**
 * Reassembles newline-delimited JSON from raw terminal chunks. Lines that are not JSON objects
 * (spinners, plain text) are dropped, and a partial line over 1 MiB is discarded.
 */
export class JsonLineAssembler {
  private partial = "";
  private discarding = false;

  push(chunk: string): unknown[] {
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop()!;
    const objects: unknown[] = [];
    for (const raw of lines) {
      if (this.discarding) { this.discarding = false; continue; }
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value)) objects.push(value);
      } catch { /* Not JSON output. */ }
    }
    if (this.partial.length > MAX_PARTIAL_LINE) { this.partial = ""; this.discarding = true; }
    return objects;
  }
}
