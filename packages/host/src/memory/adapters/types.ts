import type { MemoryRecord } from "@infinite/remote";

/** Provider-neutral projection adapter contracts. Canonical records remain in Infinite. */
export type MemoryAdapterHealthState = "ready" | "degraded" | "unavailable" | "quarantined";
export type MemoryIndexEventKind = "snapshot" | "upsert" | "delete" | "revoke" | "checkpoint";
export type MemoryIndexState = "indexed" | "pending" | "disabled" | "quarantined";

export interface MemoryAdapterPartition {
  workspaceId: string;
  collectionId: string;
  generationId: string;
  bindingEpoch: number;
  sourceEpoch: number;
}

export interface MemoryIndexSourceEvent {
  partition: MemoryAdapterPartition;
  sourceEnrollmentId: string;
  sourceId: string;
  sourceRevision: string;
  eventId: string;
  kind: MemoryIndexEventKind;
  payloadHash: string;
  recordId: string;
  recordRevision: number;
  text: string | null;
  observedAt: string;
}

export interface MemoryCandidateHandle {
  partition: MemoryAdapterPartition;
  handle: string;
  recordId: string;
  recordRevision: number;
}

export interface MemoryAdapterCandidate {
  candidate: MemoryCandidateHandle;
  score: number;
  match: "exact" | "lexical" | "semantic";
}

/** Provider-index linkage. Canonical lexical candidates do not require this metadata. */
export interface IndexedCandidateMapping {
  partition: MemoryAdapterPartition;
  handle: string;
  recordId: string;
  recordRevision: number;
  sourceEnrollmentId: string;
  sourceId: string;
  sourceRevision: string;
  payloadHash: string;
  eventId: string;
  eventKind: MemoryIndexEventKind;
}

export interface MemoryIndexReceipt {
  eventId: string;
  payloadHash: string;
  lexical: MemoryIndexState;
  semantic: MemoryIndexState;
  providerReceipt: string | null;
}

export interface MemoryAdapterHealth {
  state: MemoryAdapterHealthState;
  provider: "lexical" | "honcho";
  activeGenerationId: string | null;
  lexicalLagMs: number | null;
  semanticLagMs: number | null;
  quarantined: boolean;
  modelEndpointId: string | null;
  embeddingEndpointId: string | null;
  reason: string | null;
}

/** Current authorization and durable projection metadata supplied by Infinite's store. */
export interface MemoryProjectionLedger {
  /** Synchronous host-owned epoch check. Throw before use if binding/source epochs are stale. */
  assertCurrentPartition(partition: MemoryAdapterPartition): void;
  /** Only ready/active generations may be queried or hydrated. */
  assertServingPartition(partition: MemoryAdapterPartition): void;
  /** Canonical authorization/epoch check without honoring the adapter quarantine flag. */
  assertCanonicalCurrent(partition: MemoryAdapterPartition): void;
  /** Persisted quarantine status is checked when opening and before every use. */
  isQuarantined(partition: MemoryAdapterPartition): boolean;
  findCandidate(partition: MemoryAdapterPartition, handle: string): Promise<IndexedCandidateMapping | null>;
  findEvent(event: Pick<MemoryIndexSourceEvent, "partition" | "eventId" | "sourceEnrollmentId" | "sourceId" | "sourceRevision" | "kind" | "payloadHash">): Promise<MemoryIndexReceipt | null>;
  recordIndexEvent(mapping: IndexedCandidateMapping, receipt: MemoryIndexReceipt): Promise<void>;
  quarantine(partition: MemoryAdapterPartition, reason: string): Promise<void>;
  beginRebuild(input: { collectionId: string; workspaceId: string; generationId: string; expectedBindingEpoch: number; expectedSourceEpoch: number; sourceManifestDigest: string; expectedProjectionCount: number }): Promise<void>;
  writeRebuildBatch(input: { partition: MemoryAdapterPartition; cursor: string; batchDigest: string; mappings: IndexedCandidateMapping[] }): Promise<void>;
  sealRebuild(input: { partition: MemoryAdapterPartition; expectedSourceManifestDigest: string }): Promise<void>;
  activateGeneration(input: { partition: MemoryAdapterPartition; expectedCurrentGenerationId: string | null; expectedBindingEpoch: number; expectedSourceEpoch: number }): Promise<void>;
}

