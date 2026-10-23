import { createHash } from "node:crypto";
import { MEMORY_ERROR_STATUS, type MemoryCapability, type MemoryError, type MemoryMutation, type MemoryRecordPayload, type MemorySourceType } from "@infinite/remote";

const CAPABILITIES: MemoryCapability[] = ["administer", "curate", "erase", "feedback", "propose", "publish", "read", "review", "share"];
const SOURCE_TYPES: MemorySourceType[] = ["repository-briefing", "understanding-catalog", "owner-context", "linear-reference", "legacy-brain-import", "routing-outcome", "session-history"];
const SUPPRESSION_REASONS = ["obsolete", "misleading", "sensitive", "user_preference"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;

export type MemoryStoreErrorCode = MemoryError["error"];

export class MemoryStoreError extends Error {
  readonly status: number;
  constructor(
    public readonly error: MemoryStoreErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly requestId?: string,
    public readonly currentRevision?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "MemoryStoreError";
    this.status = MEMORY_ERROR_STATUS[error];
  }
}

export class MemoryUnsupportedOperationError extends Error {
  constructor(public readonly operation: string) {
    super(`Memory operation ${operation} is not implemented by the canonical foundation.`);
    this.name = "MemoryUnsupportedOperationError";
  }
}

export function memoryError(
  error: MemoryStoreErrorCode,
  message: string,
  options: { retryable?: boolean; requestId?: string; currentRevision?: number; retryAfterMs?: number } = {},
): MemoryStoreError {
  return new MemoryStoreError(error, message, options.retryable, options.requestId, options.currentRevision, options.retryAfterMs);
}

function invalid(message: string): never {
  throw memoryError("invalid_request", message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(`${name} must be a plain object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], name = "object"): void {
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${name} is missing a required field.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${name} contains an unknown field.`);
}

function boundedString(value: unknown, maxBytes: number, name: string, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes) invalid(`${name} is invalid.`);
  return value;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(`${name} is invalid.`);
  return Number(value);
}

function enumValue<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(`${name} is invalid.`);
  return value as T;
}

function date(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${name} is invalid.`);
  return value;
}

function jsonValue(value: unknown, depth = 0): void {
  if (depth > 32) invalid("JSON nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid("JSON numbers must be finite safe integers or finite fractions.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) jsonValue(item, depth + 1);
    return;
  }
  const objectValue = record(value, "JSON value");
  for (const item of Object.values(objectValue)) jsonValue(item, depth + 1);
}

/** Canonical JSON uses ECMAScript JSON strings/numbers and UTF-16 key ordering. */
export function canonicalMemoryJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical memory JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalMemoryJson).join(",")}]`;
  const objectValue = record(value, "canonical JSON value");
  const keys = Object.keys(objectValue).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalMemoryJson(objectValue[key])}`).join(",")}}`;
}

