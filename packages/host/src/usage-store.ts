import type { SQLInputValue } from "node:sqlite";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "./evidence/types.js";
import type { TeamAssignment } from "./team-types.js";
import { SESSION_PURPOSES, type Provider, type SessionPurpose } from "./types.js";
import type { UsageCoverage, UsageCoverageReason } from "./transcript-usage.js";
import { usageRecordKey } from "./transcript-usage.js";
import type { UsageRecord, UsageTokens } from "./usage.js";

export { SESSION_PURPOSES };
export type LedgerCoverageReason = UsageCoverageReason | "running";
export interface LedgerCoverage { coverage: UsageCoverage; reason?: LedgerCoverageReason }
export interface LedgerHeader {
  sessionId: string;
  provider: Provider;
  projectId: string;
  createdAt: string;
  lastActiveAt?: string;
  team?: TeamAssignment;
  profileId?: string;
  purpose?: SessionPurpose;
  configId?: string;
}
export interface LedgerState extends LedgerCoverage {
  cursor: number;
  seen: number;
  refused: number;
  exited: boolean;
  /** The worker's usage-coverage record, once the fold has read it. */
  journaled?: LedgerCoverage & { finalDrain?: "complete" | "incomplete" | "skipped" };
}
export interface StoredSession extends LedgerState {
  sessionId: string;
  provider: Provider;
  projectId: string;
  createdAt: string;
  lastActiveAt?: string;
  runId?: string;
  memberId?: string;
  revision?: number;
  role?: string;
  taskKey?: string;
  profileId?: string;
  purpose?: SessionPurpose;
  configId?: string;
}
/** The `Ledger` type of usage-service.ts, copied here for the import. Task 3 removes the original. */
export type SealedSession = { provider: Provider; projectId: string; createdAt: string; lastActiveAt?: string; measured: boolean; team?: TeamAssignment; profileId?: string; exited?: true };
/** The `Ledger` type of usage-service.ts, copied here for the import. Task 3 removes the original. */
export type SealedLedger = { cursors: Record<string, number>; sessions: Record<string, SealedSession>; rows: Record<string, UsageRecord>; briefings: Record<string, { projectId: string; at: string; record?: UsageRecord }> };

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const CONFIG_ID = /^[0-9a-f]{64}$/;
const ROLE = /^[a-z][a-z0-9-]{0,39}$/;
const PROVIDERS: readonly string[] = ["claude", "codex", "grok", "opencode", "demo"];
const RECORD_PROVIDERS: readonly string[] = ["opencode", "claude", "codex"];
const SOURCES: readonly string[] = ["requested", "reported", "unknown"];
const COVERAGES: readonly string[] = ["none", "partial", "complete"];
const FINAL_DRAINS: readonly string[] = ["complete", "incomplete", "skipped"];
const SEALED_IMPORT = "sealed-import";
const TOKEN_CLASSES = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

const SESSION_COLUMNS = ["session_id", "provider", "project_ref", "created_at", "last_active_at", "coverage", "coverage_reason",
  "journaled_coverage", "journaled_reason", "final_drain", "run_id", "member_id", "revision", "role", "task_key", "profile_id",
  "purpose", "config_id", "journal_cursor", "records_seen", "records_refused", "exited"] as const;
const RECORD_COLUMNS = ["record_key", "provider", "session_id", "completed_at", "model_ref", "model_source", "input", "output",
  "reasoning", "cache_read", "cache_write", "cache_write_1h", "reported_cost", "secondary"] as const;
const BRIEFING_COLUMNS = ["briefing_key", "project_ref", "at", "model_ref", "model_source", "input", "output", "reasoning",
  "cache_read", "cache_write", "reported_cost"] as const;

