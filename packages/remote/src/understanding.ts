import type { WorkspaceKnowledge } from "./understanding-knowledge.js";
import type { Diagram } from "./understanding-work.js";

/** Read-only workspace knowledge. A generated brief does not certify completion or deployment. */
export interface UnderstandingCitation { source: string; line: number }
export interface UnderstandingClaim { text: string; citations: UnderstandingCitation[] }
export interface UnderstandingBrief {
  summary: string;
  architecture: UnderstandingClaim[];
  changes: UnderstandingClaim[];
  checks: UnderstandingClaim[];
  review: { priority: "high" | "medium"; area: string; why: string; question: string; citations: UnderstandingCitation[] }[];
  guidance: { text: string; basis: "documented" | "proposed"; citations: UnderstandingCitation[] }[];
  unknowns: string[];
  /** Parsed from the writer's Mermaid diagrams at persist time; absent on older artifacts. */
  diagrams?: Diagram[];
}
export interface UnderstandingArtifact {
  id: string;
  sourceProjectId: string;
  sessionId: string;
  sourceKind: "project" | "team";
  head: string | null;
  base: string | null;
  fingerprint: string;
  generatedAt: string;
  retainedAt: string;
  coverage: string[];
  brief: UnderstandingBrief;
  evidence: { source: string; line: number; text: string }[];
}
export type UnderstandingWorkKind = "mission" | "team" | "goal";
export interface UnderstandingLink { kind: "pr" | "issue"; label: string; url: string }
export interface UnderstandingWork {
  /** Stable key including kind; sourceId links to the original record. */
  id: string;
  sourceId: string;
  kind: UnderstandingWorkKind;
  title: string;
  objective: string | null;
  reportedSummary: string | null;
  /** The source's execution status, never inferred from the brief. */
  status: string;
  column: "needs-input" | "working" | "review" | "ended";
  updatedAt: string;
  scope: "complete" | "partial";
  repositoryIds: string[];
  briefIds: string[];
  links: UnderstandingLink[];
}
export interface UnderstandingPlan {
  workId: string;
  kind: UnderstandingWorkKind;
  title: string;
  text: string;
  status: string;
  updatedAt: string;
  source: "request";
}
export interface UnderstandingRepository {
  /** Primary enrolled project ID, matching the workspace's folded repository. */
  id: string;
  name: string;
  checkoutIds: string[];
  state: "ready" | "updating" | "failed" | "empty" | "unavailable";
  current: UnderstandingArtifact[];
  planned: UnderstandingPlan[];
  warnings: string[];
  coverage: string[];
}
export interface WorkspaceUnderstanding {
  schemaVersion: 1;
  workspace: { id: string; name: string; revision: number };
  /** Read time; does not imply that sources or environments were checked then. */
  observedAt: string;
  work: UnderstandingWork[];
  repositories: UnderstandingRepository[];
  coverage: string[];
  /** Optional for compatibility with hosts and clients predating workspace maintenance. */
  knowledge?: WorkspaceKnowledge;
}
