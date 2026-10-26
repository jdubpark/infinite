import type { Diagram } from "./understanding-work.js";

export const NODE_W = 132, NODE_H = 44, LAYER_GAP = 56, NODE_GAP = 18, GROUP_PAD = 14;

const MARGIN = 16;
const LABEL_CHARS = 18;
const SELF_LOOP_SIZE = 24;

export interface DiagramLayout {
  width: number; height: number;
  nodes: { id: string; x: number; y: number; w: number; h: number; lines: string[] }[];
  edges: { from: string; to: string; points: [number, number][]; label?: string; labelAt: [number, number]; style: "solid" | "dashed" | "thick" }[];
  groups: { id: string; label: string; x: number; y: number; w: number; h: number }[];
  lanes?: { id: string; label: string; x: number }[];
}

type LayoutNode = DiagramLayout["nodes"][number];
type LayoutEdge = DiagramLayout["edges"][number];
type Point = [number, number];
type EdgeRef = { from: string; to: string; index: number };
type Box = { id: string; label: string; x: number; y: number; w: number; h: number };

function wrapLabel(label: string): string[] {
  const remaining = Array.from(label.trim().replace(/\s+/g, " "));
  if (remaining.length === 0) return [""];

  const takeLine = (): string => {
    if (remaining.length <= LABEL_CHARS) return remaining.splice(0).join("");

    const boundary = remaining.slice(0, LABEL_CHARS).lastIndexOf(" ");
    const length = boundary > 0 ? boundary : LABEL_CHARS;
    const line = remaining.splice(0, length).join("");
    while (remaining[0] === " ") remaining.shift();
    return line;
  };

  const first = takeLine();
  if (remaining.length === 0) return [first];

  const second = takeLine();
  if (remaining.length > 0) {
    const chars = Array.from(second);
    return [first, `${chars.slice(0, LABEL_CHARS - 1).join("")}…`];
  }
  return [first, second];
}

function edgePoints(start: Point, end: Point, direction: "LR" | "TD"): Point[] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (direction === "LR") {
    return [start, [start[0] + dx / 3, start[1]], [start[0] + dx * 2 / 3, end[1]], end];
  }
  return [start, [start[0], start[1] + dy / 3], [end[0], start[1] + dy * 2 / 3], end];
}