/** Builds `INSERT ... ON CONFLICT(key) DO UPDATE` over every column but the key, so the statement lists each column once. */
function upsert(table: string, columns: readonly string[], key: string): string {
  const update = columns.filter(column => column !== key).map(column => `${column}=excluded.${column}`).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${key}) DO UPDATE SET ${update}`;
}

const SCHEMA = [
  "CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE usage_projects (project_ref TEXT PRIMARY KEY, encrypted_project TEXT NOT NULL)",
  "CREATE TABLE usage_models (model_ref INTEGER PRIMARY KEY, model_key TEXT NOT NULL UNIQUE, encrypted_model TEXT NOT NULL)",
  `CREATE TABLE usage_sessions (
    session_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
    project_ref TEXT NOT NULL REFERENCES usage_projects(project_ref),
    created_at TEXT NOT NULL, last_active_at TEXT,
    coverage TEXT NOT NULL, coverage_reason TEXT, journaled_coverage TEXT, journaled_reason TEXT, final_drain TEXT,
    run_id TEXT, member_id TEXT, revision INTEGER, role TEXT, task_key TEXT,
    profile_id TEXT, purpose TEXT, config_id TEXT,
    journal_cursor INTEGER NOT NULL DEFAULT 0, records_seen INTEGER NOT NULL DEFAULT 0,
    records_refused INTEGER NOT NULL DEFAULT 0, exited INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE usage_records (
    record_key TEXT PRIMARY KEY, provider TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES usage_sessions(session_id),
    completed_at TEXT NOT NULL, model_ref INTEGER NOT NULL REFERENCES usage_models(model_ref), model_source TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL DEFAULT 0,
    reported_cost REAL NOT NULL DEFAULT 0, secondary INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE usage_briefings (
    briefing_key TEXT PRIMARY KEY, project_ref TEXT NOT NULL REFERENCES usage_projects(project_ref), at TEXT NOT NULL,
    model_ref INTEGER REFERENCES usage_models(model_ref), model_source TEXT,
    input INTEGER, output INTEGER, reasoning INTEGER, cache_read INTEGER, cache_write INTEGER, reported_cost REAL
  )`,
  "CREATE INDEX usage_records_by_session ON usage_records (session_id)",
  "CREATE INDEX usage_records_by_time ON usage_records (completed_at)",
  "CREATE INDEX usage_sessions_by_member ON usage_sessions (run_id, member_id)",
  "CREATE INDEX usage_sessions_by_project ON usage_sessions (project_ref)",
];

/** The `usage` evidence module: the usage ledger's tables. Usage rows outlive their run, so it has no run deletion. */
export const usageModule: EvidenceModule = {
  name: "usage",
  version: 1,
  readVersion: 1,
  migrate(tx) {
    for (const sql of SCHEMA) tx.exec(sql);
  },
  counts(db) {
    const row = db.get<{ sessions: number; records: number; briefings: number }>(
      "SELECT (SELECT count(*) FROM usage_sessions) AS sessions, (SELECT count(*) FROM usage_records) AS records, "
      + "(SELECT count(*) FROM usage_briefings) AS briefings",
    );
    return { sessions: row?.sessions ?? 0, records: row?.records ?? 0, briefings: row?.briefings ?? 0 };
  },
};

const opaque = (value: unknown): value is string => typeof value === "string" && OPAQUE_ID.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** An ISO time with milliseconds, or undefined when the text does not parse. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * The checked copy of a usage record, with only usage fields and normalised times. A value that fails any check is undefined.
 * `nativeId` is dropped too: nothing reads it, and no plain column may hold it.
 */
export function ledgerRecord(value: unknown): UsageRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const text = (field: unknown, min: number, max: number): field is string => typeof field === "string" && field.length >= min && field.length <= max;
  const tokens = raw.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) return undefined;
  const counts = tokens as Record<string, unknown>;
  if (!TOKEN_CLASSES.every(name => isCount(counts[name]))) return undefined;
  const completedAt = isoTime(raw.completedAt);
  if (!completedAt || typeof raw.provider !== "string" || !RECORD_PROVIDERS.includes(raw.provider)) return undefined;
  if (!text(raw.providerId, 1, 200) || !text(raw.modelId, 1, 200) || !text(raw.messageId, 1, 512) || !text(raw.partId, 0, 512)) return undefined;
  if (typeof raw.modelSource !== "string" || !SOURCES.includes(raw.modelSource)) return undefined;
  const { input, output, reasoning, cacheRead, cacheWrite } = counts as unknown as UsageTokens;
  if (raw.cacheWrite1h !== undefined && !(isCount(raw.cacheWrite1h) && raw.cacheWrite1h <= cacheWrite)) return undefined;
  if (typeof raw.reportedCost !== "number" || !Number.isFinite(raw.reportedCost) || raw.reportedCost < 0) return undefined;
  if (raw.secondary !== undefined && raw.secondary !== true) return undefined;
  return {
    provider: raw.provider as UsageRecord["provider"],
    providerId: raw.providerId as string,
    modelId: raw.modelId as string,
    messageId: raw.messageId as string,
    partId: raw.partId as string,
    modelSource: raw.modelSource as UsageRecord["modelSource"],
    completedAt,
    tokens: { input, output, reasoning, cacheRead, cacheWrite },
    reportedCost: raw.reportedCost,
    ...(raw.cacheWrite1h !== undefined ? { cacheWrite1h: raw.cacheWrite1h as number } : {}),
    ...(raw.secondary === true ? { secondary: true as const } : {}),
  };
}

/** OpenCode keys are scoped to their session. Claude and Codex keys are global, so one request seen twice keeps one row. */
export function ledgerKey(record: UsageRecord, sessionId: string): string {
  return record.provider === "opencode" ? `opencode:${sessionId}/${record.messageId}/${record.partId}` : usageRecordKey(record);
}

function ensureProject(tx: EvidenceTx, projectId: string): string {
  const ref = tx.index("project", projectId);
  if (!tx.get("SELECT 1 AS found FROM usage_projects WHERE project_ref=?", ref)) {
    tx.run("INSERT INTO usage_projects (project_ref, encrypted_project) VALUES (?, ?)", ref, tx.seal("usage_projects", ref, projectId));
  }
  return ref;
}

function ensureModel(tx: EvidenceTx, providerId: string, modelId: string): number {
  const key = tx.index("model", `${providerId}\u0000${modelId}`);
  const row = tx.get<{ model_ref: number }>("SELECT model_ref FROM usage_models WHERE model_key=?", key);
  if (row) return row.model_ref;
  const sealed = tx.seal("usage_models", key, { providerId, modelId });
  return tx.run("INSERT INTO usage_models (model_key, encrypted_model) VALUES (?, ?)", key, sealed).lastInsertRowid;
}

/**
 * Stores a session's header and state. Returns false, with nothing written, when an id, a time, a purpose, or a
 * coverage value is invalid. A session id and team ids must be opaque; a config id that is not a digest is stored as null.
 */
export function writeSession(tx: EvidenceTx, header: LedgerHeader, state: LedgerState): boolean {
  const createdAt = isoTime(header.createdAt);
  const lastActiveAt = header.lastActiveAt === undefined ? null : isoTime(header.lastActiveAt);
  const team = header.team;
  if (!opaque(header.sessionId) || typeof header.provider !== "string" || !PROVIDERS.includes(header.provider)) return false;
  if (typeof header.projectId !== "string" || !createdAt || lastActiveAt === undefined) return false;
  if (team && (!opaque(team.runId) || !opaque(team.memberId) || !isCount(team.revision))) return false;
  if (header.profileId !== undefined && !opaque(header.profileId)) return false;
  if (header.purpose !== undefined && !SESSION_PURPOSES.includes(header.purpose)) return false;
  if (!COVERAGES.includes(state.coverage) || !isCount(state.cursor) || !isCount(state.seen) || !isCount(state.refused)) return false;
  if (state.reason !== undefined && !REASON.test(state.reason) && state.reason !== "running") return false;
  const journaled = state.journaled;
  if (journaled && (!COVERAGES.includes(journaled.coverage) || (journaled.reason !== undefined && !REASON.test(journaled.reason))
    || (journaled.finalDrain !== undefined && !FINAL_DRAINS.includes(journaled.finalDrain)))) return false;
  const projectRef = ensureProject(tx, header.projectId);
  const values = [
    header.sessionId,
    header.provider,
    projectRef,
    createdAt,
    lastActiveAt,
    state.coverage,
    state.reason ?? null,
    journaled?.coverage ?? null,
    journaled?.reason ?? null,
    journaled?.finalDrain ?? null,
    team?.runId ?? null,
    team?.memberId ?? null,
    team?.revision ?? null,
    team && ROLE.test(team.role) ? team.role : null,
    team?.taskId === undefined ? null : tx.index("task", team.taskId),
    header.profileId ?? null,
    header.purpose ?? (team ? "work" : null),
    header.configId !== undefined && CONFIG_ID.test(header.configId) ? header.configId : null,
    state.cursor,
    state.seen,
    state.refused,
    state.exited ? 1 : 0,
  ];
  tx.run(upsert("usage_sessions", SESSION_COLUMNS, "session_id"), ...values);
  return true;
}

type Stored = { session_id?: string; input: number; output: number; reasoning: number; cache_read: number; cache_write: number; cache_write_1h: number };
const total = (row: Stored) => row.input + row.output + row.reasoning + row.cache_read + row.cache_write;

/**
 * Stores one record under its key. The record is checked again here, and a session row must exist.
 * Claude and Codex keep the larger whole record. OpenCode keeps the last copy.
 */
export function writeRecord(tx: EvidenceTx, sessionId: string, record: UsageRecord): "inserted" | "replaced" | "kept" {
  const checked = ledgerRecord(record);
  if (!checked) throw new TypeError("A usage record must pass ledgerRecord before it is stored.");
  if (!tx.get("SELECT 1 AS found FROM usage_sessions WHERE session_id=?", sessionId)) throw new Error("The usage session row must exist before its records");
  const key = tx.index("usage-record", ledgerKey(checked, sessionId));
  const prior = tx.get<Stored>("SELECT session_id, input, output, reasoning, cache_read, cache_write, cache_write_1h FROM usage_records WHERE record_key=?", key);
  const next: Stored = {
    input: checked.tokens.input, output: checked.tokens.output, reasoning: checked.tokens.reasoning,
    cache_read: checked.tokens.cacheRead, cache_write: checked.tokens.cacheWrite, cache_write_1h: checked.cacheWrite1h ?? 0,
  };
  if (prior && checked.provider !== "opencode") {
    const larger = total(next) !== total(prior) ? total(next) > total(prior)
      : next.reasoning !== prior.reasoning ? next.reasoning > prior.reasoning
        : next.cache_write_1h > prior.cache_write_1h;
    if (!larger) return "kept";
  }
  const modelRef = ensureModel(tx, checked.providerId, checked.modelId);
  // A replaced Claude or Codex row keeps the session that first stored its key.
  const owner = prior && checked.provider !== "opencode" ? prior.session_id as string : sessionId;
  tx.run(upsert("usage_records", RECORD_COLUMNS, "record_key"), key, checked.provider, owner, checked.completedAt, modelRef,
    checked.modelSource, next.input, next.output, next.reasoning, next.cache_read, next.cache_write, next.cache_write_1h,
    checked.reportedCost, checked.secondary ? 1 : 0);
  return prior ? "replaced" : "inserted";
}

/**
 * Stores a briefing under its `${sessionId}/${at}` key. The record, when given, must pass ledgerRecord.
 * The last write for a key wins. Throws, with nothing written, for an invalid time, record, or project.
 */
export function writeBriefing(tx: EvidenceTx, key: string, projectId: string, at: string, record?: UsageRecord): void {
  const time = isoTime(at);
  if (!time || typeof projectId !== "string") throw new TypeError("A briefing needs a project and a valid time");
  const checked = record === undefined ? undefined : ledgerRecord(record);
  if (record !== undefined && !checked) throw new TypeError("A briefing record must pass ledgerRecord before it is stored.");
  const projectRef = ensureProject(tx, projectId);
  const modelRef = checked ? ensureModel(tx, checked.providerId, checked.modelId) : null;
  tx.run(upsert("usage_briefings", BRIEFING_COLUMNS, "briefing_key"), tx.index("usage-record", `briefing:${key}`), projectRef, time,
    modelRef, checked?.modelSource ?? null, checked?.tokens.input ?? null, checked?.tokens.output ?? null,
    checked?.tokens.reasoning ?? null, checked?.tokens.cacheRead ?? null, checked?.tokens.cacheWrite ?? null,
    checked?.reportedCost ?? null);
}

/** Opens a model's sealed names. The row key is the model's blind index. */
function modelNames(db: EvidenceDb, ref: number, cache: Map<number, { providerId: string; modelId: string }>) {
  const hit = cache.get(ref);
  if (hit) return hit;
  const row = db.get<{ model_key: string; encrypted_model: string }>("SELECT model_key, encrypted_model FROM usage_models WHERE model_ref=?", ref);
  if (!row) throw new Error("A usage record names a model that is not stored");
  const names = db.open<{ providerId: string; modelId: string }>("usage_models", row.model_key, row.encrypted_model);
  cache.set(ref, names);
  return names;
}

/** The sessions the ledger holds. Project ids are opened here, and nothing else is decrypted. */
export function readSessions(db: EvidenceDb): StoredSession[] {
  const rows = db.all<Record<string, unknown> & { encrypted_project: string }>(
    "SELECT s.*, p.encrypted_project FROM usage_sessions s JOIN usage_projects p ON p.project_ref = s.project_ref ORDER BY s.session_id",
  );
  return rows.map((row) => {
    const projectId = db.open<string>("usage_projects", row.project_ref as string, row.encrypted_project);
    const optional = <K extends string>(key: K, value: unknown) => value === null || value === undefined ? {} : { [key]: value };
    return {
      sessionId: row.session_id as string,
      provider: row.provider as Provider,
      projectId,
      createdAt: row.created_at as string,
      ...optional("lastActiveAt", row.last_active_at),
      coverage: row.coverage as UsageCoverage,
      ...optional("reason", row.coverage_reason),
      cursor: row.journal_cursor as number,
      seen: row.records_seen as number,
      refused: row.records_refused as number,
      exited: row.exited === 1,
      ...(row.journaled_coverage === null ? {} : { journaled: {
        coverage: row.journaled_coverage as UsageCoverage,
        ...optional("reason", row.journaled_reason),
        ...optional("finalDrain", row.final_drain),
      } as NonNullable<LedgerState["journaled"]> }),
      ...optional("runId", row.run_id),
      ...optional("memberId", row.member_id),
      ...optional("revision", row.revision),
      ...optional("role", row.role),
      ...optional("taskKey", row.task_key),
      ...optional("profileId", row.profile_id),
      ...optional("purpose", row.purpose),
      ...optional("configId", row.config_id),
    };
  });
}

/** Reads records by session and time. `from` is inclusive and `to` exclusive. Only usage fields come back. */
export function readRecords(db: EvidenceDb, filter: { sessionIds?: string[]; from?: string; to?: string } = {}): { sessionId: string; record: UsageRecord }[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.sessionIds) {
    if (filter.sessionIds.length === 0) return [];
    where.push(`session_id IN (${filter.sessionIds.map(() => "?").join(", ")})`);
    params.push(...filter.sessionIds);
  }
  if (filter.from !== undefined) {
    const from = isoTime(filter.from);
    if (!from) throw new TypeError("A usage time filter must be a valid time");
    where.push("completed_at >= ?");
    params.push(from);
  }
  if (filter.to !== undefined) {
    const to = isoTime(filter.to);
    if (!to) throw new TypeError("A usage time filter must be a valid time");
    where.push("completed_at < ?");
    params.push(to);
  }
  const rows = db.all<Record<string, unknown>>(
    `SELECT session_id, provider, completed_at, model_ref, model_source, input, output, reasoning, cache_read, cache_write,
      cache_write_1h, reported_cost, secondary FROM usage_records${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY completed_at, record_key`,
    ...params,
  );
  const cache = new Map<number, { providerId: string; modelId: string }>();
  return rows.map((row) => {
    const names = modelNames(db, row.model_ref as number, cache);
    const cacheWrite1h = row.cache_write_1h as number;
    const record: UsageRecord = {
      provider: row.provider as UsageRecord["provider"],
      providerId: names.providerId,
      modelId: names.modelId,
      messageId: "",
      partId: "",
      modelSource: row.model_source as UsageRecord["modelSource"],
      completedAt: row.completed_at as string,
      tokens: {
        input: row.input as number,
        output: row.output as number,
        reasoning: row.reasoning as number,
        cacheRead: row.cache_read as number,
        cacheWrite: row.cache_write as number,
      },
      reportedCost: row.reported_cost as number,
      ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
      ...(row.secondary === 1 ? { secondary: true as const } : {}),
    };
    return { sessionId: row.session_id as string, record };
  });
}

/** The briefings the ledger holds. A briefing without a record has no model or token figures. */
export function readBriefings(db: EvidenceDb): { projectId: string; at: string; record?: UsageRecord }[] {
  const rows = db.all<Record<string, unknown> & { encrypted_project: string }>(
    "SELECT b.*, p.encrypted_project FROM usage_briefings b JOIN usage_projects p ON p.project_ref = b.project_ref ORDER BY b.at, b.briefing_key",
  );
  const cache = new Map<number, { providerId: string; modelId: string }>();
  return rows.map((row) => {
    const projectId = db.open<string>("usage_projects", row.project_ref as string, row.encrypted_project);
    const at = row.at as string;
    if (row.model_ref === null) return { projectId, at };
    const names = modelNames(db, row.model_ref as number, cache);
    return { projectId, at, record: {
      provider: "opencode",
      providerId: names.providerId,
      modelId: names.modelId,
      messageId: "",
      partId: "",
      modelSource: row.model_source as UsageRecord["modelSource"],
      completedAt: at,
      tokens: {
        input: row.input as number,
        output: row.output as number,
        reasoning: row.reasoning as number,
        cacheRead: row.cache_read as number,
        cacheWrite: row.cache_write as number,
      },
      reportedCost: row.reported_cost as number,
    } };
  });
}

/** `pending` until the sealed ledger's import has been recorded, whatever its outcome. */
export function importState(db: EvidenceDb): "pending" | "done" {
  return db.get("SELECT value FROM usage_meta WHERE key=?", SEALED_IMPORT) ? "done" : "pending";
}

/**
 * Imports the sealed ledger in the caller's transaction. Only `imported` reads the ledger; `absent` and `unreadable`
 * record the outcome and nothing else. A measured session is `complete` with its cursor. Any other session is
 * `none` with `unsupported`. Sessions are written before records, and a record whose session was not imported is refused.
 */
export function importLedger(tx: EvidenceTx, ledger: SealedLedger | undefined, outcome: "imported" | "absent" | "unreadable"):
  { sessions: number; records: number; briefings: number; refused: number } {
  const counts = { sessions: 0, records: 0, briefings: 0, refused: 0 };
  if (outcome === "imported" && ledger) {
    const imported = new Set<string>();
    for (const [sessionId, session] of Object.entries(ledger.sessions)) {
      const state: LedgerState = session.measured
        ? { coverage: "complete", cursor: ledger.cursors[sessionId] ?? 0, seen: 0, refused: 0, exited: session.exited === true }
        : { coverage: "none", reason: "unsupported", cursor: 0, seen: 0, refused: 0, exited: false };
      const header: LedgerHeader = {
        sessionId,
        provider: session.provider,
        projectId: session.projectId,
        createdAt: session.createdAt,
        ...(session.lastActiveAt === undefined ? {} : { lastActiveAt: session.lastActiveAt }),
        ...(session.team === undefined ? {} : { team: session.team }),
        ...(session.profileId === undefined ? {} : { profileId: session.profileId }),
      };
      if (writeSession(tx, header, state)) {
        imported.add(sessionId);
        counts.sessions++;
      } else counts.refused++;
    }
    for (const [key, value] of Object.entries(ledger.rows)) {
      const slash = key.indexOf("/");
      const sessionId = slash > 0 ? key.slice(0, slash) : "";
      const record = ledgerRecord(value);
      if (!record || !imported.has(sessionId)) {
        counts.refused++;
        continue;
      }
      if (writeRecord(tx, sessionId, record) !== "kept") counts.records++;
    }
    for (const [key, briefing] of Object.entries(ledger.briefings)) {
      const record = briefing.record === undefined ? undefined : ledgerRecord(briefing.record);
      if ((briefing.record !== undefined && !record) || !isoTime(briefing.at) || typeof briefing.projectId !== "string") {
        counts.refused++;
        continue;
      }
      writeBriefing(tx, key, briefing.projectId, briefing.at, record);
      counts.briefings++;
    }
  }
  tx.run("INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", SEALED_IMPORT, outcome);
  return counts;
}

