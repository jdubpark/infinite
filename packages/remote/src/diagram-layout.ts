import type { Diagram } from "./understanding-work.js";

export const NODE_W = 132, NODE_H = 44, LAYER_GAP = 56, NODE_GAP = 18, GROUP_PAD = 14;

export interface DiagramLayout {
  width: number; height: number;
  nodes: { id: string; x: number; y: number; w: number; h: number; lines: string[] }[];
  edges: { from: string; to: string; points: [number, number][]; label?: string; labelAt: [number, number]; style: "solid" | "dashed" | "thick" }[];
  groups: { id: string; label: string; x: number; y: number; w: number; h: number }[];
  lanes?: { id: string; label: string; x: number }[];
}

/** Deterministic layered layout; sequence diagrams lay out as lanes and message rows. */
export function layoutDiagram(_diagram: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence">): DiagramLayout {
  throw new Error("not implemented");
}
