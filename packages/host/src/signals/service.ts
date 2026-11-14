import { randomUUID } from "node:crypto";
import type { EvidenceStore } from "../evidence/store.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "../evidence/types.js";
import type { AppliedScan } from "../outcome-scan.js";
import { type ProjectSignal, type SignalKind, type SignalReader, signalKinds } from "./types.js";

export const SIGNALS_MODULE = "signals";
export const SIGNAL_RETENTION_DAYS = 30;
export const MAX_SIGNAL_ROWS = 20_000;
export const MAX_SIGNAL_KEY_LENGTH = 200;
export const MAX_SIGNAL_TEXT_LENGTH = 2_000;
export const DEFAULT_SIGNAL_PAGE = 50;
export const MAX_SIGNAL_PAGE = 200;

const TABLE = "project_signals";
const DAY_MS = 86_400_000;
/** After a failed read, `head()` reports the inbox unreadable for this long, then the next read tries again. */
const RETRY_MS = 5_000;
const KINDS: ReadonlySet<string> = new Set(signalKinds);
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A key is an id the source chose: printable ASCII without spaces. */
const KEY = /^[\x21-\x7e]+$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * One row per signal. `seq` never repeats, also after retention deletes rows, because the table uses AUTOINCREMENT.
 * The project is a blind index, and the dedup value is a blind index of (project, kind, key). Everything a consumer
 * reads besides the kind and the time is sealed.
 */
const SCHEMA = `
CREATE TABLE project_signals (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   TEXT NOT NULL UNIQUE,
  project_ref TEXT NOT NULL,
  kind        TEXT NOT NULL,
  dedup       TEXT NOT NULL UNIQUE,
  at          TEXT NOT NULL,
  sealed      TEXT NOT NULL
);
CREATE INDEX project_signals_by_project ON project_signals (project_ref, seq);
CREATE INDEX project_signals_by_at ON project_signals (at);
`;

/** Deletes every row older than the newest MAX_SIGNAL_ROWS. */
const CAP_SQL = `DELETE FROM project_signals WHERE seq <= (SELECT seq FROM project_signals ORDER BY seq DESC LIMIT 1 OFFSET ${MAX_SIGNAL_ROWS})`;

const HEAD_SQL = "SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name='project_signals'), 0), "
  + "coalesce((SELECT max(seq) FROM project_signals), 0)) AS seq";

const SIGNALS_EVIDENCE_MODULE: EvidenceModule = {
  name: SIGNALS_MODULE,
  version: 1,
  readVersion: 1,
  migrate(tx: EvidenceTx) {
    tx.exec(SCHEMA);
  },
  counts(db) {
    return { rows: db.get<{ n: number }>("SELECT count(*) AS n FROM project_signals")?.n ?? 0 };
  },
};

/** The sealed part of a row. The project and kind are sealed too, so a row moved to another project does not open. */
type Sealed = { projectId: string; kind: SignalKind; key: string; runId?: string; commit?: string; text?: string };
type Row = { seq: number; signal_id: string; kind: string; at: string; sealed: string };

export type SignalInput = { projectId: string; kind: SignalKind; key: string; runId?: string; commit?: string; text?: string };

/**
 * `recorded: false` with a signal is a repeat of (project, kind, key), and the signal is the one stored first.
 * Without a signal, `failure` says why nothing was recorded.
 */
export type RecordResult =
  | { recorded: true; signal: ProjectSignal }
  | { recorded: false; signal: ProjectSignal }
  | { recorded: false; failure: "invalid" | "unavailable" };

export type SignalPage = { signals: ProjectSignal[]; head: number };

export type SignalServiceOptions = { store: EvidenceStore; now?: () => number };

/**
 * The project signal inbox. A source records a fact; nothing here starts work. The head `seq` is kept in memory, so a
 * consumer whose cursor is at the head costs no database read. Recording fails soft: a source never sees a throw.
 */
export class SignalService {
  private readonly store: EvidenceStore;
  private readonly now: () => number;
  private headSeq: number | undefined;
  private retryAt = 0;
  private readonly logged = new Set<string>();

  constructor(options: SignalServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.store.register(SIGNALS_EVIDENCE_MODULE);
    this.loadHead();
  }

  /** The highest seq recorded, 0 when none, or undefined while the inbox cannot be read. */
  head(): number | undefined {
    // The status check reads memory only. A store that closed or failed after the head loaded is unreadable.
    if (this.now() < this.retryAt || !this.ready()) return undefined;
    return this.headSeq ?? this.loadHead();
  }

  record(input: SignalInput): RecordResult {
    return this.recordAll([input])[0]!;
  }

