import type { Diagram } from "./understanding-work.js";

export type ParsedMermaid =
  | { ok: true; diagram: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence">; kind: "flowchart" | "sequence"; coverage: string[] }
  | { ok: false; error: string };

/** Parses the flowchart/graph/sequenceDiagram subset the briefing engine writes. Never throws. */
export function parseMermaid(text: string): ParsedMermaid {
  try {
    if (typeof text !== "string") return failure("Mermaid input must be text.");
    if (text.length > 3000) return failure("Mermaid input exceeds the 3000 character limit.");

    const source = text.trim();
    if (!source) return failure("Mermaid input is empty.");

    const lines = source.split(/\r?\n/);
    const header = lines[0]?.trim() ?? "";
    const flowHeaderMatch = /^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b(.*)$/.exec(header);
    // Reject all same-line suffixes after the direction so no header statement is silently discarded.
    if (flowHeaderMatch && flowHeaderMatch[3].trim()) {
      return failure("Flowchart header must end after the direction.");
    }
    const flowHeader = flowHeaderMatch;
    const isSequence = /^sequenceDiagram\b/.test(header);
    if (!flowHeader && !isSequence) {
      return failure("Expected a flowchart, graph, or sequenceDiagram header.");
    }

    const forbidden = forbiddenConstruct(source);
    if (forbidden) return failure(`Unsupported Mermaid construct: ${forbidden}.`);

    const body = lines.slice(1);
    const bodyLineCount = body.filter(line => line.trim().length > 0).length;
    const unparsedLines: string[] = [];
    const coverage: string[] = [];

    if (isSequence) {
      const sequence = parseSequence(body, unparsedLines);
      if (sequence.error) return failure(sequence.error);
      const coverageError = coverageFor(bodyLineCount, unparsedLines.length, sequence.skipped, coverage);
      if (coverageError) return failure(coverageError);
      return {
        ok: true,
        kind: "sequence",
        diagram: { direction: "LR", nodes: [], edges: [], groups: [], sequence: sequence.value },
        coverage,
      };
    }

    const declaredDirection = flowHeader?.[2];
    const direction: Diagram["direction"] = declaredDirection === "LR" || declaredDirection === "RL" ? "LR" : "TD";
    const flow = parseFlowchart(body, unparsedLines);
    if (flow.error) return failure(flow.error);
    const coverageError = coverageFor(bodyLineCount, unparsedLines.length, 0, coverage);
    if (coverageError) return failure(coverageError);
    return { ok: true, kind: "flowchart", diagram: { direction, ...flow.value }, coverage };
  } catch {
    return failure("Mermaid input could not be parsed.");
  }
}

type DiagramNode = Diagram["nodes"][number];
type DiagramEdge = Diagram["edges"][number];
type Sequence = NonNullable<Diagram["sequence"]>;

const MAX_NODES = 48;
const MAX_EDGES = 120;

function failure(error: string): ParsedMermaid {
  return { ok: false, error };
}

function forbiddenConstruct(source: string): string | undefined {
  if (source.includes("%%{")) return "%%{";
  if (source.includes("<")) return "<";
  if (source.includes("@{")) return "@{";

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:click|linkStyle|classDef)\b/.test(trimmed)) return trimmed.split(/\s/, 1)[0];
    if (/^(?:class|style)\s/.test(trimmed)) return trimmed.split(/\s/, 1)[0];
    // A link/links line is an unsafe Mermaid directive, while the same word
    // remains valid as a node or participant identifier.
    if (/^links?\s+[A-Za-z_][\w.-]*\s*:/.test(trimmed)) return trimmed.split(/\s/, 1)[0];
  }
  return undefined;
}

function coverageFor(bodyLineCount: number, unparsedCount: number, skippedCount: number, coverage: string[]): string | undefined {
  if (skippedCount > 0) {
    coverage.push(`skipped ${skippedCount} sequence line${skippedCount === 1 ? "" : "s"}.`);
  }
  if (unparsedCount === 0) return undefined;

  const percentage = bodyLineCount === 0 ? 0 : (unparsedCount / bodyLineCount) * 100;
  const detail = `Ignored ${unparsedCount} line${unparsedCount === 1 ? "" : "s"} as unparsed (${percentage.toFixed(1)}% of nonempty body lines).`;
  if (percentage > 10) return `${detail} This exceeds the 10% limit.`;
  coverage.push(detail);
  return undefined;
}

