import { posix } from "node:path";
import { setImmediate as yieldMacrotask } from "node:timers/promises";

export type FileTouch = { path: string; reads: number; edits: number; lastAt: string };
export type SessionTouches = {
  sessionId: string;
  observable: boolean;
  complete: boolean;
  graphQueries: number;
  files: FileTouch[];
  truncated: boolean;
};
export type TouchSource = { sessionId: string; cwd: string; provider: string; projectId: string };
export type TouchPage = {
  events: { seq: number; at: string; type: string; data: Record<string, unknown> }[];
  cursor: number;
  more: boolean;
};

const OBSERVABLE_PROVIDERS = new Set(["claude", "codex"]);
const FILE_TOOLS: Record<string, { field: string; kind: "reads" | "edits" }> = {
  Read: { field: "file_path", kind: "reads" },
  Edit: { field: "file_path", kind: "edits" },
  Write: { field: "file_path", kind: "edits" },
  MultiEdit: { field: "file_path", kind: "edits" },
  NotebookEdit: { field: "notebook_path", kind: "edits" },
};
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell", "exec_command", "local_shell"]);
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;
const GRAPHIFY = /(^|[\s;&|(])graphify\s+(query|path|explain)\b/;
const RELATIVE_TOKEN = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+$/;
const ABSOLUTE_TOKEN = /^\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+$/;
const EXTENSION = /^.+\.[A-Za-z0-9]{1,8}$/;
const MAX_PATCH_DEPTH = 4;
/** The marker `truncateInput` appends to a string it cut; a cut path names no real file. */
const TRUNCATED = / … \[\+\d+ chars\]$/;

interface FileState { reads: number; edits: number; lastAt: string; seq: number }
interface SessionState {
  cursor: number;
  files: Map<string, FileState>;
  graphQueries: number;
  complete: boolean;
  truncated: boolean;
  lastUsed: number;
  inflight?: Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Turns a tool input path into a repository-relative POSIX path under `cwd`, or undefined.
 * Anything that could be an invented path (`..`, backslashes, `~`, NUL, edge whitespace,
 * trailing slash, the cwd itself) is dropped.
 */
function repoPath(raw: unknown, cwd: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) return undefined;
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("~") || raw.endsWith("/") || TRUNCATED.test(raw)) return undefined;
  if (raw.split("/").includes("..")) return undefined;
  if (!posix.isAbsolute(cwd)) return undefined;
  const root = posix.resolve(cwd);
  const rel = posix.isAbsolute(raw) ? posix.relative(root, posix.normalize(raw)) : posix.normalize(raw);
  if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) return undefined;
  if (rel.includes("\0")) return undefined;
  return rel;
}

