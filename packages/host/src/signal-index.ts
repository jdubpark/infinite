import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Event } from "./types.js";
import { MAX_EVENT_PAGE_BYTES, readEvents, seal, SEGMENT_SIZE, unseal, writeSealed } from "./vault.js";

export const SIGNAL_INDEX_FILE = "signals.sealed";
export const SIGNAL_INDEX_STATE_FILE = "signals-state.sealed";

const SIGNAL_ONLY = new Set(["signal"]);

export type EventPage = { events: Event[]; cursor: number; more: boolean };
export type EventPageReader = (
  after: number,
  limit: number,
  types?: Set<string>,
) => EventPage;

export interface SignalIndexRead {
  entries: Event[];
  lineBytes: number[];
  intact: boolean;
  exists: boolean;
}

export interface SignalIndexState {
  coveredSeq: number;
  count: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function isSignalOnlyTypes(types?: Set<string>): boolean {
  return Boolean(types && types.size === 1 && types.has("signal"));
}

export function journalTipSeq(eventsDir: string): number {
  if (!existsSync(eventsDir)) return 0;
  let names: string[];
  try {
    names = readdirSync(eventsDir);
  } catch {
    return 0;
  }
  const segments = new Set<number>();
  for (const name of names) {
    if (/^\d{10}\.journal$/.test(name)) segments.add(Number(name.slice(0, 10)));
  }
  let lastSegment = -1;
  while (segments.has(lastSegment + 1)) lastSegment++;
  if (lastSegment < 0) return 0;
  const lastFile = join(eventsDir, `${String(lastSegment).padStart(10, "0")}.journal`);
  let raw: string;
  try {
    raw = readFileSync(lastFile, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  lines.pop();
  return lastSegment * SEGMENT_SIZE + lines.length;
}

export function readSignalIndex(file: string, key: Buffer, sessionId: string): SignalIndexRead {
  if (!existsSync(file)) return { entries: [], lineBytes: [], intact: true, exists: false };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { entries: [], lineBytes: [], intact: false, exists: true };
  }
  if (!raw.length) return { entries: [], lineBytes: [], intact: true, exists: true };
  const hasTrailingNewline = raw.endsWith("\n");
  const end = raw.lastIndexOf("\n");
  if (end < 0) return { entries: [], lineBytes: [], intact: false, exists: true };
  const lines = raw.slice(0, end).split("\n");
  const entries: Event[] = [];
  const lineBytes: number[] = [];
  let lastSeq = 0;
  let intact = hasTrailingNewline;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      intact = false;
      break;
    }
    try {
      const parsed = unseal<unknown>(key, `${sessionId}:signal:${i}`, line);
      if (
        !isRecord(parsed) ||
        typeof parsed.seq !== "number" ||
        !Number.isSafeInteger(parsed.seq) ||
        parsed.seq <= lastSeq ||
        typeof parsed.at !== "string" ||
        parsed.type !== "signal" ||
        !isRecord(parsed.data)
      ) {
        intact = false;
        break;
      }
      entries.push({
        seq: parsed.seq,
        at: parsed.at,
        type: "signal",
        data: parsed.data,
      });
      lineBytes.push(line.length);
      lastSeq = parsed.seq;
    } catch {
      intact = false;
      break;
    }
  }
  return { entries, lineBytes, intact, exists: true };
}

export function readSignalIndexState(
  file: string,
  key: Buffer,
  sessionId: string,
): SignalIndexState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = unseal<unknown>(key, `${sessionId}:signal-index-state`, readFileSync(file, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      typeof parsed.coveredSeq !== "number" ||
      !Number.isSafeInteger(parsed.coveredSeq) ||
      parsed.coveredSeq < 0 ||
      typeof parsed.count !== "number" ||
      !Number.isSafeInteger(parsed.count) ||
      parsed.count < 0
    ) {
      return undefined;
    }
    return { coveredSeq: parsed.coveredSeq, count: parsed.count };
  } catch {
    return undefined;
  }
}

function verifiedCoverage(
  index: SignalIndexRead,
  state: SignalIndexState | undefined,
  tipSeq: number,
): number {
  const lastIndexedSeq = index.entries.at(-1)?.seq ?? 0;
  const safeStateCovered =
    index.intact &&
    state !== undefined &&
    index.entries.length === state.count &&
    state.coveredSeq >= lastIndexedSeq &&
    state.coveredSeq <= tipSeq
      ? state.coveredSeq
      : 0;
  return Math.max(lastIndexedSeq, safeStateCovered);
}

