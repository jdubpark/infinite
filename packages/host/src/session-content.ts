import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Manager } from "./manager.js";
import type { Session } from "./types.js";

export class ContentError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  ts: string;
  /** Journal position of the recording event, comparable with the page cursor. */
  seq?: number;
}

/**
 * Only explicit recorded messages become chat; terminal output remains terminal output.
 * With `transcript`, the provider's own conversation record was journaled as `message`
 * events, which already carry the prompts and replies the fallback would synthesize.
 */
export function recordedMessages(manager: Manager, session: Session, after = "0", limit = 200, transcript = false) {
  if (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after)))
    throw new ContentError("Invalid message cursor", 400);
  const page = manager.events(session.id, Number(after), limit);
  const messages: ChatMessage[] = [];
  if (after === "0" && session.initialPrompt && !transcript) messages.push({
    id: "initial", role: "user", text: session.initialPrompt, ts: session.createdAt,
  });
  for (const event of page.events) {
    const data = event.data;
    if (event.type === "message") {
      if (typeof data.text !== "string" || !["user", "assistant", "tool"].includes(String(data.role))) continue;
      messages.push({
        id: typeof data.id === "string" ? `message:${data.id}` : `message:${event.seq}`,
        role: data.role as ChatMessage["role"], text: data.text,
        ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}),
        ts: typeof data.ts === "string" ? data.ts : event.at, seq: event.seq,
      });
    } else if (transcript) {
      continue;
    } else if (event.type === "input-result" && data.state === "delivered" && typeof data.message === "string") {
      messages.push({ id: `input:${event.seq}`, role: "user", text: data.message, ts: event.at, seq: event.seq });
    } else if (event.type === "signal" && data.kind === "turn-end" && typeof data.message === "string" && data.message.trim()) {
      messages.push({ id: `reply:${event.seq}`, role: "assistant", text: data.message, ts: event.at, seq: event.seq });
    } else if (event.type === "signal" && data.kind === "tool-start" && typeof data.tool === "string") {
      messages.push({ id: `tool:${event.seq}`, role: "tool", toolName: data.tool, text: data.tool, ts: event.at, seq: event.seq });
    }
  }
  return { messages, cursor: String(page.cursor), more: page.more, source: transcript ? "transcript" : "recording", available: messages.length > 0 };
}

const images: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
function contained(root: string, file: string) {
  const path = relative(root, file);
  return path !== "" && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== ".." && !isAbsolute(path);
}

/** Read only the chosen session workspace, following symlinks before the containment check. */
export async function sessionFile(session: Pick<Session, "cwd">, path: string) {
  if (!path || path.length > 4096 || path.includes("\0")) throw new ContentError("Choose a file in this session's project", 400);
  const root = await realpath(session.cwd);
  const file = await realpath(resolve(root, path));
  if (!contained(root, file)) throw new ContentError("File is outside this session's project", 403);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const mimeType = images[extname(file).toLowerCase()];
    if (!stat.isFile() || stat.size > (mimeType ? 2 * 1024 * 1024 : 1024 * 1024))
      throw new ContentError("File preview is limited to 1 MiB of text or 2 MiB of images", 413);
    // Bounded read also handles a file that grows after stat.
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await realpath(file) !== file)
      throw new ContentError("File changed while reading; refresh its preview");
    const value = bytes.subarray(0, bytesRead);
    if (!mimeType && value.includes(0)) throw new ContentError("This binary file has no preview", 415);
    return {
      path: relative(root, file), name: basename(file), size: stat.size,
      modifiedAt: stat.mtime.toISOString(), mimeType: mimeType ?? "text/plain",
      ...(mimeType ? { base64: value.toString("base64") } : { text: value.toString("utf8") }),
    };
  } finally { await handle.close(); }
}
