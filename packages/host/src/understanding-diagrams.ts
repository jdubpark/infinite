import { z } from "zod";
import type { DiagramEdge, DiagramGraph, DiagramGroup, DiagramNode, KnowledgeComponent, KnowledgeRelationship } from "@infinite/remote";

export type ParsedFlowchart = {
  direction: "LR" | "TB";
  nodes: { id: string; label: string; group: string | null }[];
  groups: { id: string; label: string }[];
  edges: { from: string; to: string; label: string | null }[];
};

const MAX_NODES = 200;
const MAX_GROUPS = 50;
const MAX_EDGES = 400;
const MAX_LABEL = 200;
const MAX_SOURCE = 3000;
const MAX_ERROR_LINE = 120;
const ID = /^[A-Za-z0-9_.-]+$/;
const NODE_ID = /^[A-Za-z0-9_.-]+/;
const SHAPES: [string, string][] = [["((", "))"], ["[[", "]]"], ["[", "]"], ["(", ")"], ["{", "}"], [">", "]"]];
const LABELED_ARROW = /^(?:--\s+(.+?)\s+-->|-\.\s+(.+?)\s+\.->)/;
const PLAIN_ARROW = /^(?:-->|---|-\.->|==>)/;
const PIPE_LABEL = /^\|([^|]*)\|/;
const HEADER = /^(?:flowchart|graph)\s+(LR|RL|TB|TD)$/;
const IGNORED = /^(?:classDef|class|style|linkStyle|click)(?:\s|$)/;
/** Diagram types outside the subset; a bare keyword line is rejected rather than read as a node. */
const DIAGRAM_KEYWORDS = new Set(["flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "gitGraph", "mindmap", "timeline", "quadrantChart", "requirementDiagram"]);
const ENTITIES: Record<string, string> = { "&quot;": "\"", "#quot;": "\"", "&amp;": "&", "&lt;": "<", "&gt;": ">" };

type Statement = { refs: { id: string; label: string | null }[]; arrows: (string | null)[] };

function decodeLabel(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) text = text.slice(1, -1).trim();
  return text.replace(/&quot;|#quot;|&amp;|&lt;|&gt;/g, entity => ENTITIES[entity] ?? entity);
}

/** Reads one flowchart statement such as `A[Label] -->|edge| B --> C`. Returns null when outside the subset. */
function parseStatement(line: string): Statement | null {
  let pos = 0;
  const refs: Statement["refs"] = [];
  const arrows: Statement["arrows"] = [];
  const skip = () => { while (pos < line.length && /\s/.test(line.charAt(pos))) pos += 1; };
  const ref = (): boolean => {
    const match = NODE_ID.exec(line.slice(pos));
    const id = match?.[0].replace(/[-.]+$/, "") ?? "";
    if (!id) return false;
    pos += id.length;
    let label: string | null = null;
    for (const [open, close] of SHAPES) {
      if (!line.startsWith(open, pos)) continue;
      const start = pos + open.length;
      let closeAt: number;
      let raw: string;
      if (line.charAt(start) === "\"") {
        const endQuote = line.indexOf("\"", start + 1);
        if (endQuote < 0) return false;
        closeAt = endQuote + 1;
        raw = line.slice(start, closeAt);
      } else {
        closeAt = line.indexOf(close, start);
        if (closeAt < 0) return false;
        raw = line.slice(start, closeAt);
      }
      if (!line.startsWith(close, closeAt)) return false;
      label = decodeLabel(raw);
      if (!label || label.length > MAX_LABEL) return false;
      pos = closeAt + close.length;
      break;
    }
    refs.push({ id, label });
    return true;
  };

  if (!ref()) return null;
  skip();
  if (pos === line.length && refs.length === 1 && DIAGRAM_KEYWORDS.has(refs[0].id) && refs[0].label === null) return null;
  while (pos < line.length) {
    const rest = line.slice(pos);
    const labeled = LABELED_ARROW.exec(rest);
    const arrow = labeled ?? PLAIN_ARROW.exec(rest);
    if (!arrow) return null;
    pos += arrow[0].length;
    const inline = labeled ? (labeled[1] ?? labeled[2]) : undefined;
    skip();
    const pipe = PIPE_LABEL.exec(line.slice(pos));
    if (pipe) {
      if (inline !== undefined) return null;
      pos += pipe[0].length;
      skip();
    }
    const text = pipe?.[1] ?? inline ?? "";
    const label = decodeLabel(text);
    if (label.length > MAX_LABEL) return null;
    arrows.push(label || null);
    if (!ref()) return null;
    skip();
  }
  return { refs, arrows };
}

function unsupported(index: number, line: string): { ok: false; error: string } {
  return { ok: false, error: `line ${index + 1}: ${line.slice(0, MAX_ERROR_LINE)}` };
}

function parseSubgraph(rest: string): DiagramGroup | null {
  const text = rest.trim();
  const bracket = /^([A-Za-z0-9_.-]+)\s*\[(.*)\]$/.exec(text);
  if (bracket?.[1] && bracket[2] !== undefined) {
    const label = decodeLabel(bracket[2]);
    return ID.test(bracket[1]) && label && label.length <= MAX_LABEL ? { id: bracket[1], label } : null;
  }
  if (text.startsWith("\"")) {
    const label = decodeLabel(text);
    const id = label.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
    return id && label.length <= MAX_LABEL ? { id, label } : null;
  }
  return ID.test(text) ? { id: text, label: text } : null;
}

/** Parses the flowchart subset the briefing engine emits. Any other line is an error, never a guess. */
export function parseMermaidFlowchart(text: string): { ok: true; graph: ParsedFlowchart } | { ok: false; error: string } {
  if (text.length > MAX_SOURCE) return { ok: false, error: `diagram source exceeds ${MAX_SOURCE} characters` };
  const lines = text.split(/\r?\n/);
  const nodes = new Map<string, { id: string; label: string; group: string | null; explicit: boolean }>();
  const groups: DiagramGroup[] = [];
  const edges: ParsedFlowchart["edges"] = [];
  let direction: "LR" | "TB" | null = null;
  let current: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line || line.startsWith("%%")) continue;
    if (direction === null) {
      const header = HEADER.exec(line);
      if (!header?.[1]) return unsupported(index, line);
      direction = header[1] === "LR" || header[1] === "RL" ? "LR" : "TB";
      continue;
    }
    if (IGNORED.test(line)) continue;
    const sub = /^subgraph(?:\s+(.*))?$/.exec(line);
    if (sub) {
      const group: DiagramGroup | null = current === null ? parseSubgraph(sub[1] ?? "") : null;
      if (!group || groups.some(g => g.id === group.id)) return unsupported(index, line);
      if (groups.length >= MAX_GROUPS) return { ok: false, error: `more than ${MAX_GROUPS} groups` };
      groups.push(group);
      current = group.id;
      continue;
    }
    if (line === "end") {
      if (current === null) return unsupported(index, line);
      current = null;
      continue;
    }
    const statement = parseStatement(line);
    if (!statement) return unsupported(index, line);
    for (const ref of statement.refs) {
      const existing = nodes.get(ref.id);
      if (!existing) {
        if (nodes.size >= MAX_NODES) return { ok: false, error: `more than ${MAX_NODES} nodes` };
        nodes.set(ref.id, { id: ref.id, label: ref.label ?? ref.id, group: current, explicit: ref.label !== null });
      } else if (ref.label !== null && !existing.explicit) {
        existing.label = ref.label;
        existing.explicit = true;
      }
    }
    for (const [i, label] of statement.arrows.entries()) {
      if (edges.length >= MAX_EDGES) return { ok: false, error: `more than ${MAX_EDGES} edges` };
      const from = statement.refs[i]?.id;
      const to = statement.refs[i + 1]?.id;
      if (from && to) edges.push({ from, to, label });
    }
  }
  if (direction === null) return { ok: false, error: "missing flowchart header" };
  if (current !== null) return { ok: false, error: "subgraph is not closed with end" };
  return {
    ok: true,
    graph: {
      direction,
      nodes: [...nodes.values()].map(({ id, label, group }) => ({ id, label, group })),
      groups,
      edges,
    },
  };
}

