import test from "node:test";
import assert from "node:assert/strict";
import { MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import type { WorkspaceUnderstanding } from "@infinite/remote";
import { boundedResponse } from "../packages/host/src/understanding.js";

test("a cut overview keeps relationships between kept components and reports each cut category once", () => {
  const big = "d".repeat(100 * 1024);
  const components = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, description: big }));
  const relationships = components.slice(1).map((component, i) => ({ from: `c${i}`, to: component.id }));
  const briefs = Array.from({ length: 10 }, (_, i) => ({ repositoryId: `r${i}`, summary: big }));
  const catalog = { revision: 7, projects: [{ id: "p" }], features: [{ id: "f" }], plans: [], componentOverrides: [], coverage: [] };
  const value = { schemaVersion: 1, workspace: { id: "w", name: "W", revision: 1 }, observedAt: "2026-01-01T00:00:00.000Z", work: [], repositories: [], coverage: [],
    knowledge: { schemaVersion: 1, catalog, components, relationships, delivery: [], briefs, diagrams: [], maintenance: {}, coverage: [] } } as unknown as WorkspaceUnderstanding;
  const result = boundedResponse(value), knowledge = result.knowledge!;
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < MAX_RESPONSE_BYTES);
  assert.ok(knowledge.components.length > 0 && knowledge.components.length < components.length);
  const kept = new Set(knowledge.components.map(component => component.id));
  assert.ok(knowledge.relationships.every(edge => kept.has(edge.from) && kept.has(edge.to)));
  assert.ok(knowledge.relationships.length < relationships.length);
  const lines = knowledge.coverage;
  assert.equal(lines.filter(line => line.startsWith("Components:")).length, 1);
  assert.ok(lines.includes(`Components: ${knowledge.components.length} of 60 shown here; the rest are available on the detail pages.`));
  assert.equal(lines.filter(line => line.startsWith("Relationships:")).length, 1);
  assert.equal(lines.filter(line => line.startsWith("Briefs:")).length, 1);
  assert.deepEqual(knowledge.catalog, catalog, "the catalog is never emptied by the budget");
});
