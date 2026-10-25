import type { Diagram } from "./understanding-work.js";

export type ParsedMermaid =
  | { ok: true; diagram: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence">; kind: "flowchart" | "sequence"; coverage: string[] }
  | { ok: false; error: string };

/** Parses the flowchart/graph/sequenceDiagram subset the briefing engine writes. Never throws. */
export function parseMermaid(_text: string): ParsedMermaid {
  throw new Error("not implemented");
}