export function diagramFromMermaid(input: {
  id: string; title: string; kind: "system" | "change"; mermaid: string; repositoryId: string; head: string | null; observedAt: string;
}): DiagramGraph {
  const base = {
    id: input.id, title: input.title, kind: input.kind, source: "mermaid" as const,
    sourceText: input.mermaid.slice(0, MAX_SOURCE), repositoryId: input.repositoryId, head: input.head, observedAt: input.observedAt,
  };
  const parsed = parseMermaidFlowchart(input.mermaid);
  if (!parsed.ok) return { ...base, direction: "LR", nodes: [], groups: [], edges: [], parseError: parsed.error };
  const nodes: DiagramNode[] = parsed.graph.nodes.map(node => ({ ...node, componentId: null }));
  return { ...base, direction: parsed.graph.direction, nodes, groups: parsed.graph.groups, edges: parsed.graph.edges, parseError: null };
}

/** Top-level directory of a component's first path; files at the root group under "root". */
function groupOf(path: string | undefined): string {
  if (!path) return "root";
  const slash = path.indexOf("/");
  return slash > 0 ? path.slice(0, slash) : "root";
}

export function componentGraph(input: {
  repositoryId: string; head: string | null; observedAt: string;
  components: Pick<KnowledgeComponent, "id" | "name" | "paths" | "retired">[];
  relationships: Pick<KnowledgeRelationship, "from" | "to" | "kind">[];
}): DiagramGraph {
  const nodes: DiagramNode[] = input.components.filter(c => !c.retired).map(c => ({
    id: c.id, label: c.name.slice(0, MAX_LABEL), group: groupOf(c.paths[0]?.path), componentId: c.id,
  }));
  const ids = new Set(nodes.map(node => node.id));
  const groups: DiagramGroup[] = [];
  for (const node of nodes) {
    const group = node.group ?? "root";
    if (!groups.some(g => g.id === group)) groups.push({ id: group, label: group });
  }
  const seen = new Set<string>();
  const edges: DiagramEdge[] = [];
  for (const relationship of input.relationships) {
    if (!ids.has(relationship.from) || !ids.has(relationship.to)) continue;
    const key = JSON.stringify([relationship.from, relationship.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: relationship.from, to: relationship.to, label: relationship.kind === "imports" ? null : relationship.kind });
  }
  return {
    id: `components:${input.repositoryId}`, title: "Component map", kind: "components", direction: "LR",
    nodes, groups, edges, source: "components", sourceText: null, parseError: null,
    repositoryId: input.repositoryId, head: input.head, observedAt: input.observedAt,
  };
}

