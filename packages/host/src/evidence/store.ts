import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { types } from "node:util";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { EVIDENCE_KEY_VERSION, blindIndex, canonicalJson, deriveEvidenceKey, openRow, sealRow } from "./crypto.js";
import {
  EvidenceError,
  type EvidenceDb,
  type EvidenceDescription,
  type EvidenceErrorCode,
  type EvidenceModule,
  type EvidenceStatus,
  type EvidenceTx,
  type ModuleState,
  type RunEvent,
} from "./types.js";

export const evidenceDatabasePath = (stateDir: string) => join(stateDir, "evidence", "evidence.sqlite3");

const STORE_MODULE = "store";
const STORE_VERSION = 1;
const VAULT_KEY_CHECK = "infinite-evidence-key-check-v1";
const MAX_VAULT_KEY_CHECK_BYTES = 512;
const DEFAULT_BUSY_TIMEOUT_MS = 250;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const MODULE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_REMEMBERED_FAILURES = 64;

const TEMP_INFIX = ".creating-";
const TEMP_SUFFIX = /^([1-9][0-9]{0,9})-[0-9a-f-]{36}(-journal)?$/;

const EVENT_KIND = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MAX_EVENT_KIND_LENGTH = 64;
const MAX_EVENT_KEY_LENGTH = 512;
const MAX_EVENT_DATA_BYTES = 16 * 1024;
const MAX_EVENT_PAGE = 500;
const MAX_EVENT_KINDS = 32;
const MAX_TASK_ID_LENGTH = 512;
const MAX_AT_LENGTH = 64;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const REFUSED_KEYWORDS: ReadonlySet<string> = new Set([
  "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH", "VACUUM", "PRAGMA",
]);
const SQL_WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const TCL_PARAMETER = /[$@:#][A-Za-z0-9_$:\u0080-\uffff]*\(/y;

const EVIDENCE_CODES: ReadonlySet<string> = new Set<EvidenceErrorCode>([
  "unavailable", "nested-write", "invalid-event", "event-too-large", "invalid-module", "invalid-statement", "unreadable",
]);
const ERRNO_TOKENS: ReadonlySet<string> = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "ENOSPC", "EDQUOT", "EROFS", "EIO",
  "EMFILE", "ENFILE", "EBUSY", "ELOOP", "ENAMETOOLONG", "EXDEV", "ENOTSUP", "EOPNOTSUPP",
]);

const STORE_SCHEMA = `
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schema_modules (
  name         TEXT PRIMARY KEY,
  version      INTEGER NOT NULL,
  read_version INTEGER NOT NULL
);
CREATE TABLE run_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hmac       TEXT NOT NULL UNIQUE,
  run_id         TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  member_id      TEXT,
  task_key       TEXT,
  encrypted_data TEXT NOT NULL
);
CREATE INDEX run_events_by_run  ON run_events (run_id, seq);
CREATE INDEX run_events_by_kind ON run_events (kind, seq);
`;

const KEY_CHECK_SQL = "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value ELSE NULL END AS value "
  + "FROM store_meta WHERE key='vault_key_check'";

type SqliteModule = typeof import("node:sqlite");

type OpenReason = "key-check-failed" | "unsupported-key-version" | "open-failed";
type OpenDetail = "sqlite-missing" | "store-schema-unreadable" | "store-schema-version";

class OpenFailure extends Error {
  constructor(readonly reason: OpenReason, readonly detail?: OpenDetail) {
    super(reason);
  }
}

type RegisteredModule = { module: EvidenceModule; state: ModuleState };

type MetaRow = { value: unknown };

type EventRow = {
  seq: number;
  key_hmac: string;
  run_id: string;
  revision: number;
  at: string;
  kind: string;
  member_id: string | null;
  encrypted_data: string;
};

type SealedEvent = { key: string; taskId?: string; data: Record<string, unknown> };

export type EventQuery = { runId?: string; kinds?: string[]; after?: number; limit: number };

