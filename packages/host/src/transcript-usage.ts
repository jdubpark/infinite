import type { UsageRecord, UsageTokens } from "./usage.js";

export type UsageTranscriptProvider = "claude" | "codex";

export interface UsageTailOptions {
  provider: UsageTranscriptProvider;
  requestedModel?: string;
  secondary?: boolean;
}

type ModelOrigin = { providerId: string; modelId: string; modelSource: UsageRecord["modelSource"] };

interface ClaudeCounts { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number; oneHour: number }
const CLAUDE_COUNT_KEYS = ["input", "output", "thinking", "cacheRead", "cacheWrite", "oneHour"] as const;

const MAX_MESSAGES = 4096;
const MAX_TURNS = 256;
const MAX_REQUESTS = 4096;
const CLASSES = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function optionalCount(value: unknown): number | undefined {
  return value === undefined ? 0 : isCount(value) ? value : undefined;
}

function claudeCounts(usage: Record<string, unknown>): ClaudeCounts | undefined {
  const { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } = usage;
  if (!isCount(input) || !isCount(output) || !isCount(cacheRead) || !isCount(cacheWrite)) return undefined;
  const thinking = optionalCount(object(usage.output_tokens_details)?.thinking_tokens);
  if (thinking === undefined || thinking > output) return undefined;
  const oneHour = optionalCount(object(usage.cache_creation)?.ephemeral_1h_input_tokens);
  if (oneHour === undefined || oneHour > cacheWrite) return undefined;
  return { input, output, thinking, cacheRead, cacheWrite, oneHour };
}

function claudeTokens(counts: ClaudeCounts): UsageTokens {
  return { input: counts.input, output: counts.output - counts.thinking, reasoning: counts.thinking, cacheRead: counts.cacheRead, cacheWrite: counts.cacheWrite };
}

function codexTokens(usage: Record<string, unknown>): UsageTokens | undefined {
  const { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total } = usage;
  if (!isCount(input) || !isCount(cached) || !isCount(cacheWrite) || !isCount(output) || !isCount(reasoning) || !isCount(total)) return undefined;
  if (cached > input || reasoning > output || total !== input + output) return undefined;
  return { input: input - cached, cacheRead: cached, cacheWrite, output: output - reasoning, reasoning };
}

export class UsageTail {
  private readonly options: UsageTailOptions;
  private readonly messages = new Map<string, ClaudeCounts>();
  private readonly turnModels = new Map<string, string>();
  private lastTurnModel: string | undefined;
  private turns = 0;
  private openTurn: { id: string | undefined } | undefined;
  private sawRequestRows = false;
  private threadId: string | undefined;
  private total: number | undefined;
  private cumulative: UsageTokens | undefined;
  private cumulativeAt: string | undefined;
  private rows = 0;
  private records = 0;
  private requestTokens = 0;
  private childThreads = false;
  private rejected = 0;
  private readonly requests = new Map<string, { total: number; tokens: UsageTokens }>();
  private requestOverflow = false;

  constructor(options: UsageTailOptions) {
    this.options = options;
  }

  push(row: unknown): UsageRecord[] {
    this.rows += 1;
    let records: UsageRecord[] = [];
    try {
      const value = object(row);
      if (value) records = this.options.provider === "claude" ? this.pushClaude(value) : this.pushCodex(value);
    } catch {
      records = [];
    }
    this.records += records.length;
    return records;
  }

  finish(): UsageRecord[] {
    const records = this.fallbackRecords();
    this.records += records.length;
    return records;
  }

  cumulativeTotal(): number | undefined {
    return this.total;
  }

  rowCount(): number {
    return this.rows;
  }

  recordCount(): number {
    return this.records;
  }

  requestTotal(): number {
    return this.requestTokens;
  }

  lastTurnEnded(): boolean {
    return this.turns > 0 && this.openTurn === undefined;
  }

  private rowInTurn() {
    this.openTurn ??= { id: undefined };
  }

  sawChildThreads(): boolean {
    return this.childThreads;
  }

  rejectedCount(): number {
    return this.rejected;
  }

  reconciled(): boolean {
    if (this.options.provider !== "codex") return true;
    if (this.requestOverflow) return false;
    if (this.sawRequestRows) return this.total !== undefined && this.requestTokens === this.total;
    return !this.total || this.threadId !== undefined;
  }

