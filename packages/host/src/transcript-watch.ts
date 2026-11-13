// The transcript watch owns everything the worker needs to capture a session's usage and chat
// from its provider transcript: the byte reader, the usage reader, the drains, the end evidence,
// and the facts that stay true once a transcript is replaced. The worker journals what it returns.
import { TranscriptTail, type TranscriptMessage, type TranscriptProvider } from "./transcript.js";
import { UsageTail, usageCoverage, type UsageCoverage, type UsageCoverageReason } from "./transcript-usage.js";
import type { UsageRecord } from "./usage.js";

/** The coverage of one session, journaled by the worker when the provider exits. */
export interface CoverageRecord {
  coverage: UsageCoverage;
  reason?: UsageCoverageReason;
  records: number;
  provider: string;
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
}

/** The transcript being read now, with its byte reader and its usage reader. */
interface Current {
  path: string;
  tail: TranscriptTail;
  usage: UsageTail;
}

/** Runs `action`, and returns `fallback` when it throws. The watch never throws to its caller. */
function guard<T>(fallback: T, action: () => T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
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
  private subagents = false;
  private writeFailed = false;
  /** What replaced transcripts held. Each fact stays sticky. */
  private readonly retired = { rows: 0, records: 0, dropped: false, gap: false, mismatch: false, childThreads: false };

  constructor(options: WatchOptions) {
    this.options = options;
  }

  /** Every provider hook. Returns what the relay must send when the hook names a transcript. */
  hook(input: WatchHook): { path: string; after: number; drain: number } | undefined {
    return guard(undefined, () => this.receiveHook(input));
  }

  /** One post to the transcript route: a chunk or an end mark. Undefined when the post is not for the current transcript. */
  post(body: unknown): { messages: TranscriptMessage[]; after: number } | undefined {
    return guard(undefined, () => this.receivePost(body));
  }

  /** The provider exited. Journals the last usage records, and returns the coverage of the session. */
  finish(hooks: boolean): CoverageRecord {
    return guard<CoverageRecord>({ coverage: "partial", reason: "row-dropped", records: 0, provider: this.options.provider }, () => this.coverage(hooks));
  }

  private receiveHook(input: WatchHook): { path: string; after: number; drain: number } | undefined {
    if (input.subagent) this.subagents = true;
    if (!input.transcript) {
      this.last = { turnEnd: input.turnEnd, drain: undefined };
      return undefined;
    }
    const path = input.transcript.path;
    const current = this.current?.path === path ? this.current : this.switchTo({ path, provider: input.transcript.provider });
    this.drainSeq += 1;
    this.drain = this.drainSeq;
    this.last = { turnEnd: input.turnEnd, drain: this.drain };
    return { path, after: current.tail.offset, drain: this.drain };
  }

  private receivePost(body: unknown): { messages: TranscriptMessage[]; after: number } | undefined {
    const current = this.current;
    const b = body as Record<string, unknown>;
    if (!current || b.path !== current.path) return undefined;
    // A chunk from elsewhere than the cursor is not applied; the reply tells the relay where to resume.
    const applied = b.offset === current.tail.offset;
    if (typeof b.text === "string") {
      // A chunk never creates end evidence, whatever flags it carries. Only a text-less mark does.
      const messages = applied ? current.tail.ingest(b.text) : [];
      return { messages, after: current.tail.offset };
    }
    if (b.end !== true) return undefined;
    if (applied) this.mark(b.drain, current.tail.offset);
    return { messages: [], after: current.tail.offset };
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

  /** Retires the current transcript, then opens the next one with no evidence. */
  private switchTo(next: { path: string; provider: TranscriptProvider }): Current {
    if (this.current) this.retire(this.current);
    this.evidence = undefined;
    const usage = new UsageTail({ provider: next.provider, requestedModel: this.options.requestedModel });
    const tail = new TranscriptTail(next.provider, 4096, row => this.emit(usage.push(row)));
    this.current = { path: next.path, tail, usage };
    return this.current;
  }

  /** Journals the usage the old transcript still held, and keeps its facts. */
  private retire(old: Current) {
    const complete = this.complete(old);
    const records = old.usage.finish();
    this.retired.rows += old.usage.rowCount();
    this.retired.records += old.usage.recordCount();
    this.retired.dropped = this.retired.dropped || old.tail.dropped || old.tail.discarded > 0 || old.usage.rejectedCount() > 0;
    this.retired.gap = this.retired.gap || !complete;
    this.retired.mismatch = this.retired.mismatch || !old.usage.reconciled();
    this.retired.childThreads = this.retired.childThreads || old.usage.sawChildThreads();
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

  private coverage(hooks: boolean): CoverageRecord {
    const current = this.current;
    if (current) this.emit(current.usage.finish());
    const tail = current?.usage;
    const records = this.retired.records + (tail?.recordCount() ?? 0);
    const result = usageCoverage({
      provider: this.options.provider,
      hooks,
      rows: this.retired.rows + (tail?.rowCount() ?? 0),
      records,
      dropped: this.retired.dropped || this.writeFailed
        || (current !== undefined && (current.tail.dropped || current.tail.discarded > 0))
        || (tail?.rejectedCount() ?? 0) > 0,
      lastDrain: { complete: current !== undefined && this.complete(current) && !this.retired.gap, turnEnd: this.last?.turnEnd ?? false },
      subagents: this.subagents,
      childThreads: this.retired.childThreads || (tail?.sawChildThreads() ?? false),
      totalMismatch: this.retired.mismatch || (tail !== undefined && !tail.reconciled()),
    });
    return { ...result, records, provider: this.options.provider };
  }
}