export class EvidenceStore {
  private readonly databasePath: string;
  private readonly busyTimeoutMs: number;
  private readonly rowKey: Buffer;
  private readonly indexKey: Buffer;
  private readonly eventKey: Buffer;
  private readonly modules = new Map<string, RegisteredModule>();
  private readonly loggedFailures = new Set<string>();
  private sqlite: SqliteModule | undefined;
  private db: DatabaseSync | undefined;
  private readDb: DatabaseSync | undefined;
  private reason: string | undefined;
  private activeTx: EvidenceTx | undefined;

  constructor(options: { databasePath: string; vaultKey: Buffer; busyTimeoutMs?: number }) {
    const timeout = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!options || typeof options.databasePath !== "string" || options.databasePath.length === 0
      || !Buffer.isBuffer(options.vaultKey) || options.vaultKey.length !== 32
      || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_BUSY_TIMEOUT_MS) {
      throw new TypeError("Invalid evidence store options");
    }
    this.databasePath = options.databasePath;
    this.busyTimeoutMs = timeout;
    this.rowKey = deriveEvidenceKey(options.vaultKey, "row-encryption");
    this.indexKey = deriveEvidenceKey(options.vaultKey, "blind-index");
    this.eventKey = deriveEvidenceKey(options.vaultKey, "event-key");
    try {
      this.db = this.open();
    } catch (error) {
      this.reason = error instanceof OpenFailure ? error.reason : "open-failed";
      this.wipeKeys();
      const detail = error instanceof OpenFailure ? error.detail : failureToken(error);
      console.warn(`Evidence store unavailable: ${this.reason}${detail ? ` (${detail})` : ""}.`);
    }
  }

  status(): EvidenceStatus {
    const ready = this.db !== undefined;
    const modules: Record<string, ModuleState> = { [STORE_MODULE]: ready ? "ready" : "unavailable" };
    for (const [name, entry] of this.modules) modules[name] = ready ? entry.state : "unavailable";
    if (ready) return { state: "ready", modules };
    return { state: "unavailable", reason: this.reason ?? "open-failed", modules };
  }

  register(module: EvidenceModule): void {
    assertModule(module);
    if (this.modules.has(module.name)) {
      throw new EvidenceError("invalid-module", "An evidence module with this name is already registered.");
    }
    const entry: RegisteredModule = { module, state: "unavailable" };
    this.modules.set(module.name, entry);
    if (!this.db) return;
    try {
      const outcome = this.write(tx => {
        const stored = tx.get<MetaRow>("SELECT version AS value FROM schema_modules WHERE name=?", module.name);
        const from = stored === undefined ? 0 : stored.value;
        if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0) {
          throw new EvidenceError("invalid-module", "The stored evidence module version is invalid.");
        }
        if (from > module.version) return "newer";
        if (from < module.version) synchronousHook(module.migrate(tx, from));
        tx.run(
          "INSERT INTO schema_modules (name, version, read_version) VALUES (?, ?, ?) "
          + "ON CONFLICT(name) DO UPDATE SET version=excluded.version, read_version=excluded.read_version",
          module.name, module.version, module.readVersion,
        );
        return "ready";
      });
      if (outcome === "newer") {
        this.warnOnce(`Evidence module ${module.name} unavailable: its stored version is newer than this host.`);
        return;
      }
      entry.state = "ready";
    } catch (error) {
      this.warnOnce(`Evidence module ${module.name} unavailable: migration failed (${failureToken(error)}).`);
    }
  }

  read<T>(fn: (db: EvidenceDb) => T): T {
    const reader = this.reader();
    return fn(this.view(reader, () => {
      if (this.readDb !== reader) throw new EvidenceError("unavailable", "The evidence store is unavailable.");
    }));
  }

  write<T>(fn: (tx: EvidenceTx) => T): T {
    const db = this.ready();
    if (this.activeTx) {
      throw new EvidenceError("nested-write", "An evidence write cannot start inside another write.");
    }
    let active = true;
    const guard = () => {
      if (!active || this.db !== db) throw new EvidenceError("unavailable", "The evidence transaction has ended.");
      assertTransactionOpen(db);
    };
    const tx: EvidenceTx = {
      ...this.view(db, guard),
      run: (sql, ...params) => {
        const values = plainParameters(params);
        guard();
        const result = db.prepare(checkedSql(sql)).run(...values);
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      },
      exec: sql => {
        guard();
        db.exec(checkedSql(sql));
        assertTransactionOpen(db);
      },
      seal: (table, rowId, value) => {
        guard();
        return sealRow(this.rowKey, table, rowId, value);
      },
    };
    this.activeTx = tx;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(tx);
        if (isThenable(result)) {
          result.then(undefined, () => undefined);
          throw new TypeError("An evidence write callback must be synchronous");
        }
        guard();
        assertTransactionOpen(db);
        commit(db);
        return result;
      } catch (error) {
        rollback(db);
        throw error;
      }
    } finally {
      active = false;
      this.activeTx = undefined;
    }
  }

  tryWrite(fn: (tx: EvidenceTx) => void): boolean {
    try {
      this.write(fn);
      return true;
    } catch (error) {
      this.warnOnce(`Evidence write failed (${failureToken(error)}).`);
      return false;
    }
  }

  appendEvent(tx: EvidenceTx, event: Omit<RunEvent, "seq">): { seq: number; inserted: boolean } {
    if (!this.activeTx || tx !== this.activeTx) {
      throw new TypeError("appendEvent needs the transaction of the current evidence write");
    }
    assertTransactionOpen(this.ready());
    const fault = examineEvent(event);
    if (fault === "envelope") throw new EvidenceError("invalid-event", "The event envelope is invalid.");
    if (fault === "data") throw new EvidenceError("invalid-event", "Event data must be a JSON object.");
    if (fault === "too-large") throw new EvidenceError("event-too-large", "Event data is larger than 16 KiB.");
    const keyHmac = this.eventKeyHmac(event.key);
    const sealed: SealedEvent = {
      key: event.key,
      data: event.data,
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    };
    const insert = tx.run(
      "INSERT INTO run_events (key_hmac, run_id, revision, at, kind, member_id, task_key, encrypted_data) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key_hmac) DO NOTHING",
      keyHmac,
      event.runId,
      event.revision,
      event.at,
      event.kind,
      event.memberId ?? null,
      event.taskId === undefined ? null : tx.index("task", event.taskId),
      tx.seal("run_events", keyHmac, sealed),
    );
    if (insert.changes === 1) return { seq: insert.lastInsertRowid, inserted: true };
    const stored = tx.get<{ seq: number }>("SELECT seq FROM run_events WHERE key_hmac=?", keyHmac);
    if (!stored) throw new Error("The stored evidence event could not be read back");
    return { seq: stored.seq, inserted: false };
  }

  events(query: EventQuery): { events: RunEvent[]; cursor: number; more: boolean } {
    const checked = checkEventQuery(query);
    return this.read(db => readEvents(db, query, checked));
  }

  eventsIn(db: EvidenceDb, query: EventQuery): { events: RunEvent[]; cursor: number; more: boolean } {
    return readEvents(db, query, checkEventQuery(query));
  }

  hasEvent(key: string): boolean {
    return this.read(db => {
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_EVENT_KEY_LENGTH) return false;
      const found = db.get("SELECT 1 AS found FROM run_events WHERE key_hmac=?", this.eventKeyHmac(key));
      return found !== undefined;
    });
  }

  deleteRun(runId: string): boolean {
    return this.removeRun(runId) === "deleted";
  }

  sweep(isLive: (runId: string) => boolean): number {
    if (!this.db) return 0;
    let runIds: Set<string>;
    try {
      runIds = this.read(db => this.storedRunIds(db));
    } catch (error) {
      this.warnOnce(`Evidence sweep failed (${failureToken(error)}).`);
      return 0;
    }
    let removed = 0;
    for (const runId of runIds) {
      let live = true;
      try {
        live = isLive(runId) !== false;
      } catch {
        live = true;
      }
      if (live) continue;
      const outcome = this.removeRun(runId);
      if (outcome === "deleted") removed++;
      else if (outcome === "stop") break;
    }
    return removed;
  }

  describe(): EvidenceDescription {
    let status = this.status();
    let events = 0;
    const counts: Record<string, number> = {};
    if (this.db) {
      let reason: string | undefined;
      try {
        this.reader();
        this.read(db => {
          events = db.get<{ count: number }>("SELECT count(*) AS count FROM run_events")?.count ?? 0;
          for (const entry of this.readyModules()) Object.assign(counts, this.moduleCounts(entry.module, db));
        });
      } catch (error) {
        reason = this.readDb ? "read-failed" : "reader-unavailable";
        if (this.readDb) this.warnOnce(`Evidence status read failed (${failureToken(error)}).`);
      }
      if (reason) {
        events = 0;
        for (const name of Object.keys(counts)) delete counts[name];
        const modules = Object.fromEntries(Object.keys(status.modules).map(name => [name, "unavailable" as const]));
        status = { state: "unavailable", reason, modules };
      }
    }
    return {
      ...status,
      fileBytes: fileSize(this.databasePath),
      walBytes: fileSize(`${this.databasePath}-wal`),
      events,
      counts,
    };
  }

  close(): void {
    const db = this.db;
    if (!db) return;
    this.db = undefined;
    this.reason = "closed";
    if (this.activeTx) rollback(db);
    closeQuietly(this.readDb);
    this.readDb = undefined;
    closeQuietly(db);
    this.wipeKeys();
  }

  private ready(): DatabaseSync {
    if (!this.db) throw new EvidenceError("unavailable", "The evidence store is unavailable.");
    return this.db;
  }

  private removeRun(runId: string): "deleted" | "failed" | "stop" {
    if (typeof runId !== "string" || runId.length === 0) return "failed";
    try {
      this.write(tx => {
        for (const { module } of this.readyModules()) {
          if (module.deleteRun) synchronousHook(module.deleteRun(tx, runId));
        }
        tx.run("DELETE FROM run_events WHERE run_id=?", runId);
      });
      return "deleted";
    } catch (error) {
      this.warnOnce(`Evidence write failed (${failureToken(error)}).`);
      const code = sqliteCode(error);
      const storeWide = code === 5 || code === 6 || (error instanceof EvidenceError && error.code === "unavailable");
      return storeWide ? "stop" : "failed";
    }
  }

  private reader(): DatabaseSync {
    this.ready();
    if (this.readDb) return this.readDb;
    let reader: DatabaseSync | undefined;
    try {
      reader = new this.sqlite!.DatabaseSync(this.databasePath, { readOnly: true, timeout: this.busyTimeoutMs });
      reader.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};`);
      this.authenticate(reader);
    } catch (error) {
      closeQuietly(reader);
      this.warnOnce(`Evidence reader unavailable (${failureToken(error)}).`);
      throw new EvidenceError("unavailable", "The evidence reader could not open.");
    }
    this.readDb = reader;
    return reader;
  }

  private view(db: DatabaseSync, guard: () => void): EvidenceDb {
    return evidenceView(db, { rowKey: this.rowKey, indexKey: this.indexKey }, guard);
  }

  private open(): DatabaseSync {
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (!sqlite || typeof sqlite.DatabaseSync !== "function") throw new OpenFailure("open-failed", "sqlite-missing");
    this.sqlite = sqlite;
    const path = this.databasePath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    removeStaleTemps(path);
    if (!fileExists(path)) this.create(sqlite, path);
    const reader = new sqlite.DatabaseSync(path, { readOnly: true, timeout: this.busyTimeoutMs });
    try {
      this.authenticate(reader);
    } finally {
      reader.close();
    }
    let database: DatabaseSync | undefined;
    try {
      database = new sqlite.DatabaseSync(path, { timeout: this.busyTimeoutMs });
      this.authenticate(database);
      assertEvidenceStoreVersion(database);
      narrowModes(path);
      database.exec([
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=FULL;",
        "PRAGMA foreign_keys=ON;",
        "PRAGMA secure_delete=ON;",
        `PRAGMA busy_timeout=${this.busyTimeoutMs};`,
        "PRAGMA wal_autocheckpoint=1000;",
      ].join(" "));
      return database;
    } catch (error) {
      closeQuietly(database);
      throw error;
    }
  }

  private create(sqlite: SqliteModule, path: string): void {
    try {
      this.buildAndLink(sqlite, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.buildAndLink(sqlite, path);
    }
  }

  private buildAndLink(sqlite: SqliteModule, path: string): void {
    const temp = `${path}${TEMP_INFIX}${process.pid}-${randomUUID()}`;
    try {
      closeSync(openSync(temp, "wx", 0o600));
      const database = new sqlite.DatabaseSync(temp, { timeout: this.busyTimeoutMs });
      try {
        database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
        this.initialize(database);
      } finally {
        database.close();
      }
      try {
        linkSync(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      removeQuietly(temp);
      removeQuietly(`${temp}-journal`);
    }
  }

  private authenticate(database: DatabaseSync): void {
    authenticateEvidence(database, this.rowKey);
  }

  private initialize(database: DatabaseSync): void {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(STORE_SCHEMA);
      const keyCheck = sealRow(this.rowKey, "store_meta", "vault_key_check", VAULT_KEY_CHECK);
      database.prepare("INSERT INTO store_meta (key, value) VALUES ('vault_key_check', ?)").run(keyCheck);
      database.prepare("INSERT INTO store_meta (key, value) VALUES ('key_version', ?)").run(String(EVIDENCE_KEY_VERSION));
      database.prepare("INSERT INTO schema_modules (name, version, read_version) VALUES (?, ?, ?)")
        .run(STORE_MODULE, STORE_VERSION, STORE_VERSION);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  private readyModules(): RegisteredModule[] {
    return [...this.modules.values()].filter(entry => entry.state === "ready");
  }

  private storedRunIds(db: EvidenceDb): Set<string> {
    const runIds = new Set(db.all<{ run_id: string }>("SELECT DISTINCT run_id FROM run_events ORDER BY run_id").map(row => row.run_id));
    for (const { module } of this.readyModules()) {
      if (!module.runIds) continue;
      try {
        const listed = synchronousHook(module.runIds(db));
        if (!Array.isArray(listed)) throw new EvidenceError("invalid-module", "A module run listing must be an array.");
        for (const runId of listed) {
          if (typeof runId === "string" && runId.length > 0) runIds.add(runId);
        }
      } catch (error) {
        this.warnOnce(`Evidence module ${module.name} could not list its runs (${failureToken(error)}).`);
      }
    }
    return runIds;
  }

  private moduleCounts(module: EvidenceModule, db: EvidenceDb): Record<string, number> {
    if (!module.counts) return {};
    const counts: Record<string, number> = {};
    try {
      const reported = synchronousHook(module.counts(db));
      if (typeof reported !== "object" || reported === null) {
        throw new EvidenceError("invalid-module", "Module counts must be an object.");
      }
      for (const [name, value] of Object.entries(reported)) {
        if (typeof value === "number" && Number.isFinite(value)) counts[`${module.name}.${name}`] = value;
      }
      return counts;
    } catch (error) {
      this.warnOnce(`Evidence module ${module.name} could not count its rows (${failureToken(error)}).`);
      return {};
    }
  }

  private eventKeyHmac(key: string): string {
    return createHmac("sha256", this.eventKey).update(key, "utf8").digest("hex");
  }

  private warnOnce(line: string): void {
    if (this.loggedFailures.has(line)) return;
    if (this.loggedFailures.size < MAX_REMEMBERED_FAILURES) this.loggedFailures.add(line);
    console.warn(line);
  }

  private wipeKeys(): void {
    for (const key of [this.rowKey, this.indexKey, this.eventKey]) key.fill(0);
  }
}

function assertModule(module: EvidenceModule): void {
  const hooksValid = !!module
    && (module.deleteRun === undefined || typeof module.deleteRun === "function")
    && (module.runIds === undefined || typeof module.runIds === "function")
    && (module.counts === undefined || typeof module.counts === "function")
    && (module.deleteRun === undefined || module.runIds !== undefined);
  const valid = hooksValid
    && typeof module.name === "string" && MODULE_NAME.test(module.name) && module.name !== STORE_MODULE
    && Number.isSafeInteger(module.version) && module.version >= 1
    && Number.isSafeInteger(module.readVersion) && module.readVersion >= 1 && module.readVersion <= module.version
    && typeof module.migrate === "function";
  if (!valid) throw new EvidenceError("invalid-module", "The evidence module definition is invalid.");
}

function synchronousHook<T>(result: T): T {
  if (isThenable(result)) {
    result.then(undefined, () => undefined);
    throw new EvidenceError("invalid-module", "An evidence module hook must be synchronous.");
  }
  return result;
}

function checkedSql(sql: string): string {
  if (typeof sql !== "string") throw new TypeError("Evidence SQL must be a string");
  if (!allowedStatements(sql)) {
    throw new EvidenceError("invalid-statement", "Evidence SQL cannot control transactions, attach files, vacuum, or set PRAGMAs.");
  }
  return sql;
}

function allowedStatements(sql: string): boolean {
  let words: string[] = [];
  let inTrigger = false;
  const statementAllowed = (): boolean => {
    const [first, second, third] = words;
    words = [];
    if (first === undefined) return true;
    if (inTrigger && first === "END") {
      inTrigger = false;
      return true;
    }
    if (REFUSED_KEYWORDS.has(first)) return false;
    const temp = second === "TEMP" || second === "TEMPORARY";
    if (first === "CREATE" && (second === "TRIGGER" || (temp && third === "TRIGGER"))) inTrigger = true;
    return true;
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === "\"" || char === "`") {
      index = skipQuoted(sql, index, char);
    } else if (char === "[") {
      index = skipPast(sql, "]", index + 1);
    } else if (char === "-" && sql[index + 1] === "-") {
      index = skipPast(sql, "\n", index + 2);
    } else if (char === "/" && sql[index + 1] === "*") {
      index = skipPast(sql, "*/", index + 2);
    } else if (char === ";") {
      if (!statementAllowed()) return false;
      index++;
    } else {
      TCL_PARAMETER.lastIndex = index;
      if (TCL_PARAMETER.test(sql)) return false;
      SQL_WORD.lastIndex = index;
      const word = SQL_WORD.exec(sql);
      if (word && words.length < 3) words.push(word[0].toUpperCase());
      index += word ? word[0].length : 1;
    }
  }
  return statementAllowed();
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) index++;
    else if (sql[index + 1] === quote) index += 2;
    else return index + 1;
  }
  return sql.length;
}

