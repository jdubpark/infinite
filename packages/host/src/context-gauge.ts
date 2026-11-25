export type GaugeProvider = "claude" | "codex";

export type ToolClass = "program" | "shell" | "file-read" | "file-write" | "search" | "web" | "mcp" | "agent" | "other";

export interface ClassCount { calls: number; chars: number; maxChars: number }

export interface ContextGauge {
  v: 1;
  provider: GaugeProvider;
  modelSteps: number;
  peakInputTokens: number;
  received: Partial<Record<ToolClass, ClassCount>>;
  insidePrograms: Partial<Record<ToolClass, ClassCount>>;
  images: number;
  unmatched: number;
  dropped: number;
}

const MAX_CALLS = 8192;
const MAX_STEP_IDS = 1024;
const MAX_ID_LENGTH = 256;

const TOOL_CLASSES: readonly ToolClass[] = ["program", "shell", "file-read", "file-write", "search", "web", "mcp", "agent", "other"];

const CLAUDE_CLASSES = new Map<string, ToolClass>([
  ["Bash", "shell"], ["BashOutput", "shell"], ["KillShell", "shell"],
  ["Read", "file-read"], ["NotebookRead", "file-read"],
  ["Edit", "file-write"], ["Write", "file-write"], ["MultiEdit", "file-write"], ["NotebookEdit", "file-write"],
  ["Grep", "search"], ["Glob", "search"], ["LS", "search"], ["ToolSearch", "search"], ["WebFetch", "web"], ["WebSearch", "web"],
  ["Agent", "agent"], ["Task", "agent"],
  ["REPL", "program"],
]);

const CODEX_CLASSES = new Map<string, ToolClass>([
  ["exec", "program"], ["wait", "program"],
  ["spawn_agent", "agent"], ["send_message", "agent"], ["wait_agent", "agent"], ["followup_task", "agent"], ["list_agents", "agent"],
]);

type Table = Partial<Record<ToolClass, ClassCount>>;
interface Measure { chars: number; images: number }

const SAFE = Number.MAX_SAFE_INTEGER;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const list = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_ID_LENGTH;
const claudeCount = (value: unknown): number => isCount(value) ? value : 0;
const saturate = (a: number, b: number): number => Math.min(SAFE, a + b);

function measure(content: unknown, isImage: (type: string) => boolean): Measure {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  const result: Measure = { chars: 0, images: 0 };
  for (const part of list(content) ?? []) {
    const value = object(part);
    if (!value) continue;
    if (typeof value.type === "string" && isImage(value.type)) result.images += 1;
    else if (typeof value.text === "string") result.chars = saturate(result.chars, value.text.length);
  }
  return result;
}

function tally(table: Table, cls: ToolClass, chars: number): void {
  const count = table[cls] ?? { calls: 0, chars: 0, maxChars: 0 };
  table[cls] = { calls: saturate(count.calls, 1), chars: saturate(count.chars, chars), maxChars: Math.max(count.maxChars, chars) };
}

function copyTable(table: Table): Table {
  const out: Table = {};
  for (const cls of TOOL_CLASSES) {
    const count = table[cls];
    if (count) out[cls] = { ...count };
  }
  return out;
}

function programItem(item: Record<string, unknown>): { cls: ToolClass; chars: number } | undefined {
  const length = (value: unknown) => typeof value === "string" ? value.length : 0;
  switch (item.type) {
    case "CommandExecution": return { cls: "shell", chars: length(item.aggregated_output) };
    case "McpToolCall": return { cls: "mcp", chars: measure(object(item.result)?.content, () => false).chars };
    case "FileChange": return { cls: "file-write", chars: length(item.stdout) + length(item.stderr) };
    case "Extension": return { cls: "web", chars: 0 };
    default: return undefined;
  }
}

const claudeClass = (name: string): ToolClass => name.startsWith("mcp__") ? "mcp" : CLAUDE_CLASSES.get(name) ?? "other";
const codexClass = (name: string): ToolClass =>
  CODEX_CLASSES.get(name) ?? (name.endsWith("_agent") || name.endsWith("_agents") ? "agent" : "other");

export class ContextGaugeTail {
  private readonly provider: GaugeProvider;
  private readonly calls = new Map<string, ToolClass>();
  private readonly stepIds = new Set<string>();
  private modelSteps = 0;
  private peak = 0;
  private sawRecord = false;
  private legacySteps = 0;
  private legacyPeak = 0;
  private readonly received: Table = {};
  private readonly inside: Table = {};
  private images = 0;
  private unmatched = 0;
  private dropped = 0;