function parseFlowchart(body: string[], unparsedLines: string[]): { value: Pick<Diagram, "nodes" | "edges" | "groups">; error?: string } {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const groups: Diagram["groups"] = [];
  const nodeById = new Map<string, DiagramNode>();
  const groupById = new Map<string, { id: string; label: string }>();
  const seenEdges = new Set<string>();
  const groupStack: string[] = [];

  const declareNode = (spec: NodeSpec): string | undefined => {
    const existing = nodeById.get(spec.id);
    if (existing) {
      if (spec.explicit) {
        existing.label = spec.label;
        existing.shape = spec.shape;
      }
      return undefined;
    }
    if (nodes.length >= MAX_NODES) return `Diagram exceeds the ${MAX_NODES} node limit.`;
    const node: DiagramNode = {
      id: spec.id,
      label: spec.label,
      shape: spec.shape,
      ...(groupStack.length ? { group: groupStack[groupStack.length - 1] } : {}),
    };
    nodeById.set(spec.id, node);
    nodes.push(node);
    return undefined;
  };

  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) continue;

    const subgraph = /^subgraph\s+([A-Za-z_][\w.-]*)(?:\s+\[([^\]]*)\])?\s*$/.exec(line);
    if (subgraph) {
      const id = subgraph[1]!;
      const label = subgraph[2]?.trim() || id;
      let group = groupById.get(id);
      if (!group) {
        group = { id, label };
        groupById.set(id, group);
        groups.push(group);
      }
      groupStack.push(id);
      continue;
    }

    if (line === "end") {
      if (groupStack.length) groupStack.pop();
      else unparsedLines.push(rawLine);
      continue;
    }

    const edgeChain = scanFlowEdges(line);
    if (!edgeChain) {
      const standalone = parseNodeList(line);
      if (!standalone) {
        unparsedLines.push(rawLine);
        continue;
      }
      for (const spec of standalone) {
        const error = declareNode(spec);
        if (error) return { value: { nodes, edges, groups }, error };
      }
      continue;
    }

    const sides: NodeSpec[][] = [];
    let malformed = false;
    for (let i = 0; i < edgeChain.sides.length; i++) {
      let sideText = edgeChain.sides[i]!.trim();
      if (i > 0) {
        const label = takePipeLabel(sideText);
        if (!label.ok) {
          malformed = true;
          break;
        }
        sideText = label.rest;
        const operator = edgeChain.operators[i - 1]!;
        if (label.label !== undefined && operator.label !== undefined) {
          malformed = true;
          break;
        }
        if (label.label !== undefined) operator.label = label.label;
      }
      const specs = parseNodeList(sideText);
      if (!specs) {
        malformed = true;
        break;
      }
      sides.push(specs);
    }
    if (malformed || sides.length !== edgeChain.operators.length + 1) {
      unparsedLines.push(rawLine);
      continue;
    }

    const pendingEdges: DiagramEdge[] = [];
    const pendingKeys = new Set<string>();
    let duplicateEdge = false;
    for (let i = 0; i < edgeChain.operators.length; i++) {
      const operator = edgeChain.operators[i]!;
      for (const from of sides[i]!) {
        for (const to of sides[i + 1]!) {
          const edge: DiagramEdge = { from: from.id, to: to.id, ...(operator.label ? { label: operator.label } : {}), style: operator.style };
          const key = flowEdgeKey(edge);
          if (seenEdges.has(key) || pendingKeys.has(key)) {
            duplicateEdge = true;
            continue;
          }
          pendingKeys.add(key);
          pendingEdges.push(edge);
        }
      }
    }
    if (edges.length + pendingEdges.length > MAX_EDGES) {
      return { value: { nodes, edges, groups }, error: `Diagram exceeds the ${MAX_EDGES} edge limit.` };
    }
    for (const side of sides) {
      for (const spec of side) {
        const error = declareNode(spec);
        if (error) return { value: { nodes, edges, groups }, error };
      }
    }
    for (const edge of pendingEdges) {
      edges.push(edge);
      seenEdges.add(flowEdgeKey(edge));
    }
    if (duplicateEdge && pendingEdges.length === 0) {
      // Retain distinct pairs from a mixed chain, but count its repeated pair
      // as unparsed so repeated-edge floods still fail the coverage gate.
      unparsedLines.push(rawLine);
    }
  }

  if (groupStack.length) return { value: { nodes, edges, groups }, error: "Diagram has an unclosed subgraph." };
  return { value: { nodes, edges, groups } };
}

interface NodeSpec {
  id: string;
  label: string;
  shape: DiagramNode["shape"];
  explicit: boolean;
}

