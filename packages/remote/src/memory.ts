/** Memory wire contract. Authority always comes from the authenticated host context. */
export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MEMORY_PACKET_MAX_TOKENS = 512;
export const MEMORY_PACKET_MAX_CLAIMS = 8;
export const MEMORY_RECALL_MAX_CANDIDATES = 20;

export type MemoryJson = null | boolean | number | string | MemoryJson[] | { [key: string]: MemoryJson };
/** Canonical nonnegative decimal integer string; accounting uses BigInt on the host. */
export type MemoryMicrounits = string;
export type MemoryCapability = "read" | "propose" | "review" | "curate" | "feedback" | "share" | "publish" | "administer" | "erase";
export type MemoryScope = "private" | "shared" | "global";
export type MemoryLifecycle = "candidate" | "active" | "superseded" | "invalidated" | "archived" | "erased";
export type MemoryProvenanceClass = "owner-authored" | "source-evidence" | "model-candidate" | "reviewed-lesson" | "advisory-outcome";
export type MemoryRecallMode = "exact" | "lexical" | "hybrid";

export interface MemoryRepositoryBinding {
  repositoryIdentity: string;
  projectIds: string[];
  rootIdentityDigest: string;
}
export interface MemoryWorkspace {
  workspaceId: string;
  revision: number;
  bindingEpoch: number;
  repositoryBindings: MemoryRepositoryBinding[];
  status: "active" | "review-required" | "retired";
  createdAt: string;
  updatedAt: string;
}
export interface MemoryCollection {
  collectionId: string;
  ownerWorkspaceId: string;
  scope: MemoryScope;
  revision: number;
  status: "active" | "archived" | "erased";
}
export interface MemorySourceRef {
  sourceEnrollmentId: string;
  sourceId: string;
  sourceRevision: string;
}
export interface MemoryRecordRef { recordId: string; recordRevision: number }
export interface MemoryRecordPayload {
  content: string;
  kind: "claim" | "context" | "lesson" | "outcome";
  sensitivity: "standard" | "restricted";
  sourceRefs: MemorySourceRef[];
  derivedFrom: MemoryRecordRef[];
  validFrom: string | null;
  validUntil: string | null;
  metadata: { [key: string]: MemoryJson };
}
export interface MemoryRecord extends MemoryRecordPayload {
  id: string;
  workspaceId: string;
  collectionId: string;
  revision: number;
  provenanceClass: MemoryProvenanceClass;
  lifecycle: MemoryLifecycle;
  suppressed: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface MemoryGrant {
  id: string;
  collectionId: string;
  subjectKind: "workspace" | "device" | "task";
  subjectId: string;
  capabilities: MemoryCapability[];
  revision: number;
  grantEpoch: number;
  state: "active" | "revoked";
}

export type MemorySourceType = "repository-briefing" | "understanding-catalog" | "owner-context" | "linear-reference" | "legacy-brain-import" | "routing-outcome" | "session-history";
export type MemoryProcessingOperation = "extraction" | "embedding" | "consolidation" | "deep-recall";
export interface MemoryProcessingDestination {
  operation: MemoryProcessingOperation;
  providerId: string;
  endpointId: string;
  modelId: string;
}
export interface MemoryProcessingPolicy {
  mode: "local_lexical_only" | "configured_external";
  operations: MemoryProcessingDestination[];
  maxInputBytes: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicrounits: MemoryMicrounits;
}
export interface MemoryRetentionPolicy {
  rawPayloadDays: number;
  candidateDays: number;
  sourceValidationDays: number;
  archivedDays: number;
  receiptMinimumDays: number;
}
export interface MemorySourceEnrollment {
  id: string;
  workspaceId: string;
  collectionId: string;
  sourceType: MemorySourceType;
  stableSourceId: string;
  bindingDigest: string;
  allowedFields: string[];
  processingPolicy: MemoryProcessingPolicy;
  retentionPolicy: MemoryRetentionPolicy;
  status: "pending" | "active" | "paused" | "revoked" | "review-required";
  revision: number;
  enrolledByPrincipal: string;
  enrolledAt: string;
}

export interface MemoryReviewInput { recordId: string; expectedRevision: number; payloadDigest: string }
export type MemoryReviewOperation = {
  type: "record_review";
  recordId: string;
  inputRevisions: MemoryReviewInput[];
  reasonCode: string;
} & (
  | { decision: "accept" | "reject" | "keep_separate"; supersedeRecordIds?: never; resultPayload?: never; resultPayloadDigest?: never }
  | { decision: "merge"; supersedeRecordIds?: string[]; resultPayload: MemoryRecordPayload; resultPayloadDigest: string }
  | { decision: "supersede"; supersedeRecordIds: string[]; resultPayload: MemoryRecordPayload; resultPayloadDigest: string }
);
export type MemoryOperation =
  | { type: "collection_create"; scope: MemoryScope }
  | { type: "record_create"; collectionId: string; payload: MemoryRecordPayload }
  | { type: "record_propose"; collectionId: string; payload: MemoryRecordPayload }
  | { type: "record_revise"; recordId: string; payload: MemoryRecordPayload }
  | { type: "record_correct"; recordId: string; payload: MemoryRecordPayload }
  | MemoryReviewOperation
  | { type: "grant_set"; collectionId: string; subjectKind: MemoryGrant["subjectKind"]; subjectId: string; capabilities: MemoryCapability[] }
  | { type: "grant_revoke"; grantId: string }
  | { type: "record_publish"; recordId: string; sanitizedText: string; sanitizedTextDigest: string; destinationCollectionId: string; destinationExpectedRevision: number }
  | { type: "record_suppress"; recordId: string; reasonCode: "obsolete" | "misleading" | "sensitive" | "user_preference" }
  | { type: "record_unsuppress"; recordId: string }
  | { type: "record_archive"; recordId: string }
  | { type: "record_erase"; recordId: string; reasonCode: string }
  | { type: "source_enroll"; collectionId: string; sourceType: MemorySourceType; stableSourceId: string; allowedFields: string[]; processingPolicy: MemoryProcessingPolicy; retentionPolicy: MemoryRetentionPolicy }
  | { type: "source_pause"; sourceEnrollmentId: string }
  | { type: "source_revoke"; sourceEnrollmentId: string }
  | { type: "feedback_record"; retrievalReceiptId: string; recordId: string; recordRevision: number; signal: "relevant" | "wrong" | "stale" }
  | { type: "workspace_review_binding"; repositoryBindingsDigest: string };
export interface MemoryMutation {
  requestId: string;
  expectedRevision: number;
  expectedBindingEpoch: number;
  op: MemoryOperation;
}
export interface MemoryResponseBinding {
  hostId: string;
  workspaceId: string;
  collectionIds: string[];
  bindingEpoch: number;
  taskBindingId: string | null;
  requestId: string;
}
export interface MemoryMutationReceipt {
  requestId: string;
  payloadDigest: string;
  operation: MemoryOperation["type"];
  outcome: "committed";
  resourceId: string;
  resultingRevision: number;
  committedAt: string;
}
export interface MemoryMutationResult { binding: MemoryResponseBinding; receipt: MemoryMutationReceipt }
export const MEMORY_ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  not_found: 404,
  stale_revision: 409,
  idempotency_key_reused: 409,
  binding_review_required: 409,
  stale_binding_epoch: 409,
  revoked_or_tombstoned: 410,
  limit_exceeded: 413,
  recovery_required: 423,
  quota_exceeded: 429,
  unavailable: 503,
} as const;
export interface MemoryError {
  error: keyof typeof MEMORY_ERROR_STATUS;
  message: string;
  retryable: boolean;
  requestId?: string;
  currentRevision?: number;
  retryAfterMs?: number;
}
export type MemoryMutationStatus = {
  requestId: string;
  payloadDigest: string;
  operation: MemoryOperation["type"];
} & (
  | { state: "pending" | "failed"; receipt: null; error: MemoryError }
  | { state: "committed"; receipt: MemoryMutationReceipt; error: null }
);

