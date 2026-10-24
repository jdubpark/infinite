import type {
  MemoryCollection,
  MemoryMutation,
  MemoryMutationResult,
  MemoryMutationStatusResult,
  MemoryPage,
  MemoryRecord,
  MemoryRecordPayload,
  MemoryRecordResult,
  MemoryRepositoryBinding,
  MemoryWorkspace,
  MemoryWorkspaceResult,
} from "@infinite/remote";
import type { MemoryRecoveryWitness } from "./recovery.js";

/** Selector only. The host resolves it again on every protected operation. */
export type MemoryPrincipalSelector =
  | { kind: "device"; deviceId: string }
  | { kind: "task"; taskBindingId: string };

/** Fresh, host-authenticated state returned by the host integration callbacks. */
export interface MemoryPrincipalSnapshot {
  principalId: string;
  kind: "device" | "task";
  deviceId?: string;
  deviceRole?: "owner" | "controller" | "viewer";
  taskBindingId?: string;
  workspaceId?: string;
  collectionIds?: string[];
  bindingEpoch?: number;
  grantEpoch?: number;
  allowedActions?: string[];
  allowedRecallModes?: Array<"exact" | "lexical" | "hybrid">;
  expiresAt?: string;
  state: "active" | "revoked";
}

/** Current identity comes from ProjectGroupService, never from a caller selector. */
export interface MemoryCurrentWorkspaceBinding {
  workspaceId: string;
  bindingEpoch: number;
  bindingDigest: string;
  repositoryBindings: MemoryRepositoryBinding[];
  state: "active" | "review-required" | "retired";
}

export interface MemoryProvisionIntent {
  /** Stable ID of the already-authorized, explicit workspace-enable intent. */
  intentEventId: string;
  actor: MemoryPrincipalSelector & { kind: "device" };
  workspaceId: string;
  expectedBindingEpoch: number;
  bindingDigest: string;
}

export interface MemoryPageOptions {
  limit?: number;
  cursor?: string;
  collectionId?: string;
  state?: string;
}

export interface MemoryLexicalQuery {
  mode: "exact" | "lexical";
  collectionIds?: string[];
  query: string;
  limit: number;
}

export interface MemoryAuthorizationSnapshot {
  principal: MemoryPrincipalSnapshot;
  workspace: MemoryWorkspace;
  currentBinding: MemoryCurrentWorkspaceBinding;
  collectionIds: string[];
  servingEpoch: number;
  grantEpoch: number;
}

const memoryReadFenceBrand: unique symbol = Symbol("memory-read-fence");

/** An opaque host-only proof that a particular protected read was current. */
export interface MemoryReadFence {
  readonly [memoryReadFenceBrand]: true;
}

export interface AuthorizedRead<T> {
  value: T;
  fence: MemoryReadFence;
}

/** Only the store implementation should issue or inspect these opaque fences. */
export function createMemoryReadFence(token: string): MemoryReadFence {
  const fence = {} as MemoryReadFence & { [memoryReadFenceBrand]: true; token: string };
  Object.defineProperty(fence, memoryReadFenceBrand, { value: true });
  Object.defineProperty(fence, "token", { value: token });
  return Object.freeze(fence);
}

export function memoryReadFenceToken(fence: MemoryReadFence): string {
  return (fence as MemoryReadFence & { token: string }).token;
}

export interface MemoryStoreOptions {
  databasePath: string;
  vaultKey: Buffer;
  hostId: string;
  resolvePrincipal(selector: MemoryPrincipalSelector): MemoryPrincipalSnapshot | undefined;
  resolveWorkspaceBinding(workspaceId: string): MemoryCurrentWorkspaceBinding | undefined;
  recoveryWitness?: MemoryRecoveryWitness;
  recoveryPublicKey?: Buffer | string;
  isProcessingPolicyConfigured?(policy: import("@infinite/remote").MemoryProcessingPolicy): boolean;
  now?: () => number;
}

export interface MemoryStore {
  /** Initialize the SQLite schema and attempt fresh witness reconciliation. */
  openRecovery(): Promise<void>;
  readonly recoveryReady: boolean;
  provisionWorkspaceMemory(intent: MemoryProvisionIntent): AuthorizedRead<MemoryWorkspace>;
  mutate(input: {
    actor: MemoryPrincipalSelector;
    workspaceId: string;
    request: MemoryMutation;
  }): Promise<AuthorizedRead<MemoryMutationResult | MemoryMutationStatusResult>>;
  getWorkspace(actor: MemoryPrincipalSelector, workspaceId: string): AuthorizedRead<MemoryWorkspaceResult>;
  listCollections(actor: MemoryPrincipalSelector, workspaceId: string, options?: MemoryPageOptions): AuthorizedRead<MemoryPage<MemoryCollection>>;
  listRecords(actor: MemoryPrincipalSelector, workspaceId: string, options?: MemoryPageOptions): AuthorizedRead<MemoryPage<MemoryRecord>>;
  getRecord(actor: MemoryPrincipalSelector, recordId: string): AuthorizedRead<MemoryRecordResult>;
  listGrants(actor: MemoryPrincipalSelector, workspaceId: string, options?: MemoryPageOptions): AuthorizedRead<MemoryPage<import("@infinite/remote").MemoryGrant>>;
  listSources(actor: MemoryPrincipalSelector, workspaceId: string, options?: MemoryPageOptions): AuthorizedRead<MemoryPage<import("@infinite/remote").MemorySourceEnrollment>>;
  lexicalCandidates(actor: MemoryPrincipalSelector, workspaceId: string, query: MemoryLexicalQuery): AuthorizedRead<MemoryRecord[]>;
  currentAuthorizationSnapshot(actor: MemoryPrincipalSelector, workspaceId: string): AuthorizedRead<MemoryAuthorizationSnapshot>;
  getMutationStatus(actor: MemoryPrincipalSelector, workspaceId: string, requestId: string): AuthorizedRead<MemoryMutationStatusResult>;
  /** Host transport calls this immediately before sending any protected response bytes. */
  revalidateResponse(actor: MemoryPrincipalSelector, fence: MemoryReadFence): void;
  close(): void;
}

export type { MemoryCollection, MemoryMutation, MemoryRecord, MemoryRecordPayload, MemoryWorkspace };

export type MemoryFoundationOperation =
  | Extract<MemoryMutation["op"], { type: "collection_create" }>
  | Extract<MemoryMutation["op"], { type: "record_create" | "record_propose" }>
  | Extract<MemoryMutation["op"], { type: "grant_set" | "grant_revoke" }>
  | Extract<MemoryMutation["op"], { type: "source_enroll" | "source_pause" | "source_revoke" }>
  | Extract<MemoryMutation["op"], { type: "record_archive" | "record_erase" | "workspace_review_binding" }>;
