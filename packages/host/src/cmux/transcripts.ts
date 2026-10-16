import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { CmuxError, array, object, string, type Json } from "./client.js";
import type { CmuxProvider } from "./discovery.js";

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  ts?: string;
}

const WINDOW = 4 * 1024 * 1024;
const MAX_MESSAGE = 128 * 1024;
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

function parseRecord(raw: string, provider: CmuxProvider, offset: number): Message[] {
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
    return array(content).flatMap((block, i): Message[] => {
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

/** Bounded, append-aware reads. The cursor includes a block index to avoid dropping
 * additional messages when one JSONL record crosses a page boundary. */
export function readTranscript(path: string | undefined, provider: CmuxProvider, after?: string, limit = 200): { messages: Message[]; cursor: string; more: boolean } {
  if (after !== undefined && !/^\d+(?::\d+)?$/.test(after)) throw new CmuxError("invalid-cursor");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new CmuxError("invalid-limit");
  if (!path) return { messages: [], cursor: "0", more: false };
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return { messages: [], cursor: after ?? "0", more: false }; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { messages: [], cursor: after ?? "0", more: false };
    const [startText, blockText = "0"] = (after ?? "0").split(":");
    const requested = Number(startText), requestedBlock = Number(blockText);
    if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(requestedBlock) || requested > stat.size) throw new CmuxError("invalid-cursor", "Transcript changed; reload the conversation");
    const start = after === undefined ? Math.max(0, stat.size - WINDOW) : requested;
    const buffer = Buffer.alloc(Math.min(WINDOW, stat.size - start));
    const length = readSync(fd, buffer, 0, buffer.length, start);
    let position = after === undefined && start > 0 ? buffer.indexOf(10) + 1 : 0;
    if (position === 0 && start > 0 && after === undefined) return { messages: [], cursor: String(start), more: false };
    let cursor = String(start + position);
    const messages: Message[] = [];
    let bytes = 0;
    while (position < length) {
      const end = buffer.indexOf(10, position);
      if (end < 0 || end >= length) break; // An incomplete append is read next time.
      const offset = start + position;
      const parsed = parseRecord(buffer.toString("utf8", position, end), provider, offset);
      const first = after !== undefined && offset === requested ? requestedBlock : 0;
      for (let i = first; i < parsed.length; i++) {
        if (after !== undefined && (messages.length >= limit || bytes >= 512 * 1024)) return { messages, cursor: `${offset}:${i}`, more: true };
        const message = parsed[i];
        message.id = `${provider}:${createHash("sha256").update(path).digest("hex").slice(0, 12)}:${message.id}`;
        message.text = message.text.slice(0, MAX_MESSAGE);
        bytes += Buffer.byteLength(message.text);
        messages.push(message);
      }
      position = end + 1;
      cursor = String(start + position);
    }
    // A single oversized record must not pin the cursor forever. Skip complete
    // oversized lines without parsing them; partial final lines still wait.
    if (position === 0 && length === WINDOW && after !== undefined) {
      let scanned = start + length;
      while (scanned < stat.size && scanned - start < 64 * 1024 * 1024) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - scanned), scanned);
        const newline = buffer.subarray(0, count).indexOf(10);
        if (newline >= 0) return { messages: [], cursor: String(scanned + newline + 1), more: scanned + newline + 1 < stat.size };
        if (!count) break;
        scanned += count;
      }
    }
    const page = after === undefined ? messages.slice(-limit) : messages;
    if (after === undefined) {
      let size = page.reduce((total, message) => total + Buffer.byteLength(message.text), 0);
      while (size > 512 * 1024 && page.length > 1) size -= Buffer.byteLength(page.shift()!.text);
    }
    return { messages: page, cursor, more: position > 0 && start + length < stat.size };
  } finally { closeSync(fd); }
}
