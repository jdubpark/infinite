/** Graph data drawn in the System tab. Mermaid source is kept as text and is never evaluated. */
export interface DiagramNode { id: string; label: string; group: string | null; componentId: string | null }
export interface DiagramGroup { id: string; label: string }
export interface DiagramEdge { from: string; to: string; label: string | null }
export interface DiagramGraph {
  id: string; title: string; kind: "system" | "change" | "components"; direction: "LR" | "TB";
  nodes: DiagramNode[]; groups: DiagramGroup[]; edges: DiagramEdge[];
  source: "mermaid" | "components"; sourceText: string | null; parseError: string | null;
  repositoryId: string; head: string | null; observedAt: string;
}
