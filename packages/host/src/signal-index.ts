import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Event } from "./types.js";
import {
  MAX_EVENT_PAGE_BYTES,
  readEvents,
  seal,
  SEGMENT_SIZE,
  unseal,
  writeSealed,
  type JournalAppendMeta,
} from "./vault.js";

export const SIGNAL_INDEX_DIR = "signals";
export const SIGNAL_INDEX_STATE_FILE = "signals-state.sealed";
export const SIGNAL_SEGMENT_SIZE = 64;

const SIGNAL_ONLY = new Set(["signal"]);
const SEGMENT_FILE_RE = /^(\d{10})-(\d{12})\.sealed$/;
const TIP_CACHE_LIMIT = 512;

export type EventPage = { events: Event[]; cursor: number; more: boolean };
export type EventPageReader = (
  after: number,
  limit: number,
  types?: Set<string>,
) => EventPage;

export interface SignalSegmentDescriptor {
  index: number;
  startSeq: number;
  name: string;
  path: string;
}

export interface SignalSegmentRead {
  entries: Event[];
  lineBytes: number[];
  intact: boolean;
}

export interface SignalIndexRead {
  entries: Event[];
  lineBytes: number[];
  intact: boolean;
  exists: boolean;
  segments: SignalSegmentDescriptor[];
}

export interface SignalIndexState {
  coveredSeq: number;
  count: number;
  segmentCount: number;
  lastSegment?: string;
  lastSegmentLines: number;
  lastSignalSeq: number;
  tipSegment?: string;
  tipBytes?: number;
}

export type JournalTipProbe =
  | { kind: "empty" }
  | { kind: "ok"; seq: number; segment: string; bytes: number }
  | { kind: "error" };

export interface JournalTipHint {
  coveredSeq: number;
  tipSegment: string;
  tipBytes: number;
}

interface TipCacheEntry {
  key: string;
  seq: number;
}

const tipCache = new Map<string, TipCacheEntry>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const formatSegmentName = (index: number, startSeq: number) =>
  `${String(index).padStart(10, "0")}-${String(startSeq).padStart(12, "0")}.sealed`;

const signalAad = (sessionId: string, index: number, startSeq: number, lineIndex: number) =>
  `${sessionId}:signal:${index}:${startSeq}:${lineIndex}`;

function fsyncDirectory(directory: string): void {
  const dirFd = openSync(directory, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function isSignalOnlyTypes(types?: Set<string>): boolean {
  return Boolean(types && types.size === 1 && types.has("signal"));
}

function parseSignalEvent(value: unknown, minExclusiveSeq: number): Event | undefined {
  if (
    !isRecord(value) ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq <= minExclusiveSeq ||
    typeof value.at !== "string" ||
    value.type !== "signal" ||
    !isRecord(value.data)
  ) {
    return undefined;
  }
  return { seq: value.seq, at: value.at, type: "signal", data: value.data };
}

function listSignalSegments(
  signalsDir: string,
): { kind: "empty" } | { kind: "ok"; segments: SignalSegmentDescriptor[] } | { kind: "corrupt" } {
  let names: string[];
  try {
    names = readdirSync(signalsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "empty" };
    return { kind: "corrupt" };
  }
  if (!names.length) return { kind: "empty" };
  const parsed: SignalSegmentDescriptor[] = [];
  for (const name of names) {
    const match = SEGMENT_FILE_RE.exec(name);
    if (!match) return { kind: "corrupt" };
    const index = Number(match[1]);
    const startSeq = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(startSeq) || startSeq < 1) {
      return { kind: "corrupt" };
    }
    parsed.push({ index, startSeq, name, path: join(signalsDir, name) });
  }
  parsed.sort((a, b) => a.index - b.index);
  let prevStart = 0;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].index !== i || parsed[i].startSeq <= prevStart) return { kind: "corrupt" };
    prevStart = parsed[i].startSeq;
  }
  return { kind: "ok", segments: parsed };
}

function readSegmentRaw(
  path: string,
): { ok: false } | { ok: true; lines: string[]; hasTrailingNewline: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false };
  }
  if (!raw.length) return { ok: true, lines: [], hasTrailingNewline: true };
  const hasTrailingNewline = raw.endsWith("\n");
  const end = raw.lastIndexOf("\n");
  if (end < 0) return { ok: true, lines: [], hasTrailingNewline: false };
  return { ok: true, lines: raw.slice(0, end).split("\n"), hasTrailingNewline };
}