function parseNodeList(text: string): NodeSpec[] | undefined {
  const parts: string[] = [];
  const delimiters: string[] = [];
  const closes: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (closes[char]) delimiters.push(closes[char]!);
    else if (char === "]" || char === ")" || char === "}") {
      if (delimiters.pop() !== char) return undefined;
    } else if (char === "&" && delimiters.length === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (delimiters.length) return undefined;
  parts.push(text.slice(start));
  const specs: NodeSpec[] = [];
  for (const part of parts) {
    const spec = parseNode(part.trim());
    if (!spec) return undefined;
    specs.push(spec);
  }
  return specs.length ? specs : undefined;
}

function parseNode(text: string): NodeSpec | undefined {
  const match = /^([A-Za-z_][\w.-]*)([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const id = match[1]!;
  const shapeText = match[2]!.trim();
  if (!shapeText) return { id, label: id, shape: "box", explicit: false };

  let shape: DiagramNode["shape"];
  let label: string;
  if (shapeText.startsWith("[(") && shapeText.endsWith(")]") && shapeText.length >= 4) {
    shape = "cylinder";
    label = shapeText.slice(2, -2);
  } else if (shapeText.startsWith("([") && shapeText.endsWith("])") && shapeText.length >= 4) {
    shape = "pill";
    label = shapeText.slice(2, -2);
  } else if (shapeText.startsWith("((") && shapeText.endsWith("))") && shapeText.length >= 4) {
    shape = "round";
    label = shapeText.slice(2, -2);
  } else if (shapeText.startsWith("[") && shapeText.endsWith("]")) {
    shape = "box";
    label = shapeText.slice(1, -1);
  } else if (shapeText.startsWith("(") && shapeText.endsWith(")")) {
    shape = "round";
    label = shapeText.slice(1, -1);
  } else if (shapeText.startsWith("{") && shapeText.endsWith("}")) {
    shape = "diamond";
    label = shapeText.slice(1, -1);
  } else {
    return undefined;
  }
  return { id, label: label.trim() || id, shape, explicit: true };
}

interface FlowOperator { style: DiagramEdge["style"]; label?: string }
interface FlowEdgeChain { sides: string[]; operators: FlowOperator[] }

function flowEdgeKey(edge: DiagramEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.label ?? null, edge.style]);
}

function scanFlowEdges(line: string): FlowEdgeChain | undefined {
  const sides: string[] = [];
  const operators: FlowOperator[] = [];
  const delimiters: string[] = [];
  const closes: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (closes[char]) {
      delimiters.push(closes[char]!);
      continue;
    }
    if (char === "]" || char === ")" || char === "}") {
      if (delimiters.pop() !== char) return undefined;
      continue;
    }
    if (delimiters.length) continue;

    let length = 0;
    let operator: FlowOperator | undefined;
    if (line.startsWith("-->", i)) {
      length = 3;
      operator = { style: "solid" };
    } else if (line.startsWith("---", i)) {
      length = 3;
      operator = { style: "solid" };
    } else if (line.startsWith("--", i)) {
      const labeled = /^--\s*([^-]+?)\s*-->/.exec(line.slice(i));
      if (labeled) {
        const label = labeled[1]!.trim();
        if (label) {
          length = labeled[0].length;
          operator = { style: "solid", label };
        }
      }
    }
    if (!operator && line.startsWith("-.->", i)) {
      length = 4;
      operator = { style: "dashed" };
    } else if (!operator && line.startsWith("==>", i)) {
      length = 3;
      operator = { style: "thick" };
    }
    if (operator) {
      sides.push(line.slice(start, i));
      operators.push(operator);
      i += length - 1;
      start = i + 1;
    }
  }
  if (delimiters.length) return undefined;
  if (!operators.length) return undefined;
  sides.push(line.slice(start));
  return { sides, operators };
}

function takePipeLabel(text: string): { ok: true; rest: string; label?: string } | { ok: false } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("|")) return { ok: true, rest: text };
  const close = trimmed.indexOf("|", 1);
  if (close < 0) return { ok: false };
  return { ok: true, rest: trimmed.slice(close + 1).trimStart(), label: trimmed.slice(1, close).trim() };
}

function parseSequence(body: string[], unparsedLines: string[]): { value: Sequence; skipped: number; error?: string } {
  const participants: Sequence["participants"] = [];
  const messages: Sequence["messages"] = [];
  const participantById = new Map<string, Sequence["participants"][number]>();
  let skipped = 0;
  let error: string | undefined;

  const ensureParticipant = (id: string): boolean => {
    if (participantById.has(id)) return true;
    if (participants.length >= MAX_NODES) {
      error = `Diagram exceeds the ${MAX_NODES} participant limit.`;
      return false;
    }
    const participant = { id, label: id };
    participantById.set(id, participant);
    participants.push(participant);
    return true;
  };

  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) continue;

    const participant = /^participant\s+([A-Za-z_][\w.-]*)(?:\s+as\s+(.+))?$/.exec(line);
    if (participant) {
      const id = participant[1]!;
      if (!ensureParticipant(id)) return { value: { participants, messages }, skipped, error };
      const target = participantById.get(id)!;
      target.label = participant[2]?.trim() || id;
      continue;
    }

    const message = /^([A-Za-z_][\w.-]*?)\s*(-->>|->>|-->|->)\s*([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (message) {
      if (!ensureParticipant(message[1]!) || !ensureParticipant(message[3]!)) {
        return { value: { participants, messages }, skipped, error };
      }
      if (messages.length >= MAX_EDGES) return { value: { participants, messages }, skipped, error: `Diagram exceeds the ${MAX_EDGES} message limit.` };
      messages.push({
        from: message[1]!,
        to: message[3]!,
        text: message[4]!.trim(),
        style: message[2] === "-->>" || message[2] === "-->" ? "dashed" : "solid",
      });
      continue;
    }
    if (/^(?:Note|loop|alt|else|opt|par|end|activate|deactivate)\b/.test(line)) {
      skipped++;
      continue;
    }
    unparsedLines.push(rawLine);
  }
  return { value: { participants, messages }, skipped };
}