  private fallbackRecords(): UsageRecord[] {
    const threadId = this.threadId;
    if (this.options.provider !== "codex" || this.sawRequestRows || !threadId || !this.cumulative || !this.cumulativeAt) return [];
    const model = this.modelOf(this.lastTurnModel);
    return [this.stamp({
      provider: "codex", providerId: model.providerId, modelId: model.modelId, messageId: `cumulative:${threadId}`, partId: "",
      nativeId: threadId, modelSource: model.modelSource, completedAt: this.cumulativeAt,
      tokens: { ...this.cumulative }, reportedCost: 0,
    })];
  }

  private pushClaude(row: Record<string, unknown>): UsageRecord[] {
    if (row.type !== "assistant") return [];
    const message = object(row.message);
    const usage = object(message?.usage);
    if (!message || !usage || (typeof message.model === "string" && message.model.startsWith("<"))) return [];
    const messageId = text(message.id);
    const modelId = text(message.model);
    const completedAt = text(row.timestamp);
    const parsed = claudeCounts(usage);
    if (!messageId || !modelId || !completedAt || !parsed) {
      this.rejected += 1;
      return [];
    }

    const seen = this.messages.get(messageId);
    const merged: ClaudeCounts = seen ? {
      input: Math.max(seen.input, parsed.input), output: Math.max(seen.output, parsed.output),
      thinking: Math.max(seen.thinking, parsed.thinking), cacheRead: Math.max(seen.cacheRead, parsed.cacheRead),
      cacheWrite: Math.max(seen.cacheWrite, parsed.cacheWrite), oneHour: Math.max(seen.oneHour, parsed.oneHour),
    } : parsed;
    if (seen && CLAUDE_COUNT_KEYS.every(key => merged[key] === seen[key])) return [];
    if (!seen && this.messages.size >= MAX_MESSAGES) {
      const oldest = this.messages.keys().next();
      if (!oldest.done) this.messages.delete(oldest.value);
    }
    this.messages.set(messageId, merged);

    const sessionId = text(row.sessionId);
    return [this.stamp({
      provider: "claude", providerId: "claude", modelId, messageId, partId: "",
      ...(sessionId ? { nativeId: sessionId } : {}),
      modelSource: "reported", completedAt, tokens: claudeTokens(merged),
      ...(merged.oneHour > 0 ? { cacheWrite1h: merged.oneHour } : {}),
      reportedCost: 0,
    })];
  }

  private pushCodex(row: Record<string, unknown>): UsageRecord[] {
    const payload = object(row.payload);
    if (row.type === "inter_agent_communication_metadata") {
      this.childThreads = true;
      return [];
    }
    if (row.type === "session_meta") {
      this.threadId ??= text(payload?.id);
      return [];
    }
    if (row.type === "turn_context") {
      this.rowInTurn();
      const turnId = text(payload?.turn_id);
      const model = text(payload?.model);
      if (turnId && model) {
        if (!this.turnModels.has(turnId) && this.turnModels.size >= MAX_TURNS) {
          const oldest = this.turnModels.keys().next();
          if (!oldest.done) this.turnModels.delete(oldest.value);
        }
        this.turnModels.set(turnId, model);
        this.lastTurnModel = model;
      }
      return [];
    }
    if (row.type === "token_usage_record") {
      this.sawRequestRows = true;
      this.rowInTurn();
      return this.requestRecord(row, payload);
    }
    if (row.type === "event_msg" && payload?.type === "task_started") {
      this.turns += 1;
      this.openTurn = { id: text(payload.turn_id) };
    }
    if (row.type === "event_msg" && payload?.type === "task_complete" && this.openTurn?.id !== undefined && text(payload.turn_id) === this.openTurn.id)
      this.openTurn = undefined;
    if (row.type === "event_msg" && payload?.type === "token_count") this.cumulativeRow(row, payload);
    return [];
  }

