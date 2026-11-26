import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { IPty } from "node-pty";
import { seal, unseal } from "./vault.js";
import type { Event, TerminalSize } from "./types.js";

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 32 };
export const TERMINAL_SIZE_INDEX_FILE = "terminal-sizes.sealed";

export interface TerminalSizeEntry {
  seq: number;
  cols: number;
  rows: number;
}

export interface TerminalSizeIndexRead {
  entries: TerminalSizeEntry[];
  intact: boolean;
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

export function readTerminalSizeIndex(file: string, key: Buffer, sessionId: string): TerminalSizeIndexRead {
  if (!existsSync(file)) return { entries: [], intact: false };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { entries: [], intact: false };
  }
  if (!raw.length) return { entries: [], intact: false };
  const hasTrailingNewline = raw.endsWith("\n");
  const end = raw.lastIndexOf("\n");
  if (end < 0) return { entries: [], intact: false };
  const lines = raw.slice(0, end).split("\n");
  const entries: TerminalSizeEntry[] = [];
  let lastSeq = 0;
  let intact = hasTrailingNewline;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      intact = false;
      break;
    }
    try {
      const parsed = unseal<unknown>(key, `${sessionId}:terminal-size:${i}`, line);
      const size = terminalSizeOf(parsed);
      const seq = (parsed as { seq?: unknown }).seq;
      if (!size || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= lastSeq) {
        intact = false;
        break;
      }
      entries.push({ seq, cols: size.cols, rows: size.rows });
      lastSeq = seq;
    } catch {
      intact = false;
      break;
    }
  }
  return { entries, intact: intact && entries.length > 0 };
}

export function holdTerminalOpen(pty: IPty): void {
  const path: unknown = Reflect.get(pty, "ptsName");
  if (typeof path !== "string") return;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
  } catch {
    return;
  }
  pty.onExit(() => {
    try {
      closeSync(fd);
    } catch {
    }
  });
}

export class TerminalBarrier {
  private queue: ((queued: boolean) => void)[] | undefined;
  private bytes = 0;
  private abort: ((error: Error) => void) | undefined;

  dispatch(task: (queued: boolean) => void, byteLength = 0): void {
    if (!this.queue) {
      task(false);
      return;
    }
    this.queue.push(task);
    this.bytes += byteLength;
    if (this.bytes > 2 * 1024 * 1024) this.abort?.(new Error("Snapshot output queue is full"));
  }

  async run<T>(
    flush: () => void,
    drain: (done: () => void) => void,
    fn: () => T,
    beforeDrain?: () => void,
  ): Promise<T> {
    this.queue = [];
    this.bytes = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      flush();
      beforeDrain?.();
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
      try {
        for (const task of queued) task(true);
      } finally {
        this.queue = undefined;
      }
    }
  }
}

export class TerminalSizeIndex {
  private count = 0;
  private last: TerminalSize | undefined;
  private disabled = false;
  private frozenCoveredSeq = 0;

  constructor(
    readonly file: string,
    readonly key: Buffer,
    readonly sessionId: string,
  ) {
    const existing = readTerminalSizeIndex(file, key, sessionId);
    this.count = existing.entries.length;
    const tail = existing.entries.at(-1);
    if (tail) {
      this.last = { cols: tail.cols, rows: tail.rows };
      this.frozenCoveredSeq = tail.seq;
    }
    if (existing.entries.length > 0 && !existing.intact) this.disabled = true;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  coveredSeq(journalSeq: number): number | undefined {
    if (this.disabled) return this.frozenCoveredSeq > 0 ? this.frozenCoveredSeq : undefined;
    if (this.count === 0) return undefined;
    return journalSeq;
  }

  invalidate(beforeSeq: number): void {
    if (this.disabled) return;
    this.disabled = true;
    this.frozenCoveredSeq = Math.max(0, Math.min(this.frozenCoveredSeq || beforeSeq, beforeSeq));
  }

  append(seq: number, size: TerminalSize): boolean {
    if (this.disabled || !Number.isSafeInteger(seq) || seq <= 0 || !isValidTerminalSize(size.cols, size.rows)) {
      return false;
    }
    if (this.last && this.last.cols === size.cols && this.last.rows === size.rows) {
      this.frozenCoveredSeq = Math.max(this.frozenCoveredSeq, seq);
      return true;
    }
    try {
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
      this.frozenCoveredSeq = seq;
      return true;
    } catch {
      this.disabled = true;
      this.frozenCoveredSeq = this.count > 0 ? Math.max(0, seq - 1) : 0;
      return false;
    }
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

export interface ResolveReplaySizeOptions {
  fallback?: TerminalSize;
  index?: TerminalSizeIndexRead;
  coveredSeq?: number;
  signal?: AbortSignal;
}

export async function resolveReplayTerminalSize(
  readPage: EventPageReader,
  after: number,
  options: ResolveReplaySizeOptions = {},
): Promise<TerminalSize | undefined> {
  const safeFallback = options.fallback ? terminalSizeOf(options.fallback) : undefined;
  if (after === 0) {
    const page = readPage(0, 200, new Set(["output", "lifecycle"]));
    for (const event of page.events) {
      const size = terminalSizeFromEvent(event);
      if (size) return size;
      if (event.type === "output") break;
    }
    return safeFallback;
  }
  const index = options.index ?? { entries: [], intact: false };
  const entries = index.entries;
  const indexed = findIndexedEntryAt(entries, after);
  let resolved: TerminalSize | undefined = indexed ? { cols: indexed.cols, rows: indexed.rows } : undefined;
  const lastIndexedSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0;
  const safeCovered =
    index.intact &&
    typeof options.coveredSeq === "number" &&
    Number.isSafeInteger(options.coveredSeq) &&
    options.coveredSeq >= lastIndexedSeq
      ? options.coveredSeq
      : 0;
  const verifiedSeq = Math.max(lastIndexedSeq, safeCovered);
  if (entries.length > 0 && after <= verifiedSeq && resolved) {
    return resolved;
  }
  let cursor = after > verifiedSeq ? verifiedSeq : 0;
  let pages = 0;
  while (cursor < after) {
    if (options.signal?.aborted) break;
    if (pages > 0) await new Promise<void>(resolve => setImmediate(resolve));
    if (options.signal?.aborted) break;
    const page = readPage(cursor, 200, new Set(["lifecycle"]));
    pages++;
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
