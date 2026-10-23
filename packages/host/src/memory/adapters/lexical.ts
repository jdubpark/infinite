import { createHash } from "node:crypto";
import type { MemoryRecord } from "@infinite/remote";
import { canonicalMemoryText, memoryLexicalTerms } from "../policy.js";
import type {
  MemoryAdapterCandidate, MemoryAdapterHealth, MemoryAdapterPartition, MemoryCandidateHandle,
  IndexedCandidateMapping, MemoryIndexReceipt, MemoryProjectionLedger, MemoryLexicalSource,
  MemoryAdapterSearchInput, MemoryIndexInput, MemoryAdapter,
} from "./types.js";

const MAX_PAGE_SIZE = 20;

function partitionKey(partition: MemoryAdapterPartition): string {
  return [partition.workspaceId, partition.collectionId, partition.generationId,
    partition.bindingEpoch, partition.sourceEpoch].join("\u0000");
}

function candidateHandle(partition: MemoryAdapterPartition, recordId: string, recordRevision: number): string {
  const digest = createHash("sha256").update(JSON.stringify([
    partitionKey(partition), recordId, recordRevision,
  ])).digest("base64url");
  return `mh_${digest}`;
}

export function projectionHandle(mapping: Omit<IndexedCandidateMapping, "handle">): string {
  return candidateHandle(mapping.partition, mapping.recordId, mapping.recordRevision);
}

function rank(input: MemoryAdapterSearchInput, record: MemoryRecord): { score: number; match: "exact" | "lexical" } | null {
  const normalizedQuery = canonicalMemoryText(input.query);
  if (!normalizedQuery) return null;
  if (input.query === record.id || normalizedQuery === canonicalMemoryText(record.content)) return { score: 1, match: "exact" };
  if (input.mode === "exact") return null;
  const queryTokens = memoryLexicalTerms(input.query).slice(0, 64);
  if (!queryTokens.length) return null;
  const textTokens = new Set(memoryLexicalTerms(record.content));
  const matched = queryTokens.reduce((count, token) => count + Number(textTokens.has(token)), 0);
  return matched ? { score: matched / queryTokens.length, match: "lexical" } : null;
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer from 1 to 20");
  return Math.min(limit, MAX_PAGE_SIZE);
}

function candidateFor(partition: MemoryAdapterPartition, record: MemoryRecord): MemoryCandidateHandle {
  return { partition, handle: candidateHandle(partition, record.id, record.revision), recordId: record.id, recordRevision: record.revision };
}

export class LexicalMemoryAdapter implements MemoryAdapter {
  constructor(
    private readonly ledger: MemoryProjectionLedger,
    private readonly source: MemoryLexicalSource,
  ) {}

  async health(): Promise<MemoryAdapterHealth> {
    return {
      state: "degraded", provider: "lexical", activeGenerationId: null,
      lexicalLagMs: null, semanticLagMs: null, quarantined: false,
      modelEndpointId: null, embeddingEndpointId: null,
      reason: "lexical availability and lag are evaluated per authorized partition",
    };
  }

  async indexSourceEvent({ event, processingAllowed }: MemoryIndexInput): Promise<MemoryIndexReceipt> {
    this.ledger.assertCanonicalCurrent(event.partition);
    const prior = await this.ledger.findEvent(event);
    if (prior) return prior;
    this.ledger.assertCurrentPartition(event.partition);
    const mappingBase = {
      partition: event.partition, recordId: event.recordId, recordRevision: event.recordRevision,
      sourceEnrollmentId: event.sourceEnrollmentId, sourceId: event.sourceId,
      sourceRevision: event.sourceRevision, payloadHash: event.payloadHash,
      eventId: event.eventId, eventKind: event.kind,
    };
    const mapping: IndexedCandidateMapping = { ...mappingBase, handle: projectionHandle(mappingBase) };
    const receipt: MemoryIndexReceipt = {
      eventId: event.eventId,
      payloadHash: event.payloadHash,
      lexical: event.kind === "delete" || event.kind === "revoke" ? "quarantined" : "indexed",
      semantic: event.kind === "delete" || event.kind === "revoke" ? "quarantined" : processingAllowed ? "pending" : "quarantined",
      providerReceipt: null,
    };
    await this.ledger.recordIndexEvent(mapping, receipt);
    this.ledger.assertCanonicalCurrent(event.partition);
    return await this.ledger.findEvent(event) ?? receipt;
  }