function skipPast(sql: string, end: string, from: number): number {
  const found = sql.indexOf(end, from);
  return found === -1 ? sql.length : found + end.length;
}

export function transactionOpen(db: DatabaseSync): boolean {
  const flag = (db as { isTransaction?: unknown }).isTransaction;
  if (typeof flag === "boolean") return flag;
  try {
    db.exec("BEGIN");
  } catch (error) {
    return error instanceof Error && /within a transaction/i.test(error.message);
  }
  rollback(db);
  return false;
}

function plainParameters(params: readonly unknown[]): SQLInputValue[] {
  return params.map(value => {
    if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
      return value;
    }
    if (types.isUint8Array(value)) return Buffer.from(value);
    throw new TypeError("Evidence SQL parameters must be null, a number, a bigint, a string, or bytes.");
  });
}

function assertTransactionOpen(db: DatabaseSync): void {
  if (!transactionOpen(db)) {
    throw new EvidenceError("invalid-statement", "An evidence statement ended the write's transaction.");
  }
}

function commit(db: DatabaseSync): void {
  try {
    db.exec("COMMIT");
  } catch (error) {
    if (sqliteCode(error) === 1) {
      throw new EvidenceError("invalid-statement", "An evidence statement ended the write's transaction.");
    }
    throw error;
  }
}

