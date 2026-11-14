import test from "node:test";
import assert from "node:assert/strict";
import { cost, usd } from "../apps/web/src/swarm/format";

test("cost shows the money text alone when every agent is measured", () => {
  assert.deepEqual(cost(1.5, 0), { text: usd(1.5) });
  assert.deepEqual(cost(0, 0), { text: "$0.00" });
  assert.deepEqual(cost(undefined, 0), { text: "" });
});

test("cost marks a measured figure that leaves agents out, and dashes a figure with none", () => {
  const cases: [number | undefined, number, { text: string; title: string }][] = [
    [1.5, 2, { text: "$1.50+", title: "2 agents not measured" }],
    [1.5, 1, { text: "$1.50+", title: "1 agent not measured" }],
    [120, 1, { text: "$120+", title: "1 agent not measured" }],
    [0, 6, { text: "—", title: "cost not measured" }],
    [undefined, 3, { text: "—", title: "cost not measured" }],
  ];
  for (const [value, unmeasured, expected] of cases) assert.deepEqual(cost(value, unmeasured), expected, `cost(${value}, ${unmeasured})`);
});