export interface AuthorizedMemoryLexicalRead {
  /** Only recall-eligible records, including authorized candidates with complete lineage. */
  records: MemoryRecord[];
  /** Revalidate the opaque canonical read proof, including grants, time and lineage. */
  recheckCurrent(): void;
}

export interface AuthorizedMemoryHydration {
  /** Null when the exact record revision is no longer eligible for ordinary recall. */
  record: MemoryRecord | null;
  /** Revalidate the same canonical proof after any asynchronous boundary. */
  recheckCurrent(): void;
}

/** Bounded read and hydration from Infinite's current authorized canonical index. */
export interface MemoryLexicalSource {
  searchAuthorizedRecords(input: MemoryAdapterSearchInput): Promise<AuthorizedMemoryLexicalRead>;
  hydrateCurrent(partition: MemoryAdapterPartition, recordId: string, recordRevision: number): Promise<AuthorizedMemoryHydration>;
}

export interface MemoryAdapterSearchInput {
  partition: MemoryAdapterPartition;
  query: string;
  mode: "exact" | "lexical";
  limit: number;
  sourceEnrollmentIds?: string[];
}

export interface MemoryIndexInput {
  event: MemoryIndexSourceEvent;
  semanticDestination?: { providerId: string; endpointId: string; modelId: string };
  processingAllowed: boolean;
}

export interface MemoryAdapter {
  health(): Promise<MemoryAdapterHealth>;
  indexSourceEvent(input: MemoryIndexInput): Promise<MemoryIndexReceipt>;
  searchLexical(input: MemoryAdapterSearchInput): Promise<MemoryAdapterCandidate[]>;
  searchSemantic(input: MemoryAdapterSearchInput & {
    destination: { providerId: string; endpointId: string; modelId: string };
    reservationId: string;
  }): Promise<MemoryAdapterCandidate[]>;
  hydrateCandidate(candidate: MemoryCandidateHandle): Promise<MemoryRecord>;
  revokeAndQuarantine(partition: MemoryAdapterPartition, reason: string): Promise<void>;
  beginRebuild(input: { collectionId: string; workspaceId: string; generationId: string; expectedBindingEpoch: number; expectedSourceEpoch: number; sourceManifestDigest: string; expectedProjectionCount: number }): Promise<void>;
  writeRebuildBatch(input: { partition: MemoryAdapterPartition; cursor: string; batchDigest: string; mappings: IndexedCandidateMapping[] }): Promise<void>;
  sealRebuild(input: { partition: MemoryAdapterPartition; expectedSourceManifestDigest: string }): Promise<void>;
  activateGeneration(input: { partition: MemoryAdapterPartition; expectedCurrentGenerationId: string | null; expectedBindingEpoch: number; expectedSourceEpoch: number }): Promise<void>;
}

export interface MemoryProcessingReservation {
  reservationId: string;
  providerId: string;
  endpointId: string;
  modelId: string;
  inputBytes: number;
  maxInputTokens: number;
  maxCostMicrounits: string;
}

/** Must atomically persist the budget reservation before authorizing an external request. */
export interface MemoryProcessingGateway {
  reserveEmbedding(input: {
    partition: MemoryAdapterPartition;
    query: string;
    destination: { providerId: string; endpointId: string; modelId: string };
  }): Promise<MemoryProcessingReservation>;
  settleEmbedding(input: {
    reservation: MemoryProcessingReservation;
    outcome: "completed" | "uncertain";
    inputBytes: number;
    inputTokens: number;
    costMicrounits: string;
  }): Promise<void>;
  assertReservationCurrent(reservationId: string, partition: MemoryAdapterPartition): Promise<void>;
}