export function eventProblem(event: Omit<RunEvent, "seq">): "invalid-event" | "event-too-large" | undefined {
  try {
    const fault = examineEvent(event);
    if (fault === "too-large") return "event-too-large";
    return fault === undefined ? undefined : "invalid-event";
  } catch {
    return "invalid-event";
  }
}

type EventFault = "envelope" | "data" | "too-large";

function examineEvent(event: Omit<RunEvent, "seq">): EventFault | undefined {
  if (!validEvent(event)) return "envelope";
  let data: string;
  try {
    data = canonicalJson(event.data);
  } catch {
    return "data";
  }
  return Buffer.byteLength(data, "utf8") > MAX_EVENT_DATA_BYTES ? "too-large" : undefined;
}

export function isEventKind(kind: unknown): kind is string {
  return typeof kind === "string" && kind.length <= MAX_EVENT_KIND_LENGTH && EVENT_KIND.test(kind);
}

function validEvent(event: Omit<RunEvent, "seq">): boolean {
  if (!event || typeof event !== "object") return false;
  const { key, runId, revision, at, kind, memberId, taskId, data } = event;
  return typeof key === "string" && key.length >= 1 && key.length <= MAX_EVENT_KEY_LENGTH
    && typeof runId === "string" && OPAQUE_ID.test(runId)
    && Number.isSafeInteger(revision) && revision >= 1
    && typeof at === "string" && at.length <= MAX_AT_LENGTH && Number.isFinite(Date.parse(at))
    && isEventKind(kind)
    && (memberId === undefined || (typeof memberId === "string" && OPAQUE_ID.test(memberId)))
    && (taskId === undefined || (typeof taskId === "string" && taskId.length >= 1 && taskId.length <= MAX_TASK_ID_LENGTH))
    && isPlainObject(data);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type CheckedEventQuery = { after: number; kinds?: string[]; limit: number };

function checkEventQuery(query: EventQuery): CheckedEventQuery {
  const after = query.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new EvidenceError("invalid-event", "An event cursor must be a non-negative integer.");
  }
  if (query.runId !== undefined && typeof query.runId !== "string") {
    throw new EvidenceError("invalid-event", "An event query run ID must be a string.");
  }
  const kinds = query.kinds;
  if (kinds !== undefined
    && (!Array.isArray(kinds) || kinds.length > MAX_EVENT_KINDS || kinds.some(kind => typeof kind !== "string"))) {
    throw new EvidenceError("invalid-event", "An event query takes at most 32 kinds.");
  }
  return { after, kinds, limit: clampLimit(query.limit) };
}

