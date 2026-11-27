import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { deriveEvidenceKey } from "./crypto.js";
import {
  assertEvidenceStoreVersion,
  authenticateEvidence,
  evidenceView,
  failureToken,
  transactionOpen,
} from "./store.js";
import { EvidenceError, type EvidenceDb } from "./types.js";

export const READER_REOPEN_MS = 5_000;
const DEFAULT_BUSY_TIMEOUT_MS = 250;

type SqliteModule = typeof import("node:sqlite");
type ReadVersionRow = { value: unknown };

export class EvidenceReader {
  private readonly databasePath: string;
  private readonly modules: Readonly<Record<string, number>>;
  private readonly busyTimeoutMs: number;
  private readonly now: () => number;
  private rowKey: Buffer;
  private indexKey: Buffer;
  private db: DatabaseSync | undefined;
  private retryAt = 0;
  private warned = false;
  private closed = false;

  constructor(options: {
    databasePath: string;
    vaultKey: Buffer;
    modules: Readonly<Record<string, number>>;
    busyTimeoutMs?: number;
    now?: () => number;
  }) {
    const timeout = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!options || typeof options.databasePath !== "string" || options.databasePath.length === 0
      || !Buffer.isBuffer(options.vaultKey) || options.vaultKey.length !== 32
      || !options.modules || typeof options.modules !== "object"
      || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
      throw new TypeError("Invalid evidence reader options");
    }
    this.databasePath = options.databasePath;
    this.modules = { ...options.modules };
    this.busyTimeoutMs = timeout;
    this.now = options.now ?? Date.now;
    this.rowKey = deriveEvidenceKey(options.vaultKey, "row-encryption");
    this.indexKey = deriveEvidenceKey(options.vaultKey, "blind-index");
  }

  read<T>(fn: (db: EvidenceDb) => T): T {
    const connection = this.connection();
    const view = evidenceView(connection, { rowKey: this.rowKey, indexKey: this.indexKey }, () => {
      if (this.db !== connection || !transactionOpen(connection)) {
        throw new EvidenceError("unavailable", "The evidence reader is unavailable.");
      }
    });
    let began = false;
    try {
      connection.exec("BEGIN DEFERRED");
      began = true;
      for (const [name, readVersion] of Object.entries(this.modules)) {
        const row = view.get<ReadVersionRow>("SELECT read_version AS value FROM schema_modules WHERE name=?", name);
        if (row?.value !== readVersion) {
          throw new EvidenceError("unavailable", "The evidence layout is not known to this reader.");
        }
      }
      const value = fn(view);
      connection.exec("COMMIT");
      return value;
    } catch (error) {
      if (began) rollback(connection);
      if (isSqliteError(error)) {
        this.drop();
        throw new EvidenceError("unavailable", "The evidence reader is unavailable.");
      }
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.drop();
    this.rowKey.fill(0);
    this.indexKey.fill(0);
  }

  private connection(): DatabaseSync {
    if (this.closed) throw new EvidenceError("unavailable", "The evidence reader is closed.");
    if (this.db) return this.db;
    const now = this.now();
    if (now < this.retryAt) throw new EvidenceError("unavailable", "The evidence reader is waiting to reopen.");
    let connection: DatabaseSync | undefined;
    try {
      const sqlite = process.getBuiltinModule("node:sqlite") as SqliteModule | undefined;
      if (!sqlite || typeof sqlite.DatabaseSync !== "function") throw new Error("sqlite missing");
      if (!existsSync(this.databasePath)) throw new Error("missing store");
      connection = new sqlite.DatabaseSync(this.databasePath, { readOnly: true, timeout: this.busyTimeoutMs });
      connection.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};`);
      authenticateEvidence(connection, this.rowKey);
      assertEvidenceStoreVersion(connection);
    } catch (error) {
      closeQuietly(connection);
      this.retryAt = now + READER_REOPEN_MS;
      if (!this.warned) {
        this.warned = true;
        console.warn(`Evidence reader unavailable (${failureToken(error)}).`);
      }
      throw new EvidenceError("unavailable", "The evidence reader could not open.");
    }
    this.db = connection;
    return connection;
  }

  private drop(): void {
    closeQuietly(this.db);
    this.db = undefined;
  }
}

function isSqliteError(error: unknown): boolean {
  return typeof (error as { errcode?: unknown } | undefined)?.errcode === "number";
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
  }
}

function closeQuietly(db: DatabaseSync | undefined): void {
  try {
    db?.close();
  } catch {
  }
}
