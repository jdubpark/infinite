// The transcript watch owns everything the worker needs to capture a session's usage and chat
// from its provider transcript: the byte reader, the usage reader, the drains, the end evidence,
// the subagent transcripts, and the facts that stay true once a transcript is replaced. The worker
// journals what it returns.
import { TranscriptTail, type TranscriptMessage, type TranscriptProvider } from "./transcript.js";
import { UsageTail, usageCoverage, type SecondaryState, type UsageCoverage, type UsageCoverageReason } from "./transcript-usage.js";
import { MAX_SECONDARY_FILES, SECONDARY_ID, SECONDARY_NAME, type SecondaryListing, type SecondaryRequest } from "./transcript-secondary.js";
import type { UsageRecord } from "./usage.js";

/** How the final drain after the provider exited ended: it never ran, it reached the end, or it did not. */
export type FinalDrainState = "complete" | "incomplete" | "skipped";

/** The coverage of one session, journaled by the worker when the provider exits. */
export interface CoverageRecord {
  coverage: UsageCoverage;
  reason?: UsageCoverageReason;
  records: number;
  provider: string;
  /** Present only when `finish` was told a drain was owed and a primary transcript was open. */
  finalDrain?: FinalDrainState;
}

/**
 * Whether a hook closes a turn with nothing left running: the `SessionEnd` event, or a `turn-end` signal that
 * did not fail and has no background task. A background subagent keeps writing usage after its turn ends, and a
 * failed turn end carries no task count, so neither proves that every row was read.
 */
export function closesTurn(signals: readonly { kind: string; backgroundTasks?: number; failed?: boolean }[], event: string): boolean {
  if (event === "SessionEnd") return true;
  return signals.some(signal => signal.kind === "turn-end" && signal.failed !== true && (signal.backgroundTasks ?? 0) === 0);
}

export interface WatchOptions {
  /** The session's provider. `opencode` never reaches the watch; its usage comes from run output. */
  provider: string;
  /** The model the launch asked for. Used only when a row names no model. */
  requestedModel?: string;
  /** Journals one usage record. A throw is recorded as a failed write and never reaches chat. */
  onUsage: (record: UsageRecord) => void;
}

/** The facts of one provider hook that the watch needs. The worker reads them from the payload. */
export interface WatchHook {
  /** The hook came from a subagent, whose usage the primary transcript does not hold. */
  subagent: boolean;
  /** The hook closes a turn: a turn-end signal, or the end of the session. */
  turnEnd: boolean;
  /** The hook names a primary transcript file. Absent when the hook names none. */
  transcript?: { path: string; provider: TranscriptProvider };
  /** The hook is the provider's `SessionEnd`. */
  sessionEnd?: boolean;
}

/** A secondary transcript the watch reads, with its own end evidence for one drain. */
interface Reader {
  name: string;
  /** The identity of the file the watch first read under this name. */
  id: string;
  tail: TranscriptTail;
  usage: UsageTail;
  /** The largest size any listing gave for the file. The reader must reach it before it is complete. */
  required: number;
  /** The file was replaced or shortened. Its bytes are never read again. */
  broken: boolean;
  evidence?: { drain: number; offset: number };
}

/** The secondary listing that came with the primary end mark of one drain. */
interface Listing {
  drain: number;
  names: Set<string>;
}

/**
 * The transcript being read now, with its byte reader, its usage reader, and its secondary facts. Secondary
 * facts belong to one transcript. `cut` is sticky: once a listing shows files the watch cannot hold, the
 * transcript's secondaries are never complete.
 */
interface Current {
  path: string;
  provider: TranscriptProvider;
  tail: TranscriptTail;
  usage: UsageTail;
  readers: Map<string, Reader>;
  listing?: Listing;
  cut: boolean;
  /** A subagent hook arrived while this transcript was the primary. */
  subagentHook: boolean;
  /** A listing of this transcript reported a file, or was invalid. Sticky. */
  listedAny: boolean;
}

const RANK: Record<SecondaryState, number> = { none: 0, complete: 1, missing: 2 };
/** The worse of two secondary states: `missing` is worse than `complete`, which is worse than `none`. */
const worse = (a: SecondaryState, b: SecondaryState): SecondaryState => (RANK[a] >= RANK[b] ? a : b);

