import type { UsageRecord } from "./usage.js";

const MAX_PARTIAL_LINE = 1024 * 1024;

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

export interface UsageContext { completedAt: string; providerId: string; modelId: string; modelSource: UsageRecord["modelSource"] }

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

export function usageFromRunLine(line: unknown, model: string, now = new Date()): UsageRecord | undefined {
  const event = line as { type?: unknown; timestamp?: unknown; part?: unknown } | null;
  if (event?.type !== "step_finish") return undefined;
  const slash = model.indexOf("/");
  const stamp = typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? new Date(event.timestamp) : now;
  return usageFromStepFinish(event.part, { completedAt: (Number.isNaN(stamp.getTime()) ? now : stamp).toISOString(), modelSource: "requested",
    providerId: slash < 0 ? model : model.slice(0, slash), modelId: slash < 0 ? model : model.slice(slash + 1) });
}

type ToolPart = { id?: unknown; partID?: unknown; tool?: unknown; callID?: unknown; state?: { status?: unknown; metadata?: { toolCalls?: unknown } } };

export function toolFromRunLine(line: unknown): { tool: string; toolUseId?: string; ok: boolean } | undefined {
  const event = line as { type?: unknown; part?: ToolPart } | null;
  if (event?.type !== "tool_use") return undefined;
  const tool = text(event.part?.tool)?.slice(0, 100);
  if (!tool) return undefined;
  const toolUseId = text(event.part?.callID ?? (event.part?.partID === undefined ? undefined : event.part.id))?.slice(0, 200);
  return { tool, ...(toolUseId ? { toolUseId } : {}), ok: event.part?.state?.status !== "error" };
}

const MAX_NESTED = 200;

export function nestedToolsFromRunLine(line: unknown): { tool: string; toolUseId?: string; ok: boolean }[] {
  const event = line as { type?: unknown; part?: ToolPart } | null;
  const parent = toolFromRunLine(event);
  if (!parent || parent.tool !== "execute") return [];
  const calls = event?.part?.state?.metadata?.toolCalls;
  if (!Array.isArray(calls)) return [];
  const nested: { tool: string; toolUseId?: string; ok: boolean }[] = [];
  for (const [index, call] of calls.slice(0, MAX_NESTED).entries()) {
    const entry = call as { tool?: unknown; status?: unknown } | null;
    const tool = text(entry?.tool)?.slice(0, 100);
    if (!tool || (entry?.status !== "completed" && entry?.status !== "error")) continue;
    nested.push({ tool, ...(parent.toolUseId ? { toolUseId: `${parent.toolUseId}#${index}` } : {}), ok: entry.status === "completed" });
  }
  return nested;
}

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
      } catch {}
    }
    if (this.partial.length > MAX_PARTIAL_LINE) { this.partial = ""; this.discarding = true; }
    return objects;
  }
}
