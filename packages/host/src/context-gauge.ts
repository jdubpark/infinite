/** Measures tool output the model received, and output kept in the record, from transcript rows. Lengths only, never text. */
export type GaugeProvider = "claude" | "codex";

/** PROPOSED: tool classes. Each name is a coarse bucket of what a tool does, not a tool name. */
export type ToolClass = "program" | "shell" | "file-read" | "file-write" | "search" | "web" | "mcp" | "agent" | "other";

export interface ClassCount { calls: number; chars: number; maxChars: number }

export interface ContextGauge {
  v: 1;
  provider: GaugeProvider;
  modelSteps: number; // requests the model answered
  peakInputTokens: number; // the largest input of one model step
  received: Partial<Record<ToolClass, ClassCount>>; // tool output the model received
  insidePrograms: Partial<Record<ToolClass, ClassCount>>; // Codex only: results of calls a program made; the record keeps them
  images: number; // image parts in output the model received
  unmatched: number; // outputs with no known call
  dropped: number; // ids forgotten because a bound was reached
}

/** PROPOSED bounds: 8,192 recorded call ids and 8,192 pending program items. The oldest is forgotten first. */
const MAX_CALLS = 8192;
const MAX_PENDING = 8192;

const TOOL_CLASSES: readonly ToolClass[] = ["program", "shell", "file-read", "file-write", "search", "web", "mcp", "agent", "other"];

/** PROPOSED: Claude Code tool names by class. Any other name is `other`, and `mcp__` names are `mcp`. */
const CLAUDE_CLASSES = new Map<string, ToolClass>([
  ["Bash", "shell"], ["BashOutput", "shell"], ["KillShell", "shell"],
  ["Read", "file-read"], ["NotebookRead", "file-read"],
  ["Edit", "file-write"], ["Write", "file-write"], ["MultiEdit", "file-write"], ["NotebookEdit", "file-write"],
  ["Grep", "search"], ["Glob", "search"], ["LS", "search"], ["ToolSearch", "search"], ["WebFetch", "web"], ["WebSearch", "web"],
  ["Agent", "agent"], ["Task", "agent"],
]);

/** PROPOSED: Codex function names by class. Any other name is `other`. */
const CODEX_CLASSES = new Map<string, ToolClass>([
  ["exec", "program"], ["wait", "program"],
  ["spawn_agent", "agent"], ["send_message", "agent"], ["wait_agent", "agent"], ["followup_task", "agent"], ["list_agents", "agent"],
]);

type Table = Partial<Record<ToolClass, ClassCount>>;
interface Measure { chars: number; images: number }

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const list = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A Claude count: anything that is not a finite non-negative number counts as 0. */
const claudeNumber = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Output content: a string counts its length; a list counts each part's text. An image part adds no characters. */
function measure(content: unknown, isImage: (type: string) => boolean): Measure {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  const result: Measure = { chars: 0, images: 0 };
  for (const part of list(content) ?? []) {
    const value = object(part);
    if (!value) continue;
    if (typeof value.type === "string" && isImage(value.type)) result.images += 1;
    else if (typeof value.text === "string") result.chars += value.text.length;
  }
  return result;
}

function tally(table: Table, cls: ToolClass, chars: number): void {
  const count = table[cls] ?? { calls: 0, chars: 0, maxChars: 0 };
  table[cls] = { calls: count.calls + 1, chars: count.chars + chars, maxChars: Math.max(count.maxChars, chars) };
}

function copyTable(table: Table): Table {
  const out: Table = {};
  for (const cls of TOOL_CLASSES) {
    const count = table[cls];
    if (count) out[cls] = { ...count };
  }
  return out;
}

/** A Codex item a program made. Undefined for item types the gauge does not measure. */
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
/** Reads one row at a time; never throws. Codex program items wait in `pending` until a call row shows whether the model made the call. */
export class ContextGaugeTail {
  private readonly provider: GaugeProvider;
  private readonly calls = new Map<string, ToolClass>();
  private readonly pending = new Map<string, { cls: ToolClass; chars: number }>();
  private readonly received: Table = {};
  private readonly inside: Table = {};
  /** Claude message or Codex response ids, each with its largest input. */
  private readonly steps = new Map<string, number>();
  private peak = 0;
  /** Codex `token_count` rows, used only when the session has no valid `token_usage_record` row. */
  private sawRecord = false;
  private legacySteps = 0;
  private legacyPeak = 0;
  private images = 0;
  private unmatched = 0;
  private dropped = 0;

  constructor(provider: GaugeProvider) {
    this.provider = provider;
  }

