// Provider transcripts (Claude Code project JSONL, Codex rollout JSONL) normalized into chat
// messages. Shared by the cmux reader, which reads files directly, and the worker, which
// receives the bytes from the hook relay because the agent's home is private to its account.

export type TranscriptProvider = "claude" | "codex";

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  ts?: string;
}

type Json = Record<string, any>;
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

const INJECTED = /^(?:<environment_context>|<user_instructions>|# AGENTS\.md|<permissions instructions>|<INSTRUCTIONS>)/;

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  return array(content).flatMap((block) => {
    if (["text", "input_text", "output_text"].includes(block.type) && typeof block.text === "string") return [block.text];
    if (["image", "input_image"].includes(block.type)) return ["[image]"];
    return [];
  }).join("\n").trim();
}

function userText(text: string): string {
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (command) return [command[1].trim(), /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim()].filter(Boolean).join(" ");
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return /^<(?:local-command-(?:stdout|stderr|caveat)|command-message|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)[\s>]/.test(cleaned) ? "" : cleaned;
}

function toolText(name: string, input: unknown): string {
  const data = object(input);
  const text = string(data.command) ?? string(data.cmd) ?? string(data.file_path) ?? string(data.path) ?? string(data.description) ?? string(data.prompt);
  return text ? text.slice(0, 2000) : name;
}

/** One JSONL record to the chat messages it contains. Unknown or injected records yield none. */
export function parseTranscriptRecord(raw: string, provider: TranscriptProvider, offset: number): TranscriptMessage[] {
  let row: Json;
  try { row = object(JSON.parse(raw)); } catch { return []; }
  const ts = string(row.timestamp);
  if (provider === "claude") {
    if (row.isSidechain || row.isMeta || row.isCompactSummary || row.isVisibleInTranscriptOnly) return [];
    const id = string(row.uuid) ?? `line-${offset}`;
    if (row.type === "attachment" && row.attachment?.type === "queued_command") {
      const text = userText(string(row.attachment.prompt) ?? "");
      return text ? [{ id, role: "user", text, ts }] : [];
    }
    if (row.type === "user") {
      const text = userText(textContent(row.message?.content));
      return text ? [{ id, role: "user", text, ts }] : [];
    }
    if (row.type !== "assistant") return [];
    const content = row.message?.content;
    if (typeof content === "string") return content.trim() ? [{ id, role: "assistant", text: content.trim(), ts }] : [];
    return array(content).flatMap((block, i): TranscriptMessage[] => {
      if (block.type === "text" && string(block.text)) return [{ id: `${id}:${i}`, role: "assistant", text: block.text, ts }];
      if (block.type === "tool_use" && string(block.name)) return [{ id: `${id}:${i}`, role: "tool", text: toolText(block.name, block.input), toolName: block.name, ts }];
      return [];
    });
  }
  if (row.type !== "response_item") return [];
  const payload = object(row.payload);
  const id = string(payload.id) ?? `line-${offset}`;
  if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
    const text = textContent(payload.content);
    const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
    if (payload.role === "user" && (Array.isArray(kinds) ? !kinds.includes("user.text") : INJECTED.test(text))) return [];
    // The chat view includes user-visible replies; provider analysis is not a message.
    if (payload.role === "assistant" && payload.channel === "analysis") return [];
    return text ? [{ id, role: payload.role, text, ts }] : [];
  }
  const name = string(payload.name) ?? "tool";
  if (payload.type === "function_call") {
    let input: unknown;
    try { input = JSON.parse(payload.arguments); } catch { input = {}; }
    return [{ id, role: "tool", text: toolText(name, input), toolName: name, ts }];
  }
  if (payload.type === "custom_tool_call") return [{ id, role: "tool", text: (string(payload.input) ?? name).slice(0, 2000), toolName: name, ts }];
  return [];
}

/** Longest text kept per message once it enters a recording. */
export const MAX_RECORDED_MESSAGE = 16 * 1024;
const MAX_PARTIAL_LINE = 4 * 1024 * 1024;

/**
 * Incremental transcript ingestion. Bytes arrive in order from a known file offset; a record
 * split across two chunks waits for its newline. Messages already seen by id are not repeated,
 * so a relay retry after a lost acknowledgement cannot duplicate chat.
 */
export class TranscriptTail {
  offset = 0;
  private partial = "";
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(readonly provider: TranscriptProvider, private readonly remember = 4096) {}

  /** Appends `text`, which must start at `this.offset`, and returns the new complete messages. */
  ingest(text: string): TranscriptMessage[] {
    this.offset += Buffer.byteLength(text);
    let buffer = this.partial + text;
    const messages: TranscriptMessage[] = [];
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      for (const message of parseTranscriptRecord(line, this.provider, this.offset)) {
        if (this.seen.has(message.id)) continue;
        this.seen.add(message.id); this.order.push(message.id);
        if (this.order.length > this.remember) this.seen.delete(this.order.shift()!);
        messages.push({ ...message, text: message.text.slice(0, MAX_RECORDED_MESSAGE) });
      }
    }
    // A record that never ends is not a transcript; drop it rather than grow without bound.
    this.partial = buffer.length > MAX_PARTIAL_LINE ? "" : buffer;
    return messages;
  }
}