function readEvents(
  db: EvidenceDb,
  query: EventQuery,
  checked: CheckedEventQuery,
): { events: RunEvent[]; cursor: number; more: boolean } {
  const where = ["seq > ?"];
  const params: SQLInputValue[] = [checked.after];
  if (query.runId !== undefined) {
    where.push("run_id = ?");
    params.push(query.runId);
  }
  if (checked.kinds !== undefined) {
    where.push(`kind IN (${checked.kinds.map(() => "?").join(", ")})`);
    params.push(...checked.kinds);
  }
  const rows = db.all<EventRow>(
    "SELECT seq, key_hmac, run_id, revision, at, kind, member_id, encrypted_data FROM run_events "
    + `WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`,
    ...params,
    checked.limit + 1,
  );
  const page = rows.slice(0, checked.limit);
  return {
    events: page.map(row => toEvent(db, row)),
    cursor: page.length > 0 ? page[page.length - 1].seq : checked.after,
    more: rows.length > checked.limit,
  };
}

function clampLimit(limit: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return 1;
  return Math.min(MAX_EVENT_PAGE, Math.max(1, Math.floor(limit)));
}

function toEvent(db: EvidenceDb, row: EventRow): RunEvent {
  const sealed = db.open<SealedEvent>("run_events", row.key_hmac, row.encrypted_data);
  return {
    seq: row.seq,
    key: sealed.key,
    runId: row.run_id,
    revision: row.revision,
    at: row.at,
    kind: row.kind,
    ...(row.member_id === null ? {} : { memberId: row.member_id }),
    ...(sealed.taskId === undefined ? {} : { taskId: sealed.taskId }),
    data: sealed.data,
  };
}

