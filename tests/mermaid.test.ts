import assert from "node:assert/strict";
import test from "node:test";
import { parseMermaid } from "../packages/remote/src/mermaid.js";

test("flowchart shapes, labels, chains, fan-out and subgraphs", () => {
  const r = parseMermaid("flowchart TD\n  A[Store] -->|reads| B(Cache)\n  B -.-> C{Decide}\n  C --> D[(DB)] & E([Queue])\n  E --> F --> G");
  assert.ok(r.ok); const d = r.diagram;
  assert.equal(d.direction, "TD");
  assert.deepEqual(d.nodes.map(n => [n.id, n.label, n.shape]), [["A","Store","box"],["B","Cache","round"],["C","Decide","diamond"],["D","DB","cylinder"],["E","Queue","pill"],["F","F","box"],["G","G","box"]]);
  assert.deepEqual(d.edges.map(e => [e.from, e.to, e.label ?? null, e.style]), [["A","B","reads","solid"],["B","C",null,"dashed"],["C","D",null,"solid"],["C","E",null,"solid"],["E","F",null,"solid"],["F","G",null,"solid"]]);
  const g = parseMermaid("graph LR\n  subgraph Host\n    A --> B\n  end\n  B --> C");
  assert.ok(g.ok); assert.deepEqual(g.diagram.groups, [{ id: "Host", label: "Host" }]);
  assert.equal(g.diagram.nodes.find(n => n.id === "A")?.group, "Host"); assert.equal(g.diagram.nodes.find(n => n.id === "C")?.group, undefined);
  assert.ok(parseMermaid("flowchart LR\n  API --> Policy").ok);
  const labeled = parseMermaid("flowchart LR\n  A -- label --> B");
  assert.ok(labeled.ok); assert.equal(labeled.diagram.edges[0]?.label, "label");
  const thick = parseMermaid("flowchart LR\n  A ==> B");
  assert.ok(thick.ok); assert.equal(thick.diagram.edges[0]?.style, "thick");
  const open = parseMermaid("flowchart LR\n  A --- B");
  assert.ok(open.ok); assert.equal(open.diagram.edges[0]?.style, "solid");

  const normalized = parseMermaid("flowchart TB\n  A --> B\n  B --> C");
  assert.ok(normalized.ok); assert.equal(normalized.diagram.direction, "TD");
  const reversed = parseMermaid("graph RL\n  A --> B\n  B --> C");
  assert.ok(reversed.ok); assert.equal(reversed.diagram.direction, "LR");
  assert.deepEqual(reversed.diagram.edges.map(e => [e.from, e.to]), [["A", "B"], ["B", "C"]]);

  const declaredOutside = parseMermaid("flowchart LR\n  A --> B\n  subgraph Host\n    B --> C\n  end");
  assert.ok(declaredOutside.ok);
  assert.equal(declaredOutside.diagram.nodes.find(n => n.id === "B")?.group, undefined);
  assert.equal(declaredOutside.diagram.nodes.find(n => n.id === "C")?.group, "Host");

  const updatedShape = parseMermaid("flowchart LR\n  A --> B\n  B((Updated)) --> C");
  assert.ok(updatedShape.ok);
  assert.deepEqual(updatedShape.diagram.nodes.find(n => n.id === "B"), { id: "B", label: "Updated", shape: "round" });
  const fanOutBothSides = parseMermaid("flowchart LR\n  A & B --> C & D");
  assert.ok(fanOutBothSides.ok);
  assert.deepEqual(fanOutBothSides.diagram.edges.map(e => [e.from, e.to]), [["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"]]);

  const linkNodeIds = parseMermaid("flowchart LR\n  link --> A\n  link[Link] --> B");
  assert.ok(linkNodeIds.ok);
  assert.deepEqual(linkNodeIds.diagram.nodes.map(n => [n.id, n.label]), [["link", "Link"], ["A", "A"], ["B", "B"]]);
  const linkLabeledArrow = parseMermaid("flowchart LR\n  link -->|type:read| B");
  assert.ok(linkLabeledArrow.ok);
  assert.deepEqual(linkLabeledArrow.diagram.edges.map(e => [e.from, e.to, e.label]), [["link", "B", "type:read"]]);

  const mixedDuplicateChain = parseMermaid("flowchart LR\nA --> B\nA --> B --> C");
  assert.ok(mixedDuplicateChain.ok);
  assert.deepEqual(mixedDuplicateChain.diagram.edges.slice(0, 2).map(e => [e.from, e.to]), [["A", "B"], ["B", "C"]]);
  assert.deepEqual(mixedDuplicateChain.coverage, []);
});

