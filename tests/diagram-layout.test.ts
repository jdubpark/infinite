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

test("group boxes enclose their members with exact padding", () => {
  const layout = layoutGraph({ direction: "LR", groups: [{ id: "g", label: "G" }], nodes: [{ id: "a", label: "a", group: "g", componentId: null }, { id: "b", label: "b", group: "g", componentId: null }], edges: [e("a", "b")] });
  const g = layout.groups[0];
  const minX = Math.min(...layout.nodes.map(node => node.x));
  const maxX = Math.max(...layout.nodes.map(node => node.x + node.width));
  assert.equal(g.x, minX - 12);
  assert.equal(g.width, maxX - minX + 24);
  for (const node of layout.nodes) { assert.ok(node.x >= g.x + 12 && node.x + node.width <= g.x + g.width - 12); }
});

test("is deterministic and drops edges to unknown nodes", () => {
  const graph = { direction: "LR" as const, groups: [], nodes: n(["a", "b"]), edges: [e("a", "b"), e("a", "zzz")] };
  assert.deepEqual(layoutGraph(graph), layoutGraph(graph));
  assert.equal(layoutGraph(graph).edges.length, 1);
});

test("sweeps reorder a layer so it matches the order of the layer before it", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a", "b", "c", "d"]), edges: [e("a", "d"), e("b", "c")] });
  const at = (id: string) => layout.nodes.find(node => node.id === id)!;
  assert.deepEqual([at("a").layer, at("b").layer, at("c").layer, at("d").layer], [0, 0, 1, 1]);
  assert.equal(at("d").y, at("a").y);
  assert.equal(at("c").y, at("b").y);
  assert.ok(at("d").y < at("c").y);
});

test("LR forward edge runs from the source right edge to the target left edge", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a", "b"]), edges: [e("a", "b")] });
  const [a, b] = layout.nodes;
  const edge = layout.edges[0];
  assert.equal(edge.back, false);
  assert.deepEqual(edge.points, [{ x: a.x + a.width, y: a.y + a.height / 2 }, { x: b.x, y: b.y + b.height / 2 }]);
});

test("LR back edge runs from the source left edge to the target right edge", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a", "b", "c"]), edges: [e("a", "b"), e("b", "c"), e("c", "a")] });
  const at = (id: string) => layout.nodes.find(node => node.id === id)!;
  const [a, , c] = [at("a"), at("b"), at("c")];
  const back = layout.edges[2];
  assert.equal(back.back, true);
  assert.deepEqual(back.points, [{ x: c.x, y: c.y + c.height / 2 }, { x: a.x + a.width, y: a.y + a.height / 2 }]);
});

test("TB forward edge runs from the source bottom edge to the target top edge", () => {
  const layout = layoutGraph({ direction: "TB", groups: [], nodes: n(["a", "b"]), edges: [e("a", "b")] });
  const [a, b] = layout.nodes;
  assert.deepEqual(layout.edges[0].points, [{ x: a.x + a.width / 2, y: a.y + a.height }, { x: b.x + b.width / 2, y: b.y }]);
});

test("an empty graph has no nodes or edges and is sized by padding alone", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: [], edges: [] });
  assert.deepEqual([layout.nodes, layout.edges, layout.groups], [[], [], []]);
  assert.equal(layout.width, 24);
  assert.equal(layout.height, 24);
});

test("a self-loop is a back edge and leaves its node in layer 0", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a"]), edges: [e("a", "a")] });
  assert.equal(layout.nodes[0].layer, 0);
  assert.equal(layout.edges[0].back, true);
});

test("option overrides change the width by the overridden rules", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a", "b", "c"]), edges: [e("a", "b"), e("b", "c")] }, { nodeWidth: 100, gapX: 10 });
  assert.equal(layout.width, 3 * 100 + 2 * 10 + 2 * 12);
});