/** Runs `action`, and returns `fallback` when it throws. The watch never throws to its caller. */
function guard<T>(fallback: T, action: () => T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

/** The listing value of a primary end mark, when it is well formed. Undefined for any other value. */
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

/**
 * One session's transcript watch. A drain starts at each hook that names the transcript. The drain
 * is complete only when a post names it and reaches the end of the file with nothing pending.
 */
export class TranscriptWatch {
  private readonly options: WatchOptions;
  private current: Current | undefined;
  private drainSeq = 0;
  /** The id of the drain the last transcript hook started. */
  private drain: number | undefined;
  /** The last provider hook: whether it closed a turn, and which drain it started. */
  private last: { turnEnd: boolean; drain: number | undefined } | undefined;
  /** The end evidence for `drain`: the offset at which its end mark arrived. */
  private evidence: { drain: number; offset: number } | undefined;
  /** A subagent hook that arrived before any transcript was open. It counts for the first transcript that opens. */
  private pendingSubagent = false;
  private writeFailed = false;
  /** The host asked the provider to stop. Sticky. */
  private stopped = false;
  /** The provider exited and the watch closed. Sticky. */
  private closed = false;
  /** The id of the final drain, once one started. */
  private finalDrain: number | undefined;
  /** What replaced transcripts held. Each fact stays sticky. `secondary` is the worst state of them all. */
  private readonly retired: { rows: number; records: number; dropped: boolean; gap: boolean; midTurn: boolean; secondary: SecondaryState; mismatch: boolean; childThreads: boolean } = {
    rows: 0, records: 0, dropped: false, gap: false, midTurn: false, secondary: "none", mismatch: false, childThreads: false,
  };

  constructor(options: WatchOptions) {
    this.options = options;
  }

  /** A primary transcript is open, so a final drain has a file to read. */
  get reading(): boolean {
    return this.current !== undefined && !this.closed;
  }

  /** The host asked the provider to stop. Idempotent. */
  stopRequested(): void {
    this.stopped = true;
  }

  /**
   * Every provider hook. Returns what the relay must send when the hook names a transcript. After the final drain
   * starts, a hook changes nothing: the provider has exited, so no late hook can describe a turn.
   */
  hook(input: WatchHook): { path: string; after: number; drain: number; secondaries?: true } | undefined {
    return guard(undefined, () => {
      if (this.closed || this.finalDrain !== undefined) return undefined;
      // After a stop request, the provider's SessionEnd proves the process is ending, not that the turn ended: it keeps the turn boundary of the hook before it.
      const turnEnd = input.sessionEnd === true && this.stopped ? (this.last?.turnEnd ?? false) : input.turnEnd;
      return this.receiveHook({ ...input, turnEnd });
    });
  }

  /**
   * Starts the final drain on the current transcript, once per session. It takes the turn boundary of the last
   * provider hook. Undefined when no primary transcript is open, or after the drain started or the watch closed.
   */
  drainFinal(): { path: string; after: number; drain: number; secondaries?: true } | undefined {
    return guard(undefined, () => {
      const current = this.current;
      if (this.closed || !current || this.finalDrain !== undefined) return undefined;
      const started = this.receiveHook({
        subagent: false, turnEnd: this.last?.turnEnd ?? false, transcript: { path: current.path, provider: current.provider },
      });
      if (started) this.finalDrain = started.drain;
      return started;
    });
  }

  /**
   * One post to the transcript route: a chunk or an end mark, for the primary or a secondary. Undefined
   * when the post is not for the current transcript, or the watch closed. `secondaries` lists the files the worker wants.
   */
  post(body: unknown): { messages: TranscriptMessage[]; after: number; secondaries?: SecondaryRequest[] } | undefined {
    return guard(undefined, () => (this.closed ? undefined : this.receivePost(body)));
  }

  /**
   * The provider exited. Journals the last usage records, and returns the coverage of the session. With `finalDrain`
   * true a drain was owed: the record states how it ended, and the watch closes.
   */
  finish(hooks: boolean, finalDrain = false): CoverageRecord {
    if (finalDrain) this.closed = true;
    return guard<CoverageRecord>({ coverage: "partial", reason: "row-dropped", records: 0, provider: this.options.provider }, () => this.coverage(hooks, finalDrain));
  }

  private receiveHook(input: WatchHook): { path: string; after: number; drain: number; secondaries?: true } | undefined {
    if (input.subagent) {
      if (this.current) this.current.subagentHook = true;
      else this.pendingSubagent = true;
    }
    // A subagent hook can drain the primary the watch already reads. It never opens or replaces one.
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
    // Only a Claude transcript has subagent files, so only its hooks ask for the listing.
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
    // A chunk from elsewhere than the cursor is not applied; the reply tells the relay where to resume.
    const applied = b.offset === current.tail.offset;
    if (typeof b.text === "string") {
      // A chunk never creates end evidence, whatever flags it carries. Only a text-less mark does.
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

  /** A post for one secondary transcript. Its chat messages are discarded; only its usage is kept. */
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

  /**
   * Accepts the listing of the current drain. A file the watch cannot hold becomes a cut listing. Returns the
   * files that have grown past the watch's offset, in listing order, with the byte each starts at.
   */
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
      // A file under a name the watch read before, with another identity, or smaller than a size a listing gave
      // or than the bytes already read, was replaced or shortened. Its cursor belongs to bytes that no longer
      // exist, so it is never read again.
      if (reader.broken || file.id !== reader.id || file.size < Math.max(reader.required, reader.tail.offset)) {
        reader.broken = true;
        current.cut = true;
        continue;
      }
      reader.required = Math.max(reader.required, file.size);
      const offset = reader.tail.offset;
      // The listing comes from the relay's fresh size check. A file with nothing new needs no stream.
      if (file.size === offset && !reader.tail.pending) reader.evidence = { drain, offset };
      else if (file.size > offset) {
        // Bytes are unread: the evidence of an earlier listing in this drain no longer holds.
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

  /** Records end evidence only for the drain the last transcript hook started. */
  private mark(drain: unknown, offset: number) {
    if (this.drain !== undefined && drain === this.drain) this.evidence = { drain: this.drain, offset };
  }

  /** The drain of the last transcript hook reached the end of `current`, and nothing is pending. */
  private complete(current: Current): boolean {
    const evidence = this.evidence;
    return evidence !== undefined
      && this.drain !== undefined
      && evidence.drain === this.drain
      && this.last?.drain === this.drain
      && evidence.offset === current.tail.offset
      && !current.tail.pending;
  }

  /**
   * The listing of the current drain names every secondary reader, each one reached its end in this drain
   * at its required size, and the transcript is not cut. Evaluated while the drain it names is still current.
   */
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

  /**
   * The secondary state of one transcript. `none` when it saw no subagent hook, has no reader, and no listing of
   * it reported a file or was invalid. `complete` when it has a reader and its secondaries are complete.
   */
  private stateOf(current: Current): SecondaryState {
    if (!current.subagentHook && current.readers.size === 0 && !current.listedAny) return "none";
    return current.readers.size > 0 && this.secondariesComplete(current) ? "complete" : "missing";
  }

  /** The secondary state of the session: the worst of the current transcript and every replaced one. */
  private sessionSecondary(current: Current | undefined): SecondaryState {
    const now: SecondaryState = current ? this.stateOf(current) : this.pendingSubagent ? "missing" : "none";
    return worse(this.retired.secondary, now);
  }

  /** Retires the current transcript, then opens the next one with no evidence and no secondary facts. */
  private switchTo(next: { path: string; provider: TranscriptProvider }): Current {
    if (this.current) this.retire(this.current);
    this.evidence = undefined;
    const usage = new UsageTail({ provider: next.provider, requestedModel: this.options.requestedModel });
    const tail = new TranscriptTail(next.provider, 4096, row => this.emit(usage.push(row)));
    this.current = { path: next.path, provider: next.provider, tail, usage, readers: new Map(), cut: false, subagentHook: this.pendingSubagent, listedAny: false };
    this.pendingSubagent = false;
    return this.current;
  }

  /** Journals the usage the old transcript and its secondaries still held, and keeps its facts. */
  private retire(old: Current) {
    const complete = this.complete(old);
    // The state is read while the drain it names is still the current one.
    this.retired.secondary = worse(this.retired.secondary, this.stateOf(old));
    this.retireUsage(old.usage, old.tail);
    for (const reader of old.readers.values()) this.retireUsage(reader.usage, reader.tail);
    this.retired.gap = this.retired.gap || !complete;
    // A transcript that ended its drain outside a turn boundary leaves the session mid-turn, even if a later one ends a turn.
    this.retired.midTurn = this.retired.midTurn || (complete && !(this.last?.turnEnd ?? false));
  }

  /** Finishes one usage reader: its records are journaled, and its counts and faults join the retired facts. */
  private retireUsage(usage: UsageTail, tail: TranscriptTail) {
    const records = usage.finish();
    this.retired.rows += usage.rowCount();
    this.retired.records += usage.recordCount();
    this.retired.dropped = this.retired.dropped || tail.dropped || tail.discarded > 0 || usage.rejectedCount() > 0;
    this.retired.mismatch = this.retired.mismatch || !usage.reconciled();
    this.retired.childThreads = this.retired.childThreads || usage.sawChildThreads();
    this.emit(records);
  }

  /** Writes each record through the caller's journal. A failed write is kept as a fact, never thrown. */
  private emit(records: UsageRecord[]) {
    for (const record of records) {
      try {
        this.options.onUsage(record);
      } catch {
        this.writeFailed = true;
      }
    }
  }

  /** The coverage of the session, from the current transcript and every retired fact. */
  private coverage(hooks: boolean, finalDrain: boolean): CoverageRecord {
    const current = this.current;
    if (current) this.emit(current.usage.finish());
    // The final drain is the last drain. It is complete when it is the current drain and the primary transcript reached its end.
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
        turnEnd: (this.last?.turnEnd ?? false) && !this.retired.midTurn,
      },
      finalDrain: finalState,
      secondary: this.sessionSecondary(current),
      childThreads: this.retired.childThreads || (tail?.sawChildThreads() ?? false),
      totalMismatch: this.retired.mismatch || (tail !== undefined && !tail.reconciled()) || readers.some(reader => !reader.usage.reconciled()),
    });
    return { ...result, records, provider: this.options.provider, ...(finalState ? { finalDrain: finalState } : {}) };
  }
}
