import { createHash } from "node:crypto";
import { canonicalJson } from "./crypto.js";
import { type EvidenceStore, eventProblem, isEventKind } from "./store.js";
import type { EvidenceModule, EvidenceTx, RunEvent } from "./types.js";

export type OutboxEvent = Omit<RunEvent, "seq">;

export interface EventProjector {
  /** Unique among projectors, /^[a-z][a-z0-9-]{0,39}$/. The outbox keeps one cursor under this name. */
  name: string;
  /** A module registered with the store. Its tables are the ones this projector writes. */
  module: string;
  /** Exact kinds such as "task.integrated", or a prefix that ends with a dot, such as "duel.". */
  kinds: readonly string[];
  /** Runs inside the projector's own transaction, once per matching event, in `seq` order. Must be synchronous. */
  project(tx: EvidenceTx, event: RunEvent): void;
}

export type FlushResult = {
  /** True when every accepted event is in the store. False means none of this flush was stored. */
  stored: boolean;
  /** Events the store can never accept. The caller drops them when `stored` is true. */
  refused: number;
};

export type BlockReason = "definition-changed" | "cursor-ahead";

export type AdvanceResult = {
  /** Matching events projected by the projectors that committed. */
  projected: number;
  /** True when some projector still has stored events it has not seen, or cannot run. */
  pending: boolean;
  /** Projectors that cannot run until someone repairs them. Each also counts as pending. */
  blocked: { name: string; reason: BlockReason }[];
};

type Registered = {
  name: string;
  module: string;
  kinds: readonly string[];
  definition: string;
  project: (tx: EvidenceTx, event: RunEvent) => void;
};

const OUTBOX_MODULE = "event-outbox";
const MAX_PROJECTOR_KINDS = 64;
const DEFAULT_PAGE = 500;
const PROJECTOR_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Stores run events first, then runs each projector over the stored events after its own cursor.
 * A flush never waits for a projection, so an event stored before its projector existed is still projected.
 * A store has one outbox. A projector that cannot run safely is blocked for the life of this object.
 */
export class EventOutbox {
  private readonly projectors: Registered[] = [];
  private readonly blocked = new Map<string, BlockReason>();

  constructor(private readonly store: EvidenceStore) {
    if (Object.hasOwn(store.status().modules, OUTBOX_MODULE)) {
      throw new TypeError("An evidence store has one event outbox.");
    }
    store.register(this.storageModule());
  }

