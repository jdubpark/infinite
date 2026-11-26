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
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
const EXTENSION_PAYLOAD_KEYS = ["results", "result", "output", "content", "structuredContent", "text"] as const;
const MAX_PAYLOAD_DEPTH = 8;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const list = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
const claudeCount = (value: unknown): number => isCount(value) ? value : 0;

export function saturate(a: number, b: number, limit = SAFE): number {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(SAFE, Math.floor(limit)) : 0;
  if (cap === 0) return 0;
  const left = Number.isFinite(a) && a > 0 ? Math.min(cap, a) : a === Infinity ? cap : 0;
  const right = Number.isFinite(b) && b > 0 ? Math.min(cap, b) : b === Infinity ? cap : 0;
  return left >= cap - right ? cap : left + right;
}

function measure(content: unknown, isImage: (type: string) => boolean): Measure {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  const result: Measure = { chars: 0, images: 0 };
  for (const part of list(content) ?? []) {
    const value = object(part);
    if (!value) continue;
    if (typeof value.type === "string" && isImage(value.type)) result.images = saturate(result.images, 1);
    else if (typeof value.text === "string") result.chars = saturate(result.chars, value.text.length);
  }
  return result;
}

function serializedLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || text === "{}" || text === "[]") return 0;
    return text.length;
  } catch {
    return 0;
  }
}

function isImageMime(record: Record<string, unknown>): boolean {
  const mime = typeof record.mimeType === "string" ? record.mimeType : typeof record.mime_type === "string" ? record.mime_type : undefined;
  return mime !== undefined && mime.toLowerCase().startsWith("image/");
}

function isImagePart(value: Record<string, unknown>): boolean {
  if (typeof value.type === "string" && value.type.toLowerCase().includes("image")) return true;
  if (value.image_url !== undefined || value.imageUrl !== undefined) return true;
  if (isImageMime(value)) return true;
  const resource = object(value.resource);
  return resource !== undefined && isImageMime(resource);
}

function measureOpaque(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value && typeof value === "object") return serializedLength(value);
  return 0;
}

function measureContentArray(items: unknown[]): number {
  let chars = 0;
  for (let i = 0; i < items.length; i += 1) {
    const part = items[i];
    if (typeof part === "string") {
      chars = saturate(chars, part.length);
      continue;
    }
    const value = object(part);
    if (!value) {
      if (part !== undefined && part !== null && typeof part === "object") chars = saturate(chars, serializedLength(part));
      continue;
    }
    if (isImagePart(value)) continue;
    if (typeof value.type === "string" && TEXT_PART_TYPES.has(value.type) && typeof value.text === "string") {
      chars = saturate(chars, value.text.length);
    } else if (value.type === undefined && typeof value.text === "string" && Object.keys(value).length === 1) {
      chars = saturate(chars, value.text.length);
    } else {
      chars = saturate(chars, serializedLength(value));
    }
  }
  return chars;
}

function measureKey(key: (typeof EXTENSION_PAYLOAD_KEYS)[number], value: unknown, depth: number): number {
  if (key === "results" || key === "structuredContent") return measureOpaque(value);
  return measurePayload(value, depth);
}

function measurePayload(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return measureContentArray(value);
  const record = object(value);
  if (!record) return 0;
  if (depth < MAX_PAYLOAD_DEPTH) {
    let matched = false;
    for (const key of EXTENSION_PAYLOAD_KEYS) {
      if (!Object.hasOwn(record, key)) continue;
      matched = true;
      const chars = measureKey(key, record[key], depth + 1);
      if (chars > 0) return chars;
    }
    if (matched) return 0;
  }
  return serializedLength(record);
}

function extensionClass(item: Record<string, unknown>): ToolClass {
  const kind = typeof item.kind === "string" ? item.kind : undefined;
  return !kind || kind.startsWith("web.") ? "web" : "other";
}

function measureExtension(item: Record<string, unknown>): number {
  for (const key of EXTENSION_PAYLOAD_KEYS) {
    if (!Object.hasOwn(item, key)) continue;
    const chars = measureKey(key, item[key], 0);
    if (chars > 0) return chars;
  }
  return 0;
}

function tally(table: Table, cls: ToolClass, chars: number): void {
  const count = table[cls] ?? { calls: 0, chars: 0, maxChars: 0 };
  table[cls] = { calls: saturate(count.calls, 1), chars: saturate(count.chars, chars), maxChars: Math.max(count.maxChars, chars) };
}

function mergeTable(target: Table, source: Table): void {
  for (const cls of TOOL_CLASSES) {
    const add = source[cls];
    if (!add) continue;
    const count = target[cls] ?? { calls: 0, chars: 0, maxChars: 0 };
    target[cls] = {
      calls: saturate(count.calls, add.calls),
      chars: saturate(count.chars, add.chars),
      maxChars: Math.max(count.maxChars, add.maxChars),
    };
  }
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
    case "FileChange": return { cls: "file-write", chars: saturate(length(item.stdout), length(item.stderr)) };
    case "Extension": return { cls: extensionClass(item), chars: measureExtension(item) };
    default: return undefined;
  }
}

