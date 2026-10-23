import { createHash } from "node:crypto";
import type { MemoryRecord } from "@infinite/remote";
import type {
  MemoryAdapter,
  MemoryAdapterCandidate,
  MemoryAdapterHealth,
  MemoryAdapterPartition,
  MemoryAdapterSearchInput,
  MemoryCandidateHandle,
  MemoryIndexInput,
  MemoryIndexReceipt,
  MemoryProjectionLedger,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface HonchoAdapterConfig {
  baseUrl: string;
  /** Host-minted workspace-only JWT; adapter verifies its declared scope before use. */
  workspaceToken(workspaceName: string): string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function workspaceName(partition: MemoryAdapterPartition): string {
  const digest = createHash("sha256").update(JSON.stringify([
    partition.workspaceId, partition.collectionId, partition.generationId,
  ])).digest("base64url");
  return `inf_${digest.slice(0, 40)}`;
}

function tokenWorkspace(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (claims.ad || claims.p || claims.s || claims.sc) return null;
    return typeof claims.w === "string" ? claims.w : null;
  } catch {
    return null;
  }
}

export class HonchoMemoryAdapter implements MemoryAdapter {
  private readonly root: URL;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: HonchoAdapterConfig, private readonly ledger: MemoryProjectionLedger) {
    this.root = new URL(config.baseUrl);
    if (this.root.protocol !== "http:" && this.root.protocol !== "https:") throw new TypeError("Honcho URL must use HTTP or HTTPS");
    if (this.root.username || this.root.password) throw new TypeError("Honcho URL must not embed credentials");
    this.root.pathname = `${this.root.pathname.replace(/\/$/, "")}/`;
    this.request = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new RangeError("invalid Honcho request timeout");
  }

  async health(): Promise<MemoryAdapterHealth> {
    try {
      const response = await this.fetchJson("health");
      return {
        state: response.ok ? "degraded" : "unavailable", provider: "honcho",
        activeGenerationId: null, lexicalLagMs: null, semanticLagMs: null,
        quarantined: false, modelEndpointId: null, embeddingEndpointId: null,
        reason: response.ok
          ? "Honcho API health endpoint is reachable; image version is unverified and inference is disabled pending a metered egress proxy"
          : "Honcho health endpoint returned an error",
      };
    } catch {
      return {
        state: "unavailable", provider: "honcho", activeGenerationId: null,
        lexicalLagMs: null, semanticLagMs: null, quarantined: true,
        modelEndpointId: null, embeddingEndpointId: null, reason: "Honcho API is unreachable",
      };
    }
  }

  /**
   * Honcho message writes schedule background embedding/reasoning retries. The
   * adapter keeps that path disabled until a host-owned egress proxy can meter
   * every nested attempt. Lexical indexing remains Infinite-owned.
   */
  async indexSourceEvent(input: MemoryIndexInput): Promise<MemoryIndexReceipt> {
    this.ledger.assertCurrentPartition(input.event.partition);
    throw new Error(input.processingAllowed || input.semanticDestination
      ? "Honcho ingestion is disabled until every background inference attempt is metered by a controlled egress proxy"
      : "Honcho ingestion is disabled; deterministic indexing remains Infinite-owned");
  }

  async searchLexical(_input: MemoryAdapterSearchInput): Promise<MemoryAdapterCandidate[]> {
    throw new Error("Honcho is not the lexical source; use Infinite's canonical lexical index");
  }

  /** Honcho search generates an embedding inside the service; disabled without per-attempt metering. */
  async searchSemantic(_input: MemoryAdapterSearchInput & {
    destination: { providerId: string; endpointId: string; modelId: string };
    reservationId: string;
  }): Promise<MemoryAdapterCandidate[]> {
    throw new Error("Honcho semantic search is disabled until its internal embedding call and retries pass through a metering egress proxy");
  }

  async hydrateCandidate(candidate: MemoryCandidateHandle): Promise<MemoryRecord> {
    this.ledger.assertCanonicalCurrent(candidate.partition);
    throw new Error("Honcho candidate hydration is disabled; hydrate from Infinite's canonical store");
  }

  /** A 202 means deletion was queued. The generation remains quarantined. */
  async revokeAndQuarantine(partition: MemoryAdapterPartition, reason: string): Promise<void> {
    this.ledger.assertCanonicalCurrent(partition);
    await this.ledger.quarantine(partition, reason);
    this.ledger.assertCanonicalCurrent(partition);
    const name = workspaceName(partition);
    const token = this.scopedToken(name);
    const response = await this.fetchJson(`v3/workspaces/${encodeURIComponent(name)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404 && response.status !== 202) throw new Error(`Honcho deletion request failed with status ${response.status}`);
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

  /** Qualification helper: create one isolated provider workspace for this collection generation. */
  async ensureWorkspace(partition: MemoryAdapterPartition): Promise<void> {
    this.ledger.assertCurrentPartition(partition);
    const name = workspaceName(partition);
    const token = this.scopedToken(name);
    const response = await this.fetchJson("v3/workspaces", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: name }),
    });
    this.ledger.assertCurrentPartition(partition);
    if (!response.ok && response.status !== 200 && response.status !== 201) throw new Error(`Honcho workspace request failed with status ${response.status}`);
  }

  private scopedToken(workspace: string): string {
    const token = this.config.workspaceToken(workspace);
    if (!token || tokenWorkspace(token) !== workspace) throw new Error("a workspace-only Honcho token scoped to the exact collection generation is required");
    return token;
  }

  private async fetchJson(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: unknown }> {
    const url = new URL(path.replace(/^\/+/, ""), this.root);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(url, { ...init, redirect: "error", signal: controller.signal });
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Honcho response exceeded the adapter limit");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error("Honcho response exceeded the adapter limit");
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes);
      let json: unknown = null;
      if (text) {
        try { json = JSON.parse(text); } catch { throw new Error("Honcho returned a non-JSON response"); }
      }
      return { ok: response.ok, status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  }
}
