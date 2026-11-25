import { TranscriptTail, type TranscriptMessage, type TranscriptProvider } from "./transcript.js";
import { UsageTail, usageCoverage, type SecondaryState, type UsageCoverage, type UsageCoverageReason } from "./transcript-usage.js";
import { MAX_SECONDARY_FILES, SECONDARY_ID, SECONDARY_NAME, type SecondaryListing, type SecondaryRequest } from "./transcript-secondary.js";
import type { UsageRecord } from "./usage.js";

export type FinalDrainState = "complete" | "incomplete" | "skipped";

export interface CoverageRecord {
  coverage: UsageCoverage;
  reason?: UsageCoverageReason;
  records: number;
  provider: string;
  finalDrain?: FinalDrainState;
}

export function closesTurn(signals: readonly { kind: string; backgroundTasks?: number; failed?: boolean }[], event: string): boolean {
  if (event === "SessionEnd") return true;
  return signals.some(signal => signal.kind === "turn-end" && signal.failed !== true && (signal.backgroundTasks ?? 0) === 0);
}

export interface WatchOptions {
  provider: string;
  requestedModel?: string;
  onUsage: (record: UsageRecord) => void;
}

export interface WatchHook {
  subagent: boolean;
  turnEnd: boolean;
  transcript?: { path: string; provider: TranscriptProvider };
  sessionEnd?: boolean;
  endOnly?: boolean;
}

interface Reader {
  name: string;
  id: string;
  tail: TranscriptTail;
  usage: UsageTail;
  required: number;
  broken: boolean;
  evidence?: { drain: number; offset: number };
}

interface Listing {
  drain: number;
  names: Set<string>;
}

interface Current {
  path: string;
  provider: TranscriptProvider;
  tail: TranscriptTail;
  usage: UsageTail;
  readers: Map<string, Reader>;
  listing?: Listing;
  cut: boolean;
  subagentHook: boolean;
  listedAny: boolean;
}

const RANK: Record<SecondaryState, number> = { none: 0, complete: 1, missing: 2 };
const worse = (a: SecondaryState, b: SecondaryState): SecondaryState => (RANK[a] >= RANK[b] ? a : b);

function guard<T>(fallback: T, action: () => T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

function parseListing(value: unknown): SecondaryListing | undefined {
  const listing = value as { files?: unknown; total?: unknown } | null;
  if (!listing || typeof listing !== "object" || !Array.isArray(listing.files) || listing.files.length > MAX_SECONDARY_FILES) return undefined;
  if (!Number.isSafeInteger(listing.total) || (listing.total as number) < listing.files.length) return undefined;
  const seen = new Set<string>();
  const files: { name: string; size: number; id: string }[] = [];
  for (const item of listing.files) {
    const file = item as { name?: unknown; size?: unknown; id?: unknown } | null;
    if (!file || typeof file !== "object" || typeof file.name !== "string" || !SECONDARY_NAME.test(file.name) || seen.has(file.name)) return undefined;
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) return undefined;
    if (typeof file.id !== "string" || !SECONDARY_ID.test(file.id)) return undefined;
    seen.add(file.name);
    files.push({ name: file.name, size: file.size as number, id: file.id });
  }
  return { files, total: listing.total as number };
}

export class TranscriptWatch {
  private readonly options: WatchOptions;
  private current: Current | undefined;
  private drainSeq = 0;
  private drain: number | undefined;
  private last: { turnEnd: boolean; drain: number | undefined } | undefined;
  private endOnly = false;
  private evidence: { drain: number; offset: number } | undefined;
  private pendingSubagent = false;
  private writeFailed = false;
  private stopped = false;
  private closed = false;
  private finalDrain: number | undefined;
  private finalStart: { path: string; after: number; drain: number; secondaries?: true } | undefined;
  private readonly retired: { rows: number; records: number; dropped: boolean; gap: boolean; midTurn: boolean; secondary: SecondaryState; mismatch: boolean; childThreads: boolean } = {
    rows: 0, records: 0, dropped: false, gap: false, midTurn: false, secondary: "none", mismatch: false, childThreads: false,
  };

  constructor(options: WatchOptions) {
    this.options = options;
  }

  get reading(): boolean {
    return this.current !== undefined && !this.closed;
  }

  stopRequested(): void {
    this.stopped = true;
  }

  hook(input: WatchHook): { path: string; after: number; drain: number; secondaries?: true } | undefined {
    return guard(undefined, () => {
      if (this.closed || this.finalDrain !== undefined) return undefined;
      const turnEnd = input.sessionEnd === true && this.stopped ? (this.last?.turnEnd ?? false) : input.turnEnd;
      const started = this.receiveHook({ ...input, turnEnd });
      this.endOnly = input.endOnly === true && turnEnd;
      return started;
    });
  }

  drainFinal(): { path: string; after: number; drain: number; secondaries?: true } | undefined {
    return guard(undefined, () => {
      const current = this.current;
      if (this.closed || !current) return undefined;
      if (this.finalStart) return { ...this.finalStart, after: current.tail.offset };
      const started = this.receiveHook({
        subagent: false, turnEnd: this.last?.turnEnd ?? false, transcript: { path: current.path, provider: current.provider },
      });
      if (started) {
        this.finalDrain = started.drain;
        this.finalStart = started;
      }
      return started;
    });
  }