  /** Records several signals in one write, in order. A repeat inside the batch is a repeat. */
  recordAll(inputs: readonly SignalInput[]): RecordResult[] {
    const checked = inputs.map(checkInput);
    const failed = (failure: "invalid" | "unavailable") => checked.map((input): RecordResult => ({ recorded: false, failure: input ? failure : "invalid" }));
    if (!checked.some(Boolean)) return failed("invalid");
    if (!this.ready()) return failed("unavailable");
    const at = new Date(this.now()).toISOString();
    let results: RecordResult[] = [];
    const written = this.store.tryWrite(tx => {
      results = checked.map((input): RecordResult => input ? insert(tx, input, at) : { recorded: false, failure: "invalid" });
      if (results.some(result => result.recorded)) tx.run(CAP_SQL);
    });
    if (!written) return failed("unavailable");
    for (const result of results) {
      if (result.recorded) this.headSeq = Math.max(this.headSeq ?? 0, result.signal.seq);
    }
    return results;
  }

  /** Records the signals a base scan supports: its landings, its reverts, and at most one outside commit. */
  recordScan(scan: AppliedScan): RecordResult[] {
    try {
      const inputs = scanSignals(scan);
      return inputs.length === 0 ? [] : this.recordAll(inputs);
    } catch {
      this.warnOnce("Project signals from a base scan could not be recorded.");
      return [];
    }
  }

  /**
   * Signals of one project after `after`, oldest first, at most `limit`, with the head they were read at.
   * Undefined when the inbox cannot be read. A row that does not open is skipped, and the page is filled past it,
   * so a page shorter than `limit` means every readable signal up to `head` was returned.
   */
  page(projectId: string, after: number, options: { kinds?: readonly SignalKind[]; limit?: number } = {}): SignalPage | undefined {
    const head = this.head();
    if (head === undefined) return undefined;
    const limit = clampLimit(options.limit);
    const kinds = options.kinds === undefined ? undefined : [...new Set(options.kinds)].filter(kind => KINDS.has(kind));
    if (typeof projectId !== "string" || !Number.isSafeInteger(after) || after < 0 || after >= head || kinds?.length === 0) {
      return { signals: [], head };
    }
    try {
      const signals = this.store.read(db => readPage(db, projectId, after, kinds, limit, () => this.warnOnce("A project signal could not be opened.")));
      return { signals, head };
    } catch {
      this.unreadable();
      return undefined;
    }
  }

  /** The consumer view. Both calls are synchronous and never throw. */
  reader(): SignalReader {
    return {
      head: () => {
        try { return this.head(); } catch { return undefined; }
      },
      after: (projectId, seq, options) => {
        try { return this.page(projectId, seq, options)?.signals ?? []; } catch { return []; }
      },
    };
  }

  /** Deletes signals older than the retention and rows past the row cap. Runs on the hourly evidence sweep. */
  sweep(): void {
    if (!this.ready()) return;
    const cutoff = new Date(this.now() - SIGNAL_RETENTION_DAYS * DAY_MS).toISOString();
    this.store.tryWrite(tx => {
      tx.run("DELETE FROM project_signals WHERE at < ?", cutoff);
      tx.run(CAP_SQL);
    });
  }

  private ready(): boolean {
    return this.store.status().modules[SIGNALS_MODULE] === "ready";
  }

  private loadHead(): number | undefined {
    if (!this.ready()) {
      this.unreadable();
      return undefined;
    }
    try {
      const row = this.store.read(db => db.get<{ seq: number | null }>(HEAD_SQL));
      this.headSeq = Number(row?.seq ?? 0);
      return this.headSeq;
    } catch {
      this.unreadable();
      return undefined;
    }
  }

  private unreadable(): void {
    this.retryAt = this.now() + RETRY_MS;
  }

  private warnOnce(line: string): void {
    if (this.logged.has(line)) return;
    this.logged.add(line);
    console.warn(line);
  }
}

/**
 * The signals one recorded scan supports. A landing gives `delivery-landed` and a revert gives `revert`, each keyed by
 * the ledger's own signal id. An outside commit gives one `external-commit` keyed by the new head (see `outsideCommit`).
 */
export function scanSignals(scan: AppliedScan): SignalInput[] {
  const inputs: SignalInput[] = [];
  for (const signal of scan.recorded) {
    inputs.push({
      projectId: scan.projectId,
      kind: signal.kind === "landing" ? "delivery-landed" : "revert",
      key: signal.signalId,
      runId: signal.runId,
      commit: signal.commit,
    });
  }
  if (outsideCommit(scan)) inputs.push({ projectId: scan.projectId, kind: "external-commit", key: scan.head, commit: scan.head });
  return inputs;
}

/**
 * Whether the scan proves a new base commit that is neither a landing nor a revert it attributed to a team run of the
 * project. Only a continuous scan knows which commits are new. A landing commit with fewer than two parents (a squash, a
 * rebase, or a fast-forward) may be the last of several commits of the same run, so only commits after the last such
 * landing count. A merge's own commits sit behind its second parent and are not in the list.
 */
