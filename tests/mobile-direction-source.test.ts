import test from "node:test";
import assert from "node:assert/strict";
import { directionSourceLabel } from "../apps/mobile/src/features/teams/model.ts";

test("a direction from the owner's GitHub review is labelled as the owner's review", () => {
  assert.equal(directionSourceLabel({ kind: "github-review", name: "Your GitHub review" }), "Owner (GitHub review)");
});

test("a connector direction shows the connector's name, and the coordinator, slack and no-source cases keep their labels", () => {
  assert.equal(directionSourceLabel({ kind: "connector", name: "Ops bot" }), "Ops bot");
  assert.equal(directionSourceLabel("coordinator"), "Mission coordinator");
  assert.equal(directionSourceLabel("slack"), "You");
  assert.equal(directionSourceLabel(undefined), "You");
});
