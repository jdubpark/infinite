import type { MemoryRecord } from "@infinite/remote";

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

export interface MemoryProjectionLedger {
  assertCurrentPartition(partition: MemoryAdapterPartition): void;
  assertServingPartition(partition: MemoryAdapterPartition): void;
  assertCanonicalCurrent(partition: MemoryAdapterPartition): void;
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
  records: MemoryRecord[];
  recheckCurrent(): void;
}

export interface AuthorizedMemoryHydration {
  record: MemoryRecord | null;
  recheckCurrent(): void;
}

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