function firstEntryAfter(entries: readonly Event[], after: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].seq <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class SignalIndex {
  readonly file: string;
  readonly stateFile: string;
  private count = 0;
  private lastSignalSeq = 0;
  private lastObservedSeq = 0;
  private persistedCoveredSeq = 0;
  private bytesSinceCovered = 0;
  private disabled = false;

  constructor(
    readonly sessionDir: string,
    readonly key: Buffer,
    readonly sessionId: string,
    initialJournalSeq = 0,
  ) {
    this.file = join(sessionDir, SIGNAL_INDEX_FILE);
    this.stateFile = join(sessionDir, SIGNAL_INDEX_STATE_FILE);
    const existing = readSignalIndex(this.file, key, sessionId);
    const state = readSignalIndexState(this.stateFile, key, sessionId);
    this.count = existing.entries.length;
    this.lastSignalSeq = existing.entries.at(-1)?.seq ?? 0;
    if (!Number.isSafeInteger(initialJournalSeq) || initialJournalSeq < 0 || this.lastSignalSeq > initialJournalSeq) {
      this.disabled = true;
      return;
    }
    const safeState =
      existing.intact &&
      state !== undefined &&
      existing.entries.length === state.count &&
      state.coveredSeq >= this.lastSignalSeq &&
      state.coveredSeq <= initialJournalSeq
        ? state.coveredSeq
        : 0;
    const verified = Math.max(this.lastSignalSeq, safeState);
    this.lastObservedSeq = verified;
    this.persistedCoveredSeq = safeState;
    const freshEmpty = initialJournalSeq === 0 && !existing.exists && state === undefined;
    if (!freshEmpty && !(existing.intact && verified === initialJournalSeq)) {
      this.disabled = true;
    }
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  get coveredSeq(): number {
    return this.lastObservedSeq;
  }

  get persistedSeq(): number {
    return this.persistedCoveredSeq;
  }

  invalidate(): void {
    this.disabled = true;
  }

  observe(event: Event): boolean {
    if (this.disabled) return false;
    if (!Number.isSafeInteger(event.seq) || event.seq !== this.lastObservedSeq + 1) {
      this.disabled = true;
      return false;
    }
    if (event.type === "signal") {
      try {
        const creating = this.count === 0 && !existsSync(this.file);
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const payload: Event = {
          seq: event.seq,
          at: event.at,
          type: "signal",
          data: event.data,
        };
        const bytes = Buffer.from(
          seal(this.key, `${this.sessionId}:signal:${this.count}`, payload) + "\n",
        );
        const fd = openSync(this.file, "a", 0o600);
        try {
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (creating) {
          const dirFd = openSync(dirname(this.file), "r");
          try {
            fsyncSync(dirFd);
          } finally {
            closeSync(dirFd);
          }
        }
        this.count += 1;
        this.lastSignalSeq = event.seq;
        this.lastObservedSeq = event.seq;
        this.bytesSinceCovered = 0;
        return true;
      } catch {
        this.disabled = true;
        return false;
      }
    }
    this.lastObservedSeq = event.seq;
    if (event.type === "output" && typeof event.data.text === "string") {
      this.bytesSinceCovered += event.data.text.length;
    }
    if (
      this.lastObservedSeq - Math.max(this.persistedCoveredSeq, this.lastSignalSeq) >= SEGMENT_SIZE ||
      this.bytesSinceCovered >= MAX_EVENT_PAGE_BYTES / 2
    ) {
      this.checkpoint(this.lastObservedSeq);
    }
    return true;
  }

  checkpoint(seq = this.lastObservedSeq): boolean {
    if (this.disabled) return false;
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    if (seq > this.lastObservedSeq) {
      this.disabled = true;
      return false;
    }
    if (seq <= Math.max(this.persistedCoveredSeq, this.lastSignalSeq)) return true;
    try {
      writeSealed(this.stateFile, this.key, `${this.sessionId}:signal-index-state`, {
        v: 1,
        coveredSeq: seq,
        count: this.count,
      });
      this.persistedCoveredSeq = seq;
      this.bytesSinceCovered = 0;
      return true;
    } catch {
      return false;
    }
  }
}

export function readSignalEvents(
  sessionDir: string,
  key: Buffer,
  sessionId: string,
  after = 0,
  limit = 200,
  readTail?: EventPageReader,
): EventPage {
  const eventsDir = join(sessionDir, "events");
  const fallback: EventPageReader =
    readTail ?? ((from, count, types) => readEvents(eventsDir, key, sessionId, from, count, types));
  if (!Number.isSafeInteger(after) || after < 0) {
    return fallback(after, limit, SIGNAL_ONLY);
  }
  const tipSeq = journalTipSeq(eventsDir);
  if (tipSeq === 0 || after >= tipSeq) {
    return { events: [], cursor: after, more: false };
  }
  if (limit <= 0) {
    return { events: [], cursor: after, more: true };
  }
  const index = readSignalIndex(join(sessionDir, SIGNAL_INDEX_FILE), key, sessionId);
  const lastIndexedSeq = index.entries.at(-1)?.seq ?? 0;
  if (lastIndexedSeq > tipSeq) {
    return fallback(after, limit, SIGNAL_ONLY);
  }
  const state = readSignalIndexState(join(sessionDir, SIGNAL_INDEX_STATE_FILE), key, sessionId);
  const covered = verifiedCoverage(index, state, tipSeq);
  if (covered <= after) {
    return fallback(after, limit, SIGNAL_ONLY);
  }
  const events: Event[] = [];
  let totalBytes = 0;
  const start = firstEntryAfter(index.entries, after);
  for (let i = start; i < index.entries.length; i++) {
    const entry = index.entries[i];
    if (events.length >= limit || (events.length > 0 && totalBytes >= MAX_EVENT_PAGE_BYTES)) {
      return { events, cursor: events[events.length - 1].seq, more: true };
    }
    events.push(entry);
    totalBytes += index.lineBytes[i];
  }
  if (covered >= tipSeq) {
    return { events, cursor: tipSeq, more: false };
  }
  if (events.length >= limit || (events.length > 0 && totalBytes >= MAX_EVENT_PAGE_BYTES)) {
    return { events, cursor: covered, more: true };
  }
  const tail = fallback(covered, limit - events.length, SIGNAL_ONLY);
  return {
    events: events.length ? [...events, ...tail.events] : tail.events,
    cursor: tail.cursor,
    more: tail.more,
  };
}

export function readIndexedEvents(
  sessionDir: string,
  key: Buffer,
  sessionId: string,
  after = 0,
  limit = 200,
  types?: Set<string>,
  readTail?: EventPageReader,
): EventPage {
  if (isSignalOnlyTypes(types)) {
    return readSignalEvents(sessionDir, key, sessionId, after, limit, readTail);
  }
  if (readTail) return readTail(after, limit, types);
  return readEvents(join(sessionDir, "events"), key, sessionId, after, limit, types);
}
