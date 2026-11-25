import type { SQLInputValue } from "node:sqlite";
import type { EvidenceIndexClass } from "./crypto.js";

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

export interface EvidenceDb {
  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[];
  open<T>(table: string, rowId: string, sealed: string): T;
  index(cls: EvidenceIndexClass, value: string): string;
}

export interface EvidenceTx extends EvidenceDb {
  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number };
  exec(sql: string): void;
  seal(table: string, rowId: string, value: unknown): string;
}

export interface EvidenceModule {
  name: string;
  version: number;
  readVersion: number;
  migrate(tx: EvidenceTx, from: number): void;
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

export type EvidenceDescription = EvidenceStatus & {
  fileBytes: number;
  walBytes: number;
  events: number;
  counts: Record<string, number>;
};

export type EvidenceErrorCode =
  "unavailable" | "nested-write" | "invalid-event" | "event-too-large" | "invalid-module" | "invalid-statement" | "unreadable";

export class EvidenceError extends Error {
  constructor(readonly code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}
