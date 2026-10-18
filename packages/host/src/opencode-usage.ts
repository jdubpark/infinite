import type { UsageRecord } from "./usage.js";

const MAX_PARTIAL_LINE = 1024 * 1024;

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

export interface UsageContext { completedAt: string; providerId: string; modelId: string; modelSource: "requested" | "reported" }

/**
 * Turns an OpenCode `step-finish` part into a usage record. Each step reports its own tokens and
 * cost, so one assistant message yields several records. Numbers are coerced to finite
 * non-negative values so malformed provider data cannot reach pricing.
 */
export function usageFromStepFinish(part: unknown, context: UsageContext): UsageRecord | undefined {
  const step = part as Record<string, any> | null;
  if (!step || step.type !== "step-finish") return undefined;
  const partId = text(step.id), messageId = text(step.messageID);
  if (!partId || !messageId) return undefined;
  const tokens = step.tokens ?? {};
  return { provider: "opencode", providerId: context.providerId, modelId: context.modelId, modelSource: context.modelSource,
    messageId, partId, completedAt: context.completedAt,
    tokens: { input: count(tokens.input), output: count(tokens.output), reasoning: count(tokens.reasoning),
      cacheRead: count(tokens.cache?.read), cacheWrite: count(tokens.cache?.write) },
    reportedCost: amount(step.cost) };
}

/**
 * Usage record for one line of `opencode run --format json` output, or undefined for any other
 * line. The model comes from the requested `provider/model` selection.
 */
export function usageFromRunLine(line: unknown, model: string, now = new Date()): UsageRecord | undefined {
  const event = line as { type?: unknown; timestamp?: unknown; part?: unknown } | null;
  if (event?.type !== "step_finish") return undefined;
  const slash = model.indexOf("/");
  const stamp = typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? new Date(event.timestamp) : now;
  return usageFromStepFinish(event.part, { completedAt: (Number.isNaN(stamp.getTime()) ? now : stamp).toISOString(), modelSource: "requested",
    providerId: slash < 0 ? model : model.slice(0, slash), modelId: slash < 0 ? model : model.slice(slash + 1) });
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
