import assert from "node:assert/strict";
import test from "node:test";
import { LAYER_GAP, NODE_H, NODE_W, layoutDiagram } from "../packages/remote/src/work-diagram-layout.js";
import type { Diagram } from "../packages/remote/src/understanding-work.js";

function flow(direction: Diagram["direction"], ids: string[], pairs: [string, string][]): Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence"> {
  return {
    direction,
    nodes: ids.map(id => ({ id, label: id, shape: "box" })),
    edges: pairs.map(([from, to]) => ({ from, to, style: "solid" })),
    groups: [],
  };
}

test("longest-path layering and deterministic positions", () => {
  const a = layoutDiagram(flow("LR", ["A", "B", "C", "D"], [["A", "B"], ["B", "C"], ["A", "C"], ["C", "D"]]));
  const x = Object.fromEntries(a.nodes.map(n => [n.id, n.x]));
  assert.ok(x.A < x.B && x.B < x.C && x.C < x.D);
  assert.deepEqual(a, layoutDiagram(flow("LR", ["A", "B", "C", "D"], [["A", "B"], ["B", "C"], ["A", "C"], ["C", "D"]])));
  const td = layoutDiagram(flow("TD", ["A", "B"], [["A", "B"]]));
  assert.ok(td.nodes[0]!.y < td.nodes[1]!.y && td.nodes[0]!.x === td.nodes[1]!.x);

  const lrFanout = layoutDiagram(flow("LR", ["A", "B", "C"], [["A", "B"], ["A", "C"]]));
  const lrPoints = lrFanout.edges[0]!.points;
  assert.equal(lrPoints[1]![0], lrPoints[0]![0] + (lrPoints[3]![0] - lrPoints[0]![0]) / 3);
  assert.equal(lrPoints[2]![0], lrPoints[0]![0] + (lrPoints[3]![0] - lrPoints[0]![0]) * 2 / 3);
  assert.equal(lrPoints[1]![1], lrPoints[0]![1]); assert.equal(lrPoints[2]![1], lrPoints[3]![1]);

  const tdFanout = layoutDiagram(flow("TD", ["A", "B", "C"], [["A", "B"], ["A", "C"]]));
  const tdPoints = tdFanout.edges[0]!.points;
  assert.equal(tdPoints[1]![1], tdPoints[0]![1] + (tdPoints[3]![1] - tdPoints[0]![1]) / 3);
  assert.equal(tdPoints[2]![1], tdPoints[0]![1] + (tdPoints[3]![1] - tdPoints[0]![1]) * 2 / 3);
  assert.equal(tdPoints[1]![0], tdPoints[0]![0]); assert.equal(tdPoints[2]![0], tdPoints[3]![0]);
});

test("cycles terminate and every node is placed", () => {
  const l = layoutDiagram(flow("LR", ["A", "B", "C"], [["A", "B"], ["B", "A"], ["B", "C"]]));
  assert.equal(l.nodes.length, 3); assert.ok(l.width > 0 && l.height > 0);
});

test("groups bound their members and labels wrap", () => {
  const d = flow("LR", ["A", "B", "C"], [["A", "B"], ["B", "C"]]); d.nodes[0]!.group = "G"; d.nodes[1]!.group = "G"; d.groups = [{ id: "G", label: "Group" }];
  d.nodes[2]!.label = "A very long component label that needs wrapping badly";
  const l = layoutDiagram(d); const g = l.groups[0]!; const inside = l.nodes.filter(n => ["A", "B"].includes(n.id));
  assert.ok(inside.every(n => n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h));
  assert.equal(l.nodes.find(n => n.id === "C")!.lines.length, 2); assert.ok(l.nodes.find(n => n.id === "C")!.lines[1]!.endsWith("…"));
});

test("members of other groups stay outside each group box", () => {
  const d = flow("LR", ["A", "B", "C"], []);
  d.nodes[0]!.group = "G"; d.nodes[1]!.group = "H"; d.nodes[2]!.group = "G";
  d.groups = [{ id: "G", label: "Group G" }, { id: "H", label: "Group H" }];
  const l = layoutDiagram(d);
  const groupByNode = new Map(d.nodes.map(node => [node.id, node.group]));
  for (const group of l.groups) {
    const nonMembers = l.nodes.filter(node => groupByNode.get(node.id) !== group.id);
    assert.ok(nonMembers.every(node => node.y + node.h <= group.y || node.y >= group.y + group.h));
  }
});

