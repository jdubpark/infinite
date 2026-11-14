import type { TeamMember, TeamRole, TeamRun } from "../team-types.js";
import { canonicalJson } from "./crypto.js";
import { ENTRY_KINDS, MEMBER_ENTRY_KINDS, type EntryHead, type EntryKind, type HostEntry, type HostEntryKind } from "./entry-types.js";
import { hostEntry, hostEntryId, hostEntrySources } from "./host-entries.js";
import { memberEntryId, memberScopeOf, postAllowed, type MemberEntryEnvelope, type MemberEntryPost } from "./member-entry.js";
import type { EvidenceStore } from "./store.js";
import { EvidenceError, type EvidenceDb, type EvidenceModule, type EvidenceTx } from "./types.js";

export const BLACKBOARD_MODULE = "blackboard";
/** The layout this host writes. Version 2 adds `entries.supersedes` and `member_scopes.read_seq`. */
export const BLACKBOARD_VERSION = 2;
/** Raised only when a reader must change. Version 2 is the first layout a member-tools reader may open. */
export const BLACKBOARD_READ_VERSION = 2;
/** A host body larger than this is refused whole, never truncated (plan, phase 2). */
export const MAX_HOST_BODY_BYTES = 1024 * 1024;
export const MIRROR_BATCH = 64;
export const MIRROR_RETRY_MS = 60_000;
/** Member entries one run may hold. Posts past it are dropped at ingest and counted (spec part 4). */
export const MAX_MEMBER_ENTRIES = 400;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_KINDS = 8;

export type EntryQuery = { kinds?: EntryKind[]; taskId?: string; since?: number; limit?: number };
export type EntryPage = { entries: EntryHead[]; cursor: number; more: boolean };
/** One journaled member post, as the worker's `team-entry` event holds it. The host checks it again before it stores it. */
export type MemberPostRecord = { seq: number; at: string; envelope: Extract<MemberEntryEnvelope, { op: "post" }> };
/** One journaled read receipt of a member: a list or a get call, and the bytes it served. */
export type MemberReadRecord = { seq: number; op: "list" | "get"; servedBytes: number };
export type IngestOutcome = { result: "stored" | "unready" | "held" | "failed"; stored: number; dropped: number; invalid: number };
export type LaunchSizes = { launchSeq: number | undefined; promptBytes: number; contextBytes: number; digestBytes?: number };
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
/** `done`: nothing is left to store. `more`: sources remain. `held`: the run waits out a failed write. */
type MirrorResult = "done" | "more" | "held" | "failed" | "invalid" | "unready";
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
  supersedes: string | null;
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

/** The member kinds as SQL text. A report is a member's entry too, but it is a host kind, so the cap counts by kind. */
const MEMBER_KIND_SQL = MEMBER_ENTRY_KINDS.map(kind => `'${kind}'`).join(", ");

const HEAD_COLUMNS ="seq, entry_id, scope, run_id, revision, at, kind, author, authority, state, body_bytes, supersedes, encrypted_head";

/** Version 1: the tables of phase 2. */
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

