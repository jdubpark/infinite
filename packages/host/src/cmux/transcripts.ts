import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { CmuxError } from "./client.js";
import type { CmuxProvider } from "./discovery.js";
import { parseTranscriptRecord, type TranscriptMessage } from "../transcript.js";

export type Message = TranscriptMessage;

const WINDOW = 4 * 1024 * 1024;
const MAX_MESSAGE = 128 * 1024;
const parseRecord = parseTranscriptRecord;

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
