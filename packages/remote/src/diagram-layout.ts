import type { DiagramEdge, DiagramGraph } from "./understanding-diagrams.js";

/** Deterministic layered layout shared by the phone, web and desktop. No DOM or Node APIs. */
export interface LayoutOptions { nodeWidth: number; nodeHeight: number; gapX: number; gapY: number; groupPadding: number }
export interface LayoutNode { id: string; x: number; y: number; width: number; height: number; layer: number }
export interface LayoutEdge { from: string; to: string; label: string | null; points: { x: number; y: number }[]; back: boolean }
export interface LayoutGroup { id: string; label: string; x: number; y: number; width: number; height: number }
export interface GraphLayout { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[]; groups: LayoutGroup[] }

export const defaultLayoutOptions: LayoutOptions = { nodeWidth: 150, nodeHeight: 44, gapX: 48, gapY: 28, groupPadding: 12 };
/** Room for a group box's label above its padding. */
export const groupLabelHeadroom = 16;

type Point = { x: number; y: number };

export function layoutGraph(graph: Pick<DiagramGraph, "direction" | "nodes" | "groups" | "edges">, options: Partial<LayoutOptions> = {}): GraphLayout {
  const o = { ...defaultLayoutOptions, ...options };
  const pad = o.groupPadding;
  const lr = graph.direction === "LR";
  const nodes = graph.nodes;
  const groupOf = new Map(nodes.map(node => [node.id, node.group]));
  const grouped = graph.groups.length > 0 && nodes.some(node => node.group !== null);
  // Boxes carry a label above their members, so a grouped graph starts lower and spaces rows so that boxes stay apart.
  const top = grouped ? groupLabelHeadroom : 0;
  const gapY = grouped ? Math.max(o.gapY, 2 * pad + groupLabelHeadroom + 4) : o.gapY;
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  const back = markBackEdges(nodes.map(node => node.id), edges);

  // Longest-path layering over the forward edges only.
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  edges.forEach((edge, index) => {
    if (back[index]) return;
    push(preds, edge.to, edge.from);
    push(succs, edge.from, edge.to);
  });
  const layerOf = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    const value = Math.max(-1, ...(preds.get(id) ?? []).map(depth)) + 1;
    layerOf.set(id, value);
    return value;
  };
  nodes.forEach(node => depth(node.id));
  const layerCount = Math.max(0, ...layerOf.values()) + (nodes.length ? 1 : 0);
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const node of nodes) layers[layerOf.get(node.id) ?? 0].push(node.id);

  // Barycenter sweeps (down, up, down, up) against the adjacent layer; ties go by group id, then input order.
  // After each sort the members of one group are made contiguous, so a box around a layer's members holds no other node.
  const rank = new Map(nodes.map((node, index) => [node.id, index]));
  const position = new Map<string, number>();
  const indexLayers = (): void => layers.forEach(row => row.forEach((id, index) => position.set(id, index)));
  const sweep = (layer: number, neighbors: Map<string, string[]>): void => {
    const row = layers[layer];
    const bary = new Map(row.map(id => {
      const near = neighbors.get(id) ?? [];
      const mean = near.length ? near.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / near.length : (position.get(id) ?? 0);
      return [id, mean] as const;
    }));
    row.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || (groupOf.get(a) ?? "").localeCompare(groupOf.get(b) ?? "") || (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    layers[layer] = contiguous(row, groupOf);
    layers[layer].forEach((id, index) => position.set(id, index));
  };
  layers.forEach((row, layer) => { layers[layer] = contiguous(row, groupOf); });
  const adjacentPreds = new Map([...preds].map(([id, list]) => [id, list.filter(other => layerOf.get(other) === (layerOf.get(id) ?? 0) - 1)]));
  const adjacentSuccs = new Map([...succs].map(([id, list]) => [id, list.filter(other => layerOf.get(other) === (layerOf.get(id) ?? 0) + 1)]));
  indexLayers();
  for (let round = 0; round < 2; round++) {
    for (let layer = 1; layer < layers.length; layer++) sweep(layer, adjacentPreds);
    indexLayers();
    for (let layer = layers.length - 2; layer >= 0; layer--) sweep(layer, adjacentSuccs);
    indexLayers();
  }

  // Layers advance along the flow axis; nodes within a layer advance along the other axis.
  const mainStep = lr ? o.nodeWidth + o.gapX : o.nodeHeight + gapY;
  const crossStep = lr ? o.nodeHeight + gapY : o.nodeWidth + o.gapX;
  const laidNodes: LayoutNode[] = nodes.map(node => {
    const layer = layerOf.get(node.id) ?? 0;
    const along = pad + layer * mainStep;
    const across = pad + (position.get(node.id) ?? 0) * crossStep;
    return { id: node.id, x: lr ? along : across, y: (lr ? across : along) + top, width: o.nodeWidth, height: o.nodeHeight, layer };
  });
  const byId = new Map(laidNodes.map(node => [node.id, node]));

  const groups: LayoutGroup[] = graph.groups.flatMap(group => {
    const members = nodes.flatMap(node => {
      const box = node.group === group.id ? byId.get(node.id) : undefined;
      return box ? [box] : [];
    });
    if (!members.length) return [];
    const minX = Math.min(...members.map(m => m.x));
    const minY = Math.min(...members.map(m => m.y));
    const maxX = Math.max(...members.map(m => m.x + m.width));
    const maxY = Math.max(...members.map(m => m.y + m.height));
    const box = { id: group.id, label: group.label, x: minX - pad, y: minY - pad - groupLabelHeadroom, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad + groupLabelHeadroom };
    // Members spread over several layers can still surround another node; such a box would misstate membership.
    return laidNodes.some(node => groupOf.get(node.id) !== group.id && overlaps(node, box)) ? [] : [box];
  });

  const boxes = [...laidNodes, ...groups];
  const width = Math.max(pad, ...boxes.map(box => box.x + box.width)) + pad;
  const height = Math.max(pad, ...boxes.map(box => box.y + box.height)) + pad;

  const layoutEdges: LayoutEdge[] = edges.flatMap((edge, index) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) return [];
    const isBack = back[index];
    const start = isBack ? near(source, lr) : far(source, lr);
    const end = isBack ? far(target, lr) : near(target, lr);
    return [{ from: edge.from, to: edge.to, label: edge.label, points: [start, end], back: isBack }];
  });

  return { width, height, nodes: laidNodes, edges: layoutEdges, groups };
}