function unsealSegmentLine(
  key: Buffer,
  sessionId: string,
  segment: SignalSegmentDescriptor,
  lineIndex: number,
  line: string,
  minExclusiveSeq: number,
): Event | undefined {
  if (!line) return undefined;
  try {
    const parsed = unseal<unknown>(key, signalAad(sessionId, segment.index, segment.startSeq, lineIndex), line);
    const event = parseSignalEvent(parsed, minExclusiveSeq);
    if (!event) return undefined;
    if (lineIndex === 0 && event.seq !== segment.startSeq) return undefined;
    return event;
  } catch {
    return undefined;
  }
}

function readSignalSegment(
  segment: SignalSegmentDescriptor,
  key: Buffer,
  sessionId: string,
  requireFull: boolean,
): SignalSegmentRead {
  const raw = readSegmentRaw(segment.path);
  if (!raw.ok) return { entries: [], lineBytes: [], intact: false };
  const { lines, hasTrailingNewline } = raw;
  if (!lines.length) {
    return { entries: [], lineBytes: [], intact: false };
  }
  if (lines.length > SIGNAL_SEGMENT_SIZE) {
    return { entries: [], lineBytes: [], intact: false };
  }
  let intact = hasTrailingNewline && (!requireFull || lines.length === SIGNAL_SEGMENT_SIZE);
  const entries: Event[] = [];
  const lineBytes: number[] = [];
  let lastSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    const event = unsealSegmentLine(key, sessionId, segment, i, lines[i], lastSeq);
    if (!event) {
      intact = false;
      break;
    }
    entries.push(event);
    lineBytes.push(lines[i].length);
    lastSeq = event.seq;
  }
  return { entries, lineBytes, intact };
}

