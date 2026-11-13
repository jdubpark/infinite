import type { TeamMember, TeamRole, TeamRun } from "../team-types.js";
import { canonicalJson } from "./crypto.js";
import { ENTRY_KINDS, type EntryHead, type EntryKind, type HostEntry, type HostEntryKind } from "./entry-types.js";
import { hostEntry, hostEntryId, hostEntrySources } from "./host-entries.js";
import type { EvidenceStore } from "./store.js";
import { EvidenceError, type EvidenceDb, type EvidenceModule, type EvidenceTx } from "./types.js";

export const BLACKBOARD_MODULE = "blackboard";
/** A host body larger than this is refused whole, never truncated (plan, phase 2). */
export const MAX_HOST_BODY_BYTES = 1024 * 1024;
export const MIRROR_BATCH = 64;
export const MIRROR_RETRY_MS = 60_000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_KINDS = 8;

export type EntryQuery = { kinds?: EntryKind[]; taskId?: string; since?: number; limit?: number };
export type EntryPage = { entries: EntryHead[]; cursor: number; more: boolean };
export type LaunchSizes = { launchSeq: number | undefined; promptBytes: number; contextBytes: number };
export type MemberContextUsage = {
  memberId: string;
  role: TeamRole;
  launchSeq: number;
  promptBytes: number;
  contextBytes: number;
  digestBytes: number;
  servedBytes: number;
  listCalls: number;
  getCalls: number;
};

type Known = "stored" | "refused";
type Pending = { id: string; entry: HostEntry; json: string };
type EntryRow = {
  seq: number;
  entry_id: string;
  scope: string;
  run_id: string;
  revision: number;
  at: string;
  kind: string;
  author: string;
  authority: string;
  state: string;
  body_bytes: number;
  encrypted_head: string;
};
type SealedHead = { taskId?: string; authorRole?: TeamRole | "mission-coordinator"; paths: string[]; summary: string };
type ScopeRow = {
  member_id: string;
  role: string;
  launch_seq: number;
  prompt_bytes: number;
  context_bytes: number;
  digest_bytes: number;
  served_bytes: number;
  list_calls: number;
  get_calls: number;
};

const HEAD_COLUMNS = "seq, entry_id, scope, run_id, revision, at, kind, author, authority, state, body_bytes, encrypted_head";

const SCHEMA = [
  "CREATE TABLE entries ("
  + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
  + "entry_id TEXT NOT NULL UNIQUE, "
  + "scope TEXT NOT NULL, "
  + "run_id TEXT NOT NULL, "
  + "mission_id TEXT, "
  + "revision INTEGER NOT NULL, "
  + "at TEXT NOT NULL, "
  + "kind TEXT NOT NULL, "
  + "author TEXT NOT NULL, "
  + "authority TEXT NOT NULL, "
  + "author_member_id TEXT, "
  + "task_key TEXT, "
  + "state TEXT NOT NULL DEFAULT 'active', "
  + "body_bytes INTEGER NOT NULL, "
  + "encrypted_head TEXT NOT NULL, "
  + "encrypted_body TEXT)",
  "CREATE INDEX entries_by_run ON entries (run_id, seq)",
  "CREATE INDEX entries_by_task ON entries (run_id, task_key, seq)",
  "CREATE INDEX entries_by_mission ON entries (mission_id, seq) WHERE mission_id IS NOT NULL",
  "CREATE TABLE member_scopes ("
  + "member_id TEXT PRIMARY KEY, "
  + "run_id TEXT NOT NULL, "
  + "mission_id TEXT, "
  + "role TEXT NOT NULL, "
  + "launch_seq INTEGER NOT NULL, "
  + "prompt_bytes INTEGER NOT NULL, "
  + "context_bytes INTEGER NOT NULL, "
  + "digest_bytes INTEGER NOT NULL, "
  + "served_bytes INTEGER NOT NULL DEFAULT 0, "
  + "list_calls INTEGER NOT NULL DEFAULT 0, "
  + "get_calls INTEGER NOT NULL DEFAULT 0, "
  + "encrypted_scope TEXT NOT NULL)",
  "CREATE INDEX member_scopes_by_run ON member_scopes (run_id)",
];

/**
 * Host-written entries and member launch sizes in the shared evidence store. The host mirrors each entry
 * from a saved run record, after the record is written. Entry bodies and heads are sealed. Plain columns
 * hold only opaque ids, enumerations, numbers, and times. Nothing here changes a run.
 */
