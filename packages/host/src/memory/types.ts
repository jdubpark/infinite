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

export type MemoryPrincipalSelector =
  | { kind: "device"; deviceId: string }
  | { kind: "task"; taskBindingId: string };

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

export interface MemoryCurrentWorkspaceBinding {
  workspaceId: string;
  bindingEpoch: number;
  bindingDigest: string;
  repositoryBindings: MemoryRepositoryBinding[];
  state: "active" | "review-required" | "retired";
}

export interface MemoryProvisionIntent {
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

export interface MemoryReadFence {
  readonly [memoryReadFenceBrand]: true;
}

export interface AuthorizedRead<T> {
  value: T;
  fence: MemoryReadFence;
}

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
  revalidateResponse(actor: MemoryPrincipalSelector, fence: MemoryReadFence): void;
  close(): void;
}

export type { MemoryCollection, MemoryMutation, MemoryRecord, MemoryRecordPayload, MemoryWorkspace };