export function readSignalIndex(signalsDir: string, key: Buffer, sessionId: string): SignalIndexRead {
  const listed = listSignalSegments(signalsDir);
  if (listed.kind === "empty") {
    return { entries: [], lineBytes: [], intact: true, exists: existsSync(signalsDir), segments: [] };
  }
  if (listed.kind === "corrupt") {
    return { entries: [], lineBytes: [], intact: false, exists: true, segments: [] };
  }
  const entries: Event[] = [];
  const lineBytes: number[] = [];
  let intact = true;
  let lastSeq = 0;
  for (let s = 0; s < listed.segments.length; s++) {
    const segment = listed.segments[s];
    const isFinal = s === listed.segments.length - 1;
    const read = readSignalSegment(segment, key, sessionId, !isFinal);
    if (!read.intact) intact = false;
    for (let i = 0; i < read.entries.length; i++) {
      if (read.entries[i].seq <= lastSeq) {
        return { entries, lineBytes, intact: false, exists: true, segments: listed.segments };
      }
      entries.push(read.entries[i]);
      lineBytes.push(read.lineBytes[i]);
      lastSeq = read.entries[i].seq;
    }
    if (!read.intact) break;
  }
  return { entries, lineBytes, intact, exists: true, segments: listed.segments };
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
      parsed.count < 0 ||
      typeof parsed.segmentCount !== "number" ||
      !Number.isSafeInteger(parsed.segmentCount) ||
      parsed.segmentCount < 0 ||
      typeof parsed.lastSegmentLines !== "number" ||
      !Number.isSafeInteger(parsed.lastSegmentLines) ||
      parsed.lastSegmentLines < 0 ||
      parsed.lastSegmentLines > SIGNAL_SEGMENT_SIZE ||
      typeof parsed.lastSignalSeq !== "number" ||
      !Number.isSafeInteger(parsed.lastSignalSeq) ||
      parsed.lastSignalSeq < 0 ||
      (parsed.lastSegment !== undefined &&
        (typeof parsed.lastSegment !== "string" || !SEGMENT_FILE_RE.test(parsed.lastSegment))) ||
      (parsed.tipSegment !== undefined &&
        (typeof parsed.tipSegment !== "string" || !/^\d{10}\.journal$/.test(parsed.tipSegment))) ||
      (parsed.tipBytes !== undefined &&
        (typeof parsed.tipBytes !== "number" || !Number.isSafeInteger(parsed.tipBytes) || parsed.tipBytes < 0))
    ) {
      return undefined;
    }
    return {
      coveredSeq: parsed.coveredSeq,
      count: parsed.count,
      segmentCount: parsed.segmentCount,
      ...(parsed.lastSegment !== undefined ? { lastSegment: parsed.lastSegment } : {}),
      lastSegmentLines: parsed.lastSegmentLines,
      lastSignalSeq: parsed.lastSignalSeq,
      ...(parsed.tipSegment !== undefined && parsed.tipBytes !== undefined
        ? { tipSegment: parsed.tipSegment, tipBytes: parsed.tipBytes }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function cacheTip(path: string, key: string, seq: number): void {
  if (tipCache.size >= TIP_CACHE_LIMIT && !tipCache.has(path)) {
    const oldest = tipCache.keys().next().value;
    if (oldest !== undefined) tipCache.delete(oldest);
  }
  tipCache.set(path, { key, seq });
}

export function probeJournalTip(eventsDir: string, hint?: JournalTipHint): JournalTipProbe {
  let names: string[];
  try {
    names = readdirSync(eventsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "empty" };
    return { kind: "error" };
  }
  const segments = new Set<number>();
  for (const name of names) {
    if (/^\d{10}\.journal$/.test(name)) segments.add(Number(name.slice(0, 10)));
  }
  let lastSegment = -1;
  while (segments.has(lastSegment + 1)) lastSegment++;
  if (lastSegment < 0) return { kind: "empty" };
  const segment = `${String(lastSegment).padStart(10, "0")}.journal`;
  const lastFile = join(eventsDir, segment);
  let info;
  try {
    info = statSync(lastFile);
  } catch {
    return { kind: "error" };
  }
  if (!info.isFile()) return { kind: "error" };
  if (hint && hint.tipSegment === segment && hint.tipBytes === info.size) {
    return { kind: "ok", seq: hint.coveredSeq, segment, bytes: info.size };
  }
  const cacheKey = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const cached = tipCache.get(lastFile);
  if (cached && cached.key === cacheKey) {
    return { kind: "ok", seq: cached.seq, segment, bytes: info.size };
  }
  let raw: string;
  try {
    raw = readFileSync(lastFile, "utf8");
  } catch {
    return { kind: "error" };
  }
  const lines = raw.split("\n");
  lines.pop();
  const seq = lastSegment * SEGMENT_SIZE + lines.length;
  cacheTip(lastFile, cacheKey, seq);
  return { kind: "ok", seq, segment, bytes: info.size };
}

export function journalTipSeq(eventsDir: string): number {
  const probe = probeJournalTip(eventsDir);
  return probe.kind === "ok" ? probe.seq : 0;
}

function probeExactTipForSeq(eventsDir: string, seq: number): JournalAppendMeta | undefined {
  if (seq <= 0) return undefined;
  const segIndex = Math.floor((seq - 1) / SEGMENT_SIZE);
  const segment = `${String(segIndex).padStart(10, "0")}.journal`;
  const nextSegment = `${String(segIndex + 1).padStart(10, "0")}.journal`;
  if (existsSync(join(eventsDir, nextSegment))) return undefined;
  const file = join(eventsDir, segment);
  let info;
  let raw: string;
  try {
    info = statSync(file);
    if (!info.isFile()) return undefined;
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  lines.pop();
  const expectedLines = ((seq - 1) % SEGMENT_SIZE) + 1;
  if (lines.length !== expectedLines) return undefined;
  return { segment, bytes: info.size };
}

function purgeSignalSidecars(sessionDir: string, signalsDir: string, stateFile: string): void {
  const prefix = `${join(sessionDir, "events")}/`;
  for (const key of tipCache.keys()) {
    if (key.startsWith(prefix)) tipCache.delete(key);
  }
  try {
    if (existsSync(stateFile)) rmSync(stateFile, { force: true });
    if (existsSync(signalsDir) && lstatSync(signalsDir).isDirectory()) {
      rmSync(signalsDir, { recursive: true, force: true });
    }
    if (existsSync(sessionDir)) fsyncDirectory(sessionDir);
  } catch {}
}

function findStartSegment(segments: readonly SignalSegmentDescriptor[], after: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let candidate = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].startSeq <= after) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate;
}

function stateMatchesSegments(
  state: SignalIndexState,
  segments: readonly SignalSegmentDescriptor[],
  lastLines: number,
  lastSeq: number,
  tipSeq: number,
): boolean {
  const lastSeg = segments.at(-1);
  if (!lastSeg) {
    return (
      state.count === 0 &&
      state.segmentCount === 0 &&
      state.lastSegment === undefined &&
      state.lastSegmentLines === 0 &&
      state.lastSignalSeq === 0 &&
      state.coveredSeq <= tipSeq
    );
  }
  const expectedCount = (segments.length - 1) * SIGNAL_SEGMENT_SIZE + lastLines;
  return (
    state.segmentCount === segments.length &&
    state.lastSegment === lastSeg.name &&
    state.lastSegmentLines === lastLines &&
    state.count === expectedCount &&
    state.lastSignalSeq === lastSeq &&
    state.coveredSeq >= lastSeq &&
    state.coveredSeq <= tipSeq
  );
}

export class SignalIndex {
  readonly signalsDir: string;
  readonly stateFile: string;
  private count = 0;
  private segmentCount = 0;
  private currentSegmentIndex = -1;
  private currentSegmentStartSeq = 0;
  private currentSegmentLines = 0;
  private currentSegmentName: string | undefined;
  private lastSignalSeq = 0;
  private lastObservedSeq = 0;
  private persistedCoveredSeq = 0;
  private bytesSinceCovered = 0;
  private lastTipSegment: string | undefined;
  private lastTipBytes: number | undefined;
  private disabled = false;

  constructor(
    readonly sessionDir: string,
    readonly key: Buffer,
    readonly sessionId: string,
    initialJournalSeq = 0,
  ) {
    this.signalsDir = join(sessionDir, SIGNAL_INDEX_DIR);
    this.stateFile = join(sessionDir, SIGNAL_INDEX_STATE_FILE);
    if (!Number.isSafeInteger(initialJournalSeq) || initialJournalSeq < 0) {
      this.disabled = true;
      return;
    }
    const state = readSignalIndexState(this.stateFile, key, sessionId);
    const listed = listSignalSegments(this.signalsDir);
    if (listed.kind === "corrupt") {
      if (state !== undefined && state.coveredSeq > initialJournalSeq) {
        purgeSignalSidecars(sessionDir, this.signalsDir, this.stateFile);
      }
      this.disabled = true;
      return;
    }
    if (listed.kind === "empty") {
      if (state !== undefined && state.coveredSeq > initialJournalSeq) {
        purgeSignalSidecars(sessionDir, this.signalsDir, this.stateFile);
        this.disabled = true;
        return;
      }
      const safeState =
        state !== undefined && stateMatchesSegments(state, [], 0, 0, initialJournalSeq)
          ? state.coveredSeq
          : 0;
      this.lastObservedSeq = safeState;
      this.persistedCoveredSeq = safeState;
      const freshEmpty =
        initialJournalSeq === 0 && !existsSync(this.signalsDir) && !existsSync(this.stateFile);
      if (!freshEmpty && safeState !== initialJournalSeq) {
        this.disabled = true;
      }
      return;
    }
    const lastSeg = listed.segments.at(-1)!;
    const lastRead =
      lastSeg.startSeq > initialJournalSeq
        ? { entries: [] as Event[], lineBytes: [] as number[], intact: false }
        : readSignalSegment(lastSeg, key, sessionId, false);
    const lastSeq = lastRead.entries.at(-1)?.seq ?? 0;
    const ahead =
      lastSeg.startSeq > initialJournalSeq ||
      lastSeq > initialJournalSeq ||
      (state !== undefined && state.coveredSeq > initialJournalSeq);
    if (ahead) {
      purgeSignalSidecars(sessionDir, this.signalsDir, this.stateFile);
      this.disabled = true;
      return;
    }
    this.segmentCount = listed.segments.length;
    this.currentSegmentIndex = lastSeg.index;
    this.currentSegmentStartSeq = lastSeg.startSeq;
    this.currentSegmentLines = lastRead.entries.length;
    this.currentSegmentName = lastSeg.name;
    this.count = (listed.segments.length - 1) * SIGNAL_SEGMENT_SIZE + lastRead.entries.length;
    this.lastSignalSeq = lastSeq;
    const safeState =
      lastRead.intact &&
      state !== undefined &&
      stateMatchesSegments(state, listed.segments, lastRead.entries.length, lastSeq, initialJournalSeq)
        ? state.coveredSeq
        : 0;
    const verified = Math.max(lastSeq, safeState);
    this.lastObservedSeq = verified;
    this.persistedCoveredSeq = safeState;
    if (!(lastRead.intact && verified === initialJournalSeq)) {
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

  observe(event: Event, meta?: JournalAppendMeta): boolean {
    if (this.disabled) return false;
    if (!Number.isSafeInteger(event.seq) || event.seq !== this.lastObservedSeq + 1) {
      this.disabled = true;
      return false;
    }
    this.lastTipSegment = meta?.segment;
    this.lastTipBytes = meta?.bytes;
    if (event.type === "signal") {
      try {
        const creatingSegment = this.segmentCount === 0 || this.currentSegmentLines >= SIGNAL_SEGMENT_SIZE;
        const segIndex = creatingSegment ? this.segmentCount : this.currentSegmentIndex;
        const startSeq = creatingSegment ? event.seq : this.currentSegmentStartSeq;
        const lineIndex = creatingSegment ? 0 : this.currentSegmentLines;
        const segName = creatingSegment ? formatSegmentName(segIndex, startSeq) : this.currentSegmentName!;
        const target = join(this.signalsDir, segName);
        mkdirSync(this.signalsDir, { recursive: true, mode: 0o700 });
        const payload: Event = {
          seq: event.seq,
          at: event.at,
          type: "signal",
          data: event.data,
        };
        const bytes = Buffer.from(
          seal(this.key, signalAad(this.sessionId, segIndex, startSeq, lineIndex), payload) + "\n",
        );
        const fd = openSync(target, "a", 0o600);
        try {
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (creatingSegment) {
          fsyncDirectory(this.signalsDir);
          if (segIndex === 0) fsyncDirectory(dirname(this.signalsDir));
          this.segmentCount += 1;
          this.currentSegmentIndex = segIndex;
          this.currentSegmentStartSeq = startSeq;
          this.currentSegmentName = segName;
          this.currentSegmentLines = 1;
        } else {
          this.currentSegmentLines += 1;
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
    if (seq <= this.persistedCoveredSeq) return true;
    const tip =
      seq === this.lastObservedSeq
        ? this.lastTipSegment !== undefined && this.lastTipBytes !== undefined
          ? { segment: this.lastTipSegment, bytes: this.lastTipBytes }
          : probeExactTipForSeq(join(this.sessionDir, "events"), seq)
        : undefined;
    try {
      writeSealed(this.stateFile, this.key, `${this.sessionId}:signal-index-state`, {
        v: 1,
        coveredSeq: seq,
        count: this.count,
        segmentCount: this.segmentCount,
        ...(this.currentSegmentName !== undefined ? { lastSegment: this.currentSegmentName } : {}),
        lastSegmentLines: this.currentSegmentLines,
        lastSignalSeq: this.lastSignalSeq,
        ...(tip !== undefined ? { tipSegment: tip.segment, tipBytes: tip.bytes } : {}),
      });
      this.persistedCoveredSeq = seq;
      this.bytesSinceCovered = 0;
      return true;
    } catch {
      return false;
    }
  }
}

function inspectFinalSegment(
  segments: readonly SignalSegmentDescriptor[],
  state: SignalIndexState | undefined,
  key: Buffer,
  sessionId: string,
  tipSeq: number,
): {
  validSegments: readonly SignalSegmentDescriptor[];
  lastSignalSeq: number;
  covered: number;
  cachedFinal?: SignalSegmentRead;
} | undefined {
  const lastSeg = segments[segments.length - 1];
  if (lastSeg.startSeq > tipSeq) return undefined;
  const raw = readSegmentRaw(lastSeg.path);
  if (
    raw.ok &&
    raw.hasTrailingNewline &&
    raw.lines.length > 0 &&
    raw.lines.length <= SIGNAL_SEGMENT_SIZE &&
    state !== undefined &&
    stateMatchesSegments(state, segments, raw.lines.length, state.lastSignalSeq, tipSeq)
  ) {
    const tailEvent = unsealSegmentLine(
      key,
      sessionId,
      lastSeg,
      raw.lines.length - 1,
      raw.lines[raw.lines.length - 1],
      raw.lines.length === 1 ? 0 : lastSeg.startSeq,
    );
    if (tailEvent && tailEvent.seq === state.lastSignalSeq) {
      return {
        validSegments: segments,
        lastSignalSeq: tailEvent.seq,
        covered: Math.max(tailEvent.seq, state.coveredSeq),
      };
    }
  }
  const full = readSignalSegment(lastSeg, key, sessionId, false);
  const lastEntry = full.entries.at(-1);
  if (lastEntry) {
    if (lastEntry.seq > tipSeq) return undefined;
    const safeState =
      full.intact &&
      state !== undefined &&
      stateMatchesSegments(state, segments, full.entries.length, lastEntry.seq, tipSeq)
        ? state.coveredSeq
        : 0;
    return {
      validSegments: segments,
      lastSignalSeq: lastEntry.seq,
      covered: Math.max(lastEntry.seq, safeState),
      cachedFinal: full,
    };
  }
  if (segments.length < 2) return undefined;
  const prevSeg = segments[segments.length - 2];
  const prevRaw = readSegmentRaw(prevSeg.path);
  if (!prevRaw.ok || !prevRaw.hasTrailingNewline || prevRaw.lines.length !== SIGNAL_SEGMENT_SIZE) {
    return undefined;
  }
  const prevTail = unsealSegmentLine(
    key,
    sessionId,
    prevSeg,
    SIGNAL_SEGMENT_SIZE - 1,
    prevRaw.lines[SIGNAL_SEGMENT_SIZE - 1],
    prevSeg.startSeq,
  );
  if (!prevTail || prevTail.seq > tipSeq) return undefined;
  return {
    validSegments: segments.slice(0, -1),
    lastSignalSeq: prevTail.seq,
    covered: prevTail.seq,
  };
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
  const state = readSignalIndexState(join(sessionDir, SIGNAL_INDEX_STATE_FILE), key, sessionId);
  const listed = listSignalSegments(join(sessionDir, SIGNAL_INDEX_DIR));
  if (listed.kind === "corrupt" || (listed.kind === "empty" && state === undefined)) {
    return fallback(after, limit, SIGNAL_ONLY);
  }
  const tipHint =
    state !== undefined && state.tipSegment !== undefined && state.tipBytes !== undefined
      ? { coveredSeq: state.coveredSeq, tipSegment: state.tipSegment, tipBytes: state.tipBytes }
      : undefined;
  const tip = probeJournalTip(eventsDir, tipHint);
  if (tip.kind === "empty") return { events: [], cursor: after, more: false };
  if (tip.kind === "error") return fallback(after, limit, SIGNAL_ONLY);
  const tipSeq = tip.seq;
  if (after >= tipSeq) return { events: [], cursor: after, more: false };
  if (limit <= 0) return { events: [], cursor: after, more: true };

  if (listed.kind === "empty") {
    if (!state || !stateMatchesSegments(state, [], 0, 0, tipSeq) || state.coveredSeq <= after) {
      return fallback(after, limit, SIGNAL_ONLY);
    }
    if (state.coveredSeq >= tipSeq) return { events: [], cursor: tipSeq, more: false };
    return fallback(state.coveredSeq, limit, SIGNAL_ONLY);
  }

  const inspected = inspectFinalSegment(listed.segments, state, key, sessionId, tipSeq);
  if (!inspected || inspected.covered <= after) {
    return fallback(after, limit, SIGNAL_ONLY);
  }
  const { validSegments, lastSignalSeq, covered, cachedFinal } = inspected;
  if (after >= lastSignalSeq) {
    if (covered >= tipSeq) return { events: [], cursor: tipSeq, more: false };
    return fallback(covered, limit, SIGNAL_ONLY);
  }

  const events: Event[] = [];
  let totalBytes = 0;
  let lastValidSeq = after;
  const startIdx = findStartSegment(validSegments, after);
  for (let s = startIdx; s < validSegments.length; s++) {
    const seg = validSegments[s];
    const isFinal = s === validSegments.length - 1;
    if (isFinal && cachedFinal) {
      let prevSeq = s === startIdx ? 0 : lastValidSeq;
      for (let i = 0; i < cachedFinal.entries.length; i++) {
        const entry = cachedFinal.entries[i];
        if (entry.seq > covered || entry.seq <= prevSeq) {
          if (events.length > 0) return { events, cursor: events[events.length - 1].seq, more: true };
          return fallback(Math.max(after, lastValidSeq), limit, SIGNAL_ONLY);
        }
        prevSeq = entry.seq;
        if (entry.seq <= after) {
          lastValidSeq = Math.max(lastValidSeq, entry.seq);
          continue;
        }
        const bytes = cachedFinal.lineBytes[i];
        if (
          events.length >= limit ||
          (events.length > 0 && (totalBytes >= MAX_EVENT_PAGE_BYTES || totalBytes + bytes > MAX_EVENT_PAGE_BYTES))
        ) {
          return { events, cursor: events[events.length - 1].seq, more: true };
        }
        events.push(entry);
        totalBytes += bytes;
        lastValidSeq = entry.seq;
        if (
          (events.length >= limit || totalBytes >= MAX_EVENT_PAGE_BYTES) &&
          i + 1 < cachedFinal.entries.length
        ) {
          return { events, cursor: entry.seq, more: true };
        }
      }
      continue;
    }

    const raw = readSegmentRaw(seg.path);
    const fullCheck = !isFinal && (!raw.ok || !raw.hasTrailingNewline || raw.lines.length !== SIGNAL_SEGMENT_SIZE);
    if (fullCheck || !raw.ok || raw.lines.length === 0 || raw.lines.length > SIGNAL_SEGMENT_SIZE) {
      if (events.length > 0) return { events, cursor: events[events.length - 1].seq, more: true };
      return fallback(Math.max(after, lastValidSeq), limit, SIGNAL_ONLY);
    }
    if (!isFinal && s === startIdx && seg.startSeq <= after) {
      const segTail = unsealSegmentLine(
        key,
        sessionId,
        seg,
        raw.lines.length - 1,
        raw.lines[raw.lines.length - 1],
        seg.startSeq,
      );
      if (segTail && segTail.seq <= after) {
        lastValidSeq = segTail.seq;
        continue;
      }
    }
    let segPrevSeq = s === startIdx ? 0 : lastValidSeq;
    for (let i = 0; i < raw.lines.length; i++) {
      const line = raw.lines[i];
      const entry = unsealSegmentLine(key, sessionId, seg, i, line, segPrevSeq);
      if (!entry || entry.seq > covered) {
        if (events.length > 0) return { events, cursor: events[events.length - 1].seq, more: true };
        return fallback(Math.max(after, lastValidSeq), limit, SIGNAL_ONLY);
      }
      segPrevSeq = entry.seq;
      if (entry.seq <= after) {
        lastValidSeq = Math.max(lastValidSeq, entry.seq);
        continue;
      }
      if (
        events.length >= limit ||
        (events.length > 0 && (totalBytes >= MAX_EVENT_PAGE_BYTES || totalBytes + line.length > MAX_EVENT_PAGE_BYTES))
      ) {
        return { events, cursor: events[events.length - 1].seq, more: true };
      }
      events.push(entry);
      totalBytes += line.length;
      lastValidSeq = entry.seq;
      if (
        (events.length >= limit || totalBytes >= MAX_EVENT_PAGE_BYTES) &&
        (i + 1 < raw.lines.length || !isFinal)
      ) {
        return { events, cursor: entry.seq, more: true };
      }
    }
  }

  if (covered >= tipSeq) {
    return { events, cursor: tipSeq, more: false };
  }
  if (events.length > 0) {
    return { events, cursor: covered, more: true };
  }
  return fallback(covered, limit, SIGNAL_ONLY);
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