  /** One parsed row. */
  push(row: unknown): void {
    try {
      const value = object(row);
      if (!value) return;
      if (this.provider === "claude") this.pushClaude(value);
      else this.pushCodex(value);
    } catch {
      // Unreadable rows change nothing.
    }
  }

  /** One JSON line; a line that does not parse is ignored. */
  pushLine(line: string): void {
    try {
      if (typeof line === "string") this.push(JSON.parse(line));
    } catch {
      // Not JSON.
    }
  }

  /** A fresh object on every call. */
  snapshot(): ContextGauge {
    const legacy = this.provider === "codex" && !this.sawRecord;
    const inside = copyTable(this.inside);
    for (const { cls, chars } of this.pending.values()) tally(inside, cls, chars);
    const steps = legacy ? this.legacySteps : this.steps.size;
    const peak = legacy ? this.legacyPeak : this.peak;
    return { v: 1, provider: this.provider, modelSteps: steps, peakInputTokens: peak, received: copyTable(this.received),
      insidePrograms: inside, images: this.images, unmatched: this.unmatched, dropped: this.dropped };
  }

  private pushClaude(row: Record<string, unknown>): void {
    if (row.isSidechain === true) return;
    const message = object(row.message);
    if (!message) return;
    if (row.type === "assistant") {
      const usage = object(message.usage);
      if (usage && typeof message.id === "string") {
        this.step(message.id, claudeNumber(usage.input_tokens) + claudeNumber(usage.cache_read_input_tokens) + claudeNumber(usage.cache_creation_input_tokens));
      }
      for (const block of list(message.content) ?? []) {
        const value = object(block);
        if (value?.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string") this.remember(value.id, claudeClass(value.name));
      }
    } else if (row.type === "user") {
      for (const block of list(message.content) ?? []) {
        const value = object(block);
        if (value?.type === "tool_result" && typeof value.tool_use_id === "string") {
          this.output(value.tool_use_id, value.content, type => type === "image");
        }
      }
    }
  }

  private pushCodex(row: Record<string, unknown>): void {
    const payload = object(row.payload);
    if (row.type === "token_usage_record") {
      const input = object(payload?.usage)?.input_tokens;
      if (typeof payload?.response_id === "string" && isCount(input)) {
        this.sawRecord = true;
        this.step(payload.response_id, input);
      }
    } else if (row.type === "event_msg" && payload?.type === "token_count") {
      const input = object(object(payload.info)?.last_token_usage)?.input_tokens;
      if (isCount(input)) {
        this.legacySteps += 1;
        this.legacyPeak = Math.max(this.legacyPeak, input);
      }
    } else if (row.type === "event_msg" && payload?.type === "item_completed") {
      const item = object(payload.item);
      if (item && typeof item.id === "string" && !this.calls.has(item.id)) {
        const found = programItem(item);
        if (found) this.hold(item.id, found.cls, found.chars);
      }
    } else if (row.type === "response_item" && payload) {
      const callId = payload.call_id;
      if ((payload.type === "custom_tool_call" || payload.type === "function_call") && typeof callId === "string" && typeof payload.name === "string") {
        this.remember(callId, CODEX_CLASSES.get(payload.name) ?? "other");
      } else if ((payload.type === "custom_tool_call_output" || payload.type === "function_call_output") && typeof callId === "string") {
        this.output(callId, payload.output, type => type.includes("image"));
      }
    }
  }

  private step(id: string, input: number): void {
    this.steps.set(id, Math.max(this.steps.get(id) ?? 0, input));
    this.peak = Math.max(this.peak, input);
  }

  /** A call row means the model made the call directly, so a pending item with this id is dropped. */
  private remember(id: string, cls: ToolClass): void {
    if (this.calls.has(id)) return;
    if (this.calls.size >= MAX_CALLS) {
      const oldest = this.calls.keys().next();
      if (!oldest.done) this.calls.delete(oldest.value);
      this.dropped += 1;
    }
    this.calls.set(id, cls);
    this.pending.delete(id);
  }

  /** Past the bound, the oldest pending item counts as inside a program. */
  private hold(id: string, cls: ToolClass, chars: number): void {
    if (this.pending.size >= MAX_PENDING && !this.pending.has(id)) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        const evicted = this.pending.get(oldest.value);
        this.pending.delete(oldest.value);
        if (evicted) tally(this.inside, evicted.cls, evicted.chars);
      }
      this.dropped += 1;
    }
    this.pending.set(id, { cls, chars });
  }

  private output(callId: string, content: unknown, isImage: (type: string) => boolean): void {
    const cls = this.calls.get(callId);
    if (cls === undefined) this.unmatched += 1;
    const measured = measure(content, isImage);
    tally(this.received, cls ?? "other", measured.chars);
    this.images += measured.images;
  }
}