export function authenticateEvidence(database: DatabaseSync, rowKey: Buffer): void {
  let check: MetaRow | undefined;
  let version: MetaRow | undefined;
  try {
    check = database.prepare(KEY_CHECK_SQL).get(MAX_VAULT_KEY_CHECK_BYTES) as MetaRow | undefined;
    version = database.prepare("SELECT value FROM store_meta WHERE key='key_version'").get() as MetaRow | undefined;
  } catch (error) {
    throw new OpenFailure(unreadableDatabase(error) ? "key-check-failed" : "open-failed");
  }
  if (version !== undefined && version.value !== String(EVIDENCE_KEY_VERSION)) {
    throw new OpenFailure("unsupported-key-version");
  }
  let opened: unknown;
  try {
    if (!check || typeof check.value !== "string") throw new Error("missing key check");
    opened = openRow<unknown>(rowKey, "store_meta", "vault_key_check", check.value);
  } catch {
    throw new OpenFailure("key-check-failed");
  }
  if (opened !== VAULT_KEY_CHECK) throw new OpenFailure("key-check-failed");
  if (version === undefined) throw new OpenFailure("unsupported-key-version");
}

export function evidenceView(db: DatabaseSync, keys: { rowKey: Buffer; indexKey: Buffer }, guard: () => void): EvidenceDb {
  return {
    get: <R = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]) => {
      const values = plainParameters(params);
      guard();
      return db.prepare(checkedSql(sql)).get(...values) as R | undefined;
    },
    all: <R = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]) => {
      const values = plainParameters(params);
      guard();
      return db.prepare(checkedSql(sql)).all(...values) as R[];
    },
    open: <R>(table: string, rowId: string, sealed: string) => {
      guard();
      return openRow<R>(keys.rowKey, table, rowId, sealed);
    },
    index: (cls, value) => {
      guard();
      return blindIndex(keys.indexKey, cls, value);
    },
  };
}

