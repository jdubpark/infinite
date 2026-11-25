import type { WorkspaceKnowledge } from "./understanding-knowledge.js";
import type { Diagram } from "./understanding-work.js";

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
  id: string;
  sourceId: string;
  kind: UnderstandingWorkKind;
  title: string;
  objective: string | null;
  reportedSummary: string | null;
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
  excerpt?: boolean;
}
export interface UnderstandingRepository {
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
  observedAt: string;
  work: UnderstandingWork[];
  repositories: UnderstandingRepository[];
  coverage: string[];
  knowledge?: WorkspaceKnowledge;
}

export interface GeneratedPlan { id: string; workId: string; kind: UnderstandingWorkKind; title: string; objective: string; repositoryIds: string[]; status: string; column: UnderstandingWork["column"]; outcome: string | null; links: UnderstandingLink[]; updatedAt: string; basis: "work" }
export interface GeneratedProject { id: string; name: string; repositoryIds: string[]; planIds: string[]; basis: "repository" }
export interface GeneratedCatalogPage { projects: GeneratedProject[]; plans: GeneratedPlan[]; next: string | null; coverage: string[] }