export function validateMemoryRecordPayload(value: unknown): MemoryRecordPayload {
  const payload = record(value, "record payload");
  exactKeys(payload, ["content", "kind", "sensitivity", "sourceRefs", "derivedFrom", "validFrom", "validUntil", "metadata"], [], "record payload");
  const content = boundedString(payload.content, 16 * 1024, "content");
  const kind = enumValue(payload.kind, ["claim", "context", "lesson", "outcome"] as const, "kind");
  const sensitivity = enumValue(payload.sensitivity, ["standard", "restricted"] as const, "sensitivity");
  if (!Array.isArray(payload.sourceRefs) || payload.sourceRefs.length > 100) invalid("sourceRefs is invalid.");
  const sourceRefs = payload.sourceRefs.map((item, index) => {
    const ref = record(item, `sourceRefs[${index}]`);
    exactKeys(ref, ["sourceEnrollmentId", "sourceId", "sourceRevision"], [], "source reference");
    return {
      sourceEnrollmentId: boundedString(ref.sourceEnrollmentId, 128, "source enrollment id"),
      sourceId: boundedString(ref.sourceId, 512, "source id"),
      sourceRevision: boundedString(ref.sourceRevision, 512, "source revision"),
    };
  });
  if (!Array.isArray(payload.derivedFrom) || payload.derivedFrom.length > 100) invalid("derivedFrom is invalid.");
  const derivedFrom = payload.derivedFrom.map((item, index) => {
    const ref = record(item, `derivedFrom[${index}]`);
    exactKeys(ref, ["recordId", "recordRevision"], [], "record reference");
    return {
      recordId: boundedString(ref.recordId, 128, "record id"),
      recordRevision: safeInteger(ref.recordRevision, "record revision", 1),
    };
  });
  const derivedKeys = derivedFrom.map(ref => `${ref.recordId}\u0000${String(ref.recordRevision).padStart(16, "0")}`);
  if (new Set(derivedKeys).size !== derivedKeys.length || derivedKeys.some((key, index) => index > 0 && derivedKeys[index - 1]! > key)) invalid("derivedFrom must be unique and sorted.");
  if (sourceRefs.length + derivedFrom.length > 100) invalid("Lineage exceeds its edge limit.");
  const sourceKeys = sourceRefs.map(ref => `${ref.sourceEnrollmentId}\u0000${ref.sourceId}\u0000${ref.sourceRevision}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) invalid("sourceRefs must be unique.");
  const metadata = record(payload.metadata, "metadata");
  jsonValue(metadata);
  if (Buffer.byteLength(canonicalMemoryJson(metadata), "utf8") > 4 * 1024) invalid("metadata exceeds its size limit.");
  return {
    content,
    kind,
    sensitivity,
    sourceRefs,
    derivedFrom,
    validFrom: date(payload.validFrom, "validFrom"),
    validUntil: date(payload.validUntil, "validUntil"),
    metadata: metadata as MemoryRecordPayload["metadata"],
  };
}

function validMicrounits(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid("maxCostMicrounits is invalid.");
  return value;
}

function validateProcessingPolicy(value: unknown): void {
  const policy = record(value, "processing policy");
  exactKeys(policy, ["mode", "operations", "maxInputBytes", "maxInputTokens", "maxOutputTokens", "maxCostMicrounits"], [], "processing policy");
  const mode = enumValue(policy.mode, ["local_lexical_only", "configured_external"] as const, "processing mode");
  const operations = policy.operations;
  if (!Array.isArray(operations) || operations.length > 20) invalid("processing operations are invalid.");
  const keys: string[] = [];
  for (const item of operations) {
    const operation = record(item, "processing operation");
    exactKeys(operation, ["operation", "providerId", "endpointId", "modelId"], [], "processing operation");
    enumValue(operation.operation, ["extraction", "embedding", "consolidation", "deep-recall"] as const, "processing operation kind");
    const key = [operation.operation, operation.providerId, operation.endpointId, operation.modelId].map(value => boundedString(value, 128, "processing identity")).join("\u0000");
    keys.push(key);
  }
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! > key)) invalid("processing operations must be unique and sorted.");
  const maxInputBytes = safeInteger(policy.maxInputBytes, "maxInputBytes");
  const maxInputTokens = safeInteger(policy.maxInputTokens, "maxInputTokens");
  const maxOutputTokens = safeInteger(policy.maxOutputTokens, "maxOutputTokens");
  const maxCost = validMicrounits(policy.maxCostMicrounits);
  if (mode === "local_lexical_only") {
    if (operations.length || maxInputBytes !== 0 || maxInputTokens !== 0 || maxOutputTokens !== 0 || maxCost !== "0") invalid("Local lexical processing cannot authorize external work.");
  } else if (!operations.length || maxInputBytes === 0 || maxInputTokens === 0 || maxCost === "0") {
    invalid("Configured external processing requires explicit operations and positive limits.");
  }
}

function validateRetentionPolicy(value: unknown): void {
  const policy = record(value, "retention policy");
  exactKeys(policy, ["rawPayloadDays", "candidateDays", "sourceValidationDays", "archivedDays", "receiptMinimumDays"], [], "retention policy");
  const raw = safeInteger(policy.rawPayloadDays, "rawPayloadDays");
  safeInteger(policy.candidateDays, "candidateDays");
  safeInteger(policy.sourceValidationDays, "sourceValidationDays");
  safeInteger(policy.archivedDays, "archivedDays");
  const receipts = safeInteger(policy.receiptMinimumDays, "receiptMinimumDays");
  if (raw !== 0) invalid("Raw payload retention intent is not available in the canonical foundation.");
  if (receipts < 365) invalid("Receipt retention cannot be shorter than 365 days.");
}

function validateCoreOperation(value: unknown): MemoryMutation["op"] {
  const operation = record(value, "operation");
  const type = boundedString(operation.type, 64, "operation type");
  switch (type) {
    case "collection_create":
      exactKeys(operation, ["type", "scope"], [], type);
      enumValue(operation.scope, ["private", "shared", "global"] as const, "scope");
      break;
    case "record_create":
    case "record_propose":
      exactKeys(operation, ["type", "collectionId", "payload"], [], type);
      boundedString(operation.collectionId, 128, "collectionId");
      validateMemoryRecordPayload(operation.payload);
      break;
    case "grant_set": {
      exactKeys(operation, ["type", "collectionId", "subjectKind", "subjectId", "capabilities"], [], type);
      boundedString(operation.collectionId, 128, "collectionId");
      enumValue(operation.subjectKind, ["workspace", "device", "task"] as const, "subjectKind");
      boundedString(operation.subjectId, 256, "subjectId");
      if (!Array.isArray(operation.capabilities) || !operation.capabilities.length) invalid("capabilities is invalid.");
      const capabilities = operation.capabilities.map(value => enumValue(value, CAPABILITIES, "capability"));
      if (new Set(capabilities).size !== capabilities.length || capabilities.some((value, index) => index > 0 && capabilities[index - 1]! >= value)) invalid("capabilities must be unique and sorted.");
      break;
    }
    case "grant_revoke":
      exactKeys(operation, ["type", "grantId"], [], type);
      boundedString(operation.grantId, 128, "grantId");
      break;
    case "source_enroll": {
      exactKeys(operation, ["type", "collectionId", "sourceType", "stableSourceId", "allowedFields", "processingPolicy", "retentionPolicy"], [], type);
      boundedString(operation.collectionId, 128, "collectionId");
      enumValue(operation.sourceType, SOURCE_TYPES, "sourceType");
      boundedString(operation.stableSourceId, 512, "stableSourceId");
      if (!Array.isArray(operation.allowedFields) || operation.allowedFields.length === 0 || operation.allowedFields.length > 100) invalid("allowedFields is invalid.");
      const fields = operation.allowedFields.map(value => boundedString(value, 128, "allowed field"));
      if (new Set(fields).size !== fields.length || fields.some((value, index) => index > 0 && fields[index - 1]! >= value)) invalid("allowedFields must be unique and sorted.");
      validateProcessingPolicy(operation.processingPolicy);
      validateRetentionPolicy(operation.retentionPolicy);
      break;
    }
    case "source_pause":
    case "source_revoke":
      exactKeys(operation, ["type", "sourceEnrollmentId"], [], type);
      boundedString(operation.sourceEnrollmentId, 128, "sourceEnrollmentId");
      break;
    case "record_archive":
      exactKeys(operation, ["type", "recordId"], [], type);
      boundedString(operation.recordId, 128, "recordId");
      break;
    case "record_erase":
      exactKeys(operation, ["type", "recordId", "reasonCode"], [], type);
      boundedString(operation.recordId, 128, "recordId");
      if (!/^[A-Za-z0-9_]{1,64}$/.test(boundedString(operation.reasonCode, 64, "reasonCode"))) invalid("reasonCode is invalid.");
      break;
    case "workspace_review_binding":
      exactKeys(operation, ["type", "repositoryBindingsDigest"], [], type);
      if (!DIGEST.test(boundedString(operation.repositoryBindingsDigest, 64, "repositoryBindingsDigest"))) invalid("repositoryBindingsDigest is invalid.");
      break;
    case "record_suppress":
      exactKeys(operation, ["type", "recordId", "reasonCode"], [], type);
      boundedString(operation.recordId, 128, "recordId");
      enumValue(operation.reasonCode, SUPPRESSION_REASONS, "reasonCode");
      throw new MemoryUnsupportedOperationError(type);
    default:
      throw new MemoryUnsupportedOperationError(type);
  }
  return operation as unknown as MemoryMutation["op"];
}

export function validateFoundationMutation(value: unknown): MemoryMutation {
  const mutation = record(value, "mutation");
  exactKeys(mutation, ["requestId", "expectedRevision", "expectedBindingEpoch", "op"], [], "mutation");
  const requestId = boundedString(mutation.requestId, 64, "requestId");
  if (!UUID.test(requestId)) invalid("requestId must be a UUID.");
  safeInteger(mutation.expectedRevision, "expectedRevision", 1);
  safeInteger(mutation.expectedBindingEpoch, "expectedBindingEpoch", 1);
  const op = validateCoreOperation(mutation.op);
  return { requestId, expectedRevision: Number(mutation.expectedRevision), expectedBindingEpoch: Number(mutation.expectedBindingEpoch), op };
}

export function isMemoryDigest(value: string): boolean { return DIGEST.test(value); }

export function canonicalMemoryDigest(value: unknown): string {
  return createHash("sha256").update(canonicalMemoryJson(value), "utf8").digest("hex");
}

export function canonicalMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

export function memoryLexicalTerms(value: string): string[] {
  return [...new Set(value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [])].sort();
}

export function validateCursorOptions(value: { limit?: number; cursor?: string }): { limit: number; cursor?: string } {
  const limit = value.limit === undefined ? 50 : safeInteger(value.limit, "limit", 1);
  if (limit > 100) invalid("limit exceeds its bound.");
  if (value.cursor !== undefined) boundedString(value.cursor, 2048, "cursor");
  return { limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
}

export function validateIdentifier(value: string, name: string): void {
  boundedString(value, 512, name);
}