  post(body: unknown): { messages: TranscriptMessage[]; after: number; secondaries?: SecondaryRequest[] } | undefined {
    return guard(undefined, () => (this.closed ? undefined : this.receivePost(body)));
  }

  finish(hooks: boolean, finalDrain = false): CoverageRecord {
    if (finalDrain) this.closed = true;
    return guard<CoverageRecord>({ coverage: "partial", reason: "row-dropped", records: 0, provider: this.options.provider }, () => this.coverage(hooks, finalDrain));
  }

  private receiveHook(input: WatchHook): { path: string; after: number; drain: number; secondaries?: true } | undefined {
    if (input.subagent) {
      if (this.current) this.current.subagentHook = true;
      else this.pendingSubagent = true;
    }
    const transcript = input.subagent && input.transcript?.path !== this.current?.path ? undefined : input.transcript;
    if (!transcript) {
      this.last = { turnEnd: input.turnEnd, drain: undefined };
      return undefined;
    }
    const path = transcript.path;
    const current = this.current?.path === path ? this.current : this.switchTo({ path, provider: transcript.provider });
    this.drainSeq += 1;
    this.drain = this.drainSeq;
    this.last = { turnEnd: input.turnEnd, drain: this.drain };
    return {
      path,
      after: current.tail.offset,
      drain: this.drain,
      ...(transcript.provider === "claude" ? { secondaries: true as const } : {}),
    };
  }

  private receivePost(body: unknown): { messages: TranscriptMessage[]; after: number; secondaries?: SecondaryRequest[] } | undefined {
    const current = this.current;
    const b = body as Record<string, unknown>;
    if (!current || b.path !== current.path) return undefined;
    if (typeof b.secondary === "string") return this.receiveSecondary(current, b.secondary, b);
    const applied = b.offset === current.tail.offset;
    if (typeof b.text === "string") {
      const messages = applied ? current.tail.ingest(b.text) : [];
      return { messages, after: current.tail.offset };
    }
    if (b.end !== true) return undefined;
    if (applied) this.mark(b.drain, current.tail.offset);
    if (!applied || this.drain === undefined || b.drain !== this.drain || b.secondaries === undefined) {
      return { messages: [], after: current.tail.offset };
    }
    const wanted = this.acceptListing(current, b.secondaries);
    return { messages: [], after: current.tail.offset, ...(wanted.length > 0 ? { secondaries: wanted } : {}) };
  }

  private receiveSecondary(current: Current, name: string, b: Record<string, unknown>) {
    const reader = current.readers.get(name);
    if (!reader || reader.broken) return undefined;
    const applied = b.offset === reader.tail.offset;
    if (typeof b.text === "string") {
      if (applied) reader.tail.ingest(b.text);
      return { messages: [], after: reader.tail.offset };
    }
    if (b.end !== true) return undefined;
    if (applied && this.drain !== undefined && b.drain === this.drain) reader.evidence = { drain: this.drain, offset: reader.tail.offset };
    return { messages: [], after: reader.tail.offset };
  }

  private acceptListing(current: Current, value: unknown): SecondaryRequest[] {
    const drain = this.drain as number;
    const parsed = parseListing(value);
    if (!parsed) {
      current.listedAny = true;
      current.cut = true;
      current.listing = { drain, names: new Set() };
      return [];
    }
    if (parsed.total > 0) current.listedAny = true;
    if (parsed.total > parsed.files.length) current.cut = true;
    const names = new Set<string>();
    const wanted: SecondaryRequest[] = [];
    for (const file of parsed.files) {
      let reader = current.readers.get(file.name);
      if (!reader) {
        if (current.readers.size >= MAX_SECONDARY_FILES) {
          current.cut = true;
          continue;
        }
        reader = this.openReader(current, file.name, file.id);
      }
      names.add(file.name);
      if (reader.broken || file.id !== reader.id || file.size < Math.max(reader.required, reader.tail.offset)) {
        reader.broken = true;
        current.cut = true;
        continue;
      }
      reader.required = Math.max(reader.required, file.size);
      const offset = reader.tail.offset;
      if (file.size === offset && !reader.tail.pending) reader.evidence = { drain, offset };
      else if (file.size > offset) {
        reader.evidence = undefined;
        wanted.push({ name: file.name, after: offset });
      }
    }
    current.listing = { drain, names };
    return wanted;
  }

  private openReader(current: Current, name: string, id: string): Reader {
    const usage = new UsageTail({ provider: "claude", secondary: true });
    const tail = new TranscriptTail("claude", 1, row => this.emit(usage.push(row)));
    const reader: Reader = { name, id, tail, usage, required: 0, broken: false };
    current.readers.set(name, reader);
    return reader;
  }

  private mark(drain: unknown, offset: number) {
    if (this.drain === undefined || drain !== this.drain) return;
    this.evidence = { drain: this.drain, offset };
  }