/** Version 2: the member supersede column and the receipt cursor. Version 1 rows keep their values. */
const SCHEMA_V2 = [
  "ALTER TABLE entries ADD COLUMN supersedes TEXT",
  "CREATE INDEX entries_by_supersedes ON entries (supersedes) WHERE supersedes IS NOT NULL",
  "ALTER TABLE member_scopes ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0",
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
  private readonly unreadAt = new Map<string, number>();
  private retryFailedAt: number | undefined;
  private readonly warned = new Set<HostEntryKind>();
  private refused = 0;
  private dropped = 0;
  private invalid = 0;

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
      // A save has just written the record, so an earlier failed read of it says nothing now.
      this.unreadAt.delete(run.id);
      return this.mirrorRun(run) === "done";
    } catch {
      return false;
    }
  }

  /**
   * `mirror` for the retry pass. `done`: nothing is left to store, or the value is not a run record, so a retry
   * cannot help. `more`: sources remain (a batch limit, a held run, a store that is not ready). `failed`: a write
   * was tried now and failed, or the pass threw. Only `failed` starts the retry pause. Never throws.
   */
  retry(run: TeamRun): "done" | "more" | "failed" {
    try {
      const result = this.mirrorRun(run);
      if (result === "done" || result === "invalid") return "done";
      if (result !== "failed") return "more";
    } catch {
      // A pass that throws would throw again at once, so it pauses like a failed write.
    }
    this.retryFailedAt = this.now();
    return "failed";
  }

  /** False when the store is not ready, or when a retry failed under a minute ago. Never throws. */
  retryable(): boolean {
    try {
      return this.ready() && !this.recent(this.retryFailedAt, this.now());
    } catch {
      return false;
    }
  }

  /** True while the run's last failed write is under a minute old: a write for it would not be tried. Never throws. */
  held(runId: string): boolean {
    try {
      return this.recent(this.failedAt.get(runId), this.now());
    } catch {
      return false;
    }
  }

  /**
   * Notes that the caller could not read the run's saved record now. It holds no write back: only `unread` reports
   * it, so the retry pass can leave the record alone for a minute. Never throws.
   */
  noteUnread(runId: string): void {
    try {
      this.unreadAt.set(runId, this.now());
    } catch {
      // Without a time the next pass reads the record again.
    }
  }

  /** True while the run's record could not be read under a minute ago. Never throws. */
  unread(runId: string): boolean {
    try {
      const at = this.unreadAt.get(runId);
      if (at === undefined) return false;
      if (this.recent(at, this.now())) return true;
      this.unreadAt.delete(runId);
      return false;
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
      const digestBytes = sizes.digestBytes ?? 0;
      if (![launchSeq, sizes.promptBytes, sizes.contextBytes, digestBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
        return false;
      }
      // A run whose last write failed under a minute ago waits, so a locked database costs one failed write
      // per run per minute, launches included.
      const time = this.now();
      if (this.recent(this.failedAt.get(run.id), time)) return false;
      const planned = memberScopeOf(run, member, launchSeq);
      const scope = {
        ...(planned.taskId === undefined ? {} : { taskId: planned.taskId }),
        paths: planned.paths,
        ...(planned.dependsOn.length > 0 ? { dependsOn: planned.dependsOn } : {}),
      };
      const written = this.store.tryWrite(tx => {
        tx.run(
          "INSERT INTO member_scopes (member_id, run_id, mission_id, role, launch_seq, prompt_bytes, context_bytes, "
          + "digest_bytes, encrypted_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
          + "ON CONFLICT(member_id) DO UPDATE SET launch_seq=excluded.launch_seq, prompt_bytes=excluded.prompt_bytes, "
          + "context_bytes=excluded.context_bytes, digest_bytes=excluded.digest_bytes, encrypted_scope=excluded.encrypted_scope",
          member.memberId,
          run.id,
          run.missionId ?? null,
          member.role,
          launchSeq,
          sizes.promptBytes,
          sizes.contextBytes,
          digestBytes,
          tx.seal("member_scopes", member.memberId, scope),
        );
      });
      if (!written) this.failedAt.set(run.id, time);
      return written;
    } catch {
      return false;
    }
  }

  /** True when the store and the module are ready. Never throws. */
  available(): boolean {
    try {
      return this.ready();
    } catch {
      return false;
    }
  }

  /**
   * Stores one journal page of a member: its posts, then the receipts of its reads, in one write. Each post is
   * checked again against the member record, and a post that fails a check stores nothing and counts as invalid.
   * Stored states depend only on the set of stored posts, so the order of a page does not matter. Never throws.
   */
  ingest(run: TeamRun, member: TeamMember, posts: readonly MemberPostRecord[], reads: readonly MemberReadRecord[]): IngestOutcome {
    const failed: IngestOutcome = { result: "failed", stored: 0, dropped: 0, invalid: 0 };
    try {
      if (!this.ready() || !isRunShape(run)) return { ...failed, result: "unready" };
      const time = this.now();
      if (this.recent(this.failedAt.get(run.id), time)) return { ...failed, result: "held" };
      if (posts.length === 0 && reads.length === 0) return { ...failed, result: "stored" };

      const counts = { stored: 0, dropped: 0, invalid: 0 };
      const written = this.store.tryWrite(tx => {
        counts.stored = 0;
        counts.dropped = 0;
        counts.invalid = 0;
        let members = tx.get<{ n: number }>(
          `SELECT count(*) AS n FROM entries WHERE run_id=? AND kind IN (${MEMBER_KIND_SQL})`,
          run.id,
        )?.n ?? 0;
        for (const record of posts) {
          const entry = checkedPost(run, member, record);
          if (entry === undefined) {
            counts.invalid += 1;
          } else if (tx.get("SELECT 1 AS n FROM entries WHERE entry_id=?", record.envelope.requestId) !== undefined) {
            counts.stored += 1;
          } else if (members >= MAX_MEMBER_ENTRIES) {
            counts.dropped += 1;
          } else {
            this.insertMember(tx, run, member, record, entry);
            members += 1;
            counts.stored += 1;
          }
        }
        recordReads(tx, run.id, member.memberId, reads);
      });
      if (!written) {
        this.failedAt.set(run.id, time);
        return failed;
      }
      this.failedAt.delete(run.id);
      this.dropped += counts.dropped;
      this.invalid += counts.invalid;
      return { result: "stored", ...counts };
    } catch {
      return failed;
    }
  }

  /**
   * The owner's withdrawal of one entry of a run. The body stays, so the owner still reads the entry. Returns
   * undefined when the run holds no such entry. Throws EvidenceError `unavailable` when the store is not ready or the write fails.
   */
  withdraw(runId: string, entryId: string): "withdrawn" | "unchanged" | undefined {
    this.requireReady();
    const outcome: { value: "withdrawn" | "unchanged" | undefined } = { value: undefined };
    const written = this.store.tryWrite(tx => {
      const row = tx.get<{ state: string }>("SELECT state FROM entries WHERE run_id=? AND entry_id=?", runId, entryId);
      if (row === undefined) return;
      if (row.state === "withdrawn") {
        outcome.value = "unchanged";
        return;
      }
      tx.run("UPDATE entries SET state='withdrawn' WHERE run_id=? AND entry_id=?", runId, entryId);
      outcome.value = "withdrawn";
    });
    if (!written) throw new EvidenceError("unavailable", "The blackboard is unavailable.");
    return outcome.value;
  }

  /** Writes one member row, then applies the supersede rules to it. The caller has checked the post. */
  private insertMember(tx: EvidenceTx, run: TeamRun, member: TeamMember, record: MemberPostRecord, entry: MemberEntryPost): void {
    const id = record.envelope.requestId;
    const head: SealedHead = {
      ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      authorRole: member.role,
      paths: entry.paths,
      summary: entry.summary,
    };
    const supersedes = "supersedes" in entry ? entry.supersedes ?? null : null;
    const inserted = tx.run(
      "INSERT INTO entries (entry_id, scope, run_id, mission_id, revision, at, kind, author, authority, author_member_id, "
      + "task_key, state, body_bytes, supersedes, encrypted_head, encrypted_body) "
      + "VALUES (?, 'run', ?, ?, ?, ?, ?, 'member', 'claim', ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(entry_id) DO NOTHING",
      id,
      run.id,
      run.missionId ?? null,
      member.revision,
      record.at,
      entry.kind,
      member.memberId,
      entry.taskId === undefined ? null : tx.index("task", entry.taskId),
      Buffer.byteLength(canonicalJson(entry.body), "utf8"),
      supersedes,
      tx.seal("entries", `${id}:head`, head),
      tx.seal("entries", `${id}:body`, entry.body),
    );
    if (inserted.changes === 1) settleSupersedes(tx, run.id, id);
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

  private mirrorRun(run: TeamRun): MirrorResult {
    if (!this.ready()) return "unready";
    if (!isRunShape(run)) return "invalid";
    const runId = run.id;
    const time = this.now();
    if (this.recent(this.failedAt.get(runId), time)) return "held";

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
        this.failedAt.set(runId, time);
        return "failed";
      }
      this.failedAt.delete(runId);
      for (const item of pending) known.set(item.id, "stored");
    }

    // A refused source counts as done: the same body would be refused again.
    return hostEntrySources(run).every(source => known.get(hostEntryId(runId, kindOf(source), source)) !== undefined) ? "done" : "more";
  }

  /** True while a failure at `failedAt` is under a minute old. A clock that moved back ends the wait. */
  private recent(failedAt: number | undefined, time: number): boolean {
    return failedAt !== undefined && time >= failedAt && time - failedAt < MIRROR_RETRY_MS;
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
      version: BLACKBOARD_VERSION,
      readVersion: BLACKBOARD_READ_VERSION,
      migrate(tx, from) {
        if (from < 1) for (const statement of SCHEMA) tx.exec(statement);
        if (from < 2) for (const statement of SCHEMA_V2) tx.exec(statement);
      },
      deleteRun: (tx, runId) => {
        tx.run("DELETE FROM entries WHERE run_id=?", runId);
        tx.run("DELETE FROM member_scopes WHERE run_id=?", runId);
        this.known.delete(runId);
        this.failedAt.delete(runId);
        this.unreadAt.delete(runId);
      },
      runIds: db => db.all<{ run_id: string }>(
        "SELECT run_id FROM entries UNION SELECT run_id FROM member_scopes",
      ).map(row => row.run_id),
      counts: db => ({
        entries: db.get<{ n: number }>("SELECT count(*) AS n FROM entries")?.n ?? 0,
        scopes: db.get<{ n: number }>("SELECT count(*) AS n FROM member_scopes")?.n ?? 0,
        memberEntries: db.get<{ n: number }>(`SELECT count(*) AS n FROM entries WHERE kind IN (${MEMBER_KIND_SQL})`)?.n ?? 0,
        refused: this.refused,
        dropped: this.dropped,
        invalid: this.invalid,
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
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    state: row.state as EntryHead["state"],
  };
}

function kindOf(source: string): HostEntryKind {
  const prefix = source.slice(0, source.indexOf(":"));
  if (prefix === "steering" || prefix === "answer") return "direction";
  return prefix as HostEntryKind;
}

/**
 * The post's entry when it matches the member record: the run, the binding, the entry id, the role and kind, the
 * task, and the entry tools. Undefined otherwise. Never throws.
 */
function checkedPost(run: TeamRun, member: TeamMember, record: MemberPostRecord): MemberEntryPost | undefined {
  try {
    const { envelope } = record;
    const binding = { runId: member.runId, memberId: member.memberId, revision: member.revision };
    if (member.runId !== run.id || member.entryTools !== true) return undefined;
    if (envelope.runId !== binding.runId || envelope.memberId !== binding.memberId || envelope.revision !== binding.revision) {
      return undefined;
    }
    if (envelope.requestId !== memberEntryId(binding, envelope.entry)) return undefined;
    if (postAllowed(member, envelope.entry) !== "ok") return undefined;
    return envelope.entry;
  } catch {
    return undefined;
  }
}

/**
 * Applies the supersede rules to a row just inserted. Each rule changes only an active row, so a withdrawn row never
 * changes. The result depends only on which posts are stored, never on the order they arrived in.
 */
function settleSupersedes(tx: EvidenceTx, runId: string, id: string): void {
  const row = tx.get<{ kind: string; author_member_id: string | null; task_key: string | null; supersedes: string | null; at: string }>(
    "SELECT kind, author_member_id, task_key, supersedes, at FROM entries WHERE entry_id=?",
    id,
  );
  if (row === undefined) return;
  // The new row names an earlier row that it may supersede.
  if (row.supersedes !== null) {
    tx.run(
      "UPDATE entries SET state='superseded' WHERE run_id=? AND entry_id=? AND state='active' AND author='member' AND kind=? "
      + "AND (author_member_id=? OR (task_key IS NOT NULL AND task_key=?))",
      runId,
      row.supersedes,
      row.kind,
      row.author_member_id,
      row.task_key,
    );
  }
  // A stored row that names the new row supersedes it, when the new row may be superseded by that row.
  tx.run(
    "UPDATE entries SET state='superseded' WHERE run_id=? AND entry_id=? AND state='active' AND author='member' "
    + "AND EXISTS (SELECT 1 FROM entries AS X WHERE X.run_id=? AND X.supersedes=entries.entry_id AND X.kind=entries.kind "
    + "AND (X.author_member_id=entries.author_member_id OR (entries.task_key IS NOT NULL AND X.task_key=entries.task_key)))",
    runId,
    id,
    runId,
  );
  // A handoff of a task is superseded by any later handoff of that task, and it supersedes every earlier active one.
  if (row.kind === "handoff" && row.task_key !== null) {
    tx.run(
      "UPDATE entries SET state='superseded' WHERE run_id=? AND kind='handoff' AND task_key=? AND state='active' "
      + "AND (at < ? OR (at = ? AND entry_id < ?))",
      runId,
      row.task_key,
      row.at,
      row.at,
      id,
    );
    tx.run(
      "UPDATE entries SET state='superseded' WHERE run_id=? AND entry_id=? AND state='active' "
      + "AND EXISTS (SELECT 1 FROM entries AS L WHERE L.run_id=? AND L.kind='handoff' AND L.task_key=entries.task_key "
      + "AND (L.at > entries.at OR (L.at = entries.at AND L.entry_id > entries.entry_id)))",
      runId,
      id,
      runId,
    );
  }
}

/** Adds each receipt newer than the member's `read_seq` once, then moves `read_seq` to the newest. No scope row, no change. */
function recordReads(tx: EvidenceTx, runId: string, memberId: string, reads: readonly MemberReadRecord[]): void {
  const scope = tx.get<{ read_seq: number }>("SELECT read_seq FROM member_scopes WHERE member_id=? AND run_id=?", memberId, runId);
  if (scope === undefined) return;
  let highest = scope.read_seq;
  let servedBytes = 0;
  let listCalls = 0;
  let getCalls = 0;
  for (const read of [...reads].sort((a, b) => a.seq - b.seq)) {
    if (read.seq <= highest) continue;
    highest = read.seq;
    servedBytes += read.servedBytes;
    if (read.op === "list") listCalls += 1;
    else getCalls += 1;
  }
  if (highest === scope.read_seq) return;
  tx.run(
    "UPDATE member_scopes SET served_bytes=served_bytes+?, list_calls=list_calls+?, get_calls=get_calls+?, read_seq=? "
    + "WHERE member_id=? AND run_id=?",
    servedBytes,
    listCalls,
    getCalls,
    highest,
    memberId,
    runId,
  );
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
