import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import {
  MEMORY_RECOVERY_GENESIS_HASH,
  MemoryRecoveryCoordinator,
  MemoryRecoveryError,
  createMemoryRecoveryDelta,
  type MemoryRecoveryAppendReceipt,
  type MemoryRecoveryCheckpoint,
  type MemoryRecoveryDelta,
} from "./recovery.js";
import {
  canonicalMemoryDigest,
  canonicalMemoryJson,
  canonicalMemoryText,
  memoryError,
  memoryLexicalTerms,
  MemoryStoreError,
  MemoryUnsupportedOperationError,
  validateCursorOptions,
  validateFoundationMutation,
  validateIdentifier,
  validateMemoryRecordPayload,
} from "./policy.js";
import {
  createMemoryReadFence,
  memoryReadFenceToken,
  type AuthorizedRead,
  type MemoryAuthorizationSnapshot,
  type MemoryCurrentWorkspaceBinding,
  type MemoryLexicalQuery,
  type MemoryPageOptions,
  type MemoryPrincipalSelector,
  type MemoryPrincipalSnapshot,
  type MemoryProvisionIntent,
  type MemoryReadFence,
  type MemoryStore as MemoryStoreContract,
  type MemoryStoreOptions,
} from "./types.js";
import type {
  MemoryCapability,
  MemoryCollection,
  MemoryError,
  MemoryGrant,
  MemoryMutation,
  MemoryMutationReceipt,
  MemoryMutationResult,
  MemoryMutationStatus,
  MemoryMutationStatusResult,
  MemoryPage,
  MemoryRecord,
  MemoryRecordPayload,
  MemoryRecordResult,
  MemoryResponseBinding,
  MemorySourceEnrollment,
  MemoryWorkspace,
  MemoryWorkspaceResult,
} from "@infinite/remote";

type SqlRow = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type StoredOwnerBinding = {
  principalId: string;
  deviceId: string;
  workspaceId: string;
  bindingEpoch: number;
  grantEpoch: number;
  capabilities: MemoryCapability[];
  state: "active" | "revoked";
  intentEventId: string;
};
type StoredWorkspaceBinding = {
  workspaceId: string;
  repositoryBindings: MemoryCurrentWorkspaceBinding["repositoryBindings"];
  bindingDigest: string;
  state: MemoryWorkspace["status"];
  createdAt: string;
  updatedAt: string;
};
type StoredRecordPayload = {
  workspaceId: string;
  payload: MemoryRecordPayload;
  provenanceClass: MemoryRecord["provenanceClass"];
  authorPrincipalId: string;
  payloadDigest: string;
};
type StoredGrantPayload = { subjectId: string };
type StoredSourcePayload = Omit<MemorySourceEnrollment, "id" | "workspaceId" | "collectionId" | "status" | "revision">;
type StoredMutation = {
  state: "pending" | "committed" | "failed";
  response: MemoryMutationResult | MemoryMutationStatusResult;
  eventId: string;
  resourceKey: string;
  targetCollectionId: string | null;
  recoveryDelta?: MemoryRecoveryDelta;
};
type FenceSnapshot = {
  expiresAt: number;
  selector: MemoryPrincipalSelector;
  principalKey: string;
  principalFingerprint: string;
  workspaceId: string;
  workspaceKey: string;
  bindingEpoch: number;
  servingEpoch: number;
  grantEpoch: number;
  sourceEpoch: number;
  sourceKeys: string[];
  records: Array<{ recordKey: string; revision: number }>;
};
type MutationResultContext = { resourceId: string; resultingRevision: number; collectionIds: string[]; targetCollectionId: string | null; resourceKey: string };