export class Blackboard {
  private readonly now: () => number;
  private readonly known = new Map<string, Map<string, Known>>();
  private readonly failedAt = new Map<string, number>();
  private lastFailedAt: number | undefined;
  private readonly warned = new Set<HostEntryKind>();
  private refused = 0;

  /** Registers the `blackboard` module. Throws a TypeError when the store already has one. */
  constructor(private readonly store: EvidenceStore, options: { now?: () => number } = {}) {
    if (Object.hasOwn(store.status().modules, BLACKBOARD_MODULE)) {
      throw new TypeError("An evidence store has one blackboard.");
    }
    this.now = options.now ?? (() => Date.now());
    store.register(this.storageModule());
  }

  /**
   * Stores every host entry of the run that is not stored yet, at most MIRROR_BATCH builds per call.
   * True when no source of the run is left to store: each one is stored or was refused. Never throws.
   */
  mirror(run: TeamRun): boolean {
    try {
      return this.mirrorRun(run);
    } catch {
      return false;
    }
  }

  /** False when the store is not ready, or when a write of this blackboard failed under a minute ago. Never throws. */
  writable(): boolean {
    try {
      return this.ready() && !this.recent(this.lastFailedAt, this.now());
    } catch {
      return false;
    }
  }

  /** The highest entry seq of the run, 0 when it has none. Undefined when the store, the module, or the read fails. */
  launchMark(runId: string): number | undefined {
    try {
      if (!this.ready()) return undefined;
      return this.store.read(db => db.get<{ seq: number }>(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM entries WHERE run_id=?",
        runId,
      )?.seq ?? 0);
    } catch {
      return undefined;
    }
  }

