import test from "node:test";
import assert from "node:assert/strict";
import { decideRoute, explicitRoute } from "../packages/host/src/intake-route.js";

test("explicitRoute reads ask: and work: only at the start, with the colon", () => {
  assert.deepEqual(explicitRoute("ask: how does retry work?"), { route: "answer", text: "how does retry work?" });
  assert.deepEqual(explicitRoute("WORK :  fix the retry"), { route: "work", text: "fix the retry" });
  assert.deepEqual(explicitRoute("  Ask:"), { route: "answer", text: "" });
  for (const text of ["asking how it works", "workflow is slow", "ask how it works", "please ask: this"]) assert.equal(explicitRoute(text), undefined);
});

test("decideRoute prefers the owner's word, then a confident reading, then work", () => {
  assert.deepEqual(decideRoute({ route: "work" }, { route: "answer", confidence: 0.99 }), { kind: "work", by: "owner" });
  assert.deepEqual(decideRoute(undefined, { route: "work", confidence: 0.6 }), { kind: "work", by: "model", confidence: 0.6 });
  assert.deepEqual(decideRoute(undefined, { route: "work", confidence: 0.59 }), { kind: "answer", by: "model", confidence: 0.59 });
  assert.deepEqual(decideRoute(undefined, { route: "answer", confidence: 0.51 }), { kind: "answer", by: "model", confidence: 0.51 });
  assert.deepEqual(decideRoute(undefined, undefined), { kind: "work", by: "default" });
});