  /** Projectors run in registration order. Throws a TypeError for a projector the store cannot serve. */
  registerProjector(projector: EventProjector): void {
    if (!projector || typeof projector !== "object") throw new TypeError("An event projector must be an object.");
    const { name, module, kinds, project } = projector;
    if (typeof name !== "string" || !PROJECTOR_NAME.test(name) || this.projectors.some(p => p.name === name)) {
      throw new TypeError("An event projector needs a unique name of lower-case letters, digits, and hyphens.");
    }
    if (typeof module !== "string" || module === "store" || module === OUTBOX_MODULE
      || !Object.hasOwn(this.store.status().modules, module)) {
      throw new TypeError("An event projector must name a module registered with the evidence store.");
    }
    if (typeof project !== "function") throw new TypeError("An event projector needs a project function.");
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > MAX_PROJECTOR_KINDS) {
      throw new TypeError(`An event projector takes 1 to ${MAX_PROJECTOR_KINDS} kinds.`);
    }
    const copied = [...kinds];
    for (const kind of copied) {
      if (typeof kind !== "string" || !(isEventKind(kind) || isEventPrefix(kind))) {
        throw new TypeError("An event projector kind must be an event kind or a prefix ending with a dot.");
      }
    }
    this.projectors.push({
      name,
      module,
      kinds: copied,
      definition: definitionOf(module, copied),
      project: project.bind(projector),
    });
  }

  /**
   * Stores the accepted events in one write, then advances the projectors once. Never throws.
   * An unavailable store, or a write that fails, stores nothing and returns `stored: false`.
   */
  flush(events: readonly OutboxEvent[]): FlushResult {
    try {
      return this.flushEvents(events);
    } catch {
      return { stored: false, refused: 0 };
    }
  }

  /** Projects the stored events after each projector's cursor, one page per projector. Never throws. */
  advance(limit: number = DEFAULT_PAGE): AdvanceResult {
    try {
      return this.advanceProjectors(limit);
    } catch {
      return { projected: 0, pending: this.projectors.length > 0, blocked: [] };
    }
  }

  /** The outbox's own evidence module: its cursor table, and the loss count a run deletion leaves behind. */
  private storageModule(): EvidenceModule {
    return {
      name: OUTBOX_MODULE,
      version: 1,
      readVersion: 1,
      migrate(tx) {
        tx.exec(
          "CREATE TABLE IF NOT EXISTS projector_cursors (name TEXT PRIMARY KEY, seq INTEGER NOT NULL, "
          + "definition TEXT NOT NULL, lost INTEGER NOT NULL DEFAULT 0)",
        );
      },
      runIds: () => [],
      deleteRun: (tx, runId) => this.recordLoss(tx, runId),
      counts(db) {
        const row = db.get<{ projectors: number; lost: number }>(
          "SELECT count(*) AS projectors, COALESCE(SUM(lost), 0) AS lost FROM projector_cursors",
        );
        return { projectors: row?.projectors ?? 0, lost: row?.lost ?? 0 };
      },
    };
  }

  /**
   * Runs inside a run's deletion, before its events are removed. For each projector it counts the run's
   * events after the projector's cursor that the projector matches, and adds that count to `lost`.
   */
  private recordLoss(tx: EvidenceTx, runId: string): void {
    for (const projector of this.projectors) {
      const cursor = tx.get<{ seq: number }>("SELECT seq FROM projector_cursors WHERE name=?", projector.name)?.seq ?? 0;
      const unseen = tx.all<{ kind: string }>("SELECT kind FROM run_events WHERE run_id=? AND seq > ?", runId, cursor);
      const lost = unseen.filter(row => matches(projector.kinds, row.kind)).length;
      tx.run(
        "INSERT INTO projector_cursors (name, seq, definition, lost) VALUES (?, 0, ?, ?) "
        + "ON CONFLICT(name) DO UPDATE SET lost = lost + excluded.lost",
        projector.name,
        projector.definition,
        lost,
      );
    }
  }

  private flushEvents(events: readonly OutboxEvent[]): FlushResult {
    if (!Array.isArray(events)) return { stored: false, refused: 0 };
    if (events.length === 0) return { stored: true, refused: 0 };
    if (this.store.status().state !== "ready") return { stored: false, refused: 0 };

    const accepted: OutboxEvent[] = [];
    let refused = 0;
    for (const raw of events) {
      const snapshot = snapshotEvent(raw);
      if (snapshot === undefined) refused += 1;
      else accepted.push(snapshot);
    }
    if (accepted.length === 0) return { stored: true, refused };

    const stored = this.store.tryWrite(tx => {
      for (const event of accepted) this.store.appendEvent(tx, event);
    });
    if (!stored) return { stored: false, refused: 0 };
    this.advance();
    return { stored: true, refused };
  }

  private advanceProjectors(limit: number): AdvanceResult {
    if (this.projectors.length === 0) return { projected: 0, pending: false, blocked: [] };
    const status = this.store.status();
    if (status.state !== "ready") return { projected: 0, pending: true, blocked: [] };
    const page = clampPage(limit);
    let projected = 0;
    let pending = false;
    const blocked: AdvanceResult["blocked"] = [];
    for (const projector of this.projectors) {
      const held = this.blocked.get(projector.name);
      if (held !== undefined) {
        blocked.push({ name: projector.name, reason: held });
        pending = true;
        continue;
      }
      if (status.modules[projector.module] !== "ready") {
        pending = true;
        continue;
      }
      const result = this.advanceProjector(projector, page);
      projected += result.projected;
      pending = pending || result.pending;
      blocked.push(...result.blocked);
    }
    return { projected, pending, blocked };
  }

  /**
   * One write per projector. Its rows and its cursor commit together, or neither does. A projector whose
   * definition or cursor does not match the stored one is blocked, and its write is not run.
   */
  private advanceProjector(projector: Registered, page: number): AdvanceResult {
    let outcome: AdvanceResult | undefined;
    let block: BlockReason | undefined;
    const committed = this.store.tryWrite(tx => {
      const row = tx.get<{ seq: number; definition: string }>(
        "SELECT seq, definition FROM projector_cursors WHERE name=?",
        projector.name,
      );
      if (row !== undefined && row.definition !== projector.definition) {
        block = "definition-changed";
        return;
      }
      const cursor = row?.seq ?? 0;
      const highWater = tx.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='run_events'")?.seq ?? 0;
      if (cursor > highWater) {
        block = "cursor-ahead";
        return;
      }
      const read = this.store.eventsIn(tx, { after: cursor, limit: page });
      let matched = 0;
      for (const event of read.events) {
        if (!matches(projector.kinds, event.kind)) continue;
        const result: unknown = projector.project(tx, event);
        if (isThenable(result)) {
          // The write fails below. Consume the rejection so it cannot surface later as unhandled.
          result.then(undefined, () => undefined);
          throw new TypeError("An event projector must be synchronous");
        }
        matched += 1;
      }
      if (read.events.length > 0) {
        tx.run(
          "INSERT INTO projector_cursors (name, seq, definition, lost) VALUES (?, ?, ?, 0) "
          + "ON CONFLICT(name) DO UPDATE SET seq=excluded.seq",
          projector.name,
          read.cursor,
          projector.definition,
        );
      }
      outcome = { projected: matched, pending: read.more, blocked: [] };
    });
    if (block !== undefined && committed) {
      this.block(projector.name, block);
      return { projected: 0, pending: true, blocked: [{ name: projector.name, reason: block }] };
    }
    return committed && outcome ? outcome : { projected: 0, pending: true, blocked: [] };
  }

  private block(name: string, reason: BlockReason): void {
    this.blocked.set(name, reason);
    console.warn(`Event projector ${name} is blocked: ${reason}.`);
  }
}