  async searchLexical(input: MemoryAdapterSearchInput): Promise<MemoryAdapterCandidate[]> {
    const limit = boundedLimit(input.limit);
    this.ledger.assertCanonicalCurrent(input.partition);
    const authorized = await this.source.searchAuthorizedRecords({ ...input, limit });
    if (authorized.records.length > MAX_PAGE_SIZE) throw new Error("canonical lexical index exceeded the bounded result limit");
    authorized.recheckCurrent();
    this.ledger.assertCanonicalCurrent(input.partition);
    const allowedSources = input.sourceEnrollmentIds ? new Set(input.sourceEnrollmentIds) : null;
    const ranked = authorized.records.flatMap(record => {
      if (record.workspaceId !== input.partition.workspaceId || record.collectionId !== input.partition.collectionId) return [];
      if (allowedSources && !record.sourceRefs.some(ref => allowedSources.has(ref.sourceEnrollmentId))) return [];
      const result = rank(input, record);
      if (!result) return [];
      return [{ candidate: candidateFor(input.partition, record), ...result }];
    }).sort((left, right) => Number(right.match === "exact") - Number(left.match === "exact") || right.score - left.score ||
      (left.candidate.recordId < right.candidate.recordId ? -1 : left.candidate.recordId > right.candidate.recordId ? 1 : 0));
    authorized.recheckCurrent();
    this.ledger.assertCanonicalCurrent(input.partition);
    return ranked.slice(0, limit);
  }

  async searchSemantic(): Promise<MemoryAdapterCandidate[]> {
    throw new Error("semantic retrieval is unavailable in the lexical adapter");
  }

  async hydrateCandidate(candidate: MemoryCandidateHandle): Promise<MemoryRecord> {
    this.ledger.assertCanonicalCurrent(candidate.partition);
    if (candidate.handle !== candidateHandle(candidate.partition, candidate.recordId, candidate.recordRevision))
      throw new Error("unknown or forged candidate handle");
    const hydrated = await this.source.hydrateCurrent(candidate.partition, candidate.recordId, candidate.recordRevision);
    hydrated.recheckCurrent();
    this.ledger.assertCanonicalCurrent(candidate.partition);
    const record = hydrated.record;
    if (!record || record.id !== candidate.recordId || record.revision !== candidate.recordRevision ||
      record.workspaceId !== candidate.partition.workspaceId || record.collectionId !== candidate.partition.collectionId)
      throw new Error("candidate is no longer current and authorized");
    return record;
  }

  async revokeAndQuarantine(partition: MemoryAdapterPartition, reason: string): Promise<void> {
    this.ledger.assertCurrentPartition(partition);
    await this.ledger.quarantine(partition, reason);
  }

  async beginRebuild(input: Parameters<MemoryProjectionLedger["beginRebuild"]>[0]): Promise<void> {
    const partition = {
      workspaceId: input.workspaceId, collectionId: input.collectionId,
      generationId: input.generationId, bindingEpoch: input.expectedBindingEpoch,
      sourceEpoch: input.expectedSourceEpoch,
    };
    this.ledger.assertCanonicalCurrent(partition);
    await this.ledger.beginRebuild(input);
    this.ledger.assertCanonicalCurrent(partition);
  }

  async writeRebuildBatch(input: Parameters<MemoryProjectionLedger["writeRebuildBatch"]>[0]): Promise<void> {
    this.ledger.assertCurrentPartition(input.partition);
    await this.ledger.writeRebuildBatch(input);
    this.ledger.assertCurrentPartition(input.partition);
  }

  async sealRebuild(input: Parameters<MemoryProjectionLedger["sealRebuild"]>[0]): Promise<void> {
    this.ledger.assertCurrentPartition(input.partition);
    await this.ledger.sealRebuild(input);
    this.ledger.assertCurrentPartition(input.partition);
  }

  async activateGeneration(input: Parameters<MemoryProjectionLedger["activateGeneration"]>[0]): Promise<void> {
    this.ledger.assertCurrentPartition(input.partition);
    await this.ledger.activateGeneration(input);
    this.ledger.assertCurrentPartition(input.partition);
  }
}
