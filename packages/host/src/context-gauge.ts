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
  dropped: number; // call ids forgotten because a bound was reached
}

/**
 * PROPOSED bounds. A call id lives only while its call is in flight. The survey of 150 Codex records
 * showed at most one call in flight at once, so 8,192 is far above the need.
 */
const MAX_CALLS = 8192;
/** PROPOSED: the step ids seen most recently are kept for deduplication, and seeing an id again makes it recent. An id seen again after 1,024 other ids counts again. */
const MAX_STEP_IDS = 1024;
/**
 * PROPOSED: a string longer than this is not an id. An id only links rows. A call row or a step row without a usable id
 * links nothing and is not counted (a `token_count` row has no id by nature and counts by itself). An output or a
 * program item without one is still measured: the output as an unmatched `other` output, the item as inside a program.
 */
const MAX_ID_LENGTH = 256;

const TOOL_CLASSES: readonly ToolClass[] = ["program", "shell", "file-read", "file-write", "search", "web", "mcp", "agent", "other"];

/** PROPOSED: Claude Code tool names by class. Any other name is `other`, and `mcp__` names are `mcp`. */
const CLAUDE_CLASSES = new Map<string, ToolClass>([
  ["Bash", "shell"], ["BashOutput", "shell"], ["KillShell", "shell"],
  ["Read", "file-read"], ["NotebookRead", "file-read"],
  ["Edit", "file-write"], ["Write", "file-write"], ["MultiEdit", "file-write"], ["NotebookEdit", "file-write"],
  ["Grep", "search"], ["Glob", "search"], ["LS", "search"], ["ToolSearch", "search"], ["WebFetch", "web"], ["WebSearch", "web"],
  ["Agent", "agent"], ["Task", "agent"],
  // The Code Mode program call: its result is the program's output, like a Codex exec result.
  ["REPL", "program"],
]);

/** PROPOSED: Codex function names by class. Names ending in `_agent` or `_agents` are also `agent`; any other name is `other`. */
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
/**
 * PROPOSED numeric policy. A Claude token field counts only when it is a safe non-negative integer, otherwise 0, and a
 * step whose sum is not a safe integer is not counted. A Codex usage row with any other input value is not counted.
 */
const claudeCount = (value: unknown): number => isCount(value) ? value : 0;
/** Adds without exceeding Number.MAX_SAFE_INTEGER: a defence for totals far beyond an ordinary transcript (about 9e15 characters). No test exercises it. */
const saturate = (a: number, b: number): number => Math.min(SAFE, a + b);

/** Output content: a string counts its length; a list counts each part's text. An image part adds no characters. */
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

/** A Codex item a program made. Undefined for item types the gauge does not measure. */
function programItem(item: Record<string, unknown>): { cls: ToolClass; chars: number } | undefined {
  const length = (value: unknown) => typeof value === "string" ? value.length : 0;
  switch (item.type) {
    case "CommandExecution": return { cls: "shell", chars: length(item.aggregated_output) };
    case "McpToolCall": return { cls: "mcp", chars: measure(object(item.result)?.content, () => false).chars };
    case "FileChange": return { cls: "file-write", chars: length(item.stdout) + length(item.stderr) };
    // PROPOSED: an Extension result shape is not verified, so it counts as a call with no characters.
    case "Extension": return { cls: "web", chars: 0 };
    default: return undefined;
  }
}

const claudeClass = (name: string): ToolClass => name.startsWith("mcp__") ? "mcp" : CLAUDE_CLASSES.get(name) ?? "other";
const codexClass = (name: string): ToolClass =>
  CODEX_CLASSES.get(name) ?? (name.endsWith("_agent") || name.endsWith("_agents") ? "agent" : "other");

/**
 * Reads one row at a time; never throws.
 * PROPOSED: a Codex program item counts as inside a program unless its id is a call in flight. The survey
 * showed each direct call's item arrives between its call row and its output row, so an item before its
 * call row, or after its output row, is counted inside. That limit is kept, not fixed.
 */
export class ContextGaugeTail {
  private readonly provider: GaugeProvider;
  /** Call ids in flight. An id is forgotten when its output arrives. */
  private readonly calls = new Map<string, ToolClass>();
  /** Recent step ids for deduplication, in insertion order. */
  private readonly stepIds = new Set<string>();
  private modelSteps = 0;
  private peak = 0;
  /** Codex `token_count` rows, used only when the session has no valid `token_usage_record` row. PROPOSED: a session with only cumulative totals (no `last_token_usage`) gives no steps. */
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
      // PROPOSED, as transcript-usage.ts: a model name that starts with "<" marks a row the client wrote, so it is no step. Its content is still read.
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

  /** A step counts once per id among the 1,024 ids seen most recently. The peak is a running maximum. */
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

  /**
   * Remembers a call id until its output arrives. When full, the oldest id is forgotten and counted as dropped.
   * PROPOSED: a call row that repeats an id in flight changes nothing. The first class stays and no id is forgotten for it.
   */
  private remember(id: string, cls: ToolClass): void {
    if (this.calls.has(id)) return;
    if (this.calls.size >= MAX_CALLS) {
      const oldest = this.calls.keys().next();
      if (!oldest.done) this.calls.delete(oldest.value);
      this.dropped = saturate(this.dropped, 1);
    }
    this.calls.set(id, cls);
  }

  /** The output of a call: look up its class, count it, then forget the id. An output without a usable id is unmatched. */
  private output(callId: string | undefined, content: unknown, isImage: (type: string) => boolean): void {
    const cls = callId === undefined ? undefined : this.calls.get(callId);
    if (callId !== undefined) this.calls.delete(callId);
    if (cls === undefined) this.unmatched = saturate(this.unmatched, 1);
    const measured = measure(content, isImage);
    tally(this.received, cls ?? "other", measured.chars);
    this.images = saturate(this.images, measured.images);
  }
}