test("a group moved past another box stays outside earlier boxes", () => {
  const d = flow("LR", ["I0", "I1", "I2", "A0", "A1", "H", "G", "B1", "B2"], [
    ["I0", "I1"], ["I1", "I2"], ["A0", "A1"], ["A1", "H"], ["G", "B1"], ["B1", "B2"],
  ]);
  d.nodes[0]!.group = "I"; d.nodes[2]!.group = "I"; d.nodes[5]!.group = "H"; d.nodes[6]!.group = "G";
  d.groups = [{ id: "G", label: "Group G" }, { id: "H", label: "Group H" }, { id: "I", label: "Group I" }];
  const l = layoutDiagram(d);
  const groupByNode = new Map(d.nodes.map(node => [node.id, node.group]));
  for (const group of l.groups) {
    const nonMembers = l.nodes.filter(node => groupByNode.get(node.id) !== group.id);
    assert.ok(nonMembers.every(node =>
      node.x + node.w <= group.x || node.x >= group.x + group.w || node.y + node.h <= group.y || node.y >= group.y + group.h,
    ));
  }
});

test("sequence layout gives lanes and ordered message rows", () => {
  const l = layoutDiagram({ direction: "LR", nodes: [], edges: [], groups: [], sequence: { participants: [{ id: "A", label: "API" }, { id: "B", label: "B" }], messages: [{ from: "A", to: "B", text: "req", style: "solid" }, { from: "B", to: "A", text: "rep", style: "dashed" }] } });
  assert.equal(l.lanes?.length, 2); assert.equal(l.edges.length, 2); assert.ok(l.edges[0]!.points[0]![1] < l.edges[1]!.points[0]![1]);
  assert.deepEqual(l.lanes?.map(lane => lane.x), [0, NODE_W + LAYER_GAP]);
  assert.equal(l.edges[0]!.points[0]![1], NODE_H + 36);
  assert.equal(l.edges[1]!.points[0]![1], NODE_H + 72);
});

test("duplicate node IDs deduplicate first-wins without corrupting topological layering or groups", () => {
  const d: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence"> = {
    direction: "LR",
    nodes: [
      { id: "A", label: "First A", shape: "box", group: "G1" },
      { id: "A", label: "Second A", shape: "box", group: "G2" },
      { id: "B", label: "B", shape: "box" },
      { id: "C", label: "C", shape: "box" },
      { id: "Y", label: "Y", shape: "box" },
      { id: "X", label: "X", shape: "box" },
    ],
    edges: [
      { from: "A", to: "B", style: "solid" },
      { from: "Y", to: "X", style: "solid" },
      { from: "X", to: "B", style: "solid" },
      { from: "B", to: "C", style: "solid" },
    ],
    groups: [
      { id: "G1", label: "Group 1" },
      { id: "G1", label: "Group 1 duplicate" },
      { id: "G2", label: "Group 2" },
    ],
  };
  const l = layoutDiagram(d);
  assert.deepEqual(l.nodes.map(node => node.id), ["A", "B", "C", "Y", "X"]);
  assert.deepEqual(l.nodes.find(node => node.id === "A")!.lines, ["First A"]);
  assert.deepEqual(l.groups.map(group => ({ id: group.id, label: group.label })), [{ id: "G1", label: "Group 1" }]);
  const x = Object.fromEntries(l.nodes.map(node => [node.id, node.x]));
  assert.ok(x.A < x.B && x.Y < x.X && x.X < x.B && x.B < x.C);
  const a = l.nodes.find(node => node.id === "A")!;
  const g1 = l.groups[0]!;
  assert.ok(a.x >= g1.x && a.y >= g1.y && a.x + a.w <= g1.x + g1.w && a.y + a.h <= g1.y + g1.h);
  assert.deepEqual(l, layoutDiagram(d));
});

test("duplicate node IDs in cycles and sequence participants remain unique and deterministic", () => {
  const cyclic = flow("LR", ["A", "B", "A", "C"], [["A", "B"], ["B", "A"], ["B", "C"], ["A", "A"]]);
  const l = layoutDiagram(cyclic);
  assert.deepEqual(l.nodes.map(node => node.id), ["A", "B", "C"]);
  assert.equal(l.edges.length, 4);
  assert.ok(l.width > 0 && l.height > 0);
  assert.deepEqual(l, layoutDiagram(cyclic));

  const seq = layoutDiagram({
    direction: "LR",
    nodes: [],
    edges: [],
    groups: [],
    sequence: {
      participants: [
        { id: "A", label: "First API" },
        { id: "B", label: "Worker" },
        { id: "A", label: "Second API" },
      ],
      messages: [
        { from: "A", to: "B", text: "req", style: "solid" },
        { from: "B", to: "A", text: "rep", style: "dashed" },
      ],
    },
  });
  assert.deepEqual(seq.lanes?.map(lane => ({ id: lane.id, label: lane.label, x: lane.x })), [
    { id: "A", label: "First API", x: 0 },
    { id: "B", label: "Worker", x: NODE_W + LAYER_GAP },
  ]);
  assert.deepEqual(seq.nodes.map(node => ({ id: node.id, lines: node.lines })), [
    { id: "A", lines: ["First API"] },
    { id: "B", lines: ["Worker"] },
  ]);
  assert.equal(seq.edges.length, 2);
});