  constructor(provider: GaugeProvider) {
    this.provider = provider;
  }

  push(row: unknown): void {
    try {
      const value = object(row);
      if (!value) return;
      if (this.provider === "claude") this.pushClaude(value);
      else this.pushCodex(value);
    } catch {
    }
  }

  pushLine(line: string): void {
    try {
      if (typeof line === "string") this.push(JSON.parse(line));
    } catch {
    }
  }

  snapshot(): ContextGauge {
    const legacy = this.provider === "codex" && !this.sawRecord;
    return {
      v: 1,
      provider: this.provider,
      modelSteps: legacy ? this.legacySteps : this.modelSteps,
      peakInputTokens: legacy ? this.legacyPeak : this.peak,
      received: copyTable(this.received),
      insidePrograms: copyTable(this.inside),
      images: this.images,
      unmatched: this.unmatched,
      dropped: this.dropped,
    };
  }

  private pushClaude(row: Record<string, unknown>): void {
    if (row.isSidechain === true || row.isVirtual === true) return;
    const message = object(row.message);
    if (!message) return;
    if (row.type === "assistant") {
      const usage = object(message.usage);
      const synthetic = typeof message.model === "string" && message.model.startsWith("<");
      if (usage && isId(message.id) && !synthetic) {
        const input = claudeCount(usage.input_tokens) + claudeCount(usage.cache_read_input_tokens) + claudeCount(usage.cache_creation_input_tokens);
        if (Number.isSafeInteger(input)) this.step(message.id, input);
      }
      for (const block of list(message.content) ?? []) {
        const value = object(block);
        if (value?.type === "tool_use" && isId(value.id) && typeof value.name === "string") this.remember(value.id, claudeClass(value.name));
      }
    } else if (row.type === "user") {
      for (const block of list(message.content) ?? []) {
        const value = object(block);
        if (value?.type === "tool_result") this.output(isId(value.tool_use_id) ? value.tool_use_id : undefined, value.content, type => type === "image");
      }
    }
  }

  private pushCodex(row: Record<string, unknown>): void {
    const payload = object(row.payload);
    if (row.type === "token_usage_record") {
      const input = object(payload?.usage)?.input_tokens;
      if (isId(payload?.response_id) && isCount(input)) {
        this.sawRecord = true;
        this.step(payload.response_id, input);
      }
    } else if (row.type === "event_msg" && payload?.type === "token_count") {
      const input = object(object(payload.info)?.last_token_usage)?.input_tokens;
      if (isCount(input)) {
        this.legacySteps = saturate(this.legacySteps, 1);
        this.legacyPeak = Math.max(this.legacyPeak, input);
      }
    } else if (row.type === "event_msg" && payload?.type === "item_completed") {
      const item = object(payload.item);
      const direct = item !== undefined && isId(item.id) && this.calls.has(item.id);
      const found = item && !direct ? programItem(item) : undefined;
      if (found) tally(this.inside, found.cls, found.chars);
    } else if (row.type === "response_item" && payload) {
      const callId = payload.call_id;
      if ((payload.type === "custom_tool_call" || payload.type === "function_call") && isId(callId) && typeof payload.name === "string") {
        this.remember(callId, codexClass(payload.name));
      } else if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
        this.output(isId(callId) ? callId : undefined, payload.output, type => type.includes("image"));
      }
    }
  }

  private step(id: string, input: number): void {
    this.peak = Math.max(this.peak, input);
    if (this.stepIds.delete(id)) { this.stepIds.add(id); return; }
    if (this.stepIds.size >= MAX_STEP_IDS) {
      const oldest = this.stepIds.values().next();
      if (!oldest.done) this.stepIds.delete(oldest.value);
    }
    this.stepIds.add(id);
    this.modelSteps = saturate(this.modelSteps, 1);
  }

  private remember(id: string, cls: ToolClass): void {
    if (this.calls.has(id)) return;
    if (this.calls.size >= MAX_CALLS) {
      const oldest = this.calls.keys().next();
      if (!oldest.done) this.calls.delete(oldest.value);
      this.dropped = saturate(this.dropped, 1);
    }
    this.calls.set(id, cls);
  }

  private output(callId: string | undefined, content: unknown, isImage: (type: string) => boolean): void {
    const cls = callId === undefined ? undefined : this.calls.get(callId);
    if (callId !== undefined) this.calls.delete(callId);
    if (cls === undefined) this.unmatched = saturate(this.unmatched, 1);
    const measured = measure(content, isImage);
    tally(this.received, cls ?? "other", measured.chars);
    this.images = saturate(this.images, measured.images);
  }
}
