import type { UnderstandingBrief, UnderstandingWork } from "./understanding.js";

/** Source observations never confer completion or delivery authority. */
export interface KnowledgeSource {
  repositoryId: string; head: string | null; fingerprint: string; observedAt: string; kind: "checkout";
}
/** A null line cites a file-level observation, never a fabricated source line. */
export interface KnowledgeEvidence { repositoryId: string; source: string; line: number | null; text?: string }
export interface KnowledgeClaim { text: string; basis: "source" | "agent" | "owner" | "provider"; evidence: KnowledgeEvidence[] }
export interface KnowledgeHistory { revision: number; at: string; summary: string }
export interface KnowledgeProject {
  id: string; revision: number; name: string; description: string; repositoryIds: string[];
  archived: boolean; createdAt: string; updatedAt: string; history: KnowledgeHistory[];
}
export type KnowledgeFeatureStatus = "planned" | "active" | "blocked" | "completed" | "cancelled" | "failed";
export interface KnowledgeFeature {
  id: string; revision: number; projectId: string | null; title: string; description: string;
  repositoryIds: string[]; workIds: string[]; componentIds: string[];
  /** Explicit owner assessment, independent of execution and provider delivery. */
  status: KnowledgeFeatureStatus;
  sourceUrl: string | null; archived: boolean; createdAt: string; updatedAt: string; history: KnowledgeHistory[];
}
export interface KnowledgePlan {
  id: string; revision: number; componentId: string; repositoryIds: string[]; title: string; text: string;
  status: "proposed" | "accepted" | "superseded";
  sourceUrl: string | null; workId: string | null; archived: boolean;
  createdAt: string; updatedAt: string; history: KnowledgeHistory[];
}
export interface KnowledgeComponentOverride {
  id: string; revision: number; repositoryIds: string[]; name: string; description: string;
  /** Owner redirects preserve navigation after a rename or split. */
  redirectTo: string | null; pinned: boolean; updatedAt: string;
}
export interface KnowledgePolicy {
  enabled: boolean;
  /** Models run only when enabled here and a host writer is configured. */
  synthesis: boolean;
  delivery: boolean; intervalMinutes: number; dailyJobLimit: number;
}
export interface KnowledgeCatalog {
  revision: number; projects: KnowledgeProject[]; features: KnowledgeFeature[]; plans: KnowledgePlan[];
  componentOverrides: KnowledgeComponentOverride[]; policy: KnowledgePolicy; coverage: string[];
}
export interface KnowledgeDifference {
  state: "unverified" | "review-needed" | "aligned"; summary: string; claims: KnowledgeClaim[];
  /** Exact plan revisions and source generation compared by the writer. */
  planRevisions: { id: string; revision: number }[]; snapshotId: string | null; generatedAt: string | null;
}
export interface KnowledgeComponent {
  id: string; name: string; description: string; repositoryIds: string[];
  paths: { repositoryId: string; path: string }[];
  files: { repositoryId: string; path: string; hash: string; lines: number }[];
  pinned: boolean; retired: boolean; redirectTo: string | null;
  current: {
    state: "mapped" | "ready" | "stale" | "unavailable"; snapshotId: string; sources: KnowledgeSource[];
    summary: string; claims: KnowledgeClaim[]; brief: UnderstandingBrief | null; generatedAt: string | null;
  };
  planned: KnowledgePlan[]; difference: KnowledgeDifference; featureIds: string[];
  history: { snapshotId: string; at: string; summary: string }[]; coverage: string[];
}
export interface KnowledgeRelationship {
  id: string; from: string; to: string;
  kind: "imports" | "calls" | "publishes" | "consumes" | "stores" | "implements";
  basis: "source" | "agent" | "owner"; summary: string; evidence: KnowledgeEvidence[];
}
export interface KnowledgePullRequest {
  repositoryId: string; number: number; title: string; url: string; state: "open" | "closed" | "merged";
  head: string; mergeCommit: string | null; observedAt: string;
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
}
export interface KnowledgeEnvironment {
  repositoryId: string; environment: string; revision: string; status: string; url: string | null;
  observedAt: string; basis: "provider";
}
export interface KnowledgeDelivery {
  repositoryId: string; state: "ready" | "unavailable" | "failed" | "stale"; observedAt: string | null;
  pullRequests: KnowledgePullRequest[]; environments: KnowledgeEnvironment[]; coverage: string[];
}
export interface KnowledgeMaintenance {
  state: "disabled" | "idle" | "queued" | "running" | "failed" | "budget-limited" | "unavailable";
  lastObservedAt: string | null; lastPublishedAt: string | null; nextAttemptAt: string | null;
  jobsToday: number; dailyJobLimit: number; message: string | null;
  lastFailure?: { at: string; reason: string } | null;
}
export interface WorkspaceKnowledge {
  schemaVersion: 1; catalog: KnowledgeCatalog; components: KnowledgeComponent[];
  relationships: KnowledgeRelationship[]; delivery: KnowledgeDelivery[]; maintenance: KnowledgeMaintenance; coverage: string[];
}

/** Caller UUID plus catalog revision protects mutations against replay and races. */
export interface KnowledgeMutation { requestId: string; revision: number }
export type KnowledgeProjectInput = Pick<KnowledgeProject, "name" | "description" | "repositoryIds">;
export type KnowledgeFeatureInput = Pick<KnowledgeFeature, "projectId" | "title" | "description" | "repositoryIds" | "workIds" | "componentIds" | "status" | "sourceUrl">;
export type KnowledgePlanInput = Pick<KnowledgePlan, "componentId" | "repositoryIds" | "title" | "text" | "status" | "sourceUrl" | "workId">;
export type KnowledgeComponentInput = Pick<KnowledgeComponentOverride, "repositoryIds" | "name" | "description" | "redirectTo" | "pinned">;
export interface KnowledgeMutationContext {
  work: UnderstandingWork[]; components: Pick<KnowledgeComponent, "id" | "repositoryIds">[];
}
