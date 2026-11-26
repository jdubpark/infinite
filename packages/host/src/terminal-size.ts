import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { seal, unseal } from "./vault.js";
import type { Event, TerminalSize } from "./types.js";

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 32 };
export const TERMINAL_SIZE_INDEX_FILE = "terminal-sizes.sealed";

export interface TerminalSizeEntry {
  seq: number;
  cols: number;
  rows: number;
}

function validDimension(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidTerminalSize(cols: unknown, rows: unknown): boolean {
  return validDimension(cols, 1, 1000) && validDimension(rows, 1, 1000);
}

export function isPtyTerminalSize(cols: unknown, rows: unknown): boolean {
  return validDimension(cols, 20, 240) && validDimension(rows, 5, 100);
}

export function terminalSizeOf(value: unknown): TerminalSize | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { cols, rows } = value as Record<string, unknown>;
  return validDimension(cols, 1, 1000) && validDimension(rows, 1, 1000) ? { cols, rows } : undefined;
}

export function terminalSizeFromEvent(event: Event): TerminalSize | undefined {
  if (event.type !== "lifecycle" && event.type !== "output") return undefined;
  return terminalSizeOf(event.data) ?? terminalSizeOf(event.data.terminalSize);
}

export function readTerminalSizeIndex(file: string, key: Buffer, sessionId: string): TerminalSizeEntry[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const end = raw.lastIndexOf("\n");
  if (end < 0) return [];
  const lines = raw.slice(0, end).split("\n");
  const entries: TerminalSizeEntry[] = [];
  let lastSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    try {
      const parsed = unseal<unknown>(key, `${sessionId}:terminal-size:${i}`, line);
      const size = terminalSizeOf(parsed);
      const seq = (parsed as { seq?: unknown }).seq;
      if (!size || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= lastSeq) break;
      entries.push({ seq, cols: size.cols, rows: size.rows });
      lastSeq = seq;
    } catch {
      break;
    }
  }
  return entries;
}

export class TerminalBarrier {
  private queue: (() => void)[] | undefined;
  private bytes = 0;
  private abort: ((error: Error) => void) | undefined;

  dispatch(task: () => void, byteLength = 0): void {
    if (!this.queue) {
      task();
      return;
    }
    this.queue.push(task);
    this.bytes += byteLength;
    if (this.bytes > 2 * 1024 * 1024) this.abort?.(new Error("Snapshot output queue is full"));
  }

  async run<T>(flush: () => void, drain: (done: () => void) => void, fn: () => T): Promise<T> {
    this.queue = [];
    this.bytes = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      flush();
      await new Promise<void>((resolve, reject) => {
        this.abort = reject;
        deadline = setTimeout(() => reject(new Error("Terminal renderer is busy")), 1000);
        drain(resolve);
      });
      return fn();
    } finally {
      clearTimeout(deadline);
      this.abort = undefined;
      const queued = this.queue;
      this.queue = undefined;
      for (const task of queued) task();
    }
  }
}

export class TerminalSizeIndex {
  private count = 0;
  private last: TerminalSize | undefined;

  constructor(
    readonly file: string,
    readonly key: Buffer,
    readonly sessionId: string,
  ) {
    const existing = readTerminalSizeIndex(file, key, sessionId);
    this.count = existing.length;
    const tail = existing.at(-1);
    if (tail) this.last = { cols: tail.cols, rows: tail.rows };
  }

  append(seq: number, size: TerminalSize): void {
    if (!Number.isSafeInteger(seq) || seq <= 0 || !isValidTerminalSize(size.cols, size.rows)) return;
    if (this.last && this.last.cols === size.cols && this.last.rows === size.rows) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(
      seal(this.key, `${this.sessionId}:terminal-size:${this.count}`, { seq, cols: size.cols, rows: size.rows }) + "\n",
    );
    const fd = openSync(this.file, "a", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.count += 1;
    this.last = { cols: size.cols, rows: size.rows };
  }
}

type EventPageReader = (
  after: number,
  limit: number,
  types?: Set<string>,
) => { events: Event[]; cursor: number; more: boolean };

function findIndexedEntryAt(entries: readonly TerminalSizeEntry[], after: number): TerminalSizeEntry | undefined {
  let lo = 0;
  let hi = entries.length - 1;
  let found: TerminalSizeEntry | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].seq <= after) {
      found = entries[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function resolveReplayTerminalSize(
  readPage: EventPageReader,
  after: number,
  fallback?: TerminalSize,
  indexEntries: readonly TerminalSizeEntry[] = [],
): TerminalSize | undefined {
  const safeFallback = fallback ? terminalSizeOf(fallback) : undefined;
  if (after === 0) {
    const page = readPage(0, 200, new Set(["output", "lifecycle"]));
    for (const event of page.events) {
      const size = terminalSizeFromEvent(event);
      if (size) return size;
      if (event.type === "output") break;
    }
    return safeFallback;
  }
  const indexed = findIndexedEntryAt(indexEntries, after);
  let resolved: TerminalSize | undefined = indexed ? { cols: indexed.cols, rows: indexed.rows } : undefined;
  const lastIndexedSeq = indexEntries.length > 0 ? indexEntries[indexEntries.length - 1].seq : 0;
  if (indexEntries.length > 0 && after <= lastIndexedSeq && resolved) {
    return resolved;
  }
  let cursor = after > lastIndexedSeq ? lastIndexedSeq : 0;
  while (cursor < after) {
    const page = readPage(cursor, 200, new Set(["lifecycle"]));
    for (const event of page.events) {
      if (event.seq > after) return resolved ?? safeFallback;
      const size = terminalSizeFromEvent(event);
      if (size) resolved = size;
    }
    if (!page.more || page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return resolved ?? safeFallback;
}
