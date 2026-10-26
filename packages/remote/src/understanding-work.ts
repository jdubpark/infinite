import type { UnderstandingCitation, UnderstandingWorkKind } from "./understanding.js";
import type { KnowledgeRelationship } from "./understanding-knowledge.js";

/**
 * A work brief is a generated explanation of one work item. It describes a
 * recorded range, agent reports, or a model's reading of a snapshot; it never
 * certifies completion, delivery, or deployment.
 */
export interface WorkBrief {
  schemaVersion: 1;
  workspaceId: string;
  /** "team:<id>" | "mission:<id>" | "goal:<id>", the same key as UnderstandingWork.id. */
  workId: string;
  kind: UnderstandingWorkKind;
  title: string;
  /** Identity of what this brief describes; a client compares it to the work row. */
  source: { revision: number; status: string; updatedAt: string; baseCommit: string | null; headCommit: string | null };
  /** When the deterministic brief was assembled (read time). */
  generatedAt: string;
  /** The model part, kept separate from the deterministic part. */
  narrative: WorkNarrativeStatus;
  sections: WorkSection[];
  coverage: string[];
}

export type WorkNarrativeStatus =
  | { state: "ready"; generatedAt: string; engine: string; model: string }
  | { state: "pending"; requestedAt: string }
  /** A cached narrative for an older head; shown as such, never as current. */
  | { state: "stale"; generatedAt: string; reason: string }
  | { state: "failed"; at: string; reason: string }
  /** No writer, no budget, wrong role, or a kind of work that has no narrative. */
  | { state: "unavailable"; reason: string };

export type WorkSectionKind =
  | "overview" | "changes" | "diagram" | "narrative" | "tasks" | "checks"
  | "decisions" | "review" | "delivery" | "request" | "report" | "evidence";

export interface WorkSection { id: string; kind: WorkSectionKind; title: string; blocks: WorkBlock[] }

/**
 * Who says so. `source` is an observation of the recorded range or checkout;
 * `agent` is a report an agent filed; `owner` is text the owner wrote;
 * `model` is writer output with citations; `host` is the host's own record
 * (statuses, times, budgets).
 */
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

/** Rich text as data: produced by the shared Markdown parser, rendered natively by clients. */
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
  /** https only; other schemes become text. */
  | { type: "link"; text: string; url: string };

export type ChangeKind = "added" | "modified" | "removed";
export type FileChangeKind = ChangeKind | "renamed";

export interface ComponentChange {
  /** Null when no component map covered the path; the unit is then a folder. */
  componentId: string | null;
  name: string;
  /** Repository-relative. */
  path: string;
  repositoryId: string;
  change: ChangeKind;
  files: { path: string; change: FileChangeKind; added: number | null; removed: number | null }[];
  /** `files` may be truncated; this is the real count. */
  filesTotal: number;
  /** Tasks whose recorded paths fall in this component. */
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
  /** Set on mission subtasks: the subteam's own "team:<id>" brief. */
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
  /** The last part of the recorded output, bounded. */
  outputTail: string;
}

export interface DecisionSummary {
  id: string;
  question: string;
  options: string[];
  answer: string | null;
  answeredBy: "owner" | "coordinator" | null;
  answeredAt: string | null;
  createdAt: string;
}

export type DiagramNodeShape = "box" | "round" | "diamond" | "cylinder" | "pill";
export type DiagramEdgeStyle = "solid" | "dashed" | "thick";

/** A diagram as data: nodes and edges, never executable markup. */
export interface Diagram {
  id: string;
  title: string;
  kind: "change-map" | "system" | "change" | "sequence";
  /** "source" for the change map built from recorded changes, "model" for a parsed writer diagram. */
  basis: Basis;
  direction: "LR" | "TD";
  nodes: { id: string; label: string; shape: DiagramNodeShape; change?: ChangeKind; componentId?: string; group?: string }[];
  edges: { from: string; to: string; label?: string; style: DiagramEdgeStyle; kind?: KnowledgeRelationship["kind"] }[];
  groups: { id: string; label: string }[];
  /** Sequence diagrams: participants in order and numbered messages. */
  sequence?: { participants: { id: string; label: string }[]; messages: { from: string; to: string; text: string; style: "solid" | "dashed" }[] };
  /** The Mermaid text a model diagram came from, kept so a client can show it when parsing failed. */
  sourceText?: string;
  parseError?: string;
  citations: UnderstandingCitation[];
  coverage: string[];
}