export function assertEvidenceStoreVersion(database: DatabaseSync): void {
  let stored: MetaRow | undefined;
  try {
    stored = database.prepare("SELECT version AS value FROM schema_modules WHERE name=?").get(STORE_MODULE) as MetaRow | undefined;
  } catch {
    throw new OpenFailure("open-failed", "store-schema-unreadable");
  }
  if (stored?.value !== STORE_VERSION) throw new OpenFailure("open-failed", "store-schema-version");
}

function narrowModes(path: string): void {
  chmodSync(path, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${path}${suffix}`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeStaleTemps(path: string): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}${TEMP_INFIX}`;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const match = name.startsWith(prefix) ? TEMP_SUFFIX.exec(name.slice(prefix.length)) : null;
    if (!match || processRuns(Number(match[1]))) continue;
    try {
      rmSync(join(directory, name), { force: true });
    } catch {
    }
  }
}

function processRuns(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
  }
}

function closeQuietly(db: DatabaseSync | undefined): void {
  try {
    db?.close();
  } catch {
  }
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function sqliteCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | undefined)?.errcode;
  return typeof code === "number" ? code & 0xff : undefined;
}

function unreadableDatabase(error: unknown): boolean {
  const code = sqliteCode(error);
  return code === undefined || code === 1 || code === 11 || code === 26;
}

export function failureToken(error: unknown): string {
  if (error instanceof EvidenceError) return EVIDENCE_CODES.has(error.code) ? error.code : "unexpected";
  if (error instanceof OpenFailure) return error.detail ?? error.reason;
  const sqlite = sqliteCode(error);
  if (sqlite !== undefined) {
    if (sqlite === 5 || sqlite === 6) return "sqlite-busy";
    if (sqlite === 13) return "sqlite-full";
    if (sqlite === 11 || sqlite === 26) return "sqlite-corrupt";
    if (sqlite === 8) return "sqlite-readonly";
    return "sqlite-other";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && ERRNO_TOKENS.has(code)) return code;
  return "unexpected";
}
