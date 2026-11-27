import type { UnderstandingCitation, UnderstandingWorkKind } from "./understanding.js";
import type { KnowledgeRelationship } from "./understanding-knowledge.js";

export interface WorkBrief {
  schemaVersion: 1;
  workspaceId: string;
  workId: string;
  kind: UnderstandingWorkKind;
  title: string;
  source: { revision: number; status: string; updatedAt: string; baseCommit: string | null; headCommit: string | null };
  generatedAt: string;
  narrative: WorkNarrativeStatus;
  sections: WorkSection[];
  coverage: string[];
}

export type WorkNarrativeStatus =
  | { state: "ready"; generatedAt: string; engine: string; model: string }
  | { state: "pending"; requestedAt: string }
  | { state: "stale"; generatedAt: string; reason: string }
  | { state: "failed"; at: string; reason: string }
  | { state: "unavailable"; reason: string };

export type WorkSectionKind =
  | "overview" | "changes" | "diagram" | "narrative" | "tasks" | "checks"
  | "decisions" | "review" | "delivery" | "request" | "report" | "evidence";

export interface WorkSection { id: string; kind: WorkSectionKind; title: string; blocks: WorkBlock[] }

export type Basis = "source" | "agent" | "owner" | "model" | "host";

export type WorkBlock =
  | { kind: "facts"; items: { label: string; value: string; basis: Basis }[] }
  | { kind: "rich"; basis: Basis; nodes: RichNode[] }
  | { kind: "components"; items: ComponentChange[] }
  | { kind: "diagram"; diagram: Diagram }
  | { kind: "tasks"; items: TaskSummary[] }
  | { kind: "checks"; items: CheckSummary[] }
  | { kind: "decisions"; items: DecisionSummary[] }
  | { kind: "questions"; items: { priority: "high" | "medium"; area: string; why: string; question: string; citations: UnderstandingCitation[] }[] }
  | { kind: "links"; items: { label: string; url: string; basis: Basis }[] }
  | { kind: "citations"; items: UnderstandingCitation[] }
  | { kind: "note"; tone: "info" | "warning"; text: string };

export type RichNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; start?: number; items: { inlines: Inline[]; children: RichNode[] }[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "quote"; children: RichNode[] }
  | { type: "rule" };

export type Inline =
  | { type: "text"; text: string; bold?: true; italic?: true }
  | { type: "code"; text: string }
  | { type: "link"; text: string; url: string };

export type ChangeKind = "added" | "modified" | "removed";
export type FileChangeKind = ChangeKind | "renamed";

export interface ComponentChange {
  componentId: string | null;
  name: string;
  path: string;
  repositoryId: string;
  change: ChangeKind;
  files: { path: string; change: FileChangeKind; added: number | null; removed: number | null }[];
  filesTotal: number;
  taskIds: string[];
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  revision: number;
  role: string | null;
  summary: RichNode[];
  diffStat: { added: number; removed: number; files: number } | null;
  reviewRounds: number;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number } | null;
  componentNames: string[];
  workId?: string;
}

export interface CheckSummary {
  command: string;
  phase: "setup" | "verify";
  status: "running" | "passed" | "failed" | "interrupted";
  exitCode: number | null;
  headCommit: string | null;
  startedAt: string;
  finishedAt: string | null;
  outputTail: string;
}

export interface DecisionSummary {
  id: string;
  question: string;
  options: string[];
  answer: string | null;
  answeredBy: "owner" | "coordinator" | "connector" | null;
  source?: { kind: "connector"; id: string; name: string };
  answeredAt: string | null;
  createdAt: string;
}

export type DiagramNodeShape = "box" | "round" | "diamond" | "cylinder" | "pill";
export type DiagramEdgeStyle = "solid" | "dashed" | "thick";

export interface Diagram {
  id: string;
  title: string;
  kind: "change-map" | "system" | "change" | "sequence";
  basis: Basis;
  direction: "LR" | "TD";
  nodes: { id: string; label: string; shape: DiagramNodeShape; change?: ChangeKind; componentId?: string; group?: string }[];
  edges: { from: string; to: string; label?: string; style: DiagramEdgeStyle; kind?: KnowledgeRelationship["kind"] }[];
  groups: { id: string; label: string }[];
  sequence?: { participants: { id: string; label: string }[]; messages: { from: string; to: string; text: string; style: "solid" | "dashed" }[] };
  sourceText?: string;
  parseError?: string;
  citations: UnderstandingCitation[];
  coverage: string[];
}
