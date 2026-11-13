import type { SQLInputValue } from "node:sqlite";
import type { EvidenceIndexClass } from "./crypto.js";

/** A typed fact about a run transition (umbrella contract C2). */
export type RunEvent = {
  seq: number;
  key: string;
  runId: string;
  revision: number;
  at: string;
  kind: string;
  memberId?: string;
  taskId?: string;
  data: Record<string, unknown>;
};

/**
 * Read access that a module hook or a `read` callback receives. Outside a write it reads committed rows
 * through a read-only connection. Every hook must be synchronous.
 */
export interface EvidenceDb {
  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[];
  open<T>(table: string, rowId: string, sealed: string): T;
  index(cls: EvidenceIndexClass, value: string): string;
}

/** Write access inside one immediate transaction of `EvidenceStore.write`. */
export interface EvidenceTx extends EvidenceDb {
  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number };
  exec(sql: string): void;
  seal(table: string, rowId: string, value: unknown): string;
}

/** One design's tables and migrations in the shared evidence store. */
export interface EvidenceModule {
  /** Matches /^[a-z][a-z0-9-]{0,39}$/ and is never "store". */
  name: string;
  /** An integer of at least 1. Every migration raises it. */
  version: number;
  /** Raised only when a reader must change. */
  readVersion: number;
  /** `from` is the stored version, or 0 for a new module. */
  migrate(tx: EvidenceTx, from: number): void;
  /** A module with this hook must also have `runIds`, so the sweep finds rows that a failed delete left. */
  deleteRun?(tx: EvidenceTx, runId: string): void;
  runIds?(db: EvidenceDb): string[];
  counts?(db: EvidenceDb): Record<string, number>;
}

export type ModuleState = "ready" | "unavailable";

export type EvidenceStatus = {
  state: "ready" | "unavailable";
  reason?: string;
  modules: Record<string, ModuleState>;
};

/** What `EvidenceStore.describe` and `GET /api/evidence/status` report. */
export type EvidenceDescription = EvidenceStatus & {
  fileBytes: number;
  walBytes: number;
  events: number;
  counts: Record<string, number>;
};

export type EvidenceErrorCode =
  "unavailable" | "nested-write" | "invalid-event" | "event-too-large" | "invalid-module" | "invalid-statement";

export class EvidenceError extends Error {
  constructor(readonly code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}