/** Strings under `value` that carry a patch body. */
function patchTexts(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return value.includes("*** Begin Patch") ? [value] : [];
  if (depth >= MAX_PATCH_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((item) => patchTexts(item, depth + 1));
  if (isRecord(value)) return Object.values(value).flatMap((item) => patchTexts(item, depth + 1));
  return [];
}

function shellCommand(input: Record<string, unknown>): string | undefined {
  const { command, cmd } = input;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  return typeof cmd === "string" ? cmd : undefined;
}

/** Repository-relative paths one tool-start input points at. Conservative: a missed path is acceptable. */
export function extractTouches(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  inArea: (directory: string) => boolean,
): { reads: string[]; edits: string[]; graphQuery: boolean } {
  const reads = new Set<string>();
  const edits = new Set<string>();
  let graphQuery = false;
  const fileTool = FILE_TOOLS[tool];

  if (fileTool) {
    const path = repoPath(input[fileTool.field], cwd);
    if (path) (fileTool.kind === "reads" ? reads : edits).add(path);
  } else if (tool === "apply_patch") {
    for (const text of patchTexts(input)) {
      for (const line of text.split("\n")) {
        const match = PATCH_HEADER.exec(line.replace(/\r$/, ""));
        const path = match ? repoPath(match[1], cwd) : undefined;
        if (path) edits.add(path);
      }
    }
  } else if (SHELL_TOOLS.has(tool)) {
    const command = shellCommand(input);
    if (command !== undefined) {
      graphQuery = GRAPHIFY.test(command);
      for (const raw of command.split(/[\s;&|()]+/)) {
        const token = raw.replace(/^["']+|["']+$/g, "");
        if (!RELATIVE_TOKEN.test(token) && !ABSOLUTE_TOKEN.test(token)) continue;
        const path = repoPath(token, cwd);
        if (!path || !EXTENSION.test(posix.basename(path))) continue;
        if (!inArea(posix.dirname(path))) continue;
        reads.add(path);
      }
    }
  }
  return { reads: [...reads], edits: [...edits], graphQuery };
}

/** Incremental, bounded, in-memory index of the files each session's tools pointed at. */
export class ContextTouches {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxReads: number;
  private readonly maxSessions: number;
  private readonly maxFiles: number;
  private clock = 0;

  constructor(
    private readonly options: {
      read(sessionId: string, after: number): TouchPage | Promise<TouchPage>;
      areas(projectId: string): ReadonlySet<string> | undefined;
      maxReads?: number;
      maxSessions?: number;
      maxFiles?: number;
    },
  ) {
    this.maxReads = options.maxReads ?? 8;
    this.maxSessions = options.maxSessions ?? 256;
    this.maxFiles = options.maxFiles ?? 300;
  }

  async session(source: TouchSource): Promise<SessionTouches> {
    if (!OBSERVABLE_PROVIDERS.has(source.provider)) {
      return { sessionId: source.sessionId, observable: false, complete: true, graphQueries: 0, files: [], truncated: false };
    }
    const state = this.stateFor(source.sessionId);
    state.lastUsed = ++this.clock;
    state.inflight ??= this.advance(state, source).finally(() => { state.inflight = undefined; });
    await state.inflight;
    return this.snapshot(source.sessionId, state);
  }

  private stateFor(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = {
      cursor: 0, files: new Map(), graphQueries: 0, complete: false, truncated: false, lastUsed: 0,
    };
    this.sessions.set(sessionId, created);
    if (this.sessions.size > this.maxSessions) this.evictLeastRecent(sessionId);
    return created;
  }

  private evictLeastRecent(keep: string): void {
    let victim: [string, SessionState] | undefined;
    for (const entry of this.sessions) {
      if (entry[0] === keep || entry[1].inflight) continue;
      if (!victim || entry[1].lastUsed < victim[1].lastUsed) victim = entry;
    }
    if (victim) this.sessions.delete(victim[0]);
  }

  private async advance(state: SessionState, source: TouchSource): Promise<void> {
    const inArea = this.areaTest(source.projectId);
    state.complete = false;
    for (let i = 0; i < this.maxReads; i++) {
      if (i > 0) await yieldMacrotask();
      const page = await this.options.read(source.sessionId, state.cursor);
      this.apply(state, page, source, inArea);
      if (!page.more) {
        state.complete = true;
        return;
      }
    }
  }

  private apply(state: SessionState, page: TouchPage, source: TouchSource, inArea: (directory: string) => boolean): void {
    const from = state.cursor;
    for (const event of page.events) {
      if (event.seq <= from || event.type !== "signal" || event.data.kind !== "tool-start") continue;
      const { tool, input } = event.data;
      if (typeof tool !== "string") continue;
      const found = extractTouches(tool, isRecord(input) ? input : {}, source.cwd, inArea);
      if (found.graphQuery) state.graphQueries++;
      for (const path of found.reads) this.touch(state, path, "reads", event);
      for (const path of found.edits) this.touch(state, path, "edits", event);
    }
    state.cursor = Math.max(state.cursor, page.cursor);
    this.trim(state);
  }

  private touch(state: SessionState, path: string, kind: "reads" | "edits", event: TouchPage["events"][number]): void {
    const file = state.files.get(path) ?? { reads: 0, edits: 0, lastAt: event.at, seq: event.seq };
    file[kind]++;
    file.lastAt = event.at;
    file.seq = event.seq;
    state.files.set(path, file);
  }

  private trim(state: SessionState): void {
    if (state.files.size <= this.maxFiles) return;
    const newest = [...state.files.entries()].sort((a, b) => b[1].seq - a[1].seq).slice(0, this.maxFiles);
    state.files = new Map(newest);
    state.truncated = true;
  }

  private areaTest(projectId: string): (directory: string) => boolean {
    const areas = this.options.areas(projectId);
    if (!areas) return () => false;
    return (directory) => {
      for (let current = directory; ; current = posix.dirname(current)) {
        if (areas.has(current)) return true;
        if (current === ".") return false;
      }
    };
  }

  private snapshot(sessionId: string, state: SessionState): SessionTouches {
    const files = [...state.files.entries()]
      .sort((a, b) => b[1].seq - a[1].seq)
      .map(([path, file]) => ({ path, reads: file.reads, edits: file.edits, lastAt: file.lastAt }));
    return {
      sessionId,
      observable: true,
      complete: state.complete,
      graphQueries: state.graphQueries,
      files,
      truncated: state.truncated,
    };
  }
}