  private endStands(current: Current | undefined, finalDrain: FinalDrainState | undefined): boolean {
    return !this.endOnly || (finalDrain === "complete" && current !== undefined && current.usage.lastTurnEnded());
  }

  private complete(current: Current): boolean {
    const evidence = this.evidence;
    return evidence !== undefined
      && this.drain !== undefined
      && evidence.drain === this.drain
      && this.last?.drain === this.drain
      && evidence.offset === current.tail.offset
      && !current.tail.pending;
  }

  private secondariesComplete(current: Current): boolean {
    const listing = current.listing;
    if (current.cut || !listing || this.drain === undefined || listing.drain !== this.drain || this.last?.drain !== this.drain) return false;
    for (const reader of current.readers.values()) {
      const evidence = reader.evidence;
      if (!listing.names.has(reader.name) || !evidence || evidence.drain !== this.drain
        || evidence.offset !== reader.tail.offset || reader.tail.offset < reader.required || reader.tail.pending) return false;
    }
    return true;
  }

  private stateOf(current: Current): SecondaryState {
    if (!current.subagentHook && current.readers.size === 0 && !current.listedAny) return "none";
    return current.readers.size > 0 && this.secondariesComplete(current) ? "complete" : "missing";
  }

  private sessionSecondary(current: Current | undefined): SecondaryState {
    const now: SecondaryState = current ? this.stateOf(current) : this.pendingSubagent ? "missing" : "none";
    return worse(this.retired.secondary, now);
  }

  private switchTo(next: { path: string; provider: TranscriptProvider }): Current {
    if (this.current) this.retire(this.current);
    this.evidence = undefined;
    const usage = new UsageTail({ provider: next.provider, requestedModel: this.options.requestedModel });
    const tail = new TranscriptTail(next.provider, 4096, row => this.emit(usage.push(row)));
    this.current = { path: next.path, provider: next.provider, tail, usage, readers: new Map(), cut: false, subagentHook: this.pendingSubagent, listedAny: false };
    this.pendingSubagent = false;
    return this.current;
  }

  private retire(old: Current) {
    const complete = this.complete(old);
    this.retired.secondary = worse(this.retired.secondary, this.stateOf(old));
    this.retireUsage(old.usage, old.tail);
    for (const reader of old.readers.values()) this.retireUsage(reader.usage, reader.tail);
    this.retired.gap = this.retired.gap || !complete || this.endOnly;
    this.retired.midTurn = this.retired.midTurn || (complete && !(this.last?.turnEnd ?? false));
  }

  private retireUsage(usage: UsageTail, tail: TranscriptTail) {
    const records = usage.finish();
    this.retired.rows += usage.rowCount();
    this.retired.records += usage.recordCount();
    this.retired.dropped = this.retired.dropped || tail.dropped || tail.discarded > 0 || usage.rejectedCount() > 0;
    this.retired.mismatch = this.retired.mismatch || !usage.reconciled();
    this.retired.childThreads = this.retired.childThreads || usage.sawChildThreads();
    this.emit(records);
  }

  private emit(records: UsageRecord[]) {
    for (const record of records) {
      try {
        this.options.onUsage(record);
      } catch {
        this.writeFailed = true;
      }
    }
  }

  private coverage(hooks: boolean, finalDrain: boolean): CoverageRecord {
    const current = this.current;
    if (current) this.emit(current.usage.finish());
    const finalState: FinalDrainState | undefined = finalDrain && current
      ? (this.finalDrain === undefined ? "skipped" : this.drain === this.finalDrain && this.complete(current) ? "complete" : "incomplete")
      : undefined;
    const readers = current ? [...current.readers.values()] : [];
    for (const reader of readers) this.emit(reader.usage.finish());
    const tail = current?.usage;
    const rows = this.retired.rows + (tail?.rowCount() ?? 0) + readers.reduce((sum, reader) => sum + reader.usage.rowCount(), 0);
    const records = this.retired.records + (tail?.recordCount() ?? 0) + readers.reduce((sum, reader) => sum + reader.usage.recordCount(), 0);
    const result = usageCoverage({
      provider: this.options.provider,
      hooks,
      rows,
      records,
      dropped: this.retired.dropped || this.writeFailed
        || (current !== undefined && (current.tail.dropped || current.tail.discarded > 0))
        || (tail?.rejectedCount() ?? 0) > 0
        || readers.some(reader => reader.tail.dropped || reader.tail.discarded > 0 || reader.usage.rejectedCount() > 0),
      lastDrain: {
        complete: current !== undefined && this.complete(current) && !this.retired.gap,
        turnEnd: (this.last?.turnEnd ?? false) && !this.retired.midTurn && this.endStands(current, finalState),
      },
      finalDrain: finalState,
      secondary: this.sessionSecondary(current),
      childThreads: this.retired.childThreads || (tail?.sawChildThreads() ?? false),
      totalMismatch: this.retired.mismatch || (tail !== undefined && !tail.reconciled()) || readers.some(reader => !reader.usage.reconciled()),
    });
    return { ...result, records, provider: this.options.provider, ...(finalState ? { finalDrain: finalState } : {}) };
  }
}