function edgeMidpoint(start: Point, end: Point): Point {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function makeGroupBox(id: string, label: string, members: LayoutNode[]): Box | undefined {
  if (members.length === 0) return undefined;
  const left = Math.min(...members.map(node => node.x));
  const top = Math.min(...members.map(node => node.y));
  const right = Math.max(...members.map(node => node.x + node.w));
  const bottom = Math.max(...members.map(node => node.y + node.h));
  return {
    id,
    label,
    x: left - GROUP_PAD,
    y: top - GROUP_PAD,
    w: right - left + GROUP_PAD * 2,
    h: bottom - top + GROUP_PAD * 2,
  };
}

function groupBoxes(diagram: Pick<Diagram, "nodes" | "groups">, nodes: LayoutNode[]): Box[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return diagram.groups.flatMap(group => {
    const members = diagram.nodes
      .filter(node => node.group === group.id)
      .map(node => byId.get(node.id))
      .filter((node): node is LayoutNode => node !== undefined);
    const box = makeGroupBox(group.id, group.label, members);
    return box ? [box] : [];
  });
}

function placeGroupsAndNonMembersOutside(
  diagram: Pick<Diagram, "direction" | "nodes" | "groups">,
  layerIds: string[][],
  nodes: LayoutNode[],
): Box[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const isHorizontal = diagram.direction === "LR";
  const crossStart = (node: LayoutNode) => isHorizontal ? node.y : node.x;
  const crossEnd = (node: LayoutNode) => crossStart(node) + (isHorizontal ? node.h : node.w);
  const groupCrossStart = (box: Box) => isHorizontal ? box.y : box.x;
  const groupCrossEnd = (box: Box) => groupCrossStart(box) + (isHorizontal ? box.h : box.w);
  const overlapsPrimaryAxis = (left: Box, right: Box) => isHorizontal
    ? left.x < right.x + right.w && left.x + left.w > right.x
    : left.y < right.y + right.h && left.y + left.h > right.y;
  const overlapsNodePrimaryAxis = (node: LayoutNode, box: Box) => isHorizontal
    ? node.x < box.x + box.w && node.x + node.w > box.x
    : node.y < box.y + box.h && node.y + node.h > box.y;
  const overlapsCrossAxis = (leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) =>
    leftStart < rightEnd && leftEnd > rightStart;

  const groupMembers = new Map<string, LayoutNode[]>();
  for (const group of diagram.groups) {
    const members = diagram.nodes
      .filter(node => node.group === group.id)
      .map(node => nodeById.get(node.id))
      .filter((node): node is LayoutNode => node !== undefined);
    if (members.length > 0) groupMembers.set(group.id, members);
  }

  const boxes: Box[] = [];
  for (const group of diagram.groups) {
    const members = groupMembers.get(group.id);
    if (!members) continue;
    let box = makeGroupBox(group.id, group.label, members);
    if (!box) continue;
    const currentBox = box;
    const primaryNeighbors = boxes.filter(placed => overlapsPrimaryAxis(currentBox, placed));
    const crossStart = groupCrossStart(currentBox), crossEnd = groupCrossEnd(currentBox);
    if (primaryNeighbors.some(placed => overlapsCrossAxis(crossStart, crossEnd, groupCrossStart(placed), groupCrossEnd(placed)))) {
      const targetCrossStart = Math.max(...primaryNeighbors.map(placed => groupCrossEnd(placed))) + NODE_GAP;
      const delta = Math.max(0, targetCrossStart - crossStart);
      for (const member of members) {
        if (isHorizontal) member.y += delta;
        else member.x += delta;
      }
      box = makeGroupBox(group.id, group.label, members)!;
    }
    boxes.push(box);
  }

  const validGroupIds = new Set(boxes.map(box => box.id));
  const groupForNode = new Map(diagram.nodes.map(node => [node.id, node.group]));

  for (const ids of layerIds) {
    const pinned = ids
      .filter(id => validGroupIds.has(groupForNode.get(id) ?? ""))
      .map(id => nodeById.get(id))
      .filter((node): node is LayoutNode => node !== undefined);
    const placed = [...pinned];
    const others = ids
      .filter(id => !validGroupIds.has(groupForNode.get(id) ?? ""))
      .map(id => nodeById.get(id))
      .filter((node): node is LayoutNode => node !== undefined)
      .sort((left, right) => crossStart(left) - crossStart(right));

    for (const node of others) {
      let next = crossStart(node);
      let moved: boolean;
      do {
        moved = false;
        for (const box of boxes) {
          if (!overlapsNodePrimaryAxis(node, box)) continue;
          const start = groupCrossStart(box), end = groupCrossEnd(box);
          if (overlapsCrossAxis(next, next + (isHorizontal ? node.h : node.w), start, end)) {
            next = end + NODE_GAP;
            moved = true;
          }
        }
        for (const blocker of placed) {
          if (next < crossEnd(blocker) && next + (isHorizontal ? node.h : node.w) > crossStart(blocker)) {
            next = crossEnd(blocker) + NODE_GAP;
            moved = true;
          }
        }
      } while (moved);

      if (isHorizontal) node.y = next;
      else node.x = next;
      placed.push(node);
    }
  }
  return groupBoxes(diagram, nodes);
}

function layoutSequence(sequence: NonNullable<Diagram["sequence"]>): DiagramLayout {
  const spacing = NODE_W + LAYER_GAP;
  const lanes = sequence.participants.map((participant, index) => ({
    id: participant.id,
    label: participant.label,
    x: index * spacing,
  }));
  const laneById = new Map<string, number>();
  sequence.participants.forEach((participant, index) => {
    if (!laneById.has(participant.id)) laneById.set(participant.id, index);
  });

  const nodes: LayoutNode[] = sequence.participants.map((participant, index) => ({
    id: participant.id,
    x: index * spacing,
    y: 0,
    w: NODE_W,
    h: NODE_H,
    lines: wrapLabel(participant.label),
  }));
  const edges: LayoutEdge[] = [];

  sequence.messages.forEach((message, index) => {
    const fromIndex = laneById.get(message.from);
    const toIndex = laneById.get(message.to);
    if (fromIndex === undefined || toIndex === undefined) return;

    const fromX = fromIndex * spacing + NODE_W / 2;
    const toX = toIndex * spacing + NODE_W / 2;
    const y = NODE_H + 36 * (index + 1);
    let points: Point[];
    let labelAt: Point;
    if (fromIndex === toIndex) {
      points = [
        [fromX, y],
        [fromX + SELF_LOOP_SIZE, y],
        [fromX + SELF_LOOP_SIZE, y + SELF_LOOP_SIZE],
        [fromX, y + SELF_LOOP_SIZE],
      ];
      labelAt = [fromX + SELF_LOOP_SIZE, y + SELF_LOOP_SIZE / 2];
    } else {
      points = edgePoints([fromX, y], [toX, y], "LR");
      labelAt = edgeMidpoint(points[0], points[3]);
    }
    edges.push({ from: message.from, to: message.to, points, label: message.text, labelAt, style: message.style });
  });

  const maxMessageY = edges.reduce((max, edge) => Math.max(max, ...edge.points.map(point => point[1])), nodes.length > 0 ? NODE_H : 0);
  const maxNodeX = nodes.reduce((max, node) => Math.max(max, node.x + node.w), MARGIN);
  const maxEdgeX = edges.reduce((max, edge) => Math.max(max, ...edge.points.map(point => point[0])), maxNodeX);
  return {
    width: Math.max(2 * MARGIN, Math.max(maxNodeX, maxEdgeX) + MARGIN),
    height: Math.max(2 * MARGIN, maxMessageY + MARGIN),
    nodes,
    edges,
    groups: [],
    lanes,
  };
}

/** Deterministic layered layout; sequence diagrams lay out as lanes and message rows. */
export function layoutDiagram(diagram: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence">): DiagramLayout {
  if (diagram.sequence) return layoutSequence(diagram.sequence);

  const ids = diagram.nodes.map(node => node.id);
  const indexById = new Map<string, number>();
  ids.forEach((id, index) => {
    if (!indexById.has(id)) indexById.set(id, index);
  });
  const edges: EdgeRef[] = diagram.edges
    .map((edge, index) => ({ from: edge.from, to: edge.to, index }))
    .filter(edge => indexById.has(edge.from) && indexById.has(edge.to));
  const outgoing = new Map(ids.map(id => [id, [] as EdgeRef[]]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge);

  // Reverse only DFS back-edges in the layering graph. The rendered edge is unchanged.
  const state = new Map<string, 0 | 1 | 2>(ids.map(id => [id, 0]));
  const reversed = new Set<number>();
  const visit = (id: string): void => {
    state.set(id, 1);
    const stack: { id: string; nextEdge: number }[] = [{ id, nextEdge: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = outgoing.get(frame.id) ?? [];
      if (frame.nextEdge >= next.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }

      const edge = next[frame.nextEdge++]!;
      const targetState = state.get(edge.to) ?? 2;
      if (targetState === 0) {
        state.set(edge.to, 1);
        stack.push({ id: edge.to, nextEdge: 0 });
      } else if (targetState === 1) {
        reversed.add(edge.index);
      }
    }
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);

  const dagOutgoing = new Map(ids.map(id => [id, [] as string[]]));
  const dagIncoming = new Map(ids.map(id => [id, [] as string[]]));
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const edge of edges) {
    let from = edge.from, to = edge.to;
    if (reversed.has(edge.index)) [from, to] = [to, from];
    if (from === to) continue;
    dagOutgoing.get(from)?.push(to);
    dagIncoming.get(to)?.push(from);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const ready = ids.filter(id => indegree.get(id) === 0);
  const topological: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0));
    const id = ready.shift()!;
    topological.push(id);
    for (const target of dagOutgoing.get(id) ?? []) {
      const degree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  // The DFS reversal makes a DAG; this guard also ensures malformed duplicate ids terminate.
  for (const id of ids) if (!topological.includes(id)) topological.push(id);

  const layerById = new Map(ids.map(id => [id, 0]));
  for (const id of topological) {
    const layer = layerById.get(id) ?? 0;
    for (const target of dagOutgoing.get(id) ?? []) {
      layerById.set(target, Math.max(layerById.get(target) ?? 0, layer + 1));
    }
  }
  const layerCount = ids.length === 0 ? 0 : Math.max(...layerById.values()) + 1;
  const layerIds = Array.from({ length: layerCount }, () => [] as string[]);
  for (const id of ids) layerIds[layerById.get(id) ?? 0]?.push(id);

  const declarationIndex = (id: string) => indexById.get(id) ?? 0;
  const orderedPosition = new Map<string, number>();
  const refreshPositions = () => {
    for (const layer of layerIds) layer.forEach((id, index) => orderedPosition.set(id, index));
  };
  refreshPositions();

  const sweepLayer = (layerIndex: number, down: boolean): void => {
    const layer = layerIds[layerIndex];
    if (!layer || layer.length < 2) return;
    const neighborMap = down ? dagIncoming : dagOutgoing;
    const currentCount = layer.length;
    const barycenter = new Map<string, number>();
    for (const id of layer) {
      const neighbors = (neighborMap.get(id) ?? []).filter(neighbor => {
        const neighborLayer = layerById.get(neighbor) ?? 0;
        return down ? neighborLayer < layerIndex : neighborLayer > layerIndex;
      });
      if (neighbors.length === 0) {
        barycenter.set(id, ((orderedPosition.get(id) ?? 0) + 0.5) / currentCount);
        continue;
      }
      const positions = neighbors.map(neighbor => {
        const neighborLayer = layerIds[layerById.get(neighbor) ?? 0] ?? [];
        const position = orderedPosition.get(neighbor) ?? 0;
        return (position + 0.5) / Math.max(1, neighborLayer.length);
      });
      barycenter.set(id, positions.reduce((sum, position) => sum + position, 0) / positions.length);
    }
    layer.sort((left, right) => (barycenter.get(left) ?? 0) - (barycenter.get(right) ?? 0) || declarationIndex(left) - declarationIndex(right));
    refreshPositions();
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    if (sweep % 2 === 0) {
      for (let layer = 1; layer < layerCount; layer++) sweepLayer(layer, true);
    } else {
      for (let layer = layerCount - 2; layer >= 0; layer--) sweepLayer(layer, false);
    }
  }

  const nodesById = new Map<string, LayoutNode>();
  const crossStep = (diagram.direction === "LR" ? NODE_H : NODE_W) + NODE_GAP;
  for (const layer of layerIds) {
    const crossSize = layer.length === 0 ? 0 : layer.length * (diagram.direction === "LR" ? NODE_H : NODE_W) + (layer.length - 1) * NODE_GAP;
    const maxCrossSize = Math.max(...layerIds.map(idsInLayer => idsInLayer.length === 0 ? 0 : idsInLayer.length * (diagram.direction === "LR" ? NODE_H : NODE_W) + (idsInLayer.length - 1) * NODE_GAP));
    for (let position = 0; position < layer.length; position++) {
      const id = layer[position]!;
      const layerIndex = layerById.get(id) ?? 0;
      const crossOffset = MARGIN + (maxCrossSize - crossSize) / 2 + position * crossStep;
      const node: LayoutNode = {
        id,
        x: diagram.direction === "LR" ? MARGIN + layerIndex * (NODE_W + LAYER_GAP) : crossOffset,
        y: diagram.direction === "LR" ? crossOffset : MARGIN + layerIndex * (NODE_H + LAYER_GAP),
        w: NODE_W,
        h: NODE_H,
        lines: wrapLabel(diagram.nodes[indexById.get(id) ?? 0]?.label ?? ""),
      };
      nodesById.set(id, node);
    }
  }
  const nodes = ids.map(id => nodesById.get(id)).filter((node): node is LayoutNode => node !== undefined);
  const groups = placeGroupsAndNonMembersOutside(diagram, layerIds, nodes);

  const layoutEdges: LayoutEdge[] = [];
  for (const edge of diagram.edges) {
    const from = nodesById.get(edge.from), to = nodesById.get(edge.to);
    if (!from || !to) continue;
    let points: Point[];
    if (from.id === to.id) {
      if (diagram.direction === "LR") {
        const y = from.y + from.h / 2;
        points = [[from.x + from.w, y], [from.x + from.w + SELF_LOOP_SIZE, y], [from.x + from.w + SELF_LOOP_SIZE, y - SELF_LOOP_SIZE], [from.x + from.w, y - SELF_LOOP_SIZE]];
      } else {
        const x = from.x + from.w / 2;
        points = [[x, from.y + from.h], [x, from.y + from.h + SELF_LOOP_SIZE], [x + SELF_LOOP_SIZE, from.y + from.h + SELF_LOOP_SIZE], [x + SELF_LOOP_SIZE, from.y + from.h]];
      }
    } else if (diagram.direction === "LR") {
      points = edgePoints([from.x + from.w, from.y + from.h / 2], [to.x, to.y + to.h / 2], "LR");
    } else {
      points = edgePoints([from.x + from.w / 2, from.y + from.h], [to.x + to.w / 2, to.y], "TD");
    }
    layoutEdges.push({
      from: edge.from,
      to: edge.to,
      points,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      labelAt: edgeMidpoint(points[0]!, points[3]!),
      style: edge.style,
    });
  }

  const maxNodeX = nodes.reduce((max, node) => Math.max(max, node.x + node.w), MARGIN);
  const maxNodeY = nodes.reduce((max, node) => Math.max(max, node.y + node.h), MARGIN);
  const maxGroupX = groups.reduce((max, box) => Math.max(max, box.x + box.w), MARGIN);
  const maxGroupY = groups.reduce((max, box) => Math.max(max, box.y + box.h), MARGIN);
  const maxEdgeX = layoutEdges.reduce((max, edge) => Math.max(max, ...edge.points.map(point => point[0])), MARGIN);
  const maxEdgeY = layoutEdges.reduce((max, edge) => Math.max(max, ...edge.points.map(point => point[1])), MARGIN);
  return {
    width: Math.max(2 * MARGIN, Math.max(maxNodeX, maxGroupX, maxEdgeX) + MARGIN),
    height: Math.max(2 * MARGIN, Math.max(maxNodeY, maxGroupY, maxEdgeY) + MARGIN),
    nodes,
    edges: layoutEdges,
    groups,
  };
}
