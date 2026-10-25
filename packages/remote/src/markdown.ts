import type { RichNode } from "./understanding-work.js";

/** Bounded CommonMark-subset parser producing rich nodes. Never throws. */
export function parseMarkdown(_text: string, _options: { maxNodes?: number; maxBytes?: number } = {}): { nodes: RichNode[]; truncated: boolean } {
  throw new Error("not implemented");
}