test("sequence diagrams", () => {
  const r = parseMermaid("sequenceDiagram\n  participant A as API\n  A->>B: request\n  Note over A: skip me\n  B-->>A: reply");
  assert.ok(r.ok); assert.equal(r.kind, "sequence");
  assert.deepEqual(r.diagram.sequence?.participants, [{ id: "A", label: "API" }, { id: "B", label: "B" }]);
  assert.deepEqual(r.diagram.sequence?.messages, [{ from: "A", to: "B", text: "request", style: "solid" }, { from: "B", to: "A", text: "reply", style: "dashed" }]);
  assert.ok(r.coverage.some(line => /skipped 1/.test(line)));

  const skippedBlocks = parseMermaid("sequenceDiagram\n  loop retry\n  A->B: request\n  alt accepted\n  else rejected\n  opt extra\n  par parallel\n  activate A\n  deactivate A\n  end");
  assert.ok(skippedBlocks.ok);
  assert.deepEqual(skippedBlocks.diagram.sequence?.messages, [{ from: "A", to: "B", text: "request", style: "solid" }]);
  assert.ok(skippedBlocks.coverage.some(line => /skipped 8/.test(line)));

  const laterDeclaration = parseMermaid("sequenceDiagram\n  A-->B: first\n  participant A as API");
  assert.ok(laterDeclaration.ok);
  assert.deepEqual(laterDeclaration.diagram.sequence?.participants, [{ id: "A", label: "API" }, { id: "B", label: "B" }]);
  const sequenceDirections = parseMermaid("sequenceDiagram\n  B->>A: ask\n  A->B: answer");
  assert.ok(sequenceDirections.ok);
  assert.deepEqual(sequenceDirections.diagram.sequence?.participants.map(p => p.id), ["B", "A"]);
  assert.deepEqual(sequenceDirections.diagram.sequence?.messages.map(m => m.style), ["solid", "solid"]);
  const dashedSingleArrow = parseMermaid("sequenceDiagram\n  X-->Y: dashed");
  assert.ok(dashedSingleArrow.ok);
  assert.equal(dashedSingleArrow.diagram.sequence?.messages[0]?.style, "dashed");
  const linkSender = parseMermaid("sequenceDiagram\n  link ->>B: hello");
  assert.ok(linkSender.ok);
  assert.deepEqual(linkSender.diagram.sequence?.participants.map(p => p.id), ["link", "B"]);
  const loopSender = parseMermaid("sequenceDiagram\n  loop->>B: hello");
  assert.ok(loopSender.ok);
  assert.deepEqual(loopSender.diagram.sequence?.participants.map(p => p.id), ["loop", "B"]);
});

test("dropped inputs", () => {
  for (const text of ["flowchart LR\n  A --> B\n  click A \"https://example.invalid\"", "flowchart LR\n  A[<img src=x>] --> B", "%%{init: {}}%%\nflowchart LR\n  A --> B",
    "flowchart LR\n  A --> B\n  style A fill:#f00", "flowchart LR\n  A --> B\n  classDef red fill:#f00", "flowchart LR\n  A --> B\n  class A red", "flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00",
    "sequenceDiagram\n  A->>B: hi\n  link A: Docs @ example", "sequenceDiagram\n  links A: Docs", "flowchart LR\n  A@{ img: \"x.png\" } --> B", "pie title X\n  \"a\": 1", "flowchart LR\n  A --> B\n  " + "Z --> Y\n".repeat(60)]) {
    const r = parseMermaid(text); assert.equal(r.ok, false, text);
  }

  for (const direction of ["TD", "TB", "BT", "LR", "RL"] as const) {
    const r = parseMermaid(`flowchart ${direction}\n  A --> B`);
    assert.ok(r.ok, direction);
  }
  assert.equal(parseMermaid("flowchart LR\n  A --> B\n  " + "x".repeat(3000)).ok, false);
  const exactly3000 = "flowchart LR\n  A[" + "x".repeat(3000 - "flowchart LR\n  A[] --> B".length) + "] --> B";
  assert.equal(exactly3000.length, 3000);
  assert.equal(parseMermaid(exactly3000).ok, true);
  assert.equal(parseMermaid("flowchart LR\n  " + Array.from({ length: 49 }, (_, i) => `N${i} --> N${i + 1}`).join("\n")).ok, false);
  const pairs = Array.from({ length: 12 }, (_, from) => Array.from({ length: 12 }, (_, to) => [from, to] as const).filter(([a, b]) => a !== b)).flat().slice(0, 121);
  assert.equal(parseMermaid("flowchart LR\n  " + pairs.map(([from, to]) => `N${from} --> N${to}`).join("\n")).ok, false);
  assert.equal(parseMermaid("sequenceDiagram\n  A->>B: hello link there").ok, true);
  assert.equal(parseMermaid("sequenceDiagram\n  link A: Docs").ok, false);
});

test("unparsed lines over 10% drop the diagram, under keep it with coverage", () => {
  const bad = parseMermaid("flowchart LR\n  A --> B\n  ??? nonsense ???");
  assert.equal(bad.ok, false);
  const lines = ["flowchart LR", ...Array.from({ length: 20 }, (_, i) => `  N${i} --> N${i + 1}`), "  ??? one bad line"];
  const ok = parseMermaid(lines.join("\n")); assert.ok(ok.ok); assert.ok(ok.coverage.some(l => /1 line/.test(l)));

  const exactThresholdLines = ["flowchart LR", ...Array.from({ length: 9 }, (_, i) => `  N${i} --> N${i + 1}`), "  ??? exactly ten percent"];
  const exactThreshold = parseMermaid(exactThresholdLines.join("\n"));
  assert.ok(exactThreshold.ok);
  assert.ok(exactThreshold.coverage.some(line => /10(?:\.0)?%/.test(line)));

  const repeatedEdgeLines = ["flowchart LR", ...Array.from({ length: 10 }, (_, i) => `  N${i} --> N${i + 1}`), "  N0 --> N1"];
  const repeatedEdge = parseMermaid(repeatedEdgeLines.join("\n"));
  assert.ok(repeatedEdge.ok);
  assert.ok(repeatedEdge.coverage.some(line => /Ignored 1 line/.test(line)));
});