export function outsideCommit(scan: Pick<AppliedScan, "continuous" | "commits" | "landings" | "reverts">): boolean {
  if (!scan.continuous || scan.commits.length === 0) return false;
  const attributed = new Set<string>([...scan.landings.map(landing => landing.commit), ...scan.reverts.map(revert => revert.commit)]);
  let from = 0;
  for (const landing of scan.landings) {
    const commit = scan.commits[landing.position];
    if (commit === undefined || commit.id !== landing.commit || commit.parents.length < 2) from = Math.max(from, landing.position + 1);
  }
  return scan.commits.slice(from).some(commit => !attributed.has(commit.id));
}

function checkInput(input: SignalInput): Sealed | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { projectId, kind, key, runId, commit, text } = input;
  const valid = typeof projectId === "string" && PROJECT_ID.test(projectId)
    && typeof kind === "string" && KINDS.has(kind)
    && typeof key === "string" && key.length <= MAX_SIGNAL_KEY_LENGTH && KEY.test(key)
    && (runId === undefined || (typeof runId === "string" && RUN_ID.test(runId)))
    && (commit === undefined || (typeof commit === "string" && COMMIT.test(commit)))
    // Text comes from the owner only, so only the owner kind carries it, and it always does.
    && (kind === "owner"
      ? typeof text === "string" && text.trim().length > 0 && text.length <= MAX_SIGNAL_TEXT_LENGTH
      : text === undefined);
  if (!valid) return undefined;
  return {
    projectId, kind, key,
    ...(runId === undefined ? {} : { runId }),
    ...(commit === undefined ? {} : { commit }),
    ...(text === undefined ? {} : { text }),
  };
}

function insert(tx: EvidenceTx, input: Sealed, at: string): RecordResult {
  const dedup = tx.index("signal", `${input.projectId}\u0000${input.kind}\u0000${input.key}`);
  const prior = tx.get<Row>("SELECT seq, signal_id, kind, at, sealed FROM project_signals WHERE dedup=?", dedup);
  if (prior !== undefined) {
    const signal = openSignal(tx, prior, input.projectId);
    return signal ? { recorded: false, signal } : { recorded: false, failure: "unavailable" };
  }
  const id = randomUUID();
  const result = tx.run(
    "INSERT INTO project_signals (signal_id, project_ref, kind, dedup, at, sealed) VALUES (?, ?, ?, ?, ?, ?)",
    id, tx.index("project", input.projectId), input.kind, dedup, at, tx.seal(TABLE, id, input),
  );
  return { recorded: true, signal: toSignal(result.lastInsertRowid, id, at, input) };
}

function readPage(
  db: EvidenceDb,
  projectId: string,
  after: number,
  kinds: readonly SignalKind[] | undefined,
  limit: number,
  skipped: () => void,
): ProjectSignal[] {
  const ref = db.index("project", projectId);
  const kindFilter = kinds === undefined ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const signals: ProjectSignal[] = [];
  let cursor = after;
  while (signals.length < limit) {
    const want = limit - signals.length;
    const rows = db.all<Row>(
      `SELECT seq, signal_id, kind, at, sealed FROM project_signals WHERE project_ref=? AND seq>?${kindFilter} ORDER BY seq LIMIT ?`,
      ref, cursor, ...(kinds ?? []), want,
    );
    for (const row of rows) {
      const signal = openSignal(db, row, projectId);
      if (signal) signals.push(signal);
      else skipped();
      cursor = row.seq;
    }
    if (rows.length < want) break;
  }
  return signals;
}

function openSignal(db: EvidenceDb, row: Row, projectId: string): ProjectSignal | undefined {
  try {
    const sealed = db.open<Sealed>(TABLE, row.signal_id, row.sealed);
    if (sealed.projectId !== projectId || sealed.kind !== row.kind || typeof sealed.key !== "string") return undefined;
    return toSignal(row.seq, row.signal_id, row.at, sealed);
  } catch {
    return undefined;
  }
}

function toSignal(seq: number, id: string, at: string, sealed: Sealed): ProjectSignal {
  return {
    seq, id, projectId: sealed.projectId, kind: sealed.kind, key: sealed.key, at,
    ...(sealed.runId === undefined ? {} : { runId: sealed.runId }),
    ...(sealed.commit === undefined ? {} : { commit: sealed.commit }),
    ...(sealed.text === undefined ? {} : { text: sealed.text }),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== "number" || Number.isNaN(limit)) return DEFAULT_SIGNAL_PAGE;
  return Math.min(MAX_SIGNAL_PAGE, Math.max(1, Math.floor(limit)));
}