/** Links a node to a component by id, else by a unique case-insensitive name match. */
export function linkDiagramNodes(graph: DiagramGraph, components: Pick<KnowledgeComponent, "id" | "name">[]): DiagramGraph {
  const ids = new Set(components.map(component => component.id));
  const byName = new Map<string, string[]>();
  for (const component of components) {
    const key = component.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), component.id]);
  }
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      if (ids.has(node.id)) return { ...node, componentId: node.id };
      const matches = byName.get(node.label.toLowerCase()) ?? [];
      const only = matches.length === 1 ? matches[0] : undefined;
      return { ...node, componentId: only ?? null };
    }),
  };
}

const text = (max: number) => z.string().min(1).max(max);
const nodeSchema = z.object({ id: text(200), label: text(MAX_LABEL), group: text(200).nullable(), componentId: text(200).nullable() }).strict();
const groupSchema = z.object({ id: text(200), label: text(MAX_LABEL) }).strict();
const edgeSchema = z.object({ from: text(200), to: text(200), label: text(MAX_LABEL).nullable() }).strict();

export const diagramGraphSchema: z.ZodType<DiagramGraph> = z.object({
  id: text(200), title: text(120), kind: z.enum(["system", "change", "components"]), direction: z.enum(["LR", "TB"]),
  nodes: z.array(nodeSchema).max(MAX_NODES), groups: z.array(groupSchema).max(MAX_GROUPS), edges: z.array(edgeSchema).max(MAX_EDGES),
  source: z.enum(["mermaid", "components"]), sourceText: z.string().max(MAX_SOURCE).nullable(),
  parseError: z.string().max(300).nullable(), repositoryId: text(200), head: z.string().max(80).nullable(),
  observedAt: z.string().max(64),
}).strict();