/** Reorders a layer so each group's members sit together: groups keep the order of their first member, members keep theirs. Ungrouped nodes stay where they are. */
function contiguous(row: string[], groupOf: Map<string, string | null>): string[] {
  const blocks = new Map<string, string[]>();
  for (const id of row) {
    const key = groupOf.get(id) ? `g:${groupOf.get(id)}` : `n:${id}`;
    const block = blocks.get(key);
    if (block) block.push(id); else blocks.set(key, [id]);
  }
  return [...blocks.values()].flat();
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Marks edges that close a cycle in a DFS over nodes in input order, so the rest form a DAG. */
function markBackEdges(ids: string[], edges: DiagramEdge[]): boolean[] {
  const outgoing = new Map<string, number[]>();
  edges.forEach((edge, index) => push(outgoing, edge.from, index));
  const state = new Map<string, "active" | "done">();
  const back = edges.map(() => false);
  const visit = (id: string): void => {
    state.set(id, "active");
    for (const index of outgoing.get(id) ?? []) {
      const to = edges[index].to;
      const seen = state.get(to);
      if (seen === "active") back[index] = true;
      else if (!seen) visit(to);
    }
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return back;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Far edge in the flow direction: right side for LR, bottom for TB. */
function far(node: LayoutNode, lr: boolean): Point {
  return lr ? { x: node.x + node.width, y: node.y + node.height / 2 } : { x: node.x + node.width / 2, y: node.y + node.height };
}

/** Near edge in the flow direction: left side for LR, top for TB. */
function near(node: LayoutNode, lr: boolean): Point {
  return lr ? { x: node.x, y: node.y + node.height / 2 } : { x: node.x + node.width / 2, y: node.y };
}