  /** Records one member's launch sizes, keeping its read counters. False when nothing is written. Never throws. */
  recordLaunch(run: TeamRun, member: TeamMember, sizes: LaunchSizes): boolean {
    try {
      const launchSeq = sizes.launchSeq;
      if (!this.ready() || !isRunShape(run) || launchSeq === undefined) return false;
      if (![launchSeq, sizes.promptBytes, sizes.contextBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
        return false;
      }
      // A run whose last write failed under a minute ago waits, so a locked database costs one failed write
      // per run per minute, launches included.
      const time = this.now();
      if (this.recent(this.failedAt.get(run.id), time)) return false;
      const scope = {
        ...(member.taskId === undefined ? {} : { taskId: member.taskId }),
        paths: ownedPaths(run, member),
      };
      const written = this.store.tryWrite(tx => {
        tx.run(
          "INSERT INTO member_scopes (member_id, run_id, mission_id, role, launch_seq, prompt_bytes, context_bytes, "
          + "digest_bytes, encrypted_scope) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) "
          + "ON CONFLICT(member_id) DO UPDATE SET launch_seq=excluded.launch_seq, prompt_bytes=excluded.prompt_bytes, "
          + "context_bytes=excluded.context_bytes, digest_bytes=0, encrypted_scope=excluded.encrypted_scope",
          member.memberId,
          run.id,
          run.missionId ?? null,
          member.role,
          launchSeq,
          sizes.promptBytes,
          sizes.contextBytes,
          tx.seal("member_scopes", member.memberId, scope),
        );
      });
      if (!written) this.failed(run.id, time);
      return written;
    } catch {
      return false;
    }
  }

  /** One page of the run's entry heads in `seq` order. Throws EvidenceError `unavailable` when the store is not ready. */
  list(runId: string, query: EntryQuery = {}): EntryPage {
    this.requireReady();
    const limit = clampLimit(query.limit);
    const since = query.since ?? 0;
    if (!Number.isSafeInteger(since) || since < 0) throw new TypeError("An entry cursor must be a non-negative integer.");
    const kinds = query.kinds ?? [];
    if (!Array.isArray(kinds) || kinds.length > MAX_QUERY_KINDS || !kinds.every(isEntryKind)) {
      throw new TypeError(`An entry query takes at most ${MAX_QUERY_KINDS} known kinds.`);
    }
    return this.store.read(db => {
      const where = ["run_id=?", "seq > ?"];
      const params: (string | number)[] = [runId, since];
      if (kinds.length > 0) {
        where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
        params.push(...kinds);
      }
      if (query.taskId !== undefined) {
        where.push("task_key=?");
        params.push(db.index("task", query.taskId));
      }
      const rows = db.all<EntryRow>(
        `SELECT ${HEAD_COLUMNS} FROM entries WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`,
        ...params,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      return {
        entries: page.map(row => headOf(db, row)),
        cursor: page.length > 0 ? page[page.length - 1].seq : since,
        more: rows.length > limit,
      };
    });
  }

  /** One entry of the run, or undefined. Another run's entry is undefined. Throws when the store is not ready. */
  get(runId: string, entryId: string): { head: EntryHead; body: unknown } | undefined {
    this.requireReady();
    return this.store.read(db => {
      const row = db.get<EntryRow>(`SELECT ${HEAD_COLUMNS} FROM entries WHERE run_id=? AND entry_id=?`, runId, entryId);
      if (row === undefined) return undefined;
      const stored = db.get<{ encrypted_body: string | null }>(
        "SELECT encrypted_body FROM entries WHERE entry_id=? AND run_id=?",
        entryId,
        runId,
      );
      if (stored?.encrypted_body == null) return undefined;
      return { head: headOf(db, row), body: db.open("entries", `${entryId}:body`, stored.encrypted_body) };
    });
  }

  /** The run's launch sizes in first-launch order. Throws when the store is not ready. */
  contextUsage(runId: string): MemberContextUsage[] {
    this.requireReady();
    return this.store.read(db => db.all<ScopeRow>(
      "SELECT member_id, role, launch_seq, prompt_bytes, context_bytes, digest_bytes, served_bytes, list_calls, get_calls "
      + "FROM member_scopes WHERE run_id=? ORDER BY rowid",
      runId,
    ).map(row => ({
      memberId: row.member_id,
      role: row.role as TeamRole,
      launchSeq: row.launch_seq,
      promptBytes: row.prompt_bytes,
      contextBytes: row.context_bytes,
      digestBytes: row.digest_bytes,
      servedBytes: row.served_bytes,
      listCalls: row.list_calls,
      getCalls: row.get_calls,
    })));
  }

  private mirrorRun(run: TeamRun): boolean {
    if (!this.ready() || !isRunShape(run)) return false;
    const runId = run.id;
    const time = this.now();
    if (this.recent(this.failedAt.get(runId), time)) return false;

    let known = this.known.get(runId);
    if (known === undefined) {
      known = new Map(this.storedEntryIds(runId).map(id => [id, "stored" as const]));
      this.known.set(runId, known);
    }

    const at = new Date(time).toISOString();
    const pending: Pending[] = [];
    let builds = 0;
    for (const source of hostEntrySources(run)) {
      const kind = kindOf(source);
      const id = hostEntryId(runId, kind, source);
      if (known.get(id) !== undefined) continue;
      if (builds >= MIRROR_BATCH) continue;
      builds += 1;
      const built = this.build(run, source, at, kind);
      if (built === undefined) known.set(id, "refused");
      else pending.push({ id, ...built });
    }

    if (pending.length > 0) {
      const written = this.store.tryWrite(tx => {
        for (const item of pending) this.insert(tx, item);
      });
      if (!written) {
        this.failed(runId, time);
        return false;
      }
      this.failedAt.delete(runId);
      for (const item of pending) known.set(item.id, "stored");
    }

    // A refused source counts as done: the same body would be refused again.
    return hostEntrySources(run).every(source => known.get(hostEntryId(runId, kindOf(source), source)) !== undefined);
  }

  /** True while a failure at `failedAt` is under a minute old. A clock that moved back ends the wait. */
  private recent(failedAt: number | undefined, time: number): boolean {
    return failedAt !== undefined && time >= failedAt && time - failedAt < MIRROR_RETRY_MS;
  }

  /** A failed write holds back the run for a minute, and marks the store as not writable for the same time. */
  private failed(runId: string, time: number): void {
    this.failedAt.set(runId, time);
    this.lastFailedAt = time;
  }

  /** The built entry and its canonical body, or undefined when the body cannot be stored. Refusals are counted. */
  private build(run: TeamRun, source: string, at: string, kind: HostEntryKind): { entry: HostEntry; json: string } | undefined {
    let entry: HostEntry | undefined;
    let json: string;
    try {
      entry = hostEntry(run, source, at);
      if (entry === undefined) {
        this.refuse(kind, "unserializable");
        return undefined;
      }
      json = canonicalJson(entry.body);
    } catch {
      this.refuse(kind, "unserializable");
      return undefined;
    }
    if (Buffer.byteLength(json, "utf8") > MAX_HOST_BODY_BYTES) {
      this.refuse(kind, "oversized");
      return undefined;
    }
    return { entry, json };
  }

  private refuse(kind: HostEntryKind, reason: "oversized" | "unserializable"): void {
    this.refused += 1;
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    console.warn(`Blackboard refused an ${reason} ${kind} entry.`);
  }

  private insert(tx: EvidenceTx, item: Pending): void {
    const { entry } = item;
    const head: SealedHead = {
      ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      ...(entry.authorRole === undefined ? {} : { authorRole: entry.authorRole }),
      paths: [],
      summary: entry.summary,
    };
    tx.run(
      "INSERT INTO entries (entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, author_member_id, "
      + "task_key, state, body_bytes, encrypted_head, encrypted_body) "
      + "VALUES (?, 'run', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?) ON CONFLICT(entry_id) DO NOTHING",
      item.id,
      entry.runId,
      entry.missionId ?? null,
      entry.revision,
      entry.at,
      entry.kind,
      entry.author,
      entry.authority,
      entry.authorMemberId ?? null,
      entry.taskId === undefined ? null : tx.index("task", entry.taskId),
      Buffer.byteLength(item.json, "utf8"),
      tx.seal("entries", `${item.id}:head`, head),
      tx.seal("entries", `${item.id}:body`, entry.body),
    );
  }

  private storedEntryIds(runId: string): string[] {
    return this.store.read(db => db.all<{ entry_id: string }>(
      "SELECT entry_id FROM entries WHERE run_id=?",
      runId,
    ).map(row => row.entry_id));
  }

  private ready(): boolean {
    const status = this.store.status();
    return status.state === "ready" && status.modules[BLACKBOARD_MODULE] === "ready";
  }

  private requireReady(): void {
    if (!this.ready()) throw new EvidenceError("unavailable", "The blackboard is unavailable.");
  }

  /** Its tables, and the hooks that delete a run's rows, list its runs, and count its rows. */
  private storageModule(): EvidenceModule {
    return {
      name: BLACKBOARD_MODULE,
      version: 1,
      readVersion: 1,
      migrate(tx, from) {
        if (from >= 1) return;
        for (const statement of SCHEMA) tx.exec(statement);
      },
      deleteRun: (tx, runId) => {
        tx.run("DELETE FROM entries WHERE run_id=?", runId);
        tx.run("DELETE FROM member_scopes WHERE run_id=?", runId);
        this.known.delete(runId);
        this.failedAt.delete(runId);
      },
      runIds: db => db.all<{ run_id: string }>(
        "SELECT run_id FROM entries UNION SELECT run_id FROM member_scopes",
      ).map(row => row.run_id),
      counts: db => ({
        entries: db.get<{ n: number }>("SELECT count(*) AS n FROM entries")?.n ?? 0,
        scopes: db.get<{ n: number }>("SELECT count(*) AS n FROM member_scopes")?.n ?? 0,
        refused: this.refused,
      }),
    };
  }
}

/** Heads come from the plain columns and the sealed head. A head whose seal fails throws. */
function headOf(db: EvidenceDb, row: EntryRow): EntryHead {
  const sealed = db.open<SealedHead>("entries", `${row.entry_id}:head`, row.encrypted_head);
  return {
    entryId: row.entry_id,
    seq: row.seq,
    scope: row.scope as EntryHead["scope"],
    runId: row.run_id,
    revision: row.revision,
    at: row.at,
    kind: row.kind as EntryKind,
    author: row.author as EntryHead["author"],
    authority: row.authority as EntryHead["authority"],
    ...(sealed.authorRole === undefined ? {} : { authorRole: sealed.authorRole }),
    ...(sealed.taskId === undefined ? {} : { taskId: sealed.taskId }),
    paths: sealed.paths,
    summary: sealed.summary,
    bodyBytes: row.body_bytes,
    state: row.state as EntryHead["state"],
  };
}

function kindOf(source: string): HostEntryKind {
  const prefix = source.slice(0, source.indexOf(":"));
  if (prefix === "steering" || prefix === "answer") return "direction";
  return prefix as HostEntryKind;
}

function ownedPaths(run: TeamRun, member: TeamMember): string[] {
  if (member.taskId === undefined) return [];
  const task = run.tasks.find(item => item.id === member.taskId);
  return task === undefined ? [] : [...task.paths];
}

/** The fields the mirror reads must be arrays. Anything else is not a run record. */
function isRunShape(run: TeamRun): boolean {
  return typeof run === "object" && run !== null && typeof run.id === "string" && run.id.length > 0
    && Array.isArray(run.members) && Array.isArray(run.checks) && Array.isArray(run.steering)
    && Array.isArray(run.decisions) && Array.isArray(run.tasks);
}

function isEntryKind(value: unknown): value is EntryKind {
  return typeof value === "string" && (ENTRY_KINDS as readonly string[]).includes(value);
}

function clampLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (typeof value !== "number" || Number.isNaN(value)) return 1;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}
