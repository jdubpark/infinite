import test from "node:test";
import assert from "node:assert/strict";
import { componentGraph, diagramFromMermaid, diagramGraphSchema, linkDiagramNodes, parseMermaidFlowchart } from "../packages/host/src/understanding-diagrams.js";

test("parses the flowchart subset with groups, labeled edges and chains", () => {
  const result = parseMermaidFlowchart(`flowchart TD\n%% comment\nsubgraph api [API]\n  a[\"Auth &amp; tokens\"]\n  b(Store)\nend\nc((Worker))\na -->|verifies| b --> c\nc -. retry .-> a\nclassDef x fill:#fff`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.graph.direction, "TB");
  assert.deepEqual(result.graph.groups, [{ id: "api", label: "API" }]);
  assert.deepEqual(result.graph.nodes.map(n => [n.id, n.label, n.group]), [["a", "Auth & tokens", "api"], ["b", "Store", "api"], ["c", "Worker", null]]);
  assert.deepEqual(result.graph.edges, [{ from: "a", to: "b", label: "verifies" }, { from: "b", to: "c", label: null }, { from: "c", to: "a", label: "retry" }]);
});

test("rejects unsupported lines with the line number and keeps the source text", () => {
  const result = parseMermaidFlowchart("flowchart LR\na --> b\nsequenceDiagram");
  assert.deepEqual(result, { ok: false, error: "line 3: sequenceDiagram" });
  const graph = diagramFromMermaid({ id: "d1", title: "System", kind: "system", mermaid: "flowchart LR\na --> b\nsequenceDiagram", repositoryId: "repo", head: null, observedAt: "2026-10-25T00:00:00.000Z" });
  assert.equal(graph.parseError, "line 3: sequenceDiagram");
  assert.equal(graph.sourceText?.startsWith("flowchart"), true);
  assert.equal(graph.nodes.length, 0);
});

test("rejects more than 200 nodes", () => {
  const lines = Array.from({ length: 201 }, (_, i) => `n${i}`);
  assert.equal(parseMermaidFlowchart(`flowchart LR\n${lines.join("\n")}`).ok, false);
});

test("builds a component graph grouped by top-level directory with deduplicated edges", () => {
  const { graph, coverage } = componentGraph({ repositoryId: "repo", head: "a".repeat(40), observedAt: "2026-10-25T00:00:00.000Z",
    components: [{ id: "cmp_a", name: "A", paths: [{ repositoryId: "repo", path: "src/a" }], retired: false }, { id: "cmp_b", name: "B", paths: [{ repositoryId: "repo", path: "src/b" }], retired: false }, { id: "cmp_r", name: "R", paths: [{ repositoryId: "repo", path: "README.md" }], retired: false }, { id: "cmp_old", name: "Old", paths: [], retired: true }],
    relationships: [{ from: "cmp_a", to: "cmp_b", kind: "imports" }, { from: "cmp_a", to: "cmp_b", kind: "imports" }, { from: "cmp_b", to: "cmp_old", kind: "calls" }] });
  assert.equal(graph.id, "components:repo");
  assert.deepEqual(graph.nodes.map(n => [n.id, n.group, n.componentId]), [["cmp_a", "src", "cmp_a"], ["cmp_b", "src", "cmp_b"], ["cmp_r", "root", "cmp_r"]]);
  assert.deepEqual(graph.groups.map(g => g.id), ["src", "root"]);
  assert.deepEqual(graph.edges, [{ from: "cmp_a", to: "cmp_b", label: null }]);
  assert.deepEqual(coverage, []);
});

test("links diagram nodes to components by id, then by unique case-insensitive name", () => {
  const graph = diagramFromMermaid({ id: "d", title: "t", kind: "system", mermaid: "flowchart LR\ncmp_a --> store[Store] --> other[Other]", repositoryId: "repo", head: null, observedAt: "2026-10-25T00:00:00.000Z" });
  const linked = linkDiagramNodes(graph, [{ id: "cmp_a", name: "Auth" }, { id: "cmp_s", name: "store" }, { id: "cmp_o1", name: "Other" }, { id: "cmp_o2", name: "other" }]);
  assert.deepEqual(linked.nodes.map(n => n.componentId), ["cmp_a", "cmp_s", null]);
});

test("stored component graphs validate beyond the parser node limit", () => {
  const components = Array.from({ length: 201 }, (_, i) => ({ id: `cmp_${i}`, name: `C${i}`, paths: [{ repositoryId: "repo", path: `src/c${i}` }], retired: false }));
  const { graph } = componentGraph({ repositoryId: "repo", head: null, observedAt: "2026-10-25T00:00:00.000Z", components, relationships: [] });
  assert.equal(graph.nodes.length, 201);
  assert.equal(diagramGraphSchema.safeParse(graph).success, true);
});

test("a component map larger than the stored ceilings is capped, validates, and says how much it drew", () => {
  // 2,001 components in 250 top-level directories, one named directory too long for a label, one empty name, 4,500 connections.
  const components = Array.from({ length: 2001 }, (_, i) => ({ id: `cmp_${i}`, name: i === 0 ? "" : i === 1 ? "n".repeat(260) : `C${i}`,
    paths: [{ repositoryId: "repo", path: `${i === 2 ? "d".repeat(300) : `dir${i % 250}`}/c${i}` }], retired: false }));
  const relationships = Array.from({ length: 4500 }, (_, i) => ({ from: `cmp_${i % 2000}`, to: `cmp_${(i % 2000 + 1 + Math.floor(i / 2000)) % 2000}`, kind: "imports" as const }));
  const { graph, coverage } = componentGraph({ repositoryId: "repo", head: null, observedAt: "2026-10-25T00:00:00.000Z", components, relationships });
  assert.equal(diagramGraphSchema.safeParse(graph).success, true);
  assert.deepEqual([graph.nodes.length, graph.groups.length, graph.edges.length], [2000, 200, 4000]);
  assert.deepEqual(graph.nodes.slice(0, 3).map(node => [node.label.length, node.group?.length]), [[5, 4], [200, 4], [2, 200]]);
  assert.equal(graph.nodes[0].label, "cmp_0");
  assert.ok(graph.nodes.every(node => node.group === null || graph.groups.some(group => group.id === node.group)));
  assert.ok(graph.nodes.some(node => node.group === null), "components past the group ceiling are drawn without a group box");
  assert.deepEqual(coverage, ["Component map: 2000 of 2001 components drawn; the rest are listed under Components.", "Component map: 4000 of 4500 connections between drawn components are shown."]);
});