const claudeClass = (name: string): ToolClass => name.startsWith("mcp__") ? "mcp" : CLAUDE_CLASSES.get(name) ?? "other";
const codexClass = (name: string): ToolClass =>
  CODEX_CLASSES.get(name) ?? (name.endsWith("_agent") || name.endsWith("_agents") ? "agent" : "other");

export class ContextGaugeTail {
  private readonly provider: GaugeProvider;
  private readonly calls = new Map<string, ToolClass>();
  private readonly directIds = new Set<string>();
  private readonly pendingOutputs = new Map<string, number>();
  private readonly pendingItems = new Map<string, Table>();
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
    const received = copyTable(this.received);
    let unmatched = this.unmatched;
    for (const chars of this.pendingOutputs.values()) {
      tally(received, "other", chars);
      unmatched = saturate(unmatched, 1);
    }
    const inside = copyTable(this.inside);
    for (const table of this.pendingItems.values()) mergeTable(inside, table);
    return {
      v: 1,
      provider: this.provider,
      modelSteps: legacy ? this.legacySteps : this.modelSteps,
      peakInputTokens: legacy ? this.legacyPeak : this.peak,
      received,
      insidePrograms: inside,
      images: this.images,
      unmatched,
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
      if (!item) return;
      const id = isId(item.call_id) ? item.call_id : isId(item.id) ? item.id : undefined;
      if (id !== undefined && (this.calls.has(id) || this.directIds.has(id) || this.pendingOutputs.has(id))) return;
      const found = programItem(item);
      if (found) this.recordProgramItem(id, found.cls, found.chars);
    } else if (row.type === "response_item" && payload) {
      const callId = payload.call_id;
      if ((payload.type === "custom_tool_call" || payload.type === "function_call") && isId(callId) && typeof payload.name === "string") {
        this.markDirect(callId);
        this.remember(callId, codexClass(payload.name));
      } else if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
        const id = isId(callId) ? callId : undefined;
        if (id !== undefined) this.markDirect(id);
        this.output(id, payload.output, type => type.includes("image"));
      } else if (payload.type === "web_search_call" || payload.type === "image_generation_call") {
        const id = isId(payload.id) ? payload.id : isId(callId) ? callId : undefined;
        if (id !== undefined) this.markDirect(id);
      }
    }
  }

  private markDirect(id: string): void {
    this.pendingItems.delete(id);
    if (this.directIds.delete(id)) { this.directIds.add(id); return; }
    if (this.directIds.size >= MAX_CALLS) {
      const oldest = this.directIds.values().next();
      if (!oldest.done) this.directIds.delete(oldest.value);
    }
    this.directIds.add(id);
  }

  private recordProgramItem(id: string | undefined, cls: ToolClass, chars: number): void {
    if (id === undefined) {
      tally(this.inside, cls, chars);
      return;
    }
    const existing = this.pendingItems.get(id);
    if (existing) {
      tally(existing, cls, chars);
      this.pendingItems.delete(id);
      this.pendingItems.set(id, existing);
      return;
    }
    if (this.pendingItems.size >= MAX_CALLS) {
      const oldest = this.pendingItems.entries().next();
      if (!oldest.done) {
        this.pendingItems.delete(oldest.value[0]);
        mergeTable(this.inside, oldest.value[1]);
      }
    }
    const table: Table = {};
    tally(table, cls, chars);
    this.pendingItems.set(id, table);
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
    const pending = this.pendingOutputs.get(id);
    if (pending !== undefined) {
      this.pendingOutputs.delete(id);
      tally(this.received, cls, pending);
      return;
    }
    if (this.calls.size >= MAX_CALLS) {
      const oldest = this.calls.keys().next();
      if (!oldest.done) this.calls.delete(oldest.value);
      this.dropped = saturate(this.dropped, 1);
    }
    this.calls.set(id, cls);
  }

  private output(callId: string | undefined, content: unknown, isImage: (type: string) => boolean): void {
    const measured = measure(content, isImage);
    this.images = saturate(this.images, measured.images);
    if (callId === undefined) {
      this.unmatched = saturate(this.unmatched, 1);
      tally(this.received, "other", measured.chars);
      return;
    }
    const cls = this.calls.get(callId);
    if (cls !== undefined) {
      this.calls.delete(callId);
      tally(this.received, cls, measured.chars);
      return;
    }
    if (this.pendingOutputs.has(callId)) {
      this.unmatched = saturate(this.unmatched, 1);
      tally(this.received, "other", measured.chars);
      return;
    }
    if (this.pendingOutputs.size >= MAX_CALLS) {
      const oldest = this.pendingOutputs.entries().next();
      if (!oldest.done) {
        this.pendingOutputs.delete(oldest.value[0]);
        this.unmatched = saturate(this.unmatched, 1);
        tally(this.received, "other", oldest.value[1]);
      }
    }
    this.pendingOutputs.set(callId, measured.chars);
  }
}