const CURRENT_SCHEMA_VERSION = 1;
const CURRENT_KEY_VERSION = 1;
const MAX_WORKSPACE_RECORDS = 10_000;
const MAX_HOST_RECORDS = 100_000;
const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LEXICAL_CANDIDATES = 20;
const MAX_READ_FENCES = 2048;
const READ_FENCE_TTL_MS = 30_000;
const OWNER_CAPABILITIES: MemoryCapability[] = ["read", "propose", "review", "curate", "feedback", "share", "publish", "administer", "erase"];
const OWNER_ONLY_CAPABILITIES = new Set<MemoryCapability>(["review", "share", "publish", "administer", "curate", "erase"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_workspaces (
  workspace_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','review-required','retired')),
  object_key TEXT NOT NULL UNIQUE,
  encrypted_binding TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_owner_bindings (
  workspace_key TEXT NOT NULL REFERENCES memory_workspaces(workspace_key),
  device_key TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  intent_event_id TEXT NOT NULL UNIQUE,
  encrypted_binding TEXT NOT NULL,
  PRIMARY KEY (workspace_key, device_key)
);
CREATE TABLE IF NOT EXISTS memory_collections (
  collection_id TEXT PRIMARY KEY,
  owner_workspace_key TEXT NOT NULL REFERENCES memory_workspaces(workspace_key),
  scope TEXT NOT NULL CHECK (scope IN ('private','shared','global')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active','archived','erased')),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_records (
  record_id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL UNIQUE,
  workspace_key TEXT NOT NULL REFERENCES memory_workspaces(workspace_key),
  collection_id TEXT NOT NULL REFERENCES memory_collections(collection_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('candidate','active','superseded','invalidated','archived','erased')),
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0,1)),
  valid_from TEXT,
  valid_until TEXT,
  event_id TEXT NOT NULL,
  encrypted_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_grants (
  grant_id TEXT PRIMARY KEY,
  grant_key TEXT NOT NULL UNIQUE,
  collection_id TEXT NOT NULL REFERENCES memory_collections(collection_id),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('workspace','device','task')),
  subject_key TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  object_key TEXT NOT NULL UNIQUE,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_source_enrollments (
  source_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  workspace_key TEXT NOT NULL REFERENCES memory_workspaces(workspace_key),
  collection_id TEXT NOT NULL REFERENCES memory_collections(collection_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','active','paused','revoked','review-required')),
  binding_digest TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_record_sources (
  record_key TEXT NOT NULL REFERENCES memory_records(record_key),
  source_id TEXT NOT NULL REFERENCES memory_source_enrollments(source_id),
  source_key TEXT NOT NULL,
  source_revision_key TEXT NOT NULL,
  PRIMARY KEY (record_key, source_key, source_revision_key)
);
CREATE TABLE IF NOT EXISTS memory_record_lineage (
  record_key TEXT NOT NULL REFERENCES memory_records(record_key),
  parent_record_key TEXT NOT NULL,
  parent_revision INTEGER NOT NULL,
  PRIMARY KEY (record_key, parent_record_key, parent_revision)
);
CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_receipts (
  principal_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','committed','failed')),
  resource_key TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL,
  target_collection_id TEXT,
  committed_at TEXT,
  event_id TEXT NOT NULL UNIQUE,
  encrypted_response TEXT NOT NULL,
  PRIMARY KEY (principal_key, request_id)
);
CREATE TABLE IF NOT EXISTS memory_outbox (
  event_id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','witness-pending','ready','complete','discarded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until TEXT,
  not_before TEXT NOT NULL,
  target_object_key TEXT,
  encrypted_payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_tombstones (
  object_key TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  deletion_epoch INTEGER NOT NULL,
  time TEXT NOT NULL,
  reason_class TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_epochs (
  workspace_key TEXT PRIMARY KEY REFERENCES memory_workspaces(workspace_key),
  serving_epoch INTEGER NOT NULL CHECK (serving_epoch > 0),
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch > 0),
  source_epoch INTEGER NOT NULL CHECK (source_epoch > 0)
);
CREATE TABLE IF NOT EXISTS memory_recovery_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  head_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_pending_witness (
  event_id TEXT PRIMARY KEY,
  principal_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  object_key TEXT NOT NULL,
  action TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  prior_hash TEXT NOT NULL,
  delta_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  encrypted_context TEXT NOT NULL,
  UNIQUE (principal_key, request_id)
);
CREATE TABLE IF NOT EXISTS memory_retired_bindings (
  workspace_key TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  retired_at TEXT NOT NULL,
  PRIMARY KEY (workspace_key,binding_epoch)
);
CREATE TABLE IF NOT EXISTS memory_lexical_tokens (
  collection_id TEXT NOT NULL REFERENCES memory_collections(collection_id),
  term_hmac TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES memory_records(record_id),
  tokenizer_version INTEGER NOT NULL,
  PRIMARY KEY (collection_id, term_hmac, record_id)
);
CREATE TABLE IF NOT EXISTS memory_exact_content (
  collection_id TEXT NOT NULL REFERENCES memory_collections(collection_id),
  content_hmac TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES memory_records(record_id),
  tokenizer_version INTEGER NOT NULL,
  PRIMARY KEY (collection_id, content_hmac, record_id)
);
CREATE INDEX IF NOT EXISTS memory_collections_by_workspace ON memory_collections(owner_workspace_key,status,collection_id);
CREATE INDEX IF NOT EXISTS memory_grants_by_subject ON memory_grants(subject_kind,subject_key,state,collection_id);
CREATE UNIQUE INDEX IF NOT EXISTS memory_grants_active_subject ON memory_grants(collection_id,subject_kind,subject_key) WHERE state='active';
CREATE INDEX IF NOT EXISTS memory_records_by_workspace ON memory_records(workspace_key,collection_id,lifecycle,record_id);
CREATE INDEX IF NOT EXISTS memory_records_by_collection ON memory_records(collection_id,lifecycle,suppressed,record_id);
CREATE INDEX IF NOT EXISTS memory_records_by_validity ON memory_records(collection_id,lifecycle,valid_until,record_id);
CREATE INDEX IF NOT EXISTS memory_sources_by_workspace ON memory_source_enrollments(workspace_key,collection_id,status,source_id);
CREATE INDEX IF NOT EXISTS memory_outbox_by_target ON memory_outbox(target_object_key,state,event_id);
CREATE INDEX IF NOT EXISTS memory_record_sources_by_source ON memory_record_sources(source_id,record_key);
CREATE INDEX IF NOT EXISTS memory_lineage_by_parent ON memory_record_lineage(parent_record_key,record_key);
CREATE INDEX IF NOT EXISTS memory_lexical_lookup ON memory_lexical_tokens(collection_id,term_hmac,record_id);
CREATE INDEX IF NOT EXISTS memory_exact_lookup ON memory_exact_content(collection_id,content_hmac,record_id);
`;

function row(value: unknown): SqlRow | undefined {
  return value && typeof value === "object" ? value as SqlRow : undefined;
}

function textColumn(source: SqlRow, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`Invalid local memory column ${key}`);
  return value;
}

function numberColumn(source: SqlRow, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid local memory column ${key}`);
  return value;
}

function boolColumn(source: SqlRow, key: string): boolean { return numberColumn(source, key) === 1; }

/** Persistent canonical SQLite store. It cannot serve until fresh recovery succeeds. */
export class MemoryStoreService implements MemoryStoreContract {
  private readonly db: DatabaseSync;
  private readonly options: MemoryStoreOptions;
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;
  private readonly identifierKey: Buffer;
  private readonly cursorKey: Buffer;
  private readonly recovery?: MemoryRecoveryCoordinator;
  private readonly fences = new Map<string, FenceSnapshot>();
  private mutationTail: Promise<void> = Promise.resolve();
  private closed = false;
  private recoveryOpen = false;

  constructor(options: MemoryStoreOptions) {
    if (!options || typeof options.databasePath !== "string" || options.databasePath.length === 0
      || !Buffer.isBuffer(options.vaultKey) || options.vaultKey.length !== 32
      || typeof options.hostId !== "string" || options.hostId.length === 0) throw new TypeError("Invalid memory store options");
    this.options = options;
    this.encryptionKey = this.deriveKey("row-encryption");
    this.indexKey = this.deriveKey("lexical-index");
    this.identifierKey = this.deriveKey("opaque-identifiers");
    this.cursorKey = this.deriveKey("cursor-authentication");
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.databasePath);
    chmodSync(options.databasePath, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000;");
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION};`);
    this.ensureStoreMetadata();
    if (options.recoveryWitness && options.recoveryPublicKey) {
      this.recovery = new MemoryRecoveryCoordinator({
        witness: options.recoveryWitness,
        pinnedPublicKey: options.recoveryPublicKey,
        readCheckpoint: () => this.recoveryCheckpoint(),
        applyDeltas: (deltas, checkpoint) => this.applyWitnessDeltas(deltas, checkpoint),
      });
    }
  }

  async openRecovery(): Promise<void> {
    this.assertOpen();
    this.recoveryOpen = false;
    if (!this.recovery) throw new MemoryRecoveryError("recovery_required", "Fresh recovery witness is not configured.", false);
    await this.recovery.reconcileFresh();
    this.recoveryOpen = this.recovery.isReady;
  }

  get recoveryReady(): boolean { return !this.closed && this.recoveryOpen && this.recovery?.isReady === true; }

  private deriveKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.options.vaultKey, Buffer.from("infinite-memory-kdf-v1"), Buffer.from(`infinite-memory:${purpose}:v${CURRENT_KEY_VERSION}`), 32));
  }

  private ensureStoreMetadata(): void {
    const version = this.one("SELECT value FROM memory_meta WHERE key='key_version'");
    if (version && version.value !== String(CURRENT_KEY_VERSION)) throw new Error("Unsupported memory key version");
    this.run("INSERT OR IGNORE INTO memory_meta(key,value) VALUES('key_version',?)", String(CURRENT_KEY_VERSION));
    const schemaVersion = this.one("SELECT value FROM memory_meta WHERE key='schema_version'");
    if (schemaVersion && schemaVersion.value !== String(CURRENT_SCHEMA_VERSION)) throw new Error("Unsupported memory schema version");
    this.run("INSERT OR IGNORE INTO memory_meta(key,value) VALUES('schema_version',?)", String(CURRENT_SCHEMA_VERSION));
    this.run("INSERT OR IGNORE INTO memory_recovery_state(singleton,sequence,head_hash) VALUES(1,0,?)", MEMORY_RECOVERY_GENESIS_HASH);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory store is closed");
  }

  private assertRecovery(): void {
    this.assertOpen();
    if (!this.recoveryReady) throw memoryError("recovery_required", "Protected memory is closed pending fresh recovery.");
  }

  private one(sql: string, ...values: SQLInputValue[]): SqlRow | undefined {
    return row(this.db.prepare(sql).get(...values));
  }

  private all(sql: string, ...values: SQLInputValue[]): SqlRow[] {
    return (this.db.prepare(sql).all(...values) as unknown[]).map(value => row(value)).filter((value): value is SqlRow => value !== undefined);
  }

  private run(sql: string, ...values: SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original transaction failure */ }
      throw error;
    }
  }

  private timestamp(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }

  private opaque(purpose: string, value: string): string {
    return createHmac("sha256", this.identifierKey).update(`${purpose}\u0000${value}`, "utf8").digest("hex");
  }

  private workspaceKey(workspaceId: string): string { return this.opaque("workspace", workspaceId); }
  private principalKey(principalId: string): string { return this.opaque("principal", principalId); }
  private deviceKey(deviceId: string): string { return this.opaque("device", deviceId); }
  private taskKey(taskBindingId: string): string { return this.opaque("task", taskBindingId); }
  private recordKey(recordId: string): string { return this.opaque("record", recordId); }
  private collectionObjectKey(collectionId: string): string { return this.opaque("collection", collectionId); }
  private grantObjectKey(grantId: string): string { return this.opaque("grant", grantId); }
  private sourceObjectKey(sourceId: string): string { return this.opaque("source", sourceId); }

  private subjectKey(kind: "workspace" | "device" | "task", id: string): string {
    return this.opaque(`subject-${kind}`, id);
  }

  private seal(table: string, id: string, revision: number, value: unknown): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`infinite:memory:v${CURRENT_KEY_VERSION}:${table}:${id}:${revision}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(canonicalMemoryJson(value), "utf8"), cipher.final()]);
    return JSON.stringify({ v: CURRENT_KEY_VERSION, n: nonce.toString("base64"), c: encrypted.toString("base64"), t: cipher.getAuthTag().toString("base64") });
  }

  private unseal<T>(table: string, id: string, revision: number, value: string): T {
    const envelope: unknown = JSON.parse(value);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid encrypted memory envelope");
    const data = envelope as Record<string, unknown>;
    if (data.v !== CURRENT_KEY_VERSION || typeof data.n !== "string" || typeof data.c !== "string" || typeof data.t !== "string") throw new Error("Unsupported encrypted memory envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(data.n, "base64"));
    decipher.setAAD(Buffer.from(`infinite:memory:v${CURRENT_KEY_VERSION}:${table}:${id}:${revision}`, "utf8"));
    decipher.setAuthTag(Buffer.from(data.t, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data.c, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as T;
  }

  private digestTerms(collectionId: string, term: string): string {
    return createHmac("sha256", this.indexKey).update(`${collectionId}\u0000term\u0000${term}`, "utf8").digest("hex");
  }

  private digestExact(collectionId: string, value: string): string {
    return createHmac("sha256", this.indexKey).update(`${collectionId}\u0000exact\u0000${canonicalMemoryText(value)}`, "utf8").digest("hex");
  }

  private recoveryCheckpoint(): MemoryRecoveryCheckpoint {
    const current = this.one("SELECT sequence,head_hash FROM memory_recovery_state WHERE singleton=1");
    if (!current) throw new Error("Missing local recovery checkpoint");
    return { sequence: numberColumn(current, "sequence"), headHash: textColumn(current, "head_hash") };
  }

  private sizeBytes(): number {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { total += statSync(`${this.options.databasePath}${suffix}`).size; } catch { /* file not created yet */ }
    }
    return total;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private currentPrincipal(selector: MemoryPrincipalSelector): MemoryPrincipalSnapshot {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)
      || (selector.kind === "device" && (Object.keys(selector).length !== 2 || typeof selector.deviceId !== "string"))
      || (selector.kind === "task" && (Object.keys(selector).length !== 2 || typeof selector.taskBindingId !== "string"))
      || (selector.kind !== "device" && selector.kind !== "task")) throw memoryError("unauthenticated", "The current memory principal is unavailable.");
    let principal: MemoryPrincipalSnapshot | undefined;
    try { principal = this.options.resolvePrincipal(selector); } catch { /* authentication callbacks fail closed */ }
    const now = (this.options.now ?? Date.now)();
    const expiry = principal?.expiresAt === undefined ? Number.NaN : Date.parse(principal.expiresAt);
    const malformedTask = principal?.kind === "task" && (
      !principal.taskBindingId || !principal.workspaceId
      || !Array.isArray(principal.collectionIds) || principal.collectionIds.some(id => typeof id !== "string")
      || new Set(principal.collectionIds).size !== principal.collectionIds.length
      || !Number.isSafeInteger(principal.bindingEpoch) || (principal.bindingEpoch ?? 0) < 1
      || !Number.isSafeInteger(principal.grantEpoch) || (principal.grantEpoch ?? 0) < 1
      || !Array.isArray(principal.allowedActions) || principal.allowedActions.some(action => typeof action !== "string")
      || new Set(principal.allowedActions).size !== principal.allowedActions.length
      || !Array.isArray(principal.allowedRecallModes) || principal.allowedRecallModes.some(mode => !["exact", "lexical", "hybrid"].includes(mode))
      || new Set(principal.allowedRecallModes).size !== principal.allowedRecallModes.length
      || !Number.isFinite(expiry));
    if (!principal || principal.state !== "active" || !principal.principalId
      || principal.kind !== selector.kind
      || (selector.kind === "device" && principal.deviceId !== selector.deviceId)
      || (selector.kind === "task" && principal.taskBindingId !== selector.taskBindingId)
      || (principal.expiresAt !== undefined && (!Number.isFinite(expiry) || expiry <= now))
      || (principal.kind === "task" && (malformedTask || expiry <= now))) {
      throw memoryError("unauthenticated", "The current memory principal is unavailable.");
    }
    return structuredClone(principal);
  }

  private requireTaskAction(principal: MemoryPrincipalSnapshot, action: string): void {
    if (principal.kind === "task" && !principal.allowedActions?.includes(action)) throw memoryError("not_found", "The memory resource is unavailable.");
  }

  private requireTaskRecall(principal: MemoryPrincipalSnapshot, mode?: "exact" | "lexical"): void {
    if (principal.kind !== "task") return;
    this.requireTaskAction(principal, "recall");
    if (!principal.allowedRecallModes?.length || (mode !== undefined && !principal.allowedRecallModes.includes(mode))) {
      throw memoryError("not_found", "The memory resource is unavailable.");
    }
  }

  private requireTaskCollection(principal: MemoryPrincipalSnapshot, collectionId: string): void {
    if (principal.kind === "task" && !principal.collectionIds?.includes(collectionId)) throw memoryError("not_found", "The memory collection is unavailable.");
  }

  private currentBinding(workspaceId: string): MemoryCurrentWorkspaceBinding {
    let binding: MemoryCurrentWorkspaceBinding | undefined;
    try { binding = this.options.resolveWorkspaceBinding(workspaceId); } catch { /* lookup failures fail closed */ }
    if (!binding || binding.workspaceId !== workspaceId || !Number.isSafeInteger(binding.bindingEpoch) || binding.bindingEpoch < 1
      || !/^[a-f0-9]{64}$/.test(binding.bindingDigest)
      || !["active", "review-required", "retired"].includes(binding.state)) {
      throw memoryError("not_found", "The memory workspace is unavailable.");
    }
    return structuredClone(binding);
  }

  private workspaceRow(workspaceId: string): SqlRow {
    const workspace = this.one("SELECT * FROM memory_workspaces WHERE workspace_key=?", this.workspaceKey(workspaceId));
    if (!workspace) throw memoryError("not_found", "The memory workspace is unavailable.");
    return workspace;
  }

  private workspaceIdFromKey(workspaceKey: string): string {
    const workspace = this.one("SELECT revision,encrypted_binding FROM memory_workspaces WHERE workspace_key=?", workspaceKey);
    if (!workspace) throw memoryError("not_found", "The memory workspace is unavailable.");
    const stored = this.unseal<StoredWorkspaceBinding>("memory_workspaces", workspaceKey, numberColumn(workspace, "revision"), textColumn(workspace, "encrypted_binding"));
    return stored.workspaceId;
  }

  private epochs(workspaceKey: string): { servingEpoch: number; grantEpoch: number; sourceEpoch: number } {
    const value = this.one("SELECT serving_epoch,grant_epoch,source_epoch FROM memory_epochs WHERE workspace_key=?", workspaceKey);
    if (!value) throw memoryError("recovery_required", "Memory authorization state is unavailable.");
    return {
      servingEpoch: numberColumn(value, "serving_epoch"),
      grantEpoch: numberColumn(value, "grant_epoch"),
      sourceEpoch: numberColumn(value, "source_epoch"),
    };
  }

  private workspaceView(workspaceId: string, workspace: SqlRow, current: MemoryCurrentWorkspaceBinding): MemoryWorkspace {
    const key = textColumn(workspace, "workspace_key");
    const revision = numberColumn(workspace, "revision");
    const stored = this.unseal<StoredWorkspaceBinding>("memory_workspaces", key, revision, textColumn(workspace, "encrypted_binding"));
    const bindingMatches = numberColumn(workspace, "binding_epoch") === current.bindingEpoch && stored.bindingDigest === current.bindingDigest;
    const status = textColumn(workspace, "state") === "retired" || current.state === "retired"
      ? "retired"
      : bindingMatches && current.state === "active" ? "active" : "review-required";
    return {
      workspaceId,
      revision,
      bindingEpoch: numberColumn(workspace, "binding_epoch"),
      repositoryBindings: structuredClone(stored.repositoryBindings),
      status,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private ownerBinding(workspaceKey: string, principal: MemoryPrincipalSnapshot): StoredOwnerBinding | undefined {
    if (principal.kind !== "device" || principal.deviceRole !== "owner" || !principal.deviceId) return undefined;
    const binding = this.one("SELECT * FROM memory_owner_bindings WHERE workspace_key=? AND device_key=? AND state='active'", workspaceKey, this.deviceKey(principal.deviceId));
    if (!binding) return undefined;
    const epoch = numberColumn(binding, "grant_epoch");
    return this.unseal<StoredOwnerBinding>("memory_owner_bindings", `${workspaceKey}:${textColumn(binding, "device_key")}`, epoch, textColumn(binding, "encrypted_binding"));
  }

  private requireOwnerBinding(workspaceKey: string, principal: MemoryPrincipalSnapshot, capability: MemoryCapability): StoredOwnerBinding {
    if (principal.kind !== "device" || principal.deviceRole !== "owner") throw memoryError("not_found", "The memory resource is unavailable.");
    const binding = this.ownerBinding(workspaceKey, principal);
    if (!binding || binding.state !== "active" || !binding.capabilities.includes(capability)) throw memoryError("not_found", "The memory resource is unavailable.");
    return binding;
  }

  private ownerBindingRow(workspaceKey: string, deviceId: string): SqlRow | undefined {
    return this.one("SELECT * FROM memory_owner_bindings WHERE workspace_key=? AND device_key=? AND state='active'", workspaceKey, this.deviceKey(deviceId));
  }

  private requireCollectionCapability(
    principal: MemoryPrincipalSnapshot,
    workspaceId: string,
    collectionId: string,
    capability: MemoryCapability,
  ): { row: SqlRow; grant: SqlRow; capabilities: MemoryCapability[] } {
    this.requireTaskCollection(principal, collectionId);
    const collection = this.one("SELECT * FROM memory_collections WHERE collection_id=?", collectionId);
    if (!collection || textColumn(collection, "owner_workspace_key") !== this.workspaceKey(workspaceId)
      || textColumn(collection, "status") !== "active"
      || this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", textColumn(collection, "object_key"))) {
      throw memoryError("not_found", "The memory collection is unavailable.");
    }
    const authorized = this.directGrant(principal, workspaceId, collectionId);
    if (!authorized || !authorized.capabilities.includes(capability)) throw memoryError("not_found", "The memory collection is unavailable.");
    return { row: collection, grant: authorized.row, capabilities: authorized.capabilities };
  }

  private authorizeMutation(principal: MemoryPrincipalSnapshot, workspaceId: string, workspaceKey: string, operation: MemoryMutation["op"]): string | null {
    switch (operation.type) {
      case "collection_create":
        this.requireOwnerBinding(workspaceKey, principal, "administer");
        return null;
      case "record_create":
        this.requireCurrentOwner(principal);
        this.requireCollectionCapability(principal, workspaceId, operation.collectionId, "curate");
        return operation.collectionId;
      case "record_propose":
        this.requireTaskAction(principal, "record_propose");
        this.requireCollectionCapability(principal, workspaceId, operation.collectionId, "propose");
        return operation.collectionId;
      case "grant_set":
      case "grant_revoke":
        this.requireCurrentOwner(principal);
        if (operation.type === "grant_set") {
          if (operation.subjectKind === "workspace") throw new MemoryUnsupportedOperationError("workspace-subject grant consumption");
          this.requireCollectionCapability(principal, workspaceId, operation.collectionId, "share");
          return operation.collectionId;
        } else {
          const grant = this.one("SELECT collection_id FROM memory_grants WHERE grant_id=?", operation.grantId);
          if (!grant) throw memoryError("not_found", "The memory grant is unavailable.");
          const collectionId = textColumn(grant, "collection_id");
          this.requireCollectionCapability(principal, workspaceId, collectionId, "share");
          return collectionId;
        }
      case "source_enroll":
        this.requireCurrentOwner(principal);
        this.requireOwnerBinding(workspaceKey, principal, "administer");
        this.requireCollectionCapability(principal, workspaceId, operation.collectionId, "administer");
        return operation.collectionId;
      case "source_pause":
      case "source_revoke": {
        this.requireCurrentOwner(principal);
        const source = this.one("SELECT collection_id,workspace_key FROM memory_source_enrollments WHERE source_id=?", operation.sourceEnrollmentId);
        if (!source || textColumn(source, "workspace_key") !== workspaceKey) throw memoryError("not_found", "The memory source is unavailable.");
        const collectionId = textColumn(source, "collection_id");
        this.requireCollectionCapability(principal, workspaceId, collectionId, "administer");
        this.requireOwnerBinding(workspaceKey, principal, "administer");
        return collectionId;
      }
      case "record_archive":
      case "record_erase": {
        this.requireCurrentOwner(principal);
        const target = this.one("SELECT collection_id,workspace_key FROM memory_records WHERE record_id=?", operation.recordId);
        if (!target || textColumn(target, "workspace_key") !== workspaceKey) throw memoryError("not_found", "The memory record is unavailable.");
        const collectionId = textColumn(target, "collection_id");
        this.requireCollectionCapability(principal, workspaceId, collectionId, operation.type === "record_erase" ? "erase" : "curate");
        return collectionId;
      }
      case "workspace_review_binding":
        this.requireOwnerBinding(workspaceKey, principal, "administer");
        return null;
      default:
        throw new MemoryUnsupportedOperationError(operation.type);
    }
  }

  private checkRecordQuotas(workspaceKey: string): void {
    const workspaceCount = this.one("SELECT COUNT(*) AS count FROM memory_records WHERE workspace_key=?", workspaceKey);
    const hostCount = this.one("SELECT COUNT(*) AS count FROM memory_records");
    if (!workspaceCount || !hostCount) throw memoryError("recovery_required", "Memory record accounting is unavailable.");
    if (numberColumn(workspaceCount, "count") >= MAX_WORKSPACE_RECORDS || numberColumn(hostCount, "count") >= MAX_HOST_RECORDS || this.sizeBytes() >= MAX_DATABASE_BYTES) {
      throw memoryError("quota_exceeded", "Canonical memory capacity is full.");
    }
  }

  private validateRecordLineage(principal: MemoryPrincipalSnapshot, workspaceId: string, collectionId: string, payload: MemoryRecordPayload): void {
    if (payload.sourceRefs.length) throw new MemoryUnsupportedOperationError("source-backed record writes");
    if (principal.kind === "task" && payload.derivedFrom.length === 0) throw memoryError("invalid_request", "Task proposals require revision-addressed evidence lineage.");
    this.requireTaskCollection(principal, collectionId);
    const now = (this.options.now ?? Date.now)();
    for (const ref of payload.derivedFrom) {
      const parent = this.one("SELECT * FROM memory_records WHERE record_id=? AND collection_id=?", ref.recordId, collectionId);
      if (!parent || numberColumn(parent, "revision") !== ref.recordRevision
        || !this.recordEligible(parent, now)
        || !this.directGrant(principal, workspaceId, collectionId)?.capabilities.includes("read")) {
        throw memoryError("not_found", "The referenced memory evidence is unavailable.");
      }
    }
  }

  private createResponseBinding(principal: MemoryPrincipalSnapshot, workspaceId: string, bindingEpoch: number, collectionId: string | null, requestId: string): MemoryResponseBinding {
    return this.responseBinding(principal, workspaceId, bindingEpoch, collectionId ? [collectionId] : [], requestId);
  }

  private committedMutation(input: {
    actor: MemoryPrincipalSnapshot;
    request: MemoryMutation;
    requestDigest: string;
    workspaceId: string;
    workspaceKey: string;
    eventId: string;
    context: MutationResultContext;
    bindingEpoch: number;
    timestamp: string;
  }): MemoryMutationResult {
    const receipt: MemoryMutationReceipt = {
      requestId: input.request.requestId,
      payloadDigest: input.requestDigest,
      operation: input.request.op.type,
      outcome: "committed",
      resourceId: input.context.resourceId,
      resultingRevision: input.context.resultingRevision,
      committedAt: input.timestamp,
    };
    const result: MemoryMutationResult = {
      binding: this.createResponseBinding(input.actor, input.workspaceId, input.bindingEpoch, input.context.targetCollectionId, input.request.requestId),
      receipt,
    };
    const stored: StoredMutation = {
      state: "committed",
      response: result,
      eventId: input.eventId,
      resourceKey: input.context.resourceKey,
      targetCollectionId: input.context.targetCollectionId,
    };
    this.run("INSERT INTO memory_receipts(principal_key,request_id,workspace_key,payload_digest,operation,state,resource_key,resulting_revision,target_collection_id,committed_at,event_id,encrypted_response) VALUES(?,?,?,?,?,'committed',?,?,?,?,?,?)",
      this.principalKey(input.actor.principalId), input.request.requestId, input.workspaceKey, input.requestDigest, input.request.op.type,
      input.context.resourceKey, input.context.resultingRevision, input.context.targetCollectionId, input.timestamp, input.eventId,
      this.seal("memory_receipts", input.request.requestId, input.context.resultingRevision, stored));
    return result;
  }

  private replayMutation(rowValue: SqlRow): StoredMutation {
    return this.unseal<StoredMutation>("memory_receipts", textColumn(rowValue, "request_id"), numberColumn(rowValue, "resulting_revision"), textColumn(rowValue, "encrypted_response"));
  }

  mutate(input: { actor: MemoryPrincipalSelector; workspaceId: string; request: MemoryMutation }): Promise<AuthorizedRead<MemoryMutationResult | MemoryMutationStatusResult>> {
    return this.enqueueMutation(() => this.mutateInternal(input));
  }

  private async mutateInternal(input: { actor: MemoryPrincipalSelector; workspaceId: string; request: MemoryMutation }): Promise<AuthorizedRead<MemoryMutationResult | MemoryMutationStatusResult>> {
    this.assertRecovery();
    const principal = this.currentPrincipal(input.actor);
    validateIdentifier(input.workspaceId, "workspaceId");
    const request = validateFoundationMutation(input.request);
    const requestDigest = canonicalMemoryDigest({ operation: "mutation", workspaceId: input.workspaceId, request });
    const access = this.assertWorkspaceAccess(principal, input.workspaceId, { allowBindingReview: request.op.type === "workspace_review_binding" });
    this.assertBindingForMutation(access.row, access.binding, request.expectedBindingEpoch, request.op);
    const targetCollectionId = this.authorizeMutation(principal, input.workspaceId, access.workspaceKey, request.op);
    const principalKey = this.principalKey(principal.principalId);
    const previous = this.one("SELECT * FROM memory_receipts WHERE principal_key=? AND request_id=?", principalKey, request.requestId);
    if (previous) {
      if (textColumn(previous, "payload_digest") !== requestDigest) throw memoryError("idempotency_key_reused", "This request ID is already bound to a different mutation.", { requestId: request.requestId });
      if (textColumn(previous, "state") === "pending") await this.flushPendingWitnessQueue();
      const current = this.one("SELECT * FROM memory_receipts WHERE principal_key=? AND request_id=?", principalKey, request.requestId);
      if (!current) throw memoryError("recovery_required", "Mutation receipt disappeared during retry.");
      const stored = this.replayMutation(current);
      const response = stored.response;
      const binding = this.currentBinding(input.workspaceId);
      const responseValue = "binding" in response ? { ...response, binding: { ...response.binding, bindingEpoch: binding.bindingEpoch } } : response;
      return this.authorized(responseValue, input.actor, principal, input.workspaceId, access.workspaceKey, binding.bindingEpoch);
    }

    const eventId = randomUUID();
    const timestamp = this.timestamp();
    let pendingResponse: MemoryMutationStatusResult | undefined;
    let resultContext: MutationResultContext | undefined;
    this.transaction(() => {
      const workspace = this.workspaceRow(input.workspaceId);
      if (numberColumn(workspace, "revision") !== numberColumn(access.row, "revision")) throw memoryError("stale_revision", "The memory workspace changed. Reload and retry with a new request ID.", { currentRevision: numberColumn(workspace, "revision") });
      const operation = request.op;
      let recoveryAction: MemoryRecoveryDelta["action"] | undefined;
      let objectKey = "";
      let resourceId = "";
      let resourceKey = "";
      let resultingRevision = 1;
      let affectedCollectionId = targetCollectionId;
      let payloadDigest = requestDigest;

      switch (operation.type) {
        case "collection_create": {
          this.assertExpectedRevision(request.expectedRevision, numberColumn(workspace, "revision"));
          const owner = this.requireOwnerBinding(access.workspaceKey, principal, "administer");
          const collectionId = randomUUID();
          const collectionKey = this.collectionObjectKey(collectionId);
          const deviceId = principal.deviceId!;
          const grantId = randomUUID();
          const subjectKey = this.subjectKey("device", deviceId);
          const grantObjectKey = this.grantObjectKey(grantId);
          const grant: MemoryGrant = { id: grantId, collectionId, subjectKind: "device", subjectId: deviceId, capabilities: [...owner.capabilities].sort(), revision: 1, grantEpoch: 1, state: "active" };
          const now = timestamp;
          this.run("INSERT INTO memory_collections(collection_id,owner_workspace_key,scope,revision,status,object_key,created_at,updated_at) VALUES(?,?,?,1,'active',?,?,?)",
            collectionId, access.workspaceKey, operation.scope, collectionKey, now, now);
          this.run("INSERT INTO memory_grants(grant_id,grant_key,collection_id,subject_kind,subject_key,capabilities,revision,grant_epoch,state,object_key,encrypted_payload,created_at) VALUES(?,?,?,'device',?,?,1,1,'active',?,?,?)",
            grantId, this.opaque("grant", grantId), collectionId, subjectKey, JSON.stringify(grant.capabilities), grantObjectKey,
            this.seal("memory_grants", grantId, 1, { subjectId: deviceId }), now);
          const nextWorkspaceRevision = this.reviseWorkspace(workspace, access.binding, "active");
          this.bumpEpochs(access.workspaceKey, { serving: true, grant: true });
          this.emitEvent(eventId, access.workspaceKey, collectionKey, operation.type, requestDigest, timestamp);
          resultContext = { resourceId: collectionId, resultingRevision: 1, collectionIds: [collectionId], targetCollectionId: collectionId, resourceKey: collectionKey };
          this.committedMutation({ actor: principal, request, requestDigest, workspaceId: input.workspaceId, workspaceKey: access.workspaceKey, eventId, context: resultContext, bindingEpoch: access.binding.bindingEpoch, timestamp });
          void nextWorkspaceRevision;
          break;
        }
        case "record_create":
        case "record_propose": {
          const collection = this.requireCollectionCapability(principal, input.workspaceId, operation.collectionId, operation.type === "record_create" ? "curate" : "propose");
          if (textColumn(collection.row, "scope") === "global") throw memoryError("invalid_request", "Global collections accept only reviewed sanitized publication.");
          this.assertExpectedRevision(request.expectedRevision, numberColumn(collection.row, "revision"));
          const payload = validateMemoryRecordPayload(operation.payload);
          this.validateRecordLineage(principal, input.workspaceId, operation.collectionId, payload);
          this.checkRecordQuotas(access.workspaceKey);
          const recordId = randomUUID();
          const recordKey = this.recordKey(recordId);
          const recordDigest = this.recordPayloadDigest(payload);
          const record: StoredRecordPayload = {
            workspaceId: input.workspaceId,
            payload,
            provenanceClass: operation.type === "record_create" ? "owner-authored" : principal.kind === "task" ? "model-candidate" : "owner-authored",
            authorPrincipalId: principal.principalId,
            payloadDigest: recordDigest,
          };
          const lifecycle = operation.type === "record_create" ? "active" : "candidate";
          this.run("INSERT INTO memory_records(record_id,record_key,workspace_key,collection_id,revision,lifecycle,suppressed,valid_from,valid_until,event_id,encrypted_payload,created_at,updated_at) VALUES(?,?,?,?,1,?,0,?,?,?,?,?,?)",
            recordId, recordKey, access.workspaceKey, operation.collectionId, lifecycle, payload.validFrom, payload.validUntil, eventId,
            this.seal("memory_records", recordId, 1, record), timestamp, timestamp);
          for (const edge of payload.derivedFrom) this.run("INSERT INTO memory_record_lineage(record_key,parent_record_key,parent_revision) VALUES(?,?,?)", recordKey, this.recordKey(edge.recordId), edge.recordRevision);
          this.putRecordTokens(operation.collectionId, recordId, payload);
          this.run("UPDATE memory_collections SET revision=revision+1,updated_at=? WHERE collection_id=?", timestamp, operation.collectionId);
          this.bumpEpochs(access.workspaceKey, { serving: true });
          this.emitEvent(eventId, access.workspaceKey, recordKey, operation.type, recordDigest, timestamp);
          this.enqueueOutbox(eventId, access.workspaceKey, "projection-refresh", recordDigest, { collectionId: operation.collectionId, recordId, revision: 1, payload: record }, "pending", recordKey);
          resultContext = { resourceId: recordId, resultingRevision: 1, collectionIds: [operation.collectionId], targetCollectionId: operation.collectionId, resourceKey: recordKey };
          this.committedMutation({ actor: principal, request, requestDigest, workspaceId: input.workspaceId, workspaceKey: access.workspaceKey, eventId, context: resultContext, bindingEpoch: access.binding.bindingEpoch, timestamp });
          break;
        }
        case "grant_set": {
          const collection = this.requireCollectionCapability(principal, input.workspaceId, operation.collectionId, "share");
          this.assertExpectedRevision(request.expectedRevision, numberColumn(collection.row, "revision"));
          const sourceCapabilities = collection.capabilities;
          const capabilities = operation.capabilities;
          if (capabilities.some(capability => !sourceCapabilities.includes(capability))
            || ((operation.subjectKind === "workspace" || operation.subjectKind === "task") && capabilities.some(capability => OWNER_ONLY_CAPABILITIES.has(capability)))) {
            throw memoryError("not_found", "The memory collection is unavailable.");
          }
          const subjectKey = this.subjectKey(operation.subjectKind, operation.subjectId);
          const prior = this.one("SELECT * FROM memory_grants WHERE collection_id=? AND subject_kind=? AND subject_key=? AND state='active'", operation.collectionId, operation.subjectKind, subjectKey);
          let grantId: string;
          let revision: number;
          let grantEpoch: number;
          let grantObjectKey: string;
          if (prior) {
            const previousCapabilities = JSON.parse(textColumn(prior, "capabilities")) as MemoryCapability[];
            if (previousCapabilities.some(capability => !capabilities.includes(capability))) throw memoryError("invalid_request", "Capability reductions require an explicit grant revocation.");
            grantId = textColumn(prior, "grant_id");
            revision = numberColumn(prior, "revision") + 1;
            grantEpoch = numberColumn(prior, "grant_epoch") + 1;
            grantObjectKey = textColumn(prior, "object_key");
            const oldPayload = this.unseal<StoredGrantPayload>("memory_grants", grantId, revision - 1, textColumn(prior, "encrypted_payload"));
            this.run("UPDATE memory_grants SET capabilities=?,revision=?,grant_epoch=?,encrypted_payload=? WHERE grant_id=?",
              JSON.stringify(capabilities), revision, grantEpoch, this.seal("memory_grants", grantId, revision, oldPayload), grantId);
          } else {
            grantId = randomUUID();
            revision = 1;
            grantEpoch = 1;
            grantObjectKey = this.grantObjectKey(grantId);
            this.run("INSERT INTO memory_grants(grant_id,grant_key,collection_id,subject_kind,subject_key,capabilities,revision,grant_epoch,state,object_key,encrypted_payload,created_at) VALUES(?,?,?,?,?,?,1,1,'active',?,?,?)",
              grantId, this.opaque("grant", grantId), operation.collectionId, operation.subjectKind, subjectKey, JSON.stringify(capabilities), grantObjectKey,
              this.seal("memory_grants", grantId, 1, { subjectId: operation.subjectId }), timestamp);
          }
          this.run("UPDATE memory_collections SET revision=revision+1,updated_at=? WHERE collection_id=?", timestamp, operation.collectionId);
          this.bumpEpochs(access.workspaceKey, { serving: true, grant: true });
          this.emitEvent(eventId, access.workspaceKey, grantObjectKey, operation.type, requestDigest, timestamp);
          this.enqueueOutbox(eventId, access.workspaceKey, "authorization-refresh", requestDigest, { collectionId: operation.collectionId, grantId, grantEpoch });
          resultContext = { resourceId: grantId, resultingRevision: revision, collectionIds: [operation.collectionId], targetCollectionId: operation.collectionId, resourceKey: grantObjectKey };
          this.committedMutation({ actor: principal, request, requestDigest, workspaceId: input.workspaceId, workspaceKey: access.workspaceKey, eventId, context: resultContext, bindingEpoch: access.binding.bindingEpoch, timestamp });
          break;
        }
        case "grant_revoke": {
          const grant = this.one("SELECT * FROM memory_grants WHERE grant_id=?", operation.grantId);
          if (!grant) throw memoryError("not_found", "The memory grant is unavailable.");
          this.assertExpectedRevision(request.expectedRevision, numberColumn(grant, "revision"));
          const grantId = textColumn(grant, "grant_id");
          const collectionId = textColumn(grant, "collection_id");
          const currentRevision = numberColumn(grant, "revision");
          const revision = currentRevision + 1;
          const grantEpoch = numberColumn(grant, "grant_epoch") + 1;
          const grantObjectKey = textColumn(grant, "object_key");
          const payload = this.unseal<StoredGrantPayload>("memory_grants", grantId, currentRevision, textColumn(grant, "encrypted_payload"));
          this.run("UPDATE memory_grants SET state='revoked',revision=?,grant_epoch=?,encrypted_payload=? WHERE grant_id=?", revision, grantEpoch,
            this.seal("memory_grants", grantId, revision, payload), grantId);
          this.run("UPDATE memory_collections SET revision=revision+1,updated_at=? WHERE collection_id=?", timestamp, collectionId);
          this.bumpEpochs(access.workspaceKey, { serving: true, grant: true });
          this.run("INSERT OR IGNORE INTO memory_tombstones(object_key,workspace_key,deletion_epoch,time,reason_class) VALUES(?,?,?,?,?)", grantObjectKey, access.workspaceKey, this.epochs(access.workspaceKey).servingEpoch, timestamp, "grant-revoke");
          this.emitEvent(eventId, access.workspaceKey, grantObjectKey, operation.type, requestDigest, timestamp);
          this.enqueueOutbox(eventId, access.workspaceKey, "authorization-invalidation", requestDigest, { grantId, collectionId }, "witness-pending");
          resourceId = grantId; resourceKey = grantObjectKey; resultingRevision = revision; affectedCollectionId = collectionId; objectKey = grantObjectKey; recoveryAction = "grant-revoke";
          break;
        }
        case "source_enroll": {
          if (operation.processingPolicy.mode === "configured_external" && !this.options.isProcessingPolicyConfigured?.(operation.processingPolicy)) {
            throw new MemoryUnsupportedOperationError("unconfigured external source processing");
          }
          const workspaceRevision = numberColumn(workspace, "revision");
          this.assertExpectedRevision(request.expectedRevision, workspaceRevision);
          const collection = this.requireCollectionCapability(principal, input.workspaceId, operation.collectionId, "administer");
          if (textColumn(collection.row, "scope") === "global") throw memoryError("invalid_request", "Global collections accept only reviewed sanitized publication.");
          const sourceId = randomUUID();
          const sourceKey = this.opaque("source-enrollment", sourceId);
          const sourceObjectKey = this.sourceObjectKey(sourceId);
          const storedSource: StoredSourcePayload = {
            sourceType: operation.sourceType,
            stableSourceId: operation.stableSourceId,
            bindingDigest: access.binding.bindingDigest,
            allowedFields: operation.allowedFields,
            processingPolicy: operation.processingPolicy,
            retentionPolicy: operation.retentionPolicy,
            enrolledByPrincipal: principal.principalId,
            enrolledAt: timestamp,
          };
          this.run("INSERT INTO memory_source_enrollments(source_id,source_key,workspace_key,collection_id,revision,source_epoch,status,binding_digest,object_key,encrypted_payload,created_at,updated_at) VALUES(?,?,?, ?,1,1,'pending',?,?, ?,?,?)",
            sourceId, sourceKey, access.workspaceKey, operation.collectionId, access.binding.bindingDigest, sourceObjectKey,
            this.seal("memory_source_enrollments", sourceId, 1, storedSource), timestamp, timestamp);
          this.reviseWorkspace(workspace, access.binding, "active");
          this.bumpEpochs(access.workspaceKey, { serving: true, source: true });
          this.emitEvent(eventId, access.workspaceKey, sourceObjectKey, operation.type, requestDigest, timestamp);
          resultContext = { resourceId: sourceId, resultingRevision: 1, collectionIds: [operation.collectionId], targetCollectionId: operation.collectionId, resourceKey: sourceObjectKey };
          this.committedMutation({ actor: principal, request, requestDigest, workspaceId: input.workspaceId, workspaceKey: access.workspaceKey, eventId, context: resultContext, bindingEpoch: access.binding.bindingEpoch, timestamp });
          break;
        }
        case "source_pause":
        case "source_revoke": {
          const source = this.one("SELECT * FROM memory_source_enrollments WHERE source_id=? AND workspace_key=?", operation.sourceEnrollmentId, access.workspaceKey);
          if (!source) throw memoryError("not_found", "The memory source is unavailable.");
          this.assertExpectedRevision(request.expectedRevision, numberColumn(source, "revision"));
          const sourceId = textColumn(source, "source_id");
          const oldRevision = numberColumn(source, "revision");
          const revision = oldRevision + 1;
          const sourceObjectKey = textColumn(source, "object_key");
          const storedSource = this.unseal<StoredSourcePayload>("memory_source_enrollments", sourceId, oldRevision, textColumn(source, "encrypted_payload"));
          const isRevoke = operation.type === "source_revoke";
          this.run("UPDATE memory_source_enrollments SET status=?,revision=?,source_epoch=source_epoch+1,encrypted_payload=?,updated_at=? WHERE source_id=?",
            isRevoke ? "revoked" : "paused", revision, this.seal("memory_source_enrollments", sourceId, revision, storedSource), timestamp, sourceId);
          this.bumpEpochs(access.workspaceKey, { serving: true, source: true });
          this.emitEvent(eventId, access.workspaceKey, sourceObjectKey, operation.type, requestDigest, timestamp);
          if (isRevoke) {
            this.run("INSERT OR IGNORE INTO memory_tombstones(object_key,workspace_key,deletion_epoch,time,reason_class) VALUES(?,?,?,?,?)", sourceObjectKey, access.workspaceKey, this.epochs(access.workspaceKey).servingEpoch, timestamp, "source-revoke");
            this.enqueueOutbox(eventId, access.workspaceKey, "source-invalidation", requestDigest, { sourceEnrollmentId: sourceId }, "witness-pending");
            resourceId = sourceId; resourceKey = sourceObjectKey; resultingRevision = revision; affectedCollectionId = textColumn(source, "collection_id"); objectKey = sourceObjectKey; recoveryAction = "source-revoke";
          } else {
            this.enqueueOutbox(eventId, access.workspaceKey, "source-pause", requestDigest, { sourceEnrollmentId: sourceId });
            resultContext = { resourceId: sourceId, resultingRevision: revision, collectionIds: [textColumn(source, "collection_id")], targetCollectionId: textColumn(source, "collection_id"), resourceKey: sourceObjectKey };
            this.committedMutation({ actor: principal, request, requestDigest, workspaceId: input.workspaceId, workspaceKey: access.workspaceKey, eventId, context: resultContext, bindingEpoch: access.binding.bindingEpoch, timestamp });
          }
          break;
        }
        case "record_archive":
        case "record_erase": {
          const target = this.one("SELECT * FROM memory_records WHERE record_id=? AND workspace_key=?", operation.recordId, access.workspaceKey);
          if (!target) throw memoryError("not_found", "The memory record is unavailable.");
          this.assertExpectedRevision(request.expectedRevision, numberColumn(target, "revision"));
          const currentRevision = numberColumn(target, "revision");
          const revision = currentRevision + 1;
          const recordId = textColumn(target, "record_id");
          const recordKey = textColumn(target, "record_key");
          const oldPayload = target.encrypted_payload;
          if (typeof oldPayload !== "string") throw memoryError("not_found", "The memory record is unavailable.");
          const storedRecord = this.unseal<StoredRecordPayload>("memory_records", recordId, currentRevision, oldPayload);
          const isErase = operation.type === "record_erase";
          this.run("UPDATE memory_records SET revision=?,lifecycle=?,encrypted_payload=?,updated_at=? WHERE record_id=?",
            revision, isErase ? "erased" : "archived", this.seal("memory_records", recordId, revision, storedRecord), timestamp, recordId);
          this.bumpEpochs(access.workspaceKey, { serving: true });
          this.run("INSERT OR IGNORE INTO memory_tombstones(object_key,workspace_key,deletion_epoch,time,reason_class) VALUES(?,?,?,?,?)", recordKey, access.workspaceKey, this.epochs(access.workspaceKey).servingEpoch, timestamp, isErase ? "erase" : "record-archive");
          this.discardRecordOutbox(recordKey);
          this.emitEvent(eventId, access.workspaceKey, recordKey, operation.type, requestDigest, timestamp);
          this.enqueueOutbox(eventId, access.workspaceKey, isErase ? "record-erasure" : "record-archive", requestDigest, { recordId }, "witness-pending");
          resourceId = recordId; resourceKey = recordKey; resultingRevision = revision; affectedCollectionId = textColumn(target, "collection_id"); objectKey = recordKey; recoveryAction = isErase ? "erase" : "revoke";
          break;
        }
        case "workspace_review_binding": {
          this.assertExpectedRevision(request.expectedRevision, numberColumn(workspace, "revision"));
          const currentStored = this.unseal<StoredWorkspaceBinding>("memory_workspaces", access.workspaceKey, numberColumn(workspace, "revision"), textColumn(workspace, "encrypted_binding"));
          const retiredBindingKey = this.opaque("binding", `${input.workspaceId}:${numberColumn(workspace, "binding_epoch")}`);
          objectKey = retiredBindingKey;
          recoveryAction = "binding-retire";
          resourceId = input.workspaceId;
          resourceKey = textColumn(workspace, "object_key");
          resultingRevision = numberColumn(workspace, "revision") + 1;
          this.run("UPDATE memory_workspaces SET state='review-required' WHERE workspace_key=?", access.workspaceKey);
          this.run("INSERT OR IGNORE INTO memory_retired_bindings(workspace_key,binding_epoch,object_key,retired_at) VALUES(?,?,?,?)",
            access.workspaceKey, numberColumn(workspace, "binding_epoch"), retiredBindingKey, timestamp);
          this.run("INSERT OR IGNORE INTO memory_tombstones(object_key,workspace_key,deletion_epoch,time,reason_class) VALUES(?,?,?,?,?)",
            retiredBindingKey, access.workspaceKey, this.epochs(access.workspaceKey).servingEpoch + 1, timestamp, "binding-retire");
          this.bumpEpochs(access.workspaceKey, { serving: true, grant: true });
          this.emitEvent(eventId, access.workspaceKey, retiredBindingKey, operation.type, requestDigest, timestamp);
          this.enqueueOutbox(eventId, access.workspaceKey, "binding-invalidation", requestDigest, { workspaceId: currentStored.workspaceId, retiredBindingEpoch: numberColumn(workspace, "binding_epoch") }, "witness-pending");
          break;
        }
        default:
          throw new MemoryUnsupportedOperationError(operation.type);
      }

      if (recoveryAction) {
        pendingResponse = this.insertPendingWitness({
          actor: principal,
          request,
          requestDigest,
          workspaceId: input.workspaceId,
          workspaceKey: access.workspaceKey,
          resourceId,
          resourceKey,
          targetCollectionId: affectedCollectionId,
          resultingRevision,
          eventId,
          objectKey,
          action: recoveryAction,
          responseBinding: this.createResponseBinding(principal, input.workspaceId, access.binding.bindingEpoch, affectedCollectionId, request.requestId),
        });
      }
    });

    if (pendingResponse) {
      const acknowledged = await this.flushPendingWitnessQueue();
      const latest = this.one("SELECT * FROM memory_receipts WHERE principal_key=? AND request_id=?", principalKey, request.requestId);
      if (!latest) throw memoryError("recovery_required", "Mutation receipt disappeared during acknowledgement.");
      const stored = this.replayMutation(latest);
      const response = stored.response;
      const binding = this.currentBinding(input.workspaceId);
      const responseValue = acknowledged ? response : (response as MemoryMutationStatusResult);
      const adjusted = "binding" in responseValue ? { ...responseValue, binding: { ...responseValue.binding, bindingEpoch: binding.bindingEpoch } } : responseValue;
      return this.authorized(adjusted, input.actor, this.currentPrincipal(input.actor), input.workspaceId, access.workspaceKey, binding.bindingEpoch);
    }
    if (!resultContext) {
      const latest = this.one("SELECT * FROM memory_receipts WHERE principal_key=? AND request_id=?", principalKey, request.requestId);
      if (!latest) throw memoryError("recovery_required", "Mutation did not persist a receipt.");
      const response = this.replayMutation(latest).response;
      return this.authorized(response, input.actor, this.currentPrincipal(input.actor), input.workspaceId, access.workspaceKey, access.binding.bindingEpoch);
    }
    const response = this.replayMutation(this.one("SELECT * FROM memory_receipts WHERE principal_key=? AND request_id=?", principalKey, request.requestId)!).response;
    return this.authorized(response, input.actor, this.currentPrincipal(input.actor), input.workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  private requireCurrentOwner(principal: MemoryPrincipalSnapshot): string {
    if (principal.kind !== "device" || principal.deviceRole !== "owner" || !principal.deviceId) throw memoryError("not_found", "The memory resource is unavailable.");
    return principal.deviceId;
  }

  private assertBindingForMutation(
    workspace: SqlRow,
    binding: MemoryCurrentWorkspaceBinding,
    expectedBindingEpoch: number,
    operation: MemoryMutation["op"],
  ): void {
    if (expectedBindingEpoch !== binding.bindingEpoch) throw memoryError("stale_binding_epoch", "Workspace binding changed before the mutation.");
    const revision = numberColumn(workspace, "revision");
    const stored = this.unseal<StoredWorkspaceBinding>("memory_workspaces", textColumn(workspace, "workspace_key"), revision, textColumn(workspace, "encrypted_binding"));
    const matches = numberColumn(workspace, "binding_epoch") === binding.bindingEpoch && stored.bindingDigest === binding.bindingDigest;
    if (operation.type === "workspace_review_binding") {
      if (operation.repositoryBindingsDigest !== binding.bindingDigest || binding.state !== "active") throw memoryError("stale_binding_epoch", "The current repository binding does not match the review request.");
      return;
    }
    if (!matches || binding.state !== "active" || textColumn(workspace, "state") !== "active") throw memoryError("binding_review_required", "Workspace repository binding needs owner review.");
  }

  private assertExpectedRevision(expected: number, current: number): void {
    if (expected !== current) throw memoryError("stale_revision", "The memory resource changed. Reload and retry with a new request ID.", { currentRevision: current });
  }

  private bumpEpochs(workspaceKey: string, changes: { serving?: boolean; grant?: boolean; source?: boolean } = {}): { servingEpoch: number; grantEpoch: number; sourceEpoch: number } {
    this.run("UPDATE memory_epochs SET serving_epoch=serving_epoch+?,grant_epoch=grant_epoch+?,source_epoch=source_epoch+? WHERE workspace_key=?",
      changes.serving ? 1 : 0, changes.grant ? 1 : 0, changes.source ? 1 : 0, workspaceKey);
    return this.epochs(workspaceKey);
  }

  private reviseWorkspace(workspace: SqlRow, binding: MemoryCurrentWorkspaceBinding, state: MemoryWorkspace["status"]): number {
    const workspaceKey = textColumn(workspace, "workspace_key");
    const oldRevision = numberColumn(workspace, "revision");
    const nextRevision = oldRevision + 1;
    const old = this.unseal<StoredWorkspaceBinding>("memory_workspaces", workspaceKey, oldRevision, textColumn(workspace, "encrypted_binding"));
    const next: StoredWorkspaceBinding = {
      workspaceId: old.workspaceId,
      repositoryBindings: structuredClone(binding.repositoryBindings),
      bindingDigest: binding.bindingDigest,
      state,
      createdAt: old.createdAt,
      updatedAt: this.timestamp(),
    };
    this.run("UPDATE memory_workspaces SET revision=?,binding_epoch=?,state=?,encrypted_binding=?,updated_at=? WHERE workspace_key=? AND revision=?",
      nextRevision, binding.bindingEpoch, state, this.seal("memory_workspaces", workspaceKey, nextRevision, next), next.updatedAt, workspaceKey, oldRevision);
    return nextRevision;
  }

  private emitEvent(
    eventId: string,
    workspaceKey: string,
    resourceKey: string,
    operation: string,
    payloadDigest: string,
    timestamp: string,
  ): void {
    this.run("INSERT INTO memory_events(event_id,workspace_key,resource_key,operation,payload_digest,created_at) VALUES(?,?,?,?,?,?)",
      eventId, workspaceKey, resourceKey, operation, payloadDigest, timestamp);
  }

  private enqueueOutbox(eventId: string, workspaceKey: string, kind: string, digest: string, payload: unknown, state = "pending", targetObjectKey: string | null = null): void {
    this.run("INSERT INTO memory_outbox(event_id,workspace_key,kind,digest,state,attempts,not_before,target_object_key,encrypted_payload) VALUES(?,?,?,?,?,0,?,?,?)",
      eventId, workspaceKey, kind, digest, state, this.timestamp(), targetObjectKey, this.seal("memory_outbox", eventId, 1, payload));
  }

  private discardRecordOutbox(recordKey: string): void {
    this.run("UPDATE memory_outbox SET state='discarded' WHERE target_object_key=?", recordKey);
  }

  private purgeRecordOutboxPayloads(recordKey: string): void {
    const events = this.all("SELECT event_id FROM memory_outbox WHERE target_object_key=?", recordKey);
    for (const event of events) {
      const eventId = textColumn(event, "event_id");
      this.run("UPDATE memory_outbox SET state='discarded',encrypted_payload=? WHERE event_id=? AND target_object_key=?",
        this.seal("memory_outbox", eventId, 1, { purged: true }), eventId, recordKey);
    }
  }

  private putRecordTokens(collectionId: string, recordId: string, payload: MemoryRecordPayload): void {
    for (const term of memoryLexicalTerms(payload.content)) {
      this.run("INSERT INTO memory_lexical_tokens(collection_id,term_hmac,record_id,tokenizer_version) VALUES(?,?,?,1)", collectionId, this.digestTerms(collectionId, term), recordId);
    }
    this.run("INSERT INTO memory_exact_content(collection_id,content_hmac,record_id,tokenizer_version) VALUES(?,?,?,1)", collectionId, this.digestExact(collectionId, payload.content), recordId);
  }

  private pendingDelta(rowValue: SqlRow): MemoryRecoveryDelta {
    const delta = createMemoryRecoveryDelta({
      sequence: numberColumn(rowValue, "sequence"),
      workspaceKey: textColumn(rowValue, "workspace_key"),
      objectKey: textColumn(rowValue, "object_key"),
      action: textColumn(rowValue, "action") as MemoryRecoveryDelta["action"],
      eventId: textColumn(rowValue, "event_id"),
      priorHash: textColumn(rowValue, "prior_hash"),
      timestamp: textColumn(rowValue, "timestamp"),
    });
    if (delta.deltaHash !== textColumn(rowValue, "delta_hash")) throw memoryError("recovery_required", "Pending recovery evidence failed its local integrity check.");
    return delta;
  }

  private insertPendingWitness(input: {
    actor: MemoryPrincipalSnapshot;
    request: MemoryMutation;
    requestDigest: string;
    workspaceId: string;
    workspaceKey: string;
    resourceId: string;
    resourceKey: string;
    targetCollectionId: string | null;
    resultingRevision: number;
    eventId: string;
    objectKey: string;
    action: MemoryRecoveryDelta["action"];
    responseBinding: MemoryResponseBinding;
  }): MemoryMutationStatusResult {
    const pendingCount = this.one("SELECT COUNT(*) AS count FROM memory_pending_witness");
    if (!pendingCount || numberColumn(pendingCount, "count") >= 100) throw memoryError("quota_exceeded", "Pending recovery actions reached their bound.");
    const checkpoint = this.recoveryCheckpoint();
    const previousPending = this.one("SELECT sequence,delta_hash FROM memory_pending_witness ORDER BY sequence DESC LIMIT 1");
    const sequence = previousPending ? numberColumn(previousPending, "sequence") + 1 : checkpoint.sequence + 1;
    const priorHash = previousPending ? textColumn(previousPending, "delta_hash") : checkpoint.headHash;
    const timestamp = this.timestamp();
    const delta = createMemoryRecoveryDelta({
      sequence,
      workspaceKey: input.workspaceKey,
      objectKey: input.objectKey,
      action: input.action,
      eventId: input.eventId,
      priorHash,
      timestamp,
    });
    const principalKey = this.principalKey(input.actor.principalId);
    const status: MemoryMutationStatus = {
      requestId: input.request.requestId,
      payloadDigest: input.requestDigest,
      operation: input.request.op.type,
      state: "pending",
      receipt: null,
      error: { error: "unavailable", message: "The mutation is waiting for recovery acknowledgement.", retryable: true, requestId: input.request.requestId },
    };
    const result: MemoryMutationStatusResult = { binding: input.responseBinding, status };
    const stored: StoredMutation = {
      state: "pending",
      response: result,
      eventId: input.eventId,
      resourceKey: input.resourceKey,
      targetCollectionId: input.targetCollectionId,
      recoveryDelta: delta,
    };
    this.run("INSERT INTO memory_pending_witness(event_id,principal_key,request_id,workspace_key,object_key,action,sequence,prior_hash,delta_hash,timestamp,encrypted_context) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      input.eventId, principalKey, input.request.requestId, input.workspaceKey, input.objectKey, input.action, sequence, priorHash, delta.deltaHash, timestamp,
      this.seal("memory_pending_witness", input.eventId, 1, { operation: input.request.op, workspaceId: input.workspaceId, expectedBindingEpoch: input.request.expectedBindingEpoch, resourceId: input.resourceId }));
    this.run("INSERT INTO memory_receipts(principal_key,request_id,workspace_key,payload_digest,operation,state,resource_key,resulting_revision,target_collection_id,committed_at,event_id,encrypted_response) VALUES(?,?,?,?,?,'pending',?,?,?,NULL,?,?)",
      principalKey, input.request.requestId, input.workspaceKey, input.requestDigest, input.request.op.type, input.resourceKey, input.resultingRevision, input.targetCollectionId, input.eventId,
      this.seal("memory_receipts", input.request.requestId, input.resultingRevision, stored));
    this.run("UPDATE memory_outbox SET state='witness-pending' WHERE event_id=?", input.eventId);
    return result;
  }

  private applyWitnessDeltas(deltas: readonly MemoryRecoveryDelta[], checkpoint: MemoryRecoveryCheckpoint): void {
    this.transaction(() => {
      for (const delta of deltas) {
        const workspace = this.one("SELECT * FROM memory_workspaces WHERE workspace_key=?", delta.workspaceKey);
        const localIntent = this.one("SELECT event_id FROM memory_pending_witness WHERE event_id=? AND delta_hash=?", delta.eventId, delta.deltaHash);
        const currentEpoch = workspace ? this.epochs(delta.workspaceKey).servingEpoch + (localIntent ? 0 : 1) : 1;
        this.run("INSERT INTO memory_tombstones(object_key,workspace_key,deletion_epoch,time,reason_class) VALUES(?,?,?,?,?) ON CONFLICT(object_key) DO UPDATE SET deletion_epoch=MAX(deletion_epoch,excluded.deletion_epoch)",
          delta.objectKey, delta.workspaceKey, currentEpoch, delta.timestamp, delta.action);
        if (workspace) {
          if (localIntent) {
            if (delta.action === "erase") {
              const erased = this.one("SELECT record_id FROM memory_records WHERE record_key=?", delta.objectKey);
              if (erased) {
                const recordId = textColumn(erased, "record_id");
                this.run("UPDATE memory_records SET lifecycle='erased',encrypted_payload=NULL WHERE record_id=?", recordId);
                this.run("DELETE FROM memory_lexical_tokens WHERE record_id=?", recordId);
                this.run("DELETE FROM memory_exact_content WHERE record_id=?", recordId);
              }
            }
          } else if (delta.action === "grant-revoke") {
            const grant = this.one("SELECT grant_id,revision,encrypted_payload FROM memory_grants WHERE object_key=?", delta.objectKey);
            if (grant) {
              const grantId = textColumn(grant, "grant_id");
              const revision = numberColumn(grant, "revision");
              const nextRevision = revision + 1;
              const payload = this.unseal<StoredGrantPayload>("memory_grants", grantId, revision, textColumn(grant, "encrypted_payload"));
              this.run("UPDATE memory_grants SET state='revoked',revision=?,grant_epoch=grant_epoch+1,encrypted_payload=? WHERE grant_id=?",
                nextRevision, this.seal("memory_grants", grantId, nextRevision, payload), grantId);
            }
          } else if (delta.action === "source-revoke") {
            const source = this.one("SELECT source_id,revision,encrypted_payload FROM memory_source_enrollments WHERE object_key=?", delta.objectKey);
            if (source) {
              const sourceId = textColumn(source, "source_id");
              const revision = numberColumn(source, "revision");
              const nextRevision = revision + 1;
              const payload = this.unseal<StoredSourcePayload>("memory_source_enrollments", sourceId, revision, textColumn(source, "encrypted_payload"));
              this.run("UPDATE memory_source_enrollments SET status='revoked',revision=?,source_epoch=source_epoch+1,encrypted_payload=?,updated_at=? WHERE source_id=?",
                nextRevision, this.seal("memory_source_enrollments", sourceId, nextRevision, payload), delta.timestamp, sourceId);
            }
          } else if (delta.action === "erase") {
            const erased = this.one("SELECT record_id FROM memory_records WHERE record_key=?", delta.objectKey);
            if (erased) {
              const recordId = textColumn(erased, "record_id");
              this.run("UPDATE memory_records SET lifecycle='erased',encrypted_payload=NULL WHERE record_id=?", recordId);
              this.run("DELETE FROM memory_lexical_tokens WHERE record_id=?", recordId);
              this.run("DELETE FROM memory_exact_content WHERE record_id=?", recordId);
            }
          } else if (delta.action === "revoke") {
            this.run("UPDATE memory_records SET lifecycle='archived' WHERE record_key=? AND lifecycle!='erased'", delta.objectKey);
            if (delta.objectKey === textColumn(workspace, "object_key")) this.run("UPDATE memory_workspaces SET state='retired' WHERE workspace_key=?", delta.workspaceKey);
          } else if (delta.action === "binding-retire") {
            const revision = numberColumn(workspace, "revision");
            const stored = this.unseal<StoredWorkspaceBinding>("memory_workspaces", delta.workspaceKey, revision, textColumn(workspace, "encrypted_binding"));
            const oldEpoch = numberColumn(workspace, "binding_epoch");
            const expectedObjectKey = this.opaque("binding", `${stored.workspaceId}:${oldEpoch}`);
            if (expectedObjectKey === delta.objectKey) {
              this.run("INSERT OR IGNORE INTO memory_retired_bindings(workspace_key,binding_epoch,object_key,retired_at) VALUES(?,?,?,?)", delta.workspaceKey, oldEpoch, delta.objectKey, delta.timestamp);
              this.run("UPDATE memory_workspaces SET state='review-required' WHERE workspace_key=?", delta.workspaceKey);
            }
          }
          if (!localIntent) this.run("UPDATE memory_epochs SET serving_epoch=serving_epoch+1,grant_epoch=grant_epoch+?,source_epoch=source_epoch+? WHERE workspace_key=?",
            delta.action === "grant-revoke" ? 1 : 0, delta.action === "source-revoke" ? 1 : 0, delta.workspaceKey);
        }
      }
      this.run("UPDATE memory_recovery_state SET sequence=?,head_hash=? WHERE singleton=1", checkpoint.sequence, checkpoint.headHash);
    });
  }

  private finalizeBindingReview(workspaceId: string, expectedDigest: string, expectedEpoch: number): void {
    const current = this.currentBinding(workspaceId);
    if (current.state !== "active" || current.bindingEpoch !== expectedEpoch || current.bindingDigest !== expectedDigest) throw memoryError("stale_binding_epoch", "Workspace binding changed while review acknowledgement was pending.");
    const workspace = this.workspaceRow(workspaceId);
    this.reviseWorkspace(workspace, current, "active");
    const workspaceKey = textColumn(workspace, "workspace_key");
    const ownerRows = this.all("SELECT * FROM memory_owner_bindings WHERE workspace_key=? AND state='active'", workspaceKey);
    for (const owner of ownerRows) {
      const deviceKey = textColumn(owner, "device_key");
      const oldEpoch = numberColumn(owner, "grant_epoch");
      const ownerBinding = this.unseal<StoredOwnerBinding>("memory_owner_bindings", `${workspaceKey}:${deviceKey}`, oldEpoch, textColumn(owner, "encrypted_binding"));
      const next: StoredOwnerBinding = { ...ownerBinding, bindingEpoch: current.bindingEpoch, grantEpoch: oldEpoch + 1 };
      this.run("UPDATE memory_owner_bindings SET grant_epoch=?,encrypted_binding=? WHERE workspace_key=? AND device_key=?",
        next.grantEpoch, this.seal("memory_owner_bindings", `${workspaceKey}:${deviceKey}`, next.grantEpoch, next), workspaceKey, deviceKey);
    }
    this.bumpEpochs(workspaceKey, { serving: true, grant: true });
  }

  private commitWitnessAcknowledgement(rowValue: SqlRow, next: MemoryRecoveryCheckpoint, receipt: MemoryRecoveryAppendReceipt): void {
    const eventId = textColumn(rowValue, "event_id");
    this.transaction(() => {
      const current = this.recoveryCheckpoint();
      const alreadyApplied = current.sequence >= next.sequence
        && (current.sequence > next.sequence || current.headHash === next.headHash);
      if (!alreadyApplied && (current.sequence !== numberColumn(rowValue, "sequence") - 1 || current.headHash !== textColumn(rowValue, "prior_hash"))) {
        throw memoryError("recovery_required", "The local recovery checkpoint changed during witness acknowledgement.");
      }
      const pending = this.one("SELECT * FROM memory_pending_witness WHERE event_id=?", eventId);
      const mutationReceipt = this.one("SELECT * FROM memory_receipts WHERE event_id=?", eventId);
      if (!pending || !mutationReceipt) throw memoryError("recovery_required", "Pending mutation receipt is unavailable.");
      const context = this.unseal<{ operation: MemoryMutation["op"]; workspaceId: string; expectedBindingEpoch: number; resourceId: string }>(
        "memory_pending_witness", eventId, 1, textColumn(pending, "encrypted_context"),
      );
      const workspaceId = context.workspaceId;
      const operation = textColumn(mutationReceipt, "operation");
      let reviewFailure: MemoryStoreError | undefined;
      if (operation === "workspace_review_binding") {
        if (context.operation.type !== "workspace_review_binding") throw memoryError("recovery_required", "Workspace review receipt context is invalid.");
        try {
          this.finalizeBindingReview(workspaceId, context.operation.repositoryBindingsDigest, context.expectedBindingEpoch);
        } catch (error) {
          if (error instanceof MemoryStoreError && ["stale_binding_epoch", "binding_review_required", "not_found"].includes(error.error)) {
            reviewFailure = memoryError("stale_binding_epoch", "Workspace binding changed before review acknowledgement; submit a fresh review.");
          } else {
            throw error;
          }
        }
      }
      if (operation === "record_erase") {
        const recordId = context.resourceId;
        this.run("UPDATE memory_records SET encrypted_payload=NULL,lifecycle='erased' WHERE record_id=?", recordId);
        this.run("DELETE FROM memory_lexical_tokens WHERE record_id=?", recordId);
        this.run("DELETE FROM memory_exact_content WHERE record_id=?", recordId);
      }
      if (operation === "record_erase" || operation === "record_archive") this.purgeRecordOutboxPayloads(textColumn(pending, "object_key"));
      const stored = this.unseal<StoredMutation>("memory_receipts", textColumn(mutationReceipt, "request_id"), numberColumn(mutationReceipt, "resulting_revision"), textColumn(mutationReceipt, "encrypted_response"));
      const pendingResult = stored.response as MemoryMutationStatusResult;
      const committedAt = receipt.acceptedAt;
      if (reviewFailure) {
        const failed: MemoryMutationStatusResult = {
          binding: pendingResult.binding,
          status: {
            requestId: textColumn(mutationReceipt, "request_id"),
            payloadDigest: textColumn(mutationReceipt, "payload_digest"),
            operation: operation as MemoryMutation["op"]["type"],
            state: "failed",
            receipt: null,
            error: { error: reviewFailure.error, message: reviewFailure.message, retryable: false, requestId: textColumn(mutationReceipt, "request_id") },
          },
        };
        const final: StoredMutation = { ...stored, state: "failed", response: failed };
        this.run("UPDATE memory_receipts SET state='failed',committed_at=?,encrypted_response=? WHERE event_id=? AND state='pending'",
          committedAt, this.seal("memory_receipts", textColumn(mutationReceipt, "request_id"), numberColumn(mutationReceipt, "resulting_revision"), final), eventId);
        this.run("UPDATE memory_outbox SET state='ready' WHERE event_id=?", eventId);
        this.run("DELETE FROM memory_pending_witness WHERE event_id=?", eventId);
        if (!alreadyApplied) this.run("UPDATE memory_recovery_state SET sequence=?,head_hash=? WHERE singleton=1", next.sequence, next.headHash);
        return;
      }
      const successReceipt: MemoryMutationReceipt = {
        requestId: textColumn(mutationReceipt, "request_id"),
        payloadDigest: textColumn(mutationReceipt, "payload_digest"),
        operation: operation as MemoryMutation["op"]["type"],
        outcome: "committed",
        resourceId: context.resourceId,
        resultingRevision: numberColumn(mutationReceipt, "resulting_revision"),
        committedAt,
      };
      const committed: MemoryMutationResult = { binding: pendingResult.binding, receipt: successReceipt };
      const final: StoredMutation = { ...stored, state: "committed", response: committed };
      this.run("UPDATE memory_receipts SET state='committed',committed_at=?,encrypted_response=? WHERE event_id=? AND state='pending'",
        committedAt, this.seal("memory_receipts", successReceipt.requestId, successReceipt.resultingRevision, final), eventId);
      this.run("UPDATE memory_outbox SET state='ready' WHERE event_id=?", eventId);
      this.run("DELETE FROM memory_pending_witness WHERE event_id=?", eventId);
      if (!alreadyApplied) this.run("UPDATE memory_recovery_state SET sequence=?,head_hash=? WHERE singleton=1", next.sequence, next.headHash);
    });
  }

  private async flushPendingWitnessQueue(): Promise<boolean> {
    if (!this.recovery || !this.recoveryReady) throw memoryError("recovery_required", "Protected memory is closed pending fresh recovery.");
    for (;;) {
      const pending = this.one("SELECT * FROM memory_pending_witness ORDER BY sequence LIMIT 1");
      if (!pending) return true;
      const delta = this.pendingDelta(pending);
      try {
        await this.recovery.appendAndCommit(delta, (checkpoint, receipt) => this.commitWitnessAcknowledgement(pending, checkpoint, receipt));
      } catch (error) {
        if (error instanceof MemoryRecoveryError && error.error === "unavailable") return false;
        if (error instanceof MemoryRecoveryError && error.error === "recovery_required") this.recoveryOpen = false;
        throw error;
      }
    }
  }

  private directGrant(principal: MemoryPrincipalSnapshot, workspaceId: string, collectionId: string): { row: SqlRow; capabilities: MemoryCapability[] } | undefined {
    const subjects: Array<{ kind: "device" | "task" | "workspace"; key: string }> = [];
    if (principal.kind === "device" && principal.deviceId) subjects.push({ kind: "device", key: this.subjectKey("device", principal.deviceId) });
    if (principal.kind === "task" && principal.taskBindingId) subjects.push({ kind: "task", key: this.subjectKey("task", principal.taskBindingId) });
    if (principal.workspaceId === workspaceId) subjects.push({ kind: "workspace", key: this.subjectKey("workspace", workspaceId) });
    for (const subject of subjects) {
      const grant = this.one("SELECT * FROM memory_grants WHERE collection_id=? AND subject_kind=? AND subject_key=? AND state='active'", collectionId, subject.kind, subject.key);
      if (!grant || this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", textColumn(grant, "object_key"))) continue;
      const caps = JSON.parse(textColumn(grant, "capabilities")) as MemoryCapability[];
      return { row: grant, capabilities: caps };
    }
    return undefined;
  }

  private authorizedCollectionIds(principal: MemoryPrincipalSnapshot, workspaceId: string, capability: MemoryCapability): string[] {
    const workspaceKey = this.workspaceKey(workspaceId);
    const collections = this.all("SELECT collection_id FROM memory_collections WHERE owner_workspace_key=? AND status='active' ORDER BY collection_id LIMIT 10000", workspaceKey);
    const visible: string[] = [];
    for (const item of collections) {
      const id = textColumn(item, "collection_id");
      const grant = this.directGrant(principal, workspaceId, id);
      if (grant?.capabilities.includes(capability)) visible.push(id);
    }
    if (principal.kind === "task" && principal.collectionIds) {
      return visible.filter(id => principal.collectionIds!.includes(id));
    }
    return visible;
  }

  private assertWorkspaceAccess(
    principal: MemoryPrincipalSnapshot,
    workspaceId: string,
    options: { allowBindingReview?: boolean; requireRead?: boolean } = {},
  ): { row: SqlRow; binding: MemoryCurrentWorkspaceBinding; view: MemoryWorkspace; workspaceKey: string } {
    const current = this.currentBinding(workspaceId);
    if (current.state === "retired") throw memoryError("not_found", "The memory workspace is unavailable.");
    if (principal.kind === "task" && principal.workspaceId !== workspaceId) throw memoryError("not_found", "The memory workspace is unavailable.");
    const workspace = this.workspaceRow(workspaceId);
    const workspaceKey = textColumn(workspace, "workspace_key");
    if (principal.kind === "task") {
      const epochs = this.epochs(workspaceKey);
      if (principal.bindingEpoch !== current.bindingEpoch || principal.grantEpoch !== epochs.grantEpoch) {
        throw memoryError("not_found", "The memory workspace is unavailable.");
      }
    }
    if (this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", textColumn(workspace, "object_key"))) throw memoryError("not_found", "The memory workspace is unavailable.");
    const view = this.workspaceView(workspaceId, workspace, current);
    if (view.status === "review-required" && !options.allowBindingReview) throw memoryError("binding_review_required", "Workspace repository binding needs owner review.");
    const owner = this.ownerBinding(workspaceKey, principal);
    const readable = this.authorizedCollectionIds(principal, workspaceId, "read").length > 0;
    if (options.requireRead && !readable && !owner) throw memoryError("not_found", "The memory workspace is unavailable.");
    return { row: workspace, binding: current, view, workspaceKey };
  }

  private principalFingerprint(principal: MemoryPrincipalSnapshot): string {
    return canonicalMemoryDigest({
      principalId: principal.principalId,
      kind: principal.kind,
      deviceId: principal.deviceId ?? null,
      deviceRole: principal.deviceRole ?? null,
      taskBindingId: principal.taskBindingId ?? null,
      workspaceId: principal.workspaceId ?? null,
      collectionIds: [...(principal.collectionIds ?? [])].sort(),
      bindingEpoch: principal.bindingEpoch ?? null,
      grantEpoch: principal.grantEpoch ?? null,
      allowedActions: [...(principal.allowedActions ?? [])].sort(),
      allowedRecallModes: [...(principal.allowedRecallModes ?? [])].sort(),
      expiresAt: principal.expiresAt ?? null,
      state: principal.state,
    });
  }

  private createFence(
    selector: MemoryPrincipalSelector,
    principal: MemoryPrincipalSnapshot,
    workspaceId: string,
    workspaceKey: string,
    bindingEpoch: number,
    recordIds: string[] = [],
  ): MemoryReadFence {
    const now = (this.options.now ?? Date.now)();
    for (const [token, snapshot] of this.fences) if (snapshot.expiresAt <= now) this.fences.delete(token);
    while (this.fences.size >= MAX_READ_FENCES) this.fences.delete(this.fences.keys().next().value!);
    const recordKeys = recordIds.map(id => this.recordKey(id));
    const records = recordKeys.flatMap(key => {
      const result = this.one("SELECT revision FROM memory_records WHERE record_key=?", key);
      return result ? [{ recordKey: key, revision: numberColumn(result, "revision") }] : [];
    });
    const sourceKeys = recordKeys.flatMap(key => this.all("SELECT DISTINCT source_id FROM memory_record_sources WHERE record_key=?", key).map(item => this.sourceObjectKey(textColumn(item, "source_id"))));
    const epochs = this.epochs(workspaceKey);
    const token = randomUUID();
    this.fences.set(token, {
      expiresAt: now + READ_FENCE_TTL_MS,
      selector: structuredClone(selector),
      principalKey: this.principalKey(principal.principalId),
      principalFingerprint: this.principalFingerprint(principal),
      workspaceId,
      workspaceKey,
      bindingEpoch,
      servingEpoch: epochs.servingEpoch,
      grantEpoch: epochs.grantEpoch,
      sourceEpoch: epochs.sourceEpoch,
      sourceKeys: [...new Set(sourceKeys)].sort(),
      records,
    });
    return createMemoryReadFence(token);
  }

  private authorized<T>(
    value: T,
    selector: MemoryPrincipalSelector,
    principal: MemoryPrincipalSnapshot,
    workspaceId: string,
    workspaceKey: string,
    bindingEpoch: number,
    recordIds: string[] = [],
  ): AuthorizedRead<T> {
    return { value, fence: this.createFence(selector, principal, workspaceId, workspaceKey, bindingEpoch, recordIds) };
  }

  private responseBinding(principal: MemoryPrincipalSnapshot, workspaceId: string, bindingEpoch: number, collectionIds: string[], requestId: string = randomUUID()): MemoryResponseBinding {
    return {
      hostId: this.options.hostId,
      workspaceId,
      collectionIds: [...new Set(collectionIds)].sort(),
      bindingEpoch,
      taskBindingId: principal.kind === "task" ? principal.taskBindingId ?? null : null,
      requestId,
    };
  }

  private pageCursor(
    route: string,
    workspaceKey: string,
    principal: MemoryPrincipalSnapshot,
    filters: unknown,
    epochs: { servingEpoch: number; grantEpoch: number },
    lastId: string,
  ): string {
    const value = {
      v: 1,
      route,
      workspaceKey,
      principalKey: this.principalKey(principal.principalId),
      filterDigest: canonicalMemoryDigest(filters),
      servingEpoch: epochs.servingEpoch,
      grantEpoch: epochs.grantEpoch,
      lastId,
      issuedAt: (this.options.now ?? Date.now)(),
    };
    const payload = Buffer.from(canonicalMemoryJson(value), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.cursorKey).update(payload, "utf8").digest("base64url");
    return `${payload}.${mac}`;
  }

  private cursorStart(
    cursor: string | undefined,
    route: string,
    workspaceKey: string,
    principal: MemoryPrincipalSnapshot,
    filters: unknown,
    epochs: { servingEpoch: number; grantEpoch: number },
  ): string {
    if (!cursor) return "";
    const parts = cursor.split(".");
    if (parts.length !== 2) throw memoryError("invalid_request", "Cursor is invalid.");
    const [payload, encodedMac] = parts as [string, string];
    const expectedMac = createHmac("sha256", this.cursorKey).update(payload, "utf8").digest();
    let actualMac: Buffer;
    try { actualMac = Buffer.from(encodedMac, "base64url"); } catch { throw memoryError("invalid_request", "Cursor is invalid."); }
    if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) throw memoryError("invalid_request", "Cursor is invalid.");
    let value: SqlRow;
    try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SqlRow; } catch { throw memoryError("invalid_request", "Cursor is invalid."); }
    if (value.v !== 1 || value.route !== route || value.workspaceKey !== workspaceKey
      || value.principalKey !== this.principalKey(principal.principalId)
      || value.filterDigest !== canonicalMemoryDigest(filters)
      || value.servingEpoch !== epochs.servingEpoch || value.grantEpoch !== epochs.grantEpoch
      || typeof value.lastId !== "string" || typeof value.issuedAt !== "number"
      || (this.options.now ?? Date.now)() - value.issuedAt > READ_FENCE_TTL_MS) {
      throw memoryError("stale_binding_epoch", "The memory cursor is stale.");
    }
    return value.lastId;
  }

  private recordView(rowValue: SqlRow): MemoryRecord {
    const recordId = textColumn(rowValue, "record_id");
    const revision = numberColumn(rowValue, "revision");
    const encryptedPayload = rowValue.encrypted_payload;
    if (typeof encryptedPayload !== "string") throw memoryError("not_found", "The memory record is unavailable.");
    const stored = this.unseal<StoredRecordPayload>("memory_records", recordId, revision, encryptedPayload);
    return {
      ...stored.payload,
      id: recordId,
      workspaceId: stored.workspaceId,
      collectionId: textColumn(rowValue, "collection_id"),
      revision,
      provenanceClass: stored.provenanceClass,
      lifecycle: textColumn(rowValue, "lifecycle") as MemoryRecord["lifecycle"],
      suppressed: boolColumn(rowValue, "suppressed"),
      createdAt: textColumn(rowValue, "created_at"),
      updatedAt: textColumn(rowValue, "updated_at"),
    };
  }

  private recordEligible(rowValue: SqlRow, now: number, visited = new Set<string>()): boolean {
    const key = textColumn(rowValue, "record_key");
    const lifecycle = textColumn(rowValue, "lifecycle");
    if (!(["active", "candidate"].includes(lifecycle)) || boolColumn(rowValue, "suppressed")
      || this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", key)) return false;
    const validFrom = rowValue.valid_from;
    const validUntil = rowValue.valid_until;
    if (typeof validFrom === "string" && Date.parse(validFrom) > now) return false;
    if (typeof validUntil === "string" && Date.parse(validUntil) <= now) return false;
    return this.recordLineageEligible(rowValue, now, visited);
  }

  private recordLineageEligible(rowValue: SqlRow, now: number, visited = new Set<string>()): boolean {
    const key = textColumn(rowValue, "record_key");
    if (visited.has(key) || this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", key)) return false;
    visited.add(key);
    const validFrom = rowValue.valid_from;
    const validUntil = rowValue.valid_until;
    if (typeof validFrom === "string" && Date.parse(validFrom) > now) return false;
    if (typeof validUntil === "string" && Date.parse(validUntil) <= now) return false;
    const sources = this.all("SELECT source_id FROM memory_record_sources WHERE record_key=?", key);
    for (const source of sources) {
      const sourceId = textColumn(source, "source_id");
      const sourceRow = this.one("SELECT source_key,object_key,status FROM memory_source_enrollments WHERE source_id=?", sourceId);
      if (!sourceRow || textColumn(sourceRow, "status") === "revoked"
        || textColumn(sourceRow, "status") === "pending"
        || this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", textColumn(sourceRow, "object_key"))) return false;
    }
    const parents = this.all("SELECT parent_record_key,parent_revision FROM memory_record_lineage WHERE record_key=?", key);
    for (const parent of parents) {
      const parentKey = textColumn(parent, "parent_record_key");
      const parentRow = this.one("SELECT * FROM memory_records WHERE record_key=?", parentKey);
      if (!parentRow || numberColumn(parentRow, "revision") !== numberColumn(parent, "parent_revision")
        || !["active", "candidate"].includes(textColumn(parentRow, "lifecycle"))
        || boolColumn(parentRow, "suppressed")
        || !this.recordLineageEligible(parentRow, now, visited)) return false;
    }
    visited.delete(key);
    return true;
  }

  private recordPayloadDigest(record: MemoryRecordPayload): string { return canonicalMemoryDigest(record); }

  getWorkspace(actor: MemoryPrincipalSelector, workspaceId: string): AuthorizedRead<MemoryWorkspaceResult> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    this.requireTaskRecall(principal);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { allowBindingReview: true, requireRead: true });
    const collectionIds = this.authorizedCollectionIds(principal, workspaceId, "read");
    const result: MemoryWorkspaceResult = {
      binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, collectionIds),
      workspace: access.view,
      coverage: { lexical: "complete", semantic: "disabled" },
      coverageReasons: [],
    };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  listCollections(actor: MemoryPrincipalSelector, workspaceId: string, options: MemoryPageOptions = {}): AuthorizedRead<MemoryPage<MemoryCollection>> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    this.requireTaskRecall(principal);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { requireRead: true });
    const page = validateCursorOptions(options);
    const allowedOptions = new Set(["limit", "cursor", "collectionId", "state"]);
    for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw memoryError("invalid_request", "Collection selectors are invalid.");
    const filters = { collectionId: options.collectionId ?? null, state: options.state ?? "active" };
    const collectionIds = this.authorizedCollectionIds(principal, workspaceId, "read");
    if (options.collectionId && !collectionIds.includes(options.collectionId)) throw memoryError("not_found", "The memory collection is unavailable.");
    if (options.state !== undefined && options.state !== "all" && !["active", "archived", "erased"].includes(options.state)) throw memoryError("invalid_request", "Collection state is invalid.");
    if (options.state && options.state !== "active") {
      const selected = options.collectionId ? [options.collectionId] : collectionIds;
      if (selected.some(id => !this.directGrant(principal, workspaceId, id)?.capabilities.some(cap => cap === "curate" || cap === "review"))) throw memoryError("not_found", "The memory collection is unavailable.");
    }
    const epochs = this.epochs(access.workspaceKey);
    const startAfter = this.cursorStart(page.cursor, "collections", access.workspaceKey, principal, filters, epochs);
    const stateClause = options.state === undefined || options.state === "active" || options.state === "all" ? "" : " AND status=?";
    const ids = options.collectionId ? [options.collectionId] : collectionIds;
    const items: MemoryCollection[] = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const params: SQLInputValue[] = [workspaceId ? this.workspaceKey(workspaceId) : access.workspaceKey, ...ids, startAfter];
      if (stateClause) params.push(options.state ?? "active");
      params.push(page.limit + 1);
      const selected = this.all(`SELECT collection_id,owner_workspace_key,scope,revision,status FROM memory_collections WHERE owner_workspace_key=? AND collection_id IN (${placeholders}) AND collection_id>?${stateClause} ORDER BY collection_id LIMIT ?`, ...params);
      for (const item of selected.slice(0, page.limit)) {
        items.push({
          collectionId: textColumn(item, "collection_id"),
          ownerWorkspaceId: workspaceId,
          scope: textColumn(item, "scope") as MemoryCollection["scope"],
          revision: numberColumn(item, "revision"),
          status: textColumn(item, "status") as MemoryCollection["status"],
        });
      }
      const nextCursor = selected.length > page.limit && items.length
        ? this.pageCursor("collections", access.workspaceKey, principal, filters, epochs, items.at(-1)!.collectionId)
        : null;
      const result: MemoryPage<MemoryCollection> = {
        binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, ids),
        items,
        nextCursor,
        complete: true,
        coverageReasons: [],
      };
      return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
    }
    const result: MemoryPage<MemoryCollection> = {
      binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, []),
      items,
      nextCursor: null,
      complete: true,
      coverageReasons: [],
    };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  listRecords(actor: MemoryPrincipalSelector, workspaceId: string, options: MemoryPageOptions = {}): AuthorizedRead<MemoryPage<MemoryRecord>> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    this.requireTaskRecall(principal);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { requireRead: true });
    const page = validateCursorOptions(options);
    const allowedOptions = new Set(["limit", "cursor", "collectionId", "state"]);
    for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw memoryError("invalid_request", "Record selectors are invalid.");
    const state = options.state ?? "active";
    if (state !== "active" && state !== "all" && !["candidate", "superseded", "invalidated", "archived"].includes(state)) throw memoryError("invalid_request", "Record state is invalid.");
    const collectionIds = this.authorizedCollectionIds(principal, workspaceId, "read");
    if (options.collectionId && !collectionIds.includes(options.collectionId)) throw memoryError("not_found", "The memory collection is unavailable.");
    const selectedCollections = options.collectionId ? [options.collectionId] : collectionIds;
    if (state !== "active" && selectedCollections.some(id => !this.directGrant(principal, workspaceId, id)?.capabilities.some(cap => cap === "curate" || cap === "review"))) throw memoryError("not_found", "The memory collection is unavailable.");
    const filters = { collectionId: options.collectionId ?? null, state };
    const epochs = this.epochs(access.workspaceKey);
    const startAfter = this.cursorStart(page.cursor, "records", access.workspaceKey, principal, filters, epochs);
    const items: MemoryRecord[] = [];
    let scannedLastId = "";
    let hasMore = false;
    if (selectedCollections.length) {
      const placeholders = selectedCollections.map(() => "?").join(",");
      const lifecycleClause = state === "all" ? "" : " AND r.lifecycle=?";
      const validClause = state === "active" ? " AND (r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?) AND r.suppressed=0" : "";
      const params: SQLInputValue[] = [...selectedCollections, startAfter];
      if (lifecycleClause) params.push(state);
      if (validClause) params.push(this.timestamp(), this.timestamp());
      params.push(page.limit + 1);
      const candidates = this.all(`SELECT r.* FROM memory_records r WHERE r.collection_id IN (${placeholders}) AND r.record_id>?${lifecycleClause}${validClause} ORDER BY r.record_id LIMIT ?`, ...params);
      const visible: Array<{ row: SqlRow; record: MemoryRecord }> = [];
      for (const candidate of candidates) {
        scannedLastId = textColumn(candidate, "record_id");
        const lifecycle = textColumn(candidate, "lifecycle");
        if (lifecycle === "erased" || typeof candidate.encrypted_payload !== "string") continue;
        if (state === "active" && !this.recordEligible(candidate, (this.options.now ?? Date.now)())) continue;
        if (state !== "active" && state !== "all" && lifecycle !== state) continue;
        if (state !== "active" && state !== "all" && !this.recordLineageEligible(candidate, (this.options.now ?? Date.now)())) continue;
        if (state === "all" && lifecycle !== "active" && lifecycle !== "candidate" && !this.recordLineageEligible(candidate, (this.options.now ?? Date.now)())) continue;
        visible.push({ row: candidate, record: this.recordView(candidate) });
      }
      hasMore = visible.length > page.limit || candidates.length > page.limit;
      items.push(...visible.slice(0, page.limit).map(value => value.record));
    }
    const lastId = items.at(-1)?.id ?? scannedLastId;
    const nextCursor = hasMore && lastId ? this.pageCursor("records", access.workspaceKey, principal, filters, epochs, lastId) : null;
    const result: MemoryPage<MemoryRecord> = {
      binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, selectedCollections),
      items,
      nextCursor,
      complete: true,
      coverageReasons: [],
    };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch, items.map(item => item.id));
  }

  getRecord(actor: MemoryPrincipalSelector, recordId: string): AuthorizedRead<MemoryRecordResult> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    this.requireTaskRecall(principal);
    validateIdentifier(recordId, "recordId");
    const candidate = this.one("SELECT * FROM memory_records WHERE record_id=?", recordId);
    if (!candidate) throw memoryError("not_found", "The memory record is unavailable.");
    const collectionId = textColumn(candidate, "collection_id");
    this.requireTaskCollection(principal, collectionId);
    const workspaceId = this.workspaceIdFromKey(textColumn(candidate, "workspace_key"));
    const access = this.assertWorkspaceAccess(principal, workspaceId, { requireRead: true });
    const grant = this.directGrant(principal, workspaceId, collectionId);
    if (!grant?.capabilities.includes("read") || !this.recordEligible(candidate, (this.options.now ?? Date.now)())) throw memoryError("not_found", "The memory record is unavailable.");
    const value = this.recordView(candidate);
    const result: MemoryRecordResult = { binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, [collectionId]), record: value };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch, [recordId]);
  }

  lexicalCandidates(actor: MemoryPrincipalSelector, workspaceId: string, request: MemoryLexicalQuery): AuthorizedRead<MemoryRecord[]> {
    this.assertRecovery();
    if (!request || (request.mode !== "exact" && request.mode !== "lexical")
      || typeof request.query !== "string" || Buffer.byteLength(request.query, "utf8") > 4 * 1024
      || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_LEXICAL_CANDIDATES) throw memoryError("invalid_request", "Memory query bounds are invalid.");
    const principal = this.currentPrincipal(actor);
    this.requireTaskRecall(principal, request.mode);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { requireRead: true });
    const readable = this.authorizedCollectionIds(principal, workspaceId, "read");
    const selected = request.collectionIds === undefined ? readable : request.collectionIds;
    if (!Array.isArray(selected) || selected.length > 100 || new Set(selected).size !== selected.length
      || selected.some(id => !readable.includes(id))) throw memoryError("not_found", "The memory collection is unavailable.");
    const ids = [...selected].sort();
    const now = (this.options.now ?? Date.now)();
    const matches: SqlRow[] = [];
    if (ids.length && request.mode === "exact") {
      if (UUID.test(request.query)) {
        const found = this.one("SELECT r.* FROM memory_records r WHERE r.record_id=? AND r.collection_id IN (" + ids.map(() => "?").join(",") + ") LIMIT 1", request.query, ...ids);
        if (found) matches.push(found);
      } else {
        for (const collectionId of ids) {
          const contentHmac = this.digestExact(collectionId, request.query);
          const found = this.one("SELECT r.* FROM memory_exact_content e JOIN memory_records r ON r.record_id=e.record_id WHERE e.collection_id=? AND e.content_hmac=? AND r.lifecycle IN ('active','candidate') AND r.suppressed=0 AND (r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?) ORDER BY r.record_id LIMIT ?",
            collectionId, contentHmac, new Date(now).toISOString(), new Date(now).toISOString(), request.limit);
          if (found) matches.push(found);
          if (matches.length >= request.limit) break;
        }
      }
    } else if (ids.length) {
      const terms = memoryLexicalTerms(request.query).slice(0, 64);
      if (terms.length) {
        const termHashes = [...new Set(ids.flatMap(collectionId => terms.map(term => this.digestTerms(collectionId, term))))];
        const placeholders = termHashes.map(() => "?").join(",");
        const candidateCollectionFilter = ids.map(() => "?").join(",");
        const found = this.all(`SELECT r.*,COUNT(DISTINCT t.term_hmac) AS term_count FROM memory_lexical_tokens t JOIN memory_records r ON r.record_id=t.record_id WHERE t.collection_id IN (${candidateCollectionFilter}) AND t.term_hmac IN (${placeholders}) AND r.lifecycle IN ('active','candidate') AND r.suppressed=0 AND (r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?) GROUP BY r.record_id ORDER BY term_count DESC,r.record_id ASC LIMIT ?`,
          ...ids, ...termHashes, new Date(now).toISOString(), new Date(now).toISOString(), request.limit);
        matches.push(...found);
      }
    }
    const items: MemoryRecord[] = [];
    for (const candidate of matches) {
      if (!this.recordEligible(candidate, now)) continue;
      items.push(this.recordView(candidate));
      if (items.length >= request.limit) break;
    }
    return this.authorized(items, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch, items.map(item => item.id));
  }

  listGrants(actor: MemoryPrincipalSelector, workspaceId: string, options: MemoryPageOptions = {}): AuthorizedRead<MemoryPage<MemoryGrant>> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { requireRead: true });
    const page = validateCursorOptions(options);
    const allowedOptions = new Set(["limit", "cursor", "collectionId", "state"]);
    for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw memoryError("invalid_request", "Grant selectors are invalid.");
    const state = options.state ?? "active";
    if (state !== "active" && state !== "all" && state !== "revoked") throw memoryError("invalid_request", "Grant state is invalid.");
    const shareable = this.authorizedCollectionIds(principal, workspaceId, "share");
    if (options.collectionId && !shareable.includes(options.collectionId)) throw memoryError("not_found", "The memory collection is unavailable.");
    const collectionIds = options.collectionId ? [options.collectionId] : shareable;
    const filters = { collectionId: options.collectionId ?? null, state };
    const epochs = this.epochs(access.workspaceKey);
    const startAfter = this.cursorStart(page.cursor, "grants", access.workspaceKey, principal, filters, epochs);
    const grants: MemoryGrant[] = [];
    let nextCursor: string | null = null;
    if (collectionIds.length) {
      const placeholders = collectionIds.map(() => "?").join(",");
      const statusClause = state === "all" ? "" : " AND g.state=?";
      const values: SQLInputValue[] = [...collectionIds];
      if (statusClause) values.push(state);
      values.push(startAfter, page.limit + 1);
      const found = this.all(`SELECT g.* FROM memory_grants g WHERE g.collection_id IN (${placeholders})${statusClause} AND g.grant_id>? ORDER BY g.grant_id LIMIT ?`, ...values);
      for (const item of found.slice(0, page.limit)) {
        const grantId = textColumn(item, "grant_id");
        const revision = numberColumn(item, "revision");
        if (this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", textColumn(item, "object_key"))) continue;
        const stored = this.unseal<StoredGrantPayload>("memory_grants", grantId, revision, textColumn(item, "encrypted_payload"));
        grants.push({
          id: grantId,
          collectionId: textColumn(item, "collection_id"),
          subjectKind: textColumn(item, "subject_kind") as MemoryGrant["subjectKind"],
          subjectId: stored.subjectId,
          capabilities: JSON.parse(textColumn(item, "capabilities")) as MemoryCapability[],
          revision,
          grantEpoch: numberColumn(item, "grant_epoch"),
          state: textColumn(item, "state") as MemoryGrant["state"],
        });
      }
      if (found.length > page.limit && grants.length) nextCursor = this.pageCursor("grants", access.workspaceKey, principal, filters, epochs, grants.at(-1)!.id);
    }
    const result: MemoryPage<MemoryGrant> = {
      binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, collectionIds),
      items: grants,
      nextCursor,
      complete: true,
      coverageReasons: [],
    };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  listSources(actor: MemoryPrincipalSelector, workspaceId: string, options: MemoryPageOptions = {}): AuthorizedRead<MemoryPage<MemorySourceEnrollment>> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { allowBindingReview: true });
    this.requireOwnerBinding(access.workspaceKey, principal, "administer");
    const administrableCollectionIds = this.authorizedCollectionIds(principal, workspaceId, "administer");
    const page = validateCursorOptions(options);
    const allowedOptions = new Set(["limit", "cursor", "collectionId", "state"]);
    for (const key of Object.keys(options)) if (!allowedOptions.has(key)) throw memoryError("invalid_request", "Source selectors are invalid.");
    const state = options.state;
    if (state !== undefined && state !== "all" && !["pending", "active", "paused", "revoked", "review-required"].includes(state)) throw memoryError("invalid_request", "Source state is invalid.");
    if (options.collectionId) {
      if (!administrableCollectionIds.includes(options.collectionId)) throw memoryError("not_found", "The memory collection is unavailable.");
    }
    const selectedCollections = options.collectionId ? [options.collectionId] : administrableCollectionIds;
    const filters = { collectionId: options.collectionId ?? null, state: state ?? "all" };
    const epochs = this.epochs(access.workspaceKey);
    const startAfter = this.cursorStart(page.cursor, "sources", access.workspaceKey, principal, filters, epochs);
    let found: SqlRow[] = [];
    if (selectedCollections.length) {
      const clauses = ["workspace_key=?", `collection_id IN (${selectedCollections.map(() => "?").join(",")})`, "source_id>?"];
      const values: SQLInputValue[] = [access.workspaceKey, ...selectedCollections, startAfter];
      if (state && state !== "all") { clauses.push("status=?"); values.push(state); }
      values.push(page.limit + 1);
      found = this.all(`SELECT * FROM memory_source_enrollments WHERE ${clauses.join(" AND ")} ORDER BY source_id LIMIT ?`, ...values);
    }
    const items = found.slice(0, page.limit).map(item => {
      const id = textColumn(item, "source_id");
      const revision = numberColumn(item, "revision");
      const stored = this.unseal<StoredSourcePayload>("memory_source_enrollments", id, revision, textColumn(item, "encrypted_payload"));
      return {
        ...stored,
        id,
        workspaceId,
        collectionId: textColumn(item, "collection_id"),
        status: textColumn(item, "status") as MemorySourceEnrollment["status"],
        revision,
      };
    });
    const nextCursor = found.length > page.limit && items.length
      ? this.pageCursor("sources", access.workspaceKey, principal, filters, epochs, items.at(-1)!.id)
      : null;
    const collectionIds = selectedCollections;
    const result: MemoryPage<MemorySourceEnrollment> = {
      binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, collectionIds),
      items,
      nextCursor,
      complete: true,
      coverageReasons: [],
    };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  getMutationStatus(actor: MemoryPrincipalSelector, workspaceId: string, requestId: string): AuthorizedRead<MemoryMutationStatusResult> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    validateIdentifier(requestId, "requestId");
    const principalKey = this.principalKey(principal.principalId);
    const receipt = this.one("SELECT * FROM memory_receipts WHERE principal_key=? AND request_id=?", principalKey, requestId);
    if (!receipt || textColumn(receipt, "workspace_key") !== this.workspaceKey(workspaceId)) throw memoryError("not_found", "The mutation status is unavailable.");
    const access = this.assertWorkspaceAccess(principal, workspaceId, { allowBindingReview: true });
    const operation = textColumn(receipt, "operation");
    const targetCollectionId = receipt.target_collection_id === null ? null : String(receipt.target_collection_id);
    if (targetCollectionId) {
      const required = operation === "grant_set" || operation === "grant_revoke" ? "share"
        : operation === "source_enroll" || operation === "source_pause" || operation === "source_revoke" ? "administer"
        : operation === "record_erase" ? "erase"
        : operation === "record_create" ? "curate"
        : operation === "record_propose" ? "propose"
        : "read";
      this.requireCollectionCapability(principal, workspaceId, targetCollectionId, required);
    } else {
      this.requireOwnerBinding(access.workspaceKey, principal, "administer");
    }
    const receiptState = textColumn(receipt, "state");
    const storedResponse = receiptState === "failed" ? this.replayMutation(receipt).response as MemoryMutationStatusResult : undefined;
    const status: MemoryMutationStatus = receiptState === "committed"
      ? {
          requestId,
          payloadDigest: textColumn(receipt, "payload_digest"),
          operation: operation as MemoryMutation["op"]["type"],
          state: "committed",
          receipt: (this.replayMutation(receipt).response as MemoryMutationResult).receipt,
          error: null,
        }
      : receiptState === "failed" && storedResponse
        ? storedResponse.status
        : {
          requestId,
          payloadDigest: textColumn(receipt, "payload_digest"),
          operation: operation as MemoryMutation["op"]["type"],
          state: "pending",
          receipt: null,
          error: { error: "unavailable", message: "The mutation is waiting for recovery acknowledgement.", retryable: true, requestId },
        };
    const collectionIds = targetCollectionId ? [targetCollectionId] : [];
    const result: MemoryMutationStatusResult = {
      binding: this.responseBinding(principal, workspaceId, access.binding.bindingEpoch, collectionIds, requestId),
      status,
    };
    return this.authorized(result, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  currentAuthorizationSnapshot(actor: MemoryPrincipalSelector, workspaceId: string): AuthorizedRead<MemoryAuthorizationSnapshot> {
    this.assertRecovery();
    const principal = this.currentPrincipal(actor);
    this.requireTaskRecall(principal);
    const access = this.assertWorkspaceAccess(principal, workspaceId, { requireRead: true });
    const collectionIds = this.authorizedCollectionIds(principal, workspaceId, "read");
    const epochs = this.epochs(access.workspaceKey);
    const value: MemoryAuthorizationSnapshot = {
      principal,
      workspace: access.view,
      currentBinding: access.binding,
      collectionIds,
      servingEpoch: epochs.servingEpoch,
      grantEpoch: epochs.grantEpoch,
    };
    return this.authorized(value, actor, principal, workspaceId, access.workspaceKey, access.binding.bindingEpoch);
  }

  revalidateResponse(actor: MemoryPrincipalSelector, fence: MemoryReadFence): void {
    this.assertRecovery();
    const token = memoryReadFenceToken(fence);
    const captured = this.fences.get(token);
    if (!captured || captured.expiresAt <= (this.options.now ?? Date.now)()) {
      this.fences.delete(token);
      throw memoryError("stale_binding_epoch", "Protected response fence expired.");
    }
    if (canonicalMemoryJson(actor) !== canonicalMemoryJson(captured.selector)) throw memoryError("not_found", "The memory response is no longer authorized.");
    const principal = this.currentPrincipal(actor);
    if (this.principalKey(principal.principalId) !== captured.principalKey
      || this.principalFingerprint(principal) !== captured.principalFingerprint) throw memoryError("not_found", "The memory response is no longer authorized.");
    const access = this.assertWorkspaceAccess(principal, captured.workspaceId, { allowBindingReview: captured.records.length === 0 });
    if (access.binding.state !== "active" || access.binding.bindingEpoch !== captured.bindingEpoch) throw memoryError("stale_binding_epoch", "Workspace binding changed before response delivery.");
    const workspace = this.workspaceRow(captured.workspaceId);
    if (this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", textColumn(workspace, "object_key"))) throw memoryError("not_found", "The memory response is no longer authorized.");
    if (captured.records.length && access.view.status !== "active") throw memoryError("binding_review_required", "Workspace repository binding needs owner review.");
    const epochs = this.epochs(captured.workspaceKey);
    if (epochs.servingEpoch !== captured.servingEpoch || epochs.grantEpoch !== captured.grantEpoch || epochs.sourceEpoch !== captured.sourceEpoch) throw memoryError("not_found", "The memory response is no longer authorized.");
    for (const key of captured.sourceKeys) {
      if (this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", key)) throw memoryError("not_found", "The memory response is no longer authorized.");
    }
    for (const reference of captured.records) {
      const current = this.one("SELECT * FROM memory_records WHERE record_key=?", reference.recordKey);
      if (!current || numberColumn(current, "revision") !== reference.revision
        || !this.recordEligible(current, (this.options.now ?? Date.now)())) throw memoryError("not_found", "The memory response is no longer authorized.");
      const collectionId = textColumn(current, "collection_id");
      this.requireTaskCollection(principal, collectionId);
      if (!this.directGrant(principal, captured.workspaceId, collectionId)?.capabilities.includes("read")) throw memoryError("not_found", "The memory response is no longer authorized.");
    }
  }

  provisionWorkspaceMemory(intent: MemoryProvisionIntent): AuthorizedRead<MemoryWorkspace> {
    this.assertRecovery();
    const principal = this.currentPrincipal(intent.actor);
    if (principal.kind !== "device" || principal.deviceRole !== "owner" || principal.deviceId !== intent.actor.deviceId) throw memoryError("not_found", "The memory workspace is unavailable.");
    const binding = this.currentBinding(intent.workspaceId);
    if (binding.state !== "active" || binding.bindingEpoch !== intent.expectedBindingEpoch || binding.bindingDigest !== intent.bindingDigest) throw memoryError("stale_binding_epoch", "Workspace binding changed before memory enablement.");
    validateIdentifier(intent.intentEventId, "intentEventId");
    const workspaceKey = this.workspaceKey(intent.workspaceId);
    const deviceKey = this.deviceKey(principal.deviceId!);
    const existing = this.one("SELECT * FROM memory_workspaces WHERE workspace_key=?", workspaceKey);
    if (existing) {
      const owner = this.ownerBindingRow(workspaceKey, principal.deviceId!);
      if (!owner) throw memoryError("not_found", "The memory workspace is unavailable.");
      const view = this.workspaceView(intent.workspaceId, existing, binding);
      return this.authorized(view, intent.actor, principal, intent.workspaceId, workspaceKey, binding.bindingEpoch);
    }
    const objectKey = this.opaque("workspace-object", intent.workspaceId);
    if (this.one("SELECT 1 FROM memory_tombstones WHERE object_key=?", objectKey)) throw memoryError("not_found", "The memory workspace is unavailable.");
    const now = this.timestamp();
    const ownerBinding: StoredOwnerBinding = {
      principalId: principal.principalId,
      deviceId: principal.deviceId!,
      workspaceId: intent.workspaceId,
      bindingEpoch: binding.bindingEpoch,
      grantEpoch: 1,
      capabilities: OWNER_CAPABILITIES,
      state: "active",
      intentEventId: intent.intentEventId,
    };
    const workspaceBinding: StoredWorkspaceBinding = {
      workspaceId: intent.workspaceId,
      repositoryBindings: binding.repositoryBindings,
      bindingDigest: binding.bindingDigest,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.transaction(() => {
      this.run("INSERT INTO memory_workspaces(workspace_key,revision,binding_epoch,state,object_key,encrypted_binding,created_at,updated_at) VALUES(?,1,?,'active',?,?,?,?)",
        workspaceKey, binding.bindingEpoch, objectKey, this.seal("memory_workspaces", workspaceKey, 1, workspaceBinding), now, now);
      this.run("INSERT INTO memory_owner_bindings(workspace_key,device_key,principal_key,grant_epoch,state,intent_event_id,encrypted_binding) VALUES(?,?,?,1,'active',?,?)",
        workspaceKey, deviceKey, this.principalKey(principal.principalId), intent.intentEventId,
        this.seal("memory_owner_bindings", `${workspaceKey}:${deviceKey}`, 1, ownerBinding));
      this.run("INSERT INTO memory_epochs(workspace_key,serving_epoch,grant_epoch,source_epoch) VALUES(?,1,1,1)", workspaceKey);
      this.run("INSERT INTO memory_events(event_id,workspace_key,resource_key,operation,payload_digest,created_at) VALUES(?,?,?,?,?,?)",
        intent.intentEventId, workspaceKey, objectKey, "workspace_enable", canonicalMemoryDigest({ workspaceId: intent.workspaceId, bindingEpoch: binding.bindingEpoch, bindingDigest: binding.bindingDigest }), now);
    });
    const created = this.workspaceRow(intent.workspaceId);
    return this.authorized(this.workspaceView(intent.workspaceId, created, binding), intent.actor, principal, intent.workspaceId, workspaceKey, binding.bindingEpoch);
  }

  // Remaining read and mutation methods are implemented below.

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.recoveryOpen = false;
    this.fences.clear();
    this.db.close();
  }

  // Remaining service methods are implemented below.
}