  private requestRecord(row: Record<string, unknown>, payload: Record<string, unknown> | undefined): UsageRecord[] {
    const messageId = text(payload?.response_id);
    const completedAt = text(row.timestamp);
    const usage = object(payload?.usage);
    const tokens = usage ? codexTokens(usage) : undefined;
    const total = usage?.total_tokens;
    if (!messageId || !completedAt || !tokens || !isCount(total)) {
      this.rejected += 1;
      return [];
    }
    const seen = this.requests.get(messageId);
    if (seen && total <= seen.total) return [];
    const delta = seen ? { input: tokens.input - seen.tokens.input, output: tokens.output - seen.tokens.output, reasoning: tokens.reasoning - seen.tokens.reasoning, cacheRead: tokens.cacheRead - seen.tokens.cacheRead, cacheWrite: tokens.cacheWrite - seen.tokens.cacheWrite } : tokens;
    if (CLASSES.some(key => delta[key] < 0)) {
      this.rejected += 1;
      return [];
    }
    if (!seen && this.requests.size >= MAX_REQUESTS) this.requestOverflow = true;
    else this.requests.set(messageId, { total, tokens });
    this.requestTokens += total - (seen?.total ?? 0);
    const turnId = text(payload?.turn_id);
    const model = this.modelOf(turnId ? this.turnModels.get(turnId) : undefined);
    const nativeId = text(payload?.thread_id);
    return [this.stamp({
      provider: "codex", providerId: model.providerId, modelId: model.modelId, messageId, partId: "",
      ...(nativeId ? { nativeId } : {}),
      modelSource: model.modelSource, completedAt, tokens, reportedCost: 0,
    })];
  }

  private cumulativeRow(row: Record<string, unknown>, payload: Record<string, unknown>): void {
    const total = object(object(payload.info)?.total_token_usage);
    if (!total) return;
    const completedAt = text(row.timestamp);
    const tokens = codexTokens(total);
    const totalTokens = total.total_tokens;
    if (!completedAt || !tokens || !isCount(totalTokens)) {
      this.rejected += 1;
      return;
    }
    if (totalTokens <= (this.total ?? 0)) return;
    this.total = totalTokens;
    this.cumulative = tokens;
    this.cumulativeAt = completedAt;
  }

  private modelOf(reported: string | undefined): ModelOrigin {
    if (reported) return { providerId: "codex", modelId: reported, modelSource: "reported" };
    if (this.options.requestedModel) return { providerId: "codex", modelId: this.options.requestedModel, modelSource: "requested" };
    return { providerId: "codex", modelId: "unknown", modelSource: "unknown" };
  }

  private stamp(record: UsageRecord): UsageRecord {
    return this.options.secondary ? { ...record, secondary: true } : record;
  }
}

export function usageRecordKey(record: UsageRecord): string {
  return `${record.provider}:${record.messageId}`;
}

export type UsageCoverage = "none" | "partial" | "complete";
export type UsageCoverageReason = "hooks-off" | "no-transcript" | "no-usage-fields" | "unsupported"
  | "row-dropped" | "drain-skipped" | "drain-incomplete" | "stopped-mid-turn" | "secondary-missing" | "child-threads";

export type SecondaryState = "none" | "complete" | "missing";

export interface UsageCoverageInput {
  provider: string;
  hooks: boolean;
  rows: number;
  records: number;
  dropped: boolean;
  lastDrain?: { complete: boolean; turnEnd: boolean };
  finalDrain?: "complete" | "incomplete" | "skipped";
  secondary: SecondaryState;
  childThreads: boolean;
  totalMismatch: boolean;
}

const COVERED_PROVIDERS = new Set(["claude", "codex", "demo"]);

export function usageCoverage(input: UsageCoverageInput): { coverage: UsageCoverage; reason?: UsageCoverageReason } {
  if (!COVERED_PROVIDERS.has(input.provider)) return { coverage: "none", reason: "unsupported" };
  if (!input.hooks) return { coverage: "none", reason: "hooks-off" };
  if (input.rows === 0) return { coverage: "none", reason: "no-transcript" };
  if (input.records === 0) return { coverage: "none", reason: "no-usage-fields" };
  if (input.dropped || input.totalMismatch) return { coverage: "partial", reason: "row-dropped" };
  if (input.finalDrain === "skipped" && (!input.lastDrain || !input.lastDrain.complete || !input.lastDrain.turnEnd)) return { coverage: "partial", reason: "drain-skipped" };
  if (!input.lastDrain || !input.lastDrain.complete) return { coverage: "partial", reason: "drain-incomplete" };
  if (!input.lastDrain.turnEnd) return { coverage: "partial", reason: "stopped-mid-turn" };
  if (input.secondary === "missing") return { coverage: "partial", reason: "secondary-missing" };
  if (input.childThreads) return { coverage: "partial", reason: "child-threads" };
  return { coverage: "complete" };
}