/**
 * Copies one caller event into a value the outbox owns. Each known field is read once, and `data` is copied
 * through its canonical JSON, so later reads of the caller's object cannot change what is stored. Returns
 * undefined for an event that cannot be copied or that the store would refuse.
 */
function snapshotEvent(raw: unknown): OutboxEvent | undefined {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    const source = raw as Partial<Record<keyof OutboxEvent, unknown>>;
    const key = source.key;
    const runId = source.runId;
    const revision = source.revision;
    const at = source.at;
    const kind = source.kind;
    const memberId = source.memberId;
    const taskId = source.taskId;
    const data = JSON.parse(canonicalJson(source.data)) as Record<string, unknown>;
    const snapshot = {
      key,
      runId,
      revision,
      at,
      kind,
      data,
      ...(memberId === undefined ? {} : { memberId }),
      ...(taskId === undefined ? {} : { taskId }),
    } as OutboxEvent;
    return eventProblem(snapshot) === undefined ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

/** The identity of a projector's match: its module and its sorted kinds. A changed match is a new definition. */
function definitionOf(module: string, kinds: readonly string[]): string {
  return createHash("sha256").update(canonicalJson({ module, kinds: [...kinds].sort() }), "utf8").digest("hex");
}

function clampPage(limit: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return 1;
  return Math.min(DEFAULT_PAGE, Math.max(1, Math.floor(limit)));
}

/** A prefix ends with a dot, and adding one more segment to it gives an event kind. */
function isEventPrefix(kind: string): boolean {
  return kind.endsWith(".") && isEventKind(`${kind}x`);
}

function matches(kinds: readonly string[], kind: string): boolean {
  return kinds.some(entry => (entry.endsWith(".") ? kind.startsWith(entry) : kind === entry));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}
