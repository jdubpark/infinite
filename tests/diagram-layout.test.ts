import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph } from "../packages/remote/src/diagram-layout.js";

const n = (ids: string[]) => ids.map(id => ({ id, label: id, group: null, componentId: null }));
const e = (from: string, to: string) => ({ from, to, label: null });

test("layers a chain left to right and keeps a back edge", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a", "b", "c"]), edges: [e("a", "b"), e("b", "c"), e("c", "a")] });
  assert.deepEqual(layout.nodes.map(x => x.layer), [0, 1, 2]);
  assert.ok(layout.nodes[0].x < layout.nodes[1].x && layout.nodes[1].x < layout.nodes[2].x);
  assert.deepEqual(layout.edges.map(x => x.back), [false, false, true]);
  assert.equal(layout.width, 3 * 150 + 2 * 48 + 2 * 12);
});

test("layers top to bottom and places siblings apart", () => {
  const layout = layoutGraph({ direction: "TB", groups: [], nodes: n(["root", "x", "y"]), edges: [e("root", "x"), e("root", "y")] });
  const [root, x, y] = layout.nodes;
  assert.ok(root.y < x.y && x.y === y.y && x.x !== y.x);
});

test("group boxes enclose their members with padding", () => {
  const layout = layoutGraph({ direction: "LR", groups: [{ id: "g", label: "G" }], nodes: [{ id: "a", label: "a", group: "g", componentId: null }, { id: "b", label: "b", group: "g", componentId: null }], edges: [e("a", "b")] });
  const g = layout.groups[0];
  for (const node of layout.nodes) { assert.ok(node.x >= g.x + 12 && node.x + node.width <= g.x + g.width - 12); }
});

test("is deterministic and drops edges to unknown nodes", () => {
  const graph = { direction: "LR" as const, groups: [], nodes: n(["a", "b"]), edges: [e("a", "b"), e("a", "zzz")] };
  assert.deepEqual(layoutGraph(graph), layoutGraph(graph));
  assert.equal(layoutGraph(graph).edges.length, 1);
});