export interface MemoryRecallBounds {
  requestId: string;
  expectedBindingEpoch: number;
  collectionIds?: string[];
  query: string;
  limit: number;
  maxPacketTokens?: number;
  maxClaims?: number;
}
export interface MemoryRecallRequest extends MemoryRecallBounds { mode: MemoryRecallMode }
export interface MemoryDeepRecallRequest extends MemoryRecallBounds { maxEvidenceRecords: number }
export type MemoryRecallReason = "exact_identifier" | "exact_term" | "lexical_match" | "semantic_match" | "task_condition" | "evidence_quality" | "freshness";
export interface MemoryRecallItem {
  recordId: string;
  recordRevision: number;
  text: string;
  status: "owner" | "source" | "proposed" | "reviewed";
  lifecycle: MemoryLifecycle;
  validFrom: string | null;
  validUntil: string | null;
  sourceRefs: MemorySourceRef[];
  whyRecalled: MemoryRecallReason[];
}
export interface MemoryPacket { text: string; usedTokens: number; maxTokens: number; claimCount: number }
export interface MemoryCoverage {
  lexical: "complete" | "pending" | "unavailable";
  semantic: "disabled" | "complete" | "pending" | "unavailable";
}
export type MemoryCoverageReason = "processing_disallowed" | "semantic_disabled" | "semantic_pending" | "semantic_unavailable" | "source_pending" | "packet_limit";
export interface MemoryMeteringEntry {
  operation: "embedding" | "deep-recall";
  providerId: string;
  endpointId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputBytes: number;
  outputBytes: number;
  costMicrounits: MemoryMicrounits;
  querySent: boolean;
  sourceContentSent: boolean;
  outcome: "completed" | "uncertain";
  reservationId: string;
}
export interface MemoryRecallResult {
  kind: "recall";
  receiptId: string;
  binding: MemoryResponseBinding;
  mode: MemoryRecallMode;
  items: MemoryRecallItem[];
  packet: MemoryPacket;
  complete: boolean;
  coverageReasons: MemoryCoverageReason[];
  coverage: MemoryCoverage;
  omittedAuthorizedCount: number;
  metering: MemoryMeteringEntry[];
  servingEpoch: number;
}
export interface MemoryDeepRecallResult {
  kind: "deep_recall";
  receiptId: string;
  binding: MemoryResponseBinding;
  authorityId: string;
  evidence: MemoryRecallItem[];
  proposal: { text: string; untrusted: true; sourceRefs: MemorySourceRef[] } | null;
  packet: MemoryPacket;
  complete: boolean;
  coverageReasons: MemoryCoverageReason[];
  coverage: MemoryCoverage;
  omittedAuthorizedCount: number;
  metering: MemoryMeteringEntry[];
  servingEpoch: number;
}
export interface MemoryRetrievalReceipt {
  receiptId: string;
  requestId: string;
  payloadDigest: string;
  kind: "recall" | "deep_recall";
  binding: MemoryResponseBinding;
  mode: MemoryRecallMode | null;
  recordRefs: MemoryRecordRef[];
  complete: boolean;
  coverageReasons: MemoryCoverageReason[];
  coverage: MemoryCoverage;
  semanticLagMs: number | null;
  metering: MemoryMeteringEntry[];
  createdAt: string;
}
export interface MemoryPage<T> {
  binding: MemoryResponseBinding;
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  coverageReasons: MemoryCoverageReason[];
}
export interface MemoryConflict {
  id: string;
  revision: number;
  state: "open" | "resolved";
  recordRefs: MemoryRecordRef[];
}
export interface MemoryWorkspaceResult {
  binding: MemoryResponseBinding;
  workspace: MemoryWorkspace;
  coverage: MemoryCoverage;
  coverageReasons: MemoryCoverageReason[];
}
export interface MemoryRecordResult { binding: MemoryResponseBinding; record: MemoryRecord }
export interface MemoryMutationStatusResult { binding: MemoryResponseBinding; status: MemoryMutationStatus }
export interface MemoryRetrievalReceiptResult { binding: MemoryResponseBinding; receipt: MemoryRetrievalReceipt }
